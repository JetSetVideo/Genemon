# Genemon — security, anti-cheat and privacy

> **Summary (read this first)**
> 1. Today nothing protects a player's local data from that player: localStorage, devtools and the bundle are all theirs. Local cheating only cheats yourself (accepted). The online design never trusts the client.
> 2. Once online, the targets are ownership, credits, territory, the ladder, and **people's real-world location**. The worst attacks are GPS spoofing, bots, wash trading, seed grinding and stalking. The answers are server authority, deterministic re-simulation, GPS plausibility checks and coarse location sharing.
> 3. `src/net/` implements and tests the primitives: envelope integrity, replay window, rate limits, a prototype-pollution guard, battle re-simulation, GPS checks and travel cooldowns. None of it is wired in yet. Deleting any one control makes a test fail (24/24 in a mutation check).
> 4. Privacy is the largest real-world risk. GPS trails and lifestyle data (diet, gym, activity hours) are GDPR personal data, partly health-adjacent. Raw coordinates never enter the ledger (tested), others see only ≥ 500 m cells, a DPIA comes before launch, and minors get no location sharing.
> 5. Real money or NFTs would turn every bug into a payout and trigger France's JONUM regime (ANJ declaration, ID and age checks, no minors) plus AML rules. Default answer: **no**.

Related: `docs/NETWORK.md` (architecture, message catalogue, pipeline), `src/net/protocol.ts`, `src/net/antiCheat.ts`, `tests/net_test.ts`.

---

## 0. Scope, method, limits

- **System modelled.** The current local build (`src/core`, `src/genome`, `src/economy/market.ts`, `tools/serve.ts`, `tools/build.ts`, `web/index.html`) and the target online architecture in NETWORK.md. When this was written, `main.ts` and the UI code did not exist yet. Attacks on them (localStorage profiles, `__GENEMON__`) come from the project brief and are marked **unverified**.
- **Threat actors in scope:**
  - **T1** a cheating player with full control of their device: devtools, edited bundle, emulator, GPS spoofer.
  - **T2** a bot farmer running many accounts headlessly.
  - **T3** colluding players: wash trading, boosting, account sharing.
  - **T4** a network attacker: MITM in the LAN phase, cross-site WebSocket hijacking.
  - **T5** a malicious content author: crafted import JSON, crafted names.
  - **T6** a stalker using game data to find a person.
  - **T7** a compromised dependency.
- **Out of scope:** stolen unlocked devices, nation-state attackers, hosting-provider insiders (until hosting exists).
- **Method.** Asset register → trust boundaries → STRIDE per boundary → attack scenarios → one decision each (mitigate / accept / eliminate / transfer) with an owner → controls with status and the test that fails without them.
- **Status vocabulary.**
  - **lib**: implemented in `src/net` with a passing test, not yet wired into a runtime path.
  - **deployed**: observed live in the current build's code or config.
  - **planned**: designed but not built.
  - **unverified**: claimed by another module or the brief, not checked here.
- **This is a design-level threat model, not a penetration test, a scan, or a compliance attestation.** All three are still needed before Phase 3 (§8, S12).

## 1. Asset register

| ID | Asset | Lives in (today → target) | Data class | The loss that matters |
|---|---|---|---|---|
| A1 | Profile & progress (Genemon, items, credits, xp) | localStorage → server event store | integrity-critical once shared | fraud |
| A2 | Genome identity & ownership ("NFT-style" provenance) | `gm-xxxxxxxx` 32-bit ids → server registry | integrity-critical | fraud (duplicated or forged rare genomes) |
| A3 | Credits, listings, escrow | `src/economy/market.ts` (local) → market service | financial-like | fraud |
| A4 | Territories | world module → world cell shards | integrity | fraud (claimed without presence) |
| A5 | Ladder / MMR, battle results | `src/ladder` → battle service | integrity | fraud (boosting, forged wins) |
| A6 | Precise location history (GPS fixes) | device → server anti-cheat buffer (72 h) | personal, highly sensitive | **disclosure** (stalking, home address) |
| A7 | Lifestyle inside Genemon `conditions` (diet, gym, night walks, `activeHour`, exposure) | localStorage → server | personal, health-adjacent | disclosure (habits, schedule) |
| A8 | Social graph & presence | presence/social services | personal | disclosure (who meets whom, when you are out) |
| A9 | Accounts, sessions | auth service | secret | disclosure (takeover) |
| A10 | Ledger & ML datasets (`artifacts/*.jsonl`) | local → server exports | analytics | corruption (poisoned models); disclosure if coordinates leak |
| A11 | Availability (gateway, world tick, auction timers) | servers | availability | unavailability |
| A12 | Build & supply chain (bundle, npm three, `deno.lock`) | `dist/` | code integrity | corruption (malicious bundle) |

