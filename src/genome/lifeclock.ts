/**
 * THE LIFE CLOCK [P5-G4, P5-G5, P5-L1, P5-V1]: age phases (egg -> fetus -> hatchling -> juvenile ->
 * adult -> elder -> ancient), the circadian rhythm (chronotype shifted by altitude and age), the long
 * loop that catches up offline time (digestion, hunger, ageing, fatigue, acclimatisation), scars,
 * retirement from ranked, and the evolution path with the cost and properties of every step.
 *
 * Loops at several time scales [P5-L1]: a 2-3 minute match (scars, fatigue), the daily feeding /
 * digestion (hours), the weekly growth (hatchling -> juvenile -> adult in days..weeks), the lifetime
 * (elder after ~5 months, ancient after ~10 for a medium body; big bodies live longer).
 * Pure: callers pass `now` (ms) and the local hour; the only randomness (scar placement) is seeded.
 */
import { NOWHERE, type Where } from "../core/ledger.ts";
import { clamp, clamp01, r3, u01 } from "../core/math.ts";
import { hashSeed, Rng } from "../core/rng.ts";
import type { ElementId } from "../data/elements.ts";
import { type FoodId, FOODS } from "../data/lifestyle.ts";
import type { Genemon } from "./genemon.ts";
import { emptyConditions, xpForLevel } from "./epigenetics.ts";
import { helixOf } from "./helix.ts";
import { P5_DEFAULTS } from "./morphTypes.ts";
import { express, type Phenotype, type SizeClass } from "./phenotype.ts";
import { bloatOf, capacityOf, digest, fullnessOf, newDigestion } from "./digestion.ts";
import {
  type CircadianState,
  type EvolutionStep,
  LIFE_PHASES,
  type LifePhase,
  type LifeState,
  type LifeTickCtx,
  type LifeTickReport,
  type Scar,
} from "./lifeTypes.ts";

export const DAY_MS = 86_400_000;
/** A single tickLife never catches up more than this much simulated time (a month offline). */
export const MAX_CATCHUP_DAYS = 30;
/** Start of each phase in days for a medium body with no neoteny (scaled by lifespanK / neoteny). */
export const PHASE_DAYS: Record<LifePhase, number> = {
  egg: 0,
  fetus: 0.3,
  hatchling: 1,
  juvenile: 7,
  adult: 30,
  elder: 150,
  ancient: 300,
};
/** Big creatures live longer (and develop slower). */
export const SIZE_LIFESPAN: Record<SizeClass, number> = { XS: 0.7, S: 0.85, M: 1, L: 1.25, XL: 1.5 };
/** Level the evolution path expects at the start of each phase (xp cost). */
export const PHASE_LEVEL: Record<LifePhase, number> = {
  egg: 1,
  fetus: 1,
  hatchling: 1,
  juvenile: 5,
  adult: 16,
  elder: 25,
  ancient: 35,
};
/** Bond the owner needs for each step (feeding and care, not just time). */
export const PHASE_BOND: Record<LifePhase, number> = {
  egg: 0,
  fetus: 0,
  hatchling: 0,
  juvenile: 0.1,
  adult: 0.25,
  elder: 0.4,
  ancient: 0.5,
};
/** Hunger gained per day at average metabolism (same rate as the legacy age()). */
export const HUNGER_PER_DAY = 0.25;
/** Elders with this many scars (or this summed severity) are past their prime for ranked. */
export const ELDER_SCAR_LIMIT = { count: 8, severity: 3 };
export const MAX_SCARS = 32;

const PHASE_NAME: Record<LifePhase, string> = {
  egg: "Egg",
  fetus: "Fetus",
  hatchling: "Hatchling",
  juvenile: "Juvenile",
  adult: "Adult",
  elder: "Elder",
  ancient: "Ancient",
};

// ------------------------------------------------------------------ phenotype access (no genemon.ts import cycle)
const phCache = new Map<string, Phenotype>();
function phOf(g: Genemon): Phenotype {
  const key = `${g.genome.id}|${JSON.stringify(g.conditions)}`;
  let ph = phCache.get(key);
  if (!ph) {
    ph = express(g.genome, g.conditions);
    if (phCache.size > 500) phCache.clear();
    phCache.set(key, ph);
  }
  return ph;
}
/**
 * Reference ADULT phenotype of the genome (fixed conditions): the life clock's thresholds must not
 * move as the creature ages (age lowers tempo, growth changes the size class), or a phase could go
 * backwards. Lifestyle shapes the body; the genome alone sets the lifespan.
 */
