/**
 * Pass-7 CONTRACT (types + defaults, no logic): Pareto-shaped variety, deeper morphogenetic operators,
 * surface relief, elaborated horns / spikes, a motion personality and an effects signature, all carried
 * by heritable gene pairs (appended to the morph helix, inherited Mendelian with a Pareto-tailed mutation).
 *
 * THE PARETO RULE [P7-D1]: every continuous morph parameter is expressed through a rank-preserving remap
 * (src/genome/pareto.ts): the population rank of the raw expression is sent through a two-sided bounded
 * Pareto quantile around the population median. Consequences, measured by `deno task pareto`:
 *   - min and max: the declared physical bounds are REACHED (rare creatures sit at the extremes);
 *   - median: the typical creature keeps the pre-pass-7 median look (the remap pins the median);
 *   - mean: pulled off the median toward the longer side (skewed, not symmetric);
 *   - 80/20: the 20 % most deviant creatures hold ~80 % of the total absolute deviation from the median.
 * So a Genemon is typical in most traits and striking in a few (its SIGNATURE traits, `MorphP7.signature`).
 * Combat stats are NOT remapped: the balance budget [SPEC B1] owns power; only shape / motion / effects are.
 *
 * Producers: src/genome/pareto.ts (math + remap), src/genome/helix7.ts (p7Of), src/genome/helix.ts (wiring).
 * Consumers read `helix.p7 ?? P7_DEFAULTS` (P7_DEFAULTS reproduces the pass-6 look and motion exactly):
 *   src/render/anatomy/ops.ts + body.ts (ops, relief, horns, spikes)  - lane geometry
 *   src/render/animator.ts                                           - lane motion
 *   src/render/fx.ts (+ battleView wiring lines)                     - lane fx
 */
import type { MorphOp } from "./morphTypes.ts";

/** Surface relief carved / raised on the lofted chains (torso, neck, tail; limbs at half strength). */
export interface ReliefGenes {
  /** Sharp longitudinal crests along the back (0 = none .. 5). */
  ridges: number;
  /** Longitudinal grooves spaced around the section (0 = none .. 8). */
  flutes: number;
  /** Annular banding rings along a chain (0 = none .. 12): arthropod / worm segmentation. */
  segments: number;
  /** Depth of those bands 0..1. */
  segmentDepth: number;
  /** Tubercles / warts / bosses density 0..1. */
  knobs: number;
  /** Faceting 0 (smooth) .. 1 (crystal / armour planes). */
  facets: number;
  /** Scalloped edges on frills, fins, ears and wing membranes 0..1. */
  scallop: number;
}

export interface HornP7 {
  /** Horn PAIRS 0..3 (0 = the pass-6 horns only, as plan.horns decides). */
  pairs: number;
  /** Branching levels 0..3 (tines, antlers). */
  branch: number;
  /** Curl in turns 0 .. 1.5 (ram spiral). */
  curl: number;
}

export interface SpikeP7 {
  /** Spike rows along the back 0..3 (0 = the pass-6 single dorsal row). */
  rows: number;
  /** Length multiplier 0.5 .. 2. */
  length: number;
  /** Density multiplier 0.5 .. 2. */
  density: number;
}

/** Motion personality (secondary motion and timing), all bounded; neutral values = pass-6 motion. */
export interface MotionP7 {
  /** Follow-through / overlapping action on tails, ears, antennae, neck lag 0..1. */
  followThrough: number;
  /** Anticipation: wind-up exaggeration before a strike 0..1. */
  anticipation: number;
  /** Idle nervous micro-motion 0..1. */
  jitter: number;
  /** Idle body sway 0..1. */
  sway: number;
  /** Gait vertical bounce 0..1. */
  bounce: number;
  /** Spring stiffness multiplier 0.6 .. 1.6 (snappy vs. languid). */
  stiffness: number;
}

/** Effects signature: how this creature's moves and aura look (render-only, never the simulation). */
export interface FxP7 {
  /** Particle count / size multiplier 0.6 .. 1.6 (still under the FxDirector spawn budget). */
  intensity: number;
  /** Trail length 0..1 (projectiles, dashes, strikes). */
  trail: number;
  /** Ambient emissive motes around the body 0..1. */
  sparkle: number;
  /** Emissive glow pulse depth 0..1. */
  pulse: number;
  /** Hue shift of the element colour, turns (-0.08 .. 0.08). */
  hueShift: number;
}

export interface MorphP7 {
  version: 7;
  /** Extra morphogenetic operators (any MorphOpKind incl. the pass-7 kinds), 0..6, Pareto-distributed count. */
  ops: MorphOp[];
  relief: ReliefGenes;
  horns: HornP7;
  spikes: SpikeP7;
  motion: MotionP7;
  fx: FxP7;
  /**
   * The creature's SIGNATURE traits: the remapped genes whose population rank is most extreme
   * (|rank - 0.5| >= SIGNATURE_RANK = 0.485 in helix.ts; one-sided genes: high end only), most extreme first, at most 6. Empty = a perfectly typical Genemon.
   */
  signature: { gene: string; rank: number }[];
}

/** Pass-6 look and motion (identity for every consumer). */
export const P7_DEFAULTS: MorphP7 = {
  version: 7,
  ops: [],
  relief: { ridges: 0, flutes: 0, segments: 0, segmentDepth: 0, knobs: 0, facets: 0, scallop: 0 },
  horns: { pairs: 0, branch: 0, curl: 0 },
  spikes: { rows: 0, length: 1, density: 1 },
  motion: { followThrough: 0, anticipation: 0, jitter: 0, sway: 0, bounce: 0, stiffness: 1 },
  fx: { intensity: 1, trail: 0, sparkle: 0, pulse: 0, hueShift: 0 },
  signature: [],
};
