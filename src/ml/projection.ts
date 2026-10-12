/**
 * Genome projections for the Insights screen (docs/AI-AND-DATA.md §9 Genospace PCA, §10 archetypes):
 * where the diversity of a Genemon population lies, said in words. Pure and deterministic.
 *
 *   axisRows      one row per Genemon: its 26 expressed opposite-pole axes, in AXIS_IDS order
 *   projectAxes   PCA on the covariance (power iteration + deflation, stats.pca; every axis is in
 *                 [-1, 1], one shared unit, so no z-scoring): coordinates, explained variance per
 *                 component and each component's top axis loadings as pole words
 *                 ("hot vs cold, dry vs wet": the + end of the component vs its - end)
 *   clusterAxes   seeded k-means++ (stats.kmeans) on the full 26-D vectors: archetypes ranked by
 *                 size, with their dominant primary element and the poles that set the centroid
 *                 apart from the population mean
 *   elbow         k-means inertia for k = 1..kMax (pick k where the curve bends)
 */
import { hashSeed, Rng } from "../core/rng.ts";
import { AXIS_BY_ID, AXIS_IDS, type AxisId } from "../data/axes.ts";
import { ELEMENT_IDS, type ElementId } from "../data/elements.ts";
import { type Genemon, phenotypeOf } from "../genome/genemon.ts";
import { kmeans, pca } from "./stats.ts";

type Rows = readonly (readonly number[])[];

/** The 26 expressed axes of every Genemon (AXIS_IDS order), one row each. */
export function axisRows(gs: readonly Genemon[]): number[][] {
  return gs.map((g) => {
    const ax = phenotypeOf(g).axes;
    return AXIS_IDS.map((id) => ax[id]);
  });
}

export interface PoleLoading {
  axis: AxisId;
  /** The axis' weight (a component loading, or a centroid's offset from the mean). */
  weight: number;
  /** Pole reached moving toward + ("hot" for heat +0.6, "dry" for moisture -0.5). */
  plus: string;
  /** The opposite pole. */
  minus: string;
}

/** The n axes with the largest |weight|, as pole pairs (ties keep the AXIS_IDS order). */
export function topPoles(weights: readonly number[], n = 3): PoleLoading[] {
  if (weights.length !== AXIS_IDS.length) {
    throw new Error(`topPoles: expected ${AXIS_IDS.length} axis weights, got ${weights.length}`);
  }
  return weights
    .map((w, i) => ({ w, i }))
    .sort((a, b) => Math.abs(b.w) - Math.abs(a.w) || a.i - b.i)
    .slice(0, Math.max(0, Math.floor(n)))
    .map(({ w, i }) => {
      const ax = AXIS_BY_ID[AXIS_IDS[i]];
      return { axis: ax.id, weight: w, plus: w >= 0 ? ax.pos : ax.neg, minus: w >= 0 ? ax.neg : ax.pos };
    });
}

export interface ComponentSummary {
  /** 0-based (PC1 = 0). */
  index: number;
  /** Share of the total variance (0..1). */
  explained: number;
  /** Variance along the component (eigenvalue of the covariance). */
  variance: number;
  /** Unit vector over the 26 axes; sign fixed so the largest |entry| is positive. */
  loadings: number[];
  top: PoleLoading[];
  /** "hot vs cold, dry vs wet, wild vs calm" (+ end pole vs - end pole, strongest axis first). */
  words: string;
}

export interface AxisProjection {
  /** n x k coordinates, centred on the population mean. */
  coords: number[][];
  /** coords divided per component by its largest |value|: every column spans [-1, 1] (2D charts). */
  unit: number[][];
  /** coords divided by ONE common scale (the largest |value| overall): the geometry is kept (3D). */
  uniform: number[][];
  components: ComponentSummary[];
  /** Share of the variance the k components carry together. */
  explainedTotal: number;
  /** Population mean axis vector. */
  mean: number[];
}

