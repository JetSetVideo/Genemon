/**
 * DRAG-TO-FEED [P5-U2]. In the Lab the right panel shows the BAG (plus the free pantry of staple foods)
 * as a grid of item icons. Drag one (mouse, pen or touch: pointer events with capture) onto the main 3D
 * view to use it on the selected Genemon: food -> feed (bag foods through feedFromBag, staples free),
 * gear -> equipGear, cosmetic -> wear. While dragging a ghost icon follows the pointer and the viewport
 * lights up as a drop zone. After the drop a popup near the drop point lists what changed, computed by
 * DIFFING the phenotype before / after (stats, level, top axis shifts, element drift, hunger, bond);
 * the panel keeps a "recent effects" list. Tap a tile (or Enter) for a "Use" button: no drag needed.
 *
 * The animation lane's `labView.feedReaction(color, kind)` and `labView.hitTest(x, y)` are called when
 * present (duck-typed), so this file works before and after that lane lands.
 */
import type { App } from "./app.ts";
import { AXIS_BY_ID, type AxisId } from "../data/axes.ts";
import { ELEMENTS } from "../data/elements.ts";
import { FOOD_IDS, type FoodId, FOODS } from "../data/lifestyle.ts";
import { feedLife, type Genemon, type LifeCtx, phenotypeOf } from "../genome/genemon.ts";
import type { Phenotype } from "../genome/phenotype.ts";
import { foodItemId, type ItemKind, ITEMS } from "../economy/items.ts";
import { bagOf, cosmeticsOf, equipGear, feedFromBagLife, gearOf, wear } from "./bagStore.ts";
import { fullnessOf } from "../genome/digestion.ts";
import { h, toast } from "./dom.ts";
import { iconChip, iconSpec, itemIcon } from "./icons.ts";

// ------------------------------------------------------------------ pure: before/after diff
export interface FeedSnap {
  level: number;
  power: number;
  stats: { hp: number; atk: number; def: number; spd: number };
  hunger: number;
  bond: number;
  axes: Record<string, number>;
  affinity: Record<string, number>;
  primary: string;
  secondary: string | null;
  heightM: number;
}

export function feedSnap(ph: Phenotype, cond: { hunger: number; bond: number }): FeedSnap {
  return {
    level: ph.level,
    power: ph.power,
    stats: { hp: ph.stats.hp, atk: ph.stats.atk, def: ph.stats.def, spd: ph.stats.spd },
    hunger: cond.hunger,
    bond: cond.bond,
    axes: { ...ph.axes },
    affinity: { ...ph.elements.affinity },
    primary: ph.elements.primary,
    secondary: ph.elements.secondary,
    heightM: ph.heightM,
  };
}

export interface EffectLine {
  key: string;
  text: string;
  delta: number;
  /** true = good for the player, false = bad, null = neutral (axis shifts). */
  good: boolean | null;
}

const signed = (v: number, d: number) => `${v > 0 ? "+" : v < 0 ? "−" : "±"}${Math.abs(v).toFixed(d)}`;

