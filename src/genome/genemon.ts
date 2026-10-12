/**
 * A Genemon individual = genome + life conditions + learned moves + knowledge. All mutations of an
 * individual (xp, food, exposure, experiences, evolution) go through functions here that also
 * write a ledger row, so a creature's whole life is replayable and analysable.
 */
import { type Ledger, NOWHERE, type Where } from "../core/ledger.ts";
import { r3 } from "../core/math.ts";
import { hashSeed, Rng } from "../core/rng.ts";
import type { ElementId } from "../data/elements.ts";
import type { GroundId } from "../data/grounds.ts";
import { EXPERIENCES, type ExperienceId, FOODS, type FoodId } from "../data/lifestyle.ts";
import { isDamaging, type Move, MOVES, TIER_LEVEL } from "../combat/moves.ts";
import { type Conditions, emptyConditions, levelOf, xpForLevel } from "./epigenetics.ts";
import { type Genome, type GenomeBias, randomGenome } from "./genome.ts";
import { express, nameFor, type Phenotype } from "./phenotype.ts";
import { u01 } from "../core/math.ts";

export interface Genemon {
  id: string;
  genome: Genome;
  name: string;
  owner: string;
  bornAt: number;
  conditions: Conditions;
  moves: string[];
  /** Learned type knowledge "fire>plant" -> confidence 0..1 (wise Genemon learn faster). */
  knowledge: Record<string, number>;
  stage: number;
}

export const STAGE_NAMES = ["", "Hatchling", "Juvenile", "Adult", "Ascended"] as const;

const cache = new Map<string, Phenotype>();
function conditionKey(g: Genemon): string {
  return `${g.genome.id}|${JSON.stringify(g.conditions)}`;
}

export function phenotypeOf(g: Genemon): Phenotype {
  const key = conditionKey(g);
  let ph = cache.get(key);
  if (!ph) {
    ph = express(g.genome, g.conditions);
    if (cache.size > 4000) cache.clear();
    cache.set(key, ph);
  }
  return ph;
}

function moveAllowed(m: Move, ph: Phenotype): boolean {
  if (TIER_LEVEL[m.tier] > ph.level) return false;
  if (m.requires?.ability && !ph.abilities[m.requires.ability]) return false;
  if (m.requires?.kinds && !m.requires.kinds.includes(ph.kind)) return false;
  return true;
}

/** Choose up to 4 moves that fit the phenotype: element, preferred distance, focus, abilities. */
export function learnset(ph: Phenotype, seed: string, size = 4): string[] {
  const rng = new Rng(hashSeed(seed, "learnset", ph.level));
  const { primary, secondary, secondaryLevel } = ph.elements;
  const far = u01(ph.axes.reach), focused = u01(ph.axes.focus);
  const score = (m: Move): number => {
    const el = m.element === primary ? 1 : m.element === secondary ? 0.55 + 0.4 * secondaryLevel : m.element === "neutral" ? 0.35 : 0;
    if (el === 0) return -1;
    let fit = 0.5;
    if (m.shape === "melee") fit = 1 - far;
    else if (m.shape === "projectile" || m.shape === "beam") fit = 0.4 * far + 0.4 * focused + 0.2;
    else if (m.shape === "burst" || m.shape === "zone") fit = 0.5 * (1 - focused) + 0.3;
    else fit = 0.35 + 0.3 * u01(ph.axes.wisdom);
    const tierBonus = m.tier * 0.08;
    return el * (0.6 + fit) + tierBonus + rng.next() * 0.08;
  };
  const pool = MOVES.filter((m) => moveAllowed(m, ph)).map((m) => ({ m, s: score(m) })).filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);
  const out: Move[] = [];
  const take = (pred: (m: Move) => boolean) => {
    const hit = pool.find((x) => pred(x.m) && !out.includes(x.m));
    if (hit && out.length < size) out.push(hit.m);
  };
  take((m) => isDamaging(m) && m.element === primary);
  take((m) => isDamaging(m) && (m.shape === "melee") !== (out[0]?.shape === "melee"));
  if (ph.abilities.fly) take((m) => m.shape === "fly");
  if (ph.abilities.dig) take((m) => m.shape === "dig");
  if (ph.abilities.phaseShift) take((m) => m.shape === "phase");
  take((m) => isDamaging(m) && (m.element === secondary || m.tier >= 2));
  let utility = out.filter((m) => !isDamaging(m)).length;
  for (const { m } of pool) {
    if (out.length >= size) break;
    if (out.includes(m)) continue;
    if (!isDamaging(m)) {
      if (utility >= 1) continue;
      utility++;
    }
    out.push(m);
  }
  return out.map((m) => m.id);
}

export interface CreateOptions {
  seed: number;
  owner?: string;
  level?: number;
  ageDays?: number;
  bias?: GenomeBias;
  genome?: Genome;
  bornAt?: number;
  name?: string;
}

