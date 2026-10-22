/**
 * Body anatomy (P4-V1, P4-V3): the replacement for the ellipsoid / capsule / cone creature body. Every joint
 * gets meshes in ITS OWN local frame (origin at the joint, bone along j.dir), built as swept sections:
 *
 * - CHAINS (spine/chest, hexapod abdomen, serpent body, blob stack, neck, tail) share one profile along the
 *   whole chain (hip and shoulder widening, waist, belly bulge, keel, scapulae, a spine GROOVE lobe), so the
 *   segments at rest coincide and the body reads as ONE surface; fusion lengthens the overlap and removes
 *   the inter-segment pinch (low fusion = visibly segmented). Each segment's overlap is a hair thinner than
 *   its neighbour's own span (no coincident surfaces, no z-fighting). The ventral arc is the belly group.
 * - Angularity raises the superellipse exponent and adds sharp dorsolateral ridge lobes (outer angles);
 *   the spine groove and the waist give the inner angles.
 * - Cross-pivot joints (hip, shoulder, neck root, tail root, wing root, pods, abdomen) are hidden by a
 *   SOCKET sphere owned by the PARENT, centred on the child pivot; same-axis limb joints get a smoothstep
 *   connector plus a small socket (limbs.ts).
 * - Horns: curved tapering lofts along a cubic bezier with ridged rings; fractalDepth 3 adds tines.
 *   Spikes: small curved cones along the dorsal surface, following its normal. Ears: flattened lofts with
 *   a concave front and an inner leaf (belly material).
 * - Asymmetry (rare): helix.asymmetricParts on helix.asymmetricSide scale by (1 + a), the other side by
 *   (1 - a/2); all lateral parts are otherwise exact mirror images (built for side +1, then mirrored).
 * Head and jaw are the face lane's (face.ts); this module leaves them empty.
 *
 * Pass 5 [P5-V2, V3, V5, V6] (genes: helix.p5 ?? P5_DEFAULTS):
 * - neoteny: the skeleton's baby factor (sk.dev.baby) rounds the forms (lower angularity, softer muscles);
 * - element curvature: + curvy (exponent toward 1.85, softer lobes), - angular (higher exponent, facet ridges);
 * - morph operators (ops.ts) reshape every chain / limb section before meshing;
 * - shoulders: width and hump on the quadruped / biped chest;
 * - tail tips: taper, club, fin, fan, spade, whip, flame, leaf, rattle, split (tipSize);
 * - armFractal: branch / spiral / mandelbrot-like sub-branches on hands, front claws and horn tips (budgeted);
 * - tentacle chains (`tent<i>`) lofted as one tapering surface with a belly-coloured underside.
 */
import type * as THREE from "../../lib/three.ts";
import type { JointDef, Skeleton } from "../../body/skeleton.ts";
import type { Phenotype } from "../../genome/phenotype.ts";
import { type MorphHelix, type MorphOp, type MorphP5, type MorphRegion, P5_DEFAULTS } from "../../genome/morphTypes.ts";
import type { BodyParts, JointMeshes, SkinMaterials } from "./types.ts";
import { asymScale } from "./hitbox.ts";
import { buildDigits, canon, canonJoint, fractalPieces, limbPieces, type LimbPart, meshOf, type Quality, type Res, resolution, type Slot, socketK } from "./limbs.ts";
import { buildWing, feather } from "./wings.ts";
import { applyOps, opsFor, regionOfChain } from "./ops.ts";
import {
  add3,
  bezier3,
  boneFrame,
  boneRings,
  bump,
  clamp01,
  clampExponent,
  curveRings,
  type Lobe,
  loftRings,
  mul3,
  norm3,
  pair,
  type Piece,
  type Section,
  smoothstep,
  sphereGeo,
  type Station,
  sub3,
  superSection,
  triCount,
  type V3,
} from "./loft.ts";

const HALF_PI = Math.PI / 2;

interface Ctx {
  ph: Phenotype;
  sk: Skeleton;
  helix: MorphHelix;
  res: Res;
  F: number;
  /** Effective angularity: helix angularity bent by element curvature and rounded by neoteny. */
  A: number;
  p5: MorphP5;
  /** Element curvature -1 (angular) .. +1 (curvy). */
  curv: number;
  /** Baby proportions 1 .. 0 (sk.dev.baby; 0 on legacy skeletons). */
  baby: number;
  ops: (region: MorphRegion) => MorphOp[];
  pieces: Piece<Slot>[][];
}

/** Effective angularity [P5-V2, P5-V6]: element curvature bends it (rock / metal up, water / air down), babies are round. */
export function effectiveAngularity(angularity: number, curvature: number, baby: number): number {
  const c = Math.max(-1, Math.min(1, Number.isFinite(curvature) ? curvature : 0));
  return clamp01((clamp01(angularity) - 0.55 * c) * (1 - 0.6 * clamp01(baby)));
}

interface ChainCfg {
  section: (s: number, rb: number) => Section;
  caps: [number, number];
  belly: number;
  pinch: number;
  /** Extension (x the end radius) beyond the chain's first / last joint, bridging into the neighbour part. */
  extStart: number;
  extEnd: number;
  spikes: boolean;
  dorsal: V3;
  vertical: V3;
}