## 2. Trust boundaries

| ID | Boundary | What crosses | What authenticates the crossing | What the receiver assumes unchecked (today) |
|---|---|---|---|---|
| TB1 | Player ↔ own browser runtime (devtools, extensions, edited bundle) | everything | nothing: the player owns the device | that localStorage and memory are honest |
| TB2 | Imported files → app state (profile/genome/replay import; JSONL fed back to AI sessions) | JSON | nothing | well-formed, no `__proto__`, sane size and depth |
| TB3 | Device sensors → game (Geolocation API, clock) | lat/lon/accuracy, time | the OS (spoofable) | that position and time are real |
| TB4 | Client ↔ server (target) | envelopes over WSS | TLS + session cookie; `expectFrom` binds `from` to the session | nothing: full pipeline (NETWORK.md §4) |
| TB5 | Peer ↔ peer (LAN phase) | relayed envelopes | **nothing yet** (the hash is not authentication) | that the relayed `from` is genuine → device signatures (S6) |
| TB6 | Service ↔ service | internal RPC | private network + mTLS (planned) | that callers are internal |
| TB7 | Ledger → `artifacts/` → ML / AI coding sessions | JSONL rows | nothing | that rows are true and free of personal data |
| TB8 | npm registry → bundle | three.js (+ dev-only playwright) | pinned versions + `deno.lock` integrity hashes | that the pinned package is benign |

## 3. STRIDE per boundary

| Boundary | Spoofing | Tampering | Repudiation | Information disclosure | Denial of service | Elevation of privilege |
|---|---|---|---|---|---|---|
| TB1 | n/a | edit storage/memory/bundle (H1, H2) | no server log exists today | – | – | call internals via globals (H2) |
| TB2 | forged "other player's" genome | prototype pollution (H4), NaN/huge numbers (H5) | – | crafted names → XSS (H14) | deep or huge JSON freezes the tab (H17) | pollution flips flags app-wide (H4) |
| TB3 | GPS spoofing (H6) | clock games for offline progress (H12) | – | – | – | physical rewards without moving |
| TB4 | forged `from`; WebSocket hijack; shared accounts (H10) | edited body (hash); replay (H7); forged result (H11) | ledger row per decision (`net.reject`…) | location relayed to others (§6) | floods, oversize, deep JSON (H17) | client-computed prices or results (H5, H11) |
| TB5 | forged relayed identity | relay edits and re-hashes | no non-repudiation without signatures | peers learn IPs | relay drops inputs → lockstep stalls | – |
| TB6 | rogue service | – | – | – | cascading failure | lateral movement |
| TB7 | – | forged local rows (H13) | – | raw coordinates in exports (control tested) | flood evicts evidence from the 20 000-row ring buffer (H17) | – |
| TB8 | typosquatting | compromised version | – | – | – | code execution in every client |

## 4. The hacker's attack list against the CURRENT local build

Each item gives the **entry → path → precondition → impact**, then the **decision (owner)**, then the **controls (status)**. Scenarios name the route, not a weapon.

