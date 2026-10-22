/**
 * Pass-5 CONTRACT (types only, no logic): senses, digestion, the life clock (age phases, circadian
 * rhythm, altitude, scars, retirement), imprints and the evolution path.
 *
 * Producers (lane genetics-life): src/genome/senses.ts, src/genome/digestion.ts, src/genome/lifeclock.ts,
 * src/genome/imprint.ts. Consumers: battle (resonance + perception), the Lab / Genemon sheet, the Home
 * life loop, breeding. A Genemon without `life` behaves exactly as before (all functions treat a missing
 * LifeState as `newLifeState(...)`). Pure: no DOM, no Date.now() (callers pass `now` in ms).
 *
 * THE API the producers MUST export (consumers code against these exact signatures):
 *
 *   senses.ts     sensesOf(ph: Phenotype, helix: MorphHelix, life?: LifeState): SenseProfile
 *                 channelOfMove(m: Move): SenseId | null          // which sense a move's effect travels through
 *                 resonanceMult(target: SenseProfile, ch: SenseId | null): number   // incoming multiplier, 0.7 .. 1.45
 *   digestion.ts  eat(life: LifeState, food: FoodId, units: number, now: number, ph: Phenotype, o?: { ignoreCapacity?: boolean }): EatResult
 *                 digest(life: LifeState, now: number, ph: Phenotype): DigestTick   // releases absorbed units over time
 *   lifeclock.ts  newLifeState(g: Genemon, now: number): LifeState
 *                 lifeOf(g: Genemon, now: number): LifeState       // g.life ?? newLifeState (does not mutate)
 *                 lifePhase(g: Genemon): LifePhase                 // from ageDays + growth + neoteny
 *                 circadian(life: LifeState, hour: number, altitudeM: number, ageDays: number): CircadianState
 *                 tickLife(g: Genemon, now: number, ctx: LifeTickCtx): LifeTickReport   // digestion, hunger, aging, rhythm; ledger rows
 *                 addScar(g: Genemon, scar: Scar): void
 *                 canRank(g: Genemon): { ok: boolean; why: string }  // elders past their prime cannot enter ranked
 *                 evolutionPath(g: Genemon): EvolutionStep[]        // every stage with its cost and properties
 *   imprint.ts    imprintFrom(g: Genemon, itemId: string, now: number): Imprint | null
 *                 inheritImprints(a: LifeState | undefined, b: LifeState | undefined, seed: number): Imprint[]
 */
import type { ElementId } from "../data/elements.ts";
import type { AxisId } from "../data/axes.ts";

// ------------------------------------------------------------------ senses
export const SENSE_IDS = [
  "vision", // eyes: range + field of view (count, yaw, size)
  "hearing", // ears: radius, detects what is behind
  "smell", // snout / nose: tracks hidden, burrowed, invisible targets
  "touch", // skin, whiskers, fur: melee read, parry
  "taste", // tongue: food effect strength, poison detection
  "thermal", // pits / glow organs: sees heat through smoke and fog
  "magnet", // metal / electric bodies: orientation, reads electric charge
  "electro", // electroreception (water, electric): senses charging moves
  "psychic", // mind / empathy: reads intent (the move an enemy is charging)
  "vibration", // feet, belly, serpents: senses ground moves and diggers
] as const;
export type SenseId = typeof SENSE_IDS[number];

/**
 * Every sense is a DOUBLE-EDGED sword: acuity gives information, and the same organ resonates with
 * effects that travel through it (big ears hear far AND take more from sonic moves). Senses are
 * budget-neutral: sum of acuity is normalised (SENSE_BUDGET) so a creature specialises, it does not
 * get stronger overall [SPEC B1].
 */
export interface SenseProfile {
  acuity: Record<SenseId, number>;
  /** Incoming effect multiplier per channel (resonance), 0.7 .. 1.45; 1 = neutral. */
  resonance: Record<SenseId, number>;
  /** Metres the creature sees in front of it (inside fovHalf). */
  visionRange: number;
  /** Half field of view, radians (pi = all around). */
  fovHalf: number;
  /** Metres it hears in every direction (behind included). */
  hearingRange: number;
  /** The organ behind each sense (for the UI: "ears 1.4x -> hearing 0.82"). */
  organ: Record<SenseId, string>;
}
export const SENSE_BUDGET = 3.2;

