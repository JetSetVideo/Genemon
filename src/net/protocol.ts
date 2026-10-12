/**
 * Genemon wire protocol v1: pure primitives shared by client, server and future peers.
 * Envelope = header + body + SHA-256 over the canonical JSON of everything but `hash`.
 *
 * Pure module: no DOM, no IO, no clock (callers pass `now`), randomness only via core Rng.
 * WebCrypto (crypto.subtle) is the only platform dependency; it exists in Deno and browsers.
 *
 * READ THIS BEFORE TRUSTING AN ENVELOPE: `hash` is an integrity checksum and content id, NOT
 * authentication. Anyone can recompute it after editing a message. Sender identity comes from the
 * transport (TLS + server session, enforced here through `expectFrom`); peer-to-peer relays will
 * need device signatures (see docs/NETWORK.md, docs/SECURITY.md).
 *
 * Receiver pipeline (order matters): raw frame size cap -> JSON.parse -> TokenBucket.take
 * -> verifyEnvelope({ expectFrom, nonces }) -> per-type body validation -> handler -> ledger.
 */
import type { GEvent, Ledger, Where } from "../core/ledger.ts";
import { r3 } from "../core/math.ts";
import { hashSeed, type Rng } from "../core/rng.ts";
import type { GpsFix } from "./antiCheat.ts";

export const PROTOCOL_VERSION = 1;

export const MSG_TYPES = [
  "hello",
  "presence",
  "battle.request",
  "battle.result",
  "market.post",
  "market.bid",
  "world.claim",
  "world.move",
  "friend.add",
  "genemon.sync",
] as const;
export type MsgType = typeof MSG_TYPES[number];

export function isMsgType(t: unknown): t is MsgType {
  return typeof t === "string" && (MSG_TYPES as readonly string[]).includes(t);
}

export interface Envelope<T = unknown> {
  v: number;
  type: MsgType;
  /** Sender account id (server-issued). Must equal the authenticated session (expectFrom). */
  from: string;
  /** Per-sender sequence number (ordering / gap detection; replay safety comes from nonce + skew). */
  seq: number;
  /** Unique per sender within the replay window. 16-128 chars of [A-Za-z0-9_-]. */
  nonce: string;
  /** Sender clock, epoch ms, already corrected by the offset learned in `hello`. */
  sentAt: number;
  body: T;
  /** sha256 hex of canonicalJSON(envelope without hash). */
  hash: string;
}

// ---------------------------------------------------------------------------------------------
// Limits (tunable; every value is a security decision, see docs/NETWORK.md)

/** Accept sentAt within +-30 s of the receiver clock (after the hello clock-offset correction). */
export const DEFAULT_MAX_SKEW_MS = 30_000;
/** INVARIANT: nonce TTL >= 2 * max skew, else a replay can outlive its nonce yet pass the skew check. */
export const DEFAULT_NONCE_TTL_MS = 2 * DEFAULT_MAX_SKEW_MS;
/** Nesting limit for canonicalJSON: deep attacker JSON must fail cleanly, not blow the stack. */
export const MAX_DEPTH = 32;
/** Canonical-size limits per type (bytes). verifyEnvelope's maxBytes overrides. */
export const MAX_BYTES: Readonly<Record<MsgType, number>> = {
  "hello": 2_048,
  "presence": 1_024,
  "battle.request": 4_096,
  "battle.result": 4_096,
  "market.post": 2_048,
  "market.bid": 1_024,
  "world.claim": 8_192,
  "world.move": 1_024,
  "friend.add": 1_024,
  "genemon.sync": 65_536,
};
/** Account / item ids: short, printable, no spaces or control chars (safe in logs and keys). */
export const ID_RE = /^[A-Za-z0-9._:@-]{1,128}$/;
/** Nonces: hex, base64url or UUID; >= 16 chars so they carry >= 64 bits. */
export const NONCE_RE = /^[A-Za-z0-9_-]{16,128}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
/** Bytes `"hash":"<64 hex>"` plus one comma add to the canonical form of the unsigned envelope. */
const HASH_FIELD_BYTES = 74;
const ENVELOPE_KEYS: ReadonlySet<string> = new Set([
  "v",
  "type",
  "from",
  "seq",
  "nonce",
  "sentAt",
  "body",
  "hash",
]);
/** Keys that turn a naive merge into prototype pollution. Rejected anywhere inside a body. */
export const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