**H1 — localStorage profile tampering.** Entry: DevTools → Application → Local Storage, or any script on the origin. Path: edit credits, levels or genomes, then reload. Precondition: none. Impact: locally you cheat yourself; online, forged progress would reach battles and the market *if* the server trusted client state.
Decision: **accept locally** (owner: orchestrator). An HMAC key or encryption key shipped in the bundle is extractable in minutes, so no client-side secret can protect data from the device owner. **Eliminate online** (owner: network): the server rebuilds state from validated events (`genemon.sync`) and never accepts client snapshots. Imports must still validate bounds so a corrupted profile cannot crash the app.
Controls: planned.

**H2 — Devtools globals (`__GENEMON__`).** Entry: the console. Path: call exposed mutation functions or read internal state. Precondition: the global exists. The brief says so, but grep found no `__GENEMON__` in `src/` or `web/` at the time of writing (**unverified**). Removing the global is obscurity, since breakpoints reach every closure.
Decision: **accept** in dev builds. Production builds expose read-only snapshots or nothing, behind a build flag (owner: orchestrator). Online, server authority makes the global harmless.

**H3 — CSP gaps.** Observed in `tools/serve.ts`: `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'` plus `nosniff`. That is strong: no inline script, no eval, no third-party origins. Gaps:
- **(a)** The CSP exists only as a dev-server header, and `web/index.html` has no `<meta http-equiv="Content-Security-Policy">`. A `dist/` served by any other static host runs without CSP.
- **(b)** `form-action` does not fall back to `default-src`; set it to `'none'`.
- **(c)** No Trusted Types (`require-trusted-types-for 'script'`, Chromium) to close `innerHTML` sinks.
- **(d)** Missing companion headers: `Referrer-Policy: no-referrer`; `Permissions-Policy: geolocation=(self), camera=(), microphone=(), payment=()`; `Cross-Origin-Opener-Policy: same-origin`; `Cross-Origin-Resource-Policy: same-origin`; HSTS once on TLS.
- **(e)** Phase 2 needs an explicit `wss://` origin in `connect-src`.
- **(f)** CSP does not stop exfiltration by navigation. It is a seatbelt, not a vault.

Decision: **mitigate** (owner: orchestrator).
Controls: CSP header **deployed** (dev server only); the rest planned (S2).

**H4 — Prototype pollution via imported JSON.** Entry: an imported profile, genome or replay file, later any JSON from peers. Path: the file contains `{"__proto__": {...}}` or `constructor.prototype`. `JSON.parse` is safe (it creates an own key), but a recursive merge or `Object.assign` into live state walks into `__proto__` and writes to `Object.prototype`. Every object in the app then inherits attacker properties: flipped defaults, broken invariants, XSS gadgets. Precondition: a naive deep-merge of untrusted JSON. Impact: local corruption; online, shared replays or genomes become a worm vector.
Decision: **mitigate** (owners: network for the guard, orchestrator for import).
Controls:
- `findForbiddenKey` rejects `__proto__` / `constructor` / `prototype` at any depth, and `seal` and `verifyEnvelope` enforce it (**lib**).
- `canonicalJSON` refuses non-plain objects (**lib**).
- `ActionThrottle` keeps rules in a `Map`, so an action named `"constructor"` cannot resolve through a prototype (**lib**).
- Planned: imports validate and then *rebuild* from whitelisted fields (never merge). Dictionaries keyed by user data use `Map` or `Object.create(null)`. Optionally `Object.freeze(Object.prototype)` at boot, tested with three.js.

**H5 — Price and amount manipulation.** Entry: console, storage, or crafted market messages. Path: NaN, negative, fractional or huge (`1e308` → `Infinity`) amounts. Classic: `if (price > balance) reject` is *false* for NaN, so the purchase passes and `balance − NaN` poisons every later check. A negative quantity becomes a refund. Impact: online, minted credits.
Decision: **eliminate online** with server authority and integer credits; **mitigate in code** by validating `Number.isSafeInteger`, `> 0` and `≤ cap` everywhere (owners: economist, network).
Controls:
- `market.ts` checks `Number.isInteger(n) || n < 1 || n > MAX_CREDITS` at the call site seen. The rest of the file was not reviewed (**unverified**).
- Per-type body validators are planned (NETWORK.md N1).

