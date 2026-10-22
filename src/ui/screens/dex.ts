/**
 * Collection screen (P4-R1, P4-R2, P4-R3, P4-U1): ALL my Genemon (search / sort / filters + a detail
 * drawer with the Q/W/E/R kit), several saved TEAM presets with one active, the Dex (seen vs owned) and
 * a prominent Hatch button. Three-click rule: tab -> card -> the drawer shows the moves.
 */
import type { App } from "../app.ts";
import { ELEMENT_IDS, ELEMENTS, type ElementId } from "../../data/elements.ts";
import { type Genemon, phenotypeOf, STAGE_NAMES } from "../../genome/genemon.ts";
import { SIZE_CLASSES, type SizeClass } from "../../genome/phenotype.ts";
import { MOVE_BY_ID } from "../../combat/moves.ts";
import { synergies, TEAM_CAPACITY } from "../../combat/team.ts";
import { hashSeed } from "../../core/rng.ts";
import type { Profile } from "../profile.ts";
import { clear, fmt, h, hex, section, select, toast } from "../dom.ts";
import { elChip, genemonCard } from "../widgets.ts";
import { kitStrip } from "../moveCard.ts";
import { dayKey, HATCH_CHOICES, hatchCost, type HatchElement, hatchedOn, hatchGenemon, type HatchRecord, recordHatch } from "../hatch.ts";
import {
  activePreset,
  createPreset,
  deletePreset,
  duplicatePreset,
  MAX_PRESETS,
  moveMember,
  presetsOf,
  presetsWith,
  renamePreset,
  setActive,
  slotsOf,
  syncFromTeam,
  toggleMember,
  type TeamPresets,
  withPresets,
} from "../teamsStore.ts";

type Tab = "genemon" | "teams" | "dex";
type Sort = "level" | "power" | "name" | "element" | "size" | "newest";

// Persistent module state (survives re-renders, like lab.ts).
let tab: Tab = "genemon";
let query = "";
let sort: Sort = "level";
let elFilter: ElementId | "all" = "all";
let sizeFilter: SizeClass | "all" = "all";
let hatchEl: HatchElement = "any";
let drawer: string | null = null;

type CollectionProfile = Profile & { hatches?: HatchRecord };

const SORTS: readonly { value: Sort; label: string }[] = [
  { value: "level", label: "Level" },
  { value: "power", label: "Power" },
  { value: "name", label: "Name" },
  { value: "element", label: "Element" },
  { value: "size", label: "Size" },
  { value: "newest", label: "Newest" },
];

function idsOf(p: Profile): string[] {
  return p.collection.map((g) => g.id);
}

/** The presets, reconciled with `profile.team` (older screens still edit it directly). */
function presets(p: Profile): TeamPresets {
  return syncFromTeam(presetsOf(p), p.team, idsOf(p));
}

function commit(app: App, ps: TeamPresets, why: string): void {
  const p = withPresets(app.profile, ps);
  app.log("team.change", why, activePreset(ps).id, p.team.join(","));
  app.save();
  app.render();
}

// ---------------------------------------------------------------- hatch

function hatch(app: App): void {
  const p = app.profile as CollectionProfile;
  const now = new Date();
  const day = dayKey(now);
  const n = hatchedOn(p.hatches, day);
  const cost = hatchCost(n);
  if (p.credits < cost) {
    toast(`Hatching costs ${cost} credits today; you have ${fmt(p.credits)}.`);
    return;
  }
  const ids = new Set(idsOf(p));
  let g: Genemon | null = null;
  for (let k = 0; k < 8 && (!g || ids.has(g.id)); k++) {
    g = hatchGenemon({ seed: hashSeed(p.seed, "hatch", day, n, p.collection.length, now.getTime() % 1e9, k), owner: p.id, element: hatchEl, bornAt: now.getTime() });
  }
  if (!g || ids.has(g.id)) {
    toast("The egg did not hatch, try again.");
    return;
  }
  const ph = phenotypeOf(g);
  p.credits -= cost;
  p.hatches = recordHatch(p.hatches, day);
  p.collection.push(g);
  if (!p.pokedex.includes(g.genome.id)) p.pokedex.push(g.genome.id);
  app.log("genemon.hatch", `hatched (${hatchEl})`, g.id, `${g.name} · ${ph.elements.primary} · ${ph.sizeClass} · cost ${cost}`);
  app.save();
  tab = "genemon";
  drawer = g.id;
  toast(`🥚 ${g.name} hatched: ${ELEMENTS[ph.elements.primary].name}, ${ph.sizeClass}${cost ? ` (−${cost} credits)` : " (free today)"}.`);
  app.select(g.id);
}

