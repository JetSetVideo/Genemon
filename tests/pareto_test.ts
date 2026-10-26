// Pass 7 [P7-D1, P7-H1]: the Pareto rule on generated morph parameters, its calibration and its heredity.
import { assert, assertAlmostEquals, assertEquals } from "./_assert.ts";
import { knotMedian, paretoAround, paretoQ, paretoRemap, paretoShare, quantileKnots, rankOf, summarize } from "../src/genome/pareto.ts";
import { createGenemon, phenotypeOf } from "../src/genome/genemon.ts";
import { type Genome, randomGenome } from "../src/genome/genome.ts";
import { breed } from "../src/genome/breeding.ts";
import { helixOf, mutationStep, PARETO_PROBE, SIGNATURE_RANK } from "../src/genome/helix.ts";
import { PARETO_CALIB } from "../src/data/paretoCalib.ts";
import { hashSeed, Rng } from "../src/core/rng.ts";
import type { MorphHelix } from "../src/genome/morphTypes.ts";

// ------------------------------------------------------------------ the math
Deno.test("pareto: paretoQ is a normalised bounded Pareto quantile holding the 80/20 rule", () => {
  assertEquals(paretoQ(0), 0);
  assertAlmostEquals(paretoQ(1), 1, 1e-9);
  let prev = -1;
  const xs: number[] = [];
  for (let i = 0; i <= 20000; i++) {
    const v = paretoQ(i / 20000);
    assert(v >= prev, "monotone");
    prev = v;
    xs.push(v);
  }
  // Top 20 % of the values hold ~80 % of the total (one-sided: deviation from the minimum 0).
  const s = xs.slice().sort((a, b) => b - a);
  const share = s.slice(0, 4000).reduce((a, b) => a + b, 0) / s.reduce((a, b) => a + b, 0);
  assert(share >= 0.78 && share <= 0.82, `top-20 share ${share}`);
  const d = summarize(xs);
  assert(d.median < 0.02 && d.mean > 2 * d.median, `median ${d.median} << mean ${d.mean}`);
  assertEquals(paretoQ(NaN), 0, "non-finite input is the minimum");
});

Deno.test("pareto: two-sided remap pins the median, reaches both bounds, is monotone; share20 ~0.8", () => {
  for (const m of [0.15, 0.5, 0.8]) {
    assertAlmostEquals(paretoAround(0.5, m), m, 1e-12, "median pinned");
    assertAlmostEquals(paretoAround(0, m), 0, 1e-9, "min reached");
    assertAlmostEquals(paretoAround(1, m), 1, 1e-9, "max reached");
    let prev = -1;
    const xs: number[] = [];
    for (let i = 0; i <= 10000; i++) {
      const v = paretoAround(i / 10000, m);
      assert(v >= prev - 1e-12, "monotone");
      prev = v;
      xs.push(v);
    }
    const sh = paretoShare(xs);
    assert(sh >= 0.75 && sh <= 0.88, `m=${m}: share20 ${sh}`);
  }
});

Deno.test("pareto: FALSIFIER - the share20 metric fails uniform and normal data", () => {
  const r = new Rng(7);
  const uni = Array.from({ length: 20000 }, () => r.next());
  const nor = Array.from({ length: 20000 }, () => r.normal(0, 1));
  assert(paretoShare(uni) < 0.45, `uniform ${paretoShare(uni)}`);
  assert(paretoShare(nor) < 0.5, `normal ${paretoShare(nor)}`);
  assertEquals(paretoShare([1, 1, 1, 1, 1, 1]), 0, "constant data has no deviation");
});

Deno.test("pareto: rankOf / quantile knots - empirical CDF with ties, clamped outside", () => {
  const k = quantileKnots(Array.from({ length: 1001 }, (_, i) => i / 1000));
  assertAlmostEquals(rankOf(k, 0.25), 0.25, 1e-6);
  assertEquals(rankOf(k, -1), 0);
  assertEquals(rankOf(k, 2), 1);
  assertAlmostEquals(knotMedian(k), 0.5, 1e-6);
  const tied = [0, 0.5, 0.5, 0.5, 1];
  assertAlmostEquals(rankOf(tied, 0.5), 0.5, 1e-9, "middle of a flat run");
  assertEquals(paretoRemap(undefined, 0.37).value, 0.37, "uncalibrated key = identity");
  assertAlmostEquals(paretoRemap(k, 0.9, true).value, paretoQ(0.9), 1e-6, "one-sided");
});

