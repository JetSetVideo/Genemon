/**
 * SENSES [P5-G1, P5-G2]: ten perception channels DERIVED from the body the genome built (eyes, ears,
 * snout, tongue, fur, glow, element affinities, body plan). Pure: no DOM, no clock, no randomness.
 *
 * Budget-neutral [SPEC B1]: the raw organ scores are normalised so the acuities always sum to
 * SENSE_BUDGET (scars and age only REMOVE acuity). A creature specialises, it never perceives more
 * overall. Double-edged [P5-G2]: the same organ RESONATES with effects travelling through it, so the
 * incoming multiplier of a channel grows with its acuity (big ears hear far AND take more from a roar).
 *
 * Yaw convention (src/world/physics.ts Body.yaw, battle.ts): yaw = atan2(dx, dz), 0 = facing +z.
 */
import { angleDiff, clamp, clamp01, u01 } from "../core/math.ts";
import type { Move } from "../combat/moves.ts";
import type { MorphHelix } from "./morphTypes.ts";
import { P5_DEFAULTS } from "./morphTypes.ts";
import type { Phenotype } from "./phenotype.ts";
import { type LifeState, SENSE_BUDGET, SENSE_IDS, type SenseId, type SenseProfile } from "./lifeTypes.ts";

/** Mean acuity per sense (SENSE_BUDGET / 10): acuity at the mean = neutral resonance 1. */
export const SENSE_MEAN = SENSE_BUDGET / SENSE_IDS.length;
export const RESONANCE_MIN = 0.7;
export const RESONANCE_MAX = 1.45;
/** Resonance slope: resonance = 1 + RESONANCE_K * (acuity / mean - 1), clamped to [0.7, 1.45]. */
export const RESONANCE_K = 0.45;

const KIND_VIBRATION: Record<Phenotype["kind"], number> = {
  serpent: 0.55,
  hexapod: 0.35,
  blob: 0.3,
  quadruped: 0.15,
  biped: 0.08,
  avian: 0.03,
};

function zeroSenses(): Record<SenseId, number> {
  return Object.fromEntries(SENSE_IDS.map((s) => [s, 0])) as Record<SenseId, number>;
}

/** Resonance (incoming multiplier) of a channel with this acuity. Monotone in acuity. */
export function resonanceOf(acuity: number): number {
  return clamp(1 + RESONANCE_K * (acuity / SENSE_MEAN - 1), RESONANCE_MIN, RESONANCE_MAX);
}

