# Genemon - consolidated spec (requirement ids, bounds, owners, honest status)

Every requirement from the founding brief, with an id, its bound, the file that owns it and a STATUS:

- **LIVE**: observed running in a real browser (QA capture `artifacts/qa/round-N/`).
- **TESTED**: pinned by a unit test or a harness number (named `[SPEC id]` when it is a cross-module bound).
- **MODEL**: the pure model exists but the game does not use it yet.
- **OPEN**: asked for, not built.

A requirement silently dropped reads as delivered: OPEN rows are the honest gap list. Update a row only with
evidence (a test name, a harness number, a capture file). Numbers come from the tools, never typed by hand.

Last updated: 2026-10-22 (pass 4; section P4 below). Measurements: `artifacts/balance/REPORT.md`, `artifacts/scenarios/`,
`artifacts/qa/round-2/REPORT.md` (when written), `docs/EVIDENCE.md`.

## P5 - Pass 5 (founder's second request of 2026-10-22, decoded in `docs/team/PASS5-BRIEF.md`)

Browser evidence: `tools/p5probe.ts` (19/19, `artifacts/qa/p5-r2/`), `tools/p5life.ts` (7/7), `tools/p5gaps.ts`
(0 floating meshes in 16 creatures; `--fake` proves it can fail), `tools/p5close.ts` (`artifacts/qa/p5-close/`).

