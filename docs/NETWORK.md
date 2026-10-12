# Genemon — network architecture

> **Summary (read this first)**
> 1. Genemon runs local-only today: nothing touches a network. `src/net/` already holds the tested pure building blocks the online game needs: envelopes, canonical-JSON hashing, replay protection, rate limits, battle-claim checks and GPS anti-cheat.
> 2. Target: an **authoritative server** per region. Clients are offline-first and predictive. The server owns everything another player could lose: ownership, credits, territory and ladder.
> 3. Battles are deterministic. A replay is a ~1 KB claim (seed, arena, weather, team state hashes, result hash). The server re-simulates the battle; it never trusts a result.
> 4. Real-time battles use **server-relayed lockstep with an input deadline**. Move wind-ups hide 100–150 ms of input delay, only the server's simulation counts, and a slow opponent never stalls you.
> 5. Growth follows Gall's law: in-process loopback, then LAN (HTTPS), then one EU server, and only then geographic world-cell shards. Every step uses the same envelopes.

Related: `docs/SECURITY.md` (threat model, privacy, GDPR), `src/net/protocol.ts`, `src/net/antiCheat.ts`, `tests/net_test.ts`.

---

## 0. Status: what is real today

| Piece | State | Evidence |
|---|---|---|
| `src/net/protocol.ts`: envelopes, canonical JSON, SHA-256, `NonceCache`, `TokenBucket`, battle claims, body types | implemented, **not wired** into any runtime path | `tests/net_test.ts`: 22 tests pass (`deno test --allow-read tests/net_test.ts`) |
| `src/net/antiCheat.ts`: GPS checks, presence, travel cooldown, `ActionThrottle`, location coarsening | same | same |
| Mutation check: each control deleted one at a time (hash compare, skew, nonce, size, forbidden keys, `expectFrom`, key sort, accuracy floor, dwell speed, travel cooldown...) | 24/24 deletions caught by a failing test | scratch script, not committed |
| Server, sockets, accounts, persistence | **design only** (this document) | none |

## 1. Principles (each with its WHY)

1. **The server is authoritative for value.** This covers ownership, credits, territory, ladder and rewards. WHY: the client runs on the attacker's machine, so anything it computes is a suggestion.
2. **Determinism makes verification cheap.** A battle is `f(seed, arena, weather, teams[, inputs])`. The server re-runs it instead of trusting it. WHY: a replay is kilobytes, and verifying it is milliseconds of CPU.
3. **The client is offline-first.** The game stays playable without network. Local actions become ledger rows that sync later and are *re-validated*. WHY: GO-style play happens on trains and in basements.
4. **Gall's law.** Start with one region, one process and one database; shard only when measurements demand it. WHY: a working simple system is the only reliable path to a working complex one.
5. **Privacy by design.** Raw GPS never leaves the server-side anti-cheat buffer. Other players only see coarse cells (≥ 500 m), and the ledger never stores coordinates (tested). WHY: a location trail reveals a home, a schedule and a person.

## 2. Target architecture

```
 Browser / PWA (phone, desktop)                       EU region  (phase 3 = ONE Deno process)
┌───────────────────────────────┐   WSS (TLS)    ┌──────────────────────────────────────────────┐
│ UI + three.js renderer        │◄──envelopes───►│ Edge gateway: TLS, session cookie, Origin    │
│ Same pure engine (predictive) │                │ check, frame cap, TokenBucket, verifyEnvelope│
│ Local ledger = offline outbox │                │ (expectFrom + NonceCache), route by type/cell│
│ GPS sampler (Geolocation API) │                └────┬────────────┬─────────────┬──────────────┘
└───────────────────────────────┘                     │            │             │
        ┌──────────────────┬──────────────────────────┘            │             └──────────────┐
        ▼                  ▼                                       ▼                            ▼
 Presence / session   World cell shards                      Battle service              Market (auction
 (online status,      (territory, spawns, NPC tick,          (matchmaking, fair seeds,   house: wallets,
 coarse cells,        offline Genemon, GPS buffer 72 h,      lockstep relay, re-sim      escrow, one writer
 friends fan-out)     physicalPresence / ActionThrottle)     verifyBattleClaim)          per listing)
        └──────────────────┴───────────────────┬───────────────────┴────────────────────────────┘
                                               ▼
                 Event store = server ledger (append-only; per-player and per-cell streams)
                 → snapshots, replays, pseudonymised ML exports (never raw GPS)
```

