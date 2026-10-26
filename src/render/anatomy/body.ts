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
 *
 * Pass 7 [P7-G1, P7-G2] (genes: helix.p7 ?? P7_DEFAULTS; P7_DEFAULTS builds the pass-6 body exactly):
 * - p7.ops run after the pass-5 ops (one angle convention, the loft frame, every lobe op mirror-paired: ops.ts);
 * - relief on every chain section (dorsal ridges, flutes, facets, segment BANDS whose count scales with the
 *   chain's length against the trunk, extra stations so the bands resolve), limbs at half strength;
 *   knobs = mirrored bosses rooted on the trunk / neck / tail; scallop = rippled ears and tail fins / spades /
 *   leaves / fans (and wing trailing edges, wings.ts);
 * - horns: pairs (extra, smaller pairs seated on the skull ellipsoid in front of the skeleton's horns),
 *   branch (antler tines, 1..3 levels), curl (a ram spiral: a helix about the horn's lateral axis whose
 *   turning radius never drops under 1.4 x the local horn radius and whose pitch clears the previous turn);
 * - spikes: rows (1 dorsal, 2 dorsolateral, 3 both), length and density, under a per-body spike budget.
 * Every count is budgeted (spikes, knobs; tines skipped on dense colossi) so bodyTriangleCap still holds.
 */
import * as THREE from "../../lib/three.ts";
import type { BodyPlan6, JointDef, Skeleton } from "../../body/skeleton.ts";
import type { Phenotype } from "../../genome/phenotype.ts";
import { type MorphHelix, type MorphOp, type MorphP5, type MorphRegion, P5_DEFAULTS } from "../../genome/morphTypes.ts";
import { type MorphP7, P7_DEFAULTS, type ReliefGenes } from "../../genome/p7Types.ts";
import type { BodyParts, JointMeshes, SkinMaterials } from "./types.ts";
import { asymScale } from "./hitbox.ts";
import { buildDigits, canon, canonJoint, DENSE_JOINTS, fractalPieces, limbPieces, type LimbPart, liteResolution, meshOf, type Quality, type Res, resolutionFor, type Slot, socketK, VERY_DENSE_JOINTS } from "./limbs.ts";
import { buildWing, feather } from "./wings.ts";
import { applyOps, applyRelief, opsFor, regionOfChain, reliefActive, sanitizeRelief } from "./ops.ts";
import {
  add3,
  bezier3,
  boneFrame,
  boneRings,
  bump,
  clamp01,
  clampExponent,
  cross3,
  curveRings,
  type Lobe,
  len3,
  loftRings,
  mergePieces,
  mul3,
  norm3,
  pair,
  type Piece,
  type Ring,
  rotate3,
  safeSection,
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
  /** Pass 6: the resolved body plan (sk.plan6), armour plates / molting shell pieces per joint (own meshes). */
  P: BodyPlan6 | null;
  shells: Piece<Slot>[][][];
  /** Pass 7 genes (P7_DEFAULTS = the pass-6 body) and the sanitised relief. */
  p7: MorphP7;
  relief: ReliefGenes;
  /** Total trunk (torso chains) length: segment bands per chain = segments x chain length / trunkLen. */
  trunkLen: number;
  /** Pass 7 budgets: spikes per row per joint, knob PAIRS per chain joint. */
  spikePerRow: number;
  knobPairs: number;
  /** Pass 7 detail level (buildBody's budget cascade). */
  detail: Detail;
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
  const { ph, A, F, helix, curv, p5, P } = ctx;
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
  // Pass 6: the globe's hidden base and the chrysalis (a ribbed, pointed shell standing on its base).
  if (P?.globe && chain === "stack") return { ...base, section: (_s, rb) => ({ rx: rb, ry: rb, exp: 2 }), caps: [1, 1] };
  if (P?.form === "cocoon" && chain === "stack") {
    const ribs: Lobe[] = [];
    for (let k = 0; k < 6; k++) ribs.push({ angle: (k * Math.PI) / 3 + 0.2, amp: 0.07, sharp: 7 });
    return { ...base, section: (s, rb) => ({ rx: rb * (1 + 0.04 * Math.sin(9 * s)), ry: rb * 0.93, exp: 2, lobes: ribs.map((l) => ({ ...l, angle: l.angle + 0.9 * s })) }), caps: [1, 1.3] };
  }
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
  if (chain.startsWith("neck")) {
    return {
      ...base,
      section: (_s, rb) => ({ rx: rb, ry: rb * 1.08, exp, lobes: [{ angle: -HALF_PI, amp: 0.06, sharp: 2 }, ...(A > 0.5 ? [{ angle: HALF_PI, amp: 0.08 * A, sharp: 10 }] : [])] }),
      caps: [0.6, 0.8],
      belly: 0.6,
      extStart: 0.9,
      extEnd: (0.6 * lastHeadR) / Math.max(1e-4, rbEnd),
    };
  }
  if (chain.startsWith("tail")) {
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
  switch (ctx.sk.kind) {
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
        // Pass 6: a larva is a segmented grub (a pinch at every segment boundary).
        pinch: P?.form === "larva" ? 0.16 : 0,
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
  const region = regionOfChain(js[0].chain);
  const ops = ctx.ops(region);
  // Pass 7 relief: never on the globe's hidden base; bands scale with this chain's length against the trunk.
  const rel = ctx.relief;
  const globeBase = !!ctx.P?.globe && js[0].chain === "stack";
  const bands = !globeBase && rel.segments > 0 && rel.segmentDepth > 0 ? Math.max(0, Math.min(16, Math.round((rel.segments * T) / ctx.trunkLen))) : 0;
  const relOn = !globeBase && reliefActive(rel, bands);
  const relK = region === "limb" ? 0.5 : 1;
  const sectionAt = (s: number): Section => {
    let pinch = 1;
    for (const b of bounds) pinch -= cfg.pinch * bump(s, b, w);
    const sec = applyOps(cfg.section(clamp01(s), rb(s) * pinch), clamp01(s), ops);
    return relOn ? applyRelief(sec, clamp01(s), rel, relK, bands) : sec;
  };
  for (let k = 0; k < n; k++) {
    const j = js[k];
    const L = lens[k];
    const first = k === 0, last = k === n - 1;
    const ovPrev = first ? 0 : rb(cum[k] / T) * (0.25 + 0.75 * F);
    const ovNext = last ? 0 : rb((cum[k] + L) / T) * (0.25 + 0.75 * F);
    const a = first ? -cfg.extStart * rS[0] : -ovPrev;
    let b = last ? L + cfg.extEnd * rE[n - 1] : L + ovNext;
    // Pass 7 robustness: a chain's FIRST segment must reach past the socket sphere its parent puts on its pivot
    // (a short neck0 / tail0 at low fusion lay wholly inside that socket and the parent: "buried").
    if (first && j.parent >= 0 && sk.joints[j.parent].chain !== j.chain) b = Math.max(b, 1.3 * socketK(j.role) * Math.max(1e-4, j.r0));
    // Pass 6: a dense colossus on the low tier lofts each (short, straight) tentacle segment with 2 stations.
    let nSt = (tent ? (res.limbStations > 5 ? 4 : res.dense && res.limbStations <= 2 ? 2 : 3) : res.stations) + (a < -0.3 * L || b > 1.3 * L ? 2 : 0);
    // Pass 7: enough stations for ~4 per segment band (capped: 3x the base stations, 2x on a dense colossus).
    if (bands > 0 && ctx.detail < 2) nSt = Math.max(nSt, Math.min((res.dense || ctx.detail === 1 ? 2 : 3) * res.stations + 1, Math.ceil((4 * bands * (b - a)) / T) + 1));
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
    if (rel.knobs > 0 && ctx.knobPairs > 0 && !globeBase && !tent) knobPieces(ctx, ids[k], frame, L, (t) => sectionAt((cum[k] + t) / T), rb((cum[k] + L / 2) / T));
    // Pass 6 [P6-E4]: armour plates (armor+) on the trunk; a molting body's shell cracks into pieces.
    const P = ctx.P;
    const trunk = js[0].chain === "spine" || js[0].chain === "body" || js[0].chain === "abdomen" || (js[0].chain === "stack" && !P?.globe && P?.form !== "cocoon");
    if (P && P.armor > 0 && trunk && P.form !== "larva") shellPieces(ctx, ids[k], frame, L, (t) => sectionAt((cum[k] + t) / T));
  }
}

/**
 * Armour plates [P6-E4] on one trunk joint (its frame): a lens-shaped carapace plate sitting ON the back (its
 * lower half buried in the trunk, its rim overhanging the flanks), thicker with every armor+. A MOLTING body's
 * plate is cracked into four pieces (split along the spine and across), each tilted outward and lifted a little:
 * every piece still roots in the trunk, and each is its OWN mesh so the viability check sees every piece.
 */
function shellPieces(ctx: Ctx, idx: number, frame: { t: V3; x: V3; y: V3 }, L0: number, secAt: (t: number) => Section): void {
  const P = ctx.P!;
  // The plate stops short of a neck or a tail rooted on this joint: its socket would swallow the plate (a
  // molting serpent's rear shell pieces vanished inside the sockets of its tail forks).
  const rooted = ctx.sk.joints.some((c) => c.parent === idx && (c.role === "neck" || c.role === "tail"));
  const L = rooted ? 0.55 * L0 : L0;
  const high = ctx.res.limbStations > 5;
  const nSt = high ? 5 : 3;
  // A serpent's thin, overlapping segments need a thicker plate to show above the neighbours' overlap.
  const thick = (1 + 0.25 * Math.min(3, Math.max(0, P.armor - 1))) * (ctx.sk.kind === "serpent" ? 1.35 : 1);
  const normal = norm3([frame.x[1] * frame.y[2] - frame.x[2] * frame.y[1], frame.x[2] * frame.y[0] - frame.x[0] * frame.y[2], frame.x[0] * frame.y[1] - frame.x[1] * frame.y[0]]);
  const piece = (t0: number, t1: number, ox: number, ang: number, wK: number, lift: number): Piece<Slot> => {
    const xa = rotate3(frame.x, normal, ang), ya = rotate3(frame.y, normal, ang);
    const rings: Ring[] = [];
    for (let m = 0; m < nSt; m++) {
      const u = m / (nSt - 1);
      const t = t0 + (t1 - t0) * u;
      const sec = secAt(Math.max(0, Math.min(L, t)));
      const [, py] = superSection(HALF_PI, sec.rx, sec.ry, sec.exp ?? 2, sec.lobes);
      const w = sec.rx * 0.95 * wK * (0.72 + 0.28 * Math.sin(Math.PI * (0.1 + 0.8 * u)));
      // Centre 0.86 of the dorsal radius, half-thickness 0.3: the top clears the back (and the overlap of a
      // fatter neighbouring segment) by ~0.15 of the radius, the bottom stays buried in the trunk.
      const c = add3(add3(mul3(frame.t, t), mul3(frame.x, ox * sec.rx)), mul3(frame.y, py * ((ctx.sk.kind === "serpent" ? 0.95 : 0.86) + lift)));
      rings.push({ rx: Math.max(1e-4, w), ry: Math.max(1e-4, py * 0.3 * thick), exp: 2.3, lobes: [{ angle: HALF_PI, amp: 0.2, sharp: 2 }], c, x: xa, y: ya });
    }
    return { geo: loftRings(rings, { radial: ctx.res.limbRadial, capRings: 1, capScale: [0.5, 0.5] }), slots: ["keratin"] };
  };
  if (!P.molting) {
    ctx.shells[idx].push([piece(-0.02 * L, 1.02 * L, 0, 0, 1, 0)]);
    return;
  }
  for (const side of [-1, 1]) {
    for (const [a, b] of [[0.02, 0.47], [0.55, 0.98]]) ctx.shells[idx].push([piece(a * L, b * L, side * 0.5, -side * 0.38, 0.5, ctx.sk.kind === "serpent" ? 0.2 : 0.1)]);
  }
}

/**
 * The second MOUTH [P6-C1] of a one-headed creature: a ventral / chest maw on the front of the host trunk
 * joint (the loft vertex furthest toward the front-low direction), a lip ring, a dark throat and a ring of
 * inward teeth, as its own mesh (the dark throat material is returned for disposal).
 */
function mawMesh(ctx: Ctx, hi: number, mats: SkinMaterials, quality: Quality): { mesh: THREE.Mesh; dark: THREE.Material } | null {
  const loft = ctx.pieces[hi][0]?.geo;
  if (!loft) return null;
  const upright = ctx.sk.kind === "biped" || ctx.sk.kind === "blob";
  const want = new THREE.Vector3(0, upright ? -0.15 : -0.8, upright ? 1 : 0.6).normalize();
  const Pos = loft.getAttribute("position"), Nor = loft.getAttribute("normal");
  const c0 = new THREE.Vector3(), v = new THREE.Vector3();
  for (let i = 0; i < Pos.count; i++) c0.add(v.fromBufferAttribute(Pos, i));
  c0.multiplyScalar(1 / Math.max(1, Pos.count));
  let best = 0, bd = -Infinity;
  for (let i = 0; i < Pos.count; i++) {
    const d = v.fromBufferAttribute(Pos, i).sub(c0).dot(want);
    if (d > bd) bd = d, best = i;
  }
  const p = new THREE.Vector3().fromBufferAttribute(Pos, best);
  const n = Nor ? new THREE.Vector3().fromBufferAttribute(Nor, best).normalize() : want.clone();
  if (!Number.isFinite(n.x) || n.lengthSq() < 0.5) n.copy(want);
  const j = ctx.sk.joints[hi];
  const mw = Math.max(1e-3, ((j.r0 + j.r1) / 2) * 0.4);
  const z = n.clone();
  const x = new THREE.Vector3(0, 1, 0).cross(z);
  if (x.lengthSq() < 1e-6) x.set(1, 0, 0);
  x.normalize();
  const y = z.clone().cross(x).normalize();
  const M = new THREE.Matrix4().makeBasis(x, y, z).setPosition(p.clone().addScaledVector(n, -0.08 * mw));
  const hiQ = quality === "high";
  const pieces: Piece<Slot | "dark">[] = [];
  const lip = new THREE.TorusGeometry(mw, mw * 0.2, hiQ ? 8 : 5, hiQ ? 20 : 12).scale(1, 0.62, 1).applyMatrix4(M);
  pieces.push({ geo: lip, slots: ["accent"] });
  const throat = new THREE.SphereGeometry(1, hiQ ? 14 : 8, hiQ ? 8 : 5).scale(mw * 0.95, mw * 0.6, mw * 0.3).translate(0, 0, -0.05 * mw).applyMatrix4(M);
  pieces.push({ geo: throat, slots: ["dark"] });
  const nT = hiQ ? 10 : 6;
  for (let k = 0; k < nT; k++) {
    const a = ((k + 0.5) / nT) * Math.PI * 2;
    const at = new THREE.Vector3(mw * 0.92 * Math.cos(a), mw * 0.62 * 0.92 * Math.sin(a), 0.04 * mw);
    const dir = at.clone().multiplyScalar(-1).normalize().add(new THREE.Vector3(0, 0, 0.5)).normalize();
    const tooth = new THREE.ConeGeometry(mw * 0.09, mw * 0.4, hiQ ? 6 : 4).translate(0, mw * 0.16, 0);
    tooth.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir)).translate(at.x, at.y, at.z).applyMatrix4(M);
    pieces.push({ geo: tooth, slots: ["keratin"] });
  }
  const m = mergePieces(pieces, ["accent", "keratin", "dark"] as const);
  for (const pc of pieces) pc.geo.dispose();
  if (!m) return null;
  const dark = new THREE.MeshStandardMaterial({ color: 0x2a0b12, roughness: 0.9 });
  const list = m.slots.map((sl) => (sl === "dark" ? dark : mats[sl]));
  m.geo.computeBoundingBox();
  m.geo.computeBoundingSphere();
  const mesh = new THREE.Mesh(m.geo, list.length === 1 ? list[0] : list);
  mesh.name = `${j.id}:maw`;
  mesh.userData = { maw: true, width: 2 * mw };
  return { mesh, dark };
}

/** Curved cones along the dorsal surface, rooted ON the loft (the section's dorsal point), leaning back. */
function spikePieces(ctx: Ctx, idx: number, frame: { t: V3; x: V3; y: V3 }, L: number, secAt: (t: number) => Section, rb: number): void {
  const { ph, A, res } = ctx;
  const sp = ctx.p7.spikes;
  const rows = Math.max(0, Math.min(3, Math.round(Number.isFinite(sp.rows) ? sp.rows : 0)));
  if (rows > 0) return spikeRows(ctx, idx, frame, L, secAt, rb, rows);
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
 * Pass-7 spike rows [P7-G2]: 1 = the dorsal row, 2 = a mirrored dorsolateral pair of rows (+-1.0 rad off the
 * dorsal axis), 3 = both; length x0.5..2 and density x0.5..2 (count per row capped by the body's spike budget).
 * Lateral rows are staggered half a step and a little shorter; every spike roots inside the guarded section.
 */
function spikeRows(ctx: Ctx, idx: number, frame: { t: V3; x: V3; y: V3 }, L: number, secAt: (t: number) => Section, rb: number, rows: number): void {
  const { ph, A, res } = ctx;
  const sp = ctx.p7.spikes;
  const fin = (v: number, lo: number, hi: number, d: number) => (Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d);
  const lenK = fin(sp.length, 0.5, 2, 1), denK = fin(sp.density, 0.5, 2, 1);
  const n = Math.max(1, Math.min(ctx.spikePerRow, Math.round(ph.plan.spikes * 3 * denK)));
  const h0 = rb * (0.45 + 0.7 * (ph.plan.spikes - 0.55)) * (1 + 0.3 * A) * lenK;
  // Flank rows at +-1.0 rad off the dorsal axis (at +-0.62 they lined up with the dorsal row from every camera).
  const LAT = 1.0;
  const angles = rows === 1 ? [HALF_PI] : rows === 2 ? [HALF_PI - LAT, HALF_PI + LAT] : [HALF_PI, HALF_PI - LAT, HALF_PI + LAT];
  const ns = res.limbStations > 5 ? 6 : 4;
  for (const th of angles) {
    const lateral = th !== HALF_PI;
    // Lateral rows 0.9x the dorsal row (0.72x read as a single row in real Chrome captures).
    const h = h0 * (lateral ? 0.9 : 1);
    const rS = rb * 0.16 * (lateral ? 0.9 : 1) * (0.85 + 0.15 * lenK);
    for (let k = 0; k < n; k++) {
      const t = lateral ? L * (0.2 + (0.6 * (k + 0.5)) / n) : n === 1 ? L * 0.5 : L * (0.2 + (0.6 * k) / (n - 1));
      const s = safeSection(secAt(t), res.radial);
      const [px, py] = superSection(th, s.rx, s.ry, s.exp ?? 2, s.lobes);
      const p = add3(add3(mul3(frame.t, t), mul3(frame.x, px + (s.offsetX ?? 0))), mul3(frame.y, py + (s.offsetY ?? 0)));
      const nrm = lateral ? norm3(add3(mul3(frame.x, px), mul3(frame.y, py))) : frame.y;
      const dirS = norm3(sub3(mul3(nrm, Math.cos(0.4)), mul3(frame.t, Math.sin(0.4))));
      const pts: V3[] = [];
      for (let i = 0; i < ns; i++) {
        pts.push(bezier3(
          sub3(p, mul3(dirS, h * 0.25 + rS * 0.5)),
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
}

/** Fractional part (deterministic low-discrepancy placement of knobs: no Math.random in geometry). */
const frac = (x: number) => x - Math.floor(x);

/**
 * Knobs [P7-G2]: mirrored bosses (warts / tubercles; bony when knobs >= 0.6) on one chain joint, rooted on the
 * GUARDED section surface (the loft's own safeSection) and sunk 85 % of their radius, from the flank up to near
 * the spine (a pair collapses to one dorsal knob near the axis). Positions are a golden-ratio sequence of the
 * joint index: deterministic per genome.
 */
function knobPieces(ctx: Ctx, idx: number, frame: { t: V3; x: V3; y: V3 }, L: number, secAt: (t: number) => Section, rb: number): void {
  const { res } = ctx;
  const kn = ctx.relief.knobs;
  const pairs = Math.min(ctx.knobPairs, Math.round(kn * 4));
  const high = res.limbStations > 5;
  const [sw, sh] = high ? [8, 6] : [6, 4];
  const slot: Slot = kn >= 0.6 ? "keratin" : "skin";
  for (let q = 0; q < pairs; q++) {
    const h1 = frac(0.6180339887 * (q + 1) + 0.4142135624 * idx);
    const h2 = frac(0.7548776662 * (q + 1) + 0.5698402910 * idx);
    const h3 = frac(0.5698402910 * (q + 1) + 0.7548776662 * idx + 0.3);
    const t = L * (0.12 + 0.76 * h1);
    const th = -0.25 + (HALF_PI + 0.25 - 0.1) * h2;
    const rk = rb * (0.06 + 0.1 * kn) * (0.75 + 0.5 * h3);
    const s = safeSection(secAt(t), res.radial);
    const one = Math.abs(th - HALF_PI) < 0.18;
    for (const a of one ? [HALF_PI] : [th, Math.PI - th]) {
      const [px, py] = superSection(a, s.rx, s.ry, s.exp ?? 2, s.lobes);
      const n = norm3(add3(mul3(frame.x, px), mul3(frame.y, py)));
      const c = add3(add3(add3(mul3(frame.t, t), mul3(frame.x, px + (s.offsetX ?? 0))), mul3(frame.y, py + (s.offsetY ?? 0))), mul3(n, 0.15 * rk));
      ctx.pieces[idx].push({ geo: sphereGeo(c, rk, sw, sh), slots: [slot] });
    }
  }
}

/** Scalloped outline factor [P7-G2]: four notches along u (1 at both ends and when scallop is 0). */
function scallopK(sc: number, u: number, notches = 4): number {
  return sc > 0 ? 1 - 0.22 * sc * (0.5 - 0.5 * Math.cos(2 * Math.PI * notches * u)) : 1;
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
  const sc = ctx.relief.scallop;
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
  // Pass 7: a scalloped fin / spade / leaf needs more stations to show its notches.
  const nS = sc > 0 && (shape === "fin" || shape === "spade" || shape === "leaf") ? (high ? 17 : 11) : high ? 9 : 5;
  switch (shape) {
    case "club":
      along(L - 0.4 * s0, L + 1.7 * s0, nS, (u) => {
        const r = r1 + (s0 * 1.05 - r1) * Math.sin(Math.PI * Math.min(1, u * 1.15)) ** 0.8;
        return { rx: r, ry: r * 0.92, exp: 2 + 0.3 * A, lobes: [...pair(0.5, 0.18, 6), ...pair(-0.6, 0.14, 6), { angle: HALF_PI, amp: 0.15, sharp: 6 }] };
      }, "accent", [0.5, 0.8]);
      break;
    case "fin":
      along(L - 2.6 * s0, L + 0.9 * s0, nS, (u) => ({ rx: s0 * 0.16 + r1 * 0.3, ry: r1 + s0 * 1.5 * Math.sin(Math.PI * (0.08 + 0.84 * u)) ** 0.7 * scallopK(sc, u), exp: 2 }), "accent", [0.5, 1.2]);
      break;
    case "spade":
      along(L - 0.5 * s0, L + 2.2 * s0, nS, (u) => ({ rx: r1 * 0.6 + s0 * 1.25 * Math.sin(Math.PI * Math.pow(u, 0.55)) ** 1.1 * scallopK(sc, u, 3), ry: r1 * 0.35 + s0 * 0.16, exp: 2.2 }), "accent", [0.5, 1.6]);
      break;
    case "leaf": {
      const pts: V3[] = [];
      for (let i = 0; i < nS; i++) {
        const u = i / (nS - 1);
        pts.push(at(L - 0.5 * s0 + 3.2 * s0 * u, 0, -0.5 * s0 * u * u));
      }
      curve(pts, (u) => ({ rx: r1 * 0.5 + s0 * 1.1 * Math.sin(Math.PI * u) ** 0.8 * scallopK(sc, u, 5), ry: r1 * 0.3 + s0 * 0.1, lobes: [{ angle: HALF_PI, amp: 0.6, sharp: 14 }] }), "accent", res.limbRadial);
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
        out.push({ geo: feather(at(L - 0.3 * s0), dir, s0 * (3.2 - 0.9 * Math.abs(a)) * (sc > 0 && k % 2 === 1 ? 1 - 0.3 * sc : 1), s0 * 0.9, res), slots: ["accent"] });
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

/**
 * Pass-7 ram curl [P7-G2]: the horn path as a helix about its lateral axis. The direction turns by up to
 * `curl` turns (concentrated toward the tip, u^1.3), but never with a turning radius under 1.4 x the local horn
 * radius (a fat short horn curls less instead of folding its own tube), and drifts outward by 2.6 x the root
 * radius per turn so a turn never cuts through the previous one.
 */
export function curlPath(P0: V3, d: V3, L: number, curl: number, rAt: (u: number) => number, r0: number, n: number): V3[] {
  let ax = cross3(d, [0, 0, -1]);
  if (len3(ax) < 0.2) ax = [-1, 0, 0];
  ax = norm3(ax);
  const outward: V3 = ax[0] < 0 ? mul3(ax, -1) : ax;
  const step = (L * (1 + 0.4 * curl)) / Math.max(1, n - 1);
  const pts: V3[] = [P0];
  let p = P0, dir = norm3(d), done = 0;
  for (let i = 1; i < n; i++) {
    const u = i / (n - 1);
    const want = curl * 2 * Math.PI * Math.pow(u, 1.3) - done;
    const dth = Math.max(0, Math.min(want, step / (1.4 * Math.max(1e-6, rAt(u)))));
    done += dth;
    dir = norm3(rotate3(dir, ax, dth));
    p = add3(add3(p, mul3(dir, step)), mul3(outward, (2.6 * r0 * dth) / (2 * Math.PI)));
    pts.push(p);
  }
  return pts;
}

/** Point at parameter u of a sampled polyline (uniform in index). */
function polyAt(pts: V3[], u: number): V3 {
  const x = clamp01(u) * (pts.length - 1);
  const i = Math.min(pts.length - 2, Math.floor(x));
  const f = x - i;
  return add3(mul3(pts[i], 1 - f), mul3(pts[i + 1], f));
}

interface HornSpec {
  origin: V3;
  d: V3;
  L: number;
  r0: number;
  /** p7 antler levels 0..3 and ram curl in turns 0..1.5. */
  branch: number;
  curl: number;
  /** The skeleton's own horn: it alone keeps the fractalDepth tines and the armFractal antlers. */
  main: boolean;
}

/** A curved, ridged, tapering horn along a bezier (canonical frame); tines at fractalDepth 3; p7 antlers / curl. */
function hornOne(ctx: Ctx, h: HornSpec): Piece<Slot>[] {
  const { helix, A, res } = ctx;
  const d = h.d;
  const L = h.L, r0 = h.r0, O = h.origin;
  const curlAmt = 0.55 - 0.4 * A;
  const curl = norm3([0.6, -0.25, -1]);
  const P0 = add3(O, mul3(d, -r0 * 0.8));
  const P1 = add3(O, mul3(d, L * 0.35));
  const P2 = add3(O, add3(mul3(d, L * 0.7), mul3(curl, L * 0.25 * curlAmt)));
  const P3 = add3(O, add3(mul3(d, L * (0.95 - 0.2 * curlAmt)), mul3(curl, L * 0.6 * curlAmt)));
  const high = res.limbStations > 5;
  const depth = Math.round(helix.fractalDepth);
  const ringsN = 4 + Math.round(3 * clamp01(helix.wings.detail + helix.surface.plates) / 2 + depth);
  const ridge = high ? 0.04 + 0.03 * Math.min(3, depth) : 0;
  const rAt = (u: number) => r0 * Math.pow(1 - u, 0.9) + r0 * 0.05;
  const ram = h.curl > 0.01;
  const samples0 = high ? Math.max(14, ringsN * 3) : 7;
  const samples = ram ? Math.max(samples0, (high ? 16 : 8) + Math.ceil(h.curl * (high ? 16 : 8))) : samples0;
  let pts: V3[] = [];
  if (ram) pts = curlPath(P0, d, L, h.curl, rAt, r0, samples);
  else for (let i = 0; i < samples; i++) pts.push(bezier3(P0, P1, P2, P3, i / (samples - 1)));
  const at = (u: number): V3 => (ram ? polyAt(pts, u) : bezier3(P0, P1, P2, P3, u));
  const tangent = (u: number): V3 => norm3(sub3(at(Math.min(1, u + 0.02)), at(Math.max(0, u - 0.02))));
  const sec = (u: number): Section => {
    const r = rAt(u) * (1 + ridge * (0.5 + 0.5 * Math.cos(2 * Math.PI * u * ringsN)));
    return { rx: r, ry: r * (1 + 0.15 * A), exp: 2 + 0.4 * A, lobes: A > 0.1 ? [{ angle: HALF_PI, amp: 0.15 * A, sharp: 6 }] : [] };
  };
  const out: Piece<Slot>[] = [{ geo: loftRings(curveRings(pts, sec, [0, 0, 1]), { radial: res.smallRadial + 2, capRings: 2, capScale: [0.6, 1.2] }), slots: ["accent"] }];
  // Pass 6: a dense colossus keeps plain horns (no tines, no fractal antlers): budget.
  if (h.main && depth >= 3 && !res.dense) {
    const tines = high ? [0.42, 0.68] : [0.55];
    tines.forEach((u, i) => {
      const base = at(u);
      const tan = tangent(u);
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
  // Pass 7 antlers: `branch` levels of alternating tines (each tine forks once per further level). Same budget rule.
  if (h.branch > 0 && !res.dense) {
    const us = h.branch >= 2 ? [0.42, 0.64, 0.84] : [0.5, 0.74];
    us.forEach((u, i) => {
      const tan = tangent(u);
      const side = i % 2 === 0 ? 1 : -1;
      // Tines stand OFF the beam (mostly perpendicular, up-forward, alternating sides) so they read as antlers.
      const w: V3 = [0, 0.55, 0.5];
      const perp = sub3(w, mul3(tan, w[0] * tan[0] + w[1] * tan[1] + w[2] * tan[2]));
      const td = norm3(rotate3(norm3(add3(mul3(tan, 0.35), len3(perp) > 1e-3 ? norm3(perp) : [0, 1, 0])), tan, side * 0.7));
      antler(out, at(u), td, L * 0.5 * (1 - 0.15 * i), rAt(u) * 0.5, h.branch, side, high, Math.max(4, res.smallRadial - 2));
    });
  }
  // armFractal on the horn: antler-like sub-branches from the upper horn (depth capped at 3).
  const af = ctx.p5.body.armFractal;
  if (h.main && af.mode !== "none" && af.depth >= 1 && !res.dense) {
    const u0 = 0.62;
    const base = at(u0);
    const tan = ram ? tangent(u0) : norm3(sub3(bezier3(P0, P1, P2, P3, u0 + 0.03), bezier3(P0, P1, P2, P3, u0 - 0.03)));
    out.push(...fractalPieces(base, norm3(add3(tan, [0, 0.4, 0])), L * 0.42, rAt(u0) * 0.8, { ...af, depth: Math.min(3, af.depth) }, res, high ? 9 : 4, "accent"));
  }
  return out;
}

/** One antler tine rooted inside its parent at `base`; forks once more per remaining level (alternating sides). */
function antler(out: Piece<Slot>[], base: V3, dir: V3, len: number, r: number, level: number, side: number, high: boolean, radial: number): void {
  if (len < 1e-5 || r < 1e-6) return;
  const ns = high ? 4 : 3;
  const P0 = sub3(base, mul3(dir, r * 0.6)), P1 = add3(base, mul3(dir, len * 0.4)), P2 = add3(base, mul3(dir, len * 0.75));
  const P3 = add3(add3(base, mul3(dir, len)), [0, len * 0.12, 0]);
  const pts: V3[] = [];
  for (let k = 0; k < ns; k++) pts.push(bezier3(P0, P1, P2, P3, k / (ns - 1)));
  out.push({ geo: loftRings(curveRings(pts, (v) => ({ rx: r * (1 - 0.85 * v) + r * 0.06, ry: r * (1 - 0.85 * v) + r * 0.06 }), [0, 0, 1]), { radial, capRings: 1, capScale: [0.5, 1] }), slots: ["accent"] });
  if (level <= 1) return;
  const u = 0.6;
  const fork = bezier3(P0, P1, P2, P3, u);
  const ax = cross3(dir, [0, 1, 0]);
  const cd = norm3(rotate3(dir, len3(ax) > 1e-3 ? ax : [1, 0, 0], side * 0.6));
  antler(out, fork, cd, len * 0.6, r * (1 - 0.85 * u) * 0.9 + r * 0.06, level - 1, -side, high, radial);
}

/**
 * The horns of one horn joint (canonical frame): the skeleton's horn plus, on the FRONT-most horn of each side,
 * `extras` smaller pairs [P7-G2] walking forward and inward along the skull. Each extra root is seated on the
 * face ellipsoid the skeleton seats its horns on (centre 0.45 L, radii r, 0.95 r, 0.62 L in the head frame) and
 * sunk a little, then expressed in this horn joint's frame (rest frames are un-rotated: offsets subtract).
 */
function hornPieces(ctx: Ctx, j: JointDef, head?: JointDef, extras = 0): Piece<Slot>[] {
  const h7 = ctx.p7.horns;
  const branch = Math.max(0, Math.min(3, Math.round(Number.isFinite(h7.branch) ? h7.branch : 0)));
  const curl = Number.isFinite(h7.curl) ? Math.max(0, Math.min(1.5, h7.curl)) : 0;
  const L = Math.max(1e-4, j.length), r0 = Math.max(1e-4, j.r0);
  const d = norm3(j.dir);
  const out = hornOne(ctx, { origin: [0, 0, 0], d, L, r0, branch: ctx.detail >= 1 ? Math.min(1, branch) : branch, curl, main: true });
  if (ctx.detail >= 1) extras = Math.min(1, extras);
  if (extras <= 0 || !head) return out;
  const headR = Math.max(1e-4, head.r0), headLen = Math.max(1e-4, head.length);
  const o = j.offset;
  for (let k = 1; k <= extras; k++) {
    const hx = Math.max(0.2 * headR, Math.min(0.8 * headR, o[0] * (1 - 0.28 * k)));
    const hz = Math.min(headLen * (0.45 + 0.62 * 0.75), o[2] + 0.22 * headLen * k);
    const ex = hx / headR, ez = (hz - headLen * 0.45) / (headLen * 0.62);
    const hy = 0.95 * headR * Math.sqrt(Math.max(0.04, 1 - ex * ex - ez * ez)) * 0.86;
    const origin: V3 = [hx - o[0], hy - o[1], hz - o[2]];
    const dk = norm3([0.25 + 0.1 * d[0], 0.95, -0.15 + 0.12 * k]);
    out.push(...hornOne(ctx, { origin, d: dk, L: L * Math.pow(0.7, k), r0: r0 * Math.pow(0.78, k), branch: Math.min(branch, 1), curl: curl * 0.5, main: false }));
  }
  return out;
}

/** A flattened ear with a concave front and an inner leaf (canonical frame). */
function earPieces(ctx: Ctx, j: JointDef): Piece<Slot>[] {
  const { A, res } = ctx;
  const d = norm3(j.dir);
  const L = Math.max(1e-4, j.length), r0 = Math.max(1e-4, j.r0), r1 = Math.max(1e-4, j.r1);
  const bend = norm3([0.2, 0, -1]);
  const sc = ctx.relief.scallop;
  const n = sc > 0 ? (res.limbStations > 5 ? 13 : 9) : res.limbStations > 5 ? 7 : 4;
  const pts: V3[] = [];
  for (let i = 0; i < n; i++) {
    const u = i / (n - 1);
    pts.push(add3(mul3(d, -r0 * 0.4 + (L + r0 * 0.4) * u), mul3(bend, L * 0.18 * u * u)));
  }
  const width = (u: number) => (r0 * (0.8 + 0.6 * Math.sin(Math.PI * u * 0.9)) * Math.pow(1 - u, 0.5) + r1) * scallopK(sc, u);
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

/**
 * Pass-6 body triangle cap: the creature total (normal 40k high / 15k low; a colossus, mythic or more than
 * DENSE_JOINTS joints, 60k / 20k) minus the head + face allowance of every head (6k / 3.5k each).
 */
export function bodyTriangleCap(sk: Skeleton, quality: Quality): number {
  const colossus = sk.plan6?.tier === "mythic" || sk.joints.length > DENSE_JOINTS;
  const heads = Math.max(1, sk.joints.filter((j) => j.role === "head").length);
  const total = quality === "high" ? (colossus ? 60000 : 40000) : (colossus ? 20000 : 15000);
  return total - heads * (quality === "high" ? 6000 : 3500);
}

export function buildBody(ph: Phenotype, sk: Skeleton, helix: MorphHelix, mats: SkinMaterials, quality: Quality): BodyParts {
  // Pass 6: a dense colossus (many joints) is meshed coarser; a pass-6 body over its cap is rebuilt one step
  // coarser (dense resolution, then the lite one).
  const dense = sk.joints.length > DENSE_JOINTS;
  const cap = bodyTriangleCap(sk, quality);
  const res0 = resolutionFor(quality, sk.joints.length);
  const first = buildBodyAt(ph, sk, helix, mats, quality, res0);
  if (first.triangles <= cap || (!sk.plan6 && !helix.p7)) return first;
  const coarse = dense ? liteResolution(quality) : resolutionFor(quality, DENSE_JOINTS + 1);
  // Pass 7: before coarsening the whole mesh, the p7 detail steps down (lite: fewer spikes / knobs / tines /
  // extra horns / band stations; then off); then the pass-6 coarser step, then lite and off (the pass-6 coarse body plus
  // the section-only relief). The first build inside the cap wins, else the lightest. Without helix.p7 this is
  // exactly the pass-6 rule (full resolution, then the coarser one). A legacy skeleton (no plan6) is never
  // coarsened (pass-6 rule) but its p7 detail still steps down, so p7 never pushes it over the cap either.
  const steps: [Res, Detail][] = !sk.plan6 ? [[res0, 1], [res0, 2]] : helix.p7 ? [[res0, 1], [res0, 2], [coarse, 0], [coarse, 1], [coarse, 2]] : [[coarse, 0]];
  let best = first;
  for (const [res, detail] of steps) {
    const next = buildBodyAt(ph, sk, helix, mats, quality, res, detail);
    if (next.triangles <= cap) {
      disposeParts(best);
      return next;
    }
    if (next.triangles < best.triangles) {
      disposeParts(best);
      best = next;
    } else disposeParts(next);
  }
  return best;
}

function disposeParts(p: BodyParts): void {
  p.perJoint.forEach((objs) => objs.forEach((o) => o.traverse((x) => (x as THREE.Mesh).isMesh && (x as THREE.Mesh).geometry.dispose())));
  for (const m of p.materials ?? []) m.dispose();
}

/** Pass-7 detail level: 0 full, 1 lite (fewer spikes / knobs / tines / extra horns, fewer band stations), 2 off. */
type Detail = 0 | 1 | 2;

/** The p7 genes a detail level keeps (level 2: no knobs, scallop, horn or spike elaboration). */
function p7AtDetail(p7: MorphP7, detail: Detail): MorphP7 {
  if (detail < 2) return p7;
  return { ...p7, relief: { ...p7.relief, knobs: 0, scallop: 0 }, horns: { pairs: 0, branch: 0, curl: 0 }, spikes: { rows: 0, length: 1, density: 1 } };
}

function buildBodyAt(ph: Phenotype, sk: Skeleton, helix0: MorphHelix, mats: SkinMaterials, quality: Quality, res: Res, detail: Detail = 0): BodyParts {
  const helix: MorphHelix = detail === 2 && helix0.p7 ? { ...helix0, p7: p7AtDetail(helix0.p7, 2) } : helix0;
  const p5 = helix.p5 ?? P5_DEFAULTS;
  const curv = Math.max(-1, Math.min(1, Number.isFinite(p5.body.curvature) ? p5.body.curvature : 0));
  const baby = clamp01(sk.dev?.baby ?? 0);
  // Pass 7: p7 ops after the pass-5 ones, budgets for the counted parts.
  const p7 = helix.p7 ?? P7_DEFAULTS;
  const allOps: MorphOp[] = [...(p5.body.ops ?? []), ...(p7.ops ?? [])];
  const high = quality === "high";
  const spikeBudget = (high ? 120 : 60) * (res.dense ? 0.5 : 1);
  const knobBudget = (high ? 96 : 64) * (res.dense ? 0.5 : 1);
  const chainJoints = sk.joints.filter((j) => CHAIN_ROLES.has(j.role) && !j.chain.startsWith("tent")).length;
  const trunkJoints = sk.joints.filter((j) => CHAIN_ROLES.has(j.role) && regionOfChain(j.chain) === "torso").length;
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
    ops: (region) => opsFor(allOps, region),
    pieces: sk.joints.map(() => []),
    P: sk.plan6 ?? null,
    shells: sk.joints.map(() => []),
    p7,
    relief: sanitizeRelief(p7.relief),
    trunkLen: Math.max(1e-3, sk.joints.reduce((a, j) => a + (CHAIN_ROLES.has(j.role) && regionOfChain(j.chain) === "torso" ? Math.max(1e-4, j.length) : 0), 0)),
    spikePerRow: Math.max(1, Math.min(detail >= 1 ? 2 : 8, Math.floor(spikeBudget / Math.max(1, trunkJoints)))),
    knobPairs: Math.max(0, Math.min(detail >= 1 ? 1 : 4, Math.floor(knobBudget / 2 / Math.max(1, chainJoints)))),
    detail,
  };
  const P = ctx.P;
  const materials: THREE.Material[] = [];
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

  // 1b. Tail tip shape on the last joint of EVERY tail (a serpent's tail is the end of its body chain).
  for (const tails of tailChains(sk)) {
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
  const limbRelief = reliefActive(ctx.relief, 0);
  // Pass 7 horn pairs: the missing pairs (p7.horns.pairs minus the skeleton's own) grow on the FRONT-most horn
  // of each side (largest head-frame z), never more than 3 pairs in total.
  const hornExtras = new Map<number, number>();
  {
    const want = Math.max(0, Math.min(3, Math.round(Number.isFinite(p7.horns.pairs) ? p7.horns.pairs : 0)));
    // Per head and side (a two-headed body gets its extra pairs on both heads).
    const groups = new Map<string, number[]>();
    J.forEach((j, i) => {
      if (j.role === "horn") groups.set(`${j.parent}:${j.side}`, [...(groups.get(`${j.parent}:${j.side}`) ?? []), i]);
    });
    for (const hs of groups.values()) {
      if (want <= hs.length) continue;
      const front = hs.reduce((a, b) => (J[b].offset[2] > J[a].offset[2] ? b : a));
      hornExtras.set(front, want - hs.length);
    }
  }
  const af = p5.body.armFractal;
  const fractalOn = af.mode !== "none" && af.depth >= 1;
  J.forEach((j, i) => {
    if (j.chain.startsWith("tent")) return;
    const jc = canonJoint(j);
    const part = j.role === "ankle" && J[j.parent]?.role === "pod" ? "podTip" : LIMB_PART[j.role];
    if (part) {
      const childIdx = J.findIndex((c) => c.parent === i && (LIMB_PART[c.role] !== undefined || c.role === "ankle"));
      const child = childIdx >= 0 ? canonJoint(J[childIdx]) : undefined;
      ctx.pieces[i].push(...limbPieces(jc, child, part, ph, helix, res, undefined, { ops: limbOps, u: LIMB_U[part], A: ctx.A, baby, style: p5.body.limbStyle, ...(limbRelief ? { relief: ctx.relief, reliefStrength: 0.5 } : {}) }));
      // armFractal: a fractal HAND replaces the fingers of a wrist; front feet get fractal claws from depth 2.
      const frontFoot = j.role === "ankle" && J[J[j.parent]?.parent ?? -1]?.role === "shoulder";
      const fractalHand = fractalOn && j.role === "wrist";
      // Pass 6: hands carry the counted fingers (up to 7; fingers+ adds); a larva's stubby legs have none.
      const handN = P && j.role === "wrist" ? (P.source === "p6" ? P.counts.fingers : Math.round(helix.digits) + P.fingerBonus) : undefined;
      // A very dense body (or a dense one on the low tier) keeps only its hands' fingers: toes go.
      const toes = j.role === "wrist" || !(J.length > VERY_DENSE_JOINTS || (J.length > DENSE_JOINTS && quality === "low"));
      if ((j.role === "ankle" || j.role === "wrist") && part === "foot" && !fractalHand && P?.form !== "larva" && toes) extra.set(i, buildDigits(j, ph, helix, mats, quality, handN, res));
      if (fractalHand || (fractalOn && frontFoot && af.depth >= 2)) {
        const d = norm3(jc.dir);
        const handUp = norm3(add3(d, [0, 0, 0.35]));
        const high = res.limbStations > 5;
        const fr = fractalPieces(mul3(d, jc.length * 0.85), handUp, Math.max(jc.length * 1.5, jc.r1 * 3.2) * (fractalHand ? 1 : 0.6), jc.r1 * (fractalHand ? 0.5 : 0.35), af, res, fractalHand ? (high ? 24 : 10) : (high ? 10 : 5), fractalHand ? "skin" : "keratin");
        const m = meshOf(fr, mats, `${j.id}:fractal`, j.side < 0);
        if (m) extra.set(i, [...(extra.get(i) ?? []), m]);
      }
    } else if (j.role === "horn") ctx.pieces[i].push(...hornPieces(ctx, jc, J[j.parent], hornExtras.get(i) ?? 0));
    else if (j.role === "ear") ctx.pieces[i].push(...earPieces(ctx, jc));
  });

  // 3b. The second mouth of a one-headed body: a maw on the chest (pass 6).
  if (P && P.counts.mouths >= 2 && J.filter((j) => j.role === "head").length < 2 && !P.globe && P.form !== "cocoon" && P.form !== "larva") {
    const host = J.findIndex((j) => j.role === "chest");
    const maw = mawMesh(ctx, host >= 0 ? host : 0, mats, quality);
    if (maw) {
      const at = host >= 0 ? host : 0;
      extra.set(at, [...(extra.get(at) ?? []), maw.mesh]);
      materials.push(maw.dark);
    }
  }

  // 4. Merge per joint; mirror side -1; asymmetric scale for horns / ears; armour / shell pieces as own meshes.
  J.forEach((j, i) => {
    const scale = j.role === "horn" ? asymScale(helix, "horn", j.side) : j.role === "ear" ? asymScale(helix, "ear", j.side) : 1;
    const m = meshOf(ctx.pieces[i], mats, `${j.id}:body`, j.side < 0, scale);
    const list: THREE.Object3D[] = [];
    if (m) list.push(m);
    ctx.shells[i].forEach((group, k) => {
      const sm = meshOf(group, mats, P?.molting ? `${j.id}:shell${k}` : `${j.id}:armor`, j.side < 0);
      if (sm) {
        sm.userData = { shell: true, molting: !!P?.molting };
        list.push(sm);
      }
    });
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
    // Pass 6: every extra pair is smaller (x0.78 per pair), wings+ grows the span; an imago gets insect panes.
    const spanK = (P?.wingSpan ?? 1) * Math.pow(0.78, j.pair ?? 0);
    const imagoKind = P?.form === "imago" && helix.wings.kind === "none";
    const wh: MorphHelix = spanK !== 1 || imagoKind
      ? { ...helix, wings: { ...helix.wings, kind: imagoKind ? "insect" : helix.wings.kind, span: (helix.wings.span > 0 ? helix.wings.span : 1.4) * spanK } }
      : helix;
    const w = buildWing(idx.map((k) => J[k]), ph, wh, mats, quality, res);
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
  return { perJoint, wings, triangles, ...(materials.length ? { materials } : {}) };
}

/** Every tail chain (root first): one per extra tail (pass 6); a serpent without tail joints ends in its body chain. */
export function tailChains(sk: Skeleton): number[][] {
  const groups = new Map<string, number[]>();
  sk.joints.forEach((j, i) => {
    if (j.role === "tail") groups.set(j.chain, [...(groups.get(j.chain) ?? []), i]);
  });
  if (groups.size > 0) return [...groups.values()];
  const t = tailJoints(sk);
  return t.length > 0 ? [t] : [];
}
