/**
 * Gauntlet (P4-B1, pure): ONE chosen Genemon fights an endless string of random opponents. Its HP
 * is carried from round to round (a little is healed between fights, more after a boss), every 5th
 * round is a boss (higher level, bigger body), and the run ends on the first loss or draw. The
 * streak (rounds won) is the record.
 *
 * Determinism: an opponent depends only on (run.seed, round, championLevel); the battle seed and the
 * arena of a round depend only on (run.seed, round). No clock, no Math.random: `now` is passed in.
 * Updates are immutable (recordRound / abandonRun return a new run). A finished run is final:
 * recordRound() on a dead run THROWS (it is a caller bug: the UI must start a new run).
 */
import { clamp } from "../core/math.ts";
import { hashSeed, Rng } from "../core/rng.ts";
import { ELEMENT_IDS, ELEMENTS, type ElementId } from "../data/elements.ts";
import type { AxisId, AxisVector } from "../data/axes.ts";
import { createGenemon, type Genemon, phenotypeOf } from "../genome/genemon.ts";
import { BODY_KINDS, type GenomeBias } from "../genome/genome.ts";
import { ARENA_KINDS, type ArenaKind } from "../world/arena.ts";

/** Every BOSS_EVERY-th round is a boss. */
export const BOSS_EVERY = 5;
/** Level bonus of a boss over a normal opponent of the same round. */
export const BOSS_LEVEL_BONUS = 4;
/** HP fraction healed after a won round (after a boss: BOSS_HEAL). */
export const HEAL_BETWEEN = 0.25;
export const BOSS_HEAL = 0.5;
/** Owner id of every gauntlet opponent. */
export const GAUNTLET_OWNER = "gauntlet";

export interface GauntletRound {
  round: number;
  opponent: string;
  level: number;
  boss: boolean;
  won: boolean;
  /** Champion HP fraction at the end of the fight (before the between-rounds heal). */
  hpAfter: number;
  durationS: number;
}

export interface GauntletRun {
  id: string;
  championId: string;
  /** Champion name at the start (kept for the records when the Genemon is later renamed/released). */
  championName: string;
  /** Champion level at the start of the run. */
  startLevel: number;
  ownerId: string;
  seed: number;
  /** 1-based number of the NEXT round to fight. */
  round: number;
  /** Rounds won. */
  streak: number;
  /** Champion HP fraction (0..1) at the start of the next round. */
  hpCarry: number;
  alive: boolean;
  /** True when the run ended by "give up" instead of a lost round. */
  gaveUp: boolean;
  startedAt: number;
  history: GauntletRound[];
}

export interface RoundOutcome {
  won: boolean;
  hpFrac: number;
  opponent: string;
  level: number;
  durationS: number;
}

