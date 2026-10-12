// World store: persistence through a Storage-like object, per-profile neighbourhoods, the place ->
// arena map, and the physical-vs-virtual gates the World screen wires to its buttons. Presence in
// the UI = Simulated GPS on AND the avatar at that place (there is no real GPS yet).
import { assert, assertAlmostEquals, assertEquals } from "./_assert.ts";
import { isValidEvent, Ledger } from "../src/core/ledger.ts";
import { distXZ } from "../src/core/math.ts";
import { hashSeed, Rng } from "../src/core/rng.ts";
import { ELEMENT_IDS } from "../src/data/elements.ts";
import { EXPERIENCES } from "../src/data/lifestyle.ts";
import { createGenemon, type Genemon, phenotypeOf } from "../src/genome/genemon.ts";
import { ARENA_KINDS } from "../src/world/arena.ts";
import { type Place, PLACE_KIND_DEFS, PLACE_KINDS, type PlaceKind, type Spawn, VIRTUAL_TRAVEL_KINDS, WORLD_ACTIONS, WorldMap } from "../src/world/worldmap.ts";
import {
  aOrAn,
  applyBuyFood,
  applyCatch,
  applyClaim,
  applyDefend,
  applyRelease,
  applyTrain,
  arenaKindForPlace,
  battlePlan,
  catchVerdict,
  ensureNeighbourhood,
  fmtDistance,
  geoDistanceKm,
  homeOf,
  type Keeper,
  kindAction,
  loadWorld,
  lookForWild,
  moveAvatar,
  newSession,
  PARIS_HOTEL_DE_VILLE,
  pickFood,
  PLACE_FOODS,
  presentAt,
  recentreWorld,
  resolveAvatar,
  saveWorld,
  spawnSeed,
  type StorageLike,
  teamMembers,
  teamPower,
  topSpawns,
  wildCandidate,
  WORLD_KEY,
  WORLD_SEED,
} from "../src/ui/worldStore.ts";

/** Fixed clock (12:00:00.000 UTC: a minute boundary). */
const T0 = Date.UTC(2026, 9, 12, 12, 0, 0);
const DAY = 86_400_000;
const LYON = { lat: 45.7748, lon: 4.8318 };

class MemStorage implements StorageLike {
  readonly m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, String(v));
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
}

function fixture() {
  const ledger = new Ledger("test", 20000);
  const world = new WorldMap({ seed: WORLD_SEED, origin: PARIS_HOTEL_DE_VILLE, ledger });
  const places = ensureNeighbourhood(world, "max", T0);
  return { ledger, world, places };
}

/** A profile-shaped keeper: n Genemon, the first min(n, 3) in the team. */
function keeperOf(id: string, n: number): Keeper {
  const collection: Genemon[] = Array.from({ length: n }, (_, i) => createGenemon({ seed: hashSeed(id, "keeper", i), owner: id, level: 12 + i }));
  return { id, collection, team: collection.slice(0, 3).map((g) => g.id), pokedex: collection.map((g) => g.genome.id) };
}

function byKind(world: WorldMap, profileId: string, kind: PlaceKind): Place {
  const p = world.places().find((q) => q.kind === kind && (q.ownerId === null || q.ownerId === profileId));
  assert(p, `no ${kind} in the neighbourhood`);
  return p;
}

