/**
 * Elements: identity, colour, the axis signature that makes an element EMERGE from a genome, the
 * attack chart, and spatial REACTIONS between elements (fire+water -> smoke, water+electric ->
 * conduction...). A Genemon's types are not picked: they are the elements whose signature best
 * matches its expressed axes, so a creature raised in water can grow a water secondary type.
 */
import type { AxisId, AxisVector } from "./axes.ts";

export const ELEMENT_IDS = [
  "neutral",
  "fire",
  "water",
  "plant",
  "earth",
  "air",
  "electric",
  "ice",
  "metal",
  "poison",
  "light",
  "shadow",
  "psychic",
  "void",
] as const;
export type ElementId = typeof ELEMENT_IDS[number];

export interface Element {
  id: ElementId;
  name: string;
  color: number;
  /** Secondary FX colour (core / highlight). */
  core: number;
  signature: Partial<Record<AxisId, number>>;
  note: string;
}

export const ELEMENTS: Record<ElementId, Element> = {
  neutral: { id: "neutral", name: "Neutral", color: 0xb8b2a6, core: 0xffffff, signature: {}, note: "Baseline matter. No strengths, steady." },
  fire: { id: "fire", name: "Fire", color: 0xff5a1f, core: 0xffd166, signature: { heat: 1, moisture: -0.6, temper: 0.3, luminance: 0.2 }, note: "Burns plants, melts ice and metal; drowned by water into smoke." },
  water: { id: "water", name: "Water", color: 0x2f8cff, core: 0xbfe6ff, signature: { moisture: 1, form: 0.4, heat: -0.2 }, note: "Extinguishes fire, erodes earth, conducts electricity." },
  plant: { id: "plant", name: "Plant", color: 0x3fbf4a, core: 0xd9ff7a, signature: { vitality: 1, moisture: 0.4, structure: 0.2, hardness: -0.2 }, note: "Drinks water, binds earth, absorbs light." },
  earth: { id: "earth", name: "Earth", color: 0xa0703c, core: 0xe8c48a, signature: { hardness: 0.6, weight: 0.6, substance: 0.5, altitude: -0.5, moisture: -0.2 }, note: "Grounds electricity, smothers fire; can be dug." },
  air: { id: "air", name: "Air", color: 0xa9e4f2, core: 0xffffff, signature: { altitude: 1, weight: -0.8, phase: 0.5, tempo: 0.3 }, note: "Flies, spreads fire and clouds, disperses smoke and poison." },
  electric: { id: "electric", name: "Electric", color: 0xffe14a, core: 0xffffff, signature: { conductivity: 1, tempo: 0.6, structure: -0.4 }, note: "Conducts through water and metal; grounded by earth." },
  ice: { id: "ice", name: "Ice", color: 0x9ee7ff, core: 0xffffff, signature: { heat: -1, hardness: 0.4, moisture: 0.3, tempo: -0.3 }, note: "Freezes water into slippery ground; melts under fire." },
  metal: { id: "metal", name: "Metal", color: 0x9aa3ad, core: 0xe9eef2, signature: { hardness: 0.8, conductivity: 0.6, weight: 0.5, elasticity: -0.4 }, note: "Armoured; conducts; rusts in water, softens in fire." },
  poison: { id: "poison", name: "Poison", color: 0x9b4dff, core: 0xe0b8ff, signature: { vitality: -1, moisture: 0.2, structure: -0.3 }, note: "Corrodes life, contaminates water." },
  light: { id: "light", name: "Light", color: 0xfff3b0, core: 0xffffff, signature: { luminance: 1, rhythm: 0.4, conviction: 0.3 }, note: "Banishes shadow and void; reflected by metal." },
  shadow: { id: "shadow", name: "Shadow", color: 0x4b3a6b, core: 0x9e86ff, signature: { luminance: -1, rhythm: -0.6, curiosity: -0.2 }, note: "Hides, frightens minds; erased by light." },
  psychic: { id: "psychic", name: "Psychic", color: 0xff6fb5, core: 0xffd1ea, signature: { wisdom: 1, focus: 0.4, conviction: 0.3 }, note: "Mind over matter: bends metal, purges poison." },
  void: { id: "void", name: "Void", color: 0x1c1b2e, core: 0x7a6cff, signature: { substance: -1, phase: 0.4, luminance: -0.3, structure: -0.4 }, note: "Absence: swallows air and minds; filled by light." },
};

