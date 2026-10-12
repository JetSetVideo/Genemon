/**
 * Progress (pure): one profile's achievements and quest log, driven ONLY by ledger rows.
 *
 * ingest(row, ctx) runs the row through the content adapter (src/progress/events.ts), adds
 * eventWeight() (entries.units, else 1) to every achievement and active quest step whose trigger
 * matches (triggerMatches, ME = the profile) and RETURNS the rewards this very row earned. Unlocks
 * and completions are written into the state at the same moment, so a reward is returned once and
 * never again: not for a repeated row, not after toJSON / fromJSON. The caller pays it
 * (src/ui/progressStore.ts). No clock and no randomness here: `now`, the local `hour`, the team
 * level and the weather of the day come in through ctx.
 *
 * Rules
 * - Physical gate: a physical trigger (isPhysicalTrigger) and every step of a physicalOnly quest
 *   only count rows proving presence (entries.physical === true, or where.space === "physical",
 *   e.g. world.* GPS rows); a row with entries.physical === false never moves them, wherever it is.
 * - Quest log: available quests (questAvailable: team level, local hour, weather of the day,
 *   physical presence, finished chapters, giver stages) are accepted automatically, MAX_ACTIVE (5)
 *   at most: SOFA_SLOTS (3) for sofa quests and PHYSICAL_SLOTS (2) kept free for errands, so an
 *   errand is still offered when the player steps outside. The next quest of a pool comes from its
 *   least represented group (daily, story, task, weekly; ties in that order), first in QUESTS
 *   order. Only quests every step of which can move on the app's rows are offered (canProgress:
 *   app-native events, or events this profile already produced with those keys), so the log never
 *   fills with steps nothing can move yet.
 * - Presence: ctx.physical when given; otherwise a presence-proving row in the last PRESENCE_MS
 *   (30 min) - today the Lab's "I am physically there" experiences, GPS rows later.
 * - Gates that say WHEN (timeWindow) or UNDER WHICH SKY (weather) gate progress as well as the
 *   offer: Sun Salute only counts sunbathing between 07:00 and 11:00 on a clear or hot day.
 * - Repeats: a daily quest resets per local day (unfinished ones expire at midnight, finished ones
 *   come back), a weekly one per local week (Monday); every other quest is done once. Story
 *   chapters wait for the previous one (after) and the giver's community stage (default 1).
 * - Battles count once per seed (SPEC X1, like Profile.rewardedSeeds): a battle's content events
 *   are held until its outcome (battle.end) and counted then, so a replayed seed (already counted,
 *   or adopted from rewardedSeeds) and an abandoned battle count nothing, and toasts come after the
 *   fight. A battle whose battle.start this Progress never saw counts as its rows arrive.
 * - Steps progress in any order; a quest completes when every step reached its count.
 */
import type { EventInput, GEvent } from "../core/ledger.ts";
import { type Achievement, ACHIEVEMENT_BY_ID, ACHIEVEMENTS, CONTENT_EVENTS, eventWeight, REWARD_ITEMS, triggerMatches } from "../data/achievements.ts";
import { FOOD_IDS } from "../data/lifestyle.ts";
import { inTimeWindow, isPhysicalTrigger, type Quest, QUEST_BY_ID, questAvailable, type QuestContext, QUESTS, type QuestStep } from "../data/quests.ts";
import { WEATHER_IDS, type WeatherId } from "../data/weather.ts";
import { canProgress, ContentDeriver, LIVE_CONTENT, type SeenKeys } from "./events.ts";

export const MAX_ACTIVE = 5;
export const SOFA_SLOTS = 3;
export const PHYSICAL_SLOTS = 2;
/** How long a presence-proving row keeps the player "physically present" (ms). */
export const PRESENCE_MS = 30 * 60_000;

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const QUARTER_MS = 900_000;

/**
 * Local day number (days since 1970-01-01 in local time) from an epoch `now` and the local `hour`
 * at that instant: the UTC offset is inferred to the quarter hour and read in [-10:30, +13:30), so
 * Honolulu beats Kiribati and New Zealand summer time beats Niue. Pass IngestCtx.day to skip it.
 */
