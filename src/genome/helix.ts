/**
 * The morph helix [SPEC P4-V2, P4-V3]: every visible or animated trait is carried by a MIN gene and a
 * MAX gene, and one equation bounds the expressed value between them.
 *
 * THE BOUNDING EQUATION
 *
 *     lo = min(a0, a1)          hi = max(a0, a1)                (the two alleles of the gene pair)
 *     s(t) = t * t * (3 - 2 t)                                   (smoothstep, t = clamp01(drive))
 *     boundTrait(pair, drive) = lo + (hi - lo) * s(drive)
 *     physical value = R0 + (R1 - R0) * boundTrait(pair, drive)  (R0..R1 = the trait's physical range)
 *
 * lo <= hi is ENFORCED at expression time (a raw pair passed with lo > hi is swapped), so a trait can
 * never leave the band its genes allow, whatever the drive asks for. `drive` (0..1) is what the
 * phenotype or the moment asks for (temper, growth, a move's power...): top-down, the seeds give the
 * alleles, the phenotype gives the drive, the equation gives the monster.
 *
 * ANIMATION ENVELOPES: each channel has an absolute range (`channelRange`), the phenotype narrows it to
 * a creature window [W0, W1] (tempo and elasticity widen it, a big body narrows it, avian wing flap is
 * floored at 0.6 rad), and the gene pair maps into that window:
 *
 *     lo = W0 + (W1 - W0) * 0.6 * min(a0, a1)       hi = W0 + (W1 - W0) * (0.4 + 0.6 * max(a0, a1))
 *
 * (the min gene spans the lower 60 % of the window, the max gene the upper 60 %, so lo <= hi always and
 * no creature is ever frozen). The animator calls `boundTrait(helix.anim[ch], drive)`.
 *
 * DISCRETE TRAITS (eye style, teeth kind): weights come from the phenotype, the leading allele a0 is
 * the categorical roll (heritable: a child carries one parental allele in a0 half of the time).
 * RARE TRAITS (asymmetry, 1 / 3-4 eyes) are recessive: both alleles must pass a threshold.
 *
 * Legacy genomes (no `morph`) get a deterministic helix from `deriveMorph` (seeded by the genome id
 * and its plan genes). The genome id never hashes the morph genes. Pure module: Rng/hashSeed only.
 *
 * PASS 5 [P5-V2..V7]: `helixOf` also fills `p5` (eyes 1..8 with layout / height / spread / yaw / tilt /
 * socket / outline, beaks and mouth scale / tongue / lips, the growth envelope, shoulders / tails /
 * fractal arms / limb style / curvature / morph operators, the coat). Every field comes from a `p5.*`
 * allele pair (P5_MORPH_GENES, appended after the pass-4 genes) expressed through the same equation,
 * the same categorical lead-allele rolls and the same recessive gates. Elements shape the parts
 * (water curves, earth / metal / ice angular, fire flame tails, plant leaves) while the colour code is
 * untouched. `EyeGenes.count` mirrors `p5.eyes.count` (one number, 1..8).
 *
 * PASS 6 [P6-C1, P6-N1]: `helixOf` fills `p6 = { version: 6, complexity: complexityOf(g) }` and the p5 genes
 * OBEY its body counts: eye count = counts.eyes, wings present <=> counts.wingPairs > 0, limb style
 * "tentacles" <=> counts.tentacles > 0, serpent legs = counts.legPairs, digits = counts.fingers (a minimal
 * globe: one eye, no wings, no limbs, no digits). Then life bends the expressed traits: `ph.nurture?.shift`
 * (src/genome/structure.ts nurtureOf, optional) multiplies wing span (fin span for fin wings), tail length,
 * fin tail tips, shoulder width, eye size, armour plates and fur - nature first, nurture bends (each factor
 * is capped at +-NURTURE_CAP by its producer, and every bent value is clamped to its physical range).
 */
import {
  ANIM_CHANNELS,
  type AnimChannel,
  type AsymPart,
  type BeakKind,
  type BodyP5,
  type BoundTrait,
  type CoatKind,
  type EyeAura,
  type EyeLayout,
  type EyeP5,
  type EyeShape,
  type EyeGenes,
  type EyeStyle,
  type GenePair,
  type GrowthGenes,
  type LimbStyle,
  type MorphHelix,
  type MorphOp,
  type MorphP5,
  type MorphRegion,
  type MouthGenes,
  type MouthP5,
  type PupilFill,
  type SkinP5,
  type SurfaceGenes,
  type TailShape,
  type TeethKind,
  type WingGenes,
  type WingKind,
} from "./morphTypes.ts";
import { type ElementId, ELEMENTS } from "../data/elements.ts";
import { clamp, clamp01, u01 } from "../core/math.ts";
import { hashSeed, Rng } from "../core/rng.ts";
import type { Genome, PlanGene } from "./genome.ts";
import type { Phenotype } from "./phenotype.ts";
import type { BodyCounts, NurtureTrait } from "./p6Types.ts";
import { complexityOf, describeComplexity } from "./complexity.ts";
import { P7_MORPH_GENES, p7Of, type P7GeneId } from "./helix7.ts";
import type { MorphP7 } from "./p7Types.ts";
import { paretoRemap } from "./pareto.ts";
import { PARETO_CALIB } from "../data/paretoCalib.ts";

// ------------------------------------------------------------------ genes
/** Pass-4 genes (the order is frozen: `deriveMorph` draws them first, so legacy derivations never move). */
export const P4_MORPH_GENES = [
  "asymmetry",
  "fractal",
  "digits",
  "claw",
  "eyeStyle",
  "eyeSize",
  "eyeCount",
  "eyeGlow",
  "eyeAura",
  "sclera",
  "lid",
  "mouthWidth",
  "teeth",
  "toothLength",
  "wingSpan",
  "wingFingers",
  "wingDetail",
  "bump",
  "patternScale",
  "patternContrast",
  "plates",
  "sheen",
  "fur",
  "fusion",
  "angularity",
  "anim.breath",
  "anim.gait",
  "anim.tail",
  "anim.wingFlap",
  "anim.headBob",
  "anim.windup",
  "anim.strike",
  "anim.recoil",
  "anim.squash",
] as const;
/**
 * Pass-5 genes [P5-V2..V7]: eyes 1..8 and their outlines, beaks / mouth scale / tongue / lips, the growth
 * envelope, body plan details (shoulders, tails, fractal arms, limb style, curvature, morph operators)
 * and the coat. Appended AFTER the pass-4 list: a genome stored with only pass-4 alleles keeps them, and
 * the missing pass-5 alleles are filled deterministically from its id (`ensureMorph`).
 */
export const P5_MORPH_GENES = [
  "p5.eyeMany",
  "p5.eyeShape",
  "p5.eyeLayout",
  "p5.eyeHeight",
  "p5.eyeSpread",
  "p5.eyeYaw",
  "p5.eyeTilt",
  "p5.socket",
  "p5.eyeScaleX",
  "p5.eyeScaleY",
  "p5.eyeScaleZ",
  "p5.brow",
  "p5.beak",
  "p5.beakLength",
  "p5.beakRound",
  "p5.mouthScaleX",
  "p5.mouthScaleY",
  "p5.mouthScaleZ",
  "p5.mouthHeight",
  "p5.tongue",
  "p5.tongueFork",
  "p5.lip",
  "p5.growLength",
  "p5.growStrength",
  "p5.growAngle",
  "p5.spiral",
  "p5.neoteny",
  "p5.shoulderW",
  "p5.shoulderH",
  "p5.hump",
  "p5.tailShape",
  "p5.tailLength",
  "p5.tailCurl",
  "p5.tailTip",
  "p5.armMode",
  "p5.armDepth",
  "p5.armBranch",
  "p5.armRatio",
  "p5.armTwist",
  "p5.limbStyle",
  "p5.serpentLegs",
  "p5.limbVariation",
  "p5.curvature",
  "p5.ops",
  "p5.coat",
  "p5.belly",
  "p5.frills",
  "p5.stripes",
  "p5.celBands",
  "p5.outline",
  "p5.overlays",
] as const;
/** Pass-7 genes [P7-G1] (src/genome/helix7.ts) are appended last, after the pass-5 list. */
export const MORPH_GENES = [...P4_MORPH_GENES, ...P5_MORPH_GENES, ...P7_MORPH_GENES] as const;
export type MorphGeneId = typeof MORPH_GENES[number];
/** Allele pairs in [0, 1]; for bounded traits a0/a1 are the min and the max gene (order-free). */
export type MorphAlleles = Record<MorphGeneId, [number, number]>;