/** What changed between two snapshots, most important first. Tiny float noise is ignored. */
export function effectDeltas(a: FeedSnap, b: FeedSnap, maxAxes = 3): EffectLine[] {
  const out: EffectLine[] = [];
  if (b.level !== a.level) out.push({ key: "level", text: `Level ${a.level} → ${b.level}`, delta: b.level - a.level, good: b.level > a.level });
  if (b.primary !== a.primary || b.secondary !== a.secondary) {
    const name = (e: string | null) => (e ? ELEMENTS[e as keyof typeof ELEMENTS]?.name ?? e : "none");
    out.push({ key: "element", text: `Element ${name(a.primary)}${a.secondary ? "/" + name(a.secondary) : ""} → ${name(b.primary)}${b.secondary ? "/" + name(b.secondary) : ""}`, delta: 1, good: null });
  }
  const stat = (key: keyof FeedSnap["stats"], label: string, d: number) => {
    const v = b.stats[key] - a.stats[key];
    if (Math.abs(v) >= 0.5 * 10 ** -d) out.push({ key, text: `${label} ${signed(v, d)}`, delta: v, good: v > 0 });
  };
  stat("hp", "HP", 1);
  stat("atk", "Attack", 1);
  stat("def", "Defence", 1);
  stat("spd", "Speed", 2);
  const pw = b.power - a.power;
  if (Math.abs(pw) >= 0.05) out.push({ key: "power", text: `Power ${signed(pw, 1)}`, delta: pw, good: pw > 0 });
  const hg = b.hunger - a.hunger;
  if (Math.abs(hg) >= 0.0005) out.push({ key: "hunger", text: `Hunger ${signed(hg, 3)}${b.hunger <= 0 ? " (full)" : ""}`, delta: hg, good: hg < 0 });
  const bd = b.bond - a.bond;
  if (Math.abs(bd) >= 0.0005) out.push({ key: "bond", text: `Bond ${signed(bd, 3)}`, delta: bd, good: bd > 0 });
  const ht = b.heightM - a.heightM;
  if (Math.abs(ht) >= 0.0005) out.push({ key: "height", text: `Height ${signed(ht * 100, 1)} cm`, delta: ht, good: null });
  const axes = Object.keys(b.axes)
    .map((k) => ({ k, d: (b.axes[k] ?? 0) - (a.axes[k] ?? 0) }))
    .filter((x) => Math.abs(x.d) >= 0.0005)
    .sort((x, y) => Math.abs(y.d) - Math.abs(x.d))
    .slice(0, maxAxes);
  for (const { k, d } of axes) {
    const ax = AXIS_BY_ID[k as AxisId];
    const pole = ax ? (d > 0 ? ax.pos : ax.neg) : "";
    out.push({ key: `axis.${k}`, text: `${k} ${signed(d, 3)}${pole ? ` → ${pole}` : ""}`, delta: d, good: null });
  }
  const drift = Object.keys(b.affinity)
    .filter((k) => k !== "neutral")
    .map((k) => ({ k, d: (b.affinity[k] ?? 0) - (a.affinity[k] ?? 0) }))
    .sort((x, y) => Math.abs(y.d) - Math.abs(x.d))[0];
  if (drift && Math.abs(drift.d) >= 0.0005) {
    const name = ELEMENTS[drift.k as keyof typeof ELEMENTS]?.name ?? drift.k;
    out.push({ key: "drift", text: `${name} affinity ${signed(drift.d, 3)}`, delta: drift.d, good: null });
  }
  return out;
}

/** Staple foods (price < 12) are free in the Lab pantry; strong elemental foods come from the bag. */
export function isStaple(food: FoodId): boolean {
  return FOODS[food].price < 12;
}

/** Can this item be used by dropping it on the Genemon? */
export function usableKind(kind: ItemKind | "unknown"): boolean {
  return kind === "food" || kind === "gear" || kind === "cosmetic";
}

// ------------------------------------------------------------------ actions
export function labCtx(app: App): LifeCtx {
  return { ledger: app.ledger, when: Date.now(), hour: app.hourNow(), who: app.profile.id, where: { x: 0, y: 0, z: 0, zone: "lab", space: "lab" } };
}

interface Recent {
  gid: string;
  at: number;
  itemId: string;
  title: string;
  lines: EffectLine[];
}
const recent: Recent[] = [];
const RECENT_MAX = 12;

export function recentEffects(gid: string): readonly Recent[] {
  return recent.filter((r) => r.gid === gid);
}

type Source = "pantry" | "bag";

interface LabViewHooks {
  feedReaction?: (color: number, kind: string) => void;
  hitTest?: (x: number, y: number) => boolean;
  setGenemon(g: Genemon): void;
}

function hooks(app: App): LabViewHooks | null {
  return (app.labView as unknown as LabViewHooks | null) ?? null;
}

/**
 * Use one item on the Genemon. Returns the effect lines, or null when refused (toast explains).
 * `at` = drop point in client px (popup placement); without it the popup sits mid-viewport.
 */