const refCache = new Map<string, { ph: Phenotype; neoteny: number }>();
function lifeRef(g: Genemon): { ph: Phenotype; neoteny: number } {
  let r = refCache.get(g.genome.id);
  if (!r) {
    const c = emptyConditions();
    c.ageDays = 60;
    c.xp = xpForLevel(20);
    c.hunger = 0;
    const ph = express(g.genome, c);
    r = { ph, neoteny: neotenyOf(g, ph) };
    if (refCache.size > 500) refCache.clear();
    refCache.set(g.genome.id, r);
  }
  return r;
}
/** Growth the creature has EARNED (age, xp, food) ignoring current hunger: never decreases. */
function earnedGrowth(g: Genemon): number {
  const c = g.conditions;
  const eaten = Object.entries(c.diet).reduce(
    (s, [f, n]) => s + (FOODS[f as FoodId]?.nutrition ?? 0) * (n ?? 0),
    0,
  );
  return 1 - Math.exp(-(c.ageDays / 18 + c.xp / 2500 + eaten / 120));
}
function neotenyOf(g: Genemon, ph: Phenotype): number {
  const h = helixOf(g.genome, ph);
  return clamp01((h.p5 ?? P5_DEFAULTS).growth.neoteny);
}
const wrap24 = (h: number) => ((h % 24) + 24) % 24;

// ------------------------------------------------------------------ state
/** Lifespan multiplier: size class x metabolism (fast bodies burn out sooner): 0.6 .. 1.7. */
export function lifespanK(ph: Phenotype): number {
  return SIZE_LIFESPAN[ph.sizeClass] * (1.15 - 0.3 * u01(ph.axes.tempo));
}

export function newLifeState(g: Genemon, now: number): LifeState {
  const ph = phOf(g);
  // Chronotype: the genetic rhythm axis (+1 day creature -> 13 h, -1 night creature -> 1 h), pulled
  // halfway toward the hour it has actually been living at.
  const genetic = wrap24(13 + 12 * (1 - u01(ph.genetic.rhythm)));
  let d = wrap24(g.conditions.activeHour - genetic);
  if (d > 12) d -= 24;
  return {
    version: 1,
    digestion: newDigestion(ph, now, g.conditions.ageDays),
    scars: [],
    imprints: [],
    chronotype: r3(wrap24(genetic + 0.5 * d)),
    // Soaring lineages are born acclimatised to the heights.
    altitudeM: Math.round(1500 * Math.max(0, ph.genetic.altitude)),
    lastTick: now,
    fatigue: 0,
  };
}

export function lifeOf(g: Genemon, now: number): LifeState {
  return g.life ?? newLifeState(g, now);
}

/** Day each phase starts for this creature (size, metabolism, neoteny). Strictly increasing. */
export function phaseDays(g: Genemon): Record<LifePhase, number> {
  const ref = lifeRef(g);
  const k = lifespanK(ref.ph), neo = ref.neoteny;
  return {
    egg: 0,
    fetus: PHASE_DAYS.fetus * k,
    hatchling: PHASE_DAYS.hatchling * k,
    juvenile: PHASE_DAYS.juvenile * k * (1 + 0.3 * neo),
    adult: PHASE_DAYS.adult * k * (1 + 0.6 * neo),
    elder: PHASE_DAYS.elder * k * (1 + 0.2 * neo),
    ancient: PHASE_DAYS.ancient * k * (1 + 0.2 * neo),
  };
}

/** Phase from age + growth + neoteny: an underfed juvenile (earned growth < 0.55) stays juvenile longer. Never goes backwards. */
export function lifePhase(g: Genemon): LifePhase {
  const days = phaseDays(g);
  const age = g.conditions.ageDays;
  let out: LifePhase = "egg";
  for (const p of LIFE_PHASES) if (age >= days[p]) out = p;
  if (out === "adult" && earnedGrowth(g) < 0.55 && age < 1.5 * days.adult) out = "juvenile";
  return out;
}

