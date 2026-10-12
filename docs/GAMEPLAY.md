# Gameplay rules (the numbers the code uses)

**Summary.** A Genemon's power is a fixed budget set by its size class, level, growth and genetic
quality; its 26 axes decide how that budget is spent (tank, striker, sniper, swarm piece). Battles are
real-time and simultaneous on a physical arena: every move charges, strikes and rests; damage
multiplies about fifteen explicit factors (type, weather, ground, conduction, size, emotion, synergy,
day/night...), and elements react in space. Every formula below is quoted from the code it lives in.

## 1. From genome to fighter — `src/genome/phenotype.ts`

| Quantity | Formula |
|---|---|
| Adult height | `0.25 m × 16^stature01` (0.25 m .. 4 m) |
| Current height | `adult × (0.35 + 0.65 × growth)` |
| Density | `1000 × 2^(1.6·weight) × (1 − 0.75·max(0,phase)) × (1 − 0.6·max(0,−substance)) × (1 + 0.35·max(0,hardness))`, clamped 60..4000 kg/m³ |
| Mass | `density × shapeK(kind) × height³` (shapeK: blob 0.22, quadruped 0.16, hexapod 0.10, biped 0.09, serpent/avian 0.07) |
| Size class | mass < 6 kg XS · < 45 S · < 260 M · < 1100 L · else XL |
| Team slots | XS 1 · S 1 · M 2 · L 3 · XL 4 (team capacity 6) |
| Power budget | XS 0.85 · S 1 · M 1.9 · L 2.75 · XL 3.5 (big ones are slightly less efficient per slot) |
| Target power **[SPEC B1]** | `100 × budget × (1 + 0.12(2q − 1)) × (1 + (level − 1)/30) × (0.55 + 0.45·growth)` |
| Power index | `sqrt(hp × (1 + def/120) × atk × rate)`; hp and atk are scaled so the index equals the target |
| Elements | affinity = signature · axes (normalised); primary = best affinity ≥ 0.2 (else neutral); secondary if ≥ 0.32 |

Abilities: **fly** (avian, or wings > 0.62 & altitude > 0.35 & density < 900), **swim** (moisture >
0.25), **dig** (altitude < −0.3, not avian/blob), **phaseShift** (form > 0.45, |phase| < 0.6),
**weatherShaper** (wisdom > 0.2 and a strong air/water/ice/light/shadow affinity), **terraformer**
(might > 0 and a strong earth/plant/ice/fire affinity).

## 2. Life changes the creature — `src/genome/epigenetics.ts`

- Pressure per axis = Σ ground hours × habitat nudge + Σ food units × food nudge + Σ experiences ×
  nudge + battle terms (damage taken by element × 4e-5 × element signature; elements used × 1.5e-3;
  conviction +0.004 per net win; temper +0.001 per battle) + time terms (wisdom +min(0.6, 0.004·age);
  tempo declines after 120 days; rhythm follows the mean active hour; mood follows bond and hunger).
- **Shift = 0.5 × tanh(pressure / 0.5)**: a life can bend each axis by at most ±0.5. Genes stay the anchor.
- Growth `= 1 − exp(−(age/18 + xp/2500 + nutrition/120) × (1 − 0.4·hunger))`; level `= floor(1 + cbrt(xp/8))`.
- Stages: Hatchling (growth < 0.35) → Juvenile (growth < 0.7 or level < 16) → Adult → **Ascended**
  (level ≥ 40, bond ≥ 0.6, ≥ 25 wins). Crossing an element threshold re-specialises the moveset.
- Some experiences are **physical-only** (gym, climbing, km travelled, night walk, sunbathing, rescue):
  `live(..., { physical: false })` refuses them and logs `genemon.experience.denied`.

## 3. Breeding & transformation — `src/genome/breeding.ts`

