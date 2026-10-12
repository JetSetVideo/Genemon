/**
 * Anti-cheat primitives for physical-world actions (GPS): fix validation, speed plausibility,
 * presence proofs, travel cooldowns, per-player action throttles, and location coarsening.
 *
 * Pure module: no DOM, no clock, no IO, no Math.random. Every time-dependent function takes `now`
 * (ms) as a parameter so decisions are replayable from the ledger.
 *
 * Trust model: these checks are AUTHORITATIVE only when they run on the server over fixes the
 * server itself received. The client may run the same code for UX hints ("you're moving too fast"),
 * but anything executed on the client can be patched, so a client verdict is never evidence.
 *
 * Privacy rule: ledger rows written here never contain raw coordinates. They carry speed, accuracy
 * and a coarse 1 km cell id only, because ledger rows are exported to artifacts/ (ML datasets, AI
 * coding sessions) and a precise location trail reveals home, work and habits. See docs/SECURITY.md.
 */
import type { Ledger } from "../core/ledger.ts";
import { r3 } from "../core/math.ts";

/** One GPS reading. `t` = epoch ms (server-corrected), `accuracy` = confidence radius in metres. */
export interface GpsFix {
  t: number;
  lat: number;
  lon: number;
  /** Horizontal accuracy radius in metres (W3C: 95 % confidence; Android reports 68 %). */
  accuracy: number;
}

export interface LatLon {
  lat: number;
  lon: number;
}

/** IUGG mean Earth radius. */
export const EARTH_RADIUS_M = 6_371_008.8;
const RAD = Math.PI / 180;
/** Metres per degree of latitude on the mean sphere (~111 195 m). */
const M_PER_DEG = EARTH_RADIUS_M * RAD;
const DAY_MS = 86_400_000;

export function isValidLatLon(p: unknown): p is LatLon {
  if (!p || typeof p !== "object") return false;
  const r = p as Record<string, unknown>;
  // NaN and +-Infinity fail these comparisons, so they are rejected too.
  return typeof r.lat === "number" && r.lat >= -90 && r.lat <= 90 &&
    typeof r.lon === "number" && r.lon >= -180 && r.lon <= 180;
}

/** Structural validity only (finite, in range). Plausibility is gpsPlausible's job. */
export function isValidFix(f: unknown): f is GpsFix {
  if (!isValidLatLon(f)) return false;
  const r = f as unknown as Record<string, unknown>;
  return typeof r.t === "number" && Number.isFinite(r.t) && r.t >= 0 &&
    typeof r.accuracy === "number" && Number.isFinite(r.accuracy) && r.accuracy >= 0;
}

