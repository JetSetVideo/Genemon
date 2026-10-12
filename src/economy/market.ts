/**
 * The Genemon auction house: one deterministic, ledger-first market where COMPANIES (infinite stock,
 * flash promotions), NPC TRADERS (bargain hunter, collector, flipper, forager) and PLAYERS trade
 * catalogue items and unique Genemons for credits.
 *
 *  - The house is the custodian of wallets (integer credits), inventories and ESCROW: posting escrows
 *    the item, bidding escrows the credits, an outbid bidder is refunded at once.
 *  - Minimum raise 5 %; a bid inside the last 30 s pushes the end back by 30 s (anti-sniping).
 *  - A sale moves the item to the buyer and the price minus a fee (default 5 %, rounded up) to the
 *    seller; the fee goes to the house treasury, the economy's main credit sink.
 *  - Pure and replayable: no DOM, no clock (`now` is always a parameter), every draw from Rng(seed),
 *    and every state change emits ONE ledger row (space "market", zone "auction-house").
 * Rules, models, decisions and open questions: docs/ECONOMY.md.
 */
import type { Ledger, Scalar } from "../core/ledger.ts";
import { r3 } from "../core/math.ts";
import { hashSeed, Rng } from "../core/rng.ts";
import type { Phenotype } from "../genome/phenotype.ts";
import {
  type GenemonInfo,
  genemonItemDef,
  isGenemonItem,
  ITEM_IDS,
  type ItemDef,
  itemDef,
  type ItemKind,
  ITEMS,
  RARITIES,
  type Rarity,
  RARITY_RANK,
} from "./items.ts";

// ------------------------------------------------------------------ rules
export const DEFAULT_FEE_RATE = 0.05;
/** Minimum raise over the current bid in basis points (500 = 5 %). */
export const MIN_INCREMENT_BPS = 500;
/** A bid placed when at most this much time is left extends the auction... */
export const ANTI_SNIPE_WINDOW_MS = 30_000;
/** ...by this much. */
export const ANTI_SNIPE_EXTEND_MS = 30_000;
export const MIN_DURATION_MS = 60_000;
export const MAX_DURATION_MS = 7 * 24 * 3_600_000;
/** Ceiling of any single amount: keeps price x basis points inside the float64 safe-integer range. */
export const MAX_CREDITS = 100_000_000_000;
/** The house's own account id (settlements, rounds, appraisals). */
export const HOUSE_ID = "house";
export const HOUSE_ZONE = "auction-house";

const COMPANY_LISTING_MS = 2 * 3_600_000;
const NPC_LISTING_MS = 3_600_000;
/** The flipper only bids on auctions that end within this horizon (it snipes; the house extends). */
const SNIPE_HORIZON_MS = 120_000;
const NPC_MAX_OPEN = 6;
/** Fair value needs this many trades before the market median starts to pull it off list price. */
const FAIR_MIN_TRADES = 3;
const FAIR_WINDOW = 50;
const ARCHIVE_CAP = 2_000;
const HISTORY_CAP = 500;
const TRADE_LOG_CAP = 5_000;

// ------------------------------------------------------------------ types
export type SellerKind = "company" | "npc" | "player";
export type ListingStatus = "open" | "sold" | "expired" | "cancelled";

export interface Promo {
  label: string;
  /** Fraction off the buyout while active (0.25 = -25 %). */
  discount: number;
  endsAt: number;
}

export interface Listing {
  id: string;
  sellerId: string;
  sellerKind: SellerKind;
  itemId: string;
  /** Units in the lot. Every price on a listing is for the WHOLE lot. */
  qty: number;
  startPrice: number;
  buyout: number | null;
  currentBid: number | null;
  bidderId: string | null;
  createdAt: number;
  endsAt: number;
  promo?: Promo;
  status: ListingStatus;
  bidCount: number;
  /** Anti-sniping extensions applied so far. */
  extensions: number;
  buyerId: string | null;
  finalPrice: number | null;
  closedAt: number | null;
}

export interface Settlement {
  listingId: string;
  itemId: string;
  qty: number;
  status: "sold" | "expired";
  sellerId: string;
  sellerKind: SellerKind;
  buyerId: string | null;
  /** Lot price paid (0 when expired). */
  price: number;
  fee: number;
  /** Credits the seller received (price - fee). */
  proceeds: number;
  /** When the auction actually ended (listing.endsAt), not when tick() noticed it. */
  at: number;
}

export interface ListingFilter {
  itemId?: string;
  kind?: ItemKind;
  sellerKind?: SellerKind;
  status?: ListingStatus;
  sellerId?: string;
  bidderId?: string;
}

/** Per-unit statistics of completed sales. median/mean/last are null until the first trade. */
export interface MarketStats {
  median: number | null;
  mean: number | null;
  /** Realised volatility: RMS of log returns between consecutive trades (0.1 ~ 10 % moves). */
  volatility: number;
  /** Units traded. */
  volume: number;
  last: number | null;
  trades: number;
}

export interface Quote {
  listingId: string;
  open: boolean;
  minBid: number;
  /** Buyout price right now (promo applied), null when the listing has none. */
  buyout: number | null;
  promoActive: boolean;
  msLeft: number;
  /** Fair value of the whole lot (see fairValue). */
  fair: number;
}

export interface MoneySupply {
  wallets: number;
  escrow: number;
  treasury: number;
  minted: number;
  withdrawn: number;
  /** wallets + escrow + treasury === minted - withdrawn (credits are never created or lost). */
  balanced: boolean;
}

/** A player pair whose trades look like wash trading (a lead for human review, not a verdict). */
export interface WashSignal {
  a: string;
  b: string;
  trades: number;
  /** Largest share of one side's player-to-player sales that went to the other. */
  share: number;
  /** Same item sold a -> b and later b -> a. */
  roundTrips: number;
  /** Trades priced > 2.5x or < 0.4x the item's reference price. */
  offMarket: number;
  score: number;
}

export type MarketErrorCode =
  | "invalid-account"
  | "invalid-amount"
  | "invalid-time"
  | "invalid-duration"
  | "invalid-promo"
  | "unknown-item"
  | "unknown-listing"
  | "unknown-company"
  | "unknown-npc"
  | "impersonation"
  | "forbidden"
  | "not-stackable"
  | "duplicate-unique"
  | "insufficient-items"
  | "insufficient-funds"
  | "not-open"
  | "ended"
  | "own-listing"
  | "bid-too-low"
  | "no-buyout"
  | "has-bids"
  | "not-seller"
  | "promo-company-only";

export class MarketError extends Error {
  readonly code: MarketErrorCode;
  constructor(code: MarketErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "MarketError";
    this.code = code;
  }
}

// ------------------------------------------------------------------ sellers (data)
export interface CompanyDef {
  id: string;
  name: string;
  kinds: readonly ItemKind[];
  /** Max simultaneously open listings (restock tops up to this). */
  maxOpen: number;
  /** Buyout = list price x markup; the start price is always 75 % of list. */
  markup: number;
  note: string;
}

export const COMPANIES: readonly CompanyDef[] = [
  {
    id: "co:freshmart",
    name: "FreshMart Supermarket",
    kinds: ["food"],
    maxOpen: 6,
    markup: 1.1,
    note: "Every food, bundles of 1-10.",
  },
  {
    id: "co:genelab",
    name: "GeneLab Supplies",
    kinds: ["potion", "egg", "incubator", "stone"],
    maxOpen: 5,
    markup: 1.2,
    note: "Care and breeding supplies.",
  },
  {
    id: "co:wildgear",
    name: "Wildgear Outfitters",
    kinds: ["lure", "map", "territoryFlag"],
    maxOpen: 5,
    markup: 1.15,
    note: "Field gear for the world map.",
  },
  {
    id: "co:stadium",
    name: "Stadium League Box Office",
    kinds: ["ticket"],
    maxOpen: 3,
    markup: 1,
    note: "Arena cups and dungeon passes.",
  },
  {
    id: "co:atelier",
    name: "Atelier Chroma",
    kinds: ["cosmetic"],
    maxOpen: 3,
    markup: 1.25,
    note: "Cosmetics (visual only).",
  },
];

export type NpcPersonality = "bargainHunter" | "collector" | "flipper" | "forager";

/** An NPC trader is DATA: its whole behaviour is these numbers plus its personality branch. */
export interface NpcTrader {
  id: string;
  name: string;
  personality: NpcPersonality;
  /** Liquidity budget: under half of it the house tops the wallet back up (a logged faucet). */
  floor: number;
  /** Max buys/bids (or gathers) per round. */
  maxActions: number;
  /** Std-dev of the log-normal noise on its private valuation. */
  noise: number;
  /** Private valuation = fair value x bias x noise. */
  bias: number;
  /** Buys out when price <= valuation x buyBelow. */
  buyBelow: number;
  /** Bids the minimum when minBid <= valuation x bidBelow. */
  bidBelow: number;
  /** Max share of its wallet committed to one purchase. */
  spendShare: number;
  /** Price band over fair value for FRESH lots it posts (the forager's world drops) [low, high]. */
  markup: readonly [number, number];
  /** Price band over fair value when it relists stock it holds (flipper margin, forager clearance). */
  relist: readonly [number, number];
  note: string;
}

