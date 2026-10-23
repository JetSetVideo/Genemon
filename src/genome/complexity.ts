/**
 * Complexity and rarity [P6-C1, P6-C2]: from the minimal GLOBE (one round body, one eye, two colours,
 * nothing else) to the mythic COLOSSUS (XXL chimera: tentacles, several wing and arm pairs, many fingers,
 * two mouths, 6-8 eyes).
 *
 * THE SCORE (nature only, deterministic from the genome):
 *
 *     geneZ = sum of the 12 complexity alleles (6 pairs, `Genome.cxGenes`) - 6     (Irwin-Hall, sd 1)
 *     planZ = (mean of the 10 "part" plan genes - 0.5) / PLAN_SD, clamped to +-3        (~N(0, 1))
 *     luck  = N(0, 1) from the genotype seed (developmental, NOT inherited: a child has a new seed)
 *     raw   = (geneZ + PLAN_W * planZ + NOISE_W * luck) / sqrt(1 + PLAN_W^2 + NOISE_W^2) + KIND_OFFSET[kind]
 *
 * The genetic terms are allele means, so the score is ADDITIVE: a child's expected genetic value is the
 * mid-parent value (Mendelian segregation adds noise; breeding adds rare jumps, src/genome/breeding.ts); the
 * luck term (~54 % of the variance) keeps heritability near 0.45, so selection climbs slowly. The tier cuts
 * (T_*) are calibrated on 3 M wild genomes so the wild shares match `TIER_ODDS` (globe ~6.5 %, median in
 * "common", mythic 1 in 1500, colossal 1 in 5000). A globe is a BLOB by definition: only blobs can be
 * minimal (the blob offset puts most blobs there), every other body floors at "simple".
 *
 * Legacy genomes (no `cxGenes`) derive their alleles from `seeds.genotype` (never from the id, never hashed
 * into the id), so a stored Genemon keeps its id and gets one stable profile; wild genomes from
 * `randomGenome` use the same derivation, so they need not store anything.
 *
 * BODY COUNTS: the pass-5 anatomy rules (eye-count gene, tentacle gene, serpent legs, digits, wings from
 * plan.wings) evaluated on the GENOME (genetic axes, genetic element) give the base counts; the tier then
 * caps (minimal, simple) or adds parts (complex, elaborate, mythic). `helixOf` copies these counts into
 * the helix (eye count, wings presence, tentacles, serpent legs, digits), so p5 and p6 always agree.
 *
 * Pure module. Runtime imports avoid `genome.ts` (genome.ts imports this file for the colossus bias).
 */
import type { Allele, BodyKind, Genome, PlanGene } from "./genome.ts";
import type { BodyCounts, ComplexityProfile, ComplexityTier } from "./p6Types.ts";
import { AXES, AXIS_IDS, type AxisId, type AxisVector } from "../data/axes.ts";
import { ELEMENT_IDS, elementAffinities, type ElementId } from "../data/elements.ts";
import { clamp, clamp01, u01 } from "../core/math.ts";
import { hashSeed, Rng } from "../core/rng.ts";
import { ensureMorph, type MorphAlleles } from "./helix.ts";

export const COMPLEXITY_TIERS: readonly ComplexityTier[] = ["minimal", "simple", "common", "complex", "elaborate", "mythic"];
/** Number of complexity allele pairs on the genome (`Genome.cxGenes`). */
export const CX_PAIRS = 6;

/** Target share of wild genomes per tier (the T_* cuts below are calibrated to these). */
const TIER_ODDS: Record<ComplexityTier, number> = {
  minimal: 0.065,
  simple: 0.22,
  common: 0.42,
  complex: 0.2,
  elaborate: 1 - 0.065 - 0.22 - 0.42 - 0.2 - 1 / 1500,
  mythic: 1 / 1500,
};
/** Share of wild genomes that are colossal (a subset of mythic). */
export const COLOSSAL_ODDS = 1 / 5000;

