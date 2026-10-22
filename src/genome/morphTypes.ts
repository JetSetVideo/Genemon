/**
 * Pass-4 CONTRACT: the morph helix (types only, no logic).
 *
 * The genome is a double helix. Every visible or animated trait is carried by TWO genes on the strand,
 * a MINIMUM gene and a MAXIMUM gene, and an equation bounds the expressed value between them:
 *
 *     value = lo + (hi - lo) * shape(drive)        with lo <= hi enforced at expression time
 *
 * `drive` (0..1) is what the moment asks for (energy, emotion, a move's power, growth...). So a
 * creature whose wing-flap genes are (0.4, 1.3) never flaps less than 0.4 rad nor more than 1.3 rad,
 * whatever the animation wants: the genes bound the animation, top-down from the seed to the motion.
 *
 * Producers: `src/genome/helix.ts` (helixOf, boundTrait, inheritance). Consumers: `src/render/anatomy/*`
 * (geometry, face, wings, digits, skin), `src/render/animator.ts` (amplitude envelopes).
 * Legacy genomes (no `morph` alleles) get a DETERMINISTIC helix derived from their seeds and plan genes,
 * so every saved Genemon keeps the same look across reloads. The genome id never hashes these genes.
 */

/** A gene pair on the helix: the minimum and the maximum allele, both in [0, 1]. */
export interface GenePair {
  lo: number;
  hi: number;
}

/** An expressed bounded trait: its two bounds and the value at the reference drive (0.5). */
export interface BoundTrait {
  lo: number;
  hi: number;
  /** Value at drive 0.5 (the resting expression). */
  value: number;
}

/** Manga eye structures. */
export type EyeStyle =
  | "round" // big round eye, full dark pupil (classic shonen)
  | "sparkle" // shoujo: huge iris with star/sparkle highlights
  | "ring" // hollow pupil: an iris ring around an empty centre (hypnotised, menacing)
  | "blank" // white eyes: no pupil at all (rage, possession, mystery)
  | "slit" // reptile / feline vertical slit
  | "sharp" // tsurime: narrow upturned angular eye
  | "sleepy" // tareme: drooping half-lidded eye
  | "compound"; // insect: faceted dome

export type PupilFill = "full" | "hollow" | "none" | "slit" | "star";
/** Something leaking out of the eyes (rendered as particles / emissive trails). */
export type EyeAura = "none" | "smoke" | "flame" | "spark" | "frost" | "tears";
export type TeethKind = "none" | "fangs" | "saw" | "tusks" | "needles" | "beak" | "molars";
export type WingKind = "none" | "membrane" | "feather" | "insect" | "fin";

/** Animation channels bounded by min/max gene pairs. Units: radians for joint motion, fractions for squash. */
export const ANIM_CHANNELS = ["breath", "gait", "tail", "wingFlap", "headBob", "windup", "strike", "recoil", "squash"] as const;
export type AnimChannel = typeof ANIM_CHANNELS[number];

export type AsymPart = "horn" | "ear" | "eye" | "wing" | "claw" | "tail" | "pattern";

export interface EyeGenes {
  style: EyeStyle;
  pupil: PupilFill;
  /** Eye radius as a share of the head radius (0.12 .. 0.45). */
  size: number;
  /** 1 .. 4 (two is by far the most common; 1 = cyclops, 3/4 rare). */
  count: number;
  /** 0xRRGGBB iris colour (element-coded by default, see helix.ts). */
  irisColor: number;
  /** 0xRRGGBB sclera colour (white is the norm; black or tinted sclera are rare). */
  scleraColor: number;
  /** Emissive strength of the iris 0..1. */
  glow: number;
  aura: EyeAura;
  /** Lid tilt in radians: + = upturned (fierce), - = drooping (sleepy). */
  lidAngle: number;
}

export interface MouthGenes {
  /** Mouth width as a share of the head width (0.3 .. 1). Drives breath-move power (src/combat/kit.ts). */
  width: number;
  teeth: TeethKind;
  /** Teeth per jaw side (0 .. 12). */
  teethCount: number;
  /** Tooth length as a share of the head radius (0 .. 0.6). */
  toothLength: number;
  tongue: boolean;
}

export interface WingGenes {
  kind: WingKind;
  /** Total span as a multiple of body height (0 when kind = none; 1.4 .. 3.2 for fliers). */
  span: number;
  /** Finger bones / main feathers spreading the surface (0 .. 5). */
  fingers: number;
  /** Membrane / feather detail level 0..1 (scallops, veins, feather rows). */
  detail: number;
}

export interface SurfaceGenes {
  /** Bump / normal-map depth 0..1. */
  bump: number;
  /** Pattern scale multiplier (0.5 .. 2). */
  patternScale: number;
  /** Pattern contrast 0..1. */
  patternContrast: number;
  /** Plate / scale size 0..1 (0 = none). */
  plates: number;
  /** Specular sheen 0..1 (wet, chitin, metal). */
  sheen: number;
  /** Fur / fuzz 0..1 (rim softness). */
  fur: number;
}

export interface MorphHelix {
  version: 1;
  /** Bilateral asymmetry 0 (perfect mirror) .. 1. Most creatures are 0; asymmetric ones are RARE (~8 %). */
  asymmetry: number;
  /** The side that carries the larger feature when asymmetric. */
  asymmetricSide: -1 | 1;
  asymmetricParts: AsymPart[];
  /** Fractal development depth 0..3: 0 smooth stumps, 1 digits, 2 digits + claws + knuckles, 3 sub-branching (tines, frills, crest fans). */
  fractalDepth: number;
  /** Digits per hand / foot (0 .. 5). */
  digits: number;
  /** Claw length as a share of the digit length (0 .. 1). Drives claw-move power. */
  clawLength: number;
  eyes: EyeGenes;
  mouth: MouthGenes;
  wings: WingGenes;
  surface: SurfaceGenes;
  /** How much adjacent body parts fuse into one surface (0 separate primitives .. 1 one smooth body). */
  fusion: number;
  /** Silhouette angularity: 0 round and soft .. 1 faceted, with sharp inner and outer angles. */
  angularity: number;
  /** Min/max envelopes of every animation channel. */
  anim: Record<AnimChannel, BoundTrait>;
}