Deno.test("[WORLD-STORE] save/load through a Storage-like object is lossless; unreadable saves fail closed to a fresh world", () => {
  const storage = new MemStorage();
  const ledger = new Ledger("test", 20000);
  const world = loadWorld(storage, { ledger });
  assertEquals(world.origin, { lat: 48.8566, lon: 2.3522 }, "default origin: Paris, Hotel de Ville");
  assertEquals(world.seed, WORLD_SEED);
  assertEquals(world.places().length, 0, "empty storage: a fresh world");
  ensureNeighbourhood(world, "max", T0);
  const keeper = keeperOf("max", 4);
  const s = newSession();
  const home = homeOf(world, "max");
  assert(home);
  s.avatar = home.id;
  s.gps = true;
  assert(applyClaim(world, s, keeper, home, T0).ok, "claim the home cell on site");
  assert(applyRelease(world, s, keeper, keeper.collection[3].id, T0 + 1000, ledger).ok, "a release seeds the ecology");
  s.gps = false;
  const arena = byKind(world, "max", "arena");
  assert(moveAvatar(world, s, "max", arena.id, T0 + 2000).ok, "virtual travel sets the engine avatar");

  assert(saveWorld(storage, world), "saved");
  assert(storage.getItem(WORLD_KEY) !== null);
  const back = loadWorld(storage, { ledger, origin: LYON });
  assertEquals(back.toJSON(), world.toJSON(), "lossless; a saved world keeps its own origin");
  assertEquals(back.territory(world.cellOf(home.pos), T0 + DAY).ownerId, "max", "territory survives");
  assertEquals(back.avatarAt("max"), arena.id, "engine avatar survives");
  assertEquals(back.spawnTable(home.pos, 13, "clear", T0 + DAY), world.spawnTable(home.pos, 13, "clear", T0 + DAY), "ecology survives");

  const bad = new MemStorage();
  bad.setItem(WORLD_KEY, "{not json");
  assertEquals(loadWorld(bad).places().length, 0, "unparseable save -> fresh world");
  assertEquals(bad.getItem(`${WORLD_KEY}.corrupt`), "{not json", "the unreadable save is kept aside");
  bad.setItem(WORLD_KEY, JSON.stringify({ ...world.toJSON(), v: 2 }));
  assertEquals(loadWorld(bad).places().length, 0, "unsupported version fails closed");
  assertEquals(loadWorld(new MemStorage(), { origin: { lat: 89, lon: 0 } }).origin, { lat: 48.8566, lon: 2.3522 }, "polar origin -> Paris");
  assertEquals(loadWorld(new MemStorage(), { origin: LYON }).origin, LYON, "a profile home becomes the origin of a new world");
  const full: StorageLike = {
    getItem: () => null,
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
    removeItem: () => undefined,
  };
  assertEquals(saveWorld(full, world), false, "a full storage reports failure instead of throwing");
});

Deno.test("[WORLD-STORE] ensureNeighbourhood generates a profile's places once: home at the origin, or at the profile's home", () => {
  const { ledger, world, places } = fixture();
  assertEquals(places.length, 29, "home + 28 places");
  assertEquals(new Set(places.map((p) => p.kind)).size, PLACE_KINDS.length, "every place kind");
  const rows = ledger.size;
  const again = ensureNeighbourhood(world, "max", T0 + DAY);
  assertEquals(again.map((p) => p.id), places.map((p) => p.id), "same places");
  assertEquals(world.places().length, 29, "second call adds nothing");
  assertEquals(ledger.size, rows, "second call logs nothing");
  const home = homeOf(world, "max");
  assert(home && home.ownerId === "max");
  assert(distXZ(home.pos, { x: 0, y: 0, z: 0 }) <= 180, "no home: the home sits at the origin (its 250 m cell centre)");

  ensureNeighbourhood(world, "sophie", T0, LYON);
  const sh = homeOf(world, "sophie");
  assert(sh && geoDistanceKm(sh, LYON) * 1000 <= 180, "a profile home anchors its neighbourhood");
  assertEquals(world.places().length, 58);
  ensureNeighbourhood(world, "sophie", T0, PARIS_HOTEL_DE_VILLE);
  assertEquals(world.places().length, 58, "an existing neighbourhood is never duplicated");

  const moved = recentreWorld(world, LYON, ledger);
  ensureNeighbourhood(moved, "max", T0);
  assertEquals(moved.places().length, 58, "after re-centring, the existing home still wins (no second neighbourhood)");

  const s = newSession();
  assertEquals(resolveAvatar(world, s, "max")?.id, home.id, "the avatar starts at home");
  s.avatar = sh.id;
  assertEquals(resolveAvatar(world, s, "max")?.id, home.id, "never someone else's home");
  s.avatar = "nowhere";
  assertEquals(resolveAvatar(world, s, "max")?.id, home.id, "unknown place -> home");
});

