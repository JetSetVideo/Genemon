# Round 1: game critic, pro player and gameplay agent

**Evidence used:** `artifacts/qa/round-1/` (55 shots, 6 contact sheets, `REPORT.md`, `manifest.json`),
`artifacts/scenarios/REPORT.md` and `docs/GAMEPLAY.md`. I also read the source to check the
documented formulas: `src/combat/{battle,team,moves}.ts`, `src/genome/{phenotype,genemon}.ts`,
`src/render/battleCamera.ts`, `src/ui/app.ts` and `src/ui/screens/arena.ts`.

**Method:** I did not run any code. Numbers marked *(computed)* come from a read-only parse of
`manifest.json` or from the documented formulas. Pixel sizes are estimates from the images and
vary by about ±30% between passes. When the manifest and an image disagree, I give the manifest
figure.

**Line numbers:** outside the re-check section, `file:line` references point to the code as I
first read it. Some files have shifted since. The re-check section gives the current lines.

---

## Verdict

**For these three roles, round 1 cannot ship. 1 AGREE, 6 DISAGREE.**

The rules engine is the most original thing in the folder, and part of it is measured. Three
things still block it:

1. **The battle screen hides the systems the game advertises.**
   - A fight is over in about 12 s.
   - Most creatures are 10–35 px on screen.
   - 64% of attack resolutions in the captures are misses *(computed)*.
   - A charge looks exactly like idle.
   - The most dramatic event in the captures is an electric chain that knocks out the caster's
     own teammate. It appears only as a line of text in the log.
2. **A competitive player can break the ladder in one evening.**
   - "Rematch (same seed)" replays a deterministic win and pays MMR and XP again.
   - "Abandon battle" erases a loss.
   - AI opponents are always rated 1500.
3. **The formulas contain at least four degenerate loops:**
   - healing is priced as a fraction of max HP;
   - the electric chain carries damage past every defence;
   - synergies can be switched on by one sacrificial creature;
   - evasion is subtracted from hit chance and is not part of the power budget.

**Re-check after round 1.** Changes landed after these shots were captured. The scores below
stay as judged on the round-1 evidence. Against the current code, all 8 exploits still stand,
and X7 (flight) is now cheaper. See *Re-check against changes made after capture* below.

---

## Checklist

