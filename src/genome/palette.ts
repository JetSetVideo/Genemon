/**
 * Pass 6 [P6-K1]: the PRIMARY / SECONDARY / TERTIARY palette, chosen by colour theory.
 *
 *  - PRIMARY = the element colour family. The hue is LOCKED to the element (the colour code is sacred: water
 *    blue, fire red, electric yellow, plant green...) within +-PRIMARY_HUE_SHIFT degrees; lightness and
 *    saturation come from the axes (luminance, substance, mood). A hybrid identity (src/data/hybrids.ts:
 *    Steam, Magma...) keeps its identity colour as the primary.
 *  - SECONDARY / TERTIARY follow a HARMONY SCHEME (mono, analogous, complementary, split-complementary, triad,
 *    tetrad) picked deterministically from the genome's hue allele with SCHEME_WEIGHTS (analogous and
 *    complementary common, tetrad rare). A dual-typed creature (or the other parent of a hybrid) puts its
 *    SECOND ELEMENT in the secondary role with that element's colour; the scheme is then the one its hue
 *    relationship names.
 *  - harmonyScore(p) 0..1 = hue relationships (closeness to the harmonic angles, discounted for near-neutral
 *    colours) + lightness structure (distinct roles, value range, no equal-value vibration between strong
 *    complements) + saturation balance (no garish all-saturated triple, no muddy greyish mid-dark secondaries).
 *    Candidates under HARMONY_FLOOR are re-rolled INSIDE the scheme (offsets, lightness, saturation); the best
 *    of MAX_TRIES is kept (tests/palette_test.ts measures that the floor holds over >= 5000 genomes).
 *  - ATTRIBUTION: which body part wears which role (body / back / head = primary, markings = secondary,
 *    belly = a light tint of primary or secondary, limbs / tail / wings / horns / eyes / glow per scheme and
 *    body kind). Renderers (src/render/textures.ts rolesOf, anatomy/skin.ts, anatomy/coat.ts) obey it.
 *  - MINIMAL globes (complexity tier "minimal", `colors` = 2) use primary + secondary only: tertiary ===
 *    secondary and no part is attributed "tertiary".
 *
 * PURE: no DOM, randomness only through Rng(hashSeed(...)) of the hue alleles (heritable, deterministic).
 * Colour maths: HSL hue (the artist's wheel) for the scheme angles, OKLab for lightness and chroma.
 */
import type { AxisVector } from "../data/axes.ts";
import { elementAffinities, ELEMENTS, type ElementId } from "../data/elements.ts";
import { type Hybrid, HYBRIDS, identityOfPhenotype } from "../data/hybrids.ts";
import { hashSeed, Rng } from "../core/rng.ts";
import type { Genome } from "./genome.ts";
import type { HarmonyScheme, Palette3 } from "./p6Types.ts";

// ====================================================================== constants

export const HARMONY_SCHEMES: readonly HarmonyScheme[] = ["mono", "analogous", "complementary", "split", "triad", "tetrad"];
/** Share of single-typed genomes per scheme (picked from the hue allele; tests measure the distribution). */
export const SCHEME_WEIGHTS: Readonly<Record<HarmonyScheme, number>> = {
  analogous: 0.31,
  complementary: 0.25,
  split: 0.15,
  mono: 0.14,
  triad: 0.11,
  tetrad: 0.04,
};
/** Palettes below this harmony are re-rolled inside their scheme. */
export const HARMONY_FLOOR = 0.65;
/** Max hue drift of the primary from its element hue, degrees (the colour code is sacred). */
export const PRIMARY_HUE_SHIFT = 8;
/** Max hue slide of a second element's colour toward a harmonic angle (re-rolls only), degrees. */
export const SECONDARY_HUE_SLIDE = 12;
const MAX_TRIES = 24;

