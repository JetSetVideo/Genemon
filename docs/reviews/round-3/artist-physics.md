# Round 3 review: 3D artist + physics specialist

## Evidence used, and what is NOT JUDGED

**Images I viewed** (full-resolution crops, not the contact sheets):
- `battle-angle-auto.png`, whole frame.
- `creature-00-34-Embrglon-quadruped.png`: whole frame, plus a crop of x 330-730, y 300-650.
- `creature-00-side-Embrglon-quadruped.png`: crops of x 250-850, y 250-750 and x 440-700, y 330-480, plus a **pixel column scan** of x 470-640, y 330-480.
- `creature-07-34-Frosmane-quadruped.png`: crop of x 250-850, y 250-700.
- `creature-07-side-Frosmane-quadruped.png`: crop of x 250-850, y 300-650.
- `sheet-creatures.png`: contact sheet only, so low confidence.

**Data I parsed** with a script:
- All 55 shots in `manifest.json`: lab stability/strain; per fighter pos, phase, mode, stability and screen box against `viewPx`; `hudRects`; camera debug.
- The round-1 and round-2 manifests, for comparison.
- `REPORT.md`.

**Source I read** at the captured revision:
- **Lineage holds.** `dist/app.js` was built at 23:28:18 and the capture ran 23:28:20-23:29:43. Every `src` file I cite was last modified before the build.
- **Files:** `creature.ts`, `animator.ts`, `skeleton.ts` (and `git show f5cefca`), `battleView.ts`, `battleCamera.ts`, `display.ts`, `labView.ts`, `tools/capture.ts`, and `battle.ts` (formation, `knockOut`, `step`, weather).
- **Canvas offset** in the 1440×900 shots is (92, 52), measured from column and row edges. Manifest screen boxes are in canvas px (908×848).

**NOT JUDGED this round** (I stopped on request):
- Full-resolution images of 8 starters: Tidlash, Leafmemon, Ampix, Clodsttusk, Zephkite, Murkmire, Solar and Psiooze.
- `03-lab-skeleton.png`, `phase-*.png` and all 8 `arena-*.png`.
- Battle angles other than auto, `battle-result.png`, and the tablet and mobile shots.

Where a verdict below leans on the manifest or the code instead of an image, it says so.

## Verdict

**Score 34/100 (round 1: 30). NOT SHIP for the 3D-artist and physics roles.**

Real gains this round:
- The stability metric is honest now. 0 of 20 gallery snapshots read the constructor default `1`; in round 1, 16 of 20 did. Every lab body kind is positive.
- The lab capture uses `lv.frame()`.
- Side markers exist.
- Small fighters are drawn larger.

The creature art is unchanged where it matters:
- **Wings.** The wing membrane is the same code as in round 1 (`creature.ts:146`, `t = side·normalize(UP×dir)`). On Embrglon it still renders as a horizontal canopy that floats 4-10 px above the back.
- **Faces.** No mouth on either starter I zoomed. The eye vector still has `·(-1)` at `creature.ts:200`.
- **Phases.** Charge and rest are numerically the same pose: the COM shifts less than 0.003 H.

The new camera behaviour makes things worse in battle:
- The auto camera only checks the 2 action subjects, and it lifts its aim to clear a full-width HUD band. As a result, **7 living fighters are entirely off-canvas in 3 of the 9 desktop auto shots** (`camera.outside` reports 0 or 1).
- The tablet fighters shrank from 25-73 px in round 2 to 18-44 px. Camera distance went from 8.6 m to 30.0 m.

On the physics side there is one new failure: a fighter KO'd while airborne stays frozen in mid-air (`battle.ts:1155`).

## Checklist (my roles: C1-C8, A1-A4)

