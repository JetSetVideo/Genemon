/** Pass-5 UI pure parts: item icon specs (every catalogue item), the feed-effects diff, auction outcomes. */
import { assert, assertEquals } from "./_assert.ts";
import { ITEM_IDS, ITEMS, RARITIES } from "../src/economy/items.ts";
import { FOOD_IDS } from "../src/data/lifestyle.ts";
import { FOOD_ICON, FOOD_SHAPES, ICON_SHAPES, iconSpec, mixHex, RARITY_RING, SHAPE_PARTS } from "../src/ui/icons.ts";
import { effectDeltas, feedSnap, isStaple, usableKind } from "../src/ui/dragFeed.ts";
import { createGenemon, feed, phenotypeOf } from "../src/genome/genemon.ts";
import { bidOutcome, saleOutcome } from "../src/ui/screens/market.ts";
import type { Listing } from "../src/economy/market.ts";

const HEX = /^#[0-9a-f]{6}$/;

Deno.test("icons: every catalogue item has a drawable, coloured, rarity-ringed icon", () => {
  assert(ITEM_IDS.length > 80, `catalogue has ${ITEM_IDS.length} items`);
  for (const id of ITEM_IDS) {
    const s = iconSpec(id);
    const def = ITEMS[id];
    assert(ICON_SHAPES.includes(s.shape), `${id}: shape ${s.shape}`);
    assert(s.shape !== "unknown", `${id} falls back to the unknown glyph`);
    assert(SHAPE_PARTS[s.shape].length > 0, `${id}: empty glyph`);
    for (const c of [s.main, s.accent, s.bg, s.ring]) assert(HEX.test(c), `${id}: bad colour ${c}`);
    assertEquals(s.ring, RARITY_RING[def.rarity], `${id}: ring follows rarity`);
    assertEquals(s.kind, def.kind);
    assertEquals(s.name, def.name);
  }
});

Deno.test("icons: one distinct glyph per food, foods coloured by element or nature", () => {
  const shapes = FOOD_IDS.map((f) => iconSpec(`food.${f}`).shape);
  assertEquals(new Set(shapes).size, FOOD_IDS.length, "every food has its own glyph");
  for (const s of shapes) assert((FOOD_SHAPES as readonly string[]).includes(s), `${s} is a food glyph`);
  // Strong elemental foods without a natural colour take their element's colour.
  const chili = iconSpec("food.emberChili");
  assertEquals(chili.element, "fire");
  assertEquals(FOOD_ICON.emberChili.color, null);
  assert(chili.main !== iconSpec("food.springWater").main, "fire and water foods differ in colour");
});

Deno.test("icons: kinds map to their glyph families; genemon tokens, unknown ids and colour overrides", () => {
  assertEquals(iconSpec("gear.emberFang").shape, "fang");
  assertEquals(iconSpec("gear.emberFang").element, "fire");
  assertEquals(iconSpec("gear.emberFang").accent, iconSpec("food.emberChili").main, "an ivory fang carries its element on the accent");
  assert(iconSpec("egg.common").accent !== iconSpec("egg.legendary").accent, "egg spots follow rarity");
  assertEquals(iconSpec("cosmetic.crown").shape, "crown");
  assertEquals(iconSpec("cosmetic.frostGlow").main, "#9ee7ff", "a cosmetic colour effect paints the glyph");
  assertEquals(iconSpec("lure.water").element, "water");
  assertEquals(iconSpec("egg.legendary").shape, "egg");
  assertEquals(iconSpec("stone.voidShard").element, "void");
  assertEquals(iconSpec("genemon:g-abc").shape, "token");
  assertEquals(iconSpec("genemon:g-abc", { color: "#123456" }).main, "#123456");
  assertEquals(iconSpec("nope.nothing").shape, "unknown");
  assertEquals(new Set(RARITIES.map((r) => RARITY_RING[r])).size, RARITIES.length, "rarity rings are distinct");
  assertEquals(mixHex("#000000", "#ffffff", 0.5), "#808080");
});

Deno.test("icons: glyph parts stay inside the 32 px box and use known primitives", () => {
  for (const shape of ICON_SHAPES) {
    for (const p of SHAPE_PARTS[shape]) {
      assert(["circle", "ellipse", "path", "rect", "polygon"].includes(p.el), `${shape}: ${p.el}`);
      for (const k of ["cx", "cy", "x", "y"] as const) {
        const v = p.a[k];
        if (typeof v === "number") assert(v >= 0 && v <= 32, `${shape}.${k}=${v}`);
      }
    }
  }
});

Deno.test("dragFeed: effectDeltas reports hunger, bond and the axis a strong food pushes", () => {
  const g = createGenemon({ seed: 42, owner: "t", level: 8 });
  g.conditions.hunger = 0.8;
  const before = feedSnap(phenotypeOf(g), g.conditions);
  feed(g, "emberChili", 10);
  const lines = effectDeltas(before, feedSnap(phenotypeOf(g), g.conditions));
  const keys = lines.map((l) => l.key);
  assert(keys.includes("hunger"), keys.join(","));
  assert(lines.find((l) => l.key === "hunger")!.good === true, "less hunger is good");
  assert(keys.includes("bond"), keys.join(","));
  assert(keys.includes("axis.heat"), `heat axis moves: ${keys.join(",")}`);
  assertEquals(effectDeltas(before, before).length, 0, "no change -> no line");
  assert(isStaple("berries") && !isStaple("emberChili"));
  assert(usableKind("food") && usableKind("gear") && usableKind("cosmetic") && !usableKind("egg"));
});

Deno.test("market: bid and sale outcomes", () => {
  const base: Listing = {
    id: "L1", sellerId: "npc", sellerKind: "npc", itemId: "food.meat", qty: 1, startPrice: 10, buyout: null,
    currentBid: 12, bidderId: "me", createdAt: 0, endsAt: 1000, status: "open", bidCount: 1, extensions: 0,
    buyerId: null, finalPrice: null, closedAt: null,
  };
  assertEquals(bidOutcome(base, "me", 500), "leading");
  assertEquals(bidOutcome({ ...base, bidderId: "you" }, "me", 500), "outbid");
  assertEquals(bidOutcome(base, "me", 2000), "ended");
  assertEquals(bidOutcome({ ...base, status: "sold", buyerId: "me" }, "me", 2000), "won");
  assertEquals(bidOutcome({ ...base, status: "sold", buyerId: "you" }, "me", 2000), "lost");
  assertEquals(bidOutcome(null, "me", 0), "archived");
  assertEquals(saleOutcome({ ...base, currentBid: null, bidderId: null }, 500), "listed");
  assertEquals(saleOutcome(base, 500), "bidding");
  assertEquals(saleOutcome({ ...base, status: "expired" }, 2000), "expired");
});
