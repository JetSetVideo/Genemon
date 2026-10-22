/**
 * Pass-4 move-kit system [P4-M1..M3, M5..M7], pure and deterministic.
 *
 * - CATEGORY / PART / SLOT of any move (explicit on kit rows, derived for legacy rows).
 * - `bodyFactor`: power follows the delivering body part (mouth width for breath, mass for slams,
 *   claws, horns, tail, wings, legs, eyes, element affinity for auras). Centred so that over a random
 *   population the MEAN factor per part is ~1: the body reshapes power, never adds it [SPEC B1].
 * - `learnCheck`: limited learnsets with human-readable refusal reasons (level, element, size,
 *   energy, missing body part, ability).
 * - `buildKit`: League-style kit [Q basic, W control, E mobility, R ultimate].
 * - `counterValue` / `interrupts`: how well one move answers the enemy's current move and phase.
 * - `phaseLaw` / `retimed`: the timing law (defined in ./movesKit.ts, re-exported here).
 */
import { clamp, clamp01, u01 } from "../core/math.ts";
import { hashSeed, Rng } from "../core/rng.ts";
import { type ElementId, typeMultiplier } from "../data/elements.ts";
import type { MorphHelix } from "../genome/morphTypes.ts";
import type { Abilities, Phenotype, SizeClass } from "../genome/phenotype.ts";
import { type BodyPart, isDamaging, type KitSlot, type Move, type MoveCategory, moveCost, MOVES, type MoveShape, type StatusId, TIER_LEVEL } from "./moves.ts";
import { KIT_MOVES, phaseLaw } from "./movesKit.ts";

export { KIT_MOVES, phaseLaw };

/** Every move the engine knows: the legacy catalogue + the pass-4 kit rows. */
export const ALL_MOVES: readonly Move[] = [...MOVES, ...KIT_MOVES];
export const ALL_MOVE_BY_ID: Record<string, Move> = Object.fromEntries(ALL_MOVES.map((m) => [m.id, m]));

/** Keyboard label of each kit slot (League convention). */
export const SLOT_KEY: Record<KitSlot, string> = { basic: "Q", control: "W", mobility: "E", ultimate: "R", utility: "-" };

const STATUS_SHAPES: ReadonlySet<MoveShape> = new Set<MoveShape>(["buff", "heal", "weather", "terrain", "phase"]);
const CONTROL_STATUS: ReadonlySet<StatusId> = new Set<StatusId>(["staggered", "frozen", "feared", "paralyzed", "stunned"]);
const INTERRUPT_STATUS: ReadonlySet<StatusId> = new Set<StatusId>(["stunned", "frozen"]);
const RANGED_SHAPES: ReadonlySet<MoveShape> = new Set<MoveShape>(["beam", "cone", "zone", "projectile"]);

// ------------------------------------------------------------------ timing

/** A legacy move re-timed by the phase law (damaging moves only; utility moves are returned as is). */
export function retimed(m: Move): Move {
  if (!isDamaging(m)) return m;
  return { ...m, ...phaseLaw(m.power, m.area, m.effects.length) };
}

// ------------------------------------------------------------------ category / part / slot

export function categoryOf(m: Move): MoveCategory {
  if (m.category) return m.category;
  if (STATUS_SHAPES.has(m.shape) || m.shape === "fly" || m.power <= 0) return "status";
  if (m.shape === "melee" || m.shape === "dash" || m.shape === "dig") return "physical";
  // A ground-tagged burst (Stomp, Quake) is the body hitting the floor.
  if (m.shape === "burst" && m.tags.includes("ground")) return "physical";
  return "special";
}

export function partOf(m: Move): BodyPart {
  if (m.part) return m.part;
  const n = m.name.toLowerCase();
  if (m.shape === "fly") return "wings";
  if (m.shape === "dig") return "legs";
  const cat = categoryOf(m);
  if (cat === "physical") {
    if (/bite|fang/.test(n)) return "jaw";
    if (/claw|slash|strike/.test(n)) return "claws";
    if (/\bram\b|horn/.test(n)) return "horns";
    if (/tail/.test(n)) return "tail";
    if (/wing/.test(n)) return "wings";
    return "mass";
  }
  if (m.shape === "cone" || /spit|jet|breath|howl|roar/.test(n)) return "mouth";
  if (/gaze|ray|eye/.test(n) || (m.shape === "beam" && (m.element === "light" || m.element === "psychic"))) return "eyes";
  return "aura";
}

