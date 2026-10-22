/**
 * Cyclic item ROTATION and world INVESTMENT returns (pass 4, P4-E1). PURE: no DOM, no clock; the
 * caller passes `dayIndex` (whole days since an epoch it chooses, e.g. floor(now / 86 400 000)) and
 * every draw comes from Rng(hashSeed(...)).
 *
 * - rotationFor(day): a 7-day ELEMENT theme cycle (one element per weekday; its foods and gear are
 *   "in season" and drop 3x more often, see loot.ts) and a 28-day RARE cycle (one rare item on the
 *   last day of each week, four different ones per 28 days).
 * - investmentReturn: credits invested in a world place (supermarket, gym, park, lab, shrine) come
 *   back as that place's special items over the following days, with diminishing returns in both
 *   the amount invested (value ~ invested^0.85) and the time waited (1 - e^(-days/7)).
 */
import { hashSeed, Rng } from "../core/rng.ts";
import type { ElementId } from "../data/elements.ts";
import type { FoodId } from "../data/lifestyle.ts";
import { foodItemId, ITEMS } from "./items.ts";

/** One element per weekday; the cycle repeats every 7 days. */
export const THEME_CYCLE: readonly ElementId[] = ["fire", "water", "plant", "electric", "earth", "ice", "air"];
/** Rare item shown on the last day of week k (k = 0..3): the cycle repeats every 28 days. */
export const RARE_CYCLE: readonly string[] = ["stone.evolution", "gear.shadowVeil", "cosmetic.starSpots", "stone.helixKey"];
export const THEME_DAYS = 7;
export const RARE_DAYS = 28;

/** Element -> its strong food first, then staples that push the same axes. */
export const ELEMENT_FOODS: Record<ElementId, readonly FoodId[]> = {
  neutral: ["berries", "greens"],
  fire: ["emberChili", "spicyPepper"],
  water: ["springWater", "fish", "seaweed"],
  plant: ["seedCake", "greens", "berries"],
  earth: ["stoneBread", "minerals"],
  air: ["cloudPuff", "honey"],
  electric: ["stormBerry", "coffeeBean", "seaweed"],
  ice: ["frostMint", "iceCream"],
  metal: ["ironNut", "minerals"],
  poison: ["toxicCap", "mushroom"],
  light: ["sunPetal", "glowFruit"],
  shadow: ["nightPlum", "mushroom"],
  psychic: ["mindLeaf", "coffeeBean"],
  void: ["voidSalt", "ashRoot"],
};

/** Element -> gear ids themed on it (element gear first, then a generic piece). */
export const ELEMENT_GEAR: Record<ElementId, readonly string[]> = {
  neutral: ["gear.ironHide"],
  fire: ["gear.emberFang", "gear.coneNozzle"],
  water: ["gear.tideCharm", "gear.vitalSeed"],
  plant: ["gear.thornBracer", "gear.vitalSeed"],
  earth: ["gear.quakeBoots", "gear.ironHide"],
  air: ["gear.swiftAnklet", "gear.focusLens"],
  electric: ["gear.thunderBand", "gear.swiftAnklet"],
  ice: ["gear.frostScale", "gear.ironHide"],
  metal: ["gear.ironHide", "gear.powerBand"],
  poison: ["gear.coneNozzle"],
  light: ["gear.focusLens"],
  shadow: ["gear.shadowVeil"],
  psychic: ["gear.focusLens"],
  void: ["gear.shadowVeil"],
};

export interface Rotation {
  dayIndex: number;
  theme: ElementId;
  /** Catalogue item ids (`food.<FoodId>`) in season today. */
  foods: string[];
  /** Catalogue gear ids in season today. */
  gear: string[];
  /** Rare catalogue item available today (last day of each week), else null. */
  rare: string | null;
}

function mod(n: number, m: number): number {
  return ((Math.floor(n) % m) + m) % m;
}

export function rotationFor(dayIndex: number): Rotation {
  const d = Number.isFinite(dayIndex) ? Math.floor(dayIndex) : 0;
  const theme = THEME_CYCLE[mod(d, THEME_DAYS)];
  const week = Math.floor(mod(d, RARE_DAYS) / THEME_DAYS);
  return {
    dayIndex: d,
    theme,
    foods: ELEMENT_FOODS[theme].map(foodItemId),
    gear: [...ELEMENT_GEAR[theme]],
    rare: mod(d, THEME_DAYS) === THEME_DAYS - 1 ? RARE_CYCLE[week] : null,
  };
}

