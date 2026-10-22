/**
 * Procedural item ICONS [P5-U1]: one glyph family per item kind (27 food glyphs, gear, cosmetics,
 * potions, lures, eggs, stones, flags, incubators, tickets, maps, Genemon tokens), coloured by the
 * item's element (glyph + background tint) and ringed by its rarity. No image files, no innerHTML:
 * `iconSpec` is PURE (shape id + colours, unit-tested over every ITEM_ID) and `itemIcon` builds the SVG
 * with document.createElementNS. SVG presentation attributes (fill, stroke) are not inline styles, so the
 * strict CSP (style-src 'self') holds. Readable from 20 to 48 px: one bold silhouette + 1-2 accents.
 */
import { ELEMENT_IDS, type ElementId, ELEMENTS } from "../data/elements.ts";
import type { FoodId } from "../data/lifestyle.ts";
import { isGenemonItem, itemDef, type ItemKind, type Rarity } from "../economy/items.ts";
import { h } from "./dom.ts";

// ------------------------------------------------------------------ shapes
export const FOOD_SHAPES = [
  "berry", "leaf", "meat", "fish", "honey", "pepper", "mineral", "mushroom", "candy", "seaweed", "icecream", "bean",
  "fruit", "root", "chili", "droplet", "stormberry", "mint", "nut", "toxiccap", "petal", "plum", "mindleaf", "salt",
  "bread", "cloud", "cake",
] as const;
export const OTHER_SHAPES = [
  "flask", "lure", "egg", "gem", "hat", "crown", "scarf", "paint", "trail", "lantern", "glow", "stripes", "spots", "plate",
  "fang", "charm", "bracer", "scale", "band", "hide", "anklet", "lens", "seed", "veil", "nozzle", "boots", "flag",
  "incubator", "ticket", "map", "token", "unknown",
] as const;
export type IconShape = typeof FOOD_SHAPES[number] | typeof OTHER_SHAPES[number];
export const ICON_SHAPES: readonly IconShape[] = [...FOOD_SHAPES, ...OTHER_SHAPES];

/** Which colour a primitive takes: the glyph colour, its accent, a dark outline/detail, a highlight, a shade, a halo. */
export type Paint = "main" | "accent" | "dark" | "light" | "shade" | "halo" | "green" | "s-main" | "s-accent" | "s-dark" | "s-light" | "s-green";
export interface IconPart {
  el: "circle" | "ellipse" | "path" | "rect" | "polygon";
  a: Record<string, number | string>;
  paint: Paint;
  /** Stroke width for s-* paints (default 2). */
  w?: number;
}

const c = (cx: number, cy: number, r: number, paint: Paint): IconPart => ({ el: "circle", a: { cx, cy, r }, paint });
const e = (cx: number, cy: number, rx: number, ry: number, paint: Paint, rot = 0): IconPart =>
  ({ el: "ellipse", a: rot ? { cx, cy, rx, ry, transform: `rotate(${rot} ${cx} ${cy})` } : { cx, cy, rx, ry }, paint });
const p = (d: string, paint: Paint, w?: number): IconPart => ({ el: "path", a: { d }, paint, w });
const g = (points: string, paint: Paint): IconPart => ({ el: "polygon", a: { points }, paint });
const r = (x: number, y: number, width: number, height: number, rx: number, paint: Paint): IconPart => ({ el: "rect", a: { x, y, width, height, rx }, paint });

const LEAF = "M8 24 C8 12 16 7 25 7 C25 17 19 24 8 24z";
const PETALS: IconPart[] = [0, 72, 144, 216, 288].map((deg) => {
  const t = (deg - 90) * Math.PI / 180;
  return c(+(16 + 6 * Math.cos(t)).toFixed(2), +(16 + 6 * Math.sin(t)).toFixed(2), 4.6, "main");
});