// ------------------------------------------------------------------ circadian rhythm
/**
 * Rhythm at local `hour`: altitude shifts the peak EARLIER (up to 3 h at 4500 m) and flattens it;
 * being far from the acclimatised altitude costs breath (fight); age flattens the rhythm, moves sleep
 * earlier and makes it longer, and lowers fertility. Every multiplier stays within 0.8 .. 1.15.
 */
export function circadian(life: LifeState, hour: number, altitudeM: number, ageDays: number): CircadianState {
  const alt = Math.max(0, altitudeM);
  const old = clamp01((ageDays - 150) / 300);
  const shift = -Math.min(3, alt / 1500) - 1.5 * old;
  const amp = clamp((1 - Math.min(0.4, alt / 10000)) * (1 - 0.45 * old), 0.3, 1);
  const peakHour = r3(wrap24(life.chronotype + shift));
  let d = wrap24(hour - peakHour);
  if (d > 12) d -= 24;
  const rhythm = Math.cos((2 * Math.PI * d) / 24); // +1 at the peak, -1 twelve hours away
  const alertness = clamp01(0.5 + 0.5 * amp * rhythm - 0.3 * life.fatigue);
  const asleep = rhythm < -0.5 + 0.2 * old || life.fatigue > 0.95;
  const breath = clamp(1 - 0.05 * Math.abs(alt - life.altitudeM) / 1000, 0.88, 1);
  const fight = clamp((1 + 0.12 * amp * rhythm) * breath * (1 - 0.08 * life.fatigue), 0.8, 1.15);
  const production = clamp(1 + 0.1 * amp * rhythm - 0.05 * life.fatigue, 0.8, 1.15);
  const fertility = clamp((1 + 0.1 * amp * rhythm) * (1 - 0.25 * old), 0.8, 1.15);
  return {
    alertness: r3(alertness),
    fight: r3(fight),
    production: r3(production),
    fertility: r3(fertility),
    peakHour,
    asleep,
  };
}

// ------------------------------------------------------------------ the long loop
const LIFE_WHERE: Where = { ...NOWHERE, zone: "home", space: "virtual" };

/**
 * Catch up the time since life.lastTick (x ctx.timeScale, capped at MAX_CATCHUP_DAYS): digest,
 * add the absorbed units into conditions.diet, raise hunger, age, recover fatigue, acclimatise to
 * ctx.altitudeM (half-life ~5 days), and write ONE "genemon.life" ledger row. Mutates g.life and
 * g.conditions; deterministic given (g, now, ctx). Re-derive moves / stage afterwards (genemon.ts).
 */
