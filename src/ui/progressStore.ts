/**
 * Progress store (UI): the live wiring of src/progress/progress.ts. One Progress per active profile,
 * persisted in localStorage under "genemon.progress.<profileId>" and fed by EVERY new ledger row
 * (Ledger.subscribe), so achievements and quests move with whatever the player does (battles, the
 * Lab, later the world map and the market) without any screen having to call it.
 *
 * It is the only place progress rewards reach the profile, each exactly once: Progress returns a
 * reward once, and the store saves the progress state BEFORE paying, so a crash can lose a reward
 * but never pay it twice.
 * - credits -> profile.credits; unlocked ids -> profile.achievements (then the profile is saved);
 * - quest xp -> every Genemon of the team through grantXp(), so level-ups are ledger rows too;
 * - the consumer rows the content contract expects (quest.complete, achievement.unlock) are written
 *   to the ledger and flow back in like any other row (Echo's "complete 3 quests", Completionist).
 * Ledger writes are deferred to a microtask so every subscriber sees rows in ledger order, and
 * unlocks / completions are announced in one batched toast.
 *
 * Integration (src/ui/app.ts): getProgress(this) once the profile is loaded, resetProgress() when
 * the active profile changes. A subscription left behind re-targets itself on its next row anyway.
 */
import type { GEvent } from "../core/ledger.ts";
import { grantXp, phenotypeOf } from "../genome/genemon.ts";
import { achievementUnlockRow, type IngestCtx, type IngestResult, Progress, questCompleteRow } from "../progress/progress.ts";
import type { App } from "./app.ts";
import { toast } from "./dom.ts";
import { teamOf } from "./profile.ts";

export interface StorageLike {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

/** localStorage key of a profile's progress. */
export const progressKey = (profileId: string): string => `genemon.progress.${profileId}`;

/** The stored progress of a profile, or a fresh one when missing or unreadable. */
export function loadProgress(storage: StorageLike, profileId: string): Progress {
  try {
    const raw = storage.getItem(progressKey(profileId));
    return raw ? Progress.fromJSON(JSON.parse(raw), profileId) : new Progress(profileId);
  } catch {
    return new Progress(profileId);
  }
}

export function saveProgress(storage: StorageLike, p: Progress): void {
  try {
    storage.setItem(progressKey(p.profileId), JSON.stringify(p.toJSON()));
  } catch (e) {
    console.warn("progress save failed (storage full?)", e);
  }
}

const SAVE_DELAY_MS = 1500;
const RENDER_DELAY_MS = 250;
const NOTE_DELAY_MS = 80;
const LEVEL_TTL_MS = 2000;
/** Screens that show progress: re-rendered (debounced) when it moves. */
const PROGRESS_SCREENS = new Set(["home", "achievements"]);

interface Slot {
  app: App;
  profileId: string;
  progress: Progress;
  off: () => void;
  timer: ReturnType<typeof setTimeout> | undefined;
  dirty: boolean;
}

let slot: Slot | null = null;
let levelCache = { at: 0, profileId: "", value: 1 };
let notes: string[] = [];
let noteTimer: ReturnType<typeof setTimeout> | undefined;
let renderTimer: ReturnType<typeof setTimeout> | undefined;
let flushInstalled = false;

/** The active profile's Progress (loaded, subscribed to app.ledger and offered quests on first call). */
export function getProgress(app: App): Progress {
  if (slot && slot.app === app && slot.profileId === app.profile.id) return slot.progress;
  resetProgress();
  const profileId = app.profile.id;
  const progress = loadProgress(localStorage, profileId);
  const s: Slot = { app, profileId, progress, off: () => {}, timer: undefined, dirty: false };
  slot = s;
  // profile.achievements and the progress state must agree, with no reward for either side.
  if (progress.adoptUnlocked(app.profile.achievements, Date.now()) > 0) markDirty(s);
  // Seeds the app already paid (X1) are replays for progress too.
  if (progress.adoptBattles(app.profile.rewardedSeeds ?? []) > 0) markDirty(s);
  let adopted = false;
  for (const id of progress.unlockedIds()) {
    if (!app.profile.achievements.includes(id)) {
      app.profile.achievements.push(id);
      adopted = true;
    }
  }
  if (adopted) app.store.save(app.profile);
  s.off = app.ledger.subscribe((row) => onRow(s, row));
  if (progress.refresh(ctxOf(app)).length > 0) markDirty(s);
  installFlush();
  return progress;
}

/** Save and unsubscribe the current profile's progress (call when the active profile changes). */
export function resetProgress(): void {
  const s = slot;
  if (!s) return;
  slot = null;
  s.off();
  flush(s);
}

/** Write pending progress now (also done on pagehide / when the tab is hidden). */
export function flushProgress(): void {
  if (slot) flush(slot);
}

/** Delete a profile's stored progress (call next to ProfileStore.remove(id)). */
export function forgetProgress(storage: StorageLike, profileId: string): void {
  const s = slot;
  if (s && s.profileId === profileId) {
    slot = null;
    s.off();
    if (s.timer !== undefined) clearTimeout(s.timer);
  }
  try {
    storage.removeItem(progressKey(profileId));
  } catch {
    /* storage unavailable: nothing to forget */
  }
}

/** Day rollover + quest offers for the current moment; returns the active profile's Progress. */
export function syncQuests(app: App): Progress {
  const p = getProgress(app);
  const before = p.revision;
  p.refresh(ctxOf(app));
  if (slot && p.revision !== before) markDirty(slot);
  return p;
}

/** Drop an active quest (offered again tomorrow at the earliest), refill the log and re-render. */
export function abandonQuest(app: App, questId: string): void {
  const p = getProgress(app);
  if (!p.abandon(questId)) return;
  p.refresh(ctxOf(app));
  if (slot) {
    slot.dirty = true;
    flush(slot);
  }
  app.render();
}

// ---------------------------------------------------------------- internals

function onRow(s: Slot, row: GEvent): void {
  if (slot !== s) return;
  // Ledger.emit does not catch: a throw here would abort the emitter (a battle step, a Lab action).
  try {
    handleRow(s, row);
  } catch (e) {
    console.warn("progress: row not counted", e);
  }
}

function handleRow(s: Slot, row: GEvent): void {
  const app = s.app;
  if (app.profile.id !== s.profileId) {
    // The active profile changed without resetProgress(): re-target. The new subscription is added
    // while the ledger is notifying, so it receives this row itself (Set iteration semantics).
    getProgress(app);
    return;
  }
  const before = s.progress.revision;
  const res: IngestResult = s.progress.ingest(row, ctxOf(app));
  if (s.progress.revision !== before) markDirty(s);
  if (res.unlocked.length > 0 || res.completed.length > 0) pay(s, res);
  if (res.accepted.length > 0) note(`📜 New quest: ${res.accepted.map((q) => `${q.name} (${q.giver})`).join(", ")}`);
  if (res.unlocked.length + res.completed.length + res.accepted.length + res.questSteps.length > 0) scheduleRender(app);
}

/** Pay the rewards of one ingest: progress saved first, then the profile, then the deferred ledger writes. */
function pay(s: Slot, res: IngestResult): void {
  const app = s.app;
  const prof = app.profile;
  s.dirty = true;
  flush(s);
  if (res.credits !== 0) prof.credits = Math.round(prof.credits + res.credits);
  for (const a of res.unlocked) if (!prof.achievements.includes(a.id)) prof.achievements.push(a.id);
  app.store.save(prof);
  for (const a of res.unlocked) {
    note(`🏆 ${a.name} · +${a.reward.credits} cr${a.reward.itemId ? ` · ${a.reward.itemId}` : ""}${a.reward.title ? ` · title "${a.reward.title}"` : ""}`);
  }
  for (const q of res.completed) {
    note(`✔ ${q.name} (${q.giver}) · +${q.reward.credits} cr · +${q.reward.xp} xp${q.reward.itemId ? ` · ${q.reward.itemId}` : ""}`);
  }
  const { xp, completed, unlocked } = res;
  queueMicrotask(() => {
    const when = Date.now();
    const guard = (what: string, fn: () => void) => {
      try {
        fn();
      } catch (e) {
        console.warn(`progress: ${what} failed`, e);
      }
    };
    if (xp > 0) {
      const where = { x: 0, y: 0, z: 0, zone: "quests", space: "virtual" as const };
      for (const g of teamOf(prof)) guard("quest xp", () => grantXp(g, xp, { ledger: app.ledger, when, where, who: prof.id, why: "quest reward" }));
      guard("profile save", () => app.store.save(prof));
    }
    for (const q of completed) guard("quest.complete", () => app.ledger.emit(questCompleteRow(q, prof.id, when)));
    for (const a of unlocked) guard("achievement.unlock", () => app.ledger.emit(achievementUnlockRow(a, prof.id, when)));
  });
}

function ctxOf(app: App): IngestCtx {
  const d = new Date();
  return {
    profileId: app.profile.id,
    now: d.getTime(),
    hour: d.getHours() + d.getMinutes() / 60,
    day: Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000),
    level: teamLevel(app),
    weather: app.rw.weather,
  };
}

