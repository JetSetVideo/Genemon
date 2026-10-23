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

- **Round-1 review cross-check** (`docs/reviews/round-1/*.md`, received in full after pass 2):
  - FIXED with measurements:
    - X1-X8 exploits
    - biped/avian stability `[SPEC K2]`
    - phone overflow and portrait tablets (round 4: 0 overflow)
    - side identification and the HUD
    - mono-element accent colour: the complementary hue is replaced by an analogous one. Of 262 mono creatures, 0 now have an accent more than 60 deg from the body hue; the old formula put all of them 126-180 deg away.
    - element-chip contrast: theme text on a tint
    - light-theme muted text set to #5b6678
    - time of day now shapes creatures. Nothing ever wrote `activeHour`, so every Genemon stayed at 13 h. Battles, feeding and training now record their local hour as a circular running mean that moves along the shorter arc; an angle-only vector blend never moved between opposite hours. Pinned by the `[SPEC G2]` test.
  - FIXED, visual check pending (next capture): eyes now sit on the upper half of the head. The "up" vector was negated: +Z x +X = +Y, then x(-1).
  - STILL OPEN:
    - wing membranes fold into level shelves
    - no visible mouth or jaw
    - charge pose looks like rest
    - 06h renders as night; the volcano shows no lava
    - the 3D scene stays dark in the light theme
    - the low camera is blocked by props; follow tracks no one
    - no visuals for conduction, MISS or KO
    - the lab capture does not call `LabView.frame()`
    - serpent side view unverified
  - Disagreement kept: the critic asks for a 30-45 s median; the design keeps ~25 s (measured 22.9 s) for phone sessions.

- Market lots do not say whether the seller is a company, an NPC or a player, and promotions are not shown on the lot; World map labels clip at the frame edge (round-4 vision check).
- Balance regression to check first: an intermediate configuration measured better than the final one. Both runs use `deno task balance 6`.
  - Intermediate (PACE 0.6, every team starting ~11 m apart, XL budget 3.9): 12/13 elements in band, air 26 % the only miss; XL vs 4 S 47 %, L vs 3 S 53 %, M vs 2 S 44 %; median 18.0 s.
  - Final (PACE 0.5, start line scaled to body size): 10/13 in band (water 32 %, air 22 %).
  - The drop is within the +-11-point noise, but it coincides with the compact start for small bodies, which favours melee elements.
  - Re-measure with `deno task balance 12` before tuning elements.
- Element balance: water 32 %, air 22 %, fire 65 % (CI about +-11 points at n = 72). Probe
  (`artifacts/tmp/probe-elements.ts`): at equal power, air spends its budget on evasion (0.244 vs
  0.137), speed and rate; flight costs 1.5 energy/s. Neither evasion pricing nor the take-off decision
  moved air (26 % -> 26 %), so its duels are lost by wide margins - next: per-matchup duel traces.
- `frostFang` is learned by 25 corpus fighters and never used (melee option filtered by the closing
  test for slow ice bodies): move learning should respect the body's speed and reach.
- Readability: 6-vs-6 WIDE shots stay at 36-41 px; next lever is framing on projected extents instead
  of a bounding sphere. Fixed camera modes (top/side/low/follow/orbit) are not held to the floor.
- Not changed yet: faces (eyes/mouth), distinct charge vs rest poses, ground-type readability, 06h dusk.
- Insights (neural-network win predictor + PCA) and the 12-persona simulation: built by subagents, NOT integrated or verified (untracked files); the simulation builder was stopped before finishing.

## Round-3 reviews (2 agents, `docs/reviews/round-3/`): follow-up, verdicts not upgraded

- Verdicts:
  - 3D artist + physics: 34/100 (round 1: 30), NOT SHIP.
  - Designer: 56/100 (round 1: 36), REVISE.
  - Pro player: HOLD. Both reviewers stopped early on request, so X1-X8 were not re-judged.
- **Correction to the pass-2 readability numbers.**
  - The capture's readability table never checked that a fighter is INSIDE the canvas.
  - Both reviewers found living fighters entirely off-screen in the auto shots: 7 of 12 auto shots, and 4 of 5 of your fighters in the canyon shot.
  - The camera's own `outside` counter read 0-1, because it only checks the attacker and the target, by centre point.
  - The HUD-band aim lift (`battleCamera.ts`, `safeTop`) made it worse.
  - So "smallest fighter 41 px" overstates readability.
