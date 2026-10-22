/**
 * Procedural textures. Pass 5 [P5-V7, P5-V8]: every creature texture is painted into a PURE `Raster`
 * (Float32 RGBA, no DOM) and uploaded as a THREE.DataTexture, so the painters are unit-testable headless
 * (tests/skin_p5_test.ts reads their pixels) and identical in the browser.
 *
 * UV convention (anatomy/loft.ts): x = u AROUND the section (0.25 = dorsal, 0.75 = ventral, wraps),
 * y = v ALONG the part (row 0 = v 0 = root). Rasters are tileable in both directions.
 *
 *  - paintSkin: the BACK — base colour, a dorsal/ventral countershade along u, the genome PATTERN
 *    (stripes, spots, mottle, rings, scales, gradient, veins), then up to 3 OVERLAY layers
 *    (mottle under spots under stripes; stripes element-coloured with SkinP5.stripes strength).
 *  - paintBelly: the BELLY's own texture, lighter (SkinP5.bellyContrast) with transverse ventral SCUTES
 *    (serpents), soft fur (furred), plates (armoured), feather scallops, or soft folds.
 *  - paintRelief: the height field behind the normal map, per coat (scales, fur, feathers, leaves,
 *    chitin, slime, bark, crystal) or, for bare skin, per pattern; normalFromHeight turns it into a map.
 *  - paintScar: pale scar tissue with darker edges (slash, claw, burn, frost, bolt, acid).
 *  - fur alpha, feather card and leaf card sprites for anatomy/coat.ts.
 */
import * as THREE from "../lib/three.ts";
import { Rng } from "../core/rng.ts";
import type { Phenotype } from "../genome/phenotype.ts";
import type { CoatKind, SkinP5 } from "../genome/morphTypes.ts";
import { ELEMENTS } from "../data/elements.ts";

export type RGB = [number, number, number];

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : Number.isFinite(x) ? x : 0);
const clamp = (x: number, lo: number, hi: number) => (Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : lo);
export const rgbOf = (c: number): RGB => [((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255];
export const mixRGB = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export const scaleRGB = (a: RGB, k: number): RGB => [clamp01(a[0] * k), clamp01(a[1] * k), clamp01(a[2] * k)];
export const lum = (c: RGB | Float32Array, i = 0) => 0.299 * c[i] + 0.587 * c[i + 1] + 0.114 * c[i + 2];
const WHITE: RGB = [1, 1, 1];
const BLACK: RGB = [0, 0, 0];

// ====================================================================== the pure raster

/** A tileable float RGBA image (values are display-encoded 0..1, like a canvas). Row 0 = v 0. */
export class Raster {
  readonly data: Float32Array;
  constructor(readonly w: number, readonly h: number, fill: RGB = BLACK, alpha = 1) {
    this.data = new Float32Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      this.data[i * 4] = fill[0];
      this.data[i * 4 + 1] = fill[1];
      this.data[i * 4 + 2] = fill[2];
      this.data[i * 4 + 3] = alpha;
    }
  }
  clone(): Raster {
    const r = new Raster(this.w, this.h);
    r.data.set(this.data);
    return r;
  }
  /** Index of the wrapped pixel (x, y). */
  at(x: number, y: number): number {
    const w = this.w, h = this.h;
    const xi = ((Math.floor(x) % w) + w) % w, yi = ((Math.floor(y) % h) + h) % h;
    return (yi * w + xi) * 4;
  }
  /** Source-over blend of a colour with alpha a (wrapped coordinates). */
  blend(x: number, y: number, c: RGB, a: number): void {
    if (a <= 0) return;
    const i = this.at(x, y), d = this.data, t = a > 1 ? 1 : a;
    d[i] += (c[0] - d[i]) * t;
    d[i + 1] += (c[1] - d[i + 1]) * t;
    d[i + 2] += (c[2] - d[i + 2]) * t;
  }
  /** Blend toward a value in the ALPHA channel (cards, fur). */
  alphaTo(x: number, y: number, v: number, a: number): void {
    const i = this.at(x, y) + 3;
    this.data[i] += (v - this.data[i]) * clamp01(a);
  }
  /** Multiply the colour (darken < 1 < lighten). */
  mul(x: number, y: number, k: number): void {
    const i = this.at(x, y), d = this.data;
    d[i] = clamp01(d[i] * k);
    d[i + 1] = clamp01(d[i + 1] * k);
    d[i + 2] = clamp01(d[i + 2] * k);
  }
  /** Soft radial blob: alpha a at the centre falling to 0 at radius rad (smooth). */
  blob(cx: number, cy: number, rad: number, c: RGB, a: number, hard = 0): void {
    const r = Math.max(0.5, rad);
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / r;
        if (d >= 1) continue;
        const s = 1 - d;
        const f = hard > 0 ? clamp01(s / Math.max(1e-3, 1 - hard)) : s * s * (3 - 2 * s);
        this.blend(x, y, c, a * f);
      }
    }
  }
  /** Filled anti-aliased ellipse (rotation rot, edge softness in px). */
  ellipse(cx: number, cy: number, rx: number, ry: number, rot: number, c: RGB, a: number, soft = 1): void {
    const R = Math.max(rx, ry) + soft + 1, co = Math.cos(rot), si = Math.sin(rot);
    for (let y = Math.floor(cy - R); y <= Math.ceil(cy + R); y++) {
      for (let x = Math.floor(cx - R); x <= Math.ceil(cx + R); x++) {
        const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
        const lx = dx * co + dy * si, ly = -dx * si + dy * co;
        const e = Math.hypot(lx / Math.max(0.5, rx), ly / Math.max(0.5, ry));
        const edge = (e - 1) * Math.min(rx, ry);
        const cov = clamp01(0.5 - edge / Math.max(0.5, soft));
        if (cov > 0) this.blend(x, y, c, a * cov);
      }
    }
  }
  /** Anti-aliased thick segment. */
  line(x0: number, y0: number, x1: number, y1: number, width: number, c: RGB, a: number, soft = 0.8): void {
    const hw = width / 2, pad = hw + soft + 1;
    const dx = x1 - x0, dy = y1 - y0, L2 = dx * dx + dy * dy || 1e-9;
    for (let y = Math.floor(Math.min(y0, y1) - pad); y <= Math.ceil(Math.max(y0, y1) + pad); y++) {
      for (let x = Math.floor(Math.min(x0, x1) - pad); x <= Math.ceil(Math.max(x0, x1) + pad); x++) {
        const px = x + 0.5, py = y + 0.5;
        const t = clamp01(((px - x0) * dx + (py - y0) * dy) / L2);
        const d = Math.hypot(px - (x0 + dx * t), py - (y0 + dy * t));
        const cov = clamp01((hw + soft * 0.5 - d) / Math.max(0.3, soft));
        if (cov > 0) this.blend(x, y, c, a * cov);
      }
    }
  }
  /** A horizontal (constant-v) band across the full width, optionally wavy, with soft edges. */
  band(cy: number, halfW: number, c: RGB, a: number, wave = 0, phase = 0, mask?: (x: number) => number): void {
    for (let x = 0; x < this.w; x++) {
      const yc = cy + wave * Math.sin((x / this.w) * Math.PI * 4 + phase);
      const m = mask ? mask(x) : 1;
      if (m <= 0) continue;
      for (let y = Math.floor(yc - halfW - 1); y <= Math.ceil(yc + halfW + 1); y++) {
        const cov = clamp01(halfW + 0.5 - Math.abs(y + 0.5 - yc));
        if (cov > 0) this.blend(x, y, c, a * cov * m);
      }
    }
  }
  /** Mean luminance over a rectangle (wrapped, inclusive-exclusive). */
  meanLum(x0: number, y0: number, x1: number, y1: number): number {
    let s = 0, n = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        s += lum(this.data, this.at(x, y));
        n++;
      }
    }
    return n ? s / n : 0;
  }
  /** 8-bit RGBA bytes (for DataTexture upload). */
  bytes(): Uint8Array {
    const out = new Uint8Array(this.data.length);
    for (let i = 0; i < out.length; i++) out[i] = Math.round(clamp01(this.data[i]) * 255);
    return out;
  }
}

