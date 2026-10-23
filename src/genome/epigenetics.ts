/**
 * Conditions = the life history of an individual: time (age, active hours), space (hours per
 * ground), food, battles and experiences. Epigenetics turns those into bounded axis shifts on top
 * of the genetic expression, so the same genome raised by two different players becomes two
 * different creatures. Shifts saturate (tanh) at +-0.5 per axis: a lifestyle can bend a genome,
 * it cannot erase it.
 */
import { AXIS_IDS, type AxisId, type AxisVector, zeroAxes } from "../data/axes.ts";
import { ELEMENTS, type ElementId } from "../data/elements.ts";
import type { GroundId } from "../data/grounds.ts";
import { EXPERIENCES, type ExperienceId, FOODS, type FoodId, GROUND_EXPOSURE } from "../data/lifestyle.ts";

export interface BattleRecord {
  won: number;
  lost: number;
  draws: number;
  kos: number;
  damageTakenBy: Partial<Record<ElementId, number>>;
  elementsUsed: Partial<Record<ElementId, number>>;
}

export interface Conditions {
  ageDays: number;
  xp: number;
  exposure: Partial<Record<GroundId, number>>;
  diet: Partial<Record<FoodId, number>>;
  battles: BattleRecord;
  experiences: Partial<Record<ExperienceId, number>>;
  /** Mean local hour of activity (0-24). */
  activeHour: number;
  /** Bond with the owner, 0-1. */
  bond: number;
  /** Hunger 0 (fed) - 1 (starving); affects mood and growth. */
  hunger: number;
}

export function emptyConditions(): Conditions {
  return {
    ageDays: 0,
    xp: 0,
    exposure: {},
    diet: {},
    battles: { won: 0, lost: 0, draws: 0, kos: 0, damageTakenBy: {}, elementsUsed: {} },
    experiences: {},
    activeHour: 13,
    bond: 0.2,
    hunger: 0.3,
  };
}

export const EPIGENETIC_CAP = 0.5;

function addNudge(acc: AxisVector, nudge: Partial<Record<AxisId, number>>, units: number): void {
  for (const [k, v] of Object.entries(nudge) as [AxisId, number][]) acc[k] += v * units;
}

/** Raw (unsaturated) epigenetic pressure per axis with a per-source breakdown for explanations. */
export function epigeneticPressure(c: Conditions): { total: AxisVector; sources: Record<string, AxisVector> } {
  const sources: Record<string, AxisVector> = {
    space: zeroAxes(),
    food: zeroAxes(),
    battle: zeroAxes(),
    experience: zeroAxes(),
    time: zeroAxes(),
  };
  for (const [g, h] of Object.entries(c.exposure) as [GroundId, number][]) {
    const n = GROUND_EXPOSURE[g];
    if (n) addNudge(sources.space, n, h);
  }
  for (const [f, units] of Object.entries(c.diet) as [FoodId, number][]) addNudge(sources.food, FOODS[f].nudge, units);
  for (const [e, units] of Object.entries(c.experiences) as [ExperienceId, number][]) {
    addNudge(sources.experience, EXPERIENCES[e].nudge, units);
  }
  // Battles: acclimatise to elements taken (resistance via signature), practise elements used.
  for (const [el, dmg] of Object.entries(c.battles.damageTakenBy) as [ElementId, number][]) {
    addNudge(sources.battle, ELEMENTS[el].signature, dmg * 0.00004);
  }
  for (const [el, uses] of Object.entries(c.battles.elementsUsed) as [ElementId, number][]) {
    addNudge(sources.battle, ELEMENTS[el].signature, uses * 0.0015);
  }
  const net = c.battles.won - c.battles.lost;
  sources.battle.conviction += net * 0.004;
  sources.battle.temper += (c.battles.won + c.battles.lost) * 0.001;
  // Time: age brings wisdom and slows tempo late in life; activity hour drives the rhythm axis.
  sources.time.wisdom += Math.min(0.6, c.ageDays * 0.004);
  if (c.ageDays > 120) sources.time.tempo -= (c.ageDays - 120) * 0.002;
  const dayness = Math.cos(((c.activeHour - 13) / 24) * Math.PI * 2); // +1 at 13h, -1 at 1h
  sources.time.rhythm += dayness * Math.min(1, c.ageDays / 30) * 0.4;
  sources.time.mood += (c.bond - 0.3) * 0.5 - c.hunger * 0.3;

  const total = zeroAxes();
  for (const s of Object.values(sources)) for (const id of AXIS_IDS) total[id] += s[id];
  return { total, sources };
}

