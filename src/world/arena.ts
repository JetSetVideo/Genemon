/**
 * Arena: a seeded heightmap + ground-type grid + water level + props. Pure data (no renderer) so the
 * same arena drives physics, combat and the 3D view. Grounds are MUTABLE: reactions freeze water,
 * melt ice, burn grass to ash, turn soil to mud (version++ lets the renderer recolour).
 *
 * Pass 5 [P5-W1]:
 * - HEIGHT LEVELS: every kind terraces its terrain into clear level bands (`levelStep` metres apart,
 *   `levelAt(x, z)` = band index) and raises a few PLATEAUS with one gentle RAMP each.
 * - DENSITY: interior props (rocks, trees, crystals, pillars, ruins, bushes, reeds, dunes) at a
 *   per-kind density x `spec.density`; each prop has a footprint radius, a height and a `solid` flag.
 *   Solid props raise a small mound in the heightmap (physics feels them through heightAt) and can be
 *   made hard obstacles / line-of-sight cover by the battle (`collideProps`, `propOnSegment`).
 * - ALTITUDE: `altitudeM` (metres above sea level of the arena floor, per kind or `spec.altitudeM`)
 *   for the life lane's circadian / breath effects; `altitudeAt(x, z)` adds the local terrain.
 * - SYMMETRY: `spec.symmetry` = "mirror" (x -> -x) or "rotational" (180 deg about the centre) copies
 *   one half of the heights, grounds and props onto the other, exactly, so neither side has an
 *   advantage (ranked maps: `rankedSymmetry`).
 * - SPAWNS: candidate start points per side (`spawns.side0[i]` / `spawns.side1[i]` are images of each
 *   other under the arena's symmetry; `SPAWN_SLOTS[i]` names them). `spawnAnchor` turns a chosen slot
 *   into the formation centre the battle places a side around (slot 0 = the legacy start line).
 */
import { clamp, fbm2, smoothstep, type V3, v3 } from "../core/math.ts";
import { hashSeed, Rng } from "../core/rng.ts";
import { GROUND_IDS, type Ground, type GroundId, GROUNDS, transformGround } from "../data/grounds.ts";
import type { ElementId } from "../data/elements.ts";
import type { WeatherId } from "../data/weather.ts";

export const ARENA_KINDS = ["meadow", "lake", "volcano", "canyon", "tundra", "swamp", "crystal", "city", "beach", "forest"] as const;
export type ArenaKind = typeof ARENA_KINDS[number];

export interface ArenaInfo {
  name: string;
  weathers: WeatherId[];
  note: string;
  /** Altitude of the arena floor above sea level, metres [P5-W1, P5-G4]. */
  altitudeM: number;
}

export const ARENA_INFO: Record<ArenaKind, ArenaInfo> = {
  meadow: { name: "Sunny Meadow", weathers: ["clear", "rain", "wind"], note: "Grass, soil and a pond: the neutral ground.", altitudeM: 320 },
  lake: { name: "Mirror Lake", weathers: ["clear", "rain", "fog", "storm"], note: "A central lake: swimmers and conduction rule.", altitudeM: 1100 },
  volcano: { name: "Ember Caldera", weathers: ["heatwave", "ashfall", "clear"], note: "Lava crater, ash and stone.", altitudeM: 2350 },
  canyon: { name: "Red Canyon", weathers: ["clear", "sandstorm", "wind"], note: "High walls, sandy floor, a dry riverbed.", altitudeM: 1450 },
  tundra: { name: "Frost Tundra", weathers: ["snow", "clear", "aurora"], note: "Snow and a frozen lake: slippery ice.", altitudeM: 900 },
  swamp: { name: "Murk Swamp", weathers: ["fog", "rain", "acidRain"], note: "Mud, muddy water and moss: slow and conductive.", altitudeM: 15 },
  crystal: { name: "Crystal Grotto", weathers: ["clear", "aurora", "eclipse"], note: "Stone floor studded with crystals.", altitudeM: 1800 },
  city: { name: "Neon Plaza", weathers: ["clear", "rain", "storm"], note: "Metal plates and stone terraces.", altitudeM: 60 },
  beach: { name: "Tidal Beach", weathers: ["clear", "wind", "rain"], note: "Sand dunes facing deep water.", altitudeM: 2 },
  forest: { name: "Elder Forest", weathers: ["clear", "fog", "rain"], note: "Moss, roots and dense trees.", altitudeM: 650 },
};

