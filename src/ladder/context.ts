/**
 * Pre-match CONDITIONS of a ladder match: the engine side of the contract with the condition-aware
 * ladder (src/ladder/mmr.ts, docs/AI-AND-DATA.md §4 and §5, quest Q1). Pure and deterministic.
 *
 * matchContext(a, b, arena) fills every feature the ladder expects the caller to provide (the
 * CONTEXT_FEATURES names except `comboEdge`, which the ladder derives from its own combo history)
 * plus `rhythmFit` for the hour (the §4 v2 candidate name; the ladder learns any extra name).
 * Every value is from side A's perspective, lies in [-1, 1] (positive = good for A) and is
 * ANTISYMMETRIC: matchContext(b, a) negates every value of matchContext(a, b), so two identical
 * teams give 0 everywhere and the ladder's E_B = 1 - E_A invariant holds.
 *
 * Only PRE-MATCH information is read: phenotypes, the elements of each member's damaging moves,
 * the arena's ground shares as GENERATED from its spec (before any attack reshapes the ground), the
 * starting weather and the hour. Nothing measured during the battle may enter the context, or the
 * outcome leaks into the expected score and every rating change shrinks.
 *
 *   typeAdvantage   adv_X = mean over (X member, damaging move, opposing member) of
 *                   log2 typeMultiplier(move.element, defender types);  clamp(1.5 (adv_A - adv_B), -1, 1)
 *   arenaAffinity   aff_X = sum_g share_g * mean over members of affinity_g[primary] + 0.5 affinity_g[secondary]
 *                   (GROUNDS[g].affinity);  clamp(8 (aff_A - aff_B), -1, 1)
 *   weatherAffinity wx_X = mean over X's damaging moves of log2 WEATHERS[w].elementMult[element];
 *                   clamp(4 (wx_A - wx_B), -1, 1)
 *   powerDiff       (P_A - P_B) / (P_A + P_B), P = sum of phenotype.power (already slot-normalised)
 *   synergyDiff     clamp(2 (syn_A - syn_B), -1, 1), syn = 0.25 sociality + 0.25 coverage + 0.2 reaction
 *                   potential + 0.3 synergy bonus (the real battle modifiers of team.ts synergies(),
 *                   as a damage-equivalent gain saturating at +25%), each in [0, 1]
 *   sizeDiff        tanh(ln(M_A / M_B) / 2), M = sum of body mass (>= 0.5 kg each, like the physics)
 *   reachDiff       tanh((mean reach_A - mean reach_B) / 2 m), reach = stats.reach
 *   rhythmFit       r_X = mean over X's damaging moves of log2 of the battle's day/night multiplier
 *                   (rhythm axis x 6%, light/shadow x 1.1 / 0.9; day = 7h-19h as in Battle);
 *                   clamp(6 (r_A - r_B), -1, 1)
 *
 * The gains (FEATURE_GAIN, a measured choice documented there) differ from the v1 proposals of
 * docs/AI-AND-DATA.md §4 for typeAdvantage, arenaAffinity, weatherAffinity and synergyDiff.
 *
 * teamCombos() tags what a side fielded (synergy ids + primary-element pairs) for the ladder's
 * comboEdge and its best/worst combo tables; matchResultFrom() turns a finished battle into the
 * MatchResult the ladder records.
 */
import { clamp, u01 } from "../core/math.ts";
import { ELEMENT_IDS, type ElementId, reactionBetween, typeMultiplier } from "../data/elements.ts";
import { GROUNDS, type GroundId } from "../data/grounds.ts";
import { type Weather, WEATHERS } from "../data/weather.ts";
import { phenotypeOf } from "../genome/genemon.ts";
import type { Phenotype, Stats } from "../genome/phenotype.ts";
import type { BattleResult } from "../combat/battle.ts";
import { isDamaging, type Move, MOVE_BY_ID } from "../combat/moves.ts";
import { synergies, type Team } from "../combat/team.ts";
import { type ArenaSpec, generateArena } from "../world/arena.ts";
import { makeContext, type MatchContext, type MatchResult } from "./mmr.ts";

