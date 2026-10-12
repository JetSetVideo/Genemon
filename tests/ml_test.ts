import { assert, assertAlmostEquals, assertEquals, assertThrows } from "./_assert.ts";
import { Rng } from "../src/core/rng.ts";
import { MLP, type MLPJSON, predictOutcomeModel, type Sample } from "../src/ml/mlp.ts";
import {
  correlation,
  histogram,
  kmeans,
  linearRegression,
  mean,
  median,
  pca,
  quantile,
  std,
  wilson,
  zscore,
} from "../src/ml/stats.ts";

const XOR: Sample[] = [
  { x: [0, 0], y: [0] },
  { x: [0, 1], y: [1] },
  { x: [1, 0], y: [1] },
  { x: [1, 1], y: [0] },
];

// ------------------------------------------------------------------------------------ stats

Deno.test("stats: mean/std/quantile/median, non-finite values ignored", () => {
  assertEquals(mean([1, 2, 3, 4]), 2.5);
  assertAlmostEquals(std([2, 4, 4, 4, 5, 5, 7, 9]), 2, 1e-12, "population std");
  assertAlmostEquals(std([2, 4, 4, 4, 5, 5, 7, 9], true), Math.sqrt(32 / 7), 1e-12, "sample std");
  assertAlmostEquals(quantile([1, 2, 3, 4], 0.25), 1.75, 1e-12, "numpy type-7 interpolation");
  assertEquals(quantile([1, 2, 3, 4], 0), 1);
  assertEquals(quantile([1, 2, 3, 4], 1), 4);
  assertEquals(median([3, 1, 2]), 2);
  assertEquals(median([4, 1, 3, 2]), 2.5);
  assertEquals(mean([1, NaN, 3, Infinity]), 2);
  assertEquals(median([5, NaN, 1]), 3);
  assert(Number.isNaN(mean([])) && Number.isNaN(std([NaN])) && Number.isNaN(median([])), "empty -> NaN");
  assertEquals(std([7]), 0);
  assert(Number.isNaN(std([7], true)), "sample std of one value is undefined");
});

Deno.test("stats: histogram edges/counts, max in the last bin, degenerate and explicit ranges", () => {
  const h = histogram([0, 1, 2, 3, 4], 4);
  assertEquals(h.edges, [0, 1, 2, 3, 4]);
  assertEquals(h.counts, [1, 1, 1, 2]);
  const flat = histogram([5, 5, 5], 2);
  assertEquals(flat.edges, [4.5, 5, 5.5]);
  assertEquals(flat.counts, [0, 3]);
  assertEquals(histogram([-1, 0.5, 3, NaN], 2, [0, 2]).counts, [1, 0]);
  const empty = histogram([], 3);
  assertEquals(empty.counts, [0, 0, 0]);
  assertEquals(empty.edges.length, 4);
});

Deno.test("stats: correlation and zscore", () => {
  assertAlmostEquals(correlation([1, 2, 3, 4], [2, 4, 6, 8]), 1, 1e-12);
  assertAlmostEquals(correlation([1, 2, 3, 4], [8, 6, 4, 2]), -1, 1e-12);
  assertAlmostEquals(correlation([1, 2, 3, 4, NaN], [1, 3, 2, 4, 9]), 0.8, 1e-12, "the NaN pair is skipped");
  assert(Number.isNaN(correlation([1, 1, 1], [1, 2, 3])), "constant series -> undefined");
  assertThrows(() => correlation([1, 2], [1]), "length mismatch must throw");
  const z = zscore([1, 2, 3]);
  assertAlmostEquals(z[0], -Math.sqrt(1.5), 1e-12);
  assertAlmostEquals(z[1], 0, 1e-12);
  assertAlmostEquals(mean(z), 0, 1e-12);
  assertAlmostEquals(std(z), 1, 1e-12);
  assertEquals(zscore([4, 4]), [0, 0]);
});

Deno.test("stats: Wilson interval contains p and narrows with n", () => {
  let width = Infinity;
  for (const n of [5, 20, 80, 320, 1280]) {
    const ci = wilson(0.3 * n, n);
    assertAlmostEquals(ci.p, 0.3, 1e-12);
    assert(ci.lo <= ci.p && ci.p <= ci.hi, `n=${n}: [${ci.lo}, ${ci.hi}] must contain ${ci.p}`);
    assert(ci.hi - ci.lo < width, `n=${n}: interval must narrow`);
    width = ci.hi - ci.lo;
  }
  const known = wilson(5, 10);
  assertAlmostEquals(known.lo, 0.236590, 1e-6);
  assertAlmostEquals(known.hi, 0.763410, 1e-6);
  assertEquals(wilson(0, 0), { p: 0, lo: 0, hi: 1 });
  assertEquals(wilson(0, 10).lo, 0);
  assertEquals(wilson(10, 10).hi, 1);
  assert(wilson(3, 3).lo < 0.5, "3/3 is not certainty");
});