/** Raw (unnormalised) organ scores and their organ labels. Exported for the sheet ("why this sense"). */
export function rawSenses(
  ph: Phenotype,
  helix: MorphHelix,
): { raw: Record<SenseId, number>; organ: Record<SenseId, string> } {
  const p5 = helix.p5 ?? P5_DEFAULTS;
  const a = ph.axes, aff = ph.elements.affinity, plan = ph.plan;
  const eyeCount = clamp(Math.round(p5.eyes.count || helix.eyes.count || 2), 1, 8);
  const eyeSize = clamp(helix.eyes.size, 0.12, 0.45);
  const sizeK = eyeSize / 0.28;
  const tongue = clamp(p5.mouth.tongueLength, 0, 1.2) *
    (helix.mouth.tongue || p5.mouth.tongueLength > 0 ? 1 : 0);
  const fork = p5.mouth.tongueFork;
  const beak = p5.mouth.beak !== "none";
  const fur = clamp01(helix.surface.fur);
  const pos = (v: number) => Math.max(0, v);
  const raw = zeroSenses();
  // Eyes: size gives range, count gives coverage (diminishing), light affinity sees in the dark.
  raw.vision = 0.42 * Math.pow(sizeK, 0.8) * (1 + 0.14 * Math.log2(eyeCount)) + 0.06 * pos(a.luminance);
  // Ears: the plan gene (0..1).
  raw.hearing = 0.08 + 0.62 * plan.ears;
  // Snout / jaw, plus the forked tongue that "tastes the air" (snakes); beaks smell poorly.
  raw.smell =
    (0.1 + 0.3 * plan.jaw + (fork ? 0.25 * tongue + 0.08 : 0) + (ph.kind === "quadruped" ? 0.08 : 0)) *
    (beak ? 0.6 : 1);
  // Skin, fur, whiskers: soft skin and fur feel more; blobs are all skin.
  raw.touch = 0.1 + 0.35 * fur + 0.15 * (1 - u01(a.hardness)) + (ph.kind === "blob" ? 0.2 : 0);
  // Tongue length and appetite.
  raw.taste = 0.06 + 0.3 * tongue + 0.12 * u01(a.appetite);
  // Heat pits / glow organs: fire affinity and glow; serpents carry pits.
  raw.thermal = 0.04 + 0.45 * pos(aff.fire) + 0.25 * ph.glow + 0.12 * pos(a.heat) +
    (ph.kind === "serpent" ? 0.12 : 0);
  // Metal bodies read fields; conductivity too.
  raw.magnet = 0.03 + 0.55 * pos(aff.metal) + 0.2 * pos(a.conductivity);
  // Electroreception: electric bodies and water dwellers.
  raw.electro = 0.03 + 0.5 * pos(aff.electric) + 0.22 * pos(aff.water);
  // Mind: psychic affinity and wisdom.
  raw.psychic = 0.03 + 0.55 * pos(aff.psychic) + 0.22 * pos(a.wisdom);
  // Belly / feet contact: serpents, hexapods, burrowers, serpent legs.
  raw.vibration = 0.05 + KIND_VIBRATION[ph.kind] + 0.2 * pos(-a.altitude) +
    0.04 * clamp(p5.body.serpentLegs, 0, 4);
  for (const s of SENSE_IDS) raw[s] = Math.max(0.01, raw[s]);
  const n2 = (v: number) => v.toFixed(2);
  const organ: Record<SenseId, string> = {
    vision: `${eyeCount} eye${eyeCount > 1 ? "s" : ""}, size ${n2(sizeK)}x, yaw ${n2(p5.eyes.yaw)} rad`,
    hearing: `ears ${n2(plan.ears)}`,
    smell: fork
      ? `forked tongue + snout (jaw ${n2(plan.jaw)})`
      : beak
      ? `beak nostrils (jaw ${n2(plan.jaw)})`
      : `snout (jaw ${n2(plan.jaw)})`,
    touch: ph.kind === "blob" ? "whole-body skin" : `skin, fur ${n2(fur)}`,
    taste: tongue > 0 ? `tongue ${n2(tongue)}` : "palate (no tongue)",
    thermal: ph.kind === "serpent"
      ? "heat pits"
      : ph.glow > 0.3
      ? `glow organs ${n2(ph.glow)}`
      : `skin warmth`,
    magnet: aff.metal > 0.2 ? `metal body (${n2(aff.metal)})` : `conductivity ${n2(a.conductivity)}`,
    electro: aff.electric > 0.2
      ? `charged body (${n2(aff.electric)})`
      : aff.water > 0.2
      ? `wet skin pores (${n2(aff.water)})`
      : "faint",
    psychic: aff.psychic > 0.2 ? `mind (${n2(aff.psychic)})` : `wisdom ${n2(a.wisdom)}`,
    vibration: ph.kind === "serpent"
      ? "belly on the ground"
      : ph.kind === "hexapod"
      ? "six feet"
      : a.altitude < -0.3
      ? "burrower's paws"
      : "feet",
  };
  return { raw, organ };
}

/** Scar on the head / eyes dims vision; on ears dims hearing; age is applied by the caller via life. */
function lifeLoss(life: LifeState | undefined): Partial<Record<SenseId, number>> {
  const out: Partial<Record<SenseId, number>> = {};
  if (!life) return out;
  for (const s of life.scars) {
    const p = s.part.toLowerCase();
    const sev = clamp01(s.severity);
    if (p.includes("eye") || p === "head") out.vision = (out.vision ?? 0) + 0.12 * sev;
    if (p.includes("ear") || p === "head") out.hearing = (out.hearing ?? 0) + 0.06 * sev;
    if (p.includes("snout") || p.includes("jaw")) out.smell = (out.smell ?? 0) + 0.1 * sev;
  }
  return out;
}

