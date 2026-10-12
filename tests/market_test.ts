import { assert, assertAlmostEquals, assertEquals, assertThrows } from "./_assert.ts";
import { isValidEvent, Ledger } from "../src/core/ledger.ts";
import { ELEMENT_IDS } from "../src/data/elements.ts";
import { FOOD_IDS, FOODS } from "../src/data/lifestyle.ts";
import { createGenemon, phenotypeOf } from "../src/genome/genemon.ts";
import {
  appraiseGenemon,
  foodItemId,
  genemonItemId,
  ITEM_IDS,
  ITEM_KINDS,
  itemDef,
  ITEMS,
} from "../src/economy/items.ts";
import {
  ANTI_SNIPE_EXTEND_MS,
  AuctionHouse,
  COMPANIES,
  MarketError,
  type MarketErrorCode,
  NPC_TRADERS,
  type NpcAction,
} from "../src/economy/market.ts";

const MIN = 60_000;

function house(feeRate?: number, seed = 11): { ah: AuctionHouse; ledger: Ledger } {
  const ledger = new Ledger("test");
  return { ah: new AuctionHouse({ seed, ledger, feeRate }), ledger };
}

function throwsCode(fn: () => unknown, code: MarketErrorCode): void {
  let caught: unknown = null;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  assert(caught instanceof MarketError, `expected MarketError(${code}), got ${String(caught)}`);
  assertEquals(caught.code, code);
}

Deno.test("auction: post -> bid -> outbid refunds -> settles to the high bidder at expiry", () => {
  const { ah } = house();
  ah.give("alice", "potion.heal", 5, 0);
  ah.deposit("bob", 500, 0);
  ah.deposit("cara", 500, 0);
  const l = ah.post("alice", "player", "potion.heal", 5, 50, null, 10 * MIN, 0);
  assertEquals(ah.inventory("alice"), {}, "the lot is escrowed");

  ah.bid(l.id, "bob", 50, 1_000);
  assertEquals(ah.balance("bob"), 450);
  assertEquals(ah.escrowed("bob"), 50);
  throwsCode(() => ah.bid(l.id, "cara", 52, 2_000), "bid-too-low"); // min raise 5 %: 50 -> 53
  ah.bid(l.id, "cara", 53, 2_000);
  assertEquals(ah.balance("bob"), 500, "outbid bidder refunded in full");
  assertEquals(ah.escrowed("bob"), 0);
  assertEquals(ah.balance("cara"), 447);

  assertEquals(ah.tick(10 * MIN - 1).length, 0, "not over yet");
  const [s] = ah.tick(10 * MIN);
  assertEquals([s.status, s.buyerId, s.price, s.fee, s.proceeds], ["sold", "cara", 53, 3, 50]); // fee = ceil(2.65)
  assertEquals(ah.balance("alice"), 50);
  assertEquals(ah.inventory("cara"), { "potion.heal": 5 });
  assertEquals(ah.listing(l.id)?.status, "sold");
  assertEquals(ah.priceHistory("potion.heal"), [{ t: 10 * MIN, price: 10.6 }], "unit price of the lot");
  assertEquals(ah.tick(20 * MIN).length, 0, "settles exactly once");
  assert(ah.moneySupply().balanced);
});

