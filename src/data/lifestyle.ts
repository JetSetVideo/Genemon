/**
 * Lifestyle inputs that shape a Genemon epigenetically: FOODS bought at the supermarket or found in
 * the world, EXPERIENCES (gym, swimming, quests, social time...), and time spent on each GROUND.
 * Each entry nudges expressed axes per unit (bounded later by a saturating function), which is how
 * the owner's real lifestyle and their friends' influence end up in the creature's body and mind.
 */
import type { AxisId } from "./axes.ts";
import type { GroundId } from "./grounds.ts";

export interface Food {
  id: FoodId;
  name: string;
  /** Nutrition in growth units (feeds `growth`). */
  nutrition: number;
  /** Mood change when eaten (scaled by appetite axis). */
  joy: number;
  nudge: Partial<Record<AxisId, number>>;
  /** Base market price (credits). */
  price: number;
}

export const FOOD_IDS = [
  "berries",
  "greens",
  "meat",
  "fish",
  "honey",
  "spicyPepper",
  "minerals",
  "mushroom",
  "candy",
  "seaweed",
  "iceCream",
  "coffeeBean",
  "glowFruit",
  "ashRoot",
  // Strong elemental foods (pass 4, P4-E2): ~4x the per-unit nudge of the staples above, so a
  // deliberate diet can steer a plain Genemon into an element (and two diets into a hybrid).
  "emberChili",
  "springWater",
  "stormBerry",
  "frostMint",
  "ironNut",
  "toxicCap",
  "sunPetal",
  "nightPlum",
  "mindLeaf",
  "voidSalt",
  "stoneBread",
  "cloudPuff",
  "seedCake",
] as const;
export type FoodId = typeof FOOD_IDS[number];

export const FOODS: Record<FoodId, Food> = {
  berries: { id: "berries", name: "Wild berries", nutrition: 1, joy: 0.05, nudge: { vitality: 0.004, mood: 0.003 }, price: 4 },
  greens: { id: "greens", name: "Leafy greens", nutrition: 1, joy: 0.01, nudge: { vitality: 0.006, structure: 0.002 }, price: 3 },
  meat: { id: "meat", name: "Meat", nutrition: 2, joy: 0.04, nudge: { might: 0.006, temper: 0.004, weight: 0.002 }, price: 9 },
  fish: { id: "fish", name: "Fish", nutrition: 1.6, joy: 0.04, nudge: { moisture: 0.006, wisdom: 0.002, tempo: 0.002 }, price: 8 },
  honey: { id: "honey", name: "Honey", nutrition: 1.2, joy: 0.08, nudge: { mood: 0.006, elasticity: 0.003, luminance: 0.002 }, price: 7 },
  spicyPepper: { id: "spicyPepper", name: "Spicy pepper", nutrition: 0.5, joy: 0.02, nudge: { heat: 0.008, temper: 0.004 }, price: 5 },
  minerals: { id: "minerals", name: "Mineral lick", nutrition: 0.4, joy: 0, nudge: { hardness: 0.007, weight: 0.003, conductivity: 0.002 }, price: 6 },
  mushroom: { id: "mushroom", name: "Cave mushroom", nutrition: 0.8, joy: 0.02, nudge: { luminance: -0.006, wisdom: 0.004, rhythm: -0.003 }, price: 6 },
  candy: { id: "candy", name: "Candy", nutrition: 0.6, joy: 0.12, nudge: { mood: 0.006, tempo: 0.004, vitality: -0.004, appetite: 0.004 }, price: 2 },
  seaweed: { id: "seaweed", name: "Seaweed", nutrition: 0.8, joy: 0.01, nudge: { moisture: 0.005, conductivity: 0.004 }, price: 5 },
  iceCream: { id: "iceCream", name: "Ice cream", nutrition: 0.7, joy: 0.1, nudge: { heat: -0.006, mood: 0.004 }, price: 4 },
  coffeeBean: { id: "coffeeBean", name: "Coffee bean", nutrition: 0.2, joy: 0.03, nudge: { tempo: 0.006, rhythm: 0.004, conviction: 0.002 }, price: 5 },
  glowFruit: { id: "glowFruit", name: "Glow fruit", nutrition: 1, joy: 0.06, nudge: { luminance: 0.008, focus: 0.003 }, price: 14 },
  ashRoot: { id: "ashRoot", name: "Ash root", nutrition: 0.9, joy: 0, nudge: { substance: -0.006, luminance: -0.003, form: 0.003 }, price: 16 },
  emberChili: { id: "emberChili", name: "Ember chili", nutrition: 0.5, joy: 0.03, nudge: { heat: 0.032, temper: 0.016 }, price: 18 },
  springWater: { id: "springWater", name: "Spring water", nutrition: 0.3, joy: 0.02, nudge: { moisture: 0.028, form: 0.014 }, price: 12 },
  stormBerry: { id: "stormBerry", name: "Storm berry", nutrition: 0.8, joy: 0.05, nudge: { conductivity: 0.028, tempo: 0.016 }, price: 20 },
  frostMint: { id: "frostMint", name: "Frost mint", nutrition: 0.4, joy: 0.04, nudge: { heat: -0.03, tempo: -0.006 }, price: 16 },
  ironNut: { id: "ironNut", name: "Iron nut", nutrition: 0.9, joy: 0, nudge: { hardness: 0.026, conductivity: 0.018, weight: 0.008 }, price: 22 },
  toxicCap: { id: "toxicCap", name: "Toxic cap", nutrition: 0.6, joy: -0.02, nudge: { vitality: -0.03, structure: -0.01 }, price: 24 },
  sunPetal: { id: "sunPetal", name: "Sun petal", nutrition: 0.6, joy: 0.06, nudge: { luminance: 0.032, rhythm: 0.01 }, price: 26 },
  nightPlum: { id: "nightPlum", name: "Night plum", nutrition: 0.9, joy: 0.03, nudge: { luminance: -0.028, rhythm: -0.018 }, price: 26 },
  mindLeaf: { id: "mindLeaf", name: "Mind leaf", nutrition: 0.5, joy: 0.02, nudge: { wisdom: 0.028, focus: 0.014 }, price: 28 },
  voidSalt: { id: "voidSalt", name: "Void salt", nutrition: 0.2, joy: 0, nudge: { substance: -0.03, phase: 0.01 }, price: 40 },
  stoneBread: { id: "stoneBread", name: "Stone bread", nutrition: 1.6, joy: 0.01, nudge: { hardness: 0.02, weight: 0.02, altitude: -0.016 }, price: 14 },
  cloudPuff: { id: "cloudPuff", name: "Cloud puff", nutrition: 0.5, joy: 0.07, nudge: { altitude: 0.03, weight: -0.02 }, price: 18 },
  seedCake: { id: "seedCake", name: "Seed cake", nutrition: 1.2, joy: 0.04, nudge: { vitality: 0.03, structure: 0.006 }, price: 12 },
};

