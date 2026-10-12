/**
 * Item catalogue + Genemon appraisal for the Genemon economy. PURE: no DOM, no clock, no randomness.
 *
 * - ITEMS holds every food from FOODS (same list price) plus potions, one lure per element, one egg
 *   per rarity tier, evolution/mutation/fusion stones, cosmetics, territory flags, incubators, arena
 *   and dungeon tickets and treasure maps. `effects` is a flat bag that the consuming system reads
 *   (food -> genemon.feed, stone.voidShard -> breeding.mutate, stone.fusionCore -> breeding.fuse...).
 * - A Genemon is tradeable too: its item id is `genemon:<genemonId>`, it is unique (never stackable)
 *   and its reference price comes from appraiseGenemon (level, power, element rarity, generation...).
 * Rules, tables and the reasons behind every number: docs/ECONOMY.md.
 */
import { ELEMENT_IDS, ELEMENTS, type ElementId } from "../data/elements.ts";
import { FOOD_IDS, FOODS, type FoodId } from "../data/lifestyle.ts";
import type { Phenotype } from "../genome/phenotype.ts";

export type ItemKind =
  | "food"
  | "potion"
  | "lure"
  | "egg"
  | "stone"
  | "cosmetic"
  | "territoryFlag"
  | "incubator"
  | "ticket"
  | "map"
  | "genemon";

/** Every kind, in catalogue order (genemon last: those items are dynamic, never in ITEMS). */
export const ITEM_KINDS: readonly ItemKind[] = [
  "food",
  "potion",
  "lure",
  "egg",
  "stone",
  "cosmetic",
  "territoryFlag",
  "incubator",
  "ticket",
  "map",
  "genemon",
];

export type Rarity = "common" | "uncommon" | "rare" | "epic" | "legendary";
export const RARITIES: readonly Rarity[] = ["common", "uncommon", "rare", "epic", "legendary"];
/** Ordinal of a rarity tier (common 0 .. legendary 4) for comparisons. */
export const RARITY_RANK: Record<Rarity, number> = { common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 4 };
/** Value multiplier per tier, shared by genemon appraisal and NPC collector demand. */
export const RARITY_MULT: Record<Rarity, number> = { common: 1, uncommon: 1.3, rare: 1.75, epic: 2.4, legendary: 3.5 };

/**
 * How scarce each element is in the wild. Classic four + air are common, the "technical" ones
 * uncommon, the mind/light/shadow trio rare, void epic. Drives lure prices and genemon appraisal.
 */
export const ELEMENT_RARITY: Record<ElementId, Rarity> = {
  neutral: "common",
  fire: "common",
  water: "common",
  plant: "common",
  earth: "common",
  air: "common",
  electric: "uncommon",
  ice: "uncommon",
  metal: "uncommon",
  poison: "uncommon",
  light: "rare",
  shadow: "rare",
  psychic: "rare",
  void: "epic",
};

export interface ItemDef {
  id: string;
  name: string;
  kind: ItemKind;
  /** List price in credits for ONE unit (the anchor of every price model). */
  basePrice: number;
  rarity: Rarity;
  /** Fungible units that may be listed as a bundle (qty > 1). */
  stackable: boolean;
  /** Flat effect bag read by the consuming system (battle, world, breeding, cosmetics). */
  effects: Record<string, number | string>;
  note: string;
}

/** Catalogue id of a food item (`food.<FoodId>`); `effects.food` carries the raw FoodId back. */
export function foodItemId(food: FoodId): string {
  return `food.${food}`;
}

// ------------------------------------------------------------------ catalogue
const LURE_PRICE: Record<Rarity, number> = { common: 25, uncommon: 35, rare: 60, epic: 120, legendary: 250 };

/** Egg tiers: hatch distance (km walked, physical play), genetic quality floor, mutation chance. */
const EGG_TIERS: Record<Rarity, { price: number; hatchKm: number; minQuality: number; mutationChance: number }> = {
  common: { price: 40, hatchKm: 2, minQuality: 0.3, mutationChance: 0.01 },
  uncommon: { price: 110, hatchKm: 5, minQuality: 0.42, mutationChance: 0.02 },
  rare: { price: 300, hatchKm: 7, minQuality: 0.55, mutationChance: 0.04 },
  epic: { price: 850, hatchKm: 10, minQuality: 0.68, mutationChance: 0.07 },
  legendary: { price: 2400, hatchKm: 15, minQuality: 0.82, mutationChance: 0.12 },
};