/** Dorsal weight of a column: 1 on the dorsal line (u 0.25), 0 from the flanks to the belly. */
export const dorsalOf = (u: number) => Math.max(0, Math.cos(2 * Math.PI * (u - 0.25)));
/** Ventral weight: 1 on the ventral line (u 0.75). */
export const ventralOf = (u: number) => Math.max(0, -Math.cos(2 * Math.PI * (u - 0.25)));

// ====================================================================== DataTexture wrappers

/** Upload a raster (or raw RGBA bytes) as a repeat-wrapped, mip-mapped DataTexture. */
export function dataTexture(src: Raster | { bytes: Uint8Array; w: number; h: number }, color: boolean): THREE.DataTexture {
  const bytes = src instanceof Raster ? src.bytes() : src.bytes;
  const t = new THREE.DataTexture(bytes, src.w, src.h, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

// ====================================================================== colours

/** The element colour (the colour code is sacred: water blue, fire red, electric yellow...). */
export function elementRGB(ph: Phenotype): RGB {
  return rgbOf(ELEMENTS[ph.elements.primary]?.color ?? ph.palette.accent);
}

/** Back (dorsal) base colour and the belly colour for a given contrast. Belly is always >= back in luminance. */
export function countershadeColors(ph: Phenotype, contrast: number): { back: RGB; belly: RGB } {
  const k = clamp01(contrast);
  const base = rgbOf(ph.palette.base);
  const pb = rgbOf(ph.palette.belly);
  // The belly keeps a trace of the base hue, lightened with contrast; never darker than the back.
  let belly = mixRGB(base, mixRGB(pb, WHITE, 0.18 + 0.32 * k), 0.25 + 0.75 * k);
  if (lum(belly) < lum(base) + 0.04 * k) belly = mixRGB(belly, WHITE, 0.25 * k + 0.05);
  return { back: base, belly };
}

// ====================================================================== the back (skin colour)

const STRIPE_N = (ph: Phenotype) => 4 + Math.round(((ph.axes.structure + 1) / 2) * 6);

function patternLayer(r: Raster, kind: string, c: RGB, alpha: number, rng: Rng, ph: Phenotype, emissive?: Raster): void {
  const size = r.w, order = (ph.axes.structure + 1) / 2;
  switch (kind) {
    case "stripes": {
      const n = STRIPE_N(ph);
      for (let i = 0; i < n; i++) {
        r.band(((i + 0.5) / n) * size, size / (n * 5.2), c, alpha, size * 0.03 * (1 - order), i, (x) => 0.3 + 0.7 * dorsalOf(x / size) + 0.15);
      }
      break;
    }
    case "spots": {
      for (let i = 0; i < 26; i++) {
        let x = rng.next() * size;
        if (ventralOf(x / size) > 0.6) x = (x + size * 0.5) % size; // spots live on the back and flanks
        r.ellipse(x, rng.next() * size, size * (0.02 + rng.next() * 0.05), size * (0.02 + rng.next() * 0.045), rng.next() * 3, c, alpha, 1.2);
      }
      break;
    }
    case "mottle": {
      for (let i = 0; i < 60; i++) {
        r.ellipse(rng.next() * size, rng.next() * size, size * (0.03 + rng.next() * 0.08), size * (0.02 + rng.next() * 0.05), rng.next() * 3, c, alpha * 0.45, 3);
      }
      break;
    }
    case "rings": {
      for (let i = 0; i < 6; i++) r.band((i / 6) * size + size / 44, size / 44, c, alpha);
      break;
    }
    case "scales": {
      const s = size / 12;
      for (let row = 0, y = 0; y < size + s; row++, y += s * 0.75) {
        for (let x = row % 2 ? s / 2 : 0; x < size + s; x += s) {
          for (let k = 0; k < 10; k++) {
            const a0 = Math.PI + (k / 10) * Math.PI, a1 = Math.PI + ((k + 1) / 10) * Math.PI;
            r.line(x + Math.cos(a0) * s / 2, y + Math.sin(a0) * s / 2, x + Math.cos(a1) * s / 2, y + Math.sin(a1) * s / 2, 1.5, c, alpha * 0.5);
          }
        }
      }
      break;
    }
    case "gradient": {
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) r.blend(x, y, c, alpha * 0.7 * ((x + y) / (2 * size)));
      break;
    }
    case "veins": {
      const glow = rgbOf(ph.palette.glow);
      for (let k = 0; k < 9; k++) {
        let x = rng.next() * size, y = rng.next() * size;
        for (let s = 0; s < 14; s++) {
          const nx = x + (rng.next() - 0.5) * 34 * (size / 256), ny = y + (rng.next() - 0.3) * 22 * (size / 256);
          r.line(x, y, nx, ny, 2, c, alpha);
          emissive?.line(x, y, nx, ny, 2, glow, 1);
          x = nx;
          y = ny;
        }
      }
      break;
    }
    default:
      break;
  }
}

/** The overlay stack painted above the base pattern, bottom to top (mottle < spots < stripes). */
export function overlayLayers(ph: Phenotype, p5: SkinP5): ("mottle" | "spots" | "stripes")[] {
  const n = Math.round(clamp(p5.overlays, 0, 3));
  const out: ("mottle" | "spots" | "stripes")[] = [];
  const wantStripes = p5.stripes > 0.05;
  const pool = (["mottle", "spots"] as const).filter((k) => k !== ph.pattern);
  for (const k of pool) if (out.length < n - (wantStripes ? 1 : 0)) out.push(k);
  if (wantStripes && ph.pattern !== "stripes") out.push("stripes");
  else if (wantStripes && ph.pattern === "stripes" && out.length < 3) out.push("stripes"); // a second, offset stripe set
  return out.slice(0, 3);
}

export interface SkinPaint {
  map: Raster;
  /** Emissive veins (glowing Genemon), null when the pattern has none. */
  emissive: Raster | null;
}

/** The back: base colour + countershade along u + pattern + overlays. */
export function paintSkin(ph: Phenotype, p5: SkinP5, seed: number, size = 256): SkinPaint {
  const rng = new Rng(seed);
  const { back, belly } = countershadeColors(ph, p5.bellyContrast);
  const accent = rgbOf(ph.palette.accent);
  const r = new Raster(size, size, back);
  const k = clamp01(p5.bellyContrast);
  // Fine grain so even "solid" skins are not flat plastic.
  const grains = Math.round(900 * (size * size) / (256 * 256));
  for (let i = 0; i < grains; i++) {
    const c = rng.next() < 0.5 ? BLACK : WHITE, a = 0.03 + rng.next() * 0.04, x = rng.next() * size, y = rng.next() * size;
    r.blend(x, y, c, a);
    r.blend(x + 1, y, c, a);
    r.blend(x, y + 1, c, a);
    r.blend(x + 1, y + 1, c, a);
  }
  let emissive: Raster | null = null;
  if (ph.pattern === "veins") emissive = new Raster(size, size, BLACK);
  patternLayer(r, ph.pattern, accent, 1, rng, ph, emissive ?? undefined);
  // Overlays (element-coloured): mottle darker accent, spots accent/element, stripes element colour.
  const el = elementRGB(ph);
  for (const layer of overlayLayers(ph, p5)) {
    const lr = new Rng((seed ^ (layer === "stripes" ? 0x5717 : layer === "spots" ? 0x5b07 : 0x3077)) >>> 0);
    if (layer === "mottle") patternLayer(r, "mottle", scaleRGB(mixRGB(back, accent, 0.5), 0.8), 0.8, lr, ph);
    else if (layer === "spots") patternLayer(r, "spots", mixRGB(accent, el, 0.4), 0.85, lr, ph);
    else {
      const strength = clamp01(p5.stripes);
      const n = STRIPE_N(ph) + (ph.pattern === "stripes" ? 3 : 0);
      const col = mixRGB(scaleRGB(el, 0.7), scaleRGB(accent, 0.6), 0.3);
      for (let i = 0; i < n; i++) {
        const cy = ((i + 0.25) / n) * size;
        r.band(cy, size / (n * 4.5) * (0.6 + 0.6 * lr.next()), col, strength, size * 0.02, i * 1.7, (x) => dorsalOf(x / size) * 0.85 + 0.15);
      }
    }
  }
  // Countershade baked along u, OVER the pattern (it fades onto the belly): a darker dorsal saddle,
  // flanks easing into the belly colour.
  for (let x = 0; x < size; x++) {
    const u = x / size, d = dorsalOf(u), v = ventralOf(u);
    for (let y = 0; y < size; y++) {
      r.mul(x, y, 1 - 0.25 * k * d);
      if (v > 0) r.blend(x, y, belly, 0.7 * k * v * v);
    }
  }
  return { map: r, emissive };
}

// ====================================================================== the belly

export type BellyStyle = "scutes" | "fur" | "plates" | "feathers" | "folds";

export function bellyStyle(ph: Phenotype, coat: CoatKind, plates: number, fur: number): BellyStyle {
  if (ph.kind === "serpent" || coat === "scales") return "scutes";
  if (coat === "chitin" || coat === "crystal" || coat === "bark" || plates > 0.55) return "plates";
  if (coat === "feathers" || ph.kind === "avian") return "feathers";
  if (coat === "fur" || fur > 0.4) return "fur";
  return "folds";
}

/** The belly's own colour texture (lighter, countershaded) and its own relief (for its normal map). */
export function paintBelly(ph: Phenotype, p5: SkinP5, style: BellyStyle, seed: number, size = 128): { map: Raster; height: Raster } {
  const rng = new Rng((seed ^ 0xbe11) >>> 0);
  const { belly } = countershadeColors(ph, p5.bellyContrast);
  const r = new Raster(size, size, belly);
  const h = new Raster(size, size, [0.5, 0.5, 0.5]);
  const dark = scaleRGB(belly, 0.82), light = mixRGB(belly, WHITE, 0.25);
  switch (style) {
    case "scutes": {
      // Transverse ventral plates: one wide scute per row band, a groove at its trailing edge.
      const n = 9;
      for (let i = 0; i < n; i++) {
        const y0 = (i / n) * size, s = size / n;
        for (let y = 0; y < s; y++) {
          const t = y / s;
          for (let x = 0; x < size; x++) {
            r.mul(x, y0 + y, 0.93 + 0.12 * t);
            h.blend(x, y0 + y, [0.35 + 0.5 * t, 0.35 + 0.5 * t, 0.35 + 0.5 * t], 1);
          }
        }
        r.band(y0, Math.max(0.8, s * 0.06), dark, 0.9);
        h.band(y0, Math.max(0.8, s * 0.06), [0.1, 0.1, 0.1], 1);
        r.band(y0 + s * 0.12, Math.max(0.5, s * 0.04), light, 0.6);
      }
      break;
    }
    case "plates": {
      const cw = Math.max(4, Math.round(size / 12)), chh = Math.max(4, Math.round(size / 9));
      for (let row = 0; row * chh < size; row++) {
        const off = row % 2 ? cw / 2 : 0;
        for (let col = -1; col * cw < size + cw; col++) {
          const x = col * cw + off, y = row * chh;
          r.line(x, y, x + cw, y, 1.4, dark, 0.8);
          r.line(x, y, x, y + chh, 1.4, dark, 0.8);
          h.line(x, y, x + cw, y, 1.6, [0.15, 0.15, 0.15], 1);
          h.line(x, y, x, y + chh, 1.6, [0.15, 0.15, 0.15], 1);
          h.blob(x + cw / 2, y + chh / 2, Math.min(cw, chh) * 0.55, [0.8, 0.8, 0.8], 0.6);
        }
      }
      break;
    }
    case "feathers": {
      const s = size / 10;
      for (let row = 0, y = 0; y < size + s; row++, y += s * 0.6) {
        for (let x = row % 2 ? s / 2 : 0; x < size + s; x += s) {
          r.ellipse(x, y, s * 0.48, s * 0.62, 0, rng.next() < 0.5 ? light : belly, 0.5, 1.5);
          h.blob(x, y, s * 0.6, [0.75, 0.75, 0.75], 0.5);
        }
      }
      break;
    }
    case "fur": {
      const strands = Math.round(size * size * 0.12);
      for (let i = 0; i < strands; i++) {
        const x = rng.next() * size, y = rng.next() * size, l = 2 + rng.next() * 3;
        const c = rng.next() < 0.5 ? light : dark;
        r.line(x, y, x + (rng.next() - 0.5) * 1.2, y + l, 0.8, c, 0.25);
        h.line(x, y, x + (rng.next() - 0.5) * 1.2, y + l, 0.8, rng.next() < 0.5 ? [0.7, 0.7, 0.7] : [0.3, 0.3, 0.3], 0.35);
      }
      break;
    }
    case "folds": {
      for (let i = 0; i < 14; i++) {
        const y = ((i + 0.5) / 14) * size;
        r.band(y, size / 90 + 0.4, dark, 0.22, size * 0.01, i);
        h.band(y, size / 70 + 0.5, [0.32, 0.32, 0.32], 0.7, size * 0.01, i);
      }
      break;
    }
  }
  // A paler ventral midline (u 0.75) so the belly reads even from a low angle.
  for (let x = 0; x < size; x++) {
    const v = ventralOf(x / size);
    if (v > 0.6) for (let y = 0; y < size; y++) r.blend(x, y, light, 0.25 * (v - 0.6) / 0.4);
  }
  return { map: r, height: h };
}

// ====================================================================== relief (height -> normal map)

export interface ReliefGenes {
  patternScale: number;
  patternContrast: number;
  plates: number;
  fur: number;
}

const G = (v: number): RGB => [v, v, v];

/** Height field (grey, 0.5 = flat) for the coat (or, for bare skin, the pattern). */
export function paintRelief(ph: Phenotype, S: ReliefGenes, coat: CoatKind, seed: number, size = 256): Raster {
  const rng = new Rng((seed ^ 0x51ed27) >>> 0);
  const h = new Raster(size, size, G(0.5));
  const ps = clamp(S.patternScale, 0.5, 2);
  const plates = clamp01(S.plates);
  const contrast = 0.5 + 0.5 * clamp01(S.patternContrast);
  const k = size / 256;
  // Low-frequency undulation so even smooth skins are not plastic.
  for (let i = 0; i < 10; i++) h.blob(rng.next() * size, rng.next() * size, size * (0.1 + rng.next() * 0.15), G(rng.next() < 0.5 ? 0.35 : 0.67), 0.35);

  const scaleTiles = (per: number, elong = 1) => {
    const s = size / per;
    for (let row = 0, y = 0; y < size + s; row++, y += s * 0.75 * elong) {
      for (let x = row % 2 ? s / 2 : 0; x < size + s; x += s) {
        // Raised half-disc: high at the centre, a groove at the free edge.
        const R = s * 0.55;
        for (let yy = Math.floor(y - R * elong); yy <= y; yy++) {
          for (let xx = Math.floor(x - R); xx <= Math.ceil(x + R); xx++) {
            const d = Math.hypot((xx + 0.5 - x) / R, (yy + 0.5 - y) / (R * elong));
            if (d >= 1) continue;
            const v = d < 0.75 ? 0.5 + 0.35 * contrast * (1 - d / 0.75) + 0.05 : 0.55 - 0.32 * contrast * ((d - 0.75) / 0.25);
            h.blend(xx, yy, G(v), 1);
          }
        }
      }
    }
  };

  switch (coat) {
    case "scales":
      scaleTiles(Math.max(6, Math.round((16 - 8 * plates) / ps)));
      break;
    case "feathers": {
      scaleTiles(Math.max(5, Math.round(9 / ps)), 1.6);
      for (let i = 0; i < size * 6; i++) {
        const x = rng.next() * size, y = rng.next() * size;
        h.line(x, y, x + 2.5 * k, y + 1.2 * k, 0.7, G(rng.next() < 0.5 ? 0.42 : 0.6), 0.4);
      }
      break;
    }
    case "fur": {
      const strands = Math.round(size * size * 0.09);
      for (let i = 0; i < strands; i++) {
        const x = rng.next() * size, y = rng.next() * size, l = (2 + rng.next() * 4) * k;
        h.line(x, y, x + (rng.next() - 0.5) * 1.5, y + l, 0.9, G(rng.next() < 0.5 ? 0.27 : 0.75), 0.4);
      }
      break;
    }
    case "leaves": {
      // Overlapping leaf scallops with a raised midrib each.
      const s = size / Math.max(4, Math.round(7 / ps));
      for (let row = 0, y = 0; y < size + s; row++, y += s * 0.7) {
        for (let x = row % 2 ? s / 2 : 0; x < size + s; x += s) {
          h.ellipse(x, y, s * 0.42, s * 0.6, 0, G(0.66), 0.8, s * 0.2);
          h.line(x, y - s * 0.55, x, y + s * 0.55, 1.4 * k + 0.6, G(0.85), 0.8);
          h.ellipse(x, y, s * 0.44, s * 0.62, 0, G(0.3), 0.15, 1);
        }
      }
      break;
    }
    case "chitin": {
      // Transverse segments (sclerites) with sharp grooves, a dorsal midline suture and lateral sutures.
      const n = Math.max(4, Math.round(7 / ps));
      const s = size / n;
      for (let y = 0; y < size; y++) {
        const t = (y % s) / s;
        const v = 0.35 + 0.45 * Math.sin(Math.PI * Math.min(1, t * 1.15)) ** 0.6;
        for (let x = 0; x < size; x++) h.blend(x, y, G(v), 1);
      }
      for (let i = 0; i < n; i++) h.band(i * s, 1.2 * k + 0.5, G(0.08), 1);
      h.line(size * 0.25, 0, size * 0.25, size, 2 * k + 0.6, G(0.15), 0.9);
      h.line(size * 0.0, 0, size * 0.0, size, 1.5 * k + 0.6, G(0.25), 0.7);
      h.line(size * 0.5, 0, size * 0.5, size, 1.5 * k + 0.6, G(0.25), 0.7);
      break;
    }
    case "slime": {
      // Wet and smooth: soft swells and a few small bubbles, low relief.
      for (let i = 0; i < 18; i++) h.blob(rng.next() * size, rng.next() * size, size * (0.06 + rng.next() * 0.1), G(0.62), 0.5);
      for (let i = 0; i < 40; i++) h.blob(rng.next() * size, rng.next() * size, size * (0.008 + rng.next() * 0.02), G(0.85), 0.8, 0.5);
      break;
    }
    case "bark": {
      // Ridges running ALONG the part (constant u), wavy, cut by dark cracks.
      const freq = Math.round(12 / ps);
      const ph0 = rng.next() * 6;
      for (let y = 0; y < size; y++) {
        const wob = Math.sin((y / size) * Math.PI * 4 + ph0) * 0.6 + Math.sin((y / size) * Math.PI * 10) * 0.25;
        for (let x = 0; x < size; x++) {
          const a = Math.abs(Math.sin(((x / size) * freq + wob * 0.15) * Math.PI));
          h.blend(x, y, G(0.25 + 0.6 * a ** 0.7), 1);
        }
      }
      for (let i = 0; i < 26; i++) {
        const x = rng.next() * size, y = rng.next() * size, l = size * (0.05 + rng.next() * 0.12);
        h.line(x, y, x + (rng.next() - 0.5) * 3, y + l, 1.6 * k + 0.6, G(0.05), 0.9);
      }
      break;
    }
    case "crystal": {
      // Voronoi facets: each cell is a flat tilted plane -> a faceted normal map.
      const N = Math.max(14, Math.round(36 / ps));
      const pts = Array.from({ length: N }, () => ({ x: rng.next() * size, y: rng.next() * size, a: (rng.next() - 0.5) * 0.02 / k, b: (rng.next() - 0.5) * 0.02 / k }));
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          let best = 1e9, bp = pts[0], bdx = 0, bdy = 0;
          for (const p of pts) {
            let dx = x - p.x, dy = y - p.y;
            if (dx > size / 2) dx -= size;
            else if (dx < -size / 2) dx += size;
            if (dy > size / 2) dy -= size;
            else if (dy < -size / 2) dy += size;
            const d = dx * dx + dy * dy;
            if (d < best) {
              best = d;
              bp = p;
              bdx = dx;
              bdy = dy;
            }
          }
          h.blend(x, y, G(clamp01(0.5 + bp.a * bdx + bp.b * bdy)), 1);
        }
      }
      break;
    }
    default: {
      // Bare skin: relief follows the colour pattern (pass-4 behaviour).
      if (ph.pattern === "scales" || plates > 0.3) {
        if (ph.pattern === "scales" && plates <= 0.3) scaleTiles(12);
        else {
          const per = Math.max(3, Math.round((18 - 13 * plates) / ps));
          const s = size / per, groove = Math.max(1, s * (0.05 + 0.06 * plates));
          for (let row = 0; row < per; row++) {
            const off = row % 2 ? s / 2 : 0;
            for (let col = -1; col <= per; col++) {
              const x0 = col * s + off, y0 = row * s;
              for (let y = Math.floor(y0 + groove); y < y0 + s - groove; y++) {
                for (let x = Math.floor(x0 + groove); x < x0 + s - groove; x++) {
                  const t = ((x - x0) + (y - y0)) / (2 * s);
                  h.blend(x, y, G(0.5 + (0.31 - 0.24 * t) * contrast), 1);
                }
              }
            }
          }
          for (let row = 0; row <= per; row++) h.band(row * s, groove / 2, G(0.5 - 0.35 * contrast), 1);
        }
      } else if (ph.pattern === "spots" || ph.pattern === "mottle") {
        const nb = Math.round((ph.pattern === "spots" ? 30 : 60) / ps);
        for (let i = 0; i < nb; i++) h.blob(rng.next() * size, rng.next() * size, size * (0.025 + rng.next() * 0.06) * ps, G(0.5 + 0.39 * contrast), 0.8);
      } else if (ph.pattern === "stripes" || ph.pattern === "rings") {
        const n = ph.pattern === "stripes" ? STRIPE_N(ph) : 6;
        for (let i = 0; i < n; i++) {
          const y = ph.pattern === "stripes" ? ((i + 0.5) / n) * size : (i / 6) * size + size / 44;
          h.band(y, size / (n * 4.4), G(0.5 + 0.37 * contrast), 0.8);
        }
      } else if (ph.pattern === "veins") {
        for (let kk = 0; kk < 9; kk++) {
          let x = rng.next() * size, y = rng.next() * size;
          for (let s = 0; s < 14; s++) {
            const nx = x + (rng.next() - 0.5) * 34 * k, ny = y + (rng.next() - 0.3) * 22 * k;
            h.line(x, y, nx, ny, Math.max(1.5, size / 110), G(0.5 + 0.35 * contrast), 1);
            x = nx;
            y = ny;
          }
        }
      }
      const fur = clamp01(S.fur);
      if (fur > 0.3) {
        const strands = Math.round(size * size * 0.05 * fur);
        for (let i = 0; i < strands; i++) {
          const x = rng.next() * size, y = rng.next() * size, l = 2 + rng.next() * 4;
          h.line(x, y, x + (rng.next() - 0.5) * 1.5, y + l, 0.8, G(rng.next() < 0.5 ? 0.27 : 0.75), 0.35);
        }
      }
    }
  }
  // Pores / micro noise.
  for (let i = 0; i < size * 5; i++) h.blend(rng.next() * size, rng.next() * size, G(rng.next() < 0.5 ? 0.39 : 0.61), 0.5);
  return h;
}