/** True if the move inflicts (not on its user) one of `set` with chance >= `minChance`. */
function inflicts(m: Move, set: ReadonlySet<StatusId>, minChance: number): boolean {
  return m.effects.some((e) => e.kind === "status" && !e.self && e.status !== undefined && set.has(e.status) && (e.chance ?? 1) >= minChance);
}

export function slotOf(m: Move): KitSlot {
  if (m.slot) return m.slot;
  if (STATUS_SHAPES.has(m.shape)) return "utility";
  if (m.shape === "fly" || m.shape === "dig" || m.shape === "dash") return "mobility";
  if (m.tier === 3 && isDamaging(m)) return "ultimate";
  if (inflicts(m, CONTROL_STATUS, 0.3)) return "control";
  return "basic";
}

/** A stun / freeze / stagger with chance >= 0.5: lands on a charge and cancels it [P4-M6]. */
export function interrupts(m: Move): boolean {
  return inflicts(m, INTERRUPT_STATUS, 0.5);
}

/** Carries a damage-over-time or a status on the target (the kit's "special effect"). */
function hasSpecialEffect(m: Move): boolean {
  return m.effects.some((e) => e.kind === "status" && !e.self && (e.chance ?? 1) >= 0.2);
}

// ------------------------------------------------------------------ body factor [P4-M2]

const BAND_LO = 0.7, BAND_HI = 1.35;
/** 1 + slope x (x - population mean), clamped to the band. */
const lin = (x: number, mean: number, slope: number) => clamp(1 + slope * (x - mean), BAND_LO, BAND_HI);
/** Population reference mass (kg, geometric mean per class, 400 random level-35 Genemon). */
export const MASS_REF: Record<SizeClass, number> = { XS: 2.7, S: 21, M: 104, L: 430, XL: 2050 };
export const HEIGHT_REF: Record<SizeClass, number> = { XS: 0.4, S: 0.69, M: 1.07, L: 1.49, XL: 2.29 };

/**
 * Power multiplier in [0.7, 1.35] from the body part that delivers the move. Plan genes have a
 * population mean of 0.5, so each part's factor is centred on 1 [SPEC B1]; status moves return 1.
 */
export function bodyFactor(m: Move, ph: Phenotype, helix?: MorphHelix): number {
  const cat = categoryOf(m);
  if (cat === "status") return 1;
  const p = ph.plan;
  switch (partOf(m)) {
    case "mouth":
      return helix ? lin(helix.mouth.width, 0.65, 0.8) : lin(0.6 * p.jaw + 0.4 * p.head, 0.5, 0.7);
    case "jaw":
      return helix ? lin(0.5 * helix.mouth.width + 0.5 * clamp01(helix.mouth.toothLength / 0.6), 0.5, 0.7) : lin(p.jaw, 0.5, 0.6);
    case "eyes":
      return helix ? lin(helix.eyes.size, 0.285, 1.6) : lin(p.eyes, 0.5, 0.6);
    case "aura":
      return m.element === "neutral" ? 1 : lin(ph.elements.affinity[m.element], 0, 0.6);
    case "mass": {
      const r = Math.pow(ph.massKg / MASS_REF[ph.sizeClass], 0.25) * Math.pow(ph.heightM / HEIGHT_REF[ph.sizeClass], 0.1);
      return clamp(r, BAND_LO, BAND_HI);
    }
    case "claws":
      if (helix) return helix.digits <= 0 ? BAND_LO : lin(0.8 * helix.clawLength + 0.04 * helix.digits, 0.48, 0.6);
      return lin(p.spikes, 0.5, 0.6);
    case "horns":
      return lin(p.horns, 0.5, 0.6);
    case "tail":
      return lin(ph.kind === "serpent" ? Math.max(p.tail, 0.5) : p.tail, 0.5, 0.6);
    case "wings":
      return helix && helix.wings.span > 0 ? lin(helix.wings.span, 2.2, 0.25) : lin(p.wings, 0.5, 0.6);
    case "legs":
      return lin(p.legLen, 0.5, 0.6);
  }
}

