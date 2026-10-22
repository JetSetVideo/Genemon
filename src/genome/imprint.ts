/**
 * IMPRINTING [P5-G6]: objects a Genemon eats, wears or carries IMPRINT a small particularity on it (an
 * axis, a sense, its coat, glow or colour). Repeated use strengthens the imprint with diminishing
 * returns; the strongest imprints pass down to the next generation, halved each time (generation + 1).
 * Effects are small by design: an axis imprint at full strength bends the axis by IMPRINT_AXIS_MAX.
 * Pure: no DOM, no clock (callers pass `now`), randomness only through Rng(hashSeed(seed, ...)).
 */
import { clamp, r3 } from "../core/math.ts";
import { hashSeed, Rng } from "../core/rng.ts";
import type { AxisId } from "../data/axes.ts";
import { type ElementId, ELEMENTS } from "../data/elements.ts";
import { type FoodId, FOODS } from "../data/lifestyle.ts";
import { itemDef } from "../economy/items.ts";
import type { Genemon } from "./genemon.ts";
import { type Imprint, type LifeState, SENSE_IDS, type SenseId } from "./lifeTypes.ts";
import { newLifeState } from "./lifeclock.ts";

export type ImprintTrait = Imprint["trait"];
/** Axis shift of a full-strength (1.0) axis imprint. */
export const IMPRINT_AXIS_MAX = 0.06;
/** Strength gained per use of an ordinary object (strong / rare objects imprint more). */
export const IMPRINT_STEP = 0.08;
/** Inherited imprints keep this share of their strength per generation. */
export const IMPRINT_DECAY = 0.5;
/** Inherited imprints weaker than this are lost. */
export const IMPRINT_FLOOR = 0.04;
/** At most this many imprints are inherited by one child. */
export const IMPRINT_MAX_INHERITED = 3;
export const IMPRINT_MAX_HELD = 12;

/** Traits that are not axes (senses and cosmetic channels). */
const NON_AXIS: ReadonlySet<string> = new Set<string>([...SENSE_IDS, "coat", "glow", "color"]);

/** Gear and cosmetics that bend a specific trait (the rest fall back on their effect bag). */
const ITEM_TRAIT: Record<string, { trait: ImprintTrait; sign: 1 | -1 }> = {
  "gear.focusLens": { trait: "vision", sign: 1 },
  "gear.quakeBoots": { trait: "vibration", sign: 1 },
  "gear.thunderBand": { trait: "electro", sign: 1 },
  "gear.coneNozzle": { trait: "smell", sign: 1 },
  "gear.ironHide": { trait: "hardness", sign: 1 },
  "gear.swiftAnklet": { trait: "tempo", sign: 1 },
  "gear.powerBand": { trait: "might", sign: 1 },
  "gear.vitalSeed": { trait: "vitality", sign: 1 },
  "gear.shadowVeil": { trait: "luminance", sign: -1 },
  "cosmetic.scarf": { trait: "touch", sign: 1 },
  "cosmetic.silkScarf": { trait: "touch", sign: 1 },
  "cosmetic.crown": { trait: "conviction", sign: 1 },
  "cosmetic.wizardHat": { trait: "wisdom", sign: 1 },
  "cosmetic.flowerCrown": { trait: "vitality", sign: 1 },
  "cosmetic.goldPlate": { trait: "color", sign: 1 },
  "stone.prism": { trait: "color", sign: 1 },
  "stone.everstone": { trait: "structure", sign: 1 },
};
const RARITY_K: Record<string, number> = { common: 1, uncommon: 1.15, rare: 1.3, epic: 1.5, legendary: 1.75 };

/** The axis an element's signature leans on most (fire -> heat, metal -> hardness...). */
function elementAxis(el: ElementId): { trait: AxisId; sign: 1 | -1 } | null {
  const sig = Object.entries(ELEMENTS[el]?.signature ?? {}) as [AxisId, number][];
  if (sig.length === 0) return null;
  const [axis, w] = sig.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))[0];
  return { trait: axis, sign: w >= 0 ? 1 : -1 };
}

/** Which trait an item bends, its sign and its per-use step (null = the item does not imprint). */
export function imprintTraitOf(itemId: string): { trait: ImprintTrait; sign: 1 | -1; step: number } | null {
  const def = itemDef(itemId);
  if (!def) return null;
  const rk = RARITY_K[def.rarity] ?? 1;
  const fixed = ITEM_TRAIT[itemId];
  if (fixed) return { ...fixed, step: IMPRINT_STEP * rk };
  const fx = def.effects;
  if (def.kind === "food") {
    const f = FOODS[fx.food as FoodId];
    if (!f) return null;
    const top = (Object.entries(f.nudge) as [AxisId, number][]).sort((a, b) =>
      Math.abs(b[1]) - Math.abs(a[1])
    )[0];
    if (!top) return null;
    // Strong elemental foods (|nudge| >= 0.02) imprint more than staples.
    return {
      trait: top[0],
      sign: top[1] >= 0 ? 1 : -1,
      step: IMPRINT_STEP * (Math.abs(top[1]) >= 0.02 ? 1.5 : 1) * rk,
    };
  }
  if (def.kind === "cosmetic") {
    if (typeof fx.color === "number") return { trait: "color", sign: 1, step: IMPRINT_STEP * rk };
    if (fx.slot === "pattern") return { trait: "coat", sign: 1, step: IMPRINT_STEP * rk };
    if (typeof fx.glow === "number" || typeof fx.light === "number" || fx.slot === "trail") {
      return { trait: "glow", sign: 1, step: IMPRINT_STEP * rk };
    }
    return null;
  }
  if ((def.kind === "gear" || def.kind === "lure") && typeof fx.element === "string") {
    const ax = elementAxis(fx.element as ElementId);
    return ax ? { ...ax, step: IMPRINT_STEP * rk } : null;
  }
  return null;
}

