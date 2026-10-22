/**
 * The egg and the fetus [P5-V2]. Development starts in an egg: the embryo lies CURLED on itself in a spiral
 * (GrowthGenes.spiral turns shared along the neck, spine and tail, tighter toward the tail tip, limbs folded
 * against the belly, wings folded) and uncurls as it develops. Three pure-ish helpers for the views:
 *
 * - fetusPose(sk, growth, spiral): the curled pose (a Pose for CreatureView.applyPose). It is NOT passed
 *   through constrainPose: an embryo is not a standing, fighting body, its chains exceed the adult budgets
 *   by design. growth here is the development progress (0 = tight spiral, ~0.85+ = uncurled).
 * - eggFit(sk, pose): the egg size and centre (creature space) that encloses the curled body.
 * - buildEgg(spec, colour, seed, quality): a lathe shell (indexed, normals, UVs) with SEEDED speckles in
 *   vertex colours, element-tinted by the passed colour; optional translucency to show the embryo inside.
 *
 * Determinism: speckles come from Rng(seed) (no Math.random): the same Genemon always lays the same egg.
 */
import * as THREE from "../../lib/three.ts";
import { forwardKinematics, type Pose, type Skeleton, type Vec3 } from "../../body/skeleton.ts";
import { Rng } from "../../core/rng.ts";
import { clamp01, smoothstep } from "./loft.ts";

/** How curled the embryo is at development progress `growth`: 1 (tight spiral) .. 0 (uncurled). */
export function curlAmount(growth: number): number {
  return 1 - smoothstep(0.05, 0.85, clamp01(Number.isFinite(growth) ? growth : 0));
}

/**
 * The fetal pose. Sagittal curl (+X = ventral for forward bones, -X for backward ones: tails, abdomens) over
 * the neck / spine / tail path with weights growing toward the tail tip (a logarithmic-spiral feel); a
 * serpent coils flat (yaw) with its head tucked; tentacles roll inward; legs fold, wings fold.
 * The summed |angle| over the curl path equals spiral x 2 pi x curlAmount(growth).
 */
export function fetusPose(sk: Skeleton, growth: number, spiral: number): Pose {
  const c = curlAmount(growth);
  const turns = Math.max(0.3, Math.min(2.5, Number.isFinite(spiral) ? spiral : 1));
  const total = turns * 2 * Math.PI * c;
  const pose: Pose = {};
  const J = sk.joints;
  const set = (id: string, x: number, y = 0, z = 0) => {
    const a = pose[id] ?? [0, 0, 0];
    pose[id] = [a[0] + x, a[1] + y, a[2] + z];
  };
  if (c <= 0) return pose;
  const serpent = sk.kind === "serpent";
  // The curl path: forward chain (spine, neck, head) gets +, backward chains (tail, abdomen, serpent body) -.
  const path: { id: string; sign: number; w: number }[] = [];
  const back = J.filter((j) => j.role === "tail" || (j.role === "segment" && (j.chain === "abdomen" || j.chain === "body")) || (serpent && j.role === "root"));
  const fwd = J.filter((j) => j.role === "spine" || j.role === "chest" || j.role === "neck" || j.role === "head" || (j.role === "segment" && j.chain === "stack"));
  // Bend per joint ~ bone length x weight (a curvature, so the long trunk curls as much as the short tail),
  // the weight growing toward the tail tip (tighter inner coil: a logarithmic-spiral feel).
  const Lof = (j: { length: number; r0: number }) => Math.max(j.length, j.r0, 1e-4);
  fwd.forEach((j) => path.push({ id: j.id, sign: 1, w: Lof(j) * (j.role === "neck" ? 1.3 : j.role === "head" ? 0.6 : 1) }));
  back.forEach((j, k) => path.push({ id: j.id, sign: -1, w: Lof(j) * (1 + 1.6 * (k / Math.max(1, back.length - 1))) }));
  const wsum = path.reduce((s, p) => s + p.w, 0) || 1;
  if (serpent) {
    // A flat coil (yaw), body and tail tighter toward the tip; head and neck tucked toward the coil.
    const coil = back.map((j, k) => ({ id: j.id, w: Lof(j) * (1 + 1.6 * (k / Math.max(1, back.length - 1))) }));
    const cs = coil.reduce((s, p) => s + p.w, 0) || 1;
    for (const p of coil) set(p.id, 0.04 * c, (total * p.w) / cs);
    for (const j of J) if (j.role === "neck" || j.role === "head") set(j.id, 0.35 * c, 0.4 * c);
  } else {
    for (const p of path) set(p.id, (p.sign * total * p.w) / wsum);
  }
  // Tentacles roll up and inward about the horizontal axis perpendicular to their outward direction.
  const q = new THREE.Quaternion(), eu = new THREE.Euler();
  for (const j of J) {
    if (!j.chain.startsWith("tent")) continue;
    const root = J[sk.index.get(j.chain) ?? -1] ?? j;
    const e = Math.atan2(root.dir[0], root.dir[2]);
    const k = j.role === "pod" ? 0.5 : 0.7;
    q.setFromAxisAngle(new THREE.Vector3(Math.cos(e), 0, -Math.sin(e)), -k * c);
    eu.setFromQuaternion(q, "XYZ");
    set(j.id, eu.x, eu.y, eu.z);
  }
  // Limbs fold against the belly; wings fold along the flanks.
  for (const j of J) {
    const leg = j.chain.startsWith("leg");
    if (leg && j.role === "hip") set(j.id, -1.0 * c);
    else if (leg && j.role === "shoulder") set(j.id, 0.7 * c);
    else if (j.role === "knee") set(j.id, 1.3 * c);
    else if (j.role === "ankle" && leg) set(j.id, -0.5 * c);
    else if (j.role === "shoulder") set(j.id, -0.9 * c, 0, -j.side * 0.25 * c);
    else if (j.role === "elbow") set(j.id, -1.6 * c);
    else if (j.role === "pod") set(j.id, -0.5 * c);
    else if (j.role === "wingRoot") set(j.id, 0, j.side * 0.7 * c, -j.side * 0.5 * c);
    else if (j.role === "wingMid") set(j.id, 0, j.side * 1.2 * c, -j.side * 0.25 * c);
    else if (j.role === "wingTip") set(j.id, 0, j.side * 0.6 * c, 0);
  }
  return pose;
}

