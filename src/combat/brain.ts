/**
 * Fighter brain [P5-B1] and perception [P5-B2], pure and deterministic.
 *
 * A BASIC DECISION TREE SHAPED LIKE A SMALL NEURAL MODEL. Every decision, a fighter reads a fixed
 * feature vector (its HP and energy, the distance band to its focus enemy, what that enemy is doing,
 * whether it is looking at me, whether I am seen, my allies, the type advantage I believe I have,
 * my kit and my psyche). One hidden layer of eight NAMED neurons (aggress, kite, flank, guard,
 * interrupt, finish, retreat, regroup) computes `sigmoid(bias + w . x + p . psyche)` with FIXED weights
 * (`BRAIN_WEIGHTS`) and psyche weights (`BRAIN_PSYCHE`: a wild temper drives aggress, fear drives
 * retreat, wisdom drives flank / interrupt / guard, a far reach drives kite, sociality regroup). The
 * winning neuron (argmax, Rng tie-break, a small stickiness bonus for the current intent) is the
 * INTENT. The intent does not pick the move: it BIASES the utility AI (`moveBias`, `targetBias`) and
 * the movement (battle.ts `steer`: flank = go round to the target's back, kite = keep range,
 * retreat = disengage, regroup = rejoin the allies). The activations are exposed for the UI.
 *
 * PERCEPTION: each fighter sees inside a field of view (half angle `fovHalf` around its body yaw)
 * up to `visionRange`, and hears all around up to `hearingRange` (louder when the other moves fast
 * or casts). `defaultPerception(ph)` derives the three numbers from the plan genes (eyes, ears,
 * head) with a trade-off (big eyes see further but narrower); the genetics lane's
 * `sensesOf(ph, helix)` returns a SenseProfile with the same three fields and can be plugged in
 * through `BattleSetup.perception`.
 */
import { clamp, u01 } from "../core/math.ts";
import type { Rng } from "../core/rng.ts";
import type { Genemon } from "../genome/genemon.ts";
import type { Phenotype } from "../genome/phenotype.ts";

// ------------------------------------------------------------------ perception [P5-B2]

/** What a fighter can perceive. Structurally a subset of lifeTypes' SenseProfile. */
export interface Perception {
  /** Metres it sees in front of it (inside fovHalf). */
  visionRange: number;
  /** Half field of view, radians (PI = all around). */
  fovHalf: number;
  /** Metres it hears in every direction (behind included). */
  hearingRange: number;
}

/** Plugged by the orchestrator, e.g. `(g, ph) => sensesOf(ph, helixOf(g))`. */
export type PerceptionProvider = (g: Genemon, ph: Phenotype) => Perception;

/** Seconds a fighter remembers where an enemy was after losing it from sight and hearing. */
export const MEMORY_S = 3;
/** Utility multiplier on a target the fighter neither sees, hears nor remembers. */
export const UNPERCEIVED_K = 0.35;

/**
 * Default perception from the body plan (eyes, ears, head genes in 0..1, kind), budget-shaped: a big
 * eye sees further but narrower (predator), a small one wider (prey); big ears hear further. Blobs
 * have no front (all-round, short sight); serpents feel the ground (hearing +2 m); bigger bodies see
 * a little further (their eyes are higher).
 */
export function defaultPerception(ph: Phenotype): Perception {
  const p = ph.plan;
  const eyes = clamp(p.eyes ?? 0.5, 0, 1),
    ears = clamp(p.ears ?? 0.5, 0, 1),
    head = clamp(p.head ?? 0.5, 0, 1);
  const tall = 0.85 + 0.15 * clamp(ph.heightM, 0, 2);
  let visionRange = (9 + 9 * eyes + 2 * head) * tall;
  let fovHalf = 1.95 - 0.75 * eyes;
  let hearingRange = 4 + 7 * ears + 1.5 * head;
  if (ph.kind === "blob") {
    fovHalf = Math.PI;
    visionRange *= 0.6;
  }
  if (ph.kind === "serpent") hearingRange += 2;
  if (ph.kind === "avian") visionRange *= 1.15;
  return {
    visionRange: r2(visionRange),
    fovHalf: fovHalf >= Math.PI ? Math.PI : r2(clamp(fovHalf, 0.6, Math.PI)),
    hearingRange: r2(hearingRange),
  };
}

