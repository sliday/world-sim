export function wrappedTarget(current: number, next: number, size: number): number {
  const normalized = ((current % size) + size) % size;
  let delta = next - normalized;
  if (delta > size / 2) delta -= size;
  else if (delta < -size / 2) delta += size;
  return current + delta;
}

const SNAP_RESPONSE_MS = 180;

export function easeToward(
  current: number,
  target: number,
  elapsedMs: number,
  responseMs = SNAP_RESPONSE_MS,
): number {
  if (Math.abs(target - current) < 0.0001) return target;
  const alpha = 1 - Math.exp(-Math.min(Math.max(elapsedMs, 0), 50) / responseMs);
  return current + (target - current) * alpha;
}

/**
 * Easing response for one snapshot's movement. The expected gap to the next snapshot is the
 * world's tick interval, shortened when snapshots arrive faster (catch-up bursts). A quarter of
 * that gap leaves about 2% of the move at the next snapshot, so bots glide instead of hopping.
 * A zero gap (first snapshot, world replaced) settles at the original fast response.
 */
export function glideResponseMs(msPerTick: number, measuredGapMs: number): number {
  return Math.max(SNAP_RESPONSE_MS, Math.min(msPerTick, Math.max(measuredGapMs, 0)) / 4);
}

export function normalizeSettled(value: number, target: number, size: number): [number, number] {
  if (Math.abs(target - value) >= 0.0001 || (value >= 0 && value < size)) return [value, target];
  const normalized = ((value % size) + size) % size;
  return [normalized, normalized];
}

export function clampOverlayAnchor(
  screenX: number,
  desiredScreenY: number,
  overlayWidth: number,
  viewportWidth: number,
  viewportHeight: number,
  margin = 4,
): [number, number] {
  const halfWidth = overlayWidth / 2;
  const minX = margin + halfWidth;
  const maxX = Math.max(minX, viewportWidth - margin - halfWidth);
  const halfHeight = 9;
  const minY = margin + halfHeight;
  const maxY = Math.max(minY, viewportHeight - margin - halfHeight);
  return [Math.min(Math.max(screenX, minX), maxX), Math.min(Math.max(desiredScreenY, minY), maxY)];
}

export function fitOverlayText(
  value: string,
  maximumWidth: number,
  measure: (text: string) => number,
): string {
  if (measure(value) <= maximumWidth) return value;
  const ellipsis = "…";
  if (measure(ellipsis) > maximumWidth) return "";
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (measure(`${value.slice(0, middle).trimEnd()}${ellipsis}`) <= maximumWidth) low = middle;
    else high = middle - 1;
  }
  return `${value.slice(0, low).trimEnd()}${ellipsis}`;
}
