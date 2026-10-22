/**
 * Hit volumes (P4-V1 "better hitboxes"): spheres along every bone, sized from the same radii the anatomy
 * lofts use (torso widening grows with fusion, limb muscle with girth, asymmetric horns/ears with the
 * helix), instead of one cylinder per body. Pure math: no meshes, no three.js.
 *
 * Offsets are in JOINT space (origin at the joint, bone along j.dir), like the meshes; the footprint and
 * height helpers place them in creature space at the rest pose (every joint frame un-rotated, so a joint's
 * creature position is the sum of the offsets up its parent chain).
 */
import type { Skeleton } from "../../body/skeleton.ts";
import type { Phenotype } from "../../genome/phenotype.ts";
import { type AsymPart, type MorphHelix, P5_DEFAULTS } from "../../genome/morphTypes.ts";
import type { HitSphere } from "./types.ts";

type P3 = [number, number, number];

/** Rare bilateral asymmetry: listed parts on helix.asymmetricSide grow by (1 + a), the other side shrinks by (1 - a/2). */
export function asymScale(helix: MorphHelix, part: AsymPart, side: number): number {
  const a = Math.max(0, Math.min(1, helix.asymmetry || 0));
  if (a <= 0 || side === 0 || !helix.asymmetricParts.includes(part)) return 1;
  return side === helix.asymmetricSide ? 1 + a : 1 - a * 0.5;
}

/** Creature-space rest position of every joint origin. */
export function restPositions(sk: Skeleton): P3[] {
  const out: P3[] = [];
  sk.joints.forEach((j, i) => {
    const p = j.parent < 0 ? [0, 0, 0] : out[j.parent];
    out[i] = [p[0] + j.offset[0], p[1] + j.offset[1], p[2] + j.offset[2]];
  });
  return out;
}

const WING_ROLES = new Set(["wingRoot", "wingMid", "wingTip"]);

/** Tail tips with real volume [P5-V6] get their own hit sphere (tip size x the tail root radius). */
const BULKY_TIPS = new Set(["club", "spade", "fan", "fin", "leaf", "rattle"]);

export function hitSpheres(ph: Phenotype, sk: Skeleton, helix: MorphHelix): HitSphere[] {
  const out: HitSphere[] = [];
  const hasChild = new Set(sk.joints.map((j) => j.parent));
  const tail = (helix.p5 ?? P5_DEFAULTS).body.tail;
  let tails = sk.joints.flatMap((j, i) => (j.role === "tail" ? [i] : []));
  if (tails.length === 0 && sk.kind === "serpent") {
    const body = sk.joints.flatMap((j, i) => (j.chain === "body" ? [i] : []));
    tails = body.slice(Math.floor(body.length * 0.6));
  }
  if (tails.length > 0 && BULKY_TIPS.has(tail.shape)) {
    const last = sk.joints[tails[tails.length - 1]];
    const r = sk.joints[tails[0]].r0 * 0.9 * Math.max(0.4, Math.min(2.5, tail.tipSize));
    const L = last.length + r * 0.6;
    out.push({ joint: tails[tails.length - 1], offset: [last.dir[0] * L, last.dir[1] * L, last.dir[2] * L], r: Math.max(1e-3, r) });
  }
  const torsoK = 1.1 + 0.1 * Math.max(0, Math.min(1, helix.fusion));
  const limbK = 1.08 + 0.12 * Math.max(0, Math.min(1, ph.plan.girth));
  sk.joints.forEach((j, i) => {
    if (j.role === "jaw") return;
    const L = Math.max(0, j.length);
    let k = 1;
    switch (j.role) {
      case "root":
      case "spine":
      case "chest":
      case "segment":
        k = torsoK;
        break;
      case "hip":
      case "shoulder":
      case "knee":
      case "elbow":
      case "pod":
        k = limbK;
        break;
      case "horn":
        k = asymScale(helix, "horn", j.side);
        break;
      case "ear":
        k = asymScale(helix, "ear", j.side);
        break;
      case "wingRoot":
      case "wingMid":
      case "wingTip":
        k = 1.6 * asymScale(helix, "wing", j.side);
        break;
    }
    const push = (t: number, r: number) =>
      out.push({ joint: i, offset: [j.dir[0] * L * t, j.dir[1] * L * t, j.dir[2] * L * t], r: Math.max(1e-3, r) });
    if (j.role === "head") {
      push(0, j.r0);
      push(0.5, Math.max(j.r0, L * 0.45));
      if (!hasChild.has(i)) push(1, j.r1);
      return;
    }
    const rAvg = Math.max(1e-3, (j.r0 + j.r1) / 2);
    const n = Math.max(1, Math.min(3, Math.round(L / (1.5 * rAvg))));
    for (let s = 0; s < n; s++) push(s / n, (j.r0 + (j.r1 - j.r0) * (s / n)) * k);
    // Leaf bones (feet, tail tip, horns, wing tips) also cover their end.
    if (!hasChild.has(i) || n > 1 || L > 2 * rAvg) push(1, j.r1 * k);
  });
  return out;
}

function placed(spheres: HitSphere[], sk: Skeleton): { p: P3; r: number; wing: boolean }[] {
  const rest = restPositions(sk);
  return spheres.map((s) => {
    const o = rest[s.joint] ?? [0, 0, 0];
    return { p: [o[0] + s.offset[0], o[1] + s.offset[1], o[2] + s.offset[2]], r: s.r, wing: WING_ROLES.has(sk.joints[s.joint]?.role ?? "") };
  });
}

/** XZ footprint radius around the creature origin (wings excluded: they fold away on the ground). */
export function hitRadiusXZ(spheres: HitSphere[], sk: Skeleton): number {
  let r = 0;
  for (const s of placed(spheres, sk)) if (!s.wing) r = Math.max(r, Math.hypot(s.p[0], s.p[2]) + s.r);
  return r;
}

/** Top of the hit volume above the ground (wings excluded). */
export function hitHeight(spheres: HitSphere[], sk: Skeleton): number {
  let h = 0;
  for (const s of placed(spheres, sk)) if (!s.wing) h = Math.max(h, s.p[1] + s.r);
  return h;
}
