/**
 * Battle engine (pure, deterministic, fixed dt). Teams fight simultaneously on a physical arena.
 * Every move runs 3 phases: CHARGE (gather, slow, readable tell) -> ACTIVE (strike resolves at its
 * start) -> REST (recovery, vulnerable). Fighters choose (move, target) with a utility AI shaped by
 * their psyche (temper, reach, wisdom, chaos/order, fear) and their learned type knowledge.
 * Space matters: projectiles fly and can CLASH mid-air (fire vs water -> smoke), reactions leave
 * zones, attacks transform the ground (freeze, melt, burn, mud), electricity conducts through
 * water/wet bodies (and allies!), flyers dodge ground moves, diggers need diggable ground, weather
 * and real time of day modulate everything. Each decision and outcome is a ledger row.
 */
import { type Ledger, type Scalar } from "../core/ledger.ts";
import { clamp, dist, distXZ, r3, u01, type V3, v3 } from "../core/math.ts";
import { hashSeed, Rng } from "../core/rng.ts";
import { type ElementId, ELEMENTS, type ReactionId, reactionBetween, typeMultiplier } from "../data/elements.ts";
import { GROUNDS, type GroundId } from "../data/grounds.ts";
import { type WeatherId, WEATHERS } from "../data/weather.ts";
import { type Genemon, phenotypeOf } from "../genome/genemon.ts";
import type { Emotions, Phenotype, Stats } from "../genome/phenotype.ts";
import { EVASION_CAP } from "../genome/phenotype.ts";
import { noteActivity } from "../genome/epigenetics.ts";
import { type Arena, type ArenaSpec, generateArena } from "../world/arena.ts";
import { applyImpulse, type Body, makeBody, stepPhysics } from "../world/physics.ts";
import { isDamaging, type MetaUsage, type Move, moveCost, type StatusId } from "./moves.ts";
import { type Synergy, synergies, type Team } from "./team.ts";
import { ALL_MOVE_BY_ID, bodyFactor, counterValue } from "./kit.ts";

export type Phase = "idle" | "charge" | "active" | "rest";

export interface FighterTally {
  dealt: number;
  taken: number;
  kos: number;
  hits: number;
  misses: number;
  crits: number;
  reactions: number;
  casts: number;
}

export interface Fighter {
  idx: number;
  id: string;
  team: 0 | 1;
  order: number;
  name: string;
  genemon: Genemon;
  ph: Phenotype;
  types: ElementId[];
  stats: Stats;
  body: Body;
  hp: number;
  maxHp: number;
  energy: number;
  moves: Move[];
  costs: number[];
  phase: Phase;
  phaseT: number;
  phaseDur: number;
  move: Move | null;
  target: number;
  aim: V3 | null;
  cooldown: number;
  status: Map<StatusId, number>;
  emotions: Emotions;
  ko: boolean;
  koAt: number;
  rng: Rng;
  memory: Record<string, number>;
  tally: FighterTally;
  elementsUsed: Partial<Record<ElementId, number>>;
  damageTakenBy: Partial<Record<ElementId, number>>;
  lastHitAt: number;
  /** Strain from joint constraints reported by the renderer/animator (feeds balance). */
  strain: number;
  /** Heals cast this battle (each restores HEAL_DECAY x the previous one). */
  heals: number;
  /** A flyer committing to a melee dive stays low and hittable by ground melee until this time. */
  swoopUntil: number;
  /** On the trainer's bench (not on the field): not targetable, not simulated, keeps its HP [P4-B2]. */
  benched: boolean;
  /** A dash in flight: the body travels from -> to during the active phase and strikes on arrival. */
  dash: { from: V3; to: V3; t0: number; dur: number } | null;
  /** Times this fighter was interrupted (a stun or freeze landed on its charge). */
  interrupted: number;
}

export interface Projectile {
  id: number;
  owner: number;
  team: 0 | 1;
  move: Move;
  pos: V3;
  vel: V3;
  ttl: number;
  radius: number;
  element: ElementId;
  alive: boolean;
}

export interface Zone {
  id: number;
  kind: ReactionId | "field";
  element: ElementId;
  pos: V3;
  radius: number;
  ttl: number;
  maxTtl: number;
  owner: number;
  team: -1 | 0 | 1;
  /** Damage per second (absolute) for move fields, or fraction of max HP for reaction zones. */
  dps: number;
  frac: number;
  status: StatusId | null;
  accuracyMult: number;
  regen: number;
  move?: Move;
}

export type BattleEventType =
  | "phase"
  | "hit"
  | "miss"
  | "reaction"
  | "status"
  | "ko"
  | "terrain"
  | "weather"
  | "projectile"
  | "projectileEnd"
  | "zone"
  | "clash"
  | "lightning"
  | "fail"
  | "physics"
  | "switch"
  | "interrupt"
  | "end";

export interface BattleEvent {
  seq: number;
  t: number;
  type: BattleEventType;
  a?: number;
  b?: number;
  pos?: V3;
  element?: ElementId;
  value?: number;
  move?: string;
  label?: string;
  crit?: boolean;
}

export interface BattleSetup {
  seed: number;
  arena: ArenaSpec;
  teams: [Team, Team];
  maxTime?: number;
  dt?: number;
  ledger?: Ledger;
  /** "full": every decision/hit; "summary": start/end/KO/reactions only. */
  detail?: "full" | "summary";
  meta?: MetaUsage;
  /** Epoch ms of t=0 for ledger timestamps. */
  when0?: number;
  /**
   * Fighters per side ON THE FIELD at once [P4-B2]. Undefined = everyone at once (the brawl format).
   * The rest wait on the bench and are thrown in when a fighter is knocked out or when the trainer
   * switches (requestSwitch, or the AI trainer for side 1).
   */
  field?: number;
  /** Starting HP fraction per Genemon id (gauntlet carries HP between rounds) [P4-B1]. */
  startHp?: Record<string, number>;
  /** Scripted switches to replay a recorded battle deterministically: { t, team, out, in } by fighter idx. */
  script?: SwitchOrder[];
  /** Side 1's trainer AI may switch (default true when field is set). */
  aiSwitch?: boolean;
}

/** One trainer switch: fighter `out` goes to the bench, `in` is thrown into the field. */
export interface SwitchOrder {
  t: number;
  team: 0 | 1;
  out: number;
  in: number;
}

/** Seconds a thrown-in Genemon needs before it can act (the throw), and the per-side switch cooldown. */
export const SWITCH_ENTRY = 0.7;
export const SWITCH_COOLDOWN = 3;

export interface BattleResult {
  winner: 0 | 1 | 2;
  reason: "ko" | "timeout" | "forfeit";
  duration: number;
  hpFrac: [number, number];
  mvp: string;
  arena: string;
  weatherStart: WeatherId;
  weatherEnd: WeatherId;
  hour: number;
  reactions: Partial<Record<string, number>>;
  fighters: { id: string; name: string; team: 0 | 1; alive: boolean; hpFrac: number; tally: FighterTally }[];
  knowledge: Record<string, Record<string, number>>;
  elementsUsed: Record<string, Partial<Record<ElementId, number>>>;
  damageTakenBy: Record<string, Partial<Record<ElementId, number>>>;
  moveUses: Record<string, number>;
  synergies: [string[], string[]];
  /** Every switch that happened (manual, AI or KO replacement), replayable via setup.script. */
  switches: SwitchOrder[];
  interrupts: number;
}

/**
 * Which ground tiles physically react with an attack element that lands on them, and as which
 * element. Only real pairs: fire burns vegetation and steams water but does NOT turn soil or
 * stone into magma; water muddies loose ground; ice freezes water; poison taints water and
 * vegetation; air raises dust from loose dry ground and mist from water; plants bloom on water;
 * earth fills water with mud. (Electric on water is handled by conduction chains, not here.)
 */
const GROUND_REACTS: Partial<Record<ElementId, Partial<Record<GroundId, ElementId>>>> = {
  fire: { grass: "plant", moss: "plant", water: "water", deepWater: "water", muddyWater: "water", ice: "ice", snow: "ice" },
  water: { soil: "earth", sand: "earth", gravel: "earth", ash: "earth", lava: "fire" },
  ice: { water: "water", deepWater: "water", muddyWater: "water" },
  poison: { water: "water", deepWater: "water", muddyWater: "water", grass: "plant", moss: "plant" },
  air: { sand: "earth", soil: "earth", gravel: "earth", ash: "earth", water: "water", deepWater: "water" },
  plant: { water: "water", muddyWater: "water" },
  earth: { water: "water", deepWater: "water", muddyWater: "water" },
};

const REACTION_ZONE: Partial<Record<ReactionId, { frac: number; status: StatusId | null; acc: number; regen: number; allies: boolean }>> = {
  smoke: { frac: 0, status: "blinded", acc: 0.65, regen: 0, allies: true },
  wildfire: { frac: 0.018, status: "burn", acc: 1, regen: 0, allies: true },
  firestorm: { frac: 0.03, status: "burn", acc: 1, regen: 0, allies: true },
  magma: { frac: 0.022, status: "slowed", acc: 1, regen: 0, allies: true },
  conduction: { frac: 0, status: "paralyzed", acc: 1, regen: 0, allies: true },
  mud: { frac: 0, status: "slowed", acc: 1, regen: 0, allies: true },
  freeze: { frac: 0, status: null, acc: 1, regen: 0, allies: true },
  contamination: { frac: 0.02, status: "poisoned", acc: 1, regen: 0, allies: true },
  mist: { frac: 0, status: null, acc: 0.85, regen: 0, allies: true },
  dust: { frac: 0, status: null, acc: 0.8, regen: 0, allies: true },
  bloom: { frac: 0, status: "regen", acc: 1, regen: 0.02, allies: false },
  blizzard: { frac: 0.02, status: "slowed", acc: 0.9, regen: 0, allies: true },
  blight: { frac: 0.015, status: null, acc: 1, regen: -1, allies: true },
};

/**
 * Battle PACE: every change of HP - direct hits, conduction, damage over time, hazards, zones, heals
 * and regeneration - is multiplied by PACE, so the whole fight is time-stretched uniformly while
 * actions (charges, cooldowns, energy) keep their real-time rate. Lower = longer battles with more
 * actions per fighter. Tuned for a ~25 s median battle; measured by tools/balance.ts (corpus
 * duration) and tools/scenarios.ts (SC-06).
 */
export const PACE = 0.5;
/** Extra distance a melee strike covers on its active phase (the lunge), metres. */
export const MELEE_LUNGE = 0.9;
/** Every heal a fighter casts in one battle restores HEAL_DECAY x the previous one (0.3, 0.18, 0.11 ...). */
export const HEAL_DECAY = 0.6;

/** Statuses that hurt their bearer (tenacity applies to these only). */
const HARMFUL = new Set<StatusId>(["burn", "wet", "frozen", "paralyzed", "poisoned", "slowed", "blinded", "feared", "confused", "staggered", "softened", "stunned"]);
/** Statuses that cancel a charge they land on (the counter to long wind-ups) [P4-M6]. */
const INTERRUPTING = new Set<StatusId>(["stunned", "frozen"]);

/**
 * Damage category of a move [P4-M1]: an explicit `category`, else physical for contact moves,
 * special for other damaging moves, status otherwise.
 */
export function moveCategory(m: Move): "physical" | "special" | "status" {
  if (m.category) return m.category;
  if (m.tags.includes("contact")) return "physical";
  return isDamaging(m) ? "special" : "status";
}

const IMMUNE: Partial<Record<StatusId, ElementId[]>> = {
  burn: ["fire"],
  poisoned: ["poison", "metal"],
  frozen: ["ice", "fire"],
  paralyzed: ["electric", "earth"],
  wet: ["fire"],
};

function angleDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

const f2 = (x: number) => Math.round(x * 100) / 100;

function bodyRadius(ph: Phenotype): number {
  const k = { quadruped: 0.5, biped: 0.3, hexapod: 0.5, serpent: 0.42, avian: 0.33, blob: 0.48 }[ph.kind];
  return clamp(ph.heightM * k, 0.25, 3);
}

export class Battle {
  readonly setup: BattleSetup;
  readonly arena: Arena;
  readonly dt: number;
  readonly maxTime: number;
  readonly fighters: Fighter[] = [];
  readonly projectiles: Projectile[] = [];
  readonly zones: Zone[] = [];
  readonly events: BattleEvent[] = [];
  /** Active synergies per team: formed at the start, LOST when their enablers are knocked out (X4). */
  synergies: [Synergy[], Synergy[]];
  private readonly teams: [Team, Team];
  weather: WeatherId;
  weatherTimer = 0;
  t = 0;
  tick = 0;
  winner: 0 | 1 | 2 | null = null;
  reason: "ko" | "timeout" = "ko";
  private seq = 0;
  private nextId = 1;
  private rng: Rng;
  private reactions: Partial<Record<string, number>> = {};
  private moveUses: Record<string, number> = {};
  private lastTarget: [number, number] = [-1, -1];
  private lastTargetAt: [number, number] = [-9, -9];
  private lightningT = 3;
  private switches: SwitchOrder[] = [];
  private pendingSwitches: SwitchOrder[] = [];
  private switchCd: [number, number] = [0, 0];
  private interruptCount = 0;

  constructor(setup: BattleSetup) {
    this.setup = setup;
    this.dt = setup.dt ?? 1 / 30;
    this.maxTime = setup.maxTime ?? 90;
    this.arena = generateArena(setup.arena);
    this.weather = setup.arena.weather;
    this.rng = new Rng(hashSeed(setup.seed, "battle"));
    this.synergies = [synergies(setup.teams[0]), synergies(setup.teams[1])];
    this.teams = [setup.teams[0], setup.teams[1]];
    const R = this.arena.radius;
    // Formation scale: the start line, rows and lanes follow the fighters' size. Two 30-cm Genemon
    // do not open a fight 11 m apart (37 body heights; QA round 2 measured 21-46 px fighters at
    // 1440x900): small fights start compact so the camera frames them at a readable size, big
    // fights keep the full ~11 m (R x 0.3 each side).
    const heights = setup.teams.flatMap((t) => t.members.map((g) => phenotypeOf(g).heightM));
    const meanH = heights.reduce((s, x) => s + x, 0) / Math.max(1, heights.length);
    const halfGap = clamp(2 + 3.5 * meanH, 2.5, R * 0.3), rowGap = clamp(1 + 1.5 * meanH, 1.5, 2.5);
    const field = setup.field && setup.field > 0 ? Math.floor(setup.field) : Infinity;
    setup.teams.forEach((team, ti) => {
      const n = Math.min(team.members.length, field);
      // Team ORDER is initiative (first-action stagger below) AND formation: the leading members
      // (all of a duo, half of a bigger team rounded up) hold the front row; the rest stand a row
      // behind them, so the lead takes the first contact and the back row shoots over it.
      const front = n <= 2 ? n : Math.ceil(n / 2);
      team.members.forEach((g, i) => {
        const ph = phenotypeOf(g);
        const benched = i >= n;
        const stats: Stats = { ...ph.stats };
        for (const s of this.synergies[ti]) {
          for (const [k, v] of Object.entries(s.statMult ?? {}) as [keyof Stats, number][]) stats[k] *= v;
        }
        const slot = benched ? 0 : i;
        const row = slot < front ? 0 : 1, inRow = row === 0 ? front : n - front, k = row === 0 ? slot : slot - front;
        const x = (ti === 0 ? -1 : 1) * (halfGap + row * rowGap), z = (k - (inRow - 1) / 2) * Math.max(1.3, 0.9 + 1.4 * ph.heightM);
        const body = makeBody(g.id, {
          mass: Math.max(0.5, ph.massKg),
          radius: bodyRadius(ph),
          height: ph.heightM,
          elasticity: ph.elasticity,
          balance: stats.balance,
          maxSpeed: stats.spd,
          mobility: ph.mobility,
          swimmer: ph.abilities.swim,
          yaw: ti === 0 ? Math.PI / 2 : -Math.PI / 2,
        });
        // The bench stands outside the ring behind its trainer; benched bodies are not simulated.
        const bx = (ti === 0 ? -1 : 1) * (R + 2.5 + 1.2 * (i - n)), bz = R * 0.55;
        body.pos = benched ? v3(bx, 0, bz) : v3(x, this.arena.surfaceAt(x, z), z);
        const moves = g.moves.map((id) => ALL_MOVE_BY_ID[id]).filter(Boolean);
        const idx = this.fighters.length;
        this.fighters.push({
          idx,
          id: g.id,
          team: ti as 0 | 1,
          order: i,
          name: g.name,
          genemon: g,
          ph,
          types: [ph.elements.primary, ...(ph.elements.secondary ? [ph.elements.secondary] : [])],
          stats,
          body,
          hp: stats.hp * clamp(setup.startHp?.[g.id] ?? 1, 0.01, 1),
          maxHp: stats.hp,
          energy: stats.energy * 0.6,
          moves,
          costs: moves.map((m) => moveCost(m, setup.meta)),
          phase: "idle",
          phaseT: 0,
          phaseDur: 0,
          move: null,
          target: -1,
          aim: null,
          cooldown: 0.5 + i * 0.35,
          status: new Map(),
          emotions: { ...ph.psyche.emotions },
          ko: false,
          koAt: 0,
          rng: new Rng(hashSeed(setup.seed, g.id, ti, i)),
          memory: { ...g.knowledge },
          tally: { dealt: 0, taken: 0, kos: 0, hits: 0, misses: 0, crits: 0, reactions: 0, casts: 0 },
          elementsUsed: {},
          damageTakenBy: {},
          lastHitAt: -9,
          strain: 0,
          heals: 0,
          swoopUntil: -9,
          benched,
          dash: null,
          interrupted: 0,
        });
      });
    });
    this.log("battle.start", "system", "instant battle requested", setup.teams[0].owner, setup.teams[1].owner, v3(), {
      seed: setup.seed,
      arena: setup.arena.kind,
      weather: this.weather,
      hour: setup.arena.hour,
      teamA: setup.teams[0].members.map((g) => g.id).join(","),
      teamB: setup.teams[1].members.map((g) => g.id).join(","),
    }, {
      synergiesA: this.synergies[0].map((s) => s.id).join(",") || "none",
      synergiesB: this.synergies[1].map((s) => s.id).join(",") || "none",
      fighters: this.fighters.length,
      field: Number.isFinite(field) ? field : 0,
    }, true);
    if (setup.script) this.pendingSwitches = setup.script.slice().sort((a, b) => a.t - b.t);
  }

  // ------------------------------------------------------------------ logging
  private emit(e: Omit<BattleEvent, "seq" | "t">): void {
    this.events.push({ seq: ++this.seq, t: this.t, ...e });
    if (this.events.length > 600) this.events.splice(0, this.events.length - 600);
  }

  private log(what: string, who: string, why: string, from: string, to: string, pos: V3, entries: Record<string, Scalar>, exits: Record<string, Scalar>, summary = false): void {
    const l = this.setup.ledger;
    if (!l) return;
    if (!summary && (this.setup.detail ?? "full") !== "full") return;
    l.emit({
      when: (this.setup.when0 ?? 0) + Math.round(this.t * 1000),
      where: { x: r3(pos.x), y: r3(pos.y), z: r3(pos.z), zone: this.arena.spec.kind, space: "arena" },
      who,
      what,
      why,
      from,
      to,
      entries,
      exits,
      tags: [`battle:${this.setup.seed}`],
    });
  }

  lastSeq(): number {
    return this.seq;
  }

  // ------------------------------------------------------------------ helpers
  get weatherDef() {
    return WEATHERS[this.weather];
  }

  enemiesOf(f: Fighter): Fighter[] {
    return this.fighters.filter((o) => o.team !== f.team && !o.ko && !o.benched);
  }

  /** On the field and conscious. */
  private live(o: Fighter): boolean {
    return !o.ko && !o.benched;
  }

  /** Bench of a side: conscious Genemon waiting to be thrown in, in team order. */
  bench(team: 0 | 1): Fighter[] {
    return this.fighters.filter((o) => o.team === team && o.benched && !o.ko);
  }

  /** Can side `team` switch `out` for `inn` right now? (reason when not) */
  canSwitch(team: 0 | 1, out: number, inn: number): { ok: boolean; why: string } {
    const a = this.fighters[out], b = this.fighters[inn];
    if (this.winner !== null) return { ok: false, why: "battle over" };
    if (!a || !b || a.team !== team || b.team !== team) return { ok: false, why: "not your Genemon" };
    if (a.ko || a.benched) return { ok: false, why: `${a.name} is not on the field` };
    if (b.ko || !b.benched) return { ok: false, why: `${b.name} is not on the bench` };
    if (this.switchCd[team] > 0) return { ok: false, why: `switch ready in ${this.switchCd[team].toFixed(1)} s` };
    return { ok: true, why: "" };
  }

  /** Queue a trainer switch for the next tick (UI or AI). Deterministic: replays use setup.script. */
  requestSwitch(team: 0 | 1, out: number, inn: number): { ok: boolean; why: string } {
    const c = this.canSwitch(team, out, inn);
    if (c.ok) this.pendingSwitches.push({ t: this.t, team, out, in: inn });
    return c;
  }

  private isDay(): boolean {
    const h = this.setup.arena.hour;
    return h >= 7 && h < 19;
  }

  private rhythmMult(f: Fighter, el: ElementId): number {
    const r = f.ph.axes.rhythm;
    let k = this.isDay() ? 1 + 0.06 * r : 1 - 0.06 * r;
    if (el === "light") k *= this.isDay() ? 1.1 : 0.9;
    if (el === "shadow") k *= this.isDay() ? 0.9 : 1.1;
    return k;
  }

  private conduction(t: Fighter): number {
    const g = GROUNDS[t.body.groundId];
    const base = t.body.mode === "fly" ? 0.6 : t.body.mode === "burrow" ? 0.5 : g.conductivity;
    return base * (t.status.has("wet") ? 1.3 : 1) * (this.weatherDef.wetness > 0.4 ? 1.08 : 1);
  }

  private inWater(t: Fighter): boolean {
    return t.body.mode === "ground" && GROUNDS[t.body.groundId].liquid && t.body.groundId !== "lava";
  }

  private knownType(f: Fighter, el: ElementId, t: Fighter): number {
    const truth = typeMultiplier(el, t.types);
    const w = u01(f.ph.axes.wisdom);
    const key = `${el}>${t.types[0]}`;
    const learned = f.memory[key];
    if (learned !== undefined) return learned;
    return w > 0.65 ? truth : 1 + (truth - 1) * w * 0.6;
  }

  private teamMult(f: Fighter, el: ElementId): number {
    let k = 1;
    for (const s of this.synergies[f.team]) {
      if (s.damageMult) k *= s.damageMult;
      if ((s.element === el || s.element2 === el) && s.elementMult) k *= s.elementMult;
    }
    return k;
  }

  private reach(f: Fighter, m: Move): number {
    switch (m.shape) {
      case "melee":
        return f.stats.reach + m.range + f.body.radius;
      case "projectile":
      case "beam":
      case "zone":
        return m.range;
      case "burst":
        return m.area * 0.95 + f.body.radius;
      case "cone":
        return m.range + f.body.radius;
      case "dash":
        return m.range + f.stats.reach + f.body.radius;
      case "dig":
        return 16;
      default:
        return Infinity;
    }
  }

