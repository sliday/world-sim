import { describe, expect, it } from "vite-plus/test";
import { createInitialWorld, ensureAgentOperatingSystem } from "./engine";
import {
  currentMsPerTick,
  formatTickAge,
  LEGACY_MS_PER_TICK,
  NEW_AGE_WINDOW_SECONDS,
  tickSpanMs,
  withTickRate,
} from "./tick-age";
import type { WorldState } from "./types";

describe("tick age", () => {
  it("marks creations from the last five authoritative minutes as new", () => {
    expect(formatTickAge(1_000, 1_000)).toEqual({ ticks: 0, isNew: true, label: "[new]" });
    expect(formatTickAge(1_000, 1_000 - NEW_AGE_WINDOW_SECONDS)).toMatchObject({
      isNew: true,
      label: "[new]",
    });
    expect(formatTickAge(1_000, 1_000 - NEW_AGE_WINDOW_SECONDS - 1)).toMatchObject({
      isNew: false,
      label: "5m old",
    });
  });

  it("formats older creations in bounded minute, hour, and day units", () => {
    expect(formatTickAge(10_000, 9_399).label).toBe("10m old");
    expect(formatTickAge(10_000, 2_800).label).toBe("2h old");
    expect(formatTickAge(200_000, 27_200).label).toBe("2d old");
    expect(formatTickAge(10, 20)).toEqual({ ticks: 0, isNew: true, label: "[new]" });
  });

  it("converts ticks to wall-clock age across a tick-rate change", () => {
    const epochs = [
      { fromTick: 0, msPerTick: 1_000 },
      { fromTick: 100_000, msPerTick: 10_000 },
    ];
    // Thirty ten-second ticks are five minutes; thirty-one are past the new window.
    expect(formatTickAge(100_030, 100_000, epochs)).toMatchObject({ ticks: 30, isNew: true });
    expect(formatTickAge(100_031, 100_000, epochs)).toMatchObject({
      ticks: 31,
      isNew: false,
      label: "5m old",
    });
    // 600 one-second ticks plus 360 ten-second ticks: 10 minutes plus 1 hour.
    expect(tickSpanMs(99_400, 100_360, epochs)).toBe(600_000 + 3_600_000);
    expect(formatTickAge(100_360, 99_400, epochs).label).toBe("1h old");
    // Spans that end before the change keep the one-second rate.
    expect(formatTickAge(100_000, 99_400, epochs).label).toBe("10m old");
    // A full day at the slower rate is 8,640 ticks.
    expect(formatTickAge(108_640, 100_000, epochs).label).toBe("1d old");
    expect(formatTickAge(108_639, 100_000, epochs).label).toBe("23h old");
  });

  it("records a new epoch only when the configured rate changes", () => {
    const legacy = [{ fromTick: 0, msPerTick: LEGACY_MS_PER_TICK }];
    expect(withTickRate(legacy, 500, 1_000)).toEqual(legacy);
    const slowed = withTickRate(legacy, 500, 10_000);
    expect(slowed).toEqual([
      { fromTick: 0, msPerTick: 1_000 },
      { fromTick: 500, msPerTick: 10_000 },
    ]);
    expect(currentMsPerTick(slowed)).toBe(10_000);
    // A reload at the same tick with another rate replaces the epoch that never ran.
    expect(withTickRate(slowed, 500, 5_000)).toEqual([
      { fromTick: 0, msPerTick: 1_000 },
      { fromTick: 500, msPerTick: 5_000 },
    ]);
    // Reverting before any slow tick ran restores the original single epoch.
    expect(withTickRate(slowed, 500, 1_000)).toEqual(legacy);
    expect(currentMsPerTick(undefined)).toBe(LEGACY_MS_PER_TICK);
  });

  it("migrates worlds without a rate history to one-second ticks", () => {
    const fresh = createInitialWorld(7);
    expect(fresh.tickEpochs).toEqual([{ fromTick: 0, msPerTick: LEGACY_MS_PER_TICK }]);
    const legacy = createInitialWorld(7) as Partial<WorldState>;
    delete legacy.tickEpochs;
    const migrated = ensureAgentOperatingSystem(legacy as WorldState);
    expect(migrated.tickEpochs).toEqual([{ fromTick: 0, msPerTick: LEGACY_MS_PER_TICK }]);
    migrated.tickEpochs = [
      { fromTick: 0, msPerTick: 1_000 },
      { fromTick: 40, msPerTick: 10_000 },
    ];
    expect(ensureAgentOperatingSystem(migrated).tickEpochs).toHaveLength(2);
  });
});
