/**
 * Batch lab [P5-X1]: breed and fight in BATCHES to balance the game with evidence, not taste.
 *
 *  - ARCHETYPES: six GenomeBias presets (fast, powerful, clever, tank, sensory, swarm). An archetype is a
 *    SHAPE of the power budget, never a bigger budget [SPEC B1]: it is built at the same size class as its
 *    opponent (stature is searched), crossed with every element (element signature at 0.8, the
 *    archetype's own axes on top) and with two slot budgets (M = 2 slots, L = 3 slots; the swarm fields
 *    the same number of slots as S bodies).
 *  - matchupMatrix / MatrixJob: archetype x archetype win-rate matrix. Win rate EXCLUDES draws (draws are
 *    reported separately), Wilson 95 % intervals, sides swapped every other battle, a pros/cons table per
 *    archetype and flags for any row above 65 % overall or any cell above 85 %.
 *  - breedBatch / BreedJob: tournament selection on battle win rate, Mendelian breed + mutate
 *    (src/genome/breeding.ts), per-generation stats (mean stats, power index, archetype drift, diversity).
 *  - colossusMatrix / ColossusJob [P6-B1, P6-B2]: a lone XXL colossus (buildColossus) against a poor / median /
 *    good six of S bodies (composeSix, ranked by teamQuality from src/combat/team.ts) at levels 10 / 25 / 50; the
 *    six's win rate per cell, draws excluded and reported, Wilson 95 % intervals, target bands (COLOSSUS_TARGET).
 *  - batchReportMarkdown / colossusReportMarkdown: the human report (weights, costs and probabilities explained).
 *
 * Pure and deterministic: randomness only through Rng / hashSeed; no clock, no DOM. The *Job classes do the
 * work in resumable slices (advance(yieldNow, max)) so the UI can time-slice them; the plain functions run
 * a job to completion.
 */
import { Battle, type BattleResult } from "../combat/battle.ts";
import { ALL_MOVE_BY_ID } from "../combat/kit.ts";
import { isDamaging } from "../combat/moves.ts";
import { QUALITY_WEIGHTS, type Team, TEAM_CAPACITY, type TeamQuality, teamQuality } from "../combat/team.ts";
import { clamp } from "../core/math.ts";
import { hashSeed, Rng } from "../core/rng.ts";
import { type AxisId, type AxisVector } from "../data/axes.ts";
import { ELEMENT_IDS, ELEMENTS, type ElementId, typeMultiplier } from "../data/elements.ts";
import { breed, geneticDistance, mutate } from "../genome/breeding.ts";
import { createGenemon, type Genemon, phenotypeOf } from "../genome/genemon.ts";
import { type BodyKind, cloneGenome, type Genome, type GenomeBias, type PlanGene, planValue, sealGenome } from "../genome/genome.ts";
import { CX_PAIRS, isColossal } from "../genome/complexity.ts";
import { POWER_BUDGET, type Phenotype, SIZE_CLASSES, type SizeClass, SLOT_COST } from "../genome/phenotype.ts";
import { type Interval, median, wilson } from "../ml/stats.ts";
import { ARENA_KINDS } from "../world/arena.ts";

// ------------------------------------------------------------------------------------------ archetypes

export type ArchetypeId = "fast" | "powerful" | "clever" | "tank" | "sensory" | "swarm";

export interface BatchArchetype {
  id: ArchetypeId;
  label: string;
  /** Chart / chip colour. */
  color: string;
  /** Axis targets (the archetype's own genes; element signature fills the others). Never stature. */
  axes: Partial<AxisVector>;
  /** Body-plan gene targets in [0, 1]. */
  plan?: Partial<Record<PlanGene, number>>;
  kind?: BodyKind;
  /** Fields its slot budget as several S bodies instead of one body of the matching class. */
  swarm?: boolean;
  /** The design intent, checked against the measured matrix (never asserted from it). */
  intent: string;
  /** Level handicap/bonus on top of the batch level (tests and what-if runs only; 0 for the real six). */
  levelBonus?: number;
}

export const BATCH_ARCHETYPES: readonly BatchArchetype[] = [
  {
    id: "fast",
    label: "Fast",
    color: "#4cc9f0",
    axes: { tempo: 0.9, weight: -0.6, elasticity: 0.5, might: -0.3, hardness: -0.3 },
    intent: "tempo/agility: charges faster, dodges more; pays with HP and armour",
  },
  {
    id: "powerful",
    label: "Powerful",
    color: "#ff6b35",
    axes: { might: 0.9, weight: 0.7, temper: 0.5, tempo: -0.4, reach: -0.6 },
    intent: "might/weight: hits hard in contact, stable; slow and easy to hit",
  },
  {
    id: "clever",
    label: "Clever",
    color: "#9b5de5",
    axes: { wisdom: 0.9, focus: 0.8, structure: 0.5, temper: -0.5, reach: 0.5 },
    intent: "wisdom/focus: accurate, crits, special attacks, learns types; fragile up close",
  },
  {
    id: "tank",
    label: "Tank",
    color: "#a7b3c6",
    axes: { hardness: 0.9, vitality: 0.8, weight: 0.5, tempo: -0.6, conviction: 0.5 },
    intent: "hardness/vitality: armour and regeneration; low damage rate, long fights",
  },
  {
    id: "sensory",
    label: "Sensory",
    color: "#3ddc84",
    axes: { curiosity: 0.8, reach: 0.6, focus: 0.4, conviction: -0.3 },
    plan: { ears: 0.95, eyes: 0.95, head: 0.75 },
    intent: "big ears/eyes, ranged and alert; senses are double-edged (resonance) once the senses lane lands",
  },
  {
    id: "swarm",
    label: "Swarm",
    color: "#ffd166",
    axes: { tempo: 0.4, sociality: 0.9, weight: -0.2 },
    swarm: true,
    intent: "several small bodies for the same slots: spreads damage and statuses; cleaved by big bodies",
  },
];

export const ARCHETYPE_BY_ID: Record<ArchetypeId, BatchArchetype> = Object.fromEntries(
  BATCH_ARCHETYPES.map((a) => [a.id, a]),
) as Record<ArchetypeId, BatchArchetype>;

/** Elements an archetype is crossed with (neutral is the absence of one). */
export const BATCH_ELEMENTS: readonly ElementId[] = ELEMENT_IDS.filter((e) => e !== "neutral");

/** Flags the founder asked for. */
export const DOMINANT_ROW = 0.65;
export const LOPSIDED_CELL = 0.85;
export const WEAK_ROW = 0.35;
/** A cell needs this many decisive battles before it can be flagged. */
export const MIN_FLAG_N = 4;

const STATURE_GUESS: Record<SizeClass, number> = { XS: -0.85, S: -0.5, M: 0.05, L: 0.55, XL: 0.85, XXL: 1 };
const STATURES = Array.from({ length: 20 }, (_, i) => -0.95 + i * 0.1);
const CLASS_FOR_SLOTS: Record<number, SizeClass> = { 1: "S", 2: "M", 3: "L", 4: "XL", 6: "XXL" };

/**
 * The archetype as a GenomeBias crossed with an element: the element signature at 0.8, then the
 * archetype's own genes on top, multiplied by `strength` (lowered by buildBody when the archetype genes
 * would otherwise turn every body into one element: wisdom 0.9 alone makes a Psychic).
 */
export function archetypeBias(a: BatchArchetype, element: ElementId | null, stature: number, spread = 0.14, strength = 1): GenomeBias {
  const axes: Partial<AxisVector> = {};
  if (element) for (const [k, v] of Object.entries(ELEMENTS[element].signature)) axes[k as AxisId] = clamp((v as number) * 0.8, -0.95, 0.95);
  for (const [k, v] of Object.entries(a.axes)) axes[k as AxisId] = clamp((v as number) * strength + (axes[k as AxisId] ?? 0) * (1 - strength), -0.95, 0.95);
  axes.stature = stature;
  return { axes, kind: a.kind, spread, plan: { quality: 0.5, ...(a.plan ?? {}) } };
}

export interface BuildStats {
  built: number;
  /** No stature hit the wanted class: the closest body was used instead. */
  missed: number;
  /** The requested element came out as the primary element. */
  elementHits: number;
  /** Sum of the archetype gene strength used (mean = strengthSum / built). */
  strengthSum: number;
}

export const emptyBuildStats = (): BuildStats => ({ built: 0, missed: 0, elementHits: 0, strengthSum: 0 });

/** Archetype gene strengths tried, strongest first, until the requested element emerges. */
export const ARCHETYPE_STRENGTHS = [1, 0.8, 0.65, 0.5] as const;