Deno.test("buyout is immediate, refunds the leading bidder and closes the listing", () => {
  const { ah } = house();
  ah.give("alice", "cosmetic.crown", 1, 0);
  ah.deposit("bob", 1000, 0);
  ah.deposit("cara", 1000, 0);
  const l = ah.post("alice", "player", "cosmetic.crown", 1, 200, 400, 60 * MIN, 0);
  ah.bid(l.id, "bob", 200, 1_000);
  const sold = ah.buyout(l.id, "cara", 2_000);
  assertEquals([sold.status, sold.buyerId, sold.finalPrice, sold.closedAt], ["sold", "cara", 400, 2_000]);
  assertEquals(ah.balance("bob"), 1000);
  assertEquals(ah.balance("cara"), 600);
  assertEquals(ah.inventory("cara"), { "cosmetic.crown": 1 });
  assertEquals(ah.balance("alice"), 380, "400 minus the 5 % fee");
  assertEquals(ah.tick(61 * MIN).length, 0, "nothing left to settle");
  throwsCode(() => ah.buyout(l.id, "bob", 3_000), "not-open");

  // A bid at or above the buyout price is a buyout at that price (never an overpayment).
  ah.give("alice", "cosmetic.scarf", 1, 0);
  const m = ah.post("alice", "player", "cosmetic.scarf", 1, 20, 40, 60 * MIN, 0);
  const viaBid = ah.bid(m.id, "bob", 55, 3_000);
  assertEquals([viaBid.status, viaBid.finalPrice], ["sold", 40]);
  assertEquals(ah.balance("bob"), 960);
});

Deno.test("the seller fee goes to the treasury and credits are conserved", () => {
  const { ah } = house(0.1);
  ah.give("seller", "stone.prism", 1, 0);
  ah.deposit("buyer", 1000, 0);
  const l = ah.post("seller", "player", "stone.prism", 1, 100, 200, 30 * MIN, 0);
  const sold = ah.buyout(l.id, "buyer", 1_000);
  assertEquals(sold.finalPrice, 200);
  assertEquals(ah.balance("seller"), 180);
  assertEquals(ah.balance("buyer"), 800);
  const m = ah.moneySupply();
  assertEquals([m.treasury, m.wallets, m.escrow, m.minted], [20, 980, 0, 1000]);
  assert(m.balanced);
  ah.withdraw("buyer", 300, 2_000, "fixed-price shop");
  assertEquals(ah.moneySupply().withdrawn, 300);
  assert(ah.moneySupply().balanced);
  assertThrows(() => new AuctionHouse({ seed: 1, feeRate: 1 }), "a 100 % fee is refused");
});

Deno.test("promo: the discount applies to a company buyout only while the promotion runs", () => {
  const { ah } = house();
  ah.deposit("p1", 1000, 0);
  ah.deposit("p2", 1000, 0);
  const promo = { label: "Flash sale -25%", discount: 0.25, endsAt: 10 * MIN };
  const a = ah.post("co:genelab", "company", "potion.revive", 2, 120, 160, 60 * MIN, 0, promo);
  const q = ah.quote(a.id, MIN)!;
  assert(q.promoActive);
  assertEquals(q.buyout, 120);
  assertAlmostEquals(a.promo!.discount, 0.25);
  const sold = ah.buyout(a.id, "p1", MIN);
  assertEquals(sold.finalPrice, 120);
  assertEquals(ah.balance("p1"), 880);
  assertEquals(ah.balance("co:genelab"), 114, "company revenue minus fee");

  const b = ah.post("co:genelab", "company", "potion.revive", 2, 120, 160, 60 * MIN, 0, promo);
  assert(!ah.quote(b.id, 10 * MIN)!.promoActive, "promo over at its endsAt");
  ah.buyout(b.id, "p2", 11 * MIN);
  assertEquals(ah.balance("p2"), 840, "full price after the promo window");
  assertEquals(ah.inventory("co:genelab"), {}, "companies sell from infinite stock");

  ah.give("p1", "potion.heal", 1, 0);
  throwsCode(
    () => ah.post("p1", "player", "potion.heal", 1, 10, 20, 10 * MIN, 0, promo),
    "promo-company-only",
  );
  throwsCode(() => ah.post("co:fake", "company", "potion.heal", 1, 10, 20, 10 * MIN, 0), "unknown-company");
});