/** Shared angular extras: dorsolateral ridges (outer angles) and the spine groove (inner angle). */
function angularLobes(A: number, groove: number, curv = 0): Lobe[] {
  const out: Lobe[] = [{ angle: HALF_PI, amp: -groove * (0.4 + A), sharp: 8 }];
  if (A > 0.05) out.push(...pair(HALF_PI - 0.75, 0.07 * A, 4 + 8 * A));
  // Rock / metal: a second, ventrolateral facet ridge (the section reads as cut stone).
  if (curv < -0.3) out.push(...pair(-HALF_PI + 1.25, 0.05 * -curv, 6 + 4 * -curv));
  return out;
}

function chainCfg(ctx: Ctx, chain: string, lastHeadR: number, rbEnd: number): ChainCfg {
  const { ph, A, F, helix, curv, p5 } = ctx;
  const G = clamp01(ph.plan.girth);
  const exp = clampExponent(1.9 + 0.55 * A - 0.06 * Math.max(0, curv));
  const hump = Math.max(0, Math.min(1.2, p5.body.shoulder.hump));
  const shW = Math.max(0.7, Math.min(1.4, p5.body.shoulder.width));
  const base: ChainCfg = {
    section: (_s, rb) => ({ rx: rb, ry: rb, exp }),
    caps: [0.9, 0.9],
    belly: 0,
    pinch: 0,
    extStart: 0,
    extEnd: 0,
    spikes: false,
    dorsal: [0, 1, 0],
    vertical: [0, 0, -1],
  };
  if (chain.startsWith("tent")) {
    // Octopus arm: round, a flat sucker underside (belly material), a dorsal ridge when angular.
    return {
      ...base,
      section: (_s, rb) => ({ rx: rb, ry: rb * 0.88, exp, lobes: [{ angle: -HALF_PI, amp: -0.12, sharp: 2.5 }, ...(A > 0.3 ? [{ angle: HALF_PI, amp: 0.06 * A, sharp: 10 }] : [])] }),
      caps: [0.7, 1.3],
      belly: 0.8,
      extStart: 0.6,
    };
  }
  if (chain === "neck") {
    return {
      ...base,
      section: (_s, rb) => ({ rx: rb, ry: rb * 1.08, exp, lobes: [{ angle: -HALF_PI, amp: 0.06, sharp: 2 }, ...(A > 0.5 ? [{ angle: HALF_PI, amp: 0.08 * A, sharp: 10 }] : [])] }),
      caps: [0.6, 0.8],
      belly: 0.6,
      extStart: 0.9,
      extEnd: (0.6 * lastHeadR) / Math.max(1e-4, rbEnd),
    };
  }
  if (chain === "tail") {
    const asym = asymScale(helix, "tail", helix.asymmetricSide) - 1;
    return {
      ...base,
      section: (_s, rb) => ({
        rx: rb,
        ry: rb * 1.06,
        exp,
        lobes: [...(A > 0.05 ? [{ angle: HALF_PI, amp: 0.1 * A, sharp: 10 }] : []), ...(asym > 0 ? [{ angle: helix.asymmetricSide > 0 ? 0 : Math.PI, amp: 0.3 * asym, sharp: 3 }] : [])],
      }),
      caps: [0.6, 1.4],
      belly: 0.6,
      extStart: 0.8,
    };
  }
  switch (ph.kind) {
    case "quadruped":
      return {
        ...base,
        section: (s, rb) => ({
          rx: rb * (1 + 0.12 * bump(s, 0.12, 0.25) + (0.15 + 0.4 * (shW - 1)) * bump(s, 0.85, 0.25) - 0.07 * bump(s, 0.5, 0.3)),
          ry: rb * (1 + 0.08 * bump(s, 0.8, 0.3)),
          exp,
          lobes: [
            { angle: -HALF_PI, amp: 0.16 * (0.6 + G) * bump(s, 0.48, 0.4), sharp: 2.2 },
            ...pair(HALF_PI - 0.55, 0.09 * bump(s, 0.85, 0.2), 5),
            ...pair(HALF_PI - 0.9, 0.08 * bump(s, 0.12, 0.2), 4),
            ...angularLobes(A, 0.05, curv),
            ...(hump > 0.02 ? [{ angle: HALF_PI, amp: 0.32 * hump * bump(s, 0.82, 0.24), sharp: 2.6 }] : []),
          ],
        }),
        caps: [0.95, 0.85],
        belly: 0.75,
        spikes: true,
      };
    case "biped": {
      // The shoulder girdle meets the arm pivots instead of swallowing them: above the waist the half-width
      // eases toward 0.95 x the shoulder pivot's lateral offset (the socket sphere then caps the junction).
      const arm = ctx.sk.joints.find((j) => j.role === "shoulder" && j.chain.startsWith("arm"));
      const shX = arm ? Math.abs(arm.offset[0]) * 0.95 : 0;
      return {
        ...base,
        section: (s, rb) => ({
          rx: (() => {
            const rx = rb * (1.1 + 0.08 * bump(s, 0.08, 0.2) - 0.14 * bump(s, 0.45, 0.25));
            return shX > 0 ? rx + (shX - rx) * smoothstep(0.55, 0.95, s) : rx;
          })(),
          ry: rb * (0.82 + 0.1 * bump(s, 0.75, 0.3)),
          exp,
          lobes: [
            { angle: -HALF_PI, amp: 0.12 * (0.5 + G) * bump(s, 0.3, 0.3), sharp: 2.2 },
            ...pair(-HALF_PI + 0.6, 0.1 * bump(s, 0.8, 0.25), 4),
            ...angularLobes(A, 0.05, curv),
            ...(hump > 0.02 ? [{ angle: HALF_PI, amp: 0.3 * hump * bump(s, 0.78, 0.25), sharp: 2.6 }] : []),
          ],
        }),
        caps: [0.7, 0.65],
        belly: 0.75,
        spikes: true,
      };
    }
    case "avian":
      return {
        ...base,
        section: (s, rb) => ({
          rx: rb * (0.95 + 0.12 * bump(s, 0.6, 0.4)),
          ry: rb * (1.02 + 0.06 * bump(s, 0.7, 0.3)),
          exp,
          lobes: [{ angle: -HALF_PI, amp: (0.12 + 0.1 * A) * bump(s, 0.68, 0.35), sharp: 4 + 6 * A }, ...angularLobes(A, 0.03, curv)],
        }),
        caps: [1.1, 0.8],
        belly: 0.75,
        spikes: true,
      };
    case "hexapod":
      if (chain === "abdomen") {
        return {
          ...base,
          section: (s, rb) => {
            const k = 1 + 0.25 * bump(s, 0.35, 0.45);
            return { rx: rb * k, ry: rb * k * 0.85, exp, lobes: angularLobes(A, 0.04, curv) };
          },
          caps: [0.5, 1.25],
          pinch: 0.12 + 0.2 * (1 - F),
        };
      }
      return {
        ...base,
        section: (s, rb) => ({ rx: rb * (1 + 0.08 * bump(s, 0.5, 0.5)), ry: rb * 0.9, exp, lobes: angularLobes(A, 0.05, curv) }),
        caps: [0.7, 0.75],
        spikes: true,
      };
    case "serpent":
      return {
        ...base,
        section: (_s, rb) => ({
          rx: rb,
          ry: rb * 0.88,
          exp,
          lobes: [{ angle: -HALF_PI, amp: -0.1, sharp: 2.5 }, ...(A > 0.05 ? [{ angle: HALF_PI, amp: 0.06 * A, sharp: 10 }] : [])],
        }),
        caps: [0.9, 1.6],
        belly: 0.7,
        spikes: true,
      };
    case "blob": {
      const nPairs = 1 + Math.round(1.5 * clamp01(ph.plan.segments));
      const lobes: Lobe[] = [
        { angle: HALF_PI, amp: 0.08 + 0.06 * clamp01(ph.plan.head), sharp: 2.5 + 2 * A },
        { angle: -HALF_PI, amp: 0.1, sharp: 2.5 },
      ];
      for (let i = 0; i < nPairs; i++) {
        const frac = (clamp01(ph.plan.eyes) * 7 + i * 0.37) % 1;
        lobes.push(...pair(-HALF_PI + ((i + 0.5) / nPairs) * Math.PI * 0.95, 0.06 + 0.08 * frac, 2.5 + 2 * A));
      }
      return {
        ...base,
        section: (s, rb) => ({ rx: rb * (1 + 0.05 * bump(s, 0.3, 0.4)), ry: rb, exp, lobes }),
        caps: [0.55, 0.95],
        pinch: 0.18 * (1 - F),
      };
    }
  }
}