// ------------------------------------------------------------------ digestion
export type DietClass = "herbivore" | "carnivore" | "omnivore" | "lithovore" | "energivore";
export interface GutItem {
  food: string;
  units: number;
  /** ms */
  eatenAt: number;
  /** 0 .. 1 of the units already absorbed. */
  digested: number;
}
export interface Digestion {
  diet: DietClass;
  stomach: GutItem[];
  /** Stomach capacity in food units (body size); overfeeding past it is refused unless forced. */
  capacity: number;
  /** Hours to digest one unit (metabolism, temperature, age). */
  hoursPerUnit: number;
  /** ms of the last digest() call. */
  lastTick: number;
}
export interface EatResult {
  ok: boolean;
  why: string;
  /** Units actually swallowed. */
  units: number;
  /** Efficiency 0.2 .. 1.4 for this food given the diet class and taste (applied when absorbed). */
  efficiency: number;
  /** Fullness after eating, 0 .. capacity (can exceed capacity when forced). */
  fullness: number;
  /** Immediate visible effects (for the feed popup): stat / axis deltas, mood, element drift. */
  preview: { label: string; delta: number }[];
}
export interface DigestTick {
  /** Units absorbed per food since the last tick (the caller feeds these into conditions.diet). */
  absorbed: Record<string, number>;
  /** Hunger change (negative = fed). */
  hunger: number;
  /** Overfed discomfort 0..1 (slows, sleepy). */
  bloat: number;
}

// ------------------------------------------------------------------ life clock
export type LifePhase = "egg" | "fetus" | "hatchling" | "juvenile" | "adult" | "elder" | "ancient";
export const LIFE_PHASES: readonly LifePhase[] = ["egg", "fetus", "hatchling", "juvenile", "adult", "elder", "ancient"];
export interface Scar {
  /** Age (days) when it happened. */
  atDay: number;
  /** Body region ("torso", "head", "tail", "limb.l0"...). */
  part: string;
  /** 0..1 */
  severity: number;
  from: ElementId | "physical";
  side: -1 | 1;
  /** Position along the part 0..1 and around it (radians). */
  u: number;
  angle: number;
}
export interface Imprint {
  itemId: string;
  /** Which trait the object bent: an axis id, a sense id or a cosmetic channel. */
  trait: AxisId | SenseId | "coat" | "glow" | "color";
  /** Signed strength -1 .. 1. */
  strength: number;
  /** ms */
  since: number;
  /** Generations it has been carried (0 = acquired in this life). */
  generation: number;
}
export interface CircadianState {
  /** 0..1 how awake the creature is now. */
  alertness: number;
  /** Multipliers applied by consumers (fight power, production, breeding fertility). */
  fight: number;
  production: number;
  fertility: number;
  /** Preferred active hour after altitude + age shifts. */
  peakHour: number;
  asleep: boolean;
}
export interface LifeState {
  version: 1;
  digestion: Digestion;
  scars: Scar[];
  imprints: Imprint[];
  /** Genetic chronotype: preferred active hour 0..24. */
  chronotype: number;
  /** Altitude the creature is acclimatised to (m); far from it the rhythm and breath suffer. */
  altitudeM: number;
  /** Real ms of the last tickLife (the long loop catches up offline time from here). */
  lastTick: number;
  /** Fatigue 0..1 (fights, overfeeding, sleep debt). */
  fatigue: number;
}
export interface LifeTickCtx {
  hour: number;
  altitudeM: number;
  /** Demo / test multiplier on elapsed time (1 = real time). */
  timeScale?: number;
  ledger?: import("../core/ledger.ts").Ledger;
  who?: string;
}
export interface LifeTickReport {
  elapsedDays: number;
  phaseBefore: LifePhase;
  phaseAfter: LifePhase;
  absorbed: Record<string, number>;
  hunger: number;
  circadian: CircadianState;
  events: string[];
}
export interface EvolutionStep {
  phase: LifePhase;
  stage: number;
  name: string;
  /** What it takes to get there from the previous step. */
  cost: { days: number; xp: number; food: number; credits: number; bond: number };
  /** Plain-language properties gained / lost ("+18 % height", "eyes shrink to adult size", "can rank"). */
  properties: string[];
  reached: boolean;
}

// ------------------------------------------------------------------ demo / test settings
/** Settings.dev (the founder's test-demo controls). Absent = everything off / real time. */
export interface DevSettings {
  /** Life clock speed: 1 = real, 60 = one hour per minute, 1440 = a day per minute. */
  timeScale: number;
  /** Credits never run out (topped up to 1e9 on every save). */
  unlimitedCredits: boolean;
  /** Feeding ignores stomach capacity. */
  noFoodLimit: boolean;
}
export const DEV_DEFAULTS: DevSettings = { timeScale: 1, unlimitedCredits: false, noFoodLimit: false };
