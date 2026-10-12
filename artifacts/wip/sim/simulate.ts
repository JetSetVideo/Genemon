/**
 * Persona simulator (pure, deterministic): the personas of src/sim/personas.ts live `weeks` weeks of
 * simulated time in ONE shared world, through the REAL engine, and every action is a ledger row.
 *
 * Clock: local Europe/Paris time at a fixed UTC offset (DST not modelled). The run starts at the
 * local midnight of `startMs` and advances hour by hour; inside an hour, events run in time order:
 * market rounds (AuctionHouse.tick + npcActivity every `marketStepMin`, companyRestock every third
 * round) and the persona actions planned for that minute.
 *
 * Per persona and day, sessions are drawn INSIDE the play blocks of its own timetable (playBlocks):
 * expected minutes = block length x playIntensity, lengths within sessionLengthMin. Per session,
 * actions come from the persona's style (rates per session hour, see STYLE): ranked battles against
 * ONLINE personas on one shared Ladder (rankedConditions + isRated + matchContext computed BEFORE
 * the battle + matchResultFrom), practice battles against the app's "wild" opponent when the queue
 * is empty, catches (WorldMap.rollSpawn + catchAllowed + actionAllowed: on site in physical blocks,
 * catch.virtual in a dungeon otherwise), territory claims (WorldMap.claim, presence required),
 * releases (physical "release"), breeding (breed + createGenemon), market buys/flips in ONE
 * AuctionHouse. The first session of the day feeds the companion the persona's diet (feed; the
 * uncommon "fantasy" foods must come out of the market inventory via take), experiencesPerWeek are
 * spread over the week's sessions through live() (physical-only ones over physical sessions only),
 * physical sessions expose the companion to the place's ground. Achievements and quests: one
 * src/progress Progress per persona, fed with the persona's ledger rows.
 *
 * Simplifications (docs/SIMULATION.md): battles log at "summary" detail; places are each persona's
 * generated neighbourhood (no shared landmarks); no friendly/co-op play; teams are autoTeam with the
 * companion forced in; personas do not sell Genemon on the market.
 */
import { type GEvent, Ledger, type Scalar, type Where } from "../core/ledger.ts";
import { clamp, r3, type V3 } from "../core/math.ts";
import { hashSeed, Rng } from "../core/rng.ts";
import type { AxisId, AxisVector } from "../data/axes.ts";
import { ELEMENTS, type ElementId } from "../data/elements.ts";
import { EXPERIENCES, type ExperienceId, type FoodId } from "../data/lifestyle.ts";
import type { WeatherId } from "../data/weather.ts";
import { applyBattleResult, Battle, type BattleResult } from "../combat/battle.ts";
import { autoTeam, TEAM_CAPACITY, type Team } from "../combat/team.ts";
import { age, createGenemon, expose, feed, type Genemon, type LifeCtx, live, phenotypeOf } from "../genome/genemon.ts";
import { breed } from "../genome/breeding.ts";
import { Ladder } from "../ladder/mmr.ts";
import { matchContext, matchResultFrom } from "../ladder/context.ts";
import { isRated, rankedConditions } from "../ladder/ranked.ts";
import { AuctionHouse, MarketError, type MoneySupply } from "../economy/market.ts";
import { foodItemId, ITEMS } from "../economy/items.ts";
import { catchAllowed, type Place, type PlaceKind, WorldMap } from "../world/worldmap.ts";
import { ARENA_INFO, ARENA_KINDS, type ArenaSpec } from "../world/arena.ts";
import { type IngestResult, Progress } from "../progress/progress.ts";
import { weatherOfDay } from "../ui/realworld.ts";
import { correlation, median, quantile, std } from "../ml/stats.ts";
import { type Activity, type Persona, PERSONAS, type PlayStyle, playBlocks } from "./personas.ts";

// ---------------------------------------------------------------- public API

export interface SimOptions {
  /** Personas to simulate (default: the 12 of PERSONAS). */
  personas?: readonly Persona[];
  /** Simulated weeks (days = round(weeks x 7), at least 1). */
  weeks: number;
  seed: number;
  /** Epoch ms; the run starts at the local midnight of this instant. */
  startMs: number;
  /** Optional: every engine and simulator row is emitted here. */
  ledger?: Ledger;
  /** Local clock = UTC + this many hours (Europe/Paris, DST not modelled). Default 2. */
  utcOffsetH?: number;
  /** Battles one session may start (runtime cap). Default 4. */
  battlesPerSession?: number;
  /** Minutes between market rounds. Default 5. */
  marketStepMin?: number;
}

export interface WinTally {
  games: number;
  wins: number;
  losses: number;
  draws: number;
}

export interface SimPersonaReport {
  id: string;
  name: string;
  style: PlayStyle;
  secondaryStyle: PlayStyle;
  skill: number;
  sessions: number;
  playHours: number;
  /** Timetable expectation over the same days: sum of block length x playIntensity. */
  expectedPlayHours: number;
  physicalHours: number;
  /** Hours played per local hour of day (24 buckets). */
  hoursByHour: number[];
  battles: WinTally;
  ranked: WinTally;
  queueEmpty: number;
  rating: number | null;
  rank: number | null;
  ratingDelta: number;
  collection: number;
  caught: number;
  caughtOnSite: number;
  released: number;
  bred: number;
  maxGeneration: number;
  /** Distinct body kind x primary x secondary owned at any time (docs/PERSONAS.md Q5). */
  pokedex: number;
  /** Distinct body kind x primary. */
  families: number;
  pokedexGoal: number;
  favouriteMoves: { move: string; uses: number }[];
  declaredFavouriteCasts: number;
  achievements: string[];
  questsCompleted: number;
  rewardCredits: number;
  credits: number;
  spent: number;
  trades: number;
  placesDiscovered: number;
  physicalActions: number;
  deniedPhysical: number;
  territories: number;
  claims: number;
  takeovers: number;
  cellsLost: number;
  companion: { name: string; level: number; primary: ElementId; hunger: number; rhythm: number };
  /** Mean hunger of the team members that are not the companion (only the companion is fed). */
  teamHunger: number;
  missingFood: number;
  frustrations: Record<string, number>;
}

export interface SimReport {
  meta: {
    seed: number;
    weeks: number;
    days: number;
    startMs: number;
    endMs: number;
    utcOffsetH: number;
    personas: string[];
    marketRounds: number;
    rows: number;
    rowsByWhat: Record<string, number>;
    progressErrors: number;
  };
  personas: SimPersonaReport[];
  world: {
    places: number;
    placesDiscovered: number;
    territories: Record<string, number>;
    claims: number;
    takeovers: number;
    failedRaids: number;
    lostWhileAsleep: number;
    catchesByElement: Record<string, number>;
    releasesByElement: Record<string, number>;
    catchesByRarity: Record<string, number>;
    catchesOnSite: number;
    catchesVirtual: number;
  };
  market: {
    trades: number;
    unitsTraded: number;
    creditsTraded: number;
    personaTrades: number;
    moneySupply: MoneySupply;
    npcRefills: number;
    rewardFaucet: number;
    openingBalances: number;
    openListings: number;
    items: { itemId: string; trades: number; units: number; median: number; list: number; drift: number }[];
    medianPrices: Record<string, number>;
    walletGini: number;
  };
  balance: {
    winRateByStyle: (WinTally & { style: string; winRate: number | null })[];
    elementUsage: { element: string; casts: number; share: number }[];
    elementEntropy: number;
    ratingSpread: { n: number; min: number; max: number; sd: number; iqr: number; spearmanSkill: number | null };
    rankedMatches: number;
    battles: number;
    drawRate: number;
    meanDurationS: number;
    emptyQueueByHour: number[];
  };
}