Deno.test("companyRestock posts flash promotions of 10-40 % with timers and respects shelf caps", () => {
  const { ah } = house();
  const posted = ah.companyRestock(0);
  assert(posted.length >= COMPANIES.length, "every company posts 1-2 lots");
  const promos = posted.filter((l) => l.promo);
  assert(promos.length >= 1, "at least one flash promotion per restock");
  for (const l of promos) {
    const p = l.promo!;
    assert(p.discount >= 0.1 && p.discount <= 0.4, `discount ${p.discount}`);
    assert(p.endsAt > 0 && p.endsAt <= l.endsAt, "promo timer inside the listing");
    assertEquals(l.sellerKind, "company");
  }
  for (let i = 1; i <= 10; i++) ah.companyRestock(i * 1_000);
  for (const co of COMPANIES) {
    const open = ah.listings({ sellerId: co.id, status: "open" });
    assert(open.length <= co.maxOpen, `${co.id} over its shelf cap`);
    assert(
      open.every((l) => co.kinds.includes(itemDef(l.itemId)!.kind)),
      `${co.id} sells its own kinds only`,
    );
  }
  assert(ah.listings({ kind: "food", sellerKind: "company" }).length > 0, "the supermarket stocks food");

  // Small restocks (one free shelf slot) must still carry a promotion: the guarantee, not luck.
  ah.deposit("whale", 10_000_000, 20_000);
  for (let i = 0; i < 20; i++) {
    const t = 30_000 + i * 1_000;
    const open = ah.listings({ sellerKind: "company", status: "open" });
    ah.buyout(open[i % open.length].id, "whale", t);
    const small = ah.companyRestock(t);
    assert(small.length >= 1 && small.length <= 2, `restock ${i} posted ${small.length}`);
    assert(small.some((l) => l.promo), `restock ${i} has no promotion`);
  }

  // Infinite stock both ways: an unsold company lot just disappears, it never lands in an inventory.
  const expired = ah.tick(24 * 3_600_000).filter((s) => s.status === "expired" && s.sellerKind === "company");
  assert(expired.length > 0, "some company lots expire unsold");
  for (const co of COMPANIES) assertEquals(ah.inventory(co.id), {}, `${co.id} inventory`);
});

Deno.test("anti-sniping: a bid in the last 30 s extends the auction by 30 s", () => {
  const { ah } = house();
  ah.give("s", "map.nest", 1, 0);
  ah.deposit("b1", 1000, 0);
  ah.deposit("b2", 1000, 0);
  const l = ah.post("s", "player", "map.nest", 1, 100, null, 10 * MIN, 0);
  const end = l.endsAt;
  const early = ah.bid(l.id, "b1", 100, end - 60_000);
  assertEquals([early.endsAt, early.extensions], [end, 0], "no extension outside the window");
  const late = ah.bid(l.id, "b2", 105, end - 10_000);
  assertEquals([late.endsAt, late.extensions], [end + ANTI_SNIPE_EXTEND_MS, 1]);
  assertEquals(ah.tick(end).length, 0, "still open at the original end");
  throwsCode(() => ah.bid(l.id, "b1", 110, end + 20_000), "bid-too-low"); // 105 -> 111
  const again = ah.bid(l.id, "b1", 111, end + 20_000);
  assertEquals(again.endsAt, end + 2 * ANTI_SNIPE_EXTEND_MS, "each late bid extends again");
  const [s] = ah.tick(end + 2 * ANTI_SNIPE_EXTEND_MS);
  assertEquals([s.buyerId, s.price, s.at], ["b1", 111, end + 2 * ANTI_SNIPE_EXTEND_MS]);
  throwsCode(() => ah.bid(l.id, "b2", 200, end + 3 * ANTI_SNIPE_EXTEND_MS), "not-open");
});