- Also found:
  - The tablet camera pulls back to ~30 m: fighters 18-44 px (round 2: 25-73 px).
  - KO'd fliers hang in mid-air, because KO bodies skip physics.
  - The camera buttons cover the rival HP cards on phone and tablet.
  - Charge and rest are numerically the same pose.
  - The "heatwave / fog / sandstorm" arena shots were captured during a storm a move triggered.
  - The panel's weather line was stale. Fixed after round 3: it now reads "started in ...".
- Eyes were judged on round-3 images, which predate the eye fix (`1a9b31c`): still to verify.

## Pass 4 - kits, anatomy, collection, arenas, gauntlet, economy (2026-10-22)

- Brief: `docs/team/PASS4-BRIEF.md` (requirement ids P4-*). Ten builder lanes plus the orchestrator; every lane's tests run in the real tree.
- Tests: `deno task test` ok | 301 passed | 0 failed; `deno task check` clean.
- Scenarios (`deno task scenarios`, n=120): SC-01..SC-06 PASS (SC-06 side parity 42.5 %, CI 34-51; at 1,200 seeds 47.8 %, CI 45-51).
- Balance (`deno task balance 72`): elements 40-62 % (13/13); big vs swarm 55 / 56 / 46 %; top cast share Void Orb 5.7 %; 3/141 moves never learned; median 24.8 s, draws 0 %.
- Capture round 6 (`artifacts/qa/round-6/`, real headless Chrome on Metal): 62 shots, 0 console errors, 0 overflow, 55 fps at 1440x900.
- Round-5 review findings fixed in round 6: the camera menu covered the fighters and the rival HUD (now closed, bottom-right); depth of field blurred the foreground (gentler defaults); big wings on non-fliers stood up like a frame (now drape along the flanks).
- Engine smoke in a browser: 1v1 volcano battle 37.8 s with 10 throw-ins and switches, loot added to the bag.
- Open: fighters still small and hidden by weather effects in storm battle shots (C2); 27 lopsided element pairs; hexapods never get wings; the folded wing reads as a thin blade from the side; learn-lock reasons not shown in the UI; investments not in the game; boss gauntlet UI not browser-checked.


## Pass 5 (2026-10-23): ten lanes integrated, measured by the orchestrator

Orchestrator model: claude-opus-5-5 (anthropic). Lanes: genetics-life, battle-brain, body-morph, helix-face,
skin-coat, animation, ui-sheet, home-dex, world-maps, batch-lab (`docs/team/PASS5-BRIEF.md`). Every number below
was re-run in the parent after integration, not copied from a lane report.

- Gates: `deno task check` clean; `deno lint` clean (177 files); `deno test`: **453 passed, 0 failed**.
- Scenarios SC-01..06 all PASS; SC-06 side parity 45.8 % [37-55] n=120; duration p10 26.3 s, median 42.9 s, p90 67.7 s.
- Balance 72 (senses plugged in as the default perception): 13/13 elements in band (Metal 60 % .. Fire 41 %);
  big vs swarm XL/4S 56 %, L/3S 55 %, M/2S 50 %; draws 1/1440; median 41.2 s (pass 4: 24.8 s);
  never learned 5/141 (geyser, solarBloom, shrapnel, plagueBurst, plague); learned never used: roar, tailwind,
  ironShell, worldTree, blackHole. 14 element pairs still at 0-4 % / 94-100 % (B2 open).
- Battle playback in Chrome: 0.75x of the speed setting measured (t = 11.0 s after 16 s wall, including slow-mo).
- Archetype matrix `deno task batch 48` (1008 battles, 0 draws): Powerful 68 % (DOMINANT, beats Swarm 88 %),
  Clever 60 %, Tank 57 %, Sensory 47 %, Fast 37 %, Swarm 30 % (WEAK); held-out seed: Powerful 62 %, Swarm 30 %.
  Clever and Tank have real counters (Tank loses to Clever 29 %); Fast and Swarm lack a winning matchup outside
  Swarm/Sensory. **The founder's "every archetype has pros and cons" is not met yet** (quest P5-1).
- Browser (`tools/p5probe.ts`, headless Chrome + Metal, 1440x900): 19/19 checks, 0 console errors; home platform
  with 4 creatures and size labels; profile sheet 10 sections; drag-to-feed onto `#scene` adds one `genemon.feed`
  row and a stomach item, popup moved to the top-left after the first capture showed it covering the creature;
  egg (opaque) and fetus (translucent, curled) seen; battle intents in the snapshot; a battle left 3 scars;
  no panel overflow on home, lab, dex, market, batch, settings, world; Home titles on 6 colour bands (DOM-measured).
- Long loop (`tools/p5life.ts`, fake clock): 10080x aged the team ~70 days in 10 min (1200 `genemon.life` rows);
  credits topped to 1e9; a x10 feast refused 3 times at capacity 7.9, accepted to 37.9 with "no food limit"
  (animator bloat 1); an ancient (age 5000 d) benched from a ranked battle. 7/7.
