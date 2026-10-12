/**
 * The device's auction house: ONE AuctionHouse shared by every local profile ("you and me" trade in
 * it), persisted in localStorage, kept alive while nobody plays, and wired to the profiles.
 *
 *  - Persistence: the house snapshot + store metadata under "genemon.market"; the Genemon objects
 *    escrowed by open listings under "genemon.market.genemon" (the market only knows item ids).
 *  - Offline life: every visit replays the 5-minute rounds (tick + company restock + NPC traders)
 *    missed since the last one, at most the 48 most recent (4 h), then settles what ended by `now`.
 *    While the Market screen is open it calls live() every 5 s (NPCs also act every 60 s then).
 *  - Wallets: the house is the bank. A profile's first visit deposits its credits once; after every
 *    action profile.credits mirrors the house balance. Credits gained or spent outside the market
 *    since the last mirror are deposited / withdrawn first, so no reward is overwritten.
 *  - Genemon trades: listing registers + escrows the creature (out of the collection and the team);
 *    a sale to a local profile delivers it to that collection (+ pokedex); a sale to an NPC sends it
 *    off this device; expiry or cancel returns it to the seller.
 * Everything takes `now` and a Storage-like object, so it runs (and is tested) without a DOM.
 */
import type { Ledger, Scalar } from "../core/ledger.ts";
import { hashSeed } from "../core/rng.ts";
import { type Genemon, phenotypeOf } from "../genome/genemon.ts";
import {
  appraiseGenemon,
  genemonItemId,
  isGenemonItem,
  ITEM_IDS,
  type ItemDef,
  itemDef,
} from "../economy/items.ts";
import {
  AuctionHouse,
  type AuctionHouseData,
  COMPANIES,
  HOUSE_ID,
  HOUSE_ZONE,
  isHouseAccount,
  type Listing,
  MarketError,
  type MarketErrorCode,
  MAX_CREDITS,
  MAX_DURATION_MS,
  MIN_DURATION_MS,
  NPC_TRADERS,
  type TradeRow,
} from "../economy/market.ts";
import type { Profile } from "./profile.ts";

// ------------------------------------------------------------------ constants
export const MARKET_KEY = "genemon.market";
export const ESCROW_KEY = "genemon.market.genemon";
/** One simulated market round: tick + company restock + NPC activity. */
export const ROUND_MS = 5 * 60_000;
/** Offline catch-up runs at most this many rounds (the most recent ones): 4 h of market life. */
export const MAX_CATCHUP_ROUNDS = 48;
/** Heartbeat of the open Market screen. */
export const LIVE_MS = 5_000;
/** NPC traders also act this often while someone watches (reaches the flipper's 2-min snipe window). */
export const LIVE_NPC_MS = 60_000;
export const SALE_DURATIONS: readonly { label: string; ms: number }[] = [
  { label: "1 min", ms: 60_000 },
  { label: "10 min", ms: 10 * 60_000 },
  { label: "1 h", ms: 3_600_000 },
  { label: "24 h", ms: 24 * 3_600_000 },
];

/** How much of the archive the saved copy keeps (the live house keeps its own, larger caps). */
export interface CompactCaps {
  /** Closed listings between house accounts only (company / NPC lots). */
  houseClosed: number;
  /** Closed listings a player sold, bought or bid on ("recent settlements"). */
  playerClosed: number;
  /** Trades kept per item (never below 50: fairValue reads the last 50, so NPC prices never move). */
  history: number;
  /** Fraud trade log length. */
  trades: number;
}
export const COMPACT_CAPS: CompactCaps = { houseClosed: 200, playerClosed: 300, history: 80, trades: 1000 };
/** Fallback when storage is nearly full. */
export const TIGHT_CAPS: CompactCaps = { houseClosed: 40, playerClosed: 100, history: 50, trades: 200 };
const FAIR_KEEP = 50;
const STORE_VERSION = 1;

// ------------------------------------------------------------------ types
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** What the store needs from the profile store (ProfileStore satisfies it). */
export interface ProfileBook {
  get(id: string): Profile | null;
  save(p: Profile): void;
  list(): Profile[];
}

/** What getMarket needs from the App. */
export interface MarketHost {
  readonly ledger: Ledger;
  readonly store: ProfileBook;
}

export interface WalletRecord {
  /** First market visit: when profile.credits moved into the bank. */
  since: number;
  /** profile.credits as last mirrored from the house balance. */
  mirror: number;
}