  private canReach(f: Fighter, t: Fighter, m: Move): boolean {
    if (t.status.has("burrowed") && !m.tags.includes("ground")) return false;
    if (t.body.mode === "fly" && m.tags.includes("ground")) return false;
    // A flyer is out of a ground brawler's reach unless it is diving to strike (X7).
    if (t.body.mode === "fly" && m.shape === "melee" && f.body.mode !== "fly" && this.t >= t.swoopUntil) {
      const alt = t.body.pos.y - f.body.pos.y;
      if (alt > f.stats.reach + f.ph.heightM) return false;
    }
    return true;
  }

  // ------------------------------------------------------------------ AI
  private estimate(f: Fighter, t: Fighter, m: Move): number {
    const atkF = f.stats.atk / 40;
    const defF = 100 / (100 + t.stats.def * (t.status.has("shielded") ? 1.6 : 1));
    const stab = f.types.includes(m.element) ? 1.2 : 1;
    const wx = this.weatherDef.elementMult[m.element] ?? 1;
    const cond = m.element === "electric" ? this.conduction(t) : 1;
    return m.power * bodyFactor(m, f.ph) * atkF * defF * this.knownType(f, m.element, t) * stab * wx * cond * this.teamMult(f, m.element);
  }

  private hitChance(f: Fighter, t: Fighter, m: Move): number {
    const ranged = m.shape !== "melee" && m.shape !== "burst" && m.shape !== "cone" && m.shape !== "dash";
    let p = m.accuracy * f.stats.accuracy * Math.pow(this.weatherDef.visibility, ranged ? 1 : 0.3);
    if (f.status.has("blinded")) p *= 0.65;
    if (f.status.has("focused")) p *= 1.05;
    for (const z of this.zones) if (z.accuracyMult < 1 && distXZ(z.pos, f.body.pos) < z.radius) p *= z.accuracyMult;
    // Evasion is MULTIPLICATIVE and capped: a dodge removes a share of the hits that would land,
    // never more than EVASION_CAP of them (subtractive evasion made 82 % dodge fortresses, X5).
    let ev = t.stats.evasion * (t.status.has("evasive") ? 1.6 : 1) + (t.status.has("evasive") ? 0.06 : 0);
    if (t.phase === "rest") ev *= 0.5;
    if (t.status.has("frozen") || t.status.has("staggered") || t.status.has("stunned")) ev = 0;
    // A body in the middle of a dash is hard to pin down: the dash is the dodge [P4-M6].
    const dashing = t.dash && m.shape !== "burst" && m.shape !== "zone" ? 0.45 : 1;
    return clamp(p * (1 - Math.min(EVASION_CAP, ev)) * dashing, 0.05, 0.99);
  }

  private decide(f: Fighter): void {
    const enemies = this.enemiesOf(f);
    if (enemies.length === 0) return;
    if (f.status.has("paralyzed") && f.rng.chance(0.3)) {
      f.cooldown = 0.6;
      return;
    }
    const temper = u01(f.ph.axes.temper), far = u01(f.ph.axes.reach), wise = u01(f.ph.axes.wisdom);
    const fear = Math.max(f.emotions.fear, f.status.has("feared") ? 0.8 : 0);
    const hpF = f.hp / f.maxHp;
    type Opt = { m: Move; t: number; u: number; cost: number };
    const opts: Opt[] = [];
    const relative: { m: Move; t: number; k: number; cost: number }[] = [];
    f.moves.forEach((m, mi) => {
      const cost = f.costs[mi];
      if (f.energy < cost) return;
      if (isDamaging(m) || m.shape === "dig") {
        if (m.shape === "dig" && (!GROUNDS[f.body.groundId].diggable || f.body.mode !== "ground")) return;
        for (const e of enemies) {
          if (!this.canReach(f, e, m)) continue;
          const d = distXZ(f.body.pos, e.body.pos);
          // Melee and burst only resolve at strike time: skip options the fighter cannot close in
          // during the charge (it approaches first and re-decides) instead of whiffing from afar.
          if (m.shape === "cone" && d - e.body.radius > m.range + f.body.radius + f.stats.spd * m.charge * 0.35) continue;
          if (m.shape === "dash" && d - f.body.radius - e.body.radius > m.range + f.stats.reach + MELEE_LUNGE) continue;
          if (m.shape === "melee" || m.shape === "burst") {
            const short = m.shape === "melee" ? d - f.body.radius - e.body.radius - (f.stats.reach + m.range + MELEE_LUNGE) : d - e.body.radius - m.area;
            const closing = f.stats.spd * (m.charge / Math.max(0.3, f.stats.rate)) * (m.shape === "melee" ? 0.95 : 0.35) * 0.8;
            if (short > closing) continue;
          }
          const r = this.reach(f, m);
          const travel = Math.max(0, d - r) / Math.max(0.5, f.stats.spd);
          let u = this.estimate(f, e, m) * this.hitChance(f, e, m) / (cost + 12);
          u *= Math.exp(-travel / (1.2 + 2 * temper));
          if (this.estimate(f, e, m) >= e.hp) u *= 1.5;
          if (m.area > 0) {
            const others = enemies.filter((o) => o !== e && distXZ(o.body.pos, e.body.pos) < m.area).length;
            u *= 1 + 0.6 * others;
            if (m.shape === "burst") {
              const allies = this.fighters.filter((o) => o.team === f.team && o !== f && this.live(o) && distXZ(o.body.pos, f.body.pos) < m.area).length;
              u *= Math.max(0.3, 1 - 0.25 * allies);
            }
          }
          if (m.element === "electric" && (this.inWater(e) || e.status.has("wet"))) {
            // The current also reaches wet bodies near the target: more enemies is better, allies hurt.
            const wetNear = (mine: boolean) =>
              this.fighters.filter((o) => o !== e && o !== f && this.live(o) && (o.team === f.team) === mine && distXZ(o.body.pos, e.body.pos) <= 4.5 && (this.inWater(o) || o.status.has("wet"))).length;
            u *= (1.25 + 0.2 * Math.min(2, wetNear(false))) * Math.max(0.2, 1 - 0.4 * wetNear(true));
          }
          if (m.shape === "melee" || m.shape === "dash") u *= 1 + 0.35 * (1 - far) + 0.25 * temper - 0.4 * fear;
          else u *= 1 + 0.35 * far + 0.2 * fear;
          if (m.shape === "cone") {
            // A cone catches every enemy inside its arc: value the crowd it would cover.
            const arc = m.arc ?? 0.45, dx0 = e.body.pos.x - f.body.pos.x, dz0 = e.body.pos.z - f.body.pos.z, a0 = Math.atan2(dx0, dz0);
            const caught = enemies.filter((o) => o !== e && Math.abs(angleDiff(Math.atan2(o.body.pos.x - f.body.pos.x, o.body.pos.z - f.body.pos.z), a0)) < arc && distXZ(o.body.pos, f.body.pos) < m.range + o.body.radius).length;
            u *= 1 + 0.6 * caught;
          }
          // Counters [P4-M6]: a stun on a long charge, a dash through a ranged charge, a heavy hit on a rest.
          // An interrupt only counts if it lands before the enemy's charge ends.
          {
            const left = Math.max(0, e.phaseDur - e.phaseT);
            const travel = m.shape === "projectile" && m.speed > 0 ? d / m.speed : 0;
            const inTime = e.phase !== "charge" || left > m.charge / Math.max(0.3, f.stats.rate) + travel;
            if (inTime) u *= counterValue(m, e.move, e.phase, e.phaseDur > 0 ? e.phaseT / e.phaseDur : 0, left);
          }
          u *= 1 + 0.25 * temper * (m.power / 70);
          const sameTarget = this.lastTarget[f.team] === e.idx && this.t - this.lastTargetAt[f.team] < 2.5;
          if (sameTarget) u *= 1.15 + this.synergies[f.team].reduce((s, x) => s + (x.combo ?? 0), 0);
          opts.push({ m, t: e.idx, u, cost });
        }
      } else {
        let u = 0;
        const sx = (s: StatusId) => f.status.has(s);
        switch (m.shape) {
          case "heal":
            // Each heal in a fight is worth less than the last (HEAL_DECAY, X2): no infinite Rest loop.
            u = hpF < 0.6 ? (1 - hpF) * (1 - hpF) * 3.2 * Math.pow(HEAL_DECAY, f.heals) : 0;
            break;
          case "buff": {
            const st = m.effects.find((e) => e.status)?.status;
            u = st && !sx(st) ? 0.55 + 0.3 * wise : 0;
            break;
          }
          case "fly": {
            // Flight dodges ground moves and (unless diving) ground melee, and costs energy every
            // second: worth the SHARE of the enemies' damaging options it would dodge, relative to
            // the best attack. Against a ranged-only team it is pure cost, so the AI stays down.
            if (sx("airborne")) break;
            let dodged = 0, total = 0;
            for (const e of enemies) {
              for (const mm of e.moves) {
                if (!isDamaging(mm)) continue;
                total++;
                if (mm.tags.includes("ground") || mm.shape === "melee") dodged++;
              }
            }
            if (dodged > 0) relative.push({ m, t: enemies[0].idx, k: 1.6 * (dodged / total), cost });
            break;
          }
          case "phase":
            u = sx("liquid") ? 0 : hpF < 0.55 ? 0.9 : 0.15;
            break;
          case "weather": {
            // Valued RELATIVE to the best attack (resolved after the loop): a weather that raises my
            // team's element multipliers by `net` for D seconds is worth `net` of the attacks the team
            // makes in that window (~D / 2.5 s each), discounted 0.35 for the risk it is overwritten.
            const fx = m.effects.find((e) => e.weather);
            const w = fx?.weather;
            if (w && w !== this.weather) {
              const gain = (team: 0 | 1) =>
                this.fighters.filter((o) => o.team === team && this.live(o)).reduce((s, o) => s + (WEATHERS[w].elementMult[o.types[0]] ?? 1) - (this.weatherDef.elementMult[o.types[0]] ?? 1), 0);
              const net = gain(f.team) - gain(f.team === 0 ? 1 : 0);
              if (net > 0) relative.push({ m, t: enemies[0].idx, k: net * ((fx?.duration ?? 14) / 2.5) * 0.35 * (0.6 + 0.8 * wise), cost });
            }
            break;
          }
          case "terrain": {
            // Reshaping the ground: a standing bonus for the user's element (+ self status), and for
            // frost a direct counter to enemies standing in water. Relative to the best attack too.
            const gnd = m.effects.find((e) => e.ground)?.ground;
            const tp = enemies[0].body.pos;
            const already = gnd !== undefined && this.arena.groundIdAt(tp.x, tp.z) === gnd;
            const selfSt = m.effects.find((e) => e.status && e.self)?.status;
            const fresh = selfSt !== undefined && !f.status.has(selfSt);
            const wet = gnd === "ice" ? enemies.filter((e) => this.inWater(e)).length : 0;
            const k = (already ? 0 : 0.3 + 0.35 * wise) + (fresh ? 0.25 : 0) + 0.6 * wet;
            if (k > 0) relative.push({ m, t: enemies[0].idx, k, cost });
            break;
          }
          case "burst": {
            // Status-only bursts (Roar): worth the number of enemies caught, more against the timid.
            const st = m.effects.find((e) => e.status && !e.self)?.status;
            if (st && !enemies.some((e) => e.status.has(st))) {
              const caught = enemies.filter((e) => distXZ(e.body.pos, f.body.pos) < m.area + e.body.radius);
              u = caught.reduce((s, e) => s + 0.55 * (1.2 - u01(e.ph.axes.conviction)), 0) * (0.7 + 0.5 * wise);
            }
            break;
          }
        }
        if (u > 0) opts.push({ m, t: enemies[0].idx, u, cost });
      }
    });
    // Resolve relative options against the best damaging option available right now.
    const refU = Math.max(0.6, ...opts.filter((o) => isDamaging(o.m)).map((o) => o.u));
    for (const r of relative) if (r.k > 0) opts.push({ m: r.m, t: r.t, u: r.k * refU, cost: r.cost });
    if (opts.length === 0) {
      f.cooldown = 0.35;
      return;
    }
    const maxU = Math.max(...opts.map((o) => o.u));
    const chaos = u01(-f.ph.axes.structure);
    const tau = 0.06 + 0.25 * chaos + 0.18 * (1 - wise) + (f.status.has("confused") ? 0.6 : 0);
    const weights = opts.map((o) => Math.exp((o.u / maxU - 1) / tau));
    const pick = f.rng.weighted(opts, weights);
    let target = pick.t;
    if (f.status.has("confused") && f.rng.chance(0.25)) {
      const all = this.fighters.filter((o) => this.live(o) && o !== f);
      target = f.rng.pick(all).idx;
    }
    this.startMove(f, pick.m, target);
    if (this.fighters[target].team !== f.team) {
      this.lastTarget[f.team] = target;
      this.lastTargetAt[f.team] = this.t;
    }
    const sorted = opts.slice().sort((a, b) => b.u - a.u);
    this.log("battle.decide", f.id, `utility ${r3(pick.u)} (best ${r3(sorted[0].u)}, ${opts.length} options, tau ${r3(tau)})`, f.id, this.fighters[target].id, f.body.pos, {
      options: opts.length,
      hp: r3(hpF),
      energy: Math.round(f.energy),
      fear: r3(fear),
      anger: r3(f.emotions.anger),
    }, { move: pick.m.id, target: this.fighters[target].id, utility: r3(pick.u), second: r3(sorted[1]?.u ?? 0) });
  }

