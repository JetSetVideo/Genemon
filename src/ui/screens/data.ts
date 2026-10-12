import type { App } from "../app.ts";
import { AXIS_IDS, type AxisId, SPACES } from "../../data/axes.ts";
import { ELEMENT_IDS, ELEMENTS } from "../../data/elements.ts";
import { phenotypeOf } from "../../genome/genemon.ts";
import { barChart, histogram } from "../charts.ts";
import { clear, download, fmt, h, hex, section, select } from "../dom.ts";

let axes: [AxisId, AxisId, AxisId] = ["heat", "moisture", "luminance"];

export function renderData(app: App): HTMLElement {
  const L = app.ledger;
  const counts = L.counts();
  const feedEl = h("div", { class: "feed" });
  const fillFeed = () => {
    clear(feedEl);
    for (const r of L.rows().slice(-60).reverse()) {
      feedEl.append(h("div", { class: "ev", title: `${r.why} | entries ${JSON.stringify(r.entries)} | exits ${JSON.stringify(r.exits)}` },
        h("span", { class: "muted" }, new Date(r.when).toLocaleTimeString()),
        h("span", { class: "what" }, r.what),
        h("span", {}, `${r.who.slice(0, 14)} → ${r.to.slice(0, 14)} · ${r.why.slice(0, 60)}`)));
    }
  };
  fillFeed();
  const dmg = L.query({ what: "battle.hit" }).map((r) => Number(r.exits.damage)).filter(Number.isFinite);
  const hist = h("canvas", { class: "chart" });
  const byEl = h("canvas", { class: "chart" });
  const arenaC = h("canvas", { class: "chart" });
  queueMicrotask(() => requestAnimationFrame(() => {
    histogram(hist, dmg, 12, "#ff6b35");
    const n = ELEMENT_IDS.map((e) => app.profile.collection.filter((g) => phenotypeOf(g).elements.primary === e).length);
    barChart(byEl, ELEMENT_IDS.map((e) => ELEMENTS[e].name), n, ELEMENT_IDS.map((e) => hex(ELEMENTS[e].color)));
    const arenas = [...new Set(app.profile.history.map((x) => x.arena))];
    const wr = arenas.map((a) => {
      const hs = app.profile.history.filter((x) => x.arena === a && x.won !== 2);
      return hs.length ? hs.filter((x) => x.won === 0).length / hs.length : 0;
    });
    barChart(arenaC, arenas.length ? arenas : ["no battles"], arenas.length ? wr : [0], "#4cc9f0");
  }));
  const s = app.session;
  const dev = app.rw.device;
  const pick = (i: 0 | 1 | 2) => select(AXIS_IDS, axes[i], (v) => {
    axes = [...axes] as [AxisId, AxisId, AxisId];
    axes[i] = v;
    app.showGenospace(axes);
  });
  return h("div", {},
    h("h1", {}, "Data"),
    h("p", {}, "Every mechanic writes a 5W ledger row: where / when / who / what / why / from / to / entries / exits. This feeds the ladder, the models and AI coding sessions."),
    section("Genospace (3D view)",
      h("p", { class: "muted" }, "Your Genemon (ringed) and 180 wild ones plotted on three opposite-pole axes. Drag to orbit, hover a dot for its name."),
      h("div", { class: "grid3" }, pick(0), pick(1), pick(2)),
      h("div", { class: "row" }, ...Object.entries(SPACES).map(([name, ids]) => h("button", { class: "btn small", onclick: () => {
        axes = [ids[0], ids[1], ids[2]] as [AxisId, AxisId, AxisId];
        app.showGenospace(axes);
        app.render();
      } }, name)))),
    section(`Ledger · ${L.size} rows`,
      h("div", { class: "row" },
        h("button", { class: "btn small", onclick: fillFeed }, "↻ refresh"),
        h("button", { class: "btn small", onclick: () => download(`genemon-ledger-${Date.now()}.jsonl`, L.toJSONL(), "application/x-ndjson") }, "⤓ export JSONL"),
        h("button", { class: "btn small", onclick: () => download(`genemon-profile-${app.profile.id}.json`, app.store.exportJSON(app.profile.id)) }, "⤓ export profile")),
      feedEl),
    section("Events by type", h("table", { class: "t" }, ...Object.entries(counts).slice(0, 18).map(([k, v]) => h("tr", {}, h("td", { class: "mono" }, k), h("td", {}, String(v)))))),
    section("Damage per hit (this session)", hist),
    section("Collection by primary element", byEl),
    section("Win rate by arena (decisive battles)", arenaC),
    section("Hardware & session",
      h("dl", { class: "kv" },
        h("dt", {}, "GPU"), h("dd", {}, dev.gpu ?? "-"),
        h("dt", {}, "Form factor"), h("dd", {}, `${dev.formFactor} (${dev.touch ? "touch" : "mouse"})`),
        h("dt", {}, "CPU cores"), h("dd", {}, String(dev.cores)),
        h("dt", {}, "Memory"), h("dd", {}, dev.memoryGB ? `${dev.memoryGB} GB` : "hidden by browser"),
        h("dt", {}, "Screen"), h("dd", {}, `${dev.screen} @${dev.dpr}x`),
        h("dt", {}, "Frame"), h("dd", {}, `${fmt(app.stage.fps)} fps · ${fmt(app.stage.frameMs, 1)} ms CPU`),
        h("dt", {}, "Session"), h("dd", {}, `${fmt(s.active() / 60000, 1)} min active · ${s.clicks} clicks · screens ${Object.entries(s.screens).map(([k, v]) => `${k}×${v}`).join(", ")}`))),
  );
}