/** A Genemon waiting in escrow while its listing is open (the house holds `genemon:<id>`). */
export interface EscrowEntry {
  itemId: string;
  listingId: string;
  sellerId: string;
  postedAt: number;
  genemon: Genemon;
}

export interface CatchUpPlan {
  /** Round timestamps to simulate, oldest first, on the lastRound + k x ROUND_MS grid. */
  times: number[];
  /** Rounds due since the last one. */
  due: number;
  /** Due rounds dropped by the cap (the oldest ones). */
  skipped: number;
  /** The new anchor: the last due grid point (skipped rounds are not owed again). */
  nextLastRound: number;
}

export interface StepReport {
  rounds: number;
  skipped: number;
  /** Listings settled (sold or expired) during this step. */
  settled: number;
  npcActions: number;
  /** Genemon moved out of escrow (delivered, returned or departed). */
  moved: number;
  /** Credits deposited by a first visit (0 if the profile had none), null when the wallet already existed. */
  opened: number | null;
  /** Something a player can see changed (re-render worth it). */
  changed: boolean;
}

export interface Party {
  id: string;
  kind: "house" | "company" | "npc" | "player";
  name: string;
  icon: string;
  note: string;
}

export interface MarketStoreOptions {
  ledger?: Ledger;
  /** Seed of a NEW house (a saved one keeps its own). Default hashSeed("genemon.market", now). */
  seed?: number;
  /** A new house starts this many rounds in the past, so the first visit finds stocked shelves. */
  warmupRounds?: number;
}

interface SavedMarket {
  lastRound: number;
  lastNpc: number;
  wallets: [string, WalletRecord][];
  house: AuctionHouse;
  genemons: ItemDef[];
}

// ------------------------------------------------------------------ pure helpers
/**
 * Which rounds to replay between the last round and `now`: due = whole ROUND_MS steps elapsed;
 * only the `max` most recent are run (a 3-day absence does not cost 864 rounds) and the anchor
 * jumps to the last due grid point, so the same (lastRound, now) always gives the same rounds.
 */
export function catchUpPlan(lastRound: number, now: number, max = MAX_CATCHUP_ROUNDS): CatchUpPlan {
  if (!Number.isFinite(lastRound) || !Number.isFinite(now)) {
    return { times: [], due: 0, skipped: 0, nextLastRound: Number.isFinite(lastRound) ? lastRound : now };
  }
  const due = Math.max(0, Math.floor((now - lastRound) / ROUND_MS));
  const n = Math.min(due, Math.max(0, Math.floor(max)));
  const times: number[] = [];
  for (let k = due - n + 1; k <= due; k++) times.push(lastRound + k * ROUND_MS);
  return { times, due, skipped: due - n, nextLastRound: lastRound + due * ROUND_MS };
}

/** "45s", "4m 05s", "3h 05m", "2d 03h"; `done` once the time is up. */
export function formatCountdown(ms: number, done = "ended"): string {
  if (!Number.isFinite(ms) || ms <= 0) return done;
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const hr = Math.floor(m / 60);
  if (hr < 24) return `${hr}h ${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(hr / 24)}d ${String(hr % 24).padStart(2, "0")}h`;
}

/** A readable sentence per refusal code (the detail from the house is appended in brackets). */
export const MARKET_ERROR_TEXT: Record<MarketErrorCode, string> = {
  "invalid-account": "That account cannot trade",
  "invalid-amount": "Enter a whole number of credits (at least 1)",
  "invalid-time": "The device clock looks wrong",
  "invalid-duration": "Pick a duration between 1 minute and 7 days",
  "invalid-promo": "That promotion is not valid",
  "unknown-item": "This item does not exist",
  "unknown-listing": "This listing no longer exists",
  "unknown-company": "Unknown company",
  "unknown-npc": "Unknown trader",
  "impersonation": "House accounts cannot trade here",
  "forbidden": "That is not allowed",
  "not-stackable": "This item is sold one unit at a time",
  "duplicate-unique": "This Genemon is already on the market",
  "insufficient-items": "You do not have that",
  "insufficient-funds": "Not enough credits",
  "not-open": "This lot is already closed",
  "ended": "Too late: the auction has ended",
  "own-listing": "That is your own listing",
  "bid-too-low": "Bid too low: beat the current bid by at least 5 %",
  "no-buyout": "This lot has no buyout price",
  "has-bids": "A lot with bids cannot be cancelled",
  "not-seller": "Only the seller can cancel this lot",
  "promo-company-only": "Only companies run promotions",
};

