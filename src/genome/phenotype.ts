/**
 * Phenotype = genome x conditions. Everything visible or playable is derived here: body plan and
 * size, density/mass, elasticity/mobility, palette & pattern, elements (emergent from axes),
 * slot-normalised combat stats, abilities and the psyche (character, needs, envies, passions,
 * fears, baseline emotions).
 *
 * Balance contract [SPEC B1]: total combat power is NORMALISED to the size class budget x genetic
 * quality x level x growth. Axes decide how power is DISTRIBUTED (tank vs striker), not how much.
 */
import { AXIS_IDS, type AxisId, type AxisVector } from "../data/axes.ts";
import { ELEMENT_IDS, ELEMENTS, elementAffinities, type ElementId, typeMultiplier } from "../data/elements.ts";
import { GROUND_IDS, type GroundId } from "../data/grounds.ts";
import { FOOD_IDS, FOODS, type FoodId, GROUND_EXPOSURE } from "../data/lifestyle.ts";
import { clamp, clamp01, u01 } from "../core/math.ts";
import { type Conditions, epigeneticShift, growthOf, levelOf } from "./epigenetics.ts";
import { type BodyKind, geneticAxes, type Genome, type PatternKind, PLAN_GENES, type PlanGene, planValue } from "./genome.ts";
import { hashSeed, Rng } from "../core/rng.ts";

export const SIZE_CLASSES = ["XS", "S", "M", "L", "XL"] as const;
export type SizeClass = typeof SIZE_CLASSES[number];
export const SLOT_COST: Record<SizeClass, number> = { XS: 1, S: 1, M: 2, L: 3, XL: 4 };
/**
 * Relative combat-power budget per class. Per-slot parity is the target ([SPEC B3]: big vs swarm at
 * equal slots within 35-65%, measured by tools/balance.ts); big bodies get slightly less than 1.0
 * per slot because they also hit harder in contact, cleave in melee and shrug off knockback.
 */
export const POWER_BUDGET: Record<SizeClass, number> = { XS: 0.85, S: 1, M: 2, L: 2.9, XL: 3.9 };
export const MASS_THRESHOLDS: Record<Exclude<SizeClass, "XL">, number> = { XS: 6, S: 45, M: 260, L: 1100 };

export interface Stats {
  hp: number;
  atk: number;
  def: number;
  /** Ground speed m/s. */
  spd: number;
  energy: number;
  /** Energy regeneration per second. */
  regen: number;
  accuracy: number;
  evasion: number;
  crit: number;
  /** Stability against knockback/stagger 0..1. */
  balance: number;
  /** Melee reach in metres. */
  reach: number;
  /** Charge-speed multiplier (higher = faster phases). */
  rate: number;
}

export interface Emotions {
  joy: number;
  anger: number;
  fear: number;
  sadness: number;
  surprise: number;
  trust: number;
  energy: number;
}

export const NEED_IDS = ["hunger", "rest", "play", "social", "explore", "safety", "warmth", "water"] as const;
export type NeedId = typeof NEED_IDS[number];

export interface Psyche {
  character: string[];
  needs: Record<NeedId, number>;
  envies: string[];
  passions: string[];
  fears: string[];
  emotions: Emotions;
}

export interface Abilities {
  fly: boolean;
  swim: boolean;
  dig: boolean;
  /** Can change state of matter (form/melt). */
  phaseShift: boolean;
  weatherShaper: boolean;
  terraformer: boolean;
}

export interface Palette {
  base: number;
  accent: number;
  belly: number;
  eye: number;
  glow: number;
}

export interface Phenotype {
  axes: AxisVector;
  genetic: AxisVector;
  growth: number;
  level: number;
  kind: BodyKind;
  plan: Record<PlanGene, number>;
  pattern: PatternKind;
  palette: Palette;
  /** Glow strength 0..1 (emissive). */
  glow: number;
  heightM: number;
  massKg: number;
  /** kg/m3 */
  density: number;
  elasticity: number;
  /** Joint range multiplier. */
  mobility: number;
  /** Surface roughness 0..1 (texture/material). */
  roughness: number;
  /** 0 opaque .. 1 ghostly (gas/void bodies). */
  translucency: number;
  sizeClass: SizeClass;
  slots: number;
  elements: { primary: ElementId; secondary: ElementId | null; secondaryLevel: number; affinity: Record<ElementId, number> };
  stats: Stats;
  abilities: Abilities;
  psyche: Psyche;
  /** Normalised combat power index (budget x quality x level x growth x 100). */
  power: number;
}

