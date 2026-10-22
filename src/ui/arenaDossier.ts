/**
 * Arena dossier [P4-A1]: a collapsible glass panel with everything worth knowing about an arena
 * before a battle - ground composition (click a ground to highlight it in the 3D preview), elevation
 * and slope, height levels / altitude / symmetry / cover [P5-W1], liquid / diggable / conductive shares,
 * favoured elements, the arena's weathers with their
 * boosted / weakened elements, plain-language hints and a topology toggle. Strict CSP: every dynamic
 * style value goes through CSS custom properties (h(..., { vars })).
 */
import { ELEMENTS, type ElementId } from "../data/elements.ts";
import type { GroundId } from "../data/grounds.ts";
import { type WeatherId, WEATHERS } from "../data/weather.ts";
import { ARENA_INFO } from "../world/arena.ts";
import type { ArenaStats } from "../world/arenaStats.ts";
import { bar, fmt, h, hex, pct } from "./dom.ts";

export interface ArenaDossierOptions {
  open?: boolean;
  /** Initial states (so a re-render keeps them). */
  topology?: boolean;
  highlight?: GroundId | null;
  /** Weathers offered by the selector (default ARENA_INFO[stats.kind].weathers). */
  weathers?: WeatherId[];
  onWeather?(w: WeatherId): void;
  onTopology?(on: boolean): void;
  onHighlight?(g: GroundId | null): void;
  /** The <details> was opened / collapsed by the player. */
  onOpen?(open: boolean): void;
  /** When given, a weather click rebuilds the dossier in place from restat(w) (no full panel re-render). */
  restat?(w: WeatherId): ArenaStats;
}

function chip(e: ElementId, extra?: string): HTMLElement {
  return h("span", { class: "el", vars: { el: hex(ELEMENTS[e].color) }, title: ELEMENTS[e].note }, ELEMENTS[e].name, extra ? h("small", { class: "dossier-mult" }, extra) : null);
}

function shareRow(label: string, frac: number, color: string, title: string): HTMLElement {
  return h("div", { class: "dossier-share", title }, h("span", { class: "dossier-share-label" }, label), bar(frac, color), h("span", { class: "dossier-share-val mono" }, pct(frac)));
}

/** Blue (low) -> amber (high) for a level band, relative to the arena's own band range. */
function levelColor(level: number, all: readonly { level: number }[]): string {
  const lo = Math.min(...all.map((b) => b.level)), hi = Math.max(...all.map((b) => b.level));
  const t = hi > lo ? (level - lo) / (hi - lo) : 0.5;
  const mix = (a: number, b: number) => Math.round(a + (b - a) * t);
  return `rgb(${mix(76, 255)}, ${mix(201, 209)}, ${mix(240, 102)})`;
}

function signedMult(m: number): string {
  const d = Math.round((m - 1) * 100);
  return `${d >= 0 ? "+" : ""}${d}%`;
}