export interface EggSpec {
  /** Egg centre in creature space (the creature's root group frame). */
  center: Vec3;
  /** Full width (equatorial diameter) and height (pole to pole), metres. */
  width: number;
  height: number;
  /** Raise the creature group by this much so the egg rests on y = 0. */
  lift: number;
}

const EGG_ASPECT = 1.3;

/** The egg that encloses the (curled) body at `pose`, with a margin; joints are spheres of their radii. */
export function eggFit(sk: Skeleton, pose: Pose, margin = 1.12): EggSpec {
  const fk = forwardKinematics(sk, pose);
  const pts: { p: THREE.Vector3; r: number }[] = [];
  sk.joints.forEach((j, i) => {
    const r = Math.max(j.r0, j.r1, j.role === "head" ? j.length * 0.62 : 0);
    pts.push({ p: fk.pos[i], r: j.r0 }, { p: fk.pos[i].clone().lerp(fk.end[i], 0.5), r }, { p: fk.end[i], r: j.r1 });
    // The face reaches past the head bone (snout, beak, jaw tip): a margin point beyond the bone end.
    if (j.role === "head" || j.role === "jaw") pts.push({ p: fk.pos[i].clone().lerp(fk.end[i], 1.25), r: j.r0 * 0.6 });
  });
  const box = new THREE.Box3();
  for (const q of pts) box.expandByPoint(q.p);
  const c = box.getCenter(new THREE.Vector3());
  let half = 1e-3;
  for (const q of pts) {
    const dx = q.p.x - c.x, dy = (q.p.y - c.y) / EGG_ASPECT, dz = q.p.z - c.z;
    half = Math.max(half, Math.hypot(dx, dy, dz) + q.r);
  }
  const width = 2 * half * margin, height = width * EGG_ASPECT;
  return { center: [c.x, c.y, c.z], width, height, lift: height / 2 - c.y };
}

/**
 * The egg that encloses the ACTUAL meshes of a posed creature (call after applyPose + updateMatrixWorld):
 * vertices of every mesh under `root`, expressed in root's local frame. Exact where eggFit is an estimate.
 */