| Component | Owns (single writer) | Scales by |
|---|---|---|
| Edge gateway | connections, sessions, rate limits, envelope verification | stateless, add instances |
| Presence | online status, coarse cells, friend subscriptions | player id hash |
| World cell shard | territories, spawns, NPCs, offline Genemon in its cells, raw-GPS buffer | geography (`geoCellId`) |
| Battle service | live battles, seeds, input logs, verdicts | battle id |
| Market | wallets, listings, escrow, settlement | listing id (wallet ops serialized per player) |
| Event store | the server ledger (truth) and snapshots | player/cell stream |

### 2.1 Regions
- **Start with one EU region.** The operator and early players are in France. Keeping data in the EU is the simplest GDPR posture, and a single region means no cross-region consistency.
- **Later regions:** each account gets a home region where its data rests. A battle is hosted in the region that minimises the worse player's RTT. The market stays global, but each listing has exactly one home shard. A territory lives in the region that physically contains it.

### 2.2 Sharded world cells
- The world is partitioned with `geoCellId(lat, lon, cellMeters)` (antiCheat.ts). Ids are stable integers (`"500:123:456"`, no float formatting), and cells are ≤ `cellMeters` with no cell straddling the antimeridian (tested).
- There are two levels. An **interest cell** (~500 m) is what a client subscribes to (3×3 neighbourhood: spawns, NPCs, nearby territories). A **shard cell** (e.g. 20 km, denser in Paris) is the unit of ownership. Exactly one process owns a shard cell at a time (lease), so territory writes are serialized without distributed locks.
- WHY a lat/lon grid and not S2/H3: the house rule forbids dependencies, the ids are stable, and the cell id is opaque to clients, so it can be swapped later.
- The virtual space (arenas, dungeons) is sharded by instance id, not by geography.

### 2.3 Presence service
- Clients send a `presence` heartbeat every 60 s or on change. A player goes offline after 2.5 missed heartbeats.
- Others see a status plus an *opt-in* coarse cell (≥ 500 m, `coarsenLocation`), never raw GPS. Minors get no location sharing at all.
- Fan-out uses one topic per player that friends subscribe to. The friend cap (e.g. 300) bounds the fan-out.

### 2.4 Offline-first client and sync
- The client runs the same pure modules (genome, epigenetics, battle) for instant feedback. Every local action is already a ledger row (`src/genome/genemon.ts` logs everything), and those rows form the outbox.
- On reconnect the client sends `genemon.sync { genemon, fromSeq, rows, stateHash }`. The server replays the rows through the same pure functions with server rules (rate caps, physical-only checks), computes its own state hash and acks. **On mismatch the server state wins.** The client rebases: it drops rejected rows and shows "N offline actions could not be confirmed".
- **Physical-only actions** (gym, supermarket, territory, travelKm, rescue) need presence proofs the server *observed live*. Offline they are refused, or kept as "pending" until matching `world.move` fixes arrive. WHY: an offline GPS log is just a file the user can edit.
- Offline progress (hunger, ageing) is credited by **server** time elapsed between syncs, never by the device clock.

### 2.5 The always-on world simulation
- The world lives while players sleep: NPCs, spawns, weather, territory decay, and offline players' Genemon (hunger, ageing, home-territory defence).
- Each shard cell has a **deterministic tick**: `state(n+1) = step(state(n), new Rng(hashSeed(worldSeed, cellId, n)))`. Any replica can recompute and audit any tick.
- **Evaluation is lazy.** Unobserved cells are not ticked. On first observation they fast-forward: closed-form catch-up for slow variables (hunger, ageing; `age(g, days)` already works this way) and batched ticks for spawns. WHY: 100 k players × 6 Genemon × 1 440 min is ~864 M updates a day, almost all of which nobody would ever see.
- Interactions with offline players happen **on demand**. A challenger at an offline player's territory fights the defenders' AI with a deterministic seed, so the result is verifiable like any battle.

## 3. Message catalogue (protocol v1, `src/net/protocol.ts`)

All messages share the `Envelope` header: `v, type, from, seq, nonce, sentAt, body, hash`. Sizes are canonical UTF-8 bytes, measured with the real code on Deno 2.9.7 (Apple Silicon) using realistic bodies.

