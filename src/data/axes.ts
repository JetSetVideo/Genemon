/**
 * Opposite-pole axes: the coordinate system every Genemon lives in. A genome stores an allele PAIR
 * per axis (double helix, inherited from the legacy lab); expression gives a value in [-1, 1]
 * where -1 is the `neg` pole and +1 the `pos` pole. Elements, stats, body, psyche and abilities
 * are all DERIVED from these coordinates, so evolution under conditions (time, place, food,
 * battles, experiences) is simply movement in this space.
 *
 * SPACES group axes into multidimensional sub-spaces that the Data screen projects (PCA) and the
 * Genospace view populates with every known Genemon.
 */

export type AxisGroup = "cosmic" | "matter" | "body" | "psyche" | "tempo" | "combat";

export interface Axis {
  id: AxisId;
  neg: string;
  pos: string;
  group: AxisGroup;
  /** additive: child = mean of alleles. extreme: the allele farther from 0 dominates. */
  dominance: "additive" | "extreme";
  note: string;
}

export const AXIS_IDS = [
  "luminance",
  "substance",
  "structure",
  "vitality",
  "phase",
  "heat",
  "moisture",
  "hardness",
  "elasticity",
  "conductivity",
  "stature",
  "weight",
  "might",
  "tempo",
  "altitude",
  "form",
  "conviction",
  "temper",
  "sociality",
  "curiosity",
  "wisdom",
  "mood",
  "appetite",
  "reach",
  "focus",
  "rhythm",
] as const;

export type AxisId = typeof AXIS_IDS[number];

export const AXES: readonly Axis[] = [
  { id: "luminance", neg: "dark", pos: "light", group: "cosmic", dominance: "extreme", note: "Light/shadow affinity, glow, sight in darkness." },
  { id: "substance", neg: "void", pos: "matter", group: "cosmic", dominance: "extreme", note: "How much the body exists: void bodies are partly intangible." },
  { id: "structure", neg: "chaos", pos: "order", group: "cosmic", dominance: "additive", note: "Predictability: chaos crits and surprises, order is consistent and synergises." },
  { id: "vitality", neg: "decay", pos: "growth", group: "cosmic", dominance: "additive", note: "Regeneration vs corrosion; plant vs poison." },
  { id: "phase", neg: "solid", pos: "gas", group: "matter", dominance: "additive", note: "Solid (-1), liquid (~0), gas (+1). Phase shifters can form and melt." },
  { id: "heat", neg: "cold", pos: "hot", group: "matter", dominance: "additive", note: "Body temperature: fire vs ice; melts or freezes the ground." },
  { id: "moisture", neg: "dry", pos: "wet", group: "matter", dominance: "additive", note: "Water content: swims, conducts electricity, resists fire." },
  { id: "hardness", neg: "soft", pos: "hard", group: "matter", dominance: "additive", note: "Armour and brittleness; diggers need hardness." },
  { id: "elasticity", neg: "rigid", pos: "elastic", group: "matter", dominance: "additive", note: "Squash/stretch, bounce, joint range." },
  { id: "conductivity", neg: "insulating", pos: "conductive", group: "matter", dominance: "additive", note: "Electric affinity and vulnerability." },
  { id: "stature", neg: "tiny", pos: "huge", group: "body", dominance: "additive", note: "Adult size: drives mass, team slots and reach." },
  { id: "weight", neg: "feather", pos: "heavy", group: "body", dominance: "additive", note: "Density of the body: knockback resistance vs agility/flight." },
  { id: "might", neg: "weak", pos: "strong", group: "body", dominance: "additive", note: "Raw physical power." },
  { id: "tempo", neg: "slow", pos: "fast", group: "tempo", dominance: "additive", note: "Movement and charge speed." },
  { id: "altitude", neg: "burrowing", pos: "soaring", group: "body", dominance: "extreme", note: "Digs into the ground or flies above it." },
  { id: "form", neg: "fixed", pos: "fluid", group: "body", dominance: "extreme", note: "Shape-shifting, morphing, form/melt transitions." },
  { id: "conviction", neg: "fear", pos: "certainty", group: "psyche", dominance: "additive", note: "Courage under pressure; fear makes it retreat." },
  { id: "temper", neg: "calm", pos: "wild", group: "psyche", dominance: "additive", note: "Aggression and risk-taking." },
  { id: "sociality", neg: "solitary", pos: "social", group: "psyche", dominance: "additive", note: "Synergy with teammates, protects allies." },
  { id: "curiosity", neg: "cautious", pos: "curious", group: "psyche", dominance: "additive", note: "Explores terrain, tries new moves, finds places." },
  { id: "wisdom", neg: "naive", pos: "wise", group: "psyche", dominance: "additive", note: "Learns from experience (type knowledge, move choice)." },
  { id: "mood", neg: "melancholic", pos: "joyful", group: "psyche", dominance: "additive", note: "Baseline emotion; drives idle animation energy." },
  { id: "appetite", neg: "ascetic", pos: "gluttonous", group: "psyche", dominance: "additive", note: "How much food matters to growth and mood." },
  { id: "reach", neg: "close", pos: "far", group: "combat", dominance: "additive", note: "Preferred combat distance: melee vs ranged." },
  { id: "focus", neg: "spread", pos: "focused", group: "combat", dominance: "additive", note: "Single-target precision vs area attacks; crit chance." },
  { id: "rhythm", neg: "nocturnal", pos: "diurnal", group: "tempo", dominance: "additive", note: "Active at night or by day: real local time buffs." },
];

export const AXIS_BY_ID: Record<AxisId, Axis> = Object.fromEntries(AXES.map((a) => [a.id, a])) as Record<
  AxisId,
  Axis
>;

/** Multidimensional sub-spaces (projected and populated on the Data/Genospace screens). */
export const SPACES: Record<string, readonly AxisId[]> = {
  cosmic: ["luminance", "substance", "structure", "vitality"],
  matter: ["phase", "heat", "moisture", "hardness", "elasticity", "conductivity"],
  body: ["stature", "weight", "might", "tempo", "altitude", "form"],
  psyche: ["conviction", "temper", "sociality", "curiosity", "wisdom", "mood", "appetite"],
  combat: ["reach", "focus", "might", "tempo", "conviction", "temper"],
  time: ["rhythm", "tempo", "vitality"],
};

export type AxisVector = Record<AxisId, number>;

export function zeroAxes(): AxisVector {
  return Object.fromEntries(AXIS_IDS.map((id) => [id, 0])) as AxisVector;
}

/** Label of the dominant pole, e.g. "hot (0.72)". */
export function poleLabel(id: AxisId, v: number): string {
  const a = AXIS_BY_ID[id];
  if (Math.abs(v) < 0.15) return `balanced ${a.neg}/${a.pos}`;
  return `${v < 0 ? a.neg : a.pos} (${Math.abs(v).toFixed(2)})`;
}
