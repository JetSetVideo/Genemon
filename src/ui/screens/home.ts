/**
 * Home = the MAIN MENU [P5-H1]. The 3D stage shows the team on the graduated platform (HomeView,
 * mounted by `mountHome`); the panel holds the quick actions, the team strip (click = select), a size
 * legend that matches the platform's graduations, the compact test-demo block [P5-D1], then the
 * pre-pass-5 home content (quests, real world, team cards, ladder, collection by element).
 */
import type { App } from "../app.ts";
import { ELEMENTS, type ElementId } from "../../data/elements.ts";
import { WEATHERS } from "../../data/weather.ts";
import { type Genemon, phenotypeOf } from "../../genome/genemon.ts";
import { teamSummary } from "../../combat/team.ts";
import { teamOf } from "../profile.ts";
import { fmt, h, hex, section } from "../dom.ts";
import { elChip, genemonCard } from "../widgets.ts";
import { renderQuestPanel } from "./quests.ts";
import { fmtM, HomeView, POLE_STEP, poleTicks } from "../../render/homeView.ts";
import { lifeHooks, renderDevPanel } from "../devPanel.ts";
import { openDex } from "./dex.ts";
import { leagueStanding, renderRankedPanel } from "../rankedPanel.ts";
import { LEAGUE_IDS, LEAGUES, leagueOfRecord, rankTier } from "../../ladder/leagues.ts";

/**
 * Select a Genemon from Home without leaving the platform. `app.select` swaps the 3D view to the Lab
 * when no Lab view is mounted (the case on Home), so Home sets the selection itself, logs it and
 * re-renders; elsewhere it defers to `app.select`.
 */
export function pickOnHome(app: App, id: string): void {
  if (app.labView || !(app.stage.view instanceof HomeView)) {
    app.select(id);
    return;
  }
  app.selected = id;
  app.log("ui.select", "picked on the home platform", id);
  app.render();
}

/** Mount the platform (once: going Home again keeps the running view, which follows the team itself). */
export function mountHome(app: App): void {
  if (app.stage.view instanceof HomeView) return;
  const s = app.profile.settings;
  app.mountView(new HomeView(app.stage, {
    team: () => teamOf(app.profile),
    selected: () => app.selected,
    asleep: (g) => lifeHooks()?.asleep(g) ?? false,
    onPick: (id) => pickOnHome(app, id),
  }, { dark: s.theme === "dark", shadows: s.shadows, quality: s.quality }));
  // The panel was rendered before the platform existed: refresh it with the measured heights.
  if (app.screen === "home") app.render();
}

const ACTIONS: readonly { icon: string; label: string; hint: string; go: string }[] = [
  { icon: "⚔", label: "Arena", hint: "Ranked and practice battles", go: "arena" },
  { icon: "❖", label: "Team", hint: "6 slots, synergies, order", go: "team" },
  { icon: "⚗", label: "Lab", hint: "Feed, grow, breed, morph", go: "lab" },
  { icon: "◫", label: "Collection", hint: "All Genemon, teams, hatch", go: "dex" },
  { icon: "📖", label: "Dex", hint: "Species: seen, owned, developed", go: "dex:dex" },
  { icon: "◎", label: "World", hint: "Map around your home", go: "world" },
  { icon: "⚖", label: "Market", hint: "Auction house", go: "market" },
  { icon: "★", label: "Feats", hint: "Achievements", go: "achievements" },
];

/** Measured standing heights from the mounted platform (id -> m), empty before the first mount. */
function standHeights(app: App): Map<string, number> {
  const v = app.stage.view instanceof HomeView ? app.stage.view.snapshot() : null;
  const list = (v?.actors ?? []) as { id: string; standM: number }[];
  return new Map(list.map((a) => [a.id, a.standM]));
}