/**
 * One body of archetype `a`, element `e`, size class `want`. The element is decided by the non-stature
 * alleles, so the search first finds the strongest archetype strength (and seed variant) whose body comes
 * out with primary element `e`, then searches stature for the size class. Misses fall back to the
 * closest class / the full-strength archetype and are counted in `stats`.
 */
export function buildBody(a: BatchArchetype, e: ElementId | null, want: SizeClass, seed: number, level = 25, owner = "batch", stats?: BuildStats): Genemon {
  const make = (strength: number, k: number, stature: number) =>
    createGenemon({ seed: hashSeed(seed, a.id, e ?? "none", k, want), owner, level, bias: archetypeBias(a, e, stature, 0.14, strength) });
  let strength: number = ARCHETYPE_STRENGTHS[0], variant = 0, elementOk = !e;
  if (e) {
    search: for (const st of ARCHETYPE_STRENGTHS) {
      for (let k = 0; k < 2; k++) {
        if (phenotypeOf(make(st, k, STATURE_GUESS[want])).elements.primary === e) {
          (strength = st), (variant = k), (elementOk = true);
          break search;
        }
      }
    }
  }
  const order = STATURES.slice().sort((x, y) => Math.abs(x - STATURE_GUESS[want]) - Math.abs(y - STATURE_GUESS[want]));
  let best: Genemon | null = null, bestGap = 99;
  // Pass 6: a minimal globe is capped at S (phenotype.ts), so a bigger class tries the next variants too.
  search2: for (const stature of order) {
    for (const vk of [variant, variant + 2, variant + 4]) {
      const g = make(strength, vk, stature);
      const ph = phenotypeOf(g);
      const gap = Math.abs(SIZE_CLASSES.indexOf(ph.sizeClass) - SIZE_CLASSES.indexOf(want));
      if (gap < bestGap) (best = g), (bestGap = gap);
      if (gap === 0) break search2;
      if (vk === variant && (e === null || ph.elements.primary === e) && ph.sizeClass !== "S" && ph.sizeClass !== "XS") break;
    }
  }
  if (stats) {
    stats.built++;
    stats.strengthSum += strength;
    if (bestGap > 0) stats.missed++;
    if (elementOk && (!e || phenotypeOf(best!).elements.primary === e)) stats.elementHits++;
  }
  return best!;
}

/** The fighters an archetype fields for a slot budget: one body of the matching class, or S bodies (swarm). */
export function buildSide(a: BatchArchetype, e: ElementId | null, slots: number, seed: number, level = 25, owner = "batch", stats?: BuildStats): Genemon[] {
  if (a.swarm) return Array.from({ length: slots }, (_, k) => buildBody(a, e, "S", hashSeed(seed, "swarm", k), level, owner, stats));
  return [buildBody(a, e, CLASS_FOR_SLOTS[slots] ?? "M", seed, level, owner, stats)];
}

/** Nearest archetype of a Genemon (distance on each archetype's own genes; plan genes mapped to [-1, 1]). */
export function classifyArchetype(g: Genemon, archetypes: readonly BatchArchetype[] = BATCH_ARCHETYPES): ArchetypeId {
  const ph = phenotypeOf(g);
  let best: ArchetypeId = archetypes[0].id, bestD = Infinity;
  for (const a of archetypes) {
    let s = 0, n = 0;
    for (const [k, v] of Object.entries(a.axes)) (s += (ph.axes[k as AxisId] - (v as number)) ** 2), n++;
    for (const [k, v] of Object.entries(a.plan ?? {})) (s += (2 * planValue(g.genome, k as PlanGene) - 2 * (v as number)) ** 2), n++;
    if (a.swarm) (s += (ph.slots === 1 ? 0 : 1)), n++;
    const d = n ? Math.sqrt(s / n) : Infinity;
    if (d < bestD) (bestD = d), (best = a.id);
  }
  return best;
}

// ------------------------------------------------------------------------------------------ stat profile

export const PROFILE_KEYS = ["hp", "atk", "def", "spd", "evasion", "accuracy", "crit", "rate", "regen", "reach"] as const;
export type ProfileKey = typeof PROFILE_KEYS[number];
export type StatProfile = Record<ProfileKey, number> & { power: number; powerPerSlot: number };

export const PROFILE_LABEL: Record<ProfileKey, string> = {
  hp: "HP per budget unit",
  atk: "attack per budget unit",
  def: "defence",
  spd: "ground speed",
  evasion: "evasion",
  accuracy: "accuracy",
  crit: "crit chance",
  rate: "charge rate",
  regen: "energy regen",
  reach: "melee reach",
};

/** HP and attack are divided by the class budget so bodies of different classes compare per budget unit. */
export function profileOf(ph: Phenotype): StatProfile {
  const b = POWER_BUDGET[ph.sizeClass];
  const s = ph.stats;
  return {
    hp: s.hp / b,
    atk: s.atk / b,
    def: s.def,
    spd: s.spd,
    evasion: s.evasion,
    accuracy: s.accuracy,
    crit: s.crit,
    rate: s.rate,
    regen: s.regen,
    reach: s.reach,
    power: ph.power,
    powerPerSlot: ph.power / ph.slots,
  };
}

function meanProfile(ps: readonly StatProfile[]): StatProfile {
  const out = { power: 0, powerPerSlot: 0 } as StatProfile;
  for (const k of [...PROFILE_KEYS, "power", "powerPerSlot"] as const) out[k] = ps.length ? ps.reduce((s, p) => s + p[k], 0) / ps.length : 0;
  return out;
}

// ------------------------------------------------------------------------------------------ one fight

export interface FightOutcome {
  /** 0 = side A (row) won, 1 = side B won, 2 = draw. Already un-swapped. */
  winner: 0 | 1 | 2;
  reason: BattleResult["reason"];
  duration: number;
  /** Damage dealt / taken by side A (row), summed over its fighters. */
  dealtA: number;
  takenA: number;
}

function teamOf(owner: string, members: Genemon[]): Team {
  return { id: `team-${owner}`, owner, name: owner, members };
}

/** One battle, A on side `side` (0 or 1), returned from A's point of view. */
export function fight(A: Genemon[], B: Genemon[], seed: number, side: 0 | 1, arenaIdx: number, hour: number, maxTime?: number): FightOutcome {
  const ta = teamOf("A", A), tb = teamOf("B", B);
  const r = new Battle({
    seed,
    arena: { seed, kind: ARENA_KINDS[((arenaIdx % ARENA_KINDS.length) + ARENA_KINDS.length) % ARENA_KINDS.length], weather: "clear", hour },
    teams: side === 0 ? [ta, tb] : [tb, ta],
    detail: "summary",
    ...(maxTime ? { maxTime } : {}),
  }).run();
  let dealtA = 0, takenA = 0;
  for (const f of r.fighters) if (f.team === side) (dealtA += f.tally.dealt), (takenA += f.tally.taken);
  const winner: 0 | 1 | 2 = r.winner === 2 ? 2 : r.winner === side ? 0 : 1;
  return { winner, reason: r.reason, duration: r.duration, dealtA, takenA };
}

// ------------------------------------------------------------------------------------------ matchup matrix

export interface MatrixOptions {
  level?: number;
  /** Slot budgets crossed (default [2, 3] = M and L bodies; the swarm fields that many S bodies). */
  slots?: number[];
  /** "mirror": both sides share the sample's element (isolates the archetype); "mixed": independent elements. */
  elements?: "mirror" | "mixed";
  /** Battle length cap (default: the engine's). */
  maxTime?: number;
}

export interface CellStats {
  a: ArchetypeId;
  b: ArchetypeId;
  wins: number;
  losses: number;
  draws: number;
  /** Decisive battles (wins + losses): the win-rate denominator. */
  n: number;
  p: number;
  lo: number;
  hi: number;
  medianDuration: number;
  meanDealt: number;
  meanTaken: number;
  timeouts: number;
}

export interface ArchetypeSummary {
  id: ArchetypeId;
  label: string;
  /** Overall vs the OTHER archetypes (mirror excluded), decisive only. */
  overall: Interval & { wins: number; n: number; draws: number };
  beats: { id: ArchetypeId; p: number; significant: boolean }[];
  losesTo: { id: ArchetypeId; p: number; significant: boolean }[];
  medianDuration: number;
  meanDealt: number;
  meanTaken: number;
  koRate: number;
  profile: StatProfile;
  /** Stat deviations from the mean of all archetypes (fraction, +0.25 = 25 % above). */
  deviations: Record<ProfileKey, number>;
  pros: string[];
  cons: string[];
  flags: string[];
}

