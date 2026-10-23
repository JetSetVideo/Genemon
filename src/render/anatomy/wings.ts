/**
 * Wings (P4-V3: bigger, more detailed). One side's three wing joints (wingRoot, wingMid, wingTip) become
 * bones plus SURFACES, each surface attached to the joint whose bone it follows so the animator's flap
 * (z on root and mid, folding y) folds it. The span honours the helix: tip-to-tip = helix.wings.span x body
 * height; when the skeleton's bones are shorter, the tip surface (leading finger / outer primaries / pane)
 * is extended outward from the tip bone.
 *
 * - membrane (bat / dragon): finger bones radiating from the wrist, membrane panels between them with a
 *   SCALLOPED trailing edge, root and arm panels back to the flank; veins as thin raised strips when
 *   detail > 0.5; a thumb claw at fractalDepth >= 2.
 * - feather: overlapping tapered feather lofts in rows: primaries on the tip bone, secondaries along the
 *   arm, coverts over them near the root; counts scale with detail.
 * - insect: two translucent veined panes (fore + hind) per side on the root joint.
 * - fin: a rayed, scalloped fin on the root joint.
 * Surfaces use mats.membrane (double-sided) except feathers (closed lofts, accent/skin).
 *
 * Fire [P5-V6]: a fire-primary creature (or one whose tail gene is "flame") grows flame tongues (accent
 * material) off the trailing edge of membrane panels and off the primary-feather tips.
 *
 * Built for the side +1 canon and mirrored; the rare asymmetry ("wing" part) scales the tip (hand) meshes.
 * perJoint keys are POSITIONS in the given joints array (0 root, 1 mid, 2 tip): the caller maps them.
 */
import type * as THREE from "../../lib/three.ts";
import type { JointDef } from "../../body/skeleton.ts";
import type { Phenotype } from "../../genome/phenotype.ts";
import type { MorphHelix } from "../../genome/morphTypes.ts";
import type { JointMeshes, SkinMaterials } from "./types.ts";
import { asymScale } from "./hitbox.ts";
import { canonJoint, limbPieces, meshOf, type Quality, type Res, resolution, type Slot } from "./limbs.ts";
import {
  add3,
  bezier3,
  boneFrame,
  boneRings,
  clamp01,
  cross3,
  curveRings,
  dot3,
  gridSurface,
  len3,
  lerp3,
  loftRings,
  mul3,
  norm3,
  type Piece,
  rotate3,
  type Section,
  type Station,
  sub3,
  type V3,
} from "./loft.ts";

const UP: V3 = [0, 1, 0];

/** A thin raised strip (vein, ray, finger) along sampled points. */
function strip(pts: V3[], r0: number, r1: number, res: Res, flat = 0.6): THREE.BufferGeometry {
  return loftRings(curveRings(pts, (u) => ({ rx: r0 + (r1 - r0) * u, ry: (r0 + (r1 - r0) * u) * flat }), UP), {
    radial: Math.max(4, res.smallRadial - 2),
    capRings: 1,
    capScale: 0.8,
  });
}

function sample(f: (u: number) => V3, n: number, u0 = 0, u1 = 1): V3[] {
  const out: V3[] = [];
  for (let i = 0; i < n; i++) out.push(f(u0 + ((u1 - u0) * i) / (n - 1)));
  return out;
}

/** A closed, flattened feather: rachis ridge, rounded vane, slight droop (also the tail fan, body.ts). */
export function feather(base: V3, dir: V3, len: number, width: number, res: Res): THREE.BufferGeometry {
  const n = res.limbStations > 5 ? 6 : res.dense ? 3 : 4;
  const pts = sample((u) => add3(add3(base, mul3(dir, len * u)), [0, -0.06 * len * u * u, 0]), n);
  const sec = (u: number): Section => {
    const w = width * 0.5 * (0.3 + 0.7 * Math.sin(Math.PI * (0.12 + 0.85 * u)));
    return { rx: w, ry: 0.06 * w + 0.001 * len, lobes: [{ angle: Math.PI / 2, amp: 0.8, sharp: 10 }, { angle: -Math.PI / 2, amp: 0.5, sharp: 10 }] };
  };
  return loftRings(curveRings(pts, sec, UP), { radial: res.limbStations > 5 ? 6 : 4, capRings: 1, capScale: [0.5, 1.5] });
}