export const EXPERIENCE_IDS = [
  "gymTraining",
  "swimming",
  "climbing",
  "socialPlay",
  "questDone",
  "travelKm",
  "nightWalk",
  "sunbathing",
  "meditation",
  "music",
  "petting",
  "digging",
  "flightTime",
  "puzzle",
  "rescue",
] as const;
export type ExperienceId = typeof EXPERIENCE_IDS[number];

export interface Experience {
  id: ExperienceId;
  name: string;
  /** Can only be earned by physically moving (GPS) rather than in the virtual space. */
  physicalOnly: boolean;
  xp: number;
  nudge: Partial<Record<AxisId, number>>;
}

export const EXPERIENCES: Record<ExperienceId, Experience> = {
  gymTraining: { id: "gymTraining", name: "Gym training", physicalOnly: true, xp: 30, nudge: { might: 0.01, hardness: 0.004, tempo: 0.002 } },
  swimming: { id: "swimming", name: "Swimming", physicalOnly: false, xp: 15, nudge: { moisture: 0.008, elasticity: 0.003 } },
  climbing: { id: "climbing", name: "Climbing", physicalOnly: true, xp: 20, nudge: { altitude: 0.008, might: 0.003, conviction: 0.003 } },
  socialPlay: { id: "socialPlay", name: "Play with friends' Genemon", physicalOnly: false, xp: 10, nudge: { sociality: 0.01, mood: 0.004 } },
  questDone: { id: "questDone", name: "Quest completed", physicalOnly: false, xp: 50, nudge: { wisdom: 0.006, curiosity: 0.004, conviction: 0.003 } },
  travelKm: { id: "travelKm", name: "Kilometre travelled", physicalOnly: true, xp: 8, nudge: { curiosity: 0.005, tempo: 0.003 } },
  nightWalk: { id: "nightWalk", name: "Night walk", physicalOnly: true, xp: 12, nudge: { rhythm: -0.01, luminance: -0.004, conviction: 0.003 } },
  sunbathing: { id: "sunbathing", name: "Sunbathing", physicalOnly: true, xp: 6, nudge: { luminance: 0.006, heat: 0.004, rhythm: 0.004 } },
  meditation: { id: "meditation", name: "Meditation", physicalOnly: false, xp: 10, nudge: { wisdom: 0.008, temper: -0.006, structure: 0.004 } },
  music: { id: "music", name: "Music session", physicalOnly: false, xp: 6, nudge: { mood: 0.008, rhythm: 0.002 } },
  petting: { id: "petting", name: "Petting", physicalOnly: false, xp: 2, nudge: { mood: 0.006, conviction: 0.004, sociality: 0.002 } },
  digging: { id: "digging", name: "Digging", physicalOnly: false, xp: 8, nudge: { altitude: -0.008, hardness: 0.003 } },
  flightTime: { id: "flightTime", name: "Flight time", physicalOnly: false, xp: 8, nudge: { altitude: 0.01, weight: -0.004 } },
  puzzle: { id: "puzzle", name: "Puzzle solved", physicalOnly: false, xp: 12, nudge: { wisdom: 0.008, focus: 0.004 } },
  rescue: { id: "rescue", name: "Rescued a released Genemon", physicalOnly: true, xp: 40, nudge: { sociality: 0.006, conviction: 0.006, luminance: 0.003 } },
};

/** Axis nudges per hour spent on each ground type (space / habitat influence). */
export const GROUND_EXPOSURE: Partial<Record<GroundId, Partial<Record<AxisId, number>>>> = {
  grass: { vitality: 0.004 },
  moss: { vitality: 0.004, moisture: 0.002 },
  water: { moisture: 0.008, elasticity: 0.002 },
  deepWater: { moisture: 0.01, altitude: -0.004, conviction: 0.002 },
  muddyWater: { moisture: 0.005, substance: 0.002 },
  mud: { moisture: 0.004, hardness: -0.002 },
  sand: { moisture: -0.006, heat: 0.003 },
  stone: { hardness: 0.005, weight: 0.002 },
  gravel: { hardness: 0.003 },
  snow: { heat: -0.007 },
  ice: { heat: -0.009, hardness: 0.002 },
  lava: { heat: 0.01, luminance: 0.003 },
  metal: { conductivity: 0.006, hardness: 0.003 },
  ash: { heat: 0.004, luminance: -0.004 },
  crystal: { luminance: 0.006, wisdom: 0.003 },
  salt: { conductivity: 0.004, moisture: -0.003 },
  soil: { substance: 0.003, vitality: 0.002 },
};
