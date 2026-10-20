import { describe, expect, it } from "vite-plus/test";
import { advanceWorld, createInitialWorld, publicSnapshot } from "./engine";
import {
  decodeSnapshotFrame,
  encodeSnapshotFrame,
  type SentTerrain,
  type SnapshotFrame,
} from "./snapshot-stream";
import type { PublicWorldSnapshot } from "./types";

// Frames cross the wire as JSON, so compare what a client would parse.
function wire<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("snapshot stream", () => {
  it("rebuilds every broadcast exactly from a full frame and terrain patches", () => {
    const world = createInitialWorld(260826081, 0);
    advanceWorld(world, 30);
    let sent: SentTerrain | undefined;
    let held: PublicWorldSnapshot | undefined;
    for (let broadcast = 0; broadcast < 40; broadcast += 1) {
      advanceWorld(world, 1);
      const snapshot = publicSnapshot(world, false);
      const frame = wire(encodeSnapshotFrame(snapshot, sent));
      sent = { tick: snapshot.tick, terrain: snapshot.terrain };
      expect("terrainPatch" in frame).toBe(broadcast > 0);
      held = decodeSnapshotFrame(frame, held);
      expect(held).toEqual(wire(snapshot));
    }
  });

  it("sends a small fraction of the terrain once a base exists", () => {
    const world = createInitialWorld(260826081, 0);
    advanceWorld(world, 30);
    const first = publicSnapshot(world, false);
    advanceWorld(world, 1);
    const frame = encodeSnapshotFrame(publicSnapshot(world, false), {
      tick: first.tick,
      terrain: first.terrain,
    });
    if (!("terrainPatch" in frame)) throw new Error("expected a terrain patch");
    expect(frame.terrainPatch.fromTick).toBe(first.tick);
    expect(frame.terrainPatch.tiles.length).toBeGreaterThan(0);
    expect(frame.terrainPatch.tiles.length).toBeLessThan(first.terrain.length / 10);
    expect(JSON.stringify(frame).length).toBeLessThan(JSON.stringify(first).length / 2);
  });

  it("keeps a client that connected mid-broadcast and refuses a patch for another base", () => {
    const world = createInitialWorld(260826081, 0);
    advanceWorld(world, 10);
    const base = publicSnapshot(world, false);
    advanceWorld(world, 1);
    const next = publicSnapshot(world, false);
    const frame = wire(encodeSnapshotFrame(next, { tick: base.tick, terrain: base.terrain }));

    // A full snapshot of the new tick already holds the patched terrain.
    expect(decodeSnapshotFrame(frame, wire(next))).toEqual(wire(next));
    // A client missing the base, or holding an older one, must reload.
    expect(decodeSnapshotFrame(frame, undefined)).toBeUndefined();
    advanceWorld(world, 1);
    const later = publicSnapshot(world, false);
    const skipped: SnapshotFrame = wire(
      encodeSnapshotFrame(later, { tick: next.tick, terrain: next.terrain }),
    );
    expect(decodeSnapshotFrame(skipped, wire(base))).toBeUndefined();
  });

  it("sends the full snapshot when there is no base to patch", () => {
    const world = createInitialWorld(260826081, 0);
    const snapshot = publicSnapshot(world, false);
    expect(encodeSnapshotFrame(snapshot, undefined)).toBe(snapshot);
    expect(decodeSnapshotFrame(snapshot, undefined)).toBe(snapshot);
  });
});
