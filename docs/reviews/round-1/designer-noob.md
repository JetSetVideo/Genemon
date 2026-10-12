# QA round 1: UI/UX designer + noob player

**Evidence.** I used the full-size PNGs in `artifacts/qa/round-1/`, plus `manifest.json` and `REPORT.md`. The contact sheets were only for finding my way around: several things I read on a sheet turned out different at full size. Phone and tablet PNGs are 2x captures (780x1688, 1640x2360). I also read `web/styles.css`, `src/ui/**`, `src/render/battleCamera.ts`, `src/render/labView.ts` and `tools/capture.ts`.

**Code lineage.** The source tree already contains the changes made after round 1 (the HUD 30 % cap and the broadcast camera). File:line references point at the current tree; the images show the round-1 build. Each finding says whether a change made after round 1 plausibly addresses it:
- ✅ likely fixed
- ◐ partly fixed
- ✖ not addressed

## Verdict

**REVISE. Not shippable on phones or portrait tablets. Round-1 score 36/100 against a pass line of 90.**

- **What works.** The desktop shell is calm and consistent, the dark theme mostly reads well, and Home has one unmistakable call to action.
- **Phones.** On a 390-px phone the whole app is laid out about 500 px wide. Lines are cut mid-word and section boxes lose their right border. The profile chip, the Data and Settings tabs, every camera button and the right half of the opponent HUD are off-screen. `REPORT.md` still says "Horizontal overflow: none" because its check cannot see this.
- **Portrait tablets.** At 820 px they fall through to the desktop three-column grid. The 3D view becomes a 378x1128 px strip, and the HUD cards are too narrow to show fighter names.
- **Battle.** I confirm both first-pass findings:
  - fighters are 12-25 px specks on every device;
  - the HUD covers about a quarter of the desktop frame and two-thirds of the phone frame;
  - nothing in the 3D view says which side a creature is on.
- **Noob.** A new player gets exactly one obvious action (Instant battle), then a wall of jargon and developer telemetry.
- **Changes made since round 1:**
  - The camera director and the 11 m team start can plausibly fix creature size.
  - The HUD compaction can plausibly fix desktop coverage.
  - None of them touches the phone or tablet layout, contrast, or side identification.
  - The phone CSS still forces each HUD column to 48 % (`web/styles.css:182`), so the new 30 % cap never reaches phones.

## Checklist

| Item | Score | File judged | What I see | Changed since R1 |
|---|---|---|---|---|
| U1 | AGREE | 01-home.png (+ tablet-home, mobile-home) | The full-width orange "⚔ Instant battle" is the first thing the eye hits, above the fold on all three devices. Nothing says what a Genemon is, which creature is mine, or that battles play themselves. | n/a |
| U2 | DISAGREE | 01-home.png (nav rail crop), mobile-home.png | Labels are plain words but 11 px grey. ◎ World, ⚖ Market, ∿ Data and ❖ Team read as target, law, audio and gems. On the phone only 7 of 9 tabs are on screen: Data and Settings are missing. | ✖ |
| U3 | DISAGREE | 01-home.png, 08-settings-light.png, 09-lab-light.png | No invisible body text. Element chips are white text on the element colour; computed from the CSS, that is 1.3:1 for Electric, 1.4:1 for Ice and Air, 1.1:1 for Light. The Home "Boosted: Air" and Lab "Ice" chips look washed out. Light-theme muted text #6b778c is 4.0:1 on #eef1f6 and 4.2:1 on #f4f6fa. The 3D scene stays dark in Light. | ✖ |
| U4 | DISAGREE | mobile-home, mobile-battle, mobile-lab, tablet-battle, tablet-home | The phone layout is wider than the screen. These lines are cut: "…nocturnal ones are dro", "(keys 1-6). S", "…Leafmemon, Zeph", "…active → re". Section borders are missing, and the profile chip, Data, Settings and camera buttons are off-screen. The tablet gets a 378-px-wide 3D strip, and 6 of the 8 readable HUD cards show no name. | ✖ (tablet may get worse) |
| U5 | DISAGREE | 02-lab-overview, 09-lab-light, mobile-lab | Identity is on top (Frosmane · S·1 · Ice · quadruped · Adult · Lv 26) but diluted by "gm-0d43f9a2" and "stability 0,11 · animation phase cycles…". The default tab is 22 read-only rows. Every way to change the creature is behind the 5th and 6th lowercase tabs ("life", "breed"), which look like the skeleton/rotate toggles. | ✖ |
| B1 | DISAGREE | battle-angle-auto (+ manifest camera), tablet-battle, mobile-battle | Desktop: the engine reports 0 fighters outside the frame and none behind terrain, but bodies are 12-25 px and I could find only 7 bodies for 8 living fighters. Phone: the right ~110 px of the 3D canvas is off-screen (estimate), and about two-thirds of the rest is under cards. | ◐ |
| B2 | DISAGREE | battle-angle-auto, mobile-battle | Nothing in 3D marks a side (no team ring, name tag or HP pip), and the HUD columns are not labelled You / Rival. Feed lines are coloured by the move's element, not by side, and every KO line is red, including enemy KOs. | ✖ |
| B5 | DISAGREE | battle-angle-auto, tablet-battle, mobile-battle | Desktop: the HUD covers about a quarter of the frame (no fighter under it at this instant). Text is 10-11 px, status text is grey at about 3.5:1 over the meadow, and the "S"/"M" size chip looks like a keyboard hotkey. Phone: cards cover about two-thirds of the 3D height and are cut off. Tablet: cards are too narrow for names. | ◐ desktop only |