/** The drawing of every shape on a 32 x 32 grid (glyph area ~6..26). */
export const SHAPE_PARTS: Record<IconShape, readonly IconPart[]> = {
  // ---- food
  berry: [c(12.5, 19.5, 5.2, "main"), c(20, 18, 4.8, "main"), c(15.5, 12.5, 4.4, "main"), c(11, 18, 1.3, "light"), c(18.6, 16.5, 1.2, "light"), p("M16 8 q4 -4 8 -1 q-4 3 -8 1z", "green")],
  leaf: [p(LEAF, "main"), p("M9 23 L22 10 M14 18 l-1 -4 M17 15 l3 1", "s-dark", 1.4)],
  meat: [p("M13 19 L8 24", "s-light", 3.2), c(7, 23.5, 2.3, "light"), c(9, 25.6, 2.3, "light"), e(18.5, 13.5, 8, 6.5, "main", -30), e(20.5, 11.5, 3, 2, "shade", -30)],
  fish: [g("21,16 28,10.5 28,21.5", "main"), e(14.5, 16, 8.5, 5.5, "main"), p("M12 11 q3 -3 6 0", "accent"), c(10.5, 15, 1.4, "dark"), p("M17 13 q2 3 0 6", "s-dark", 1.2)],
  honey: [p("M9 13 h14 l-1 10 a3 3 0 0 1 -3 3 h-6 a3 3 0 0 1 -3 -3z", "main"), r(8, 9.5, 16, 4, 2, "accent"), p("M12 13.5 v4 a1.3 1.3 0 0 0 2.6 0 v-4z", "light")],
  pepper: [p("M9 13 C8 20 11 26 16 26 C21 26 24 20 23 13 C20 11 12 11 9 13z", "main"), p("M16 12 q0 -4 3 -6", "s-green", 2.4), p("M12 15 q-1 5 1 8", "s-light", 1.2)],
  mineral: [g("6,26 7,16 10,12 13,16 13,26", "main"), g("19,26 19,15 22.5,11 26,15 25,26", "main"), g("12,27 12,10 16,4 20,10 20,27", "main"), g("16,4 16,27 12,27 12,10", "shade"), p("M17.5 9 v12", "s-light", 1)],
  mushroom: [r(13, 16, 6, 9.5, 2.5, "light"), p("M6.5 17 a9.5 8.5 0 0 1 19 0z", "main"), c(12, 13, 1.6, "light"), c(18.5, 11.5, 1.3, "light"), c(20.5, 15, 1, "light")],
  candy: [g("10.5,16 5.5,11.5 5.5,20.5", "accent"), g("21.5,16 26.5,11.5 26.5,20.5", "accent"), c(16, 16, 6, "main"), p("M13 14 q3 -2 5 1 q-1 3 -4 2", "s-light", 1.4)],
  seaweed: [p("M10 27 C7 21 13 18 10 12 C8.5 9 11 7 11 5", "s-main", 3), p("M16.5 27 C13.5 20 19.5 17 16.5 9", "s-main", 3), p("M22.5 27 C20.5 22 25.5 19 22.5 13", "s-accent", 2.6)],
  icecream: [g("10.5,16 21.5,16 16,28", "accent"), p("M12 19 l7 0 M13 22 l5 0", "s-dark", 1), c(12.8, 13.5, 4.4, "main"), c(19.2, 13.5, 4.4, "main"), c(16, 9.2, 4.4, "light")],
  bean: [p("M10 21 C8 13 16 6 21.5 9 C26.5 12 22 22 15 24.5 C12.5 25.3 10.7 23.6 10 21z", "main"), p("M16.5 10 C13.5 14 18 18 14.5 23", "s-dark", 1.6)],
  fruit: [c(16, 18, 8.5, "halo"), c(16, 18, 6.8, "main"), p("M16 11 q1 -4 5 -5 q0 4 -5 5z", "accent"), c(13.4, 15.5, 1.8, "light")],
  root: [p("M11.5 8 h9 l-2.5 8 l1 6 l-3.2 5 l-1 -6 l-2 -5z", "main"), p("M13.5 8 l-2 -3.5 M16 8 v-4 M18.5 8 l2 -3.5", "s-accent", 1.8), p("M13 13 h4 M14.5 18 h3", "s-dark", 1)],
  chili: [p("M7.5 10 C9 19 15 25.5 26.5 26.5 C24 24.5 17 21 13.5 10.5z", "main"), p("M10.5 10 q-1 -4 3 -5.5", "s-green", 2.4), p("M10 13 q2 7 8 10", "s-light", 1.2), p("M22 6 q4 3.5 1.5 8.5 q-1 -2.2 -3.3 -2.2 q2.2 -2.5 1.8 -6.3z", "accent")],
  droplet: [p("M16 5 C20 12 24 15.5 24 20 a8 8 0 0 1 -16 0 C8 15.5 12 12 16 5z", "main"), p("M12 20 a4 4 0 0 0 3 4", "s-light", 1.8)],
  stormberry: [c(12.5, 19.5, 5.2, "main"), c(20, 18, 4.8, "main"), c(15.5, 12.5, 4.4, "main"), g("17.5,7 12.5,16.5 16,16.5 13.8,25 21,14 17.2,14 19.5,7", "light")],
  mint: [p("M16 26 C8 22 7 13 11 7 C16 11 17 19 16 26z", "main"), p("M16 26 C24 22 25 13 21 7 C16 11 15 19 16 26z", "accent"), p("M16 9 v16", "s-light", 1.2)],
  nut: [p("M9 14.5 h14 c0 7 -4 11 -7 12 c-3 -1 -7 -5 -7 -12z", "main"), p("M7.5 15 a8.5 5.5 0 0 1 17 0z", "accent"), p("M16 9.5 v-4", "s-dark", 2), p("M10 15 h12", "s-dark", 1)],
  toxiccap: [r(13.5, 16, 5, 9, 2.5, "light"), p("M6.5 17 a9.5 9 0 0 1 19 0z", "main"), c(11.5, 13, 1.8, "dark"), c(17.5, 11, 1.5, "dark"), c(20.5, 14.6, 1.2, "dark"), p("M9 17 v3 a1 1 0 0 0 2 0 v-3z", "accent")],
  petal: [...PETALS, c(16, 16, 3.6, "accent"), c(15, 15, 1, "light")],
  plum: [c(16, 18, 8, "main"), p("M16 11 C13 15 13 21 16 26", "s-dark", 1.4), p("M16 10.5 q2 -4 6 -4 q-1 4 -6 4z", "accent"), c(12.5, 15, 1.6, "light")],
  mindleaf: [p(LEAF, "main"), p("M16.5 16 a1 1 0 1 1 1.6 -1 a2.8 2.8 0 1 1 -5 2 a4.6 4.6 0 1 1 8.6 -2.5", "s-light", 1.5)],
  salt: [g("5.5,26 16,12 26.5,26", "main"), r(11, 18, 3, 3, 0.4, "light"), r(17, 20.5, 2.6, 2.6, 0.4, "light"), r(14.5, 14.5, 2.2, 2.2, 0.4, "light"), r(19, 6, 3.4, 3.4, 0.5, "accent")],
  bread: [p("M6.5 21 C6.5 11.5 25.5 11.5 25.5 21 v4 h-19z", "main"), p("M11 15.5 l2 3 M15.5 14.5 l2 3 M20 15.5 l2 3", "s-dark", 1.5), r(6.5, 22, 19, 3, 1, "shade")],
  cloud: [p("M9 23 a5 5 0 0 1 0.5 -10 a7 7 0 0 1 13.2 1.6 a4.4 4.4 0 0 1 0.3 8.4z", "main"), p("M11 19 q3 2 6 0", "s-light", 1.4)],
  cake: [r(8, 15, 16, 10.5, 2, "main"), p("M8 17.5 q2 3 4 0 q2 3 4 0 q2 3 4 0 q2 3 4 0 v-3.5 a2 2 0 0 0 -2 -2 h-12 a2 2 0 0 0 -2 2z", "green"), c(12, 21.5, 0.9, "dark"), c(16, 22.5, 0.9, "dark"), c(20, 21.5, 0.9, "dark"), p("M16 12 v-4", "s-light", 1.6)],
  // ---- potions, lures, eggs, stones
  flask: [p("M13 6 h6 v5 l5.5 10 a4 4 0 0 1 -3.8 5.5 h-9.4 a4 4 0 0 1 -3.8 -5.5 l5.5 -10z", "light"), p("M9.3 18.5 h13.4 l1.8 2.8 a4 4 0 0 1 -3.8 5.2 h-9.4 a4 4 0 0 1 -3.8 -5.2z", "main"), r(12, 4.5, 8, 3, 1.2, "accent"), c(13.5, 22, 1.2, "light")],
  lure: [p("M16 4.5 v13 a4.5 4.5 0 0 1 -9 0 l2 -2", "s-dark", 1.8), c(16, 12, 4.6, "main"), g("16,16 21,25 16,22.5 11,25", "accent"), c(14.6, 10.6, 1.3, "light")],
  egg: [e(16, 17, 7.5, 9.5, "main"), c(13, 19, 1.8, "accent"), c(18.5, 14, 1.4, "accent"), c(19, 21.5, 1.2, "accent"), e(13, 12.5, 1.4, 2.4, "light", 20)],
  gem: [g("16,5 25.5,13 16,27.5 6.5,13", "main"), g("6.5,13 25.5,13 16,27.5", "shade"), g("11,8.5 21,8.5 25.5,13 6.5,13", "light"), p("M11 13 L16 27.5 L21 13", "s-dark", 0.8)],
  // ---- cosmetics
  hat: [g("16,4 23.5,22 8.5,22", "main"), e(16, 23, 11.5, 3.2, "accent"), g("16,10 17,12.5 19.5,12.5 17.5,14 18.3,16.5 16,15 13.7,16.5 14.5,14 12.5,12.5 15,12.5", "light")],
  crown: [g("6.5,23 6.5,11 11.5,16.5 16,7.5 20.5,16.5 25.5,11 25.5,23", "main"), r(6.5, 21, 19, 3.5, 1, "accent"), c(16, 15.5, 1.8, "light"), c(10.5, 19, 1.3, "accent"), c(21.5, 19, 1.3, "accent")],
  scarf: [p("M6 11 q10 -5 20 0 v5 q-10 -5 -20 0z", "main"), p("M17 14 h5 l1 11 h-5z", "main"), p("M18 25 v3 M20 25 v3 M22 25 v3", "s-accent", 1.2), p("M8 12.5 q8 -4 16 0", "s-light", 1)],
  paint: [r(9, 13, 14, 13, 2.5, "dark"), p("M9 15.5 h14 v4 q-2 3 -4 0 q-1 5 -3 2 q-2 -3 -3 0 q-2 2 -4 -2z", "main"), e(16, 13, 7, 2.4, "light"), p("M22 9 q4 -3 5 1", "s-accent", 1.6)],
  trail: [c(8, 23, 1.5, "halo"), c(11, 20.5, 2.2, "halo"), c(14.5, 17.5, 2.6, "light"), g("21,6 22.8,11.2 28,11.6 23.9,15 25.3,20.2 21,17.2 16.7,20.2 18.1,15 14,11.6 19.2,11.2", "main")],
  lantern: [c(16, 17, 10, "halo"), r(10.5, 10, 11, 14, 4.5, "main"), r(12.5, 7.5, 7, 3, 1, "dark"), r(12.5, 23.5, 7, 2.5, 1, "dark"), p("M16 7.5 v-3", "s-dark", 1.4), p("M10.5 17 h11", "s-accent", 1)],
  glow: [c(16, 16, 10.5, "halo"), c(16, 16, 6.5, "main"), c(16, 16, 3, "light"), p("M16 3.5 v3 M16 25.5 v3 M3.5 16 h3 M25.5 16 h3", "s-main", 1.6)],
  stripes: [c(16, 16, 9.5, "main"), p("M10 9 q3 7 0 14 M16 6.5 q3 9.5 0 19 M22 9 q3 7 0 14", "s-dark", 2.2)],
  spots: [c(16, 16, 9.5, "main"), c(12, 12.5, 2.2, "dark"), c(19.5, 14, 1.8, "dark"), c(14, 20, 1.6, "dark"), g("20,18.5 21,20.8 23.5,21 21.6,22.6 22.2,25 20,23.7 17.8,25 18.4,22.6 16.5,21 19,20.8", "light")],
  plate: [r(5.5, 11, 21, 10.5, 2.5, "main"), r(7.5, 13, 17, 6.5, 1.5, "shade"), p("M10 16.2 h12", "s-light", 1.6), c(5.5, 16.2, 1, "dark"), c(26.5, 16.2, 1, "dark")],
  // ---- gear
  fang: [p("M9.5 7 h13 C21.5 15 18.5 22 16 27.5 C13.5 22 10.5 15 9.5 7z", "main"), r(9, 5.5, 14, 3.5, 1.5, "accent"), p("M13 10 q1 7 3 12", "s-light", 1.2)],
  charm: [p("M8.5 5.5 L16 13.5 L23.5 5.5", "s-dark", 1.4), c(16, 19, 7, "main"), c(16, 19, 3.6, "light"), c(16, 19, 1.6, "accent")],
  bracer: [r(9, 9.5, 14, 13, 3.5, "main"), g("9,12 4.5,13.5 9,15", "accent"), g("23,12 27.5,13.5 23,15", "accent"), g("9,17 4.5,18.5 9,20", "accent"), g("23,17 27.5,18.5 23,20", "accent"), p("M12 13 h8 M12 16 h8 M12 19 h8", "s-dark", 1)],
  scale: [p("M16 5.5 C23.5 8.5 24.5 17 16 26.5 C7.5 17 8.5 8.5 16 5.5z", "main"), p("M10.5 12 q5.5 4 11 0 M11.5 17 q4.5 3.5 9 0", "s-light", 1.4)],
  band: [{ el: "circle", a: { cx: 16, cy: 16, r: 8 }, paint: "s-main", w: 4.6 }, { el: "circle", a: { cx: 16, cy: 16, r: 8 }, paint: "s-dark", w: 0.8 }, g("17.5,8.5 13,16.5 16.2,16.5 14.4,23.5 19.5,14.8 16.4,14.8 18.4,8.5", "accent")],
  hide: [p("M16 4.5 l9.5 4 v7.5 c0 6 -4.2 9.2 -9.5 11.5 c-5.3 -2.3 -9.5 -5.5 -9.5 -11.5 v-7.5z", "main"), p("M16 4.5 v22.5 c-5.3 -2.3 -9.5 -5.5 -9.5 -11.5 v-7.5z", "shade"), c(16, 14.5, 2.6, "accent"), c(10, 10, 1, "light"), c(22, 10, 1, "light")],
  anklet: [e(15, 19, 9, 4.5, "s-main"), g("22,15 28,8 27,15.5 24,17", "light"), g("21,14 25,7 24.5,13.5", "accent"), c(15, 23.5, 1.6, "accent")],
  lens: [p("M20.5 20.5 L26.5 26.5", "s-dark", 3.4), c(14, 14, 7.5, "light"), c(14, 14, 7.5, "s-main"), p("M14 9.5 v9 M9.5 14 h9", "s-main", 1)],
  seed: [p("M16 27 C9 24 9 16 16 11 C23 16 23 24 16 27z", "main"), p("M16 11 C16 7 13 5 9.5 5.5 C10 9 13 11 16 11z M16 11 C16 8 19 6 22.5 6.5 C22 9.5 19 11 16 11z", "accent"), c(13.8, 19, 1.4, "light")],
  veil: [p("M7 8 h18 c-1 8 1 13 3.5 18.5 h-25 c2.5 -5.5 4.5 -10.5 3.5 -18.5z", "main"), p("M11 10 c0 6 -1 11 -3 16 M16 10 v16 M21 10 c0 6 1 11 3 16", "s-light", 1), e(13, 15, 1.6, 1, "dark"), e(19, 15, 1.6, 1, "dark")],
  nozzle: [g("5,12.5 14,10.5 14,21.5 5,19.5", "dark"), r(13, 9.5, 3.5, 13, 1, "accent"), p("M18 16 L27 9 M18 16 L28 16 M18 16 L27 23", "s-main", 2), c(25, 12, 1.2, "main"), c(25, 20, 1.2, "main")],
  boots: [p("M9.5 5.5 h8 v12 h6.5 a3.5 3.5 0 0 1 3.5 3.5 v3.5 h-18z", "main"), r(8.5, 24, 19.5, 3, 1.2, "dark"), p("M9.5 10 h8 M9.5 13.5 h8", "s-accent", 1.4)],
  // ---- flags, incubators, tickets, maps
  flag: [p("M10 4.5 V28", "s-dark", 2.2), g("11,6 26,10 11,15.5", "main"), p("M11 9.5 l9 1.2", "s-light", 1)],
  incubator: [r(7, 22, 18, 5, 1.5, "accent"), e(16, 17.5, 4.5, 5.5, "main"), p("M8 22.5 a8 10.5 0 0 1 16 0z", "halo"), p("M10 21 a6 8 0 0 1 3 -7", "s-light", 1.2)],
  ticket: [p("M5 10 h22 v4 a2 2 0 0 0 0 4 v4 h-22 v-4 a2 2 0 0 0 0 -4z", "main"), p("M20 10.5 v11", "s-light", 1), g("12,12 13.2,14.6 16,14.8 13.9,16.6 14.6,19.4 12,17.9 9.4,19.4 10.1,16.6 8,14.8 10.8,14.6", "light")],
  map: [g("5.5,9 12,7 20,9 26.5,7 26.5,23 20,25 12,23 5.5,25", "main"), g("12,7 20,9 20,25 12,23", "shade"), p("M8.5 18 q3 -4 6 -1 q3 3 5 -2", "s-dark", 1.2), p("M20.5 12 l3 3 M23.5 12 l-3 3", "s-accent", 1.8)],
  // ---- genemon tokens and unknown items
  token: [g("9,10 11,4.5 14,9", "accent"), g("23,10 21,4.5 18,9", "accent"), c(16, 17, 9, "main"), e(12.5, 16, 2.4, 2.8, "light"), e(19.5, 16, 2.4, 2.8, "light"), c(12.8, 16.4, 1.2, "dark"), c(19.8, 16.4, 1.2, "dark"), p("M13 21.5 q3 2 6 0", "s-dark", 1.3)],
  unknown: [c(16, 16, 9, "main"), p("M12.5 13 a3.5 3.5 0 1 1 5 3.2 c-1.2 0.6 -1.5 1.3 -1.5 2.6", "s-light", 2.2), c(16, 22.4, 1.4, "light")],
};

