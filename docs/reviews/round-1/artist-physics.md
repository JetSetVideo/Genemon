# Round 1 review: 3D artist + physics specialist

Evidence used: full-size PNGs in `artifacts/qa/round-1/`, viewed as full-resolution crops of the creature regions (I did not trust the contact sheets for detail), `manifest.json`, `shasum -a 256` of the gallery, phase and battle shots, and a static reading of the **current** source (`creature.ts`, `skeleton.ts`, `animator.ts`, `labView.ts`, `battleView.ts`, `battleCamera.ts`, `arenaView.ts`, `phenotype.ts`, `tools/capture.ts`).
Caveat: repeated vision passes on the same crop sometimes disagreed (for example eyes "present" vs "absent"). Where they disagreed I resolved it from the code or with a tighter crop. Each such case is marked below.
Round-2 note: the orchestrator says these changes landed after this capture: membranes hinged per bone, mirrored right-side limits, folded-wing rest pose, FK grounding, and bounding-sphere lab framing. The code I read already contains all of them. The last column of the checklist says, for each finding, whether one of those changes plausibly addresses it.

## Verdict

**Score: 30/100. BLOCK for my role.**

The skeleton-first pipeline is sound: limbs sit where the bones are, the centre of mass and support polygon are computed from the same FK, and quadruped, hexapod, biped and blob bodies stand on the floor. The art layer on top of it fails in four places that are visible in almost every shot:

1. **Winged creatures carry flat accent-coloured shelves instead of wings.** This affects Embrglon, Frosmane and Zephkite. In Frosmane's case the folded wing reads as a "tail fin" even in the skeleton crop.
2. **Faces do not read.** Eyes are buried or sit in the lower half of the head, and no creature shows a mouth, even mid-strike.
3. **Charge and rest look the same.** Only the active phase is a distinct pose.
4. **In battle every creature is about 20 px tall.** None of the creature work is visible in the actual game.

On the physics side, the stability number in the manifests is not evidence yet:
- 20 of 31 lab snapshots report exactly `1`, which is a constructor default.
- Bipeds, avians and serpents can never score above 0, by construction.

The round-2 wing rebuild does **not** fix the horizontal shelf, by my analysis of the current code (see (a) below). The new lab framing is **not used** by the capture tool.

## Orchestrator's first pass: confirm or refute