function hatchBar(app: App): HTMLElement {
  const p = app.profile as CollectionProfile;
  const cost = hatchCost(hatchedOn(p.hatches, dayKey(new Date())));
  const label = (e: HatchElement) => e === "any" ? "Any (mostly plain)" : e === "plain" ? "Plain" : ELEMENTS[e].name;
  return h("div", { class: "dex-hatch" },
    h("button", { class: "btn primary big dex-hatch-btn", "data-action": "hatch", disabled: p.credits < cost, title: "Hatch a random newborn: most are plain/neutral; elements come later from food and life", onclick: () => hatch(app) },
      `🥚 Hatch · ${cost ? `${cost} c` : "free"}`),
    h("label", { class: "field dex-hatch-el" }, "Egg", select<HatchElement>(HATCH_CHOICES.map((e) => ({ value: e, label: label(e) })), hatchEl, (v) => {
      hatchEl = v;
    })),
    h("span", { class: "muted" }, `${fmt(p.credits)} credits · first hatch each day is free`));
}

// ---------------------------------------------------------------- Genemon tab

function sortKey(g: Genemon, i: number): [number, string] {
  const ph = phenotypeOf(g);
  switch (sort) {
    case "level": return [-ph.level, g.name];
    case "power": return [-ph.power, g.name];
    case "name": return [0, g.name.toLowerCase()];
    case "element": return [ELEMENT_IDS.indexOf(ph.elements.primary), g.name];
    case "size": return [-ph.slots, g.name];
    case "newest": return [-(g.bornAt || 0) - i * 1e-6, g.name];
  }
}

function visible(p: Profile): Genemon[] {
  const q = query.trim().toLowerCase();
  const keyed = p.collection.map((g, i) => ({ g, k: sortKey(g, i) })).filter(({ g }) => {
    const ph = phenotypeOf(g);
    if (elFilter !== "all" && ph.elements.primary !== elFilter && ph.elements.secondary !== elFilter) return false;
    if (sizeFilter !== "all" && ph.sizeClass !== sizeFilter) return false;
    if (q && !`${g.name} ${ph.kind} ${ph.elements.primary} ${ph.elements.secondary ?? ""} ${g.genome.id}`.toLowerCase().includes(q)) return false;
    return true;
  });
  keyed.sort((a, b) => a.k[0] - b.k[0] || a.k[1].localeCompare(b.k[1]));
  return keyed.map((x) => x.g);
}

function toggleActive(app: App, id: string): void {
  const ps = presets(app.profile);
  const act = activePreset(ps);
  if (act.members.includes(id) && act.members.length <= 1) {
    toast("A team needs at least one Genemon.");
    return;
  }
  const r = toggleMember(ps, act.id, id, app.profile.collection);
  if (!r.ok) {
    const g = app.profile.collection.find((x) => x.id === id);
    toast(`Not enough slots in ${act.name}: ${g?.name ?? id} ${r.reason}.`);
    return;
  }
  commit(app, r.presets, `user edited team ${act.name}`);
}