export type ColourRole = "primary" | "secondary" | "tertiary";
export type ColourPart = "body" | "belly" | "back" | "markings" | "limbs" | "head" | "wings" | "tail" | "horns" | "eyes" | "glow";
export const COLOUR_PARTS: readonly ColourPart[] = ["body", "back", "head", "belly", "markings", "limbs", "tail", "wings", "horns", "eyes", "glow"];
/** Pass-5 behaviour expressed as an attribution (used when a phenotype has no palette3). */
export const DEFAULT_ATTRIBUTION: Readonly<Record<ColourPart, ColourRole>> = {
  body: "primary",
  back: "primary",
  head: "primary",
  belly: "primary",
  markings: "secondary",
  limbs: "primary",
  tail: "primary",
  wings: "secondary",
  horns: "secondary",
  eyes: "tertiary",
  glow: "tertiary",
};
/** Elements that glow in their OWN colour (the glow stays primary / element core). */
const SELF_GLOW: ReadonlySet<ElementId> = new Set<ElementId>(["fire", "electric", "light", "psychic", "void"]);

// ====================================================================== colour maths

const clamp = (x: number, lo: number, hi: number) => (Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : lo);
const clamp01 = (x: number) => clamp(x, 0, 1);
const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const wrap360 = (h: number) => ((h % 360) + 360) % 360;

export interface Hsl {
  /** Degrees [0, 360). */
  h: number;
  s: number;
  l: number;
}

export function hexToHsl(c: number): Hsl {
  const r = ((c >> 16) & 255) / 255, g = ((c >> 8) & 255) / 255, b = (c & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: h * 60, s, l };
}

export function hslToHex(h: number, s: number, l: number): number {
  const hh = wrap360(h) / 360, ss = clamp01(s), ll = clamp01(l);
  const f = (n: number) => {
    const k = (n + hh * 12) % 12;
    const a = ss * Math.min(ll, 1 - ll);
    return Math.round(255 * (ll - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return (f(0) << 16) | (f(8) << 8) | f(4);
}

/** OKLab of a 0xRRGGBB colour: L 0..1 (perceived lightness), a / b, chroma C. */
export function oklab(c: number): { L: number; a: number; b: number; C: number } {
  const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const r = lin(((c >> 16) & 255) / 255), g = lin(((c >> 8) & 255) / 255), bl = lin((c & 255) / 255);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * bl);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * bl);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * bl);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const b = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { L, a, b, C: Math.hypot(a, b) };
}

/** Unsigned hue distance on the wheel, degrees [0, 180]. */
export function hueDistance(a: number, b: number): number {
  const d = wrap360(a - b);
  return d > 180 ? 360 - d : d;
}

/** Signed hue offset b - a in (-180, 180]. */
function hueOffset(a: number, b: number): number {
  const d = wrap360(b - a);
  return d > 180 ? d - 360 : d;
}

/** The scheme a hue relationship names (nearest harmonic angle). */
export function classifyScheme(hueDist: number): HarmonyScheme {
  // 60 degrees (two steps on the 12-hue wheel) still reads as a wide analogous pair; a tetrad needs a square.
  const anchors: [number, HarmonyScheme][] = [[0, "mono"], [30, "analogous"], [55, "analogous"], [90, "tetrad"], [120, "triad"], [150, "split"], [180, "complementary"]];
  let best = anchors[0];
  for (const a of anchors) if (Math.abs(hueDist - a[0]) < Math.abs(hueDist - best[0])) best = a;
  return best[1];
}

// ====================================================================== harmony score

const HUE_ANCHORS: [number, number][] = [[0, 1], [30, 0.95], [60, 0.6], [90, 0.8], [120, 0.95], [150, 0.9], [180, 1]];
const HUE_SIGMA = 11;
/** Fit of a hue distance to the harmonic angles (0..1; ~0.3 in the discord gaps such as 45 or 75 degrees). */
export function hueFit(d: number): number {
  let best = 0;
  for (const [a, w] of HUE_ANCHORS) best = Math.max(best, w * Math.exp(-((d - a) ** 2) / (2 * HUE_SIGMA * HUE_SIGMA)));
  return best;
}