Deno.test("[WORLD-STORE] arenaKindForPlace is total and valid over PLACE_KINDS x every hour, and follows the place", () => {
  const hours = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
  for (let hr = -48; hr <= 72; hr += 0.25) hours.push(hr);
  for (const kind of PLACE_KINDS) {
    for (const hr of hours) assert(ARENA_KINDS.includes(arenaKindForPlace(kind, hr)), `${kind} @ ${hr}`);
  }
  const fixed: [PlaceKind, string][] = [
    ["lake", "lake"],
    ["river", "lake"],
    ["beach", "beach"],
    ["forest", "forest"],
    ["park", "meadow"],
    ["mountain", "canyon"],
    ["stadium", "city"],
    ["arena", "city"],
    ["dungeon", "crystal"],
    ["supermarket", "meadow"],
    ["home", "meadow"],
  ];
  for (const [kind, arena] of fixed) {
    for (let hr = 0; hr < 24; hr++) assertEquals(arenaKindForPlace(kind, hr), arena, `${kind} @ ${hr}h`);
  }
  const portal = new Set(Array.from({ length: 24 }, (_, hr) => arenaKindForPlace("portal", hr)));
  assert(portal.size >= 5, `the portal's far side turns with the hour (${[...portal].join(",")})`);
  assertEquals(arenaKindForPlace("portal", 3.7), arenaKindForPlace("portal", 3), "same hour, same arena");
  assertEquals(arenaKindForPlace("portal", 27), arenaKindForPlace("portal", 3), "hours wrap at 24");
  assertEquals(arenaKindForPlace("unknown" as PlaceKind, 3), "meadow", "an unknown kind from a foreign save falls back");
});

Deno.test("[WORLD-STORE] physical-only actions are refused without presence; presence = Simulated GPS on + avatar on site", () => {
  const { ledger, world } = fixture();
  for (const kind of PLACE_KINDS) {
    const place = byKind(world, "max", kind);
    for (const a of PLACE_KIND_DEFS[kind].physicalActions) {
      const off = world.actionAllowed(a, place, false, "max");
      assert(!off.ok && off.reason === `physical presence required: ${a} at a ${kind}`, `${a} @ ${kind}: ${off.reason}`);
      assert(world.actionAllowed(a, place, true, "max").ok, `${a} @ ${kind} on site`);
    }
  }
  for (const kind of PLACE_KINDS) {
    const ka = kindAction(kind);
    if (!ka) continue;
    const def = PLACE_KIND_DEFS[kind];
    assert(def.physicalActions.includes(ka.action) || def.virtualActions.includes(ka.action), `${ka.action} is offered at a ${kind}`);
    assertEquals(WORLD_ACTIONS[ka.action].physical, ka.id !== "battle", `${ka.action}: shopping and gym are physical, battles virtual`);
  }

  const gym = byKind(world, "max", "gym"), shop = byKind(world, "max", "supermarket");
  const s = newSession();
  s.avatar = gym.id;
  assert(!presentAt(s, gym.id), "GPS off: never present");
  s.gps = true;
  assert(presentAt(s, gym.id) && !presentAt(s, shop.id), "GPS on: present only where the avatar stands");

  const keeper = keeperOf("max", 4);
  const team = teamMembers(keeper);
  assertEquals(team.length, 3);
  s.gps = false;
  const xp0 = keeper.collection.map((g) => g.conditions.xp);
  const t1 = applyTrain(world, s, keeper, gym, T0, ledger);
  assert(!t1.ok && t1.reason === "physical presence required: gym.train at a gym", t1.reason);
  assertEquals(keeper.collection.map((g) => g.conditions.xp), xp0, "a refused training changes nothing");
  s.gps = true;
  const t2 = applyTrain(world, s, keeper, gym, T0, ledger);
  assert(t2.ok, t2.reason);
  keeper.collection.forEach((g, i) => assertEquals(g.conditions.xp - xp0[i], i < 3 ? EXPERIENCES.gymTraining.xp : 0, `xp of member ${i}`));

  const b1 = applyBuyFood(world, s, keeper, shop, T0, ledger);
  assert(!b1.ok && b1.reason === "physical presence required: supermarket.buy at a supermarket", `GPS on but avatar at the gym: ${b1.reason}`);
  assertEquals(ledger.query({ what: "genemon.feed" }).length, 0, "a refused purchase feeds nobody");
  s.avatar = shop.id;
  const b2 = applyBuyFood(world, s, keeper, shop, T0, ledger);
  assert(b2.ok, b2.reason);
  assertEquals(b2.fed.length, 3, "every team member eats");
  for (const f of b2.fed) assert(PLACE_FOODS.supermarket?.includes(f.food), `${f.food} is sold at the supermarket`);
  const feeds = ledger.query({ what: "genemon.feed" });
  assertEquals(feeds.length, 3);
  for (const r of feeds) assert(isValidEvent(r) && r.where.space === "physical" && r.where.zone === world.cellOf(shop.pos), "feed rows sit at the shop's cell");
  assertEquals(applyBuyFood(world, s, keeper, gym, T0, ledger).reason, "no food for sale at a gym");

  s.gps = false;
  const c1 = applyClaim(world, s, keeper, shop, T0);
  assert(!c1.ok && c1.reason === "physical presence required: territory can only be claimed on site", c1.reason);
  assertEquals(world.territory(world.cellOf(shop.pos), T0).ownerId, null);
  s.gps = true;
  assert(applyClaim(world, s, keeper, shop, T0).ok, "on site, the team's power claims the cell");
  const cell = world.territory(world.cellOf(shop.pos), T0);
  assertEquals(cell.ownerId, "max");
  assertAlmostEquals(cell.defense, teamPower(team), 1e-9, "garrison = sum of team power");
  s.gps = false;
  assert(applyDefend(world, keeper, shop, T0 + DAY).ok, "defend works from the sofa on your own cell");
  const other = keeperOf("rival", 1);
  assert(!applyDefend(world, other, shop, T0 + DAY).ok, "not on someone else's cell");
});

