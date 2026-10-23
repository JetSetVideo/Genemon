/**
 * Morphogenetic OPERATORS [P5-V3]: after growth, BodyP5.ops dig, merge, squash and twist the forms. They act
 * on the loft SECTIONS (rings) at a station u along a region (torso, neck, tail, limb) BEFORE meshing, so the
 * result is still one smooth swept surface (no CSG, no seams) and every ring stays a valid lobed superellipse:
 *
 * - carve       a narrow negative lobe (a groove dug at `angle`)
 * - difference  a broad dent plus a ring shrink (a volume taken away)
 * - merge       a broad positive lobe (a neighbouring mass fused in)
 * - bulge       a rounder positive lobe plus a slight swell
 * - compress    squash the section ALONG `angle` (and widen it across); decompress is the inverse
 * - twist       rotate the section (its lobes, and the ellipse axes by projection)
 * - pinch       a waist: both radii shrink
 *
 * Each op weighs in with a cosine window around `u` of half-width `width`; `amount` is clamped to [-1, 1].
 * Guards: the cumulative radius scale stays in [SCALE_MIN, SCALE_MAX] of the input section, added lobes are
 * capped at LOBE_MAX, the exponent is clamped to the loft's [1.75, 2.45], and loftRings' safeSection keeps
 * the sharpest ring turn under 0.6 rad. The head region belongs to the face lane: the body ignores it.
 */
import type { MorphOp, MorphRegion } from "../../genome/morphTypes.ts";
import { bump, clampExponent, type Lobe, type Section } from "./loft.ts";

export const OP_LIMITS = { scaleMin: 0.55, scaleMax: 1.6, lobeMax: 0.45, minWidth: 0.06 } as const;

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

/** Apply ops to one section at station u (0 root .. 1 tip of the region). Pure: returns a new section. */
export function applyOps(sec: Section, u: number, ops: readonly MorphOp[]): Section {
  if (ops.length === 0) return sec;
  let sx = 1, sy = 1;
  let rot = 0;
  const added: Lobe[] = [];
  for (const op of ops) {
    const w = opWeight(op, u);
    if (w <= 1e-4) continue;
    const a = clampA(op.amount);
    const m = Math.abs(a) * w;
    const ang = Number.isFinite(op.angle) ? op.angle : 0;
    const c2 = Math.cos(ang) ** 2, s2 = 1 - c2;
    switch (op.kind) {
      case "carve":
        added.push({ angle: ang, amp: -0.35 * m, sharp: 6 });
        break;
      case "difference":
        added.push({ angle: ang, amp: -0.25 * m, sharp: 2.5 });
        sx *= 1 - 0.12 * m;
        sy *= 1 - 0.12 * m;
        break;
      case "merge":
        added.push({ angle: ang, amp: 0.3 * m, sharp: 2 });
        break;
      case "bulge":
        added.push({ angle: ang, amp: 0.35 * m, sharp: 3 });
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
  const lobes: Lobe[] = [
    ...(sec.lobes ?? []).map((l) => (rot !== 0 ? { ...l, angle: l.angle + rot } : l)),
    ...added.map((l) => ({ angle: l.angle + rot, amp: Math.max(-OP_LIMITS.lobeMax, Math.min(OP_LIMITS.lobeMax, l.amp)), sharp: l.sharp })),
  ];
  return { ...sec, rx, ry, exp: clampExponent(sec.exp), lobes };
}

/** Region of a body chain name (skeleton chain ids). */
export function regionOfChain(chain: string): MorphRegion {
  if (chain.startsWith("neck")) return "neck";
  if (chain.startsWith("tail")) return "tail";
  if (chain === "head") return "head";
  if (chain.startsWith("leg") || chain.startsWith("arm") || chain.startsWith("pod") || chain.startsWith("tent")) return "limb";
  return "torso";
}
