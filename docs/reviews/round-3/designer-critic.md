# QA round 3: UI/UX designer + noob player + pro player

**Evidence examined this round.**
- **Images.** I looked at full frames and zoomed crops. Where a full-frame pass and a crop disagreed, I trusted the crop. Crop boxes are given as x0,y0–x1,y1 in image pixels.
  - `mobile-home.png`, crop 380,900–780,1688
  - `mobile-lab.png`, crop 380,800–780,1688
  - `mobile-battle.png`, crops 0,60–780,900; 0,90–780,420; 440,90–780,420
  - `tablet-battle.png`, crop 560,640–1300,1140
  - `battle-angle-auto.png`, crop 200,480–1000,900
- **Data.**
  - `manifest.json`: I script-parsed all 19 battle shots (fighter screen boxes against `viewPx`, `hudRects`, camera, ledger counts).
  - Also read: `REPORT.md`, `CHECKLIST.md`, round-1 `designer-noob.md` and `critic-pro-gameplay.md`.
  - Figures marked *(computed)* come from that script, not from eyeballing.
- **Not examined.** The review was cut short at the user's request, so I did not get to:
  - any source code, so change 4 (integrity) is **NOT JUDGED**;
  - the images listed under *Evidence gaps*.

  Every item that depends on these is marked NOT JUDGED.
- **One correction during the review.** A full-frame pass said the phone section boxes lose their right border. The zoomed crops show the border and rounded corners inset from the screen edge, so the full-frame pass was wrong.

---

## Verdicts

**UI/UX designer: REVISE, 56/100.** This is a judgement on round 1's scale, where this role gave 36.

The structural failures from round 1 are fixed:
- The phone app fits 390 px. Box borders are visible, no word is cut at the edge, and the profile chip is on screen (`mobile-home` and `mobile-lab` crops).
- Phones get a 5-tab bar with More.
- The portrait tablet stacks a 748×590 3D view above the panel (`tablet-battle.png`, manifest `viewPx`).
- Touch screens say "tap them".

The battle HUD did not adapt to the new device layouts:
- **Coverage.** The HUD covers **44.3 % of the tablet 3D view** and **35.5 % of the phone view** *(computed from `hudRects`)*. Desktop is 23.2–26.7 %, against a round-1 target of 15 %.
- **Camera buttons over the rival HUD.** The camera-button column is drawn on top of the rival column.
  - Phone (`mobile-battle` crop 440,90–780,420): `auto` covers Frosar's HP bar and `orbit` covers Nullix's.
  - Tablet: Nullix's "charge · Vol…" chip is clipped.
- **Tablet camera distance.** The tablet camera sits at **30.0 m**, against 16.9 m on desktop at the same instant, with its own `outside = 2`. Fighters there are 18–44 px.
- **Lab.** The phone Lab is unchanged since round 1 (U5).

**Noob, first 5 minutes on a phone: better, still lost inside the battle.**

What now works:
- Home says what to do: "Hello Max", a one-line pitch and one big Instant battle button (`mobile-home.png`).
- In battle I can tell mine from theirs. YOU is cyan and RIVAL is orange, and the creatures carry matching tags and rings (`mobile-battle.png`, `battle-angle-auto` crop).
- "Abandon practice battle" tells me this fight does not count.

What still loses me:
- **My creatures are tiny.** They are 18–28 px on the phone (manifest).
- **Buttons over enemy health.** The camera buttons sit on the enemy health bars.
- **Two weathers at once.** The panel says "Sunny Meadow · Clear · 13h. No modifiers." while rain pours and the overlay says "Sunny Meadow · Thunderstorm · 13h · t 5.0s". The ledger shows one `battle.weather` event, so a move changed the weather and the panel never updated.
- **Developer readouts in the player UI:**
  - the top bar shows "57 fps · 6.4 ms" on desktop and "62 fps · 4.2 ms" on tablet;
  - Home lists "Device: mobile · 10 cores · 390×844@2x".
- **The Lab is still a stat sheet.** It shows the size chip "S·1" (vision read it as "s-1"), the genome id "gm-0d43f9a2" and "stability 0,00 · animation phase cycles…". The ways to change the creature are still under the 5th and 6th tabs ("life", "breed").

