/**
 * Condition-aware ladder MMR. Pure (no DOM) and deterministic (no randomness at all).
 *
 * Classic Elo predicts a match from the two ratings only. Genemon battles are decided as much by
 * the CONDITIONS (type chart, arena ground, weather, slot power, team synergy, size, reach, combos)
 * as by skill, so the expected score is a logistic model over both:
 *
 *   E_A = sigmoid( ln10 * (R_A - R_B) / 400  +  sum_f x_f * (w_f + w_f|arena + w_f|weather) )
 *
 *   x_f   context features from side A's perspective, ~[-1, 1] (positive = good for A)
 *   w     learned online: one SGD step on the logistic loss after every match
 *   R     moves by K * (S - E_A); K = mean of both players' K (zero-sum) x win-condition factor
 *
 * Consequences: a win in UNFAVOURABLE conditions (E low) pays more than a win the conditions handed
 * you (E high), and losing a match you were set up to win costs more. Arena and weather are shared
 * by both sides, so they cannot favour A or B by themselves: they enter as INTERACTIONS that
 * re-weight how much each side-relative feature matters there (type advantage in a storm...).
 * The ladder also derives `comboEdge` from its own combo history (best/worst combos feed back in).
 *
 * Each record() emits one `ladder.match` ledger row; matchDataset() turns those rows back into the
 * outcome-predictor dataset. Doc + worked example: docs/AI-AND-DATA.md.
 */
import type { GEvent, Ledger, Scalar } from "../core/ledger.ts";
import { clamp, r3, sigmoid } from "../core/math.ts";
import { wilson } from "../ml/stats.ts";

export interface MatchContext {
  /** Unique feature names, parallel to `features` (no "|" - it separates interaction keys). */
  names: string[];
  /** Values from side A's perspective, ~[-1, 1], positive = good for A. Clamped to [-2, 2]. */
  features: number[];
}

export interface MatchResult {
  a: string;
  b: string;
  scoreA: 1 | 0.5 | 0;
  context: MatchContext;
  arena: string;
  weather: string;
  /** ms (epoch for live play, simulated ms in sims) - copied to the ledger row, never Date.now(). */
  when: number;
  /** Tags of what side A fielded: element pairs, move sequences, roles ("fire+air", "rainCall>thunderBeam"). */
  combosA: string[];
  combosB: string[];
  /** How the match ended: ko | ringOut | sweep | timeout | forfeit | disconnect | ... (see WIN_CONDITION_K). */
  winCondition?: string;
}

/** Name of the feature the ladder derives from its own combo history. */
export const COMBO_FEATURE = "comboEdge";

/** Column holding (R_A - R_B) / 400 in matchDataset(). */
export const RATING_COLUMN = "ratingDiff";

/**
 * Canonical context features: the contract between the battle engine and the ladder (definitions
 * in docs/AI-AND-DATA.md#context-features). Any other name is accepted and learned the same way;
 * this list fixes the column order and the Data screen labels.
 */
export const CONTEXT_FEATURES: readonly { name: string; note: string }[] = [
  { name: "typeAdvantage", note: "Type-chart edge of A's damaging moves over B's types, minus the reverse." },
  { name: "arenaAffinity", note: "How much A's elements thrive on the arena's grounds, minus B's." },
  { name: "weatherAffinity", note: "How much the weather boosts A's move elements, minus B's." },
  { name: "powerDiff", note: "Slot-normalised team power gap (powerA - powerB) / (powerA + powerB)." },
  { name: "synergyDiff", note: "Team synergy A minus B (sociality, coverage, intra-team reactions)." },
  { name: "sizeDiff", note: "Mass gap tanh(ln(massA / massB) / 2): knockback and ring-out resistance." },
  { name: "reachDiff", note: "Reach gap tanh((reachA - reachB) / 2 m): who controls the distance." },
  { name: COMBO_FEATURE, note: "Derived by the ladder: shrunk win rate of A's combos minus B's, / 2." },
];

/**
 * K multiplier per win condition (unknown or missing -> 1). A timeout decided on remaining HP is a
 * narrower, luckier result than a KO; a sweep (no member lost) is a margin-of-victory bonus;
 * quitting must never be cheaper than losing, so forfeit and disconnect count in full.
 */
export const WIN_CONDITION_K: Readonly<Record<string, number>> = {
  ko: 1,
  ringOut: 1,
  sweep: 1.15,
  timeout: 0.75,
  forfeit: 1,
  disconnect: 1,
  draw: 1,
};