// ------------------------------------------------------------------ colours
export const RARITY_RING: Record<Rarity, string> = {
  common: "#8d99ae",
  uncommon: "#2ec4a6",
  rare: "#3a9bff",
  epic: "#b26bff",
  legendary: "#ff9f1c",
};
const RARITY_WIDTH: Record<Rarity, number> = { common: 1.6, uncommon: 1.9, rare: 2.2, epic: 2.5, legendary: 2.8 };

function elHex(el: ElementId): string {
  return `#${ELEMENTS[el].color.toString(16).padStart(6, "0")}`;
}

/** Linear mix of two #rrggbb colours (t = 0 -> a, 1 -> b). */
export function mixHex(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  const ch = (s: number) => Math.round(((pa >> s) & 255) * (1 - t) + ((pb >> s) & 255) * t);
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, "0")}`;
}

/** Each food: its glyph, its natural colour (null = the element colour) and the element it pushes toward. */
export const FOOD_ICON: Record<FoodId, { shape: IconShape; color: string | null; element: ElementId }> = {
  berries: { shape: "berry", color: "#d63a6b", element: "plant" },
  greens: { shape: "leaf", color: "#58b947", element: "plant" },
  meat: { shape: "meat", color: "#c9563c", element: "fire" },
  fish: { shape: "fish", color: "#5aa9d6", element: "water" },
  honey: { shape: "honey", color: "#f2b632", element: "light" },
  spicyPepper: { shape: "pepper", color: "#e8442e", element: "fire" },
  minerals: { shape: "mineral", color: "#9fb0c4", element: "earth" },
  mushroom: { shape: "mushroom", color: "#a0714f", element: "shadow" },
  candy: { shape: "candy", color: "#ff7ab8", element: "neutral" },
  seaweed: { shape: "seaweed", color: "#2f9e72", element: "water" },
  iceCream: { shape: "icecream", color: "#ffd1e8", element: "ice" },
  coffeeBean: { shape: "bean", color: "#7a4a2a", element: "electric" },
  glowFruit: { shape: "fruit", color: "#ffe45c", element: "light" },
  ashRoot: { shape: "root", color: "#6e6259", element: "shadow" },
  emberChili: { shape: "chili", color: null, element: "fire" },
  springWater: { shape: "droplet", color: null, element: "water" },
  stormBerry: { shape: "stormberry", color: "#5b5bd6", element: "electric" },
  frostMint: { shape: "mint", color: null, element: "ice" },
  ironNut: { shape: "nut", color: null, element: "metal" },
  toxicCap: { shape: "toxiccap", color: null, element: "poison" },
  sunPetal: { shape: "petal", color: null, element: "light" },
  nightPlum: { shape: "plum", color: null, element: "shadow" },
  mindLeaf: { shape: "mindleaf", color: null, element: "psychic" },
  voidSalt: { shape: "salt", color: null, element: "void" },
  stoneBread: { shape: "bread", color: "#b08a5a", element: "earth" },
  cloudPuff: { shape: "cloud", color: "#e8f1ff", element: "air" },
  seedCake: { shape: "cake", color: "#e0b26a", element: "plant" },
};

/** Glyph of non-food items by id (else the kind's default). */
const ID_SHAPE: Record<string, IconShape> = {
  "cosmetic.scarf": "scarf", "cosmetic.silkScarf": "scarf", "cosmetic.glowPaint": "paint", "cosmetic.crown": "crown",
  "cosmetic.flowerCrown": "crown", "cosmetic.wizardHat": "hat", "cosmetic.goldPlate": "plate", "cosmetic.starTrail": "trail",
  "cosmetic.lantern": "lantern", "cosmetic.emberGlow": "glow", "cosmetic.frostGlow": "glow", "cosmetic.tigerStripes": "stripes",
  "cosmetic.starSpots": "spots",
  "gear.emberFang": "fang", "gear.tideCharm": "charm", "gear.thornBracer": "bracer", "gear.frostScale": "scale",
  "gear.thunderBand": "band", "gear.powerBand": "band", "gear.ironHide": "hide", "gear.swiftAnklet": "anklet",
  "gear.focusLens": "lens", "gear.vitalSeed": "seed", "gear.shadowVeil": "veil", "gear.coneNozzle": "nozzle",
  "gear.quakeBoots": "boots",
};
const KIND_SHAPE: Record<ItemKind, IconShape> = {
  food: "berry", potion: "flask", lure: "lure", egg: "egg", stone: "gem", cosmetic: "hat", gear: "band",
  territoryFlag: "flag", incubator: "incubator", ticket: "ticket", map: "map", genemon: "token",
};
/** Element of non-food items whose effects do not name one. */
const ID_ELEMENT: Record<string, ElementId> = {
  "potion.heal": "plant", "potion.fullHeal": "fire", "potion.energy": "electric", "potion.surge": "electric",
  "potion.cleanse": "water", "potion.revive": "plant",
  "stone.evolution": "light", "stone.everstone": "earth", "stone.voidShard": "void", "stone.fusionCore": "void",
  "stone.prism": "light", "stone.helixKey": "psychic",
  "cosmetic.scarf": "fire", "cosmetic.silkScarf": "air", "cosmetic.glowPaint": "light", "cosmetic.crown": "light",
  "cosmetic.flowerCrown": "plant", "cosmetic.wizardHat": "psychic", "cosmetic.goldPlate": "light",
  "cosmetic.starTrail": "light", "cosmetic.lantern": "fire", "cosmetic.emberGlow": "fire", "cosmetic.frostGlow": "ice",
  "cosmetic.tigerStripes": "fire", "cosmetic.starSpots": "void",
  "gear.ironHide": "metal", "gear.swiftAnklet": "air", "gear.focusLens": "psychic", "gear.powerBand": "fire",
  "gear.vitalSeed": "plant", "gear.shadowVeil": "shadow", "gear.coneNozzle": "water", "gear.quakeBoots": "earth",
  "flag.wood": "earth", "flag.iron": "metal", "flag.crystal": "ice",
  "incubator.thermal": "fire", "ticket.arenaGold": "light", "ticket.crystalCave": "ice", "ticket.voidAbyss": "void",
  "ticket.arenaBronze": "earth", "map.tornTreasure": "earth", "map.nest": "plant", "map.ancientTreasure": "earth",
};
/** Fixed accents that read better than a tint of the main colour. */
/** Glyphs whose body has a natural colour (the element then paints the accent instead). */
const SHAPE_MAIN: Partial<Record<IconShape, string>> = { fang: "#f1e6cc", egg: "#f4ecd8", boots: "#8a5a3c", lens: "#d8f3ff" };
const SHAPE_ACCENT: Partial<Record<IconShape, string>> = {
  berry: "#4caf50", stormberry: "#ffe066", fruit: "#4caf50", plum: "#4caf50", pepper: "#3f8f3a", chili: "#ffb347",
  root: "#7cb342", nut: "#7a5230", candy: "#ffe066", icecream: "#d9a066", honey: "#8d5a2b", cake: "#fff2d6",
  crown: "#e63946", hat: "#ffd166", lantern: "#ff6b35", fang: "#e0d6c3", flag: "#ffffff", token: "#ffd166",
  egg: "#ffffff", incubator: "#8d99ae", mint: "#bdf5ff", seed: "#7cb342",
};

const isElement = (x: unknown): x is ElementId => typeof x === "string" && (ELEMENT_IDS as readonly string[]).includes(x);

export interface IconSpec {
  itemId: string;
  name: string;
  kind: ItemKind | "unknown";
  shape: IconShape;
  element: ElementId;
  rarity: Rarity;
  /** Glyph colour, accent, background disc tint and rarity ring, all #rrggbb. */
  main: string;
  accent: string;
  bg: string;
  ring: string;
  ringWidth: number;
}

/**
 * PURE: the icon of an item id (catalogue ids, `genemon:<id>` tokens, unknown ids -> "unknown").
 * `o.color` overrides the glyph colour (a Genemon token in its palette colour).
 */
export function iconSpec(itemId: string, o: { color?: string } = {}): IconSpec {
  const def = itemDef(itemId);
  const kind: ItemKind | "unknown" = def?.kind ?? "unknown";
  const rarity: Rarity = def?.rarity ?? "common";
  let shape: IconShape = def ? (ID_SHAPE[itemId] ?? KIND_SHAPE[def.kind]) : "unknown";
  let element: ElementId = "neutral";
  let main: string | null = null;
  if (def?.kind === "food") {
    const f = FOOD_ICON[def.effects.food as FoodId];
    if (f) {
      shape = f.shape;
      element = f.element;
      main = f.color;
    }
  } else if (def) {
    const fx = def.effects;
    if (isElement(fx.element)) element = fx.element;
    else if (isElement(fx.primary)) element = fx.primary;
    else element = ID_ELEMENT[itemId] ?? "neutral";
    if (typeof fx.color === "number") main = `#${fx.color.toString(16).padStart(6, "0")}`;
  }
  if (isGenemonItem(itemId)) shape = "token";
  const tint = element === "neutral" ? mixHex(RARITY_RING[rarity], "#ffffff", 0.25) : elHex(element);
  const natural = SHAPE_MAIN[shape];
  main = o.color ?? (natural && !main ? natural : null) ?? main ?? tint;
  const ring = RARITY_RING[rarity];
  const accent = natural && main === natural ? (shape === "egg" ? ring : tint) : SHAPE_ACCENT[shape] ?? mixHex(main, "#ffffff", 0.45);
  return {
    itemId,
    name: def?.name ?? itemId,
    kind,
    shape,
    element,
    rarity,
    main,
    accent,
    bg: mixHex(elHex(element), "#10151f", 0.72),
    ring,
    ringWidth: RARITY_WIDTH[rarity],
  };
}