export interface MatrixResult {
  ids: ArchetypeId[];
  /** cells[i][j]: archetype i (row) vs archetype j (column), i's point of view. */
  cells: CellStats[][];
  rows: ArchetypeSummary[];
  flags: string[];
  verdict: { noDominantRow: boolean; noLopsidedCell: boolean; allHaveProsAndCons: boolean };
  nPerCell: number;
  seed: number;
  battles: number;
  draws: number;
  build: BuildStats;
  buildBy: Record<string, BuildStats>;
  options: Required<Omit<MatrixOptions, "maxTime">> & { maxTime: number | null };
}

interface CellAcc {
  wins: number;
  losses: number;
  draws: number;
  durations: number[];
  dealt: number;
  taken: number;
  timeouts: number;
  kos: number;
}

const emptyAcc = (): CellAcc => ({ wins: 0, losses: 0, draws: 0, durations: [], dealt: 0, taken: 0, timeouts: 0, kos: 0 });

/** Resumable archetype x archetype batch (one unordered pair at a time, both cells filled per battle). */
export class MatrixJob {
  readonly archetypes: readonly BatchArchetype[];
  readonly nPerCell: number;
  readonly seed: number;
  readonly opts: MatrixResult["options"];
  readonly total: number;
  done = 0;
  /** Build stats per archetype (element emergence, strength, class misses). */
  readonly buildBy: Record<string, BuildStats> = {};
  private readonly pairs: [number, number][] = [];
  private readonly acc: CellAcc[][];
  private readonly profiles: StatProfile[][];

  constructor(archetypes: readonly BatchArchetype[], nPerCell: number, seed: number, o: MatrixOptions = {}) {
    if (archetypes.length < 2) throw new Error("MatrixJob needs at least 2 archetypes");
    this.archetypes = archetypes;
    this.nPerCell = Math.max(1, Math.floor(nPerCell));
    this.seed = seed >>> 0;
    this.opts = { level: o.level ?? 25, slots: o.slots?.length ? o.slots : [2, 3], elements: o.elements ?? "mirror", maxTime: o.maxTime ?? null };
    for (let i = 0; i < archetypes.length; i++) for (let j = i; j < archetypes.length; j++) this.pairs.push([i, j]);
    this.total = this.pairs.length * this.nPerCell;
    this.acc = archetypes.map(() => archetypes.map(emptyAcc));
    this.profiles = archetypes.map(() => []);
  }

  /** Run battles until done, `max` battles, or yieldNow() says stop. Returns true when finished. */
  advance(yieldNow: () => boolean = () => false, max = Infinity): boolean {
    let count = 0;
    while (this.done < this.total && count < max) {
      this.runOne(this.done);
      this.done++;
      count++;
      if (yieldNow()) break;
    }
    return this.done >= this.total;
  }

  private runOne(t: number): void {
    const pi = Math.floor(t / this.nPerCell), s = t % this.nPerCell;
    const [i, j] = this.pairs[pi];
    const A = this.archetypes[i], B = this.archetypes[j];
    const slotList = this.opts.slots;
    const slots = slotList[Math.floor(s / 2) % slotList.length];
    const side = (s % 2) as 0 | 1;
    const EL = BATCH_ELEMENTS;
    const eA = EL[(s + pi * 3) % EL.length];
    const eB = this.opts.elements === "mirror" ? eA : EL[(s * 5 + pi * 7 + 4) % EL.length];
    const lvl = this.opts.level;
    const sideA = buildSide(A, eA, slots, hashSeed(this.seed, "row", A.id, B.id, s), lvl + (A.levelBonus ?? 0), "batchA", (this.buildBy[A.id] ??= emptyBuildStats()));
    const sideB = buildSide(B, eB, slots, hashSeed(this.seed, "col", A.id, B.id, s), lvl + (B.levelBonus ?? 0), "batchB", (this.buildBy[B.id] ??= emptyBuildStats()));
    for (const g of sideA) this.profiles[i].push(profileOf(phenotypeOf(g)));
    for (const g of sideB) this.profiles[j].push(profileOf(phenotypeOf(g)));
    const out = fight(sideA, sideB, hashSeed(this.seed, "fight", A.id, B.id, s), side, s + pi, (s * 7 + 3) % 24, this.opts.maxTime ?? undefined);
    const ab = this.acc[i][j];
    const record = (c: CellAcc, won: boolean, lost: boolean, dealt: number, taken: number) => {
      if (won) c.wins++;
      else if (lost) c.losses++;
      else c.draws++;
      c.durations.push(out.duration);
      c.dealt += dealt;
      c.taken += taken;
      if (out.reason === "timeout") c.timeouts++;
      if (out.reason === "ko" && out.winner !== 2) c.kos++;
    };
    record(ab, out.winner === 0, out.winner === 1, out.dealtA, out.takenA);
    if (i !== j) record(this.acc[j][i], out.winner === 1, out.winner === 0, out.takenA, out.dealtA);
  }

  result(): MatrixResult {
    const ids = this.archetypes.map((a) => a.id);
    const lab = (id: string): string => this.archetypes.find((a) => a.id === id)?.label ?? id;
    const cells: CellStats[][] = this.acc.map((row, i) =>
      row.map((c, j) => {
        const n = c.wins + c.losses;
        const w = wilson(c.wins, n);
        const m = Math.max(1, c.durations.length);
        return {
          a: ids[i],
          b: ids[j],
          wins: c.wins,
          losses: c.losses,
          draws: c.draws,
          n,
          p: w.p,
          lo: w.lo,
          hi: w.hi,
          medianDuration: c.durations.length ? median(c.durations) : 0,
          meanDealt: c.dealt / m,
          meanTaken: c.taken / m,
          timeouts: c.timeouts,
        };
      })
    );
    const profiles = this.profiles.map(meanProfile);
    const fieldMean = meanProfile(profiles);
    const flags: string[] = [];
    const rows: ArchetypeSummary[] = this.archetypes.map((a, i) => {
      let wins = 0, n = 0, draws = 0, dealt = 0, taken = 0, kos = 0, fights = 0;
      const durations: number[] = [];
      for (let j = 0; j < ids.length; j++) {
        if (j === i) continue;
        const c = this.acc[i][j];
        (wins += c.wins), (n += c.wins + c.losses), (draws += c.draws), (dealt += c.dealt), (taken += c.taken), (kos += c.kos);
        fights += c.durations.length;
        durations.push(...c.durations);
      }
      const overall = { ...wilson(wins, n), wins, n, draws };
      const others = cells[i].filter((_, j) => j !== i && cells[i][j].n > 0);
      const beats = others.filter((c) => c.p > 0.5).sort((x, y) => y.p - x.p).map((c) => ({ id: c.b, p: c.p, significant: c.lo > 0.5 }));
      const losesTo = others.filter((c) => c.p < 0.5).sort((x, y) => x.p - y.p).map((c) => ({ id: c.b, p: c.p, significant: c.hi < 0.5 }));
      const deviations = {} as Record<ProfileKey, number>;
      for (const k of PROFILE_KEYS) deviations[k] = fieldMean[k] ? profiles[i][k] / fieldMean[k] - 1 : 0;
      const ranked = PROFILE_KEYS.slice().sort((x, y) => deviations[y] - deviations[x]);
      const pc = (v: number) => `${Math.round(v * 100)}%`;
      const sgn = (v: number) => `${v >= 0 ? "+" : "−"}${Math.round(Math.abs(v) * 100)}%`;
      const pros = [
        ...ranked.slice(0, 2).filter((k) => deviations[k] > 0.02).map((k) => `${PROFILE_LABEL[k]} ${sgn(deviations[k])}`),
        ...beats.map((b) => `beats ${lab(b.id)} ${pc(b.p)}${b.significant ? " *" : ""}`),
      ];
      const cons = [
        ...ranked.slice(-2).reverse().filter((k) => deviations[k] < -0.02).map((k) => `${PROFILE_LABEL[k]} ${sgn(deviations[k])}`),
        ...losesTo.map((b) => `loses to ${lab(b.id)} ${pc(b.p)}${b.significant ? " *" : ""}`),
      ];
      const rowFlags: string[] = [];
      if (n > 0 && overall.p > DOMINANT_ROW) rowFlags.push(`DOMINANT: ${pc(overall.p)} overall > ${pc(DOMINANT_ROW)}`);
      if (n > 0 && overall.p < WEAK_ROW) rowFlags.push(`WEAK: ${pc(overall.p)} overall < ${pc(WEAK_ROW)}`);
      for (const c of others) {
        if (c.n >= MIN_FLAG_N && c.p > LOPSIDED_CELL) rowFlags.push(`LOPSIDED: vs ${lab(c.b)} ${pc(c.p)} > ${pc(LOPSIDED_CELL)} (n=${c.n})`);
      }
      for (const f of rowFlags) flags.push(`${a.label}: ${f}`);
      return {
        id: a.id,
        label: a.label,
        overall,
        beats,
        losesTo,
        medianDuration: durations.length ? median(durations) : 0,
        meanDealt: dealt / Math.max(1, fights),
        meanTaken: taken / Math.max(1, fights),
        koRate: kos / Math.max(1, fights),
        profile: profiles[i],
        deviations,
        pros,
        cons,
        flags: rowFlags,
      };
    });
    const draws = this.acc.reduce((s, row, i) => s + row.reduce((t, c, j) => t + (j >= i ? c.draws : 0), 0), 0);
    return {
      ids,
      cells,
      rows,
      flags,
      verdict: {
        noDominantRow: !rows.some((r) => r.overall.n > 0 && r.overall.p > DOMINANT_ROW),
        noLopsidedCell: !cells.some((row, i) => row.some((c, j) => i !== j && c.n >= MIN_FLAG_N && c.p > LOPSIDED_CELL)),
        allHaveProsAndCons: rows.every((r) => r.beats.length > 0 && r.losesTo.length > 0),
      },
      nPerCell: this.nPerCell,
      seed: this.seed,
      battles: this.done,
      draws,
      build: Object.values(this.buildBy).reduce((t, b) => ({ built: t.built + b.built, missed: t.missed + b.missed, elementHits: t.elementHits + b.elementHits, strengthSum: t.strengthSum + b.strengthSum }), emptyBuildStats()),
      buildBy: structuredClone(this.buildBy),
      options: this.opts,
    };
  }
}

