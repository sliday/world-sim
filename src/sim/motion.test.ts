import { describe, expect, it } from "vite-plus/test";
import { easeToward, glideResponseMs } from "./motion";

function glide(responseMs: number, elapsedMs: number): number {
  let x = 0;
  for (let time = 0; time < elapsedMs; time += 16) x = easeToward(x, 1, 16, responseMs);
  return x;
}

describe("snapshot glide", () => {
  it("scales the easing response with the tick interval", () => {
    expect(glideResponseMs(1_000, 1_000)).toBe(250);
    expect(glideResponseMs(10_000, 10_000)).toBe(2_500);
    expect(glideResponseMs(60_000, 60_000)).toBe(15_000);
  });

  it("spreads a one-tile move across most of a ten-second tick", () => {
    const responseMs = glideResponseMs(10_000, 10_000);
    expect(glide(responseMs, 1_000)).toBeLessThan(0.5);
    expect(glide(responseMs, 7_500)).toBeGreaterThan(0.9);
    expect(glide(responseMs, 10_000)).toBeGreaterThan(0.97);
  });

  it("keeps up with catch-up bursts, pauses, and replaced worlds", () => {
    // Snapshots arriving faster than the tick interval shorten the glide.
    expect(glideResponseMs(10_000, 2_000)).toBe(500);
    expect(glideResponseMs(10_000, 300)).toBe(180);
    // A paused world that resumes still glides over one tick interval, not the pause.
    expect(glideResponseMs(10_000, 90_000)).toBe(2_500);
    // First snapshot or a replaced world settles at the original fast response.
    expect(glideResponseMs(10_000, 0)).toBe(180);
    expect(glideResponseMs(80, 160)).toBe(180);
  });
});
