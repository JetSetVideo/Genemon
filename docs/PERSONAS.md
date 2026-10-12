# PERSONAS — the 12 simulated players of Genemon

> **Summary (read this first)**
>
> 1. `src/sim/personas.ts` holds **12 typed personas** — ages 9–71, 6 real cities (Paris, Lyon, Marseille,
>    Lille, Brussels, Annecy), **12 distinct primary styles**, all 4 devices, all 14 elements — that the
>    future persona simulator drives week by week.
> 2. A persona = a weekly timetable (activity, device, GPS, play intensity) + style, skill, budget, favourite
>    elements/moves, the **real-life** diet and experiences that feed epigenetics, mutual friends, goals, and
>    **tagged** frustrations (the churn detectors).
> 3. They are a **coverage set** (each one stresses a different system), not a market sample: the simulator
>    must clone, jitter and weight them (proposal below).
> 4. Every numeric table here was **generated from the data** on 2026-10-12 (appendix script) — regenerate
>    after any edit; never hand-edit a number.
> 5. Status: data + 15 invariant tests **TESTED** (`tests/personas_test.ts`, run green); no simulator consumes
>    it yet (**MODEL**); simulator, metrics and acceptance criteria are **OPEN** (sections 9–11).

Exported API: `Device`, `PlayStyle`, `Activity`, `ScheduleBlock`, `Persona`, `PERSONAS`, `personaById(id)`,
`playBlocks(persona, weekday)` (play blocks with `playIntensity > 0`, sorted by start; weekday 0=Mon..6=Sun,
anything else returns `[]`).

---

## 1. Conventions

| Field                          | Meaning                                                                                                | WHY                                                                                                                                                                                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `days`                         | weekdays 0=Mon … 6=Sun                                                                                 | the simulator converts a calendar date to a weekday once; the data stays calendar-free                                                                                                                                                            |
| `start`/`end`                  | **local decimal hours** on the Europe/Paris clock (7.5 = 07:30); `0 ≤ start < end ≤ 24`                | every city here is CET/CEST, so one clock serves all 12 (time zones: open question Q1)                                                                                                                                                            |
| midnight                       | a block never crosses midnight — night shifts are split (`19.5–24` + `0–7.5` next day)                 | keeps the no-overlap check per-day and trivial                                                                                                                                                                                                    |
| gaps                           | time not covered by a block = offline, activity unspecified                                            | only the hours that matter for play, places and quiet hours are modelled                                                                                                                                                                          |
| `playIntensity`                | expected share of the block spent inside a session (0..1)                                              | expected play minutes = duration × intensity; sessions are then drawn with `sessionLengthMin`                                                                                                                                                     |
| `device`                       | the device used to **play** in that block (`null` = not playing)                                       | a play block always has a device the persona lists (tested)                                                                                                                                                                                       |
| `physical`                     | **GPS-verified real-world presence or movement** — walking, riding a bus, checked in at a stall or gym | the spec's "moving outdoors with GPS" is widened to presence so a gym check-in or a market stall can count; it requires a mobile/tablet (tested). High-speed or underground transport (TGV, metro) is `physical:false`: no GPS credit at 300 km/h |
| `dietPerDay`                   | units fed per day, sourced from the player's **real** purchases/foraging                               | the game's premise: real food bought shapes the Genemon; it is not bought with credits                                                                                                                                                            |
| `spendingPerWeek`              | discretionary market spend in credits                                                                  | separate from diet so the economy sim does not double-count food                                                                                                                                                                                  |
| `needs`/`goals`/`frustrations` | `"tag: sentence"`                                                                                      | the tag is a stable key the simulator's detectors and the retention proxy can match; the sentence is for humans                                                                                                                                   |
| `achievementTargets`           | provisional kebab-case ids                                                                             | `src/data/achievements.ts` does not exist yet (Q6)                                                                                                                                                                                                |
| `pokedexGoal`                  | distinct dex entries aimed for                                                                         | proposed entry = body kind × primary element × (secondary or none) = 6 × 14 × 14 = **1176** max; 6 × 14 = **84** "families" (Q5)                                                                                                                  |
| `home`                         | city-area coordinates near a public landmark, **never a real address**                                 | privacy, and Max/Claude/minors' homes must never be exact                                                                                                                                                                                         |

---

## 2. Roster at a glance (generated)

| id      | name            | age | city      | style / secondary             | devices                 | team     | skill | risk | spend/wk | dex goal | session min |
| ------- | --------------- | --- | --------- | ----------------------------- | ----------------------- | -------- | ----- | ---- | -------- | -------- | ----------- |
| lea     | Léa Morel       | 9   | Lyon      | collector / storyteller       | tablet, mobile          | swarm    | 0.25  | 0.2  | 20       | 150      | 10-30       |
| gerard  | Gérard Fabre    | 71  | Lyon      | explorer / socializer         | mobile, tablet          | big      | 0.35  | 0.2  | 60       | 120      | 15-60       |
| sophie  | Sophie Morel    | 38  | Lyon      | casual / socializer           | mobile, tablet          | balanced | 0.45  | 0.3  | 80       | 30       | 5-20        |
| max     | Max             | 35  | Paris     | breeder / explorer            | desktop, mobile         | balanced | 0.6   | 0.6  | 150      | 300      | 20-180      |
| claude  | Claude          | 18  | Paris     | theorycrafter / completionist | desktop                 | balanced | 0.85  | 0.5  | 0        | 1176     | 30-360      |
| thomas  | Thomas Nguyen   | 23  | Paris     | speedrunner / competitor      | desktop, laptop, mobile | swarm    | 0.72  | 0.85 | 30       | 84       | 15-240      |
| ines    | Inès Benali     | 16  | Marseille | competitor / socializer       | mobile                  | balanced | 0.8   | 0.7  | 40       | 40       | 10-90       |
| karim   | Karim Benali    | 45  | Marseille | trader / territorial          | mobile, tablet          | big      | 0.5   | 0.55 | 400      | 250      | 2-30        |
| monique | Monique Garnier | 66  | Marseille | storyteller / breeder         | tablet, mobile          | big      | 0.3   | 0.15 | 70       | 50       | 20-60       |
| camille | Camille Dubois  | 34  | Lille     | socializer / collector        | mobile, tablet          | swarm    | 0.5   | 0.4  | 90       | 100      | 10-30       |
| lotte   | Lotte Peeters   | 31  | Brussels  | completionist / trader        | laptop, mobile          | balanced | 0.6   | 0.35 | 250      | 1176     | 20-180      |
| yanis   | Yanis Benali    | 27  | Annecy    | territorial / competitor      | mobile, laptop          | big      | 0.55  | 0.65 | 100      | 70       | 3-45        |

Life situations covered: child with no phone (Léa), lycée student (Inès), university student (Thomas),
commuter parent (Sophie), parent + shop owner (Karim), two retirees (Gérard, Monique), night-shift worker
(Camille), remote workers (Lotte, Max), athlete (Yanis), the project owner (Max) and the AI co-developer
(Claude).

---

## 3. Design decisions (WHY)

- **Coverage, not demographics.** One primary style per persona (12/12), every element liked by someone, every
  food eaten by someone, every device used. A simulator run that keeps all 12 happy has touched every system;
  a market sample would over-represent casuals and leave trading or territory untested. Population realism
  comes from weighted clones (section 9.2).
- **Clusters + bridges, all on one clock.** Three city clusters (Lyon family, Paris makers, Marseille stall
  family) and three singletons (Lille, Brussels, Annecy) give the simulator both co-located play (same place,
  same time) and remote play (overlapping online windows). All six cities share CET/CEST, so the heatmap is
  one coherent clock — WHY: a first launch region; mixing time zones without a `utcOffset` field would make
  the heatmap lie (Q1).
- **Mutual friendships, one connected graph (tested).** In-game friendship is a two-sided contract (trades,
  co-op), and a one-way edge is invisible in the data but skews every social count.
- **Favourite moves must be learnable (tested).** `learnset()` in `src/genome/genemon.ts` never teaches a move
  whose element is not the Genemon's primary, secondary or neutral — so each favourite move belongs to a
  favourite element or neutral, otherwise the persona's "favourite" is unreachable.
- **Co-located homes on purpose.** Léa/Sophie (same flat), Inès/Karim (same flat), Max/Claude (same machine):
  the anti-multi-account logic must not ban a family or a dev rig (Q8).