/** Sense imprints bend the RAW score (before normalisation), so they stay budget-neutral. */
function imprintBend(life: LifeState | undefined): Partial<Record<SenseId, number>> {
  const out: Partial<Record<SenseId, number>> = {};
  if (!life) return out;
  for (const im of life.imprints) {
    if ((SENSE_IDS as readonly string[]).includes(im.trait)) {
      const s = im.trait as SenseId;
      out[s] = (out[s] ?? 0) + 0.25 * clamp(im.strength, -1, 1);
    }
  }
  return out;
}

export function sensesOf(ph: Phenotype, helix: MorphHelix, life?: LifeState): SenseProfile {
  const { raw, organ } = rawSenses(ph, helix);
  const bend = imprintBend(life);
  for (const s of SENSE_IDS) raw[s] = Math.max(0.01, raw[s] * (1 + (bend[s] ?? 0)));
  const total = SENSE_IDS.reduce((t, s) => t + raw[s], 0);
  const loss = lifeLoss(life);
  const acuity = zeroSenses();
  const resonance = zeroSenses();
  for (const s of SENSE_IDS) {
    acuity[s] = (raw[s] / total) * SENSE_BUDGET * (1 - clamp(loss[s] ?? 0, 0, 0.6));
    // A scarred organ still resonates as it was built (the ear is big, it just hears worse).
    resonance[s] = resonanceOf((raw[s] / total) * SENSE_BUDGET);
  }
  const p5 = helix.p5 ?? P5_DEFAULTS;
  const eyeCount = clamp(Math.round(p5.eyes.count || helix.eyes.count || 2), 1, 8);
  const sizeK = clamp(helix.eyes.size, 0.12, 0.45) / 0.28;
  const yaw = clamp(p5.eyes.yaw, 0, 1.4), spread = clamp01(p5.eyes.spread);
  // Field of view: forward eyes ~66 deg half-angle; side-facing / many eyes approach all-around.
  const fovHalf = clamp(0.55 + 0.95 * yaw + 0.45 * spread + 0.12 * (eyeCount - 2), 0.35, Math.PI);
  // Range: bigger eyes see farther, forward (binocular) eyes farther than wide-set ones.
  const visionRange = clamp(
    6 + 12 * (acuity.vision / SENSE_MEAN) * Math.sqrt(sizeK) * (1 - 0.2 * spread),
    3,
    45,
  );
  const hearingRange = clamp(2 + 8 * (acuity.hearing / SENSE_MEAN), 1.5, 30);
  return { acuity, resonance, visionRange, fovHalf, hearingRange, organ };
}

// ------------------------------------------------------------------ move channels
const SOUND = /roar|howl|screech|sonic|shriek|song|clap|boom|scream/;
const LIGHT = /flash|dazzle|blind|gaze|prism|photon|radiant|solar beam|supernova|glare/;
const MIND = /mind|psi|psy|confus|dread|fear|telekin|calm/;
const MAGNET = /magnet|iron|steel|shrapnel|metal/;
const GROUND = /quake|stomp|tremor|burrow|earthshatter/;
const GAS = /spore|miasma|gas|plague|stench|mist|smell|cloud|acid/;
const HEAT = /heat|flame|ember|scorch|burn|inferno|cinder|frost|cryo|ice|snow|hail|meteor|avalanche/;

/**
 * Which sense an incoming move's effect travels through (null = none: it just hits the body).
 * Order matters: a roar is sound before it is fear; a thunder clap is sound before electricity.
 */
