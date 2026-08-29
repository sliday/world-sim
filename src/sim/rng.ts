export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0 || 0x6d2b79f5;
  }

  next(): number {
    let value = this.state;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.state = value >>> 0;
    return this.state / 0x1_0000_0000;
  }

  int(max: number): number {
    return Math.floor(this.next() * max);
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    const item = items[this.int(items.length)];
    if (item === undefined) throw new Error("Cannot pick from an empty collection");
    return item;
  }

  get snapshot(): number {
    return this.state;
  }
}

export function hashNoise(seed: number, x: number, y: number): number {
  let value = (seed ^ Math.imul(x, 374761393) ^ Math.imul(y, 668265263)) >>> 0;
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 0xffff_ffff;
}

export function toroidalField(
  seed: number,
  x: number,
  y: number,
  width: number,
  height: number,
  octave = 1,
): number {
  const ax = (Math.PI * 2 * x * octave) / width;
  const ay = (Math.PI * 2 * y * octave) / height;
  const p1 = Math.sin(ax + seed * 0.013) * Math.cos(ay - seed * 0.017);
  const p2 = Math.sin(ax * 2 - ay + seed * 0.0031) * 0.5;
  const p3 = Math.cos(ay * 3 + ax + seed * 0.0017) * 0.25;
  return (p1 + p2 + p3 + 1.75) / 3.5;
}
