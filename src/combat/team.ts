/**
 * Teams: 6 slots; a Genemon costs slots by size class (XS/S 1, M 2, L 3, XL 4, XXL 6 = a lone colossus) so the strongest,
 * biggest monsters crowd out the roster. Member ORDER is the attack/initiative order. Synergies are
 * computed from element pairs, psyche and body mixes and become battle modifiers.
 */
import { type ElementId, typeMultiplier } from "../data/elements.ts";
import { type Genemon, phenotypeOf } from "../genome/genemon.ts";
import type { Stats } from "../genome/phenotype.ts";
import { Rng } from "../core/rng.ts";
import { clamp } from "../core/math.ts";
import { ALL_MOVE_BY_ID } from "./kit.ts";
import { isDamaging } from "./moves.ts";

export const TEAM_CAPACITY = 6;

export interface Team {
  id: string;
  owner: string;
  name: string;
  /** Ordered: index 0 leads and acts first. */
  members: Genemon[];
}

export interface Synergy {
  id: string;
  name: string;
  why: string;
  /** Multipliers on stats for every member. */
  statMult?: Partial<Record<keyof Stats, number>>;
  /** Damage multiplier for one element (team-wide). */
  element?: ElementId;
  /** A second element the same elementMult applies to (Forgeheart: fire AND earth). */
  element2?: ElementId;
  elementMult?: number;
  /** Multiplier on all damage. */
  damageMult?: number;
  /** Extra status-application chance multiplier for an element's moves. */
  statusMult?: number;
  /** Plant members regenerate this fraction of max HP per second. */
  regen?: number;
  /** Order combos: bonus when consecutive attackers hit the same target within the window. */
  combo?: number;
}

export function slotsUsed(members: readonly Genemon[]): number {
  return members.reduce((s, g) => s + phenotypeOf(g).slots, 0);
}

export function validateTeam(t: Team): { ok: boolean; slots: number; errors: string[] } {
  const errors: string[] = [];
  const slots = slotsUsed(t.members);
  if (t.members.length === 0) errors.push("team is empty");
  if (slots > TEAM_CAPACITY) errors.push(`uses ${slots} slots > capacity ${TEAM_CAPACITY}`);
  const ids = new Set(t.members.map((g) => g.id));
  if (ids.size !== t.members.length) errors.push("duplicate Genemon");
  return { ok: errors.length === 0, slots, errors };
}

const PAIRS: [ElementId, ElementId, Synergy][] = [
  ["water", "electric", { id: "conductor", name: "Conductor", why: "Water soaks, electricity conducts: +15% electric damage.", element: "electric", elementMult: 1.15 }],
  ["fire", "air", { id: "bellows", name: "Bellows", why: "Wind feeds fire: +12% fire damage.", element: "fire", elementMult: 1.12 }],
  ["plant", "water", { id: "garden", name: "Garden", why: "Watered plants regrow: plant members regenerate 1%/s.", regen: 0.01 }],
  ["earth", "metal", { id: "bulwark", name: "Bulwark", why: "Stone and steel: +10% defence.", statMult: { def: 1.1 } }],
  ["light", "psychic", { id: "clarity", name: "Clarity", why: "Light and mind: +5% accuracy.", statMult: { accuracy: 1.05 } }],
  ["shadow", "void", { id: "abyss", name: "Abyss", why: "Darkness and absence: +25% evasion.", statMult: { evasion: 1.25 } }],
  ["ice", "water", { id: "glacier", name: "Glacier", why: "Water ready to freeze: ice status chances x1.5.", element: "ice", statusMult: 1.5 }],
  ["poison", "plant", { id: "rot", name: "Rot", why: "Poisoned growth: +10% poison damage.", element: "poison", elementMult: 1.1 }],
  ["fire", "earth", { id: "forgeheart", name: "Forgeheart", why: "Magma core: +8% fire and earth damage.", element: "fire", element2: "earth", elementMult: 1.08 }],
];

/**
 * Team balance knobs [P6-B1] (tools may ablate them; gameplay never writes them). Pack: attack bonus per social
 * member beyond the first, counted up to packMax members (pass 5: +6 % for exactly 3).
 */
export const TEAM_TUNING = { packAtk: 0.15, packMax: 3 };

