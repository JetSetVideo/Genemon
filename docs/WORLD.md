# WORLD — the Genemon map model

> **Summary (5 lines)**
> 1. `src/world/worldmap.ts` is a pure model of the always-on world: places at real lat/lon, local ENU metres (x east, y up, z north), deterministic terrain.
> 2. The ground is a **global** ~100 m cell grid. Cells are claimed **on site**, defended remotely, and decay when neglected. Homes keep a garrison floor.
> 3. Wild spawns = base × place bias × ground × time of day × weather × **ecology**. Releases seed an element locally and catches deplete it; both fade with a 2-day half-life.
> 4. Physical vs virtual is data: every action is physical everywhere or virtual everywhere. Only arena/dungeon/portal/stadium/museum/library are virtually reachable.
> 5. Privacy by construction: a home is stored only as its 250 m cell centre, and ledger rows carry 100 m cell centres. Status: **TESTED** (18 tests, 14/14 mutants caught), **not integrated** yet.

Owner: World designer (see `docs/team/ROSTER.md`). Code is the source of truth; the tables below were
generated from the module on 2026-10-12 by a scratch probe (see [Evidence](#evidence)).

---

## 1. The map model

| Concept | Type | What it is |
|---|---|---|
| World | `WorldMap` | One seeded world. Places, territory cells, avatars. Pure: `now` is always a parameter. |
| Place | `Place` | A point of interest with a disc (`pos`, `lat`, `lon`, `radius`, `ground`, `kind`). Public places have `ownerId: null`; only a **home** is private. |
| Place kind | `PlaceKind`, `PLACE_KIND_DEFS` | Catalogue row: ground, radius, physical actions, virtual actions, element bias, flags. |
| Territory | `Territory` | One ~100 m cell: owner, garrison (`defense` as of `defendedAt`), ecology `influence` (as of `influenceAt`). |
| Action | `WORLD_ACTIONS` | Every world action with its presence rule and a suggested throttle (cooldown, daily cap). |
| Avatar | `avatarAt()` | Where a player's avatar stands in the virtual space (set by `travelVirtual`). |

**Lazy time.** Nothing ticks. Every decaying quantity is stored as a value plus a timestamp. A read at `now`
applies the decay: `territory(cellId, now)` returns the live view, `territory(cellId)` the stored snapshot.
*Why:* deterministic, replayable from the ledger, no timers. An offline world ages correctly with nobody
online.

### API (signatures)

```ts
new WorldMap({ seed, origin: { lat, lon }, ledger?, cellSize? /* 100 */ })
toLocal(lat, lon, alt = 0): V3            toGeo(p: V3): { lat, lon, alt }
heightAt(x, z): number                    groundAt(pos): GroundId
generateNeighbourhood(ownerId, home: V3, now = 0): Place[]
addPlace({ kind, pos, name?, radius?, ground?, id? }, now = 0): Place      // homes refused
places(): Place[]   place(id): Place | null   placesNear(pos, r, kind?): Place[]
placesAt(pos): Place[]   sensitivePlaceAt(pos): Place | null
discover(playerId, placeId, now, physicallyPresent, ctx?: { hour?, weather? }): { ok, reason, firstVisit }
cellOf(pos): string   cellCenter(cellId): V3   territory(cellId, now?): Territory
claim(playerId, pos, power, now, physicallyPresent): { ok, reason }
defend(playerId, cellId, power, now): { ok, reason }
actionAllowed(action, place, physicallyPresent, playerId?): { ok, reason }
travelVirtual(playerId, placeId, now): { ok, reason }   avatarAt(playerId): string | null
release(playerId, element, pos, now): number   catchAt(playerId, element, pos, now): number
influenceAt(pos, element, now): number
spawnTable(pos, hour, weather, now): { element, weight }[]      // all 14 elements, weight > 0
rollSpawn(pos, hour, weather, now, rng): { element, rarity, level }
toJSON(): WorldMapJSON   WorldMap.fromJSON(data, ledger?): WorldMap     // fails closed
catchAllowed(rarity, physicallyPresent): { ok, reason }               // free function
```

Additions to the original spec, and why:
- `Place.visitedBy`: on-site visitors, so a virtual discovery never consumes the on-site `firstVisit` reward.
- `Territory.defendedAt` / `influenceAt`: the decay clocks that lazy time needs.
- `PlaceKindDef.radius`, `virtualTravel` and `sensitive` flags.
- The optional `now` parameter on `generateNeighbourhood` / `addPlace`, used for the ledger row.
- The optional `playerId` parameter on `actionAllowed`, which private places require.

---

## 2. Coordinates and projection error

- Local frame: **ENU metres** around `origin`. `x = (lon − lon0)·M·cos(lat0)`, `z = (lat − lat0)·M`, `y = altitude`, with `M = R·π/180` and `R = 6 371 008.8 m` (IUGG mean, same as `src/net/antiCheat.ts`). Longitude differences wrap at ±180°.
- `toGeo` is the **exact inverse**: the round trip is ~1e-8 m. `[WORLD-PROJ]` asserts < 1 m at 5 km on 4 origins, including one 0.01° from the antimeridian.
- Origins beyond ±85° latitude are refused, because `cos(lat0) → 0`.

**Measured error.** Real module against an exact great circle, max over 24 bearings:

| origin lat | distance from origin error at 1 / 5 / 10 / 20 / 50 km (m) | local scale error, 100 m pair at 1 / 5 / 10 / 20 / 50 km (m) |
|---|---|---|
| 0° | 0.000 / 0.000 / 0.001 / 0.008 / 0.13 | 0.000 / 0.000 / 0.000 / 0.001 / 0.003 |
| 30° | 0.017 / 0.43 / 1.70 / 6.8 / 42.6 | 0.009 / 0.045 / 0.091 / 0.18 / 0.46 |
| 48.85° (Paris) | 0.034 / **0.84** / 3.37 / 13.5 / 84.5 | 0.018 / 0.090 / 0.180 / 0.36 / 0.90 |
| 60° | 0.051 / 1.28 / 5.10 / 20.4 / 128 | 0.027 / 0.136 / 0.272 / 0.54 / 1.36 |
| 70° | 0.081 / 2.02 / 8.10 / 32.4 / 203 | 0.043 / 0.216 / 0.431 / 0.86 / 2.16 |

Rule of thumb: the east–west scale error at Δz metres north or south of the origin is ≈ `tan(lat0)·Δz/R`.
That is **0.09 % at 5 km and 0.9 % at 50 km** at Paris latitude.

Decisions:
- **Presence is never decided in local metres.** Netcode checks presence with haversine on `place.lat/lon/radius`, so projection error cannot flip a verdict. Local metres serve rendering and spawns, where 1 % is invisible.
- **Re-centre the origin when the player is > 20 km from it** (integrator's job). That keeps local error < 0.4 % and float precision comfortable. Places carry `lat/lon`, so re-projecting them is cheap.
- **Everything shared is a function of lat/lon, never of the origin.** That covers terrain (`heightAt` samples noise in sinusoidal global metres), cell ids and generated neighbourhoods. Two clients with different origins see the same world: `[WORLD-PRIVACY]`, `[WORLD-CELL]` and `[WORLD-TERRAIN]` assert it to 1e-9° / 1e-6 m.

Terrain: `heightAt = 160·(fbm2(…/2400 m, 4 oct) − ½) + 24·(fbm2(…/400 m, 3 oct) − ½)`. Measured range
over 40 × 40 km: **−67.5 … +65.1 m**. `groundAt` returns the innermost place's ground, otherwise natural
ground from height and a moisture noise: stone > 55 m, gravel > 40 m, moss or mud if wet, soil if dry, else grass.

---

## 3. Place catalogue

The 21 kinds of the world spec come first. Then 5 kinds the Lists designer proposed in
`CONTENT_VOCAB.poi`: **pool, garden, harbour, landmark, plaza**. *Why:* quests filter `world.visit` on
`poi` (for example "Go down to the harbour"). A kind the world cannot place makes that quest impossible to
finish. `PlaceKind` is now a superset of `CONTENT_VOCAB.poi`.

| kind | ground | radius m | physical actions | virtual actions | element bias | flags |
|---|---|---|---|---|---|---|
| home | grass | 180 | visit, catch, release, rescue, home.rest | home.manage, home.feed | neutral +1, plant +0.3, psychic +0.2 | private |
| supermarket | stone | 50 | visit, catch, supermarket.buy, supermarket.bonus | - | neutral +0.8, metal +0.5, electric +0.4, plant +0.3, ice +0.3 |  |
| gym | metal | 40 | visit, catch, gym.train, gym.spar | - | metal +1, earth +0.6, fire +0.5, neutral +0.3 |  |
| park | grass | 120 | visit, catch, release, rescue, forage, sunbathe, friend.meet | - | plant +1, air +0.6, neutral +0.4, light +0.3 |  |
| lake | water | 200 | visit, catch, release, rescue, swim | - | water +1.5, ice +0.5, electric +0.3, plant +0.3 |  |
| forest | moss | 300 | visit, catch, release, rescue, forage | - | plant +1.5, earth +0.5, poison +0.5, shadow +0.4 |  |
| cafe | stone | 35 | visit, catch, cafe.buy, friend.meet | - | fire +0.6, psychic +0.5, neutral +0.5 |  |
| school | gravel | 80 | visit | - | none | sensitive |
| office | stone | 50 | visit, catch, friend.meet | - | electric +0.8, metal +0.6, psychic +0.4 |  |
| station | metal | 60 | visit, catch, friend.meet | - | electric +1, metal +0.8, air +0.4 |  |
| museum | stone | 60 | visit, catch, museum.scan | museum.tour | earth +0.8, psychic +0.8, light +0.4, void +0.3 | virtual travel |
| beach | sand | 150 | visit, catch, release, rescue, swim, sunbathe, forage | - | water +1, earth +0.6, air +0.6, light +0.5 |  |
| mountain | stone | 300 | visit, catch, release, rescue, climb | - | earth +1.2, air +0.9, ice +0.6, metal +0.3 |  |
| hospital | stone | 90 | visit | - | none | sensitive |
| library | stone | 40 | visit, catch | library.read | psychic +1.2, light +0.4, void +0.3 | virtual travel |
| stadium | grass | 120 | visit, catch, friend.meet | battle.ranked, battle.spectate, tournament.join | fire +0.6, electric +0.6, air +0.4, light +0.3 | virtual travel |
| farmersMarket | soil | 60 | visit, catch, farmersMarket.buy | - | plant +1, earth +0.5, neutral +0.4 |  |
| river | water | 80 | visit, catch, release, rescue, swim | - | water +1.2, plant +0.4, earth +0.3, electric +0.2 |  |
| arena | soil | 70 | visit, catch | battle.casual, battle.ranked, battle.spectate | fire +0.5, earth +0.5, metal +0.4, neutral +0.4 | virtual travel |
| dungeon | stone | 50 | visit, catch | dungeon.enter, catch.virtual | shadow +1.2, void +0.8, earth +0.6, poison +0.5 | virtual travel |
| portal | crystal | 35 | visit, catch | portal.enter, catch.virtual | void +1.2, psychic +0.9, light +0.5 | virtual travel |
| pool | water | 40 | visit, catch, swim | - | water +1, ice +0.3, neutral +0.3 |  |
| garden | grass | 60 | visit, catch, release, rescue, forage, sunbathe | - | plant +1.2, earth +0.3, light +0.3, poison +0.2 |  |
| harbour | stone | 120 | visit, catch, release, rescue, harbour.buy | - | water +1.2, metal +0.5, air +0.4, electric +0.2 |  |
| landmark | stone | 60 | visit, catch, friend.meet | - | light +0.6, psychic +0.5, earth +0.4 |  |
| plaza | stone | 70 | visit, catch, friend.meet | - | air +0.5, neutral +0.6, electric +0.3, light +0.3 |  |

Rules encoded in the catalogue, each tested in `[WORLD-ACTION]` / `[WORLD-SENSITIVE]`:
- **Radius ≥ 35 m.** Netcode's `physicalPresence` only counts a fix whose whole accuracy disc fits inside the place, so a 10 m café would be uncheckable.
- **Sensitive kinds (school, hospital):** visit only, no claims, no element lure, and spawners must skip `sensitivePlaceAt(pos)`. *Why:* crowds of players at schools (minors) and hospitals (emergency access) are a real-world harm. Pokémon GO learned this in public.
- **Virtual actions only where there is a virtual way in:** a virtual-travel kind, or the owner's own home (remote management).
- The bias is added to the spawn table near the place: `1 + bias` at the centre, fading smoothly to 0 at twice the radius.

### Generated neighbourhood (`generateNeighbourhood`)

- **Content:** a home plus one place of every other kind, with two cafés, two supermarkets and two parks. That makes **29 places**, all 26 kinds.
- **Determinism:** fully determined by `hashSeed(seed, owner, coarse home cell)`.
- **Distances, measured over 400 owners (geodesic, nearest of each kind):**
  - all places: 253 – 2500 m
  - supermarket: 300 – 1476 m (median 859)
  - gym: 416 – 1800 m (median 1331)
  - café: 253 – 794 m (median 485)

  A supermarket and a gym are **always within 1.8 km**: every candidate is drawn inside its recipe band, and the band caps them at 1.5 km and 1.8 km.
- **Terrain coherence:**
  - The lake and the river take the lowest of 8 free candidates, and the mountain the highest. The lake sat below the mountain in **400/400** neighbourhoods.
  - Beach and harbour sit on the lake shore.
  - Places never overlap (15 m gap).
- **Idempotent:** a second call returns the same places and logs nothing.
- **No territory is claimed.** `generateNeighbourhood` has no presence proof, and claims must stay physical.

---

## 4. Territory rules

| Rule | Value | Why |
|---|---|---|
| Cell | global lat/lon grid, ≤ 100 m a side, id `100:row:col` | ~a city block or a small park: walkable in a minute, ~10 cells per km of walk. Smaller would turn claiming into GPS-jitter noise; larger would let one claim cover a whole street. Same construction and id format as net `geoCellId` (**20000/20000 identical ids** in the probe). |
| Claim | **on site only**; free or lapsed cell → yours, garrison = `power` | The physical-presence rule of the game. |
| Contest | owned cell: `power` must be **strictly >** the decayed defense | Ties go to the defender, so equal teams cannot ping-pong a cell. |
| Takeover | the winner garrisons at **full power** (not `power − defense`) | A pyrrhic garrison of 1 would be retaken instantly. |
| Defend (`defend`) | owner only, from anywhere; garrison = `max(decayed, power)`; the decay clock restarts | Bounded by the strongest real garrison: stacking weak reinforcements can never build an untakeable cell. |
| Decay | half-life **5 days**; a claim **lapses** below defense 1 (100 → lapse in ~33 days) | The world reflects who is active; abandoned land reopens. |
| Home floor | a resident holding their own home cell never decays below `min(garrison, 100)` | The house keeps its locks while you are away, yet a home cell stays raidable. Occupiers get no floor. |
| Own cell | claiming your own cell = reinforce (logs `territory.reinforce`, not `world.claim`) | Claims must not be farmable for quests and achievements. |
| Sensitive | no claims inside a school or hospital disc | Real-world safety. |

`power` is opaque to the world. The recommended scale is the sum of the team's `Phenotype.power` (a
hatchling is about 50, an adult 200–400, a maxed XL about 1500). `homeDefense = 100` assumes that scale:
see open questions.

---

## 5. The spawn ecology loop

```
players catch ──► influence[e] −0.25 per catch ─┐
players release ─► influence[e] +1 per release ─┤   (per cell, half-life 2 days, capped ±8)
                                                ▼
spawnTable(pos) = base[e] × (1 + placeBias) × (1 + 2.5·groundAffinity) × time(hour) × weather × clamp(e^(0.35·I), 0.25, 4)
                                                ▼
rollSpawn → element, rarity, level  ──►  other players walk there, catch / release  ──► (loop)
```

- **Influence field.** `I(pos)` sums the 3×3 neighbouring cells. Each cell is weighted by `1 − d/(1.5·cell)`, where `d` is the distance to its centre. The effect is smooth across cell borders, while a release **1 km away changes nothing here** (tested).
- **Asymmetry.** Four catches offset one release. Depletion bottoms out at ×0.25 and seeding tops out at ×4, so over-hunting thins an element locally but **never erases it**. Every element always keeps weight > 0.
- **Measured example** (open grass, noon, clear): 3 ice releases raise the ice weight **×2.60**. Four days later (two half-lives) it is back to **×1.27**.
- **Time of day.** `dayness = cos(2π(hour − 13)/24)`. Light, fire and plant peak by day; shadow, void and psychic by night. Measured spawn shares on open grass:

  | spot / time | top shares |
  |---|---|
  | 13 h clear | plant 17.0 %, fire 12.9 %, light 9.3 % … shadow 2.2 %, void 0.9 % |
  | 01 h clear | shadow 10.2 %, neutral 9.3 %, plant 8.6 %, psychic 8.4 % … void 3.9 %, light 2.2 % |
  | 13 h rain | water 7.2 → 12.9 %, electric 6.5 → 9.0 %, fire 12.9 → 5.4 % |

- **Weather.** The world has its own `SPAWN_WEATHER` table, separate from `WEATHERS.elementMult`. *Why:* that one is a damage table tuned for battle parity, while a spawn multiplier only shifts the mix. Rain: water ×1.8, electric ×1.4, fire ×0.5. Eclipse: shadow ×2, void ×1.8. Aurora: light ×1.8, psychic ×1.7.
- **Rarity.** Base mix is 62 / 26 / 9 / 2.6 / 0.4 %. Rare, epic and legendary scale by `boost^1, ^1.5, ^2`, where `boost` multiplies three factors:
  - night: up to ×1.3
  - weather: storm ×1.4, aurora or eclipse ×1.8
  - place: dungeon or portal ×1.6, mountain ×1.3

  Measured over 5000 rolls: rare+ is **12.0 % at a clear noon** and **27.1 % on an aurora night**.
- **Level.** `LEVEL_BASE[rarity]` (5 / 10 / 18 / 28 / 42) + altitude/15 + N(0, 2.5), clamped to 1–100.
- `rollSpawn` draws element, then rarity, then level from the caller's `Rng`, so a spawn replays exactly from its seed.

---

## 6. Physical vs virtual, and anti-spoofing hooks

| Physical only (GPS-verified presence) | Allowed from the virtual space |
|---|---|
| claim territory · gym.train · supermarket.buy / .bonus · farmersMarket / harbour / cafe buy · catch on the street · **catching rare+ spawns** · release / rescue · forage / swim / sunbathe / climb · museum.scan · friend.meet · home.rest · discovering any non-virtual kind · every check-in | travel to arena / dungeon / portal / stadium / museum / library · battles and tournaments · `catch.virtual` inside dungeon/portal (**common/uncommon only**, `catchAllowed`) · museum.tour · library.read · home.manage / home.feed (owner) · territory.reinforce |

- **Every action is physical everywhere or virtual everywhere** (`WORLD_ACTIONS[a].physical`, tested). *Why:* one throttle rule per action, and the presence rule never depends on where an action happens. Virtual variants get their own names (`catch.virtual`).
- **The world never decides presence.** It takes `physicallyPresent: boolean`. The **server** derives it with netcode, from fixes the server itself received:
  1. **Presence:** `src/net/antiCheat.ts` `physicalPresence(fixes, place, now)`. `Place` is shape-compatible: it already has `lat`, `lon` and `radius`. For a claim at an arbitrary position, check against `{ ...toGeo(pos), radius: 50 }`.
  2. **Speed:** `gpsPlausible` rejects teleports. `travelCooldownMs` spaces out physical actions far apart.
  3. **Throttle:** pass `ActionThrottle` `{ ...DEFAULT_THROTTLE_RULES, ...WORLD_ACTIONS }`. The shapes are compatible, and `catch`, `world.claim`, `gym.train` and `supermarket.buy` use the **same keys and numbers** as netcode.
- Denied calls change nothing and log nothing (tested). Spoofing signals are netcode's rows (`anticheat.*`).
- **Private places fail closed.** `actionAllowed` on a home without `playerId` denies with "pass the acting playerId". Only the owner checks in or acts there. The stored place wins over a forged copy passed in.

### Tunables (`WORLD_TUNING`)

cellSize 100 m · defenseHalfLife 5 d · lapseDefense 1 · homeDefense 100 · homeGrid 250 m · homeRadius 180 m ·
influenceHalfLife 2 d · release +1 · catch −0.25 · influenceCap ±8 · influenceGain 0.35 · influence mult [0.25, 4] ·
groundSpawnGain 2.5 · maxOriginLat 85°.

### Action table (`WORLD_ACTIONS`)

| action | presence | cooldown | max/day | note |
|---|---|---|---|---|
| visit | physical | 1 min | 200 | Check in on site; first check-in discovers the place (world.visit). |
| catch | physical | 3 s | 300 | Catch a wild spawn on site; rare+ can ONLY be caught this way. |
| release | physical | 10 s | 50 | Release into the wild: seeds its element locally. |
| rescue | physical | 30 s | 50 | Rescue a Genemon someone released here (EXPERIENCES.rescue). |
| forage / swim / sunbathe / climb | physical | 5 / 10 / 15 / 10 min | 30 / 12 / 8 / 12 | Outdoor experiences (sunbathing, climbing are physicalOnly in lifestyle.ts). |
| home.rest | physical | 30 min | 12 | Rest at home. |
| gym.train / gym.spar | physical | 30 s / 1 min | 60 / 30 | EXPERIENCES.gymTraining. |
| supermarket.buy / .bonus | physical | 10 s / 60 min | 100 / 3 | In-person food purchase / bonus. |
| farmersMarket.buy / harbour.buy / cafe.buy | physical | 10 s / 10 s / 1 min | 100 / 100 / 20 | In-person purchases. |
| friend.meet | physical | 1 min | 30 | Meeting in person bonds more than a remote request. |
| museum.scan | physical | 5 min | 10 | Ancient genome fragment. |
| world.claim | physical | 1 min | 20 | `claim()`. |
| home.manage / home.feed | virtual | 1 s / 10 s | – / 100 | Owner, remotely. |
| museum.tour / library.read | virtual | 5 s | – | Lore, puzzles. |
| battle.casual / battle.ranked / battle.spectate | virtual | 2 s / 2 s / 1 s | 500 / 500 / – | |
| tournament.join | virtual | 1 min | 10 | |
| dungeon.enter / portal.enter | virtual | 1 min | 30 | Instances. |
| catch.virtual | virtual | 5 s | 100 | Common/uncommon only. |
| virtual.travel | virtual | 10 s | 200 | `travelVirtual()`. |
| territory.reinforce | virtual | 1 min | 50 | `defend()`. |

---

## 7. Ledger rows

The naming convention is load-bearing: content's `isPhysicalTrigger` treats `world.*` as GPS-verified.

| what | space | who (from → to) | entries | exits | emitted by |
|---|---|---|---|---|---|
| map.neighbourhood | world | owner (seed → owner) | places, anchor (250 m cell id) | home | first `generateNeighbourhood` |
| map.place | world | "world" (none → place) | poi, radius, ground | place | `addPlace` |
| world.visit | physical | player (player → place) | poi, place, firstVisit, discovered, hour, night, weather? | visitors | `discover(…, true)`: **every** on-site check-in |
| virtual.discover | virtual | player (player → place) | poi, place | discoverers | `discover(…, false)` on a virtual-travel kind |
| world.claim | physical | claimer (previous owner or none → claimer) | territory, ground, power, poi?, contested, defense | owner, defense | free or lapsed claim, or won contest |
| world.raid | physical | attacker (attacker → owner) | territory, ground, power, poi?, defense | won | every contested claim |
| world.defend | physical | owner (attacker → owner) | territory, ground, attackers, defense, power | won | every contested claim (defender's row) |
| territory.reinforce | world | owner (owner → cell) | territory, power, before | defense | `defend`, own-cell `claim` |
| virtual.travel | virtual | player (previous place or hub → place) | poi, place | arrived | `travelVirtual` |
| world.release / world.catch | physical | player (player ↔ cell) | element, territory, before, delta | influence | `release` / `catchAt` |

Every row:
- `where` = the **100 m cell centre** in local ENU, `zone` = cell id.
- `tags` start with `"world"`.
- entries and exits are flat scalars, with no `lat`/`lon`/`x`/`z` keys (`[WORLD-LEDGER]`).

A contest logs a raid row and a defend row because content counts per `who`, so the defender needs a row
of their own. The `world.visit` / `world.claim` / `world.raid` / `world.defend` keys match the
Lists designer's `CONTENT_EVENTS` proposal.

---

## 8. Real-world map data (OpenStreetMap) replacing generated places

Generated places are stand-ins. The swap path, with no API change:

1. **Offline preprocessing.** The CSP is `default-src 'self'` and the game runs offline, so clients never call Overpass. A tool or server job extracts a region into static JSON.
2. **Tag mapping:**

   | OSM tags | kind |
   |---|---|
   | `shop=supermarket\|convenience` | supermarket |
   | `leisure=fitness_centre` | gym |
   | `leisure=park` | park |
   | `natural=water`+`water=lake\|pond`, `waterway=riverbank` | lake |
   | `landuse=forest`, `natural=wood` | forest |
   | `amenity=cafe` | cafe |
   | `amenity=school\|kindergarten\|college` | school (sensitive) |
   | `office=*` | office |
   | `railway=station`, `public_transport=station` | station |
   | `tourism=museum` | museum |
   | `natural=beach` | beach |
   | `natural=peak` | mountain |
   | `amenity=hospital\|clinic` | hospital (sensitive) |
   | `amenity=library` | library |
   | `leisure=stadium` | stadium |
   | `amenity=marketplace` | farmersMarket |
   | `waterway=river` (sampled points) | river |
   | `leisure=swimming_pool` (public) | pool |
   | `leisure=garden` (public) | garden |
   | `harbour=yes`, `leisure=marina` | harbour |
   | `tourism=attraction\|viewpoint` | landmark |
   | `place=square` | plaza |

   Game-only kinds are anchored on public features:

   | game kind | OSM anchor |
   |---|---|
   | arena | `leisure=pitch\|sports_centre` |
   | dungeon | `historic=ruins\|castle`, `natural=cave_entrance` |
   | portal | `tourism=artwork` |

3. **Exclusions.** Never import memorials, cemeteries, places of worship, military land, private residences or shelters.
4. **Import.** `addPlace({ kind, pos: toLocal(lat, lon, heightAt), radius: max(35, √(area/π)), ground, id: "osm:way/123" })`. Ids are stable, and `addPlace` refuses homes and radii below 35 m.
5. **Fill the gaps.** Keep generated places only where OSM has no place of that kind within the recipe distance, so every player still finds a gym and a supermarket.
6. **Licence.** ODbL: show "© OpenStreetMap contributors", and the derived place database is share-alike.

---

## 9. Privacy

- **Home coarsening.** `generateNeighbourhood` uses the exact fix once, only to pick its global **250 m** cell. The home place sits at that cell's centre with a **180 m** radius. That is ≥ the 176.8 m half-diagonal, so standing at the real home always counts as "at home".
- **Nothing to invert.** The neighbourhood depends only on the coarse cell. Any home in the same cell gives **byte-identical** output, and the saved JSON contains none of the exact coordinates (`[WORLD-PRIVACY]`).
- **Ledger rows** carry 100 m cell centres and ids, never a raw fix. Exporters writing `artifacts/` should coarsen further to 1 km zones, the netcode convention (`docs/SECURITY.md`, Network specialist).
- **Other players' homes.** Only the owner may check in or act at a home. The network layer must not ship other players' home places to clients: raiders see the home cell as an ordinary owned cell, sturdier because of the floor.

---

## 10. The always-on world

- **Ageing.** The world keeps living while you are offline. Garrisons decay, the ecology relaxes back to its baseline, and every read at `now` sees the aged state. No ticks, no server cron needed for correctness.
- **Visitors.** Others explore your neighbourhood: places are public, discovered by whoever walks by. Your claimed cells defend themselves with their garrisons, and `world.defend` rows tell you what happened while you were away.
- **NPCs.** Virtual characters live at places. Content's `QUEST_GIVERS` each name a `home: Poi`; instantiate each giver at the nearest place of that kind.
  - **Evolving with players:** their arc stages unlock from ledger milestones counted in their zone. World rows carry `zone` = cell id, so a giver's community = the rows whose cell lies within its place radius.
  - **Acting in the ecology (next quest):** a grocer NPC restocks the supermarket bias, and a lake warden releases water Genemon at dawn. Each NPC gets a deterministic daily schedule from `hashSeed(seed, npc, day)`, so NPCs and players shape the same spawn loop.
- **Authority.** The authoritative `WorldMap` lives on the server; clients hold views. `toJSON` / `fromJSON` is the snapshot format, and it fails closed on malformed input.

---

## 11. Decisions log (with why)

1. **Global cell grid, not a local one.** Clients have different origins, and a local grid would fork the territory map. Ids match netcode's `geoCellId`.
2. **Equirectangular projection plus re-centring.** It is exactly invertible and cheap, and its error is measured and bounded. Presence uses haversine, so the error never decides gameplay verdicts.
3. **Terrain and neighbourhoods are functions of lat/lon.** The world is shared, so it must be origin-independent (tested).
4. **Lazy decay.** Deterministic, replayable, and the offline world ages correctly.
5. **Reinforce with `max()`, contest with strict `>`, takeover at full power.** Bounded, tie-safe, no ping-pong.
6. **No automatic home claim.** Claims must stay physical. The home floor rewards claiming your home on site.
7. **`world.*` / `virtual.*` / `map.*` naming.** The content layer's physical/sofa split depends on it.
8. **Raid + defend + claim rows.** Each `who` gets its own countable row, and re-claiming your own cell is not farmable.
9. **One presence rule per action.** One throttle rule per action and no context-dependent loopholes.
10. **A separate spawn weather table.** It shifts the mix without touching battle balance.
11. **Catch −0.25 vs release +1, multiplier clamped to [0.25, 4], weight always > 0.** Players shape the land but can never erase an element or flood a cell forever.
12. **Five content POI kinds adopted.** Every quest `poi` filter refers to a placeable kind.
13. **Sensitive kinds, private homes failing closed, radius ≥ 35 m.** Real-world safety, privacy, and GPS reality.

---

## 12. Open questions

- **Power scale.** `homeDefense = 100` assumes `power` = the sum of team `Phenotype.power`. Combat or economy must confirm.
- **Dense cities.** Many homes share one 250 m cell (good for k-anonymity), but only the first claimant of the 100 m home cell gets the floor. Should the floor become a per-resident home garrison instead of cell ownership?
- **Moving house.** A new home cell creates a second home, and there is no `moveHome` / removal yet. It needs a cooldown so homes cannot teleport next to a rival.
- **Ping-pong.** Should a fresh takeover get a short per-cell shield (~10 min) on top of netcode's per-player claim cooldown? Should failed raids wear down the garrison (attrition)?
- **Friends' co-defence.** `defend` is owner-only for now and needs netcode's social graph.
- **Civil hour.** `world.visit` defaults to local mean *solar* hour, which can be 1–2 h off civil time with DST and time zones. Callers should pass `ctx.hour` from `src/ui/realworld.ts`.
- **Virtual catches.** Should dungeon and portal catches have their own instance ecology? Today they do not touch the physical one.
- **Scale.** `placesNear` / `placesAt` are O(N) scans. Index by cell id once OSM imports thousands of places.
- **Antimeridian.** Terrain noise has a seam at ±180° (cells and projection are fine).

## 13. Next quests

1. **3D map view** (`src/render/mapView.ts`, orchestrator):
   - terrain mesh from `heightAt`
   - place markers coloured by kind
   - territory tiles from `cellCenter` + owner colour, opacity = `territory(id, now).defense`
   - spawn heat from `spawnTable`
2. **Server wiring:** `physicalPresence` → `physicallyPresent`, and `ActionThrottle` fed with `WORLD_ACTIONS`.
3. **Catch/release flow:** it emits `genemon.catch` / `genemon.release` with the creature fields, then calls `catchAt` / `release` for the ecology row. **Purchase flow:** `world.purchase` after `actionAllowed(…buy)`.
4. **OSM import tool**, as described in §8.
5. **`tools/world-report.ts`:** regenerates every table in this doc from the code (catalogue, actions, projection error, spawn shares, rarity mix).
6. **`src/world/npcs.ts`:** daily NPC schedules acting on the ecology.
7. **`moveHome` and per-cell shields.**
8. **Place kind → arena mapping** for battles fought at a place (`src/world/arena.ts` `ARENA_KINDS`):

   | arena | place kinds |
   |---|---|
   | lake | lake, pool |
   | beach | beach, harbour |
   | forest | forest, garden |
   | canyon | mountain |
   | meadow | park, arena, stadium |
   | city | plaza, station, office, supermarket, gym |
   | crystal | dungeon, portal, museum |
   | swamp | river |

---

## Evidence

Test index (`tests/worldmap_test.ts`, 18 tests, all passing: `deno test --allow-read tests/worldmap_test.ts`):

| Test | Pins |
|---|---|
| `[WORLD-PROJ]` | round trip < 1 m at 5 km; projected distance error < 2 m at 5 km; axes; polar origin refused |
| `[WORLD-GEN]` | determinism per seed + owner; supermarket and gym ≤ 3 km; all kinds; 150–2500 m; lake below mountain; idempotent |
| `[WORLD-PRIVACY]` | home snapped within its cell; same-cell invariance; no leak in JSON; origin-independent places and cells |
| `[WORLD-CLAIM]` ×2 | sofa claim denied with reason; strict `>` contest; raid/defend/claim rows; own-cell claim not farmable |
| `[WORLD-DECAY]` | half-life; lapse; home floor; occupier has no floor |
| `[WORLD-DEFEND]` | owner only; `max()`; clock restart |
| `[WORLD-VIRTUAL]` | gym denied, arena allowed; exactly 6 virtual-travel kinds |
| `[WORLD-ACTION]` | presence rules; private home; registry consistency with `EXPERIENCES.physicalOnly`; `catchAllowed` |
| `[WORLD-DISCOVER]` | every on-site check-in logged; virtual discovery does not consume `firstVisit` |
| `[WORLD-ECO]` | release raises only its element, decays by half per half-life; catches deplete; 1 km isolation; cap |
| `[WORLD-SPAWN]` ×2 | night shadow > light; day/night/weather/place shifts; seeded replay; rare+ responds to aurora night |
| `[WORLD-SENSITIVE]` | no claims in school or hospital; flagged for spawners; `addPlace` guards |
| `[WORLD-CELL]` | ids shared across origins; ≤ 100 m cells; 10–11 borders per km |
| `[WORLD-TERRAIN]` | deterministic, bounded, shared across origins, seed-dependent |
| `[WORLD-LEDGER]` | all 11 event kinds; valid flat rows at cell centres; denied calls log nothing |
| `[WORLD-JSON]` | lossless round trip (state and behaviour); fails closed on bad version, kind, cell size, element |

**Mutation check:** a scratch probe planted 14 rule-breaking mutants in a copy of the module. **14/14 were
caught**, each by the intended test:
- presence, strict `>`, virtual travel, time of day, influence decay, home coarsening
- defense decay, `max()` vs sum, sensitive claims, raw positions in rows, private home
- origin-relative terrain, `cos(lat0)`, farmable own-cell claims

Measurement probes (projection, cell compatibility, neighbourhood distances, terrain range, spawn shares,
rarity mix) ran the real module plus `src/net/antiCheat.ts` (`haversineM`, `geoCellId`) on 2026-10-12.