/** Archetype x archetype win-rate matrix, run to completion (see MatrixJob for the sliced version). */
export function matchupMatrix(archetypes: readonly BatchArchetype[], nPerCell: number, seed: number, opts: MatrixOptions = {}): MatrixResult {
  const job = new MatrixJob(archetypes, nPerCell, seed, opts);
  job.advance();
  return job.result();
}

// ------------------------------------------------------------------------------------------ fitness

/** Fitness in [0, 1] of one Genemon; deterministic in (g, seed). */
export type FitnessFn = (g: Genemon, seed: number) => number;

export interface GauntletOptions {
  archetypes?: readonly BatchArchetype[];
  /** Battles per archetype opponent (default 1; sides alternate). */
  fightsPer?: number;
  level?: number;
  maxTime?: number;
}

/**
 * Win rate against an archetype gauntlet built at the candidate's OWN slot count and primary element
 * (a neutral candidate meets a rotating element). Draws count half. Opponents are cached per key, so the
 * gauntlet is fixed: selection measures shape, never size.
 */
export function gauntletFitness(o: GauntletOptions = {}): FitnessFn {
  const archetypes = o.archetypes ?? BATCH_ARCHETYPES;
  const per = Math.max(1, Math.floor(o.fightsPer ?? 1));
  const level = o.level ?? 25;
  const cache = new Map<string, Genemon[]>();
  return (g, seed) => {
    const ph = phenotypeOf(g);
    const slots = Math.min(4, ph.slots);
    let score = 0, fights = 0;
    archetypes.forEach((a, ai) => {
      for (let k = 0; k < per; k++) {
        const e = ph.elements.primary !== "neutral" ? ph.elements.primary : BATCH_ELEMENTS[(ai + k) % BATCH_ELEMENTS.length];
        const key = `${a.id}|${slots}|${e}|${k}|${level}`;
        let opp = cache.get(key);
        if (!opp) cache.set(key, (opp = buildSide(a, e, slots, hashSeed("gauntlet", a.id, slots, e, k), level, "gauntlet")));
        const out = fight([g], opp, hashSeed(seed, g.id, a.id, k), ((ai + k) % 2) as 0 | 1, ai + k, (ai * 5 + k * 7 + 3) % 24, o.maxTime);
        score += out.winner === 0 ? 1 : out.winner === 2 ? 0.5 : 0;
        fights++;
      }
    });
    return fights ? score / fights : 0;
  };
}

// ------------------------------------------------------------------------------------------ batch breeding

export interface BreedBatchOptions {
  /** Tournament size (default 3). */
  tournament?: number;
  /** Best individuals copied unchanged into the next generation (default 1). */
  elite?: number;
  /** Chance a child also goes through mutate() (default 0.35), strength (default 0.25). */
  mutateChance?: number;
  mutateStrength?: number;
  /** Per-gene breed mutation rate (default: breeding.ts's 0.03). */
  mutationRate?: number;
  /** Level of the children (default: median level of the seed population). */
  level?: number;
  owner?: string;
  archetypes?: readonly BatchArchetype[];
}

export interface GenerationStats {
  gen: number;
  size: number;
  meanFitness: number;
  bestFitness: number;
  meanStats: StatProfile;
  /** Mean power index and power per slot. */
  meanPower: number;
  powerPerSlot: number;
  /** Share of the population nearest to each archetype (archetype drift). */
  archetypeShare: Record<string, number>;
  /** Mean pairwise genetic distance (mean |allele difference| over the axes). */
  diversity: number;
  sizeShare: Partial<Record<SizeClass, number>>;
  bestId: string;
  bestName: string;
  bestArchetype: ArchetypeId;
}

export interface BreedBatchResult {
  generations: GenerationStats[];
  population: Genemon[];
  fitness: number[];
  /** Best individual bred during the batch (not one of the seed Genemon); null if none was bred. */
  bestChild: Genemon | null;
  bestChildFitness: number;
  evaluations: number;
}

function populationStats(gen: number, pop: readonly Genemon[], fit: readonly number[], archetypes: readonly BatchArchetype[]): GenerationStats {
  const phs = pop.map(phenotypeOf);
  const prof = meanProfile(phs.map(profileOf));
  const share: Record<string, number> = Object.fromEntries(archetypes.map((a) => [a.id, 0]));
  for (const g of pop) share[classifyArchetype(g, archetypes)] += 1 / pop.length;
  const sizeShare: Partial<Record<SizeClass, number>> = {};
  for (const ph of phs) sizeShare[ph.sizeClass] = (sizeShare[ph.sizeClass] ?? 0) + 1 / pop.length;
  let d = 0, pairs = 0;
  for (let i = 0; i < pop.length; i++) for (let j = i + 1; j < pop.length; j++) (d += geneticDistance(pop[i].genome, pop[j].genome)), pairs++;
  let bi = 0;
  for (let i = 1; i < fit.length; i++) if (fit[i] > fit[bi]) bi = i;
  return {
    gen,
    size: pop.length,
    meanFitness: fit.reduce((s, v) => s + v, 0) / Math.max(1, fit.length),
    bestFitness: fit[bi] ?? 0,
    meanStats: prof,
    meanPower: prof.power,
    powerPerSlot: prof.powerPerSlot,
    archetypeShare: share,
    diversity: pairs ? d / pairs : 0,
    sizeShare,
    bestId: pop[bi]?.id ?? "",
    bestName: pop[bi]?.name ?? "",
    bestArchetype: pop[bi] ? classifyArchetype(pop[bi], archetypes) : archetypes[0].id,
  };
}

/** Resumable batch breeding: one fitness evaluation per unit of work. */
export class BreedJob {
  readonly generations: number;
  readonly popSize: number;
  readonly seed: number;
  readonly total: number;
  done = 0;
  private readonly fitness: FitnessFn;
  private readonly o: Required<Omit<BreedBatchOptions, "mutationRate">> & { mutationRate: number | undefined };
  private readonly seedIds: Set<string>;
  private gen = 0;
  private pop: Genemon[];
  private fit: number[] = [];
  private readonly stats: GenerationStats[] = [];
  private bestChild: Genemon | null = null;
  private bestChildFit = -1;