  private startMove(f: Fighter, m: Move, target: number): void {
    const mi = f.moves.indexOf(m);
    f.energy -= f.costs[mi];
    f.move = m;
    f.target = target;
    f.phase = "charge";
    f.phaseT = 0;
    const speed = f.stats.rate * (f.status.has("hasted") ? 1.33 : 1) * (f.status.has("slowed") ? 0.87 : 1) * (f.status.has("paralyzed") ? 0.7 : 1);
    f.phaseDur = m.charge / speed;
    // A flyer's melee is a DIVE: it comes down for the whole move plus a recovery beat, and ground
    // brawlers can hit it back meanwhile (X7: no free melee from out of reach).
    if (f.body.mode === "fly" && m.shape === "melee") f.swoopUntil = this.t + (m.charge + m.active + m.rest) / speed + 0.8;
    f.tally.casts++;
    this.moveUses[m.id] = (this.moveUses[m.id] ?? 0) + 1;
    f.elementsUsed[m.element] = (f.elementsUsed[m.element] ?? 0) + 1;
    this.emit({ type: "phase", a: f.idx, b: target, label: "charge", move: m.id, element: m.element, value: f.phaseDur });
  }

  // ------------------------------------------------------------------ strikes
  private strike(f: Fighter): void {
    const m = f.move!;
    const t = this.fighters[f.target];
    const fp = f.body.pos;
    const head = v3(fp.x, fp.y + f.ph.heightM * 0.6, fp.z);
    switch (m.shape) {
      case "melee": {
        // Contact if the gap between the two body SURFACES is within reach + a lunge.
        const gap = distXZ(fp, t.body.pos) - f.body.radius - t.body.radius;
        const dirx = t.body.pos.x - fp.x, dirz = t.body.pos.z - fp.z, dl = Math.hypot(dirx, dirz) || 1;
        applyImpulse(f.body, v3((dirx / dl) * f.body.mass * 3, 0, (dirz / dl) * f.body.mass * 3));
        if (!t.ko && gap <= f.stats.reach + m.range + MELEE_LUNGE && this.canReach(f, t, m)) {
          this.hit(f, t, m, 1, "melee", t.body.pos);
          // Cleave: a large body (3+ slots) sweeps every other enemy in its frontal arc and reach.
          if (f.ph.slots >= 3) {
            const fwd = Math.atan2(dirx, dirz);
            for (const o of this.enemiesOf(f)) {
              if (o === t || !this.canReach(f, o, m)) continue;
              const og = distXZ(fp, o.body.pos) - f.body.radius - o.body.radius;
              let da = Math.atan2(o.body.pos.x - fp.x, o.body.pos.z - fp.z) - fwd;
              while (da > Math.PI) da -= Math.PI * 2;
              while (da < -Math.PI) da += Math.PI * 2;
              if (og <= f.stats.reach + m.range + MELEE_LUNGE && Math.abs(da) < Math.PI / 3) this.hit(f, o, m, 0.5, "cleave", o.body.pos);
            }
          }
        } else this.miss(f, t, m, `out of reach (gap ${r3(gap)} m)`);
        break;
      }
      case "projectile": {
        const lead = this.leadAim(f, t, m.speed);
        const dx = lead.x - head.x, dy = lead.y + t.ph.heightM * 0.4 - head.y, dz = lead.z - head.z;
        const dl = Math.hypot(dx, dy, dz) || 1;
        const p: Projectile = {
          id: this.nextId++,
          owner: f.idx,
          team: f.team,
          move: m,
          pos: { ...head },
          vel: v3((dx / dl) * m.speed, (dy / dl) * m.speed, (dz / dl) * m.speed),
          ttl: (m.range * 1.4) / m.speed,
          // Bigger bodies throw bigger projectiles (+0.12 m of hit radius per metre of height).
          radius: 0.25 + m.power / 400 + 0.12 * f.ph.heightM,
          element: m.element,
          alive: true,
        };
        this.projectiles.push(p);
        this.emit({ type: "projectile", a: f.idx, b: t.idx, value: p.id, element: m.element, move: m.id, pos: { ...head } });
        break;
      }
      case "beam": {
        const end = v3(t.body.pos.x, t.body.pos.y + t.ph.heightM * 0.4, t.body.pos.z);
        const len = dist(head, end);
        let victim: Fighter | null = null;
        let best = Infinity;
        for (const o of this.enemiesOf(f)) {
          if (!this.canReach(f, o, m)) continue;
          const along = ((o.body.pos.x - head.x) * (end.x - head.x) + (o.body.pos.z - head.z) * (end.z - head.z)) / (len * len || 1);
          if (along < 0 || along > 1.1) continue;
          const px = head.x + (end.x - head.x) * along, pz = head.z + (end.z - head.z) * along;
          const off = Math.hypot(o.body.pos.x - px, o.body.pos.z - pz);
          if (off < o.body.radius + 0.5 + 0.12 * f.ph.heightM && along < best) {
            best = along;
            victim = o;
          }
        }
        // Beams crossing a reactive zone trigger its reaction on the way.
        for (const z of this.zones) {
          const r = reactionBetween(m.element, z.element);
          if (r && distXZ(z.pos, head) + distXZ(z.pos, end) < len + z.radius * 1.2) this.react(f, m.element, z.element, z.pos, `beam through ${z.kind}`);
        }
        this.emit({ type: "phase", a: f.idx, b: victim?.idx ?? t.idx, label: "beam", move: m.id, element: m.element, pos: end });
        if (victim && distXZ(fp, victim.body.pos) <= m.range + victim.body.radius) this.hit(f, victim, m, 1, "beam", victim.body.pos);
        else this.miss(f, t, m, "beam missed");
        break;
      }
      case "burst": {
        let any = false;
        for (const o of this.enemiesOf(f)) {
          const d = distXZ(fp, o.body.pos) - o.body.radius;
          if (d > m.area || !this.canReach(f, o, m)) continue;
          any = true;
          this.hit(f, o, m, 1 - 0.45 * clamp(d / m.area, 0, 1), "burst", o.body.pos);
        }
        this.groundImpact(f, m, fp, m.area * 0.7);
        if (!any) this.miss(f, t, m, "nobody in the area");
        break;
      }
      case "zone": {
        const at = this.leadAim(f, t, 18);
        const z = this.spawnZone("field", m.element, at, m.area, 3 + m.area, f, m);
        for (const o of this.enemiesOf(f)) {
          if (distXZ(o.body.pos, at) < m.area + o.body.radius && this.canReach(f, o, m)) this.hit(f, o, m, 0.65, "zone", o.body.pos);
        }
        this.groundImpact(f, m, at, m.area * 0.8);
        this.emit({ type: "zone", a: f.idx, value: z.id, element: m.element, pos: at, move: m.id });
        break;
      }
      case "cone": {
        // Breath / spray from the mouth: every enemy inside the arc and the range, weaker at the edge.
        const arc = m.arc ?? 0.45;
        const aim = Math.atan2(t.body.pos.x - fp.x, t.body.pos.z - fp.z);
        let any = false;
        for (const o of this.enemiesOf(f)) {
          if (!this.canReach(f, o, m)) continue;
          const d = distXZ(fp, o.body.pos) - o.body.radius;
          if (d > m.range + f.body.radius) continue;
          const da = Math.abs(angleDiff(Math.atan2(o.body.pos.x - fp.x, o.body.pos.z - fp.z), aim));
          if (da > arc + Math.atan2(o.body.radius, Math.max(0.5, d))) continue;
          any = true;
          this.hit(f, o, m, 1 - 0.35 * clamp(d / Math.max(1, m.range), 0, 1), "cone", o.body.pos);
        }
        const mid = v3(fp.x + Math.sin(aim) * m.range * 0.6, fp.y, fp.z + Math.cos(aim) * m.range * 0.6);
        for (const z of this.zones) {
          if (reactionBetween(m.element, z.element) && distXZ(z.pos, mid) < z.radius + m.range * 0.5) this.react(f, m.element, z.element, z.pos, `breath through ${z.kind}`);
        }
        this.groundImpact(f, m, mid, Math.max(1, m.range * Math.tan(arc) * 0.6));
        this.emit({ type: "phase", a: f.idx, b: t.idx, label: "cone", move: m.id, element: m.element, pos: head, value: m.range });
        if (!any) this.miss(f, t, m, "nobody inside the cone");
        break;
      }
      case "dash": {
        // The body travels toward the target (at most the move's range) during the active phase and
        // strikes on arrival (advancePhase). Its own momentum: heavy bodies hit harder (massScaled).
        const dx = t.body.pos.x - fp.x, dz = t.body.pos.z - fp.z, dl = Math.hypot(dx, dz) || 1;
        const go = clamp(dl - f.body.radius - t.body.radius - 0.15, 0, m.range);
        const to = v3(fp.x + (dx / dl) * go, fp.y, fp.z + (dz / dl) * go);
        f.dash = { from: { ...fp }, to, t0: this.t, dur: Math.max(0.12, m.active) };
        this.emit({ type: "phase", a: f.idx, b: t.idx, label: "dash", move: m.id, element: m.element, pos: { ...to }, value: go });
        break;
      }
      case "dig": {
        if (!GROUNDS[f.body.groundId].diggable) {
          this.emit({ type: "fail", a: f.idx, label: "ground too hard to dig", pos: fp, move: m.id });
          this.log("battle.fail", f.id, "dig needs diggable ground", f.id, f.body.groundId, fp, { move: m.id }, { reason: `${f.body.groundId} not diggable` });
          break;
        }
        f.status.set("burrowed", m.active);
        f.body.mode = "burrow";
        this.emit({ type: "status", a: f.idx, label: "burrowed", move: m.id, pos: fp });
        break;
      }
      default:
        this.selfEffects(f, m);
    }
  }

