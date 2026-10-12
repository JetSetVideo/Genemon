# Plan — Genemon, grown by Gall's law

**Summary.** "A complex system that works evolved from a simple system that worked." Each phase
below ends with a game that runs, is measured, and is reviewed; nothing is started on top of a layer
that is not working. Development is tracked as quests (`docs/QUESTS.md`) with acceptance criteria;
every pass appends what was measured to `docs/EVIDENCE.md`; requirement statuses live in
`docs/SPEC.md`. Agents have fixed roles (`docs/team/ROSTER.md`) and visual rounds are judged by at
least two reviewers from different roles.

## Phases

| # | Phase | Working result that gates the next phase | Status |
|---|---|---|---|
| 0 | Foundations | git history, legacy prototype frozen, Deno + three.js scaffold, deterministic RNG, Ledger | ✅ done |
| 1 | The genome game (pure) | genome → phenotype → epigenetics → breeding; skeleton with coupled limits; physics; battle; scenarios pass | ✅ done, 6/6 scenarios measured |
| 2 | The 3D game | creatures from skeletons, animator through constraints, arenas × weathers × hours, FX, camera, HUD | ⚠️ built; rounds 1 and 3 reviewed — NOT SHIP (the camera leaves living fighters off-screen, the 48 px readability floor is unmet): quest C2 |
| 3 | The personal loop | profiles (human + AI), team, lab (feed / live / habitat / breed / fuse / morph / mutate), settings, data screen | ✅ built |
| 4 | The social game (local) | condition-aware ladder, auction house, quests & achievements, world map with places & territories — integrated one at a time behind probes | ✅ integrated and browser-verified (quests L1, E1, Q1Q, W1); caveat: the ladder's condition weights start at 0, so conditions barely move ratings at first — quest L2 |
| 5 | The simulated society | 12-persona simulator over weeks of play: economy inflation, MMR spread, element diversity, territory churn, retention proxy | ⏳ half-built, parked in `artifacts/wip/sim/` — quest S1 |
| 6 | The learning game | outcome predictor and battle policy trained on ledger datasets; live meta feeding move costs; projections of the population | ⏳ win predictor + PCA/k-means built and tested (9 tests); in its one measured run the neural net did NOT beat logistic regression, and the screen is unwired — quest D6; live meta — quest M1 |
| 7 | Online | deterministic replay verification server-side, presence, persistent world tick, territory consistency | ⏳ quests N1+ (design in `docs/NETWORK.md`) |
| 8 | Real-world data | opt-in geolocation, OpenStreetMap places, live weather, health/activity trackers (privacy first) | ⏳ quest G1 |

## Current position (2026-10-12, commit `d2f49da`)

Phases 0–4 have shipped working software: the deterministic core, its 3D presentation, the personal
loop, and the local social layer (ladder, market, world, quests) are all in the app and verified in a
browser. What is NOT finished is quality, not architecture: the battle camera loses fighters off-screen
(quest C2), the readability floor is unmet, and three systems are built but not integrated (the
Insights screen, the persona simulator, netcode).

Next quests, in order (`docs/QUESTS.md`): **C2** camera keeps every living fighter in frame and the QA
metric can fail · **A7** KO'd fliers fall, camera buttons off the HP cards, honest weather shots ·
**L2** ladder conditions count from match 1 · **D6** wire the Insights screen · **S1** finish the
persona simulator · **B2** balance pass (re-measure before tuning: an intermediate configuration
measured 12/13 elements in band against today's 10/13) · **M1** live meta · **V2** view hand-off.

Review history: round 1 (3 reviewers), round 3 (2 reviewers, after the fixes) — 3D/physics 30 → 34/100,
designer 36 → 56/100. Both rounds scored "not ship"; the gap between the numbers and a ship verdict is
`docs/reviews/round-3/*.md` plus the quest list above.

## The 12-player simulation plan

The personas (`src/sim/personas.ts`, cards in `docs/PERSONAS.md`) are 12 typed players — from Léa
(9, Lyon, collector) and Gérard (71, Lyon, explorer) to Thomas (23, Paris, speedrunner), Karim (45,
Marseille, trader) and the two real ones, **max** and **claude** — each with a weekly timetable,
devices, play style, social circle, diet, experiences, favourite moves, achievement targets and a
pokédex goal. The simulator (quest S1) replays their weeks against the real engine:

1. For each simulated day and each persona block: open a session on the block's device, apply the
   block's physical moves (gym, supermarket, walks) and food to their Genemon through the same
   `feed / live / expose / age` functions the Lab uses, play battles (`Battle` with seeds), trade on
   the `AuctionHouse`, claim territories on the `WorldMap`, and record everything in one Ledger.
2. Clone each persona with jitter to reach a population (e.g. 12 × 50) and weight clones by realism.
3. Output the metrics of `docs/PERSONAS.md` §9.3 (retention proxy, MMR spread, element diversity,
   economy inflation, territory churn, achievement pace) and check its acceptance criteria (§9.4).

## Review protocol (every visual pass)

1. `deno task build && deno task capture N` → `artifacts/qa/round-N/` (shots, contact sheets,
   engine-state manifest, console errors, offline proof, overflow check, fps sample).
2. At least two reviewers from different roles score the SAME fixed checklist (`docs/reviews/CHECKLIST.md`)
   and write `docs/reviews/round-N/<role>.md` with agree/disagree per item and blockers.
3. The orchestrator reproduces each finding (pixels, snapshot numbers, code) before acting on it,
   fixes, re-captures as round N+1, and tells reviewers which changes postdate their last capture.
4. Stop when reviewers agree on the checklist — record what still fails and why in `docs/EVIDENCE.md`.

## Risks

| Risk | Mitigation |
|---|---|
| Emergent elements make some genomes strictly better | [SPEC B1] power budget; the balance harness (`tools/balance.ts`) measures element and size parity every pass |
| Lifestyle tracking is personal data (GDPR) | Opt-in, local-first, coarse location; see `docs/SECURITY.md` |
| Real-money / NFT expectations | Explicit non-goal until legal review; genome id is already a stable content hash |
| Visual quality of procedural creatures | Skeleton-first construction + reviewer rounds with fixed checklists and measured geometry |
| Scope (the vision is enormous) | Gall's law phases; every phase ships a working game; SPEC statuses keep gaps visible |
