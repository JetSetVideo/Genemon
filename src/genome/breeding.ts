/**
 * Breeding & transformation operators on genomes:
 *  - breed:  Mendelian crossover (one allele from each parent per gene) + mutation.
 *  - mutate: random perturbation (radiation, void exposure, rare items).
 *  - morph:  continuous blend between two genomes (t in [0,1]) - shapeshifting & previews.
 *  - fuse:   combination of two creatures into one: strongest pole wins per axis, larger body.
 * Mutation rate rises with chaos (structure axis < 0) - chaotic lineages diverge faster.
 */
import { AXIS_IDS, type AxisId } from "../data/axes.ts";
import { clamp, clamp01 } from "../core/math.ts";
import { hashSeed, Rng } from "../core/rng.ts";
import { ensureMorph, inheritMorph } from "./helix.ts";
import { type Allele, BODY_KINDS, type Genome, geneticAxes, PATTERNS, PLAN_GENES, type PlanGene, sealGenome } from "./genome.ts";

export interface BreedOptions {
  /** Base per-gene mutation probability (default 0.03). */
  mutationRate?: number;
  /** Std-dev of a mutation step on an axis allele (default 0.25). */
  mutationStep?: number;
}

function chaosOf(g: Genome): number {
  return Math.max(0, -geneticAxes(g).structure);
}

export function breed(a: Genome, b: Genome, seed: number, o: BreedOptions = {}): Genome {
  const rng = new Rng(hashSeed(seed, a.id, b.id, "breed"));
  const rate = (o.mutationRate ?? 0.03) * (1 + 1.5 * (chaosOf(a) + chaosOf(b)) / 2);
  const step = o.mutationStep ?? 0.25;
  const mutations: string[] = [];
  const axes = {} as Record<AxisId, Allele>;
  for (const id of AXIS_IDS) {
    let x = rng.pick(a.axes[id]), y = rng.pick(b.axes[id]);
    if (rng.chance(rate)) {
      x = clamp(x + rng.normal(0, step), -1, 1);
      mutations.push(`axis:${id}`);
    }
    if (rng.chance(rate)) y = clamp(y + rng.normal(0, step), -1, 1);
    axes[id] = rng.chance(0.5) ? [x, y] : [y, x];
  }
  const plan = {} as Record<PlanGene, Allele>;
  for (const id of PLAN_GENES) {
    let x = rng.pick(a.plan[id]), y = rng.pick(b.plan[id]);
    if (rng.chance(rate)) {
      x = clamp01(x + rng.normal(0, step * 0.6));
      mutations.push(`plan:${id}`);
    }
    if (rng.chance(rate)) y = clamp01(y + rng.normal(0, step * 0.6));
    plan[id] = [x, y];
  }
  let kind = rng.chance(0.5) ? a.kind : b.kind;
  if (rng.chance(rate * 0.6)) {
    kind = rng.pick(BODY_KINDS);
    mutations.push(`kind:${kind}`);
  }
  let pattern = rng.chance(0.5) ? a.pattern : b.pattern;
  if (rng.chance(rate)) {
    pattern = rng.pick(PATTERNS);
    mutations.push(`pattern:${pattern}`);
  }
  return sealGenome({
    seeds: { genotype: hashSeed(a.seeds.genotype, b.seeds.genotype, seed), environment: hashSeed(seed, "env") },
    generation: Math.max(a.generation, b.generation) + 1,
    lineage: [a.id, b.id],
    kind,
    pattern,
    axes,
    plan,
    hue: [rng.pick(a.hue), rng.pick(b.hue)],
    mutations,
    morph: inheritMorph(a, b, rng.fork("morph"), Math.min(0.2, rate + 0.01)),
  });
}