export const NPC_TRADERS: readonly NpcTrader[] = [
  {
    id: "npc:penny",
    name: "Penny the Bargain Hunter",
    personality: "bargainHunter",
    floor: 800,
    maxActions: 2,
    noise: 0.08,
    bias: 1,
    buyBelow: 0.88,
    bidBelow: 0.7,
    spendShare: 0.35,
    markup: [1, 1],
    relist: [1, 1],
    note: "Only buys clearly under value: flash promos and lowball bids. Never sells.",
  },
  {
    id: "npc:magpie",
    name: "Magpie the Collector",
    personality: "collector",
    floor: 2500,
    maxActions: 2,
    noise: 0.15,
    bias: 1.2,
    buyBelow: 1,
    bidBelow: 0.95,
    spendShare: 0.6,
    markup: [1, 1],
    relist: [1, 1],
    note: "Pays a premium for rare+ items, eggs, cosmetics and appraised Genemon. Never sells.",
  },
  {
    id: "npc:flint",
    name: "Flint the Flipper",
    personality: "flipper",
    floor: 1500,
    maxActions: 2,
    noise: 0.06,
    bias: 1,
    buyBelow: 0.82,
    bidBelow: 0.85,
    spendShare: 0.4,
    markup: [1.08, 1.25],
    relist: [1.08, 1.25],
    note: "Buys out under 82 % of fair value, snipes auctions in their last 2 minutes, relists at +8..25 %.",
  },
  {
    id: "npc:moss",
    name: "Moss the Forager",
    personality: "forager",
    floor: 100,
    maxActions: 2,
    noise: 0.1,
    bias: 1,
    buyBelow: 0,
    bidBelow: 0,
    spendShare: 0,
    markup: [1, 1.2],
    relist: [0.75, 0.95],
    note:
      "Gathers world drops (food, stones, maps, eggs) and auctions them; unsold lots return as clearance.",
  },
];

const COMPANY_BY_ID = new Map(COMPANIES.map((c) => [c.id, c]));
const NPC_BY_ID = new Map(NPC_TRADERS.map((n) => [n.id, n]));

/** Companies, NPC traders and the house itself can never act through the player buy API. */
export function isHouseAccount(id: string): boolean {
  return id === HOUSE_ID || COMPANY_BY_ID.has(id) || NPC_BY_ID.has(id);
}

const COMPANY_RARITY_WEIGHT: Record<Rarity, number> = {
  common: 6,
  uncommon: 3,
  rare: 1,
  epic: 0.25,
  legendary: 0,
};
const FORAGE_RARITY_WEIGHT: Record<Rarity, number> = {
  common: 10,
  uncommon: 4,
  rare: 1.2,
  epic: 0.3,
  legendary: 0.05,
};
const FORAGE_KINDS: readonly ItemKind[] = ["food", "stone", "map", "egg"];
const BUNDLE_MAX: Partial<Record<ItemKind, number>> = {
  food: 10,
  potion: 5,
  lure: 3,
  egg: 2,
  ticket: 2,
  territoryFlag: 2,
};
const PROMO_LABELS = [
  "Flash sale",
  "Happy hour",
  "Morning deal",
  "Rainy-day deal",
  "Clearance",
  "Members week",
] as const;

interface Pool {
  defs: ItemDef[];
  w: number[];
}

function poolOf(kinds: readonly ItemKind[], weights: Record<Rarity, number>): Pool {
  const defs = ITEM_IDS.map((id) => ITEMS[id]).filter((d) => kinds.includes(d.kind) && weights[d.rarity] > 0);
  return { defs, w: defs.map((d) => weights[d.rarity]) };
}

const COMPANY_POOLS = new Map(COMPANIES.map((c) => [c.id, poolOf(c.kinds, COMPANY_RARITY_WEIGHT)]));
const FORAGE_POOL = poolOf(FORAGE_KINDS, FORAGE_RARITY_WEIGHT);

// ------------------------------------------------------------------ helpers
interface Trade {
  t: number;
  listingId: string;
  itemId: string;
  qty: number;
  unit: number;
  total: number;
  sellerId: string;
  sellerKind: SellerKind;
  buyerId: string;
}

/** Locale-free string order (localeCompare depends on the machine's locale: not deterministic). */
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const r2 = (v: number): number => Math.round(v * 100) / 100;

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Callers get copies: the house's own records can only change through its methods. */
function view(l: Listing): Listing {
  return l.promo ? { ...l, promo: { ...l.promo } } : { ...l };
}

export interface AuctionHouseOptions {
  seed: number;
  ledger?: Ledger;
  /** Seller fee on every sale, in [0, 1). Default 0.05. */
  feeRate?: number;
}

// ------------------------------------------------------------------ snapshot (persistence)
/** Tag and version of the toJSON() snapshot. Bump the version on any change of shape. */
export const SNAPSHOT_FORMAT = "genemon.auction-house";
export const SNAPSHOT_VERSION = 1;

/** One completed trade, compact (the history and the fraud log can hold thousands). */
export type TradeRow = [
  t: number,
  listingId: string,
  itemId: string,
  qty: number,
  unit: number,
  total: number,
  sellerId: string,
  sellerKind: SellerKind,
  buyerId: string,
];

/**
 * The WHOLE house as plain JSON: wallets, inventories, every held listing (open ones are the item
 * and credit escrow), the closed-listing archive queue, per-item price history, the fraud trade log,
 * appraised Genemon definitions, the uniqueness set, and the counters that name the next listing and
 * seed the next restock / NPC round. fromJSON(toJSON()) continues byte-identically.
 */
export interface AuctionHouseData {
  format: typeof SNAPSHOT_FORMAT;
  v: typeof SNAPSHOT_VERSION;
  seed: number;
  feeRate: number;
  /** Listing id counter: ids are `L<seq>`. */
  seq: number;
  /** Latest `now` seen; the time of calls made without one. */
  clock: number;
  treasury: number;
  minted: number;
  withdrawn: number;
  /** Restock and NPC round counters (each round's Rng stream is hashed from its number). */
  restocks: number;
  npcRounds: number;
  wallets: [ownerId: string, credits: number][];
  inventories: [ownerId: string, items: [itemId: string, qty: number][]][];
  genemons: ItemDef[];
  /** Genemon item ids that exist (held or escrowed): the duplicate-unique guard. */
  unique: string[];
  /** Every listing still held (open + archived), in creation order. */
  listings: Listing[];
  /** Closed listing ids, oldest closure first: the archive eviction queue. */
  closed: string[];
  /** Per-item trades, oldest first (unit prices: priceHistory, stats, fair value). */
  history: [itemId: string, trades: TradeRow[]][];
  /** The fraud trade log (washTradeSignals), oldest first. */
  trades: TradeRow[];
}

export interface AuctionHouseRestoreOptions {
  ledger?: Ledger;
}

// ------------------------------------------------------------------ the house
export class AuctionHouse {
  readonly seed: number;
  readonly feeRate: number;
  readonly #feeBps: number;
  readonly #ledger: Ledger | undefined;
  readonly #wallets = new Map<string, number>();
  readonly #inv = new Map<string, Map<string, number>>();
  readonly #listings = new Map<string, Listing>();
  readonly #closed: string[] = [];
  readonly #history = new Map<string, Trade[]>();
  readonly #trades: Trade[] = [];
  readonly #genemons = new Map<string, ItemDef>();
  readonly #unique = new Set<string>();
  #seq = 0;
  #clock = 0;
  #treasury = 0;
  #minted = 0;
  #withdrawn = 0;
  #restocks = 0;
  #npcRounds = 0;

  constructor(opts: AuctionHouseOptions) {
    if (!Number.isFinite(opts.seed)) throw new MarketError("invalid-amount", "seed must be a finite number");
    const fee = opts.feeRate ?? DEFAULT_FEE_RATE;
    if (!(fee >= 0 && fee < 1)) {
      throw new MarketError("invalid-amount", `feeRate must be in [0, 1), got ${fee}`);
    }
    this.seed = opts.seed >>> 0;
    this.feeRate = fee;
    this.#feeBps = Math.round(fee * 10_000);
    this.#ledger = opts.ledger;
  }