// ---------------------------------------------------------------- data

const MIN_MS = 60_000, HOUR_MS = 3_600_000, DAY_MS = 86_400_000;
const OPENING_CREDITS = 500; // src/ui/profile.ts default credits
const STARTER_LEVEL = 5;
const MISMATCH = 300; // docs/PERSONAS.md 9.1.8 skill-mismatch detector
const SIM_WHERE: Where = { x: 0, y: 0, z: 0, zone: "sim", space: "sim" };
const HOME_VIRTUAL: Where = { x: 0, y: 0, z: 0, zone: "home", space: "virtual" };

/** Actions per SESSION HOUR by style (secondary style adds a quarter), breeding per week, kept collection. */
interface Rates {
  battle: number;
  ranked: number;
  catch: number;
  claim: number;
  market: number;
  breed: number;
  keep: number;
}
const STYLE: Record<PlayStyle, Rates> = {
  collector: { battle: 0.5, ranked: 0, catch: 3, claim: 0, market: 0.5, breed: 0, keep: 80 },
  competitor: { battle: 5, ranked: 1, catch: 0.3, claim: 0.2, market: 0.3, breed: 0, keep: 20 },
  explorer: { battle: 0.6, ranked: 0.2, catch: 2.5, claim: 0.6, market: 0.3, breed: 0, keep: 40 },
  breeder: { battle: 0.8, ranked: 0.3, catch: 1, claim: 0, market: 0.8, breed: 7, keep: 40 },
  trader: { battle: 0.4, ranked: 0.3, catch: 0.8, claim: 0.3, market: 6, breed: 0, keep: 25 },
  socializer: { battle: 1.5, ranked: 0.3, catch: 1, claim: 0.2, market: 0.6, breed: 0, keep: 40 },
  casual: { battle: 1, ranked: 0.3, catch: 0.8, claim: 0, market: 1, breed: 0, keep: 15 },
  completionist: { battle: 0.6, ranked: 0.3, catch: 2.5, claim: 0.2, market: 1.5, breed: 1, keep: 150 },
  theorycrafter: { battle: 3, ranked: 0, catch: 0.5, claim: 0, market: 0, breed: 2, keep: 60 },
  territorial: { battle: 1.5, ranked: 0.7, catch: 0.8, claim: 4, market: 0.4, breed: 0, keep: 20 },
  storyteller: { battle: 0.1, ranked: 0, catch: 0.8, claim: 0, market: 0.3, breed: 2, keep: 30 },
  speedrunner: { battle: 3, ranked: 0.8, catch: 0.5, claim: 0, market: 0.2, breed: 0, keep: 15 },
};

function ratesOf(p: Persona): Rates {
  const a = STYLE[p.style], b = STYLE[p.secondaryStyle];
  const mix = (k: "battle" | "catch" | "claim" | "market" | "breed") => a[k] + 0.25 * b[k];
  return {
    battle: mix("battle"),
    ranked: a.ranked > 0 ? a.ranked : 0.25 * b.ranked,
    catch: mix("catch"),
    claim: mix("claim"),
    market: mix("market"),
    breed: mix("breed"),
    keep: Math.max(a.keep, b.keep),
  };
}

/** Where a physical block happens (the timetable has no place: docs/PERSONAS.md Q2). */
const ACTIVITY_PLACES: Partial<Record<Activity, readonly PlaceKind[]>> = {
  walk: ["park", "river", "lake", "beach", "forest", "garden", "mountain"],
  shopping: ["supermarket", "farmersMarket", "harbour", "cafe"],
  gym: ["gym", "pool", "lake"],
  commute: ["station", "plaza"],
  lunch: ["cafe", "park", "plaza", "garden"],
  social: ["park", "plaza", "cafe", "landmark", "beach"],
  work: ["farmersMarket", "office"],
  travel: ["station"],
};

/** Foods that are not common items (glow fruit, ash root): they exist only in the market / world. */
const FANTASY = new Set<string>(
  Object.values(ITEMS).filter((d) => d.kind === "food" && d.rarity !== "common").map((d) => String(d.effects.food)),
);

// ---------------------------------------------------------------- internals

interface Sess {
  d: number;
  start: number; // minute of day
  end: number; // minute of day (exclusive)
  activity: Activity;
  physical: boolean;
  place: Place | null;
  first: boolean;
  exp: Partial<Record<ExperienceId, number>>;
  breed: boolean;
}

interface Agent {
  p: Persona;
  i: number;
  r: Rates;
  sandbox: boolean;
  trades: boolean;
  places: Place[];
  dungeon: Place | null;
  arena: Place | null;
  progress: Progress;
  collection: Genemon[];
  companion: Genemon;
  team: Genemon[];
  dirty: boolean;
  dex: Set<string>;
  families: Set<string>;
  week: Sess[][];
  casts: Map<string, number>;
  rewarded: number[];
  need: Map<FoodId, number>;
  cells: Set<string>;
  discovered: Set<string>;
  hoursByHour: number[];
  frustrations: Map<string, number>;
  battles: WinTally;
  ranked: WinTally;
  n: Record<string, number>;
}

const tally = (): WinTally => ({ games: 0, wins: 0, losses: 0, draws: 0 });

function pois(rng: Rng, x: number): number {
  const k = Math.floor(x);
  return k + (rng.next() < x - k ? 1 : 0);
}

/** Genome bias toward an element's axis signature (same rule as the World screen's wild candidates). */
function signatureBias(el: ElementId): Partial<AxisVector> {
  const out: Partial<AxisVector> = {};
  for (const [axis, w] of Object.entries(ELEMENTS[el].signature) as [AxisId, number][]) out[axis] = 0.85 * w;
  return out;
}

function dexKey(g: Genemon): [string, string] {
  const ph = phenotypeOf(g);
  return [`${ph.kind}|${ph.elements.primary}|${ph.elements.secondary ?? "none"}`, `${ph.kind}|${ph.elements.primary}`];
}

class Simulation {
  readonly seed: number;
  readonly days: number;
  readonly off: number;
  readonly day0: number;
  readonly t0: number;
  readonly cap: number;
  readonly step: number;
  readonly tap: Ledger;
  readonly world: WorldMap;
  readonly ah: AuctionHouse;
  readonly ladder = new Ladder();
  readonly agents: Agent[];
  readonly byId = new Map<string, Agent>();
  readonly weather = new Map<string, WeatherId[]>();
  readonly opts: SimOptions;
  // router
  queue: { row: GEvent; to: Agent[] }[] = [];
  qi = 0;
  draining = false;
  hold = false;
  battleOwners: [string, string] | null = null;
  // counters
  rows = 0;
  rowsByWhat = new Map<string, number>();
  progressErrors = 0;
  npcRefills = 0;
  rewardFaucet = 0;
  openingBalances = 0;
  marketRounds = 0;
  rankedMatches = 0;
  durations: number[] = [];
  draws = 0;
  emptyQueueByHour = Array.from({ length: 24 }, () => 0);
  elementCasts = new Map<string, number>();
  catchesByElement = new Map<string, number>();
  releasesByElement = new Map<string, number>();
  catchesByRarity = new Map<string, number>();
  world_ = { claims: 0, takeovers: 0, failedRaids: 0, lostWhileAsleep: 0, onSite: 0, virtual: 0 };
  trades = 0;
  personaTrades = 0;
  units = 0;
  credits = 0;
  items = new Map<string, { trades: number; units: number; prices: number[] }>();