function mateRow(app: App, g: Genemon, tallest: number, stand: number | undefined): HTMLElement {
  const ph = phenotypeOf(g);
  const hooks = lifeHooks();
  const asleep = hooks?.asleep(g) ?? false;
  const phase = hooks?.phaseOf(g) ?? null;
  const sel = app.selected === g.id;
  const tall = stand ?? ph.heightM;
  const hm = fmtM(Number(tall.toFixed(2)));
  return h("button", { class: `hd5-mate ${sel ? "sel" : ""}`, "data-genemon": g.id, title: `${g.name}: ${ph.kind}, stands ${hm} tall (size ${fmtM(Number(ph.heightM.toFixed(2)))}), ${fmt(ph.massKg, 1)} kg (click to select)`, vars: { sw: hex(ph.palette.base), h: `${Math.max(4, (tall / tallest) * 100).toFixed(1)}%` }, onclick: () => pickOnHome(app, g.id) },
    h("span", { class: "swatch" }),
    h("span", { class: "hd5-mate-name" }, `${asleep ? "💤 " : ""}${g.name}`),
    h("span", { class: "hd5-hbar" }, h("i", {})),
    h("span", { class: "mono hd5-mate-size" }, `${hm} · ${fmt(ph.massKg, ph.massKg < 10 ? 1 : 0)} kg · ${ph.sizeClass}`),
    h("span", { class: "muted hd5-mate-meta" }, `Lv ${ph.level} · ${phase ?? ph.kind} · hunger ${Math.round(g.conditions.hunger * 100)} %`));
}

