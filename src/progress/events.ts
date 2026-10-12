/**
 * Content events (pure): the single adapter between the rows the app REALLY writes today
 * (docs/DATA-MODEL.md) and the content vocabulary achievements and quests count (CONTENT_EVENTS,
 * Trigger, triggerMatches in src/data/achievements.ts). progress.ts never needs to know how
 * battle.ts or the Lab phrase their rows.
 *
 * deriveContentEvents(row, { profileId, hour }) returns the content events `row` produces FOR ONE
 * PROFILE P: copies of the row (same seq, when, where, why, from, to, tags; the id gets a ">what"
 * suffix when the name changes) whose `who` is P, whose `what` is the content name and whose
 * entries / exits gain the keys content filters on. The source row's own keys always win, so an
 * emitter that starts writing a requested key simply takes over. A row that counts for nobody, an
 * unknown row and a malformed row all derive [] - the function never throws.
 *
 * Battle rows name the ACTING Genemon (who), not its owner. battle.start names both owners
 * (from = side A, to = side B) and both rosters (entries.teamA / teamB, comma-joined Genemon ids),
 * so a small memory keyed by the battle tag ("battle:<seed>") keeps the rosters, the current sky,
 * the KOs and the reactions of each side: later rows are attributed through it and battle.end
 * becomes P's win / loss / draw. It holds the last 24 battles; each memory update is applied once
 * per row id, so several profiles may derive the same row.
 *
 * | app row (emitter)                       | content event          | counts for profile P when                                         | keys added (source)                                                  |
 * |-----------------------------------------|------------------------|-------------------------------------------------------------------|----------------------------------------------------------------------|
 * | battle.start (src/combat/battle.ts)     | battle.start           | P owns side A (from) or side B (to)                               | - (opens the memory: rosters, sky, hour; mode, slots* if written)     |
 * | battle.decide                           | battle.decide          | who is one of P's fighters                                        | -                                                                    |
 * | battle.hit                              | battle.hit             | who (the attacker) is P's                                         | element, contact (MOVE_BY_ID[move]); weatherId (current sky)          |
 * | battle.miss                             | battle.miss            | to (the target that dodged) is P's: content counts dodges         | -                                                                    |
 * | battle.fail                             | battle.fail            | who is P's                                                        | -                                                                    |
 * | battle.clash                            | battle.clash           | P is in the battle: a clash always pairs one projectile per side  | -                                                                    |
 * | battle.reaction                         | battle.reaction        | who (the cause) is P's; "environment" counts for nobody           | weather (current sky)                                                |
 * | battle.status                           | battle.status          | who (the applier) is P's and the target is an enemy or itself     | -                                                                    |
 * | battle.terrain                          | battle.terrain         | who is P's                                                        | -                                                                    |
 * | battle.weather                          | battle.weather         | who (the shaper) is P's; "sky" (expiry) counts for nobody         | - (memory: sky = exits.weather; the fight's weather changed)          |
 * | battle.lightning                        | -                      | nobody (who = sky)                                                | -                                                                    |
 * | battle.ko                               | battle.ko              | who (the attacker) is P's and the fallen (exits.team) is an enemy | move, element (the same-tick battle.hit of who on to); weather; night |
 * | battle.end (who = system)               | battle.win, battle.loss, battle.draw** | P owns a side (memory, else from / to)            | entries: arena, weather (sky at the start), hour (floored), night,    |
 * |                                         |                        |                                                                   |   teamSize, enemyCount; win: weatherChanged; mode, mySlots,           |
 * |                                         |                        |                                                                   |   enemySlots, myMaxSize* when battle.start writes them;               |
 * |                                         |                        |                                                                   | exits: durationS, reason (ko / timeout); win: survivors, flawless,    |
 * |                                         |                        |                                                                   |   reactions (caused by P's side)                                      |
 * | battle.win / loss / draw (future rows)  | same                   | who = P; skipped when battle.end already counted that battle for  | -                                                                    |
 * |                                         |                        | P, and battle.end is skipped when such a row came first           |                                                                      |
 * | genemon.feed / experience / experience.denied / exposure / xp / levelUp / evolve / specialize (genemon.ts) | same | who = P | -                     |
 * | genemon.create (Lab, why "bred ...")    | genemon.breed          | who = P                                                           | exits: child (= to), generation (entries.detail "... gen N")         |
 * | genemon.create (Lab, why "fused ...")   | genemon.fuse           | who = P                                                           | exits: child, generation                                             |
 * | genemon.create (morph, mutate)          | -                      | nobody: no content counts them                                    | -                                                                    |
 * | genemon.breed / genemon.fuse (future)   | same                   | who = P; one event per child (the twin genemon.create is skipped) | -                                                                    |
 * | market.sold (market.ts, who = house)    | market.sold            | exits.sellerId or exits.buyerId is P (content still filters ME)   | -                                                                    |
 * | any other CONTENT_EVENTS name: genemon.release / catch, market.post / bid / buyout, world.*, social.*,  | same | who = P | -                                  |
 * |   shop.buy, ladder.promote, dex.register, quest.complete and achievement.unlock (src/ui/progressStore.ts) |      |         |                                    |
 * | team.change, ui.*, device.*, net.*, anticheat.*, ladder.match, other market.*, anything else | -   | nobody                                                    | -                                                                    |
 *
 * night = outside 07:00-18:59, the battle engine's own day (Battle.isDay). * read when present:
 * battle.start entries mode, slotsA / slotsB (team slots) and maxSizeA / maxSizeB (largest size
 * class) are integration requests, battle.ts does not write them today. ** battle.draw is not in
 * CONTENT_EVENTS (no content counts draws); it is derived so a view can show it.
 */