/** Highest level in the active team (quest minLevel), cached for a moment: rows arrive in bursts. */
function teamLevel(app: App): number {
  const now = Date.now();
  if (levelCache.profileId === app.profile.id && now - levelCache.at < LEVEL_TTL_MS) return levelCache.value;
  let value = 1;
  try {
    for (const g of teamOf(app.profile)) value = Math.max(value, phenotypeOf(g).level);
  } catch {
    /* an unreadable Genemon keeps the level found so far */
  }
  levelCache = { at: now, profileId: app.profile.id, value };
  return value;
}

function markDirty(s: Slot): void {
  s.dirty = true;
  if (s.timer !== undefined) return;
  s.timer = setTimeout(() => {
    s.timer = undefined;
    flush(s);
  }, SAVE_DELAY_MS);
}

function flush(s: Slot): void {
  if (s.timer !== undefined) {
    clearTimeout(s.timer);
    s.timer = undefined;
  }
  if (!s.dirty) return;
  s.dirty = false;
  saveProgress(localStorage, s.progress);
}

function installFlush(): void {
  if (flushInstalled || typeof addEventListener !== "function") return;
  flushInstalled = true;
  addEventListener("pagehide", () => flushProgress());
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) flushProgress();
  });
}

function note(msg: string): void {
  notes.push(msg);
  if (noteTimer !== undefined) return;
  noteTimer = setTimeout(() => {
    noteTimer = undefined;
    const all = notes;
    notes = [];
    try {
      toast(all.slice(0, 3).join("  ·  ") + (all.length > 3 ? `  ·  +${all.length - 3} more` : ""), 4200);
    } catch {
      /* no #toast element (tests, headless) */
    }
  }, NOTE_DELAY_MS);
}

function scheduleRender(app: App): void {
  if (!PROGRESS_SCREENS.has(app.screen) || renderTimer !== undefined) return;
  renderTimer = setTimeout(() => {
    renderTimer = undefined;
    if (PROGRESS_SCREENS.has(app.screen)) app.render();
  }, RENDER_DELAY_MS);
}