Deno.test("bidding or buying out your own listing is rejected and logged", () => {
  const { ah, ledger } = house();
  ah.give("s", "egg.rare", 1, 0);
  ah.deposit("s", 1000, 0);
  const l = ah.post("s", "player", "egg.rare", 1, 300, 450, 10 * MIN, 0);
  throwsCode(() => ah.bid(l.id, "s", 300, 1_000), "own-listing");
  throwsCode(() => ah.buyout(l.id, "s", 1_000), "own-listing");
  assertEquals(ah.balance("s"), 1000);
  assertEquals(ah.listing(l.id)?.currentBid, null);
  const rejects = ledger.query({ what: "market.reject" });
  assertEquals(rejects.map((r) => r.entries.code), ["own-listing", "own-listing"]);
  assertEquals(rejects[0].who, "s");
  throwsCode(() => ah.bid(l.id, "npc:penny", 300, 1_000), "impersonation");
  throwsCode(() => ah.post("npc:magpie", "player", "egg.rare", 1, 1, null, 10 * MIN, 0), "impersonation");
});

Deno.test("insufficient funds are rejected without side effects; escrowed credits stay locked", () => {
  const { ah } = house();
  ah.give("s", "flag.iron", 1, 0);
  ah.give("s", "flag.wood", 1, 0);
  ah.deposit("poor", 50, 0);
  const l = ah.post("s", "player", "flag.iron", 1, 100, 300, 10 * MIN, 0);
  throwsCode(() => ah.bid(l.id, "poor", 100, 1_000), "insufficient-funds");
  throwsCode(() => ah.buyout(l.id, "poor", 1_000), "insufficient-funds");
  assertEquals(ah.balance("poor"), 50);
  assertEquals([ah.listing(l.id)?.currentBid, ah.listing(l.id)?.status], [null, "open"]);

  ah.deposit("mid", 150, 0);
  ah.bid(l.id, "mid", 100, 1_000);
  const l2 = ah.post("s", "player", "flag.wood", 1, 60, null, 10 * MIN, 0);
  throwsCode(() => ah.bid(l2.id, "mid", 60, 1_000), "insufficient-funds"); // 50 free, 100 escrowed
  ah.bid(l.id, "mid", 140, 2_000); // raising your own lead only needs the difference
  assertEquals([ah.balance("mid"), ah.escrowed("mid")], [10, 140]);
  throwsCode(() => ah.withdraw("mid", 11, 2_000), "insufficient-funds");
});

Deno.test("cancel only without bids; expired and cancelled lots go back to the seller", () => {
  const { ah } = house();
  ah.give("s", "ticket.arenaGold", 2, 0);
  ah.deposit("b", 1000, 0);
  const a = ah.post("s", "player", "ticket.arenaGold", 1, 300, null, 5 * MIN, 0);
  const b = ah.post("s", "player", "ticket.arenaGold", 1, 300, null, 5 * MIN, 0);
  throwsCode(
    () => ah.post("s", "player", "ticket.arenaGold", 1, 300, null, 5 * MIN, 0),
    "insufficient-items",
  );
  ah.bid(b.id, "b", 300, 1_000);
  throwsCode(() => ah.cancel(b.id, "s", 2_000), "has-bids");
  throwsCode(() => ah.cancel(a.id, "b", 2_000), "not-seller");
  assertEquals(ah.cancel(a.id, "s", 2_000).status, "cancelled");
  assertEquals(ah.inventory("s"), { "ticket.arenaGold": 1 });
  const d = ah.post("s", "player", "ticket.arenaGold", 1, 300, null, 5 * MIN, 3_000);
  const settled = ah.tick(d.endsAt);
  assertEquals(settled.map((x) => x.status), ["sold", "expired"]);
  assertEquals(ah.inventory("s"), { "ticket.arenaGold": 1 });
  assertEquals(ah.inventory("b"), { "ticket.arenaGold": 1 });
  assertEquals(ah.listings({ status: "expired" }).map((x) => x.id), [d.id]);
});

