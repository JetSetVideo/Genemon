/**
 * Achievements: long-term goals unlocked by COUNTING LEDGER EVENTS (src/core/ledger.ts). An
 * achievement is pure data - a Trigger { what, count, where?, filter? } - so the game needs no
 * achievement-specific code: the engine subscribes to the ledger, runs triggerMatches() on each
 * row and adds eventWeight() (entries.units when numeric, else 1) until progress >= count.
 *
 * This file also owns the CONTENT CONTRACT shared with src/data/quests.ts: CONTENT_EVENTS lists
 * every ledger event a trigger may name, its payload keys with their value domains, the module
 * that must emit it, and whether a src/ module emits it today ("emitted") or it is still a
 * contract for its owner ("proposed"). tests/content_test.ts validates every trigger against it,
 * so renaming a move, reaction or ground breaks a test instead of silently killing an achievement.
 *
 * Attribution (for the consumer that keeps per-player progress): a row counts for player P when
 * GEvent.who is P or one of P's Genemon (battle rows name the acting Genemon). Rows written by a
 * system account (market.sold: who = house) are matched with the ME placeholder instead, e.g.
 * { sellerId: ME }. EventSpec.requested lists keys content needs that the emitter does not write
 * yet (integration requests); triggers may use them and progressesToday() reports which can't move.
 * Tables, balance notes and how to add entries: docs/LISTS.md (Achievements, Ledger events).
 */
import type { GEvent, Space } from "../core/ledger.ts";
import type { ReactionId } from "./elements.ts";
import type { ExperienceId } from "./lifestyle.ts";
import type { WeatherId } from "./weather.ts";

// ---------------------------------------------------------------- content vocabularies

/** Vocabularies introduced by content that no other module defines yet (proposals for their owners). */
export const CONTENT_VOCAB = {
  /** Real-world point-of-interest kinds the world layer (src/world) tags map features with. */
  poi: [
    "supermarket",
    "farmersMarket",
    "gym",
    "pool",
    "park",
    "garden",
    "forest",
    "lake",
    "river",
    "harbour",
    "beach",
    "mountain",
    "museum",
    "library",
    "cafe",
    "stadium",
    "landmark",
    "station",
    "plaza",
  ],
  battleMode: ["casual", "ranked", "friendly", "wild", "raid", "territory", "story", "tournament"],
  /** Why an attack did not land (battle.miss exits.reason, requested): the roll, a flyer over a ground move, a digger underground... */
  dodgeReason: ["roll", "airborne", "burrowed", "evasive", "obscured", "range"],
  ladderTier: ["bronze", "silver", "gold", "platinum", "diamond", "master"],
  /** Mirror of src/economy/items.ts ITEM_KINDS (kept here so this data module needs no economy import; the test pins them equal). */
  itemKind: ["food", "potion", "lure", "egg", "stone", "cosmetic", "territoryFlag", "incubator", "ticket", "map", "genemon"],
  /** Mirror of src/world/arena.ts ARENA_KINDS (same reason, same test). */
  arenaKind: ["meadow", "lake", "volcano", "canyon", "tundra", "swamp", "crystal", "city", "beach", "forest"],
} as const;

export type Poi = typeof CONTENT_VOCAB["poi"][number];

/** Non-food reward items handed out by content (proposal for src/economy, which owns item specs). */
export const REWARD_ITEMS = [
  "lure.rain",
  "lure.night",
  "lure.storm",
  "egg.mystery",
  "egg.shadow",
  "egg.light",
  "incubator",
  "scanner.dna",
  "badge.gym",
  "badge.night",
  "badge.harbour",
  "cosmetic.crown",
  "cosmetic.lantern",
  "cosmetic.scarf",
  "map.fragment",
] as const;

// ---------------------------------------------------------------- trigger contract

export type FilterValue = string | number | boolean;

/** A ledger-counting condition, shared by achievements, quest steps and quest-giver arcs. */
export interface Trigger {
  /** Ledger event name (GEvent.what), e.g. "battle.reaction". Must be a key of CONTENT_EVENTS. */
  what: string;
  /** Progress needed = sum of eventWeight() over matching rows. Integer >= 1. */
  count: number;
  /** Optional GEvent.where.space (e.g. "physical") or GEvent.where.zone the row must carry. */
  where?: string;
  /** Payload conditions, all of which must hold. Key syntax: see triggerMatches(). */
  filter?: Record<string, FilterValue>;
}

/**
 * Value domain of a payload key. Id domains are validated against their owning module by
 * tests/content_test.ts (element -> ELEMENT_IDS, move -> MOVES, poi -> CONTENT_VOCAB.poi...).
 */
export type Domain =
  | "number"
  | "boolean"
  | "hour"
  | "text"
  | "element"
  | "elementOrNone"
  | "reaction"
  | "ground"
  | "weather"
  | "food"
  | "experience"
  | "status"
  | "move"
  | "moveShape"
  | "sizeClass"
  | "bodyKind"
  | "pattern"
  | "questKind"
  | "achievementCategory"
  /** A player id; content never names players, so the only valid filter value is ME. */
  | "player"
  | keyof typeof CONTENT_VOCAB;

export interface EventSpec {
  /** Module that writes (or must write) the row. */
  emitter: string;
  /** emitted = a src/ module writes it today with exactly these keys; proposed = awaiting its owner. */
  status: "emitted" | "proposed";
  /** Usual GEvent.where.space values. */
  spaces: readonly Space[];
  entries: Record<string, Domain>;
  exits: Record<string, Domain>;
  note: string;
  /** Keys content needs that the emitter does not write yet (integration requests; progress waits for them). */
  requested?: { entries?: Record<string, Domain>; exits?: Record<string, Domain> };
  /** Domains of the GEvent envelope fields from / to, when content filters on them (battle.terrain grounds). */
  envelope?: { from?: Domain; to?: Domain };
}

const LIFE: readonly Space[] = ["physical", "virtual", "lab"];
const ARENA: readonly Space[] = ["arena"];
const GPS: readonly Space[] = ["physical"];
const MARKET: readonly Space[] = ["market"];
const GENEMON = "src/genome/genemon.ts";
const COMBAT = "src/combat/battle.ts";
const WORLD = "src/world";
const ECONOMY = "src/economy/market.ts";

function ev(
  emitter: string,
  status: EventSpec["status"],
  spaces: readonly Space[],
  entries: Record<string, Domain>,
  exits: Record<string, Domain>,
  note: string,
  extra: Pick<EventSpec, "requested" | "envelope"> = {},
): EventSpec {
  return { emitter, status, spaces, entries, exits, note, ...extra };
}

/** Battle payload shared by battle.start / battle.win / battle.loss. */
const BATTLE_CONTEXT: Record<string, Domain> = {
  mode: "battleMode",
  arena: "arenaKind",
  weather: "weather",
  hour: "hour",
  night: "boolean",
  teamSize: "number",
  enemyCount: "number",
  mySlots: "number",
  enemySlots: "number",
};

