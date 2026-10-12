/**
 * World map: the persistent, always-on Genemon world laid over the real one. Places (home,
 * supermarket, gym, park, arena, portal...) sit at real lat/lon; the ground is cut into ~100 m
 * territory cells that players claim ON SITE and defend; wild spawns are drawn from a table mixing
 * place, ground, time of day, weather and the ECOLOGY players create (catching depletes an element
 * locally, releasing seeds it). Physical-only vs virtual actions are data (PLACE_KIND_DEFS,
 * WORLD_ACTIONS). Pure: no DOM, no clock, no Math.random; `now` (epoch ms) is always a parameter.
 *
 * Coordinates: local ENU metres around `origin`, x = east, y = altitude (up), z = north, through an
 * equirectangular projection (measured error budget: docs/WORLD.md#coordinates). Territory cells
 * are a GLOBAL lat/lon grid, so every client derives the same cell ids whatever its origin (same id
 * format as src/net/antiCheat.ts geoCellId). Terrain and generated neighbourhoods are functions of
 * lat/lon too, never of the origin.
 *
 * Privacy: a home is stored only as the centre of its ~250 m grid cell (the exact fix never enters
 * this module's state); ledger rows carry a 100 m cell centre + cell id, never a raw position.
 *
 * Ledger naming: `world.*` = caused by a GPS-verified physical action (content counts these as
 * physical, see src/data/quests.ts isPhysicalTrigger); `virtual.*` = avatar actions in the virtual
 * space; `map.*` / `territory.reinforce` = world-state changes with no presence proof.
 * Design, rules and open questions: docs/WORLD.md.
 */
import { clamp, distXZ, fbm2, r3, smoothstep, type V3, v3 } from "../core/math.ts";
import type { Ledger, Scalar, Space } from "../core/ledger.ts";
import { hashSeed, Rng } from "../core/rng.ts";
import { ELEMENT_IDS, type ElementId } from "../data/elements.ts";
import { GROUND_IDS, type GroundId, GROUNDS } from "../data/grounds.ts";
import type { WeatherId } from "../data/weather.ts";

// ---------------------------------------------------------------- constants & tuning

/** IUGG mean Earth radius (same value as src/net/antiCheat.ts EARTH_RADIUS_M). */
const EARTH_RADIUS_M = 6_371_008.8;
const RAD = Math.PI / 180;
/** Metres per degree of latitude on the mean sphere (~111 195 m). */
const M_PER_DEG = EARTH_RADIUS_M * RAD;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** A GPS accuracy disc (~5-30 m) must fit inside a place for presence to count (net/antiCheat physicalPresence). */
const MIN_PLACE_RADIUS_M = 35;

/** Every tunable of the world rules in one reviewable table (rationale: docs/WORLD.md). */
export const WORLD_TUNING = {
  /** Territory cell side in metres: one claim ~ one city block / a small park. */
  cellSize: 100,
  /** Garrison strength halves every 5 days without a reinforce. */
  defenseHalfLifeMs: 5 * DAY_MS,
  /** Below this decayed defense the owner's claim lapses and the cell is free again. */
  lapseDefense: 1,
  /** A home cell held by its own resident never decays below min(garrison, homeDefense). */
  homeDefense: 100,
  /** Homes are snapped to the centre of their cell on this global grid (privacy). */
  homeGridM: 250,
  /** Home disc radius: >= the grid's half-diagonal (176.8 m), so the real home is always inside. */
  homeRadiusM: 180,
  /** Release/catch influence halves every 2 days: the ecology remembers, then forgets. */
  influenceHalfLifeMs: 2 * DAY_MS,
  releaseInfluence: 1,
  catchInfluence: 0.25,
  /** |influence| bound per element per cell. */
  influenceCap: 8,
  /** Spawn multiplier = clamp(exp(influenceGain * influence), influenceMultMin, influenceMultMax). */
  influenceGain: 0.35,
  influenceMultMin: 0.25,
  influenceMultMax: 4,
  /** Spawn multiplier from ground affinity: 1 + groundSpawnGain * GROUNDS[g].affinity[e]. */
  groundSpawnGain: 2.5,
  /** Equirectangular frames are refused near the poles (cos(lat) -> 0). */
  maxOriginLat: 85,
} as const;

// ---------------------------------------------------------------- actions

export interface WorldActionDef {
  /** true = needs GPS-verified presence wherever it is offered; false = doable from the virtual space. */
  physical: boolean;
  /** Suggested throttle; shape-compatible with src/net/antiCheat.ts ThrottleRule. */
  cooldownMs: number;
  maxPerDay?: number;
  note: string;
}

const act = (physical: boolean, cooldownMs: number, maxPerDay: number | null, note: string): WorldActionDef =>
  maxPerDay === null ? { physical, cooldownMs, note } : { physical, cooldownMs, maxPerDay, note };

/**
 * Every world action. An action is physical EVERYWHERE or virtual EVERYWHERE (tested), so the
 * presence rule never depends on where it is performed and the throttle table maps 1:1.
 */
export const WORLD_ACTIONS = {
  // ---- physical (GPS-verified presence)
  visit: act(true, 60_000, 200, "Check in on site; the first check-in discovers the place (world.visit)."),
  catch: act(true, 3_000, 300, "Catch a wild spawn on site; rare+ spawns can ONLY be caught this way."),
  release: act(true, 10_000, 50, "Release a Genemon into the wild: seeds its element locally (world.release)."),
  rescue: act(true, 30_000, 50, "Rescue a Genemon someone released here (EXPERIENCES.rescue)."),
  forage: act(true, 300_000, 30, "Gather wild food (berries, greens, mushrooms, seaweed)."),
  swim: act(true, 600_000, 12, "Swim with the team in real water."),
  sunbathe: act(true, 900_000, 8, "Sunbathe outdoors (EXPERIENCES.sunbathing)."),
  climb: act(true, 600_000, 12, "Climb with the team (EXPERIENCES.climbing)."),
  "home.rest": act(true, 1_800_000, 12, "Rest at home: restores the team."),
  "gym.train": act(true, 30_000, 60, "Train at a real gym (EXPERIENCES.gymTraining)."),
  "gym.spar": act(true, 60_000, 30, "Friendly spar with trainers present at the gym."),
  "supermarket.buy": act(true, 10_000, 100, "Buy food in person (world.purchase)."),
  "supermarket.bonus": act(true, 3_600_000, 3, "In-person shopping bonus (fresh stock, coupons)."),
  "farmersMarket.buy": act(true, 10_000, 100, "Buy fresh produce in person (world.purchase)."),
  "harbour.buy": act(true, 10_000, 100, "Buy fish at the harbour in person (world.purchase)."),
  "cafe.buy": act(true, 60_000, 20, "Buy a coffee or a treat in person."),
  "friend.meet": act(true, 60_000, 30, "Meet a friend in person: a stronger bond than a remote request."),
  "museum.scan": act(true, 300_000, 10, "Scan an exhibit on site to unlock an ancient genome fragment."),
  "world.claim": act(true, 60_000, 20, "Claim a territory cell on site (claim())."),
  // ---- virtual (from the sofa)
  "home.manage": act(false, 1_000, null, "The owner manages the home remotely (defenders, storage)."),
  "home.feed": act(false, 10_000, 100, "Feed the team from the home pantry."),
  "museum.tour": act(false, 5_000, null, "Virtual tour: lore and element history."),
  "library.read": act(false, 5_000, null, "Read: puzzles and lore (EXPERIENCES.puzzle)."),
  "battle.casual": act(false, 2_000, 500, "Casual battle."),
  "battle.ranked": act(false, 2_000, 500, "Ranked ladder battle."),
  "battle.spectate": act(false, 1_000, null, "Watch a battle."),
  "tournament.join": act(false, 60_000, 10, "Join a tournament bracket."),
  "dungeon.enter": act(false, 60_000, 30, "Enter the dungeon instance."),
  "portal.enter": act(false, 60_000, 30, "Step through the portal."),
  "catch.virtual": act(false, 5_000, 100, "Catch inside a virtual instance: common/uncommon only (catchAllowed)."),
  "virtual.travel": act(false, 10_000, 200, "Move the avatar to a virtual-travel place (travelVirtual())."),
  "territory.reinforce": act(false, 60_000, 50, "Reinforce an owned cell from anywhere (defend())."),
} satisfies Record<string, WorldActionDef>;
export type WorldAction = keyof typeof WORLD_ACTIONS;

