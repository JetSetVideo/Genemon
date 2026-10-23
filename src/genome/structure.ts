/**
 * Nature and nurture intertwined [P6-N1]. The DNA leans toward body-plan STRUCTURES (attractors: globe,
 * quadruped, biped, avian, serpent, hexapod, cephalopod, larval, armoured, chimera); a life of activities,
 * foods, habitats and fights fine-tunes the body (swimming -> fins, gym -> arms and shoulders, flight time ->
 * wings, kilometres -> legs, fights -> armour and horns), CAPPED so nurture bends nature, never replaces it.
 *
 *   natureOf(g)      genetic attractor weights (sum 1), one dominant, consistent with the body kind
 *   nurtureOf(g, c)  weights after life + multiplicative trait shifts + plain-language reasons
 *
 * THE NURTURE EQUATIONS
 *
 *   pressure[a]   = sum over a's fedBy sources of units(source) x UNIT_W[source type]
 *   weight'[a]    = nature[a] x (1 + NURTURE_CAP x tanh(pressure[a]))        then renormalised to sum 1
 *   raw[t]        = sum over sources of units x TRAIT_FEED[source][t] x aptitude[t]
 *   aptitude[t]   = 0.5 + sum over attractors of nature[a] x (pulls[a][t] > 1 ? 1 : pulls[a][t] < 1 ? 0.25 : 0.5)
 *   shift[t]      = 1 + NURTURE_CAP x tanh(raw[t] / NURTURE_CAP)            in [1 - CAP, 1 + CAP]
 *
 * A body built for a trait (nature) takes the training better (aptitude); the tanh saturates every trait.
 * Units: experiences and foods = counts recorded in Conditions; grounds = hours; battles = fights / KOs.
 * Pure module.
 */
import type { Genome } from "./genome.ts";
import type { Conditions } from "./epigenetics.ts";
import { type AttractorDef, type AttractorId, NURTURE_CAP, type NurtureState, type NurtureTrait } from "./p6Types.ts";
import { EXPERIENCES, type ExperienceId, FOODS, type FoodId } from "../data/lifestyle.ts";
import { type GroundId, GROUNDS } from "../data/grounds.ts";
import { clamp01 } from "../core/math.ts";
import { complexityOf } from "./complexity.ts";

export { NURTURE_CAP };

/** Pseudo-source ids for fights (read from Conditions.battles). */
export const BATTLE_SOURCES = ["battles", "kos"] as const;

/** The ten body-plan tendencies; `fedBy` lists REAL experience / food / ground ids (+ "battles", "kos"). */
export const ATTRACTORS: readonly AttractorDef[] = [
  { id: "globe", pulls: { girth: 1.3, legLength: 0.6, neckLength: 0.6, tailLength: 0.5 }, fedBy: ["meditation", "petting", "music", "candy", "honey", "iceCream", "mud"] },
  { id: "quadruped", pulls: { legLength: 1.1, shoulderWidth: 1.1, tailLength: 1.1, neckLength: 1.05 }, fedBy: ["travelKm", "digging", "meat", "grass", "soil", "sand"] },
  { id: "biped", pulls: { armSize: 1.2, shoulderWidth: 1.2, legLength: 1.05 }, fedBy: ["gymTraining", "climbing", "puzzle", "questDone", "rescue"] },
  { id: "avian", pulls: { wingSpan: 1.3, legLength: 0.9, girth: 0.85, furDensity: 1.1 }, fedBy: ["flightTime", "climbing", "sunbathing", "cloudPuff", "berries"] },
  { id: "serpent", pulls: { tailLength: 1.35, neckLength: 1.2, legLength: 0.6, girth: 0.9 }, fedBy: ["swimming", "nightWalk", "sand", "mud", "fish"] },
  { id: "hexapod", pulls: { legLength: 1.15, armor: 1.15, eyeSize: 1.2 }, fedBy: ["digging", "puzzle", "honey", "soil", "gravel", "moss"] },
  { id: "cephalopod", pulls: { finSize: 1.3, armSize: 1.15, eyeSize: 1.2, legLength: 0.7 }, fedBy: ["swimming", "fish", "seaweed", "springWater", "water", "deepWater", "muddyWater"] },
  { id: "larval", pulls: { girth: 1.2, legLength: 0.7, neckLength: 0.8, armor: 0.9 }, fedBy: ["greens", "berries", "seedCake", "mushroom", "moss", "grass"] },
  { id: "armored", pulls: { armor: 1.35, hornSize: 1.25, girth: 1.1, shoulderWidth: 1.1 }, fedBy: ["battles", "kos", "minerals", "ironNut", "stoneBread", "stone", "gravel", "metal"] },
  { id: "chimera", pulls: { hornSize: 1.15, wingSpan: 1.1, armSize: 1.1, tailLength: 1.1 }, fedBy: ["voidSalt", "mindLeaf", "glowFruit", "rescue", "crystal", "lava"] },
];
export const ATTRACTOR_IDS: readonly AttractorId[] = ATTRACTORS.map((a) => a.id);
const BY_ID = Object.fromEntries(ATTRACTORS.map((a) => [a.id, a])) as Record<AttractorId, AttractorDef>;

