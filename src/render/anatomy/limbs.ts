/**
 * Limb anatomy (P4-V1, P4-V3): tapered limb lofts with muscle lobes and smoothstep CONNECTORS into the next
 * same-axis segment (knee, elbow, ankle, wrist, wing elbow/wrist), the child's SOCKET sphere owned by the
 * parent segment, and DIGITS for feet and hands: helix.digits toes/fingers fanned across the sole, 2-3
 * phalanges each (fractalDepth >= 2 adds knuckle bulges and keratin claws of helix.clawLength x the digit
 * length), plus a sole/palm pad. Also the shared assembly helpers of the anatomy lane: material slots,
 * per-joint mesh merging, the mirror canon (every lateral part is built for side +1 and mirrored, so a
 * symmetric helix gives EXACT mirror images) and the quality resolutions.
 */
import * as THREE from "../../lib/three.ts";
import type { JointDef, JointRole } from "../../body/skeleton.ts";
import type { Phenotype } from "../../genome/phenotype.ts";
import type { MorphHelix } from "../../genome/morphTypes.ts";
import type { SkinMaterials } from "./types.ts";
import { asymScale } from "./hitbox.ts";
import {
  add3,
  bezier3,
  boneFrame,
  boneRings,
  bump,
  clamp01,
  cross3,
  curveRings,
  len3,
  loftRings,
  mergePieces,
  mirrorX,
  mul3,
  norm3,
  type Piece,
  rotate3,
  type Section,
  smoothstep,
  sphereGeo,
  type Station,
  sub3,
  taper,
  type V3,
} from "./loft.ts";

export type Quality = "low" | "high";
export type Slot = "skin" | "belly" | "accent" | "keratin" | "membrane";
export const SLOT_ORDER: readonly Slot[] = ["skin", "belly", "accent", "keratin", "membrane"];

export interface Res {
  /** Torso / neck / tail ring vertices. */
  radial: number;
  limbRadial: number;
  smallRadial: number;
  /** Stations per torso / limb bone. */
  stations: number;
  limbStations: number;
  capRings: number;
  sphere: [number, number];
  grid: [number, number];
}

export function resolution(q: Quality): Res {
  return q === "high"
    ? { radial: 20, limbRadial: 14, smallRadial: 8, stations: 8, limbStations: 7, capRings: 3, sphere: [14, 10], grid: [10, 6] }
    : { radial: 10, limbRadial: 8, smallRadial: 6, stations: 4, limbStations: 4, capRings: 2, sphere: [8, 6], grid: [5, 3] };
}

/** Mirror a vector into the side +1 canon (x negated for side -1). */
export function canon(v: V3, side: number): V3 {
  return side < 0 ? [-v[0], v[1], v[2]] : [v[0], v[1], v[2]];
}

/** The side +1 twin of a lateral joint (identity for median joints). */
export function canonJoint(j: JointDef): JointDef {
  return j.side < 0 ? { ...j, side: 1, offset: canon(j.offset, -1), dir: canon(j.dir, -1) } : j;
}

/** Merge a joint's pieces into ONE mesh (one group per material slot), mirrored and scaled as asked. */
export function meshOf(pieces: Piece<Slot>[], mats: SkinMaterials, name: string, mirror: boolean, scale = 1): THREE.Mesh | null {
  const m = mergePieces(pieces, SLOT_ORDER);
  if (!m) return null;
  if (mirror) mirrorX(m.geo);
  if (scale !== 1) m.geo.scale(scale, scale, scale);
  m.geo.computeBoundingBox();
  m.geo.computeBoundingSphere();
  const list = m.slots.map((s) => mats[s]);
  const mesh = new THREE.Mesh(m.geo, list.length === 1 ? list[0] : list);
  mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = false;
  return mesh;
}

/**
 * Socket-sphere radius multiplier for a child pivot, applied to the child's root radius. Cross-pivot joints
 * (hip, shoulder, wing root, neck/tail roots, pods) are hidden by a sphere OWNED BY THE PARENT and centred
 * on the child pivot: a sphere is invariant under rotation about its centre, so no pose opens a gap. The
 * hip needs more than the shoulder because the pelvis is wide and the thigh root small.
 */
export function socketK(role: JointRole): number {
  switch (role) {
    case "hip":
      return 1.6;
    case "shoulder":
    case "pod":
      return 1.35;
    case "wingRoot":
      return 1.5;
    case "neck":
      return 1.2;
    case "tail":
      return 1.15;
    case "segment":
      return 0.85;
    case "wingMid":
    case "wingTip":
      return 1.15;
    default:
      return 1.08;
  }
}

export type LimbPart = "upper" | "lower" | "foot" | "pod" | "podTip" | "wing";

/**
 * A limb segment in its (canonical) joint frame: a tapered loft from slightly behind the pivot to the bone
 * end, then a smoothstep connector toward the child's root radius, with muscle lobes (thigh / biceps in
 * front and outside, hamstring behind; calf behind on the lower segment), and the child's socket sphere.
 * `lengthOverride` stretches the bone (wing tip extended to the requested span).
 */