**H6 — GPS spoofing.** Entry: Chrome DevTools location override, Android mock-location apps, emulators, jailbroken iOS, or an edited bundle. Path: report fixes at a gym, supermarket or territory without going there, or hop between cities. Precondition: none today. Impact online: free physical-only rewards (`gymTraining`, `travelKm`, `rescue`, territory) and territories stolen from honest locals.
Decision: **mitigate**; it cannot be eliminated (owners: network; world designer for reward caps).
Controls (**lib**, tested):
- `gpsPlausible` flags teleports (> 350 m/s after subtracting both accuracy radii), timestamps going backwards, mock accuracy (< 1 m, e.g. 0) and malformed fixes. TGV and plane speeds are refused but *not* flagged.
- `physicalPresence` requires ≥ 2 fixes over ≥ 10 s, the latest one inside, the whole accuracy disc inside, dwell speed ≤ 7 m/s and no teleport in the 5-min track. A future-dated or malformed fix voids the whole set.
- `travelCooldownMs` + `ActionThrottle` make consecutive physical actions obey a distance-based cooldown (≈ 30 min per 100 km, capped at 2 h), logged as `anticheat.throttle`.

Planned: decisions made server-side only over server-received fixes, diminishing returns, daily caps, a coarse IP-geolocation cross-check, and native attestation later (Play Integrity / App Attest; it raises the bar, but rooted devices still pass).
**Residual, stated plainly:** a careful "joystick" spoofer emulating walking speed and plausible jitter cannot be told apart from a real walker using browser GPS alone.

**H7 — Replay attacks.** Entry: capture a valid message (a proxy on your own device, or a peer in the LAN phase). Path: resend `market.bid`, `world.claim` or `battle.result`. Impact: double actions.
Decision: **mitigate** (owner: network).
Controls: nonce cache per sender with TTL ≥ 2 × skew, a ±30 s skew window, nonces recorded only after the hash verifies, and `expectFrom` so another session's envelopes are refused (all **lib**). The envelope hash as idempotency key in handlers is planned.

**H8 — Bots and farming.** Entry: the game is a web page, so any automation drives it. Playwright is *already* a dependency in `deno.json` (for screenshots); headless Chrome, console scripts, or importing the pure modules directly also work. Path: 24/7 catching, breeding, sniping and ladder farming. Impact: economy inflation, ladder pollution, load.
Decision: **mitigate** (owners: network, data scientist, economist).
Controls:
- `TokenBucket` per session and account, logging O(log n) rows per flood (**lib**).
- `ActionThrottle` daily caps, logged as `daily-cap` (**lib**).
- Planned: diminishing returns and behavioural signals from the ledger (inter-action timing entropy, 24/7 activity, reaction-time floors, identical decision sequences across accounts). Also device/IP account clustering, with challenges on anomaly only. `navigator.webdriver` is trivially spoofed and is not a control.

**H9 — Wash trading.** Entry: two accounts controlled by one person, or colluders. Path: pass an item back and forth at inflated prices to fake price history, launder credits or pump an "NFT" before dumping it on a real player.
Decision: **mitigate** (owners: economist, network).
Controls: `market.ts` `washTradeSignals()` and a median clamped to list price (**unverified**, other owner); fees make round trips costly. Planned: related-party detection (shared device, IP or payment), excluding related-party trades from price history, holding periods for new accounts, and trade-graph cycle detection.

**H10 — Account sharing, boosting, "walk for me".** Path: a stronger player climbs your ladder, or someone else carries your phone. Decision: **mitigate** (owner: network). Planned: one active session per account; impossible-travel checks between sessions (`gpsPlausible` / `travelCooldownMs` on session locations); passkey device binding; terms of service.

