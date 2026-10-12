# Genemon Lab (Nuxt 4 + Deno 2 + Three.js)

Prototype lab to generate, evolve, and visualize Genemons in 3D. Editor-style UI with top bar, left/right panels, and a central viewport. Pure CSS and JSON data only.

## Tech
- Nuxt 4 (Nitro preset: deno)
- Deno 2 tasks (deno.json)
- Three.js for 3D
- Pure CSS (no preprocessors)
- JSON data in `/data`

## Quickstart (Deno)
```bash
cd /Users/macmax/Desktop/Genemon
# first run may fetch npm dependencies via Deno
deno task dev
```
Open http://localhost:3000.

## Project Structure
- `app.vue` / `layouts/default.vue` UI shell with three panels
- `components/` TopBar, DataTree, DetailEditor, ThreeScene, EvolutionViewer, MapCanvas, HelixEditor
- `pages/` creator, arena, map, users
- `types/` TypeScript types for JSON shapes
- `data/` JSON files
  - `genemons/*.json` individual Genemon entities (editor target)
  - `genemon_base.json` immutable genotype baseline (GFK-derived)
  - `genemon_state.json` dynamic phenotype state (timeline-driven)
  - `users.json` fake users with influence profiles
  - `map_data.json` GeoJSON features
  - `attacks.json`, `biomes.json` reference data
- `master.css` root variables; `assets/css/base.css` layout styles

## Data Flow
- JSON loaded via `import.meta.glob('/data/genemons/*.json', { eager: true })`
- State managed by `useGenemonLab()` composable
- Export button downloads current selection as JSON (no server writes)
- Optional server API routes (Nitro/Deno):
  - `GET /api/genemons` list
  - `GET /api/genemons/:id` detail
  - `POST /api/genemons/update` write `{ id, data }`

## Scripts
- `deno task dev` – start dev server
- `deno task build` – production build
- `deno task preview` – preview build

## Seed Strategy
Use two seeds per Genemon: `genotypeSeed` (intrinsics) and `environmentSeed` (extrinsics). This cleanly separates body plan and palette from environmental specialization and experiences.
