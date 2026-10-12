/**
 * Quests and achievements views (UI). They only READ the active profile's Progress
 * (src/ui/progressStore.ts); counting happens on ledger rows, never here.
 * - renderQuestPanel(app): a Home section. Active quests with their giver, kind, "in person",
 *   time-window and weather badges, each step with a progress bar, the reward and a Drop button;
 *   then "N/total achievements", the five most recent unlocks and an inline toggle for the full list.
 * - renderAchievements(app): every achievement grouped by category: locked / unlocked (secret ones
 *   stay hidden until unlocked), tier, progress bar, reward, and "later" for those no row the app
 *   writes today can move yet.
 */
import type { App } from "../app.ts";
import { type Achievement, ACHIEVEMENT_CATEGORIES, ACHIEVEMENTS } from "../../data/achievements.ts";
import { ELEMENTS } from "../../data/elements.ts";
import { inTimeWindow, type Quest, QUEST_GIVERS } from "../../data/quests.ts";
import { WEATHERS } from "../../data/weather.ts";
import { canProgress } from "../../progress/events.ts";
import type { ActiveQuestView, Progress } from "../../progress/progress.ts";
import { bar, fmt, h, hex, section } from "../dom.ts";
import { abandonQuest, getProgress, syncQuests } from "../progressStore.ts";

const TIER_COLOR: Record<number, string> = { 1: "#cd7f32", 2: "#8d99ae", 3: "#e9b949", 4: "#9b5de5" };
const DONE_COLOR = "#3ddc84";
const PHYSICAL_COLOR = "#2a9d8f";
const GIVERS = new Map(QUEST_GIVERS.map((g) => [g.name, g]));

/** Whether the Home panel shows the full achievement list inline. */
let showAll = false;

export function renderQuestPanel(app: App): HTMLElement {
  const p = syncQuests(app);
  const now = Date.now();
  const active = p.activeQuests();
  const recent = p.recentUnlocks(5);
  return section(`Quests · ${active.length} active`,
    ...(active.length > 0
      ? active.map((v) => questBlock(app, v, app.rw.hour, p.isPresent(now)))
      : [h("p", { class: "muted" }, "No quest right now: characters offer new ones as your team grows, at other hours and under other skies.")]),
    h("div", { class: "row" },
      h("b", {}, `🏆 ${p.unlockedCount}/${ACHIEVEMENTS.length} achievements`),
      h("span", { class: "muted" }, `${fmt(p.earned().credits)} cr · ${fmt(p.earned().xp)} xp earned from goals`)),
    recent.length > 0
      ? h("table", { class: "t" }, ...recent.map(({ achievement: a, at }) =>
        h("tr", {}, h("td", {}, a.name), h("td", {}, tierChip(a)), h("td", { class: "muted" }, rewardOf(a)), h("td", { class: "muted" }, new Date(at).toLocaleDateString()))))
      : h("p", { class: "muted" }, "No achievement yet: win a battle, feed your Genemon, train it, breed a child..."),
    h("div", { class: "row" },
      h("button", { class: `btn small ${showAll ? "on" : ""}`, "data-action": "toggle-achievements", onclick: () => {
        showAll = !showAll;
        app.render();
      } }, showAll ? "Hide the achievement list" : "All achievements")),
    showAll ? renderAchievements(app) : null);
}

export function renderAchievements(app: App): HTMLElement {
  const p = getProgress(app);
  const items = Object.entries(p.items());
  const titles = p.titles();
  return h("div", {},
    h("h1", {}, "Achievements"),
    h("p", {}, `${p.unlockedCount}/${ACHIEVEMENTS.length} unlocked · ${fmt(p.earned().credits)} credits and ${fmt(p.earned().xp)} xp earned from achievements and quests. Progress counts the ledger rows of your battles, Lab sessions and outings.`),
    items.length > 0 || titles.length > 0
      ? h("dl", { class: "kv" },
        h("dt", {}, "Reward items"), h("dd", {}, items.map(([id, n]) => `${id} ×${n}`).join(", ") || "-"),
        h("dt", {}, "Titles"), h("dd", {}, titles.join(", ") || "-"))
      : null,
    ...ACHIEVEMENT_CATEGORIES.map((cat) => {
      const list = ACHIEVEMENTS.filter((a) => a.category === cat);
      const got = list.filter((a) => p.isUnlocked(a.id)).length;
      return section(`${cat[0].toUpperCase()}${cat.slice(1)} · ${got}/${list.length}`,
        h("table", { class: "t" },
          h("tr", {}, h("th", {}, "achievement"), h("th", {}, "tier"), h("th", {}, "progress"), h("th", {}, "reward")),
          ...list.map((a) => achievementRow(p, a))));
    }));
}

