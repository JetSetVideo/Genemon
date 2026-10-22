/**
 * Hatching (P4-R1): a button that randomly generates a newborn Genemon. Founder: "most of them are
 * pretty normal to begin with" - the genome bias is a SMALL spread around the origin so most
 * newborns express no element (primary "neutral"); elements come later from food and life. Asking for
 * an element nudges that element's signature axes. Pure and deterministic per seed.
 */
import { ELEMENT_IDS, ELEMENTS, type ElementId } from "../data/elements.ts";
import type { AxisId, AxisVector } from "../data/axes.ts";
import { createGenemon, type Genemon } from "../genome/genemon.ts";
import type { GenomeBias } from "../genome/genome.ts";

export type HatchElement = ElementId | "plain" | "any";

/** Allele spread of a newborn (randomGenome's default is 0.45: wild Genemon are far more varied). */
export const HATCH_SPREAD = 0.18;
/** Spread when the player explicitly asks for a plain newborn. */
export const HATCH_PLAIN_SPREAD = 0.14;
/** How far an asked-for element pushes each of its signature axes (scaled by the signature weight). */
export const HATCH_NUDGE = 0.35;
export const HATCH_LEVEL = 3;

export interface HatchOptions {
  seed: number;
  owner: string;
  level?: number;
  element?: HatchElement;
  bornAt?: number;
}

/** The genome bias of a hatch: zero axes (plain), or the element's signature pushed by HATCH_NUDGE. */
export function hatchBias(element: HatchElement = "plain"): GenomeBias {
  // "any" = the natural lottery (mostly plain, sometimes a lucky element); "plain" = an even tighter spread.
  if (element === "any") return { spread: HATCH_SPREAD };
  if (element === "plain" || element === "neutral") return { spread: HATCH_PLAIN_SPREAD };
  const axes: Partial<AxisVector> = {};
  for (const [axis, w] of Object.entries(ELEMENTS[element].signature) as [AxisId, number][]) {
    // Weak signature axes get a proportionally smaller push; the dominant axis gets the full nudge.
    axes[axis] = Math.sign(w) * HATCH_NUDGE * Math.min(1, Math.abs(w) / 0.4);
  }
  return { spread: HATCH_SPREAD, axes };
}

/** A newborn: level 3, one day old, mostly plain. "any" = plain genes with the usual small spread. */
export function hatchGenemon(o: HatchOptions): Genemon {
  return createGenemon({ seed: o.seed, owner: o.owner, level: o.level ?? HATCH_LEVEL, ageDays: 1, bias: hatchBias(o.element ?? "plain"), bornAt: o.bornAt });
}

/** Elements a player can ask for (the hatch select): any, plain, then every non-neutral element. */
export const HATCH_CHOICES: readonly HatchElement[] = ["any", "plain", ...ELEMENT_IDS.filter((e) => e !== "neutral")];

/** Credits for the next hatch today: the first is free, then 40, 60, 90, 135... (x1.5, rounded to 5, capped). */
export function hatchCost(hatchedToday: number): number {
  const n = Math.max(0, Math.floor(hatchedToday));
  if (n === 0) return 0;
  const c = 40 * Math.pow(1.5, n - 1);
  return Math.min(2000, Math.round(c / 5) * 5);
}

/** Per-day hatch counter stored on the profile (`hatches`). `day` is a local "YYYY-MM-DD" key. */
export interface HatchRecord {
  day: string;
  count: number;
}

export function dayKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function hatchedOn(rec: HatchRecord | undefined, day: string): number {
  return rec && rec.day === day ? Math.max(0, rec.count | 0) : 0;
}

export function recordHatch(rec: HatchRecord | undefined, day: string): HatchRecord {
  return { day, count: hatchedOn(rec, day) + 1 };
}