  constructor(opts: SimOptions) {
    this.opts = opts;
    this.seed = opts.seed;
    this.days = Math.max(1, Math.round(opts.weeks * 7));
    this.off = (opts.utcOffsetH ?? 2) * HOUR_MS;
    this.day0 = Math.floor((opts.startMs + this.off) / DAY_MS);
    this.t0 = this.day0 * DAY_MS - this.off;
    this.cap = Math.max(0, Math.floor(opts.battlesPerSession ?? 4));
    this.step = clamp(Math.floor(opts.marketStepMin ?? 5), 1, 60);
    this.tap = opts.ledger ?? new Ledger("sim", 1);
    const personas = opts.personas ?? PERSONAS;
    if (personas.length === 0) throw new RangeError("simulate: no personas");
    const lat = personas.reduce((s, p) => s + p.home.lat, 0) / personas.length;
    const lon = personas.reduce((s, p) => s + p.home.lon, 0) / personas.length;
    this.world = new WorldMap({ seed: hashSeed(this.seed, "world"), origin: { lat, lon }, ledger: this.tap });
    this.ah = new AuctionHouse({ seed: hashSeed(this.seed, "market"), ledger: this.tap });
    this.ladder = new Ladder({ ledger: this.tap });
    for (const p of personas) {
      if (this.weather.has(p.city)) continue;
      const days: WeatherId[] = [];
      for (let d = 0; d < this.days; d++) days.push(weatherOfDay(new Date(this.at(d, 720)), p.home.lat));
      this.weather.set(p.city, days);
    }
    this.agents = personas.map((p, i) => this.makeAgent(p, i));
  }

  at(d: number, minute: number): number {
    return this.t0 + d * DAY_MS + minute * MIN_MS;
  }

  weekday(d: number): number {
    return (((this.day0 + d + 3) % 7) + 7) % 7;
  }

  wx(a: Agent, d: number): WeatherId {
    const w = this.weather.get(a.p.city)!;
    return w[clamp(d, 0, w.length - 1)];
  }

  makeAgent(p: Persona, i: number): Agent {
    const places = this.world.generateNeighbourhood(p.id, this.world.toLocal(p.home.lat, p.home.lon), this.t0);
    const starters = p.favoriteElements.map((el, k) => {
      let g = createGenemon({ seed: hashSeed(this.seed, p.id, "starter", k), owner: p.id, level: STARTER_LEVEL, bornAt: this.t0 });
      for (let t = 0; t < 8; t++) {
        const axes = signatureBias(el);
        g = createGenemon({ seed: hashSeed(this.seed, p.id, "starter", k, t), owner: p.id, level: STARTER_LEVEL, bornAt: this.t0, bias: { axes, spread: Object.keys(axes).length ? 0.3 : 0.12 } });
        if (phenotypeOf(g).elements.primary === el) break;
      }
      return g;
    });
    const a: Agent = {
      p,
      i,
      r: ratesOf(p),
      sandbox: p.style === "theorycrafter",
      trades: p.spendingPerWeek > 0,
      places,
      dungeon: places.find((x) => x.kind === "dungeon") ?? null,
      arena: places.find((x) => x.kind === "arena") ?? null,
      progress: new Progress(p.id),
      collection: [],
      companion: starters[0],
      team: [],
      dirty: true,
      dex: new Set(),
      families: new Set(),
      week: [],
      casts: new Map(),
      rewarded: [],
      need: new Map(),
      cells: new Set(),
      discovered: new Set(),
      hoursByHour: Array.from({ length: 24 }, () => 0),
      frustrations: new Map(),
      battles: tally(),
      ranked: tally(),
      n: {},
    };
    this.byId.set(p.id, a);
    for (const g of starters) this.adopt(a, g);
    return a;
  }

  inc(a: Agent, k: string, v = 1): void {
    a.n[k] = (a.n[k] ?? 0) + v;
  }

  adopt(a: Agent, g: Genemon): void {
    g.owner = a.p.id;
    a.collection.push(g);
    const [entry, family] = dexKey(g);
    a.dex.add(entry);
    a.families.add(family);
    this.inc(a, "maxGen", 0);
    a.n.maxGen = Math.max(a.n.maxGen ?? 0, g.genome.generation);
    a.dirty = true;
  }

  // ------------------------------------------------------------ ledger routing (Progress per persona)
  onRow(row: GEvent): void {
    this.rows++;
    this.rowsByWhat.set(row.what, (this.rowsByWhat.get(row.what) ?? 0) + 1);
    if (row.what === "market.deposit" && row.who.startsWith("npc:")) this.npcRefills += Number(row.entries.credits) || 0;
    if (row.what === "market.sold" || row.what === "market.buyout") this.trade(row);
    const to: Agent[] = [];
    const add = (id: unknown) => {
      const a = typeof id === "string" ? this.byId.get(id) : undefined;
      if (a && !to.includes(a)) to.push(a);
    };
    add(row.who);
    if (this.battleOwners && row.what.startsWith("battle.")) {
      add(this.battleOwners[0]);
      add(this.battleOwners[1]);
    }
    if (row.what === "market.sold") {
      add(row.exits.buyerId);
      add(row.exits.sellerId);
    }
    if (to.length === 0) return;
    this.queue.push({ row, to });
    if (!this.hold) this.drain();
  }

  trade(row: GEvent): void {
    const itemId = String(row.entries.itemId);
    const qty = Number(row.entries.qty) || 1, price = Number(row.entries.price) || 0;
    const buyer = row.what === "market.sold" ? String(row.exits.buyerId) : row.who;
    const seller = String(row.exits.sellerId);
    this.trades++;
    this.units += qty;
    this.credits += price;
    const it = this.items.get(itemId) ?? { trades: 0, units: 0, prices: [] };
    it.trades++;
    it.units += qty;
    it.prices.push(price / qty);
    this.items.set(itemId, it);
    const b = this.byId.get(buyer), s = this.byId.get(seller);
    if (b) {
      this.inc(b, "spent", price);
      this.inc(b, "spentWeek", price);
      this.inc(b, "trades");
    }
    if (s) this.inc(s, "trades");
    if (b || s) this.personaTrades++;
  }

  drain(): void {
    if (this.draining) return;
    this.draining = true;
    while (this.qi < this.queue.length) {
      const { row, to } = this.queue[this.qi++];
      for (const a of to) {
        let res: IngestResult;
        try {
          res = a.progress.ingest(row, this.ctx(a, row.when));
        } catch {
          this.progressErrors++;
          continue;
        }
        if (res.credits > 0 || res.completed.length > 0) this.pay(a, res, row.when);
      }
    }
    this.queue = [];
    this.qi = 0;
    this.draining = false;
  }

  ctx(a: Agent, when: number) {
    const d = clamp(Math.floor((when - this.t0) / DAY_MS), 0, this.days - 1);
    const minute = clamp(Math.floor((when - this.at(d, 0)) / MIN_MS), 0, 1439);
    const team = a.team.length > 0 ? a.team : [a.companion];
    return {
      profileId: a.p.id,
      now: when,
      hour: minute / 60,
      day: this.day0 + d,
      level: Math.max(...team.map((g) => phenotypeOf(g).level)),
      weather: this.wx(a, d),
      physical: this.sessionAt(a, d, minute)?.physical ?? false,
    };
  }

