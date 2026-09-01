import { describe, expect, it } from "vite-plus/test";
import { createInitialWorld } from "./engine";
import { createHeldOutSchedule, HELD_OUT_SCHEDULE_SEEDS, runHeldOutAssay } from "./held-out-assay";
import type { Artifact, ControllerAction } from "./types";

function assayArtifact(action: ControllerAction, index: number): Artifact {
  return {
    id: `assay-${action}`,
    name: `Assay ${action}`,
    x: 10 + index * 11,
    y: 12 + index * 7,
    material: "mineral",
    health: 1,
    performance: 0.72,
    generation: 1,
    creatorId: "A001",
    authors: ["A001"],
    contributors: ["A001"],
    adopters: [],
    controller: { sensor: "contamination", threshold: 0, action, revision: 1 },
    stationId: "S4",
    process: "foundry",
    storedWater: 0,
    reserve: 1.5,
    flux: {
      waterCollected: 0,
      contaminationRemoved: 0,
      reserveConsumed: 0,
      maintenanceInput: 0,
    },
    fluxTrackingStartedTick: 0,
    builtAt: 0,
    uses: 0,
    validated: true,
  };
}

describe("agent-free held-out assay", () => {
  it("creates deterministic unseen schedules containing each disturbance class", () => {
    const first = createHeldOutSchedule(HELD_OUT_SCHEDULE_SEEDS[0]);
    const replay = createHeldOutSchedule(HELD_OUT_SCHEDULE_SEEDS[0]);

    expect(first).toEqual(replay);
    expect(new Set(first.disturbances.map((event) => event.kind))).toEqual(
      new Set(["contamination", "drought", "damage", "resource-variation"]),
    );
    expect(
      first.disturbances.every(
        (event) =>
          event.centerX >= 0 && event.centerX < 96 && event.centerY >= 0 && event.centerY < 72,
      ),
    ).toBe(true);
  });

  it("evaluates frozen artifact portfolios without agents or source-world mutation", () => {
    const world = createInitialWorld(260826081, 0);
    world.tick = 400;
    world.artifacts = (["collect-water", "remediate", "heal", "grow", "signal"] as const).map(
      assayArtifact,
    );
    const sourceBefore = structuredClone(world);

    const result = runHeldOutAssay(world, 24, [9201, 9202]);
    const replay = runHeldOutAssay(world, 24, [9201, 9202]);

    expect(result).toEqual(replay);
    expect(result.sourceTick).toBe(400);
    expect(result.evaluationTicks).toBe(24);
    expect(result.artifactCount).toBe(5);
    expect(result.agentsRemoved).toBe(true);
    expect(result.scheduleResults).toHaveLength(2);
    expect(result.scheduleResults.every((schedule) => schedule.disturbances.length === 4)).toBe(
      true,
    );
    expect(
      result.scheduleResults.every(
        (schedule) =>
          schedule.heldOutResilience >= 0 &&
          schedule.heldOutResilience <= 1 &&
          schedule.finalService >= 0 &&
          schedule.finalService <= 1,
      ),
    ).toBe(true);
    expect(result.meanHeldOutResilience).toBeGreaterThan(0);
    expect(world).toEqual(sourceBefore);
    expect(world.agents).toHaveLength(100);
    expect(world.tick).toBe(400);
  });
});
