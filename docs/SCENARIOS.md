# Genemon gameplay scenarios

> **Summary (read this first)**
> 1. 31 concrete fights and upbringings (SC-01 … SC-31) that explain how Genemon plays and become balance tests.
> 2. Every scenario ends with a machine-readable `json` fixture (teams, arena, weather, hour, expectations with tolerances) that `tests/content_test.ts` parses and validates against the real ids and the real `battle.hit` factors.
> 3. SC-01 … SC-12 cover the mandated topics: the user's three examples, flyers, diggers, weather and terrain changers, phase shifters, eclipse, synergy, big-vs-swarm and day/night rhythm.
> 4. Status: 27 ENGINE (the rules exist in `src/combat/battle.ts`), 2 PROPOSAL (need an engine rule that does not exist yet), 2 MODEL (run today on every test run). The harness now EXISTS: `tools/scenarios.ts` (`deno task scenarios`) measures SC-01 … SC-05 with the same meaning as here, and all five pass over 120 seeds each; it uses SC-06 for side parity instead, so this document's SC-06 (weather changers flipping a neutral matchup) is NOT asserted yet — renumber it or add it to the harness. The other 21 ENGINE scenarios still need harness entries; their expected factors are machine-readable and validated by `tests/content_test.ts`.
> 5. Expectations marked `"target": true` (10, in SC-01, SC-09, SC-11, SC-14, SC-27, SC-28, SC-31) are design goals the current code is predicted to miss — measured balance risks, reported, never asserted.

## Why this document exists

Genemon's promise is that *space and matter matter*: elements react where they meet, the ground under a creature changes the damage it takes, the sky and the clock tilt matchups, size costs team slots, and real life shapes the creature. Each scenario states one promise as a falsifiable expectation with a tolerance, names the code that delivers it, and carries a fixture a harness can run. Many expectations read a damage factor that `Battle.hit()` already logs on every `battle.hit` row (`conduction`, `rhythm`, `ground`, `team`...), so they are exact checks, not win-rate guesses.

## How to read a scenario

- **Setup** — teams (size class, element, level, moves), arena, weather, local hour. Every move is learnable by its owner (element, tier level, ability) and every team fits the 6-slot cap; the test checks this.
- **Expected** — the outcome with a numeric tolerance. Win rates are decisive-only (draws reported separately). `relativeTo` means a ratio between two variants of the same fixture.
- **Why** — the mechanic exercised. **Mechanics** — where it lives in code.
- **Status** — `ENGINE`: every rule it needs exists in `src/combat/battle.ts`; `PROPOSAL`: needs a rule listed under Proposals; `MODEL`: runs today on the genome model.

## Harness rules (for the future `tools/scenarios.ts`)

1. **Build.** One `Battle` per seed: `new Battle({ seed, arena: arenaSpec(kind, seed, weather, hour), teams, ledger, detail: "full" }).run()` (`src/combat/scenario.ts` already builds archetype teams). A member template becomes a genome biased toward its element signature, size class, kind and axes; reject and redraw until the expressed phenotype matches, then force `moves`.
2. **Floors.** `arena.kind` is the natural arena; `arena.ground` is the floor the expectation is about. Until P1 lands, group hits by the ground under the target instead of pinning the floor.
3. **Seeds.** Run `seeds` fights per variant with seeds 1..N; confirm tuning changes on held-out seeds N+1..2N. SC-13 (mirror parity) must pass before any other number is believed.
4. **Win rates** are decisive-only with draws as their own field; print the Wilson 95 % interval next to every rate. A band passes when the point estimate lies inside it; `target` expectations are printed, never asserted.
5. **Read the ledger.** Every number comes from `battle.*` rows (hit, miss, fail, reaction, clash, status, terrain, weather, ko, end) or, for chained current, from `Battle.events` hits labelled `conduction`. These are the rows achievements and quests count, so a scenario also proves the rows exist.

## Fixture schema

```ts
interface Fixture {
  id: `SC-${number}`; title: string; tags: string[]; status: "ENGINE" | "PROPOSAL" | "MODEL" | "DATA";
  arena: { kind?: ArenaKind; ground: GroundId; weather: WeatherId; hour: number };   // kind required unless MODEL; hour = local 0-23
  teamA: Member[]; teamB: Member[];                                                     // empty only for MODEL
  seeds: number;                                                                        // >= 100
  variants?: { label: string; arena?: Partial<Arena>; teamA?: Member[]; teamB?: Member[] }[];
  regimen?: { level: number; ageDays: number; groups: { label: string; exposure: Partial<Record<GroundId, number>>; diet: Partial<Record<FoodId, number>> }[] };
  expect: { metric: Metric; op: ">=" | "<=" | "between" | "=="; value: number | [number, number] | string;
            variant?: string /* default main */; relativeTo?: string /* ratio */; target?: boolean;
            move?: string; factor?: BattleHitFactor; reaction?: ReactionId; status?: StatusId; side?: "A" | "B"; ground?: GroundId; element?: ElementId }[];
}
interface Member { name?: string; size: SizeClass; primary: ElementId; secondary?: ElementId; level: number;
                  kind?: BodyKind; abilities?: (keyof Abilities)[]; axes?: Partial<AxisVector>; moves: string[] /* 1-4 */ }
```

## Metric vocabulary

| metric | definition | params |
|---|---|---|
| `winRateA` | decisive wins of side A / decisive fights (`battle.end` exits.winner) | - |
| `meanHitDamage` | mean `exits.damage` of the move's `battle.hit` rows | move |
| `meanHitFactor` | mean of one logged damage factor (`battle.hit` entries: conduction, rhythm, ground, team, type, weather...) over the move's hits | move, factor |
| `statusDamageRatio` | mean damage of the move's hits on targets carrying the status / on targets without it, same fights | move, status |
| `hitsWhileStatus` | landed hits of the move on targets carrying the status, summed over seeds | move, status |
| `reactionsPerHit` | `battle.reaction` rows of the reaction caused by the move / landed hits of the move | move, reaction |
| `battlesWithReaction` | share of fights with at least one `battle.reaction` of that reaction | reaction |
| `clashReactionShare` | share of `battle.clash` rows between the reaction's two elements whose exits.reaction is that reaction | reaction |
| `moveSuccess` | uses of the move (`battle.decide` exits.move) not followed by a `battle.fail` for it / all uses | move |
| `groundAfter` | ground on the move's impact cells afterwards (`battle.terrain` to, mode over seeds) | move |
| `groundShare` | share of arena cells of that ground after 60 s | ground |
| `slideDistance` | mean knockback displacement (m) of targets hit by the move from `side` | move, side |
| `zoneAccuracyRatio` | hit rate of attacks fired from inside the reaction's zone / elsewhere | reaction |
| `statusUptime` | share of alive time the side's Genemon carry the status | status, side |
| `friendlyShare` | share of the reaction's damage landing on the causing side's own Genemon | reaction |
| `moveSpeed` | mean ground speed of the side's Genemon on that ground / their stat `spd` | side, ground |
| `expressedElementShare` | MODEL: share of seeds whose expressed primary or secondary type is the element | element |
| `superEffectiveChoice` | share of damaging-move choices that are super-effective when one is available | - |
| `chargeInterruptRate` | share of the move's charges cancelled before their active phase | move |

## Engine rules these scenarios exercise (as implemented in `src/combat/battle.ts`)