  // ---------------------------------------------------------------- wallets & inventories
  /** Credit faucet (quest/battle rewards, NPC liquidity). Returns the new available balance. */
  deposit(ownerId: string, credits: number, now?: number, why = "credit grant"): number {
    const t = this.#when(now, ownerId, "deposit");
    this.#needAccount(ownerId, t, "deposit");
    this.#needAmount(credits, t, ownerId, "deposit", "credits");
    const after = this.#credit(ownerId, credits);
    this.#minted += credits;
    this.#emit(t, ownerId, "market.deposit", why, "faucet", `wallet:${ownerId}`, { credits }, {
      balance: after,
    }, ["wallet"]);
    return after;
  }

  /** Credit sink outside the auction (fixed-price shops, entry fees). Returns the new balance. */
  withdraw(ownerId: string, credits: number, now?: number, why = "credit spend"): number {
    const t = this.#when(now, ownerId, "withdraw");
    this.#needAccount(ownerId, t, "withdraw");
    this.#needAmount(credits, t, ownerId, "withdraw", "credits");
    const have = this.balance(ownerId);
    if (have < credits) {
      throw this.#fail(
        t,
        ownerId,
        "withdraw",
        "insufficient-funds",
        `needs ${credits}, has ${have}`,
        `wallet:${ownerId}`,
      );
    }
    const after = this.#credit(ownerId, -credits);
    this.#withdrawn += credits;
    this.#emit(t, ownerId, "market.withdraw", why, `wallet:${ownerId}`, "sink", { credits }, {
      balance: after,
    }, ["wallet"]);
    return after;
  }

  /** Available credits (escrowed bids excluded: see escrowed()). */
  balance(ownerId: string): number {
    return this.#wallets.get(ownerId) ?? 0;
  }

  /** Credits locked as the leading bid on open listings. */
  escrowed(ownerId: string): number {
    let s = 0;
    for (const l of this.#listings.values()) {
      if (l.status === "open" && l.bidderId === ownerId && l.currentBid !== null) s += l.currentBid;
    }
    return s;
  }

  /** Put items into an inventory (supermarket purchase, world drop, quest reward). Genemon are unique. */
  give(ownerId: string, itemId: string, qty: number, now?: number, why = "item grant"): number {
    const t = this.#when(now, ownerId, "give");
    this.#needAccount(ownerId, t, "give");
    const def = this.#def(itemId);
    if (!def) throw this.#fail(t, ownerId, "give", "unknown-item", `no item ${itemId}`);
    this.#needAmount(qty, t, ownerId, "give", "qty");
    if (def.kind === "genemon") {
      if (qty !== 1 || this.#unique.has(itemId)) {
        throw this.#fail(t, ownerId, "give", "duplicate-unique", `${itemId} already exists (unique, qty 1)`);
      }
      this.#unique.add(itemId);
    }
    const held = this.#addItems(ownerId, itemId, qty);
    this.#emit(t, ownerId, "market.give", why, "world", `inv:${ownerId}`, { itemId, kind: def.kind, qty }, {
      held,
    }, ["inventory", def.kind]);
    return held;
  }

  /** Remove items (eaten, used, withdrawn back to the world). Returns what is left. */
  take(ownerId: string, itemId: string, qty: number, now?: number, why = "item used"): number {
    const t = this.#when(now, ownerId, "take");
    this.#needAccount(ownerId, t, "take");
    this.#needAmount(qty, t, ownerId, "take", "qty");
    const have = this.#held(ownerId, itemId);
    if (have < qty) {
      throw this.#fail(
        t,
        ownerId,
        "take",
        "insufficient-items",
        `needs ${qty} ${itemId}, has ${have}`,
        `inv:${ownerId}`,
      );
    }
    const left = this.#addItems(ownerId, itemId, -qty);
    if (isGenemonItem(itemId)) this.#unique.delete(itemId);
    const kind = this.#def(itemId)?.kind ?? "unknown";
    this.#emit(t, ownerId, "market.take", why, `inv:${ownerId}`, "world", { itemId, kind, qty }, {
      held: left,
    }, ["inventory", kind]);
    return left;
  }

  /** Items held (escrowed listings excluded), keys sorted for stable rendering. */
  inventory(ownerId: string): Record<string, number> {
    const m = this.#inv.get(ownerId);
    if (!m) return {};
    return Object.fromEntries([...m.entries()].sort((a, b) => cmp(a[0], b[0])));
  }

  /** Appraise a Genemon and register its item definition (reference price, rarity, facts). */
  registerGenemon(genemonId: string, ph: Phenotype, info: GenemonInfo & { now?: number } = {}): ItemDef {
    const t = this.#when(info.now, HOUSE_ID, "appraise");
    if (typeof genemonId !== "string" || genemonId.length === 0) {
      throw this.#fail(t, HOUSE_ID, "appraise", "unknown-item", "empty genemon id");
    }
    const def = genemonItemDef(genemonId, ph, info);
    this.#genemons.set(def.id, def);
    this.#emit(
      t,
      HOUSE_ID,
      "market.genemon.appraise",
      "appraisal: power per slot x level x element rarity x pedigree",
      `genemon:${genemonId}`,
      "catalogue",
      {
        genemonId,
        level: ph.level,
        power: Math.round(ph.power),
        primary: ph.elements.primary,
        secondary: ph.elements.secondary ?? "none",
        generation: info.generation ?? 0,
        mutations: info.mutations ?? 0,
      },
      { itemId: def.id, appraisal: def.basePrice, rarity: def.rarity },
      ["genemon"],
    );
    return def;
  }

  // ---------------------------------------------------------------- listing lifecycle
  /**
   * List a lot. Players and NPCs escrow the items from their inventory; companies have infinite
   * stock. Promotions are company-only and need a buyout (the discount applies to the buyout).
   */
  post(
    sellerId: string,
    sellerKind: SellerKind,
    itemId: string,
    qty: number,
    startPrice: number,
    buyout: number | null,
    durationMs: number,
    now: number,
    promo?: Promo,
  ): Listing {
    return this.#post(
      sellerId,
      sellerKind,
      itemId,
      qty,
      startPrice,
      buyout,
      durationMs,
      now,
      promo,
      `${sellerKind} listing`,
    );
  }

  /**
   * Bid on a lot (players only). Min raise 5 %; the previous leader is refunded at once; credits are
   * escrowed; a bid in the last 30 s adds 30 s. A bid >= the current buyout price buys out at that price.
   */
  bid(listingId: string, bidderId: string, amount: number, now: number): Listing {
    const t = this.#when(now, bidderId, "bid");
    this.#needPlayer(bidderId, t, "bid");
    const l = this.#listings.get(listingId);
    if (!l) {
      throw this.#fail(
        t,
        bidderId,
        "bid",
        "unknown-listing",
        `no listing ${listingId}`,
        `listing:${listingId}`,
      );
    }
    return this.#bid(l, bidderId, amount, t, "bid placed");
  }

  /** Buy the lot now at the buyout price (promo discount applied while the promo runs). */
  buyout(listingId: string, buyerId: string, now: number): Listing {
    const t = this.#when(now, buyerId, "buyout");
    this.#needPlayer(buyerId, t, "buyout");
    const l = this.#listings.get(listingId);
    if (!l) {
      throw this.#fail(
        t,
        buyerId,
        "buyout",
        "unknown-listing",
        `no listing ${listingId}`,
        `listing:${listingId}`,
      );
    }
    return this.#buyout(l, buyerId, t, "buyout");
  }

  /** Withdraw a listing that has no bid yet; escrowed items go back to the seller. */
  cancel(listingId: string, sellerId: string, now: number): Listing {
    const t = this.#when(now, sellerId, "cancel");
    this.#needAccount(sellerId, t, "cancel");
    const l = this.#listings.get(listingId);
    const ref = `listing:${listingId}`;
    if (!l) throw this.#fail(t, sellerId, "cancel", "unknown-listing", `no listing ${listingId}`, ref);
    if (l.sellerId !== sellerId) {
      throw this.#fail(t, sellerId, "cancel", "not-seller", `${sellerId} is not the seller`, ref);
    }
    if (l.status !== "open") {
      throw this.#fail(t, sellerId, "cancel", "not-open", `listing is ${l.status}`, ref);
    }
    if (l.currentBid !== null) {
      throw this.#fail(t, sellerId, "cancel", "has-bids", "a listing with bids cannot be cancelled", ref);
    }
    l.status = "cancelled";
    l.closedAt = t;
    if (l.sellerKind !== "company") this.#addItems(l.sellerId, l.itemId, l.qty);
    this.#archive(l);
    this.#emit(
      t,
      sellerId,
      "market.cancel",
      "seller withdrew an unbid listing",
      ref,
      l.sellerKind === "company" ? `company:${sellerId}` : `inv:${sellerId}`,
      { listingId: l.id, itemId: l.itemId, qty: l.qty },
      { status: l.status, returned: l.sellerKind === "company" ? 0 : l.qty },
      ["listing", l.sellerKind],
    );
    return view(l);
  }

  /** Settle every open listing whose end has passed: sold to the high bidder, or expired back to the seller. */
  tick(now: number): Settlement[] {
    const t = this.#when(now, HOUSE_ID, "tick");
    const out: Settlement[] = [];
    for (const l of [...this.#listings.values()]) {
      if (l.status !== "open" || l.endsAt > t) continue;
      const kind = this.#def(l.itemId)?.kind ?? "unknown";
      if (l.bidderId !== null && l.currentBid !== null) {
        const buyerId = l.bidderId, price = l.currentBid;
        const { fee, proceeds } = this.#sell(l, buyerId, price, l.endsAt);
        out.push({
          listingId: l.id,
          itemId: l.itemId,
          qty: l.qty,
          status: "sold",
          sellerId: l.sellerId,
          sellerKind: l.sellerKind,
          buyerId,
          price,
          fee,
          proceeds,
          at: l.endsAt,
        });
        this.#emit(
          t,
          HOUSE_ID,
          "market.sold",
          "auction ended with a winning bid",
          `listing:${l.id}`,
          `inv:${buyerId}`,
          {
            listingId: l.id,
            itemId: l.itemId,
            kind,
            qty: l.qty,
            price,
            bids: l.bidCount,
            extensions: l.extensions,
            endsAt: l.endsAt,
          },
          { buyerId, sellerId: l.sellerId, fee, proceeds, unitPrice: r2(price / l.qty) },
          ["settle", kind, l.sellerKind],
        );
      } else {
        l.status = "expired";
        l.closedAt = l.endsAt;
        const returned = l.sellerKind === "company" ? 0 : l.qty;
        if (returned > 0) this.#addItems(l.sellerId, l.itemId, returned);
        this.#archive(l);
        out.push({
          listingId: l.id,
          itemId: l.itemId,
          qty: l.qty,
          status: "expired",
          sellerId: l.sellerId,
          sellerKind: l.sellerKind,
          buyerId: null,
          price: 0,
          fee: 0,
          proceeds: 0,
          at: l.endsAt,
        });
        this.#emit(
          t,
          HOUSE_ID,
          "market.expired",
          "auction ended without a bid",
          `listing:${l.id}`,
          l.sellerKind === "company" ? `company:${l.sellerId}` : `inv:${l.sellerId}`,
          { listingId: l.id, itemId: l.itemId, kind, qty: l.qty, startPrice: l.startPrice, endsAt: l.endsAt },
          { returned },
          ["settle", kind, l.sellerKind],
        );
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- reads
  listing(listingId: string): Listing | null {
    const l = this.#listings.get(listingId);
    return l ? view(l) : null;
  }

  /** Listings in creation order (closed ones are kept up to an archive cap). No filter = all. */
  listings(filter: ListingFilter = {}): Listing[] {
    const out: Listing[] = [];
    for (const l of this.#listings.values()) {
      if (filter.itemId !== undefined && l.itemId !== filter.itemId) continue;
      if (filter.kind !== undefined && this.#def(l.itemId)?.kind !== filter.kind) continue;
      if (filter.sellerKind !== undefined && l.sellerKind !== filter.sellerKind) continue;
      if (filter.status !== undefined && l.status !== filter.status) continue;
      if (filter.sellerId !== undefined && l.sellerId !== filter.sellerId) continue;
      if (filter.bidderId !== undefined && l.bidderId !== filter.bidderId) continue;
      out.push(view(l));
    }
    return out;
  }

  /** What the UI shows on a listing card: min next bid, live buyout price, promo flag, time left. */
  quote(listingId: string, now: number): Quote | null {
    const l = this.#listings.get(listingId);
    if (!l) return null;
    const buyout = this.#buyoutPrice(l, now);
    return {
      listingId,
      open: l.status === "open" && now < l.endsAt,
      minBid: this.#minBid(l),
      buyout,
      promoActive: buyout !== null && buyout !== l.buyout,
      msLeft: Math.max(0, l.endsAt - now),
      fair: Math.round(this.fairValue(l.itemId) * l.qty),
    };
  }

  /** Unit prices of completed sales, oldest first. */
  priceHistory(itemId: string): { t: number; price: number }[] {
    return (this.#history.get(itemId) ?? []).map((p) => ({ t: p.t, price: p.unit }));
  }

  stats(itemId: string, since = -Infinity): MarketStats {
    const pts = (this.#history.get(itemId) ?? []).filter((p) => p.t >= since);
    if (pts.length === 0) {
      return { median: null, mean: null, volatility: 0, volume: 0, last: null, trades: 0 };
    }
    const prices = pts.map((p) => p.unit);
    let sq = 0;
    for (let i = 1; i < prices.length; i++) {
      const r = Math.log(prices[i] / prices[i - 1]);
      sq += r * r;
    }
    return {
      median: r2(median(prices)),
      mean: r2(prices.reduce((s, p) => s + p, 0) / prices.length),
      volatility: prices.length > 1 ? r3(Math.sqrt(sq / (prices.length - 1))) : 0,
      volume: pts.reduce((s, p) => s + p.qty, 0),
      last: prices[prices.length - 1],
      trades: pts.length,
    };
  }

  /**
   * Fair value of ONE unit: the list price until 3 trades exist, then a blend toward the recent
   * median (weight trades/25, capped 0.6), the median clamped to [0.5x, 3x] list so a burst of wash
   * trades cannot drag the NPC valuations anywhere. Unappraised Genemon are worth 0 (NPCs skip them).
   */
  fairValue(itemId: string): number {
    const def = this.#def(itemId);
    if (!def) return 0;
    const hist = this.#history.get(itemId);
    if (!hist || hist.length < FAIR_MIN_TRADES) return def.basePrice;
    const med = median(hist.slice(-FAIR_WINDOW).map((p) => p.unit));
    if (def.basePrice <= 0) return Math.max(1, Math.round(med));
    const anchored = Math.min(def.basePrice * 3, Math.max(def.basePrice * 0.5, med));
    const w = Math.min(0.6, hist.length / 25);
    return Math.max(1, Math.round((1 - w) * def.basePrice + w * anchored));
  }

  /** Conservation check for the Data screen: credits only enter by deposit and leave by withdraw. */
  moneySupply(): MoneySupply {
    let wallets = 0, escrow = 0;
    for (const v of this.#wallets.values()) wallets += v;
    for (const l of this.#listings.values()) {
      if (l.status === "open" && l.currentBid !== null) escrow += l.currentBid;
    }
    return {
      wallets,
      escrow,
      treasury: this.#treasury,
      minted: this.#minted,
      withdrawn: this.#withdrawn,
      balanced: wallets + escrow + this.#treasury === this.#minted - this.#withdrawn,
    };
  }

  /**
   * Wash-trading leads among PLAYER pairs (house accounts trade with everyone by design): repeated
   * trades concentrated on one counterparty, items bouncing back and forth, prices far off reference.
   */
  washTradeSignals(minTrades = 3): WashSignal[] {
    const p2p = this.#trades.filter((tr) => tr.sellerKind === "player" && !isHouseAccount(tr.buyerId));
    const sales = new Map<string, number>();
    for (const tr of p2p) sales.set(tr.sellerId, (sales.get(tr.sellerId) ?? 0) + 1);
    const pairs = new Map<
      string,
      { a: string; b: string; trades: number; ab: number; ba: number; roundTrips: number; offMarket: number }
    >();
    const hops = new Set<string>();
    for (const tr of p2p) {
      const [a, b] = cmp(tr.sellerId, tr.buyerId) <= 0
        ? [tr.sellerId, tr.buyerId]
        : [tr.buyerId, tr.sellerId];
      const key = `${a}\u0000${b}`;
      let p = pairs.get(key);
      if (!p) {
        p = { a, b, trades: 0, ab: 0, ba: 0, roundTrips: 0, offMarket: 0 };
        pairs.set(key, p);
      }
      p.trades++;
      if (tr.sellerId === a) p.ab++;
      else p.ba++;
      if (hops.has(`${tr.itemId}\u0000${tr.buyerId}\u0000${tr.sellerId}`)) p.roundTrips++;
      hops.add(`${tr.itemId}\u0000${tr.sellerId}\u0000${tr.buyerId}`);
      const ref = this.#def(tr.itemId)?.basePrice || this.stats(tr.itemId).median || 0;
      if (ref > 0 && (tr.unit > ref * 2.5 || tr.unit < ref * 0.4)) p.offMarket++;
    }
    const out: WashSignal[] = [];
    for (const p of pairs.values()) {
      if (p.trades < minTrades && p.roundTrips === 0) continue;
      const share = Math.max(p.ab / (sales.get(p.a) || 1), p.ba / (sales.get(p.b) || 1));
      const score = 0.4 * share * Math.min(1, p.trades / minTrades) + 0.4 * Math.min(1, p.roundTrips / 2) +
        0.2 * Math.min(1, p.offMarket / 2);
      out.push({
        a: p.a,
        b: p.b,
        trades: p.trades,
        share: r3(share),
        roundTrips: p.roundTrips,
        offMarket: p.offMarket,
        score: r3(score),
      });
    }
    return out.sort((x, y) => y.score - x.score || cmp(x.a, y.a) || cmp(x.b, y.b));
  }

  // ---------------------------------------------------------------- persistence
  /**
   * Snapshot of the whole house as plain JSON (`JSON.stringify(house)` calls this). Read-only: no
   * ledger row, no state change. See AuctionHouseData for what is inside.
   */
  toJSON(): AuctionHouseData {
    const row = (tr: Trade): TradeRow => [
      tr.t,
      tr.listingId,
      tr.itemId,
      tr.qty,
      tr.unit,
      tr.total,
      tr.sellerId,
      tr.sellerKind,
      tr.buyerId,
    ];
    return {
      format: SNAPSHOT_FORMAT,
      v: SNAPSHOT_VERSION,
      seed: this.seed,
      feeRate: this.feeRate,
      seq: this.#seq,
      clock: this.#clock,
      treasury: this.#treasury,
      minted: this.#minted,
      withdrawn: this.#withdrawn,
      restocks: this.#restocks,
      npcRounds: this.#npcRounds,
      wallets: [...this.#wallets.entries()],
      inventories: [...this.#inv.entries()]
        .filter(([, m]) => m.size > 0)
        .map(([ownerId, m]) => [ownerId, [...m.entries()]]),
      genemons: [...this.#genemons.values()].map((d) => ({ ...d, effects: { ...d.effects } })),
      unique: [...this.#unique],
      listings: [...this.#listings.values()].map(view),
      closed: [...this.#closed],
      history: [...this.#history.entries()].map(([itemId, h]) => [itemId, h.map(row)]),
      trades: this.#trades.map(row),
    };
  }

  /**
   * Rebuild a house from a toJSON() snapshot (typically parsed back from storage). The shape is
   * validated - types, ranges, unique ids, the archive queue against listing statuses, the listing
   * counter against existing ids - and a bad snapshot throws a TypeError naming the faulty path.
   * Restoring emits nothing on the ledger: it is not a market event.
   */
  static fromJSON(data: unknown, opts: AuctionHouseRestoreOptions = {}): AuctionHouse {
    const d = snapRecord(data, "snapshot");
    if (d.format !== SNAPSHOT_FORMAT) snapFail("format", `must be "${SNAPSHOT_FORMAT}"`);
    if (d.v !== SNAPSHOT_VERSION) snapFail("v", `must be ${SNAPSHOT_VERSION}, got ${String(d.v)}`);
    const seed = snapInt(d.seed, "seed");
    if (seed > 0xffffffff) snapFail("seed", "must be a 32-bit unsigned integer");
    const feeRate = snapNumber(d.feeRate, "feeRate");
    if (!(feeRate >= 0 && feeRate < 1)) snapFail("feeRate", "must be in [0, 1)");
    const ah = new AuctionHouse({ seed, feeRate, ledger: opts.ledger });

    snapArray(d.wallets, "wallets").forEach((w, i) => {
      const [ownerId, credits] = snapPair(w, `wallets[${i}]`);
      const id = snapString(ownerId, `wallets[${i}][0]`);
      if (ah.#wallets.has(id)) snapFail(`wallets[${i}]`, `duplicates owner ${id}`);
      ah.#wallets.set(id, snapInt(credits, `wallets[${i}][1]`));
    });
    snapArray(d.inventories, "inventories").forEach((e, i) => {
      const [ownerId, items] = snapPair(e, `inventories[${i}]`);
      const id = snapString(ownerId, `inventories[${i}][0]`);
      if (ah.#inv.has(id)) snapFail(`inventories[${i}]`, `duplicates owner ${id}`);
      const m = new Map<string, number>();
      snapArray(items, `inventories[${i}][1]`).forEach((it, j) => {
        const path = `inventories[${i}][1][${j}]`;
        const [itemId, qty] = snapPair(it, path);
        const key = snapString(itemId, `${path}[0]`);
        if (m.has(key)) snapFail(path, `duplicates item ${key}`);
        m.set(key, snapInt(qty, `${path}[1]`, 1));
      });
      ah.#inv.set(id, m);
    });
    snapArray(d.genemons, "genemons").forEach((g, i) => {
      const def = snapGenemonDef(g, `genemons[${i}]`);
      if (ah.#genemons.has(def.id)) snapFail(`genemons[${i}]`, `duplicates ${def.id}`);
      ah.#genemons.set(def.id, def);
    });
    snapArray(d.unique, "unique").forEach((u, i) => {
      const id = snapString(u, `unique[${i}]`);
      if (!isGenemonItem(id)) snapFail(`unique[${i}]`, `${id} is not a genemon item id`);
      ah.#unique.add(id);
    });

    const seq = snapInt(d.seq, "seq");
    snapArray(d.listings, "listings").forEach((x, i) => {
      const l = snapListing(x, `listings[${i}]`);
      if (ah.#listings.has(l.id)) snapFail(`listings[${i}]`, `duplicates listing ${l.id}`);
      const n = /^L(\d+)$/.exec(l.id);
      if (n && Number(n[1]) > seq) snapFail("seq", `${seq} is behind listing ${l.id} (ids would collide)`);
      ah.#listings.set(l.id, l);
    });
    const closed = snapArray(d.closed, "closed").map((c, i) => snapString(c, `closed[${i}]`));
    const seen = new Set<string>();
    closed.forEach((id, i) => {
      const l = ah.#listings.get(id);
      if (!l) snapFail(`closed[${i}]`, `names unknown listing ${id}`);
      if (l.status === "open") snapFail(`closed[${i}]`, `names open listing ${id}`);
      if (seen.has(id)) snapFail(`closed[${i}]`, `duplicates ${id}`);
      seen.add(id);
    });
    let closedHeld = 0;
    for (const l of ah.#listings.values()) if (l.status !== "open") closedHeld++;
    if (closedHeld !== closed.length) snapFail("closed", "must name every closed listing exactly once");
    for (const id of closed) ah.#closed.push(id);

    snapArray(d.history, "history").forEach((e, i) => {
      const [itemId, rows] = snapPair(e, `history[${i}]`);
      const id = snapString(itemId, `history[${i}][0]`);
      if (ah.#history.has(id)) snapFail(`history[${i}]`, `duplicates item ${id}`);
      const h = snapArray(rows, `history[${i}][1]`).map((r, j) => snapTrade(r, `history[${i}][1][${j}]`));
      h.forEach((tr, j) => {
        if (tr.itemId !== id) snapFail(`history[${i}][1][${j}]`, `is a trade of ${tr.itemId}, not ${id}`);
        if (j > 0 && tr.t < h[j - 1].t) snapFail(`history[${i}][1][${j}]`, "is out of time order");
      });
      ah.#history.set(id, h);
    });
    snapArray(d.trades, "trades").forEach((r, i) => ah.#trades.push(snapTrade(r, `trades[${i}]`)));

    ah.#seq = seq;
    ah.#clock = snapNumber(d.clock, "clock");
    ah.#treasury = snapInt(d.treasury, "treasury");
    ah.#minted = snapInt(d.minted, "minted");
    ah.#withdrawn = snapInt(d.withdrawn, "withdrawn");
    ah.#restocks = snapInt(d.restocks, "restocks");
    ah.#npcRounds = snapInt(d.npcRounds, "npcRounds");
    return ah;
  }

  // ---------------------------------------------------------------- companies & NPCs
  /**
   * Companies top their shelves up to maxOpen: 1-2 lots each, start 75 % of list, buyout list x
   * markup. Each lot gets a flash promotion (-10..40 % on the buyout for 5-30 min) with p = 0.45,
   * and every restock carries at least one promotion.
   */
  companyRestock(now: number): Listing[] {
    const t = this.#when(now, HOUSE_ID, "restock");
    const round = ++this.#restocks;
    const rng = new Rng(hashSeed(this.seed, "restock", round));
    const picks: { co: CompanyDef; def: ItemDef; qty: number }[] = [];
    for (const co of COMPANIES) {
      const pool = COMPANY_POOLS.get(co.id);
      const room = co.maxOpen - this.#countOpen(co.id);
      if (!pool || pool.defs.length === 0 || room <= 0) continue;
      const n = Math.min(room, rng.int(1, 2));
      for (let i = 0; i < n; i++) {
        const def = rng.weighted(pool.defs, pool.w);
        picks.push({ co, def, qty: def.stackable ? rng.int(1, BUNDLE_MAX[def.kind] ?? 1) : 1 });
      }
    }
    const promoted = picks.map(() => rng.chance(0.45));
    if (picks.length > 0 && !promoted.includes(true)) promoted[rng.int(0, picks.length - 1)] = true;
    const posted: Listing[] = [];
    let promos = 0;
    picks.forEach((p, i) => {
      const lot = p.def.basePrice * p.qty;
      const start = Math.max(1, Math.round(lot * 0.75));
      const buyout = Math.max(start, Math.round(lot * p.co.markup));
      let promo: Promo | undefined;
      if (promoted[i]) {
        const pct = 5 * rng.int(2, 8);
        promo = {
          label: `${rng.pick(PROMO_LABELS)} -${pct}%`,
          discount: pct / 100,
          endsAt: t + rng.int(5, 30) * 60_000,
        };
        promos++;
      }
      const why = promo ? "company restock with flash promotion" : "company restock";
      posted.push(
        this.#post(p.co.id, "company", p.def.id, p.qty, start, buyout, COMPANY_LISTING_MS, t, promo, why),
      );
    });
    this.#emit(
      t,
      HOUSE_ID,
      "market.company.restock",
      "companies topped up their shelves",
      "companies",
      "market",
      { round, companies: COMPANIES.length },
      { posted: posted.length, promos },
      ["company"],
    );
    return posted;
  }

  /**
   * One round of NPC trading. Each trader draws from its own stream Rng(hash(seed, id, round)),
   * values items at fairValue x bias x lognormal noise, then acts by personality: the forager
   * gathers world drops and auctions them, the flipper relists last round's buys then hunts
   * underpriced lots and snipes ending auctions, the bargain hunter and the collector buy or bid.
   */
  npcActivity(now: number): NpcAction[] {
    const t = this.#when(now, HOUSE_ID, "npc");
    const round = ++this.#npcRounds;
    const actions: NpcAction[] = [];
    for (const npc of NPC_TRADERS) {
      const rng = new Rng(hashSeed(this.seed, "npc", npc.id, round));
      const bal = this.balance(npc.id);
      if (bal < npc.floor / 2) {
        this.deposit(npc.id, npc.floor - bal, t, `${npc.personality} liquidity budget`);
        actions.push(this.#act(npc, "refill", "credits", null, npc.floor - bal, 0));
      }
      if (npc.personality === "forager") {
        this.#relist(npc, rng, t, actions);
        this.#forage(npc, rng, t, actions);
      } else {
        if (npc.personality === "flipper") this.#relist(npc, rng, t, actions);
        this.#shop(npc, rng, t, actions);
      }
    }
    const count = (a: NpcAction["action"]) => actions.filter((x) => x.action === a).length;
    this.#emit(
      t,
      HOUSE_ID,
      "market.npc.round",
      "npc traders scanned the market",
      "npc",
      "market",
      { round, traders: NPC_TRADERS.length },
      {
        actions: actions.length,
        bids: count("bid"),
        buyouts: count("buyout"),
        posts: count("post"),
        gathers: count("gather"),
        refills: count("refill"),
      },
      ["npc"],
    );
    return actions;
  }

  // ---------------------------------------------------------------- internals: actions
  #post(
    sellerId: string,
    sellerKind: SellerKind,
    itemId: string,
    qty: number,
    startPrice: number,
    buyout: number | null,
    durationMs: number,
    now: number,
    promo: Promo | undefined,
    why: string,
  ): Listing {
    const t = this.#when(now, sellerId, "post");
    this.#needAccount(sellerId, t, "post");
    if (sellerKind === "company") {
      if (!COMPANY_BY_ID.has(sellerId)) {
        throw this.#fail(t, sellerId, "post", "unknown-company", `${sellerId} is not a registered company`);
      }
    } else if (sellerKind === "npc") {
      if (!NPC_BY_ID.has(sellerId)) {
        throw this.#fail(t, sellerId, "post", "unknown-npc", `${sellerId} is not a registered NPC trader`);
      }
    } else if (sellerKind === "player") {
      if (isHouseAccount(sellerId)) {
        throw this.#fail(t, sellerId, "post", "impersonation", `${sellerId} is a house account`);
      }
    } else {
      throw this.#fail(t, sellerId, "post", "invalid-account", `unknown seller kind ${String(sellerKind)}`);
    }
    const def = this.#def(itemId);
    if (!def) throw this.#fail(t, sellerId, "post", "unknown-item", `no item ${itemId}`);
    if (def.kind === "genemon" && sellerKind === "company") {
      throw this.#fail(t, sellerId, "post", "forbidden", "companies do not sell Genemon");
    }
    this.#needAmount(qty, t, sellerId, "post", "qty");
    if (!def.stackable && qty !== 1) {
      throw this.#fail(t, sellerId, "post", "not-stackable", `${itemId} is listed one unit at a time`);
    }
    this.#needAmount(startPrice, t, sellerId, "post", "startPrice");
    if (buyout !== null) {
      this.#needAmount(buyout, t, sellerId, "post", "buyout");
      if (buyout < startPrice) {
        throw this.#fail(t, sellerId, "post", "invalid-amount", "buyout below start price");
      }
    }
    if (!Number.isInteger(durationMs) || durationMs < MIN_DURATION_MS || durationMs > MAX_DURATION_MS) {
      throw this.#fail(
        t,
        sellerId,
        "post",
        "invalid-duration",
        `duration must be ${MIN_DURATION_MS}..${MAX_DURATION_MS} ms`,
      );
    }
    const endsAt = t + durationMs;
    let deal: Promo | undefined;
    if (promo) {
      if (sellerKind !== "company") {
        throw this.#fail(t, sellerId, "post", "promo-company-only", "only companies run promotions");
      }
      if (buyout === null) {
        throw this.#fail(t, sellerId, "post", "no-buyout", "a promotion discounts the buyout: set one");
      }
      const discount = Math.round(promo.discount * 100) / 100;
      if (!(discount >= 0.05 && discount <= 0.9) || !Number.isFinite(promo.endsAt) || promo.endsAt <= t) {
        throw this.#fail(
          t,
          sellerId,
          "post",
          "invalid-promo",
          "discount must be 0.05..0.9 and end in the future",
        );
      }
      deal = { label: String(promo.label).slice(0, 48), discount, endsAt: Math.min(promo.endsAt, endsAt) };
    }
    if (sellerKind !== "company") {
      const have = this.#held(sellerId, itemId);
      if (have < qty) {
        throw this.#fail(
          t,
          sellerId,
          "post",
          "insufficient-items",
          `needs ${qty} ${itemId}, has ${have}`,
          `inv:${sellerId}`,
        );
      }
      this.#addItems(sellerId, itemId, -qty);
    }
    const l: Listing = {
      id: `L${++this.#seq}`,
      sellerId,
      sellerKind,
      itemId,
      qty,
      startPrice,
      buyout,
      currentBid: null,
      bidderId: null,
      createdAt: t,
      endsAt,
      status: "open",
      bidCount: 0,
      extensions: 0,
      buyerId: null,
      finalPrice: null,
      closedAt: null,
    };
    if (deal) l.promo = deal;
    this.#listings.set(l.id, l);
    this.#emit(
      t,
      sellerId,
      "market.post",
      why,
      sellerKind === "company" ? `company:${sellerId}` : `inv:${sellerId}`,
      `listing:${l.id}`,
      {
        itemId,
        kind: def.kind,
        qty,
        startPrice,
        buyout: buyout ?? 0,
        hasBuyout: buyout !== null,
        durationMs,
        promoDiscount: deal?.discount ?? 0,
        promoLabel: deal?.label ?? "",
      },
      {
        listingId: l.id,
        endsAt,
        promoEndsAt: deal?.endsAt ?? 0,
        fair: Math.round(this.fairValue(itemId) * qty),
      },
      ["listing", def.kind, sellerKind],
    );
    return view(l);
  }

  #bid(l: Listing, bidderId: string, amount: number, t: number, why: string): Listing {
    const ref = `listing:${l.id}`;
    if (l.status !== "open") throw this.#fail(t, bidderId, "bid", "not-open", `listing is ${l.status}`, ref);
    if (t >= l.endsAt) throw this.#fail(t, bidderId, "bid", "ended", "auction already ended", ref);
    if (bidderId === l.sellerId) {
      throw this.#fail(t, bidderId, "bid", "own-listing", "cannot bid on your own listing", ref);
    }
    this.#needAmount(amount, t, bidderId, "bid", "amount");
    const buyNow = this.#buyoutPrice(l, t);
    if (buyNow !== null && amount >= buyNow) {
      return this.#buyout(l, bidderId, t, `${why} (reached the buyout price)`);
    }
    const minBid = this.#minBid(l);
    if (amount < minBid) throw this.#fail(t, bidderId, "bid", "bid-too-low", `minimum bid is ${minBid}`, ref);
    const held = l.bidderId === bidderId ? (l.currentBid ?? 0) : 0;
    const need = amount - held;
    if (this.balance(bidderId) < need) {
      throw this.#fail(
        t,
        bidderId,
        "bid",
        "insufficient-funds",
        `needs ${need}, has ${this.balance(bidderId)}`,
        ref,
      );
    }
    const prevBid = l.currentBid ?? 0;
    let refundTo = "none", refundAmount = 0;
    if (l.bidderId !== null && l.bidderId !== bidderId) {
      this.#credit(l.bidderId, prevBid);
      refundTo = l.bidderId;
      refundAmount = prevBid;
    }
    this.#credit(bidderId, -need);
    l.currentBid = amount;
    l.bidderId = bidderId;
    l.bidCount++;
    const msLeft = l.endsAt - t;
    const extended = msLeft <= ANTI_SNIPE_WINDOW_MS;
    if (extended) {
      l.endsAt += ANTI_SNIPE_EXTEND_MS;
      l.extensions++;
    }
    const kind = this.#def(l.itemId)?.kind ?? "unknown";
    this.#emit(
      t,
      bidderId,
      "market.bid",
      extended ? `${why}; anti-sniping extension` : why,
      `wallet:${bidderId}`,
      ref,
      { listingId: l.id, itemId: l.itemId, qty: l.qty, amount, minBid, prevBid, msLeft },
      {
        currentBid: amount,
        endsAt: l.endsAt,
        extended,
        refundTo,
        refundAmount,
        balance: this.balance(bidderId),
      },
      ["bid", kind, l.sellerKind],
    );
    return view(l);
  }

  #buyout(l: Listing, buyerId: string, t: number, why: string): Listing {
    const ref = `listing:${l.id}`;
    if (l.status !== "open") {
      throw this.#fail(t, buyerId, "buyout", "not-open", `listing is ${l.status}`, ref);
    }
    if (t >= l.endsAt) throw this.#fail(t, buyerId, "buyout", "ended", "auction already ended", ref);
    if (buyerId === l.sellerId) {
      throw this.#fail(t, buyerId, "buyout", "own-listing", "cannot buy your own listing", ref);
    }
    const price = this.#buyoutPrice(l, t);
    if (price === null) {
      throw this.#fail(t, buyerId, "buyout", "no-buyout", "listing has no buyout price", ref);
    }
    const credit = l.bidderId === buyerId ? (l.currentBid ?? 0) : 0;
    if (this.balance(buyerId) + credit < price) {
      throw this.#fail(
        t,
        buyerId,
        "buyout",
        "insufficient-funds",
        `needs ${price}, has ${this.balance(buyerId) + credit}`,
        ref,
      );
    }
    let refundTo = "none", refundAmount = 0;
    if (l.bidderId !== null && l.currentBid !== null) {
      this.#credit(l.bidderId, l.currentBid);
      refundTo = l.bidderId;
      refundAmount = l.currentBid;
    }
    this.#credit(buyerId, -price);
    const listPrice = l.buyout ?? price;
    const { fee, proceeds } = this.#sell(l, buyerId, price, t);
    const kind = this.#def(l.itemId)?.kind ?? "unknown";
    this.#emit(
      t,
      buyerId,
      "market.buyout",
      why,
      `wallet:${buyerId}`,
      `inv:${buyerId}`,
      {
        listingId: l.id,
        itemId: l.itemId,
        kind,
        qty: l.qty,
        price,
        listPrice,
        promoActive: price !== listPrice,
        discount: l.promo?.discount ?? 0,
      },
      {
        sellerId: l.sellerId,
        fee,
        proceeds,
        refundTo,
        refundAmount,
        balance: this.balance(buyerId),
        unitPrice: r2(price / l.qty),
      },
      ["buyout", kind, l.sellerKind],
    );
    return view(l);
  }

  /** Close a sale: item to the buyer, price - fee to the seller, fee to the treasury, price recorded. */
  #sell(l: Listing, buyerId: string, price: number, at: number): { fee: number; proceeds: number } {
    const fee = this.#feeBps === 0 ? 0 : Math.min(price, Math.ceil((price * this.#feeBps) / 10_000));
    const proceeds = price - fee;
    this.#credit(l.sellerId, proceeds);
    this.#treasury += fee;
    this.#addItems(buyerId, l.itemId, l.qty);
    l.status = "sold";
    l.buyerId = buyerId;
    l.finalPrice = price;
    l.closedAt = at;
    this.#record({
      t: at,
      listingId: l.id,
      itemId: l.itemId,
      qty: l.qty,
      unit: r2(price / l.qty),
      total: price,
      sellerId: l.sellerId,
      sellerKind: l.sellerKind,
      buyerId,
    });
    this.#archive(l);
    return { fee, proceeds };
  }

  // ---------------------------------------------------------------- internals: NPC behaviour
  #shop(npc: NpcTrader, rng: Rng, t: number, actions: NpcAction[]): void {
    let done = 0;
    const candidates = rng.shuffle(this.#openListings(t).filter((l) => l.sellerId !== npc.id));
    for (const l of candidates) {
      if (done >= npc.maxActions) break;
      if (l.status !== "open" || t >= l.endsAt) continue;
      const def = this.#def(l.itemId);
      if (!def || !this.#wants(npc, def)) continue;
      const fair = this.fairValue(l.itemId) * l.qty;
      if (fair <= 0 || (npc.personality === "flipper" && fair < 20)) continue;
      const value = fair * npc.bias * Math.exp(rng.normal(0, npc.noise));
      const budget = Math.floor(this.balance(npc.id) * npc.spendShare);
      const price = this.#buyoutPrice(l, t);
      if (price !== null && price <= value * npc.buyBelow && price <= budget) {
        const pct = Math.round((1 - price / fair) * 100);
        this.#buyout(l, npc.id, t, `${npc.personality}: buyout ${pct}% under fair value`);
        actions.push(this.#act(npc, "buyout", l.itemId, l.id, price, l.qty));
        done++;
        continue;
      }
      if (l.bidderId === npc.id) continue;
      if (npc.personality === "flipper" && l.endsAt - t > SNIPE_HORIZON_MS) continue;
      const minBid = this.#minBid(l);
      if (minBid <= value * npc.bidBelow && minBid <= budget) {
        const after = this.#bid(l, npc.id, minBid, t, `${npc.personality}: bid under private valuation`);
        actions.push(
          this.#act(npc, after.status === "sold" ? "buyout" : "bid", l.itemId, l.id, minBid, l.qty),
        );
        done++;
      }
    }
  }

  #wants(npc: NpcTrader, def: ItemDef): boolean {
    const rank = RARITY_RANK[def.rarity];
    switch (npc.personality) {
      case "bargainHunter":
      case "flipper":
        return def.kind !== "genemon";
      case "collector":
        return rank >= 2 ||
          ((def.kind === "egg" || def.kind === "cosmetic" || def.kind === "genemon") && rank >= 1);
      case "forager":
        return false;
    }
  }

  /** Relist held stock (the flipper's buys at a margin, the forager's unsold lots as clearance). */
  #relist(npc: NpcTrader, rng: Rng, t: number, actions: NpcAction[]): void {
    let posts = 0;
    for (const [itemId, qty] of Object.entries(this.inventory(npc.id))) {
      if (posts >= npc.maxActions || this.#countOpen(npc.id) >= NPC_MAX_OPEN) break;
      const def = this.#def(itemId);
      const fair = this.fairValue(itemId);
      if (!def || fair <= 0) continue;
      const lot = def.stackable ? qty : 1;
      const buyout = Math.max(1, Math.round(fair * lot * rng.range(npc.relist[0], npc.relist[1])));
      const start = Math.max(1, Math.min(buyout, Math.round(fair * lot * npc.relist[0] * 0.85)));
      const why = npc.personality === "forager"
        ? "forager: clearance of an unsold lot"
        : `${npc.personality}: relist at margin`;
      const l = this.#post(
        npc.id,
        "npc",
        itemId,
        lot,
        start,
        buyout,
        NPC_LISTING_MS * rng.int(1, 3),
        t,
        undefined,
        why,
      );
      actions.push(this.#act(npc, "post", itemId, l.id, buyout, lot));
      posts++;
    }
  }

  /** The wild supply: gather 1..maxActions world drops (rarity-weighted) and auction them. */
  #forage(npc: NpcTrader, rng: Rng, t: number, actions: NpcAction[]): void {
    const n = rng.int(1, npc.maxActions);
    for (let i = 0; i < n && this.#countOpen(npc.id) < NPC_MAX_OPEN; i++) {
      const def = rng.weighted(FORAGE_POOL.defs, FORAGE_POOL.w);
      const qty = def.stackable ? rng.int(1, BUNDLE_MAX[def.kind] ?? 1) : 1;
      this.give(npc.id, def.id, qty, t, "forager: world drop gathered");
      actions.push(this.#act(npc, "gather", def.id, null, 0, qty));
      const fair = this.fairValue(def.id) * qty;
      const start = Math.max(1, Math.round(fair * rng.range(0.7, 0.9)));
      const buyout = Math.max(start, Math.round(fair * rng.range(npc.markup[0], npc.markup[1])));
      const l = this.#post(
        npc.id,
        "npc",
        def.id,
        qty,
        start,
        buyout,
        NPC_LISTING_MS,
        t,
        undefined,
        "forager: auction a world drop",
      );
      actions.push(this.#act(npc, "post", def.id, l.id, buyout, qty));
    }
  }

  #act(
    npc: NpcTrader,
    action: NpcAction["action"],
    itemId: string,
    listingId: string | null,
    amount: number,
    qty: number,
  ): NpcAction {
    return { npcId: npc.id, personality: npc.personality, action, itemId, listingId, amount, qty };
  }

  // ---------------------------------------------------------------- internals: bookkeeping
  #def(itemId: string): ItemDef | undefined {
    return this.#genemons.get(itemId) ?? itemDef(itemId);
  }

  #buyoutPrice(l: Listing, t: number): number | null {
    if (l.buyout === null) return null;
    if (!l.promo || t >= l.promo.endsAt) return l.buyout;
    const pct = Math.round(l.promo.discount * 100);
    return Math.max(1, Math.round((l.buyout * (100 - pct)) / 100));
  }

  #minBid(l: Listing): number {
    if (l.currentBid === null) return l.startPrice;
    return l.currentBid + Math.max(1, Math.ceil((l.currentBid * MIN_INCREMENT_BPS) / 10_000));
  }

  #openListings(t: number): Listing[] {
    const out: Listing[] = [];
    for (const l of this.#listings.values()) if (l.status === "open" && t < l.endsAt) out.push(l);
    return out;
  }

  #countOpen(sellerId: string): number {
    let n = 0;
    for (const l of this.#listings.values()) if (l.status === "open" && l.sellerId === sellerId) n++;
    return n;
  }

  #credit(ownerId: string, delta: number): number {
    const v = (this.#wallets.get(ownerId) ?? 0) + delta;
    this.#wallets.set(ownerId, v);
    return v;
  }

  #held(ownerId: string, itemId: string): number {
    return this.#inv.get(ownerId)?.get(itemId) ?? 0;
  }

  #addItems(ownerId: string, itemId: string, delta: number): number {
    let m = this.#inv.get(ownerId);
    if (!m) {
      m = new Map();
      this.#inv.set(ownerId, m);
    }
    const v = (m.get(itemId) ?? 0) + delta;
    if (v > 0) m.set(itemId, v);
    else m.delete(itemId);
    return Math.max(0, v);
  }

  #record(tr: Trade): void {
    let h = this.#history.get(tr.itemId);
    if (!h) {
      h = [];
      this.#history.set(tr.itemId, h);
    }
    let i = h.length;
    while (i > 0 && h[i - 1].t > tr.t) i--;
    h.splice(i, 0, tr);
    if (h.length > HISTORY_CAP) h.splice(0, h.length - HISTORY_CAP);
    this.#trades.push(tr);
    if (this.#trades.length > TRADE_LOG_CAP) this.#trades.splice(0, this.#trades.length - TRADE_LOG_CAP);
  }

  /** Closed listings stay readable up to ARCHIVE_CAP, then the oldest closed ones are dropped. */
  #archive(l: Listing): void {
    this.#closed.push(l.id);
    while (this.#closed.length > ARCHIVE_CAP) this.#listings.delete(this.#closed.shift()!);
  }

  #when(now: number | undefined, who: string, action: string): number {
    if (now === undefined) return this.#clock;
    if (!Number.isFinite(now)) {
      throw this.#fail(
        this.#clock,
        String(who),
        action,
        "invalid-time",
        `now must be a finite ms timestamp, got ${now}`,
      );
    }
    if (now > this.#clock) this.#clock = now;
    return now;
  }

  #needAccount(id: string, t: number, action: string): void {
    if (typeof id !== "string" || id.trim().length === 0 || id.length > 64) {
      throw this.#fail(
        t,
        String(id),
        action,
        "invalid-account",
        "account ids are non-empty strings of at most 64 chars",
      );
    }
  }

  #needPlayer(id: string, t: number, action: string): void {
    this.#needAccount(id, t, action);
    if (isHouseAccount(id)) throw this.#fail(t, id, action, "impersonation", `${id} is a house account`);
  }

  #needAmount(n: number, t: number, who: string, action: string, label: string): void {
    if (!Number.isInteger(n) || n < 1 || n > MAX_CREDITS) {
      throw this.#fail(
        t,
        who,
        action,
        "invalid-amount",
        `${label} must be an integer in 1..${MAX_CREDITS}, got ${n}`,
      );
    }
  }

  /** Log the refusal (anti-fraud and UX analytics read these) and hand back the error to throw. */
  #fail(
    t: number,
    who: string,
    action: string,
    code: MarketErrorCode,
    message: string,
    ref = "market",
  ): MarketError {
    this.#emit(t, who, "market.reject", message, who, ref, { action, code }, { accepted: false }, [
      "reject",
      code,
    ]);
    return new MarketError(code, message);
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
    tags: readonly string[],
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
      tags: ["market", ...tags],
    });
  }
}