export function marketErrorText(e: unknown): string {
  if (e instanceof MarketError) {
    const prefix = `${e.code}: `;
    const detail = e.message.startsWith(prefix) ? e.message.slice(prefix.length) : e.message;
    return `${MARKET_ERROR_TEXT[e.code] ?? "The market refused that"} (${detail}).`;
  }
  return e instanceof Error ? e.message : String(e);
}

/**
 * Trim a snapshot before it is saved: the oldest closed listings (house-only ones first; the ones a
 * player took part in are kept longer), per-item history beyond max(50, cap) and the fraud log. Open
 * listings, wallets, inventories and counters are untouched, so the market behaves exactly the same
 * after a reload; only the read-only archive gets shorter.
 */
export function compactHouseData(data: AuctionHouseData, caps: CompactCaps = COMPACT_CAPS): AuctionHouseData {
  const byId = new Map(data.listings.map((l) => [l.id, l]));
  const player = (id: string): boolean => {
    const l = byId.get(id);
    if (!l) return false;
    return l.sellerKind === "player" || (l.buyerId !== null && !isHouseAccount(l.buyerId)) ||
      (l.bidderId !== null && !isHouseAccount(l.bidderId));
  };
  const keep = new Set<string>();
  let nHouse = 0, nPlayer = 0;
  for (let i = data.closed.length - 1; i >= 0; i--) {
    const id = data.closed[i];
    if (player(id) ? nPlayer++ < caps.playerClosed : nHouse++ < caps.houseClosed) keep.add(id);
  }
  const histCap = Math.max(FAIR_KEEP, Math.floor(caps.history));
  const tail = (
    rows: TradeRow[],
    n: number,
  ): TradeRow[] => (rows.length > n ? rows.slice(rows.length - n) : rows);
  return {
    ...data,
    listings: data.listings.filter((l) => l.status === "open" || keep.has(l.id)),
    closed: data.closed.filter((id) => keep.has(id)),
    history: data.history.map(([id, rows]): [string, TradeRow[]] => [id, tail(rows, histCap)]),
    trades: tail(data.trades, Math.max(0, Math.floor(caps.trades))),
  };
}

function safeGet(storage: StorageLike, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function isEscrowEntry(x: unknown): x is EscrowEntry {
  if (!x || typeof x !== "object") return false;
  const e = x as Record<string, unknown>;
  const g = e.genemon as Record<string, unknown> | null | undefined;
  return typeof e.itemId === "string" && typeof e.listingId === "string" && typeof e.sellerId === "string" &&
    typeof e.postedAt === "number" && !!g && typeof g === "object" && typeof g.id === "string" &&
    g.id.length > 0 && !!g.genome && typeof g.genome === "object" && e.itemId === genemonItemId(g.id);
}

/** Escrowed Genemon saved on this device (malformed entries are skipped). */
export function readEscrow(storage: StorageLike): EscrowEntry[] {
  const raw = safeGet(storage, ESCROW_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isEscrowEntry) : [];
  } catch {
    return [];
  }
}

export function writeEscrow(storage: StorageLike, entries: readonly EscrowEntry[]): void {
  if (entries.length === 0) storage.removeItem(ESCROW_KEY);
  else storage.setItem(ESCROW_KEY, JSON.stringify(entries));
}

/** Parse "genemon.market" (throws on a malformed document; the house validates its own part). */
export function loadMarketDoc(storage: StorageLike, ledger?: Ledger): SavedMarket | null {
  const raw = safeGet(storage, MARKET_KEY);
  if (raw === null) return null;
  const doc: unknown = JSON.parse(raw);
  if (!doc || typeof doc !== "object") throw new TypeError(`${MARKET_KEY}: not an object`);
  const o = doc as Record<string, unknown>;
  if (o.v !== STORE_VERSION) throw new TypeError(`${MARKET_KEY}: unsupported version ${String(o.v)}`);
  const house = AuctionHouse.fromJSON(o.house, { ledger });
  const num = (
    v: unknown,
    fallback: number,
  ): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
  const wallets: [string, WalletRecord][] = [];
  for (const w of Array.isArray(o.wallets) ? o.wallets : []) {
    if (!Array.isArray(w) || typeof w[0] !== "string" || !w[1] || typeof w[1] !== "object") continue;
    const r = w[1] as Record<string, unknown>;
    if (typeof r.mirror !== "number" || !Number.isSafeInteger(r.mirror)) continue;
    wallets.push([w[0], { since: num(r.since, 0), mirror: r.mirror }]);
  }
  const savedAt = num(o.savedAt, 0);
  return {
    lastRound: num(o.lastRound, savedAt),
    lastNpc: num(o.lastNpc, savedAt),
    wallets,
    house,
    genemons: (o.house as AuctionHouseData).genemons,
  };
}

