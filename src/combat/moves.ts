/**
 * Moves: the attack catalogue, the 3-phase timing (charge -> active -> rest), and the COST SYSTEM.
 * Energy cost is computed from power, area, range, accuracy, charge speed, effects, element rarity
 * and the live META (moves used a lot on the ladder get pricier, forgotten ones cheaper) so no move
 * is free power and the meta keeps moving. See docs/GAMEPLAY.md#moves.
 */
import { clamp } from "../core/math.ts";
import type { ElementId } from "../data/elements.ts";
import type { GroundId } from "../data/grounds.ts";
import type { WeatherId } from "../data/weather.ts";
import type { BodyKind } from "../genome/genome.ts";
import type { Abilities } from "../genome/phenotype.ts";

export type MoveShape =
  | "melee"
  | "projectile"
  | "beam"
  | "burst"
  | "zone"
  | "buff"
  | "heal"
  | "weather"
  | "terrain"
  | "dig"
  | "fly"
  | "phase"
  /** A cone breathed or sprayed from the mouth (special): every enemy inside the arc and range. */
  | "cone"
  /** A dash: the body itself travels to the target and strikes on arrival (physical, mobility). */
  | "dash";

/** Damage category: PHYSICAL hits with the body (scaled by size, weight, claws, horns), SPECIAL
 * channels the element through an organ (mouth, eyes, aura), STATUS deals no direct damage. */
export type MoveCategory = "physical" | "special" | "status";
/** The body part a move is delivered by: its power and learnability follow that part's genes. */
export type BodyPart = "mouth" | "jaw" | "claws" | "horns" | "tail" | "wings" | "mass" | "eyes" | "aura" | "legs";
/** League-style kit slot: Q basic, W control (stun/snare), E mobility (dash/flight), R ultimate. */
export type KitSlot = "basic" | "control" | "mobility" | "ultimate" | "utility";

export const STATUS_IDS = [
  "burn",
  "wet",
  "frozen",
  "paralyzed",
  "poisoned",
  "slowed",
  "blinded",
  "feared",
  "confused",
  "staggered",
  "shielded",
  "hasted",
  "evasive",
  "focused",
  "softened",
  "airborne",
  "burrowed",
  "liquid",
  "regen",
  /** Hard crowd control: no action and no movement; interrupts a charge it lands on. */
  "stunned",
] as const;
export type StatusId = typeof STATUS_IDS[number];

export interface MoveEffect {
  kind: "status" | "knockback" | "pull" | "ground" | "weather" | "heal";
  status?: StatusId;
  chance?: number;
  duration?: number;
  value?: number;
  ground?: GroundId;
  weather?: WeatherId;
  self?: boolean;
}

export interface Move {
  id: string;
  name: string;
  element: ElementId;
  shape: MoveShape;
  power: number;
  accuracy: number;
  /** Max distance in metres; for melee, extra reach added to the body's own reach. */
  range: number;
  /** Area radius in metres (0 = single target). */
  area: number;
  /** Projectile speed m/s (0 = instant). */
  speed: number;
  charge: number;
  active: number;
  rest: number;
  effects: MoveEffect[];
  tags: string[];
  tier: 1 | 2 | 3;
  requires?: { ability?: keyof Abilities; kinds?: BodyKind[] };
  /** Pass-4 kit fields (optional on legacy rows; src/combat/kit.ts derives defaults). */
  category?: MoveCategory;
  part?: BodyPart;
  slot?: KitSlot;
  /** Cone half-angle in radians (shape "cone"). */
  arc?: number;
}

type Fx = MoveEffect[];
export const st = (status: StatusId, chance: number, duration = 3, self = false): MoveEffect => ({ kind: "status", status, chance, duration, self });
export const kb = (value: number): MoveEffect => ({ kind: "knockback", value });
export const pull = (value: number): MoveEffect => ({ kind: "pull", value });
export const wx = (weather: WeatherId, duration = 14): MoveEffect => ({ kind: "weather", weather, duration });
export const gr = (ground: GroundId): MoveEffect => ({ kind: "ground", ground });
export const heal = (value: number): MoveEffect => ({ kind: "heal", value, self: true });