/** Sobel tangent-space normal map from a height raster (R channel), OpenGL convention, tileable. */
export function normalFromHeight(src: Raster, strength: number): Raster {
  const w = src.w, hh = src.h, d = src.data;
  const H = (x: number, y: number) => d[((((y + hh) % hh) * w) + ((x + w) % w)) * 4];
  const out = new Raster(w, hh);
  const o = out.data;
  for (let y = 0; y < hh; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (H(x + 1, y - 1) + 2 * H(x + 1, y) + H(x + 1, y + 1)) - (H(x - 1, y - 1) + 2 * H(x - 1, y) + H(x - 1, y + 1));
      const dy = (H(x - 1, y + 1) + 2 * H(x, y + 1) + H(x + 1, y + 1)) - (H(x - 1, y - 1) + 2 * H(x, y - 1) + H(x + 1, y - 1));
      // Row 0 is v 0 (DataTexture, no flip), so +y in the raster is +v: the green channel is +dh/dv.
      let nx = -dx * strength, ny = -dy * strength, nz = 1;
      const l = Math.hypot(nx, ny, nz);
      nx /= l;
      ny /= l;
      nz /= l;
      const i = (y * w + x) * 4;
      o[i] = nx * 0.5 + 0.5;
      o[i + 1] = ny * 0.5 + 0.5;
      o[i + 2] = nz * 0.5 + 0.5;
      o[i + 3] = 1;
    }
  }
  return out;
}

