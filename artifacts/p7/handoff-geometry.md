# Pass 7 — lane GEOMETRY handoff (P7-G1 operators, P7-G2 relief / horns / spikes, robustness)

Not committed (the parent integrates). Base: 79b3a9c (calibration final). `src/render/anatomy/loft.ts` is unchanged, so its exports are stable.

## Files
| file | change |
|---|---|
| `src/render/anatomy/ops.ts` | 7 new op kinds; `sym()` mirror pairing for every lobe op; lobe cap `OP_LIMITS.maxLobes = 32` (whole mirror pairs / flute rings kept); relief: `sanitizeRelief`, `reliefActive`, `bandProfile`, `applyRelief` |
| `src/render/anatomy/body.ts` | reads `helix.p7 ?? P7_DEFAULTS`; p7.ops after p5 ops; relief on chains (with band stations), knobs, scallop (ears, tail fin/spade/leaf/fan); horns (extra pairs, antler `branch`, ram `curl` via exported `curlPath`); spike rows; p7 detail budget cascade; first-segment socket fix |
| `src/render/anatomy/limbs.ts` | `LimbOpts.relief` / `reliefStrength` (half-strength relief on limbs; optional, backward compatible); pod/limb socket fix (`fwd`) |
| `src/render/anatomy/wings.ts` | scallop notches on membrane hand panels and fin panels (grid ×2 only when scallop > 0) |
| `tests/p7_geometry_test.ts` | NEW, 14 tests |
| `tools/p7geo.ts` | NEW probe: triangles, build ms, cap breaches, NaN, feature reachability, per-seed triangles |

## Operators (ops.ts, loft frame)
- **ridge**: a sharp crest (amp 0.3·a·w, sharpness 14). A negative amount gives a keel groove.
- **flute**: 4–6 grooves (or ribs, if positive) at PI/2 + 2PI(k+½)/N. The set maps onto itself under x → -x.
- **facet**: moves the exponent toward EXP_MAX (positive) or EXP_MIN (negative), plus 6 alternating broad lobes.
- **scallop**: radius ripple along u (3 crests across the op window).
- **segment**: 2–6 periodic constrictions along u (or raised rings, if positive).
- **knob**: a sharp boss whose window along u is 0.4 × the op width.
- **spiral**: a mirror pair of crests winding in opposite senses (a braid), so it stays bilaterally symmetric.
- **twist** remains the only chiral op (as in pass 5).
- Every result stays inside the existing scale band, lobe amplitude cap and exponent clamp, and passes the loft's safeSection turn guard.

## Angle convention: finding and fix
- `loft.ts`, `applyOps`, the pass-5 tests (`morph_p5_test` carves the back with angle PI/2) and the pass-7 producer (`helix7.ts`: ±PI/2) all use the LOFT frame: 0 = +x lateral, PI/2 = dorsal.
- Two places disagree:
  - The `morphTypes.ts` comment says "0 = dorsal".
  - The pass-5 producer `helix.ts:963` emits `0 | PI` ("dorsal or ventral").
- Consequence in pass 6: every pass-5 carve, merge, bulge or difference landed on ONE flank (+x or -x) of the unmirrored torso, neck or tail, so the body was asymmetric.
- Fix in my lane: every lobe op off the dorsal axis is emitted as a mirror pair (θ, PI−θ). No input angle can break the mirror any more (tested at random angles for all 14 non-twist kinds; the metric is proven able to fail on twist).
  - A pass-5 angle 0 or PI now marks both flanks.
  - I tried converting p5 angles in the consumer (PI/2 − a). It broke `morph_p5_test` "carved back is lower", which uses PI/2 for the back, so I reverted it.