/** Great-circle distance in metres (haversine on the mean sphere; < 0.5 % error vs WGS84). */
export function haversineM(a: LatLon, b: LatLon): number {
  const sLat = Math.sin(((b.lat - a.lat) * RAD) / 2);
  const sLon = Math.sin(((b.lon - a.lon) * RAD) / 2);
  const h = sLat * sLat + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * sLon * sLon;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

// ---------------------------------------------------------------------------------------------
// Movement classification

export type MovementMode = "still" | "walk" | "run" | "bike" | "vehicle" | "impossible";

/**
 * Upper bounds (exclusive, m/s). Vehicle tops out at 350 m/s so cars, TGV (89 m/s) and airliners
 * (~250 m/s ground speed) are "vehicle"; nothing a phone rides moves faster than ~Mach 1.
 */
export const MODE_LIMITS_MS: ReadonlyArray<readonly [MovementMode, number]> = [
  ["still", 0.5],
  ["walk", 2.5],
  ["run", 7],
  ["bike", 14],
  ["vehicle", 350],
];

export function movementMode(speedMs: number): MovementMode {
  // NaN, negative and infinite speeds are bugs or forgeries: fail closed.
  if (!(speedMs >= 0) || !Number.isFinite(speedMs)) return "impossible";
  for (const [mode, limit] of MODE_LIMITS_MS) if (speedMs < limit) return mode;
  return "impossible";
}

// ---------------------------------------------------------------------------------------------
// Fix-to-fix plausibility

export interface GpsOptions {
  /** Above this conservative speed the fix cannot back a gameplay action (default 55 m/s ~ 200 km/h). */
  maxSpeedMs?: number;
  /** Above this the jump is physically implausible for a phone: a cheat signal (default 350 m/s). */
  teleportSpeedMs?: number;
  /** Accuracy below this is a mock-location signature: phones never report 0 m (default 1 m). */
  minAccuracyM?: number;
  /** Accuracy above this is too vague to support physical actions (default 150 m). */
  maxAccuracyM?: number;
  /** Optional security ledger: suspicious verdicts emit an 'anticheat.gps' row. */
  ledger?: Ledger;
  who?: string;
  /** Ledger timestamp; defaults to next.t. */
  now?: number;
}

export const GPS_DEFAULTS = {
  maxSpeedMs: 55,
  teleportSpeedMs: 350,
  minAccuracyM: 1,
  maxAccuracyM: 150,
} as const;

export type GpsReason =
  | "invalid-fix"
  | "accuracy-implausible"
  | "time-backwards"
  | "teleport"
  | "too-fast"
  | "imprecise";

export interface GpsVerdict {
  ok: boolean;
  /** Conservative speed (m/s): the slowest movement consistent with both accuracy discs. */
  speed: number;
  mode: MovementMode;
  reason?: GpsReason;
  /** True when the verdict is a cheat signal (vs. merely unusable data like a vague fix). */
  suspicious: boolean;
}

/**
 * Is `next` a plausible successor of `prev`? Speed uses the distance MINUS both accuracy radii, so
 * GPS jitter never reads as movement and nobody is accused because of noise. Reasons, by priority:
 * invalid-fix > accuracy-implausible > time-backwards > teleport > too-fast > imprecise.
 * 'too-fast' (TGV, plane) and 'imprecise' (indoors) refuse the action but are not cheat signals.
 */
export function gpsPlausible(prev: GpsFix | null, next: GpsFix, opts: GpsOptions = {}): GpsVerdict {
  const maxSpeed = opts.maxSpeedMs ?? GPS_DEFAULTS.maxSpeedMs;
  const teleport = opts.teleportSpeedMs ?? GPS_DEFAULTS.teleportSpeedMs;
  const minAcc = opts.minAccuracyM ?? GPS_DEFAULTS.minAccuracyM;
  const maxAcc = opts.maxAccuracyM ?? GPS_DEFAULTS.maxAccuracyM;
  let dtMs = -1;
  let distM = 0;

  const verdict = (ok: boolean, speed: number, reason?: GpsReason, suspicious = false): GpsVerdict => {
    const v: GpsVerdict = { ok, speed, mode: movementMode(speed), suspicious };
    if (reason) v.reason = reason;
    if (suspicious && opts.ledger && reason) {
      const fix = isValidLatLon(next) ? next : null;
      const when = opts.now ?? (isValidFix(next) ? next.t : 0);
      opts.ledger.emit({
        when,
        where: {
          x: 0,
          y: 0,
          z: 0,
          zone: fix ? geoCellId(fix.lat, fix.lon, 1000) : "geo:unknown",
          space: "physical",
        },
        who: opts.who ?? "unknown",
        what: "anticheat.gps",
        why: reason,
        from: opts.who ?? "unknown",
        to: "anticheat",
        entries: {
          speed: Number.isFinite(speed) ? r3(speed) : -1,
          dtMs,
          distM: r3(distM),
          accuracy: isValidFix(next) ? r3(next.accuracy) : -1,
        },
        exits: { ok, reason },
        tags: ["security", "gps"],
      });
    }
    return v;
  };

  if (!isValidFix(next)) return verdict(false, 0, "invalid-fix", true);
  if (next.accuracy < minAcc) return verdict(false, 0, "accuracy-implausible", true);
  let speed = 0;
  if (prev && isValidFix(prev)) {
    dtMs = next.t - prev.t;
    if (dtMs < 0) return verdict(false, 0, "time-backwards", true);
    distM = haversineM(prev, next);
    const minDisplacement = Math.max(0, distM - (prev.accuracy + next.accuracy));
    // Same-timestamp fixes count as 1 ms apart: a real jump at dt=0 becomes a huge finite speed.
    speed = minDisplacement / (Math.max(dtMs, 1) / 1000);
    if (speed > maxSpeed) {
      const isTeleport = speed > teleport;
      return verdict(false, speed, isTeleport ? "teleport" : "too-fast", isTeleport);
    }
  }
  if (next.accuracy > maxAcc) return verdict(false, speed, "imprecise");
  return verdict(true, speed);
}

// ---------------------------------------------------------------------------------------------
// Physical presence at a place (gym, supermarket, territory)

export interface Place {
  lat: number;
  lon: number;
  /** Metres. Size it >= ~30 m: a fix only counts when its whole accuracy disc fits inside. */
  radius: number;
}

export interface PresenceOptions {
  /** Only fixes newer than now - windowMs count (default 5 min). */
  windowMs?: number;
  /** Consecutive inside fixes required (default 2). */
  minFixes?: number;
  /** The inside run must span at least this long (default 10 s): one instant proves nothing. */
  minSpanMs?: number;
  /** Fixes stamped later than now + this are forged or clock-broken (default 30 s). */
  maxFutureMs?: number;
  /** Faster than this inside the place = passing by, not present (default 7 m/s; also: no claiming while driving). */
  maxDwellSpeedMs?: number;
  /** Inside iff distance + accuracyWeight * accuracy <= radius (default 1 = whole disc inside). */
  accuracyWeight?: number;
  /** Speed / accuracy thresholds for the track check (its ledger field is ignored). */
  gps?: GpsOptions;
  /** Optional security ledger: suspicious outcomes emit an 'anticheat.presence' row. */
  ledger?: Ledger;
  who?: string;
}

export type PresenceReason =
  | "ok"
  | "invalid-fix"
  | "accuracy-implausible"
  | "future-fix"
  | "too-few-fixes"
  | "implausible-track"
  | "outside"
  | "imprecise"
  | "too-short"
  | "moving";

export interface PresenceVerdict {
  present: boolean;
  reason: PresenceReason;
  /** Length of the trailing run of consecutive inside fixes. */
  inside: number;
  /** Time covered by that run (ms). */
  spanMs: number;
}

const SUSPICIOUS_PRESENCE: ReadonlySet<PresenceReason> = new Set([
  "invalid-fix",
  "accuracy-implausible",
  "future-fix",
  "implausible-track",
]);

/**
 * Proof that a player is at `place` NOW: the latest fixes (>= minFixes of them, spanning >= minSpanMs)
 * form an unbroken run inside the place, at dwell speed, and the whole recent track contains no
 * teleport. Any malformed, mock-accuracy or future fix voids the whole set (forged data is never
 * partially accepted). The server should prefer fixes it received live via world.move over fixes
 * bundled inside the claim itself.
 */
export function physicalPresence(
  fixes: readonly GpsFix[],
  place: Place,
  now: number,
  opts: PresenceOptions = {},
): PresenceVerdict {
  if (!Number.isFinite(now)) throw new RangeError("physicalPresence: now must be finite");
  if (!isValidLatLon(place) || !(place.radius > 0) || !Number.isFinite(place.radius)) {
    throw new RangeError("physicalPresence: invalid place");
  }
  const windowMs = opts.windowMs ?? 300_000;
  const minFixes = Math.max(1, opts.minFixes ?? 2);
  const minSpanMs = opts.minSpanMs ?? 10_000;
  const maxFutureMs = opts.maxFutureMs ?? 30_000;
  const maxDwell = opts.maxDwellSpeedMs ?? 7;
  const weight = opts.accuracyWeight ?? 1;
  const minAcc = opts.gps?.minAccuracyM ?? GPS_DEFAULTS.minAccuracyM;
  const track: GpsOptions = {
    maxSpeedMs: opts.gps?.maxSpeedMs,
    teleportSpeedMs: opts.gps?.teleportSpeedMs,
    minAccuracyM: minAcc,
    maxAccuracyM: Infinity, // vagueness is judged by the inside test, not by the track
  };

  const out = (present: boolean, reason: PresenceReason, inside = 0, spanMs = 0): PresenceVerdict => {
    if (opts.ledger && SUSPICIOUS_PRESENCE.has(reason)) {
      opts.ledger.emit({
        when: now,
        where: { x: 0, y: 0, z: 0, zone: geoCellId(place.lat, place.lon, 1000), space: "physical" },
        who: opts.who ?? "unknown",
        what: "anticheat.presence",
        why: reason,
        from: opts.who ?? "unknown",
        to: "anticheat",
        entries: { fixes: fixes.length, radius: r3(place.radius) },
        exits: { present, reason },
        tags: ["security", "gps"],
      });
    }
    return { present, reason, inside, spanMs };
  };

  for (const f of fixes) {
    if (!isValidFix(f)) return out(false, "invalid-fix");
    if (f.accuracy < minAcc) return out(false, "accuracy-implausible");
    if (f.t > now + maxFutureMs) return out(false, "future-fix");
  }
  // Copy before sorting (never mutate the caller's array); Array#sort is stable, so this is deterministic.
  const sorted = fixes.filter((f) => f.t >= now - windowMs).sort((a, b) => a.t - b.t);
  const recent: GpsFix[] = [];
  for (const f of sorted) {
    const p = recent[recent.length - 1];
    // Exact resends are harmless duplicates; they must not count twice.
    if (p && p.t === f.t && p.lat === f.lat && p.lon === f.lon && p.accuracy === f.accuracy) continue;
    recent.push(f);
  }
  if (recent.length < minFixes) return out(false, "too-few-fixes");

  const speeds: number[] = [0];
  for (let i = 1; i < recent.length; i++) {
    const v = gpsPlausible(recent[i - 1], recent[i], track);
    if (v.reason === "teleport" || v.reason === "time-backwards") return out(false, "implausible-track");
    speeds.push(v.speed);
  }

  const dist = recent.map((f) => haversineM(f, place));
  const isInside = (i: number) => dist[i] + weight * recent[i].accuracy <= place.radius;
  const last = recent.length - 1;
  if (!isInside(last)) return out(false, dist[last] <= place.radius ? "imprecise" : "outside");

  let first = last;
  while (first > 0 && isInside(first - 1)) first--;
  const inside = last - first + 1;
  const spanMs = recent[last].t - recent[first].t;
  if (inside < minFixes || spanMs < minSpanMs) return out(false, "too-short", inside, spanMs);
  for (let i = first + 1; i <= last; i++) {
    if (speeds[i] > maxDwell) return out(false, "moving", inside, spanMs);
  }
  return out(true, "ok", inside, spanMs);
}

// ---------------------------------------------------------------------------------------------
// Location coarsening (privacy) and grid cells (sharding, ledger zones)

interface Cell {
  row: number;
  col: number;
  lat: number;
  lon: number;
}

/**
 * Snap to a lat/lon grid whose cells are at most ~cellMeters on each side. Rows and columns are
 * integer divisions of 180 deg / 360 deg (rounded UP, so cells are never larger than nominal and never
 * straddle the antimeridian); the column count is derived from the cell-CENTRE latitude, so every
 * point of a row shares one grid (stable ids, idempotent snapping).
 * Guarantee: haversine(point, centre) <= cellMeters everywhere, poles and antimeridian included
 * (<= cellMeters/2 along the meridian + <= cellMeters/2 along the centre's parallel).
 */
function cellOf(lat: number, lon: number, cellMeters: number): Cell {
  if (!isValidLatLon({ lat, lon })) throw new RangeError("geo cell: invalid coordinates");
  if (!(cellMeters > 0) || !Number.isFinite(cellMeters)) {
    throw new RangeError("geo cell: cellMeters must be > 0");
  }
  const nRows = Math.max(1, Math.ceil((180 * M_PER_DEG) / cellMeters));
  const dLat = 180 / nRows;
  const row = Math.min(nRows - 1, Math.floor((lat + 90) / dLat));
  const cLat = -90 + (row + 0.5) * dLat;
  const nCols = Math.max(1, Math.ceil((360 * M_PER_DEG * Math.cos(cLat * RAD)) / cellMeters));
  const dLon = 360 / nCols;
  const L = lon >= 180 ? lon - 360 : lon; // +180 and -180 are the same meridian
  const col = Math.min(nCols - 1, Math.floor((L + 180) / dLon));
  return { row, col, lat: cLat, lon: -180 + (col + 0.5) * dLon };
}

/**
 * Privacy: the location other players may see (home area, presence). Deterministic snapping beats
 * random noise: noise averages out over repeated observations, a fixed cell centre never does.
 */
export function coarsenLocation(lat: number, lon: number, cellMeters = 500): LatLon {
  const c = cellOf(lat, lon, cellMeters);
  return { lat: c.lat, lon: c.lon };
}

/** Stable integer cell id, e.g. "1000:123862:4" (no float formatting, safe as a map/shard key). */
export function geoCellId(lat: number, lon: number, cellMeters = 500): string {
  const c = cellOf(lat, lon, cellMeters);
  return `${cellMeters}:${c.row}:${c.col}`;
}

// ---------------------------------------------------------------------------------------------
// Travel cooldown and per-player action throttle

export interface TravelOptions {
  /** Ground travel speed (default 55 m/s). */
  groundSpeedMs?: number;
  /** Air travel speed (default 250 m/s). */
  airSpeedMs?: number;
  /** Fixed air overhead: airport, boarding (default 30 min). */
  airOverheadMs?: number;
  /** Maximum cooldown (default 2 h): a legit flight to anywhere then costs at most 2 h. */
  capMs?: number;
}

/**
 * Minimum time between two physical actions `distanceM` apart: the faster of driving or flying,
 * capped. ~18 s per km nearby, ~30 min for 100 km, ~97 min for 1000 km, 2 h beyond ~1350 km.
 * A spoofer can still hop between cities, but at most ~12 hops a day instead of thousands.
 */
export function travelCooldownMs(distanceM: number, opts: TravelOptions = {}): number {
  const cap = opts.capMs ?? 7_200_000;
  if (Number.isNaN(distanceM) || distanceM === Infinity) return cap; // fail closed
  if (distanceM <= 0) return 0;
  const ground = (distanceM / (opts.groundSpeedMs ?? 55)) * 1000;
  const air = (opts.airOverheadMs ?? 1_800_000) + (distanceM / (opts.airSpeedMs ?? 250)) * 1000;
  return Math.ceil(Math.min(cap, ground, air));
}

export interface ThrottleRule {
  /** Minimum ms between two actions of this kind by one player. */
  cooldownMs: number;
  /** Rolling 24 h cap (omit = uncapped). */
  maxPerDay?: number;
  /** Requires a location; consecutive physical actions of ANY kind obey travelCooldownMs. */
  physical?: boolean;
}

/** Starting points only: tuning belongs to the world designer and the economist. */
export const DEFAULT_THROTTLE_RULES: Readonly<Record<string, ThrottleRule>> = {
  "catch": { cooldownMs: 3_000, maxPerDay: 300, physical: true },
  "world.claim": { cooldownMs: 60_000, maxPerDay: 20, physical: true },
  "gym.train": { cooldownMs: 30_000, maxPerDay: 60, physical: true },
  "supermarket.buy": { cooldownMs: 10_000, maxPerDay: 100, physical: true },
  "market.post": { cooldownMs: 5_000, maxPerDay: 100 },
  "market.bid": { cooldownMs: 1_000, maxPerDay: 1_000 },
  "friend.add": { cooldownMs: 10_000, maxPerDay: 50 },
  "battle.request": { cooldownMs: 2_000, maxPerDay: 500 },
};

export type ThrottleReason = "unknown-action" | "cooldown" | "daily-cap" | "travel-cooldown" | "no-location";

export interface ThrottleVerdict {
  ok: boolean;
  /** 0 when ok or when waiting cannot help (unknown action, missing location). */
  retryInMs: number;
  reason?: ThrottleReason;
}

interface PlayerThrottle {
  last: Map<string, number>;
  day: Map<string, number[]>;
  phys?: { t: number; lat: number; lon: number };
  seen: number;
}

/**
 * Per-player cooldowns, rolling daily caps and the cross-action travel cooldown. check() is a dry
 * run; attempt() records the action when allowed. 'travel-cooldown' and 'daily-cap' denials are
 * logged ('anticheat.throttle') because they are spoofing / farming signals; plain cooldown
 * denials are normal double-taps and are not.
 */
export class ActionThrottle {
  #rules = new Map<string, ThrottleRule>();
  #players = new Map<string, PlayerThrottle>();
  #ledger?: Ledger;
  #travel: TravelOptions;
  /** Idle time after which a player's state can no longer deny anything (sweep threshold). */
  #horizonMs: number;

  constructor(
    rules: Readonly<Record<string, ThrottleRule>> = DEFAULT_THROTTLE_RULES,
    opts: { ledger?: Ledger; travel?: TravelOptions } = {},
  ) {
    this.#travel = opts.travel ?? {};
    this.#horizonMs = Math.max(DAY_MS, this.#travel.capMs ?? 7_200_000);
    // Own keys only, copied into a Map: rules["constructor"] must never resolve through a prototype.
    for (const key of Object.keys(rules)) {
      const r = rules[key];
      if (!(r.cooldownMs >= 0) || (r.maxPerDay !== undefined && !(r.maxPerDay >= 1))) {
        throw new RangeError(`ActionThrottle: bad rule '${key}'`);
      }
      this.#rules.set(key, r);
      this.#horizonMs = Math.max(this.#horizonMs, r.cooldownMs);
    }
    this.#ledger = opts.ledger;
  }

  check(player: string, action: string, now: number, at?: LatLon): ThrottleVerdict {
    if (!Number.isFinite(now)) throw new RangeError("ActionThrottle: now must be finite");
    const rule = this.#rules.get(action);
    if (!rule) return { ok: false, retryInMs: 0, reason: "unknown-action" };
    const st = this.#players.get(player);
    const last = st?.last.get(action);
    if (last !== undefined) {
      const wait = last + rule.cooldownMs - now;
      if (wait > 0) return { ok: false, retryInMs: Math.ceil(wait), reason: "cooldown" };
    }
    if (rule.maxPerDay !== undefined) {
      const recent = (st?.day.get(action) ?? []).filter((t) => t > now - DAY_MS);
      if (recent.length >= rule.maxPerDay) {
        let oldest = recent[0];
        for (const t of recent) if (t < oldest) oldest = t;
        return { ok: false, retryInMs: Math.max(1, Math.ceil(oldest + DAY_MS - now)), reason: "daily-cap" };
      }
    }
    if (rule.physical) {
      if (!isValidLatLon(at)) return { ok: false, retryInMs: 0, reason: "no-location" };
      const p = st?.phys;
      if (p) {
        const wait = p.t + travelCooldownMs(haversineM(p, at), this.#travel) - now;
        if (wait > 0) return { ok: false, retryInMs: Math.ceil(wait), reason: "travel-cooldown" };
      }
    }
    return { ok: true, retryInMs: 0 };
  }

  attempt(player: string, action: string, now: number, at?: LatLon): ThrottleVerdict {
    const v = this.check(player, action, now, at);
    if (!v.ok) {
      if (this.#ledger && (v.reason === "travel-cooldown" || v.reason === "daily-cap")) {
        const p = this.#players.get(player)?.phys;
        this.#ledger.emit({
          when: now,
          where: {
            x: 0,
            y: 0,
            z: 0,
            zone: isValidLatLon(at) ? geoCellId(at.lat, at.lon, 1000) : "geo:unknown",
            space: "physical",
          },
          who: player,
          what: "anticheat.throttle",
          why: v.reason,
          from: player,
          to: action,
          entries: { action, km: p && isValidLatLon(at) ? r3(haversineM(p, at) / 1000) : -1 },
          exits: { ok: false, reason: v.reason, retryInMs: v.retryInMs },
          tags: ["security", "throttle"],
        });
      }
      return v;
    }
    let st = this.#players.get(player);
    if (!st) {
      st = { last: new Map(), day: new Map(), seen: now };
      this.#players.set(player, st);
    }
    st.seen = Math.max(st.seen, now);
    st.last.set(action, now);
    const rule = this.#rules.get(action)!;
    if (rule.maxPerDay !== undefined) {
      const kept = (st.day.get(action) ?? []).filter((t) => t > now - DAY_MS);
      kept.push(now);
      st.day.set(action, kept);
    }
    if (rule.physical && isValidLatLon(at)) st.phys = { t: now, lat: at.lat, lon: at.lon };
    return v;
  }

  /** Forget players idle beyond every cooldown/cap horizon (their state can no longer deny anything). */
  sweep(now: number): number {
    let removed = 0;
    for (const [player, st] of this.#players) {
      if (now - st.seen > this.#horizonMs) {
        this.#players.delete(player);
        removed++;
      }
    }
    return removed;
  }

  get size(): number {
    return this.#players.size;
  }
}