| Operator | Rule |
|---|---|
| Breed | Mendelian: one allele from each parent per gene; mutation rate `0.03 × (1 + 1.5 × mean chaos)`, step N(0, 0.25) |
| Fuse | Per axis the stronger pole wins (both alleles); stature +0.3; generation + 1 |
| Morph | Linear blend of every allele at t; discrete genes (kind, pattern) switch at t = 0.5 |
| Mutate | Random axes (25% each, or a focus list) moved by N(0, strength) |

## 4. Teams — `src/combat/team.ts`

Six slots, ordered: index 0 leads and acts first (initial cooldown 0.5 s + 0.35 s per position).
Synergies (computed, then applied as stat or damage multipliers):

| Synergy | Condition | Effect |
|---|---|---|
| Conductor | water + electric | electric damage ×1.15 |
| Bellows | fire + air | fire damage ×1.12 |
| Garden | plant + water | plant members regenerate 1% HP/s |
| Bulwark | earth + metal | defence ×1.1 |
| Clarity | light + psychic | accuracy ×1.05 |
| Abyss | shadow + void | evasion ×1.25 |
| Glacier | ice + water | ice status chances ×1.5 |
| Rot | poison + plant | poison damage ×1.1 |
| Forgeheart | fire + earth | fire damage ×1.08 |
| Pack | ≥ 3 social members | attack ×1.06 |
| Formation | mean order > 0.2 | consecutive hits on one target +10% |
| Vanguard & Artillery | a brawler and a sniper | all damage ×1.05 |
| Guardian | a 3+ slot giant with a 1-slot ally | evasion ×1.15 |
| Prism | ≥ 4 primary elements | all damage ×1.03 |
| Resonance | ≥ 2 members, one shared primary | that element ×1.1 |

## 5. Moves and their cost — `src/combat/moves.ts`

