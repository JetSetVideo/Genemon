/**
 * Gauntlet panel (P4-B1): pick ONE Genemon and see how far it goes. Shows the champion picker, the
 * run in progress (round, streak, carried HP, the next opponent previewed through opponentFor), the
 * best streak per Genemon and the last finished runs. It never starts a battle itself: the App
 * wires `deps` (start / next / abandon) to its battle flow, so this file only renders and calls.
 */
import { ELEMENTS } from "../data/elements.ts";
import { type GauntletRun, isBoss, opponentFor, rewardsFor, scoreOf } from "../combat/gauntlet.ts";
import { type Genemon, phenotypeOf } from "../genome/genemon.ts";
import type { App } from "./app.ts";
import { bar, fmt, h, hex, pct, section, select } from "./dom.ts";
import type { GauntletStore } from "./gauntletStore.ts";
import { elChip } from "./widgets.ts";

export interface GauntletDeps {
  store: GauntletStore;
  /** Start a new run with this champion (and usually its first fight). */
  start(championId: string): void;
  /** Fight the current run's next round. */
  next(): void;
  /** Give up the current run. */
  abandon(): void;
}

/** Champion picked in the select (UI state, survives re-renders). */
let pick: string | null = null;

const hpColor = (f: number) => (f > 0.6 ? "#3ddc84" : f > 0.3 ? "#ffd166" : "#ff4d6d");

function label(g: Genemon): string {
  const ph = phenotypeOf(g);
  const els = [ph.elements.primary, ph.elements.secondary].filter((e) => e !== null).map((e) => ELEMENTS[e!].name).join("/");
  return `${g.name} · Lv ${ph.level} · ${els} · ${ph.sizeClass}`;
}

function runCard(app: App, run: GauntletRun, deps: GauntletDeps): HTMLElement {
  const champ = app.profile.collection.find((g) => g.id === run.championId) ?? null;
  const card = h("div", { class: "gauntlet-run", "data-gauntlet": "run" });
  const boss = isBoss(run.round);
  const reward = rewardsFor(run);
  card.append(
    h("div", { class: "gauntlet-head" },
      h("b", {}, champ ? champ.name : run.championName),
      h("span", { class: "gauntlet-round" }, `Round ${run.round}`),
      h("span", { class: "gauntlet-streak", title: "Rounds won in this run" }, `🔥 ${run.streak}`)),
    h("div", { class: "gauntlet-hp" },
      h("span", { class: "muted" }, `HP carried ${pct(run.hpCarry)}`),
      bar(run.hpCarry, hpColor(run.hpCarry))),
    h("p", { class: "muted" }, `Earned so far: ${fmt(reward.credits)} credits · ${fmt(reward.xp)} xp · score ${fmt(scoreOf(run))}`),
  );
  if (!champ) {
    card.append(h("p", { class: "gauntlet-warn" }, "The champion is no longer in your collection: this run cannot continue."));
  } else {
    const level = phenotypeOf(champ).level;
    const opp = opponentFor(run, level);
    const oph = phenotypeOf(opp);
    card.append(
      h("div", { class: `gauntlet-next ${boss ? "boss" : ""}`, "data-gauntlet": "next-opponent", vars: { el: hex(ELEMENTS[oph.elements.primary].color) } },
        h("span", { class: "muted" }, "Next opponent"),
        h("div", { class: "row" },
          h("b", {}, opp.name),
          h("span", {}, `Lv ${oph.level}`),
          h("span", { class: "size", title: `${oph.kind} · ${oph.heightM.toFixed(2)} m` }, oph.sizeClass),
          elChip(oph.elements.primary),
          oph.elements.secondary ? elChip(oph.elements.secondary) : null,
          boss ? h("span", { class: "gauntlet-boss" }, "BOSS") : null),
        h("span", { class: "muted" }, `${oph.kind}${boss ? " · bosses heal you 50% when beaten" : " · win to heal 25%"}`)),
    );
  }
  card.append(h("div", { class: "row" },
    champ ? h("button", { class: "btn primary", "data-action": "gauntlet-next", onclick: () => deps.next() }, boss ? "⚔ Fight the boss" : "⚔ Next fight") : null,
    h("button", { class: "btn", "data-action": "gauntlet-abandon", onclick: () => deps.abandon() }, "Give up")));
  return card;
}

function picker(app: App, deps: GauntletDeps): HTMLElement {
  const pool = app.profile.collection;
  if (pool.length === 0) return h("p", { class: "muted" }, "Your collection is empty: catch or hatch a Genemon first.");
  if (!pick || !pool.some((g) => g.id === pick)) pick = app.selected && pool.some((g) => g.id === app.selected) ? app.selected : pool[0].id;
  const options = [...pool].sort((a, b) => a.name.localeCompare(b.name)).map((g) => ({ value: g.id, label: label(g) }));
  const best = deps.store.best(pick);
  return h("div", { class: "gauntlet-pick" },
    h("label", { class: "field" }, "Champion", select(options, pick, (v) => {
      pick = v;
      app.render();
    }, { "data-gauntlet": "champion" })),
    h("p", { class: "muted" }, best > 0 ? `Best streak of this Genemon: ${best}.` : "This Genemon has never run the gauntlet."),
    h("button", { class: "btn primary big", "data-action": "gauntlet-start", onclick: () => pick && deps.start(pick) }, "Start run"));
}

function bestTable(deps: GauntletDeps): HTMLElement | null {
  const rows = deps.store.bests().slice(0, 10);
  if (rows.length === 0) return null;
  return h("div", { class: "gauntlet-block" },
    h("h3", {}, "Best streak per Genemon"),
    h("table", { class: "t gauntlet-table" },
      h("tr", {}, h("th", {}, "Genemon"), h("th", {}, "Streak"), h("th", {}, "Score")),
      ...rows.map((b) => h("tr", {}, h("td", {}, b.name), h("td", {}, String(b.streak)), h("td", {}, fmt(b.score))))));
}

function lastRuns(deps: GauntletDeps): HTMLElement | null {
  const runs = deps.store.recent();
  if (runs.length === 0) return null;
  return h("div", { class: "gauntlet-block" },
    h("h3", {}, "Last runs"),
    h("table", { class: "t gauntlet-table", "data-gauntlet": "last-runs" },
      h("tr", {}, h("th", {}, "Champion"), h("th", {}, "Streak"), h("th", {}, "Score"), h("th", {}, "End"), h("th", {}, "Date")),
      ...runs.map((r) => {
        const last = r.history[r.history.length - 1];
        const end = r.gaveUp ? "gave up" : last && !last.won ? `lost to ${last.opponent}` : "-";
        return h("tr", {}, h("td", {}, r.championName), h("td", {}, String(r.streak)), h("td", {}, fmt(r.score)), h("td", {}, end), h("td", {}, new Date(r.endedAt).toLocaleDateString()));
      })));
}

export function renderGauntletPanel(app: App, deps: GauntletDeps): HTMLElement {
  const run = deps.store.current();
  const el = section("Gauntlet - how far can one Genemon go?",
    h("p", { class: "muted" }, "One Genemon against an endless line of random opponents. HP carries over between rounds (+25% heal after a win, +50% after a boss), a boss every 5 rounds, the first loss or draw ends the run."),
    run && run.alive ? runCard(app, run, deps) : picker(app, deps),
    bestTable(deps),
    lastRuns(deps));
  el.classList.add("gauntlet");
  el.setAttribute("data-section", "gauntlet");
  return el;
}
