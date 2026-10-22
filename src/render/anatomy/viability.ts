/**
 * Viability [P5-V3]: after growth and the morph operators, is the body still ONE connected creature with
 * nothing floating outside it and nothing lost inside it? A pure check over the built BodyParts at the
 * skeleton's REST positions (every joint frame un-rotated, so joint i's meshes sit at restPositions(sk)[i]):
 *
 * - connectivity: every mesh must touch or overlap a mesh of its own joint, its parent, its grandparent or a
 *   child (vertex distance <= tol, or a vertex inside the other's closed volume); a union-find over those
 *   anatomical links must reach the ROOT's component. Joints without body meshes (the head and the jaw: the
 *   face lane builds them) are stood in for by the head / jaw ellipsoid volumes creature.ts places, so horns
 *   and ears connect to something real.
 * - buried: a closed mesh whose sampled vertices ALL lie inside the union of the closed meshes of its own
 *   joint, its parent and its grandparent (generalised winding number >= 0.5: robust to overlapping parts)
 *   can never be seen: reported.
 *
 * Wing surfaces (open sheets) only take part through the distance test and are never containers.
 * A metric that cannot fail is not a metric: tests fabricate a floating part and a buried part.
 */
import * as THREE from "../../lib/three.ts";
import type { Skeleton } from "../../body/skeleton.ts";
import type { BodyParts } from "./types.ts";
import { restPositions } from "./hitbox.ts";

export interface ViabilityIssue {
  joint: number;
  id: string;
  mesh: string;
  kind: "floating" | "buried";
  /** floating: distance (m) to the nearest anatomical neighbour; buried: share of sampled vertices inside. */
  detail: number;
}

export interface ViabilityReport {
  ok: boolean;
  floating: ViabilityIssue[];
  buried: ViabilityIssue[];
  /** Connected components among the checked meshes (1 = one creature). */
  components: number;
  meshes: number;
}

interface Item {
  joint: number;
  name: string;
  /** Creature-space vertex positions (flat xyz). */
  pos: Float32Array;
  /** Triangle vertex indices (into pos). */
  tri: Uint32Array;
  sheet: boolean;
  proxy: boolean;
  box: THREE.Box3;
}

function itemOf(joint: number, name: string, geo: THREE.BufferGeometry, M: THREE.Matrix4, sheet: boolean, proxy = false): Item {
  const P = geo.getAttribute("position");
  const pos = new Float32Array(P.count * 3);
  const v = new THREE.Vector3();
  const box = new THREE.Box3();
  for (let i = 0; i < P.count; i++) {
    v.fromBufferAttribute(P, i).applyMatrix4(M);
    pos[i * 3] = v.x;
    pos[i * 3 + 1] = v.y;
    pos[i * 3 + 2] = v.z;
    box.expandByPoint(v);
  }
  let tri: Uint32Array;
  if (geo.index) {
    tri = new Uint32Array(geo.index.count);
    for (let i = 0; i < geo.index.count; i++) tri[i] = geo.index.getX(i);
  } else {
    tri = new Uint32Array(P.count);
    for (let i = 0; i < P.count; i++) tri[i] = i;
  }
  return { joint, name, pos, tri, sheet, proxy, box };
}

/** Generalised winding number of a closed (or union of closed) triangle soup at point (x, y, z). */
export function windingNumber(pos: Float32Array, tri: Uint32Array, x: number, y: number, z: number): number {
  let sum = 0;
  for (let t = 0; t + 2 < tri.length; t += 3) {
    const a = tri[t] * 3, b = tri[t + 1] * 3, c = tri[t + 2] * 3;
    const ax = pos[a] - x, ay = pos[a + 1] - y, az = pos[a + 2] - z;
    const bx = pos[b] - x, by = pos[b + 1] - y, bz = pos[b + 2] - z;
    const cx = pos[c] - x, cy = pos[c + 1] - y, cz = pos[c + 2] - z;
    const la = Math.hypot(ax, ay, az), lb = Math.hypot(bx, by, bz), lc = Math.hypot(cx, cy, cz);
    const det = ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
    const den = la * lb * lc + (ax * bx + ay * by + az * bz) * lc + (ax * cx + ay * cy + az * cz) * lb + (bx * cx + by * cy + bz * cz) * la;
    sum += 2 * Math.atan2(det, den);
  }
  return sum / (4 * Math.PI);
}

/** Up to n evenly strided vertex indices of an item. */
function sample(it: Item, n: number): number[] {
  const count = it.pos.length / 3;
  const step = Math.max(1, Math.floor(count / n));
  const out: number[] = [];
  for (let i = 0; i < count && out.length < n; i += step) out.push(i);
  return out;
}

function minDist(a: Item, b: Item, idx: number[]): number {
  let best = Infinity;
  const bp = b.pos;
  for (const i of idx) {
    const x = a.pos[i * 3], y = a.pos[i * 3 + 1], z = a.pos[i * 3 + 2];
    for (let k = 0; k < bp.length; k += 3) {
      const dx = bp[k] - x, dy = bp[k + 1] - y, dz = bp[k + 2] - z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < best) best = d;
    }
  }
  return Math.sqrt(best);
}

/** Head / jaw stand-ins: the same ellipsoids creature.ts gives the face (head 0.9 x mid, r x 0.95 r x 0.62 L). */
function proxyFor(sk: Skeleton, i: number, rest: [number, number, number]): Item | null {
  const j = sk.joints[i];
  if (j.role !== "head" && j.role !== "jaw") return null;
  const dir = new THREE.Vector3(j.dir[0], j.dir[1], j.dir[2]).normalize();
  const mid = dir.clone().multiplyScalar((j.length / 2) * (j.role === "head" ? 0.9 : 1));
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
  const s = j.role === "head" ? new THREE.Vector3(j.r0, j.r0 * 0.95, j.length * 0.62) : new THREE.Vector3(j.r0 * 1.05, j.r0 * 0.5, j.length / 2);
  const M = new THREE.Matrix4().compose(mid.add(new THREE.Vector3(...rest)), q, s);
  return itemOf(i, `${j.id}:proxy`, new THREE.SphereGeometry(1, 12, 8), M, false, true);
}