export const NET_WHERE: Where = { x: 0, y: 0, z: 0, zone: "net", space: "device" };

const encoder = new TextEncoder();

export function utf8Length(text: string): number {
  return encoder.encode(text).byteLength;
}

// ---------------------------------------------------------------------------------------------
// Canonical JSON + hashing

/**
 * Deterministic JSON: object keys sorted by UTF-16 code units, no whitespace, numbers and strings
 * exactly as JSON.stringify writes them. For JSON values this equals RFC 8785 (JCS), so a server in
 * another language can verify hashes with any JCS library.
 *
 * Injective over what it accepts, hence strict: throws on NaN/Infinity, functions, symbols, bigint,
 * undefined inside arrays (incl. holes), cycles, nesting > MAX_DEPTH and any non-plain object
 * (Date, Map, Set, class instances: JSON.stringify would silently turn a Map into {} and make two
 * different values share a hash). `undefined` object properties are omitted, like JSON, so
 * canonicalJSON(JSON.parse(canonicalJSON(x))) === canonicalJSON(x) always holds: that round trip is
 * what lets a receiver re-derive the sender's hash. toJSON() is never called.
 */
export function canonicalJSON(value: unknown): string {
  const out: string[] = [];
  writeCanonical(value, "$", 0, new Set<object>(), out);
  return out.join("");
}

function writeCanonical(v: unknown, path: string, depth: number, stack: Set<object>, out: string[]): void {
  switch (typeof v) {
    case "string":
      out.push(JSON.stringify(v));
      return;
    case "number":
      if (!Number.isFinite(v)) throw new TypeError(`canonicalJSON: non-finite number at ${path}`);
      out.push(JSON.stringify(v)); // -0 -> "0"; shortest round-trip digits (ECMAScript = JCS)
      return;
    case "boolean":
      out.push(v ? "true" : "false");
      return;
    case "object":
      break;
    default:
      throw new TypeError(`canonicalJSON: unsupported ${typeof v} at ${path}`);
  }
  if (v === null) {
    out.push("null");
    return;
  }
  if (depth >= MAX_DEPTH) throw new RangeError(`canonicalJSON: nesting deeper than ${MAX_DEPTH} at ${path}`);
  if (stack.has(v)) throw new TypeError(`canonicalJSON: cycle at ${path}`);
  stack.add(v);
  if (Array.isArray(v)) {
    out.push("[");
    for (let i = 0; i < v.length; i++) {
      if (i) out.push(",");
      writeCanonical(v[i], `${path}[${i}]`, depth + 1, stack, out); // holes read as undefined -> throw
    }
    out.push("]");
  } else {
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError(`canonicalJSON: non-plain object at ${path}`);
    }
    const rec = v as Record<string, unknown>;
    out.push("{");
    let first = true;
    for (const key of Object.keys(rec).sort()) {
      const item = rec[key];
      if (item === undefined) continue;
      if (!first) out.push(",");
      first = false;
      out.push(JSON.stringify(key), ":");
      writeCanonical(item, `${path}.${key}`, depth + 1, stack, out);
    }
    out.push("}");
  }
  stack.delete(v);
}

/** Path of the first prototype-pollution key ('__proto__', 'constructor', 'prototype'), or null. */
export function findForbiddenKey(value: unknown, path = "$", depth = 0): string | null {
  if (typeof value !== "object" || value === null) return null;
  if (depth > MAX_DEPTH) return `${path}<too-deep>`;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findForbiddenKey(value[i], `${path}[${i}]`, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) return `${path}.${key}`;
    const hit = findForbiddenKey((value as Record<string, unknown>)[key], `${path}.${key}`, depth + 1);
    if (hit) return hit;
  }
  return null;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
  let hex = "";
  for (const b of digest) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/** Content hash of any canonical value (Genemon state hashes, team commitments, replay ids). */
export async function hashCanonical(value: unknown): Promise<string> {
  return await sha256Hex(canonicalJSON(value));
}