**Pro player: HOLD. The integrity fixes are NOT JUDGED.**
- **Code not read.** I did not read `src/ladder/ranked.ts`, `src/ui/app.ts`, `src/combat/battle.ts`, `src/combat/team.ts` or `src/genome/phenotype.ts` this round. So I can neither clear nor confirm any of X1–X8, and I reached no formula, so I found no new formula exploit.
- **Runtime hints:**
  - The battle button now reads "Abandon practice battle" in all three battle shots.
  - The ledger records `battle.synergyLost: 1` after Leafmemon's KO (auto, tablet and mobile snapshots), so synergies now drop at runtime.
  - The miss rate at t = 5.03 s is **12 of 24 resolutions (50 %)** *(computed, ledger)*, down from 64 % in round 1.
- **Information a competitive player loses:**
  - The phone pills show only the name and an HP bar, with no phase, move or status. Desktop and tablet cards show "charge · Hydro…".
  - The panel's condition line goes stale after a weather move (finding N1), so the conditions you read are not the ones in play.

---

## Checklist (my roles: U*, B*, K*)

| Item | R1 | R3 | File judged | What I see |
|---|---|---|---|---|
| U1 | AGREE | **AGREE** | mobile-home.png | "Hello Max", the pitch line, and a full-width "Instant battle" above the fold. Desktop `01-home` not viewed. |
| U2 | DISAGREE | **AGREE** (weak) | mobile-home / -battle / -lab; tablet-battle | **Phone:** 5 plain-word tabs (Home, Arena, Team, Lab, More). **Tablet rail:** all 9 labels, Settings included. **Caveats:** inactive labels are small and grey; the Team icon is still three diamonds; the More sheet is in no shot, so Settings and Data reachability on a phone is unverified. |
| U3 | DISAGREE | **NOT JUDGED** | – | `08-settings-light` and `09-lab-light` not viewed. |
| U4 | DISAGREE | **AGREE** (layout) | mobile-home and mobile-lab crops; mobile-battle; tablet-battle | **No horizontal overflow:** borders and corners inset, no word cut. **Tablet:** 3D view 748×590 above the panel. **Text:** readable. **CAN'T TELL** whether the last panel lines scroll clear of the bottom nav; "Battles…", the Body table and "Opponent…" sit under it. HUD and size problems are scored under B1 and B5. |
| U5 | DISAGREE | **DISAGREE** | mobile-lab.png | **Order unchanged since R1:** name; "S·1"; Ice; "quadruped · Adult · Lv 26 · gen 0 · gm-0d43f9a2"; skeleton / rotate; the "stability 0,00 · animation phase cycles idle → charge → active → rest" line; then tabs overview / genome / psyche / moves / life / breed (breed wraps to a second row). **Below the tabs:** a Body table with French decimals (0,59 m, 36,6 kg, 0,25). **Framing:** the creature fills about a quarter of the 3D view. |
| B1 | DISAGREE | **DISAGREE** | manifest.json (screen boxes vs `viewPx`); REPORT.md | **Fighters out of frame** *(computed)*: in 7 of 12 auto-mode shots a living fighter's box crosses the frame edge. 7 living fighters lie entirely outside it while the camera reports `outside` = 0, 0, 1: volcano (Lucidard, Lumtusk), swamp (Tidlash), canyon (Frosmane, Ampix, Zephkite, Tidlash, which is 4 of my 5). **battle-angle-auto:** Frosar's box runs to y 905 in an 848-px view with `outside = 0`; a zoomed pass did not see it clipped, so the box may be loose. **Tablet:** `outside = 2` at 30.0 m. **Smallest living fighter:** 41 px desktop, 18 px tablet, 18 px phone (REPORT.md). Arena images not viewed. |
| B2 | DISAGREE | **AGREE** | battle-angle-auto crop; tablet-battle crop; mobile-battle | **Headers:** YOU (cyan) and RIVAL (orange) on all three devices. **Markers:** every living fighter has a matching cyan or orange tag, thin ring and bar; the KO'd Leafmemon has none. **Caveats:** two passes read every bar as full, including Tidlash at 74/250 HP (fix 4); KO feed colour by side not verified. |
| B3 | DISAGREE | **NOT JUDGED** | battle-angle-auto (HUD only) | The cards say "charge · Hydro…", "active · …" (red) and "rest · …". The `phase-*` shots were not viewed, so the in-world tell is not judged. |
| B4 | DISAGREE | **NOT JUDGED** | battle-angle-auto crop | Tinted zones are visible: a purple field over my team and a green sparkling field over theirs. The manifest has `projectiles 0` at this instant. Conduction, lightning and the arena shots were not viewed. |
| B5 | DISAGREE | **DISAGREE** | manifest `hudRects`; mobile-battle crops; tablet-battle; battle-angle-auto | **Names:** now readable everywhere; on the tablet all 9 show. **Coverage** *(computed)*: the HUD covers 23.2–26.7 % of the desktop 3D view, 44.3 % on tablet and 35.5 % on phone. **Camera column** *(computed)*: overlaps the rival column in 16 of 17 desktop shots, on tablet and on phone; on phone and tablet it visibly hides rival HP. **Truncated move names:** "Thunder …", "Hydro …", "Jet Stre…", "Vol…". **Phone pills:** no phase, move or status. |
| B6 | DISAGREE | **DISAGREE** (manifest only) | manifest.json; REPORT.md | **top:** smallest fighter 12 px, and Tidlash 83 % under the YOU column *(computed)*. **orbit-0:** Frosar's box lies entirely right of the frame, and Nullix's crosses the edge. **orbit 0/120/241:** each reports `outside = 4`. The 8 angle images were not viewed. |
| K1 | AGREE | **AGREE** (weak) | mobile-home.png | The pitch "Your Genemon evolve with your real life…" plus the real-world panel (local time, season, moon, weather of the day). `04-lab-genome` and `07-arena-setup` not viewed. |
| K2 | DISAGREE | **DISAGREE** (touch); desktop improving | battle-angle-auto; tablet-battle; mobile-battle; manifest | **Desktop:** now reads as two tagged teams of 41–115 px creatures. **Tablet and phone:** 18–50 px, and rival HP is under the buttons. **Misses:** half of all attacks miss at t = 5 s (12/24). **Captured result (seed 101):** a 5–0 wipe of my team at 19.5 s (manifest; image not viewed). |
| K3 | DISAGREE | **NOT JUDGED** | tablet-battle panel; manifest ledger | Not examined: `05-team` and `team.ts`. The tablet-battle panel reads "Synergies: Conductor, Garden, Glacier, Prism vs Resonance". It still lists all four after the ledger's `battle.synergyLost`. |

