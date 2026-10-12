# Design — creatures, arenas, motion, camera, interface

**Summary.** Readability first: every creature is built from its skeleton so silhouette = body plan;
element colour is the dominant hue everywhere (skin, aura, projectiles, HUD chips); every attack has a
visible tell (charge glow, wind-up), a strike and a recovery; the camera keeps every fighter inside a
safe frame and only adds drama (shake, lens punch, slow motion) on events that deserve it.

## Creatures (`src/render/creature.ts`, `textures.ts`)

- **Built from the skeleton.** One Object3D per joint, in the same order and offsets as
  `buildSkeleton()`, so a constrained pose maps 1:1 to the mesh. Torso and head segments are
  overlapping ellipsoids (they blend into one body); limbs are tapered capsules with socket spheres;
  wings are membranes on a 3-joint chain; horns, ears, spikes, fangs and a possible third eye come from
  plan genes and temperament.
- **Material = physics + chemistry.** Roughness from hardness/moisture, metalness from metal affinity,
  translucency from gas/void axes, emissive glow from fire/electric/light/psychic/void elements;
  skins are procedural canvases painted with the genome's pattern (stripes, spots, mottle, rings,
  scales, gradient, veins — veins also feed an emissive map).
- **Emotion on the face.** Pupils widen with fear and narrow with anger; the posture layer of the
  animator crouches when afraid, droops when sad, wags when joyful. Eyes and third eye sit on the upper
  half of the head surface, facing forward (the "up" vector is world up made orthogonal to the head
  axis; it used to point down, which buried the eyes in the lower half). No mouth/jaw is visible yet —
  open (round-3 artist review).
- **Battle display scale** (`display.ts`). Outside the Lab a Genemon shorter than 0.9 m is DRAWN larger
  (`min(2, max(1, sqrt(0.9 / heightM)))`: ×1.9 at 0.25 m, ×1.34 at 0.5 m, ×1 from 0.9 m up), while
  physics, reach and hit tests keep the true size — size order is preserved, so an XL still towers over
  an XS. Added because small bodies measured 18–41 px on screen; the 48 px floor is still unmet in wide
  shots (quest C2).

## Motion (`src/render/animator.ts`)

Layers, summed then passed through `constrainPose()` (dynamic coupled joint limits + chain budgets):
breathing (faster when aroused) → emotion posture → look-at target → gait (trot for quadrupeds,
alternating tripod for hexapods, biped walk with arm swing, serpent wave, blob paddle, wing flaps
while flying) → **attack phases**:

| Phase | Melee | Ranged (projectile, beam, zone) | Burst | Self (buff, heal, weather...) |
|---|---|---|---|---|
| Charge (tell) | crouch, head low, jaw opening, arms cocked | neck raised, jaw wide, element glow builds | crouch | head up, glow |
| Active (strike, `impulse()` fast rise / slow fall) | lunge: spine, neck and front legs snap forward | head thrust, jaw open | legs splay, roar | head thrown back |
| Rest (vulnerable) | head hangs, breathing heavy | same | same | same |

Amplitudes scale with energy, anger and sadness (a tired, sad Genemon attacks smaller). Hit
reactions flinch the spine away (crits twice as hard), stagger wobbles, KO collapses. Squash and
stretch follow impacts with a spring whose damping falls as elasticity rises. Balance (centre of mass
vs support polygon) is measured every 8 frames and exposed in snapshots.

## Arenas (`src/render/arenaView.ts`)

Vertex-coloured heightmap recoloured live when reactions transform the ground; water/lava sheet;
props per arena kind; a stadium ring and three tiers of stands; a gradient sky dome whose colours mix
the weather's sky with night and dusk according to the real (or chosen) hour; a sun that follows a
solar arc (moonlight at night); weather particles (rain streaks, snow, sand, ash, aurora sparkles,
leaves) pushed by the weather's wind.

## Effects (`src/render/fx.ts`)

Two GPU particle pools (additive glows, normal-blended smoke/dust), projectile cores with halos and
trails, beams with cores, shockwave rings, lightning bolts, and per-zone looks (smoke clouds,
wildfire embers, conduction sparks, mud and blight decals, bloom motes, blizzard). Element colour is
the hue of every effect; crits add rings, a screen flash in the element's core colour and slow motion.

