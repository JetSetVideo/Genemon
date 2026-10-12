import { assert, assertEquals, assertThrows } from "./_assert.ts";
import { isValidEvent, Ledger } from "../src/core/ledger.ts";
import { createGenemon, phenotypeOf } from "../src/genome/genemon.ts";
import { genemonItemId, ITEM_IDS } from "../src/economy/items.ts";
import {
  AuctionHouse,
  type AuctionHouseData,
  MarketError,
  type MarketErrorCode,
} from "../src/economy/market.ts";
import { type Profile, ProfileStore } from "../src/ui/profile.ts";
import {
  catchUpPlan,
  compactHouseData,
  ESCROW_KEY,
  formatCountdown,
  MARKET_ERROR_TEXT,
  MARKET_KEY,
  marketErrorText,
  MarketStore,
  MAX_CATCHUP_ROUNDS,
  ROUND_MS,
  type StorageLike,
} from "../src/ui/marketStore.ts";

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 12, 9, 0, 0);

/** localStorage stand-in (Storage-shaped so ProfileStore accepts it too). */
class MemoryStorage implements StorageLike {
  #m = new Map<string, string>();
  get length(): number {
    return this.#m.size;
  }
  key(i: number): string | null {
    return [...this.#m.keys()][i] ?? null;
  }
  getItem(k: string): string | null {
    return this.#m.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.#m.set(k, String(v));
  }
  removeItem(k: string): void {
    this.#m.delete(k);
  }
  clear(): void {
    this.#m.clear();
  }
}

interface World {
  storage: MemoryStorage;
  profiles: ProfileStore;
  max: Profile;
  claude: Profile;
  ledger: Ledger;
  market: MarketStore;
}

/** A device with the two default profiles ("you and me") and a market on the same storage. */
function world(seed = 7, warmupRounds?: number): World {
  const storage = new MemoryStorage();
  const profiles = new ProfileStore(storage as unknown as Storage, T0);
  const [max, claude] = profiles.list();
  const ledger = new Ledger("store");
  const market = new MarketStore(storage, profiles, T0, { ledger, seed, warmupRounds });
  return { storage, profiles, max, claude, ledger, market };
}

/** A Genemon of the profile that is not in its team (what the Sell tab offers). */
function spare(p: Profile, skip = 0) {
  const g = p.collection.filter((x) => !p.team.includes(x.id))[skip];
  assert(g !== undefined, `${p.name} has no spare Genemon #${skip}`);
  return g;
}

function savedProfile(storage: MemoryStorage, id: string): Profile {
  return JSON.parse(storage.getItem(`genemon.profile.${id}`)!) as Profile;
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

/** A house with every kind of state: wallets, escrowed items + credits, a Genemon, promos, history. */
function busyHouse(ledger?: Ledger): { ah: AuctionHouse; heal: string; gem: string } {
  const ah = new AuctionHouse({ seed: 99, ledger });
  ah.deposit("p1", 5_000, 0);
  ah.deposit("p2", 3_000, 0);
  ah.give("p1", "potion.heal", 6, 0);
  ah.give("p1", "cosmetic.crown", 1, 0);
  const g = createGenemon({ seed: 5, level: 30 });
  const def = ah.registerGenemon(g.id, phenotypeOf(g), { name: g.name, generation: 1, mutations: 2, now: 0 });
  ah.give("p1", def.id, 1, 0);
  const heal = ah.post("p1", "player", "potion.heal", 6, 60, 90, 180 * MIN, 0);
  ah.bid(heal.id, "p2", 60, 1_000);
  ah.post("p1", "player", def.id, 1, def.basePrice, null, 60 * MIN, 0);
  for (let r = 0; r < 8; r++) {
    const t = r * 5 * MIN;
    ah.companyRestock(t);
    ah.npcActivity(t + 1);
    ah.tick(t + 2);
  }
  const promo = ah.listings({ sellerKind: "company", status: "open" }).find((l) => l.promo);
  if (promo) ah.buyout(promo.id, "p2", 36 * MIN);
  return { ah, heal: heal.id, gem: def.id };
}

/** Rows without the per-ledger id/seq, so two ledgers can be compared. */
const rowsOf = (L: Ledger, from = 0) =>
  JSON.stringify(L.rows().slice(from).map(({ id: _i, seq: _s, ...r }) => r));

Deno.test("toJSON/fromJSON: balances, listings, inventories, escrow and the future survive a roundtrip", () => {
  const ledgerA = new Ledger("r");
  const { ah, heal, gem } = busyHouse(ledgerA);
  const json = JSON.stringify(ah);
  const copy = AuctionHouse.fromJSON(JSON.parse(json), { ledger: new Ledger("r") });
  assertEquals(JSON.stringify(copy), json, "re-snapshot is byte-identical");

  const owners = [
    "p1",
    "p2",
    "house",
    "npc:penny",
    "npc:magpie",
    "npc:flint",
    "npc:moss",
    "co:freshmart",
    "co:genelab",
  ];
  for (const id of owners) {
    assertEquals(copy.balance(id), ah.balance(id), `${id} balance`);
    assertEquals(copy.escrowed(id), ah.escrowed(id), `${id} escrow`);
    assertEquals(copy.inventory(id), ah.inventory(id), `${id} inventory`);
  }
  assert(ah.balance("p2") > 0 && ah.escrowed("p2") === 60, "the bid is escrowed");
  assertEquals(copy.listings(), ah.listings());
  assertEquals(copy.listing(heal)?.bidderId, "p2");
  assertEquals(copy.listings({ itemId: gem, status: "open" }).length, 1, "the Genemon lot is still escrowed");
  assertEquals(copy.moneySupply(), ah.moneySupply());
  assert(copy.moneySupply().balanced);
  for (const id of [...ITEM_IDS, gem]) {
    assertEquals(copy.fairValue(id), ah.fairValue(id), `${id} fair value`);
    assertEquals(copy.stats(id), ah.stats(id), `${id} stats`);
  }
  assertEquals(copy.quote(heal, 2_000), ah.quote(heal, 2_000));
  assertEquals(copy.washTradeSignals(1), ah.washTradeSignals(1));
  throwsCode(() => copy.give("p3", gem, 1, 0), "duplicate-unique");

  // Same future on both: same listing ids, same NPC and restock streams, same ledger rows.
  const ledgerB = new Ledger("r");
  const restored = AuctionHouse.fromJSON(JSON.parse(json), { ledger: ledgerB });
  const mark = ledgerA.rows().length;
  const future = (h: AuctionHouse) => {
    for (let r = 8; r < 20; r++) {
      const t = r * 5 * MIN;
      h.companyRestock(t);
      h.npcActivity(t + 1);
      h.tick(t + 2);
    }
    const open = h.listings({ sellerKind: "company", status: "open" })[0];
    h.bid(open.id, "p1", h.quote(open.id, 101 * MIN)!.minBid, 101 * MIN);
    return JSON.stringify(h);
  };
  assertEquals(future(restored), future(ah), "continues byte-identically");
  assertEquals(rowsOf(ledgerB), rowsOf(ledgerA, mark), "and logs the same rows");
  assertEquals(ledgerB.query({ what: /^market\./ }).length > 0, true);

  // Malformed snapshots are refused, naming the faulty path.
  const good = JSON.parse(json) as AuctionHouseData;
  assertThrows(() => AuctionHouse.fromJSON(null), "null");
  assertThrows(() => AuctionHouse.fromJSON({ ...good, v: 2 }), "unknown version");
  assertThrows(() => AuctionHouse.fromJSON({ ...good, seq: 1 }), "listing counter behind existing ids");
  assertThrows(() => AuctionHouse.fromJSON({ ...good, wallets: [["p1", -5]] }), "negative wallet");
  assertThrows(
    () => AuctionHouse.fromJSON({ ...good, closed: good.closed.slice(1) }),
    "archive queue incomplete",
  );
  let msg = "";
  try {
    AuctionHouse.fromJSON({
      ...good,
      listings: [{ ...good.listings[0], qty: 0 }, ...good.listings.slice(1)],
    });
  } catch (e) {
    msg = String(e);
  }
  assert(msg.includes("listings[0].qty"), `error names the path: ${msg}`);
});

Deno.test("offline catch-up: 5-minute rounds since the last visit, deterministic, capped at 48", () => {
  // The plan is a pure function of (lastRound, now).
  assertEquals(catchUpPlan(0, ROUND_MS - 1).times, []);
  assertEquals(catchUpPlan(0, 3 * ROUND_MS + 7).times, [ROUND_MS, 2 * ROUND_MS, 3 * ROUND_MS]);
  const far = catchUpPlan(0, 1000 * ROUND_MS + 123);
  assertEquals(far.times.length, MAX_CATCHUP_ROUNDS);
  assertEquals([far.times[0], far.times[47], far.due, far.skipped], [
    953 * ROUND_MS,
    1000 * ROUND_MS,
    1000,
    952,
  ]);
  assertEquals(far.nextLastRound, 1000 * ROUND_MS, "skipped rounds are not owed again");
  assertEquals(catchUpPlan(5 * ROUND_MS, 2 * ROUND_MS).times, [], "a clock that went back runs nothing");

  const T1 = T0 + 10 * 24 * 3_600_000 + 4 * MIN; // ten days away
  const device = () => {
    const w = world(7);
    const first = w.market.visit(w.max, T0); // a new market warms up on the last 48 rounds
    const reopened = new MarketStore(w.storage, w.profiles, T1, { ledger: w.ledger });
    const back = reopened.visit(w.max, T1);
    const quiet = reopened.visit(w.max, T1 + 1_000);
    return { first, back, quiet, json: w.storage.getItem(MARKET_KEY)!, house: reopened.house };
  };
  const a = device(), b = device();
  assertEquals(a.first.rounds, MAX_CATCHUP_ROUNDS, "warm-up");
  assertEquals([a.back.rounds, a.back.skipped], [MAX_CATCHUP_ROUNDS, 10 * 24 * 12 - MAX_CATCHUP_ROUNDS]);
  assertEquals(a.quiet.rounds, 0, "no round is due one second later");
  assertEquals(a.json, b.json, "same saved market + same clock = byte-identical market");
  const saved = JSON.parse(a.json) as { lastRound: number; house: AuctionHouseData };
  assertEquals([saved.house.restocks, saved.house.npcRounds], [96, 96], "exactly 48 + 48 rounds ran");
  assertEquals(
    (T1 - saved.lastRound) < ROUND_MS && (saved.lastRound - (T0 - 48 * ROUND_MS)) % ROUND_MS === 0,
    true,
  );
  assert(a.house.listings({ sellerKind: "company", status: "open" }).length > 0, "shelves are stocked");
  assert(a.house.moneySupply().balanced, "credits conserved through the catch-up");

  // Another seed (same clock) gives another market: the seed lives in the saved snapshot.
  const w7 = world(7), w8 = world(8);
  w7.market.visit(w7.max, T0);
  w8.market.visit(w8.max, T0);
  assert(
    JSON.stringify(w7.market.house.listings()) !== JSON.stringify(w8.market.house.listings()),
    "seed matters",
  );
  assertEquals((JSON.parse(w8.storage.getItem(MARKET_KEY)!) as { house: AuctionHouseData }).house.seed, 8);
});

Deno.test("wallet: the first visit deposits the profile's credits once; the house balance is mirrored", () => {
  const w = world(7);
  w.market.visit(w.max, T0);
  w.market.visit(w.max, T0 + 1_000);
  w.market.live(w.max, T0 + 2_000);
  const deposits = () => w.ledger.query({ what: "market.deposit", who: w.max.id });
  assertEquals(deposits().length, 1);
  assertEquals(deposits()[0].entries.credits, 500);
  assertEquals([w.market.balance(w.max.id), w.max.credits], [500, 500]);
  assert(w.market.walletOpen(w.max.id) && !w.market.walletOpen(w.claude.id), "Claude has not visited yet");

  // The flag is persisted: reopening the device (page reload) does not deposit again.
  const profiles = new ProfileStore(w.storage as unknown as Storage, T0);
  const reopened = new MarketStore(w.storage, profiles, T0 + 3_000, { ledger: w.ledger });
  const max = profiles.get(w.max.id)!;
  assertEquals(reopened.visit(max, T0 + 3_000).opened, null);
  assertEquals(deposits().length, 1, "still one opening deposit");

  // Credits earned elsewhere (a quest reward written to profile.credits) are banked, not overwritten.
  max.credits += 120;
  reopened.visit(max, T0 + 4_000);
  assertEquals([reopened.balance(max.id), max.credits], [620, 620]);
  assertEquals(savedProfile(w.storage, max.id).credits, 620, "mirrored credits are saved");

  // Claude's own first visit is its own single deposit.
  const claude = profiles.get(w.claude.id)!;
  assertEquals(reopened.visit(claude, T0 + 5_000).opened, 500);
  assertEquals(reopened.visit(claude, T0 + 6_000).opened, null);
  assert(reopened.house.moneySupply().balanced);
});

Deno.test("selling a Genemon takes it out of the collection and the team and escrows its JSON", () => {
  const w = world(7);
  const { market, max, storage } = w;
  market.visit(max, T0);
  const g = spare(max);
  const before = max.collection.length;
  const l = market.sellGenemon(max, g.id, 100, 300, 10 * MIN, T0 + 1_000);
  assertEquals([l.status, l.itemId, l.sellerKind], ["open", genemonItemId(g.id), "player"]);
  assert(!max.collection.some((x) => x.id === g.id), "left the collection");
  assertEquals(max.collection.length, before - 1);
  assertEquals(market.inventory(max.id)[genemonItemId(g.id)], undefined, "the house holds it in the lot");
  const escrow = JSON.parse(storage.getItem(ESCROW_KEY)!) as { listingId: string; genemon: { id: string } }[];
  assertEquals(escrow.map((e) => [e.listingId, e.genemon.id]), [[l.id, g.id]], "its JSON waits in escrow");
  assert(!savedProfile(storage, max.id).collection.some((x) => x.id === g.id), "saved without it");
  assertEquals(market.describe(l.itemId)?.name, g.name, "appraised under its own name");
  assert((market.describe(l.itemId)?.basePrice ?? 0) >= 10);

  // A team member listed through the store also leaves the team (the Sell tab only offers spares).
  const lead = max.team[0];
  market.sellGenemon(max, lead, 50, null, MIN, T0 + 2_000);
  assert(!max.team.includes(lead) && !max.collection.some((x) => x.id === lead));
  assertEquals(market.escrowedGenemon(max.id).length, 2);

  // Bad terms are refused before anything moves; the last Genemon can never be sold.
  const h = spare(max, 1);
  throwsCode(() => market.sellGenemon(max, h.id, 100, 50, 10 * MIN, T0 + 3_000), "invalid-amount");
  throwsCode(() => market.sellGenemon(max, h.id, 100, null, 1_000, T0 + 3_000), "invalid-duration");
  assert(max.collection.some((x) => x.id === h.id), "still in the collection after a refusal");
  assertEquals(
    w.ledger.query({ what: /^market\.(give|genemon\.appraise)$/ }).filter((r) =>
      r.entries.itemId === genemonItemId(h.id) || r.entries.genemonId === h.id
    ).length,
    0,
    "nothing was appraised or handed to the house",
  );
  throwsCode(() => market.sellGenemon(max, "g-nope", 100, null, 10 * MIN, T0 + 3_000), "insufficient-items");
  const lonely = { ...max, collection: [h], team: [] } as Profile;
  throwsCode(() => market.sellGenemon(lonely, h.id, 100, null, 10 * MIN, T0 + 3_000), "forbidden");
});

Deno.test("a local buyer receives the Genemon on buyout, after a reload, and can resell it", () => {
  const w = world(7);
  w.market.visit(w.max, T0);
  const g = spare(w.max);
  const l = w.market.sellGenemon(w.max, g.id, 100, 200, 60 * MIN, T0 + 1_000);

  // Page reload: fresh profile cache and market from the same storage.
  const profiles = new ProfileStore(w.storage as unknown as Storage, T0);
  const market = new MarketStore(w.storage, profiles, T0 + 2_000, { ledger: w.ledger });
  const claude = profiles.get(w.claude.id)!;
  market.visit(claude, T0 + 2_000);
  const sold = market.buyout(claude, l.id, T0 + 3_000);
  assertEquals([sold.status, sold.buyerId, sold.finalPrice], ["sold", claude.id, 200]);

  const got = claude.collection.find((x) => x.id === g.id);
  assert(got !== undefined, "delivered to the buyer's collection");
  assertEquals(got.owner, claude.id);
  assert(claude.pokedex.includes(g.genome.id), "and to the pokedex");
  assertEquals(claude.credits, 300, "500 - 200");
  const max = profiles.get(w.max.id)!;
  assertEquals(max.credits, 690, "500 + 200 - 10 fee, mirrored on the seller's profile too");
  assert(!max.collection.some((x) => x.id === g.id));
  assert(
    savedProfile(w.storage, claude.id).collection.some((x) => x.id === g.id),
    "the buyer's profile is saved",
  );
  assertEquals(savedProfile(w.storage, max.id).credits, 690, "the seller's profile is saved");
  assertEquals(w.storage.getItem(ESCROW_KEY), null, "escrow emptied");
  assertEquals(market.inventory(claude.id)[l.itemId], undefined, "it lives in the collection, not the house");
  const delivered = w.ledger.query({ what: "market.genemon.delivered" });
  assertEquals(delivered.map((r) => [r.who, r.entries.genemonId]), [[claude.id, g.id]]);
  assert(w.ledger.query({ tag: "store" }).every((r) => isValidEvent(r) && r.where.space === "market"));

  // The new owner can list it again (the unique item was released on delivery).
  const again = market.sellGenemon(claude, g.id, 150, null, 10 * MIN, T0 + 4_000);
  assertEquals([again.status, again.sellerId], ["open", claude.id]);
  assert(market.house.moneySupply().balanced);
});

Deno.test("cancel and expiry return the Genemon to the seller; an NPC buyer takes it off the device", () => {
  const w = world(7);
  const { market, max } = w;
  market.visit(max, T0);
  const a = spare(max), b = spare(max, 1);

  const la = market.sellGenemon(max, a.id, 100, null, 10 * MIN, T0 + 1_000);
  const cancelled = market.cancel(max, la.id, T0 + 2_000);
  assertEquals(cancelled.status, "cancelled");
  assert(max.collection.some((x) => x.id === a.id), "back after cancel");
  assert(!max.team.includes(a.id), "back in the collection, not the team");
  assertEquals(market.inventory(max.id)[la.itemId], undefined, "nothing left at the house");
  assertEquals(w.ledger.query({ what: "market.genemon.returned" }).length, 1);

  // Priced far beyond any NPC budget, a 1-minute lot expires and comes back on the next visit.
  const lb = market.sellGenemon(max, b.id, 9_000_000, null, MIN, T0 + 3_000);
  market.visit(max, T0 + 3_000 + MIN + 1);
  assertEquals(market.house.listing(lb.id)?.status, "expired");
  assert(max.collection.some((x) => x.id === b.id), "back after expiry");
  assertEquals(market.escrowedGenemon().length, 0);
  assert(savedProfile(w.storage, max.id).collection.some((x) => x.id === b.id), "and saved");

  // A cheap appraised Genemon on a quiet market: Magpie the collector buys it and it departs.
  const q = world(11, 0);
  q.market.visit(q.max, T0);
  const c = spare(q.max);
  const lc = q.market.sellGenemon(q.max, c.id, 10, 20, 24 * 60 * MIN, T0 + 1_000);
  let t = T0 + 1_000;
  for (let i = 0; i < 60 && q.market.house.listing(lc.id)?.status === "open"; i++) {
    t += 61_000;
    q.market.live(q.max, t);
  }
  const after = q.market.house.listing(lc.id)!;
  assertEquals(after.status, "sold");
  assert(after.buyerId !== null && after.buyerId.startsWith("npc:"), `bought by ${after.buyerId}`);
  const gone = q.ledger.query({ what: "market.genemon.departed" });
  assertEquals(gone.map((r) => r.entries.genemonId), [c.id], "logged as leaving the device");
  assert(!q.max.collection.some((x) => x.id === c.id));
  assertEquals(q.market.escrowedGenemon().length, 0);
  assertEquals(q.market.inventory(after.buyerId!)[lc.itemId], 1, "the NPC owns it now");
  assertEquals(q.max.credits, 500 + q.market.proceeds(after.finalPrice!), "the seller was paid");
});

Deno.test("persistence: compaction keeps the market's behaviour; a corrupt save opens a new market and returns escrow", () => {
  const { ah } = busyHouse();
  for (let r = 0; r < 150; r++) {
    const t = (r + 20) * 5 * MIN;
    ah.companyRestock(t);
    ah.npcActivity(t + 1);
    ah.tick(t + 2);
  }
  const full = ah.toJSON();
  const small = compactHouseData(full, { houseClosed: 20, playerClosed: 5, history: 10, trades: 30 });
  assert(JSON.stringify(small).length < JSON.stringify(full).length / 2, "much smaller");
  assert(
    small.history.every(([, rows]) => rows.length <= 50),
    "history trimmed, but never under 50 per item",
  );
  const back = AuctionHouse.fromJSON(small);
  assertEquals(back.listings({ status: "open" }), ah.listings({ status: "open" }), "open lots untouched");
  for (const id of ITEM_IDS) {
    assertEquals(back.fairValue(id), ah.fairValue(id), `${id}: NPC valuations unchanged`);
  }
  assertEquals(back.moneySupply(), ah.moneySupply());
  const t = 200 * 5 * MIN;
  for (const h of [ah, back]) {
    h.companyRestock(t);
    h.npcActivity(t + 1);
  }
  assertEquals(
    back.listings({ status: "open" }),
    ah.listings({ status: "open" }),
    "same decisions afterwards",
  );

  // A corrupted save: a new market opens (logged) and an escrowed creature goes home.
  const w = world(7);
  w.market.visit(w.max, T0);
  const g = spare(w.max);
  w.market.sellGenemon(w.max, g.id, 100, null, 10 * MIN, T0 + 1_000);
  w.storage.setItem(MARKET_KEY, "{ not json");
  const profiles = new ProfileStore(w.storage as unknown as Storage, T0);
  const fresh = new MarketStore(w.storage, profiles, T0 + 2_000, { ledger: w.ledger });
  assert(fresh.loadError !== null);
  assertEquals(w.ledger.query({ what: "market.store.reset" }).length, 1);
  const max = profiles.get(w.max.id)!;
  fresh.visit(max, T0 + 2_000);
  assert(max.collection.some((x) => x.id === g.id), "the escrowed Genemon came back");
  assertEquals(fresh.balance(max.id), 500, "the mirrored credits re-open the wallet");
  assert(fresh.house.moneySupply().balanced);
});

Deno.test("UI helpers: countdown text and a readable message for every refusal code", () => {
  assertEquals(
    [0, -5, 999, 45_000, 4 * MIN + 5_000, 3 * 3_600_000 + 5 * MIN, 50 * 3_600_000].map((ms) =>
      formatCountdown(ms)
    ),
    ["ended", "ended", "1s", "45s", "4m 05s", "3h 05m", "2d 02h"],
  );
  assertEquals(formatCountdown(0, "over"), "over");
  const w = world(7, 0);
  w.market.visit(w.max, T0);
  let caught: unknown = null;
  try {
    w.market.bid(w.max, "L999", 10, T0 + 1);
  } catch (e) {
    caught = e;
  }
  assertEquals(marketErrorText(caught), "This listing no longer exists (no listing L999).");
  assertEquals(Object.keys(MARKET_ERROR_TEXT).length, 23, "one text per MarketErrorCode");
  for (const [code, text] of Object.entries(MARKET_ERROR_TEXT)) {
    assert(/^[A-Z]/.test(text) && text.includes(" ") && text.length > 10, `${code} reads like a sentence`);
  }
  assertEquals(marketErrorText(new Error("plain")), "plain");
});
