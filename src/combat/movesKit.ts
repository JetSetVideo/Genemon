/**
 * Pass-4 move kit [P4-M1, P4-M2, P4-M5, P4-M7]: ~59 new moves, each one bound to a CATEGORY
 * (physical / special / status), a BODY PART (its power follows that part's genes, see
 * `bodyFactor` in ./kit.ts) and a League-style SLOT (Q basic, W control, E mobility, R ultimate).
 *
 * Timing follows the PHASE LAW [P4-M5]: every row's charge / active / rest is computed from its
 * power, area and number of effects by `phaseLaw` (defined in ./moves.ts, which also re-times the
 * legacy damaging rows with it; ./kit.ts re-exports it). Strong moves are slow in all three phases,
 * fast moves are short in all three, hit little and spread little.
 */
import type { ElementId } from "../data/elements.ts";
import { type BodyPart, type KitSlot, kb, type Move, type MoveCategory, type MoveEffect, type MoveShape, mv, phaseLaw, pull, st, tameEffects } from "./moves.ts";

export { phaseLaw };

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
  return mv(id, name, element, shape, power, accuracy, range, area, speed, t.charge, t.active, t.rest, tameEffects(effects), tier, extra);
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
  breath("frostBreath", "Frost Breath", "ice", 54, 5.5, 0.4, [st("slowed", 0.4, 2.5)]),
  breath("toxicBreath", "Toxic Breath", "poison", 48, 5, 0.5, [st("poisoned", 0.6, 5)]),
  breath("steamBreath", "Steam Breath", "water", 58, 5, 0.5, [st("wet", 0.7, 4)], 2),
  breath("sandBreath", "Sand Breath", "earth", 46, 5, 0.55, [st("blinded", 0.5, 2.5)]),
  breath("sparkBreath", "Spark Breath", "electric", 52, 6, 0.4, [st("paralyzed", 0.25, 2)]),
  breath("shadowMist", "Shadow Mist", "shadow", 44, 4.5, 0.6, [st("feared", 0.45, 2.5)], 2),
  breath("psychicWave", "Psychic Wave", "psychic", 52, 7, 0.45, [st("confused", 0.35, 2)], 2, "eyes"),

  // ------------------------------------------------ physical basics (Q) [P4-M1]
  km("slice", "Slice", "neutral", "melee", 32, 0.98, 0.3, 0, 0, [], 1, P("claws")),
  km("crunch", "Crunch", "neutral", "melee", 46, 0.95, 0, 0, 0, [st("softened", 0.2, 3)], 1, P("jaw")),
  km("rendingClaws", "Rending Claws", "shadow", "melee", 58, 0.93, 0.3, 0, 0, [st("softened", 0.3, 3)], 2, P("claws", "basic", ["highCrit"])),
  km("hornGore", "Horn Gore", "neutral", "melee", 62, 0.9, 0.4, 0, 0, [kb(3)], 2, P("horns")),
  km("tailWhip", "Tail Whip", "neutral", "melee", 40, 0.96, 1.2, 0, 0, [kb(4)], 1, P("tail")),
  km("wingBuffet", "Wing Buffet", "air", "burst", 42, 0.97, 0, 2.2, 0, [kb(3)], 1, P("wings")),
  km("crushingWeight", "Crushing Weight", "neutral", "melee", 76, 0.88, 0, 0, 0, [st("staggered", 0.35, 1.2)], 2, P("mass", "basic", ["massScaled"])),

  // ------------------------------------------------ dashes (E, physical, range = dash distance)
  dash("quickDash", "Quick Dash", "neutral", 30, 7, 18, []),
  dash("flameDash", "Flame Dash", "fire", 52, 8, 16, [st("burn", 0.35, 3)]),
  dash("aquaJet", "Aqua Jet", "water", 44, 8, 20, [st("wet", 0.5, 4)]),
  dash("voltRush", "Volt Rush", "electric", 46, 9, 24, [st("paralyzed", 0.2, 1.5)]),
  dash("galeDash", "Gale Dash", "air", 42, 10, 22, [kb(2)]),
  dash("iceSlide", "Ice Slide", "ice", 44, 9, 20, [st("slowed", 0.3, 2)]),
  dash("shadowStep", "Shadow Step", "shadow", 46, 9, 30, [st("evasive", 1, 1.5, true)], 2, "legs", ["highCrit"]),
  dash("hornCharge", "Horn Charge", "neutral", 54, 8, 15, [kb(4)], 2, "horns"),
  dash("rollingCharge", "Rolling Charge", "neutral", 56, 9, 13, [kb(5)], 2, "mass", ["massScaled"]),
  // Every element owns a dash, so E is not a neutral move by default (neutral is resisted by earth,
  // metal and void, which made those three win on defence alone).
  dash("thornRush", "Thorn Rush", "plant", 44, 8, 16, [st("slowed", 0.3, 2)]),
  dash("steelCharge", "Steel Charge", "metal", 40, 8, 15, [kb(4)], 1, "mass"),
  dash("venomLunge", "Venom Lunge", "poison", 42, 8, 20, [st("poisoned", 0.6, 4)], 1, "jaw"),
  dash("flashStep", "Flash Step", "light", 42, 10, 32, [st("blinded", 0.3, 1.5)]),
  dash("psiBlink", "Psi Blink", "psychic", 40, 9, 30, [st("confused", 0.25, 2)]),
  dash("riftDash", "Rift Dash", "void", 44, 9, 28, [st("softened", 0.3, 3)]),

  // ------------------------------------------------ control (W): stuns, binds, fear [P4-M6]
  // One rider per move [P5-B1]: a control zone's rider is its stun / freeze, which lands with the CAST
  // (it can interrupt); the lingering field re-applies only a SOFT rider (kit.ts fieldStatus), so a
  // stun zone leaves a harmless field and cannot stun-lock (measured in pass 4: frost / stun fields
  // carried ice, water and void to 60-70 % on their own).
  km("thunderClap", "Thunder Clap", "electric", "burst", 36, 0.97, 0, 3, 0, [st("stunned", 0.55, 1)], 2, S("aura", "control")),
  km("headbutt", "Headbutt", "neutral", "melee", 45, 0.93, 0, 0, 0, [st("stunned", 0.5, 0.8)], 1, P("mass", "control")),
  km("shieldBash", "Shield Bash", "metal", "melee", 40, 0.86, 0, 0, 0, [st("stunned", 0.5, 0.9)], 1, P("mass", "control")),
  km("tailSweep", "Tail Sweep", "neutral", "burst", 38, 0.96, 0, 2, 0, [st("stunned", 0.45, 0.9)], 1, P("tail", "control")),
  km("petrifyGaze", "Petrify Gaze", "earth", "beam", 30, 0.92, 11, 0, 0, [st("stunned", 0.55, 1.2)], 2, S("eyes", "control")),
  km("frostBind", "Frost Bind", "ice", "zone", 30, 0.95, 10, 1.8, 14, [st("frozen", 0.55, 1.2)], 2, S("aura", "control")),
  km("vineSnare", "Vine Snare", "plant", "zone", 32, 0.95, 10, 1.8, 14, [st("stunned", 0.5, 0.8)], 2, S("aura", "control")),
  km("mindLock", "Mind Lock", "psychic", "beam", 25, 0.9, 11, 0, 0, [st("stunned", 0.55, 1.2)], 2, S("eyes", "control")),
  km("dreadHowl", "Dread Howl", "shadow", "burst", 25, 1, 0, 4, 0, [st("feared", 0.7, 3)], 2, S("mouth", "control")),
  // Every element owns a W, so control is not a neutral Headbutt by default.
  km("flareBurst", "Flare Burst", "fire", "burst", 34, 0.97, 0, 2.5, 0, [st("stunned", 0.5, 0.8)], 2, S("aura", "control")),
  km("whirlpool", "Whirlpool", "water", "zone", 30, 0.95, 10, 1.8, 14, [st("stunned", 0.5, 0.8)], 2, S("aura", "control")),
  km("downdraft", "Downdraft", "air", "zone", 30, 0.95, 11, 1.8, 18, [st("stunned", 0.5, 0.8)], 2, S("aura", "control")),
  km("nerveSpit", "Nerve Spit", "poison", "projectile", 36, 0.97, 10, 0, 18, [st("stunned", 0.5, 0.8)], 1, S("mouth", "control")),
  km("blindingFlash", "Blinding Flash", "light", "burst", 32, 1, 0, 3, 0, [st("stunned", 0.5, 0.8)], 2, S("eyes", "control")),
  km("voidGrip", "Void Grip", "void", "zone", 30, 0.93, 11, 1.6, 0, [st("stunned", 0.5, 0.8)], 2, S("aura", "control")),

  // ------------------------------------------------ ultimates (R, tier 3, very long phases) [P4-M5]
  ult("meteor", "Meteor", "fire", "zone", 150, 0.9, 13, 2.4, 10, [st("burn", 0.6, 4)], "special", "aura"),
  ult("tsunami", "Tsunami", "water", "zone", 135, 0.92, 12, 2.6, 0, [st("wet", 1, 6)], "special", "aura"),
  ult("worldTree", "World Tree", "plant", "zone", 120, 0.95, 10, 2.6, 0, [st("regen", 1, 6, true)], "special", "aura"),
  ult("earthshatter", "Earthshatter", "earth", "burst", 150, 0.95, 0, 3.6, 0, [st("staggered", 0.6, 1.4)], "physical", "legs", ["ground"]),
  ult("hurricane", "Hurricane", "air", "zone", 130, 0.9, 12, 2.6, 0, [kb(6)], "special", "aura"),
  ult("stormLance", "Storm Lance", "electric", "beam", 145, 0.88, 16, 0, 0, [st("paralyzed", 0.5, 2)], "special", "aura"),
  ult("avalanche", "Avalanche", "ice", "zone", 140, 0.9, 12, 2.4, 0, [st("slowed", 0.5, 3)], "special", "aura"),
  ult("ironMaiden", "Iron Maiden", "metal", "burst", 130, 0.95, 0, 2.6, 0, [st("staggered", 0.5, 1.2)], "special", "aura"),
  ult("plague", "Plague", "poison", "zone", 125, 0.92, 11, 2.6, 0, [st("poisoned", 1, 6)], "special", "aura"),
  ult("supernova", "Supernova", "light", "burst", 155, 0.95, 0, 3.6, 0, [st("blinded", 0.7, 3)], "special", "aura"),
  ult("eclipseFall", "Eclipse Fall", "shadow", "zone", 140, 0.9, 13, 2.4, 0, [st("feared", 0.5, 3)], "special", "aura"),
  ult("mindCrush", "Mind Crush", "psychic", "beam", 140, 0.9, 15, 0, 0, [st("confused", 0.5, 3)], "special", "eyes"),
  ult("blackHole", "Black Hole", "void", "zone", 135, 0.9, 12, 2.6, 0, [pull(8)], "special", "aura"),
  ult("titanSlam", "Titan Slam", "neutral", "burst", 160, 0.92, 0, 3, 0, [kb(6)], "physical", "mass", ["massScaled", "ground"]),
];

export const KIT_MOVE_BY_ID: Record<string, Move> = Object.fromEntries(KIT_MOVES.map((m) => [m.id, m]));