  pay(a: Agent, res: IngestResult, when: number): void {
    const credits = Math.round(res.credits);
    this.inc(a, "rewards", credits);
    this.inc(a, "quests", res.completed.length);
    if (credits > 0 && a.trades) {
      this.ah.deposit(a.p.id, credits, when, "achievement and quest rewards");
      this.rewardFaucet += credits;
    }
  }

  // ------------------------------------------------------------ sessions
  sessionAt(a: Agent, d: number, minute: number): Sess | null {
    const day = a.week[d % 7];
    if (!day || day.length === 0 || day[0].d !== d) return null;
    return day.find((s) => s.start <= minute && minute < s.end) ?? null;
  }

  daySessions(a: Agent, d: number): Sess[] {
    const rng = new Rng(hashSeed(this.seed, a.p.id, "sessions", d));
    const [lo, hi] = a.p.sessionLengthMin;
    const out: Sess[] = [];
    for (const b of playBlocks(a.p, this.weekday(d))) {
      const b0 = Math.round(b.start * 60), b1 = Math.round(b.end * 60), dur = b1 - b0;
      if (dur <= 0 || b.device === null) continue;
      const expected = dur * b.playIntensity;
      let lens: number[] = [];
      if (expected < lo) {
        if (rng.chance(expected / lo)) lens = [Math.min(lo, dur)];
      } else {
        const n = Math.max(1, Math.round(expected / ((lo + hi) / 2) + rng.range(-0.5, 0.5)));
        for (let k = 0; k < n; k++) lens.push(clamp((expected / n) * rng.range(0.7, 1.3), lo, hi));
        const total = lens.reduce((s, x) => s + x, 0);
        if (total > dur) lens = lens.map((x) => (x * dur) / total);
      }
      const free = Math.max(0, dur - lens.reduce((s, x) => s + x, 0));
      const w = Array.from({ length: lens.length + 1 }, () => rng.next() + 1e-6);
      const ws = w.reduce((s, x) => s + x, 0);
      let t = b0, prevEnd = b0;
      for (let k = 0; k < lens.length; k++) {
        t += (free * w[k]) / ws;
        const start = Math.max(prevEnd, Math.round(t));
        const end = Math.min(b1, start + Math.max(1, Math.round(lens[k])));
        if (end <= start) break;
        let place: Place | null = null;
        if (b.physical) {
          const kinds = ACTIVITY_PLACES[b.activity] ?? ["park"];
          const cands = a.places.filter((x) => kinds.includes(x.kind));
          place = cands.length > 0 ? rng.pick(cands) : a.places.find((x) => x.kind === "park") ?? null;
        }
        out.push({ d, start, end, activity: b.activity, physical: b.physical, place, first: false, exp: {}, breed: false });
        t += lens[k];
        prevEnd = end;
      }
    }
    if (out.length > 0) out[0].first = true;
    return out;
  }

  planWeek(w: number): void {
    const d0 = w * 7, n = Math.min(7, this.days - d0);
    for (const a of this.agents) {
      a.week = [];
      for (let k = 0; k < 7; k++) a.week.push(k < n ? this.daySessions(a, d0 + k) : []);
      const all = a.week.flat();
      if (all.length === 0) continue;
      for (const [e, perWeek] of Object.entries(a.p.experiencesPerWeek) as [ExperienceId, number][]) {
        const total = (perWeek * n) / 7;
        const eligible = all.filter((s) => !EXPERIENCES[e].physicalOnly || s.physical);
        const pool = eligible.length > 0 ? eligible : [all[0]]; // nowhere physical: one honest (denied) attempt
        const mins = pool.reduce((s, x) => s + x.end - x.start, 0);
        for (const s of pool) s.exp[e] = (s.exp[e] ?? 0) + (eligible.length > 0 ? (total * (s.end - s.start)) / mins : total);
      }
      const rng = new Rng(hashSeed(this.seed, a.p.id, "breed", w));
      const sofa = rng.shuffle(all.filter((s) => !s.physical));
      for (const s of sofa.slice(0, pois(rng, (a.r.breed * n) / 7))) s.breed = true;
    }
  }

  // ------------------------------------------------------------ main loop
  run(): SimReport {
    const unsub = this.tap.subscribe((row) => this.onRow(row));
    try {
      for (const a of this.agents) {
        if (a.trades) {
          this.ah.deposit(a.p.id, OPENING_CREDITS, this.t0, "opening balance: profile credits");
          this.openingBalances += OPENING_CREDITS;
        }
      }
      for (let d = 0; d < this.days; d++) {
        if (d % 7 === 0) {
          this.planWeek(d / 7);
          for (const a of this.agents) a.n.spentWeek = 0;
        }
        this.runDay(d);
      }
      return this.report();
    } finally {
      unsub();
    }
  }

  runDay(d: number): void {
    type Ev = { t: number; o: number; i: number; n: number; k: string; s?: Sess };
    const evs: Ev[] = [];
    let n = 0;
    for (let m = 0; m < 1440; m += this.step) evs.push({ t: m, o: 0, i: -1, n: n++, k: "market" });
    for (const a of this.agents) {
      for (const s of a.week[d % 7]) {
        const rng = new Rng(hashSeed(this.seed, a.p.id, "plan", d, s.start));
        const hours = (s.end - s.start) / 60;
        const mid: string[] = [];
        const push = (k: string, c: number) => {
          for (let j = 0; j < c; j++) mid.push(k);
        };
        push("battle", Math.min(this.cap, pois(rng, a.r.battle * hours)));
        push("catch", pois(rng, a.r.catch * hours));
        if (s.physical) {
          push("claim", pois(rng, a.r.claim * hours));
          push("release", 1);
        }
        if (a.trades) push("market", pois(rng, a.r.market * hours));
        if (s.breed) push("breed", 1);
        if (Object.keys(s.exp).length > 0) push("exp", 1);
        const acts = [...(s.first ? ["care"] : []), ...(s.physical ? ["visit"] : []), ...rng.shuffle(mid)];
        evs.push({ t: s.start, o: 1, i: a.i, n: n++, k: "start", s });
        acts.forEach((k, j) => evs.push({ t: s.start + Math.floor(((j + 0.5) * (s.end - s.start)) / acts.length), o: 2, i: a.i, n: n++, k, s }));
        evs.push({ t: s.end, o: 3, i: a.i, n: n++, k: "end", s });
      }
    }
    evs.sort((x, y) => x.t - y.t || x.o - y.o || x.i - y.i || x.n - y.n);
    for (const ev of evs) {
      const now = this.at(d, ev.t);
      if (ev.k === "market") {
        this.marketRound(now);
        continue;
      }
      const a = this.agents[ev.i], s = ev.s!;
      this.act(a, s, ev.k, now, d, ev.t);
    }
    // end of day: the whole team ages one day (hunger +0.25), the rest of the collection weekly
    const night = this.at(d, 1439);
    for (const a of this.agents) {
      for (const g of a.collection) {
        if (a.team.includes(g) || g === a.companion) age(g, 1, { ledger: this.tap, when: night, who: a.p.id, why: "a day passed" });
        else if (d % 7 === 6) age(g, 7, { ledger: this.tap, when: night, who: a.p.id, why: "a week passed" });
      }
      if (a.companion.conditions.hunger >= 0.9) this.frustrate(a, "neglect-guilt", night, {});
      a.dirty = true;
    }
  }

  marketRound(now: number): void {
    this.ah.tick(now);
    if (this.marketRounds % 3 === 0) this.ah.companyRestock(now);
    this.ah.npcActivity(now);
    this.marketRounds++;
  }