/** Greyish mid-dark colour (the "mud" of colour theory): low but nonzero chroma at mid-low lightness. */
export function mudOf(c: number): number {
  const o = oklab(c);
  return smooth(0.012, 0.03, o.C) * (1 - smooth(0.06, 0.09, o.C)) * smooth(0.25, 0.33, o.L) * (1 - smooth(0.55, 0.66, o.L));
}

export interface HarmonyParts {
  hue: number;
  light: number;
  sat: number;
  score: number;
}

/** Score breakdown (0..1 each). Two-colour palettes (tertiary equal to another role) score the pair only. */
export function harmonyParts(p: Pick<Palette3, "primary" | "secondary" | "tertiary">): HarmonyParts {
  const two = p.tertiary === p.secondary || p.tertiary === p.primary;
  const cols = two ? [p.primary, p.secondary] : [p.primary, p.secondary, p.tertiary];
  const hsl = cols.map(hexToHsl), lab = cols.map(oklab);
  const pair = (i: number, j: number) => {
    const w = Math.min(1, Math.min(lab[i].C, lab[j].C) / 0.06);
    return 1 - w * (1 - hueFit(hueDistance(hsl[i].h, hsl[j].h)));
  };
  const dE = (i: number, j: number) => Math.hypot(lab[i].L - lab[j].L, lab[i].a - lab[j].a, lab[i].b - lab[j].b);
  const vib = (i: number, j: number) =>
    hueDistance(hsl[i].h, hsl[j].h) > 60 ? (1 - smooth(0.04, 0.16, Math.abs(lab[i].L - lab[j].L))) * smooth(0.1, 0.16, Math.min(lab[i].C, lab[j].C)) : 0;
  const Ls = lab.map((x) => x.L);
  const range = smooth(0.06, 0.2, Math.max(...Ls) - Math.min(...Ls));
  let hue: number, light: number;
  if (two) {
    hue = pair(0, 1);
    light = (0.65 * smooth(0.05, 0.15, dE(0, 1)) + 0.35 * range) * (1 - 0.5 * vib(0, 1));
  } else {
    // Geometric weighting: one discordant pair is enough to hurt.
    hue = Math.exp((1 * Math.log(Math.max(1e-3, pair(0, 1))) + 0.7 * Math.log(Math.max(1e-3, pair(0, 2))) + 0.5 * Math.log(Math.max(1e-3, pair(1, 2)))) / 2.2);
    const dT = Math.min(dE(2, 0), dE(2, 1));
    light = (0.5 * smooth(0.05, 0.15, dE(0, 1)) + 0.28 * smooth(0.03, 0.1, dT) + 0.22 * range) * (1 - 0.5 * Math.max(vib(0, 1), 0.6 * vib(0, 2)));
  }
  const meanC = lab.reduce((s, x) => s + x.C, 0) / lab.length;
  const spread = cols.length > 1 ? Math.max(...cols.map((_, i) => (i ? hueDistance(hsl[0].h, hsl[i].h) : 0))) : 0;
  const garish = smooth(0.15, 0.22, meanC) * (spread > 60 ? 1 : 0.5);
  const mud = Math.max(0.3 * mudOf(cols[0]), ...cols.slice(1).map(mudOf));
  const sat = clamp01(1 - 0.7 * garish - 0.8 * mud);
  // Weighted GEOMETRIC mean: a muddy or vibrating palette cannot be rescued by a perfect hue relationship.
  const lg = (x: number) => Math.log(Math.max(1e-3, x));
  const score = clamp01(Math.exp(0.4 * lg(hue) + 0.35 * lg(light) + 0.25 * lg(sat)));
  return { hue, light, sat, score };
}

