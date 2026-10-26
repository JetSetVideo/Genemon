/**
 * Morphogenetic OPERATORS [P5-V3, P7-G1]: after growth, the body ops dig, merge, squash, twist, ridge, flute,
 * facet, scallop, segment, stud and wind the forms. They act on the loft SECTIONS (rings) at a station u along
 * a region (torso, neck, tail, limb) BEFORE meshing, so the result is still one smooth swept surface (no CSG,
 * no seams) and every ring stays a valid lobed superellipse:
 *
 * pass 5
 * - carve       a narrow negative lobe (a groove dug at `angle`)
 * - difference  a broad dent plus a ring shrink (a volume taken away)
 * - merge       a broad positive lobe (a neighbouring mass fused in)
 * - bulge       a rounder positive lobe plus a slight swell
 * - compress    squash the section ALONG `angle` (and widen it across); decompress is the inverse
 * - twist       rotate the section (its lobes, and the ellipse axes by projection) - CHIRAL by nature
 * - pinch       a waist: both radii shrink
 * pass 7
 * - ridge       a sharp, narrow crest (negative amount: a sharp keel groove)
 * - flute       4..6 grooves (negative) or ribs (positive) evenly spaced around the ring, symmetric about
 *               the dorsal axis (angles PI/2 + 2 PI (k + 1/2) / N: the set is closed under x -> -x)
 * - facet       flat planes: the exponent moves toward EXP_MAX (positive) or EXP_MIN (negative, diamond) and
 *               six low, broad, alternating lobes cut a hexagonal outline
 * - scallop     a radius ripple ALONG u: three crests across the op window
 * - segment     annular bands along u: 2..6 periodic constrictions (negative) or raised rings (positive)
 * - knob        a small, sharp, local boss (its window along u is 0.4 x the op width)
 * - spiral      a crest whose angle winds with u across the window; built as a MIRROR PAIR of crests winding
 *               in opposite senses (a braid), so it keeps the bilateral symmetry. Twist stays the only chiral op.
 *
 * ANGLE CONVENTION (pass 7 finding): `MorphOp.angle` is read in the LOFT section frame of loft.ts (0 = +x
 * lateral, PI/2 = dorsal, -PI/2 = ventral). That is what pass-5 applyOps always did, what the pass-5 tests
 * assume (tests/morph_p5_test.ts carves the back with angle PI/2) and what the pass-7 producer (helix7.ts)
 * emits. Only the PASS-5 producer (helix.ts p5Of) emits 0 / PI meaning "dorsal / ventral" (the morphTypes.ts
 * comment "0 = dorsal"): in pass 6 its carve / merge / bulge / difference landed on ONE flank (+x or -x) of
 * the unmirrored torso / neck / tail - an asymmetric body. Fix here: every lobe op whose angle is off the
 * dorsal axis is emitted as a MIRROR PAIR (angle, PI - angle) (`sym`), so no input angle can break the mirror
 * (a pass-5 angle-0 / PI op now marks both flanks). The producer-side fix (emit PI/2 / -PI/2 so the intended
 * dorsal / ventral placement is realised) is a genome-lane line: see artifacts/p7/handoff-geometry.md.
 *
 * Each op weighs in with a cosine window around `u` of half-width `width`; `amount` is clamped to [-1, 1].
 * Guards: the cumulative radius scale stays in [SCALE_MIN, SCALE_MAX] of the input section, each added lobe is
 * capped at LOBE_MAX and at most MAX_LOBES op lobes are kept (strongest first, mirror pairs kept whole), the
 * exponent is clamped to the loft's [1.75, 2.45], and loftRings' safeSection keeps the sharpest ring turn
 * under 0.6 rad. The head region belongs to the face lane: the body ignores it.
 *
 * RELIEF [P7-G2] (`applyRelief`): the pass-7 surface relief genes on a whole chain: dorsal ridges, flutes,
 * segment bands and facets (knobs and scallops are separate pieces built by body.ts / wings.ts).
 */
