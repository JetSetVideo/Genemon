/**
 * Skeleton: the base of every Genemon model. A body plan (quadruped, biped, hexapod, serpent,
 * avian, blob) is generated from the phenotype as a joint tree. Each joint has angle LIMITS that
 * are not fixed: they are re-computed every frame from the CURRENT angles of the connected joints
 * (couplings: a flexed hip narrows the knee, a twisted neck narrows the head's yaw...) and every
 * chain (spine, neck, tail) has a total bend BUDGET. constrainPose() is the single gate every
 * animation passes through. FK + mass give the centre of mass; contact points give the support
 * polygon; their relation is the balance margin used by animation and physics.
 *
 * Frame convention: creature space, +Z forward, +Y up, side +1 = +X. Positive X rotation pitches a
 * forward-pointing bone DOWN (jaw opens, head nods); for a downward bone it swings the end BACK.
 */
import { Euler, Quaternion, Vector3 } from "../lib/three.ts";
import type { Phenotype } from "../genome/phenotype.ts";
import { type BodyP5, type GenePair, type GrowthGenes, type MorphP5, P5_DEFAULTS } from "../genome/morphTypes.ts";
import type { BodyCounts, ComplexityTier, EvoState, MorphP6, MorphUnlock, PhaseForm } from "../genome/p6Types.ts";

export type JointRole =
  | "root"
  | "spine"
  | "chest"
  | "neck"
  | "head"
  | "jaw"
  | "tail"
  | "hip"
  | "knee"
  | "ankle"
  | "shoulder"
  | "elbow"
  | "wrist"
  | "wingRoot"
  | "wingMid"
  | "wingTip"
  | "pod"
  | "horn"
  | "ear"
  | "segment";

type Range = [number, number];
export type Vec3 = [number, number, number];
export type Axis3 = 0 | 1 | 2;

export interface Coupling {
  src: string;
  srcAxis: Axis3;
  axis: Axis3;
  loLin: number;
  loAbs: number;
  hiLin: number;
  hiAbs: number;
}

export interface JointDef {
  id: string;
  role: JointRole;
  parent: number;
  side: -1 | 0 | 1;
  offset: Vec3;
  dir: Vec3;
  length: number;
  r0: number;
  r1: number;
  limits: [Range, Range, Range];
  couplings: Coupling[];
  chain: string;
  contact: boolean;
  mass: number;
  /** Pass-5 growth expression of this node (only when built with growth genes): every value lies in its GrowthGenes band. */
  grow?: NodeGrowth;
  /** Pass 6: index of the repeated part this joint belongs to (wing / arm pair, tail, head), 0 = the first. */
  pair?: number;
  /** Pass 6, head joints only: what the face builder puts on THIS head (face.ts reads it). */
  face?: FaceSpec;
}

/** Pass-6 face of one head: its eye count (undefined = the helix genes), bonus eyes (eyes+), the globe's cute face, complex eyes, a secondary head. */
export interface FaceSpec {
  eyes?: number;
  eyeBonus: number;
  globe: boolean;
  /** 6-8 eyes from the complexity counts: eye rings / compound clusters and ringed irises. */
  complex: boolean;
  /** A second head (its face is built with the head mesh). */
  second: boolean;
}

/** The expressed growth of one skeleton node [P5-V2]: length / strength (radius) multipliers and the bend angle (rad). */
export interface NodeGrowth {
  length: number;
  strength: number;
  /** Rest bend (rad) applied to neck / tail nodes; + curls ventrally (toward the fetal curl). */
  bend: number;
}

/** Development state of a skeleton built with pass-5 genes (absent on legacy skeletons). */
export interface Development {
  /** ph.growth 0..1. */
  growth: number;
  /** smoothstep(growth): the drive of the growth bands. */
  drive: number;
  /** Baby proportions 1 (newborn) .. 0 (adult), faded by growth and held longer by neoteny. */
  baby: number;
  /** Fetal spiral turns (GrowthGenes.spiral). */
  spiral: number;
  neoteny: number;
}

export interface Skeleton {
  kind: Phenotype["kind"];
  joints: JointDef[];
  index: Map<string, number>;
  chains: Record<string, { joints: number[]; budget: Vec3 }>;
  height: number;
  rootHeight: number;
  totalMass: number;
  mobility: number;
  /** Pass-5 development (growth bands + neoteny) when built with genes; undefined = legacy skeleton. */
  dev?: Development;
  /** Pass 6: the resolved body plan (complexity counts + evolution unlocks); undefined = pass-5 build. */
  plan6?: BodyPlan6;
}

export type Pose = Record<string, Vec3>;

// Base limits per role (radians) before mobility scaling: [x, y, z].
const ROLE_LIMITS: Record<JointRole, [Range, Range, Range]> = {
  root: [[-0.35, 0.35], [0, 0], [-0.3, 0.3]],
  spine: [[-0.3, 0.3], [-0.35, 0.35], [-0.15, 0.15]],
  chest: [[-0.3, 0.3], [-0.35, 0.35], [-0.15, 0.15]],
  segment: [[-0.25, 0.25], [-0.55, 0.55], [-0.1, 0.1]],
  neck: [[-0.7, 0.6], [-0.8, 0.8], [-0.25, 0.25]],
  head: [[-0.5, 0.5], [-0.6, 0.6], [-0.3, 0.3]],
  jaw: [[0, 0.65], [0, 0], [0, 0]],
  tail: [[-0.6, 0.6], [-0.7, 0.7], [0, 0]],
  hip: [[-0.9, 0.9], [-0.2, 0.2], [-0.3, 0.3]],
  shoulder: [[-0.9, 0.9], [-0.25, 0.25], [-0.35, 0.35]],
  knee: [[-0.05, 1.5], [0, 0], [0, 0]],
  elbow: [[-2.0, 0.05], [0, 0], [0, 0]],
  ankle: [[-0.7, 0.7], [0, 0], [-0.15, 0.15]],
  wrist: [[-0.6, 0.6], [-0.2, 0.2], [-0.3, 0.3]],
  wingRoot: [[-0.4, 0.4], [-0.5, 0.75], [-1.1, 1.1]],
  wingMid: [[-0.2, 0.2], [-0.2, 1.3], [-0.9, 0.9]],
  wingTip: [[-0.1, 0.1], [-0.3, 0.7], [-0.6, 0.6]],
  pod: [[-0.6, 0.6], [-0.3, 0.3], [-0.6, 0.6]],
  horn: [[0, 0], [0, 0], [0, 0]],
  ear: [[0, 0], [0, 0], [-0.3, 0.3]],
};
const FIXED_ROLES: JointRole[] = ["jaw", "horn"];

