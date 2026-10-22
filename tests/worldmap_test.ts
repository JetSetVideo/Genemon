// World map: projection, neighbourhood generation, privacy, territory, physical vs virtual,
// ecology-driven spawns, ledger rows and persistence. Bounds are named [WORLD-*] after docs/WORLD.md.
import { assert, assertAlmostEquals, assertEquals, assertThrows } from "./_assert.ts";
import { type GEvent, isValidEvent, Ledger } from "../src/core/ledger.ts";
import { r3, type V3 } from "../src/core/math.ts";
import { Rng } from "../src/core/rng.ts";
import { ELEMENT_IDS, type ElementId } from "../src/data/elements.ts";
import { GROUND_IDS } from "../src/data/grounds.ts";
import { EXPERIENCES } from "../src/data/lifestyle.ts";
import {
  catchAllowed,
  PLACE_KIND_DEFS,
  PLACE_KINDS,
  type Place,
  type PlaceKind,
  RARITIES,
  type SpawnEntry,
  VIRTUAL_TRAVEL_KINDS,
  WORLD_ACTIONS,
  WORLD_TUNING,
  WorldMap,
} from "../src/world/worldmap.ts";

const PARIS = { lat: 48.8566, lon: 2.3522 };
/** Fixed clock (never Date.now() in logic or tests). */
const T0 = Date.UTC(2026, 9, 12, 12, 0, 0);
const DAY = 86_400_000;
const R = 6_371_008.8;
const RAD = Math.PI / 180;
/** Open ground far from any generated place. */
const OPEN: V3 = { x: 9000, y: 0, z: -9000 };

function haversine(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const s1 = Math.sin(((b.lat - a.lat) * RAD) / 2), s2 = Math.sin(((b.lon - a.lon) * RAD) / 2);
  const h = s1 * s1 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * s2 * s2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Exact great-circle destination (the truth the projection is measured against). */
function destination(o: { lat: number; lon: number }, meters: number, bearingDeg: number) {
  const d = meters / R, la1 = o.lat * RAD, br = bearingDeg * RAD;
  const la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(br));
  const lo2 = o.lon * RAD + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(la1), Math.cos(d) - Math.sin(la1) * Math.sin(la2));
  let lon = lo2 / RAD;
  if (lon > 180) lon -= 360;
  if (lon <= -180) lon += 360;
  return { lat: la2 / RAD, lon };
}

const weight = (t: SpawnEntry[], e: ElementId) => t.find((x) => x.element === e)!.weight;
const byKind = (places: Place[], kind: PlaceKind) => places.find((p) => p.kind === kind)!;

Deno.test("[WORLD-PROJ] ENU round trip error < 1 m at 5 km; projected distance error < 2 m at 5 km", () => {
  const origins = [PARIS, { lat: -33.87, lon: 151.21 }, { lat: 60.17, lon: 24.94 }, { lat: 0.5, lon: 179.99 }];
  for (const origin of origins) {
    const m = new WorldMap({ seed: 1, origin });
    for (let b = 0; b < 360; b += 30) {
      const g = destination(origin, 5000, b);
      const p = m.toLocal(g.lat, g.lon, 35);
      const back = m.toGeo(p);
      const rt = haversine(g, back);
      assert(rt < 1, `round trip ${rt} m at ${JSON.stringify(origin)} bearing ${b}`);
      assertAlmostEquals(back.alt, 35, 1e-9, "altitude passes through");
      const again = m.toLocal(back.lat, back.lon, back.alt);
      assert(Math.hypot(again.x - p.x, again.z - p.z) < 1e-6, "local -> geo -> local is exact");
      // Equirectangular distortion vs the great circle (measured max 1.28 m at 60 deg, see docs/WORLD.md).
      const err = Math.abs(Math.hypot(p.x, p.z) - 5000);
      assert(err < 2, `projection error ${err.toFixed(3)} m at ${origin.lat} deg bearing ${b}`);
    }
  }
  // Axes: x = east, z = north, y = up.
  const m = new WorldMap({ seed: 1, origin: PARIS });
  const north = m.toLocal(PARIS.lat + 0.01, PARIS.lon), east = m.toLocal(PARIS.lat, PARIS.lon + 0.01);
  assert(north.z > 1000 && Math.abs(north.x) < 1e-6, "z grows northward");
  assert(east.x > 500 && Math.abs(east.z) < 1e-6, "x grows eastward");
  assertThrows(() => new WorldMap({ seed: 1, origin: { lat: 89, lon: 0 } }), "polar origin refused");
  assertThrows(() => new WorldMap({ seed: Number.NaN, origin: PARIS }), "NaN seed refused");
});

