// Colour lane (pass 6, P6-K1): primary / secondary / tertiary palettes from colour theory (src/genome/palette.ts)
// and the renderers that obey their attribution (textures.ts, anatomy/skin.ts, anatomy/coat.ts). Headless.
import * as THREE from "../src/lib/three.ts";
import { assert, assertEquals } from "./_assert.ts";
import { randomGenome, type Genome } from "../src/genome/genome.ts";
import { express, type Phenotype } from "../src/genome/phenotype.ts";
import { emptyConditions } from "../src/genome/epigenetics.ts";
import { ELEMENT_IDS, ELEMENTS, type ElementId } from "../src/data/elements.ts";
import { HYBRIDS } from "../src/data/hybrids.ts";
import { Rng } from "../src/core/rng.ts";
import { P5_DEFAULTS, type SkinP5 } from "../src/genome/morphTypes.ts";
import type { HarmonyScheme, Palette3 } from "../src/genome/p6Types.ts";
import {
  classifyScheme,
  COLOUR_PARTS,
  HARMONY_FLOOR,
  HARMONY_SCHEMES,
  harmonyScore,
  hexToHsl,
  hueDistance,
  palette3Of,
  type Palette3Detail,
  paletteFromP3,
  PRIMARY_HUE_SHIFT,
  SCHEME_WEIGHTS,
  schemeOf,
  SECONDARY_HUE_SLIDE,
} from "../src/genome/palette.ts";
import { paintSkin, rolesOf } from "../src/render/textures.ts";
import { makeSkinMaterials } from "../src/render/anatomy/skin.ts";
import { frillEdgeRaster } from "../src/render/anatomy/coat.ts";