/** "mirror": h(x, z) = h(-x, z). "rotational": h(x, z) = h(-x, -z). Side 0 starts at -x, side 1 at +x. */
export type ArenaSymmetry = "none" | "mirror" | "rotational";
export const ARENA_SYMMETRIES: readonly ArenaSymmetry[] = ["none", "mirror", "rotational"];

export interface ArenaSpec {
  seed: number;
  kind: ArenaKind;
  weather: WeatherId;
  /** Side length in metres. */
  size?: number;
  /** Local hour 0-24 (real time feeds this). */
  hour: number;
  /** Symmetric layout (ranked maps). Default "none". */
  symmetry?: ArenaSymmetry;
  /** Interior prop density multiplier (0 = an empty floor, 1 = the kind's default, max 3). Default 1. */
  density?: number;
  /** Override the kind's altitude above sea level (m), e.g. the altitude of a world place. */
  altitudeM?: number;
}

export const PROP_KINDS = ["rock", "tree", "crystal", "pillar", "reed", "dune", "ruin", "bush"] as const;
export type PropKind = typeof PROP_KINDS[number];

export interface PropDef {
  /** Footprint radius at scale 1 (m). */
  radius: number;
  /** Height at scale 1 (m). */
  height: number;
  /** Blocks bodies and lines of sight (rock, tree, crystal, pillar, ruin); soft props only hide. */
  solid: boolean;
  /** Mound baked into the heightmap at scale 1 (m). */
  mound: number;
  name: string;
}

export const PROP_DEFS: Record<PropKind, PropDef> = {
  rock: { radius: 1.0, height: 1.1, solid: true, mound: 0.32, name: "Rock" },
  tree: { radius: 0.45, height: 5, solid: true, mound: 0.14, name: "Tree" },
  crystal: { radius: 0.8, height: 2.2, solid: true, mound: 0.26, name: "Crystal" },
  pillar: { radius: 0.55, height: 4, solid: true, mound: 0.18, name: "Pillar" },
  reed: { radius: 0.5, height: 1.6, solid: false, mound: 0, name: "Reeds" },
  dune: { radius: 2.4, height: 0.6, solid: false, mound: 0.5, name: "Dune" },
  ruin: { radius: 1.3, height: 1.8, solid: true, mound: 0.22, name: "Ruin" },
  bush: { radius: 0.8, height: 0.9, solid: false, mound: 0, name: "Bush" },
};

export interface Prop {
  x: number;
  z: number;
  kind: PropKind;
  scale: number;
  rot: number;
  /** Footprint radius in metres (PROP_DEFS radius x scale). */
  radius: number;
  /** Height in metres (PROP_DEFS height x scale). */
  height: number;
  solid: boolean;
  /** Inside the playable circle (an obstacle / cover), not a decoration of the stands. */
  inner: boolean;
}

/** Per-kind terrain levels and prop density. */
interface KindShape {
  /** Terrace step (m); level bands are this far apart. */
  step: number;
  /** Ramp share of a step (0..1): small = sharp cliffs, 1 = soft rolling bands. */
  ramp: number;
  plateaus: number;
  /** Plateau lift in level steps. */
  lift: number;
  /** Low-frequency relief amplitude (m) added to dry ground before terracing (more level bands). */
  relief: number;
  /** Interior props at density 1. */
  props: number;
  interior: PropKind[];
}