// ---------------------------------------------------------------- pieces

function questBlock(app: App, v: ActiveQuestView, hour: number, present: boolean): HTMLElement {
  const q = v.quest;
  const giver = GIVERS.get(q.giver);
  const color = giver ? hex(ELEMENTS[giver.element].color) : "#888888";
  const closed = q.timeWindow !== undefined && !inTimeWindow(q.timeWindow, hour);
  return h("div", { class: "section", "data-quest": q.id },
    h("div", { class: "row" },
      h("b", {}, q.name),
      h("span", { class: "el", vars: { el: color }, title: giver ? `${giver.name}, ${giver.role}` : q.giver }, q.giver),
      h("span", { class: "size" }, q.kind),
      q.physicalOnly ? h("span", { class: "el", vars: { el: PHYSICAL_COLOR }, title: "Only what you do in person counts (physical presence)" }, "📍 in person") : null,
      q.timeWindow ? h("span", { class: "size", title: "Local hours" }, `${q.timeWindow.startHour}h-${q.timeWindow.endHour}h`) : null,
      q.weather ? h("span", { class: "size", title: "Weather of the day" }, q.weather.map((w) => WEATHERS[w].name).join(" / ")) : null),
    ...v.steps.map(({ step, count, target }) =>
      h("div", {},
        h("div", { class: "muted" }, step.text),
        h("div", { class: "row" },
          h("div", { class: "spacer" }, bar(target > 0 ? count / target : 0, count >= target ? DONE_COLOR : color)),
          h("span", { class: "mono" }, `${num(count)}/${target}`)))),
    closed && q.timeWindow ? h("p", { class: "muted" }, `Counts between ${q.timeWindow.startHour}h and ${q.timeWindow.endHour}h (local time).`) : null,
    q.physicalOnly && !present ? h("p", { class: "muted" }, "Go there for real: these steps only move with physical presence.") : null,
    h("div", { class: "row" },
      h("span", { class: "muted", title: q.note }, questReward(q)),
      h("span", { class: "spacer" }),
      h("button", { class: "btn small", "data-action": "drop-quest", title: "Drop this quest (offered again tomorrow at the earliest)", onclick: () => abandonQuest(app, q.id) }, "Drop")));
}

function achievementRow(p: Progress, a: Achievement): HTMLElement {
  const done = p.isUnlocked(a.id);
  const hidden = a.category === "secret" && !done;
  const value = p.achievementProgress(a.id);
  const at = p.unlockedAt(a.id);
  const trackable = canProgress(a.trigger, p.seen()) || value > 0;
  // The bar sits in the wide first cell: a .bar alone in a table cell has no width of its own.
  const status = done
    ? h("span", { class: "muted" }, `✓ ${at ? new Date(at).toLocaleDateString() : "unlocked"}`)
    : trackable
    ? h("span", { class: "mono" }, `${num(value)}/${a.trigger.count}`)
    : h("span", { class: "muted", title: "No row the app writes today can move it yet (world, social, market, ladder... arrive later)." }, "later");
  return h("tr", {},
    h("td", {},
      h("div", {}, h("b", {}, `${done ? "✓ " : ""}${hidden ? "???" : a.name}`)),
      h("div", { class: "muted" }, hidden ? "Secret: unlock it to reveal it." : a.description),
      !done && trackable ? bar(Math.min(1, value / a.trigger.count), TIER_COLOR[a.tier]) : null),
    h("td", {}, tierChip(a)),
    h("td", {}, status),
    h("td", { class: "muted" }, rewardOf(a)));
}

function tierChip(a: Achievement): HTMLElement {
  return h("span", { class: "el", vars: { el: TIER_COLOR[a.tier] }, title: `Tier ${a.tier} of 4` }, `T${a.tier}`);
}

function rewardOf(a: Achievement): string {
  return `${fmt(a.reward.credits)} cr${a.reward.itemId ? ` · ${a.reward.itemId}` : ""}${a.reward.title ? ` · "${a.reward.title}"` : ""}`;
}

function questReward(q: Quest): string {
  return `Reward: ${fmt(q.reward.credits)} cr · ${fmt(q.reward.xp)} xp${q.reward.itemId ? ` · ${q.reward.itemId}` : ""}`;
}

const num = (v: number): string => fmt(v, Number.isInteger(v) ? 0 : 1);