export function mv(
  id: string,
  name: string,
  element: ElementId,
  shape: MoveShape,
  power: number,
  accuracy: number,
  range: number,
  area: number,
  speed: number,
  charge: number,
  active: number,
  rest: number,
  effects: Fx = [],
  tier: 1 | 2 | 3 = 1,
  extra: { tags?: string[]; requires?: Move["requires"]; category?: MoveCategory; part?: BodyPart; slot?: KitSlot; arc?: number } = {},
): Move {
  const tags = [...(extra.tags ?? [])];
  if (shape === "melee" || shape === "dash") tags.push("contact");
  const m: Move = { id, name, element, shape, power, accuracy, range, area, speed, charge, active, rest, effects, tags, tier, requires: extra.requires };
  if (extra.category) m.category = extra.category;
  if (extra.part) m.part = extra.part;
  if (extra.slot) m.slot = extra.slot;
  if (extra.arc !== undefined) m.arc = extra.arc;
  return m;
}

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

/**
 * Legacy rows are re-timed by the phase law at load [P4-M5]: a damaging row keeps its power, reach,
 * effects and identity, but its charge / active / rest come from `phaseLaw` (the hand-written timings
 * in the table below were faster than the law at equal power, so Q always picked legacy rows).
 * Utility rows (buff, heal, weather, phase, fly), the dig (its active phase IS the time underground)
 * and terraforming (a slow, deliberate act) keep their hand timings.
 */
function lawTimed(m: Move): Move {
  if (!isDamaging(m) || m.shape === "dig" || m.shape === "terrain") return m;
  return { ...m, ...phaseLaw(m.power, m.area, m.effects.length) };
}

const WS = { requires: { ability: "weatherShaper" as const } };
const TF = { requires: { ability: "terraformer" as const } };