  constructor(seedPop: readonly Genemon[], generations: number, popSize: number, fitness: FitnessFn, seed: number, o: BreedBatchOptions = {}) {
    if (seedPop.length === 0) throw new Error("breedBatch needs at least one seed Genemon");
    this.generations = Math.max(0, Math.floor(generations));
    this.popSize = Math.max(2, Math.floor(popSize));
    this.seed = seed >>> 0;
    this.fitness = fitness;
    const levels = seedPop.map((g) => phenotypeOf(g).level).sort((a, b) => a - b);
    this.o = {
      tournament: Math.max(1, o.tournament ?? 3),
      elite: clamp(Math.floor(o.elite ?? 1), 0, this.popSize - 1),
      mutateChance: o.mutateChance ?? 0.35,
      mutateStrength: o.mutateStrength ?? 0.25,
      mutationRate: o.mutationRate,
      level: o.level ?? levels[Math.floor(levels.length / 2)],
      owner: o.owner ?? "batch",
      archetypes: o.archetypes ?? BATCH_ARCHETYPES,
    };
    this.seedIds = new Set(seedPop.map((g) => g.id));
    // Generation 0: the seed Genemon, topped up with their children (or trimmed) to popSize.
    const rng = new Rng(hashSeed(this.seed, "gen0"));
    const pop = seedPop.slice(0, this.popSize);
    let k = 0;
    while (pop.length < this.popSize) {
      const a = rng.pick(seedPop), b = seedPop.length > 1 ? rng.pick(seedPop.filter((x) => x !== a)) : a;
      pop.push(this.child(a, b, hashSeed(this.seed, "fill", k++)));
    }
    this.pop = pop;
    this.total = (this.generations + 1) * this.popSize;
  }

  private child(a: Genemon, b: Genemon, s: number): Genemon {
    const rng = new Rng(hashSeed(s, "child"));
    let genome = breed(a.genome, b.genome, s, this.o.mutationRate !== undefined ? { mutationRate: this.o.mutationRate } : {});
    if (rng.chance(this.o.mutateChance)) genome = mutate(genome, hashSeed(s, "mut"), this.o.mutateStrength);
    return createGenemon({ seed: s, genome, level: this.o.level, owner: this.o.owner });
  }

  private nextGeneration(): void {
    const rng = new Rng(hashSeed(this.seed, "select", this.gen));
    const order = this.pop.map((_, i) => i).sort((x, y) => this.fit[y] - this.fit[x] || (this.pop[x].id < this.pop[y].id ? -1 : 1));
    const next: Genemon[] = order.slice(0, this.o.elite).map((i) => this.pop[i]);
    const tour = (): number => {
      let best = rng.int(0, this.pop.length - 1);
      for (let t = 1; t < this.o.tournament; t++) {
        const c = rng.int(0, this.pop.length - 1);
        if (this.fit[c] > this.fit[best]) best = c;
      }
      return best;
    };
    let k = 0;
    while (next.length < this.popSize) {
      const ia = tour();
      let ib = tour();
      for (let r = 0; r < 3 && ib === ia; r++) ib = tour();
      next.push(this.child(this.pop[ia], this.pop[ib], hashSeed(this.seed, "gen", this.gen + 1, k++)));
    }
    this.pop = next;
    this.fit = [];
    this.gen++;
  }

  /** Evaluate until done, `max` evaluations, or yieldNow() says stop. Returns true when finished. */
  advance(yieldNow: () => boolean = () => false, max = Infinity): boolean {
    let count = 0;
    while (this.done < this.total && count < max) {
      const i = this.fit.length;
      const g = this.pop[i];
      const f = this.fitness(g, hashSeed(this.seed, "eval", this.gen, i));
      this.fit.push(f);
      if (!this.seedIds.has(g.id) && f > this.bestChildFit) (this.bestChild = g), (this.bestChildFit = f);
      this.done++;
      count++;
      if (this.fit.length === this.pop.length) {
        this.stats.push(populationStats(this.gen, this.pop, this.fit, this.o.archetypes));
        if (this.gen < this.generations) this.nextGeneration();
      }
      if (yieldNow()) break;
    }
    return this.done >= this.total;
  }

  /** Generation curves so far (one entry per fully evaluated generation). */
  get curve(): readonly GenerationStats[] {
    return this.stats;
  }

  result(): BreedBatchResult {
    return {
      generations: this.stats.slice(),
      population: this.pop.slice(),
      fitness: this.fit.slice(),
      bestChild: this.bestChild,
      bestChildFitness: Math.max(0, this.bestChildFit),
      evaluations: this.done,
    };
  }
}

/** Batch breeding run to completion (see BreedJob for the sliced version). Deterministic in its inputs. */
export function breedBatch(seedPop: readonly Genemon[], generations: number, popSize: number, fitness: FitnessFn, seed: number, o: BreedBatchOptions = {}): BreedBatchResult {
  const job = new BreedJob(seedPop, generations, popSize, fitness, seed, o);
  job.advance();
  return job.result();
}

// ------------------------------------------------------------------------------------------ colossus vs six [P6-B1, P6-B2]

/** Team-quality brackets of the six small Genemon that face a lone colossus. */
export const QUALITY_BRACKETS = ["poor", "median", "good"] as const;
export type QualityBracket = typeof QUALITY_BRACKETS[number];
/** Level brackets: both sides fight at the same level. */
export const LEVEL_BRACKETS = [10, 25, 50] as const;
/** Target band of the six's win rate per bracket (decisive only) [P6-B1]. */
export const COLOSSUS_TARGET: Record<QualityBracket, [number, number]> = { poor: [0.25, 0.4], median: [0.45, 0.55], good: [0.55, 0.7] };

/**
 * The XXL colossus recipe (until src/genome/complexity.ts lands): the element signature at 0.8, then stature and
 * weight pushed to the top of their range, a quadruped with a thick body (girth 0.9) on medium legs, small spread.
 * The first (stature, weight, variant) whose body is XXL with the requested primary element wins.
 */
export const COLOSSUS_RECIPE = { statures: [0.9, 0.95, 1], weights: [0.6, 0.8, 0.95], variants: 3, kind: "quadruped" as BodyKind, plan: { quality: 0.5, girth: 0.9, legLen: 0.6 }, spread: 0.1, signature: 0.8 };

export interface ColossusBuildStats {
  built: number;
  /** No recipe step reached XXL: the heaviest body was used (counted, never hidden). */
  missedClass: number;
  /** The requested element did not come out primary. */
  missedElement: number;
}

/** Part genes raised on a bred-to-the-top colossus line (the planZ term of src/genome/complexity.ts saturates). */
const COLOSSUS_PARTS: readonly PlanGene[] = ["wings", "horns", "spikes", "tail", "segments", "ears", "quality", "neck", "eyes", "jaw"];

/**
 * Pass 6: XXL is reserved for REAL colossi (phenotype.ts caps every other body below 6000 kg), so the recipe
 * genome is turned into a colossal one the way a breeder would: every complexity allele at its top, the part
 * genes high, then the colossus body (genome.ts colossusBody). The per-seed developmental luck can still keep
 * it below the colossal cut (~10 % of seeds): the caller's loop simply tries the next variant.
 */
function colossalize(g: Genemon, seed: number, owner: string, level: number): Genemon {
  const gen = cloneGenome(g.genome);
  gen.cxGenes = Array.from({ length: CX_PAIRS }, () => [1, 1] as [number, number]);
  for (const id of COLOSSUS_PARTS) gen.plan[id] = [Math.max(gen.plan[id][0], 0.8), Math.max(gen.plan[id][1], 0.8)];
  const { id: _id, ...rest } = gen;
  void _id;
  if (!isColossal(rest)) return g;
  const sealed: Genome = sealGenome(rest);
  return createGenemon({ seed, owner, level, genome: sealed });
}

/** A lone XXL colossus of primary element `e` at `level` (recipe COLOSSUS_RECIPE; deterministic in seed). */
export function buildColossus(e: ElementId, seed: number, level = 25, owner = "colossus", stats?: ColossusBuildStats): Genemon {
  const R = COLOSSUS_RECIPE;
  const sig: Partial<AxisVector> = {};
  for (const [k, v] of Object.entries(ELEMENTS[e].signature)) sig[k as AxisId] = clamp((v as number) * R.signature, -0.95, 0.95);
  let best: Genemon | null = null, bestScore = -Infinity;
  for (const stature of R.statures) {
    for (const w of R.weights) {
      for (let k = 0; k < R.variants; k++) {
        const axes: Partial<AxisVector> = { ...sig, stature, weight: Math.max(sig.weight ?? -1, w) };
        const s0 = hashSeed(seed, "colossus", e, stature, w, k);
        const g = colossalize(createGenemon({ seed: s0, owner, level, bias: { axes, kind: R.kind, spread: R.spread, plan: R.plan } }), s0, owner, level);
        const ph = phenotypeOf(g);
        const score = (ph.sizeClass === "XXL" ? 2 : 0) + (ph.elements.primary === e ? 1 : 0) + ph.massKg / 1e6;
        if (score > bestScore) (best = g), (bestScore = score);
        if (score >= 3) {
          if (stats) stats.built++;
          return g;
        }
      }
    }
  }
  const ph = phenotypeOf(best!);
  if (stats) {
    stats.built++;
    if (ph.sizeClass !== "XXL") stats.missedClass++;
    if (ph.elements.primary !== e) stats.missedElement++;
  }
  return best!;
}