export interface NpcAction {
  npcId: string;
  personality: NpcPersonality;
  action: "refill" | "gather" | "post" | "bid" | "buyout";
  itemId: string;
  listingId: string | null;
  /** Credits involved: bid, price paid, buyout asked, refill amount (0 for a gather). */
  amount: number;
  qty: number;
}

// ------------------------------------------------------------------ snapshot validation (fromJSON)
const SELLER_KINDS: readonly SellerKind[] = ["company", "npc", "player"];
const LISTING_STATUSES: readonly ListingStatus[] = ["open", "sold", "expired", "cancelled"];

function snapFail(path: string, problem: string): never {
  throw new TypeError(`AuctionHouse.fromJSON: ${path} ${problem}`);
}

function snapRecord(v: unknown, path: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) snapFail(path, "must be an object");
  return v as Record<string, unknown>;
}

function snapArray(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) snapFail(path, "must be an array");
  return v;
}

function snapPair(v: unknown, path: string): [unknown, unknown] {
  const a = snapArray(v, path);
  if (a.length !== 2) snapFail(path, "must be a [key, value] pair");
  return [a[0], a[1]];
}

function snapString(v: unknown, path: string): string {
  if (typeof v !== "string" || v.length === 0) snapFail(path, "must be a non-empty string");
  return v;
}