// ---------------------------------------------------------------- place catalogue

/**
 * The 21 kinds of the world spec, then the POI kinds proposed by content (CONTENT_VOCAB.poi in
 * src/data/achievements.ts) that had no equivalent, so every quest's `poi` filter names a kind the
 * world can actually place (e.g. "Go down to the harbour").
 */
export const PLACE_KINDS = [
  "home",
  "supermarket",
  "gym",
  "park",
  "lake",
  "forest",
  "cafe",
  "school",
  "office",
  "station",
  "museum",
  "beach",
  "mountain",
  "hospital",
  "library",
  "stadium",
  "farmersMarket",
  "river",
  "arena",
  "dungeon",
  "portal",
  "pool",
  "garden",
  "harbour",
  "landmark",
  "plaza",
] as const;
export type PlaceKind = typeof PLACE_KINDS[number];

export interface PlaceKindDef {
  kind: PlaceKind;
  name: string;
  ground: GroundId;
  /** Need GPS-verified presence inside the place. */
  physicalActions: WorldAction[];
  /** Allowed without presence (the avatar acts from the virtual space; at home: the owner, remotely). */
  virtualActions: WorldAction[];
  /** Added to the spawn table near the place (1 + bias, fading to 0 at twice the radius). */
  elementBias: Partial<Record<ElementId, number>>;
  /** Default radius in metres (>= 35 so a GPS accuracy disc fits inside). */
  radius: number;
  /** Reachable by the avatar through the virtual space (travelVirtual). */
  virtualTravel: boolean;
  /** Sensitive place (school, hospital): visit only, no claims, spawners must skip it, no lure. */
  sensitive: boolean;
}

function kindDef(
  kind: PlaceKind,
  name: string,
  ground: GroundId,
  radius: number,
  physicalActions: WorldAction[],
  virtualActions: WorldAction[],
  elementBias: Partial<Record<ElementId, number>>,
  flags: { virtualTravel?: boolean; sensitive?: boolean } = {},
): PlaceKindDef {
  return {
    kind,
    name,
    ground,
    physicalActions,
    virtualActions,
    elementBias,
    radius,
    virtualTravel: flags.virtualTravel ?? false,
    sensitive: flags.sensitive ?? false,
  };
}

const nature = (...extra: WorldAction[]): WorldAction[] => ["visit", "catch", "release", "rescue", ...extra];
const VIRTUAL = { virtualTravel: true };
const SENSITIVE = { sensitive: true };

export const PLACE_KIND_DEFS: Record<PlaceKind, PlaceKindDef> = {
  home: kindDef("home", "Home", "grass", WORLD_TUNING.homeRadiusM, nature("home.rest"), ["home.manage", "home.feed"], { neutral: 1, plant: 0.3, psychic: 0.2 }),
  supermarket: kindDef("supermarket", "Supermarket", "stone", 50, ["visit", "catch", "supermarket.buy", "supermarket.bonus"], [], { neutral: 0.8, metal: 0.5, electric: 0.4, plant: 0.3, ice: 0.3 }),
  gym: kindDef("gym", "Gym", "metal", 40, ["visit", "catch", "gym.train", "gym.spar"], [], { metal: 1, earth: 0.6, fire: 0.5, neutral: 0.3 }),
  park: kindDef("park", "Park", "grass", 120, nature("forage", "sunbathe", "friend.meet"), [], { plant: 1, air: 0.6, neutral: 0.4, light: 0.3 }),
  lake: kindDef("lake", "Lake", "water", 200, nature("swim"), [], { water: 1.5, ice: 0.5, electric: 0.3, plant: 0.3 }),
  forest: kindDef("forest", "Forest", "moss", 300, nature("forage"), [], { plant: 1.5, earth: 0.5, poison: 0.5, shadow: 0.4 }),
  cafe: kindDef("cafe", "Café", "stone", 35, ["visit", "catch", "cafe.buy", "friend.meet"], [], { fire: 0.6, psychic: 0.5, neutral: 0.5 }),
  school: kindDef("school", "School", "gravel", 80, ["visit"], [], {}, SENSITIVE),
  office: kindDef("office", "Office", "stone", 50, ["visit", "catch", "friend.meet"], [], { electric: 0.8, metal: 0.6, psychic: 0.4 }),
  station: kindDef("station", "Station", "metal", 60, ["visit", "catch", "friend.meet"], [], { electric: 1, metal: 0.8, air: 0.4 }),
  museum: kindDef("museum", "Museum", "stone", 60, ["visit", "catch", "museum.scan"], ["museum.tour"], { earth: 0.8, psychic: 0.8, light: 0.4, void: 0.3 }, VIRTUAL),
  beach: kindDef("beach", "Beach", "sand", 150, nature("swim", "sunbathe", "forage"), [], { water: 1, earth: 0.6, air: 0.6, light: 0.5 }),
  mountain: kindDef("mountain", "Mountain", "stone", 300, nature("climb"), [], { earth: 1.2, air: 0.9, ice: 0.6, metal: 0.3 }),
  hospital: kindDef("hospital", "Hospital", "stone", 90, ["visit"], [], {}, SENSITIVE),
  library: kindDef("library", "Library", "stone", 40, ["visit", "catch"], ["library.read"], { psychic: 1.2, light: 0.4, void: 0.3 }, VIRTUAL),
  stadium: kindDef("stadium", "Stadium", "grass", 120, ["visit", "catch", "friend.meet"], ["battle.ranked", "battle.spectate", "tournament.join"], { fire: 0.6, electric: 0.6, air: 0.4, light: 0.3 }, VIRTUAL),
  farmersMarket: kindDef("farmersMarket", "Farmers' market", "soil", 60, ["visit", "catch", "farmersMarket.buy"], [], { plant: 1, earth: 0.5, neutral: 0.4 }),
  river: kindDef("river", "River", "water", 80, nature("swim"), [], { water: 1.2, plant: 0.4, earth: 0.3, electric: 0.2 }),
  arena: kindDef("arena", "Arena", "soil", 70, ["visit", "catch"], ["battle.casual", "battle.ranked", "battle.spectate"], { fire: 0.5, earth: 0.5, metal: 0.4, neutral: 0.4 }, VIRTUAL),
  dungeon: kindDef("dungeon", "Dungeon", "stone", 50, ["visit", "catch"], ["dungeon.enter", "catch.virtual"], { shadow: 1.2, void: 0.8, earth: 0.6, poison: 0.5 }, VIRTUAL),
  portal: kindDef("portal", "Portal", "crystal", 35, ["visit", "catch"], ["portal.enter", "catch.virtual"], { void: 1.2, psychic: 0.9, light: 0.5 }, VIRTUAL),
  pool: kindDef("pool", "Pool", "water", 40, ["visit", "catch", "swim"], [], { water: 1, ice: 0.3, neutral: 0.3 }),
  garden: kindDef("garden", "Garden", "grass", 60, nature("forage", "sunbathe"), [], { plant: 1.2, earth: 0.3, light: 0.3, poison: 0.2 }),
  harbour: kindDef("harbour", "Harbour", "stone", 120, nature("harbour.buy"), [], { water: 1.2, metal: 0.5, air: 0.4, electric: 0.2 }),
  landmark: kindDef("landmark", "Landmark", "stone", 60, ["visit", "catch", "friend.meet"], [], { light: 0.6, psychic: 0.5, earth: 0.4 }),
  plaza: kindDef("plaza", "Plaza", "stone", 70, ["visit", "catch", "friend.meet"], [], { air: 0.5, neutral: 0.6, electric: 0.3, light: 0.3 }),
};

/** The only kinds the avatar may reach without moving: arena, dungeon, portal, stadium, museum, library. */
export const VIRTUAL_TRAVEL_KINDS: readonly PlaceKind[] = PLACE_KINDS.filter((k) => PLACE_KIND_DEFS[k].virtualTravel);

// ---------------------------------------------------------------- spawn data

export const RARITIES = ["common", "uncommon", "rare", "epic", "legendary"] as const;
export type Rarity = typeof RARITIES[number];
/** Rarities that can only be caught on site: "rare spawns need real movement". */
export const PHYSICAL_ONLY_RARITIES: readonly Rarity[] = ["rare", "epic", "legendary"];