export const MOVES: readonly Move[] = ([
  // neutral
  mv("tackle", "Tackle", "neutral", "melee", 40, 0.97, 0, 0, 0, 0.35, 0.2, 0.4, [kb(2)]),
  mv("bodySlam", "Body Slam", "neutral", "melee", 60, 0.9, 0, 0, 0, 0.8, 0.3, 0.8, [kb(5), st("staggered", 0.25, 1)], 2, { tags: ["massScaled"] }),
  mv("stomp", "Stomp", "neutral", "burst", 45, 0.95, 0, 2.2, 0, 0.6, 0.25, 0.6, [st("staggered", 0.3, 1)], 1, { tags: ["ground"] }),
  mv("roar", "Roar", "neutral", "burst", 0, 1, 0, 4.5, 0, 0.6, 0.4, 0.6, [st("feared", 0.6, 3)], 1),
  mv("rest", "Rest", "neutral", "heal", 0, 1, 0, 0, 0, 0.4, 1.2, 0.6, [heal(0.3)], 1),
  mv("meltForm", "Melt / Form", "neutral", "phase", 0, 1, 0, 0, 0, 0.5, 0.4, 0.4, [st("liquid", 1, 6, true)], 1, { requires: { ability: "phaseShift" } }),
  // fire
  mv("emberBite", "Ember Bite", "fire", "melee", 55, 0.95, 0, 0, 0, 0.45, 0.25, 0.5, [st("burn", 0.35)]),
  mv("cinderSpit", "Cinder Spit", "fire", "projectile", 45, 0.9, 12, 0, 16, 0.5, 0.2, 0.45, [st("burn", 0.3)]),
  mv("flameLance", "Flame Lance", "fire", "beam", 76, 0.88, 14, 0, 0, 0.9, 0.35, 0.8, [st("burn", 0.35)], 2),
  mv("scorchField", "Scorch Field", "fire", "zone", 38, 0.95, 10, 2.6, 12, 0.8, 0.3, 0.7, [st("burn", 0.4)], 2),
  mv("infernoBurst", "Inferno Burst", "fire", "burst", 135, 0.95, 0, 3.2, 0, 1.2, 0.35, 1.0, [st("burn", 0.3), kb(4)], 3),
  mv("heatwaveCall", "Heatwave Call", "fire", "weather", 0, 1, 0, 0, 0, 1.4, 0.3, 1.2, [wx("heatwave")], 2, WS),
  // water
  mv("tideSlam", "Tide Slam", "water", "melee", 55, 0.95, 0, 0, 0, 0.5, 0.25, 0.5, [kb(3), st("wet", 0.6, 5)]),
  mv("waterJet", "Water Jet", "water", "projectile", 45, 0.92, 12, 0, 20, 0.45, 0.2, 0.45, [st("wet", 0.7, 5)]),
  mv("hydroBeam", "Hydro Beam", "water", "beam", 72, 0.88, 14, 0, 0, 0.95, 0.35, 0.8, [st("wet", 0.8, 5), kb(2)], 2),
  mv("riptide", "Riptide", "water", "burst", 52, 0.95, 0, 3, 0, 0.8, 0.3, 0.7, [st("wet", 0.9, 5), st("slowed", 0.3)], 2),
  mv("geyser", "Geyser", "water", "zone", 125, 0.9, 11, 2.2, 0, 1.1, 0.4, 0.9, [kb(5), st("wet", 1, 6)], 3),
  mv("rainCall", "Rain Call", "water", "weather", 0, 1, 0, 0, 0, 1.4, 0.3, 1.2, [wx("rain")], 2, WS),
  // plant
  mv("vineLash", "Vine Lash", "plant", "melee", 54, 0.98, 2.5, 0, 0, 0.45, 0.3, 0.5, [pull(3)]),
  mv("seedShot", "Seed Shot", "plant", "projectile", 52, 0.97, 12, 0, 18, 0.4, 0.2, 0.4, [st("regen", 0.4, 4, true)]),
  mv("thornSpray", "Thorn Spray", "plant", "burst", 68, 0.95, 0, 2.8, 0, 0.8, 0.3, 0.7, [st("softened", 0.4, 4)], 2),
  mv("rootSnare", "Root Snare", "plant", "zone", 38, 0.95, 10, 2.4, 0, 0.7, 0.3, 0.6, [st("slowed", 0.8, 3)], 2),
  mv("sapMend", "Sap Mend", "plant", "heal", 0, 1, 0, 0, 0, 0.6, 0.8, 0.5, [heal(0.25), st("regen", 1, 5, true)], 1),
  mv("overgrowth", "Overgrowth", "plant", "terrain", 20, 1, 8, 4, 0, 1.0, 0.4, 0.8, [gr("grass"), st("regen", 1, 6, true)], 2, TF),
  mv("solarBloom", "Solar Bloom", "plant", "beam", 130, 0.9, 15, 0, 0, 1.5, 0.4, 1.0, [], 3),
  // earth
  mv("boulderCrush", "Boulder Crush", "earth", "melee", 65, 0.9, 0, 0, 0, 0.7, 0.3, 0.7, [kb(5), st("staggered", 0.3, 1)], 1),
  mv("rockToss", "Rock Toss", "earth", "projectile", 55, 0.88, 11, 0, 14, 0.7, 0.25, 0.6, [kb(2)]),
  mv("quake", "Quake", "earth", "burst", 135, 0.95, 0, 4, 0, 1.2, 0.4, 1.0, [st("staggered", 0.5, 1)], 3, { tags: ["ground"] }),
  mv("burrow", "Burrow", "earth", "dig", 60, 0.95, 0, 0, 0, 0.6, 2.2, 0.6, [st("burrowed", 1, 2.2, true), kb(4)], 1, { requires: { ability: "dig" } }),
  mv("stoneWall", "Terraform: Stone", "earth", "terrain", 15, 1, 6, 3.5, 0, 0.9, 0.4, 0.7, [gr("stone"), st("shielded", 1, 5, true)], 2, TF),
  mv("sandstormCall", "Sandstorm Call", "earth", "weather", 0, 1, 0, 0, 0, 1.4, 0.3, 1.2, [wx("sandstorm")], 2, WS),
  // air
  mv("galeSlash", "Gale Slash", "air", "melee", 48, 0.96, 0.5, 0, 0, 0.3, 0.2, 0.4),
  mv("airCutter", "Air Cutter", "air", "projectile", 45, 0.92, 13, 0, 26, 0.4, 0.2, 0.4),
  mv("jetStream", "Jet Stream", "air", "beam", 68, 0.9, 14, 0, 0, 0.85, 0.35, 0.8, [kb(3)], 2),
  mv("tornado", "Tornado", "air", "zone", 120, 0.9, 11, 2.8, 0, 1.0, 0.5, 0.9, [kb(4), st("slowed", 0.5, 2), st("staggered", 0.4, 1)], 3),
  mv("takeFlight", "Take Flight", "air", "fly", 0, 1, 0, 0, 0, 0.5, 0.3, 0.3, [st("airborne", 1, 8, true)], 1, { requires: { ability: "fly" } }),
  mv("tailwind", "Tailwind", "air", "buff", 0, 1, 0, 0, 0, 0.5, 0.3, 0.4, [st("hasted", 1, 6, true)], 2),
  mv("galeCall", "Gale Call", "air", "weather", 0, 1, 0, 0, 0, 1.4, 0.3, 1.2, [wx("wind")], 2, WS),
  // electric
  mv("staticFang", "Static Fang", "electric", "melee", 50, 0.95, 0, 0, 0, 0.4, 0.2, 0.45, [st("paralyzed", 0.3, 2)]),
  mv("sparkBolt", "Spark Bolt", "electric", "projectile", 48, 0.92, 13, 0, 30, 0.45, 0.2, 0.45, [st("paralyzed", 0.25, 2)]),
  mv("thunderBeam", "Thunder Beam", "electric", "beam", 75, 0.86, 14, 0, 0, 1.0, 0.35, 0.85, [st("paralyzed", 0.25, 2)], 2),
  mv("discharge", "Discharge", "electric", "burst", 130, 0.95, 0, 3.2, 0, 1.0, 0.35, 0.9, [st("paralyzed", 0.3, 2)], 3),
  mv("stormCall", "Storm Call", "electric", "weather", 0, 1, 0, 0, 0, 1.4, 0.3, 1.2, [wx("storm")], 2, WS),
  // ice
  mv("frostFang", "Frost Fang", "ice", "melee", 50, 0.95, 0, 0, 0, 0.45, 0.25, 0.5, [st("frozen", 0.15, 1.5)]),
  mv("iceShard", "Ice Shard", "ice", "projectile", 42, 0.93, 12, 0, 24, 0.4, 0.2, 0.4),
  mv("cryoBeam", "Cryo Beam", "ice", "beam", 68, 0.88, 14, 0, 0, 0.95, 0.35, 0.8, [st("frozen", 0.2, 1.5)], 2),
  mv("hailBurst", "Hail Burst", "ice", "burst", 125, 0.95, 0, 3, 0, 0.9, 0.3, 0.8, [st("slowed", 0.4)], 3),
  mv("frostGround", "Terraform: Frost", "ice", "terrain", 15, 1, 8, 4, 0, 0.9, 0.4, 0.7, [gr("ice")], 2, TF),
  mv("snowCall", "Snow Call", "ice", "weather", 0, 1, 0, 0, 0, 1.4, 0.3, 1.2, [wx("snow")], 2, WS),
  // metal
  mv("ironRam", "Iron Ram", "metal", "melee", 56, 0.86, 0, 0, 0, 0.6, 0.3, 0.7, [kb(6)], 1, { tags: ["massScaled"] }),
  mv("steelSpike", "Steel Spike", "metal", "projectile", 40, 0.8, 12, 0, 22, 0.55, 0.2, 0.5),
  mv("magnetPull", "Magnet Pull", "metal", "zone", 30, 0.95, 12, 1.5, 0, 0.7, 0.3, 0.6, [pull(6), st("slowed", 0.4, 2), st("staggered", 0.3, 1)], 2),
  mv("ironShell", "Iron Shell", "metal", "buff", 0, 1, 0, 0, 0, 0.5, 0.3, 0.4, [st("shielded", 1, 6, true)], 1),
  mv("shrapnel", "Shrapnel Burst", "metal", "burst", 135, 0.93, 0, 3, 0, 1.0, 0.3, 0.9, [], 3),
  // poison
  mv("venomFang", "Venom Fang", "poison", "melee", 54, 0.95, 0, 0, 0, 0.45, 0.25, 0.5, [st("poisoned", 0.6, 5)]),
  mv("toxicSpit", "Toxic Spit", "poison", "projectile", 52, 0.96, 11, 0, 16, 0.45, 0.2, 0.45, [st("poisoned", 0.6, 5)]),
  mv("miasma", "Miasma", "poison", "zone", 48, 1, 10, 3, 0, 0.8, 0.4, 0.7, [st("poisoned", 1, 5)], 2),
  mv("corrosion", "Corrosion", "poison", "beam", 80, 0.93, 13, 0, 0, 0.9, 0.35, 0.8, [st("softened", 0.4, 4), st("poisoned", 0.4, 5)], 2),
  mv("plagueBurst", "Plague Burst", "poison", "burst", 125, 0.95, 0, 3.2, 0, 1.0, 0.35, 0.9, [st("poisoned", 0.6, 5)], 3),
  mv("acidRainCall", "Acid Rain Call", "poison", "weather", 0, 1, 0, 0, 0, 1.4, 0.3, 1.2, [wx("acidRain")], 2, WS),
  // light
  mv("radiantStrike", "Radiant Strike", "light", "melee", 56, 0.96, 0, 0, 0, 0.4, 0.2, 0.45, [st("blinded", 0.25, 2)], 1, { part: "aura" }),
  mv("photonDart", "Photon Dart", "light", "projectile", 46, 0.98, 15, 0, 40, 0.4, 0.15, 0.4),
  mv("dazzle", "Dazzle", "light", "burst", 30, 1, 0, 3.5, 0, 0.6, 0.3, 0.6, [st("blinded", 0.7, 2.5)], 2),
  mv("prismRay", "Prism Ray", "light", "beam", 80, 0.92, 14, 0, 0, 0.9, 0.3, 0.8, [st("blinded", 0.35, 2)], 2),
  mv("solarBeam", "Solar Beam", "light", "beam", 140, 0.9, 16, 0, 0, 1.6, 0.45, 1.0, [], 3),
  mv("auroraCall", "Aurora Call", "light", "weather", 0, 1, 0, 0, 0, 1.4, 0.3, 1.2, [wx("aurora")], 2, WS),
  // shadow
  mv("shadowClaw", "Shadow Claw", "shadow", "melee", 56, 0.94, 0, 0, 0, 0.45, 0.25, 0.5, [], 1, { tags: ["highCrit"] }),
  mv("umbraOrb", "Umbra Orb", "shadow", "projectile", 50, 0.9, 12, 0, 15, 0.55, 0.2, 0.5),
  mv("dreadGaze", "Dread Gaze", "shadow", "beam", 30, 0.95, 12, 0, 0, 0.6, 0.4, 0.6, [st("feared", 0.7, 3)], 2),
  mv("umbralLance", "Umbral Lance", "shadow", "beam", 72, 0.88, 14, 0, 0, 0.95, 0.35, 0.8, [st("blinded", 0.2, 2)], 2),
  mv("nightfall", "Nightfall", "shadow", "burst", 130, 0.95, 0, 3.3, 0, 1.1, 0.35, 0.9, [st("feared", 0.35, 2.5)], 3),
  mv("nightVeil", "Night Veil", "shadow", "buff", 0, 1, 0, 0, 0, 0.5, 0.3, 0.4, [st("evasive", 1, 6, true)], 2),
  mv("eclipseCall", "Eclipse Call", "shadow", "weather", 0, 1, 0, 0, 0, 1.4, 0.3, 1.2, [wx("eclipse")], 2, WS),
  // psychic
  mv("mindSpike", "Mind Spike", "psychic", "projectile", 50, 0.92, 14, 0, 34, 0.5, 0.2, 0.45),
  mv("psiBeam", "Psi Beam", "psychic", "beam", 70, 0.9, 14, 0, 0, 0.95, 0.35, 0.8, [st("confused", 0.2, 2)], 2),
  mv("telekinesis", "Telekinesis", "psychic", "zone", 45, 0.92, 12, 1.5, 0, 0.8, 0.3, 0.7, [kb(7)], 2),
  mv("calmMind", "Calm Mind", "psychic", "buff", 0, 1, 0, 0, 0, 0.5, 0.4, 0.4, [st("focused", 1, 8, true)], 1),
  mv("psyStorm", "Psy Storm", "psychic", "burst", 130, 0.95, 0, 3.2, 0, 1.0, 0.35, 0.9, [st("confused", 0.3, 2)], 3),
  // void
  mv("nullBite", "Null Bite", "void", "melee", 54, 0.94, 0, 0, 0, 0.45, 0.25, 0.5, [st("softened", 0.25, 4)]),
  mv("voidOrb", "Void Orb", "void", "projectile", 48, 0.9, 12, 0, 15, 0.55, 0.2, 0.5),
  mv("phaseOut", "Phase Out", "void", "buff", 0, 1, 0, 0, 0, 0.4, 0.3, 0.4, [st("evasive", 1, 3, true)], 2),
  mv("collapse", "Collapse", "void", "burst", 125, 0.93, 0, 3.4, 0, 1.1, 0.35, 0.9, [pull(5)], 3),
] as Move[]).map(lawTimed);