Deno.test("[WORLD-GEN] neighbourhood is deterministic per seed+owner and has a supermarket and a gym within 3 km", () => {
  const home: V3 = { x: 420, y: 0, z: -310 };
  const a = new WorldMap({ seed: 2026, origin: PARIS }).generateNeighbourhood("ana", home);
  const b = new WorldMap({ seed: 2026, origin: PARIS }).generateNeighbourhood("ana", home);
  assertEquals(a, b, "same seed + owner + home");
  const other = new WorldMap({ seed: 2026, origin: PARIS }).generateNeighbourhood("ben", home);
  assert(JSON.stringify(other.map((p) => p.pos)) !== JSON.stringify(a.map((p) => p.pos)), "another owner, another layout");
  const reseeded = new WorldMap({ seed: 7, origin: PARIS }).generateNeighbourhood("ana", home);
  assert(JSON.stringify(reseeded.map((p) => p.pos)) !== JSON.stringify(a.map((p) => p.pos)), "another world seed, another layout");

  const h = a[0];
  assertEquals(h.kind, "home");
  assertEquals(h.ownerId, "ana");
  for (const kind of ["supermarket", "gym"] as const) {
    const d = a.filter((p) => p.kind === kind).map((p) => haversine(h, p));
    assert(d.length >= 1 && Math.min(...d) <= 3000, `${kind} within 3 km (got ${d.map(Math.round)})`);
  }
  assertEquals(new Set(a.map((p) => p.kind)).size, PLACE_KINDS.length, "every kind appears");
  for (const p of a.slice(1)) {
    const d = haversine(h, p);
    assert(d >= 150 && d <= 2500, `${p.kind} at a plausible ${d.toFixed(0)} m`);
    assertEquals(p.ownerId, null, "public places are never owned");
    assertEquals(p.ground, PLACE_KIND_DEFS[p.kind].ground);
    assertAlmostEquals(p.pos.y, new WorldMap({ seed: 2026, origin: PARIS }).heightAt(p.pos.x, p.pos.z), 1e-6, "on the terrain");
  }
  assert(byKind(a, "lake").pos.y < byKind(a, "mountain").pos.y, "the lake sits below the mountain");
  assert(haversine(byKind(a, "beach"), byKind(a, "lake")) < 200 + 150 + 45, "the beach is on the lake shore");

  const m = new WorldMap({ seed: 2026, origin: PARIS });
  const first = m.generateNeighbourhood("ana", home);
  const count = m.places().length;
  assertEquals(m.generateNeighbourhood("ana", home), first, "idempotent");
  assertEquals(m.places().length, count, "no duplicates on regeneration");
});

Deno.test("[WORLD-PRIVACY] the exact home never enters the map; output depends only on the coarse home cell", () => {
  const m = new WorldMap({ seed: 9, origin: PARIS });
  const exact: V3 = { x: 1234.5, y: 0, z: -987.25 };
  const hood = m.generateNeighbourhood("ana", exact);
  const home = hood[0];
  const off = Math.hypot(home.pos.x - exact.x, home.pos.z - exact.z);
  assert(off > 0, "the home is snapped, not stored as given");
  assert(off <= (WORLD_TUNING.homeGridM * Math.SQRT2) / 2 + 1e-6, `snapped within the cell (${off.toFixed(1)} m)`);
  assert(off <= home.radius, "standing at the real home always counts as being at home");
  assert(WORLD_TUNING.homeRadiusM >= (WORLD_TUNING.homeGridM * Math.SQRT2) / 2, "home radius covers the whole grid cell");

  // Any home inside the same coarse cell yields the identical neighbourhood: nothing leaks the exact spot.
  const nearby: V3 = { x: (exact.x + home.pos.x) / 2, y: 0, z: (exact.z + home.pos.z) / 2 };
  assertEquals(new WorldMap({ seed: 9, origin: PARIS }).generateNeighbourhood("ana", nearby), hood);

  const json = JSON.stringify(m.toJSON());
  const g = m.toGeo(exact);
  for (const leak of [String(exact.x), String(exact.z), g.lat.toFixed(6), g.lon.toFixed(6)]) {
    assert(!json.includes(leak), `saved state leaks ${leak}`);
  }

  // A second client with another origin rebuilds the same places at the same lat/lon (shared world).
  const far = new WorldMap({ seed: 9, origin: { lat: PARIS.lat + 0.03, lon: PARIS.lon - 0.04 } });
  const hood2 = far.generateNeighbourhood("ana", far.toLocal(g.lat, g.lon));
  assertEquals(hood2.map((p) => p.id), hood.map((p) => p.id));
  hood2.forEach((p, i) => {
    assertAlmostEquals(p.lat, hood[i].lat, 1e-9, `${p.kind} lat`);
    assertAlmostEquals(p.lon, hood[i].lon, 1e-9, `${p.kind} lon`);
    assertAlmostEquals(p.pos.y, hood[i].pos.y, 1e-6, `${p.kind} altitude`);
    assertEquals(far.cellOf(p.pos), m.cellOf(hood[i].pos), `${p.kind} cell id`);
  });
});

Deno.test("[WORLD-CLAIM] a claim without physical presence is denied with a reason", () => {
  const ledger = new Ledger("claim");
  const m = new WorldMap({ seed: 3, origin: PARIS, ledger });
  const v = m.claim("ana", OPEN, 100, T0, false);
  assertEquals(v.ok, false);
  assert(v.reason.includes("physical presence"), v.reason);
  assertEquals(m.territory(m.cellOf(OPEN)).ownerId, null);
  assertEquals(ledger.size, 0, "a denied sofa claim changes nothing and logs nothing");
  assertEquals(m.claim("ana", OPEN, 0, T0, true).ok, false, "zero power");
  assertEquals(m.claim("ana", OPEN, Number.NaN, T0, true).ok, false, "NaN power");

  const ok = m.claim("ana", OPEN, 100, T0, true);
  assert(ok.ok, ok.reason);
  const t = m.territory(m.cellOf(OPEN));
  assertEquals([t.ownerId, t.defense, t.claimedAt], ["ana", 100, T0]);
  assertEquals(ledger.query({ what: "world.claim" }).length, 1);
});

