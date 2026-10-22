/**
 * DIGESTION [P5-G3]: food goes into a STOMACH (capacity by body size), is digested over hours
 * (metabolism = tempo axis, body heat, age, ambient temperature) and is ABSORBED with an efficiency
 * set by the diet class (herbivore, carnivore, omnivore, lithovore, energivore) and the sense of taste.
 * Overfeeding past the capacity is refused unless forced (demo "no food limit"); a forced stomach
 * BLOATS (slow, sleepy) until it digests down. The caller adds the absorbed units into
 * `conditions.diet`, where the epigenetics already turn food into axis nudges.
 * Pure: no DOM, no clock (callers pass `now` in ms), no randomness.
 */
import type { AxisId, AxisVector } from "../data/axes.ts";
import { elementAffinities, type ElementId } from "../data/elements.ts";
import { type FoodId, FOODS } from "../data/lifestyle.ts";
import { clamp, clamp01, r3, u01 } from "../core/math.ts";
import type { Phenotype, SizeClass } from "./phenotype.ts";
import type { DietClass, Digestion, DigestTick, EatResult, LifeState } from "./lifeTypes.ts";
import { SENSE_MEAN } from "./senses.ts";

export const HOUR_MS = 3_600_000;

/** What a food is made of, for the diet match. */
export type FoodKind = "plant" | "meat" | "mineral" | "energy" | "plain";
export const FOOD_KIND: Record<FoodId, FoodKind> = {
  berries: "plant",
  greens: "plant",
  meat: "meat",
  fish: "meat",
  honey: "plant",
  spicyPepper: "plant",
  minerals: "mineral",
  mushroom: "plant",
  candy: "energy",
  seaweed: "plant",
  iceCream: "plain",
  coffeeBean: "energy",
  glowFruit: "energy",
  ashRoot: "plant",
  emberChili: "plant",
  springWater: "plain",
  stormBerry: "energy",
  frostMint: "plant",
  ironNut: "mineral",
  toxicCap: "plant",
  sunPetal: "energy",
  nightPlum: "plant",
  mindLeaf: "plant",
  voidSalt: "mineral",
  stoneBread: "mineral",
  cloudPuff: "plain",
  seedCake: "plant",
};

/** Diet x food-kind absorption factor (before taste). */
export const DIET_MATCH: Record<DietClass, Record<FoodKind, number>> = {
  herbivore: { plant: 1.2, meat: 0.4, mineral: 0.45, energy: 0.9, plain: 1 },
  carnivore: { plant: 0.5, meat: 1.3, mineral: 0.4, energy: 0.8, plain: 1 },
  omnivore: { plant: 1, meat: 1, mineral: 0.6, energy: 0.95, plain: 1 },
  lithovore: { plant: 0.5, meat: 0.45, mineral: 1.35, energy: 0.7, plain: 0.9 },
  energivore: { plant: 0.7, meat: 0.45, mineral: 0.5, energy: 1.35, plain: 0.9 },
};

/** Stomach size in food units per size class (before appetite). */
export const STOMACH_UNITS: Record<SizeClass, number> = { XS: 2, S: 3, M: 5, L: 8, XL: 12 };
/** Hunger drop per absorbed nutrition unit (same rate as the legacy feed()). */
export const HUNGER_PER_NUTRITION = 0.15;

/** Diet class from element and axes: rock / metal eat stone, light / electric eat energy... */
export function dietOf(ph: Phenotype): DietClass {
  const a = ph.axes, p = ph.elements.primary;
  const litho: ElementId[] = ["earth", "metal"], energ: ElementId[] = ["light", "electric", "void"];
  if (litho.includes(p) || (a.hardness > 0.55 && a.altitude < -0.25)) return "lithovore";
  if (energ.includes(p) || (a.luminance > 0.6 && a.conductivity > 0.3)) return "energivore";
  if (a.appetite > 0.5) return "omnivore"; // gluttons eat anything
  const carn = a.temper + 0.5 * a.might + (p === "fire" || p === "shadow" ? 0.3 : 0);
  const herb = a.vitality - 0.5 * a.temper + 0.2 * a.structure + (p === "plant" ? 0.4 : 0);
  if (Math.abs(carn - herb) < 0.25) return "omnivore";
  return carn > herb ? "carnivore" : "herbivore";
}