const SHAPES: Record<ArenaKind, KindShape> = {
  meadow: { step: 0.8, ramp: 0.55, plateaus: 2, lift: 1, relief: 1.1, props: 9, interior: ["rock", "tree", "bush", "bush"] },
  lake: { step: 0.7, ramp: 0.6, plateaus: 2, lift: 1, relief: 0.9, props: 7, interior: ["reed", "rock", "reed", "bush"] },
  volcano: { step: 1.0, ramp: 0.45, plateaus: 0, lift: 1, relief: 0, props: 8, interior: ["rock", "pillar", "rock"] },
  canyon: { step: 1.25, ramp: 0.3, plateaus: 3, lift: 1, relief: 0.4, props: 9, interior: ["rock", "pillar", "ruin"] },
  tundra: { step: 0.8, ramp: 0.5, plateaus: 2, lift: 1, relief: 1.1, props: 8, interior: ["rock", "crystal", "rock"] },
  swamp: { step: 0.5, ramp: 0.8, plateaus: 1, lift: 1, relief: 0, props: 11, interior: ["reed", "tree", "bush", "reed"] },
  crystal: { step: 0.85, ramp: 0.35, plateaus: 3, lift: 1, relief: 1.4, props: 12, interior: ["crystal", "crystal", "pillar", "rock"] },
  city: { step: 0.45, ramp: 0.25, plateaus: 3, lift: 2, relief: 0, props: 10, interior: ["pillar", "ruin", "ruin"] },
  beach: { step: 0.6, ramp: 0.75, plateaus: 1, lift: 1, relief: 0.6, props: 7, interior: ["dune", "rock", "bush"] },
  forest: { step: 0.8, ramp: 0.55, plateaus: 2, lift: 1, relief: 1.2, props: 18, interior: ["tree", "tree", "tree", "bush", "rock"] },
};

/** Level band step (m) of an arena kind. */
export function levelStepOf(kind: ArenaKind): number {
  return SHAPES[kind].step;
}

/** Interior props at density 1 for an arena kind. */
export function propBudgetOf(kind: ArenaKind): number {
  return SHAPES[kind].props;
}

/**
 * Candidate start points of side 0 (side 1 gets their image under the arena's symmetry), in units of
 * the playable radius R. Side 0 faces +x: its left is -z, its right +z. Slot 0 is the legacy start
 * line (the formation used before pass 5), so `spawn` 0 reproduces old battles bit for bit.
 */
export const SPAWN_SLOTS = [
  { id: "centre", label: "Centre line", ux: -0.3, uz: 0 },
  { id: "left", label: "Left flank", ux: -0.27, uz: -0.42 },
  { id: "right", label: "Right flank", ux: -0.27, uz: 0.42 },
  { id: "back", label: "Back line", ux: -0.55, uz: 0 },
] as const;
export type SpawnSlotId = typeof SPAWN_SLOTS[number]["id"];

export interface ArenaSpawns {
  side0: V3[];
  side1: V3[];
}

/** Image of a point of side 0's half under a symmetry (none behaves like mirror for spawns). */
export function symmetricImage(x: number, z: number, sym: ArenaSymmetry): { x: number; z: number } {
  return sym === "rotational" ? { x: -x, z: -z } : { x: -x, z };
}