## The orchestrator's first pass

**(a) The HUD covers a large part of the 3D action: CONFIRMED, and worst on phones.**
- **Desktop (battle-angle-auto).** Card stacks, feed, meta line and camera column cover about 23-30 % of the 908x848 px view. The top ~28 % band is 55 % covered.
  - In the 8 desktop angles, no fighter is under a card at this instant. Today the HUD costs framing, not occlusion.
  - But `battleCamera.ts:182-189` still checks |NDC| < 0.85 against the full frame, so a fighter on the far corners of the arena can still land under a card.
- **Phone.** Two columns at 48 % each cover about two-thirds of the 3D height, edge to edge, and the right column is cut off by the overflow.
- **Tablet.** The event feed spans the whole 358-px strip.
- **Changes since R1 ◐.**
  - The compaction should fix desktop.
  - Phones keep `.hud-team{width:48%}` (`styles.css:182`).
  - On the tablet strip, the new 30 % cap gives cards of about 107 px, so names will disappear completely unless fix 2 lands.

**(b) Creatures are tiny: CONFIRMED on every device.**
- **Observed body heights:**
  - desktop: 12-25 px, about 2-3 % of the 3D height;
  - tablet: 10-30 px;
  - phone: 30 px at most, and mostly hidden.
- **Why, from the manifest.** Camera distances are 29.7 m on desktop, 45.0 m on tablet and 15.6 m on phone. The tablet camera is that far because a 0.33-aspect strip forces it back. That gives roughly 27-32 px per metre, and Frosmane is 0.59 m tall.
- **Changes since R1 ◐.**
  - Starting teams at 11 m should scale wide shots by about 18/11 ≈ 1.6x. That makes an S creature roughly 30 px at 1440x900, which is still under the 48-px floor I would set.
  - Action shots should do better.
  - Round 2 must measure both shot types.

## The noob's first 5 minutes

**0:00, Home (01-home).** The biggest thing on screen is a dark void with a small striped animal on a blue disc. Nobody tells me its name or that it is mine. The top bar says:
- "14:30 · afternoon · autumn · Gale · new moon". Is it windy outside? It is not.
- "0 fps · 0.0 ms". Is the game frozen?
- "Max · 1500". I never typed a name, and what is 1500?

