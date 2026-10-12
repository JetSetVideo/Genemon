/**
 * Statistics toolkit for the ladder, the ML datasets and the Data screen graphs. Pure (no DOM),
 * deterministic (every random draw takes an Rng), dependency-free.
 *
 *   summaries     mean, std, quantile, median, histogram
 *   relations     correlation (Pearson), zscore, linearRegression (ridge, normal equations)
 *   confidence    wilson: 95% interval of a win rate (used by the ladder's condition tables)
 *   projection    pca: power iteration + deflation on the covariance matrix (Genospace view)
 *   clustering    kmeans: k-means++ seeding + Lloyd iterations (archetype discovery)
 *
 * Conventions:
 *   - Univariate summaries IGNORE non-finite values: one NaN sample from a broken physics step must
 *     not poison a whole digest. They return NaN when nothing finite is left (the UI shows "-").
 *   - Matrices are row-major `number[][]`: one row per sample, one column per feature.
 *   - Every random draw goes through an Rng (house rule). kmeans takes one; pca defaults to a
 *     fixed-seed Rng for its start vectors, so the same data always gives the same components.
 * Doc: docs/AI-AND-DATA.md.
 */
import { clamp } from "../core/math.ts";
import { hashSeed, Rng } from "../core/rng.ts";

type Matrix = readonly (readonly number[])[];

function finiteValues(values: readonly number[]): number[] {
  const out: number[] = [];
  for (const v of values) if (Number.isFinite(v)) out.push(v);
  return out;
}

function assertRect(rows: Matrix, d: number, who: string): void {
  for (let r = 0; r < rows.length; r++) {
    if (rows[r].length !== d) throw new Error(`${who}: row ${r} has ${rows[r].length} columns, expected ${d}`);
  }
}

function columnMeans(rows: Matrix, d: number): number[] {
  const m = new Array<number>(d).fill(0);
  for (const r of rows) for (let i = 0; i < d; i++) m[i] += r[i];
  return m.map((s) => s / Math.max(1, rows.length));
}

function dot(a: readonly number[], b: readonly number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function sqDist(a: readonly number[], b: readonly number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const t = a[i] - b[i];
    s += t * t;
  }
  return s;
}

// ------------------------------------------------------------------------------- summaries

/** Arithmetic mean of the finite values (NaN when there are none). */
export function mean(values: readonly number[]): number {
  let s = 0, n = 0;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    s += v;
    n++;
  }
  return n > 0 ? s / n : NaN;
}

/** Standard deviation of the finite values: population (divide by n) unless `sample` (n - 1). */
export function std(values: readonly number[], sample = false): number {
  const m = mean(values);
  if (Number.isNaN(m)) return NaN;
  let ss = 0, n = 0;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    ss += (v - m) * (v - m);
    n++;
  }
  const dof = sample ? n - 1 : n;
  return dof > 0 ? Math.sqrt(ss / dof) : NaN;
}

/** q-quantile (q in [0, 1]) with linear interpolation between order statistics (numpy/R type 7). */
export function quantile(values: readonly number[], q: number): number {
  const s = finiteValues(values).sort((a, b) => a - b);
  if (s.length === 0 || !Number.isFinite(q)) return NaN;
  const t = clamp(q, 0, 1) * (s.length - 1);
  const i = Math.floor(t);
  const f = t - i;
  return i + 1 < s.length ? s[i] + f * (s[i + 1] - s[i]) : s[i];
}

export function median(values: readonly number[]): number {
  return quantile(values, 0.5);
}

export interface Histogram {
  /** bins + 1 edges, ascending. */
  edges: number[];
  /** counts[i] covers [edges[i], edges[i+1]); the last bin also includes its upper edge. */
  counts: number[];
}

/**
 * Equal-width histogram. Without a range the data's own [min, max] is used; a degenerate range
 * (all values equal, or no data) is widened to +-0.5 so the edges stay strictly increasing.
 * Values outside an explicit range are not counted.
 */