| claim | result | evidence |
|---|---|---|
| (a) Winged quadrupeds and bipeds show wing membranes as large flat horizontal plates ("yellow slab" on Embrglon) | **CONFIRMED for round 1. REFUTED that the current code fixes it.** | **What the images show.** In `creature-00-34-Embrglon-quadruped.png` (crop 380-720 x 440-680) there are two uniform, unlit yellow parallelograms side by side along a red rod, lying in a near-horizontal plane seen from above. In `creature-00-side-…` the same plate juts sideways toward the camera, roughly 230x140 px, and hides the front leg. In `creature-07-34-Frosmane…` and `03-lab-skeleton.png` the folded red membrane reads as a notched "tail fin" with a bone along its edge. In `creature-05-side-Zephkite-avian.png` the near membrane drapes over the legs in screen space, so the bird looks like it hovers.<br>**Why the current code still does this.** In `creature.ts:146-150` the quad spans `dir` and `t = side·normalize(UP × dir)`. `UP × dir` has a **zero y-component for every dir**, so in its own joint frame each panel is horizontal to within the bone's own pitch (7°, 1° and 3° for root, mid and tip). The folded rest pose (`animator.ts:176-178`) is mostly **yaw**: 0.6, 1.1 and 0.5 rad. Yaw keeps a horizontal plane horizontal. The only roll is +0.3 rad on the root and −0.15 rad on the mid.<br>**Hand FK of the left wing at rest.** The membrane normals are about 24° (root) and 15° (mid) from vertical, so the panels are still horizontal shelves. They are now folded back over the hindquarters. The mid panel's trailing edge points **inward**, `t ≈ (−0.90, −0.25, +0.34)`, so the left and right panels meet over the spine at about 0.19-0.28 H above the spine axis. That is right at the torso's top surface (≈ 0.19 H), so the panels form a "saddle/table top" on the back. Chord sizes are relative to body height H (0.5 H at the root), not to the span, so the panels are as big as the creature's flank. |
| (b) In battle the creatures are tiny (1-3 % of viewport height) | **CONFIRMED.** By projection it is about 1.5-4 %. | **Projection.** The `battle-angle-auto` manifest gives camera distance 29.7 m with fov 48°, so 1 m ≈ 34 px at 900 px. Frosmane (0.59 m) is about 20 px, 2.2 %. The vision estimates are 2-6 % for most fighters; the ~10 % figure includes auras.<br>**Cause.** `battleCamera.ts:96-164` fits the radius of all subjects (6.66 m in this shot) at 48°. The arena scale is about 30-60× the creature scale.<br>**Round-2 changes:** they concern the lab camera only. **Not addressed.** |
| (c) The lab side view of Tidlash is byte-identical to its 3/4 view | **CONFIRMED.** | Both files hash to SHA-256 `15b54b8610e86a7a…`. Every other pair of shots differs. So there is **no side view of the serpent**, which is exactly the view that would show the tail hovering (see O5). |
| (c) Lab snapshots report stability = 1 as a measurement artifact | **CONFIRMED, with mechanism and scope.** | **Scope.** 20 of 31 lab-view snapshots are exactly `1`, the constructor default (`animator.ts:66`, and `battleView.ts:60` for battles). A new Animator is built on every `setGenemon()`, and balance is only computed when `frame % 8 === 0`. The capture snapshots 120 ms after a rebuild with `stage.paused = true`. Why the snapshot sometimes sees the default cannot be proven from source alone.<br>**The UI number is stale too.** `lab.ts:55` renders `stability` once, at selection time, and shows the **previous** creature's value. The Clodsttusk-34 panel shows "0.15", which is Ampix's value (0.152). The Murkmire-34 panel shows "1.00" while its snapshot says 0.32.<br>**Bigger, missed:** see "Blockers" (structurally negative biped stability). |

## Checklist