/** Loft one chain (consecutive joints of one chain name) with a shared profile; adds spikes when asked. */
function chainPieces(ctx: Ctx, ids: number[]): void {
  const { sk, res, F, ph } = ctx;
  const js = ids.map((i) => sk.joints[i]);
  const n = js.length;
  const lens = js.map((j) => Math.max(1e-4, j.length));
  const T = lens.reduce((a, b) => a + b, 0);
  const cum: number[] = [];
  lens.reduce((a, b, i) => ((cum[i] = a), a + b), 0);
  const rS = js.map((j, i) => (i === 0 ? j.r0 : (js[i - 1].r1 + j.r0) / 2));
  const rE = js.map((j, i) => (i === n - 1 ? j.r1 : (j.r1 + js[i + 1].r0) / 2));
  const rb = (s: number) => {
    const x = clamp01(s) * T;
    let i = 0;
    while (i < n - 1 && x > cum[i] + lens[i]) i++;
    const u = clamp01((x - cum[i]) / lens[i]);
    return Math.max(1e-4, rS[i] + (rE[i] - rS[i]) * u);
  };
  const headIdx = sk.joints.findIndex((j) => j.role === "head" && j.parent === ids[n - 1]);
  const cfg = chainCfg(ctx, js[0].chain, headIdx >= 0 ? sk.joints[headIdx].r0 : 0, rE[n - 1]);
  const tent = js[0].chain.startsWith("tent");
  const bounds = cum.slice(1).map((c) => c / T);
  const w = 0.35 * Math.min(...lens) / T;
  const ops = ctx.ops(regionOfChain(js[0].chain));
  const sectionAt = (s: number): Section => {
    let pinch = 1;
    for (const b of bounds) pinch -= cfg.pinch * bump(s, b, w);
    return applyOps(cfg.section(clamp01(s), rb(s) * pinch), clamp01(s), ops);
  };
  for (let k = 0; k < n; k++) {
    const j = js[k];
    const L = lens[k];
    const first = k === 0, last = k === n - 1;
    const ovPrev = first ? 0 : rb(cum[k] / T) * (0.25 + 0.75 * F);
    const ovNext = last ? 0 : rb((cum[k] + L) / T) * (0.25 + 0.75 * F);
    const a = first ? -cfg.extStart * rS[0] : -ovPrev;
    const b = last ? L + cfg.extEnd * rE[n - 1] : L + ovNext;
    const nSt = (tent ? (res.limbStations > 5 ? 4 : 3) : res.stations) + (a < -0.3 * L || b > 1.3 * L ? 2 : 0);
    const st: Station[] = [];
    for (let m = 0; m < nSt; m++) {
      const t = a + ((b - a) * m) / (nSt - 1);
      const sec = sectionAt((cum[k] + t) / T);
      let shrink = 1;
      if (!first && t < 0) shrink -= 0.07 * smoothstep(0, -a, -t);
      if (!last && t > L) shrink -= 0.07 * smoothstep(L, b, t);
      st.push({ ...sec, rx: sec.rx * shrink, ry: sec.ry * shrink, z: t });
    }
    const frame = boneFrame(j.dir, cfg.dorsal, cfg.vertical);
    ctx.pieces[ids[k]].push({
      geo: loftRings(boneRings([0, 0, 0], j.dir, st, frame), {
        radial: tent ? res.smallRadial + (res.limbStations > 5 ? 2 : 0) : res.radial,
        capRings: res.capRings,
        capScale: [first ? cfg.caps[0] : 0.45, last ? cfg.caps[1] : 0.45],
        belly: cfg.belly,
      }),
      slots: cfg.belly > 0 ? ["skin", "belly"] : ["skin"],
    });
    if (cfg.spikes && ph.plan.spikes > 0.55) spikePieces(ctx, ids[k], frame, L, (t) => sectionAt((cum[k] + t) / T), rb((cum[k] + L / 2) / T));
  }
}

