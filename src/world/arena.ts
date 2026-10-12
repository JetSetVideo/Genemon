/**
 * Arena: a seeded heightmap + ground-type grid + water level + props. Pure data (no renderer) so the
 * same arena drives physics, combat and the 3D view. Grounds are MUTABLE: reactions freeze water,
 * melt ice, burn grass to ash, turn soil to mud (version++ lets the renderer recolour).
 */
import { clamp, fbm2, smoothstep, type V3, v3 } from "../core/math.ts";
import { hashSeed, Rng } from "../core/rng.ts";
import { GROUND_IDS, type Ground, type GroundId, GROUNDS, transformGround } from "../data/grounds.ts";
import type { ElementId } from "../data/elements.ts";
import type { WeatherId } from "../data/weather.ts";

export const ARENA_KINDS = ["meadow", "lake", "volcano", "canyon", "tundra", "swamp", "crystal", "city", "beach", "forest"] as const;
export type ArenaKind = typeof ARENA_KINDS[number];

export const ARENA_INFO: Record<ArenaKind, { name: string; weathers: WeatherId[]; note: string }> = {
  meadow: { name: "Sunny Meadow", weathers: ["clear", "rain", "wind"], note: "Grass, soil and a pond: the neutral ground." },
  lake: { name: "Mirror Lake", weathers: ["clear", "rain", "fog", "storm"], note: "A central lake: swimmers and conduction rule." },
  volcano: { name: "Ember Caldera", weathers: ["heatwave", "ashfall", "clear"], note: "Lava crater, ash and stone." },
  canyon: { name: "Red Canyon", weathers: ["clear", "sandstorm", "wind"], note: "High walls, sandy floor, a dry riverbed." },
  tundra: { name: "Frost Tundra", weathers: ["snow", "clear", "aurora"], note: "Snow and a frozen lake: slippery ice." },
  swamp: { name: "Murk Swamp", weathers: ["fog", "rain", "acidRain"], note: "Mud, muddy water and moss: slow and conductive." },
  crystal: { name: "Crystal Grotto", weathers: ["clear", "aurora", "eclipse"], note: "Stone floor studded with crystals." },
  city: { name: "Neon Plaza", weathers: ["clear", "rain", "storm"], note: "Metal plates and stone terraces." },
  beach: { name: "Tidal Beach", weathers: ["clear", "wind", "rain"], note: "Sand dunes facing deep water." },
  forest: { name: "Elder Forest", weathers: ["clear", "fog", "rain"], note: "Moss, roots and dense trees." },
};

export interface ArenaSpec {
  seed: number;
  kind: ArenaKind;
  weather: WeatherId;
  /** Side length in metres. */
  size?: number;
  /** Local hour 0-24 (real time feeds this). */
  hour: number;
}

export interface Prop {
  x: number;
  z: number;
  kind: "rock" | "tree" | "crystal" | "pillar" | "reed" | "dune";
  scale: number;
  rot: number;
}

export class Arena {
  readonly spec: Required<ArenaSpec>;
  readonly n: number;
  readonly size: number;
  readonly cell: number;
  readonly half: number;
  readonly radius: number;
  readonly heights: Float32Array;
  readonly grounds: Uint8Array;
  waterLevel: number;
  props: Prop[] = [];
  /** Incremented whenever the ground grid changes. */
  version = 0;

  constructor(spec: ArenaSpec, n = 65) {
    this.spec = { size: 44, ...spec };
    this.n = n;
    this.size = this.spec.size;
    this.cell = this.size / (n - 1);
    this.half = this.size / 2;
    this.radius = this.half - 3.5;
    this.heights = new Float32Array(n * n);
    this.grounds = new Uint8Array(n * n);
    this.waterLevel = -100;
  }

  idx(i: number, j: number): number {
    return clamp(j, 0, this.n - 1) * this.n + clamp(i, 0, this.n - 1);
  }

  toGrid(x: number, z: number): [number, number] {
    return [(x + this.half) / this.cell, (z + this.half) / this.cell];
  }

  heightAt(x: number, z: number): number {
    const [gx, gz] = this.toGrid(x, z);
    const i = Math.floor(clamp(gx, 0, this.n - 1.001)), j = Math.floor(clamp(gz, 0, this.n - 1.001));
    const fx = clamp(gx - i, 0, 1), fz = clamp(gz - j, 0, 1);
    const h = this.heights;
    const a = h[this.idx(i, j)], b = h[this.idx(i + 1, j)], c = h[this.idx(i, j + 1)], d = h[this.idx(i + 1, j + 1)];
    return (a * (1 - fx) + b * fx) * (1 - fz) + (c * (1 - fx) + d * fx) * fz;
  }