export function useItem(app: App, g: Genemon, itemId: string, source: Source, at?: { x: number; y: number }): EffectLine[] | null {
  const def = ITEMS[itemId];
  if (!def || !usableKind(def.kind)) {
    toast(`${def?.name ?? itemId} cannot be used in the Lab.`);
    return null;
  }
  const p = app.profile;
  const ph0 = phenotypeOf(g);
  const before = feedSnap(ph0, g.conditions);
  const stage0 = g.stage;
  let lines: EffectLine[] = [];
  let verb = "";
  if (def.kind === "food") {
    const food = def.effects.food as FoodId;
    // Pass 5 [P5-G3]: the meal goes into the stomach and is digested over hours by the life loop; the
    // popup shows what it WILL do (diet efficiency x nutrients) and how full the stomach is.
    const ignoreCapacity = p.settings.dev?.noFoodLimit === true;
    const now = Date.now();
    const r = source === "pantry" && isStaple(food)
      ? feedLife(g, food, 1, now, { ...labCtx(app), ignoreCapacity, why: "fed in the lab (dragged from the pantry)" })
      : feedFromBagLife(p, g, food, 1, now, { ...labCtx(app), ignoreCapacity, why: "fed from the bag (dragged)" });
    if (!r) {
      toast(`No ${def.name} left in the bag.`);
      return null;
    }
    if (!r.ok) {
      toast(`${g.name} refuses: ${r.why}. (Settings › Test demo › No food limit lets you overfeed.)`, 4200);
      return null;
    }
    verb = `ate ${def.name}`;
    const life = g.life;
    if (life) {
      const full = fullnessOf(life.digestion), cap = life.digestion.capacity;
      lines.push({ key: "stomach", text: `Stomach ${full.toFixed(1)} / ${cap.toFixed(1)}${full > cap ? " · overfed!" : ""} · diet ${life.digestion.diet} ×${r.efficiency.toFixed(2)}`, delta: full, good: full <= cap });
    }
    for (const x of r.preview) lines.push({ key: `dig.${x.label}`, text: `digesting → ${x.label} ${x.delta >= 0 ? "+" : ""}${x.delta.toFixed(3)}`, delta: x.delta, good: null });
  } else if (def.kind === "gear") {
    const prev = gearOf(p, g.id)?.itemId;
    if (!equipGear(p, g.id, itemId)) {
      toast(`No ${def.name} in the bag.`);
      return null;
    }
    app.log("ui.bag.equip", "gear given from the bag (drag and drop)", g.id, `${itemId}${prev ? ` replaces ${prev}` : ""}`);
    verb = `holds ${def.name}`;
    lines.push({ key: "gear", text: def.note, delta: 1, good: true });
    if (prev) lines.push({ key: "gear.prev", text: `${ITEMS[prev]?.name ?? prev} back in the bag`, delta: 0, good: null });
  } else {
    const slot = String(def.effects.slot ?? "body");
    const prev = cosmeticsOf(p, g.id)[slot];
    if (!wear(p, g.id, itemId)) {
      toast(`No ${def.name} in the bag.`);
      return null;
    }
    app.log("ui.bag.wear", "cosmetic worn from the bag (drag and drop)", g.id, `${itemId} in ${slot}`);
    verb = `wears ${def.name}`;
    lines.push({ key: "cosmetic", text: `Worn in the ${slot} slot (visual only)`, delta: 1, good: true });
    if (prev) lines.push({ key: "cosmetic.prev", text: `${ITEMS[prev]?.name ?? prev} back in the bag`, delta: 0, good: null });
  }
  const ph1 = phenotypeOf(g);
  lines = [...effectDeltas(before, feedSnap(ph1, g.conditions)), ...lines];
  if (g.stage !== stage0) lines.unshift({ key: "stage", text: `Evolved: stage ${stage0} → ${g.stage}`, delta: 1, good: true });
  if (lines.length === 0) lines.push({ key: "none", text: "No visible change yet: effects build up over many meals.", delta: 0, good: null });
  app.save();
  const lv = hooks(app);
  const visual = g.stage !== stage0 || ph1.level !== ph0.level || ph1.elements.primary !== ph0.elements.primary || ph1.sizeClass !== ph0.sizeClass || def.kind === "cosmetic";
  if (visual) lv?.setGenemon(g);
  const spec = iconSpec(itemId);
  if (typeof lv?.feedReaction === "function") {
    try {
      lv.feedReaction(parseInt(spec.main.slice(1), 16), def.kind);
    } catch (e) {
      console.warn("feedReaction failed", e);
    }
  }
  const title = `${g.name} ${verb}`;
  recent.unshift({ gid: g.id, at: Date.now(), itemId, title, lines });
  recent.length = Math.min(recent.length, RECENT_MAX);
  showPopup(itemId, title, lines, at);
  return lines;
}

// ------------------------------------------------------------------ popup over the 3D view
function effectList(lines: readonly EffectLine[], max = 8): HTMLElement {
  return h("ul", { class: "ui5-fx" }, ...lines.slice(0, max).map((l) =>
    h("li", { class: l.good === true ? "up" : l.good === false ? "down" : "" }, l.text)));
}