/** A plain small body of element e (no archetype genes): the element signature at 0.8, stature searched for class S. */
const PLAIN: BatchArchetype = { id: "plain" as ArchetypeId, label: "Plain", color: "#a7b3c6", axes: {}, intent: "element signature only" };
export function smallBody(e: ElementId, seed: number, level = 25, owner = "six", stats?: BuildStats): Genemon {
  return buildBody(PLAIN, e, "S", seed, level, owner, stats);
}

const typesOf = (g: Genemon): ElementId[] => {
  const ph = phenotypeOf(g);
  return [ph.elements.primary, ...(ph.elements.secondary ? [ph.elements.secondary] : [])];
};

/**
 * Edge of element `e` against a colossus (log2 units): how hard its own-element moves hit the colossus minus how
 * hard the colossus's damaging moves hit an `e` body. Negative = a bad element to bring.
 */
export function elementEdge(e: ElementId, colossus: Genemon): number {
  const ct = typesOf(colossus);
  const els = [...new Set(colossus.moves.map((id) => ALL_MOVE_BY_ID[id]).filter((m) => m && isDamaging(m)).map((m) => m.element))];
  const worst = els.length ? Math.max(...els.map((x) => typeMultiplier(x, [e]))) : 1;
  return Math.log2(typeMultiplier(e, ct)) - Math.log2(worst);
}

export interface ComposedSix {
  members: Genemon[];
  quality: TeamQuality;
}

/** Candidate pool of the composer: POOL_PER_ELEMENT small bodies per element (26). */
export const POOL_PER_ELEMENT = 2;

/**
 * Compose six small Genemon (one slot each) against `colossus` at `level`:
 *  - good: greedy on teamQuality from a pool of 2 S bodies per element (coverage of the colossus's weaknesses,
 *    mixed synergies, kits, distinct elements);
 *  - median: six random members of the same pool;
 *  - poor: six bodies of ONE element, the one with the lowest elementEdge against the colossus (ties rotate by seed).
 */
export function composeSix(colossus: Genemon, bracket: QualityBracket, seed: number, level = 25, owner = "six", stats?: BuildStats): ComposedSix {
  const rng = new Rng(hashSeed(seed, "compose", bracket));
  let members: Genemon[];
  if (bracket === "poor") {
    const ranked = BATCH_ELEMENTS.map((e) => ({ e, edge: elementEdge(e, colossus) })).sort((a, b) => a.edge - b.edge || (a.e < b.e ? -1 : 1));
    const worst = ranked.filter((r) => r.edge <= ranked[0].edge + 1e-9);
    const e = worst[rng.int(0, worst.length - 1)].e;
    members = Array.from({ length: TEAM_CAPACITY }, (_, k) => smallBody(e, hashSeed(seed, "poor", k), level, owner, stats));
  } else {
    const pool = BATCH_ELEMENTS.flatMap((e) => Array.from({ length: POOL_PER_ELEMENT }, (_, k) => smallBody(e, hashSeed(seed, "pool", e, k), level, owner, stats)));
    if (bracket === "median") members = rng.shuffle(pool.slice()).slice(0, TEAM_CAPACITY);
    else {
      members = [];
      const left = pool.slice();
      while (members.length < TEAM_CAPACITY && left.length) {
        let bi = 0, bs = -Infinity;
        left.forEach((g, i) => {
          const s = teamQuality([...members, g], [colossus]).score;
          if (s > bs + 1e-12) (bs = s), (bi = i);
        });
        members.push(left.splice(bi, 1)[0]);
      }
    }
  }
  return { members, quality: teamQuality(members, [colossus]) };
}

export interface ColossusCell {
  level: number;
  bracket: QualityBracket;
  /** Six's wins / colossus wins / draws. */
  wins: number;
  losses: number;
  draws: number;
  n: number;
  /** Six's win rate (decisive only) and its 95 % Wilson interval; the colossus's is 1 - p. */
  p: number;
  lo: number;
  hi: number;
  medianDuration: number;
  timeouts: number;
  /** Mean team-quality score and components of the six. */
  quality: Omit<TeamQuality, "synergies">;
  /** Mean number of synergies the six formed at the start. */
  synergies: number;
  /** Mean members of the six still standing when the six won. */
  sixSurvivors: number;
  inBand: boolean;
}

export interface ColossusResult {
  levels: number[];
  brackets: QualityBracket[];
  /** cells[levelIdx][bracketIdx] */
  cells: ColossusCell[][];
  /** Per bracket, all levels pooled. */
  pooled: ColossusCell[];
  nPerCell: number;
  seed: number;
  battles: number;
  draws: number;
  colossusBuild: ColossusBuildStats;
  sixBuild: BuildStats;
  verdict: { goodBeatsColossus: boolean; poorLosesToColossus: boolean; medianBalanced: boolean; allInBand: boolean };
  flags: string[];
}

interface ColAcc {
  wins: number;
  losses: number;
  draws: number;
  durations: number[];
  timeouts: number;
  q: Omit<TeamQuality, "synergies">;
  syn: number;
  survivors: number;
  fights: number;
}
const emptyColAcc = (): ColAcc => ({ wins: 0, losses: 0, draws: 0, durations: [], timeouts: 0, q: { score: 0, synergy: 0, offense: 0, defense: 0, diversity: 0, kit: 0 }, syn: 0, survivors: 0, fights: 0 });

/**
 * Resumable COLOSSUS vs SIX batch: for every level bracket and battle index one colossus (element rotating through
 * all 13) meets the poor, the median and the good six (the same colossus for the three, so the brackets are
 * paired), sides swapped every other battle, arenas and hours rotating. One unit of work = one battle.
 */
export class ColossusJob {
  readonly levels: number[];
  readonly nPerCell: number;
  readonly seed: number;
  readonly total: number;
  readonly maxTime: number | undefined;
  done = 0;
  readonly colossusBuild: ColossusBuildStats = { built: 0, missedClass: 0, missedElement: 0 };
  readonly sixBuild: BuildStats = emptyBuildStats();
  private readonly acc: ColAcc[][];
  private col: { key: string; g: Genemon } | null = null;

  constructor(nPerCell: number, seed: number, levels: readonly number[] = LEVEL_BRACKETS, maxTime?: number) {
    this.levels = levels.slice();
    this.nPerCell = Math.max(1, Math.floor(nPerCell));
    this.seed = seed >>> 0;
    this.maxTime = maxTime;
    this.total = this.levels.length * QUALITY_BRACKETS.length * this.nPerCell;
    this.acc = this.levels.map(() => QUALITY_BRACKETS.map(emptyColAcc));
  }

  advance(yieldNow: () => boolean = () => false, max = Infinity): boolean {
    let count = 0;
    while (this.done < this.total && count < max) {
      this.runOne(this.done);
      this.done++;
      count++;
      if (yieldNow()) break;
    }
    return this.done >= this.total;
  }

  private runOne(t: number): void {
    const per = QUALITY_BRACKETS.length;
    const li = Math.floor(t / (this.nPerCell * per)), rem = t % (this.nPerCell * per);
    const s = Math.floor(rem / per), qi = rem % per;
    const level = this.levels[li], bracket = QUALITY_BRACKETS[qi];
    const e = BATCH_ELEMENTS[(s + li * 5) % BATCH_ELEMENTS.length];
    const key = `${li}|${s}`;
    if (this.col?.key !== key) this.col = { key, g: buildColossus(e, hashSeed(this.seed, "col", level, s), level, "colossus", this.colossusBuild) };
    const colossus = this.col.g;
    const six = composeSix(colossus, bracket, hashSeed(this.seed, "six", level, s), level, "six", this.sixBuild);
    const side = (s % 2) as 0 | 1;
    const r = new Battle({
      seed: hashSeed(this.seed, "cfight", level, s, bracket),
      arena: { seed: hashSeed(this.seed, "arena", s), kind: ARENA_KINDS[(s + li) % ARENA_KINDS.length], weather: "clear", hour: (s * 7 + 3) % 24 },
      teams: side === 0 ? [teamOf("six", six.members), teamOf("colossus", [colossus])] : [teamOf("colossus", [colossus]), teamOf("six", six.members)],
      detail: "summary",
      ...(this.maxTime ? { maxTime: this.maxTime } : {}),
    }).run();
    const c = this.acc[li][qi];
    if (r.winner === 2) c.draws++;
    else if (r.winner === side) {
      c.wins++;
      c.survivors += r.fighters.filter((f) => f.team === side && f.alive).length;
    } else c.losses++;
    c.durations.push(r.duration);
    if (r.reason === "timeout") c.timeouts++;
    for (const k of Object.keys(c.q) as (keyof ColAcc["q"])[]) c.q[k] += six.quality[k];
    c.syn += r.synergies[side].length;
    c.fights++;
  }