/** Every ledger event content may count, with its payload keys. Single source for emitters. */
export const CONTENT_EVENTS: Record<string, EventSpec> = {
  // ---- emitted today by src/genome/genemon.ts (keys mirror its log() calls; a test re-checks them)
  "genemon.xp": ev(GENEMON, "emitted", LIFE, { xp: "number" }, { total: "number", level: "number" }, "grantXp()"),
  "genemon.levelUp": ev(GENEMON, "emitted", LIFE, { from: "number" }, { to: "number", moves: "text" }, "settle() after any xp change; filter exits.to"),
  "genemon.evolve": ev(
    GENEMON,
    "emitted",
    LIFE,
    { fromStage: "number", growth: "number", level: "number" },
    { toStage: "number", height: "number", sizeClass: "sizeClass" },
    "stages 1 Hatchling, 2 Juvenile, 3 Adult, 4 Ascended (STAGE_NAMES)",
  ),
  "genemon.specialize": ev(
    GENEMON,
    "emitted",
    LIFE,
    { primary: "element", secondary: "elementOrNone" },
    { primary: "element", secondary: "elementOrNone" },
    "entries = types before, exits = types after: always filter with an explicit exits. scope",
  ),
  "genemon.feed": ev(GENEMON, "emitted", LIFE, { food: "food", units: "number" }, { hunger: "number", bond: "number" }, "feed(); units = portions"),
  "genemon.experience": ev(
    GENEMON,
    "emitted",
    LIFE,
    { experience: "experience", units: "number", physical: "boolean" },
    { xp: "number" },
    "live(); units = sessions or km; physical-only experiences are refused when physical === false",
  ),
  "genemon.experience.denied": ev(GENEMON, "emitted", LIFE, { experience: "experience" }, { reason: "text" }, "a physical-only experience attempted from the sofa"),
  "genemon.exposure": ev(GENEMON, "emitted", LIFE, { ground: "ground", hours: "number" }, { totalHours: "number" }, "expose(); one row per session"),
  // ---- life & lab
  "genemon.catch": ev(
    WORLD,
    "emitted",
    ["physical", "virtual"],
    {
      primary: "element",
      secondary: "elementOrNone",
      sizeClass: "sizeClass",
      kind: "bodyKind",
      pattern: "pattern",
      ground: "ground",
      weather: "weather",
      hour: "hour",
      night: "boolean",
      physical: "boolean",
    },
    { genemon: "text" },
    "wild encounter caught; physical = caught at a GPS-verified spawn",
  ),
  "genemon.release": ev(WORLD, "emitted", ["physical", "virtual"], { primary: "element", sizeClass: "sizeClass" }, { spawn: "text" }, "released Genemon become rescues for others (src/ui/worldStore.ts, and the Lab screen writes a lighter row with only `detail`: see docs/DATA-MODEL.md)"),
  "genemon.breed": ev(
    "src/genome/breeding.ts caller (lab)",
    "proposed",
    ["lab"],
    { parentA: "text", parentB: "text", distance: "number" },
    { child: "text", generation: "number", mutations: "number", kind: "bodyKind", primary: "element", sizeClass: "sizeClass" },
    "breed(); distance = geneticDistance(a, b); mutations = child.mutations.length",
  ),
  "genemon.fuse": ev(
    "src/genome/breeding.ts caller (lab)",
    "proposed",
    ["lab"],
    { a: "text", b: "text" },
    { child: "text", generation: "number", sizeClass: "sizeClass", primary: "element" },
    "fuse(): the stronger pole wins per axis, the body grows",
  ),
  "dex.register": ev("src/ui (collection)", "proposed", ["virtual"], { primary: "element", kind: "bodyKind", pattern: "pattern", sizeClass: "sizeClass" }, {}, "first time this player owns this element x kind x pattern x size combination"),
  // ---- battle: written today by src/combat/battle.ts (who = the acting Genemon; where.zone = arena kind).
  // Battle writes start/end/ko/reaction/weather at every detail level, the other rows only with detail "full".
  "battle.start": ev(
    COMBAT,
    "emitted",
    ARENA,
    { seed: "number", arena: "arenaKind", weather: "weather", hour: "hour", teamA: "text", teamB: "text" },
    { synergiesA: "text", synergiesB: "text", fighters: "number" },
    "teams locked in; who = system, from/to = the two owners",
    { requested: { entries: { mode: "battleMode" } } },
  ),
  "battle.decide": ev(
    COMBAT,
    "emitted",
    ARENA,
    { options: "number", hp: "number", energy: "number", fear: "number", anger: "number" },
    { move: "move", target: "text", utility: "number", second: "number" },
    "a fighter commits to a move; exits.move = the move it starts charging",
  ),
  "battle.hit": ev(
    COMBAT,
    "emitted",
    ARENA,
    {
      move: "move",
      power: "number",
      atk: "number",
      def: "number",
      type: "number",
      stab: "number",
      weather: "number",
      ground: "number",
      conduction: "number",
      size: "number",
      emotion: "number",
      team: "number",
      rhythm: "number",
      reaction: "number",
      crit: "boolean",
    },
    { damage: "number", hp: "number", hpFrac: "number" },
    "landed hit with every damage factor: type = typeMultiplier(); weather, ground, conduction... are multipliers, not ids",
    {
      requested: {
        entries: {
          element: "element",
          contact: "boolean",
          targetGround: "ground",
          targetElement: "element",
          attackerSize: "sizeClass",
          targetSize: "sizeClass",
          weatherId: "weather",
        },
      },
    },
  ),
  "battle.miss": ev(COMBAT, "emitted", ARENA, { move: "move" }, { hp: "number" }, "an attack that did not land (why = the roll)", {
    requested: { exits: { reason: "dodgeReason" } },
  }),
  "battle.fail": ev(COMBAT, "emitted", ARENA, { move: "move" }, { reason: "text" }, "a move the world refused, e.g. Burrow on undiggable ground"),
  "battle.clash": ev(
    COMBAT,
    "emitted",
    ARENA,
    { a: "element", b: "element" },
    { reaction: "text" },
    "two projectiles met mid-air; reaction = a REACTIONS id or cancel; from/to = the two moves",
  ),
  "battle.reaction": ev(
    COMBAT,
    "emitted",
    ARENA,
    { a: "element", b: "element" },
    { reaction: "reaction", damageMult: "number", zone: "text" },
    "elements.ts REACTIONS fired (target state, zone, ground under the impact or a chained current); who = the cause or environment",
    { requested: { entries: { ground: "ground", weather: "weather" }, exits: { allies: "number" } }, envelope: { from: "element", to: "element" } },
  ),
  "battle.status": ev(COMBAT, "emitted", ARENA, { status: "status", duration: "number" }, { active: "number" }, "status applied; to = the target"),
  "battle.terrain": ev(
    COMBAT,
    "emitted",
    ARENA,
    { move: "move", radius: "number" },
    { cells: "number" },
    "ground changed by transformGround or a terrain move; from/to = ground before/after",
    { envelope: { from: "ground", to: "ground" } },
  ),
  "battle.weather": ev(
    COMBAT,
    "emitted",
    ARENA,
    { duration: "number" },
    { weather: "weather" },
    "weather changed; who = the shaper, or sky when it expires (counts for nobody); from/to = weather before/after",
    { envelope: { from: "weather", to: "weather" } },
  ),
  "battle.ko": ev(
    COMBAT,
    "emitted",
    ARENA,
    { t: "number" },
    { team: "number" },
    "a Genemon knocked out; who = the attacker, to = the fallen",
    {
      requested: {
        entries: {
          move: "move",
          element: "element",
          attackerSize: "sizeClass",
          targetSize: "sizeClass",
          targetElement: "element",
          ground: "ground",
          weather: "weather",
          night: "boolean",
        },
        exits: { mult: "number" },
      },
    },
  ),
  "battle.end": ev(
    COMBAT,
    "emitted",
    ARENA,
    { arena: "arenaKind", weatherStart: "weather", weatherEnd: "weather", hour: "hour", synergiesA: "text", synergiesB: "text" },
    { winner: "number", duration: "number", hpA: "number", hpB: "number", mvp: "text", reactions: "text" },
    "one row per battle (who = system); winner 0 = side A, 1 = side B, 2 = draw",
  ),
  // ---- proposed: per-owner views of battle.end (who = the owner), so a win can be counted for its player.
  "battle.win": ev(
    COMBAT,
    "proposed",
    ARENA,
    { ...BATTLE_CONTEXT, myMaxSize: "sizeClass", weatherChanged: "boolean" },
    { survivors: "number", flawless: "boolean", reactions: "number", durationS: "number" },
    "decisive win; weather = the sky at the start; reactions = reactions the winning side caused",
  ),
  "battle.loss": ev(COMBAT, "proposed", ARENA, { ...BATTLE_CONTEXT }, { durationS: "number" }, "decisive loss"),
  "ladder.promote": ev("src/ladder", "proposed", ARENA, { tier: "ladderTier" }, { mmr: "number" }, "ladder tier reached"),
  // ---- physical world (GPS-verified presence only)
  "world.visit": ev(
    WORLD,
    "emitted",
    GPS,
    { poi: "poi", firstVisit: "boolean", hour: "hour", night: "boolean", weather: "weather" },
    {},
    "arrived at a real point of interest; weather = real weather mapped to a WeatherId",
  ),
  "world.purchase": ev(WORLD, "proposed", GPS, { item: "food", units: "number", poi: "poi" }, {}, "bought food in a real shop while present (no receipt data stored)"),
  "world.claim": ev(WORLD, "emitted", GPS, { territory: "text", ground: "ground", poi: "poi" }, {}, "territory cell claimed on site"),
  "world.defend": ev(WORLD, "emitted", GPS, { territory: "text", ground: "ground", attackers: "number" }, { won: "boolean" }, "own territory attacked (passive, async)"),
  "world.raid": ev(WORLD, "emitted", GPS, { territory: "text", ground: "ground" }, { won: "boolean" }, "attacked a rival territory on site"),
  // ---- proposed: social, market, meta
  "social.friend": ev("src/net", "proposed", ["virtual", "physical"], { friend: "text" }, {}, "friendship accepted"),
  "social.visit": ev("src/net", "proposed", ["virtual"], { friend: "text" }, {}, "visited a friend's habitat"),
  "social.trade": ev("src/net", "proposed", ["virtual", "physical"], { partner: "text", kind: "itemKind" }, {}, "trade completed"),
  "social.gift": ev("src/net", "proposed", ["virtual", "physical"], { friend: "text", item: "food", units: "number" }, {}, "gift sent"),
  "social.coop": ev("src/net", "proposed", ["arena"], { mode: "battleMode", players: "number" }, { won: "boolean" }, "co-op battle finished"),
  "shop.buy": ev(ECONOMY, "proposed", MARKET, { item: "food", units: "number" }, { credits: "number" }, "virtual shop purchase (sofa)"),
  "market.post": ev(
    ECONOMY,
    "emitted",
    MARKET,
    {
      itemId: "text",
      kind: "itemKind",
      qty: "number",
      startPrice: "number",
      buyout: "number",
      hasBuyout: "boolean",
      durationMs: "number",
      promoDiscount: "number",
      promoLabel: "text",
    },
    { listingId: "text", endsAt: "number", promoEndsAt: "number", fair: "number" },
    "listing opened; who = the seller",
    { requested: { entries: { generation: "number", sizeClass: "sizeClass" } } },
  ),
  "market.bid": ev(
    ECONOMY,
    "emitted",
    MARKET,
    { listingId: "text", itemId: "text", qty: "number", amount: "number", minBid: "number", prevBid: "number", msLeft: "number" },
    { currentBid: "number", endsAt: "number", extended: "boolean", refundTo: "text", refundAmount: "number", balance: "number" },
    "bid placed; who = the bidder",
  ),
  "market.sold": ev(
    ECONOMY,
    "emitted",
    MARKET,
    { listingId: "text", itemId: "text", kind: "itemKind", qty: "number", price: "number", bids: "number", extensions: "number", endsAt: "number" },
    { buyerId: "player", sellerId: "player", fee: "number", proceeds: "number", unitPrice: "number" },
    "auction closed with a winning bid; who = house, so content filters sellerId: ME or buyerId: ME",
    { requested: { entries: { generation: "number", sizeClass: "sizeClass" } } },
  ),
  "market.buyout": ev(
    ECONOMY,
    "emitted",
    MARKET,
    { listingId: "text", itemId: "text", kind: "itemKind", qty: "number", price: "number", listPrice: "number", promoActive: "boolean", discount: "number" },
    { sellerId: "player", fee: "number", proceeds: "number", refundTo: "text", refundAmount: "number", balance: "number", unitPrice: "number" },
    "instant purchase at the buyout price; who = the buyer",
  ),
  "quest.complete": ev("src/ui/progressStore.ts", "emitted", ["virtual", "physical"], { quest: "text", kind: "questKind", giver: "text", physical: "boolean" }, {}, "quest finished"),
  "achievement.unlock": ev("src/ui/progressStore.ts", "emitted", ["ui"], { achievement: "text", category: "achievementCategory", tier: "number" }, {}, "achievement unlocked"),
};

