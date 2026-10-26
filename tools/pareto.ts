// deno-lint-ignore-file no-explicit-any
/**
 * The Pareto rule, calibrated and measured [P7-D1].
 *
 *   deno task pareto            measure: per generated morph parameter min / max / median / mean / share20
 *                               (BEFORE = remap bypassed, AFTER = shipped calibration), heredity, generations
 *   deno task pareto --write    recalibrate src/data/paretoCalib.ts (fixed point, 3 rounds) then measure
 *   options: --n=6000 (calibration population)  --m=4000 (measurement population, DISJOINT seeds)
 *
 * Population: wild Genemon from `createGenemon` (genome = randomGenome(seed), level 1..40 from the seed, so
 * growth / fractal depth / nurture-free phenotypes cover the game's range). Measurement seeds start at 10^6
 * (never used by the calibration). Writes artifacts/p7/pareto-report.{json,md}.
 *
 * share20 = share of the total |x - median| held by the 20 % most deviant creatures. The rule passes for a
 * continuous parameter when 0.70 <= share20 <= 0.90 (uniform data scores ~0.36, a normal ~0.44). Parameters
 * that are mostly one value (gated rarities, integer counts with <= 6 values) are reported in their own class.
 */
import { createGenemon, phenotypeOf } from "../src/genome/genemon.ts";
import { randomGenome, type Genome } from "../src/genome/genome.ts";
import { breed } from "../src/genome/breeding.ts";
import { helixOf, PARETO_PROBE } from "../src/genome/helix.ts";
import { PARETO_CALIB } from "../src/data/paretoCalib.ts";
import { quantileKnots, summarize, type DistSummary } from "../src/genome/pareto.ts";
import { hashSeed } from "../src/core/rng.ts";
import type { MorphHelix } from "../src/genome/morphTypes.ts";
import type { Phenotype } from "../src/genome/phenotype.ts";

const arg = (k: string, d: number) => Number((Deno.args.find((a) => a.startsWith(`--${k}=`)) ?? `=${d}`).split("=")[1]);
const WRITE = Deno.args.includes("--write");
const N_CAL = arg("n", 6000);
const N_MEAS = arg("m", 4000);

/** Parameters whose population is a MIXTURE of design classes: also judged inside each class. */
const CLASS_SPLIT: [string, string][] = [
  ["anim.wingFlap.lo", "wingClass"],
  ["anim.wingFlap.hi", "wingClass"],
  ["anim.wingFlap.value", "wingClass"],
  ["wings.span", "wingClass"],
  ["p5.skin.stripes", "stripeClass"],
  ["p5.body.curvature", "element"],
  ["p5.mouth.beakLength", "p5.mouth.beak"],
  ["p5.mouth.beakRound", "p5.mouth.beak"],
  ["mouth.toothLength", "mouth.teeth"],
  ["mouth.teethCount", "mouth.teeth"],
  ["p5.body.armFractal.twist", "p5.body.armFractal.mode"],
];
const levelOf = (s: number) => 1 + (hashSeed(s, "lvl") % 40);
let lastPh: Phenotype | null = null;
function helixFor(genome: Genome, s: number): MorphHelix {
  const g = createGenemon({ seed: s, owner: "pareto", genome, level: levelOf(s) });
  lastPh = phenotypeOf(g);
  return helixOf(g.genome, lastPh);
}
const wild = (s: number) => helixFor(randomGenome(s), s);

// ------------------------------------------------------------------ flatten a helix
const SKIP = new Set(["version", "asymmetricSide", "irisColor", "scleraColor", "signature"]);
function flatten(h: MorphHelix): { nums: Record<string, number>; cats: Record<string, string> } {
  const nums: Record<string, number> = {}, cats: Record<string, string> = {};
  const walk = (o: any, path: string) => {
    if (o === null || o === undefined) return;
    if (Array.isArray(o)) {
      if (path.endsWith("ops")) {
        nums[`${path}.count`] = o.length;
        for (const op of o) cats[`${path}.kind:${op.kind}`] = "1";
        return;
      }
      if (o.every((v) => typeof v === "number")) {
        o.forEach((v, i) => (nums[`${path}[${i}]`] = v));
        return;
      }
      if (path.endsWith("asymmetricParts")) {
        nums[`${path}.count`] = o.length;
        return;
      }
      return;
    }
    if (typeof o === "object") {
      for (const [k, v] of Object.entries(o)) {
        if (SKIP.has(k)) continue;
        if (path === "p6" ) continue; // genome-level complexity (pass 6), not a morph expression
        walk(v, path ? `${path}.${k}` : k);
      }
      return;
    }
    if (typeof o === "number") nums[path] = o;
    else if (typeof o === "boolean") nums[path] = o ? 1 : 0;
    else if (typeof o === "string") cats[path] = o;
  };
  walk(h, "");
  return { nums, cats };
}