  // ------------------------------------------------------------ actions
  simRow(when: number, who: string, what: string, why: string, entries: Record<string, Scalar>, where: Where = SIM_WHERE): void {
    this.tap.emit({ when, where, who, what, why, from: who, to: "sim", entries, exits: {}, tags: ["sim"] });
  }

  frustrate(a: Agent, tag: string, when: number, entries: Record<string, Scalar>): void {
    a.frustrations.set(tag, (a.frustrations.get(tag) ?? 0) + 1);
    this.simRow(when, a.p.id, "sim.frustration", tag, { tag, listed: a.p.frustrations.some((f) => f.startsWith(`${tag}:`)), ...entries });
  }

  /** One audited row per world action attempt (ok + reason + presence). */
  action(a: Agent, when: number, action: string, ok: boolean, reason: string, place: Place | null, present: boolean): void {
    this.simRow(when, a.p.id, "sim.action", reason, { action, ok, physical: present, poi: place?.kind ?? "none" }, place && present ? this.cellWhere(place.pos, "physical") : SIM_WHERE);
    if (ok && present) this.inc(a, "physicalActions");
  }

  cellWhere(pos: V3, space: Where["space"]): Where {
    const zone = this.world.cellOf(pos);
    const c = this.world.cellCenter(zone);
    return { x: r3(c.x), y: r3(c.y), z: r3(c.z), zone, space };
  }

  life(a: Agent, s: Sess, now: number, why: string): LifeCtx {
    return { ledger: this.tap, when: now, who: a.p.id, why, where: s.physical && s.place ? this.cellWhere(s.place.pos, "physical") : HOME_VIRTUAL };
  }

  ensureTeam(a: Agent): void {
    if (!a.dirty && a.team.length > 0) return;
    const fav = new Set<ElementId>(a.p.favoriteElements);
    const rest = a.collection.filter((g) => g !== a.companion);
    const favPool = rest.filter((g) => fav.has(phenotypeOf(g).elements.primary));
    const pool = favPool.length >= 2 ? favPool : rest;
    const picked = autoTeam(pool, a.p.id, hashSeed(this.seed, a.p.id, "team", a.n.builds ?? 0), a.p.teamPreference).members;
    this.inc(a, "builds");
    const team = [a.companion];
    let slots = phenotypeOf(a.companion).slots;
    for (const g of picked) {
      const sl = phenotypeOf(g).slots;
      if (slots + sl <= TEAM_CAPACITY) {
        team.push(g);
        slots += sl;
      }
    }
    a.team = team;
    a.dirty = false;
  }

  act(a: Agent, s: Sess, k: string, now: number, d: number, minute: number): void {
    const id = a.p.id;
    switch (k) {
      case "start": {
        this.inc(a, "sessions");
        for (let m = s.start; m < s.end; m++) a.hoursByHour[Math.floor(m / 60)] += 1 / 60;
        if (s.physical) this.inc(a, "physMinutes", s.end - s.start);
        this.simRow(now, id, "sim.session.start", `${s.activity} block`, { day: d, weekday: this.weekday(d), start: s.start, end: s.end, physical: s.physical, activity: s.activity });
        return;
      }
      case "end": {
        if (s.physical && s.place) expose(a.companion, s.place.ground, (s.end - s.start) / 60, this.life(a, s, now, "time on site"));
        this.simRow(now, id, "sim.session.end", `${s.activity} block`, { day: d, start: s.start, end: s.end });
        return;
      }
      case "care":
        return this.care(a, s, now, d);
      case "exp": {
        for (const [e, units] of Object.entries(s.exp) as [ExperienceId, number][]) {
          if (units < 0.005) continue;
          const ok = live(a.companion, e, r3(units), { ...this.life(a, s, now, "real-life experience"), physical: s.physical });
          if (!ok) {
            this.inc(a, "deniedPhysical");
            this.frustrate(a, "physical-gate", now, { experience: e });
          } else if (EXPERIENCES[e].physicalOnly) this.inc(a, "physicalActions");
        }
        return;
      }
      case "visit": {
        const place = s.place;
        if (!place) return;
        const gate = this.world.actionAllowed("visit", place, s.physical, id);
        if (gate.ok) {
          const v = this.world.discover(id, place.id, now, true, { hour: minute / 60, weather: this.wx(a, d) });
          if (v.ok) a.discovered.add(place.id);
        }
        this.action(a, now, "visit", gate.ok, gate.reason, place, s.physical);
        return;
      }
      case "battle":
        return this.battle(a, now, d, minute);
      case "catch":
        return this.catchOne(a, s, now, d, minute);
      case "claim": {
        const place = s.place;
        if (!place) return;
        this.ensureTeam(a);
        const rng = new Rng(hashSeed(this.seed, id, "claim", now));
        const ang = rng.range(0, Math.PI * 2), rad = place.radius * 0.6 * Math.sqrt(rng.next());
        const pos = { x: place.pos.x + Math.cos(ang) * rad, y: place.pos.y, z: place.pos.z + Math.sin(ang) * rad };
        const cell = this.world.cellOf(pos);
        const prev = this.world.territory(cell, now).ownerId;
        const power = a.team.reduce((x, g) => x + phenotypeOf(g).power, 0);
        const v = this.world.claim(id, pos, power, now, s.physical);
        this.action(a, now, "world.claim", v.ok, v.reason, place, s.physical);
        this.inc(a, "claims");
        this.world_.claims++;
        if (v.ok) a.cells.add(cell);
        const loser = prev && prev !== id ? this.byId.get(prev) : undefined;
        if (loser && v.ok) {
          this.inc(a, "takeovers");
          this.inc(loser, "cellsLost");
          this.world_.takeovers++;
          const lm = this.at(d, 0);
          const asleep = loser.p.schedule.some((b) => b.activity === "sleep" && b.days.includes(this.weekday(d)) && b.start * 60 <= (now - lm) / MIN_MS && (now - lm) / MIN_MS < b.end * 60);
          if (asleep) {
            this.world_.lostWhileAsleep++;
            this.frustrate(loser, "offline-territory-loss", now, { cell });
          }
        } else if (prev && prev !== id) this.world_.failedRaids++;
        return;
      }
      case "release": {
        const place = s.place;
        if (!place || a.collection.length <= a.r.keep) return;
        const gate = this.world.actionAllowed("release", place, s.physical, id);
        this.action(a, now, "release", gate.ok, gate.reason, place, s.physical);
        if (!gate.ok) return;
        this.ensureTeam(a);
        const spare = a.collection.filter((g) => g !== a.companion && !a.team.includes(g))
          .sort((x, y) => phenotypeOf(x).power - phenotypeOf(y).power || (x.id < y.id ? -1 : 1))
          .slice(0, Math.min(3, a.collection.length - a.r.keep));
        for (const g of spare) {
          const el = phenotypeOf(g).elements.primary;
          this.world.release(id, el, place.pos, now);
          a.collection = a.collection.filter((x) => x !== g);
          this.releasesByElement.set(el, (this.releasesByElement.get(el) ?? 0) + 1);
          this.inc(a, "released");
          this.tap.emit({ when: now, where: this.cellWhere(place.pos, "physical"), who: id, what: "genemon.release", why: "surplus released on site", from: g.id, to: place.id, entries: { primary: el, sizeClass: phenotypeOf(g).sizeClass }, exits: { spawn: place.id } });
        }
        a.dirty = true;
        return;
      }
      case "market":
        return this.market(a, now);
      case "breed":
        return this.breedOne(a, now);
    }
  }