/**
 * 128-bit nonce (32 hex) drawn from a core Rng (house rule: no Math.random). Nonces only need to be
 * UNIQUE per sender within the replay window, not secret. In production seed the session Rng from
 * crypto.getRandomValues at the IO edge so two devices never share a nonce stream; server-issued
 * challenges (which must be unpredictable) use crypto.getRandomValues directly, never this.
 */
export function makeNonce(rng: Rng): string {
  let s = "";
  for (let i = 0; i < 4; i++) s += Math.floor(rng.next() * 4294967296).toString(16).padStart(8, "0");
  return s;
}

// ---------------------------------------------------------------------------------------------
// Envelopes

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** First invalid header field name, or null. Shared by seal (throws) and verifyEnvelope (rejects). */
function headerProblem(r: Record<string, unknown>): string | null {
  if (typeof r.from !== "string" || !ID_RE.test(r.from)) return "from";
  if (typeof r.seq !== "number" || !Number.isSafeInteger(r.seq) || r.seq < 0) return "seq";
  if (typeof r.nonce !== "string" || !NONCE_RE.test(r.nonce)) return "nonce";
  if (typeof r.sentAt !== "number" || !Number.isSafeInteger(r.sentAt) || r.sentAt < 0) return "sentAt";
  return null;
}

/**
 * Build a sealed envelope. Throws TypeError on anything a receiver would reject structurally
 * (bad header, undefined or non-canonical body, prototype-pollution keys) so bugs surface at the
 * sender. Size and clock are receiver policy and are not checked here.
 */
export async function seal<T>(
  type: MsgType,
  from: string,
  seq: number,
  nonce: string,
  sentAt: number,
  body: T,
): Promise<Envelope<T>> {
  const unsigned = { v: PROTOCOL_VERSION, type, from, seq, nonce, sentAt, body };
  if (!isMsgType(type)) throw new TypeError(`seal: unknown message type '${String(type)}'`);
  const bad = headerProblem(unsigned);
  if (bad) throw new TypeError(`seal: invalid ${bad}`);
  if (body === undefined) throw new TypeError("seal: body must not be undefined (use null)");
  const forbidden = findForbiddenKey(body, "$.body");
  if (forbidden) throw new TypeError(`seal: forbidden key at ${forbidden}`);
  const hash = await sha256Hex(canonicalJSON(unsigned));
  return { ...unsigned, hash };
}

/** UTF-8 size of the canonical form of a whole envelope (what MAX_BYTES limits). */
export function envelopeBytes(e: Envelope): number {
  return utf8Length(canonicalJSON(e));
}

export type RejectReason =
  | "malformed"
  | "schema"
  | "version"
  | "unknown-type"
  | "from-mismatch"
  | "stale"
  | "future"
  | "not-canonical"
  | "too-large"
  | "forbidden-key"
  | "hash-mismatch"
  | "replay"
  | "nonce-flood";

export interface VerifyOptions {
  /** Receiver clock, epoch ms. */
  now: number;
  maxSkewMs?: number;
  /** Overrides MAX_BYTES[type]. */
  maxBytes?: number;
  /** Authenticated session identity: envelope.from must equal it (anti-spoofing). */
  expectFrom?: string;
  /** Replay protection; the nonce is recorded only after every other check passed. */
  nonces?: NonceCache;
  /** Security ledger: each rejection emits one 'net.reject' row. Rate-limit BEFORE verifying. */
  ledger?: Ledger;
  where?: Where;
}

export interface Verdict {
  ok: boolean;
  reason?: RejectReason;
}

/**
 * Validate an untrusted, already-parsed message. Cheap checks run first (shape, version, type,
 * identity, clock), then canonicalization (bounded by MAX_DEPTH), size, forbidden keys, the hash,
 * and finally the nonce, so forged envelopes can never burn a legitimate sender's nonce.
 * Never throws for bad input; throws only for bad OPTIONS (a NaN `now` would silently disable the
 * clock check, so it is a loud error instead).
 */
