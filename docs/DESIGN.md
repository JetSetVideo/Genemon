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
  animator crouches when afraid, droops when sad, wags when joyful.

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

## Interface (`web/styles.css`, `src/ui/*`)

- Layout: nav rail (screens generated from `screens/registry.ts`, each with a colour and a hint) ·
  3D viewport · side panel. Tablet narrows both rails; mobile stacks viewport over panel with a bottom
  tab bar.
- Themes: dark and light via `[data-theme]` CSS variables, saved in the profile; the 3D lab/genospace
  backgrounds follow the theme.
- Battle HUD: per-fighter cards (element chip, size class, phase badge with the move name, HP and
  energy bars, statuses and an emotion emoji), a live event feed, and a meta line (arena · weather ·
  hour · time).
- Everything has a hint (`title`); colours never carry meaning alone (labels accompany chips).

## Open design questions

- Creature silhouettes per body kind need a reviewer pass at gameplay distance (see `docs/reviews/`).
- Size-class readability: XS Genemon can be tiny next to XL ones; a minimum on-screen size or a ring
  marker may be needed.
- Mobile HUD density with 6 fighters per side.