function detailDrawer(app: App, g: Genemon, ps: TeamPresets): HTMLElement {
  const ph = phenotypeOf(g);
  const act = activePreset(ps);
  const inActive = act.members.includes(g.id);
  const moves = g.moves.map((id) => MOVE_BY_ID[id]).filter((m) => !!m);
  const ins = presetsWith(ps, g.id).map((t) => t.name);
  return h("div", { class: "dex-drawer", "data-genemon": g.id, vars: { el: hex(ELEMENTS[ph.elements.primary].color) } },
    h("div", { class: "dex-drawer-head" },
      h("span", { class: "dex-name" }, g.name),
      h("button", { class: "btn small", title: "Close", onclick: () => {
        drawer = null;
        app.render();
      } }, "✕")),
    h("div", { class: "row" }, elChip(ph.elements.primary), ph.elements.secondary ? elChip(ph.elements.secondary) : null,
      h("span", { class: "size", title: `${ph.slots} team slot(s)` }, `${ph.sizeClass}·${ph.slots}`)),
    h("dl", { class: "kv" },
      h("dt", {}, "Level"), h("dd", {}, String(ph.level)),
      h("dt", {}, "Stage"), h("dd", {}, STAGE_NAMES[g.stage] || "-"),
      h("dt", {}, "Power"), h("dd", {}, fmt(ph.power)),
      h("dt", {}, "Body"), h("dd", {}, `${ph.kind} · ${fmt(ph.heightM, 2)} m · ${fmt(ph.massKg, 1)} kg`),
      h("dt", {}, "Teams"), h("dd", {}, ins.length ? ins.join(", ") : "none")),
    h("h3", {}, "Moves"),
    moves.length ? kitStrip(moves) : h("p", { class: "muted" }, "No moves learned yet."),
    h("div", { class: "row" },
      h("button", { class: `btn ${inActive ? "" : "primary"}`, "data-action": "toggle-team", onclick: () => toggleActive(app, g.id) }, inActive ? `Remove from ${act.name}` : `Add to ${act.name}`),
      h("button", { class: "btn", onclick: () => {
        app.select(g.id);
        app.go("lab");
      } }, "Open in Lab")));
}

function genemonTab(app: App, ps: TeamPresets): HTMLElement {
  const p = app.profile;
  const act = activePreset(ps);
  const grid = h("div", { class: "cards dex-grid" });
  const count = h("span", { class: "muted" });
  const fill = () => {
    clear(grid);
    const list = visible(p);
    count.textContent = `${list.length} / ${p.collection.length}`;
    for (const g of list) {
      const card = genemonCard(g, { selected: drawer === g.id, inTeam: act.members.includes(g.id), onClick: () => {
        drawer = g.id;
        app.select(g.id);
      } });
      const n = presetsWith(ps, g.id).length;
      if (n > 0) card.append(h("span", { class: "dex-badge", title: presetsWith(ps, g.id).map((t) => t.name).join(", ") }, `❖${n}`));
      grid.append(card);
    }
    if (!list.length) grid.append(h("p", { class: "muted" }, "No Genemon match these filters."));
  };
  fill();
  const chip = (e: ElementId | "all") =>
    h("button", {
      class: `el dex-elf ${elFilter === e ? "on" : ""}`,
      vars: { el: e === "all" ? "#8a94a6" : hex(ELEMENTS[e].color) },
      "data-el": e,
      onclick: () => {
        elFilter = elFilter === e ? "all" : e;
        app.render();
      },
    }, e === "all" ? "All" : ELEMENTS[e].name);
  const present = ELEMENT_IDS.filter((e) => p.collection.some((g) => {
    const els = phenotypeOf(g).elements;
    return els.primary === e || els.secondary === e;
  }));
  const sel = drawer ? p.collection.find((g) => g.id === drawer) : undefined;
  return h("div", {},
    sel ? detailDrawer(app, sel, ps) : null,
    h("div", { class: "dex-tools" },
      h("input", { class: "dex-search", type: "search", placeholder: "Search name, element, body…", value: query, "aria-label": "Search Genemon", oninput: (e: Event) => {
        query = (e.target as HTMLInputElement).value;
        fill();
      } }),
      h("label", { class: "field" }, "Sort", select<Sort>(SORTS, sort, (v) => {
        sort = v;
        app.render();
      })),
      h("label", { class: "field" }, "Size", select<SizeClass | "all">(["all", ...SIZE_CLASSES], sizeFilter, (v) => {
        sizeFilter = v;
        app.render();
      }))),
    h("div", { class: "row dex-elfilters" }, chip("all"), ...present.map(chip)),
    section(`All my Genemon · ${p.collection.length}`, h("div", { class: "row" }, count, h("span", { class: "muted" }, `❖ = in a saved team · TEAM = in ${act.name}`)), grid));
}