/** The gene pair that bounds an animation channel. */
export function animGene(ch: AnimChannel): MorphGeneId {
  return `anim.${ch}` as MorphGeneId;
}

/** Plan gene that seeds a morph gene in `deriveMorph` (the helix grows from the body plan). */
const PLAN_SEED: Partial<Record<MorphGeneId, PlanGene>> = {
  fractal: "quality",
  claw: "spikes",
  eyeSize: "eyes",
  mouthWidth: "jaw",
  toothLength: "jaw",
  wingSpan: "wings",
  wingDetail: "quality",
  plates: "spikes",
  "anim.tail": "tail",
  "p5.tailLength": "tail",
  "p5.mouthScaleX": "jaw",
  "p5.shoulderW": "girth",
};

// ------------------------------------------------------------------ the equation
const smooth01 = (t: number): number => t * t * (3 - 2 * t);
const r3 = (v: number): number => Math.round(v * 1000) / 1000;

/** The bounding equation: lo + (hi - lo) * smoothstep(clamp01(drive)); lo > hi is normalised (swapped). */
export function boundTrait(pair: GenePair, drive: number): number {
  const lo = Math.min(pair.lo, pair.hi), hi = Math.max(pair.lo, pair.hi);
  const t = clamp01(Number.isFinite(drive) ? drive : 0.5);
  return lo + (hi - lo) * smooth01(t);
}

/** An allele pair as a min/max gene pair. */
export function genePair(a: readonly [number, number]): GenePair {
  return { lo: Math.min(a[0], a[1]), hi: Math.max(a[0], a[1]) };
}

/**
 * Pareto layer [P7-D1]: the calibration probe (tools/pareto.ts records every RAW normalised expression by
 * key) and the rank collector of the helix being expressed (its signature traits). Both are null outside
 * those two synchronous windows.
 */
export const PARETO_PROBE: { log: ((key: string, raw: number) => void) | null } = { log: null };
let rankSink: Map<string, number> | null = null;

/** Raw normalised value v (0..1) of `key` -> Pareto-remapped value (identity when the key is uncalibrated). */
function pareto(key: string, v: number): number {
  PARETO_PROBE.log?.(key, v);
  const r = paretoRemap(PARETO_CALIB[key], v);
  if (rankSink && PARETO_CALIB[key]) {
    const prev = rankSink.get(key);
    if (prev === undefined || Math.abs(r.rank - 0.5) > Math.abs(prev - 0.5)) rankSink.set(key, r.rank);
  }
  return r.value;
}

/**
 * Physical value of a bounded trait: R0 + (R1 - R0) * pareto(boundTrait(pair, drive)). The bounding equation
 * gives the raw value inside the gene band; the Pareto remap [P7-D1] shapes the population (median kept,
 * bounds reached, 20 % of creatures carry 80 % of the deviation).
 */
function trait(m: MorphAlleles, gene: MorphGeneId, drive: number, r0 = 0, r1 = 1): number {
  return r0 + (r1 - r0) * pareto(gene, boundTrait(genePair(m[gene]), drive));
}

/** A gene pair whose two alleles are each Pareto-remapped by the same monotone map (keeps lo <= hi). */
function paretoPair(m: MorphAlleles, gene: MorphGeneId): GenePair {
  const p = genePair(m[gene]);
  return { lo: pareto(`${gene}#allele`, p.lo), hi: pareto(`${gene}#allele`, p.hi) };
}

const CHANNEL_RANGE: Record<AnimChannel, readonly [number, number]> = {
  breath: [0.01, 0.12], // chest scale fraction
  gait: [0.15, 1.0], // leg / body swing, rad
  tail: [0.05, 0.9], // rad
  wingFlap: [0.3, 1.6], // rad
  headBob: [0.02, 0.4], // rad
  windup: [0.1, 1.2], // rad
  strike: [0.2, 1.6], // rad
  recoil: [0.05, 0.8], // rad
  squash: [0, 0.35], // scale fraction
};
export const CHANNEL_UNIT: Record<AnimChannel, "rad" | "fraction"> = {
  breath: "fraction",
  gait: "rad",
  tail: "rad",
  wingFlap: "rad",
  headBob: "rad",
  windup: "rad",
  strike: "rad",
  recoil: "rad",
  squash: "fraction",
};

/** Declared absolute [min, max] of an animation channel (radians for joint motion, fraction for breath/squash). */
export function channelRange(ch: AnimChannel): [number, number] {
  const r = CHANNEL_RANGE[ch];
  return [r[0], r[1]];
}

// ------------------------------------------------------------------ alleles
function validPair(p: unknown): p is [number, number] {
  return Array.isArray(p) && p.length === 2 &&
    p.every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1);
}

/** Deterministic alleles for a genome without stored morph genes (legacy saves, wild spawns). */
export function deriveMorph(g: Genome): MorphAlleles {
  const rng = new Rng(hashSeed(g.id, "helix"));
  const out = {} as MorphAlleles;
  for (const id of MORPH_GENES) {
    const plan = PLAN_SEED[id];
    if (plan) {
      const p = g.plan[plan];
      out[id] = [clamp01(rng.normal(p[0], 0.15)), clamp01(rng.normal(p[1], 0.15))];
    } else out[id] = [rng.next(), rng.next()];
  }
  return out;
}

/**
 * The genome's stored morph alleles when present and valid, else the deterministic derivation.
 * A stored morph whose PASS-4 genes are all valid is kept; any missing / invalid PASS-5 gene is filled
 * from `deriveMorph` (seeded by the genome id), so a pass-4 save keeps its look and gains stable pass-5
 * genes. A stored morph with an invalid pass-4 gene is rejected as a whole (as before).
 */
export function ensureMorph(g: Genome): MorphAlleles {
  const m = (g as Genome & { morph?: unknown }).morph;
  if (!m || typeof m !== "object") return deriveMorph(g);
  const o = m as Record<string, unknown>;
  if (!P4_MORPH_GENES.every((id) => validPair(o[id]))) return deriveMorph(g);
  if (MORPH_GENES.every((id) => validPair(o[id]))) return m as MorphAlleles;
  const d = deriveMorph(g);
  const out = {} as MorphAlleles;
  for (const id of MORPH_GENES) {
    const p = o[id];
    out[id] = validPair(p) ? [p[0], p[1]] : d[id];
  }
  return out;
}

/** Mendelian inheritance: one allele from each parent per gene, then a small clamped normal jitter. */
export function inheritMorph(a: Genome, b: Genome, rng: Rng, mutationRate = 0.04): MorphAlleles {
  const ma = ensureMorph(a), mb = ensureMorph(b);
  const out = {} as MorphAlleles;
  for (const id of MORPH_GENES) {
    let x = rng.pick(ma[id]), y = rng.pick(mb[id]);
    if (rng.chance(mutationRate)) x = clamp01(x + rng.normal(0, 0.1));
    if (rng.chance(mutationRate)) y = clamp01(y + rng.normal(0, 0.1));
    out[id] = rng.chance(0.5) ? [x, y] : [y, x];
  }
  return out;
}

// ------------------------------------------------------------------ expression helpers
/** Weighted pick driven by a roll u in [0, 1) instead of an Rng draw. */
function pickBy<T>(items: readonly T[], weights: readonly number[], u: number): T {
  let total = 0;
  for (const w of weights) total += Math.max(0, w);
  let r = clamp(u, 0, 0.999999) * total;
  for (let i = 0; i < items.length; i++) {
    r -= Math.max(0, weights[i]);
    if (r < 0) return items[i];
  }
  return items[items.length - 1];
}

function mixHex(a: number, b: number, t: number): number {
  const ch = (c: number, s: number) => (c >> s) & 255;
  const m = (s: number) => Math.round(ch(a, s) + (ch(b, s) - ch(a, s)) * clamp01(t));
  return (m(16) << 16) | (m(8) << 8) | m(0);
}

const DARK_ELS: ElementId[] = ["shadow", "void"];
const WHITE_SCLERA = 0xf4f4ef;
const BLACK_SCLERA = 0x121118;

const EYE_STYLES: readonly EyeStyle[] = [
  "round",
  "sparkle",
  "ring",
  "blank",
  "slit",
  "sharp",
  "sleepy",
  "compound",
];
const PUPIL: Record<EyeStyle, PupilFill> = {
  round: "full",
  sparkle: "star",
  ring: "hollow",
  blank: "none",
  slit: "slit",
  sharp: "full",
  sleepy: "full",
  compound: "none",
};