- Connectivity (`tools/p5gaps.ts`): 0 meshes farther than 4 % of body height from another mesh across 16 creatures;
  `--fake` reports the injected floating copy (gap 41-46 x height). Two vision "floating part" calls on the
  contact sheet were wrong by this measure (a far wing tip over the back; a whole-sheet question).
- Vision on close-ups: bellies lighter than backs; eyes in shallow sockets; serpents, octopus blobs, flame tails
  read; cel shading reads as toon bands + ink on some creatures and as smooth on others (celMix raised 0.9 -> 1,
  not re-judged).
- Integration choices: drag/Lab feeding goes through the stomach (`feedLife`), so food effects arrive as the life
  loop digests (shown as "digesting ->" lines); hatching starts at age 0 (egg); scars are applied after the fight
  from heavy hits (>= 25 % max HP, max 2 per Genemon), never inside the simulation.

## Pass 6 (2026-10-23): six lanes integrated, measured by the orchestrator

Lanes: genome-nature, evolution, colour, render-complex, balance, leagues (`docs/team/PASS6-BRIEF.md`). Every number
re-run in the parent after integration.

- Gates: `deno task check` clean; `deno lint` clean; `deno test`: **517 passed, 0 failed**.
- Scenarios SC-01..06 PASS (SC-06 56.7 % [48-65] n=120; median 42.1 s).
- Balance 72: 13/13 elements in band (Shadow 60 % .. Fire ~41 %); big vs swarm 53 / 50 / 47 %; draws 0/1440; median 38.3 s.
- Complexity (genome-nature lane, re-checked here): minimal 6.5 %, mythic 1/1516, colossal 1/4695 wild.
- **Integration defects found and fixed by measurement (real seeds, `tools/p6showcase.ts`):**
  - a minimal globe evolved "tentacles+" and reached 1.52 m (L, 3 slots); 300/400 globes gained part unlocks and globe
    sizes spread XS..XXL. Now: globes never gain parts, never molt / metamorphose, are capped at S, carry no coat
    decorations -> 400/400 globes XS/S with 0 part unlocks; the globe's floating crystal shard is gone (worst mesh gap
    7.3 % -> 0.8 % of height).
  - 25 of 20000 NON-colossal adults were XXL (1 in 800, six times the colossus rate). XXL is now reserved for colossi:
    0 non-colossal XXL in 20000; 120/120 colossus checks (40 colossi x 3 ages) are XXL.
  - the balance lane had tuned on stand-in recipe colossi; with real colossi (bred-to-the-top complexity genomes,
    `batch.ts colossalize`) the six won poor 10 / median 19 / good 49 % at budget 5.9. A sweep (5.9 / 5.2 / 4.8 / 4.4)
    set XXL = 5.0: pooled poor 32 / median 48 / good 69 % (seed 5), 35 / 52 / 69 % (held-out 1005). Good beats the
    colossus at every level and poor loses at every level; 4 of 9 level x quality cells remain outside their band.
  - a light-element colossus rendered as a white silhouette: body lightness capped at 0.78 and self-glow damped on pale
    bodies; it now reads pale yellow with shading, still very bright (quest P6-3).
- Archetype matrix n=48: Fast 50, Powerful 60, Clever 49, Tank 57, Sensory 46, Swarm 38 % (pass 5: Powerful 68 %
  dominant, Swarm 30 %); no flags; significant counters: Fast > Clever, Swarm; Powerful > Fast, Swarm; Clever > Tank;
  Tank > Swarm, Powerful; Sensory and Swarm none (quest P6-2).
- Browser: `tools/p5probe.ts` 19/19, `tools/p5life.ts` 7/7, `tools/p5gaps.ts` 0 floating meshes, 0 console errors;
  showcase (`artifacts/qa/p6-show3/`): globe = one sphere, one eye, two colours; quadruped colossus = 4 arms with hands,
  4 tentacles, 2 mouths, hooves + insect legs, nothing detached; cocoon = closed segmented pod standing on its base.
  Skeleton check: hexapod colossus 3 wing pairs, 2 arm pairs, 9 tentacle segments, 6 eyes (vision undercounted them
  in a crowded, bright frame). Home Ranked control: league toggle + start + tier + eligibility chips, no overlap.
- Evolution distribution (lane, 20000 genomes): static 12.0 %, gradual 70.1 %, metamorphosis 9.0 %, molt 8.9 %;
  phases 1..6 = 12.0 / 18.9 / 36.9 / 21.5 / 8.1 / 2.6 %.
