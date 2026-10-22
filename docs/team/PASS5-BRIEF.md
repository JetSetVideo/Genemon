# Pass 5 brief — the founder's requests of 2026-10-22 (second message), decoded into requirement ids

Read first: `AGENTS.md`, `docs/team/BUILDER-BRIEF.md` (hard rules, final-answer format), then your lane below.
The request was voice-transcribed (phonetic drift: "Fittus" = fetus, "Canondas" = circadian rhythms,
"caduillage" = graduations / a measuring scale, "pray them" = breed them, "drills" = frills / stripes,
"auctions" = the actions and the auction house). **Do not erase anything — develop it.**
Status words: OPEN until code + test + (for visuals) a browser capture prove it.

## Requirement ids (user's intent)

| id | requirement |
|---|---|
| P5-U1 | ICONS for every object (foods, gear, cosmetics, loot): drawn, element-coloured, readable at 24-40 px. |
| P5-U2 | DRAG an object from the right panel (bag) onto the main 3D view to FEED the Genemon; SEE the effects (eat animation + stat / axis deltas popup). |
| P5-U3 | A Genemon PROFILE page: statistics, attacks, story, character, associated objects, age, parents, senses, digestion, scars, evolution path. |
| P5-U4 | Nicer panels: section titles on distinct background colour shades; the actions (feed, train, breed...) all work; the auction house is finished (lots with icons, ending soon, won/lost outcome). |
| P5-V1 | 3D generation includes the COST and PROPERTIES of every evolution step (egg -> fetus -> hatchling -> juvenile -> adult -> elder -> ancient). |
| P5-V2 | Development from the EGG: a FETUS spiralling on itself, uncurling as it grows; nodes grow inside min/max LENGTH, STRENGTH and ANGLE gene bands (GrowthGenes). Fluid from birth: baby features (big head, big eyes, short limbs) fade with growth (neoteny). |
| P5-V3 | Morph OPERATORS after growth: carve (dig), merge, compress, decompress, difference, twist, bulge, pinch; viability checks: everything connected, nothing floating inside or outside the body. |
| P5-V4 | More face shapes: round beaks of several sizes, eyeballs and mouths scaled on X / Y / Z, teeth, tongues (forked), lips. Eyes DUG into sockets (carved head), 1 eye minimum, up to 8, several layouts, heights, angles, non-round outlines (almond, tear, crescent, hooded, diamond). |
| P5-V5 | Symmetry respected, but a limb pair may drift a little from its goal (limbVariation); shoulders vary (width, height, hump); arms with mathematical complexity (fractal branching, spiral, mandelbrot-like). |
| P5-V6 | Body plans: bipeds, serpents (that slither and can rear up on legs), octopus-like (tentacles), chimera mixes. Elements shape the parts: water curves, rock / metal angular, fire flames on wings / tail. Tails: more shapes and lengths. |
| P5-V7 | More cel shading; BELLY differs from the back (countershading, own texture); texture overlays, stripes, frills; coats: fur, scales, feathers, LEAVES (plants), chitin, slime, bark, crystal. Low polycount kept. |
| P5-V8 | Scars from fights, visible on the body; age shows (elders). |
| P5-A1 | Smoother, SLOWER animations; fights are too fast. |
| P5-A2 | Animation aware of where the head is and of the creature's state (hungry, sleepy, bloated, charging, KO); the head looks at its target; serpents slither (sinusoid) and rear up; mouths move (breath, chew, roar). |
| P5-B1 | Fewer powers per fight (less effect spam); a basic DECISION TREE shaped like a small neural model for the fighting patterns. |
| P5-B2 | Awareness: each Genemon knows where the others are and where they LOOK (facing, field of view, hearing behind). |
| P5-G1 | SENSES in the genome, derived from the features (big ears -> hearing): vision (range, field of view), hearing, smell, touch, taste, thermal, magnetism, electroreception, psychic / empathy, vibration. |
| P5-G2 | Every sense is DOUBLE-EDGED: more sensitive = more affected by moves through that channel (sonic moves hurt big ears more: RESONANCE); budget-neutral [SPEC B1]. |
| P5-G3 | A DIGESTION system: food is eaten into a stomach (capacity), digested over hours, efficiency depends on the diet class; overfeeding bloats. |
| P5-G4 | CIRCADIAN rhythms affected by altitude and age; they modulate fighting, production and breeding. |
| P5-G5 | Long loops: feed regularly, watch them evolve and get OLD; scars accumulate; elders past a point can no longer RANK. |
| P5-G6 | IMPRINTING: objects imprint particularities that can pass down to the next generations. |
| P5-L1 | Loops at several time scales: the 2-3 minute match, the daily feeding / digestion, the weekly growth, the lifetime. |
| P5-D1 | TEST DEMO controls: age faster (time scale), overfeed past the limit, almost unlimited money. |
| P5-D2 | A better Pokédex: unlock and develop species. |
| P5-W1 | Maps and minimaps: object density, heights, altitude levels; some RANKED maps built with symmetry; choosable starting points. |
| P5-H1 | Main menu: a PLATFORM with graduations to measure the size visually; SEVERAL team Genemon on the home screen at once, interacting (friends). |
| P5-X1 | BATCHES: breed and run generations in batches; archetype matchup MATRICES (fast / powerful / clever / tank / sensory) proving every archetype has pros and cons; weights, costs and probabilities explained. |