export function renderHome(app: App): HTMLElement {
  const p = app.profile;
  const rw = app.rw;
  const w = WEATHERS[rw.weather];
  const team = teamOf(p);
  const sum = teamSummary({ id: "t", owner: p.id, name: "", members: team });
  const boosted = (Object.entries(w.elementMult) as [ElementId, number][]).filter(([, v]) => v > 1).map(([e]) => elChip(e));
  const weakened = (Object.entries(w.elementMult) as [ElementId, number][]).filter(([, v]) => v < 1).map(([e]) => elChip(e));
  const day = rw.hour >= 7 && rw.hour < 19;
  const rhythmTip = day ? "Diurnal Genemon hit harder now; nocturnal ones are drowsy." : "Night: nocturnal Genemon are sharper, light moves are weaker.";
  const onStage = team.slice(0, 6);
  const stands = standHeights(app);
  const tallOf = (g: Genemon) => stands.get(g.id) ?? phenotypeOf(g).heightM;
  const tallest = Math.max(0.25, ...onStage.map(tallOf));
  const view = app.stage.view instanceof HomeView ? app.stage.view.snapshot() : null;
  const top = poleTicks(tallest).at(-1)?.y ?? 1;
  const sleeping = onStage.filter((g) => lifeHooks()?.asleep(g)).length;
  return h("div", { class: "hd5-menu" },
    h("h1", {}, `Hello ${p.name}`),
    h("p", { class: "muted" }, `${fmt(p.credits)} credits · ${p.collection.length} Genemon. Your Genemon evolve with your real life: the time you play, the places you go, the food you buy, the battles you fight.`),
    renderRankedPanel(app, { compact: true }),
    h("div", { class: "hd5-actions" }, ...ACTIONS.map((a) =>
      h("button", { class: "hd5-act", "data-go": a.go, title: a.hint, onclick: () => (a.go === "dex:dex" ? openDex(app) : app.go(a.go)) },
        h("span", { class: "ico" }, a.icon), h("span", {}, a.label)))),
    section(`On the platform · ${onStage.length} Genemon${sleeping ? ` · ${sleeping} asleep` : ""}`,
      onStage.length
        ? h("div", { class: "hd5-strip" }, ...onStage.map((g) => mateRow(app, g, tallest, stands.get(g.id))))
        : h("p", { class: "muted" }, "Your team is empty: add Genemon in the Team screen."),
      h("div", { class: "hd5-legend" },
        h("b", {}, "Size legend"),
        h("span", {}, `Floor rings every ${view ? fmtM(view.ringStep as number) : "0.25-1 m"} from the centre (labelled); ruler ticks every ${view && (view.radius as number) > 6 ? "0.25" : "0.1"} m.`),
        h("span", {}, `Measuring pole: red/white bands of ${POLE_STEP} m, up to ${fmtM(top)}.`),
        h("span", {}, "The selected Genemon gets a gold ring and a dashed line to the pole at its height."),
        h("span", { class: "muted" }, "Bars: height vs the tallest here. Drag to orbit, pinch / wheel to zoom, tap a Genemon to select it."))),
    renderDevPanel(app, true),
    renderQuestPanel(app),
    section("Right now (real world)",
      h("dl", { class: "kv" },
        h("dt", {}, "Local time"), h("dd", {}, `${rw.now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · ${rw.dayPhase}`),
        h("dt", {}, "Season"), h("dd", {}, rw.season),
        h("dt", {}, "Moon"), h("dd", {}, rw.moonName),
        h("dt", {}, "Weather of the day"), h("dd", {}, w.name),
        h("dt", {}, "Device"), h("dd", {}, `${rw.device.formFactor} · ${rw.device.cores} cores · ${rw.device.screen}@${rw.device.dpr}x`)),
      h("p", {}, rhythmTip),
      boosted.length ? h("div", { class: "row" }, h("span", { class: "muted" }, "Boosted:"), ...boosted) : null,
      weakened.length ? h("div", { class: "row" }, h("span", { class: "muted" }, "Weakened:"), ...weakened) : null),
    section(`Your team · ${sum.slots}/6 slots · power ${fmt(sum.power)}`,
      h("div", { class: "cards" }, ...team.map((g) => genemonCard(g, { onClick: () => pickOnHome(app, g.id), selected: app.selected === g.id }))),
      sum.synergies.length ? h("p", {}, h("b", {}, "Synergies: "), sum.synergies.map((s) => s.name).join(", ")) : h("p", { class: "muted" }, "No synergy yet - pair water with electric, fire with air..."),
      h("div", { class: "row" }, h("button", { class: "btn", onclick: () => app.go("team") }, "Edit team"), h("button", { class: "btn", onclick: () => app.go("dex") }, "All Genemon & teams"), h("button", { class: "btn", onclick: () => app.go("lab") }, "Open the Lab"))),
    section("Ladder",
      h("dl", { class: "kv" }, ...LEAGUE_IDS.flatMap((l) => {
        const st = leagueStanding(app, l);
        const last = p.history.find((r) => leagueOfRecord(r) === l);
        return [
          h("dt", {}, LEAGUES[l].name),
          h("dd", { "data-home-league": l },
            `${rankTier(st.rating, st.games).name} · ${Math.round(st.rating)} · ${st.wins}W ${st.losses}L ${st.draws}D`,
            last ? h("span", { class: "muted" }, ` · last: ${last.won === 0 ? "won" : last.won === 1 ? "lost" : "draw"} vs ${last.opponent} (${last.mmrDelta >= 0 ? "+" : ""}${last.mmrDelta})`) : null),
        ];
      })),
      h("p", { class: "muted" }, `All battles: ${p.stats.wins}W ${p.stats.losses}L ${p.stats.draws}D · ${p.pokedex.length} species seen`),
      h("button", { class: "btn small", onclick: () => app.go("ladder") }, "Both ladders")),
    section("Collection by element",
      h("div", { class: "row" }, ...Object.entries(p.collection.reduce<Record<string, number>>((acc, g) => {
        const e = phenotypeOf(g).elements.primary;
        acc[e] = (acc[e] ?? 0) + 1;
        return acc;
      }, {})).map(([e, n]) => h("span", { class: "el", vars: { el: hex(ELEMENTS[e as ElementId].color) } }, `${ELEMENTS[e as ElementId].name} ×${n}`)))));
}