import type { GEvent, Scalar, Space, Where } from "../core/ledger.ts";
import { CONTENT_EVENTS, parseFilterKey, resolveKey, type Trigger } from "../data/achievements.ts";
import { type Move, MOVE_BY_ID } from "../combat/moves.ts";

export interface DeriveCtx {
  /** Profile whose progress is counted: Profile.id, which is also the Team.owner battles log. */
  profileId: string;
  /** Local hour 0-24, used only when a battle row carries no hour of its own. */
  hour: number;
}

/** Night as the battle engine sees it (Battle.isDay: 07:00 to 18:59 is day). */
export function isNight(hour: number): boolean {
  const h = normHour(hour);
  return !(h >= 7 && h < 19);
}

// ---------------------------------------------------------------- reachability

/** Battle-context keys every derived outcome row can carry today. */
const OUTCOME_KEYS = ["arena", "weather", "hour", "night", "teamSize", "enemyCount", "durationS", "reason"] as const;
const NO_KEYS: readonly string[] = [];

/**
 * Content events the app's OWN rows produce today (battles, the Lab, the progress store), with the
 * payload keys this module adds on top of the emitter's own CONTENT_EVENTS keys. Events written by
 * modules that are wired in later (market.*, world.*, genemon.catch...) need no entry: Progress
 * marks an event live once the profile has actually produced it, with the keys it really carried.
 */
export const LIVE_CONTENT: Readonly<Record<string, readonly string[]>> = {
  "genemon.feed": NO_KEYS,
  "genemon.experience": NO_KEYS,
  "genemon.experience.denied": NO_KEYS,
  "genemon.exposure": NO_KEYS,
  "genemon.xp": NO_KEYS,
  "genemon.levelUp": NO_KEYS,
  "genemon.evolve": NO_KEYS,
  "genemon.specialize": NO_KEYS,
  "genemon.release": NO_KEYS,
  "battle.start": NO_KEYS,
  "battle.decide": NO_KEYS,
  "battle.miss": NO_KEYS,
  "battle.fail": NO_KEYS,
  "battle.clash": NO_KEYS,
  "battle.status": NO_KEYS,
  "battle.terrain": NO_KEYS,
  "battle.weather": NO_KEYS,
  "battle.hit": ["element", "contact", "weatherId"],
  "battle.reaction": ["weather"],
  "battle.ko": ["move", "element", "weather", "night"],
  "battle.win": [...OUTCOME_KEYS, "weatherChanged", "survivors", "flawless", "reactions"],
  "battle.loss": OUTCOME_KEYS,
  "genemon.breed": ["child", "generation"],
  "genemon.fuse": ["child", "generation"],
  "quest.complete": ["quest", "kind", "giver", "physical"],
  "achievement.unlock": ["achievement", "category", "tier"],
};

