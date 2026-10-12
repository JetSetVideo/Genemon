import { assert, assertAlmostEquals, assertEquals, assertThrows } from "./_assert.ts";
import { Battle } from "../src/combat/battle.ts";
import { hashSeed, Rng } from "../src/core/rng.ts";
import { AXIS_IDS } from "../src/data/axes.ts";
import type { ElementId } from "../src/data/elements.ts";
import { createGenemon, phenotypeOf } from "../src/genome/genemon.ts";
import { axisRows, clusterAxes, elbow, projectAxes, topPoles } from "../src/ml/projection.ts";
import {
  calibrationTable,
  CONDITION_FEATURES,
  CorpusJob,
  corpusMatch,
  preMatchRow,
  simulateCorpus,
  trainWinModel,
  WIN_FEATURE_NAMES,
  WIN_FEATURES,
  winFeatures,
  type WinModelReport,
  winPredictor,
  type WinRow,
  WinTrainer,
} from "../src/ml/winModel.ts";

const ROW_KEYS = ["arena", "combosA", "combosB", "features", "hour", "weather", "win"];

/** Synthetic rows: every feature uniform in [-1, 1]; the label is decided by one column alone. */
function decidedRows(n: number, seed: number, decider: string, flip = 0): WinRow[] {
  const rng = new Rng(seed);
  const j = WIN_FEATURE_NAMES.indexOf(decider);
  assert(j >= 0, `unknown feature ${decider}`);
  return Array.from({ length: n }, (_, i) => {
    const features = WIN_FEATURE_NAMES.map(() => rng.range(-1, 1));
    const win = (features[j] > 0) !== rng.chance(flip) ? 1 : 0;
    return { features, win, arena: "meadow", weather: "clear", hour: 12, combosA: [`c${i % 3}`], combosB: [`c${(i + 1) % 3}`] };
  });
}

function score(rep: WinModelReport, id: string) {
  const s = rep.scores.find((x) => x.id === id);
  assert(s, `missing score ${id}`);
  return s;
}

// ------------------------------------------------------------------------------------ corpus

Deno.test("winModel: simulateCorpus rows hold only pre-match information (features computable without fighting)", () => {
  const rows = simulateCorpus(6, 3);
  assertEquals(rows.length, 6);
  const labels = new Set<number>();
  rows.forEach((row, i) => {
    assertEquals(Object.keys(row).sort(), ROW_KEYS, "a row is the pre-match fields + the label, nothing else");
    assert(row.win === 0 || row.win === 0.5 || row.win === 1, `label ${row.win}`);
    labels.add(row.win);
    // Rebuild the same setup and read it WITHOUT running any battle: the row must match exactly.
    const m = corpusMatch(3, i);
    const pre = preMatchRow(m);
    const { win: _label, ...rest } = row;
    assertEquals(rest, pre, `row ${i}: something besides the label depends on the battle`);
    assertEquals(row.features.length, WIN_FEATURE_NAMES.length);
    assert(row.features.every(Number.isFinite), `row ${i}: non-finite feature`);
    // Fighting the battle must not change what the features read (no mutation leak either).
    const before = winFeatures(m.teams[0], m.teams[1], m.arena);
    new Battle({ seed: m.seed, arena: m.arena, teams: m.teams }).run();
    assertEquals(winFeatures(m.teams[0], m.teams[1], m.arena), before, `row ${i}: features changed after the battle`);
  });
  assert(labels.has(1) && labels.has(0), `both sides should win sometimes in 6 battles: ${[...labels]}`);
  for (const n of WIN_FEATURE_NAMES) {
    assert(!/win|winner|hpFrac|duration|ko|mvp|result|damage/i.test(n), `feature "${n}" sounds like a battle outcome`);
  }
  assertEquals(WIN_FEATURE_NAMES.slice(0, CONDITION_FEATURES.length), [...CONDITION_FEATURES], "the ladder's 8 conditions come first");
  assertEquals(new Set(WIN_FEATURE_NAMES).size, WIN_FEATURES.length, "unique names");
});