  private leadAim(f: Fighter, t: Fighter, speed: number): V3 {
    const d = distXZ(f.body.pos, t.body.pos);
    const tt = speed > 0 ? d / speed : 0;
    const skill = 0.4 + 0.6 * u01(f.ph.axes.wisdom);
    return v3(t.body.pos.x + t.body.vel.x * tt * skill, t.body.pos.y, t.body.pos.z + t.body.vel.z * tt * skill);
  }

  private selfEffects(f: Fighter, m: Move): void {
    for (const e of m.effects) {
      if (e.kind === "status" && e.status) this.addStatus(f, e.status, e.duration ?? 3, f);
      if (e.kind === "heal") {
        const before = f.hp;
        f.hp = Math.min(f.maxHp, f.hp + f.maxHp * (e.value ?? 0) * PACE * Math.pow(HEAL_DECAY, f.heals));
        f.heals++;
        this.emit({ type: "status", a: f.idx, label: "heal", value: f.hp - before, pos: f.body.pos });
      }
      if (e.kind === "weather" && e.weather) this.setWeather(e.weather, e.duration ?? 14, f);
      if (e.kind === "ground" && e.ground) {
        const t = this.fighters[f.target];
        const at = m.range > 0 && t ? t.body.pos : f.body.pos;
        const n = this.arena.setGround(at.x, at.z, m.area, e.ground);
        this.emit({ type: "terrain", a: f.idx, label: e.ground, pos: { ...at }, value: m.area });
        this.log("battle.terrain", f.id, `terraform to ${e.ground}`, f.body.groundId, e.ground, at, { move: m.id, radius: m.area }, { cells: n });
      }
    }
    if (m.shape === "fly") {
      f.body.mode = "fly";
      f.body.flyAlt = 1.8 + f.ph.heightM * 0.9;
    }
  }

  private setWeather(w: WeatherId, duration: number, by: Fighter | null): void {
    const before = this.weather;
    this.weather = w;
    this.weatherTimer = duration;
    this.emit({ type: "weather", a: by?.idx, label: w });
    this.log("battle.weather", by?.id ?? "sky", by ? `${by.name} changed the weather` : "weather expired", before, w, by?.body.pos ?? v3(), { duration }, { weather: w }, true);
  }

  private groundImpact(f: Fighter, m: Move, at: V3, r: number): void {
    const gEl = GROUND_REACTS[m.element]?.[this.arena.groundIdAt(at.x, at.z)];
    if (gEl) {
      const rx = reactionBetween(m.element, gEl);
      if (rx && rx.id !== "conduction") this.react(f, m.element, gEl, at, `${m.element} on ${this.arena.groundIdAt(at.x, at.z)}`);
    }
    const before = this.arena.groundIdAt(at.x, at.z);
    const n = this.arena.applyElement(at.x, at.z, Math.max(0.8, r), m.element);
    if (n > 0) {
      const after = this.arena.groundIdAt(at.x, at.z);
      this.emit({ type: "terrain", a: f.idx, label: after, pos: { ...at }, value: r, element: m.element });
      this.log("battle.terrain", f.id, `${m.element} transforms the ground`, before, after, at, { move: m.id, radius: r3(r) }, { cells: n });
    }
  }

  private react(f: Fighter | null, a: ElementId, b: ElementId, at: V3, why: string): number {
    const r = reactionBetween(a, b);
    if (!r) return 1;
    this.reactions[r.id] = (this.reactions[r.id] ?? 0) + 1;
    if (f) f.tally.reactions++;
    if (r.zone && !this.zones.some((z) => z.kind === r.id && distXZ(z.pos, at) < z.radius * 0.6)) {
      this.spawnZone(r.id, a, at, r.zone.radius, r.zone.ttl, f, undefined);
    }
    if (r.id === "freeze") this.arena.setGround(at.x, at.z, 2.2, "ice");
    if (r.id === "melt") this.arena.applyElement(at.x, at.z, 2, "fire");
    if (r.id === "mud") this.arena.applyElement(at.x, at.z, 2.4, "water");
    if (r.id === "disperse") {
      for (const z of this.zones) if (["smoke", "mist", "dust", "contamination"].includes(z.kind) && distXZ(z.pos, at) < 5) z.ttl = Math.min(z.ttl, 0.3);
    }
    if (r.id === "eclipse") {
      for (const o of this.fighters) if (this.live(o) && distXZ(o.body.pos, at) < 4) this.addStatus(o, "blinded", 1, f);
    }
    this.emit({ type: "reaction", a: f?.idx, label: r.id, element: a, pos: { ...at }, value: r.damageMult });
    this.log("battle.reaction", f?.id ?? "environment", why, a, b, at, { a, b }, { reaction: r.id, damageMult: r.damageMult, zone: r.zone?.kind ?? "none" }, true);
    return r.damageMult;
  }

  private spawnZone(kind: Zone["kind"], el: ElementId, at: V3, radius: number, ttl: number, f: Fighter | null, m: Move | undefined): Zone {
    const spec = kind === "field" ? null : REACTION_ZONE[kind];
    const z: Zone = {
      id: this.nextId++,
      kind,
      element: el,
      pos: { ...at },
      radius,
      ttl,
      maxTtl: ttl,
      owner: f?.idx ?? -1,
      team: kind === "field" ? (f?.team ?? -1) : spec?.allies === false ? (f?.team ?? -1) : -1,
      dps: m ? m.power * 0.16 * ((f?.stats.atk ?? 40) / 40) : 0,
      frac: spec?.frac ?? 0,
      status: m ? (m.effects.find((e) => e.status && !e.self)?.status ?? null) : (spec?.status ?? null),
      accuracyMult: spec?.acc ?? 1,
      regen: spec?.regen ?? 0,
      move: m,
    };
    this.zones.push(z);
    this.emit({ type: "zone", a: f?.idx, value: z.id, label: kind, element: el, pos: { ...at } });
    return z;
  }

  private addStatus(t: Fighter, s: StatusId, dur: number, by: Fighter | null): void {
    if (IMMUNE[s]?.some((e) => t.types.includes(e))) return;
    // Tenacity: big bodies shake off harmful statuses faster (XL x0.63, L x0.71, M x0.83). Without
    // it, damage-over-time scales with the VICTIM's max HP while a swarm applies it N times as often.
    if (by !== t && HARMFUL.has(s)) dur /= 1 + 0.2 * (t.ph.slots - 1);
    const had = t.status.has(s);
    t.status.set(s, Math.max(t.status.get(s) ?? 0, dur));
    if (s === "frozen") t.body.mode = "frozen";
    if (s === "staggered") t.body.stagger = Math.max(t.body.stagger, dur);
    if (INTERRUPTING.has(s) && t.phase === "charge" && t.move && by && by.team !== t.team) this.interrupt(t, by, s);
    if (s === "wet" && t.status.has("burn")) {
      t.status.delete("burn");
      this.react(by, "water", "fire", t.body.pos, "wet body quenched a burn");
    }
    if (!had) {
      this.emit({ type: "status", a: t.idx, b: by?.idx, label: s, pos: { ...t.body.pos } });
      this.log("battle.status", by?.id ?? "environment", `applied ${s}`, by?.id ?? "env", t.id, t.body.pos, { status: s, duration: r3(dur) }, { active: t.status.size });
    }
  }

  private miss(f: Fighter, t: Fighter, m: Move, why: string): void {
    f.tally.misses++;
    this.emit({ type: "miss", a: f.idx, b: t.idx, move: m.id, element: m.element, pos: { ...t.body.pos }, label: why });
    this.log("battle.miss", f.id, why, f.id, t.id, t.body.pos, { move: m.id }, { hp: Math.round(t.hp) });
  }

