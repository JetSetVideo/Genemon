# START HERE — orientation for AI coding sessions

> A root `AGENTS.md` was not created: writing agent-instruction files needs the user's explicit
> approval, and that prompt timed out. If the user approves later, this file can be copied there.

Genemon is a 3D generative-monster game: Pokémon Stadium-style battles + a Pokémon GO-style world,
where every monster ("Genemon") is generated from a genome and keeps evolving with the real life of
its player (time, places, food, battles, experiences). Deno 2 + strict TypeScript + **three.js only**.

## Where the project stands (last updated: pass 2, 2026-10-12, commit `d2f49da`)

- **Working and verified in a browser:** all 10 screens (Home, Arena, Team, Lab, World, Market,
  Ladder, Feats, Data, Settings) load on desktop, tablet and phone with 0 console errors and no
  overflow; 196 unit tests pass; the 6 brief scenarios pass; balance is measured (10/13 elements in
  band, slot parity 42–44 %).
- **Not ready to ship:** the battle camera loses fighters off-screen (below). Round-3 reviewers scored
  3D/physics 34/100 and design 56/100; reports in `docs/reviews/round-3/`.
- **First three quests** (`docs/QUESTS.md`, in order): **C2** keep every living fighter in frame and
  make the capture metric able to fail · **A7** KO'd fliers fall, camera buttons off the HP cards,
  honest weather shots · **L2** make the ladder's conditions count from match 1.
- **Built but not wired:** the Insights screen (quest D6, 2 lines), the persona simulator (parked in
  `artifacts/wip/sim/`, quest S1), netcode (no server).
- **Parked outside the typecheck/test paths on purpose:** `artifacts/wip/` — `deno task check` and
  `deno task test` do not see it.

## 30-second orientation

| Need | Go to |
|---|---|
| What the game is and why | `docs/VISION.md` |
| What is built, tested, modelled or still open (requirement ids + statuses) | `docs/SPEC.md` |
| What to do next (quests with acceptance criteria) | `docs/QUESTS.md` |
| What was measured each pass, and the corrections to earlier claims | `docs/EVIDENCE.md` |
| Rules of play (damage formula, phases, reactions, slots, costs, winning) | `docs/GAMEPLAY.md` |
| Code layout, data flow, determinism, build | `docs/ARCHITECTURE.md` |
| Ledger event schema + catalogue, persisted shapes | `docs/DATA-MODEL.md` |
| Visual / UI / animation / camera design | `docs/DESIGN.md` |
| Roadmap (Gall's law phases) + 12-persona simulation plan | `docs/PLAN.md`, `docs/PERSONAS.md` |
| Master lists (axes, elements, moves...) + scenarios | `docs/LISTS.md`, `docs/SCENARIOS.md` |
| Economy / world / AI & data / network / security | `docs/ECONOMY.md`, `docs/WORLD.md`, `docs/AI-AND-DATA.md`, `docs/NETWORK.md`, `docs/SECURITY.md` |
| Agent roles and the review protocol | `docs/team/ROSTER.md`, `docs/reviews/` |
| The legacy Nuxt prototype this grew from | `legacy/nuxt-lab/` (frozen, not built) |

## Commands (repo root)

```
deno task check       # strict typecheck of main.ts, src/, tools/, tests/
deno task test        # unit tests (tests/*_test.ts)
deno task scenarios   # gameplay scenarios over many seeds -> artifacts/scenarios/REPORT.md
deno task balance N   # element matrix, big-vs-swarm parity, corpus -> artifacts/balance/REPORT.md
deno task lists       # regenerate every generated table of docs/LISTS.md from the code
deno task build       # bundle -> dist/app.js (+ index.html, styles.css)
deno task dev         # build + serve dist/ on http://127.0.0.1:8800 (the user runs this; tool calls cannot keep servers alive)
deno task capture N   # real headless Chrome QA screenshots -> artifacts/qa/round-N/ (starts and stops its own server)
```

`deno task capture N` is roster-driven: it reads the nav's `data-nav` ids (generated from
`screens/registry.ts`) and fails if a registered screen was not captured, so a new screen cannot
silently go unphotographed.