// ------------------------------------------------------------------ DOM
const SVG_NS = "http://www.w3.org/2000/svg";

function paintAttrs(part: IconPart, s: IconSpec): Record<string, string | number> {
  const dark = "#141a26";
  switch (part.paint) {
    case "main": return { fill: s.main };
    case "accent": return { fill: s.accent };
    case "dark": return { fill: dark };
    case "light": return { fill: "#ffffff", "fill-opacity": 0.85, stroke: "none" };
    case "shade": return { fill: "#000000", "fill-opacity": 0.22, stroke: "none" };
    case "halo": return { fill: s.main, "fill-opacity": 0.3, stroke: "none" };
    case "green": return { fill: "#5cb85c" };
    case "s-green": return { fill: "none", stroke: "#4caf50", "stroke-width": part.w ?? 2, "stroke-linecap": "round", "stroke-linejoin": "round" };
    case "s-main": return { fill: "none", stroke: s.main, "stroke-width": part.w ?? 2, "stroke-linecap": "round", "stroke-linejoin": "round" };
    case "s-accent": return { fill: "none", stroke: s.accent, "stroke-width": part.w ?? 2, "stroke-linecap": "round", "stroke-linejoin": "round" };
    case "s-dark": return { fill: "none", stroke: dark, "stroke-width": part.w ?? 2, "stroke-linecap": "round", "stroke-linejoin": "round", "stroke-opacity": 0.75 };
    case "s-light": return { fill: "none", stroke: "#ffffff", "stroke-width": part.w ?? 2, "stroke-linecap": "round", "stroke-linejoin": "round", "stroke-opacity": 0.85 };
  }
}