/** Payload keys a profile has actually seen per content event outside LIVE_CONTENT (kept by Progress). */
export type SeenKeys = Readonly<Record<string, readonly string[]>>;

/**
 * Can this trigger progress on the rows the app writes today? Either its event is in LIVE_CONTENT
 * and every filter key is added here or written by an emitted (non-requested) CONTENT_EVENTS key,
 * or the profile has already produced the event and every filter key was in those real rows.
 */
export function canProgress(t: Pick<Trigger, "what" | "filter">, seen: SeenKeys = {}): boolean {
  if (!Object.hasOwn(CONTENT_EVENTS, t.what)) return false;
  const spec = CONTENT_EVENTS[t.what];
  const extra = Object.hasOwn(LIVE_CONTENT, t.what) ? LIVE_CONTENT[t.what] : undefined;
  const observed = Object.hasOwn(seen, t.what) ? seen[t.what] : undefined;
  if (!extra && !observed) return false;
  return Object.keys(t.filter ?? {}).every((raw) => {
    const { key } = parseFilterKey(raw);
    if (extra?.includes(key) || observed?.includes(key)) return true;
    if (!extra) return false;
    const info = resolveKey(spec, raw);
    return spec.status === "emitted" && info !== undefined && !info.requested;
  });
}

// ---------------------------------------------------------------- row normalisation

