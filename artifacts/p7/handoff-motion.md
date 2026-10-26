# Pass 7 — lane MOTION handoff

Not committed: the parent integrates and commits.

## Files
- `src/render/animator.ts` (modified; +357/−12): reads the motion genes, adds 2 input-driven improvements, adds the exported helpers `springStepDamped`, `springStepRamp` and `motionOf`.
- `tests/p7_motion_test.ts` (new): 12 tests.
- `artifacts/p7/animator_pre_p7.ts` (new): a FROZEN copy of `src/render/animator.ts` at 65e4591. Only the import paths are rewritten. The identity test imports it. Do not edit it. `deno.json` excludes `artifacts/` from discovery, but `deno check tests/` still type-checks the file through the test's import, and that check passes.
- `artifacts/p7/handoff-motion.md` (this file).

## What each gene does (`motionOf(helix)` reads `(helix.p7 ?? P7_DEFAULTS).motion` and clamps it to its range)
- **followThrough 0..1**: the tail chains, the neck chains (plus the main head) and the ears lag the body (overlapping action).
  - For each joint and axis (pitch, yaw), the joint's world angle (ancestors + the chain up to that joint) is tracked by an underdamped spring.
  - Damping ratio ζ = 1 − 0.6·ft. Omega = 14·stiffness / (1 + 1.8·ft·(k+1)/n), so the tip lags and overshoots the most.
  - The spring uses a first-order hold (`springStepRamp`, exact when the target moves linearly).
  - The joint's local angles are rebuilt from the lagged angles and blended in by ft. Each joint's change is capped at 0.6 rad before `constrainPose`.
  - Ears flop on z against the head's motion. A body turn (`turnRate`) shifts the lagged tail angles.
- **anticipation 0..1**: in the charge phase, a counter-motion opposite to the coming strike, c = a·w·smooth01((pr−0.15)/0.6). Because w is the windup envelope (it includes env("windup")), the counter-motion stays inside it. By move type:
  - melee: spine and neck/head pull back, front hips load.
  - ranged: neck pulls back.
  - burst: legs move opposite to the strike.
  - self moves: the head dips.
  - every move: arms and elbows cock, wings raise, the tail cocks.
  - serpents: an extra rear-up.
- **jitter 0..1**: three idle micro-motions, scaled by an idleness factor that is smoothed and set to 0 when asleep or KO:
  - head micro-saccades: a new offset every 0.15–1 s / ((0.6+j)·tempo) of up to ±0.07 rad yaw and ±0.04 rad pitch, reached by a spring with omega 38·stiffness, scaled by env("headBob");
  - ear / tail-tip twitches shaped x·e^(1−x), scaled by env("tail");
  - a 9 Hz spine tremor of 0.005·j.
  - The noise is mulberry32 seeded from the creature (joint count, height, mass, elasticity). It never uses Math.random. Events fire at their exact time inside the frame, because the frame is split at each event.
- **sway 0..1**: a slow idle weight shift with a period of about 6–10 s: body roll 0.05·s, a spine lean on z, the hips shift on z, the head counter-rolls to stay level, the neck drifts in yaw. Scaled by env("gait", 0.3).
- **bounce 0..1**: the body is lifted by 0.07·H·sp·b·env("gait")·|cos gait|. That term is 0 at each footfall, where sin gait = ±1. The spine pitches at twice the stride frequency. Every footfall kicks the squash spring, with the kick scaled by the step period so a fast cadence cannot pin the squash at its clamp. Serpents are excluded.
- **stiffness 0.6..1.6**: multiplies these spring omegas: posture, hit flinch (22), jaw (20/9), squash (k·s², damping·s), follow-through and the micro-saccades.

## General improvements (input-driven, so the defaults stay identical)
1. **Directional hit**: `hit(strength, crit, fromYaw?)`. fromYaw is in creature space (+ = left, 0 = ahead). The body recoils away from the blow: it pitches back for a front blow and lurches forward for a rear blow; for a side blow it bends, turns the head and tips the body roll away. A side blow still flinches back a little (0.3). |pitch factor| and |lateral| ≤ 1, so the recoil stays inside the legacy recoil envelope. Without fromYaw, the pass-6 alternating flinch is unchanged.
2. **Turn reaction**: `AnimInput.turnRate?` in rad/s (+ = toward +lookYaw). The body banks into the turn (|roll| ≤ 0.15), the head leads (neck yaw ≤ 0.3) and the tail trails (≤ 0.25). When absent, nothing changes.

### Wiring lines for `src/render/battleView.ts` (fx lane / orchestrator). Both are NOT LIVE until added.
```ts
// import: add wrapAngle to the existing animator import
import { Animator, animStateFromLife, type AnimState, springAngle, springStep, wrapAngle } from "./animator.ts";
// react(), case "hit": replace `this.animators[e.b!].hit(k, !!e.crit);` with
const src = e.a !== undefined && e.a !== e.b ? b.fighters[e.a] : undefined;
const fromYaw = src ? wrapAngle(Math.atan2(src.body.pos.x - t.body.pos.x, src.body.pos.z - t.body.pos.z) - this.visYaw[e.b!]) : undefined;
this.animators[e.b!].hit(k, !!e.crit, fromYaw);
// syncCreatures(), inside the this.animators[i].update({ ... }) literal:
turnRate: dt > 0 ? this.visYawV[i] : 0,
```
`homeView.ts:617` (`a.anim.hit(0.35, false)`) can stay as it is.

