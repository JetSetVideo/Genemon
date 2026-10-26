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
  anim: Record<AnimChannel, BoundTrait>;  /** Pass-5 genes (eyes 1..8 and shapes, beaks, growth envelope, operators, coat). Absent = P5_DEFAULTS. */
  p5?: MorphP5;
  /** Pass-6: complexity profile and body counts (src/genome/complexity.ts). Absent = derive / pass-5 look. */
  p6?: import("./p6Types.ts").MorphP6;
  /** Pass-7: Pareto-shaped extra operators, relief, horns, spikes, motion and fx genes (src/genome/p7Types.ts). Absent = P7_DEFAULTS. */
  p7?: import("./p7Types.ts").MorphP7;
}

// ====================================================================== PASS 5 CONTRACT (types only)
/**
 * Pass-5 morph genes [P5-V*]. Optional on MorphHelix (`p5`) so legacy helices and every consumer keep
 * working: consumers read `helix.p5 ?? P5_DEFAULTS`. Producer: src/genome/helix.ts (lane helix-face).
 */

/** Eye outline drawn on the sclera shell (not every eye is a circle). */
export type EyeShape = "round" | "almond" | "tear" | "crescent" | "hooded" | "diamond" | "oval";
/** How several eyes are laid out on the head. */
export type EyeLayout = "pair" | "cyclops" | "row" | "arc" | "cluster" | "stacked";
export interface EyeP5 {
  shape: EyeShape;
  layout: EyeLayout;
  /** 1 .. 8 eyes (1 = cyclops; 2 by far the most common; 3+ rare and recessive). Overrides EyeGenes.count. */
  count: number;
  /** Vertical placement on the head, -1 (low, cheek) .. +1 (top of the skull). */
  height: number;
  /** Lateral spread 0 (close together, forward-facing predator) .. 1 (wide, side-facing prey). */
  spread: number;
  /** Yaw of each eye away from forward, radians (0 forward .. ~1.3 side). Drives field of view. */
  yaw: number;
  /** Outline tilt, radians (+ outer corner up). */
  tilt: number;
  /** How deep the eye sits in a socket carved into the head 0 (bulging) .. 1 (deep-set). */
  socketDepth: number;
  /** Per-axis eyeball scale (x wide, y tall, z bulge) around 1. */
  scale: [number, number, number];
  /** Brow ridge 0..1 (overhang over the socket). */
  brow: number;
}
export type BeakKind = "none" | "round" | "hooked" | "flat" | "needle" | "shovel";
export interface MouthP5 {
  beak: BeakKind;
  /** Beak length as a share of the head length (0 .. 0.9). */
  beakLength: number;
  /** Beak roundness 0 (sharp cone) .. 1 (blunt ball, parrot / duck). */
  beakRound: number;
  /** Mouth scale per axis (x width, y gape height, z depth into the head) around 1. */
  scale: [number, number, number];
  /** Mouth vertical position on the head -1 .. 1 (0 = default). */
  height: number;
  /** Tongue length as a share of the head length (0 = no tongue .. 1.2 chameleon). */
  tongueLength: number;
  /** Forked tongue (snakes, lizards). */
  tongueFork: boolean;
  /** Lip / snout curve: -1 frown .. +1 smile. */
  lipCurve: number;
}
/** A morphogenetic OPERATOR applied after growth (grow, then carve / merge / squash the forms). */
/**
 * Pass 5: carve, merge, compress, decompress, difference, twist, bulge, pinch.
 * Pass 7 [P7-G1]: ridge (sharp crest), flute (several grooves around the section), facet (flat planes),
 * scallop (radius ripple along the region), segment (annular bands), knob (local boss), spiral (a crest
 * whose angle winds along the region). Consumers that do not know a kind ignore it.
 */
export type MorphOpKind =
  | "carve"
  | "merge"
  | "compress"
  | "decompress"
  | "difference"
  | "twist"
  | "bulge"
  | "pinch"
  | "ridge"
  | "flute"
  | "facet"
  | "scallop"
  | "segment"
  | "knob"
  | "spiral";
