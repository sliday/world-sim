import {
  advanceAgentFreeWorld,
  ensureAgentOperatingSystem,
  realizedPortfolioScore,
} from "./engine";
import { Rng } from "./rng";
import { WORLD_HEIGHT, WORLD_WIDTH, type WorldState } from "./types";

export const HELD_OUT_ASSAY_TICKS = 288;
export const HELD_OUT_SCHEDULE_SEEDS = [9201, 9202, 9203, 9204, 9205, 9206, 9207, 9208] as const;

export type HeldOutDisturbanceKind = "contamination" | "drought" | "damage" | "resource-variation";

export interface HeldOutDisturbance {
  kind: HeldOutDisturbanceKind;
  centerX: number;
  centerY: number;
}

export interface HeldOutSchedule {
  seed: number;
  disturbances: HeldOutDisturbance[];
}

export interface HeldOutScheduleResult {
  seed: number;
  disturbances: HeldOutDisturbance[];
  initialService: number;
  finalService: number;
  heldOutResilience: number;
}

export interface HeldOutAssayResult {
  sourceTick: number;
  evaluationTicks: number;
  artifactCount: number;
  agentsRemoved: true;
  scheduleResults: HeldOutScheduleResult[];
  meanHeldOutResilience: number;
}

const disturbanceKinds: HeldOutDisturbanceKind[] = [
  "contamination",
  "drought",
  "damage",
  "resource-variation",
];
const DISTURBANCE_RADIUS = 9;

export function createHeldOutSchedule(seed: number): HeldOutSchedule {
  const rng = new Rng(seed);
  const kinds = [...disturbanceKinds];
  for (let index = kinds.length - 1; index > 0; index -= 1) {
    const swap = rng.int(index + 1);
    [kinds[index], kinds[swap]] = [kinds[swap]!, kinds[index]!];
  }
  return {
    seed,
    disturbances: kinds.map((kind) => ({
      kind,
      centerX: rng.int(WORLD_WIDTH),
      centerY: rng.int(WORLD_HEIGHT),
    })),
  };
}

function toroidalDelta(first: number, second: number, size: number): number {
  const direct = Math.abs(first - second);
  return Math.min(direct, size - direct);
}

function disturbanceFalloff(x: number, y: number, disturbance: HeldOutDisturbance): number {
  const dx = toroidalDelta(x, disturbance.centerX, WORLD_WIDTH);
  const dy = toroidalDelta(y, disturbance.centerY, WORLD_HEIGHT);
  const distance = Math.sqrt(dx * dx + dy * dy);
  return Math.max(0, 1 - distance / DISTURBANCE_RADIUS);
}

function applyHeldOutDisturbance(
  world: WorldState,
  disturbance: HeldOutDisturbance,
  phase: number,
): void {
  const intensity = 0.4 + 0.6 * Math.sin(Math.PI * phase);
  for (let offsetY = -DISTURBANCE_RADIUS; offsetY <= DISTURBANCE_RADIUS; offsetY += 1) {
    for (let offsetX = -DISTURBANCE_RADIUS; offsetX <= DISTURBANCE_RADIUS; offsetX += 1) {
      const x = (disturbance.centerX + offsetX + WORLD_WIDTH) % WORLD_WIDTH;
      const y = (disturbance.centerY + offsetY + WORLD_HEIGHT) % WORLD_HEIGHT;
      const falloff = disturbanceFalloff(x, y, disturbance);
      if (falloff <= 0) continue;
      const tile = world.terrain[y * WORLD_WIDTH + x]!;
      const amount = falloff * intensity;
      if (disturbance.kind === "contamination")
        tile.contamination = Math.min(1, tile.contamination + amount * 0.015);
      else if (disturbance.kind === "drought")
        tile.moisture = Math.max(0, tile.moisture - amount * 0.012);
      else if (disturbance.kind === "resource-variation")
        tile.richness = Math.max(0.02, tile.richness - amount * 0.009);
    }
  }
  if (disturbance.kind !== "damage") return;
  for (const artifact of world.artifacts) {
    const falloff = disturbanceFalloff(artifact.x, artifact.y, disturbance);
    if (falloff > 0) artifact.health = Math.max(0, artifact.health - falloff * intensity * 0.009);
  }
}

export function runHeldOutAssay(
  source: WorldState,
  evaluationTicks = HELD_OUT_ASSAY_TICKS,
  scheduleSeeds: readonly number[] = HELD_OUT_SCHEDULE_SEEDS,
): HeldOutAssayResult {
  const sourceTick = source.tick;
  const scheduleResults = scheduleSeeds.map((seed) => {
    const world = structuredClone(source);
    ensureAgentOperatingSystem(world);
    world.agents = [];
    const schedule = createHeldOutSchedule(seed);
    const eventTicks = Math.max(1, Math.ceil(evaluationTicks / schedule.disturbances.length));
    const initialService = realizedPortfolioScore(world, false);
    let serviceArea = 0;
    for (let tick = 0; tick < evaluationTicks; tick += 1) {
      const eventIndex = Math.min(schedule.disturbances.length - 1, Math.floor(tick / eventTicks));
      const phase = ((tick % eventTicks) + 1) / eventTicks;
      applyHeldOutDisturbance(world, schedule.disturbances[eventIndex]!, phase);
      advanceAgentFreeWorld(world, 1);
      serviceArea += realizedPortfolioScore(world, false);
    }
    return {
      seed,
      disturbances: schedule.disturbances,
      initialService,
      finalService: realizedPortfolioScore(world, false),
      heldOutResilience: evaluationTicks ? serviceArea / evaluationTicks : initialService,
    };
  });
  return {
    sourceTick,
    evaluationTicks,
    artifactCount: source.artifacts.length,
    agentsRemoved: true,
    scheduleResults,
    meanHeldOutResilience: scheduleResults.length
      ? scheduleResults.reduce((total, result) => total + result.heldOutResilience, 0) /
        scheduleResults.length
      : 0,
  };
}