export function tickLife(g: Genemon, now: number, ctx: LifeTickCtx): LifeTickReport {
  const life = g.life ?? newLifeState(g, now);
  g.life = life;
  const scale = Math.max(0, ctx.timeScale ?? 1);
  const realMs = Math.max(0, now - life.lastTick);
  const simMs = Math.min(realMs * scale, MAX_CATCHUP_DAYS * DAY_MS);
  const elapsedDays = simMs / DAY_MS;
  const phaseBefore = lifePhase(g);
  const ph = phOf(g);
  const events: string[] = [];

  // Digest on the simulated clock, then re-anchor both clocks on real time.
  life.digestion.lastTick = life.lastTick;
  const tick = digest(life, life.lastTick + simMs, ph, { ageDays: g.conditions.ageDays });
  life.digestion.lastTick = now;
  let absorbedUnits = 0;
  for (const [food, units] of Object.entries(tick.absorbed)) {
    if (!(units > 0)) continue;
    g.conditions.diet[food as FoodId] = r3((g.conditions.diet[food as FoodId] ?? 0) + units);
    absorbedUnits += units;
  }
  const metab = 0.8 + 0.4 * u01(ph.axes.tempo);
  const hungerBefore = g.conditions.hunger;
  g.conditions.hunger = r3(clamp01(g.conditions.hunger + HUNGER_PER_DAY * metab * elapsedDays + tick.hunger));
  g.conditions.ageDays = r3(g.conditions.ageDays + elapsedDays);
  life.fatigue = r3(clamp01(life.fatigue - 0.6 * elapsedDays + 0.2 * tick.bloat));
  const altBefore = life.altitudeM;
  const alt = Number.isFinite(ctx.altitudeM) ? ctx.altitudeM : life.altitudeM;
  life.altitudeM = Math.round(alt + (life.altitudeM - alt) * Math.exp(-elapsedDays / 7));
  life.lastTick = now;

  const circ = circadian(life, ctx.hour, alt, g.conditions.ageDays);
  const phaseAfter = lifePhase(g);
  if (phaseAfter !== phaseBefore) events.push(`phase:${phaseAfter}`);
  if (tick.bloat > 0) events.push("bloated");
  if (g.conditions.hunger >= 0.9) events.push("starving");
  if (Math.abs(altBefore - alt) > 300 && Math.abs(life.altitudeM - alt) <= 300) events.push("acclimatised");
  if (circ.asleep) events.push("asleep");

  ctx.ledger?.emit({
    when: now,
    where: LIFE_WHERE,
    who: ctx.who ?? g.owner,
    what: "genemon.life",
    why: scale === 1 ? "life clock" : `life clock x${scale}`,
    from: g.owner,
    to: g.id,
    entries: {
      elapsedDays: r3(elapsedDays),
      timeScale: scale,
      hour: r3(ctx.hour),
      altitudeM: Math.round(alt),
      phaseBefore,
      hungerBefore: r3(hungerBefore),
    },
    exits: {
      ageDays: g.conditions.ageDays,
      phase: phaseAfter,
      phaseChanged: phaseAfter !== phaseBefore,
      hunger: g.conditions.hunger,
      absorbed: r3(absorbedUnits),
      stomach: r3(fullnessOf(life.digestion)),
      bloat: tick.bloat,
      fatigue: life.fatigue,
      alertness: circ.alertness,
      asleep: circ.asleep,
      acclimatisedM: life.altitudeM,
      events: events.join(","),
    },
  });
  return {
    elapsedDays: r3(elapsedDays),
    phaseBefore,
    phaseAfter,
    absorbed: tick.absorbed,
    hunger: g.conditions.hunger,
    circadian: circ,
    events,
  };
}

// ------------------------------------------------------------------ scars and retirement
/** Store a scar (keeps the MAX_SCARS most severe). Creates the life state if missing. */
export function addScar(g: Genemon, scar: Scar): void {
  const life = g.life ?? newLifeState(g, g.bornAt);
  g.life = life;
  life.scars.push({
    ...scar,
    severity: r3(clamp01(scar.severity)),
    u: r3(clamp01(scar.u)),
    angle: r3(scar.angle),
  });
  if (life.scars.length > MAX_SCARS) {
    const weakest = life.scars.reduce((wi, s, i, arr) => (s.severity < arr[wi].severity ? i : wi), 0);
    life.scars.splice(weakest, 1);
  }
}

/**
 * A heavy hit may leave a scar: hits under 25 % of max HP never do; above, the chance and the
 * severity grow with the hit. Seeded (same battle seed -> same scars). Returns the scar, does not add it.
 */
export function scarFromHit(
  g: Genemon,
  damageFrac: number,
  element: ElementId | "physical",
  part: string,
  seed: number,
): Scar | null {
  if (!(damageFrac >= 0.25)) return null;
  const rng = new Rng(hashSeed(seed, g.id, part, "scar"));
  const severity = clamp01((damageFrac - 0.2) / 0.6);
  if (!rng.chance(0.35 + 0.6 * severity)) return null;
  return {
    atDay: r3(g.conditions.ageDays),
    part,
    severity: r3(severity),
    from: element,
    side: rng.chance(0.5) ? -1 : 1,
    u: r3(rng.range(0.15, 0.85)),
    angle: r3(rng.range(-Math.PI, Math.PI)),
  };
}