| Type | Direction | Purpose | Body type | Max | Measured | Suggested rate | Physical |
|---|---|---|---|---|---|---|---|
| `hello` | C→S (reply S→C) | build, capabilities, clock-offset handshake | `HelloBody` | 2 KiB | 272 B | 3/min | – |
| `presence` | C→S→friends | status heartbeat, opt-in coarse cell | `PresenceBody` | 1 KiB | 245 B | 1/30 s | coarse only |
| `battle.request` | C→S→C | challenge / queue, with team and seed commitments | `BattleRequestBody` | 4 KiB | ~400 B (est.) | 30/min | – |
| `battle.result` | C→S | claim: seed, arena, weather, team state hashes, result hash | `BattleClaim` | 4 KiB | 1 176 B (6v6) | 1 per battle | – |
| `market.post` | C→S | create a listing (item escrowed) | `MarketPostBody` | 2 KiB | ~300 B | throttle `market.post` | – |
| `market.bid` | C→S | bid (credits escrowed) | `MarketBidBody` | 1 KiB | 242 B | throttle `market.bid` | – |
| `world.claim` | C→S | claim a territory | `WorldClaimBody` | 8 KiB | 1 060 B (12 fixes) | throttle `world.claim` | **yes** |
| `world.move` | C→S | GPS fix (physical) or position (virtual) | `WorldMoveBody` | 1 KiB | 297 B | 1/2 s, burst 5 | **yes** (physical) |
| `friend.add` | C→S | request or accept; a QR code means "met in person" | `FriendAddBody` | 1 KiB | ~250 B | throttle `friend.add` | optional |
| `genemon.sync` | C→S | offline ledger rows plus resulting state hash | `GenemonSyncBody` | 64 KiB | 3 246 B (10 rows) | 6/min | – |

`BodyByType` maps each type to its body, and `sealTyped()` makes the compiler enforce that pairing. Server→client messages reuse the envelope with `from` = shard id. Ack, error and reply shapes are not designed yet (quest N2). **Per-type body validation is not implemented yet** (quest N1): `verifyEnvelope` checks the envelope, so handlers must still validate bodies (integer credits, `ID_RE` ids, `isValidFix`).

## 4. Envelope pipeline, replay protection, clocks

Receiver pipeline, cheapest check first:

1. **Transport.** WSS only. A raw frame cap (≈ 64 KiB + slack) applies *before* `JSON.parse`. The `Origin` header is checked on the WebSocket upgrade, which stops cross-site WebSocket hijacking.
2. `JSON.parse` (no reviver).
3. **`TokenBucket.take(sessionKey, now)`**, per session and per account. It runs *before* verification so a flood costs O(1) per message.
4. **`verifyEnvelope(e, { now, expectFrom: session.accountId, nonces, ledger })`** checks shape, version, type, identity, clock skew, canonical size (`MAX_BYTES[type]`), prototype-pollution keys, the hash and finally the nonce. It never throws on bad input, but it *does* throw on bad options: a NaN `now` would silently disable the clock check (tested).
5. Per-type body validation (quest N1).
6. Domain handler on the owning shard. The envelope `hash` is the **idempotency key**, so at-least-once retries apply once.
7. One ledger row per decision. Rejections produce `net.reject`, `net.ratelimit` and `net.battle.reject` rows, kept flat and schema-valid (tested).

Invariants, each with a test in `tests/net_test.ts`:
- **Nonce TTL ≥ 2 × max skew** (defaults 60 s and ±30 s). An envelope accepted at `sentAt − skew` can be replayed until `sentAt + skew`, and the replay is still caught at that exact edge.
- **The nonce is recorded only after the hash verifies.** Forged envelopes cannot pre-burn a victim's nonce.
- **`from` must equal the authenticated session (`expectFrom`).** The hash is *not* authentication: anyone can recompute it after editing a message (a test shows a forger passing the hash check and failing `expectFrom`).
- **Canonical JSON round-trips:** `canonicalJSON(JSON.parse(canonicalJSON(x))) === canonicalJSON(x)`, so sender and receiver derive the same hash. For JSON values it equals RFC 8785 (JCS), so a non-JS server can verify hashes with any JCS library.

**Clock offset.** `hello` carries `clientNow`. The server replies with its own time, and the client sets `offset = serverNow − (sent + received)/2` (NTP-style) and re-estimates it on every `hello`. Every `sentAt` and `GpsFix.t` then uses corrected time, which makes ±30 s generous. WHY not a wider window: nonce-cache memory is rate × TTL per sender (bounded by `maxPerSender`).