**H11 — Seed grinding and forged battle results.** Entry: today the client picks the seed *and* runs the battle. Path: simulate thousands of seeds offline and keep the wins, or report a result without fighting.
Decision: **eliminate for ranked**; **accept for local** (owners: network, orchestrator).
Controls: `deriveBattleSeed` with commit-reveal plus a server salt (**lib**), `verifyBattleClaim` re-simulation (**lib**), and team commitments before the reveal (planned).

**H12 — Clock manipulation.** Path: move the device clock forward to fast-forward hunger, ageing or cooldowns, or back to repeat dailies. Impact: local only, once the server clock is authoritative.
Decision: **accept locally**, **eliminate online** (owner: orchestrator).
Controls: `TokenBucket`, `NonceCache` and `ActionThrottle` never refill or reset when time goes backwards (**lib**, tested). Note: `src/genome/genemon.ts` `log()` falls back to `Date.now()` when `ctx.when` is missing. That breaks house rule 1 and makes ledger rows non-replayable (S3).

**H13 — Ledger poisoning of ML datasets.** Entry: local ledger rows are unsigned client data. Path: forged rows (fake wins, fake lifestyles) reach datasets or AI coding sessions. Impact: biased MMR or outcome models and misleading AI feedback.
Decision: **mitigate** (owner: data scientist). Planned: anything that matters trains only on server-verified rows, with a provenance tag (`client` vs `server-verified`).

**H14 — XSS via player-controlled strings.** Entry: Genemon names, player names, imported files, and later other players' data. Path: rendering with `innerHTML`. Precondition: an unescaped sink. None was found by grep at the time of writing, but the UI is still being built (**unverified**). Impact online: stored XSS leading to session theft or automated trading.
Decision: **mitigate** (owner: orchestrator). Use `textContent` only, plus Trusted Types. The deployed CSP already blocks inline script, which limits the blast radius.

**H15 — Genome id collisions.** `genomeId()` (`src/genome/genome.ts`) folds alleles into a **32-bit** id and is documented as "the basis of the NFT token id". By the birthday bound there is a 50 % chance of a collision among ≈ 77 000 genomes, and anyone who can craft genomes can grind a collision with a chosen id in ~2^32 cheap hashes (minutes).
Decision: **mitigate** (owner: orchestrator). Keep `gm-` ids for display; network identity = `hashCanonical(genome without id)` (SHA-256).
Controls: planned (S4).

**H16 — Cross-engine float drift → false accusations.** Path: outcome code depending on `Math.sin/exp/log/pow…` resolves differently on Safari and Firefox than on the server's V8, so honest claims fail re-simulation and lockstep desyncs.
Decision: **mitigate** (owners: orchestrator, network). The server's result is truth and a mismatch alone is never punished; see the determinism contract (NETWORK.md §5.1) and lint (N8).

**H17 — Denial of service through data.** Path: huge or deeply nested JSON (import or network) overflows the stack or freezes the UI; floods evict evidence from the 20 000-row ledger ring buffer.
Decision: **mitigate** (owners: network, orchestrator).
Controls (**lib**): `MAX_DEPTH` 32, `MAX_BYTES` per type, `verifyEnvelope` never throws on bad input, `TokenBucket` logs at the 1st/2nd/4th/8th… denial, and throttle logs only spoofing/farming signals. Planned: a raw frame cap before `JSON.parse`, an import size cap (~1 MB), and a dedicated `new Ledger("security", 50_000)` (S13).

**H18 — Supply chain.** Observed: `deno.json` pins exact versions (`three@0.180.0`; `playwright@1.56.1` dev-only), and `tools/build.ts` refuses remote imports in the bundle. A `deno.lock` with integrity hashes appeared in the repo root during this session, untracked.
Decision: **mitigate** (owner: orchestrator). Commit `deno.lock`, keep three.js as the only runtime dependency, review three upgrades, and keep playwright out of the bundle.
Controls: pinning **deployed**; lockfile planned.

## 5. Controls register

