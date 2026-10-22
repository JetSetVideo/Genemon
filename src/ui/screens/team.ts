import type { App } from "../app.ts";
import { autoTeam, slotsUsed, TEAM_CAPACITY, teamSummary } from "../../combat/team.ts";
import { phenotypeOf } from "../../genome/genemon.ts";
import { teamOf } from "../profile.ts";
import { fmt, h, hex, section, toast } from "../dom.ts";
import { genemonCard } from "../widgets.ts";

export function renderTeam(app: App): HTMLElement {
  const p = app.profile;
  const team = teamOf(p);
  const sum = teamSummary({ id: "t", owner: p.id, name: "", members: team });
  const slots = h("div", { class: "slots" });
  let used = 0;
  for (const g of team) {
    const ph = phenotypeOf(g);
    slots.append(h("div", { class: "slot filled", vars: { sw: hex(ph.palette.base), span: ph.slots }, title: `${g.name}: ${ph.sizeClass} costs ${ph.slots} slot(s)` }, `${team.indexOf(g) + 1}. ${g.name}`));
    used += ph.slots;
  }
  for (let i = used; i < TEAM_CAPACITY; i++) slots.append(h("div", { class: "slot" }, "free"));
  const move = (id: string, d: number) => {
    const i = p.team.indexOf(id), j = i + d;
    if (i < 0 || j < 0 || j >= p.team.length) return;
    [p.team[i], p.team[j]] = [p.team[j], p.team[i]];
    app.save();
    app.render();
  };
  const toggle = (id: string) => {
    if (p.team.includes(id)) p.team = p.team.filter((x) => x !== id);
    else {
      const g = p.collection.find((x) => x.id === id)!;
      if (slotsUsed(team) + phenotypeOf(g).slots > TEAM_CAPACITY) {
        toast(`Not enough slots: ${g.name} needs ${phenotypeOf(g).slots}.`);
        return;
      }
      p.team.push(id);
    }
    app.log("team.change", "user edited the team", id, p.team.join(","));
    app.save();
    app.render();
  };
  const auto = (pref: "big" | "swarm" | "balanced") => {
    p.team = autoTeam(p.collection, p.id, Date.now() % 100000, pref).members.map((g) => g.id);
    app.save();
    app.render();
  };
  const sel = app.selected && p.collection.find((g) => g.id === app.selected);
  return h("div", {},
    h("h1", {}, "Team"),
    h("p", {}, "6 slots. Big Genemon cost more (XS/S 1 · M 2 · L 3 · XL 4). The order is the attack/initiative order: #1 leads."),
    h("div", { class: "row" }, h("button", { class: "btn", onclick: () => app.go("dex") }, "Saved teams · Dex · 🥚 Hatch")),
    section(`Slots ${used}/${TEAM_CAPACITY} · power ${fmt(sum.power)}`, slots,
      h("div", { class: "row" }, h("span", { class: "muted" }, "Auto-build:"), h("button", { class: "btn small", onclick: () => auto("big") }, "Big"), h("button", { class: "btn small", onclick: () => auto("swarm") }, "Swarm"), h("button", { class: "btn small", onclick: () => auto("balanced") }, "Balanced"))),
    section("Attack order",
      ...team.map((g, i) => h("div", { class: "row" }, h("b", {}, `${i + 1}.`), h("span", { class: "spacer" }, g.name),
        h("button", { class: "btn small", title: "Move up", onclick: () => move(g.id, -1) }, "↑"),
        h("button", { class: "btn small", title: "Move down", onclick: () => move(g.id, 1) }, "↓"),
        h("button", { class: "btn small", title: "Remove from team", onclick: () => toggle(g.id) }, "✕")))),
    section("Synergies",
      ...(sum.synergies.length ? sum.synergies.map((s) => h("p", {}, h("b", {}, s.name), ` - ${s.why}`)) : [h("p", { class: "muted" }, "None. Try water + electric (Conductor), fire + air (Bellows), plant + water (Garden), a giant with small allies (Guardian)...")])),
    sel ? section(`Selected: ${sel.name}`, h("div", { class: "row" },
      h("button", { class: "btn primary", onclick: () => toggle(sel.id) }, p.team.includes(sel.id) ? "Remove from team" : "Add to team"),
      h("button", { class: "btn", onclick: () => app.go("lab") }, "Inspect in Lab"))) : null,
    section(`Collection (${p.collection.length})`,
      h("div", { class: "cards" }, ...p.collection.map((g) => genemonCard(g, { selected: app.selected === g.id, inTeam: p.team.includes(g.id), onClick: () => app.select(g.id) })))),
  );
}