/** attacker -> defender multipliers that differ from 1. */
const CHART: Partial<Record<ElementId, Partial<Record<ElementId, number>>>> = {
  neutral: { metal: 0.5, earth: 0.5, void: 0.5 },
  fire: { plant: 2, ice: 2, metal: 2, fire: 0.5, water: 0.5, earth: 0.5 },
  water: { fire: 2, earth: 2, water: 0.5, plant: 0.5, ice: 0.5 },
  plant: { water: 2, earth: 2, fire: 0.5, plant: 0.5, air: 0.5, poison: 0.5, metal: 0.5 },
  earth: { fire: 2, electric: 2, metal: 2, poison: 2, plant: 0.5, air: 0.5 },
  air: { plant: 2, poison: 2, electric: 0.5, metal: 0.5, earth: 0.5 },
  electric: { water: 2, air: 2, metal: 2, electric: 0.5, plant: 0.5, earth: 0.5 },
  ice: { plant: 2, air: 2, earth: 2, fire: 0.5, metal: 0.5, ice: 0.5 },
  metal: { ice: 2, earth: 2, metal: 0.5, fire: 0.5, electric: 0.5 },
  poison: { plant: 2, water: 2, poison: 0.5, earth: 0.5, metal: 0.25 },
  light: { shadow: 2, void: 2, light: 0.5, metal: 0.5, plant: 0.5 },
  shadow: { light: 2, psychic: 2, shadow: 0.5 },
  psychic: { metal: 2, poison: 2, psychic: 0.5, shadow: 0.5 },
  void: { psychic: 2, air: 2, light: 2, electric: 2, void: 0.5, earth: 0.5 },
};

/** Multiplier of an attack element against a (possibly dual-typed) defender. Clamped to [0.25, 4]. */
export function typeMultiplier(attack: ElementId, defender: readonly ElementId[]): number {
  let m = 1;
  for (const d of defender) m *= CHART[attack]?.[d] ?? 1;
  return Math.min(4, Math.max(0.25, m));
}

/** Affinity of an expressed axis vector to every element, in [-1, 1]. Neutral has a small floor. */
export function elementAffinities(axes: AxisVector): Record<ElementId, number> {
  const out = {} as Record<ElementId, number>;
  for (const id of ELEMENT_IDS) {
    const sig = ELEMENTS[id].signature;
    let s = 0, w = 0;
    for (const [axis, weight] of Object.entries(sig) as [AxisId, number][]) {
      s += weight * axes[axis];
      w += Math.abs(weight);
    }
    out[id] = id === "neutral" ? 0.18 : w > 0 ? s / w : 0;
  }
  return out;
}

// ---------------------------------------------------------------- spatial reactions

export type ReactionId =
  | "smoke"
  | "wildfire"
  | "melt"
  | "firestorm"
  | "magma"
  | "forge"
  | "conduction"
  | "mud"
  | "freeze"
  | "contamination"
  | "mist"
  | "dust"
  | "disperse"
  | "magnetize"
  | "bloom"
  | "eclipse"
  | "blizzard"
  | "blight";

export interface Reaction {
  id: ReactionId;
  a: ElementId;
  b: ElementId;
  /** Zone left on the field (null = instant effect only). */
  zone: null | { kind: ReactionId; radius: number; ttl: number };
  /** Multiplier applied to the triggering attack's damage. */
  damageMult: number;
  note: string;
}