export function showPopup(itemId: string, title: string, lines: readonly EffectLine[], at?: { x: number; y: number }): HTMLElement | null {
  const vp = document.getElementById("viewport");
  if (!vp) return null;
  const r = vp.getBoundingClientRect();
  // Top-left of the 3D view, beside the drop: the creature (centred) stays visible while it eats.
  const dropX = at ? at.x - r.left : r.width / 2;
  const x = dropX > r.width * 0.42 ? 16 : Math.max(16, r.width - 266);
  const y = Math.max(16, Math.min(r.height - 220, 56));
  const pop = h("div", { class: "ui5-pop", role: "status", vars: { x: `${x.toFixed(0)}px`, y: `${y.toFixed(0)}px` } },
    h("div", { class: "ui5-pop-head" }, itemIcon(itemId, 28), h("b", {}, title)),
    effectList(lines));
  vp.append(pop);
  setTimeout(() => pop.classList.add("out"), 4200);
  setTimeout(() => pop.remove(), 4800);
  return pop;
}

// ------------------------------------------------------------------ the bag dock (right panel)
let picked: { itemId: string; source: Source } | null = null;
let dockOpen = true;

interface Tile {
  itemId: string;
  source: Source;
  qty: number | null;
}

function tilesOf(app: App): Tile[] {
  const bag = bagOf(app.profile);
  const pantry: Tile[] = FOOD_IDS.filter(isStaple).map((f) => ({ itemId: foodItemId(f), source: "pantry" as const, qty: null }));
  const rank: Record<string, number> = { food: 0, gear: 1, cosmetic: 2 };
  const owned: Tile[] = Object.entries(bag)
    .filter(([id, n]) => n > 0 && ITEMS[id])
    .sort(([a], [b]) => (rank[ITEMS[a].kind] ?? 9) - (rank[ITEMS[b].kind] ?? 9) || ITEMS[a].name.localeCompare(ITEMS[b].name))
    .map(([id, n]) => ({ itemId: id, source: "bag" as const, qty: n }));
  return [...owned, ...pantry];
}

/** The bag panel for the Lab: draggable tiles, a tap-to-use detail, and the recent effects of `g`. */
export function bagDock(app: App, g: Genemon): HTMLElement {
  const tiles = tilesOf(app);
  if (picked && !tiles.some((t) => t.itemId === picked!.itemId && t.source === picked!.source)) picked = null;
  const grid = h("div", { class: "ui5-baggrid", role: "list" },
    ...tiles.map((t) => tileEl(app, g, t)));
  const def = picked ? ITEMS[picked.itemId] : null;
  const detail = picked && def
    ? h("div", { class: "ui5-pick" }, itemIcon(picked.itemId, 36),
      h("div", { class: "ui5-pick-txt" }, h("b", {}, def.name), h("span", { class: "muted" }, `${def.kind} · ${def.rarity}${picked.source === "pantry" ? " · free pantry" : ""} — ${def.note}`)),
      usableKind(def.kind)
        ? h("button", { class: "btn small primary", "data-use": picked.itemId, onclick: () => {
          const pk = picked!;
          if (useItem(app, g, pk.itemId, pk.source)) app.render();
        } }, def.kind === "food" ? `Feed ${g.name}` : def.kind === "gear" ? "Give" : "Wear")
        : h("span", { class: "muted" }, "Not usable in the Lab"))
    : null;
  const rec = recentEffects(g.id);
  const summary = h("summary", {}, itemIcon("food.berries", 20), `Bag · drag onto ${g.name}`, h("span", { class: "muted" }, ` ${tiles.filter((t) => t.source === "bag").length} kinds`));
  const root = h("details", { class: "glass ui5-bag", open: dockOpen, ontoggle: (e: Event) => (dockOpen = (e.target as HTMLDetailsElement).open) },
    summary,
    h("div", { class: "body" },
      h("p", { class: "muted" }, "Drag an object onto the 3D view to use it: food feeds, gear is held, cosmetics are worn. Staple foods (∞) are free; tap a tile for details."),
      grid,
      detail,
      rec.length
        ? h("div", { class: "ui5-recent" }, h("h3", {}, "Recent effects"),
          ...rec.slice(0, 4).map((r) => h("div", { class: "ui5-recent-row" }, itemIcon(r.itemId, 22), h("div", {}, h("b", {}, r.title), h("span", { class: "muted" }, ` · ${new Date(r.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`), effectList(r.lines, 5)))))
        : null));
  return root;
}