function npcRun(seed: number, restock: boolean): { json: string; actions: NpcAction[]; balanced: boolean } {
  const ledger = new Ledger("npc");
  const ah = new AuctionHouse({ seed, ledger });
  // A seed-independent shelf of player lots, so without restocks only the NPC streams differ.
  const lots: [string, number, number, number][] = [
    ["food.meat", 10, 60, 100],
    ["potion.heal", 4, 30, 52],
    ["cosmetic.crown", 1, 300, 420],
    ["egg.rare", 1, 240, 330],
    ["lure.void", 2, 150, 260],
    ["stone.prism", 1, 220, 300],
  ];
  for (const [item, qty, start, buyout] of lots) {
    ah.give("p", item, qty, 0);
    ah.post("p", "player", item, qty, start, buyout, 30 * MIN, 0);
  }
  const actions: NpcAction[] = [];
  for (let r = 0; r < 12; r++) {
    const t = r * 10 * MIN;
    if (restock) ah.companyRestock(t);
    actions.push(...ah.npcActivity(t + 1_000));
    ah.tick(t + 2_000);
  }
  return {
    json: JSON.stringify({ actions, rows: ledger.rows(), listings: ah.listings(), supply: ah.moneySupply() }),
    actions,
    balanced: ah.moneySupply().balanced,
  };
}

Deno.test("NPC activity is deterministic for a seed and differs for another seed", () => {
  const a = npcRun(7, false), b = npcRun(7, false), c = npcRun(8, false);
  assert(a.json === b.json, "the same seed must replay byte-identically");
  assert(a.json !== c.json, "another seed must give other NPC decisions (restocks are off here)");
  assert(a.actions.some((x) => x.action === "bid" || x.action === "buyout"), "NPCs never bought or bid");
});

Deno.test("NPC market loop: four personalities, at least three trade, credits conserved", () => {
  const a = npcRun(7, true), c = npcRun(8, true);
  assert(a.json === npcRun(7, true).json, "full loop replays identically");
  const did = new Set(a.actions.map((x) => x.action));
  for (const k of ["refill", "gather", "post", "bid", "buyout"] as const) {
    assert(did.has(k), `no ${k} action`);
  }
  const traders = new Set(a.actions.filter((x) => x.action !== "refill").map((x) => x.personality));
  assert(traders.size >= 3, `only ${[...traders].join(",")} acted`);
  assertEquals(new Set(NPC_TRADERS.map((n) => n.personality)).size, 4);
  assert(a.balanced && c.balanced, "credits conserved through NPC trading");
});

Deno.test("the flipper snipes an underpriced auction near its end, wins it and relists at a margin", () => {
  const { ah } = house();
  ah.give("p", "lure.void", 1, 0);
  const l = ah.post("p", "player", "lure.void", 1, 50, null, 10 * MIN, 0);
  const early = ah.npcActivity(MIN);
  assert(
    !early.some((a) => a.npcId === "npc:flint" && a.action === "bid"),
    "the flipper waits for the last 2 minutes",
  );
  const late = ah.npcActivity(l.endsAt - 20_000);
  assert(late.some((a) => a.npcId === "npc:flint" && a.action === "bid"), "the flipper snipes");
  const after = ah.listing(l.id)!;
  assert(after.extensions >= 1 && after.endsAt > l.endsAt, "the house extended the sniped auction");
  assertEquals(after.bidderId, "npc:flint");
  const [s] = ah.tick(after.endsAt);
  assertEquals([s.status, s.buyerId], ["sold", "npc:flint"]);
  const relist = ah.npcActivity(after.endsAt + 1_000).find((a) =>
    a.npcId === "npc:flint" && a.action === "post"
  );
  assert(relist !== undefined && relist.itemId === "lure.void", "bought stock is relisted");
  assert(relist.amount > s.price, `relisted at ${relist.amount} over the ${s.price} paid`);
});