function snapText(v: unknown, path: string): string {
  if (typeof v !== "string") snapFail(path, "must be a string");
  return v;
}

function snapNumber(v: unknown, path: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) snapFail(path, "must be a finite number");
  return v;
}

function snapInt(v: unknown, path: string, min = 0): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min) {
    snapFail(path, `must be an integer >= ${min}`);
  }
  return v;
}

function snapIntOrNull(v: unknown, path: string): number | null {
  return v === null ? null : snapInt(v, path, 1);
}

function snapStringOrNull(v: unknown, path: string): string | null {
  return v === null ? null : snapString(v, path);
}

function snapOneOf<T extends string>(v: unknown, options: readonly T[], path: string): T {
  if (typeof v !== "string" || !(options as readonly string[]).includes(v)) {
    snapFail(path, `must be one of ${options.join(", ")}`);
  }
  return v as T;
}

/** Fields are rebuilt in the order #post creates them, so a re-snapshot is byte-identical. */
function snapListing(v: unknown, path: string): Listing {
  const o = snapRecord(v, path);
  const l: Listing = {
    id: snapString(o.id, `${path}.id`),
    sellerId: snapString(o.sellerId, `${path}.sellerId`),
    sellerKind: snapOneOf(o.sellerKind, SELLER_KINDS, `${path}.sellerKind`),
    itemId: snapString(o.itemId, `${path}.itemId`),
    qty: snapInt(o.qty, `${path}.qty`, 1),
    startPrice: snapInt(o.startPrice, `${path}.startPrice`, 1),
    buyout: snapIntOrNull(o.buyout, `${path}.buyout`),
    currentBid: snapIntOrNull(o.currentBid, `${path}.currentBid`),
    bidderId: snapStringOrNull(o.bidderId, `${path}.bidderId`),
    createdAt: snapNumber(o.createdAt, `${path}.createdAt`),
    endsAt: snapNumber(o.endsAt, `${path}.endsAt`),
    status: snapOneOf(o.status, LISTING_STATUSES, `${path}.status`),
    bidCount: snapInt(o.bidCount, `${path}.bidCount`),
    extensions: snapInt(o.extensions, `${path}.extensions`),
    buyerId: snapStringOrNull(o.buyerId, `${path}.buyerId`),
    finalPrice: snapIntOrNull(o.finalPrice, `${path}.finalPrice`),
    closedAt: o.closedAt === null ? null : snapNumber(o.closedAt, `${path}.closedAt`),
  };
  if (o.promo !== undefined) {
    const p = snapRecord(o.promo, `${path}.promo`);
    l.promo = {
      label: snapText(p.label, `${path}.promo.label`),
      discount: snapNumber(p.discount, `${path}.promo.discount`),
      endsAt: snapNumber(p.endsAt, `${path}.promo.endsAt`),
    };
  }
  if ((l.currentBid === null) !== (l.bidderId === null)) {
    snapFail(path, "must carry currentBid and bidderId together");
  }
  if (l.status === "sold" && (l.buyerId === null || l.finalPrice === null)) {
    snapFail(path, "is sold without a buyer or a final price");
  }
  return l;
}