/** Every catalogue id that is in season on `dayIndex` (foods, gear and the rare item). */
export function inSeason(dayIndex: number): Set<string> {
  const r = rotationFor(dayIndex);
  return new Set([...r.foods, ...r.gear, ...(r.rare ? [r.rare] : [])]);
}

// ------------------------------------------------------------------ world investments
export type InvestPlace = "supermarket" | "gym" | "park" | "lab" | "shrine";
export const INVEST_PLACES: readonly InvestPlace[] = ["supermarket", "gym", "park", "lab", "shrine"];

/** What each place pays back, and its rate (value returned per invested^0.85 credit at full maturity). */
export const INVEST_TABLE: Record<InvestPlace, { rate: number; pool: readonly string[]; note: string }> = {
  supermarket: {
    rate: 1.5,
    pool: ["emberChili", "springWater", "stormBerry", "frostMint", "seedCake", "stoneBread", "cloudPuff"].map((f) =>
      foodItemId(f as FoodId)
    ),
    note: "Shares in the supermarket come back as strong elemental foods.",
  },
  gym: {
    rate: 1.3,
    pool: ["gear.ironHide", "gear.swiftAnklet", "gear.powerBand", "gear.focusLens", "potion.energy"],
    note: "Sponsoring the gym returns training gear.",
  },
  park: {
    rate: 1.4,
    pool: ["food.seedCake", "food.berries", "food.cloudPuff", "cosmetic.flowerCrown", "potion.heal"],
    note: "Planting the park returns fruit, seeds and flower crowns.",
  },
  lab: {
    rate: 1.2,
    pool: ["food.mindLeaf", "food.voidSalt", "potion.surge", "potion.cleanse", "stone.prism"],
    note: "Funding the lab returns experimental foods, potions and prism shards.",
  },
  shrine: {
    rate: 1.1,
    pool: ["food.sunPetal", "food.nightPlum", "cosmetic.lantern", "cosmetic.emberGlow", "cosmetic.frostGlow"],
    note: "Offerings at the shrine return light/dark foods and glows.",
  },
};
/** Diminishing exponent on the invested amount. */
export const INVEST_EXPONENT = 0.85;
/** Hard cap on units returned by one claim (keeps a whale's claim bounded). */
export const INVEST_MAX_UNITS = 500;
/** Days for ~63 % of the full return. */
export const INVEST_TAU_DAYS = 7;

/** Credit value the investment has returned after `days` (before rounding to whole items). */
export function investmentValue(invested: number, days: number, place: InvestPlace): number {
  if (!(invested > 0) || !(days > 0) || !Number.isFinite(invested) || !Number.isFinite(days)) return 0;
  return INVEST_TABLE[place].rate * Math.pow(invested, INVEST_EXPONENT) * (1 - Math.exp(-days / INVEST_TAU_DAYS));
}

/**
 * Items returned so far by `invested` credits left at `place` for `days`. Deterministic per seed, and
 * the draw order does not depend on `days`, so waiting longer only ADDS items to what was owed.
 */
export function investmentReturn(o: {
  invested: number;
  days: number;
  place: InvestPlace;
  seed: number;
}): { itemId: string; qty: number }[] {
  const t = INVEST_TABLE[o.place];
  if (!t) return [];
  let budget = investmentValue(o.invested, o.days, o.place);
  const rng = new Rng(hashSeed(o.seed, "invest", o.place));
  const out = new Map<string, number>();
  // PREFIX rule: walk one fixed seeded sequence and stop at the first item the budget cannot pay yet
  // (it is "being saved for" and arrives on a later day). A bigger budget (more days, more credits)
  // therefore always returns a superset. Picks weigh 1/price so each item returns similar VALUE.
  const weights = t.pool.map((id) => 1 / ITEMS[id].basePrice);
  for (let n = 0; n < INVEST_MAX_UNITS; n++) {
    const id = rng.weighted(t.pool, weights);
    const price = ITEMS[id].basePrice;
    if (price > budget) break;
    budget -= price;
    out.set(id, (out.get(id) ?? 0) + 1);
  }
  return [...out.entries()].map(([itemId, qty]) => ({ itemId, qty })).sort((a, b) => a.itemId.localeCompare(b.itemId));
}