export async function verifyEnvelope(e: unknown, opts: VerifyOptions): Promise<Verdict> {
  if (!Number.isFinite(opts.now)) throw new RangeError("verifyEnvelope: opts.now must be finite");
  const skew = opts.maxSkewMs ?? DEFAULT_MAX_SKEW_MS;
  if (!(skew >= 0) || !Number.isFinite(skew)) throw new RangeError("verifyEnvelope: bad maxSkewMs");
  if (opts.maxBytes !== undefined && !(opts.maxBytes > 0)) {
    throw new RangeError("verifyEnvelope: bad maxBytes");
  }

  const reject = (reason: RejectReason): Verdict => {
    if (opts.ledger) {
      const r = isPlainRecord(e) ? e : {};
      const who = typeof r.from === "string" && ID_RE.test(r.from) ? r.from : "unknown";
      opts.ledger.emit({
        when: opts.now,
        where: opts.where ?? NET_WHERE,
        who,
        what: "net.reject",
        why: reason,
        from: who,
        to: "net",
        entries: {
          type: isMsgType(r.type) ? r.type : "unknown",
          seq: typeof r.seq === "number" && Number.isSafeInteger(r.seq) ? r.seq : -1,
        },
        exits: { ok: false, reason },
        tags: ["security", "net"],
      });
    }
    return { ok: false, reason };
  };

  try {
    if (!isPlainRecord(e)) return reject("malformed");
    const keys = Object.keys(e);
    if (keys.length !== ENVELOPE_KEYS.size || !keys.every((k) => ENVELOPE_KEYS.has(k))) {
      return reject("schema");
    }
    if (typeof e.v !== "number") return reject("schema");
    if (e.v !== PROTOCOL_VERSION) return reject("version");
    if (!isMsgType(e.type)) return reject("unknown-type");
    if (headerProblem(e) || typeof e.hash !== "string" || !HEX64_RE.test(e.hash)) return reject("schema");
    const from = e.from as string, nonce = e.nonce as string, sentAt = e.sentAt as number;
    if (opts.expectFrom !== undefined && from !== opts.expectFrom) return reject("from-mismatch");
    if (opts.now - sentAt > skew) return reject("stale");
    if (sentAt - opts.now > skew) return reject("future");

    const { hash, ...unsigned } = e;
    let canon: string;
    try {
      canon = canonicalJSON(unsigned);
    } catch {
      return reject("not-canonical");
    }
    if (utf8Length(canon) + HASH_FIELD_BYTES > (opts.maxBytes ?? MAX_BYTES[e.type])) {
      return reject("too-large");
    }
    if (findForbiddenKey(e.body) !== null) return reject("forbidden-key");
    if ((await sha256Hex(canon)) !== hash) return reject("hash-mismatch");
    if (opts.nonces) {
      const n = opts.nonces.check(from, nonce, opts.now);
      if (n === "replay") return reject("replay");
      if (n === "full") return reject("nonce-flood");
    }
    return { ok: true };
  } catch {
    // Proxies / throwing getters can only come from in-process callers, never from JSON.parse.
    return reject("malformed");
  }
}

// ---------------------------------------------------------------------------------------------
// Replay protection

/**
 * Remembers (sender, nonce) pairs for ttlMs (inclusive). Keep ttlMs >= 2 * maxSkewMs: an envelope
 * accepted at sentAt - skew can be replayed until sentAt + skew. Memory is bounded per sender:
 * beyond maxPerSender live nonces that sender alone is refused ('full'), others are unaffected.
 */
export class NonceCache {
  readonly ttlMs: number;
  readonly maxPerSender: number;
  #bySender = new Map<string, Map<string, number>>();

  constructor(ttlMs: number = DEFAULT_NONCE_TTL_MS, opts: { maxPerSender?: number } = {}) {
    if (!(ttlMs > 0) || !Number.isFinite(ttlMs)) throw new RangeError("NonceCache: ttlMs must be > 0");
    this.ttlMs = ttlMs;
    this.maxPerSender = opts.maxPerSender ?? 4096;
  }