| id | requirement | bound | owner | status |
|---|---|---|---|---|
| P5-U1 | Icons for every object | procedural SVG per item kind, element tint, rarity ring; covers every ITEM_ID | `src/ui/icons.ts` | TESTED `tests/icons_test.ts`; LIVE (bag, market lots, loot) |
| P5-U2 | Drag an object from the panel onto the 3D view to feed; see the effects | pointer drag (mouse + touch), drop -> stomach (food) / gear / cosmetic; popup + recent effects; eat animation | `src/ui/dragFeed.ts`, `labView.feedReaction/hitTest` | LIVE: probe dragged berries onto `#scene`, `genemon.feed` +1, stomach 1 item, popup top-left, head dips + crumbs (vision) |
| P5-U3 | Genemon profile page | identity (age, phase, parents), story, character, stats, attacks, objects, senses, digestion, scars, evolution path | `src/ui/sheet.ts` (Lab default tab) | LIVE: 10 sections measured |
| P5-U4 | Shaded section titles; actions work; auction house finished | every `section()` title on a colour band (6 shades), lot icons + time bars + ending-soon + bid outcomes + settle now | `web/styles.css`, `src/ui/widgets.ts sec`, `market.ts` | LIVE: Home bands measured (6 titles, 6 colours); outbid state tested only in a pure test |
| P5-V1 | Evolution steps with cost and properties | egg -> ancient, cost {days, xp, food, credits, bond} + properties | `src/genome/lifeclock.ts evolutionPath` | TESTED; shown on the sheet |
| P5-V2 | Egg, fetal spiral, growth bands, neoteny | spiral curl = turns x 2pi, uncurls with growth; bone length/strength/bend inside gene bands; hatch starts as an egg | `skeleton.ts`, `anatomy/egg.ts`, `hatch.ts` | TESTED `tests/morph_p5_test.ts`; LIVE: egg (opaque) and fetus (translucent, curled) seen in the Lab |
| P5-V3 | Morph operators + viability | carve, merge, compress, decompress, difference, twist, bulge, pinch on loft stations; connectivity check | `anatomy/ops.ts`, `viability.ts` | TESTED; browser: 0 meshes > 4 % of height from a neighbour (16 creatures) |
| P5-V4 | Faces: sockets, 1-8 eyes, outlines, beaks, mouth xyz, tongues | eye count 2 = 80 %, 1 = 5.6 %, 3-8 = 14.4 % (2000 seeds) | `helix.ts p5Of`, `anatomy/face.ts buildHead` | TESTED `tests/helix_p5_test.ts`, `face_test.ts`; LIVE (vision: eyes in shallow sockets) |
| P5-V5 | Shoulders, rare limb drift, fractal arms | drift on 6 % of genomes, mirror symmetric | `body.ts`, `limbs.ts fractalPieces` | TESTED; fractal branching reads as clawed paws at full-creature scale |
| P5-V6 | Tentacles, legged serpents, element curvature, 10 tail shapes | tentacles 5.3 %, serpent legs 4.7 % of serpents; water +0.83 / metal -0.91 curvature | `body.ts`, `helix.ts` | TESTED; LIVE (octopus blobs seen) |
| P5-V7 | Cel shading, countershaded bellies, overlays, coats | 2-5 cel bands, ink outline (budgeted), belly texture, 9 coats | `anatomy/skin.ts`, `coat.ts`, `textures.ts` | TESTED; vision: bellies lighter, cel look visible on some creatures but read as smooth on others |
| P5-V8 | Scars, aged skin | heavy hits (>= 25 % max HP) may scar after the fight; elder/ancient grey tint | `app.ts applyScars`, `skin.ts applyScars/ageTint` | LIVE: a probe battle left 3 scars on the team |
| P5-A1 | Smoother, slower | sim TEMPO 1.85 + playback x0.75; springs; FX caps | `battle.ts`, `battleView.ts`, `animator.ts`, `fx.ts` | MEASURED: median 41.2 s sim (24.8 s before), playback 0.75x measured in Chrome |
| P5-A2 | Head-aware, state-aware animation, slither, mouths | look-at within limits, hungry/sleepy/bloated/KO, rear-up, chew/roar | `animator.ts` | TESTED `tests/animator_p5_test.ts`; bloat 1 reached in the browser after overfeeding |
| P5-B1 | Fewer powers; neural-shaped decision tree | 1 rider per move, STATUS_CAP 2, MAX_ZONES 4; 8 intent neurons | `src/combat/brain.ts`, `battle.ts` | TESTED `tests/brain_test.ts`; LIVE (intents in the battle snapshot) |
| P5-B2 | Awareness: facing, field of view, hearing | perception from the genome's senses (sensesOf) by default; blind-side bonus | `battle.ts`, `senses.ts` | TESTED |
| P5-G1/G2 | Senses from features, double-edged resonance | acuity sum = SENSE_BUDGET; resonance 0.7-1.45; damage weight 0.5 | `src/genome/senses.ts` | TESTED; 104/141 moves travel through a sense |
| P5-G3 | Digestion | stomach capacity by size, diet efficiency, hours per unit, bloat | `src/genome/digestion.ts`, `genemon.feedLife` | LIVE: feast refused at capacity 7.9, accepted to 37.9 with "no food limit" |
| P5-G4 | Circadian rhythm, altitude, age | fight/production/fertility multipliers, asleep | `lifeclock.ts circadian` | TESTED; the Lab creature sleeps by its rhythm; arena altitude not yet fed into battles: OPEN |
| P5-G5 | Long loop: feed, age, scars, retirement | phases by size class; ancients and scarred elders cannot rank | `lifeclock.ts`, `app.startBattle` | LIVE: an ancient was benched from ranked |
| P5-G6 | Imprints passed down | +-0.06 axis bend, decaying inheritance | `src/genome/imprint.ts`, `breed -> inheritLife` | TESTED; using an item does not yet call imprintItem in the UI: OPEN |
| P5-L1 | Loops at several time scales | life loop ticks (1/min real, 5 s demo), offline catch-up 30 d | `src/ui/lifeLoop.ts` | LIVE: 70 days in 10 min at 10080x |
| P5-D1 | Test demo: time scale, overfeed, unlimited money | 1x / 60x / 1440x / 10080x; credits topped to 1e9 | `src/ui/devPanel.ts` (top of Settings, compact on Home) | LIVE |
| P5-D2 | Dex: unlock and develop species | 432 species keys, research 1-5 | `src/ui/screens/dex.ts` | TESTED `tests/home_dex_test.ts`; LIVE |
| P5-W1 | Maps: density, levels, altitude, symmetric ranked, start points, minimaps | terraces, plateaus, props (solid collide), mirror / rotational ranked maps, 4 start slots | `src/world/arena.ts`, `arenaPreview.ts`, `screens/arena.ts` | TESTED `tests/arena_p5_test.ts`; parity 49.7-49.8 % over 1000 battles |
| P5-H1 | Home platform with graduations, several Genemon interacting | rings 0.5 m, ruler 0.1 m, pole 0.25 m bands; 2-6 creatures pair up and play | `src/render/homeView.ts` | LIVE (4 creatures, size labels) |
| P5-X1 | Batches, archetype matrices | win rate excl. draws, Wilson CI, flags | `src/sim/batch.ts`, `tools/batch.ts`, Batch screen | MEASURED n=48: Powerful 68 % DOMINANT, Swarm 30 % WEAK, Fast 37 %: the "every archetype has pros and cons" goal is NOT met yet |

