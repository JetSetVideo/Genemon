/**
 * Face builder (pass 4 lane face, pass 5 lane helix-face [P5-V4]): the HEAD surface with carved eye
 * SOCKETS and brow ridges, 1..8 eyes laid out by the helix (layout / height / spread / yaw / tilt), eye
 * OUTLINES (round, almond, tear, crescent, hooded, diamond, oval), manga eye structures, eyelids,
 * catchlights, the mouth line and lips, inner mouth, teeth per kind, BEAKS (round / hooked / flat /
 * needle / shovel lofts with roundness and length), a TONGUE (forked option) and the jaw volume, all
 * built FROM the head / jaw JointDefs and the morph helix (`helix.p5 ?? P5_DEFAULTS`).
 *
 * Frames: every head mesh is in the HEAD joint frame, every jaw mesh in the JAW joint frame
 * (src/body/skeleton.ts: +Z forward, +Y up, side +1 = +X; positive X rotation opens the jaw).
 *
 * Head volume: an ellipsoid centred at dir * 0.45 L with semi-axes (r, 0.95 r, 0.62 L) along
 * (side, faceUp, dir) (`headVolume`). `buildHead` meshes it with a lat-long grid whose parameters are
 * warped toward the face (denser where the eyes and the mouth are), pushes a brow ridge out above every
 * eye, then CARVES each socket: in the eye's normalised frame (unit = 1.06 x the scaled eyeball), head
 * vertices inside the socket sphere move onto its deep wall (a boolean difference), and a funnel joins
 * the eyeball equator to the skin around it (deeper sockets = wider funnel). The eyeball centre is
 * embedded by (0.25 + 0.75 socketDepth) of its radius, so it sits IN the socket, never stuck on: no head
 * vertex is left inside an eyeball (pinned by tests/face_test.ts). The jaw volume (`jawVolume`) is
 * scaled per axis by MouthP5.scale.
 *
 * Eye layering (all on concentric shells around the eye centre so nothing z-fights, and pupils can be
 * scaled about their own pole): sclera 1.00 er, iris 1.012, hot bead 1.02, pupil 1.05 (margin for
 * setScalar emotion scaling), catchlight 1.07, OUTLINE MASK 1.09 (skin annulus whose inner edge is the
 * 2D outline projected on the shell: the visible eye opening is not a circle), blink lid 1.11. Glowing
 * eyes = saturated iris shell (emissive normalised by luminance) + a small hot bead in the lower iris.
 * Babies have bigger eyes: x (1 + 0.5 (1 - growth)(0.4 + 0.6 neoteny)).
 */
import * as THREE from "../../lib/three.ts";
import type { JointDef } from "../../body/skeleton.ts";
import type { Phenotype } from "../../genome/phenotype.ts";
import {
  type BeakKind,
  type EyeLayout,
  type EyeP5,
  type EyeShape,
  type EyeStyle,
  type MorphHelix,
  type MorphP5,
  P5_DEFAULTS,
  type PupilFill,
  type TeethKind,
} from "../../genome/morphTypes.ts";
import type { FaceParts, SkinMaterials } from "./types.ts";

type V3 = THREE.Vector3;
type Quality = "low" | "high";
const UP = new THREE.Vector3(0, 1, 0);
const clamp = (x: number, lo: number, hi: number) => (Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : lo);
const smooth = (t: number) => {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
};

interface Frame {
  fwd: V3;
  up: V3;
  side: V3;
}

/** Joint frame with the face-up fix: world up made orthogonal to the bone (a head pointing straight
 * up looks forward, +Z). `side` always leans +X so left/right labels survive. */
function frameOf(dir: readonly [number, number, number]): Frame {
  const fwd = new THREE.Vector3(dir[0], dir[1], dir[2]);
  if (fwd.lengthSq() < 1e-9) fwd.set(0, 0, 1);
  fwd.normalize();
  const up = UP.clone().addScaledVector(fwd, -UP.dot(fwd));
  if (up.lengthSq() < 1e-4) up.set(0, 0, 1);
  else up.normalize();
  const side = new THREE.Vector3().crossVectors(up, fwd).normalize();
  if (side.x < 0) side.negate();
  return { fwd, up, side };
}

/** An ellipsoid volume in a joint frame (semi-axes a side, b up, d forward). */
export interface Ellipsoid {
  f: Frame;
  c: V3;
  a: number;
  b: number;
  d: number;
}

/** Point and outward normal on an ellipsoid at azimuth `az` (toward +side) and elevation `el`. */
function surface(e: Ellipsoid, az: number, el: number, k = 1): { p: V3; n: V3 } {
  const ds = Math.cos(el) * Math.sin(az), du = Math.sin(el), df = Math.cos(el) * Math.cos(az);
  const p = e.c.clone()
    .addScaledVector(e.f.side, ds * e.a * k)
    .addScaledVector(e.f.up, du * e.b * k)
    .addScaledVector(e.f.fwd, df * e.d * k);
  const n = new THREE.Vector3()
    .addScaledVector(e.f.side, ds / e.a)
    .addScaledVector(e.f.up, du / e.b)
    .addScaledVector(e.f.fwd, df / e.d)
    .normalize();
  return { p, n };
}

/** The head volume every face part is placed on (HEAD joint frame). */
export function headVolume(head: JointDef): Ellipsoid {
  const r = Math.max(1e-3, head.r0), L = Math.max(1e-3, head.length);
  const f = frameOf(head.dir);
  return { f, c: f.fwd.clone().multiplyScalar(L * 0.45), a: r, b: r * 0.95, d: L * 0.62 };
}

/** The jaw volume (JAW joint frame), scaled per axis by MouthP5.scale (x width, y gape, z depth). */
export function jawVolume(jaw: JointDef, helix: MorphHelix): Ellipsoid {
  const [sx, sy, sz] = (helix.p5 ?? P5_DEFAULTS).mouth.scale.map((v) => clamp(v, 0.6, 1.5));
  const f = frameOf(jaw.dir);
  const L = Math.max(1e-3, jaw.length), r0 = Math.max(1e-3, jaw.r0);
  return { f, c: f.fwd.clone().multiplyScalar((L / 2) * sz), a: r0 * 1.05 * sx, b: r0 * 0.5 * sy, d: (L / 2) * sz };
}

/** Quaternion whose local +Y is `axis` and local +Z leans toward `toward`. */
function orient(axis: V3, toward: V3): THREE.Quaternion {
  const y = axis.clone().normalize();
  const z = toward.clone().addScaledVector(y, -toward.dot(y));
  if (z.lengthSq() < 1e-8) z.set(y.y, y.z, y.x).addScaledVector(y, -y.dot(new THREE.Vector3(y.y, y.z, y.x)));
  z.normalize();
  const x = new THREE.Vector3().crossVectors(y, z).normalize();
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}