  private cell(level: number, bracket: QualityBracket, c: ColAcc): ColossusCell {
    const n = c.wins + c.losses;
    const w = wilson(c.wins, n);
    const m = Math.max(1, c.fights);
    const q = { ...c.q };
    for (const k of Object.keys(q) as (keyof typeof q)[]) q[k] /= m;
    const [lo, hi] = COLOSSUS_TARGET[bracket];
    return {
      level,
      bracket,
      wins: c.wins,
      losses: c.losses,
      draws: c.draws,
      n,
      p: w.p,
      lo: w.lo,
      hi: w.hi,
      medianDuration: c.durations.length ? median(c.durations) : 0,
      timeouts: c.timeouts,
      quality: q,
      synergies: c.syn / m,
      sixSurvivors: c.wins ? c.survivors / c.wins : 0,
      inBand: n > 0 && w.p >= lo && w.p <= hi,
    };
  }

  result(): ColossusResult {
    const cells = this.acc.map((row, li) => row.map((c, qi) => this.cell(this.levels[li], QUALITY_BRACKETS[qi], c)));
    const pooled = QUALITY_BRACKETS.map((b, qi) => {
      const sum = emptyColAcc();
      for (const row of this.acc) {
        const c = row[qi];
        (sum.wins += c.wins), (sum.losses += c.losses), (sum.draws += c.draws), sum.durations.push(...c.durations), (sum.timeouts += c.timeouts);
        for (const k of Object.keys(sum.q) as (keyof ColAcc["q"])[]) sum.q[k] += c.q[k];
        (sum.syn += c.syn), (sum.survivors += c.survivors), (sum.fights += c.fights);
      }
      return this.cell(0, b, sum);
    });
    const flags: string[] = [];
    for (const row of cells) {
      for (const c of row) {
        if (c.n && !c.inBand) flags.push(`L${c.level} ${c.bracket}: six win ${pc(c.p)} outside ${pc(COLOSSUS_TARGET[c.bracket][0])}-${pc(COLOSSUS_TARGET[c.bracket][1])} (n=${c.n})`);
      }
    }
    const P = Object.fromEntries(pooled.map((c) => [c.bracket, c])) as Record<QualityBracket, ColossusCell>;
    const draws = this.acc.reduce((s, row) => s + row.reduce((t, c) => t + c.draws, 0), 0);
    return {
      levels: this.levels.slice(),
      brackets: [...QUALITY_BRACKETS],
      cells,
      pooled,
      nPerCell: this.nPerCell,
      seed: this.seed,
      battles: this.done,
      draws,
      colossusBuild: { ...this.colossusBuild },
      sixBuild: { ...this.sixBuild },
      verdict: {
        goodBeatsColossus: P.good.n > 0 && P.good.p > 0.5 && cells.every((row) => row[2].n === 0 || row[2].p > 0.5),
        poorLosesToColossus: P.poor.n > 0 && P.poor.p < 0.5 && cells.every((row) => row[0].n === 0 || row[0].p < 0.5),
        medianBalanced: P.median.inBand,
        allInBand: cells.every((row) => row.every((c) => c.n === 0 || c.inBand)),
      },
      flags,
    };
  }
}

/** Colossus vs six batch run to completion (see ColossusJob for the sliced version). */
export function colossusMatrix(nPerCell: number, seed: number, levels: readonly number[] = LEVEL_BRACKETS, maxTime?: number): ColossusResult {
  const job = new ColossusJob(nPerCell, seed, levels, maxTime);
  job.advance();
  return job.result();
}

/** Markdown section for the colossus batch. */
export function colossusReportMarkdown(c: ColossusResult, held?: ColossusResult): string {
  const q = (v: number) => v.toFixed(2);
  const row = (x: ColossusCell) => `${pc(x.p)} <sub>${pc(x.lo)}-${pc(x.hi)}, ${x.wins}-${x.losses}${x.draws ? `, ${x.draws}d` : ""}</sub>${x.inBand ? "" : " ⚠"}`;
  const R = COLOSSUS_RECIPE;
  const lines = [
    "## 6. Colossus vs six [P6-B1, P6-B2]",
    "",
    `One lone XXL colossus (6 slots) against six small S Genemon (1 slot each) at the SAME level; ${c.nPerCell} battles per cell (${c.battles} battles, seed ${c.seed}); ` +
    `the colossus's element rotates through all 13 and the SAME colossus meets the poor, the median and the good six (paired brackets); sides swapped every other battle; arenas and hours rotate.`,
    `Colossus recipe (GenomeBias, until src/genome/complexity.ts lands): element signature x${R.signature}, stature ${R.statures.join("/")}, weight >= ${R.weights.join("/")}, ${R.kind}, girth ${R.plan.girth}, legLen ${R.plan.legLen}, spread ${R.spread}: ` +
    `${c.colossusBuild.built} built, ${c.colossusBuild.missedClass} not XXL, ${c.colossusBuild.missedElement} off-element.`,
    `Six: ${c.sixBuild.built} S bodies built, ${c.sixBuild.missed} missed class S. Brackets: **good** = greedy on the team-quality score from a pool of ${POOL_PER_ELEMENT} S bodies per element; **median** = 6 random members of that pool; **poor** = six bodies of the element with the lowest edge against the colossus (same element, weak to it, no mixed synergy).`,
    `Quality score = ${Object.entries(QUALITY_WEIGHTS).map(([k, v]) => `${v} ${k}`).join(" + ")} (src/combat/team.ts teamQuality). Win rate = the SIX's, decisive only (the colossus's is 100 % minus it); draws ${c.draws}/${c.battles}, reported per cell; ⚠ = outside the target band.`,
    "",
    `Target bands (six's win rate): ${QUALITY_BRACKETS.map((b) => `${b} ${pc(COLOSSUS_TARGET[b][0])}-${pc(COLOSSUS_TARGET[b][1])}`).join(", ")}.`,
    "",
    `- Good six beats the colossus (every level > 50 %): **${c.verdict.goodBeatsColossus ? "yes" : "NO"}**`,
    `- Poor six loses to it (every level < 50 %): **${c.verdict.poorLosesToColossus ? "yes" : "NO"}**`,
    `- Median six balanced (pooled 45-55 %): **${c.verdict.medianBalanced ? "yes" : "NO"}**`,
    `- Every cell in its band: **${c.verdict.allInBand ? "yes" : "NO"}**`,
    ...(c.flags.length ? ["", ...c.flags.map((f) => `- ${f}`)] : []),
    "",
    `| level \\ six | ${c.brackets.join(" | ")} |`,
    `|---|${c.brackets.map(() => "---").join("|")}|`,
    ...c.cells.map((r, li) => `| **${c.levels[li]}** | ${r.map(row).join(" | ")} |`),
    `| **all** | ${c.pooled.map(row).join(" | ")} |`,
    ...(held ? [`| held-out seed ${held.seed} (all) | ${held.pooled.map(row).join(" | ")} |`] : []),
    "",
    "| bracket | quality score | synergy | offense | defense | diversity | kit | synergies formed | median duration | timeouts | survivors when the six wins |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
    ...c.pooled.map((x) => `| ${x.bracket} | ${q(x.quality.score)} | ${q(x.quality.synergy)} | ${q(x.quality.offense)} | ${q(x.quality.defense)} | ${q(x.quality.diversity)} | ${q(x.quality.kit)} | ${x.synergies.toFixed(1)} | ${x.medianDuration.toFixed(1)} s | ${x.timeouts} | ${x.sixSurvivors.toFixed(1)} |`),
    "",
  ];
  return lines.join("\n");
}

// ------------------------------------------------------------------------------------------ report

const pc = (p: number) => `${Math.round(p * 100)}%`;
const f1 = (v: number) => v.toFixed(1);
const f2 = (v: number) => v.toFixed(2);