Deno.test("[WORLD-CLAIM] a contested claim needs strictly more power than the defense", () => {
  const ledger = new Ledger("contest");
  const m = new WorldMap({ seed: 3, origin: PARIS, ledger });
  const cell = m.cellOf(OPEN);
  assert(m.claim("ana", OPEN, 100, T0, true).ok);

  const tie = m.claim("ben", OPEN, 100, T0, true);
  assertEquals(tie.ok, false);
  assert(tie.reason.includes("contested") && tie.reason.includes("100"), tie.reason);
  assertEquals(m.territory(cell).ownerId, "ana", "equal power does not take the cell");

  const win = m.claim("ben", { x: OPEN.x + 20, y: 0, z: OPEN.z - 20 }, 100.5, T0, true);
  assert(win.ok, win.reason);
  assertEquals(m.territory(cell).ownerId, "ben");
  assertEquals(m.territory(cell).defense, 100.5, "the winner garrisons the cell at full power");

  const raids = ledger.query({ what: "world.raid" });
  assertEquals(raids.map((r) => r.exits.won), [false, true]);
  assertEquals(raids.map((r) => [r.who, r.to]), [["ben", "ana"], ["ben", "ana"]]);
  const defences = ledger.query({ what: "world.defend" });
  assertEquals(defences.map((r) => [r.who, r.exits.won]), [["ana", true], ["ana", false]]);
  const claims = ledger.query({ what: "world.claim" });
  assertEquals(claims.map((r) => [r.who, r.entries.contested]), [["ana", false], ["ben", true]]);

  // Re-claiming your own cell reinforces it and never logs another world.claim (claims are not farmable).
  const self = m.claim("ben", OPEN, 50, T0 + 1000, true);
  assert(self.ok && self.reason.startsWith("already yours"), self.reason);
  assertEquals(ledger.query({ what: "world.claim" }).length, 2);
});

Deno.test("[WORLD-DECAY] garrisons decay, lapsed cells are free again, home cells keep a floor", () => {
  const m = new WorldMap({ seed: 3, origin: PARIS });
  const cell = m.cellOf(OPEN);
  m.claim("ana", OPEN, 100, T0, true);
  const half = WORLD_TUNING.defenseHalfLifeMs;
  assertAlmostEquals(m.territory(cell, T0 + half).defense, 50, 1e-9, "one half-life");
  assertEquals(m.territory(cell).defense, 100, "the stored snapshot is untouched by reads");
  assertEquals(m.claim("ben", OPEN, 49, T0 + half, true).ok, false, "49 < 50");
  assert(m.claim("ben", OPEN, 51, T0 + half, true).ok, "a weakened garrison falls");

  const m2 = new WorldMap({ seed: 3, origin: PARIS });
  m2.claim("ana", OPEN, 100, T0, true);
  const late = T0 + 8 * half; // 100 / 2^8 < lapseDefense
  assertEquals(m2.territory(cell, late).ownerId, null, "lapsed");
  const free = m2.claim("ben", OPEN, 5, late, true);
  assert(free.ok && free.reason.includes("lapsed"), free.reason);

  const m3 = new WorldMap({ seed: 4, origin: PARIS });
  const home = m3.generateNeighbourhood("ana", { x: 0, y: 0, z: 0 }, T0)[0];
  const homeCell = m3.cellOf(home.pos);
  assert(m3.claim("ana", home.pos, 250, T0, true).ok);
  const much = T0 + 60 * DAY;
  assertAlmostEquals(m3.territory(homeCell, much).defense, WORLD_TUNING.homeDefense, 1e-9, "home floor");
  assertEquals(m3.claim("ben", home.pos, WORLD_TUNING.homeDefense - 1, much, true).ok, false);
  assert(m3.claim("ben", home.pos, WORLD_TUNING.homeDefense + 1, much, true).ok, "a home cell can still be raided");
  const twoHalfLives = much + 2 * half;
  assertAlmostEquals(m3.territory(homeCell, twoHalfLives).defense, 101 / 4, 1e-9, "no floor for a raider: below 100");
  assertEquals(m3.territory(homeCell, much + 60 * DAY).ownerId, null, "an occupier's hold lapses like any other");
});