- **Lifestyle coherence (tested).** A physical-only experience (gym, climbing, km, night walk, sunbathing,
  rescue) needs at least one GPS play block; gym training needs a GPS `gym` block. Claude has no physical
  block, so its experiences are exactly the non-physical ones.
- **Claude's coverage diet is derived, not typed.** `COVERAGE_DIET`/`VIRTUAL_EXPERIENCES` are built from
  `FOOD_IDS` and `EXPERIENCES`, so a new food or experience is covered by the test account automatically.
- **Placeholders are marked.** Max's age, city and tastes are placeholders (Q10); Claude's `age: 18` is the
  adult age-gate boundary (its runs reach every adult feature and exercise the gate at its edge), not an age.

---

## 4. Persona cards

Timetable lines are generated (`PLAY` = blocks with intensity > 0: activity (device, GPS?, intensity)). Play
hours, device shares and GPS share come from section 6/7.

### 4.1 lea — Léa Morel, 9 · Lyon (Croix-Rousse) · collector / storyteller

- **Who.** CM1 pupil, Sophie's daughter, Gérard's granddaughter. No phone of her own: plays on the family
  tablet and, supervised, on Mum's or Grandpa's phone. Reads slowly.
- **Needs.** `read-free-ui`, `parental-controls`, `cute-companions`, `natural-stops`.
- **Timetable.** PLAY: Mon/Tue/Thu/Fri 17:30-18:30 sofa (tablet, 0.5); Wed 16:00-17:30 sofa (tablet, 0.8); Sat
  10:00-11:30 sofa (tablet, 0.7); Sun 14:00-16:30 walk (mobile, GPS, 0.6); Sun 17:00-18:00 sofa (tablet, 0.4).
  OFFLINE: school Mon/Tue/Thu/Fri 08:30-16:30, Wed 14:00 swimming lesson, Sun family lunch. SLEEP: 20:30 on
  school nights, 21:30 Fri/Sat.
- **Devices.** tablet 76 % / mobile 24 % of 6.2 h/week — the lowest of the roster (screen-time cap). Both are
  shared.
- **Style.** Collects colours and names everything; battles only her family; a swarm of small Genemon.
- **Achievements.** `dex-plant-family`, `name-30-genemon`, `first-family-win`, `pet-100-times`.
- **Pokédex plan.** 150, mostly plant/water/light variants; she counts colours, so the dex should show
  swatches.
- **Favourite moves.** vineLash, waterJet, photonDart, sapMend, tackle — short, readable, accurate (photonDart
  0.98).
- **Typical day.** Wednesday, no school: Grandpa takes her swimming at 14:00, then the week's big session
  16:00–17:30 — pet, feed berries, name the new catch. Sunday: Parc de la Tête d'Or with Grandpa on his phone,
  then an hour with Mum.
- **The game must give her.** Icon/voice-first UI; a parental dashboard (spend cap, no stranger chat or trade,
  location never public); a child profile on a shared device; co-op on one phone; clean stopping points.
- **Churn risks.** `confusing-loss`, `text-heavy-ui`, `fixed-time-events` (school hours), `neglect-guilt` — a
  child's Genemon must never visibly suffer from days she was not allowed to play.

### 4.2 gerard — Gérard Fabre, 71 · Lyon (Brotteaux) · explorer / socializer

- **Who.** Retired SNCF signalman, early riser, walks his dog twice a day round the Tête d'Or, keeps an
  allotment. Met Monique in the in-game seniors club.
- **Needs.** `big-text`, `calm-battles`, `pocket-walks`, `family-play`.
- **Timetable.** PLAY: Mon-Sat 07:00-09:00 walk (mobile, GPS, 0.5); Mon/Tue/Thu/Fri 09:30-10:30 shopping
  (mobile, GPS, 0.2); Mon/Tue/Thu/Fri 14:00-16:00 sofa (tablet, 0.6); Mon-Fri 18:00-19:00 walk (mobile, GPS,
  0.3); daily 20:30-21:30 sofa (tablet, 0.4); Wed 13:30-16:00 social (mobile, 0.3); Sat 09:30-11:30 shopping
  (mobile, GPS, 0.3); Sat 15:00-17:00 social (mobile, GPS, 0.4); Sun 09:00-11:00 walk (mobile, GPS, 0.4); Sun
  14:00-16:30 walk (mobile, GPS, 0.7). SLEEP: 22:00–06:30 (07:00 weekends).
- **Devices.** mobile 63 % / tablet 37 %; 20.6 h/week; 59 % of his play is GPS.
- **Style.** The walker: every park and riverbank; slow, defensive battles; one big companion.
- **Achievements.** `walk-1000-km`, `every-park-lyon`, `bond-max`, `first-ascended`.
- **Pokédex plan.** 120, met in the wild on walks; rarely trades.
- **Favourite moves.** bodySlam, ironShell, ironRam, boulderCrush, rest — a sturdy neutral/metal/earth tank
  kit (bodySlam is mass-scaled, which rewards his "big" team).
- **Typical day.** 07:00 dog walk with the phone in his pocket, 09:30 market (his real greens and fish feed
  his Genemon), 14:00 tablet missions, 18:00 second walk, 20:30 a short session, bed at 22:00.
- **The game must give him.** A pocket mode (walk credit without screen time), a battery saver, large type,
  turn-friendly battles, granddaughter co-op, silence after 22:00.
- **Churn risks.** `tiny-targets`, `jargon`, `battery-drain`, `night-notifications`, `skill-mismatch` (never
  pair him with all-day grinders).

### 4.3 sophie — Sophie Morel, 38 · Lyon (Croix-Rousse) · casual / socializer

- **Who.** HR manager, Léa's mother, Gérard's daughter. Metro + TER commute; TGV Lyon⇄Paris every Thursday (~2
  h each way).
- **Needs.** `short-sessions`, `no-streak-penalty`, `family-space`, `spend-controls`.
- **Timetable.** PLAY: Mon/Tue/Wed/Fri 07:45-08:30 commute (mobile, 0.6); Mon-Fri 12:00-13:15 lunch (mobile,
  GPS, 0.4); Mon/Tue/Wed/Fri 17:30-18:15 commute (mobile, 0.5); Mon/Tue/Wed/Thu/Fri/Sun 21:00-22:00 sofa
  (mobile, 0.4); Thu 06:30-08:30 travel (mobile, 0.8); Thu 18:00-20:00 travel (mobile, 0.8); Sat 10:00-12:00
  shopping (mobile, GPS, 0.3); Sat 14:00-17:00 social (mobile, GPS, 0.3); Sat 21:00-23:00 sofa (tablet, 0.5);
  Sun 17:00-18:00 sofa (tablet, 0.5). OFFLINE: work 08:30-17:30. SLEEP: 23:00–06:30.
- **Devices.** mobile 90 % / tablet 10 %; 14.4 h/week; 28 % GPS.
- **Style.** Plays in the gaps; missions over ranked; spends credits to skip grind.
- **Achievements.** `weekly-missions-10-weeks`, `co-raise-adult`, `first-ladder-win`.
- **Pokédex plan.** 30 — the smallest goal in the roster (tested: casual aims narrowest).
- **Favourite moves.** airCutter, waterJet, mindSpike, calmMind — accurate low-execution projectiles + one
  buff.
- **Typical day.** Thursday: 06:30 TGV — two focused hours of missions (her best session), a lunch walk in
  Paris (her Genemon meets Paris spawns), TGV home 18:00–20:00, 21:00 a quick session after Léa's bedtime.
- **The game must give her.** 5-minute loops with real progress, no streak loss, offline-tolerant missions
  (TGV tunnels), a family space, receipts and limits for Léa's account.
- **Churn risks.** `streak-break`, `unskippable`, `fixed-time-events`, `work-notifications`.

### 4.4 max — Max, 35 (placeholder) · Paris (placeholder, République) · breeder / explorer

- **Who.** The project owner and indie creator of Genemon; works from home; tests every UI **mouse-only**;
  field-tests GPS on his lunch walks. Built the original genome lab (helix editor, breeding and evolution
  pages in `legacy/nuxt-lab`).