import type { MorphOp, MorphRegion } from "../../genome/morphTypes.ts";
import type { ReliefGenes } from "../../genome/p7Types.ts";
import { bump, clamp01, clampExponent, EXP_MAX, EXP_MIN, type Lobe, type Section } from "./loft.ts";

export const OP_LIMITS = { scaleMin: 0.55, scaleMax: 1.6, lobeMax: 0.45, minWidth: 0.06, maxLobes: 32 } as const;

const HALF_PI = Math.PI / 2;
const clampA = (x: number) => (Number.isFinite(x) ? Math.max(-1, Math.min(1, x)) : 0);

/** The ops that act on `region` (its own plus the "all" ones), in order. */
export function opsFor(ops: readonly MorphOp[] | undefined, region: MorphRegion): MorphOp[] {
  if (!ops || ops.length === 0) return [];
  return ops.filter((o) => o.region === region || (o.region === "all" && region !== "head"));
}

/** Weight 0..1 of an op at station u (cosine window). */
export function opWeight(op: MorphOp, u: number): number {
  const c = Number.isFinite(op.u) ? Math.max(0, Math.min(1, op.u)) : 0.5;
  const w = Math.max(OP_LIMITS.minWidth, Math.min(1, Number.isFinite(op.width) ? op.width : 0.2));
  return bump(u, c, w);
}

/** One lobe on the dorsal / ventral axis, or a mirror pair (angle, PI - angle) when off it. */
export function sym(angle: number, amp: number, sharp: number): Lobe[] {
  return Math.abs(Math.cos(angle)) < 1e-6 ? [{ angle, amp, sharp }] : [{ angle, amp, sharp }, { angle: Math.PI - angle, amp, sharp }];
}

/** Signed position of u inside an op window: -1 .. 1 (0 at the centre). */
function windowPhase(op: MorphOp, u: number): number {
  const c = Number.isFinite(op.u) ? Math.max(0, Math.min(1, op.u)) : 0.5;
  const w = Math.max(OP_LIMITS.minWidth, Math.min(1, Number.isFinite(op.width) ? op.width : 0.2));
  return Math.max(-1, Math.min(1, (u - c) / w));
}

