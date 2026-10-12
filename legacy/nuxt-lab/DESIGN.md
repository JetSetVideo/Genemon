## Design Overview

Genemon Lab emulates a code-editor layout for rapid iteration on procedurally generated monsters. The center is a 3D lab; left is data structure; right is precise editors. All content is powered by JSON files and pure CSS.

### UI Layout
- **Top bar**: navigation (creator, arena, map), current genemon name, panel toggles.
- **Left panel**: data tree for `/data` with basic CRUD (create, select, delete, export selected JSON).
- **Center panel**: 3D scene and evolution viewer (5s birth→adult with orbiting camera).
- **Right panel**: property editors (name, types, growth, physiology, etc.).

### Three.js / Visualization
- Minimal skeleton-based proxy rendering in `EvolutionViewer` shows continuous growth controlled by `state.growthT ∈ [0,1]`.
- Camera animates around the subject during evolution to communicate volumetric change.

### Determinism and Seeds
- Use **two seeds per genemon**:
  - `genotypeSeed`: base morphology, color palette, innate traits, base stats.
  - `environmentSeed`: biomes, encounters, events; drives specialization and emergent traits.
- Optional derived seeds (not stored) can be created via stable hashing: e.g. `paletteSeed = hash(genotypeSeed, 'palette')`.

### Double Helix (Genotype) and Timeline (Phenotype)
- Genotype can be stored as two numerical strands or as keyed loci pairs (e.g., `"morpho.limb_potential": [0.8, -0.2]`).
- Phenotype evolves continuously along the ontogeny timeline via `state.growthT` and `timeline.events` epigenetic multipliers.

### Evolution Showcase Generator (Preview)
- A 5s automated capture that sweeps `growthT` from 0→1 while orbiting camera; output WebM/MP4 via `MediaRecorder`.
- Initial implementation targets a separate, in-memory Three.js scene to avoid coupling with editor viewport.

### Growth and Specialization
- Continuous growth parameter `growthT` maps to morph targets (segments, limbs, tail/wings enablement).
- Specialization rules unlock traits or switch secondary elements when thresholds are crossed (e.g., `whenGrowthAbove: 0.7 → secondary=air`).

### Map Prototype
- Manual XYZ path plotting over a world graticule, representing geolocation and altitude constraints for encounters.

### Accessibility and Theming
- Pure CSS variables in `master.css` for colors, spacing, elevation, radii.

## Data Files
- `data/genemon_base.json`: Immutable GFK/genotype baseline entries.
- `data/genemon_state.json`: Dynamic phenotype snapshots.
- `data/users.json`: Fake users with influence profiles.
- `data/map_data.json`: Geo features (biomes/POIs).
- `data/attacks.json`, `data/biomes.json`: Reference lists.