function buildCatalogue(): Record<string, ItemDef> {
  const out: Record<string, ItemDef> = {};
  const add = (
    id: string,
    name: string,
    kind: ItemKind,
    basePrice: number,
    rarity: Rarity,
    stackable: boolean,
    effects: Record<string, number | string>,
    note: string,
  ): void => {
    if (Object.hasOwn(out, id)) throw new Error(`duplicate item id ${id}`);
    out[id] = Object.freeze({ id, name, kind, basePrice, rarity, stackable, effects: Object.freeze({ ...effects }), note });
  };

  // Food: the supermarket staple. Same price as FOODS so lifestyle and market never disagree.
  for (const id of FOOD_IDS) {
    const f = FOODS[id];
    add(
      foodItemId(id),
      f.name,
      "food",
      f.price,
      f.price >= 12 ? "uncommon" : "common",
      true,
      { food: id, nutrition: f.nutrition, joy: f.joy },
      `Feeds ${f.nutrition} growth units; nudges ${Object.keys(f.nudge).join(", ")}.`,
    );
  }

  // Potions: battle and care consumables.
  add("potion.heal", "Healing tonic", "potion", 12, "common", true, { heal: 0.35 }, "Restores 35% HP.");
  add("potion.fullHeal", "Phoenix draught", "potion", 60, "rare", true, { heal: 1 }, "Restores all HP; using it in battle costs the turn.");
  add("potion.energy", "Energy drink", "potion", 10, "common", true, { energy: 40 }, "Restores 40 energy.");
  add("potion.surge", "Surge elixir", "potion", 35, "uncommon", true, { energy: 100, regenBoost: 0.5, durationS: 30 }, "Full energy and +50% energy regen for 30 s.");
  add("potion.cleanse", "Cleansing salts", "potion", 18, "uncommon", true, { cleanse: "all", immunityS: 5 }, "Removes poison, burn, freeze, blind and slow; 5 s immunity.");
  add("potion.revive", "Revival seed", "potion", 80, "rare", true, { revive: 0.5 }, "Revives a knocked-out Genemon at 50% HP.");

  // Lures: one per element; bias wild spawns toward that element around the player.
  for (const el of ELEMENT_IDS) {
    const r = ELEMENT_RARITY[el];
    const name = el === "neutral" ? "Plain lure" : `${ELEMENTS[el].name} lure`;
    add(
      `lure.${el}`,
      name,
      "lure",
      el === "neutral" ? 15 : LURE_PRICE[r],
      r,
      true,
      { element: el, spawnBias: 0.35, durationMin: 30, radiusM: 40 },
      `Biases wild spawns toward ${ELEMENTS[el].name.toLowerCase()} Genemon within 40 m for 30 min.`,
    );
  }

  // Eggs: contents roll at HATCH time from the hatch seed, so unhatched eggs of a tier are fungible.
  for (const r of RARITIES) {
    const e = EGG_TIERS[r];
    add(
      `egg.${r}`,
      `${r.charAt(0).toUpperCase()}${r.slice(1)} egg`,
      "egg",
      e.price,
      r,
      true,
      { hatchKm: e.hatchKm, minQuality: e.minQuality, mutationChance: e.mutationChance },
      `Hatches after ${e.hatchKm} km walked; genetic quality >= ${e.minQuality}.`,
    );
  }

  // Stones: evolution, mutation and fusion (wired to src/genome/breeding.ts operators).
  add("stone.evolution", "Evolution stone", "stone", 250, "rare", true, { evolve: 1, minGrowth: 0.6 }, "Advances one stage when growth >= 0.6, skipping the level gate.");
  add("stone.everstone", "Everstone", "stone", 60, "uncommon", true, { lockStage: 1 }, "Holds a Genemon at its current stage while carried.");
  add("stone.voidShard", "Void shard", "stone", 600, "epic", true, { mutate: 0.3, focus: "substance,phase,luminance" }, "Mutates the genome (breeding.mutate strength 0.3, void axes). Irreversible.");
  add("stone.fusionCore", "Fusion core", "stone", 2500, "legendary", true, { fuse: 1, consumes: 2 }, "Fuses two owned Genemon into one (breeding.fuse); both inputs are consumed.");
  add("stone.prism", "Prism shard", "stone", 300, "rare", true, { rerollPattern: 1 }, "Re-rolls the coat pattern; every other gene is kept.");
  add("stone.helixKey", "Helix key", "stone", 900, "epic", true, { mutationRateMult: 1.5 }, "Next breeding runs at 1.5x mutation rate.");

  // Cosmetics: purely visual, no stats (keeps the market out of pay-to-win).
  add("cosmetic.scarf", "Woolly scarf", "cosmetic", 30, "common", false, { slot: "neck", style: "wool" }, "Visual only.");
  add("cosmetic.glowPaint", "Glow paint", "cosmetic", 90, "uncommon", false, { slot: "body", glow: 0.3 }, "Adds 0.3 emissive glow. Visual only.");
  add("cosmetic.crown", "Tiny crown", "cosmetic", 350, "rare", false, { slot: "head", style: "gold-crown" }, "Visual only.");
  add("cosmetic.goldPlate", "Gold nameplate", "cosmetic", 260, "rare", false, { slot: "nameplate", style: "gold" }, "Gold name tag in arenas and on the map.");
  add("cosmetic.starTrail", "Star trail", "cosmetic", 800, "epic", false, { slot: "trail", particles: 24 }, "Particle trail while moving. Visual only.");

  // Territory flags: claim a world-map area (world designer owns the claim rules).
  add("flag.wood", "Wooden flag", "territoryFlag", 50, "common", true, { claimRadiusM: 25, holdHours: 12, defenseBonus: 0 }, "Claims a 25 m radius for 12 h.");
  add("flag.iron", "Iron banner", "territoryFlag", 180, "uncommon", true, { claimRadiusM: 50, holdHours: 24, defenseBonus: 0.05 }, "Claims 50 m for 24 h; defenders +5%.");
  add("flag.crystal", "Crystal standard", "territoryFlag", 1400, "epic", true, { claimRadiusM: 120, holdHours: 72, defenseBonus: 0.12 }, "Claims 120 m for 72 h; defenders +12%.");

  // Incubators: wear out (uses), so a used one is not fungible -> never stackable.
  add("incubator.basic", "Basic incubator", "incubator", 60, "common", false, { uses: 3, speed: 1 }, "Hatches 3 eggs at walking speed x1.");
  add("incubator.super", "Super incubator", "incubator", 200, "uncommon", false, { uses: 3, speed: 1.5 }, "Hatches 3 eggs; every km counts 1.5x.");
  add("incubator.thermal", "Thermal incubator", "incubator", 450, "rare", false, { uses: 1, speed: 1, element: "fire", mutationChance: 0.05 }, "One egg; biases the hatchling toward fire, +5% mutation.");

  // Tickets: entry passes for arena cups and dungeons.
  add("ticket.arenaBronze", "Bronze cup pass", "ticket", 40, "common", true, { arenaTier: 1, entries: 1 }, "One entry to a bronze arena cup.");
  add("ticket.arenaGold", "Gold cup pass", "ticket", 300, "rare", true, { arenaTier: 3, entries: 1 }, "One entry to a gold arena cup.");
  add("ticket.crystalCave", "Crystal cave pass", "ticket", 120, "uncommon", true, { dungeon: "crystal-cave", entries: 1, durationMin: 30 }, "30 min run in the crystal cave dungeon.");
  add("ticket.voidAbyss", "Void abyss pass", "ticket", 900, "epic", true, { dungeon: "void-abyss", entries: 1, durationMin: 20 }, "20 min run in the void abyss.");

  // Maps: each points at one place -> unique, never stackable.
  add("map.tornTreasure", "Torn treasure map", "map", 80, "uncommon", false, { lootTier: 1, radiusKm: 2 }, "Marks a tier-1 cache within 2 km.");
  add("map.nest", "Nest map", "map", 260, "rare", false, { revealsNest: 1, durationH: 6 }, "Reveals a spawning nest for 6 h.");
  add("map.ancientTreasure", "Ancient treasure map", "map", 1100, "epic", false, { lootTier: 3, radiusKm: 10 }, "Marks a tier-3 cache within 10 km.");

  return out;
}