/** A curved, wavy, tapering flame tongue rising from `base` along `dir` (rooted slightly inside the surface). */
function flameTongue(base: V3, dir: V3, len: number, r: number, res: Res, phase: number): THREE.BufferGeometry {
  const d = norm3(dir);
  const side = norm3(cross3(d, UP));
  const n = res.limbStations > 5 ? 6 : 4;
  const pts = sample((u) => add3(add3(add3(base, mul3(d, len * (u - 0.1))), mul3(UP, len * 0.35 * u * u)), mul3(side, len * 0.12 * Math.sin(Math.PI * 2 * u + phase) * u)), n);
  return loftRings(curveRings(pts, (u) => {
    const rr = r * Math.pow(1 - u, 0.9) * (0.75 + 0.25 * Math.sin(Math.PI * Math.min(1, u * 2.5))) + r * 0.04;
    return { rx: rr, ry: rr * 0.7 };
  }, UP), { radial: Math.max(4, res.smallRadial - 2), capRings: 1, capScale: [0.5, 0.9] });
}

export function buildWing(
  joints: JointDef[],
  ph: Phenotype,
  helix: MorphHelix,
  mats: SkinMaterials,
  quality: Quality,
  resOverride?: Res,
): { perJoint: JointMeshes; surfaces: THREE.Mesh[] } {
  const perJoint: JointMeshes = new Map();
  const surfaces: THREE.Mesh[] = [];
  if (joints.length < 3) return { perJoint, surfaces };
  const side = joints[0].side < 0 ? -1 : 1;
  const [c0, c1, c2] = joints.map(canonJoint);
  const res = resOverride ?? resolution(quality);
  const H = Math.max(0.05, ph.heightM);
  const kind = helix.wings.kind === "none" ? "membrane" : helix.wings.kind;
  const span = helix.wings.span > 0 ? helix.wings.span : 1.4;
  const detail = clamp01(helix.wings.detail);
  const Rs = (span * H) / 2;
  const d0 = norm3(c0.dir), d2 = norm3(c2.dir);
  // Pivots in the root frame (rest pose: frames un-rotated).
  const E: V3 = [...c1.offset];
  const W: V3 = add3(E, c2.offset);
  const T: V3 = add3(W, mul3(d2, c2.length));
  const rootX = Math.max(0, c0.offset[0]);
  const ext = Math.max(0, Rs - rootX - T[0]);
  const leadLen = c2.length + ext / Math.max(0.35, d2[0]);
  const bones: Piece<Slot>[][] = [[], [], []];
  const surf: Piece<Slot>[][] = [[], [], []];
  const [nu, nv] = res.grid;
  const rv = Math.max(0.003 * H, 0.006 * Rs);
  const fire = ph.elements.primary === "fire" || helix.p5?.body.tail.shape === "flame";
  // Pass 6: a dense colossus on the low tier (smallRadial 4) drops the vein strips (budget).
  const veins = detail > 0.5 && res.smallRadial > 4;

  if (kind === "membrane") {
    const F = Math.max(2, Math.min(5, Math.round(helix.wings.fingers)));
    const fanTotal = 1.0 + 0.08 * F;
    const dirs: V3[] = [], lens: number[] = [], tips: V3[] = [];
    for (let k = 0; k < F; k++) {
      dirs.push(norm3(rotate3(d2, UP, (k / (F - 1)) * fanTotal)));
      lens.push(leadLen * (1 - (0.45 * k) / (F - 1)));
      tips.push(mul3(dirs[k], lens[k]));
    }
    const sc = 0.1 + 0.2 * detail;
    const B: V3 = [-rootX * 0.2, -0.04 * H, -0.4 * Rs];
    const Fl = add3(W, tips[F - 1]);
    const C = lerp3(lerp3(B, Fl, 0.45), E, 0.12);
    const sagged = (p: V3, u: number, v: number, chord: number): V3 => [p[0], p[1] - 0.05 * chord * Math.sin(Math.PI * u) * Math.sin(Math.PI * v), p[2]];
    const panel = (lead: (u: number) => V3, Ta: V3, Tb: V3, origin: V3) => {
      const P = (u: number, v: number): V3 => {
        const L = lead(u);
        const Tl = lerp3(Ta, Tb, u);
        const Tr = add3(Tl, mul3(sub3(L, Tl), sc * Math.sin(Math.PI * u)));
        return sub3(sagged(lerp3(L, Tr, v), u, v, len3(sub3(Tr, L))), origin);
      };
      return P;
    };
    const rootP = panel((u) => mul3(E, u), B, C, [0, 0, 0]);
    const midP = panel((u) => lerp3(E, W, u), C, Fl, E);
    surf[0].push({ geo: gridSurface(rootP, nu, nv), slots: ["membrane"] });
    surf[1].push({ geo: gridSurface(midP, nu, nv), slots: ["membrane"] });
    for (let k = 0; k + 1 < F; k++) {
      const P = (u: number, v: number): V3 => {
        const e = mul3(lerp3(tips[k], tips[k + 1], u), 1 - sc * Math.sin(Math.PI * u));
        return sagged(mul3(e, v), u, v, len3(e) * 0.5);
      };
      surf[2].push({ geo: gridSurface(P, Math.max(3, Math.round(nu * 0.6)), nv), slots: ["membrane"] });
      if (veins) bones[2].push({ geo: strip(sample((v) => add3(P(0.5, v), [0, rv * 0.6, 0]), 5, 0.12, 0.95), rv, rv * 0.5, res), slots: ["skin"] });
    }
    if (fire) {
      for (let k = 0; k + 1 < F; k++) {
        const e = mul3(lerp3(tips[k], tips[k + 1], 0.5), 1 - sc);
        bones[2].push({ geo: flameTongue(e, add3(norm3(e), [0, 0, -0.6]), len3(e) * 0.32, len3(e) * 0.06, res, k), slots: ["accent"] });
      }
      const m = midP(0.55, 1);
      bones[1].push({ geo: flameTongue(m, [0.3, 0, -1], len3(sub3(W, E)) * 0.4, len3(sub3(W, E)) * 0.07, res, 2), slots: ["accent"] });
    }
    if (veins) {
      for (const u of [1 / 3, 2 / 3]) {
        bones[0].push({ geo: strip(sample((v) => add3(rootP(u, v), [0, rv * 0.6, 0]), 5, 0.05, 0.95), rv, rv * 0.5, res), slots: ["skin"] });
        bones[1].push({ geo: strip(sample((v) => add3(midP(u, v), [0, rv * 0.6, 0]), 5, 0.05, 0.95), rv, rv * 0.5, res), slots: ["skin"] });
      }
    }
    bones[0].push(...limbPieces(c0, c1, "wing", ph, helix, res));
    bones[1].push(...limbPieces(c1, c2, "wing", ph, helix, res));
    bones[2].push(...limbPieces(c2, undefined, "wing", ph, helix, res, leadLen));
    for (let k = 1; k < F; k++) {
      const st: Station[] = [];
      for (let i = 0; i < 4; i++) {
        const u = i / 3;
        const r = c2.r0 * (0.6 - 0.48 * u);
        st.push({ z: -c2.r0 * 0.3 + (lens[k] + c2.r0 * 0.3) * u, rx: r, ry: r * 0.8 });
      }
      bones[2].push({ geo: loftRings(boneRings([0, 0, 0], dirs[k], st, boneFrame(dirs[k], UP, [0, 0, 1])), { radial: res.smallRadial, capRings: 1, capScale: [0.5, 1.5] }), slots: ["skin"] });
    }
    if (helix.fractalDepth >= 2) {
      const cd = norm3([0.3, 0.15, 1]);
      const Lc = c2.r0 * 2.5 * (0.5 + clamp01(helix.clawLength));
      const cp = sample((u) => bezier3([0, 0, 0], mul3(cd, Lc * 0.5), add3(mul3(cd, Lc * 0.85), [0, -Lc * 0.1, 0]), add3(mul3(cd, Lc), [0, -Lc * 0.4, 0]), u), 5);
      bones[2].push({ geo: loftRings(curveRings(cp, (u) => ({ rx: c2.r0 * 0.4 * (1 - u) + 0.01 * c2.r0, ry: c2.r0 * 0.5 * (1 - u) + 0.01 * c2.r0 })), { radial: res.smallRadial, capRings: 1, capScale: 0.6 }), slots: ["keratin"] });
    }
  } else if (kind === "feather") {
    const LE = c0.length + c1.length;
    const chord = (g: number) => Rs * (0.42 - 0.1 * g);
    const onArm = (g: number): { j: 0 | 1; base: V3 } => {
      const s = g * LE;
      return s < c0.length ? { j: 0, base: mul3(d0, s) } : { j: 1, base: mul3(norm3(c1.dir), s - c0.length) };
    };
    const back = (a: number) => norm3(rotate3([0, 0, -1], UP, -a));
    // Pass 6: a dense colossus (several wing pairs) gets about half the feathers per row, each a bit wider.
    const thin = res.dense ? 0.45 : 1;
    const nS = Math.max(3, Math.round((5 + 7 * detail) * thin));
    for (let i = 0; i < nS; i++) {
      const g = (i + 0.5) / nS;
      const { j, base } = onArm(g);
      const r = j === 0 ? c0.r0 : c1.r0;
      surf[j].push({ geo: feather(add3(base, [0, -0.15 * r - 0.002 * i * H, 0]), back(0.08 + 0.35 * g), chord(g), (LE / nS) * 1.7, res), slots: ["accent"] });
    }
    const nC = Math.max(2, Math.round((4 + 8 * detail) * thin));
    for (let i = 0; i < nC; i++) {
      const g = (i + 0.5) / nC;
      const { j, base } = onArm(g);
      const r = j === 0 ? c0.r0 : c1.r0;
      surf[j].push({ geo: feather(add3(base, [0, 0.5 * r + 0.001 * i * H, -0.3 * r]), back(0.1 + 0.3 * g), chord(g) * 0.45, (LE / nC) * 1.6, res), slots: ["skin"] });
    }
    const nP = Math.max(3, Math.round((5 + 5 * detail) * thin));
    const lenOuter = Math.max(Rs * 0.42, leadLen - c2.length * 0.95 + Rs * 0.05);
    for (let k = 0; k < nP; k++) {
      const f = nP > 1 ? k / (nP - 1) : 0;
      const base = add3(mul3(d2, c2.length * (0.95 - 0.9 * f)), [0, -0.003 * k * H, 0]);
      const dir = norm3(rotate3(d2, UP, 0.12 + 1.15 * f));
      const fl = lenOuter + (Rs * 0.33 - lenOuter) * f;
      surf[2].push({ geo: feather(base, dir, fl, (c2.length / nP) * 1.8 + Rs * 0.04, res), slots: ["accent"] });
      if (fire && k % 2 === 0) bones[2].push({ geo: flameTongue(add3(base, mul3(dir, fl * 0.92)), dir, fl * 0.3, fl * 0.05, res, k), slots: ["accent"] });
    }
    bones[0].push(...limbPieces(c0, c1, "wing", ph, helix, res));
    bones[1].push(...limbPieces(c1, c2, "wing", ph, helix, res));
    bones[2].push(...limbPieces(c2, undefined, "wing", ph, helix, res));
  } else if (kind === "insect") {
    const Lw = Math.max(Rs - rootX, T[0] * 1.02);
    const pane = (origin: V3, dl: V3, len: number, chordMax: number) => {
      const cb = norm3(sub3([0, 0, -1], mul3(dl, dot3([0, 0, -1], dl))));
      return (u: number, v: number): V3 => {
        const cw = chordMax * Math.pow(Math.sin(Math.PI * (0.05 + 0.88 * u)), 0.65);
        return add3(add3(origin, mul3(dl, len * u)), mul3(cb, cw * (v - 0.12)));
      };
    };
    const dlF = norm3(rotate3(d0, UP, 0.05));
    const dlH = norm3(rotate3(dlF, UP, 0.5));
    const panes = [pane([0, 0, 0], dlF, Lw, 0.3 * Lw), pane([0, -0.01 * Lw, -0.06 * Lw], dlH, Lw * 0.8, 0.29 * Lw)];
    for (const P of panes) {
      surf[0].push({ geo: gridSurface(P, nu, nv), slots: ["membrane"] });
      for (const v of [0, 0.3, 0.6]) bones[0].push({ geo: strip(sample((u) => add3(P(u, v), [0, rv * 0.5, 0]), 6, 0.02, 0.95), rv * (v === 0 ? 1.4 : 1), rv * 0.5, res), slots: ["accent"] });
      if (veins) for (const u of [0.35, 0.65]) bones[0].push({ geo: strip(sample((v) => add3(P(u, v), [0, rv * 0.5, 0]), 4, 0, 0.6), rv * 0.7, rv * 0.7, res), slots: ["accent"] });
    }
    bones[0].push(...limbPieces(c0, undefined, "wing", ph, helix, res, c0.length * 0.25));
  } else {
    // fin
    const nR = Math.max(3, Math.min(7, Math.round(helix.wings.fingers) + 2));
    const Lf = Math.max(Rs - rootX, T[0]);
    const tips: V3[] = [];
    for (let k = 0; k < nR; k++) tips.push(mul3(norm3(rotate3(d0, UP, (k / (nR - 1)) * 1.2)), Lf * (1 - (0.45 * k) / (nR - 1))));
    const sc = 0.08 + 0.15 * detail;
    for (let k = 0; k + 1 < nR; k++) {
      const P = (u: number, v: number): V3 => mul3(mul3(lerp3(tips[k], tips[k + 1], u), 1 - sc * Math.sin(Math.PI * u)), v);
      surf[0].push({ geo: gridSurface(P, Math.max(3, Math.round(nu * 0.5)), nv), slots: ["membrane"] });
    }
    for (const t of tips) bones[0].push({ geo: strip(sample((u) => add3(mul3(t, u), [0, rv * 0.4, 0]), 4, 0.02, 1), rv * 1.6, rv * 0.5, res), slots: ["accent"] });
    bones[0].push(...limbPieces(c0, undefined, "wing", ph, helix, res, c0.length * 0.25));
  }

  // Rare asymmetry scales the HAND (tip joint) only: scaling the root / mid meshes about their own pivots
  // opened a gap at the elbow on the smaller side (pass-6 viability stress found floating wing tips).
  const asym = asymScale(helix, "wing", side);
  for (let i = 0; i < 3; i++) {
    const list: THREE.Object3D[] = [];
    const scale = i === 2 ? asym : 1;
    const b = meshOf(bones[i], mats, `${joints[i].id}:wing-bone`, side < 0, scale);
    if (b) list.push(b);
    const s = meshOf(surf[i], mats, `${joints[i].id}:wing-surface`, side < 0, scale);
    if (s) {
      s.castShadow = true;
      list.push(s);
      surfaces.push(s);
    }
    if (list.length) perJoint.set(i, list);
  }
  return { perJoint, surfaces };
}