| item | score | evidence file | one-line reason |
|---|---|---|---|
| **C1** one connected body | **DISAGREE** | `creature-00-side-Embrglon-quadruped.png` (pixel scan) | Columns x=478-494 and x=574-614 run wing (13-21 px), then a **background-black gap of 4-10 px** (e.g. x=574: wing y 372-393, gap 394-403), then the back. The wing floats. Frosmane side view: no gap. |
| **C2** body kind from silhouette | **DISAGREE** (winged bodies) | `creature-00-side…` crop 440-700×330-480; `creature-00-34…` crop | Embrglon (quadruped) is read as an *"insect-like creature with a wing/elytron"*: a horizontal plate 60-80 % of the torso length. The 7 non-winged starters read at sheet scale only (`sheet-creatures.png`, low confidence). |
| **C3** element hue dominates | **DISAGREE** (partial) | `creature-07-34-Frosmane-quadruped.png` crop | Ice-tagged Frosmane is about 40-45 % red (stripes, horns, dorsal membrane) against 50-55 % teal. Red is the eye-catching colour. The palette code is untouched (`f5cefca` changed only `POWER_BUDGET` and `powerIndex` in `phenotype.ts`). Other 8: NOT JUDGED. |
| **C4** pattern visible | **AGREE** for 2 / **NOT JUDGED** for 8 | `creature-00-34…`, `creature-07-34…` | Embrglon's yellow zigzags and Frosmane's transverse stripes read at lab distance. |
| **C5** face reads as a face | **DISAGREE** | `creature-00-34…` crop, `creature-07-side…` crop | Embrglon: no mouth line, jaw or fangs. Its eyes are ambiguous: two passes gave "one small black eye" and "no unambiguous eye". Frosmane side view: no eye or mouth discernible. Code unchanged: `creature.ts:200` `up = (fwd×side)·(−1)` points down. |
| **C6** contacts ON the ground | **DISAGREE** | `creature-00-*`, `creature-07-*`; `manifest.json` → `battle-result.png`; `battle.ts:1155` | **Lab:** all visible feet of both quadrupeds touch, with contact shadows and no gap.<br>**Battle:** KO'd Zephkite sits at **pos.y 2.21 m with status `airborne`**, while every grounded fighter in that shot is at −0.39…−0.05 m. KO bodies are excluded from `stepPhysics`. It is off-screen, so there is no image. Serpent, avian and blob: NOT JUDGED. |
| **C7** overlay matches body | **NOT JUDGED** | (`03-lab-skeleton.png` not viewed); `labView.ts:154-172` | Code risk, unchanged since round 1. The overlay ignores the pivot lift and draws the toe tips in joint order. `balanceOf` instead uses 8-point sole discs (`skeleton.ts:559-569`), so the drawn polygon is not the polygon being tested. |
| **C8** charge / active / rest differ | **DISAGREE** (manifest + code; images NOT JUDGED) | `manifest.json` phase shots; `animator.ts:191-237`; `capture.ts:211` | Embrglon stability: idle 0.1916, charge 0.1897, rest 0.1918 (COM shift < 0.003 H). Active is −0.4031, the only distinct pose. Amplitudes are unchanged, and the capture still samples charge and rest at 200 ms of wall clock. |
| **A1** ground types distinguishable | **NOT JUDGED** | `arenaView.ts` (mtime 21:37:11, before the round-1 capture at 22:01) | The arena code has not changed since round 1, so the round-1 DISAGREE (no lava, mud = grass) should stand. |
| **A2** weather visible | **CAN'T TELL** (evidence invalid for 3/8) | `manifest.json` | At capture time the engine weather is **`storm`** in `arena-volcano-heatwave-15h`, `arena-swamp-fog-6h` and `arena-canyon-sandstorm-17h`. A move changed it (`battle.ts:816-819`, reverted by the timer at `:1097-1099`). Those files cannot show heatwave, fog or sandstorm. |
| **A3** time of day reads | **NOT JUDGED** | `arenaView.ts` unchanged | The round-1 cause (dusk tint × `day`, 06h `day` = 0.15) is not touched. |
| **A4** stands / props frame without hiding | **NOT JUDGED** | — | — |

## Changes since round 1

