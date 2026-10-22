/**
 * Collection screen (P4-R1, P4-R2, P4-R3, P4-U1): ALL my Genemon (search / sort / filters + a detail
 * drawer with the Q/W/E/R kit), several saved TEAM presets with one active, the Dex (seen vs owned) and
 * a prominent Hatch button. Three-click rule: tab -> card -> the drawer shows the moves.
 * Pass 5 [P5-D2]: the Dex tab lists SPECIES (body plan x elemental identity) that are unseen / seen /
 * owned / developed, with research levels 1-5 earned by owning, feeding and battling.
 */
import type { App } from "../app.ts";
import { ELEMENT_IDS, ELEMENTS, type ElementId } from "../../data/elements.ts";
import { HYBRIDS, identityOfPhenotype } from "../../data/hybrids.ts";
import { AXIS_BY_ID, type AxisId } from "../../data/axes.ts";
import { FOOD_IDS, FOODS } from "../../data/lifestyle.ts";
import { type Genemon, phenotypeOf, STAGE_NAMES } from "../../genome/genemon.ts";
import { BODY_KINDS, type BodyKind } from "../../genome/genome.ts";
import { type Phenotype, SIZE_CLASSES, type SizeClass } from "../../genome/phenotype.ts";
import { LIFE_PHASES } from "../../genome/lifeTypes.ts";
import { ALL_MOVE_BY_ID as MOVE_BY_ID } from "../../combat/kit.ts";
import { synergies, TEAM_CAPACITY } from "../../combat/team.ts";
import { hashSeed } from "../../core/rng.ts";
import type { Profile } from "../profile.ts";
import { bar, clear, fmt, h, hex, section, select, toast } from "../dom.ts";
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
type DexProfile = Profile & { dexP5?: DexMemory };

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

// ---------------------------------------------------------------- Dex: species [P5-D2]
//
// A SPECIES = body plan x elemental identity (src/data/hybrids.ts identityOfPhenotype: the element, or
// the hybrid the body expresses). 6 body plans x (14 elements + 58 hybrids) = 432 entries. Each one is
// UNSEEN, SEEN (met in a battle, never owned), OWNED (research level 1) or DEVELOPED (levels 2-5).
// Research points come from owning (10 per Genemon, max 5), feeding (1 per food unit, max 200) and
// battling (4 per battle, max 100) with members of the species; the best score is remembered so
// research never regresses when a Genemon is sold or released. The pure part below is tested in
// tests/home_dex_test.ts.

export interface Species {
  key: string;
  kind: BodyKind;
  /** Element id or hybrid id. */
  identity: string;
  name: string;
  color: number;
  hybrid: boolean;
  /** The two parents of a hybrid identity. */
  parents: [ElementId, ElementId] | null;
}

/** Dex memory stored on the profile (`dexP5`): first-seen time and best research points per species. */
export interface DexMemory {
  seen: Record<string, number>;
  best: Record<string, number>;
}

export interface SpeciesTally {
  owned: number;
  /** Food units eaten by the owned members. */
  fed: number;
  /** Battles fought by the owned members. */
  battles: number;
  seen: boolean;
  /** Best research points ever reached (DexMemory.best). */
  best?: number;
}

export type DexState = "unseen" | "seen" | "owned" | "developed";

export interface Research {
  state: DexState;
  /** 0 (not owned) .. 5. */
  level: number;
  points: number;
  /** Points needed for the next level (null at level 5 or when not owned yet). */
  next: number | null;
  /** Progress 0..1 towards the next level (1 at level 5). */
  frac: number;
  /** What the next level unlocks (null at level 5). */
  unlockNext: string | null;
}

/** Points at which research levels 1..5 are reached (level 1 = owning one). */
export const RESEARCH_STEPS: readonly number[] = [10, 30, 90, 200, 400];
export const RESEARCH_UNLOCKS: readonly string[] = [
  "Card: body plan, size, identity",
  "Lore lines",
  "Stat ranges (height, mass, power, speed)",
  "Evolution path (stages + life phases)",
  "Mastery: hybrid recipes, signature axes, best foods",
];
const KIND_NAME: Record<BodyKind, string> = { quadruped: "Quadruped", biped: "Biped", hexapod: "Hexapod", serpent: "Serpent", avian: "Avian", blob: "Blob" };
const KIND_ICON: Record<BodyKind, string> = { quadruped: "🐾", biped: "🚶", hexapod: "🪲", serpent: "🐍", avian: "🪶", blob: "💧" };