export function createGenemon(o: CreateOptions): Genemon {
  const genome = o.genome ?? randomGenome(o.seed, hashSeed(o.seed, "env"), o.bias);
  const conditions = emptyConditions();
  const level = o.level ?? 5;
  conditions.xp = xpForLevel(level);
  conditions.ageDays = o.ageDays ?? 6 + level * 1.5;
  const g: Genemon = {
    id: `g-${genome.id.slice(3)}-${(hashSeed(o.seed, o.owner ?? "wild") % 1679616).toString(36)}`,
    genome,
    name: "",
    owner: o.owner ?? "wild",
    bornAt: o.bornAt ?? 0,
    conditions,
    moves: [],
    knowledge: {},
    stage: 1,
  };
  const ph = phenotypeOf(g);
  g.name = o.name ?? nameFor(genome, ph);
  g.moves = learnset(ph, genome.id);
  g.stage = stageOf(g, ph);
  return g;
}

export function stageOf(g: Genemon, ph = phenotypeOf(g)): number {
  if (ph.growth < 0.35) return 1;
  if (ph.growth < 0.7 || ph.level < 16) return 2;
  if (ph.level >= 40 && g.conditions.bond >= 0.6 && g.conditions.battles.won >= 25) return 4;
  return 3;
}

export interface LifeCtx {
  ledger?: Ledger;
  where?: Where;
  when?: number;
  who?: string;
  why?: string;
}

function log(ctx: LifeCtx, g: Genemon, what: string, entries: Record<string, number | string | boolean>, exits: Record<string, number | string | boolean>, why = "") {
  ctx.ledger?.emit({
    when: ctx.when ?? Date.now(),
    where: ctx.where ?? NOWHERE,
    who: ctx.who ?? g.owner,
    what,
    why: ctx.why ?? why,
    from: g.owner,
    to: g.id,
    entries,
    exits,
  });
}

/** Re-derive moves and stage after any change; logs level-ups and evolutions. */
function settle(g: Genemon, before: { level: number; stage: number; primary: ElementId; secondary: ElementId | null }, ctx: LifeCtx) {
  const ph = phenotypeOf(g);
  if (ph.level !== before.level) {
    g.moves = learnset(ph, g.genome.id);
    log(ctx, g, "genemon.levelUp", { from: before.level }, { to: ph.level, moves: g.moves.join(",") }, "xp threshold");
  }
  const stage = stageOf(g, ph);
  if (stage !== g.stage) {
    log(ctx, g, "genemon.evolve", { fromStage: g.stage, growth: r3(ph.growth), level: ph.level }, { toStage: stage, height: r3(ph.heightM), sizeClass: ph.sizeClass }, "growth/level/bond thresholds");
    g.stage = stage;
  }
  if (ph.elements.primary !== before.primary || ph.elements.secondary !== before.secondary) {
    log(ctx, g, "genemon.specialize", { primary: before.primary, secondary: before.secondary ?? "none" }, { primary: ph.elements.primary, secondary: ph.elements.secondary ?? "none" }, "epigenetic drift crossed an element threshold");
    g.moves = learnset(ph, g.genome.id);
  }
}

function snapshot(g: Genemon) {
  const ph = phenotypeOf(g);
  return { level: ph.level, stage: g.stage, primary: ph.elements.primary, secondary: ph.elements.secondary };
}

export function grantXp(g: Genemon, xp: number, ctx: LifeCtx = {}): void {
  const before = snapshot(g);
  g.conditions.xp += xp;
  log(ctx, g, "genemon.xp", { xp }, { total: g.conditions.xp, level: levelOf(g.conditions.xp) });
  settle(g, before, ctx);
}

export function feed(g: Genemon, food: FoodId, units = 1, ctx: LifeCtx = {}): void {
  const before = snapshot(g);
  g.conditions.diet[food] = (g.conditions.diet[food] ?? 0) + units;
  g.conditions.hunger = Math.max(0, g.conditions.hunger - 0.15 * FOODS[food].nutrition * units);
  g.conditions.bond = Math.min(1, g.conditions.bond + 0.005 * units);
  log(ctx, g, "genemon.feed", { food, units }, { hunger: r3(g.conditions.hunger), bond: r3(g.conditions.bond) }, "owner fed");
  settle(g, before, ctx);
}

export function live(g: Genemon, exp: ExperienceId, units = 1, ctx: LifeCtx & { physical?: boolean } = {}): boolean {
  const e = EXPERIENCES[exp];
  if (e.physicalOnly && ctx.physical === false) {
    log(ctx, g, "genemon.experience.denied", { experience: exp }, { reason: "physical presence required" });
    return false;
  }
  const before = snapshot(g);
  g.conditions.experiences[exp] = (g.conditions.experiences[exp] ?? 0) + units;
  g.conditions.xp += e.xp * units;
  log(ctx, g, "genemon.experience", { experience: exp, units, physical: ctx.physical ?? true }, { xp: g.conditions.xp });
  settle(g, before, ctx);
  return true;
}

export function expose(g: Genemon, ground: GroundId, hours: number, ctx: LifeCtx = {}): void {
  const before = snapshot(g);
  g.conditions.exposure[ground] = (g.conditions.exposure[ground] ?? 0) + hours;
  log(ctx, g, "genemon.exposure", { ground, hours }, { totalHours: r3(g.conditions.exposure[ground]!) });
  settle(g, before, ctx);
}

export function age(g: Genemon, days: number, ctx: LifeCtx = {}): void {
  const before = snapshot(g);
  g.conditions.ageDays += days;
  g.conditions.hunger = Math.min(1, g.conditions.hunger + 0.25 * days);
  settle(g, before, ctx);
}
