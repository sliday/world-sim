export const WORLD_DIARY_INTERVAL_TICKS = 3_600;
export const WORLD_DIARY_MAX_LINES = 5;
export const WORLD_DIARY_LINE_LENGTH = 140;

export function nextWorldDiaryTick(startTick: number): number {
  return Math.max(0, Math.floor(startTick)) + WORLD_DIARY_INTERVAL_TICKS;
}

export function normalizeWorldDiaryLines(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((line): line is string => typeof line === "string")
    .map((line) => line.replace(/\s+/g, " ").trim().slice(0, WORLD_DIARY_LINE_LENGTH))
    .filter(Boolean)
    .slice(0, WORLD_DIARY_MAX_LINES);
}
