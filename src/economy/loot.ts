/**
 * Battle LOOT (pass 4, P4-E1). PURE and deterministic: the same context always drops the same items.
 *
 * - A win drops 1-3 items, a loss 0-1 (a consolation). Streaks and bosses add drops.
 * - Rarity rises with opponent level, win streak and boss fights (weights tilt toward higher tiers).
 * - Kinds: food, cosmetic, gear, potion, stone. Items in season (rotation.ts) weigh x3 and the
 *   arena's themed foods weigh x3 (volcano -> ember chili, lake -> spring water...).
 * - The returned rarity is the dropped item's catalogue rarity (never a separate roll).
 */
import { hashSeed, Rng } from "../core/rng.ts";
import type { FoodId } from "../data/lifestyle.ts";
import { foodItemId, type ItemKind, ITEM_IDS, ITEMS, type Rarity, RARITIES, RARITY_RANK } from "./items.ts";
import { inSeason } from "./rotation.ts";

export interface LootCtx {
  seed: number;
  arena: string;
  won: boolean;
  streak?: number;
  opponentLevel: number;
  dayIndex: number;
  boss?: boolean;
}

export interface Drop {
  itemId: string;
  qty: number;
  rarity: Rarity;
}

export const LOOT_KINDS: readonly ItemKind[] = ["food", "cosmetic", "gear", "potion", "stone"];
const KIND_WEIGHT: Record<string, number> = { food: 45, potion: 18, gear: 15, cosmetic: 12, stone: 10 };
/** Base rarity weights before the level / streak / boss tilt. */
const BASE_RARITY_WEIGHT: Record<Rarity, number> = { common: 60, uncommon: 26, rare: 10, epic: 3.4, legendary: 0.6 };
export const SEASON_WEIGHT = 3;
export const ARENA_WEIGHT = 3;

/** Arena -> themed foods (weighted x3 when the drop is a food). */
export const ARENA_FOODS: Record<string, readonly FoodId[]> = {
  meadow: ["berries", "greens", "honey", "cloudPuff"],
  lake: ["springWater", "fish", "seaweed"],
  volcano: ["emberChili", "spicyPepper", "ashRoot"],
  canyon: ["stoneBread", "minerals", "ironNut"],
  tundra: ["frostMint", "iceCream"],
  swamp: ["toxicCap", "mushroom", "seaweed"],
  crystal: ["sunPetal", "glowFruit", "mindLeaf"],
  city: ["stormBerry", "coffeeBean", "candy"],
  beach: ["springWater", "seaweed", "fish"],
  forest: ["seedCake", "berries", "nightPlum"],
};

/**
 * Rarity tilt in [0, ~3]: level 100 = 1.2, a 10-win streak = 0.8, a boss = 1.2, a loss -0.5.
 * Tier r's weight is multiplied by e^(tilt * r * 0.7), so a higher tilt moves mass up the tiers.
 */
export function rarityTilt(ctx: LootCtx): number {
  const lvl = Math.min(100, Math.max(1, Number.isFinite(ctx.opponentLevel) ? ctx.opponentLevel : 1));
  const streak = Math.min(10, Math.max(0, Number.isFinite(ctx.streak ?? 0) ? Math.floor(ctx.streak ?? 0) : 0));
  return Math.max(0, 1.2 * (lvl / 100) + 0.08 * streak + (ctx.boss ? 1.2 : 0) - (ctx.won ? 0 : 0.5));
}

/** Rarity weights after the tilt (exported for docs and tests). */
export function rarityWeights(ctx: LootCtx): Record<Rarity, number> {
  const t = rarityTilt(ctx);
  const out = {} as Record<Rarity, number>;
  for (const r of RARITIES) out[r] = BASE_RARITY_WEIGHT[r] * Math.exp(t * RARITY_RANK[r] * 0.7);
  return out;
}

/** Number of drops: win 1-3 (+1 boss, +streak chance), loss 0-1. */
function dropCount(rng: Rng, ctx: LootCtx): number {
  if (!ctx.won) return rng.chance(ctx.boss ? 0.6 : 0.35) ? 1 : 0;
  const streak = Math.min(10, Math.max(0, Math.floor(ctx.streak ?? 0)));
  let n = 1;
  if (rng.chance(0.4 + 0.03 * streak)) n++;
  if (rng.chance(0.12 + 0.03 * streak)) n++;
  if (ctx.boss) n++;
  return Math.min(3, n);
}

function candidates(kind: ItemKind, rarity: Rarity): string[] {
  return ITEM_IDS.filter((id) => ITEMS[id].kind === kind && ITEMS[id].rarity === rarity);
}

/** Nearest tier that has items of this kind: first downward, then upward. */
function poolFor(kind: ItemKind, rarity: Rarity): string[] {
  const r0 = RARITY_RANK[rarity];
  for (let d = 0; d < RARITIES.length; d++) {
    for (const r of [r0 - d, r0 + d]) {
      if (r < 0 || r >= RARITIES.length) continue;
      const c = candidates(kind, RARITIES[r]);
      if (c.length) return c;
    }
  }
  return [];
}

export function battleLoot(ctx: LootCtx): Drop[] {
  const rng = new Rng(hashSeed(ctx.seed, "loot", ctx.arena, ctx.dayIndex, ctx.won ? 1 : 0, ctx.boss ? 1 : 0));
  const n = dropCount(rng, ctx);
  if (n === 0) return [];
  const season = inSeason(ctx.dayIndex);
  const arenaFoods = new Set((ARENA_FOODS[ctx.arena] ?? []).map(foodItemId));
  const rw = rarityWeights(ctx);
  const out = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const rarity = rng.weighted(RARITIES, RARITIES.map((r) => rw[r]));
    const kind = rng.weighted(LOOT_KINDS, LOOT_KINDS.map((k) => KIND_WEIGHT[k]));
    const pool = poolFor(kind, rarity);
    if (pool.length === 0) continue;
    const weights = pool.map((id) => (season.has(id) ? SEASON_WEIGHT : 1) * (arenaFoods.has(id) ? ARENA_WEIGHT : 1));
    const itemId = rng.weighted(pool, weights);
    const def = ITEMS[itemId];
    const qty = def.stackable && def.kind === "food" ? rng.int(1, def.rarity === "common" ? 3 : 2) : 1;
    out.set(itemId, (out.get(itemId) ?? 0) + qty);
  }
  return [...out.entries()].map(([itemId, qty]) => ({ itemId, qty, rarity: ITEMS[itemId].rarity }));
}
