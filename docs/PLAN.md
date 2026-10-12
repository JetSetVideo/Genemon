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
| 2 | The 3D game | creatures from skeletons, animator through constraints, arenas × weathers × hours, FX, camera, HUD | ✅ built; review round 1 in progress |
| 3 | The personal loop | profiles (human + AI), team, lab (feed / live / habitat / breed / fuse / morph / mutate), settings, data screen | ✅ built |
| 4 | The social game (local) | condition-aware ladder, auction house, quests & achievements, world map with places & territories — integrated one at a time behind probes | ⏳ modules built by agents, integration = quests L1, E1, Q1, W1 |
| 5 | The simulated society | 12-persona simulator over weeks of play: economy inflation, MMR spread, element diversity, territory churn, retention proxy | ⏳ quest S1 (plan in `docs/PERSONAS.md` §9) |
| 6 | The learning game | outcome predictor and battle policy trained on ledger datasets; live meta feeding move costs; projections of the population | ⏳ quests ML1, M1 |
| 7 | Online | deterministic replay verification server-side, presence, persistent world tick, territory consistency | ⏳ quests N1+ (design in `docs/NETWORK.md`) |
| 8 | Real-world data | opt-in geolocation, OpenStreetMap places, live weather, health/activity trackers (privacy first) | ⏳ quest G1 |

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