/** Per-activity weight of the active-hour average (recent activity counts more; ~16 events = 63 %). */
export const ACTIVE_HOUR_RATE = 0.06;

/**
 * Record activity at local `hour` (0-24) into the CIRCULAR running mean `activeHour`.
 * WHY circular: 23 h and 1 h are two hours apart, and a plain average of them is noon, which turned
 * night owls into day creatures (personas review F3). Before this function existed nothing wrote
 * `activeHour` at all: every Genemon stayed at 13 h forever and time of day never shaped a creature.
 * The caller passes the hour (pure module: it never reads the clock). `weight` = units of activity.
 */
export function noteActivity(c: Conditions, hour: number, weight = 1): void {
  if (!Number.isFinite(hour) || !(weight > 0)) return;
  const a = 1 - Math.pow(1 - ACTIVE_HOUR_RATE, Math.min(20, weight));
  // Move along the SHORTER arc by a share `a` of the gap. (Blending unit vectors and keeping only the
  // angle never moves between two opposite hours: 13 h and 1 h are exactly opposite, so the blend just
  // shrinks and still points at 13 h. The [SPEC G2] test caught that.)
  let d = (((hour - c.activeHour) % 24) + 24) % 24;
  if (d > 12) d -= 24;
  c.activeHour = (((c.activeHour + a * d) % 24) + 24) % 24;
}

/** Saturated epigenetic shift per axis, each within +-EPIGENETIC_CAP. */
export function epigeneticShift(c: Conditions): AxisVector {
  const { total } = epigeneticPressure(c);
  const out = zeroAxes();
  for (const id of AXIS_IDS) out[id] = EPIGENETIC_CAP * Math.tanh(total[id] / EPIGENETIC_CAP);
  return out;
}

/**
 * Continuous growth (legacy growthT) from age, xp and nutrition. `xpMult` = the lineage's XP curve
 * (src/genome/evolution.ts): xp is counted in lineage units so two lineages at the same LEVEL and age have
 * the same growth (a long-curve creature does not outgrow a short-curve one just by needing more xp).
 */
export function growthOf(c: Conditions, xpMult = 1): number {
  const eaten = Object.entries(c.diet).reduce((s, [f, n]) => s + FOODS[f as FoodId].nutrition * (n ?? 0), 0);
  const drive = c.ageDays / 18 + c.xp / (2500 * (xpMult > 0 ? xpMult : 1)) + eaten / 120;
  return Math.min(1, 1 - Math.exp(-drive * (1 - 0.4 * c.hunger)));
}

/**
 * Level from xp (smooth cube-root curve, 1..maxLevel). Pass 6 [P6-E2]: `xpMult` stretches every level of a
 * lineage's curve (long > 1 > short) and `maxLevel` caps it; the defaults are the pass-5 global curve.
 * The 1e-9 guard keeps levelOf(xpForLevel(n)) === n despite floating cube roots.
 */
export function levelOf(xp: number, xpMult = 1, maxLevel = 100): number {
  const m = xpMult > 0 ? xpMult : 1;
  return Math.max(1, Math.min(maxLevel, Math.floor(1 + Math.cbrt(Math.max(0, xp) / (8 * m)) + 1e-9)));
}

/** XP at which `level` starts on a curve stretched by `xpMult` (integers for non-unit curves: ceil). */
export function xpForLevel(level: number, xpMult = 1): number {
  const m = xpMult > 0 ? xpMult : 1;
  const v = Math.pow(Math.max(0, level - 1), 3) * 8 * m;
  return m === 1 ? v : Math.max(0, Math.ceil(v - 1e-9));
}
