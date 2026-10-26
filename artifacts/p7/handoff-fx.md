# Pass 7 — lane FX handoff

Not committed (the parent integrates). Measured on the live tree after calibration commits 75e6773 / 79b3a9c.

## Files changed
- `src/render/fx.ts`: per-fighter effects signature, element impacts, scorch decals, strike streaks, ambient motes, allocation-free spawns, full dispose, QA `stats()` / `clearAll()`.
- `src/render/battleView.ts`: wiring (see below).
- `src/render/anatomy/eyeAura.ts`: `setSignature({ intensity, hueShift })` (emission rate x intensity, hue shift) + `tint()`.
- NEW `tests/p7_fx_test.ts` (10 tests), NEW `tools/p7fx.ts` (probe + `--shots` capture), `artifacts/p7/fx/*` (18 PNG + manifest.json + probe.txt).

## Wiring (battleView.ts, already applied)
- Fighter build: `sig = helix.p7?.fx ?? P7_DEFAULTS.fx`, then `fx.setFighterFx(i, sig)` (clamped to FX_BOUNDS), `this.fxSig[i]`, and `cv.aura?.setSignature?.(sig)`.
- Per frame, after `cv.setCharge(...)` (which resets emissive every frame): `pg = pulseGlow(sig.pulse, t, i*1.7)`; `cv.skin.emissiveIntensity += 0.65*pg`; `cv.accent.emissiveIntensity += pg`. The change is made at runtime on the CreatureView materials, so creature.ts and skin.ts are untouched. pulse 0 adds 0.
- Charge motes: rate `14 x intensity`, hue-shifted colour from a scratch Color. This removes a `new THREE.Color` per frame.
- Cone stream gets the fighter index. Stunned sparks now take a glow-budget token. Before, they bypassed the budget.
- Every frame, `fx.ambient(i, centre, radius*ds*1.15, height*ds*1.1, primaryElement, dt)` runs for visible, non-KO fighters. It returns at once when sparkle is 0.
- `snapshot().fx` now includes `fx.stats()` and the per-fighter signatures.

## Behaviour
- **intensity**: counts x intensity (`scaledCount`, exact identity at 1), sizes x sqrt(intensity). Applies to impacts, streaks, beam, cone, dash, projectile trail and charge motes. Every spawn still takes from the pool budgets.
- **trail**: projectile trail life `0.2·(1+1.5·trail)` and rate `28·(1+trail)`. Dash count is `9·(1+trail)` and its life uses the same factor. Beam motes use the same life factor. Strike streak length is `2.4·trail` m (linear, so the Pareto shape carries over).
- **sparkle**: `moteRate = 12·sparkle` motes/s (linear, no floor). Motes take from their own bucket (48/s, burst 12) and from the glow budget. They yield (spawn nothing) when the glow budget is below 35 %.
- **pulse**: `pulseGlow` stays in [0, 0.45·pulse] and breathes at 0.55–0.85 Hz.
- **hueShift**: an HSL hue turn, clamped to ±0.08. At 0 the colour is bit-exact. It applies to impacts, streak, projectile mesh and halo, beam, cone, dash, charge motes, crit ring and flash colour, and the eye aura.
- **Impacts (`IMPACT_PROFILES`, 14 elements)**:
  - fire: embers rise.
  - water: droplets fall, plus a splash ring.
  - plant: leaves flutter (alternating spin).
  - earth: debris falls, plus a dust puff and a crater stain.
  - air: swirl (spin).
  - electric: fast short sparks, plus 1–2 short bolts and a scorch.
  - ice: shards with gravity, plus a frost patch.
  - metal: sparks arc down.
  - poison: bubbles swell and rise, plus a stain.
  - light: big glints that shrink.
  - shadow: wisps sink and grow.
  - psychic: flat expanding ring of motes, plus a halo ring.
  - void: wisps implode onto the hit point.
  - All sprays lie on the strike line and rebound off the struck surface toward the attacker's side. Spraying into the target hid them behind its body in the first captures.
- **Scorch decals**: one shared CircleGeometry, hard cap `TRANSIENT_CAP.decal = 8`, 5 s, hold then fade. Created only on heavy hits.
- **Pass-5 calm rules kept**: budgets, ring/beam/bolt caps and FlashLimiter are unchanged. Every flash still goes through `flash()`.

## Identity (P7_DEFAULTS)
`deno run -A tools/p7fx.ts 400 <copy of git HEAD fx.ts>` reports spawn counts per event type over 4 real 3v3 battles, with budgets lifted, old → new:
- **Equal**: interrupt 60, ko 234, miss 432, beam 680, cone 108, dash 696, emerge 42, bump 228, projectileEnd 392, terrain 36.
- **Changed on purpose**: hit 1354 → 1382 (+28, the new earth debris dust). The main impact count per hit is unchanged (`6+18k+10·crit`). What changed is behaviour per element: plant moved from the glow pool to the smoke pool, the shapes are new, and the extras (splash/halo rings, bolts, scorch) are new transients.
- Projectile-end impacts use the element profile too, with the same count of 7.
- A unit test proves the no-signature path and the P7_DEFAULTS path give identical spawn counts and particle buffers.

