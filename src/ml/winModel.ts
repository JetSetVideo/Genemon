/**
 * Battle win predictor: the job of the dependency-free MLP (src/ml/mlp.ts). Pure (no DOM, no
 * clock) and deterministic: every draw goes through an Rng forked from the seed.
 *
 *   corpus    simulateCorpus(n, seed) / CorpusJob: n headless battles with the REAL engine (Battle):
 *             random autoTeams at matched levels (like the game's rival matchmaking), random arenas,
 *             one of the arena's weathers, a random hour. A row holds only what is known BEFORE
 *             the battle (features, arena, weather, hour, combos) plus the label `win` (1 = side A
 *             won, 0 = side B won, 0.5 = draw). Nothing measured during the fight enters a row.
 *   features  WIN_FEATURES: the ladder's 8 condition features (matchContext, antisymmetric), 10
 *             team-summary gaps A - B (antisymmetric) and 4 shared conditions (the same for both
 *             sides: they can only matter through interactions, which a network can learn).
 *   training  trainWinModel(rows, seed) / WinTrainer: a seeded train/holdout split, inputs z-scored
 *             on the training rows, a [d, 8, 1] tanh/sigmoid MLP fitted by cross-entropy with early
 *             stopping (a validation split of the TRAINING rows picks the epoch count, then the net
 *             is refitted on all training rows), compared on the holdout with (a) the training base
 *             rate, (b) logistic regression on the same inputs (a [d, 1] MLP IS logistic regression),
 *             (c) logistic regression on the ladder's 8 condition features only (the ladder's model
 *             family, fitted offline) and (d) the ladder's own expectation after one online pass
 *             over the training matches (exactly as live).
 *   report    holdout log-loss (+ standard error, + paired difference vs the network), accuracy on
 *             decisive battles, Brier score, a 10-bin calibration table, permutation feature
 *             importance, train/holdout loss curves and the model as JSON (winPredictor()).
 *
 * Both jobs are resumable - advance(shouldYield) - so the UI can run them in small chunks; where
 * they yield never changes the result (pinned by tests/ml_insights_test.ts).
 * Doc: docs/AI-AND-DATA.md §7 (outcome predictor).
 */
import { Battle } from "../combat/battle.ts";
import { isDamaging } from "../combat/moves.ts";
import { ALL_MOVE_BY_ID as MOVE_BY_ID } from "../combat/kit.ts";
import { autoTeam, type Team } from "../combat/team.ts";
import { clamp } from "../core/math.ts";
import { hashSeed, Rng } from "../core/rng.ts";
import { type Weather, WEATHERS } from "../data/weather.ts";
import { createGenemon, phenotypeOf } from "../genome/genemon.ts";
import type { Phenotype } from "../genome/phenotype.ts";
import { isDayHour, MATCH_FEATURES, matchContext, teamCombos } from "../ladder/context.ts";
import { Ladder, type MatchContext, makeContext } from "../ladder/mmr.ts";
import { ARENA_INFO, ARENA_KINDS, type ArenaSpec } from "../world/arena.ts";
import { MLP, type MLPJSON, type Sample } from "./mlp.ts";
import { wilson } from "./stats.ts";

// ------------------------------------------------------------------------------------ features

export type FeatureGroup = "condition" | "team" | "shared";

export interface WinFeature {
  name: string;
  group: FeatureGroup;
  /** Short UI label. */
  label: string;
  note: string;
}

/**
 * The input columns, in order. condition = the ladder's context (src/ladder/context.ts);
 * team = A minus B (swapping the sides negates them); shared = identical for both sides.
 */
