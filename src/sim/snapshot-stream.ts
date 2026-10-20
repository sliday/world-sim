import type { PublicWorldSnapshot, Tile } from "./types";

/**
 * A live WebSocket frame. Terrain is most of a snapshot, yet one tick changes only a few hundred
 * of its tiles, so after a full frame the Worker sends just the tiles that differ from the frame
 * it broadcast before. HTTP snapshots and the browser fallback always carry the full terrain.
 */
export type SnapshotFrame = PublicWorldSnapshot | TerrainPatchFrame;

export interface TerrainPatchFrame extends Omit<PublicWorldSnapshot, "terrain"> {
  terrainPatch: {
    /** Tick of the broadcast this patch edits; a client must hold that terrain to apply it. */
    fromTick: number;
    /** Every tile that changed, as [index, complete new tile]. */
    tiles: Array<[number, Tile]>;
  };
}

/** The terrain a broadcast carried, kept by the Worker as the base for the next patch. */
export interface SentTerrain {
  tick: number;
  terrain: readonly Tile[];
}

function sameTile(left: Tile, right: Tile | undefined): boolean {
  return (
    right !== undefined &&
    left.terrain === right.terrain &&
    left.richness === right.richness &&
    left.moisture === right.moisture &&
    left.contamination === right.contamination
  );
}

/** Encodes a broadcast against the previous one; with no previous broadcast it sends everything. */
export function encodeSnapshotFrame(
  snapshot: PublicWorldSnapshot,
  previous: SentTerrain | undefined,
): SnapshotFrame {
  if (!previous || previous.terrain.length !== snapshot.terrain.length) return snapshot;
  const { terrain, ...rest } = snapshot;
  const tiles: Array<[number, Tile]> = [];
  terrain.forEach((tile, index) => {
    if (!sameTile(tile, previous.terrain[index])) tiles.push([index, tile]);
  });
  return { ...rest, terrainPatch: { fromTick: previous.tick, tiles } };
}

/**
 * Rebuilds the authoritative snapshot a frame describes. Terrain changes only when the tick
 * advances, so the tick names the terrain a client holds. Returns undefined when the held terrain
 * is not the patch's base; the caller then reloads a full snapshot.
 */
export function decodeSnapshotFrame(
  frame: SnapshotFrame,
  held: PublicWorldSnapshot | undefined,
): PublicWorldSnapshot | undefined {
  if (!("terrainPatch" in frame)) return frame;
  const { terrainPatch, ...rest } = frame;
  if (!held) return undefined;
  if (held.tick === terrainPatch.fromTick) {
    const terrain = held.terrain.slice();
    for (const [index, tile] of terrainPatch.tiles) terrain[index] = tile;
    return { ...rest, terrain };
  }
  // A client that connected while this tick was being broadcast already holds its terrain.
  if (held.tick === frame.tick) return { ...rest, terrain: held.terrain };
  return undefined;
}
