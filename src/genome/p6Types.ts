/**
 * Pass-6 CONTRACT (types only, no logic): complexity and rarity (from the minimal globe to the colossal
 * chimera), structural tendencies (NATURE) bent by activities (NURTURE), evolution plans (1-6 phases,
 * metamorphosis, molts, XP curves, fertility windows), the primary / secondary / tertiary palette, and the
 * ranked leagues (Prime vs Eternal).
 *
 * Read with `docs/team/PASS6-BRIEF.md`. Producers and the EXACT API they export:
 *
 *   src/genome/complexity.ts   (lane genome-nature)
 *     complexityOf(g: Genome): ComplexityProfile                // deterministic from the genome alone (nature)
 *     COMPLEXITY_TIERS: readonly ComplexityTier[]               // ordered minimal .. mythic
 *     tierOdds(): Record<ComplexityTier, number>                // expected share of wild genomes per tier
 *   src/genome/structure.ts    (lane genome-nature)
 *     ATTRACTORS: readonly AttractorDef[]                       // the body-plan tendencies
 *     natureOf(g: Genome): Record<AttractorId, number>          // genetic weights, sum 1
 *     nurtureOf(g: Genome, c: Conditions): NurtureState         // weights + trait shifts after life (capped)
 *   src/genome/evolution.ts    (lane evolution)
 *     evolutionPlanOf(g: Genome): EvolutionPlan                 // nature: how this lineage evolves
 *     phaseOf(plan: EvolutionPlan, level: number, ageDays: number, c: Conditions): EvoState
 *     levelCurve(plan: EvolutionPlan): { xpForLevel(level: number): number; levelOf(xp: number): number }
 *     fertileNow(plan: EvolutionPlan, phase: number, ageDays: number): { fertile: boolean; why: string; nextWindowDay: number | null }
 *   src/genome/palette.ts      (lane colour)
 *     palette3Of(g: Genome, axes: AxisVector, primary: ElementId, secondary: ElementId | null): Palette3
 *     harmonyScore(p: Palette3): number                          // 0..1 compatibility of the three colours
 *   src/ladder/leagues.ts      (lane leagues)
 *     LEAGUES: Record<LeagueId, LeagueDef>
 *     eligibility(league: LeagueId, g: Genemon, now: number): { ok: boolean; why: string }
 *
 * Consumers read optional fields with fallbacks: `helix.p6 ?? null`, `ph.evo ?? null`, `ph.nurture ?? null`,
 * `ph.palette3 ?? null`, so every pass-5 save and fixture keeps working.
 */
import type { ElementId } from "../data/elements.ts";

// ------------------------------------------------------------------ complexity & rarity
/**
 * minimal  = a GLOBE: one round body, one eye, two colours, no limbs (the simplest Genemon).
 * mythic   = a COLOSSUS: XXL (6 slots), several tentacle branches, several wing pairs, several arm pairs with
 *            many fingers, two mouths, 6-8 complex eyes; almost impossible to get.
 */
export type ComplexityTier = "minimal" | "simple" | "common" | "complex" | "elaborate" | "mythic";
export interface BodyCounts {
  /** 1 .. 8 */
  eyes: number;
  /** 1 .. 2 */
  mouths: number;
  /** 1 .. 2 (a second head is mythic-only) */
  heads: number;
  /** 0 .. 3 */
  wingPairs: number;
  /** Fore-limb pairs used as ARMS (hands, fingers), 0 .. 3 */
  armPairs: number;
  /** Ground legs pairs, 0 .. 4 (0 = globe / serpent / cephalopod) */
  legPairs: number;
  /** 0 .. 12 tentacle branches */
  tentacles: number;
  /** Fingers per hand, 0 .. 7 */
  fingers: number;
  /** 0 .. 3 */
  tails: number;
}
export interface ComplexityProfile {
  /** 0 (globe) .. 1 (colossus). */
  score: number;
  tier: ComplexityTier;
  /** "1 in N wild genomes" for this tier (UI + rarity of drops). */
  oneIn: number;
  counts: BodyCounts;
  /** XXL colossus (mythic tier only, and not every mythic). */
  colossal: boolean;
  /** Number of palette colours actually used (minimal = 2). */
  colors: 2 | 3;
}

// ------------------------------------------------------------------ nature (structure) & nurture (life)
/** Body-plan tendencies the DNA leans toward; a genome is a weighted mix (most have one dominant). */
export type AttractorId =
  | "globe" // round body, no limbs
  | "quadruped"
  | "biped"
  | "avian"
  | "serpent"
  | "hexapod" // insect / arachnid
  | "cephalopod" // octopus-like, tentacles
  | "larval" // grub / caterpillar (metamorphosis lineages)
  | "armored" // shell, plates (molting lineages)
  | "chimera"; // a mix of everything (rare)