/** Curved cones along the dorsal surface, rooted ON the loft (the section's dorsal point), leaning back. */
function spikePieces(ctx: Ctx, idx: number, frame: { t: V3; x: V3; y: V3 }, L: number, secAt: (t: number) => Section, rb: number): void {
  const { ph, A, res } = ctx;
  const n = Math.max(1, Math.round(ph.plan.spikes * 3));
  const h = rb * (0.45 + 0.7 * (ph.plan.spikes - 0.55)) * (1 + 0.3 * A);
  const rS = rb * 0.16;
  const dirS = norm3(sub3(mul3(frame.y, Math.cos(0.4)), mul3(frame.t, Math.sin(0.4))));
  for (let k = 0; k < n; k++) {
    const t = n === 1 ? L * 0.5 : L * (0.2 + (0.6 * k) / (n - 1));
    const s = secAt(t);
    const [px, py] = superSection(HALF_PI, s.rx, s.ry, s.exp ?? 2, s.lobes);
    const p = add3(add3(mul3(frame.t, t), mul3(frame.x, px + (s.offsetX ?? 0))), mul3(frame.y, py + (s.offsetY ?? 0)));
    const pts: V3[] = [];
    const ns = res.limbStations > 5 ? 6 : 4;
    for (let i = 0; i < ns; i++) {
      pts.push(bezier3(
        sub3(p, mul3(dirS, h * 0.25)),
        add3(p, mul3(dirS, h * 0.35)),
        sub3(add3(p, mul3(dirS, h * 0.7)), mul3(frame.t, h * 0.1)),
        sub3(add3(p, mul3(dirS, h * 0.95)), mul3(frame.t, h * 0.3)),
        i / (ns - 1),
      ));
    }
    const sec = (u: number): Section => {
      const r = rS * Math.pow(1 - u, 1.1) + rS * 0.03;
      return { rx: r * 0.75, ry: r };
    };
    ctx.pieces[idx].push({ geo: loftRings(curveRings(pts, sec, frame.t), { radial: res.smallRadial, capRings: 1, capScale: [0.5, 0.8] }), slots: ["accent"] });
  }
}

/**
 * Tail tip shapes [P5-V6] on the LAST tail joint (its frame: bone along dir, dorsal +Y): every piece starts
 * inside the tip of the tail loft so it is connected. Size = the tail root radius x tipSize.
 */