/** Per-unit trait response of each life source (raw, before aptitude and saturation). */
const TRAIT_FEED: Record<string, Partial<Record<NurtureTrait, number>>> = {
  // experiences (per session / unit)
  swimming: { finSize: 0.006, tailLength: 0.002, furDensity: -0.002 },
  gymTraining: { armSize: 0.006, shoulderWidth: 0.005, girth: 0.002 },
  climbing: { armSize: 0.003, legLength: 0.002, wingSpan: 0.001 },
  flightTime: { wingSpan: 0.006, girth: -0.002, legLength: -0.001 },
  travelKm: { legLength: 0.004, girth: -0.002 },
  digging: { armSize: 0.003, armor: 0.002, eyeSize: -0.002 },
  nightWalk: { eyeSize: 0.004 },
  sunbathing: { furDensity: -0.002 },
  meditation: { neckLength: 0.002, girth: 0.001 },
  puzzle: { eyeSize: 0.001 },
  socialPlay: { furDensity: 0.001 },
  petting: { furDensity: 0.002 },
  // foods (per unit eaten)
  meat: { girth: 0.003, hornSize: 0.002, armSize: 0.001 },
  fish: { finSize: 0.003 },
  seaweed: { finSize: 0.002 },
  springWater: { finSize: 0.002 },
  minerals: { armor: 0.004, hornSize: 0.002 },
  ironNut: { armor: 0.008, hornSize: 0.004 },
  stoneBread: { armor: 0.005, girth: 0.004 },
  cloudPuff: { wingSpan: 0.006, girth: -0.004 },
  candy: { girth: 0.003 },
  honey: { girth: 0.002, furDensity: 0.001 },
  greens: { neckLength: 0.002 },
  seedCake: { girth: 0.002, neckLength: 0.001 },
  frostMint: { furDensity: 0.003 },
  iceCream: { furDensity: 0.002, girth: 0.001 },
  // grounds (per hour)
  water: { finSize: 0.002 },
  deepWater: { finSize: 0.004, tailLength: 0.001 },
  muddyWater: { finSize: 0.001 },
  snow: { furDensity: 0.003 },
  ice: { furDensity: 0.002 },
  stone: { armor: 0.002 },
  gravel: { armor: 0.001, legLength: 0.001 },
  metal: { armor: 0.002, hornSize: 0.001 },
  sand: { legLength: 0.001 },
  lava: { furDensity: -0.003, hornSize: 0.001 },
  // fights (per fight / per KO)
  battles: { armor: 0.003, hornSize: 0.002, shoulderWidth: 0.001 },
  kos: { hornSize: 0.003 },
};
/** Weight of one unit of a source in an attractor's pressure. */
const UNIT_W = { experience: 0.01, food: 0.01, ground: 0.005, battle: 0.005 } as const;