| item | score | file judged | what I see | round-2 change that plausibly addresses it |
|---|---|---|---|---|
| **C1** One connected body, nothing floats | **DISAGREE** | `creature-05-34-Zephkite-avian.png`, `creature-00-34-Embrglon…` | Nothing is detached, but winged bodies join by interpenetration, not connection. The wing panels are separate quads per bone with a visible notch or gap between them ("two separate panels with a gap" on Zephkite). The wing root sits inside the torso (`skeleton.ts:256`: (0.5 r, 0.65 r) is inside the chest ellipsoid), so the inner panel cuts through the body. Torsos and serpents read as chains of separate bulges ("caterpillar"). Non-winged creatures are fine. | Per-bone hinged quads: **no.** Panels still do not share edges once the fold yaws them about 1.1 rad apart (corner separation ≈ 0.4 × chord). |
| **C2** Body kind recognisable from silhouette | **DISAGREE** (2-3 of 10 fail) | `creature-05-34-Zephkite-avian.png`, `creature-07-34-Frosmane…`, `creature-00-side-…` | Biped, hexapod, serpent and blob read. Zephkite in close crop reads "insect/alien": big sphere head, no clear neck or beak, legs hidden in the side view. The winged quadrupeds' silhouettes are dominated by the shelf, which hides one or two legs. | Folded-wing pose: **no** (still horizontal, see (a)). |
| **C3** Primary element hue dominates the skin | **DISAGREE** | `creature-07-34-Frosmane-quadruped.png`, `creature-05-side-Zephkite-avian.png` | Frosmane is tagged **Ice** but is about 55-65 % red by area: red bands, red horns, red folded membranes. Zephkite (**Air**) has a teal body with crimson membranes that dominate the side view. Likely cause: `phenotype.ts:165` uses the **complementary** hue (h0 + 0.5) as accent when there is no secondary element, and that accent paints membranes, horns and spikes (`creature.ts:53-62,152`), probably the pattern too. The other 8 starters match their element (Embrglon red/yellow, Tidlash cyan, Leafmemon green, Psiooze pink, Murkmire dark violet…). | **No.** |
| **C4** Pattern visible at lab distance | **DISAGREE** (6 of 10) | `creature-02-34-Leafmemon-biped.png`, `creature-06-34-Murkmire-blob.png`, `creature-09-34-Psiooze-blob.png` | Readable: Embrglon veins, Frosmane stripes, Clodsttusk bands, Ampix mottle, Tidlash squiggles, Zephkite white marks. Plain at this distance: Leafmemon, Murkmire, Psiooze, Solar (faint). The capture frames creatures at only 13-27 % of frame height: `d = hgt·3.6 + 1.2`. | Bounding-sphere framing **would help, but `tools/capture.ts:163-167` overrides the camera and never calls `LabView.frame()`**, so round 2 will not exercise it. |
| **C5** Face reads as a face | **DISAGREE** | `creature-00-34-Embrglon…` (crop: 0 eyes), `creature-03-34-Ampix…`, `creature-06/09-34-*-blob`, `creature-02-34-Leafmemon…` | **Eyes.** Missing on Embrglon, Zephkite, Ampix, Murkmire and Psiooze. Where visible (Leafmemon, Solar) they sit in the **lower half** of the head. Cause in `creature.ts:200`: `up = (fwd × side)·(−1)` points down, so eyes land at −0.38 r. The eye centre sits at about 73 % of the surface radius, so `er = 0.2-0.38 r` protrudes between −0.07 r and +0.11 r. Iris and pupil are pushed along the head's long axis, not out of the face.<br>**Mouth.** No mouth on any starter, including `phase-active.png`. The jaw ellipsoid (`skeleton.ts:207`, `creature.ts:113-126`) lies inside the head at rest, and the fangs are +Y cones pointing into the head. | **No.** |
| **C6** Contact points ON the ground | **DISAGREE** (partial) | `creature-05-side-Zephkite-avian.png`, `creature-05-34-…`, blobs | Quadruped, biped and hexapod feet sit on the disc. Zephkite reads as **hovering** in both views: the lowest visible parts are a membrane edge and a pointed limb, and lit floor shows between them and the shadow. The code seats the lowest contact at y = 0, so this is a read failure: the wing hides the legs, there is no contact shadow, and the light throws the shadow behind the body. Blob bodies hover on their pods by about 0.13 R (design). Serpent: CAN'T TELL, the side shot is missing; the code predicts the tail hovers (O5). | FK grounding: **yes** for crouch, charge and KO feet. **No** for the serpent taper, the avian read, or the foot ellipsoid offset (O8). |
| **C7** Skeleton overlay matches the body | **AGREE** (idle, one creature only) | `03-lab-skeleton.png` | Bones run inside the legs and torso, the centre of mass is inside the torso, and the yellow polygon is at ground level under the feet. Horn and ear bones look bare because the cones are sub-pixel thin and the ears are flat. Risks in code: `drawSkeleton` (`labView.ts:156-158`) ignores the pivot's lift, squash and pitch, and draws contacts in **joint order** (hR, fR, hL, fL), not the hull: a bow-tie in top view for quadrupeds and hexapods. Not visible at this angle; needs a top-down overlay shot. | FK grounding **worsens** overlay drift, because the mesh is lowered by `lift` and the overlay is not. Verify with an overlay during charge. |
| **C8** Charge, active and rest are different poses | **DISAGREE** | `sheet-phases.png`, `phase-charge.png`, `phase-rest.png`, `phase-active.png` | Only active differs: crouch, head down, hips and tail up. Charge and rest are indistinguishable at sheet scale. Full-size crops show only a slight head drop in charge. Causes: small amplitudes (`animator.ts:191-205`: knees 0.35 w, spine −0.22 w / (n/2); rest only nods the neck 0.18 rad), and the capture samples charge 200 ms into the phase (w ≈ 0.3). | **No.** |
| **A1** Ground types distinguishable | **DISAGREE** | `arena-volcano-heatwave-15h.png`, `arena-swamp-fog-6h.png`, `arena-lake-storm-21h.png` | Snow/ice (tundra) and sand (canyon, beach) read. **No visible lava** in the volcano: it is orange rock with a pale ring. Mud and grass are indistinguishable in the swamp. Lake water is dark with no reflection (readable only from the label). City metal and crystal ground don't read. | **No.** |
| **A2** Weather visible | **DISAGREE** (partial) | `arena-lake-storm-21h.png`, `arena-swamp-fog-6h.png` | Rain streaks (lake, city) and snow read. The storm frame has no lightning. Fog reads as darkness because the fog colour is the near-black sky bottom. Heatwave is only a tint. Eclipse is plain dark. Wind is ambiguous. | **No.** |
| **A3** Time of day reads | **DISAGREE** (partial) | `arena-swamp-fog-6h.png`, `arena-beach-wind-19h.png` | Nights read. **06h reads as night**, and 19h dusk is ambiguous. Cause in `arenaView.ts:19-26,215-218`: `day = 0.15` at 06h and `0` at 19h, and the dusk tint is multiplied by `day`, so it vanishes exactly at the golden hour. The HUD clock also shows "14:30 · afternoon" over 21h and 06h arenas. | **No.** |
| **A4** Stands, props and rim frame without hiding | **DISAGREE** | `battle-angle-auto.png`, `arena-swamp-fog-6h.png` | No stands are in frame in auto, in any arena. They are plain open grey cylinders at r ≥ half + 4 m (`arenaView.ts:85-92`). The rim torus is barely visible (opacity 0.35). What frames the fight is the HUD. The pond rim, a tree trunk and white zone discs partly hide fighters. | **No.** |