/**
 * Eye count 1..8 [P5-V4, P6-C1]: `count` = complexityOf(g).counts.eyes. The pass-5 rule lives on in
 * complexity.ts, evaluated on the genome: RECESSIVE both ways, a cyclops needs BOTH eyeCount alleles low
 * (hi < 0.245), extra eyes need BOTH alleles high (lo > ~0.66; hexapods, wise and psychic / void genomes
 * lower the bar), how many (3..8) is the p5.eyeMany lead allele; then the tier caps it (a minimal globe has
 * ONE eye, a simple body at most 3) or raises it (a mythic chimera has 6-8).
 */
function eyesOf(m: MorphAlleles, ph: Phenotype, count: number): EyeGenes {
  const a = ph.axes, prim = ph.elements.primary, sec = ph.elements.secondary;
  const pos = (v: number) => Math.max(0, v);
  const dark = DARK_ELS.includes(prim);
  const w = [
    1.0 + 0.6 * u01(a.mood), // round
    0.25 + 2.0 * pos(a.luminance) * u01(a.mood) + 0.6 * pos(a.wisdom) + (prim === "light" ? 0.6 : 0), // sparkle
    0.2 + 0.9 * pos(a.wisdom) + (dark ? 0.9 : 0) + (prim === "psychic" ? 0.6 : 0), // ring
    0.12 + 1.4 * pos(a.temper - 0.3) + (dark ? 0.9 : 0), // blank
    0.25 + (ph.kind === "serpent" ? 2.2 : 0) + 2.0 * pos(Math.min(a.moisture, a.heat)) + 0.4 * pos(a.focus), // slit
    0.25 + 1.4 * pos(a.temper), // sharp
    0.12 + 1.6 * Math.sqrt(pos(-a.tempo) * pos(-a.mood)) + 0.3 * pos(-a.tempo), // sleepy
    ph.kind === "hexapod" ? 3.2 : 0.02, // compound
  ];
  const style = pickBy(EYE_STYLES, w, m.eyeStyle[0]);
  const sizeDrive = 0.45 * ph.plan.eyes + 0.3 * (1 - u01(a.stature)) + 0.15 * u01(a.mood) +
    (style === "sparkle" || style === "compound" ? 0.15 : 0);
  const size = clamp(trait(m, "eyeSize", sizeDrive, 0.12, 0.45) * (count > 2 ? 0.8 : 1), 0.12, 0.45);
  // Sclera: white is the norm; dark creatures sometimes have black sclera, very rarely a tinted one.
  const s = genePair(m.sclera);
  const scleraColor = dark && s.lo > 0.55
    ? BLACK_SCLERA
    : s.lo > 0.94
    ? mixHex(WHITE_SCLERA, ELEMENTS[prim].color, 0.45)
    : WHITE_SCLERA;
  let irisColor = prim === "neutral" ? ph.palette.eye : ELEMENTS[prim].color;
  if (scleraColor === BLACK_SCLERA || prim === "void") irisColor = ELEMENTS[prim].core;
  if (sec && sec !== "neutral") {
    irisColor = mixHex(irisColor, ELEMENTS[sec].color, 0.3 * ph.elements.secondaryLevel);
  }
  const glow = trait(m, "eyeGlow", 0.6 * ph.glow + 0.4 * pos(a.luminance), 0, 1);
  // Aura: the phenotype proposes a candidate and its intensity, the gene pair decides if it shows.
  let aura: EyeAura = "none", intensity = 0;
  if (dark) [aura, intensity] = ["smoke", 0.5 + 0.5 * pos(a.temper)];
  else if (prim === "fire" && a.temper > 0.25) [aura, intensity] = ["flame", 0.5 + 0.5 * a.temper];
  else if (a.temper > 0.62) [aura, intensity] = ["smoke", a.temper];
  else if (prim === "electric") [aura, intensity] = ["spark", 0.3 + 0.5 * u01(a.conductivity)];
  else if (prim === "ice") [aura, intensity] = ["frost", 0.3 + 0.5 * pos(-a.heat)];
  else if (a.mood < -0.5) [aura, intensity] = ["tears", -a.mood];
  if (aura !== "none" && trait(m, "eyeAura", intensity) < 0.55) aura = "none";
  let lidAngle = trait(
    m,
    "lid",
    0.5 + 0.4 * a.temper - 0.9 * ph.psyche.emotions.sadness - 0.15 * pos(-a.tempo),
    -0.45,
    0.45,
  );
  if (style === "sharp") lidAngle = Math.max(lidAngle, 0.15);
  if (style === "sleepy") lidAngle = Math.min(lidAngle, -0.15);
  return {
    style,
    pupil: PUPIL[style],
    size: r3(size),
    count,
    irisColor,
    scleraColor,
    glow: r3(glow),
    aura,
    lidAngle: r3(lidAngle),
  };
}

const TEETH: readonly TeethKind[] = ["none", "fangs", "tusks", "saw", "needles", "beak", "molars"];
const TOOTH_COUNT: Record<TeethKind, [number, number]> = {
  none: [0, 0],
  beak: [0, 0],
  fangs: [2, 8],
  tusks: [1, 2],
  saw: [6, 12],
  needles: [6, 12],
  molars: [3, 8],
};
const TOOTH_LEN: Record<TeethKind, [number, number]> = {
  none: [0, 0],
  beak: [0, 0],
  fangs: [0.18, 0.5],
  tusks: [0.35, 0.6],
  saw: [0.08, 0.22],
  needles: [0.1, 0.28],
  molars: [0.04, 0.1],
};

function mouthOf(m: MorphAlleles, ph: Phenotype): MouthGenes {
  const a = ph.axes, prim = ph.elements.primary, kind = ph.kind;
  const pos = (v: number) => Math.max(0, v);
  const big = ph.sizeClass === "L" || ph.sizeClass === "XL" || ph.sizeClass === "XXL";
  const w = [
    kind === "blob" ? 3.0 : 0.12, // none
    0.3 + 1.2 * pos(a.temper) + 0.8 * ph.plan.jaw, // fangs
    (kind === "quadruped" && big ? 1.5 : 0.04) + (prim === "earth" ? (kind === "quadruped" ? 1.0 : 0.3) : 0), // tusks
    0.1 + 2.0 * pos(a.moisture) * pos(a.temper) + (prim === "water" && a.temper > 0 ? 0.8 : 0), // saw
    (kind === "serpent" ? 1.6 : 0.08) + (prim === "poison" ? 1.2 : 0), // needles
    kind === "avian" ? 8 : 0, // beak (birds only)
    0.2 + ((prim === "plant" || prim === "neutral") ? (a.temper < 0 ? 1.4 : 0.6) : 0), // molars
  ];
  const teeth = pickBy(TEETH, w, m.teeth[0]);
  const [c0, c1] = TOOTH_COUNT[teeth];
  const teethCount = Math.round(trait(m, "teeth", ph.plan.jaw, c0, c1));
  const [l0, l1] = TOOTH_LEN[teeth];
  const toothLength = trait(
    m,
    "toothLength",
    0.5 * u01(a.temper) + 0.3 * u01(a.might) + 0.2 * ph.plan.jaw,
    l0,
    l1,
  );
  const width = trait(m, "mouthWidth", 0.65 * ph.plan.jaw + 0.35 * ph.plan.head, 0.3, 1);
  const tongue = kind === "serpent" || prim === "poison" || (width >= 0.7 && a.mood > 0.15);
  return { width: r3(width), teeth, teethCount, toothLength: r3(toothLength), tongue };
}

const FINGERS: Record<WingKind, [number, number]> = {
  none: [0, 0],
  feather: [3, 5],
  membrane: [2, 5],
  insect: [0, 2],
  fin: [1, 4],
};