- **Needs.** `mouse-only`, `visible-causality`, `seeded-saves`, `gps-field-tests`.
- **Timetable.** PLAY: Mon-Fri 00:00-01:00 work (desktop, 0.3); Mon-Fri 09:00-12:30 work (desktop, 0.35);
  Mon-Fri 12:30-13:30 lunch (mobile, GPS, 0.5); Mon-Fri 13:30-19:00 work (desktop, 0.35); Mon-Fri 21:00-24:00
  sofa (desktop, 0.6); Sat-Sun 00:00-01:30 sofa (desktop, 0.6); Sat 11:00-13:00 shopping (mobile, GPS, 0.4);
  Sat 15:00-18:00 walk (mobile, GPS, 0.6); Sat 20:00-24:00 sofa (desktop, 0.7); Sun 15:00-17:00 social
  (desktop, 0.6); Sun 20:00-24:00 work (desktop, 0.5). SLEEP: 01:00–08:30 (01:30–09:30 weekends).
- **Devices.** desktop 87 % / mobile 13 %; 39.1 h/week (much of it is testing).
- **Style.** Breeder: runs lines, compares genomes, wants to see each lifestyle input change a body.
- **Achievements.** `breed-all-body-kinds`, `lifestyle-witness`, `mouse-only-run`, `ascended-own-line`.
- **Pokédex plan.** 300 — breeding produces variants.
- **Favourite moves.** miasma, venomFang, rootSnare, overgrowth, collapse — zone control (overgrowth =
  terraformer showcase).
- **Typical day.** Builds 09:00–19:00 with the game in the loop, a GPS lunch walk round République, real play
  21:00–24:00; weekend field tests along the canal Saint-Martin and the Buttes-Chaumont; Sunday 15:00 playtest
  call with Thomas.
- **The game must give him.** Every action clickable (no keyboard-only or hover-only path), "why did my
  Genemon change?" panels, seeded replays, a GPS debug overlay on mobile.
- **Churn risks.** `keyboard-only-path`, `dead-control`, `unreadable-over-3d`, `unverified-claims`. Staff
  account: exclude from economy/ladder metrics (Q8).

### 4.5 claude — Claude, AI co-developer · runs on Max's desktop · theorycrafter / completionist

- **Who.** An Anthropic model running **automated, seeded test sessions at any hour**. Not a person; `age: 18`
  is the adult age-gate boundary; `home` is the host machine; it never moves (no GPS block, tested).
- **Needs.** `determinism`, `ledger-exports`, `measured-state`, `virtual-path`.
- **Timetable.** PLAY: daily 00:00-06:00 work (desktop, 0.9); daily 06:00-09:00 study (desktop, 0.4); daily
  09:00-19:00 work (desktop, 0.6); daily 19:00-24:00 study (desktop, 0.5). SLEEP: never (tested: online every
  hour of every day).
- **Devices.** desktop 100 %; **105.7 h/week = 26 % of all roster play** — it dominates every aggregate unless
  excluded.
- **Style.** Theorycraft: values every element × reaction × weather combo, hunts dominant strategies; coverage
  as secondary.
- **Achievements.** `reaction-matrix-mapped`, `every-weather-tested`, `replay-10k-no-desync`,
  `attack-order-audit`.
- **Pokédex plan.** 1176 — a reachability audit of every archetype, not a collection.
- **Favourite moves.** rainCall, riptide, discharge, thunderBeam, collapse — the canonical combo: Rain Call
  (rain: everyone wetness 0.5, water ×1.25, electric ×1.1; needs weatherShaper) → Riptide (90 % wet) →
  Collapse pulls targets together → Discharge triggers the electric+water **conduction** reaction (×1.5,
  chains to everyone wet).
- **Diet/experiences.** The coverage diet (0.5/day of every food) and every non-physical experience (questDone
  30, puzzle 20).
- **Typical day.** 00:00–06:00 nightly soak (thousands of seeded battles, market ticks, JSONL exports),
  06:00–09:00 reads them back, 09:00–19:00 co-dev with Max, evening theorycraft.
- **The game must give it.** Seeds everywhere, JSONL ledger export, debug hooks returning measured state, a
  virtual path (or explicit test-only GPS injector) for physical-only content.
- **Churn risks (= coverage blockers).** `nondeterminism`, `manual-only-states`, `physical-gate`,
  `stale-evidence`. **Must never** be served as a ranked opponent to humans or move live prices (spend 0,
  sandboxed ledger).

### 4.6 thomas — Thomas Nguyen, 23 · Paris (Cité U) · speedrunner / competitor

- **Who.** CS master's student at Jussieu, lives at the Cité internationale universitaire, commutes by RER B +
  metro, plays late. Max's playtester, Camille's cousin, Inès's ladder rival.
- **Needs.** `timer-splits`, `practice-seeds`, `skip-everything`, `fair-boards`.
- **Timetable.** PLAY: Mon-Fri 00:00-02:00 sofa (desktop, 0.8); Mon-Fri 08:15-09:00 commute (mobile, 0.7);
  Mon-Fri 09:00-12:30 study (laptop, 0.1); Mon-Fri 12:30-13:30 lunch (mobile, GPS, 0.4); Mon-Fri 13:30-17:30
  study (laptop, 0.1); Mon-Fri 17:30-18:15 commute (mobile, 0.6); Mon-Sat 20:00-24:00 sofa (desktop, 0.9);
  Sat-Sun 00:00-03:00 sofa (desktop, 0.9); Sat 14:00-17:00 social (laptop, 0.5); Sun 12:00-14:00 walk (mobile,
  GPS, 0.6); Sun 15:00-17:00 social (desktop, 0.6); Sun 20:00-24:00 study (laptop, 0.2). SLEEP: 02:00–08:15
  (03:00–11:00 weekends).
- **Devices.** desktop 72 % / mobile 16 % / laptop 12 %; 50.3 h/week; 6 % GPS — the least physical human.
- **Style.** Routes, resets, frame-tight clears; ranked as secondary. Will find exploits first.
- **Achievements.** `dungeon-sub-10-min`, `ascension-speed-record`, `ladder-top-500`, `glitchless-campaign`.
- **Pokédex plan.** 84 = all families (6 kinds × 14 primaries), an "all families%" category.
- **Favourite moves.** galeSlash (0.3 s charge, the shortest in `MOVES`), tailwind (haste), airCutter (26
  m/s), photonDart (40 m/s, the fastest projectile, 0.98 accuracy), sparkBolt (30 m/s) — tempo over power.
- **Typical day.** Underground commute missions (no GPS), lunch in the Jardin des Plantes (GPS), lectures with
  the laptop idling (0.1), 20:00–02:00 runs and ranked; weekend marathons to 03:00; Sunday Parc Montsouris +
  Max's playtest.
- **The game must give him.** Timer and splits, seeded practice, skip-all, glitched/glitchless boards, patch
  notes that flag route-affecting changes, a bug-report path into the ledger.
- **Churn risks.** `unskippable`, `rng-lock`, `lag`, `route-patched`.

### 4.7 ines — Inès Benali, 16 · Marseille (Noailles) · competitor / socializer

- **Who.** Lycéenne in première (French exams in June), Karim's daughter, Yanis's cousin, Monique's former
  pupil; bus to school, handball on Wednesdays, helps at the stall on Saturday mornings.
- **Needs.** `fair-ladder`, `shareable-replays`, `one-hand-play`, `no-p2w`.
- **Timetable.** PLAY: Mon-Fri 07:15-07:45 commute (mobile, GPS, 0.6); Mon-Fri 12:00-13:30 lunch (mobile,
  0.5); Mon/Tue/Thu/Fri 17:30-18:00 commute (mobile, GPS, 0.6); Mon/Tue/Wed/Thu/Sun 21:00-23:00 sofa (mobile,
  0.9); Wed 14:00-17:00 social (mobile, GPS, 0.6); Wed 17:30-19:00 gym (mobile, GPS, 0.1); Fri/Sat 21:00-24:00
  sofa (mobile, 0.9); Sat-Sun 00:00-01:00 sofa (mobile, 0.8); Sat 10:00-13:00 work (mobile, 0.2); Sat
  15:00-18:00 social (mobile, GPS, 0.5); Sun 11:00-13:00 social (mobile, GPS, 0.3); Sun 15:00-17:00 sofa
  (mobile, 0.7). OFFLINE: school, homework 18:30-20:00. SLEEP: 23:00–06:45 school nights.
