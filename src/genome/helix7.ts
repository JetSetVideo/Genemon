/**
 * Pass-7 producer [P7-G1, P7-M1, P7-F1]: the extra morphogenetic operators, the surface relief, horn and
 * spike elaboration, the motion personality and the effects signature, all expressed from `p7.*` allele
 * pairs through the helix bounding equation AND the Pareto remap (the `trait` passed in by helix.ts), so
 * every value is heritable, bounded, typical for most creatures and extreme for a few.
 *
 * Elements and axes give the DRIVE (what the body tends toward: earth / metal / ice ridge and facet, water /
 * plant flute and scallop, hexapods and serpents segment, poison and earth knob; fast, elastic creatures
 * bounce and jitter, heavy ones sway; fire and electric trail and sparkle), the gene pair bounds it.
 * Pure module: the op list is seeded by the ORDER-FREE `p7.ops` allele pair (a child that inherits the
 * same pair inherits the same operators), never by Math.random.
 */
import type { MorphOp, MorphOpKind, MorphRegion } from "./morphTypes.ts";
import type { MorphP7 } from "./p7Types.ts";
import type { Phenotype } from "./phenotype.ts";
import type { ElementId } from "../data/elements.ts";
import { clamp, u01 } from "../core/math.ts";
import { hashSeed, Rng } from "../core/rng.ts";

/** Pass-7 genes, appended AFTER the pass-5 list (legacy alleles never move). */
export const P7_MORPH_GENES = [
  "p7.ops",
  "p7.ridges",
  "p7.flutes",
  "p7.segments",
  "p7.segDepth",
  "p7.knobs",
  "p7.facets",
  "p7.scallop",
  "p7.hornPairs",
  "p7.hornBranch",
  "p7.hornCurl",
  "p7.spikeRows",
  "p7.spikeLength",
  "p7.spikeDensity",
  "p7.followThrough",
  "p7.anticipation",
  "p7.jitter",
  "p7.sway",
  "p7.bounce",
  "p7.stiffness",
  "p7.fxIntensity",
  "p7.fxTrail",
  "p7.sparkle",
  "p7.pulse",
  "p7.fxHue",
] as const;
export type P7GeneId = typeof P7_MORPH_GENES[number];

/** Every operator kind (pass 5 + pass 7). */
export const ALL_OP_KINDS: readonly MorphOpKind[] = [
  "carve",
  "merge",
  "compress",
  "decompress",
  "difference",
  "twist",
  "bulge",
  "pinch",
  "ridge",
  "flute",
  "facet",
  "scallop",
  "segment",
  "knob",
  "spiral",
];
/** Sign of a fresh op's amount (remove = -1, add = +1; twist / spiral pick a handedness). */
const SIGN: Record<MorphOpKind, number> = {
  carve: -1,
  merge: 1,
  compress: -1,
  decompress: 1,
  difference: -1,
  twist: 1,
  bulge: 1,
  pinch: -1,
  ridge: 1,
  flute: -1,
  facet: 1,
  scallop: 1,
  segment: -1,
  knob: 1,
  spiral: 1,
};
export const P7_MAX_OPS = 6;

export type TraitFn = (gene: P7GeneId, drive: number, r0?: number, r1?: number) => number;

const r3 = (v: number): number => Math.round(v * 1000) / 1000;