const TRAIT_WORD: Record<NurtureTrait, string> = {
  neckLength: "neck",
  legLength: "legs",
  armSize: "arms",
  shoulderWidth: "shoulders",
  wingSpan: "wings",
  tailLength: "tail",
  armor: "armour",
  finSize: "fins",
  girth: "girth",
  hornSize: "horns",
  eyeSize: "eyes",
  furDensity: "fur",
};

// ------------------------------------------------------------------ nature
const plan = (g: Genome, id: keyof Genome["plan"]) => clamp01((g.plan[id][0] + g.plan[id][1]) / 2);
const pos = (v: number) => Math.max(0, v);

function normalise(w: Record<AttractorId, number>): Record<AttractorId, number> {
  let s = 0;
  for (const id of ATTRACTOR_IDS) s += Math.max(0, w[id]);
  const out = {} as Record<AttractorId, number>;
  for (const id of ATTRACTOR_IDS) out[id] = s > 0 ? Math.max(0, w[id]) / s : 1 / ATTRACTOR_IDS.length;
  return out;
}

/**
 * Genetic attractor weights (sum 1). The body kind's own structure gets the big share (a tentacled blob is a
 * cephalopod, an untentacled blob a globe); the part genes add the secondary tendencies (long segmented
 * bodies -> larval, hard spiky ones -> armoured, extra wings -> avian); elaborate / mythic genomes lean chimera.
 */
export function natureOf(g: Genome): Record<AttractorId, number> {
  const cx = complexityOf(g);
  const c = cx.counts;
  const hard = (g.axes.hardness[0] + g.axes.hardness[1]) / 2;
  const w = {} as Record<AttractorId, number>;
  for (const id of ATTRACTOR_IDS) w[id] = 0.03;
  const own: AttractorId = g.kind === "blob" ? (c.tentacles > 0 ? "cephalopod" : "globe") : g.kind;
  w[own] += 2.2;
  if (cx.tier === "minimal") w.globe += 2;
  if (c.tentacles > 0 && own !== "cephalopod") w.cephalopod += 0.25 + 0.05 * c.tentacles;
  const larvalBody = g.kind === "serpent" || g.kind === "hexapod" || g.kind === "blob" ? 1 : 0.3;
  w.larval += 0.7 * plan(g, "segments") * (1 - plan(g, "legLen")) * larvalBody;
  w.armored += 0.8 * pos(hard) + 0.35 * plan(g, "spikes") * (0.5 + pos(hard));
  if (c.wingPairs > 0 && g.kind !== "avian") w.avian += 0.25 * c.wingPairs;
  if (g.kind !== "serpent") w.serpent += 0.25 * pos(plan(g, "tail") - 0.6);
  if (c.legPairs >= 3 && g.kind !== "hexapod") w.hexapod += 0.3;
  if (g.kind === "blob" && own === "cephalopod") w.globe += 0.4;
  w.chimera += cx.tier === "mythic" ? (cx.colossal ? 3.2 : 2.6) : cx.tier === "elaborate" ? 0.45 : cx.tier === "complex" ? 0.12 : 0;
  return normalise(w);
}

// ------------------------------------------------------------------ nurture
interface Src {
  id: string;
  units: number;
  type: keyof typeof UNIT_W;
  name: string;
}

function sourcesOf(c: Conditions): Src[] {
  const out: Src[] = [];
  for (const [id, n] of Object.entries(c.experiences ?? {}) as [ExperienceId, number][]) {
    if (n > 0 && EXPERIENCES[id]) out.push({ id, units: n, type: "experience", name: EXPERIENCES[id].name });
  }
  for (const [id, n] of Object.entries(c.diet ?? {}) as [FoodId, number][]) {
    if (n > 0 && FOODS[id]) out.push({ id, units: n, type: "food", name: FOODS[id].name });
  }
  for (const [id, h] of Object.entries(c.exposure ?? {}) as [GroundId, number][]) {
    if (h > 0 && GROUNDS[id]) out.push({ id, units: h, type: "ground", name: `${GROUNDS[id].name} (h)` });
  }
  const b = c.battles;
  if (b) {
    const fights = (b.won ?? 0) + (b.lost ?? 0) + (b.draws ?? 0);
    if (fights > 0) out.push({ id: "battles", units: fights, type: "battle", name: "Battles" });
    if ((b.kos ?? 0) > 0) out.push({ id: "kos", units: b.kos, type: "battle", name: "KOs" });
  }
  return out;
}