| id | rule | used by |
|---|---|---|
| R1 | **Damage** = power x atk/40 x 100/(100 + def; shielded x1.6, softened x0.75) x type x STAB 1.2 x weather element mult x ground affinity (1 + 0.5 x the attacker's cell affinity) x conduction (electric) x size (contact) x melee 1.08 x emotion x team synergy x rhythm x liquid x frozen 1.15 x fire-on-wet 0.8 x reaction x spread U(0.88, 1.12) x crit 1.6. Every factor is logged on `battle.hit`. | all |
| R2 | **Hit chance** = move accuracy x accuracy x visibility^(1 ranged, 0.3 melee/burst) x blinded 0.65 x focused 1.05 x zone accuracy when the attacker stands in smoke 0.65 / dust 0.8 / mist 0.85, minus evasion (frozen or staggered: 0), clamped 0.05-0.99. | SC-02, 16, 24 |
| R3 | **Conduction** (electric only) = conductivity of the target's ground (flying 0.6, burrowed 0.5) x 1.3 if wet x 1.08 if the sky's wetness > 0.4. | SC-03, 10, 17, 19 |
| R4 | **Wet**: a sky with wetness >= 0.45 wets every non-fire fighter above ground; standing in a liquid other than lava wets non-fire fighters. | SC-03, 06, 17 |
| R5 | **Current chains**: an electric hit on a wet or in-water target deals 0.45 x its damage (scaled by relative conduction) to every other wet or in-water body within 4.5 m, allies included; one `battle.reaction` conduction row when at least one body is chained. | SC-10 |
| R6 | **Reactions** fire when fire hits a wet or in-water target (smoke x0.6, dries it) or a water type (smoke, no multiplier); water hits a burning target (smoke x0.6) or a fire type (smoke); fire hits a frozen target (melt); an attack lands in a reacting zone; the impact cell is reacting ground (water, deep and muddy water = water; grass, moss = plant; lava = fire; ice, snow = ice; metal = metal; soil, sand, mud, gravel, stone = earth; conduction excluded); two projectiles clash. | SC-01, 02, 09, 15, 18, 19, 22, 24 |
| R7 | **Reach**: `ground`-tagged moves never reach flyers; burrowed targets are reachable only by `ground`-tagged moves; melee cannot reach a flyer above reach + height. | SC-04, 05 |
| R8 | **Dig** is refused (`battle.fail`) when the user stands on non-diggable ground. | SC-05 |
| R9 | **Liquid body**: contact x0.5, electric x1.25, no knockback or pull, movement x0.85. | SC-08 |
| R10 | **Rhythm**: day = 07:00-18:59 local. Attack x (1 + 0.06 x rhythm) by day, x (1 - 0.06 x rhythm) by night; light x1.1 by day / 0.9 by night, shadow the reverse. | SC-09, 12 |
| R11 | **Fear**: below 30 % HP each hit adds 0.25 x (1 - conviction01) fear; a Genemon flees when feared, or when fear > 0.6 under 35 % HP. The feared status ignores conviction. | SC-28 |
| R12 | **Learning**: damage estimates use learned matchups (`memory["fire>plant"]`), else the truth if wisdom01 > 0.65, else 1 + (truth - 1) x 0.6 x wisdom01; each hit blends in the truth at 0.2 + 0.6 x wisdom01. | SC-29 |
| R13 | **Weather over time**: heatwave melts random ice/snow cells, snow freezes water cells, sandstorm drains non-earth/non-metal fighters, thunderstorm lightning hits non-electric fighters for 5 % max HP x conduction. | SC-06, 20, 22 |
| R14 | **Knockback** impulse = value x crit 1.8 x clamp(sqrt(massRatio), 0.5, 2) x target mass, resisted by balance; ground friction decides the slide. | SC-07, 26 |
| R15 | **Disabled**: frozen or staggered fighters cannot start a move; frozen also pauses a charge in progress; a stagger does not cancel one. | SC-27 |
| R16 | **End**: last side standing, or 90 s on slot-weighted HP (a draw within 2 %). | all |

## Proposals (not implemented; the scenarios that need them say so)

| id | proposal | owner | scenarios |
|---|---|---|---|
| P1 | `ArenaSpec.floor?: GroundId`, a uniform floor so a scenario can pin the ground under both teams. | world (`src/world/arena.ts`) | SC-03, 05, 07, 17, 19, 25 |
| P2 | Content keys on battle rows (`battle.hit` targetGround / element / contact / sizes, `battle.reaction` ground, `battle.miss` reason...) — the `requested` keys in `CONTENT_EVENTS`. | battle engine | harness grouping; LISTS §17 |
| P3 | A stagger landing during a charge cancels the move (energy stays spent). | battle engine | SC-27 |
| P4 | Conviction shortens the feared status: duration x (1 - 0.6 x max(0, conviction)). | battle engine | SC-28 |
| P5 | A swarm counterweight: surround/flank bonus, area damage split between targets, or budgets near the parity line. | genome + battle | SC-01 slotFair, 11, 14 |
| P6 | Smooth rhythm: the cosine of the hour `epigenetics.ts` already uses, instead of the 07:00 / 19:00 step. | battle engine | SC-12 (not asserted) |

## Coverage of the mandated topics

| topic | scenarios |
|---|---|
| User example 1: a big fire Genemon with a close attack beats two small, different plant Genemon | SC-01 (`user-big-fire-vs-small-plants`) |
| User example 2: fire against water creates smoke | SC-02 (`user-fire-water-smoke`) |
| User example 3: electricity connects strongly on water, less on muddy water, least on stone | SC-03 (`user-electric-ground-ladder`) |
| Flyers dodge ground quakes | SC-04 (`flyer-dodges-quake`) |
| Diggers need diggable ground | SC-05 (`digger-needs-diggable-ground`) |
| Weather changers flip a matchup | SC-06 (`weather-flips-matchup`) |
| Terrain changers: freeze water into slippery ice | SC-07 (`terrain-freeze-slippery`) |
| Phase shifters melt / form | SC-08 (`phase-shift-melt-form`) |
| Light vs shadow eclipse | SC-09 (`light-shadow-eclipse`) |
| Synergy team (water + electric) vs non-synergy | SC-10 (`synergy-water-electric`) |
| Big vs swarm by slots | SC-11 (`big-vs-swarm-slots`) |
| Night vs day rhythm buffs | SC-12 (`night-day-rhythm`) |

## Scenarios

### SC-01 — A big fire bruiser beats two small plants up close

**Status:** ENGINE · **Tags:** `user-big-fire-vs-small-plants`, `type-chart`, `size-budget`, `reaction-wildfire`

**Setup.** A: one **L fire** quadruped, lvl 30, close-range kit Ember Bite (melee) + Inferno Burst (burst, 3.2 m around itself) + Tackle (3 slots). B: two **S plants**, lvl 30 — *Sproutling* (pure plant: Vine Lash, Seed Shot, Thorn Spray) and *Blightbud* (plant/poison: Vine Lash, Venom Fang, Toxic Spit) (2 slots). Grass arena, clear, 14:00.

**Expected.** A wins **>= 85 %** of 200 seeds (`tests/battle_test.ts` already runs this matchup with `ARCHETYPES.bigFireBrawler` against two `smallPlant`). Wildfire fires in **>= 95 %** of fights and Inferno Burst leaves **ash**. Variant *waterCounter* (Blightbud replaced by a plant/water with Water Jet): A still wins **55-90 %**. Variant *slotFair* (three small plants, 3 slots each side): design target **35-65 %**, predicted miss (A >= 70 %, see SC-11).

**Why.** Fire hits plant x2 (plus STAB x1.2) and plant hits fire x0.5. The L body brings a 2.75 power budget against 2 x 1.0, and contact hits scale with mass (massRatio^0.1 clamped 0.75-1.4: up to x1.4 for the L, down to x0.75 for the S). Wildfire comes from the grass under each impact; burnt cells turn to ash, which removes the plants' grass affinity mid-fight.

**Mechanics.** `src/combat/battle.ts` Battle.hit (type, STAB, size), groundImpact · `src/data/elements.ts` typeMultiplier, REACTIONS.wildfire · `src/data/grounds.ts` transformGround(grass, fire) · `src/genome/phenotype.ts` POWER_BUDGET, SLOT_COST

```json
{
  "id": "SC-01",
  "title": "A big fire bruiser beats two small plants up close",
  "tags": ["user-big-fire-vs-small-plants", "type-chart", "size-budget", "reaction-wildfire"],
  "status": "ENGINE",
  "arena": {"kind": "meadow", "ground": "grass", "weather": "clear", "hour": 14},
  "teamA": [
    {"name": "Cinderhound", "size": "L", "primary": "fire", "level": 30, "kind": "quadruped", "moves": ["emberBite", "infernoBurst", "tackle"]}
  ],
  "teamB": [
    {"name": "Sproutling", "size": "S", "primary": "plant", "level": 30, "moves": ["vineLash", "seedShot", "thornSpray"]},
    {"name": "Blightbud", "size": "S", "primary": "plant", "secondary": "poison", "level": 30, "moves": ["vineLash", "venomFang", "toxicSpit"]}
  ],
  "seeds": 200,
  "variants": [
    {"label": "waterCounter", "teamB": [{"size": "S", "primary": "plant", "level": 30, "moves": ["vineLash", "seedShot"]}, {"size": "S", "primary": "plant", "secondary": "water", "level": 30, "moves": ["vineLash", "waterJet"]}]},
    {"label": "slotFair", "teamB": [{"size": "S", "primary": "plant", "level": 30, "moves": ["vineLash", "seedShot"]}, {"size": "S", "primary": "plant", "secondary": "poison", "level": 30, "moves": ["vineLash", "venomFang"]}, {"size": "S", "primary": "plant", "secondary": "water", "level": 30, "moves": ["vineLash", "waterJet"]}]}
  ],
  "expect": [
    {"metric": "winRateA", "op": ">=", "value": 0.85},
    {"metric": "battlesWithReaction", "op": ">=", "value": 0.95, "reaction": "wildfire"},
    {"metric": "groundAfter", "op": "==", "value": "ash", "move": "infernoBurst"},
    {"metric": "winRateA", "op": "between", "value": [0.55, 0.9], "variant": "waterCounter"},
    {"metric": "winRateA", "op": "between", "value": [0.35, 0.65], "variant": "slotFair", "target": true}
  ]
}
```

### SC-02 — Fire meets water: smoke

**Status:** ENGINE · **Tags:** `user-fire-water-smoke`, `reaction-smoke`, `accuracy-zone`

**Setup.** A: **M fire**, lvl 12 (Cinder Spit, Flame Lance, Ember Bite). B: **M water**, lvl 12 (Water Jet, Hydro Beam, Tide Slam). Stone arena (no standing water, so smoke can only come from the two elements meeting), clear, 14:00.

**Expected.** **>= 95 %** of fire hits on the water Genemon and **>= 95 %** of water hits on the fire Genemon log a smoke reaction. Attacks fired from inside the cloud keep **<= 0.70x** their accuracy (0.65). A wins **<= 15 %**.

**Why.** battle.ts logs smoke whenever fire meets a water body or water meets a fire body, both directions. The x0.6 smoke multiplier applies only when fire lands on a wet or standing-in-water target (and dries it); against a dry water type the chart already prices the matchup (x0.5 one way, x2 the other). The cloud then blinds whoever attacks from inside it. On this stone floor fire impacts also make magma (fire + earth ground).

**Mechanics.** `src/combat/battle.ts` Battle.hit (target-state reactions), hitChance (zone accuracy) · `src/data/elements.ts` REACTIONS.smoke, reactionBetween

```json
{
  "id": "SC-02",
  "title": "Fire meets water: smoke",
  "tags": ["user-fire-water-smoke", "reaction-smoke", "accuracy-zone"],
  "status": "ENGINE",
  "arena": {"kind": "crystal", "ground": "stone", "weather": "clear", "hour": 14},
  "teamA": [
    {"size": "M", "primary": "fire", "level": 12, "moves": ["cinderSpit", "flameLance", "emberBite"]}
  ],
  "teamB": [
    {"size": "M", "primary": "water", "level": 12, "moves": ["waterJet", "hydroBeam", "tideSlam"]}
  ],
  "seeds": 200,
  "expect": [
    {"metric": "reactionsPerHit", "op": ">=", "value": 0.95, "move": "cinderSpit", "reaction": "smoke"},
    {"metric": "reactionsPerHit", "op": ">=", "value": 0.95, "move": "waterJet", "reaction": "smoke"},
    {"metric": "zoneAccuracyRatio", "op": "<=", "value": 0.7, "reaction": "smoke"},
    {"metric": "winRateA", "op": "<=", "value": 0.15}
  ]
}
```

### SC-03 — Electric damage follows the ground: water > muddy water > mud > stone

**Status:** ENGINE · **Tags:** `user-electric-ground-ladder`, `reaction-conduction`, `ground-conductivity`

**Setup.** A: **M electric**, lvl 12 (Spark Bolt, Thunder Beam). B: **M neutral** training target, lvl 12 (Tackle). The same fight on four pinned floors (P1): water (main), muddy water, mud, stone. Clear, 14:00.

**Expected.** Spark Bolt's logged conduction factor (`battle.hit` entries.conduction) is exact: water **2.08** (1.6 x 1.3 wet), muddy water **1.625** (1.25 x 1.3), mud **1.10** (wet-looking but not liquid, so the target stays dry), stone **0.70**, each +-0.01. Mean damage per hit, water/stone: **2.6-3.35** (contract 2.97).

**Why.** Electric damage is multiplied by the conductivity of the ground under the target, and by 1.3 more when the target is wet; standing in liquid (water, muddy water, deep water) wets every non-fire Genemon. Mud conducts better than stone but is not liquid. The ladder is the one the user described: strongest on water, less on muddy water, least on stone (2.08 > 1.625 > 1.10 > 0.70).

**Mechanics.** `src/combat/battle.ts` conduction(), step() (wet while in liquid) · `src/data/grounds.ts` GROUNDS[*].conductivity, liquid

```json
{
  "id": "SC-03",
  "title": "Electric damage follows the ground: water > muddy water > mud > stone",
  "tags": ["user-electric-ground-ladder", "reaction-conduction", "ground-conductivity"],
  "status": "ENGINE",
  "arena": {"kind": "lake", "ground": "water", "weather": "clear", "hour": 14},
  "teamA": [
    {"size": "M", "primary": "electric", "level": 12, "moves": ["sparkBolt", "thunderBeam"]}
  ],
  "teamB": [
    {"name": "Target dummy", "size": "M", "primary": "neutral", "level": 12, "moves": ["tackle"]}
  ],
  "seeds": 200,
  "variants": [
    {"label": "muddyWater", "arena": {"kind": "swamp", "ground": "muddyWater"}},
    {"label": "mud", "arena": {"kind": "swamp", "ground": "mud"}},
    {"label": "stone", "arena": {"kind": "crystal", "ground": "stone"}}
  ],
  "expect": [
    {"metric": "meanHitFactor", "op": "between", "value": [2.07, 2.09], "move": "sparkBolt", "factor": "conduction"},
    {"metric": "meanHitFactor", "op": "between", "value": [1.615, 1.635], "move": "sparkBolt", "factor": "conduction", "variant": "muddyWater"},
    {"metric": "meanHitFactor", "op": "between", "value": [1.09, 1.11], "move": "sparkBolt", "factor": "conduction", "variant": "mud"},
    {"metric": "meanHitFactor", "op": "between", "value": [0.69, 0.71], "move": "sparkBolt", "factor": "conduction", "variant": "stone"},
    {"metric": "meanHitDamage", "op": "between", "value": [2.6, 3.35], "move": "sparkBolt", "relativeTo": "stone"}
  ]
}
```

### SC-04 — Flyers dodge ground quakes

**Status:** ENGINE · **Tags:** `flyer-dodges-quake`, `ability-fly`, `move-tags`

**Setup.** A: **L earth**, lvl 30 (Quake, Stomp, Rock Toss, Boulder Crush), 3 slots. B: **M air** avian with *fly*, lvl 30 (Take Flight, Air Cutter, Gale Slash, Tornado). Soil, clear, 14:00. Variant *grounded*: B without Take Flight.

**Expected.** Quake lands **0** hits on B while B is airborne; B spends **>= 30 %** of its alive time airborne; A's win rate against the flying B is **<= 0.8x** its rate against the grounded B. Rock Toss (a projectile) still reaches flyers.

**Why.** Quake and Stomp carry the `ground` tag and `canReach()` refuses them against a flyer, so the AI does not even try. Earth and air resist each other (x0.5 both ways), so A's budget edge (L 2.75 vs M 1.9) decides a grounded fight; flight switches off half of A's kit. Flying drains 1.5 energy/s, so B must land to recover — that is A's window.

**Mechanics.** `src/combat/battle.ts` canReach(), step() (fly energy drain) · `src/combat/moves.ts` quake/stomp tags, takeFlight (requires fly) · `src/genome/phenotype.ts` abilities.fly

```json
{
  "id": "SC-04",
  "title": "Flyers dodge ground quakes",
  "tags": ["flyer-dodges-quake", "ability-fly", "move-tags"],
  "status": "ENGINE",
  "arena": {"kind": "meadow", "ground": "soil", "weather": "clear", "hour": 14},
  "teamA": [
    {"size": "L", "primary": "earth", "level": 30, "moves": ["quake", "stomp", "rockToss", "boulderCrush"]}
  ],
  "teamB": [
    {"size": "M", "primary": "air", "level": 30, "kind": "avian", "abilities": ["fly"], "moves": ["takeFlight", "airCutter", "galeSlash", "tornado"]}
  ],
  "seeds": 200,
  "variants": [
    {"label": "grounded", "teamB": [{"size": "M", "primary": "air", "level": 30, "kind": "avian", "moves": ["airCutter", "galeSlash", "tornado"]}]}
  ],
  "expect": [
    {"metric": "hitsWhileStatus", "op": "==", "value": 0, "move": "quake", "status": "airborne"},
    {"metric": "statusUptime", "op": ">=", "value": 0.3, "status": "airborne", "side": "B"},
    {"metric": "winRateA", "op": "<=", "value": 0.8, "relativeTo": "grounded"}
  ]
}
```

### SC-05 — Diggers need diggable ground

**Status:** ENGINE · **Tags:** `digger-needs-diggable-ground`, `ability-dig`, `ground-properties`

**Setup.** A: **M earth** with *dig*, lvl 12 (Burrow, Boulder Crush, Rock Toss). B: **M neutral**, lvl 12 (Tackle, Body Slam, Stomp). Soil (main), then stone and ice. Clear, 14:00.

**Expected.** Burrow succeeds **>= 99 %** of the times it is chosen on soil and **<= 1 %** on stone and ice (`battle.fail`: dig needs diggable ground); B's Tackle lands **0** hits on a burrowed A while Stomp (ground-tagged) still can; A's win rate on stone is **<= 0.9x** its soil win rate.

**Why.** Soil is diggable, stone and ice are not. A burrowed Genemon can only be reached by `ground`-tagged moves, so the counter to a digger is a stomper. Burrow costs 41 energy (the priciest tier-1 attack), so trying it on hard ground is expensive; the AI should learn not to.

**Mechanics.** `src/combat/battle.ts` act() case dig, canReach() · `src/data/grounds.ts` GROUNDS[*].diggable · `src/combat/moves.ts` burrow (requires dig)

```json
{
  "id": "SC-05",
  "title": "Diggers need diggable ground",
  "tags": ["digger-needs-diggable-ground", "ability-dig", "ground-properties"],
  "status": "ENGINE",
  "arena": {"kind": "meadow", "ground": "soil", "weather": "clear", "hour": 14},
  "teamA": [
    {"size": "M", "primary": "earth", "level": 12, "abilities": ["dig"], "moves": ["burrow", "boulderCrush", "rockToss"]}
  ],
  "teamB": [
    {"size": "M", "primary": "neutral", "level": 12, "moves": ["tackle", "bodySlam", "stomp"]}
  ],
  "seeds": 200,
  "variants": [
    {"label": "stone", "arena": {"kind": "crystal", "ground": "stone"}},
    {"label": "ice", "arena": {"kind": "tundra", "ground": "ice"}}
  ],
  "expect": [
    {"metric": "moveSuccess", "op": ">=", "value": 0.99, "move": "burrow"},
    {"metric": "moveSuccess", "op": "<=", "value": 0.01, "move": "burrow", "variant": "stone"},
    {"metric": "moveSuccess", "op": "<=", "value": 0.01, "move": "burrow", "variant": "ice"},
    {"metric": "hitsWhileStatus", "op": "==", "value": 0, "move": "tackle", "status": "burrowed"},
    {"metric": "hitsWhileStatus", "op": ">=", "value": 1, "move": "stomp", "status": "burrowed"},
    {"metric": "winRateA", "op": "<=", "value": 0.9, "variant": "stone", "relativeTo": "main"}
  ]
}
```

### SC-06 — Weather changers flip a neutral matchup (fire vs electric)

**Status:** ENGINE · **Tags:** `weather-flips-matchup`, `ability-weather-shaper`, `weather`

**Setup.** A: **M fire** weather shaper, lvl 12 (Cinder Spit, Flame Lance, Heatwave Call). B: **M electric** weather shaper, lvl 12 (Spark Bolt, Thunder Beam, Storm Call). Stone, clear, 14:00. Variants: *neutralSky* (no weather moves: Ember Bite / Static Fang instead), *stormOnly*, *heatOnly*.

**Expected.** No weather moves: **42-58 %**. Only B calls the storm: A **<= 25 %**. Only A calls the heatwave: A **>= 62 %**. Both call: **25-55 %** (the storm swings harder).

**Why.** Fire and electric are x1 against each other, so the sky decides. A storm gives electric x1.35 and fire x0.7, and its lightning strikes non-electric fighters (5 % max HP x conduction). Fire bodies never get wet, so electric hits on A only get the storm's x1.08, not the wet x1.3. A heatwave only gives fire x1.3.

**Mechanics.** `src/data/weather.ts` WEATHERS.storm / heatwave · `src/combat/battle.ts` setWeather(), conduction(), step() (lightning) · `src/combat/moves.ts` stormCall, heatwaveCall (require weatherShaper)

```json
{
  "id": "SC-06",
  "title": "Weather changers flip a neutral matchup (fire vs electric)",
  "tags": ["weather-flips-matchup", "ability-weather-shaper", "weather"],
  "status": "ENGINE",
  "arena": {"kind": "crystal", "ground": "stone", "weather": "clear", "hour": 14},
  "teamA": [
    {"size": "M", "primary": "fire", "level": 12, "abilities": ["weatherShaper"], "moves": ["cinderSpit", "flameLance", "heatwaveCall"]}
  ],
  "teamB": [
    {"size": "M", "primary": "electric", "level": 12, "abilities": ["weatherShaper"], "moves": ["sparkBolt", "thunderBeam", "stormCall"]}
  ],
  "seeds": 200,
  "variants": [
    {"label": "neutralSky", "teamA": [{"size": "M", "primary": "fire", "level": 12, "moves": ["cinderSpit", "flameLance", "emberBite"]}], "teamB": [{"size": "M", "primary": "electric", "level": 12, "moves": ["sparkBolt", "thunderBeam", "staticFang"]}]},
    {"label": "stormOnly", "teamA": [{"size": "M", "primary": "fire", "level": 12, "moves": ["cinderSpit", "flameLance", "emberBite"]}]},
    {"label": "heatOnly", "teamB": [{"size": "M", "primary": "electric", "level": 12, "moves": ["sparkBolt", "thunderBeam", "staticFang"]}]}
  ],
  "expect": [
    {"metric": "winRateA", "op": "between", "value": [0.42, 0.58], "variant": "neutralSky"},
    {"metric": "winRateA", "op": "<=", "value": 0.25, "variant": "stormOnly"},
    {"metric": "winRateA", "op": ">=", "value": 0.62, "variant": "heatOnly"},
    {"metric": "winRateA", "op": "between", "value": [0.25, 0.55]}
  ]
}
```

### SC-07 — Terraforming water into ice makes it slippery

**Status:** ENGINE · **Tags:** `terrain-freeze-slippery`, `ability-terraformer`, `ground-friction`

**Setup.** A: **M ice** terraformer, lvl 12 (Frost Ground, Frost Fang, Ice Shard, Tackle). B: **M neutral** quadruped, lvl 12 (Tackle, Body Slam). Water arena (0.5 m deep), clear, 14:00. Variant *noTerraform*: A without Frost Ground.

**Expected.** Frost Ground leaves **ice** on its cells (`battle.terrain` water -> ice); B slides **>= 3x** farther after A's Tackle than in *noTerraform*; Frost Fang's logged ground factor averages **>= 1.06** (1.125 on ice = 1 + 0.5 x the +0.25 ice affinity, 1.0 on water) and its mean damage is **1.03-1.19x** the *noTerraform* value.

**Why.** Frost Ground turns water into ice; ice friction is 0.05 against 0.30 for water, so knockback slides opponents across the arena (and out of melee range). The attacker's own cell adds 0.5 x its ground affinity for the move's element.

**Mechanics.** `src/combat/battle.ts` act() terrain, Battle.hit gAff · `src/data/grounds.ts` transformGround(water, ice), GROUNDS.ice.friction/affinity · `src/combat/moves.ts` frostGround (requires terraformer)

```json
{
  "id": "SC-07",
  "title": "Terraforming water into ice makes it slippery",
  "tags": ["terrain-freeze-slippery", "ability-terraformer", "ground-friction"],
  "status": "ENGINE",
  "arena": {"kind": "lake", "ground": "water", "weather": "clear", "hour": 14},
  "teamA": [
    {"size": "M", "primary": "ice", "level": 12, "abilities": ["terraformer"], "moves": ["frostGround", "frostFang", "iceShard", "tackle"]}
  ],
  "teamB": [
    {"size": "M", "primary": "neutral", "level": 12, "kind": "quadruped", "moves": ["tackle", "bodySlam"]}
  ],
  "seeds": 200,
  "variants": [
    {"label": "noTerraform", "teamA": [{"size": "M", "primary": "ice", "level": 12, "moves": ["frostFang", "iceShard", "tackle"]}]}
  ],
  "expect": [
    {"metric": "groundAfter", "op": "==", "value": "ice", "move": "frostGround"},
    {"metric": "slideDistance", "op": ">=", "value": 3, "move": "tackle", "side": "A", "relativeTo": "noTerraform"},
    {"metric": "meanHitFactor", "op": ">=", "value": 1.06, "move": "frostFang", "factor": "ground"},
    {"metric": "meanHitDamage", "op": "between", "value": [1.03, 1.19], "move": "frostFang", "relativeTo": "noTerraform"}
  ]
}
```

### SC-08 — Phase shifters melt to let blows through — and pay for it against electricity

**Status:** ENGINE · **Tags:** `phase-shift-melt-form`, `ability-phase-shift`, `status-liquid`

**Setup.** A: **M water** blob with *phaseShift*, lvl 12 (Melt/Form, Tide Slam, Water Jet). B: **M metal**, lvl 12 (Iron Ram, Steel Spike, Iron Shell). Stone, clear, 14:00. Variants: *noMelt*; *vsElectric* (B = M electric: Static Fang, Spark Bolt, Thunder Beam); *vsElectricNoMelt*.

**Expected.** Iron Ram hits on a liquid A deal **0.45-0.55x** the damage of its hits on a solid A and push it **0 m**; against metal, melting raises A's win rate to **>= 1.2x** the *noMelt* value; against electric, Spark Bolt hits on a liquid A deal **1.15-1.35x** (x1.25) and melting must **not** help (ratio **<= 1.0**).

**Why.** Melt/Form grants *liquid* for 6 s: contact hits do half damage and knockback does nothing, but electricity hits 25 % harder and a liquid body moves at 0.85x. Phase shifting is a read-the-opponent tool, not a free shield.

**Mechanics.** `src/combat/battle.ts` Battle.hit liquidK and knockback guard, movement statusK · `src/combat/moves.ts` meltForm (requires phaseShift) · `src/genome/phenotype.ts` abilities.phaseShift (form > 0.45, |phase| < 0.6)

```json
{
  "id": "SC-08",
  "title": "Phase shifters melt to let blows through — and pay for it against electricity",
  "tags": ["phase-shift-melt-form", "ability-phase-shift", "status-liquid"],
  "status": "ENGINE",
  "arena": {"kind": "crystal", "ground": "stone", "weather": "clear", "hour": 14},
  "teamA": [
    {"size": "M", "primary": "water", "level": 12, "kind": "blob", "abilities": ["phaseShift"], "moves": ["meltForm", "tideSlam", "waterJet"]}
  ],
  "teamB": [
    {"size": "M", "primary": "metal", "level": 12, "moves": ["ironRam", "steelSpike", "ironShell"]}
  ],
  "seeds": 200,
  "variants": [
    {"label": "noMelt", "teamA": [{"size": "M", "primary": "water", "level": 12, "kind": "blob", "moves": ["tideSlam", "waterJet", "tackle"]}]},
    {"label": "vsElectric", "teamB": [{"size": "M", "primary": "electric", "level": 12, "moves": ["staticFang", "sparkBolt", "thunderBeam"]}]},
    {"label": "vsElectricNoMelt", "teamA": [{"size": "M", "primary": "water", "level": 12, "kind": "blob", "moves": ["tideSlam", "waterJet", "tackle"]}], "teamB": [{"size": "M", "primary": "electric", "level": 12, "moves": ["staticFang", "sparkBolt", "thunderBeam"]}]}
  ],
  "expect": [
    {"metric": "statusDamageRatio", "op": "between", "value": [0.45, 0.55], "move": "ironRam", "status": "liquid"},
    {"metric": "winRateA", "op": ">=", "value": 1.2, "relativeTo": "noMelt"},
    {"metric": "winRateA", "op": "<=", "value": 1.0, "variant": "vsElectric", "relativeTo": "vsElectricNoMelt"},
    {"metric": "statusDamageRatio", "op": "between", "value": [1.15, 1.35], "move": "sparkBolt", "status": "liquid", "variant": "vsElectric"}
  ]
}
```

### SC-09 — Light against shadow: eclipse, and the sky decides

**Status:** ENGINE · **Tags:** `light-shadow-eclipse`, `reaction-eclipse`, `weather`

**Setup.** A: **M light**, lvl 12 (Photon Dart, Radiant Strike, Dazzle). B: **M shadow**, lvl 12 (Umbra Orb, Shadow Claw, Night Veil). Stone, clear, 14:00. Variants: *eclipseSky* (eclipse weather, 14:00), *night* (clear, 02:00).

**Expected.** Light-vs-shadow projectile clashes produce *eclipse* **>= 95 %** of the time. At 14:00 A wins **>= 65 %**; under an eclipse sky A wins **<= 40 %**; at 02:00 design target **40-60 %** (predicted miss: light's tier-1 moves still out-damage shadow's).

**Why.** Light and shadow hit each other x2 both ways, so time and sky decide: by day light x1.1 and shadow x0.9 (a x1.22 swing), by night the reverse; an eclipse sky gives shadow x1.3 and light x0.75. Eclipse as a reaction appears where light and shadow meet in space (clashing projectiles, zones), not on every hit. Photon Dart (47.5 dmg/s at 0.98 accuracy) out-damages Umbra Orb (36.0), which is why night parity is only a target.

**Mechanics.** `src/combat/battle.ts` rhythmMult(), projectile clash · `src/data/elements.ts` REACTIONS.eclipse, CHART · `src/data/weather.ts` eclipse

```json
{
  "id": "SC-09",
  "title": "Light against shadow: eclipse, and the sky decides",
  "tags": ["light-shadow-eclipse", "reaction-eclipse", "weather"],
  "status": "ENGINE",
  "arena": {"kind": "crystal", "ground": "stone", "weather": "clear", "hour": 14},
  "teamA": [
    {"size": "M", "primary": "light", "level": 12, "moves": ["photonDart", "radiantStrike", "dazzle"]}
  ],
  "teamB": [
    {"size": "M", "primary": "shadow", "level": 12, "moves": ["umbraOrb", "shadowClaw", "nightVeil"]}
  ],
  "seeds": 200,
  "variants": [
    {"label": "eclipseSky", "arena": {"weather": "eclipse"}},
    {"label": "night", "arena": {"hour": 2}}
  ],
  "expect": [
    {"metric": "clashReactionShare", "op": ">=", "value": 0.95, "reaction": "eclipse"},
    {"metric": "winRateA", "op": ">=", "value": 0.65},
    {"metric": "winRateA", "op": "<=", "value": 0.4, "variant": "eclipseSky"},
    {"metric": "winRateA", "op": "between", "value": [0.4, 0.6], "variant": "night", "target": true}
  ]
}
```

### SC-10 — Synergy: a water + electric pair against a pair with no reaction

**Status:** ENGINE · **Tags:** `synergy-water-electric`, `reaction-conduction`, `team-building`, `friendly-fire`

**Setup.** A: **S water** (Water Jet, Riptide, Tide Slam) + **M electric** (Spark Bolt, Discharge, Static Fang), lvl 30, 3 slots. B: **M neutral** (Tackle, Stomp, Body Slam) + **S neutral** (Tackle, Stomp), lvl 30, 3 slots. Stone, clear, 14:00. Variant *noSynergy*: A's electric member replaced by an M psychic with near-identical move power (Mind Spike, Psy Storm, Psi Beam).

**Expected.** With synergy A wins **58-85 %**, without **40-60 %**. The *Conductor* synergy shows on every Spark Bolt hit (team factor **>= 1.15**); Spark Bolt's mean conduction factor is **>= 0.80** (0.70 on a dry target, 0.91 on one soaked by Riptide); **<= 20 %** of chained current lands on A's own Genemon.

**Why.** Water + electric is the conduction pair: Riptide soaks targets (wet: electric x1.3), the Conductor synergy adds x1.15 to electric damage, and every hit on a wet target chains 45 % to the other wet bodies within 4.5 m — allies included. Psychic + water has no reaction and no synergy. Neutral opponents remove the type chart, so the gap is pure synergy.

**Mechanics.** `src/combat/team.ts` synergies (Conductor) · `src/combat/battle.ts` Battle.hit (current chain), conduction() · `src/combat/moves.ts` riptide, discharge

```json
{
  "id": "SC-10",
  "title": "Synergy: a water + electric pair against a pair with no reaction",
  "tags": ["synergy-water-electric", "reaction-conduction", "team-building", "friendly-fire"],
  "status": "ENGINE",
  "arena": {"kind": "crystal", "ground": "stone", "weather": "clear", "hour": 14},
  "teamA": [
    {"size": "S", "primary": "water", "level": 30, "moves": ["waterJet", "riptide", "tideSlam"]},
    {"size": "M", "primary": "electric", "level": 30, "moves": ["sparkBolt", "discharge", "staticFang"]}
  ],
  "teamB": [
    {"size": "M", "primary": "neutral", "level": 30, "moves": ["tackle", "stomp", "bodySlam"]},
    {"size": "S", "primary": "neutral", "level": 30, "moves": ["tackle", "stomp"]}
  ],
  "seeds": 200,
  "variants": [
    {"label": "noSynergy", "teamA": [{"size": "S", "primary": "water", "level": 30, "moves": ["waterJet", "riptide", "tideSlam"]}, {"size": "M", "primary": "psychic", "level": 30, "moves": ["mindSpike", "psyStorm", "psiBeam"]}]}
  ],
  "expect": [
    {"metric": "winRateA", "op": "between", "value": [0.58, 0.85]},
    {"metric": "winRateA", "op": "between", "value": [0.4, 0.6], "variant": "noSynergy"},
    {"metric": "meanHitFactor", "op": ">=", "value": 1.15, "move": "sparkBolt", "factor": "team"},
    {"metric": "meanHitFactor", "op": ">=", "value": 0.8, "move": "sparkBolt", "factor": "conduction"},
    {"metric": "friendlyShare", "op": "<=", "value": 0.2, "reaction": "conduction"}
  ]
}
```

### SC-11 — Big against swarm, slot for slot

**Status:** ENGINE · **Tags:** `big-vs-swarm-slots`, `size-budget`, `team-building`

**Setup.** A: one **XL neutral** quadruped, lvl 30 (Body Slam, Stomp, Tackle) — 4 slots. B: four **S neutral**, lvl 30 (Tackle, Stomp) — 4 slots. Stone, clear, 14:00. Variants: *mVs2s* (one M vs two S) and *lVs3s* (one L vs three S).

**Expected.** Design target for every slot-equal pairing: **40-60 %**. Measured 2026-10-12 by `tools/balance.ts` section 2 (random elements and arenas, n = 36 per pairing, CI about +-15 points): XL vs 4 S **44 %**, L vs 3 S **50 %**, M vs 2 S **42 %**.

**Why.** Budgets per class are XS 0.85, S 1, M 2, L 2.9, XL 4.1 (`POWER_BUDGET`, about one unit per slot). The focus-fire estimate (a lone body keeps its damage until it dies while a swarm loses damage with every knockout, so it wins when budget^2 > N(N+1)/2, i.e. above 1.73 / 2.45 / 3.16) predicted that the old budgets 1.9 / 2.75 / 3.5 favoured the big body. The harness measured the opposite: **XL vs 4 S won 28 %**, because a swarm also brings N energy pools, N evasion rolls and N status appliers, and single-target overkill is wasted. The engine now answers with mechanics instead of a raw-power gap: melee **cleave** for 3+-slot bodies (50 % to other enemies in a 60-degree frontal arc), **tenacity** (harmful statuses on a big body last 1 / (1 + 0.2 (slots - 1))), projectile hit radius growing with height, and the contact size factor (massRatio^0.1, ^0.22 for mass-scaled slams, clamped 0.75-1.4). The precondition test now pins "budget per slot within +-20 %", not "XL below 4 S".

**Mechanics.** `src/genome/phenotype.ts` POWER_BUDGET, SLOT_COST · `src/combat/battle.ts` Battle.hit size factor · `src/combat/team.ts` Guardian / Pack synergies

```json
{
  "id": "SC-11",
  "title": "Big against swarm, slot for slot",
  "tags": ["big-vs-swarm-slots", "size-budget", "team-building"],
  "status": "ENGINE",
  "arena": {"kind": "crystal", "ground": "stone", "weather": "clear", "hour": 14},
  "teamA": [
    {"size": "XL", "primary": "neutral", "level": 30, "kind": "quadruped", "moves": ["bodySlam", "stomp", "tackle"]}
  ],
  "teamB": [
    {"size": "S", "primary": "neutral", "level": 30, "moves": ["tackle", "stomp"]},
    {"size": "S", "primary": "neutral", "level": 30, "moves": ["tackle", "stomp"]},
    {"size": "S", "primary": "neutral", "level": 30, "moves": ["tackle", "stomp"]},
    {"size": "S", "primary": "neutral", "level": 30, "moves": ["tackle", "stomp"]}
  ],
  "seeds": 200,
  "variants": [
    {"label": "mVs2s", "teamA": [{"size": "M", "primary": "neutral", "level": 30, "moves": ["bodySlam", "stomp", "tackle"]}], "teamB": [{"size": "S", "primary": "neutral", "level": 30, "moves": ["tackle", "stomp"]}, {"size": "S", "primary": "neutral", "level": 30, "moves": ["tackle", "stomp"]}]},
    {"label": "lVs3s", "teamA": [{"size": "L", "primary": "neutral", "level": 30, "moves": ["bodySlam", "stomp", "tackle"]}], "teamB": [{"size": "S", "primary": "neutral", "level": 30, "moves": ["tackle", "stomp"]}, {"size": "S", "primary": "neutral", "level": 30, "moves": ["tackle", "stomp"]}, {"size": "S", "primary": "neutral", "level": 30, "moves": ["tackle", "stomp"]}]}
  ],
  "expect": [
    {"metric": "winRateA", "op": "between", "value": [0.4, 0.6], "target": true},
    {"metric": "winRateA", "op": "between", "value": [0.4, 0.6], "variant": "mVs2s", "target": true},
    {"metric": "winRateA", "op": "between", "value": [0.4, 0.6], "variant": "lVs3s", "target": true}
  ]
}
```

### SC-12 — Night owls and day birds

**Status:** ENGINE · **Tags:** `night-day-rhythm`, `axis-rhythm`, `real-time`

**Setup.** A: **M neutral nocturnal** (rhythm -0.8) vs B: **M neutral diurnal** (rhythm +0.8), both lvl 12 with Tackle and Body Slam. Stone, clear, at 02:00 (main), 14:00 (*noon*) and 07:00 (*dawn*).

**Expected.** A wins **>= 60 %** at 02:00 and **<= 40 %** at 14:00 and at 07:00 (day starts at 07:00 sharp). A's logged rhythm factor is **1.04-1.06** at night and **0.94-0.96** by day.

**Why.** battle.ts splits the day at 07:00 and 19:00 local time: attack x (1 + 0.06 x rhythm) by day and x (1 - 0.06 x rhythm) by night, so a nocturnal Genemon (rhythm -0.8) hits x1.048 at night and x0.952 by day and the diurnal one the reverse — a 10 % swing in a mirror match. The step is abrupt; P6 proposes the smooth cosine `epigenetics.ts` already uses.

**Mechanics.** `src/combat/battle.ts` rhythmMult(), isDay() · `src/data/axes.ts` rhythm

```json
{
  "id": "SC-12",
  "title": "Night owls and day birds",
  "tags": ["night-day-rhythm", "axis-rhythm", "real-time"],
  "status": "ENGINE",
  "arena": {"kind": "crystal", "ground": "stone", "weather": "clear", "hour": 2},
  "teamA": [
    {"size": "M", "primary": "neutral", "level": 12, "axes": {"rhythm": -0.8}, "moves": ["tackle", "bodySlam"]}
  ],
  "teamB": [
    {"size": "M", "primary": "neutral", "level": 12, "axes": {"rhythm": 0.8}, "moves": ["tackle", "bodySlam"]}
  ],
  "seeds": 200,
  "variants": [
    {"label": "noon", "arena": {"hour": 14}},
    {"label": "dawn", "arena": {"hour": 7}}
  ],
  "expect": [
    {"metric": "winRateA", "op": ">=", "value": 0.6},
    {"metric": "winRateA", "op": "<=", "value": 0.4, "variant": "noon"},
    {"metric": "winRateA", "op": "<=", "value": 0.4, "variant": "dawn"},
    {"metric": "meanHitFactor", "op": "between", "value": [1.04, 1.06], "move": "tackle", "factor": "rhythm"},
    {"metric": "meanHitFactor", "op": "between", "value": [0.94, 0.96], "move": "tackle", "factor": "rhythm", "variant": "noon"}
  ]
}
```

### SC-13 — Mirror parity: the harness itself is fair

**Status:** ENGINE · **Tags:** `harness-validity`, `mirror`

**Setup.** Two identical **M fire**, lvl 12 (Cinder Spit, Ember Bite, Flame Lance). Stone, clear, 14:00, 1000 seeds.

**Expected.** A wins **47-53 %** of decisive fights; draws are reported separately.

**Why.** A mirror must be a coin flip. Any skew means first-attacker bias or a shared RNG stream, and every other scenario's number is then meaningless. Run this one first.

**Mechanics.** `src/combat/battle.ts` one Rng per fighter (hashSeed(seed, id, team, slot)), initial cooldown by slot order · `src/core/rng.ts`

```json
{
  "id": "SC-13",
  "title": "Mirror parity: the harness itself is fair",
  "tags": ["harness-validity", "mirror"],
  "status": "ENGINE",
  "arena": {"kind": "crystal", "ground": "stone", "weather": "clear", "hour": 14},
  "teamA": [
    {"size": "M", "primary": "fire", "level": 12, "moves": ["cinderSpit", "emberBite", "flameLance"]}
  ],
  "teamB": [
    {"size": "M", "primary": "fire", "level": 12, "moves": ["cinderSpit", "emberBite", "flameLance"]}
  ],
  "seeds": 1000,
  "expect": [
    {"metric": "winRateA", "op": "between", "value": [0.47, 0.53]}
  ]
}
```

### SC-14 — XS against S for the same slot

**Status:** ENGINE · **Tags:** `size-budget`, `xs-value`

**Setup.** A: **XS neutral** vs B: **S neutral**, lvl 12, Tackle + Stomp, one slot each. Stone, clear, 14:00.

**Expected.** Design target **40-60 %** (flagged): the current data predicts S wins ~65 % or more.

**Why.** XS gets a 0.85 budget for the same slot that buys an S at 1.0, and only +0.06 evasion in return; measured wild averages are 77.6 power for XS vs 91.3 for S, and contact hits favour the heavier S (size factor). XS needs a perk to ever be picked: two XS per slot, a smaller hitbox, or a stealth/dodge bonus.

**Mechanics.** `src/genome/phenotype.ts` POWER_BUDGET, SLOT_COST, evasion · `src/combat/battle.ts` Battle.hit size factor

```json
{
  "id": "SC-14",
  "title": "XS against S for the same slot",
  "tags": ["size-budget", "xs-value"],
  "status": "ENGINE",
  "arena": {"kind": "crystal", "ground": "stone", "weather": "clear", "hour": 14},
  "teamA": [
    {"size": "XS", "primary": "neutral", "level": 12, "moves": ["tackle", "stomp"]}
  ],
  "teamB": [
    {"size": "S", "primary": "neutral", "level": 12, "moves": ["tackle", "stomp"]}
  ],
  "seeds": 200,
  "expect": [
    {"metric": "winRateA", "op": "between", "value": [0.4, 0.6], "target": true}
  ]
}
```

### SC-15 — Fire on grass: wildfire and ash

**Status:** ENGINE · **Tags:** `reaction-wildfire`, `ground-transform`

**Setup.** A: **M fire**, lvl 30 (Inferno Burst, Scorch Field, Ember Bite) vs B: **M plant**, lvl 30 (Thorn Spray, Sap Mend, Vine Lash). Grass, clear, 14:00.

**Expected.** Wildfire fires in **>= 95 %** of fights; Inferno Burst leaves **ash**; A wins **>= 90 %**.

**Why.** Wildfire (fire landing on grass, x1.2, burning zone); the burnt cells turn to ash, which strips the plant's grass affinity mid-fight.

**Mechanics.** `src/combat/battle.ts` groundImpact · `src/data/elements.ts` REACTIONS.wildfire · `src/data/grounds.ts` transformGround(grass, fire)

```json
{
  "id": "SC-15",
  "title": "Fire on grass: wildfire and ash",
  "tags": ["reaction-wildfire", "ground-transform"],
  "status": "ENGINE",
  "arena": {"kind": "meadow", "ground": "grass", "weather": "clear", "hour": 14},
  "teamA": [
    {"size": "M", "primary": "fire", "level": 30, "moves": ["infernoBurst", "scorchField", "emberBite"]}
  ],
  "teamB": [
    {"size": "M", "primary": "plant", "level": 30, "moves": ["thornSpray", "sapMend", "vineLash"]}
  ],
  "seeds": 200,
  "expect": [
    {"metric": "battlesWithReaction", "op": ">=", "value": 0.95, "reaction": "wildfire"},
    {"metric": "groundAfter", "op": "==", "value": "ash", "move": "infernoBurst"},
    {"metric": "winRateA", "op": ">=", "value": 0.9}
  ]
}
```

### SC-16 — Fog favours melee

**Status:** ENGINE · **Tags:** `weather-fog`, `range-vs-melee`

**Setup.** A: **M metal brawler** (Iron Ram, Iron Shell) vs B: **M metal sniper** (Steel Spike, Iron Shell), lvl 12. Stone, fog, 14:00. Variant *clearSky*.

**Expected.** The brawler wins **>= 60 %** in fog and **30-60 %** in clear weather.

**Why.** Fog's visibility 0.55 multiplies ranged accuracy fully (Steel Spike 0.90 -> ~0.50) but melee and bursts only by 0.55^0.3 = 0.84. Mirrored elements remove the chart.

**Mechanics.** `src/combat/battle.ts` hitChance() · `src/data/weather.ts` WEATHERS.fog.visibility

```json
{
  "id": "SC-16",
  "title": "Fog favours melee",
  "tags": ["weather-fog", "range-vs-melee"],
  "status": "ENGINE",
  "arena": {"kind": "crystal", "ground": "stone", "weather": "fog", "hour": 14},
  "teamA": [
    {"size": "M", "primary": "metal", "level": 12, "moves": ["ironRam", "ironShell"]}
  ],
  "teamB": [
    {"size": "M", "primary": "metal", "level": 12, "moves": ["steelSpike", "ironShell"]}
  ],
  "seeds": 200,
  "variants": [
    {"label": "clearSky", "arena": {"weather": "clear"}}
  ],
  "expect": [
    {"metric": "winRateA", "op": ">=", "value": 0.6},
    {"metric": "winRateA", "op": "between", "value": [0.3, 0.6], "variant": "clearSky"}
  ]
}
```

### SC-17 — Rain makes everyone conduct

**Status:** ENGINE · **Tags:** `weather-rain`, `reaction-conduction`

**Setup.** A: **M electric** (Spark Bolt, Static Fang) vs B: **M neutral** (Tackle), lvl 12. Stone, rain, 14:00. Variant *clearSky*.

**Expected.** Spark Bolt's logged conduction factor on stone is **0.98** in rain (0.7 x 1.3 wet x 1.08 rainy sky) and **0.70** in clear weather, each +-0.01; mean damage rain/clear **1.4-1.7** (contract 1.54 with rain's electric x1.1).

