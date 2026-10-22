/**
 * The ONE place the UI reaches the pass-5 life modules (src/genome/{senses,digestion,lifeclock}.ts,
 * contract in src/genome/lifeTypes.ts). The sheet and the Lab only call the functions below; every call
 * is guarded (a throwing producer logs a warning and the UI shows "not available" instead of breaking).
 * A Genemon without `life` is shown with the fresh state lifeOf() derives (nothing is mutated here).
 */
import { type Genemon, phenotypeOf } from "../genome/genemon.ts";
import type { Digestion, EvolutionStep, Imprint, LifePhase, Scar, SenseProfile } from "../genome/lifeTypes.ts";
import { helixOf } from "../genome/helix.ts";
import { sensesOf } from "../genome/senses.ts";
import { canRank, evolutionPath, lifeOf, lifePhase, phaseDays } from "../genome/lifeclock.ts";
import { bloatOf, dietOf, efficiencyOf } from "../genome/digestion.ts";
import type { FoodId } from "../data/lifestyle.ts";

function safe<T>(f: () => T): T | null {
  try {
    return f();
  } catch (e) {
    console.warn("lifeAdapter:", e);
    return null;
  }
}

/** Life phase (egg .. ancient) and the age (days) at which each phase starts for this creature. */
export function lifePhaseOf(g: Genemon): { phase: LifePhase; starts: Record<LifePhase, number> } | null {
  return safe(() => ({ phase: lifePhase(g), starts: phaseDays(g) }));
}

export function sensesFor(g: Genemon): SenseProfile | null {
  return safe(() => {
    const ph = phenotypeOf(g);
    return sensesOf(ph, helixOf(g.genome, ph), g.life);
  });
}

export function evolutionFor(g: Genemon): EvolutionStep[] | null {
  return safe(() => evolutionPath(g));
}

export function canRankOf(g: Genemon): { ok: boolean; why: string } | null {
  return safe(() => canRank(g));
}

/** Digestion (stored, or the fresh state when the life clock has not ticked yet). */
export function digestionFor(g: Genemon, now = Date.now()): { d: Digestion; fresh: boolean; bloat: number } | null {
  return safe(() => {
    const life = lifeOf(g, now);
    return { d: life.digestion, fresh: !g.life, bloat: bloatOf(life.digestion) };
  });
}

/** How well this creature digests a food (0.2 .. 1.4) given its diet class and taste. */
export function foodEfficiency(g: Genemon, food: FoodId): number | null {
  return safe(() => efficiencyOf(phenotypeOf(g), food));
}

export function dietClassOf(g: Genemon): string | null {
  return safe(() => dietOf(phenotypeOf(g)));
}

export function scarsFor(g: Genemon): Scar[] {
  return g.life?.scars ?? [];
}

export function imprintsFor(g: Genemon): Imprint[] {
  return g.life?.imprints ?? [];
}

/** Undigested food units in the stomach and the fill fraction (can exceed 1 when overfed). */
export function fullnessOf(d: Digestion): { units: number; frac: number } {
  const units = d.stomach.reduce((s, x) => s + x.units * (1 - Math.max(0, Math.min(1, x.digested))), 0);
  return { units, frac: d.capacity > 0 ? units / d.capacity : 0 };
}