const r2 = (x: number) => Math.round(x * 100) / 100;

/** Signed smallest difference a - b, in (-PI, PI]. */
export function angleDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Bearing (yaw convention of physics.ts: atan2(dx, dz)) from (x0, z0) to (x1, z1). */
export function bearing(x0: number, z0: number, x1: number, z1: number): number {
  return Math.atan2(x1 - x0, z1 - z0);
}

/** Is the point inside the field of view of a body at (x, z) facing `yaw`? */
export function inFov(yaw: number, fovHalf: number, x: number, z: number, px: number, pz: number): boolean {
  if (fovHalf >= Math.PI) return true;
  return Math.abs(angleDiff(bearing(x, z, px, pz), yaw)) <= fovHalf;
}

/** 0 (looking straight away) .. 1 (looking straight at the point). */
export function facingScore(yaw: number, x: number, z: number, px: number, pz: number): number {
  return (1 + Math.cos(angleDiff(bearing(x, z, px, pz), yaw))) / 2;
}

// ------------------------------------------------------------------ the model [P5-B1]

export const INTENTS = [
  "aggress",
  "kite",
  "flank",
  "guard",
  "interrupt",
  "finish",
  "retreat",
  "regroup",
] as const;
export type Intent = typeof INTENTS[number];

export const FEATURES = [
  "hp", // my HP fraction
  "energy", // my energy fraction
  "close", // soft distance band to the focus enemy (surface gap < ~1.5 m)
  "mid", // 1 - close - far
  "far", // gap > ~6 m
  "threat", // an enemy is charging a move AT ME (x its power / 140, x its progress)
  "enemyResting", // the focus enemy is in its rest phase (vulnerable)
  "enemyFacingMe", // 0 = it looks away, 1 = it looks at me
  "seen", // 1 if at least one enemy currently sees me
  "allies", // live allies within 5 m / 3
  "alone", // I have live allies but none within ~5-10 m
  "typeAdv", // log2 of the best type multiplier I believe my moves have, in [-1, 1]
  "targetLow", // 1 - focus enemy's HP fraction
  "ranged", // share of my damaging moves that are ranged (projectile / beam / zone)
  "canGuard", // I can afford a buff / heal / phase / flight
  "canInterrupt", // I can afford a move that interrupts (stun / freeze >= 50 %)
  "temper", // psyche: calm 0 .. wild 1
  "wisdom", // psyche: naive 0 .. wise 1
  "fear", // emotion now (feared status counts 0.8)
] as const;
export type FeatureId = typeof FEATURES[number];
export type BrainFeatures = Record<FeatureId, number>;

/** Psyche axes that shape the gains (all in 0..1). */
export interface BrainPsyche {
  temper: number;
  wisdom: number;
  fear: number;
  reach: number;
  sociality: number;
}

export interface Neuron {
  bias: number;
  w: Partial<Record<FeatureId, number>>;
}

/**
 * The fixed weights of the hidden layer (pre-activation = bias + sum w_i x_i). The weights are
 * hand-set (sign = the reason, size = how much it matters); the biases were calibrated once, offline,
 * on the feature vectors of a 120-battle random-team corpus so that the intents share roughly
 * aggress 40 %, kite 15 %, flank / interrupt / finish 10 % each, guard / retreat / regroup 5 % each
 * (tests/brain_test.ts checks every intent is reachable and the psyche moves the shares).
 */
