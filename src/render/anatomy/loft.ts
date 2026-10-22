/**
 * Swept-section (loft) geometry for the pass-4 anatomy (P4-V1). A body part is a sequence of RINGS, each a
 * superellipse section (exponent clamped to [1.75, 2.45]: 2 is an ellipse, higher squares off, lower
 * points) modulated by directional LOBES r * (1 + sum(amp * max(0, cos(theta - angle))^sharp)); a negative
 * amplitude carves a groove. Rings are stitched, both ends are DOME-capped (no flat right-angle caps),
 * every geometry is INDEXED with normals and UVs (u around the section, v along the path) so parts merge
 * and texture/bump-map. A section guard keeps the sharpest ring turn under MAX_TURN (0.6 rad; a right angle
 * is 1.571) unless the bare ellipse of that aspect already turns more: a primitive cannot sneak back in.
 *
 * Section frame: `x` is the lateral axis, `y` the dorsal axis; lobe angle 0 = +x, PI/2 = dorsal, -PI/2 =
 * ventral (the belly strip). Pure geometry: no materials, no scene.
 */
import * as THREE from "../../lib/three.ts";

export type V3 = [number, number, number];

export interface Lobe {
  /** Direction of the bulge in the section plane (rad; 0 = +x lateral, PI/2 = dorsal). */
  angle: number;
  /** Relative bulge (negative = groove). */
  amp: number;
  /** Cosine power: higher = narrower lobe. */
  sharp: number;
}

export interface Section {
  rx: number;
  ry: number;
  exp?: number;
  lobes?: Lobe[];
  offsetX?: number;
  offsetY?: number;
}

export interface Station extends Section {
  z: number;
}

/** A ring placed in space: centre plus the section's lateral (x) and dorsal (y) unit axes. */
export interface Ring extends Section {
  c: V3;
  x: V3;
  y: V3;
}

export interface LoftOptions {
  /** Ring vertex count (forced even so mirrored sections stay mirror-exact). */
  radial?: number;
  caps?: boolean | [boolean, boolean];
  /** Extra rings per dome cap. */
  capRings?: number;
  /** Dome length as a share of the end section's smaller radius. */
  capScale?: number | [number, number];
  /** Half-width (rad) of the ventral arc emitted as group 1 (belly material); 0 = one group. */
  belly?: number;
}

export const EXP_MIN = 1.75;
export const EXP_MAX = 2.45;
export const MAX_TURN = 0.6;

// ------------------------------------------------------------------ small vector helpers
export const add3 = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub3 = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mul3 = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
export const dot3 = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross3 = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len3 = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
export function norm3(a: V3): V3 {
  const l = len3(a);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 1];
}
export const lerp3 = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
/** Rotate v about a unit axis by angle (Rodrigues). */
export function rotate3(v: V3, axis: V3, angle: number): V3 {
  const c = Math.cos(angle), s = Math.sin(angle);
  const k = norm3(axis);
  const kv = cross3(k, v);
  const d = dot3(k, v) * (1 - c);
  return [v[0] * c + kv[0] * s + k[0] * d, v[1] * c + kv[1] * s + k[1] * d, v[2] * c + kv[2] * s + k[2] * d];
}

// ------------------------------------------------------------------ profile helpers (taper)
export const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
export function smoothstep(a: number, b: number, x: number): number {
  const t = clamp01((x - a) / (b - a || 1e-9));
  return t * t * (3 - 2 * t);
}
/** Linear taper r0 -> r1 over t in [0,1] with an optional power (>1 keeps the root fat longer). */
export function taper(t: number, r0: number, r1: number, power = 1): number {
  return r0 + (r1 - r0) * Math.pow(clamp01(t), power);
}
/** Smooth bump: 1 at `centre`, 0 beyond +-width (cosine window). */
export function bump(t: number, centre: number, width: number): number {
  const d = Math.abs(t - centre) / Math.max(1e-6, width);
  return d >= 1 ? 0 : 0.5 + 0.5 * Math.cos(Math.PI * d);
}
/** Mirror pair of lobes about the dorsal axis (angle a and PI - a): keeps a section bilaterally symmetric. */
export function pair(angle: number, amp: number, sharp: number): Lobe[] {
  return [{ angle, amp, sharp }, { angle: Math.PI - angle, amp, sharp }];
}

// ------------------------------------------------------------------ sections
export function clampExponent(e: number | undefined): number {
  if (e === undefined || !Number.isFinite(e)) return 2;
  return Math.min(EXP_MAX, Math.max(EXP_MIN, e));
}

