/**
 * Deterministic randomness. EVERY random draw in Genemon goes through an Rng so any genome,
 * battle, market tick or persona simulation can be replayed from its seed. This is the basis of
 * replays, server-side anti-cheat re-simulation, and reproducible AI training datasets.
 *
 * Seeds are hashed through a splitmix-style avalanche before use: sequential seeds (0,1,2...) fed
 * to a plain LCG produce correlated first draws, which silently biases single-sample decisions.
 */

/** FNV-1a 32-bit string hash. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** 32-bit avalanche mix (murmur3 fmix32 variant). */
export function mix32(x: number): number {
  x = (x >>> 0) ^ (x >>> 16);
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

/** Combine any mix of numbers/strings into one well-mixed 32-bit seed. */
export function hashSeed(...parts: Array<number | string>): number {
  let h = 0x9e3779b9;
  for (const p of parts) {
    const v = typeof p === "number" ? mix32(Math.floor(p) ^ Math.floor(p * 4096) >>> 0) : hashString(p);
    h = mix32(h ^ v ^ (h << 6) ^ (h >>> 2));
  }
  return h >>> 0;
}

export class Rng {
  readonly seed: number;
  #s: number;

  constructor(seed: number) {
    this.seed = seed >>> 0;
    this.#s = mix32(this.seed) || 0x6d2b79f5;
  }

  /** Uniform float in [0, 1) — mulberry32. */
  next(): number {
    let t = (this.#s = (this.#s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1 - 1e-9));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("Rng.pick on empty list");
    return items[Math.min(items.length - 1, Math.floor(this.next() * items.length))];
  }

  weighted<T>(items: readonly T[], weights: readonly number[]): T {
    let total = 0;
    for (const w of weights) total += Math.max(0, w);
    if (total <= 0) return this.pick(items);
    let r = this.next() * total;
    for (let i = 0; i < items.length; i++) {
      r -= Math.max(0, weights[i]);
      if (r <= 0) return items[i];
    }
    return items[items.length - 1];
  }

  /** Standard normal via Box-Muller. */
  normal(mean = 0, sd = 1): number {
    const u = Math.max(1e-12, this.next());
    const v = this.next();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  shuffle<T>(items: readonly T[]): T[] {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  /** Independent, stable sub-stream: depends only on this Rng's seed and the label, never on draws. */
  fork(label: string | number): Rng {
    return new Rng(hashSeed(this.seed, label));
  }
}