## Blockers (for my role)

1. **Wing shelves on every winged creature** (3 of 10 starters). They dominate the silhouette and hide legs, and they still come out horizontal in the current code (claim (a)).
2. **Faces don't read.** On at least 7 of 10 starters there are no visible eyes, or the eyes are in the lower half. Zero mouths.
3. **Creatures are about 20 px tall in battle.** Silhouette, pattern, face and pose all disappear in the game's main view.
4. **Attack phases are not legible.** Charge is about the same as rest.
5. **The stability metric is not evidence** (physics). The default `1` leaks into 20 of 31 lab snapshots. Bipeds and avians are **always ≤ 0**, because each foot contributes one point (the ankle bone end) and 2 points make a degenerate hull, so `margin = −segDist` (`skeleton.ts:525-536`). The battle snapshot shows it: Leafmemon −0.009, Frosar −0.018, Zephkite −0.091, Tidlash −0.038, while every quadruped, hexapod and blob is positive.

## Top 5 fixes, ranked

### 1. Rebuild the folded wing as a vertical, continuous membrane

- **Where:** `creature.ts:140-154`, `animator.ts:174-179`, `skeleton.ts:230-235`.
- **What:**
  - Build `t` in creature space as down-back, `normalize(0, −0.6, −1)`, not `UP × dir`.
  - Fold by rolling the wingRoot about Z by `−side·1.2…1.4` so the bone lies along the flank and the membrane hangs like a bat's folded wing or a cape. Spread it to horizontal only in flight.
  - Make it **one** BufferGeometry whose leading-edge vertices are the FK bone ends and whose trailing edge is interpolated, updated in `applyPose`, so there are no gaps.
  - Size the chord from the span (about 0.35 × span), not from H.
  - Anchor the root trailing vertex on the flank or hip, not inside the chest.
  - Use a textured, semi-translucent membrane material instead of the flat emissive accent.