// ------------------------------------------------------------------ calibration (fixed point)
async function calibrate(): Promise<void> {
  const calib = PARETO_CALIB as Record<string, number[]>;
  for (const k of Object.keys(calib)) delete calib[k];
  for (let round = 1; round <= 3; round++) {
    const samples = new Map<string, number[]>();
    PARETO_PROBE.log = (key, raw) => {
      let a = samples.get(key);
      if (!a) samples.set(key, (a = []));
      a.push(raw);
    };
    for (let s = 1; s <= N_CAL; s++) wild(s);
    PARETO_PROBE.log = null;
    const next: Record<string, number[]> = {};
    for (const [k, xs] of [...samples.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) next[k] = quantileKnots(xs);
    let drift = 0;
    for (const [k, kn] of Object.entries(next)) {
      const old = calib[k];
      if (old) drift = Math.max(drift, ...kn.map((v, i) => Math.abs(v - old[i])));
      else drift = Math.max(drift, 1);
    }
    for (const k of Object.keys(calib)) delete calib[k];
    Object.assign(calib, next);
    console.log(`calibration round ${round}: ${Object.keys(next).length} keys, max knot drift ${drift.toFixed(4)}`);
  }
  const body = Object.entries(calib).map(([k, v]) => `  ${JSON.stringify(k)}: [${v.join(", ")}],`).join("\n");
  const src = `/**
 * GENERATED by \`deno task pareto --write\` (tools/pareto.ts) - do not edit by hand.
 * Pareto calibration [P7-D1]: per morph gene key, quantile knots of the RAW normalised expression over the
 * wild population (${N_CAL} wild Genemon, levels 1..40, 3 fixed-point rounds). src/genome/pareto.ts remaps each
 * raw value by its rank. Empty = identity.
 */
export const PARETO_CALIB: Readonly<Record<string, readonly number[]>> = {
${body}
};
`;
  await Deno.writeTextFile("src/data/paretoCalib.ts", src);
  console.log(`wrote src/data/paretoCalib.ts (${Object.keys(calib).length} keys)`);
}

// ------------------------------------------------------------------ measurement
/**
 * pareto / off: continuous parameter in / out of the 0.70-0.90 share20 band.
 * gated-pareto / gated-off: >= 20 % of creatures sit on one value (the feature is absent: no wings, no claws,
 *   a closed recessive gate); judged on the creatures that HAVE the feature (share20 of the other values).
 * discrete: <= 6 distinct values (small integer counts); constant: one value.
 */
type Klass = "pareto" | "off" | "gated-pareto" | "gated-off" | "discrete" | "constant";
const inBand = (x: number) => x >= 0.7 && x <= 0.9;
function klass(d: DistSummary, mode: number, modeAtBound: boolean, integral: boolean, cond: DistSummary | null): Klass {
  if (d.distinct <= 1) return "constant";
  if (d.distinct <= 6 || (integral && d.distinct <= 13)) return "discrete";
  if (((mode >= 0.2 && modeAtBound) || mode >= 0.5) && cond) return cond.distinct <= 6 ? "discrete" : inBand(cond.share20) ? "gated-pareto" : "gated-off";
  return inBand(d.share20) ? "pareto" : "off";
}
function modeOf(xs: number[]): { share: number; value: number } {
  const c = new Map<number, number>();
  for (const x of xs) c.set(Math.round(x * 1e4), (c.get(Math.round(x * 1e4)) ?? 0) + 1);
  let best = 0, key = 0;
  for (const [k, v] of c) if (v > best) [best, key] = [v, k];
  return { share: best / xs.length, value: key / 1e4 };
}
const modeShare = (xs: number[]) => modeOf(xs).share;
/** Discrete Pareto check: share of creatures holding the most common 20 % of the values (at least one value). */
function topFreq(xs: number[]): number {
  const c = new Map<number, number>();
  for (const x of xs) c.set(x, (c.get(x) ?? 0) + 1);
  const fr = [...c.values()].sort((a, b) => b - a);
  return fr.slice(0, Math.max(1, Math.round(fr.length * 0.2))).reduce((a, b) => a + b, 0) / xs.length;
}

function population(bypass: boolean, n: number, from: number) {
  PARETO_PROBE.bypass = bypass;
  const cols = new Map<string, number[]>();
  const catCounts = new Map<string, Map<string, number>>();
  const sigSizes: number[] = [];
  const looks = new Set<string>(), looksP6 = new Set<string>();
  const classCols = new Map<string, number[]>();
  const t0 = performance.now();
  for (let s = from; s < from + n; s++) {
    const h = wild(s);
    const { nums, cats } = flatten(h);
    for (const [k, v] of Object.entries(nums)) {
      let a = cols.get(k);
      if (!a) cols.set(k, (a = []));
      a.push(v);
    }
    for (const [k, v] of Object.entries(cats)) {
      const key = k.includes(":") ? k.split(":")[0] : k, val = k.includes(":") ? k.split(":")[1] : v;
      let m = catCounts.get(key);
      if (!m) catCounts.set(key, (m = new Map()));
      m.set(val, (m.get(val) ?? 0) + 1);
    }
    sigSizes.push(h.p7?.signature.length ?? 0);
    // A coarse "look" = the big silhouette choices (eye style, wings, tail shape, coat, limb style); the p7 look
    // adds which pass-7 elaborations are present (any extra op, ridges, flutes, segments, knobs, facets, horn
    // pairs > 1, branched horns, spike rows > 1). Counts how many distinct silhouettes a population shows.
    const p5 = h.p5!, p7 = h.p7!;
    const base = [h.eyes.style, h.wings.kind, p5.body.tail.shape, p5.skin.coat, p5.body.limbStyle].join("|");
    looksP6.add(base);
    const rl = p7.relief;
    looks.add(`${base}|${[p7.ops.length > 0, rl.ridges > 0, rl.flutes > 0, rl.segments > 0, rl.knobs > 0.25, rl.facets > 0.25, p7.horns.pairs > 1, p7.horns.branch > 0, p7.spikes.rows > 1].map((b) => (b ? 1 : 0)).join("")}`);
    // The calibration classes of helix.ts (wing class = avian / fly / glide / none; stripes = pattern / gate).
    const ph = lastPh!;
    cats.wingClass = h.wings.kind === "none" ? "none" : ph.kind === "avian" ? "avian" : ph.abilities.fly ? "fly" : "glide";
    cats.element = ph.elements.primary;
    cats.stripeClass = ph.pattern === "stripes" ? "pattern" : h.p5!.skin.stripes > 0 ? "gate" : "none";
    for (const [param, by] of CLASS_SPLIT) {
      if (!(param in nums) || !(by in cats)) continue;
      const key = `${param} | ${by}=${cats[by]}`;
      (classCols.get(key) ?? classCols.set(key, []).get(key)!).push(nums[param]);
    }
  }
  const ms = (performance.now() - t0) / n;
  PARETO_PROBE.bypass = false;
  // Pad missing samples (a key absent on some creatures, e.g. op counts) is not needed: every key is always present.
  const params: Record<string, DistSummary & { klass: Klass; mode: number; cond: DistSummary | null; top20freq: number }> = {};
  for (const [k, xs] of cols) {
    if (xs.length < n * 0.98) continue;
    const d = summarize(xs), md = modeOf(xs);
    const rest = xs.filter((x) => Math.round(x * 1e4) / 1e4 !== md.value);
    const atBound = Math.abs(md.value - d.min) < 1e-4 || Math.abs(md.value - d.max) < 1e-4;
    const integral = xs.every((x) => Number.isInteger(x));
    const cond = ((md.share >= 0.2 && atBound) || md.share >= 0.5) && rest.length >= 50 ? summarize(rest) : null;
    params[k] = { ...d, mode: md.share, cond, klass: klass(d, md.share, atBound, integral, cond), top20freq: integral ? topFreq(xs) : NaN };
  }
  const cats: Record<string, { values: number; top20share: number; freq: Record<string, number> }> = {};
  for (const [k, m] of catCounts) {
    const fr = [...m.values()].sort((a, b) => b - a), tot = k.endsWith("ops.kind") ? fr.reduce((a, b) => a + b, 0) : n;
    const top = Math.max(1, Math.round(fr.length * 0.2));
    cats[k] = { values: fr.length, top20share: fr.slice(0, top).reduce((a, b) => a + b, 0) / tot, freq: Object.fromEntries([...m.entries()].map(([v, c]) => [v, Math.round((c / tot) * 1000) / 1000])) };
  }
  const byClass: Record<string, { n: number; share20: number; cond: number; mode: number }> = {};
  for (const [k, xs] of classCols) {
    if (xs.length < 100) continue;
    const md = modeOf(xs), rest = xs.filter((x) => Math.round(x * 1e4) / 1e4 !== md.value);
    byClass[k] = { n: xs.length, share20: summarize(xs).share20, cond: rest.length >= 50 ? summarize(rest).share20 : NaN, mode: md.share };
  }
  return { params, cats, byClass, sigMean: sigSizes.reduce((a, b) => a + b, 0) / n, sigZero: sigSizes.filter((x) => x === 0).length / n, looks: looks.size, looksP6: looksP6.size, msPerHelix: ms };
}

/** Heredity: mid-parent vs child per numeric parameter over `fam` families of wild parents. */
function heredity(fam: number) {
  const mid = new Map<string, number[]>(), kid = new Map<string, number[]>();
  let extremeParents = 0, extremeKids = 0, baseKids = 0, baseN = 0;
  for (let f = 0; f < fam; f++) {
    const sa = 2_000_000 + 2 * f, sb = sa + 1;
    const A = randomGenome(sa), B = randomGenome(sb);
    const C = breed(A, B, hashSeed(f, "fam"));
    const ha = flatten(helixFor(A, sa)).nums, hb = flatten(helixFor(B, sa)).nums, hc = flatten(helixFor(C, sa)).nums;
    for (const k of Object.keys(hc)) {
      if (!(k in ha) || !(k in hb)) continue;
      (mid.get(k) ?? mid.set(k, []).get(k)!).push((ha[k] + hb[k]) / 2);
      (kid.get(k) ?? kid.set(k, []).get(k)!).push(hc[k]);
    }
  }
  const r: Record<string, number> = {};
  for (const [k, xs] of mid) {
    const ys = kid.get(k)!;
    const n = xs.length, mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) {
      sxy += (xs[i] - mx) * (ys[i] - my);
      sxx += (xs[i] - mx) ** 2;
      syy += (ys[i] - my) ** 2;
    }
    if (sxx > 1e-12 && syy > 1e-12) r[k] = Math.round((sxy / Math.sqrt(sxx * syy)) * 1000) / 1000;
  }
  // Tail transmission: a child is "extreme" in a parameter when it lies in that parameter's top or bottom 10 %
  // of children; compare its rate when the mid-parent is extreme vs. when it is not.
  for (const [k, xs] of mid) {
    const ys = kid.get(k)!;
    const sx = xs.slice().sort((a, b) => a - b), sy = ys.slice().sort((a, b) => a - b);
    const q = (s: number[], p: number) => s[Math.round(p * (s.length - 1))];
    const [xl, xh, yl, yh] = [q(sx, 0.1), q(sx, 0.9), q(sy, 0.1), q(sy, 0.9)];
    if (xl === xh || yl === yh) continue;
    for (let i = 0; i < xs.length; i++) {
      const pe = xs[i] <= xl || xs[i] >= xh, ce = (ys[i] <= yl && xs[i] <= xl) || (ys[i] >= yh && xs[i] >= xh);
      if (pe) {
        extremeParents++;
        if (ce) extremeKids++;
      } else {
        baseN++;
        if (ys[i] <= yl || ys[i] >= yh) baseKids++;
      }
    }
  }
  const vals = Object.values(r).sort((a, b) => a - b);
  return {
    families: fam,
    params: vals.length,
    medianR: vals[Math.floor(vals.length / 2)],
    shareRAbove02: vals.filter((v) => v > 0.2).length / vals.length,
    tailGivenExtremeParent: extremeKids / Math.max(1, extremeParents),
    tailBaseRate: baseKids / Math.max(1, baseN),
    perParam: r,
  };
}

