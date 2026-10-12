# Genemon agent roster

Every role below is a subagent mandate. Builders own **disjoint new files**; the orchestrator
(main session) owns every shared file (`main.ts`, `src/core/*`, `src/data/{axes,elements,grounds,weather,lifestyle}.ts`,
`src/genome/*`, `src/combat/*`, `src/render/*`, `src/ui/*`, `deno.json`, `docs/SPEC.md`, `docs/QUESTS.md`,
`docs/EVIDENCE.md`) and does all integration, builds and verification. A child's report is a self-report
until the orchestrator re-runs it.

| Role | Kind | Owns / produces | Judges |
|---|---|---|---|
| Orchestrator (main session) | builder + integrator | shared files, engine, render, UI, tools | final verdicts, evidence log |
| Economist | builder | `src/economy/*`, `docs/ECONOMY.md` | prices, auction timers, fraud |
| Data scientist | builder | `src/ladder/*`, `src/ml/*`, `docs/AI-AND-DATA.md` | MMR, models, graphs |
| World designer | builder | `src/world/worldmap.ts`, `docs/WORLD.md` | map, territories, spawns, physical vs virtual |
| Game designer (personas) | builder | `src/sim/personas.ts`, `docs/PERSONAS.md` | the 12 player simulations |
| Network specialist + Hacker | builder | `src/net/*`, `docs/NETWORK.md`, `docs/SECURITY.md` | netcode, anti-cheat, threat model |
| Lists & balance designer | builder | `src/data/achievements.ts`, `src/data/quests.ts`, `docs/LISTS.md`, `docs/SCENARIOS.md` | content lists, scenarios |
| Designer (UI/UX) | reviewer | `docs/reviews/round-N/designer.md` | layout, readability, themes, mobile |
| 3D artist | reviewer | `docs/reviews/round-N/artist-3d.md` | creature silhouettes, materials, arena art |
| Physics specialist | reviewer | `docs/reviews/round-N/physics.md` | skeleton constraints, balance, terrain physics |
| Professional player | reviewer | `docs/reviews/round-N/pro-player.md` | depth, counterplay, team building, meta |
| Noob player | reviewer | `docs/reviews/round-N/noob.md` | onboarding, clarity, first 5 minutes |
| Game critic | reviewer | `docs/reviews/round-N/critic.md` | fun, identity, hooks, comparison to Pokémon Stadium/GO |
| Software architect | reviewer | `docs/reviews/round-N/architect.md` | layering, data model, Gall's-law growth path |
| Game tester | reviewer | `docs/reviews/round-N/tester.md` | bugs, edge cases, repro steps |
| Gameplay agent | reviewer | `docs/reviews/round-N/gameplay.md` | combat feel, camera, phases, effects |

Screenshot rule: every visual round is judged by **at least two** reviewers from different roles
(e.g. 3D artist + designer, critic + noob), each scoring the same fixed checklist so rounds are comparable.