export const REACTIONS: readonly Reaction[] = [
  { id: "smoke", a: "fire", b: "water", zone: { kind: "smoke", radius: 3.2, ttl: 6 }, damageMult: 0.6, note: "Fire meets water: a smoke cloud blinds (-35% accuracy) everyone inside." },
  { id: "wildfire", a: "fire", b: "plant", zone: { kind: "wildfire", radius: 2.6, ttl: 5 }, damageMult: 1.2, note: "Burning vegetation: damage over time on the ground." },
  { id: "melt", a: "fire", b: "ice", zone: null, damageMult: 1.1, note: "Ice ground becomes water; frozen targets thaw." },
  { id: "firestorm", a: "fire", b: "air", zone: { kind: "firestorm", radius: 3.5, ttl: 3 }, damageMult: 1.35, note: "Wind feeds fire: wider, hotter blast." },
  { id: "magma", a: "fire", b: "earth", zone: { kind: "magma", radius: 2.2, ttl: 6 }, damageMult: 1, note: "Molten ground: burns and slows." },
  { id: "forge", a: "fire", b: "metal", zone: null, damageMult: 1.15, note: "Heated metal softens: -20% defence for 4 s." },
  { id: "conduction", a: "electric", b: "water", zone: { kind: "conduction", radius: 4, ttl: 0.6 }, damageMult: 1.5, note: "Current runs through water: chains to everyone wet or standing in water." },
  { id: "mud", a: "water", b: "earth", zone: { kind: "mud", radius: 2.8, ttl: 10 }, damageMult: 1, note: "Ground turns to mud: -40% speed." },
  { id: "freeze", a: "ice", b: "water", zone: { kind: "freeze", radius: 2.6, ttl: 12 }, damageMult: 1.2, note: "Water freezes into slippery ice; wet targets freeze solid." },
  { id: "contamination", a: "poison", b: "water", zone: { kind: "contamination", radius: 3, ttl: 8 }, damageMult: 1.1, note: "Toxic water: poisons whoever stands in it." },
  { id: "mist", a: "air", b: "water", zone: { kind: "mist", radius: 3.5, ttl: 6 }, damageMult: 0.9, note: "Mist: -15% accuracy, cools fire." },
  { id: "dust", a: "air", b: "earth", zone: { kind: "dust", radius: 3.5, ttl: 5 }, damageMult: 0.9, note: "Dust cloud: -20% accuracy." },
  { id: "disperse", a: "air", b: "poison", zone: null, damageMult: 1.1, note: "Wind blows gas away: clears smoke, mist and toxic clouds nearby." },
  { id: "magnetize", a: "electric", b: "metal", zone: null, damageMult: 1.25, note: "Magnetised metal is pulled toward the attacker (stagger)." },
  { id: "bloom", a: "plant", b: "water", zone: { kind: "bloom", radius: 2.5, ttl: 8 }, damageMult: 1, note: "Watered growth: regenerates plant allies in the zone." },
  { id: "eclipse", a: "light", b: "shadow", zone: null, damageMult: 0.7, note: "Light and shadow annihilate in a flash: both sides blinded 1 s." },
  { id: "blizzard", a: "ice", b: "air", zone: { kind: "blizzard", radius: 3.8, ttl: 4 }, damageMult: 1.3, note: "Wind-driven ice: wider area and slow." },
  { id: "blight", a: "poison", b: "plant", zone: { kind: "blight", radius: 2.4, ttl: 6 }, damageMult: 1.2, note: "Rotting growth: blocks regeneration." },
];

/** Order-insensitive reaction lookup between two elements. */
export function reactionBetween(x: ElementId, y: ElementId): Reaction | null {
  for (const r of REACTIONS) {
    if ((r.a === x && r.b === y) || (r.a === y && r.b === x)) return r;
  }
  return null;
}

export function hex(c: number): string {
  return `#${c.toString(16).padStart(6, "0")}`;
}