/** Plan genes that add visible parts (their mean is the planZ term). */
const CX_PLAN: readonly PlanGene[] = ["wings", "horns", "spikes", "tail", "segments", "ears", "quality", "neck", "eyes", "jaw"];
/** Std-dev of the mean of CX_PLAN on wild genomes (measured on 3 M wild genomes: 0.0482). */
const PLAN_SD = 0.048;
const PLAN_W = 0.5;
/** planZ is clamped: selecting every part gene to its maximum must not run away with the score. */
const PLAN_Z_MAX = 3;
/**
 * Developmental luck: a per-individual N(0, 1) drawn from the genotype seed (a child gets a new seed, so it is
 * NOT inherited). ~54 % of the variance: heritability ~0.45, which makes selection climb SLOWLY.
 */
const NOISE_W = 1.2;
const KIND_OFFSET: Record<BodyKind, number> = { blob: -1.2, serpent: -0.25, quadruped: 0, biped: 0.1, avian: 0.15, hexapod: 0.35 };

// Tier cuts on `raw` (calibrated: see the header). minimal = blob && raw < T_MIN.
const T_MIN = -1.4097;
const T_SIMPLE = -0.7573;
const T_COMMON = 0.4697;
const T_COMPLEX = 1.2933;
const T_MYTHIC = 3.2507;
const T_COLOSSAL = 3.5814;
/** Mean / sd of raw on wild genomes (the 0..1 score is the logistic percentile of raw). */
const RAW_MU = -0.1441;
const RAW_SD = 1.112;

// ------------------------------------------------------------------ alleles
function validPairs(x: unknown): x is Allele[] {
  return Array.isArray(x) && x.length === CX_PAIRS &&
    x.every((p) => Array.isArray(p) && p.length === 2 && p.every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1));
}

/** Deterministic complexity alleles from the genotype seed (legacy saves and wild genomes). Never the id. */
export function deriveCx(g: Pick<Genome, "seeds">): Allele[] {
  const rng = new Rng(hashSeed(g.seeds.genotype >>> 0, "complexity"));
  const out: Allele[] = [];
  for (let i = 0; i < CX_PAIRS; i++) out.push([rng.next(), rng.next()]);
  return out;
}

/** The stored complexity alleles when valid, else the deterministic derivation. */
export function cxAllelesOf(g: Pick<Genome, "seeds"> & { cxGenes?: unknown }): Allele[] {
  return validPairs(g.cxGenes) ? g.cxGenes.map((p) => [p[0], p[1]] as Allele) : deriveCx(g);
}

// ------------------------------------------------------------------ score
const planV = (g: Pick<Genome, "plan">, id: PlanGene) => clamp01((g.plan[id][0] + g.plan[id][1]) / 2);

/** The additive complexity value (higher = more parts). Needs only alleles, plan genes and the body kind. */
export function complexityRaw(g: Pick<Genome, "seeds" | "plan" | "kind"> & { cxGenes?: unknown }): number {
  const cx = cxAllelesOf(g);
  let sum = 0;
  for (const p of cx) sum += p[0] + p[1];
  const geneZ = sum - CX_PAIRS;
  let pm = 0;
  for (const id of CX_PLAN) pm += planV(g, id);
  const planZ = clamp((pm / CX_PLAN.length - 0.5) / PLAN_SD, -PLAN_Z_MAX, PLAN_Z_MAX);
  const luck = new Rng(hashSeed(g.seeds.genotype >>> 0, "cx-dev")).normal();
  return (geneZ + PLAN_W * planZ + NOISE_W * luck) / Math.sqrt(1 + PLAN_W * PLAN_W + NOISE_W * NOISE_W) + KIND_OFFSET[g.kind];
}

/** Tier of a raw value for a body kind (only blobs can be minimal globes). */
export function tierOfRaw(raw: number, kind: BodyKind): ComplexityTier {
  if (kind === "blob" && raw < T_MIN) return "minimal";
  if (raw < T_SIMPLE) return "simple";
  if (raw < T_COMMON) return "common";
  if (raw < T_COMPLEX) return "complex";
  if (raw < T_MYTHIC) return "elaborate";
  return "mythic";
}

