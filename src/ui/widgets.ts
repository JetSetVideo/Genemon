/** Reusable UI pieces: Genemon cards, element chips, axis bars, stat tables, move rows. */
import { AXES, type AxisId } from "../data/axes.ts";
import { ELEMENTS, type ElementId } from "../data/elements.ts";
import { type Genemon, phenotypeOf, STAGE_NAMES } from "../genome/genemon.ts";
import { moveCostBreakdown } from "../combat/moves.ts";
import { ALL_MOVE_BY_ID as MOVE_BY_ID } from "../combat/kit.ts";
import type { Phenotype } from "../genome/phenotype.ts";
import { bar, fmt, h, hex } from "./dom.ts";

export function elChip(e: ElementId): HTMLElement {
  return h("span", { class: "el", vars: { el: hex(ELEMENTS[e].color) }, title: ELEMENTS[e].note }, ELEMENTS[e].name);
}

export function genemonCard(g: Genemon, o: { selected?: boolean; inTeam?: boolean; onClick?: () => void } = {}): HTMLElement {
  const ph = phenotypeOf(g);
  return h("button", { class: `gcard ${o.selected ? "sel" : ""} ${o.inTeam ? "inteam" : ""}`, onclick: o.onClick, title: `${ph.kind} · ${ph.heightM.toFixed(2)} m · ${fmt(ph.massKg, 1)} kg` },
    h("span", { class: "swatch", vars: { sw: hex(ph.palette.base) } }),
    h("span", { class: "name" }, g.name),
    h("span", { class: "row" }, elChip(ph.elements.primary), ph.elements.secondary ? elChip(ph.elements.secondary) : null),
    h("span", { class: "row muted" }, h("span", { class: "size", title: `${ph.slots} team slot(s)` }, `${ph.sizeClass}·${ph.slots}`), `Lv ${ph.level}`, `⚡${Math.round(ph.power)}`),
    h("span", { class: "muted" }, `${ph.kind} · ${STAGE_NAMES[g.stage]}`));
}

export function axisRow(id: AxisId, v: number, genetic: number): HTMLElement {
  const a = AXES.find((x) => x.id === id)!;
  const pct = (x: number) => `${((x + 1) / 2 * 100).toFixed(1)}%`;
  return h("div", { class: `axis ${Math.abs(v) > 0.5 ? "active" : ""}`, title: `${a.note} (genetic ${genetic.toFixed(2)}, expressed ${v.toFixed(2)})` },
    h("span", { class: "neg" }, a.neg),
    h("span", { class: "track" }, h("span", { class: "gen", vars: { g: pct(genetic) } }), h("span", { class: "dot", vars: { x: pct(v), c: v < 0 ? "#7b8cff" : "#ff8a5b" } })),
    h("span", { class: "pos" }, a.pos));
}

export function statsBlock(ph: Phenotype): HTMLElement {
  const s = ph.stats;
  const row = (k: string, v: string, title = "") => [h("dt", { title }, k), h("dd", {}, v)];
  return h("dl", { class: "kv" },
    ...row("HP", fmt(s.hp)), ...row("Attack", fmt(s.atk)), ...row("Defence", fmt(s.def)),
    ...row("Speed", `${fmt(s.spd, 1)} m/s`), ...row("Energy regen", `${fmt(s.regen, 1)}/s`),
    ...row("Accuracy", `${Math.round(s.accuracy * 100)}%`), ...row("Evasion", `${Math.round(s.evasion * 100)}%`),
    ...row("Crit", `${Math.round(s.crit * 100)}%`), ...row("Balance", fmt(s.balance, 2), "Resistance to knockback & stagger"),
    ...row("Reach", `${fmt(s.reach, 2)} m`), ...row("Phase speed", `x${fmt(s.rate, 2)}`, "Charge/rest speed multiplier"),
    ...row("Power index", fmt(ph.power), "sqrt(eHP x attack x rate), normalised to the size budget"));
}

export function bodyBlock(ph: Phenotype): HTMLElement {
  const row = (k: string, v: string) => [h("dt", {}, k), h("dd", {}, v)];
  const ab = Object.entries(ph.abilities).filter(([, v]) => v).map(([k]) => k).join(", ") || "none";
  return h("dl", { class: "kv" },
    ...row("Body plan", ph.kind), ...row("Size class", `${ph.sizeClass} (${ph.slots} slot${ph.slots > 1 ? "s" : ""})`),
    ...row("Height", `${fmt(ph.heightM, 2)} m`), ...row("Mass", `${fmt(ph.massKg, 1)} kg`),
    ...row("Density", `${fmt(ph.density)} kg/m³`), ...row("Elasticity", fmt(ph.elasticity, 2)),
    ...row("Mobility", `x${fmt(ph.mobility, 2)}`), ...row("Pattern", ph.pattern),
    ...row("Growth", `${Math.round(ph.growth * 100)}%`), ...row("Abilities", ab));
}