| # | change | result | evidence |
|---|---|---|---|
| 1 | Wing membranes as quads hinged per bone, trailing back; folded rest pose; right-side limits mirrored | **NOT DELIVERED** as a visual fix (the mirrored limits are delivered in code) | **Images.** `creature-00-34…`: a horizontal yellow canopy over the back. `creature-00-side…`: the same slab floats 4-10 px above the back (pixel scan). `creature-07-34…`: "flat horizontal-ish dorsal plates". `creature-07-side…` is the only acceptable read: the membrane lies along the upper flank.<br>**Code.** `creature.ts:146-150` is byte-for-byte the round-1 construction. `UP×dir` has y = 0, so each panel lies in the bone's horizontal plane, and the fold at `animator.ts:175-179` is mostly yaw, which keeps it horizontal. The mirroring is real (`skeleton.ts:133-138`).<br>**Open.** Frosmane alone carries **strain 0.476 at idle** in every shot (all other starters 0). Something in its rest pose is clamped. Not traced. |
| 2 | FK grounding; balanced rest posture; sole discs; stability > 0 at rest | **PARTIAL** | **Lab (delivered).** Every kind is positive: biped 0.0392 / 0.0382, avian 0.0389, quadrupeds 0.156-0.206, hexapod 0.192, serpent 0.1425, blobs 0.390-0.421. No default `1`.<br>**Battle (not robust).** A living Leafmemon at rest scores −0.014 (`arena-tundra-snow-9h`). A living Zephkite at idle scores −0.008 (`arena-volcano-heatwave-15h`).<br>**Why the margin is fragile.** Biped and avian values sit just under the sole-radius floor `0.04·H` (`skeleton.ts:564`), so the number mostly reports the assumed sole size. The soles are centred on the **toe tip** (`fk.end` of a forward ankle bone, `skeleton.ts:187,561`), not under the visible foot.<br>**The unit test is near-tautological.** `balancePosture` loops until margin > 0.02·H (`:408-410`), the test then asserts > 0, and the falsifier shove is a full body height.<br>**KO (failed).** A body KO'd in the air stays there (C6). |
| 3a | Side markers (ring + tag + HP pip, `#38bdf8` / `#fb923c`) | **DELIVERED** | `battle-angle-auto.png`: rings and name tags under and over every living fighter in the side colours (vision read). `battleView.ts:22,91-115`. A KO hides the tag and sets ring opacity to 0.2 (`:257,262`). |
| 3b | Small Genemon drawn larger (×2 below 0.9 m) | **DELIVERED in code, short of target** | `display.ts:11-13` uses `sqrt(0.9/h)`, so ×2 only at h ≤ 0.225 m. A 0.59 m Frosmane is drawn ×1.24. The smallest on-screen fighter in auto is **41 px** (`REPORT.md`), against the 48 px floor cited in `display.ts`. Round 1 was ~20 px. |
| 3c | Size-scaled start formation | **NOT VERIFIED** (code only) | `battle.ts:279-281` (`halfGap = clamp(2+3.5·meanH, 2.5, 0.3R)`). No t = 0 shot exists. |
| 3d | Camera keeps fighters below the HUD band | **PARTIAL, with a regression** | **Desktop.** The HUD cards cover canvas y 10-353 of 848 (42 %), and every fighter sits at y ≥ 467.<br>**Fighters cut or lost.** **Frosar (alive) extends 57 of its 80 px below the canvas** in `battle-angle-auto`. Living fighters fully off-canvas: volcano Lucidard and Lumtusk, swamp Tidlash, canyon Frosmane, Ampix, Zephkite and Tidlash (4 of the 5 on YOUR side). That is 7 fighters in 3 of 9 auto shots, and 7 of 9 shots cut at least one living fighter. `outside` reads 0 / 0 / 1 there.<br>**Tablet.** HUD covers 60 % of the canvas, the camera sits at 30.0 m, fighters are 18-44 px. In round 2 it was 8.6 m and 25-73 px.<br>**Cause.** Action-shot subjects are only the attacker and its target (`battleCamera.ts:101`). The aim is lifted by `safeTop·0.5·radius` (`:174`). The test uses each subject's centre point (`:194-197`). |
| 4 | HUD: YOU / RIVAL headers, side-coloured edges, 12 px text, size tooltip | **NOT JUDGED** (designer's items) | Only the "You" and "RIVAL" headers were seen (vision read of `battle-angle-auto.png`). |

## Blockers (max 5)

1. **Wings are still horizontal canopies that float off the back** on winged starters (`creature-00-side…` 4-10 px gap; `creature.ts:146` unchanged for 2 rounds).
2. **The auto camera loses living fighters.** 7 are fully off-canvas across 3 of 9 shots, Frosar is 71 % below the frame, and tablet fighters are 18 px. None of the creature work is visible on a fighter that is not on screen.
3. **KO'd fliers hang in mid-air** (`battle.ts:1155`; `battle-result` manifest: Zephkite y = 2.21, `airborne`).
4. **Faces do not read**: no mouth on any starter I zoomed, ambiguous eyes (`creature.ts:200`, `:113-126`).
5. **Charge = rest** (COM Δ < 0.003 H; `animator.ts:191-237`), so B3 cannot pass.

## Top 5 fixes, ranked

### 1. Every living fighter in frame, sized by its projected box
- **WHERE:** `battleCamera.ts` `update()`, lines 101, 170, 174 and 194-198. `BattleView.setHudTop` (`battleView.ts:128-130`).
- **WHAT:**
  - Keep the action pair as the zoom target, but run the readability test on **all** living fighters.
  - Test the projected **feet and head points** with `ds` applied, not the centre `at(f)`.
  - Model the HUD as its two **corner rectangles**, not a full-width band.
  - Shift framing with `camera.setViewOffset` instead of lifting the aim (`target.y += safeTop·0.5·radius` pushes the bottom row off the frame).
  - Clamp the distance per viewport so the tablet does not fall back to 30 m.
- **WHY:** this is the B1 and change-3 regression. A fighter off screen makes every C item moot.
- **VERIFY:** same seeds and instants. The manifest asserts that every living fighter's box is inside `viewPx` and outside the `hudRects`. Smallest fighter ≥ 48 px on desktop and ≥ 30 px on tablet. `REPORT.md` lists off-canvas fighters instead of dropping them.

### 2. Vertical, continuous folded membrane
- **WHERE:** `creature.ts` constructor wing case (lines 140-154), `animator.ts:174-179`, `skeleton.ts:230-235` `wingChain`.
- **WHAT:** the round-1 fix 1, still owed.
  - Trailing vector in creature space down and back: `normalize(0, −0.6, −1)`, not `UP×dir`.
  - Fold by rolling the root about Z by −side·1.2-1.4.
  - Build one BufferGeometry whose leading edge is the FK bone ends, rewritten in `applyPose`.
  - Chord ≈ 0.35 × span.
  - Root trailing vertex on the flank or hip.
- **WHY:** this is C1, C2 and change 1. It is the number-one silhouette defect, for the third round running.
- **VERIFY:**
  - **Unit test:** at rest, |n·ŷ| ≤ 0.3 for every membrane triangle.
  - **Images:** the gap scan on the Embrglon, Frosmane and Zephkite side shots finds 0 background px between membrane and body, and a top view (pitch π/2) shows a band less than 15 % of the torso width.

### 3. KO bodies fall and rest on the floor
- **WHERE:** `battle.ts` `step()` line 1155 and `knockOut()` lines 1069-1077.
- **WHAT:**
  - Keep stepping KO bodies with gravity only (intent 0), or drop them to `surfaceAt(x,z)` over about 0.4 s.
  - Clear `airborne` on KO.
- **WHY:** C6 and change 2 ("KO body stays on the floor") fail for any airborne KO.
- **VERIFY:**
  - **Battle test:** a flier KO'd at altitude reaches `surfaceAt ± 0.05 m` within 1.5 s.
  - **Manifest:** add `aboveGround = pos.y − heightAt` per fighter and assert ≤ 0.1 for every KO body in `battle-result`.

### 4. Readable faces
- **WHERE:** `creature.ts:191-216` (drop the `·(−1)` at line 200), `creature.ts:113-126` and `skeleton.ts:207` (jaw and fangs).
- **WHAT:** the round-1 fix 2.
  - Eyes on the upper half of the head surface, offset 0.5·er outward, irises aimed along normal + 0.6·fwd.
  - Jaw lowered to about −0.75 headR, with a dark mouth crease.
  - Fangs on the upper jaw, pointing down.
- **WHY:** C5 fails on every starter I zoomed. The code is unchanged since round 1.
- **VERIFY:**
  - **Gallery:** add a front shot (yaw 0). All 10 starters show 2 eye whites in the upper half of the head and a mouth line.
  - **Unit test:** eye centre y > 0 in head-local space.

### 5. Distinct phases and trustworthy phase / physics evidence
- **WHERE:** `animator.ts:191-237`, `capture.ts:204-216`, `battleView.ts:49,139` (the frozen flag).
- **WHAT:**
  - **Charge:** 2-3× the current amplitude, with weight back.
  - **Rest:** a head-below-shoulders recovery pose.
  - **Capture:** sample at progress 0.9 / 0.25 / 0.15 plus an idle reference.
  - **Frozen battles freeze the animator clock too.** At the "same frozen instant" Nullix's stability ranges from −0.001 to 0.267 across the 8 camera shots, so the pose differs from shot to shot.
- **WHY:** this is C8 and B3. Cross-angle comparison is also invalid while the pose drifts.
- **VERIFY:**
  - The COM shift between charge and rest is ≥ 0.03 H.
  - Silhouette masks of idle, charge, active and rest differ pairwise by ≥ 15 %.
  - Every fighter's stability is identical across the 8 battle-angle shots.

## Other findings (not yet blockers)

- **Frosmane strain.** Frosmane has strain **0.476 at idle** in all 16 snapshots where it appears; every other starter has 0 in the lab. Dump `constrainPose().perJoint` to find which joint is clamped.
- **Frosmane charge stability.** Frosmane in charge on swamp `muddyWater` scores **−0.384** (`arena-swamp-fog-6h`), against +0.19 for a charge in the lab. Unexplained.
- **KO serpents.** Stability is `−1` (zero contacts, `skeleton.ts:572`) for KO serpents and hexapods (lake Nihilcoil, result Ampix and Tidlash, beach Tidlash). With all-joint KO grounding (`animator.ts:275`), a KO serpent may rest on its head with its belly lifted. Not checked in an image.
- **Snapshot box width** is measured along world X only (`battleView.ts:287`), so widths collapse in side-on views (Ampix in the crystal arena: 5 × 62 px). Only `hPx` and the vertical extents are reliable.
- **Stale lab stability (unverified).** The lab panel on `creature-00-34…` reads "stability 0.16" by a whole-frame vision read, while the manifest gives 0.1916 for Embrglon. That looks like the round-1 stale-panel bug, but I did not confirm it with a crop.
- **Battle stability default.** `battleView.ts:80` still pushes a default stability of `1`. It does not leak this round because balance is computed on frame 0.

## Evidence gaps (shots needed next round)

1. **Shots I did not review:** full-resolution crops of the 8 starters not reviewed, `03-lab-skeleton.png`, `phase-*.png`, all `arena-*.png`, the other battle angles and the tablet and mobile shots.
2. **Winged views:** front (yaw 0), side (pitch 0) and top (pitch π/2) views of Embrglon, Frosmane and Zephkite.
3. **Weather:** arena shots captured while the requested weather is active. Assert manifest `weather` equals the requested weather, or pin the weather during capture.
4. **Start formation:** a t = 0 battle shot, to verify the compact formation (change 3c).
5. **KO evidence:**
   - A camera aimed at a KO'd flier and a KO'd serpent.
   - `aboveGround`, `displayScale` and a fully-in-frame flag per fighter in the manifest.
6. **Skeleton overlay:** at peak charge, plus a top-down overlay, to check the sole discs against the drawn polygon (C7).
7. **Phase strip:** sampled at fixed progress values with the animator frozen; same for the battle-angle set.