/** Wings [P4, P6-C1]: present iff the body counts carry a wing pair (avian, plan.wings >= 0.45, or a chimera). */
function wingsOf(m: MorphAlleles, ph: Phenotype, fractalDepth: number, hasWings: boolean): WingGenes {
  const a = ph.axes, prim = ph.elements.primary, kind = ph.kind;
  let wk: WingKind = "none";
  if (!hasWings) wk = "none";
  else if (kind === "avian") wk = "feather";
  else {
    if (kind === "hexapod") wk = "insect";
    else if (kind === "serpent" && (prim === "water" || a.moisture > 0.25)) wk = "fin";
    else if ((["fire", "shadow", "void", "earth"] as ElementId[]).includes(prim)) wk = "membrane";
    else if ((["air", "light", "psychic"] as ElementId[]).includes(prim)) wk = "feather";
    else wk = "membrane";
  }
  if (wk === "none") return { kind: "none", span: 0, fingers: 0, detail: 0 };
  const [s0, s1] = kind === "avian" ? [2.0, 3.2] : ph.abilities.fly ? [1.6, 2.6] : [1.2, 1.8];
  const span = trait(
    m,
    "wingSpan",
    0.5 * ph.plan.wings + 0.3 * u01(a.altitude) + 0.2 * (1 - u01(a.weight)),
    s0,
    s1,
  );
  const [f0, f1] = FINGERS[wk];
  const fingers = Math.round(trait(m, "wingFingers", fractalDepth / 3, f0, f1));
  const detail = trait(m, "wingDetail", 0.4 * fractalDepth / 3 + 0.3 * ph.plan.quality + 0.3 * ph.growth);
  return { kind: wk, span: r3(span), fingers, detail: r3(detail) };
}

function surfaceOf(m: MorphAlleles, ph: Phenotype, fractalDepth: number): SurfaceGenes {
  const a = ph.axes;
  const hard = u01(a.hardness), wet = u01(a.moisture);
  const bump = trait(m, "bump", 0.5 * hard + 0.3 * ph.roughness + 0.2 * fractalDepth / 3);
  const patternScale = trait(m, "patternScale", 0.6 * (1 - u01(a.stature)) + 0.4 * ph.plan.segments, 0.5, 2);
  const contrast =
    trait(m, "patternContrast", 0.5 * Math.abs(a.luminance) + 0.5 * (ph.elements.secondary ? 1 : 0.3)) *
    (ph.pattern === "solid" ? 0.3 : 1);
  const plates = a.hardness < -0.25 ? 0 : trait(m, "plates", hard + (ph.pattern === "scales" ? 0.25 : 0));
  const sheen = trait(m, "sheen", 0.45 * hard + 0.45 * wet + 0.1 * u01(a.conductivity));
  const fur = a.moisture > 0.4 || a.hardness > 0.4
    ? 0
    : trait(m, "fur", 0.6 * ph.elasticity + 0.4 * (1 - hard));
  return {
    bump: r3(bump),
    patternScale: r3(patternScale),
    patternContrast: r3(contrast),
    plates: r3(plates),
    sheen: r3(sheen),
    fur: r3(fur),
  };
}

function animOf(m: MorphAlleles, ph: Phenotype, wings: WingKind): Record<AnimChannel, BoundTrait> {
  const a = ph.axes, size01 = u01(a.stature);
  // Window width: tempo and elasticity widen it, a big body narrows it.
  const w = clamp(0.55 + 0.25 * a.tempo + 0.3 * (ph.elasticity - 0.5) - 0.3 * (size01 - 0.5), 0.25, 1);
  const out = {} as Record<AnimChannel, BoundTrait>;
  for (const ch of ANIM_CHANNELS) {
    const [A0, A1] = CHANNEL_RANGE[ch];
    let W0 = A0, W1 = A0 + (A1 - A0) * w;
    if (ch === "squash") {
      const ws = clamp(
        0.2 + 0.6 * ph.elasticity + (ph.kind === "blob" ? 0.3 : 0) + 0.15 * Math.max(0, a.form),
        0.15,
        1,
      );
      W1 = A0 + (A1 - A0) * ws;
    } else if (ch === "tail") W1 = A0 + (A1 - A0) * w * (0.6 + 0.4 * ph.plan.tail);
    else if (ch === "wingFlap") {
      if (ph.kind === "avian") [W0, W1] = [0.6, 0.6 + 0.9 * clamp(w + 0.25, 0.45, 1)];
      else if (wings === "none") W1 = A0 + 0.3 * w;
      else if (ph.abilities.fly) W1 = A0 + (A1 - A0) * clamp(w + 0.15, 0.4, 1);
    }
    const p = paretoPair(m, animGene(ch));
    const lo = r3(W0 + (W1 - W0) * 0.6 * p.lo);
    const hi = r3(W0 + (W1 - W0) * (0.4 + 0.6 * p.hi));
    out[ch] = { lo, hi, value: r3(boundTrait({ lo, hi }, 0.5)) };
  }
  return out;
}

const ASYM_PARTS: readonly AsymPart[] = ["horn", "ear", "eye", "wing", "claw", "tail", "pattern"];


// ------------------------------------------------------------------ pass 5 [P5-V2..V7]
/** Element curvature signature: + flowing curves (water, air, psychic), - angular facets (earth, metal, ice). */
const CURVE: Record<ElementId, number> = {
  neutral: 0,
  fire: 0.15,
  water: 0.75,
  plant: 0.25,
  earth: -0.65,
  air: 0.6,
  electric: -0.3,
  ice: -0.5,
  metal: -0.8,
  poison: 0.3,
  light: 0.2,
  shadow: 0,
  psychic: 0.55,
  void: 0.1,
};

/** Physical value of a gene pair mapped into a creature window [W0, W1] (min gene low 60 %, max gene high 60 %). */
function band(m: MorphAlleles, gene: MorphGeneId, w0: number, w1: number): GenePair {
  const p = paretoPair(m, gene);
  return { lo: r3(w0 + (w1 - w0) * 0.6 * p.lo), hi: r3(w0 + (w1 - w0) * (0.4 + 0.6 * p.hi)) };
}

/** Recessive gate: both alleles above `t`; returns how far above (0..1) or -1 when closed. */
function recessive(m: MorphAlleles, gene: MorphGeneId, t: number): number {
  const p = genePair(m[gene]);
  if (p.lo <= t) return -1;
  return clamp01((p.lo - t) / Math.max(1e-6, 1 - t));
}

const EYE_SHAPES: readonly EyeShape[] = ["round", "almond", "tear", "crescent", "hooded", "diamond", "oval"];
const LAYOUTS_MANY: readonly EyeLayout[] = ["row", "arc", "cluster", "stacked"];

function eyesP5(m: MorphAlleles, ph: Phenotype, e: EyeGenes): EyeP5 {
  const a = ph.axes, prim = ph.elements.primary, st = e.style;
  const pos = (v: number) => Math.max(0, v);
  const hard = prim === "metal" || prim === "ice" || prim === "earth";
  const shape: EyeShape = st === "compound" ? "round" : pickBy(EYE_SHAPES, [
    1.2 + (st === "round" || st === "sparkle" ? 2.0 : 0) + 0.5 * u01(a.mood), // round
    0.6 + (st === "sharp" || st === "slit" ? 2.0 : 0) + 0.5 * pos(a.focus), // almond
    0.15 + 1.6 * pos(-a.mood) + (e.aura === "tears" ? 1.5 : 0), // tear
    0.12 + 1.2 * pos(a.mood - 0.4) + (prim === "psychic" || prim === "shadow" || prim === "void" ? 0.4 : 0), // crescent
    0.2 + (st === "sleepy" ? 2.5 : 0) + 0.6 * pos(-a.tempo), // hooded
    0.1 + 1.2 * pos(a.hardness) * (hard ? 1 : 0.4) + (prim === "light" ? 0.3 : 0), // diamond
    0.8, // oval
  ], m["p5.eyeShape"][0]);
  const count = e.count;
  const layout: EyeLayout = count === 1 ? "cyclops" : count === 2 ? "pair" : pickBy(LAYOUTS_MANY, [
    1.0, // row
    1.0 + (prim === "psychic" || prim === "light" ? 0.8 : 0), // arc
    0.6 + (ph.kind === "hexapod" ? 2.5 : 0) + (count >= 6 ? 1.2 : 0), // cluster (spider)
    0.8 + (count <= 4 ? 0.8 : 0), // stacked
  ], m["p5.eyeLayout"][0]);
  // Predator (wild, mighty, focused): eyes close together and forward; prey: wide-set and side-facing.
  const predator = 0.5 * u01(a.temper) + 0.3 * u01(a.might) + 0.2 * u01(a.focus);
  const spread = trait(m, "p5.eyeSpread", 1 - predator + (ph.kind === "avian" ? 0.1 : 0));
  const yaw = trait(m, "p5.eyeYaw", spread, 0.05, 1.3);
  const height = trait(
    m,
    "p5.eyeHeight",
    0.45 + 0.25 * pos(a.moisture) + (ph.kind === "serpent" ? 0.15 : 0) - 0.15 * pos(-a.altitude),
    -0.5,
    0.9,
  );
  const tilt = trait(m, "p5.eyeTilt", 0.5 + 0.35 * a.temper - 0.4 * ph.psyche.emotions.sadness, -0.5, 0.5);
  const socketDepth = trait(m, "p5.socket", 0.4 * u01(a.hardness) + 0.3 * u01(a.wisdom) + 0.3 * (1 - u01(a.mood)));
  const sx = trait(m, "p5.eyeScaleX", 0.5 + (shape === "almond" || shape === "diamond" ? 0.25 : 0), 0.8, 1.3);
  const sy = trait(m, "p5.eyeScaleY", 0.5 - (shape === "hooded" || shape === "crescent" ? 0.2 : 0) + 0.2 * u01(a.mood) - 0.1, 0.75, 1.25);
  const sz = trait(m, "p5.eyeScaleZ", 0.4 + 0.4 * spread + (st === "compound" ? 0.2 : 0), 0.75, 1.35);
  const brow = trait(m, "p5.brow", 0.5 * u01(a.temper) + 0.3 * u01(a.might) + 0.2 * u01(a.hardness));
  return {
    shape,
    layout,
    count,
    height: r3(height),
    spread: r3(spread),
    yaw: r3(yaw),
    tilt: r3(tilt),
    socketDepth: r3(socketDepth),
    scale: [r3(sx), r3(sy), r3(sz)],
    brow: r3(brow),
  };
}