/** Base rarity weights (sum 100); rare/epic/legendary scale by boost^1, ^1.5, ^2. */
const RARITY_WEIGHTS: readonly number[] = [62, 26, 9, 2.6, 0.4];
const RARITY_EXP: readonly number[] = [0, 0, 1, 1.5, 2];
const LEVEL_BASE: Record<Rarity, number> = { common: 5, uncommon: 10, rare: 18, epic: 28, legendary: 42 };

/** How common each element is with no context at all. */
const SPAWN_BASE: Record<ElementId, number> = {
  neutral: 1.2,
  fire: 1,
  water: 1,
  plant: 1,
  earth: 1,
  air: 1,
  electric: 0.9,
  ice: 0.7,
  metal: 0.8,
  poison: 0.8,
  light: 0.6,
  shadow: 0.6,
  psychic: 0.6,
  void: 0.25,
};

/** Time-of-day multiplier: 1 + day * d + night * n (day/night in [0, 1] from a 13 h-peaked cosine). */
const SPAWN_TIME: Record<ElementId, { day: number; night: number }> = {
  neutral: { day: 0, night: 0 },
  fire: { day: 0.5, night: -0.3 },
  water: { day: 0, night: 0 },
  plant: { day: 0.5, night: -0.3 },
  earth: { day: 0, night: 0 },
  air: { day: 0.2, night: -0.1 },
  electric: { day: 0, night: 0.1 },
  ice: { day: -0.1, night: 0.2 },
  metal: { day: 0, night: 0 },
  poison: { day: -0.1, night: 0.3 },
  light: { day: 0.8, night: -0.6 },
  shadow: { day: -0.5, night: 1.2 },
  psychic: { day: 0, night: 0.8 },
  void: { day: -0.5, night: 1 },
};

/**
 * Weather spawn multipliers. Deliberately separate from WEATHERS.elementMult (a damage table tuned
 * for battle parity): a spawn multiplier shifts the MIX of what appears, not anyone's power.
 */
const SPAWN_WEATHER: Record<WeatherId, Partial<Record<ElementId, number>>> = {
  clear: { fire: 1.2, plant: 1.15, light: 1.2 },
  heatwave: { fire: 1.8, earth: 1.2, ice: 0.4, water: 0.8 },
  rain: { water: 1.8, electric: 1.4, plant: 1.2, fire: 0.5 },
  storm: { electric: 2, water: 1.5, air: 1.3, fire: 0.4 },
  snow: { ice: 2, water: 1.1, fire: 0.6, plant: 0.7 },
  fog: { shadow: 1.6, psychic: 1.3, void: 1.3, light: 0.7 },
  wind: { air: 2, plant: 1.1 },
  sandstorm: { earth: 1.8, metal: 1.3, air: 1.2, water: 0.6, plant: 0.7 },
  aurora: { light: 1.8, psychic: 1.7, electric: 1.3, ice: 1.2 },
  eclipse: { shadow: 2, void: 1.8, light: 0.4 },
  acidRain: { poison: 2, water: 1.1, metal: 0.7, plant: 0.6 },
  ashfall: { fire: 1.5, earth: 1.4, shadow: 1.2, air: 0.8 },
};

/** Rarity boost per weather (rare events bring rare creatures). */
const RARE_WEATHER: Record<WeatherId, number> = {
  clear: 1,
  heatwave: 1.05,
  rain: 1.05,
  storm: 1.4,
  snow: 1.1,
  fog: 1.15,
  wind: 1.05,
  sandstorm: 1.1,
  aurora: 1.8,
  eclipse: 1.8,
  acidRain: 1.1,
  ashfall: 1.2,
};

/** Rarity boost inside a place (strongest place wins, no stacking). */
const RARE_PLACE: Partial<Record<PlaceKind, number>> = { dungeon: 1.6, portal: 1.6, mountain: 1.3, forest: 1.15, lake: 1.1, museum: 1.1 };

// ---------------------------------------------------------------- neighbourhood recipe

interface Recipe {
  kind: PlaceKind;
  count: number;
  /** Distance band (m) from the home anchor; `near` places ignore it unless their anchor is missing. */
  min: number;
  max: number;
  /** Terrain preference: compare 8 free candidates and keep the lowest / highest. */
  prefer?: "low" | "high";
  /** Place right next to this kind (a lakeside beach, a marina). */
  near?: PlaceKind;
}

const NEIGHBOURHOOD: readonly Recipe[] = [
  { kind: "cafe", count: 2, min: 250, max: 800 },
  { kind: "supermarket", count: 2, min: 300, max: 1500 },
  { kind: "park", count: 2, min: 250, max: 1000 },
  { kind: "gym", count: 1, min: 400, max: 1800 },
  { kind: "school", count: 1, min: 300, max: 1200 },
  { kind: "station", count: 1, min: 400, max: 1600 },
  { kind: "library", count: 1, min: 500, max: 1800 },
  { kind: "office", count: 1, min: 600, max: 2500 },
  { kind: "farmersMarket", count: 1, min: 500, max: 2000 },
  { kind: "hospital", count: 1, min: 900, max: 2500 },
  { kind: "museum", count: 1, min: 900, max: 2500 },
  { kind: "stadium", count: 1, min: 1200, max: 2500 },
  { kind: "lake", count: 1, min: 600, max: 2000, prefer: "low" },
  { kind: "beach", count: 1, min: 800, max: 2400, near: "lake" },
  { kind: "harbour", count: 1, min: 800, max: 2400, near: "lake" },
  { kind: "river", count: 1, min: 300, max: 2000, prefer: "low" },
  { kind: "forest", count: 1, min: 700, max: 2500 },
  { kind: "mountain", count: 1, min: 1500, max: 2400, prefer: "high" },
  { kind: "arena", count: 1, min: 500, max: 2000 },
  { kind: "dungeon", count: 1, min: 800, max: 2500 },
  { kind: "portal", count: 1, min: 600, max: 2500 },
  { kind: "pool", count: 1, min: 400, max: 1800 },
  { kind: "garden", count: 1, min: 250, max: 1200 },
  { kind: "landmark", count: 1, min: 600, max: 2500 },
  { kind: "plaza", count: 1, min: 300, max: 1500 },
];

const NAME_PREFIXES: readonly string[] = [
  "Oak",
  "Elm",
  "Maple",
  "Willow",
  "Cedar",
  "Birch",
  "River",
  "Hill",
  "Mill",
  "Bridge",
  "Lark",
  "Stone",
  "Sun",
  "Moon",
  "North",
  "South",
  "East",
  "West",
  "Old Town",
  "Market",
];

// ---------------------------------------------------------------- public types

export interface Place {
  id: string;
  kind: PlaceKind;
  name: string;
  /** Local ENU metres (y = terrain altitude at the place centre). */
  pos: V3;
  lat: number;
  lon: number;
  radius: number;
  ground: GroundId;
  /** Set only for private places (a home). Public places are never owned: control comes from the cells. */
  ownerId: string | null;
  /** Players who discovered it: on site, or virtually for virtual-travel kinds. */
  discoveredBy: string[];
  /** Players who checked in ON SITE at least once (drives world.visit firstVisit). */
  visitedBy: string[];
}

/** addPlace input; homes are refused (generateNeighbourhood coarsens them). */
export interface NewPlace {
  kind: PlaceKind;
  pos: V3;
  name?: string;
  radius?: number;
  ground?: GroundId;
  id?: string;
}

export interface Territory {
  cellId: string;
  /** Stored owner; a lapsed claim stays here until the next write (read with territory(id, now)). */
  ownerId: string | null;
  /** Garrison strength as of defendedAt (power units of Phenotype.power). */
  defense: number;
  claimedAt: number;
  /** Last claim / reinforce: the decay clock. */
  defendedAt: number;
  /** Ecology influence per element as of influenceAt (+ releases, - catches, decaying to 0). */
  influence: Partial<Record<ElementId, number>>;
  influenceAt: number;
}

export interface Verdict {
  ok: boolean;
  reason: string;
}

export interface DiscoverResult extends Verdict {
  /** First ON-SITE check-in of this player at this place. */
  firstVisit: boolean;
}

/** Optional context for world.visit rows; hour defaults to local mean solar time at the place. */
export interface VisitContext {
  hour?: number;
  weather?: WeatherId;
}

export interface SpawnEntry {
  element: ElementId;
  weight: number;
}

export interface Spawn {
  element: ElementId;
  rarity: Rarity;
  level: number;
}

export interface WorldMapOptions {
  seed: number;
  origin: { lat: number; lon: number };
  ledger?: Ledger;
  /** Territory cell side in metres (default 100). */
  cellSize?: number;
}