/**
 * Use `itemId` on `g` at `now`: upserts the matching imprint in g.life.imprints (creating the life
 * state if missing) and returns it. Repeated use strengthens it with diminishing returns
 * (s += step x (1 - |s|)), so it never exceeds 1. Returns null when the item does not imprint.
 */
export function imprintFrom(g: Genemon, itemId: string, now: number): Imprint | null {
  const t = imprintTraitOf(itemId);
  if (!t) return null;
  const life = g.life ?? newLifeState(g, now);
  g.life = life;
  const own = life.imprints.find((im) => im.itemId === itemId && im.trait === t.trait && im.generation === 0);
  if (own) {
    const s = Math.abs(own.strength);
    own.strength = r3(t.sign * clamp(s + t.step * (1 - s), 0, 1));
    return { ...own };
  }
  const im: Imprint = { itemId, trait: t.trait, strength: r3(t.sign * t.step), since: now, generation: 0 };
  life.imprints.push(im);
  if (life.imprints.length > IMPRINT_MAX_HELD) {
    const weakest = life.imprints.reduce(
      (wi, x, i, arr) => (Math.abs(x.strength) < Math.abs(arr[wi].strength) ? i : wi),
      0,
    );
    life.imprints.splice(weakest, 1);
  }
  return { ...im };
}

/**
 * Imprints a child inherits from parents `a` and `b`: per trait the strongest parental imprint,
 * decayed by IMPRINT_DECAY (generation + 1), kept with probability 0.35 + 0.5 x |strength| (seeded),
 * at most IMPRINT_MAX_INHERITED, strongest first. Deterministic for a given seed.
 */
export function inheritImprints(a: LifeState | undefined, b: LifeState | undefined, seed: number): Imprint[] {
  const rng = new Rng(hashSeed(seed, "imprints"));
  const best = new Map<string, Imprint>();
  for (const im of [...(a?.imprints ?? []), ...(b?.imprints ?? [])]) {
    const cur = best.get(im.trait);
    if (
      !cur || Math.abs(im.strength) > Math.abs(cur.strength) ||
      (Math.abs(im.strength) === Math.abs(cur.strength) && im.itemId < cur.itemId)
    ) {
      best.set(im.trait, im);
    }
  }
  const out: Imprint[] = [];
  const ordered = [...best.values()].sort((x, y) =>
    Math.abs(y.strength) - Math.abs(x.strength) || (x.trait < y.trait ? -1 : 1)
  );
  for (const im of ordered) {
    const s = im.strength * IMPRINT_DECAY;
    const roll = rng.next(); // one draw per candidate, in a fixed order: stable streams
    if (Math.abs(s) < IMPRINT_FLOOR) continue;
    if (roll >= 0.35 + 0.5 * Math.abs(im.strength)) continue;
    out.push({
      itemId: im.itemId,
      trait: im.trait,
      strength: r3(s),
      since: im.since,
      generation: im.generation + 1,
    });
    if (out.length >= IMPRINT_MAX_INHERITED) break;
  }
  return out;
}

/** Summed axis bend of a life's imprints, each axis within +-IMPRINT_AXIS_MAX (for phenotype.express). */
export function imprintAxisShift(life: LifeState | undefined): Partial<Record<AxisId, number>> {
  const out: Partial<Record<AxisId, number>> = {};
  for (const im of life?.imprints ?? []) {
    if (NON_AXIS.has(im.trait)) continue;
    const ax = im.trait as AxisId;
    out[ax] = clamp((out[ax] ?? 0) + IMPRINT_AXIS_MAX * im.strength, -IMPRINT_AXIS_MAX, IMPRINT_AXIS_MAX);
  }
  for (const k of Object.keys(out) as AxisId[]) out[k] = r3(out[k]!);
  return out;
}

/** Cosmetic imprints (coat / glow / colour), summed and clamped to +-1, for the renderer. */
export function imprintLooks(
  life: LifeState | undefined,
): { coat: number; glow: number; color: number; senses: Partial<Record<SenseId, number>> } {
  const out = { coat: 0, glow: 0, color: 0, senses: {} as Partial<Record<SenseId, number>> };
  for (const im of life?.imprints ?? []) {
    if (im.trait === "coat" || im.trait === "glow" || im.trait === "color") {
      out[im.trait] = r3(clamp(out[im.trait] + im.strength, -1, 1));
    } else if (NON_AXIS.has(im.trait)) {
      const s = im.trait as SenseId;
      out.senses[s] = r3(clamp((out.senses[s] ?? 0) + im.strength, -1, 1));
    }
  }
  return out;
}
