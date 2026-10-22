/**
 * Pass-4 move kit [P4-M1, P4-M2, P4-M5, P4-M7]: ~47 new moves, each one bound to a CATEGORY
 * (physical / special / status), a BODY PART (its power follows that part's genes, see
 * `bodyFactor` in ./kit.ts) and a League-style SLOT (Q basic, W control, E mobility, R ultimate).
 *
 * Timing follows the PHASE LAW [P4-M5]: every row's charge / active / rest is computed from its
 * power, area and number of effects by `phaseLaw` (defined here so this table can use it without an
 * import cycle; ./kit.ts re-exports it). Strong moves are slow in all three phases, fast moves are
 * short in all three, hit little and spread little.
 */
import type { ElementId } from "../data/elements.ts";
import { type BodyPart, type KitSlot, kb, type Move, type MoveCategory, type MoveEffect, type MoveShape, mv, pull, st } from "./moves.ts";

/** Piecewise-linear interpolation through sorted knots [x, y]. */
function interp(knots: readonly (readonly [number, number])[], x: number, tailSlope: number): number {
  if (x <= knots[0][0]) return knots[0][1];
  for (let i = 1; i < knots.length; i++) {
    const [x1, y1] = knots[i];
    if (x <= x1) {
      const [x0, y0] = knots[i - 1];
      return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
    }
  }
  const [xl, yl] = knots[knots.length - 1];
  return yl + tailSlope * (x - xl);
}

const CHARGE_KNOTS = [[0, 0.22], [28, 0.25], [60, 0.6], [100, 1.4], [140, 2.4]] as const;
const ACTIVE_KNOTS = [[0, 0.1], [28, 0.12], [60, 0.25], [100, 0.55], [140, 0.9]] as const;
const REST_KNOTS = [[0, 0.25], [28, 0.3], [60, 0.6], [100, 1.25], [140, 2.0]] as const;

/**
 * The phase law [P4-M5]: (charge, active, rest) in seconds as a function of power, area radius (m)
 * and the number of effects. Monotone non-decreasing in each argument. Anchors: ~(0.25, 0.12, 0.3)
 * at power 28, ~(0.6, 0.25, 0.6) at 60, ~(2.4, 0.9, 2.0) at 140 (slow growth beyond). Area and
 * effects lengthen every phase slightly (up to +18 % and +12 %).
 */
export function phaseLaw(power: number, area = 0, effects = 0): { charge: number; active: number; rest: number } {
  const p = Math.max(0, power);
  const k = 1 + 0.03 * Math.min(6, Math.max(0, area)) + 0.04 * Math.min(3, Math.max(0, effects));
  const r = (x: number) => Math.round(x * 1000) / 1000;
  return {
    charge: r(interp(CHARGE_KNOTS, p, 0.005) * k),
    active: r(interp(ACTIVE_KNOTS, p, 0.003) * k),
    rest: r(interp(REST_KNOTS, p, 0.004) * k),
  };
}

interface KitExtra {
  category: MoveCategory;
  part: BodyPart;
  slot: KitSlot;
  arc?: number;
  tags?: string[];
  requires?: Move["requires"];
}

/** One kit row: the phases come from the law, the rest is the classic `mv` row. */
function km(
  id: string,
  name: string,
  element: ElementId,
  shape: MoveShape,
  power: number,
  accuracy: number,
  range: number,
  area: number,
  speed: number,
  effects: MoveEffect[],
  tier: 1 | 2 | 3,
  extra: KitExtra,
): Move {
  const t = phaseLaw(power, area, effects.length);
  return mv(id, name, element, shape, power, accuracy, range, area, speed, t.charge, t.active, t.rest, effects, tier, extra);
}

/** A breath cone: special, from the mouth. `area` is the cone's mean half-width (pricing + AI). */
function breath(id: string, name: string, element: ElementId, power: number, range: number, arc: number, effects: MoveEffect[], tier: 1 | 2 = 1, part: BodyPart = "mouth"): Move {
  const area = Math.round(range * Math.sin(arc) * 0.5 * 10) / 10;
  return km(id, name, element, "cone", power, 0.95, range, area, 0, effects, tier, { category: "special", part, slot: "basic", arc, tags: ["breath"] });
}

/** A dash: physical, the body travels `range` metres at `speed` m/s and strikes on arrival. */
function dash(id: string, name: string, element: ElementId, power: number, range: number, speed: number, effects: MoveEffect[], tier: 1 | 2 = 1, part: BodyPart = "legs", tags: string[] = []): Move {
  return km(id, name, element, "dash", power, 0.95, range, 0, speed, effects, tier, { category: "physical", part, slot: "mobility", tags: ["dash", ...tags] });
}