// ------------------------------------------------------------------ learnability [P4-M3]

const ABILITY_TEXT: Record<keyof Abilities, string> = {
  fly: "cannot fly",
  swim: "cannot swim",
  dig: "cannot dig",
  phaseShift: "cannot change form",
  weatherShaper: "cannot shape the weather",
  terraformer: "cannot terraform",
};
/** Minimum energy regeneration (per second) to sustain an ultimate. */
export const ULTIMATE_REGEN = 10;

/** Can this phenotype learn the move? `reasons` are short human strings (empty when ok). */
export function learnCheck(m: Move, ph: Phenotype, helix?: MorphHelix): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const slot = slotOf(m), cat = categoryOf(m), part = partOf(m);
  const need = TIER_LEVEL[m.tier];
  if (ph.level < need) reasons.push(`level ${need} needed`);
  // Element: own type (or affinity >= 0.3) at tier 1, affinity >= 0.3 at tier 2, >= 0.45 for tier 3 / R.
  if (m.element !== "neutral") {
    const aff = ph.elements.affinity[m.element];
    const own = ph.elements.primary === m.element || ph.elements.secondary === m.element;
    const req = m.tier === 3 || slot === "ultimate" ? 0.45 : m.tier === 2 ? 0.3 : 0;
    if (req === 0) {
      if (!own && aff < 0.3) reasons.push(`wrong element (${m.element} is not its type)`);
    } else if (aff < req) reasons.push(`wrong element (${m.element} affinity ${aff.toFixed(2)} < ${req})`);
  }
  // Size.
  const small = ph.sizeClass === "XS" || ph.sizeClass === "S";
  if (cat === "physical" && part === "mass" && small && (m.tags.includes("massScaled") || m.power >= 75)) reasons.push("too small (needs M+)");
  if (m.shape === "dash" && ph.sizeClass === "XL" && part !== "mass") reasons.push("too big to dash (XL)");
  if (m.shape === "cone" && part === "mouth" && ph.kind === "blob" && ph.plan.jaw < 0.4) reasons.push("no jaw to breathe from");
  // Energy.
  if (slot === "ultimate" && ph.stats.regen < ULTIMATE_REGEN) reasons.push(`not enough energy (regen ${ph.stats.regen.toFixed(1)} < ${ULTIMATE_REGEN})`);
  // Body parts.
  if (part === "horns" && ph.plan.horns <= 0.45) reasons.push("needs horns");
  if (part === "tail" && ph.kind !== "serpent" && ph.plan.tail <= 0.35) reasons.push("needs a tail");
  if (part === "wings" && !ph.abilities.fly && ph.plan.wings <= 0.55) reasons.push("needs wings");
  if (part === "claws" && helix && (helix.digits <= 0 || helix.clawLength <= 0.15)) reasons.push("needs claws");
  // Legacy requirements.
  const ab = m.requires?.ability;
  if (ab && !ph.abilities[ab]) reasons.push(ABILITY_TEXT[ab]);
  const kinds = m.requires?.kinds;
  if (kinds && !kinds.includes(ph.kind)) reasons.push(`wrong body (needs ${kinds.join("/")})`);
  return { ok: reasons.length === 0, reasons };
}

// ------------------------------------------------------------------ kit builder [P4-M7]

const CC_WEIGHT: Partial<Record<StatusId, number>> = { stunned: 1.5, frozen: 1.4, paralyzed: 0.8, staggered: 0.7, feared: 0.8, slowed: 0.3 };

/**
 * Four move ids ordered [Q basic, W control, E mobility, R ultimate], each slot taken by the best
 * learnable move (score = STAB x bodyFactor x range fit x slot value, +-2 % seeded tiebreak).
 * Fallbacks: R -> best tier-2 damaging move; W -> best status-applying move; E -> a damaging move of
 * the other range class than Q. Then any learnable damaging move, then anything learnable.
 */