export interface AttractorDef {
  id: AttractorId;
  /** Trait targets this tendency pulls toward (trait id -> target multiplier around 1, or count). */
  pulls: Partial<Record<NurtureTrait, number>>;
  /** Which activities strengthen it (experience / food / ground ids from src/data/lifestyle.ts, grounds.ts). */
  fedBy: string[];
}
/** Body traits that life can fine-tune (bounded: nurture bends nature, never replaces it). */
export type NurtureTrait =
  | "neckLength"
  | "legLength"
  | "armSize"
  | "shoulderWidth"
  | "wingSpan"
  | "tailLength"
  | "armor"
  | "finSize"
  | "girth"
  | "hornSize"
  | "eyeSize"
  | "furDensity";
export interface NurtureState {
  /** Attractor weights after life (sum 1). */
  weights: Record<AttractorId, number>;
  /** Multiplicative trait shifts from life, each within [1 - NURTURE_CAP, 1 + NURTURE_CAP]. */
  shift: Partial<Record<NurtureTrait, number>>;
  /** Plain-language reasons ("swimming 40 h -> fins +12 %"), most important first. */
  reasons: string[];
}
export const NURTURE_CAP = 0.35;

// ------------------------------------------------------------------ evolution plans
/**
 * static        = one phase, never changes form (but still levels up)
 * gradual       = grows through 2-6 phases, each bigger, unlocking parts (longer neck, bigger wings, arms...)
 * metamorphosis = larva -> cocoon -> imago (butterfly-like): the form changes completely
 * molt          = sheds its armour / shell at a phase (loses defence, gains speed, regrows)
 */
export type EvolutionKind = "static" | "gradual" | "metamorphosis" | "molt";
export type PhaseForm = "egg" | "larva" | "cocoon" | "imago" | "juvenile" | "adult" | "prime" | "elder" | "molting";
export type MorphUnlock = "neck+" | "wings+" | "wingPair+" | "arms+" | "armPair+" | "fingers+" | "tail+" | "horns+" | "armor+" | "armorShed" | "eyes+" | "mouth+" | "tentacles+" | "size+";
export interface PhaseDef {
  /** 1-based. */
  index: number;
  name: string;
  form: PhaseForm;
  /** Reached at this level AND age (both). */
  atLevel: number;
  atAgeDays: number;
  /** Height multiplier vs the lineage's adult size (most lineages grow: monotone except metamorphosis). */
  sizeMult: number;
  unlocks: MorphUnlock[];
  /** Can breed during this phase (inside the plan's fertility cycle). */
  fertile: boolean;
}
export interface EvolutionPlan {
  kind: EvolutionKind;
  /** 1 .. 6 phases; the distribution has median 3 with a spread (static ~12 %, 6 phases rare). */
  phases: PhaseDef[];
  /** XP curve: "long" = few long levels (long XP bar), "short" = many short levels. */
  curve: "short" | "normal" | "long";
  /** XP multiplier per level vs the global curve (short < 1 < long). */
  xpMult: number;
  /** Max level reachable (short curves go higher). */
  maxLevel: number;
  /** Fertility cycle: fertile for `fertileDays` every `cycleDays` while in a fertile phase. */
  fertility: { cycleDays: number; fertileDays: number; offsetDays: number };
}
/** The expressed evolution state of an individual (on the phenotype as `ph.evo`). */
export interface EvoState {
  phase: number;
  phases: number;
  form: PhaseForm;
  name: string;
  kind: EvolutionKind;
  /** Cumulative unlocks up to this phase (renderers read these). */
  unlocks: MorphUnlock[];
  /** Height multiplier of the current phase. */
  sizeMult: number;
  /** Progress to the next phase 0..1 (1 at the last phase). */
  progress: number;
  /** Level within the lineage's curve, and XP needed for the next level. */
  level: number;
  xpToNext: number;
}

// ------------------------------------------------------------------ colour
/** Colour roles: primary (body), secondary (accent / markings), tertiary (details: eyes rim, claws, glow). */
export type HarmonyScheme = "mono" | "analogous" | "complementary" | "split" | "triad" | "tetrad";
export interface Palette3 {
  primary: number;
  secondary: number;
  tertiary: number;
  scheme: HarmonyScheme;
  /** 0..1 compatibility of the three colours (harmonyScore). */
  harmony: number;
  /** Which body parts get which role (renderers obey this). */
  attribution: Partial<Record<"body" | "belly" | "back" | "markings" | "limbs" | "head" | "wings" | "tail" | "horns" | "eyes" | "glow", "primary" | "secondary" | "tertiary">>;
  /** Element that dictates the primary hue (colour code is sacred). */
  element: ElementId;
}

// ------------------------------------------------------------------ helix extension
export interface MorphP6 {
  version: 6;
  complexity: ComplexityProfile;
}

// ------------------------------------------------------------------ ranked leagues
/**
 * prime   = the main ranked league: level cap, no elders past their prime, no colossus above the slot rules.
 * eternal = every Genemon allowed (elders, ancients, colossi), its own ladder and rating.
 */
export type LeagueId = "prime" | "eternal";
export interface LeagueDef {
  id: LeagueId;
  name: string;
  blurb: string;
  /** Max level for each fighter (null = none). */
  levelCap: number | null;
  /** Life phases refused (lifeclock phases). */
  refusedPhases: string[];
  /** Ladder key used for the rating (separate MMR per league). */
  ladderKey: string;
}