## House rules (each one exists because breaking it caused a real bug somewhere)

1. **Determinism.** Every random draw in simulation code goes through `Rng` (`src/core/rng.ts`),
   seeded via `hashSeed(...)`. Never `Math.random()` / `Date.now()` inside simulation logic — pass
   `now` and seeds in. Same seed + same teams = same battle: replays, server re-simulation and
   datasets depend on it. (Render-only jitter in `src/render/` may use `Math.random`; it never feeds
   back into the simulation.) Pure modules that need the local hour receive it as a parameter
   (`LifeCtx.hour`, `localHour(now)` in the UI layer).
2. **The Ledger is the single event schema** (`src/core/ledger.ts`): every state change emits one flat
   row answering where / when / who / what / why / from / to / entries / exits. A new mechanic means a
   new `what` name, documented in `docs/DATA-MODEL.md`.
3. **Import three.js only through `src/lib/three.ts`** (and `src/lib/orbit.ts`). A bare `import "three"`
   type-checks as `any` under Deno and silently hides every three.js type error.
4. **Layering.** `core` and `data` import nothing above them; `genome`, `body`, `combat`, `world`,
   `economy`, `ladder`, `ml`, `net`, `progress`, `sim` are pure (no DOM; `body` uses three.js math types
   only); only `src/render/` and `src/ui/` touch WebGL or the DOM.
5. **Balance contract [SPEC B1]:** combat power is normalised to the size-class budget
   (`src/genome/phenotype.ts`); axes change the *shape* of a Genemon, not its total power. The power
   index prices defence, evasion (×0.8 of its face value), regeneration, accuracy and crit, so a
   speciality is paid for in raw HP and attack.
6. **Strict CSP, offline:** no CDN, no inline styles or scripts. Dynamic styling uses CSS custom
   properties via `h(..., { vars })` (`src/ui/dom.ts`).
7. **Honest status.** A module only a test or a tool calls is not a shipped feature. Update
   `docs/SPEC.md` (LIVE / TESTED / MODEL / OPEN) and append to `docs/EVIDENCE.md` what you *measured*.
   When a later pass contradicts an earlier claim, append a correction rather than editing history.
8. **Builders own disjoint new files; the orchestrator owns shared files** (`main.ts`, `src/ui/*`,
   `src/render/*`, `src/combat/*`, `src/genome/*`, `src/core/*`, `deno.json`, SPEC/QUESTS/EVIDENCE).
9. **A QA metric that cannot fail is not a metric.** The readability table counted only fighters it had
   already found on canvas, reported "smallest fighter 41 px", and missed that in 7 of 12 auto-camera
   shots a living fighter was off-screen entirely. Make every measurement able to report a failure, and
   prefer a number the reviewers can cross-check against the manifest.
10. **Never claim a fix you have not seen.** A code change that has not been re-captured or re-measured
    goes in as "fixed, verification pending" with the command that will verify it.

## Debug / QA surface

`globalThis.__GENEMON__` = `{ app, ledger, snapshot(), go(screen), battle(opts) }`. `snapshot()`
returns the active screen, a profile summary, the active 3D view's state (camera mode and framing
numbers; every fighter's phase, move, statuses, ground, joint strain, balance stability, triangle
count, and its on-screen box in CSS px), ledger counts, real-world context and fps. Use the exact
global name (no optional chaining) in probes, or a typo silently photographs the default view.

## Build provenance (which model wrote which pass)

The codebase was built in passes, each ending with measurements; the orchestrating model is recorded
because reviewer prompts and reasoning style changed with it. `docs/EVIDENCE.md` holds the pass log.

| Pass | Work | Orchestrator model |
|---|---|---|
| 1 | core → genome → skeleton → battle → render → UI, first QA round, 3 reviews | claude-opus-5-5 (anthropic) |
| 2 | integrity + legibility pass (exploits X1-X8, posture, side markers, layouts), World / Market / quests integrated, ladder wired, QA rounds 2-4, round-3 reviews | claude-opus-5-5 (anthropic) |
| 3 (current) | review findings recorded (C2 camera, A7, L2, D6, S1), time-of-day fix, docs synced | deepseek/deepseek-v4.1-flash (openrouter) |
