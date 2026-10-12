# Genemon - consolidated spec (requirement ids, bounds, owners, honest status)

Every requirement from the founding brief, with an id, its bound, the file that owns it and a STATUS:

- **LIVE**: observed running in a real browser (QA capture `artifacts/qa/round-N/`).
- **TESTED**: pinned by a unit test or a harness number (named `[SPEC id]` when it is a cross-module bound).
- **MODEL**: the pure model exists but the game does not use it yet.
- **OPEN**: asked for, not built.

A requirement silently dropped reads as delivered: OPEN rows are the honest gap list. Update a row only with
evidence (a test name, a harness number, a capture file). Numbers come from the tools, never typed by hand.

Last updated: 2026-10-12 (pass 2). Measurements: `artifacts/balance/REPORT.md`, `artifacts/scenarios/`,
`artifacts/qa/round-2/REPORT.md` (when written), `docs/EVIDENCE.md`.

## G - Genome and creatures

| id | requirement | bound / definition | owner | status |
|---|---|---|---|---|
| G1 | Generative monsters, one unique genome each ("NFT-like") | genome = allele pairs + body plan, content-hashed id; same seed = same creature | `src/genome/genome.ts` | LIVE (Lab). Real minting/chain: OPEN |
| G2 | Evolution under time, space, experiences, food, battle | epigenetic shift tanh-saturated, capped at +-0.5 per axis; level/growth from xp and age | `src/genome/epigenetics.ts`, `src/data/lifestyle.ts`, `genemon.ts` (feed, live, applyBattleResult) | TESTED; feed/experience LIVE in Lab |
| G3 | Breed, mutate, morph, grow, combine (fuse) into new generations | chaos axis raises mutation rate; generation counter | `src/genome/breeding.ts` | TESTED; LIVE in Lab |
| G4 | Bonuses/maluses shape the creature's fighting AI | axes temper/reach/wisdom/conviction weigh the battle utilities | `src/combat/battle.ts` decide() | TESTED (battle_test) |
| G5 | Characters, emotions, energies, needs, envies, passions, fears | psyche derived from axes; emotions move in battle (anger on hit, fear at low HP) | `src/genome/phenotype.ts` psyche, battle emotions | TESTED; needs/envies drive nothing yet outside the sim: OPEN |
| G6 | Densities, patterns, textures, mobility, elasticity | density -> mass -> size class; 8 patterns; elasticity in physics | `phenotype.ts`, `src/render/creature.ts`, `textures.ts` | LIVE |
| G7 | Opposite-pole axes in multidimensional spaces, populated | 26 axes in 6 spaces; Genospace 3D view | `src/data/axes.ts`, `src/render/genospaceView.ts` | LIVE; PCA projection: in progress (insights builder) |

## B - Balance (measured by `tools/balance.ts`, `tools/scenarios.ts`)

| id | requirement | bound | owner | status |
|---|---|---|---|---|
| B1 | Size classes are normalised: power = budget(size), never raw axes | powerIndex = sqrt(EHP x expected damage rate) incl. defence, evasion (x0.8), regen, accuracy, crit; budget XS .85 S 1 M 2 L 2.9 XL 3.9 | `src/genome/phenotype.ts` | TESTED `[SPEC B1]` |
| B2 | Symmetric type chart; element win rates 35-65 % | every element: as many 2x strengths as 2x weaknesses | `src/data/elements.ts` | chart TESTED `[SPEC B2]`; win rates MEASURED 10/13 in band (water 32 %, air 24 %, fire 65 % at the edge; CI ~+-11 pts, n=72) - OPEN |
| B3 | Big vs swarm at equal slots 35-65 % | XL vs 4 S, L vs 3 S, M vs 2 S | `phenotype.ts` POWER_BUDGET + battle cleave/tenacity | MEASURED 58 / 56 / 44 % (n=36 each) |
| B4 | Readable pace | median battle ~25 s, 0 % draws | `battle.ts` PACE = 0.5 | MEASURED median 24.1 s (p10 14.8, p90 36.9), draws 0 % |
| B5 | No degenerate strategy (round-1 critic X1-X8) | see section X | `battle.ts`, `team.ts`, `moves.ts`, `app.ts` | fixes landed pass 2 (section X); re-review in round 2 |

## T - Teams