**Why.** Rain (wetness 0.5 >= 0.45) soaks every non-fire fighter, wet targets conduct x1.3, and any sky wetter than 0.4 adds x1.08: you do not need a water partner when the sky is one.

**Mechanics.** `src/combat/battle.ts` conduction(), step() (wet from weather) · `src/data/weather.ts` WEATHERS.rain

```json
{
  "id": "SC-17",
  "title": "Rain makes everyone conduct",
  "tags": ["weather-rain", "reaction-conduction"],
  "status": "ENGINE",
  "arena": {"kind": "crystal", "ground": "stone", "weather": "rain", "hour": 14},
  "teamA": [
    {"size": "M", "primary": "electric", "level": 12, "moves": ["sparkBolt", "staticFang"]}
  ],
  "teamB": [
    {"size": "M", "primary": "neutral", "level": 12, "moves": ["tackle"]}
  ],
  "seeds": 200,
  "variants": [
    {"label": "clearSky", "arena": {"weather": "clear"}}
  ],
  "expect": [
    {"metric": "meanHitFactor", "op": "between", "value": [0.97, 0.99], "move": "sparkBolt", "factor": "conduction"},
    {"metric": "meanHitFactor", "op": "between", "value": [0.69, 0.71], "move": "sparkBolt", "factor": "conduction", "variant": "clearSky"},
    {"metric": "meanHitDamage", "op": "between", "value": [1.4, 1.7], "move": "sparkBolt", "relativeTo": "clearSky"}
  ]
}
```