  /** Resolve a hit: accuracy roll, damage breakdown, crits, reactions, statuses, knockback. */
  private hit(f: Fighter, t: Fighter, m: Move, scale: number, source: string, at: V3): void {
    if (t.ko) return;
    const p = this.hitChance(f, t, m);
    const roll = f.rng.next();
    if (roll > p) {
      this.miss(f, t, m, `roll ${r3(roll)} > p ${r3(p)}`);
      return;
    }
    const contact = m.tags.includes("contact");
    // Reactions with the target's state or the zone it stands in.
    let reactK = 1;
    if (m.element === "fire" && (t.status.has("wet") || this.inWater(t))) {
      reactK *= this.react(f, "fire", "water", t.body.pos, "fire hit a wet target");
      t.status.delete("wet");
    } else if (m.element === "fire" && t.types.includes("water")) {
      // A body made of water steams on contact: smoke cloud, but the type chart already prices the damage.
      this.react(f, "fire", "water", t.body.pos, "fire hit a water-bodied Genemon");
    }
    if (m.element === "water" && t.status.has("burn")) {
      reactK *= this.react(f, "water", "fire", t.body.pos, "water hit a burning target");
      t.status.delete("burn");
    } else if (m.element === "water" && t.types.includes("fire")) {
      this.react(f, "water", "fire", t.body.pos, "water hit a fire-bodied Genemon");
    }
    if (m.element === "fire" && t.status.has("frozen")) {
      reactK *= this.react(f, "fire", "ice", t.body.pos, "fire thawed a frozen target");
      t.status.delete("frozen");
      t.body.mode = "ground";
    }
    for (const z of this.zones) {
      if (z.kind === "field" || distXZ(z.pos, t.body.pos) > z.radius) continue;
      const r = reactionBetween(m.element, z.element);
      if (r && r.id !== z.kind) reactK *= this.react(f, m.element, z.element, t.body.pos, `${m.element} into ${z.kind}`);
    }
    // Physical vs special [P4-M1]: each body splits its (budgeted) attack and guard between the two
    // categories with a geometric mean of 1, so the split shapes a Genemon without adding power.
    const cat = moveCategory(m);
    const offK = cat === "status" ? 1 : f.ph.offense?.[cat] ?? 1, guardK = cat === "status" ? 1 : t.ph.guard?.[cat] ?? 1;
    const atkF = (f.stats.atk / 40) * offK / guardK;
    const defEff = t.stats.def * (t.status.has("shielded") ? 1.6 : 1) * (t.status.has("softened") ? 0.75 : 1);
    const defF = 100 / (100 + defEff);
    const typeK = typeMultiplier(m.element, t.types);
    const stab = f.types.includes(m.element) ? 1.2 : 1;
    const wx = this.weatherDef.elementMult[m.element] ?? 1;
    const gAff = 1 + 0.5 * (GROUNDS[f.body.groundId].affinity[m.element] ?? 0);
    const cond = m.element === "electric" ? this.conduction(t) : 1;
    const massRatio = f.body.mass / Math.max(0.5, t.body.mass);
    const size = contact ? clamp(Math.pow(massRatio, m.tags.includes("massScaled") ? 0.22 : 0.1), 0.75, 1.4) : 1;
    const prox = m.shape === "melee" ? 1.08 : 1;
    const emo = 1 + 0.15 * f.emotions.anger - (f.status.has("feared") ? 0.15 : 0);
    const team = this.teamMult(f, m.element);
    const rhythm = this.rhythmMult(f, m.element);
    const liquidK = t.status.has("liquid") ? (contact ? 0.5 : m.element === "electric" ? 1.25 : 1) : 1;
    const frozenK = t.status.has("frozen") ? 1.15 : 1;
    const wetFire = m.element === "fire" && t.status.has("wet") ? 0.8 : 1;
    let critP = f.stats.crit * (m.tags.includes("highCrit") ? 2 : 1) * (f.status.has("focused") ? 1.6 : 1) * (1 + 0.3 * f.emotions.joy);
    critP = clamp(critP, 0, 0.5);
    const crit = f.rng.chance(critP);
    const spread = f.rng.range(0.88, 1.12);
    const body = bodyFactor(m, f.ph);
    const dmg = Math.max(1, PACE * m.power * body * atkF * defF * typeK * stab * wx * gAff * cond * size * prox * emo * team * rhythm * liquidK * frozenK * wetFire * reactK * scale * spread * (crit ? 1.6 : 1));
    t.hp = Math.max(0, t.hp - dmg);
    f.tally.dealt += dmg;
    f.tally.hits++;
    if (crit) f.tally.crits++;
    t.tally.taken += dmg;
    t.damageTakenBy[m.element] = (t.damageTakenBy[m.element] ?? 0) + dmg;
    t.lastHitAt = this.t;
    // Emotions and learning.
    t.emotions.anger = clamp(t.emotions.anger + (dmg / t.maxHp) * 0.9, 0, 1);
    t.emotions.surprise = clamp(t.emotions.surprise + (crit ? 0.5 : 0.1), 0, 1);
    if (t.hp / t.maxHp < 0.3) t.emotions.fear = clamp(t.emotions.fear + 0.25 * (1 - u01(t.ph.axes.conviction)), 0, 1);
    f.emotions.joy = clamp(f.emotions.joy + (crit ? 0.2 : 0.04), 0, 1);
    const key = `${m.element}>${t.types[0]}`;
    const rate = 0.2 + 0.6 * u01(f.ph.axes.wisdom);
    f.memory[key] = r3((f.memory[key] ?? 1) * (1 - rate) + typeMultiplier(m.element, [t.types[0]]) * rate);
    this.emit({ type: "hit", a: f.idx, b: t.idx, move: m.id, element: m.element, value: dmg, crit, pos: { ...at }, label: source });
    this.log("battle.hit", f.id, `${m.name} (${source})`, f.id, t.id, at, {
      move: m.id,
      power: m.power,
      atk: r3(atkF),
      def: r3(defF),
      type: typeK,
      stab,
      weather: wx,
      ground: r3(gAff),
      conduction: r3(cond),
      size: r3(size),
      emotion: r3(emo),
      team: r3(team),
      rhythm: r3(rhythm),
      reaction: r3(reactK),
      category: cat,
      body: r3(body),
      crit,
    }, { damage: r3(dmg), hp: r3(t.hp), hpFrac: r3(t.hp / t.maxHp) });
    // Statuses, knockback, pull.
    const team2 = this.synergies[f.team];
    for (const e of m.effects) {
      if (e.self) continue;
      if (e.kind === "status" && e.status) {
        const boost = team2.reduce((s, x) => (x.element === m.element && x.statusMult ? s * x.statusMult : s), 1) * (crit ? 1.5 : 1);
        let chance = (e.chance ?? 1) * boost;
        if (e.status === "frozen" && t.status.has("wet")) chance += 0.2;
        if (f.rng.chance(clamp(chance, 0, 1))) this.addStatus(t, e.status, e.duration ?? 3, f);
      }
      if ((e.kind === "knockback" || e.kind === "pull") && !t.status.has("liquid")) {
        const dx = t.body.pos.x - f.body.pos.x, dz = t.body.pos.z - f.body.pos.z, dl = Math.hypot(dx, dz) || 1;
        const sign = e.kind === "pull" ? -1 : 1;
        const k = (e.value ?? 0) * (crit ? 1.8 : 1) * clamp(Math.sqrt(massRatio), 0.5, 2) * t.body.mass;
        const mag = applyImpulse(t.body, v3((sign * dx / dl) * k, k * 0.35, (sign * dz / dl) * k));
        if (mag > 2.5) this.emit({ type: "physics", a: t.idx, label: e.kind, value: mag, pos: { ...t.body.pos } });
      }
    }
    // Electric conduction chains through water and wet bodies - allies included (X3 fixed): each
    // bystander takes the RAW strike (no crit, no attacker type bonus carried over) re-weighted by
    // ITS OWN type and defence, at the weaker of the two conductivities, to at most 2 bystanders
    // (nearest first, falloff 1 / 0.6).
    if (m.element === "electric" && (this.inWater(t) || t.status.has("wet")) && source !== "conduction") {
      const raw = dmg / (typeK * defF * cond * liquidK * frozenK * (crit ? 1.6 : 1));
      const near = this.fighters
        .filter((o) => o !== t && o !== f && this.live(o) && distXZ(o.body.pos, t.body.pos) <= 4.5 && (this.inWater(o) || o.status.has("wet")))
        .sort((a, b) => distXZ(a.body.pos, t.body.pos) - distXZ(b.body.pos, t.body.pos))
        .slice(0, 2);
      near.forEach((o, i) => {
        const oDef = 100 / (100 + o.stats.def * (o.status.has("shielded") ? 1.6 : 1) * (o.status.has("softened") ? 0.75 : 1));
        const cd = raw * 0.45 * Math.min(this.conduction(o), cond) * typeMultiplier("electric", o.types) * oDef * (i === 0 ? 1 : 0.6);
        o.hp = Math.max(0, o.hp - cd);
        o.tally.taken += cd;
        f.tally.dealt += o.team !== f.team ? cd : 0;
        this.emit({ type: "hit", a: f.idx, b: o.idx, move: m.id, element: "electric", value: cd, pos: { ...o.body.pos }, label: o.team === f.team ? "conduction (ally)" : "conduction" });
        this.log("battle.conduction", f.id, "current chained through water", t.id, o.id, o.body.pos, {
          move: m.id,
          ally: o.team === f.team,
          rank: i,
          conduction: r3(Math.min(this.conduction(o), cond)),
        }, { damage: r3(cd), hp: r3(o.hp) });
        if (o.hp <= 0) this.knockOut(o, f);
      });
      if (near.length > 0) this.react(f, "electric", "water", t.body.pos, `current chained to ${near.length} more`);
    }
    if (t.hp <= 0) this.knockOut(t, f);
  }

  /**
   * Synergies live with their enablers (X4): when a fighter is knocked out, recompute its team's
   * synergies from the survivors and take back the stat multipliers of every synergy that no longer
   * holds. A team never GAINS a synergy by losing members.
   */
  private dropSynergies(t: Fighter): void {
    const before = this.synergies[t.team];
    if (before.length === 0) return;
    const alive = this.fighters.filter((o) => o.team === t.team && !o.ko);
    const after = alive.length ? synergies({ ...this.teams[t.team], members: alive.map((o) => o.genemon) }) : [];
    const keep = before.filter((s) => after.some((a) => a.id === s.id && a.element === s.element));
    const lost = before.filter((s) => !keep.includes(s));
    if (lost.length === 0) return;
    for (const s of lost) {
      for (const o of alive) for (const [k, v] of Object.entries(s.statMult ?? {}) as [keyof Stats, number][]) o.stats[k] /= v;
    }
    this.synergies[t.team] = keep;
    this.log("battle.synergyLost", t.id, "an enabler was knocked out", t.id, this.teams[t.team].owner, t.body.pos, {
      lost: lost.map((s) => s.id).join(","),
      survivors: alive.length,
    }, { remaining: keep.map((s) => s.id).join(",") || "none" });
  }

  private knockOut(t: Fighter, by: Fighter | null): void {
    if (t.ko) return;
    t.ko = true;
    t.koAt = this.t;
    t.phase = "idle";
    t.move = null;
    this.dropSynergies(t);
    t.body.mode = "ground";
    t.body.intent = { x: 0, z: 0, speed: 0 };
    if (by && by.team !== t.team) by.tally.kos++;
    if (by) by.emotions.joy = clamp(by.emotions.joy + 0.3, 0, 1);
    for (const ally of this.fighters) {
      if (ally.team === t.team && this.live(ally)) {
        ally.emotions.sadness = clamp(ally.emotions.sadness + 0.3 * u01(ally.ph.axes.sociality), 0, 1);
        ally.emotions.fear = clamp(ally.emotions.fear + 0.1 * (1 - u01(ally.ph.axes.conviction)), 0, 1);
      }
    }
    t.dash = null;
    this.emit({ type: "ko", a: by?.idx, b: t.idx, pos: { ...t.body.pos } });
    // The trainer throws the next Genemon from the bench into the freed place [P4-B2].
    const next = this.bench(t.team)[0];
    if (next && !this.pendingSwitches.some((x) => x.in === next.idx)) this.pendingSwitches.push({ t: this.t + SWITCH_ENTRY, team: t.team, out: t.idx, in: next.idx });
    this.log("battle.ko", by?.id ?? "environment", "hp reached 0", by?.id ?? "env", t.id, t.body.pos, { t: r3(this.t) }, { team: t.team }, true);
  }

  // ------------------------------------------------------------------ simulation step
  step(): void {
    if (this.winner !== null) return;
    const dt = this.dt;
    this.t += dt;
    this.tick++;
    const W = this.weatherDef;
    if (this.weatherTimer > 0) {
      this.weatherTimer -= dt;
      if (this.weatherTimer <= 0) this.setWeather(this.setup.arena.weather, 0, null);
    }
    // Weather hazards.
    if (this.weather === "storm") {
      this.lightningT -= dt;
      if (this.lightningT <= 0) {
        this.lightningT = 3 + this.rng.range(0, 3);
        const alive = this.fighters.filter((o) => this.live(o));
        if (alive.length) {
          const wts = alive.map((o) => 1 + (o.status.has("wet") ? 1 : 0) + (o.types.includes("metal") ? 1.5 : 0) + (o.body.mode === "fly" ? 1 : 0));
          const v = this.rng.weighted(alive, wts);
          const dmg = PACE * v.maxHp * 0.05 * (v.types.includes("electric") ? 0 : 1) * this.conduction(v);
          v.hp = Math.max(0, v.hp - dmg);
          v.tally.taken += dmg;
          this.emit({ type: "lightning", b: v.idx, value: dmg, pos: { ...v.body.pos }, element: "electric" });
          this.log("battle.lightning", "sky", "thunderstorm strike", "storm", v.id, v.body.pos, { conduction: r3(this.conduction(v)) }, { damage: r3(dmg) });
          if (dmg > 0 && this.rng.chance(0.3)) this.addStatus(v, "paralyzed", 1.5, null);
          if (v.hp <= 0) this.knockOut(v, null);
        }
      }
    }
    if (this.weather === "heatwave" && this.tick % 15 === 0) {
      const x = this.rng.range(-this.arena.radius, this.arena.radius), z = this.rng.range(-this.arena.radius, this.arena.radius);
      if (this.arena.groundIdAt(x, z) === "ice" || this.arena.groundIdAt(x, z) === "snow") this.arena.applyElement(x, z, 1.5, "fire");
    }
    if (this.weather === "snow" && this.tick % 20 === 0) {
      const x = this.rng.range(-this.arena.radius, this.arena.radius), z = this.rng.range(-this.arena.radius, this.arena.radius);
      if (this.arena.groundIdAt(x, z) === "water") this.arena.setGround(x, z, 1.2, "ice");
    }
    this.runSwitches(dt);
    for (const f of this.fighters) {
      if (f.ko || f.benched) continue;
      this.tickStatuses(f, dt, W.wetness, W.id);
      if (f.ko) continue;
      f.energy = Math.min(f.stats.energy, f.energy + f.stats.regen * dt * (f.phase === "rest" ? 1.5 : 1) - (f.body.mode === "fly" ? 1.5 * dt : 0));
      if (f.body.mode === "fly" && f.energy <= 1) {
        f.status.delete("airborne");
        f.body.mode = "ground";
      }
      // Cruise altitude, or skimming the ground while diving to strike.
      if (f.body.mode === "fly") f.body.flyAlt = this.t < f.swoopUntil ? Math.max(0.35, 0.3 * f.ph.heightM) : 1.8 + f.ph.heightM * 0.9;
      for (const k of ["anger", "fear", "joy", "surprise", "sadness"] as const) {
        f.emotions[k] += (f.ph.psyche.emotions[k] - f.emotions[k]) * dt * 0.08;
      }
      f.emotions.energy = f.energy / f.stats.energy;
      const disabled = f.status.has("frozen") || f.status.has("stunned") || f.status.has("staggered") || f.body.stagger > 0.05;
      if (f.phase === "idle") {
        f.cooldown -= dt;
        if (!disabled && f.cooldown <= 0) this.decide(f);
      } else if (!f.status.has("frozen") && !f.status.has("stunned")) {
        f.phaseT += dt;
        if (f.phaseT >= f.phaseDur) this.advancePhase(f);
      }
      this.steer(f);
    }
    this.updateProjectiles(dt);
    this.updateZones(dt);
    const physEv = stepPhysics(this.fighters.filter((f) => this.live(f)).map((f) => f.body), this.arena, W, dt);
    for (const f of this.fighters) if (f.dash && this.live(f)) this.dashStep(f);
    for (const e of physEv) {
      if (e.kind === "bump" || e.kind === "land" || e.kind === "splash") {
        const f = this.fighters.find((x) => x.id === e.a);
        this.emit({ type: "physics", a: f?.idx, label: e.kind, value: e.value, pos: e.pos });
      }
    }
    this.checkEnd();
  }