Deno.test("stats: PCA recovers the main direction of an elongated cloud", () => {
  const rng = new Rng(3);
  const dir = [Math.cos(0.6), Math.sin(0.6)];
  const rows = Array.from({ length: 300 }, () => {
    const t = rng.normal(0, 3), s = rng.normal(0, 0.4);
    return [5 + t * dir[0] - s * dir[1], -2 + t * dir[1] + s * dir[0]];
  });
  const p = pca(rows, 2);
  const cos = p.components[0][0] * dir[0] + p.components[0][1] * dir[1];
  assert(Math.abs(cos) > 0.95, `|cos| = ${Math.abs(cos)}`);
  assert(p.explained[0] > 0.8, `explained[0] = ${p.explained[0]}`);
  assertAlmostEquals(p.explained[0] + p.explained[1], 1, 1e-9, "k = d explains everything");
  assertAlmostEquals(
    p.components[0][0] * p.components[1][0] + p.components[0][1] * p.components[1][1],
    0,
    1e-9,
  );
  assertAlmostEquals(Math.hypot(...p.components[1]), 1, 1e-12);
  assertEquals([p.projected.length, p.projected[0].length], [300, 2]);
  assertAlmostEquals(mean(p.projected.map((r) => r[0])), 0, 1e-9, "projection is centred");
  assertAlmostEquals(p.mean[0], mean(rows.map((r) => r[0])), 1e-12);
  // 3-D cloud lying in a plane: the third direction carries no variance.
  const plane = rows.map((r) => [r[0], r[1], 2 * r[0] - r[1]]);
  const p3 = pca(plane, 3);
  assert(p3.explained[2] < 1e-9, `planar data: explained[2] = ${p3.explained[2]}`);
  assertEquals(pca(rows, 2), p, "same data -> same components (fixed-seed start vectors)");
  assertEquals(pca([], 2).components, []);
});

Deno.test("stats: kmeans separates two well-separated blobs (k-means++, deterministic)", () => {
  const rng = new Rng(11);
  const rows = [
    ...Array.from({ length: 40 }, () => [rng.normal(0, 0.5), rng.normal(0, 0.5)]),
    ...Array.from({ length: 40 }, () => [rng.normal(8, 0.5), rng.normal(8, 0.5)]),
  ];
  const km = kmeans(rows, 2, new Rng(5));
  const first = km.assignments[0], second = km.assignments[40];
  assert(first !== second, "the blobs must get different clusters");
  assert(km.assignments.slice(0, 40).every((a) => a === first), "blob A is one cluster");
  assert(km.assignments.slice(40).every((a) => a === second), "blob B is one cluster");
  assert(Math.hypot(km.centroids[first][0], km.centroids[first][1]) < 0.5, "centroid A near the origin");
  assert(
    Math.hypot(km.centroids[second][0] - 8, km.centroids[second][1] - 8) < 0.5,
    "centroid B near (8, 8)",
  );
  assert(km.inertia < 80 * 2 * 0.5, `inertia ${km.inertia} should be ~ n * d * sigma^2`);
  assertEquals(kmeans(rows, 2, new Rng(5)), km, "same seed -> same clustering");
  assertEquals(kmeans(rows.slice(0, 3), 10, new Rng(1)).centroids.length, 3, "k clamps to n");
  assertThrows(() => kmeans(rows, 0, new Rng(1)));
});

Deno.test("stats: ridge linearRegression recovers known coefficients and survives collinearity", () => {
  const rng = new Rng(9);
  const x: number[][] = [], y: number[] = [];
  for (let i = 0; i < 200; i++) {
    const a = rng.range(-1, 1), b = rng.range(-1, 1);
    x.push([a, b]);
    y.push(1 + 2 * a - 3 * b + rng.normal(0, 0.05));
  }
  const m = linearRegression(x, y);
  assertAlmostEquals(m.weights[0], 2, 0.05);
  assertAlmostEquals(m.weights[1], -3, 0.05);
  assertAlmostEquals(m.intercept, 1, 0.05);
  assert(m.r2 > 0.99, `r2 ${m.r2}`);
  const dup = linearRegression(x.map((r) => [r[0], r[0]]), y);
  assert(dup.weights.every(Number.isFinite), "duplicated column must not produce NaN");
  assertAlmostEquals(dup.weights[0] + dup.weights[1], 2, 0.2, "collinear columns share the slope");
  assertThrows(() => linearRegression([], []));
});

// ------------------------------------------------------------------------------------ MLP