---

## Change verification (changes 1–4)

| # | Claimed change | Status | Evidence |
|---|---|---|---|
| 1a | `minmax(0,1fr)` column and shrinking chips: the phone app is no wider than the phone | **DELIVERED** at 390×844 | `mobile-home` and `mobile-lab` crops: right borders and corners inset, no word cut. The context chip ends in an ellipsis ("14:30 · afternoon · autu…"), and "Max · 1500" is visible. 360×800 not captured; CSS not read. |
| 1b | Phones: 4 tabs plus a More sheet | **PARTIAL** | The bar is Home, Arena, Team, Lab, More (`mobile-*`). The More sheet (World, Market, Ladder, Data, Settings) is in no shot. |
| 1c | Portrait tablet: 3D view at 50dvh above the panel | **DELIVERED** (battle) | tablet-battle: 3D view 748×590 of a 1180-px screen (manifest `viewPx`), panel below, rail kept. `tablet-home` and `tablet-lab` not viewed. |
| 1d | Touch wording on touch screens | **DELIVERED** | **Touch** (mobile, tablet): "Camera buttons are on the right edge of the 3D view (tap them). ⏸ pauses." **Desktop:** "(keys 1-6). Space pauses." |
| 1e | Overflow measured per region against `visualViewport` | **NOT JUDGED** (method) | REPORT.md says "none" and the manifest has `overflow: []`, which matches my crops. `tools/capture.ts` not read. |
| 2a | YOU / RIVAL headers | **DELIVERED** | All three battle shots. "RIVAL · RIVAL TRAINER" says "rival" twice. |
| 2b | Side-coloured card edges | **NOT VERIFIED** | The passes disagree on whether the edge colour shows the side, the element or the HP. A crop is needed. |
| 2c | 12 px text; status text in `--text-2` | **NOT JUDGED** | Text is readable at full size, but I did not measure it or read the CSS. |
| 2d | Cards no longer capture pointer drags | **NOT JUDGED** | Not visible in stills; CSS not read. |
| 2e | Phones: two rows of HP pills | **PARTIAL** | **Lines:** the pills wrap to 4 lines (2 per side) and end at y 127 of the 371-px view, 34 % against the R1 target of 20 %. **Overlap:** the camera column covers the right end of the rival lines. **Content:** each pill has only a name and a bar. |
| 2f | KO feed lines coloured by side | **NOT VERIFIED** | Only my own KO is on screen ("★ Leafmemon is knocked out by Vacskooze"), read as orange/red. There is no rival KO line to compare. |
| 2g | Friendly-fire conduction labelled | **NOT JUDGED** | The city-rain and lake shots were not viewed. |
| 3a | Ring + tag + HP pip, you sky blue / rival orange | **DELIVERED** (the HP pip is suspect) | battle-angle-auto and tablet crops: cyan rings and tags on mine, orange on theirs; the KO'd body is unmarked. Two passes read the pips as full on Tidlash (30 % HP), Nullix (49 %) and Vacskooze (77 %). |
| 3b | Small Genemon drawn larger in battle | **PARTIAL** | **Desktop:** auto smallest is 41 px (R1: 12–25 px; R1 floor 48 px); arenas 36–80 px. **Tablet and phone:** 18 px each (REPORT.md). |
| 3c | Compact start for small fighters | **NOT JUDGED** | Cannot be seen in stills without spawn positions. |
| 3d | Camera keeps fighters below the HUD band | **PARTIAL** | **Desktop auto:** no fighter is under a card, except in canyon (Leafmemon 16 % under the feed). **Phone:** Vacskooze is 32 % under the camera column. **Tablet:** the band ends at 60 % of the view height, and the camera backs off to 30 m with `outside = 2`. **Action shots:** they push other fighters out of frame (B1). |
| 4 | Integrity: `ranked.ts` (`rankedConditions`, `isRated`); `finishBattle` / `abandonBattle` / `startRanked`; `hitChance` with `EVASION_CAP`; the conduction chain; `HEAL_DECAY`; `dropSynergies`; `swoopUntil`; `hpFrac`; team synergies; `powerIndex` | **NOT JUDGED** | Code not read. **Runtime hints only:** the "Abandon practice battle" label; one `battle.synergyLost` event after a KO; profile MMR 1500 in every snapshot I printed, all taken before any result. |