const OPS = [">=", "<=", "!="] as const;
export type FilterOp = "=" | typeof OPS[number];

/**
 * Parse a filter key. Syntax: [entries.|exits.]key[>=|<=|!=]
 *   "reaction"          entries.reaction, else exits.reaction, must EQUAL the value
 *   "exits.toStage"     look only in exits
 *   "credits>="         numeric lower bound (also "<=" upper bound, "!=" inequality)
 */
export function parseFilterKey(raw: string): { scope: "any" | "entries" | "exits"; key: string; op: FilterOp } {
  let key = raw;
  let op: FilterOp = "=";
  for (const o of OPS) {
    if (key.endsWith(o)) {
      op = o;
      key = key.slice(0, -o.length);
      break;
    }
  }
  if (key.startsWith("entries.")) return { scope: "entries", key: key.slice(8), op };
  if (key.startsWith("exits.")) return { scope: "exits", key: key.slice(6), op };
  return { scope: "any", key, op };
}

type Row = Pick<GEvent, "what" | "where" | "entries" | "exits"> & Partial<Pick<GEvent, "from" | "to">>;

/** Placeholder filter value for "the player whose progress is counted" (market.sold { sellerId: ME }). */
export const ME = "$me";

/**
 * Does a ledger row satisfy a trigger's what / where / filter? (count is accumulated by the caller.)
 * An unscoped key is looked up in entries, then exits, then (for "from" / "to") the GEvent envelope.
 * A filter value ME matches the id passed as `me`; without `me` such a filter never matches.
 */