// ====================================================================== scars [P5-V8]

export type ScarKind = "slash" | "claw" | "burn" | "frost" | "bolt" | "acid";

export interface ScarStroke {
  /** Centre in UV (u around, v along). */
  u: number;
  v: number;
  /** Direction in the texture plane (radians). */
  dir: number;
  /** Length and width as fractions of the texture size. */
  length: number;
  width: number;
  kind: ScarKind;
  seed: number;
}

export function scarKindOf(from: string, severity: number): ScarKind {
  switch (from) {
    case "fire":
      return "burn";
    case "ice":
      return "frost";
    case "electric":
      return "bolt";
    case "poison":
      return "acid";
    default:
      return severity > 0.55 ? "claw" : "slash";
  }
}

/** Paints one scar: darker (bruised / puckered) edges first, then the pale scar tissue core. */
export function paintScar(r: Raster, s: ScarStroke, base: RGB): void {
  const size = r.w;
  const rng = new Rng(s.seed >>> 0);
  const cx = s.u * size, cy = s.v * r.h;
  const L = s.length * size, W = Math.max(1.2, s.width * size);
  const edge = scaleRGB(mixRGB(base, [0.35, 0.12, 0.12], 0.3), 0.5);
  const pale = mixRGB(mixRGB(base, [0.96, 0.86, 0.82], 0.85), WHITE, 0.15);
  const seg = (x0: number, y0: number, x1: number, y1: number, w: number, e = edge, p = pale) => {
    r.line(x0, y0, x1, y1, w * 2.4, e, 0.7);
    r.line(x0, y0, x1, y1, w, p, 0.95);
  };
  const ux = Math.cos(s.dir), uy = Math.sin(s.dir);
  switch (s.kind) {
    case "slash":
    case "claw": {
      const n = s.kind === "claw" ? 3 : 1;
      for (let k = 0; k < n; k++) {
        const off = (k - (n - 1) / 2) * W * 2.6;
        const ox = -uy * off, oy = ux * off;
        // A slightly jagged line: 4 sub-segments, tapering at both ends.
        let px = cx + ox - ux * L / 2, py = cy + oy - uy * L / 2;
        for (let i = 1; i <= 4; i++) {
          const t = i / 4, j = (rng.next() - 0.5) * W * 0.8;
          const nx = cx + ox - ux * L / 2 + ux * L * t - uy * j, ny = cy + oy - uy * L / 2 + uy * L * t + ux * j;
          seg(px, py, nx, ny, W * (0.55 + 0.45 * Math.sin(Math.PI * (t - 0.125))));
          px = nx;
          py = ny;
        }
        // Stitch marks across severe wounds.
        if (L > size * 0.25) {
          for (let i = 1; i < 4; i++) {
            const t = i / 4 - 0.5, sx = cx + ox + ux * L * t, sy = cy + oy + uy * L * t;
            r.line(sx - uy * W * 1.6, sy + ux * W * 1.6, sx + uy * W * 1.6, sy - ux * W * 1.6, Math.max(0.8, W * 0.35), edge, 0.6);
          }
        }
      }
      break;
    }
    case "burn": {
      // A puckered patch: dark scorched rim, glossy pale centre, irregular outline.
      for (let i = 0; i < 7; i++) {
        const a = rng.next() * Math.PI * 2, d = rng.next() * L * 0.25;
        r.ellipse(cx + Math.cos(a) * d, cy + Math.sin(a) * d, L * 0.22, L * 0.16, rng.next() * 3, scaleRGB(mixRGB(base, [0.3, 0.08, 0.04], 0.5), 0.45), 0.55, 2);
      }
      for (let i = 0; i < 5; i++) {
        const a = rng.next() * Math.PI * 2, d = rng.next() * L * 0.15;
        r.ellipse(cx + Math.cos(a) * d, cy + Math.sin(a) * d, L * 0.14, L * 0.1, rng.next() * 3, pale, 0.85, 1.5);
      }
      break;
    }
    case "frost": {
      const ice = mixRGB(pale, [0.75, 0.9, 1], 0.45);
      for (let b = 0; b < 5; b++) {
        const a = s.dir + (b / 5) * Math.PI * 2 + rng.next() * 0.4;
        const ex = cx + Math.cos(a) * L * 0.45, ey = cy + Math.sin(a) * L * 0.45;
        seg(cx, cy, ex, ey, W * 0.7, scaleRGB(mixRGB(base, [0.2, 0.3, 0.5], 0.4), 0.6), ice);
        const mx = (cx + ex) / 2, my = (cy + ey) / 2;
        seg(mx, my, mx + Math.cos(a + 0.7) * L * 0.15, my + Math.sin(a + 0.7) * L * 0.15, W * 0.45, scaleRGB(base, 0.6), ice);
      }
      break;
    }
    case "bolt": {
      // A Lichtenberg figure: a branching zigzag.
      const walk = (x: number, y: number, a: number, len: number, w: number, depth: number) => {
        const steps = 5;
        for (let i = 0; i < steps; i++) {
          const na = a + (rng.next() - 0.5) * 1.1, step = len / steps;
          const nx = x + Math.cos(na) * step, ny = y + Math.sin(na) * step;
          seg(x, y, nx, ny, w);
          if (depth > 0 && rng.next() < 0.45) walk(nx, ny, na + (rng.next() < 0.5 ? 0.8 : -0.8), len * 0.45, w * 0.6, depth - 1);
          x = nx;
          y = ny;
        }
      };
      walk(cx - ux * L / 2, cy - uy * L / 2, s.dir, L, W * 0.8, 2);
      break;
    }
    case "acid": {
      const tint = scaleRGB(mixRGB(base, [0.45, 0.2, 0.55], 0.35), 0.55);
      for (let i = 0; i < 9; i++) {
        const a = rng.next() * Math.PI * 2, d = rng.next() * L * 0.4, rr = W * (0.8 + rng.next() * 1.4);
        r.ellipse(cx + Math.cos(a) * d, cy + Math.sin(a) * d, rr * 1.7, rr * 1.5, 0, tint, 0.6, 1.2);
        r.ellipse(cx + Math.cos(a) * d, cy + Math.sin(a) * d, rr, rr * 0.9, 0, pale, 0.9, 1);
      }
      break;
    }
  }
}

