// Network protocol + anti-cheat primitives (src/net/*). Pure: no network, no clock, no Math.random.
import { assert, assertEquals, assertThrows } from "./_assert.ts";
import { isValidEvent, Ledger } from "../src/core/ledger.ts";
import { hashSeed, Rng } from "../src/core/rng.ts";
import {
  battleClaimHash,
  canonicalJSON,
  DEFAULT_MAX_SKEW_MS,
  DEFAULT_NONCE_TTL_MS,
  deriveBattleSeed,
  type Envelope,
  envelopeBytes,
  findForbiddenKey,
  hashCanonical,
  makeNonce,
  MAX_BYTES,
  NONCE_RE,
  NonceCache,
  type Resimulate,
  seal,
  sealTyped,
  sha256Hex,
  TokenBucket,
  verifyBattleClaim,
  verifyEnvelope,
} from "../src/net/protocol.ts";
import {
  ActionThrottle,
  coarsenLocation,
  geoCellId,
  type GpsFix,
  gpsPlausible,
  haversineM,
  movementMode,
  physicalPresence,
  travelCooldownMs,
} from "../src/net/antiCheat.ts";

const T0 = 1_760_000_000_000; // fixed epoch ms: tests never read the wall clock
const PARIS = { lat: 48.8566, lon: 2.3522 };
const LYON = { lat: 45.764, lon: 4.8357 };
const EIFFEL = { lat: 48.85837, lon: 2.294481 };

async function rejects(p: Promise<unknown>): Promise<boolean> {
  try {
    await p;
    return false;
  } catch {
    return true;
  }
}

function nonce(i: number): string {
  return makeNonce(new Rng(hashSeed("test-nonce", i)));
}

/** Point `meters` north/east of `p` (small offsets, local flat approximation). */
function offset(p: { lat: number; lon: number }, north: number, east: number) {
  return {
    lat: p.lat + north / 111_195,
    lon: p.lon + east / (111_195 * Math.cos((p.lat * Math.PI) / 180)),
  };
}

function bid(seq = 1, sentAt = T0, n = nonce(seq)) {
  return seal("market.bid", "alice", seq, n, sentAt, { listing: "L-42", amount: 120 });
}

// ------------------------------------------------------------------------------------------------
// canonical JSON + hashing

Deno.test("canonicalJSON sorts keys, drops whitespace and is stable across insertion orders", () => {
  const a = { b: 1, a: [3, { d: true, c: null }], "é": "x", z: { y: 2, x: 1 } };
  const b = { z: { x: 1, y: 2 }, "é": "x", a: [3, { c: null, d: true }], b: 1 };
  const expected = '{"a":[3,{"c":null,"d":true}],"b":1,"z":{"x":1,"y":2},"é":"x"}';
  assertEquals(canonicalJSON(a), expected);
  assertEquals(canonicalJSON(b), expected);
  assertEquals(canonicalJSON(a), canonicalJSON(a), "repeatable");
  // Number formatting is ECMAScript's (= RFC 8785): -0 -> 0, exponent form, shortest digits.
  assertEquals(canonicalJSON([-0, 1e21, 0.1 + 0.2, 5e-7]), "[0,1e+21,0.30000000000000004,5e-7]");
  assertEquals(canonicalJSON({ a: undefined, b: 2 }), '{"b":2}', "undefined props are omitted like JSON");
  // Round trip through the wire is the property that lets a receiver re-derive the sender's hash.
  const c = canonicalJSON(a);
  assertEquals(canonicalJSON(JSON.parse(c)), c);
});

Deno.test("canonicalJSON rejects values that would make two different inputs share a hash", () => {
  const cyclic: Record<string, unknown> = { a: 1 };
  cyclic.self = cyclic;
  let deep: unknown = 0;
  for (let i = 0; i < 40; i++) deep = [deep];
  const bad: Array<[string, unknown]> = [
    ["NaN", { x: NaN }],
    ["Infinity", [Infinity]],
    ["-Infinity", -Infinity],
    ["function", { f: () => 1 }],
    ["bigint", { n: 10n }],
    ["symbol", [Symbol("s")]],
    ["undefined in array", [1, undefined]],
    ["array hole", new Array(2)],
    ["top-level undefined", undefined],
    ["Date", { d: new Date(0) }],
    ["Map", new Map([["a", 1]])],
    ["Set", { s: new Set([1]) }],
    ["class instance", { r: new Rng(1) }],
    ["cycle", cyclic],
    ["too deep", deep],
  ];
  for (const [label, value] of bad) assertThrows(() => canonicalJSON(value), `should reject ${label}`);
  // A shared (non-cyclic) reference is fine.
  const shared = { k: 1 };
  assertEquals(canonicalJSON({ a: shared, b: shared }), '{"a":{"k":1},"b":{"k":1}}');
});