Every move has **three phases**: charge (readable tell; slow movement) → active (the strike resolves
at its start) → rest (recovery; the user's evasion is halved). Durations: `charge / (rate × haste
1.33 × slowed 0.87 × paralysed 0.7)`, `active`, `rest / (rate × haste)`.

Shapes: melee, projectile (travels, leads its target, can clash mid-air), beam (first body on the
line; triggers reactions with zones it crosses), burst (area around the user), zone (persistent
field), buff, heal, weather, terrain, dig, fly, phase.

**Energy cost** = `max(4, round((damage × 0.3 × tempo + effects) × rarity × meta))` with
`damage = power × (1 + 0.28·area) × (range > 4 ? 1 + 0.025(range − 4) : 1) × (0.6 + 0.5·accuracy)`,
`tempo = 1 + clamp(0.9 − charge, −0.6, 0.6) × 0.45`, effects = statuses `9 × chance × duration/3`
(self ×1.2), knockback/pull `1.4 × value`, ground change 9, weather 16, heal `40 × fraction`,
dig/fly/phase +6; rarity: neutral 0.9, light/void 1.08, shadow/psychic 1.06; **meta** =
`clamp(1 + 0.3 × (share × N − 1)/4, 0.8, 1.25)` from ladder usage share (model ready, live feed open).
Energy starts at 60%, regenerates `7 + 7·vitality01` per second (×1.5 while resting); flying drains 1.5/s.

## 6. A hit — `Battle.hit()` in `src/combat/battle.ts`

Hit chance = `move.accuracy × accuracy × visibility^(ranged ? 1 : 0.3)` × blinded 0.65 × focused 1.05
× zone accuracy (smoke 0.65, dust 0.8, mist 0.85) − target evasion (evasive ×2 + 0.1; resting ×0.5;
frozen/staggered 0), clamped 0.05..0.99.

Damage = power × atk/40 × 100/(100 + def·shielded 1.6·softened 0.75) × **type** (chart, 0.25..4) ×
STAB 1.2 × **weather** element multiplier × **ground affinity** of the attacker's tile × **conduction**
(electric only: ground conductivity, ×1.3 wet, ×1.08 in rain; flying 0.6, burrowed 0.5) × **size**
(contact moves: `clamp(massRatio^0.1, 0.75, 1.4)`, `^0.22` for mass-scaled slams) × melee proximity
1.08 × **emotion** (1 + 0.15·anger − 0.15 if feared) × team synergies × **day/night rhythm**
(±6% × rhythm axis; light ×1.1 by day / 0.9 by night, shadow the reverse) × liquid body (contact 0.5,
electric 1.25) × frozen 1.15 × fire-on-wet 0.8 × reaction multiplier × area falloff × spread
U(0.88, 1.12) × **crit 1.6**.

Crit chance = `crit × highCrit 2 × focused 1.6 × (1 + 0.3·joy)`, ≤ 50%. A crit also multiplies status
chances ×1.5 and knockback ×1.8, and on screen: slow motion, rings, a screen flash, a lens punch.

After a hit: anger rises with damage taken, fear rises below 30% HP (less for brave Genemon),
the attacker learns the real type multiplier (`memory["fire>plant"]`, faster when wise), statuses roll,
knockback/pull impulses go to the physics, and **electric current chains** to every other body
within 4.5 m that is wet or standing in water — allies included.

## 7. Elements in space — reactions (`REACTIONS` in `src/data/elements.ts`)

Fire+water → **smoke** cloud (−35% accuracy inside) · fire+plant → wildfire · fire+ice → melt (ice
ground → water) · fire+air → firestorm · fire+earth → magma · fire+metal → forge (−20% def) ·
electric+water → **conduction** · water+earth → mud (slow) · ice+water → freeze (water → slippery ice)
· poison+water → contamination · air+water → mist · air+earth → dust · air+poison → disperse (clears
clouds) · electric+metal → magnetise · plant+water → bloom (regen) · light+shadow → eclipse (blinds)
· ice+air → blizzard · poison+plant → blight (blocks regen).

They trigger when projectiles **clash mid-air**, when an element hits a target that is wet / burning /
frozen / standing in water / of the opposite element, when a beam crosses a zone, and when an attack
lands on a reactive ground tile. Attacks also **transform the ground** (`transformGround`): ice
freezes water, fire melts ice and burns grass to ash, water turns soil to mud, earth fills water,
plant greens soil and stone.

## 8. The arena and the body — `src/world/arena.ts`, `src/world/physics.ts`

17 ground types with friction, conductivity, wetness, diggability, flammability, temperature, depth
and move cost; 10 arena kinds (meadow, lake, volcano, canyon, tundra, swamp, crystal, city, beach,
forest); 12 weathers with element multipliers, visibility, wetness, wind, friction and particles.
Physics: traction limited by `friction × g`; slopes steeper than the friction pull bodies downhill;
water drags and floats; flyers hover on a spring and are pushed by wind inversely to their mass;
collisions are mass-weighted with elasticity-based restitution; knockback is resisted by
`0.55 + 0.9 × balance` and staggers above a threshold. Lava burns non-fire bodies, thunderstorms throw
lightning (wet, metal and flying bodies attract it), heatwaves melt ice, snow freezes water.

## 9. The fighter's mind — `Battle.decide()`

Each option (move × target) gets a utility: expected damage (using *learned* type knowledge, not the
truth, until the Genemon is wise or experienced) × hit chance / (cost + 12), discounted by travel
time, boosted for kills, area coverage, electric-on-water, combo follow-ups; melee preference from
temper and the reach axis, ranged preference from fear. A softmax with temperature
`0.06 + 0.25·chaos + 0.18·(1 − wisdom)` picks: orderly, wise Genemon are predictable and precise,
chaotic ones surprise. Confusion can redirect a move at anyone. Movement: approach to the move's
range, kite when ranged and too close, circle-strafe at range, flee when afraid, avoid hostile zones
and (for non-swimmers) deep water.

## 10. Winning

A battle ends when a side has no conscious Genemon, or at 90 s on slot-weighted remaining HP (a draw
within 2%). Results fold back into each Genemon: battle record, element exposure (epigenetics), XP,
bond, learned type knowledge. The ladder (`src/ladder/mmr.ts`, being integrated) rates the result
against the *conditions* of the match, not only the opponent's rating.