// ------------------------------------------------------------------ the shipped population
const levelOf = (s: number) => 1 + (hashSeed(s, "lvl") % 40);
function helixFor(genome: Genome, s: number, level = levelOf(s)): MorphHelix {
  const g = createGenemon({ seed: s, owner: "pareto", genome, level });
  return helixOf(g.genome, phenotypeOf(g));
}
const N = 1500;
// Seeds disjoint from the calibration (1..N_CAL) and from tools/pareto.ts measurements (10^6..).
const SEEDS = Array.from({ length: N }, (_, i) => 5_000_000 + i);
const after = SEEDS.map((s) => helixFor(randomGenome(s), s));
PARETO_PROBE.bypass = true;
const before = SEEDS.map((s) => helixFor(randomGenome(s), s));
PARETO_PROBE.bypass = false;

const PICK: [string, (h: MorphHelix) => number][] = [
  ["eyes.size", (h) => h.eyes.size],
  ["mouth.width", (h) => h.mouth.width],
  ["fusion", (h) => h.fusion],
  ["angularity", (h) => h.angularity],
  ["surface.sheen", (h) => h.surface.sheen],
  ["p5.tail.length", (h) => h.p5!.body.tail.length],
  ["p5.eyes.spread", (h) => h.p5!.eyes.spread],
  ["p5.skin.outline", (h) => h.p5!.skin.outline],
  ["anim.gait.hi", (h) => h.anim.gait.hi],
  ["anim.strike.lo", (h) => h.anim.strike.lo],
  ["p7.motion.followThrough", (h) => h.p7!.motion.followThrough],
  ["p7.motion.stiffness", (h) => h.p7!.motion.stiffness],
  ["p7.fx.intensity", (h) => h.p7!.fx.intensity],
];

Deno.test("pareto: the calibration is shipped (keys for p4, p5, p7 genes and anim / growth bands)", () => {
  const keys = Object.keys(PARETO_CALIB);
  assert(keys.length >= 100, `${keys.length} calibrated keys`);
  for (const k of ["eyeSize", "fusion", "p5.tailLength", "p7.followThrough", "p7.ops", "anim.gait.lo", "growth.length.hi", "wingSpan@avian"]) {
    assert(keys.includes(k), `calibrated: ${k}`);
  }
  for (const v of Object.values(PARETO_CALIB)) assert(v.every((x, i) => i === 0 || x >= v[i - 1]), "knots sorted");
});

Deno.test("pareto: shipped traits follow 80/20 on disjoint seeds - median kept, extremes kept, mean off the median", () => {
  const rows: string[] = [];
  for (const [name, get] of PICK) {
    const a = summarize(after.map(get)), b = summarize(before.map(get));
    rows.push(`${name}: share20 ${b.share20.toFixed(2)} -> ${a.share20.toFixed(2)}, median ${b.median.toFixed(3)} -> ${a.median.toFixed(3)}, range [${a.min.toFixed(2)}, ${a.max.toFixed(2)}]`);
    assert(a.share20 >= 0.68 && a.share20 <= 0.92, `${name} share20 ${a.share20}`);
    assert(b.share20 < 0.6, `${name}: the uncalibrated expression is NOT Pareto (${b.share20}) - the metric can fail`);
    const span = Math.max(1e-9, b.max - b.min);
    assert(Math.abs(a.median - b.median) <= 0.06 * span, `${name}: median kept (${b.median} -> ${a.median})`);
    // The rarest of N creatures sits at rank ~1 - 1/N: paretoQ(0.9987) = 0.92 of the way to the bound, so a
    // finite sample spans at least ~85 % of the uncalibrated range while 80 % of it crowds the median.
    assert(a.max - a.min >= 0.85 * (b.max - b.min), `${name}: range ${a.min}..${a.max} vs ${b.min}..${b.max}`);
    assert(Math.abs(a.mean - a.median) > 1e-4, `${name}: mean off the median`);
  }
  console.log(rows.join("\n"));
});

