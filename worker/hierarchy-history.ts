import {
  computeHierarchy,
  hierarchyHistoryPoint,
  HIERARCHY_MAX_SNAPSHOTS,
  HIERARCHY_SNAPSHOT_INTERVAL_TICKS,
  type HierarchyApiResponse,
  type HierarchyFossils,
  type HierarchyHistoryPoint,
  type HierarchyReport,
} from "../src/sim/hierarchy";
import type { WorldState } from "../src/sim/types";

interface SnapshotRow {
  [key: string]: SqlStorageValue;
  tick: number;
  pointJson: string;
}

/**
 * Observer-only hierarchy history. Tracking starts when this table first
 * exists: the first row is a labeled baseline of the state at that moment,
 * and no earlier history is reconstructed.
 */
export class HierarchyHistoryStore {
  private readonly sql: SqlStorage;
  private latestTick?: number;
  private cached?: { tick: number; report: HierarchyReport };

  constructor(sql: SqlStorage) {
    this.sql = sql;
    sql.exec(`
      CREATE TABLE IF NOT EXISTS hierarchy_snapshots (
        tick INTEGER PRIMARY KEY,
        kind TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        point_json TEXT NOT NULL
      );
    `);
  }

  report(world: WorldState, fossils?: HierarchyFossils): HierarchyReport {
    if (this.cached?.tick !== world.tick)
      this.cached = { tick: world.tick, report: computeHierarchy(world, { fossils }) };
    return this.cached.report;
  }

  /** Record a baseline once, then one snapshot per interval of world ticks. */
  maybeRecord(world: WorldState, now = Date.now(), fossils?: HierarchyFossils): void {
    this.latestTick ??=
      this.sql
        .exec<{ [key: string]: SqlStorageValue; tick: number | null }>(
          "SELECT MAX(tick) AS tick FROM hierarchy_snapshots",
        )
        .toArray()[0]?.tick ?? undefined;
    const kind =
      this.latestTick === undefined
        ? "baseline"
        : world.tick - this.latestTick >= HIERARCHY_SNAPSHOT_INTERVAL_TICKS
          ? "interval"
          : undefined;
    if (!kind) return;
    const point = hierarchyHistoryPoint(this.report(world, fossils), kind, now);
    this.sql.exec(
      `INSERT OR REPLACE INTO hierarchy_snapshots (tick, kind, created_at, point_json)
       VALUES (?, ?, ?, ?)`,
      point.tick,
      point.kind,
      point.createdAt,
      JSON.stringify(point),
    );
    this.latestTick = point.tick;
    this.thin();
  }

  /**
   * Bound the table without dropping its start: past the cap, every other row
   * in the older half goes, so old history keeps its span at coarser spacing.
   */
  private thin(): void {
    const count =
      this.sql
        .exec<{ [key: string]: SqlStorageValue; count: number }>(
          "SELECT COUNT(*) AS count FROM hierarchy_snapshots",
        )
        .toArray()[0]?.count ?? 0;
    if (count <= HIERARCHY_MAX_SNAPSHOTS) return;
    this.sql.exec(
      `DELETE FROM hierarchy_snapshots WHERE tick IN (
         SELECT tick FROM (
           SELECT tick, ROW_NUMBER() OVER (ORDER BY tick) AS position FROM hierarchy_snapshots
         ) WHERE position > 1 AND position <= ? AND position % 2 = 0
       )`,
      Math.floor(count / 2),
    );
  }

  read(): HierarchyHistoryPoint[] {
    return this.sql
      .exec<SnapshotRow>(
        `SELECT tick, point_json AS pointJson FROM hierarchy_snapshots
         ORDER BY tick ASC LIMIT ?`,
        HIERARCHY_MAX_SNAPSHOTS + 1,
      )
      .toArray()
      .flatMap((row) => {
        try {
          return [JSON.parse(row.pointJson) as HierarchyHistoryPoint];
        } catch {
          return [];
        }
      });
  }

  response(world: WorldState, fossils?: HierarchyFossils): HierarchyApiResponse {
    const points = this.read();
    return {
      current: this.report(world, fossils),
      history: {
        intervalTicks: HIERARCHY_SNAPSHOT_INTERVAL_TICKS,
        maxPoints: HIERARCHY_MAX_SNAPSHOTS,
        startedTick: points[0]?.tick,
        points,
      },
    };
  }
}
