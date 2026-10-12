/**
 * World store: the device's one persisted WorldMap ("genemon.world" in localStorage, saved after
 * every action), each profile's generated neighbourhood, the per-session avatar + Simulated-GPS
 * state, and the action helpers the World screen wires to its buttons.
 *
 * Every gate is the engine's own rule (actionAllowed, travelVirtual, claim, defend, discover,
 * catchAllowed) and every refusal carries the engine's reason. There is NO real GPS yet (the CSP
 * keeps the app offline): a profile counts as physically present at a place only while its
 * session's "Simulated GPS: I am physically here" toggle is ON (default OFF) AND its avatar stands
 * at that place. The genemon.catch / genemon.release rows this module writes under the toggle are
 * tagged "simulated-gps" (feed / experience rows say so in `why`); the engine's own world.* rows
 * cannot carry that tag, so the screen logs a ui.world.simulatedGps row whenever the toggle changes.
 *
 * Pure except getWorld(), which reads the browser's localStorage: everything else takes a
 * Storage-like object and `now` (epoch ms), so it runs under plain `deno test`.
 */
import type { Ledger, Scalar, Space, Where } from "../core/ledger.ts";
import { distXZ, r3, type V3 } from "../core/math.ts";
import { hashSeed, Rng } from "../core/rng.ts";
import type { AxisId, AxisVector } from "../data/axes.ts";
import { ELEMENT_IDS, ELEMENTS, type ElementId } from "../data/elements.ts";
import { EXPERIENCES, FOODS, type FoodId } from "../data/lifestyle.ts";
import type { WeatherId } from "../data/weather.ts";
import { createGenemon, feed, type Genemon, live, phenotypeOf } from "../genome/genemon.ts";
import { ARENA_KINDS, type ArenaKind } from "../world/arena.ts";
import {
  catchAllowed,
  type DiscoverResult,
  type Place,
  PLACE_KIND_DEFS,
  type PlaceKind,
  type Rarity,
  type Spawn,
  type SpawnEntry,
  type Verdict,
  type VisitContext,
  WORLD_TUNING,
  type WorldAction,
  WorldMap,
} from "../world/worldmap.ts";

// ---------------------------------------------------------------- persistence

export const WORLD_KEY = "genemon.world";
/** One shared world per device: every profile's neighbourhood lives in it (the seed is saved too). */
export const WORLD_SEED = 20261012;
export type LatLon = { lat: number; lon: number };
/** Default origin and default home: Paris, Hôtel de Ville. */
export const PARIS_HOTEL_DE_VILLE: Readonly<LatLon> = Object.freeze({ lat: 48.8566, lon: 2.3522 });
/** docs/WORLD.md §2: re-centre the local frame when the player is farther than this from the origin. */
export const RECENTRE_KM = 20;
/** IUGG mean Earth radius (same value as src/world/worldmap.ts). */
const EARTH_RADIUS_KM = 6371.0088;
const DAY_MS = 86_400_000;

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface LoadOptions {
  ledger?: Ledger;
  /** Origin for a NEW world (an existing save keeps its own); invalid -> Paris. */
  origin?: LatLon | null;
  seed?: number;
}

/** A usable equirectangular origin (finite, within the engine's +-85 deg), else null. */
export function validOrigin(o: LatLon | null | undefined): LatLon | null {
  if (!o || !Number.isFinite(o.lat) || !Number.isFinite(o.lon)) return null;
  if (Math.abs(o.lat) > WORLD_TUNING.maxOriginLat || Math.abs(o.lon) > 180) return null;
  return { lat: o.lat, lon: o.lon };
}