function tileEl(app: App, g: Genemon, t: Tile): HTMLElement {
  const def = ITEMS[t.itemId];
  const ok = usableKind(def.kind);
  const sel = picked?.itemId === t.itemId && picked.source === t.source;
  const el = h("button", {
    class: `ui5-tile ${ok ? "" : "off"} ${sel ? "sel" : ""} ${t.source === "pantry" ? "pantry" : ""}`,
    role: "listitem",
    title: `${def.name}${t.qty !== null ? ` ×${t.qty}` : " (free)"} — ${ok ? "drag onto the 3D view" : "not usable in the Lab"}`,
    "data-item": t.itemId,
    "data-source": t.source,
    "aria-label": `${def.name}${t.qty !== null ? `, ${t.qty} in the bag` : ", free"}`,
  }, iconChip(t.itemId, 34, t.qty ?? undefined), t.qty === null ? h("b", { class: "ui5-qty inf" }, "∞") : null);
  el.addEventListener("click", () => {
    picked = sel ? null : { itemId: t.itemId, source: t.source };
    app.render();
  });
  if (ok) el.addEventListener("pointerdown", (ev) => startDrag(app, g, t, el, ev));
  return el;
}

// ------------------------------------------------------------------ pointer drag
function startDrag(app: App, g: Genemon, t: Tile, tile: HTMLElement, ev: PointerEvent): void {
  if (ev.button !== 0 && ev.pointerType === "mouse") return;
  const x0 = ev.clientX, y0 = ev.clientY;
  let ghost: HTMLElement | null = null;
  const vp = document.getElementById("viewport");
  try {
    tile.setPointerCapture(ev.pointerId);
  } catch { /* synthetic events have no active pointer */ }
  const inside = (x: number, y: number): boolean => {
    if (!vp) return false;
    const r = vp.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  };
  const move = (e: PointerEvent) => {
    if (e.pointerId !== ev.pointerId) return;
    if (!ghost) {
      if (Math.hypot(e.clientX - x0, e.clientY - y0) < 6) return;
      ghost = h("div", { class: "ui5-ghost", "aria-hidden": "true" }, itemIcon(t.itemId, 48));
      document.body.append(ghost);
      vp?.classList.add("ui5-dropzone");
      tile.classList.add("dragging");
    }
    e.preventDefault();
    ghost.style.setProperty("--x", `${e.clientX}px`);
    ghost.style.setProperty("--y", `${e.clientY}px`);
    const over = inside(e.clientX, e.clientY);
    vp?.classList.toggle("ui5-drop-hot", over);
    const lv = hooks(app);
    let onBody = false;
    if (over && typeof lv?.hitTest === "function") {
      try {
        onBody = Boolean(lv.hitTest(e.clientX, e.clientY));
      } catch { /* the hook is optional */ }
    }
    vp?.classList.toggle("ui5-drop-body", onBody);
  };
  const end = (e: PointerEvent, cancelled: boolean) => {
    if (e.pointerId !== ev.pointerId) return;
    tile.removeEventListener("pointermove", move);
    tile.removeEventListener("pointerup", up);
    tile.removeEventListener("pointercancel", cancel);
    vp?.classList.remove("ui5-dropzone", "ui5-drop-hot", "ui5-drop-body");
    tile.classList.remove("dragging");
    if (!ghost) return; // a plain click: the click handler picks the tile
    ghost.remove();
    // Swallow the click that follows a drag so it does not also toggle the detail.
    tile.addEventListener("click", (c) => c.stopImmediatePropagation(), { capture: true, once: true });
    if (!cancelled && inside(e.clientX, e.clientY)) {
      if (useItem(app, g, t.itemId, t.source, { x: e.clientX, y: e.clientY })) app.render();
    }
  };
  const up = (e: PointerEvent) => end(e, false);
  const cancel = (e: PointerEvent) => end(e, true);
  tile.addEventListener("pointermove", move);
  tile.addEventListener("pointerup", up);
  tile.addEventListener("pointercancel", cancel);
}

/** Bag icon strip for other screens (read-only): icons with counts. */
export function bagStrip(app: App, max = 24): HTMLElement {
  const bag = bagOf(app.profile);
  const ids = Object.keys(bag).filter((id) => bag[id] > 0 && ITEMS[id]).slice(0, max);
  return h("div", { class: "ui5-baggrid" }, ...ids.map((id) => h("span", { class: "ui5-tile", title: ITEMS[id].name }, iconChip(id, 30, bag[id]))));
}