## Camera (`src/render/battleCamera.ts`)

A broadcast director: frames every living fighter (+ projectiles, + large zones) with charge-weighted
centring; sits on the perpendicular of the fight axis with side hysteresis (no flip-flopping);
raises itself when terrain occludes; **readability equation** — if any fighter leaves the
|NDC| < 0.85 box the framing widens by 60%/s, otherwise it tightens by 15%/s; anticipation drifts
toward a big charge (power ≥ 70) and narrows the lens; trauma² shake, FOV punch and dutch roll on
crits, KOs and lightning; modes auto / orbit / top / side / low / follow (keys 1–6), saved per profile.

**Known failure (quest C2).** The framing test only checks the attacker and its target, by centre point,
so in 7 of 12 auto-camera shots of round 3 a living fighter was entirely off canvas while the camera
itself reported 0–1 outside; the HUD-band aim lift (`safeTop`, `setHudTop()`) pushed subjects further
out; the tablet shot pulls back to ~30 m against 16.9 m on desktop; the "same frozen instant" camera set
is not frozen for animation; and the low mode can be blocked by props while follow tracks no specific
body. The fix is to frame the projected boxes of ALL living fighters, bound the aim lift, cap the tablet
distance at the desktop distance, and make the capture's readability table count off-canvas fighters as
failures rather than skipping them.

## Interface (`web/styles.css`, `src/ui/*`)

- Layout: nav rail (screens generated from `screens/registry.ts`, each with a colour and a hint) ·
  3D viewport · side panel. Tablet narrows both rails; portrait tablets stack the 3D view (50 dvh) above
  the panel; phones stack viewport over panel with a bottom bar of 4 primary tabs + a **More** sheet for
  World, Market, Ladder, Feats, Data and Settings. The grid uses `minmax(0, 1fr)` so top-bar chips can
  never widen the layout past the device (they did: a 390 px phone laid out at ~500 px in round 1).
- Themes: dark and light via `[data-theme]` CSS variables, saved in the profile; the 3D lab/genospace
  backgrounds follow the theme (battle arenas do not — they follow weather and hour).
- Element chips: theme text on a 32 % tint of the element colour with a full-colour border; white text on
  the raw colour measured 1.1–1.4:1 contrast on Electric, Ice, Air and Light chips.
- Battle HUD: two labelled columns (**YOU** / **RIVAL**, side-coloured edge), per-fighter cards (element
  chip, name, HP/energy bars, phase with the move name, statuses, emotion), a live event feed with KO
  lines coloured by side, and a meta line (arena · weather at the start · hour · time). Cards are
  `pointer-events: none` so they never swallow camera drags. On phones each side collapses to ONE row of
  HP pills (measured: 2 wrapped rows covered 40–45 % of the 3D view; one row is the fix).
- **Who is whose in 3D:** a ground ring in the side colour (sky blue = you, orange = rival; it stays on
  the ground under fliers so depth reads), plus a name tag and an HP pip at constant screen size above
  the head. Added because nothing showed sides before round 3.
- Everything has a hint (`title`); colours never carry meaning alone (labels accompany chips).

Measured HUD coverage (round 3, before the one-row phone change): desktop 23–27 %, phone 35.5 %,
tablet 44.3 %, against a 15 % target; the camera-button column also overlaps the rival cards on phone
and tablet (quest A7).

## Open design questions

- **Camera framing (blocking, quest C2):** the camera must frame every living fighter, not the attacker
  and its target, and the readability table must be able to report a fighter it cannot see.
- **On-screen size:** the battle display scale plus a tighter wide shot is the current answer; the 48 px
  floor at 1440×900 and ~6 % of the frame height on phones are still unmet in 6-vs-6 shots.
- **Mobile HUD density with 6 fighters per side:** one row per side is in; the 15 % coverage target is
  not (35–44 % measured on phone/tablet before the row change).
- **Faces and phases:** no visible mouth, and charge reads like rest (numerically the same pose in round
  3) — both still open after three review rounds.
- Creature silhouettes per body kind still need a reviewer pass at gameplay distance; wings fold into
  flat shelves rather than a continuous membrane (round-1 and round-3 artist reviews).
- Ground-type readability: the arena floor changes colour per ground but the *type* is not named on
  screen, and 06h renders as night while the volcano shows no lava (round-3).