**Nonces** come from `makeNonce(rng)` (house rule: core `Rng`). In production, seed the session `Rng` from `crypto.getRandomValues` at the IO edge. Nonces only need uniqueness, while server-issued *challenges* must be unpredictable and use WebCrypto directly.

**Peer relays (LAN phase).** Without a server session nothing authenticates `from`, so add device signatures over the same canonical bytes: Ed25519 where WebCrypto supports it, ECDSA P-256 as the fallback (quest N4).

## 5. Deterministic battles: replays and server re-simulation

- **The claim.** `BattleClaim { seed, arena, weather, teamA, teamB, winner, resultHash }`, with `resultHash = battleClaimHash(claim, outcome)` under the domain tag `genemon.battle.v1`. The tag means a battle hash can never equal an envelope hash. Teams are **Genemon state hashes** (`hashCanonical(genemon)`: genome + conditions + moves). The server already holds those states from `genemon.sync`, so a 6v6 claim is 1.2 KB instead of ~30 KB of creatures.
- **Verification.** `verifyBattleClaim(claim, resimulate)` validates the schema (uint32 seed, 1..`MAX_TEAM` ids, 64-hex hash), re-simulates with the real engine and compares winner and hash. A mismatch writes a `net.battle.reject` row, and the server's own result is recorded either way.
- **Seed fairness.** A client-chosen seed can be ground offline: simulate 10 000 seeds and submit only the wins. Ranked seeds = `deriveBattleSeed(serverSalt, revealA, revealB)` after both players committed (`seedCommit`). Aborting after seeing the opponent's reveal counts as a forfeit. Teams stay hidden until both lock (`teamCommit = hashCanonical({ domain: "genemon.team.v1", team, salt })`). Casual or local battles may use any seed but never count for ladder or rewards.
- **Cost.** Canonicalising and hashing a 2.5 KB level-30 Genemon takes ~43 µs on this Mac (measured, indicative). Battle re-simulation cost is unknown until the engine exists. At a ≤ 5 ms budget, 1 M battles a day ≈ 1.4 CPU-hours.
- **Replays are tiny.** A claim (plus the input log for real-time) is all a viewer needs to re-render a fight locally. Replays are cacheable and CDN-able.

### 5.1 Cross-engine determinism contract (important)
ECMAScript makes `+ − × ÷`, `Math.sqrt`, `floor/round/trunc/abs/min/max/sign/imul/fround` and integer bit operations exact on every engine. `Math.sin/cos/tan/asin/acos/atan/atan2/exp/expm1/log/log1p/log2/log10/pow/hypot/cbrt` (and `**`) are *implementation-approximated*: V8, SpiderMonkey and JavaScriptCore differ in the last bits, and browser-fingerprinting scripts exploit exactly that. A battle that branches on such a value can resolve differently on Safari than on the server's Deno (V8). That causes **false cheat flags** and lockstep desyncs. Rules:
1. The server's re-simulation is the truth. A mismatch alone is never punished; repeated mismatches on ranked claims go to review.
2. Outcome code avoids those functions, or quantises state every tick (integer HP, `r3` positions, lookup tables).
3. Known uses today: `Rng.normal()` (`Math.log`, `Math.cos`) and `sigmoid` (`Math.exp`) in `src/core/*`. They are fine for cosmetics and risky in outcome paths (integration request; lint quest N8).

## 6. Latency strategy for real-time battles

| | Input-delay lockstep (P2P/relay) | Server sim + client prediction | Rollback (GGPO-style) |
|---|---|---|---|
| Bandwidth | inputs only (~20 B each) | state snapshots every tick | inputs only |
| Truth | every client; needs bit-exact engines | server | every client; needs bit-exact engines |
| Feel | constant delay ≈ ½ RTT + jitter | instant local response, opponent interpolated | instant; visible corrections on mispredicts |
| Packet loss / slow peer | **both players stall** | no stall | no stall |
| Complexity | low | high (reconciliation) | high (save/restore, re-sim N frames) |
| Fit for Genemon | LAN / friendly matches | ranked, but snapshots are wasteful | fighting-game feel: overkill for commands |

