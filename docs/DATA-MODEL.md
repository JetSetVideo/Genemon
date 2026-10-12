# Data model

**Summary.** Everything that happens is a Ledger row with the same 5W shape; everything that persists
is a Profile in localStorage (JSON) whose Genemon are `{ genome, conditions, moves, knowledge }` —
the phenotype is always *derived*, never stored, so a formula fix re-derives every creature. Export
the ledger as JSONL and a profile as JSON from the Data screen.

## Ledger row — `GEvent` in `src/core/ledger.ts`

| Field | Type | Meaning |
|---|---|---|
| `id`, `seq` | string, number | `<ledger>-<seq>`, monotonic per ledger |
| `when` | number (ms) | real epoch for live play; `when0 + simulated ms` inside battles |
| `where` | `{x, y, z, zone, space}` | metres in the space's frame; `zone` = arena kind / screen / place; `space` ∈ physical, virtual, arena, lab, market, world, sim, ui, device |
| `who` | string | actor id (player, Genemon, `system`, `sky`, `environment`, `device`) |
| `what` | string | dotted event name (catalogue below) |
| `why` | string | the decision or rule that caused it (utility numbers, thresholds, user intent) |
| `from`, `to` | string | source state/actor → target state/actor |
| `entries` | flat record | inputs (number / string / boolean only) |
| `exits` | flat record | outputs (number / string / boolean only) |
| `tags` | string[]? | grouping, e.g. `battle:<seed>` |

`isValidEvent()` validates the shape; every test that produces rows asserts it.

## Event catalogue (generated from the code by grep, pass 1)

| what | emitted by | entries → exits (main fields) |
|---|---|---|
| `battle.start` | `Battle` constructor | seed, arena, weather, hour, teamA, teamB → synergiesA/B, fighters |
| `battle.decide` | `Battle.decide` | options, hp, energy, fear, anger → move, target, utility, second-best |
| `battle.hit` | `Battle.hit` | move, power, atk, def, type, stab, weather, ground, conduction, size, emotion, team, rhythm, reaction, crit → damage, hp, hpFrac |
| `battle.miss` | `Battle.miss` | move → target hp (why = roll vs p, out of reach, ...) |
| `battle.reaction` | `Battle.react` | a, b → reaction, damageMult, zone |
| `battle.clash` | projectile update | a, b elements → reaction or cancel |
| `battle.status` | `Battle.addStatus` | status, duration → active count |
| `battle.terrain` | ground impacts, terraform moves | move, radius → cells changed (from/to = ground ids) |
| `battle.weather` | weather moves / expiry | duration → weather |
| `battle.lightning` | thunderstorm | conduction → damage |
| `battle.fail` | e.g. dig on stone | move → reason |
| `battle.ko` | `Battle.knockOut` | t → team |
| `battle.end` | `Battle.checkEnd` | arena, weather start/end, hour, synergies → winner, duration, hpA, hpB, mvp, reactions |
| `battle.conduction` | `Battle.hit` (electric chain) | move, ally, rank, conduction → damage, hp [SPEC X3] |
| `battle.synergyLost` | `Battle.knockOut` → `dropSynergies` | lost, survivors → remaining [SPEC X4] |
| `battle.settled` | `App.finishBattle` | seed, ranked, fresh, forfeit, kind → mmrDelta, mmr, winner [SPEC L4] |
| `genemon.feed` | `feed()` | food, units → hunger, bond |
| `genemon.experience` / `.denied` | `live()` | experience, units, physical → xp / reason |
| `genemon.exposure` | `expose()` | ground, hours → total hours |
| `genemon.xp` | `grantXp()` | xp → total, level |
| `genemon.levelUp` | `settle()` | from → to, moves |
| `genemon.evolve` | `settle()` | fromStage, growth, level → toStage, height, sizeClass |
| `genemon.specialize` | `settle()` | primary/secondary before → after |
| `genemon.create` / `genemon.release` | Lab screen | detail (operation, names). **Key mismatch:** the Lab's `genemon.release` row carries only `detail`, while the content contract's `genemon.release` expects `primary`/`sizeClass` → `spawn` (the world screen writes that shape). A release from the Lab therefore moves no element- or size-filtered achievement. Fix when the release flow is unified |
| `team.change` | Team screen | detail (ordered ids) |
| `ui.navigate`, `ui.settings`, `ui.profile.switch` | `App` | detail |
| `device.session.start`, `device.session.pause`, `device.session.resume`, `device.gpu` | `Session`, `App` | cores, memory, touch, screen, dpr, form factor / active ms / renderer, max texture |
| `market.*` (post, bid, buyout, cancel, sold, expired, deposit, withdraw, give, take, reject, company.restock, npc.round, genemon.appraise, **catchup, genemon.escrow, genemon.delivered, genemon.returned, genemon.departed, store.reset**) | `src/economy/market.ts` + `src/ui/marketStore.ts` | see `docs/ECONOMY.md` (wired pass 2) |
| `ladder.match` | `src/ladder/mmr.ts`, `src/ui/ladderStore.ts` | conditions, expected, delta → see `docs/AI-AND-DATA.md` (wired pass 2) |
| `world.claim`, `world.move`, `virtual.*`, `map.*`, `territory.reinforce`, `world.purchase`, `genemon.catch`, `genemon.release` | `src/world/worldmap.ts`, `src/ui/worldStore.ts` | see `docs/WORLD.md` (wired pass 2). `world.*` rows mean GPS-verified presence; everything else is virtual |
| `quest.complete`, `achievement.unlock` | `src/progress/progress.ts` via `src/ui/progressStore.ts` | quest/achievement id, reward → totals (wired pass 2) |
| `net.reject`, `net.ratelimit`, `net.battle.reject`, `anticheat.gps`, `anticheat.presence`, `anticheat.throttle` | `src/net/*` | see `docs/NETWORK.md`, `docs/SECURITY.md` (no server yet) |
| `ml.winModel.trained` | `src/ui/screens/insights.ts` | corpus size, holdout scores → metrics (screen not wired yet: quest D6) |