Deno.test("[WORLD-DEFEND] only the owner reinforces; garrison = max(decayed, power) and the clock restarts", () => {
  const ledger = new Ledger("defend");
  const m = new WorldMap({ seed: 5, origin: PARIS, ledger });
  const cell = m.cellOf(OPEN);
  m.claim("ana", OPEN, 100, T0, true);
  const half = WORLD_TUNING.defenseHalfLifeMs;

  const intruder = m.defend("ben", cell, 500, T0);
  assert(!intruder.ok && intruder.reason.includes("not your territory"), intruder.reason);
  const empty = m.defend("ana", m.cellOf({ x: OPEN.x + 5000, y: 0, z: OPEN.z }), 10, T0);
  assert(!empty.ok && empty.reason.includes("unclaimed"), empty.reason);
  assertEquals(m.defend("ana", "not-a-cell", 10, T0).ok, false);
  assertEquals(m.defend("ana", cell, -3, T0).ok, false);

  const refresh = m.defend("ana", cell, 30, T0 + half);
  assert(refresh.ok && refresh.reason.includes("refreshed"), refresh.reason);
  assertAlmostEquals(m.territory(cell, T0 + half).defense, 50, 1e-9, "weak reinforcements never lower the garrison");
  assertAlmostEquals(m.territory(cell, T0 + 2 * half).defense, 25, 1e-9, "decay restarted from the refresh");
  assert(m.defend("ana", cell, 200, T0 + 2 * half).ok);
  assertAlmostEquals(m.territory(cell, T0 + 2 * half).defense, 200, 1e-9);
  const rows = ledger.query({ what: "territory.reinforce" });
  assertEquals(rows.length, 2);
  assertEquals(rows[1].exits.defense, 200);
});

Deno.test("[WORLD-VIRTUAL] virtual travel to a gym is denied, to an arena allowed", () => {
  const m = new WorldMap({ seed: 6, origin: PARIS });
  const hood = m.generateNeighbourhood("ana", { x: 0, y: 0, z: 0 }, T0);
  const gym = byKind(hood, "gym"), arena = byKind(hood, "arena");

  const denied = m.travelVirtual("ana", gym.id, T0);
  assertEquals(denied.ok, false);
  assert(denied.reason.includes("physically"), denied.reason);
  assertEquals(m.avatarAt("ana"), null);

  const ok = m.travelVirtual("ana", arena.id, T0 + 1);
  assert(ok.ok, ok.reason);
  assertEquals(m.avatarAt("ana"), arena.id);
  assertEquals(m.travelVirtual("ana", arena.id, T0 + 2).reason, "already there");
  assertEquals(m.travelVirtual("ana", "nowhere", T0).ok, false);

  assertEquals([...VIRTUAL_TRAVEL_KINDS].sort(), ["arena", "dungeon", "library", "museum", "portal", "stadium"]);
  for (const p of hood) {
    assertEquals(m.travelVirtual("zed", p.id, T0).ok, VIRTUAL_TRAVEL_KINDS.includes(p.kind), `virtual travel to ${p.kind}`);
  }
});

Deno.test("[WORLD-ACTION] physical actions need presence, virtual ones do not; private places need their owner", () => {
  const m = new WorldMap({ seed: 6, origin: PARIS });
  const hood = m.generateNeighbourhood("ana", { x: 0, y: 0, z: 0 }, T0);
  const gym = byKind(hood, "gym"), arena = byKind(hood, "arena"), home = hood[0], school = byKind(hood, "school");

  const sofa = m.actionAllowed("gym.train", gym, false);
  assert(!sofa.ok && sofa.reason.includes("physical presence"), sofa.reason);
  assert(m.actionAllowed("gym.train", gym, true).ok);
  assert(m.actionAllowed("battle.ranked", arena, false).ok, "arena battles from the sofa");
  assert(m.actionAllowed("supermarket.buy", byKind(hood, "supermarket"), true).ok);
  assertEquals(m.actionAllowed("supermarket.bonus", byKind(hood, "supermarket"), false).ok, false);
  const wrong = m.actionAllowed("gym.train", arena, true);
  assert(!wrong.ok && wrong.reason.includes("not available"), wrong.reason);

  assert(!m.actionAllowed("home.rest", home, true).ok, "private place without an actor fails closed");
  assert(m.actionAllowed("home.rest", home, true, "ana").ok);
  assert(m.actionAllowed("home.manage", home, false, "ana").ok, "the owner manages the home remotely");
  assert(!m.actionAllowed("home.rest", home, true, "ben").ok);
  assert(!m.actionAllowed("home.rest", { ...home, ownerId: null }, true).ok, "the stored place wins over a forged copy");
  assertEquals(m.actionAllowed("catch", school, true).ok, false, "no catching at a school");

  // Registry: every listed action exists, is physical everywhere or virtual everywhere, lists are disjoint.
  for (const k of PLACE_KINDS) {
    const d = PLACE_KIND_DEFS[k];
    assertEquals(d.kind, k);
    assert(d.radius >= 35, `${k} radius fits a GPS accuracy disc`);
    for (const a of d.physicalActions) assert(WORLD_ACTIONS[a].physical, `${k}: ${a} listed as physical`);
    for (const a of d.virtualActions) assert(!WORLD_ACTIONS[a].physical, `${k}: ${a} listed as virtual`);
    assert(d.physicalActions.every((a) => !(d.virtualActions as string[]).includes(a)), `${k}: lists overlap`);
    assert(d.virtualActions.length === 0 || d.virtualTravel || k === "home", `${k}: virtual actions need a virtual way in`);
  }
  for (const [action, exp] of [["gym.train", "gymTraining"], ["climb", "climbing"], ["sunbathe", "sunbathing"], ["rescue", "rescue"]] as const) {
    assertEquals(WORLD_ACTIONS[action].physical, EXPERIENCES[exp].physicalOnly, `${action} matches EXPERIENCES.${exp}`);
  }
  assert(WORLD_ACTIONS["world.claim"].physical && WORLD_ACTIONS.catch.physical && !WORLD_ACTIONS["catch.virtual"].physical);

  assertEquals(catchAllowed("rare", false).ok, false);
  assert(catchAllowed("rare", false).reason.includes("on site"));
  assert(catchAllowed("uncommon", false).ok, "common/uncommon from the virtual space");
  assert(catchAllowed("legendary", true).ok);
});