export function buildKit(ph: Phenotype, seed: string, helix?: MorphHelix, pool: readonly Move[] = ALL_MOVES): string[] {
  const learn = pool.filter((m) => learnCheck(m, ph, helix).ok);
  const { primary, secondary, secondaryLevel, affinity } = ph.elements;
  const far = u01(ph.axes.reach);
  const el = (m: Move) =>
    m.element === primary ? 1.25 : m.element === secondary ? 1.05 + 0.15 * secondaryLevel : m.element === "neutral" ? 0.95 : 0.85 + 0.3 * Math.max(0, affinity[m.element]);
  const isClose = (m: Move) => m.shape === "melee" || m.shape === "dash" || m.shape === "burst" || m.shape === "dig" || m.shape === "cone";
  const fit = (m: Move) => (m.shape === "cone" ? 0.9 + 0.2 * (1 - far) : isClose(m) ? 0.8 + 0.4 * (1 - far) : 0.8 + 0.4 * far);
  const jitter = (m: Move) => 1 + 0.04 * (new Rng(hashSeed(seed, "kit", m.id)).next() - 0.5);
  const base = (m: Move) => el(m) * bodyFactor(m, ph, helix) * fit(m) * jitter(m);
  const fx = (m: Move) => m.effects.reduce((s, e) => s + (e.kind === "status" && !e.self ? (e.chance ?? 1) * (e.duration ?? 3) / 3 : 0), 0);
  const cc = (m: Move) =>
    m.effects.reduce((s, e) => s + (e.kind === "status" && !e.self && e.status ? (CC_WEIGHT[e.status] ?? 0.2) * (e.chance ?? 1) * (e.duration ?? 3) : 0), 0);
  const cycle = (m: Move) => m.charge + m.active + m.rest;
  const sQ = (m: Move) => base(m) * (m.power * (1 + 0.1 * Math.min(3, m.area)) + 10 * fx(m)) / Math.max(0.5, cycle(m));
  // W is the stun slot: a move that can interrupt a charge is preferred over a long fear or slow.
  const sW = (m: Move) => base(m) * (cc(m) + m.power / 100 + (interrupts(m) ? 0.6 : 0));
  const sE = (m: Move) => base(m) * (m.shape === "dash" ? 0.3 + m.power / 60 : m.shape === "fly" ? 0.95 : 0.8 + m.power / 100);
  const sR = (m: Move) => base(m) * m.power * (1 + 0.1 * Math.min(4, m.area)) * (1 + 0.3 * fx(m));
  const used = new Set<string>();
  const best = (cands: Move[], score: (m: Move) => number): Move | null => {
    let top: Move | null = null, ts = -Infinity;
    for (const m of cands) {
      if (used.has(m.id)) continue;
      const s = score(m);
      if (s > ts) [top, ts] = [m, s];
    }
    return top;
  };
  const take = (m: Move | null): Move | null => {
    if (m) used.add(m.id);
    return m;
  };
  const dmg = learn.filter(isDamaging);
  const q = take(best(dmg.filter((m) => slotOf(m) === "basic"), sQ) ?? best(dmg.filter((m) => slotOf(m) !== "ultimate"), sQ));
  const w = take(best(learn.filter((m) => slotOf(m) === "control"), sW) ?? best(learn.filter((m) => fx(m) > 0 && slotOf(m) !== "ultimate"), sW));
  const e = take(best(learn.filter((m) => slotOf(m) === "mobility"), sE) ?? best(dmg.filter((m) => !q || isClose(m) !== isClose(q)), sQ));
  const r = take(best(learn.filter((m) => slotOf(m) === "ultimate"), sR) ?? best(dmg.filter((m) => m.tier === 2), sR));
  const kit: (Move | null)[] = [q, w, e, r];
  for (let i = 0; i < 4; i++) if (!kit[i]) kit[i] = take(best(dmg, sR) ?? best(learn, sR));
  // Special-effect rule (tiebreak): if none of the four carries a DoT / status, swap Q (else R, else E)
  // for a same-slot move that does and scores within 15 %.
  if (!kit.some((m) => m && hasSpecialEffect(m))) {
    const swaps: [number, KitSlot, (m: Move) => number][] = [[0, "basic", sQ], [3, "ultimate", sR], [2, "mobility", sE]];
    for (const [i, slot, score] of swaps) {
      const cur = kit[i];
      if (!cur || slotOf(cur) !== slot) continue;
      const alt = best(learn.filter((m) => slotOf(m) === slot && hasSpecialEffect(m)), score);
      if (alt && score(alt) >= 0.85 * score(cur)) {
        used.delete(cur.id);
        kit[i] = take(alt);
        break;
      }
    }
  }
  return kit.filter((m): m is Move => m !== null).map((m) => m.id);
}