export function speciesKey(kind: BodyKind, identity: string): string {
  return `${kind}:${identity}`;
}

const speciesCache = new WeakMap<Phenotype, Species>();

/** The species of a phenotype (cached per phenotype object: phenotypeOf caches those). */
export function speciesOf(ph: Phenotype): Species {
  let s = speciesCache.get(ph);
  if (s) return s;
  const id = identityOfPhenotype(ph);
  const hy = id.hybrid ? HYBRIDS.find((x) => x.id === id.id) ?? null : null;
  s = { key: speciesKey(ph.kind, id.id), kind: ph.kind, identity: id.id, name: `${id.name} ${KIND_NAME[ph.kind]}`, color: id.color, hybrid: id.hybrid, parents: hy ? [hy.a, hy.b] : null };
  speciesCache.set(ph, s);
  return s;
}

let allCache: Species[] | null = null;
/** Every species the Dex can hold: body plans x (elements, then hybrids). */
export function allSpecies(): Species[] {
  if (allCache) return allCache;
  const out: Species[] = [];
  for (const kind of BODY_KINDS) {
    for (const e of ELEMENT_IDS) out.push({ key: speciesKey(kind, e), kind, identity: e, name: `${ELEMENTS[e].name} ${KIND_NAME[kind]}`, color: ELEMENTS[e].color, hybrid: false, parents: null });
    for (const hy of HYBRIDS) out.push({ key: speciesKey(kind, hy.id), kind, identity: hy.id, name: `${hy.name} ${KIND_NAME[kind]}`, color: hy.color, hybrid: true, parents: [hy.a, hy.b] });
  }
  return (allCache = out);
}

export function researchPoints(t: SpeciesTally): number {
  return Math.min(5, t.owned) * 10 + Math.min(200, t.fed) + Math.min(100, t.battles) * 4;
}

/** State, level and progress of one species. Research only counts once a member was owned. */
export function researchOf(t: SpeciesTally): Research {
  const now = researchPoints(t);
  const points = Math.max(now, t.best ?? 0);
  const everOwned = t.owned > 0 || (t.best ?? 0) >= RESEARCH_STEPS[0];
  if (!everOwned) {
    return { state: t.seen ? "seen" : "unseen", level: 0, points: 0, next: RESEARCH_STEPS[0], frac: 0, unlockNext: RESEARCH_UNLOCKS[0] };
  }
  let level = 0;
  while (level < RESEARCH_STEPS.length && points >= RESEARCH_STEPS[level]) level++;
  level = Math.max(1, level);
  if (level >= 5) return { state: "developed", level: 5, points, next: null, frac: 1, unlockNext: null };
  const lo = RESEARCH_STEPS[level - 1], hi = RESEARCH_STEPS[level];
  return { state: level >= 2 ? "developed" : "owned", level, points, next: hi, frac: Math.max(0, Math.min(1, (points - lo) / (hi - lo))), unlockNext: RESEARCH_UNLOCKS[level] };
}

/** Tally the collection per species (owned count, food units, battles), merged with the Dex memory. */
export function tallySpecies(collection: readonly Genemon[], mem?: DexMemory): Map<string, SpeciesTally & { members: Genemon[] }> {
  const out = new Map<string, SpeciesTally & { members: Genemon[] }>();
  const get = (k: string) => {
    let t = out.get(k);
    if (!t) out.set(k, t = { owned: 0, fed: 0, battles: 0, seen: false, members: [] });
    return t;
  };
  for (const g of collection) {
    const t = get(speciesOf(phenotypeOf(g)).key);
    t.owned++;
    t.seen = true;
    t.members.push(g);
    t.fed += Object.values(g.conditions.diet).reduce<number>((s, v) => s + (v ?? 0), 0);
    const b = g.conditions.battles;
    t.battles += b.won + b.lost + b.draws;
  }
  if (mem) {
    for (const k of Object.keys(mem.seen)) get(k).seen = true;
    for (const [k, v] of Object.entries(mem.best)) get(k).best = v;
  }
  return out;
}