export interface WorldMapJSON {
  v: 1;
  seed: number;
  origin: { lat: number; lon: number };
  cellSize: number;
  places: Place[];
  territories: Territory[];
  avatars: { playerId: string; placeId: string; since: number }[];
}

/** Rare and better spawns need presence; virtual instances only yield common/uncommon. */
export function catchAllowed(rarity: Rarity, physicallyPresent: boolean): Verdict {
  if (!RARITIES.includes(rarity)) return { ok: false, reason: `unknown rarity ${String(rarity)}` };
  if (!physicallyPresent && PHYSICAL_ONLY_RARITIES.includes(rarity)) {
    return { ok: false, reason: `a ${rarity} spawn can only be caught on site` };
  }
  return { ok: true, reason: physicallyPresent ? "on site" : "virtual catch" };
}

// ---------------------------------------------------------------- helpers

interface GridCell {
  id: string;
  lat: number;
  lon: number;
}

const CELL_ID_RE = /^(\d+(?:\.\d+)?):(\d+):(\d+)$/;

/** Longitude difference wrapped into (-180, 180]. */
function wrap180(deg: number): number {
  const w = ((((deg + 180) % 360) + 360) % 360) - 180;
  return w === -180 ? 180 : w;
}

function normHour(h: number): number {
  return ((h % 24) + 24) % 24;
}

/** +1 at 13 h, -1 at 1 h (same convention as src/genome/epigenetics.ts). */
function dayness(hour: number): number {
  return Math.cos((2 * Math.PI * (normHour(hour) - 13)) / 24);
}

/** Local mean solar time: the fallback when the caller has no civil local hour. */
function solarHour(now: number, lon: number): number {
  return normHour(now / HOUR_MS + lon / 15);
}

function finite(n: number, what: string): number {
  if (typeof n !== "number" || !Number.isFinite(n)) throw new RangeError(`${what} must be a finite number`);
  return n;
}

function requireId(s: string, what: string): string {
  if (typeof s !== "string" || s.length === 0 || s.length > 128) throw new RangeError(`${what} must be a non-empty id`);
  return s;
}

const validPower = (p: number) => typeof p === "number" && Number.isFinite(p) && p > 0;
const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Global lat/lon grid with cells at most `size` metres on a side: rows divide 180 deg, columns per
 * row divide 360 deg using the row-centre latitude (same construction and id format as
 * src/net/antiCheat.ts geoCellId, so `${size}:${row}:${col}` ids agree across modules).
 */
function gridCell(lat: number, lon: number, size: number): GridCell {
  if (!(Math.abs(lat) <= 90) || !Number.isFinite(lon)) throw new RangeError("grid cell: position off the globe");
  const nRows = Math.max(1, Math.ceil((180 * M_PER_DEG) / size));
  const dLat = 180 / nRows;
  const row = Math.min(nRows - 1, Math.floor((lat + 90) / dLat));
  const cLat = -90 + (row + 0.5) * dLat;
  const nCols = Math.max(1, Math.ceil((360 * M_PER_DEG * Math.cos(cLat * RAD)) / size));
  const dLon = 360 / nCols;
  const L = lon >= 180 ? lon - 360 : lon;
  const col = Math.min(nCols - 1, Math.floor((L + 180) / dLon));
  return { id: `${size}:${row}:${col}`, lat: cLat, lon: -180 + (col + 0.5) * dLon };
}

function gridCellById(id: string): GridCell {
  const m = typeof id === "string" ? CELL_ID_RE.exec(id) : null;
  if (!m) throw new RangeError(`invalid cell id ${String(id)}`);
  const size = Number(m[1]), row = Number(m[2]), col = Number(m[3]);
  if (!(size > 0)) throw new RangeError(`invalid cell id ${id}`);
  const nRows = Math.max(1, Math.ceil((180 * M_PER_DEG) / size));
  if (row >= nRows) throw new RangeError(`invalid cell id ${id}`);
  const cLat = -90 + (row + 0.5) * (180 / nRows);
  const nCols = Math.max(1, Math.ceil((360 * M_PER_DEG * Math.cos(cLat * RAD)) / size));
  if (col >= nCols) throw new RangeError(`invalid cell id ${id}`);
  return { id, lat: cLat, lon: -180 + (col + 0.5) * (360 / nCols) };
}

/** Origin-independent planar metres (sinusoidal): terrain and moisture noise are sampled here. */
function globalXZ(lat: number, lon: number): [number, number] {
  return [lon * M_PER_DEG * Math.cos(lat * RAD), lat * M_PER_DEG];
}

function copyPlace(p: Place): Place {
  return { ...p, pos: { ...p.pos }, discoveredBy: [...p.discoveredBy], visitedBy: [...p.visitedBy] };
}

function blankTerritory(cellId: string): Territory {
  return { cellId, ownerId: null, defense: 0, claimedAt: 0, defendedAt: 0, influence: {}, influenceAt: 0 };
}

function copyTerritory(t: Territory): Territory {
  return { ...t, influence: { ...t.influence } };
}

// ---------------------------------------------------------------- the map

export class WorldMap {
  readonly seed: number;
  readonly origin: Readonly<{ lat: number; lon: number }>;
  readonly cellSize: number;
  #ledger?: Ledger;
  /** Metres per degree of longitude at the origin latitude. */
  #kLon: number;
  #terrainSeed: number;
  #detailSeed: number;
  #moistSeed: number;
  #places = new Map<string, Place>();
  #cells = new Map<string, Territory>();
  /** cellId -> residents whose home anchor lies in that cell (home defense floor). */
  #homeCells = new Map<string, Set<string>>();
  #avatars = new Map<string, { placeId: string; since: number }>();

  constructor(opts: WorldMapOptions) {
    finite(opts.seed, "seed");
    const lat = opts.origin?.lat, lon = opts.origin?.lon;
    if (typeof lat !== "number" || !(Math.abs(lat) <= WORLD_TUNING.maxOriginLat)) {
      throw new RangeError(`origin.lat must be within +-${WORLD_TUNING.maxOriginLat} deg`);
    }
    if (typeof lon !== "number" || !(Math.abs(lon) <= 180)) throw new RangeError("origin.lon must be within +-180 deg");
    const cellSize = opts.cellSize ?? WORLD_TUNING.cellSize;
    if (!(cellSize >= 10 && cellSize <= 5000)) throw new RangeError("cellSize must be within 10..5000 m");
    this.seed = opts.seed;
    this.origin = Object.freeze({ lat, lon });
    this.cellSize = cellSize;
    this.#ledger = opts.ledger;
    this.#kLon = M_PER_DEG * Math.cos(lat * RAD);
    this.#terrainSeed = hashSeed(opts.seed, "terrain");
    this.#detailSeed = hashSeed(opts.seed, "terrain-detail");
    this.#moistSeed = hashSeed(opts.seed, "moisture");
  }

  // ------------------------------------------------------------ coordinates & terrain

