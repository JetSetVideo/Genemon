/**
 * Readable move cards (P4-R3 "readable names and techniques", P4-M1/M5/M7): big name, element stripe +
 * chip, category icon, body part, Q/W/E/R slot badge, power / range / area, a 3-segment PHASE BAR whose
 * widths follow charge / active / rest seconds, effects in words, energy cost, and a locked state with
 * the reasons a Genemon cannot learn the move. DOM via h(); dynamic values only through CSS vars.
 */
import { ELEMENTS } from "../data/elements.ts";
import { type KitSlot, type Move, type MoveCategory, type MoveEffect, moveCost } from "../combat/moves.ts";
import { ALL_MOVE_BY_ID, slotOf } from "../combat/kit.ts";
import { h, hex } from "./dom.ts";
import { elChip } from "./widgets.ts";

export type SlotKey = "Q" | "W" | "E" | "R";
export const SLOT_KEYS: readonly SlotKey[] = ["Q", "W", "E", "R"];

export const KEY_OF_SLOT: Record<KitSlot, SlotKey | null> = { basic: "Q", control: "W", mobility: "E", ultimate: "R", utility: null };
export const SLOT_LABEL: Record<SlotKey, string> = { Q: "basic", W: "control", E: "mobility", R: "ultimate" };
export const CATEGORY_ICON: Record<MoveCategory, string> = { physical: "✊", special: "✦", status: "◎" };

const STATUS_WORD: Record<string, string> = {
  burn: "burn", wet: "soak", frozen: "freeze", paralyzed: "paralysis", poisoned: "poison", slowed: "slow", blinded: "blind",
  feared: "fear", confused: "confusion", staggered: "stagger", shielded: "shield", hasted: "haste", evasive: "evasion",
  focused: "focus", softened: "soften", airborne: "airborne", burrowed: "burrow", liquid: "liquid form", regen: "regeneration", stunned: "stun",
};

const STATUS_SHAPES = new Set(["buff", "heal", "weather", "terrain", "phase"]);

/** The move's category: its own field, else derived (no power / support shape = status, body contact = physical). */
export function categoryOf(m: Move): MoveCategory {
  if (m.category) return m.category;
  if (m.power <= 0 || STATUS_SHAPES.has(m.shape)) return "status";
  if (m.shape === "melee" || m.shape === "dash" || m.tags.includes("contact")) return "physical";
  return "special";
}

function num(v: number, d = 1): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(d).replace(/\.0+$/, "");
}

/** One effect in words: "40 % burn 3 s", "stun 1.2 s", "knockback 4", "heals 30 % HP". */
export function effectWords(e: MoveEffect): string {
  const self = e.self ? " (self)" : "";
  switch (e.kind) {
    case "status": {
      const chance = e.chance !== undefined && e.chance < 1 ? `${Math.round(e.chance * 100)} % ` : "";
      const dur = e.duration ? ` ${num(e.duration)} s` : "";
      return `${chance}${STATUS_WORD[e.status ?? ""] ?? e.status ?? "status"}${dur}${self}`;
    }
    case "knockback":
      return `knockback ${num(e.value ?? 0)}`;
    case "pull":
      return `pull ${num(e.value ?? 0)}`;
    case "heal":
      return `heals ${Math.round((e.value ?? 0) * 100)} % HP${e.self ? "" : " (ally)"}`;
    case "ground":
      return `turns the ground to ${e.ground ?? "?"}`;
    case "weather":
      return `calls ${e.weather ?? "weather"}${e.duration ? ` ${num(e.duration)} s` : ""}`;
  }
  return e.kind;
}

export function effectsText(m: Move): string {
  return m.effects.length ? m.effects.map(effectWords).join(" · ") : "no side effect";
}

function phaseBar(m: Move): HTMLElement {
  const total = Math.max(0.001, m.charge + m.active + m.rest);
  const seg = (cls: string, s: number, label: string) =>
    h("i", { class: `mcard-ph ${cls}`, vars: { f: Math.max(0.04, s / total).toFixed(3) }, title: `${label} ${num(s, 2)} s` }, h("b", {}, `${num(s, 2)} s`));
  return h("div", { class: "mcard-phases", title: `charge ${num(m.charge, 2)} s → active ${num(m.active, 2)} s → rest ${num(m.rest, 2)} s (total ${num(total, 2)} s)` },
    h("div", { class: "mcard-phasebar" }, seg("charge", m.charge, "charge"), seg("active", m.active, "active"), seg("rest", m.rest, "rest")),
    h("div", { class: "mcard-phaselegend muted" }, h("span", {}, "charge"), h("span", {}, "active"), h("span", {}, "rest")));
}