export function mutate(g: Genome, seed: number, strength = 0.3, focus?: AxisId[]): Genome {
  const rng = new Rng(hashSeed(seed, g.id, "mutate"));
  const axes = structuredClone(g.axes);
  const mutations = [...g.mutations];
  const targets = focus ?? AXIS_IDS.filter(() => rng.chance(0.25));
  for (const id of targets) {
    const i = rng.int(0, 1);
    axes[id][i] = clamp(axes[id][i] + rng.normal(0, strength), -1, 1);
    mutations.push(`mut:${id}`);
  }
  return sealGenome({ ...structuredClone(g), axes, mutations, generation: g.generation, morph: ensureMorph(g) });
}

/** Continuous blend between genomes (t=0 -> a, t=1 -> b). Discrete genes switch at t=0.5. */
export function morph(a: Genome, b: Genome, t: number): Genome {
  const k = clamp01(t);
  const mixA = (x: Allele, y: Allele, lo: number, hi: number): Allele => [
    clamp(x[0] + (y[0] - x[0]) * k, lo, hi),
    clamp(x[1] + (y[1] - x[1]) * k, lo, hi),
  ];
  const axes = {} as Record<AxisId, Allele>;
  for (const id of AXIS_IDS) axes[id] = mixA(a.axes[id], b.axes[id], -1, 1);
  const plan = {} as Record<PlanGene, Allele>;
  for (const id of PLAN_GENES) plan[id] = mixA(a.plan[id], b.plan[id], 0, 1);
  return sealGenome({
    seeds: k < 0.5 ? a.seeds : b.seeds,
    generation: Math.max(a.generation, b.generation),
    lineage: [a.id, b.id],
    kind: k < 0.5 ? a.kind : b.kind,
    pattern: k < 0.5 ? a.pattern : b.pattern,
    axes,
    plan,
    hue: mixA(a.hue, b.hue, 0, 1),
    mutations: [...a.mutations, `morph:${k.toFixed(2)}`],
    morph: structuredClone(k < 0.5 ? ensureMorph(a) : ensureMorph(b)),
  });
}

/** Fusion: per axis the stronger pole wins (both alleles), the body grows, lineage records both. */
export function fuse(a: Genome, b: Genome, seed: number): Genome {
  const rng = new Rng(hashSeed(seed, a.id, b.id, "fuse"));
  const ea = geneticAxes(a), eb = geneticAxes(b);
  const axes = {} as Record<AxisId, Allele>;
  for (const id of AXIS_IDS) {
    const src = Math.abs(ea[id]) >= Math.abs(eb[id]) ? a.axes[id] : b.axes[id];
    axes[id] = [src[0], src[1]];
  }
  axes.stature = [clamp(axes.stature[0] + 0.3, -1, 1), clamp(axes.stature[1] + 0.3, -1, 1)];
  const plan = {} as Record<PlanGene, Allele>;
  for (const id of PLAN_GENES) {
    plan[id] = [clamp01(Math.max(a.plan[id][0], b.plan[id][0])), clamp01((a.plan[id][1] + b.plan[id][1]) / 2)];
  }
  return sealGenome({
    seeds: { genotype: hashSeed(a.seeds.genotype, b.seeds.genotype, "fuse"), environment: hashSeed(seed, "fenv") },
    generation: Math.max(a.generation, b.generation) + 1,
    lineage: [a.id, b.id],
    kind: rng.chance(0.5) ? a.kind : b.kind,
    pattern: rng.chance(0.5) ? a.pattern : b.pattern,
    axes,
    plan,
    hue: [a.hue[0], b.hue[1]],
    mutations: ["fusion"],
    morph: inheritMorph(a, b, rng.fork("morph"), 0),
  });
}

/** Genetic distance (mean absolute allele difference) - used to rate breeding diversity. */
export function geneticDistance(a: Genome, b: Genome): number {
  let s = 0, n = 0;
  for (const id of AXIS_IDS) {
    s += Math.abs(a.axes[id][0] - b.axes[id][0]) + Math.abs(a.axes[id][1] - b.axes[id][1]);
    n += 2;
  }
  return s / n;
}
