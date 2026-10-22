/**
 * The LONG LOOP driver [P5-L1 (UI), P5-G5]: every few real seconds, every Genemon of the collection
 * lives a little (digestion, hunger, ageing, circadian rhythm) through the genetics-life lane's
 * `tickLife(g, now, ctx)`, at the demo time scale of `settings.dev.timeScale` [P5-D1].
 *
 *  - on start it CATCHES UP the offline time (real time, at most MAX_CATCHUP_DAYS), then ticks every
 *    `periodMs` (5 s) with ctx { hour: app.hourNow(), altitudeM (home altitude, 0 = unknown),
 *    timeScale, ledger: app.ledger, who: profile id };
 *  - unlimited credits: tops credits up to 1e9 on every tick;
 *  - saves DEBOUNCED (at most every `saveEveryMs`, and when the tab hides);
 *  - re-renders the panel only when a number the player can see changed (level, hunger %, whole age
 *    days, life phase, asleep, credits) and only on screens that show them (home, dex, team);
 *  - the Dex learns the species met in battle (ledger row `battle.settled`).
 *
 * This is the ONLY file of the home-dex lane that imports src/genome/lifeclock.ts (the exact producer
 * signatures of src/genome/lifeTypes.ts). Home and the HomeView read life facts through the hooks it
 * registers in devPanel.ts (`lifeHooks()`), so they build and run (always awake) without it.
 */
import type { App } from "./app.ts";
import type { Genemon } from "../genome/genemon.ts";
import { liveTick, phenotypeOf } from "../genome/genemon.ts";
import type { LifePhase, LifeState, LifeTickReport } from "../genome/lifeTypes.ts";
import { canRank, lifeOf, lifePhase } from "../genome/lifeclock.ts";
import { advanceHourOffset, catchUpFrom, devOf, type LifeHooks, MAX_CATCHUP_DAYS, setLifeHooks, topUpCredits } from "./devPanel.ts";
import { dexMemoryOf, noteSeen, speciesOf } from "./screens/dex.ts";

export interface LifeLoopOptions {
  /** Real ms between ticks when the time scale is above 1 (default 5000). */
  periodMs?: number;
  /** Real ms between ticks at real time, 1x (default 60000: keeps the ledger lean). */
  realPeriodMs?: number;
  /** Minimum real ms between two saves caused by the loop (default 20000). */
  saveEveryMs?: number;
  /** Screens re-rendered when a visible number changed. */
  renderOn?: readonly string[];
}

export interface LifeLoop extends LifeHooks {
  stop(): void;
  /** Run one tick now (QA / the dev panel). Returns how many Genemon ticked. */
  tickNow(): number;
  /** Last tick report per Genemon id (circadian state, phase change, events). */
  readonly reports: ReadonlyMap<string, LifeTickReport>;
  asleep(g: Genemon): boolean;
  phaseOf(g: Genemon): LifePhase | null;
  canRank(g: Genemon): { ok: boolean; why: string } | null;
  /** The life state (g.life or a fresh one; never mutates). */
  lifeOf(g: Genemon): LifeState | null;
  /** The creatures' hour (runs ahead of the real one at a demo time scale). */
  hour(): number;
  /** Counters for the QA snapshot. */
  stats(): { ticks: number; lastTickAt: number; lastMs: number; errors: number; saves: number; renders: number; caughtUpDays: number };
}

let current: LifeLoop | null = null;

/** The running loop (null before startLifeLoop / after stop). */
export function lifeLoop(): LifeLoop | null {
  return current;
}

function safe<T>(f: () => T, fallback: T): T {
  try {
    return f();
  } catch {
    return fallback;
  }
}