Deno.test("winModel: a chunked CorpusJob (yield at every check, 1 battle per call) equals simulateCorpus", () => {
  const whole = simulateCorpus(4, 21);
  const job = new CorpusJob(4, 21);
  let calls = 0;
  while (!job.advance(() => true, 1)) calls++;
  assert(calls > 4, `expected many resumptions, got ${calls}`);
  assertEquals(job.rows, whole);
  assertEquals(job.stats.aWins + job.stats.bWins + job.stats.draws, 4);
  assert(job.stats.ticks > 0 && job.stats.gameSeconds > 0, "stats are counted");
  assertEquals(simulateCorpus(0, 1), []);
  assertThrows(() => new CorpusJob(-1, 1));
});

Deno.test("winModel: winFeatures negates the side-relative columns when the sides swap and keeps the shared ones", () => {
  for (let i = 0; i < 6; i++) {
    const m = corpusMatch(5, i);
    const ab = winFeatures(m.teams[0], m.teams[1], m.arena);
    const ba = winFeatures(m.teams[1], m.teams[0], m.arena);
    WIN_FEATURES.forEach((f, j) => {
      if (f.group === "shared") assertEquals(ba[j], ab[j], `${f.name} must not depend on the side`);
      else assertAlmostEquals(ba[j], -ab[j], 1e-12, `${f.name} must flip sign`);
      assert(Math.abs(ab[j]) <= 1.5, `${f.name} = ${ab[j]} out of range`);
    });
  }
});

// ------------------------------------------------------------------------------------ training

Deno.test("winModel: trainWinModel is deterministic per seed, chunking does not change it, another seed does", () => {
  const rows = decidedRows(120, 4, "powerDiff", 0.1);
  const a = trainWinModel(rows, 9);
  const b = trainWinModel(rows, 9);
  assertEquals(JSON.stringify(a), JSON.stringify(b), "same rows + seed -> identical report");
  const t = new WinTrainer(rows, 9);
  let calls = 0;
  while (!t.advance(() => true)) calls++;
  assert(calls > 10, `expected one epoch per call, got ${calls} calls`);
  assertEquals(JSON.stringify(t.report()), JSON.stringify(a), "advance() in chunks == one call");
  const c = trainWinModel(rows, 10);
  assert(JSON.stringify(c.model) !== JSON.stringify(a.model), "another seed gives another split / init");
  assertThrows(() => trainWinModel(rows.slice(0, 9), 1), "too few rows");
  assertThrows(() => trainWinModel([{ ...rows[0], features: [1, 2] }, ...rows.slice(1)], 1), "wrong width");
  assertThrows(() => new WinTrainer(rows, 1).report(), "no report before training");
});

Deno.test("winModel: the network beats the base rate when one feature decides the outcome, and ranks it first", () => {
  const rows = decidedRows(300, 7, "levelGap");
  const rep = trainWinModel(rows, 2);
  assertEquals(rep.scores.map((s) => s.id), ["nn", "logistic", "conditions", "ladder", "base"]);
  const nn = score(rep, "nn"), base = score(rep, "base");
  assert(base.logLoss > 0.6, `base rate log-loss ${base.logLoss} should be ~ln 2`);
  assert(nn.logLoss < 0.6 * base.logLoss, `network ${nn.logLoss} vs base ${base.logLoss}`);
  assert(nn.accuracy > 0.85, `network accuracy ${nn.accuracy}`);
  assert(base.vsNN > 3 * base.vsNNSE, `paired gain ${base.vsNN} +- ${base.vsNNSE} must be clear`);
  assertEquals(rep.importance[0].name, "levelGap", "permutation importance finds the deciding column");
  assert(rep.importance[0].delta > 5 * Math.abs(rep.importance[1].delta), "and it dominates");
  const coef = rep.importance[0].coef;
  assert(coef > 1, `logistic coefficient of the decider ${coef} (positive: good for A)`);
  // The ladder never sees levelGap (not a condition): it cannot do better than a coin here.
  assert(score(rep, "ladder").logLoss > nn.logLoss, "ladder without the deciding column");
  assert(rep.curve.bestEpoch >= 1 && rep.fitCurve.length === rep.curve.bestEpoch, "refit for the early-stopped epoch count");
  assert(rep.curve.validation.length === rep.curve.train.length && rep.curve.train.length >= rep.curve.bestEpoch);
  // The exported model reproduces a confident call on a clear-cut row.
  const predict = winPredictor(JSON.parse(JSON.stringify(rep.model)));
  const strong = WIN_FEATURE_NAMES.map((n) => (n === "levelGap" ? 0.9 : 0));
  const weak = WIN_FEATURE_NAMES.map((n) => (n === "levelGap" ? -0.9 : 0));
  assert(predict(strong) > 0.8 && predict(weak) < 0.2, `P(+) ${predict(strong)}, P(-) ${predict(weak)}`);
  assertThrows(() => predict([0, 1]));
});