**0:20.** The orange "⚔ Instant battle" is obviously the thing to press, and it is what I click first. On the way I skim:
- "Your Genemon evolve with your real life…". What is a Genemon?
- "Device: laptop · 10 cores". Why does a game show me my CPU?
- "Diurnal". No idea.
- A pale "Air" chip I can barely read.
- "Your team · 6/6 slots" above five cards. Where is the sixth?
- A grey "S·1" that I read as "$-1". The automated reader transcribed it that way too. Do I owe money?

**0:40, battle (battle-angle-auto).**
- It looks like a meadow seen from a helicopter, with specks on it. Nine cards fill the top corners and a log runs up the bottom left.
- I look for an attack button and there is none. The panel only explains camera keys, so after about 10 s I work out that it plays itself.
- I cannot match the names on the left to any speck.
- "💥 Nullix is knocked out by Ampix" is red, so I assume something bad happened to me. It was the enemy.

**1:10, result.** "Victory!" appears in the side panel, not in the arena; the arena keeps showing specks by a pond. The big button says "Rematch (same seed)". What is a seed? Pressing it replays exactly the same fight.

**2:00, Team (05-team).** I want to swap a creature.
- There is no empty slot or "+".
- The same five names appear twice, once as slot tiles and once as "Attack order".
- The only controls are tiny ↑ ↓ ✕.
- Clicking a collection card reveals an "Add to team" box higher up the panel, and then "Not enough slots".

**3:00, Lab (02).** A wall of numbers: Density 1125 kg/m³, Elasticity 0,25, Phase speed x1,03. I want to feed or train my creature. Nothing on screen tells me that lives under the tab "life".

**4:00.**
- World and Market say "Integration pending … src/world/worldmap.ts - quest W1 in docs/QUESTS.md". I take it from the code; these screens were not captured. It reads as a broken game.
- Data shows a log of my own clicks.

**5:00, phone (mobile-*).**
- Text runs off the right edge and there is no Settings tab.
- The battle is a stack of cards over a strip of grass.
- The help line tells me to press keys 1-6 and Space, on a phone.
- I quit.

**Summary.**
- **Clicked first:** Instant battle.
- **Most confusing:** which creatures are mine, and whether I am supposed to do anything.
- **Would not understand:** seed, MMR, power, slots that cost more by size, the synergy names, S·1, genome/psyche, "phase".

## Blockers

1. **The phone layout is wider than the phone (U4, B1, B5).**
   - Text is cut mid-word, and Settings, Data and the profile chip are unreachable.
   - The camera buttons and half the opponent HUD are off-screen.
   - The camera frames fighters into the hidden strip.
   - ✖ No change since R1 touches this.
2. **Portrait tablets get the desktop grid (U4, B5).**
   - The 3D view is a 378-px strip.
   - Fighter names are missing on 6 of the 8 readable cards, and creatures are about 15 px.
   - ✖ Not addressed, and the 30 % HUD cap probably makes the names worse here.
3. **A newcomer cannot see the fighters or tell them apart (B1, B2, B5).**
   - Fighters are 12-25 px specks.
   - There are no side markers in 3D or on the HUD, and the feed and KO colours mislead.
   - ◐ The camera director, the 11 m start and the HUD compaction target size and coverage. Side identification and a measured size floor are not addressed.

## Top 5 fixes, ranked

### 1. Phone: stop the app being wider than the phone, and make the QA gate catch it

**Where.**
- `web/styles.css:172-178`: on mobile, `#app{grid-template-columns:1fr}`, and `#nav` with 9 × `.nav-btn{min-width:52px}`.
- `web/styles.css:59`: `.chip{white-space:nowrap}` on the context and profile chips.
- `src/ui/screens/arena.ts:18`: the help text.
- `tools/capture.ts:68`: the overflow metric.

**What.**
- Set `grid-template-columns:minmax(0,1fr)` and `#topbar>*{min-width:0}`.
- Let `#context-chip` truncate with an ellipsis, or show only "14:30 · Gale" under 480 px. Keep the profile chip visible.
- Bottom bar: 5 tabs (Home, Arena, Team, Lab, More), with a More sheet for World, Market, Ladder, Data and Settings. Nine 52-px tabs plus gaps need 508 px and cannot fit in 390.
- On touch screens (`(pointer:coarse)`), replace "keys 1-6 / Space" with touch wording.