Battles can log in `detail: "summary"` mode (start / reactions / weather / KO / end only) for
large simulations; the app uses `"full"`.

## Persisted shapes

```ts
Profile {                       // localStorage "genemon.profile.<id>", index in "genemon.profiles"
  id, name, kind: "human" | "ai", createdAt, seed,
  settings: { theme, quality, pixelRatio, shadows, camera, shake, speed, hourMode, hour, showSkeleton, units },
  credits, collection: Genemon[], team: string[] /* ordered ids */, mmr,
  stats: { battles, wins, losses, draws }, history: BattleRecordLite[] /* last 60, each with kind: ranked | practice | replay | forfeit */,
  pokedex: string[] /* genome ids seen */, achievements: string[], home: {lat, lon} | null, friends: string[],
  rewardedSeeds: number[] /* seeds that already paid XP, record and rating: a rematch pays nothing twice [SPEC L4] */
}
Genemon { id, genome: Genome, name, owner, bornAt, conditions: Conditions, moves: string[], knowledge: Record<"fire>plant", number>, stage }
Genome  { id /* content hash: the NFT token id candidate */, seeds: {genotype, environment}, generation, lineage: [parentA, parentB],
          kind, pattern, axes: Record<AxisId, [allele, allele]>, plan: Record<PlanGene, [allele, allele]>, hue: [a, b], mutations: string[] }
Conditions { ageDays, xp, exposure: Record<GroundId, hours>, diet: Record<FoodId, units>, battles: { won, lost, draws, kos,
             damageTakenBy: Record<ElementId, number>, elementsUsed: Record<ElementId, number> },
             experiences: Record<ExperienceId, units>, activeHour /* circular running mean of the local
             hours the creature actually played, weight ACTIVE_HOUR_RATE; drives the rhythm axis [SPEC G2] */, bond, hunger }
```

Derived (never stored): `Phenotype` (`express(genome, conditions)`), `Skeleton` (`buildSkeleton(ph)`),
learnset (`learnset(ph, seed)` when the level or elements change).

## Datasets the ledger already supports

| Dataset | Rows | Use |
|---|---|---|
| Battle outcomes | `battle.end` (+ `battle.start` for teams) | outcome predictor, condition-aware MMR features |
| Decisions | `battle.decide` | imitation learning of the utility AI; policy distillation into an MLP |
| Damage model | `battle.hit` (every multiplier logged) | balance audits, per-factor attribution, the damage histogram |
| Lifestyle | `genemon.feed/experience/exposure/evolve/specialize` | which lives produce which creatures |
| Sessions & hardware | `device.*`, `ui.*` | play-time patterns per device and hour, performance budgets |