---

## Exploits

The round-1 formulas are summarised from `critic-pro-gameplay.md`; its line numbers may have moved. Nothing below was re-attacked in code this round.

| # | R3 status | Formula (as of R1) | Abuse | Severity |
|---|---|---|---|---|
| X1 | **NOT JUDGED** | Elo against a fixed 1500; same-seed Rematch pays again; Abandon leaves no result | Pump MMR and XP; erase losses. R3 hint: the button now says "Abandon practice battle". | Critical (R1) |
| X2 | **NOT JUDGED** | Rest costs 11 energy for 30 % of max HP | Sustain loop. `HEAL_DECAY` not read. | High (R1) |
| X3 | **NOT JUDGED** | `cd = dmg·0.45·cond(o)/max(0.6,cond(t))`; no roll, defence or type | Launder super-effective hits onto wet bystanders. Per-bystander typing and the max-2 cap not read. | High (R1) |
| X4 | **Partly addressed at runtime**; code NOT JUDGED | Synergy set = primary ∪ secondary; computed once | `battle.synergyLost` now fires after a KO (ledger). Whether a single dual-type member can still unlock a pair is not checked. | Medium–high (R1) |
| X5 | **NOT JUDGED** | `hit = clamp(p − ev, …)` | Evasion fortress. `EVASION_CAP` and the multiplicative form not read. | Medium–high (R1) |
| X6 | **NOT JUDGED** | Player picks arena, weather and hour for rated fights | Condition shopping. Ranked draw by the ladder not read. | Medium (R1) |
| X7 | **NOT JUDGED** | One-way altitude check; Take Flight costs 20 energy | Flyers hit without being hit back. `swoopUntil` not read. | Medium (R1) |
| X8 | **NOT JUDGED** | `hpFrac = Σhp·slots / Σmax·slots` | Turtle one big creature to the timeout. | Medium (R1) |
| N1 | **NEW** (UI truth) | The panel's conditions line is written at setup and never updated after a weather move. Ledger `battle.weather: 1`; panel "Clear · No modifiers" vs overlay "Thunderstorm" (mobile-, tablet-battle). | Players read the wrong multipliers mid-fight. Whether a ranked result screen reuses this line is NOT JUDGED. | Low |
| N2 | **STILL OPEN** (QA gate; noted by the R1 critic) | `camera.outside` counts only the framed subjects | B1 regressions pass the gate: `outside = 0` while 7 living fighters are fully off-frame (volcano, swamp, canyon). | Medium |