  private tickStatuses(f: Fighter, dt: number, wetness: number, w: WeatherId): void {
    if (wetness >= 0.45 && !f.types.includes("fire") && f.body.mode !== "burrow") f.status.set("wet", Math.max(f.status.get("wet") ?? 0, 1));
    if (this.inWater(f) && !f.types.includes("fire")) f.status.set("wet", Math.max(f.status.get("wet") ?? 0, 2));
    let dot = 0;
    if (f.status.has("burn")) dot += 0.016;
    if (f.status.has("poisoned")) dot += 0.03;
    if (w === "sandstorm" && !f.types.some((e) => e === "earth" || e === "metal")) dot += 0.008;
    if (w === "acidRain" && f.types.some((e) => e === "metal" || e === "plant")) dot += 0.008;
    if (GROUNDS[f.body.groundId].id === "lava" && f.body.mode === "ground" && !f.types.includes("fire")) dot += 0.05;
    let heal = f.status.has("regen") ? 0.02 : 0;
    for (const s of this.synergies[f.team]) if (s.regen && f.types.includes("plant")) heal += s.regen;
    for (const z of this.zones) {
      if (distXZ(z.pos, f.body.pos) > z.radius || f.body.mode === "burrow") continue;
      const enemyZone = z.team === -1 || z.team !== f.team;
      if (z.kind === "field") {
        if (z.team !== f.team && z.move && (!z.move.tags.includes("ground") || f.body.mode !== "fly")) {
          const dmgPs = PACE * z.dps * (100 / (100 + f.stats.def)) * typeMultiplier(z.element, f.types);
          f.hp -= dmgPs * dt;
          f.tally.taken += dmgPs * dt;
          if (z.owner >= 0) this.fighters[z.owner].tally.dealt += dmgPs * dt;
          if (z.status && this.tick % 15 === 0) this.addStatus(f, z.status, 1.2, z.owner >= 0 ? this.fighters[z.owner] : null);
        }
        continue;
      }
      if (z.regen > 0 && z.team === f.team) heal += z.regen;
      if (z.regen < 0) heal = 0;
      // Reaction zones hurt everyone inside, scaled by the type chart (a fire body resists a
      // wildfire it started, x0.5, but is not immune; a plant body takes x2).
      if (enemyZone && z.frac > 0) dot += z.frac * typeMultiplier(z.element, f.types);
      if (enemyZone && z.status && this.tick % 10 === 0) this.addStatus(f, z.status, 1, null);
    }
    if (dot > 0 || heal > 0) {
      f.hp = clamp(f.hp + PACE * (heal - dot) * f.maxHp * dt, 0, f.maxHp);
      if (dot > 0) f.tally.taken += PACE * dot * f.maxHp * dt;
    }
    for (const [s, left] of f.status) {
      const nl = left - dt;
      if (nl <= 0) {
        f.status.delete(s);
        if (s === "frozen" && f.body.mode === "frozen") f.body.mode = "ground";
        if (s === "airborne" && f.body.mode === "fly") f.body.mode = "ground";
        if (s === "burrowed") this.emerge(f);
        this.emit({ type: "status", a: f.idx, label: `${s}-end` });
      } else f.status.set(s, nl);
    }
    if (f.hp <= 0) this.knockOut(f, null);
  }

  /** A stun / freeze landed on a charge: the move is cancelled, its energy is lost [P4-M6]. */
  private interrupt(t: Fighter, by: Fighter, s: StatusId): void {
    const m = t.move!;
    t.phase = "idle";
    t.move = null;
    t.phaseT = 0;
    t.cooldown = 0.25;
    t.interrupted++;
    this.interruptCount++;
    this.emit({ type: "interrupt", a: by.idx, b: t.idx, move: m.id, element: m.element, label: s, pos: { ...t.body.pos } });
    this.log("battle.interrupt", by.id, `${s} cancelled a charging ${m.name}`, by.id, t.id, t.body.pos, { move: m.id, power: m.power, status: s }, { energyLost: f2(t.costs[t.moves.indexOf(m)] ?? 0) }, true);
  }

  private dashStep(f: Fighter): void {
    const d = f.dash!;
    const k = clamp((this.t - d.t0) / d.dur, 0, 1), e = k * k * (3 - 2 * k);
    const x = d.from.x + (d.to.x - d.from.x) * e, z = d.from.z + (d.to.z - d.from.z) * e;
    f.body.pos.x = x;
    f.body.pos.z = z;
    f.body.pos.y = Math.max(f.body.pos.y, this.arena.surfaceAt(x, z));
    f.body.vel.x = f.body.vel.z = 0;
  }

  private dashArrive(f: Fighter, m: Move): void {
    f.dash = null;
    const t = this.fighters[f.target];
    if (!t || !this.live(t) || t.team === f.team) return;
    const gap = distXZ(f.body.pos, t.body.pos) - f.body.radius - t.body.radius;
    if (gap <= f.stats.reach + MELEE_LUNGE && this.canReach(f, t, m)) this.hit(f, t, m, 1, "dash", t.body.pos);
    else this.miss(f, t, m, `dash fell short (gap ${r3(gap)} m)`);
  }

  /** Apply due switches (KO replacements, trainer orders, replay script) and run the AI trainer. */
  private runSwitches(dt: number): void {
    for (const k of [0, 1] as const) this.switchCd[k] = Math.max(0, this.switchCd[k] - dt);
    if (this.setup.field && (this.setup.aiSwitch ?? true) && this.tick % 15 === 0) this.aiTrainer(1);
    const due = this.pendingSwitches.filter((x) => x.t <= this.t + 1e-9);
    if (due.length === 0) return;
    this.pendingSwitches = this.pendingSwitches.filter((x) => !due.includes(x));
    for (const o of due) {
      const out = this.fighters[o.out], inn = this.fighters[o.in];
      if (!out || !inn || inn.ko || !inn.benched) continue;
      const replacement = out.ko;
      if (!replacement && (out.benched || this.switchCd[o.team] > 0)) continue;
      // The newcomer lands where the leaver stood (a KO'd body stays where it fell; land beside it).
      const p = out.body.pos, side = o.team === 0 ? -1 : 1;
      const x = replacement ? p.x + side * 1.2 : p.x, z = p.z;
      inn.benched = false;
      inn.body.pos = v3(x, this.arena.surfaceAt(x, z), z);
      inn.body.vel = v3();
      inn.cooldown = SWITCH_ENTRY;
      inn.phase = "idle";
      if (!replacement) {
        out.benched = true;
        out.phase = "idle";
        out.move = null;
        out.dash = null;
        // Recalled Genemon shed their transient states on the bench (HP is kept).
        for (const st of ["airborne", "burrowed", "liquid", "frozen", "stunned", "staggered", "feared", "confused"] as StatusId[]) out.status.delete(st);
        out.body.mode = "ground";
        out.body.pos = v3(side * (this.arena.radius + 2.5), 0, this.arena.radius * 0.55);
        this.switchCd[o.team] = SWITCH_COOLDOWN;
      }
      // Exact tick time (not rounded): a replay applies the order on the very same tick.
      const rec: SwitchOrder = { t: this.t, team: o.team, out: o.out, in: o.in };
      this.switches.push(rec);
      this.emit({ type: "switch", a: inn.idx, b: out.idx, label: replacement ? "replace" : "switch", pos: { ...inn.body.pos } });
      this.log("battle.switch", this.teams[o.team].owner, replacement ? "a fighter was knocked out" : "trainer switched", out.id, inn.id, inn.body.pos, { team: o.team, replacement }, { hp: r3(inn.hp / inn.maxHp) }, true);
    }
  }

  /**
   * The AI trainer (side 1, and side 0 when nobody drives it in a sim): recall a badly matched or
   * badly hurt fighter for a bench member that the enemy's types hit less hard.
   */
  aiTrainer(team: 0 | 1): void {
    if (this.switchCd[team] > 0) return;
    const bench = this.bench(team);
    if (bench.length === 0) return;
    const foes = this.fighters.filter((o) => o.team !== team && this.live(o));
    if (foes.length === 0) return;
    const threat = (g: Fighter) => foes.reduce((s, e) => s + Math.max(...e.moves.filter(isDamaging).map((mm) => typeMultiplier(mm.element, g.types)), 1), 0) / foes.length;
    for (const f of this.fighters.filter((o) => o.team === team && this.live(o))) {
      if (f.phase !== "idle") continue;
      const mine = threat(f);
      const best = bench.slice().sort((a, b) => threat(a) - threat(b))[0];
      const hurt = f.hp / f.maxHp < 0.25 && best.hp / best.maxHp > 0.6;
      if ((mine >= 2 && threat(best) <= 1) || hurt) {
        this.requestSwitch(team, f.idx, best.idx);
        return;
      }
    }
  }

  private emerge(f: Fighter): void {
    f.body.mode = "ground";
    f.body.pos.y = this.arena.surfaceAt(f.body.pos.x, f.body.pos.z);
    f.body.vel.y = 4;
    const m = f.move ?? f.moves.find((x) => x.shape === "dig");
    this.emit({ type: "phase", a: f.idx, label: "emerge", pos: { ...f.body.pos } });
    if (!m) return;
    for (const o of this.enemiesOf(f)) {
      if (distXZ(o.body.pos, f.body.pos) < 2 + o.body.radius && o.body.mode !== "fly") this.hit(f, o, m, 1, "emerge", o.body.pos);
    }
  }

  private advancePhase(f: Fighter): void {
    const m = f.move!;
    const speed = f.stats.rate * (f.status.has("hasted") ? 1.33 : 1);
    if (f.phase === "charge") {
      f.phase = "active";
      f.phaseT = 0;
      f.phaseDur = m.active;
      this.emit({ type: "phase", a: f.idx, b: f.target, label: "active", move: m.id, element: m.element, value: m.active });
      if (this.fighters[f.target]?.ko && f.target !== f.idx) {
        const alt = this.enemiesOf(f).sort((a, b) => distXZ(a.body.pos, f.body.pos) - distXZ(b.body.pos, f.body.pos))[0];
        if (alt) f.target = alt.idx;
      }
      this.strike(f);
    } else if (f.phase === "active") {
      if (m.shape === "dash") this.dashArrive(f, m);
      f.phase = "rest";
      f.phaseT = 0;
      f.phaseDur = m.rest / speed;
      this.emit({ type: "phase", a: f.idx, label: "rest", move: m.id, value: f.phaseDur });
    } else if (f.phase === "rest") {
      f.phase = "idle";
      f.move = null;
      f.cooldown = 0.12 + f.rng.next() * 0.25;
      this.emit({ type: "phase", a: f.idx, label: "idle" });
    }
  }