/** Apply ops to one section at station u (0 root .. 1 tip of the region). Pure: returns a new section. */
export function applyOps(sec: Section, u: number, ops: readonly MorphOp[]): Section {
  if (ops.length === 0) return sec;
  let sx = 1, sy = 1;
  let rot = 0;
  let exp = sec.exp;
  const units: Lobe[][] = [];
  const add = (l: Lobe[]) => units.push(l);
  for (const op of ops) {
    let w = opWeight(op, u);
    if (op.kind === "knob") {
      const c = Number.isFinite(op.u) ? Math.max(0, Math.min(1, op.u)) : 0.5;
      const wd = Math.max(OP_LIMITS.minWidth, Math.min(1, Number.isFinite(op.width) ? op.width : 0.2));
      w = bump(u, c, Math.max(OP_LIMITS.minWidth, 0.4 * wd));
    }
    if (w <= 1e-4) continue;
    const a = clampA(op.amount);
    const m = Math.abs(a) * w;
    const ang = Number.isFinite(op.angle) ? op.angle : 0;
    const c2 = Math.cos(ang) ** 2, s2 = 1 - c2;
    switch (op.kind) {
      case "carve":
        add(sym(ang, -0.35 * m, 6));
        break;
      case "difference":
        add(sym(ang, -0.25 * m, 2.5));
        sx *= 1 - 0.12 * m;
        sy *= 1 - 0.12 * m;
        break;
      case "merge":
        add(sym(ang, 0.3 * m, 2));
        break;
      case "bulge":
        add(sym(ang, 0.35 * m, 3));
        sx *= 1 + 0.08 * m;
        sy *= 1 + 0.08 * m;
        break;
      case "compress":
      case "decompress": {
        // Signed: compress with a negative amount decompresses (and vice versa).
        const k = (op.kind === "compress" ? -1 : 1) * a * w;
        const along = 1 + 0.35 * k, across = 1 - 0.12 * k;
        sx *= c2 * along + s2 * across;
        sy *= s2 * along + c2 * across;
        break;
      }
      case "twist":
        rot += a * w * (Math.PI / 3);
        break;
      case "pinch":
        sx *= 1 - 0.3 * m;
        sy *= 1 - 0.3 * m;
        break;
      // ---------------------------------------------------------------- pass 7
      case "ridge":
        add(sym(ang, 0.3 * a * w, 14));
        break;
      case "flute": {
        const n = 4 + Math.round(2 * Math.abs(a));
        const l: Lobe[] = [];
        for (let k = 0; k < n; k++) l.push({ angle: HALF_PI + (2 * Math.PI * (k + 0.5)) / n, amp: 0.18 * a * w, sharp: 9 });
        add(l);
        break;
      }
      case "facet": {
        const e0 = clampExponent(exp);
        exp = e0 + ((a >= 0 ? EXP_MAX : EXP_MIN) - e0) * Math.min(1, 1.2 * m);
        const l: Lobe[] = [];
        for (let k = 0; k < 6; k++) l.push({ angle: HALF_PI + (k * Math.PI) / 3, amp: (k % 2 === 0 ? 1 : -1) * 0.06 * m, sharp: 2 });
        add(l);
        break;
      }
      case "scallop": {
        const k = 1 + 0.16 * a * w * Math.cos(3 * Math.PI * windowPhase(op, u));
        sx *= k;
        sy *= k;
        break;
      }
      case "segment": {
        const bands = 2 + Math.round(4 * Math.abs(a));
        const c = Math.pow(0.5 + 0.5 * Math.cos(Math.PI * bands * windowPhase(op, u)), 3);
        const k = 1 + 0.32 * a * w * c;
        sx *= k;
        sy *= k;
        break;
      }
      case "knob":
        add(sym(ang, 0.4 * a * w, 18));
        break;
      case "spiral": {
        const phi = (a >= 0 ? 1 : -1) * Math.PI * windowPhase(op, u);
        const amp = 0.22 * m * (0.5 + 0.5 * Math.abs(Math.sin(phi)));
        const t1 = ang + phi;
        add([{ angle: t1, amp, sharp: 10 }, { angle: Math.PI - t1, amp, sharp: 10 }]);
        break;
      }
    }
  }
  const lim = (k: number) => Math.max(OP_LIMITS.scaleMin, Math.min(OP_LIMITS.scaleMax, k));
  let rx = sec.rx * lim(sx), ry = sec.ry * lim(sy);
  if (rot !== 0) {
    // A rotated ellipse projected back on the section axes (the loft section has no rotation of its own).
    const mean = (rx + ry) / 2, half = ((rx - ry) / 2) * Math.cos(2 * rot);
    rx = mean + half;
    ry = mean - half;
  }
  // Lobe cap: keep the strongest units (a mirror pair or a flute ring stays whole) up to MAX_LOBES lobes.
  let kept = units;
  if (units.reduce((n, l) => n + l.length, 0) > OP_LIMITS.maxLobes) {
    const order = units.map((l, i) => ({ i, s: Math.max(...l.map((x) => Math.abs(x.amp))) })).sort((p, q) => q.s - p.s || p.i - q.i);
    const keep = new Set<number>();
    let n = 0;
    for (const o of order) {
      if (n + units[o.i].length > OP_LIMITS.maxLobes) continue;
      keep.add(o.i);
      n += units[o.i].length;
    }
    kept = units.filter((_, i) => keep.has(i));
  }
  const added = kept.flat();
  const lobes: Lobe[] = [
    ...(sec.lobes ?? []).map((l) => (rot !== 0 ? { ...l, angle: l.angle + rot } : l)),
    ...added.map((l) => ({ angle: l.angle + rot, amp: Math.max(-OP_LIMITS.lobeMax, Math.min(OP_LIMITS.lobeMax, l.amp)), sharp: l.sharp })),
  ];
  return { ...sec, rx, ry, exp: clampExponent(exp), lobes };
}