**Why.**
- The top bar is the one grid item in that column that does not scroll, and its chips cannot shrink. `1fr` means `minmax(auto,1fr)`, so the column very likely widens to the top bar's minimum width of about 500 px.
- The panel, nav, viewport and HUD then all lay out past the screen edge.
- The camera's aspect ratio is measured on that wider canvas, so the director frames fighters into a strip the player cannot see.
- `capture.ts:68` compares `scrollWidth` with `innerWidth`. Mobile emulation probably widens `innerWidth` along with the content, so the check reported 0.

**Verify.**
- Recapture `mobile-*` at 390x844 and 360x800.
- `getBoundingClientRect().right` must be at most `visualViewport.width` for `#topbar`, `#viewport`, `#panel` and `#nav`.
- `#panel.scrollWidth` must be at most `#panel.clientWidth`.
- Every section shows its right border and no line is cut.
- All 9 destinations are reachable in 2 taps or fewer, and the camera buttons are visible.

**Changed since R1:** ✖

### 2. Portrait tablets: stack the 3D view above the panel

**Where.** `web/styles.css:164-186`. The tablet rule only narrows the columns (`--panel-w:370px; --nav-w:72px`). Stacking starts at `max-width:760px`, so portrait devices from 768 to 1180 px get a 3D strip.

**What.**
- Apply the stacked grid for `(max-width:760px), (orientation:portrait) and (max-width:1180px)`.
- Tablets can keep the left rail, with the 3D view at about 50dvh above the panel.
- Size the HUD columns with a container query on `#viewport` instead of `min(30%,250px)`.

**Why.**
- In tablet-battle, 6 of the 8 readable cards show no name.
- The camera sits at 45 m because the horizontal field of view is about 17°.
- tablet-home and tablet-lab show the creature in a 330-378 px column that is about two-thirds empty void.

**Verify.** Recapture `tablet-*` at 820x1180 and 768x1024. Then check:
- the 3D view is at least 700 CSS px wide;
- every card shows the full name;
- an S fighter is at least 40 px tall.

**Changed since R1:** ✖. The new 30 % cap makes this more urgent.

### 3. Battle: fighters big enough to see, framed clear of the HUD

**Where.**
- `src/render/battleCamera.ts:156-189`: distance is computed from the subject radius and the field of view, `distK` runs from 0.75 to 1.8, and the readability box is |NDC| < 0.85 over the full frame.
- `src/render/battleView.ts`: the fighters' display scale.

**What.**
- Make the readability box HUD-aware: exclude the card columns, or use `camera.setViewOffset` to push the frame centre below them.
- Add a size floor: an S fighter at least 6 % of the 3D height in WIDE shots and at least 15 % in ACTION shots.
- If the 11 m start does not reach the floor, add a battle display scale (×2 for XS/S, ×1.5 for M, physics untouched) or shrink the play area.
- Keep the 1.4 s minimum between cuts (already in the code) so a noob is not whiplashed.

**Why.** This is the main reason a newcomer cannot follow the fight (finding b).

**Verify.**
- Have the capture write into `manifest.json` each fighter's on-screen box (head and feet through `camera.project`) and the HUD rectangles.
- Assert a minimum fighter height of 48 px at 1440x900 in both shot types.
- Assert zero overlap between fighter boxes and HUD rectangles across all 8 camera angles.

**Changed since R1:** ◐. The director and the 11 m start address size. The HUD-aware box, the floor and the measurement are still missing.

### 4. Battle HUD: say who is whose, readable at a glance, light on phones

