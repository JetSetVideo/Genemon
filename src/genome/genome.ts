/**
 * Genome: the heritable code of a Genemon. Two seeds (legacy lab decision): `genotype` decides the
 * intrinsic body and coordinates, `environment` decides the extrinsic history (biomes, encounters).
 * Every gene is an allele PAIR (the double helix) so breeding is Mendelian: a child takes one
 * allele from each parent per gene, then mutation may perturb it.
 */
import { AXES, AXIS_IDS, type AxisId, type AxisVector } from "../data/axes.ts";
import { clamp, clamp01 } from "../core/math.ts";
import { hashSeed, mix32, Rng } from "../core/rng.ts";
import type { MorphAlleles } from "./helix.ts";

export const BODY_KINDS = ["quadruped", "biped", "hexapod", "serpent", "avian", "blob"] as const;
export type BodyKind = typeof BODY_KINDS[number];

export const PATTERNS = ["solid", "stripes", "spots", "mottle", "rings", "scales", "gradient", "veins"] as const;
export type PatternKind = typeof PATTERNS[number];

/** Body-plan genes, alleles in [0, 1]. */
export const PLAN_GENES = [
  "segments",
  "neck",
  "tail",
  "head",
  "legLen",
  "girth",
  "horns",
  "spikes",
  "ears",
  "jaw",
  "wings",
  "eyes",
  "quality",
] as const;
export type PlanGene = typeof PLAN_GENES[number];

export type Allele = [number, number];

export interface Genome {
  id: string;
  seeds: { genotype: number; environment: number };
  generation: number;
  lineage: string[];
  kind: BodyKind;
  pattern: PatternKind;
  axes: Record<AxisId, Allele>;
  plan: Record<PlanGene, Allele>;
  /** Palette hue shift alleles in [0, 1]. */
  hue: Allele;
  mutations: string[];
  /** Morph helix min/max alleles (src/genome/helix.ts); absent on legacy saves (derived deterministically). Never hashed into the id. */
  morph?: MorphAlleles;
}

export interface GenomeBias {
  axes?: Partial<AxisVector>;
  kind?: BodyKind;
  plan?: Partial<Record<PlanGene, number>>;
  /** Std-dev of the allele spread around the bias (default 0.45). */
  spread?: number;
}

/** Stable short id from all alleles (also the basis of the NFT token id). */
export function genomeId(g: Omit<Genome, "id">): string {
  let h = hashSeed(g.kind, g.pattern, g.generation, g.seeds.genotype);
  const fold = (v: number) => (h = mix32(h ^ Math.round((v + 2) * 100000)));
  for (const id of AXIS_IDS) g.axes[id].forEach(fold);
  for (const id of PLAN_GENES) g.plan[id].forEach(fold);
  g.hue.forEach(fold);
  return `gm-${h.toString(16).padStart(8, "0")}`;
}

function kindFromAxes(rng: Rng, a: AxisVector): BodyKind {
  const w = [
    1.2, // quadruped
    0.8 + Math.max(0, a.wisdom) + Math.max(0, a.might) * 0.5, // biped
    0.5 + Math.max(0, a.structure) + Math.max(0, -a.stature) * 0.8, // hexapod
    0.5 + Math.max(0, a.form) + Math.max(0, -a.altitude) * 0.8, // serpent
    0.3 + Math.max(0, a.altitude) * 2.5 - Math.max(0, a.weight), // avian
    0.3 + Math.max(0, a.phase) * 1.5 + Math.max(0, -a.substance) + Math.max(0, a.form) * 0.6, // blob
  ];
  return rng.weighted(BODY_KINDS, w);
}

function patternFromAxes(rng: Rng, a: AxisVector): PatternKind {
  const order = Math.max(0, a.structure), chaos = Math.max(0, -a.structure);
  const w = [
    0.6,
    0.5 + order,
    0.5 + chaos,
    0.4 + chaos,
    0.3 + order * 0.8,
    0.3 + Math.max(0, a.hardness),
    0.5 + Math.max(0, a.phase),
    0.2 + Math.max(0, a.luminance) + Math.max(0, a.conductivity) * 0.8,
  ];
  return rng.weighted(PATTERNS, w);
}

export function expressAllele(id: AxisId, pair: Allele): number {
  const ax = AXES.find((a) => a.id === id)!;
  if (ax.dominance === "extreme") return Math.abs(pair[0]) >= Math.abs(pair[1]) ? pair[0] : pair[1];
  return (pair[0] + pair[1]) / 2;
}

/** Genetic (pre-epigenetic) axis expression. */
export function geneticAxes(g: Genome): AxisVector {
  const out = {} as AxisVector;
  for (const id of AXIS_IDS) out[id] = clamp(expressAllele(id, g.axes[id]), -1, 1);
  return out;
}

export function planValue(g: Genome, gene: PlanGene): number {
  return clamp01((g.plan[gene][0] + g.plan[gene][1]) / 2);
}

/** A new wild/first-generation genome from seeds and an optional bias (biome, quest, lure...). */
export function randomGenome(genotypeSeed: number, environmentSeed = genotypeSeed ^ 0x5bd1e995, bias: GenomeBias = {}): Genome {
  const rng = new Rng(hashSeed(genotypeSeed, "genome"));
  const spread = bias.spread ?? 0.45;
  const axes = {} as Record<AxisId, Allele>;
  for (const id of AXIS_IDS) {
    const center = bias.axes?.[id] ?? 0;
    axes[id] = [clamp(rng.normal(center, spread), -1, 1), clamp(rng.normal(center, spread), -1, 1)];
  }
  const plan = {} as Record<PlanGene, Allele>;
  for (const id of PLAN_GENES) {
    const c = bias.plan?.[id] ?? 0.5;
    plan[id] = [clamp01(rng.normal(c, 0.22)), clamp01(rng.normal(c, 0.22))];
  }
  const partial: Omit<Genome, "id"> = {
    seeds: { genotype: genotypeSeed >>> 0, environment: environmentSeed >>> 0 },
    generation: 0,
    lineage: [],
    kind: "quadruped",
    pattern: "solid",
    axes,
    plan,
    hue: [rng.next(), rng.next()],
    mutations: [],
  };
  const expressed = geneticAxes({ ...partial, id: "" });
  partial.kind = bias.kind ?? kindFromAxes(rng, expressed);
  partial.pattern = patternFromAxes(rng, expressed);
  return { id: genomeId(partial), ...partial };
}

/** Recompute the id after an edit (breeding/mutation return fresh genomes through this). */
export function sealGenome(g: Omit<Genome, "id">): Genome {
  return { id: genomeId(g), ...g };
}

export function cloneGenome(g: Genome): Genome {
  return JSON.parse(JSON.stringify(g));
}