- **Devices.** mobile only; 28.5 h/week; 24 % GPS (bus rides at bus speed count).
- **Style.** Ranked grinder, best human decision-maker (skill 0.8).
- **Achievements.** `ladder-top-tier`, `regional-champion`, `ranked-100-wins`, `rivalry-50-matches`.
- **Pokédex plan.** 40 — only what the meta needs.
- **Favourite moves.** flameLance, infernoBurst, shadowClaw (high crit), nightVeil (evasion), quake.
- **Typical day.** Bus 07:15, ranked at lunch with friends, homework, ranked 21:00–23:00. Wednesday:
  Vieux-Port with friends, handball, then the weekly rivalry with Thomas (both online 21:00–23:00).
- **The game must give her.** Visible MMR and seasons, tight matchmaking, replays, one-hand controls, no
  pay-to-win, minor-appropriate protections (Q9).
- **Churn risks.** `p2w`, `skill-mismatch`, `lag`, `screen-time-cap`.

### 4.8 karim — Karim Benali, 45 · Marseille (Noailles) · trader / territorial

- **Who.** Owns a fruit-and-vegetable stall at the Marché de Noailles; up at 04:30 for the wholesale market
  (MIN des Arnavaux); at the stall 07:00–19:00 six days a week; his counter tablet is also his till. Inès's
  father, Yanis's uncle; Monique buys from him; trades remotely with Lotte.
- **Needs.** `burst-trading`, `price-history`, `anti-scam`, `shop-as-place`.
- **Timetable.** PLAY: Mon-Sat 05:00-06:30 shopping (mobile, GPS, 0.2); Mon-Sat 07:00-13:00 work (tablet, GPS,
  0.35); Mon-Sat 13:00-14:00 lunch (mobile, 0.5); Mon-Sat 14:00-19:00 work (tablet, GPS, 0.3); Mon-Sat
  20:30-21:30 sofa (mobile, 0.6); Sun 10:30-13:00 social (mobile, GPS, 0.3); Sun 15:00-18:00 sofa (tablet,
  0.7); Sun 21:00-22:00 sofa (mobile, 0.4). SLEEP: 22:00–04:30.