// ------------------------------------------------------------------ counters [P4-M6]

/** Elemental "quench" pairs: my element douses / smothers / freezes theirs. */
const QUENCH: Partial<Record<ElementId, ElementId[]>> = {
  water: ["fire"],
  earth: ["electric", "fire"],
  fire: ["ice", "plant"],
  ice: ["water"],
  light: ["shadow"],
  air: ["poison"],
};

/**
 * How well `mine` answers the enemy's current move and phase, in [0, 2] (1 = neutral). Stuns on a
 * long, strong charge (an ultimate wind-up) are the best counter; a dash during a ranged charge
 * dodges it; evasive/shield buffs blunt projectiles and beams; quench elements douse; a heavy hit
 * punishes a long rest. Starting a long charge into an enemy's interrupt is penalised.
 */
export function counterValue(
  mine: Move,
  theirs: Move | null,
  theirPhase: "idle" | "charge" | "active" | "rest",
  theirProgress: number,
  theirPhaseLeft: number,
): number {
  if (!theirs || theirPhase === "idle") return 1;
  let v = 1;
  const prog = clamp01(theirProgress);
  const left = Math.max(0, theirPhaseLeft);
  const heavy = clamp01(theirs.power / 140);
  const inTime = mine.charge <= left + 0.05;
  const selfSt = (s: StatusId) => mine.effects.some((e) => e.kind === "status" && e.self && e.status === s);
  if (theirPhase === "charge") {
    if (interrupts(mine)) {
      const chance = Math.max(...mine.effects.filter((e) => e.kind === "status" && !e.self && e.status && INTERRUPT_STATUS.has(e.status)).map((e) => e.chance ?? 1));
      v += (inTime ? 1 : 0.35) * (0.2 + 0.45 * clamp01(left / 1.5) + 0.35 * heavy) * (0.5 + 0.5 * chance);
    }
    if (mine.shape === "dash" && RANGED_SHAPES.has(theirs.shape)) v += (inTime ? 1 : 0.5) * (0.25 + 0.25 * prog) + 0.15 * heavy;
    if (mine.shape === "fly" && (theirs.tags.includes("ground") || theirs.shape === "melee")) v += 0.35;
    if (interrupts(theirs) && mine.charge > left) v -= 0.25 * clamp01((mine.charge - left) / 1);
  }
  if (theirPhase === "charge" || theirPhase === "active") {
    const ranged = RANGED_SHAPES.has(theirs.shape);
    if (selfSt("evasive")) v += ranged ? 0.35 : 0.1;
    if (selfSt("shielded")) v += ranged ? 0.25 : 0.15;
    if (isDamaging(mine) && theirs.element !== "neutral") {
      if (QUENCH[mine.element]?.includes(theirs.element)) v += 0.3;
      else if (typeMultiplier(mine.element, [theirs.element]) >= 2) v += 0.1;
    }
  }
  if (theirPhase === "rest" && isDamaging(mine)) {
    const lands = clamp01(left / Math.max(0.2, mine.charge));
    v += (slotOf(mine) === "ultimate" || mine.power >= 100 ? 0.6 : 0.25 * clamp01(mine.power / 80)) * lands;
  }
  return clamp(v, 0, 2);
}

// ------------------------------------------------------------------ summaries (UI widgets)

export interface KitRow {
  id: string;
  name: string;
  element: ElementId;
  category: MoveCategory;
  part: BodyPart;
  slot: KitSlot;
  key: string;
  power: number;
  charge: number;
  active: number;
  rest: number;
  cost: number;
}

export function kitSummary(ids: string[]): KitRow[] {
  return ids.map((id) => ALL_MOVE_BY_ID[id]).filter((m): m is Move => m !== undefined).map((m) => {
    const slot = slotOf(m);
    return {
      id: m.id,
      name: m.name,
      element: m.element,
      category: categoryOf(m),
      part: partOf(m),
      slot,
      key: SLOT_KEY[slot],
      power: m.power,
      charge: m.charge,
      active: m.active,
      rest: m.rest,
      cost: moveCost(m),
    };
  });
}