  /** 'fresh' (now recorded), 'replay' (seen within ttl) or 'full' (sender over its budget; not recorded). */
  check(from: string, nonce: string, now: number): "fresh" | "replay" | "full" {
    if (!Number.isFinite(now)) throw new RangeError("NonceCache: now must be finite");
    let seen = this.#bySender.get(from);
    if (!seen) {
      seen = new Map();
      this.#bySender.set(from, seen);
    }
    for (const [n, exp] of seen) {
      if (exp >= now) break; // insertion order == expiry order while time moves forward
      seen.delete(n);
    }
    const exp = seen.get(nonce);
    if (exp !== undefined && exp >= now) return "replay";
    if (seen.size >= this.maxPerSender) return "full";
    seen.delete(nonce); // re-insert at the end so iteration order stays expiry order
    seen.set(nonce, now + this.ttlMs);
    return "fresh";
  }

  /** Spec API: true if (from, nonce) was already seen within ttl (or the sender is flooding). */
  seen(from: string, nonce: string, now: number): boolean {
    return this.check(from, nonce, now) !== "fresh";
  }

  /** Drop expired nonces and empty senders; returns how many nonces were removed. */
  sweep(now: number): number {
    let removed = 0;
    for (const [from, seen] of this.#bySender) {
      for (const [n, exp] of seen) {
        if (exp < now) {
          seen.delete(n);
          removed++;
        }
      }
      if (seen.size === 0) this.#bySender.delete(from);
    }
    return removed;
  }

  get size(): number {
    let n = 0;
    for (const seen of this.#bySender.values()) n += seen.size;
    return n;
  }
}

// ---------------------------------------------------------------------------------------------
// Rate limiting

/**
 * Classic token bucket per key: `capacity` burst, `refillPerSec` sustained. New keys start full.
 * Time going backwards never refills. With a ledger, denials are logged at the 1st, 2nd, 4th, 8th...
 * denial of a burst: a flood costs O(log n) rows instead of evicting real evidence from the ring
 * buffer. Use account ids or salted hashes as keys, never raw IP addresses (personal data).
 */
export class TokenBucket {
  readonly capacity: number;
  readonly refillPerSec: number;
  #buckets = new Map<string, { tokens: number; last: number; denied: number }>();
  #ledger?: Ledger;
  #name: string;

  constructor(capacity: number, refillPerSec: number, opts: { ledger?: Ledger; name?: string } = {}) {
    if (!(capacity > 0) || !Number.isFinite(capacity)) {
      throw new RangeError("TokenBucket: capacity must be > 0");
    }
    if (!(refillPerSec >= 0) || !Number.isFinite(refillPerSec)) {
      throw new RangeError("TokenBucket: bad refill rate");
    }
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.#ledger = opts.ledger;
    this.#name = opts.name ?? "bucket";
  }

  #refill(key: string, now: number) {
    if (!Number.isFinite(now)) throw new RangeError("TokenBucket: now must be finite");
    let b = this.#buckets.get(key);
    if (!b) {
      b = { tokens: this.capacity, last: now, denied: 0 };
      this.#buckets.set(key, b);
    } else if (now > b.last) {
      b.tokens = Math.min(this.capacity, b.tokens + ((now - b.last) / 1000) * this.refillPerSec);
      b.last = now;
    }
    return b;
  }

  take(key: string, now: number, cost = 1): boolean {
    if (!(cost > 0) || !Number.isFinite(cost)) throw new RangeError("TokenBucket: cost must be > 0");
    const b = this.#refill(key, now);
    if (b.tokens >= cost) {
      b.tokens -= cost;
      b.denied = 0;
      return true;
    }
    b.denied++;
    if (this.#ledger && (b.denied & (b.denied - 1)) === 0) {
      this.#ledger.emit({
        when: now,
        where: NET_WHERE,
        who: key,
        what: "net.ratelimit",
        why: `${this.#name} empty`,
        from: key,
        to: this.#name,
        entries: { cost, tokens: r3(b.tokens) },
        exits: { ok: false, denied: b.denied },
        tags: ["security", "net"],
      });
    }
    return false;
  }

  /** Tokens available now (refills, consumes nothing). */
  peek(key: string, now: number): number {
    return this.#refill(key, now).tokens;
  }

  /** Remove buckets that are full again: indistinguishable from a fresh key, so lossless. */
  sweep(now: number): number {
    let removed = 0;
    for (const [key, b] of this.#buckets) {
      if (b.tokens + (Math.max(0, now - b.last) / 1000) * this.refillPerSec >= this.capacity) {
        this.#buckets.delete(key);
        removed++;
      }
    }
    return removed;
  }

  get size(): number {
    return this.#buckets.size;
  }
}

