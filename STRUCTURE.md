## Project Structure

- `app.vue`: Mounts default layout and pages
- `layouts/default.vue`: Top bar + three panels
- `components/`
  - `TopBar.vue`, `DataTree.vue`, `DetailEditor.vue`
  - `ThreeScene.vue`, `EvolutionViewer.vue`, `MapCanvas.vue`
- `pages/`
  - `index.vue` (landing), `creator.vue`, `arena.vue`, `map.vue`, `users.vue`
- `composables/useGenemonLab.ts`: In-memory data model and CRUD
- `types/genemon.ts`: Strongly typed JSON schema mirror
- `data/`
  - `genemons/*.json`: Entity definitions
  - `genemon_base.json`: Immutable genotype baseline per GFK
  - `genemon_state.json`: Dynamic phenotype and combat state
  - `users.json`: Fake users and influence profiles
  - `map_data.json`: GeoJSON-like features (biomes, POIs)
  - `attacks.json`, `biomes.json`: Reference lists
  - `schemas/genemon.schema.json`: JSON Schema for validation
- `assets/css/base.css`: Layout CSS
- `master.css`: Root CSS variables
- `public/`: Static assets
- `nuxt.config.ts`: Nuxt config (Deno preset)
- `deno.json`: Deno tasks
- `package.json`: npm deps (nuxt, three)

## Server (Optional CRUD)

- `server/api/genemons/index.get.ts` – list genemons from `data/genemons`
- `server/api/genemons/[id].get.ts` – fetch a single genemon by id
- `server/api/genemons/update.post.ts` – write genemon JSON `{ id, data }`