const BEAKS: readonly BeakKind[] = ["round", "hooked", "flat", "needle", "shovel"];
const BEAK_LEN: Record<BeakKind, [number, number]> = {
  none: [0, 0],
  round: [0.15, 0.45],
  hooked: [0.25, 0.55],
  flat: [0.3, 0.6],
  needle: [0.5, 0.9],
  shovel: [0.4, 0.75],
};
const BEAK_ROUND: Record<BeakKind, [number, number]> = {
  none: [0.5, 0.5],
  round: [0.6, 1],
  hooked: [0.3, 0.6],
  flat: [0.45, 0.75],
  needle: [0, 0.2],
  shovel: [0.5, 0.85],
};

function mouthP5(m: MorphAlleles, ph: Phenotype, mo: MouthGenes, eyes: EyeGenes, coat: CoatKind): MouthP5 {
  const a = ph.axes, prim = ph.elements.primary, kind = ph.kind;
  const pos = (v: number) => Math.max(0, v);
  const small = ph.sizeClass === "XS" || ph.sizeClass === "S";
  let beak: BeakKind = "none";
  if (mo.teeth === "beak") {
    beak = pickBy(BEAKS, [
      1.2 + (prim === "plant" || prim === "neutral" ? 1.5 : 0) + u01(a.mood) + (small ? 0.6 : 0), // round
      0.4 + 2.0 * pos(a.temper) + 1.0 * pos(a.might), // hooked
      0.2 + 2.5 * pos(a.moisture) + (prim === "water" ? 1.5 : 0), // flat
      0.2 + 1.5 * pos(a.focus) + 1.0 * pos(a.reach) + (small ? 0.5 : 0), // needle
      0.1 + 1.5 * pos(a.moisture) * u01(a.stature) + (prim === "water" ? 0.6 : 0), // shovel
    ], m["p5.beak"][0]);
  } else if ((mo.teeth === "none" || mo.teeth === "molars") && kind !== "blob" && kind !== "serpent") {
    // Rare, recessive non-avian beaks (turtle, platypus): both alleles high.
    const gate = recessive(m, "p5.beak", 0.9);
    if (gate >= 0) beak = pickBy(["hooked", "flat", "round", "shovel"] as const, [1, 1 + pos(a.moisture), 0.8, 0.4], gate);
  }
  const lenDrive = 0.5 * ph.plan.jaw + 0.3 * u01(a.reach) + 0.2 * u01(a.stature);
  const [l0, l1] = BEAK_LEN[beak];
  const beakLength = beak === "none" ? 0 : trait(m, "p5.beakLength", lenDrive, l0, l1);
  const [q0, q1] = BEAK_ROUND[beak];
  const beakRound = trait(m, "p5.beakRound", 0.5 * u01(a.mood) + 0.5 * (1 - u01(a.temper)), q0, q1);
  const sx = trait(m, "p5.mouthScaleX", 0.6 * ph.plan.jaw + 0.4 * mo.width, 0.75, 1.35);
  const sy = trait(m, "p5.mouthScaleY", 0.5 * u01(a.temper) + 0.5 * ph.plan.jaw, 0.7, 1.4);
  const sz = trait(m, "p5.mouthScaleZ", ph.plan.head, 0.75, 1.3);
  const height = trait(m, "p5.mouthHeight", 0.5 - (kind === "serpent" ? 0.15 : 0) + 0.1 * a.mood, -0.6, 0.6);
  const reptile = kind !== "avian" && kind !== "blob" &&
    (eyes.style === "slit" || ph.pattern === "scales" || coat === "scales");
  const tongueLength = !mo.tongue
    ? 0
    : trait(
      m,
      "p5.tongue",
      (kind === "serpent" ? 0.5 : 0) + 0.3 * u01(a.appetite) + 0.2 * u01(a.reach),
      0.25,
      1.2,
    );
  const fork = genePair(m["p5.tongueFork"]);
  const tongueFork = tongueLength > 0 &&
    (kind === "serpent" ? fork.hi > 0.2 : reptile ? fork.lo > 0.5 : fork.lo > 0.93);
  const lipCurve = trait(m, "p5.lip", 0.5 + 0.4 * a.mood - 0.3 * pos(a.temper) - 0.3 * ph.psyche.emotions.sadness, -1, 1);
  return {
    beak,
    beakLength: r3(beakLength),
    beakRound: r3(beakRound),
    scale: [r3(sx), r3(sy), r3(sz)],
    height: r3(height),
    tongueLength: r3(tongueLength),
    tongueFork,
    lipCurve: r3(lipCurve),
  };
}

function growthP5(m: MorphAlleles, ph: Phenotype, curvature: number): GrowthGenes {
  const a = ph.axes;
  const ang = paretoPair(m, "p5.growAngle");
  const A = 0.08 + 0.3 * ph.elasticity + 0.1 * Math.max(0, curvature);
  return {
    length: band(m, "p5.growLength", 0.7, 1.35),
    strength: band(m, "p5.growStrength", 0.7 + 0.1 * u01(a.might), 1.35),
    angle: { lo: r3(-A * (0.4 + 0.6 * ang.lo)), hi: r3(A * (0.4 + 0.6 * ang.hi)) },
    spiral: r3(trait(
      m,
      "p5.spiral",
      (ph.kind === "serpent" ? 0.4 : 0) + 0.3 * u01(a.form) + 0.3 * ph.elasticity,
      0.6,
      1.6,
    )),
    neoteny: r3(trait(m, "p5.neoteny", 0.5 * u01(a.mood) + 0.3 * (1 - u01(a.stature)) + 0.2 * u01(a.sociality))),
  };
}

const TAILS: readonly TailShape[] = ["taper", "club", "fin", "fan", "spade", "whip", "flame", "leaf", "rattle", "split"];
const BIG_TIP: ReadonlySet<TailShape> = new Set(["club", "flame", "spade", "fan", "leaf"]);
type P5OpKind = "carve" | "merge" | "compress" | "decompress" | "difference" | "twist" | "bulge" | "pinch";
const OP_KINDS: readonly P5OpKind[] = ["carve", "merge", "compress", "decompress", "difference", "twist", "bulge", "pinch"];
const OP_SIGN: Record<P5OpKind, number> = {
  carve: -1,
  merge: 1,
  compress: -1,
  decompress: 1,
  difference: -1,
  twist: 1,
  bulge: 1,
  pinch: -1,
};