export function synergies(t: Team): Synergy[] {
  const out: Synergy[] = [];
  const phs = t.members.map((g) => phenotypeOf(g));
  // A pair synergy needs two DIFFERENT members: one dual-type creature cannot enable a pair alone (X4).
  const holders = (e: ElementId) => phs.flatMap((p, i) => (p.elements.primary === e || p.elements.secondary === e ? [i] : []));
  for (const [a, b, s] of PAIRS) {
    const A = holders(a), B = holders(b);
    if (A.some((i) => B.some((j) => j !== i))) out.push(s);
  }
  // Pack [P6-B1]: social Genemon fight as one - +packAtk attack per social member beyond the first (2+ needed).
  const social = phs.filter((p) => p.axes.sociality > 0.25).length;
  if (phs.length >= 2 && social >= 2) {
    const k = 1 + TEAM_TUNING.packAtk * Math.min(TEAM_TUNING.packMax - 1, social - 1);
    out.push({ id: "pack", name: "Pack", why: `${social} social Genemon fight as one: +${Math.round((k - 1) * 100)}% attack.`, statMult: { atk: k } });
  }
  if (phs.length >= 2) {
    const order = phs.reduce((s, p) => s + p.axes.structure, 0) / phs.length;
    if (order > 0.2) out.push({ id: "formation", name: "Formation", why: "Orderly team: consecutive attacks on one target +10%.", combo: 0.1 });
  }
  if (phs.some((p) => p.axes.reach < -0.2) && phs.some((p) => p.axes.reach > 0.2)) {
    out.push({ id: "vanguard", name: "Vanguard & Artillery", why: "A brawler and a sniper: +5% damage.", damageMult: 1.05 });
  }
  if (phs.some((p) => p.slots >= 3) && phs.some((p) => p.slots === 1)) {
    out.push({ id: "guardian", name: "Guardian", why: "A giant shelters the small: +15% evasion.", statMult: { evasion: 1.15 } });
  }
  const primaries = new Set(phs.map((p) => p.elements.primary));
  if (primaries.size >= 4) out.push({ id: "prism", name: "Prism", why: "Four elements cover each other: +3% damage.", damageMult: 1.03 });
  // Resonance: two or more members share a primary element (the most common one wins; ties go to
  // the earlier member) - as documented in GAMEPLAY.md; it used to require EVERY member.
  const count = new Map<ElementId, number>();
  for (const p of phs) count.set(p.elements.primary, (count.get(p.elements.primary) ?? 0) + 1);
  let best: ElementId | null = null, bestN = 1;
  for (const [e, n] of count) {
    if (n > bestN) {
      best = e;
      bestN = n;
    }
  }
  if (best) out.push({ id: "resonance", name: "Resonance", why: `${bestN} ${best} primaries: +10% ${best} damage.`, element: best, elementMult: 1.1 });
  return out;
}

// ------------------------------------------------------------------ team quality [P6-B2]

/** Synergies that need a MIX (a pair of elements, a brawler + a sniper, 4 elements...): Resonance is the mono-team one. */
const MIX_SYNERGY = (s: Synergy) => s.id !== "resonance";

/** Element of each damaging move in a kit (moves resolved by id; unknown ids skipped). */
function damagingElements(g: Genemon): ElementId[] {
  return g.moves.map((id) => ALL_MOVE_BY_ID[id]).filter((m) => m && isDamaging(m)).map((m) => m.element);
}

/** Strength of one kit: mean power x accuracy of its two best damaging moves, / KIT_REF (a median kit ~1). */
export const KIT_REF = 85;
export function kitStrength(g: Genemon): number {
  const v = g.moves.map((id) => ALL_MOVE_BY_ID[id]).filter((m) => m && isDamaging(m)).map((m) => m.power * m.accuracy).sort((a, b) => b - a).slice(0, 2);
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length / KIT_REF : 0;
}

export interface TeamQuality {
  /** Weighted score in [0, 1] (QUALITY_WEIGHTS). */
  score: number;
  /** Mixed synergies (all but Resonance) / 4, capped at 1. */
  synergy: number;
  /** Offence vs the opponent: mean over members of the best type multiplier of their damaging moves, log2 mapped 0.5x -> 0, 2x -> 1. */
  offense: number;
  /** Defence vs the opponent: 1 - mean over members of the worst type multiplier the opponent's moves deal them, same map. */
  defense: number;
  /** Distinct primary elements / members. */
  diversity: number;
  /** Mean kitStrength, capped at 1.5, / 1.5. */
  kit: number;
  synergies: string[];
}