function lobeFactor(theta: number, lobes: Lobe[] | undefined): number {
  if (!lobes || lobes.length === 0) return 1;
  let m = 1;
  for (const l of lobes) {
    const c = Math.cos(theta - l.angle);
    if (c > 0 && l.amp !== 0) m += l.amp * Math.pow(c, Math.min(24, Math.max(1.5, l.sharp)));
  }
  return Math.max(0.15, m);
}

/** One point of a lobed superellipse section at angle theta (no offset). */
export function superSection(theta: number, rx: number, ry: number, exponent: number, lobes: Lobe[] = []): [number, number] {
  const p = 2 / clampExponent(exponent);
  const c = Math.cos(theta), s = Math.sin(theta);
  const m = lobeFactor(theta, lobes);
  return [rx * Math.sign(c) * Math.pow(Math.abs(c), p) * m, ry * Math.sign(s) * Math.pow(Math.abs(s), p) * m];
}

/** The sampled section (radial points, offsets applied). */
export function sectionRing(sec: Section, radial: number): [number, number][] {
  const out: [number, number][] = [];
  const e = sec.exp ?? 2;
  for (let k = 0; k < radial; k++) {
    const [x, y] = superSection((k / radial) * Math.PI * 2, sec.rx, sec.ry, e, sec.lobes);
    out.push([x + (sec.offsetX ?? 0), y + (sec.offsetY ?? 0)]);
  }
  return out;
}

/** Sharpest turning angle (rad) between consecutive edges of a closed sampled ring. */
export function maxRingTurn(pts: [number, number][]): number {
  let worst = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[(i + n - 1) % n], b = pts[i], c = pts[(i + 1) % n];
    const e1x = b[0] - a[0], e1y = b[1] - a[1], e2x = c[0] - b[0], e2y = c[1] - b[1];
    if (Math.hypot(e1x, e1y) < 1e-12 || Math.hypot(e2x, e2y) < 1e-12) continue;
    worst = Math.max(worst, Math.abs(Math.atan2(e1x * e2y - e1y * e2x, e1x * e2x + e1y * e2y)));
  }
  return worst;
}

/**
 * The section guard: if lobes or the exponent push the sharpest ring turn over MAX_TURN (or over the bare
 * ellipse's own turn for very flat sections), soften the lobes and pull the exponent toward 2.
 */
export function safeSection(sec: Section, radial: number): Section {
  const base = maxRingTurn(sectionRing({ rx: sec.rx, ry: sec.ry }, radial));
  const limit = Math.max(MAX_TURN, base * 1.05);
  let cur: Section = { ...sec, exp: clampExponent(sec.exp) };
  for (let it = 0; it < 8 && maxRingTurn(sectionRing(cur, radial)) > limit; it++) {
    cur = {
      ...cur,
      exp: 2 + ((cur.exp ?? 2) - 2) * 0.6,
      lobes: cur.lobes?.map((l) => ({ angle: l.angle, amp: l.amp * 0.75, sharp: Math.max(1.5, l.sharp * 0.7) })),
    };
  }
  // Last resort (pass 5: stacked morph ops on a flat section): the bare ellipse, which IS the reference.
  if (maxRingTurn(sectionRing(cur, radial)) > limit) cur = { ...cur, exp: 2, lobes: [] };
  return cur;
}

// ------------------------------------------------------------------ frames
/**
 * Section frame for a straight bone: t along the bone, y = the dorsal reference made orthogonal to t
 * (falls back to `vertical` when the bone is near-parallel to the reference), x = +X made orthogonal to
 * both (falls back to y x t for bones along X, e.g. wings).
 */
export function boneFrame(dir: V3, dorsal: V3 = [0, 1, 0], vertical: V3 = [0, 0, -1]): { t: V3; x: V3; y: V3 } {
  const t = norm3(dir);
  let D = dorsal;
  if (Math.abs(dot3(norm3(D), t)) > 0.75) D = vertical;
  const y = norm3(sub3(D, mul3(t, dot3(D, t))));
  let x = sub3(sub3([1, 0, 0], mul3(t, t[0])), mul3(y, y[0]));
  x = len3(x) < 1e-3 ? norm3(cross3(y, t)) : norm3(x);
  return { t, x, y };
}