Deno.test("[WORLD-STORE] virtual travel reaches an arena but never a gym; Simulated GPS walks anywhere", () => {
  const { ledger, world } = fixture();
  const home = homeOf(world, "max");
  assert(home);
  const arena = byKind(world, "max", "arena"), gym = byKind(world, "max", "gym");
  const dungeon = byKind(world, "max", "dungeon"), stadium = byKind(world, "max", "stadium");
  const s = newSession();
  s.avatar = home.id;

  const toArena = moveAvatar(world, s, "max", arena.id, T0);
  assert(toArena.ok && toArena.mode === "virtual", toArena.reason);
  assertEquals(s.avatar, arena.id);
  assertEquals(world.avatarAt("max"), arena.id);
  assertEquals(ledger.query({ what: "virtual.travel" }).length, 1, "one virtual.travel row");

  const toGym = moveAvatar(world, s, "max", gym.id, T0 + 1);
  assert(!toGym.ok && toGym.reason === "a gym can only be reached physically", toGym.reason);
  assertEquals(s.avatar, arena.id, "a refused move changes nothing");
  const probe = fixture().world;
  for (const kind of PLACE_KINDS) {
    if (kind === "home") continue;
    const ps = newSession();
    resolveAvatar(probe, ps, "max");
    const m = moveAvatar(probe, ps, "max", byKind(probe, "max", kind).id, T0);
    assertEquals(m.ok, VIRTUAL_TRAVEL_KINDS.includes(kind), `GPS off, ${kind}: ${m.reason}`);
  }

  const plan = battlePlan(world, s, "max", dungeon, 13, T0 + 2);
  assert(plan.ok, plan.reason);
  assertEquals(plan.battle, { arena: "crystal", weather: "auto", hour: "real", opponent: "wild" }, "dungeon: wild swarm in the crystal grotto");
  assertEquals(s.avatar, dungeon.id, "the avatar travelled to the dungeon first");
  const rival = battlePlan(world, s, "max", stadium, 13, T0 + 3);
  assertEquals(rival.battle?.opponent, "rival");
  assertEquals(rival.battle?.arena, "city");
  assertEquals(battlePlan(world, s, "max", gym, 13, T0 + 4).ok, false, "no battles at a gym");

  const back = moveAvatar(world, s, "max", home.id, T0 + 5);
  assert(back.ok && back.mode === "return", "the avatar can always come home");
  s.gps = true;
  const walk = moveAvatar(world, s, "max", gym.id, T0 + 6);
  assert(walk.ok && walk.mode === "walk", walk.reason);
  assertEquals(s.avatar, gym.id);
  assertEquals(world.avatarAt("max"), stadium.id, "a simulated walk writes no engine travel");
  const sophie = new WorldMap({ seed: WORLD_SEED, origin: PARIS_HOTEL_DE_VILLE });
  ensureNeighbourhood(sophie, "sophie", T0);
  ensureNeighbourhood(sophie, "max", T0);
  const sophieHome = homeOf(sophie, "sophie");
  assert(sophieHome);
  assert(!moveAvatar(sophie, newSession(), "max", sophieHome.id, T0).ok, "nobody walks into someone else's home");
});