/** Weights of the quality score: coverage of the opponent first, then synergy, kits and diversity. */
export const QUALITY_WEIGHTS = { synergy: 0.25, offense: 0.3, defense: 0.2, diversity: 0.1, kit: 0.15 } as const;

/**
 * How well a team is COMPOSED against a given opponent (pure; for the batch brackets and the team screen):
 * synergies that need a mix, element coverage of the opponent's weaknesses, exposure to the opponent's
 * moves, distinct elements and kit strength. Level is NOT part of it (brackets compare at equal level).
 */
export function teamQuality(members: readonly Genemon[], opponents: readonly Genemon[]): TeamQuality {
  const map = (k: number) => clamp((Math.log2(Math.max(0.25, k)) + 1) / 2, 0, 1);
  const oppTypes = opponents.map((g) => {
    const ph = phenotypeOf(g);
    return [ph.elements.primary, ...(ph.elements.secondary ? [ph.elements.secondary] : [])] as ElementId[];
  });
  const oppEls = [...new Set(opponents.flatMap(damagingElements))];
  let off = 0, def = 0, kit = 0;
  const prim = new Set<ElementId>();
  for (const g of members) {
    const ph = phenotypeOf(g);
    const types = [ph.elements.primary, ...(ph.elements.secondary ? [ph.elements.secondary] : [])] as ElementId[];
    prim.add(ph.elements.primary);
    const mine = damagingElements(g);
    const best = oppTypes.length && mine.length ? Math.max(...mine.map((e) => oppTypes.reduce((s, t) => s + typeMultiplier(e, t), 0) / oppTypes.length)) : 1;
    const worst = oppEls.length ? Math.max(...oppEls.map((e) => typeMultiplier(e, types))) : 1;
    off += map(best);
    def += 1 - map(worst);
    kit += Math.min(1.5, kitStrength(g)) / 1.5;
  }
  const n = Math.max(1, members.length);
  const syn = synergies({ id: "q", owner: "q", name: "q", members: [...members] });
  const q = {
    synergy: Math.min(1, syn.filter(MIX_SYNERGY).length / 4),
    offense: off / n,
    defense: def / n,
    diversity: members.length ? prim.size / members.length : 0,
    kit: kit / n,
  };
  const W = QUALITY_WEIGHTS;
  const score = W.synergy * q.synergy + W.offense * q.offense + W.defense * q.defense + W.diversity * q.diversity + W.kit * q.kit;
  return { score, ...q, synergies: syn.map((s) => s.id) };
}

export interface TeamSummary {
  slots: number;
  power: number;
  elements: Partial<Record<ElementId, number>>;
  synergies: Synergy[];
}

export function teamSummary(t: Team): TeamSummary {
  const elements: Partial<Record<ElementId, number>> = {};
  let power = 0;
  for (const g of t.members) {
    const ph = phenotypeOf(g);
    power += ph.power;
    elements[ph.elements.primary] = (elements[ph.elements.primary] ?? 0) + 1;
  }
  return { slots: slotsUsed(t.members), power, elements, synergies: synergies(t) };
}

/** Fill a team from a pool with a preference ("big" monsters, a "swarm" of small ones, or "balanced"). */
export function autoTeam(pool: readonly Genemon[], owner: string, seed: number, pref: "big" | "swarm" | "balanced" = "balanced"): Team {
  const rng = new Rng(seed);
  // Pass 6 [P6-E4]: a cocoon cannot fight, so it is never drafted.
  const scored = pool.filter((g) => phenotypeOf(g).evo?.form !== "cocoon").map((g) => {
    const ph = phenotypeOf(g);
    const sizeBias = pref === "big" ? ph.slots : pref === "swarm" ? 1 / ph.slots : 1;
    return { g, ph, s: (ph.power / ph.slots) * sizeBias * (0.9 + 0.2 * rng.next()) };
  }).sort((a, b) => b.s - a.s);
  const members: Genemon[] = [];
  const seen = new Set<ElementId>();
  let slots = 0;
  for (const pass of [0, 1]) {
    for (const x of scored) {
      if (members.includes(x.g) || slots + x.ph.slots > TEAM_CAPACITY) continue;
      if (pass === 0 && seen.has(x.ph.elements.primary)) continue;
      members.push(x.g);
      seen.add(x.ph.elements.primary);
      slots += x.ph.slots;
    }
  }
  return { id: `team-${owner}-${seed}`, owner, name: `${owner}'s team`, members };
}
