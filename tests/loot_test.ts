import { assert, assertEquals } from "./_assert.ts";
import { ELEMENT_IDS } from "../src/data/elements.ts";
import { foodItemId, ITEM_IDS, ITEMS, RARITY_RANK } from "../src/economy/items.ts";
import { battleLoot, type LootCtx, LOOT_KINDS } from "../src/economy/loot.ts";
import {
  INVEST_PLACES,
  investmentReturn,
  investmentValue,
  RARE_DAYS,
  rotationFor,
  THEME_CYCLE,
  THEME_DAYS,
} from "../src/economy/rotation.ts";
import { addItems, bagOf, count, cosmeticsOf, equipGear, feedFromBag, gearOf, take, takeOff, unequip, wear } from "../src/ui/bagStore.ts";
import { newProfile } from "../src/ui/profile.ts";

const SEEDS = Array.from({ length: 500 }, (_, i) => i + 1);
const base: LootCtx = { seed: 1, arena: "meadow", won: true, opponentLevel: 20, dayIndex: 0 };
const meanRank = (f: (s: number) => LootCtx) => {
  let sum = 0, n = 0;
  for (const s of SEEDS) {
    for (const d of battleLoot(f(s))) {
      sum += RARITY_RANK[d.rarity];
      n++;
    }
  }
  return n ? sum / n : 0;
};
const totalQty = (f: (s: number) => LootCtx, pred: (id: string) => boolean = () => true) =>
  SEEDS.reduce((t, s) => t + battleLoot(f(s)).filter((d) => pred(d.itemId)).reduce((u, d) => u + d.qty, 0), 0);

Deno.test("[LOOT] deterministic, known items of the loot kinds, rarity from the catalogue", () => {
  for (const s of SEEDS.slice(0, 100)) {
    const ctx = { ...base, seed: s, streak: s % 7, boss: s % 5 === 0 };
    assertEquals(battleLoot(ctx), battleLoot({ ...ctx }));
    for (const d of battleLoot(ctx)) {
      const def = ITEMS[d.itemId];
      assert(def, `unknown item ${d.itemId}`);
      assert(LOOT_KINDS.includes(def.kind), `${d.itemId}: kind ${def.kind}`);
      assertEquals(d.rarity, def.rarity);
      assert(Number.isInteger(d.qty) && d.qty >= 1);
    }
  }
  assert(JSON.stringify(battleLoot({ ...base, seed: 1 })) !== JSON.stringify(battleLoot({ ...base, seed: 2 })) ||
    JSON.stringify(battleLoot({ ...base, seed: 3 })) !== JSON.stringify(battleLoot({ ...base, seed: 4 })), "seed matters");
});

Deno.test("[LOOT] a win drops 1-3 items, a loss 0-1, and wins pay more over 500 seeds", () => {
  let win = 0, loss = 0;
  for (const s of SEEDS) {
    const w = battleLoot({ ...base, seed: s }).length;
    const l = battleLoot({ ...base, seed: s, won: false }).length;
    assert(w >= 1 && w <= 3, `win drops ${w}`);
    assert(l >= 0 && l <= 1, `loss drops ${l}`);
    win += w;
    loss += l;
  }
  console.log(`drops per battle over 500 seeds: win ${(win / 500).toFixed(2)}, loss ${(loss / 500).toFixed(2)}`);
  assert(win > loss * 2, "a win is worth clearly more than a loss");
});

Deno.test("[LOOT] rarity rises with boss, opponent level and streak", () => {
  const plain = meanRank((s) => ({ ...base, seed: s }));
  const boss = meanRank((s) => ({ ...base, seed: s, boss: true }));
  const high = meanRank((s) => ({ ...base, seed: s, opponentLevel: 90 }));
  const streak = meanRank((s) => ({ ...base, seed: s, streak: 10 }));
  console.log(`mean rarity rank: plain ${plain.toFixed(2)} boss ${boss.toFixed(2)} lvl90 ${high.toFixed(2)} streak10 ${streak.toFixed(2)}`);
  assert(boss > plain + 0.3, "a boss raises rarity");
  assert(high > plain + 0.1, "a strong opponent raises rarity");
  assert(streak > plain + 0.1, "a streak raises rarity");
});

