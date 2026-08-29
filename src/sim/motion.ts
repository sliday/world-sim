export function wrappedTarget(current: number, next: number, size: number): number {
  const normalized = ((current % size) + size) % size;
  let delta = next - normalized;
  if (delta > size / 2) delta -= size;
  else if (delta < -size / 2) delta += size;
  return current + delta;
}

export function easeToward(
  current: number,
  target: number,
  elapsedMs: number,
  responseMs = 180,
): number {
  if (Math.abs(target - current) < 0.0001) return target;
  const alpha = 1 - Math.exp(-Math.min(Math.max(elapsedMs, 0), 50) / responseMs);
  return current + (target - current) * alpha;
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
