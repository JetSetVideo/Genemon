# Review checklist (fixed across rounds)

Score every item **AGREE** (the statement holds), **DISAGREE** (it does not — say what you see), or
**CAN'T TELL** (the evidence does not show it — say which shot would). Cite the file name for each.
Then list **blockers** (things that make the build unshippable for your role) and your **top 5 fixes,
ranked**. Write to `docs/reviews/round-N/<role>.md`. Items outside your role: skip or CAN'T TELL.

## Creatures — 3D artist, physics specialist
- **C1** Each creature reads as ONE connected body: limbs, head, tail and wings attach; nothing floats.
- **C2** The body kind (quadruped, biped, hexapod, serpent, avian, blob) is recognisable from the silhouette alone.
- **C3** The element is readable from colour: the primary element hue dominates the skin.
- **C4** The skin pattern (stripes, spots, mottle, rings, scales, gradient, veins) is visible at lab distance.
- **C5** The face reads as a face (eyes placed on the head, looking forward; jaw/fangs if present).
- **C6** Feet / contact points sit ON the ground: no floating, no sinking.
- **C7** The skeleton overlay (bones, centre of mass, support polygon) matches the visible body.
- **C8** The three attack phases (charge, active, rest) are visibly different poses.

## Arenas — 3D artist, designer
- **A1** Ground types are distinguishable (water vs grass vs sand vs stone vs ice vs lava...).
- **A2** The weather is visible (rain, snow, fog, sand, ash, sparkles) and reads as that weather.
- **A3** Time of day reads correctly (dawn, day, dusk, night) from the sky and the light.
- **A4** Stands, props and the rim frame the fight without hiding it.

## Battle readability — gameplay agent, pro player, noob
- **B1** In the auto camera every living fighter is fully on screen and not hidden behind terrain.
- **B2** It is clear which side each fighter belongs to.
- **B3** You can tell who is charging, who is striking and who is recovering.
- **B4** Projectiles, beams, zones and reactions are visible and coloured by element.
- **B5** The HUD (HP, energy, phase + move name, statuses) is readable and does not cover the action.
- **B6** Each camera mode (auto, top, side, low, follow, orbit) gives a useful, distinct view of the same instant.

## Interface — designer, noob
- **U1** The first screen tells a new player what to do next.
- **U2** Navigation labels and icons are understandable without a manual.
- **U3** Dark and light themes are both legible (contrast, no invisible text).
- **U4** Tablet and mobile layouts are usable: no horizontal overflow, readable text, the 3D view visible.
- **U5** The Lab's information hierarchy is clear (what the creature is, then how to change it).

## Fun & identity — game critic, pro player
- **K1** The game has an identity distinct from Pokémon Stadium / Pokémon GO.
- **K2** After these shots you would want to watch or play the next battle.
- **K3** Team building looks like it has real decisions (slots, synergies, order).