## P4 - Pass 4 (founder's requests of 2026-10-22, decoded in `docs/team/PASS4-BRIEF.md`)

| id | requirement | bound | owner | status |
|---|---|---|---|---|
| P4-R1 | Random Hatch button; most newborns plain | first hatch per day free, then 40, 60, 90...; plain egg 76 % neutral (500 hatches) | `src/ui/hatch.ts`, Collection screen | TESTED `tests/hatch_test.ts`; screen captured round 6 (`screen-dex.png`), hatch click not browser-driven yet |
| P4-R2 | Better Dex | seen vs owned grid, silhouettes for seen-not-owned | `src/ui/screens/dex.ts` | built; captured round 6 (`screen-dex.png`) |
| P4-R3 | Find the team fast; several saved teams; all my Genemon; readable names and moves | up to 8 presets, active mirrored into `profile.team`; move cards with Q/W/E/R badge and phase bar | `src/ui/teamsStore.ts`, `moveCard.ts`, `dex.ts` | TESTED `tests/teams_store_test.ts`; LIVE (Collection tab) |
| P4-M1 | Physical / special / status moves | offense and guard splits with geometric mean 1 (budget-neutral) | `phenotype.ts` offense/guard, `battle.ts` moveCategory | TESTED `tests/battle_pass4_test.ts` |
| P4-M2 | Power bound to the body part (breath = mouth, slam = mass...) | bodyFactor in [0.7, 1.35], mean per part 1.00-1.02 | `src/combat/kit.ts` bodyFactor; cones in `battle.ts` | TESTED `tests/kit_test.ts`, cone hit test |
| P4-M3 | Limited learnsets with reasons | level, element affinity, size, energy, body-part gates | `kit.ts` learnCheck | TESTED; the lock reasons are not shown in the UI yet: OPEN |
| P4-M4 | Moves interact with arenas and weather | weather calls back in kits (all 9 learned, ~0.95 cast / battle); cones react with zones | `kit.ts` utilityValue, `battle.ts` | MEASURED (balance 72) |
| P4-M5 | Phase law: big moves charge, act and rest long | `phaseLaw(power, area, effects)`, legacy damaging rows re-timed | `src/combat/moves.ts` lawTimed | TESTED |
| P4-M6 | Counters (stun interrupts a charge, dash dodges) | interrupts only on stunned/frozen; AI weighs counterValue | `battle.ts` interrupt, `kit.ts` counterValue | TESTED |
| P4-M7 | Q/W/E/R kits | 4 moves: basic, control, mobility (or utility for supports), ultimate; 59 kit moves | `kit.ts` buildKit, `movesKit.ts` | TESTED; ultimates 1.4 % of casts |
| P4-A1 | Arena seen from outside + stats dossier | composition, elevation, slope, liquid/dig/conduction shares, favoured elements, weather, hints | `src/world/arenaStats.ts`, `render/arenaPreview.ts`, `ui/arenaDossier.ts` | TESTED `tests/arena_stats_test.ts`; LIVE (Arena tab, round 6 `07-arena-setup.png`) |
| P4-U1 | Three-click rule | Arena tab shows the dossier at once; Collection tab -> card -> drawer shows moves | screens | built; no automated click-count audit: OPEN |
| P4-U2 | Glass minimal design | translucent panels, hairlines, readable names | `web/styles.css` pass-4 layer | captured round 6 |
| P4-U3 | All camera options in one collapsible menu | closed by default, bottom-right | `src/ui/cameraPanel.ts` | TESTED `tests/post_test.ts`; LIVE round 6 |
| P4-V1 | Fused anatomy, skin shaders, bump, depth of field, fog | lofted bodies, normal-mapped physical skin, rim term, EffectComposer DOF/bloom/vignette | `src/render/anatomy/*`, `render/post.ts` | TESTED (`anatomy_test`, `face_test`, `post_test`); LIVE round 6: 0 console errors, 55 fps at 1440x900 |
| P4-V2 | Helix DNA with min/max genes bounding traits and animation | value = lo + (hi - lo) * smoothstep(drive) | `src/genome/helix.ts`, `render/animator.ts` | TESTED `tests/helix_test.ts`; LIVE (animator envelopes) |
| P4-V3 | Rare asymmetry, digits, bigger wings, teeth, manga eyes, eye smoke | asymmetry 8.6 %, 8 eye styles, 7 teeth kinds, avian span >= 2x | `helix.ts`, `anatomy/body.ts`, `face.ts`, `eyeAura.ts` | TESTED; captured round 6 (creature sheet). Hexapods never get wings (no wing chain): OPEN |
| P4-B1 | Gauntlet: one Genemon against endless opponents | HP carried, boss every 5th round | `src/combat/gauntlet.ts`, `ui/gauntletPanel.ts` | TESTED `tests/gauntlet_test.ts`; browser run past round 1 (lane); boss UI not browser-checked: OPEN |
| P4-B2 | Throwing Genemon in, switching during the battle | 1v1 / 2v2 / 3v3 with a bench, KO throw-ins, trainer switch (cooldown 3 s), AI trainer, replayable script | `battle.ts`, `app.ts` switchIn | TESTED `tests/battle_pass4_test.ts`; browser: a 1v1 volcano battle made 10 switches |
| P4-E1 | Evolve by feeding and battle loot; rotating items; investments | 1-3 drops per win; 7-day element rotation; investment returns | `src/economy/loot.ts`, `rotation.ts`, `ui/bagStore.ts` | loot LIVE (bag + result screen); investments not in the game yet: OPEN |
| P4-E2 | Diet changes the element; strict colour code | plain -> fire after 13-23 ember chilis -> Steam after 12-16 spring waters (8 seeds) | `src/data/hybrids.ts`, `lifestyle.ts`, `phenotype.ts` hybridPalette | TESTED `tests/hybrids_test.ts` |