/** Rings along a straight axis from `origin` in direction `dir`: each station's z is the distance along dir. */
export function boneRings(origin: V3, dir: V3, stations: Station[], frame = boneFrame(dir)): Ring[] {
  return stations.map((s) => ({ ...s, c: add3(origin, mul3(frame.t, s.z)), x: frame.x, y: frame.y }));
}

export function bezier3(p0: V3, p1: V3, p2: V3, p3: V3, u: number): V3 {
  const a = 1 - u;
  const k0 = a * a * a, k1 = 3 * a * a * u, k2 = 3 * a * u * u, k3 = u * u * u;
  return [
    p0[0] * k0 + p1[0] * k1 + p2[0] * k2 + p3[0] * k3,
    p0[1] * k0 + p1[1] * k1 + p2[1] * k2 + p3[1] * k3,
    p0[2] * k0 + p1[2] * k1 + p2[2] * k2 + p3[2] * k3,
  ];
}

/**
 * Rings along a sampled curve with parallel-transported frames (no twist flips). `sectionAt(u)` gives the
 * section at curve parameter u in [0, 1]; `up` seeds the dorsal axis.
 */
export function curveRings(points: V3[], sectionAt: (u: number) => Section, up: V3 = [0, 1, 0]): Ring[] {
  const n = points.length;
  const tang = (i: number) => norm3(sub3(points[Math.min(n - 1, i + 1)], points[Math.max(0, i - 1)]));
  const f0 = boneFrame(tang(0), up, [0, 0, 1]);
  const hand = dot3(cross3(f0.y, f0.t), f0.x) >= 0 ? 1 : -1;
  let y = f0.y;
  const rings: Ring[] = [];
  for (let i = 0; i < n; i++) {
    const t = tang(i);
    y = sub3(y, mul3(t, dot3(y, t)));
    y = len3(y) < 1e-6 ? boneFrame(t, up, [0, 0, 1]).y : norm3(y);
    const x = mul3(norm3(cross3(y, t)), hand);
    rings.push({ ...sectionAt(n > 1 ? i / (n - 1) : 0), c: points[i], x, y });
  }
  return rings;
}

