# Pass 6 brief — the founder's request of 2026-10-23, decoded into requirement ids

Read first: `AGENTS.md`, `docs/team/BUILDER-BRIEF.md` (hard rules, final-answer format), `src/genome/p6Types.ts` (THE
contract: types + the exact API each producer exports), then your lane below. Voice-transcribed request; decoded
intent. **Do not erase anything — develop it.** Status: OPEN until code + test + (visuals) a browser capture prove it.

## Requirement ids

| id | requirement |
|---|---|
| P6-C1 | A complexity spectrum in the genome. MINIMAL = a globe: one round body, two colours, ONE eye, nothing else. MYTHIC = a colossus: XXL (fills the 6 slots alone), several tentacle branches, several wing pairs, several arm pairs with many fingers, two mouths, 6-8 complex eyes, a chimera. |
| P6-C2 | Rarity follows complexity: the mythic colossus is almost impossible to get (target ~1 in 5000 wild genomes; mythic tier ~1 in 1500); minimal globes are common-ish (~5-8 %); the median creature sits in "common". Breeding can climb the ladder slowly (complexity is heritable, mostly additive, rare jumps). |
| P6-B1 | Balance: a team of SIX small Genemon with good experience, strong kits, and good combination / harmony (complementary elements, synergies) BEATS the lone colossus in a 6-slot match; a BADLY composed team (same element, weak to it, no synergy) LOSES to it. Prove it with batches. |
| P6-B2 | Batches give maximum information: level brackets (10 / 25 / 50), team-quality brackets (poor / median / good), colossus vs team matrices with Wilson intervals; also close quest P5-1 (archetypes: Powerful 68 % dominant, Swarm 30 %, Fast 37 % -> every archetype 35-65 % with a counter). |
| P6-E1 | Evolution plans per lineage: some have ONE phase and never change form (static), some change a lot with age and experience; 1..6 phases, median ~3 with a spread. |
| P6-E2 | XP curves per lineage: some need a LONG XP bar per level (few long levels), some many SHORT levels. |
| P6-E3 | Phases unlock morph changes: longer neck, bigger wings, an extra wing pair, arms, more fingers, horns, armour... most lineages grow bigger at each phase. |
| P6-E4 | Metamorphosis lineages: larva -> cocoon -> imago (butterfly-like); molt lineages lose their armour at a phase. |
| P6-E5 | Reproduction windows: fertile periods (phase + cycle); breeding outside a window is refused with a reason. |
| P6-R1 | Old Genemon never die. The main ranked league (PRIME) refuses those past their prime and has a LEVEL CAP; the ETERNAL league admits every Genemon (elders, ancients, colossi) and has its OWN rating. |
| P6-R2 | A cleaner ranked UI: one Ranked button with a league choice, the team's eligibility visible at a glance (who sits out and why), both ladders readable. |
| P6-K1 | Colour theory: primary / secondary / tertiary colours, their compatibility (harmony schemes: mono, analogous, complementary, split, triad, tetrad) and their attribution to body parts; the element colour code stays sacred (primary hue); minimal globes use two colours. |
| P6-N1 | Nature and nurture intertwined: the DNA tends toward body-plan STRUCTURES (attractors: globe, quadruped, biped, avian, serpent, hexapod, cephalopod, larval, armoured, chimera); activities, foods, trainings and habitats fine-tune them over the creature's life (swimming -> fins, gym -> arms and shoulders, flight training -> wings, running -> legs...), capped so nurture bends nature, never replaces it. |

## Contracts landed (use them)

- `src/data/sizeBudget.ts`: `SIZE_CLASSES` now ends with `"XXL"` (slot cost 6, power budget 5.6 to tune); `MASS_THRESHOLDS.XL = 6000 kg`.
- `src/genome/p6Types.ts`: every type + the producer API. `MorphHelix.p6?: MorphP6`; `Phenotype.evo? / nurture? / palette3?`.

## Lanes (each owns ONLY its files; anything else = exact lines in the final answer)

| lane | owns (edit / create) | ids |
|---|---|---|
| genome-nature | NEW `src/genome/complexity.ts`, `src/genome/structure.ts`; `src/genome/{helix,genome,breeding}.ts`; tests | P6-C1, C2, N1 (+ helix p6 + p5 genes driven by counts and nurture) |
| evolution | NEW `src/genome/evolution.ts`; `src/genome/{phenotype,epigenetics,genemon,lifeclock}.ts`; `src/ui/sheet.ts`; tests | P6-E1..E5 |
| colour | NEW `src/genome/palette.ts`; `src/render/anatomy/{skin,coat}.ts`, `src/render/textures.ts`; tests | P6-K1 |
| render-complex | `src/body/skeleton.ts`, `src/render/anatomy/{body,limbs,loft,wings,hitbox,face,eyeAura,ops,egg,viability}.ts`; tests | P6-C1 visuals, E3/E4 visuals |
| balance | `src/data/sizeBudget.ts`, `src/combat/*`, `src/sim/batch.ts`, `tools/{batch,balance}.ts`, `src/ui/screens/batch.ts`; tests | P6-B1, B2 |
| leagues | NEW `src/ladder/leagues.ts`, NEW `src/ui/rankedPanel.ts`; `src/ladder/*`, `src/ui/{ladderStore}.ts`, `src/ui/screens/{ladder,home,arena}.ts`; tests | P6-R1, R2 |

Orchestrator-owned (exact lines only): `main.ts`, `src/ui/app.ts`, `src/ui/screens/registry.ts`, `src/ui/profile.ts`,
`web/styles.css`, `src/render/{creature,labView,battleView,homeView,animator,stage}.ts`, `src/genome/{morphTypes,p6Types,lifeTypes}.ts`,
`deno.json`, `docs/*`. CSS: ONE block per lane, classes prefixed (`.p6c-`, `.p6e-`, `.p6r-`, `.p6b-`).

## Working in a shared tree

- Other lanes edit concurrently: filter `deno check` output to your files; run your tests with `--no-check`.
- A producer you depend on may not be on disk yet: code against the contract in `p6Types.ts`, keep the import in ONE
  place, and say so in the final answer (the orchestrator wires it).
- Baseline before your change: `deno test --no-check --allow-read --allow-write=artifacts tests/` = 453 passed.
- Determinism, the Ledger, three.js via `src/lib/three.ts`, strict CSP, budgets (creature high < 40k tris, low < 15k;
  a colossus may use up to 60k high / 20k low) — AGENTS.md.