// ====================================================================== coat sprites (cards, fur)

/** Fur strand alpha (G and A channels) for shell texturing: sparse bright dots on black. */
export function paintFurAlpha(seed: number, size = 64, density = 0.55): Raster {
  const rng = new Rng((seed ^ 0xf0f0) >>> 0);
  const r = new Raster(size, size, BLACK, 0);
  const n = Math.round(size * size * density * 0.5);
  for (let i = 0; i < n; i++) {
    const x = rng.next() * size, y = rng.next() * size, v = 0.4 + rng.next() * 0.6;
    const idx = r.at(x, y);
    r.data[idx] = r.data[idx + 1] = r.data[idx + 2] = Math.max(r.data[idx + 1], v);
    r.data[idx + 3] = Math.max(r.data[idx + 3], v);
  }
  return r;
}

/** A feather card: rachis + vane (white, modulated by the material colour), alpha outside the vane = 0. */
export function paintFeather(seed: number, w = 32, h = 64): Raster {
  const rng = new Rng((seed ^ 0xfea7) >>> 0);
  const r = new Raster(w, h, WHITE, 0);
  for (let y = 0; y < h; y++) {
    const t = y / (h - 1); // 0 base -> 1 tip
    const half = (w / 2 - 1) * Math.sin(Math.PI * Math.min(1, 0.15 + t * 0.95)) * (t < 0.12 ? t / 0.12 : 1);
    for (let x = 0; x < w; x++) {
      const dx = Math.abs(x + 0.5 - w / 2);
      const cov = clamp01(half + 0.5 - dx);
      if (cov <= 0) continue;
      const i = r.at(x, y);
      // Barbs: slanted shade lines; darker toward the edge.
      const barb = 0.82 + 0.18 * Math.sin((y * 1.6 + dx * 1.1) + rng.next() * 0.3);
      const shade = (1 - 0.25 * (dx / Math.max(1, half))) * barb;
      r.data[i] = r.data[i + 1] = r.data[i + 2] = shade;
      r.data[i + 3] = cov * (rng.next() < 0.05 * (dx / Math.max(1, half)) ? 0 : 1);
    }
  }
  r.line(w / 2, 0, w / 2, h * 0.95, 1.2, [0.6, 0.58, 0.55], 1);
  for (let y = 0; y < h; y++) r.alphaTo(w / 2, y, 1, 1);
  return r;
}