export interface Rewards {
  credits: number;
  xp: number;
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;
const frac = (x: number) => (Number.isFinite(x) ? clamp(x, 0, 1) : 0);

export function isBoss(round: number): boolean {
  return round >= 1 && round % BOSS_EVERY === 0;
}

/** HP fraction healed after winning `round` (bosses heal more). */
export function healBetween(round: number): number {
  return isBoss(round) ? BOSS_HEAL : HEAL_BETWEEN;
}

export function startRun(champion: Genemon, ownerId: string, seed: number, now: number): GauntletRun {
  return {
    id: `gnt-${hashSeed(seed, champion.id, ownerId, now).toString(36)}`,
    championId: champion.id,
    championName: champion.name,
    startLevel: phenotypeOf(champion).level,
    ownerId,
    seed: seed >>> 0,
    round: 1,
    streak: 0,
    hpCarry: 1,
    alive: true,
    gaveUp: false,
    startedAt: now,
    history: [],
  };
}

/** Opponent level of a round: max(1, championLevel - 3 + floor(round * 0.7)), bosses +4. */
export function opponentLevel(round: number, championLevel: number): number {
  return Math.max(1, Math.round(championLevel) - 3 + Math.floor(round * 0.7)) + (isBoss(round) ? BOSS_LEVEL_BONUS : 0);
}

/** Seed of the opponent genome of a round (also its Genemon id basis). */
export function opponentSeed(run: Pick<GauntletRun, "seed">, round: number): number {
  return hashSeed(run.seed, "gauntlet", round);
}

/** Battle seed of the run's NEXT round: the App uses it so a round can be matched to its battle. */
export function battleSeed(run: Pick<GauntletRun, "seed" | "round">): number {
  return hashSeed(run.seed, "gauntlet", run.round, "battle");
}

/** Arena of the run's NEXT round (drawn per round, so the champion sees every ground). */
export function arenaFor(run: Pick<GauntletRun, "seed" | "round">): ArenaKind {
  return new Rng(hashSeed(run.seed, "gauntlet", run.round, "arena")).pick(ARENA_KINDS);
}

const THEMES: readonly ElementId[] = ELEMENT_IDS.filter((e) => e !== "neutral");

/**
 * Genome bias of a round: a random element theme (its axis signature, scaled) so elements vary,
 * a random body kind, and for bosses a pushed stature/weight so they land in a bigger size class.
 */
export function opponentBias(run: Pick<GauntletRun, "seed">, round: number): GenomeBias & { theme: ElementId } {
  const rng = new Rng(opponentSeed(run, round)).fork("bias");
  const theme = rng.pick(THEMES);
  const strength = rng.range(0.6, 1);
  const axes: Partial<AxisVector> = {};
  for (const [k, v] of Object.entries(ELEMENTS[theme].signature) as [AxisId, number][]) axes[k] = clamp(v * strength, -1, 1);
  const kind = rng.pick(BODY_KINDS);
  if (isBoss(round)) {
    axes.stature = clamp(Math.max(axes.stature ?? 0, 0) + 0.75, -1, 1);
    axes.weight = clamp(Math.max(axes.weight ?? 0, 0) + 0.45, -1, 1);
    return { axes, kind, spread: 0.3, theme };
  }
  return { axes, kind, spread: 0.4, theme };
}

/** The opponent of the run's NEXT round. Same (seed, round, championLevel) = the same Genemon. */
export function opponentFor(run: Pick<GauntletRun, "seed" | "round">, championLevel: number): Genemon {
  const round = run.round;
  const b = opponentBias(run, round);
  const bias: GenomeBias = { axes: b.axes, kind: b.kind, spread: b.spread };
  const g = createGenemon({ seed: opponentSeed(run, round), owner: GAUNTLET_OWNER, level: opponentLevel(round, championLevel), bias });
  if (isBoss(round)) g.name = `Boss ${g.name}`;
  return g;
}

/**
 * Fold one fought round into the run (immutable). Win: streak + 1, round + 1, hpCarry =
 * min(1, hpFrac + healBetween(round)). Loss or draw (won === false): alive = false, the round is
 * still recorded. THROWS on a dead run (a finished run never continues).
 */
export function recordRound(run: GauntletRun, r: RoundOutcome): GauntletRun {
  if (!run.alive) throw new Error(`gauntlet run ${run.id} is over (round ${run.round}); start a new run`);
  const hpAfter = frac(r.hpFrac);
  const entry: GauntletRound = {
    round: run.round,
    opponent: String(r.opponent),
    level: Math.round(r.level),
    boss: isBoss(run.round),
    won: r.won === true,
    hpAfter: r3(hpAfter),
    durationS: r3(Math.max(0, Number.isFinite(r.durationS) ? r.durationS : 0)),
  };
  const history = [...run.history, entry];
  if (!entry.won) return { ...run, alive: false, history };
  return {
    ...run,
    round: run.round + 1,
    streak: run.streak + 1,
    hpCarry: r3(Math.min(1, hpAfter + healBetween(run.round))),
    history,
  };
}

/** "Give up": the run ends without a lost round (no-op on a run that is already over). */
export function abandonRun(run: GauntletRun): GauntletRun {
  return run.alive ? { ...run, alive: false, gaveUp: true } : run;
}

/** Reward of winning one round: grows with the round, bosses add a bonus. */
export function roundReward(round: number): Rewards {
  const boss = isBoss(round);
  return { credits: 15 + 5 * round + (boss ? 60 : 0), xp: 20 + 4 * round + (boss ? 50 : 0) };
}

/** Total rewards earned by a run so far (sum of roundReward over its won rounds). */
export function rewardsFor(run: Pick<GauntletRun, "history">): Rewards {
  let credits = 0, xp = 0;
  for (const h of run.history) {
    if (!h.won) continue;
    const r = roundReward(h.round);
    credits += r.credits;
    xp += r.xp;
  }
  return { credits, xp };
}

/** Score: 10 x opponent level per won round (bosses count double) + the carried HP of a live run. */
export function scoreOf(run: Pick<GauntletRun, "history" | "alive" | "hpCarry">): number {
  let s = 0;
  for (const h of run.history) if (h.won) s += 10 * Math.max(1, h.level) * (h.boss ? 2 : 1);
  return s + (run.alive ? Math.round(10 * run.hpCarry) : 0);
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const num = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

function isRound(x: unknown): x is GauntletRound {
  return isObj(x) && num(x.round) && typeof x.opponent === "string" && num(x.level) && typeof x.boss === "boolean" &&
    typeof x.won === "boolean" && num(x.hpAfter) && num(x.durationS);
}

/** Structural check of a stored run (stores fail closed on anything else). */
export function isGauntletRun(x: unknown): x is GauntletRun {
  return isObj(x) && typeof x.id === "string" && typeof x.championId === "string" && typeof x.championName === "string" &&
    num(x.startLevel) && typeof x.ownerId === "string" && num(x.seed) && num(x.round) && x.round >= 1 && num(x.streak) &&
    num(x.hpCarry) && x.hpCarry >= 0 && x.hpCarry <= 1 && typeof x.alive === "boolean" && typeof x.gaveUp === "boolean" &&
    num(x.startedAt) && Array.isArray(x.history) && x.history.every(isRound);
}