/** A row with every field present and typed (whatever the input looked like). */
interface Row {
  id: string;
  seq: number;
  when: number;
  where: Where;
  who: string;
  what: string;
  why: string;
  from: string;
  to: string;
  entries: Record<string, Scalar>;
  exits: Record<string, Scalar>;
  tags: string[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const fin = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function normHour(h: number): number {
  return Number.isFinite(h) ? ((h % 24) + 24) % 24 : 12;
}

function flat(v: unknown): Record<string, Scalar> {
  const out: Record<string, Scalar> = {};
  if (!isObj(v)) return out;
  for (const [k, x] of Object.entries(v)) {
    if (typeof x === "string" || typeof x === "boolean" || (typeof x === "number" && Number.isFinite(x))) out[k] = x;
  }
  return out;
}

function normalize(raw: unknown): Row | null {
  if (!isObj(raw)) return null;
  const what = raw.what;
  if (typeof what !== "string" || what === "") return null;
  const w = isObj(raw.where) ? raw.where : {};
  return {
    id: str(raw.id),
    seq: fin(raw.seq) ?? 0,
    when: fin(raw.when) ?? 0,
    where: { x: fin(w.x) ?? 0, y: fin(w.y) ?? 0, z: fin(w.z) ?? 0, zone: str(w.zone) || "none", space: (str(w.space) || "sim") as Space },
    who: str(raw.who),
    what,
    why: str(raw.why),
    from: str(raw.from),
    to: str(raw.to),
    entries: flat(raw.entries),
    exits: flat(raw.exits),
    tags: Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => typeof t === "string") : [],
  };
}

function copy(r: Row, what: string, who: string, entries: Record<string, Scalar> = r.entries, exits: Record<string, Scalar> = r.exits): GEvent {
  return {
    id: what === r.what ? r.id : `${r.id}>${what}`,
    seq: r.seq,
    when: r.when,
    where: { ...r.where },
    who,
    what,
    why: r.why,
    from: r.from,
    to: r.to,
    entries: { ...entries },
    exits: { ...exits },
    tags: [...r.tags],
  };
}

const moveOf = (id: string): Move | undefined => (Object.hasOwn(MOVE_BY_ID, id) ? MOVE_BY_ID[id] : undefined);

// ---------------------------------------------------------------- battle memory

interface Memo {
  startId: string;
  lastId: string;
  owners: [string, string];
  teams: [Set<string>, Set<string>];
  arena: string;
  weatherStart: string;
  sky: string;
  hour: number | undefined;
  changed: boolean;
  reactions: [number, number];
  fallen: [Set<string>, Set<string>];
  lastHit: { who: string; to: string; when: number; move: string } | null;
  mode: string;
  slots: [number, number] | null;
  maxSize: [string, string] | null;
  /** Profile -> id of the row that produced its outcome (battle.end or a real per-owner row). */
  outcomes: Map<string, string>;
}

const MAX_BATTLES = 24;
const MAX_CHILDREN = 256;

function battleKey(r: Row): string {
  const tag = r.tags.find((t) => t.startsWith("battle:"));
  if (tag) return tag;
  const seed = r.entries.seed;
  return r.what === "battle.start" && (typeof seed === "number" || (typeof seed === "string" && seed !== "")) ? `battle:${seed}` : "";
}

function openMemo(r: Row): Memo {
  const e = r.entries;
  const roster = (v: Scalar | undefined) => new Set(typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);
  const slotsA = fin(e.slotsA), slotsB = fin(e.slotsB);
  const sizeA = str(e.maxSizeA), sizeB = str(e.maxSizeB);
  const weather = str(e.weather);
  return {
    startId: r.id,
    lastId: r.id,
    owners: [r.from, r.to],
    teams: [roster(e.teamA), roster(e.teamB)],
    arena: str(e.arena) || r.where.zone,
    weatherStart: weather,
    sky: weather,
    hour: fin(e.hour),
    changed: false,
    reactions: [0, 0],
    fallen: [new Set(), new Set()],
    lastHit: null,
    mode: str(e.mode),
    slots: slotsA !== undefined && slotsB !== undefined ? [slotsA, slotsB] : null,
    maxSize: sizeA && sizeB ? [sizeA, sizeB] : null,
    outcomes: new Map(),
  };
}

function sideOf(m: Memo, profileId: string): number {
  return m.owners[0] === profileId ? 0 : m.owners[1] === profileId ? 1 : -1;
}

function evictOldest<K, V>(map: Map<K, V>, max: number): void {
  while (map.size > max) {
    const first = map.keys().next();
    if (first.done) break;
    map.delete(first.value);
  }
}

// ---------------------------------------------------------------- the deriver

/** Stateful deriver (battle memory + one breed / fuse event per child). Progress owns one each. */
export class ContentDeriver {
  readonly #battles = new Map<string, Memo>();
  readonly #children = new Map<string, string>();

  derive(row: GEvent, ctx: DeriveCtx): GEvent[] {
    try {
      const r = normalize(row);
      const profileId = typeof ctx?.profileId === "string" ? ctx.profileId : "";
      if (!r || profileId === "") return [];
      this.#observe(r);
      return this.#project(r, profileId, normHour(ctx.hour));
    } catch {
      return [];
    }
  }

  /** Forget every battle and child. */
  clear(): void {
    this.#battles.clear();
    this.#children.clear();
  }