function tailTipPieces(ctx: Ctx, last: JointDef, rootR: number): Piece<Slot>[] {
  const { res, p5, A } = ctx;
  const shape = p5.body.tail.shape;
  if (shape === "taper") return [];
  const high = res.limbStations > 5;
  const L = Math.max(1e-4, last.length);
  const s0 = Math.max(1e-4, rootR) * 0.9 * Math.max(0.4, Math.min(2.5, p5.body.tail.tipSize));
  const f = boneFrame(last.dir, [0, 1, 0], [0, 0, -1]);
  const at = (z: number, x = 0, y = 0): V3 => add3(add3(mul3(f.t, z), mul3(f.x, x)), mul3(f.y, y));
  const r1 = Math.max(1e-4, last.r1);
  const out: Piece<Slot>[] = [];
  const along = (z0: number, z1: number, n: number, sec: (u: number) => Section, slot: Slot, caps: [number, number] = [0.6, 0.9], radial = res.limbRadial) => {
    const st: Station[] = [];
    for (let i = 0; i < n; i++) {
      const u = i / (n - 1);
      st.push({ ...sec(u), z: z0 + (z1 - z0) * u });
    }
    out.push({ geo: loftRings(boneRings([0, 0, 0], last.dir, st, f), { radial, capRings: 2, capScale: caps }), slots: [slot] });
  };
  const curve = (pts: V3[], sec: (u: number) => Section, slot: Slot, radial = res.smallRadial) =>
    out.push({ geo: loftRings(curveRings(pts, sec, f.y), { radial, capRings: 1, capScale: [0.5, 0.9] }), slots: [slot] });
  const nS = high ? 9 : 5;
  switch (shape) {
    case "club":
      along(L - 0.4 * s0, L + 1.7 * s0, nS, (u) => {
        const r = r1 + (s0 * 1.05 - r1) * Math.sin(Math.PI * Math.min(1, u * 1.15)) ** 0.8;
        return { rx: r, ry: r * 0.92, exp: 2 + 0.3 * A, lobes: [...pair(0.5, 0.18, 6), ...pair(-0.6, 0.14, 6), { angle: HALF_PI, amp: 0.15, sharp: 6 }] };
      }, "accent", [0.5, 0.8]);
      break;
    case "fin":
      along(L - 2.6 * s0, L + 0.9 * s0, nS, (u) => ({ rx: s0 * 0.16 + r1 * 0.3, ry: r1 + s0 * 1.5 * Math.sin(Math.PI * (0.08 + 0.84 * u)) ** 0.7, exp: 2 }), "accent", [0.5, 1.2]);
      break;
    case "spade":
      along(L - 0.5 * s0, L + 2.2 * s0, nS, (u) => ({ rx: r1 * 0.6 + s0 * 1.25 * Math.sin(Math.PI * Math.pow(u, 0.55)) ** 1.1, ry: r1 * 0.35 + s0 * 0.16, exp: 2.2 }), "accent", [0.5, 1.6]);
      break;
    case "leaf": {
      const pts: V3[] = [];
      for (let i = 0; i < nS; i++) {
        const u = i / (nS - 1);
        pts.push(at(L - 0.5 * s0 + 3.2 * s0 * u, 0, -0.5 * s0 * u * u));
      }
      curve(pts, (u) => ({ rx: r1 * 0.5 + s0 * 1.1 * Math.sin(Math.PI * u) ** 0.8, ry: r1 * 0.3 + s0 * 0.1, lobes: [{ angle: HALF_PI, amp: 0.6, sharp: 14 }] }), "accent", res.limbRadial);
      break;
    }
    case "whip": {
      const pts: V3[] = [];
      for (let i = 0; i < nS; i++) {
        const u = i / (nS - 1);
        pts.push(at(L - r1 + 4 * s0 * u, 0, 1.2 * s0 * u * u * u));
      }
      curve(pts, (u) => ({ rx: r1 * (1 - 0.8 * u) + 0.01 * s0, ry: r1 * (1 - 0.8 * u) + 0.01 * s0 }), "skin");
      break;
    }
    case "flame": {
      const n = high ? 5 : 3;
      for (let k = 0; k < n; k++) {
        const off = n > 1 ? k / (n - 1) - 0.5 : 0;
        const len = s0 * (2.4 - 1.2 * Math.abs(off) * 2);
        const pts: V3[] = [];
        for (let i = 0; i < (high ? 7 : 4); i++) {
          const u = i / ((high ? 7 : 4) - 1);
          pts.push(at(L - 0.4 * s0 + len * 0.5 * u, off * s0 * 1.6 * u + 0.25 * s0 * Math.sin(Math.PI * 2 * u + k) * u, len * u * 0.9));
        }
        curve(pts, (u) => {
          const r = s0 * (0.42 - 0.12 * Math.abs(off)) * Math.pow(1 - u, 0.9) * (0.7 + 0.3 * Math.sin(Math.PI * Math.min(1, u * 2.5))) + 0.01 * s0;
          return { rx: r, ry: r * 0.8 };
        }, "accent");
      }
      break;
    }
    case "fan": {
      const n = high ? 7 : 5;
      for (let k = 0; k < n; k++) {
        const a = (k / (n - 1) - 0.5) * 1.8;
        const dir = norm3(add3(mul3(f.t, Math.cos(a)), add3(mul3(f.x, Math.sin(a)), mul3(f.y, 0.25))));
        out.push({ geo: feather(at(L - 0.3 * s0), dir, s0 * (3.2 - 0.9 * Math.abs(a)), s0 * 0.9, res), slots: ["accent"] });
      }
      break;
    }
    case "rattle": {
      const n = high ? 5 : 3;
      for (let k = 0; k < n; k++) {
        const rr = s0 * 0.75 * (1 - 0.12 * k) + r1 * 0.5;
        const z = L - 0.2 * s0 + k * 0.6 * s0;
        along(z, z + 0.7 * s0, high ? 5 : 3, (u) => ({ rx: rr * (0.55 + 0.45 * Math.sin(Math.PI * u)), ry: rr * 0.8 * (0.55 + 0.45 * Math.sin(Math.PI * u)) }), "keratin", [0.4, 0.4], res.smallRadial + 2);
      }
      break;
    }
    case "split": {
      for (const sd of [-1, 1]) {
        const pts: V3[] = [];
        for (let i = 0; i < (high ? 6 : 4); i++) {
          const u = i / ((high ? 6 : 4) - 1);
          pts.push(at(L - 0.6 * r1 + 2.4 * s0 * u, sd * 1.1 * s0 * u * u, 0.3 * s0 * u));
        }
        curve(pts, (u) => ({ rx: r1 * 1.1 * (1 - 0.85 * u) + 0.02 * s0, ry: r1 * (1 - 0.85 * u) + 0.02 * s0 }), "skin");
      }
      break;
    }
  }
  return out;
}

