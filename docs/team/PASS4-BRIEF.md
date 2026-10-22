# Pass 4 brief — the founder's requests of 2026-10-22, decoded into requirement ids

Read first: `AGENTS.md`, `docs/team/BUILDER-BRIEF.md` (hard rules, final-answer format), then your lane below.
The request was voice-transcribed; this is the decoded intent. **Do not erase anything — develop it.**
Status words: OPEN until code + test + (for visuals) a browser capture prove it.

## Requirement ids (user's intent)

| id | requirement |
|---|---|
| P4-R1 | A button that randomly generates (hatches) new Genemon. Most newborns are NEUTRAL / plain; elements come later from food and life. |
| P4-R2 | A better Pokédex ("Dex"): every species seen, owned vs seen, filters, readable cards. |
| P4-R3 | UI restructure: find the team fast; SEVERAL saved teams (presets) with one active; see ALL my Genemon; readable names and techniques. |
| P4-M1 | Moves are PHYSICAL (body: size, weight, claws, horns, tail) or SPECIAL (element through an organ: mouth breath, eyes, aura) or STATUS. |
| P4-M2 | Power is bound to the body part: Fire Breath = a cone of fire from the MOUTH, stronger with a big mouth; Slice = physical, bound to size and weight. |
| P4-M3 | Learnable moves are LIMITED: some Genemon can learn powerful moves, others cannot (not enough energy, not big enough, wrong type, missing body part). |
| P4-M4 | Deeper move <-> arena interaction (ground, water, slopes, weather). |
| P4-M5 | Phase law: the most powerful moves have a VERY long charge, a long active phase and a long rest; the fastest moves are short in all three, hit little and have little spread. |
| P4-M6 | Moves COUNTER each other (a stun interrupts a long charge, a dash dodges a slow beam, water douses a fire breath...) and the AI weighs counters when judging a move. |
| P4-M7 | League-of-Legends kit: 4 moves = Q basic, W control (stun), E mobility (dash), R ultimate (special effects); one of them often carries a special effect (poison...). |
| P4-A1 | See each arena from the OUTSIDE before a battle (topology, grounds, weather) with a collapsible, well-defined statistics panel. |
| P4-U1 | Three-click rule: any data reachable in at most 3 clicks from anywhere. |
| P4-U2 | Clear, sharp, minimalist GLASS design for every panel, window and button (keep the current direction). |
| P4-U3 | All camera options in ONE collapsible menu; the camera is dynamic. |
| P4-V1 | Better 3D models: morphed / fused shapes (inner and outer angles), better skeletons, patterns, hitboxes, deformation, textures, shaders, bump mapping, depth, depth-of-field focus and fog. |
| P4-V2 | Animation min/max: a helix DNA where each trait has two genes, the minimum and the maximum, bounded by an equation, applied top-down from the gene seeds to the monster (`src/genome/morphTypes.ts`). |
| P4-V3 | Asymmetry is RARE; fractal development (fingers, digits, details); wings bigger, flapping more, more detail; mouths with teeth; manga eye structures (full / empty pupils, white eyes, colours, smoke from the eyes). |
| P4-B1 | Gauntlet mode: one Genemon keeps fighting random opponents; how far can it go (streak). |
| P4-B2 | Switching: a trainer throws Genemon into the battle; who comes in is decided before AND during the fight. |
| P4-E1 | Evolution by feeding and by the items won after battles; items rotate cyclically; currencies invested in the world bring back special items; items are food, cosmetics or fighting gear. |
| P4-E2 | Elements follow diet: normal -> fire with fiery food -> steam when water food is mixed in; the 3D design and the colours follow; colour code is sacred (water blue, fire red, electric yellow, steam pale grey-white...). |

## Contracts already landed (use them, do not redo them)

- `src/combat/moves.ts`: `MoveShape` has `"cone"` (breath/spray arc from the mouth) and `"dash"` (the body travels and strikes);
  `StatusId` has `"stunned"`; `Move` has optional `category`, `part`, `slot`, `arc`; `mv`, `st`, `kb`, `pull`, `wx`, `gr`, `heal`
  are exported. The battle engine support for cone / dash / stunned / interrupt / switching is the ORCHESTRATOR's job (in progress).
- `src/genome/morphTypes.ts`: `MorphHelix`, `GenePair`, `BoundTrait`, `EyeGenes`, `MouthGenes`, `WingGenes`, `SurfaceGenes`, `ANIM_CHANNELS`.

## Ownership

Each lane owns ONLY the new files it lists. Shared files (`src/ui/app.ts`, `src/ui/screens/registry.ts`, `src/ui/profile.ts`,
`web/styles.css`, `src/combat/battle.ts`, `src/combat/moves.ts`, `src/genome/genemon.ts`, `src/genome/genome.ts`,
`src/genome/phenotype.ts`, `src/render/creature.ts`, `src/render/animator.ts`, `src/render/battleView.ts`, `src/render/stage.ts`,
`deno.json`, `docs/SPEC.md`, `docs/QUESTS.md`, `docs/EVIDENCE.md`) are the orchestrator's: put the EXACT lines in your final answer.
CSS: you may not edit `web/styles.css`; write the CSS your markup needs into your final answer as one block (class names prefixed
with your lane, e.g. `.dex-`), using only CSS custom properties for dynamic values (strict CSP).

## Commands you may try (if denied: write "not executed", do not retry)

`cd /Users/macmax/Desktop/Genemon && deno check <your files>` and `deno test --allow-read tests/<your test>`.
