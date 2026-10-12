/**
 * Ground types: the physical surface under each point of an arena or world tile. Physics reads
 * friction, liquid depth and moveCost; combat reads conductivity (electric), wetness, flammability;
 * abilities read diggable/hardness. Reactions can CHANGE the ground (freeze water -> ice, melt ice
 * -> water, water + earth -> mud, fire + grass -> ash).
 */
import type { ElementId } from "./elements.ts";

export const GROUND_IDS = [
  "grass",
  "soil",
  "sand",
  "stone",
  "gravel",
  "mud",
  "water",
  "deepWater",
  "muddyWater",
  "ice",
  "snow",
  "lava",
  "metal",
  "moss",
  "ash",
  "crystal",
  "salt",
] as const;
export type GroundId = typeof GROUND_IDS[number];

export interface Ground {
  id: GroundId;
  name: string;
  color: number;
  /** Coulomb friction coefficient (ice ~0.05, rubbery moss ~0.9). */
  friction: number;
  /** Multiplier applied to electric damage received while standing here. */
  conductivity: number;
  wetness: number;
  diggable: boolean;
  flammable: number;
  /** -1 freezing .. +1 scorching. */
  temperature: number;
  hardness: number;
  liquid: boolean;
  /** Liquid depth in metres (buoyancy/drag). */
  depth: number;
  /** Speed multiplier for walkers. */
  moveCost: number;
  /** Element creatures that thrive here get this bonus (damage/regen). */
  affinity: Partial<Record<ElementId, number>>;
}

