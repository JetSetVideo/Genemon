/**
 * The player's BAG (pass 4, P4-E1): item counts, held gear and worn cosmetics on the Profile.
 * PURE (no DOM, no storage): it mutates the Profile object; the caller persists with app.save().
 *
 * Profile fields (optional, added by the orchestrator to src/ui/profile.ts):
 *   bag?: Record<itemId, count>                 every catalogue item the player owns
 *   gear?: Record<genemonId, itemId>            ONE held gear piece per Genemon
 *   cosmetics?: Record<genemonId, Record<slot, itemId>>   one cosmetic per slot per Genemon
 * Equipped / worn items leave the bag and come back when removed, so counts never duplicate.
 */
import { feed, feedLife, type Genemon, type LifeCtx } from "../genome/genemon.ts";
import type { EatResult } from "../genome/lifeTypes.ts";
import type { FoodId } from "../data/lifestyle.ts";
import { foodItemId, ITEMS } from "../economy/items.ts";
import type { Profile } from "./profile.ts";

export type Bag = Record<string, number>;

interface BagFields {
  bag?: Bag;
  gear?: Record<string, string>;
  cosmetics?: Record<string, Record<string, string>>;
}

function fields(p: Profile): BagFields {
  return p as unknown as BagFields;
}

/** The profile's bag (created and attached on first use, so mutations persist with the profile). */
export function bagOf(p: Profile): Bag {
  const f = fields(p);
  if (!f.bag || typeof f.bag !== "object") f.bag = {};
  return f.bag;
}

function validQty(q: number): boolean {
  return Number.isInteger(q) && q > 0;
}

/** Add drops (loot, investment returns, purchases). Unknown ids and bad quantities are skipped. */
export function addItems(bag: Bag, drops: readonly { itemId: string; qty: number }[]): Bag {
  for (const d of drops) {
    if (!Object.hasOwn(ITEMS, d.itemId) || !validQty(d.qty)) continue;
    bag[d.itemId] = (bag[d.itemId] ?? 0) + d.qty;
  }
  return bag;
}

/** Remove `qty` units; false (and no change) when the bag holds fewer. */
export function take(bag: Bag, itemId: string, qty = 1): boolean {
  if (!validQty(qty)) return false;
  const have = Object.hasOwn(bag, itemId) ? bag[itemId] : 0;
  if (have < qty) return false;
  if (have === qty) delete bag[itemId];
  else bag[itemId] = have - qty;
  return true;
}

export function count(bag: Bag, itemId: string): number {
  return Object.hasOwn(bag, itemId) ? bag[itemId] : 0;
}

function owns(p: Profile, genemonId: string): boolean {
  return p.collection.some((g) => g.id === genemonId);
}

/** Feed `units` of a food FROM THE BAG: decrements, then calls genemon.feed. False when missing. */
export function feedFromBag(p: Profile, g: Genemon, foodId: FoodId, units = 1, ctx: LifeCtx = {}): boolean {
  if (!owns(p, g.id)) return false;
  if (!take(bagOf(p), foodItemId(foodId), units)) return false;
  feed(g, foodId, units, ctx);
  return true;
}

/**
 * Pass 5 [P5-G3]: feed from the bag INTO THE STOMACH (digested over hours by the life loop). The bag is
 * only charged for the units actually swallowed. null = not enough in the bag; r.ok false = refused
 * (stomach full; `ignoreCapacity` = the test-demo "no food limit").
 */
export function feedFromBagLife(p: Profile, g: Genemon, foodId: FoodId, units: number, now: number, ctx: LifeCtx & { ignoreCapacity?: boolean } = {}): EatResult | null {
  if (!owns(p, g.id)) return null;
  if (count(bagOf(p), foodItemId(foodId)) < units) return null;
  const r = feedLife(g, foodId, units, now, ctx);
  if (r.ok && r.units > 0) take(bagOf(p), foodItemId(foodId), r.units);
  return r;
}

/** Give a Genemon a gear piece from the bag; the piece it held before goes back to the bag. */
export function equipGear(p: Profile, genemonId: string, itemId: string): boolean {
  if (!owns(p, genemonId) || ITEMS[itemId]?.kind !== "gear") return false;
  const bag = bagOf(p);
  if (!take(bag, itemId, 1)) return false;
  const f = fields(p);
  f.gear ??= {};
  const prev = f.gear[genemonId];
  if (prev) bag[prev] = (bag[prev] ?? 0) + 1;
  f.gear[genemonId] = itemId;
  return true;
}

/** Take the held gear back into the bag; returns its id, or null when nothing was held. */
export function unequip(p: Profile, genemonId: string): string | null {
  const f = fields(p);
  const prev = f.gear?.[genemonId];
  if (!prev) return null;
  delete f.gear![genemonId];
  const bag = bagOf(p);
  bag[prev] = (bag[prev] ?? 0) + 1;
  return prev;
}

/** Held gear id and its effect bag (null when none) - what the battle reads. */
export function gearOf(p: Profile, genemonId: string): { itemId: string; effects: Record<string, number | string> } | null {
  const id = fields(p).gear?.[genemonId];
  const def = id ? ITEMS[id] : undefined;
  return def ? { itemId: def.id, effects: def.effects } : null;
}

/** Wear a cosmetic from the bag in its slot (effects.slot); the one already in that slot returns. */
export function wear(p: Profile, genemonId: string, itemId: string): boolean {
  const def = ITEMS[itemId];
  if (!owns(p, genemonId) || def?.kind !== "cosmetic") return false;
  const slot = String(def.effects.slot ?? "body");
  const bag = bagOf(p);
  if (!take(bag, itemId, 1)) return false;
  const f = fields(p);
  f.cosmetics ??= {};
  const worn = (f.cosmetics[genemonId] ??= {});
  const prev = worn[slot];
  if (prev) bag[prev] = (bag[prev] ?? 0) + 1;
  worn[slot] = itemId;
  return true;
}

/** Take off the cosmetic in `slot` (back to the bag); returns its id or null. */
export function takeOff(p: Profile, genemonId: string, slot: string): string | null {
  const worn = fields(p).cosmetics?.[genemonId];
  const prev = worn?.[slot];
  if (!worn || !prev) return null;
  delete worn[slot];
  const bag = bagOf(p);
  bag[prev] = (bag[prev] ?? 0) + 1;
  return prev;
}

/** Worn cosmetics by slot (a copy). */
export function cosmeticsOf(p: Profile, genemonId: string): Record<string, string> {
  return { ...(fields(p).cosmetics?.[genemonId] ?? {}) };
}