function bodyP5(m: MorphAlleles, ph: Phenotype, fractalDepth: number, chaos: number, counts: BodyCounts | null): BodyP5 {
  const a = ph.axes, prim = ph.elements.primary, sec = ph.elements.secondary, kind = ph.kind;
  const pos = (v: number) => Math.max(0, v);
  const has = (el: ElementId) => prim === el ? 1 : sec === el ? 0.5 * ph.elements.secondaryLevel : 0;
  // Curvature: element signature (primary + weighted secondary) + fluid / elastic / hard axes + a gene nudge.
  const curvature = clamp(
    CURVE[prim] + (sec ? 0.4 * ph.elements.secondaryLevel * CURVE[sec] : 0) + 0.2 * a.form +
      0.3 * (ph.elasticity - 0.5) - 0.15 * a.hardness + 0.5 * (trait(m, "p5.curvature", 0.5) - 0.5),
    -1,
    1,
  );
  const limbed = kind === "quadruped" || kind === "biped" || kind === "hexapod";
  const shoulder = {
    width: r3(trait(m, "p5.shoulderW", 0.5 * u01(a.might) + 0.3 * ph.plan.girth + (kind === "biped" ? 0.2 : 0), 0.8, 1.35)),
    height: r3(trait(m, "p5.shoulderH", 0.4 + 0.3 * u01(a.might) - 0.2 * u01(a.tempo) + 0.2 * u01(a.stature), 0.85, 1.2)),
    hump: 0,
  };
  const hg = recessive(m, "p5.hump", 0.65 - 0.2 * pos(a.weight) - 0.1 * pos(a.might));
  if (limbed && hg >= 0) shoulder.hump = r3(0.15 + 0.85 * hg);
  const big = ph.sizeClass === "L" || ph.sizeClass === "XL" || ph.sizeClass === "XXL";
  const shape = pickBy(TAILS, [
    1.0, // taper
    1.6 * (has("earth") + has("metal")) + 0.8 * pos(a.hardness) * pos(a.might) + (kind === "quadruped" && big ? 0.4 : 0), // club
    2.2 * has("water") + pos(a.moisture), // fin
    1.2 * has("air") + (kind === "avian" ? 2.0 : 0) + 0.4 * has("light"), // fan
    1.6 * (has("shadow") + has("void")) + 0.6 * has("ice") + 0.3, // spade
    0.4 + pos(a.tempo) + 0.6 * has("electric") + (kind === "serpent" ? 0.6 : 0), // whip
    3.0 * has("fire"), // flame
    3.0 * has("plant"), // leaf
    kind === "serpent" ? 0.6 + 1.4 * has("poison") : 0.3 * has("poison"), // rattle
    1.2 * has("electric") + 0.8 * has("psychic") + 0.15, // split
  ], m["p5.tailShape"][0]);
  const tail = {
    shape,
    length: r3(trait(m, "p5.tailLength", 0.6 * ph.plan.tail + (kind === "serpent" ? 0.4 : 0.12), 0.4, 1.8)),
    curl: r3(trait(m, "p5.tailCurl", 0.5 * clamp01(0.5 + curvature / 2) + 0.3 * ph.elasticity + 0.2 * u01(a.form))),
    tipSize: r3(trait(m, "p5.tailTip", (BIG_TIP.has(shape) ? 0.5 : 0) + 0.3 * u01(a.might) + 0.2 * ph.plan.tail, 0.5, 2)),
  };
  // Limb style: tentacles are rare and mostly blobs / serpents (recessive); fins for water bodies.
  // Pass 6: tentacles <=> counts.tentacles > 0 and serpent legs = counts.legPairs (the same recessive
  // rules, evaluated on the genome in complexity.ts); fins stay a phenotype call (a wet life can fin a body).
  const ls = genePair(m["p5.limbStyle"]);
  const wet = prim === "water" || prim === "poison" || a.moisture > 0.4;
  let limbStyle: LimbStyle = kind === "blob" ? "stumps" : "legs";
  let serpentLegs = 0;
  if (counts) {
    if (counts.tentacles > 0) limbStyle = "tentacles";
    else if ((prim === "water" || a.moisture > 0.55) && kind !== "avian" && kind !== "blob" && ls.hi < 0.5) limbStyle = "fins";
    serpentLegs = kind === "serpent" ? Math.min(2, counts.legPairs) : 0;
  } else {
    if (kind === "blob" && ls.lo > (wet ? 0.45 : 0.55)) limbStyle = "tentacles";
    else if (kind === "serpent" && ls.lo > (wet ? 0.72 : 0.8)) limbStyle = "tentacles";
    else if (kind !== "blob" && kind !== "serpent" && ls.lo > 0.95) limbStyle = "tentacles";
    else if ((prim === "water" || a.moisture > 0.55) && kind !== "avian" && kind !== "blob" && ls.hi < 0.5) limbStyle = "fins";
    const sl = recessive(m, "p5.serpentLegs", 0.72);
    serpentLegs = kind === "serpent" && limbStyle === "legs" && sl >= 0 ? (genePair(m["p5.serpentLegs"]).hi > 0.95 ? 2 : 1) : 0;
  }
  const lv = recessive(m, "p5.limbVariation", 0.78 - 0.15 * chaos);
  const limbVariation = lv >= 0 ? r3(0.03 + 0.22 * lv) : 0;
  // Fractal arms: branch / spiral are common once the creature develops detail; mandelbrot is recessive.
  type ArmMode = BodyP5["armFractal"]["mode"];
  let mode: ArmMode = "none";
  if (fractalDepth > 0) {
    const mt = 0.86 - 0.08 * chaos - (prim === "psychic" || prim === "void" ? 0.06 : 0);
    if (recessive(m, "p5.armMode", mt) >= 0) mode = "mandelbrot";
    else {
      mode = pickBy(["none", "branch", "spiral"] as const, [
        2.0,
        1.0 + 0.5 * fractalDepth,
        0.2 + 1.2 * pos(curvature) + 0.6 * (has("psychic") + has("water")),
      ], m["p5.armMode"][0]);
    }
  }
  const depth = mode === "none"
    ? 0
    : Math.round(clamp(fractalDepth + trait(m, "p5.armDepth", ph.plan.quality, -0.4, 1.4), mode === "mandelbrot" ? 3 : 1, 4));
  const armFractal = {
    depth,
    branch: mode === "none" ? 2 : Math.round(trait(m, "p5.armBranch", 0.5 * ph.plan.quality + 0.5 * u01(a.structure), 2, 4)),
    ratio: r3(trait(m, "p5.armRatio", 0.5 + 0.3 * curvature * 0.5, 0.45, 0.75)),
    twist: mode === "none"
      ? 0
      : r3(mode === "spiral" ? trait(m, "p5.armTwist", u01(a.form), 0.4, 1.4) : trait(m, "p5.armTwist", u01(a.form), 0, 0.4)),
    mode,
  };
  // Morph operators: 0..4, most creatures 0-1. Seeded by the ORDER-FREE ops allele pair, so a child that
  // inherits the same pair inherits the same operators.
  const opsPair = genePair(m["p5.ops"]);
  const v = boundTrait(opsPair, 0.3 * chaos + 0.3 * u01(a.form) + 0.2 * fractalDepth / 3 + 0.2 * ph.plan.quality);
  const nOps = Math.min(4, Math.floor(5 * v * v));
  const orng = new Rng(hashSeed(Math.round(opsPair.lo * 1e6), Math.round(opsPair.hi * 1e6), "ops"));
  const opW = [
    0.4 + has("earth") + has("metal") + 0.6 * has("ice"), // carve
    0.4 + has("water") + has("plant") + 0.6 * has("poison"), // merge
    0.3 + 0.8 * pos(a.hardness) + 0.5 * has("metal"), // compress
    0.3 + has("air") + 0.6 * pos(a.phase), // decompress
    0.2 + has("void") + has("shadow"), // difference
    0.3 + has("psychic") + 0.6 * (has("air") + has("water") + has("electric")), // twist
    0.4 + 0.8 * pos(a.might) + 0.5 * has("fire"), // bulge
    0.3 + has("fire") + has("electric"), // pinch
  ];
  const regions: MorphRegion[] = ["torso", "torso", "head", "all"];
  if (ph.plan.tail > 0.25 || kind === "serpent") regions.push("tail", "tail");
  if (limbed) regions.push("limb", "limb");
  if (ph.plan.neck > 0.3 && kind !== "blob") regions.push("neck");
  const ops: MorphOp[] = [];
  for (let i = 0; i < nOps; i++) {
    const k = orng.weighted(OP_KINDS, opW);
    ops.push({
      kind: k,
      region: orng.pick(regions),
      u: r3(orng.range(0.15, 0.85)),
      amount: r3(OP_SIGN[k] * orng.range(0.15, 0.6) * (k === "twist" && orng.chance(0.5) ? -1 : 1)),
      width: r3(orng.range(0.1, 0.5)),
      angle: orng.chance(0.65) ? 0 : r3(Math.PI), // dorsal or ventral: keeps the bilateral mirror
    });
  }
  return {
    shoulder,
    tail,
    armFractal,
    limbStyle,
    serpentLegs,
    limbVariation,
    curvature: r3(curvature),
    ops,
  };
}

const COATS: readonly CoatKind[] = ["skin", "fur", "scales", "feathers", "leaves", "chitin", "slime", "bark", "crystal"];