Deno.test("[WORLD-DISCOVER] check-ins count every on-site visit; remote discovery only for virtual-travel kinds", () => {
  const ledger = new Ledger("disc");
  const m = new WorldMap({ seed: 8, origin: PARIS, ledger });
  const hood = m.generateNeighbourhood("ana", { x: 0, y: 0, z: 0 }, T0);
  const gym = byKind(hood, "gym"), arena = byKind(hood, "arena");

  const first = m.discover("ana", gym.id, T0, true, { hour: 23, weather: "rain" });
  assert(first.ok && first.firstVisit, first.reason);
  const again = m.discover("ana", gym.id, T0 + DAY, true);
  assert(again.ok && !again.firstVisit);
  const remote = m.discover("ben", gym.id, T0, false);
  assert(!remote.ok && remote.reason.includes("physical presence"), remote.reason);
  assertEquals(m.place(gym.id)!.discoveredBy, ["ana"]);

  assertEquals(m.discover("ben", arena.id, T0, false).reason, "discovered virtually");
  const onSite = m.discover("ben", arena.id, T0 + 5, true);
  assert(onSite.firstVisit, "a virtual discovery does not consume the on-site first visit");
  assertEquals(m.discover("ben", hood[0].id, T0, true).ok, false, "nobody else checks in at a home");
  assertEquals(m.discover("ana", "missing", T0, true).ok, false);

  const visits = ledger.query({ what: "world.visit" });
  assertEquals(visits.length, 3);
  assertEquals(visits[0].entries, { poi: "gym", place: gym.id, firstVisit: true, discovered: true, hour: 23, night: true, weather: "rain" });
  assertEquals([visits[1].entries.firstVisit, visits[1].entries.weather], [false, undefined]);
  assertEquals(ledger.query({ what: "virtual.discover" }).length, 1);
});

Deno.test("[WORLD-ECO] a release raises that element's spawn weight on the spot, then decays; catches deplete", () => {
  const m = new WorldMap({ seed: 11, origin: PARIS });
  const base = m.spawnTable(OPEN, 12, "clear", T0);
  assertEquals(m.release("ana", "ice", OPEN, T0), WORLD_TUNING.releaseInfluence);
  const after = m.spawnTable(OPEN, 12, "clear", T0);
  assert(weight(after, "ice") > weight(base, "ice") * 1.2, `ice ${weight(base, "ice")} -> ${weight(after, "ice")}`);
  for (const e of ELEMENT_IDS) if (e !== "ice") assertEquals(weight(after, e), weight(base, e), `${e} untouched`);

  const later = m.spawnTable(OPEN, 12, "clear", T0 + 10 * DAY);
  const gainNow = weight(after, "ice") - weight(base, "ice"), gainLater = weight(later, "ice") - weight(base, "ice");
  assert(gainLater > 0 && gainLater < 0.1 * gainNow, `decays toward the baseline (${gainNow} -> ${gainLater})`);
  const half = WORLD_TUNING.influenceHalfLifeMs;
  assertAlmostEquals(m.influenceAt(OPEN, "ice", T0 + half) / m.influenceAt(OPEN, "ice", T0), 0.5, 1e-9, "half-life");

  for (let i = 0; i < 8; i++) m.catchAt("ana", "water", OPEN, T0);
  assert(weight(m.spawnTable(OPEN, 12, "clear", T0), "water") < weight(base, "water"), "over-catching depletes water");

  const elsewhere: V3 = { x: OPEN.x + 1000, y: 0, z: OPEN.z };
  m.release("ben", "fire", elsewhere, T0);
  assertEquals(weight(m.spawnTable(OPEN, 12, "clear", T0), "fire"), weight(base, "fire"), "1 km away is another ecology");
  for (let i = 0; i < 50; i++) m.release("ana", "void", OPEN, T0);
  const v = m.territory(m.cellOf(OPEN)).influence.void!;
  assertEquals(v, WORLD_TUNING.influenceCap, "influence is capped");
  assertThrows(() => m.release("ana", "lava" as ElementId, OPEN, T0), "unknown element refused");
});