  /** Geodetic -> local ENU metres (equirectangular around the origin; exact inverse of toGeo). */
  toLocal(lat: number, lon: number, alt = 0): V3 {
    return { x: wrap180(lon - this.origin.lon) * this.#kLon, y: alt, z: (lat - this.origin.lat) * M_PER_DEG };
  }

  toGeo(p: V3): { lat: number; lon: number; alt: number } {
    return { lat: this.origin.lat + p.z / M_PER_DEG, lon: wrap180(this.origin.lon + p.x / this.#kLon), alt: p.y };
  }

  /** Deterministic terrain altitude (m) at a local position: a function of lat/lon and the world seed. */
  heightAt(x: number, z: number): number {
    const g = this.toGeo(v3(x, 0, z));
    return this.#terrain(g.lat, g.lon);
  }

  /** Ground under a point: the innermost place's ground, else natural ground from height + moisture. */
  groundAt(pos: V3): GroundId {
    const inside = this.#inside(pos);
    if (inside.length > 0) return inside[0].ground;
    const g = this.toGeo(pos);
    const h = this.#terrain(g.lat, g.lon);
    const [gx, gz] = globalXZ(g.lat, g.lon);
    const m = fbm2(this.#moistSeed, gx / 900, gz / 900, 3);
    if (h > 55) return "stone";
    if (h > 40) return "gravel";
    if (m > 0.62) return h < -20 ? "mud" : "moss";
    if (m < 0.38) return "soil";
    return "grass";
  }

  #terrain(lat: number, lon: number): number {
    const [gx, gz] = globalXZ(lat, lon);
    const hills = fbm2(this.#terrainSeed, gx / 2400, gz / 2400, 4) - 0.5;
    const detail = fbm2(this.#detailSeed, gx / 400, gz / 400, 3) - 0.5;
    return hills * 160 + detail * 24;
  }

  // ------------------------------------------------------------ places

  /**
   * The owner's generated neighbourhood: a home + one place of every other kind (two cafés,
   * supermarkets and parks) 250-2500 m away, deterministic from seed + owner + the COARSE home cell.
   * The exact `home` is used once to find its homeGridM cell and is never stored, so every home in
   * the same cell yields byte-identical output. Lakes/rivers seek low ground, the mountain the high
   * ground; beach and harbour sit on the lake shore. Idempotent: a second call returns the same
   * places without adding or logging anything. No territory is claimed (claims need presence).
   */
  generateNeighbourhood(ownerId: string, home: V3, now = 0): Place[] {
    requireId(ownerId, "ownerId");
    finite(now, "now");
    const hg = this.toGeo(home);
    const anchor = gridCell(hg.lat, hg.lon, WORLD_TUNING.homeGridM);
    const key = hashSeed(this.seed, "neighbourhood", ownerId, anchor.id);
    const ids = [`home-${key.toString(36)}`];
    for (const rec of NEIGHBOURHOOD) {
      for (let i = 0; i < rec.count; i++) ids.push(`${rec.kind}-${hashSeed(key, rec.kind, i).toString(36)}`);
    }
    if (this.#places.has(ids[0])) {
      return ids.flatMap((id) => {
        const p = this.#places.get(id);
        return p ? [copyPlace(p)] : [];
      });
    }

    const rng = new Rng(key);
    const kLon = M_PER_DEG * Math.cos(anchor.lat * RAD);
    // Offsets are metres in the anchor's own tangent plane, so the result does not depend on the origin.
    const geoOf = (dx: number, dz: number) => ({ lat: anchor.lat + dz / M_PER_DEG, lon: wrap180(anchor.lon + dx / kLon) });
    const spots: { kind: PlaceKind; dx: number; dz: number; r: number }[] = [
      { kind: "home", dx: 0, dz: 0, r: WORLD_TUNING.homeRadiusM },
    ];
    const free = (dx: number, dz: number, r: number) => spots.every((s) => Math.hypot(s.dx - dx, s.dz - dz) >= s.r + r + 15);

    for (const rec of NEIGHBOURHOOD) {
      const r = PLACE_KIND_DEFS[rec.kind].radius;
      const near = rec.near ? spots.find((s) => s.kind === rec.near) : undefined;
      const lo = Math.max(rec.min, WORLD_TUNING.homeRadiusM + r + 20);
      const hi = Math.max(rec.max, lo + 50);
      for (let i = 0; i < rec.count; i++) {
        const want = rec.prefer ? 8 : 1;
        let best: { dx: number; dz: number; h: number } | null = null;
        let last = { dx: 0, dz: 0 };
        for (let attempt = 0, found = 0; attempt < 40 && found < want; attempt++) {
          const a = rng.range(0, Math.PI * 2);
          const d = near ? near.r + r + 20 + rng.range(0, 20) : Math.sqrt(rng.range(lo * lo, hi * hi));
          const dx = (near?.dx ?? 0) + Math.cos(a) * d;
          const dz = (near?.dz ?? 0) + Math.sin(a) * d;
          last = { dx, dz };
          if (!free(dx, dz, r)) continue;
          found++;
          const q = geoOf(dx, dz);
          const h = this.#terrain(q.lat, q.lon);
          if (!best || (rec.prefer === "low" && h < best.h) || (rec.prefer === "high" && h > best.h)) best = { dx, dz, h };
        }
        const pick = best ?? last;
        spots.push({ kind: rec.kind, dx: pick.dx, dz: pick.dz, r });
      }
    }

    const out: Place[] = [];
    spots.forEach((s, i) => {
      const q = geoOf(s.dx, s.dz);
      const def = PLACE_KIND_DEFS[s.kind];
      const isHome = s.kind === "home";
      const place: Place = {
        id: ids[i],
        kind: s.kind,
        name: isHome ? "Home" : `${rng.pick(NAME_PREFIXES)} ${def.name}`,
        pos: this.toLocal(q.lat, q.lon, this.#terrain(q.lat, q.lon)),
        lat: q.lat,
        lon: q.lon,
        radius: s.r,
        ground: def.ground,
        ownerId: isHome ? ownerId : null,
        discoveredBy: isHome ? [ownerId] : [],
        visitedBy: [],
      };
      this.#insert(place);
      out.push(copyPlace(place));
    });
    this.#emit({
      what: "map.neighbourhood",
      space: "world",
      pos: out[0].pos,
      who: ownerId,
      why: "generated from seed + owner + coarse home cell",
      from: "seed",
      to: ownerId,
      when: now,
      entries: { places: out.length, anchor: anchor.id },
      exits: { home: ids[0] },
      tags: ["map"],
    });
    return out;
  }

  /** Add a public place (OSM import, events, editor). Homes are refused: use generateNeighbourhood. */
  addPlace(p: NewPlace, now = 0): Place {
    finite(now, "now");
    const def = PLACE_KIND_DEFS[p.kind];
    if (!def) throw new RangeError(`unknown place kind ${String(p.kind)}`);
    if (p.kind === "home") throw new RangeError("homes are created by generateNeighbourhood (it coarsens the location)");
    finite(p.pos?.x, "pos.x");
    finite(p.pos?.y, "pos.y");
    finite(p.pos?.z, "pos.z");
    const radius = p.radius ?? def.radius;
    if (!(radius >= MIN_PLACE_RADIUS_M && radius <= 5000)) {
      throw new RangeError(`radius must be within ${MIN_PLACE_RADIUS_M}..5000 m (a GPS accuracy disc must fit inside)`);
    }
    const ground = p.ground ?? def.ground;
    if (!GROUND_IDS.includes(ground)) throw new RangeError(`unknown ground ${String(ground)}`);
    const g = this.toGeo(p.pos);
    const id = p.id ?? `${p.kind}-${hashSeed(this.seed, p.kind, Math.round(p.pos.x), Math.round(p.pos.z)).toString(36)}`;
    requireId(id, "place id");
    const place: Place = {
      id,
      kind: p.kind,
      name: p.name ?? def.name,
      pos: { x: p.pos.x, y: p.pos.y, z: p.pos.z },
      lat: g.lat,
      lon: g.lon,
      radius,
      ground,
      ownerId: null,
      discoveredBy: [],
      visitedBy: [],
    };
    this.#insert(place);
    this.#emit({
      what: "map.place",
      space: "world",
      pos: place.pos,
      who: "world",
      why: "place added",
      from: "none",
      to: id,
      when: now,
      entries: { poi: place.kind, radius: r3(radius), ground },
      exits: { place: id },
      tags: ["map"],
    });
    return copyPlace(place);
  }

  /** Every place, insertion order (copies: mutate through the API so the ledger sees it). */
  places(): Place[] {
    return [...this.#places.values()].map(copyPlace);
  }

  place(id: string): Place | null {
    const p = this.#places.get(id);
    return p ? copyPlace(p) : null;
  }

  /** Places whose CENTRE lies within r metres (XZ) of pos, nearest first, optionally of one kind. */
  placesNear(pos: V3, r: number, kind?: PlaceKind): Place[] {
    finite(r, "r");
    const out = [...this.#places.values()].filter((p) => (kind === undefined || p.kind === kind) && distXZ(pos, p.pos) <= r);
    out.sort((a, b) => distXZ(pos, a.pos) - distXZ(pos, b.pos) || byId(a, b));
    return out.map(copyPlace);
  }

  /** Places whose disc contains pos, innermost first (smallest distance / radius). */
  placesAt(pos: V3): Place[] {
    return this.#inside(pos).map(copyPlace);
  }

  /** The sensitive place (school, hospital) containing pos, if any: spawners and lures must skip it. */
  sensitivePlaceAt(pos: V3): Place | null {
    const p = this.#inside(pos).find((q) => PLACE_KIND_DEFS[q.kind].sensitive);
    return p ? copyPlace(p) : null;
  }

  /**
   * Check in / discover. On site: always a world.visit row (quests count check-ins); firstVisit is
   * the player's first ON-SITE visit. Remote: only virtual-travel kinds can be discovered (one
   * virtual.discover row); everything else needs presence. Private places (a home) accept only
   * their owner.
   */
  discover(playerId: string, placeId: string, now: number, physicallyPresent: boolean, ctx: VisitContext = {}): DiscoverResult {
    requireId(playerId, "playerId");
    finite(now, "now");
    const p = this.#places.get(placeId);
    if (!p) return { ok: false, reason: `unknown place ${placeId}`, firstVisit: false };
    if (p.ownerId !== null && p.ownerId !== playerId) {
      return { ok: false, reason: "private place: only its owner can check in", firstVisit: false };
    }
    if (physicallyPresent) {
      const firstVisit = !p.visitedBy.includes(playerId);
      if (firstVisit) p.visitedBy.push(playerId);
      const discovered = !p.discoveredBy.includes(playerId);
      if (discovered) p.discoveredBy.push(playerId);
      const hour = ctx.hour === undefined ? solarHour(now, p.lon) : normHour(finite(ctx.hour, "ctx.hour"));
      this.#emit({
        what: "world.visit",
        space: "physical",
        pos: p.pos,
        who: playerId,
        why: firstVisit ? "first visit" : "check-in",
        from: playerId,
        to: p.id,
        when: now,
        entries: {
          poi: p.kind,
          place: p.id,
          firstVisit,
          discovered,
          hour: r3(hour),
          night: hour < 5 || hour >= 22,
          ...(ctx.weather === undefined ? {} : { weather: ctx.weather }),
        },
        exits: { visitors: p.visitedBy.length },
        tags: ["gps"],
      });
      return { ok: true, reason: firstVisit ? "first visit" : "check-in", firstVisit };
    }
    if (!PLACE_KIND_DEFS[p.kind].virtualTravel) {
      return { ok: false, reason: `physical presence required to discover a ${p.kind}`, firstVisit: false };
    }
    if (p.discoveredBy.includes(playerId)) return { ok: true, reason: "already discovered", firstVisit: false };
    p.discoveredBy.push(playerId);
    this.#emit({
      what: "virtual.discover",
      space: "virtual",
      pos: p.pos,
      who: playerId,
      why: "discovered from the virtual space",
      from: playerId,
      to: p.id,
      when: now,
      entries: { poi: p.kind, place: p.id },
      exits: { discoverers: p.discoveredBy.length },
      tags: ["virtual"],
    });
    return { ok: true, reason: "discovered virtually", firstVisit: false };
  }