/** An ultimate: tier 3, slot R, tagged "ultimate". */
function ult(id: string, name: string, element: ElementId, shape: MoveShape, power: number, accuracy: number, range: number, area: number, speed: number, effects: MoveEffect[], category: MoveCategory, part: BodyPart, tags: string[] = []): Move {
  return km(id, name, element, shape, power, accuracy, range, area, speed, effects, 3, { category, part, slot: "ultimate", tags: ["ultimate", ...tags] });
}

const P = (part: BodyPart, slot: KitSlot = "basic", tags: string[] = []): KitExtra => ({ category: "physical", part, slot, tags });
const S = (part: BodyPart, slot: KitSlot = "basic", tags: string[] = []): KitExtra => ({ category: "special", part, slot, tags });

export const KIT_MOVES: readonly Move[] = [
  // ------------------------------------------------ breath cones (Q, special, mouth) [P4-M2]
  breath("fireBreath", "Fire Breath", "fire", 56, 6, 0.45, [st("burn", 0.35, 3)]),
  breath("frostBreath", "Frost Breath", "ice", 54, 5.5, 0.4, [st("slowed", 0.4, 2.5), st("frozen", 0.15, 1.2)]),
  breath("toxicBreath", "Toxic Breath", "poison", 48, 5, 0.5, [st("poisoned", 0.6, 5)]),
  breath("steamBreath", "Steam Breath", "water", 58, 5, 0.5, [st("burn", 0.25, 3), st("wet", 0.7, 4)], 2),
  breath("sandBreath", "Sand Breath", "earth", 46, 5, 0.55, [st("blinded", 0.5, 2.5)]),
  breath("sparkBreath", "Spark Breath", "electric", 52, 6, 0.4, [st("paralyzed", 0.25, 2)]),
  breath("shadowMist", "Shadow Mist", "shadow", 44, 4.5, 0.6, [st("feared", 0.45, 2.5)], 2),
  breath("psychicWave", "Psychic Wave", "psychic", 52, 7, 0.45, [st("confused", 0.35, 2)], 2, "eyes"),

  // ------------------------------------------------ physical basics (Q) [P4-M1]
  km("slice", "Slice", "neutral", "melee", 32, 0.98, 0.3, 0, 0, [], 1, P("claws")),
  km("crunch", "Crunch", "neutral", "melee", 46, 0.95, 0, 0, 0, [st("softened", 0.2, 3)], 1, P("jaw")),
  km("rendingClaws", "Rending Claws", "shadow", "melee", 58, 0.93, 0.3, 0, 0, [st("softened", 0.3, 3)], 2, P("claws", "basic", ["highCrit"])),
  km("hornGore", "Horn Gore", "neutral", "melee", 62, 0.9, 0.4, 0, 0, [kb(3), st("staggered", 0.25, 1)], 2, P("horns")),
  km("tailWhip", "Tail Whip", "neutral", "melee", 40, 0.96, 1.2, 0, 0, [kb(4)], 1, P("tail")),
  km("wingBuffet", "Wing Buffet", "air", "burst", 42, 0.97, 0, 2.2, 0, [kb(3)], 1, P("wings")),
  km("crushingWeight", "Crushing Weight", "neutral", "melee", 76, 0.88, 0, 0, 0, [st("staggered", 0.35, 1.2)], 2, P("mass", "basic", ["massScaled"])),

  // ------------------------------------------------ dashes (E, physical, range = dash distance)
  dash("quickDash", "Quick Dash", "neutral", 30, 7, 18, []),
  dash("flameDash", "Flame Dash", "fire", 48, 8, 16, [st("burn", 0.25, 3)]),
  dash("aquaJet", "Aqua Jet", "water", 44, 8, 20, [st("wet", 0.5, 4)]),
  dash("voltRush", "Volt Rush", "electric", 46, 9, 24, [st("paralyzed", 0.2, 1.5)]),
  dash("galeDash", "Gale Dash", "air", 42, 10, 22, [kb(2)]),
  dash("iceSlide", "Ice Slide", "ice", 44, 9, 20, [st("slowed", 0.3, 2)]),
  dash("shadowStep", "Shadow Step", "shadow", 46, 9, 30, [st("evasive", 1, 1.5, true)], 2, "legs", ["highCrit"]),
  dash("hornCharge", "Horn Charge", "neutral", 60, 8, 15, [kb(4), st("stunned", 0.3, 1)], 2, "horns"),
  dash("rollingCharge", "Rolling Charge", "neutral", 64, 9, 13, [kb(5), st("staggered", 0.3, 1)], 2, "mass", ["massScaled"]),

  // ------------------------------------------------ control (W): stuns, binds, fear [P4-M6]
  km("thunderClap", "Thunder Clap", "electric", "burst", 36, 0.97, 0, 3, 0, [st("stunned", 0.55, 1)], 2, S("aura", "control")),
  km("headbutt", "Headbutt", "neutral", "melee", 45, 0.93, 0, 0, 0, [st("stunned", 0.5, 0.8)], 1, P("mass", "control")),
  km("shieldBash", "Shield Bash", "metal", "melee", 42, 0.94, 0, 0, 0, [st("stunned", 0.5, 1), kb(2)], 1, P("mass", "control")),
  km("tailSweep", "Tail Sweep", "neutral", "burst", 38, 0.96, 0, 2, 0, [st("stunned", 0.45, 0.9), kb(2)], 1, P("tail", "control")),
  km("petrifyGaze", "Petrify Gaze", "earth", "beam", 30, 0.92, 11, 0, 0, [st("stunned", 0.6, 1.4)], 2, S("eyes", "control")),
  km("frostBind", "Frost Bind", "ice", "zone", 30, 0.95, 10, 1.8, 14, [st("frozen", 0.7, 1.5)], 2, S("aura", "control")),
  km("vineSnare", "Vine Snare", "plant", "zone", 28, 0.95, 10, 1.8, 14, [st("slowed", 0.8, 3), st("stunned", 0.5, 0.8)], 2, S("aura", "control")),
  km("mindLock", "Mind Lock", "psychic", "beam", 25, 0.95, 12, 0, 0, [st("stunned", 0.65, 1.6)], 2, S("eyes", "control")),
  km("dreadHowl", "Dread Howl", "shadow", "burst", 25, 1, 0, 4, 0, [st("feared", 0.7, 3), st("stunned", 0.3, 0.8)], 2, S("mouth", "control")),

  // ------------------------------------------------ ultimates (R, tier 3, very long phases) [P4-M5]
  ult("meteor", "Meteor", "fire", "zone", 150, 0.9, 13, 2.4, 10, [st("burn", 0.6, 4), kb(4)], "special", "aura"),
  ult("tsunami", "Tsunami", "water", "zone", 135, 0.92, 12, 2.6, 0, [st("wet", 1, 6), kb(7)], "special", "aura"),
  ult("worldTree", "World Tree", "plant", "zone", 120, 0.95, 10, 2.6, 0, [st("slowed", 0.5, 3), st("regen", 1, 6, true)], "special", "aura"),
  ult("earthshatter", "Earthshatter", "earth", "burst", 150, 0.95, 0, 3.6, 0, [st("staggered", 0.6, 1.4)], "physical", "legs", ["ground"]),
  ult("hurricane", "Hurricane", "air", "zone", 130, 0.9, 12, 2.6, 0, [kb(6), st("staggered", 0.4, 1)], "special", "aura"),
  ult("stormLance", "Storm Lance", "electric", "beam", 145, 0.88, 16, 0, 0, [st("paralyzed", 0.5, 2)], "special", "aura"),
  ult("avalanche", "Avalanche", "ice", "zone", 140, 0.9, 12, 2.4, 0, [st("frozen", 0.4, 1.6), st("slowed", 0.5, 3)], "special", "aura"),
  ult("ironMaiden", "Iron Maiden", "metal", "burst", 130, 0.95, 0, 2.6, 0, [st("staggered", 0.5, 1.2), st("shielded", 1, 4, true)], "special", "aura"),
  ult("plague", "Plague", "poison", "zone", 125, 0.92, 11, 2.6, 0, [st("poisoned", 1, 6), st("softened", 0.4, 4)], "special", "aura"),
  ult("supernova", "Supernova", "light", "burst", 155, 0.95, 0, 3.6, 0, [st("blinded", 0.7, 3)], "special", "aura"),
  ult("eclipseFall", "Eclipse Fall", "shadow", "zone", 140, 0.9, 13, 2.4, 0, [st("feared", 0.5, 3)], "special", "aura"),
  ult("mindCrush", "Mind Crush", "psychic", "beam", 140, 0.9, 15, 0, 0, [st("confused", 0.5, 3), st("stunned", 0.3, 1)], "special", "eyes"),
  ult("blackHole", "Black Hole", "void", "zone", 135, 0.9, 12, 2.6, 0, [pull(8), st("staggered", 0.4, 1)], "special", "aura"),
  ult("titanSlam", "Titan Slam", "neutral", "burst", 160, 0.92, 0, 3, 0, [st("stunned", 0.4, 1.2), kb(6)], "physical", "mass", ["massScaled", "ground"]),
];

export const KIT_MOVE_BY_ID: Record<string, Move> = Object.fromEntries(KIT_MOVES.map((m) => [m.id, m]));