export function localDay(now: number, hour: number): number {
  if (!Number.isFinite(now)) return 0;
  if (!Number.isFinite(hour)) return Math.floor(now / DAY_MS);
  const utc = ((now % DAY_MS) + DAY_MS) % DAY_MS;
  let off = (((hour % 24) + 24) % 24) * HOUR_MS - utc;
  if (off >= 13.5 * HOUR_MS) off -= DAY_MS;
  else if (off < -10.5 * HOUR_MS) off += DAY_MS;
  off = Math.round(off / QUARTER_MS) * QUARTER_MS;
  return Math.floor((now + off) / DAY_MS);
}

/** Local week number; weeks start on Monday (day 0, 1970-01-01, was a Thursday). */
export function localWeek(day: number): number {
  return Math.floor((day + 3) / 7);
}

export interface IngestCtx {
  /** The profile this Progress belongs to; rows ingested under another id are ignored. */
  profileId: string;
  /** Local hour 0-24 of the real clock (quest time windows; battle rows without an hour). */
  hour: number;
  /** Epoch ms from the caller's clock (never read here). */
  now: number;
  /** Local day number (see localDay); default: inferred from now and hour. */
  day?: number;
  /** Highest level in the profile's team (quest minLevel); default: the last value given, else 1. */
  level?: number;
  /** Weather of the day (quest weather gates); default: the last value given (unknown = no weather quests). */
  weather?: WeatherId;
  /** Physically present right now (GPS session); default: inferred from recent presence-proving rows. */
  physical?: boolean;
  /** Community arc stage per giver name (missing = 1). */
  giverStages?: Readonly<Record<string, number>>;
}

export interface StepProgress {
  questId: string;
  stepId: string;
  count: number;
  target: number;
}

export interface IngestResult {
  /** Achievements unlocked by this row (their rewards are included below, once). */
  unlocked: Achievement[];
  /** Quest steps this row moved, with their new count. */
  questSteps: StepProgress[];
  /** Quests this row completed. */
  completed: Quest[];
  /** Credits earned by this row (achievements + quests). */
  credits: number;
  /** XP earned by this row (quests). */
  xp: number;
  /** Quests accepted during this call. */
  accepted: Quest[];
  /** Reward item ids earned by this row. */
  items: string[];
  /** Titles earned by this row. */
  titles: string[];
}

export interface ActiveQuestView {
  quest: Quest;
  acceptedAt: number;
  steps: { step: QuestStep; count: number; target: number }[];
}

export interface ProgressJSON {
  v: 1;
  profileId: string;
  /** Achievement id -> progress (sum of event weights) while locked. */
  ach: Record<string, number>;
  /** Achievement id -> unlock time (ms), in unlock order. */
  unlocked: Record<string, number>;
  active: { id: string; at: number; day: number; week: number; steps: Record<string, number> }[];
  /** Quest id -> completions, last completion time and its local day / week. */
  done: Record<string, { n: number; at: number; day: number; week: number }>;
  /** Quest id -> local day it was dropped (not offered again that day). */
  skip: Record<string, number>;
  /** Content event -> payload keys seen on this profile's rows (events outside LIVE_CONTENT). */
  seen: Record<string, string[]>;
  day: number | null;
  week: number | null;
  presenceAt: number | null;
  level: number;
  weather: WeatherId | null;
  items: Record<string, number>;
  titles: string[];
  earned: { credits: number; xp: number };
  /** Battle seeds already counted (a seed counts once), newest first. Optional in older saves. */
  battles: string[];
}

interface ActiveQuest {
  id: string;
  at: number;
  day: number;
  week: number;
  steps: Record<string, number>;
}

interface DoneQuest {
  n: number;
  at: number;
  day: number;
  week: number;
}

type Group = "daily" | "story" | "task" | "weekly";
const GROUPS: readonly Group[] = ["daily", "story", "task", "weekly"];
const groupOf = (q: Quest): Group => (q.kind === "daily" || q.kind === "story" || q.kind === "weekly" ? q.kind : "task");

