# Genemon

Generative monsters that live with you. Every Genemon is grown from a genome and keeps changing with
your real life — the hours you play, the places you go, the food you buy, the battles you fight —
then fights in physical 3D arenas whose ground, weather and time of day matter.

## Play it (one step)

In a terminal:

```
cd ~/Desktop/Genemon && deno task dev
```

Then open **http://127.0.0.1:8800** in your browser. You will see the Home screen with your first
Genemon turning on a pedestal; click **⚔ Instant battle**.

Two profiles exist on first launch: **Max** (you) and **Claude** (the AI). Switch in Settings → Profiles.

## What is in this build

- 26 opposite-pole axes (dark/light, void/matter, chaos/order, fear/certainty, solid/gas, slow/fast,
  weak/strong...) → body, size, density, elasticity, pattern, elements, stats, abilities, character,
  needs, envies, passions, fears and emotions are all derived from them.
- Lifestyle evolution: food, places (ground types), experiences (some need you to physically move),
  age, battles. Breed, fuse, morph and mutate in the Lab.
- Skeleton-based models with joint limits that change with the angles of the connected joints.
- Battles: 6-slot teams (big Genemon cost more slots), synergies, attack order, 3-phase attacks
  (charge → strike → rest), 14 elements, 18 spatial reactions (fire + water → smoke, electric +
  water → conduction...), statuses, terrain transformation, weather changes, flying, digging, melting.
- 10 arenas × 12 weathers × real local time, an intelligent broadcast camera, dark & light themes,
  profiles and settings saved locally, a Data screen (event ledger, charts, genospace, hardware).

What is modelled but not yet wired into the screens (world map, auction house, condition-aware
ladder, neural networks, netcode) is listed honestly in `docs/SPEC.md`.

For AI coding sessions: read `docs/START-HERE.md` first.