/** How well this body takes training on a trait (nature first): 0.5 .. 1.5. */
function aptitude(nature: Record<AttractorId, number>, t: NurtureTrait): number {
  let a = 0.5;
  for (const id of ATTRACTOR_IDS) {
    const p = BY_ID[id].pulls[t];
    a += nature[id] * (p === undefined ? 0.5 : p > 1 ? 1 : p < 1 ? 0.25 : 0.5);
  }
  return a;
}

const sat = (x: number) => NURTURE_CAP * Math.tanh(x / NURTURE_CAP);

/**
 * Weights and trait shifts after life. Every shift is multiplicative and within [1 - NURTURE_CAP,
 * 1 + NURTURE_CAP]; every weight changes by at most a factor (1 + NURTURE_CAP) before renormalising, so the
 * genetic structure stays recognisable. `reasons` are plain language, most important first.
 */
export function nurtureOf(g: Genome, c: Conditions): NurtureState {
  const nature = natureOf(g);
  const srcs = sourcesOf(c);
  // Attractor pressure.
  const pressure = {} as Record<AttractorId, number>;
  for (const a of ATTRACTORS) {
    pressure[a.id] = 0;
    for (const s of srcs) if (a.fedBy.includes(s.id)) pressure[a.id] += s.units * UNIT_W[s.type];
  }
  const bent = {} as Record<AttractorId, number>;
  for (const id of ATTRACTOR_IDS) bent[id] = nature[id] * (1 + NURTURE_CAP * Math.tanh(pressure[id]));
  const weights = normalise(bent);
  // Trait shifts.
  const raw: Partial<Record<NurtureTrait, number>> = {};
  const per: { s: Src; t: NurtureTrait; v: number }[] = [];
  for (const s of srcs) {
    const feed = TRAIT_FEED[s.id];
    if (!feed) continue;
    for (const [t, k] of Object.entries(feed) as [NurtureTrait, number][]) {
      const v = s.units * k * aptitude(nature, t);
      raw[t] = (raw[t] ?? 0) + v;
      per.push({ s, t, v });
    }
  }
  const shift: Partial<Record<NurtureTrait, number>> = {};
  for (const [t, v] of Object.entries(raw) as [NurtureTrait, number][]) {
    const f = 1 + sat(v);
    if (Math.abs(f - 1) >= 0.005) shift[t] = Math.round(f * 1000) / 1000;
  }
  // Reasons: each source's share of the saturated shift of its trait.
  const reasons = per
    .filter((p) => shift[p.t] !== undefined && raw[p.t])
    .map((p) => ({ p, pct: (shift[p.t]! - 1) * (p.v / raw[p.t]!) * 100 }))
    .filter((x) => Math.abs(x.pct) >= 0.5)
    .sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct))
    .slice(0, 6)
    .map(({ p, pct }) => {
      const u = Math.round(p.s.units * 10) / 10;
      return `${p.s.name} x${u} -> ${TRAIT_WORD[p.t]} ${pct >= 0 ? "+" : "-"}${Math.abs(Math.round(pct))} %`;
    });
  // The attractor that moved most, if it moved visibly.
  let top: AttractorId | null = null, dv = 0;
  for (const id of ATTRACTOR_IDS) if (weights[id] - nature[id] > dv) [top, dv] = [id, weights[id] - nature[id]];
  if (top && dv >= 0.01) reasons.push(`life leans the body toward ${top} (+${Math.round(dv * 100)} pts)`);
  return { weights, shift, reasons };
}

/** The dominant attractor of a weight map. */
export function dominantAttractor(w: Record<AttractorId, number>): AttractorId {
  let best: AttractorId = "globe", bv = -1;
  for (const id of ATTRACTOR_IDS) if (w[id] > bv) [best, bv] = [id, w[id]];
  return best;
}