Deno.test("ledger: every market action emits a valid flat row in the market space", () => {
  const ledger = new Ledger("rows");
  const ah = new AuctionHouse({ seed: 3, ledger });
  ah.deposit("p1", 2000, 0);
  ah.deposit("p2", 2000, 0);
  ah.give("p1", "lure.fire", 3, 0);
  ah.give("p1", "map.tornTreasure", 1, 0);
  const a = ah.post("p1", "player", "lure.fire", 3, 60, 90, 5 * MIN, 0);
  ah.bid(a.id, "p2", 60, 1_000);
  const b = ah.post("p1", "player", "map.tornTreasure", 1, 80, null, 5 * MIN, 0);
  ah.cancel(b.id, "p1", 1_000);
  const c = ah.post("p1", "player", "map.tornTreasure", 1, 80, 120, 5 * MIN, 1_000);
  try {
    ah.bid(c.id, "p1", 80, 2_000);
  } catch { /* logged rejection */ }
  ah.companyRestock(2_000);
  ah.npcActivity(3_000);
  const promo = ah.listings({ sellerKind: "company", status: "open" }).find((l) => l.promo);
  if (promo) ah.buyout(promo.id, "p2", 4_000);
  ah.tick(6 * MIN + 1_000);
  ah.take("p2", "lure.fire", 1, 7 * MIN, "used in the world");

  const rows = ledger.rows();
  assert(rows.length > 20);
  for (const row of rows) {
    assert(isValidEvent(row), `invalid row ${JSON.stringify(row)}`);
    assertEquals([row.where.space, row.where.zone], ["market", "auction-house"]);
    assert(row.what.startsWith("market."), row.what);
    assert(row.why.length > 0 && row.who.length > 0, `missing who/why on ${row.what}`);
    for (const v of [...Object.values(row.entries), ...Object.values(row.exits)]) {
      assert(typeof v !== "number" || Number.isFinite(v), `non-finite payload on ${row.what}`);
    }
  }
  const whats = new Set(rows.map((r) => r.what));
  for (
    const w of [
      "deposit",
      "give",
      "take",
      "post",
      "bid",
      "buyout",
      "cancel",
      "sold",
      "expired",
      "reject",
      "company.restock",
      "npc.round",
    ]
  ) {
    assert(whats.has(`market.${w}`), `no market.${w} row`);
  }
});

Deno.test("catalogue: every food at its list price plus 30+ items across every kind", () => {
  for (const id of FOOD_IDS) {
    const d = ITEMS[foodItemId(id)];
    assert(d !== undefined, id);
    assertEquals([d.kind, d.basePrice, d.effects.food], ["food", FOODS[id].price, id]);
  }
  assert(ITEM_IDS.filter((id) => ITEMS[id].kind !== "food").length >= 30);
  for (const k of ITEM_KINDS) {
    if (k !== "genemon") assert(ITEM_IDS.some((id) => ITEMS[id].kind === k), `no ${k}`);
  }
  for (const el of ELEMENT_IDS) assertEquals(ITEMS[`lure.${el}`]?.effects.element, el);
  for (const id of ITEM_IDS) {
    const d = ITEMS[id];
    assertEquals(d.id, id);
    assert(Number.isInteger(d.basePrice) && d.basePrice > 0, `${id} price`);
    assert(
      Object.values(d.effects).every((v) => typeof v === "number" || typeof v === "string"),
      `${id} effects`,
    );
  }
  assertEquals(ITEMS["stone.voidShard"].effects.mutate, 0.3);
  assertEquals(ITEMS["stone.fusionCore"].effects.fuse, 1);
  assertEquals(itemDef("constructor"), undefined, "prototype keys never resolve");
  assertEquals(itemDef(genemonItemId("g-1"))?.kind, "genemon");
  assertThrows(() => genemonItemId(""));
});