  // ------------------------------------------------------------ territory

  /** Global cell id of a local position, e.g. "100:117906:2131" (`${cellSize}:${row}:${col}`). */
  cellOf(pos: V3): string {
    const g = this.toGeo(pos);
    return gridCell(g.lat, g.lon, this.cellSize).id;
  }

  /** Local centre of any grid cell id (y = terrain height there). */
  cellCenter(cellId: string): V3 {
    const c = gridCellById(cellId);
    const p = this.toLocal(c.lat, c.lon);
    p.y = this.#terrain(c.lat, c.lon);
    return p;
  }

  /**
   * A cell's record (a blank one if never touched). Without `now`: the stored snapshot. With `now`:
   * the live view (defense decayed, a lapsed owner shown as null, influence decayed).
   */
  territory(cellId: string, now?: number): Territory {
    gridCellById(cellId);
    const stored = this.#cells.get(cellId) ?? blankTerritory(cellId);
    if (now === undefined) return copyTerritory(stored);
    finite(now, "now");
    const d = this.#defense(stored, now);
    const lapsed = stored.ownerId !== null && d < WORLD_TUNING.lapseDefense;
    return {
      ...copyTerritory(stored),
      ownerId: lapsed ? null : stored.ownerId,
      defense: lapsed ? 0 : d,
      defendedAt: Math.max(stored.defendedAt, now),
      influence: this.#decayed(stored, now),
      influenceAt: Math.max(stored.influenceAt, now),
    };
  }

