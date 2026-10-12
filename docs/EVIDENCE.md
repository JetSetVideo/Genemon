# Evidence log - one entry per pass

What was built, what was MEASURED (by which command), and the honest gaps. Reviewer reservations are
recorded as follow-up entries; a verdict is never upgraded in place. Numbers are copied from tool
output, never estimated.

## Pass 1 - working skeleton to first QA round (2026-10-12)

- Built: core (Rng, ledger), data lists, genome -> epigenetics -> phenotype, breeding, skeleton with
  coupled limits, physics, deterministic battle, render layer, UI shell, capture/balance/scenario tools.
- Measured: 15 tests; scenarios SC-01..06 PASS; QA round 1 = 55 shots, 0 console errors, offline.
- Reviewed by 3 agents (artist + physics, critic + pro + gameplay, designer + noob):
  `docs/reviews/round-1/*.md`. Verdict: not shippable - wing slabs, unreadable faces, ~20 px fighters,
  charge = rest, a broken stability metric, MMR/XP pump and 7 more exploits (X1-X8), phone layout wider
  than the phone, no side identification.

## Pass 2 - integrity, posture, legibility, ladder (2026-10-12)

Changes (commits `1666221`, `f5cefca`, and the pass-2 commit that adds this file):

- **Exploits X1-X8 closed** (see `docs/SPEC.md` section X): a seed pays XP/W-L/rating once; ranked
  arenas drawn by the ladder (real hour + real weather); ranked abandon = forfeit; evasion multiplicative,
  capped at 0.35 and priced in the power index; heal decay 0.6; conduction per bystander (type, defence,
  weaker conductivity, max 2, friendly fire labelled); synergies need two members and die with their
  enablers; flyer melee is an exposed dive; timeout score = plain HP share.
- **Docs matched to code**: Resonance (>= 2 shared primaries), Forgeheart (fire AND earth), meta floor
  (0.8 reachable).
- **Stability metric fixed** (physics blocker 5): soles are discs (not points) and the rest posture slides
  the legs under the centre of mass. Probe before: biped margins -0.002..-0.025 m, avian -0.010..-0.054 m
  (always unstable). After: biped +0.0095..+0.024, avian +0.013..+0.017, quadruped/hexapod/blob unchanged
  positive. `[SPEC K2]` now covers every body kind plus a falsifier (COM shoved past the soles reads unstable).
- **Legibility**: side ring + name tag + HP pip (you sky blue, rival orange); YOU / RIVAL HUD;
  side-coloured KO lines; 12 px HUD text; cards no longer eat orbit drags; display scale for small bodies
  (render only); size-scaled start formation; camera keeps fighters below the measured HUD band.
- **Layouts**: minmax(0,1fr) columns, shrinking chips, 4 tabs + More on phones, stacked portrait
  tablets, touch wording; QA overflow check rewritten (per region vs visualViewport).
- **Ladder wired**: Home "Instant battle" is ranked; Ladder screen (integrator) registered; every
  settled battle emits `battle.settled` (kind ranked / practice / replay / forfeit).
- **Tools**: `deno task lists` regenerates every GEN table of `docs/LISTS.md` (8 stale tables fixed);
  capture writes fighter screen boxes, HUD rectangles and a readability table.

Measured (commands and outputs):

| what | command | result |
|---|---|---|
| tests | `deno test --allow-read tests/` (integrator suites excluded while in progress) | 151 passed, 0 failed |
| scenarios | `deno run ... tools/scenarios.ts 120` | SC-01..SC-06 all PASS; SC-06 parity 53.3 % [44-62], median 23.7 s |
| element balance | `deno task balance 6` | 10/13 in 35-65 %: fire 65, metal 60, light 54, void 54, electric 53, psychic 53, earth 51, ice 49, shadow 42, plant 40, poison 40, **water 32, air 22** |
| big vs swarm | same | XL vs 4 S 44 %, L vs 3 S 42 %, M vs 2 S 42 % (n=36 each) |
| pace | same | median 22.9 s (p10 14.5, p90 41.2), draws 0 % |
| QA round 2 (before formation/display scale) | `deno task capture 2` | 0 console errors, 0 overflow; smallest fighter 21-46 px (auto + arena shots); fighters under HUD boxes in 7 of 10 auto/arena shots |
| QA round 3 (after) | `deno task capture 3` | 0 console errors, 0 overflow; auto 41 px; arena shots 36-80 px (4 of 9 >= 48 px); HUD overlap in 1 of 10 auto/arena shots; tablet 18 px, phone 18 px |
| own vision check (round 3) | `vision_analyze` on battle-angle-auto, mobile-battle | sides identifiable at a glance (rings, tags, YOU/RIVAL); phone: no clipping, 5 tabs incl. More, ellipsised chip; phone HUD covered 40-45 % of the 3D view -> compacted to one row per side (not yet re-captured) |
| QA round 4 (after integrating World, Market, Feats/quests) | `deno task capture 4` (roster-driven: every registered screen) | 10/10 screens captured, 0 console errors, 0 overflow at 1440 / 820 / 390; own vision check: World map renders places + simulated-GPS refusal text, Market shows live lots with timers / bid / buyout and a 48-round offline catch-up, phone More sheet opens with 6 tabs (~75x50 px targets) |
| tests after integration | `deno test --allow-read tests/` (sim + insights suites excluded while their builders finish) | 186 passed, 0 failed; bundle 1.02 MB |

Honest gaps after pass 2:

- Market lots do not say whether the seller is a company, an NPC or a player, and promotions are not shown on the lot; World map labels clip at the frame edge (round-4 vision check).
- Element balance: water 32 %, air 22 %, fire 65 % (CI about +-11 points at n = 72). Probe
  (`artifacts/tmp/probe-elements.ts`): at equal power, air spends its budget on evasion (0.244 vs
  0.137), speed and rate; flight costs 1.5 energy/s. Neither evasion pricing nor the take-off decision
  moved air (26 % -> 26 %), so its duels are lost by wide margins - next: per-matchup duel traces.
- `frostFang` is learned by 25 corpus fighters and never used (melee option filtered by the closing
  test for slow ice bodies): move learning should respect the body's speed and reach.
- Readability: 6-vs-6 WIDE shots stay at 36-41 px; next lever is framing on projected extents instead
  of a bounding sphere. Fixed camera modes (top/side/low/follow/orbit) are not held to the floor.
- Not changed yet: faces (eyes/mouth), distinct charge vs rest poses, ground-type readability, 06h dusk.
- Market, World, Quests, Insights, Simulation: built or being built by subagents; integration pending.