---

## Blockers (my roles)

1. **The camera-button column covers the rival HUD on phone and tablet** (B5, B2).
   - It hides rival HP: Frosar and Nullix on the phone, Nullix's chip on the tablet.
   - On desktop the rectangles overlap in 16 of 17 shots. The overlap is not visible with 4 rivals; a 6-rival shot would show it.
2. **Touch-device battles** (B1, B5, K2).
   - The HUD takes 35–44 % of the 3D view.
   - Fighters are 18 px.
   - The tablet camera backs off to 30 m with `outside = 2`.

   The new layouts produced a good 3D viewport, but the HUD and the camera were not resized for it.
3. **The auto camera leaves living fighters out of frame** (B1).
   - This happens in 7 of 12 auto shots. In the canyon shot, 4 of my 5 creatures are off-screen.
   - The camera's own check reports 0, so the QA gate cannot catch it (N2).
4. **Pro role: round-1 blocker 1 (ladder and progression integrity, X1/X6) cannot be cleared.** Change 4 was not judged this round.

---

## Top 5 fixes, ranked

### 1. Move the camera buttons off the rival HUD

**Where.**
- `.view-tools`. Manifest rectangles:
  - desktop: x 845–898, y 310–539;
  - tablet: x 685–738, y 181–410;
  - phone: x 327–380, y 71–300.
- It collides with `.hud-team.right`. Both are styled in `web/styles.css` (not re-read this round).

**What.**
- On touch and narrow views, fold the six camera buttons and pause into one "camera ▾" button with a popover, placed bottom-right of the 3D view (the feed already sits bottom-left).
- On desktop, anchor the column bottom-right, or below the rival column's real bottom, so a 6-card rival stack can never reach it.

**Why.** It hides rival HP on touch devices (B5, B2). The rectangles overlap in 16 of 17 desktop shots.

**Verify.**
- `view-tools` overlaps no `hud-team` rectangle in any battle shot.
- Add a desktop shot against 6 rivals.
- A crop shows every rival bar in full.

### 2. Give each device a HUD budget, and let the camera use the space it frees

**Where.**
- The `.hud-team` rules for the stacked tablet and the phone (`web/styles.css`).
- The HUD-aware framing box in `src/render/battleCamera.ts`.

**What.**
- Give portrait tablets the phone pill treatment instead of desktop cards, which stand 343 px tall in a 590-px view.
- On phones, show one row per side, made of fixed-width pills that scroll horizontally.
- Shorten the "RIVAL · RIVAL TRAINER" header to "RIVAL".
- Cap the band at 20 % of the 3D height.

**Why.**
- Coverage is 44.3 % on tablet and 35.5 % on phone *(computed)*.
- The tablet band ends at 60 % of the view height. This is my inference for why the camera backs off to 30 m with `outside = 2` and shows 18-px fighters.

**Verify.**
- HUD coverage is at most 15 % on desktop and 20 % on tablet and phone.
- At the same instant, the tablet camera distance is within 20 % of the desktop one, with `outside = 0`.
- The smallest living S fighter is at least 40 px on tablet and 32 px on phone (REPORT.md table).

### 3. Auto camera: keep every living fighter in frame, and measure it honestly

**Where.**
- The `outside` count in `src/render/battleCamera.ts`, which covers only the framed subjects (R1 critic: lines 97-98 and 184-188).
- The manifest and REPORT generation in `tools/capture.ts`.