**Where.**
- `src/ui/app.ts:334-345` (`buildHud`), `:365-394` (`hudLoop`) and `:280-305` (`onBattleEvents`: feed colour comes from the move's element, and every KO is `#ff4d6d`).
- `web/styles.css:137-155`:
  - `.fcard` text is 11 px;
  - `.ph` and `.st` are 10 px;
  - `.st` uses `--text-3`;
  - `.fcard{pointer-events:auto}` has no handler.
- `web/styles.css:182` (`.hud-team{width:48%}` on mobile) and `:101` (the `.size` chip styled like a keycap).
- `src/render/battleView.ts`: in-world markers.

**What.**
- Add "YOU" / "RIVAL" column headers in two team colours. Reuse the same colours as a ground ring plus a name and HP pip over each fighter in 3D.
- Colour feed lines by side: enemy KO in gold or green, own KO in red.
- Use at least 12 px text, with status text in `--text-2`.
- Remove the size chip from the HUD, or write it as "size S" with a tooltip.
- On phones, replace the two 48 % stacks with two rows of HP pills taking at most 20 % of the 3D height, tap to expand.
- Set `.fcard{pointer-events:none}`. Today the cards block orbit drags over two-thirds of the phone view.

**Why.** B2 fails outright, B5 fails on all devices, and the noob's first question ("which ones are mine?") has no answer on screen.

**Verify.**
- Recapture the battle on all three devices.
- The HUD covers at most 15 % of the 3D area on desktop and at most 25 % on phones.
- Every name is visible.
- Chip and status text reach a contrast of at least 4.5:1.
- 5-second test: someone who has not played names their creatures from a still.

**Changed since R1:** ◐. The desktop compaction landed; phones, side marking and text sizes did not.

### 5. Contrast, and a theme that actually switches

**Where.**
- `web/styles.css:100` (`.el{color:#fff}`), `:36` (light `--text-3:#6b778c`) and `:69` (`#viewport{background:#000}`).
- `src/render/labView.ts:34-38`: the background and pedestal colours are chosen from `dark` in the constructor only.
- `src/ui/app.ts:176-180`: `showLab` reuses the existing view instance.
- `src/ui/app.ts:107-119`: `updateSettings`.

**What.**
- Pick each element chip's text colour by luminance: `#111` on Ice, Air, Electric, Light, Neutral and Metal (Ice goes from 1.4:1 to 13.8:1). Set an `--el-ink` variable next to `--el` in `elChip()` and `buildHud()`.
- Change light-theme `--text-3` to about `#5b6678` (5.1:1 on #eef1f6).
- On theme change, rebuild or recolour the active Lab or Genospace 3D view, and drive the `#viewport` background from a theme variable.

**Why.** U3 fails, and the element chips are the game's colour language on Home, Team, Lab and the HUD.

**Verify.**
- Recapture 01, 08 and 09, plus Home and a battle in the light theme.
- Run a computed-contrast or axe pass in the capture with 0 failures on `.el`, `.muted`, `.st` and `.kv dt`.

**Changed since R1:** ✖

## Other observations

### What the changes since round 1 must prove in round 2

| Change since R1 | Plausibly fixes | Will not fix, or new risk | Round-2 check |
|---|---|---|---|
| HUD compacted (30 % cap, smaller cards, empty status lines hidden, phase badge truncates, feed limited to 4 lines) | Desktop coverage, finding (a). The round-1 feed showed 6 lines. | Phones still get 48 % per column (`styles.css:182`). In the tablet strip, cards would be about 107 px, so names and move names truncate to nothing. "Smaller cards" must not mean text under 11 px. | HUD area %. Names visible on every card at 1440, 820 and 390 px. Minimum font size. |
| Broadcast director (cuts between WIDE and ACTION) | Creature size in action shots, and a sense of who is hitting whom. | WIDE still uses the full-frame box. Cuts can disorient a new player. On phones it frames into the off-screen part of the canvas until fix 1 lands. | Capture both shot types. Measure fighter heights on screen and fighter/HUD overlaps. |
| Teams start ~11 m apart | Wide-shot scale, about 1.6x larger. | An S fighter is still only about 30 px (estimate), under the 48-px floor. | Measured fighter heights. |

### Next fixes (6-10), none addressed by the changes since R1

6. **Separate the player UI from developer telemetry.**
   - Move behind a Settings → Developer switch:
     - the fps chip ("0 fps · 0.0 ms" on Home reads as frozen);
     - the "Device: laptop · 10 cores" row;
     - the genome id;
     - the "stability … animation phase cycles" line;
     - the Data ledger ("…AI coding sessions").
   - World and Market should say "Coming soon" without `src/world/worldmap.ts - quest W1` (`later.ts:20, 28, 55`). World, Market and Ladder were not captured.
   - Label "Right now (real world) · Weather of the day: Gale" honestly. It is a deterministic daily pick (`realworld.ts:68-71`), not real weather.
7. **Lab hierarchy (U5).**
   - Order the panel as an identity card (name, element, kind, level, one plain sentence), then the main actions (Feed, Train, Breed) on the overview tab, then the stats collapsed.
   - Make the tabs a real segmented control, not `btn small` like the toggles.
   - The hero framing shows the creature at only 15-20 % of the 3D height, over a large empty void (02, tablet-lab).
8. **Arena setup (07).**
   - At 1440x900, "⚔ Start instant battle" is below the fold, after 10 text-only arena cards (`arena.ts:89`). Make it sticky at the bottom of the panel.
   - Preview the selected arena in the 3D view; today it shows the same lone creature on a void.
9. **Result screen (battle-result).**
   - The primary gradient button is "↻ Rematch (same seed)", which replays an identical deterministic battle. Make "New battle" primary.
   - Move the anti-cheat footnote (`arena.ts:48-55`) out of the player UI.
   - The battle end has no moment in the 3D view. `.banner` exists in the CSS (`styles.css:156`) but nothing uses it, and on phones the "Victory!" panel sits below the 3D view.
10. **Navigation and copy.**
    - Use 5 main destinations and clearer icons (map pin, shopping bag, bar chart, group). Nav labels should be 12 px in `--text` (`styles.css:64`).
    - Home says "Your team · 6/6 slots" above 5 cards, with no hint that Ampix (size M) takes 2 slots.
    - "S·1" reads as "$-1" (`widgets.ts:19`).
    - The English UI uses French decimals ("12,1 s", "0,59 m") because `fmt()` uses the browser locale (`dom.ts:43`).
    - Team shows no "add" button until a collection card is selected (`team.ts:59-61`), and the "TEAM" badge is 9 px.
    - On phones and tablets, touch targets are about 24 px against a 44-px guideline. This covers the `btn small` buttons: camera, speed, lab tabs, and the team ↑↓✕.

### Evidence gaps (CAN'T TELL in round 1; add these shots in round 2)

- Light theme: Home, a battle (white `--hud` cards over a bright arena), Team.
- World, Market and Ladder on desktop and phone.
- Phone: Team, Arena setup, Result, and Settings (to check it can be reached).
- Other sizes: 768x1024 portrait, 1180x820 landscape, 360x800, and a 1366x768 laptop.
- A desktop battle against 6 opponents. By my estimate, 6 opponent cards with status lines reach the camera buttons, which are centred vertically.
- Keyboard focus states.

### What works (keep it)

- The app shell is consistent and the dark theme is calm.
- Home's call-to-action hierarchy is right.
- The phase badge colours work: charge yellow, active red, rest grey.
- KO'd fighter cards grey out clearly.
- The result screen works: "Victory!" leads, the table reads, the next actions are visible.
- In the light theme, Settings controls still look like controls.
- 0 console errors, and the app is fully offline.

### QA tooling notes

- `REPORT.md`'s "Horizontal overflow: none" is wrong for the phone shots (see fix 1).
- The desktop FPS line ("60.5 fps, 1599.0 ms CPU/frame") contradicts itself.
- The contact sheets misled me twice. For example, the sheet suggested the light theme only changed the panels, but at full size the top bar and nav are light too. Judge legibility from the full-size PNGs only.