export function p7Of(
  trait: TraitFn,
  opsPair: readonly [number, number],
  ph: Phenotype,
  base: { fractalDepth: number; chaos: number; angularity: number; curvature: number; frills: number; hasWings: boolean },
): Omit<MorphP7, "signature"> {
  const a = ph.axes, prim = ph.elements.primary, sec = ph.elements.secondary, kind = ph.kind;
  const pos = (v: number) => Math.max(0, v);
  const has = (el: ElementId) => prim === el ? 1 : sec === el ? 0.5 * ph.elements.secondaryLevel : 0;
  const limbed = kind === "quadruped" || kind === "biped" || kind === "hexapod";
  const hard = u01(a.hardness), wet = u01(a.moisture);
  const sharp = clamp(0.5 * base.angularity + 0.5 * clamp(-base.curvature, 0, 1), 0, 1);
  const curvy = clamp(base.curvature, 0, 1);

  // ---- relief
  const relief = {
    ridges: Math.round(trait("p7.ridges", 0.35 * hard + 0.3 * sharp + 0.25 * (has("earth") + has("metal") + 0.6 * has("ice")) + 0.1 * u01(a.might), 0, 5)),
    flutes: Math.round(trait("p7.flutes", 0.4 * curvy + 0.3 * (has("plant") + has("water")) + 0.15 * wet + 0.15 * ph.plan.quality, 0, 8)),
    segments: Math.round(trait(
      "p7.segments",
      (kind === "hexapod" ? 0.45 : kind === "serpent" ? 0.35 : 0.05) + 0.3 * u01(a.structure) + 0.2 * ph.plan.segments,
      0,
      12,
    )),
    segmentDepth: r3(trait("p7.segDepth", 0.5 * u01(a.structure) + 0.3 * hard + (kind === "hexapod" ? 0.2 : 0))),
    knobs: r3(trait("p7.knobs", 0.3 * ph.roughness + 0.3 * (has("poison") + has("earth")) + 0.2 * (1 - u01(a.mood)) + 0.2 * base.chaos)),
    facets: r3(trait("p7.facets", 0.45 * sharp + 0.35 * (has("ice") + has("metal") + 0.6 * has("earth") + 0.5 * has("light")) + 0.2 * hard)),
    scallop: r3(trait("p7.scallop", 0.35 * base.frills + 0.35 * (has("water") + has("plant")) + 0.15 * curvy + (base.hasWings ? 0.15 : 0))),
  };

  // ---- horns and spikes (pairs / rows only where the plan grows them)
  const horned = ph.plan.horns > 0.35;
  const horns = {
    pairs: horned ? Math.round(trait("p7.hornPairs", 0.6 * ph.plan.horns + 0.4 * u01(a.might), 1, 3)) : 0,
    branch: horned ? Math.round(trait("p7.hornBranch", 0.5 * base.fractalDepth / 3 + 0.3 * has("plant") + 0.2 * u01(a.wisdom), 0, 3)) : 0,
    curl: horned ? r3(trait("p7.hornCurl", 0.4 * curvy + 0.3 * u01(a.weight) + 0.3 * u01(a.wisdom), 0, 1.5)) : 0,
  };
  const spiky = ph.plan.spikes > 0.55;
  const spikes = {
    rows: spiky ? Math.round(trait("p7.spikeRows", 0.5 * ph.plan.spikes + 0.3 * u01(a.temper) + 0.2 * hard, 1, 3)) : 0,
    length: spiky ? r3(trait("p7.spikeLength", 0.5 * u01(a.temper) + 0.5 * ph.plan.spikes, 0.5, 2)) : 1,
    density: spiky ? r3(trait("p7.spikeDensity", 0.5 * u01(a.structure) + 0.5 * base.fractalDepth / 3, 0.5, 2)) : 1,
  };

  // ---- motion personality
  const light = 1 - u01(a.weight);
  const motion = {
    followThrough: r3(trait("p7.followThrough", 0.45 * ph.elasticity + 0.25 * ph.plan.tail + 0.15 * ph.plan.ears + 0.15 * curvy)),
    anticipation: r3(trait("p7.anticipation", 0.45 * u01(a.temper) + 0.3 * u01(a.might) + 0.25 * (1 - u01(a.tempo)))),
    jitter: r3(trait("p7.jitter", 0.4 * u01(a.tempo) + 0.3 * light + 0.3 * pos(-a.mood) * 1.5)),
    sway: r3(trait("p7.sway", 0.4 * u01(a.weight) + 0.3 * u01(a.stature) + 0.3 * curvy)),
    bounce: r3(trait("p7.bounce", limbed ? 0.4 * ph.elasticity + 0.35 * light + 0.25 * u01(a.mood) : 0.15 * ph.elasticity)),
    stiffness: r3(trait("p7.stiffness", 0.45 * u01(a.tempo) + 0.35 * hard + 0.2 * (1 - ph.elasticity), 0.6, 1.6)),
  };

  // ---- effects signature (render only)
  const hot = has("fire") + has("electric") + 0.6 * has("light");
  const fx = {
    intensity: r3(trait("p7.fxIntensity", 0.4 * ph.glow + 0.35 * u01(a.temper) + 0.25 * hot, 0.6, 1.6)),
    trail: r3(trait("p7.fxTrail", 0.45 * u01(a.tempo) + 0.3 * hot + 0.25 * has("air"))),
    sparkle: r3(trait("p7.sparkle", 0.5 * ph.glow + 0.3 * pos(a.luminance) + 0.2 * (has("psychic") + has("light") + has("electric")))),
    pulse: r3(trait("p7.pulse", 0.5 * ph.glow + 0.3 * u01(a.temper) + 0.2 * has("void"))),
    hueShift: r3(trait("p7.fxHue", 0.5, -0.08, 0.08)),
  };

  // ---- extra operators: 0..P7_MAX_OPS, Pareto count, kinds weighted by element and relief
  const nOps = Math.round(trait("p7.ops", 0.3 * base.chaos + 0.25 * u01(a.form) + 0.25 * base.fractalDepth / 3 + 0.2 * ph.plan.quality, 0, P7_MAX_OPS));
  const lo = Math.min(opsPair[0], opsPair[1]), hi = Math.max(opsPair[0], opsPair[1]);
  const orng = new Rng(hashSeed(Math.round(lo * 1e6), Math.round(hi * 1e6), "ops7"));
  const W: Record<MorphOpKind, number> = {
    carve: 0.3 + has("earth") + has("metal"),
    merge: 0.3 + has("water") + has("plant"),
    compress: 0.25 + 0.6 * hard,
    decompress: 0.25 + has("air") + 0.5 * pos(a.phase),
    difference: 0.2 + has("void") + has("shadow"),
    twist: 0.25 + has("psychic") + 0.5 * has("air"),
    bulge: 0.3 + 0.7 * u01(a.might) + 0.4 * has("fire"),
    pinch: 0.25 + 0.6 * (has("fire") + has("electric")),
    ridge: 0.3 + 0.8 * sharp + has("earth") + 0.6 * has("metal"),
    flute: 0.25 + 0.8 * curvy + has("plant"),
    facet: 0.2 + has("ice") + has("metal") + 0.6 * has("light"),
    scallop: 0.2 + has("water") + 0.5 * has("plant"),
    segment: 0.2 + (kind === "hexapod" ? 1.5 : kind === "serpent" ? 1 : 0) + 0.5 * u01(a.structure),
    knob: 0.2 + has("poison") + 0.6 * has("earth") + 0.4 * base.chaos,
    spiral: 0.15 + has("psychic") + 0.6 * has("water") + 0.4 * curvy,
  };
  const weights = ALL_OP_KINDS.map((k) => W[k]);
  const regions: MorphRegion[] = ["torso", "torso", "all"];
  if (ph.plan.tail > 0.25 || kind === "serpent") regions.push("tail", "tail");
  if (limbed) regions.push("limb");
  if (ph.plan.neck > 0.3 && kind !== "blob") regions.push("neck");
  const ops: MorphOp[] = [];
  for (let i = 0; i < nOps; i++) {
    const k = orng.weighted(ALL_OP_KINDS, weights);
    const flip = (k === "twist" || k === "spiral") && orng.chance(0.5) ? -1 : 1;
    ops.push({
      kind: k,
      region: orng.pick(regions),
      u: r3(orng.range(0.12, 0.88)),
      amount: r3(SIGN[k] * flip * orng.range(0.15, 0.65)),
      width: r3(k === "segment" || k === "scallop" || k === "spiral" || k === "facet" ? orng.range(0.35, 0.9) : orng.range(0.08, 0.45)),
      // dorsal (PI/2) or ventral (-PI/2) on the section frame keeps the bilateral mirror; 0 = whole ring kinds.
      angle: k === "segment" || k === "scallop" || k === "facet" || k === "flute" ? 0 : r3(orng.chance(0.7) ? Math.PI / 2 : -Math.PI / 2),
    });
  }
  return { version: 7, ops, relief, horns, spikes, motion, fx };
}
