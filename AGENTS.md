# AGENTS.md — Genemon

Hard rules first, for any coding agent working in this repo (Hermes, Claude Code, Codex, Cursor).
This file is deliberately SHORT and stable. The long form — current state, quest order, review history —
is `docs/START-HERE.md`. Requirement statuses: `docs/SPEC.md`. What was measured: `docs/EVIDENCE.md`.
What to do next: `docs/QUESTS.md`.

## What this is

Genemon: 3D generative monsters that evolve with their player's real life (hours, places, food, battles)
and fight in physical arenas whose ground, weather and time of day matter. Deno 2 + strict TypeScript +
**three.js only**. One deterministic simulation core (genome → epigenetics → phenotype → skeleton →
battle on a physical arena), one event schema (the Ledger), three.js rendering, a small DOM UI.
Offline, strict CSP, one local bundle.

## Commands (repo root)

```
deno task check       # strict typecheck: main.ts, src/, tools/, tests/
deno task test        # unit tests (tests/*_test.ts)
deno task scenarios   # the gameplay scenarios over many seeds
deno task balance N   # element matrix, big-vs-swarm parity, corpus
deno task lists       # regenerate the generated tables of docs/LISTS.md from code
deno task build       # bundle -> dist/app.js
deno task dev         # build + serve on http://127.0.0.1:8800  (the USER runs this)
deno task capture N   # real headless Chrome -> artifacts/qa/round-N/ (owns its server)
```

A tool call cannot keep a server alive: never try to start `deno task dev` for the user — tell them the
one command to run. `deno task capture N` starts and stops its own server.

## Hard rules (each exists because breaking it caused a real bug)

1. **Determinism.** Simulation randomness goes through `Rng` (`src/core/rng.ts`) seeded with
   `hashSeed(...)`; never `Math.random()` / `Date.now()` in simulation logic — pass `now`, seeds and the
   local hour in. Same seed + same teams = same battle (replays, server re-simulation and datasets depend
   on it). Render-only cosmetic jitter in `src/render/` may use `Math.random()`; it must never feed back
   into the simulation.
2. **The Ledger is the only event schema** (`src/core/ledger.ts`): every state change emits one flat row
   answering where / when / who / what / why / from / to / entries / exits, values being
   number | string | boolean. A new mechanic means a new `what` name recorded in `docs/DATA-MODEL.md` and
   declared in `CONTENT_EVENTS` (`src/data/achievements.ts`).
3. **three.js only through `src/lib/three.ts`** (and `src/lib/orbit.ts`). A bare `import "three"`
   type-checks as `any` under Deno and silently hides every three.js type error.
4. **Layering.** `core` and `data` import nothing above them; `genome`, `body`, `combat`, `world`,
   `economy`, `ladder`, `ml`, `net`, `progress`, `sim` are pure (no DOM; `body` uses three.js math types
   only); only `src/render/` and `src/ui/` touch WebGL or the DOM. New UI screens are registered in
   `src/ui/screens/registry.ts` — navigation, colours and the capture tool all read that list.
5. **Balance contract [SPEC B1].** Combat power is normalised to the size-class budget
   (`src/genome/phenotype.ts`); axes change the *shape* of a Genemon, never its total power. Anything that
   wins fights (defence, evasion, regeneration, accuracy, crit) is paid for out of the same budget.
6. **Strict CSP, offline.** No CDN, no inline scripts or styles. Dynamic styling goes through CSS custom
   properties via `h(..., { vars })` (`src/ui/dom.ts`).
7. **Honest status.** A module only a test or a tool calls is NOT a shipped feature. Update `docs/SPEC.md`
   (LIVE / TESTED / MODEL / OPEN) and append what you *measured* to `docs/EVIDENCE.md` in the same commit
   as the change. When a later pass contradicts an earlier claim, append a correction — never edit history.
8. **Ownership.** Parallel builders own disjoint NEW files; the orchestrator owns the shared files
   (`main.ts`, `src/ui/*`, `src/render/*`, `src/combat/*`, `src/genome/*`, `src/core/*`, `deno.json`,
   `docs/SPEC.md`, `docs/QUESTS.md`, `docs/EVIDENCE.md`). A builder returns the exact lines to add to a
   shared file instead of editing it.
9. **A QA metric that cannot fail is not a metric.** Every measurement must be able to report a failure
   and must be cross-checkable against the per-shot manifest. (The readability table counted only fighters
   it had already found on canvas, reported "smallest fighter 41 px", and missed that a living fighter was
   off-screen entirely in 7 of 12 auto-camera shots.)
10. **Never claim a fix you have not seen.** A change that has not been re-captured or re-measured goes in
    as "fixed, verification pending" plus the exact command that will verify it.

## Verification discipline

- Run `deno task check` and `deno task test` before every commit and quote the real output.
- "Fixed" needs a measurement: `deno task scenarios`, `deno task balance N`, or `deno task capture N` plus
  a vision pass. Never report plausible numbers you did not produce.
- Visual rounds are judged by at least two reviewers from different roles against the fixed checklist in
  `docs/reviews/CHECKLIST.md`; tell them the round number and which changes postdate their last capture.
- Do not tune balance without re-measuring: an intermediate configuration measured **better** (12/13
  elements in band) than the current one (10/13) and the difference is inside the noise — see the
  regression note in `docs/EVIDENCE.md`.
- Subagent reports are self-reports. Run their tests yourself and verify any artifact they claim to have
  written before repeating the claim.

## Where things live

| Path | What |
|---|---|
| `src/core`, `src/data` | RNG, ledger, math; axes, elements, grounds, weather, lifestyle, achievements, quests |
| `src/genome`, `src/body` | genome → epigenetics → phenotype; skeleton, coupled joint limits, balance |
| `src/combat`, `src/world` | moves, teams, battle, scenarios; arena, physics, world map |
| `src/economy`, `src/ladder`, `src/ml`, `src/net`, `src/progress`, `src/sim` | auction house; MMR + context + ranked; stats/MLP/win model; protocol + anti-cheat; quests engine; personas |
| `src/render`, `src/ui` | the only WebGL/DOM layers; UI screens come from `screens/registry.ts` |
| `tools/` | build, serve, capture, scenarios, balance, gen-lists harnesses |
| `web/` | `index.html`, `styles.css`, manifest; `dist/` is generated |
| `docs/` | the source of truth (see the map at the top of `docs/START-HERE.md`) |
| `docs/LISTS.md` | generated tables — edit the code, then run `deno task lists` |
| `artifacts/` | generated evidence: `qa/round-N/`, `balance/`, `scenarios/`, `tmp/` (scratch probes) |
| `artifacts/wip/` | parked, half-built work; deliberately outside the typecheck and test paths |
| `legacy/nuxt-lab/` | the frozen prototype this grew from; never built or imported |

## Debug / QA surface

`globalThis.__GENEMON__` = `{ app, ledger, snapshot(), go(screen), battle(opts) }`. `snapshot()` returns
the active screen, a profile summary, the active 3D view's state (camera mode and framing numbers; each
fighter's phase, move, statuses, ground, joint strain, balance stability, triangle count and on-screen box
in CSS px), ledger counts, real-world context and fps. Use the exact global name — no optional chaining —
or a typo silently photographs the default view.

## Commits

One concern per commit; the message says what changed and what was measured; the `docs/` update rides in
the same commit as the code it describes.
