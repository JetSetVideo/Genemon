# Architecture

**Summary.** One deterministic, pure simulation core (genome → phenotype → battle on a physical
arena) with a single event schema (the Ledger), rendered by three.js and driven by a small DOM UI.
Real-world context sits at the top of the data flow; persistence is per-profile localStorage today,
with a server-authoritative path designed (`docs/NETWORK.md`) because battles replay bit-identically
from a seed. Growth follows Gall's law: each layer was added only on top of a working, tested one.

## Data flow (top → bottom)

```
 REAL WORLD  src/ui/realworld.ts      local time, day phase, season, moon, weather-of-day, device, session
     │
 PROFILE     src/ui/profile.ts        settings (theme, quality, camera...), collection, ordered team, MMR, history
     │
 GENOME      src/genome/genome.ts     26 axis allele pairs + 13 body-plan genes + kind + pattern + hue (seeded)
     │  × CONDITIONS  src/genome/epigenetics.ts   age, xp, diet, habitat hours, experiences, battles, bond, hunger
     ▼
 PHENOTYPE   src/genome/phenotype.ts  axes → size/mass/density/elasticity → elements → normalised stats → abilities → psyche
     │
 SKELETON    src/body/skeleton.ts     joint tree per body kind, dynamic coupled limits, chain budgets, FK, COM, balance
     │
 BATTLE      src/combat/battle.ts     moves (3 phases) + team synergies + AI + reactions + zones + statuses
     │  on    src/world/arena.ts + physics.ts   heightmap, ground grid (mutable), water, weather, bodies
     ▼
 RENDER      src/render/*             CreatureView (from skeleton) · Animator (→ constrainPose) · ArenaView · FX · BattleCamera
     │
 UI          src/ui/*                 screens tree (registry.ts), HUD, charts, settings, Data screen
                                      ▲
 LEDGER      src/core/ledger.ts  ─────┘ every layer emits 5W rows; Data screen, exports, ladder & ML datasets read them
```

## Module map

| Layer | Files | Pure? | Tested by |
|---|---|---|---|
| core | `rng.ts` (mulberry32 + avalanche-hashed seeds, forks), `ledger.ts`, `math.ts` | yes | `tests/core_test.ts` |
| data | `axes.ts` (26 axes, 6 spaces), `elements.ts` (14 elements, chart, 18 reactions), `grounds.ts` (17), `weather.ts` (12), `lifestyle.ts` (14 foods, 15 experiences, habitat nudges), `achievements.ts`, `quests.ts` | yes | core/content tests |
| genome | `genome.ts`, `epigenetics.ts`, `phenotype.ts`, `genemon.ts` (individual + life functions), `breeding.ts` | yes | core tests |
| body | `skeleton.ts` | yes (three math only) | core tests [SPEC K1] |
| world | `arena.ts`, `physics.ts`; `worldmap.ts` (builder: map, places, territories, spawns) | yes | battle/world tests |
| combat | `moves.ts` (77 moves + cost), `team.ts`, `battle.ts`, `scenario.ts` | yes | battle tests + `tools/scenarios.ts` |
| economy | `items.ts`, `market.ts` (builder: auction house) | yes | `tests/market_test.ts` |
| ladder / ml | `mmr.ts` (condition-aware MMR), `stats.ts` (PCA, k-means, Wilson...), `mlp.ts` (neural net) | yes | ladder/ml tests |
| net | `protocol.ts` (envelopes, hashing, replay protection, rate limits), `antiCheat.ts` (GPS plausibility) | yes | `tests/net_test.ts` |
| sim | `personas.ts` (12 simulated players) | yes | `tests/personas_test.ts` |
| render | `stage.ts`, `creature.ts`, `textures.ts`, `animator.ts`, `arenaView.ts`, `fx.ts`, `battleCamera.ts`, `battleView.ts`, `labView.ts`, `genospaceView.ts` | no (WebGL) | `tools/capture.ts` |
| ui | `app.ts`, `dom.ts`, `profile.ts`, `realworld.ts`, `charts.ts`, `widgets.ts`, `screens/*` | no (DOM) | `tools/capture.ts` |

## Key design decisions (and why)

| Decision | Why |
|---|---|
| Allele *pairs* per axis, dominance per axis (additive or extreme) | Mendelian breeding that players can reason about; kept from the legacy lab's double-helix idea. |
| Epigenetic shift capped at ±0.5 through tanh | Life bends a genome without erasing it; no lifestyle can turn any genome into any creature. |
| Power normalised to a size-class budget [SPEC B1] | 26 free axes would otherwise make some genomes strictly better; this keeps variety without power creep and makes "big costs slots" meaningful. |
| Elements emerge from axes | No hand-made species table; a creature raised in water can grow a water secondary type. |
| Real-time simultaneous battle with fixed dt (1/30 s) | Spatial mechanics (travel, area, clashes, zones, knockback) need continuous time; fixed dt keeps it deterministic. |
| One RNG stream per fighter + one for the battle | Position-independent randomness: adding a fighter does not reshuffle everyone else's rolls. |
| Animator → `constrainPose()` gate | Every animation layer is free to ask for anything; the skeleton's dynamic limits and chain budgets decide what the body can do, and the leftover becomes measurable *strain*. |
| Ledger rows are flat primitives | One JSON line per row: diffable, streamable (JSONL export), loadable by any data tool. |
| three.js through a typed shim | Deno does not attach `@types/three` automatically; without the shim three.js code is unchecked `any`. |
| Strict CSP + local bundle | Offline-first, no supply-chain surprises; the capture tool proves zero non-local requests. |

## Build, serve, verify

- `tools/build.ts`: `deno bundle --platform=browser --format=esm --minify` of `main.ts` → `dist/app.js`,
  copies `web/*`, and fails if the bundle contains a remote import.
- `tools/serve.ts`: allowlisted static server with CSP `default-src 'self'` (no inline anything).
- `tools/capture.ts`: real Chrome (headless, ANGLE/Metal), fixed clock, offline routing, per-shot
  engine snapshots, contact sheets, console-error/overflow/blocked-request report.
- `tools/scenarios.ts`: the gameplay scenarios measured over many seeds with confidence intervals.

## Growth path (Gall's law)

1. ✅ A working deterministic core: genome → phenotype → battle, tested and measured.
2. ✅ A working 3D presentation of that core (arena, creatures from skeletons, FX, camera, HUD).
3. ✅ A working personal loop: profiles, team, lab (feed / live / breed), settings, data.
4. ⏳ Integrate the builder modules one at a time, each behind a measured probe: condition-aware
   ladder → auction house → world map & territories → quests & achievements → persona simulator.
5. ⏳ Online: deterministic replays verified by a server (`src/net/protocol.ts`), then presence,
   then the persistent shared world. Never start the server before the local game is fun.