export function histogram(values: readonly number[], bins: number, range?: readonly [number, number]): Histogram {
  const nb = Math.max(1, Math.floor(Number.isFinite(bins) ? bins : 1));
  const xs = finiteValues(values);
  let lo = range ? range[0] : Infinity;
  let hi = range ? range[1] : -Infinity;
  if (!range) {
    for (const v of xs) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  if (!(hi > lo)) {
    const c = Number.isFinite(lo) ? lo : Number.isFinite(hi) ? hi : 0;
    lo = c - 0.5;
    hi = c + 0.5;
  }
  const width = (hi - lo) / nb;
  const edges = Array.from({ length: nb + 1 }, (_, i) => (i === nb ? hi : lo + i * width));
  const counts = new Array<number>(nb).fill(0);
  for (const v of xs) {
    if (v < lo || v > hi) continue;
    counts[Math.min(nb - 1, Math.floor((v - lo) / width))]++;
  }
  return { edges, counts };
}

// ------------------------------------------------------------------------------- relations

/**
 * Pearson correlation over the pairs where both values are finite. NaN when it is undefined
 * (fewer than 2 pairs or a constant series) - a 0 would wrongly read as "no relation".
 */
export function correlation(x: readonly number[], y: readonly number[]): number {
  if (x.length !== y.length) throw new Error(`correlation: length mismatch ${x.length} vs ${y.length}`);
  let n = 0, sx = 0, sy = 0;
  for (let i = 0; i < x.length; i++) {
    if (!Number.isFinite(x[i]) || !Number.isFinite(y[i])) continue;
    n++;
    sx += x[i];
    sy += y[i];
  }
  if (n < 2) return NaN;
  const mx = sx / n, my = sy / n;
  let cxy = 0, cxx = 0, cyy = 0;
  for (let i = 0; i < x.length; i++) {
    if (!Number.isFinite(x[i]) || !Number.isFinite(y[i])) continue;
    const dx = x[i] - mx, dy = y[i] - my;
    cxy += dx * dy;
    cxx += dx * dx;
    cyy += dy * dy;
  }
  const den = Math.sqrt(cxx * cyy);
  return den > 0 ? clamp(cxy / den, -1, 1) : NaN;
}

/** (v - mean) / std (population). A constant series maps to zeros; non-finite values stay NaN. */
export function zscore(values: readonly number[]): number[] {
  const m = mean(values), s = std(values);
  return values.map((v) => (!Number.isFinite(v) ? NaN : s > 0 ? (v - m) / s : 0));
}

export interface LinearModel {
  weights: number[];
  intercept: number;
  /** Coefficient of determination on the training rows (1 = perfect fit). */
  r2: number;
}

/** Solve A x = b for a symmetric positive (semi-)definite A by Cholesky; null when not positive. */
function cholesky(A: readonly (readonly number[])[], b: readonly number[], jitter: number): number[] | null {
  const d = A.length;
  const L = Array.from({ length: d }, () => new Array<number>(d).fill(0));
  for (let i = 0; i < d; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i][j] + (i === j ? jitter : 0);
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
      if (i === j) {
        if (!(s > 0)) return null;
        L[i][i] = Math.sqrt(s);
      } else {
        L[i][j] = s / L[j][j];
      }
    }
  }
  const z = new Array<number>(d).fill(0);
  for (let i = 0; i < d; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= L[i][k] * z[k];
    z[i] = s / L[i][i];
  }
  const x = new Array<number>(d).fill(0);
  for (let i = d - 1; i >= 0; i--) {
    let s = z[i];
    for (let k = i + 1; k < d; k++) s -= L[k][i] * x[k];
    x[i] = s / L[i][i];
  }
  return x;
}

/**
 * Ridge least squares by the normal equations on CENTRED data (the intercept is never penalised):
 * (Xc'Xc + lambda I) w = Xc'yc, intercept = mean(y) - w . mean(x). `lambda` is added to the Gram
 * matrix as-is (scikit-learn convention); the small default only stabilises collinear columns.
 * Rows containing a non-finite value are skipped. A singular system gets escalating diagonal jitter.
 */
export function linearRegression(x: Matrix, y: readonly number[], lambda = 1e-6): LinearModel {
  if (x.length !== y.length) throw new Error(`linearRegression: ${x.length} rows but ${y.length} targets`);
  if (x.length === 0) throw new Error("linearRegression: no rows");
  const d = x[0].length;
  assertRect(x, d, "linearRegression");
  const keep: number[] = [];
  for (let r = 0; r < x.length; r++) if (Number.isFinite(y[r]) && x[r].every(Number.isFinite)) keep.push(r);
  if (keep.length === 0) throw new Error("linearRegression: no finite rows");
  const rows = keep.map((r) => x[r]);
  const ys = keep.map((r) => y[r]);
  const n = rows.length;
  const xm = columnMeans(rows, d);
  const ym = ys.reduce((s, v) => s + v, 0) / n;
  const G = Array.from({ length: d }, () => new Array<number>(d).fill(0));
  const b = new Array<number>(d).fill(0);
  for (let r = 0; r < n; r++) {
    const dy = ys[r] - ym;
    for (let i = 0; i < d; i++) {
      const xi = rows[r][i] - xm[i];
      b[i] += xi * dy;
      for (let j = 0; j <= i; j++) G[i][j] += xi * (rows[r][j] - xm[j]);
    }
  }
  let trace = 0;
  for (let i = 0; i < d; i++) {
    for (let j = 0; j < i; j++) G[j][i] = G[i][j];
    G[i][i] += Math.max(0, lambda);
    trace += G[i][i];
  }
  let w: number[] | null = null;
  let jitter = 0;
  for (let attempt = 0; attempt < 10 && !w; attempt++) {
    w = cholesky(G, b, jitter);
    jitter = jitter === 0 ? 1e-12 * Math.max(1, trace / Math.max(1, d)) : jitter * 100;
  }
  const weights = w ?? new Array<number>(d).fill(0);
  const intercept = ym - dot(weights, xm);
  let ssRes = 0, ssTot = 0;
  for (let r = 0; r < n; r++) {
    const e = ys[r] - (intercept + dot(weights, rows[r]));
    ssRes += e * e;
    ssTot += (ys[r] - ym) * (ys[r] - ym);
  }
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : ssRes <= 1e-12 ? 1 : 0;
  return { weights, intercept, r2 };
}