  /** Memory updates (profile-independent, once per row id). */
  #observe(r: Row): void {
    if (!r.what.startsWith("battle.")) return;
    const key = battleKey(r);
    if (key === "") return;
    if (r.what === "battle.start") {
      const old = this.#battles.get(key);
      if (old && r.id !== "" && old.startId === r.id) return;
      this.#battles.delete(key);
      this.#battles.set(key, openMemo(r));
      evictOldest(this.#battles, MAX_BATTLES);
      return;
    }
    const m = this.#battles.get(key);
    if (!m || (r.id !== "" && m.lastId === r.id)) return;
    m.lastId = r.id;
    switch (r.what) {
      case "battle.weather":
        m.sky = str(r.exits.weather) || r.to || m.sky;
        m.changed = true;
        break;
      case "battle.reaction": {
        const s: number = m.teams[0].has(r.who) ? 0 : m.teams[1].has(r.who) ? 1 : -1;
        if (s >= 0) m.reactions[s]++;
        break;
      }
      case "battle.ko": {
        const t = r.exits.team;
        const s: number = t === 0 || t === 1 ? t : m.teams[0].has(r.to) ? 0 : m.teams[1].has(r.to) ? 1 : -1;
        if (s >= 0 && r.to !== "") m.fallen[s].add(r.to);
        break;
      }
      case "battle.hit":
        m.lastHit = { who: r.who, to: r.to, when: r.when, move: str(r.entries.move) };
        break;
    }
  }

  #project(r: Row, p: string, hour: number): GEvent[] {
    if (r.what.startsWith("battle.")) return this.#battle(r, p, hour);
    switch (r.what) {
      case "genemon.create":
        return this.#create(r, p);
      case "genemon.breed":
      case "genemon.fuse":
        return r.who === p && this.#claim(p, str(r.exits.child) || r.to, r.id) ? [copy(r, r.what, p)] : [];
      case "market.sold":
        return r.exits.sellerId === p || r.exits.buyerId === p ? [copy(r, r.what, p)] : [];
    }
    return r.who === p && Object.hasOwn(CONTENT_EVENTS, r.what) ? [copy(r, r.what, p)] : [];
  }