/** A curved, ridged, tapering horn along a bezier (canonical frame); tines at fractalDepth 3. */
function hornPieces(ctx: Ctx, j: JointDef): Piece<Slot>[] {
  const { helix, A, res } = ctx;
  const d = norm3(j.dir);
  const L = Math.max(1e-4, j.length), r0 = Math.max(1e-4, j.r0);
  const curlAmt = 0.55 - 0.4 * A;
  const curl = norm3([0.6, -0.25, -1]);
  const P0 = mul3(d, -r0 * 0.8);
  const P1 = mul3(d, L * 0.35);
  const P2 = add3(mul3(d, L * 0.7), mul3(curl, L * 0.25 * curlAmt));
  const P3 = add3(mul3(d, L * (0.95 - 0.2 * curlAmt)), mul3(curl, L * 0.6 * curlAmt));
  const high = res.limbStations > 5;
  const depth = Math.round(helix.fractalDepth);
  const ringsN = 4 + Math.round(3 * clamp01(helix.wings.detail + helix.surface.plates) / 2 + depth);
  const ridge = high ? 0.04 + 0.03 * Math.min(3, depth) : 0;
  const samples = high ? Math.max(14, ringsN * 3) : 7;
  const pts: V3[] = [];
  for (let i = 0; i < samples; i++) pts.push(bezier3(P0, P1, P2, P3, i / (samples - 1)));
  const rAt = (u: number) => r0 * Math.pow(1 - u, 0.9) + r0 * 0.05;
  const sec = (u: number): Section => {
    const r = rAt(u) * (1 + ridge * (0.5 + 0.5 * Math.cos(2 * Math.PI * u * ringsN)));
    return { rx: r, ry: r * (1 + 0.15 * A), exp: 2 + 0.4 * A, lobes: A > 0.1 ? [{ angle: HALF_PI, amp: 0.15 * A, sharp: 6 }] : [] };
  };
  const out: Piece<Slot>[] = [{ geo: loftRings(curveRings(pts, sec, [0, 0, 1]), { radial: res.smallRadial + 2, capRings: 2, capScale: [0.6, 1.2] }), slots: ["accent"] }];
  if (depth >= 3) {
    const tines = high ? [0.42, 0.68] : [0.55];
    tines.forEach((u, i) => {
      const base = bezier3(P0, P1, P2, P3, u);
      const tan = norm3(sub3(bezier3(P0, P1, P2, P3, Math.min(1, u + 0.02)), bezier3(P0, P1, P2, P3, Math.max(0, u - 0.02))));
      const td = norm3(add3(tan, [0, 0.55, 0.5]));
      const Lt = L * 0.32 * (1 - 0.25 * i);
      const rT = rAt(u) * 0.55;
      const tp: V3[] = [];
      const ns = high ? 6 : 4;
      for (let k = 0; k < ns; k++) {
        tp.push(bezier3(sub3(base, mul3(td, rT * 0.5)), add3(base, mul3(td, Lt * 0.4)), add3(base, mul3(td, Lt * 0.75)), add3(add3(base, mul3(td, Lt)), [0, Lt * 0.15, 0]), k / (ns - 1)));
      }
      out.push({ geo: loftRings(curveRings(tp, (v) => ({ rx: rT * (1 - 0.9 * v) + rT * 0.05, ry: rT * (1 - 0.9 * v) + rT * 0.05 }), [0, 0, 1]), { radial: res.smallRadial, capRings: 1, capScale: [0.5, 1] }), slots: ["accent"] });
    });
  }
  // armFractal on the horn: antler-like sub-branches from the upper horn (depth capped at 3).
  const af = ctx.p5.body.armFractal;
  if (af.mode !== "none" && af.depth >= 1) {
    const u0 = 0.62;
    const base = bezier3(P0, P1, P2, P3, u0);
    const tan = norm3(sub3(bezier3(P0, P1, P2, P3, u0 + 0.03), bezier3(P0, P1, P2, P3, u0 - 0.03)));
    out.push(...fractalPieces(base, norm3(add3(tan, [0, 0.4, 0])), L * 0.42, rAt(u0) * 0.8, { ...af, depth: Math.min(3, af.depth) }, res, high ? 9 : 4, "accent"));
  }
  return out;
}