// ---------------------------------------------------------------------------------------------
// Deterministic battle claims

export interface BattleClaim {
  /** uint32. Must be server-issued or commit-reveal derived (deriveBattleSeed): a client-chosen seed can be ground offline. */
  seed: number;
  arena: string;
  weather: string;
  /** Team members as Genemon state hashes (hashCanonical of genome + conditions + moves), in battle order. */
  teamA: string[];
  teamB: string[];
  resultHash: string;
  winner: "A" | "B" | "draw";
}

export const BATTLE_DOMAIN = "genemon.battle.v1";
export const MAX_TEAM = 6;

/**
 * Hash binding a battle's full definition to its outcome. Picks the claim fields explicitly (a stray
 * resultHash or extra field never changes it) and prefixes a domain tag so a battle hash can never
 * collide with an envelope hash or any other canonical hash.
 */
export async function battleClaimHash(c: Omit<BattleClaim, "resultHash">, outcome: unknown): Promise<string> {
  const claim = {
    seed: c.seed,
    arena: c.arena,
    weather: c.weather,
    teamA: c.teamA,
    teamB: c.teamB,
    winner: c.winner,
  };
  return await sha256Hex(canonicalJSON({ domain: BATTLE_DOMAIN, claim, outcome }));
}

/** What the battle engine returns when the server re-simulates a claim. */
export type Resimulate = (
  c: Omit<BattleClaim, "resultHash" | "winner">,
) =>
  | { winner: BattleClaim["winner"]; outcome: unknown }
  | Promise<{ winner: BattleClaim["winner"]; outcome: unknown }>;

export type BattleRejectReason = "schema" | "resim-error" | "winner-mismatch" | "hash-mismatch";

function battleClaimProblem(c: unknown): boolean {
  if (!isPlainRecord(c)) return true;
  const team = (t: unknown) =>
    Array.isArray(t) && t.length >= 1 && t.length <= MAX_TEAM &&
    t.every((x) => typeof x === "string" && ID_RE.test(x));
  const label = (s: unknown) => typeof s === "string" && s.length >= 1 && s.length <= 64;
  return !(typeof c.seed === "number" && Number.isInteger(c.seed) && c.seed >= 0 && c.seed <= 0xffffffff &&
    label(c.arena) && label(c.weather) && team(c.teamA) && team(c.teamB) &&
    (c.winner === "A" || c.winner === "B" || c.winner === "draw") &&
    typeof c.resultHash === "string" && HEX64_RE.test(c.resultHash));
}

/**
 * Server-side check of a claimed result: re-simulate from the claim's inputs with the deterministic
 * engine, then compare winner and outcome hash. The client's own result is never trusted.
 */
export async function verifyBattleClaim(
  claim: unknown,
  resimulate: Resimulate,
  log?: { ledger: Ledger; now: number; who?: string },
): Promise<{ ok: boolean; reason?: BattleRejectReason; expectedHash?: string }> {
  const reject = (reason: BattleRejectReason, expectedHash?: string) => {
    log?.ledger.emit({
      when: log.now,
      where: { x: 0, y: 0, z: 0, zone: "net", space: "arena" },
      who: log.who ?? "unknown",
      what: "net.battle.reject",
      why: reason,
      from: log.who ?? "unknown",
      to: "battle",
      entries: { seed: isPlainRecord(claim) && typeof claim.seed === "number" ? claim.seed : -1 },
      exits: { ok: false, reason },
      tags: ["security", "battle"],
    });
    return expectedHash ? { ok: false, reason, expectedHash } : { ok: false, reason };
  };
  if (battleClaimProblem(claim)) return reject("schema");
  const c = claim as unknown as BattleClaim;
  const inputs = { seed: c.seed, arena: c.arena, weather: c.weather, teamA: c.teamA, teamB: c.teamB };
  let sim: { winner: BattleClaim["winner"]; outcome: unknown };
  let expected: string;
  try {
    sim = await resimulate(inputs);
    expected = await battleClaimHash({ ...inputs, winner: sim.winner }, sim.outcome);
  } catch {
    return reject("resim-error");
  }
  if (sim.winner !== c.winner) return reject("winner-mismatch", expected);
  if (expected !== c.resultHash) return reject("hash-mismatch", expected);
  return { ok: true, expectedHash: expected };
}