  #battle(r: Row, p: string, hour: number): GEvent[] {
    const key = battleKey(r);
    const m = key === "" ? undefined : this.#battles.get(key);
    if (r.what === "battle.end") return this.#outcome(r, m, p, hour);
    if (r.what === "battle.win" || r.what === "battle.loss" || r.what === "battle.draw") {
      if (r.who !== p) return [];
      if (m) {
        const prev = m.outcomes.get(p);
        if (prev !== undefined && prev !== r.id) return [];
        m.outcomes.set(p, r.id);
      }
      return [copy(r, r.what, p)];
    }
    if (!m) return [];
    const side = sideOf(m, p);
    if (side < 0) return [];
    const mine = m.teams[side];
    switch (r.what) {
      case "battle.start":
      case "battle.clash":
        return [copy(r, r.what, p)];
      case "battle.decide":
      case "battle.fail":
      case "battle.terrain":
      case "battle.weather":
        return mine.has(r.who) ? [copy(r, r.what, p)] : [];
      case "battle.miss":
        return mine.has(r.to) && r.to !== r.who ? [copy(r, r.what, p)] : [];
      case "battle.status":
        return mine.has(r.who) && (r.to === r.who || !mine.has(r.to)) ? [copy(r, r.what, p)] : [];
      case "battle.hit": {
        if (!mine.has(r.who)) return [];
        const add: Record<string, Scalar> = {};
        const mv = moveOf(str(r.entries.move));
        if (mv) {
          add.element = mv.element;
          add.contact = mv.tags.includes("contact");
        }
        if (m.sky) add.weatherId = m.sky;
        return [copy(r, r.what, p, { ...add, ...r.entries })];
      }
      case "battle.reaction":
        return mine.has(r.who) ? [copy(r, r.what, p, { ...(m.sky ? { weather: m.sky } : {}), ...r.entries })] : [];
      case "battle.ko": {
        if (!mine.has(r.who)) return [];
        const t = r.exits.team;
        if (t === side || (t !== 0 && t !== 1 && mine.has(r.to))) return [];
        const add: Record<string, Scalar> = {};
        const h = m.lastHit;
        if (h && h.move !== "" && h.who === r.who && h.to === r.to && h.when === r.when) {
          add.move = h.move;
          const mv = moveOf(h.move);
          if (mv) add.element = mv.element;
        }
        if (m.sky) add.weather = m.sky;
        add.night = isNight(m.hour ?? hour);
        return [copy(r, r.what, p, { ...add, ...r.entries })];
      }
    }
    return [];
  }

  /** battle.end -> the profile's battle.win / battle.loss / battle.draw. */
  #outcome(r: Row, m: Memo | undefined, p: string, hour: number): GEvent[] {
    const winner = r.exits.winner;
    if (winner !== 0 && winner !== 1 && winner !== 2) return [];
    const side = m ? sideOf(m, p) : r.from === p ? 0 : r.to === p ? 1 : -1;
    if (side < 0) return [];
    if (m) {
      const prev = m.outcomes.get(p);
      if (prev !== undefined && prev !== r.id) return [];
      m.outcomes.set(p, r.id);
    }
    const what = winner === 2 ? "battle.draw" : winner === side ? "battle.win" : "battle.loss";
    const e = r.entries;
    const h = normHour(fin(e.hour) ?? m?.hour ?? hour);
    const weatherStart = str(e.weatherStart) || m?.weatherStart || "";
    const weatherEnd = str(e.weatherEnd) || m?.sky || "";
    const arena = str(e.arena) || m?.arena || "";
    const entries: Record<string, Scalar> = { hour: Math.floor(h), night: isNight(h) };
    if (arena) entries.arena = arena;
    if (weatherStart) entries.weather = weatherStart;
    const exits: Record<string, Scalar> = {};
    const duration = fin(r.exits.duration);
    if (duration !== undefined) exits.durationS = duration;
    if (r.why === "ko" || r.why === "timeout") exits.reason = r.why;
    const changedSky = weatherStart !== "" && weatherEnd !== "" && weatherStart !== weatherEnd;
    if (m) {
      const me = m.teams[side], them = m.teams[1 - side];
      if (me.size > 0) entries.teamSize = me.size;
      if (them.size > 0) entries.enemyCount = them.size;
      if (m.mode) entries.mode = m.mode;
      if (m.slots) {
        entries.mySlots = m.slots[side];
        entries.enemySlots = m.slots[1 - side];
      }
      if (what === "battle.win") {
        if (m.maxSize) entries.myMaxSize = m.maxSize[side];
        entries.weatherChanged = m.changed || changedSky;
        const fallen = m.fallen[side].size;
        if (me.size > 0) exits.survivors = Math.max(0, me.size - fallen);
        exits.flawless = fallen === 0;
        exits.reactions = m.reactions[side];
      }
    } else if (what === "battle.win" && weatherStart !== "" && weatherEnd !== "") {
      entries.weatherChanged = changedSky;
    }
    return [copy(r, what, p, entries, exits)];
  }

  /** Lab genemon.create rows -> genemon.breed / genemon.fuse (the Lab writes no breed row yet). */
  #create(r: Row, p: string): GEvent[] {
    if (r.who !== p) return [];
    const why = r.why.trim().toLowerCase();
    const what = why.startsWith("bred") ? "genemon.breed" : why.startsWith("fused") ? "genemon.fuse" : "";
    if (what === "" || !this.#claim(p, r.to, r.id)) return [];
    const gen = /\bgen\s*(\d+)\s*$/i.exec(str(r.entries.detail));
    const exits: Record<string, Scalar> = {};
    if (r.to !== "") exits.child = r.to;
    if (gen) exits.generation = Number(gen[1]);
    return [copy(r, what, p, {}, exits)];
  }

  /** One breed / fuse event per child: the first row naming it wins (the same row may re-derive). */
  #claim(p: string, child: string, rowId: string): boolean {
    if (child === "") return true;
    const k = `${p}|${child}`;
    const prev = this.#children.get(k);
    if (prev !== undefined) return rowId !== "" && prev === rowId;
    this.#children.set(k, rowId);
    evictOldest(this.#children, MAX_CHILDREN);
    return true;
  }
}

const shared = new ContentDeriver();

/** Content events a ledger row produces for one profile (shared memory; Progress keeps its own deriver). */
export function deriveContentEvents(row: GEvent, ctx: DeriveCtx): GEvent[] {
  return shared.derive(row, ctx);
}