// ------------------------------------------------------------------ the store
export class MarketStore {
  #house: AuctionHouse;
  #lastRound: number;
  #lastNpc: number;
  readonly #wallets = new Map<string, WalletRecord>();
  readonly #escrow = new Map<string, EscrowEntry>();
  /** Registered Genemon item definitions (names, rarity, appraisal) for display. */
  readonly #defs = new Map<string, ItemDef>();
  readonly #storage: StorageLike;
  readonly #profiles: ProfileBook;
  readonly #ledger: Ledger | undefined;
  #dirty = false;
  /** Why the saved market could not be restored (a new one was opened); null otherwise. */
  readonly loadError: string | null = null;
  /** Last persist failure (storage full...); null after a successful save. */
  saveError: string | null = null;

  constructor(storage: StorageLike, profiles: ProfileBook, now: number, opts: MarketStoreOptions = {}) {
    this.#storage = storage;
    this.#profiles = profiles;
    this.#ledger = opts.ledger;
    let saved: SavedMarket | null = null;
    let error: string | null = null;
    try {
      saved = loadMarketDoc(storage, opts.ledger);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    if (saved) {
      this.#house = saved.house;
      this.#lastRound = saved.lastRound;
      this.#lastNpc = saved.lastNpc;
      for (const [id, w] of saved.wallets) this.#wallets.set(id, w);
      for (const d of saved.genemons) this.#defs.set(d.id, d);
    } else {
      const warm = Math.max(0, Math.floor(opts.warmupRounds ?? MAX_CATCHUP_ROUNDS));
      this.#house = new AuctionHouse({
        seed: opts.seed ?? hashSeed("genemon.market", now),
        ledger: opts.ledger,
      });
      this.#lastRound = now - warm * ROUND_MS;
      this.#lastNpc = now;
      this.#dirty = true;
      if (error !== null) {
        this.loadError = error;
        this.#emit(
          now,
          HOUSE_ID,
          "market.store.reset",
          "the saved market could not be restored: a new one opened",
          MARKET_KEY,
          "market",
          {
            error: error.slice(0, 160),
          },
          { seed: this.#house.seed },
        );
      }
    }
    for (const e of readEscrow(storage)) this.#escrow.set(e.itemId, e);
  }

  // ---------------------------------------------------------------- reads (act through the store)
  /** The shared house, for READS (listings, quote, stats, priceHistory...). Act through the store. */
  get house(): AuctionHouse {
    return this.#house;
  }

  /** Grid anchor of the last simulated round. */
  get lastRound(): number {
    return this.#lastRound;
  }

  balance(ownerId: string): number {
    return this.#house.balance(ownerId);
  }

  escrowed(ownerId: string): number {
    return this.#house.escrowed(ownerId);
  }

  inventory(ownerId: string): Record<string, number> {
    return this.#house.inventory(ownerId);
  }

  /** Has this profile visited the market (credits moved into the bank)? */
  walletOpen(profileId: string): boolean {
    return this.#wallets.has(profileId);
  }

  /** Catalogue item, appraised Genemon, or an unappraised Genemon placeholder. */
  describe(itemId: string): ItemDef | undefined {
    return this.#defs.get(itemId) ?? itemDef(itemId);
  }

  escrowEntry(itemId: string): EscrowEntry | undefined {
    return this.#escrow.get(itemId);
  }

  /** Genemon waiting in escrow (optionally only one seller's). */
  escrowedGenemon(sellerId?: string): EscrowEntry[] {
    return [...this.#escrow.values()].filter((e) => sellerId === undefined || e.sellerId === sellerId);
  }

  /** Items with at least one completed trade, most traded first. */
  tradedItems(): string[] {
    const ids = [...ITEM_IDS, ...this.#defs.keys()];
    const n = new Map(ids.map((id) => [id, this.#house.priceHistory(id).length]));
    return ids.filter((id) => (n.get(id) ?? 0) > 0).sort((a, b) => n.get(b)! - n.get(a)! || (a < b ? -1 : 1));
  }

  /** Who a seller / buyer id is, for chips. */
  party(id: string): Party {
    if (id === HOUSE_ID) {
      return { id, kind: "house", name: "The auction house", icon: "⚖", note: "The house itself" };
    }
    const co = COMPANIES.find((c) => c.id === id);
    if (co) return { id, kind: "company", name: co.name, icon: "🏪", note: co.note };
    const npc = NPC_TRADERS.find((n) => n.id === id);
    if (npc) return { id, kind: "npc", name: npc.name, icon: "🎭", note: npc.note };
    const p = this.#profiles.get(id);
    return {
      id,
      kind: "player",
      name: p?.name ?? id,
      icon: p?.kind === "ai" ? "🤖" : "🙂",
      note: p ? `${p.kind === "ai" ? "AI" : "Human"} profile on this device` : "A player",
    };
  }

  /** Reference price of a Genemon (what the house would appraise it at). */
  appraise(g: Genemon): number {
    return appraiseGenemon(phenotypeOf(g), {
      generation: g.genome.generation,
      mutations: g.genome.mutations.length,
    });
  }

  /** Suggested start price for a lot: the market median per unit, else fair value, else list price. */
  suggestStart(itemId: string, qty: number): number {
    const unit = this.#house.stats(itemId).median ??
      (this.#house.fairValue(itemId) || this.describe(itemId)?.basePrice || 1);
    return Math.max(1, Math.round(unit * Math.max(1, Math.floor(qty))));
  }

  /** What a seller receives for a sale at `price` (the house fee is rounded up). */
  proceeds(price: number): number {
    const bps = Math.round(this.#house.feeRate * 10_000);
    return price - (bps === 0 ? 0 : Math.min(price, Math.ceil((price * bps) / 10_000)));
  }

  // ---------------------------------------------------------------- time
  /**
   * Replay the rounds missed since the last one (tick, company restock, NPC traders; at most the
   * 48 most recent), then settle every auction that ended by `now`.
   */
  catchUp(now: number): { rounds: number; skipped: number; settled: number; npcActions: number } {
    const plan = catchUpPlan(this.#lastRound, now);
    let settled = 0, posted = 0, npcActions = 0;
    for (const t of plan.times) {
      settled += this.#house.tick(t).length;
      posted += this.#house.companyRestock(t).length;
      npcActions += this.#house.npcActivity(t).length;
    }
    if (plan.times.length > 0) {
      this.#emit(
        now,
        HOUSE_ID,
        "market.catchup",
        "the market kept living while nobody watched: missed 5-minute rounds replayed",
        "offline",
        "market",
        { since: this.#lastRound, now, due: plan.due, cap: MAX_CATCHUP_ROUNDS },
        { rounds: plan.times.length, skipped: plan.skipped, settled, posted, npcActions },
      );
    }
    if (plan.nextLastRound !== this.#lastRound) {
      this.#lastRound = plan.nextLastRound;
      this.#dirty = true;
    }
    const late = this.#house.tick(now).length;
    if (plan.times.length > 0 || late > 0) this.#dirty = true;
    return { rounds: plan.times.length, skipped: plan.skipped, settled: settled + late, npcActions };
  }

  /** A visit (every Market render): catch up, open the wallet on a first visit, deliver, mirror, save. */
  visit(actor: Profile, now: number): StepReport {
    const c = this.catchUp(now);
    const opened = this.#openWallet(actor, now);
    const moved = this.#settle(actor, now, false);
    return { ...c, moved, opened, changed: c.rounds > 0 || c.settled > 0 || moved > 0 };
  }

  /** The 5-second heartbeat of the open Market screen: a visit plus NPC activity every 60 s. */
  live(actor: Profile, now: number): StepReport {
    const c = this.catchUp(now);
    let npc = 0;
    if (now - this.#lastNpc >= LIVE_NPC_MS || now < this.#lastNpc) {
      npc = this.#house.npcActivity(now).length;
      this.#lastNpc = now;
      this.#dirty = true;
    }
    const opened = this.#openWallet(actor, now);
    const moved = this.#settle(actor, now, false);
    return {
      ...c,
      npcActions: c.npcActions + npc,
      moved,
      opened,
      changed: c.rounds > 0 || c.settled > 0 || npc > 0 || moved > 0,
    };
  }

  // ---------------------------------------------------------------- actions (the actor is the active profile)
  bid(actor: Profile, listingId: string, amount: number, now: number): Listing {
    return this.#act(actor, now, () => this.#house.bid(listingId, actor.id, amount, now));
  }

  buyout(actor: Profile, listingId: string, now: number): Listing {
    return this.#act(actor, now, () => this.#house.buyout(listingId, actor.id, now));
  }

  cancel(actor: Profile, listingId: string, now: number): Listing {
    return this.#act(actor, now, () => this.#house.cancel(listingId, actor.id, now));
  }

  /** List items the actor holds at the market (bought earlier). Genemon go through sellGenemon. */
  sellItem(
    actor: Profile,
    itemId: string,
    qty: number,
    startPrice: number,
    buyout: number | null,
    durationMs: number,
    now: number,
  ): Listing {
    return this.#act(actor, now, () => {
      if (isGenemonItem(itemId)) {
        throw new MarketError("forbidden", "sell a Genemon from your collection instead");
      }
      return this.#house.post(actor.id, "player", itemId, qty, startPrice, buyout, durationMs, now);
    });
  }

  /**
   * List a Genemon from the actor's collection: appraise (registerGenemon), hand it to the house,
   * post, then take it out of the collection and the team and keep its JSON in escrow.
   */
  sellGenemon(
    actor: Profile,
    genemonId: string,
    startPrice: number,
    buyout: number | null,
    durationMs: number,
    now: number,
  ): Listing {
    return this.#act(actor, now, () => {
      const g = actor.collection.find((x) => x.id === genemonId);
      if (!g) {
        throw new MarketError("insufficient-items", `${genemonId} is not in ${actor.name}'s collection`);
      }
      if (actor.collection.length <= 1) {
        throw new MarketError("forbidden", "you cannot sell your last Genemon");
      }
      checkTerms(startPrice, buyout, durationMs);
      const def = this.#house.registerGenemon(g.id, phenotypeOf(g), {
        generation: g.genome.generation,
        mutations: g.genome.mutations.length,
        name: g.name,
        now,
      });
      this.#defs.set(def.id, def);
      const held = this.#house.inventory(actor.id)[def.id] ?? 0;
      if (held < 1) {
        this.#house.give(actor.id, def.id, 1, now, "genemon put up for sale: handed to the house");
      }
      let l: Listing;
      try {
        l = this.#house.post(actor.id, "player", def.id, 1, startPrice, buyout, durationMs, now);
      } catch (e) {
        if (held < 1) {
          this.#house.take(actor.id, def.id, 1, now, "listing refused: the genemon stays in the collection");
        }
        throw e;
      }
      const inTeam = actor.team.includes(g.id);
      actor.collection = actor.collection.filter((x) => x.id !== g.id);
      actor.team = actor.team.filter((id) => id !== g.id);
      this.#escrow.set(def.id, {
        itemId: def.id,
        listingId: l.id,
        sellerId: actor.id,
        postedAt: now,
        genemon: JSON.parse(JSON.stringify(g)) as Genemon,
      });
      this.#emit(
        now,
        actor.id,
        "market.genemon.escrow",
        "listed: the creature leaves the collection and waits in escrow",
        `collection:${actor.id}`,
        `listing:${l.id}`,
        {
          genemonId: g.id,
          name: g.name,
          listingId: l.id,
          startPrice,
          buyout: buyout ?? 0,
          durationMs,
          appraisal: def.basePrice,
        },
        { collection: actor.collection.length, wasInTeam: inTeam, team: actor.team.length },
      );
      return l;
    });
  }

  // ---------------------------------------------------------------- persistence
  /** Save escrow (first: it holds the creatures) then the compacted house; false if storage refused. */
  persist(now: number): boolean {
    const doc = (caps: CompactCaps): string =>
      JSON.stringify({
        v: STORE_VERSION,
        savedAt: now,
        lastRound: this.#lastRound,
        lastNpc: this.#lastNpc,
        wallets: [...this.#wallets.entries()],
        house: compactHouseData(this.#house.toJSON(), caps),
      });
    try {
      writeEscrow(this.#storage, [...this.#escrow.values()]);
      try {
        this.#storage.setItem(MARKET_KEY, doc(COMPACT_CAPS));
      } catch {
        this.#storage.setItem(MARKET_KEY, doc(TIGHT_CAPS));
      }
      this.#dirty = false;
      this.saveError = null;
      return true;
    } catch (e) {
      this.saveError = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  // ---------------------------------------------------------------- internals
  #act<T>(actor: Profile, now: number, op: () => T): T {
    this.#openWallet(actor, now);
    this.#mirror(actor, now);
    let out: T;
    try {
      out = op();
    } catch (e) {
      if (this.#dirty) this.#settle(actor, now, false);
      throw e;
    }
    this.#settle(actor, now, true);
    return out;
  }

  /** First visit: profile.credits move into the bank, once. Returns the deposit, or null if already open. */
  #openWallet(p: Profile, now: number): number | null {
    if (this.#wallets.has(p.id)) return null;
    const credits = Number.isFinite(p.credits)
      ? Math.max(0, Math.min(MAX_CREDITS, Math.floor(p.credits)))
      : 0;
    if (credits > 0) {
      this.#house.deposit(
        p.id,
        credits,
        now,
        "opening balance: the profile's credits moved into the market bank",
      );
    }
    this.#wallets.set(p.id, { since: now, mirror: credits });
    this.#dirty = true;
    return credits;
  }

  /**
   * profile.credits := house balance. Credits gained / spent outside the market since the last mirror
   * are deposited / withdrawn first. Returns true when the profile object changed (save it).
   */
  #mirror(p: Profile, now: number): boolean {
    const w = this.#wallets.get(p.id);
    if (!w) return false;
    const have = Number.isFinite(p.credits) ? Math.floor(p.credits) : w.mirror;
    const delta = have - w.mirror;
    if (delta > 0) {
      this.#house.deposit(
        p.id,
        Math.min(delta, MAX_CREDITS),
        now,
        "credits earned outside the market, banked",
      );
    } else if (delta < 0) {
      const out = Math.min(-delta, this.#house.balance(p.id));
      if (out > 0) this.#house.withdraw(p.id, out, now, "credits spent outside the market");
    }
    const bal = this.#house.balance(p.id);
    // A banked outside delta must reach the saved profile too, or a reload would replay it.
    const changed = p.credits !== bal || delta !== 0;
    p.credits = bal;
    if (w.mirror !== bal || delta !== 0) {
      w.mirror = bal;
      this.#dirty = true;
    }
    return changed;
  }

  /** After a step or an action: move escrowed Genemon, mirror every banked profile, save what changed. */
  #settle(actor: Profile | null, now: number, acted: boolean): number {
    const touched = new Set<Profile>();
    const moved = this.#reconcile(actor, now, touched);
    for (const id of this.#wallets.keys()) {
      const p = this.#profile(id, actor);
      if (p && this.#mirror(p, now)) touched.add(p);
    }
    if (actor && acted) touched.add(actor);
    for (const p of touched) this.#profiles.save(p);
    if (acted || moved > 0) this.#dirty = true;
    if (this.#dirty) this.persist(now);
    return moved;
  }

  /** Follow every escrowed Genemon whose listing is no longer open to its new home. */
  #reconcile(actor: Profile | null, now: number, touched: Set<Profile>): number {
    let moved = 0;
    for (const e of [...this.#escrow.values()]) {
      let l = this.#house.listing(e.listingId);
      if (!l || l.itemId !== e.itemId) {
        // The saved house and the escrow disagree (interrupted save, archive dropped it): follow the item.
        const open = this.#house.listings({ itemId: e.itemId, status: "open" })[0];
        if (open) {
          e.listingId = open.id;
          this.#dirty = true;
          continue;
        }
        l = null;
      }
      if (l?.status === "open") continue;
      let to: string, why: string;
      if (l?.status === "sold" && l.buyerId !== null) {
        to = l.buyerId;
        why = `sold for ${l.finalPrice ?? 0} credits`;
      } else if (l) {
        to = e.sellerId;
        why = l.status === "cancelled" ? "listing cancelled" : "auction ended without a bid";
      } else {
        to = this.#holder(e.itemId, e.sellerId, actor) ?? e.sellerId;
        why = "recovered: the item was found with its holder";
      }
      if (this.#hand(e, to, now, actor, touched, why)) moved++;
    }
    return moved;
  }

  /** Move one escrowed Genemon to `toId`: a local profile's collection, or off the device. */
  #hand(
    e: EscrowEntry,
    toId: string,
    now: number,
    actor: Profile | null,
    touched: Set<Profile>,
    why: string,
  ): boolean {
    const p = isHouseAccount(toId) ? null : this.#profile(toId, actor);
    const g = e.genemon;
    if (!p) {
      // The seller's profile is gone: keep the creature safe in escrow rather than lose it.
      if (toId === e.sellerId) return false;
      this.#escrow.delete(e.itemId);
      this.#dirty = true;
      this.#emit(
        now,
        toId,
        "market.genemon.departed",
        `${why}: the buyer is not a profile on this device, the creature leaves it`,
        `listing:${e.listingId}`,
        `inv:${toId}`,
        {
          genemonId: g.id,
          name: g.name,
          sellerId: e.sellerId,
          listingId: e.listingId,
        },
        { buyerKind: isHouseAccount(toId) ? "npc" : "remote" },
      );
      return true;
    }
    if ((this.#house.inventory(toId)[e.itemId] ?? 0) > 0) {
      this.#house.take(
        toId,
        e.itemId,
        1,
        now,
        toId === e.sellerId
          ? "genemon back from the market into its owner's collection"
          : "genemon delivered from the market into the buyer's collection",
      );
    }
    g.owner = p.id;
    if (!p.collection.some((x) => x.id === g.id)) p.collection.push(g);
    if (!p.pokedex.includes(g.genome.id)) p.pokedex.push(g.genome.id);
    touched.add(p);
    this.#escrow.delete(e.itemId);
    this.#dirty = true;
    const back = toId === e.sellerId;
    this.#emit(
      now,
      p.id,
      back ? "market.genemon.returned" : "market.genemon.delivered",
      back
        ? `${why}: the creature is back in the seller's collection`
        : `${why}: the creature joins the buyer's collection`,
      `listing:${e.listingId}`,
      `collection:${p.id}`,
      { genemonId: g.id, name: g.name, sellerId: e.sellerId, listingId: e.listingId },
      { collection: p.collection.length, pokedex: p.pokedex.length },
    );
    return true;
  }

  /** Who holds `itemId` in the house: a banked profile, any profile, an NPC (or nobody). */
  #holder(itemId: string, sellerId: string, actor: Profile | null): string | null {
    const ids = new Set<string>([sellerId, ...this.#wallets.keys(), ...NPC_TRADERS.map((n) => n.id)]);
    if (actor) ids.add(actor.id);
    for (const p of this.#profiles.list()) ids.add(p.id);
    for (const id of ids) if ((this.#house.inventory(id)[itemId] ?? 0) > 0) return id;
    return null;
  }

  #profile(id: string, actor: Profile | null): Profile | null {
    if (actor && actor.id === id) return actor;
    return this.#profiles.get(id);
  }

  #emit(
    when: number,
    who: string,
    what: string,
    why: string,
    from: string,
    to: string,
    entries: Record<string, Scalar>,
    exits: Record<string, Scalar>,
  ): void {
    this.#ledger?.emit({
      when,
      where: { x: 0, y: 0, z: 0, zone: HOUSE_ZONE, space: "market" },
      who,
      what,
      why,
      from,
      to,
      entries,
      exits,
      tags: ["market", "store"],
    });
  }
}

/** Refuse bad listing terms before a Genemon is handed over (same codes as the house). */
function checkTerms(startPrice: number, buyout: number | null, durationMs: number): void {
  const amount = (n: number) => Number.isInteger(n) && n >= 1 && n <= MAX_CREDITS;
  if (!amount(startPrice)) {
    throw new MarketError("invalid-amount", `start price must be a whole number >= 1, got ${startPrice}`);
  }
  if (buyout !== null && !amount(buyout)) {
    throw new MarketError("invalid-amount", `buyout must be a whole number >= 1, got ${buyout}`);
  }
  if (buyout !== null && buyout < startPrice) {
    throw new MarketError("invalid-amount", "buyout below start price");
  }
  if (!Number.isInteger(durationMs) || durationMs < MIN_DURATION_MS || durationMs > MAX_DURATION_MS) {
    throw new MarketError("invalid-duration", `duration must be ${MIN_DURATION_MS}..${MAX_DURATION_MS} ms`);
  }
}

// ------------------------------------------------------------------ the device singleton
let shared: MarketStore | null = null;
let sharedLedger: Ledger | null = null;

/** The device's market (localStorage + the app ledger), created on first use. */
export function getMarket(app: MarketHost): MarketStore {
  if (!shared || sharedLedger !== app.ledger) {
    shared = new MarketStore(globalThis.localStorage, app.store, Date.now(), { ledger: app.ledger });
    sharedLedger = app.ledger;
    if (shared.loadError) {
      console.warn(`market: the saved market could not be restored (${shared.loadError}); a new one opened`);
    }
  }
  return shared;
}