// ------------------------------------------------------------------ the loft
/** Stitch rings into an indexed, dome-capped surface with normals, UVs and an optional belly group. */
export function loftRings(rings: Ring[], opts: LoftOptions = {}): THREE.BufferGeometry {
  if (rings.length < 2) throw new Error("loftRings needs at least 2 rings");
  const R = Math.max(4, 2 * Math.round((opts.radial ?? 20) / 2));
  const caps: [boolean, boolean] = Array.isArray(opts.caps) ? opts.caps : [opts.caps ?? true, opts.caps ?? true];
  const capRings = Math.max(1, opts.capRings ?? 3);
  const capScale: [number, number] = Array.isArray(opts.capScale) ? opts.capScale : [opts.capScale ?? 0.9, opts.capScale ?? 0.9];
  // Main rows in 3D.
  const rowPts: V3[][] = [];
  const rowC: V3[] = [];
  const mainRow: boolean[] = [];
  const secs = rings.map((r) => safeSection(r, R));
  const main = rings.map((r, i) =>
    sectionRing(secs[i], R).map(([sx, sy]) => add3(r.c, add3(mul3(r.x, sx), mul3(r.y, sy))))
  );
  const capRows = (end: 0 | 1): { rows: V3[][]; cs: V3[]; pole: V3 } => {
    const i = end === 0 ? 0 : rings.length - 1;
    const j = end === 0 ? 1 : rings.length - 2;
    const r = rings[i];
    const sec = secs[i];
    const centre = add3(r.c, add3(mul3(r.x, sec.offsetX ?? 0), mul3(r.y, sec.offsetY ?? 0)));
    const out = norm3(sub3(rings[i].c, rings[j].c));
    const h = capScale[end] * Math.max(1e-5, Math.min(Math.abs(sec.rx), Math.abs(sec.ry)));
    const rows: V3[][] = [];
    const cs: V3[] = [];
    for (let k = 1; k <= capRings; k++) {
      const phi = (k / (capRings + 1)) * Math.PI * 0.5;
      const cc = add3(centre, mul3(out, h * Math.sin(phi)));
      rows.push(main[i].map((p) => add3(cc, mul3(sub3(p, centre), Math.cos(phi)))));
      cs.push(cc);
    }
    return { rows, cs, pole: add3(centre, mul3(out, h)) };
  };
  let poleS: V3 | null = null, poleE: V3 | null = null;
  if (caps[0]) {
    const c = capRows(0);
    for (let k = c.rows.length - 1; k >= 0; k--) {
      rowPts.push(c.rows[k]);
      rowC.push(c.cs[k]);
      mainRow.push(false);
    }
    poleS = c.pole;
  }
  for (let i = 0; i < rings.length; i++) {
    rowPts.push(main[i]);
    rowC.push(rings[i].c);
    mainRow.push(true);
  }
  if (caps[1]) {
    const c = capRows(1);
    for (let k = 0; k < c.rows.length; k++) {
      rowPts.push(c.rows[k]);
      rowC.push(c.cs[k]);
      mainRow.push(false);
    }
    poleE = c.pole;
  }
  // Arc length for v.
  const centres: V3[] = [...(poleS ? [poleS] : []), ...rowC, ...(poleE ? [poleE] : [])];
  const cum: number[] = [0];
  for (let i = 1; i < centres.length; i++) cum.push(cum[i - 1] + len3(sub3(centres[i], centres[i - 1])));
  const total = cum[cum.length - 1] || 1;
  const off = poleS ? 1 : 0;

  const pos: number[] = [], uv: number[] = [];
  const pushV = (p: V3, u: number, v: number) => {
    pos.push(p[0], p[1], p[2]);
    uv.push(u, v);
    return pos.length / 3 - 1;
  };
  const sIdx = poleS ? pushV(poleS, 0.5, 0) : -1;
  const rowStart: number[] = [];
  rowPts.forEach((row, ri) => {
    rowStart.push(pos.length / 3);
    for (let k = 0; k <= R; k++) pushV(row[k % R], k / R, cum[ri + off] / total);
  });
  const eIdx = poleE ? pushV(poleE, 0.5, 1) : -1;

  // Handedness of the frame along the path decides the winding (outward normals).
  const d = sub3(rings[1].c, rings[0].c);
  const hand = dot3(cross3(rings[0].x, rings[0].y), len3(d) > 1e-9 ? d : [0, 0, 1]) >= 0;
  const skinI: number[] = [], bellyI: number[] = [];
  const belly = opts.belly ?? 0;
  const tri = (bucket: number[], a: number, b: number, c: number) => (hand ? bucket.push(a, b, c) : bucket.push(a, c, b));
  const ventral = (k: number) => {
    if (belly <= 0) return false;
    const th = ((k + 0.5) / R) * Math.PI * 2;
    let dd = Math.abs(th - Math.PI * 1.5);
    if (dd > Math.PI) dd = 2 * Math.PI - dd;
    return dd <= belly;
  };
  for (let ri = 0; ri + 1 < rowPts.length; ri++) {
    const a = rowStart[ri], b = rowStart[ri + 1];
    const isMain = mainRow[ri] && mainRow[ri + 1];
    for (let k = 0; k < R; k++) {
      const bucket = isMain && ventral(k) ? bellyI : skinI;
      tri(bucket, a + k, a + k + 1, b + k);
      tri(bucket, a + k + 1, b + k + 1, b + k);
    }
  }
  if (sIdx >= 0) {
    const b = rowStart[0];
    for (let k = 0; k < R; k++) tri(skinI, sIdx, b + k + 1, b + k);
  }
  if (eIdx >= 0) {
    const a = rowStart[rowStart.length - 1];
    for (let k = 0; k < R; k++) tri(skinI, a + k, a + k + 1, eIdx);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex([...skinI, ...bellyI]);
  if (belly > 0) {
    geo.addGroup(0, skinI.length, 0);
    geo.addGroup(skinI.length, bellyI.length, 1);
  }
  geo.computeVertexNormals();
  // Weld the UV seam's shading: column 0 and column R share a position, average their normals.
  const n = geo.getAttribute("normal") as THREE.BufferAttribute;
  for (const s of rowStart) {
    const ax = n.getX(s) + n.getX(s + R), ay = n.getY(s) + n.getY(s + R), az = n.getZ(s) + n.getZ(s + R);
    const l = Math.hypot(ax, ay, az) || 1;
    n.setXYZ(s, ax / l, ay / l, az / l);
    n.setXYZ(s + R, ax / l, ay / l, az / l);
  }
  return geo;
}

/** A loft along local +Z (stations' z), dome-capped: the spec'd entry point. */
export function loftGeometry(stations: Station[], radial = 20, caps = true): THREE.BufferGeometry {
  return loftRings(boneRings([0, 0, 0], [0, 0, 1], stations, { t: [0, 0, 1], x: [1, 0, 0], y: [0, 1, 0] }), { radial, caps });
}

/** A UV sphere (indexed, normals, UVs) centred at c: socket spheres and knuckles. */
export function sphereGeo(c: V3, r: number, w: number, h: number): THREE.BufferGeometry {
  return new THREE.SphereGeometry(r, w, h).translate(c[0], c[1], c[2]);
}

/** A flat parametric sheet P(u, v), u,v in [0,1] (indexed, normals, UVs): membranes and panes. */
export function gridSurface(P: (u: number, v: number) => V3, nu: number, nv: number): THREE.BufferGeometry {
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  for (let j = 0; j <= nv; j++) {
    for (let i = 0; i <= nu; i++) {
      const p = P(i / nu, j / nv);
      pos.push(p[0], p[1], p[2]);
      uv.push(i / nu, j / nv);
    }
  }
  const w = nu + 1;
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const a = j * w + i;
      idx.push(a, a + 1, a + w, a + 1, a + w + 1, a + w);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

// ------------------------------------------------------------------ merge / mirror / scale
export interface Piece<S extends string> {
  geo: THREE.BufferGeometry;
  /** Material slot per geometry group (or one slot for a group-less geometry). */
  slots: S[];
}

/**
 * Merge indexed geometries (each with position, normal, uv) into ONE geometry whose groups follow `order`
 * (one contiguous group per used slot). Throws on a non-indexed or attribute-less input: a silent null
 * merge would crash at first render far from here.
 */
export function mergePieces<S extends string>(pieces: Piece<S>[], order: readonly S[]): { geo: THREE.BufferGeometry; slots: S[] } | null {
  if (pieces.length === 0) return null;
  const pos: number[] = [], nor: number[] = [], uv: number[] = [];
  const buckets = new Map<S, number[]>();
  for (const p of pieces) {
    const g = p.geo;
    const P = g.getAttribute("position"), N = g.getAttribute("normal"), U = g.getAttribute("uv");
    if (!g.index || !P || !N || !U) throw new Error("mergePieces: every piece must be indexed with position/normal/uv");
    const base = pos.length / 3;
    for (let i = 0; i < P.count; i++) {
      pos.push(P.getX(i), P.getY(i), P.getZ(i));
      nor.push(N.getX(i), N.getY(i), N.getZ(i));
      uv.push(U.getX(i), U.getY(i));
    }
    const index = g.index;
    const groups = g.groups.length > 0 ? g.groups : [{ start: 0, count: index.count, materialIndex: 0 }];
    for (const gr of groups) {
      const slot = p.slots[gr.materialIndex ?? 0] ?? p.slots[0];
      const b = buckets.get(slot) ?? [];
      const end = Math.min(index.count, gr.start + gr.count);
      for (let i = gr.start; i < end; i++) b.push(index.getX(i) + base);
      buckets.set(slot, b);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  const all: number[] = [];
  const slots: S[] = [];
  for (const s of order) {
    const b = buckets.get(s);
    if (!b || b.length === 0) continue;
    geo.addGroup(all.length, b.length, slots.length);
    slots.push(s);
    for (const v of b) all.push(v);
  }
  geo.setIndex(all);
  if (slots.length === 1) geo.clearGroups();
  geo.computeBoundingSphere();
  return { geo, slots };
}

/** Mirror a geometry across the median plane (x -> -x) in place, flipping the winding to keep normals out. */
export function mirrorX(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const P = geo.getAttribute("position") as THREE.BufferAttribute;
  const N = geo.getAttribute("normal") as THREE.BufferAttribute | undefined;
  for (let i = 0; i < P.count; i++) P.setX(i, -P.getX(i));
  if (N) for (let i = 0; i < N.count; i++) N.setX(i, -N.getX(i));
  const I = geo.index;
  if (I) {
    for (let i = 0; i + 2 < I.count; i += 3) {
      const b = I.getX(i + 1);
      I.setX(i + 1, I.getX(i + 2));
      I.setX(i + 2, b);
    }
    I.needsUpdate = true;
  }
  P.needsUpdate = true;
  if (N) N.needsUpdate = true;
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

/** Triangle count of a geometry (indexed or not). */
export function triCount(geo: THREE.BufferGeometry): number {
  return Math.round((geo.index ? geo.index.count : geo.getAttribute("position").count) / 3);
}