/** PCA of 26-axis rows: k components (clamped to [0, 26]), coordinates and loadings in words. */
export function projectAxes(rows: Rows, k = 3, topN = 3): AxisProjection {
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].length !== AXIS_IDS.length) {
      throw new Error(`projectAxes: row ${i} has ${rows[i].length} values, expected ${AXIS_IDS.length} axes`);
    }
  }
  const p = pca(rows, k);
  const kk = p.components.length;
  const colMax = Array.from({ length: kk }, (_, c) => p.projected.reduce((m, r) => Math.max(m, Math.abs(r[c])), 0));
  const all = colMax.reduce((m, v) => Math.max(m, v), 0);
  return {
    coords: p.projected,
    unit: p.projected.map((r) => r.map((v, c) => (colMax[c] > 0 ? v / colMax[c] : 0))),
    uniform: p.projected.map((r) => r.map((v) => (all > 0 ? v / all : 0))),
    components: p.components.map((v, c) => {
      const top = topPoles(v, topN);
      return {
        index: c,
        explained: p.explained[c],
        variance: p.eigenvalues[c],
        loadings: v.slice(),
        top,
        words: top.map((t) => `${t.plus} vs ${t.minus}`).join(", "),
      };
    }),
    explainedTotal: p.explained.reduce((s, e) => s + e, 0),
    mean: p.mean,
  };
}

export interface ClusterSummary {
  /** Rank by size: 0 = the largest archetype. */
  id: number;
  size: number;
  /** size / rows. */
  share: number;
  centroid: number[];
  /** Most common primary element among the members (ties: ELEMENT_IDS order). */
  dominant: ElementId;
  dominantShare: number;
  /** Primary-element counts of the members. */
  elements: Partial<Record<ElementId, number>>;
  /** The poles that set the centroid apart from the population mean, strongest first. */
  traits: PoleLoading[];
  /** "hot · dry · wild". */
  words: string;
  /** Row indices of the members, ascending. */
  members: number[];
}

export interface AxisClustering {
  /** Clusters actually populated (<= the k asked). */
  k: number;
  clusters: ClusterSummary[];
  /** Cluster id (size rank) of every row. */
  assignments: number[];
  /** Sum of squared distances to the centroids. */
  inertia: number;
  iterations: number;
}

/**
 * Seeded k-means++ archetypes of 26-axis rows. `elements` (the primary element of each row) feeds
 * the dominant-element summary. Clusters are ranked by size (ties: the smallest member index).
 */
export function clusterAxes(rows: Rows, elements: readonly ElementId[], k: number, seed: number, traitsN = 3): AxisClustering {
  if (elements.length !== rows.length) throw new Error(`clusterAxes: ${rows.length} rows but ${elements.length} elements`);
  if (rows.length === 0) return { k: 0, clusters: [], assignments: [], inertia: 0, iterations: 0 };
  const km = kmeans(rows, k, new Rng(hashSeed(seed, "projection.kmeans")));
  const d = rows[0].length;
  const mean = Array.from({ length: d }, (_, j) => rows.reduce((s, r) => s + r[j], 0) / rows.length);
  const groups = km.centroids.map((_, c) => ({ c, members: [] as number[] }));
  km.assignments.forEach((c, i) => groups[c].members.push(i));
  const live = groups.filter((g) => g.members.length > 0)
    .sort((a, b) => b.members.length - a.members.length || a.members[0] - b.members[0]);
  const rank = new Map(live.map((g, i) => [g.c, i]));
  const clusters = live.map((g, id): ClusterSummary => {
    const counts: Partial<Record<ElementId, number>> = {};
    for (const i of g.members) counts[elements[i]] = (counts[elements[i]] ?? 0) + 1;
    let dominant: ElementId = elements[g.members[0]];
    let best = 0;
    for (const e of ELEMENT_IDS) {
      const n = counts[e] ?? 0;
      if (n > best) {
        best = n;
        dominant = e;
      }
    }
    const centroid = km.centroids[g.c].slice();
    const traits = topPoles(centroid.map((v, j) => v - mean[j]), traitsN);
    return {
      id,
      size: g.members.length,
      share: g.members.length / rows.length,
      centroid,
      dominant,
      dominantShare: best / g.members.length,
      elements: counts,
      traits,
      words: traits.map((t) => t.plus).join(" · "),
      members: g.members,
    };
  });
  return {
    k: clusters.length,
    clusters,
    assignments: km.assignments.map((c) => rank.get(c) ?? -1),
    inertia: km.inertia,
    iterations: km.iterations,
  };
}

/** k-means inertia for k = 1..kMax (capped at the row count), each k with its own seeded start. */
export function elbow(rows: Rows, kMax: number, seed: number): number[] {
  const out: number[] = [];
  for (let k = 1; k <= Math.min(Math.floor(kMax), rows.length); k++) {
    out.push(kmeans(rows, k, new Rng(hashSeed(seed, "projection.elbow", k))).inertia);
  }
  return out;
}
