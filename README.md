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
Genemon turning on a pedestal; click **⚔ Instant battle** for a ranked fight, or set up a practice
battle on the **Arena** screen. Everything is reachable by mouse; camera modes are the buttons on the
right edge of the 3D view.

Two profiles exist on first launch: **Max** (you) and **Claude** (the AI). Switch in Settings → Profiles.

## The ten screens

| Screen | What it is |
|---|---|
| Home | your day (real time, season, moon, weather), your team, active quests and their progress |
| Arena | ranked (the game draws the arena; your real hour and weather apply) or practice battles |
| Team | 6 slots — big Genemon cost more — synergies, attack order, type coverage |
| Lab | inspect, feed, grow, expose, breed, mutate, morph, fuse; skeleton and balance overlay |
| World | 3D map of places around your home; discover, claim territory, shop, train, catch and release. Actions that need you physically there are refused unless you say you are present |
| Market | auction house that keeps running while you are away: bids, buyouts, promotions, company and NPC sellers |
| Ladder | the condition-aware rating, its learned weights, your best and worst conditions |
| Feats | achievements by category, with progress |
| Data | the event ledger, charts, the genome space, hardware and session data, JSONL export |
| Settings | theme, quality, camera, the two profiles |

## What is in this build

- 26 opposite-pole axes (dark/light, void/matter, chaos/order, fear/certainty, solid/gas, slow/fast,
  weak/strong...) → body, size, density, elasticity, pattern, elements, stats, abilities, character,
  needs, envies, passions, fears and emotions are all derived from them.
- Lifestyle evolution: food, places (ground types), experiences (some need you to physically move),
  age, battles — and your real hour, which shapes whether a Genemon becomes a night or day creature.
  Breed, fuse, morph and mutate in the Lab.
- Skeleton-based models with joint limits that change with the angles of the connected joints; a real
  balance model (centre of mass over the soles).
- Battles: 6-slot teams (big Genemon cost more slots), synergies that die with their enablers,
  order that sets the formation, 3-phase attacks (charge → strike → rest), 14 elements, 18 spatial
  reactions (fire + water → smoke, electric + water → conduction...), statuses, terrain and weather
  changes, flying with exposed dives, digging, melting.
- 10 arenas × 12 weathers × real local time, an intelligent broadcast camera, dark & light themes,
  profiles and settings saved locally.

## Measured, not claimed

`docs/EVIDENCE.md` records every pass with the command that produced it. Current numbers:

- **196 unit tests**, 6/6 gameplay scenarios from the brief (fire vs two plants, fire + water smoke,
  electric on water > mud > stone, fliers dodging quakes, diggers needing diggable ground, slot parity).
- Balance: **10 of 13 elements** win 35–65 % of same-size duels; big vs swarm at equal slots 42–44 %;
  median battle 22.9 s, no draws.
- QA round 4: **10/10 screens** load in real headless Chrome on desktop, tablet and phone with
  0 console errors and 0 horizontal overflow.

## What is built but NOT in the game yet

Listed with ids and statuses in `docs/SPEC.md`; the honest gap list is at the end of `docs/EVIDENCE.md`.

- The **Insights screen** (neural win predictor, genome PCA map, your play pattern): models built and
  tested (9 tests), screen written but not wired — two lines, quest D6. In its one measured run the
  neural network did **not** beat logistic regression.
- The **12-player simulation**: half-built, parked in `artifacts/wip/sim/` — quest S1.
- **Online play**: protocol, anti-cheat and a server design exist (`docs/NETWORK.md`), no server runs.

## Known broken (first quest, `docs/QUESTS.md` C2)

The battle camera leaves living fighters off-screen in about half of the automatic-camera shots, and
the on-screen size floor (48 px) is not met. Both round-3 reviewers scored the build not-ready-to-ship
(3D/physics 34/100, designer 56/100). Their reports are in `docs/reviews/round-3/`.

For coding agents: read `AGENTS.md` first (hard rules, commands, where things live); the long-form state
and quest order are in `docs/START-HERE.md`.
