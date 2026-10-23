/**
 * Breeding & transformation operators on genomes:
 *  - breed:  Mendelian crossover (one allele from each parent per gene) + mutation.
 *  - mutate: random perturbation (radiation, void exposure, rare items).
 *  - morph:  continuous blend between two genomes (t in [0,1]) - shapeshifting & previews.
 *  - fuse:   combination of two creatures into one: strongest pole wins per axis, larger body.
 * Mutation rate rises with chaos (structure axis < 0) - chaotic lineages diverge faster.
 * Pass 6 [P6-C2]: the complexity alleles are inherited the same Mendelian way (one per parent per pair, so
 * the child's expected complexity is the mid-parent value), with a small mutation and a RARE JUMP (~2 % of
 * births shift every complexity allele together by 0.04-0.10, up slightly more often than down): selection
 * climbs the ladder slowly, a lucky birth skips a rung. A child whose genes reach the colossal tier gets the
 * colossus body (`colossusBody`). Every draw uses forked streams, so pass-5 children keep their genes.
 */
import { AXIS_IDS, type AxisId } from "../data/axes.ts";
import { clamp, clamp01 } from "../core/math.ts";
import { hashSeed, Rng } from "../core/rng.ts";
import { ensureMorph, inheritMorph } from "./helix.ts";
import { type Allele, BODY_KINDS, colossusBody, type Genome, geneticAxes, PATTERNS, PLAN_GENES, type PlanGene, sealGenome } from "./genome.ts";
import { cxAllelesOf, isColossal } from "./complexity.ts";

export interface BreedOptions {
  /** Base per-gene mutation probability (default 0.03). */
  mutationRate?: number;
  /** Std-dev of a mutation step on an axis allele (default 0.25). */
  mutationStep?: number;
  /** Probability of a complexity jump at birth (default CX_JUMP_RATE). */
  cxJumpRate?: number;
}

/** Share of births whose complexity alleles all jump together (up 55 % / down 45 %). */
export const CX_JUMP_RATE = 0.02;

/** Mendelian inheritance of the complexity alleles + small mutation + the rare jump [P6-C2]. */
export function inheritCx(a: Genome, b: Genome, rng: Rng, mutationRate: number, jumpRate = CX_JUMP_RATE, mutations?: string[]): Allele[] {
  const ca = cxAllelesOf(a), cb = cxAllelesOf(b);
  const out: Allele[] = ca.map((pa, i) => {
    let x = rng.pick(pa), y = rng.pick(cb[i]);
    if (rng.chance(mutationRate)) x = clamp01(x + rng.normal(0, 0.12));
    if (rng.chance(mutationRate)) y = clamp01(y + rng.normal(0, 0.12));
    return rng.chance(0.5) ? [x, y] : [y, x];
  });
  if (rng.chance(jumpRate)) {
    const up = rng.chance(0.55);
    const d = (up ? 1 : -1) * rng.range(0.04, 0.1);
    for (const p of out) [p[0], p[1]] = [clamp01(p[0] + d), clamp01(p[1] + d)];
    mutations?.push(up ? "cx:jump+" : "cx:jump-");
  }
  return out;
}

/** Seal a child genome, giving it the colossus body when its complexity genes reach the colossal tier. */
function sealChild(g: Omit<Genome, "id">): Genome {
  if (isColossal(g)) colossusBody(g);
  return sealGenome(g);
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
  const cxGenes = inheritCx(a, b, rng.fork("cx"), rate, o.cxJumpRate ?? CX_JUMP_RATE, mutations);
  return sealChild({
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
    cxGenes,
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
  return sealGenome({ ...structuredClone(g), axes, mutations, generation: g.generation, morph: ensureMorph(g), cxGenes: cxAllelesOf(g) });
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
    cxGenes: cxAllelesOf(k < 0.5 ? a : b),
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
  // A fusion is a chimera: per complexity pair the higher allele of each rank wins (complexity rises).
  const ca = cxAllelesOf(a), cb = cxAllelesOf(b);
  const cxGenes: Allele[] = ca.map((pa, i) => {
    const x = [Math.min(...pa), Math.max(...pa)], y = [Math.min(...cb[i]), Math.max(...cb[i])];
    return [Math.max(x[0], y[0]), Math.max(x[1], y[1])];
  });
  return sealChild({
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
    cxGenes,
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
