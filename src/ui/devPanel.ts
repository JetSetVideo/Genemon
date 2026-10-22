/**
 * Test-demo controls [P5-D1]: the founder's "age faster, overfeed past the limit, almost unlimited
 * money" switches. Stored in `profile.settings.dev` (DevSettings, src/genome/lifeTypes.ts) through
 * `app.updateSettings`, every action logged with `app.log("ui.dev", ...)`.
 *
 *  - time scale 1x / 60x / 1440x / 10080x: the life loop (src/ui/lifeLoop.ts) passes it to tickLife;
 *  - age +1 day / +30 days on the selected Genemon (genemon.ts `age`, which re-settles level/stage);
 *  - unlimited credits: credits are topped up to 1e9 (now, and on every life-loop tick);
 *  - no food limit: feeding code passes `{ ignoreCapacity: settings.dev.noFoodLimit }` to `eat()`;
 *  - hatch 10: ten free newborns (src/ui/hatch.ts `hatchMany`).
 *
 * The top half of this file is PURE (time-scale maths, tested in tests/home_dex_test.ts).
 */
import type { App } from "./app.ts";
import { DEV_DEFAULTS, type DevSettings, type LifePhase } from "../genome/lifeTypes.ts";
import { age, type Genemon, phenotypeOf } from "../genome/genemon.ts";
import { hashSeed } from "../core/rng.ts";
import { fmt, h, section, toast } from "./dom.ts";
import { hatchMany } from "./hatch.ts";

// ---------------------------------------------------------------- pure
export const TIME_SCALES = [1, 60, 1440, 10080] as const;
export const UNLIMITED_CREDITS = 1e9;
/** Offline catch-up never replays more than this (a closed tab must not kill a whole team). */
export const MAX_CATCHUP_DAYS = 30;
export const DAY_MS = 86_400_000;

/** The dev settings with defaults filled in (a profile saved before pass 5 has none). */
export function devOf(s: { dev?: Partial<DevSettings> }): DevSettings {
  const d = { ...DEV_DEFAULTS, ...(s.dev ?? {}) };
  return { timeScale: clampScale(d.timeScale), unlimitedCredits: !!d.unlimitedCredits, noFoodLimit: !!d.noFoodLimit };
}

/** A usable time scale: finite, 1 .. 100800 (ten weeks per real minute); anything else = real time. */
export function clampScale(x: number): number {
  return Number.isFinite(x) && x >= 1 ? Math.min(100800, x) : 1;
}

/** Life-clock milliseconds that pass during `realMs` of real time at `scale`. */
export function scaledMs(realMs: number, scale: number): number {
  return Math.max(0, realMs) * clampScale(scale);
}

/** Life-clock days that pass during `realMs` at `scale`. */
export function gameDays(realMs: number, scale: number): number {
  return scaledMs(realMs, scale) / DAY_MS;
}

/** "1 real minute = ..." in words: 1x -> "1 min", 60x -> "1 h", 1440x -> "1 day", 10080x -> "1 week". */
export function perRealMinute(scale: number): string {
  const min = clampScale(scale);
  if (min < 60) return `${fmtN(min)} min`;
  if (min < 1440) return `${fmtN(min / 60)} h`;
  if (min < 10080) return `${fmtN(min / 1440)} day${min / 1440 === 1 ? "" : "s"}`;
  return `${fmtN(min / 10080)} week${min / 10080 === 1 ? "" : "s"}`;
}