Deno.test("sha256Hex matches FIPS 180-2 vectors; findForbiddenKey spots prototype-pollution keys", async () => {
  assertEquals(await sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assertEquals(await sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assertEquals(await hashCanonical({ b: 1, a: 2 }), await hashCanonical({ a: 2, b: 1 }));
  const polluted = JSON.parse('{"ok":1,"nested":[{"__proto__":{"admin":true}}]}');
  assertEquals(findForbiddenKey(polluted), "$.nested[0].__proto__");
  assertEquals(findForbiddenKey(JSON.parse('{"constructor":{"prototype":{"x":1}}}')), "$.constructor");
  assertEquals(findForbiddenKey({ a: [1, { b: "constructor" }] }), null, "values are fine, only keys matter");
  assertEquals(({} as Record<string, unknown>).admin, undefined, "JSON.parse itself never pollutes");
});

// ------------------------------------------------------------------------------------------------
// envelopes

Deno.test("seal -> wire -> verifyEnvelope accepts; tampering with body or header fails the hash", async () => {
  const env = await bid();
  assertEquals((await verifyEnvelope(env, { now: T0 })).ok, true);
  const wire = JSON.parse(JSON.stringify(env)) as Envelope<{ listing: string; amount: number }>;
  assertEquals((await verifyEnvelope(wire, { now: T0 })).ok, true, "survives a JSON round trip");

  const tamperedBody = structuredClone(wire);
  tamperedBody.body.amount = 1;
  assertEquals(await verifyEnvelope(tamperedBody, { now: T0 }), { ok: false, reason: "hash-mismatch" });
  const tamperedSeq = { ...wire, seq: 2 };
  assertEquals((await verifyEnvelope(tamperedSeq, { now: T0 })).reason, "hash-mismatch");
  const retyped = { ...wire, type: "market.post" };
  assertEquals((await verifyEnvelope(retyped, { now: T0 })).reason, "hash-mismatch");
  const respoofed = { ...wire, from: "mallory" };
  assertEquals((await verifyEnvelope(respoofed, { now: T0 })).reason, "hash-mismatch");
  // ...but the hash is NOT authentication: a forger who recomputes it passes the hash check.
  // Identity must come from the session, which is what expectFrom enforces:
  const forged = await seal("market.bid", "alice", 9, nonce(9), T0, { listing: "L-42", amount: 1 });
  assertEquals((await verifyEnvelope(forged, { now: T0 })).ok, true, "hash alone cannot stop a forger");
  assertEquals(await verifyEnvelope(forged, { now: T0, expectFrom: "mallory" }), {
    ok: false,
    reason: "from-mismatch",
  });
});

Deno.test("stale and future envelopes are rejected by clock skew; the boundary is inclusive", async () => {
  const skew = DEFAULT_MAX_SKEW_MS;
  assertEquals((await verifyEnvelope(await bid(1, T0 - skew), { now: T0 })).ok, true);
  assertEquals((await verifyEnvelope(await bid(2, T0 + skew), { now: T0 })).ok, true);
  assertEquals((await verifyEnvelope(await bid(3, T0 - skew - 1), { now: T0 })).reason, "stale");
  assertEquals((await verifyEnvelope(await bid(4, T0 + skew + 1), { now: T0 })).reason, "future");
  assertEquals(
    (await verifyEnvelope(await bid(5, T0 - 5_000), { now: T0, maxSkewMs: 1_000 })).reason,
    "stale",
  );
  // Bad options fail loudly: a NaN clock would otherwise silently disable the skew check.
  assert(await rejects(verifyEnvelope(await bid(), { now: NaN })), "NaN now must throw");
  assert(await rejects(verifyEnvelope(await bid(), { now: T0, maxSkewMs: NaN })), "NaN skew must throw");
  assert(await rejects(verifyEnvelope(await bid(), { now: T0, maxBytes: NaN })), "NaN maxBytes must throw");
});

Deno.test("oversize envelopes are rejected (per-type default and explicit byte limit)", async () => {
  const big = await seal("presence", "alice", 1, nonce(1), T0, { status: "online", cell: "x".repeat(2_000) });
  assert(envelopeBytes(big) > MAX_BYTES.presence);
  assertEquals((await verifyEnvelope(big, { now: T0 })).reason, "too-large");
  const sync = await seal("genemon.sync", "alice", 2, nonce(2), T0, { pad: "y".repeat(70_000) });
  assertEquals((await verifyEnvelope(sync, { now: T0 })).reason, "too-large");
  const env = await bid();
  const size = envelopeBytes(env);
  assertEquals((await verifyEnvelope(env, { now: T0, maxBytes: size })).ok, true, "limit is inclusive");
  assertEquals((await verifyEnvelope(env, { now: T0, maxBytes: size - 1 })).reason, "too-large");
});

Deno.test("schema, version, type and prototype-pollution checks reject malformed envelopes", async () => {
  const env = await bid();
  const now = T0;
  const noBody: Record<string, unknown> = { ...env };
  delete noBody.body;
  const cases: Array<[string, unknown, string]> = [
    ["null", null, "malformed"],
    ["array", [env], "malformed"],
    ["string", JSON.stringify(env), "malformed"],
    ["extra field", { ...env, admin: true }, "schema"],
    ["missing body", noBody, "schema"],
    ["v as string", { ...env, v: "1" }, "schema"],
    ["future version", { ...env, v: 2 }, "version"],
    ["unknown type", { ...env, type: "admin.grant" }, "unknown-type"],
    ["uppercase hash", { ...env, hash: env.hash.toUpperCase() }, "schema"],
    ["short nonce", { ...env, nonce: "abc" }, "schema"],
    ["negative seq", { ...env, seq: -1 }, "schema"],
    ["float sentAt", { ...env, sentAt: T0 + 0.5 }, "schema"],
    ["spaces in from", { ...env, from: "alice smith" }, "schema"],
  ];
  for (const [label, value, reason] of cases) {
    assertEquals((await verifyEnvelope(value, { now })).reason, reason, label);
  }
  // A correctly hashed envelope whose body carries __proto__ (only possible via JSON.parse).
  const unsigned = JSON.parse(
    `{"v":1,"type":"genemon.sync","from":"alice","seq":1,"nonce":"${nonce(1)}","sentAt":${T0},` +
      `"body":{"genemon":"g-1","stats":{"__proto__":{"admin":true}}}}`,
  );
  const evil = { ...unsigned, hash: await sha256Hex(canonicalJSON(unsigned)) };
  assertEquals((await verifyEnvelope(evil, { now })).reason, "forbidden-key");
  // seal refuses to build what receivers reject.
  assert(await rejects(seal("market.bid", "alice", 1, "short", T0, {})), "short nonce");
  assert(await rejects(seal("market.bid", "alice", 1, nonce(1), T0, undefined)), "undefined body");
  assert(await rejects(seal("market.bid", "alice", 1, nonce(1), T0, { p: NaN })), "NaN in body");
  assert(await rejects(seal("nope" as "hello", "alice", 1, nonce(1), T0, {})), "unknown type");
  assert(await rejects(seal("hello", "alice", 1, nonce(1), T0, JSON.parse('{"__proto__":{}}'))), "pollution");
});

Deno.test("nonce replay is detected per sender and expires after the TTL (inclusive)", () => {
  const cache = new NonceCache(10_000);
  const n = nonce(1);
  assertEquals(cache.seen("alice", n, T0), false, "first sight");
  assertEquals(cache.seen("alice", n, T0 + 1), true, "replay");
  assertEquals(cache.seen("bob", n, T0 + 1), false, "nonces are namespaced by sender");
  assertEquals(cache.seen("alice", n, T0 + 10_000), true, "still remembered exactly at ttl");
  assertEquals(cache.seen("alice", n, T0 + 10_001), false, "expired -> fresh again (and re-recorded)");
  assertEquals(cache.seen("alice", n, T0 + 10_002), true);
  // Per-sender budget: a flooder is refused without affecting anyone else.
  const small = new NonceCache(10_000, { maxPerSender: 3 });
  for (let i = 0; i < 3; i++) assertEquals(small.check("eve", nonce(100 + i), T0), "fresh");
  assertEquals(small.check("eve", nonce(200), T0), "full");
  assertEquals(small.check("alice", nonce(200), T0), "fresh");
  assertEquals(small.check("eve", nonce(200), T0 + 10_001), "fresh", "budget frees up as nonces expire");
  assertEquals(small.sweep(T0 + 30_000), 2);
  assertEquals(small.size, 0);
  assertThrows(() => new NonceCache(0));
});

Deno.test("verifyEnvelope + NonceCache: replays caught across the whole skew window; forgeries burn nothing", async () => {
  const skew = DEFAULT_MAX_SKEW_MS;
  const nonces = new NonceCache(DEFAULT_NONCE_TTL_MS);
  const env = await bid(1, T0);
  // Accepted at the earliest instant the skew check allows, replayed at the latest one.
  assertEquals((await verifyEnvelope(env, { now: T0 - skew, nonces })).ok, true);
  assertEquals((await verifyEnvelope(env, { now: T0, nonces })).reason, "replay");
  assertEquals(
    (await verifyEnvelope(env, { now: T0 + skew, nonces })).reason,
    "replay",
    "ttl >= 2*skew invariant",
  );
  assertEquals((await verifyEnvelope(env, { now: T0 + skew + 1, nonces })).reason, "stale");
  // An attacker who knows a future nonce cannot pre-burn it with a broken envelope.
  const legit = await bid(2, T0, nonce(2));
  const forged = { ...legit, body: { listing: "L-42", amount: 0 } };
  assertEquals((await verifyEnvelope(forged, { now: T0, nonces })).reason, "hash-mismatch");
  assertEquals((await verifyEnvelope(legit, { now: T0, nonces })).ok, true);
});

Deno.test("security ledger: rejections emit valid flat rows; rate-limit floods are logged logarithmically", async () => {
  const ledger = new Ledger("security");
  const env = await bid();
  await verifyEnvelope({ ...env, seq: 5 }, { now: T0, ledger });
  const rows = ledger.query({ what: "net.reject" });
  assertEquals(rows.length, 1);
  assertEquals([rows[0].who, rows[0].why, rows[0].entries.type], ["alice", "hash-mismatch", "market.bid"]);
  assert(isValidEvent(rows[0]), "row matches the ledger schema");

  const bucket = new TokenBucket(1, 0, { ledger, name: "conn" });
  assertEquals(bucket.take("alice", T0), true);
  for (let i = 0; i < 10; i++) assertEquals(bucket.take("alice", T0 + i), false);
  const limited = ledger.query({ what: "net.ratelimit" });
  assertEquals(limited.map((r) => r.exits.denied), [1, 2, 4, 8], "1st, 2nd, 4th, 8th denial only");
  assert(limited.every(isValidEvent));
});

// ------------------------------------------------------------------------------------------------
// rate limiting

Deno.test("token bucket limits bursts then refills at the configured rate", () => {
  const b = new TokenBucket(3, 1); // burst 3, 1 token/s
  assertEquals([b.take("k", T0), b.take("k", T0), b.take("k", T0)], [true, true, true]);
  assertEquals(b.take("k", T0), false, "burst exhausted");
  assertEquals(b.take("other", T0), true, "keys are independent");
  for (let i = 0; i < 3; i++) b.take("j", T0);
  assertEquals(b.take("j", T0 + 999), false, "0.999 token is not a token");
  assertEquals(b.take("k", T0 + 1_000), true, "refilled one token");
  assertEquals(b.take("k", T0 + 500), false, "clock going backwards never refills");
  const c = new TokenBucket(2, 1);
  c.take("x", T0 + 10_000);
  assertEquals(c.peek("x", T0), 1, "...nor drains: a clock correction must not punish the player");
  assertEquals(b.take("k", T0 + 1_000_000, 4), false, "cost above capacity can never pass");
  assertEquals(b.peek("k", T0 + 1_000_000), 3, "...and consumes nothing; refill caps at capacity");
  assertEquals(b.take("k", T0 + 1_000_000, 3), true);
  assertThrows(() => b.take("k", T0, 0), "zero cost would be a free pass");
  assertThrows(() => b.take("k", T0, -1), "negative cost would mint tokens");
  assertThrows(() => b.take("k", NaN), "NaN clock");
  assertEquals(b.sweep(T0 + 2_000_000), 3, "full buckets are dropped losslessly");
  assertEquals(b.size, 0);
});

// ------------------------------------------------------------------------------------------------
// deterministic battles

Deno.test("battleClaimHash is stable and sensitive to every field and to the outcome", async () => {
  const base = {
    seed: 12345,
    arena: "volcano",
    weather: "rain",
    teamA: ["a1", "a2"],
    teamB: ["b1", "b2"],
    winner: "A" as const,
  };
  const outcome = { turns: 14, hp: { a1: 12, b1: 0 }, log: ["a1:ember", "b1:faint"] };
  const h = await battleClaimHash(base, outcome);
  assertEquals(h, await battleClaimHash({ ...base }, structuredClone(outcome)), "stable");
  assertEquals(
    h,
    await battleClaimHash(base, { log: outcome.log, hp: { b1: 0, a1: 12 }, turns: 14 }),
    "key order",
  );
  assertEquals(
    h,
    await battleClaimHash({ ...base, resultHash: "f".repeat(64) } as typeof base, outcome),
    "ignores extras",
  );
  const variants = await Promise.all([
    battleClaimHash({ ...base, seed: 12346 }, outcome),
    battleClaimHash({ ...base, arena: "tundra" }, outcome),
    battleClaimHash({ ...base, weather: "sun" }, outcome),
    battleClaimHash({ ...base, teamA: ["a1", "a3"] }, outcome),
    battleClaimHash({ ...base, teamA: ["a2", "a1"] }, outcome),
    battleClaimHash({ ...base, teamB: ["b1"] }, outcome),
    battleClaimHash({ ...base, winner: "B" }, outcome),
    battleClaimHash({ ...base, winner: "draw" }, outcome),
    battleClaimHash(base, { ...outcome, turns: 15 }),
  ]);
  assertEquals(new Set([h, ...variants]).size, variants.length + 1, "every change yields a distinct hash");
  assert(/^[0-9a-f]{64}$/.test(h));
});

Deno.test("server re-simulation accepts honest claims and rejects forged winners and outcomes", async () => {
  // Stand-in deterministic engine: the real one is a pure function of the same inputs.
  const resim: Resimulate = (c) => {
    const rng = new Rng(hashSeed(c.seed, c.arena, c.weather, ...c.teamA, "|", ...c.teamB));
    const a = rng.int(0, 100), b = rng.int(0, 100);
    return { winner: a > b ? "A" : b > a ? "B" : "draw", outcome: { a, b, turns: rng.int(5, 30) } };
  };
  const inputs = {
    seed: deriveBattleSeed("salt", "ra", "rb"),
    arena: "volcano",
    weather: "rain",
    teamA: ["a1"],
    teamB: ["b1"],
  };
  const truth = await resim(inputs);
  const honest = {
    ...inputs,
    winner: truth.winner,
    resultHash: await battleClaimHash({ ...inputs, winner: truth.winner }, truth.outcome),
  };
  assertEquals((await verifyBattleClaim(honest, resim)).ok, true);
  const flipped = truth.winner === "A" ? "B" : "A";
  const ledger = new Ledger("security");
  assertEquals(
    (await verifyBattleClaim({ ...honest, winner: flipped }, resim, { ledger, now: T0 })).reason,
    "winner-mismatch",
  );
  const fakeOutcome = await battleClaimHash({ ...inputs, winner: truth.winner }, { a: 100, b: 0, turns: 1 });
  assertEquals(
    (await verifyBattleClaim({ ...honest, resultHash: fakeOutcome }, resim)).reason,
    "hash-mismatch",
  );
  assertEquals((await verifyBattleClaim({ ...honest, seed: 2 ** 32 }, resim)).reason, "schema");
  assertEquals((await verifyBattleClaim({ ...honest, teamA: [] }, resim)).reason, "schema");
  assertEquals(
    (await verifyBattleClaim(honest, () => {
      throw new Error("engine bug");
    })).reason,
    "resim-error",
  );
  assertEquals(ledger.query({ what: "net.battle.reject" }).length, 1);
  // Seed derivation: deterministic uint32, changes with any party's reveal.
  const s = deriveBattleSeed("salt", "ra", "rb");
  assertEquals(s, deriveBattleSeed("salt", "ra", "rb"));
  assert(Number.isInteger(s) && s >= 0 && s <= 0xffffffff);
  assertEquals(
    new Set([
      s,
      deriveBattleSeed("salt2", "ra", "rb"),
      deriveBattleSeed("salt", "rx", "rb"),
      deriveBattleSeed("salt", "ra", "rx"),
    ]).size,
    4,
  );
});

Deno.test("makeNonce is deterministic per seed, 128-bit hex and accepted by the envelope schema", async () => {
  const a = new Rng(7), b = new Rng(7);
  const n1 = makeNonce(a), n2 = makeNonce(a);
  assertEquals(n1, makeNonce(b));
  assert(n1 !== n2, "successive nonces differ");
  assert(/^[0-9a-f]{32}$/.test(n1) && NONCE_RE.test(n1));
  const env = await sealTyped("presence", "alice", 1, n1, T0, { status: "online" });
  assertEquals((await verifyEnvelope(env, { now: T0 })).ok, true);
});

// ------------------------------------------------------------------------------------------------
// GPS anti-cheat

Deno.test("haversine: Paris -> Lyon ~392 km, antimeridian and equator sanity", () => {
  const d = haversineM(PARIS, LYON);
  assert(Math.abs(d - 392_000) <= 5_000, `Paris-Lyon ${d} m`);
  assertEquals(Math.round(haversineM(PARIS, LYON)), Math.round(haversineM(LYON, PARIS)), "symmetric");
  assertEquals(haversineM(PARIS, PARIS), 0);
  const across = haversineM({ lat: 0, lon: 179.999 }, { lat: 0, lon: -179.999 });
  assert(Math.abs(across - 222.4) < 1, `antimeridian ${across} m`);
  const deg = haversineM({ lat: 0, lon: 0 }, { lat: 0, lon: 1 });
  assert(Math.abs(deg - 111_195) < 1, `1 degree at the equator ${deg} m`);
});

Deno.test("gpsPlausible rejects teleports, mock accuracy and time travel; accepts walking and jitter", () => {
  const fix = (t: number, p: { lat: number; lon: number }, accuracy = 8): GpsFix => ({ t, ...p, accuracy });
  const start = fix(T0, PARIS);
  // Teleport: 100 km in 10 s.
  const tp = gpsPlausible(start, fix(T0 + 10_000, offset(PARIS, 100_000, 0)));
  assertEquals([tp.ok, tp.reason, tp.suspicious, tp.mode], [false, "teleport", true, "impossible"]);
  // Walking: 84 m in 60 s.
  const walk = gpsPlausible(start, fix(T0 + 60_000, offset(PARIS, 84, 0), 5));
  assertEquals([walk.ok, walk.mode, walk.suspicious], [true, "walk", false]);
  // Jitter inside the accuracy discs is not movement.
  const jitter = gpsPlausible(start, fix(T0 + 1_000, offset(PARIS, 0, 12)));
  assertEquals([jitter.ok, jitter.speed, jitter.mode], [true, 0, "still"]);
  // TGV at ~300 km/h: refused for gameplay, but not a cheat signal.
  const tgv = gpsPlausible(start, fix(T0 + 60_000, offset(PARIS, 5_000, 0)));
  assertEquals([tgv.ok, tgv.reason, tgv.suspicious, tgv.mode], [false, "too-fast", false, "vehicle"]);
  // Mock-location signature: accuracy 0.
  assertEquals(gpsPlausible(null, fix(T0, PARIS, 0)).reason, "accuracy-implausible");
  // Timestamps going backwards.
  assertEquals(gpsPlausible(start, fix(T0 - 1, PARIS)).reason, "time-backwards");
  // Same instant, different place.
  assertEquals(gpsPlausible(start, fix(T0, offset(PARIS, 500, 0))).reason, "teleport");
  // Garbage.
  assertEquals(gpsPlausible(null, { t: T0, lat: 91, lon: 0, accuracy: 5 }).reason, "invalid-fix");
  assertEquals(gpsPlausible(null, { t: T0, lat: NaN, lon: 0, accuracy: 5 }).reason, "invalid-fix");
  // Vague fix (indoors / cell tower): unusable but honest.
  const vague = gpsPlausible(start, fix(T0 + 60_000, PARIS, 900));
  assertEquals([vague.ok, vague.reason, vague.suspicious], [false, "imprecise", false]);
  assertEquals(
    gpsPlausible(start, fix(T0 + 10_000, offset(PARIS, 100_000, 0)), { maxSpeedMs: 20_000 }).ok,
    true,
  );
});

Deno.test("movementMode classifies speeds and fails closed on garbage", () => {
  const modes = [0, 0.49, 1.4, 3, 6.9, 10, 30, 89, 250, 400, -1, NaN, Infinity].map(movementMode);
  assertEquals(modes, [
    "still",
    "still",
    "walk",
    "run",
    "run",
    "bike",
    "vehicle",
    "vehicle",
    "vehicle",
    "impossible",
    "impossible",
    "impossible",
    "impossible",
  ]);
});

Deno.test("anti-cheat ledger rows never contain raw coordinates", () => {
  const ledger = new Ledger("security");
  const at = (t: number, p: { lat: number; lon: number }): GpsFix => ({ t, ...p, accuracy: 6 });
  gpsPlausible(at(T0, EIFFEL), at(T0 + 5_000, LYON), { ledger, who: "alice" });
  physicalPresence([at(T0, EIFFEL), at(T0 + 1_000, LYON)], { ...EIFFEL, radius: 50 }, T0 + 2_000, {
    ledger,
    who: "alice",
  });
  const rows = ledger.rows();
  assertEquals(rows.map((r) => r.what), ["anticheat.gps", "anticheat.presence"]);
  assert(rows.every(isValidEvent));
  const dump = ledger.toJSONL();
  for (const needle of ["48.858", "2.294", "45.764", "4.835"]) {
    assert(!dump.includes(needle), `leaked ${needle}`);
  }
  assertEquals(rows[0].where.space, "physical");
});

Deno.test("physicalPresence needs >= 2 consistent recent fixes inside the place", () => {
  const gym = { ...EIFFEL, radius: 60 };
  const near = offset(EIFFEL, 10, 5);
  const f = (dt: number, p = near, accuracy = 8): GpsFix => ({ t: T0 + dt, ...p, accuracy });
  const now = T0 + 30_000;
  const check = (fixes: GpsFix[], at = now) => physicalPresence(fixes, gym, at);

  assertEquals(check([f(0), f(20_000)]), { present: true, reason: "ok", inside: 2, spanMs: 20_000 });
  assertEquals(check([f(20_000), f(0)]).present, true, "order of submission does not matter");
  assertEquals(check([f(20_000)]).reason, "too-few-fixes", "one fix proves nothing");
  assertEquals(check([f(20_000), f(20_000)]).reason, "too-few-fixes", "exact duplicates count once");
  assertEquals(check([f(15_000), f(20_000)]).reason, "too-short", "5 s is not a visit");
  assertEquals(check([f(0), f(20_000)], T0 + 10 * 60_000).reason, "too-few-fixes", "stale fixes expire");
  assertEquals(check([f(0), f(10_000), f(20_000, offset(EIFFEL, 400, 0))]).reason, "outside", "already left");
  assertEquals(
    check([f(0, near, 55), f(20_000, near, 55)]).reason,
    "imprecise",
    "accuracy disc crosses the edge",
  );
  assertEquals(check([f(-20_000, LYON), f(0), f(20_000)]).reason, "implausible-track", "Lyon 20 s earlier");
  assertEquals(check([f(0), f(20_000), f(60_000 + 30_000)]).reason, "future-fix");
  assertEquals(check([f(0), f(20_000, near, 0)]).reason, "accuracy-implausible");
  assertEquals(check([f(0), { t: T0, lat: 0, lon: 999, accuracy: 5 }]).reason, "invalid-fix");
  const plaza = { ...EIFFEL, radius: 500 };
  const drive = physicalPresence(
    [f(0, offset(EIFFEL, -150, 0)), f(10_000, offset(EIFFEL, 0, 0)), f(20_000, offset(EIFFEL, 150, 0))],
    plaza,
    now,
  );
  assertEquals(drive.reason, "moving", "driving through is not being there");
  assertThrows(() => physicalPresence([], { ...EIFFEL, radius: 0 }, now));
});

Deno.test("coarsenLocation moves points at most ~cellMeters, is deterministic and idempotent", () => {
  const rng = new Rng(hashSeed("coarsen"));
  for (const cell of [100, 500, 2_000]) {
    for (let i = 0; i < 400; i++) {
      const lat = i < 20 ? rng.range(-90, 90) : rng.range(-89.99, 89.99);
      const lon = i % 50 === 0 ? 179.9999 : rng.range(-180, 180);
      const c = coarsenLocation(lat, lon, cell);
      const moved = haversineM({ lat, lon }, c);
      assert(moved <= cell * (1 + 1e-9), `moved ${moved} m for cell ${cell} at ${lat},${lon}`);
      const again = coarsenLocation(c.lat, c.lon, cell);
      assert(haversineM(c, again) < 1e-6, "snapping a centre returns the same centre");
    }
  }
  const home = coarsenLocation(EIFFEL.lat, EIFFEL.lon);
  assertEquals(home, coarsenLocation(EIFFEL.lat, EIFFEL.lon), "deterministic: no averaging attack");
  const centre = offset(home, 0, 0);
  for (const [n, e] of [[50, 50], [-50, 80], [0, -100]]) {
    const p = offset(centre, n, e);
    assertEquals(coarsenLocation(p.lat, p.lon), home, "nearby points share a cell");
    assertEquals(geoCellId(p.lat, p.lon), geoCellId(centre.lat, centre.lon));
  }
  assert(haversineM(EIFFEL, home) > 1, "the precise point is actually hidden");
  const pole = coarsenLocation(90, 45, 500);
  assert(pole.lat <= 90 && haversineM({ lat: 90, lon: 45 }, pole) <= 500, "pole stays in range");
  assertEquals(geoCellId(0, 180), geoCellId(0, -180), "+180 and -180 are one meridian");
  assertThrows(() => coarsenLocation(NaN, 0));
  assertThrows(() => coarsenLocation(0, 0, 0));
});

Deno.test("travel cooldown grows with distance, flies past ~150 km and is capped at 2 h", () => {
  const min = (m: number) => travelCooldownMs(m) / 60_000;
  assertEquals(travelCooldownMs(0), 0);
  assert(Math.abs(travelCooldownMs(1_000) - 18_182) <= 1, "1 km by road ~18 s");
  assert(Math.abs(min(100_000) - 30.3) < 0.1, "100 km ~30 min (road)");
  assert(Math.abs(min(1_000_000) - 96.7) < 0.1, "1000 km ~97 min (air + 30 min overhead)");
  assertEquals(travelCooldownMs(10_000_000), 7_200_000, "capped at 2 h");
  assertEquals(travelCooldownMs(NaN), 7_200_000, "NaN fails closed");
  let prev = -1;
  for (let km = 0; km <= 3_000; km += 25) {
    const c = travelCooldownMs(km * 1_000);
    assert(c >= prev, "monotonic");
    prev = c;
  }
});

Deno.test("ActionThrottle enforces cooldowns, rolling daily caps and cross-action travel cooldowns", () => {
  const ledger = new Ledger("security");
  const th = new ActionThrottle({
    "catch": { cooldownMs: 3_000, physical: true },
    "world.claim": { cooldownMs: 60_000, maxPerDay: 2, physical: true },
    "market.bid": { cooldownMs: 0, maxPerDay: 3 },
  }, { ledger });
  assertEquals(th.attempt("alice", "catch", T0, PARIS).ok, true);
  assertEquals(th.attempt("alice", "catch", T0 + 1_000, PARIS), {
    ok: false,
    retryInMs: 2_000,
    reason: "cooldown",
  });
  assertEquals(th.attempt("alice", "catch", T0 + 3_000, PARIS).ok, true);
  assertEquals(th.attempt("bob", "catch", T0 + 1_000, PARIS).ok, true, "players are independent");
  // Paris -> Lyon one minute later: refused until the travel cooldown has elapsed.
  const lyon = th.attempt("alice", "world.claim", T0 + 63_000, LYON);
  assertEquals(lyon.reason, "travel-cooldown");
  const wait = travelCooldownMs(haversineM(PARIS, LYON));
  assert(Math.abs(lyon.retryInMs - (T0 + 3_000 + wait - (T0 + 63_000))) <= 1);
  assertEquals(th.check("alice", "world.claim", T0 + 3_000 + wait, LYON).ok, true, "check is a dry run");
  assertEquals(th.attempt("alice", "world.claim", T0 + 3_000 + wait, LYON).ok, true);
  // Rolling 24 h cap.
  for (let i = 0; i < 3; i++) assertEquals(th.attempt("carol", "market.bid", T0 + i).ok, true);
  const capped = th.attempt("carol", "market.bid", T0 + 10);
  assertEquals([capped.reason, capped.retryInMs], ["daily-cap", 86_400_000 - 10]);
  assertEquals(th.attempt("carol", "market.bid", T0 + 86_400_001).ok, true, "window rolls");
  // Unknown and prototype-named actions, physical action without a location.
  assertEquals(th.attempt("alice", "constructor", T0).reason, "unknown-action");
  assertEquals(th.attempt("alice", "__proto__", T0).reason, "unknown-action");
  assertEquals(th.attempt("dave", "catch", T0).reason, "no-location");
  // Only spoofing / farming signals are logged.
  assertEquals(ledger.query({ what: "anticheat.throttle" }).map((r) => r.why), [
    "travel-cooldown",
    "daily-cap",
  ]);
  assertEquals(th.sweep(T0 + 3 * 86_400_000), 3, "idle players are forgotten");
  assertThrows(() => new ActionThrottle({ bad: { cooldownMs: NaN } }));
});