/** Stomach capacity in units: body size x appetite (0.8 .. 1.2). */
export function capacityOf(ph: Phenotype): number {
  return r3(STOMACH_UNITS[ph.sizeClass] * (0.8 + 0.4 * u01(ph.axes.appetite)) * (0.6 + 0.4 * ph.growth));
}

/**
 * Hours to digest one unit: fast metabolism (tempo) and warm bodies digest faster; the young
 * faster, the old slower; cold weather slows, heat speeds a little.
 */
export function hoursPerUnitOf(ph: Phenotype, ageDays?: number, tempC?: number): number {
  const tempo = u01(ph.axes.tempo);
  let h = 3 * (1.35 - 0.7 * tempo) * (1 - 0.15 * ph.axes.heat);
  if (ageDays !== undefined) {
    h *= ageDays < 30 ? 0.8 + 0.2 * clamp01(ageDays / 30) : 1 + 0.4 * clamp01((ageDays - 150) / 300);
  }
  if (tempC !== undefined) h *= clamp(1 + (15 - tempC) * 0.01, 0.8, 1.3);
  return r3(clamp(h, 0.5, 10));
}

/** Taste estimate from the phenotype alone (tongue genes live on the helix; pass `taste` to be exact). */
export function tasteGuess(ph: Phenotype): number {
  return SENSE_MEAN * (0.7 + 0.6 * u01(ph.axes.appetite)) * (0.85 + 0.3 * ph.plan.jaw);
}

/** Absorption efficiency 0.2 .. 1.4 = diet match x taste (a fine palate gets more out of a meal). */
export function efficiencyOf(ph: Phenotype, food: FoodId, taste = tasteGuess(ph), diet = dietOf(ph)): number {
  const match = DIET_MATCH[diet][FOOD_KIND[food]];
  const tasteK = 0.85 + 0.15 * clamp(taste / SENSE_MEAN, 0, 2.5);
  return r3(clamp(match * tasteK, 0.2, 1.4));
}

export function newDigestion(ph: Phenotype, now: number, ageDays?: number): Digestion {
  return {
    diet: dietOf(ph),
    stomach: [],
    capacity: capacityOf(ph),
    hoursPerUnit: hoursPerUnitOf(ph, ageDays),
    lastTick: now,
  };
}

/** Units still in the stomach (not yet absorbed). */
export function fullnessOf(d: Digestion): number {
  return d.stomach.reduce((s, it) => s + it.units * (1 - it.digested), 0);
}

/** Overfed discomfort 0..1: 0 at capacity, 1 at 1.5 x capacity. */
export function bloatOf(d: Digestion): number {
  return d.capacity > 0 ? clamp01((fullnessOf(d) / d.capacity - 1) / 0.5) : 0;
}

/** The visible effects of `units` of `food` at `efficiency` (for the feed popup). */
export function previewOf(
  ph: Phenotype,
  food: FoodId,
  units: number,
  efficiency: number,
  appetite = ph.axes.appetite,
): EatResult["preview"] {
  const f = FOODS[food];
  const out: EatResult["preview"] = [];
  const k = units * efficiency;
  out.push({ label: "hunger", delta: r3(-HUNGER_PER_NUTRITION * f.nutrition * k) });
  out.push({ label: "growth", delta: r3(f.nutrition * k / 120) });
  if (f.joy !== 0) out.push({ label: "mood", delta: r3(f.joy * units * (0.6 + 0.8 * u01(appetite))) });
  const nudges = (Object.entries(f.nudge) as [AxisId, number][]).sort((x, y) =>
    Math.abs(y[1]) - Math.abs(x[1])
  );
  for (const [axis, v] of nudges) out.push({ label: axis, delta: r3(v * k) });
  // Element drift: how the nudge moves the element affinities (top mover only).
  const after = { ...ph.axes } as AxisVector;
  for (const [axis, v] of nudges) after[axis] = clamp(after[axis] + v * k, -1, 1);
  const before = ph.elements.affinity, aff = elementAffinities(after);
  let best: ElementId | null = null, bestD = 0;
  for (const id of Object.keys(aff) as ElementId[]) {
    if (id === "neutral") continue;
    const d = aff[id] - before[id];
    if (Math.abs(d) > Math.abs(bestD)) [best, bestD] = [id, d];
  }
  if (best && Math.abs(bestD) >= 0.0005) out.push({ label: `${best} affinity`, delta: r3(bestD) });
  return out;
}