| id | requirement | bound | owner | status |
|---|---|---|---|---|
| T1 | Bigger, stronger Genemon take more slots | 6 slots; XS/S 1, M 2, L 3, XL 4 | `phenotype.ts` SLOT_COST, `team.ts` | TESTED; LIVE (Team screen) |
| T2 | Synergies between members | pairs need two DIFFERENT members; a synergy dies with its enablers | `team.ts` synergies(), `battle.ts` dropSynergies | TESTED `[SPEC T2]` x2 |
| T3 | Order of attacks matters | order = initiative stagger AND formation (front half in the front row, rest 2.5 m behind) | `battle.ts` constructor | TESTED `[SPEC T3]` |
| T4 | Types combine (reactions) | 18 reactions incl. fire+water = smoke | `src/data/elements.ts` REACTIONS | TESTED SC-02 |

## M - Moves and animation

| id | requirement | bound | owner | status |
|---|---|---|---|---|
| M1 | Learnable moves with a cost (area, speed, power, type, meta) | cost = power x (1 + 0.28 area, 0.16 for bursts) x range x accuracy x delivery x tempo + effects, x rarity x meta (0.8-1.25) | `src/combat/moves.ts` moveCostBreakdown | TESTED; meta fed by the balance corpus only (live meta: OPEN, quest M1) |
| M2 | Attack animations in 3 phases: charge, attack, rest | phases drive the animator; charge pose must differ from rest | `battle.ts`, `src/render/animator.ts` | LIVE; round 1: charge reads like rest - OPEN (pass 3) |
| M3 | Animations depend on state and balance of parts and body | strain + stability (COM vs sole footprints) feed the pose | `animator.ts`, `src/body/skeleton.ts` balanceOf | TESTED `[SPEC K2]` (every body kind stable at rest; falsifier) |
| M4 | Critical hits trigger critical effects | crit x1.6 damage, +50 % status chance, FX burst + camera punch | `battle.ts`, `src/render/fx.ts`, `battleCamera.ts` | LIVE |

## A - Arena, physics, skeleton

| id | requirement | bound | owner | status |
|---|---|---|---|---|
| A1 | Ground types, weather, topography, attributes | 17 grounds, 12 weathers, 10 arena kinds with heightmaps | `src/world/arena.ts`, `src/data/grounds.ts`, `weather.ts` | LIVE |
| A2 | Physics moves bodies (position, direction) | gravity, friction, slopes, wind, knockback by mass | `src/world/physics.ts` | TESTED; LIVE |
| A3 | Skeleton with dynamic, coupled joint limits | e.g. a forward hip forbids a straight knee | `src/body/skeleton.ts` | TESTED `[SPEC K1]` |
| A4 | Static balance is real evidence | soles are discs; rest posture puts the COM over the soles (`balancePosture`) | `skeleton.ts` | TESTED `[SPEC K2]` (biped/avian margins were always <= 0 before pass 2) |
| A5 | The brief's scenarios | big fire vs 2 small plants; fire+water smoke; electric water > mud > stone; fliers dodge quakes; diggers need diggable ground; side parity | `tools/scenarios.ts` | TESTED SC-01..SC-06 all PASS (n=120 each) |
| A6 | Weather and terrain changers, form/melt (phase) | weather/terrain/phase moves; ground transforms (freeze, melt, burn, mud) | `battle.ts`, `moves.ts` | engine; documented in `docs/SCENARIOS.md` (31 scenarios) |

## C - Camera and readability

| id | requirement | bound | owner | status |
|---|---|---|---|---|
| C1 | Intelligent battle camera aware of space and effects | director: WIDE / ACTION shots, >= 1.4 s between cuts, occlusion checks, trauma shake, FOV punch | `src/render/battleCamera.ts` | LIVE |
| C2 | Fighters readable | smallest living fighter >= 48 px at 1440x900; no fighter under a HUD box | `tools/capture.ts` readability table | measured from round 2 on |
| C3 | Who is whose | side ring + name tag + HP pip in the side colour; YOU / RIVAL HUD headers | `src/render/battleView.ts`, `src/ui/app.ts` | built pass 2; verify round 2 |

## D - Data, AI, ladder