/** 13.5 -> "13:30". */
export function fmtHour(hr: number): string {
  const m = Math.floor((((hr % 24) + 24) % 24) * 60);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

function fmtN(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

export function scaleLabel(scale: number): string {
  const s = clampScale(scale);
  return s === 1 ? "1x · real time" : `${s}x · 1 min = ${perRealMinute(s)}`;
}

/**
 * The demo clock's lead over the real hour after `realMs` at `scale`: at 1x it is 0 (real hour); above,
 * the creatures' day runs `scale` times faster, so their circadian sleep / wake cycles visibly.
 */
export function advanceHourOffset(offset: number, realMs: number, scale: number): number {
  const s = clampScale(scale);
  if (s <= 1) return 0;
  return (((offset + (Math.max(0, realMs) * (s - 1)) / 3_600_000) % 24) + 24) % 24;
}

/** Credits after the unlimited-credits rule (never lowers a balance). */
export function topUpCredits(credits: number, dev: DevSettings): number {
  return dev.unlimitedCredits ? Math.max(credits, UNLIMITED_CREDITS) : credits;
}

/** Where an offline catch-up starts: at most `maxDays` before now, never after now. */
export function catchUpFrom(lastTick: number, now: number, maxDays = MAX_CATCHUP_DAYS): number {
  if (!Number.isFinite(lastTick)) return now;
  return Math.min(now, Math.max(lastTick, now - maxDays * DAY_MS));
}

// ---------------------------------------------------------------- life hooks
/**
 * What the screens may ask the running life loop (src/ui/lifeLoop.ts registers itself here), so Home
 * and the HomeView never import the life producers: only lifeLoop.ts does.
 */
export interface LifeHooks {
  asleep(g: Genemon): boolean;
  phaseOf(g: Genemon): LifePhase | null;
  canRank(g: Genemon): { ok: boolean; why: string } | null;
  /** The creatures' hour of day (the demo clock). */
  hour(): number;
  /** Tick every Genemon now (before the time scale changes, so the past interval keeps its scale). */
  tickNow(): number;
}
let hooks: LifeHooks | null = null;
export function setLifeHooks(h: LifeHooks | null): void {
  hooks = h;
}
export function lifeHooks(): LifeHooks | null {
  return hooks;
}

// ---------------------------------------------------------------- UI
/** Merge a patch into settings.dev (through app.updateSettings, which saves and logs "ui.settings"). */
export function setDev(app: App, patch: Partial<DevSettings>): void {
  if (patch.timeScale !== undefined) lifeHooks()?.tickNow();
  const next = { ...devOf(app.profile.settings), ...patch };
  app.updateSettings({ dev: next });
  if (next.unlimitedCredits) app.profile.credits = topUpCredits(app.profile.credits, next);
  app.log("ui.dev", "test-demo control", Object.keys(patch).join(","), JSON.stringify(patch));
  app.save();
  if (app.screen !== "settings") app.render();
}

export function ageSelected(app: App, days: number): void {
  const g = app.selectedGenemon();
  if (!g) return toast("Select a Genemon first.");
  const before = phenotypeOf(g);
  age(g, days, { ledger: app.ledger, who: app.profile.id, why: `test demo: age +${days} d`, hour: app.hourNow() });
  const after = phenotypeOf(g);
  app.log("ui.dev", `age +${days} d`, g.id, `${g.name}: ${fmt(before.heightM, 2)} -> ${fmt(after.heightM, 2)} m, age ${fmt(g.conditions.ageDays, 1)} d`);
  app.save();
  toast(`${g.name} aged ${days} day${days > 1 ? "s" : ""}: ${fmt(g.conditions.ageDays, 1)} d old, ${fmt(after.heightM, 2)} m.`);
  app.render();
}

export function hatchTen(app: App): void {
  const p = app.profile, now = Date.now();
  const born = hatchMany({ seed: hashSeed(p.seed, "dev-hatch", now % 1e9, p.collection.length), owner: p.id, n: 10, element: "any", bornAt: now, taken: p.collection.map((g) => g.id) });
  for (const g of born) {
    p.collection.push(g);
    if (!p.pokedex.includes(g.genome.id)) p.pokedex.push(g.genome.id);
  }
  app.log("ui.dev", "test demo: hatch 10 (free)", "collection", born.map((g) => g.name).join(","));
  app.save();
  toast(`🥚 ×${born.length} hatched (free, test demo). Collection: ${p.collection.length}.`);
  app.render();
}

/** The dev block: full in Settings, compact (one row of buttons) on Home. */
export function renderDevPanel(app: App, compact = false): HTMLElement {
  const d = devOf(app.profile.settings);
  const g = app.selectedGenemon();
  const scales = h("div", { class: "row hd5-dev-scales", role: "group", "aria-label": "Life time scale" },
    ...TIME_SCALES.map((s) =>
      h("button", { class: `btn small ${d.timeScale === s ? "on" : ""}`, "data-dev-scale": s, title: scaleLabel(s), onclick: () => setDev(app, { timeScale: s }) }, `${s}x`)
    ));
  const toggle = (key: "unlimitedCredits" | "noFoodLimit", label: string, title: string) =>
    h("label", { class: "row muted hd5-dev-toggle", title },
      h("input", { type: "checkbox", checked: d[key], "data-dev": key, onchange: (e: Event) => setDev(app, { [key]: (e.target as HTMLInputElement).checked }) }), label);
  const actions = h("div", { class: "row" },
    h("button", { class: "btn small", "data-dev-age": 1, disabled: !g, onclick: () => ageSelected(app, 1) }, "Age +1 day"),
    h("button", { class: "btn small", "data-dev-age": 30, disabled: !g, onclick: () => ageSelected(app, 30) }, "Age +30 days"),
    h("button", { class: "btn small", "data-dev-hatch": 10, onclick: () => hatchTen(app) }, "🥚 Hatch 10"));
  const status = h("p", { class: "muted hd5-dev-status" },
    `Life clock ${scaleLabel(d.timeScale)}${lifeHooks() ? ` · creatures' hour ${fmtHour(lifeHooks()!.hour())}` : " · life loop not running"} · credits ${d.unlimitedCredits ? "unlimited" : fmt(app.profile.credits)} · food limit ${d.noFoodLimit ? "OFF" : "on"}${g ? ` · selected: ${g.name} (${fmt(g.conditions.ageDays, 1)} d)` : ""}`);
  if (compact) {
    return h("details", { class: "hd5-dev compact" },
      h("summary", {}, `🧪 Test demo · ${d.timeScale}x${d.unlimitedCredits ? " · ∞ credits" : ""}${d.noFoodLimit ? " · no food limit" : ""}`),
      scales, h("div", { class: "row" }, toggle("unlimitedCredits", "∞ credits", "Tops credits up to 1e9"), toggle("noFoodLimit", "No food limit", "Feeding ignores the stomach capacity (overfeeding bloats)")), actions);
  }
  return section("Test demo (age faster, overfeed, money)",
    h("p", { class: "muted" }, "For demos and tests: speed up the life clock (digestion, hunger, growth, ageing), feed past the stomach limit, never run out of credits. Saved in this profile; every change is logged."),
    h("div", { class: "field" }, "Life time scale", scales),
    toggle("unlimitedCredits", "Unlimited credits (topped up to 1,000,000,000)", "Tops credits up to 1e9 now and on every life tick"),
    toggle("noFoodLimit", "No food limit (overfeeding allowed: the Genemon bloats)", "Feeding ignores the stomach capacity"),
    actions,
    status);
}