export function triggerMatches(t: Pick<Trigger, "what" | "where" | "filter">, e: Row, me?: string): boolean {
  if (e.what !== t.what) return false;
  if (t.where !== undefined && e.where.space !== t.where && e.where.zone !== t.where) return false;
  for (const [raw, value] of Object.entries(t.filter ?? {})) {
    const { scope, key, op } = parseFilterKey(raw);
    let got: FilterValue | undefined = scope === "exits" ? e.exits[key] : scope === "entries" ? e.entries[key] : key in e.entries ? e.entries[key] : e.exits[key];
    if (got === undefined && scope === "any" && (key === "from" || key === "to")) got = e[key];
    const want = value === ME ? me : value;
    if (got === undefined || want === undefined) return false;
    if (op === "=" && got !== want) return false;
    if (op === "!=" && got === want) return false;
    if ((op === ">=" || op === "<=") && (typeof got !== "number" || typeof want !== "number")) return false;
    if (op === ">=" && (got as number) < (want as number)) return false;
    if (op === "<=" && (got as number) > (want as number)) return false;
  }
  return true;
}

/** Where a filter key resolves in an event spec, mirroring triggerMatches(); undefined = unknown key. */
export interface KeyInfo {
  domain: Domain;
  source: "entries" | "exits" | "envelope";
  /** true = the emitter does not write this key yet (EventSpec.requested). */
  requested: boolean;
}

export function resolveKey(spec: EventSpec, raw: string): KeyInfo | undefined {
  const { scope, key } = parseFilterKey(raw);
  const look = (s: "entries" | "exits"): KeyInfo | undefined => {
    const own = spec[s][key];
    if (own !== undefined) return { domain: own, source: s, requested: false };
    const req = spec.requested?.[s]?.[key];
    return req !== undefined ? { domain: req, source: s, requested: true } : undefined;
  };
  if (scope !== "any") return look(scope);
  const env = key === "from" || key === "to" ? spec.envelope?.[key] : undefined;
  return look("entries") ?? look("exits") ?? (env !== undefined ? { domain: env, source: "envelope", requested: false } : undefined);
}

/** Can this trigger progress on the rows src/ modules write today (emitted event, no requested keys)? */
export function progressesToday(t: Pick<Trigger, "what" | "filter">): boolean {
  const spec = CONTENT_EVENTS[t.what];
  if (!spec || spec.status !== "emitted") return false;
  return Object.keys(t.filter ?? {}).every((raw) => resolveKey(spec, raw)?.requested === false);
}

/** Progress a matching row adds: its positive numeric entries.units (km, portions, gifts), else 1. */
export function eventWeight(e: Pick<GEvent, "entries">): number {
  const u = e.entries.units;
  return typeof u === "number" && Number.isFinite(u) && u > 0 ? u : 1;
}

// ---------------------------------------------------------------- achievements

export const ACHIEVEMENT_CATEGORIES = [
  "battle",
  "collection",
  "breeding",
  "exploration",
  "lifestyle",
  "social",
  "market",
  "territory",
  "mastery",
  "secret",
] as const;
export type AchievementCategory = typeof ACHIEVEMENT_CATEGORIES[number];
export type Tier = 1 | 2 | 3 | 4;

export interface Achievement {
  id: string;
  name: string;
  category: AchievementCategory;
  /** 1 first week .. 4 months of play; rewards scale with tier (bands in docs/LISTS.md). */
  tier: Tier;
  description: string;
  trigger: Trigger;
  reward: { credits: number; itemId?: string; title?: string };
}

const t = (what: string, count: number, filter?: Record<string, FilterValue>, where?: string): Trigger => ({
  what,
  count,
  ...(filter ? { filter } : {}),
  ...(where ? { where } : {}),
});

function a(
  id: string,
  name: string,
  category: AchievementCategory,
  tier: Tier,
  description: string,
  trigger: Trigger,
  credits: number,
  extra: { itemId?: string; title?: string } = {},
): Achievement {
  return { id, name, category, tier, description, trigger, reward: { credits, ...extra } };
}

/** Default credits of the generated per-reaction / per-weather achievements. */
const TIER_CREDITS: Record<Tier, number> = { 1: 120, 2: 350, 3: 1000, 4: 4000 };

/** One achievement per reaction: a new ReactionId without an entry here fails to compile. */
const REACTION_GOALS: Record<ReactionId, [name: string, tier: Tier, count: number, hint: string]> = {
  smoke: ["Smoke Signals", 1, 10, "land fire on water (or water on fire); the cloud blinds everyone inside"],
  wildfire: ["Brushfire", 1, 10, "burn plant Genemon or vegetation"],
  melt: ["Thaw", 1, 10, "hit ice with fire and frozen ground turns back to water"],
  firestorm: ["Fanned Flames", 2, 10, "let wind feed a fire attack"],
  magma: ["The Floor Is Lava", 2, 10, "set earth alight into molten ground"],
  forge: ["Red-Hot Iron", 1, 10, "soften metal armour with fire"],
  conduction: ["Current Affairs", 1, 25, "run electricity through water or wet targets"],
  mud: ["Mudslinger", 1, 10, "soak earth into slowing mud"],
  freeze: ["Flash Freeze", 1, 10, "freeze water, or a wet Genemon, with ice"],
  contamination: ["Tainted Well", 2, 10, "poison a body of water"],
  mist: ["Mist Walker", 1, 10, "blow water into an accuracy-sapping mist"],
  dust: ["Dust Devil", 1, 10, "whip earth into a dust cloud"],
  disperse: ["Clear the Air", 2, 10, "blow a toxic cloud away with wind"],
  magnetize: ["Lodestone", 2, 10, "magnetise metal with electricity"],
  bloom: ["Rain Garden", 1, 10, "water plants into a regenerating bloom"],
  eclipse: ["Total Eclipse", 3, 10, "make light and shadow annihilate in a flash"],
  blizzard: ["Whiteout", 2, 10, "drive ice with wind"],
  blight: ["Rot and Ruin", 2, 10, "rot growth with poison"],
};