| Control | Code | Mitigates | Status | Test that fails without it (`tests/net_test.ts`) |
|---|---|---|---|---|
| Canonical JSON (sorted, strict, JCS-compatible, round-trip safe) | `canonicalJSON` | hash ambiguity (H7, H11) | lib | "canonicalJSON sorts keys…", "…rejects values that would make two different inputs share a hash" |
| Envelope integrity hash | `seal`, `verifyEnvelope` | tampering in transit/storage | lib | "seal -> wire -> verifyEnvelope accepts; tampering…" |
| Sender binding | `verifyEnvelope({ expectFrom })` | spoofing, H7 | lib | same test (forger case) |
| Clock-skew window | `verifyEnvelope` | H7 | lib | "stale and future envelopes are rejected…" |
| Replay cache; TTL ≥ 2×skew; recorded after hash | `NonceCache` + `verifyEnvelope({ nonces })` | H7 | lib | "nonce replay is detected…", "…replays caught across the whole skew window; forgeries burn nothing" |
| Size and depth limits | `MAX_BYTES`, `MAX_DEPTH` | H17 | lib | "oversize envelopes are rejected…", canonicalJSON rejection test |
| Prototype-pollution guard | `findForbiddenKey` (+ `seal`, `verifyEnvelope`) | H4 | lib | "schema, version, type and prototype-pollution checks…" |
| Fail-loud options (NaN `now`/skew/bytes) | `verifyEnvelope` | silent fail-open | lib | "stale and future envelopes…" |
| Rate limit + logarithmic flood logging | `TokenBucket` | H8, H17 | lib | "token bucket limits bursts…", "security ledger: …" |
| Battle re-simulation + domain-separated claim hash | `verifyBattleClaim`, `battleClaimHash` | H11 | lib | "server re-simulation accepts honest claims…", "battleClaimHash is stable and sensitive…" |
| Fair seeds | `deriveBattleSeed` | H11 | lib | "server re-simulation…" |
| GPS plausibility | `gpsPlausible` | H6 | lib | "gpsPlausible rejects teleports, mock accuracy and time travel…" |
| Presence proof | `physicalPresence` | H6 | lib | "physicalPresence needs >= 2 consistent recent fixes…" |
| Travel cooldown, cooldowns, daily caps | `travelCooldownMs`, `ActionThrottle` | H6, H8, H10 | lib | "travel cooldown grows…", "ActionThrottle enforces…" |
| No raw coordinates in ledger rows | `antiCheat.ts` row builders | A6 disclosure | lib | "anti-cheat ledger rows never contain raw coordinates" |
| Coarse location for others | `coarsenLocation`, `geoCellId` | A6, stalking | lib | "coarsenLocation moves points at most ~cellMeters…" |
| CSP header | `tools/serve.ts` | H3, H14 | deployed (dev server) | none yet (S2) |
| Pinned deps, no remote imports in bundle | `deno.json`, `tools/build.ts` | H18 | deployed | build-time check in `tools/build.ts` |
| Integer credits, escrow, wash signals | `src/economy/market.ts` | H5, H9 | unverified (other owner) | `tests/market_test.ts` (not reviewed here) |
| Server authority, sessions, Origin check, idempotency, body validators | – | H1, H5, H7, H10 | planned | – |

**Mutation evidence.** Each *lib* control was deleted one at a time in a scratch copy, and the suite failed every time (24/24). So these tests detect the control's *absence*, not merely its presence.

## 6. Privacy: real-world location and lifestyle data (GDPR; the operator is in France)

### 6.1 What is personal here
- **Location:** GPS fixes and everything derived from them (home/work cells, routines, visited places). Visits to clinics or places of worship can reveal Art. 9 special categories *by inference*.
- **Lifestyle:** `conditions` (`src/genome/epigenetics.ts`) records diet (supermarket purchases), experiences (`gymTraining`, `swimming`, `nightWalk`, `travelKm`), hours per ground, and **`activeHour`** (mean local hour of activity). A Genemon is therefore a fingerprint of its owner's habits, and diet plus exercise are health-adjacent. Showing a raw Genemon to others (battles, market listings, NFT metadata) shows those habits.
- **Social and device data:** the friend graph, presence (when you are out), device identifiers, IP addresses, account email.