Deno.test("[WORLD-SPAWN] the night table favours shadow over light; weather and places shift the mix", () => {
  const m = new WorldMap({ seed: 12, origin: PARIS });
  const night = m.spawnTable(OPEN, 1, "clear", T0), noon = m.spawnTable(OPEN, 13, "clear", T0);
  assertEquals(night.map((e) => e.element), [...ELEMENT_IDS]);
  assert(night.every((e) => e.weight > 0 && Number.isFinite(e.weight)), "every element stays possible");
  assert(weight(night, "shadow") > weight(night, "light"), "night: shadow > light");
  assert(weight(noon, "light") > weight(noon, "shadow"), "day: light > shadow");
  for (const e of ["shadow", "void", "psychic"] as const) assert(weight(night, e) > weight(noon, e), `${e} rises at night`);
  for (const e of ["light", "fire", "plant"] as const) assert(weight(noon, e) > weight(night, e), `${e} rises by day`);
  assertEquals(m.spawnTable(OPEN, 25, "clear", T0), m.spawnTable(OPEN, 1, "clear", T0), "hours wrap");

  const rain = m.spawnTable(OPEN, 13, "rain", T0);
  assert(weight(rain, "water") > weight(noon, "water") && weight(rain, "electric") > weight(noon, "electric"));
  assert(weight(rain, "fire") < weight(noon, "fire"));

  const hood = m.generateNeighbourhood("ana", { x: 0, y: 0, z: 0 }, T0);
  const lake = m.spawnTable(byKind(hood, "lake").pos, 13, "clear", T0);
  assert(weight(lake, "water") > 2 * weight(lake, "fire"), "a lake teems with water types");
  const gymTable = m.spawnTable(byKind(hood, "gym").pos, 13, "clear", T0);
  assert(weight(gymTable, "metal") > weight(noon, "metal"), "the gym attracts metal");
});

Deno.test("[WORLD-SPAWN] rollSpawn replays from its seed; rarity responds to night, weather and wild places", () => {
  const m = new WorldMap({ seed: 13, origin: PARIS });
  const roll = (seed: number) => {
    const rng = new Rng(seed);
    return Array.from({ length: 50 }, () => m.rollSpawn(OPEN, 9, "fog", T0, rng));
  };
  assertEquals(roll(77), roll(77));
  assert(JSON.stringify(roll(77)) !== JSON.stringify(roll(78)));
  for (const s of roll(5)) {
    assert(ELEMENT_IDS.includes(s.element) && RARITIES.includes(s.rarity) && s.level >= 1 && s.level <= 100, JSON.stringify(s));
  }
  const rareShare = (hour: number, weather: "clear" | "aurora") => {
    const rng = new Rng(4242);
    let rare = 0;
    for (let i = 0; i < 3000; i++) {
      const r = m.rollSpawn(OPEN, hour, weather, T0, rng).rarity;
      if (r === "rare" || r === "epic" || r === "legendary") rare++;
    }
    return rare / 3000;
  };
  const calm = rareShare(13, "clear"), wild = rareShare(1, "aurora");
  assert(calm > 0.05 && calm < 0.2, `baseline rare+ share ${calm}`);
  assert(wild > 1.5 * calm, `aurora night ${wild} vs clear noon ${calm}`);
});

Deno.test("[WORLD-SENSITIVE] schools and hospitals: visit only, never claimed, flagged for spawners", () => {
  const m = new WorldMap({ seed: 14, origin: PARIS });
  const hood = m.generateNeighbourhood("ana", { x: 0, y: 0, z: 0 }, T0);
  const school = byKind(hood, "school");
  const v = m.claim("ana", school.pos, 1000, T0, true);
  assert(!v.ok && v.reason.includes("sensitive"), v.reason);
  assertEquals(m.sensitivePlaceAt(school.pos)?.kind, "school");
  assertEquals(m.sensitivePlaceAt(OPEN), null);
  const hospital = m.addPlace({ kind: "hospital", pos: { x: OPEN.x, y: 0, z: OPEN.z }, name: "St. Test" }, T0);
  assert(!m.claim("ana", { x: OPEN.x + 30, y: 0, z: OPEN.z }, 1000, T0, true).ok, "inside the hospital disc");
  assertEquals(m.sensitivePlaceAt(hospital.pos)?.name, "St. Test");
  for (const k of ["school", "hospital"] as const) {
    const d = PLACE_KIND_DEFS[k];
    assert(d.sensitive && d.physicalActions.join() === "visit" && d.virtualActions.length === 0, k);
    assertEquals(Object.keys(d.elementBias).length, 0, `${k} has no spawn lure`);
  }
  assertThrows(() => m.addPlace({ kind: "home", pos: OPEN }), "homes only via generateNeighbourhood");
  assertThrows(() => m.addPlace({ kind: "cafe", pos: { x: 1, y: 0, z: 1 }, radius: 5 }), "a 5 m place cannot hold a GPS fix");
  assertThrows(() => m.addPlace({ kind: "hospital", pos: { x: OPEN.x, y: 0, z: OPEN.z } }), "duplicate id");
});