export function limbPieces(j: JointDef, child: JointDef | undefined, part: LimbPart, ph: Phenotype, helix: MorphHelix, res: Res, lengthOverride?: number): Piece<Slot>[] {
  const L = Math.max(1e-4, lengthOverride ?? j.length);
  const r0 = Math.max(1e-4, j.r0), r1 = Math.max(1e-4, j.r1);
  const F = clamp01(helix.fusion), A = clamp01(helix.angularity), G = clamp01(ph.plan.girth);
  const back = r0 * 0.35;
  const fwd = child ? Math.max(1e-4, child.r0) * (0.45 + 0.5 * F) : 0;
  const n = res.limbStations + (child ? 2 : 0);
  const exp = 1.92 + 0.5 * A;
  const sharp = 2.2 + 5 * A;
  const m = 0.1 + 0.12 * G;
  const st: Station[] = [];
  for (let k = 0; k < n; k++) {
    const t = -back + ((L + fwd + back) * k) / (n - 1);
    const u = clamp01(t / L);
    let r = taper(u, r0, r1);
    if (child && t > L) r = (r1 + (child.r0 - r1) * smoothstep(L, L + fwd, t)) * (1 - 0.06 * smoothstep(L, L + fwd, t));
    const sec: Section = { rx: r, ry: r, exp };
    switch (part) {
      case "upper":
        sec.lobes = [
          { angle: Math.PI / 2, amp: m * bump(u, 0.35, 0.45), sharp },
          { angle: 0, amp: 0.6 * m * bump(u, 0.3, 0.4), sharp },
          { angle: -Math.PI / 2, amp: 0.5 * m * bump(u, 0.45, 0.4), sharp },
        ];
        break;
      case "lower":
        sec.lobes = [
          { angle: -Math.PI / 2, amp: 1.1 * m * bump(u, 0.28, 0.35), sharp },
          { angle: Math.PI / 2, amp: 0.4 * m * A * bump(u, 0.5, 0.45), sharp: sharp + 4 },
        ];
        break;
      case "foot":
        sec.rx = r * (1.1 + 0.25 * u);
        sec.ry = r * 0.62;
        sec.offsetY = r * 0.12;
        sec.exp = 2.15 + 0.3 * A;
        sec.lobes = [{ angle: -Math.PI / 2, amp: -0.1, sharp: 2 }];
        break;
      case "pod":
        sec.lobes = [{ angle: Math.PI / 2, amp: 0.12 * bump(u, 0.3, 0.5), sharp: 2 }, { angle: -Math.PI / 2, amp: 0.12 * bump(u, 0.3, 0.5), sharp: 2 }];
        break;
      case "podTip":
        sec.rx = sec.ry = taper(u, r0, r1 * 0.85);
        break;
      case "wing":
        sec.ry = r * 0.82;
        sec.lobes = [{ angle: Math.PI / 2, amp: 0.15 * bump(u, 0.2, 0.3), sharp: 3 }];
        break;
    }
    st.push({ ...sec, z: t });
  }
  const frame = part === "wing" ? boneFrame(j.dir, [0, 1, 0], [0, 0, 1]) : boneFrame(j.dir, [0, 0, 1], [0, 1, 0]);
  const endCap = child ? 0.5 : part === "foot" ? 0.9 : part === "wing" ? 2.2 : 0.85;
  const out: Piece<Slot>[] = [{
    geo: loftRings(boneRings([0, 0, 0], j.dir, st, frame), { radial: part === "wing" ? res.smallRadial + 2 : res.limbRadial, capRings: res.capRings, capScale: [0.6, endCap] }),
    slots: ["skin"],
  }];
  // `child` is passed in the same canon as `j`, so its offset is already in this frame.
  if (child) out.push({ geo: sphereGeo(child.offset, socketK(child.role) * child.r0, res.sphere[0], res.sphere[1]), slots: ["skin"] });
  return out;
}

// ------------------------------------------------------------------ digits

