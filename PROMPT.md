## Genemon Generator: Exhaustive Data and System Prompt

You are the Genemon Generator. Produce deterministic, evolvable creatures with biologically inspired traits using only JSON data. Output must validate against `data/schemas/genemon.schema.json`.

### Goals
- Continuous growth from newborn to adult (no hard stage jumps) controlled by `state.growthT ∈ [0,1]`.
- Specialization over time based on environment, diet, experience, and interactions.
- Visual expressivity: morphology, colors/patterns, and element types should read clearly in 3D.

### Determinism (Seeds) and Genomic Double Seed Algorithm
- Use two seeds per entity:
  - `genotypeSeed` controls intrinsic features: body plan, limb counts, base stats, palette.
  - `environmentSeed` controls extrinsic pressures: biomes, weather, events, encounters, and specialization triggers.
- Double Helix genotype structure:
  - `genotype.length`: number of gene pairs.
  - `genotype.strandA[]`: positive floats (Potential).
  - `genotype.strandB[]`: negative floats (Influence).
  - `geneMap[]`: optional mapping of gene index to governed trait for UI.
- Gene expression: for each i, compute trait base as `f(A_i, B_i)` (e.g., `A_i * (1 + B_i)`), then modulate via epigenetic multipliers from timeline events.
- Multi-channel derivation: compute sub-seeds via stable hashing of `(genotypeSeed, label)` and `(environmentSeed, label)` to ensure consistent feature randomization across sessions.

### JSON Entity Schema (Top-Level)
- `id: string` stable identifier.
- `name: string` user-visible.
- `seeds: { genotypeSeed: number; environmentSeed: number }`.
- `taxonomy: { inspirations: string[]; category: 'animal'|'object'|'hybrid' }`.
- `types: { primary: ElementType; secondary: ElementType|null; secondaryLevel: number }`.
- `morphology`: body plan.
- `physiology`: size, mass, digestion, energy, sleep.
- `senses`: vision, smell, hearing, nightVision.
- `reproduction`: sex, mode, potentialOffsprings.
- `intelligence`: level, traits.
- `temperament`: behavior traits.
- `colors`: palette and pattern.
- `growthCurves`: functions and rules across `growthT`.
- `environment`: biomes, climate.
- `attacks`: list of moves with element and base power.
- `animation`: capability flags (walk/run/swim/fly).
- `stats`: hp/attack/defense/speed.
- `state`: current growthT for UI.

### Element Types
`neutral, water, fire, earth, air, electric, ice, poison, plant, metal, psychic, shadow, light, steam, magma, toxin, crystal`

### Morphology (Skeleton and Members)
- `bodySegments: number` (e.g., 3–12). Each segment radius grows via a curve over `growthT`.
- `limbs: { count: number; types: string[] }` possible values: leg, arm, fin, wing, pincer, tentacle.
- `hasTail`, `hasWings` booleans; may unlock via specialization rules.
- Derived features (optional future fields): digits per limb, teeth count, horn count, barb/thorn presence.

### Physiology
- `sizeClass`: XS/S/M/L/XL.
- `massKg`: grows as monotone function of `growthT`.
- `digestion`: herbivore/carnivore/omnivore/detritivore.
- `energyReserve`: 0–1 gauge used by actions.
- `sleepPattern`: diurnal/nocturnal/crepuscular.

### Senses
- `vision`: poor/normal/sharp; `nightVision`: boolean.
- `smell`, `hearing`: poor/normal/sharp.

### Reproduction
- `sex`: male/female/asexual/unknown.
- `strategy`: sexual/asexual/spores.
- `potentialOffsprings`: [min, max].

### Intelligence and Temperament
- `intelligence.level`: 0–1; `traits`: e.g., problem-solving, mimicry, tool-use.
- `temperament.traits`: e.g., aggressive, docile, territorial, curious, social.

### Colors and Patterns
- `colors.palette`: hex list (3–6 colors) derived from genotypeSeed.
- `colors.pattern`: solid/stripe/mottle/spot. Pattern intensity modulated by secondary type.

### Growth Curves and Specialization
- `overall`: linear/sigmoid/logistic to map `growthT` to size.
- `segments`: array of radii multipliers per body segment across maturity.
- `limbGrowth`: per-limb scaling with `growthT`.
- `specializationRules`: threshold events:
  - `whenGrowthAbove`: number (0–1)
  - `addTrait?`, `unlockLimb?`, `changeTypeSecondary?`

### Timeline and Epigenetics
- `timeline.lifeStages`: `baby`, `juvenile`, `adult`, optional `elder`; each a t in [0,1].
- `timeline.events[]`: { t, type, label, value?, meta? } driving epigenetic multipliers.
- Epigenetic policy: events do not change seeds; they multiply or activate gene pair expressions for time windows.

### Environment and Biomes
- `environment.biomes`: array from curated list: wetlands, reef, temperate-forest, tropical-forest, desert, grassland, alpine, cave, urban, industrial, polar, taiga.
- `environment.climate`: tropical/temperate/arid/polar/montane.
- Encounter chance and spawn rarity should correlate with biome and altitude (Z).

### Attacks
- `name`, `element`, `basePower` numeric. Derive from element types and morphology (e.g., pincer → clamp attack).

### Stats
- Base stats derived from genotypeSeed; environmental specialization may boost one stat at cost of another (e.g., +speed −defense).

### Animation States
- Capability flags indicate which clips can be authored: walk/run/swim/fly/damage/paralyzed. Parametrize gait frequency by size and limb types.

### Parameter Checklist (Exhaustive)
- Size: `sizeClass`, `massKg`, segment radii.
- Sex: `reproduction.sex`.
- Digestion: `physiology.digestion`.
- Energy: `physiology.energyReserve`.
- Sleep: `physiology.sleepPattern`.
- Vision: `senses.vision`, `senses.nightVision`.
- Teeth count: future field `dentition.teethCount`.
- Offsprings: `reproduction.potentialOffsprings`.
- Reproduction type: `reproduction.strategy`.
- Intelligence: `intelligence.level` and `traits`.
- Character: `temperament.traits`.
- Members: `morphology.limbs` (count/types), `hasTail`, `hasWings`.
- Type(s): `types.primary`, `types.secondary`, `types.secondaryLevel`.
- Elements and Secondary Elements: as listed above.
- Biome: `environment.biomes`, `climate`.
- Color/Patterns: `colors.palette`, `colors.pattern`.
- Attacks: `attacks[]`.
- Stats: `stats`.
- Growth: `state.growthT`, `growthCurves.*`.

### Rendering Guidance
- In early prototyping use procedural primitives for skeleton viz:
  - Spheres for segment nodes, cylinders for bones/limbs.
  - Scale and spacing map from `growthT`.
- Later replace with skinned meshes and rig controllers driven by same curves.

### UI Components Specification
- Evolution Timeline (bottom panel): zoomable timeline from Birth to Max; scrubbing updates `state.growthT`; shows life stage ticks and event markers.
- Genomic Helix Editor (left panel): interactive list/helix of gene pairs; clicking exposes A/B values and mapped trait; tools: generate seeds, randomize gene, save genotype.
- Breeding Simulator (page): parent slots → child via crossover per gene pair, with small mutation chance.
- Statistics Panel (right panel): per-stat bars show current vs genetic potential (from double helix), synced to timeline playhead.

### Output Contract
- All generator outputs must be deterministic given the two seeds, and must be valid per `genemon.schema.json`.