/** Variety across generations: random mating, 240 per generation, 6 generations from wild founders. */
function generations(nPop = 240, gens = 6) {
  let pop = Array.from({ length: nPop }, (_, i) => randomGenome(3_000_000 + i));
  const rows: { gen: number; meanShare20: number; paretoShare: number; looks: number }[] = [];
  for (let gen = 0; gen <= gens; gen++) {
    const cols = new Map<string, number[]>();
    const looks = new Set<string>();
    pop.forEach((g, i) => {
      const h = helixFor(g, 3_000_000 + gen * 10_000 + i);
      for (const [k, v] of Object.entries(flatten(h).nums)) (cols.get(k) ?? cols.set(k, []).get(k)!).push(v);
      looks.add([h.eyes.style, h.wings.kind, h.p5!.body.tail.shape, h.p5!.skin.coat, h.p7!.ops.map((o) => o.kind).sort().join("+"), h.p7!.relief.ridges, h.p7!.horns.pairs].join("|"));
    });
    const sums = [...cols.values()].filter((xs) => xs.length === pop.length).map((xs) => ({ d: summarize(xs), mode: modeShare(xs) }))
      .filter(({ d, mode }) => d.distinct > 6 && mode < 0.5);
    rows.push({
      gen,
      meanShare20: Math.round((sums.reduce((a, b) => a + b.d.share20, 0) / sums.length) * 1000) / 1000,
      paretoShare: Math.round((sums.filter(({ d }) => d.share20 >= 0.7 && d.share20 <= 0.9).length / sums.length) * 1000) / 1000,
      looks: looks.size,
    });
    if (gen === gens) break;
    pop = pop.map((_, i) => breed(pop[hashSeed(gen, i, "a") % nPop], pop[hashSeed(gen, i, "b") % nPop], hashSeed(gen, i, "child")));
  }
  return rows;
}