export const WIN_FEATURES: readonly WinFeature[] = [
  { name: "typeAdvantage", group: "condition", label: "Type advantage", note: "Type-chart edge of A's damaging moves over B's types, minus the reverse." },
  { name: "arenaAffinity", group: "condition", label: "Arena ground", note: "How much A's elements thrive on the arena's grounds, minus B's." },
  { name: "weatherAffinity", group: "condition", label: "Weather", note: "How much the weather boosts A's move elements, minus B's." },
  { name: "powerDiff", group: "condition", label: "Team power", note: "(power A - power B) / (power A + power B), slot-normalised." },
  { name: "synergyDiff", group: "condition", label: "Team synergy", note: "Synergy score A minus B (sociality, coverage, reactions, synergy bonuses)." },
  { name: "sizeDiff", group: "condition", label: "Size and mass", note: "tanh(ln(mass A / mass B) / 2)." },
  { name: "reachDiff", group: "condition", label: "Reach", note: "tanh((mean reach A - mean reach B) / 2 m)." },
  { name: "rhythmFit", group: "condition", label: "Time of day", note: "Day/night fit at the match hour, A minus B." },
  { name: "levelGap", group: "team", label: "Level gap", note: "tanh((mean level A - mean level B) / 5)." },
  { name: "memberGap", group: "team", label: "Member count", note: "(members A - members B) / 6: a swarm against a few big bodies." },
  { name: "hpGap", group: "team", label: "Total HP", note: "tanh(ln(total max HP A / total max HP B))." },
  { name: "attackGap", group: "team", label: "Attack", note: "tanh(ln(mean attack A / mean attack B))." },
  { name: "defenceGap", group: "team", label: "Defence", note: "tanh(ln(mean defence A / mean defence B))." },
  { name: "speedGap", group: "team", label: "Speed", note: "tanh(ln(mean ground speed A / mean ground speed B))." },
  { name: "tempoGap", group: "team", label: "Phase speed", note: "tanh(ln(mean charge/rest speed A / B))." },
  { name: "evasionGap", group: "team", label: "Evasion", note: "clamp(4 (mean evasion A - mean evasion B), -1, 1)." },
  { name: "rangedGap", group: "team", label: "Ranged share", note: "Share of damaging moves that hit from afar (projectile, beam, zone), A minus B." },
  { name: "flyerGap", group: "team", label: "Flyers", note: "Share of members that can fly, A minus B." },
  { name: "meanLevel", group: "shared", label: "Battle level", note: "Mean level of both teams / 50." },
  { name: "teamSize", group: "shared", label: "Crowd", note: "(members A + members B) / 12." },
  { name: "daylight", group: "shared", label: "Daylight", note: "1 by day (7h-19h, as the engine), 0 at night." },
  { name: "wetness", group: "shared", label: "Wet weather", note: "The weather's wetness: rain and storms soak everyone (conduction)." },
];

export const WIN_FEATURE_NAMES: readonly string[] = WIN_FEATURES.map((f) => f.name);

/** The ladder's condition features (matchContext), in canonical order. */
export const CONDITION_FEATURES: readonly string[] = MATCH_FEATURES;

const RANGED_SHAPES = new Set<string>(["projectile", "beam", "zone"]);

interface SideSummary {
  n: number;
  level: number;
  hp: number;
  atk: number;
  def: number;
  spd: number;
  rate: number;
  evasion: number;
  ranged: number;
  flyers: number;
}

function summarize(t: Team): SideSummary {
  const phs = t.members.map((g) => phenotypeOf(g));
  const n = phs.length;
  const avg = (f: (p: Phenotype) => number): number => (n > 0 ? phs.reduce((s, p) => s + f(p), 0) / n : 0);
  let damaging = 0, ranged = 0;
  for (const g of t.members) {
    for (const id of g.moves) {
      const m = MOVE_BY_ID[id];
      if (!m || !isDamaging(m)) continue;
      damaging++;
      if (RANGED_SHAPES.has(m.shape)) ranged++;
    }
  }
  return {
    n,
    level: avg((p) => p.level),
    hp: phs.reduce((s, p) => s + p.stats.hp, 0),
    atk: avg((p) => p.stats.atk),
    def: avg((p) => p.stats.def),
    spd: avg((p) => p.stats.spd),
    rate: avg((p) => p.stats.rate),
    evasion: avg((p) => p.stats.evasion),
    ranged: damaging > 0 ? ranged / damaging : 0,
    flyers: avg((p) => (p.abilities.fly ? 1 : 0)),
  };
}

/** tanh(ln a - ln b): written as a difference of logs so swapping the sides negates it bit for bit. */
function logGap(a: number, b: number): number {
  return Math.tanh(Math.log(Math.max(1e-6, a)) - Math.log(Math.max(1e-6, b)));
}

/**
 * The pre-match feature vector of `a` vs `b` on `arena`, in WIN_FEATURES order. Reads only what
 * exists before a battle: phenotypes, loadouts, the arena spec, the starting weather and the hour.
 */
export function winFeatures(a: Team, b: Team, arena: ArenaSpec): number[] {
  const ctx = matchContext(a, b, arena);
  const v: Record<string, number> = {};
  ctx.names.forEach((n, i) => (v[n] = ctx.features[i]));
  const A = summarize(a), B = summarize(b);
  v.levelGap = Math.tanh((A.level - B.level) / 5);
  v.memberGap = (A.n - B.n) / 6;
  v.hpGap = logGap(A.hp, B.hp);
  v.attackGap = logGap(A.atk, B.atk);
  v.defenceGap = logGap(A.def, B.def);
  v.speedGap = logGap(A.spd, B.spd);
  v.tempoGap = logGap(A.rate, B.rate);
  v.evasionGap = clamp(4 * (A.evasion - B.evasion), -1, 1);
  v.rangedGap = A.ranged - B.ranged;
  v.flyerGap = A.flyers - B.flyers;
  v.meanLevel = (A.level + B.level) / 100;
  v.teamSize = (A.n + B.n) / 12;
  v.daylight = isDayHour(arena.hour) ? 1 : 0;
  v.wetness = (WEATHERS as Partial<Record<string, Weather>>)[arena.weather]?.wetness ?? 0;
  return WIN_FEATURES.map((f) => (Number.isFinite(v[f.name]) ? v[f.name] : 0));
}