**Decision: server-authoritative lockstep with an input deadline** (a hybrid).
- Fixed tick of 20 Hz (50 ms). Inputs are *commands* (move id, target, positional intent), not stick states.
- The client stamps an input for tick `n + d`, where `d = ceil((RTT/2 + jitter95) / 50 ms)` clamped to 2–6 ticks (100–300 ms).
- The server applies inputs received by the deadline. A late or missing input means *hold* (continue the current action), so the opponent never waits for you.
- The server broadcasts the per-tick **input set**, not the state. Clients simulate locally with the same engine, which keeps bandwidth tiny. Every 20 ticks the server sends a state hash; on mismatch (e.g. Safari float drift) the client fetches a snapshot and resyncs. Only the server's simulation decides the result.
- Latency is hidden with animation: the move wind-up (≥ 150–300 ms) starts on the local input (cosmetic prediction), and the hit lands on the authoritative tick.
- Battle input frames are **not** full envelopes (~250 B each). The battle channel is already authenticated, so frames are compact `[tick, action, arg]` arrays with a strictly increasing tick as replay protection. The whole input log is hashed into the final claim. That is ~2 inputs/s × 90 s × 20 B ≈ 3.6 KB per player per battle.

WHY: Stadium-like command combat tolerates 100–150 ms of input delay invisibly. Server authority turns cross-engine drift into a resync rather than a dispute. The deadline removes lockstep's "one slow player stalls both" failure. Rollback buys little for command inputs and costs a lot of engine work. LAN phase 2 can use plain relayed lockstep: everyone is a friend on the same network.

## 7. Market: server authority and escrow

`src/economy/market.ts` (economist) already models the house as custodian of wallets, escrow on post and bid, immediate refunds when outbid, the anti-sniping extension, fees and wash-trade signals. Online, the following must hold:
- **One writer per listing** (shard by listing id), with wallet operations serialized per player. That rules out double-spends and double-sells without distributed transactions.
- **Client messages are requests.** Prices on screen are display only, and the server recomputes every amount. Credits are integers, never floats.
- The envelope hash is the **idempotency key**: a retried bid applies once.
- **Settlement balances to zero** (double-entry rows: buyer −price, seller +proceeds, treasury +fee). A nightly invariant check sums every wallet against the ledger.
- Auctions end by the **server clock** (`endsAt`), never by client time.
- Fraud signals (wash pairs, related accounts sharing a device or IP, cycles A→B→C→A) go to human review. New accounts get trade holds. See SECURITY.md H9.

## 8. Territory consistency

- A territory belongs to exactly one shard cell (the one containing its centre), so claims are **linearizable inside one process** (compare-and-set on the territory version).
- A claim is accepted only when all three hold:
  - `ActionThrottle.attempt(player, "world.claim", now, at)` passes (cooldown, daily cap, travel cooldown).
  - `physicalPresence(serverReceivedFixes, place, now)` passes: ≥ 2 fixes over ≥ 10 s, the latest one inside, the whole accuracy disc inside, dwell speed ≤ 7 m/s, no teleport in the last 5 min.
  - Ownership rules pass. A contested territory means a battle against the defenders; offline defenders are simulated with a deterministic seed.
- The server prefers fixes it **received live** via `world.move` over fixes bundled in the claim, which are just a file the client wrote.
- Territories decay without periodic presence or defence (the world designer owns the numbers).

## 9. Friend graph

- Friendship needs mutual consent. Adjacency sets are sharded by player id and capped (≈ 300) to bound presence fan-out.
- **"Met in person"** works like this: phone A shows a short-lived code as a QR and phone B scans it. Both send recent fixes, and the server checks `physicalPresence` of both at the same place within ~2 min. A met edge gives a bonus and is capped per day (anti-farm).
- Friends see status plus an *opt-in* coarse cell. Blocking hides both ways. Minors get no location sharing.
- Social epigenetics (`socialPlay`) is credited server-side and rate-limited.

## 10. Data volumes per DAU (estimate)

Measured message sizes come from §3. Assumptions are guesses until telemetry exists: 30 min active a day, 15 min of that outdoors and moving, 8 battles, 10 market actions, 6 Genemon.

| Flow | Calculation | Up | Down |
|---|---|---|---|
| GPS `world.move` every 5 s outdoors | 180 × 297 B | 53 KB | – |
| `presence` 1/min | 30 × 245 B | 7 KB | 7 KB (friends) |
| Battles | 8 × (1.2 KB claim + 0.4 KB request + 3.6 KB inputs) | 41 KB | 42 KB (opponent inputs, hashes) |
| Market | 10 × 250 B; browsing listings | 3 KB | 30 KB |
| `genemon.sync` | ~30 offline rows × 290 B | 10 KB | 2 KB (acks) |
| World interest-cell updates | 1 per 5 s × 300 B while active | – | 108 KB |
| **Total** | | **≈ 115 KB** | **≈ 190 KB** |

