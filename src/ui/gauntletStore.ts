/**
 * Gauntlet store (UI persistence of src/combat/gauntlet.ts): one JSON document per profile under
 * "genemon.gauntlet.<profileId>" holding the CURRENT run (so a run resumes after a reload), the best
 * streak per Genemon and the last FINISHED_KEPT finished runs.
 *
 * Storage goes through a Storage-like object so it is testable in plain Deno. Fail closed: a missing,
 * unparseable or structurally wrong document reads as an EMPTY state (never a throw, never a partial
 * state); the next write replaces it. Every mutation is written through immediately (no debounce).
 */
import { type GauntletRun, isGauntletRun, scoreOf } from "../combat/gauntlet.ts";

export interface StorageLike {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

/** Finished runs kept for the "last runs" table. */
export const FINISHED_KEPT = 20;

export const gauntletKey = (profileId: string): string => `genemon.gauntlet.${profileId}`;

export interface BestEntry {
  streak: number;
  score: number;
  name: string;
  runId: string;
  at: number;
}

export interface FinishedRun extends GauntletRun {
  endedAt: number;
  score: number;
}

export interface GauntletState {
  kind: "genemon.gauntlet";
  version: 1;
  current: GauntletRun | null;
  best: Record<string, BestEntry>;
  finished: FinishedRun[];
}

export function emptyGauntletState(): GauntletState {
  return { kind: "genemon.gauntlet", version: 1, current: null, best: {}, finished: [] };
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const num = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

function isBest(x: unknown): x is BestEntry {
  return isObj(x) && num(x.streak) && num(x.score) && typeof x.name === "string" && typeof x.runId === "string" && num(x.at);
}

function isFinished(x: unknown): x is FinishedRun {
  return isGauntletRun(x) && num((x as unknown as Record<string, unknown>).endedAt) && num((x as unknown as Record<string, unknown>).score) && !x.alive;
}

/** Parse a stored document; anything unreadable is an empty state (fail closed). */
export function parseGauntletState(raw: string | null): GauntletState {
  if (!raw) return emptyGauntletState();
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch {
    return emptyGauntletState();
  }
  if (!isObj(j) || j.kind !== "genemon.gauntlet" || j.version !== 1) return emptyGauntletState();
  if (!(j.current === null || isGauntletRun(j.current))) return emptyGauntletState();
  if (!isObj(j.best) || !Object.values(j.best).every(isBest)) return emptyGauntletState();
  if (!Array.isArray(j.finished) || !j.finished.every(isFinished)) return emptyGauntletState();
  return {
    kind: "genemon.gauntlet",
    version: 1,
    current: j.current as GauntletRun | null,
    best: j.best as Record<string, BestEntry>,
    finished: (j.finished as FinishedRun[]).slice(0, FINISHED_KEPT),
  };
}

export class GauntletStore {
  readonly profileId: string;
  private readonly storage: StorageLike;
  private state: GauntletState;

  constructor(storage: StorageLike, profileId: string) {
    this.storage = storage;
    this.profileId = profileId;
    this.state = this.load();
  }

  /** Re-read the stored document (fail closed) and return it. */
  load(): GauntletState {
    this.state = parseGauntletState(this.storage.getItem(gauntletKey(this.profileId)));
    return this.state;
  }

  save(): void {
    this.storage.setItem(gauntletKey(this.profileId), JSON.stringify(this.state));
  }

  /** The run in progress (alive), or null. */
  current(): GauntletRun | null {
    return this.state.current;
  }

  /** Replace the run in progress (null clears it). A dead run is routed to finish() instead. */
  setCurrent(run: GauntletRun | null, now = run?.startedAt ?? 0): void {
    if (run && !run.alive) {
      this.finish(run, now);
      return;
    }
    this.state.current = run;
    this.save();
  }

  /**
   * Archive a finished run: newest first in the last-runs list (capped), best streak per Genemon
   * updated (higher streak wins, ties keep the higher score), and the current run cleared when it is
   * this run. Archiving the same run id twice replaces the earlier copy (no duplicates).
   */
  finish(run: GauntletRun, now: number): FinishedRun {
    const done: FinishedRun = { ...run, alive: false, endedAt: now, score: scoreOf({ ...run, alive: false }) };
    this.state.finished = [done, ...this.state.finished.filter((r) => r.id !== run.id)].slice(0, FINISHED_KEPT);
    const prev = this.state.best[run.championId];
    if (!prev || done.streak > prev.streak || (done.streak === prev.streak && done.score > prev.score)) {
      this.state.best[run.championId] = { streak: done.streak, score: done.score, name: run.championName, runId: run.id, at: now };
    }
    if (this.state.current?.id === run.id) this.state.current = null;
    this.save();
    return done;
  }

  /** Best streak of a Genemon (0 when it never ran). */
  best(genemonId: string): number {
    return this.state.best[genemonId]?.streak ?? 0;
  }

  /** Best entry per Genemon, best streak first. */
  bests(): (BestEntry & { genemonId: string })[] {
    return Object.entries(this.state.best).map(([genemonId, b]) => ({ genemonId, ...b }))
      .sort((a, b) => b.streak - a.streak || b.score - a.score || a.genemonId.localeCompare(b.genemonId));
  }

  /** Last finished runs ranked: streak, then score, then the most recent. */
  leaderboard(): FinishedRun[] {
    return [...this.state.finished].sort((a, b) => b.streak - a.streak || b.score - a.score || b.endedAt - a.endedAt);
  }

  /** Last finished runs, most recent first. */
  recent(): FinishedRun[] {
    return [...this.state.finished];
  }
}