function skinP5(m: MorphAlleles, ph: Phenotype, s: SurfaceGenes): SkinP5 {
  const a = ph.axes, prim = ph.elements.primary, sec = ph.elements.secondary, kind = ph.kind;
  const pos = (v: number) => Math.max(0, v);
  const has = (el: ElementId) => prim === el ? 1 : sec === el ? 0.5 * ph.elements.secondaryLevel : 0;
  const mammal = (kind === "quadruped" || kind === "biped") && s.fur > 0.25;
  const coat = pickBy(COATS, [
    0.6, // skin
    mammal ? 0.6 + 2.5 * s.fur : 0.1 * s.fur, // fur
    (kind === "serpent" ? 4 : 0) + (s.plates > 0.4 ? 1 : 0) + (kind !== "blob" ? 0.6 * has("water") : 0) + 1.2 * has("metal"), // scales
    (kind === "avian" ? 6 : 0) + (kind !== "serpent" && kind !== "hexapod" && kind !== "blob" ? 0.8 * (has("fire") + has("air")) : 0), // feathers
    5 * (prim === "plant" ? 1 : 0) + (sec === "plant" ? 1.5 * ph.elements.secondaryLevel : 0), // leaves
    (kind === "hexapod" ? 5 : 0) + 0.4 * has("metal"), // chitin
    (kind === "blob" ? 1 + 5 * Math.min(1, has("poison") + has("water")) : 0) + 0.5 * has("poison") + (a.moisture > 0.5 ? 0.4 : 0), // slime
    1.5 * (prim === "earth" ? 1 : 0) + 2 * (prim === "earth" && sec === "plant" ? 1 : 0) + (prim === "plant" ? 0.4 : 0), // bark
    1.2 * (prim === "earth" ? 1 : 0) + 2 * has("ice") + 0.6 * has("light") + 0.8 * has("metal"), // crystal
  ], m["p5.coat"][0]);
  const fr = recessive(m, "p5.frills", 0.55 - 0.15 * (has("water") + (ph.plan.spikes > 0.6 ? 1 : 0)));
  const frills = fr >= 0 ? r3(0.2 + 0.8 * fr) : 0;
  const stripes = ph.pattern === "stripes"
    ? trait(m, "p5.stripes", 0.7, 0.5, 1)
    : recessive(m, "p5.stripes", 0.6) >= 0
    ? trait(m, "p5.stripes", 0.3, 0.1, 0.6)
    : 0;
  return {
    coat,
    bellyContrast: r3(trait(m, "p5.belly", 0.5 + (kind === "serpent" || kind === "avian" ? 0.2 : 0) + 0.15 * pos(a.moisture), 0.3, 0.95)),
    frills,
    stripes: r3(stripes),
    celBands: Math.round(trait(m, "p5.celBands", 0.5 * u01(a.structure) + 0.5 * (1 - u01(a.form)), 2, 5)),
    outline: r3(trait(m, "p5.outline", 0.4 + 0.3 * u01(a.temper) + 0.3 * u01(a.structure), 0.1, 0.8)),
    overlays: Math.round(trait(m, "p5.overlays", 0.6 * s.patternContrast + 0.4 * (ph.pattern === "solid" ? 0 : 1), 0, 3)),
  };
}

/** Express every pass-5 gene [P5-V2..V7] (deterministic; the alleles are inherited with the rest). */
export function p5Of(
  m: MorphAlleles,
  ph: Phenotype,
  base: { eyes: EyeGenes; mouth: MouthGenes; surface: SurfaceGenes; fractalDepth: number; chaos: number; counts?: BodyCounts },
): MorphP5 {
  const body = bodyP5(m, ph, base.fractalDepth, base.chaos, base.counts ?? null);
  const skin = skinP5(m, ph, base.surface);
  return {
    version: 5,
    eyes: eyesP5(m, ph, base.eyes),
    mouth: mouthP5(m, ph, base.mouth, base.eyes, skin.coat),
    growth: growthP5(m, ph, body.curvature),
    body,
    skin,
  };
}

// ------------------------------------------------------------------ the helix
/** Express the morph helix of a genome given its phenotype (version 1). Deterministic. */
export function helixOf(g: Genome, ph: Phenotype): MorphHelix {
  const outer = rankSink;
  rankSink = new Map();
  try {
    return expressHelix(g, ph, rankSink);
  } finally {
    rankSink = outer;
  }
}

/** Signature traits [P7-D1]: the remapped genes ranked furthest from the median (|rank - 0.5| >= 0.4), at most 6. */
function signatureOf(ranks: Map<string, number>): MorphP7["signature"] {
  return [...ranks.entries()]
    .filter(([, r]) => Math.abs(r - 0.5) >= 0.4)
    .sort((x, y) => Math.abs(y[1] - 0.5) - Math.abs(x[1] - 0.5) || (x[0] < y[0] ? -1 : 1))
    .slice(0, 6)
    .map(([gene, rank]) => ({ gene: gene.replace("#allele", ""), rank: r3(rank) }));
}

function expressHelix(g: Genome, ph: Phenotype, ranks: Map<string, number>): MorphHelix {
  const m = ensureMorph(g);
  const a = ph.axes;
  const chaos = Math.max(0, -a.structure);
  const complexity = complexityOf(g);
  const counts = complexity.counts;

  // Fractal development: order, quality, growth and level (older / higher creatures grow more detail).
  const fracDrive = 0.25 * u01(a.structure) + 0.25 * ph.plan.quality + 0.25 * ph.growth +
    0.25 * clamp01((ph.level - 1) / 30);
  const fractalDepth = Math.round(3 * trait(m, "fractal", fracDrive));
  // Digits [P6-C1] = counts.fingers (genome-level: the digits gene driven by quality and genetic might;
  // 0 for serpents, blobs and globes, 3-4 avian toes, 3-5 hands / feet, 5-7 on a mythic chimera).
  const digits = counts.fingers;
  const clawLength = digits === 0
    ? 0
    : trait(m, "claw", 0.4 * u01(a.temper) + 0.35 * u01(a.might) + 0.25 * u01(a.hardness));

  const eyes = eyesOf(m, ph, counts.eyes);
  const mouth = mouthOf(m, ph);
  const wings = wingsOf(m, ph, fractalDepth, counts.wingPairs > 0);
  const surface = surfaceOf(m, ph, fractalDepth);

  // Asymmetry is RECESSIVE and rare: both alleles above a threshold that chaos lowers.
  const asym = genePair(m.asymmetry);
  const t = 0.73 - 0.15 * chaos;
  let asymmetry = 0;
  const parts: AsymPart[] = [];
  const prng = new Rng(hashSeed(Math.round(m.asymmetry[0] * 1e6), Math.round(m.asymmetry[1] * 1e6), "asym"));
  const asymmetricSide: -1 | 1 = prng.chance(0.5) ? -1 : 1;
  if (asym.lo > t) {
    const n = (v: number) => (v - t) / (1 - t);
    asymmetry = 0.1 + 0.3 * boundTrait({ lo: n(asym.lo), hi: n(asym.hi) }, 0.5 + 0.5 * chaos);
    const avail = ASYM_PARTS.filter((p) =>
      p === "eye" || p === "pattern" ||
      (p === "horn" && ph.plan.horns > 0.35) || (p === "ear" && ph.plan.ears > 0.35) ||
      (p === "wing" && wings.kind !== "none") || (p === "claw" && clawLength > 0.1) ||
      (p === "tail" && ph.plan.tail > 0.25)
    );
    const k = Math.min(avail.length, 1 + prng.int(0, 2));
    parts.push(...prng.shuffle(avail).slice(0, k));
    parts.sort((x, y) => ASYM_PARTS.indexOf(x) - ASYM_PARTS.indexOf(y));
  }

  const fusion = clamp01(
    trait(
      m,
      "fusion",
      0.5 * u01(a.form) + 0.3 * (1 - u01(a.hardness)) +
        (ph.kind === "blob" ? 0.2 : ph.kind === "serpent" ? 0.1 : 0),
    ),
  );
  const angularity =
    trait(m, "angularity", 0.5 * u01(a.hardness) + 0.4 * u01(a.structure) + 0.1 * (1 - u01(a.form))) *
    (ph.kind === "blob" ? 0.4 : 1);

  const p5 = p5Of(m, ph, { eyes, mouth, surface, fractalDepth, chaos, counts });
  bendByNurture(ph, eyes, wings, surface, p5);
  const anim = animOf(m, ph, wings.kind);
  const p7core = p7Of(
    (gene: P7GeneId, drive: number, r0 = 0, r1 = 1) => trait(m, gene, drive, r0, r1),
    m["p7.ops"],
    ph,
    { fractalDepth, chaos, angularity, curvature: p5.body.curvature, frills: p5.skin.frills, hasWings: wings.kind !== "none" },
  );
  const p7: MorphP7 = { ...p7core, signature: signatureOf(ranks) };
  return {
    version: 1,
    asymmetry: r3(asymmetry),
    asymmetricSide,
    asymmetricParts: parts,
    fractalDepth,
    digits,
    clawLength: r3(clawLength),
    eyes,
    mouth,
    wings,
    surface,
    fusion: r3(fusion),
    angularity: r3(angularity),
    anim,
    p5,
    p6: { version: 6, complexity },
    p7,
  };
}