export function startLifeLoop(app: App, o: LifeLoopOptions = {}): LifeLoop {
  current?.stop();
  const periodMs = o.periodMs ?? 5000;
  const realPeriodMs = o.realPeriodMs ?? 60000;
  const saveEveryMs = o.saveEveryMs ?? 20000;
  const renderOn = new Set(o.renderOn ?? ["home", "dex", "team"]);
  const reports = new Map<string, LifeTickReport>();
  const st = { ticks: 0, lastTickAt: 0, lastMs: 0, errors: 0, saves: 0, renders: 0, caughtUpDays: 0 };
  let dirty = false, lastSave = Date.now(), lastProfile = "", lastTickReal = Date.now();
  // Demo clock: at timeScale > 1 the creatures' hour runs ahead of the real one, so the circadian rhythm
  // (sleep / wake) cycles visibly; at 1x it is the app's hour.
  let hourOffset = 0;
  const lifeHour = () => (((app.hourNow() + hourOffset) % 24) + 24) % 24;
  let warned = false;

  const visible = (): string => {
    const p = app.profile;
    const parts: (string | number)[] = [Math.round(p.credits)];
    for (const g of p.collection) {
      const ph = phenotypeOf(g);
      parts.push(g.id, ph.level, Math.round(g.conditions.hunger * 100), Math.floor(g.conditions.ageDays), g.stage, safe(() => lifePhase(g), "adult"), reports.get(g.id)?.circadian.asleep ? 1 : 0);
    }
    return parts.join("|");
  };

  const tickAll = (now: number, timeScale: number): number => {
    const p = app.profile;
    const ctx = { hour: lifeHour(), altitudeM: 0, timeScale, ledger: app.ledger, who: p.id };
    let n = 0;
    for (const g of p.collection) {
      try {
        reports.set(g.id, liveTick(g, now, ctx));
        n++;
      } catch (e) {
        st.errors++;
        if (!warned) {
          warned = true;
          console.warn("lifeLoop: tickLife failed", g.id, e);
        }
      }
    }
    return n;
  };

  const save = (force = false) => {
    if (!dirty) return;
    const now = Date.now();
    if (!force && now - lastSave < saveEveryMs) return;
    app.save();
    dirty = false;
    lastSave = now;
    st.saves++;
  };

  /** Offline catch-up for the active profile: real time since each creature's last tick (capped). */
  const catchUp = () => {
    const p = app.profile, now = Date.now();
    let maxDays = 0;
    for (const g of p.collection) {
      if (!g.life) continue;
      const from = catchUpFrom(g.life.lastTick, now, MAX_CATCHUP_DAYS);
      maxDays = Math.max(maxDays, (now - from) / 86_400_000);
      g.life.lastTick = from;
    }
    tickAll(now, 1);
    st.caughtUpDays = maxDays;
    lastProfile = p.id;
    dirty = true;
  };

  const tick = (): number => {
    const t0 = performance.now();
    if (app.profile.id !== lastProfile) catchUp();
    const before = visible();
    const dev = devOf(app.profile.settings);
    const now = Date.now();
    hourOffset = advanceHourOffset(hourOffset, now - lastTickReal, dev.timeScale);
    lastTickReal = now;
    const n = tickAll(now, dev.timeScale);
    app.profile.credits = topUpCredits(app.profile.credits, dev);
    dirty = true;
    st.ticks++;
    st.lastTickAt = Date.now();
    st.lastMs = performance.now() - t0;
    if (visible() !== before && renderOn.has(app.screen)) {
      app.render();
      st.renders++;
    }
    save();
    return n;
  };

  // The Dex SEES every species met in a battle (both sides). Guarded: a throwing subscriber would abort
  // the emitter (Ledger.emit has no try/catch).
  const unsub = app.ledger.subscribe((e) => {
    try {
      if (e.what !== "battle.settled") return;
      const b = app.battleView?.battle;
      if (!b) return;
      const keys = b.setup.teams.flatMap((t) => t.members.map((g) => speciesOf(phenotypeOf(g)).key));
      if (noteSeen(dexMemoryOf(app.profile), keys, Date.now()) > 0) dirty = true;
    } catch (err) {
      console.warn("lifeLoop: dex seen", err);
    }
  });

  const onHide = () => {
    if (document.visibilityState === "hidden") save(true);
  };
  const onPageHide = () => save(true);
  document.addEventListener("visibilitychange", onHide);
  globalThis.addEventListener("pagehide", onPageHide);

  catchUp();
  save(true);
  const timer = setInterval(() => {
    try {
      // Real time moves slowly: tick once a minute; a demo time scale ticks every periodMs.
      if (devOf(app.profile.settings).timeScale <= 1 && Date.now() - lastTickReal < realPeriodMs - 50) return;
      tick();
    } catch (e) {
      st.errors++;
      console.warn("lifeLoop tick", e);
    }
  }, periodMs);

  const handle: LifeLoop = {
    stop() {
      clearInterval(timer);
      unsub();
      document.removeEventListener("visibilitychange", onHide);
      globalThis.removeEventListener("pagehide", onPageHide);
      save(true);
      if (current === handle) {
        current = null;
        setLifeHooks(null);
      }
    },
    tickNow: tick,
    reports,
    asleep: (g) => reports.get(g.id)?.circadian.asleep ?? false,
    phaseOf: (g) => safe<LifePhase | null>(() => lifePhase(g), null),
    canRank: (g) => safe<{ ok: boolean; why: string } | null>(() => canRank(g), null),
    lifeOf: (g) => safe<LifeState | null>(() => lifeOf(g, Date.now()), null),
    stats: () => ({ ...st }),
    hour: lifeHour,
  };
  current = handle;
  setLifeHooks(handle);
  return handle;
}