/** Eggs and fetuses cannot fight; ancients and heavily scarred elders are past their prime for ranked. */
export function canRank(g: Genemon): { ok: boolean; why: string } {
  const phase = lifePhase(g);
  if (phase === "egg" || phase === "fetus") return { ok: false, why: `${phase}: not born yet` };
  if (phase === "ancient") return { ok: false, why: "ancient: past its prime, retired from ranked" };
  if (phase === "elder") {
    const scars = g.life?.scars ?? [];
    const sev = scars.reduce((s, x) => s + x.severity, 0);
    if (scars.length >= ELDER_SCAR_LIMIT.count || sev >= ELDER_SCAR_LIMIT.severity) {
      return { ok: false, why: `elder with ${scars.length} scars (severity ${r3(sev)}): past its prime` };
    }
    return { ok: true, why: "elder: still fit to rank" };
  }
  return { ok: true, why: `${phase}: can rank` };
}

// ------------------------------------------------------------------ evolution path [P5-V1]
/** Growth reached at a given age and level with average feeding (epigenetics.growthOf without the diet term). */
function growthAt(ageDays: number, level: number): number {
  return 1 - Math.exp(-(ageDays / 18 + xpForLevel(level) / 2500));
}

/** Every phase with what it takes from the previous one and what changes, in plain words. */
export function evolutionPath(g: Genemon): EvolutionStep[] {
  const ph = phOf(g);
  const days = phaseDays(g);
  const neo = lifeRef(g).neoteny;
  const current = LIFE_PHASES.indexOf(lifePhase(g));
  const adultH = ph.heightM / (0.35 + 0.65 * ph.growth);
  const heightAt = (p: LifePhase) => adultH * (0.35 + 0.65 * growthAt(days[p], PHASE_LEVEL[p]));
  const perDay = capacityOf(ph) * 0.8; // about one stomach a day
  const pct = (a: number, b: number) => Math.round((b / Math.max(1e-9, a) - 1) * 100);
  const out: EvolutionStep[] = [];
  LIFE_PHASES.forEach((p, i) => {
    const prev = i > 0 ? LIFE_PHASES[i - 1] : p;
    const d = i > 0 ? days[p] - days[prev] : 0;
    const food = p === "egg" || p === "fetus" ? 0 : Math.round(d * perDay);
    const props: string[] = [];
    const dh = i > 1 ? pct(heightAt(prev), heightAt(p)) : 0;
    if (Math.abs(dh) >= 1) props.push(`${dh > 0 ? "+" : ""}${dh} % height`);
    switch (p) {
      case "egg":
        props.push("curled in a shell", "cannot fight");
        break;
      case "fetus":
        props.push(
          `spirals on itself (${
            r3((helixOf(g.genome, ph).p5 ?? P5_DEFAULTS).growth.spiral)
          } turns), uncurls as it grows`,
          "cannot fight",
        );
        break;
      case "hatchling":
        props.push(
          `baby proportions: big head, big eyes, short limbs (neoteny ${r3(neo)})`,
          "digests fast, hungry often",
          "can fight and rank",
        );
        break;
      case "juvenile":
        props.push(
          "limbs lengthen, head and eyes shrink relative to the body",
          `learns a full kit at level ${PHASE_LEVEL.juvenile}`,
          "can rank",
        );
        break;
      case "adult":
        props.push(
          "eyes shrink to adult proportions",
          "full power budget for its size class",
          `needs growth >= 0.55 (now ${r3(earnedGrowth(g))})`,
          "can rank",
        );
        break;
      case "elder":
        props.push(
          "slower, wiser",
          "sleeps earlier, flatter day rhythm, lower fertility",
          "digests slower",
          `can rank until ${ELDER_SCAR_LIMIT.count} scars`,
        );
        break;
      case "ancient":
        props.push(
          "very slow, wisest of its line",
          "cannot rank (retired)",
          "breeding fertility at its lowest",
        );
        break;
    }
    out.push({
      phase: p,
      stage: i,
      name: PHASE_NAME[p],
      cost: {
        days: r3(d),
        xp: i > 0 ? Math.max(0, xpForLevel(PHASE_LEVEL[p]) - xpForLevel(PHASE_LEVEL[prev])) : 0,
        food,
        credits: food * 6,
        bond: PHASE_BOND[p],
      },
      properties: props,
      reached: current >= i,
    });
  });
  return out;
}

/** Bloat of a life state (re-export for the sheet without importing digestion.ts). */
export function bloatOfLife(life: LifeState): number {
  return bloatOf(life.digestion);
}