- **Lines for the genome lane (not applied, not tested)** to get the intended dorsal/ventral placement:
  - `src/genome/helix.ts:963`: `angle: orng.chance(0.65) ? 0 : r3(Math.PI), // dorsal or ventral: keeps the bilateral mirror` → `angle: orng.chance(0.65) ? r3(Math.PI / 2) : r3(-Math.PI / 2), // dorsal or ventral (loft frame: PI/2 = dorsal)`. The rng call sequence is unchanged; only angle values move.
  - `src/genome/morphTypes.ts:221`: `/** Angle around the section, radians (0 = dorsal). */` → `/** Angle around the section, radians, loft frame (0 = +x lateral, PI/2 = dorsal, -PI/2 = ventral). */`

## Relief, horns, spikes (body.ts)
- **Relief on chains** (strength 1; limbs and tentacles 0.5): ridges spaced 0.34 rad apart, flutes, facets, segment bands.
  - Bands per chain = segments × chain length / trunk length (capped at 16), with extra stations so they resolve (≤3× the base stations, ≤2× when dense).
  - Never applied to the globe's hidden base.
- **Knobs**: mirrored bosses rooted on the guarded section, placed by a golden-ratio sequence (deterministic, no Math.random). ≤4 pairs per joint, body budget 96 knobs (high) / 64 (low). Material is keratin when knobs ≥ 0.6.
- **Horns**:
  - `pairs`: the missing pairs (pairs − the skeleton's own) grow on the front-most horn of each head and side, seated on the face ellipsoid, each smaller (×0.7 length per extra).
  - `branch`: 1–3 levels of alternating antler tines; each level forks once more.
  - `curl`: a ram helix. Turning radius ≥ 1.4 × the local horn radius; pitch 2.6 × r0 per turn, so one turn never cuts through the previous one.
  - Dense colossi keep plain horns (pass-6 budget rule).
- **Spikes**: `rows` 1 = dorsal, 2 = dorsolateral pair at ±0.62 rad, 3 = both; `length` and `density` apply. Per-row cap comes from the body spike budget (120 high / 60 low).
- **Budget cascade** (only when a body is over `bodyTriangleCap`): full resolution with lite p7 detail → full resolution with p7 pieces off → the pass-6 coarser step → coarse/lite → coarse/off. Legacy (non-plan6) skeletons only step down p7 detail; they are never coarsened (pass-6 rule).
- **P7_DEFAULTS is identical** to a helix without p7: same triangles and the same vertex positions, bit for bit (tested on 6 seeds).

## Robustness fix (parent finding: low fusion buried parts)
- With `helix.fusion` < 0.6, a chain's first segment (neck0 / tail0) or a short baby pod ended inside the socket sphere its parent puts on its pivot, so the viability check reported it as "buried".
- Fix: such a loft now reaches ≥ 1.3 × that socket radius.
  - body.ts: first segment of a chain whose parent belongs to another chain.
  - limbs.ts: `fwd = max(old, 1.3·socketK(role)·r0 − L)`.
- The fusion sweep (90 morph_p5 viability cases × fusion 0, 0.1..1) went from 14/990 non-viable to **0/990**. It is now a test.

## Measured (commands)
- `NO_COLOR=1 deno check main.ts src/ tools/ tests/` → clean.
- `NO_COLOR=1 deno test --no-check --allow-read --allow-write=artifacts tests/` → **ok | 563 passed | 0 failed**.
  - Baseline before my edits, with other lanes in flight: 513 passed / 4 failed (helix_p5 ×2, helix_test anim, morph_p5 viability).
  - `tests/p7_geometry_test.ts`: 14/14, about 50 s (the fusion sweep is 28 s of that).
- `deno run -A tools/p7geo.ts 200` on this tree vs on a scratch copy with the HEAD render files (`~/.hermes/cache/scratch/p7geo/{before,after}.json`), 200 wild seeds:

  | tier | triangles median | mean | p90 | max | build ms median | build ms p90 | build ms max |
  |---|---|---|---|---|---|---|---|
  | low before | 8104 | 7220 | 10448 | 11432 | 4.9 | 7.8 | 28 |
  | low after | 8256 | 7542 | 11092 | 11464 | 6.3 | 25.2 | 47 |
  | high before | 21200 | 19979 | 28788 | 33632 | 9.4 | 12.7 | 29 |
  | high after | 22248 | 20751 | 29764 | 33936 | 10.9 | 14.6 | 76 |

  - Over cap: 0 → 0. Non-finite vertices: 0 → 0.
  - No seed was coarsened (0 seeds with fewer triangles than before). The low-tier p90 build time rises because over-cap bodies go through the cascade.
- **Reachability over 200 wild seeds** (calibrated helix):

  | feature | seeds |
  |---|---|
  | ridges > 0 | 18 |
  | flutes > 0 | 29 |
  | segments with depth > 0 | 33 |
  | ≥ 1 knob pair | 22 |
  | facets > 0 | 188 (mostly tiny values) |
  | scallop > 0 | 192 (mostly tiny values) |
  | spike rows ≥ 1 | 79 |
  | spike rows ≥ 2 | 2 |
  | horns.pairs ≥ 1 | 173 |
  | extra horn pairs actually grown | 4 |
  | branch on a horned skull | 8 |
  | curl on a horned skull | 56 |
  | ≥ 1 p7 op | 19 seeds, 34 ops |

  Every op kind occurred at least once: ridge 3, flute 3, segment 3, spiral 2, knob 1, bulge 7, pinch 5, carve 2, merge 2, compress 2, difference 2, decompress 1, twist 1. Facet and scallop never occurred as op kinds.
- **Visual check**: software rasteriser `~/.hermes/cache/scratch/p7geo/raster.ts` (run from the repo root with `deno run -A --config deno.json <path> [back|bands|horns] [seed]`); PNGs in the same directory. One vision question per feature:
  - `back.png`: 3 spike rows (dorsal plus 2 lateral) and knobs, left/right symmetric. Confirmed.
  - `bands.png`: periodic ring constrictions on the serpent and along the hexapod abdomen. Confirmed.
  - `horn_curl.png`: ram-like curl, not a full closed loop. Confirmed.
  - `horn_pairs.png`: 6 horns, mirror-symmetric. Confirmed.
  - `horn_branch.png`: at first judged "no tines, only a small ridge". Measurement agreed: branch 3 added 4k triangles but moved the horn extent only 0.083 → 0.085. I lengthened the tines and made them stand off the beam: extent 0.089, 3–4 tines per horn on re-check.
- **Colossus finding (pass 6, not caused by p7)**: WORST-count mythic colossi on the low tier are already over the 13000 body cap at P7_DEFAULTS (quadruped 15112, serpent 15528, avian 14776). With p7 at max they stay exactly there: the cascade strips p7 detail to "off". The tests assert `≤ max(cap, pass-6 body)`.

## Not done / caveats
- The browser check `tools/p5gaps.ts` (Chrome) was not run. Floating parts were checked headlessly instead: `checkViability` on every forced-extreme build and the 990-case fusion sweep.
- Viability is checked per merged joint mesh, so a sub-piece inside one mesh (an extra horn, a tine, a knob) is not tested for its own connectivity. Extra horns are seated on the same face ellipsoid formula the skeleton uses (`skeleton.ts` ~l.630).
- Extra horn pairs need horn joints from the skeleton. With plan.horns in (0.35, 0.5) the skeleton has 0 horn pairs while p7.pairs ≥ 1, so nothing grows. That needs a head-joint mesh, which belongs to the face lane.
- Facet and scallop genes are nonzero in about 95 % of wild creatures but usually tiny, so they are not visibly distinct. The genome lane's one-sided calibration decides that.
- Colossi on the low tier show only the section relief (ridges, flutes, facets, bands); spikes, knobs, antlers and extra horns are dropped there by budget.
- The serpent's rest S-curve is not mirror-symmetric in the joint frames, so the mirror test runs on quadruped, hexapod, avian and biped trunks.
- docs (SPEC / EVIDENCE) are not updated; that is the parent's job.