- **Why:** this is the number-one silhouette defect, and the round-2 change keeps it horizontal by construction.
- **Verify:** Embrglon, Frosmane and Zephkite in lab side (pitch 0) and top (pitch π/2) shots. In side view the membrane is a broad sheet along the flank and the legs are visible. In top view it is a thin band, not a shelf. Unit test: in the rest pose every membrane triangle's normal has |n·y| ≤ 0.3.

### 2. Make faces readable

- **Where:** `creature.ts:191-216` (eyes), `creature.ts:113-126` and `skeleton.ts:207` (jaw and fangs).
- **What:**
  - Drop the `·(−1)`, so that `up = fwd × side` points up.
  - Place each eye on the ellipsoid surface along (±0.55, +0.38, k) and offset it 0.5·er outward along the surface normal.
  - Aim the iris and pupil along `normalize(normal + 0.6·fwd)`.
  - Lower the jaw to about −0.75 headR so it extends past the snout, and add a dark mouth crease.
  - Put the fangs on the upper jaw, pointing down.
- **Why:** C5 fails on almost every starter.
- **Verify:** add a front shot (yaw 0) to the gallery. In 10 of 10 starters, two eye whites are visible on the upper half of the head, pupils face the camera in the front view, and a mouth line is visible. Unit test: in head-local space the eye centre y > 0 and eye protrusion ≥ 0.4·er.

### 3. Make fighters big enough to read in battle

- **Where:** `battleCamera.ts:96-164`.
- **What:**
  - In auto mode, frame the action pair. Clamp the distance so the focus attacker's height is at least 12 % of the viewport: `d ≤ H / (0.12 · 2·tan(fov/2))`.
  - Leave wide shots for overview moments only.
  - Consider a battle-only creature scale of 2-3× relative to the arena.
- **Why:** at about 20 px nothing in C1-C8 is visible in the real game.
- **Verify:** same seed and the same frozen instant. Add a projected bbox per fighter to `BattleView.snapshot()`. Assert the focus pair is ≥ 10 % of viewport height and every living fighter is ≥ 4 %.

### 4. Give the three attack phases distinct poses

- **Where:** `animator.ts:191-237` and `tools/capture.ts:176-188`.
- **What:**
  - **Charge:** a real anticipation pose with about 2-3× the current amplitude. Weight shifts back (rear knees about 0.8 rad), head and neck pull back, jaw opens for ranged moves, tail coils, wings half-open.
  - **Rest:** a recovery read. Head below the shoulders, fast panting breathing (br × 3), wings and tail drooping, a small sag in the knees.
  - **Capture:** set `demoT` so charge is sampled at progress 0.9, active at 0.25 and rest at 0.15, plus an idle reference shot.
- **Why:** C8, and B3 downstream.
- **Verify:** the creature silhouette masks for idle, charge, active and rest differ pairwise by ≥ 15 % of the creature area. Log strain per phase.

### 5. Make the evidence trustworthy (cheap; do it before the round-2 recapture)

- **Where:** `tools/capture.ts:152-171`, `animator.ts:66,283`, `skeleton.ts:521-549`, `labView.ts:154-172`, `lab.ts:55`.
- **What:**
  - **Capture tool:**
    - Call `lv.frame(yaw, pitch)` instead of the hand-rolled `d = hgt·3.6 + 1.2`, so the round-2 framing change is actually exercised.
    - Wait for at least 2 rendered frames after each rebuild, then assert the camera position and that each angle's image hash is unique.
  - **Stability value:**
    - Initialise `stability` to `NaN` (meaning "not measured").
    - Compute balance in the Animator constructor and on every `setGenemon`.
    - Refresh the lab panel number every frame.
  - **Feet:** each foot contributes a footprint (heel, toe and two sides from the ankle ellipsoid) instead of one point, so a standing biped can be stable.
  - **Overlay:** `drawSkeleton` applies the pivot transform and draws the `hull2` polygon.
- **Why:** without this, round 2 cannot verify the lab-framing change, and the stability values cannot be used as evidence.
- **Verify:**
  - Gallery hashes are all unique and a serpent side view exists.
  - No snapshot shows exactly `1` without a computation.
  - A standing Leafmemon and Solar have stability > 0.
  - The overlay stays within 1 px of the mesh at peak charge.

