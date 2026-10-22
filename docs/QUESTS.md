# Quests — development log for AI sessions

**Summary.** Each quest is one working increment with acceptance criteria that a probe or a test can
check. Pick the first `NEXT` quest whose dependencies are done; when you finish, set it `DONE`, link
the evidence entry, and update `docs/SPEC.md`.

Status: `DONE` · `NEXT` (ready) · `LATER` (blocked by a dependency) · `IDEA`.

## Done

| id | quest | evidence |
|---|---|---|
| Q0 | Foundations: git baseline of the Nuxt lab, legacy moved to `legacy/nuxt-lab`, Deno + three.js scaffold, Rng (avalanche-hashed seeds), Ledger, math | EVIDENCE pass 1 |
| Q1 | Data lists: 26 opposite-pole axes in 6 spaces, 14 elements + chart + 18 reactions, 17 grounds, 12 weathers, 14 foods, 15 experiences | pass 1 |
| Q2 | Genome (allele pairs) → epigenetics (capped tanh shift) → phenotype (normalised power [SPEC B1]) → individual life functions; breeding, fusion, morph, mutation | pass 1 |
| Q3 | Skeleton per body kind with dynamic coupled limits [SPEC K1], chain budgets, FK, centre of mass, support polygon | pass 1 |
| Q4 | Moves (77) with 3 phases and the cost model; teams (6 slots by size class, synergies, order); physics; deterministic battle + ledger; 6 measured scenarios | pass 1 |
| Q5 | Render: creatures from skeletons, animator through constraints, arena view (ground recolouring, sky by hour/weather, particles), FX, broadcast camera, lab + genospace views | pass 1 |
| Q6 | UI: screens tree, HUD, dark/light themes, profiles (Max + Claude), settings saved per profile, Data screen (ledger feed/export, charts, genospace, hardware, session) | pass 1 |
| Q8 | Tools: scenarios, capture (multi-angle, devices, offline proof), balance harness | pass 1 |
| P5 | Pass 5: icons, drag-to-feed with effects, profile sheet, shaded panels, auction outcomes; egg + fetal spiral + growth bands + operators + viability; faces with sockets and 1-8 eyes, beaks, tongues; coats, countershading, cel, scars; slower fights, neural-shaped brain, perception; senses + resonance, digestion, circadian, aging, retirement, imprints; home platform with graduations; species Dex; test-demo controls; symmetric ranked maps + start slots; batch lab | EVIDENCE pass 5; SPEC section P5 |
| P4 | Pass 4: Q/W/E/R kits (physical/special, body-part power, phase law, counters), bench formats + switching, gauntlet, Collection screen (team presets, Dex, Hatch), arena preview + dossier, morph helix, fused anatomy + manga faces + skin shaders, depth of field + camera menu, hybrids + strong foods + loot bag | EVIDENCE pass 4; SPEC section P4 |

## Next