/** The static catalogue (frozen). Genemon items are dynamic: see genemonItemDef / itemDef. */
export const ITEMS: Record<string, ItemDef> = Object.freeze(buildCatalogue());
/** Catalogue ids in a stable order (deterministic iteration for restocks and drop tables). */
export const ITEM_IDS: readonly string[] = Object.freeze(Object.keys(ITEMS));

// ------------------------------------------------------------------ genemons as items
const GENEMON_PREFIX = "genemon:";

export function genemonItemId(genemonId: string): string {
  if (typeof genemonId !== "string" || genemonId.length === 0) throw new Error("genemonItemId: empty genemon id");
  return `${GENEMON_PREFIX}${genemonId}`;
}

export function isGenemonItem(itemId: string): boolean {
  return typeof itemId === "string" && itemId.startsWith(GENEMON_PREFIX) && itemId.length > GENEMON_PREFIX.length;
}

/** Facts the phenotype does not carry: pass genome.generation and genome.mutations.length. */
export interface GenemonInfo {
  generation?: number;
  mutations?: number;
  name?: string;
}

/**
 * Reference price of a Genemon in credits (integer >= 10). Multiplicative so each factor reads as
 * a premium: power per team slot x level is the investment (power is divided by sqrt(slots)
 * because a big body also costs more of the team budget [SPEC B1]), element rarity the scarcity,
 * generation and mutations the pedigree, abilities and glow the collector appeal.
 */