/**
 * A patch of the sphere of radius R facing +Z: an ellipse (ax, ay) around (cx, cy), optionally an
 * annulus (`inner`) or an n-pointed star. Vertices lie exactly on the sphere, so layered patches never
 * intersect each other.
 */
function shellPatch(R: number, ax: number, ay: number, o: { cx?: number; cy?: number; inner?: number; star?: number; rings?: number; segs?: number } = {}): THREE.BufferGeometry {
  const rings = o.rings ?? 4, segs = o.segs ?? 24, inner = o.inner ?? 0, cx = o.cx ?? 0, cy = o.cy ?? 0;
  const pos: number[] = [], nor: number[] = [], uv: number[] = [], idx: number[] = [];
  const lim = R * 0.985;
  for (let i = 0; i <= rings; i++) {
    const u = inner + (1 - inner) * (i / rings);
    for (let j = 0; j <= segs; j++) {
      const ph = (j / segs) * Math.PI * 2;
      const k = o.star ? 0.3 + 0.7 * Math.pow(Math.abs(Math.cos((o.star * ph) / 2)), 3) : 1;
      let x = cx + u * k * ax * Math.cos(ph), y = cy + u * k * ay * Math.sin(ph);
      const rr = Math.hypot(x, y);
      if (rr > lim) {
        x *= lim / rr;
        y *= lim / rr;
      }
      const z = Math.sqrt(Math.max(0, R * R - x * x - y * y));
      pos.push(x, y, z);
      nor.push(x / R, y / R, z / R);
      uv.push(j / segs, i / rings);
    }
  }
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < segs; j++) {
      const a = i * (segs + 1) + j, b = a + segs + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

// ------------------------------------------------------------------ eye outlines
/**
 * Inside test of an eye outline in the eye's 2D plane (unit = eyeball radius, +y up, `outer` = +1 when
 * +x points away from the midline). Every outline contains the origin, so it is star-shaped from there.
 */
export function insideOutline(shape: EyeShape, x: number, y: number, outer: number): boolean {
  const xo = x * outer;
  switch (shape) {
    case "round":
      return x * x + y * y <= 0.86 * 0.86;
    case "oval":
      return (x / 0.94) ** 2 + (y / 0.66) ** 2 <= 1;
    case "almond": {
      const t = 1 - (x / 0.97) ** 2;
      return t > 0 && y <= 0.62 * t && y >= -0.5 * t;
    }
    case "tear": {
      // Almond whose inner corner droops into a tear-drop point.
      const yy = y + 0.34 * Math.max(0, -xo) ** 1.5;
      const t = 1 - (x / 0.95) ** 2;
      return t > 0 && yy <= 0.66 * t && yy >= -0.5 * t - 0.1 * Math.max(0, -xo);
    }
    case "crescent": {
      // Arched band (a happy / sly crescent): both edges bow upward.
      return y <= 0.62 - 0.75 * x * x && y >= -0.06 - 0.75 * x * x && Math.abs(x) <= 0.97;
    }
    case "hooded":
      // Heavy upper lid: a flat top sloping down toward the outer corner.
      return x * x + y * y <= 0.86 * 0.86 && y <= 0.3 - 0.12 * xo;
    case "diamond":
      return Math.abs(x) / 0.96 + Math.abs(y) / 0.76 <= 1;
  }
}

/** Boundary radius of an outline along direction phi (unit eyeball radius), by marching + bisection. */
function outlineRadius(shape: EyeShape, phi: number, outer: number): number {
  const c = Math.cos(phi), s = Math.sin(phi);
  let lo = 0, hi = 1;
  for (let k = 1; k <= 40; k++) {
    const r = k / 40;
    if (!insideOutline(shape, r * c, r * s, outer)) {
      hi = r;
      break;
    }
    lo = r;
    if (k === 40) return 0.985;
  }
  for (let i = 0; i < 14; i++) {
    const m = (lo + hi) / 2;
    if (insideOutline(shape, m * c, m * s, outer)) lo = m;
    else hi = m;
  }
  return clamp(lo, 0.08, 0.985);
}

/**
 * Skin mask on the shell of radius R: an annulus whose INNER edge is the outline (projected onto the
 * sphere) and whose outer edge is the eyeball silhouette, so the visible opening takes the outline's shape.
 */
function outlineMask(R: number, shape: EyeShape, outer: number, segs: number, rings: number): THREE.BufferGeometry {
  const pos: number[] = [], nor: number[] = [], uv: number[] = [], idx: number[] = [];
  const lim = 0.998; // down to ~the eyeball equator, so no sclera peeks past the mask at grazing angles
  for (let i = 0; i <= rings; i++) {
    const u = i / rings;
    for (let j = 0; j <= segs; j++) {
      const phi = (j / segs) * Math.PI * 2;
      const r0 = outlineRadius(shape, phi, outer);
      const rr = (r0 + (lim - r0) * u) * R;
      const x = rr * Math.cos(phi), y = rr * Math.sin(phi);
      const z = Math.sqrt(Math.max(0, R * R - x * x - y * y));
      pos.push(x, y, z);
      nor.push(x / R, y / R, z / R);
      uv.push(j / segs, u);
    }
  }
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < segs; j++) {
      const a = i * (segs + 1) + j, b = a + segs + 1;
      idx.push(a, a + 1, b, b, a + 1, b + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/** A cone along +Y (base slightly embedded below y = 0) whose tip curves toward +Z by `bend` x len. */
function bentCone(rb: number, len: number, bend: number, radial = 7, heightSegs = 3): THREE.BufferGeometry {
  const g = new THREE.ConeGeometry(rb, len, radial, heightSegs);
  g.translate(0, len / 2 - len * 0.12, 0);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const t = clamp(p.getY(i) / len, 0, 1);
    p.setZ(i, p.getZ(i) + bend * len * t * t);
  }
  g.computeVertexNormals();
  return g;
}

/** Merge transformed parts into one non-indexed geometry (one draw call per half-jaw). */
function mergeParts(parts: { geo: THREE.BufferGeometry; m: THREE.Matrix4 }[]): THREE.BufferGeometry {
  const pos: number[] = [], nor: number[] = [];
  for (const { geo, m } of parts) {
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    g.applyMatrix4(m);
    if (!g.attributes.normal) g.computeVertexNormals();
    const pa = g.attributes.position.array, na = g.attributes.normal.array;
    for (let i = 0; i < pa.length; i++) pos.push(pa[i]);
    for (let i = 0; i < na.length; i++) nor.push(na[i]);
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  return out;
}

/** Average the normals of vertices that share a position (lat-long seams and poles). */
function weldNormals(g: THREE.BufferGeometry): void {
  const p = g.attributes.position, n = g.attributes.normal;
  const groups = new Map<string, number[]>();
  const q = (v: number) => Math.round(v * 1e5);
  for (let i = 0; i < p.count; i++) {
    const k = `${q(p.getX(i))},${q(p.getY(i))},${q(p.getZ(i))}`;
    const arr = groups.get(k);
    if (arr) arr.push(i);
    else groups.set(k, [i]);
  }
  const v = new THREE.Vector3();
  for (const ids of groups.values()) {
    if (ids.length < 2) continue;
    v.set(0, 0, 0);
    for (const i of ids) v.x += n.getX(i), v.y += n.getY(i), v.z += n.getZ(i);
    v.normalize();
    for (const i of ids) n.setXYZ(i, v.x, v.y, v.z);
  }
}

/**
 * A loft along +Z (length `len`) with elliptical sections: half-width w(t), half-height h(t) and centre
 * height yc(t) for t in [0, 1]; closed with a tip vertex. Used for beaks and tongues.
 */
function loftZ(len: number, w: (t: number) => number, h: (t: number) => number, yc: (t: number) => number, stations: number, ring: number, xc: (t: number) => number = () => 0): THREE.BufferGeometry {
  const pos: number[] = [], idx: number[] = [], uv: number[] = [];
  for (let i = 0; i <= stations; i++) {
    const t = i / stations;
    const ww = Math.max(1e-5, w(t)), hh = Math.max(1e-5, h(t));
    for (let j = 0; j < ring; j++) {
      const a = (j / ring) * Math.PI * 2;
      pos.push(xc(t) + ww * Math.cos(a), yc(t) + hh * Math.sin(a), t * len);
      uv.push(j / ring, t);
    }
  }
  const tip = pos.length / 3;
  const tEnd = 1;
  pos.push(xc(tEnd), yc(tEnd), len * (1 + 0.02));
  uv.push(0.5, 1);
  for (let i = 0; i < stations; i++) {
    for (let j = 0; j < ring; j++) {
      const a = i * ring + j, b = i * ring + ((j + 1) % ring), c = a + ring, d = b + ring;
      idx.push(a, b, c, b, d, c);
    }
  }
  const last = stations * ring;
  for (let j = 0; j < ring; j++) idx.push(last + j, last + ((j + 1) % ring), tip);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

const luminance = (c: THREE.Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

// ------------------------------------------------------------------ eye placement
interface EyeSlot {
  az: number;
  el: number;
  k: number;
  s: -1 | 0 | 1;
}

const sideOf = (az: number): -1 | 0 | 1 => (Math.abs(az) < 1e-6 ? 0 : az < 0 ? -1 : 1);

/** Angular slots of `n` eyes for a layout, symmetric about the midline (odd counts put one on it). */
function eyeSlots(n: number, layout: EyeLayout, P: EyeP5): EyeSlot[] {
  const el0 = clamp(0.2 + 0.4 * P.height, -0.3, 0.85);
  const az0 = 0.3 + 0.6 * clamp(P.spread, 0, 1);
  const out: EyeSlot[] = [];
  const push = (az: number, el: number, k: number) => out.push({ az: clamp(az, -1.45, 1.45), el: clamp(el, -0.5, 1.25), k, s: sideOf(az) });
  if (n === 1) {
    push(0, el0 + 0.05, 1.3);
    return out;
  }
  if (n === 2 || layout === "pair" || layout === "cyclops") {
    push(-az0, el0, 1);
    push(az0, el0, 1);
    for (let m = 1; out.length < n; m++) {
      // Extra pairs (legacy helices without a layout): smaller eyes stacked above.
      if (n - out.length === 1) push(0, el0 + 0.65, 0.6);
      else {
        push(-az0 * 0.5, el0 + 0.68 * m, 0.52);
        push(az0 * 0.5, el0 + 0.68 * m, 0.52);
      }
    }
    return out;
  }
  if (layout === "row" || layout === "arc") {
    const azMax = Math.min(1.35, az0 * (1 + 0.16 * (n - 2)));
    for (let i = 0; i < n; i++) {
      const t = -1 + (2 * i) / (n - 1);
      const el = layout === "arc" ? el0 - 0.12 + 0.42 * (1 - t * t) : el0;
      push(t * azMax, el, 1);
    }
    return out;
  }
  if (layout === "cluster") {
    // Spider: one big forward pair, the rest smaller around and above it.
    push(-az0 * 0.55, el0, 1);
    push(az0 * 0.55, el0, 1);
    const rest = n - 2, pairs = Math.floor(rest / 2);
    for (let m = 0; m < pairs; m++) {
      const az = az0 * (0.55 + 0.6 * (m + 1)), el = el0 + (m % 2 === 0 ? 0.36 : -0.2) + 0.12 * Math.floor(m / 2);
      push(-az, el, 0.58);
      push(az, el, 0.58);
    }
    if (rest % 2 === 1) push(0, el0 + 0.5, 0.58);
    return out;
  }
  // stacked: pairs in rows going up, an odd eye on the midline at the top.
  const rows = Math.floor(n / 2);
  for (let m = 0; m < rows; m++) {
    const el = el0 - 0.15 * (rows - 1) + 0.42 * m, k = 1 - 0.14 * m;
    push(-az0 * (1 - 0.12 * m), el, k);
    push(az0 * (1 - 0.12 * m), el, k);
  }
  if (n % 2 === 1) push(0, el0 - 0.15 * (rows - 1) + 0.42 * rows + 0.05, 0.7);
  return out;
}

/** One placed eye (HEAD joint frame). */
export interface EyePlacement {
  index: number;
  side: -1 | 0 | 1;
  /** Eyeball centre (embedded in its socket). */
  centre: V3;
  /** Eye frame: local +x, +y, +z (the gaze). */
  ex: V3;
  ey: V3;
  look: V3;
  /** Unscaled eyeball radius and the per-axis scale applied to the eye group. */
  er: number;
  scale: [number, number, number];
  /** The point of the original head surface the socket is dug into, and its normal. */
  anchor: V3;
  normal: V3;
  /** Embedding depth of the eyeball centre below the head surface (head units). */
  embed: number;
}

/** The p5 genes a face reads, with legacy helices (no p5) mapped onto them. */
export function faceGenes(helix: MorphHelix): MorphP5 {
  if (helix.p5) return helix.p5;
  const count = Math.round(clamp(helix.eyes.count, 1, 8));
  const layout: EyeLayout = count === 1 ? "cyclops" : "pair";
  const beak: BeakKind = helix.mouth.teeth === "beak" ? "hooked" : "none";
  return {
    ...P5_DEFAULTS,
    eyes: { ...P5_DEFAULTS.eyes, count, layout },
    mouth: {
      ...P5_DEFAULTS.mouth,
      beak,
      beakLength: beak === "none" ? 0 : 0.3 + 0.6 * clamp(helix.mouth.toothLength, 0, 0.6),
      tongueLength: helix.mouth.tongue ? 0.3 : 0,
    },
  };
}

const STYLE_SCALE: Partial<Record<EyeStyle, [number, number, number]>> = { sharp: [1.08, 0.64, 0.9] };

/**
 * Where every eye goes: slots from the layout, eyeball radius from the gene size, the count, the
 * babyness (low growth x neoteny) and the slot weight, shrunk until no two eyes overlap; centres are
 * embedded by (0.25 + 0.75 socketDepth) of the eyeball depth; gaze yawed by `yaw`, outline tilted by
 * `tilt` (mirrored per side).
 */
export function eyePlacements(head: JointDef, ph: Phenotype, helix: MorphHelix): EyePlacement[] {
  const H = headVolume(head), f = H.f, r = H.a;
  const P = faceGenes(helix).eyes;
  const n = Math.round(clamp(P.count, 1, 8));
  const slots = eyeSlots(n, n === 1 ? "cyclops" : n === 2 ? "pair" : P.layout, P);
  const st = STYLE_SCALE[helix.eyes.style] ?? [1, 1, 1];
  const scale: [number, number, number] = [
    clamp(P.scale[0], 0.6, 1.5) * st[0],
    clamp(P.scale[1], 0.6, 1.5) * st[1],
    clamp(P.scale[2], 0.6, 1.5) * st[2],
  ];
  const smax = Math.max(scale[0], scale[1]);
  const baby = 1 + 0.5 * (1 - clamp(ph.growth, 0, 1)) * (0.4 + 0.6 * clamp(faceGenes(helix).growth.neoteny, 0, 1));
  const countK = n <= 2 ? 1 : Math.sqrt(2 / n) * 1.1;
  const depth = clamp(P.socketDepth, 0, 1);
  const yaw = clamp(P.yaw, 0, 1.3), tilt = clamp(P.tilt, -0.6, 0.6);
  let er0 = clamp(helix.eyes.size, 0.12, 0.45) * r * countK * baby;
  const place = (er0: number): EyePlacement[] =>
    slots.map((slot, index) => {
      const er = Math.min(er0 * slot.k, 0.55 * r / smax);
      const { p, n: nn } = surface(H, slot.az, slot.el);
      const yawDir = f.fwd.clone().multiplyScalar(Math.cos(yaw)).addScaledVector(f.side, slot.s * Math.sin(yaw));
      const look = nn.clone().addScaledVector(slot.s === 0 ? f.fwd : yawDir, 1.1).normalize();
      let ey = f.up.clone().addScaledVector(look, -f.up.dot(look));
      if (ey.lengthSq() < 1e-6) ey = f.fwd.clone().addScaledVector(look, -f.fwd.dot(look));
      ey.normalize();
      let ex = new THREE.Vector3().crossVectors(ey, look).normalize();
      if (slot.s !== 0) {
        const q = new THREE.Quaternion().setFromAxisAngle(look, slot.s * tilt);
        ex = ex.applyQuaternion(q);
        ey = ey.applyQuaternion(q);
      }
      const embed = er * scale[2] * (0.25 + 0.75 * depth);
      const centre = p.clone().addScaledVector(nn, -embed);
      return { index, side: slot.s, centre, ex, ey, look, er, scale, anchor: p, normal: nn, embed };
    });
  let eyes = place(er0);
  for (let it = 0; it < 24; it++) {
    let ok = true;
    for (let i = 0; i < eyes.length && ok; i++) {
      for (let j = i + 1; j < eyes.length; j++) {
        const need = 1.12 * (eyes[i].er + eyes[j].er) * smax;
        if (eyes[i].centre.distanceTo(eyes[j].centre) < need) {
          ok = false;
          break;
        }
      }
    }
    if (ok) break;
    er0 *= 0.92;
    eyes = place(er0);
  }
  return eyes;
}

// ------------------------------------------------------------------ the head surface
/**
 * The HEAD mesh (HEAD joint frame): the head ellipsoid with a brow ridge above every eye and a socket
 * CARVED under every eye (see the file header). userData: { head: true, sockets: n }.
 */
export function buildHead(head: JointDef, ph: Phenotype, helix: MorphHelix, mats: SkinMaterials, quality: Quality): THREE.Object3D[] {
  const H = headVolume(head), f = H.f;
  const hi = quality === "high";
  const NU = hi ? 38 : 24, NV = hi ? 22 : 12;
  // Parameter warp: denser near the front / the eye line, sparser at the back of the skull.
  const warp = (t: number, A: number) => t * (A + (1 - A) * t * t);
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  const nrm: V3[] = [];
  for (let j = 0; j <= NV; j++) {
    const v = -1 + (2 * j) / NV;
    const el = (Math.PI / 2) * warp(v, 0.6);
    for (let i = 0; i <= NU; i++) {
      const u = -1 + (2 * i) / NU;
      const az = Math.PI * warp(u, 0.42);
      const s = surface(H, az, el);
      pos.push(s.p.x, s.p.y, s.p.z);
      nrm.push(s.n);
      uv.push(i / NU, j / NV);
    }
  }
  for (let j = 0; j < NV; j++) {
    for (let i = 0; i < NU; i++) {
      const a = j * (NU + 1) + i, b = a + 1, c = a + NU + 1, d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
  }
  const eyes = eyePlacements(head, ph, helix);
  const P = faceGenes(helix).eyes;
  const brow = helix.eyes.style === "compound" ? 0 : clamp(P.brow, 0, 1);
  const depth = clamp(P.socketDepth, 0, 1);
  const V = new THREE.Vector3(), d = new THREE.Vector3();
  const count = pos.length / 3;
  // 1) brow ridges (before carving, so a carve always wins near the eye).
  if (brow > 0.02) {
    for (let k = 0; k < count; k++) {
      V.set(pos[3 * k], pos[3 * k + 1], pos[3 * k + 2]);
      let push = 0;
      for (const e of eyes) {
        const R = e.er * 1.06;
        d.subVectors(V, e.centre);
        const lx = d.dot(e.ex) / (R * e.scale[0]), ly = d.dot(e.ey) / (R * e.scale[1]), lz = d.dot(e.look) / (R * e.scale[2]);
        if (lz < -0.6) continue;
        const q = (lx / 1.55) ** 2 + ((ly - 1.3) / 0.62) ** 2;
        if (q < 1) push = Math.max(push, brow * e.er * 0.42 * (1 - q) * (1 - q));
      }
      if (push > 0) {
        pos[3 * k] += nrm[k].x * push;
        pos[3 * k + 1] += nrm[k].y * push;
        pos[3 * k + 2] += nrm[k].z * push;
      }
    }
  }
  // 2) sockets: boolean difference with the socket sphere + a funnel to the surrounding skin.
  const Ro = 1.3 + 0.45 * depth;
  for (let k = 0; k < count; k++) {
    for (const e of eyes) {
      V.set(pos[3 * k], pos[3 * k + 1], pos[3 * k + 2]);
      const R = e.er * 1.06;
      const sx = R * e.scale[0], sy = R * e.scale[1], sz = R * e.scale[2];
      d.subVectors(V, e.centre);
      const lx = d.dot(e.ex) / sx, ly = d.dot(e.ey) / sy, lz = d.dot(e.look) / sz;
      if (lz < -1.5) continue;
      const rho = Math.hypot(lx, ly);
      if (rho >= Ro) continue;
      const e0 = (e.embed + e.er * 0.05) / sz;
      const target = rho < 1 ? -Math.sqrt(1 - rho * rho) : e0 * smooth((rho - 1) / (Ro - 1));
      if (target < lz) {
        const dz = (target - lz) * sz;
        pos[3 * k] += e.look.x * dz;
        pos[3 * k + 1] += e.look.y * dz;
        pos[3 * k + 2] += e.look.z * dz;
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  weldNormals(g);
  const mesh = new THREE.Mesh(g, mats.skin);
  mesh.name = "head";
  mesh.userData = { head: true, sockets: eyes.length, frame: f };
  return [mesh];
}

/** The JAW mesh (JAW joint frame): the jaw ellipsoid scaled by MouthP5.scale. */
export function buildJaw(jaw: JointDef, helix: MorphHelix, mats: SkinMaterials, quality: Quality): THREE.Object3D[] {
  const J = jawVolume(jaw, helix);
  const seg = quality === "high" ? 14 : 9;
  const g = new THREE.SphereGeometry(1, seg, seg);
  g.applyMatrix4(new THREE.Matrix4().makeScale(J.a, J.b, J.d));
  g.applyMatrix4(new THREE.Matrix4().makeBasis(J.f.side, J.f.up, J.f.fwd).setPosition(J.c));
  const mesh = new THREE.Mesh(g, mats.belly);
  mesh.name = "jaw";
  mesh.userData = { jawVolume: true };
  return [mesh];
}

// ------------------------------------------------------------------ the face
/** Pupil shape actually drawn: the style decides, the helix pupil fill refines sharp / sleepy eyes. */
function pupilOf(style: EyeStyle, fill: PupilFill): PupilFill {
  switch (style) {
    case "round":
      return "full";
    case "sparkle":
      return "full";
    case "ring":
      return "hollow";
    case "blank":
    case "compound":
      return "none";
    case "slit":
      return "slit";
    default:
      return fill;
  }
}

/** Front-edge elevation of the open upper lid (rad): pi/2 = fully open, 0 = half covered. */
const LID_OPEN: Record<EyeStyle, number> = {
  round: 0.95,
  sparkle: 1.05,
  ring: 0.9,
  blank: 0.8,
  slit: 0.85,
  sharp: 0.42,
  sleepy: 0.1, // (1 - sin 0.1) / 2 = 45 % of the eye covered
  compound: 0,
};

/** Beak section profile per kind: width / height factors, hook (tip droop) and a shovel flare. */
const BEAK_FORM: Record<Exclude<BeakKind, "none">, { w: number; h: number; hook: number; flare: number }> = {
  round: { w: 1.0, h: 1.05, hook: 0.22, flare: 0 },
  hooked: { w: 0.8, h: 1.1, hook: 0.55, flare: 0 },
  flat: { w: 1.3, h: 0.45, hook: 0.04, flare: 0.25 },
  needle: { w: 0.42, h: 0.42, hook: 0.05, flare: 0 },
  shovel: { w: 0.95, h: 0.38, hook: 0, flare: 0.9 },
};

/** One beak mandible as a loft along +Z: sharp cone (round 0) .. blunt ball (round 1). */
export function beakGeometry(kind: Exclude<BeakKind, "none">, len: number, rb: number, round: number, quality: Quality, lower = false): THREE.BufferGeometry {
  const F = BEAK_FORM[kind];
  const ro = clamp(round, 0, 1);
  const prof = (t: number) => {
    const sharp = 1 - t, blunt = Math.sqrt(Math.max(0, 1 - Math.pow(t, 2 + 4 * ro)));
    return sharp + (blunt - sharp) * ro;
  };
  // Bills (flat, shovel) keep their width to a blunt spatula end; the shovel flares near the tip.
  const bill = kind === "flat" || kind === "shovel";
  const close = (t: number) => Math.sqrt(Math.max(0, 1 - Math.pow(t, 4 + 8 * ro)));
  const flare = (t: number) => 1 + F.flare * Math.exp(-(((t - 0.8) / 0.18) ** 2));
  const hook = lower ? 0 : F.hook;
  const st = quality === "high" ? 10 : 6, ring = quality === "high" ? 12 : 8;
  return loftZ(
    len,
    (t) => rb * F.w * (bill ? (0.75 + 0.1 * t) * close(t) : prof(t)) * flare(t),
    (t) => rb * F.h * (lower ? 0.7 : 1) * (bill ? (1 - 0.45 * t) * close(t) : prof(t)),
    (t) => (lower ? 0.15 : -1) * hook * len * Math.pow(t, 2.2),
    st,
    ring,
  );
}

/** Tongue (JAW frame, along +Z): a flat tapering blade; a forked tongue splits into two prongs. */
function tongueGeometry(len: number, w: number, th: number, fork: boolean, quality: Quality): THREE.BufferGeometry {
  const st = quality === "high" ? 8 : 5, ring = quality === "high" ? 10 : 6;
  if (!fork) {
    return loftZ(len, (t) => w * (0.55 + 0.45 * Math.sqrt(Math.max(0, 1 - t * t))) * (t > 0.92 ? (1 - t) / 0.08 : 1), (t) => th * (1 - 0.5 * t), () => 0, st, ring);
  }
  const stem = 0.68, pl = len * (1 - stem);
  const base = loftZ(len * stem, (t) => w * (0.75 - 0.35 * t), (t) => th * (1 - 0.4 * t), () => 0, st, ring);
  const parts: { geo: THREE.BufferGeometry; m: THREE.Matrix4 }[] = [{ geo: base, m: new THREE.Matrix4() }];
  for (const s of [-1, 1]) {
    const prong = loftZ(pl, (t) => w * 0.2 * (1 - t), (t) => th * 0.45 * (1 - t), () => 0, 4, 5);
    const m = new THREE.Matrix4().makeRotationY(s * 0.32).setPosition(s * w * 0.14, 0, len * stem * 0.94);
    parts.push({ geo: prong, m });
  }
  const g = mergeParts(parts);
  for (const p of parts) p.geo.dispose();
  return g;
}

export function buildFace(head: JointDef, jaw: JointDef | undefined, ph: Phenotype, helix: MorphHelix, mats: SkinMaterials, quality: Quality): FaceParts {
  const hi = quality === "high";
  const r = Math.max(1e-3, head.r0), L = Math.max(1e-3, head.length);
  const H = headVolume(head);
  const hf = H.f;
  const E = helix.eyes, M = helix.mouth, G = faceGenes(helix);
  const style = E.style;
  const glow = clamp(E.glow, 0, 1);
  const lidAngle = clamp(E.lidAngle, -0.8, 0.8);

  const headObjs: THREE.Object3D[] = [];
  const jawObjs: THREE.Object3D[] = [];
  const pupils: THREE.Object3D[] = [];
  const lids: THREE.Object3D[] = [];
  const eyeMaterials: THREE.Material[] = [];
  const auraEmitters: V3[] = [];

  // ------------------------------------------------------------------ eye materials (shared by all eyes)
  const irisCol = new THREE.Color(E.irisColor);
  const glowing = glow > 0.35;
  const irisEmissive = Math.min(3, ((glowing ? 0.5 : 0.18) * (0.08 + glow)) / Math.max(0.1, luminance(irisCol)));
  const sclera = hi
    ? new THREE.MeshPhysicalMaterial({ color: E.scleraColor, roughness: 0.22, clearcoat: 1, clearcoatRoughness: 0.08 })
    : new THREE.MeshStandardMaterial({ color: E.scleraColor, roughness: 0.25 });
  if (style === "blank") {
    // White eyes: menace reads better with a faint inner light.
    sclera.emissive.setHex(E.scleraColor);
    sclera.emissiveIntensity = 0.14 + 0.4 * glow;
    sclera.userData.glowBase = sclera.emissiveIntensity;
  }
  const iris = new THREE.MeshStandardMaterial({
    color: irisCol,
    roughness: 0.18,
    emissive: irisCol,
    emissiveIntensity: irisEmissive,
    flatShading: style === "compound",
    metalness: style === "compound" ? 0.3 : 0,
  });
  iris.userData.glowBase = irisEmissive;
  const pupilMat = new THREE.MeshBasicMaterial({ color: 0x07070c });
  const white = new THREE.MeshBasicMaterial({ color: 0xffffff });
  eyeMaterials.push(sclera, iris, pupilMat, white);
  let bead: THREE.MeshBasicMaterial | null = null;
  if (glowing && style !== "blank") {
    // Hot bead: lighter than the shell and above 1.0 so it is the part that blooms.
    const hot = irisCol.clone().lerp(new THREE.Color(ph.palette.glow), 0.25).lerp(new THREE.Color(0xffffff), 0.35).multiplyScalar(1 + 1.6 * glow);
    bead = new THREE.MeshBasicMaterial({ color: hot });
    eyeMaterials.push(bead);
  }

  // ------------------------------------------------------------------ eyes (in their carved sockets)
  const fill = pupilOf(style, E.pupil);
  const placed = eyePlacements(head, ph, helix);
  const nEyes = placed.length;
  const segBase = hi ? 20 : 12;
  const seg = Math.max(8, 2 * Math.round((segBase * Math.pow(2 / Math.max(2, nEyes), 0.65)) / 2));
  const shape: EyeShape = G.eyes.shape;
  for (const pl of placed) {
    const er = pl.er, index = pl.index;
    const eye = new THREE.Group();
    eye.name = `eye${index}`;
    eye.userData = { eye: true, style, index, side: pl.side, radius: er, shape, socketDepth: G.eyes.socketDepth };
    eye.position.copy(pl.centre);
    eye.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(pl.ex, pl.ey, pl.look));
    eye.scale.set(pl.scale[0], pl.scale[1], pl.scale[2]);
    headObjs.push(eye);

    if (style === "compound") {
      const dome = new THREE.Mesh(new THREE.IcosahedronGeometry(er * 1.04, hi && nEyes <= 4 ? 2 : 1), iris);
      eye.add(dome);
      const cl = new THREE.Mesh(new THREE.SphereGeometry(er * 0.12, 8, 6), white);
      cl.position.set(-er * 0.32, er * 0.4, er * 0.97);
      cl.userData.catchlight = true;
      eye.add(cl);
    } else {
      eye.add(new THREE.Mesh(new THREE.SphereGeometry(er, seg, seg / 2), sclera));
      if (style !== "blank") {
        const ir = er * (style === "sparkle" ? 0.78 : style === "sharp" ? 0.66 : 0.62);
        eye.add(new THREE.Mesh(shellPatch(er * 1.012, ir, ir, { rings: hi ? 3 : 1, segs: seg }), iris));
        if (bead) eye.add(new THREE.Mesh(shellPatch(er * 1.02, ir * 0.36, ir * 0.15, { cy: -ir * 0.64, rings: hi ? 2 : 1, segs: Math.max(8, Math.round(seg * 0.7)) }), bead));
        const pr = er * (style === "sparkle" ? 0.28 : 0.3);
        let pupil: THREE.Object3D | null = null;
        const R = er * 1.05;
        const ps = Math.max(8, seg);
        if (fill === "full") pupil = new THREE.Mesh(shellPatch(R, pr, pr, { rings: hi ? 2 : 1, segs: ps }), pupilMat);
        else if (fill === "slit") pupil = new THREE.Mesh(shellPatch(R, pr * 0.3, ir * 0.82, { rings: hi ? 2 : 1, segs: ps }), pupilMat);
        else if (fill === "star") pupil = new THREE.Mesh(shellPatch(R, pr * 1.2, pr * 1.2, { star: 4, rings: 2, segs: 32 }), pupilMat);
        else if (fill === "hollow") {
          // Hollow pupil: a dark ring with the iris colour still showing inside it.
          const ring = new THREE.Mesh(new THREE.TorusGeometry(pr, pr * 0.24, 8, seg), pupilMat);
          ring.position.z = Math.sqrt(R * R - pr * pr);
          pupil = ring;
        }
        if (pupil instanceof THREE.Mesh && fill !== "hollow") {
          // Re-centre the patch on its own pole so emotion scaling (setPupils) happens about the pupil,
          // not the eye centre: a pupil scaled about the eye centre would sink into the sclera.
          pupil.geometry.translate(0, 0, -R);
          pupil.position.z = R;
        }
        if (pupil) {
          pupil.userData.pupil = true;
          eye.add(pupil);
          pupils.push(pupil);
        }
        // Catchlight on the saturated upper half; sparkle eyes get stars instead of a dot.
        const hl = (geo: THREE.BufferGeometry) => {
          const m = new THREE.Mesh(geo, white);
          m.userData.catchlight = true;
          eye.add(m);
        };
        if (style === "sparkle") {
          hl(shellPatch(er * 1.07, er * 0.22, er * 0.22, { cx: -er * 0.27, cy: er * 0.3, star: 4, rings: 2, segs: 32 }));
          hl(shellPatch(er * 1.07, er * 0.11, er * 0.11, { cx: er * 0.24, cy: -er * 0.27, star: 4, rings: 2, segs: 24 }));
          hl(shellPatch(er * 1.07, er * 0.05, er * 0.05, { cx: er * 0.05, cy: er * 0.45, rings: 1, segs: 10 }));
        } else {
          hl(shellPatch(er * 1.07, er * 0.13, er * 0.11, { cx: -er * 0.25, cy: er * 0.27, rings: hi ? 2 : 1, segs: Math.max(8, Math.round(seg * 0.6)) }));
        }
      }
      // Outline mask: skin on the 1.09 shell around the outline, so the opening is almond / tear / ...
      const mask = new THREE.Mesh(outlineMask(er * 1.09, shape, pl.side === 0 ? 1 : pl.side, Math.max(hi ? 12 : 10, seg + 4), hi ? 2 : 1), mats.skin);
      mask.userData.outline = shape;
      eye.add(mask);
      // Upper lid: a skin hemisphere hinged on the eye centre. rotation.x = userData.open (front edge
      // above the iris) .. userData.closed (pi/2 covers the eye). Tilt (lidAngle) lives on the parent.
      const tilt = new THREE.Group();
      tilt.rotation.z = pl.side * lidAngle;
      const lid = new THREE.Group();
      const shell = new THREE.Mesh(new THREE.SphereGeometry(er * 1.11, seg, Math.max(3, Math.round(seg / 4)), 0, Math.PI * 2, 0, Math.PI / 2), mats.skin);
      lid.add(shell);
      const e = LID_OPEN[style] - Math.max(0, -lidAngle) * 0.4;
      lid.rotation.x = -e;
      lid.userData = { lid: true, open: -e, closed: Math.PI / 2 };
      tilt.add(lid);
      eye.add(tilt);
      lids.push(lid);
    }
    const sy = pl.scale[1];
    auraEmitters.push(pl.centre.clone().addScaledVector(pl.ey, er * sy * 0.95).addScaledVector(pl.look, er * 0.45));
  }

  // ------------------------------------------------------------------ mouth line, lips, cavity, mouth spec
  const MP = G.mouth;
  const [msx, msy, msz] = MP.scale.map((v) => clamp(v, 0.6, 1.5));
  const width = clamp(M.width, 0.3, 1);
  const aw = clamp((0.18 + 0.75 * width) * msx, 0.15, 1.3);
  const jaf = jaw ? frameOf(jaw.dir) : null;
  const jawOff = jaw ? new THREE.Vector3(jaw.offset[0], jaw.offset[1], jaw.offset[2]) : null;
  const lipUp = jaw && jawOff ? jawOff.dot(hf.up) + 0.1 * jaw.r0 : -0.33 * r;
  const elM = Math.asin(clamp(lipUp / H.b, -0.9, -0.05)) + 0.12 * clamp(MP.height, -1, 1);
  const dark = new THREE.MeshStandardMaterial({ color: 0x2a0b12, roughness: 0.9 });
  eyeMaterials.push(dark);
  // Lip curve: + smile lifts the corners, - frown drops them (legacy helices: from the lid angle).
  const corner = helix.p5 ? 0.16 * clamp(MP.lipCurve, -1, 1) : lidAngle > 0.15 ? -0.08 : 0.05;
  const beak: BeakKind = MP.beak !== "none" ? MP.beak : M.teeth === "beak" ? "hooked" : "none";
  const lipPts: V3[] = [], upperLip: V3[] = [];
  for (let i = 0; i <= 12; i++) {
    const t = i / 6 - 1;
    lipPts.push(surface(H, t * aw, elM + corner * t * t, 1.004).p);
    upperLip.push(surface(H, t * aw * 0.96, elM + 0.035 + corner * t * t, 1.0).p);
  }
  const line = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(lipPts), hi ? 20 : 12, r * (0.025 + 0.02 * width) * Math.sqrt(msy), 5), dark);
  line.userData.mouthLine = true;
  headObjs.push(line);
  if (beak === "none") {
    // Lips: a soft skin ridge over the mouth line.
    const lip = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(upperLip), hi ? 16 : 10, r * 0.038 * msy, 4), mats.skin);
    lip.userData.lip = MP.lipCurve;
    headObjs.push(lip);
  }
  const J: Ellipsoid | null = jaw ? jawVolume(jaw, helix) : null;
  if (jaw && jawOff && jaf) {
    const cav = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 6), dark);
    cav.position.copy(jawOff).addScaledVector(jaf.fwd, jaw.length * 0.45 * msz).addScaledVector(hf.up, 0.05 * r);
    cav.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), hf.fwd);
    cav.scale.set(Math.max(0.2 * r, r * Math.sin(aw) * 0.85), 0.2 * r * msy, jaw.length * 0.42 * msz);
    cav.userData.mouthCavity = true;
    headObjs.push(cav);
  }
  const front = surface(H, 0, elM);
  const mouth = {
    origin: front.p.clone().addScaledVector(front.n, 0.04 * r),
    dir: hf.fwd.clone().addScaledVector(front.n, 0.35).normalize(),
    width: 2 * H.a * Math.sin(aw) * Math.cos(elM),
  };

  // ------------------------------------------------------------------ teeth / beak / tongue
  const kind: TeethKind = M.teeth;
  const len = (0.05 + clamp(M.toothLength, 0, 0.6)) * r;
  const n = kind === "none" || kind === "beak" || beak !== "none" ? 0 : Math.round(clamp(M.teethCount, 1, 12));
  // Teeth cones: fewer facets on the low tier.
  const cone = (rb: number, len: number, bend: number, radial = 7) => bentCone(rb, len, bend, hi ? radial : Math.max(4, radial - 2), hi ? 3 : 2);
  if (n > 0) {
    const half = (jawKey: "upper" | "lower", s: -1 | 1) => {
      const upper = jawKey === "upper";
      const ell = upper ? H : J!;
      const span = upper ? aw * 0.92 : 0.25 + 0.85 * width;
      const spacing = Math.max(1e-3, (ell.a * span) / n);
      const rb = Math.min(spacing * 0.48, len * 0.38);
      const parts: { geo: THREE.BufferGeometry; m: THREE.Matrix4 }[] = [];
      const tips: number[][] = [];
      const templates: THREE.BufferGeometry[] = [];
      const tmpl = (g: THREE.BufferGeometry) => (templates.push(g), g);
      const small = tmpl(cone(rb * 0.8, len * 0.35, 0));
      const plain = tmpl(cone(rb, len, 0, 6));
      for (let k = 0; k < n; k++) {
        const t = (k + 0.6) / (n + 0.4);
        const sp = upper ? surface(H, s * t * span, elM + 0.03, 0.985) : surface(J!, s * t * span, 0.7, 0.97);
        const axis = upper ? hf.up.clone().negate().addScaledVector(sp.n, 0.25) : ell.f.up.clone().addScaledVector(sp.n, 0.2);
        let geo = plain, tipLen = len, bend = 0;
        if (kind === "fangs") {
          const fang = k === (n >= 3 ? 1 : 0);
          geo = fang ? tmpl(cone(rb * 1.5, len * 1.25, -0.12)) : small;
          tipLen = fang ? len * 1.25 : len * 0.35;
          bend = fang ? -0.12 : 0;
        } else if (kind === "saw") {
          const g = new THREE.ConeGeometry(spacing * 0.55, len * 0.8, 3, 1);
          g.translate(0, len * 0.4 - len * 0.1, 0);
          g.scale(1, 1, 0.35);
          geo = tmpl(g);
          tipLen = len * 0.8;
        } else if (kind === "needles") {
          geo = tmpl(cone(Math.min(rb * 0.45, 0.03 * r), len * 1.1, -0.05, 4));
          tipLen = len * 1.1;
        } else if (kind === "molars") {
          const g = new THREE.BoxGeometry(spacing * 0.8, len * 0.45, spacing * 0.75);
          g.translate(0, len * 0.225 - len * 0.08, 0);
          geo = tmpl(g);
          tipLen = len * 0.45;
        } else if (kind === "tusks" && !upper && k === n - 1) {
          geo = tmpl(cone(rb * 2.1, len * 2.4, 0.35, 8));
          tipLen = len * 2.4;
          bend = 0.35;
        } else if (kind === "tusks") {
          geo = small;
          tipLen = len * 0.35;
        }
        // Tusks curve outward + forward; other teeth curve back into the mouth.
        const toward = kind === "tusks" ? ell.f.fwd.clone().addScaledVector(ell.f.side, s * 0.8) : ell.f.fwd.clone().negate();
        const q = orient(axis, toward);
        const m = new THREE.Matrix4().compose(sp.p, q, new THREE.Vector3(1, 1, 1));
        parts.push({ geo, m });
        const tipLocal = new THREE.Vector3(0, tipLen * 0.88, bend * tipLen * 0.77);
        const tip = tipLocal.applyMatrix4(m);
        tips.push([tip.x, tip.y, tip.z]);
      }
      const mesh = new THREE.Mesh(mergeParts(parts), mats.keratin);
      for (const g of templates) g.dispose();
      mesh.userData = { teeth: n, kind, jaw: jawKey, side: s, tips };
      (upper ? headObjs : jawObjs).push(mesh);
    };
    for (const s of [-1, 1] as const) {
      half("upper", s);
      if (J) half("lower", s);
    }
  }
  if (beak !== "none") {
    // Upper mandible from the front of the head, lower one on the jaw. Round beaks are blunt balls of
    // several sizes (beakLength), needles long and sharp, shovels flare at the tip.
    const rb = r * (0.24 + 0.2 * width) * msx;
    const base = surface(H, 0, elM + 0.2, 0.8);
    const bl = clamp(G.mouth.beakLength, 0.08, 0.9) * L + 0.2 * H.d;
    const upAxis = hf.fwd.clone().addScaledVector(hf.up, -0.22).normalize();
    const upY = hf.up.clone().addScaledVector(upAxis, -hf.up.dot(upAxis)).normalize();
    const upX = new THREE.Vector3().crossVectors(upY, upAxis).normalize();
    const up = new THREE.Mesh(beakGeometry(beak, bl, rb, G.mouth.beakRound, quality), mats.keratin);
    up.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(upX, upY, upAxis));
    up.position.copy(base.p);
    up.userData = { beak: "upper", kind: beak, length: bl, round: G.mouth.beakRound };
    headObjs.push(up);
    if (J) {
      const lb = surface(J, 0, 0.25, 0.7);
      const lAxis = J.f.fwd.clone();
      const lY = J.f.up.clone();
      const lX = new THREE.Vector3().crossVectors(lY, lAxis).normalize();
      const lo = new THREE.Mesh(beakGeometry(beak, bl * (beak === "hooked" ? 0.62 : 0.8), rb * 0.75, G.mouth.beakRound, quality, true), mats.keratin);
      lo.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(lX, lY, lAxis));
      lo.position.copy(lb.p);
      lo.userData = { beak: "lower", kind: beak };
      jawObjs.push(lo);
    }
  }
  const tl = G.mouth.tongueLength;
  if (tl > 0 && J && jaw) {
    const tc = new THREE.Color(0xd9576f).lerp(new THREE.Color(ph.palette.accent), 0.15);
    const tm = hi
      ? new THREE.MeshPhysicalMaterial({ color: tc, roughness: 0.45, clearcoat: 0.6, clearcoatRoughness: 0.3 })
      : new THREE.MeshStandardMaterial({ color: tc, roughness: 0.5 });
    eyeMaterials.push(tm);
    // Inside the jaw: rooted behind the jaw centre, lying on its floor, at most as long as the jaw.
    const tLen = Math.min(tl * L, J.d * 1.85);
    const fork = G.mouth.tongueFork;
    const tg = tongueGeometry(tLen, J.a * 0.42, J.b * 0.3, fork, quality);
    const tongue = new THREE.Mesh(tg, tm);
    const tX = new THREE.Vector3().crossVectors(J.f.up, J.f.fwd).normalize();
    tongue.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(tX, J.f.up, J.f.fwd));
    tongue.position.copy(J.c).addScaledVector(J.f.up, J.b * 0.8).addScaledVector(J.f.fwd, -J.d * 0.92);
    tongue.userData = { tongue: true, fork, length: tLen };
    jawObjs.push(tongue);
  }
  return { head: headObjs, jaw: jawObjs, pupils, lids, eyeMaterials, auraEmitters, mouth };
}