/** A flattened ear with a concave front and an inner leaf (canonical frame). */
function earPieces(ctx: Ctx, j: JointDef): Piece<Slot>[] {
  const { A, res } = ctx;
  const d = norm3(j.dir);
  const L = Math.max(1e-4, j.length), r0 = Math.max(1e-4, j.r0), r1 = Math.max(1e-4, j.r1);
  const bend = norm3([0.2, 0, -1]);
  const n = res.limbStations > 5 ? 7 : 4;
  const pts: V3[] = [];
  for (let i = 0; i < n; i++) {
    const u = i / (n - 1);
    pts.push(add3(mul3(d, -r0 * 0.4 + (L + r0 * 0.4) * u), mul3(bend, L * 0.18 * u * u)));
  }
  const width = (u: number) => r0 * (0.8 + 0.6 * Math.sin(Math.PI * u * 0.9)) * Math.pow(1 - u, 0.5) + r1;
  const outer = (u: number): Section => ({ rx: width(u), ry: width(u) * 0.32, exp: 2 + 0.3 * A, lobes: [{ angle: HALF_PI, amp: -0.45, sharp: 3 }] });
  const inner = (u: number): Section => ({ rx: width(u) * 0.7, ry: width(u) * 0.07, offsetY: width(u) * 0.14 });
  const opts = { radial: res.limbRadial, capRings: 2, capScale: [0.6, 1 + 1.5 * A] as [number, number] };
  return [
    { geo: loftRings(curveRings(pts, outer, [0, 0, 1]), opts), slots: ["skin"] },
    { geo: loftRings(curveRings(pts.slice(1, -1), inner, [0, 0, 1]), { ...opts, capScale: 0.8 }), slots: ["belly"] },
  ];
}

const LIMB_PART: Partial<Record<JointDef["role"], LimbPart>> = {
  hip: "upper",
  shoulder: "upper",
  knee: "lower",
  elbow: "lower",
  ankle: "foot",
  wrist: "foot",
  pod: "pod",
};
const CHAIN_ROLES = new Set<JointDef["role"]>(["root", "spine", "chest", "segment", "neck", "tail"]);

/** The tail chain's joints, root first; for a serpent (no tail role) the rear 40 % of its body chain. */
export function tailJoints(sk: Skeleton): number[] {
  const t = sk.joints.flatMap((j, i) => (j.role === "tail" ? [i] : []));
  if (t.length > 0 || sk.kind !== "serpent") return t;
  const body = sk.joints.flatMap((j, i) => (j.chain === "body" ? [i] : []));
  return body.slice(Math.floor(body.length * 0.6));
}

/** Station range of each limb part along the whole limb (morph ops with region "limb" use it). */
const LIMB_U: Record<LimbPart, [number, number]> = { upper: [0, 0.4], lower: [0.4, 0.8], foot: [0.8, 1], pod: [0, 0.7], podTip: [0.7, 1], wing: [0, 1] };