export function appraiseGenemon(ph: Phenotype, info: GenemonInfo = {}): number {
  const level = Math.min(100, Math.max(1, Number.isFinite(ph.level) ? ph.level : 1));
  const power = Number.isFinite(ph.power) ? Math.max(0, ph.power) : 0;
  const perSlot = power / Math.sqrt(Math.max(1, Number.isFinite(ph.slots) ? ph.slots : 1));
  const primary = RARITY_MULT[ELEMENT_RARITY[ph.elements.primary]];
  const secondary = ph.elements.secondary ? 1.1 + 0.25 * (RARITY_MULT[ELEMENT_RARITY[ph.elements.secondary]] - 1) : 1;
  const generation = 1 + 0.12 * Math.min(10, Math.max(0, info.generation ?? 0));
  const mutations = 1 + 0.05 * Math.min(10, Math.max(0, info.mutations ?? 0));
  const abilities = 1 + 0.08 * Object.values(ph.abilities).filter(Boolean).length;
  const glow = 1 + 0.15 * Math.min(1, Math.max(0, Number.isFinite(ph.glow) ? ph.glow : 0));
  const raw = 20 + 0.55 * perSlot * (1 + level / 20) * primary * secondary * generation * mutations * abilities * glow;
  return Number.isFinite(raw) ? Math.max(10, Math.round(raw)) : 10;
}

/** Rarity tier of an appraised value (thresholds in credits). */
export function rarityForValue(value: number): Rarity {
  if (value < 250) return "common";
  if (value < 800) return "uncommon";
  if (value < 2500) return "rare";
  if (value < 8000) return "epic";
  return "legendary";
}

/**
 * Item definition of one Genemon. Without a phenotype the creature is UNAPPRAISED (basePrice 0):
 * it can still be traded, but NPCs ignore it and no reference price is shown.
 */
export function genemonItemDef(genemonId: string, ph?: Phenotype, info: GenemonInfo = {}): ItemDef {
  const id = genemonItemId(genemonId);
  const name = info.name ?? `Genemon ${genemonId}`;
  if (!ph) {
    return {
      id,
      name,
      kind: "genemon",
      basePrice: 0,
      rarity: "common",
      stackable: false,
      effects: { genemonId, appraised: "no" },
      note: "Unappraised Genemon: register it with the auction house to get a reference price.",
    };
  }
  const value = appraiseGenemon(ph, info);
  return {
    id,
    name,
    kind: "genemon",
    basePrice: value,
    rarity: rarityForValue(value),
    stackable: false,
    effects: {
      genemonId,
      appraised: "yes",
      level: ph.level,
      power: Math.round(ph.power),
      primary: ph.elements.primary,
      secondary: ph.elements.secondary ?? "none",
      sizeClass: ph.sizeClass,
      generation: info.generation ?? 0,
    },
    note: "Unique creature: always a single unit. Price = appraiseGenemon(level, power, elements, pedigree).",
  };
}

/** Catalogue lookup that also resolves `genemon:<id>` (as unappraised). Prototype keys never match. */
export function itemDef(itemId: string): ItemDef | undefined {
  if (typeof itemId !== "string") return undefined;
  if (Object.hasOwn(ITEMS, itemId)) return ITEMS[itemId];
  if (isGenemonItem(itemId)) return genemonItemDef(itemId.slice(GENEMON_PREFIX.length));
  return undefined;
}