/**
 * Nurture bends the expressed traits [P6-N1] (in place, after the genes): `ph.nurture?.shift` factors
 * (each within 1 +- NURTURE_CAP) multiply the values the helix drives, clamped to their physical ranges.
 * Absent nurture (pass-5 phenotypes, fixtures) = identity. neckLength / legLength / armSize / girth /
 * hornSize have no helix field: renderers read `ph.nurture.shift` for those.
 */
function bendByNurture(ph: Phenotype, eyes: EyeGenes, wings: WingGenes, surface: SurfaceGenes, p5: MorphP5): void {
  const sh = ph.nurture?.shift;
  if (!sh) return;
  const f = (t: NurtureTrait) => {
    const v = sh[t];
    return typeof v === "number" && Number.isFinite(v) ? clamp(v, 0.5, 1.5) : 1;
  };
  if (wings.kind !== "none") wings.span = r3(clamp(wings.span * (wings.kind === "fin" ? f("finSize") : f("wingSpan")), 1.0, 3.6));
  eyes.size = r3(clamp(eyes.size * f("eyeSize"), 0.12, 0.45));
  surface.plates = r3(clamp01(surface.plates * f("armor")));
  surface.fur = r3(clamp01(surface.fur * f("furDensity")));
  const b = p5.body;
  b.tail.length = r3(clamp(b.tail.length * f("tailLength"), 0.3, 2.2));
  if (b.tail.shape === "fin" || b.tail.shape === "fan") b.tail.tipSize = r3(clamp(b.tail.tipSize * f("finSize"), 0.5, 2.2));
  b.shoulder.width = r3(clamp(b.shoulder.width * f("shoulderWidth"), 0.7, 1.45));
}

// ------------------------------------------------------------------ Lab text
const PUPIL_WORD: Record<PupilFill, string> = {
  full: "full",
  hollow: "hollow",
  none: "no",
  slit: "slit",
  star: "star",
};
const TOOTH_SINGULAR: Record<TeethKind, string> = {
  none: "tooth",
  beak: "beak",
  fangs: "fang",
  tusks: "tusk",
  saw: "saw tooth",
  needles: "needle",
  molars: "molar",
};
const TOOTH_PLURAL: Record<TeethKind, string> = {
  none: "teeth",
  beak: "beak",
  fangs: "fangs",
  tusks: "tusks",
  saw: "saw teeth",
  needles: "needles",
  molars: "molars",
};
const f2 = (v: number) => v.toFixed(2);

/** Short human-readable lines for the Lab UI. */
export function describeHelix(h: MorphHelix): string[] {
  const e = h.eyes, mo = h.mouth, w = h.wings;
  const lines: string[] = [];
  const eyeBits = [`${e.count === 2 ? "" : `${e.count} × `}${e.style}`, `${PUPIL_WORD[e.pupil]} pupil`];
  if (e.scleraColor === BLACK_SCLERA) eyeBits.push("black sclera");
  else if (e.scleraColor !== WHITE_SCLERA) eyeBits.push("tinted sclera");
  if (e.aura !== "none") eyeBits.push(`${e.aura} aura`);
  lines.push(`Eyes: ${eyeBits.join(", ")}`);
  if (mo.teeth === "beak") lines.push("Mouth: beak");
  else if (mo.teeth === "none" || mo.teethCount === 0) lines.push("Teeth: none");
  else {lines.push(
      `Teeth: ${mo.teethCount} ${mo.teethCount === 1 ? TOOTH_SINGULAR[mo.teeth] : TOOTH_PLURAL[mo.teeth]}`,
    );}
  if (w.kind === "none") lines.push("Wings: none");
  else lines.push(`Wings: ${w.kind}, span ${w.span.toFixed(1)}x, ${w.fingers} fingers`);
  if (h.asymmetry > 0 && h.asymmetricParts.length) {
    const side = h.asymmetricSide < 0 ? "left" : "right";
    lines.push(`Asymmetric: ${side} ${h.asymmetricParts.join(" + ")} larger (${f2(h.asymmetry)})`);
  } else lines.push("Symmetric");
  lines.push(`Development: depth ${h.fractalDepth}, ${h.digits} digits, claws ${f2(h.clawLength)}`);
  const s = h.surface;
  lines.push(`Surface: plates ${f2(s.plates)}, sheen ${f2(s.sheen)}, fur ${f2(s.fur)}, bump ${f2(s.bump)}`);
  lines.push(`Shape: fusion ${f2(h.fusion)}, angularity ${f2(h.angularity)}`);
  if (w.kind !== "none") lines.push(`Wing flap ${f2(h.anim.wingFlap.lo)}-${f2(h.anim.wingFlap.hi)} rad`);
  const motion = ANIM_CHANNELS.filter((c) => c !== "wingFlap")
    .map((c) => `${c} ${f2(h.anim[c].lo)}-${f2(h.anim[c].hi)}`);
  lines.push(`Motion: ${motion.join(", ")}`);
  if (h.p5) lines.push(...describeP5(h.p5));
  if (h.p6) lines.push(describeComplexity(h.p6.complexity));
  return lines;
}

const sgn = (v: number) => (v >= 0 ? "+" : "") + v.toFixed(2);

/** Pass-5 lines: eye layout and outline, beak / mouth / tongue, coat, body plan, growth, operators. */
export function describeP5(p: MorphP5): string[] {
  const e = p.eyes, mo = p.mouth, b = p.body, sk = p.skin, g = p.growth;
  const out: string[] = [];
  out.push(
    `Eye layout: ${e.count} ${e.shape} eye${e.count === 1 ? "" : "s"}, ${e.layout}, height ${sgn(e.height)}, ` +
      `spread ${f2(e.spread)}, socket ${f2(e.socketDepth)}, brow ${f2(e.brow)}`,
  );
  const mouth = [`scale ${mo.scale.map(f2).join("/")}`, `lips ${mo.lipCurve > 0.2 ? "smile" : mo.lipCurve < -0.2 ? "frown" : "flat"}`];
  if (mo.beak !== "none") mouth.unshift(`${mo.beak} beak (length ${f2(mo.beakLength)}, round ${f2(mo.beakRound)})`);
  if (mo.tongueLength > 0) mouth.push(`${mo.tongueFork ? "forked " : ""}tongue ${f2(mo.tongueLength)}`);
  out.push(`Mouth: ${mouth.join(", ")}`);
  const coat = [`${sk.coat}`, `belly ${f2(sk.bellyContrast)}`, `${sk.celBands} cel bands`];
  if (sk.frills > 0) coat.push(`frills ${f2(sk.frills)}`);
  if (sk.stripes > 0) coat.push(`stripes ${f2(sk.stripes)}`);
  out.push(`Coat: ${coat.join(", ")}`);
  const body = [`${b.tail.shape} tail x${b.tail.length.toFixed(1)}`, `limbs ${b.limbStyle}`, `curvature ${sgn(b.curvature)}`];
  if (b.shoulder.hump > 0) body.push(`hump ${f2(b.shoulder.hump)}`);
  if (b.serpentLegs > 0) body.push(`${b.serpentLegs} leg pair${b.serpentLegs > 1 ? "s" : ""}`);
  if (b.limbVariation > 0) body.push(`limb drift ${f2(b.limbVariation)}`);
  if (b.armFractal.mode !== "none") body.push(`${b.armFractal.mode} arms depth ${b.armFractal.depth}`);
  out.push(`Body: ${body.join(", ")}`);
  out.push(
    `Growth: length ${f2(g.length.lo)}-${f2(g.length.hi)}, strength ${f2(g.strength.lo)}-${f2(g.strength.hi)}, ` +
      `spiral ${g.spiral.toFixed(1)} turns, neoteny ${f2(g.neoteny)}`,
  );
  if (b.ops.length) out.push(`Morph ops: ${b.ops.map((o) => `${o.kind} ${o.region}`).join(", ")}`);
  return out;
}