Deno.test("mlp: learns XOR (cross-entropy < 0.05, rounded predictions correct)", () => {
  const net = new MLP([2, 4, 1], new Rng(1));
  const curve = net.fit(XOR, { epochs: 2000, lr: 0.5, batchSize: 4, rng: new Rng(2) });
  assertEquals(curve.length, 2000);
  assert(curve[curve.length - 1] < 0.05, `final training loss ${curve[curve.length - 1]}`);
  assert(net.loss(XOR) < 0.05, `evaluated loss ${net.loss(XOR)}`);
  assert(curve[curve.length - 1] < curve[0], "the loss curve must go down");
  for (const s of XOR) assertEquals(Math.round(net.forward(s.x)[0]), s.y[0], `XOR(${s.x})`);
  assertEquals(net.paramCount, 2 * 4 + 4 + 4 * 1 + 1);
});

Deno.test("mlp: toJSON/fromJSON round trip gives identical outputs and identical further training", () => {
  const net = new MLP([3, 5, 2], new Rng(4), "relu", "linear");
  const data: Sample[] = Array.from(
    { length: 16 },
    (_, i) => ({ x: [i / 16, Math.sin(i), 1 - i / 8], y: [i / 16, -i / 32] }),
  );
  net.fit(data, { epochs: 20, lr: 0.05, batchSize: 4, rng: new Rng(1) });
  const copy = MLP.fromJSON(JSON.parse(JSON.stringify(net)) as MLPJSON);
  for (const s of data) assertEquals(copy.forward(s.x), net.forward(s.x));
  assertEquals(copy.trainBatch(data.slice(0, 4), 0.05), net.trainBatch(data.slice(0, 4), 0.05));
  assertEquals(copy.toJSON(), net.toJSON());
  const bad = net.toJSON();
  bad.weights[0].pop();
  assertThrows(() => MLP.fromJSON(bad), "a malformed shape must be rejected");
});

Deno.test("mlp: same seed gives identical weights and loss curves; different seeds differ", () => {
  const a = new MLP([2, 6, 1], new Rng(42));
  const b = new MLP([2, 6, 1], new Rng(42));
  const c = new MLP([2, 6, 1], new Rng(43));
  assertEquals(a.toJSON(), b.toJSON());
  assert(JSON.stringify(a.toJSON()) !== JSON.stringify(c.toJSON()), "another seed must give another network");
  const ca = a.fit(XOR, { epochs: 50, lr: 0.3, batchSize: 2, rng: new Rng(7) });
  const cb = b.fit(XOR, { epochs: 50, lr: 0.3, batchSize: 2, rng: new Rng(7) });
  assertEquals(ca, cb);
  assertEquals(a.toJSON(), b.toJSON());
});

Deno.test("mlp: linear output + MSE regression; relu hidden layer trains too", () => {
  const data: Sample[] = Array.from({ length: 40 }, (_, i) => {
    const x = -Math.PI + (2 * Math.PI * i) / 39;
    return { x: [x / Math.PI], y: [Math.sin(x)] };
  });
  for (const hidden of ["tanh", "relu"] as const) {
    const net = new MLP([1, 16, 1], new Rng(5), hidden, "linear");
    const start = net.loss(data);
    const curve = net.fit(data, { epochs: 1500, lr: 0.05, batchSize: 8, rng: new Rng(6) });
    const end = net.loss(data);
    assert(
      end < 0.02 && end < start / 10,
      `${hidden}: MSE ${start} -> ${end} (last epoch ${curve[curve.length - 1]})`,
    );
  }
});

Deno.test("mlp: rejects malformed shapes and predictOutcomeModel learns a deciding feature", () => {
  assertThrows(() => new MLP([2], new Rng(1)), "one layer");
  assertThrows(() => new MLP([2, 0, 1], new Rng(1)), "empty layer");
  const net = new MLP([2, 3, 1], new Rng(1));
  assertThrows(() => net.forward([1]), "wrong input size");
  assertThrows(() => net.trainBatch([{ x: [1, 2], y: [1, 0] }], 0.1), "wrong target size");
  assertThrows(() => net.trainBatch([], 0.1), "empty batch");
  assertThrows(() => predictOutcomeModel([], new Rng(1)), "no rows");

  const rng = new Rng(8);
  const rows = Array.from({ length: 300 }, () => {
    const f = [rng.range(-1, 1), rng.range(-1, 1)];
    return { features: f, win: f[0] > 0 ? 1 : 0 };
  });
  const model = predictOutcomeModel(rows, new Rng(2));
  assert(model.forward([0.7, 0])[0] > 0.8, `P(win | +0.7) = ${model.forward([0.7, 0])[0]}`);
  assert(model.forward([-0.7, 0])[0] < 0.2, `P(win | -0.7) = ${model.forward([-0.7, 0])[0]}`);
  assertEquals(predictOutcomeModel(rows, new Rng(2)).toJSON(), model.toJSON(), "same seed -> same model");
});