Deno.test("winModel: calibration bins partition the holdout (10 bins, counts sum to its size)", () => {
  const rep = trainWinModel(decidedRows(200, 12, "typeAdvantage", 0.2), 3);
  for (const table of [rep.calibration, rep.calibrationLogistic]) {
    assertEquals(table.length, 10);
    assertEquals(table.reduce((s, b) => s + b.n, 0), rep.nHoldout, "every holdout row lands in exactly one bin");
    table.forEach((b, i) => {
      assertAlmostEquals(b.lo, i / 10, 1e-12);
      assertAlmostEquals(b.hi, (i + 1) / 10, 1e-12);
      if (b.n > 0) assert(b.meanP >= b.lo - 1e-12 && b.meanP <= b.hi + 1e-12, `bin ${i}: mean ${b.meanP}`);
      assert(b.observed >= 0 && b.observed <= 1 && b.ciLo <= b.ciHi, `bin ${i}`);
    });
  }
  assertEquals(rep.nTrain + rep.nHoldout, 200);
  assertEquals(rep.nHoldout, 50, "25% holdout");
  // A hand-checked table: 1.0 falls in the last bin, 0.5 in the sixth.
  const t = calibrationTable([0.05, 0.15, 0.5, 0.95, 1], [0, 1, 0.5, 1, 1]);
  assertEquals(t.map((b) => b.n), [1, 1, 0, 0, 0, 1, 0, 0, 0, 2]);
  assertAlmostEquals(t[9].meanP, 0.975, 1e-12);
  assertEquals([t[9].observed, t[5].observed, t[0].observed], [1, 0.5, 0]);
  assertThrows(() => calibrationTable([0.5], []));
});

Deno.test("winModel: end to end on real battles - finite metrics, ladder baseline runs, model JSON round trip", () => {
  const rows = simulateCorpus(40, 11);
  const rep = trainWinModel(rows, 1);
  assertEquals([rep.nTrain, rep.nHoldout], [30, 10]);
  for (const s of rep.scores) {
    assert(Number.isFinite(s.logLoss) && s.logLoss > 0, `${s.id} log-loss ${s.logLoss}`);
    assert(Number.isFinite(s.brier) && s.brier >= 0 && s.brier <= 1, `${s.id} Brier ${s.brier}`);
  }
  assert(Object.keys(rep.ladderWeights).length > 0, "the ladder learned some condition weights");
  assertEquals(rep.importance.length, WIN_FEATURE_NAMES.length);
  const predict = winPredictor(JSON.parse(JSON.stringify(rep.model)));
  for (const r of rows.slice(0, 5)) {
    const p = predict(r.features);
    assert(p > 0 && p < 1, `P = ${p}`);
  }
});

// ------------------------------------------------------------------------------------ projection

/** n rows = t * dir + small noise, in 26-D. */
function planted(n: number, seed: number, dir: Partial<Record<string, number>>, noise: number): number[][] {
  const rng = new Rng(seed);
  const u = AXIS_IDS.map((id) => dir[id] ?? 0);
  const norm = Math.hypot(...u);
  return Array.from({ length: n }, () => {
    const t = rng.normal(0, 1);
    return u.map((x) => (t * x) / norm + rng.normal(0, noise));
  });
}