Deno.test("[WORLD-CELL] cells are a global ~cellSize grid: same ids on every client whatever its origin", () => {
  const a = new WorldMap({ seed: 1, origin: PARIS });
  const b = new WorldMap({ seed: 1, origin: { lat: PARIS.lat + 0.05, lon: PARIS.lon + 0.07 } });
  const rng = new Rng(3);
  for (let i = 0; i < 300; i++) {
    const p: V3 = { x: rng.range(-5000, 5000), y: 0, z: rng.range(-5000, 5000) };
    const id = a.cellOf(p);
    assert(/^100:\d+:\d+$/.test(id), id);
    const g = a.toGeo(p);
    assertEquals(b.cellOf(b.toLocal(g.lat, g.lon)), id, "origin-independent id");
    assertEquals(a.cellOf(a.cellCenter(id)), id, "the centre lies in its own cell");
    const c = a.cellCenter(id);
    assert(Math.abs(c.x - p.x) <= 50.01 && Math.abs(c.z - p.z) <= 50.01, "cells are at most 100 m on a side");
  }
  // Walking 10 m at a time crosses a boundary at least every 100 m.
  let changes = 0, prev = a.cellOf({ x: 0, y: 0, z: 0 });
  for (let x = 10; x <= 1000; x += 10) {
    const id = a.cellOf({ x, y: 0, z: 0 });
    if (id !== prev) changes++;
    prev = id;
  }
  assert(changes >= 10 && changes <= 11, `${changes} boundaries in 1 km`);
  assert(new WorldMap({ seed: 1, origin: PARIS, cellSize: 250 }).cellOf(OPEN).startsWith("250:"));
  assertThrows(() => a.territory("garbage"), "bad id refused");
});

Deno.test("[WORLD-TERRAIN] heightAt and groundAt are deterministic, bounded and shared across origins", () => {
  const a = new WorldMap({ seed: 21, origin: PARIS });
  const b = new WorldMap({ seed: 21, origin: { lat: PARIS.lat - 0.02, lon: PARIS.lon + 0.03 } });
  const c = new WorldMap({ seed: 22, origin: PARIS });
  let differs = 0;
  for (let i = 0; i < 200; i++) {
    const x = (i % 20) * 450 - 4500, z = Math.floor(i / 20) * 450 - 2250;
    const h = a.heightAt(x, z);
    assert(Number.isFinite(h) && Math.abs(h) < 100, `height ${h}`);
    assertEquals(a.heightAt(x, z), h, "deterministic");
    const g = a.toGeo({ x, y: 0, z });
    const q = b.toLocal(g.lat, g.lon);
    assertAlmostEquals(b.heightAt(q.x, q.z), h, 1e-6, "same terrain from another origin");
    if (Math.abs(c.heightAt(x, z) - h) > 1) differs++;
    assert(GROUND_IDS.includes(a.groundAt({ x, y: 0, z })));
  }
  assert(differs > 150, "another world seed, another terrain");
});

Deno.test("[WORLD-LEDGER] every state change emits one valid flat row at a cell centre, never a raw position", () => {
  const ledger = new Ledger("world");
  const m = new WorldMap({ seed: 15, origin: PARIS, ledger });
  const hood = m.generateNeighbourhood("ana", { x: 333, y: 0, z: 444 }, T0);
  const gym = byKind(hood, "gym"), arena = byKind(hood, "arena");
  m.discover("ana", gym.id, T0 + 1, true);
  m.discover("ben", arena.id, T0 + 2, false);
  m.claim("ana", OPEN, 80, T0 + 3, true);
  m.claim("ben", OPEN, 90, T0 + 4, true);
  m.defend("ben", m.cellOf(OPEN), 120, T0 + 5);
  m.travelVirtual("ben", arena.id, T0 + 6);
  m.release("ana", "plant", OPEN, T0 + 7);
  m.catchAt("ben", "plant", OPEN, T0 + 8);
  m.addPlace({ kind: "plaza", pos: { x: -7000, y: 0, z: 7000 } }, T0 + 9);

  const before = ledger.size;
  m.claim("ana", OPEN, 999, T0 + 10, false);
  m.travelVirtual("ana", gym.id, T0 + 10);
  m.defend("zed", m.cellOf(OPEN), 1, T0 + 10);
  assertEquals(ledger.size, before, "denied actions change nothing and log nothing");

  const whats = [
    "map.neighbourhood",
    "world.visit",
    "virtual.discover",
    "world.claim",
    "world.raid",
    "world.defend",
    "territory.reinforce",
    "virtual.travel",
    "world.release",
    "world.catch",
    "map.place",
  ];
  for (const what of whats) assert(ledger.query({ what }).length >= 1, `missing ${what}`);
  for (const row of ledger.rows() as GEvent[]) {
    assert(isValidEvent(row), `invalid row ${row.what}`);
    assert(row.tags?.includes("world"), row.what);
    const c = m.cellCenter(row.where.zone);
    assertEquals([row.where.x, row.where.y, row.where.z], [r3(c.x), r3(c.y), r3(c.z)], `${row.what} snapped to its cell centre`);
    for (const key of [...Object.keys(row.entries), ...Object.keys(row.exits)]) {
      assert(!["lat", "lon", "x", "z", "pos"].includes(key), `${row.what} carries a raw position in ${key}`);
    }
    if (row.what.startsWith("world.")) assertEquals(row.where.space, "physical", `${row.what} is a GPS row`);
    if (row.what.startsWith("virtual.")) assertEquals(row.where.space, "virtual", row.what);
    assert(row.when >= T0, "rows carry the caller's clock");
  }
});