/** Record species as seen (first time only). Returns how many were new. */
export function noteSeen(mem: DexMemory, keys: Iterable<string>, now: number): number {
  let n = 0;
  for (const k of keys) {
    if (mem.seen[k] === undefined) {
      mem.seen[k] = now;
      n++;
    }
  }
  return n;
}

/** Raise the remembered best research points from a tally (never lowers them). */
export function rememberBest(mem: DexMemory, tally: Map<string, SpeciesTally>): void {
  for (const [k, t] of tally) {
    const p = researchPoints(t);
    if (t.owned > 0 && p > (mem.best[k] ?? 0)) mem.best[k] = p;
  }
}

export function dexMemoryOf(p: Profile): DexMemory {
  const q = p as DexProfile;
  q.dexP5 ??= { seen: {}, best: {} };
  q.dexP5.seen ??= {};
  q.dexP5.best ??= {};
  return q.dexP5;
}

/** Foods whose nudges point along an identity's signature (best first, positive only). */
export function bestFoodsFor(signature: Partial<Record<AxisId, number>>, n = 3): string[] {
  return FOOD_IDS.map((f) => ({ f, s: Object.entries(FOODS[f].nudge).reduce((acc, [ax, v]) => acc + (v ?? 0) * (signature[ax as AxisId] ?? 0), 0) }))
    .filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, n).map((x) => FOODS[x.f].name);
}

function signatureOf(sp: Species): Partial<Record<AxisId, number>> {
  if (!sp.parents) return ELEMENTS[sp.identity as ElementId]?.signature ?? {};
  const out: Partial<Record<AxisId, number>> = {};
  for (const e of sp.parents) for (const [ax, v] of Object.entries(ELEMENTS[e].signature) as [AxisId, number][]) out[ax] = (out[ax] ?? 0) + v / 2;
  return out;
}

const KIND_LORE: Record<BodyKind, string> = {
  quadruped: "Four-legged and sure-footed: it trots long distances and braces hard against shoves.",
  biped: "Upright on two legs, hands free: it reads a fight at eye level and reaches far.",
  hexapod: "Six legs in a tripod gait: never off balance, quick to scuttle sideways.",
  serpent: "A legless body that slithers in waves and rears up to strike from above.",
  avian: "Light bones and wings: it hops on the ground and takes to the air when it must.",
  blob: "No fixed shape: it paddles, squashes and flows around what it cannot push.",
};

function loreOf(sp: Species): string[] {
  const note = sp.parents ? HYBRIDS.find((x) => x.id === sp.identity)?.note ?? "" : ELEMENTS[sp.identity as ElementId]?.note ?? "";
  const lines = [KIND_LORE[sp.kind], note];
  if (sp.parents) lines.push(`Born where ${ELEMENTS[sp.parents[0]].name} and ${ELEMENTS[sp.parents[1]].name} meet in one body.`);
  return lines.filter(Boolean);
}

function rangeOf(gs: readonly Genemon[]): HTMLElement {
  if (!gs.length) return h("p", { class: "muted" }, "No specimen measured yet.");
  const ph = gs.map((g) => phenotypeOf(g));
  const r = (f: (p: Phenotype) => number, d: number, unit: string) => {
    const v = ph.map(f), lo = Math.min(...v), hi = Math.max(...v);
    return lo === hi ? `${fmt(lo, d)}${unit}` : `${fmt(lo, d)}-${fmt(hi, d)}${unit}`;
  };
  return h("dl", { class: "kv" },
    h("dt", {}, "Height"), h("dd", {}, r((p) => p.heightM, 2, " m")),
    h("dt", {}, "Mass"), h("dd", {}, r((p) => p.massKg, 1, " kg")),
    h("dt", {}, "Power"), h("dd", {}, r((p) => p.power, 0, "")),
    h("dt", {}, "Speed"), h("dd", {}, r((p) => p.stats.spd, 1, " m/s")),
    h("dt", {}, "Sizes"), h("dd", {}, [...new Set(ph.map((p) => p.sizeClass))].join(" · ")),
    h("dt", {}, "Specimens"), h("dd", {}, `${gs.length} measured (yours + wild)`));
}