/**
 * Fair battle seed: server salt + both players' revealed secrets (each committed earlier as
 * hashCanonical({ domain, secret })). Nobody controls the result alone; whoever aborts after seeing
 * the opponent's reveal forfeits. Uses core hashSeed, so the seed is a uint32 like every Rng seed.
 */
export function deriveBattleSeed(serverSalt: string, revealA: string, revealB: string): number {
  return hashSeed("genemon.battle.seed.v1", serverSalt, revealA, revealB);
}

// ---------------------------------------------------------------------------------------------
// Message bodies v1 (draft contract; validators per type are a next quest, see docs/NETWORK.md)

export interface HelloBody {
  /** Client build id (bundle hash). */
  build: string;
  /** Capabilities, e.g. ["gps", "lockstep"]. */
  caps: string[];
  /** Client clock at send time; the server answers with its own clock to compute the offset. */
  clientNow: number;
}
export interface PresenceBody {
  status: "online" | "away" | "battling" | "offline";
  /** Coarse geoCellId (>= 500 m), only when the player opted in. Never raw GPS. */
  cell?: string;
}
export interface BattleRequestBody {
  opponent: string;
  ranked: boolean;
  /** hashCanonical({ domain: "genemon.team.v1", team, salt }): the team stays hidden until both lock. */
  teamCommit: string;
  /** Commitment to this player's seed secret (see deriveBattleSeed). */
  seedCommit: string;
  arena?: string;
}
export type BattleResultBody = BattleClaim;
export interface MarketPostBody {
  kind: "genemon" | "item";
  item: string;
  qty: number;
  /** Integer credits (never floats: no rounding games, no NaN prices). */
  startPrice: number;
  buyout?: number;
  durationMs: number;
}
export interface MarketBidBody {
  listing: string;
  /** Integer credits; the server escrows it immediately. */
  amount: number;
}
export interface WorldClaimBody {
  territory: string;
  /** Supporting fixes; the server prefers the fixes it received live via world.move. */
  fixes: GpsFix[];
}
export interface WorldMoveBody {
  space: "physical" | "virtual";
  /** Physical space: one raw fix, server-only (never relayed to other players). */
  fix?: GpsFix;
  /** Virtual space (arenas, dungeons): position inside `zone`. */
  pos?: { x: number; y: number; z: number };
  zone?: string;
}
export interface FriendAddBody {
  player: string;
  /** Short-lived code shown as a QR in person: makes the edge a "met in person" friendship. */
  code?: string;
}
export interface GenemonSyncBody {
  genemon: string;
  /** Last local ledger seq the server acknowledged; rows continue from there. */
  fromSeq: number;
  /** Offline actions as ledger rows, replayed and validated server-side (event sourcing). */
  rows: GEvent[];
  /** Client's hashCanonical of the resulting Genemon; the server's own replay wins on mismatch. */
  stateHash: string;
}

export interface BodyByType {
  "hello": HelloBody;
  "presence": PresenceBody;
  "battle.request": BattleRequestBody;
  "battle.result": BattleResultBody;
  "market.post": MarketPostBody;
  "market.bid": MarketBidBody;
  "world.claim": WorldClaimBody;
  "world.move": WorldMoveBody;
  "friend.add": FriendAddBody;
  "genemon.sync": GenemonSyncBody;
}

/** Typed convenience over seal(): the body type follows the message type. */
export function sealTyped<K extends MsgType>(
  type: K,
  from: string,
  seq: number,
  nonce: string,
  sentAt: number,
  body: BodyByType[K],
): Promise<Envelope<BodyByType[K]>> {
  return seal(type, from, seq, nonce, sentAt, body);
}
