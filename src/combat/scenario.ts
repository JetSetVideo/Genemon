/**
 * Scenario builders: hand-shaped Genemon and teams for the gameplay scenarios (docs/SCENARIOS.md)
 * and the balance tools. Biases push the genome toward an archetype with a small spread so the
 * scenario is about the mechanic, not about a lucky roll.
 */
import type { AxisVector } from "../data/axes.ts";
import type { ArenaKind, ArenaSpec } from "../world/arena.ts";
import type { WeatherId } from "../data/weather.ts";
import type { BodyKind } from "../genome/genome.ts";
import { createGenemon, type Genemon, learnset, phenotypeOf } from "../genome/genemon.ts";
import { MOVE_BY_ID } from "./moves.ts";
import type { Team } from "./team.ts";
import { hashSeed } from "../core/rng.ts";

export interface Archetype {
  label: string;
  kind?: BodyKind;
  axes: Partial<AxisVector>;
  level?: number;
  /** Force a moveset (ids) instead of the learnset. */
  moves?: string[];
}

export const ARCHETYPES = {
  bigFireBrawler: { label: "big fire brawler", kind: "quadruped", axes: { heat: 0.95, moisture: -0.7, temper: 0.5, stature: 0.75, weight: 0.5, might: 0.7, reach: -0.9, focus: 0.3 } },
  smallPlant: { label: "small plant", kind: "biped", axes: { vitality: 0.95, moisture: 0.35, structure: 0.3, stature: -0.75, weight: -0.3, hardness: -0.3 } },
  waterSniper: { label: "water sniper", kind: "serpent", axes: { moisture: 0.95, form: 0.5, heat: -0.3, reach: 0.8, focus: 0.6 } },
  fireSniper: { label: "fire sniper", kind: "avian", axes: { heat: 0.95, moisture: -0.6, temper: 0.3, reach: 0.8, focus: 0.6, altitude: 0.2 } },
  electricBolt: { label: "electric caster", kind: "biped", axes: { conductivity: 0.95, tempo: 0.6, structure: -0.4, reach: 0.5 } },
  heavyTarget: { label: "neutral dummy", kind: "quadruped", axes: { stature: 0, hardness: 0, conductivity: 0, moisture: 0, heat: 0, vitality: 0, luminance: 0, wisdom: -0.5, temper: -0.8 } },
  digger: { label: "earth digger", kind: "quadruped", axes: { hardness: 0.7, weight: 0.5, substance: 0.6, altitude: -0.9, moisture: -0.2 } },
  flyer: { label: "air flyer", kind: "avian", axes: { altitude: 0.95, weight: -0.8, phase: 0.3, tempo: 0.5 } },
  quaker: { label: "earth quaker", kind: "quadruped", axes: { hardness: 0.7, weight: 0.7, substance: 0.6, altitude: -0.4, stature: 0.3 } },
} as const satisfies Record<string, Archetype>;

export function makeArchetype(a: Archetype, seed: number, owner = "scenario"): Genemon {
  const g = createGenemon({ seed: hashSeed(seed, a.label), owner, level: a.level ?? 25, bias: { axes: a.axes, kind: a.kind, spread: 0.12, plan: { quality: 0.5 } } });
  if (a.moves) g.moves = a.moves.filter((m) => MOVE_BY_ID[m]);
  else g.moves = learnset(phenotypeOf(g), g.genome.id);
  return g;
}

export function team(owner: string, members: Genemon[]): Team {
  return { id: `team-${owner}`, owner, name: owner, members };
}

export function arenaSpec(kind: ArenaKind, seed: number, weather: WeatherId = "clear", hour = 13): ArenaSpec {
  return { seed, kind, weather, hour };
}
