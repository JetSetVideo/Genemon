import type { App } from "../app.ts";
import { ELEMENTS, type ElementId } from "../../data/elements.ts";
import { WEATHERS } from "../../data/weather.ts";
import { phenotypeOf } from "../../genome/genemon.ts";
import { teamSummary } from "../../combat/team.ts";
import { teamOf } from "../profile.ts";
import { fmt, h, hex, section } from "../dom.ts";
import { elChip, genemonCard } from "../widgets.ts";
import { renderQuestPanel } from "./quests.ts";

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
  return h("div", {},
    h("h1", {}, `Hello ${p.name}`),
    h("p", {}, "Your Genemon evolve with your real life: the time you play, the places you go, the food you buy, the battles you fight."),
    h("button", { class: "btn primary big", "data-action": "instant-battle", title: "A ranked battle right now: the ladder draws the arena; your real hour and weather apply", onclick: () => app.startRanked() }, "⚔ Instant battle"),
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
      h("div", { class: "cards" }, ...team.map((g) => genemonCard(g, { onClick: () => app.select(g.id), selected: app.selected === g.id }))),
      sum.synergies.length ? h("p", {}, h("b", {}, "Synergies: "), sum.synergies.map((s) => s.name).join(", ")) : h("p", { class: "muted" }, "No synergy yet - pair water with electric, fire with air..."),
      h("div", { class: "row" }, h("button", { class: "btn", onclick: () => app.go("team") }, "Edit team"), h("button", { class: "btn", onclick: () => app.go("dex") }, "All Genemon & teams"), h("button", { class: "btn", onclick: () => app.go("lab") }, "Open the Lab"))),
    section("Ladder",
      h("p", {}, `MMR ${Math.round(p.mmr)} · ${p.stats.wins}W ${p.stats.losses}L ${p.stats.draws}D · ${p.collection.length} Genemon · ${p.pokedex.length} species seen`),
      p.history[0] ? h("p", { class: "muted" }, `Last: ${p.history[0].won === 0 ? "won" : p.history[0].won === 1 ? "lost" : "draw"} vs ${p.history[0].opponent} in ${p.history[0].arena} (${p.history[0].mmrDelta >= 0 ? "+" : ""}${p.history[0].mmrDelta})`) : null),
    section("Collection by element",
      h("div", { class: "row" }, ...Object.entries(p.collection.reduce<Record<string, number>>((acc, g) => {
        const e = phenotypeOf(g).elements.primary;
        acc[e] = (acc[e] ?? 0) + 1;
        return acc;
      }, {})).map(([e, n]) => h("span", { class: "el", vars: { el: hex(ELEMENTS[e as ElementId].color) } }, `${ELEMENTS[e as ElementId].name} ×${n}`)))));
}