### SC-18 — Water on earth: the ground turns to mud

**Status:** ENGINE · **Tags:** `reaction-mud`, `ground-transform`, `movement`

**Setup.** A: **M water** (Water Jet, Tide Slam, Hydro Beam) vs B: **M earth** brawler (Boulder Crush, Rock Toss), lvl 12. Soil, clear, 14:00.

**Expected.** **>= 90 %** of Water Jet impacts on earth ground make mud; B moves at **<= 0.7x** its stat speed on mud; A wins **>= 80 %**.

**Why.** Water landing on earth ground (soil, and mud, which still counts as earth) makes the mud reaction (2.8 m slow zone) and turns soil into mud (move cost 0.6); water hits earth x2 while earth hits water x1.

**Mechanics.** `src/combat/battle.ts` groundImpact (GROUND_ELEMENT) · `src/data/elements.ts` REACTIONS.mud · `src/data/grounds.ts` transformGround(soil, water), GROUNDS.mud.moveCost

```json
{
  "id": "SC-18",
  "title": "Water on earth: the ground turns to mud",
  "tags": ["reaction-mud", "ground-transform", "movement"],
  "status": "ENGINE",
  "arena": {"kind": "meadow", "ground": "soil", "weather": "clear", "hour": 14},
  "teamA": [
    {"size": "M", "primary": "water", "level": 12, "moves": ["waterJet", "tideSlam", "hydroBeam"]}
  ],
  "teamB": [
    {"size": "M", "primary": "earth", "level": 12, "moves": ["boulderCrush", "rockToss"]}
  ],
  "seeds": 200,
  "expect": [
    {"metric": "reactionsPerHit", "op": ">=", "value": 0.9, "move": "waterJet", "reaction": "mud"},
    {"metric": "moveSpeed", "op": "<=", "value": 0.7, "side": "B", "ground": "mud"},
    {"metric": "winRateA", "op": ">=", "value": 0.8}
  ]
}
```