- **Bandwidth** is ≈ 0.3 MB per DAU per day uncompressed. `permessage-deflate` typically gains 3–5× on repetitive JSON. The one-time asset download (bundle, three.js) dwarfs this.
- **Server load at 100 k DAU:** ≈ 25–30 M envelopes a day, which is ≈ 350/s on average and ≈ 2 k/s at peak. At ≈ 10–40 µs to verify each, that is < 10 % of one core. Compact battle frames add ≈ 144 M/day (≈ 1.7 k/s) but need no hashing.
- **Storage at 100 k DAU:** the ledger holds only state-changing rows (≈ 100 per DAU per day × 290 B) ≈ 2.9 GB/day raw. Raw GPS lives in a 72 h buffer (≈ 53 KB × 100 k × 3 days ≈ 16 GB) and **never** in the ledger.

## 11. Phased plan

| Phase | What | Exit criteria |
|---|---|---|
| 0. Local (now) | pure engine, local ledger, `src/net` primitives | `tests/net_test.ts` green |
| 1. Loopback | a pure `LocalServer` (same handlers, e.g. in a Web Worker); even single-player value changes go through sealed envelopes | the server ledger replay reproduces the client's state hash after a scripted session |
| 2. LAN / peers | `tools/server.ts` (`Deno.serve` + WebSocket) on the LAN; 2–4 devices; relayed lockstep battles. **HTTPS is required**: browsers expose `navigator.geolocation` only in secure contexts (localhost excepted), so use a mkcert/self-signed certificate. CSP must list the explicit `wss://` origin (older Safari did not match ws/wss with `'self'`). Binding beyond 127.0.0.1 happens only behind an explicit flag. | two phones finish a battle whose claim the server re-simulates; a real walk passes `physicalPresence` |
| 3. One EU server | single Deno process + SQLite (WAL) or Postgres; passkey (WebAuthn) accounts; HttpOnly SameSite=Strict session cookie + `Origin` check; market and territory authority; backups | DPIA done, pentest done, load test at 2 k envelopes/s |
| 4. Scale | shard-cell leases across processes; separate battle and market services; read replicas; second region only when latency or law requires it | per-shard p99 latency and error budgets met |

## 12. Open questions
- Team size (`MAX_TEAM = 6` is assumed) and battle cadence (real-time vs turn-based) drive tick rate and input delay.
- Does the battle engine use transcendental `Math` in outcome paths (§5.1)?
- Server runtime: Deno (shares the pure modules; strongly preferred) or another stack (then use JCS for hashes)?
- Account model: local anonymous profiles that later bind to a passkey account?
- Physical actions taken offline: refuse them, or accept them as "pending" with a reduced reward?
- Persistence (SQLite vs Postgres) and the event-store snapshot cadence.
- Real money / NFTs: default **no** (SECURITY.md §7).

## 13. Next quests (each with its acceptance test)
- **N1 Body validators** `validateBody(type, body) → reason | null` (pure). Test: every type rejects NaN, float or negative credits, unknown keys, bad ids and out-of-range fixes.
- **N2 Server→client shapes** (acks, errors, `hello` reply `{ serverNow, sessionTtl, challenge }`). Test: a round trip through `seal`/`verifyEnvelope`.
- **N3 `SeqTracker`** per session (ordering, gaps, duplicates). Test: out-of-order and duplicate `seq` are flagged.
- **N4 Device signatures** for peer relays (Ed25519 / ECDSA P-256 over canonical bytes). Test: a relay that edits a message and re-hashes it is rejected.
- **N5 Loopback server** (phase 1). Test: client state hash == server replay hash.
- **N6 `tools/server.ts`** (phase 2): WSS, `Origin` check, frame cap, the TokenBucket → verifyEnvelope → nonce pipeline. Test: two clients over 127.0.0.1; a cross-origin upgrade is refused.
- **N7 Lockstep battle channel** once the engine exists. Test: 200 ms of injected jitter never stalls the opponent, and a forced desync triggers a resync.
- **N8 Determinism lint.** Test: fails CI when outcome modules gain `Math.sin|cos|tan|exp|log|pow|atan2|hypot|cbrt` or `**`.
- **N9 Interest management** (3×3 cell subscriptions) and shard-cell leases. Test: a player crossing a cell boundary receives exactly the new row/column of cells.
