import {
  WORLD_HEIGHT,
  WORLD_WIDTH,
  type AgentMode,
  type OccupancyHeat,
  type OccupancyLedger,
} from "./types";

/** Wire order of activity layers; the index fills the top three bits of each heat byte. */
export const OCCUPANCY_MODES: readonly AgentMode[] = [
  "surveying",
  "harvesting",
  "fabricating",
  "maintaining",
  "forking",
  "crafting",
  "creating",
];
export const OCCUPANCY_LEVELS = 31;
/** The top level sits at this quantile of visited tiles, so one parked agent cannot wash out the map. */
const OCCUPANCY_REFERENCE_QUANTILE = 0.99;
/** Tiles at or below the median visited tile share the faintest level: ordinary wandering. */
const OCCUPANCY_BASELINE_QUANTILE = 0.5;
/** The top level needs at least this multiple of the typical tile, so a uniform world stays faint. */
const OCCUPANCY_MIN_SPAN = 4;
const TILE_COUNT = WORLD_WIDTH * WORLD_HEIGHT;
const zeroLayer = () => Array.from({ length: TILE_COUNT }, () => 0);

export interface DecodedOccupancyHeat {
  /** 0 never visited, 1/31 typical or quieter, rising on a log scale to 1 at the busiest tiles. */
  intensity: Float32Array;
  /** Index into OCCUPANCY_MODES of the activity with the most agent-ticks on each tile. */
  dominantMode: Uint8Array;
}

export function emptyOccupancy(startedTick: number): OccupancyLedger {
  return {
    startedTick,
    modes: Object.fromEntries(OCCUPANCY_MODES.map((mode) => [mode, zeroLayer()])) as Record<
      AgentMode,
      number[]
    >,
  };
}

/** Starts tracking at migration; history is never reconstructed from bounded trails. */
export function ensureOccupancy(
  ledger: OccupancyLedger | undefined,
  tick: number,
): OccupancyLedger {
  const result = ledger ?? emptyOccupancy(tick);
  for (const mode of OCCUPANCY_MODES)
    if (result.modes[mode]?.length !== TILE_COUNT) result.modes[mode] = zeroLayer();
  return result;
}

export function encodeOccupancyHeat(ledger: OccupancyLedger): OccupancyHeat {
  const totals = new Float64Array(TILE_COUNT);
  const best = new Float64Array(TILE_COUNT);
  const dominant = new Uint8Array(TILE_COUNT);
  OCCUPANCY_MODES.forEach((mode, modeIndex) => {
    const layer = ledger.modes[mode];
    for (let tile = 0; tile < TILE_COUNT; tile += 1) {
      const count = layer[tile] ?? 0;
      totals[tile] += count;
      if (count > best[tile]) {
        best[tile] = count;
        dominant[tile] = modeIndex;
      }
    }
  });
  const visited = totals.filter((total) => total > 0).sort();
  const peak = visited.at(-1) ?? 0;
  const quantile = (q: number) => visited[Math.floor((visited.length - 1) * q)] ?? 1;
  const baseline = quantile(OCCUPANCY_BASELINE_QUANTILE);
  const reference = Math.max(quantile(OCCUPANCY_REFERENCE_QUANTILE), baseline * OCCUPANCY_MIN_SPAN);
  // Each tile sits between the typical and the busiest visited tiles on a log scale. Both anchors
  // grow with the world, so all-time counts keep their contrast instead of flattening into a
  // uniform haze once every tile has accumulated visits.
  const scale = (OCCUPANCY_LEVELS - 1) / Math.log(reference / baseline);
  let binary = "";
  for (let tile = 0; tile < TILE_COUNT; tile += 1) {
    const total = totals[tile];
    const level =
      total > 0
        ? Math.min(
            OCCUPANCY_LEVELS,
            Math.max(1, Math.round(1 + Math.log(total / baseline) * scale)),
          )
        : 0;
    binary += String.fromCharCode(level ? (dominant[tile] << 5) | level : 0);
  }
  return { startedTick: ledger.startedTick, peak, tiles: btoa(binary) };
}

export function decodeOccupancyHeat(heat: OccupancyHeat): DecodedOccupancyHeat {
  const intensity = new Float32Array(TILE_COUNT);
  const dominantMode = new Uint8Array(TILE_COUNT);
  let binary = "";
  try {
    binary = atob(heat.tiles);
  } catch {
    return { intensity, dominantMode };
  }
  if (binary.length !== TILE_COUNT) return { intensity, dominantMode };
  for (let tile = 0; tile < TILE_COUNT; tile += 1) {
    const byte = binary.charCodeAt(tile);
    intensity[tile] = (byte & OCCUPANCY_LEVELS) / OCCUPANCY_LEVELS;
    dominantMode[tile] = Math.min(OCCUPANCY_MODES.length - 1, byte >> 5);
  }
  return { intensity, dominantMode };
}