/** "vitality +0.040" lines for a preview list. */
export function formatPreview(p: EatResult["preview"]): string[] {
  return p.map((x) => `${x.label} ${x.delta >= 0 ? "+" : ""}${x.delta.toFixed(3)}`);
}

/**
 * Swallow `units` of `food` into the stomach at `now`. Past capacity only the room left is
 * swallowed (refused when full) unless `o.ignoreCapacity`. Mutates life.digestion (stomach,
 * capacity, diet). `o.taste` = the taste acuity from sensesOf (else estimated from the phenotype).
 */
export function eat(
  life: LifeState,
  food: FoodId,
  units: number,
  now: number,
  ph: Phenotype,
  o: { ignoreCapacity?: boolean; taste?: number } = {},
): EatResult {
  const d = life.digestion;
  d.capacity = capacityOf(ph);
  d.diet = dietOf(ph);
  const efficiency = efficiencyOf(ph, food, o.taste, d.diet);
  const full = fullnessOf(d);
  if (!FOODS[food] || !(units > 0) || !Number.isFinite(units)) {
    return { ok: false, why: "nothing to eat", units: 0, efficiency, fullness: r3(full), preview: [] };
  }
  const room = Math.max(0, d.capacity - full);
  const take = o.ignoreCapacity ? units : Math.min(units, room);
  if (take <= 1e-6) {
    return {
      ok: false,
      why: `stomach full (${r3(full)}/${d.capacity})`,
      units: 0,
      efficiency,
      fullness: r3(full),
      preview: [],
    };
  }
  d.stomach.push({ food, units: take, eatenAt: now, digested: 0 });
  const fullness = full + take;
  const why = take < units
    ? `only ${r3(take)} of ${units} fit`
    : fullness > d.capacity
    ? "force-fed past capacity: bloated"
    : "eaten";
  return {
    ok: true,
    why,
    units: r3(take),
    efficiency,
    fullness: r3(fullness),
    preview: previewOf(ph, food, take, efficiency),
  };
}

/**
 * Digest from life.digestion.lastTick to `now`: the oldest food first, 1 / hoursPerUnit units per
 * hour (30 % slower while bloated). Returns the absorbed units per food (x efficiency) and the hunger
 * drop; mutates the stomach and lastTick. `o.ageDays` / `o.tempC` refine the speed, `o.taste` the efficiency.
 */
export function digest(
  life: LifeState,
  now: number,
  ph: Phenotype,
  o: { ageDays?: number; tempC?: number; taste?: number } = {},
): DigestTick {
  const d = life.digestion;
  d.capacity = capacityOf(ph);
  d.diet = dietOf(ph);
  d.hoursPerUnit = hoursPerUnitOf(ph, o.ageDays, o.tempC);
  const hours = Math.max(0, (now - d.lastTick) / HOUR_MS);
  d.lastTick = Math.max(d.lastTick, now);
  const absorbed: Record<string, number> = {};
  let hunger = 0;
  let budget = (hours / d.hoursPerUnit) * (bloatOf(d) > 0 ? 0.7 : 1);
  for (const it of d.stomach) {
    if (budget <= 0) break;
    const left = it.units * (1 - it.digested);
    const take = Math.min(left, budget);
    budget -= take;
    it.digested = it.units > 0 ? clamp01(it.digested + take / it.units) : 1;
    const food = it.food as FoodId;
    if (!FOODS[food]) continue;
    const eff = efficiencyOf(ph, food, o.taste, d.diet);
    absorbed[food] = r3((absorbed[food] ?? 0) + take * eff);
    hunger -= HUNGER_PER_NUTRITION * FOODS[food].nutrition * take * eff;
  }
  d.stomach = d.stomach.filter((it) => it.digested < 0.9995);
  return { absorbed, hunger: r3(hunger), bloat: r3(bloatOf(d)) };
}