export const MOVE_BY_ID: Record<string, Move> = Object.fromEntries(MOVES.map((m) => [m.id, m]));

export const TIER_LEVEL: Record<1 | 2 | 3, number> = { 1: 1, 2: 12, 3: 30 };

const ELEMENT_RARITY: Partial<Record<ElementId, number>> = { neutral: 0.9, light: 1.08, shadow: 1.06, psychic: 1.06, void: 1.08 };

/** Live meta: share of ladder uses per move id (from the ledger). */
export interface MetaUsage {
  share: Record<string, number>;
}

export interface CostBreakdown {
  damage: number;
  tempo: number;
  effects: number;
  rarity: number;
  meta: number;
  cost: number;
}

/**
 * Relative value of each status per (chance x duration/3) when pricing a move. Measured setup
 * statuses (wet only matters with electric/ice teammates) are cheap; hard disables are expensive.
 */
export const STATUS_WEIGHT: Record<StatusId, number> = {
  burn: 1,
  wet: 0.3,
  frozen: 1.6,
  paralyzed: 1.2,
  poisoned: 1,
  slowed: 0.7,
  blinded: 0.9,
  feared: 0.8,
  confused: 0.9,
  staggered: 1,
  shielded: 1,
  hasted: 0.9,
  evasive: 1,
  focused: 0.8,
  softened: 0.8,
  airborne: 0.5,
  burrowed: 0.5,
  liquid: 0.6,
  regen: 1,
  stunned: 1.8,
};