export function eggFitObject(root: THREE.Object3D, margin = 1.06, stride = 3): EggSpec {
  root.updateMatrixWorld(true);
  const inv = root.matrixWorld.clone().invert();
  const pts: THREE.Vector3[] = [];
  const v = new THREE.Vector3();
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || m.name === "egg") return;
    const M = inv.clone().multiply(m.matrixWorld);
    const P = m.geometry.getAttribute("position");
    for (let i = 0; i < P.count; i += stride) pts.push(v.fromBufferAttribute(P, i).applyMatrix4(M).clone());
  });
  const box = new THREE.Box3().setFromPoints(pts);
  const c = box.getCenter(new THREE.Vector3());
  let half = 1e-3;
  for (const p of pts) half = Math.max(half, Math.hypot(p.x - c.x, (p.y - c.y) / EGG_ASPECT, p.z - c.z));
  const width = 2 * half * margin, height = width * EGG_ASPECT;
  return { center: [c.x, c.y, c.z], width, height, lift: height / 2 - c.y };
}

/** Egg radius profile at normalised height y in [-1, 1] (pointier top): r = sqrt(1 - y^2) * (1 - 0.12 y). */
export function eggRadius(y: number): number {
  const t = Math.max(-1, Math.min(1, y));
  return Math.sqrt(Math.max(0, 1 - t * t)) * (1 - 0.12 * t);
}

/**
 * The shell geometry: a lathe (indexed, normals, UVs) centred on the origin, `width` x `height`, with a
 * `color` vertex attribute: the element tint with seeded darker speckles (and a paler cap band).
 */
export function eggGeometry(width: number, height: number, tint: number, seed: number, quality: "low" | "high"): THREE.BufferGeometry {
  const seg = quality === "high" ? 32 : 16, rows = quality === "high" ? 24 : 12;
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i <= rows; i++) {
    const y = -1 + (2 * i) / rows;
    pts.push(new THREE.Vector2(Math.max(1e-4, eggRadius(y)) * (width / 2), (y * height) / 2));
  }
  const geo = new THREE.LatheGeometry(pts, seg);
  const rng = new Rng(seed >>> 0);
  const base = new THREE.Color(tint);
  const pale = base.clone().lerp(new THREE.Color(0xffffff), 0.55);
  const dark = base.clone().multiplyScalar(0.35);
  // Speckles: seeded spots on the unit sphere (more toward the wide bottom), angular radius 0.05..0.16.
  const spots: { d: THREE.Vector3; cos: number }[] = [];
  const nSpots = 14 + rng.int(0, 16);
  for (let k = 0; k < nSpots; k++) {
    const y = -1 + 1.7 * Math.pow(rng.next(), 1.3);
    const a = rng.next() * Math.PI * 2;
    const rr = Math.sqrt(1 - y * y);
    spots.push({ d: new THREE.Vector3(rr * Math.cos(a), y, rr * Math.sin(a)), cos: Math.cos(rng.range(0.05, 0.16)) });
  }
  const P = geo.getAttribute("position");
  const col = new Float32Array(P.count * 3);
  const v = new THREE.Vector3(), cc = new THREE.Color();
  for (let i = 0; i < P.count; i++) {
    v.set(P.getX(i) / (width / 2), P.getY(i) / (height / 2), P.getZ(i) / (width / 2)).normalize();
    cc.copy(pale).lerp(base, 0.5 + 0.5 * smoothstep(0.9, -0.6, v.y));
    for (const s of spots) {
      const d = v.dot(s.d);
      if (d > s.cos) cc.lerp(dark, 0.75 * smoothstep(s.cos, s.cos + (1 - s.cos) * 0.5, d));
    }
    col[i * 3] = cc.r;
    col[i * 3 + 1] = cc.g;
    col[i * 3 + 2] = cc.b;
  }
  geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

/**
 * The egg mesh placed at spec.center (creature space): vertex-coloured standard material, optionally
 * translucent (`opacity` < 1 shows the curled embryo inside, "candling"). The caller disposes geometry and
 * material (mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose()).
 */
export function buildEgg(spec: EggSpec, tint: number, seed: number, quality: "low" | "high", opts: { opacity?: number } = {}): THREE.Mesh {
  const geo = eggGeometry(spec.width, spec.height, tint, seed, quality);
  const opacity = Math.max(0.05, Math.min(1, opts.opacity ?? 1));
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.02, transparent: opacity < 1, opacity, depthWrite: opacity >= 1 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = "egg";
  mesh.position.set(spec.center[0], spec.center[1], spec.center[2]);
  mesh.castShadow = true;
  mesh.userData.egg = { width: spec.width, height: spec.height };
  return mesh;
}