| Item | Score | Evidence (file) | One line |
|---|---|---|---|
| **K1** Identity distinct from Stadium / GO | **AGREE** | `04-lab-genome.png`, `07-arena-setup.png` | Opposite-pole axes with genetic vs expressed dots ("Life can bend each axis by at most ±0.5"), a real-world context chip on every screen, and arenas that default to "Weather auto / Time of day real". No Pokémon game exposes any of this. Caveat: the identity lives in the Lab and the rules. On the battle screen it reads as a generic auto-battler. |
| **K2** Want to watch or play the next battle | **DISAGREE** | `battle-result.png`, `battle-angle-auto.png`, `arena-city-rain-22h.png`, `manifest.json` | The fight lasts 12.1 s. Creatures are 15–80 px. The 9 captured battles show 141 misses vs 78 hits. The best moment (a chain KO of an ally) exists only as a log line. During the fight you can only change speed or camera, pause, or abandon. |
| **K3** Team building has real decisions | **DISAGREE** | `05-team.png`; `battle.ts:298`; `team.ts:69-74` | Slots are shown only as the number "Slots 6/6 · power 1008". Order affects only the first action (`cooldown 0.5 + 0.35·i`). One water S (Tidlash) switches on 3 of the 4 listed synergies and keeps them after it dies. Moves are picked automatically. The slot-vs-power trade-off is real but untested (SC-01 compares 4 slots with 2). |
| **B1** Auto camera keeps every living fighter on screen, unhidden | **DISAGREE** | `arena-lake-storm-21h.png`, `arena-swamp-fog-6h.png`, `arena-canyon-sandstorm-17h.png`, `arena-volcano-heatwave-15h.png`, `mobile-battle.png` | The camera's own check (`camera.outside = 1`) fails in 3 of 9 auto arena shots. In the lake shot a creature is cut off at the right edge. Volcano shows 5–6 of 10 identifiable at a distance of 37.1 m. On mobile, most creatures sit under HUD cards. `battle-angle-auto.png` alone passes (8/8 visible). |
| **B3** Tell who charges / strikes / recovers | **DISAGREE** | `phase-charge.png`, `sheet-phases.png`, `battle-angle-auto.png` | Charge has no tell: it is a neutral standing pose, identical to idle. Active is a clear lunge with a flat yellow slash plane. Rest is idle with that plane still showing. In battle the phase appears only as HUD text ("charge · Air Cutter") across 9 cards. |
| **B4** Projectiles, beams, zones, reactions visible and coloured | **DISAGREE** | `arena-lake-storm-21h.png`, `arena-city-rain-22h.png`, `arena-volcano-heatwave-15h.png`, `sheet-battle-angles.png` | Zones show and are tinted: green bloom ovals, a cream field ring, the green Overgrowth ring. One blue beam with yellow sparks is visible. Conduction (−408 chain, ally KO), lightning and heatwave have no visual. Volcano shows 1 of 4 zones. The 8-angle set froze at `projectiles 0, zones []`, so it cannot test B4. |
| **B6** Every camera mode gives a useful, distinct view | **DISAGREE** | `sheet-battle-angles.png`, `battle-angle-low.png`, `battle-angle-follow.png`, `manifest.json` | **low** is about 30–40% blocked by a prop. **follow** puts no creature at the centre or closer (29.8 m away) and has a foreground tree. **orbit-0** has the same centre and elevation as auto (0.4208 rad; 28.5 vs 29.7 m). **orbit-120 / orbit-241** show rock or tree occlusion. Only auto and top are useful. |

The B1 check is weaker than it looks. In an action shot, `outside` counts only the focused
attacker/target pair (`battleCamera.ts:97-98, 184-188`). An `outside = 0` therefore does not
prove that every fighter is in frame.

---

## Critic: identity, hooks, comparison

### What earns praise

- **The genome is visible.** The Lab genome tab (`04-lab-genome.png`) shows opposite-pole axes
  grouped by space, with a small grey dot for genes alone and a coloured dot for genes plus life.
  - No Pokémon game shows this (Pokémon keeps its IVs, EVs and natures hidden).
  - Spore never tied a creature to the player's own life.
  - This is the best idea in the build.
- **The real world feeds the combat maths, not just the backdrop.**
  - Every screen shows "14:30 · afternoon · autumn · Gale · new moon".
  - Arena setup defaults to real weather and real time (`07-arena-setup.png`).
  - Weather and hour change element multipliers (`weather.ts`, `battle.ts:364-375`).
  - This is Pokémon GO's real-world layer used *inside* the fight. Nothing else does that.
- **The spatial chemistry is real, as the log shows:**
  - "▦ ground → moss", "✦ bloom reaction" (`arena-volcano-heatwave-15h.png`)
  - "⚡ current chains to Bouldmane −408" (`arena-city-rain-22h.png`)
- **The result screen is more transparent than the genre's.** It shows per-fighter
  Dealt / Hits / Crits / KOs / HP, the MVP, reactions, the MMR delta and a note that replays are
  deterministic (`battle-result.png`).
- **Conditions read in the arena set.** Rain, snow, fog, sand and sparkles are visible, and the
  time of day reads correctly in all 8 arenas (`sheet-arenas.png`). Heatwave and wind show no
  particles.

### Where the pitch breaks