Deno.test("[LOOT] arena-themed foods and in-season items drop more", () => {
  const chili = (id: string) => id === foodItemId("emberChili");
  // dayIndex 1 = water day, so chili is out of season in both runs: only the arena differs.
  const volcano = totalQty((s) => ({ ...base, seed: s, arena: "volcano", dayIndex: 1 }), chili);
  const meadow = totalQty((s) => ({ ...base, seed: s, arena: "meadow", dayIndex: 1 }), chili);
  assert(volcano > meadow * 1.5, `volcano chili ${volcano} vs meadow ${meadow}`);
  const fang = (id: string) => id === "gear.emberFang";
  const fireDay = totalQty((s) => ({ ...base, seed: s, dayIndex: 0 }), fang);
  const waterDay = totalQty((s) => ({ ...base, seed: s, dayIndex: 1 }), fang);
  assert(fireDay > waterDay * 1.5, `ember fang on fire day ${fireDay} vs water day ${waterDay}`);
});

Deno.test("[ROTATION] 7-day theme cycle, 28-day rare cycle, negative days", () => {
  assertEquals(new Set(THEME_CYCLE).size, THEME_DAYS);
  for (let d = -30; d < 60; d++) {
    assertEquals(rotationFor(d).theme, rotationFor(d + THEME_DAYS).theme, `day ${d}`);
    const a = rotationFor(d), b = rotationFor(d + RARE_DAYS);
    assertEquals([a.theme, a.foods, a.gear, a.rare], [b.theme, b.foods, b.gear, b.rare]);
    for (const id of [...a.foods, ...a.gear, ...(a.rare ? [a.rare] : [])]) assert(ITEMS[id], `${id} not in catalogue`);
  }
  const rares = Array.from({ length: RARE_DAYS }, (_, d) => rotationFor(d).rare).filter((r) => r !== null);
  assertEquals(rares.length, 4);
  assertEquals(new Set(rares).size, 4, "four different rares per 28 days");
  assert(rotationFor(0).theme !== rotationFor(1).theme, "the theme changes daily");
  assertEquals(rotationFor(0).foods[0], foodItemId("emberChili"));
  assert(THEME_CYCLE.every((e) => ELEMENT_IDS.includes(e)));
});

Deno.test("[INVEST] deterministic, diminishing in credits and in days, monotone in days", () => {
  for (const place of INVEST_PLACES) {
    const o = { invested: 2000, days: 20, place, seed: 42 };
    assertEquals(investmentReturn(o), investmentReturn({ ...o }));
    assert(investmentReturn(o).length > 0, `${place} returns something`);
    assertEquals(investmentReturn({ ...o, days: 0 }), []);
    assertEquals(investmentReturn({ ...o, invested: 0 }), []);
    // Per credit: 100 > 1000 > 10000.
    const per = [100, 1000, 10000].map((c) => investmentValue(c, 30, place) / c);
    assert(per[0] > per[1] && per[1] > per[2], `${place}: diminishing per credit ${per}`);
    // Per day: the first week pays more than the second.
    const w1 = investmentValue(1000, 7, place), w2 = investmentValue(1000, 14, place) - w1;
    assert(w1 > w2 && w2 > 0, `${place}: diminishing per day`);
    // Waiting longer only adds items (prefix rule).
    let prev = new Map<string, number>();
    for (const days of [1, 3, 7, 14, 30]) {
      const now = new Map(investmentReturn({ ...o, days }).map((r) => [r.itemId, r.qty]));
      for (const [id, q] of prev) assert((now.get(id) ?? 0) >= q, `${place}: ${id} shrank at ${days} days`);
      prev = now;
    }
    // Returned value never exceeds the computed value.
    const got = investmentReturn({ ...o, days: 30 }).reduce((s, r) => s + ITEMS[r.itemId].basePrice * r.qty, 0);
    assert(got <= investmentValue(2000, 30, place) + 1e-9, `${place}: paid ${got}`);
  }
});