## Contracts already landed (use them, do not redo them)

- `src/genome/morphTypes.ts` (end of file): `MorphP5` (`EyeP5`, `MouthP5`, `GrowthGenes`, `BodyP5`, `SkinP5`, `MorphOp`),
  optional `MorphHelix.p5`, and `P5_DEFAULTS`. Consumers read `helix.p5 ?? P5_DEFAULTS`.
- `src/genome/lifeTypes.ts`: senses, digestion, life clock, scars, imprints, evolution steps, `DevSettings`, and the
  exact API signatures (in the header) the genetics-life lane exports.
- `Genemon.life?: LifeState` (src/genome/genemon.ts), `Settings.dev?: DevSettings` (src/ui/profile.ts).

## Lanes (each owns ONLY its files; anything else = exact lines in the final answer)

| lane | owns (edit / create) | requirement ids |
|---|---|---|
| genetics-life | NEW `src/genome/senses.ts`, `digestion.ts`, `lifeclock.ts`, `imprint.ts`, tests | P5-G1..G6, P5-V1 (costs), P5-L1 |
| battle-brain | `src/combat/battle.ts`, `kit.ts`, `moves.ts`, `movesKit.ts`; NEW `src/combat/brain.ts`, tests | P5-B1, P5-B2, P5-A1 (sim pace) |
| body-morph | `src/body/skeleton.ts`, `src/render/anatomy/{body,limbs,loft,wings,hitbox}.ts`; NEW `anatomy/ops.ts`, `anatomy/egg.ts`, `anatomy/viability.ts`, tests | P5-V2, V3, V5, V6 |
| helix-face | `src/genome/helix.ts`, `src/render/anatomy/{face,eyeAura}.ts`, tests | P5-V4 + the derivation of ALL `p5` genes |
| skin-coat | `src/render/anatomy/skin.ts`, `src/render/textures.ts`; NEW `anatomy/coat.ts`, tests | P5-V7, P5-V8 |
| animation | `src/render/{animator,battleView,fx,labView}.ts` | P5-A1, P5-A2 |
| ui-sheet | `src/ui/screens/lab.ts`, `src/ui/widgets.ts`, `src/ui/moveCard.ts`, `src/ui/screens/market.ts`; NEW `src/ui/icons.ts`, `src/ui/sheet.ts`, `src/ui/dragFeed.ts` | P5-U1..U4 |
| home-dex | `src/ui/screens/{home,dex,settings}.ts`, `src/ui/hatch.ts`; NEW `src/render/homeView.ts`, `src/ui/lifeLoop.ts` | P5-H1, P5-D1, P5-D2, P5-L1 (UI) |
| world-maps | `src/world/{arena,arenaStats,worldmap}.ts`, `src/render/{arenaView,arenaPreview,worldView}.ts`, `src/ui/screens/{arena,world}.ts`, `src/ui/arenaDossier.ts` | P5-W1 |
| batch-lab | NEW `src/sim/batch.ts`, `tools/batch.ts`, `src/ui/screens/batch.ts`, tests | P5-X1 |

Orchestrator-owned (lines only): `main.ts`, `src/ui/app.ts`, `src/ui/screens/registry.ts`, `src/ui/profile.ts`, `web/styles.css`,
`src/render/creature.ts`, `src/render/stage.ts`, `src/genome/{genemon,genome,phenotype,breeding,epigenetics,morphTypes,lifeTypes}.ts`,
`deno.json`, `docs/*`. CSS: one block in the final answer, class names prefixed with your lane.

## Working in a shared tree (everyone edits at once)

- `deno check <your files>` type-checks their imports too; other lanes' in-flight edits may show errors in THEIR files: filter to yours.
- Run YOUR tests: `deno test --no-check --allow-read tests/<yours>_test.ts` (add `--allow-write=artifacts` if you write there).
- Determinism, the Ledger, three.js via `src/lib/three.ts`, strict CSP (no inline style, no innerHTML markup) — AGENTS.md.
- Keep triangle budgets: a creature at quality "high" under ~40k triangles, "low" under ~15k (measure with `triCount`).