1. **"Pokémon Stadium-style" promises agency the build does not have.**
   - In Stadium you pick a move under pressure and watch a big monster perform it.
   - Here the screen says "Instant battle: your team (in attack order) against an opponent". The
     controls are speed, pause, camera and abandon.
   - That is an auto-battler (TFT / Auto Chess). It is a legitimate genre, but it has two
     requirements:
     - The pre-battle decisions must be deep. K3 says they are shallow.
     - The fight must be a spectacle. K2 and B1 say it is not.
   - Either own the auto-battler identity, or add a light command layer (for example, one "focus
     that target" or "use your big move now" call per creature every few seconds).
2. **The monster is never the star.**
   - The auto camera's distance swings from 13.6 to 37.1 m on desktop and reaches 45.0 m on tablet
     (`manifest.json`).
   - A Stadium frame gives the active monster about a third of the screen height. Here the biggest
     creature is about 80 px of 900 (`battle-angle-auto.png`) and most are 10–35 px.
   - Generative creatures are the selling point. They have to be seen.
3. **Spore's hook is authorship, and the Lab is closer to a spreadsheet.**
   - The genome tab has no tooltip, number or stat link that says what an axis does in battle.
   - The strike effect in `phase-active.png` is a flat, untextured yellow plane.
4. **The Pokémon GO half was not captured.** There is no World shot this round, so I CAN'T TELL.
   Only the context chip is visible.

### Hooks by time horizon

| Horizon | Works | Fails |
|---|---|---|
| First 10 s | Real-time chip, the genome screen | The battle reads as dots on a meadow; nothing marks the teams |
| First session | Log lines showing reactions and terrain changes; the result table | 12-s fights, two whiffs out of three, no charge tell, the chain is invisible |
| Long term | Life shapes the axes (±0.5); deterministic replays | Levelling is worth about 3× the genome (quality ×1.27 vs level ×2.3 and growth ×1.82); the ladder can be pumped (X1) |

---

## Pro player: depth, counterplay, exploits

### Decisions that are already solved

- **Power per slot** (`phenotype.ts:21-23`) *(computed)*:
  - The ranking is S 1.00, M 0.95, L 0.917, XL 0.875, XS 0.85.
  - **XS is strictly worse than S.** It uses the same slot for 15% less power, and it loses
    every contact exchange on mass ratio (`clamp(massRatio^0.1, 0.75, 1.4)`).
  - Whether the big classes earn their slots back through mass and knockback (×≤1.4 contact,
    ×≤2 knockback) is the most important balance question in the game. It was unmeasured in
    round 1: SC-01 puts a 4-slot fire brawler against 2 slots of plants that are also weak to
    fire, so its 100% result proves nothing about slot pricing.
  - After capture, the orchestrator reports **XL vs 4 small at equal slots = 28%**, even with the
    new 50% cleave. The big classes do not earn their slots back. I did not re-run this.
- **Order** (`battle.ts:261, 298`):
  - The only effect is `cooldown = 0.5 + 0.35·i` on the *first* decision. After about 2.25 s
    order no longer exists.
  - Order also sets each creature's spawn lane, which no screen mentions.
  - The one order choice that is not trivial is weather. `setWeather` overwrites, so the last
    caster wins. Its default 14 s lasts most of the 15.1 s median fight. The correct play is
    therefore to put your weather-setter *after* the opponent's.
  - Calling it the "attack order" (`05-team.png`) oversells it.
- **Moves:** there are no move choices. `learnset()` picks 4 moves, with at most 1 utility move
  (`genemon.ts:57-95`). Competitive play becomes steering the learnset through breeding.
- **Opponent:** the pick is blind. There is no team preview in `07-arena-setup.png`. The only way
  to counter-pick is the same-seed Rematch, which is exploit X1.
- **Grind vs genes** (`phenotype.ts:299`):
  - Genetic quality spans ×0.88–1.12.
  - Level 40 gives ×2.3, and growth from 0 to 1 gives ×1.82.
  - The VISION pillar "Conditions over levels" holds only because the player also chooses the
    conditions (X6).

### Exploits and degenerate strategies

The formulas below are taken from the code; file:line references are given for each.

| # | Severity | Name | Enabling formula | What a pro does |
|---|---|---|---|---|
| X1 | Critical | Rematch / abandon MMR and XP pump | `delta = round(24·(score − E))`, `E = 1/(1+10^((opp − mmr)/400))`, with `opp = 1500` for rival, wild and mirror (`app.ts:317-321`); `xp += 60` per member per win (`battle.ts:1303`); Rematch reruns the same seed (`arena.ts:48`); Abandon calls `closeBattle()` with no result (`arena.ts:21-24`) | Play at 3×. Abandon anything that looks lost. After a win, keep pressing Rematch. MMR rises to about **2169** in about 315 clicks, where `round(24(1−E))` reaches 0 *(computed)*. XP is unbounded: level 16 is 27,000 XP, or 450 wins. |
| X2 | High | Rest loop: healing priced as a fraction of max HP | heal cost `= 40 × fraction` (`moves.ts:242`), so Rest costs **11 energy for 30% of max HP** (`moves.ts:123`); heal `= maxHp × 0.3` (`battle.ts:687`); the 2.2 s cycle uses **5.0 energy/s**, below the minimum regen of 7/s (`phenotype.ts:291`) | An L with 1000 HP heals 300 HP per cast (27 HP per energy). For comparison, Body Slam costs 25 energy for 60 power. Below 40% HP the AI heals readily, since heal utility is `(1−hpF)²·3.2` (`battle.ts:500`). A Rest creature effectively gets +30% max HP every 2.2 s. |
| X3 | High | The electric chain ignores every defence and hits allies | Each wet or in-water body within 4.5 m takes `cd = dmg × 0.45 × cond(o)/max(0.6, cond(t))`. There is no hit roll and no bystander defence, type or evasion (`battle.ts:905-916`). In rain, storm or acid rain, every non-fire, non-burrowed fighter is wet (`battle.ts:1017`) | Hit the weakest target in a wet cluster. The primary hit's type multiplier (up to ×4) and crit (×1.6) carry onto every neighbour at 45%: type 2 × crit 1.6 × 0.45 = **1.44× a neutral direct hit on each bystander**, whatever its resistances. Fire teammates never get wet in rain, so electric plus fire is safe from its own chain. Evidence: "⚡ current chains to Bouldmane −408"; "Zephkite is knocked out by Ampix", and both are on team 0 (`arena-city-rain-22h.png`, manifest). |
| X4 | Medium–high | Synergy battery | The synergy set is primary ∪ secondary of all members (`team.ts:69-74`), so one dual-type creature unlocks a pair alone. Synergies are computed once and folded into stats at construction (`battle.ts:249, 256-258`), so they **survive the enabler's KO**. Stat synergies multiply every member. | Add a 1-slot water/X or shadow/void creature as a sacrifice. Water appears in 3 of the 9 pairs. Evidence: "Conductor, Garden, Glacier, Prism vs none". Water S Tidlash is the water member these three need; it finishes at 0% (`battle-result.png`), and by construction they stay on. |
| X5 | Medium–high | Evasion fortress (unbudgeted, subtractive evasion) | `hit = clamp(p − ev, 0.05, 0.99)`, `ev = evasion·(evasive?2:1) + (evasive?0.1:0)` (`battle.ts:448-451`); `evasion ≤ 0.25` from tempo and small size, and it is **not** in `powerIndex = sqrt(hp·(1+def/120)·atk·rate)` (`phenotype.ts:250-252, 293`); Abyss ×1.25 and Guardian ×1.15 apply team-wide; Night Veil gives 6 s of evasive for 23 energy | 0.25 × 1.4375 × 2 + 0.1 = **0.82**, so attackers with p 0.75–0.95 hit **5–13%** of the time *(computed)*. Upkeep is 3.8 energy/s. Tempo also gives speed (2.2 to 6.0 m/s) for free; focus gives accuracy and crit for free; vitality gives regen for free. For those stats the opposite poles are not trade-offs. |
| X6 | Medium | Condition shopping | The player picks arena (10), weather (12 or auto) and hour (real, 6, 9, 13, 18, 21, 0) for a battle that moves MMR (`arena.ts:69-77`, `app.ts:321`). | Storm: electric ×1.35 vs fire ×0.7, a **1.93×** relative swing. Eclipse at night: shadow ×1.3·1.1 vs light ×0.75·0.9 (`weather.ts`, `battle.ts:369-375`). Lake ground conducts at 1.6 vs stone at 0.7. Pick the home field every time. |
| X7 | Medium | Flight asymmetry | Ground melee cannot hit a flyer above `reach + height`, where `flyAlt = 1.8 + 0.9·h`, and ground-tagged moves cannot hit flyers at all (`battle.ts:424-428, 701`). A flying melee attacker is checked only on the ground plane (x and z, ignoring height) (`battle.ts:584-587`). Upkeep is 35 energy per 8 s plus 1.5/s ≈ 5.9/s, against regen of 7–14/s. | An all-avian team against melee or quake teams can hit without being hit back. Evidence: Zephkite finishes airborne at 250/250 (`battle-result.png`); SC-04 landed 0 of 18 quakes. The AI rarely uses this: only 2 of 11 snapshots of a living avian show it flying. |
| X8 | Medium | Timeout double-weighting | `hpFrac = Σ hp·slots / Σ maxHp·slots` (`battle.ts:1238-1249`). HP already scales with the slot budget, and the formula multiplies by slots again. | In the lake team, Bouldlash L holds **63%** of its team's timeout score with 50% of the slots *(computed)*. Combined with X2 and X5, a team can turtle one big creature to the 90 s timeout. |

### Rules where the documentation and the code disagree

- **Resonance.**
  - GAMEPLAY says "≥ 2 members, one shared primary".
  - The code requires *every* member to share one primary (`team.ts:90`).
  - Evidence: the meadow opponent had two void primaries (Vacskooze, Nullix) and got "none".
- **Forgeheart.** The tooltip says "+8% fire and earth damage". The code boosts fire only
  (`team.ts:63`).
- **Meta tax floor.** The lower clamp of 0.8 can never be reached; the minimum is 0.925 at zero
  usage (`moves.ts:248`). Popular moves are taxed by up to +25%, while unused moves get only
  −7.5%.
- **"Attack/initiative order"** (`05-team.png`). In the code, order is only the first-action
  stagger plus the spawn lane.

### What the scenario report does not prove

- **SC-01:** unequal slots plus a type advantage, so it cannot validate slot pricing.
- **SC-06:** with n = 120 the confidence interval spans [42, 60], too wide to detect a 5-point
  side bias. It also records a 15.1 s median duration, which this review treats as a problem in
  its own right.
- **No scenario covers** Rest sustain, chain friendly fire, evasion stacking, synergies after KO,
  the timeout rule, or equal-slot big-vs-small fights.

---

## Gameplay feel: what the shots show

### Pace and whiffs

- The meadow battle ends at **12.1 s**. SC-06 gives a median of 15.1 s and a p10 of 9.4 s.
- Each creature therefore acts about 4–8 times, and the 90 s cap never matters.
- Miss rate over the 9 captured battles is **141 of 219 resolutions (64%)** *(computed from
  ledger deltas)*.
  - It ranges from 45% (meadow, clear, 13h) to 84% (lake, storm, 21h).
  - By formula, the hit chance before projectile physics is `p − ev`, about 0.4–0.7. Whiffs are
    built in.
- With two misses in three, and nothing on screen to show the miss, the fight reads as
  creatures twitching while HP bars move.

### Phases

- **Charge:** indistinguishable from idle (`phase-charge.png`). This is the "readable tell" in
  GAMEPLAY §5, and it is missing.
- **Active:** reads clearly as a lunge.
- **Rest:** idle with the strike plane still visible.
- In battle there is no in-world phase cue, only per-card HUD text.

### Effects

- Zones read and are tinted by element.
- Beams read at best occasionally (one blue beam with yellow sparks, in city-rain).
- The three most consequential events have no visual:
  - **conduction:** a −408 chain and a friendly-fire KO;
  - **lightning:** no bolt in the lake storm;
  - **KO:** knocked-out bodies look like living ones in city-rain.
- Volcano shows 1 of its 4 zones.
- The crit and KO lens effects exist in code (`battleView.ts:117-128`):
  - slow-motion for 0.45 s and 0.7 s;
  - an FOV punch of 7° and 5°;
  - trauma shake.

  No shot catches them, so I CAN'T TELL whether they land.

### Camera

- **The distance multiplier ratchets outward.** `distK` grows by 60%/s whenever a framed subject
  is outside the box and shrinks by only 15%/s otherwise (`battleCamera.ts:189`).
  - The auto camera therefore parks near its 1.8× ceiling: meadow 29.7 m, volcano 37.1 m,
    city 32.8 m, tablet 45.0 m. Creatures shrink to 5–25 px.
  - The HUD cards are not treated as off-limits screen space. On mobile, most creatures are
    under them (`mobile-battle.png`).
- **low and side never lift for occlusion** (`battleCamera.ts:172`). That is why the low view is
  blocked by a prop.
- **follow** stays about 30 m out, half-way toward the lead creature. No subject reads.

### Sides and roles

- Nothing in the world marks the teams; the mapping exists only in the left/right HUD columns
  (all battle shots).
- Avians fight on the ground in 9 of 11 living snapshots. Zephkite stands in ground mode on
  `deepWater` in the lake. Flight is underused.

---

## Re-check against changes made after capture

The orchestrator reported these changes after round 1 was captured. I re-read the current code;
I re-ran nothing. Scores stay as judged on the round-1 evidence.

| Change | Effect on this review |
|---|---|
| Type chart: every element has equally many 2× strengths and weaknesses | X3 does not depend on chart balance. Any super-effective hit still carries ×2 onto every wet bystander at 45%. |
| Status-weighted costs (`STATUS_WEIGHT`), beam premium ×1.2, tempo factor 0.45 → 0.3 | **Rest** is still 11 energy (heal is still `value × 40`, `moves.ts:276`). **Night Veil** is still 23 (evasive weight 1). **Take Flight** drops from 35 to **20** (airborne weight 0.5), so flight upkeep falls from 5.9 to **4.0 energy/s** *(computed)*. X7 got cheaper. |
| Melee uses the surface gap plus a 0.9 m lunge; unreachable melee options are skipped | `canReach` still checks altitude in one direction only (`battle.ts:439-442`). X7 stands. |
| Bodies of 3+ slots cleave 50% damage in a 60° arc | The reported 28% for XL vs 4 small confirms the per-slot table: smalls still win at equal slots. "XS is strictly worse than S" stands (same slot, −15% power). |
| `PACE = 0.6` on every HP change; median about 21 s | Heals (`battle.ts:732`), hits (`:900`) and chains (`:958`) all scale by the same factor, so the ratios behind X2 and X3 are unchanged. A longer fight gives Rest more casts. 21 s is still below the 30–45 s I ask for in fix 3. |
| Auto camera cuts between wide and action shots | The distance ratchet (`battleCamera.ts:189`), the `outside` count over the framed subjects only (`:184-188`), and low/side skipping the occlusion lift (`:172`) are unchanged. The causes of the B1 and B6 failures remain in the code; a re-capture is needed. |

**Exploit status in the current code:**

| # | Status | Where it lives now |
|---|---|---|
| X1 MMR/XP pump | **Stands** | Opponent rated 1500 (`app.ts:330-334`); Rematch (`arena.ts:48`); Abandon (`arena.ts:21-24`); XP +60 per win (`battle.ts:1355`) |
| X2 Rest loop | **Stands** | Cost `heal × 40` (`moves.ts:276`); heal `maxHp × value × PACE` (`battle.ts:732`) |
| X3 Chain laundering | **Stands** | `cd = dmg × 0.45 × cond(o)/max(0.6, cond(t))` with no roll, defence or type (`battle.ts:958`); fire never wet in rain (`:1065`) |
| X4 Synergy battery | **Stands** | primary ∪ secondary set (`team.ts:71-72`); computed once (`battle.ts:263`) |
| X5 Evasion fortress | **Stands**, but the current AI does not reach it | `clamp(p − ev, …)` (`battle.ts:462-465`). Shadow measures 22%, which suggests the AI rarely casts Night Veil. The exploit becomes real once buffs are used, by a better AI or a command layer. |
| X6 Condition shopping | **Stands** | Player-chosen arena, weather and hour still move MMR |
| X7 Flight asymmetry | **Stands, and is cheaper** | One-way altitude check (`battle.ts:439-442`); Take Flight now 20 energy |
| X8 Timeout double-weighting | **Stands** | `hp × slots` (`battle.ts:1295-1296`) |

**New balance numbers (reported by the orchestrator, not verified here):**

- **Fire at 65%** sits on the edge of the band. Two hypotheses to test first, both from the code:
  - fire is the only element that never gets wet in rain, so it is immune to chains in rain
    (`battle.ts:1065`);
  - fire is the only element with two damage-pair synergies (Bellows and Forgeheart).
- **Shadow at 22%** shows that its evasion package (Night Veil, Abyss) is not being used. Once
  it is, X5 makes shadow too strong, not too weak. Fix the evasion formula *before* buffing
  shadow's numbers.

---

## Blockers (for these roles)

1. **Ladder and progression integrity (X1).**
   - Same-seed Rematch pays a win again and again.
   - Abandon removes losses.
   - AI opponents are rated a fixed 1500.
   - The player chooses the conditions (X6).

   Until this is fixed, every MMR and level number is meaningless.
2. **Battle legibility.**
   - The auto camera fails its own framing check in 3 of 9 arena shots, and it keeps creatures
     at 5–80 px.
   - Charge has no tell.
   - Conduction and friendly fire are invisible.

   The core promise, chemistry happening in space, cannot be seen.
3. **Degenerate formulas (X2, X3, X5).** They have to be fixed before any balance measurement
   (SC-06 parity, slot pricing) means anything.

---

## Top 5 fixes, ranked

### 1. Close the MMR/XP pump

- **What:**
  - Rematches and battles against rival, wild or mirror opponents become unranked: MMR delta 0,
    and XP is awarded once per seed.
  - Abandon after t > 0 counts as a loss.
  - Ranked conditions are drawn by the server, not picked.
- **Where:** `src/ui/app.ts` `finishBattle` (lines 307-331); `src/ui/screens/arena.ts`, lines 21-24
  (Abandon) and line 48 (Rematch).
- **Why:** X1 and X6 make MMR and level free. Every downstream number, including the planned
  condition-aware ladder, inherits the corruption.
- **Verify:**
  - In a browser probe, win once and press Rematch 10 times. MMR and every member's XP must be
    unchanged after the first result.
  - Abandon at t = 3 s: `profile.stats.losses` goes up by 1.
  - Add a unit test that `finishBattle` against "rival" returns delta 0.

### 2. Make the auto camera frame every living fighter at a readable size, with the HUD treated as off-limits

- **What:**
  - Count `outside` over **all** living fighters, not just the focus pair.
  - Shrink the camera's usable frame by the HUD-card rectangles so creatures are framed in the
    uncovered area.
  - Replace the asymmetric `distK` ratchet with a framing distance computed directly from the
    projected bounds.
  - Set a minimum on-screen height for the smallest fighter.
  - Let low and side run the occlusion lift.
  - Make follow 6–10 m behind the lead creature.
- **Where:** `src/render/battleCamera.ts`, lines 97-98, 172 and 184-189.
- **Why:** B1 and B6 fail. This is also the K2 and identity failure: the generated creatures are
  the product, and they are dots.
- **Verify:**
  - The manifest adds a per-fighter `screenPx` and an `outsideAll` field.
  - In all 9 arena shots plus tablet and mobile: `outsideAll == 0`, and the smallest living
    fighter is at least 48 px at 1440×900.
  - Re-capture `sheet-battle-angles.png`. Low must have no prop covering more than 10% of the
    view.

### 3. Fix the degenerate formulas

- **What:**
  - **Heals:** price them on absolute HP relative to the class budget, and add a per-fight
    diminishing return.
  - **Chain:** roll hit chance and apply defence and type for each bystander, cap at 2 bystanders
    with falloff, and clamp the `cond(o)/cond(t)` ratio to 1.
  - **Evasion:** make it multiplicative (`p·(1−ev)`), cap the total at 0.35, and fold evasion,
    speed, accuracy, crit and regen into `powerIndex`.
  - Once whiffs are no longer forced, retune time-to-kill toward a 30–45 s median.
- **Where:** `src/combat/moves.ts:242`; `src/combat/battle.ts:448-451` and `905-916`;
  `src/genome/phenotype.ts:250-252` and `285-302`.
- **Why:** X2, X3 and X5 dominate composition. Until they are fixed, parity numbers measure the
  exploit, not the design.
- **Verify:** add scenarios with n ≥ 1000 and Wilson intervals:
  - **SC-07:** Rest tank vs an equal-slot striker team, win rate between 40% and 60%.
  - **SC-08:** electric in rain vs a mixed team; damage per energy within ±20% of the other
    elements.
  - **SC-09:** Abyss + Guardian + Night Veil; the opponent's hit rate stays at or above 25%.
  - Capture miss rate across the 9 arenas at or below 40%, and SC-06 median duration at or
    above 30 s. With `PACE = 0.6` the reported median is about 21 s.

### 4. Put the phases and reactions in the world

- **What:**
  - A **charge tell**: a crouch or rear-back, an element-coloured glow that builds up, and a
    ground marker on the target or area for moves with power ≥ 70.
  - **Team rings** under every fighter.
  - **Conduction arcs** drawn between chained bodies, with a distinct friendly-fire marker and
    the log line "⚡ friendly fire".
  - A **lightning bolt**, a **KO pose or fade**, and a **"MISS" pop**.
- **Where:** `src/render/animator.ts`, `src/render/fx.ts`, `src/render/battleView.ts` (the event
  switch).
- **Why:** B3 and B4 fail. The game's unique layer, spatial reactions, shows only in a 4-line log.
- **Verify:**
  - Pixel-diff `phase-charge` vs idle; the difference must exceed a set threshold.
  - Freeze a frame mid-chain in `arena-city-rain-22h` and ask vision a colour-named question
    ("are cyan arcs visible between the wet creatures?").
  - Capture one KO and one crit frame. The manifest gets `slowmo > 0` and `fovPunch > 0` at
    capture time.

### 5. Make team building a real decision

- **What:**
  - Recompute synergies from **living** members, and require two *different* members per pair.
  - Show slot pips on the team cards, and show synergies that are "one element away".
  - Either give order an effect that lasts (for example, extend the existing Formation combo so
    each slot follows up on the previous slot's target), or rename it "initiative".
  - Re-price slots. `POWER_BUDGET` deliberately makes big creatures *less* efficient per slot
    (XL 0.875), and the reported 28% for XL vs 4 small says that is the wrong direction. Six
    bodies also take six times the actions. Raise the L and XL budgets until XL vs 4 S is about
    50%.
  - Fix the Resonance and Forgeheart texts.
- **Where:** `src/combat/team.ts` lines 63, 69-74 and 90; `src/combat/battle.ts` lines 249,
  256-258 and 396-403; `src/ui/screens/team.ts`.
- **Why:** K3 fails. Two of the three advertised levers (order, synergies) are shallow or solved,
  and the third (slots) is unmeasured.
- **Verify:**
  - Add a unit test: KO the only water member mid-battle and assert that Conductor disappears
    from `teamMult`.
  - Add a scenario "slot parity" with n ≥ 1000, type-neutral elements and equal levels:
    - XL vs 4 S;
    - 6 S vs XL + 2 S;
    - 3 M vs 6 S.

    Every pairing must land between 40% and 60%.
  - Re-capture `05-team.png` showing the pips and the inactive synergies.