export function psycheBlock(ph: Phenotype): HTMLElement {
  const p = ph.psyche;
  return h("div", {},
    h("p", {}, h("b", {}, "Character: "), p.character.join(", ")),
    h("p", {}, h("b", {}, "Passions: "), p.passions.join(", ")),
    h("p", {}, h("b", {}, "Envies: "), p.envies.join(", ")),
    h("p", {}, h("b", {}, "Fears: "), p.fears.join(", ") || "nothing much"),
    h("h3", {}, "Needs"),
    ...Object.entries(p.needs).map(([k, v]) => h("div", { class: "row" }, h("span", { class: "muted" }, k.padEnd(8)), h("div", { class: "spacer" }, bar(v, "#9b5de5")))),
    h("h3", {}, "Baseline emotions"),
    ...Object.entries(p.emotions).filter(([k]) => k !== "energy").map(([k, v]) => h("div", { class: "row" }, h("span", { class: "muted" }, k), h("div", { class: "spacer" }, bar(v, "#f15bb5")))));
}

export function movesBlock(g: Genemon): HTMLElement {
  return h("table", { class: "t" },
    h("tr", {}, h("th", {}, "Move"), h("th", {}, "Type"), h("th", {}, "Shape"), h("th", { title: "power / area / range" }, "Pow"), h("th", { title: "charge / active / rest seconds" }, "Phases"), h("th", { title: "energy cost (power x area x range x accuracy x tempo + effects, x rarity x meta)" }, "Cost")),
    ...g.moves.map((id) => {
      const m = MOVE_BY_ID[id];
      if (!m) return h("tr", {}, h("td", {}, id));
      const c = moveCostBreakdown(m);
      return h("tr", { title: m.effects.map((e) => `${e.kind}${e.status ? ":" + e.status : ""}${e.chance ? " " + Math.round(e.chance * 100) + "%" : ""}`).join(", ") },
        h("td", {}, m.name), h("td", {}, elChip(m.element)), h("td", {}, m.shape),
        h("td", {}, `${m.power}${m.area ? ` ⌀${m.area}` : ""}${m.range ? ` ↦${m.range}` : ""}`),
        h("td", { class: "mono" }, `${m.charge}/${m.active}/${m.rest}`),
        h("td", { class: "mono", title: `damage ${c.damage.toFixed(1)} · tempo x${c.tempo.toFixed(2)} · effects ${c.effects.toFixed(1)} · rarity x${c.rarity} · meta x${c.meta.toFixed(2)}` }, String(c.cost)));
    }));
}

// ------------------------------------------------------------------ pass 5 [P5-U4]: shaded sections + stat bars
/** Section families: each gets its own title-band shade (CSS .ui5-f-<family>). */
export type SectionFamily = "id" | "stats" | "attacks" | "story" | "character" | "objects" | "life" | "evolution" | "genome" | "care" | "breed" | "bag";

type Kid = Node | string | number | null | undefined | false;

/** A glass section whose title sits on a band shaded by its family; `o.id` makes it a scroll target. */
export function sec(family: SectionFamily, title: string, o: { id?: string; extra?: Kid } = {}, ...children: Kid[]): HTMLElement {
  return h("div", { class: `section ui5-sec ui5-f-${family}`, id: o.id, "data-family": family },
    h("div", { class: "section-head ui5-sec-head" }, h("h2", {}, title), o.extra ?? null),
    h("div", { class: "ui5-sec-body" }, ...children));
}

/** One labelled bar row (block layout, never inside a table cell). */
export function barRow(label: string, frac: number, value: string, color: string, title = ""): HTMLElement {
  return h("div", { class: "ui5-barrow", title }, h("span", { class: "ui5-bl" }, label), bar(frac, color), h("span", { class: "ui5-bv mono" }, value));
}

/**
 * Main stats as bars. Raw stats scale with the size class, so HP / attack / defence / speed / power are
 * drawn relative to `ref` (the best value of the collection, or the value itself); rates are absolute.
 */
export function statBars(ph: Phenotype, ref?: Partial<Record<"hp" | "atk" | "def" | "spd" | "power", number>>): HTMLElement {
  const s = ph.stats;
  const rel = (v: number, k: "hp" | "atk" | "def" | "spd" | "power") => v / Math.max(v, ref?.[k] ?? v, 1e-9);
  return h("div", { class: "ui5-bars" },
    barRow("HP", rel(s.hp, "hp"), fmt(s.hp), "#3ddc84", "relative to your strongest"),
    barRow("Attack", rel(s.atk, "atk"), fmt(s.atk), "#ff6b35"),
    barRow("Defence", rel(s.def, "def"), fmt(s.def), "#4cc9f0"),
    barRow("Speed", rel(s.spd, "spd"), `${fmt(s.spd, 1)} m/s`, "#ffd166"),
    barRow("Power", rel(ph.power, "power"), fmt(ph.power), "#f15bb5", "sqrt(eHP x attack x rate), normalised to the size budget"),
    barRow("Accuracy", s.accuracy, `${Math.round(s.accuracy * 100)}%`, "#9b5de5"),
    barRow("Evasion", s.evasion * 2, `${Math.round(s.evasion * 100)}%`, "#7bdff2", "bar scale 0-50 %"),
    barRow("Crit", s.crit * 2, `${Math.round(s.crit * 100)}%`, "#e76f51", "bar scale 0-50 %"),
    barRow("Balance", s.balance, fmt(s.balance, 2), "#a7b3c6", "Resistance to knockback & stagger"),
    barRow("Phase speed", Math.min(1, s.rate / 2), `x${fmt(s.rate, 2)}`, "#00f5d4", "Charge/rest speed multiplier (bar scale x0-x2)"));
}