Deno.test("pareto: one-sided elaborations - most creatures plain, a Pareto few elaborate", () => {
  const frac = (f: (h: MorphHelix) => boolean) => after.filter(f).length / N;
  const ops0 = frac((h) => h.p7!.ops.length === 0);
  const ridges = frac((h) => h.p7!.relief.ridges > 0);
  const many = frac((h) => h.p7!.ops.length >= 3);
  assert(ops0 >= 0.7 && ops0 <= 0.95, `no extra op ${ops0}`);
  assert(ridges >= 0.03 && ridges <= 0.3, `ridged ${ridges}`);
  assert(many > 0 && many < 0.08, `3+ extra ops ${many}`);
  const anyElab = frac((h) => {
    const p = h.p7!;
    return p.ops.length > 0 || p.relief.ridges > 0 || p.relief.flutes > 0 || p.relief.segments > 0 || p.horns.pairs > 1 || p.horns.branch > 0 || p.spikes.rows > 1;
  });
  assert(anyElab >= 0.3 && anyElab <= 0.85, `some pass-7 elaboration ${anyElab}`);
  // Every operator kind is reachable in the wild (no dead kind).
  const kinds = new Set(after.flatMap((h) => h.p7!.ops.map((o) => o.kind)));
  assert(kinds.size >= 12, `operator kinds seen in ${N} wild: ${[...kinds].join(",")}`);
});

Deno.test("pareto: signature traits are the extreme ranks, deterministic, at most 6", () => {
  let none = 0;
  for (const h of after.slice(0, 400)) {
    const sig = h.p7!.signature;
    assert(sig.length <= 6);
    for (const s of sig) assert(Math.abs(s.rank - 0.5) >= SIGNATURE_RANK - 1e-9, `${s.gene} rank ${s.rank}`);
    if (sig.length === 0) none++;
  }
  assert(none > 20 && none < 200, `typical creatures (no signature) ${none}/400`);
  assertEquals(JSON.stringify(helixFor(randomGenome(SEEDS[3]), SEEDS[3]).p7), JSON.stringify(after[3].p7), "deterministic");
});

// ------------------------------------------------------------------ heredity
function spearman(xs: number[], ys: number[]): number {
  const rk = (v: number[]) => {
    const idx = v.map((x, i) => [x, i] as const).sort((p, q) => p[0] - q[0]);
    const r = new Array<number>(v.length);
    for (let i = 0; i < idx.length;) {
      let j = i;
      while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
      for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2;
      i = j + 1;
    }
    return r;
  };
  const a = rk(xs), b = rk(ys), n = a.length, ma = (n - 1) / 2;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) {
    sab += (a[i] - ma) * (b[i] - ma);
    saa += (a[i] - ma) ** 2;
    sbb += (b[i] - ma) ** 2;
  }
  return sab / Math.sqrt(saa * sbb);
}

Deno.test("pareto: heirs inherit the expressed traits and their extremes (mid-parent vs child)", () => {
  const fams = 500;
  const mid: number[][] = PICK.map(() => []), kid: number[][] = PICK.map(() => []), stranger: number[][] = PICK.map(() => []);
  for (let f = 0; f < fams; f++) {
    const sa = 6_000_000 + 2 * f, sb = sa + 1;
    const A = randomGenome(sa), B = randomGenome(sb), C = breed(A, B, hashSeed(f, "fam"));
    const lv = 20;
    const ha = helixFor(A, sa, lv), hb = helixFor(B, sb, lv), hc = helixFor(C, sa, lv), hs = helixFor(randomGenome(sa + 77_777), sa, lv);
    PICK.forEach(([, get], i) => {
      mid[i].push((get(ha) + get(hb)) / 2);
      kid[i].push(get(hc));
      stranger[i].push(get(hs));
    });
  }
  const rows: string[] = [];
  PICK.forEach(([name], i) => {
    const r = spearman(mid[i], kid[i]), rs = spearman(mid[i], stranger[i]);
    rows.push(`${name}: child r ${r.toFixed(2)} vs stranger ${rs.toFixed(2)}`);
    assert(r > 0.25 && r > rs + 0.2, `${name}: child ${r} vs stranger ${rs}`);
  });
  console.log(rows.join("\n"));
});

Deno.test("pareto: mutation steps are Pareto-tailed - mostly tiny, rarely large", () => {
  const r = new Rng(11);
  const steps = Array.from({ length: 50000 }, () => Math.abs(mutationStep(r)));
  const d = summarize(steps);
  assert(d.median < 0.015, `median step ${d.median}`);
  assert(d.mean < 0.04 && d.mean > 2 * d.median, `mean step ${d.mean}`);
  assert(d.max > 0.3 && d.max <= 0.5, `rare large step ${d.max}`);
  assert(paretoShare(steps) >= 0.75, `steps share20 ${paretoShare(steps)}`);
});