**What.**
- Add `outsideAll` over every living fighter.
- An action close-up may run only while the others stay at least partly in frame. Otherwise cap it at about 1.5 s and cut back to wide.
- REPORT fails any auto shot in which a living fighter's box is fully outside the frame.
- Drop the boxes of fighters with `inFront: false`. In battle-result, Frosmane is logged with `hPx` 286209.

**Why.**
- B1 fails in 7 of 12 auto shots.
- In the canyon shot, 4 of my 5 creatures are off-frame while `outside` reads 1.

**Verify.**
- `outsideAll = 0` in every auto shot, or a documented exception rule for action shots.
- Recapture canyon, swamp and volcano.

### 4. Make the battle information truthful

**Where.**
- The in-world marker update in `src/render/battleView.ts`.
- The panel in `src/ui/screens/arena.ts`.
- The feed in `src/ui/app.ts`, `onBattleEvents`.

**What.**
- Drive the pip width from `hp/maxHp` every frame. Two passes read it as full at 30 % HP.
- On `battle.weather`, update or relabel the conditions line, e.g. "Started: Clear · now Thunderstorm".
- On `battle.synergyLost`, remove the lost synergy from the panel.
- Capture one own-KO line and one rival-KO line.

**Why.**
- B2 and B5.
- The noob's "it says Clear but it's raining" moment (N1).

**Verify.**
- In a crop, pip width divided by full width is within ±10 % of `hp/maxHp` for 3 fighters.
- After a weather event, the panel text matches the overlay.
- The feed crop shows two different KO colours.

### 5. Prove the integrity fixes, then hand the formulas to a reviewer

**Where.**
- `src/ui/app.ts`: `finishBattle`, `abandonBattle`, `startRanked`.
- `src/ladder/ranked.ts`.
- `src/combat/battle.ts` and `src/combat/team.ts`.
- `src/genome/phenotype.ts`.

**What.** Run a browser probe plus unit tests:
- **Practice repeats.** Win a practice battle and press Rematch 10 times. XP, W/L and MMR change once per seed, or never for practice.
- **Ranked abandon.** Abandon a ranked battle at t = 3 s. It must record a loss and lower the rating.
- **Ranked conditions.** They equal the real hour and the ladder-drawn weather, and the player cannot choose them.
- **Hit chance.** `hitChance ≥ p·(1−EVASION_CAP)`.
- **Chain.** At most 2 bystanders, with per-bystander defence and type.
- **Heals.** The n-th heal is reduced by `HEAL_DECAY`.
- **Synergies.** `synergyLost` fires when the enabler is KO'd.

Then capture Ladder, a ranked result and the phone More sheet.

**Why.** X1 was this role's top blocker in round 1, and none of change 4 was verified this round.

**Verify.**
- The probe output and the test names appear in REPORT.md.
- A reviewer then re-attacks X1–X8 with the formulas in hand.

**Also still open from round 1, not re-ranked:**
- Lab hierarchy (U5).
- Developer readouts in the player UI: the fps chip, the Device row, the genome id and the stability line.
- The "S·1" size chip.
- French decimals in the English UI.
- Move names truncated on 250-px cards.

---

## Evidence gaps

- **Code not read (all of change 4):**
  - `src/ladder/ranked.ts`
  - `src/ui/app.ts`
  - `src/combat/battle.ts`
  - `src/combat/team.ts`
  - `src/genome/phenotype.ts`

  Also not read: `web/styles.css` (12 px, `--text-2`, `pointer-events`) and `tools/capture.ts` (how overflow and `outside` are measured).
- **Images not viewed:**
  - `01-home` through `09-lab-light`
  - every `creature-*` and `phase-*`
  - every `battle-angle-*` except auto
  - `battle-result`
  - every `arena-*`
  - `tablet-home`, `tablet-lab`
  - all `sheet-*`

  This is why U3, B3, B4 and K3 are NOT JUDGED, and why B6 rests on the manifest alone.
- **Shots that do not exist:**
  - the phone More sheet;
  - the Ladder screen;
  - a ranked battle and its result;
  - a 6-rival desktop battle;
  - a light-theme battle;
  - phone at 360×800 and tablet at 768×1024;
  - a rival-KO feed line;
  - a frame in the middle of a conduction chain.
- **Crops still owed:**
  - an HP pip at known HP;
  - a card edge colour;
  - the KO line colour.