function evolutionOf(): HTMLElement {
  return h("div", {},
    h("ol", { class: "hd5-evo" },
      h("li", {}, h("b", {}, "Hatchling"), " · growth < 35 %"),
      h("li", {}, h("b", {}, "Juvenile"), " · growth ≥ 35 %"),
      h("li", {}, h("b", {}, "Adult"), " · growth ≥ 70 % and level ≥ 16"),
      h("li", {}, h("b", {}, "Ascended"), " · level ≥ 40, bond ≥ 60 %, 25 wins")),
    h("p", { class: "muted" }, `Life phases: ${LIFE_PHASES.join(" → ")}. Elders past their prime can no longer rank.`));
}

function masteryOf(sp: Species): HTMLElement {
  const sig = signatureOf(sp);
  const axes = (Object.entries(sig) as [AxisId, number][]).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 4)
    .map(([ax, v]) => `${v > 0 ? AXIS_BY_ID[ax].pos : AXIS_BY_ID[ax].neg} (${ax} ${v > 0 ? "+" : ""}${v.toFixed(2)})`);
  const recipes = sp.parents
    ? [`${ELEMENTS[sp.parents[0]].name} + ${ELEMENTS[sp.parents[1]].name}`]
    : HYBRIDS.filter((x) => x.a === sp.identity || x.b === sp.identity).slice(0, 6).map((x) => `${x.name} = ${ELEMENTS[x.a].name} + ${ELEMENTS[x.b].name}`);
  const foods = bestFoodsFor(sig);
  return h("dl", { class: "kv" },
    h("dt", {}, "Signature"), h("dd", {}, axes.length ? axes.join(", ") : "none (baseline matter)"),
    h("dt", {}, sp.parents ? "Recipe" : "Hybrids"), h("dd", {}, recipes.length ? recipes.join(" · ") : "none"),
    h("dt", {}, "Best foods"), h("dd", {}, foods.length ? foods.join(", ") : "any balanced diet"));
}

type DexFilter = "known" | "all" | DexState;
let dexFilter: DexFilter = "known";
let dexKind: BodyKind | "all" = "all";
let dexIdent: "all" | "elements" | "hybrids" | ElementId = "all";
let dexQuery = "";
let dexSel: string | null = null;
const DEX_CAP = 160;

function stars(level: number): string {
  return "★".repeat(level) + "☆".repeat(5 - level);
}

function speciesDetail(app: App, sp: Species, t: (SpeciesTally & { members: Genemon[] }) | undefined, r: Research): HTMLElement {
  const wild = app.wildPool().filter((g) => speciesOf(phenotypeOf(g)).key === sp.key);
  const block = (lv: number, body: () => HTMLElement | HTMLElement[]) => {
    const open = r.level >= lv;
    return h("div", { class: `hd5-unlock ${open ? "open" : "locked"}`, "data-level": lv },
      h("div", { class: "hd5-unlock-head" }, `${open ? "✓" : "🔒"} Level ${lv} · ${RESEARCH_UNLOCKS[lv - 1]}`),
      ...(open ? [body()].flat() : [h("p", { class: "muted" }, `Reach ${RESEARCH_STEPS[lv - 1]} research points.`)]));
  };
  const members = t?.members ?? [];
  return h("div", { class: `hd5-sp-detail state-${r.state}`, "data-species": sp.key, vars: { sp: hex(sp.color) } },
    h("div", { class: "dex-drawer-head" },
      h("span", { class: "dex-name" }, r.state === "unseen" ? `??? ${KIND_NAME[sp.kind]}` : sp.name),
      h("span", { class: `hd5-state ${r.state}` }, r.state),
      h("button", { class: "btn small", title: "Close", onclick: () => {
        dexSel = null;
        app.render();
      } }, "✕")),
    h("div", { class: "row" }, h("span", { class: "hd5-stars", title: `research level ${r.level}/5` }, stars(r.level)), h("span", { class: "muted mono" }, `${r.points} pts`)),
    h("div", { class: "hd5-progress" }, bar(r.frac, hex(sp.color))),
    h("p", { class: "muted" }, r.next !== null
      ? `Next: ${r.unlockNext} at ${r.next} pts. Own (+10 each, max 5), feed (+1 per unit) and battle (+4 each) with ${sp.name}s.`
      : "Fully developed."),
    t && t.owned ? h("p", { class: "muted" }, `Owned ${t.owned} (+${Math.min(5, t.owned) * 10}) · food ${fmt(t.fed)} (+${Math.min(200, Math.round(t.fed))}) · battles ${t.battles} (+${Math.min(100, t.battles) * 4})`) : null,
    block(1, () => h("dl", { class: "kv" },
      h("dt", {}, "Body plan"), h("dd", {}, `${KIND_ICON[sp.kind]} ${KIND_NAME[sp.kind]}`),
      h("dt", {}, "Identity"), h("dd", {}, sp.parents ? `hybrid of ${ELEMENTS[sp.parents[0]].name} + ${ELEMENTS[sp.parents[1]].name}` : ELEMENTS[sp.identity as ElementId]?.name ?? sp.identity))),
    block(2, () => loreOf(sp).map((l) => h("p", { class: "hd5-lore" }, l))),
    block(3, () => rangeOf([...members, ...wild])),
    block(4, () => evolutionOf()),
    block(5, () => masteryOf(sp)),
    members.length ? h("div", { class: "row" }, h("span", { class: "muted" }, "Yours:"), ...members.map((g) => h("button", { class: "btn small", onclick: () => {
      tab = "genemon";
      drawer = g.id;
      app.select(g.id);
    } }, g.name))) : null);
}