/** 0..1 compatibility of the palette's colours (colour theory: hue relationships + lightness + saturation). */
export function harmonyScore(p: Pick<Palette3, "primary" | "secondary" | "tertiary">): number {
  return harmonyParts(p).score;
}

// ====================================================================== the generator

/** Deterministic scheme of a genome: quantile of its second hue allele in the cumulative SCHEME_WEIGHTS. */
export function schemeOf(g: Pick<Genome, "hue">): HarmonyScheme {
  const q = clamp01(g.hue[1]);
  let acc = 0;
  const total = HARMONY_SCHEMES.reduce((s, k) => s + SCHEME_WEIGHTS[k], 0);
  for (const k of HARMONY_SCHEMES) {
    acc += SCHEME_WEIGHTS[k] / total;
    if (q < acc) return k;
  }
  return HARMONY_SCHEMES[HARMONY_SCHEMES.length - 1];
}

/** Lightness pushed away from l by amt (toward the side with room). */
function contrastL(l: number, amt: number, rng: Rng): number {
  const dir = l > 0.56 ? -1 : l < 0.36 ? 1 : rng.next() < 0.5 ? -1 : 1;
  return clamp(l + dir * amt, 0.12, 0.9);
}

/** A detail colour that pops against the primary's lightness. */
function popL(l: number, rng: Rng): number {
  if (l < 0.35) return rng.range(0.6, 0.8);
  if (l > 0.7) return rng.range(0.3, 0.48);
  return rng.next() < 0.6 ? rng.range(0.6, 0.8) : rng.range(0.24, 0.38);
}

interface Candidate {
  primary: number;
  secondary: number;
  tertiary: number;
}

function primaryHsl(base: number, g: Pick<Genome, "hue">, axes: AxisVector, hybrid: boolean): Hsl {
  const e = hexToHsl(base);
  const h = e.h + (clamp01(g.hue[0]) - 0.5) * 2 * (hybrid ? PRIMARY_HUE_SHIFT * 0.5 : PRIMARY_HUE_SHIFT);
  const dl = 0.08 * (axes.luminance ?? 0) - 0.06 * Math.max(0, -(axes.substance ?? 0));
  // Pass 6 (orchestrator): body lightness tops out at 0.78 - a near-white body (light, ice, steam) that also glows
  // blows out to white under bloom and loses its shading; the hue (the sacred colour code) is untouched.
  const l = clamp(e.l + dl, Math.max(0.1, e.l - 0.12), Math.min(0.78, e.l + 0.1));
  const s = clamp(e.s * (0.86 + 0.12 * (axes.mood ?? 0)), 0.03, 1);
  return { h: e.h === 0 && e.s === 0 ? 0 : h, s, l };
}