Deno.test("projection: PCA recovers a planted dominant direction and says it in pole words", () => {
  const rows = planted(240, 5, { heat: 0.8, moisture: -0.6 }, 0.05);
  const p = projectAxes(rows, 3);
  const c0 = p.components[0];
  assert(c0.explained > 0.8, `explained[0] = ${c0.explained}`);
  const heat = AXIS_IDS.indexOf("heat"), moisture = AXIS_IDS.indexOf("moisture");
  assert(Math.abs(c0.loadings[heat] * 0.8 - c0.loadings[moisture] * 0.6) > 0.99, "PC1 is the planted direction");
  assertEquals(c0.top.slice(0, 2).map((t) => t.axis), ["heat", "moisture"]);
  assert(c0.words.startsWith("hot vs cold, dry vs wet"), `words: "${c0.words}"`);
  assert(p.explainedTotal <= 1 + 1e-9 && p.components[1].explained < 0.05, "the rest is noise");
  assertEquals([p.coords.length, p.coords[0].length], [240, 3]);
  for (let c = 0; c < 3; c++) {
    const col = p.unit.map((r) => Math.abs(r[c]));
    assertAlmostEquals(Math.max(...col), 1, 1e-12, `unit column ${c} spans [-1, 1]`);
  }
  assertAlmostEquals(Math.max(...p.uniform.flat().map(Math.abs)), 1, 1e-12, "uniform scale");
  assertEquals(projectAxes(rows, 3), p, "same rows -> same projection");
  assertEquals(topPoles(AXIS_IDS.map((id) => (id === "luminance" ? -0.5 : 0)), 1)[0], { axis: "luminance", weight: -0.5, plus: "dark", minus: "light" });
  assertThrows(() => projectAxes([[1, 2, 3]]), "rows must have the 26 axes");
  // Real genomes go through the same path.
  const gs = Array.from({ length: 30 }, (_, i) => createGenemon({ seed: hashSeed("pca", i), level: 10 }));
  const real = projectAxes(axisRows(gs), 2);
  assertEquals(real.coords.length, 30);
  assert(real.components[0].explained >= real.components[1].explained && real.explainedTotal < 1, "sorted, partial");
});

Deno.test("projection: k-means archetypes are deterministic, split planted groups and name them", () => {
  const rng = new Rng(8);
  const blob = (heat: number, n: number) => Array.from({ length: n }, () => AXIS_IDS.map((id) => (id === "heat" ? heat : 0) + rng.normal(0, 0.08)));
  const rows = [...blob(0.8, 30), ...blob(-0.8, 20)];
  const elements: ElementId[] = [...Array(26).fill("fire"), ...Array(4).fill("neutral"), ...Array(20).fill("ice")];
  const km = clusterAxes(rows, elements, 2, 3);
  assertEquals(km.k, 2);
  assertEquals(km.clusters.map((c) => c.size), [30, 20], "ranked by size");
  assertEquals(km.clusters.reduce((s, c) => s + c.members.length, 0), rows.length);
  assertEquals([km.clusters[0].dominant, km.clusters[1].dominant], ["fire", "ice"]);
  assertAlmostEquals(km.clusters[0].dominantShare, 26 / 30, 1e-12);
  assertEquals(km.clusters[0].elements, { fire: 26, neutral: 4 });
  assertEquals([km.clusters[0].traits[0].plus, km.clusters[1].traits[0].plus], ["hot", "cold"]);
  assert(km.assignments.slice(0, 30).every((a) => a === 0) && km.assignments.slice(30).every((a) => a === 1), "assignments follow the ranks");
  km.clusters.forEach((c) => c.members.forEach((i) => assertEquals(km.assignments[i], c.id)));
  assertEquals(clusterAxes(rows, elements, 2, 3), km, "same seed -> same archetypes");
  assertEquals(clusterAxes(rows, elements, 2, 99).assignments, km.assignments, "well-separated groups do not depend on the seed");
  const curve = elbow(rows, 5, 1);
  assertEquals(curve.length, 5);
  assert(curve[1] < 0.3 * curve[0] && curve[2] > 0.9 * curve[1], `the bend is at k = 2: ${curve.map((v) => v.toFixed(1))}`);
  assertEquals(clusterAxes([], [], 3, 1).clusters, []);
  assertThrows(() => clusterAxes(rows, elements.slice(1), 2, 1));
  const gs = Array.from({ length: 24 }, (_, i) => createGenemon({ seed: hashSeed("km", i), level: 12 }));
  const real = clusterAxes(axisRows(gs), gs.map((g) => phenotypeOf(g).elements.primary), 4, 1);
  assertEquals(real.clusters.reduce((s, c) => s + c.size, 0), 24);
});