Deno.test("[WORLD-STORE] a rare spawn is never caught without presence; virtual catches stay common/uncommon in dungeons and portals", () => {
  const { ledger, world } = fixture();
  const home = homeOf(world, "max");
  assert(home);
  const dungeon = byKind(world, "max", "dungeon"), portal = byKind(world, "max", "portal"), park = byKind(world, "max", "park");
  for (const r of ["rare", "epic", "legendary"] as const) {
    const v = catchVerdict(world, dungeon, r, false, "max");
    assert(!v.ok && v.reason === `a ${r} spawn can only be caught on site`, v.reason);
  }
  assert(catchVerdict(world, dungeon, "common", false, "max").ok, "common inside a dungeon from the sofa");
  assert(catchVerdict(world, portal, "uncommon", false, "max").ok, "uncommon inside a portal from the sofa");
  const atHome = catchVerdict(world, home, "common", false, "max");
  assert(!atHome.ok && atHome.reason === "physical presence required: catch at a home", atHome.reason);
  assert(catchVerdict(world, park, "legendary", true, "max").ok, "anything on site");

  const keeper = keeperOf("max", 2);
  const s = newSession();
  s.avatar = dungeon.id;
  const spawn: Spawn = { element: "shadow", rarity: "rare", level: 20 };
  const g = wildCandidate(spawn, 42, T0);
  s.candidate = { spawn, genemon: g, placeId: dungeon.id, seed: 42, at: T0 };
  const refused = applyCatch(world, s, keeper, T0, ledger);
  assert(!refused.ok && refused.reason === "a rare spawn can only be caught on site", refused.reason);
  assertEquals(keeper.collection.length, 2, "nothing caught");
  assert(s.candidate !== null, "the spawn is still there");
  assertEquals(ledger.query({ what: /catch/ }).length, 0, "a refused catch logs nothing");

  s.gps = true;
  const caught = applyCatch(world, s, keeper, T0 + 1, ledger);
  assert(caught.ok, caught.reason);
  assertEquals(keeper.collection.length, 3);
  assert(keeper.pokedex.includes(g.genome.id), "pokedex updated");
  assertEquals(g.owner, "max");
  assertEquals(s.candidate, null);
  assertEquals(ledger.query({ what: "world.catch" }).length, 1, "on site: the ecology row");
  assert(world.influenceAt(dungeon.pos, "shadow", T0 + 1) < 0, "an on-site catch thins its element locally");
  const row = ledger.query({ what: "genemon.catch" })[0];
  assert(isValidEvent(row) && row.where.space === "physical" && (row.tags ?? []).includes("simulated-gps"), "catch row flagged as simulated GPS");

  s.gps = false;
  const spawn2: Spawn = { element: "void", rarity: "common", level: 6 };
  s.candidate = { spawn: spawn2, genemon: wildCandidate(spawn2, 43, T0), placeId: dungeon.id, seed: 43, at: T0 };
  assert(applyCatch(world, s, keeper, T0 + 2, ledger).ok, "virtual common catch in a dungeon");
  assertEquals(ledger.query({ what: "world.catch" }).length, 1, "a virtual catch writes no physical world.catch row");
  assertEquals(world.influenceAt(dungeon.pos, "void", T0 + 2), 0, "and leaves the physical ecology alone");
  assertEquals(applyCatch(world, s, keeper, T0 + 3, ledger).ok, false, "nothing left to catch");
});

