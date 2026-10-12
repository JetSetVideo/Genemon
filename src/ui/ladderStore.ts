/**
 * Persistence and battle wiring of the condition-aware ladder (src/ladder/mmr.ts): every battle
 * the app finishes is recorded with its PRE-MATCH conditions (src/ladder/context.ts), the ladder
 * is saved to localStorage under "genemon.ladder", and a compact "why did my rating move" summary
 * of the last match is kept under "genemon.ladder.last" for the Ladder screen.
 *
 * Every id is rated like any player, local profile or not ("rival", "wild", "mirror"). Storage
 * goes through a Storage-like object so the whole path is testable in plain Deno; only
 * recordBattle() reads the clock (UI code passes `Date.now()` down as the match's `when`).
 */
import type { BattleResult } from "../combat/battle.ts";
import type { Team } from "../combat/team.ts";
import type { Ledger } from "../core/ledger.ts";
import { r3 } from "../core/math.ts";
import { matchContext, matchResultFrom } from "../ladder/context.ts";
import { type Contribution, Ladder, type LadderJSON, type MatchResult, type RecordOutcome } from "../ladder/mmr.ts";
import type { ArenaSpec } from "../world/arena.ts";

export const LADDER_KEY = "genemon.ladder";
export const LAST_MATCH_KEY = "genemon.ladder.last";
/** Contributions kept for the "why did my rating move" panel (largest |logit| first). */
export const TOP_CONTRIBUTIONS = 4;

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** What the store needs from the app (App satisfies it structurally): the ledger to emit into. */
export interface LadderHost {
  readonly ledger?: Ledger;
}

/** Compact summary of the last recorded match, from side A's perspective (values rounded to 3 dp). */
export interface LastMatch {
  when: number;
  a: string;
  b: string;
  scoreA: number;
  arena: string;
  weather: string;
  winCondition: string;
  /** Condition-aware pre-match expected score of A. */
  expected: number;
  /** Classic Elo expectation from the ratings alone. */
  ratingOnly: number;
  ratingLogit: number;
  contextLogit: number;
  /** K actually applied. */
  k: number;
  deltaA: number;
  deltaB: number;
  /** Ratings after the match. */
  ratingA: number;
  ratingB: number;
  /** The TOP_CONTRIBUTIONS largest pushes on A's log-odds (feature, value, effective weight, logit). */
  top: Contribution[];
}

export interface RecordedMatch extends RecordOutcome {
  match: MatchResult;
  last: LastMatch;
}

export interface BattleRating {
  expected: number;
  deltaA: number;
  deltaB: number;
  /** False when the battle was not rated (same owner on both sides, or a ladder error). */
  rated: boolean;
}

// ------------------------------------------------------------------------------- validation

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const finite = (x: unknown): boolean => typeof x === "number" && Number.isFinite(x);

const NUMBER_OPTIONS = ["k", "base", "lr", "l2", "l2Interaction", "provisionalGames", "provisionalMult", "maxWeight"];
const BOOLEAN_OPTIONS = ["interactions", "comboFeature"];
const TALLY_DIMS = ["arena", "weather", "combo", "winCondition"];

function isTallies(x: unknown): boolean {
  if (x === undefined) return true;
  if (!isObj(x)) return false;
  return TALLY_DIMS.every((d) => {
    const dim = x[d];
    if (dim === undefined) return true;
    return isObj(dim) && Object.values(dim).every((t) => isObj(t) && ["wins", "losses", "draws", "expSum"].every((k) => finite(t[k])));
  });
}

/** Structural check of a stored ladder: anything else (old format, hand-edited, truncated) is rejected. */
function isLadderJSON(j: unknown): j is LadderJSON {
  if (!isObj(j) || j.kind !== "genemon.ladder" || j.version !== 1) return false;
  const o = j.options;
  if (!isObj(o)) return false;
  if (NUMBER_OPTIONS.some((k) => o[k] !== undefined && !finite(o[k]))) return false;
  if (BOOLEAN_OPTIONS.some((k) => o[k] !== undefined && typeof o[k] !== "boolean")) return false;
  if (j.matches !== undefined && !finite(j.matches)) return false;
  const players = j.players;
  if (!isObj(players)) return false;
  if (!Object.values(players).every((p) => isObj(p) && ["rating", "games", "wins", "losses", "draws"].every((k) => finite(p[k])))) {
    return false;
  }
  if (j.weights !== undefined && (!isObj(j.weights) || !Object.values(j.weights).every(finite))) return false;
  const t = j.tallies;
  if (t !== undefined) {
    if (!isObj(t) || !isTallies(t.global)) return false;
    if (t.players !== undefined && (!isObj(t.players) || !Object.values(t.players).every(isTallies))) return false;
  }
  return true;
}

function isLastMatch(x: unknown): x is LastMatch {
  if (!isObj(x)) return false;
  const nums = ["when", "scoreA", "expected", "ratingOnly", "ratingLogit", "contextLogit", "k", "deltaA", "deltaB", "ratingA", "ratingB"];
  return typeof x.a === "string" && typeof x.b === "string" && typeof x.arena === "string" &&
    typeof x.weather === "string" && typeof x.winCondition === "string" && nums.every((k) => finite(x[k])) &&
    Array.isArray(x.top) &&
    x.top.every((c: unknown) => isObj(c) && typeof c.name === "string" && finite(c.value) && finite(c.weight) && finite(c.logit));
}