export const BRAIN_WEIGHTS: Readonly<Record<Intent, Neuron>> = {
  aggress: {
    bias: -1.55,
    w: { hp: 1.2, energy: 0.6, close: 0.4, typeAdv: 0.9, enemyResting: 0.7, temper: 1.2, fear: -1.6 },
  },
  kite: {
    bias: -1.53,
    w: { ranged: 1.8, close: 0.9, enemyFacingMe: 0.3, wisdom: 0.4, temper: -0.6, hp: -0.3 },
  },
  flank: {
    bias: -1.77,
    w: { enemyFacingMe: 1.1, ranged: -1.1, allies: 0.7, mid: 0.4, wisdom: 0.9, fear: -0.6, seen: 0.3 },
  },
  guard: { bias: -0.4, w: { threat: 2.0, canGuard: 1.0, hp: -0.7, wisdom: 0.5, temper: -0.7 } },
  interrupt: { bias: -2.36, w: { threat: 2.4, canInterrupt: 1.5, wisdom: 0.7, energy: 0.4 } },
  finish: { bias: -2.52, w: { targetLow: 2.8, typeAdv: 0.4, temper: 0.5, energy: 0.4, hp: 0.3 } },
  retreat: { bias: -0.52, w: { hp: -2.2, fear: 2.0, temper: -0.9, seen: 0.4, allies: -0.3 } },
  regroup: { bias: -1.17, w: { alone: 1.9, hp: -0.6, fear: 0.6, temper: -0.5, threat: 0.3 } },
};

/**
 * Psyche weights: the psyche axes shift each neuron's drive, z += sum p_k x (2 psyche_k - 1) - a wild
 * temper pushes aggress up and retreat down, fear pushes retreat up, wisdom pushes flank / interrupt /
 * guard, a far reach pushes kite, sociality pushes regroup. Monotone: more of an axis always moves the
 * neuron the same way.
 */
export const BRAIN_PSYCHE: Readonly<Record<Intent, Partial<Record<keyof BrainPsyche, number>>>> = {
  aggress: { temper: 0.8, fear: -0.6 },
  kite: { reach: 0.8 },
  flank: { wisdom: 0.7 },
  guard: { wisdom: 0.5, temper: -0.4 },
  interrupt: { wisdom: 0.6 },
  finish: { temper: 0.5 },
  retreat: { fear: 0.9, temper: -0.5 },
  regroup: { sociality: 0.8 },
};

/** Bonus the CURRENT intent gets (hysteresis: no flicker between two close neurons). */
export const STICKINESS = 0.04;

