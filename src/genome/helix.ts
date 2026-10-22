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
 */
import {
  ANIM_CHANNELS,
  type AnimChannel,
  type AsymPart,
  type BoundTrait,
  type EyeAura,
  type EyeGenes,
  type EyeStyle,
  type GenePair,
  type MorphHelix,
  type MouthGenes,
  type PupilFill,
  type SurfaceGenes,
  type TeethKind,
  type WingGenes,
  type WingKind,
} from "./morphTypes.ts";
import { type ElementId, ELEMENTS } from "../data/elements.ts";
import { clamp, clamp01, u01 } from "../core/math.ts";
import { hashSeed, Rng } from "../core/rng.ts";
import type { Genome, PlanGene } from "./genome.ts";
import type { Phenotype } from "./phenotype.ts";

// ------------------------------------------------------------------ genes
export const MORPH_GENES = [
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

/** Physical value of a bounded trait: R0 + (R1 - R0) * boundTrait(pair, drive). */
function trait(m: MorphAlleles, gene: MorphGeneId, drive: number, r0 = 0, r1 = 1): number {
  return r0 + (r1 - r0) * boundTrait(genePair(m[gene]), drive);
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
function validAlleles(m: unknown): m is MorphAlleles {
  if (!m || typeof m !== "object") return false;
  const o = m as Record<string, unknown>;
  return MORPH_GENES.every((id) => {
    const p = o[id];
    return Array.isArray(p) && p.length === 2 &&
      p.every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1);
  });
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

/** The genome's stored morph alleles when present and valid, else the deterministic derivation. */
export function ensureMorph(g: Genome): MorphAlleles {
  const m = (g as Genome & { morph?: unknown }).morph;
  return validAlleles(m) ? m : deriveMorph(g);
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

function eyesOf(m: MorphAlleles, ph: Phenotype): EyeGenes {
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
  // Recessive counts: a cyclops needs both alleles low, 3-4 eyes need both alleles high.
  const c = genePair(m.eyeCount);
  const manyT = 0.82 - (ph.kind === "hexapod" ? 0.08 : 0) - 0.06 * pos(a.wisdom);
  const count = c.hi < 0.18 ? 1 : c.lo > manyT ? (c.lo > 0.95 ? 4 : 3) : 2;
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
  const big = ph.sizeClass === "L" || ph.sizeClass === "XL";
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

function wingsOf(m: MorphAlleles, ph: Phenotype, fractalDepth: number): WingGenes {
  const a = ph.axes, prim = ph.elements.primary, kind = ph.kind;
  let wk: WingKind = "none";
  if (kind === "avian") wk = "feather";
  else if (ph.plan.wings >= 0.45) {
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
    const p = genePair(m[animGene(ch)]);
    const lo = r3(W0 + (W1 - W0) * 0.6 * p.lo);
    const hi = r3(W0 + (W1 - W0) * (0.4 + 0.6 * p.hi));
    out[ch] = { lo, hi, value: r3(boundTrait({ lo, hi }, 0.5)) };
  }
  return out;
}

const ASYM_PARTS: readonly AsymPart[] = ["horn", "ear", "eye", "wing", "claw", "tail", "pattern"];

// ------------------------------------------------------------------ the helix
/** Express the morph helix of a genome given its phenotype (version 1). Deterministic. */
export function helixOf(g: Genome, ph: Phenotype): MorphHelix {
  const m = ensureMorph(g);
  const a = ph.axes;
  const chaos = Math.max(0, -a.structure);

  // Fractal development: order, quality, growth and level (older / higher creatures grow more detail).
  const fracDrive = 0.25 * u01(a.structure) + 0.25 * ph.plan.quality + 0.25 * ph.growth +
    0.25 * clamp01((ph.level - 1) / 30);
  const fractalDepth = Math.round(3 * trait(m, "fractal", fracDrive));
  const digitRange: [number, number] = ph.kind === "serpent" || ph.kind === "blob"
    ? [0, 0]
    : ph.kind === "avian"
    ? [3, 4]
    : [3, 5];
  const digits = Math.round(
    trait(m, "digits", 0.5 * fractalDepth / 3 + 0.5 * u01(a.might), digitRange[0], digitRange[1]),
  );
  const clawLength = digits === 0
    ? 0
    : trait(m, "claw", 0.4 * u01(a.temper) + 0.35 * u01(a.might) + 0.25 * u01(a.hardness));

  const eyes = eyesOf(m, ph);
  const mouth = mouthOf(m, ph);
  const wings = wingsOf(m, ph, fractalDepth);
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
    anim: animOf(m, ph, wings.kind),
  };
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
  return lines;
}