  groundIdAt(x: number, z: number): GroundId {
    const [gx, gz] = this.toGrid(x, z);
    return GROUND_IDS[this.grounds[this.idx(Math.round(gx), Math.round(gz))]];
  }

  groundAt(x: number, z: number): Ground {
    return GROUNDS[this.groundIdAt(x, z)];
  }

  /** Walkable surface: liquid tiles report the water level, others the terrain height. */
  surfaceAt(x: number, z: number): number {
    const h = this.heightAt(x, z);
    return this.groundAt(x, z).liquid ? Math.max(h, this.waterLevel) : h;
  }

  gradientAt(x: number, z: number): { gx: number; gz: number } {
    const e = this.cell * 0.5;
    return {
      gx: (this.heightAt(x + e, z) - this.heightAt(x - e, z)) / (2 * e),
      gz: (this.heightAt(x, z + e) - this.heightAt(x, z - e)) / (2 * e),
    };
  }

  normalAt(x: number, z: number): V3 {
    const { gx, gz } = this.gradientAt(x, z);
    const l = Math.hypot(gx, 1, gz);
    return v3(-gx / l, 1 / l, -gz / l);
  }

  /** Apply an element to a disc of ground; returns the number of transformed cells. */
  applyElement(x: number, z: number, r: number, element: ElementId): number {
    return this.paint(x, z, r, (g) => transformGround(g, element));
  }

  setGround(x: number, z: number, r: number, ground: GroundId): number {
    return this.paint(x, z, r, (g) => (g === ground ? null : ground));
  }

  private paint(x: number, z: number, r: number, f: (g: GroundId) => GroundId | null): number {
    const [cx, cz] = this.toGrid(x, z);
    const rc = r / this.cell;
    let changed = 0;
    for (let j = Math.floor(cz - rc); j <= Math.ceil(cz + rc); j++) {
      for (let i = Math.floor(cx - rc); i <= Math.ceil(cx + rc); i++) {
        if (i < 0 || j < 0 || i >= this.n || j >= this.n) continue;
        if ((i - cx) ** 2 + (j - cz) ** 2 > rc * rc) continue;
        const k = j * this.n + i;
        const next = f(GROUND_IDS[this.grounds[k]]);
        if (next) {
          this.grounds[k] = GROUND_IDS.indexOf(next);
          changed++;
        }
      }
    }
    if (changed) this.version++;
    return changed;
  }

  /** Share of each ground type inside the playable circle (for MMR context and arena cards). */
  groundShares(): Partial<Record<GroundId, number>> {
    const counts: Partial<Record<GroundId, number>> = {};
    let total = 0;
    for (let j = 0; j < this.n; j++) {
      for (let i = 0; i < this.n; i++) {
        const x = i * this.cell - this.half, z = j * this.cell - this.half;
        if (x * x + z * z > this.radius * this.radius) continue;
        const g = GROUND_IDS[this.grounds[j * this.n + i]];
        counts[g] = (counts[g] ?? 0) + 1;
        total++;
      }
    }
    for (const k of Object.keys(counts) as GroundId[]) counts[k] = counts[k]! / total;
    return counts;
  }
}