### SC-19 — Electricity magnetises metal

**Status:** ENGINE · **Tags:** `reaction-magnetize`, `ground-conductivity`

**Setup.** A: **M electric** (Static Fang, Spark Bolt, Thunder Beam) vs B: **M metal** (Iron Ram, Steel Spike, Magnet Pull), lvl 12. Stone, clear, 14:00. Variant *metalFloor* (the Neon Plaza's metal plates).

**Expected.** A wins **>= 85 %**. On stone Spark Bolt never magnetizes (**<= 5 %** of hits: electric and earth do not react); on a metal floor **>= 90 %** of Spark Bolt impacts magnetize and its conduction factor is **1.80** against **0.70** on stone (+-0.01).

**Why.** Electric hits metal x2 and metal hits electric x0.5. Magnetize (x1.25, a stagger pull) comes from electricity landing on metal ground — a spatial reaction, not a property of the metal Genemon. Metal plate is the best conductor in the game (1.8).

**Mechanics.** `src/combat/battle.ts` groundImpact (GROUND_ELEMENT.metal), conduction() · `src/data/elements.ts` REACTIONS.magnetize · `src/data/grounds.ts` GROUNDS.metal

```json
{
  "id": "SC-19",
  "title": "Electricity magnetises metal",
  "tags": ["reaction-magnetize", "ground-conductivity"],
  "status": "ENGINE",
  "arena": {"kind": "crystal", "ground": "stone", "weather": "clear", "hour": 14},
  "teamA": [
    {"size": "M", "primary": "electric", "level": 12, "moves": ["staticFang", "sparkBolt", "thunderBeam"]}
  ],
  "teamB": [
    {"size": "M", "primary": "metal", "level": 12, "moves": ["ironRam", "steelSpike", "magnetPull"]}
  ],
  "seeds": 200,
  "variants": [
    {"label": "metalFloor", "arena": {"kind": "city", "ground": "metal"}}
  ],
  "expect": [
    {"metric": "winRateA", "op": ">=", "value": 0.85},
    {"metric": "reactionsPerHit", "op": "<=", "value": 0.05, "move": "sparkBolt", "reaction": "magnetize"},
    {"metric": "reactionsPerHit", "op": ">=", "value": 0.9, "move": "sparkBolt", "reaction": "magnetize", "variant": "metalFloor"},
    {"metric": "meanHitFactor", "op": "between", "value": [1.79, 1.81], "move": "sparkBolt", "factor": "conduction", "variant": "metalFloor"},
    {"metric": "meanHitFactor", "op": "between", "value": [0.69, 0.71], "move": "sparkBolt", "factor": "conduction"}
  ]
}
```

### SC-20 — Sandstorm grinds the unarmoured

**Status:** ENGINE · **Tags:** `weather-sandstorm`

**Setup.** A: **M earth** (Rock Toss, Boulder Crush) vs B: **M air** (Air Cutter, Gale Slash), lvl 12. Sand, sandstorm, 14:00. Variant *clearSky*.

**Expected.** A wins **>= 60 %** in the sandstorm and **35-65 %** in clear weather.

**Why.** Earth and air resist each other x0.5 both ways, so weather decides: the sandstorm gives earth x1.2 (air x1.1) and drains every non-earth, non-metal fighter over time.

**Mechanics.** `src/combat/battle.ts` step() (sandstorm damage over time) · `src/data/weather.ts` WEATHERS.sandstorm

```json
{
  "id": "SC-20",
  "title": "Sandstorm grinds the unarmoured",
  "tags": ["weather-sandstorm"],
  "status": "ENGINE",
  "arena": {"kind": "canyon", "ground": "sand", "weather": "sandstorm", "hour": 14},
  "teamA": [
    {"size": "M", "primary": "earth", "level": 12, "moves": ["rockToss", "boulderCrush"]}
  ],
  "teamB": [
    {"size": "M", "primary": "air", "level": 12, "moves": ["airCutter", "galeSlash"]}
  ],
  "seeds": 200,
  "variants": [
    {"label": "clearSky", "arena": {"weather": "clear"}}
  ],
  "expect": [
    {"metric": "winRateA", "op": ">=", "value": 0.6},
    {"metric": "winRateA", "op": "between", "value": [0.35, 0.65], "variant": "clearSky"}
  ]
}
```

### SC-21 — A hard counter no weather can fix

**Status:** ENGINE · **Tags:** `type-chart-floor`, `weather-acid-rain`

**Setup.** A: **M poison** (Venom Fang, Toxic Spit, Corrosion) vs B: **M metal** (Iron Ram, Steel Spike), lvl 12. Stone, acid rain, 14:00. Variant *clearSky*.

**Expected.** A wins **<= 15 %** even in acid rain and **<= 10 %** in clear weather.

**Why.** Poison hits metal x0.25 (the chart floor). Acid rain gives poison x1.3 and metal x0.85, which only lifts the gap to 0.33x: weather tilts a matchup, it does not erase a 4x one. Corrosion's *softened* is poison's only out.

**Mechanics.** `src/data/elements.ts` CHART poison->metal 0.25, typeMultiplier clamp · `src/data/weather.ts` WEATHERS.acidRain

```json
{
  "id": "SC-21",
  "title": "A hard counter no weather can fix",
  "tags": ["type-chart-floor", "weather-acid-rain"],
  "status": "ENGINE",
  "arena": {"kind": "crystal", "ground": "stone", "weather": "acidRain", "hour": 14},
  "teamA": [
    {"size": "M", "primary": "poison", "level": 12, "moves": ["venomFang", "toxicSpit", "corrosion"]}
  ],
  "teamB": [
    {"size": "M", "primary": "metal", "level": 12, "moves": ["ironRam", "steelSpike"]}
  ],
  "seeds": 200,
  "variants": [
    {"label": "clearSky", "arena": {"weather": "clear"}}
  ],
  "expect": [
    {"metric": "winRateA", "op": "<=", "value": 0.15},
    {"metric": "winRateA", "op": "<=", "value": 0.1, "variant": "clearSky"}
  ]
}
```

### SC-22 — A heatwave melts the rink

**Status:** ENGINE · **Tags:** `weather-heatwave`, `ground-transform`, `reaction-melt`

**Setup.** A: **M fire** (Cinder Spit, Flame Lance) vs B: **M ice** (Ice Shard, Cryo Beam), lvl 12. Ice arena, heatwave, 14:00. Variant *snowSky*.

**Expected.** After 60 s of heatwave **>= 50 %** of the rink is water, **<= 5 %** under snow (which refreezes water); melt fires in **>= 95 %** of fights; A wins **>= 85 %**.

**Why.** A heatwave melts random ice and snow cells every 15 ticks and fire impacts on ice make the melt reaction (ice -> water); snow refreezes water every 20 ticks. Fire hits ice x2 and the heatwave adds fire x1.3 / ice x0.7; as the rink melts, the ice Genemon loses its ice-ground affinity.

**Mechanics.** `src/combat/battle.ts` step() (heatwave / snow cells), groundImpact · `src/data/elements.ts` REACTIONS.melt · `src/data/grounds.ts` transformGround(ice, fire)

```json
{
  "id": "SC-22",
  "title": "A heatwave melts the rink",
  "tags": ["weather-heatwave", "ground-transform", "reaction-melt"],
  "status": "ENGINE",
  "arena": {"kind": "tundra", "ground": "ice", "weather": "heatwave", "hour": 14},
  "teamA": [
    {"size": "M", "primary": "fire", "level": 12, "moves": ["cinderSpit", "flameLance"]}
  ],
  "teamB": [
    {"size": "M", "primary": "ice", "level": 12, "moves": ["iceShard", "cryoBeam"]}
  ],
  "seeds": 200,
  "variants": [
    {"label": "snowSky", "arena": {"weather": "snow"}}
  ],
  "expect": [
    {"metric": "groundShare", "op": ">=", "value": 0.5, "ground": "water"},
    {"metric": "groundShare", "op": "<=", "value": 0.05, "ground": "water", "variant": "snowSky"},
    {"metric": "battlesWithReaction", "op": ">=", "value": 0.95, "reaction": "melt"},
    {"metric": "winRateA", "op": ">=", "value": 0.85}
  ]
}
```

### SC-23 — Wet targets freeze

**Status:** ENGINE · **Tags:** `status-frozen-wet`, `team-building`, `synergy-glacier`

**Setup.** A: **S water** (Riptide, Water Jet) + **M ice** (Cryo Beam, Frost Fang, Hail Burst), lvl 30, vs B: **M neutral** (Tackle, Body Slam). Stone, clear, 14:00. Variant *noWater*: an S neutral (Tackle, Stomp) replaces the water partner.

**Expected.** B spends **>= 2x** more time frozen than in *noWater*.

**Why.** An ice hit on a wet target gets +0.2 frozen chance and the Glacier synergy (ice + water on one team) multiplies ice status chances x1.5: Cryo Beam's 20 % becomes 50 % on a soaked target. The freeze reaction itself is spatial (ice landing on water ground or in a water zone).

**Mechanics.** `src/combat/battle.ts` Battle.hit (status roll, frozen +0.2 when wet) · `src/combat/team.ts` Glacier · `src/combat/moves.ts` riptide, cryoBeam

```json
{
  "id": "SC-23",
  "title": "Wet targets freeze",
  "tags": ["status-frozen-wet", "team-building", "synergy-glacier"],
  "status": "ENGINE",
  "arena": {"kind": "crystal", "ground": "stone", "weather": "clear", "hour": 14},
  "teamA": [
    {"size": "S", "primary": "water", "level": 30, "moves": ["riptide", "waterJet"]},
    {"size": "M", "primary": "ice", "level": 30, "moves": ["cryoBeam", "frostFang", "hailBurst"]}
  ],
  "teamB": [
    {"size": "M", "primary": "neutral", "level": 30, "moves": ["tackle", "bodySlam"]}
  ],
  "seeds": 200,
  "variants": [
    {"label": "noWater", "teamA": [{"size": "S", "primary": "neutral", "level": 30, "moves": ["tackle", "stomp"]}, {"size": "M", "primary": "ice", "level": 30, "moves": ["cryoBeam", "frostFang", "hailBurst"]}]}
  ],
  "expect": [
    {"metric": "statusUptime", "op": ">=", "value": 2, "status": "frozen", "side": "B", "relativeTo": "noWater"}
  ]
}
```

### SC-24 — Wind on earth: a dust cloud

**Status:** ENGINE · **Tags:** `reaction-dust`, `accuracy-zone`

**Setup.** A: **M air** (Air Cutter, Gale Slash) vs B: **M earth** (Rock Toss, Boulder Crush), lvl 12. Soil, clear, 14:00.

**Expected.** Dust on **>= 90 %** of Air Cutter impacts on soil; attacks fired from inside the cloud keep **<= 0.85x** their accuracy (0.80).

**Why.** Dust (air landing on earth ground, 3.5 m / 5 s, x0.9) is the air team's answer to rock throwers: the cloud blinds whoever attacks from inside it.

**Mechanics.** `src/combat/battle.ts` groundImpact, hitChance() (zone accuracy) · `src/data/elements.ts` REACTIONS.dust

```json
{
  "id": "SC-24",
  "title": "Wind on earth: a dust cloud",
  "tags": ["reaction-dust", "accuracy-zone"],
  "status": "ENGINE",
  "arena": {"kind": "meadow", "ground": "soil", "weather": "clear", "hour": 14},
  "teamA": [
    {"size": "M", "primary": "air", "level": 12, "moves": ["airCutter", "galeSlash"]}
  ],
  "teamB": [
    {"size": "M", "primary": "earth", "level": 12, "moves": ["rockToss", "boulderCrush"]}
  ],
  "seeds": 200,
  "expect": [
    {"metric": "reactionsPerHit", "op": ">=", "value": 0.9, "move": "airCutter", "reaction": "dust"},
    {"metric": "zoneAccuracyRatio", "op": "<=", "value": 0.85, "reaction": "dust"}
  ]
}
```

### SC-25 — Deep water belongs to swimmers

**Status:** ENGINE · **Tags:** `ability-swim`, `ground-depth`, `movement`

**Setup.** A: **M water** swimmer (Tide Slam, Water Jet) vs B: **M neutral** non-swimmer (Tackle, Body Slam), lvl 12. Deep water (2.5 m), clear, 14:00. Variant *stoneFloor*.

**Expected.** A wins **>= 75 %** in deep water and **40-60 %** on stone; B moves at **<= 0.4x** its stat speed in deep water.

**Why.** Deep water has move cost 0.35 for walkers and a +0.3 water affinity; swimmers are not slowed.

**Mechanics.** `src/data/grounds.ts` GROUNDS.deepWater · `src/genome/phenotype.ts` abilities.swim · `src/combat/battle.ts` movement (non-swimmers avoid deep water)

```json
{
  "id": "SC-25",
  "title": "Deep water belongs to swimmers",
  "tags": ["ability-swim", "ground-depth", "movement"],
  "status": "ENGINE",
  "arena": {"kind": "beach", "ground": "deepWater", "weather": "clear", "hour": 14},
  "teamA": [
    {"size": "M", "primary": "water", "level": 12, "abilities": ["swim"], "moves": ["tideSlam", "waterJet"]}
  ],
  "teamB": [
    {"size": "M", "primary": "neutral", "level": 12, "moves": ["tackle", "bodySlam"]}
  ],
  "seeds": 200,
  "variants": [
    {"label": "stoneFloor", "arena": {"kind": "crystal", "ground": "stone"}}
  ],
  "expect": [
    {"metric": "winRateA", "op": ">=", "value": 0.75},
    {"metric": "winRateA", "op": "between", "value": [0.4, 0.6], "variant": "stoneFloor"},
    {"metric": "moveSpeed", "op": "<=", "value": 0.4, "side": "B", "ground": "deepWater"}
  ]
}
```

### SC-26 — Mass-scaled knockback

**Status:** ENGINE · **Tags:** `knockback`, `size-budget`

**Setup.** A: **XL neutral** (Body Slam, Tackle) vs B: **S neutral** (Body Slam, Tackle), lvl 12. Stone, clear, 14:00. Variant *swapped* (the S is side A).

**Expected.** The XL's Body Slam pushes the S **>= 3x** farther than the S's Body Slam pushes the XL.

**Why.** battle.ts scales knockback by clamp(sqrt(massRatio), 0.5, 2): an XL pushing an S gets the x2 cap, an S pushing an XL the x0.5 floor, and the heavier body also resists with balance. Body Slam carries `massScaled`, which steepens its damage size factor too.

**Mechanics.** `src/combat/battle.ts` Battle.hit knockback · `src/combat/moves.ts` bodySlam (massScaled) · `src/genome/phenotype.ts` stats.balance, MASS_THRESHOLDS

```json
{
  "id": "SC-26",
  "title": "Mass-scaled knockback",
  "tags": ["knockback", "size-budget"],
  "status": "ENGINE",
  "arena": {"kind": "crystal", "ground": "stone", "weather": "clear", "hour": 14},
  "teamA": [
    {"size": "XL", "primary": "neutral", "level": 12, "moves": ["bodySlam", "tackle"]}
  ],
  "teamB": [
    {"size": "S", "primary": "neutral", "level": 12, "moves": ["bodySlam", "tackle"]}
  ],
  "seeds": 200,
  "variants": [
    {"label": "swapped", "teamA": [{"size": "S", "primary": "neutral", "level": 12, "moves": ["bodySlam", "tackle"]}], "teamB": [{"size": "XL", "primary": "neutral", "level": 12, "moves": ["bodySlam", "tackle"]}]}
  ],
  "expect": [
    {"metric": "slideDistance", "op": ">=", "value": 3, "move": "bodySlam", "side": "A", "relativeTo": "swapped"}
  ]
}
```

### SC-27 — Interrupt the long charge

**Status:** PROPOSAL · **Tags:** `timing-charge`, `status-staggered`

**Setup.** A: **M neutral** striker (Stomp, Body Slam, Tackle) vs B: **M light** artillery (Solar Beam, Photon Dart), lvl 30. Stone, clear, 14:00. Variant *noStagger* (A has only Tackle).

**Expected.** Design target (P3): **>= 25 %** of Solar Beam charges interrupted by A's stagger moves, **<= 5 %** in *noStagger*. Today a stagger blocks the next decision and zeroes evasion but does not cancel a charge already running (only *frozen* pauses one), so both are reported as targets.

**Why.** Solar Beam charges for 1.6 s; Stomp and Body Slam stagger 30 % / 1 s. Without interrupts, slow beams — already the cheapest power per energy (Solar Bloom 3.38, Solar Beam 3.06 vs a 1.83 mean) — dominate.

**Mechanics.** `src/combat/battle.ts` step() (disabled / phase timer) · `src/combat/moves.ts` charge/active/rest timing, moveCostBreakdown tempo term

```json
{
  "id": "SC-27",
  "title": "Interrupt the long charge",
  "tags": ["timing-charge", "status-staggered"],
  "status": "PROPOSAL",
  "arena": {"kind": "crystal", "ground": "stone", "weather": "clear", "hour": 14},
  "teamA": [
    {"size": "M", "primary": "neutral", "level": 30, "moves": ["stomp", "bodySlam", "tackle"]}
  ],
  "teamB": [
    {"size": "M", "primary": "light", "level": 30, "moves": ["solarBeam", "photonDart"]}
  ],
  "seeds": 200,
  "variants": [
    {"label": "noStagger", "teamA": [{"size": "M", "primary": "neutral", "level": 30, "moves": ["tackle"]}]}
  ],
  "expect": [
    {"metric": "chargeInterruptRate", "op": ">=", "value": 0.25, "move": "solarBeam", "target": true},
    {"metric": "chargeInterruptRate", "op": "<=", "value": 0.05, "move": "solarBeam", "variant": "noStagger", "target": true}
  ]
}
```

### SC-28 — Brave Genemon shrug off fear

**Status:** PROPOSAL · **Tags:** `status-feared`, `axis-conviction`

**Setup.** A: **M shadow** (Dread Gaze, Shadow Claw) vs B: **M neutral** with conviction +0.8 (main) or -0.8 (*timid*), Tackle and Body Slam, lvl 12. Stone, clear, 14:00.

**Expected.** Design target (P4): the brave B spends **<= 0.5x** as long *feared* as the timid B. Today conviction damps only the fear emotion that builds below 30 % HP (and with it fleeing), not the feared status.

**Why.** The conviction axis is "courage under pressure; fear makes it retreat". battle.ts: fear += 0.25 x (1 - conviction01) per hit below 30 % HP, flee when feared or fear > 0.6 under 35 % HP. Proposed: feared duration x (1 - 0.6 x max(0, conviction)).

**Mechanics.** `src/combat/battle.ts` Battle.hit (fear), movement (afraid) · `src/data/axes.ts` conviction · `src/combat/moves.ts` dreadGaze (feared 70 % / 3 s)

```json
{
  "id": "SC-28",
  "title": "Brave Genemon shrug off fear",
  "tags": ["status-feared", "axis-conviction"],
  "status": "PROPOSAL",
  "arena": {"kind": "crystal", "ground": "stone", "weather": "clear", "hour": 14},
  "teamA": [
    {"size": "M", "primary": "shadow", "level": 12, "moves": ["dreadGaze", "shadowClaw"]}
  ],
  "teamB": [
    {"size": "M", "primary": "neutral", "level": 12, "axes": {"conviction": 0.8}, "moves": ["tackle", "bodySlam"]}
  ],
  "seeds": 200,
  "variants": [
    {"label": "timid", "teamB": [{"size": "M", "primary": "neutral", "level": 12, "axes": {"conviction": -0.8}, "moves": ["tackle", "bodySlam"]}]}
  ],
  "expect": [
    {"metric": "statusUptime", "op": "<=", "value": 0.5, "status": "feared", "side": "B", "relativeTo": "timid", "target": true}
  ]
}
```

### SC-29 — Wise Genemon learn the chart

**Status:** ENGINE · **Tags:** `axis-wisdom`, `type-knowledge`, `ai`

**Setup.** A: **M water/electric** with wisdom +0.8 (Water Jet, Spark Bolt, Tackle) vs B: **M fire** (Cinder Spit, Ember Bite), lvl 12, after 100 learning battles per seed. Variant *naive* (wisdom -0.8).

**Expected.** The wise A picks a super-effective move **>= 85 %** of the times one is available; the naive A **30-70 %**.

**Why.** The AI estimates damage with learned type knowledge (`memory["fire>plant"]`); without it, a Genemon with wisdom01 > 0.65 uses the true chart and a naive one only 0.6 x wisdom01 of the true deviation. Every hit blends in the truth at 0.2 + 0.6 x wisdom01, and `applyBattleResult` keeps the knowledge between battles.

**Mechanics.** `src/combat/battle.ts` knownType(), Battle.hit (memory), applyBattleResult · `src/data/axes.ts` wisdom

```json
{
  "id": "SC-29",
  "title": "Wise Genemon learn the chart",
  "tags": ["axis-wisdom", "type-knowledge", "ai"],
  "status": "ENGINE",
  "arena": {"kind": "crystal", "ground": "stone", "weather": "clear", "hour": 14},
  "teamA": [
    {"size": "M", "primary": "water", "secondary": "electric", "level": 12, "axes": {"wisdom": 0.8}, "moves": ["waterJet", "sparkBolt", "tackle"]}
  ],
  "teamB": [
    {"size": "M", "primary": "fire", "level": 12, "moves": ["cinderSpit", "emberBite"]}
  ],
  "seeds": 200,
  "variants": [
    {"label": "naive", "teamA": [{"size": "M", "primary": "water", "secondary": "electric", "level": 12, "axes": {"wisdom": -0.8}, "moves": ["waterJet", "sparkBolt", "tackle"]}]}
  ],
  "expect": [
    {"metric": "superEffectiveChoice", "op": ">=", "value": 0.85},
    {"metric": "superEffectiveChoice", "op": "between", "value": [0.3, 0.7], "variant": "naive"}
  ]
}
```

### SC-30 — Lifestyle shapes the element (runs today)

**Status:** MODEL · **Tags:** `lifestyle-shapes-element`, `epigenetics`

**Setup.** 200 wild genomes (`randomGenome(1..200)`), level 12, 40 days old, raised three ways: *baseline* (no lifestyle), *lake* (300 h in deep water + 60 portions of fish), *lava* (300 h on lava + 60 spicy peppers). No battle: `express()` is the whole experiment.

**Expected.** Share whose primary or secondary type is water: *lake* **>= 0.30** and **>= 2.5x** *baseline*. Fire share: *lava* **>= 0.30** and **>= 4x** *baseline*. Measured on the fixture's 200 seeds (the test recomputes this on every run): water 0.12 -> 0.45 (3.75x), fire 0.045 -> 0.425 (9.4x).

**Why.** Exposure and diet nudge axes (moisture, heat...) and saturate at +-0.5 per axis; elements are not chosen, they emerge from the axes. This is the promise of `elements.ts`: a creature raised in water can grow a water type. Executed by tests/content_test.ts on every run.

**Mechanics.** `src/genome/epigenetics.ts` epigeneticPressure / epigeneticShift · `src/data/lifestyle.ts` GROUND_EXPOSURE, FOODS · `src/data/elements.ts` elementAffinities

```json
{
  "id": "SC-30",
  "title": "Lifestyle shapes the element (runs today)",
  "tags": ["lifestyle-shapes-element", "epigenetics"],
  "status": "MODEL",
  "arena": {"kind": "beach", "ground": "deepWater", "weather": "clear", "hour": 12},
  "teamA": [],
  "teamB": [],
  "seeds": 200,
  "regimen": {"level": 12, "ageDays": 40, "groups": [
    {"label": "baseline", "exposure": {}, "diet": {}},
    {"label": "lake", "exposure": {"deepWater": 300}, "diet": {"fish": 60}},
    {"label": "lava", "exposure": {"lava": 300}, "diet": {"spicyPepper": 60}}
  ]},
  "expect": [
    {"metric": "expressedElementShare", "op": ">=", "value": 0.3, "element": "water", "variant": "lake"},
    {"metric": "expressedElementShare", "op": ">=", "value": 2.5, "element": "water", "variant": "lake", "relativeTo": "baseline"},
    {"metric": "expressedElementShare", "op": ">=", "value": 0.3, "element": "fire", "variant": "lava"},
    {"metric": "expressedElementShare", "op": ">=", "value": 4, "element": "fire", "variant": "lava", "relativeTo": "baseline"}
  ]
}
```

### SC-31 — Raising on lava drifts toward light (runs today, target missed)

**Status:** MODEL · **Tags:** `lifestyle-side-effect`, `epigenetics`, `element-skew`

**Setup.** Same 200 genomes and regimen as SC-30: *baseline* against *lava*.

**Expected.** Design target: the light share under *lava* stays **<= 1.1x** *baseline* (a fire upbringing should not mostly breed light Genemon). Measured on the same 200 seeds: light 0.365 -> 0.525 (**1.44x**), above the fire share the upbringing was meant to raise (0.425). The test prints this miss on every run.

**Why.** Lava exposure nudges luminance (+0.003 / h) as well as heat, and light's signature is almost pure luminance — an extreme-dominance axis that already makes light the most common wild primary (24.7 %). Fix options: drop lava's luminance nudge, or lower luminance's weight in light's signature.

**Mechanics.** `src/data/lifestyle.ts` GROUND_EXPOSURE.lava · `src/data/elements.ts` ELEMENTS.light.signature · `src/data/axes.ts` luminance (extreme)

```json
{
  "id": "SC-31",
  "title": "Raising on lava drifts toward light (runs today, target missed)",
  "tags": ["lifestyle-side-effect", "epigenetics", "element-skew"],
  "status": "MODEL",
  "arena": {"kind": "volcano", "ground": "lava", "weather": "clear", "hour": 12},
  "teamA": [],
  "teamB": [],
  "seeds": 200,
  "regimen": {"level": 12, "ageDays": 40, "groups": [
    {"label": "baseline", "exposure": {}, "diet": {}},
    {"label": "lake", "exposure": {"deepWater": 300}, "diet": {"fish": 60}},
    {"label": "lava", "exposure": {"lava": 300}, "diet": {"spicyPepper": 60}}
  ]},
  "expect": [
    {"metric": "expressedElementShare", "op": "<=", "value": 1.1, "element": "light", "variant": "lava", "relativeTo": "baseline", "target": true}
  ]
}
```

## Balance risks these scenarios expose

| risk | evidence | scenarios |
|---|---|---|
| Lone big bodies beat equal-slot swarms | budgets 10-12 % above the focus-fire break-even sqrt(N(N+1)/2), plus the contact size factor (up to x1.87 per exchange) | SC-11, SC-01 slotFair |
| XS is never worth a slot | 0.85 budget vs S 1.0; wild XS 77.6 power vs S 91.3; contact size factor against it | SC-14 |
| Light outclasses shadow | Photon Dart 47.5 dmg/s at 0.98 accuracy vs Umbra Orb 36.0; light is 24.7 % of wild primaries | SC-09 |
| A fire upbringing breeds light | lava exposure also pushes luminance: light share 0.365 -> 0.525 under lava, above fire's 0.425 (200 seeds) | SC-31 |
| Slow beams are the cheapest power and cannot be interrupted | Solar Bloom 3.38, Solar Beam 3.06 power/energy vs 1.83 mean; a stagger does not cancel a charge | SC-27 |

## Open questions

1. Should conduction reach targets on mud (wet-looking, not liquid)? battle.ts says no, which keeps the user's ladder steep (SC-03).
2. Should eclipse also fire on direct light-on-shadow hits, like smoke does for fire on water bodies? Today it needs a clash or a zone (SC-09).
3. Should a chained current hurt allies at full strength? R5 includes allies, which makes the water + electric pair risky in tight formations (SC-10).
4. Should the day/night step become a curve (P6)? A real-time game will see players time battles to 06:59 vs 07:00.
5. How does the harness turn a member template into a genome reliably (bias strength, rejection sampling until size class and element match)?

## Next quests

1. Build `tools/scenarios.ts`: parse these fixtures, build teams from templates, run `Battle` headless with `detail: "full"`, print a pass/miss table with Wilson intervals; start with SC-13, then the exact-factor scenarios (SC-03, 12, 17, 19).
2. Land P1 (uniform floors) and the P2 keys, then flip the `requested` keys in `CONTENT_EVENTS` to emitted.
3. Decide P3-P5 with the battle owner; retune `POWER_BUDGET` or add swarm mechanics until SC-11 and SC-14 pass on held-out seeds.
4. Fix SC-31 (lava's luminance nudge) and re-run the census in `docs/LISTS.md`.
5. Add a scenario per new move shape, reaction or ground — the LISTS drift test names what is missing.