// ---------------------------------------------------------------- Teams tab

function slotBar(members: Genemon[]): HTMLElement {
  const slots = h("div", { class: "slots dex-slots" });
  let used = 0;
  members.forEach((g, i) => {
    const ph = phenotypeOf(g);
    slots.append(h("div", { class: "slot filled", vars: { sw: hex(ph.palette.base), span: ph.slots }, title: `${g.name}: ${ph.sizeClass} costs ${ph.slots} slot(s)` }, `${i + 1}. ${g.name}`));
    used += ph.slots;
  });
  for (let i = used; i < TEAM_CAPACITY; i++) slots.append(h("div", { class: "slot" }, "free"));
  return slots;
}

function teamsTab(app: App, ps: TeamPresets): HTMLElement {
  const p = app.profile;
  const act = activePreset(ps);
  const members = act.members.map((id) => p.collection.find((g) => g.id === id)).filter((g): g is Genemon => !!g);
  const used = slotsOf(act.members, p.collection);
  const syn = synergies({ id: act.id, owner: p.id, name: act.name, members });
  const rows = ps.list.map((t) => {
    const on = t.id === ps.active;
    return h("div", { class: `dex-preset ${on ? "on" : ""}`, "data-preset": t.id },
      h("button", { class: `btn small ${on ? "on" : ""}`, title: on ? "Active team (used in battles)" : "Make this the active team", onclick: () => {
        if (!on) commit(app, setActive(ps, t.id), `user activated team ${t.name}`);
      } }, on ? "● active" : "○ use"),
      h("input", { class: "dex-preset-name", type: "text", maxlength: 24, value: t.name, "aria-label": "Team name", onchange: (e: Event) => commit(app, renamePreset(ps, t.id, (e.target as HTMLInputElement).value), "user renamed a team") }),
      h("span", { class: "muted mono" }, `${t.members.length}♟ ${slotsOf(t.members, p.collection)}/${TEAM_CAPACITY}`),
      h("button", { class: "btn small", title: "Duplicate", disabled: ps.list.length >= MAX_PRESETS, onclick: () => commit(app, duplicatePreset(ps, t.id), `user duplicated team ${t.name}`) }, "⧉"),
      h("button", { class: "btn small", title: "Delete", disabled: ps.list.length <= 1, onclick: () => {
        if (ps.list.length <= 1) return;
        commit(app, deletePreset(ps, t.id), `user deleted team ${t.name}`);
        toast(`Deleted ${t.name}.`);
      } }, "✕"));
  });
  const create = () => {
    if (ps.list.length >= MAX_PRESETS) return toast(`At most ${MAX_PRESETS} teams.`);
    const lead = act.members[0];
    const next = createPreset(ps, `Team ${ps.list.length + 1}`, lead ? [lead] : []);
    const made = next.list[next.list.length - 1];
    commit(app, setActive(next, made.id), "user created a team");
    toast(`${made.name} created and active; add Genemon below.`);
  };
  const bench = p.collection.filter((g) => !act.members.includes(g.id));
  return h("div", {},
    section(`Saved teams · ${ps.list.length}/${MAX_PRESETS}`, ...rows,
      h("button", { class: "btn", "data-action": "new-team", disabled: ps.list.length >= MAX_PRESETS, onclick: create }, "+ New team")),
    section(`${act.name} · ${used}/${TEAM_CAPACITY} slots`, slotBar(members),
      ...members.map((g, i) => h("div", { class: "row dex-member" }, h("b", {}, `${i + 1}.`),
        h("button", { class: "dex-link spacer", title: "Show details", onclick: () => {
          tab = "genemon";
          drawer = g.id;
          app.select(g.id);
        } }, g.name),
        elChip(phenotypeOf(g).elements.primary),
        h("button", { class: "btn small", title: "Move up", disabled: i === 0, onclick: () => commit(app, moveMember(ps, act.id, g.id, -1), "user reordered the team") }, "↑"),
        h("button", { class: "btn small", title: "Move down", disabled: i === members.length - 1, onclick: () => commit(app, moveMember(ps, act.id, g.id, 1), "user reordered the team") }, "↓"),
        h("button", { class: "btn small", title: "Remove", onclick: () => toggleActive(app, g.id) }, "✕"))),
      members.length ? null : h("p", { class: "muted" }, "Empty team: add Genemon below.")),
    section("Synergies", ...(syn.length ? syn.map((s) => h("p", {}, h("b", {}, s.name), ` - ${s.why}`)) : [h("p", { class: "muted" }, "None. Try water + electric (Conductor), fire + air (Bellows), plant + water (Garden)…")])),
    section(`Add to ${act.name}`, h("div", { class: "dex-bench" }, ...bench.map((g) => {
      const ph = phenotypeOf(g);
      const fits = used + ph.slots <= TEAM_CAPACITY;
      return h("button", { class: "btn small dex-add", disabled: !fits, title: fits ? `Add (${ph.slots} slot)` : `Needs ${ph.slots} slot(s), ${TEAM_CAPACITY - used} free`, vars: { el: hex(ELEMENTS[ph.elements.primary].color) }, onclick: () => toggleActive(app, g.id) }, `+ ${g.name} · ${ph.sizeClass}`);
    }))));
}