  /**
   * Claim the cell under `pos`. Needs presence. Free or lapsed cells are taken outright (garrison =
   * power); an owned cell is CONTESTED: power must be strictly greater than the decayed defense.
   * A contest always logs world.raid (attacker) + world.defend (defender); a takeover adds the
   * world.claim row. Your own cell is reinforced instead (no world.claim: claims must not be farmable).
   */
  claim(playerId: string, pos: V3, power: number, now: number, physicallyPresent: boolean): Verdict {
    requireId(playerId, "playerId");
    finite(now, "now");
    if (!physicallyPresent) return { ok: false, reason: "physical presence required: territory can only be claimed on site" };
    if (!validPower(power)) return { ok: false, reason: "power must be a positive finite number" };
    const inside = this.#inside(pos);
    const sensitive = inside.find((p) => PLACE_KIND_DEFS[p.kind].sensitive);
    if (sensitive) return { ok: false, reason: `sensitive place: ${sensitive.name} (${sensitive.kind}) cannot be claimed` };

    const cellId = this.cellOf(pos);
    const stored = this.#cells.get(cellId) ?? blankTerritory(cellId);
    const defense = this.#defense(stored, now);
    const owner = stored.ownerId !== null && defense >= WORLD_TUNING.lapseDefense ? stored.ownerId : null;
    if (owner === playerId) {
      const v = this.defend(playerId, cellId, power, now);
      return { ok: v.ok, reason: `already yours: ${v.reason}` };
    }
    const ground = this.groundAt(pos);
    const base: Record<string, Scalar> = {
      territory: cellId,
      ground,
      power: r3(power),
      ...(inside.length > 0 ? { poi: inside[0].kind } : {}),
    };
    const take = (why: string, from: string, contested: boolean) => {
      const t = this.#touch(cellId);
      t.ownerId = playerId;
      t.defense = power;
      t.claimedAt = now;
      t.defendedAt = now;
      this.#emit({
        what: "world.claim",
        space: "physical",
        pos,
        who: playerId,
        why,
        from,
        to: playerId,
        when: now,
        entries: { ...base, contested, defense: r3(contested ? defense : 0) },
        exits: { owner: playerId, defense: r3(power) },
        tags: ["territory", "gps"],
      });
    };

    if (owner === null) {
      const previous = stored.ownerId;
      take(previous === null ? "unclaimed cell" : "lapsed claim", previous ?? "none", false);
      return { ok: true, reason: previous === null ? "claimed an unclaimed cell" : `claimed a lapsed cell (was ${previous})` };
    }

    const won = power > defense;
    this.#emit({
      what: "world.raid",
      space: "physical",
      pos,
      who: playerId,
      why: won ? "power beat defense" : "defense held",
      from: playerId,
      to: owner,
      when: now,
      entries: { ...base, defense: r3(defense) },
      exits: { won },
      tags: ["territory", "gps"],
    });
    this.#emit({
      what: "world.defend",
      space: "physical",
      pos,
      who: owner,
      why: won ? "garrison overrun" : "garrison held",
      from: playerId,
      to: owner,
      when: now,
      entries: { territory: cellId, ground, attackers: 1, defense: r3(defense), power: r3(power) },
      exits: { won: !won },
      tags: ["territory"],
    });
    if (!won) return { ok: false, reason: `contested: power ${r3(power)} does not beat defense ${r3(defense)}` };
    take("contested takeover", owner, true);
    return { ok: true, reason: `contested: power ${r3(power)} beat defense ${r3(defense)}` };
  }

  /**
   * Reinforce an owned cell from anywhere: garrison = max(decayed defense, power) and the decay clock
   * restarts. max() rather than a sum: the cell is held by its best garrison, so stacking many weak
   * reinforcements cannot build an untakeable cell. Owner only (friends' co-defence: docs/WORLD.md).
   */
  defend(playerId: string, cellId: string, power: number, now: number): Verdict {
    requireId(playerId, "playerId");
    finite(now, "now");
    if (typeof cellId !== "string" || !CELL_ID_RE.test(cellId)) return { ok: false, reason: "invalid cell id" };
    if (!validPower(power)) return { ok: false, reason: "power must be a positive finite number" };
    const stored = this.#cells.get(cellId);
    const defense = stored ? this.#defense(stored, now) : 0;
    const owner = stored && stored.ownerId !== null && defense >= WORLD_TUNING.lapseDefense ? stored.ownerId : null;
    if (!stored || owner === null) return { ok: false, reason: "unclaimed territory: claim it on site first" };
    if (owner !== playerId) return { ok: false, reason: `not your territory (owned by ${owner})` };
    const next = Math.max(defense, power);
    stored.defense = next;
    stored.defendedAt = Math.max(stored.defendedAt, now);
    const stronger = power > defense;
    this.#emit({
      what: "territory.reinforce",
      space: "world",
      pos: this.cellCenter(cellId),
      who: playerId,
      why: stronger ? "stronger garrison" : "garrison refreshed",
      from: playerId,
      to: cellId,
      when: now,
      entries: { territory: cellId, power: r3(power), before: r3(defense) },
      exits: { defense: r3(next) },
      tags: ["territory"],
    });
    return { ok: true, reason: stronger ? "garrison strengthened" : "garrison refreshed (decay clock reset)" };
  }

  #defense(t: Territory, now: number): number {
    if (t.ownerId === null) return 0;
    const dt = Math.max(0, now - t.defendedAt);
    let d = t.defense * Math.pow(0.5, dt / WORLD_TUNING.defenseHalfLifeMs);
    if (this.#homeCells.get(t.cellId)?.has(t.ownerId)) d = Math.max(d, Math.min(t.defense, WORLD_TUNING.homeDefense));
    return d;
  }

  #touch(cellId: string): Territory {
    let t = this.#cells.get(cellId);
    if (!t) {
      t = blankTerritory(cellId);
      this.#cells.set(cellId, t);
    }
    return t;
  }

  // ------------------------------------------------------------ physical vs virtual

  /**
   * May this action happen at this place? Virtual actions: always (presence irrelevant). Physical
   * actions: only with presence. Private places (a home) also need the acting playerId to be the
   * owner; omitting it fails closed. The stored place wins over the object passed in.
   */
  actionAllowed(action: string, place: Place, physicallyPresent: boolean, playerId?: string): Verdict {
    const p = this.#places.get(place.id) ?? place;
    const def = PLACE_KIND_DEFS[p.kind];
    if (!def) return { ok: false, reason: `unknown place kind ${String(p.kind)}` };
    if (p.ownerId !== null && playerId !== p.ownerId) {
      return {
        ok: false,
        reason: playerId === undefined ? "private place: pass the acting playerId" : "private place: only its owner can act here",
      };
    }
    if ((def.virtualActions as string[]).includes(action)) {
      return { ok: true, reason: physicallyPresent ? "on site" : "virtual action" };
    }
    if ((def.physicalActions as string[]).includes(action)) {
      return physicallyPresent ? { ok: true, reason: "on site" } : { ok: false, reason: `physical presence required: ${action} at a ${p.kind}` };
    }
    return { ok: false, reason: `${action} is not available at a ${p.kind}` };
  }

  /** Move the avatar through the virtual space. Only VIRTUAL_TRAVEL_KINDS are reachable this way. */
  travelVirtual(playerId: string, placeId: string, now: number): Verdict {
    requireId(playerId, "playerId");
    finite(now, "now");
    const p = this.#places.get(placeId);
    if (!p) return { ok: false, reason: `unknown place ${placeId}` };
    if (!PLACE_KIND_DEFS[p.kind].virtualTravel) return { ok: false, reason: `a ${p.kind} can only be reached physically` };
    const prev = this.#avatars.get(playerId)?.placeId ?? null;
    if (prev === placeId) return { ok: true, reason: "already there" };
    this.#avatars.set(playerId, { placeId, since: now });
    this.#emit({
      what: "virtual.travel",
      space: "virtual",
      pos: p.pos,
      who: playerId,
      why: `travel to a ${p.kind}`,
      from: prev ?? "hub",
      to: placeId,
      when: now,
      entries: { poi: p.kind, place: placeId },
      exits: { arrived: true },
      tags: ["virtual"],
    });
    return { ok: true, reason: `avatar arrived at ${p.name}` };
  }

  /** Place id where the player's avatar currently stands in the virtual space (null = hub / none). */
  avatarAt(playerId: string): string | null {
    return this.#avatars.get(playerId)?.placeId ?? null;
  }

  // ------------------------------------------------------------ ecology & spawns

  /** A Genemon released here seeds its element locally (+releaseInfluence, decaying). Returns the cell's new value. */
  release(playerId: string, element: ElementId, pos: V3, now: number): number {
    return this.#ecology("world.release", playerId, element, pos, now, WORLD_TUNING.releaseInfluence);
  }

  /** A wild catch depletes its element locally (-catchInfluence, decaying). Returns the cell's new value. */
  catchAt(playerId: string, element: ElementId, pos: V3, now: number): number {
    return this.#ecology("world.catch", playerId, element, pos, now, -WORLD_TUNING.catchInfluence);
  }

  /** Influence felt at pos: own cell at full weight, neighbours fading to 0 at 1.5 cells (decayed to `now`). */
  influenceAt(pos: V3, element: ElementId, now: number): number {
    finite(now, "now");
    return this.#influenceField(pos, now)[element] ?? 0;
  }

  /**
   * Spawn weights for every element at a spot: base x place bias x ground affinity x time of day x
   * weather x ecology influence. Always all 14 elements, in ELEMENT_IDS order, every weight > 0.
   * `hour` is the local hour 0-24.
   */
  spawnTable(pos: V3, hour: number, weather: WeatherId, now: number): SpawnEntry[] {
    finite(hour, "hour");
    finite(now, "now");
    const dn = dayness(hour);
    const day = Math.max(0, dn), night = Math.max(0, -dn);
    const bias = this.#placeBias(pos);
    const affinity = GROUNDS[this.groundAt(pos)].affinity;
    const wx = SPAWN_WEATHER[weather] ?? {};
    const infl = this.#influenceField(pos, now);
    const T = WORLD_TUNING;
    return ELEMENT_IDS.map((element) => {
      const t = SPAWN_TIME[element];
      const time = Math.max(0.1, 1 + day * t.day + night * t.night);
      const eco = clamp(Math.exp(T.influenceGain * (infl[element] ?? 0)), T.influenceMultMin, T.influenceMultMax);
      const weight = SPAWN_BASE[element] * (1 + (bias[element] ?? 0)) * (1 + T.groundSpawnGain * (affinity[element] ?? 0)) *
        time * (wx[element] ?? 1) * eco;
      return { element, weight };
    });
  }

  /**
   * One wild spawn. Draw order is fixed (element, rarity, level) so a seeded Rng replays it exactly.
   * Rarity is boosted by night, rare weather and wild places; level by rarity and altitude.
   * Callers must skip sensitivePlaceAt(pos) and gate the catch with catchAllowed().
   */
  rollSpawn(pos: V3, hour: number, weather: WeatherId, now: number, rng: Rng): Spawn {
    const table = this.spawnTable(pos, hour, weather, now);
    const element = rng.weighted(table.map((e) => e.element), table.map((e) => e.weight));
    const boost = this.#rarityBoost(pos, hour, weather);
    const rarity = rng.weighted(RARITIES, RARITY_WEIGHTS.map((w, i) => w * Math.pow(boost, RARITY_EXP[i])));
    const h = this.heightAt(pos.x, pos.z);
    const level = clamp(Math.round(LEVEL_BASE[rarity] + Math.max(0, h) / 15 + rng.normal(0, 2.5)), 1, 100);
    return { element, rarity, level };
  }

  #ecology(what: string, playerId: string, element: ElementId, pos: V3, now: number, delta: number): number {
    requireId(playerId, "playerId");
    finite(now, "now");
    if (!ELEMENT_IDS.includes(element)) throw new RangeError(`unknown element ${String(element)}`);
    const cellId = this.cellOf(pos);
    const t = this.#touch(cellId);
    const cur = this.#decayed(t, now);
    const before = cur[element] ?? 0;
    const after = clamp(before + delta, -WORLD_TUNING.influenceCap, WORLD_TUNING.influenceCap);
    cur[element] = after;
    t.influence = cur;
    t.influenceAt = Math.max(t.influenceAt, now);
    this.#emit({
      what,
      space: "physical",
      pos,
      who: playerId,
      why: delta > 0 ? "released into the wild" : "caught in the wild",
      from: delta > 0 ? playerId : cellId,
      to: delta > 0 ? cellId : playerId,
      when: now,
      entries: { element, territory: cellId, before: r3(before), delta },
      exits: { influence: r3(after) },
      tags: ["ecology", "gps"],
    });
    return after;
  }

  #decayed(t: Territory, now: number): Partial<Record<ElementId, number>> {
    const f = Math.pow(0.5, Math.max(0, now - t.influenceAt) / WORLD_TUNING.influenceHalfLifeMs);
    const out: Partial<Record<ElementId, number>> = {};
    for (const [e, v] of Object.entries(t.influence) as [ElementId, number][]) {
      const x = v * f;
      if (Math.abs(x) >= 1e-4) out[e] = x;
    }
    return out;
  }

  #influenceField(pos: V3, now: number): Partial<Record<ElementId, number>> {
    const cs = this.cellSize;
    const seen = new Set<string>();
    const out: Partial<Record<ElementId, number>> = {};
    for (const ox of [-cs, 0, cs]) {
      for (const oz of [-cs, 0, cs]) {
        const id = this.cellOf({ x: pos.x + ox, y: 0, z: pos.z + oz });
        if (seen.has(id)) continue;
        seen.add(id);
        const t = this.#cells.get(id);
        if (!t) continue;
        const w = clamp(1 - distXZ(pos, this.cellCenter(id)) / (1.5 * cs), 0, 1);
        if (w <= 0) continue;
        for (const [e, v] of Object.entries(this.#decayed(t, now)) as [ElementId, number][]) out[e] = (out[e] ?? 0) + w * v;
      }
    }
    return out;
  }

  #placeBias(pos: V3): Partial<Record<ElementId, number>> {
    const out: Partial<Record<ElementId, number>> = {};
    for (const p of this.#places.values()) {
      const d = distXZ(pos, p.pos);
      if (d >= 2 * p.radius) continue;
      const f = 1 - smoothstep(p.radius, 2 * p.radius, d);
      for (const [e, b] of Object.entries(PLACE_KIND_DEFS[p.kind].elementBias) as [ElementId, number][]) {
        out[e] = (out[e] ?? 0) + f * b;
      }
    }
    return out;
  }

  #rarityBoost(pos: V3, hour: number, weather: WeatherId): number {
    const night = Math.max(0, -dayness(hour));
    let place = 1;
    for (const p of this.#inside(pos)) place = Math.max(place, RARE_PLACE[p.kind] ?? 1);
    return (1 + 0.3 * night) * (RARE_WEATHER[weather] ?? 1) * place;
  }

  // ------------------------------------------------------------ internals

  #inside(pos: V3): Place[] {
    const out = [...this.#places.values()].filter((p) => distXZ(pos, p.pos) <= p.radius);
    out.sort((a, b) => distXZ(pos, a.pos) / a.radius - distXZ(pos, b.pos) / b.radius || byId(a, b));
    return out;
  }

  #insert(p: Place): void {
    if (this.#places.has(p.id)) throw new RangeError(`duplicate place id ${p.id}`);
    this.#places.set(p.id, p);
    if (p.kind === "home" && p.ownerId !== null) {
      const cell = this.cellOf(p.pos);
      const set = this.#homeCells.get(cell) ?? new Set<string>();
      set.add(p.ownerId);
      this.#homeCells.set(cell, set);
    }
  }

  /** One ledger row; `where` is snapped to the 100 m cell centre (privacy: never a raw position). */
  #emit(row: {
    what: string;
    space: Space;
    pos: V3;
    who: string;
    why: string;
    from: string;
    to: string;
    when: number;
    entries: Record<string, Scalar>;
    exits: Record<string, Scalar>;
    tags: string[];
  }): void {
    if (!this.#ledger) return;
    const zone = this.cellOf(row.pos);
    const c = this.cellCenter(zone);
    this.#ledger.emit({
      when: row.when,
      where: { x: r3(c.x), y: r3(c.y), z: r3(c.z), zone, space: row.space },
      who: row.who,
      what: row.what,
      why: row.why,
      from: row.from,
      to: row.to,
      entries: row.entries,
      exits: row.exits,
      tags: ["world", ...row.tags],
    });
  }

  // ------------------------------------------------------------ persistence

  toJSON(): WorldMapJSON {
    return {
      v: 1,
      seed: this.seed,
      origin: { lat: this.origin.lat, lon: this.origin.lon },
      cellSize: this.cellSize,
      places: this.places(),
      territories: [...this.#cells.values()].map(copyTerritory),
      avatars: [...this.#avatars.entries()].map(([playerId, a]) => ({ playerId, placeId: a.placeId, since: a.since })),
    };
  }

  /** Rebuild from toJSON() output. Fails closed (RangeError) on any malformed field. */
  static fromJSON(data: unknown, ledger?: Ledger): WorldMap {
    const d = record(data, "world");
    if (d.v !== 1) throw new RangeError("WorldMap.fromJSON: unsupported version (v must be 1)");
    const origin = record(d.origin, "origin");
    const m = new WorldMap({
      seed: num(d.seed, "seed"),
      origin: { lat: num(origin.lat, "origin.lat"), lon: num(origin.lon, "origin.lon") },
      cellSize: num(d.cellSize, "cellSize"),
      ledger,
    });
    for (const raw of list(d.places, "places")) m.#insert(parsePlace(raw));
    const prefix = `${m.cellSize}:`;
    for (const raw of list(d.territories, "territories")) {
      const t = parseTerritory(raw);
      if (!t.cellId.startsWith(prefix)) throw new RangeError(`territory ${t.cellId} does not use ${m.cellSize} m cells`);
      m.#cells.set(t.cellId, t);
    }
    for (const raw of list(d.avatars, "avatars")) {
      const a = record(raw, "avatar");
      m.#avatars.set(str(a.playerId, "avatar.playerId"), { placeId: str(a.placeId, "avatar.placeId"), since: num(a.since, "avatar.since") });
    }
    return m;
  }
}

// ---------------------------------------------------------------- JSON validation

function record(v: unknown, what: string): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new RangeError(`WorldMap.fromJSON: ${what} must be an object`);
  return v as Record<string, unknown>;
}