/**
 * Check a built body. `tol` (m) defaults to 3 % of the skeleton height; `samples` caps the vertices tested
 * per mesh (distance and burial).
 */
export function checkViability(sk: Skeleton, parts: BodyParts, opts: { tol?: number; samples?: number } = {}): ViabilityReport {
  const rest = restPositions(sk);
  const tol = opts.tol ?? Math.max(1e-3, 0.03 * sk.height);
  const nS = opts.samples ?? 48;
  const items: Item[] = [];
  const byJoint = new Map<number, number[]>();
  const push = (it: Item) => {
    byJoint.set(it.joint, [...(byJoint.get(it.joint) ?? []), items.length]);
    items.push(it);
  };
  parts.perJoint.forEach((objs, i) => {
    const M = new THREE.Matrix4().makeTranslation(rest[i][0], rest[i][1], rest[i][2]);
    for (const o of objs) {
      o.traverse((x) => {
        const m = x as THREE.Mesh;
        if (!m.isMesh) return;
        // Transform relative to the joint: the chain of local matrices from the mesh up to (and including) o.
        const rel = new THREE.Matrix4();
        for (let n: THREE.Object3D | null = m; n; n = n === o ? null : n.parent) {
          n.updateMatrix();
          rel.premultiply(n.matrix);
        }
        const local = new THREE.Matrix4().multiplyMatrices(M, rel);
        push(itemOf(i, m.name || `${sk.joints[i].id}:mesh`, m.geometry, local, parts.wings.includes(m)));
      });
    }
  });
  sk.joints.forEach((_, i) => {
    if (byJoint.has(i)) return;
    const p = proxyFor(sk, i, rest[i]);
    if (p) push(p);
  });

  // Anatomical neighbourhood of a joint: itself, parent, grandparent, children (nearest ancestors WITH meshes).
  const ancestors = (i: number, n: number): number[] => {
    const out: number[] = [];
    let k = sk.joints[i].parent;
    while (k >= 0 && out.length < n) {
      if (byJoint.has(k)) out.push(k);
      k = sk.joints[k].parent;
    }
    return out;
  };
  const parent = [...Array(items.length).keys()].map((i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const nearest = new Array(items.length).fill(Infinity);
  const touches = (a: Item, b: Item): number => {
    const bb = b.box.clone().expandByScalar(tol);
    if (!bb.intersectsBox(a.box)) return Infinity;
    const idx = sample(a, nS);
    const d = minDist(a, b, idx);
    if (d <= tol) return d;
    if (!b.sheet) for (const i of idx) if (windingNumber(b.pos, b.tri, a.pos[i * 3], a.pos[i * 3 + 1], a.pos[i * 3 + 2]) >= 0.5) return 0;
    if (!a.sheet) for (const i of sample(b, nS)) if (windingNumber(a.pos, a.tri, b.pos[i * 3], b.pos[i * 3 + 1], b.pos[i * 3 + 2]) >= 0.5) return 0;
    return d;
  };
  items.forEach((a, ai) => {
    const near = [a.joint, ...ancestors(a.joint, 2)];
    for (const j of near) {
      for (const bi of byJoint.get(j) ?? []) {
        if (bi === ai) continue;
        const d = touches(a, items[bi]);
        nearest[ai] = Math.min(nearest[ai], d);
        nearest[bi] = Math.min(nearest[bi], d);
        if (d <= tol) parent[find(ai)] = find(bi);
      }
    }
  });
  const rootItems = byJoint.get(0) ?? [];
  const rootSet = new Set(rootItems.map(find));
  const floating: ViabilityIssue[] = [];
  items.forEach((it, i) => {
    if (it.proxy || rootSet.has(find(i))) return;
    floating.push({ joint: it.joint, id: sk.joints[it.joint].id, mesh: it.name, kind: "floating", detail: Number.isFinite(nearest[i]) ? nearest[i] : -1 });
  });
  const comps = new Set(items.map((_, i) => find(i))).size;

  // Burial: every sampled vertex inside the closed meshes of its own joint (others), parent and grandparent.
  const buried: ViabilityIssue[] = [];
  items.forEach((it, i) => {
    if (it.sheet || it.proxy) return;
    const containers = [it.joint, ...ancestors(it.joint, 2)].flatMap((j) => (byJoint.get(j) ?? []).filter((k) => k !== i && !items[k].sheet));
    if (containers.length === 0) return;
    const idx = sample(it, Math.min(nS, 32));
    let inside = 0;
    for (const v of idx) {
      const x = it.pos[v * 3], y = it.pos[v * 3 + 1], z = it.pos[v * 3 + 2];
      let w = 0;
      for (const k of containers) {
        const c = items[k];
        if (x < c.box.min.x || x > c.box.max.x || y < c.box.min.y || y > c.box.max.y || z < c.box.min.z || z > c.box.max.z) continue;
        w += windingNumber(c.pos, c.tri, x, y, z);
        if (w >= 0.5) break;
      }
      if (w >= 0.5) inside++;
      else break;
    }
    if (inside === idx.length && idx.length > 0) buried.push({ joint: it.joint, id: sk.joints[it.joint].id, mesh: it.name, kind: "buried", detail: 1 });
  });
  return { ok: floating.length === 0 && buried.length === 0, floating, buried, components: comps, meshes: items.length };
}
