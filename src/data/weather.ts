/**
 * Weather: global conditions of an arena or world cell. Real local time and (later) real weather
 * feed the world's weather; some Genemon moves CHANGE the weather mid-battle.
 */
import type { ElementId } from "./elements.ts";

export const WEATHER_IDS = [
  "clear",
  "heatwave",
  "rain",
  "storm",
  "snow",
  "fog",
  "wind",
  "sandstorm",
  "aurora",
  "eclipse",
  "acidRain",
  "ashfall",
] as const;
export type WeatherId = typeof WEATHER_IDS[number];

export interface Weather {
  id: WeatherId;
  name: string;
  elementMult: Partial<Record<ElementId, number>>;
  /** 1 = perfect visibility; scales accuracy of ranged attacks. */
  visibility: number;
  /** Wetness added to every fighter (electric conduction, fire resistance). */
  wetness: number;
  temperature: number;
  /** Wind strength (m/s-ish) pushing projectiles and light bodies along +X. */
  wind: number;
  frictionMult: number;
  particles: "none" | "rain" | "snow" | "sand" | "ash" | "sparkle" | "leaves";
  fog: number;
  sky: [number, number];
  light: number;
  note: string;
}

export const WEATHERS: Record<WeatherId, Weather> = {
  clear: { id: "clear", name: "Clear", elementMult: {}, visibility: 1, wetness: 0, temperature: 0, wind: 0.5, frictionMult: 1, particles: "none", fog: 0.004, sky: [0x5aa0e6, 0xcfe8ff], light: 1, note: "No modifiers." },
  heatwave: { id: "heatwave", name: "Heatwave", elementMult: { fire: 1.3, plant: 0.9, ice: 0.7, water: 0.9 }, visibility: 0.95, wetness: -0.2, temperature: 0.8, wind: 0.3, frictionMult: 1, particles: "none", fog: 0.006, sky: [0xff9a4a, 0xffe2b0], light: 1.2, note: "Fire strengthened, ice weakened; ice ground melts faster." },
  rain: { id: "rain", name: "Rain", elementMult: { water: 1.25, fire: 0.75, electric: 1.1 }, visibility: 0.85, wetness: 0.5, temperature: -0.1, wind: 1.5, frictionMult: 0.85, particles: "rain", fog: 0.012, sky: [0x56606e, 0xa4adb8], light: 0.7, note: "Everyone gets wet: electric conducts, fire fizzles." },
  storm: { id: "storm", name: "Thunderstorm", elementMult: { electric: 1.35, water: 1.15, fire: 0.7, air: 1.1 }, visibility: 0.7, wetness: 0.7, temperature: -0.1, wind: 4, frictionMult: 0.8, particles: "rain", fog: 0.016, sky: [0x2c3240, 0x6b7280], light: 0.5, note: "Random lightning strikes; flyers buffeted by wind." },
  snow: { id: "snow", name: "Snow", elementMult: { ice: 1.3, fire: 0.85, plant: 0.85 }, visibility: 0.8, wetness: 0.2, temperature: -0.7, wind: 1, frictionMult: 0.75, particles: "snow", fog: 0.014, sky: [0xb8c4d0, 0xeef3f8], light: 0.85, note: "Cold slows non-ice Genemon; water freezes over time." },
  fog: { id: "fog", name: "Fog", elementMult: { shadow: 1.15, light: 0.9 }, visibility: 0.55, wetness: 0.2, temperature: -0.1, wind: 0.2, frictionMult: 1, particles: "none", fog: 0.05, sky: [0x8a9099, 0xc7ccd2], light: 0.6, note: "Ranged accuracy collapses: close combat rules." },
  wind: { id: "wind", name: "Gale", elementMult: { air: 1.3, fire: 1.05 }, visibility: 0.95, wetness: 0, temperature: 0, wind: 6, frictionMult: 1, particles: "leaves", fog: 0.004, sky: [0x6aa8d8, 0xd8ecf8], light: 1, note: "Projectiles drift; light Genemon are pushed around." },
  sandstorm: { id: "sandstorm", name: "Sandstorm", elementMult: { earth: 1.2, air: 1.1, water: 0.9 }, visibility: 0.6, wetness: -0.3, temperature: 0.3, wind: 5, frictionMult: 0.9, particles: "sand", fog: 0.03, sky: [0xc89a5a, 0xe8cfa0], light: 0.8, note: "Abrasive: chip damage to non-earth, non-metal Genemon." },
  aurora: { id: "aurora", name: "Aurora", elementMult: { light: 1.2, psychic: 1.2, electric: 1.1 }, visibility: 0.9, wetness: 0, temperature: -0.4, wind: 0.5, frictionMult: 1, particles: "sparkle", fog: 0.006, sky: [0x0d1b3a, 0x2ee6a6], light: 0.6, note: "Rare night event: minds and light amplified." },
  eclipse: { id: "eclipse", name: "Eclipse", elementMult: { shadow: 1.3, void: 1.25, light: 0.75 }, visibility: 0.65, wetness: 0, temperature: -0.2, wind: 0.3, frictionMult: 1, particles: "none", fog: 0.012, sky: [0x101018, 0x3a2f55], light: 0.35, note: "Darkness rises: shadow and void thrive." },
  acidRain: { id: "acidRain", name: "Acid rain", elementMult: { poison: 1.3, metal: 0.85, plant: 0.85 }, visibility: 0.8, wetness: 0.5, temperature: 0, wind: 1.5, frictionMult: 0.85, particles: "rain", fog: 0.014, sky: [0x5b6b3a, 0xb6c48a], light: 0.7, note: "Corrodes metal and plants; poison loves it." },
  ashfall: { id: "ashfall", name: "Ashfall", elementMult: { fire: 1.15, earth: 1.1, air: 0.9 }, visibility: 0.7, wetness: -0.1, temperature: 0.4, wind: 1, frictionMult: 0.95, particles: "ash", fog: 0.025, sky: [0x4a3c38, 0x9a7f70], light: 0.6, note: "Volcanic fallout: fire and earth empowered." },
};