Deno.test("[WORLD-JSON] toJSON/fromJSON round-trips the whole world and fails closed on bad data", () => {
  const m = new WorldMap({ seed: 16, origin: PARIS });
  const hood = m.generateNeighbourhood("ana", { x: -200, y: 0, z: 150 }, T0);
  m.discover("ana", byKind(hood, "park").id, T0, true);
  m.claim("ana", OPEN, 70, T0, true);
  m.release("ana", "light", OPEN, T0);
  m.catchAt("ben", "earth", OPEN, T0);
  m.travelVirtual("ben", byKind(hood, "portal").id, T0);

  const json = JSON.parse(JSON.stringify(m));
  const back = WorldMap.fromJSON(json);
  assertEquals(back.toJSON(), m.toJSON());
  assertEquals(back.spawnTable(OPEN, 2, "fog", T0 + DAY), m.spawnTable(OPEN, 2, "fog", T0 + DAY));
  assertEquals(back.claim("cid", OPEN, 60, T0 + 3 * DAY, true), m.claim("cid", OPEN, 60, T0 + 3 * DAY, true));
  assertEquals(back.avatarAt("ben"), byKind(hood, "portal").id);
  assertEquals(back.generateNeighbourhood("ana", { x: -200, y: 0, z: 150 }), m.generateNeighbourhood("ana", { x: -200, y: 0, z: 150 }));

  const good = m.toJSON();
  assertThrows(() => WorldMap.fromJSON({ ...good, v: 2 }), "version");
  assertThrows(() => WorldMap.fromJSON({ ...good, places: [{ ...good.places[0], kind: "volcano" }] }), "place kind");
  assertThrows(() => WorldMap.fromJSON({ ...good, territories: [{ ...good.territories[0], cellId: "250:1:1" }] }), "cell size");
  assertThrows(() => WorldMap.fromJSON({ ...good, territories: [{ ...good.territories[0], influence: { lava: 1 } }] }), "element");
  assertThrows(() => WorldMap.fromJSON(null), "null");
});

Deno.test("[P5-W1] coverAt: deterministic density layer, follows places (forest = trees/scrub, built-up = none)", () => {
  const home: V3 = { x: 420, y: 0, z: -310 };
  const w = new WorldMap({ seed: 2026, origin: PARIS });
  const places = w.generateNeighbourhood("ana", home);
  const w2 = new WorldMap({ seed: 2026, origin: PARIS });
  w2.generateNeighbourhood("ana", home);
  const counts: Record<string, number> = { trees: 0, rocks: 0, scrub: 0, none: 0 };
  for (let j = -30; j <= 30; j++) {
    for (let i = -30; i <= 30; i++) {
      const x = home.x + i * 100, z = home.z + j * 100;
      const c = w.coverAt(x, z);
      assertEquals(w2.coverAt(x, z), c, "deterministic");
      counts[c ?? "none"]++;
    }
  }
  for (const k of ["trees", "rocks", "scrub", "none"]) assert(counts[k] > 0, `${k}: ${JSON.stringify(counts)}`);
  const forest = places.find((p) => p.kind === "forest")!;
  const shop = places.find((p) => p.kind === "supermarket")!;
  for (let k = 0; k < 12; k++) {
    const t = (k / 12) * Math.PI * 2, r = forest.radius * 0.6;
    const c = w.coverAt(forest.pos.x + Math.cos(t) * r, forest.pos.z + Math.sin(t) * r);
    assert(c === "trees" || c === "scrub", `forest cover ${c}`);
  }
  assertEquals(w.coverAt(shop.pos.x, shop.pos.z), null, "no trees inside a supermarket");
});

Deno.test("[P5-W1] reliefMarks: spread local maxima / minima, peaks above hollows, sorted", () => {
  const w = new WorldMap({ seed: 2026, origin: PARIS });
  const c: V3 = { x: 420, y: 0, z: -310 };
  const m = w.reliefMarks(c, 3000, 5);
  assert(m.peaks.length >= 2 && m.peaks.length <= 5, `peaks ${m.peaks.length}`);
  assert(m.lows.length >= 2 && m.lows.length <= 5, `lows ${m.lows.length}`);
  for (let i = 1; i < m.peaks.length; i++) assert(m.peaks[i - 1].y >= m.peaks[i].y, "peaks sorted");
  for (let i = 1; i < m.lows.length; i++) assert(m.lows[i - 1].y <= m.lows[i].y, "lows sorted");
  assert(m.peaks[0].y > m.lows[0].y, "highest peak above the lowest hollow");
  for (const list of [m.peaks, m.lows]) {
    for (const p of list) {
      assertAlmostEquals(p.y, w.heightAt(p.x, p.z), 1e-9);
      for (const q of list) if (p !== q) assert(Math.hypot(p.x - q.x, p.z - q.z) >= 1000 - 1e-6, "spread");
    }
  }
  const step = 6000 / 40;
  for (const p of m.peaks) for (const [dx, dz] of [[step, 0], [-step, 0], [0, step], [0, -step]]) assert(w.heightAt(p.x + dx, p.z + dz) < p.y, "a peak is a local maximum");
  assertEquals(JSON.stringify(w.reliefMarks(c, 3000, 5)), JSON.stringify(m), "deterministic");
});