function list(v: unknown, what: string): unknown[] {
  if (!Array.isArray(v)) throw new RangeError(`WorldMap.fromJSON: ${what} must be an array`);
  return v;
}

function num(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new RangeError(`WorldMap.fromJSON: ${what} must be a finite number`);
  return v;
}

function str(v: unknown, what: string): string {
  if (typeof v !== "string" || v.length === 0) throw new RangeError(`WorldMap.fromJSON: ${what} must be a non-empty string`);
  return v;
}

function strList(v: unknown, what: string): string[] {
  return list(v, what).map((s, i) => str(s, `${what}[${i}]`));
}

function parsePlace(raw: unknown): Place {
  const p = record(raw, "place");
  const kind = str(p.kind, "place.kind") as PlaceKind;
  if (!PLACE_KINDS.includes(kind)) throw new RangeError(`WorldMap.fromJSON: unknown place kind ${kind}`);
  const ground = str(p.ground, "place.ground") as GroundId;
  if (!GROUND_IDS.includes(ground)) throw new RangeError(`WorldMap.fromJSON: unknown ground ${ground}`);
  const pos = record(p.pos, "place.pos");
  const ownerId = p.ownerId === null ? null : str(p.ownerId, "place.ownerId");
  return {
    id: str(p.id, "place.id"),
    kind,
    name: str(p.name, "place.name"),
    pos: { x: num(pos.x, "pos.x"), y: num(pos.y, "pos.y"), z: num(pos.z, "pos.z") },
    lat: num(p.lat, "place.lat"),
    lon: num(p.lon, "place.lon"),
    radius: num(p.radius, "place.radius"),
    ground,
    ownerId,
    discoveredBy: strList(p.discoveredBy, "place.discoveredBy"),
    visitedBy: strList(p.visitedBy, "place.visitedBy"),
  };
}

function parseTerritory(raw: unknown): Territory {
  const t = record(raw, "territory");
  const cellId = str(t.cellId, "territory.cellId");
  gridCellById(cellId);
  const influence: Partial<Record<ElementId, number>> = {};
  for (const [e, v] of Object.entries(record(t.influence, "territory.influence"))) {
    if (!ELEMENT_IDS.includes(e as ElementId)) throw new RangeError(`WorldMap.fromJSON: unknown element ${e}`);
    influence[e as ElementId] = num(v, `influence.${e}`);
  }
  return {
    cellId,
    ownerId: t.ownerId === null ? null : str(t.ownerId, "territory.ownerId"),
    defense: num(t.defense, "territory.defense"),
    claimedAt: num(t.claimedAt, "territory.claimedAt"),
    defendedAt: num(t.defendedAt, "territory.defendedAt"),
    influence,
    influenceAt: num(t.influenceAt, "territory.influenceAt"),
  };
}