/** Build a deterministic arena for a spec. */
export function generateArena(spec: ArenaSpec): Arena {
  const a = new Arena(spec);
  const rng = new Rng(hashSeed(spec.seed, spec.kind, "arena"));
  const s = hashSeed(spec.seed, "terrain");
  const R = a.radius;
  const set = (i: number, j: number, h: number, g: GroundId) => {
    a.heights[j * a.n + i] = h;
    a.grounds[j * a.n + i] = GROUND_IDS.indexOf(g);
  };
  const pondX = rng.range(-R * 0.5, R * 0.5), pondZ = rng.range(-R * 0.5, R * 0.5);
  for (let j = 0; j < a.n; j++) {
    for (let i = 0; i < a.n; i++) {
      const x = i * a.cell - a.half, z = j * a.cell - a.half;
      const d = Math.hypot(x, z);
      const nse = fbm2(s, x * 0.07, z * 0.07, 4) - 0.5;
      const det = fbm2(s + 7, x * 0.25, z * 0.25, 2) - 0.5;
      const rim = smoothstep(R - 1, R + 5, d) * 3.2; // stadium bowl edge
      let h = nse * 1.6 + rim;
      let g: GroundId = "grass";
      switch (spec.kind) {
        case "meadow": {
          const pond = Math.exp(-((x - pondX) ** 2 + (z - pondZ) ** 2) / 22);
          h = nse * 1.4 - pond * 1.3 + rim;
          g = pond > 0.55 ? "water" : pond > 0.35 ? "sand" : det > 0.18 ? "soil" : nse > 0.28 ? "stone" : "grass";
          a.waterLevel = -0.55;
          break;
        }
        case "lake": {
          const bowl = Math.exp(-(d * d) / (R * R * 0.16));
          h = nse * 1.2 - bowl * 2.2 + rim;
          g = bowl > 0.75 ? "deepWater" : bowl > 0.5 ? "water" : bowl > 0.38 ? "muddyWater" : bowl > 0.28 ? "mud" : bowl > 0.2 ? "sand" : det > 0.2 ? "stone" : "grass";
          a.waterLevel = -0.75;
          break;
        }
        case "volcano": {
          const cone = Math.exp(-(d * d) / (R * R * 0.09));
          const crater = Math.exp(-(d * d) / (R * R * 0.015));
          h = cone * 4.2 - crater * 3.4 + nse * 1.2 + rim;
          g = crater > 0.45 ? "lava" : cone > 0.55 ? "stone" : det > 0.12 ? "gravel" : "ash";
          a.waterLevel = 4.2 * 0.6;
          break;
        }
        case "canyon": {
          const wall = smoothstep(R * 0.45, R * 0.8, Math.abs(z)) * 5;
          const bed = Math.exp(-(z * z) / 6);
          h = wall + nse * 0.8 - bed * 0.5 + rim * 0.5;
          g = wall > 2.5 ? "stone" : bed > 0.6 ? "gravel" : det > 0.15 ? "stone" : "sand";
          break;
        }
        case "tundra": {
          const frozen = Math.exp(-((x - pondX) ** 2 + (z - pondZ) ** 2) / 40);
          h = nse * 1.6 - frozen * 0.6 + rim;
          g = frozen > 0.45 ? "ice" : nse > 0.25 ? "stone" : "snow";
          break;
        }
        case "swamp": {
          h = nse * 0.9 + rim * 0.8;
          g = nse < -0.12 ? "muddyWater" : nse < -0.02 ? "mud" : det > 0.12 ? "water" : nse > 0.18 ? "moss" : "grass";
          a.waterLevel = -0.05;
          break;
        }
        case "crystal": {
          h = nse * 1.1 + rim * 1.4;
          g = det > 0.22 ? "crystal" : nse < -0.2 ? "salt" : "stone";
          break;
        }
        case "city": {
          const terrace = Math.round((nse + 0.5) * 3) * 0.45;
          const canal = Math.abs(x - pondX * 0.3) < 1.6;
          h = canal ? -0.6 : terrace + rim * 0.6;
          g = canal ? "water" : (Math.floor(x / 4) + Math.floor(z / 4)) % 3 === 0 ? "stone" : "metal";
          a.waterLevel = -0.3;
          break;
        }
        case "beach": {
          const sea = smoothstep(-R * 0.1, R * 0.7, x);
          h = (1 - sea) * (nse * 1.6 + 0.4) - sea * 1.6 + rim * (1 - sea);
          g = sea > 0.75 ? "deepWater" : sea > 0.45 ? "water" : sea > 0.15 ? "sand" : det > 0.15 ? "grass" : "sand";
          a.waterLevel = -0.5;
          break;
        }
        case "forest": {
          h = nse * 1.5 + rim;
          g = det > 0.15 ? "moss" : nse < -0.2 ? "mud" : det < -0.18 ? "soil" : "grass";
          break;
        }
      }
      set(i, j, h, g);
    }
  }
  // Props: decorative + readable landmarks (not physics obstacles in v0.1).
  const propKinds: Partial<Record<ArenaKind, Prop["kind"][]>> = {
    meadow: ["rock", "tree"],
    lake: ["reed", "rock"],
    volcano: ["rock", "pillar"],
    canyon: ["rock", "pillar"],
    tundra: ["rock", "crystal"],
    swamp: ["reed", "tree"],
    crystal: ["crystal", "pillar"],
    city: ["pillar"],
    beach: ["dune", "rock"],
    forest: ["tree", "tree", "rock"],
  };
  const kinds = propKinds[spec.kind] ?? ["rock"];
  const count = spec.kind === "forest" ? 28 : 16;
  for (let k = 0; k < count; k++) {
    const ang = rng.range(0, Math.PI * 2);
    const rad = rng.range(R * 0.78, R + 3);
    const x = Math.cos(ang) * rad, z = Math.sin(ang) * rad;
    const kind = rng.pick(kinds);
    if (kind === "reed" && !a.groundAt(x, z).liquid && rng.chance(0.5)) continue;
    a.props.push({ x, z, kind, scale: rng.range(0.7, 1.6), rot: rng.range(0, Math.PI * 2) });
  }
  return a;
}