/** Hour-vs-rhythm feature (docs/AI-AND-DATA.md §4, v2 candidate `rhythmFit`). */
export const RHYTHM_FEATURE = "rhythmFit";

/** Features this module adds beyond CONTEXT_FEATURES, with the note the Ladder screen shows. */
export const EXTRA_CONTEXT_FEATURES: readonly { name: string; note: string }[] = [
  {
    name: RHYTHM_FEATURE,
    note: "Day/night fit at the match hour: how much A's rhythm (diurnal vs nocturnal) and light/shadow moves gain, minus B's.",
  },
];

/** Every feature matchContext() fills (comboEdge is left to the ladder). */
export const MATCH_FEATURES = [
  "typeAdvantage",
  "arenaAffinity",
  "weatherAffinity",
  "powerDiff",
  "synergyDiff",
  "sizeDiff",
  "reachDiff",
  RHYTHM_FEATURE,
] as const;

/** Battle.isDay: the day buffs apply from 7h (inclusive) to 19h (exclusive). */
export function isDayHour(hour: number): boolean {
  return hour >= 7 && hour < 19;
}

/**
 * Gains of the features whose CONTEXT_FEATURES note leaves the scale open. Chosen so each has a
 * standard deviation of ~0.2-0.35 over realistic matchups with clamping rare: the ladder's SGD
 * learns a feature's effect at a speed proportional to its variance, and at the doc's v1 scale
 * ((adv_A - adv_B) / 2) the type advantage implied a weight above the ladder's +-4 bound
 * (logistic fit over 1,500 simulated battles: 4.2 +- 0.5). powerDiff, sizeDiff and reachDiff keep
 * the exact formulas of their notes.
 */
export const FEATURE_GAIN = {
  typeAdvantage: 1.5,
  arenaAffinity: 8,
  weatherAffinity: 4,
  synergyDiff: 2,
  rhythmFit: 6,
} as const;

/** Non-neutral elements: the coverage targets. */
const TARGETS: readonly ElementId[] = ELEMENT_IDS.filter((e) => e !== "neutral");
/** Damage-equivalent value of +100% on a stat in the synergy bonus (atk/accuracy convert 1:1). */
const STAT_GAIN: Partial<Record<keyof Stats, number>> = { atk: 1, accuracy: 1, def: 0.5, evasion: 0.5 };
/** Synergy gain (damage-equivalent fraction) at which the bonus component saturates. */
const SYNERGY_SATURATION = 0.25;

interface Member {
  ph: Phenotype;
  /** [primary, secondary?] */
  types: ElementId[];
  /** Element of every damaging move in the loadout (duplicates kept: two fire moves weigh twice). */
  attacks: ElementId[];
}

function membersOf(t: Team): Member[] {
  return t.members.map((g) => {
    const ph = phenotypeOf(g);
    const types: ElementId[] = ph.elements.secondary ? [ph.elements.primary, ph.elements.secondary] : [ph.elements.primary];
    const attacks = g.moves
      .map((id) => MOVE_BY_ID[id])
      .filter((m): m is Move => m !== undefined && isDamaging(m))
      .map((m) => m.element);
    return { ph, types, attacks };
  });
}

const meanOf = (xs: readonly number[]): number => (xs.length > 0 ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);

/** Mean log2 type multiplier of `att`'s damaging moves against each of `def`'s members. */
function typeEdge(att: readonly Member[], def: readonly Member[]): number {
  let s = 0, n = 0;
  for (const m of att) {
    for (const el of m.attacks) {
      for (const d of def) {
        s += Math.log2(typeMultiplier(el, d.types));
        n++;
      }
    }
  }
  return n > 0 ? s / n : 0;
}

/** Share-weighted ground affinity of the members' elements (secondary counts half). */
function groundFit(ms: readonly Member[], shares: readonly [GroundId, number][]): number {
  if (ms.length === 0) return 0;
  let s = 0;
  for (const [g, frac] of shares) {
    const aff: Partial<Record<ElementId, number>> = GROUNDS[g]?.affinity ?? {};
    let t = 0;
    for (const m of ms) {
      t += aff[m.ph.elements.primary] ?? 0;
      if (m.ph.elements.secondary) t += 0.5 * (aff[m.ph.elements.secondary] ?? 0);
    }
    s += (frac * t) / ms.length;
  }
  return s;
}