function dexTab(app: App): HTMLElement {
  const p = app.profile;
  const mem = dexMemoryOf(p);
  const tally = tallySpecies(p.collection, mem);
  rememberBest(mem, tally);
  const all = allSpecies();
  const rows = all.map((sp) => ({ sp, t: tally.get(sp.key), r: researchOf(tally.get(sp.key) ?? { owned: 0, fed: 0, battles: 0, seen: false }) }));
  const count: Record<DexState, number> = { unseen: 0, seen: 0, owned: 0, developed: 0 };
  for (const x of rows) count[x.r.state]++;
  const q = dexQuery.trim().toLowerCase();
  const order: Record<DexState, number> = { developed: 0, owned: 1, seen: 2, unseen: 3 };
  const list = rows.filter(({ sp, r }) => {
    if (dexFilter === "known" ? r.state === "unseen" : dexFilter !== "all" && r.state !== dexFilter) return false;
    if (dexKind !== "all" && sp.kind !== dexKind) return false;
    if (dexIdent === "elements" && sp.hybrid) return false;
    if (dexIdent === "hybrids" && !sp.hybrid) return false;
    if (dexIdent !== "all" && dexIdent !== "elements" && dexIdent !== "hybrids" && sp.identity !== dexIdent && !sp.parents?.includes(dexIdent)) return false;
    if (q && (r.state === "unseen" || !`${sp.name} ${sp.identity} ${sp.kind}`.toLowerCase().includes(q))) return false;
    return true;
  }).sort((a, b) => order[a.r.state] - order[b.r.state] || b.r.points - a.r.points || a.sp.name.localeCompare(b.sp.name));
  const known = all.length - count.unseen;
  const sel = dexSel ? rows.find((x) => x.sp.key === dexSel) : undefined;
  const card = ({ sp, r }: typeof rows[number]) =>
    h("button", { class: `hd5-sp state-${r.state} ${dexSel === sp.key ? "sel" : ""}`, "data-species": sp.key, vars: { sp: hex(sp.color) }, title: r.state === "unseen" ? "Not met yet" : `${sp.name} · ${r.state} · research ${r.level}/5`, onclick: () => {
      dexSel = dexSel === sp.key ? null : sp.key;
      app.render();
    } },
      h("span", { class: "hd5-sp-band" }),
      h("span", { class: "hd5-sp-name" }, r.state === "unseen" ? "???" : sp.name),
      h("span", { class: "muted" }, `${KIND_ICON[sp.kind]} ${KIND_NAME[sp.kind]}${r.state === "unseen" ? "" : sp.hybrid ? " · hybrid" : ""}`),
      h("span", { class: "row" }, h("span", { class: `hd5-state ${r.state}` }, r.state), h("span", { class: "hd5-stars" }, stars(r.level))),
      r.state === "unseen" ? null : bar(r.frac, hex(sp.color)),
      r.state === "unseen" ? null : h("span", { class: "muted hd5-next" }, r.unlockNext ? `next: ${r.unlockNext.split(" (")[0].split(":")[0]} · ${r.points}/${r.next}` : "fully developed"));
  const shown = list.slice(0, DEX_CAP);
  const kindOpts: { value: BodyKind | "all"; label: string }[] = [{ value: "all", label: "All bodies" }, ...BODY_KINDS.map((k) => ({ value: k, label: KIND_NAME[k] }))];
  const identOpts: { value: typeof dexIdent; label: string }[] = [{ value: "all", label: "All identities" }, { value: "elements", label: "Pure elements" }, { value: "hybrids", label: "Hybrids" }, ...ELEMENT_IDS.map((e) => ({ value: e, label: ELEMENTS[e].name }))];
  const stateOpts: { value: DexFilter; label: string }[] = [
    { value: "known", label: `Met (${known})` },
    { value: "all", label: `All (${all.length})` },
    { value: "developed", label: `Developed (${count.developed})` },
    { value: "owned", label: `Owned (${count.owned})` },
    { value: "seen", label: `Seen (${count.seen})` },
    { value: "unseen", label: `Unseen (${count.unseen})` },
  ];
  // The pre-pass-5 view (individual genomes seen / owned) is kept below the species Dex.
  const owned = new Map<string, Genemon>();
  for (const g of p.collection) if (!owned.has(g.genome.id)) owned.set(g.genome.id, g);
  const seenG = [...new Set([...p.pokedex, ...owned.keys()])];
  const indiv = seenG.map((gid, i) => {
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
    return h("div", { class: "gcard dex-unknown", title: `Seen, not owned · ${gid}` }, h("span", { class: "dex-q" }, "?"), h("span", { class: "name" }, "Unknown"), h("span", { class: "muted mono" }, `#${String(i + 1).padStart(3, "0")} · seen`));
  });
  return h("div", {},
    section(`Dex · ${known}/${all.length} species met`,
      h("div", { class: "hd5-dex-sum" },
        ...(["developed", "owned", "seen", "unseen"] as DexState[]).map((s) => h("button", { class: `hd5-state ${s} ${dexFilter === s ? "on" : ""}`, "data-filter": s, onclick: () => {
          dexFilter = dexFilter === s ? "known" : s;
          app.render();
        } }, `${s} ${count[s]}`))),
      h("div", { class: "dex-progress" }, bar(known / all.length, "#3ddc84")),
      h("p", { class: "muted" }, "A species = body plan × element (or hybrid). Meet one in battle to SEE it; own one to start its research; feed and battle with it to DEVELOP it (levels 2-5 unlock lore, stat ranges, the evolution path and mastery)."),
      h("div", { class: "dex-tools" },
        h("input", { class: "dex-search", type: "search", placeholder: "Search species…", value: dexQuery, "aria-label": "Search species", onchange: (e: Event) => {
          dexQuery = (e.target as HTMLInputElement).value;
          app.render();
        } }),
        h("label", { class: "field" }, "Show", select<DexFilter>(stateOpts, dexFilter, (v) => {
          dexFilter = v;
          app.render();
        })),
        h("label", { class: "field" }, "Body", select<BodyKind | "all">(kindOpts, dexKind, (v) => {
          dexKind = v;
          app.render();
        })),
        h("label", { class: "field" }, "Identity", select<typeof dexIdent>(identOpts, dexIdent, (v) => {
          dexIdent = v;
          app.render();
        })))),
    sel ? speciesDetail(app, sel.sp, sel.t, sel.r) : null,
    h("div", { class: "hd5-sp-grid" }, ...shown.map(card)),
    list.length > shown.length ? h("p", { class: "muted" }, `…and ${list.length - shown.length} more: narrow the filters.`) : null,
    list.length ? null : h("p", { class: "muted" }, dexFilter === "known" ? "Nothing met yet with these filters." : "No species match these filters."),
    h("details", { class: "section hd5-indiv" },
      h("summary", {}, `Individuals · ${seenG.length} genomes seen · ${owned.size} owned`),
      h("div", { class: "cards dex-grid" }, ...indiv)));
}

// ---------------------------------------------------------------- screen

/** Open the Collection screen on its Dex tab (the Home main menu's "Dex" button). */
export function openDex(app: App): void {
  tab = "dex";
  app.go("dex");
}

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