/** Secondary + tertiary of a free (single-typed) scheme. */
function schemeCandidate(P: Hsl, scheme: HarmonyScheme, rng: Rng, tries: number): Candidate {
  const sref = Math.max(P.s, 0.5);
  const sign = rng.next() < 0.5 ? -1 : 1;
  const k = 1 + tries / MAX_TRIES; // later tries widen the lightness contrast
  let s2: Hsl, s3: Hsl;
  switch (scheme) {
    case "mono": {
      s2 = { h: P.h + rng.range(-6, 6), s: sref * rng.range(0.6, 1.05), l: contrastL(P.l, rng.range(0.18, 0.3) * k, rng) };
      const away = s2.l < P.l ? 1 : -1;
      s3 = { h: P.h + rng.range(-10, 10), s: sref * rng.range(0.4, 1), l: clamp(P.l + away * rng.range(0.2, 0.32) * k, 0.1, 0.92) };
      break;
    }
    case "analogous": {
      s2 = { h: P.h + sign * rng.range(24, 40), s: sref * rng.range(0.75, 1.05), l: contrastL(P.l, rng.range(0.06, 0.2) * k, rng) };
      s3 = { h: P.h - sign * rng.range(24, 40), s: sref * rng.range(0.7, 1.1), l: popL(P.l, rng) };
      break;
    }
    case "complementary": {
      s2 = { h: P.h + 180 + rng.range(-8, 8), s: sref * rng.range(0.42, 0.78), l: contrastL(P.l, rng.range(0.08, 0.22) * k, rng) };
      s3 = rng.next() < 0.6
        ? { h: P.h + sign * rng.range(14, 28), s: sref * rng.range(0.45, 0.85), l: popL(P.l, rng) }
        : { h: s2.h + sign * rng.range(14, 28), s: sref * rng.range(0.45, 0.8), l: popL(P.l, rng) };
      break;
    }
    case "split": {
      s2 = { h: P.h + 180 + sign * rng.range(25, 35), s: sref * rng.range(0.55, 0.9), l: contrastL(P.l, rng.range(0.08, 0.2) * k, rng) };
      s3 = { h: P.h + 180 - sign * rng.range(25, 35), s: sref * rng.range(0.45, 0.8), l: popL(P.l, rng) };
      break;
    }
    case "triad": {
      s2 = { h: P.h + sign * rng.range(114, 126), s: sref * rng.range(0.55, 0.9), l: contrastL(P.l, rng.range(0.08, 0.2) * k, rng) };
      s3 = { h: P.h - sign * rng.range(114, 126), s: sref * rng.range(0.45, 0.8), l: popL(P.l, rng) };
      break;
    }
    case "tetrad": {
      s2 = { h: P.h + sign * rng.range(84, 96), s: sref * rng.range(0.55, 0.9), l: contrastL(P.l, rng.range(0.08, 0.2) * k, rng) };
      s3 = { h: P.h + 180 + rng.range(-8, 8), s: sref * rng.range(0.45, 0.8), l: popL(P.l, rng) };
      break;
    }
  }
  return { primary: hslToHex(P.h, P.s, P.l), secondary: hslToHex(s2.h, clamp(s2.s, 0.08, 1), s2.l), tertiary: hslToHex(s3.h, clamp(s3.s, 0.08, 1), s3.l) };
}

/** Secondary locked to a second element's colour; tertiary completes the scheme its hue relationship names. */
function forcedCandidate(P: Hsl, sec: number, scheme: HarmonyScheme, rng: Rng, tries: number): Candidate {
  const E = hexToHsl(sec);
  const k = tries / MAX_TRIES;
  let l2 = clamp(E.l + rng.range(-0.08, 0.08), 0.1, 0.9);
  const pL = oklab(hslToHex(P.h, P.s, P.l)).L;
  // Same-family pairs (air + ice, electric + light): push the second colour's VALUE apart.
  const gap = Math.abs(oklab(hslToHex(E.h, E.s, l2)).L - pL);
  if (gap < 0.1 + 0.12 * k) l2 = contrastL(P.l, rng.range(0.16, 0.26) + 0.12 * k, rng);
  // The second element keeps ITS hue (+-5 jitter). When the pair sits in a discord gap (e.g. psychic + poison,
  // 65 degrees) later re-rolls slide it toward the nearest harmonic angle, at most SECONDARY_HUE_SLIDE degrees.
  const d0 = hueOffset(P.h, E.h);
  const anchor = [0, 30, 60, 90, 120, 150, 180].reduce((a, b) => (Math.abs(Math.abs(d0) - b) < Math.abs(Math.abs(d0) - a) ? b : a));
  const slide = clamp((Math.sign(d0) || 1) * anchor - d0, -SECONDARY_HUE_SLIDE, SECONDARY_HUE_SLIDE) * clamp01(k * 1.6);
  const s2: Hsl = { h: E.h + rng.range(-5, 5) * (1 - k) + slide, s: clamp(E.s * rng.range(0.75, 1), 0.04, 1), l: l2 };
  const sref = Math.max(P.s, 0.5);
  const off = hueOffset(P.h, s2.h);
  const sign = off >= 0 ? 1 : -1;
  let h3: number;
  switch (scheme) {
    case "mono":
    case "analogous":
      h3 = P.h - sign * rng.range(24, 40);
      break;
    case "complementary":
      h3 = P.h + sign * rng.range(14, 28);
      break;
    case "split":
      h3 = P.h - off + rng.range(-5, 5); // the other arm: mirror of the secondary about the primary's complement axis
      break;
    case "triad":
      h3 = P.h - sign * 120 + rng.range(-6, 6);
      break;
    case "tetrad":
      h3 = P.h + 180 + rng.range(-8, 8);
      break;
  }
  const s3: Hsl = { h: h3, s: sref * rng.range(0.45, 0.85), l: popL(P.l, rng) };
  return { primary: hslToHex(P.h, P.s, P.l), secondary: hslToHex(s2.h, s2.s, s2.l), tertiary: hslToHex(s3.h, clamp(s3.s, 0.08, 1), s3.l) };
}