/** Great-circle distance (haversine). */
export function geoDistanceKm(a: LatLon, b: LatLon): number {
  const rad = Math.PI / 180;
  const s1 = Math.sin(((b.lat - a.lat) * rad) / 2), s2 = Math.sin(((b.lon - a.lon) * rad) / 2);
  const h = s1 * s1 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * s2 * s2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * The saved world, or a fresh one. A save that fails to parse or validate (WorldMap.fromJSON fails
 * closed) is kept under "genemon.world.corrupt" before a new world replaces it.
 */
export function loadWorld(storage: StorageLike, opts: LoadOptions = {}): WorldMap {
  const raw = safeGet(storage, WORLD_KEY);
  if (raw) {
    try {
      return WorldMap.fromJSON(JSON.parse(raw), opts.ledger);
    } catch {
      safeSet(storage, `${WORLD_KEY}.corrupt`, raw);
    }
  }
  return new WorldMap({ seed: opts.seed ?? WORLD_SEED, origin: validOrigin(opts.origin) ?? PARIS_HOTEL_DE_VILLE, ledger: opts.ledger });
}

/** Persist the whole world; false when storage refuses (quota). */
export function saveWorld(storage: StorageLike, world: WorldMap): boolean {
  return safeSet(storage, WORLD_KEY, JSON.stringify(world.toJSON()));
}

function safeGet(storage: StorageLike, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(storage: StorageLike, key: string, value: string): boolean {
  try {
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Same world in a new local frame: every place keeps its lat/lon (and so its cell, terrain and
 * ids); only the local ENU positions are re-projected. Territories and avatars are origin-free.
 */
export function recentreWorld(world: WorldMap, origin: LatLon, ledger?: Ledger): WorldMap {
  const json = world.toJSON();
  const frame = new WorldMap({ seed: json.seed, origin, cellSize: json.cellSize });
  const places = json.places.map((p) => ({ ...p, pos: frame.toLocal(p.lat, p.lon, p.pos.y) }));
  return WorldMap.fromJSON({ ...json, origin: { lat: origin.lat, lon: origin.lon }, places }, ledger);
}

let shared: { world: WorldMap; ledger: Ledger } | null = null;

/** The slice of the App that getWorld reads (App satisfies it; keeps this module free of app.ts). */
export interface WorldHost {
  ledger: Ledger;
  profile: { id: string; home: LatLon | null };
}

/**
 * The app's one WorldMap (built with app.ledger, loaded from localStorage). The local frame is
 * re-centred on the active profile when its home is more than RECENTRE_KM from the origin.
 */
export function getWorld(app: WorldHost): WorldMap {
  const storage = globalThis.localStorage;
  if (!shared || shared.ledger !== app.ledger) {
    shared = { world: loadWorld(storage, { ledger: app.ledger, origin: app.profile.home }), ledger: app.ledger };
  }
  const want = validOrigin(app.profile.home) ?? homeLatLon(shared.world, app.profile.id);
  if (want && geoDistanceKm(shared.world.origin, want) > RECENTRE_KM) {
    shared.world = recentreWorld(shared.world, want, app.ledger);
    saveWorld(storage, shared.world);
  }
  return shared.world;
}

// ---------------------------------------------------------------- neighbourhood

/** The profile's own home place, once its neighbourhood exists. */
export function homeOf(world: WorldMap, profileId: string): Place | null {
  return world.places().find((p) => p.kind === "home" && p.ownerId === profileId) ?? null;
}

function homeLatLon(world: WorldMap, profileId: string): LatLon | null {
  const h = homeOf(world, profileId);
  return h ? { lat: h.lat, lon: h.lon } : null;
}

/**
 * The profile's places (home + 28), generated once. An existing home always wins (so a re-centred
 * origin never spawns a second neighbourhood); otherwise the home goes at the profile's home, or
 * at the world origin for a profile without one. A repeat call adds and logs nothing.
 */
export function ensureNeighbourhood(world: WorldMap, profileId: string, now: number, home: LatLon | null = null): Place[] {
  const existing = homeOf(world, profileId);
  const at = validOrigin(home);
  const anchor = existing ? existing.pos : at ? world.toLocal(at.lat, at.lon) : world.toLocal(world.origin.lat, world.origin.lon);
  return world.generateNeighbourhood(profileId, anchor, now);
}

// ---------------------------------------------------------------- session (not persisted)

export interface Candidate {
  spawn: Spawn;
  genemon: Genemon;
  placeId: string;
  seed: number;
  at: number;
}

export interface Activity {
  at: number;
  action: string;
  ok: boolean;
  reason: string;
}

export interface WorldSession {
  /** "Simulated GPS: I am physically here" (default OFF: there is no real GPS yet). */
  gps: boolean;
  /** Place id where the avatar stands (null = the profile's home). */
  avatar: string | null;
  candidate: Candidate | null;
  log: Activity[];
}

export function newSession(): WorldSession {
  return { gps: false, avatar: null, candidate: null, log: [] };
}

const SESSIONS = new Map<string, WorldSession>();

/** This page session's world state for a profile (lost on reload by design). */
export function worldSession(profileId: string): WorldSession {
  let s = SESSIONS.get(profileId);
  if (!s) {
    s = newSession();
    SESSIONS.set(profileId, s);
  }
  return s;
}

/** The avatar's place (home by default; never someone else's private place). */
export function resolveAvatar(world: WorldMap, s: WorldSession, profileId: string): Place | null {
  const cur = s.avatar ? world.place(s.avatar) : null;
  if (cur && (cur.ownerId === null || cur.ownerId === profileId)) return cur;
  const home = homeOf(world, profileId);
  s.avatar = home?.id ?? null;
  return home;
}

/** Physically present = Simulated GPS on AND the avatar stands at that very place. */
export function presentAt(s: WorldSession, placeId: string): boolean {
  return s.gps && s.avatar === placeId;
}

/** Newest first, last 8. */
export function record(s: WorldSession, action: string, v: Verdict, now: number): void {
  s.log.unshift({ at: now, action, ok: v.ok, reason: v.reason });
  s.log.length = Math.min(s.log.length, 8);
}

const no = (reason: string): Verdict => ({ ok: false, reason });

/** "a gym", "an arena": the indefinite article for a place kind in messages. */
export function aOrAn(word: string): string {
  return `${/^[aeiou]/i.test(word) ? "an" : "a"} ${word}`;
}

// ---------------------------------------------------------------- place -> arena, kind actions, food

/** Fixed arena per place kind; null = the portal, whose far side turns with the hour. */
const PLACE_ARENA: Record<PlaceKind, ArenaKind | null> = {
  home: "meadow",
  supermarket: "meadow",
  gym: "meadow",
  park: "meadow",
  lake: "lake",
  forest: "forest",
  cafe: "meadow",
  school: "meadow",
  office: "meadow",
  station: "meadow",
  museum: "meadow",
  beach: "beach",
  mountain: "canyon",
  hospital: "meadow",
  library: "meadow",
  stadium: "city",
  farmersMarket: "meadow",
  river: "lake",
  arena: "city",
  dungeon: "crystal",
  portal: null,
  pool: "meadow",
  garden: "meadow",
  harbour: "meadow",
  landmark: "meadow",
  plaza: "meadow",
};

/** Arena of a battle fought at a place kind (total: any kind, any hour, even NaN). */
export function arenaKindForPlace(kind: PlaceKind, hour: number): ArenaKind {
  const fixed: ArenaKind | null | undefined = PLACE_ARENA[kind];
  if (fixed) return fixed;
  if (fixed === undefined) return "meadow";
  const h = Number.isFinite(hour) ? ((Math.floor(hour) % 24) + 24) % 24 : 0;
  return ARENA_KINDS[h % ARENA_KINDS.length];
}

export type KindActionId = "buy" | "train" | "battle";
export interface KindAction {
  id: KindActionId;
  action: WorldAction;
  label: string;
}

const KIND_ACTIONS: Partial<Record<PlaceKind, KindAction>> = {
  supermarket: { id: "buy", action: "supermarket.buy", label: "Buy food for your team" },
  farmersMarket: { id: "buy", action: "farmersMarket.buy", label: "Buy fresh produce for your team" },
  harbour: { id: "buy", action: "harbour.buy", label: "Buy fish for your team" },
  cafe: { id: "buy", action: "cafe.buy", label: "Buy treats for your team" },
  gym: { id: "train", action: "gym.train", label: "Train your team" },
  arena: { id: "battle", action: "battle.casual", label: "Battle here" },
  stadium: { id: "battle", action: "battle.ranked", label: "Battle here" },
  dungeon: { id: "battle", action: "dungeon.enter", label: "Battle here" },
  portal: { id: "battle", action: "portal.enter", label: "Battle here" },
};

/** The place's own action (shopping, gym, battle), gated by its WORLD_ACTIONS key. */
export function kindAction(kind: PlaceKind): KindAction | null {
  return KIND_ACTIONS[kind] ?? null;
}

/** What each shop sells (FOODS ids). */
export const PLACE_FOODS: Partial<Record<PlaceKind, readonly FoodId[]>> = {
  supermarket: ["greens", "berries", "meat", "fish", "honey", "minerals", "spicyPepper", "iceCream", "candy", "coffeeBean"],
  farmersMarket: ["berries", "greens", "honey", "mushroom", "spicyPepper", "glowFruit"],
  harbour: ["fish", "seaweed"],
  cafe: ["coffeeBean", "honey", "candy", "iceCream"],
};

/** From a shop's stock, the food whose nudges best follow the eater's element signature (else `salt` picks). */
export function pickFood(stock: readonly FoodId[], element: ElementId, salt: number): FoodId {
  if (stock.length === 0) return "berries";
  const sig = ELEMENTS[element].signature;
  let best: FoodId | null = null, bestScore = 0;
  for (const f of stock) {
    let score = 0;
    for (const [axis, w] of Object.entries(FOODS[f].nudge) as [AxisId, number][]) score += w * (sig[axis] ?? 0);
    if (score > bestScore + 1e-12) {
      best = f;
      bestScore = score;
    }
  }
  return best ?? stock[(salt >>> 0) % stock.length];
}

// ---------------------------------------------------------------- team & ledger helpers

/** The profile shape the actions touch (a Profile satisfies it). */
export interface Keeper {
  id: string;
  collection: Genemon[];
  team: string[];
  pokedex: string[];
}

export function teamMembers(k: Pick<Keeper, "collection" | "team">): Genemon[] {
  return k.team.map((id) => k.collection.find((g) => g.id === id)).filter((g): g is Genemon => g !== undefined);
}

/** Claim / garrison power: sum of the team's Phenotype.power (docs/WORLD.md §4 scale). */
export function teamPower(team: readonly Genemon[]): number {
  return team.reduce((s, g) => s + phenotypeOf(g).power, 0);
}

/** Ledger `where` snapped to the 100 m cell centre (privacy rule of the world module). */
export function cellWhere(world: WorldMap, pos: V3, space: Space): Where {
  const zone = world.cellOf(pos);
  const c = world.cellCenter(zone);
  return { x: r3(c.x), y: r3(c.y), z: r3(c.z), zone, space };
}

function genemonRow(
  ledger: Ledger | undefined,
  world: WorldMap,
  pos: V3,
  present: boolean,
  row: { when: number; who: string; what: string; why: string; from: string; to: string; entries: Record<string, Scalar>; exits: Record<string, Scalar> },
): void {
  ledger?.emit({ ...row, where: cellWhere(world, pos, present ? "physical" : "virtual"), tags: ["genemon", present ? "simulated-gps" : "virtual"] });
}

// ---------------------------------------------------------------- moving

export type MoveMode = "walk" | "virtual" | "return" | "none";
export interface MoveResult extends Verdict {
  mode: MoveMode;
}

function arrive(s: WorldSession, p: Place, r: MoveResult): MoveResult {
  s.avatar = p.id;
  s.candidate = null;
  return r;
}

/**
 * Go: with Simulated GPS on, a (simulated) walk to any visible place; otherwise travelVirtual(),
 * which only reaches VIRTUAL_TRAVEL_KINDS. Going back to your own home is always possible (the
 * avatar leaves the virtual space). A refused move changes nothing.
 */
export function moveAvatar(world: WorldMap, s: WorldSession, profileId: string, placeId: string, now: number): MoveResult {
  const p = world.place(placeId);
  if (!p) return { ok: false, reason: `unknown place ${placeId}`, mode: "none" };
  if (p.ownerId !== null && p.ownerId !== profileId) return { ok: false, reason: "private place: only its owner can go there", mode: "none" };
  if (s.avatar === placeId) return { ok: true, reason: `already at ${p.name}`, mode: "none" };
  if (s.gps) return arrive(s, p, { ok: true, reason: `walked to ${p.name} (simulated GPS)`, mode: "walk" });
  if (p.kind === "home") return arrive(s, p, { ok: true, reason: "back home: your avatar left the virtual space", mode: "return" });
  const v = world.travelVirtual(profileId, placeId, now);
  return v.ok ? arrive(s, p, { ...v, mode: "virtual" }) : { ...v, mode: "none" };
}

// ---------------------------------------------------------------- place actions

export function applyDiscover(world: WorldMap, s: WorldSession, profileId: string, place: Place, now: number, ctx: VisitContext = {}): DiscoverResult {
  return world.discover(profileId, place.id, now, presentAt(s, place.id), ctx);
}

/** Claim the cell under the place with the team's power (on site only: the engine refuses otherwise). */
export function applyClaim(world: WorldMap, s: WorldSession, keeper: Keeper, place: Place, now: number): Verdict {
  return world.claim(keeper.id, place.pos, teamPower(teamMembers(keeper)), now, presentAt(s, place.id));
}

/** Reinforce the cell under the place from anywhere (owner only). */
export function applyDefend(world: WorldMap, keeper: Keeper, place: Place, now: number): Verdict {
  return world.defend(keeper.id, world.cellOf(place.pos), teamPower(teamMembers(keeper)), now);
}

export interface Fed {
  name: string;
  food: FoodId;
}

/** Device-local hour (0-24) of an epoch time (UI layer: derived from the `now` passed in, never the clock). */
export function localHour(now: number): number {
  const d = new Date(now);
  return d.getHours() + d.getMinutes() / 60;
}

/** Shop in person: every team member eats one food from the shop's stock (feed(), ledger rows). */
export function applyBuyFood(world: WorldMap, s: WorldSession, keeper: Keeper, place: Place, now: number, ledger?: Ledger): Verdict & { fed: Fed[] } {
  const ka = kindAction(place.kind);
  const stock = PLACE_FOODS[place.kind];
  if (!ka || ka.id !== "buy" || !stock) return { ok: false, reason: `no food for sale at ${aOrAn(place.kind)}`, fed: [] };
  const v = world.actionAllowed(ka.action, place, presentAt(s, place.id), keeper.id);
  if (!v.ok) return { ...v, fed: [] };
  const team = teamMembers(keeper);
  if (team.length === 0) return { ok: false, reason: "your team is empty: add Genemon in the Team screen", fed: [] };
  const where = cellWhere(world, place.pos, "physical");
  const day = Math.floor(now / DAY_MS);
  const fed = team.map((g): Fed => {
    const food = pickFood(stock, phenotypeOf(g).elements.primary, hashSeed(place.id, g.id, day));
    feed(g, food, 1, { ledger, when: now, hour: localHour(now), who: keeper.id, where, why: `bought at ${place.name} (${ka.action}, simulated GPS)` });
    return { name: g.name, food };
  });
  return { ok: true, reason: `fed ${fed.map((f) => `${f.name}: ${FOODS[f.food].name.toLowerCase()}`).join(", ")}`, fed };
}

/** Train at a gym in person: live(g, "gymTraining", 1, { physical: true }) for the whole team. */
export function applyTrain(world: WorldMap, s: WorldSession, keeper: Keeper, place: Place, now: number, ledger?: Ledger): Verdict {
  const ka = kindAction(place.kind);
  if (!ka || ka.id !== "train") return no(`no training at ${aOrAn(place.kind)}`);
  const v = world.actionAllowed(ka.action, place, presentAt(s, place.id), keeper.id);
  if (!v.ok) return v;
  const team = teamMembers(keeper);
  if (team.length === 0) return no("your team is empty: add Genemon in the Team screen");
  const where = cellWhere(world, place.pos, "physical");
  let trained = 0;
  for (const g of team) {
    if (live(g, "gymTraining", 1, { physical: true, ledger, when: now, hour: localHour(now), who: keeper.id, where, why: `trained at ${place.name} (simulated GPS)` })) trained++;
  }
  return { ok: true, reason: `${trained} Genemon trained at ${place.name} (+${EXPERIENCES.gymTraining.xp} xp each)` };
}

/** App.startBattle options for a battle fought at a place. */
export interface WorldBattle {
  arena: ArenaKind;
  weather: "auto";
  hour: "real";
  opponent: "wild" | "rival";
}

export interface BattlePlan extends Verdict {
  battle: WorldBattle | null;
  move: MoveResult | null;
}

/**
 * Battle at an arena / stadium / dungeon / portal: gated by the place's battle action (virtual, so
 * allowed from the sofa); the avatar first goes there (walk or virtual travel). Dungeons pit you
 * against wild swarms, the rest against a rival trainer.
 */
export function battlePlan(world: WorldMap, s: WorldSession, profileId: string, place: Place, hour: number, now: number): BattlePlan {
  const ka = kindAction(place.kind);
  if (!ka || ka.id !== "battle") return { ok: false, reason: `no battles at ${aOrAn(place.kind)}`, battle: null, move: null };
  const allowed = world.actionAllowed(ka.action, place, presentAt(s, place.id), profileId);
  if (!allowed.ok) return { ...allowed, battle: null, move: null };
  const move = s.avatar === place.id ? null : moveAvatar(world, s, profileId, place.id, now);
  if (move && !move.ok) return { ok: false, reason: move.reason, battle: null, move };
  const arena = arenaKindForPlace(place.kind, hour);
  return {
    ok: true,
    reason: `${ka.action} at ${place.name}: ${arena} arena`,
    battle: { arena, weather: "auto", hour: "real", opponent: place.kind === "dungeon" ? "wild" : "rival" },
    move,
  };
}

// ---------------------------------------------------------------- wild spawns, catch, release

/** Spawn seed: place + hour + wall-clock minute (the wild changes every minute, not on every click). */
export function spawnSeed(placeId: string, hour: number, nowMs: number): number {
  return hashSeed(placeId, Number.isFinite(hour) ? Math.floor(hour) : 0, Math.floor(nowMs / 60_000));
}

/** Genome bias toward an element's axis signature (scaled so alleles stay off the clamps). */
export function signatureBias(element: ElementId, strength = 0.85): Partial<AxisVector> {
  const out: Partial<AxisVector> = {};
  for (const [axis, w] of Object.entries(ELEMENTS[element].signature) as [AxisId, number][]) out[axis] = strength * w;
  return out;
}

/**
 * The creature behind a spawn: biased toward the spawn element's signature, at the rolled level.
 * Neutral has an empty signature, so its bias is "no strong axis": alleles held close to zero.
 */
export function wildCandidate(spawn: Spawn, seed: number, now: number): Genemon {
  const axes = signatureBias(spawn.element);
  const spread = Object.keys(axes).length === 0 ? 0.12 : 0.3;
  return createGenemon({ seed, owner: "wild", level: spawn.level, bornAt: now, bias: { axes, spread } });
}

/** Roll one wild spawn where the avatar stands (sensitive places spawn nothing). */
export function lookForWild(world: WorldMap, s: WorldSession, place: Place, hour: number, weather: WeatherId, now: number): Verdict {
  if (s.avatar !== place.id) return no(`your avatar is not at ${place.name}`);
  const sensitive = world.sensitivePlaceAt(place.pos);
  if (sensitive) {
    s.candidate = null;
    return no(`no wild Genemon at ${aOrAn(sensitive.kind)}: sensitive places are skipped by spawners`);
  }
  const seed = spawnSeed(place.id, hour, now);
  const spawn = world.rollSpawn(place.pos, hour, weather, now, new Rng(seed));
  const genemon = wildCandidate(spawn, seed, now);
  s.candidate = { spawn, genemon, placeId: place.id, seed, at: now };
  return { ok: true, reason: `a wild ${spawn.rarity} ${ELEMENTS[spawn.element].name.toLowerCase()} Genemon appeared: ${genemon.name}, Lv ${spawn.level}` };
}

/**
 * Catch rule = catchAllowed(rarity, present) AND the place offers the catch: on site, the
 * physical "catch" action; from the virtual space, "catch.virtual" (dungeon / portal only).
 */
export function catchVerdict(world: WorldMap, place: Place, rarity: Rarity, present: boolean, playerId: string): Verdict {
  const rule = catchAllowed(rarity, present);
  if (!rule.ok) return rule;
  if (present) return world.actionAllowed("catch", place, true, playerId);
  const virtual = world.actionAllowed("catch.virtual", place, false, playerId);
  return virtual.ok ? rule : world.actionAllowed("catch", place, false, playerId);
}

/**
 * Catch the current candidate into the collection + pokedex. Only an ON-SITE catch calls
 * world.catchAt (the ecology and its world.catch row, which content counts as physical); a
 * virtual-instance catch leaves the physical ecology alone (docs/WORLD.md, open questions).
 */
export function applyCatch(world: WorldMap, s: WorldSession, keeper: Keeper, now: number, ledger?: Ledger): Verdict {
  const c = s.candidate;
  if (!c) return no("nothing to catch: look for wild Genemon first");
  const place = world.place(c.placeId);
  if (!place) return no(`unknown place ${c.placeId}`);
  if (s.avatar !== place.id) {
    s.candidate = null;
    return no("the wild Genemon stayed behind when you left");
  }
  const present = presentAt(s, place.id);
  const v = catchVerdict(world, place, c.spawn.rarity, present, keeper.id);
  if (!v.ok) return v;
  const g = c.genemon;
  if (keeper.collection.some((x) => x.id === g.id)) {
    s.candidate = null;
    return no(`${g.name} is already in your collection (the wild changes every minute)`);
  }
  g.owner = keeper.id;
  keeper.collection.push(g);
  if (!keeper.pokedex.includes(g.genome.id)) keeper.pokedex.push(g.genome.id);
  s.candidate = null;
  const influence = present ? world.catchAt(keeper.id, c.spawn.element, place.pos, now) : null;
  genemonRow(ledger, world, place.pos, present, {
    when: now,
    who: keeper.id,
    what: "genemon.catch",
    why: present ? "caught on site (simulated GPS)" : "caught inside a virtual instance",
    from: place.id,
    to: g.id,
    entries: { element: c.spawn.element, rarity: c.spawn.rarity, level: c.spawn.level, poi: place.kind, onSite: present },
    exits: { genome: g.genome.id, primary: phenotypeOf(g).elements.primary, collection: keeper.collection.length },
  });
  const eco = influence === null
    ? "virtual instance: the physical ecology is untouched"
    : `local ${c.spawn.element} influence now ${r3(influence)}`;
  return { ok: true, reason: `caught ${g.name} (${c.spawn.rarity} ${c.spawn.element}, Lv ${c.spawn.level}); ${eco}` };
}

/** May this Genemon be released where the avatar stands? (physical "release" + keep at least one). */
export function releaseVerdict(world: WorldMap, s: WorldSession, keeper: Keeper, genemonId: string): Verdict {
  const place = s.avatar ? world.place(s.avatar) : null;
  if (!place) return no("your avatar is nowhere: open the World screen first");
  const g = keeper.collection.find((x) => x.id === genemonId);
  if (!g) return no("pick a Genemon from your collection");
  const v = world.actionAllowed("release", place, presentAt(s, place.id), keeper.id);
  if (!v.ok) return v;
  if (keeper.collection.length <= 1) return no("keep at least one Genemon");
  const team = teamMembers(keeper);
  if (team.length <= 1 && team.some((x) => x.id === g.id)) return no("your team needs at least one Genemon: add another one to the team first");
  return v;
}

/** Release into the wild here: world.release seeds its element locally; it leaves collection and team. */
export function applyRelease(world: WorldMap, s: WorldSession, keeper: Keeper, genemonId: string, now: number, ledger?: Ledger): Verdict {
  const v = releaseVerdict(world, s, keeper, genemonId);
  if (!v.ok) return v;
  const place = s.avatar ? world.place(s.avatar) : null;
  const g = keeper.collection.find((x) => x.id === genemonId);
  if (!place || !g) return no("nothing to release here");
  const element = phenotypeOf(g).elements.primary;
  const influence = world.release(keeper.id, element, place.pos, now);
  keeper.collection = keeper.collection.filter((x) => x.id !== g.id);
  keeper.team = keeper.team.filter((id) => id !== g.id);
  genemonRow(ledger, world, place.pos, true, {
    when: now,
    who: keeper.id,
    what: "genemon.release",
    why: "released into the wild on site (simulated GPS)",
    from: g.id,
    to: place.id,
    entries: { element, poi: place.kind, genome: g.genome.id, level: phenotypeOf(g).level },
    exits: { influence: r3(influence), collection: keeper.collection.length },
  });
  return { ok: true, reason: `released ${g.name} at ${place.name}: ${element} influence here now ${r3(influence)} (more ${element} spawns nearby)` };
}

// ---------------------------------------------------------------- read models for the panel

export interface SpawnShare {
  element: ElementId;
  weight: number;
  share: number;
}

/** The n heaviest spawn entries with their share of the whole table. */
export function topSpawns(table: readonly SpawnEntry[], n = 6): SpawnShare[] {
  const total = table.reduce((sum, e) => sum + e.weight, 0) || 1;
  return [...table]
    .sort((a, b) => b.weight - a.weight || (a.element < b.element ? -1 : 1))
    .slice(0, n)
    .map((e) => ({ element: e.element, weight: e.weight, share: e.weight / total }));
}

/** Non-trivial ecology influence felt at a spot (releases +, catches -), strongest first. */
export function ecologyAt(world: WorldMap, pos: V3, now: number): { element: ElementId; influence: number }[] {
  return ELEMENT_IDS.map((element) => ({ element, influence: world.influenceAt(pos, element, now) }))
    .filter((e) => Math.abs(e.influence) >= 0.01)
    .sort((a, b) => Math.abs(b.influence) - Math.abs(a.influence));
}

export interface PlaceStatus {
  here: boolean;
  present: boolean;
  discovered: boolean;
  visited: boolean;
  yourHome: boolean;
  sensitive: boolean;
  cellId: string;
  owner: string | null;
  defense: number;
  yours: boolean;
}

export function placeStatus(world: WorldMap, s: WorldSession, profileId: string, place: Place, now: number): PlaceStatus {
  const cellId = world.cellOf(place.pos);
  const t = world.territory(cellId, now);
  return {
    here: s.avatar === place.id,
    present: presentAt(s, place.id),
    discovered: place.discoveredBy.includes(profileId),
    visited: place.visitedBy.includes(profileId),
    yourHome: place.kind === "home" && place.ownerId === profileId,
    sensitive: PLACE_KIND_DEFS[place.kind].sensitive,
    cellId,
    owner: t.ownerId,
    defense: t.defense,
    yours: t.ownerId === profileId,
  };
}

/** Places a profile may see (never someone else's home) within `range` m of `centre`, nearest to `from` first. */
export function visiblePlaces(world: WorldMap, profileId: string, from: V3, centre: V3, range: number): Place[] {
  return world.places()
    .filter((p) => (p.ownerId === null || p.ownerId === profileId) && Math.abs(p.pos.x - centre.x) <= range && Math.abs(p.pos.z - centre.z) <= range)
    .sort((a, b) => distXZ(from, a.pos) - distXZ(from, b.pos) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function fmtDistance(m: number, units: "metric" | "imperial" = "metric"): string {
  if (!Number.isFinite(m)) return "-";
  if (units === "imperial") {
    const ft = m * 3.28084;
    return ft < 1000 ? `${Math.round(ft)} ft` : `${(m / 1609.344).toFixed(1)} mi`;
  }
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
}