// ------------------------------------------------------------------------------------ corpus

export interface CorpusOptions {
  /** Shared base level range of both teams, inclusive (default 5..40). */
  minLevel?: number;
  maxLevel?: number;
  /** Each candidate's level = base +- up to this (default 3): matched, not identical, teams. */
  levelJitter?: number;
  /** Candidates drawn per side before autoTeam picks the team (default 8). */
  pool?: number;
  /** Battle time limit in seconds (default: the engine's). */
  maxTime?: number;
}

/** One corpus battle as set up BEFORE it is fought: fully determined by (seed, index). */
export interface CorpusMatch {
  index: number;
  /** Battle seed. */
  seed: number;
  arena: ArenaSpec;
  teams: [Team, Team];
}

export interface WinRow {
  /** Pre-match features, parallel to WIN_FEATURE_NAMES. */
  features: number[];
  /** The label, and the ONLY field set after the battle: 1 = side A won, 0 = side B won, 0.5 = draw. */
  win: number;
  arena: string;
  /** Starting weather. */
  weather: string;
  hour: number;
  /** What each side fielded (teamCombos): pre-match tags for the ladder's comboEdge. */
  combosA: string[];
  combosB: string[];
}

export type PreMatchRow = Omit<WinRow, "win">;

const PREFS = ["big", "swarm", "balanced"] as const;

export function corpusMatch(seed: number, index: number, options: CorpusOptions = {}): CorpusMatch {
  const lo = Math.floor(options.minLevel ?? 5), hi = Math.max(lo, Math.floor(options.maxLevel ?? 40));
  const jitter = Math.max(0, Math.floor(options.levelJitter ?? 3));
  const poolSize = Math.max(1, Math.floor(options.pool ?? 8));
  const rng = new Rng(hashSeed(seed, "winModel.corpus", index));
  const base = rng.int(lo, hi);
  const side = (owner: "A" | "B"): Team => {
    const pool = Array.from({ length: poolSize }, (_, k) =>
      createGenemon({ seed: hashSeed(seed, index, owner, k), owner, level: clamp(base + rng.int(-jitter, jitter), 1, 60) }));
    return autoTeam(pool, owner, hashSeed(seed, index, owner, "team"), rng.pick(PREFS));
  };
  const teams: [Team, Team] = [side("A"), side("B")];
  const kind = rng.pick(ARENA_KINDS);
  const arena: ArenaSpec = {
    seed: hashSeed(seed, index, "arena"),
    kind,
    weather: rng.pick(ARENA_INFO[kind].weathers),
    hour: Math.round(rng.range(0, 24) * 4) / 4,
  };
  return { index, seed: hashSeed(seed, index, "battle"), arena, teams };
}

/** Everything a corpus row knows before its battle is fought. */
export function preMatchRow(m: CorpusMatch): PreMatchRow {
  return {
    features: winFeatures(m.teams[0], m.teams[1], m.arena),
    arena: m.arena.kind,
    weather: m.arena.weather,
    hour: m.arena.hour,
    combosA: teamCombos(m.teams[0]),
    combosB: teamCombos(m.teams[1]),
  };
}

/** What the fights produced (for the UI's corpus summary; never part of a row). */
export interface CorpusStats {
  aWins: number;
  bWins: number;
  draws: number;
  timeouts: number;
  /** Simulated seconds over all battles. */
  gameSeconds: number;
  /** Engine ticks over all battles. */
  ticks: number;
}

/** Engine steps between two shouldYield() checks (~0.5 ms of work). */
const STEP_CHUNK = 64;

/**
 * A resumable corpus simulation. advance() steps battles until the corpus is done, shouldYield()
 * returns true (checked every STEP_CHUNK engine steps and after each battle) or `maxBattles`
 * battles finished in this call. The rows never depend on where it yielded.
 */
export class CorpusJob {
  readonly total: number;
  readonly seed: number;
  readonly options: CorpusOptions;
  readonly rows: WinRow[] = [];
  readonly stats: CorpusStats = { aWins: 0, bWins: 0, draws: 0, timeouts: 0, gameSeconds: 0, ticks: 0 };
  #current: { battle: Battle; pre: PreMatchRow } | null = null;

  constructor(n: number, seed: number, options: CorpusOptions = {}) {
    if (!Number.isInteger(n) || n < 0) throw new Error(`CorpusJob: n must be a non-negative integer (got ${n})`);
    this.total = n;
    this.seed = seed;
    this.options = { ...options };
  }