/** Colossal = the top of the mythic tier (and never a blob). Cheap: no morph genes needed. */
export function isColossal(g: Pick<Genome, "seeds" | "plan" | "kind"> & { cxGenes?: unknown }): boolean {
  return g.kind !== "blob" && complexityRaw(g) >= T_COLOSSAL;
}

/** Expected share of wild genomes per tier. */
export function tierOdds(): Record<ComplexityTier, number> {
  return { ...TIER_ODDS };
}

// ------------------------------------------------------------------ genome-level anatomy (pass-5 rules)
function geneticAxesOf(g: Pick<Genome, "axes">): AxisVector {
  const out = {} as AxisVector;
  for (const ax of AXES) {
    const p = g.axes[ax.id as AxisId];
    const v = ax.dominance === "extreme" ? (Math.abs(p[0]) >= Math.abs(p[1]) ? p[0] : p[1]) : (p[0] + p[1]) / 2;
    out[ax.id as AxisId] = clamp(v, -1, 1);
  }
  for (const id of AXIS_IDS) if (!(id in out)) out[id] = 0;
  return out;
}

function geneticPrimary(axes: AxisVector): ElementId {
  const aff = elementAffinities(axes);
  let best: ElementId = "neutral", bv = -Infinity;
  for (const e of ELEMENT_IDS) if (e !== "neutral" && aff[e] > bv) [best, bv] = [e, aff[e]];
  return bv >= 0.2 ? best : "neutral";
}

const lohi = (p: readonly [number, number]) => [Math.min(p[0], p[1]), Math.max(p[0], p[1])] as const;
const smooth = (t: number) => t * t * (3 - 2 * t);
function traitOf(m: MorphAlleles, id: keyof MorphAlleles, drive: number, r0: number, r1: number): number {
  const [lo, hi] = lohi(m[id]);
  return r0 + (r1 - r0) * (lo + (hi - lo) * smooth(clamp01(drive)));
}
function pickBy<T>(items: readonly T[], w: readonly number[], u: number): T {
  let tot = 0;
  for (const x of w) tot += Math.max(0, x);
  let r = clamp(u, 0, 0.999999) * tot;
  for (let i = 0; i < items.length; i++) {
    r -= Math.max(0, w[i]);
    if (r < 0) return items[i];
  }
  return items[items.length - 1];
}

/** Eye count 1..8 from the eyeCount / p5.eyeMany genes (the pass-5 recessive rule on the genome). */
function baseEyes(m: MorphAlleles, kind: BodyKind, a: AxisVector, prim: ElementId): number {
  const [lo, hi] = lohi(m.eyeCount);
  const manyT = 0.66 - (kind === "hexapod" ? 0.12 : 0) - 0.05 * Math.max(0, a.wisdom) -
    (prim === "psychic" || prim === "void" ? 0.05 : 0);
  if (hi < 0.245) return 1;
  if (lo <= manyT) return 2;
  return pickBy([3, 4, 5, 6, 7, 8], [3.0, 2.6, 1.0, 1.4, 0.4, kind === "hexapod" ? 2.6 : 0.7], m["p5.eyeMany"][0]);
}

/** Tentacle limbs (the pass-5 recessive limb-style gene; wet bodies lower the bar). */
function tentacled(m: MorphAlleles, kind: BodyKind, a: AxisVector, prim: ElementId): boolean {
  const [lo] = lohi(m["p5.limbStyle"]);
  const wet = prim === "water" || prim === "poison" || a.moisture > 0.4;
  if (kind === "blob") return lo > (wet ? 0.45 : 0.55);
  if (kind === "serpent") return lo > (wet ? 0.72 : 0.8);
  return lo > 0.95;
}

const TIER_RANK: Record<ComplexityTier, number> = { minimal: 0, simple: 1, common: 2, complex: 3, elaborate: 4, mythic: 5 };