/** Build the dossier. The returned element is a `<details class="dossier">`. */
export function renderArenaDossier(stats: ArenaStats, o: ArenaDossierOptions = {}): HTMLElement {
  let topology = !!o.topology;
  let highlight: GroundId | null = o.highlight ?? null;
  const top = stats.composition[0];
  const fav = stats.favours[0];
  const root = h("details", { class: "dossier", "data-arena": stats.kind, open: o.open !== false });
  root.addEventListener("toggle", () => o.onOpen?.(root.open));

  // Summary: name + 3 key chips (main ground, liquid share, top favoured element).
  root.append(h("summary", { class: "dossier-summary" },
    h("span", { class: "dossier-title" }, stats.name),
    h("span", { class: "dossier-chips" },
      top ? h("span", { class: "chip dossier-chip", title: `${top.name}: ${pct(top.share)} of the floor` }, h("i", { class: "dossier-dot", vars: { c: hex(top.color) } }), `${top.name} ${pct(top.share)}`) : null,
      h("span", { class: "chip dossier-chip", title: "Liquid share of the playable floor" }, `💧 ${pct(stats.liquidShare)}`),
      fav ? chip(fav.element) : h("span", { class: "chip dossier-chip" }, "neutral ground"))));

  const body = h("div", { class: "dossier-body" });
  root.append(body);
  body.append(h("p", { class: "muted dossier-note" }, stats.note));

  // Composition: stacked bar + legend rows (click = highlight in 3D).
  const legend = h("div", { class: "dossier-legend" });
  const stack = h("div", { class: "dossier-stack", role: "img", "aria-label": stats.composition.map((c) => `${c.name} ${pct(c.share)}`).join(", ") },
    ...stats.composition.map((c) => h("span", { class: "dossier-seg", title: `${c.name} ${pct(c.share)}`, vars: { w: `${(c.share * 100).toFixed(2)}%`, c: hex(c.color) } })));
  const paintLegend = () => {
    for (const b of Array.from(legend.children) as HTMLElement[]) {
      const on = b.dataset.ground === highlight;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", String(on));
    }
    root.classList.toggle("dossier-dim", highlight !== null);
  };
  for (const c of stats.composition) {
    legend.append(h("button", {
      class: "dossier-legend-row",
      type: "button",
      "data-ground": c.ground,
      title: `Highlight ${c.name.toLowerCase()} in the 3D preview`,
      onclick: () => {
        highlight = highlight === c.ground ? null : c.ground;
        paintLegend();
        o.onHighlight?.(highlight);
      },
    }, h("i", { class: "dossier-dot", vars: { c: hex(c.color) } }), h("span", {}, c.name), h("span", { class: "mono muted" }, pct(c.share))));
  }
  paintLegend();
  body.append(h("div", { class: "dossier-block" }, h("h3", {}, "Grounds"), stack, legend));

  // Terrain numbers.
  const e = stats.elevation, s = stats.slope;
  body.append(h("div", { class: "dossier-block" }, h("h3", {}, "Terrain"),
    h("dl", { class: "kv" },
      h("dt", {}, "Playable radius"), h("dd", {}, `${fmt(stats.radius, 1)} m · ${stats.cells} cells`),
      h("dt", {}, "Elevation"), h("dd", {}, `${fmt(e.min, 1)} … ${fmt(e.max, 1)} m (mean ${fmt(e.mean, 1)}, range ${fmt(e.range, 1)})`),
      h("dt", {}, "Slope"), h("dd", {}, `mean ${fmt(s.mean, 1)}° · max ${fmt(s.max, 0)}° · ${pct(s.steepShare)} over 25°`),
      h("dt", {}, "Conductivity"), h("dd", {}, `mean ×${fmt(stats.conductivityMean, 2)}`),
      h("dt", {}, "Landmarks"), h("dd", {}, `${stats.props} props`)),
    shareRow("Liquid", stats.liquidShare, "#2f8cff", "Water, mud-water or lava: swimmers thrive, walkers wade"),
    shareRow("Diggable", stats.diggableShare, "#a0703c", "Burrowers can hide underground here"),
    shareRow("Conductive", stats.conductiveShare, "#ffe14a", "Conductivity ≥ 1.2: electric chains through it"),
    shareRow("Steep", s.steepShare, "#ff6b35", "Cells sloping over 25°")));

  // Height levels, altitude and cover [P5-W1].
  const bands = [...stats.levels.bands].filter((b) => b.share >= 0.01).reverse(); // highest first
  const symText = stats.symmetry === "none" ? "free layout" : stats.symmetry === "mirror" ? "mirror (left = right)" : "rotated 180°";
  body.append(h("div", { class: "dossier-block", "data-dossier": "levels" }, h("h3", {}, "Levels & cover"),
    h("dl", { class: "kv" },
      h("dt", {}, "Altitude"), h("dd", {}, `${fmt(stats.altitudeM)} m above sea level`),
      h("dt", {}, "Symmetry"), h("dd", {}, symText),
      h("dt", {}, "Height levels"), h("dd", {}, `${bands.length} bands, ${fmt(stats.levels.step, 2)} m apart · ${stats.plateaus} plateau${stats.plateaus === 1 ? "" : "s"}`),
      h("dt", {}, "Cover"), h("dd", {}, `${stats.cover.inner} props in the ring (${stats.cover.solid} solid) · ${fmt(stats.cover.per100m2, 2)} per 100 m²`)),
    ...bands.map((b) => shareRow(`${b.h >= 0 ? "+" : ""}${fmt(b.h, 1)} m`, b.share, levelColor(b.level, stats.levels.bands), `Level ${b.level}: ${pct(b.share)} of the floor`)),
    stats.cover.kinds.length
      ? h("div", { class: "row dossier-cover" }, ...stats.cover.kinds.map((k) => h("span", { class: "chip dossier-chip", "data-prop": k.kind }, `${k.name} ×${k.count}`)))
      : h("p", { class: "muted" }, "An open floor: no cover inside the ring.")));

  // Favoured elements.
  body.append(h("div", { class: "dossier-block" }, h("h3", {}, "Favours"),
    stats.favours.length
      ? h("div", { class: "row dossier-favours" }, ...stats.favours.map((f) => chip(f.element, `+${Math.round(f.score * 100)}`)))
      : h("p", { class: "muted" }, "No element is favoured: a neutral ground.")));

  // Weather selector + boosted / weakened chips.
  const weathers = o.weathers ?? ARENA_INFO[stats.kind].weathers;
  const w = stats.weather;
  body.append(h("div", { class: "dossier-block" }, h("h3", {}, "Weather"),
    h("div", { class: "row dossier-weathers", role: "group", "aria-label": "Preview weather" }, ...weathers.map((id) =>
      h("button", {
        class: `btn small ${w?.id === id ? "on" : ""}`,
        type: "button",
        "data-weather": id,
        "aria-pressed": String(w?.id === id),
        title: WEATHERS[id].note,
        onclick: () => {
          o.onWeather?.(id);
          if (o.restat) root.replaceWith(renderArenaDossier(o.restat(id), { ...o, open: true, topology, highlight }));
        },
      }, WEATHERS[id].name))),
    w
      ? h("div", { class: "dossier-weather" },
        h("p", { class: "muted" }, w.note),
        h("dl", { class: "kv" },
          h("dt", {}, "Visibility"), h("dd", {}, pct(w.visibility)),
          h("dt", {}, "Wind"), h("dd", {}, `${fmt(w.wind, 1)} m/s`),
          h("dt", {}, "Wetness"), h("dd", {}, `${w.wetness >= 0 ? "+" : ""}${fmt(w.wetness, 1)}`)),
        w.boosted.length ? h("div", { class: "row" }, h("span", { class: "muted dossier-tag" }, "Boosted"), ...w.boosted.map((el) => chip(el, signedMult(w.mult[el] ?? 1)))) : null,
        w.weakened.length ? h("div", { class: "row" }, h("span", { class: "muted dossier-tag" }, "Weakened"), ...w.weakened.map((el) => chip(el, signedMult(w.mult[el] ?? 1)))) : null)
      : h("p", { class: "muted" }, "Pick a weather to see its modifiers.")));

  // Hints.
  body.append(h("div", { class: "dossier-block" }, h("h3", {}, "What it means"),
    h("ul", { class: "dossier-hints" }, ...stats.hints.map((t) => h("li", {}, t)))));

  // Topology toggle.
  const topo = h("button", {
    class: `btn small ${topology ? "on" : ""}`,
    type: "button",
    "data-action": "arena-topology",
    "aria-pressed": String(topology),
    title: "Iso-height contour lines on the 3D preview",
    onclick: () => {
      topology = !topology;
      topo.classList.toggle("on", topology);
      topo.setAttribute("aria-pressed", String(topology));
      topo.textContent = topology ? "◎ Topology on" : "◎ Topology";
      o.onTopology?.(topology);
    },
  }, topology ? "◎ Topology on" : "◎ Topology");
  const clearHl = h("button", {
    class: "btn small",
    type: "button",
    title: "Show every ground again",
    onclick: () => {
      if (highlight === null) return;
      highlight = null;
      paintLegend();
      o.onHighlight?.(null);
    },
  }, "Show all grounds");
  body.append(h("div", { class: "row dossier-tools" }, topo, clearHl));
  return root;
}