### 6.2 Data map and retention (target)

| Data | Collected when | Visible to | Retention |
|---|---|---|---|
| Raw GPS fixes | `world.move` in physical mode only, never in the background | server anti-cheat only | 72 h buffer, then deleted (aggregates only) |
| Coarse cell (≥ 500 m) | `presence`, opt-in | friends | while online |
| Home area | opt-in, manual pin | friends | until changed; coarsened (≥ 500 m, larger in sparse areas) |
| Ledger rows | every action | the player (export), server, pseudonymised analytics | account lifetime; GPS-free by construction |
| Genemon conditions | play | owner in full; others see a summary (level, elements, stage) | account lifetime |
| Security rows (`net.*`, `anticheat.*`) | rejections, suspicious events | security staff | decide (suggest ≤ 12 months) |

### 6.3 Legal bases (validate with counsel; this is not legal advice)
- **Gameplay location processing:** performance of contract (Art. 6(1)(b)), only while the player uses physical mode.
- **Anti-cheat on location and behaviour:** legitimate interest (Art. 6(1)(f); fraud prevention, Recital 47), with a documented balancing test and short retention.
- **Opt-in extras** (location sharing with friends, home area, ML on personal data beyond what is necessary): consent (Art. 6(1)(a)), withdrawable at any time.
- **Device storage (localStorage):** strictly necessary storage is exempt from consent under ePrivacy (France: art. 82 Loi Informatique et Libertés). Analytics trackers need consent unless they fit the CNIL audience-measurement exemption.
- **Minors:** in France a minor can consent alone from **15** (art. 45 Loi Informatique et Libertés); below that, consent-based processing also needs a parent. Location games attract children, so for minors: no location sharing, no public presence, no market, no real money.

### 6.4 DPIA
Large-scale location processing, systematic monitoring and vulnerable people (minors) meet several of the EDPB/WP248 criteria. Large-scale location processing is also a known CNIL DPIA trigger (check the current list). A DPIA is required before Phase 3.

### 6.5 Rights and the append-only ledger
- **Access and portability:** the ledger JSONL export is already the native format.
- **Erasure (Art. 17)** conflicts with an append-only log. Use pseudonymous player ids in rows with a deletable id↔person mapping, or per-player encryption keys deleted on erasure (crypto-shredding).
- Anything written to a public blockchain can never be erased, so **never put personal data on-chain**: no owner id, no conditions.
- **Breach notification:** to the CNIL within 72 h (Art. 33). The GPS buffer is the crown jewel: encrypt it at rest, keep retention short, and log every access.

### 6.6 Engineering rules (enforced in code where possible)
- **R1.** Raw coordinates never enter the ledger. Anti-cheat rows carry speed, accuracy and a 1 km cell id (**enforced and tested**).
- **R2.** Other players only ever receive `coarsenLocation` / `geoCellId` output of ≥ 500 m (library ready; presence wiring planned).
- **R3.** Snap to a fixed grid; do not add random noise. Noise averages out over repeated observations, while a fixed cell centre never moves (`coarsenLocation` is deterministic and idempotent, tested).
- **R4.** In sparse areas a 500 m cell can hold a single house. Grow the cell until ≥ k players' home areas share it (k-anonymity, S9).
- **R5.** Rate-limit and ledger keys are account ids or salted hashes, never raw IP addresses.
- **R6.** A Genemon shown to others exposes a *summary* of its conditions, never raw diet, experiences or `activeHour`.

## 7. NFT / real-money caution