const ACH_BY_WHAT = new Map<string, Achievement[]>();
for (const a of ACHIEVEMENTS) {
  const list = ACH_BY_WHAT.get(a.trigger.what);
  if (list) list.push(a);
  else ACH_BY_WHAT.set(a.trigger.what, [a]);
}

const REACH = new Map<string, boolean>();

/** Can every step of this quest move on the app's rows (canProgress)? */
export function questReachable(q: Quest, seen: SeenKeys = {}): boolean {
  const steps = () => q.steps.every((s) => canProgress(s.trigger, seen));
  if (Object.keys(seen).length > 0) return steps();
  let r = REACH.get(q.id);
  if (r === undefined) REACH.set(q.id, (r = steps()));
  return r;
}

const ITEM_IDS = new Set<string>([...REWARD_ITEMS, ...FOOD_IDS]);
const WEATHER_SET = new Set<string>(WEATHER_IDS);
const MAX_SEEN_KEYS = 40;
const MAX_TITLES = 64;
/** Counted battle seeds kept (Profile.rewardedSeeds keeps 300 too). */
const MAX_SEEDS = 300;
/** Battles held open at once (abandoned ones are dropped oldest first). */
const MAX_OPEN_BATTLES = 4;
const OUTCOMES = new Set(["battle.win", "battle.loss", "battle.draw"]);

/** "battle:<seed>" tag of a derived event, if any. */
function battleTagOf(d: GEvent): string | null {
  if (!Array.isArray(d.tags)) return null;
  const t = d.tags.find((x) => typeof x === "string" && x.startsWith("battle:") && x.length > 7);
  return t ?? null;
}

/** Proves presence: entries.physical === true, or a physical place unless the row says physical=false. */
const isPhysicalRow = (d: GEvent): boolean =>
  d.entries.physical === true || (d.entries.physical !== false && d.where.space === "physical");
const emptyResult = (): IngestResult => ({ unlocked: [], questSteps: [], completed: [], credits: 0, xp: 0, accepted: [], items: [], titles: [] });
const normHour = (h: number): number => (Number.isFinite(h) ? ((h % 24) + 24) % 24 : 12);
/** Prototype-free record: ids from storage can never reach Object.prototype. */
const dict = <T>(): Record<string, T> => Object.create(null);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown, min = 0): number => (typeof v === "number" && Number.isFinite(v) ? Math.max(min, v) : min);
const intOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : null);

function numDict(v: unknown, keep: (k: string) => boolean, max = Infinity): Record<string, number> {
  const out = dict<number>();
  if (!isObj(v)) return out;
  for (const [k, x] of Object.entries(v)) {
    if (keep(k) && typeof x === "number" && Number.isFinite(x) && x >= 0) out[k] = Math.min(max, x);
  }
  return out;
}

const hasAch = (k: string) => Object.hasOwn(ACHIEVEMENT_BY_ID, k);
const hasQuest = (k: string) => Object.hasOwn(QUEST_BY_ID, k);

/** Achievements and quest log of one profile. */
export class Progress {
  readonly profileId: string;
  #ach = dict<number>();
  #unlocked = dict<number>();
  #active: ActiveQuest[] = [];
  #done = dict<DoneQuest>();
  #skip = dict<number>();
  #seen = dict<string[]>();
  #day: number | null = null;
  #week: number | null = null;
  #presenceAt: number | null = null;
  #level = 1;
  #weather: WeatherId | null = null;
  #stages: Readonly<Record<string, number>> = {};
  #items = dict<number>();
  #titles: string[] = [];
  #earned = { credits: 0, xp: 0 };
  /** Battle seeds already counted, newest first (persisted). */
  #battles: string[] = [];
  /** Battle tag -> content events held until the outcome (transient). */
  readonly #open = new Map<string, GEvent[]>();
  /** Tags of battles being replayed: nothing of them counts (transient). */
  readonly #replays = new Set<string>();
  /** Bumped on every persisted change (the store saves when it moves). */
  #rev = 0;
  /** Bumped on every change that can alter which quests are offered. */
  #gate = 0;
  #offerSig = "";
  readonly #deriver = new ContentDeriver();

  constructor(profileId: string) {
    this.profileId = profileId;
  }

  /** Changes whenever the persisted state changes. */
  get revision(): number {
    return this.#rev;
  }