export interface BrainState {
  intent: Intent;
  /** Activation of every neuron, 0..1 (rounded to 3 decimals for the UI). */
  neurons: Record<Intent, number>;
  /** The inputs the decision was made on. */
  features: BrainFeatures;
  /** Fighter idx of the enemy the features were read on (-1 = none). */
  focus: number;
  /** Battle time of the decision. */
  t: number;
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

/** Hidden-layer activations for a feature vector and a psyche. */
export function activations(x: BrainFeatures, psyche: BrainPsyche): Record<Intent, number> {
  const out = {} as Record<Intent, number>;
  for (const id of INTENTS) {
    const n = BRAIN_WEIGHTS[id];
    let z = 0;
    for (const [k, w] of Object.entries(n.w) as [FeatureId, number][]) z += w * (x[k] ?? 0);
    for (const [k, p] of Object.entries(BRAIN_PSYCHE[id]) as [keyof BrainPsyche, number][]) {
      z += p * (2 * psyche[k] - 1);
    }
    out[id] = sigmoid(n.bias + z);
  }
  return out;
}

/**
 * The output layer: argmax of the activations (+ STICKINESS for `prev`). Exact ties (within 1e-9) are
 * broken by `rng` - consumed ONLY when a tie exists, so the fighter's random stream is otherwise untouched.
 */
export function pickIntent(a: Record<Intent, number>, rng: Rng, prev: Intent | null = null): Intent {
  let best = -Infinity;
  let top: Intent[] = [];
  for (const id of INTENTS) {
    const v = a[id] + (id === prev ? STICKINESS : 0);
    if (v > best + 1e-9) {
      best = v;
      top = [id];
    } else if (Math.abs(v - best) <= 1e-9) top.push(id);
  }
  return top.length === 1 ? top[0] : rng.pick(top);
}

/** One forward pass: features -> hidden activations -> intent. */
export function think(
  x: BrainFeatures,
  psyche: BrainPsyche,
  rng: Rng,
  prev: Intent | null = null,
  t = 0,
  focus = -1,
): BrainState {
  const a = activations(x, psyche);
  const intent = pickIntent(a, rng, prev);
  const neurons = {} as Record<Intent, number>;
  for (const id of INTENTS) neurons[id] = Math.round(a[id] * 1000) / 1000;
  return { intent, neurons, features: x, focus, t };
}

/** Psyche inputs from a phenotype and the live fear emotion. */
export function psycheOf(ph: Phenotype, fear: number): BrainPsyche {
  return {
    temper: u01(ph.axes.temper),
    wisdom: u01(ph.axes.wisdom),
    fear: clamp(fear, 0, 1),
    reach: u01(ph.axes.reach),
    sociality: u01(ph.axes.sociality),
  };
}

// ------------------------------------------------------------------ how an intent biases the AI

/** What the utility AI needs to know about a candidate move to bias it. */
export interface MoveTraits {
  damaging: boolean;
  /** projectile / beam / zone */
  ranged: boolean;
  /** melee / dash / burst / cone / dig */
  close: boolean;
  /** stun / freeze >= 50 % */
  interrupt: boolean;
  /** buff / phase / fly (a defensive or evasive self move) */
  protect: boolean;
  heal: boolean;
  power: number;
  /** Effective charge time in seconds (after the battle tempo). */
  charge: number;
}

/** Utility multiplier an intent puts on a move (independent of the target). Bounded [0.55, 1.7]. */
export function moveBias(intent: Intent, m: MoveTraits): number {
  let k = 1;
  switch (intent) {
    case "aggress":
      if (m.damaging) k *= 1.1;
      if (m.close) k *= 1.08;
      break;
    case "kite":
      if (m.ranged) k *= 1.25;
      if (m.close) k *= 0.75;
      break;
    case "flank":
      if (m.close) k *= 1.12;
      break;
    case "guard":
      if (m.protect) k *= 1.6;
      if (m.heal) k *= 1.3;
      if (m.charge > 1.6) k *= 0.8;
      break;
    case "interrupt":
      if (m.interrupt) k *= 1.45;
      else if (m.charge < 0.8) k *= 1.1;
      break;
    case "finish":
      if (m.damaging && m.charge < 1.2) k *= 1.12;
      break;
    case "retreat":
      if (m.close) k *= 0.6;
      if (m.ranged) k *= 1.1;
      if (m.heal) k *= 1.6;
      if (m.protect) k *= 1.35;
      break;
    case "regroup":
      if (m.close) k *= 0.9;
      break;
  }
  return clamp(k, 0.55, 1.7);
}

/** What the utility AI needs to know about a candidate target. */
export interface TargetTraits {
  /** HP fraction. */
  hp: number;
  /** In its charge phase. */
  charging: boolean;
  /** I am outside its field of view (it cannot see me). */
  blindSide: boolean;
}

/** Utility multiplier an intent puts on a (move, target) pair. Bounded [0.7, 1.6]. */
export function targetBias(intent: Intent, m: MoveTraits, t: TargetTraits): number {
  let k = 1;
  if (intent === "finish" && t.hp < 0.4) k *= 1.5;
  if (intent === "interrupt" && t.charging && m.interrupt) k *= 1.25;
  if (intent === "flank" && t.blindSide && m.close) k *= 1.25;
  if (intent === "aggress" && t.hp < 0.3) k *= 1.1;
  return clamp(k, 0.7, 1.6);
}