Pass-4 balance (`deno task balance 72`): 13/13 elements in 40-62 %; big vs swarm 55 / 56 / 46 %; top move 5.7 % of casts;
3/141 moves never learned; median battle 24.8 s, 0 draws; 27 of 78 element pairs still below 10 % or above 90 % (type
chart double resists): OPEN.

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
| C2 | Fighters readable | every living fighter INSIDE the canvas; smallest >= 48 px at 1440x900; no fighter under a HUD box | `tools/capture.ts` readability table, `battleCamera.ts` | BROKEN: round-3 reviewers found living fighters off-canvas in 7 of 12 auto shots, and the metric ignored off-canvas fighters: quest C2 |
| C3 | Who is whose | side ring + name tag + HP pip in the side colour; YOU / RIVAL HUD headers | `src/render/battleView.ts`, `src/ui/app.ts` | built pass 2; verify round 2 |

## D - Data, AI, ladder

| id | requirement | bound | owner | status |
|---|---|---|---|---|
| D1 | Every mechanic answers where/when/who/what/why/from/to/entries/exits | one flat ledger row per state change | `src/core/ledger.ts` | TESTED; LIVE (Data screen, export) |
| D2 | Profiles for you and me | Max (human), Claude (ai); settings saved per profile | `src/ui/profile.ts` | LIVE |
| D3 | Instant fights | Home "Instant battle" = a ranked battle with ladder-drawn arena | `app.ts` startRanked | built pass 2 |
| D4 | MMR that uses all conditions, not only the opponent's rating | logistic Elo with learned context weights on pre-match features | `src/ladder/mmr.ts`, `context.ts`, `src/ui/ladderStore.ts` | TESTED; wired pass 2 (Ladder screen). Caveat: context weights start at 0, so conditions barely move ratings for the first ~300 matches (integrator measurement): quest L2 |
| L3 | Ranked conditions are drawn, not picked | arena drawn by the ladder; real hour; real weather when the arena has it | `src/ladder/ranked.ts` | TESTED `[SPEC L3]` |
| L4 | Rating and rewards cannot be pumped | a seed pays XP, W/L and rating once; practice/mirror/wild unrated; ranked abandon = forfeit | `ranked.ts`, `app.ts` finishBattle/abandonBattle | TESTED `[SPEC L4]` |
| D5 | Hardware and session data | device, form factor, frame time, session clock | `src/ui/realworld.ts`, `stage.ts` | LIVE |
| D6 | Neural networks, projections, data-science graphs | MLP win predictor vs ladder vs base rate; PCA + k-means of genomes | `src/ml/*`, Insights screen | MODEL: the win predictor (MLP vs logistic vs ladder vs base rate) and the PCA / k-means projection are built; 9 tests pass. The Insights screen is written but NOT wired or browser-checked: quest D6. Builder's single 300-battle run (75 held out), log-loss: neural net 0.609, logistic 0.585, logistic on the ladder's 8 conditions 0.571 (70.7 %), live ladder after one pass 0.674, base rate 0.692. The neural net does not beat logistic regression. |
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