/** Same field order as genemonItemDef. */
function snapGenemonDef(v: unknown, path: string): ItemDef {
  const o = snapRecord(v, path);
  const id = snapString(o.id, `${path}.id`);
  if (!isGenemonItem(id)) snapFail(`${path}.id`, `${id} is not a genemon item id`);
  if (o.kind !== "genemon") snapFail(`${path}.kind`, `must be "genemon"`);
  if (o.stackable !== false) snapFail(`${path}.stackable`, "must be false (a Genemon is unique)");
  const fx = snapRecord(o.effects, `${path}.effects`);
  const effects: Record<string, number | string> = {};
  for (const [k, x] of Object.entries(fx)) {
    if (typeof x === "string" || (typeof x === "number" && Number.isFinite(x))) effects[k] = x;
    else snapFail(`${path}.effects.${k}`, "must be a string or a finite number");
  }
  return {
    id,
    name: snapText(o.name, `${path}.name`),
    kind: "genemon",
    basePrice: snapInt(o.basePrice, `${path}.basePrice`),
    rarity: snapOneOf(o.rarity, RARITIES, `${path}.rarity`),
    stackable: false,
    effects,
    note: snapText(o.note, `${path}.note`),
  };
}

function snapTrade(v: unknown, path: string): Trade {
  const a = snapArray(v, path);
  if (a.length !== 9) snapFail(path, "must be a 9-field trade row");
  return {
    t: snapNumber(a[0], `${path}[0]`),
    listingId: snapString(a[1], `${path}[1]`),
    itemId: snapString(a[2], `${path}[2]`),
    qty: snapInt(a[3], `${path}[3]`, 1),
    unit: snapNumber(a[4], `${path}[4]`),
    total: snapInt(a[5], `${path}[5]`, 1),
    sellerId: snapString(a[6], `${path}[6]`),
    sellerKind: snapOneOf(a[7], SELLER_KINDS, `${path}[7]`),
    buyerId: snapString(a[8], `${path}[8]`),
  };
}