const SHAPE_K: Record<BodyKind, number> = { quadruped: 0.16, biped: 0.09, hexapod: 0.1, serpent: 0.07, avian: 0.07, blob: 0.22 };
const KIND_BALANCE: Record<BodyKind, number> = { quadruped: 0.75, biped: 0.55, hexapod: 0.85, serpent: 0.8, avian: 0.45, blob: 0.65 };
const KIND_SPEED: Record<BodyKind, number> = { quadruped: 1.05, biped: 0.95, hexapod: 1, serpent: 0.85, avian: 0.9, blob: 0.7 };

// ------------------------------------------------------------------ colour helpers
function hexToHsl(c: number): [number, number, number] {
  const r = ((c >> 16) & 255) / 255, g = ((c >> 8) & 255) / 255, b = (c & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h /= 6;
  return [h, s, l];
}

export function hslToHex(h: number, s: number, l: number): number {
  h = ((h % 1) + 1) % 1;
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return (f(0) << 16) | (f(8) << 8) | f(4);
}

// ------------------------------------------------------------------ derivation
function chooseElements(axes: AxisVector) {
  const affinity = elementAffinities(axes);
  const ranked = ELEMENT_IDS.filter((e) => e !== "neutral").slice().sort((a, b) => affinity[b] - affinity[a]);
  const primary: ElementId = affinity[ranked[0]] >= 0.2 ? ranked[0] : "neutral";
  const second = primary === "neutral" ? null : ranked[1];
  const secondary = second && affinity[second] >= 0.32 ? second : null;
  return { primary, secondary, secondaryLevel: secondary ? clamp01(affinity[secondary]) : 0, affinity };
}

function paletteOf(g: Genome, axes: AxisVector, primary: ElementId, secondary: ElementId | null): Palette {
  const [h0, s0] = hexToHsl(ELEMENTS[primary].color);
  const hueShift = (g.hue[0] - 0.5) * 0.12;
  const light = clamp(0.42 + axes.luminance * 0.16 - Math.max(0, -axes.substance) * 0.15, 0.12, 0.72);
  const sat = clamp((primary === "neutral" ? 0.25 : s0 * 0.85) + axes.mood * 0.08, 0.08, 0.95);
  const base = hslToHex(h0 + hueShift, sat, light);
  const acc = secondary ? hexToHsl(ELEMENTS[secondary].color) : [h0 + 0.5 + (g.hue[1] - 0.5) * 0.3, sat * 0.8, 0.5];
  const accent = hslToHex(acc[0], clamp(acc[1], 0.2, 0.95), clamp(light + 0.1 * (g.hue[1] - 0.3), 0.18, 0.75));
  const belly = hslToHex(h0 + hueShift, sat * 0.45, clamp(light + 0.25, 0.3, 0.9));
  const eye = hslToHex(0.08 + u01(axes.wisdom) * 0.7, 0.75, 0.55);
  const glow = ELEMENTS[secondary && Math.abs(axes.luminance) < 0.2 ? secondary : primary].core;
  return { base, accent, belly, eye, glow };
}

const CHARACTER_POLES: [AxisId, string, string][] = [
  ["conviction", "timid", "brave"],
  ["temper", "serene", "hot-headed"],
  ["sociality", "loner", "loyal"],
  ["curiosity", "homebody", "explorer"],
  ["wisdom", "naive", "sage"],
  ["mood", "gloomy", "cheerful"],
  ["appetite", "picky", "glutton"],
  ["structure", "chaotic", "methodical"],
];

function psycheOf(axes: AxisVector, types: ElementId[]): Psyche {
  const character = CHARACTER_POLES
    .map(([id, neg, pos]) => ({ v: axes[id], label: axes[id] < 0 ? neg : pos }))
    .sort((a, b) => Math.abs(b.v) - Math.abs(a.v))
    .slice(0, 3)
    .filter((c) => Math.abs(c.v) > 0.12)
    .map((c) => c.label);
  if (character.length === 0) character.push("balanced");
  const needs: Record<NeedId, number> = {
    hunger: clamp01(0.25 + 0.5 * u01(axes.appetite)),
    rest: clamp01(0.2 + 0.5 * (1 - u01(axes.tempo)) + 0.2 * u01(axes.weight)),
    play: clamp01(0.15 + 0.4 * u01(axes.mood) + 0.3 * u01(axes.curiosity)),
    social: u01(axes.sociality),
    explore: u01(axes.curiosity),
    safety: clamp01(1 - u01(axes.conviction)),
    warmth: clamp01(0.5 - axes.heat * 0.5),
    water: u01(axes.moisture),
  };
  const dotNudge = (n: Partial<Record<AxisId, number>>) =>
    Object.entries(n).reduce((s, [k, v]) => s + axes[k as AxisId] * (v as number), 0);
  const foods = FOOD_IDS.slice().sort((a, b) => dotNudge(FOODS[b].nudge) - dotNudge(FOODS[a].nudge));
  const places = GROUND_IDS.filter((g) => GROUND_EXPOSURE[g])
    .sort((a, b) => dotNudge(GROUND_EXPOSURE[b as GroundId]!) - dotNudge(GROUND_EXPOSURE[a as GroundId]!));
  const envies = [FOODS[foods[0] as FoodId].name, FOODS[foods[1] as FoodId].name, `time on ${places[0]}`];
  const passions: string[] = [];
  const add = (cond: boolean, p: string) => cond && passions.push(p);
  add(axes.temper > 0.25, "battles");
  add(axes.altitude > 0.3, "flying");
  add(axes.moisture > 0.3, "swimming");
  add(axes.altitude < -0.3, "digging");
  add(axes.luminance > 0.3, "sunbathing");
  add(axes.wisdom > 0.3, "puzzles");
  add(axes.sociality > 0.3, "playing with friends");
  add(axes.curiosity > 0.3, "exploring new places");
  add(axes.mood > 0.3, "music");
  add(axes.rhythm < -0.3, "night walks");
  add(axes.appetite > 0.4, "feasts");
  if (passions.length === 0) passions.push("quiet routines");
  const fears = ELEMENT_IDS.filter((e) => e !== "neutral")
    .map((e) => ({ e, m: typeMultiplier(e, types) }))
    .filter((x) => x.m > 1)
    .sort((a, b) => b.m - a.m)
    .slice(0, 2)
    .map((x) => `${ELEMENTS[x.e].name.toLowerCase()} attacks`);
  if (axes.luminance > 0.4 && axes.conviction < 0) fears.push("darkness");
  if (axes.altitude < -0.4) fears.push("heights");
  if (axes.sociality > 0.5) fears.push("being alone");
  if (axes.sociality < -0.5) fears.push("crowds");
  if (axes.heat > 0.5 && axes.moisture < -0.3) fears.push("deep water");
  const emotions: Emotions = {
    joy: clamp01(0.2 + 0.6 * u01(axes.mood)),
    anger: clamp01(0.4 * u01(axes.temper)),
    fear: clamp01(0.5 * (1 - u01(axes.conviction))),
    sadness: clamp01(0.3 * (1 - u01(axes.mood))),
    surprise: 0.1,
    trust: clamp01(0.6 * u01(axes.sociality)),
    energy: 1,
  };
  return { character, needs, envies, passions, fears, emotions };
}

function sizeClassOf(mass: number): SizeClass {
  if (mass < MASS_THRESHOLDS.XS) return "XS";
  if (mass < MASS_THRESHOLDS.S) return "S";
  if (mass < MASS_THRESHOLDS.M) return "M";
  if (mass < MASS_THRESHOLDS.L) return "L";
  return "XL";
}

/** Reference energy regeneration (per second) at which regen is neutral in the power index. */
export const REGEN_REF = 11;
/** Hard cap on total evasion (base x statuses x synergies): a dodge never removes more than 35 % of hits. */
export const EVASION_CAP = 0.35;

/**
 * Raw combat power of a stat block: sqrt(effective HP x expected damage rate) [SPEC B1].
 * Effective HP counts defence exactly as the battle does (100 / (100 + def)) and evasion
 * (1 / (1 - evasion)); the damage rate counts energy throughput (regen / REGEN_REF), accuracy and
 * expected crit (+60 % per crit). Every stat that wins fights is paid for out of the same budget:
 * a creature that dodges, crits or regenerates more gets less raw HP and attack.
 */
export function powerIndex(s: Pick<Stats, "hp" | "def" | "atk" | "rate" | "regen" | "evasion" | "accuracy" | "crit">): number {
  // Evasion only dodges direct hits (hitChance is rolled in Battle.hit); damage over time,
  // conduction and hazards ignore it, so it is priced on ~80 % of incoming damage (estimate).
  const ehp = s.hp * (1 + s.def / 100) / (1 - 0.8 * Math.min(EVASION_CAP, s.evasion));
  const dps = s.atk * s.rate * (s.regen / REGEN_REF) * s.accuracy * (1 + 0.6 * s.crit);
  return Math.sqrt(ehp * dps);
}

export function express(g: Genome, c: Conditions): Phenotype {
  const genetic = geneticAxes(g);
  const shift = epigeneticShift(c);
  const axes = {} as AxisVector;
  for (const id of AXIS_IDS) axes[id] = clamp(genetic[id] + shift[id], -1, 1);
  const growth = growthOf(c);
  const level = levelOf(c.xp);
  const plan = {} as Record<PlanGene, number>;
  for (const id of PLAN_GENES) plan[id] = planValue(g, id);

  const size01 = u01(axes.stature), weight01 = u01(axes.weight), hard01 = u01(axes.hardness);
  const tempo01 = u01(axes.tempo), might01 = u01(axes.might), vit01 = u01(axes.vitality);
  const focus01 = u01(axes.focus);
  const adultH = 0.25 * Math.pow(16, size01);
  const heightM = adultH * (0.35 + 0.65 * growth);
  const density = clamp(
    1000 * Math.pow(2, 1.6 * axes.weight) * (1 - 0.75 * Math.max(0, axes.phase)) *
      (1 - 0.6 * Math.max(0, -axes.substance)) * (1 + 0.35 * Math.max(0, axes.hardness)),
    60,
    4000,
  );
  const massKg = density * SHAPE_K[g.kind] * heightM ** 3;
  const sizeClass = sizeClassOf(massKg);
  const elasticity = clamp01(u01(axes.elasticity) * 0.85 + Math.max(0, axes.phase) * 0.15);
  const mobility = clamp(0.6 + 0.8 * elasticity - 0.3 * hard01 + 0.2 * u01(axes.form), 0.4, 1.6);

  const els = chooseElements(axes);
  const types = [els.primary, ...(els.secondary ? [els.secondary] : [])];

  // Stat SHAPE from axes, then normalised to the power budget.
  const quality = plan.quality;
  const raw: Stats = {
    hp: 100 * (1 + 0.6 * size01 + 0.4 * hard01 + 0.3 * vit01 - 0.3 * tempo01),
    atk: 20 * (1 + 0.7 * might01 + 0.3 * u01(axes.temper) + 0.2 * focus01),
    def: 30 * (1 + 0.8 * hard01 + 0.4 * weight01),
    // Ground speed grows with body size (longer strides): XS x0.85 .. XL x1.15 at equal tempo.
    spd: (2.2 + 3.8 * tempo01) * (0.75 + 0.35 * plan.legLen) * (1 - 0.25 * weight01) * KIND_SPEED[g.kind] * (0.85 + 0.3 * size01),
    energy: 100,
    // Narrow band: energy regeneration is action THROUGHPUT, and it also enters powerIndex below.
    regen: 8.5 + 5 * vit01,
    accuracy: clamp(0.82 + 0.1 * focus01 + 0.06 * u01(axes.conviction), 0.6, 0.99),
    // Fliers, light bodies and small fast bodies are hard to hit. A light body is physically BIGGER
    // for its mass class (low density), so agility compensates its larger silhouette.
    evasion: clamp(0.04 + 0.12 * tempo01 + 0.06 * (1 - size01) + 0.07 * (0.5 - weight01) + 0.08 * Math.max(0, axes.altitude), 0.02, 0.28),
    crit: clamp(0.04 + 0.07 * focus01 + 0.04 * Math.max(0, -axes.structure), 0.03, 0.18),
    balance: clamp(KIND_BALANCE[g.kind] * (0.7 + 0.3 * weight01 + 0.2 * hard01), 0.2, 1),
    reach: 0.55 + 0.45 * heightM + 0.25 * plan.neck * heightM,
    rate: 0.75 + 0.5 * tempo01,
  };
  const target = 100 * POWER_BUDGET[sizeClass] * (1 + 0.12 * (2 * quality - 1)) * (1 + (level - 1) / 30) *
    (0.55 + 0.45 * growth);
  const s = target / powerIndex(raw);
  const stats: Stats = { ...raw, hp: raw.hp * s, atk: raw.atk * s };

  const abilities: Abilities = {
    fly: g.kind === "avian" || (plan.wings > 0.62 && axes.altitude > 0.35 && density < 900),
    swim: axes.moisture > 0.25 || (g.kind === "serpent" && axes.moisture > 0),
    dig: axes.altitude < -0.3 && axes.hardness > -0.2 && g.kind !== "avian" && g.kind !== "blob",
    phaseShift: axes.form > 0.45 && Math.abs(axes.phase) < 0.6,
    weatherShaper: axes.wisdom > 0.2 &&
      // Every element that owns a weather move can learn to call it.
      (["air", "water", "ice", "light", "shadow", "fire", "earth", "electric", "poison"] as ElementId[]).some((e) => els.affinity[e] > 0.42),
    terraformer: axes.might > 0 && (["earth", "plant", "ice", "fire"] as ElementId[]).some((e) => els.affinity[e] > 0.48),
  };
  if (abilities.fly) stats.balance = Math.max(0.2, stats.balance - 0.1);

  const glowEls: ElementId[] = ["fire", "electric", "light", "psychic", "void"];
  const glow = clamp01(
    Math.max(0, axes.luminance) * 0.7 + (glowEls.includes(els.primary) ? 0.35 : 0) +
      (els.secondary && glowEls.includes(els.secondary) ? 0.15 : 0),
  );
  return {
    axes,
    genetic,
    growth,
    level,
    kind: g.kind,
    plan,
    pattern: g.pattern,
    palette: paletteOf(g, axes, els.primary, els.secondary),
    glow,
    heightM,
    massKg,
    density,
    elasticity,
    mobility,
    roughness: clamp(0.35 + 0.5 * hard01 - 0.2 * u01(axes.moisture), 0.1, 0.95),
    translucency: clamp01(Math.max(0, axes.phase) * 0.6 + Math.max(0, -axes.substance) * 0.5),
    sizeClass,
    slots: SLOT_COST[sizeClass],
    elements: els,
    stats,
    abilities,
    psyche: psycheOf(axes, types),
    power: powerIndex(stats),
  };
}

// ------------------------------------------------------------------ names
const SYLL: Record<ElementId, string[]> = {
  neutral: ["no", "ba", "tum", "pell", "ra"],
  fire: ["pyr", "cind", "embr", "blaz", "flar"],
  water: ["aqu", "mar", "tid", "dribb", "wav"],
  plant: ["fern", "bloss", "sprou", "thorn", "leaf"],
  earth: ["terr", "bould", "grav", "clod", "dun"],
  air: ["zeph", "gust", "aer", "whisp", "sky"],
  electric: ["volt", "zap", "spark", "amp", "fulg"],
  ice: ["fros", "glac", "rim", "cryo", "sleet"],
  metal: ["ferr", "chrom", "anvi", "rivet", "steel"],
  poison: ["tox", "venn", "mias", "blig", "acr"],
  light: ["lum", "sol", "radi", "glim", "auro"],
  shadow: ["umbr", "noct", "shad", "murk", "gloam"],
  psychic: ["psi", "ment", "orac", "medi", "lucid"],
  void: ["null", "vac", "hollo", "abys", "nihil"],
};
const SUFFIX: Record<BodyKind, string[]> = {
  quadruped: ["on", "hound", "mane", "tusk", "paw"],
  biped: ["ar", "kin", "mon", "ix", "ard"],
  hexapod: ["pede", "ix", "mite", "beet", "skitter"],
  serpent: ["coil", "wyrm", "sss", "ra", "lash"],
  avian: ["wing", "kite", "fowl", "talon", "plume"],
  blob: ["goo", "blob", "ooze", "mire", "plop"],
};

export function nameFor(g: Genome, ph: Phenotype): string {
  const rng = new Rng(hashSeed(g.id, "name"));
  const a = rng.pick(SYLL[ph.elements.primary]);
  const b = ph.elements.secondary ? rng.pick(SYLL[ph.elements.secondary]).slice(0, 2) : "";
  const s = rng.pick(SUFFIX[g.kind]);
  const n = a + b + s;
  return n.charAt(0).toUpperCase() + n.slice(1);
}

export type { FoodId };