/** One win-under-weather achievement per weather: a new WeatherId without an entry fails to compile. */
const WEATHER_GOALS: Record<WeatherId, [name: string, tier: Tier, count: number, hint: string]> = {
  clear: ["Fair-Weather Fighter", 1, 10, "no modifiers: pure fundamentals"],
  heatwave: ["Heatstroke", 2, 5, "fire strengthened, ice weakened"],
  rain: ["Singing in the Rain", 1, 5, "everyone is wet, electricity conducts, fire fizzles"],
  storm: ["Eye of the Storm", 2, 5, "electricity rules and flyers are buffeted"],
  snow: ["Snowbound", 2, 5, "ice strengthened, footing slippery"],
  fog: ["Into the Fog", 2, 5, "ranged accuracy collapses, close combat rules"],
  wind: ["Gale Force", 2, 5, "air strengthened, projectiles drift"],
  sandstorm: ["Sandblasted", 2, 5, "earth strengthened, chip damage for the rest"],
  aurora: ["Northern Lights", 3, 3, "a rare night sky that amplifies light and minds"],
  eclipse: ["Darkest Hour", 3, 3, "shadow and void thrive, light falters"],
  acidRain: ["Corroded", 2, 5, "poison thrives while metal and plants corrode"],
  ashfall: ["Ashen", 3, 3, "volcanic fallout; no move summons it, find it in the world"],
};

const kebab = (id: string) => id.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

const reactionAchievements = (Object.entries(REACTION_GOALS) as [ReactionId, [string, Tier, number, string]][]).map(
  ([r, [name, tier, count, hint]]) =>
    a(`reaction-${kebab(r)}`, name, "battle", tier, `Trigger the ${r} reaction ${count} times: ${hint}.`, t("battle.reaction", count, { reaction: r }), TIER_CREDITS[tier]),
);

const weatherAchievements = (Object.entries(WEATHER_GOALS) as [WeatherId, [string, Tier, number, string]][]).map(
  ([w, [name, tier, count, hint]]) =>
    a(`weather-${kebab(w)}`, name, "battle", tier, `Win ${count} battles fought under ${w}: ${hint}.`, t("battle.win", count, { weather: w }), TIER_CREDITS[tier]),
);

const exp = (experience: ExperienceId, extra: Record<string, FilterValue> = {}) => ({ experience, ...extra });