/** Ranked maps are symmetric; the ladder seed picks mirror or rotation (beach: its sea forces mirror). */
export function rankedSymmetry(kind: ArenaKind, seed: number): Exclude<ArenaSymmetry, "none"> {
  if (kind === "beach") return "mirror";
  return new Rng(hashSeed(seed, kind, "ranked-symmetry")).chance(0.5) ? "mirror" : "rotational";
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
  /** Plateau discs raised by the generator (centre, radius, ramp direction), for minimaps and tests. */
  plateaus: { x: number; z: number; r: number; rampAngle: number }[] = [];
  /** Candidate start points per side (filled by generateArena; side1[i] is the image of side0[i]). */
  spawns: ArenaSpawns = { side0: [], side1: [] };
  /** Incremented whenever the ground grid changes. */
  version = 0;

  constructor(spec: ArenaSpec, n = 65) {
    this.spec = {
      ...spec,
      size: spec.size ?? 44,
      symmetry: spec.symmetry ?? "none",
      density: clamp(spec.density ?? 1, 0, 3),
      altitudeM: spec.altitudeM ?? ARENA_INFO[spec.kind]?.altitudeM ?? 0,
    };
    this.n = n;
    this.size = this.spec.size;
    this.cell = this.size / (n - 1);
    this.half = this.size / 2;
    this.radius = this.half - 3.5;
    this.heights = new Float32Array(n * n);
    this.grounds = new Uint8Array(n * n);
    this.waterLevel = -100;
  }

  /** Altitude of the arena floor above sea level (m). */
  get altitudeM(): number {
    return this.spec.altitudeM;
  }

  get symmetry(): ArenaSymmetry {
    return this.spec.symmetry;
  }

  /** Metres between two level bands. */
  get levelStep(): number {
    return SHAPES[this.spec.kind]?.step ?? 0.8;
  }

  /** Distance from the centre of spawn slot 0 (the legacy start line): the formation scale reference. */
  get spawnRef(): number {
    return -SPAWN_SLOTS[0].ux * this.radius;
  }

  /** Altitude above sea level at a point (m). */
  altitudeAt(x: number, z: number): number {
    return this.spec.altitudeM + this.heightAt(x, z);
  }

  /** Level band index at a point (terrace treads sit at integer multiples of levelStep). */
  levelAt(x: number, z: number): number {
    return Math.round(this.heightAt(x, z) / this.levelStep);
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

  /** Interior (playable-circle) props. */
  innerProps(): Prop[] {
    return this.props.filter((p) => p.inner);
  }

  /**
   * Push a ground body out of every solid interior prop it overlaps and cancel its velocity into the
   * prop. Returns the number of props touched. Pure and deterministic (fixed iteration order).
   */
  collideProps(b: { pos: V3; vel: V3; radius: number }): number {
    let hits = 0;
    for (const p of this.props) {
      if (!p.solid || !p.inner) continue;
      const dx = b.pos.x - p.x, dz = b.pos.z - p.z;
      const min = p.radius + b.radius * 0.8;
      const d2 = dx * dx + dz * dz;
      if (d2 >= min * min) continue;
      const d = Math.sqrt(d2);
      const nx = d > 1e-6 ? dx / d : 1, nz = d > 1e-6 ? dz / d : 0;
      b.pos.x = p.x + nx * min;
      b.pos.z = p.z + nz * min;
      const vn = b.vel.x * nx + b.vel.z * nz;
      if (vn < 0) {
        b.vel.x -= vn * nx;
        b.vel.z -= vn * nz;
      }
      hits++;
    }
    return hits;
  }

  /** First solid interior prop crossing the segment a->b below height `y` above ground (cover), or null. */
  propOnSegment(ax: number, az: number, bx: number, bz: number, y = 0): Prop | null {
    const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
    let best: Prop | null = null, bestT = Infinity;
    for (const p of this.props) {
      if (!p.solid || !p.inner || p.height < y) continue;
      const t = l2 > 1e-9 ? clamp(((p.x - ax) * dx + (p.z - az) * dz) / l2, 0, 1) : 0;
      if (t <= 0 || t >= 1) continue; // standing at an end point is not cover between the two
      const cx = ax + dx * t - p.x, cz = az + dz * t - p.z;
      if (cx * cx + cz * cz < (p.radius * 0.9) ** 2 && t < bestT) {
        best = p;
        bestT = t;
      }
    }
    return best;
  }

  /** Nearest spawn slot of a side to a point, or null when none lies within maxDist metres. */
  nearestSpawn(x: number, z: number, side: 0 | 1 = 0, maxDist = Infinity): number | null {
    const list = side === 0 ? this.spawns.side0 : this.spawns.side1;
    let best: number | null = null, bd = maxDist;
    list.forEach((p, i) => {
      const d = Math.hypot(p.x - x, p.z - z);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    return best;
  }
}

/**
 * Formation centre of side `side` for spawn slot `slot`, scaled like the legacy start line: the battle
 * opens `gap` metres from the centre on slot 0 (gap = its size-based half gap), and every other slot
 * keeps the same proportion. Slot 0 returns exactly (-gap, 0) / (+gap, 0). Out-of-range slots = 0.
 */
export function spawnAnchor(a: Arena, side: 0 | 1, slot: number, gap: number): { x: number; z: number } {
  const list = side === 0 ? a.spawns.side0 : a.spawns.side1;
  const p = list[Number.isInteger(slot) && slot >= 0 && slot < list.length ? slot : 0];
  const ref = a.spawnRef;
  if (!p || !(ref > 0)) return { x: (side === 0 ? -1 : 1) * gap, z: 0 };
  return { x: (p.x / ref) * gap, z: (p.z / ref) * gap };
}

/** Soft terrace: flat treads at multiples of `step`, joined by ramps covering `w` of each step. */
export function terrace(h: number, step: number, w: number): number {
  if (!(step > 0)) return h;
  const q = h / step, f = Math.floor(q), t = q - f;
  const hw = clamp(w, 0.02, 1) / 2;
  return (f + smoothstep(0.5 - hw, 0.5 + hw, t)) * step;
}

/** Copy the canonical half of the height + ground grids onto the other half (exact symmetry). */
function symmetrizeGrid(a: Arena, sym: ArenaSymmetry): void {
  if (sym === "none") return;
  const n = a.n, c = (n - 1) / 2;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      let src = -1;
      if (sym === "mirror") {
        if (i < c) src = j * n + (n - 1 - i);
      } else if (i < c || (i === c && j < c)) src = (n - 1 - j) * n + (n - 1 - i);
      if (src < 0) continue;
      const dst = j * n + i;
      a.heights[dst] = a.heights[src];
      a.grounds[dst] = a.grounds[src];
    }
  }
}

function makeProp(kind: PropKind, x: number, z: number, scale: number, rot: number, R: number): Prop {
  const d = PROP_DEFS[kind];
  return { x, z, kind, scale, rot, radius: d.radius * scale, height: d.height * scale, solid: d.solid, inner: Math.hypot(x, z) < R };
}

/** Keep the canonical half (x > margin) of a prop list and add the symmetric images. */
function symmetrizeProps(props: Prop[], sym: ArenaSymmetry, R: number): Prop[] {
  if (sym === "none") return props;
  const keep = props.filter((p) => p.x > Math.max(0.6, p.radius));
  const out: Prop[] = [];
  for (const p of keep) {
    out.push(p);
    const im = symmetricImage(p.x, p.z, sym);
    out.push(makeProp(p.kind, im.x, im.z, p.scale, sym === "rotational" ? p.rot + Math.PI : -p.rot, R));
  }
  return out;
}

/** Distance from point (x, z) to segment (ax, az)-(bx, bz). */
function segDist(x: number, z: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
  const t = l2 > 0 ? clamp(((x - ax) * dx + (z - az) * dz) / l2, 0, 1) : 0;
  return Math.hypot(x - (ax + dx * t), z - (az + dz * t));
}

/** Build a deterministic arena for a spec. */
export function generateArena(spec: ArenaSpec): Arena {
  const a = new Arena(spec);
  const sym = a.spec.symmetry;
  const shape = SHAPES[spec.kind];
  const rng = new Rng(hashSeed(spec.seed, spec.kind, "arena"));
  const s = hashSeed(spec.seed, "terrain");
  const R = a.radius;
  const set = (i: number, j: number, h: number, g: GroundId) => {
    a.heights[j * a.n + i] = h;
    a.grounds[j * a.n + i] = GROUND_IDS.indexOf(g);
  };
  const pondX = rng.range(-R * 0.5, R * 0.5), pondZ = rng.range(-R * 0.5, R * 0.5);
  // Relief field, normalised to [-1, 1] over the playable circle so every seed gets its full set of
  // level bands (raw fbm can be nearly flat across 37 m for an unlucky seed).
  const relief = new Float32Array(a.n * a.n);
  if (shape.relief > 0) {
    let lo = Infinity, hi = -Infinity;
    for (let j = 0; j < a.n; j++) {
      for (let i = 0; i < a.n; i++) {
        const x = i * a.cell - a.half, z = j * a.cell - a.half;
        const v = fbm2(s + 31, x * 0.05, z * 0.05, 2);
        relief[j * a.n + i] = v;
        if (x * x + z * z <= R * R) {
          lo = Math.min(lo, v);
          hi = Math.max(hi, v);
        }
      }
    }
    const span = Math.max(1e-6, hi - lo);
    for (let k = 0; k < relief.length; k++) relief[k] = clamp(((relief[k] - lo) / span) * 2 - 1, -1, 1);
  }
  for (let j = 0; j < a.n; j++) {
    for (let i = 0; i < a.n; i++) {
      const x = i * a.cell - a.half, z = j * a.cell - a.half;
      const d = Math.hypot(x, z);
      const nse = fbm2(s, x * 0.07, z * 0.07, 4) - 0.5;
      const det = fbm2(s + 7, x * 0.25, z * 0.25, 2) - 0.5;
      const rim = smoothstep(R - 1, R + 5, d) * 3.2; // stadium bowl edge
      let h = nse * 1.6 + rim;
      let g: GroundId = "grass";
      /** 1 = full relief; liquids and their shores fade it out so basins keep their shape. */
      let dry = 1;
      switch (spec.kind) {
        case "meadow": {
          const pond = Math.exp(-((x - pondX) ** 2 + (z - pondZ) ** 2) / 22);
          h = nse * 1.4 - pond * 1.3 + rim;
          dry = clamp(1 - pond * 2.2, 0, 1);
          g = pond > 0.55 ? "water" : pond > 0.35 ? "sand" : det > 0.18 ? "soil" : nse > 0.28 ? "stone" : "grass";
          a.waterLevel = -0.55;
          break;
        }
        case "lake": {
          const bowl = Math.exp(-(d * d) / (R * R * 0.16));
          h = nse * 1.2 - bowl * 2.2 + rim;
          dry = clamp(1 - bowl * 3.5, 0, 1);
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
          dry = clamp(1 - frozen * 1.8, 0, 1);
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
          const terraceH = Math.round((nse + 0.5) * 3) * 0.45;
          const canal = Math.abs(x - pondX * 0.3) < 1.6;
          h = canal ? -0.6 : terraceH + rim * 0.6;
          g = canal ? "water" : (Math.floor(x / 4) + Math.floor(z / 4)) % 3 === 0 ? "stone" : "metal";
          a.waterLevel = -0.3;
          break;
        }
        case "beach": {
          // A symmetric beach faces its sea along +z, so both sides share the same shore.
          const sea = smoothstep(-R * 0.1, R * 0.7, sym === "none" ? x : z);
          h = (1 - sea) * (nse * 1.6 + 0.4) - sea * 1.6 + rim * (1 - sea);
          dry = clamp(1 - sea * 3, 0, 1);
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
      if (shape.relief > 0 && dry > 0) h += shape.relief * dry * (1 - smoothstep(R - 3, R, d)) * relief[j * a.n + i];
      // Height levels: dry ground is terraced into clear bands (liquids keep their basin; the city
      // already builds 0.45 m terraces = its step).
      if (!GROUNDS[g].liquid && spec.kind !== "city") h = terrace(h, shape.step, shape.ramp);
      set(i, j, h, g);
    }
  }
  const legacyRng = rng; // rim props keep drawing from the legacy stream (same look for symmetry "none")

  // Clear corridors: every spawn slot of both sides (and the stretch the formation scale moves it
  // along) plus the centre stay free of plateaus and interior props.
  const spawnUs = SPAWN_SLOTS.flatMap((sl) => [{ x: sl.ux * R, z: sl.uz * R }, { ...symmetricImage(sl.ux * R, sl.uz * R, sym) }]);
  const corridor = (x: number, z: number): number => {
    let m = Math.hypot(x, z) - 2.5;
    for (const p of spawnUs) m = Math.min(m, segDist(x, z, p.x * 0.4, p.z * 0.4, p.x, p.z) - 2.6);
    return m; // > 0 = outside every corridor, by that margin
  };
  const gIdx = (x: number, z: number) => {
    const [gx, gz] = a.toGrid(x, z);
    return a.grounds[a.idx(Math.round(gx), Math.round(gz))];
  };
  const liquidAt = (x: number, z: number) => GROUNDS[GROUND_IDS[gIdx(x, z)]].liquid;

  // Plateaus: raised discs (one level step) with a gentle ramp facing the centre.
  const lr = new Rng(hashSeed(spec.seed, spec.kind, "levels"));
  for (let tries = 0; tries < shape.plateaus * 30 && a.plateaus.length < shape.plateaus; tries++) {
    const ang = lr.range(0, Math.PI * 2), rad = lr.range(R * 0.3, R * 0.75), r = lr.range(2.4, 4.2);
    let x = Math.cos(ang) * rad;
    const z = Math.sin(ang) * rad;
    if (sym !== "none") x = Math.abs(x) + r * 0.6; // canonical half: the image is added by the copy
    if (Math.hypot(x, z) + r > R * 0.92) continue;
    if (corridor(x, z) < r - 1.2) continue;
    if (a.plateaus.some((p) => Math.hypot(p.x - x, p.z - z) < p.r + r + 1.5)) continue;
    let wet = false;
    for (let k = 0; k < 9 && !wet; k++) {
      const t = (k / 8) * Math.PI * 2, rr = k === 8 ? 0 : r + 1;
      wet = liquidAt(x + Math.cos(t) * rr, z + Math.sin(t) * rr);
    }
    if (wet) continue;
    a.plateaus.push({ x, z, r, rampAngle: Math.atan2(-z, -x) });
  }
  if (a.plateaus.length) {
    for (let j = 0; j < a.n; j++) {
      for (let i = 0; i < a.n; i++) {
        const x = i * a.cell - a.half, z = j * a.cell - a.half;
        const k = j * a.n + i;
        if (GROUNDS[GROUND_IDS[a.grounds[k]]].liquid) continue;
        let lift = 0;
        for (const p of a.plateaus) {
          const d = Math.hypot(x - p.x, z - p.z);
          if (d > p.r + 4) continue;
          const face = Math.max(0, Math.cos(Math.atan2(z - p.z, x - p.x) - p.rampAngle));
          const edge = 0.9 + 3.2 * face ** 3; // the ramp side slopes gently, the rest is a low cliff
          lift = Math.max(lift, 1 - smoothstep(p.r - 0.2, p.r + edge, d));
        }
        if (lift > 0) a.heights[k] += lift * shape.step * shape.lift;
      }
    }
  }

  // Props: the stands' landmarks (legacy rim ring) + interior obstacles / cover at the kind's density.
  const propKinds: Record<ArenaKind, PropKind[]> = {
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
  let props: Prop[] = [];
  for (let k = 0; k < count; k++) {
    const ang = legacyRng.range(0, Math.PI * 2);
    const rad = legacyRng.range(R * 0.78, R + 3);
    const x = Math.cos(ang) * rad, z = Math.sin(ang) * rad;
    const kind = legacyRng.pick(kinds);
    if (kind === "reed" && !a.groundAt(x, z).liquid && legacyRng.chance(0.5)) continue;
    const scale = legacyRng.range(0.7, 1.6), rot = legacyRng.range(0, Math.PI * 2);
    // Rim props that would stand inside a spawn corridor move out to the stands.
    const p = makeProp(kind, x, z, scale, rot, R);
    if (p.inner && corridor(x, z) < p.radius) {
      const out = (R + 1.5) / Math.max(1e-6, Math.hypot(x, z));
      props.push(makeProp(kind, x * out, z * out, scale, rot, R));
    } else props.push(p);
  }
  const pr = new Rng(hashSeed(spec.seed, spec.kind, "props"));
  const want = Math.round(shape.props * a.spec.density * (sym === "none" ? 1 : 0.5));
  const inner: Prop[] = [];
  for (let tries = 0; tries < want * 10 && inner.length < want; tries++) {
    const ang = pr.range(0, Math.PI * 2), rad = Math.sqrt(pr.range(0.04, 1)) * R * 0.9;
    let x = Math.cos(ang) * rad;
    const z = Math.sin(ang) * rad;
    if (sym !== "none") x = Math.abs(x);
    const kind = pr.pick(shape.interior);
    const scale = pr.range(0.75, 1.35), rot = pr.range(0, Math.PI * 2);
    const p = makeProp(kind, x, z, scale, rot, R);
    if (sym !== "none" && x <= Math.max(0.6, p.radius)) continue;
    if (Math.hypot(x, z) + p.radius > R * 0.95) continue;
    if (corridor(x, z) < p.radius) continue;
    const gnd = GROUND_IDS[gIdx(x, z)];
    if (gnd === "lava") continue;
    if (kind === "reed" ? !GROUNDS[gnd].liquid && gnd !== "mud" : GROUNDS[gnd].liquid) continue;
    if ([...inner, ...props].some((q) => Math.hypot(q.x - x, q.z - z) < q.radius + p.radius + 0.7)) continue;
    inner.push(p);
  }
  props = symmetrizeProps([...props, ...inner], sym, R);
  a.props = props;

  // Mounds: solid props (and dunes) stand on a small rise the physics feels through heightAt.
  for (const p of a.props) {
    const m = PROP_DEFS[p.kind].mound * p.scale;
    if (m <= 0) continue;
    const rr = p.radius * 1.35;
    const [cx, cz] = a.toGrid(p.x, p.z), rc = rr / a.cell;
    for (let j = Math.floor(cz - rc); j <= Math.ceil(cz + rc); j++) {
      for (let i = Math.floor(cx - rc); i <= Math.ceil(cx + rc); i++) {
        if (i < 0 || j < 0 || i >= a.n || j >= a.n) continue;
        const k = j * a.n + i;
        if (GROUNDS[GROUND_IDS[a.grounds[k]]].liquid) continue;
        const d = Math.hypot(i * a.cell - a.half - p.x, j * a.cell - a.half - p.z);
        if (d < rr) a.heights[k] += m * (1 - smoothstep(rr * 0.35, rr, d));
      }
    }
  }
  // Exact symmetry last: every float above is copied, not recomputed, onto the other half.
  symmetrizeGrid(a, sym);
  if (sym !== "none") {
    for (const p of [...a.plateaus]) {
      const im = symmetricImage(p.x, p.z, sym);
      if (Math.hypot(im.x - p.x, im.z - p.z) < 0.5) continue;
      a.plateaus.push({ x: im.x, z: im.z, r: p.r, rampAngle: sym === "mirror" ? Math.PI - p.rampAngle : p.rampAngle + Math.PI });
    }
  }

  // Spawn candidates (side 1 = the image of side 0 under the symmetry).
  for (const sl of SPAWN_SLOTS) {
    const x = sl.ux * R, z = sl.uz * R;
    const im = symmetricImage(x, z, sym);
    a.spawns.side0.push(v3(x, a.surfaceAt(x, z), z));
    a.spawns.side1.push(v3(im.x, a.surfaceAt(im.x, im.z), im.z));
  }
  return a;
}
