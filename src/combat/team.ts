/**
 * Teams: 6 slots; a Genemon costs slots by size class (XS/S 1, M 2, L 3, XL 4) so the strongest,
 * biggest monsters crowd out the roster. Member ORDER is the attack/initiative order. Synergies are
 * computed from element pairs, psyche and body mixes and become battle modifiers.
 */
import type { ElementId } from "../data/elements.ts";
import { type Genemon, phenotypeOf } from "../genome/genemon.ts";
import type { Stats } from "../genome/phenotype.ts";
import { Rng } from "../core/rng.ts";

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

export function synergies(t: Team): Synergy[] {
  const out: Synergy[] = [];
  const phs = t.members.map((g) => phenotypeOf(g));
  // A pair synergy needs two DIFFERENT members: one dual-type creature cannot enable a pair alone (X4).
  const holders = (e: ElementId) => phs.flatMap((p, i) => (p.elements.primary === e || p.elements.secondary === e ? [i] : []));
  for (const [a, b, s] of PAIRS) {
    const A = holders(a), B = holders(b);
    if (A.some((i) => B.some((j) => j !== i))) out.push(s);
  }
  if (phs.length >= 3 && phs.filter((p) => p.axes.sociality > 0.25).length >= 3) {
    out.push({ id: "pack", name: "Pack", why: "Three social Genemon fight as one: +6% attack.", statMult: { atk: 1.06 } });
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
  const scored = pool.map((g) => {
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
