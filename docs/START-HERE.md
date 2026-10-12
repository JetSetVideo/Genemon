# START HERE — orientation for AI coding sessions

> A root `AGENTS.md` was not created: writing agent-instruction files needs the user's explicit
> approval, and that prompt timed out. If the user approves later, this file can be copied there.

Genemon is a 3D generative-monster game: Pokémon Stadium-style battles + a Pokémon GO-style world,
where every monster ("Genemon") is generated from a genome and keeps evolving with the real life of
its player (time, places, food, battles, experiences). Deno 2 + strict TypeScript + **three.js only**.

## 30-second orientation

| Need | Go to |
|---|---|
| What the game is and why | `docs/VISION.md` |
| What is built, tested, modelled or still open (requirement ids) | `docs/SPEC.md` |
| What to do next (development quests, acceptance criteria) | `docs/QUESTS.md` |
| What was measured each pass (honest evidence log) | `docs/EVIDENCE.md` |
| Rules of play (damage formula, phases, reactions, slots, costs) | `docs/GAMEPLAY.md` |
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
deno task build       # bundle -> dist/app.js (+ index.html, styles.css)
deno task dev         # build + serve dist/ on http://127.0.0.1:8800 (the user runs this; tool calls cannot keep servers alive)
deno task capture N   # real headless Chrome QA screenshots -> artifacts/qa/round-N/ (starts and stops its own server)
```

## House rules (each one exists because breaking it caused a real bug somewhere)

1. **Determinism.** Every random draw in simulation code goes through `Rng` (`src/core/rng.ts`),
   seeded via `hashSeed(...)`. Never `Math.random()` / `Date.now()` inside simulation logic — pass
   `now` and seeds in. Same seed + same teams = same battle: replays, server re-simulation and
   datasets depend on it. (Render-only jitter in `src/render/` may use `Math.random`; it never feeds
   back into the simulation.)
2. **The Ledger is the single event schema** (`src/core/ledger.ts`): every state change emits one flat
   row answering where / when / who / what / why / from / to / entries / exits. A new mechanic means a
   new `what` name, documented in `docs/DATA-MODEL.md`.
3. **Import three.js only through `src/lib/three.ts`** (and `src/lib/orbit.ts`). A bare `import "three"`
   type-checks as `any` under Deno and silently hides every three.js type error.
4. **Layering.** `core` and `data` import nothing above them; `genome`, `body`, `combat`, `world`,
   `economy`, `ladder`, `ml`, `net`, `sim` are pure (no DOM; `body` uses three.js math types only);
   only `src/render/` and `src/ui/` touch WebGL or the DOM.
5. **Balance contract [SPEC B1]:** combat power is normalised to the size-class budget
   (`src/genome/phenotype.ts`); axes change the *shape* of a Genemon, not its total power.
6. **Strict CSP, offline:** no CDN, no inline styles or scripts. Dynamic styling uses CSS custom
   properties via `h(..., { vars })` (`src/ui/dom.ts`).
7. **Honest status.** A module only a test or a tool calls is not a shipped feature. Update
   `docs/SPEC.md` (LIVE / TESTED / MODEL / OPEN) and append to `docs/EVIDENCE.md` what you *measured*.
8. **Builders own disjoint new files; the orchestrator owns shared files** (`main.ts`, `src/ui/*`,
   `src/render/*`, `src/combat/*`, `src/genome/*`, `src/core/*`, `deno.json`, SPEC/QUESTS/EVIDENCE).

## Debug / QA surface

`globalThis.__GENEMON__` = `{ app, ledger, snapshot(), go(screen), battle(opts) }`. `snapshot()`
returns the active screen, a profile summary, the active 3D view's state (camera mode and framing
numbers; every fighter's phase, move, statuses, ground, joint strain, balance stability, triangle
count), ledger counts, real-world context and fps. Use the exact global name (no optional chaining)
in probes, or a typo silently photographs the default view.