// ---------------------------------------------------------------- Dex tab

function dexTab(app: App): HTMLElement {
  const p = app.profile;
  const owned = new Map<string, Genemon>();
  for (const g of p.collection) if (!owned.has(g.genome.id)) owned.set(g.genome.id, g);
  const seen = [...new Set([...p.pokedex, ...owned.keys()])];
  const nOwned = seen.filter((id) => owned.has(id)).length;
  const cards = seen.map((gid, i) => {
    const g = owned.get(gid);
    if (g) {
      const c = genemonCard(g, { selected: drawer === g.id, onClick: () => {
        tab = "genemon";
        drawer = g.id;
        app.select(g.id);
      } });
      c.append(h("span", { class: "dex-no mono" }, `#${String(i + 1).padStart(3, "0")}`));
      return c;
    }
    return h("div", { class: "gcard dex-unknown", title: `Seen, not owned · ${gid}` },
      h("span", { class: "dex-q" }, "?"),
      h("span", { class: "name" }, "Unknown"),
      h("span", { class: "muted mono" }, `#${String(i + 1).padStart(3, "0")} · seen`));
  });
  return h("div", {},
    section(`Dex · ${seen.length} seen · ${nOwned} owned`,
      h("div", { class: "dex-progress" }, h("div", { class: "bar" }, h("i", { vars: { w: `${seen.length ? (nOwned / seen.length * 100).toFixed(1) : 0}%`, c: "#3ddc84" } }))),
      h("p", { class: "muted" }, "Every species you met. Owned ones show their card; seen-but-not-owned stay a silhouette until you catch, breed or hatch one."),
      h("div", { class: "cards dex-grid" }, ...cards)));
}

// ---------------------------------------------------------------- screen

export function renderDex(app: App): HTMLElement {
  const p = app.profile;
  if (drawer && !p.collection.some((g) => g.id === drawer)) drawer = null;
  const ps = presets(p);
  const tabs: readonly { id: Tab; label: string }[] = [
    { id: "genemon", label: `Genemon ${p.collection.length}` },
    { id: "teams", label: `Teams ${ps.list.length}` },
    { id: "dex", label: "Dex" },
  ];
  const bar = h("div", { class: "row dex-tabs", role: "tablist" }, ...tabs.map((t) =>
    h("button", { class: `btn small ${tab === t.id ? "on" : ""}`, role: "tab", "aria-selected": tab === t.id ? "true" : "false", "data-tab": t.id, onclick: () => {
      tab = t.id;
      app.render();
    } }, t.label)));
  const body = tab === "genemon" ? genemonTab(app, ps) : tab === "teams" ? teamsTab(app, ps) : dexTab(app);
  return h("div", { class: "dex" },
    h("div", { class: "row" }, h("h1", {}, "Collection"), h("span", { class: "muted" }, `active: ${activePreset(ps).name}`)),
    hatchBar(app),
    bar,
    body);
}