/** A leaf card: an ellipse-ish blade with a midrib and veins (white-ish, tinted by the material). */
export function paintLeaf(seed: number, w = 32, h = 64): Raster {
  const rng = new Rng((seed ^ 0x1eaf) >>> 0);
  const r = new Raster(w, h, WHITE, 0);
  for (let y = 0; y < h; y++) {
    const t = y / (h - 1);
    const half = (w / 2 - 1) * Math.pow(Math.sin(Math.PI * t), 0.75) * (t < 0.08 ? 0.3 : 1);
    for (let x = 0; x < w; x++) {
      const dx = Math.abs(x + 0.5 - w / 2);
      const cov = clamp01(half + 0.5 - dx);
      if (cov <= 0) continue;
      const i = r.at(x, y);
      const shade = 0.78 + 0.22 * (1 - dx / Math.max(1, half)) + (rng.next() - 0.5) * 0.04;
      r.data[i] = r.data[i + 1] = r.data[i + 2] = shade;
      r.data[i + 3] = cov;
    }
  }
  const vein: RGB = [0.62, 0.62, 0.55];
  r.line(w / 2, 1, w / 2, h - 2, 1.2, [0.95, 0.95, 0.85], 0.9);
  for (let k = 1; k < 6; k++) {
    const y = (k / 6) * h * 0.9;
    for (const s of [-1, 1]) r.line(w / 2, y, w / 2 + s * w * 0.32, y + h * 0.09, 0.8, vein, 0.6);
  }
  for (let y = 0; y < h; y++) r.alphaTo(w / 2, y, Math.max(r.data[r.at(w / 2, y) + 3], y < h - 2 ? 1 : 0), 1);
  return r;
}