export interface MoveCardOptions {
  slotKey?: SlotKey;
  category?: string;
  part?: string;
  cost?: number;
  learn?: { ok: boolean; reasons: string[] };
  compact?: boolean;
}

export function moveCard(m: Move, o: MoveCardOptions = {}): HTMLElement {
  const color = hex(ELEMENTS[m.element].color);
  const cat = (o.category ?? categoryOf(m)) as MoveCategory;
  const part = o.part ?? m.part;
  const key = o.slotKey ?? (m.slot ? KEY_OF_SLOT[m.slot] : null);
  const cost = o.cost ?? moveCost(m);
  const locked = o.learn && !o.learn.ok;
  const reach = [m.range ? `range ${num(m.range)} m` : m.shape === "melee" ? "melee" : null, m.area ? `area ⌀${num(m.area)} m` : null].filter(Boolean).join(" · ");
  return h("div", { class: `mcard ${o.compact ? "compact" : ""} ${locked ? "locked" : ""}`, vars: { el: color }, "data-move": m.id, title: `${m.name}: ${m.shape}, tier ${m.tier}` },
    h("div", { class: "mcard-head" },
      key ? h("span", { class: "mcard-key", title: `${key} = ${SLOT_LABEL[key]}` }, key) : null,
      h("span", { class: "mcard-name" }, m.name),
      h("span", { class: "mcard-cat", title: cat }, CATEGORY_ICON[cat] ?? "•")),
    h("div", { class: "mcard-tags" },
      elChip(m.element),
      h("span", { class: "mcard-tag" }, cat),
      part ? h("span", { class: "mcard-tag", title: "body part that delivers the move" }, part) : null,
      // The slot's role, or the move's own when a support took the slot (a weather call in E reads "utility").
      key ? h("span", { class: "mcard-tag" }, slotOf(m) === "utility" ? "utility" : SLOT_LABEL[key]) : null,
      h("span", { class: "mcard-tag muted" }, m.shape)),
    h("div", { class: "mcard-stats" },
      h("span", { class: "mcard-pow", title: "power" }, m.power > 0 ? `⚡ ${m.power}` : "—"),
      reach ? h("span", { class: "muted" }, reach) : null,
      h("span", { class: "mcard-cost", title: "energy cost" }, `◆ ${cost}`)),
    o.compact ? null : phaseBar(m),
    o.compact ? null : h("div", { class: "mcard-fx" }, effectsText(m)),
    locked ? h("div", { class: "mcard-lock" }, h("b", {}, "🔒 cannot learn"), ...o.learn!.reasons.map((r) => h("span", {}, r))) : null);
}

/** Keys for a kit: given keys, else the moves' own slots when all four are distinct kit slots, else Q W E R by position. */
export function kitKeys(moves: readonly Move[], keys?: readonly SlotKey[]): (SlotKey | undefined)[] {
  if (keys) return moves.map((_, i) => keys[i]);
  const own = moves.map((m) => (m.slot ? KEY_OF_SLOT[m.slot] : null));
  if (own.every((k) => k) && new Set(own).size === own.length) return own as SlotKey[];
  return moves.map((_, i) => SLOT_KEYS[i]);
}

/** The 4 Q/W/E/R cards of a kit in one row (wraps on narrow panels). */
export function kitStrip(moves: readonly Move[], keys?: readonly SlotKey[], o: Omit<MoveCardOptions, "slotKey"> = {}): HTMLElement {
  const ks = kitKeys(moves, keys);
  return h("div", { class: "kit-strip" }, ...moves.map((m, i) => moveCard(m, { ...o, slotKey: ks[i] })));
}

/** A Genemon's kit as Move rows (unknown ids skipped), for the profile sheet. */
export function kitMoves(ids: readonly string[]): Move[] {
  return ids.map((id) => ALL_MOVE_BY_ID[id]).filter((m): m is Move => Boolean(m));
}