/** Digits, claws and the pad of one foot/hand (canonical joint frame). */
function digitPieces(j: JointDef, N: number, helix: MorphHelix, res: Res, clawScale: number): Piece<Slot>[] {
  const d = norm3(j.dir);
  const L = Math.max(1e-4, j.length);
  // Sole normal: down, made orthogonal to the bone; a hanging hand's palm faces the body (medial, -X canon).
  let n = sub3([0, -1, 0], mul3(d, -d[1]));
  if (len3(n) < 0.35) n = sub3([-1, 0, 0], mul3(d, -d[0]));
  n = norm3(n);
  const up = mul3(n, -1);
  const s = norm3(cross3(d, n));
  const rEnd = Math.max(1e-4, j.r1);
  const footW = rEnd * 2.1;
  const A = clamp01(helix.angularity);
  const depth = Math.max(0, Math.min(3, Math.round(helix.fractalDepth)));
  const out: Piece<Slot>[] = [];
  // Sole / palm pad (belly material), flattened along the sole normal.
  const padSt: Station[] = [];
  for (let k = 0; k < 4; k++) {
    const u = k / 3;
    padSt.push({ z: L * (0.45 + 0.5 * u), rx: footW * 0.42 * (0.8 + 0.2 * Math.sin(Math.PI * u)), ry: rEnd * 0.24 });
  }
  out.push({
    geo: loftRings(boneRings(mul3(n, rEnd * 0.42), d, padSt, { t: d, x: s, y: up }), { radial: res.smallRadial, capRings: 2, capScale: 0.9 }),
    slots: ["belly"],
  });
  if (N === 0) return out;
  const spacing = N > 1 ? footW / (N - 1) : 0;
  const rd = Math.min(rEnd * (N <= 2 ? 0.5 : 0.4), N > 1 ? spacing * 0.5 : rEnd * 0.5);
  const phal = depth >= 2 ? 3 : 2;
  const samples = phal * (res.limbStations > 5 ? 3 : 1) + 1;
  const curl = 0.5;
  for (let k = 0; k < N; k++) {
    const off = k - (N - 1) / 2;
    const fan = N > 1 ? off * Math.min(0.38, 1.2 / (N - 1)) : 0;
    let dir = rotate3(d, n, fan);
    const centreness = 1 - Math.abs(off) / (N / 2 + 0.5);
    const Ld = Math.max(L * 0.5, rEnd * 2) * (0.75 + 0.35 * centreness) * (depth === 0 ? 0.5 : 1);
    let p = add3(add3(mul3(d, L * 0.8), mul3(s, off * spacing * 0.85)), mul3(dir, -rd * 0.6));
    const pts: V3[] = [];
    const step = (Ld + rd * 0.6) / (samples - 1);
    for (let i = 0; i < samples; i++) {
      pts.push(p);
      p = add3(p, mul3(dir, step));
      dir = norm3(rotate3(dir, cross3(dir, n), curl / samples));
    }
    const knuckle = depth >= 2 ? 0.16 : 0;
    const sectionAt = (u: number): Section => {
      let k2 = 1;
      for (let b = 1; b < phal; b++) k2 += knuckle * bump(u, b / phal, 0.5 / phal);
      const r = rd * (1 - 0.35 * u) * k2;
      return { rx: r, ry: r * 0.85, exp: 2 + 0.3 * A };
    };
    out.push({ geo: loftRings(curveRings(pts, sectionAt, up), { radial: res.smallRadial, capRings: 2, capScale: [0.6, 0.8] }), slots: ["skin"] });
    if (depth >= 2 && helix.clawLength > 0.02) {
      const tip = pts[pts.length - 1];
      const td = norm3(sub3(tip, pts[pts.length - 2]));
      const Lc = Math.max(rd * 0.8, helix.clawLength * Ld * clawScale);
      const p0 = sub3(tip, mul3(td, rd * 0.7));
      const p1 = add3(tip, mul3(td, Lc * 0.45));
      const p2 = add3(add3(tip, mul3(td, Lc * 0.8)), mul3(n, Lc * 0.12));
      const p3 = add3(add3(tip, mul3(td, Lc * 0.95)), mul3(n, Lc * 0.5));
      const cn = res.limbStations > 5 ? 8 : 4;
      const cpts: V3[] = [];
      for (let i = 0; i < cn; i++) cpts.push(bezier3(p0, p1, p2, p3, i / (cn - 1)));
      const cs = (u: number): Section => {
        const r = rd * 0.78 * Math.pow(1 - u, 0.85) + rd * 0.03;
        return { rx: r * 0.8, ry: r };
      };
      out.push({ geo: loftRings(curveRings(cpts, cs, up), { radial: res.smallRadial, capRings: 1, capScale: [0.5, 0.6] }), slots: ["keratin"] });
    }
  }
  return out;
}

/**
 * Digits of a foot (ankle) or hand (wrist) joint, in that joint's local frame: one merged mesh (skin
 * digits, belly pad, keratin claws) whose userData.digits = helix.digits. Serpents and blobs get none.
 */
export function buildDigits(joint: JointDef, ph: Phenotype, helix: MorphHelix, mats: SkinMaterials, quality: Quality): THREE.Object3D[] {
  if (ph.kind === "serpent" || ph.kind === "blob") return [];
  const N = Math.max(0, Math.min(5, Math.round(helix.digits)));
  const pieces = digitPieces(canonJoint(joint), N, helix, resolution(quality), asymScale(helix, "claw", joint.side));
  const mesh = meshOf(pieces, mats, `${joint.id}:digits`, joint.side < 0);
  if (!mesh) return [];
  mesh.userData.digits = N;
  return [mesh];
}