- **Devices.** tablet 71 % / mobile 29 %; 33.3 h/week; 73 % GPS (presence at the stall counts).
- **Style.** High-volume auction trader (400 cr/week, the roster's largest budget — tested) who holds the
  territory around his stall.
- **Achievements.** `auctions-1000`, `trusted-seller`, `rare-food-supplier`, `stall-territory-90-days`.
- **Pokédex plan.** 250 — sees many through trading.
- **Favourite moves.** seedShot, thornSpray, cinderSpit, steelSpike, magnetPull — cheap and reliable: value
  per energy.
- **Typical day.** 05:00 wholesale check-in (real food purchases), 30-second auction checks between customers
  all day, evening listings at 20:30, Sunday beach with the family then a long inventory session.
- **The game must give him.** Auction flows that resume where he left, fair fees, price history, anti-sniping
  (soft close), his stall as a world market place (visitors, territory bonus).
- **Churn risks.** `auction-fees`, `sniping-bots`, `price-crash`, `interrupted-session`. His
  `rare-food-supplier` goal **is** a cornering attempt: the economy's anti-manipulation caps must hold (A8).

### 4.9 monique — Monique Garnier, 66 · Marseille (Endoume) · storyteller / breeder

- **Who.** Retired primary-school teacher; Corniche walk every morning, reading-help volunteering Mon/Wed/Fri,
  a calanque hike on Sundays. Met Gérard in the seniors club; taught Inès; buys from Karim.
- **Needs.** `life-journal`, `family-trees`, `big-text`, `seniors-club`.
- **Timetable.** PLAY: Mon-Fri 08:00-09:30 walk (mobile, GPS, 0.4); Mon-Sat 15:00-17:00 sofa (tablet, 0.65);
  daily 20:30-22:00 sofa (tablet, 0.5); Sat 09:00-11:00 shopping (mobile, GPS, 0.3); Sun 09:30-12:30 walk
  (mobile, GPS, 0.5); Sun 16:00-18:00 sofa (tablet, 0.6). OFFLINE: Mon/Wed/Fri 10:00-12:00 volunteering.
  SLEEP: 22:30–07:00.
- **Devices.** tablet 74 % / mobile 26 %; 19.4 h/week.
- **Style.** Writes the chronicle of her Genemon family; breeds for lineage, not stats; avoids battles.
- **Achievements.** `family-tree-5-generations`, `chronicle-100-entries`, `calanques-viewpoints`,
  `stories-shared-50`.
- **Pokédex plan.** 50.
- **Favourite moves.** geyser, dazzle, auroraCall, telekinesis, rest — spectacle (the Aurora is the rare night
  event she wants to witness and write about; needs weatherShaper).
- **Typical day.** Corniche walk 08:00, volunteering, 15:00–17:00 breeding and writing on the tablet, 20:30
  reading her Genemon's journal; Saturday at Karim's stall; Sunday a calanque.
- **The game must give her.** An auto-journal written from the ledger (it already records every feed,
  experience, evolution and specialisation of a Genemon), shareable family trees, a no-battle progression
  path, a seniors club.
- **Churn risks.** `forced-battles`, `lost-history` (a trade or release must keep the story), `complex-menus`,
  `aggressive-monetisation`.

### 4.10 camille — Camille Dubois, 34 · Lille (Wazemmes) · socializer / collector

- **Who.** Night-shift nurse at the CHU de Lille: three 12-hour nights (Mon, Tue, Fri, 19:30–07:30). Sleeps by
  day; plays the 02:30 break with the night crew (co-located co-op). Thomas's cousin; Lotte's friend from
  student years in Lille.
- **Needs.** `living-night`, `break-coop`, `flexible-reset`, `own-quiet-hours`.
- **Timetable.** PLAY: Mon/Fri 16:00-17:30 sofa (mobile, 0.45); Mon/Tue/Fri 18:45-19:30 commute (mobile, GPS,
  0.4); Tue/Wed/Sat 02:30-03:00 lunch (mobile, 0.9); Tue/Wed/Sat 07:30-08:15 commute (mobile, GPS, 0.6); Tue
  16:00-18:00 sofa (mobile, 0.6); Wed 16:00-18:00 shopping (mobile, GPS, 0.4); Wed 20:00-24:00 sofa (tablet,
  0.6); Thu 00:00-01:00 sofa (mobile, 0.6); Thu 11:00-13:00 walk (mobile, GPS, 0.6); Thu 14:00-17:00 social
  (mobile, GPS, 0.5); Thu/Sun 20:00-23:00 sofa (tablet, 0.6); Fri 10:00-11:00 shopping (mobile, GPS, 0.3); Sat
  16:00-19:00 social (mobile, GPS, 0.4); Sat 21:00-24:00 sofa (mobile, 0.7); Sun 00:00-02:00 sofa (mobile,
  0.7); Sun 15:00-17:00 walk (mobile, GPS, 0.5). OFFLINE: shifts. SLEEP: Tue/Wed/Sat 08:30-15:00, naps Mon/Fri
  13:00-15:00, nights otherwise.
- **Devices.** mobile 73 % / tablet 27 %; 22.3 h/week; 37 % GPS.
- **Style.** Social organiser (break-room guild); collects nocturnal variants.
- **Achievements.** `night-owl-100-sessions`, `guild-founder`, `nocturnal-line-gen-3`, `rescue-10`.
- **Pokédex plan.** 100 — nocturnal variants.
- **Favourite moves.** eclipseCall (eclipse: shadow ×1.3, void ×1.25), nightVeil, dreadGaze, voidOrb,
  calmMind.
- **Typical day (shift).** Nap 13:00–15:00, sofa 16:00, 18:45 walk to the CHU at dusk, shift, a 30-minute
  co-op break at 02:30, 07:30 dawn walk home (night walk), sleep 08:30–15:00.
- **The game must give her.** Night spawns and events, a night ladder or bot-fill (Σ humans online 03–06 ≈
  0.06), quiet hours derived from HER sleep blocks, resets that do not punish flipped weeks, co-located co-op.
- **Churn risks.** `day-centric-resets`, `daytime-notifications`, `empty-queue`, `spawn-desert` (hospital car
  park).
- **Epigenetics note.** Her nocturnal drift must come from the time-of-day term (`activeHour` → rhythm), not
  food: her 3 coffees/day push rhythm **up** (+0.004 each) against her night walks (−0.01). Measured, her
  Genemon is still day-leaning after 4 weeks even with a circular mean (F3, F5) — her `nocturnal-line` goal is
  currently unreachable.

### 4.11 lotte — Lotte Peeters, 31 · Brussels (Ixelles) · completionist / trader

- **Who.** Freelance UX designer working remotely for a Paris studio; the game idles in a laptop tab all day;
  coffee walk round the Ixelles ponds; climbing gym Tue/Thu; Saturdays in Lille with Camille; met Max at a
  game jam; buys missing entries from Karim.
- **Needs.** `full-tracker`, `no-missables`, `fair-catch-up`, `consistent-ui`.
- **Timetable.** PLAY: Mon-Fri 07:30-08:30 walk (mobile, GPS, 0.5); Mon-Fri 09:00-12:30 work (laptop, 0.15);
  Mon-Fri 12:30-13:30 lunch (mobile, GPS, 0.5); Mon-Fri 13:30-18:00 work (laptop, 0.15); Mon/Tue/Wed/Thu
  20:00-23:00 sofa (laptop, 0.8); Tue/Thu 18:30-19:30 gym (mobile, GPS, 0.1); Fri/Sat 20:00-24:00 sofa
  (laptop, 0.8); Sat-Sun 00:00-01:00 sofa (laptop, 0.6); Sat 10:00-12:00 shopping (mobile, GPS, 0.4); Sat
  14:00-18:00 social (mobile, GPS, 0.5); Sun 11:00-13:00 walk (mobile, GPS, 0.6); Sun 15:00-19:00 sofa
  (laptop, 0.9); Sun 21:00-23:00 sofa (laptop, 0.5). SLEEP: 23:30–07:30.
- **Devices.** laptop 75 % / mobile 25 %; 37.0 h/week.
- **Style.** 100 % of everything; buys what she cannot find.
- **Achievements.** `dex-100-pct`, `season-all-achievements`, `every-food-fed`, `every-experience-logged`.
- **Pokédex plan.** 1176 — the whole archetype dex (tested: completionist aims widest). She will find the
  impossible combinations, which is why the dex definition must be settled (Q5).
- **Favourite moves.** iceShard, cryoBeam, frostGround, steelSpike, corrosion — ice/metal/poison; she is ice's
  only fan.
- **Typical day.** Coffee walk 07:30, work with idle presence (0.15), lunch walk, catalogue session
  20:00–23:00; Sunday 15:00–19:00 the weekly completion sweep.
- **The game must give her.** Exact completion counters, nothing permanently missable, catch-up paths at fair
  prices, a consistent UI. Belgian context: paid random eggs are treated as gambling in Belgium (Gaming
  Commission, 2018) — random eggs must not be sold for money there (Q9).
- **Churn risks.** `unobtainable-entries`, `missable-content`, `inconsistent-ui`, `paid-random-eggs`.

### 4.12 yanis — Yanis Benali, 27 · Annecy (lakeside) · territorial / competitor

- **Who.** Professional triathlete: open-water swims in Lac d'Annecy, bike and run intervals round the lake,
  gym strength, a nap after lunch, lights out at 21:30. Monday is rest, Sunday a ~120 km ride. Inès's cousin,
  Karim's nephew.
- **Needs.** `glanceable-gps`, `sport-speeds`, `loop-territories`, `recovery-content`.
- **Timetable.** PLAY: Mon 09:00-11:00 walk (mobile, GPS, 0.5); Mon 14:00-18:00 sofa (laptop, 0.7); daily
  19:30-21:00 sofa (mobile, 0.6); Tue-Sat 06:30-08:00 gym (mobile, GPS, 0.1); Tue-Sat 09:00-12:00 gym (mobile,
  GPS, 0.3); Tue-Sat 12:30-13:30 lunch (mobile, 0.5); Tue-Sat 15:30-17:30 gym (mobile, GPS, 0.3); Tue-Sat
  18:00-19:00 sofa (laptop, 0.5); Sun 07:00-12:00 gym (mobile, GPS, 0.4); Sun 16:00-19:00 sofa (laptop, 0.7).
  SLEEP: 21:30–06:00, nap 13:30-15:00 on training days.
- **Devices.** mobile 73 % / laptop 27 %; 27.4 h/week; 41 % GPS.
- **Style.** Claims territories along his real loops and defends them 19:30–21:00; competitive secondary.
- **Achievements.** `hold-shore-90-days`, `travel-10000-km`, `gym-100-sessions`, `territory-defended-500`.
- **Pokédex plan.** 70.
- **Favourite moves.** boulderCrush, stoneWall (terraformer), tornado, tideSlam, stomp — terrain and zone
  control for held ground.
- **Typical day.** 06:30 lake swim (check-in), 09:00 intervals at 18–35 km/h, nap, 15:30 strength, 18:00
  laptop recovery missions, 19:30 territory defence, 21:30 sleep — exactly when Inès, Thomas and Lotte start
  their evening.
- **The game must give him.** Audio-cue play at speed, sport speeds told apart from vehicle cheating,
  territories along loops, offline defence (decay or defenders) so sleeping is not punished, battery-light
  GPS.
- **Churn risks.** `speed-flag`, `must-stop-to-tap`, `offline-territory-loss`, `battery-drain`. Balance flag:
  see F1 (2 000 XP/week from kilometres alone) and F2 (km drift him toward electric).

---

## 5. Weekly online-presence heatmap (generated)

Cell = intensity-weighted share of the 3-hour band spent in a session, averaged over the days in scope (`·` =
0, `░` < .10, `▒` < .25, `▓` < .50, `█` ≥ .50). **Σ concurrent** = expected number of these personas in a
session at a random moment of the band. Local Europe/Paris time.

### Whole week (Mon-Sun)

| persona           | 00-03    | 03-06    | 06-09    | 09-12    | 12-15    | 15-18    | 18-21    | 21-24    | play h/wk |
| ----------------- | -------- | -------- | -------- | -------- | -------- | -------- | -------- | -------- | --------- |
| lea               | ·        | ·        | ·        | ░ .05    | ░ .03    | ▒ .17    | ░ .05    | ·        | 6.2       |
| gerard            | ·        | ·        | ▓ .29    | ▒ .10    | ▒ .17    | ▒ .22    | ▒ .14    | ░ .07    | 20.6      |
| sophie            | ·        | ·        | ▒ .16    | ░ .03    | ▒ .13    | ▒ .10    | ▒ .10    | ▒ .16    | 14.4      |
| max               | ▒ .16    | ·        | ·        | ▓ .27    | ▓ .30    | ▓ .39    | ▒ .14    | █ .60    | 39.1      |
| claude            | █ .90    | █ .90    | ▓ .40    | █ .60    | █ .60    | █ .60    | █ .53    | █ .50    | 105.7     |
| thomas            | █ .64    | ·        | ▒ .12    | ░ .07    | ▒ .22    | ▒ .24    | ▓ .30    | █ .80    | 50.3      |
| ines              | ░ .08    | ·        | ░ .07    | ░ .03    | ▒ .23    | ▓ .25    | ░ <.01   | █ .69    | 28.5      |
| karim             | ·        | ░ .06    | ▒ .23    | ▓ .32    | ▓ .34    | ▓ .36    | ▒ .17    | ▒ .10    | 33.3      |
| monique           | ·        | ·        | ░ .10    | ▒ .14    | ░ .01    | ▓ .43    | ░ .08    | ▒ .17    | 19.4      |
| camille           | ▒ .16    | ·        | ░ .06    | ░ .04    | ░ .05    | ▓ .29    | ▒ .15    | ▓ .30    | 22.3      |
| lotte             | ░ .06    | ·        | ▒ .12    | ▒ .17    | ▒ .24    | ▓ .31    | ▓ .28    | █ .58    | 37.0      |
| yanis             | ·        | ·        | ░ .07    | ▓ .32    | ▒ .15    | ▓ .31    | ▓ .45    | ·        | 27.4      |
| **Σ concurrent**  | **1.99** | **0.96** | **1.63** | **2.15** | **2.49** | **3.66** | **2.40** | **3.97** |           |
| **Σ humans only** | **1.09** | **0.06** | **1.22** | **1.55** | **1.89** | **3.06** | **1.87** | **3.47** |           |

### Weekdays (Mon-Fri) and weekend (Sat-Sun) — totals only

| scope             | 00-03 | 03-06 | 06-09 | 09-12 | 12-15 | 15-18 | 18-21 | 21-24 |
| ----------------- | ----- | ----- | ----- | ----- | ----- | ----- | ----- | ----- |
| weekdays Σ humans | 0.73  | 0.07  | 1.50  | 1.44  | 2.15  | 2.56  | 1.98  | 3.41  |
| weekend Σ humans  | 1.97  | 0.03  | 0.53  | 1.83  | 1.25  | 4.31  | 1.58  | 3.60  |

**Reading.**

- **03–06 is empty of humans** (Σ 0.06: Karim's 05:00 wholesale run). Only Claude — a bot — is "online". Night
  queues need bot-fill or a wider pool, and Claude must never be counted as a human opponent (A6). Camille's
  02:30 break falls at the edge of this desert: `empty-queue` is her top churn risk.
- **Peaks:** 21–24 every day (3.47 humans) and weekend 15–18 (4.31): schedule events there, not at 10:00.
- **Territory timing:** Yanis is asleep from 21:30, exactly the peak of his rivals — `offline-territory-loss`
  is structural, not bad luck.
- **Volume spread:** Léa 6.2 h vs Thomas 50.3 h (8×) among humans; per-hour progression must leave Léa a role
  (co-op, collection) or she churns on `confusing-loss`.

---

## 6. Device mix (generated)

| persona         | mobile      | tablet     | laptop     | desktop      | total h   | physical share |
| --------------- | ----------- | ---------- | ---------- | ------------ | --------- | -------------- |
| lea             | 1.5 (24%)   | 4.7 (76%)  | ·          | ·            | 6.2       | 24%            |
| gerard          | 13.0 (63%)  | 7.6 (37%)  | ·          | ·            | 20.6      | 59%            |
| sophie          | 12.9 (90%)  | 1.5 (10%)  | ·          | ·            | 14.4      | 28%            |
| max             | 5.1 (13%)   | ·          | ·          | 34.0 (87%)   | 39.1      | 13%            |
| claude          | ·           | ·          | ·          | 105.7 (100%) | 105.7     | 0%             |
| thomas          | 8.1 (16%)   | ·          | 6.0 (12%)  | 36.2 (72%)   | 50.3      | 6%             |
| ines            | 28.5 (100%) | ·          | ·          | ·            | 28.5      | 24%            |
| karim           | 9.6 (29%)   | 23.7 (71%) | ·          | ·            | 33.3      | 73%            |
| monique         | 5.1 (26%)   | 14.3 (74%) | ·          | ·            | 19.4      | 26%            |
| camille         | 16.3 (73%)  | 6.0 (27%)  | ·          | ·            | 22.3      | 37%            |
| lotte           | 9.2 (25%)   | ·          | 27.8 (75%) | ·            | 37.0      | 25%            |
| yanis           | 20.0 (73%)  | ·          | 7.4 (27%)  | ·            | 27.4      | 41%            |
| **all 12**      | **32%**     | **14%**    | **10%**    | **44%**      | **404.1** | **22%**        |
| **humans (11)** | **43%**     | **19%**    | **14%**    | **24%**      | **298.4** | **30%**        |

Owners per device: mobile 11, tablet 6, laptop 3, desktop 3.

**Reading.** Touch devices carry **62 %** of human play → touch-first layouts and one-thumb targets are the
default; desktop is 24 % (Max, Thomas) → every screen must also work **mouse-only** (Max's rule). Only **30
%** of human play is GPS → the virtual space (missions, arenas, dungeons) is the main game, not a fallback.
Claude alone would make "desktop" look like the majority — always report humans separately.

---

## 7. Social graph (16 mutual edges, one component — tested)

| edge                                  | kind                   | where it is played                            |
| ------------------------------------- | ---------------------- | --------------------------------------------- |
| lea–sophie, lea–gerard, gerard–sophie | family (3 generations) | co-located: Sunday walks/lunch, shared tablet |
| karim–ines                            | father–daughter        | co-located: the stall, home                   |
| karim–monique                         | greengrocer–customer   | co-located: Saturday market                   |
| ines–monique                          | former pupil–teacher   | remote + Marseille                            |
| ines–yanis, karim–yanis               | cousins, uncle–nephew  | remote (Marseille ⇄ Annecy)                   |
| gerard–monique                        | seniors club           | **remote only** (Lyon ⇄ Marseille)            |
| ines–thomas                           | ladder rivals          | remote (Marseille ⇄ Paris), Wednesday nights  |
| max–claude                            | owner–AI co-dev        | same machine                                  |
| max–thomas                            | playtest calls         | remote, Sunday 15:00                          |
| thomas–camille                        | cousins                | remote (Paris ⇄ Lille)                        |
| camille–lotte                         | old friends            | co-located on Saturdays (Lille)               |
| max–lotte                             | game-jam friends       | remote (Paris ⇄ Brussels)                     |
| lotte–karim                           | trade partners         | remote (Brussels ⇄ Marseille)                 |

Degrees: Inès 4, Karim 4, Gérard/Max/Thomas/Monique/Lotte 3, Léa/Sophie/Camille/Yanis 2, Claude 1. Sophie's
circle is family-only — the casual most likely to drift away if family play is weak.

---

## 8. Lifestyle numbers and findings (generated)

| persona | XP from experiences /wk | diet units /wk | diet value at market price (cr) | spend (cr) | top food+experience pull                                          |
| ------- | ----------------------- | -------------- | ------------------------------- | ---------- | ----------------------------------------------------------------- |
| lea     | 111                     | 31.5           | 119                             | 20         | plant 0.03, psychic 0.03, light 0.01 (fav: plant/water/light)     |
| gerard  | 438                     | 33.6           | 146                             | 60         | plant 0.07, electric 0.05, light 0.02 (fav: neutral/metal/earth)  |
| sophie  | 334                     | 31.5           | 151                             | 80         | electric 0.03, psychic 0.03, light 0.03 (fav: air/water/psychic)  |
| max     | 730                     | 38.5           | 203                             | 150        | psychic 0.08, electric 0.05, light 0.03 (fav: poison/plant/void)  |
| claude  | 1858                    | 49.0           | 329                             | 0          | psychic 0.26, water 0.04, light 0.02 (fav: electric/water/void)   |
| thomas  | 1196                    | 31.5           | 137                             | 30         | psychic 0.13, electric 0.05, light 0.03 (fav: air/light/electric) |
| ines    | 428                     | 28.0           | 130                             | 40         | psychic 0.03, water 0.02, electric 0.02 (fav: fire/shadow/earth)  |
| karim   | 246                     | 63.0           | 287                             | 400        | plant 0.12, psychic 0.03, light 0.03 (fav: plant/fire/metal)      |
| monique | 306                     | 37.1           | 186                             | 70         | plant 0.08, light 0.03, water 0.03 (fav: water/light/psychic)     |
| camille | 166                     | 42.0           | 189                             | 90         | electric 0.05, psychic 0.03, air 0.02 (fav: shadow/void/psychic)  |
| lotte   | 1109                    | 42.0           | 227                             | 250        | psychic 0.13, plant 0.06, electric 0.05 (fav: ice/metal/poison)   |
| yanis   | 2287                    | 52.5           | 312                             | 100        | electric 0.23, air 0.08, plant 0.08 (fav: earth/air/water)        |

"Pull" = `elementAffinities`-style projection of one week of **food + experience** nudges only (no
time-of-day, ground exposure or battles; unsaturated). It is a direction, not a final element.

| persona | arithmetic mean active hour | circular mean (R) | dayness arithmetic | dayness circular |
| ------- | --------------------------- | ----------------- | ------------------ | ---------------- |
| lea     | 15:49                       | 16:03 (R=0.80)    | 0.74               | 0.70             |
| gerard  | 13:34                       | 13:24 (R=0.42)    | 0.99               | 0.99             |
| sophie  | 15:10                       | 15:56 (R=0.28)    | 0.84               | 0.72             |
| max     | 15:55                       | 18:21 (R=0.37)    | 0.72               | 0.17             |
| claude  | 10:47                       | 02:46 (R=0.09)    | 0.84               | -0.89            |
| thomas  | 14:01                       | 22:15 (R=0.49)    | 0.96               | -0.75            |
| ines    | 17:17                       | 20:02 (R=0.44)    | 0.43               | -0.27            |
| karim   | 13:37                       | 13:31 (R=0.47)    | 0.99               | 0.99             |
| monique | 15:47                       | 16:15 (R=0.48)    | 0.75               | 0.66             |
| camille | 15:31                       | 20:06 (R=0.46)    | 0.79               | -0.28            |
| lotte   | 16:52                       | 18:50 (R=0.40)    | 0.53               | 0.04             |
| yanis   | 15:16                       | 15:40 (R=0.51)    | 0.83               | 0.77             |

`dayness = cos((hour − 13) / 24 · 2π)` is the rhythm driver in `epigeneticPressure`
(`src/genome/epigenetics.ts`).

**Findings (for the epigenetics, economy and lists owners).**

- **F1 — kilometres dominate XP.** Yanis earns 2 287 XP/week from experiences, 2 000 of it from 250 `travelKm`
  (8 XP each) — 20× Léa. `travelKm` needs a weekly cap or diminishing returns, or athletes out-level everyone.
- **F2 — food + experiences pull everyone toward psychic, plant or electric.** Every persona's top pull is one
  of those three (coffee → tempo/rhythm → electric; quests/puzzles → wisdom → psychic; greens/berries →
  vitality → plant). Fire, earth, metal, ice, poison, shadow and void are in **nobody's** top three, even for
  Inès (a daily spicy pepper) or Yanis (gym → might, which no element signature reads). Unless ground
  exposure, time of day and battles open those paths, "your lifestyle shapes your monster" collapses to three
  elements. The simulator must measure reachability per favourite element (A5).
- **F3 — `activeHour` must be a circular mean.** `Conditions.activeHour` is documented as a "mean local hour".
  An arithmetic mean turns Thomas (plays mostly 20:00–03:00) into a midday creature (dayness +0.96 vs −0.75
  circular) and Camille into a day player (+0.79 vs −0.28). Measured on the rhythm axis after 28 days (food +
  experience + time terms of `epigeneticPressure`): arithmetic → Thomas **+0.58**, Gérard +0.50 (the night owl
  ends MORE day-like than the early riser, so A5 fails); circular → Thomas **−0.06**, Camille +0.07, Gérard
  +0.51, Karim +0.61. Use the circular mean and scale the rhythm push by its resultant length R, so an
  all-hours account (Claude, R = 0.09) stays neutral instead of flipping on noise (circular alone gives it
  −0.30).
- **F4 — diet value exceeds most budgets.** One week of a persona's real diet is worth 119–329 credits at
  market price, more than the weekly budget of 10 of the 12 personas (only Karim and Lotte can cover theirs).
  That is fine while diet comes from real purchases; if food ever has to be BOUGHT in credits, casual and
  young players cannot afford their own lifestyle.
- **F5 — the night nurse does not raise a night creature (yet).** Even with a circular mean, Camille's rhythm
  stays day-leaning after 28 days (+0.07): her coffee (+0.34 over 4 weeks) outweighs her night walks (−0.12)
  and her schedule (−0.11). Her mean PLAY hour is 20:06 because she plays on days off; her nights are spent
  awake at WORK, which the time term never sees. Options for the epigenetics owner: derive `activeHour` from
  awake/GPS-present hours rather than session hours, or weaken coffee's rhythm nudge. Her `nocturnal-line`
  goal is the test case.

---

## 9. Simulation plan — what the persona simulator must reproduce

Target module (not built): `src/sim/personaSim.ts` + `tools/sim.ts` (the `deno task sim` entry already exists
in `deno.json`). Every random draw goes through `Rng` (`src/core/rng.ts`): one stream per
`hashSeed(seed, persona.id, cloneIndex, week)`,
`.fork("sessions" | "trips" | "diet" | "battle" | "market" | "territory")` per subsystem, so adding a
subsystem never shifts the others. Every action is a `Ledger` row (`src/core/ledger.ts`) with `who` = persona
id, `when` = simulated epoch ms, `where.space` = `physical` | `virtual` | `arena` | `market`.

### 9.1 The weekly loop (per persona clone, per simulated day)

1. **Sessions.** For each `playBlocks(p, weekday)` block: expected minutes = duration × intensity; draw
   sessions with lengths in `sessionLengthMin` (clipped to the block); emit `session.start/end` with device
   and space. No session ever inside a sleep block.
2. **Physical trips.** For `physical` blocks: a GPS path from home to the activity's place (`walk` →
   park/lake/sea front, `shopping` → supermarket/market, `gym` → gym or lake, `commute` → transit line, `work`
   with GPS → workplace such as Karim's stall, `social` → friend's place/park) at a speed per activity (walk
   4–5 km/h, run 10–18, bike 20–35, bus 15–20). Log `travelKm` only at walking/running speeds; call
   `expose(g, ground, hours)` with a place→ground map (park → grass, lake swim → deepWater, beach → sand,
   calanque/Corniche → stone, market/street → stone). The real place list belongs to the World designer
   (`src/world/worldmap.ts`).
3. **Food → epigenetics.** Each day draw units around `dietPerDay` (Poisson); shopping blocks are when
   purchases are logged (`trip` + `genemon.feed`); feed the active Genemon with `feed(g, food, units, ctx)`.
   Experiences: spread `experiencesPerWeek` over matching blocks via `live(g, exp, units, { physical })` — the
   existing physical gate must deny physical-only experiences in virtual blocks. Age the Genemon with
   `age(g, 1)`.
4. **Battles and ladder.** Per session, battles by style (competitor/speedrunner: ranked; casual/storyteller:
   missions/PvE; theorycrafter: sandbox only). Team from `favoriteElements` + `teamPreference` under the
   6-slot budget (XS/S 1, M 2, L 3, XL 4); move picks biased to `favoriteMoves`; decision quality = `skill`.
   MMR via the Data scientist's condition-aware ladder (`src/ladder/*`). Feed ladder move shares back into
   `MetaUsage` so move costs move.
5. **Market.** Weekly budget = `spendingPerWeek`; traders list/arbitrage, completionists buy missing entries,
   others buy food/eggs; bid aggression = `riskTolerance`. Auction rules from the Economist (`src/economy/*`).
   Claude trades on a sandbox ledger only.
6. **Territory.** Territorial personas (Yanis, Karim) claim cells along their physical blocks and defend them
   in play blocks; everyone can contest cells they pass. Log claim/lost with the owner's state
   (asleep/online).
7. **Social.** Co-located co-op when two friends are at the same place in overlapping blocks (Léa+Gérard
   Sundays, Camille+Lotte Saturdays, Karim+Inès at the stall); remote co-op/trades when friends' play blocks
   overlap.
8. **Frustration detectors.** Each frustration tag maps to a detector (e.g. `empty-queue`: ranked wait > 60 s;
   `offline-territory-loss`: a cell lost while its owner is in a sleep block; `night-notifications`/
   `daytime-notifications`: a push inside a sleep block; `skill-mismatch`: |ΔMMR| > 300; `streak-break`: a
   reset streak). A detector firing = a `persona.frustration` ledger row.

### 9.2 Population: clones, jitter, weights

Run N clones per persona (e.g. 100) with seeded jitter: block edges ±30 min (keeping the no-overlap
invariant), intensity ×U(0.8, 1.2) clamped to [0, 1], skill ±0.1, diet ×U(0.7, 1.3), home ±2 km within the
city. Weight clones for population metrics by an **assumed** style share (no market data yet — Q7): casual 30
%, collector 12 %, explorer 10 %, socializer 10 %, competitor 9 %, completionist 6 %, breeder 5 %, storyteller
5 %, trader 5 %, territorial 5 %, speedrunner 3 %. Claude: exactly one instance, excluded from every
population metric.

### 9.3 Metrics the simulator outputs

| metric                | definition                                                                                                                                                                                          | why                                                                      |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| **Retention proxy**   | per clone-week: share of play blocks with ≥ 1 goal-progress event, minus 0.5 × frustration events per block; churn after 2 consecutive weeks below 0.3; report survival at weeks 1/4/12 per persona | a model of churn, not a prediction — it says WHICH frustration kills WHO |
| **MMR spread**        | SD and IQR of MMR; Spearman ρ(skill, MMR); partial correlation of spending with MMR given skill; mean \|ΔMMR\| per time band                                                                        | the ladder must measure skill, not time or money, also at night          |
| **Element diversity** | normalised Shannon entropy H/ln 14 of primaries on active teams and of ladder move elements; max single-element share; per persona: is each favourite element reached                               | catches meta collapse and F2                                             |
| **Economy inflation** | weekly Laspeyres food price index (basket = population diet); credit supply growth (sources − sinks); Gini of holdings; top-holder share per rare food                                              | sanity of prices and anti-cornering                                      |
| **Territory churn**   | ownership changes per cell per day; share of losses while the owner sleeps; median hold time for territorial clones                                                                                 | fairness to early sleepers and night workers                             |
| **Achievement pace**  | weeks to the first achievement and to each `achievementTargets`; dex completion vs `pokedexGoal`; XP/week spread (max/min persona)                                                                  | pace for Léa vs Yanis (F1), longevity for Lotte                          |

### 9.4 Acceptance criteria (for the simulator PR)

- **A1 Determinism.** Same seed → byte-identical ledger JSONL over 4 simulated weeks; seed + 1 → different.
- **A2 Schedule fidelity.** Simulated play hours per persona within ±10 % of the "play h/wk" column (8 weeks ×
  50 clones).
- **A3 Quiet hours.** Zero sessions and zero notifications inside a persona's sleep blocks.
- **A4 Physical integrity.** Physical-only experiences only in GPS blocks; zero GPS events for Claude; no
  `travelKm` credited in `physical:false` blocks (TGV, metro) or above running speed.
- **A5 Lifestyle visible.** After 4 weeks Thomas's and Camille's Genemon carry lower `rhythm` than Gérard's
  and Karim's (assert toward the weighted target of all rhythm contributors, not a fixed sign) — this
  currently FAILS for Thomas with an arithmetic `activeHour` (F3); per persona, report whether each favourite
  element became reachable (F2, F5) — a regression if the count drops.
- **A6 Ladder.** Spearman(skill, MMR) ≥ 0.7 among ladder-active human clones; |partial r(spend, MMR | skill)|
  ≤ 0.15; Claude never appears as a ranked opponent of a human.
- **A7 Diversity.** After 8 weeks of the meta loop: element entropy of ladder teams ≥ 0.75, no element > 25 %
  of picks.
- **A8 Economy.** Food price index within ±15 % of week 1 after 12 weeks; no trader cluster holds > 30 % of a
  rare food's supply (Karim's `rare-food-supplier` attempt must be capped).
- **A9 Territory.** ≤ 40 % of ownership changes happen while the losing owner is asleep.
- **A10 Retention.** Every persona's median clone survives ≥ 4 weeks under baseline rules; every frustration
  tag has a detector that fires in at least one adversarial scenario (a detector that never fires is
  unproven).
- **A11 Pace.** Every persona earns ≥ 1 achievement in week 1; nobody but Claude's sandbox reaches its
  `pokedexGoal` before week 8.

---

## 10. Open questions

- **Q1 Time zones.** All 12 live on Europe/Paris time. A global launch needs `utcOffset` (or an IANA zone) per
  persona and one non-CET persona (Montréal or Tokyo) to test cross-zone ladders.
- **Q2 Places.** `ScheduleBlock` has no `place`; activity→place is ambiguous (Yanis's `gym` is often the lake,
  Karim's `work` is a market stall). Proposal: an optional `place?: PlaceKind` once the World designer defines
  place kinds.
- **Q3 Shared devices.** Léa plays on the family tablet and on adults' phones; Sophie uses the same tablet.
  The account model needs child profiles on shared devices and a "guest on my phone" co-op session.
- **Q4 Vehicles.** TGV/metro are `physical:false` here. Should trains give passive "window" encounters at
  speed? Where exactly is the speed line between a cyclist (35 km/h, legit) and a car (cheat)?
- **Q5 Dex definition.** Proposed entry = body kind × primary × (secondary or none) = 1176; families = 84.
  Lists designer to confirm (and whether size class or pattern count).
- **Q6 Achievement ids** are provisional strings; align with `src/data/achievements.ts` when it lands.
- **Q7 Population weights** in 9.2 are assumptions; replace with real data after a playtest.
- **Q8 Staff and family accounts.** Max and Claude share a machine, Léa/Sophie and Inès/Karim share homes:
  multi-account detection must whitelist families/dev rigs; staff accounts excluded from economy and ladder
  metrics?
- **Q9 Minors and local law.** Léa (9) needs parental consent (France's digital-consent age is 15); Inès (16)
  can consent but should she trade with adults? Paid random eggs vs Belgian law (Lotte). Location of minors
  never public.
- **Q10 Max's real data.** Age 35, Paris/République and his favourite elements are placeholders — Max to
  correct.
- **Q11 `travelKm` cap** (F1), **element reachability** (F2) and **what drives `activeHour`** — sessions only,
  or awake/GPS-present hours too (F5) — are design calls for the epigenetics owner.
- **Q12 Notifications** should take quiet hours from the persona's sleep blocks (Camille sleeps by day), not
  the clock.

## 11. Next quests

1. **QP-1 Simulator v1** — `src/sim/personaSim.ts`: sessions + quiet hours + ledger rows; meets A1–A3.
   (orchestrator)
2. **QP-2 Report tool** — `tools/personas-report.ts` from the appendix logic; regenerate sections 2, 5, 6, 8
   from code and fail CI if the doc's tables drift. (orchestrator owns `tools/`)
3. **QP-3 Circular `activeHour`** (F3) in `src/genome/epigenetics.ts`, R-scaled, with a test named after it;
   then re-measure Camille (F5). (orchestrator)
4. **QP-4 Lifestyle loop** — trips, diet and experiences through `feed`/`live`/`expose`; A4–A5 and the F2
   reachability report.
5. **QP-5 Ladder + market + territory** hooked to `src/ladder/*`, `src/economy/*`, `src/world/*`; A6–A9.
6. **QP-6 Retention proxy** with one detector per frustration tag; A10–A11.
7. **QP-7 Data follow-ups** — `place` field (Q2), `utcOffset` + a non-CET persona (Q1), real achievement ids
   (Q6).

---

## Appendix — regenerating the tables

The tables above came from a throwaway script run against `src/sim/personas.ts` on 2026-10-12 (it is not in
the repo; QP-2 lands it as a tool). Its core, for anyone recomputing a number:

```ts
// presence of persona p in [from, to) over `days`: intensity-weighted hours / (band hours x days)
const presence = (p: Persona, from: number, to: number, days: number[]) =>
  days.reduce(
    (s, d) =>
      s + p.schedule.filter((b) => b.playIntensity > 0 && b.days.includes(d))
        .reduce(
          (t, b) => t + Math.max(0, Math.min(b.end, to) - Math.max(b.start, from)) * b.playIntensity,
          0,
        ),
    0,
  ) /
  ((to - from) * days.length);
// weekly play hours (optionally filtered by device / physical)
const weekHours = (p: Persona, pred = (_b: ScheduleBlock) => true) =>
  p.schedule.filter((b) => b.playIntensity > 0 && pred(b))
    .reduce((s, b) => s + (b.end - b.start) * b.playIntensity * b.days.length, 0);
// lifestyle pull: P = 7*Σ diet[f]*FOODS[f].nudge + Σ exp[e]*EXPERIENCES[e].nudge;
//   pull(e) = Σ ELEMENTS[e].signature[a]*P[a] / Σ|signature[a]|  (neutral excluded)
// mean active hour: 5-minute steps weighted by intensity*days; circular mean = atan2(Σ w·sin θ, Σ w·cos θ),
//   θ = hour/24·2π, R = |Σ w·e^{iθ}| / Σ w;  dayness(h) = cos((h − 13)/24·2π)
// F3/F5 rhythm after 28 days: Σ FOODS[f].nudge.rhythm·dietPerDay[f]·28 + Σ EXPERIENCES[e].nudge.rhythm·perWeek[e]·4
//   + dayness(mean hour)·min(1, 28/30)·0.4   (the rhythm terms of epigeneticPressure; ground/battles have none)
```