  /** Movement intent: approach to the move's range, kite if ranged, retreat when afraid. */
  private steer(f: Fighter): void {
    const b = f.body;
    const enemies = this.enemiesOf(f);
    if (enemies.length === 0 || f.status.has("frozen") || f.status.has("stunned") || f.dash) {
      b.intent = { x: 0, z: 0, speed: 0 };
      return;
    }
    const t = this.fighters[f.target] && !this.fighters[f.target].ko && this.fighters[f.target].team !== f.team
      ? this.fighters[f.target]
      : enemies.reduce((a, c) => (distXZ(c.body.pos, b.pos) < distXZ(a.body.pos, b.pos) ? c : a));
    b.face = t.body.pos;
    const dx = t.body.pos.x - b.pos.x, dz = t.body.pos.z - b.pos.z;
    const d = Math.hypot(dx, dz) || 1;
    const ux = dx / d, uz = dz / d;
    const planned = f.move ?? f.moves.filter(isDamaging).sort((a, c) => c.power - a.power)[0] ?? null;
    const far = u01(f.ph.axes.reach);
    const want = planned ? (planned.shape === "melee" ? f.stats.reach + t.body.radius + b.radius * 0.6 : planned.shape === "burst" ? planned.area * 0.7 : Math.min(planned.range * 0.7, 6 + 6 * far)) : 4;
    const afraid = f.status.has("feared") || (f.emotions.fear > 0.6 && f.hp / f.maxHp < 0.35);
    let ix = 0, iz = 0, sp = 0;
    if (afraid) {
      ix = -ux;
      iz = -uz;
      sp = 1;
    } else if (d > want + 0.4) {
      ix = ux;
      iz = uz;
      sp = 1;
    } else if (d < want - 1.6 && planned && planned.shape !== "melee") {
      ix = -ux;
      iz = -uz;
      sp = 0.7;
    } else {
      const side = f.idx % 2 ? 1 : -1;
      ix = -uz * side;
      iz = ux * side;
      sp = 0.25 + 0.2 * u01(f.ph.axes.tempo);
    }
    // Avoid hostile zones and (for non-swimmers) deep water.
    for (const z of this.zones) {
      const zd = distXZ(z.pos, b.pos);
      if (zd < z.radius + 1 && (z.team === -1 || z.team !== f.team) && (z.frac > 0 || z.dps > 0)) {
        ix += ((b.pos.x - z.pos.x) / (zd || 1)) * 0.8;
        iz += ((b.pos.z - z.pos.z) / (zd || 1)) * 0.8;
      }
    }
    if (!b.swimmer && this.arena.groundIdAt(b.pos.x + ix * 1.5, b.pos.z + iz * 1.5) === "deepWater") {
      ix -= ux * 0.3;
      iz += ux * 0.5;
    }
    const il = Math.hypot(ix, iz) || 1;
    const isMelee = f.move ? f.move.shape === "melee" || f.move.shape === "dig" : false;
    // Melee attackers keep closing while they wind up and lunge on the strike; casters plant their feet.
    const phaseK = f.phase === "charge" ? (isMelee ? 0.95 : 0.35) : f.phase === "active" ? (isMelee ? 1.1 : 0.6) : f.phase === "rest" ? 0.25 : 1;
    const statusK = (f.status.has("slowed") ? 0.6 : 1) * (f.status.has("paralyzed") ? 0.5 : 1) * (f.status.has("hasted") ? 1.35 : 1) * (f.status.has("liquid") ? 0.85 : 1);
    b.intent = { x: ix / il, z: iz / il, speed: clamp(sp * phaseK * statusK, 0, 1.4) };
  }

  private updateProjectiles(dt: number): void {
    const W = this.weatherDef;
    for (const p of this.projectiles) {
      if (!p.alive) continue;
      p.ttl -= dt;
      p.vel.x += W.wind * 0.15 * dt;
      p.pos.x += p.vel.x * dt;
      p.pos.y += p.vel.y * dt;
      p.pos.z += p.vel.z * dt;
      const owner = this.fighters[p.owner];
      // Clash with an enemy projectile: reaction (fire vs water -> smoke) or mutual cancel.
      for (const q of this.projectiles) {
        if (!q.alive || q === p || q.team === p.team) continue;
        if (dist(p.pos, q.pos) > p.radius + q.radius + 0.5) continue;
        const mid = v3((p.pos.x + q.pos.x) / 2, (p.pos.y + q.pos.y) / 2, (p.pos.z + q.pos.z) / 2);
        p.alive = q.alive = false;
        const r = reactionBetween(p.element, q.element);
        if (r) this.react(owner, p.element, q.element, mid, `projectiles clashed mid-air`);
        this.emit({ type: "clash", a: p.owner, b: q.owner, pos: mid, element: p.element, label: r?.id ?? "cancel" });
        this.log("battle.clash", owner.id, "projectiles collided", p.move.id, q.move.id, mid, { a: p.element, b: q.element }, { reaction: r?.id ?? "cancel" });
        break;
      }
      if (!p.alive) {
        this.emit({ type: "projectileEnd", value: p.id, pos: { ...p.pos } });
        continue;
      }
      for (const o of this.fighters) {
        if (!this.live(o) || o.team === p.team || o.status.has("burrowed")) continue;
        const cy = o.body.pos.y + o.ph.heightM * 0.45;
        if (Math.hypot(o.body.pos.x - p.pos.x, cy - p.pos.y, o.body.pos.z - p.pos.z) < o.body.radius + p.radius + o.ph.heightM * 0.25) {
          p.alive = false;
          this.hit(owner, o, p.move, 1, "projectile", p.pos);
          break;
        }
      }
      const ground = this.arena.surfaceAt(p.pos.x, p.pos.z);
      if (p.alive && (p.pos.y <= ground || p.ttl <= 0 || Math.hypot(p.pos.x, p.pos.z) > this.arena.radius + 2)) {
        p.alive = false;
        if (p.pos.y <= ground + 0.2) this.groundImpact(owner, p.move, p.pos, 1);
        this.miss(owner, this.fighters[owner.target] ?? owner, p.move, "projectile hit the ground");
      }
      if (!p.alive) this.emit({ type: "projectileEnd", value: p.id, pos: { ...p.pos } });
    }
    for (let i = this.projectiles.length - 1; i >= 0; i--) if (!this.projectiles[i].alive) this.projectiles.splice(i, 1);
  }

  private updateZones(dt: number): void {
    for (const z of this.zones) z.ttl -= dt;
    for (let i = this.zones.length - 1; i >= 0; i--) if (this.zones[i].ttl <= 0) this.zones.splice(i, 1);
  }

  private checkEnd(): void {
    const alive = [0, 1].map((t) => this.fighters.some((f) => f.team === t && !f.ko));
    if (!alive[0] || !alive[1]) {
      this.winner = !alive[0] && !alive[1] ? 2 : alive[0] ? 0 : 1;
      this.reason = "ko";
    } else if (this.t >= this.maxTime) {
      const frac = this.hpFrac();
      this.winner = Math.abs(frac[0] - frac[1]) < 0.02 ? 2 : frac[0] > frac[1] ? 0 : 1;
      this.reason = "timeout";
    }
    if (this.winner !== null) {
      const r = this.result();
      this.emit({ type: "end", value: this.winner, label: this.reason });
      this.log("battle.end", "system", this.reason, this.setup.teams[0].owner, this.setup.teams[1].owner, v3(), {
        arena: r.arena,
        weatherStart: r.weatherStart,
        weatherEnd: r.weatherEnd,
        hour: r.hour,
        synergiesA: r.synergies[0].join(",") || "none",
        synergiesB: r.synergies[1].join(",") || "none",
      }, {
        winner: r.winner,
        duration: r3(r.duration),
        hpA: r3(r.hpFrac[0]),
        hpB: r3(r.hpFrac[1]),
        mvp: r.mvp,
        reactions: Object.entries(r.reactions).map(([k, v]) => `${k}:${v}`).join(",") || "none",
      }, true);
    }
  }

  hpFrac(): [number, number] {
    const f = (team: number) => {
      let hp = 0, max = 0;
      for (const x of this.fighters) {
        if (x.team !== team) continue;
        // HP already scales with the size budget: weighting by slots again double-counted big bodies (X8).
        hp += x.hp;
        max += x.maxHp;
      }
      return max > 0 ? hp / max : 0;
    };
    return [f(0), f(1)];
  }

  run(): BattleResult {
    while (this.winner === null) this.step();
    return this.result();
  }

  result(): BattleResult {
    const mvp = this.fighters.slice().sort((a, b) => b.tally.dealt + b.tally.kos * 50 - (a.tally.dealt + a.tally.kos * 50))[0];
    const knowledge: BattleResult["knowledge"] = {};
    const elementsUsed: BattleResult["elementsUsed"] = {};
    const damageTakenBy: BattleResult["damageTakenBy"] = {};
    for (const f of this.fighters) {
      knowledge[f.id] = f.memory;
      elementsUsed[f.id] = f.elementsUsed;
      damageTakenBy[f.id] = f.damageTakenBy;
    }
    return {
      winner: this.winner ?? 2,
      reason: this.reason,
      duration: this.t,
      hpFrac: this.hpFrac(),
      mvp: mvp?.id ?? "",
      arena: this.arena.spec.kind,
      weatherStart: this.setup.arena.weather,
      weatherEnd: this.weather,
      hour: this.setup.arena.hour,
      reactions: { ...this.reactions },
      fighters: this.fighters.map((f) => ({ id: f.id, name: f.name, team: f.team, alive: !f.ko, hpFrac: f.hp / f.maxHp, tally: { ...f.tally } })),
      knowledge,
      elementsUsed,
      damageTakenBy,
      moveUses: { ...this.moveUses },
      synergies: [this.synergies[0].map((s) => s.id), this.synergies[1].map((s) => s.id)],
      switches: this.switches.slice(),
      interrupts: this.interruptCount,
    };
  }
}

/** Fold a battle result back into the Genemon (battle record, xp, learned knowledge, bond). */
export function applyBattleResult(r: BattleResult, teams: [Team, Team]): void {
  teams.forEach((team, ti) => {
    for (const g of team.members) {
      const c = g.conditions;
      if (r.winner === 2) c.battles.draws++;
      else if (r.winner === ti) c.battles.won++;
      else c.battles.lost++;
      const f = r.fighters.find((x) => x.id === g.id);
      if (f) c.battles.kos += f.tally.kos;
      for (const [el, d] of Object.entries(r.damageTakenBy[g.id] ?? {}) as [ElementId, number][]) {
        c.battles.damageTakenBy[el] = (c.battles.damageTakenBy[el] ?? 0) + d;
      }
      for (const [el, n] of Object.entries(r.elementsUsed[g.id] ?? {}) as [ElementId, number][]) {
        c.battles.elementsUsed[el] = (c.battles.elementsUsed[el] ?? 0) + n;
      }
      c.xp += r.winner === ti ? 60 : r.winner === 2 ? 35 : 25;
      c.bond = Math.min(1, c.bond + 0.01);
      // A battle is activity at its local hour: night fighters grow nocturnal.
      noteActivity(c, r.hour, 2);
      Object.assign(g.knowledge, r.knowledge[g.id] ?? {});
    }
  });
}

export function elementColor(e: ElementId): number {
  return ELEMENTS[e].color;
}