Deno.test("[WORLD-STORE] wild spawns: seeded per place, hour and minute; the candidate carries the rolled level and leans to its element", () => {
  const { world } = fixture();
  const park = byKind(world, "max", "park"), school = byKind(world, "max", "school");
  assertEquals(spawnSeed(park.id, 13.2, T0), spawnSeed(park.id, 13.9, T0 + 59_000), "same place, hour and minute");
  assert(spawnSeed(park.id, 13, T0) !== spawnSeed(park.id, 13, T0 + 60_000), "next minute");
  assert(spawnSeed(park.id, 13, T0) !== spawnSeed(park.id, 14, T0), "next hour");
  assert(spawnSeed(park.id, 13, T0) !== spawnSeed(school.id, 13, T0), "another place");

  const s = newSession();
  s.avatar = park.id;
  assert(lookForWild(world, s, park, 13, "clear", T0).ok);
  const c = s.candidate;
  assert(c);
  assertEquals(phenotypeOf(c.genemon).level, c.spawn.level, "the candidate is at the rolled level");
  assertEquals(c.spawn, world.rollSpawn(park.pos, 13, "clear", T0, new Rng(spawnSeed(park.id, 13, T0))), "replayable from its seed");
  const s2 = newSession();
  s2.avatar = park.id;
  lookForWild(world, s2, park, 13, "clear", T0 + 30_000);
  assertEquals(s2.candidate?.genemon.genome.id, c.genemon.genome.id, "looking again within the minute shows the same Genemon");

  s.avatar = school.id;
  const sv = lookForWild(world, s, school, 13, "clear", T0);
  assert(!sv.ok && sv.reason.includes("sensitive"), sv.reason);
  assertEquals(s.candidate, null, "nothing spawns at a school");
  assert(!lookForWild(world, s, park, 13, "clear", T0).ok, "only where the avatar stands");

  // Measured 2026-10-12 over 40 seeds: 93-100% per element, neutral 80%; chance is 1/14.
  let total = 0;
  for (const element of ELEMENT_IDS) {
    let hits = 0;
    for (let i = 0; i < 20; i++) {
      const g = wildCandidate({ element, rarity: "common", level: 5 + i }, hashSeed("bias", element, i), T0);
      if (phenotypeOf(g).elements.primary === element) hits++;
    }
    total += hits;
    assert(hits >= 10, `${element}: ${hits}/20 candidates express the spawn element`);
  }
  assert(total / (20 * ELEMENT_IDS.length) >= 0.85, `overall ${total}/${20 * ELEMENT_IDS.length}`);
});

Deno.test("[WORLD-STORE] release needs presence, seeds its element locally and always keeps one Genemon", () => {
  const { ledger, world } = fixture();
  const home = homeOf(world, "max");
  assert(home);
  const keeper = keeperOf("max", 4);
  const [lead, second, third, target] = keeper.collection;
  keeper.team = [lead.id, second.id];
  const s = newSession();
  s.avatar = home.id;
  const el = phenotypeOf(target).elements.primary;
  const off = applyRelease(world, s, keeper, target.id, T0, ledger);
  assert(!off.ok && off.reason === "physical presence required: release at a home", off.reason);
  assertEquals(keeper.collection.length, 4);
  assertEquals(ledger.query({ what: "world.release" }).length, 0);

  s.gps = true;
  const ok = applyRelease(world, s, keeper, target.id, T0, ledger);
  assert(ok.ok, ok.reason);
  assertEquals(keeper.collection.length, 3);
  assert(!keeper.collection.some((g) => g.id === target.id), "left the collection");
  assert(world.influenceAt(home.pos, el, T0) > 0, "the released element is seeded here");
  assertEquals(ledger.query({ what: "world.release" }).length, 1);
  assertEquals(ledger.query({ what: "genemon.release" }).length, 1);

  assert(applyRelease(world, s, keeper, second.id, T0 + 1, ledger).ok, "a team member can leave while another stays");
  assertEquals(keeper.team, [lead.id], "and it leaves the team too");
  const v = applyRelease(world, s, keeper, lead.id, T0 + 2, ledger);
  assert(!v.ok && v.reason.startsWith("your team needs at least one Genemon"), v.reason);
  assert(applyRelease(world, s, keeper, third.id, T0 + 3, ledger).ok);
  const last = applyRelease(world, s, keeper, lead.id, T0 + 4, ledger);
  assert(!last.ok && last.reason === "keep at least one Genemon", last.reason);
  assertEquals(keeper.collection.map((g) => g.id), [lead.id]);

  s.avatar = byKind(world, "max", "supermarket").id;
  assertEquals(applyRelease(world, s, keeper, lead.id, T0 + 5, ledger).reason, "release is not available at a supermarket");
});