  get done(): number {
    return this.rows.length;
  }

  get finished(): boolean {
    return this.rows.length >= this.total;
  }

  advance(shouldYield: () => boolean = () => false, maxBattles = Infinity): boolean {
    let finishedHere = 0;
    while (!this.finished) {
      if (!this.#current) {
        const m = corpusMatch(this.seed, this.rows.length, this.options);
        // The features are read BEFORE the battle exists: nothing it measures can leak into them.
        const pre = preMatchRow(m);
        this.#current = { battle: new Battle({ seed: m.seed, arena: m.arena, teams: m.teams, maxTime: this.options.maxTime }), pre };
      }
      const b = this.#current.battle;
      for (let k = 0; b.winner === null && k < STEP_CHUNK; k++) b.step();
      if (b.winner === null) {
        if (shouldYield()) return false;
        continue;
      }
      const r = b.result();
      this.rows.push({ ...this.#current.pre, win: r.winner === 0 ? 1 : r.winner === 1 ? 0 : 0.5 });
      if (r.winner === 0) this.stats.aWins++;
      else if (r.winner === 1) this.stats.bWins++;
      else this.stats.draws++;
      if (r.reason === "timeout") this.stats.timeouts++;
      this.stats.gameSeconds += r.duration;
      this.stats.ticks += b.tick;
      this.#current = null;
      finishedHere++;
      if (this.finished) break;
      if (finishedHere >= maxBattles || shouldYield()) return false;
    }
    return true;
  }
}

/** n headless battles (seeded), one pre-match row each. */
export function simulateCorpus(n: number, seed: number, options: CorpusOptions = {}): WinRow[] {
  const job = new CorpusJob(n, seed, options);
  job.advance();
  return job.rows;
}

// ------------------------------------------------------------------------------------ training

export interface WinModelOptions {
  /** Share of the rows held out for evaluation (default 0.25). */
  holdout?: number;
  /** Hidden tanh units (default 8). */
  hidden?: number;
  /** Maximum network epochs (default 200). */
  epochs?: number;
  /**
   * Early stopping: the network first trains on (1 - validation) of the training rows and stops
   * once the validation loss has not improved for `patience` epochs; it is then refitted on all the
   * training rows for the best epoch count. 0 disables it (train `epochs` epochs). Default 25.
   */
  patience?: number;
  /** Share of the training rows used as the early-stopping validation set (default 0.3). */
  validation?: number;
  /** Epochs of the two logistic baselines (default 100). */
  logisticEpochs?: number;
  /** SGD learning rate (default 0.05). */
  lr?: number;
  batchSize?: number;
  /** L2 weight decay of every fitted model (default 0.03: strong, ~300 training battles are few). */
  l2?: number;
  /** Shuffles per feature in the permutation importance (default 5). */
  permutations?: number;
  /** Column names, parallel to the rows' features (default WIN_FEATURE_NAMES). */
  names?: readonly string[];
}

export type ModelId = "nn" | "logistic" | "conditions" | "ladder" | "base";

export interface ModelScore {
  id: ModelId;
  label: string;
  /** Mean holdout cross-entropy (draws are soft labels 0.5). */
  logLoss: number;
  /** Standard error of that mean. */
  logLossSE: number;
  /** Paired: this model's log-loss minus the network's on the same rows (> 0 = the network is better). */
  vsNN: number;
  vsNNSE: number;
  /** Share of the decisive holdout battles whose winner it called (p >= 0.5 calls side A). */
  accuracy: number;
  /** Mean (p - y)^2. */
  brier: number;
}

export interface CalibrationBin {
  /** Predicted-probability range [lo, hi) (the last bin includes 1). */
  lo: number;
  hi: number;
  n: number;
  /** Mean predicted P(A wins) of the rows in the bin (bin middle when empty). */
  meanP: number;
  /** Observed mean score of side A (draw = 0.5); 0 when empty. */
  observed: number;
  /** Wilson 95% interval of A's win rate over the bin's decisive battles ([0, 1] when none). */
  ciLo: number;
  ciHi: number;
}

export interface FeatureImportance {
  name: string;
  /** Mean increase of the network's holdout log-loss when this column is shuffled. */
  delta: number;
  /** Standard deviation of that increase over the shuffles. */
  sd: number;
  /** Logistic-regression coefficient (log-odds per standard deviation; > 0 = good for A). */
  coef: number;
}

export interface WinModelJSON {
  kind: "genemon.winModel";
  version: 1;
  names: string[];
  /** z-scoring applied before the network: x' = (x - mean) / std. */
  mean: number[];
  std: number[];
  mlp: MLPJSON;
}

export interface WinModelReport {
  seed: number;
  names: string[];
  nTrain: number;
  nHoldout: number;
  /** Decisive holdout battles (the accuracy denominator). */
  nDecisive: number;
  /** Mean training label: P(A wins) with draws as 0.5. */
  baseRate: number;
  /** nn, logistic, conditions, ladder, base (the last three only when the condition columns exist). */
  scores: ModelScore[];
  /** Network calibration, 10 equal-width bins; every holdout row lands in exactly one bin. */
  calibration: CalibrationBin[];
  calibrationLogistic: CalibrationBin[];
  /** Sorted by decreasing importance. */
  importance: FeatureImportance[];
  /**
   * The early-stopping run: network loss per epoch on the rows it trained on and on the validation
   * rows (empty when early stopping is off); bestEpoch = the epochs the final network was fitted for.
   */
  curve: { train: number[]; validation: number[]; bestEpoch: number };
  /** Training loss per epoch of the final network (all training rows). */
  fitCurve: number[];
  /** Global weights the ladder learned in its single online pass (no arena/weather offsets). */
  ladderWeights: Record<string, number>;
  model: WinModelJSON;
  paramCount: number;
  options: {
    holdout: number;
    hidden: number;
    epochs: number;
    patience: number;
    validation: number;
    logisticEpochs: number;
    lr: number;
    batchSize: number;
    l2: number;
    permutations: number;
  };
}

const EPS = 1e-12;

function rowLoss(p: number, y: number): number {
  const q = clamp(p, EPS, 1 - EPS);
  return -(y * Math.log(q) + (1 - y) * Math.log(1 - q));
}

function meanSE(xs: readonly number[]): { mean: number; se: number } {
  const n = xs.length;
  if (n === 0) return { mean: NaN, se: NaN };
  const m = xs.reduce((s, x) => s + x, 0) / n;
  if (n < 2) return { mean: m, se: NaN };
  const v = xs.reduce((s, x) => s + (x - m) * (x - m), 0) / (n - 1);
  return { mean: m, se: Math.sqrt(v / n) };
}

/** 10 (or `bins`) equal-width bins over [0, 1]: count, mean prediction, observed score, Wilson CI. */
export function calibrationTable(p: readonly number[], y: readonly number[], bins = 10): CalibrationBin[] {
  if (p.length !== y.length) throw new Error(`calibrationTable: ${p.length} predictions but ${y.length} labels`);
  const nb = Math.max(1, Math.floor(bins));
  const acc = Array.from({ length: nb }, () => ({ n: 0, sp: 0, sy: 0, wins: 0, decisive: 0 }));
  for (let i = 0; i < p.length; i++) {
    const q = Number.isFinite(p[i]) ? clamp(p[i], 0, 1) : 0.5;
    const b = acc[Math.min(nb - 1, Math.floor(q * nb))];
    b.n++;
    b.sp += q;
    b.sy += y[i];
    if (y[i] === 1) b.wins++;
    if (y[i] === 1 || y[i] === 0) b.decisive++;
  }
  return acc.map((b, i) => {
    const ci = wilson(b.wins, b.decisive);
    return {
      lo: i / nb,
      hi: (i + 1) / nb,
      n: b.n,
      meanP: b.n > 0 ? b.sp / b.n : (i + 0.5) / nb,
      observed: b.n > 0 ? b.sy / b.n : 0,
      ciLo: ci.lo,
      ciHi: ci.hi,
    };
  });
}

/** A ready-to-call P(A wins | features) from a trained model's JSON. */
export function winPredictor(model: WinModelJSON): (features: readonly number[]) => number {
  const net = MLP.fromJSON(model.mlp);
  const d = model.names.length;
  return (features) => {
    if (features.length !== d) throw new Error(`winPredictor: expected ${d} features, got ${features.length}`);
    return net.forward(features.map((v, i) => ((Number.isFinite(v) ? v : 0) - model.mean[i]) / model.std[i]))[0];
  };
}

type TrainPhase = "select" | "nn" | "logistic" | "conditions" | "report" | "done";

const MODEL_LABELS: Record<ModelId, string> = {
  nn: "Neural network (all inputs)",
  logistic: "Logistic regression (same inputs)",
  conditions: "Logistic regression (ladder's 8 conditions)",
  ladder: "Ladder expectation (one online pass)",
  base: "Base rate",
};

/** The label as a ladder score: exactly 0, 0.5 or 1. */
function scoreOf(y: number): 0 | 0.5 | 1 {
  return y >= 0.75 ? 1 : y <= 0.25 ? 0 : 0.5;
}

/**
 * Resumable training (see the module doc). Construct, call advance(shouldYield) until it returns
 * true (one epoch of one model between two shouldYield() checks), then report().
 *
 * Phases: select (early stopping on a validation split of the training rows) -> nn (refit on all
 * training rows for the best epoch count) -> logistic -> conditions -> report. Every model has its
 * own Rng fork, so the phases cannot influence each other.
 */
export class WinTrainer {
  readonly seed: number;
  readonly names: string[];
  readonly options: WinModelReport["options"];
  #phase: TrainPhase;
  #epoch = 0;
  #rows: readonly WinRow[];
  #trainIdx: number[];
  #holdIdx: number[];
  #mean: number[];
  #std: number[];
  #condIdx: number[];
  #train: Sample[];
  #inner: Sample[];
  #valid: Sample[];
  #hold: Sample[];
  #trainCond: Sample[];
  #sel: MLP;
  #nn: MLP;
  #lr: MLP;
  #cond: MLP | null;
  #root: Rng;
  #selRng: Rng;
  #nnRng: Rng;
  #lrRng: Rng;
  #condRng: Rng;
  #bestVal = Infinity;
  #bestEpoch = 0;
  #nnEpochs: number;
  #curve: { train: number[]; validation: number[] } = { train: [], validation: [] };
  #fitCurve: number[] = [];
  #report: WinModelReport | null = null;

  constructor(rows: readonly WinRow[], seed: number, options: WinModelOptions = {}) {
    const names = [...(options.names ?? WIN_FEATURE_NAMES)];
    if (rows.length < 10) throw new Error(`WinTrainer: need at least 10 rows (got ${rows.length})`);
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].features.length !== names.length) {
        throw new Error(`WinTrainer: row ${i} has ${rows[i].features.length} features, expected ${names.length}`);
      }
    }
    const holdout = clamp(options.holdout ?? 0.25, 0.05, 0.9);
    this.options = {
      holdout,
      hidden: Math.max(1, Math.floor(options.hidden ?? 8)),
      epochs: Math.max(1, Math.floor(options.epochs ?? 200)),
      patience: Math.max(0, Math.floor(options.patience ?? 25)),
      validation: clamp(options.validation ?? 0.3, 0.05, 0.5),
      logisticEpochs: Math.max(1, Math.floor(options.logisticEpochs ?? 100)),
      lr: options.lr ?? 0.05,
      batchSize: Math.max(1, Math.floor(options.batchSize ?? 16)),
      l2: options.l2 ?? 0.03,
      permutations: Math.max(1, Math.floor(options.permutations ?? 5)),
    };
    const o = this.options;
    this.seed = seed;
    this.names = names;
    this.#rows = rows;
    this.#root = new Rng(hashSeed(seed, "winModel"));
    const n = rows.length;
    const nHold = clamp(Math.round(n * holdout), 1, n - 2);
    const order = this.#root.fork("split").shuffle(Array.from({ length: n }, (_, i) => i));
    // Both splits keep the corpus order: the ladder learns online, in the order battles happened.
    this.#holdIdx = order.slice(0, nHold).sort((a, b) => a - b);
    this.#trainIdx = order.slice(nHold).sort((a, b) => a - b);
    const d = names.length;
    const clean = (v: number): number => (Number.isFinite(v) ? v : 0);
    // z-scoring is fitted on the training rows only (the holdout must stay unseen).
    this.#mean = new Array<number>(d).fill(0);
    this.#std = new Array<number>(d).fill(0);
    for (const i of this.#trainIdx) for (let j = 0; j < d; j++) this.#mean[j] += clean(rows[i].features[j]);
    this.#mean = this.#mean.map((s) => s / this.#trainIdx.length);
    for (const i of this.#trainIdx) {
      for (let j = 0; j < d; j++) this.#std[j] += (clean(rows[i].features[j]) - this.#mean[j]) ** 2;
    }
    this.#std = this.#std.map((s) => {
      const sd = Math.sqrt(s / this.#trainIdx.length);
      return sd > 1e-9 ? sd : 1;
    });
    const sample = (i: number): Sample => ({
      x: rows[i].features.map((v, j) => (clean(v) - this.#mean[j]) / this.#std[j]),
      y: [clamp(rows[i].win, 0, 1)],
    });
    this.#train = this.#trainIdx.map(sample);
    this.#hold = this.#holdIdx.map(sample);
    const nValid = clamp(Math.round(this.#train.length * o.validation), 1, this.#train.length - 1);
    const vOrder = this.#root.fork("validation").shuffle(Array.from({ length: this.#train.length }, (_, i) => i));
    this.#valid = vOrder.slice(0, nValid).sort((a, b) => a - b).map((i) => this.#train[i]);
    this.#inner = vOrder.slice(nValid).sort((a, b) => a - b).map((i) => this.#train[i]);
    this.#condIdx = CONDITION_FEATURES.map((c) => names.indexOf(c)).filter((j) => j >= 0);
    this.#trainCond = this.#train.map((s) => ({ x: this.#condIdx.map((j) => s.x[j]), y: s.y }));
    // The selection net and the final net start from the SAME initial weights.
    this.#sel = new MLP([d, o.hidden, 1], this.#root.fork("nn.init"), "tanh", "sigmoid");
    this.#nn = new MLP([d, o.hidden, 1], this.#root.fork("nn.init"), "tanh", "sigmoid");
    this.#lr = new MLP([d, 1], this.#root.fork("logistic.init"), "tanh", "sigmoid");
    this.#cond = this.#condIdx.length > 0 ? new MLP([this.#condIdx.length, 1], this.#root.fork("conditions.init"), "tanh", "sigmoid") : null;
    this.#selRng = this.#root.fork("nn.select");
    this.#nnRng = this.#root.fork("nn.fit");
    this.#lrRng = this.#root.fork("logistic.fit");
    this.#condRng = this.#root.fork("conditions.fit");
    this.#phase = o.patience > 0 ? "select" : "nn";
    this.#nnEpochs = o.epochs;
  }

  get finished(): boolean {
    return this.#phase === "done";
  }

  /** What is running now, for a progress line. `fraction` (0..1) estimates the whole job. */
  get progress(): { phase: TrainPhase; epoch: number; epochs: number; fraction: number } {
    const o = this.options;
    const selected = this.#phase !== "select";
    const sel = o.patience > 0 ? (selected ? this.#curve.train.length : o.epochs) : 0;
    const total = sel + this.#nnEpochs + 2 * o.logisticEpochs + 1;
    const doneBefore: Record<TrainPhase, number> = {
      select: 0,
      nn: sel,
      logistic: sel + this.#nnEpochs,
      conditions: sel + this.#nnEpochs + o.logisticEpochs,
      report: total - 1,
      done: total,
    };
    const epochs = this.#phase === "select" ? o.epochs : this.#phase === "nn" ? this.#nnEpochs : o.logisticEpochs;
    const fraction = this.#phase === "done" ? 1 : Math.min(0.99, (doneBefore[this.#phase] + this.#epoch) / total);
    return { phase: this.#phase, epoch: this.#epoch, epochs, fraction };
  }

  advance(shouldYield: () => boolean = () => false): boolean {
    const o = this.options;
    const fitOpts = { epochs: 1, lr: o.lr, batchSize: o.batchSize, l2: o.l2 };
    while (this.#phase !== "done") {
      if (this.#phase === "report") {
        this.#report = this.#buildReport();
        this.#phase = "done";
        break;
      }
      // One epoch of fit() per step: reusing the same Rng makes E calls identical to fit(epochs: E).
      if (this.#phase === "select") {
        this.#curve.train.push(this.#sel.fit(this.#inner, { ...fitOpts, rng: this.#selRng })[0]);
        const val = this.#sel.loss(this.#valid);
        this.#curve.validation.push(val);
        this.#epoch++;
        if (val < this.#bestVal - 1e-12) {
          this.#bestVal = val;
          this.#bestEpoch = this.#epoch;
        }
        if (this.#epoch >= o.epochs || this.#epoch - this.#bestEpoch >= o.patience) {
          this.#nnEpochs = Math.max(1, this.#bestEpoch);
          this.#phase = "nn";
          this.#epoch = 0;
        }
      } else if (this.#phase === "nn") {
        this.#fitCurve.push(this.#nn.fit(this.#train, { ...fitOpts, rng: this.#nnRng })[0]);
        this.#epoch++;
        if (this.#epoch >= this.#nnEpochs) {
          this.#phase = "logistic";
          this.#epoch = 0;
        }
      } else if (this.#phase === "logistic") {
        this.#lr.fit(this.#train, { ...fitOpts, rng: this.#lrRng });
        this.#epoch++;
        if (this.#epoch >= o.logisticEpochs) {
          this.#phase = "conditions";
          this.#epoch = 0;
        }
      } else {
        if (this.#cond) this.#cond.fit(this.#trainCond, { ...fitOpts, rng: this.#condRng });
        this.#epoch++;
        if (!this.#cond || this.#epoch >= o.logisticEpochs) {
          this.#phase = "report";
          this.#epoch = 0;
        }
      }
      if (shouldYield()) return false;
    }
    return true;
  }

  report(): WinModelReport {
    if (!this.#report) throw new Error("WinTrainer.report: training has not finished (call advance() until it returns true)");
    return this.#report;
  }

  #ctx(row: WinRow): MatchContext {
    return makeContext(Object.fromEntries(this.#condIdx.map((j) => [this.names[j], row.features[j]])));
  }

  #buildReport(): WinModelReport {
    const o = this.options;
    const rows = this.#rows;
    const y = this.#hold.map((s) => s.y[0]);
    const pNN = this.#hold.map((s) => this.#nn.forward(s.x)[0]);
    const pLR = this.#hold.map((s) => this.#lr.forward(s.x)[0]);
    const nnLoss = pNN.map((p, i) => rowLoss(p, y[i]));
    const baseRate = this.#train.reduce((s, x) => s + x.y[0], 0) / this.#train.length;
    const decisive = y.filter((v) => v === 0 || v === 1).length;
    const score = (id: ModelId, p: readonly number[]): ModelScore => {
      const losses = p.map((q, i) => rowLoss(q, y[i]));
      const ll = meanSE(losses);
      const diff = meanSE(losses.map((l, i) => l - nnLoss[i]));
      let correct = 0;
      for (let i = 0; i < p.length; i++) {
        if (y[i] === 1 || y[i] === 0) correct += (p[i] >= 0.5 ? 1 : 0) === y[i] ? 1 : 0;
      }
      return {
        id,
        label: MODEL_LABELS[id],
        logLoss: ll.mean,
        logLossSE: ll.se,
        vsNN: id === "nn" ? 0 : diff.mean,
        vsNNSE: id === "nn" ? 0 : diff.se,
        accuracy: decisive > 0 ? correct / decisive : NaN,
        brier: p.reduce((s, q, i) => s + (q - y[i]) * (q - y[i]), 0) / p.length,
      };
    };
    const scores: ModelScore[] = [score("nn", pNN), score("logistic", pLR)];
    let ladderWeights: Record<string, number> = {};
    if (this.#cond) {
      const cond = this.#cond;
      scores.push(score("conditions", this.#hold.map((s) => cond.forward(this.#condIdx.map((j) => s.x[j]))[0])));
      // The live ladder: fresh ids every match (equal ratings), so only its learned condition
      // weights, arena/weather offsets and comboEdge move the expectation. One pass, in corpus order.
      const ladder = new Ladder();
      this.#trainIdx.forEach((ri, k) => {
        const r = rows[ri];
        ladder.record({
          a: `a${k}`,
          b: `b${k}`,
          scoreA: scoreOf(r.win),
          context: this.#ctx(r),
          arena: r.arena,
          weather: r.weather,
          when: k,
          combosA: r.combosA,
          combosB: r.combosB,
        });
      });
      scores.push(score("ladder", this.#holdIdx.map((ri, k) => ladder.expected(`ha${k}`, `hb${k}`, this.#ctx(rows[ri]), rows[ri]))));
      ladderWeights = Object.fromEntries(Object.entries(ladder.weights()).filter(([key]) => !key.includes("|")));
    }
    scores.push(score("base", y.map(() => baseRate)));

    // Permutation importance on the holdout: shuffle one column, measure the network's loss rise.
    const impRng = this.#root.fork("importance");
    const base = nnLoss.reduce((s, l) => s + l, 0) / nnLoss.length;
    const coefs = this.#lr.toJSON().weights[0][0];
    const idx = Array.from({ length: this.#hold.length }, (_, i) => i);
    const importance: FeatureImportance[] = this.names.map((name, j) => {
      const deltas: number[] = [];
      for (let r = 0; r < o.permutations; r++) {
        const perm = impRng.shuffle(idx);
        const shuffled = this.#hold.map((s, i) => {
          const x = s.x.slice();
          x[j] = this.#hold[perm[i]].x[j];
          return { x, y: s.y };
        });
        deltas.push(this.#nn.loss(shuffled) - base);
      }
      const m = deltas.reduce((s, v) => s + v, 0) / deltas.length;
      const sd = Math.sqrt(deltas.reduce((s, v) => s + (v - m) * (v - m), 0) / deltas.length);
      return { name, delta: m, sd, coef: coefs[j] };
    }).sort((a, b) => b.delta - a.delta || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    return {
      seed: this.seed,
      names: [...this.names],
      nTrain: this.#train.length,
      nHoldout: this.#hold.length,
      nDecisive: decisive,
      baseRate,
      scores,
      calibration: calibrationTable(pNN, y),
      calibrationLogistic: calibrationTable(pLR, y),
      importance,
      curve: { train: [...this.#curve.train], validation: [...this.#curve.validation], bestEpoch: this.#nnEpochs },
      fitCurve: [...this.#fitCurve],
      ladderWeights,
      model: { kind: "genemon.winModel", version: 1, names: [...this.names], mean: [...this.#mean], std: [...this.#std], mlp: this.#nn.toJSON() },
      paramCount: this.#nn.paramCount,
      options: { ...o },
    };
  }
}

/** Train and evaluate in one call (the UI uses WinTrainer to do the same work in chunks). */
export function trainWinModel(rows: readonly WinRow[], seed: number, options: WinModelOptions = {}): WinModelReport {
  const t = new WinTrainer(rows, seed, options);
  t.advance();
  return t.report();
}