| id | quest | acceptance criteria | depends |
|---|---|---|---|
| C2 | FIRST: the camera keeps EVERY living fighter in frame. Count off-canvas fighters as failures in the capture's readability table. Frame the projected boxes of all living fighters, not the attacker and target centres. Bound or drop the HUD aim lift (`safeTop`). The tablet distance must not exceed the desktop one. | 0 off-canvas living fighters in every auto shot of a capture round; smallest fighter >= 48 px at 1440x900 | - |
| A7 | KO'd fliers fall to the ground; the camera buttons never cover the HP cards; arena weather shots are captured with weather-changing moves disabled | a capture shows a KO'd flier on the floor; no `#view-tools` / `.hud-team` rectangle overlap in the manifest; the snapshot weather matches the file name | - |
| V1 | Fix review round 1 findings (creatures, camera, HUD) | round-3 reviewers agree on the checklist items flagged in round 1 | IN PROGRESS: pass 2 fixed the stability metric, side identification, layouts, exploits X1-X8; faces, charge pose, ground readability still open; round-3 reviews `docs/reviews/round-3/` |
| L1 | Wire the condition-aware ladder (`src/ladder/mmr.ts`) into `App.finishBattle` | DONE pass 2: pre-match context, persisted, Ladder screen, ranked-only rating (`[SPEC L3]`, `[SPEC L4]`) | - |
| L2 | Make conditions count from match 1: seed a fresh ladder's context weights from a logistic fit on simulated battles; scale powerDiff (e.g. tanh(4 x gap)) so its weight fits under the cap of 4; add rhythmFit to CONTEXT_FEATURES; carry existing MMR over | with zero-initialised weights, conditions moved the expected score by under 1 point over the first 300 matches (integrator measurement, not yet re-run). Integrator's fit to re-measure: typeAdvantage 1.40, synergyDiff 0.84, reachDiff 1.6, weatherAffinity 0.33, rhythmFit 0.22, powerDiff ~11 (above the cap) | L1 |
| V2 | View hand-off: Stage.setView disposes the old view AFTER building the new one; the Lab, Genospace and Battle views' dispose() clears the shared background / orbit controls the next view relies on | dispose undoes only what is still its own; each view re-asserts its scene state on its first frame (WorldView already does) | - |
| E1 | Wire the auction house (`src/economy/market.ts`) into a Market screen | DONE pass 2: live timers, bid / buyout, 48-round offline catch-up, NPC traders, credits banked; capture `artifacts/qa/round-4/screen-market.png`. Follow-up: label seller type (company / NPC / player) and show promotions on the lot itself (vision check, round 4) | - |
| Q1Q | Achievements + quests engine reading ledger rows (`src/data/achievements.ts`, `src/data/quests.ts`) | DONE pass 2: Progress subscribed to the ledger at boot and on profile switch; quest panel on Home; Feats screen; rewards paid once; capture `screen-achievements.png` | - |
| W1 | Wire the world map (`src/world/worldmap.ts`) into a 3D World screen | DONE pass 2: 3D neighbourhood around home, simulated-GPS toggle (default off refuses physical-only actions), spawn odds; captures `screen-world.png`, `mobile-world.png`. Follow-up: map labels clip at the frame edge | - |
| M1 | Live meta: feed ladder/corpus move usage into `Battle({ meta })` | move costs in the Lab show the meta multiplier; `artifacts/balance/meta.json` regenerated by `deno task balance` | L1 |
| S1 | Persona simulator `tools/sim.ts` | runs the 12 personas (+ clones) for N weeks through the real engine and reports `docs/PERSONAS.md` §9.3 metrics against §9.4 acceptance criteria. A PARTIAL implementation, stopped before finishing, is in `artifacts/wip/sim/` (`simulate.ts`, `sim.ts`, `sim_test.ts`, output); move it back to `src/sim/`, `tools/`, `tests/`, then fix it. Its last observation: personas accumulate 3k-21k credits but never buy. This is suspected to be the simulator's own buy call (item / quote shapes), not the market, which was browser-verified buying. | - |
| D6 | Wire the Insights screen (`src/ml/winModel.ts`, `projection.ts`, `src/ui/screens/insights.ts`: 9 tests pass) | add to `registry.ts`: `import { mountInsights, renderInsights } from "./insights.ts";` and, after `data`, `{ id: "insights", label: "Insights", icon: "◈", color: "#ff9e00", hint: "Neural win predictor, genome PCA map, your play pattern", view: "genospace", mount: mountInsights, render: renderInsights }`. Then browser-check desktop + 390 px: no console error, no overflow, training slices keep the UI responsive. | - |
| B2 | Balance pass from `artifacts/balance/REPORT.md` | DONE pass 4 for the bands (elements 40-62 %, big vs swarm 46-56 %, 3/141 unused). Remaining: 27 of 78 element pairs below 10 % / above 90 %; needs type-multiplier damping in `battle.ts` hit() or coverage moves | balance report |
| P4-1 | Show learn-lock reasons in the Lab / Collection move list (`learnCheck` -> `moveCard({ learn })`) and let the player swap a kit slot among learnable moves | every locked move shows its reasons; a swap is saved and logged | - |
| P4-2 | Gauntlet boss rounds and investments in the world (`rotation.ts` investmentReturn on World places) | a capture shows a round-5 boss; investing credits pays items back over days | - |
| P4-3 | Anatomy follow-ups: hexapod wing chain, folded-wing silhouette, insect/fin wing folding, Clodsttusk shell bands | creature sheet reviewed with no floating or blade-like parts | - |

| P5-1 | Archetype balance from the batch lab: Powerful 68 % overall (beats Swarm 88 %), Swarm 30 %, Fast 37 % | `deno task batch 48`: no row above 65 %, none below 35 %, no cell above 85 %, every archetype beats at least one other significantly; balance 72 still 13/13 | P5-X1 |
| P5-2 | Feed arena altitude (`arena.altitudeM`) and world place altitude into the circadian / breath effects in battle | a high-altitude arena changes a lowland Genemon's fight multiplier, logged | P5-G4, P5-W1 |
| P5-3 | Imprints from use: dragging gear / cosmetics (and repeated foods) calls `imprintItem`; the sheet lists them | imprint row in the ledger; inherited by a bred child | P5-G6 |
| P5-4 | Cel shading judged by two reviewers on close-ups (`tools/p5close.ts`); eggs on the Home platform and in battle (eggs currently render as the creature there) | reviewers agree on toon bands + outline on 12/16 creatures | P5-V7, P5-V2 |
| P5-5 | Battle camera still clips fighters at the frame edge (probe: one fighter at x0 = -193 px at 12 s) | quest C2 acceptance | C2 |

## Later

| id | quest | notes |
|---|---|---|
| ML1 | Outcome predictor (MLP on `battle.start`/`battle.end` features) shown before a battle; policy distillation from `battle.decide` | `src/ml/mlp.ts`, `docs/AI-AND-DATA.md` |
| N1 | `tools/replay.ts`: re-simulate a battle from its claim and verify `battleClaimHash` | `src/net/protocol.ts` |
| G1 | Opt-in geolocation + OpenStreetMap places + live weather (CSP `connect-src` change, privacy review) | `docs/WORLD.md`, `docs/SECURITY.md` |
| A1 | Accessibility: keyboard navigation of all screens, reduced motion for camera shake, colour-blind element patterns | |
| P1 | Performance: instanced creature parts, LOD for 12-fighter battles on mobile | measure first with `deno task capture` fps samples |
| D1 | Dungeons in the virtual space (procedural arenas chained with quests) | after W1 |