  care(a: Agent, s: Sess, now: number, d: number): void {
    const rng = new Rng(hashSeed(this.seed, a.p.id, "diet", d));
    const ctx = this.life(a, s, now, "daily diet");
    for (const [f, perDay] of Object.entries(a.p.dietPerDay) as [FoodId, number][]) {
      const units = Math.round(perDay * rng.range(0.8, 1.2) * 100) / 100;
      if (units <= 0) continue;
      if (!FANTASY.has(f)) {
        feed(a.companion, f, units, ctx);
        continue;
      }
      // fantasy foods exist only as market items: eat what the inventory holds (take = the item sink)
      const need = (a.need.get(f) ?? 0) + units;
      const held = this.ah.inventory(a.p.id)[foodItemId(f)] ?? 0;
      const eat = Math.min(Math.floor(need), held);
      if (eat > 0) {
        this.ah.take(a.p.id, foodItemId(f), eat, now, "eaten");
        feed(a.companion, f, eat, ctx);
      }
      a.need.set(f, need - eat);
      if (need - eat >= 3) this.inc(a, "missingFood");
    }
  }

  catchOne(a: Agent, s: Sess, now: number, d: number, minute: number): void {
    const id = a.p.id, present = s.physical;
    let place = present ? s.place : a.dungeon;
    if (!place) return;
    if (!present) {
      const tv = this.world.travelVirtual(id, place.id, now);
      if (!tv.ok) return;
      this.world.discover(id, place.id, now, false);
    }
    if (this.world.sensitivePlaceAt(place.pos)) {
      this.action(a, now, "catch", false, "sensitive place: no spawns", place, present);
      place = null;
      return;
    }
    const rng = new Rng(hashSeed(this.seed, id, "spawn", now, a.n.tries ?? 0));
    this.inc(a, "tries");
    const spawn = this.world.rollSpawn(place.pos, minute / 60, this.wx(a, d), now, rng);
    const rule = catchAllowed(spawn.rarity, present);
    const v = rule.ok ? this.world.actionAllowed(present ? "catch" : "catch.virtual", place, present, id) : rule;
    this.action(a, now, present ? "catch" : "catch.virtual", v.ok, v.reason, place, present);
    if (!v.ok) {
      if (!rule.ok) {
        this.inc(a, "deniedPhysical");
        this.frustrate(a, "physical-gate", now, { rarity: spawn.rarity });
      }
      return;
    }
    const axes = signatureBias(spawn.element);
    const g = createGenemon({ seed: rng.int(1, 2 ** 31 - 2), owner: "wild", level: spawn.level, bornAt: now, bias: { axes, spread: Object.keys(axes).length ? 0.3 : 0.12 } });
    if (present) this.world.catchAt(id, spawn.element, place.pos, now);
    this.adopt(a, g);
    this.inc(a, "caught");
    if (present) this.inc(a, "caughtOnSite");
    if (present) this.world_.onSite++;
    else this.world_.virtual++;
    this.catchesByElement.set(spawn.element, (this.catchesByElement.get(spawn.element) ?? 0) + 1);
    this.catchesByRarity.set(spawn.rarity, (this.catchesByRarity.get(spawn.rarity) ?? 0) + 1);
    const ph = phenotypeOf(g), hour = minute / 60;
    this.tap.emit({
      when: now,
      where: { ...this.cellWhere(place.pos, present ? "physical" : "virtual") },
      who: id,
      what: "genemon.catch",
      why: present ? "caught on site" : "caught inside a virtual instance",
      from: place.id,
      to: g.id,
      entries: { primary: ph.elements.primary, secondary: ph.elements.secondary ?? "none", sizeClass: ph.sizeClass, kind: ph.kind, pattern: ph.pattern, ground: place.ground, weather: this.wx(a, d), hour: r3(hour), night: hour < 7 || hour >= 19, physical: present },
      exits: { genemon: g.id },
    });
  }

  breedOne(a: Agent, now: number): void {
    const pool = [...a.collection].sort((x, y) => y.genome.generation - x.genome.generation || phenotypeOf(y).power - phenotypeOf(x).power || (x.id < y.id ? -1 : 1));
    if (pool.length < 2) return;
    const [pa, pb] = pool;
    const seed = hashSeed(this.seed, a.p.id, "breed", now);
    const child = createGenemon({ seed, owner: a.p.id, genome: breed(pa.genome, pb.genome, seed), bornAt: now });
    this.adopt(a, child);
    this.inc(a, "bred");
    const ph = phenotypeOf(child);
    this.tap.emit({ when: now, where: { x: 0, y: 0, z: 0, zone: "lab", space: "lab" }, who: a.p.id, what: "genemon.breed", why: "bred in the lab", from: pa.id, to: child.id, entries: { parentA: pa.id, parentB: pb.id }, exits: { child: child.id, generation: child.genome.generation, mutations: child.genome.mutations.length, kind: ph.kind, primary: ph.elements.primary, sizeClass: ph.sizeClass } });
  }

  // ------------------------------------------------------------ market (one shared AuctionHouse)
  market(a: Agent, now: number): void {
    const ah = this.ah, id = a.p.id;
    ah.tick(now);
    const flipper = a.p.style === "trader" || a.p.secondaryStyle === "trader";
    const rng = new Rng(hashSeed(this.seed, id, "market", now));
    // traders relist what they flipped
    if (flipper) {
      for (const [itemId, qty] of Object.entries(ah.inventory(id))) {
        const f = ITEMS[itemId]?.effects.food;
        if (!ITEMS[itemId] || (typeof f === "string" && f in a.p.dietPerDay)) continue;
        const fair = ah.fairValue(itemId) * qty;
        const start = Math.max(1, Math.round(fair * 0.95));
        try {
          ah.post(id, "player", itemId, qty, start, Math.max(start, Math.round(fair * rng.range(1.1, 1.35))), rng.int(6, 24) * HOUR_MS, now);
        } catch (e) {
          if (!(e instanceof MarketError)) throw e;
        }
      }
    }
    const budget = Math.min(a.p.spendingPerWeek - (a.n.spentWeek ?? 0) - ah.escrowed(id), ah.balance(id));
    if (budget < 1) return;
    let best: { listingId: string; price: number; score: number } | null = null;
    for (const l of ah.listings({ status: "open" })) {
      if (l.endsAt <= now || l.sellerId === id) continue;
      const def = ITEMS[l.itemId];
      if (!def || def.kind !== "food") continue;
      const f = String(def.effects.food) as FoodId;
      const q = ah.quote(l.id, now);
      if (!q || q.buyout === null || q.buyout > budget) continue;
      const fair = Math.max(1, q.fair);
      let cap = 0, prio = 0;
      if (FANTASY.has(f) && (a.p.dietPerDay[f] ?? 0) > 0) [cap, prio] = [1.15 + 0.2 * a.p.riskTolerance, 3];
      else if (flipper) [cap, prio] = [FANTASY.has(f) ? 1 : 0.85, 1];
      else if ((a.p.dietPerDay[f] ?? 0) > 0) [cap, prio] = [0.7 + 0.3 * a.p.riskTolerance, 1];
      if (q.buyout > cap * fair) continue;
      const score = prio * 10 - q.buyout / fair;
      if (!best || score > best.score) best = { listingId: l.id, price: q.buyout, score };
    }
    if (!best) return;
    try {
      ah.buyout(best.listingId, id, now);
    } catch (e) {
      if (!(e instanceof MarketError)) throw e;
    }
  }