Deno.test("[WORLD-STORE] re-centring keeps every place's lat/lon, cell, terrain and territory; only the local frame moves", () => {
  const { ledger, world } = fixture();
  const home = homeOf(world, "max");
  assert(home);
  const s = newSession();
  s.avatar = home.id;
  s.gps = true;
  assert(applyClaim(world, s, keeperOf("max", 2), home, T0).ok);
  const km = geoDistanceKm(PARIS_HOTEL_DE_VILLE, LYON);
  assert(km > 380 && km < 400, `Paris-Lyon ${km.toFixed(1)} km`);
  const moved = recentreWorld(world, LYON, ledger);
  assertEquals(moved.origin, LYON);
  for (const p of world.places()) {
    const q = moved.place(p.id);
    assert(q, p.id);
    assertEquals([q.lat, q.lon], [p.lat, p.lon], "lat/lon unchanged");
    const g = moved.toGeo(q.pos);
    assertAlmostEquals(g.lat, p.lat, 1e-9, "local position re-projected");
    assertAlmostEquals(g.lon, p.lon, 1e-9, "local position re-projected");
    assertEquals(moved.cellOf(q.pos), world.cellOf(p.pos), "same global cell");
    assertAlmostEquals(moved.heightAt(q.pos.x, q.pos.z), world.heightAt(p.pos.x, p.pos.z), 1e-6, "terrain is a function of lat/lon");
  }
  const cell = world.cellOf(home.pos);
  assertEquals(moved.territory(cell, T0 + DAY), world.territory(cell, T0 + DAY), "territory unchanged");
});

Deno.test("[WORLD-STORE] shops sell from their own stock, fed food follows the eater's element; panel read models", () => {
  for (const kind of PLACE_KINDS) {
    const ka = kindAction(kind);
    if (ka?.id !== "buy") continue;
    const stock = PLACE_FOODS[kind];
    assert(stock && stock.length > 0, `${kind} has a stock`);
    for (const e of ELEMENT_IDS) assert(stock.includes(pickFood(stock, e, 7)), `${kind} sells what it feeds (${e})`);
  }
  const market = PLACE_FOODS.supermarket ?? [];
  assertEquals(pickFood(market, "fire", 0), "spicyPepper", "fire eats spicy pepper");
  assertEquals(pickFood(PLACE_FOODS.harbour ?? [], "water", 0), "fish", "water eats fish");
  assertEquals(pickFood(market, "neutral", 3), market[3], "no affinity: the salt picks");

  assertEquals(fmtDistance(850), "850 m");
  assertEquals(fmtDistance(1500), "1.5 km");
  assertEquals(fmtDistance(100, "imperial"), "328 ft");
  assertEquals(fmtDistance(5000, "imperial"), "3.1 mi");
  assertEquals(fmtDistance(Number.NaN), "-");
  assertEquals([aOrAn("gym"), aOrAn("arena"), aOrAn("office")], ["a gym", "an arena", "an office"]);

  const keeper = keeperOf("max", 4);
  const team = teamMembers(keeper);
  assertAlmostEquals(teamPower(team), team.reduce((sum, g) => sum + phenotypeOf(g).power, 0), 1e-9);
  assertEquals(teamPower([]), 0);

  const { world } = fixture();
  const park = byKind(world, "max", "park");
  const table = world.spawnTable(park.pos, 13, "clear", T0);
  const top = topSpawns(table, 6);
  assertEquals(top.length, 6);
  for (let i = 1; i < top.length; i++) assert(top[i - 1].weight >= top[i].weight, "heaviest first");
  const share = top.reduce((sum, e) => sum + e.share, 0);
  assert(share > 0 && share <= 1 + 1e-9, `shares ${share}`);
  assertEquals(topSpawns(table, 14).reduce((sum, e) => sum + e.share, 0) > 0.999, true, "the full table sums to 1");
});