const N = 6000;
interface Sample {
  g: Genome;
  ph: Phenotype;
  p: Palette3Detail;
}
let cache: Sample[] | null = null;
function samples(): Sample[] {
  if (cache) return cache;
  cache = [];
  for (let i = 0; i < N; i++) {
    const g = randomGenome(i + 1);
    const ph = express(g, emptyConditions());
    cache.push({ g, ph, p: palette3Of(g, ph.axes, ph.elements.primary, ph.elements.secondary) });
  }
  return cache;
}
const hueOf = (c: number) => hexToHsl(c).h;
const satOf = (c: number) => hexToHsl(c).s;
const pctTable = (o: Record<string, number>, n: number) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${(100 * v / n).toFixed(1)}%`).join(", ");

// ------------------------------------------------------------------ primary = the element colour (sacred)

Deno.test("palette3: the primary hue stays within tolerance of the element hue, for every element", () => {
  const TOL = PRIMARY_HUE_SHIFT + 4;
  const rng = new Rng(77);
  const worst: Record<string, number> = {};
  for (const el of ELEMENT_IDS) {
    const e = hexToHsl(ELEMENTS[el].color);
    let checked = 0;
    for (let i = 0; i < 300; i++) {
      const g = randomGenome(1000 + i);
      const ph = express(g, emptyConditions());
      // Any element as the primary (the axes still vary lightness / saturation / hybrid identity).
      const p = palette3Of({ ...g, hue: [rng.next(), rng.next()] }, ph.axes, el, null);
      assertEquals(p.element, el);
      if (p.identity !== el) continue; // a hybrid identity keeps its own colour (next test)
      checked++;
      if (e.s < 0.15) {
        // Neutral / metal: the "hue" of a grey is noise; the colour stays a grey.
        assert(satOf(p.primary) < 0.25, `${el}: stays desaturated (${p.primary.toString(16)})`);
        continue;
      }
      const d = hueDistance(e.h, hueOf(p.primary));
      worst[el] = Math.max(worst[el] ?? 0, d);
      assert(d <= TOL, `${el}: primary hue ${hueOf(p.primary).toFixed(1)} vs element ${e.h.toFixed(1)} (d ${d.toFixed(1)} > ${TOL})`);
    }
    assert(checked >= 100, `${el}: ${checked} non-hybrid samples`);
  }
  console.log("max primary hue drift per element (deg):", JSON.stringify(Object.fromEntries(Object.entries(worst).map(([k, v]) => [k, +v.toFixed(1)]))));
});

Deno.test("palette3: hybrids keep their identity colour, dual types put the second element in the secondary role", () => {
  let hybrids = 0, duals = 0;
  for (const { ph, p } of samples()) {
    if (p.identity !== p.element) {
      const h = HYBRIDS.find((x) => x.id === p.identity)!;
      assert(h, `known hybrid ${p.identity}`);
      const H = hexToHsl(h.color);
      if (H.s > 0.2) assert(hueDistance(H.h, hueOf(p.primary)) <= PRIMARY_HUE_SHIFT, `${h.id}: primary keeps the identity hue`);
      else assert(Math.abs(hexToHsl(p.primary).l - H.l) <= 0.13, `${h.id}: a grey-white identity stays grey-white`);
      hybrids++;
    } else if (ph.elements.secondary) {
      const E = hexToHsl(ELEMENTS[ph.elements.secondary].color);
      assert(p.forced, "dual type -> forced secondary");
      if (E.s > 0.25 && satOf(p.secondary) > 0.25) {
        assert(hueDistance(E.h, hueOf(p.secondary)) <= SECONDARY_HUE_SLIDE + 4, `${p.element}/${ph.elements.secondary}: secondary hue ${hueOf(p.secondary).toFixed(0)} vs ${E.h.toFixed(0)}`);
      }
      // The scheme names the hue relationship of the two element colours (+-3 deg of hex rounding).
      const d = hueDistance(hueOf(p.primary), E.h);
      assert([d - 3, d, d + 3].map((x) => classifyScheme(Math.max(0, Math.min(180, x)))).includes(p.scheme), `${p.scheme} for ${d.toFixed(1)} deg`);
      duals++;
    }
  }
  assert(hybrids > 300 && duals > 300, `hybrids ${hybrids}, duals ${duals}`);
});

// ------------------------------------------------------------------ schemes

Deno.test("palette3: scheme distribution follows SCHEME_WEIGHTS (analogous / complementary common, tetrad rare)", () => {
  const free: Record<string, number> = {}, all: Record<string, number> = {};
  let nFree = 0;
  for (const { p } of samples()) {
    all[p.scheme] = (all[p.scheme] ?? 0) + 1;
    if (!p.forced) {
      free[p.scheme] = (free[p.scheme] ?? 0) + 1;
      nFree++;
    }
  }
  console.log(`schemes, single-typed (n=${nFree}):`, pctTable(free, nFree));
  console.log(`schemes, all (n=${N}):`, pctTable(all, N));
  for (const k of HARMONY_SCHEMES) {
    const share = (free[k] ?? 0) / nFree;
    assert(Math.abs(share - SCHEME_WEIGHTS[k]) < 0.03, `${k}: ${(share * 100).toFixed(1)}% vs ${(SCHEME_WEIGHTS[k] * 100).toFixed(0)}%`);
  }
  const ranked = Object.entries(free).sort((a, b) => b[1] - a[1]).map(([k]) => k);
  assertEquals(ranked.slice(0, 2).sort(), ["analogous", "complementary"]);
  assert((all.tetrad ?? 0) / N < 0.09 && (free.tetrad ?? 0) / nFree < 0.06, "tetrad is rare");
  // Absolute spec, independent of the constants: most creatures sit in the gentle schemes.
  assert(((free.analogous ?? 0) + (free.complementary ?? 0)) / nFree > 0.45, "analogous + complementary > 45 %");
  assert(((all.analogous ?? 0) + (all.complementary ?? 0) + (all.mono ?? 0)) / N > 0.55, "gentle schemes > 55 % overall");
  // schemeOf is the quantile of the hue allele.
  assertEquals(schemeOf({ hue: [0.5, 0.01] }), "mono");
  assertEquals(schemeOf({ hue: [0.5, 0.999] }), "tetrad");
});

Deno.test("palette3: complementary puts the secondary ~180 degrees away; split / triad / analogous angles", () => {
  const want: Partial<Record<HarmonyScheme, [number, number]>> = { complementary: [165, 180], split: [135, 165], triad: [105, 135], analogous: [12, 72], mono: [0, 12] };
  const seen: Record<string, number> = {};
  for (const { p } of samples()) {
    const r = want[p.scheme];
    // Hues of greys and near-blacks / near-whites are hex-rounding noise: judge chromatic colours only.
    const ok = (c: number) => satOf(c) >= 0.2 && hexToHsl(c).l >= 0.18 && hexToHsl(c).l <= 0.88;
    if (!r || !ok(p.primary) || !ok(p.secondary)) continue;
    const d = hueDistance(hueOf(p.primary), hueOf(p.secondary));
    // Free schemes are placed by the generator (+-3 deg of hex rounding); a forced (dual-type) secondary is the
    // element's own hue (+-5 jitter), classified to the nearest anchor, so it gets a wider band.
    const slack = p.forced ? 12 + SECONDARY_HUE_SLIDE : 3;
    assert(d >= r[0] - slack && d <= r[1] + slack, `${p.scheme}${p.forced ? " (forced)" : ""}: secondary at ${d.toFixed(1)} deg (${p.primary.toString(16)} / ${p.secondary.toString(16)})`);
    if (!p.forced) seen[p.scheme] = (seen[p.scheme] ?? 0) + 1;
  }
  assert((seen.complementary ?? 0) > 400, `free complementary checked ${seen.complementary}`);
  console.log("angle-checked free palettes:", JSON.stringify(seen));
});

// ------------------------------------------------------------------ harmony

Deno.test("harmony: the floor holds over >= 5000 genomes (3 and 2 colours); the score can fail", () => {
  const scores: number[] = [];
  let rerolled = 0, below = 0;
  for (const { g, ph, p } of samples()) {
    assert(Math.abs(harmonyScore(p) - p.harmony) < 1e-12, "stored harmony = harmonyScore");
    if (p.harmony < HARMONY_FLOOR) below++;
    if (p.rerolls > 0) rerolled++;
    scores.push(p.harmony);
    const two = palette3Of(g, ph.axes, ph.elements.primary, ph.elements.secondary, 2);
    assert(two.harmony >= HARMONY_FLOOR, `2 colours: ${two.harmony.toFixed(3)}`);
  }
  scores.sort((a, b) => a - b);
  console.log(`harmony (n=${N}, floor ${HARMONY_FLOOR}): min ${scores[0].toFixed(3)} p05 ${scores[Math.floor(N * 0.05)].toFixed(3)} median ${scores[N >> 1].toFixed(3)} | re-rolled ${(100 * rerolled / N).toFixed(1)}% | below ${below}`);
  assertEquals(below, 0, "no palette under the floor");
  assert(rerolled > 0, "the floor actually rejects some first candidates");
  // The metric can fail: random triples, identical colours, a muddy secondary, equal-value vibrating complements.
  const rng = new Rng(5);
  let rnd = 0;
  for (let i = 0; i < 2000; i++) {
    const c = () => Math.floor(rng.next() * 0xffffff);
    if (harmonyScore({ primary: c(), secondary: c(), tertiary: c() }) < HARMONY_FLOOR) rnd++;
  }
  assert(rnd > 2000 * 0.08, `random triples under the floor: ${rnd}`);
  assert(harmonyScore({ primary: 0x2f8cff, secondary: 0x2f8cff, tertiary: 0x2f8cfe }) < 0.3, "identical colours");
  assert(harmonyScore({ primary: 0x2f8cff, secondary: 0x6b6440, tertiary: 0x5a4a50 }) < HARMONY_FLOOR, "muddy olive + mauve");
  assert(harmonyScore({ primary: 0xd03030, secondary: 0x30a030, tertiary: 0x3030d0 }) < 0.7, "vibrating equal-value complements");
  assert(harmonyScore({ primary: 0x2f8cff, secondary: 0x2fc8e0, tertiary: 0x1a3a80 }) > 0.85, "a clean analogous blue palette");
});

// ------------------------------------------------------------------ minimal globes, determinism, attribution

Deno.test("palette3: minimal globes (colors 2) use exactly two colours; nobody wears the tertiary", () => {
  for (const { g, ph } of samples().slice(0, 1500)) {
    const p = palette3Of(g, ph.axes, ph.elements.primary, ph.elements.secondary, 2);
    assertEquals(new Set([p.primary, p.secondary, p.tertiary]).size, 2, `${p.primary.toString(16)} ${p.secondary.toString(16)} ${p.tertiary.toString(16)}`);
    assertEquals(p.colors, 2);
    for (const part of COLOUR_PARTS) assert(p.attribution[part] !== "tertiary", `${part} wears no tertiary`);
    const r = rolesOf({ ...ph, palette3: p });
    assertEquals(new Set([r.part.body, r.part.markings, r.part.horns, r.part.limbs, r.part.tail, r.part.wings, r.detail]).size <= 2, true);
  }
});

Deno.test("palette3: deterministic; heritable (depends on the hue alleles, not the id)", () => {
  for (const { g, ph, p } of samples().slice(0, 300)) {
    const q = palette3Of(g, ph.axes, ph.elements.primary, ph.elements.secondary);
    assertEquals(q, p);
    const renamed = palette3Of({ ...g, id: "gm-other" } as Genome, ph.axes, ph.elements.primary, ph.elements.secondary);
    assertEquals(renamed, p, "same alleles, same palette");
  }
  const { g, ph } = samples()[0];
  const other = palette3Of({ ...g, hue: [g.hue[0], (g.hue[1] + 0.37) % 1] }, ph.axes, ph.elements.primary, null);
  const base = palette3Of(g, ph.axes, ph.elements.primary, null);
  assert(other.secondary !== base.secondary || other.scheme !== base.scheme, "another hue allele, another palette");
});

Deno.test("attribution: body / back / head primary, markings secondary, every part attributed; self-glowing elements glow primary", () => {
  const counts: Record<string, Record<string, number>> = {};
  for (const { p } of samples()) {
    assertEquals([p.attribution.body, p.attribution.back, p.attribution.head, p.attribution.markings], ["primary", "primary", "primary", "secondary"]);
    for (const part of COLOUR_PARTS) {
      assert(p.attribution[part], `${part} attributed`);
      counts[part] = counts[part] ?? {};
      counts[part][p.attribution[part]!] = (counts[part][p.attribution[part]!] ?? 0) + 1;
    }
    assert(p.attribution.belly === "primary" || p.attribution.belly === "secondary", "belly = tint of primary or secondary");
    if (["fire", "electric", "light", "psychic", "void"].includes(p.element)) assertEquals(p.attribution.glow, "primary");
  }
  console.log("attribution:", Object.entries(counts).map(([k, v]) => `${k} ${Object.entries(v).map(([r, n]) => `${r[0]}${(100 * n / N).toFixed(0)}`).join("/")}`).join(" | "));
  for (const part of ["limbs", "tail", "wings", "horns", "eyes"]) assert(Object.keys(counts[part]).length >= 2, `${part} varies by scheme / kind`);
});

Deno.test("paletteFromP3: base = primary, accent = secondary, belly a light tint, glow per attribution", () => {
  for (const { ph, p } of samples().slice(0, 500)) {
    const m = paletteFromP3(p, ph.palette);
    assertEquals([m.base, m.accent], [p.primary, p.secondary]);
    assert(hexToHsl(m.belly).l >= hexToHsl(p[p.attribution.belly!]).l - 1e-9, "belly lighter than its role colour");
    if (p.attribution.glow === "primary") assertEquals(m.glow, ph.palette.glow, "self-glow keeps the element core / hybrid glow");
    else assert(hexToHsl(m.glow).l >= 0.6, "tertiary glow is bright");
  }
});

// ------------------------------------------------------------------ renderers obey the attribution

const P = (o: Partial<SkinP5> = {}): SkinP5 => ({ ...P5_DEFAULTS.skin, ...o });
function fixture(): Phenotype {
  const g = randomGenome(42);
  const ph = express(g, emptyConditions());
  const p3: Palette3 = {
    primary: 0xd03020, // red body
    secondary: 0x2050e0, // blue markings
    tertiary: 0xf0d020, // yellow details
    scheme: "triad",
    harmony: 0.8,
    element: "fire" as ElementId,
    attribution: { body: "primary", back: "primary", head: "primary", belly: "primary", markings: "secondary", limbs: "secondary", tail: "primary", wings: "secondary", horns: "tertiary", eyes: "tertiary", glow: "tertiary" },
  };
  // The pass-5 accent is GREEN: a painter that ignores the palette3 would paint green markings.
  return { ...ph, pattern: "spots", palette: { ...ph.palette, base: 0xd03020, accent: 0x30c040 }, palette3: p3 };
}
const dist2 = (d: Float32Array, i: number, c: number) => {
  const r = ((c >> 16) & 255) / 255, g = ((c >> 8) & 255) / 255, b = (c & 255) / 255;
  return (d[i] - r) ** 2 + (d[i + 1] - g) ** 2 + (d[i + 2] - b) ** 2;
};
/** Share of pixels nearer to colour a than to the base colours, with a blue-dominance test for "secondary". */
function markStats(ph: Phenotype, p5: SkinP5) {
  const r = paintSkin(ph, p5, 9, 64).map;
  let blue = 0, green = 0;
  for (let i = 0; i < r.data.length; i += 4) {
    const [R, G, B] = [r.data[i], r.data[i + 1], r.data[i + 2]];
    if (B > R + 0.12 && B > G + 0.12) blue++;
    if (G > R + 0.12 && G > B + 0.12) green++;
  }
  const n = r.w * r.h;
  return { blue: blue / n, green: green / n, nearSecondary: (() => {
    let k = 0;
    for (let i = 0; i < r.data.length; i += 4) if (dist2(r.data, i, 0x2050e0) < dist2(r.data, i, 0xd03020)) k++;
    return k / n;
  })() };
}

Deno.test("textures: pattern + overlays are painted in the SECONDARY (markings) colour (pixel stats)", () => {
  const ph = fixture();
  const spots = markStats(ph, P({ overlays: 0, stripes: 0, bellyContrast: 0.3 }));
  assert(spots.blue > 0.05, `blue marking pixels ${(spots.blue * 100).toFixed(1)}%`);
  assert(spots.green < 0.005, `no pass-5 accent (green) pixels: ${(spots.green * 100).toFixed(2)}%`);
  const stripes = markStats({ ...ph, pattern: "solid" }, P({ overlays: 1, stripes: 0.9, bellyContrast: 0.3 }));
  assert(stripes.nearSecondary > 0.06, `stripe pixels nearer the secondary: ${(stripes.nearSecondary * 100).toFixed(1)}%`);
  const none = markStats({ ...ph, pattern: "solid" }, P({ overlays: 0, stripes: 0, bellyContrast: 0.3 }));
  assert(none.nearSecondary < 0.01 && none.blue < 0.005, "a solid coat has no marking pixels (the stat can fail)");
  // Without palette3 the pass-5 palette stands in: markings = accent (green).
  const legacy = markStats({ ...ph, palette3: undefined }, P({ overlays: 0, stripes: 0, bellyContrast: 0.3 }));
  assert(legacy.green > 0.05 && legacy.blue < 0.005, "fallback: markings in ph.palette.accent");
  console.log(`marking pixels: spots blue ${(spots.blue * 100).toFixed(1)}% | stripes near-secondary ${(stripes.nearSecondary * 100).toFixed(1)}% | legacy green ${(legacy.green * 100).toFixed(1)}%`);
});

Deno.test("skin / coat: materials obey the attribution (horns tertiary, wings secondary, limbs twin, detail, frill edge)", () => {
  const ph = fixture();
  const hx = { ...P5_DEFAULTS, skin: P({ coat: "skin" }) };
  // deno-lint-ignore no-explicit-any
  const helix = { surface: { bump: 0.5, patternScale: 1, patternContrast: 0.5, plates: 0.3, sheen: 0.3, fur: 0.2 }, p5: hx } as any;
  const m = makeSkinMaterials(ph, helix, 9, "low", { textures: true });
  const hex = (c: THREE.Color) => c.getHex();
  assertEquals(hex(m.accent.color), 0xf0d020, "accent (horns / spikes / tail ornaments) = horns role (tertiary)");
  assert(m.limbs !== m.skin && m.limbs.map && m.limbs.map !== m.skin.map, "limbs in the secondary get their own map");
  assertEquals(hex(m.detail.color), 0xf0d020, "detail = tertiary");
  const mem = m.membrane.color, sec = new THREE.Color(0x2050e0);
  assert(mem.b > mem.r && Math.abs(mem.b - sec.b) < 0.25, "membrane (wings) leans to the secondary");
  const ker = m.keratin.color;
  assert(ker.b < ker.g - 0.02, "keratin is ivory tinted toward the yellow tertiary");
  // Limbs map: body colour = the secondary (blue dominates).
  const ld = (m.limbs.map as THREE.DataTexture).image.data as Uint8Array;
  let blueish = 0;
  for (let i = 0; i < ld.length; i += 4) if (ld[i + 2] > ld[i] + 30) blueish++;
  assert(blueish / (ld.length / 4) > 0.5, `limbs map is secondary-coloured (${blueish})`);
  // Same-role limbs share the skin material.
  const same = { ...ph, palette3: { ...ph.palette3!, attribution: { ...ph.palette3!.attribution, limbs: "primary" as const } } };
  const m2 = makeSkinMaterials(same, helix, 9, "low", { textures: true });
  assertEquals(m2.limbs, m2.skin);
  for (const t of [...m.textures, ...m2.textures]) t.dispose();
  // Frill edge: base row = membrane colour, top rows = the tertiary.
  const fr = frillEdgeRaster(0x2050e0, 0xf0d020);
  const top = fr.data.length - 4, bot = 0;
  assert(dist2(fr.data, top, 0xf0d020) < 1e-3 && dist2(fr.data, bot, 0x2050e0) < 1e-3, "frill fades from the membrane into a tertiary edge");
});