// ------------------------------------------------------------------------------- confidence

export interface Interval {
  /** Observed proportion wins / n (0 by convention when n = 0). */
  p: number;
  lo: number;
  hi: number;
}

/**
 * Wilson score interval for a proportion (default z = 1.96, i.e. 95%). Unlike the normal
 * approximation it stays inside [0, 1] and is honest at small n (3/3 wins is NOT "100% +- 0").
 * n = 0 returns the whole [0, 1]: nothing is known.
 */
export function wilson(wins: number, n: number, z = 1.96): Interval {
  if (!(n > 0)) return { p: 0, lo: 0, hi: 1 };
  const k = clamp(wins, 0, n);
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { p, lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}

// ------------------------------------------------------------------------------- projection

export interface PCAResult {
  /** k unit vectors (d values each), sorted by decreasing variance; sign: largest |entry| positive. */
  components: number[][];
  /** Share of the total variance carried by each component (ratios in [0, 1]). */
  explained: number[];
  /** Variance along each component (eigenvalues of the sample covariance). */
  eigenvalues: number[];
  /** rows projected on the components: n x k. */
  projected: number[][];
  /** Column means that were subtracted before projecting. */
  mean: number[];
}

function orthogonalize(v: number[], basis: readonly (readonly number[])[]): void {
  for (const u of basis) {
    const p = dot(v, u);
    for (let i = 0; i < v.length; i++) v[i] -= p * u[i];
  }
}

/**
 * Principal component analysis by power iteration + deflation on the sample covariance matrix.
 * Each iterate is also re-orthogonalised against the components already found, which keeps
 * deflation error from leaking earlier directions back in. k is clamped to [0, d]; directions
 * with zero variance come back as arbitrary orthonormal vectors with eigenvalue 0.
 */
export function pca(rows: Matrix, k: number, rng: Rng = new Rng(hashSeed("stats.pca"))): PCAResult {
  const n = rows.length;
  if (n === 0) return { components: [], explained: [], eigenvalues: [], projected: [], mean: [] };
  const d = rows[0].length;
  assertRect(rows, d, "pca");
  const mu = columnMeans(rows, d);
  const C = Array.from({ length: d }, () => new Array<number>(d).fill(0));
  for (const r of rows) {
    for (let i = 0; i < d; i++) {
      const ci = r[i] - mu[i];
      for (let j = 0; j <= i; j++) C[i][j] += ci * (r[j] - mu[j]);
    }
  }
  const div = Math.max(1, n - 1);
  let trace = 0;
  for (let i = 0; i < d; i++) {
    for (let j = 0; j <= i; j++) {
      C[i][j] /= div;
      C[j][i] = C[i][j];
    }
    trace += C[i][i];
  }
  const kk = clamp(Math.floor(Number.isFinite(k) ? k : 0), 0, d);
  const A = C.map((row) => row.slice());
  const components: number[][] = [];
  const eigenvalues: number[] = [];
  for (let c = 0; c < kk; c++) {
    let v = Array.from({ length: d }, () => rng.normal());
    orthogonalize(v, components);
    let nv = Math.sqrt(dot(v, v));
    if (!(nv > 1e-9)) {
      // Pathological draw: fall back to the first basis vector outside the current span.
      for (let e = 0; e < d && !(nv > 1e-9); e++) {
        v = new Array<number>(d).fill(0);
        v[e] = 1;
        orthogonalize(v, components);
        nv = Math.sqrt(dot(v, v));
      }
    }
    v = v.map((x) => x / nv);
    for (let it = 0; it < 1000; it++) {
      const w = A.map((row) => dot(row, v));
      orthogonalize(w, components);
      const nw = Math.sqrt(dot(w, w));
      if (nw === 0 || nw <= 1e-12 * trace) break; // the remaining spectrum is ~0: keep v
      for (let i = 0; i < d; i++) w[i] /= nw;
      const align = Math.abs(dot(w, v));
      v = w;
      if (1 - align < 1e-14) break;
    }
    let big = 0;
    for (let i = 1; i < d; i++) if (Math.abs(v[i]) > Math.abs(v[big]) + 1e-12) big = i;
    if (v[big] < 0) v = v.map((x) => -x);
    const lambda = Math.max(0, dot(v, C.map((row) => dot(row, v))));
    components.push(v);
    eigenvalues.push(lambda);
    for (let i = 0; i < d; i++) for (let j = 0; j < d; j++) A[i][j] -= lambda * v[i] * v[j];
  }
  const explained = eigenvalues.map((l) => (trace > 0 ? l / trace : 0));
  const projected = rows.map((r) => {
    const centred = r.map((x, i) => x - mu[i]);
    return components.map((u) => dot(centred, u));
  });
  return { components, explained, eigenvalues, projected, mean: mu };
}

// ------------------------------------------------------------------------------- clustering

export interface KMeansResult {
  centroids: number[][];
  /** Cluster index per row. */
  assignments: number[];
  /** Sum of squared distances of every row to its centroid (the elbow-plot quantity). */
  inertia: number;
  /** Lloyd updates performed before convergence (or the iteration cap). */
  iterations: number;
}

/**
 * k-means with k-means++ seeding (each new seed drawn with probability proportional to its squared
 * distance to the nearest existing seed) followed by Lloyd iterations until the assignments stop
 * changing or `iters` updates ran. Ties go to the lowest cluster index; an empty cluster is
 * re-seeded on the row farthest from its centroid. k is clamped to the number of rows.
 */
export function kmeans(rows: Matrix, k: number, rng: Rng, iters = 50): KMeansResult {
  const n = rows.length;
  if (!(k >= 1)) throw new Error(`kmeans: k must be >= 1 (got ${k})`);
  if (n === 0) return { centroids: [], assignments: [], inertia: 0, iterations: 0 };
  const d = rows[0].length;
  assertRect(rows, d, "kmeans");
  const kk = Math.min(Math.floor(k), n);
  const centroids: number[][] = [rows[rng.int(0, n - 1)].slice()];
  const nearest = rows.map((r) => sqDist(r, centroids[0]));
  const index = Array.from({ length: n }, (_, i) => i);
  while (centroids.length < kk) {
    const c = rows[rng.weighted(index, nearest)].slice();
    centroids.push(c);
    for (let i = 0; i < n; i++) nearest[i] = Math.min(nearest[i], sqDist(rows[i], c));
  }
  const assignments = new Array<number>(n).fill(-1);
  const assign = (): boolean => {
    let changed = false;
    for (let i = 0; i < n; i++) {
      let best = 0, bestD = Infinity;
      for (let c = 0; c < centroids.length; c++) {
        const dd = sqDist(rows[i], centroids[c]);
        if (dd < bestD) {
          bestD = dd;
          best = c;
        }
      }
      if (assignments[i] !== best) {
        assignments[i] = best;
        changed = true;
      }
    }
    return changed;
  };
  const update = (): void => {
    const sums = centroids.map(() => new Array<number>(d).fill(0));
    const counts = new Array<number>(centroids.length).fill(0);
    for (let i = 0; i < n; i++) {
      counts[assignments[i]]++;
      for (let j = 0; j < d; j++) sums[assignments[i]][j] += rows[i][j];
    }
    const used = new Set<number>();
    for (let c = 0; c < centroids.length; c++) {
      if (counts[c] > 0) {
        centroids[c] = sums[c].map((s) => s / counts[c]);
        continue;
      }
      let far = -1, farD = -1;
      for (let i = 0; i < n; i++) {
        if (used.has(i)) continue;
        const dd = sqDist(rows[i], centroids[assignments[i]]);
        if (dd > farD) {
          farD = dd;
          far = i;
        }
      }
      if (far >= 0) {
        used.add(far);
        centroids[c] = rows[far].slice();
      }
    }
  };
  let iterations = 0;
  for (; iterations < Math.max(1, Math.floor(iters)); iterations++) {
    if (!assign()) break;
    update();
  }
  assign();
  let inertia = 0;
  for (let i = 0; i < n; i++) inertia += sqDist(rows[i], centroids[assignments[i]]);
  return { centroids, assignments, inertia, iterations };
}
