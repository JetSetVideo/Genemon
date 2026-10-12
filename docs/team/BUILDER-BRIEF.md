# Builder brief (read this first, then your task)

Genemon: a 3D generative-monster game (Pokémon Stadium battles + Pokémon GO world) at
`/Users/macmax/Desktop/Genemon`. Deno 2 + strict TypeScript (`noUnusedLocals`, `noUnusedParameters`)
+ three.js as the ONLY library. Read `docs/START-HERE.md` (house rules) and `docs/ARCHITECTURE.md`.

## Hard rules
1. **File ownership.** Create/modify ONLY the files your task lists. Never edit `src/ui/app.ts`,
   `src/ui/screens/registry.ts`, `web/styles.css`, `deno.json` or anyone else's files. If you need a
   change there, put the EXACT lines to add in your final answer; the orchestrator applies them.
2. **Determinism in pure modules** (`src/` outside `src/ui` and `src/render`): randomness only via
   `Rng`/`hashSeed` (`src/core/rng.ts`); no `Math.random()`, no `Date.now()` — take `now` (ms) as a
   parameter. UI code may read `Date.now()` and pass it down.
3. **Ledger**: state changes emit one flat row through `ledger.emit({ when, where: {x,y,z,zone,space},
   who, what, why, from, to, entries, exits })` (`src/core/ledger.ts`); entries/exits values are
   number | string | boolean only.
4. **three.js only through** `import * as THREE from "../lib/three.ts"` (and `../lib/orbit.ts`); a bare
   `"three"` import type-checks as `any`.
5. **Strict CSP**: no inline styles, no `innerHTML` with markup you build. Build DOM with
   `h(tag, attrs, ...children)` from `src/ui/dom.ts`; dynamic style values go through
   `h(..., { vars: { name: value } })` (CSS custom properties). Use the existing classes from
   `web/styles.css`: `section` (via `section(title, ...children)`), `row`, `grid2`, `grid3`, `muted`,
   `mono`, `kv` (a `<dl>`), `btn`, `btn primary`, `btn big`, `btn small`, `btn on`, `el` (element chip,
   `vars: { el: "#hex" }`), `size`, `cards` + `gcard` (`sel`, `name`, `swatch` with `vars: { sw }`),
   `bar` (use `bar(frac, color)`), `table.t`, `canvas.chart`, `feed` + `ev`, `field` (labels).
   Helpers in `src/ui/dom.ts`: `h`, `$`, `clear`, `hex`, `fmt`, `pct`, `bar`, `section`, `select`,
   `toast`, `download`. Widgets in `src/ui/widgets.ts`: `elChip`, `genemonCard`, `statsBlock`, ...
   Charts in `src/ui/charts.ts`: `barChart`, `histogram`, `lineChart`, `scatter`.
6. **Imports** are relative paths ending in `.ts`.

## The App you integrate with (`src/ui/app.ts`, read it)
- `app.profile: Profile` (`src/ui/profile.ts`: `id, name, kind, credits, collection: Genemon[],
  team: string[] (ordered ids), mmr, stats, history, pokedex, achievements, home, friends, settings`),
  `app.save()` (persist the active profile), `app.render()` (re-render the active screen's panel),
  `app.go(screenId)`, `app.select(genemonId)`, `app.selected`, `app.selectedGenemon()`.
- `app.store: ProfileStore` (`list()`, `get(id)`, `save(p)`), `app.ledger: Ledger`, `app.log(what, why, to, detail)`.
- `app.rw: RealWorld` (`hour, dayPhase, season, weather, device, now`), `app.hourNow()`.
- `app.stage: Stage` (`scene`, `camera`, `controls` (OrbitControls), `renderer`), `app.mountView(view)`
  mounts any object implementing `View { update(dt, t); dispose(); snapshot?() }` as the active 3D view.
- `app.startBattle({ arena: ArenaKind, weather: WeatherId | "auto", hour: number | "real",
  opponent: "rival" | "profile" | "wild" | "mirror", opponentProfile?, seed? })`.
- Screen modules export `render<Name>(app): HTMLElement` and optionally `mount<Name>(app): void`
  (called once when the screen opens, e.g. to mount a 3D view). Registration happens in
  `src/ui/screens/registry.ts` (orchestrator).
- `localStorage` is the persistence layer: write store helpers that take a Storage-like
  `{ getItem(k), setItem(k, v), removeItem(k) }` so they are testable in plain Deno.

## Tests and commands
- Tests live in `tests/<name>_test.ts`, import `{ assert, assertEquals, assertAlmostEquals, assertThrows }`
  from `./_assert.ts`, and cover the PURE parts (no DOM).
- You may try `cd /Users/macmax/Desktop/Genemon && deno check <your files>` and
  `deno test --allow-read tests/<your test>`. If a command is denied or needs approval, do not
  retry: write "not executed". The orchestrator re-runs everything; a self-reported pass is unverified.

## Final answer format
Files written · exported API (signatures) · EXACT integration lines for files you do not own ·
test status (honest: executed or not) · open issues / limitations.