/** Body counts consistent with the kind, then shaped by the tier. Deterministic (rolls seeded by the cx alleles). */
function countsOf(g: Genome, tier: ComplexityTier, colossal: boolean): BodyCounts {
  if (tier === "minimal") {
    return { eyes: 1, mouths: 1, heads: 1, wingPairs: 0, armPairs: 0, legPairs: 0, tentacles: 0, fingers: 0, tails: 0 };
  }
  const m = ensureMorph(g);
  const a = geneticAxesOf(g);
  const prim = geneticPrimary(a);
  const kind = g.kind;
  const plan = (id: PlanGene) => planV(g, id);
  const cx = cxAllelesOf(g);
  const r = new Rng(hashSeed(...cx.flatMap((p) => [Math.round(Math.min(p[0], p[1]) * 1e6), Math.round(Math.max(p[0], p[1]) * 1e6)]), "counts"));

  let eyes = baseEyes(m, kind, a, prim);
  let wingPairs = kind === "avian" || plan("wings") >= 0.45 ? 1 : 0;
  let armPairs = kind === "biped" ? 1 : 0;
  let legPairs = kind === "quadruped" ? 2 : kind === "biped" || kind === "avian" ? 1 : kind === "hexapod" ? 3 : 0;
  let tentacles = 0;
  const tent = tentacled(m, kind, a, prim);
  if (kind === "serpent" && !tent) {
    const [lo, hi] = lohi(m["p5.serpentLegs"]);
    legPairs = lo > 0.72 ? (hi > 0.95 ? 2 : 1) : 0;
  }
  if (kind === "blob" && !tent) legPairs = Math.floor((3 + Math.round(3 * plan("legLen"))) / 2); // stump pods
  if (tent) {
    if (kind === "blob" || kind === "serpent") tentacles = clamp(4 + Math.round(4 * plan("legLen")), 4, 8);
    else {
      tentacles = 2 * (legPairs + armPairs); // limbs drawn as tentacles
      legPairs = 0;
      armPairs = 0;
    }
  }
  // Digits per hand / foot (the pass-5 digits gene; tentacle-styled limbs keep their digit count as before).
  const handed = kind !== "serpent" && kind !== "blob";
  let fingers = !handed
    ? 0
    : Math.round(traitOf(m, "digits", 0.5 * plan("quality") + 0.5 * u01(a.might), 3, kind === "avian" ? 4 : 5));
  let tails = kind === "serpent" || kind === "avian"
    ? 1
    : kind === "quadruped"
    ? (Math.round(5 * plan("tail")) >= 1 ? 1 : 0)
    : kind === "blob"
    ? 0
    : plan("tail") > 0.35
    ? 1
    : 0;
  let mouths = 1, heads = 1;

  switch (tier) {
    case "simple":
      eyes = Math.min(eyes, 3);
      tentacles = Math.min(tentacles, 4);
      fingers = Math.min(fingers, 4);
      break;
    case "common":
      break;
    case "complex":
      if (tails === 1 && r.chance(0.2)) tails = 2;
      if (tentacles > 0) tentacles = Math.min(10, tentacles + 2);
      break;
    case "elaborate":
      if (wingPairs === 1 && r.chance(0.45)) wingPairs = 2;
      if (kind === "biped" && armPairs === 1 && r.chance(0.4)) armPairs = 2;
      if (r.chance(0.15)) mouths = 2;
      if (tails >= 1 && r.chance(0.3)) tails = 2;
      if (tentacles > 0) tentacles = Math.min(10, tentacles + 2 + r.int(0, 2));
      break;
    case "mythic": {
      // The chimera: parts of every body plan on one genome.
      eyes = Math.max(6, Math.min(8, eyes >= 6 ? eyes : 6 + r.int(0, 2)));
      mouths = 2;
      heads = r.chance(0.35) ? 2 : 1;
      wingPairs = 2 + (r.chance(0.4) ? 1 : 0);
      armPairs = 2 + (r.chance(0.35) ? 1 : 0);
      if (kind === "serpent") legPairs = Math.max(1, Math.min(2, legPairs || 1));
      else if (kind === "hexapod") legPairs = 3 + (r.chance(0.4) ? 1 : 0);
      else if (kind === "blob") legPairs = 0;
      else if (legPairs === 0) legPairs = kind === "quadruped" ? 2 : 1;
      tentacles = Math.max(tentacles, 4 + r.int(0, 8));
      fingers = 5 + r.int(0, 2);
      tails = 1 + r.int(0, 2);
      if (colossal) {
        tentacles = Math.max(6, tentacles);
        eyes = Math.max(6, eyes);
      }
      break;
    }
  }
  return {
    eyes: clamp(eyes, 1, 8),
    mouths: clamp(mouths, 1, 2),
    heads: clamp(heads, 1, 2),
    wingPairs: clamp(wingPairs, 0, 3),
    armPairs: clamp(armPairs, 0, 3),
    legPairs: clamp(legPairs, 0, 4),
    tentacles: clamp(tentacles, 0, 12),
    fingers: clamp(fingers, 0, 7),
    tails: clamp(tails, 0, 3),
  };
}