/** Markdown report: matrix, pros/cons, weights/costs/probabilities and (optionally) a breeding curve. */
export function batchReportMarkdown(m: MatrixResult, breedRun?: { result: BreedBatchResult; label: string }, header = ""): string {
  const L = (id: ArchetypeId) => ARCHETYPE_BY_ID[id]?.label ?? id;
  const lines: string[] = ["# Batch lab report [P5-X1]", ""];
  if (header) lines.push(header, "");
  const o = m.options;
  lines.push(
    `Archetype matchup matrix: ${m.ids.length} archetypes, ${m.nPerCell} battles per unordered pair (${m.battles} battles, seed ${m.seed}), ` +
      `slot budgets ${o.slots.join(" / ")} (M / L bodies; the swarm fields the same slots as S bodies), level ${o.level}, ` +
      `elements ${o.elements === "mirror" ? "mirrored (both sides share the sample's element, rotating through all 13)" : "mixed"}, sides swapped every other battle.`,
    `Bodies built: ${m.build.built} (${m.build.missed} missed the wanted size class and used the closest one); requested element came out primary in ${pc(m.build.elementHits / Math.max(1, m.build.built))}.`,
    `Draws: ${m.draws}/${m.battles}. Win rates EXCLUDE draws; 95 % Wilson intervals; * = interval excludes 50 %.`,
    "",
    "## 1. Verdict",
    "",
    `- No row above ${pc(DOMINANT_ROW)} overall: **${m.verdict.noDominantRow ? "yes" : "NO"}**`,
    `- No cell above ${pc(LOPSIDED_CELL)} (n >= ${MIN_FLAG_N}): **${m.verdict.noLopsidedCell ? "yes" : "NO"}**`,
    `- Every archetype beats at least one and loses to at least one other: **${m.verdict.allHaveProsAndCons ? "yes" : "NO"}**`,
    ...(m.flags.length ? ["", "Flags:", "", ...m.flags.map((f) => `- ${f}`)] : ["- Flags: none"]),
    "",
    "## 2. Win-rate matrix (row archetype vs column archetype, decisive battles only)",
    "",
    `| row \\ col | ${m.ids.map(L).join(" | ")} | overall | 95% CI | draws |`,
    `|---|${m.ids.map(() => "---").join("|")}|---|---|---|`,
  );
  m.rows.forEach((r, i) => {
    const cells = m.cells[i].map((c, j) => (c.n === 0 ? "—" : `${pc(c.p)}${i === j ? " (mirror)" : ""} <sub>${c.wins}-${c.losses}${c.draws ? `, ${c.draws}d` : ""}</sub>`));
    lines.push(`| **${r.label}** | ${cells.join(" | ")} | **${pc(r.overall.p)}** | ${pc(r.overall.lo)}-${pc(r.overall.hi)} | ${r.overall.draws} |`);
  });
  lines.push(
    "",
    "Cell intervals (95 % Wilson):",
    "",
    ...m.rows.map((r, i) => `- ${r.label}: ${m.cells[i].filter((_, j) => j !== i).map((c) => `vs ${L(c.b)} ${pc(c.lo)}-${pc(c.hi)} (n=${c.n})`).join("; ")}`),
    "",
    "## 3. Pros and cons per archetype (measured)",
    "",
    "| archetype | intent | pros | cons | median duration | dmg dealt / taken per battle | KO-win rate |",
    "|---|---|---|---|---|---|---|",
    ...m.rows.map((r) =>
      `| **${r.label}** | ${ARCHETYPE_BY_ID[r.id]?.intent ?? ""} | ${r.pros.join("; ") || "—"} | ${r.cons.join("; ") || "—"} | ${f1(r.medianDuration)} s | ${r.meanDealt.toFixed(0)} / ${r.meanTaken.toFixed(0)} | ${pc(r.koRate)} |`
    ),
    "",
    "## 4. Weights, costs and probabilities",
    "",
    "**Slot cost and power budget [SPEC B1]** (`src/genome/phenotype.ts`): a body's total combat power is fixed by its size class; the axes only decide how it is spent.",
    "",
    `| size class | ${SIZE_CLASSES.join(" | ")} |`,
    `|---|${SIZE_CLASSES.map(() => "---").join("|")}|`,
    `| slot cost (team capacity 6) | ${SIZE_CLASSES.map((c) => SLOT_COST[c]).join(" | ")} |`,
    `| power budget | ${SIZE_CLASSES.map((c) => POWER_BUDGET[c]).join(" | ")} |`,
    `| budget per slot | ${SIZE_CLASSES.map((c) => f2(POWER_BUDGET[c] / SLOT_COST[c])).join(" | ")} |`,
    "",
    "- Target power = `100 × budget × (1 + 0.12 (2q − 1)) × (1 + (level − 1)/30) × (0.55 + 0.45 growth)` (q = genetic quality gene).",
    "- Power index = `sqrt(effectiveHP × damageRate)`, effectiveHP = `hp × (1 + def/100) / (1 − 0.8 min(0.35, evasion))`, damageRate = `atk × rate × (regen / 11) × accuracy × (1 + 0.6 crit)`.",
    "- HP and attack are then SCALED so the index equals the target: every point of defence, evasion, accuracy, crit, charge rate or regeneration an archetype buys is paid for in raw HP and attack.",
    "- Breeding: Mendelian (one allele per parent per gene), per-gene mutation probability `0.03 × (1 + 1.5 × mean chaos)`, step N(0, 0.25); batch breeding adds tournament selection (k = 3) on gauntlet win rate, 1 elite, and a 35 % chance of an extra mutate() (strength 0.25).",
    "",
    "Mean fighter profile per archetype (gene strength = mean multiplier on the archetype genes needed for the requested element to emerge; HP and attack per budget unit, so classes compare); `hit %` = its accuracy × (1 − mean evasion of the others), `hit on it %` = mean accuracy of the others × (1 − its evasion):",
    "",
    "| archetype | gene strength | element emerged | power/slot | HP/b | atk/b | def | speed m/s | evasion | accuracy | crit | rate | regen | reach m | hit % | hit on it % |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  );
  m.rows.forEach((r, i) => {
    const others = m.rows.filter((_, j) => j !== i);
    const oEva = others.reduce((s, x) => s + x.profile.evasion, 0) / Math.max(1, others.length);
    const oAcc = others.reduce((s, x) => s + x.profile.accuracy, 0) / Math.max(1, others.length);
    const p = r.profile;
    const b = m.buildBy[r.id] ?? emptyBuildStats();
    lines.push(
      `| ${r.label} | ${f2(b.strengthSum / Math.max(1, b.built))} | ${pc(b.elementHits / Math.max(1, b.built))} | ${p.powerPerSlot.toFixed(0)} | ${p.hp.toFixed(0)} | ${f1(p.atk)} | ${p.def.toFixed(0)} | ${f2(p.spd)} | ${pc(p.evasion)} | ${pc(p.accuracy)} | ${pc(p.crit)} | ${f2(p.rate)} | ${f1(p.regen)} | ${f2(p.reach)} | ${pc(p.accuracy * (1 - oEva))} | ${pc(oAcc * (1 - p.evasion))} |`,
    );
  });
  lines.push(
    "",
    "Measured outcome: the matrix in section 2 — equal budgets, different shapes, and the shapes trade wins.",
    "",
  );
  if (breedRun) {
    const gs = breedRun.result.generations;
    const ids = Object.keys(gs[0]?.archetypeShare ?? {});
    lines.push(
      `## 5. Batch breeding: ${breedRun.label}`,
      "",
      `${gs.length} generations evaluated (${breedRun.result.evaluations} fitness evaluations against the archetype gauntlet at each candidate's own slot count). Archetype share = nearest archetype on its own genes.`,
      "",
      `| gen | mean fitness | best | power/slot | HP/b | atk/b | evasion | rate | diversity | ${ids.map((id) => L(id as ArchetypeId)).join(" | ")} |`,
      `|---|---|---|---|---|---|---|---|---|${ids.map(() => "---").join("|")}|`,
      ...gs.map((g) =>
        `| ${g.gen} | ${pc(g.meanFitness)} | ${pc(g.bestFitness)} | ${g.powerPerSlot.toFixed(0)} | ${g.meanStats.hp.toFixed(0)} | ${f1(g.meanStats.atk)} | ${pc(g.meanStats.evasion)} | ${f2(g.meanStats.rate)} | ${f2(g.diversity)} | ${ids.map((id) => pc(g.archetypeShare[id])).join(" | ")} |`
      ),
      "",
      breedRun.result.bestChild
        ? `Best child: ${breedRun.result.bestChild.name} (${breedRun.result.bestChild.id}, gen ${breedRun.result.bestChild.genome.generation}, nearest archetype ${L(classifyArchetype(breedRun.result.bestChild))}), gauntlet fitness ${pc(breedRun.result.bestChildFitness)}.`
        : "No child bred.",
      "",
    );
  }
  return lines.join("\n");
}