function norm3(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

// ------------------------------------------------------------------ pass-5 development [P5-V2, P5-V5, P5-V6]
/** The genes a skeleton reads: the growth envelope and the body plan extras (+ the pass-6 complexity counts). */
export type DevGenes = Pick<MorphP5, "growth" | "body"> & { p6?: MorphP6 | null };

/** The skeleton genes of a helix: pass-5 genes (or the defaults) plus the pass-6 complexity when present. */
export function skeletonGenes(helix: { p5?: MorphP5; p6?: MorphP6 }): DevGenes {
  const p5 = helix.p5 ?? P5_DEFAULTS;
  return helix.p6 ? { growth: p5.growth, body: p5.body, p6: helix.p6 } : p5;
}

// ------------------------------------------------------------------ pass-6 body plan [P6-C1, P6-E3, P6-E4]
/**
 * The resolved pass-6 body plan: the complexity counts (helix.p6.complexity.counts; without them the pass-5
 * plan expressed as counts) plus the evolution unlocks of `ph.evo` (cumulative: wingPair+ adds a pair,
 * wings+ grows the span or grants a first pair, neck+ lengthens the neck...), and the phase FORM (larva,
 * cocoon, imago, molting). Every renderer reads this one object from `sk.plan6`.
 */
export interface BodyPlan6 {
  /** Effective counts (clamped to the BodyCounts ranges). */
  counts: BodyCounts;
  /** "p6": the complexity counts drive the build; "evo": the pass-5 build plus the evolution unlocks only. */
  source: "p6" | "evo";
  tier: ComplexityTier | null;
  /** The minimal GLOBE: one round body, one eye, a small mouth, nothing else. */
  globe: boolean;
  form: PhaseForm | null;
  /** Neck length multiplier (neck+), extra neck segments. */
  neck: number;
  neckSegs: number;
  /** Wing span multiplier (wings+). */
  wingSpan: number;
  /** Arm size multiplier (arms+ on a creature that already has arms). */
  arm: number;
  /** Horn length multiplier and extra horn pairs (horns+). */
  horn: number;
  hornPairs: number;
  /** Armour plates (armor+ count; 0 after armorShed) and the molting crack. */
  armor: number;
  shed: boolean;
  molting: boolean;
  /** Trunk girth multiplier (size+). */
  bulk: number;
  /** Extra fingers per hand (fingers+), for pass-5 hands (source "evo"). */
  fingerBonus: number;
  /** Cumulative unlock tally. */
  unlocks: Partial<Record<MorphUnlock, number>>;
}

/** How many times each unlock was granted up to the current phase. */
export function unlockTally(evo: EvoState | null | undefined): Partial<Record<MorphUnlock, number>> {
  const t: Partial<Record<MorphUnlock, number>> = {};
  for (const u of evo?.unlocks ?? []) t[u] = (t[u] ?? 0) + 1;
  return t;
}

const COUNT_RANGE: Record<keyof BodyCounts, [number, number, number]> = {
  eyes: [1, 8, 2],
  mouths: [1, 2, 1],
  heads: [1, 2, 1],
  wingPairs: [0, 3, 0],
  armPairs: [0, 3, 0],
  legPairs: [0, 4, 2],
  tentacles: [0, 12, 0],
  fingers: [0, 7, 4],
  tails: [0, 3, 1],
};

/** Counts inside the contract ranges (integers; a missing or non-finite value takes its default). */
export function clampCounts(c: Partial<BodyCounts>): BodyCounts {
  const out = {} as BodyCounts;
  for (const k of Object.keys(COUNT_RANGE) as (keyof BodyCounts)[]) {
    const [lo, hi, d] = COUNT_RANGE[k];
    const v = c[k];
    out[k] = Math.round(Number.isFinite(v) ? Math.min(hi, Math.max(lo, v as number)) : d);
  }
  return out;
}

/** The pass-5 build of a phenotype expressed as counts (what buildSkeleton makes without pass-6 data). */
export function legacyCounts(ph: Phenotype, body?: BodyP5): BodyCounts {
  const p = ph.plan, fly = ph.abilities.fly;
  const tent = (body?.limbStyle ?? "legs") === "tentacles";
  const nT = Math.max(4, Math.min(8, 4 + Math.round(4 * p.legLen)));
  const c: Partial<BodyCounts> = { eyes: 2, mouths: 1, heads: 1, fingers: 4, armPairs: 0, tentacles: 0 };
  switch (ph.kind) {
    case "quadruped":
      Object.assign(c, { wingPairs: p.wings > 0.62 || fly ? 1 : 0, legPairs: 2, tails: Math.round(5 * p.tail) > 0 ? 1 : 0 });
      break;
    case "biped":
      Object.assign(c, { wingPairs: p.wings > 0.62 || fly ? 1 : 0, legPairs: 1, armPairs: 1, tails: p.tail > 0.35 && Math.round(4 * p.tail) > 0 ? 1 : 0 });
      break;
    case "hexapod":
      Object.assign(c, { wingPairs: 0, legPairs: 3, tails: 0 });
      break;
    case "serpent":
      Object.assign(c, { wingPairs: p.wings > 0.7 || fly ? 1 : 0, legPairs: body ? Math.max(0, Math.min(2, Math.round(body.serpentLegs))) : 0, tails: 0, tentacles: tent ? nT : 0 });
      break;
    case "avian":
      Object.assign(c, { wingPairs: 1, legPairs: 1, tails: 1 });
      break;
    case "blob":
      Object.assign(c, { wingPairs: 0, legPairs: tent ? 0 : Math.ceil((3 + Math.round(3 * p.legLen)) / 2), tails: 0, tentacles: tent ? nT : 0 });
      break;
  }
  return clampCounts(c);
}

/** The pass-6 plan of a phenotype + skeleton genes; null = no pass-6 data (pass-5 build, unchanged). */
export function bodyPlan6(ph: Phenotype, genes?: DevGenes | null): BodyPlan6 | null {
  const p6 = genes?.p6 ?? null;
  const evo = ph.evo ?? null;
  if (!p6 && !evo) return null;
  const t = unlockTally(evo);
  const n = (u: MorphUnlock) => t[u] ?? 0;
  const c: BodyCounts = { ...(p6 ? clampCounts(p6.complexity.counts) : legacyCounts(ph, genes?.body)) };
  const hadWings = c.wingPairs > 0, hadArms = c.armPairs > 0;
  c.wingPairs += n("wingPair+");
  if (n("wings+") > 0 && c.wingPairs === 0) c.wingPairs = 1;
  c.armPairs += n("armPair+");
  if (n("arms+") > 0 && c.armPairs === 0) c.armPairs = 1;
  c.fingers += n("fingers+");
  c.tails += n("tail+");
  c.tentacles += 2 * n("tentacles+");
  c.eyes += 2 * n("eyes+");
  if (n("mouth+") > 0) c.mouths = 2;
  const form = evo?.form ?? null;
  if (form === "larva") Object.assign(c, { wingPairs: 0, armPairs: 0, legPairs: 3, tentacles: 0, tails: 0, heads: 1, mouths: 1 });
  if (form === "cocoon") Object.assign(c, { wingPairs: 0, armPairs: 0, legPairs: 0, tentacles: 0, tails: 0, heads: 1, mouths: 1 });
  if (form === "imago") c.wingPairs = Math.max(1, c.wingPairs);
  let counts = clampCounts(c);
  const tier = p6?.complexity.tier ?? null;
  const zeros = counts.legPairs === 0 && counts.armPairs === 0 && counts.wingPairs === 0 && counts.tentacles === 0 && counts.tails === 0;
  const globe = !!p6 && form !== "larva" && form !== "cocoon" && (tier === "minimal" || (zeros && ph.kind !== "serpent"));
  if (globe) counts = { ...counts, eyes: 1, mouths: 1, heads: 1, wingPairs: 0, armPairs: 0, legPairs: 0, tentacles: 0, tails: 0, fingers: 0 };
  let armor = 0, shed = false;
  for (const u of evo?.unlocks ?? []) {
    if (u === "armor+") armor++, shed = false;
    else if (u === "armorShed") armor = 0, shed = true;
  }
  const molting = form === "molting";
  if (molting) armor = Math.max(1, armor);
  const wn = n("wings+");
  return {
    counts,
    source: p6 ? "p6" : "evo",
    tier,
    globe,
    form,
    // neck+ adds an absolute length (0.13 H each) so even a short-necked lineage visibly grows a neck.
    neck: 1 + (0.13 * n("neck+")) / (0.1 + 0.16 * Math.max(0, ph.plan.neck)),
    neckSegs: n("neck+") >= 2 ? 2 : n("neck+") >= 1 ? 1 : 0,
    wingSpan: wn === 0 ? 1 : hadWings ? 1 + 0.3 * wn : 0.8 + 0.45 * (wn - 1),
    arm: hadArms ? 1 + 0.2 * n("arms+") : 1,
    horn: 1 + 0.3 * n("horns+"),
    hornPairs: n("horns+") > 0 ? 1 : 0,
    armor: globe ? 0 : armor,
    shed,
    molting: molting && !globe,
    bulk: 1 + 0.07 * n("size+"),
    fingerBonus: n("fingers+"),
    unlocks: t,
  };
}

/** Absolute safety bounds of the growth bands (a malformed gene can never collapse or explode a node). */
export const GROWTH_LIMITS = { length: [0.5, 1.6], strength: [0.5, 1.8], angle: [-0.6, 0.6] } as const;

const clampN = (x: number, lo: number, hi: number) => (Number.isFinite(x) ? (x < lo ? lo : x > hi ? hi : x) : (lo + hi) / 2);
const clamp01n = (x: number) => clampN(x, 0, 1);
function smooth(a: number, b: number, x: number): number {
  const t = clamp01n((x - a) / (b - a || 1e-9));
  return t * t * (3 - 2 * t);
}

/** A gene pair as an ordered band inside the safety limits. */
export function geneBand(g: GenePair, lim: readonly [number, number]): [number, number] {
  const a = clampN(Math.min(g.lo, g.hi), lim[0], lim[1]), b = clampN(Math.max(g.lo, g.hi), lim[0], lim[1]);
  return [a, b];
}

/** boundTrait-like expression: lo + (hi - lo) * smoothstep(drive), always inside [lo, hi]. */
export function bandValue(g: GenePair, lim: readonly [number, number], drive: number): number {
  const [lo, hi] = geneBand(g, lim);
  return lo + (hi - lo) * smooth(0, 1, drive);
}

/** Baby proportions 1 .. 0: fade with growth; neoteny (0..1) keeps them until later (0.45 .. 1 of growth). */
export function babyFactor(growth: number, neoteny: number): number {
  return 1 - smooth(0, 0.45 + 0.55 * clamp01n(neoteny), clamp01n(growth));
}

/** Neoteny multipliers per role at baby factor b: big head, short thick limbs, round torso, horn nubs. */
export function neotenyScale(role: JointRole, b: number): { length: number; radius: number } {
  switch (role) {
    case "head":
      return { length: 1 + 0.35 * b, radius: 1 + 0.45 * b };
    case "jaw":
      return { length: 1 - 0.15 * b, radius: 1 };
    case "hip":
    case "knee":
    case "ankle":
    case "shoulder":
    case "elbow":
    case "wrist":
    case "pod":
      return { length: 1 - 0.22 * b, radius: 1 + 0.22 * b };
    case "root":
    case "spine":
    case "chest":
    case "segment":
      return { length: 1 - 0.06 * b, radius: 1 + 0.1 * b };
    case "neck":
      return { length: 1 - 0.12 * b, radius: 1 + 0.1 * b };
    case "tail":
      return { length: 1 - 0.18 * b, radius: 1 + 0.05 * b };
    case "horn":
      return { length: 1 - 0.55 * b, radius: 1 - 0.2 * b };
    case "ear":
      return { length: 1 + 0.15 * b, radius: 1 + 0.1 * b };
    case "wingRoot":
    case "wingMid":
    case "wingTip":
      return { length: 1 - 0.25 * b, radius: 1 + 0.1 * b };
  }
}

/** Deterministic 0..1 hash of a string (FNV-1a + avalanche). */
export function hash01(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return (h >>> 0) / 4294967296;
}

const LIMB_CLASS: Partial<Record<JointRole, string>> = { hip: "upper", shoulder: "upper", knee: "lower", elbow: "lower", ankle: "foot", wrist: "foot", pod: "upper" };
/** Rotate v about +X (sagittal plane): + pitches a forward bone down. */
function rotX(v: Vec3, a: number): Vec3 {
  if (a === 0) return v;
  const c = Math.cos(a), s = Math.sin(a);
  return [v[0], v[1] * c - v[2] * s, v[1] * s + v[2] * c];
}
/** Rotate v about +Y (yaw). */
function rotY(v: Vec3, a: number): Vec3 {
  if (a === 0) return v;
  const c = Math.cos(a), s = Math.sin(a);
  return [v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c];
}

class Dev {
  readonly drive: number;
  readonly baby: number;
  readonly seed: string;
  constructor(readonly ph: Phenotype, readonly g: GrowthGenes, readonly body: BodyP5) {
    this.drive = smooth(0, 1, ph.growth);
    this.baby = babyFactor(ph.growth, g.neoteny);
    this.seed = `${ph.kind}:${Object.values(ph.plan).map((v) => v.toFixed(4)).join(",")}`;
  }
  /** Node growth: a per-node drive jitter (side-neutral key, shared by every leg segment of a class) inside the bands. */
  node(id: string, role: JointRole, side: number): NodeGrowth {
    const cls = LIMB_CLASS[role];
    const key = cls ?? (side !== 0 ? id.replace(/[LR]/g, "S") : id);
    const d = clamp01n(this.drive + (hash01(`${this.seed}|${key}`) - 0.5) * 0.24);
    return {
      length: bandValue(this.g.length, GROWTH_LIMITS.length, d),
      strength: bandValue(this.g.strength, GROWTH_LIMITS.strength, d),
      bend: bandValue(this.g.angle, GROWTH_LIMITS.angle, d),
    };
  }
  /** Per limb-PAIR drift (same for both sides: mirror symmetry kept): length factor and fore/aft angle. */
  drift(pair: string): { len: number; ang: number } {
    const v = clampN(this.body.limbVariation, 0, 0.25);
    if (v <= 0) return { len: 1, ang: 0 };
    return { len: 1 + v * 0.6 * (2 * hash01(`${this.seed}|pair|${pair}`) - 1), ang: v * 0.8 * (2 * hash01(`${this.seed}|ang|${pair}`) - 1) };
  }
}

class Builder {
  joints: JointDef[] = [];
  index = new Map<string, number>();
  /** Pass 6: the repeated-part index stamped on every joint added while set (wing / arm pair, tail, head). */
  curPair: number | undefined = undefined;
  constructor(private mobility: number, readonly dev: Dev | null = null) {}

  add(
    id: string,
    role: JointRole,
    parent: string | null,
    side: -1 | 0 | 1,
    offset: Vec3,
    dir: Vec3,
    length: number,
    r0: number,
    r1: number,
    chain: string,
    contact = false,
    prescaled = false,
  ): string {
    let grow: NodeGrowth | undefined;
    if (this.dev) {
      grow = this.dev.node(id, role, side);
      if (!prescaled) {
        const neo = neotenyScale(role, this.dev.baby);
        length *= grow.length * neo.length;
        r0 *= grow.strength * neo.radius;
        r1 *= grow.strength * neo.radius;
      }
      // Rest bend of neck / tail nodes, ventral for both (a backward-pointing tail bone curls down with -X).
      if (role === "neck") dir = rotX(dir, grow.bend);
      else if (role === "tail") dir = rotX(dir, -grow.bend);
    }
    const base = ROLE_LIMITS[role];
    const m = FIXED_ROLES.includes(role) ? 1 : this.mobility;
    const limits = base.map(([lo, hi]) => [lo * m, hi * m] as Range) as [Range, Range, Range];
    // Ranges are authored for the LEFT side (+X). Mirroring across the median plane keeps rotations
    // about X and negates rotations about Y and Z, so a right-side joint gets [-hi, -lo] on y and z.
    if (side < 0) {
      limits[1] = [-limits[1][1], -limits[1][0]];
      limits[2] = [-limits[2][1], -limits[2][0]];
    }
    this.index.set(id, this.joints.length);
    this.joints.push({
      id,
      role,
      parent: parent === null ? -1 : this.index.get(parent)!,
      side,
      offset,
      dir: norm3(dir),
      length,
      r0,
      r1,
      limits,
      couplings: [],
      chain,
      contact,
      mass: 0,
      ...(grow ? { grow } : {}),
      ...(this.curPair !== undefined ? { pair: this.curPair } : {}),
    });
    return id;
  }

  has(id: string): boolean {
    return this.index.has(id);
  }

  j(id: string): JointDef {
    return this.joints[this.index.get(id)!];
  }

  couple(target: string, c: Omit<Coupling, "loLin" | "loAbs" | "hiLin" | "hiAbs"> & Partial<Coupling>): void {
    const j = this.joints[this.index.get(target)!];
    j.couplings.push({ loLin: 0, loAbs: 0, hiLin: 0, hiAbs: 0, ...c });
  }

  /** Bone end of a joint, in its own frame = dir * length (used as child offset). */
  tip(id: string, along = 1): Vec3 {
    const j = this.joints[this.index.get(id)!];
    return [j.dir[0] * j.length * along, j.dir[1] * j.length * along, j.dir[2] * j.length * along];
  }

  /**
   * Raw length to request so the node's FINAL length (after growth x neoteny) is at least `min` (a final
   * size, e.g. a parent radius): keeps a short baby bone from being swallowed by its parent's volume.
   * Identity on a legacy skeleton.
   */
  atLeast(id: string, role: JointRole, side: number, want: number, min: number): number {
    if (!this.dev) return want;
    return Math.max(want, min / Math.max(1e-6, this.scaleOf(id, role, side).length));
  }

  /** Final radius multiplier of a node (growth x neoteny), 1 on a legacy skeleton. */
  radiusK(id: string, role: JointRole, side: number): number {
    return this.scaleOf(id, role, side).radius;
  }

  /** Growth x neoteny multipliers a node would get (for callers that place children from its size). */
  scaleOf(id: string, role: JointRole, side: number): { length: number; radius: number } {
    if (!this.dev) return { length: 1, radius: 1 };
    const g = this.dev.node(id, role, side), n = neotenyScale(role, this.dev.baby);
    return { length: g.length * n.length, radius: g.strength * n.radius };
  }
}

interface LegDirs {
  upper?: Vec3;
  lower?: Vec3;
  foot?: Vec3;
}

function legChain(
  b: Builder,
  prefix: string,
  parent: string,
  side: -1 | 1,
  at: Vec3,
  upper: number,
  lower: number,
  foot: number,
  r: number,
  front: boolean,
  dirs: LegDirs = {},
  drift: { len: number; ang: number; maxShift: number } | null = null,
): string {
  const hipRole: JointRole = front ? "shoulder" : "hip";
  let du = dirs.upper ?? [0, -1, 0];
  if (drift && (drift.len !== 1 || drift.ang !== 0)) {
    // limbVariation: the pair drifts from its goal; the pivot moves by the change of vertical drop so the
    // sole stays on the ground (clamped to maxShift, the length drift is clamped to match).
    const dl = norm3(dirs.lower ?? [0, -1, 0]);
    const drop = -(norm3(du)[1] * upper + dl[1] * lower);
    let f = drift.len;
    if (drop > 1e-6) f = clampN(f, 1 - drift.maxShift / drop, 1 + drift.maxShift / drop);
    upper *= f;
    lower *= f;
    du = rotX(norm3(du), drift.ang);
    at = [at[0], at[1] + (f - 1) * Math.max(0, drop), at[2]];
  }
  const hip = b.add(`${prefix}${hipRole}`, hipRole, parent, side, at, du, upper, r * 0.42, r * 0.3, `leg-${prefix}`);
  const knee = b.add(`${prefix}knee`, "knee", hip, side, b.tip(hip), dirs.lower ?? [0, -1, 0], lower, r * 0.3, r * 0.22, `leg-${prefix}`);
  const ankle = b.add(`${prefix}ankle`, "ankle", knee, side, b.tip(knee), dirs.foot ?? [0, 0, 1], foot, r * 0.22, r * 0.2, `leg-${prefix}`, true);
  // Dynamic couplings: a forward-swung hip forbids a fully straight knee; a flexed knee narrows the ankle.
  b.couple(knee, { src: hip, srcAxis: 0, axis: 0, loLin: -0.175, loAbs: 0.175 });
  b.couple(ankle, { src: knee, srcAxis: 0, axis: 0, loAbs: 0.2, hiAbs: -0.2 });
  return hip;
}

/** Pass-6 head options: id tag (second head "_2"), neck / horn growth (neck+, horns+), a bare head (larva), lateral splay (two heads). */
interface HeadOpts {
  tag?: string;
  neckK?: number;
  hornK?: number;
  hornBonus?: number;
  bare?: boolean;
  splay?: -1 | 0 | 1;
}

function headChain(b: Builder, parent: string, at: Vec3, neckDir: Vec3, ph: Phenotype, H: number, neckSegs: number, bodyR: number, minNeck0 = 0, o: HeadOpts = {}): void {
  const p = ph.plan;
  const tag = o.tag ?? "";
  const id = (x: string) => `${x}${tag}`;
  const neckChain = tag ? `neck${tag}` : "neck";
  const neckLen = H * (0.1 + 0.16 * p.neck) * (o.neckK ?? 1);
  // A grown neck (neck+) rises as it lengthens (a giraffe line, not a snout extension).
  const lift = Math.min(0.7, 0.35 * Math.max(0, (o.neckK ?? 1) - 1));
  if (lift > 0) neckDir = norm3([neckDir[0], neckDir[1] + lift, neckDir[2]]);
  // The head is pre-scaled (growth band x neoteny: a baby's big head) so the jaw, horns and ears sit on it.
  const hk = b.scaleOf(id("head"), "head", 0);
  const headR = H * (0.1 + 0.07 * p.head) * hk.radius;
  const headLen = H * (0.18 + 0.12 * p.head) * hk.length;
  // Two heads [P6-C1]: both necks splay sideways from the shoulders so the heads clear each other.
  const sp = o.splay ?? 0;
  if (sp !== 0) {
    at = [at[0] + sp * Math.max(0.42 * bodyR, 1.05 * headR), at[1], at[2]];
    neckDir = norm3([neckDir[0] + sp * 0.5, neckDir[1], neckDir[2]]);
  }
  let prev = parent;
  let off = at;
  for (let i = 0; i < neckSegs; i++) {
    const want = neckLen / neckSegs;
    const nid = id(`neck${i}`);
    prev = b.add(nid, "neck", prev, 0, off, i === 0 ? neckDir : [sp * 0.3, 0.15 + 1.6 * lift, 1], i === 0 && minNeck0 > 0 ? b.atLeast(nid, "neck", 0, want, minNeck0) : want, bodyR * (0.55 - 0.06 * i), bodyR * (0.47 - 0.06 * i), neckChain);
    off = b.tip(prev);
  }
  const head = b.add(id("head"), "head", prev, 0, off, [sp * 0.2, -0.12, 1], headLen, headR, headR * 0.62, "head", false, true);
  b.couple(head, { src: prev, srcAxis: 1, axis: 1, loAbs: 0.3, hiAbs: -0.3 });
  if (neckSegs > 0) b.couple(id("neck0"), { src: parent, srcAxis: 0, axis: 0, loLin: -0.6, hiLin: -0.6 });
  b.add(id("jaw"), "jaw", head, 0, [0, -headR * 0.38, headLen * 0.12], [0, -0.18, 1], headLen * (0.55 + 0.3 * p.jaw), headR * 0.42, headR * 0.26, "head");
  if (o.bare) return;
  const hornPairs = Math.min(3, Math.max(0, Math.round(3 * p.horns) - 1) + (o.hornBonus ?? 0));
  const hornK = o.hornK ?? 1;
  for (let i = 0; i < hornPairs; i++) {
    for (const s of [-1, 1] as const) {
      const hx = s * headR * (0.45 + 0.15 * i), hz = headLen * (0.15 - 0.2 * i);
      // Pass 5: seat the horn root ON the head volume (the face ellipsoid: centre 0.45 L, radii r, 0.95 r, 0.62 L)
      // instead of a fixed height that leaves the rear pair hovering behind the skull of a small baby head.
      let hy = headR * 0.75;
      if (b.dev) {
        const ex = hx / headR, ez = (hz - headLen * 0.45) / (headLen * 0.62);
        hy = 0.95 * headR * Math.sqrt(Math.max(0.04, 1 - ex * ex - ez * ez)) * 0.92;
      }
      b.add(id(`horn${i}${s > 0 ? "L" : "R"}`), "horn", head, s, [hx, hy, hz], [s * 0.35, 0.9, -0.35 - 0.2 * i], H * (0.07 + 0.12 * p.horns) * (1 - 0.25 * i) * hornK, headR * 0.2 * Math.sqrt(hornK), headR * 0.02, "head");
    }
  }
  if (p.ears > 0.45) {
    for (const s of [-1, 1] as const) {
      b.add(id(`ear${s > 0 ? "L" : "R"}`), "ear", head, s, [s * headR * 0.72, headR * 0.45, -headLen * 0.05], [s * 0.65, 0.7, -0.25], H * 0.11 * p.ears, headR * 0.28, headR * 0.06, "head");
    }
  }
}

/**
 * Tail chain. `curl` (rad, total) bends it progressively dorsally (+) or ventrally (-), more toward the tip,
 * like a squirrel's or a chameleon's; 0 keeps the legacy straight tail. Pass 6: extra tails use their own
 * id suffix (`tail<i>_<k>`) and chain (`tail<k>`).
 */
function tailChain(b: Builder, parent: string, at: Vec3, dir: Vec3, n: number, segLen: number, r: number, curl = 0, minFirst = 0, k = 0, yaw = 0): void {
  let prev = parent, off = at;
  const wsum = (n * (n + 1)) / 2 || 1;
  let acc = 0;
  const tid = (i: number) => (k === 0 ? `tail${i}` : `tail${i}_${k}`);
  for (let i = 0; i < n; i++) {
    const kk = 1 - i / Math.max(1, n);
    acc += (curl * (i + 1)) / wsum;
    let d0: Vec3 = i === 0 ? dir : [0, 0.05, -1];
    if (yaw !== 0) d0 = rotY(norm3(d0), yaw * (i === 0 ? 1 : 0.6));
    const want = segLen * (1 - 0.08 * i);
    prev = b.add(tid(i), "tail", prev, 0, off, curl !== 0 && i > 0 ? rotX(norm3(d0), acc) : d0, i === 0 && minFirst > 0 ? b.atLeast(tid(0), "tail", 0, want, minFirst) : want, r * kk * 0.95 + r * 0.05, r * (kk - 1 / n) * 0.95 + r * 0.04, k === 0 ? "tail" : `tail${k}`);
    off = b.tip(prev);
  }
}

function wingChain(b: Builder, parent: string, side: -1 | 1, at: Vec3, span: number, r: number, pair = 0): void {
  const t = side > 0 ? "L" : "R";
  const id = (i: number) => (pair === 0 ? `wing${t}${i}` : `wing${t}${i}_${pair}`);
  const chain = pair === 0 ? `wing${side}` : `wing${side}_${pair}`;
  const root = b.add(id(0), "wingRoot", parent, side, at, [side, 0.12, -0.15], span * 0.42, r * 0.22, r * 0.14, chain);
  const mid = b.add(id(1), "wingMid", root, side, b.tip(root), [side, 0.02, -0.25], span * 0.36, r * 0.14, r * 0.09, chain);
  b.add(id(2), "wingTip", mid, side, b.tip(mid), [side, -0.05, -0.4], span * 0.3, r * 0.09, r * 0.02, chain);
  b.couple(mid, { src: root, srcAxis: 2, axis: 2, loAbs: 0.3, hiAbs: -0.3 });
}

/**
 * Octopus-like tentacle [P5-V6]: a pod root then `segs` tapering segments whose directions sweep from
 * down-and-out, along the ground (the contact), then up and back over themselves: a curled spiral tip.
 * `e` is the horizontal outward unit vector. Chain name `tent<i>`; roles pod + segment (the animator's
 * pod swing and segment sway move it). Median (side 0) joints: the ring of tentacles is itself mirror-symmetric.
 * Pass 6: `hang` drapes it from a raised body (no ground contact: a beard / skirt of tentacles); `id`
 * names a branch (`tent<i>b`, chain = id).
 */
function tentacle(b: Builder, i: number, parent: string, at: Vec3, e: Vec3, len: number, r: number, curl: number, segs = 4, o: { hang?: boolean; rise?: boolean; id?: string } = {}): void {
  const chain = o.id ?? `tent${i}`;
  const dirAt = (phi: number): Vec3 => [e[0] * Math.cos(phi), Math.sin(phi), e[2] * Math.cos(phi)];
  let prev = b.add(chain, "pod", parent, 0, at, dirAt(o.hang ? -1.2 : o.rise ? 0.15 : -0.95), len * 0.3, r, r * 0.8, chain);
  const phis = o.hang
    ? [-1.1, -0.8 + 0.2 * curl, -0.25 + 0.4 * curl, 0.5 + 0.8 * curl, 1.3 + curl]
    : o.rise
    ? [0.5 + 0.3 * curl, 1.1 + 0.6 * curl, 1.8 + curl, 2.5 + curl]
    : [-0.08, 0.35 + 0.3 * curl, 1.1 + 0.7 * curl, 2.0 + 1.0 * curl, 2.8 + 1.2 * curl];
  let rr = r * 0.8, L = len * 0.3;
  for (let k = 0; k < segs; k++) {
    L *= 0.82;
    const r1 = rr * 0.76;
    prev = b.add(`${chain}s${k}`, "segment", prev, 0, b.tip(prev), dirAt(phis[Math.min(phis.length - 1, k)]), L, rr, r1, chain, k === 0 && !o.hang && !o.rise);
    rr = r1;
  }
}

// ------------------------------------------------------------------ pass-6 builders [P6-C1, P6-E3, P6-E4]

const add3 = (a: Vec3, c: Vec3): Vec3 => [a[0] + c[0], a[1] + c[1], a[2] + c[2]];

/** Creature-space rest origin and bone end of every joint built so far (rest = every frame un-rotated). */
function restOf(b: Builder): { pos: Vec3[]; end: Vec3[] } {
  const pos: Vec3[] = [], end: Vec3[] = [];
  b.joints.forEach((j, i) => {
    const pp = j.parent < 0 ? [0, 0, 0] : pos[j.parent];
    pos[i] = [pp[0] + j.offset[0], pp[1] + j.offset[1], pp[2] + j.offset[2]];
    end[i] = [pos[i][0] + j.dir[0] * j.length, pos[i][1] + j.dir[1] * j.length, pos[i][2] + j.dir[2] * j.length];
  });
  return { pos, end };
}

/** Provisional ground height (creature space, before seating): the lowest contact surface so far. */
function groundOf(b: Builder): number {
  const { pos, end } = restOf(b);
  let g = Infinity;
  b.joints.forEach((j, i) => {
    if (j.contact) g = Math.min(g, end[i][1] - j.r1, pos[i][1] - j.r0);
  });
  if (!Number.isFinite(g)) b.joints.forEach((j, i) => (g = Math.min(g, pos[i][1] - j.r0)));
  return g;
}

interface TrunkPoint {
  /** Host trunk joint and the point (its frame) on its axis. */
  id: string;
  local: Vec3;
  /** Trunk radius there and the host joint's creature-space origin. */
  r: number;
  jpos: Vec3;
}

/** The trunk joints (spine / chest / abdomen / serpent body / blob stack). */
function trunkOf(b: Builder): number[] {
  return b.joints.flatMap((j, i) => (j.role === "root" || j.role === "spine" || j.role === "chest" || (j.role === "segment" && (j.chain === "abdomen" || j.chain === "body" || j.chain === "stack")) ? [i] : []));
}

/** A point at u (0 = the FRONT end: head side, or the top of an upright trunk; 1 = the rear / bottom) along the trunk. */
function trunkAt(b: Builder, u: number, upright: boolean): TrunkPoint {
  const { pos, end } = restOf(b);
  const f = upright ? 1 : 2;
  const segs = trunkOf(b).map((i) => ({ i, j: b.joints[i], frontAtStart: pos[i][f] >= end[i][f], mid: (pos[i][f] + end[i][f]) / 2 })).sort((a, c) => c.mid - a.mid);
  const total = segs.reduce((s, x) => s + x.j.length, 0) || 1;
  let x = clamp01n(u) * total;
  for (let k = 0; k < segs.length; k++) {
    const s = segs[k];
    if (x <= s.j.length || k === segs.length - 1) {
      const frac = clamp01n(x / Math.max(1e-6, s.j.length));
      const t = (s.frontAtStart ? frac : 1 - frac) * s.j.length;
      return { id: s.j.id, local: [s.j.dir[0] * t, s.j.dir[1] * t, s.j.dir[2] * t], r: s.j.r0 + (s.j.r1 - s.j.r0) * (t / Math.max(1e-6, s.j.length)), jpos: pos[s.i] };
    }
    x -= s.j.length;
  }
  const j = b.joints[0];
  return { id: j.id, local: [0, 0, 0], r: j.r0, jpos: [0, 0, 0] };
}

/** Extra leg pairs of a biped / avian (P6-C1 colossus: up to 4 pairs): sprawling spider-like legs whose soles reach the ground. */
function sprawlLegs(b: Builder, parent: string, pairs: number, r: number, y: number, legLen: number, limbR: number): void {
  if (pairs <= 0) return;
  const g = groundOf(b);
  const py = restOf(b).pos[b.index.get(parent)!][1] + y;
  for (let k = 0; k < Math.min(3, pairs); k++) {
    for (const s of [-1, 1] as const) {
      const prefix = `q${k}${s > 0 ? "L" : "R"}`;
      const u = norm3([s, 0.3, -0.25 - 0.2 * k]), l = norm3([s * 0.3, -1, -0.1]), f = norm3([s * 0.2, -0.5, 0.3]);
      const Lu = legLen * 0.4, Lf = legLen * 0.14, rad = r * 0.62 * limbR;
      const su = b.scaleOf(`${prefix}hip`, "hip", s).length, sl = b.scaleOf(`${prefix}knee`, "knee", s).length, sf = b.scaleOf(`${prefix}ankle`, "ankle", s);
      const Ll = Math.max(legLen * 0.3, (py + u[1] * Lu * su + f[1] * Lf * sf.length - rad * 0.2 * sf.radius - g) / (-l[1] * sl));
      legChain(b, prefix, parent, s, [s * r * 0.78, y, -r * (0.3 + 0.45 * k)], Lu, Ll, Lf, rad, false, { upper: u, lower: l, foot: f });
    }
  }
}

/** One arm (shoulder / elbow / wrist with a hand) of pass-6 arm pair k on a trunk point; hands never reach the ground. */
function armChain(b: Builder, k: number, t: TrunkPoint, s: -1 | 1, upright: boolean, H: number, armK: number, ground: number, round = false): void {
  const tag = s > 0 ? "L" : "R";
  const pre = `a${k}${tag}`, chain = `arm${k}-${tag}`;
  // Extra upright pairs sit a little forward of the first pair's hanging arm (so its upper arm stays free).
  const at: Vec3 = upright ? add3(t.local, [s * t.r * 1.02, 0, 0.35 * t.r]) : add3(t.local, [s * t.r * 0.88, t.r * 0.2, 0]);
  // The upper arm must still EMERGE from a fat trunk (a blob's lobed body overhangs its shoulder pivots).
  const minUpper = (upright && !round ? 0.75 : 1.1) * t.r / Math.max(1e-6, b.scaleOf(`${pre}shoulder`, "shoulder", s).length);
  // Upright bodies: each lower pair splays wider and reaches further forward (a Shiva fan, not a stack).
  // A round body (blob) reaches OUT sideways first: an arm hanging down would stay inside the ball.
  const d1 = norm3(round ? [s * 0.9, -0.25 + 0.1 * k, 0.35] : upright ? [s * (0.5 + 0.15 * k), -0.9 + 0.15 * k, 0.35 + 0.2 * k] : [s * 0.4, -0.8, 0.45]);
  const d2 = norm3(round ? [s * 0.3, -0.4, 0.85] : upright ? [s * 0.15, -0.6, 0.8] : [0, -0.15, 1]);
  const d3 = norm3(round ? [0, -0.3, 1] : upright ? [0, -0.5, 0.9] : [0, -0.2, 1]);
  const q = Math.pow(0.9, k) * armK;
  let L1 = H * 0.19 * q, L2 = H * 0.16 * q, L3 = H * 0.07 * q;
  const rr = t.r * Math.sqrt(armK) * (upright ? 0.3 : 0.26);
  // Final lengths (growth x neoteny) and the hand's own reach (fingers ~1.3 x the hand bone, curling down).
  const k1 = b.scaleOf(`${pre}shoulder`, "shoulder", s).length, k2 = b.scaleOf(`${pre}elbow`, "elbow", s).length, k3 = b.scaleOf(`${pre}wrist`, "wrist", s).length;
  const drop = -(d1[1] * L1 * k1 + d2[1] * L2 * k2 + d3[1] * L3 * k3) + 1.3 * L3 * k3 + rr;
  const avail = t.jpos[1] + at[1] - ground;
  if (drop > 0.8 * avail) {
    const f = Math.max(0.25, (0.8 * avail) / Math.max(1e-6, drop));
    L1 *= f, L2 *= f, L3 *= f;
  }
  const sh = b.add(`${pre}shoulder`, "shoulder", t.id, s, at, d1, Math.max(L1, minUpper), rr, rr * 0.75, chain);
  const el = b.add(`${pre}elbow`, "elbow", sh, s, b.tip(sh), d2, L2, rr * 0.75, rr * 0.56, chain);
  b.add(`${pre}wrist`, "wrist", el, s, b.tip(el), d3, L3, rr * 0.6, rr * 0.5, chain);
  b.couple(el, { src: sh, srcAxis: 0, axis: 0, loAbs: 0.4 });
}

/**
 * The extra repeated parts the counts / unlocks ask for beyond what the kind build made: wing pairs down the
 * back, arm pairs down the torso (each with a hand), extra tails fanned out, tentacles (a ring hanging from
 * the chest of a legged body; fractal branches from 6 tentacles on) and the second head on its own neck.
 */
function growExtras(b: Builder, P: BodyPlan6, ph: Phenotype, kind: Skeleton["kind"], H: number, hs: { parent: string; at: Vec3; dir: Vec3; H: number; segs: number; bodyR: number; min: number } | null, ho: HeadOpts): void {
  const c = P.counts, p = ph.plan;
  if (trunkOf(b).length === 0) return;
  const upright = kind === "biped" || kind === "blob";
  const dorsal: Vec3 = upright ? [0, 0, -1] : [0, 1, 0];
  // Wings.
  const wingsBuilt = b.joints.filter((j) => j.role === "wingRoot" && j.side > 0).length;
  // Span of the first pair as requested (its root bone length undone of growth x neoteny), else a default.
  const base = b.has("wingL0") ? b.j("wingL0").length / 0.42 / Math.max(1e-6, b.scaleOf("wingL0", "wingRoot", 1).length) : H * (0.55 + 0.5 * Math.max(p.wings, 0.55)) * P.wingSpan;
  for (let k = wingsBuilt; k < c.wingPairs; k++) {
    const t = trunkAt(b, Math.min(0.85, 0.12 + 0.26 * k), upright);
    b.curPair = k;
    for (const s of [-1, 1] as const) wingChain(b, t.id, s, add3(t.local, [s * t.r * 0.5, dorsal[1] * 0.62 * t.r, dorsal[2] * 0.62 * t.r]), base * Math.pow(0.78, k), t.r, k);
  }
  // Arms (shoulder joints further down the torso at each pair).
  const armsBuilt = b.joints.filter((j) => j.role === "shoulder" && j.chain.startsWith("arm") && j.side > 0).length;
  const ground = groundOf(b);
  for (let k = armsBuilt; k < c.armPairs; k++) {
    const t = trunkAt(b, upright ? 0.12 + 0.3 * k : 0.04 + 0.15 * k, upright);
    b.curPair = k;
    for (const s of [-1, 1] as const) armChain(b, k, t, s, upright, H, P.arm, ground, kind === "blob");
  }
  // Tails.
  const tailRoots = b.joints.filter((j) => j.role === "tail" && (j.parent < 0 || b.joints[j.parent].role !== "tail"));
  const builtT = tailRoots.length + (kind === "serpent" ? 1 : 0);
  for (let k = builtT; k < c.tails; k++) {
    b.curPair = k;
    const yaw = k === 0 ? 0 : (k % 2 === 1 ? 1 : -1) * 0.45 * Math.ceil(k / 2);
    const idK = b.has("tail0") ? k : 0;
    if (kind === "serpent") {
      const body = b.joints.filter((j) => j.chain === "body");
      const last = body[body.length - 1];
      tailChain(b, last.id, [last.dir[0] * last.length * 0.9, last.dir[1] * last.length * 0.9, last.dir[2] * last.length * 0.9], rotY(last.dir, yaw), 3, last.length * 1.2, last.r1 * 1.4, 0, 0, Math.max(1, k), 0);
    } else if (b.has("tail0")) {
      // Copy the first tail's REQUESTED size (its final bones carry growth x neoteny once already).
      const t0 = b.j("tail0");
      const n = b.joints.filter((j) => j.chain === "tail").length;
      const k0 = b.scaleOf("tail0", "tail", 0);
      // A yawed copy crosses more of the trunk: its first bone is at least 1.4 x the first tail's.
      tailChain(b, b.joints[t0.parent].id, t0.offset, t0.dir, Math.max(2, n), t0.length / Math.max(1e-6, k0.length), t0.r0 / Math.max(1e-6, k0.radius), 0, 1.4 * t0.length, idK, yaw);
    } else if (kind === "blob") {
      // A round body grows its tail from the back of its middle, on the surface.
      const t = trunkAt(b, 0.7, true);
      tailChain(b, t.id, add3(t.local, [0, 0, -0.9 * t.r]), [0, 0.1, -1], 4, H * 0.14, Math.min(t.r * 0.35, H * 0.05), 0, 0.9 * t.r, idK, yaw);
    } else {
      const t = trunkAt(b, 1, upright);
      tailChain(b, t.id, add3(t.local, [0, upright ? -0.1 * t.r : 0.2 * t.r, upright ? -0.6 * t.r : 0]), upright ? [0, -0.4, -1] : [0, 0.3, -1], 4, H * 0.14, Math.min(t.r * 0.45, H * 0.06), 0, 1.1 * t.r, idK, yaw);
    }
  }
  // Tentacles.
  const isMain = (j: JointDef) => j.role === "pod" && j.chain.startsWith("tent") && !j.chain.endsWith("b");
  const tentsBuilt = b.joints.filter(isMain).length;
  const more = c.tentacles - tentsBuilt;
  if (more > 0) {
    b.curPair = undefined;
    if (kind === "blob") {
      const R = b.joints[0].r0;
      const inner = b.joints.some((j) => j.role === "pod" && j.chain.startsWith("pod"));
      for (let i = 0; i < more; i++) {
        const a = ((i + 0.5) / more) * Math.PI * 2 + 0.2;
        const e: Vec3 = [Math.sin(a), 0, Math.cos(a)];
        const rr = inner ? 0.3 : 0.62;
        tentacle(b, tentsBuilt + i, "root", [e[0] * R * rr, inner ? -R * 0.55 : -R * 0.38, e[2] * R * rr], e, R * 1.7, R * 0.2, 0.3);
      }
    } else if (!b.joints.some((j) => j.contact && j.role === "ankle")) {
      // No legs (limbs drawn as tentacles): the body rests on a ring of ground tentacles under its middle.
      const t = trunkAt(b, upright ? 1 : 0.5, upright);
      const R = t.r;
      for (let i = 0; i < more; i++) {
        const a = ((i + 0.5) / more) * Math.PI * 2;
        const e: Vec3 = [Math.sin(a), 0, Math.cos(a)];
        tentacle(b, tentsBuilt + i, t.id, add3(t.local, [e[0] * R * 0.55, -R * 0.45, e[2] * R * 0.55]), e, Math.max(H * 0.5, R * 3), R * (more > 8 ? 0.26 : 0.32), 0.3);
      }
    } else {
      // A hanging ring (beard / skirt): from the pelvis of an upright body, from under the chest otherwise.
      const t = trunkAt(b, upright ? 1 : 0.1, upright);
      const centre = add3(t.local, [0, -t.r * 0.65, upright ? 0.1 * t.r : 0]);
      const hgt = t.jpos[1] + centre[1] - groundOf(b);
      const len = Math.max(H * 0.25, Math.min(H * 0.6, hgt * 1.25));
      for (let i = 0; i < more; i++) {
        const a = ((i + 0.5) / more) * Math.PI * 2;
        const e: Vec3 = [Math.sin(a), 0, Math.cos(a)];
        tentacle(b, tentsBuilt + i, t.id, add3(centre, [e[0] * t.r * 0.5, 0, e[2] * t.r * 0.5]), e, len, t.r * (more > 8 ? 0.16 : 0.2), 0.3, 4, { hang: true });
      }
    }
  }
  // Fractal tentacles: from 6 tentacles on, every other one forks once from its second segment.
  if (c.tentacles >= 6) {
    const mains = b.joints.filter(isMain).map((j) => j.chain);
    mains.forEach((chain, i) => {
      if (i % 2 !== 0 || !b.has(`${chain}s1`)) return;
      const host = b.j(`${chain}s1`);
      const pod = b.j(chain);
      const h = Math.hypot(pod.dir[0], pod.dir[2]) || 1;
      const e = rotY([pod.dir[0] / h, 0, pod.dir[2] / h], i % 4 === 0 ? 0.7 : -0.7);
      tentacle(b, -1, host.id, b.tip(host.id, 0.6), e, pod.length / 0.3 * 0.5, host.r1 * 0.85, 0.3, 2, { id: `${chain}b`, rise: true });
    });
  }
  // The second head (mythic): its own splayed neck from the same shoulders as the first.
  const heads = b.joints.filter((j) => j.role === "head").length;
  if (c.heads >= 2 && heads < 2 && hs) {
    b.curPair = 1;
    headChain(b, hs.parent, hs.at, hs.dir, ph, hs.H, hs.segs, hs.bodyR, hs.min, { ...ho, tag: "_2", splay: -1 });
  }
  b.curPair = undefined;
}

/** The minimal GLOBE [P6-C1]: one round body (the head volume IS the globe, so the face sits on it), on a hidden base. */
function buildGlobe(b: Builder, H: number): void {
  const R = H * 0.5;
  b.add("root", "root", null, 0, [0, 0, 0], [0, 1, 0], R * 0.08, R * 0.76, R * 0.76, "stack", true, true);
  const L = R / 0.62;
  b.add("head", "head", "root", 0, [0, 0.17 * R, -0.45 * L], [0, 0, 1], L, R, R * 0.62, "head", false, true);
  // The globe turns about the back of its own volume: a gentle look only.
  const h = b.j("head");
  h.limits = h.limits.map(([lo, hi]) => [lo * 0.3, hi * 0.3] as Range) as [Range, Range, Range];
}

/** LARVA [P6-E4]: a segmented grub / caterpillar (a serpent-like chain), a bare head, tiny legs, no wings. */
function buildLarva(b: Builder, ph: Phenotype, H: number, bulk: number): void {
  const p = ph.plan;
  const r = H * (0.15 + 0.04 * p.girth) * bulk;
  const n = 7 + Math.round(3 * p.segments);
  const segLen = (H * 1.5) / n;
  b.add("root", "root", null, 0, [0, 0, 0], [0, 0, -1], segLen, r * 0.9, r, "body", true);
  let prev = "root";
  for (let i = 1; i < n; i++) {
    const k0 = i / n, k1 = (i + 1) / n;
    prev = b.add(`seg${i}`, "segment", prev, 0, b.tip(prev), [0, 0, -1], segLen, r * (1 - 0.35 * k0 * k0), r * (1 - 0.35 * k1 * k1), "body", true);
  }
  headChain(b, "root", [0, r * 0.15, 0], [0, 0.35, 0.94], ph, H * 0.7, 1, r * 0.8, 1.15 * r * b.radiusK("root", "root", 0), { bare: true, neckK: 0.45 });
  // Three thoracic pairs and two prolegs.
  const hosts = ["root", "seg1", "seg2", `seg${n - 4}`, `seg${n - 2}`];
  hosts.forEach((h, q) => {
    const j = b.j(h), rr = j.r0;
    for (const s of [-1, 1] as const) {
      legChain(b, `p${q}${s > 0 ? "L" : "R"}`, h, s, [s * rr * 0.62, -rr * 0.55, -j.length * 0.5], rr * 0.42, rr * 0.34, rr * 0.22, rr * 0.5, q < 3, {
        upper: [s * 0.6, -1, 0],
        lower: [s * 0.1, -1, 0.1],
        foot: [0, -0.35, 1],
      });
    }
  });
}

/** COCOON [P6-E4]: a closed chrysalis standing on its base: no head, no limbs (the views pulse it). */
function buildCocoon(b: Builder, H: number, bulk: number): void {
  const R = H * 0.26 * bulk;
  b.add("root", "root", null, 0, [0, 0, 0], [0, 1, 0], H * 0.3, R * 0.55, R * 0.95, "stack", true);
  b.add("cocoon1", "segment", "root", 0, b.tip("root"), [0, 1, 0.03], H * 0.3, R * 0.95, R * 0.8, "stack");
  b.add("cocoon2", "segment", "cocoon1", 0, b.tip("cocoon1"), [0, 1, 0.08], H * 0.24, R * 0.8, R * 0.16, "stack");
}

export function buildSkeleton(ph: Phenotype, genes?: DevGenes): Skeleton {
  const H = ph.heightM, p = ph.plan;
  const dev = genes ? new Dev(ph, genes.growth, genes.body) : null;
  const b = new Builder(ph.mobility, dev);
  const chains: Skeleton["chains"] = {};
  const body = genes?.body;
  // Pass 6: the resolved plan (null = pass-5 build, byte-identical); C = counts that drive the kind builds.
  const P = bodyPlan6(ph, genes);
  const C = P?.source === "p6" ? P.counts : null;
  const bulk = P?.bulk ?? 1;
  const span0 = P?.wingSpan ?? 1;
  const armK = P?.arm ?? 1;
  const wing0 = (legacy: boolean) => (P ? P.counts.wingPairs >= 1 : legacy);
  // Wings granted by the counts / unlocks get a real wing frame even on a low wing gene.
  const pw = P && P.counts.wingPairs > 0 ? Math.max(p.wings, 0.55) : p.wings;
  const ho: HeadOpts = P ? { neckK: P.neck, hornK: P.horn, hornBonus: P.hornPairs, splay: P.counts.heads >= 2 ? 1 : 0 } : {};
  let headSpec: { parent: string; at: Vec3; dir: Vec3; H: number; segs: number; bodyR: number; min: number } | null = null;
  const head = (parent: string, at: Vec3, dir: Vec3, Hh: number, segs: number, bodyR: number, min = 0) => {
    // Pass-6 builds: the first neck segment always clears the trunk it grows from (pass 5 could leave a short
    // one swallowed by the chest; extra neck+ segments make it shorter still).
    headSpec = { parent, at, dir, H: Hh, segs: segs + (P?.neckSegs ?? 0), bodyR, min: P ? Math.max(min, 1.3 * bodyR * b.radiusK(parent, b.j(parent).role, 0)) : min };
    headChain(b, parent, at, dir, ph, Hh, headSpec.segs, bodyR, headSpec.min, ho);
  };
  // Body-plan extras (all identity on a legacy skeleton).
  const style = body?.limbStyle ?? "legs";
  const shW = body ? clampN(body.shoulder.width, 0.7, 1.4) : 1;
  const shH = body ? clampN(body.shoulder.height, 0.7, 1.4) : 1;
  const tailLen = body ? clampN(body.tail.length, 0.3, 2.2) : 1;
  // Tail curl (rad): the gene plus element curvature (water / air tails flow, rock / metal stay straight).
  const tailCurl = body ? clampN(body.tail.curl, -1, 1) * 1.6 + 0.35 * clampN(body.curvature, -1, 1) * (body.tail.shape === "whip" ? 1.5 : 1) : 0;
  const limbK = style === "stumps" ? 0.62 : style === "fins" ? 0.85 : 1;
  const limbR = style === "stumps" ? 1.25 : 1;
  const drift = (pair: string, maxShift: number) => (dev ? { ...dev.drift(pair), maxShift } : null);
  let kind: Skeleton["kind"] = ph.kind;
  if (P?.globe) {
    kind = "blob";
    buildGlobe(b, H * bulk);
  } else if (P?.form === "larva") {
    kind = "serpent";
    buildLarva(b, ph, H, bulk);
  } else if (P?.form === "cocoon") {
    kind = "blob";
    buildCocoon(b, H, bulk);
  } else {
    switch (ph.kind) {
      case "quadruped": {
        const legLen = H * (0.32 + 0.22 * p.legLen) * limbK;
        const bodyLen = H * (0.75 + 0.45 * p.segments);
        const r = H * (0.13 + 0.09 * p.girth) * (1 + 0.15 * Math.max(0, ph.axes.weight)) * bulk;
        const n = 2 + Math.round(2 * p.segments);
        const seg = bodyLen / n;
        let prev = b.add("root", "root", null, 0, [0, 0, 0], [0, 0, 1], seg, r * 0.92, r, "spine");
        for (let i = 1; i < n; i++) prev = b.add(i === n - 1 ? "chest" : `spine${i}`, i === n - 1 ? "chest" : "spine", prev, 0, b.tip(prev), [0, 0, 1], seg, r * (1 + 0.04 * i), r * (1 + 0.05 * i), "spine");
        head("chest", [0, r * 0.35, seg * 0.95], [0, 0.75, 0.66], H, 1 + Math.round(1.4 * p.neck), r);
        // Final torso radius (growth x neoteny): short baby bones must still EMERGE from it (viability).
        const rF = r * b.radiusK("root", "root", 0);
        const nTail = C ? (C.tails >= 1 ? Math.max(2, Math.round(5 * p.tail)) : 0) : Math.round(5 * p.tail);
        tailChain(b, "root", [0, r * 0.25, 0], [0, 0.3, -1], nTail, H * (0.1 + 0.1 * p.tail) * tailLen, r * 0.45, tailCurl, 1.15 * rF);
        // Shoulders [P5-V5]: wider / higher withers; the front legs lengthen by the lift so the soles stay down.
        const dy = (shH - 1) * r * 0.5;
        // A thigh shorter than the belly depth is swallowed by the torso: lengthen it, shorten the shin to match.
        const thigh = (want: number, lower: number, depth: number): [number, number] => {
          if (!dev) return [want, lower];
          const u = b.atLeast("hLhip", "hip", 1, want, depth);
          // The shin keeps >= 2.5 x its own final radius (a stub would vanish in the knee socket).
          const shinMin = 2.5 * r * limbR * 0.3 * b.radiusK("hLknee", "knee", 1);
          return [u, b.atLeast("hLknee", "knee", 1, Math.max(0.65 * lower, lower - (u - want)), shinMin)];
        };
        const [hu, hl] = thigh(legLen * 0.5, legLen * 0.42, 1.1 * rF);
        const [fu, fl] = thigh(legLen * 0.5 + dy * 0.55, legLen * 0.42 + dy * 0.45, 1.1 * rF - dy);
        // Pass 6: 3-4 leg pairs = middle pairs spread evenly between the hind and the fore pair.
        // (legPairs 0 = limbs drawn as tentacles: the body rests on a tentacle ring, growExtras.)
        const nPairs = C ? (C.legPairs <= 0 ? 0 : Math.max(2, Math.min(4, C.legPairs))) : 2;
        const zH = seg * 0.25, zF = (n - 1) * seg + seg * 0.7;
        for (const s of [-1, 1] as const) {
          const tag = s > 0 ? "L" : "R";
          if (nPairs > 0) {
            legChain(b, `h${tag}`, "root", s, [s * r * 0.7, -r * 0.3, seg * 0.25], hu, hl, legLen * 0.2, r * limbR, false, {}, drift("hind", 0.45 * r));
            legChain(b, `f${tag}`, "chest", s, [s * r * 0.75 * shW, -r * 0.3 + dy, seg * 0.7], fu, fl, legLen * 0.2, r * limbR, true, {}, drift("fore", 0.45 * r));
          }
          for (let k = 1; k < nPairs - 1; k++) {
            const z = zH + ((zF - zH) * k) / (nPairs - 1);
            const ti = Math.max(0, Math.min(n - 1, Math.floor(z / seg)));
            const host = ti === 0 ? "root" : ti === n - 1 ? "chest" : `spine${ti}`;
            const rr = r * (ti === 0 ? 0.96 : 1 + 0.045 * ti);
            legChain(b, `m${k}${tag}`, host, s, [s * rr * 0.72, -rr * 0.3, z - ti * seg], hu, hl, legLen * 0.2, r * limbR, false, {}, drift(`mid${k}`, 0.45 * r));
          }
          if (wing0(p.wings > 0.62 || ph.abilities.fly)) wingChain(b, "chest", s, [s * r * 0.5, r * 0.65, seg * 0.4], H * (0.5 + 0.6 * pw) * span0, r);
        }
        break;
      }
      case "biped": {
        const legLen = H * (0.36 + 0.15 * p.legLen) * limbK;
        const torso = H * (0.26 + 0.12 * p.segments);
        const r = H * (0.11 + 0.07 * p.girth) * (1 + 0.15 * Math.max(0, ph.axes.weight)) * bulk;
        const n = 2 + Math.round(p.segments);
        let prev = b.add("root", "root", null, 0, [0, 0, 0], [0, 1, 0.05], torso / n, r * 0.95, r, "spine");
        for (let i = 1; i < n; i++) prev = b.add(i === n - 1 ? "chest" : `spine${i}`, i === n - 1 ? "chest" : "spine", prev, 0, b.tip(prev), [0, 1, 0.04], torso / n, r * (1.02 + 0.05 * i), r * (1.05 + 0.04 * i), "spine");
        head("chest", b.tip("chest", 0.95), [0, 1, 0.2], H, 1, r);
        const nTail = C ? (C.tails >= 1 ? Math.max(2, Math.round(4 * p.tail)) : 0) : p.tail > 0.35 ? Math.round(4 * p.tail) : 0;
        tailChain(b, "root", [0, 0, -r * 0.7], [0, -0.4, -1], nTail, H * 0.12 * tailLen, r * 0.5, tailCurl, 0.9 * r * b.radiusK("root", "root", 0));
        const armD = dev?.drift("arms") ?? { len: 1, ang: 0 };
        for (const s of [-1, 1] as const) {
          const tag = s > 0 ? "L" : "R";
          if (!C || C.armPairs >= 1) {
            // Several arm pairs: the first hangs a little wider so the lower pairs' shoulders do not swallow it.
            const ax = C && C.armPairs >= 2 ? 0.45 : 0.22;
            const sh = b.add(`a${tag}shoulder`, "shoulder", "chest", s, [s * r * 1.08 * shW, (torso / n) * (0.8 + 0.2 * (shH - 1)), 0], armD.ang !== 0 ? rotX(norm3([s * ax, -1, 0.05]), armD.ang) : [s * ax, -1, 0.05], H * 0.2 * armD.len * armK, r * 0.32 * limbR * Math.sqrt(armK), r * 0.24 * limbR * Math.sqrt(armK), `arm-${tag}`);
            const el = b.add(`a${tag}elbow`, "elbow", sh, s, b.tip(sh), [0, -1, 0.15], H * 0.18 * armD.len * armK, r * 0.24 * limbR * Math.sqrt(armK), r * 0.18 * limbR * Math.sqrt(armK), `arm-${tag}`);
            b.add(`a${tag}wrist`, "wrist", el, s, b.tip(el), [0, -1, 0.1], H * 0.07 * armK, r * 0.2 * limbR, r * 0.16 * limbR, `arm-${tag}`);
            b.couple(el, { src: sh, srcAxis: 0, axis: 0, loAbs: 0.4 });
          }
          if (!C || C.legPairs >= 1) legChain(b, `l${tag}`, "root", s, [s * r * 0.55, -r * 0.1, 0], legLen * 0.5, legLen * 0.46, H * 0.12, r * limbR, false, {}, drift("legs", 0.3 * r));
          if (wing0(p.wings > 0.62 || ph.abilities.fly)) wingChain(b, "chest", s, [s * r * 0.4, (torso / n) * 0.7, -r * 0.6], H * (0.6 + 0.5 * pw) * span0, r);
        }
        if (C) sprawlLegs(b, "root", C.legPairs - 1, r, -r * 0.05, legLen, limbR);
        break;
      }
      case "hexapod": {
        const legLen = H * (0.3 + 0.2 * p.legLen) * limbK;
        const r = H * (0.12 + 0.06 * p.girth) * bulk;
        const thorax = H * 0.38;
        b.add("root", "root", null, 0, [0, 0, 0], [0, 0, 1], thorax, r, r * 1.05, "spine");
        let prev = "root";
        const nAbd = 1 + Math.round(2 * p.segments);
        let off: Vec3 = [0, r * 0.1, 0];
        for (let i = 0; i < nAbd; i++) {
          prev = b.add(`abd${i}`, "segment", prev, 0, off, i === 0 ? [0, 0.15, -1] : [0, 0.05, -1], H * (0.18 + 0.1 * p.segments), r * (1.25 - 0.15 * i), r * (1.1 - 0.2 * i), "abdomen");
          off = b.tip(prev);
        }
        head("root", [0, r * 0.2, thorax], [0, 0.3, 1], H * 0.8, 1, r);
        const pairs = C ? (C.legPairs <= 0 ? 0 : Math.max(2, Math.min(4, C.legPairs))) : 3;
        for (const s of [-1, 1] as const) {
          for (let k = 0; k < pairs; k++) {
            const tag = `${s > 0 ? "L" : "R"}${k}`;
            const f = pairs > 1 ? (2 * k) / (pairs - 1) - 1 : 0;
            legChain(b, `x${tag}`, "root", s, [s * r * 0.9, -r * 0.2, thorax * (0.15 + (0.7 * k) / Math.max(1, pairs - 1))], legLen * 0.45, legLen * 0.62, legLen * 0.25, r * 0.8 * limbR, k === 0, {
              upper: [s * 1, 0.35, f * 0.35],
              lower: [s * 0.35, -1, f * 0.15],
              foot: [s * 0.2, -0.6, f * 0.2 + 0.2],
            }, drift(`pair${k}`, 0.4 * r));
          }
          // Pass 6: hexapods with wings get them on the thorax (insect-like).
          if (P && P.counts.wingPairs >= 1) wingChain(b, "root", s, [s * r * 0.55, r * 0.85, thorax * 0.55], H * (0.7 + 0.5 * pw) * span0, r * 0.8);
        }
        break;
      }
      case "serpent": {
        const r = H * (0.07 + 0.05 * p.girth) * (1 + 0.15 * Math.max(0, ph.axes.weight)) * bulk;
        const n = 6 + Math.round(6 * p.segments);
        const segLen = (H * (1.6 + 0.8 * p.tail) * (body ? 0.8 + 0.2 * tailLen : 1)) / n;
        b.add("root", "root", null, 0, [0, 0, 0], [0, 0, -1], segLen, r, r, "body", true);
        let prev = "root";
        // The rear 40 % coils sideways with the tail curl (contacts stay on the ground: a yaw, not a pitch).
        let yaw = 0;
        for (let i = 1; i < n; i++) {
          const k = 1 - i / n;
          if (tailCurl !== 0 && i / n > 0.6) yaw += (tailCurl * 1.2) / Math.max(1, Math.round(0.4 * n));
          prev = b.add(`seg${i}`, "segment", prev, 0, b.tip(prev), rotY([0, 0, -1], yaw), segLen, r * (0.4 + 0.6 * k) + 0.01, r * (0.4 + 0.6 * (k - 1 / n)) + 0.005, "body", true);
        }
        head("root", [0, r * 0.4, 0], [0, 0.55, 0.85], H * 0.85, 1 + Math.round(p.neck), r * 1.3);
        if (wing0(p.wings > 0.7 || ph.abilities.fly)) for (const s of [-1, 1] as const) wingChain(b, "root", s, [s * r * 0.8, r * 0.5, -segLen], H * 0.9 * span0, r);
        // Serpent legs [P5-V6]: 1-2 short sprawling pairs (front pair near the head so it can rear up on them);
        // pass 6: up to 4 pairs spread along the body.
        const pairs = C ? Math.max(0, Math.min(4, C.legPairs)) : body ? Math.max(0, Math.min(2, Math.round(body.serpentLegs))) : 0;
        for (let q = 0; q < pairs; q++) {
          const pos = pairs <= 2 ? (q === 0 ? 0.18 : 0.52) : 0.15 + 0.22 * q;
          const at = Math.max(1, Math.min(n - 1, Math.round(n * pos)));
          const sj = b.joints[b.index.get(`seg${at}`)!];
          const rr = sj.r0;
          for (const s of [-1, 1] as const) {
            legChain(b, `s${s > 0 ? "L" : "R"}${q}`, sj.id, s, [s * rr * 0.72, -rr * 0.25, -sj.length * 0.4], rr * 0.85, rr * 0.34, rr * 0.5, rr * 0.95 * limbR, q === 0, {
              upper: [s, -0.15, 0.1],
              lower: [s * 0.15, -1, 0.1],
              foot: [s * 0.2, -0.2, 1],
            }, drift(`spair${q}`, 0.2 * rr));
          }
        }
        const nT = C ? C.tentacles : style === "tentacles" ? Math.max(4, Math.min(8, 4 + Math.round(4 * p.legLen))) : 0;
        // Octopus-like serpent: tentacles fan out from the front ring, under and around the head.
        for (let i = 0; i < nT; i++) {
          const a = -Math.PI * 0.55 + (Math.PI * 1.1 * (i + 0.5)) / nT;
          const e: Vec3 = [Math.sin(a), 0, Math.cos(a)];
          tentacle(b, i, "root", [e[0] * r * 0.6, -r * 0.2, e[2] * r * 0.6 + r * 0.2], e, H * 0.55, r * 0.42 * (nT > 8 ? 0.85 : 1), clampN(body?.curvature ?? 0, -1, 1) * 0.3 + 0.2);
        }
        break;
      }
      case "avian": {
        const legLen = H * (0.3 + 0.18 * p.legLen) * limbK;
        const r = H * (0.12 + 0.06 * p.girth) * bulk;
        const bodyL = H * 0.42;
        b.add("root", "root", null, 0, [0, 0, 0], [0, 0.25, 1], bodyL * 0.55, r, r * 1.1, "spine");
        b.add("chest", "chest", "root", 0, b.tip("root"), [0, 0.3, 1], bodyL * 0.45, r * 1.1, r * 0.9, "spine");
        const rC = r * 1.1 * b.radiusK("chest", "chest", 0);
        head("chest", b.tip("chest", 0.9), [0, 0.85, 0.5], H, 2 + Math.round(p.neck), r * 0.85, 0.95 * rC);
        if (!C || C.tails >= 1) tailChain(b, "root", [0, r * 0.2, -r * 0.5], [0, 0.15, -1], 2, H * 0.18 * tailLen, r * 0.7, tailCurl, 0.9 * r * b.radiusK("root", "root", 0));
        for (const s of [-1, 1] as const) {
          const tag = s > 0 ? "L" : "R";
          if (!C || C.legPairs >= 1) {
            legChain(b, `l${tag}`, "root", s, [s * r * 0.5, -r * 0.5, bodyL * 0.15], legLen * 0.48, legLen * 0.52, H * 0.12, r * 0.6 * limbR, false, {
              upper: [0, -1, 0.25],
              lower: [0, -1, -0.3],
            }, drift("legs", 0.3 * r));
          }
          wingChain(b, "chest", s, [s * r * 0.75, r * 0.45, bodyL * 0.1], H * (0.85 + 0.7 * p.wings) * span0, r);
        }
        if (C) sprawlLegs(b, "root", C.legPairs - 1, r, -r * 0.4, legLen, limbR);
        break;
      }
      case "blob": {
        const R = H * (0.36 + 0.08 * p.girth) * bulk;
        b.add("root", "root", null, 0, [0, 0, 0], [0, 1, 0], R * 0.8, R, R * 0.85, "stack");
        let prev = "root";
        const n = Math.round(2 * p.segments);
        for (let i = 0; i < n; i++) prev = b.add(`lobe${i}`, "segment", prev, 0, b.tip(prev), [0, 1, 0.08], R * 0.55 * (1 - 0.2 * i), R * (0.7 - 0.15 * i), R * (0.55 - 0.15 * i), "stack");
        const two = (P?.counts.heads ?? 1) >= 2;
        const hr = R * (0.5 - 0.1 * n) * (two ? 0.8 : 1);
        b.add("head", "head", prev, 0, two ? add3(b.tip(prev, 0.7), [hr * 1.05, 0, 0]) : b.tip(prev, 0.7), two ? [0.25, 0.1, 1] : [0, 0.1, 1], R * 0.5, hr, R * 0.35, "head");
        if (two) {
          b.curPair = 1;
          b.add("head_2", "head", prev, 0, add3(b.tip(prev, 0.7), [-hr * 1.05, 0, 0]), [-0.25, 0.1, 1], R * 0.5, hr, R * 0.35, "head");
          b.curPair = undefined;
        }
        const tent = C ? C.tentacles > 0 : style === "tentacles";
        if (tent) {
          // Octopus [P5-V6]: 4-8 tapering tentacles curling out from the lower rim (pass 6: up to 12; with pods
          // too, the tentacles move to an inner ring under the body so their sockets do not swallow the pods).
          const nT = C ? C.tentacles : Math.max(4, Math.min(8, 4 + Math.round(4 * p.legLen)));
          const inner = !!C && C.legPairs > 0;
          for (let i = 0; i < nT; i++) {
            const a = (i / nT) * Math.PI * 2 + Math.PI / nT;
            const e: Vec3 = [Math.sin(a), 0, Math.cos(a)];
            const rr = inner ? 0.3 : 0.62;
            tentacle(b, i, "root", [e[0] * R * rr, inner ? -R * 0.55 : -R * 0.38, e[2] * R * rr], e, R * 1.9, R * 0.24 * (nT > 8 ? 0.85 : 1), clampN(body?.curvature ?? 0, -1, 1) * 0.3 + 0.25);
          }
          if (!C) break;
        }
        const pods = C ? 2 * C.legPairs : 3 + Math.round(3 * p.legLen);
        for (let i = 0; i < pods; i++) {
          const a = (i / pods) * Math.PI * 2 + 0.3;
          const s: -1 | 0 | 1 = Math.cos(a) > 0.2 ? 1 : Math.cos(a) < -0.2 ? -1 : 0;
          const pod = b.add(`pod${i}`, "pod", "root", s, [Math.cos(a) * R * 0.6, -R * 0.35, Math.sin(a) * R * 0.6], [Math.cos(a), -0.75, Math.sin(a)], R * 0.55 * limbK, R * 0.3 * limbR, R * 0.18 * limbR, `pod${i}`);
          const tipR = R * 0.18 * limbR;
          b.add(`pod${i}tip`, "ankle", pod, s, b.tip(pod), [Math.cos(a), -0.9, Math.sin(a)], b.atLeast(`pod${i}tip`, "ankle", s, R * 0.25 * limbK, 2.4 * tipR * b.radiusK(`pod${i}tip`, "ankle", s)), tipR, R * 0.12 * limbR, `pod${i}`, true);
        }
        // A blob with neither pods nor tentacles rests on its own base.
        if (pods === 0 && !tent) b.joints[0].contact = true;
        break;
      }
    }
    if (P) growExtras(b, P, ph, kind, H, headSpec, ho);
  }

  // Pass 6: tell every head what its face carries (the eyes are split between two heads: the second gets 1-2).
  if (P) {
    const heads = b.joints.filter((j) => j.role === "head");
    const total = P.counts.eyes;
    const e2 = heads.length >= 2 ? (total >= 4 ? 2 : 1) : 0;
    heads.forEach((h, k) => {
      const counted = P.source === "p6" || P.globe;
      h.face = {
        ...(counted ? { eyes: k === 0 ? Math.max(1, total - e2) : e2 } : {}),
        eyeBonus: !counted && k === 0 ? 2 * (P.unlocks["eyes+"] ?? 0) : 0,
        globe: P.globe,
        complex: P.source === "p6" && total >= 6,
        second: k > 0,
      };
    });
  }

  // Chain budgets (total bend per axis) scale with mobility.
  const m = ph.mobility;
  const budgets: Record<string, Vec3> = {
    spine: [0.6 * m, 0.7 * m, 0.3 * m],
    neck: [1.0 * m, 1.2 * m, 0.4 * m],
    tail: [1.2 * m, 1.8 * m, 0.1],
    body: [0.8 * m, 3.6 * m, 0.4 * m],
    abdomen: [0.6 * m, 0.8 * m, 0.2 * m],
    stack: [0.5 * m, 0.6 * m, 0.5 * m],
  };
  // Pass 6: extra tails and the second neck get their own budgets.
  for (const k of [1, 2, 3]) budgets[`tail${k}`] = budgets.tail;
  budgets["neck_2"] = budgets.neck;
  b.joints.forEach((j, i) => {
    if (!budgets[j.chain]) return;
    (chains[j.chain] ??= { joints: [], budget: budgets[j.chain] }).joints.push(i);
  });

  // Mass distribution proportional to bone volume, normalised to the phenotype mass.
  let vol = 0;
  for (const j of b.joints) {
    const rr = (j.r0 + j.r1) / 2;
    j.mass = Math.PI * rr * rr * Math.max(j.length, rr) + (j.role === "head" || j.role === "root" ? (4 / 3) * Math.PI * j.r0 ** 3 : 0);
    vol += j.mass;
  }
  for (const j of b.joints) j.mass = (j.mass / vol) * ph.massKg;

  const sk: Skeleton = { kind, joints: b.joints, index: b.index, chains, height: H, rootHeight: 0, totalMass: ph.massKg, mobility: m };
  if (P) sk.plan6 = P;
  if (dev && genes) sk.dev = { growth: clamp01n(ph.growth), drive: dev.drive, baby: dev.baby, spiral: clampN(genes.growth.spiral, 0.3, 2.5), neoteny: clamp01n(genes.growth.neoteny) };
  // Seat the body: lift the root so the lowest contact surface touches y = 0 at rest.
  const fk = forwardKinematics(sk, {});
  let minY = Infinity;
  sk.joints.forEach((j, i) => {
    if (!j.contact) return;
    minY = Math.min(minY, fk.end[i].y - j.r1, fk.pos[i].y - j.r0);
  });
  if (!Number.isFinite(minY)) minY = 0;
  sk.rootHeight = -minY;
  sk.joints[0].offset = [0, sk.rootHeight, 0];
  balancePosture(sk);
  return sk;
}

/**
 * Posture: a resting animal stands with its centre of mass over its soles. When the rest pose leaves
 * the COM outside (or within 2 % of the height of the edge of) the support polygon, slide every leg
 * (the root joint of each chain that ends in a ground contact) along the body axis until the soles sit
 * under the COM. Measured before this pass: biped feet 1.5-5.5 cm in front of the COM, avian feet up to
 * 7 cm behind it. At rest every joint frame is the identity, so offset z IS creature z; the legs carry
 * mass (the COM follows them a little), hence the few iterations. Spines are never moved.
 */
function balancePosture(sk: Skeleton): void {
  const chainRoot = (i: number) => {
    let k = i;
    while (sk.joints[k].parent >= 0 && sk.joints[sk.joints[k].parent].chain === sk.joints[i].chain) k = sk.joints[k].parent;
    return k;
  };
  for (let it = 0; it < 4; it++) {
    const fk = forwardKinematics(sk, {});
    if (balanceOf(sk, fk).margin > 0.02 * sk.height) return;
    const com = centerOfMass(sk, fk);
    const feet = sk.joints.flatMap((j, i) => (j.contact && fk.end[i].y - j.r1 <= 0.08 * sk.height + 0.02 ? [i] : []));
    const roots = new Set(feet.map(chainRoot).filter((k) => k > 0 && sk.joints[k].chain !== sk.joints[0].chain));
    if (feet.length === 0 || roots.size === 0) return;
    const dz = com.z - feet.reduce((s, i) => s + fk.end[i].z, 0) / feet.length;
    for (const k of roots) {
      const o = sk.joints[k].offset;
      sk.joints[k].offset = [o[0], o[1], o[2] + dz];
    }
  }
}

// ------------------------------------------------------------------ constraints

export interface ConstraintReport {
  pose: Pose;
  /** Total radians removed by limits + budgets ("strain"). */
  strain: number;
  perJoint: Record<string, number>;
}

/** Clamp a pose to dynamic limits (parents first, couplings use already-constrained angles), then budgets. */
export function constrainPose(sk: Skeleton, pose: Pose): ConstraintReport {
  const out: Pose = {};
  const perJoint: Record<string, number> = {};
  let strain = 0;
  for (const j of sk.joints) {
    const want = pose[j.id] ?? [0, 0, 0];
    const got: Vec3 = [0, 0, 0];
    for (let a = 0; a < 3; a++) {
      let [lo, hi] = j.limits[a];
      for (const c of j.couplings) {
        if (c.axis !== a) continue;
        const th = (out[c.src] ?? [0, 0, 0])[c.srcAxis];
        lo += c.loLin * th + c.loAbs * Math.abs(th);
        hi += c.hiLin * th + c.hiAbs * Math.abs(th);
      }
      if (lo > hi) lo = hi = (lo + hi) / 2;
      const v = Number.isFinite(want[a]) ? want[a] : 0;
      got[a] = v < lo ? lo : v > hi ? hi : v;
    }
    out[j.id] = got;
    const d = Math.abs(got[0] - want[0]) + Math.abs(got[1] - want[1]) + Math.abs(got[2] - want[2]);
    if (d > 1e-9) perJoint[j.id] = d;
    strain += Number.isFinite(d) ? d : 0;
  }
  for (const chain of Object.values(sk.chains)) {
    for (let a = 0; a < 3; a++) {
      let sum = 0;
      for (const i of chain.joints) sum += Math.abs(out[sk.joints[i].id][a]);
      if (sum > chain.budget[a] && sum > 0) {
        const k = chain.budget[a] / sum;
        for (const i of chain.joints) {
          const id = sk.joints[i].id;
          const before = out[id][a];
          out[id][a] = before * k;
          strain += Math.abs(before - out[id][a]);
          perJoint[id] = (perJoint[id] ?? 0) + Math.abs(before - out[id][a]);
        }
      }
    }
  }
  return { pose: out, strain, perJoint };
}

// ------------------------------------------------------------------ kinematics & balance

export interface FK {
  pos: Vector3[];
  end: Vector3[];
  quat: Quaternion[];
}

const _e = new Euler();
const _q = new Quaternion();
const _v = new Vector3();

/** World-space joint origins, bone ends and orientations for a pose (root at rootPos/rootQuat). */
export function forwardKinematics(sk: Skeleton, pose: Pose, rootPos = new Vector3(), rootQuat = new Quaternion()): FK {
  const n = sk.joints.length;
  const pos: Vector3[] = new Array(n), end: Vector3[] = new Array(n), quat: Quaternion[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const j = sk.joints[i];
    const pq = j.parent < 0 ? rootQuat : quat[j.parent];
    const pp = j.parent < 0 ? rootPos : pos[j.parent];
    const p = new Vector3(j.offset[0], j.offset[1], j.offset[2]).applyQuaternion(pq).add(pp);
    const a = pose[j.id] ?? [0, 0, 0];
    _e.set(a[0], a[1], a[2], "XYZ");
    const q = pq.clone().multiply(_q.setFromEuler(_e));
    pos[i] = p;
    quat[i] = q;
    end[i] = _v.set(j.dir[0], j.dir[1], j.dir[2]).multiplyScalar(j.length).applyQuaternion(q).add(p).clone();
  }
  return { pos, end, quat };
}

export function centerOfMass(sk: Skeleton, fk: FK): Vector3 {
  const c = new Vector3();
  let m = 0;
  sk.joints.forEach((j, i) => {
    c.addScaledVector(fk.pos[i].clone().add(fk.end[i]).multiplyScalar(0.5), j.mass);
    m += j.mass;
  });
  return m > 0 ? c.multiplyScalar(1 / m) : c;
}

function hull2(points: [number, number][]): [number, number][] {
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [], upper: [number, number][] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

function segDist(p: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy || 1e-12;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

export interface BalanceState {
  com: Vector3;
  contacts: number;
  /** Signed distance (m) of the COM ground projection inside the support polygon (negative = outside). */
  margin: number;
  /** margin normalised by body height. */
  stability: number;
}

/** Static balance: COM projection vs convex hull of ground contacts within tolerance of groundY. */
export function balanceOf(sk: Skeleton, fk: FK, groundY = 0): BalanceState {
  const com = centerOfMass(sk, fk);
  const tol = 0.08 * sk.height + 0.02;
  // Each ground contact is a SOLE, not a point: a disc of radius 1.6x the end-joint radius (at least
  // 4 % of the height) sampled at 8 points. Point feet made a 2-point hull for every biped and avian,
  // which can never contain the centre of mass: every standing biped scored as falling.
  const pts: [number, number][] = [];
  let contacts = 0;
  sk.joints.forEach((j, i) => {
    if (!j.contact) return;
    const e = fk.end[i];
    if (e.y - j.r1 > groundY + tol) return;
    contacts++;
    const rf = Math.max(1.6 * j.r1, 0.04 * sk.height);
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      pts.push([e.x + rf * Math.cos(a), e.z + rf * Math.sin(a)]);
    }
  });
  const c: [number, number] = [com.x, com.z];
  let margin: number;
  if (contacts === 0) margin = -sk.height;
  else {
    const h = hull2(pts);
    let inside = true, dmin = Infinity;
    for (let i = 0; i < h.length; i++) {
      const a = h[i], b = h[(i + 1) % h.length];
      const cr = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      if (cr < 0) inside = false;
      dmin = Math.min(dmin, segDist(c, a, b));
    }
    margin = inside ? dmin : -dmin;
  }
  return { com, contacts, margin, stability: margin / Math.max(0.05, sk.height) };
}