/** Delivery premium: a beam resolves instantly along its line (no travel to dodge, no ground hits). */
export const DELIVERY: Partial<Record<MoveShape, number>> = { beam: 1.2 };

/** Energy cost of a move: power x area x range x accuracy x delivery x tempo + effects, x rarity x meta. */
export function moveCostBreakdown(m: Move, meta?: MetaUsage): CostBreakdown {
  // A burst is centred on its user (who must stand in melee range to use it), so its area is worth
  // less than a zone placed at range.
  const damage = m.power * (1 + (m.shape === "burst" ? 0.16 : 0.28) * m.area) * (m.range > 4 ? 1 + 0.025 * (m.range - 4) : 1) *
    (0.6 + 0.5 * m.accuracy) * (DELIVERY[m.shape] ?? 1);
  const tempo = 1 + clamp(0.9 - m.charge, -0.6, 0.6) * 0.3;
  let effects = 0;
  for (const e of m.effects) {
    if (e.kind === "status") effects += 9 * (e.status ? STATUS_WEIGHT[e.status] : 1) * (e.chance ?? 1) * ((e.duration ?? 3) / 3) * (e.self ? 1.2 : 1);
    else if (e.kind === "knockback" || e.kind === "pull") effects += (e.value ?? 0) * 1.4;
    else if (e.kind === "ground") effects += 9;
    else if (e.kind === "weather") effects += 16;
    else if (e.kind === "heal") effects += (e.value ?? 0) * 60;
  }
  if (m.shape === "dig" || m.shape === "fly" || m.shape === "phase") effects += 6;
  const rarity = ELEMENT_RARITY[m.element] ?? 1;
  const nMoves = MOVES.length;
  const share = meta?.share[m.id] ?? 1 / nMoves;
  // Meta: r = usage relative to an average move (1 = average). Unused moves get up to -20 %, a move
  // used 5x the average pays +25 %; piecewise linear so BOTH clamps are reachable (the old formula
  // bottomed out at 0.925).
  const r = meta ? share * nMoves : 1;
  const metaMult = meta ? clamp(r <= 1 ? 0.8 + 0.2 * r : 1 + 0.0625 * (r - 1), 0.8, 1.25) : 1;
  const cost = Math.max(4, Math.round((damage * 0.3 * tempo + effects) * rarity * metaMult));
  return { damage, tempo, effects, rarity, meta: metaMult, cost };
}

export function moveCost(m: Move, meta?: MetaUsage): number {
  return moveCostBreakdown(m, meta).cost;
}

export function isDamaging(m: Move): boolean {
  return m.power > 0 && !["buff", "heal", "weather", "phase", "fly"].includes(m.shape);
}