## Other observations (missed by the first pass)

- **O1, palette.** When an element has no secondary, its accent is the complement of its own hue: `phenotype.ts:165`, `acc = h0 + 0.5`. On large surfaces this flips the element read (Ice becomes red, Air gets crimson wings). Use an analogous hue (h0 ± 0.08) or a value shift for large areas, reserve the complement for small details, and cap pattern-colour coverage at about 35 % of texels.
- **O2, sausage torsos.** Each spine joint is its own ellipsoid (`creature.ts:96-100`), so quadrupeds, bipeds and serpents read as chains of beads. Use a lofted tube along the FK spine with a radius profile, or an SDF/metaball union.
- **O3, pillar legs.** Quadruped legs at rest are straight vertical columns (`skeleton.ts:185-187`, dirs `[0,−1,0]`), giving a "table legs" look on Clodsttusk. Author a digitigrade zig-zag: hind upper `[0,−1,0.35]`, lower `[0,−1,−0.45]`.
- **O4, wing material.** The membrane uses `accent` + `glow` emissive, DoubleSide, with no texture, so on glowing creatures it renders as a flat unlit fill (Embrglon's "uniform yellow").
- **O5, serpent tail hover (code).** All segments share a straight centre line at y = r_root (`skeleton.ts:305-314`), but their radii taper. Seating uses only the lowest contact, so the belly rises toward the tail to about 0.5 r_root above the floor. Unverified, because the side shot is a duplicate. Seat each segment, for example by pitching the segments or lowering the centre line per segment.
- **O6, overlay drift.** The overlay ignores `pivot.position.y = out.lift`. With the new FK grounding, any knee bend moves the mesh away from the bones, centre of mass and polygon.
- **O7, overlay polygon.** The support polygon includes every contact joint, even feet the balance check ignores (lifted beyond its tolerance), and is drawn in joint order. The drawn polygon is therefore not the one `balanceOf` uses.
- **O8, foot float.** The foot ellipsoid's half-height is 0.7·r0 (`creature.ts:159`), but seating uses r0, so the toe's underside floats by 0.3·r0. Sub-pixel today; it will show once framing is fixed.
- **O9, wings vs. grounding.** Only contact joints drive grounding (except during KO). Folded membranes and the head can therefore pass through the floor in strikes. The `phase-active.png` crop shows near-grazing but no clipping this time; add a floor-clearance check for membranes and the head.
- **O10, missing lava.** The volcano shot has no visible lava. Either the arena has no liquid ground or `waterLevel` is below the terrain (`arenaView.ts:64-79`). CAN'T TELL from source; log `waterLevel` against `heightAt` in the snapshot.
- **O11, dawn and dusk.** Sunrise and sunset are hard-coded at 06h and 18h (`sunForHour`), and the dusk tint is multiplied by `day`. Decouple the dusk tint from `day`, give sunrise/sunset `day` ≈ 0.45, and drive the hours from season or latitude.
- **O12, sea-level stands.** Stands are untextured open cylinders with no tiers. The fight has no physical frame, only the HUD.
- **O13, double rebuild.** `go("lab")` calls `render()` and then `ensureView()`, which calls `setGenemon` again. Navigation rebuilds the creature, its textures and the Animator, and every rebuild resets stability to `1`. The first frame after a rebuild costs 138-255 ms (`frameMs`), which is the likely reason the Tidlash side shot captured a stale frame.

## Round 2: shots needed to verify

- Lab front, 3/4, side (pitch 0) and top views of Embrglon, Frosmane, Zephkite and Tidlash, using `lv.frame()`.
- Skeleton overlay on a quadruped and a biped at idle and at peak charge.
- Phases sampled at fixed progress values (fix 4).
- `battle-angle-auto` with projected fighter bboxes in the manifest.
- Gallery hash-uniqueness check.