Deno.test("genemon: appraisal grows with level and pedigree; a genemon item is unique", () => {
  const young = createGenemon({ seed: 42, level: 5 });
  const old = createGenemon({ seed: 42, level: 40 });
  const pYoung = appraiseGenemon(phenotypeOf(young));
  const pOld = appraiseGenemon(phenotypeOf(old));
  assert(Number.isInteger(pYoung) && pYoung >= 10);
  assert(pOld > pYoung, `level 40 (${pOld}) must out-price level 5 (${pYoung})`);
  assert(appraiseGenemon(phenotypeOf(young), { generation: 3 }) > pYoung, "pedigree premium");
  assertEquals(appraiseGenemon(phenotypeOf(young)), pYoung, "deterministic");

  const { ah } = house();
  const def = ah.registerGenemon(old.id, phenotypeOf(old), { name: old.name, now: 0 });
  assertEquals([def.id, def.kind, def.basePrice, def.stackable], [
    genemonItemId(old.id),
    "genemon",
    pOld,
    false,
  ]);
  ah.give("owner", def.id, 1, 0);
  throwsCode(() => ah.give("thief", def.id, 1, 0), "duplicate-unique");
  throwsCode(() => ah.post("owner", "player", def.id, 2, 100, null, 30 * MIN, 0), "not-stackable");
  throwsCode(() => ah.post("co:genelab", "company", def.id, 1, 100, null, 30 * MIN, 0), "forbidden");
  const l = ah.post("owner", "player", def.id, 1, def.basePrice, null, 30 * MIN, 0);
  assertEquals(ah.quote(l.id, 0)?.fair, pOld);
  assertEquals(ah.listings({ kind: "genemon" }).length, 1);
});

Deno.test("price stats: median, mean, realised volatility, volume; fair value is anchored", () => {
  const { ah } = house(0);
  ah.give("s", "food.honey", 30, 0);
  ah.deposit("b", 20_000, 0);
  const sell = (qty: number, price: number, t: number) => {
    const l = ah.post("s", "player", "food.honey", qty, price, price, 10 * MIN, t);
    ah.buyout(l.id, "b", t + 1);
  };
  sell(1, 7, 0);
  sell(2, 16, 10);
  sell(1, 9, 20);
  assertEquals(ah.priceHistory("food.honey").map((p) => p.price), [7, 8, 9]);
  const st = ah.stats("food.honey");
  assertEquals([st.median, st.mean, st.volume, st.last, st.trades], [8, 8, 4, 9, 3]);
  assertAlmostEquals(st.volatility, 0.126, 1e-9); // sqrt((ln(8/7)^2 + ln(9/8)^2) / 2)
  assertEquals(ah.stats("food.honey", 15).trades, 1, "since filter");
  assertEquals(ah.stats("food.candy").median, null, "no trades -> no price");

  for (let i = 0; i < 20; i++) sell(1, 500, 100 + i * 10); // a pump far above list (7)
  assert(ah.fairValue("food.honey") <= 3 * FOODS.honey.price, "pumped median is clamped to 3x list");
  assert(ah.fairValue("food.honey") > FOODS.honey.price, "but the market still moves it");
});

Deno.test("wash trading: a back-and-forth player pair is flagged, ordinary trades are not", () => {
  const { ah } = house();
  for (const p of ["w1", "w2", "honest"]) ah.deposit(p, 5000, 0);
  ah.give("w1", "cosmetic.crown", 1, 0);
  ah.give("seller", "potion.heal", 1, 0);
  let owner = "w1", other = "w2";
  for (let i = 0; i < 4; i++) {
    const l = ah.post(owner, "player", "cosmetic.crown", 1, 1000, 1050, 10 * MIN, i * 1_000);
    ah.buyout(l.id, other, i * 1_000 + 500);
    [owner, other] = [other, owner];
  }
  const h = ah.post("seller", "player", "potion.heal", 1, 10, 12, 10 * MIN, 0);
  ah.buyout(h.id, "honest", 100);
  const sig = ah.washTradeSignals();
  assertEquals(sig.length, 1);
  assertEquals([sig[0].a, sig[0].b, sig[0].trades, sig[0].roundTrips, sig[0].offMarket], [
    "w1",
    "w2",
    4,
    3,
    4,
  ]);
  assertAlmostEquals(sig[0].score, 1);
});