export type MorphRegion = "torso" | "neck" | "head" | "tail" | "limb" | "all";
export interface MorphOp {
  kind: MorphOpKind;
  region: MorphRegion;
  /** Station along the region 0 (root) .. 1 (tip). */
  u: number;
  /** Signed strength (-1 .. 1); carve/difference remove, merge/bulge add, compress/decompress scale. */
  amount: number;
  /** Falloff width along the region 0..1. */
  width: number;
  /** Angle around the section, radians, loft frame (0 = +x lateral, PI/2 = dorsal, -PI/2 = ventral). */
  angle: number;
}
/** Growth envelope of the skeleton nodes: min and max per node, bounded like every helix trait. */
export interface GrowthGenes {
  /** Node (bone) length multiplier band. */
  length: GenePair;
  /** Node strength (section radius) multiplier band. */
  strength: GenePair;
  /** Node bend angle band, radians. */
  angle: GenePair;
  /** Fetal spiral turns of the curled embryo (0.6 .. 1.6 turns). */
  spiral: number;
  /** Neoteny 0..1: how long baby features (big head, big eyes, short limbs) persist. */
  neoteny: number;
}
export type LimbStyle = "legs" | "tentacles" | "fins" | "stumps";
export type TailShape = "taper" | "club" | "fin" | "fan" | "spade" | "whip" | "flame" | "leaf" | "rattle" | "split";
export type CoatKind = "skin" | "fur" | "scales" | "feathers" | "leaves" | "chitin" | "slime" | "bark" | "crystal";
export interface BodyP5 {
  /** Shoulder width / height / hump around 1. */
  shoulder: { width: number; height: number; hump: number };
  tail: { shape: TailShape; length: number; curl: number; tipSize: number };
  /** Fractal limb development: depth 0..4, branch count, length ratio per level, twist (radians). */
  armFractal: { depth: number; branch: number; ratio: number; twist: number; mode: "none" | "branch" | "spiral" | "mandelbrot" };
  limbStyle: LimbStyle;
  /** Extra leg pairs on a serpent (0 = none; snakes that can rear up on legs). */
  serpentLegs: number;
  /** Symmetric by default; each limb pair may drift from its "goal" by this much (0 .. 0.25). */
  limbVariation: number;
  /** Element-driven curvature: + curvy / flowing (water, air), - angular / faceted (rock, metal). */
  curvature: number;
  ops: MorphOp[];
}
export interface SkinP5 {
  coat: CoatKind;
  /** Belly / back contrast 0 (same) .. 1 (strongly countershaded, its own texture). */
  bellyContrast: number;
  /** Frills / crests 0..1. */
  frills: number;
  /** Stripes overlay strength 0..1 (on top of the base pattern). */
  stripes: number;
  /** Cel-shading bands 2..5 (fewer = flatter toon look). */
  celBands: number;
  /** Ink outline width 0..1. */
  outline: number;
  /** Overlay layer count 0..3 (spots over stripes over mottle...). */
  overlays: number;
}
export interface MorphP5 {
  version: 5;
  eyes: EyeP5;
  mouth: MouthP5;
  growth: GrowthGenes;
  body: BodyP5;
  skin: SkinP5;
}

/** Fallback for helices without pass-5 genes (legacy and unit fixtures). */
export const P5_DEFAULTS: MorphP5 = {
  version: 5,
  eyes: { shape: "round", layout: "pair", count: 2, height: 0.2, spread: 0.5, yaw: 0.35, tilt: 0, socketDepth: 0.35, scale: [1, 1, 1], brow: 0.2 },
  mouth: { beak: "none", beakLength: 0, beakRound: 0.5, scale: [1, 1, 1], height: 0, tongueLength: 0.3, tongueFork: false, lipCurve: 0 },
  growth: { length: { lo: 0.9, hi: 1.1 }, strength: { lo: 0.9, hi: 1.1 }, angle: { lo: -0.1, hi: 0.1 }, spiral: 1, neoteny: 0.3 },
  body: {
    shoulder: { width: 1, height: 1, hump: 0 },
    tail: { shape: "taper", length: 1, curl: 0, tipSize: 1 },
    armFractal: { depth: 0, branch: 2, ratio: 0.6, twist: 0, mode: "none" },
    limbStyle: "legs",
    serpentLegs: 0,
    limbVariation: 0,
    curvature: 0,
    ops: [],
  },
  skin: { coat: "skin", bellyContrast: 0.5, frills: 0, stripes: 0, celBands: 3, outline: 0.3, overlays: 1 },
};