type Kind = Genome["kind"];

/** Which part wears which role (deterministic; see the module doc). */
export function attributionOf(scheme: HarmonyScheme, kind: Kind, element: ElementId, colors: 2 | 3, rng: Rng): Record<ColourPart, ColourRole> {
  const r = () => rng.next();
  const colourful = scheme === "triad" || scheme === "tetrad" || scheme === "split";
  const a: Record<ColourPart, ColourRole> = {
    body: "primary",
    back: "primary",
    head: "primary",
    markings: "secondary",
    belly: scheme === "mono" ? "primary" : r() < (scheme === "complementary" ? 0.15 : colourful ? 0.4 : 0.3) ? "secondary" : "primary",
    limbs: kind === "avian" ? (r() < 0.5 ? "tertiary" : "primary") : kind === "hexapod" ? (r() < 0.4 ? "secondary" : "primary") : colourful && r() < 0.5 ? "secondary" : "primary",
    tail: ((x) => (x < (colourful ? 0.2 : 0.1) ? "tertiary" : x < 0.5 ? "secondary" : "primary"))(r()),
    wings: ((x) => (x < 0.15 ? "tertiary" : x < (kind === "avian" ? 0.75 : 0.6) ? "secondary" : "primary"))(r()),
    horns: r() < (colourful ? 0.6 : 0.4) ? "tertiary" : "secondary",
    eyes: r() < 0.7 ? "tertiary" : "secondary",
    glow: SELF_GLOW.has(element) ? "primary" : "tertiary",
  };
  if (colors === 2) for (const p of COLOUR_PARTS) if (a[p] === "tertiary") a[p] = "secondary";
  return a;
}

/** Full result: Palette3 plus how it was reached (for tests and the QA sheet). */
export interface Palette3Detail extends Palette3 {
  attribution: Record<ColourPart, ColourRole>;
  /** Hybrid identity id (steam, magma...) or the element id. */
  identity: string;
  /** Re-rolls spent inside the scheme (0 = first candidate passed the floor). */
  rerolls: number;
  /** True when the secondary is a second element's colour (dual type / hybrid parent). */
  forced: boolean;
  colors: 2 | 3;
}

/**
 * The palette of a genome expressed with these axes and types [P6-K1]. `colors` = 2 for minimal globes
 * (src/genome/complexity.ts complexityOf(g).colors); default 3.
 */