  /** Count one ledger row; returns what it earned (each reward exactly once). */
  ingest(row: GEvent, ctx: IngestCtx): IngestResult {
    const out = emptyResult();
    if (!ctx || ctx.profileId !== this.profileId) return out;
    const now = Number.isFinite(ctx.now) ? ctx.now : 0;
    const hour = normHour(ctx.hour);
    this.#context(ctx);
    const derived = this.#deriver.derive(row, { profileId: this.profileId, hour });
    for (const d of derived) this.#sense(d, now);
    this.#roll(ctx, now, hour);
    this.#offer(ctx, now, hour, out);
    for (const d of this.#gateBattles(derived)) this.#count(d, now, hour, out);
    if (out.completed.length > 0) this.#offer(ctx, now, hour, out);
    return out;
  }

  /** Day / week rollover and quest offers without a row (a screen opening, the app starting). */
  refresh(ctx: IngestCtx): Quest[] {
    const out = emptyResult();
    if (!ctx || ctx.profileId !== this.profileId) return out.accepted;
    const now = Number.isFinite(ctx.now) ? ctx.now : 0;
    const hour = normHour(ctx.hour);
    this.#context(ctx);
    this.#roll(ctx, now, hour);
    this.#offer(ctx, now, hour, out);
    return out.accepted;
  }

  /** Drop an active quest; it is not offered again the same local day. */
  abandon(questId: string): boolean {
    const i = this.#active.findIndex((a) => a.id === questId);
    if (i < 0) return false;
    this.#active.splice(i, 1);
    this.#skip[questId] = this.#day ?? 0;
    this.#gate++;
    this.#rev++;
    return true;
  }

  /** Battle seeds already paid elsewhere (Profile.rewardedSeeds): their replays count nothing. */
  adoptBattles(seeds: Iterable<number | string>): number {
    let n = 0;
    for (const s of seeds) {
      const seed = typeof s === "number" && Number.isFinite(s) ? String(s) : typeof s === "string" && s !== "" && s.length <= 32 ? s : "";
      if (seed === "" || this.#battles.includes(seed)) continue;
      this.#battles.push(seed);
      n++;
    }
    if (n > 0) {
      this.#battles = this.#battles.slice(0, MAX_SEEDS);
      this.#rev++;
    }
    return n;
  }

  /** Mark achievements as already unlocked WITHOUT reward (e.g. ids already in profile.achievements). */
  adoptUnlocked(ids: Iterable<string>, now: number): number {
    let n = 0;
    for (const id of ids) {
      if (typeof id !== "string" || !hasAch(id) || this.#unlocked[id] !== undefined) continue;
      this.#unlocked[id] = now;
      delete this.#ach[id];
      n++;
    }
    if (n > 0) this.#rev++;
    return n;
  }

  // ---------------------------------------------------------------- reads (views)

  /** Progress toward an achievement (its count once unlocked). */
  achievementProgress(id: string): number {
    if (!hasAch(id)) return 0;
    const v = this.#ach[id] ?? 0;
    return this.#unlocked[id] !== undefined ? Math.max(v, ACHIEVEMENT_BY_ID[id].trigger.count) : v;
  }

  isUnlocked(id: string): boolean {
    return hasAch(id) && this.#unlocked[id] !== undefined;
  }

  unlockedAt(id: string): number | undefined {
    return hasAch(id) ? this.#unlocked[id] : undefined;
  }

  get unlockedCount(): number {
    return Object.keys(this.#unlocked).length;
  }

  /** Unlocked achievement ids in unlock order. */
  unlockedIds(): string[] {
    return Object.keys(this.#unlocked);
  }

  /** The n most recent unlocks, newest first. */
  recentUnlocks(n = 5): { achievement: Achievement; at: number }[] {
    return Object.entries(this.#unlocked)
      .map(([id, at], i) => ({ id, at, i }))
      .sort((a, b) => b.at - a.at || b.i - a.i)
      .slice(0, Math.max(0, n))
      .map((x) => ({ achievement: ACHIEVEMENT_BY_ID[x.id], at: x.at }));
  }

  activeQuests(): ActiveQuestView[] {
    return this.#active.flatMap((a) => {
      if (!hasQuest(a.id)) return [];
      const quest = QUEST_BY_ID[a.id];
      return [{ quest, acceptedAt: a.at, steps: quest.steps.map((step) => ({ step, count: a.steps[step.id] ?? 0, target: step.trigger.count })) }];
    });
  }

  /** How many times a quest was completed. */
  completions(questId: string): number {
    return hasQuest(questId) ? (this.#done[questId]?.n ?? 0) : 0;
  }

  /** Inferred physical presence (a presence-proving row in the last PRESENCE_MS). */
  isPresent(now: number): boolean {
    return this.#presenceAt !== null && now - this.#presenceAt <= PRESENCE_MS;
  }

  /** Payload keys seen per content event outside LIVE_CONTENT (pass to canProgress). */
  seen(): SeenKeys {
    return { ...this.#seen };
  }

  items(): Record<string, number> {
    return { ...this.#items };
  }

  titles(): string[] {
    return [...this.#titles];
  }

  /** Credits and xp this profile earned from achievements and quests so far. */
  earned(): { credits: number; xp: number } {
    return { ...this.#earned };
  }

  // ---------------------------------------------------------------- persistence

  toJSON(): ProgressJSON {
    return {
      v: 1,
      profileId: this.profileId,
      ach: { ...this.#ach },
      unlocked: { ...this.#unlocked },
      active: this.#active.map((a) => ({ id: a.id, at: a.at, day: a.day, week: a.week, steps: { ...a.steps } })),
      done: Object.fromEntries(Object.entries(this.#done).map(([k, d]) => [k, { ...d }])),
      skip: { ...this.#skip },
      seen: Object.fromEntries(Object.entries(this.#seen).map(([k, keys]) => [k, [...keys]])),
      day: this.#day,
      week: this.#week,
      presenceAt: this.#presenceAt,
      level: this.#level,
      weather: this.#weather,
      items: { ...this.#items },
      titles: [...this.#titles],
      earned: { ...this.#earned },
      battles: [...this.#battles],
    };
  }

  /**
   * Rebuild from toJSON() output. Never throws: unknown ids, wrong types and out-of-range numbers are
   * dropped or clamped, and a document of another profile (profileId given and different) is ignored.
   */
  static fromJSON(raw: unknown, profileId?: string): Progress {
    const o = isObj(raw) ? raw : {};
    const stored = typeof o.profileId === "string" ? o.profileId : "";
    const p = new Progress(profileId ?? stored);
    if (profileId !== undefined && stored !== "" && stored !== profileId) return p;
    p.#ach = numDict(o.ach, hasAch);
    p.#unlocked = numDict(o.unlocked, hasAch);
    for (const id of Object.keys(p.#unlocked)) delete p.#ach[id];
    const seenIds = new Set<string>();
    for (const x of Array.isArray(o.active) ? o.active : []) {
      if (!isObj(x) || typeof x.id !== "string" || !hasQuest(x.id) || seenIds.has(x.id) || p.#active.length >= MAX_ACTIVE) continue;
      seenIds.add(x.id);
      const q = QUEST_BY_ID[x.id];
      const st = isObj(x.steps) ? x.steps : {};
      const steps = dict<number>();
      for (const s of q.steps) steps[s.id] = Math.min(s.trigger.count, num(st[s.id]));
      p.#active.push({ id: q.id, at: num(x.at), day: intOrNull(x.day) ?? 0, week: intOrNull(x.week) ?? 0, steps });
    }
    if (isObj(o.done)) {
      for (const [k, d] of Object.entries(o.done)) {
        if (!hasQuest(k) || !isObj(d)) continue;
        p.#done[k] = { n: Math.floor(num(d.n, 1)), at: num(d.at), day: intOrNull(d.day) ?? 0, week: intOrNull(d.week) ?? 0 };
      }
    }
    if (isObj(o.skip)) for (const [k, d] of Object.entries(o.skip)) if (hasQuest(k) && intOrNull(d) !== null) p.#skip[k] = intOrNull(d)!;
    if (isObj(o.seen)) {
      for (const [k, keys] of Object.entries(o.seen)) {
        if (!Object.hasOwn(CONTENT_EVENTS, k) || Object.hasOwn(LIVE_CONTENT, k) || !Array.isArray(keys)) continue;
        p.#seen[k] = [...new Set(keys.filter((x): x is string => typeof x === "string"))].slice(0, MAX_SEEN_KEYS);
      }
    }
    p.#day = intOrNull(o.day);
    p.#week = intOrNull(o.week);
    p.#presenceAt = typeof o.presenceAt === "number" && Number.isFinite(o.presenceAt) ? o.presenceAt : null;
    p.#level = Math.max(1, Math.floor(num(o.level, 1)));
    p.#weather = typeof o.weather === "string" && WEATHER_SET.has(o.weather) ? o.weather as WeatherId : null;
    p.#items = numDict(o.items, (k) => ITEM_IDS.has(k));
    if (Array.isArray(o.titles)) p.#titles = [...new Set(o.titles.filter((t): t is string => typeof t === "string" && t.length <= 40))].slice(0, MAX_TITLES);
    const e = isObj(o.earned) ? o.earned : {};
    p.#earned = { credits: num(e.credits), xp: num(e.xp) };
    if (Array.isArray(o.battles)) {
      p.#battles = [...new Set(o.battles.filter((s): s is string => typeof s === "string" && s !== "" && s.length <= 32))].slice(0, MAX_SEEDS);
    }
    return p;
  }

  // ---------------------------------------------------------------- internals

  #context(ctx: IngestCtx): void {
    if (typeof ctx.level === "number" && Number.isFinite(ctx.level)) {
      const level = Math.max(1, Math.floor(ctx.level));
      if (level !== this.#level) {
        this.#level = level;
        this.#gate++;
        this.#rev++;
      }
    }
    if (typeof ctx.weather === "string" && WEATHER_SET.has(ctx.weather) && ctx.weather !== this.#weather) {
      this.#weather = ctx.weather;
      this.#gate++;
      this.#rev++;
    }
    this.#stages = ctx.giverStages ?? {};
  }

  #present(ctx: IngestCtx, now: number): boolean {
    return typeof ctx.physical === "boolean" ? ctx.physical : this.isPresent(now);
  }

  /** Presence and the keys this profile's rows really carry (for canProgress). */
  #sense(d: GEvent, now: number): void {
    // Presence is set by proof and only expires (PRESENCE_MS): a sofa row (physical=false, e.g. the
    // quest.complete of a sofa quest) does not prove the player went home.
    if (isPhysicalRow(d) && this.#presenceAt !== now) {
      this.#presenceAt = now;
      this.#rev++;
    }
    if (Object.hasOwn(LIVE_CONTENT, d.what) || !Object.hasOwn(CONTENT_EVENTS, d.what)) return;
    const known = this.#seen[d.what] ?? [];
    const fresh = [...Object.keys(d.entries), ...Object.keys(d.exits)].filter((k) => !known.includes(k));
    if (fresh.length === 0 && this.#seen[d.what] !== undefined) return;
    this.#seen[d.what] = [...known, ...new Set(fresh)].slice(0, MAX_SEEN_KEYS);
    this.#gate++;
    this.#rev++;
  }

  /** Local day / week rollover: unfinished daily (weekly) quests of another day (week) expire. */
  #roll(ctx: IngestCtx, now: number, hour: number): void {
    const day = typeof ctx.day === "number" && Number.isFinite(ctx.day) ? Math.floor(ctx.day) : localDay(now, hour);
    const week = localWeek(day);
    if (day !== this.#day) {
      this.#day = day;
      this.#active = this.#active.filter((a) => QUEST_BY_ID[a.id].kind !== "daily" || a.day === day);
      this.#gate++;
      this.#rev++;
    }
    if (week !== this.#week) {
      this.#week = week;
      this.#active = this.#active.filter((a) => QUEST_BY_ID[a.id].kind !== "weekly" || a.week === week);
      this.#gate++;
      this.#rev++;
    }
  }

  /** Auto-accept available quests into the free slots (skipped while nothing that gates offers changed). */
  #offer(ctx: IngestCtx, now: number, hour: number, out: IngestResult): void {
    if (this.#active.length >= MAX_ACTIVE) return;
    const physical = this.#present(ctx, now);
    const stages = JSON.stringify(this.#stages);
    const sig = () => `${this.#gate}|${this.#day}|${Math.floor(hour)}|${physical}|${stages}`;
    if (sig() === this.#offerSig) return;
    const c: QuestContext = {
      level: this.#level,
      hour,
      weather: this.#weather ?? "clear",
      physical,
      completed: new Set(Object.keys(this.#done)),
      giverStages: this.#stages,
    };
    for (const pool of [false, true]) {
      const cap = pool ? PHYSICAL_SLOTS : SOFA_SLOTS;
      while (this.#active.length < MAX_ACTIVE) {
        const inPool = this.#active.map((a) => QUEST_BY_ID[a.id]).filter((q) => q.physicalOnly === pool);
        if (inPool.length >= cap) break;
        const load = (g: Group) => inPool.filter((q) => groupOf(q) === g).length;
        const order = [...GROUPS].sort((a, b) => load(a) - load(b) || GROUPS.indexOf(a) - GROUPS.indexOf(b));
        let pick: Quest | undefined;
        for (const g of order) {
          pick = QUESTS.find((q) => q.physicalOnly === pool && groupOf(q) === g && this.#offerable(q, c));
          if (pick) break;
        }
        if (!pick) break;
        this.#active.push({ id: pick.id, at: now, day: this.#day ?? 0, week: this.#week ?? 0, steps: Object.fromEntries(pick.steps.map((s) => [s.id, 0])) });
        out.accepted.push(pick);
        this.#gate++;
        this.#rev++;
      }
    }
    this.#offerSig = sig();
  }

  #offerable(q: Quest, c: QuestContext): boolean {
    if (this.#active.some((a) => a.id === q.id)) return false;
    if (this.#skip[q.id] !== undefined && this.#skip[q.id] === this.#day) return false;
    const d = this.#done[q.id];
    if (d) {
      if (q.kind === "daily") {
        if (d.day === this.#day) return false;
      } else if (q.kind === "weekly") {
        if (d.week === this.#week) return false;
      } else return false;
    }
    if (!questReachable(q, this.#seen)) return false;
    if (q.weather && this.#weather === null) return false;
    return questAvailable(q, c);
  }

  /**
   * Battles count once per seed: hold a battle's events until its outcome, then release them all if
   * the seed was never counted; a replay (seed already counted at its battle.start) releases nothing.
   */
  #gateBattles(derived: GEvent[]): GEvent[] {
    const out: GEvent[] = [];
    for (const d of derived) {
      const tag = battleTagOf(d);
      if (tag === null) {
        out.push(d);
        continue;
      }
      const seed = tag.slice(7);
      if (d.what === "battle.start") {
        this.#open.delete(tag);
        this.#replays.delete(tag);
        if (this.#battles.includes(seed)) {
          this.#replays.add(tag);
          if (this.#replays.size > MAX_OPEN_BATTLES) this.#replays.delete(this.#replays.values().next().value!);
        } else {
          this.#open.set(tag, [d]);
          if (this.#open.size > MAX_OPEN_BATTLES) this.#open.delete(this.#open.keys().next().value!);
        }
        continue;
      }
      const end = OUTCOMES.has(d.what);
      if (this.#replays.has(tag)) {
        if (end) this.#replays.delete(tag);
        continue;
      }
      const held = this.#open.get(tag);
      if (!held) {
        // battle.start not seen here: count as the rows come, the outcome once per seed.
        if (end && this.#battles.includes(seed)) continue;
        if (end) this.#remember(seed);
        out.push(d);
        continue;
      }
      held.push(d);
      if (!end) continue;
      this.#open.delete(tag);
      this.#remember(seed);
      out.push(...held);
    }
    return out;
  }

  #remember(seed: string): void {
    this.#battles = [seed, ...this.#battles.filter((s) => s !== seed)].slice(0, MAX_SEEDS);
    this.#rev++;
  }

  #count(d: GEvent, now: number, hour: number, out: IngestResult): void {
    const w = eventWeight(d);
    const physicalRow = isPhysicalRow(d);
    for (const a of ACH_BY_WHAT.get(d.what) ?? []) {
      if (this.#unlocked[a.id] !== undefined) continue;
      if (isPhysicalTrigger(a.trigger) && !physicalRow) continue;
      if (!triggerMatches(a.trigger, d, this.profileId)) continue;
      const v = (this.#ach[a.id] ?? 0) + w;
      this.#ach[a.id] = v;
      this.#rev++;
      if (v >= a.trigger.count) this.#unlock(a, now, out);
    }
    for (const aq of [...this.#active]) {
      const q = QUEST_BY_ID[aq.id];
      if (q.timeWindow && !inTimeWindow(q.timeWindow, hour)) continue;
      if (q.weather && (this.#weather === null || !q.weather.includes(this.#weather))) continue;
      let moved = false;
      for (const s of q.steps) {
        const cur = aq.steps[s.id] ?? 0;
        if (cur >= s.trigger.count) continue;
        if ((q.physicalOnly || isPhysicalTrigger(s.trigger)) && !physicalRow) continue;
        if (!triggerMatches(s.trigger, d, this.profileId)) continue;
        const next = Math.min(s.trigger.count, cur + w);
        aq.steps[s.id] = next;
        out.questSteps.push({ questId: q.id, stepId: s.id, count: next, target: s.trigger.count });
        moved = true;
      }
      if (!moved) continue;
      this.#rev++;
      if (q.steps.every((s) => (aq.steps[s.id] ?? 0) >= s.trigger.count)) this.#complete(q, aq, now, out);
    }
  }

  #unlock(a: Achievement, now: number, out: IngestResult): void {
    this.#unlocked[a.id] = now;
    delete this.#ach[a.id];
    out.unlocked.push(a);
    out.credits += a.reward.credits;
    this.#earned.credits += a.reward.credits;
    if (a.reward.itemId) this.#grantItem(a.reward.itemId, out);
    if (a.reward.title && !this.#titles.includes(a.reward.title)) {
      this.#titles.push(a.reward.title);
      out.titles.push(a.reward.title);
    }
    this.#rev++;
  }

  #complete(q: Quest, aq: ActiveQuest, now: number, out: IngestResult): void {
    this.#active = this.#active.filter((x) => x !== aq);
    this.#done[q.id] = { n: (this.#done[q.id]?.n ?? 0) + 1, at: now, day: this.#day ?? 0, week: this.#week ?? 0 };
    out.completed.push(q);
    out.credits += q.reward.credits;
    out.xp += q.reward.xp;
    this.#earned.credits += q.reward.credits;
    this.#earned.xp += q.reward.xp;
    if (q.reward.itemId) this.#grantItem(q.reward.itemId, out);
    this.#gate++;
    this.#rev++;
  }

  #grantItem(id: string, out: IngestResult): void {
    this.#items[id] = (this.#items[id] ?? 0) + 1;
    out.items.push(id);
  }
}

// ---------------------------------------------------------------- consumer rows

/** The quest.complete row the content contract expects from the quests consumer (CONTENT_EVENTS). */
export function questCompleteRow(q: Quest, profileId: string, now: number): EventInput {
  return {
    when: now,
    where: { x: 0, y: 0, z: 0, zone: "quests", space: q.physicalOnly ? "physical" : "virtual" },
    who: profileId,
    what: "quest.complete",
    why: `${q.giver}: ${q.name}`,
    from: q.giver,
    to: profileId,
    entries: { quest: q.id, kind: q.kind, giver: q.giver, physical: q.physicalOnly },
    exits: {},
  };
}

/** The achievement.unlock row the content contract expects from the achievements consumer. */
export function achievementUnlockRow(a: Achievement, profileId: string, now: number): EventInput {
  return {
    when: now,
    where: { x: 0, y: 0, z: 0, zone: "achievements", space: "ui" },
    who: profileId,
    what: "achievement.unlock",
    why: a.description,
    from: a.category,
    to: profileId,
    entries: { achievement: a.id, category: a.category, tier: a.tier },
    exits: {},
  };
}