// ====================================================================== legacy entry points

export interface SkinTextures {
  map: THREE.Texture;
  emissive: THREE.Texture | null;
}

/** Colour + emissive maps of the back (pass-4 entry point kept; now DataTextures painted by paintSkin). */
export function skinTextures(ph: Phenotype, seed: number, size = 256, p5?: SkinP5): SkinTextures {
  const p = paintSkin(ph, p5 ?? { coat: "skin", bellyContrast: 0.5, frills: 0, stripes: 0, celBands: 3, outline: 0.3, overlays: 0 }, seed, size);
  return { map: dataTexture(p.map, true), emissive: p.emissive ? dataTexture(p.emissive, true) : null };
}

/** Soft round sprite texture used by particles and glows. */
export function softDot(size = 64): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d")!;
  const r = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  r.addColorStop(0, "rgba(255,255,255,1)");
  r.addColorStop(0.4, "rgba(255,255,255,0.6)");
  r.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = r;
  g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  return t;
}

/** Text label sprite (axis names in Genospace, floating names). */
export function textSprite(text: string, color = "#ffffff", px = 28): THREE.Sprite {
  const c = document.createElement("canvas");
  const g = c.getContext("2d")!;
  g.font = `600 ${px}px system-ui, sans-serif`;
  const w = Math.ceil(g.measureText(text).width) + 16;
  c.width = w;
  c.height = px + 16;
  g.font = `600 ${px}px system-ui, sans-serif`;
  g.fillStyle = "rgba(0,0,0,0.45)";
  g.fillRect(0, 0, w, px + 16);
  g.fillStyle = color;
  g.textBaseline = "middle";
  g.fillText(text, 8, (px + 16) / 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  s.scale.set((w / (px + 16)) * 0.6, 0.6, 1);
  s.renderOrder = 10;
  return s;
}