/** Mean log2 weather multiplier over the team's damaging moves. */
function weatherFit(ms: readonly Member[], mult: Weather["elementMult"]): number {
  return meanOf(ms.flatMap((m) => m.attacks.map((el) => Math.log2(mult[el] ?? 1))));
}

/** Mean log2 of the battle's day/night multiplier (Battle.rhythmMult) over the damaging moves. */
function rhythmGain(ms: readonly Member[], day: boolean): number {
  return meanOf(ms.flatMap((m) => {
    const base = day ? 1 + 0.06 * m.ph.axes.rhythm : 1 - 0.06 * m.ph.axes.rhythm;
    return m.attacks.map((el) => {
      const k = el === "light" ? (day ? 1.1 : 0.9) : el === "shadow" ? (day ? 0.9 : 1.1) : 1;
      return Math.log2(base * k);
    });
  }));
}

/** Share of the non-neutral elements some damaging move of the team hits for x2 or more. */
function coverage(ms: readonly Member[]): number {
  const els = [...new Set(ms.flatMap((m) => m.attacks))];
  return TARGETS.filter((d) => els.some((el) => typeMultiplier(el, [d]) >= 2)).length / TARGETS.length;
}

/** Share of teammate pairs whose types can trigger an amplifying reaction (damageMult > 1). */
function reactionPotential(ms: readonly Member[]): number {
  let pairs = 0, hot = 0;
  for (let i = 0; i < ms.length; i++) {
    for (let j = i + 1; j < ms.length; j++) {
      pairs++;
      if (ms[i].types.some((x) => ms[j].types.some((y) => (reactionBetween(x, y)?.damageMult ?? 0) > 1))) hot++;
    }
  }
  return pairs > 0 ? hot / pairs : 0;
}

/** The real synergy modifiers (team.ts) as a damage-equivalent gain, mapped to [0, 1]. */
function synergyBonus(t: Team, ms: readonly Member[]): number {
  const attacks = ms.flatMap((m) => m.attacks);
  const share = (el: ElementId): number => (attacks.length > 0 ? attacks.filter((a) => a === el).length / attacks.length : 0);
  const plants = ms.length > 0 ? ms.filter((m) => m.types.includes("plant")).length / ms.length : 0;
  let gain = 0;
  for (const s of synergies(t)) {
    if (s.damageMult) gain += s.damageMult - 1;
    if (s.element && s.elementMult) gain += (s.elementMult - 1) * share(s.element);
    if (s.element && s.statusMult) gain += 0.1 * (s.statusMult - 1) * share(s.element);
    for (const [k, v] of Object.entries(s.statMult ?? {}) as [keyof Stats, number][]) gain += (STAT_GAIN[k] ?? 0.5) * (v - 1);
    if (s.regen) gain += 10 * s.regen * plants;
    if (s.combo) gain += 0.5 * s.combo;
  }
  return clamp(gain / SYNERGY_SATURATION, 0, 1);
}

/** Team synergy score in [0, 1]. */
function synergyScore(t: Team, ms: readonly Member[]): number {
  if (ms.length === 0) return 0;
  const social = meanOf(ms.map((m) => u01(m.ph.axes.sociality)));
  return 0.25 * social + 0.25 * coverage(ms) + 0.2 * reactionPotential(ms) + 0.3 * synergyBonus(t, ms);
}

const totalMass = (ms: readonly Member[]): number => Math.max(0.5, ms.reduce((s, m) => s + Math.max(0.5, m.ph.massKg), 0));
const totalPower = (ms: readonly Member[]): number => ms.reduce((s, m) => s + m.ph.power, 0);

/** Ground shares of the arena as generated from its spec (the battle's own copy may be reshaped later). */
export function arenaGroundShares(arena: ArenaSpec): [GroundId, number][] {
  return Object.entries(generateArena(arena).groundShares()) as [GroundId, number][];
}