export function buildBody(ph: Phenotype, sk: Skeleton, helix: MorphHelix, mats: SkinMaterials, quality: Quality): BodyParts {
  const res = resolution(quality);
  const p5 = helix.p5 ?? P5_DEFAULTS;
  const curv = Math.max(-1, Math.min(1, Number.isFinite(p5.body.curvature) ? p5.body.curvature : 0));
  const baby = clamp01(sk.dev?.baby ?? 0);
  const ctx: Ctx = {
    ph,
    sk,
    helix,
    res,
    F: clamp01(helix.fusion),
    A: effectiveAngularity(helix.angularity, curv, baby),
    p5,
    curv,
    baby,
    ops: (region) => opsFor(p5.body.ops, region),
    pieces: sk.joints.map(() => []),
  };
  const J = sk.joints;
  const perJoint: JointMeshes = new Map();
  const extra = new Map<number, THREE.Object3D[]>();
  const wings: THREE.Mesh[] = [];

  // 1. Chains: consecutive runs of the same chain name among trunk / neck / tail roles; tentacles whole.
  const seen = new Set<number>();
  J.forEach((j, i) => {
    if (seen.has(i)) return;
    if (j.chain.startsWith("tent")) {
      const ids = J.flatMap((c, ci) => (c.chain === j.chain ? [ci] : []));
      ids.forEach((k) => seen.add(k));
      chainPieces(ctx, ids);
      return;
    }
    if (!CHAIN_ROLES.has(j.role)) return;
    const ids = [i];
    seen.add(i);
    let cur = i;
    for (;;) {
      const next = J.findIndex((c, ci) => c.parent === cur && c.chain === j.chain && CHAIN_ROLES.has(c.role) && !seen.has(ci));
      if (next < 0) break;
      ids.push(next);
      seen.add(next);
      cur = next;
    }
    chainPieces(ctx, ids);
  });

  // 1b. Tail tip shape on the last tail joint (a serpent's tail is the end of its body chain).
  const tails = tailJoints(sk);
  if (tails.length > 0) {
    const last = tails[tails.length - 1];
    ctx.pieces[last].push(...tailTipPieces(ctx, J[last], J[tails[0]].r0));
  }

  // 2. Sockets owned by the parent at cross-pivot children (parent frame = parent's canon).
  J.forEach((j) => {
    const p = j.parent;
    if (p < 0) return;
    const pr = J[p];
    const cross = j.role === "hip" || j.role === "shoulder" || j.role === "wingRoot" || j.role === "pod" ||
      (j.role === "neck" && pr.role !== "neck") || (j.role === "tail" && pr.role !== "tail") ||
      (j.role === "segment" && pr.chain !== j.chain);
    if (!cross) return;
    const r = socketK(j.role) * Math.max(1e-4, j.r0) * (j.role === "wingRoot" ? asymScale(helix, "wing", j.side) : 1);
    ctx.pieces[p].push({ geo: sphereGeo(canon(j.offset, pr.side), r, res.sphere[0], res.sphere[1]), slots: ["skin"] });
  });

  // 3. Limbs, horns, ears, digits (lateral parts in the side +1 canon).
  const limbOps = ctx.ops("limb");
  const af = p5.body.armFractal;
  const fractalOn = af.mode !== "none" && af.depth >= 1;
  J.forEach((j, i) => {
    if (j.chain.startsWith("tent")) return;
    const jc = canonJoint(j);
    const part = j.role === "ankle" && J[j.parent]?.role === "pod" ? "podTip" : LIMB_PART[j.role];
    if (part) {
      const childIdx = J.findIndex((c) => c.parent === i && (LIMB_PART[c.role] !== undefined || c.role === "ankle"));
      const child = childIdx >= 0 ? canonJoint(J[childIdx]) : undefined;
      ctx.pieces[i].push(...limbPieces(jc, child, part, ph, helix, res, undefined, { ops: limbOps, u: LIMB_U[part], A: ctx.A, baby, style: p5.body.limbStyle }));
      // armFractal: a fractal HAND replaces the fingers of a wrist; front feet get fractal claws from depth 2.
      const frontFoot = j.role === "ankle" && J[J[j.parent]?.parent ?? -1]?.role === "shoulder";
      const fractalHand = fractalOn && j.role === "wrist";
      if ((j.role === "ankle" || j.role === "wrist") && part === "foot" && !fractalHand) extra.set(i, buildDigits(j, ph, helix, mats, quality));
      if (fractalHand || (fractalOn && frontFoot && af.depth >= 2)) {
        const d = norm3(jc.dir);
        const handUp = norm3(add3(d, [0, 0, 0.35]));
        const high = res.limbStations > 5;
        const fr = fractalPieces(mul3(d, jc.length * 0.85), handUp, Math.max(jc.length * 1.5, jc.r1 * 3.2) * (fractalHand ? 1 : 0.6), jc.r1 * (fractalHand ? 0.5 : 0.35), af, res, fractalHand ? (high ? 24 : 10) : (high ? 10 : 5), fractalHand ? "skin" : "keratin");
        const m = meshOf(fr, mats, `${j.id}:fractal`, j.side < 0);
        if (m) extra.set(i, [...(extra.get(i) ?? []), m]);
      }
    } else if (j.role === "horn") ctx.pieces[i].push(...hornPieces(ctx, jc));
    else if (j.role === "ear") ctx.pieces[i].push(...earPieces(ctx, jc));
  });

  // 4. Merge per joint; mirror side -1; asymmetric scale for horns / ears.
  J.forEach((j, i) => {
    const scale = j.role === "horn" ? asymScale(helix, "horn", j.side) : j.role === "ear" ? asymScale(helix, "ear", j.side) : 1;
    const m = meshOf(ctx.pieces[i], mats, `${j.id}:body`, j.side < 0, scale);
    const list: THREE.Object3D[] = [];
    if (m) list.push(m);
    list.push(...(extra.get(i) ?? []));
    if (list.length) perJoint.set(i, list);
  });

  // 5. Wings: one call per side with that side's [wingRoot, wingMid, wingTip].
  J.forEach((j, i) => {
    if (j.role !== "wingRoot") return;
    const mid = J.findIndex((c) => c.parent === i && c.role === "wingMid");
    const tip = mid >= 0 ? J.findIndex((c) => c.parent === mid && c.role === "wingTip") : -1;
    if (mid < 0 || tip < 0) return;
    const idx = [i, mid, tip];
    const w = buildWing(idx.map((k) => J[k]), ph, helix, mats, quality);
    w.perJoint.forEach((objs, k) => {
      const at = idx[k];
      perJoint.set(at, [...(perJoint.get(at) ?? []), ...objs]);
    });
    wings.push(...w.surfaces);
  });

  let triangles = 0;
  perJoint.forEach((objs) =>
    objs.forEach((o) =>
      o.traverse((x) => {
        const mesh = x as THREE.Mesh;
        if (mesh.isMesh) triangles += triCount(mesh.geometry);
      })
    )
  );
  return { perJoint, wings, triangles };
}