  // ------------------------------------------------------------ battles
  battle(a: Agent, now: number, d: number, minute: number): void {
    this.ensureTeam(a);
    const rng = new Rng(hashSeed(this.seed, a.p.id, "battle", now, a.battles.games));
    if (a.arena) {
      this.world.travelVirtual(a.p.id, a.arena.id, now);
      this.world.discover(a.p.id, a.arena.id, now, false);
    }
    if (!a.sandbox && rng.chance(a.r.ranked)) {
      const ra = this.ladder.rating(a.p.id);
      const opp = this.agents
        .filter((b) => b !== a && !b.sandbox && b.r.ranked > 0 && this.sessionAt(b, d, minute) && rng.chance(b.r.ranked))
        .sort((x, y) => Math.abs(this.ladder.rating(x.p.id) - ra) - Math.abs(this.ladder.rating(y.p.id) - ra) || x.i - y.i)[0];
      if (opp) return this.ranked(a, opp, now, d, minute);
      this.inc(a, "queueEmpty");
      this.emptyQueueByHour[Math.floor(minute / 60)]++;
      this.frustrate(a, "empty-queue", now, { hour: Math.floor(minute / 60) });
    }
    // practice: the app's "wild" opponent (unrated), sandbox personas cycle arena x weather setups
    const seed = hashSeed(this.seed, a.p.id, "practice", a.battles.games);
    const lvl = Math.round(a.team.reduce((x, g) => x + phenotypeOf(g).level, 0) / a.team.length);
    const pool = Array.from({ length: 6 }, (_, i) => createGenemon({ seed: hashSeed(seed, "wild", i), owner: "wild", level: lvl }));
    const B = autoTeam(pool, "wild", seed, "swarm");
    const kind = a.sandbox ? ARENA_KINDS[a.battles.games % ARENA_KINDS.length] : rng.pick(ARENA_KINDS);
    const real = this.wx(a, d);
    const weather = ARENA_INFO[kind].weathers.includes(real) ? real : ARENA_INFO[kind].weathers[a.battles.games % ARENA_INFO[kind].weathers.length];
    const arena: ArenaSpec = { seed, kind, weather, hour: minute / 60 };
    const A: Team = { id: `team-${a.p.id}`, owner: a.p.id, name: a.p.name, members: a.team };
    const r = this.fight(A, B, arena, seed, now);
    applyBattleResult(r, [A, { ...B, members: [] }]);
    this.tallyBattle(a, r, 0, false);
    this.settled(a, now, seed, false, r.winner, 0, "wild");
  }

  ranked(a: Agent, b: Agent, now: number, d: number, minute: number): void {
    this.ensureTeam(b);
    const draw = rankedConditions(a.p.id, a.battles.games, Math.floor(now / DAY_MS), minute / 60, this.wx(a, d));
    const arena: ArenaSpec = { seed: draw.seed, kind: draw.arena, weather: draw.weather, hour: draw.hour };
    const A: Team = { id: `team-${a.p.id}`, owner: a.p.id, name: a.p.name, members: a.team };
    const B: Team = { id: `team-${b.p.id}`, owner: b.p.id, name: b.p.name, members: b.team };
    const rated = isRated({ ranked: true, opponent: "profile" }, draw.seed, a.rewarded);
    const ra = this.ladder.rating(a.p.id), rb = this.ladder.rating(b.p.id);
    const ctx = matchContext(A, B, arena); // PRE-match: before the result touches the Genemon
    const r = this.fight(A, B, arena, draw.seed, now);
    let delta = 0;
    if (rated) {
      const out = this.ladder.record(matchResultFrom(r, [A, B], arena, ctx, now));
      delta = out.deltaA;
      this.inc(a, "ratingDelta", out.deltaA);
      this.inc(b, "ratingDelta", out.deltaB);
      this.rankedMatches++;
      if (Math.abs(ra - rb) > MISMATCH) {
        this.frustrate(a, "skill-mismatch", now, { gap: r3(ra - rb) });
        this.frustrate(b, "skill-mismatch", now, { gap: r3(rb - ra) });
      }
    }
    a.rewarded = [draw.seed, ...a.rewarded].slice(0, 300);
    applyBattleResult(r, [A, B]);
    this.tallyBattle(a, r, 0, rated);
    this.tallyBattle(b, r, 1, rated);
    this.settled(a, now, draw.seed, rated, r.winner, delta, b.p.id);
  }

  /** Run a battle step by step, crediting every move cast to its owner (favourite moves). */
  fight(A: Team, B: Team, arena: ArenaSpec, seed: number, when0: number): BattleResult {
    this.hold = true;
    this.battleOwners = [A.owner, B.owner];
    const b = new Battle({ seed, arena, teams: [A, B], ledger: this.tap, detail: "summary", when0 });
    let last = 0;
    while (b.winner === null) {
      b.step();
      const ev = b.events;
      for (let i = ev.length - 1; i >= 0 && ev[i].seq > last; i--) {
        const e = ev[i];
        if (e.type !== "phase" || e.label !== "charge" || !e.move || e.a === undefined) continue;
        const owner = this.byId.get(b.fighters[e.a].team === 0 ? A.owner : B.owner);
        if (owner) owner.casts.set(e.move, (owner.casts.get(e.move) ?? 0) + 1);
      }
      last = b.lastSeq();
    }
    const r = b.result();
    this.battleOwners = null;
    this.hold = false;
    this.drain();
    this.durations.push(r.duration);
    if (r.winner === 2) this.draws++;
    return r;
  }

  tallyBattle(a: Agent, r: BattleResult, side: 0 | 1, rated: boolean): void {
    for (const t of rated ? [a.battles, a.ranked] : [a.battles]) {
      t.games++;
      if (r.winner === 2) t.draws++;
      else if (r.winner === side) t.wins++;
      else t.losses++;
    }
    for (const f of r.fighters) {
      if (f.team !== side) continue;
      for (const [el, k] of Object.entries(r.elementsUsed[f.id] ?? {})) this.elementCasts.set(el, (this.elementCasts.get(el) ?? 0) + (k ?? 0));
    }
  }

  settled(a: Agent, now: number, seed: number, ranked: boolean, winner: number, delta: number, opponent: string): void {
    this.tap.emit({ when: now, where: { x: 0, y: 0, z: 0, zone: "arena", space: "arena" }, who: a.p.id, what: "battle.settled", why: ranked ? "ranked: rated by the condition-aware ladder" : "practice: unrated", from: a.p.id, to: opponent, entries: { seed, ranked, kind: ranked ? "ranked" : "practice" }, exits: { mmrDelta: r3(delta), winner } });
  }