export function palette3Of(g: Pick<Genome, "hue" | "kind">, axes: AxisVector, primary: ElementId, secondary: ElementId | null, colors: 2 | 3 = 3): Palette3Detail {
  const secondaryLevel = secondary ? clamp01(elementAffinities(axes)[secondary]) : 0;
  const id = identityOfPhenotype({ axes, elements: { primary, secondary, secondaryLevel } });
  const hybrid = id.hybrid ? hybridOfId(id.id) : null;
  const P = primaryHsl(id.hybrid ? id.color : ELEMENTS[primary].color, g, axes, id.hybrid);
  // The second element: the typed secondary, else the hybrid's other parent.
  let second: ElementId | null = secondary;
  if (!second && hybrid) second = hybrid.a === primary ? hybrid.b : hybrid.b === primary ? hybrid.a : null;
  if (second === primary) second = null;
  const forced = second !== null;
  const scheme: HarmonyScheme = forced ? classifyScheme(hueDistance(P.h, hexToHsl(ELEMENTS[second!].color).h)) : schemeOf(g);
  const rng = new Rng(hashSeed("p6-palette", Math.round(clamp01(g.hue[0]) * 1e6), Math.round(clamp01(g.hue[1]) * 1e6), primary, second ?? "-"));
  let best: Candidate | null = null, bestScore = -1, rerolls = 0;
  for (let t = 0; t < MAX_TRIES; t++) {
    let c = forced ? forcedCandidate(P, ELEMENTS[second!].color, scheme, rng, t) : schemeCandidate(P, scheme, rng, t);
    if (colors === 2) c = { ...c, tertiary: c.secondary };
    const s = harmonyScore(c);
    if (s > bestScore) {
      best = c;
      bestScore = s;
    }
    rerolls = t;
    if (s >= HARMONY_FLOOR) break;
  }
  const c = best!;
  const attribution = attributionOf(scheme, g.kind, primary, colors, new Rng(hashSeed("p6-attr", Math.round(clamp01(g.hue[1]) * 1e6), g.kind, primary)));
  return { primary: c.primary, secondary: c.secondary, tertiary: c.tertiary, scheme, harmony: bestScore, attribution, element: primary, identity: id.id, rerolls, forced, colors };
}

function hybridOfId(idv: string): Hybrid | null {
  return HYBRIDS.find((h) => h.id === idv) ?? null;
}

// ====================================================================== consumers

/** The colour a part wears (attribution falls back to DEFAULT_ATTRIBUTION). */
export function roleOf(p: Pick<Palette3, "attribution">, part: ColourPart): ColourRole {
  return p.attribution[part] ?? DEFAULT_ATTRIBUTION[part];
}
export function partColor(p: Pick<Palette3, "primary" | "secondary" | "tertiary" | "attribution">, part: ColourPart): number {
  return p[roleOf(p, part)];
}

/** A light belly tint of a colour (pale, low saturation, keeps the hue). */
export function bellyTint(c: number): number {
  const h = hexToHsl(c);
  return hslToHex(h.h, h.s * 0.45, clamp(h.l + 0.25, 0.3, 0.9));
}

/** A bright emissive version of a colour. */
export function glowTint(c: number): number {
  const h = hexToHsl(c);
  return hslToHex(h.h, Math.max(h.s, 0.75), clamp(Math.max(h.l, 0.68), 0.68, 0.85));
}

/** Pass-5 Palette shape (structurally phenotype.ts Palette; kept local so palette.ts never imports phenotype.ts). */
export interface PaletteLike {
  base: number;
  accent: number;
  belly: number;
  eye: number;
  glow: number;
}

/**
 * Maps a Palette3 back onto the pass-5 Palette so every existing consumer benefits: base = primary,
 * accent = secondary, belly = tint of the belly role, eye = the eyes role, glow = the glow role (a
 * primary glow keeps the element core / hybrid glow of `prev`, a tertiary glow is a bright tertiary).
 */
export function paletteFromP3(p: Palette3, prev: PaletteLike): PaletteLike {
  const eyeH = hexToHsl(partColor(p, "eyes"));
  return {
    base: p.primary,
    accent: p.secondary,
    belly: bellyTint(partColor(p, "belly")),
    eye: hslToHex(eyeH.h, Math.max(0.6, eyeH.s), clamp(eyeH.l, 0.45, 0.65)),
    glow: roleOf(p, "glow") === "primary" ? prev.glow : glowTint(partColor(p, "glow")),
  };
}