// ------------------------------------------------------------------ the profile
const ONE_IN: Record<ComplexityTier, number> = Object.fromEntries(
  COMPLEXITY_TIERS.map((t) => [t, Math.round(1 / TIER_ODDS[t])]),
) as Record<ComplexityTier, number>;

/** The complexity profile of a genome (nature only: the same genome always gives the same profile). */
export function complexityOf(g: Genome): ComplexityProfile {
  const raw = complexityRaw(g);
  const tier = tierOfRaw(raw, g.kind);
  const colossal = tier === "mythic" && g.kind !== "blob" && raw >= T_COLOSSAL;
  const score = Math.round(1000 / (1 + Math.exp(-1.702 * (raw - RAW_MU) / RAW_SD))) / 1000;
  return {
    score,
    tier,
    oneIn: colossal ? Math.round(1 / COLOSSAL_ODDS) : ONE_IN[tier],
    counts: countsOf(g, tier, colossal),
    colossal,
    colors: tier === "minimal" ? 2 : 3,
  };
}

/** Rank 0 (minimal) .. 5 (mythic) of a tier. */
export function tierRank(t: ComplexityTier): number {
  return TIER_RANK[t];
}

/** One short line for the Lab / sheet ("Complexity: minimal globe, 1 in 15 - 1 eye, 2 colours, no limbs"). */
export function describeComplexity(p: ComplexityProfile): string {
  const c = p.counts;
  if (p.tier === "minimal") return `Complexity: minimal globe (1 in ${p.oneIn}): 1 eye, 2 colours, no limbs, no tail`;
  const bits = [`${c.eyes} eye${c.eyes === 1 ? "" : "s"}`];
  if (c.mouths > 1) bits.push(`${c.mouths} mouths`);
  if (c.heads > 1) bits.push(`${c.heads} heads`);
  if (c.wingPairs) bits.push(`${c.wingPairs} wing pair${c.wingPairs > 1 ? "s" : ""}`);
  if (c.armPairs) bits.push(`${c.armPairs} arm pair${c.armPairs > 1 ? "s" : ""}`);
  if (c.legPairs) bits.push(`${c.legPairs} leg pair${c.legPairs > 1 ? "s" : ""}`);
  if (c.tentacles) bits.push(`${c.tentacles} tentacles`);
  if (c.fingers) bits.push(`${c.fingers} fingers`);
  if (c.tails) bits.push(`${c.tails} tail${c.tails > 1 ? "s" : ""}`);
  const name = p.colossal ? "mythic COLOSSUS" : p.tier;
  return `Complexity: ${name} (1 in ${p.oneIn}, score ${p.score.toFixed(2)}): ${bits.join(", ")}`;
}