function svgEl(tag: string, attrs: Record<string, string | number>): SVGElement {
  const n = document.createElementNS(SVG_NS, tag) as SVGElement;
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
}

/** The icon as an inline <svg> (size in CSS px). A thin dark outline keeps every glyph readable on any tint. */
export function itemIcon(itemId: string, size = 32, o: { color?: string; title?: string } = {}): SVGSVGElement {
  const s = iconSpec(itemId, o);
  const svg = svgEl("svg", {
    viewBox: "0 0 32 32", width: size, height: size, class: `ui5-icon ui5-r-${s.rarity}`, role: "img",
    "aria-label": o.title ?? s.name, "data-item": itemId, "data-shape": s.shape,
  }) as SVGSVGElement;
  const title = svgEl("title", {});
  title.textContent = o.title ?? `${s.name} · ${s.rarity}${s.element !== "neutral" ? ` · ${ELEMENTS[s.element].name}` : ""}`;
  svg.append(title);
  if (s.rarity === "epic" || s.rarity === "legendary") svg.append(svgEl("circle", { cx: 16, cy: 16, r: 15.6, fill: "none", stroke: s.ring, "stroke-opacity": 0.35, "stroke-width": 0.8 }));
  svg.append(svgEl("circle", { cx: 16, cy: 16, r: 15 - s.ringWidth / 2, fill: s.bg, stroke: s.ring, "stroke-width": s.ringWidth }));
  const glyph = svgEl("g", { stroke: "#0b0f15", "stroke-width": 0.6, "stroke-opacity": 0.55, "stroke-linejoin": "round" });
  for (const part of SHAPE_PARTS[s.shape]) glyph.append(svgEl(part.el, { ...part.a, ...paintAttrs(part, s) }));
  svg.append(glyph);
  return svg;
}

/** Icon + optional count badge in a span (bag tiles, loot rows, lot cards). */
export function iconChip(itemId: string, size = 32, qty?: number, o: { color?: string; title?: string } = {}): HTMLElement {
  return h("span", { class: "ui5-ichip", vars: { isz: `${size}px` } }, itemIcon(itemId, size, o), qty !== undefined && qty !== 1 ? h("b", { class: "ui5-qty" }, qty > 999 ? "999+" : `×${qty}`) : null);
}

/** Loot list (after a battle): icon, name, quantity per drop. */
export function lootList(drops: readonly { itemId: string; qty: number }[]): HTMLElement {
  if (drops.length === 0) return h("span", { class: "muted" }, "nothing this time");
  return h("span", { class: "ui5-loot" }, ...drops.map((d) => h("span", { class: "ui5-loot-item", title: itemDef(d.itemId)?.note ?? "" }, iconChip(d.itemId, 26), `${itemDef(d.itemId)?.name ?? d.itemId} ×${d.qty}`)));
}