// ------------------------------------------------------------------------------- persistence

/** The stored ladder, or a fresh one when the key is missing, unreadable or not a ladder. */
export function loadLadder(storage: StorageLike, ledger?: Ledger): Ladder {
  try {
    const raw = storage.getItem(LADDER_KEY);
    if (raw) {
      const j: unknown = JSON.parse(raw);
      if (isLadderJSON(j)) return Ladder.fromJSON(j, ledger);
    }
  } catch {
    // Corrupt JSON or a storage that throws: start a fresh ladder rather than break the app.
  }
  return new Ladder({ ledger });
}

/** Persist the ladder; false when the storage refused it (quota, private mode). */
export function saveLadder(storage: StorageLike, ladder: Ladder): boolean {
  try {
    storage.setItem(LADDER_KEY, JSON.stringify(ladder.toJSON()));
    return true;
  } catch (e) {
    console.warn("ladder save failed (storage full?)", e);
    return false;
  }
}

export function loadLastMatch(storage: StorageLike): LastMatch | null {
  try {
    const raw = storage.getItem(LAST_MATCH_KEY);
    if (!raw) return null;
    const j: unknown = JSON.parse(raw);
    return isLastMatch(j) ? j : null;
  } catch {
    return null;
  }
}

export function saveLastMatch(storage: StorageLike, last: LastMatch): boolean {
  try {
    storage.setItem(LAST_MATCH_KEY, JSON.stringify(last));
    return true;
  } catch (e) {
    console.warn("ladder last-match save failed", e);
    return false;
  }
}

// ------------------------------------------------------------------------------- recording

const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The pure path behind recordBattle(): context from the teams and arena FIRST, then the result,
 * then one ladder.record(). The explanation is taken before the record, so it shows the exact
 * pre-match expectation and weights the rating update used.
 */
export function recordMatch(
  ladder: Ladder,
  result: BattleResult,
  teams: readonly [Team, Team],
  arena: ArenaSpec,
  when: number,
): RecordedMatch {
  const context = matchContext(teams[0], teams[1], arena);
  const match = matchResultFrom(result, teams, arena, context, when);
  const why = ladder.explain(match.a, match.b, context, match);
  const out = ladder.record(match);
  const top = why.contributions
    .slice()
    .sort((x, y) => Math.abs(y.logit) - Math.abs(x.logit) || Math.abs(y.value) - Math.abs(x.value) || byName(x.name, y.name))
    .slice(0, TOP_CONTRIBUTIONS)
    .map((c) => ({ name: c.name, value: r3(c.value), weight: r3(c.weight), logit: r3(c.logit) }));
  return {
    ...out,
    match,
    last: {
      when,
      a: match.a,
      b: match.b,
      scoreA: match.scoreA,
      arena: match.arena,
      weather: match.weather,
      winCondition: match.winCondition ?? "",
      expected: r3(out.expected),
      ratingOnly: r3(out.ratingOnly),
      ratingLogit: r3(why.ratingLogit),
      contextLogit: r3(why.contextLogit),
      k: r3(out.k),
      deltaA: r3(out.deltaA),
      deltaB: r3(out.deltaB),
      ratingA: r3(ladder.rating(match.a)),
      ratingB: r3(ladder.rating(match.b)),
      top,
    },
  };
}

let current: { ladder: Ladder; storage: StorageLike } | null = null;

/** The app's ladder, loaded lazily from storage on first use (one instance per storage). */
export function getLadder(app: LadderHost, storage: StorageLike = globalThis.localStorage): Ladder {
  if (current === null || current.storage !== storage) current = { ladder: loadLadder(storage, app.ledger), storage };
  return current.ladder;
}

/** Forget the cached ladder (tests; or after the stored ladder was replaced). */
export function resetLadder(): void {
  current = null;
}

/**
 * Rate a finished battle: pre-match context (teams + arena only), one ladder record (which emits a
 * `ladder.match` ledger row), save, keep the last-match summary. Call it BEFORE the battle result
 * is folded into the Genemon (applyBattleResult changes xp, battle records and so phenotypes).
 * A battle between two teams of the same owner is not rated.
 */
export function recordBattle(
  app: LadderHost,
  result: BattleResult,
  teams: readonly [Team, Team],
  arena: ArenaSpec,
  storage: StorageLike = globalThis.localStorage,
): BattleRating {
  if (teams[0].owner === teams[1].owner) return { expected: 0.5, deltaA: 0, deltaB: 0, rated: false };
  const ladder = getLadder(app, storage);
  try {
    const rec = recordMatch(ladder, result, teams, arena, Date.now());
    saveLadder(storage, ladder);
    saveLastMatch(storage, rec.last);
    return { expected: rec.expected, deltaA: rec.deltaA, deltaB: rec.deltaB, rated: true };
  } catch (e) {
    console.error("ladder: battle not rated", e);
    return { expected: 0.5, deltaA: 0, deltaB: 0, rated: false };
  }
}