export function channelOfMove(m: Move): SenseId | null {
  const n = `${m.name} ${m.id}`.toLowerCase();
  const fx = new Set(m.effects.filter((e) => e.kind === "status" && !e.self).map((e) => e.status));
  const contact = m.tags.includes("contact") || m.shape === "melee" || m.shape === "dash";
  if (SOUND.test(n) || m.tags.includes("sound")) return "hearing";
  if (m.element === "light" || LIGHT.test(n) || fx.has("blinded")) return "vision";
  if (m.element === "psychic" || MIND.test(n) || fx.has("confused") || fx.has("feared")) return "psychic";
  if (m.element === "electric") return "electro";
  if (m.element === "metal" || MAGNET.test(n)) return "magnet";
  if (m.tags.includes("ground") || m.shape === "dig" || m.shape === "terrain" || GROUND.test(n)) {
    return "vibration";
  }
  if (m.element === "poison") {
    if (
      m.shape === "zone" || m.shape === "burst" || m.shape === "cone" || m.shape === "weather" || GAS.test(n)
    ) return "smell";
    return contact ? "touch" : "taste";
  }
  if (GAS.test(n)) return "smell";
  if (m.element === "fire" || m.element === "ice" || HEAT.test(n)) return "thermal";
  if (contact) return "touch";
  return null;
}

/** Incoming multiplier for an effect through channel `ch` (1 when the move uses no sense). */
export function resonanceMult(target: SenseProfile, ch: SenseId | null): number {
  if (ch === null) return 1;
  const r = target.resonance[ch];
  return Number.isFinite(r) ? clamp(r, RESONANCE_MIN, RESONANCE_MAX) : 1;
}

/**
 * Share of the resonance applied to DIRECT DAMAGE in battle. Measured over 300 creatures x 141 moves:
 * per-hit resonance has sd 0.22 with heavy mass at the 0.7 / 1.45 clamps, while each creature's mean
 * exposure stays 0.92 .. 1.10; at full weight the batch dominance test lost its signal, at 0.5 it holds.
 * Launch value; re-tune with `deno task balance N`.
 */
export const SENSE_DAMAGE_WEIGHT = 0.5;
/** Damage multiplier of move `m` on a target with these senses: 1 + weight x (resonance - 1). */
export function senseDamageMult(target: SenseProfile, m: Move, weight = SENSE_DAMAGE_WEIGHT): number {
  return 1 + weight * (resonanceMult(target, channelOfMove(m)) - 1);
}

// ------------------------------------------------------------------ perception [P5-B2]
export interface Perception {
  seen: boolean;
  heard: boolean;
  /** 0 (unaware) .. 1 (fully aware: seen up close). */
  awareness: number;
}

/**
 * Does `observer` perceive `target`? Seen = inside visionRange AND inside the field of view around
 * its yaw (yaw = atan2(dx, dz), the physics convention). Heard = inside hearingRange x targetNoise
 * (1 = normal, 0 = silent, 2 = roaring), in every direction. Smell / vibration give a faint close
 * awareness even behind and in silence.
 */
export function perceive(
  observer: { x: number; z: number; yaw: number },
  senses: SenseProfile,
  target: { x: number; z: number },
  targetNoise = 1,
): Perception {
  const dx = target.x - observer.x, dz = target.z - observer.z;
  const d = Math.hypot(dx, dz);
  const off = d < 1e-6 ? 0 : Math.abs(angleDiff(observer.yaw, Math.atan2(dx, dz)));
  const seen = d <= senses.visionRange && off <= senses.fovHalf;
  const hr = senses.hearingRange * clamp(targetNoise, 0, 3);
  const heard = hr > 0 && d <= hr;
  const near = 1.5 * (senses.acuity.smell + senses.acuity.vibration) / SENSE_MEAN;
  let awareness = 0;
  if (seen) awareness = Math.max(awareness, 0.6 + 0.4 * (1 - d / Math.max(1e-6, senses.visionRange)));
  if (heard) awareness = Math.max(awareness, 0.3 + 0.35 * (1 - d / Math.max(1e-6, hr)));
  if (d <= near) awareness = Math.max(awareness, 0.2 * (1 - d / Math.max(1e-6, near)) + 0.1);
  return { seen, heard, awareness: clamp01(awareness) };
}