| id | requirement | bound | owner | status |
|---|---|---|---|---|
| D1 | Every mechanic answers where/when/who/what/why/from/to/entries/exits | one flat ledger row per state change | `src/core/ledger.ts` | TESTED; LIVE (Data screen, export) |
| D2 | Profiles for you and me | Max (human), Claude (ai); settings saved per profile | `src/ui/profile.ts` | LIVE |
| D3 | Instant fights | Home "Instant battle" = a ranked battle with ladder-drawn arena | `app.ts` startRanked | built pass 2 |
| D4 | MMR that uses all conditions, not only the opponent's rating | logistic Elo with learned context weights on pre-match features | `src/ladder/mmr.ts`, `context.ts`, `src/ui/ladderStore.ts` | TESTED; wired pass 2 (Ladder screen) |
| L3 | Ranked conditions are drawn, not picked | arena drawn by the ladder; real hour; real weather when the arena has it | `src/ladder/ranked.ts` | TESTED `[SPEC L3]` |
| L4 | Rating and rewards cannot be pumped | a seed pays XP, W/L and rating once; practice/mirror/wild unrated; ranked abandon = forfeit | `ranked.ts`, `app.ts` finishBattle/abandonBattle | TESTED `[SPEC L4]` |
| D5 | Hardware and session data | device, form factor, frame time, session clock | `src/ui/realworld.ts`, `stage.ts` | LIVE |
| D6 | Neural networks, projections, data-science graphs | MLP win predictor vs ladder vs base rate; PCA + k-means of genomes | `src/ml/*`, Insights screen | MODEL (mlp.ts has no caller) - builder in progress |
| D7 | Real-world data at the top of the flow | local time, season, moon, deterministic weather-of-day, device | `realworld.ts` -> battles (hour, weather) | LIVE (offline; live weather API: OPEN, quest G1) |

## W - World, economy, quests

| id | requirement | bound | owner | status |
|---|---|---|---|---|
| W1 | Map with x,y,z; home, supermarket, gym; territories; discover; catch/release; physical vs virtual | WorldMap engine; physical-only actions refused without presence (simulated-GPS toggle, default off) | `src/world/worldmap.ts`, `src/ui/worldStore.ts`, World screen | LIVE (round 4: `screen-world.png`, `mobile-world.png`); real GPS: OPEN |
| W2 | The world keeps living while players play; NPCs evolve | company restocks + NPC traders replay up to 48 missed 5-min rounds per visit; persona simulation | `market.ts`, `src/ui/marketStore.ts`, `src/sim/*` | market LIVE (round 4: "ran 48 rounds, 45 lots settled"); simulation builder finishing |
| E1 | Auction house: timers, promotions, company / NPC / player sellers | bid, buyout, cancel, escrow, fees in basis points | `src/economy/market.ts`, Market screen | LIVE (round 4: `screen-market.png`); seller type and per-lot promotion not shown yet: OPEN |
| Q1 | Missions and quests, achievements | ledger rows -> progress; rewards once | `src/progress/*`, `src/ui/progressStore.ts`, Home quest panel, Feats screen | LIVE (round 4: `screen-achievements.png`); TESTED (progress_test) |
| P1 | Mobile / tablet / laptop / desktop | stacked layout on phones and portrait tablets; 4 tabs + More on phones | `web/styles.css`, `app.ts` buildNav | LIVE (round 4: `mobile-more.png`, 0 overflow at 1440 / 820 / 390) |
| S1 | Dark and light themes; every parameter saved in the profile | `[data-theme]`; settings per profile | `styles.css`, `profile.ts` | LIVE |
| N1 | Multiplayer, trading between real players | protocol + anti-cheat replay of a battle claim | `src/net/*` | MODEL (no caller) - OPEN |

## X - Exploits found by the round-1 critic (`docs/reviews/round-1/critic-pro-gameplay.md`)

| id | exploit | fix (pass 2) | evidence |
|---|---|---|---|
| X1 | Rematch / abandon MMR and XP pump | seed pays once (`rewardedSeeds`), ranked abandon = forfeit, opponents rated by the ladder | `[SPEC L4]`; `battle.settled` ledger row per battle |
| X2 | Rest loop (heal priced as a fraction of max HP) | HEAL_DECAY 0.6 per heal per battle; heal cost 60 x fraction | engine; scenario SC-07 (rest tank vs striker) still to add |
| X3 | Electric chain ignores defences, hits allies at x1.44 | raw strike re-weighted by each bystander's type and defence, weaker conductivity, max 2 bystanders (1 / 0.6), allies labelled friendly fire, AI penalises wet allies | engine; `battle.conduction` ledger rows |
| X4 | Synergy battery (one dual-type member, survives KO) | pairs need two members; synergies recomputed on KO, stat multipliers taken back | engine; `battle.synergyLost` rows |
| X5 | Evasion fortress (subtractive, unbudgeted) | multiplicative, capped at EVASION_CAP 0.35, priced in powerIndex | engine; balance harness |
| X6 | Condition shopping for rated battles | ranked arena drawn by the ladder | `[SPEC L3]` |
| X7 | Flight asymmetry (melee from out of reach) | a flyer's melee is a dive: low and hittable until the move ends + 0.8 s; take-off valued by the share of enemy moves it dodges | engine |
| X8 | Timeout score double-weighted big bodies | sum of HP / sum of max HP | `[SPEC X8]` |