export const GROUNDS: Record<GroundId, Ground> = {
  grass: { id: "grass", name: "Grass", color: 0x5f9e3a, friction: 0.7, conductivity: 0.9, wetness: 0.2, diggable: true, flammable: 0.7, temperature: 0, hardness: 0.2, liquid: false, depth: 0, moveCost: 1, affinity: { plant: 0.15 } },
  soil: { id: "soil", name: "Soil", color: 0x7a5534, friction: 0.65, conductivity: 0.85, wetness: 0.25, diggable: true, flammable: 0.1, temperature: 0, hardness: 0.3, liquid: false, depth: 0, moveCost: 1, affinity: { earth: 0.1, plant: 0.05 } },
  sand: { id: "sand", name: "Sand", color: 0xd8c27a, friction: 0.5, conductivity: 0.6, wetness: 0, diggable: true, flammable: 0, temperature: 0.3, hardness: 0.1, liquid: false, depth: 0, moveCost: 0.8, affinity: { earth: 0.1 } },
  stone: { id: "stone", name: "Stone", color: 0x8b8a86, friction: 0.75, conductivity: 0.7, wetness: 0, diggable: false, flammable: 0, temperature: 0, hardness: 0.9, liquid: false, depth: 0, moveCost: 1.05, affinity: { earth: 0.15, metal: 0.05 } },
  gravel: { id: "gravel", name: "Gravel", color: 0x9c958a, friction: 0.6, conductivity: 0.7, wetness: 0, diggable: true, flammable: 0, temperature: 0, hardness: 0.6, liquid: false, depth: 0, moveCost: 0.9, affinity: { earth: 0.1 } },
  mud: { id: "mud", name: "Mud", color: 0x5a4127, friction: 0.45, conductivity: 1.1, wetness: 0.7, diggable: true, flammable: 0, temperature: 0, hardness: 0.1, liquid: false, depth: 0, moveCost: 0.6, affinity: { earth: 0.1, water: 0.05 } },
  water: { id: "water", name: "Water", color: 0x2d6fb3, friction: 0.3, conductivity: 1.6, wetness: 1, diggable: false, flammable: 0, temperature: -0.1, hardness: 0, liquid: true, depth: 0.5, moveCost: 0.55, affinity: { water: 0.2 } },
  deepWater: { id: "deepWater", name: "Deep water", color: 0x1a4a85, friction: 0.2, conductivity: 1.7, wetness: 1, diggable: false, flammable: 0, temperature: -0.2, hardness: 0, liquid: true, depth: 2.5, moveCost: 0.35, affinity: { water: 0.3 } },
  muddyWater: { id: "muddyWater", name: "Muddy water", color: 0x6b5a3a, friction: 0.35, conductivity: 1.25, wetness: 0.9, diggable: false, flammable: 0, temperature: 0, hardness: 0, liquid: true, depth: 0.4, moveCost: 0.5, affinity: { water: 0.1, earth: 0.05 } },
  ice: { id: "ice", name: "Ice", color: 0xcfeeff, friction: 0.05, conductivity: 0.8, wetness: 0.3, diggable: false, flammable: 0, temperature: -0.8, hardness: 0.7, liquid: false, depth: 0, moveCost: 0.9, affinity: { ice: 0.25 } },
  snow: { id: "snow", name: "Snow", color: 0xf2f6fa, friction: 0.35, conductivity: 0.7, wetness: 0.5, diggable: true, flammable: 0, temperature: -0.6, hardness: 0.1, liquid: false, depth: 0, moveCost: 0.7, affinity: { ice: 0.2 } },
  lava: { id: "lava", name: "Lava", color: 0xff4a12, friction: 0.5, conductivity: 1, wetness: 0, diggable: false, flammable: 1, temperature: 1, hardness: 0.2, liquid: true, depth: 0.3, moveCost: 0.6, affinity: { fire: 0.3 } },
  metal: { id: "metal", name: "Metal plate", color: 0x7d8790, friction: 0.55, conductivity: 1.8, wetness: 0, diggable: false, flammable: 0, temperature: 0, hardness: 1, liquid: false, depth: 0, moveCost: 1.05, affinity: { metal: 0.2, electric: 0.1 } },
  moss: { id: "moss", name: "Moss", color: 0x3e7a3a, friction: 0.85, conductivity: 0.95, wetness: 0.5, diggable: true, flammable: 0.4, temperature: 0, hardness: 0.1, liquid: false, depth: 0, moveCost: 0.95, affinity: { plant: 0.2 } },
  ash: { id: "ash", name: "Ash", color: 0x4a4644, friction: 0.55, conductivity: 0.75, wetness: 0, diggable: true, flammable: 0, temperature: 0.4, hardness: 0.1, liquid: false, depth: 0, moveCost: 0.85, affinity: { fire: 0.1, shadow: 0.05 } },
  crystal: { id: "crystal", name: "Crystal", color: 0xb9a6ff, friction: 0.4, conductivity: 0.5, wetness: 0, diggable: false, flammable: 0, temperature: -0.1, hardness: 1, liquid: false, depth: 0, moveCost: 1, affinity: { light: 0.2, psychic: 0.15 } },
  salt: { id: "salt", name: "Salt flat", color: 0xe9e4d8, friction: 0.6, conductivity: 1.2, wetness: 0.1, diggable: true, flammable: 0, temperature: 0.2, hardness: 0.4, liquid: false, depth: 0, moveCost: 1, affinity: { light: 0.05 } },
};

/** Ground transformation caused by an element landing on it (reactions that reshape the arena). */
export function transformGround(g: GroundId, element: ElementId): GroundId | null {
  switch (element) {
    case "ice":
      if (g === "water" || g === "muddyWater") return "ice";
      if (g === "lava") return "stone";
      if (g === "mud") return "soil";
      return null;
    case "fire":
      if (g === "ice") return "water";
      if (g === "snow") return "water";
      if (g === "grass" || g === "moss") return "ash";
      if (g === "mud") return "soil";
      return null;
    case "water":
      if (g === "soil" || g === "sand" || g === "gravel") return "mud";
      if (g === "lava") return "stone";
      if (g === "ash") return "mud";
      return null;
    case "earth":
      if (g === "water") return "muddyWater";
      if (g === "lava") return "stone";
      return null;
    case "plant":
      if (g === "soil" || g === "mud" || g === "ash") return "grass";
      if (g === "stone") return "moss";
      return null;
    default:
      return null;
  }
}