const LN10_OVER_400 = Math.LN10 / 400;
/** Feature values are clamped to +-FEATURE_LIMIT so one mis-scaled feature cannot blow up the weights. */
const FEATURE_LIMIT = 2;

function byName(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** CONTEXT_FEATURES order first, then any other names alphabetically. */
function canonicalOrder(names: Iterable<string>): string[] {
  const rank = new Map(CONTEXT_FEATURES.map((f, i) => [f.name, i]));
  return [...names].sort((a, b) => (rank.get(a) ?? Infinity) - (rank.get(b) ?? Infinity) || byName(a, b));
}

/** Build a MatchContext from a name -> value record (canonical column order). */
export function makeContext(features: Readonly<Record<string, number>>): MatchContext {
  const names = canonicalOrder(Object.keys(features));
  return { names, features: names.map((n) => features[n]) };
}

export interface LadderOptions {
  /** Base K factor (default 24). */
  k?: number;
  /** Starting rating (default 1500). */
  base?: number;
  /** SGD learning rate of the context weights (default 0.02). */
  lr?: number;
  ledger?: Ledger;
  /** L2 decay of the global feature weights (default 0.001). */
  l2?: number;
  /** L2 decay of the arena/weather interaction offsets (default 0.01: they must earn their size). */
  l2Interaction?: number;
  /** Games played with the provisional K (default 10). */
  provisionalGames?: number;
  /** Provisional K multiplier (default 2). */
  provisionalMult?: number;
  /** Bound on every learned weight (default 4: odds x55 per unit of feature). */
  maxWeight?: number;
  /** Learn per-arena and per-weather offsets of each feature weight (default true). */
  interactions?: boolean;
  /** Append the derived comboEdge feature (default true; skipped if the context already has it). */
  comboFeature?: boolean;
}

/** Optional match conditions for expected()/explain(); a MatchResult can be passed as-is. */
export type MatchConditions = Partial<Pick<MatchResult, "arena" | "weather" | "combosA" | "combosB">>;

export interface Contribution {
  name: string;
  /** Feature value used (after clamping / derivation). */
  value: number;
  /** Effective weight: global + arena offset + weather offset. */
  weight: number;
  /** value * weight: this feature's push on the log-odds (positive = toward A). */
  logit: number;
}

export interface Explanation {
  /** Condition-aware expected score of A. */
  expected: number;
  /** Classic Elo expectation from the ratings alone. */
  ratingOnly: number;
  ratingLogit: number;
  contextLogit: number;
  contributions: Contribution[];
}

export interface RecordOutcome {
  expected: number;
  deltaA: number;
  deltaB: number;
  /** K actually applied (provisional mean x win-condition factor). */
  k: number;
  ratingOnly: number;
}

export interface PlayerRecord {
  rating: number;
  games: number;
  wins: number;
  losses: number;
  draws: number;
}

export interface LadderRow extends PlayerRecord {
  id: string;
  provisional: boolean;
}

export interface Tally {
  wins: number;
  losses: number;
  draws: number;
  /** Sum of the perspective side's pre-match expected score (calibration). */
  expSum: number;
}

export interface ConditionEntry {
  key: string;
  /** All games, draws included. */
  games: number;
  wins: number;
  losses: number;
  draws: number;
  /** wins / (wins + losses): draws are excluded from the denominator (0 when no decisive game). */
  winRate: number;
  /** Wilson 95% interval of winRate over the decisive games ([0, 1] when there are none). */
  lo: number;
  hi: number;
  /** Observed mean score (win 1, draw 0.5) over all games: compare with `expected`. */
  score: number;
  /** Mean pre-match expected score of the perspective side: the model's calibration target. */
  expected: number;
}

export interface ConditionStats {
  /** Whose results: a player id, or "favourite" (the side with E >= 0.5 before the match). */
  perspective: string;
  byArena: ConditionEntry[];
  byWeather: ConditionEntry[];
  /** Always per side: a combo is credited with the result of the side that fielded it. */
  byCombo: ConditionEntry[];
  byWinCondition: ConditionEntry[];
}

type Dim = "arena" | "weather" | "combo" | "winCondition";
type Tallies = Record<Dim, Map<string, Tally>>;
type TalliesJSON = Record<Dim, Record<string, Tally>>;

export interface LadderJSON {
  kind: "genemon.ladder";
  version: 1;
  options: Required<Omit<LadderOptions, "ledger">>;
  matches: number;
  players: Record<string, PlayerRecord>;
  weights: Record<string, number>;
  tallies: { global: TalliesJSON; players: Record<string, TalliesJSON> };
}

export interface MatchDataset {
  /** Column names: RATING_COLUMN then the context features (canonical order) unless given. */
  names: string[];
  /** One row per ladder.match event; win = scoreA (draw 0.5). */
  rows: { features: number[]; win: number }[];
}

const newTallies = (): Tallies => ({
  arena: new Map(),
  weather: new Map(),
  combo: new Map(),
  winCondition: new Map(),
});

const unique = (xs: readonly string[]): string[] => [...new Set(xs)];

const arenaKey = (feature: string, arena: string): string => `${feature}|arena:${arena}`;
const weatherKey = (feature: string, weather: string): string => `${feature}|weather:${weather}`;

function addTally(map: Map<string, Tally>, key: string, score: number, expected: number): void {
  let t = map.get(key);
  if (!t) map.set(key, t = { wins: 0, losses: 0, draws: 0, expSum: 0 });
  if (score === 1) t.wins++;
  else if (score === 0) t.losses++;
  else t.draws++;
  t.expSum += expected;
}

function toEntry(key: string, t: Tally): ConditionEntry {
  const decisive = t.wins + t.losses;
  const games = decisive + t.draws;
  const ci = wilson(t.wins, decisive);
  return {
    key,
    games,
    wins: t.wins,
    losses: t.losses,
    draws: t.draws,
    winRate: ci.p,
    lo: ci.lo,
    hi: ci.hi,
    score: games > 0 ? (t.wins + 0.5 * t.draws) / games : 0,
    expected: games > 0 ? t.expSum / games : 0.5,
  };
}

function entries(map: Map<string, Tally>): ConditionEntry[] {
  return [...map].map(([k, t]) => toEntry(k, t)).sort((x, y) => y.games - x.games || byName(x.key, y.key));
}

function talliesToJSON(t: Tallies): TalliesJSON {
  const out = {} as TalliesJSON;
  for (const dim of Object.keys(t) as Dim[]) {
    out[dim] = Object.fromEntries([...t[dim]].map(([k, v]) => [k, { ...v }]));
  }
  return out;
}

function talliesFromJSON(j: Partial<TalliesJSON> | undefined): Tallies {
  const t = newTallies();
  for (const dim of Object.keys(t) as Dim[]) {
    for (const [k, v] of Object.entries(j?.[dim] ?? {})) t[dim].set(k, { ...v });
  }
  return t;
}

export class Ladder {
  readonly k: number;
  readonly base: number;
  readonly lr: number;
  readonly l2: number;
  readonly l2Interaction: number;
  readonly provisionalGames: number;
  readonly provisionalMult: number;
  readonly maxWeight: number;
  readonly interactions: boolean;
  readonly comboFeature: boolean;
  #ledger: Ledger | undefined;
  #players = new Map<string, PlayerRecord>();
  #w = new Map<string, number>();
  #global: Tallies = newTallies();
  #perPlayer = new Map<string, Tallies>();
  #matches = 0;

  constructor(opts: LadderOptions = {}) {
    this.k = opts.k ?? 24;
    this.base = opts.base ?? 1500;
    this.lr = opts.lr ?? 0.02;
    this.l2 = opts.l2 ?? 0.001;
    this.l2Interaction = opts.l2Interaction ?? 0.01;
    this.provisionalGames = opts.provisionalGames ?? 10;
    this.provisionalMult = opts.provisionalMult ?? 2;
    this.maxWeight = opts.maxWeight ?? 4;
    this.interactions = opts.interactions ?? true;
    this.comboFeature = opts.comboFeature ?? true;
    this.#ledger = opts.ledger;
  }

  /** Matches recorded so far. */
  get matches(): number {
    return this.#matches;
  }

  rating(id: string): number {
    return this.#players.get(id)?.rating ?? this.base;
  }

  games(id: string): number {
    return this.#players.get(id)?.games ?? 0;
  }

  /** sigmoid(ln10 (Ra - Rb) / 400 + w . x): A's expected score under these conditions. */
  expected(a: string, b: string, ctx: MatchContext, cond: MatchConditions = {}): number {
    return this.explain(a, b, ctx, cond).expected;
  }

  /** The expectation broken down per feature (the "why did I gain 13 points" panel). */
  explain(a: string, b: string, ctx: MatchContext, cond: MatchConditions = {}): Explanation {
    const ratingLogit = LN10_OVER_400 * (this.rating(a) - this.rating(b));
    let contextLogit = 0;
    const contributions = this.#features(ctx, cond.combosA ?? [], cond.combosB ?? []).map(([name, value]) => {
      const weight = this.#weightOf(name, cond.arena, cond.weather);
      const logit = weight * value;
      contextLogit += logit;
      return { name, value, weight, logit };
    });
    return {
      expected: sigmoid(ratingLogit + contextLogit),
      ratingOnly: sigmoid(ratingLogit),
      ratingLogit,
      contextLogit,
      contributions,
    };
  }

  /**
   * Record a match: ratings move by K (S - E) (zero-sum), then every active weight takes one SGD
   * step on the logistic loss, w += lr ((S - E) x - l2 w), using the same pre-match E.
   */
  record(r: MatchResult): RecordOutcome {
    if (r.a === r.b) throw new Error(`Ladder.record: "${r.a}" cannot play itself`);
    if (r.scoreA !== 0 && r.scoreA !== 0.5 && r.scoreA !== 1) {
      throw new Error(`Ladder.record: scoreA must be 0, 0.5 or 1 (got ${r.scoreA})`);
    }
    const ex = this.explain(r.a, r.b, r.context, r);
    const pa = this.#player(r.a), pb = this.#player(r.b);
    const before = { ratingA: pa.rating, ratingB: pb.rating, gamesA: pa.games, gamesB: pb.games };
    const S = r.scoreA, E = ex.expected;
    const k = 0.5 * (this.#kOf(pa) + this.#kOf(pb)) * (WIN_CONDITION_K[r.winCondition ?? ""] ?? 1);
    const deltaA = k * (S - E);
    const deltaB = -deltaA;
    pa.rating += deltaA;
    pb.rating += deltaB;
    Ladder.#count(pa, S);
    Ladder.#count(pb, 1 - S);

    const g = S - E;
    for (const c of ex.contributions) {
      if (c.value === 0) continue;
      this.#step(c.name, g * c.value, this.l2);
      if (this.interactions) {
        this.#step(arenaKey(c.name, r.arena), g * c.value, this.l2Interaction);
        this.#step(weatherKey(c.name, r.weather), g * c.value, this.l2Interaction);
      }
    }
    this.#tally(r, E);
    this.#matches++;

    if (this.#ledger) {
      const entries: Record<string, Scalar> = {
        ratingA: r3(before.ratingA),
        ratingB: r3(before.ratingB),
        gamesA: before.gamesA,
        gamesB: before.gamesB,
        scoreA: S,
        arena: r.arena,
        weather: r.weather,
        winCondition: r.winCondition ?? "",
        combosA: unique(r.combosA).join(","),
        combosB: unique(r.combosB).join(","),
        expected: r3(E),
        ratingOnly: r3(ex.ratingOnly),
        contextLogit: r3(ex.contextLogit),
        k: r3(k),
      };
      for (const c of ex.contributions) entries[`x.${c.name}`] = r3(c.value);
      this.#ledger.emit({
        when: r.when,
        where: { x: 0, y: 0, z: 0, zone: r.arena, space: "arena" },
        who: r.a,
        what: "ladder.match",
        why: `condition-aware Elo: E=${r3(E)} (rating-only ${r3(ex.ratingOnly)}), K=${r3(k)}`,
        from: r.a,
        to: r.b,
        entries,
        exits: {
          deltaA: r3(deltaA),
          deltaB: r3(deltaB),
          ratingA: r3(pa.rating),
          ratingB: r3(pb.rating),
          surprise: r3(S - E),
        },
        tags: ["ladder"],
      });
    }
    return { expected: E, deltaA, deltaB, k, ratingOnly: ex.ratingOnly };
  }

  /** Learned weights, sorted by key: "feature", "feature|arena:<id>", "feature|weather:<id>". */
  weights(): Record<string, number> {
    return Object.fromEntries([...this.#w].sort(([a], [b]) => byName(a, b)));
  }

  /** Standings sorted by rating (then games, then id). */
  table(): LadderRow[] {
    return [...this.#players]
      .map(([id, p]) => ({ id, ...p, provisional: p.games < this.provisionalGames }))
      .sort((x, y) => y.rating - x.rating || y.games - x.games || byName(x.id, y.id));
  }

  /**
   * Win rates per arena, weather, combo and win condition with Wilson 95% intervals (draws
   * excluded from the denominator). With an id: that player's own results. Without: arena,
   * weather and win condition are seen from the pre-match FAVOURITE (E >= 0.5, ties to side A),
   * so "favourite won 58% here while the model expected 71%" flags an arena the model misreads.
   */
  conditionStats(id?: string): ConditionStats {
    const t = id === undefined ? this.#global : this.#perPlayer.get(id) ?? newTallies();
    return {
      perspective: id ?? "favourite",
      byArena: entries(t.arena),
      byWeather: entries(t.weather),
      byCombo: entries(t.combo),
      byWinCondition: entries(t.winCondition),
    };
  }

  /** Combos ranked by Wilson LOWER bound (confidently good); needs >= minGames decisive games. */
  bestCombos(n: number, minGames = 1): ConditionEntry[] {
    return this.#combos(minGames)
      .sort((x, y) => y.lo - x.lo || y.winRate - x.winRate || y.games - x.games || byName(x.key, y.key))
      .slice(0, Math.max(0, n));
  }

  /** Combos ranked by Wilson UPPER bound ascending (confidently bad); needs >= minGames decisive games. */
  worstCombos(n: number, minGames = 1): ConditionEntry[] {
    return this.#combos(minGames)
      .sort((x, y) => x.hi - y.hi || x.winRate - y.winRate || y.games - x.games || byName(x.key, y.key))
      .slice(0, Math.max(0, n));
  }

  toJSON(): LadderJSON {
    return {
      kind: "genemon.ladder",
      version: 1,
      options: {
        k: this.k,
        base: this.base,
        lr: this.lr,
        l2: this.l2,
        l2Interaction: this.l2Interaction,
        provisionalGames: this.provisionalGames,
        provisionalMult: this.provisionalMult,
        maxWeight: this.maxWeight,
        interactions: this.interactions,
        comboFeature: this.comboFeature,
      },
      matches: this.#matches,
      players: Object.fromEntries([...this.#players].map(([id, p]) => [id, { ...p }])),
      weights: Object.fromEntries(this.#w),
      tallies: {
        global: talliesToJSON(this.#global),
        players: Object.fromEntries([...this.#perPlayer].map(([id, t]) => [id, talliesToJSON(t)])),
      },
    };
  }

  /** Rebuild a ladder (the ledger is not serialised: pass the one to keep emitting into). */
  static fromJSON(j: LadderJSON, ledger?: Ledger): Ladder {
    const lad = new Ladder({ ...j.options, ledger });
    lad.#matches = j.matches ?? 0;
    for (const [id, p] of Object.entries(j.players ?? {})) lad.#players.set(id, { ...p });
    for (const [key, w] of Object.entries(j.weights ?? {})) lad.#w.set(key, w);
    lad.#global = talliesFromJSON(j.tallies?.global);
    for (const [id, t] of Object.entries(j.tallies?.players ?? {})) {
      lad.#perPlayer.set(id, talliesFromJSON(t));
    }
    return lad;
  }

  // ------------------------------------------------------------------------------ internals

  #player(id: string): PlayerRecord {
    let p = this.#players.get(id);
    if (!p) this.#players.set(id, p = { rating: this.base, games: 0, wins: 0, losses: 0, draws: 0 });
    return p;
  }

  #kOf(p: PlayerRecord): number {
    return p.games < this.provisionalGames ? this.k * this.provisionalMult : this.k;
  }

  static #count(p: PlayerRecord, score: number): void {
    p.games++;
    if (score === 1) p.wins++;
    else if (score === 0) p.losses++;
    else p.draws++;
  }

  #step(key: string, grad: number, l2: number): void {
    const w = this.#w.get(key) ?? 0;
    this.#w.set(key, clamp(w + this.lr * (grad - l2 * w), -this.maxWeight, this.maxWeight));
  }

  #weightOf(name: string, arena?: string, weather?: string): number {
    let w = this.#w.get(name) ?? 0;
    if (this.interactions) {
      if (arena !== undefined) w += this.#w.get(arenaKey(name, arena)) ?? 0;
      if (weather !== undefined) w += this.#w.get(weatherKey(name, weather)) ?? 0;
    }
    return w;
  }

  /** Validated, clamped (name, value) pairs plus the derived combo feature. */
  #features(ctx: MatchContext, combosA: readonly string[], combosB: readonly string[]): [string, number][] {
    if (ctx.names.length !== ctx.features.length) {
      throw new Error(`Ladder: ${ctx.names.length} feature names but ${ctx.features.length} values`);
    }
    const seen = new Set<string>();
    const out: [string, number][] = [];
    for (let i = 0; i < ctx.names.length; i++) {
      const name = ctx.names[i];
      if (seen.has(name)) throw new Error(`Ladder: duplicate feature "${name}"`);
      if (name.includes("|")) throw new Error(`Ladder: feature name "${name}" may not contain "|"`);
      seen.add(name);
      const v = ctx.features[i];
      out.push([name, Number.isFinite(v) ? clamp(v, -FEATURE_LIMIT, FEATURE_LIMIT) : 0]);
    }
    if (this.comboFeature && !seen.has(COMBO_FEATURE)) {
      out.push([COMBO_FEATURE, this.#comboEdge(combosA, combosB)]);
    }
    return out;
  }

  /**
   * Mean Beta(2,2)-shrunk win rate of each side's combos mapped to [-1, 1] (2p - 1), A minus B,
   * halved into [-1, 1]. Uses only matches recorded BEFORE this one; unseen combos count as 0.5.
   */
  #comboEdge(combosA: readonly string[], combosB: readonly string[]): number {
    const side = (combos: readonly string[]): number => {
      const keys = unique(combos);
      if (keys.length === 0) return 0;
      let s = 0;
      for (const c of keys) {
        const t = this.#global.combo.get(c);
        s += 2 * (t ? (t.wins + 2) / (t.wins + t.losses + 4) : 0.5) - 1;
      }
      return s / keys.length;
    };
    return (side(combosA) - side(combosB)) / 2;
  }

  #tallies(id: string): Tallies {
    let t = this.#perPlayer.get(id);
    if (!t) this.#perPlayer.set(id, t = newTallies());
    return t;
  }

  #tally(r: MatchResult, E: number): void {
    const favA = E >= 0.5;
    const favScore = favA ? r.scoreA : 1 - r.scoreA;
    const favE = favA ? E : 1 - E;
    const wc = r.winCondition ?? (r.scoreA === 0.5 ? "draw" : "unspecified");
    addTally(this.#global.arena, r.arena, favScore, favE);
    addTally(this.#global.weather, r.weather, favScore, favE);
    addTally(this.#global.winCondition, wc, favScore, favE);
    const sides = [
      { id: r.a, s: r.scoreA, e: E, combos: unique(r.combosA) },
      { id: r.b, s: 1 - r.scoreA, e: 1 - E, combos: unique(r.combosB) },
    ];
    for (const side of sides) {
      const t = this.#tallies(side.id);
      addTally(t.arena, r.arena, side.s, side.e);
      addTally(t.weather, r.weather, side.s, side.e);
      addTally(t.winCondition, wc, side.s, side.e);
      for (const c of side.combos) {
        addTally(this.#global.combo, c, side.s, side.e);
        addTally(t.combo, c, side.s, side.e);
      }
    }
  }

  #combos(minGames: number): ConditionEntry[] {
    return entries(this.#global.combo).filter((e) => e.wins + e.losses >= Math.max(1, minGames));
  }
}

const num = (v: Scalar | undefined): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * Ledger -> dataset: every `ladder.match` row becomes { features, win } for the outcome predictor
 * (predictOutcomeModel in src/ml/mlp.ts). Default columns: RATING_COLUMN ((R_A - R_B) / 400 before
 * the match) then every `x.<feature>` seen, in canonical order; a missing feature reads as 0.
 */
export function matchDataset(events: readonly GEvent[], names?: readonly string[]): MatchDataset {
  const matches = events.filter((e) => e.what === "ladder.match");
  let cols: string[];
  if (names) {
    cols = [...names];
  } else {
    const found = new Set<string>();
    for (const e of matches) {
      for (const key of Object.keys(e.entries)) if (key.startsWith("x.")) found.add(key.slice(2));
    }
    cols = [RATING_COLUMN, ...canonicalOrder(found)];
  }
  const rows = matches.map((e) => ({
    features: cols.map((c) =>
      c === RATING_COLUMN ? (num(e.entries.ratingA) - num(e.entries.ratingB)) / 400 : num(e.entries[`x.${c}`])
    ),
    win: num(e.entries.scoreA),
  }));
  return { names: cols, rows };
}