// ------------------------------------------------------------------ run
if (WRITE) await calibrate();
const FROM = 1_000_000;
console.log(`measuring ${N_MEAS} wild Genemon (seeds ${FROM}..${FROM + N_MEAS - 1}, disjoint from calibration)...`);
const before = population(true, N_MEAS, FROM);
const after = population(false, N_MEAS, FROM);
const fam = heredity(1200);
const gens = generations();

const count = (o: typeof after, k: Klass) => Object.values(o.params).filter((p) => p.klass === k).length;
const lines: string[] = [];
lines.push(`# Pareto report [P7-D1]`, ``, `Command: \`deno task pareto${WRITE ? " --write" : ""}\` - ${N_MEAS} wild Genemon (seeds ${FROM}..), calibration keys: ${Object.keys(PARETO_CALIB).length}.`, ``);
lines.push(`| | BEFORE (remap bypassed) | AFTER (shipped) |`, `|---|---|---|`);
for (const k of ["pareto", "off", "gated-pareto", "gated-off", "discrete", "constant"] as Klass[]) lines.push(`| ${k} parameters | ${count(before, k)} | ${count(after, k)} |`);
const judged = (p: { klass: Klass; share20: number; cond: DistSummary | null }) => p.klass.startsWith("gated") ? p.cond!.share20 : p.share20;
const discreteA = Object.entries(after.params).filter(([, p]) => p.klass === "discrete");
const contB = Object.values(before.params).filter((p) => p.klass !== "discrete" && p.klass !== "constant").map((p) => ({ ...p, share20: judged(p) }));
const contA = Object.values(after.params).filter((p) => p.klass !== "discrete" && p.klass !== "constant").map((p) => ({ ...p, share20: judged(p) }));
const med = (xs: number[]) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
lines.push(`| continuous params in the 0.70-0.90 band | ${contB.filter((p) => inBand(p.share20)).length}/${contB.length} | ${contA.filter((p) => inBand(p.share20)).length}/${contA.length} |`);
// Verdict: a continuous parameter passes overall, or (a mixture) inside every design class it is calibrated in.
const classPass = (k: string) => {
  const rows = Object.entries(after.byClass).filter(([ck, c]) => ck.startsWith(`${k} |`) && c.mode < 1);
  return rows.length > 0 && rows.every(([, c]) => c.share20 >= 0.7 && c.share20 <= 0.93);
};
const verdict = contA.map((p) => inBand(p.share20)).length;
const fails = Object.entries(after.params).filter(([, p]) => p.klass === "off" || p.klass === "gated-off").map(([k]) => k);
const failsAfterClass = fails.filter((k) => !classPass(k));
lines.push(`| continuous params passing overall OR inside every design class | - | ${verdict - fails.length + (fails.length - failsAfterClass.length)}/${verdict} (still failing: ${failsAfterClass.join(", ") || "none"}) |`);
lines.push(`| median share20 of continuous params | ${med(contB.map((p) => p.share20)).toFixed(3)} | ${med(contA.map((p) => p.share20)).toFixed(3)} |`);
lines.push(`| distinct silhouettes WITHOUT pass-7 features (the pass-6 game) | ${after.looksP6} | ${after.looksP6} |`);
lines.push(`| distinct silhouettes WITH pass-7 features (uniform vs Pareto genes) | ${before.looks} | ${after.looks} |`);
lines.push(`| signature traits per creature (mean) | ${before.sigMean.toFixed(2)} | ${after.sigMean.toFixed(2)} |`);
lines.push(`| creatures with no signature trait | ${(before.sigZero * 100).toFixed(1)} % | ${(after.sigZero * 100).toFixed(1)} % |`);
lines.push(`| helixOf cost | ${before.msPerHelix.toFixed(3)} ms | ${after.msPerHelix.toFixed(3)} ms |`, ``);
lines.push(`## Heredity (${fam.families} families of wild parents, mid-parent vs child)`, ``);
lines.push(`- ${fam.params} parameters; median Pearson r = ${fam.medianR}; ${(fam.shareRAbove02 * 100).toFixed(0)} % of parameters with r > 0.2.`);
lines.push(`- A child lands in the SAME extreme decile as an extreme mid-parent ${(fam.tailGivenExtremeParent * 100).toFixed(1)} % of the time (either extreme decile when the mid-parent is not extreme: ${(fam.tailBaseRate * 100).toFixed(1)} %).`, ``);
lines.push(`## Generations (random mating, 240 per generation)`, ``, `| gen | mean share20 | share of continuous params in the 0.70-0.90 band | distinct looks |`, `|---|---|---|---|`);
for (const r of gens) lines.push(`| ${r.gen} | ${r.meanShare20} | ${r.paretoShare} | ${r.looks} |`);
lines.push(``, `## Every numeric parameter (AFTER; BEFORE share20 in brackets; gated: share20 among creatures with the feature)`, ``, `| parameter | class | min | max | median | mean | share20 | p10 | p90 |`, `|---|---|---|---|---|---|---|---|---|`);
const f = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(3));
for (const [k, p] of Object.entries(after.params).sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
  const b = before.params[k];
  const js = judged(p), jb = b ? judged(b) : NaN;
  lines.push(`| ${k} | ${p.klass} | ${f(p.min)} | ${f(p.max)} | ${f(p.median)} | ${f(p.mean)} | ${js.toFixed(3)} (${b ? jb.toFixed(3) : "-"}) | ${f(p.p10)} | ${f(p.p90)} |`);
}
lines.push(``, `## Discrete parameters (integer counts): share of creatures on the most common 20 % of values`, ``, `| parameter | values | top-20 % share | median | mean | min | max |`, `|---|---|---|---|---|---|---|`);
for (const [k, p] of discreteA.sort((a, b) => (a[0] < b[0] ? -1 : 1))) lines.push(`| ${k} | ${p.distinct} | ${Number.isFinite(p.top20freq) ? p.top20freq.toFixed(3) : "-"} | ${f(p.median)} | ${f(p.mean)} | ${f(p.min)} | ${f(p.max)} |`);
lines.push(``, `## Mixture parameters judged inside each design class (AFTER; classes with >= 100 creatures)`, ``, `| parameter / class | n | share20 | share20 without the modal value | modal share |`, `|---|---|---|---|---|`);
for (const [k, c] of Object.entries(after.byClass).sort((a, b) => (a[0] < b[0] ? -1 : 1))) lines.push(`| ${k} | ${c.n} | ${c.share20.toFixed(3)} | ${Number.isFinite(c.cond) ? c.cond.toFixed(3) : "-"} | ${c.mode.toFixed(2)} |`);
lines.push(``, `## Categorical parameters (AFTER): share of creatures in the top 20 % of values`, ``, `| parameter | values | top-20 % share |`, `|---|---|---|`);
for (const [k, c] of Object.entries(after.cats).sort((a, b) => (a[0] < b[0] ? -1 : 1))) lines.push(`| ${k} | ${c.values} | ${c.top20share.toFixed(3)} |`);
await Deno.mkdir("artifacts/p7", { recursive: true });
await Deno.writeTextFile("artifacts/p7/pareto-report.md", lines.join("\n") + "\n");
await Deno.writeTextFile("artifacts/p7/pareto-report.json", JSON.stringify({ before, after, heredity: fam, generations: gens }, null, 1));
console.log(lines.slice(0, 32).join("\n"));
console.log("wrote artifacts/p7/pareto-report.md and .json");