Deno.test("[GEAR] >= 12 gear pieces, each pays for its edge; cosmetics cover head/neck/glow/pattern", () => {
  const gear = ITEM_IDS.filter((id) => ITEMS[id].kind === "gear");
  assert(gear.length >= 12, `only ${gear.length} gear`);
  for (const id of gear) {
    const nums = Object.values(ITEMS[id].effects).filter((v): v is number => typeof v === "number");
    assert(nums.some((v) => v > 0) && nums.some((v) => v < 0), `${id}: needs an edge AND a cost [SPEC B1]`);
  }
  const slots = new Set(ITEM_IDS.filter((id) => ITEMS[id].kind === "cosmetic").map((id) => String(ITEMS[id].effects.slot)));
  for (const s of ["head", "neck", "glow", "pattern"]) assert(slots.has(s), `no ${s} cosmetic`);
});

Deno.test("[BAG] take fails when empty; feed, gear and cosmetics move items in and out of the bag", () => {
  const p = newProfile("Bag tester", "human", 0);
  const g = p.collection[0];
  const bag = bagOf(p);
  assertEquals(bag, {});
  assert(!take(bag, "food.emberChili"), "take from an empty bag fails");
  assert(!feedFromBag(p, g, "emberChili", 1), "no chili, no feed");
  assertEquals(g.conditions.diet.emberChili, undefined, "a refused feed does not feed");
  addItems(bag, [{ itemId: "food.emberChili", qty: 3 }, { itemId: "nope.item", qty: 5 }, { itemId: "gear.ironHide", qty: 0 }]);
  assertEquals(bagOf(p), { "food.emberChili": 3 }, "unknown ids and bad quantities are skipped");
  assert(!take(bag, "food.emberChili", 4) && count(bag, "food.emberChili") === 3, "over-take refused, no change");
  assert(feedFromBag(p, g, "emberChili", 2));
  assertEquals([count(bag, "food.emberChili"), g.conditions.diet.emberChili], [1, 2]);
  assert(take(bag, "food.emberChili") && !("food.emberChili" in bag), "the last unit removes the key");

  addItems(bag, [{ itemId: "gear.ironHide", qty: 1 }, { itemId: "gear.emberFang", qty: 1 }, { itemId: "cosmetic.scarf", qty: 1 }]);
  assert(!equipGear(p, g.id, "cosmetic.scarf"), "a cosmetic is not gear");
  assert(!equipGear(p, "not-mine", "gear.ironHide"), "only own Genemon");
  assert(equipGear(p, g.id, "gear.ironHide"));
  assertEquals(gearOf(p, g.id)?.effects.defPct, 12);
  assert(equipGear(p, g.id, "gear.emberFang"), "swap");
  assertEquals([count(bag, "gear.ironHide"), count(bag, "gear.emberFang")], [1, 0], "the swapped piece is back");
  assert(!equipGear(p, g.id, "gear.emberFang"), "no second fang in the bag");
  assertEquals(unequip(p, g.id), "gear.emberFang");
  assertEquals([gearOf(p, g.id), unequip(p, g.id), count(bag, "gear.emberFang")], [null, null, 1]);

  assert(!wear(p, g.id, "gear.ironHide"), "gear is not a cosmetic");
  assert(wear(p, g.id, "cosmetic.scarf"));
  assertEquals(cosmeticsOf(p, g.id), { neck: "cosmetic.scarf" });
  assertEquals(count(bag, "cosmetic.scarf"), 0);
  assertEquals(takeOff(p, g.id, "neck"), "cosmetic.scarf");
  assertEquals([count(bag, "cosmetic.scarf"), takeOff(p, g.id, "neck")], [1, null]);
  // Loot flows into the bag.
  addItems(bag, battleLoot({ ...base, seed: 7 }));
  assert(Object.keys(bag).length >= 3);
  // JSON round trip (localStorage) keeps everything.
  const back = JSON.parse(JSON.stringify(p));
  assertEquals(bagOf(back), bag);
});