## Measurements (command: `deno run -A tools/p7fx.ts 400`, full output in artifacts/p7/fx/probe.txt)
- **Genes over 400 genomes**, as median / p90 / max / share20:
  | gene | median | p90 | max | share20 |
  |---|---|---|---|---|
  | intensity | 1.04 | 1.088 | 1.572 | 0.81 |
  | trail | 0.40 | 0.425 | 0.912 | 0.79 |
  | sparkle | 0.01 | 0.093 | 0.887 | 0.84 |
  | pulse | 0.01 | 0.088 | 0.745 | 0.80 |
  | hueShift | 0 | 0.005 | ±0.077 | 0.82 |
- **Derived effects keep the 80/20 shape**: mote rate median 0.11/s, max 10.6/s, share20 0.84. Streak median 0.96 m, max 2.19 m.
- **Heredity**, r(child, mid-parent) with the unrelated control in brackets:
  - intensity 0.53 (0.05)
  - trail 0.35 (0.10)
  - sparkle 0.38 (−0.08)
  - pulse 0.51 (0.02)
  - hueShift 0.30 (0.07)
- **Real battles replayed at 60 fps**, no signature vs real signatures:
  | seed | glow spawned | peak live glow | motes |
  |---|---|---|---|
  | 1 | 435 → 685 | 57 → 78 | 23 |
  | 2 | 468 → 808 | 29 → 45 | 29 |
  | 3 | 445 → 1482 | 27 → 54 | 707 (one sparkle-1.0 Genemon) |
  | 4 | 1142 → 1633 | 61 → 71 | 6 |
  - Peak transients and flashes are identical in both runs.
- **Tests**: `NO_COLOR=1 deno test --no-check --allow-read tests/p7_fx_test.ts` gives 10/10 ok.
  - Mutation check on a scratch copy: 6/6 mutants killed (impact budget removed, hue ignored, scorch geometry leak, trail ignored, strike orientation off, void not imploding).
- **Full suite**: `NO_COLOR=1 deno test --no-check --allow-read --allow-write=artifacts tests/` gives 560 passed, 4 failed. The 4 failures are in `tests/morph_p5_test.ts` (ops carve, triangle budget) and `tests/p7_geometry_test.ts` (2). Those are the geometry lane's in-flight files, and none of them imports fx, battleView or eyeAura.
- **Typecheck**: `deno check main.ts src/ tools/ tests/` shows one error, in `tests/p7_geometry_test.ts:78` (other lane). My five files check clean.

## Visual evidence (real headless Chrome)
- **How to reproduce**, on a scratch copy:
  - `rsync -a --exclude artifacts --exclude legacy --exclude dist --exclude .git <repo>/ ~/.hermes/cache/scratch/p7fx/`
  - `deno task build`
  - `deno run -A tools/p7fx.ts --shots artifacts/p7/fx 18731`
- **What the capture does**: a 1v1 meadow battle, frozen, with the director update suspended. Each element's hit goes through `consume()` and is stepped by a fixed number of 1/60 s frames before the still is taken. 0 page errors.
- Shots are in `artifacts/p7/fx/`: `impact-<element>.png` ×14, `sig-fire-default.png`, `sig-fire-extreme.png`, `sparkle-1-motes.png`, `sparkle-0-motes.png`. `manifest.json` gives each shot's on-screen particle box and size in px.
- **Vision answers, one question per shot**:
  - fire: 6–8 glowing dots between the creatures, mostly white/pale-pink with a couple of orange. In the first capture, which sprayed into the body, none were visible.
  - water: 4–5 light-blue droplets low near the ground, plus a light-blue splash ring.
  - earth: a brown/tan dust cone at the target's feet.
  - psychic: a pink ring around the lower body, plus pink orbs.
  - sig-fire-extreme: a horizontal streak of 8–10 yellow/white dots trailing toward the target.
  - sparkle 1 vs 0: 5–7 pale specks on or near the body vs "none visible".

## Not done
- Electric, ice, metal, poison, light, shadow, void, plant, air and neutral stills were captured but not read with vision. Only fire, water, earth, psychic, the signature pair and the sparkle pair were.
- No still of the scorch decal was confirmed: the fire-shot vision pass said "no scorch visible", probably under the target's body or shadow. The decal is measured to exist (`transients.decal = 1` in manifest.json).
- **Fire embers read mostly white**, from the additive core colour under ACES. Making them more orange would mean lowering the fire core share (`coreEvery`).
- The pulse glow is not visually verified. It is a time effect, and a still cannot show it. It is unit-tested only.
- Leaf flutter and air swirl are not checked in motion (stills only).
- The typical Genemon has trail ≈ 0.40 (the calibrated median, not 0), so a typical fight now shows short strike streaks and projectile trails ~1.6× as long. That follows the producer's distribution. If the parent wants the median creature to keep the pass-6 look, the fix belongs in the producer or calibration, not in fx.ts.
- `docs/SPEC.md` and `docs/EVIDENCE.md` are not updated (parent-owned).