  // ------------------------------------------------------------ report
  report(): SimReport {
    const end = this.at(this.days, 0);
    const table = this.ladder.table();
    const rankOf = new Map(table.map((row, i) => [row.id, i + 1]));
    const territories: Record<string, number> = {};
    for (const t of this.world.toJSON().territories) {
      const owner = this.world.territory(t.cellId, end).ownerId;
      if (owner) territories[owner] = (territories[owner] ?? 0) + 1;
    }
    const personas: SimPersonaReport[] = this.agents.map((a) => {
      const p = a.p;
      let expected = 0;
      for (let d = 0; d < this.days; d++) for (const b of playBlocks(p, this.weekday(d))) expected += (b.end - b.start) * b.playIntensity;
      const casts = [...a.casts].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1));
      const comp = phenotypeOf(a.companion);
      const others = a.team.filter((g) => g !== a.companion);
      const rated = this.ladder.games(p.id) > 0;
      return {
        id: p.id,
        name: p.name,
        style: p.style,
        secondaryStyle: p.secondaryStyle,
        skill: p.skill,
        sessions: a.n.sessions ?? 0,
        playHours: r3(a.hoursByHour.reduce((s, x) => s + x, 0)),
        expectedPlayHours: r3(expected),
        physicalHours: r3((a.n.physMinutes ?? 0) / 60),
        hoursByHour: a.hoursByHour.map(r3),
        battles: a.battles,
        ranked: a.ranked,
        queueEmpty: a.n.queueEmpty ?? 0,
        rating: rated ? r3(this.ladder.rating(p.id)) : null,
        rank: rated ? rankOf.get(p.id) ?? null : null,
        ratingDelta: r3(a.n.ratingDelta ?? 0),
        collection: a.collection.length,
        caught: a.n.caught ?? 0,
        caughtOnSite: a.n.caughtOnSite ?? 0,
        released: a.n.released ?? 0,
        bred: a.n.bred ?? 0,
        maxGeneration: a.n.maxGen ?? 0,
        pokedex: a.dex.size,
        families: a.families.size,
        pokedexGoal: p.pokedexGoal,
        favouriteMoves: casts.slice(0, 3).map(([move, uses]) => ({ move, uses })),
        declaredFavouriteCasts: p.favoriteMoves.reduce((s, m) => s + (a.casts.get(m) ?? 0), 0),
        achievements: a.progress.unlockedIds(),
        questsCompleted: a.n.quests ?? 0,
        rewardCredits: a.n.rewards ?? 0,
        credits: this.ah.balance(p.id) + this.ah.escrowed(p.id),
        spent: a.n.spent ?? 0,
        trades: a.n.trades ?? 0,
        placesDiscovered: a.discovered.size,
        physicalActions: a.n.physicalActions ?? 0,
        deniedPhysical: a.n.deniedPhysical ?? 0,
        territories: territories[p.id] ?? 0,
        claims: a.n.claims ?? 0,
        takeovers: a.n.takeovers ?? 0,
        cellsLost: a.n.cellsLost ?? 0,
        companion: { name: a.companion.name, level: comp.level, primary: comp.elements.primary, hunger: r3(a.companion.conditions.hunger), rhythm: r3(comp.axes.rhythm) },
        teamHunger: r3(others.length ? others.reduce((s, g) => s + g.conditions.hunger, 0) / others.length : 0),
        missingFood: a.n.missingFood ?? 0,
        frustrations: Object.fromEntries([...a.frustrations].sort()),
      };
    });
    // balance
    const byStyle = new Map<string, WinTally>();
    for (const r of personas) {
      const t = byStyle.get(r.style) ?? tally();
      t.games += r.battles.games;
      t.wins += r.battles.wins;
      t.losses += r.battles.losses;
      t.draws += r.battles.draws;
      byStyle.set(r.style, t);
    }
    const totalCasts = [...this.elementCasts.values()].reduce((s, x) => s + x, 0);
    const usage = [...this.elementCasts].map(([element, casts]) => ({ element, casts, share: r3(casts / Math.max(1, totalCasts)) }))
      .sort((x, y) => y.casts - x.casts || (x.element < y.element ? -1 : 1));
    const entropy = usage.reduce((s, u) => (u.casts > 0 ? s - (u.casts / totalCasts) * Math.log(u.casts / totalCasts) : s), 0) / Math.log(14);
    const ratedP = personas.filter((r) => r.rating !== null);
    const ratings = ratedP.map((r) => r.rating!);
    const rank = (xs: number[]) => xs.map((x) => xs.filter((y) => y < x).length + (xs.filter((y) => y === x).length - 1) / 2);
    const rho = ratedP.length >= 3 ? correlation(rank(ratedP.map((r) => r.skill)), rank(ratings)) : NaN;
    // market
    const items = [...this.items].map(([itemId, it]) => {
      const list = ITEMS[itemId]?.basePrice ?? 0, med = median(it.prices);
      return { itemId, trades: it.trades, units: it.units, median: r3(med), list, drift: list > 0 ? r3(med / list) : 0 };
    }).sort((x, y) => y.units - x.units || (x.itemId < y.itemId ? -1 : 1)).slice(0, 15);
    const wallets = this.agents.filter((a) => a.trades).map((a) => this.ah.balance(a.p.id) + this.ah.escrowed(a.p.id)).sort((x, y) => x - y);
    const wsum = wallets.reduce((s, x) => s + x, 0);
    const gini = wallets.length > 1 && wsum > 0 ? wallets.reduce((s, x, i) => s + (2 * (i + 1) - wallets.length - 1) * x, 0) / (wallets.length * wsum) : 0;
    const byWhat = Object.fromEntries([...this.rowsByWhat].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1)));
    return {
      meta: {
        seed: this.seed,
        weeks: this.opts.weeks,
        days: this.days,
        startMs: this.t0,
        endMs: end,
        utcOffsetH: this.off / HOUR_MS,
        personas: this.agents.map((a) => a.p.id),
        marketRounds: this.marketRounds,
        rows: this.rows,
        rowsByWhat: byWhat,
        progressErrors: this.progressErrors,
      },
      personas,
      world: {
        places: this.world.places().length,
        placesDiscovered: this.world.places().filter((pl) => pl.visitedBy.length > 0).length,
        territories,
        claims: this.world_.claims,
        takeovers: this.world_.takeovers,
        failedRaids: this.world_.failedRaids,
        lostWhileAsleep: this.world_.lostWhileAsleep,
        catchesByElement: Object.fromEntries([...this.catchesByElement].sort()),
        releasesByElement: Object.fromEntries([...this.releasesByElement].sort()),
        catchesByRarity: Object.fromEntries([...this.catchesByRarity].sort()),
        catchesOnSite: this.world_.onSite,
        catchesVirtual: this.world_.virtual,
      },
      market: {
        trades: this.trades,
        unitsTraded: this.units,
        creditsTraded: this.credits,
        personaTrades: this.personaTrades,
        moneySupply: this.ah.moneySupply(),
        npcRefills: this.npcRefills,
        rewardFaucet: this.rewardFaucet,
        openingBalances: this.openingBalances,
        openListings: this.ah.listings({ status: "open" }).length,
        items,
        medianPrices: Object.fromEntries(items.map((x) => [x.itemId, x.median])),
        walletGini: r3(gini),
      },
      balance: {
        winRateByStyle: [...byStyle].map(([style, t]) => ({ style, ...t, winRate: t.wins + t.losses > 0 ? r3(t.wins / (t.wins + t.losses)) : null }))
          .sort((x, y) => (y.winRate ?? -1) - (x.winRate ?? -1) || (x.style < y.style ? -1 : 1)),
        elementUsage: usage,
        elementEntropy: r3(entropy),
        ratingSpread: {
          n: ratings.length,
          min: ratings.length ? r3(Math.min(...ratings)) : 0,
          max: ratings.length ? r3(Math.max(...ratings)) : 0,
          sd: ratings.length ? r3(std(ratings)) : 0,
          iqr: ratings.length ? r3(quantile(ratings, 0.75) - quantile(ratings, 0.25)) : 0,
          spearmanSkill: Number.isFinite(rho) ? r3(rho) : null,
        },
        rankedMatches: this.rankedMatches,
        battles: this.durations.length,
        drawRate: r3(this.draws / Math.max(1, this.durations.length)),
        meanDurationS: r3(this.durations.reduce((s, x) => s + x, 0) / Math.max(1, this.durations.length)),
        emptyQueueByHour: this.emptyQueueByHour,
      },
    };
  }
}

/** Run the persona simulation (pure: same options -> identical report and ledger rows). */
export function simulate(opts: SimOptions): SimReport {
  return new Simulation(opts).run();
}
