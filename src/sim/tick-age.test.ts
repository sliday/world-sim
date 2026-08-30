import { describe, expect, it } from "vite-plus/test";
import { formatTickAge, NEW_TICK_WINDOW } from "./tick-age";

describe("tick age", () => {
  it("marks creations from the last five authoritative minutes as new", () => {
    expect(formatTickAge(1_000, 1_000)).toEqual({ ticks: 0, isNew: true, label: "[NEW]" });
    expect(formatTickAge(1_000, 1_000 - NEW_TICK_WINDOW)).toMatchObject({
      isNew: true,
      label: "[NEW]",
    });
    expect(formatTickAge(1_000, 1_000 - NEW_TICK_WINDOW - 1)).toMatchObject({
      isNew: false,
      label: "5M OLD",
    });
  });

  it("formats older creations in bounded minute, hour, and day units", () => {
    expect(formatTickAge(10_000, 9_399).label).toBe("10M OLD");
    expect(formatTickAge(10_000, 2_800).label).toBe("2H OLD");
    expect(formatTickAge(200_000, 27_200).label).toBe("2D OLD");
    expect(formatTickAge(10, 20)).toEqual({ ticks: 0, isNew: true, label: "[NEW]" });
  });
});
