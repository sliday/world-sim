import { describe, expect, it } from "vite-plus/test";
import {
  advanceWorld,
  createInitialWorld,
  ensureAgentOperatingSystem,
  publicSnapshot,
} from "./engine";
import {
  decodeOccupancyHeat,
  emptyOccupancy,
  encodeOccupancyHeat,
  OCCUPANCY_LEVELS,
  OCCUPANCY_MODES,
} from "./occupancy";
import { WORLD_HEIGHT, WORLD_WIDTH, type OccupancyLedger, type WorldState } from "./types";

const TILE_COUNT = WORLD_WIDTH * WORLD_HEIGHT;

function agentTicks(world: WorldState): number {
  return OCCUPANCY_MODES.reduce(
    (sum, mode) => sum + world.occupancy.modes[mode].reduce((total, count) => total + count, 0),
    0,
  );
}

function scaledLedger(ledger: OccupancyLedger, factor: number): OccupancyLedger {
  const scaled = structuredClone(ledger);
  for (const mode of OCCUPANCY_MODES)
    scaled.modes[mode] = scaled.modes[mode].map((count) => count * factor);
  return scaled;
}

describe("long-term occupancy heat", () => {
  it("counts one agent-tick per agent per tick on its tile and current activity", () => {
    const world = createInitialWorld(41, 0);
    expect(world.occupancy.startedTick).toBe(0);
    expect(agentTicks(world)).toBe(0);

    advanceWorld(world, 1);
    expect(agentTicks(world)).toBe(world.agents.length);
    for (const agent of world.agents)
      expect(world.occupancy.modes[agent.mode][agent.y * WORLD_WIDTH + agent.x]).toBeGreaterThan(0);

    advanceWorld(world, 59);
    expect(agentTicks(world)).toBe(world.agents.length * 60);
  });

  it("starts tracking at migration without fabricating history from bounded trails", () => {
    const world = createInitialWorld(41, 0);
    advanceWorld(world, 40);
    expect(world.agents.some((agent) => agent.trail.length > 1)).toBe(true);
    delete (world as unknown as { occupancy?: OccupancyLedger }).occupancy;

    ensureAgentOperatingSystem(world);
    expect(world.occupancy.startedTick).toBe(40);
    expect(agentTicks(world)).toBe(0);
    for (const mode of OCCUPANCY_MODES)
      expect(world.occupancy.modes[mode]).toHaveLength(TILE_COUNT);

    advanceWorld(world, 3);
    const counted = agentTicks(world);
    expect(counted).toBe(world.agents.length * 3);
    ensureAgentOperatingSystem(world);
    expect(world.occupancy.startedTick).toBe(40);
    expect(agentTicks(world)).toBe(counted);
  });

  it("round-trips one log-scaled byte per tile with its dominant activity", () => {
    const ledger = emptyOccupancy(7);
    ledger.modes.surveying.fill(10);
    ledger.modes.surveying[0] = 0;
    ledger.modes.surveying[3] = 20;
    ledger.modes.crafting[9] = 25;
    ledger.modes.harvesting[5] = 2_000;

    const heat = encodeOccupancyHeat(ledger);
    expect(heat.startedTick).toBe(7);
    expect(heat.peak).toBe(2_010);
    expect(atob(heat.tiles)).toHaveLength(TILE_COUNT);

    const { intensity, dominantMode } = decodeOccupancyHeat(heat);
    expect(intensity[0]).toBe(0);
    expect(intensity[1]).toBeCloseTo(1 / OCCUPANCY_LEVELS);
    expect(intensity[3]).toBeGreaterThan(intensity[1]!);
    expect(intensity[9]).toBeGreaterThan(intensity[3]!);
    expect(intensity[9]).toBeLessThan(1);
    expect(intensity[5]).toBe(1);
    expect(OCCUPANCY_MODES[dominantMode[1]!]).toBe("surveying");
    expect(OCCUPANCY_MODES[dominantMode[9]!]).toBe("crafting");
    expect(OCCUPANCY_MODES[dominantMode[5]!]).toBe("harvesting");
  });

  it("keeps the same picture as all-time counts grow and fades a uniform world", () => {
    const world = createInitialWorld(41, 0);
    advanceWorld(world, 200);
    const heat = encodeOccupancyHeat(world.occupancy);
    expect(encodeOccupancyHeat(scaledLedger(world.occupancy, 1_000)).tiles).toBe(heat.tiles);

    const uniform = emptyOccupancy(0);
    uniform.modes.surveying.fill(500);
    const uniformLevels = [...decodeOccupancyHeat(encodeOccupancyHeat(uniform)).intensity];
    expect(new Set(uniformLevels.map((level) => Math.round(level * OCCUPANCY_LEVELS)))).toEqual(
      new Set([1]),
    );
    const malformed = decodeOccupancyHeat({ ...heat, tiles: "not base64!" });
    expect(malformed.intensity.every((level) => level === 0)).toBe(true);
  });

  it("ships about nine kilobytes of heat instead of raw counts in each snapshot", () => {
    const world = createInitialWorld(41, 0);
    advanceWorld(world, 120);
    const snapshot = publicSnapshot(world, false);
    expect(snapshot).not.toHaveProperty("occupancy");
    expect(world.occupancy.modes.surveying).toHaveLength(TILE_COUNT);
    expect(snapshot.heat.tiles).toHaveLength(Math.ceil(TILE_COUNT / 3) * 4);
    const withoutHeat = JSON.stringify({ ...snapshot, heat: undefined }).length;
    expect(JSON.stringify(snapshot).length - withoutHeat).toBeLessThan(9_400);
  });
});