export const ACHIEVEMENTS: readonly Achievement[] = [
  // ---------------------------------------------------------------- battle
  a("first-victory", "First Victory", "battle", 1, "Win your first battle.", t("battle.win", 1), 50),
  a("arena-regular", "Arena Regular", "battle", 1, "Win 25 battles.", t("battle.win", 25), 150),
  a("stadium-veteran", "Stadium Veteran", "battle", 2, "Win 250 battles.", t("battle.win", 250), 600),
  a("living-legend", "Living Legend", "battle", 4, "Win 2,500 battles.", t("battle.win", 2500), 6000, { title: "Legend" }),
  a("know-your-types", "Know Your Types", "battle", 1, "Land 100 super-effective hits (type multiplier 2 or more).", t("battle.hit", 100, { "type>=": 2 }), 120),
  a("four-times-the-fury", "Four Times the Fury", "battle", 2, "Land a x4 hit on a dual type weak to your element twice over.", t("battle.hit", 1, { "type>=": 4 }), 300),
  a("untouchable", "Untouchable", "battle", 3, "Win 10 battles without any of your Genemon being knocked out.", t("battle.win", 10, { flawless: true }), 1200),
  a("last-one-standing", "Last One Standing", "battle", 2, "Win 5 battles with a team of 3 or more where only one Genemon is left standing.", t("battle.win", 5, { survivors: 1, "teamSize>=": 3 }), 400),
  a("one-against-many", "One Against Many", "battle", 2, "Win alone with a Large or bigger Genemon (3+ slots) against 3 or more enemies.", t("battle.win", 1, { teamSize: 1, "mySlots>=": 3, "enemyCount>=": 3 }), 500),
  a("colossus", "Colossus", "battle", 3, "Win 25 battles with a lone XL Genemon against 4 or more enemies.", t("battle.win", 25, { teamSize: 1, myMaxSize: "XL", "enemyCount>=": 4 }), 2000, { title: "Colossus" }),
  a("ant-army", "Ant Army", "battle", 2, "Topple a lone giant (4+ slots) with a swarm of 4 or more Genemon, 5 times.", t("battle.win", 5, { "teamSize>=": 4, enemyCount: 1, "enemySlots>=": 4 }), 500),
  a("david-and-goliath", "David and Goliath", "battle", 3, "Knock out an XL Genemon with an XS one.", t("battle.ko", 1, { attackerSize: "XS", targetSize: "XL" }), 1500),
  a("above-it-all", "Above It All", "battle", 2, "Let 10 Quakes pass harmlessly beneath an airborne Genemon.", t("battle.miss", 10, { move: "quake", "exits.reason": "airborne" }), 400),
  a("underground", "Underground", "battle", 2, "Avoid 25 hits while burrowed.", t("battle.miss", 25, { "exits.reason": "burrowed" }), 350),
  a("shapeless", "Shapeless", "battle", 2, "Melt into liquid form 10 times (contact hits on a liquid body deal half damage).", t("battle.decide", 10, { "exits.move": "meltForm" }), 400),
  a("midair-meeting", "Mid-Air Meeting", "battle", 1, "Make 10 projectiles collide mid-air (fire into water makes smoke there).", t("battle.clash", 10), 120),
  a("rink-maker", "Rink Maker", "battle", 1, "Freeze 10 patches of water into slippery ice.", t("battle.terrain", 10, { from: "water", to: "ice" }), 150),
  a("landscaper", "Landscaper", "battle", 3, "Reshape the arena ground 250 times.", t("battle.terrain", 250), 1000),
  a("rainmaker", "Rainmaker", "battle", 1, "Change the weather mid-battle 10 times.", t("battle.weather", 10), 150),
  a("changing-tides", "Changing Tides", "battle", 2, "Win 10 battles in which the weather was changed mid-fight.", t("battle.win", 10, { weatherChanged: true }), 500),
  a("perfect-circuit", "Perfect Circuit", "battle", 2, "Win 10 battles in which your team set off 3 or more element reactions (synergy).", t("battle.win", 10, { "exits.reactions>=": 3 }), 450),
  a("night-shift", "Night Shift", "battle", 2, "Win 25 battles at night (local time): nocturnal Genemon shine.", t("battle.win", 25, { night: true }), 350, { itemId: "badge.night" }),
  a("high-noon", "High Noon", "battle", 1, "Win 10 battles between 11:00 and 13:59: diurnal Genemon shine.", t("battle.win", 10, { "hour>=": 11, "hour<=": 13 }), 150),
  a("raid-breaker", "Raid Breaker", "battle", 2, "Win 10 raid battles.", t("battle.win", 10, { mode: "raid" }), 400),
  a("live-wire", "Live Wire", "battle", 1, "Chain 10 conduction shocks onto targets standing in water (the best conductor).", t("battle.reaction", 10, { reaction: "conduction", ground: "water" }), 150),
  a("murky-circuit", "Murky Circuit", "battle", 2, "Chain 10 conduction shocks onto targets in muddy water (conducts less than clear water).", t("battle.reaction", 10, { reaction: "conduction", ground: "muddyWater" }), 300),
  a("grounded-current", "Grounded Current", "battle", 2, "Chain 10 conduction shocks onto wet targets standing on mud (it barely conducts).", t("battle.reaction", 10, { reaction: "conduction", ground: "mud" }), 350),
  a("abyssal-arc", "Abyssal Arc", "battle", 3, "Chain 50 conduction shocks through deep water.", t("battle.reaction", 50, { reaction: "conduction", ground: "deepWater" }), 900),
  a("fog-machine", "Fog Machine", "battle", 2, "Create 100 smoke clouds.", t("battle.reaction", 100, { reaction: "smoke" }), 600),
  a("alchemist", "Alchemist", "battle", 3, "Trigger 500 element reactions of any kind.", t("battle.reaction", 500), 1500, { itemId: "scanner.dna" }),
  ...reactionAchievements,
  ...weatherAchievements,
  // ---------------------------------------------------------------- collection
  a("hello-world", "Hello, World", "collection", 1, "Catch your first wild Genemon.", t("genemon.catch", 1), 50),
  a("field-researcher", "Field Researcher", "collection", 2, "Catch 100 wild Genemon.", t("genemon.catch", 100), 400),
  a("living-dex", "Living Dex", "collection", 3, "Catch 1,000 wild Genemon.", t("genemon.catch", 1000), 2000),
  a("cataloguer", "Cataloguer", "collection", 1, "Register 25 new element x body x pattern x size combinations.", t("dex.register", 25), 150),
  a("genomic-atlas", "Genomic Atlas", "collection", 3, "Register 300 combinations.", t("dex.register", 300), 2500, { title: "Atlas" }),
  a("heavy-metal", "Heavy Metal", "collection", 2, "Catch 5 metal Genemon, the rarest primary type in the wild.", t("genemon.catch", 5, { primary: "metal" }), 400),
  a("thin-ice", "Thin Ice", "collection", 2, "Catch 5 ice Genemon.", t("genemon.catch", 5, { primary: "ice" }), 350),
  a("big-game", "Big Game", "collection", 3, "Catch a wild XL Genemon.", t("genemon.catch", 1, { sizeClass: "XL" }), 1200),
  a("pocket-monster", "Pocket Monster", "collection", 1, "Catch 10 XS Genemon.", t("genemon.catch", 10, { sizeClass: "XS" }), 120),
  a("bird-watcher", "Bird Watcher", "collection", 1, "Catch 10 avian Genemon.", t("genemon.catch", 10, { kind: "avian" }), 120),
  a("boots-on-the-ground", "Boots on the Ground", "collection", 2, "Catch 100 Genemon at real-world spawns.", t("genemon.catch", 100, undefined, "physical"), 600),
  a("night-collector", "Night Collector", "collection", 2, "Catch 10 shadow Genemon at night.", t("genemon.catch", 10, { primary: "shadow", night: true }), 400, { itemId: "lure.night" }),
  a("storm-chaser", "Storm Chaser", "collection", 2, "Catch 5 Genemon during a thunderstorm.", t("genemon.catch", 5, { weather: "storm" }), 400, { itemId: "lure.storm" }),
  // ---------------------------------------------------------------- breeding
  a("matchmaker", "Matchmaker", "breeding", 1, "Breed your first child.", t("genemon.breed", 1), 80),
  a("breeder", "Breeder", "breeding", 2, "Breed 50 children.", t("genemon.breed", 50), 500, { itemId: "incubator" }),
  a("third-generation", "Third Generation", "breeding", 1, "Breed a generation-3 Genemon.", t("genemon.breed", 1, { "generation>=": 3 }), 150),
  a("dynasty", "Dynasty", "breeding", 3, "Breed a generation-10 Genemon.", t("genemon.breed", 1, { "generation>=": 10 }), 1500),
  a("ancient-bloodline", "Ancient Bloodline", "breeding", 4, "Breed a generation-25 Genemon.", t("genemon.breed", 1, { "generation>=": 25 }), 5000, { title: "Lineage Keeper" }),
  a("spontaneous", "Spontaneous", "breeding", 2, "Breed a child carrying 3 or more fresh mutations (chaotic parents mutate more).", t("genemon.breed", 1, { "mutations>=": 3 }), 400),
  a("hybrid-vigour", "Hybrid Vigour", "breeding", 2, "Breed 5 children from genetically distant parents (distance 0.5 or more).", t("genemon.breed", 5, { "distance>=": 0.5 }), 350),
  a("two-become-one", "Two Become One", "breeding", 2, "Fuse two Genemon.", t("genemon.fuse", 1), 300),
  a("chimera-smith", "Chimera Smith", "breeding", 3, "Fuse 10 times.", t("genemon.fuse", 10), 1500),
  a("kaiju", "Kaiju", "breeding", 3, "Create an XL Genemon by fusion.", t("genemon.fuse", 1, { sizeClass: "XL" }), 1200),
  a("coming-of-age", "Coming of Age", "breeding", 1, "Raise a Genemon to its Adult stage.", t("genemon.evolve", 1, { "exits.toStage": 3 }), 100),
  a("ascension", "Ascension", "breeding", 4, "Raise a Genemon to its Ascended stage (level 40, bond 0.6, 25 wins).", t("genemon.evolve", 1, { "exits.toStage": 4 }), 4000, { title: "Ascendant", itemId: "cosmetic.crown" }),
  // ---------------------------------------------------------------- exploration
  a("first-steps", "First Steps", "exploration", 1, "Walk 10 km with your Genemon.", t("genemon.experience", 10, exp("travelKm")), 80),
  a("trailblazer", "Trailblazer", "exploration", 2, "Walk 250 km.", t("genemon.experience", 250, exp("travelKm")), 500, { itemId: "map.fragment" }),
  a("pilgrim", "Pilgrim", "exploration", 4, "Walk 2,500 km.", t("genemon.experience", 2500, exp("travelKm")), 5000, { title: "Pilgrim" }),
  a("new-horizons", "New Horizons", "exploration", 1, "Visit 10 places you have never been.", t("world.visit", 10, { firstVisit: true }), 120),
  a("cartographer", "Cartographer", "exploration", 3, "Visit 250 new places.", t("world.visit", 250, { firstVisit: true }), 1500, { title: "Cartographer" }),
  a("moonlit-stroll", "Moonlit Stroll", "exploration", 1, "Take 5 night walks.", t("genemon.experience", 5, exp("nightWalk")), 100),
  a("creature-of-the-night", "Creature of the Night", "exploration", 3, "Take 100 night walks.", t("genemon.experience", 100, exp("nightWalk")), 1200, { itemId: "cosmetic.lantern" }),
  a("summit-fever", "Summit Fever", "exploration", 2, "Climb 20 times.", t("genemon.experience", 20, exp("climbing")), 400),
  a("frequent-flyer", "Frequent Flyer", "exploration", 1, "Log 25 flight sessions.", t("genemon.experience", 25, exp("flightTime")), 100),
  a("mole", "Mole", "exploration", 1, "Log 25 digging sessions.", t("genemon.experience", 25, exp("digging")), 100),
  a("deep-end", "Deep End", "exploration", 1, "Log 25 swimming sessions.", t("genemon.experience", 25, exp("swimming")), 100),
  a("lakeside", "Lakeside", "exploration", 1, "Visit a real lake 5 times.", t("world.visit", 5, { poi: "lake" }), 100),
  a("thin-air", "Thin Air", "exploration", 2, "Visit a mountain 5 times.", t("world.visit", 5, { poi: "mountain" }), 350),
  a("curator", "Curator", "exploration", 1, "Visit a museum 3 times.", t("world.visit", 3, { poi: "museum" }), 100),
  // ---------------------------------------------------------------- lifestyle
  a("well-fed", "Well Fed", "lifestyle", 1, "Serve 100 portions of food.", t("genemon.feed", 100), 80),
  a("gourmet", "Gourmet", "lifestyle", 3, "Serve 2,000 portions.", t("genemon.feed", 2000), 1000),
  a("hot-stuff", "Hot Stuff", "lifestyle", 1, "Feed 25 spicy peppers (they push the heat axis toward fire).", t("genemon.feed", 25, { food: "spicyPepper" }), 120),
  a("sweet-tooth", "Sweet Tooth", "lifestyle", 1, "Feed 50 candies (joy now, vitality later).", t("genemon.feed", 50, { food: "candy" }), 60),
  a("glow-up", "Glow Up", "lifestyle", 2, "Feed 30 glow fruits.", t("genemon.feed", 30, { food: "glowFruit" }), 300),
  a("weekly-shop", "Weekly Shop", "lifestyle", 1, "Take your Genemon on 5 real supermarket trips.", t("world.visit", 5, { poi: "supermarket" }), 100),
  a("regular-customer", "Regular Customer", "lifestyle", 2, "Make 50 supermarket trips.", t("world.visit", 50, { poi: "supermarket" }), 500),
  a("pepper-run", "Pepper Run", "lifestyle", 1, "Buy 10 spicy peppers in a real shop.", t("world.purchase", 10, { item: "spicyPepper" }), 100),
  a("gym-buddy", "Gym Buddy", "lifestyle", 1, "Train at a real gym 10 times.", t("genemon.experience", 10, exp("gymTraining")), 120),
  a("membership-card", "Membership Card", "lifestyle", 2, "Check in at a gym 30 times.", t("world.visit", 30, { poi: "gym" }), 450, { itemId: "badge.gym" }),
  a("iron-discipline", "Iron Discipline", "lifestyle", 3, "Train at a gym 200 times.", t("genemon.experience", 200, exp("gymTraining")), 1500),
  a("inner-calm", "Inner Calm", "lifestyle", 1, "Meditate 30 times.", t("genemon.experience", 30, exp("meditation")), 100),
  a("jam-session", "Jam Session", "lifestyle", 1, "Play 30 music sessions.", t("genemon.experience", 30, exp("music")), 80),
  a("best-friend", "Best Friend", "lifestyle", 2, "Pet your Genemon 300 times.", t("genemon.experience", 300, exp("petting")), 300),
  a("solar-charged", "Solar Charged", "lifestyle", 1, "Sunbathe 20 times outdoors.", t("genemon.experience", 20, exp("sunbathing")), 100),
  a("puzzle-master", "Puzzle Master", "lifestyle", 2, "Solve 100 puzzles.", t("genemon.experience", 100, exp("puzzle")), 400),
  a("moss-bed", "Moss Bed", "lifestyle", 1, "Spend 10 sessions of an hour or more on moss.", t("genemon.exposure", 10, { ground: "moss", "hours>=": 1 }), 80),
  a("raised-by-the-river", "Raised by the River", "lifestyle", 2, "Let a lifestyle give a Genemon a water secondary type.", t("genemon.specialize", 1, { "exits.secondary": "water" }), 400),
  // ---------------------------------------------------------------- social
  a("circle-of-friends", "Circle of Friends", "social", 1, "Make 5 friends.", t("social.friend", 5), 80),
  a("fair-trade", "Fair Trade", "social", 2, "Complete 10 trades.", t("social.trade", 10), 350),
  a("generous", "Generous", "social", 1, "Gift 25 portions of food to friends.", t("social.gift", 25), 100),
  a("strength-in-numbers", "Strength in Numbers", "social", 2, "Win 10 co-op battles with 3 or more players.", t("social.coop", 10, { "exits.won": true, "players>=": 3 }), 500),
  a("playdates", "Playdates", "social", 1, "Let your Genemon play with friends' Genemon 25 times.", t("genemon.experience", 25, exp("socialPlay")), 100),
  a("second-chance", "Second Chance", "social", 1, "Rescue a released Genemon in the real world.", t("genemon.experience", 1, exp("rescue")), 150),
  a("shelter-hero", "Shelter Hero", "social", 3, "Rescue 25 released Genemon.", t("genemon.experience", 25, exp("rescue")), 1500, { title: "Rescuer", itemId: "cosmetic.scarf" }),
  a("friendly-rivals", "Friendly Rivals", "social", 1, "Win 20 friendly battles.", t("battle.win", 20, { mode: "friendly" }), 150),
  a("housewarming", "Housewarming", "social", 1, "Visit friends' habitats 10 times.", t("social.visit", 10), 100),
  // ---------------------------------------------------------------- market
  a("paddle-up", "Paddle Up", "market", 1, "Place your first auction bid.", t("market.bid", 1), 50),
  a("open-for-business", "Open for Business", "market", 1, "Close your first auction sale.", t("market.sold", 1, { sellerId: ME }), 100),
  a("merchant", "Merchant", "market", 2, "Close 25 auction sales.", t("market.sold", 25, { sellerId: ME }), 600),
  a("tycoon", "Tycoon", "market", 3, "Close 250 auction sales.", t("market.sold", 250, { sellerId: ME }), 2500, { title: "Tycoon" }),
  a("high-roller", "High Roller", "market", 3, "Sell a single lot for 5,000 credits or more.", t("market.sold", 1, { sellerId: ME, "price>=": 5000 }), 1000),
  a("pedigree", "Pedigree", "market", 2, "Sell a Genemon of generation 5 or more at auction.", t("market.sold", 1, { sellerId: ME, kind: "genemon", "generation>=": 5 }), 500),
  a("collectors-eye", "Collector's Eye", "market", 1, "Win 10 auctions as a buyer.", t("market.sold", 10, { buyerId: ME }), 150),
  a("auction-house", "Auction House", "market", 2, "List 50 lots.", t("market.post", 50), 400),
  a("virtual-grocer", "Virtual Grocer", "market", 1, "Buy 30 portions in the virtual shop.", t("shop.buy", 30), 80),
  // ---------------------------------------------------------------- territory
  a("stake-a-claim", "Stake a Claim", "territory", 1, "Claim your first territory on site.", t("world.claim", 1), 100),
  a("landlord", "Landlord", "territory", 2, "Claim 25 territories.", t("world.claim", 25), 600),
  a("harbour-master", "Harbour Master", "territory", 2, "Claim 3 territories on water.", t("world.claim", 3, { ground: "water" }), 400, { itemId: "badge.harbour" }),
  a("volcano-lair", "Volcano Lair", "territory", 3, "Claim a territory on lava.", t("world.claim", 1, { ground: "lava" }), 1200),
  a("hold-the-line", "Hold the Line", "territory", 1, "Defend your territory successfully 5 times.", t("world.defend", 5, { "exits.won": true }), 150),
  a("bulwark", "Bulwark", "territory", 2, "Defend your territory 50 times.", t("world.defend", 50, { "exits.won": true }), 600),
  a("unbreakable-wall", "Unbreakable Wall", "territory", 4, "Defend your territory 500 times.", t("world.defend", 500, { "exits.won": true }), 6000, { title: "Warden" }),
  a("outnumbered", "Outnumbered", "territory", 3, "Repel 10 raids by 3 or more attackers.", t("world.defend", 10, { "exits.won": true, "attackers>=": 3 }), 1200),
  a("raider", "Raider", "territory", 2, "Win 10 raids on rival territories.", t("world.raid", 10, { "exits.won": true }), 450),
  a("home-turf", "Home Turf", "territory", 3, "Win 100 territory battles.", t("battle.win", 100, { mode: "territory" }), 1500),
  // ---------------------------------------------------------------- mastery
  a("seasoned", "Seasoned", "mastery", 1, "Raise a Genemon to level 20.", t("genemon.levelUp", 1, { "exits.to>=": 20 }), 150),
  a("elite", "Elite", "mastery", 3, "Raise a Genemon to level 50.", t("genemon.levelUp", 1, { "exits.to>=": 50 }), 1500),
  a("apex", "Apex", "mastery", 4, "Raise a Genemon to level 100.", t("genemon.levelUp", 1, { "exits.to>=": 100 }), 8000, { title: "Apex" }),
  a("gold-league", "Gold League", "mastery", 2, "Reach the gold ladder tier.", t("ladder.promote", 1, { tier: "gold" }), 600),
  a("grandmaster", "Grandmaster", "mastery", 4, "Reach the master ladder tier.", t("ladder.promote", 1, { tier: "master" }), 10000, { title: "Grandmaster" }),
  a("ladder-climber", "Ladder Climber", "mastery", 3, "Win 200 ranked battles.", t("battle.win", 200, { mode: "ranked" }), 1800),
  a("creature-of-habit", "Creature of Habit", "mastery", 2, "Complete 30 daily quests.", t("quest.complete", 30, { kind: "daily" }), 500),
  a("lore-keeper", "Lore Keeper", "mastery", 2, "Complete 10 story quests.", t("quest.complete", 10, { kind: "story" }), 600),
  a("out-and-about", "Out and About", "mastery", 2, "Complete 25 physical quests.", t("quest.complete", 25, { physical: true }), 600),
  a("quest-machine", "Quest Machine", "mastery", 3, "Complete 300 quests.", t("quest.complete", 300), 2000),
  a("completionist", "Completionist", "mastery", 4, "Unlock 100 achievements.", t("achievement.unlock", 100), 7500, { title: "Completionist" }),
  // ---------------------------------------------------------------- secret (hidden until unlocked)
  a("hard-rock", "Hard Rock", "secret", 1, "Try to burrow into ground that cannot be dug.", t("battle.fail", 1, { move: "burrow" }), 100),
  a("smoke-on-the-water", "Smoke on the Water", "secret", 1, "Make smoke over a lake arena.", t("battle.reaction", 1, { reaction: "smoke", ground: "water" }), 150),
  a("double-darkness", "Double Darkness", "secret", 3, "Trigger an eclipse reaction under an eclipse sky.", t("battle.reaction", 1, { reaction: "eclipse", weather: "eclipse" }), 1000, { itemId: "egg.shadow" }),
  a("friendly-current", "Friendly Current", "secret", 1, "Shock your own wet teammate with a conduction chain.", t("battle.reaction", 1, { reaction: "conduction", "allies>=": 1 }), 100),
  a("not-a-scratch", "Not Even a Scratch", "secret", 2, "Take a hit at the minimum type multiplier (x0.25).", t("battle.hit", 1, { "type<=": 0.25 }), 300),
  a("snowballs-chance", "Snowball's Chance", "secret", 3, "Knock out an opponent with an ice move during a heatwave.", t("battle.ko", 1, { element: "ice", weather: "heatwave" }), 900),
  a("midnight-snack", "Midnight Snack", "secret", 1, "Visit a supermarket at night.", t("world.visit", 1, { poi: "supermarket", night: true }), 120),
  a("under-the-aurora", "Under the Aurora", "secret", 3, "Catch a Genemon under an aurora.", t("genemon.catch", 1, { weather: "aurora" }), 1500, { itemId: "egg.light" }),
];

export const ACHIEVEMENT_BY_ID: Record<string, Achievement> = Object.fromEntries(ACHIEVEMENTS.map((x) => [x.id, x]));