- **Recommended meaning of "NFT-style":** unique generative genomes with **server-signed, off-chain provenance** (`hashCanonical` ids). No wallet, no token, no cash-out.
- **France: JONUM.** If Genemon, eggs or credits are bought with money *and* resellable for value, France's **JONUM** regime (games with monetisable digital objects) applies: loi SREN n° 2024-449, arts. 40–41; decree n° 2026-60, in force since 7 Feb 2026; experimental until May 2027. It covers games where a paid, chance-based mechanism yields transferable digital objects (NFTs, tokens). Obligations include prior declaration to the **ANJ**, identity and age verification (minors excluded), spending and time limits, self-exclusion, reward caps, and activity/wallet reporting for AML. Paid random eggs or breeding plus resale fits that definition. Outside JONUM, it is gambling law.
- **EU: MiCA.** Unique NFTs are largely excluded, but large series, fractionalised items or fungible in-game tokens can be crypto-assets, which brings CASP/AMF obligations.
- **Also:** AML/KYC, consumer law (minors' purchases, refunds) and tax.
- **Security consequence:** real money turns every bug into a payout (account takeover, phishing, wallet drainers, market manipulation, chargebacks). Do not consider it before server authority, KYC, a pentest, an incident-response plan and a legal sign-off. Even without real money, grey markets (account selling) appear, so plan terms of service and detection.

## 8. Security quests (prioritised; each with its acceptance test)

| # | Owner | Quest | Acceptance test |
|---|---|---|---|
| S1 | orchestrator | All imports: size cap → `findForbiddenKey` → schema → rebuild from whitelisted fields (no merges) | importing a profile with `__proto__` is refused and `({}).isAdmin === undefined` afterwards |
| S2 | orchestrator | Meta CSP in `web/index.html` (+ `form-action 'none'`); companion headers in `tools/serve.ts`; Trusted Types where supported | a serve test asserts every header; a build test asserts the meta tag |
| S3 | orchestrator | Make `when` required in `src/genome/genemon.ts` `log()` (drop the `Date.now()` fallback) | two runs of the same scripted life give byte-identical ledger JSONL |
| S4 | orchestrator | Network identity = SHA-256 of the canonical genome; keep `gm-` ids for display | two genomes with colliding 32-bit ids get different network ids |
| S5 | network | Per-type body validators (NETWORK.md N1) | each type rejects NaN, float or negative credits, unknown keys, bad fixes |
| S6 | network | Device signatures for peer relays (N4) | a relay that edits and re-hashes a message is rejected |
| S7 | network | Phase-2 server hardening: `Origin` check, frame cap before parse, TLS (mkcert), bind flag | a cross-origin WebSocket upgrade is refused; an over-cap frame never reaches `JSON.parse` |
| S8 | data scientist | Provenance tags; train only on server-verified rows | the dataset builder drops `client`-tagged rows |
| S9 | network + world | k-anonymous home cells | with a synthetic sparse population, every published home cell holds ≥ k homes |
| S10 | economist | Exclude related-party trades from price history | a wash pair cannot move the reference price |
| S11 | orchestrator | Determinism lint for outcome code (N8) | CI fails on a new `Math.sin` in battle code |
| S12 | all | **DPIA + external pentest** before Phase 3 (not code) | signed DPIA; pentest report with criticals closed |
| S13 | orchestrator | Dedicated security ledger `new Ledger("security", 50_000)` | a flood of rejections does not evict gameplay rows |

## 9. Residual risk (after every planned control)
- Skilled GPS spoofers with realistic movement stay undetectable from browser data; caps and cooldowns only bound their gain.
- Client automation: rate limits bound the damage, not its existence.
- Account sharing among friends is only partially detectable.
- Everything on the client stays readable and patchable, so no client-side secret will ever exist.
- Cross-engine float drift remains until the battle engine follows the determinism contract.
- Modules owned by others (market, UI, world) are marked unverified here until reviewed.

## 10. Open questions
- Will v1 have accounts at all, or only local profiles plus LAN play?
- How much of a Genemon's conditions does breeding or the market legitimately need to show other players?
- Minimum age policy, and how to enforce it without collecting ID (JONUM would require ID if monetised).
- Is the home location a manual pin (preferred) or inferred? An inferred home is far more sensitive.
- Retention period for security rows; who in the team can read the GPS buffer.