/**
 * The pre-match context of `a` vs `b` on `arena`, from a's perspective (see the module doc for the
 * formulas). Swapping a and b negates every feature.
 */
export function matchContext(a: Team, b: Team, arena: ArenaSpec): MatchContext {
  const A = membersOf(a), B = membersOf(b);
  const shares = arenaGroundShares(arena);
  const mult: Weather["elementMult"] = (WEATHERS as Partial<Record<string, Weather>>)[arena.weather]?.elementMult ?? {};
  const day = isDayHour(arena.hour);
  const pA = totalPower(A), pB = totalPower(B);
  const G = FEATURE_GAIN;
  return makeContext({
    typeAdvantage: clamp(G.typeAdvantage * (typeEdge(A, B) - typeEdge(B, A)), -1, 1),
    arenaAffinity: clamp(G.arenaAffinity * (groundFit(A, shares) - groundFit(B, shares)), -1, 1),
    weatherAffinity: clamp(G.weatherAffinity * (weatherFit(A, mult) - weatherFit(B, mult)), -1, 1),
    powerDiff: pA + pB > 0 ? (pA - pB) / (pA + pB) : 0,
    synergyDiff: clamp(G.synergyDiff * (synergyScore(a, A) - synergyScore(b, B)), -1, 1),
    // ln(MA) - ln(MB) (not ln(MA / MB)) so swapping the sides negates the value bit for bit.
    sizeDiff: Math.tanh((Math.log(totalMass(A)) - Math.log(totalMass(B))) / 2),
    reachDiff: Math.tanh((meanOf(A.map((m) => m.ph.stats.reach)) - meanOf(B.map((m) => m.ph.stats.reach))) / 2),
    [RHYTHM_FEATURE]: clamp(G.rhythmFit * (rhythmGain(A, day) - rhythmGain(B, day)), -1, 1),
  });
}

/**
 * What a side fielded, as combo tags: its synergy ids ("bellows", "pack"...) and the sorted
 * primary-element pair of every two members ("air+fire", "fire+fire"). Deduplicated and sorted,
 * so the result does not depend on the member order.
 */
export function teamCombos(t: Team): string[] {
  const out = new Set<string>(synergies(t).map((s) => s.id));
  const prim = t.members.map((g) => phenotypeOf(g).elements.primary);
  for (let i = 0; i < prim.length; i++) {
    for (let j = i + 1; j < prim.length; j++) {
      out.add(prim[i] <= prim[j] ? `${prim[i]}+${prim[j]}` : `${prim[j]}+${prim[i]}`);
    }
  }
  return [...out].sort();
}

/**
 * How the battle ended, in WIN_CONDITION_K terms: "timeout" (decided or drawn on remaining HP),
 * "draw" (double KO), "sweep" (the winners lost no member) or "ko".
 */
export function winConditionOf(r: BattleResult): string {
  if (r.reason === "timeout") return "timeout";
  if (r.winner === 2) return "draw";
  const winners = r.fighters.filter((f) => f.team === r.winner);
  return winners.length > 0 && winners.every((f) => f.alive) ? "sweep" : "ko";
}

/**
 * The MatchResult the ladder records for a finished battle. Ids are the team owners (local profile
 * ids, or "rival" / "wild" / "mirror"), the arena and weather come from the pre-match spec (moves
 * can change the weather mid-battle; the interactions key on the starting one), `ctx` must come
 * from matchContext() computed on the same teams before the battle result was applied.
 */
export function matchResultFrom(
  result: BattleResult,
  teams: readonly [Team, Team],
  arena: ArenaSpec,
  ctx: MatchContext,
  when: number,
): MatchResult {
  return {
    a: teams[0].owner,
    b: teams[1].owner,
    scoreA: result.winner === 0 ? 1 : result.winner === 1 ? 0 : 0.5,
    context: ctx,
    arena: arena.kind,
    weather: arena.weather,
    when,
    combosA: teamCombos(teams[0]),
    combosB: teamCombos(teams[1]),
    winCondition: winConditionOf(result),
  };
}