/** Region of a body chain name (skeleton chain ids). */
export function regionOfChain(chain: string): MorphRegion {
  if (chain.startsWith("neck")) return "neck";
  if (chain.startsWith("tail")) return "tail";
  if (chain === "head") return "head";
  if (chain.startsWith("leg") || chain.startsWith("arm") || chain.startsWith("pod") || chain.startsWith("tent")) return "limb";
  return "torso";
}

// ------------------------------------------------------------------ relief [P7-G2]

/** Relief genes made safe: integer counts in their declared ranges, every share in 0..1, non-finite -> 0. */
export function sanitizeRelief(r: ReliefGenes | undefined): ReliefGenes {
  const i = (v: number | undefined, hi: number) => (Number.isFinite(v) ? Math.max(0, Math.min(hi, Math.round(v as number))) : 0);
  const f = (v: number | undefined) => (Number.isFinite(v) ? clamp01(v as number) : 0);
  return {
    ridges: i(r?.ridges, 5),
    flutes: i(r?.flutes, 8),
    segments: i(r?.segments, 12),
    segmentDepth: f(r?.segmentDepth),
    knobs: f(r?.knobs),
    facets: f(r?.facets),
    scallop: f(r?.scallop),
  };
}

/** Does the relief change a chain SECTION (ridges, flutes, facets, segment bands)? */
export function reliefActive(r: ReliefGenes, bands = r.segments): boolean {
  return r.ridges > 0 || r.flutes > 0 || r.facets > 0 || (bands > 0 && r.segmentDepth > 0);
}

/** Constriction profile 0..1 of `bands` annular bands at chain station s (peaks at interior s = i / bands). */
export function bandProfile(s: number, bands: number): number {
  if (bands <= 0) return 0;
  const edge = 0.5 / bands;
  const fade = Math.min(1, clamp01(s / edge), clamp01((1 - s) / edge));
  return fade * Math.pow(0.5 + 0.5 * Math.cos(2 * Math.PI * bands * s), 3);
}

/**
 * The relief on one chain section at station s (0 root .. 1 tip of the chain), `strength` 1 on the trunk / neck
 * / tail, 0.5 on limbs. `bands` = the number of segment bands on THIS chain (body.ts scales the gene by length).
 * - ridges: N sharp crests (amplitude 0.16) on the back, spread 0.34 rad apart symmetric about the dorsal axis;
 * - flutes: N grooves at PI/2 + 2 PI (k + 1/2) / N (closed under the mirror);
 * - segments: annular constrictions of depth 0.22 x segmentDepth between the bands;
 * - facets: exponent toward EXP_MAX and six alternating broad lobes (planes).
 * Identity (the very same object) when nothing is active.
 */
export function applyRelief(sec: Section, s: number, r: ReliefGenes, strength = 1, bands = r.segments): Section {
  if (!reliefActive(r, bands) || !(strength > 0)) return sec;
  const k = Math.min(1, strength);
  const lobes: Lobe[] = [];
  // Amplitude 0.16 (was 0.08 in the lane build: 5 ridges displaced the back by only 3.5 % of height, unseen in Chrome).
  for (let j = 0; j < r.ridges; j++) lobes.push({ angle: HALF_PI + (j - (r.ridges - 1) / 2) * 0.34, amp: 0.16 * k, sharp: 16 });
  for (let j = 0; j < r.flutes; j++) lobes.push({ angle: HALF_PI + (2 * Math.PI * (j + 0.5)) / r.flutes, amp: -0.08 * k, sharp: 9 });
  let exp = sec.exp;
  if (r.facets > 0) {
    const e0 = clampExponent(exp);
    exp = e0 + (EXP_MAX - e0) * 0.8 * r.facets * k;
    for (let j = 0; j < 6; j++) lobes.push({ angle: HALF_PI + (j * Math.PI) / 3, amp: (j % 2 === 0 ? 1 : -1) * 0.05 * r.facets * k, sharp: 2 });
  }
  const f = bands > 0 && r.segmentDepth > 0 ? 1 - 0.22 * r.segmentDepth * k * bandProfile(clamp01(s), bands) : 1;
  return { ...sec, rx: sec.rx * f, ry: sec.ry * f, exp: clampExponent(exp), lobes: [...(sec.lobes ?? []), ...lobes] };
}
