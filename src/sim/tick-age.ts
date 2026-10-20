import type { TickEpoch } from "./types";

/** Creations younger than five wall-clock minutes read as new. */
export const NEW_AGE_WINDOW_SECONDS = 300;
/** Worlds created before tick epochs existed advanced one tick per second. */
export const LEGACY_MS_PER_TICK = 1_000;

const legacyEpochs: readonly TickEpoch[] = [{ fromTick: 0, msPerTick: LEGACY_MS_PER_TICK }];

export interface TickAge {
  ticks: number;
  isNew: boolean;
  label: string;
}

export function currentMsPerTick(epochs: readonly TickEpoch[] | undefined): number {
  return epochs?.at(-1)?.msPerTick ?? LEGACY_MS_PER_TICK;
}

/** Wall-clock milliseconds the world nominally spent advancing from `fromTick` to `toTick`. */
export function tickSpanMs(
  fromTick: number,
  toTick: number,
  epochs: readonly TickEpoch[] | undefined = legacyEpochs,
): number {
  if (!(toTick > fromTick)) return 0;
  const list = epochs.length ? epochs : legacyEpochs;
  let total = 0;
  for (let index = 0; index < list.length; index += 1) {
    const start = index === 0 ? -Infinity : list[index]!.fromTick;
    const end = list[index + 1]?.fromTick ?? Infinity;
    const overlap = Math.min(toTick, end) - Math.max(fromTick, start);
    if (overlap > 0) total += overlap * list[index]!.msPerTick;
  }
  return total;
}

/** Returns epochs where ticks after `tick` run at `msPerTick`; unchanged rates add nothing. */
export function withTickRate(
  epochs: readonly TickEpoch[],
  tick: number,
  msPerTick: number,
): TickEpoch[] {
  if (epochs.at(-1)?.msPerTick === msPerTick) return [...epochs];
  const kept = epochs.filter((epoch) => epoch.fromTick < tick);
  if (kept.at(-1)?.msPerTick === msPerTick) return kept;
  return [...kept, { fromTick: tick, msPerTick }];
}

export function formatTickAge(
  nowTick: number,
  createdTick: number,
  epochs?: readonly TickEpoch[],
): TickAge {
  const ticks = Math.max(0, Math.floor(nowTick - createdTick));
  const seconds = Math.floor(tickSpanMs(createdTick, nowTick, epochs) / 1_000);
  if (seconds <= NEW_AGE_WINDOW_SECONDS) return { ticks, isNew: true, label: "[new]" };
  if (seconds < 3_600) return { ticks, isNew: false, label: `${Math.floor(seconds / 60)}m old` };
  if (seconds < 86_400)
    return { ticks, isNew: false, label: `${Math.floor(seconds / 3_600)}h old` };
  return { ticks, isNew: false, label: `${Math.floor(seconds / 86_400)}d old` };
}