## Identity proof
`p7 motion identity` covers 6 kinds (quadruped 3, biped 4, serpent 5, avian 6, hexapod 8, blob 9) × 3 variants (no helix / helix without p7 / P7_DEFAULTS) × 1500 frames = **27,000 frames**. Each frame runs a mixed dt schedule (1/60, 1/30, 1/144, 1/75, with 0 and 0.25 s spikes) and a script covering every branch: idle, walk, liquid, bite / ultimate beam / burst, flying, stagger, burrow, frozen, sleep / hunger / bloat, KO, plus hit, land and feed events and gaze glances from a seeded RNG. Every joint and every output scalar is `Object.is`-equal to the frozen pass-6 animator. The new code is gated by `gene > 0`, by `!== undefined`, or by multiplying by stiffness 1 (exact in IEEE).

## Measured (command: `NO_COLOR=1 deno test --no-check --allow-read --allow-write=artifacts tests/p7_motion_test.ts`, final Pareto calibration 79b3a9c)
- **followThrough**, tail with 4 joints, joy-0.4 wag, phase lag vs ft = 0:
  - ft 0.5: base 0.058 s, tip 0.125 s.
  - ft 1: base 0.092 s, tip 0.317 s.
  - Look step of 0.6 rad: time to 50 % goes 0.383 → 0.633 s; overshoot goes 0 → 3.1 %.
- **anticipation**, bite, minimum neck+head pitch during the wind-up: −0.032 / −0.207 / −0.382 rad (a = 0 / 0.5 / 1). Strike excursion: 0.609 / 0.767 / 0.927 rad.
- **jitter**, 20 s idle (j = 0 / 0.5 / 1): head std 0 / 0.024 / 0.059 rad; mean head speed 0 / 0.060 / 0.189 rad/s.
- **sway**, 20 s idle (s = 0 / 0.5 / 1): bodyRoll std 0 / 0.0070 / 0.0139 rad; spine z std 0 / 0.0056 / 0.0111 rad.
- **bounce**, H 0.46 m walking at 0.68 m/s (b = 0 / 0.5 / 1):
  - quadruped: lift range 0.039 / 0.046 / 0.052 m; squash range 0 / 0.0064 / 0.0129.
  - biped: lift range 0.0064 / 0.0125 / 0.0187 m.
  - The bounce component returns to about 0 at footfalls (0.000–0.003 against a peak of 0.014–0.027 m).
- **stiffness**, time for the knee to reach 90 % of a held wind-up: 1.067 / 0.633 / 0.400 s (s = 0.6 / 1 / 1.6), which is ∝ 1/s.
- **Directed hit** (strength 0.8, 7 frames later):
  - spine pitch: front −0.059, rear +0.102;
  - head yaw: left blow −0.020, right blow +0.046;
  - roll: left +0.032, right −0.018.
- **Turn** at +2 rad/s, compared with walking straight: roll −0.071 (vs 0.003), neck yaw 0.207 (vs 0.007), tail yaw −0.423 (vs 0.064).
- **Bounds**: 6 kinds × {all genes max, all genes min, defaults} × 4100 frames with 0.25 s spikes.
  - Excess over the coupled limits is 0.0 everywhere, and every chain budget holds.
  - Mean strain, max vs defaults: quadruped 0.20 vs 0.045; hexapod 2.03 vs 1.62; avian 1.22 vs 1.05.
  - max |roll| ≤ 0.411.
- **NaN**: 3600 frames (60 s at 60 fps plus 60 spikes of 0.25 s), all genes at max, a creature with 2 tail joints and 2 ears. Everything stays finite and inside the limits.
- **Frame rate**, worst joint |30 fps − 120 fps|:
  - no-strike plan: defaults 0.015 / 0.033 / 0.009; max 0.040 / 0.052 / 0.042; min 0.011 / 0.023 / 0.010 (quadruped / biped / serpent).
  - 1.5 s after a strike: ≤ 0.019 in every case.
  - The leftover error comes from the pass-6 posture springs, which hold their target for the whole frame (zero-order hold); anticipation enlarges that target motion. The assertion is max(0.045, 1.75 × the same creature's defaults), plus < 0.03 after settling.
- **Genes of 60 random genomes** with the final calibration (min / med / max): followThrough 0.21 / 0.46 / 0.62; anticipation 0.20 / 0.50 / 0.73; jitter 0.33 / 0.47 / 0.89; sway 0.24 / 0.45 / 0.66; bounce 0.32 / 0.41 / 0.60; stiffness 1.01 / 1.11 / 1.43. `Animator.motion` equals `motionOf(helix)` for every seed.

## Suite
- `deno check main.ts src/ tools/ tests/` → exit 0.
- `tests/p7_motion_test.ts` + `tests/animator_p5_test.ts` → 26/26.
- Full `NO_COLOR=1 deno test --no-check --allow-read --allow-write=artifacts tests/` → 547 passed, 3 failed. The baseline before my edits, taken while other lanes were also editing, had 513 passed and 4 failed.
- The 3 failures are geometry-lane tests: `ops: a carved torso…`, `p6 render: triangle budgets`, `triangle budget: body + face`. None of them imports the animator.

## Not done
- The battleView wiring for `fromYaw` and `turnRate` (lines above). Until it lands, both improvements are tested but not live. The genes themselves are already live, because battle, lab and home pass the helix.
- The pass-6 posture springs still hold their target for the whole frame (zero-order hold). Switching them to `springStepRamp` would remove the 0.015–0.075 rad frame-rate drift at the defaults, but it would break bit-identity, so that is the parent's call.
- No headless-Chrome capture or vision pass of the new motion (`deno task capture N`): the visual reading of these effects is not yet verified.
- There are no antenna joints in the skeleton, so follow-through covers tails, necks + head, and ears only. Wings get no follow-through.
- docs/SPEC.md and docs/EVIDENCE.md were not updated (orchestrator-owned); this file holds the numbers.
