/**
 * Element HYBRIDS (pass 4, P4-E2): two elements living in one body read as a third identity with
 * its own name and colour (fire + water = Steam, fire + earth = Magma, electric + air = Storm...).
 *
 * Colour code (sacred, tested in tests/hybrids_test.ts): every hybrid colour lies on the SHORTER hue
 * arc between its two parents' colours, unless `exception` says why not (Steam is desaturated
 * grey-white; Storm is the violet cloud with the yellow bolt as its glow).
 *
 * Two ways a creature shows a hybrid identity:
 *  1. `identityOf(primary, secondary, secondaryLevel)`: the strict typed rule. The phenotype already
 *     carries both elements and the secondary is strong (secondaryLevel >= HYBRID_LEVEL).
 *  2. `hybridScore(axes, hybrid)` / `identityOfPhenotype(ph)`: the BODY rule. Some pairs fight over
 *     the same axis (fire wants moisture -0.6, water wants +1): a hot AND wet creature has a low fire
 *     affinity AND only a middling water one, so rule 1 can never call it Steam. The body rule splits
 *     the pair's merged signature into the axes each parent CLAIMS (larger |weight| wins) and scores
 *     the weaker parent's claimed share: both parents must be expressed for a hybrid to show.
 *     It applies only to OPPOSED pairs (`opposedPair`: the parents pull one axis in opposite
 *     directions, |weight| >= 0.2 on both sides). Compatible pairs can be typed together, so they
 *     keep the strict rule; letting the body rule call them too made 54 % of wild Genemon hybrids
 *     (300 seeds) and drowned the element colour code. With the restriction: ~22 %.
 * PURE data module: imports only src/data.
 */
import type { AxisId, AxisVector } from "./axes.ts";
import { ELEMENTS, type ElementId } from "./elements.ts";

export interface Hybrid {
  id: string;
  a: ElementId;
  b: ElementId;
  name: string;
  /** Body colour 0xRRGGBB. */
  color: number;
  /** FX / emissive colour 0xRRGGBB. */
  glow: number;
  note: string;
  /** Why the colour is NOT on the hue arc between its parents (absent = it is). */
  exception?: string;
}

export const HYBRIDS: readonly Hybrid[] = [
  { id: "steam", a: "fire", b: "water", name: "Steam", color: 0xe4e0dd, glow: 0xffe2b8, note: "Fire boiling water: scalding white vapour.", exception: "Steam is desaturated grey-white by the colour code: it has no hue to sit between red and blue." },
  { id: "magma", a: "fire", b: "earth", name: "Magma", color: 0xce4a09, glow: 0xffa070, note: "Molten rock: slow, heavy, burning ground." },
  { id: "blaze", a: "fire", b: "air", name: "Blaze", color: 0xff9e1f, glow: 0xffe0b8, note: "Wind-fed fire: wide, bright, fast." },
  { id: "cinderwood", a: "fire", b: "plant", name: "Cinderwood", color: 0x955423, glow: 0xe7a06a, note: "Smouldering timber: embers that keep burning." },
  { id: "plasma", a: "fire", b: "electric", name: "Plasma", color: 0xffbb33, glow: 0xffeecc, note: "Ionised fire: yellow-hot arcs." },
  { id: "frostfire", a: "fire", b: "ice", name: "Frostfire", color: 0x70deeb, glow: 0xd9f8fc, note: "Cold flame: burns and chills at once." },
  { id: "forge", a: "fire", b: "metal", name: "Forge", color: 0xd33017, glow: 0xf9998b, note: "Red-hot steel: hard and searing." },
  { id: "brimstone", a: "fire", b: "poison", name: "Brimstone", color: 0xb81e47, glow: 0xf27d9c, note: "Sulphurous fire: burns and poisons." },
  { id: "solar", a: "fire", b: "light", name: "Solar", color: 0xffcb3d, glow: 0xfff4d6, note: "Sunfire: blinding golden flame." },
  { id: "cinder", a: "fire", b: "shadow", name: "Cinder", color: 0x541c24, glow: 0xce3b4f, note: "Dying embers in the dark." },
  { id: "fervor", a: "fire", b: "psychic", name: "Fervor", color: 0xf22c4d, glow: 0xfeb8c4, note: "A burning will: zeal made flame." },
  { id: "blackflame", a: "fire", b: "void", name: "Blackflame", color: 0x451745, glow: 0xc431c4, note: "Fire that devours light." },
  { id: "glacier", a: "water", b: "ice", name: "Glacier", color: 0xa4d9f4, glow: 0xd9f1fd, note: "Moving ice: heavy, cold, slow." },
  { id: "galvanic", a: "water", b: "electric", name: "Galvanic", color: 0x16f3e4, glow: 0xa3fff9, note: "Charged water: every splash conducts." },
  { id: "marsh", a: "water", b: "plant", name: "Marsh", color: 0x307e64, glow: 0x71d6b4, note: "Waterlogged growth: reeds and bog." },
  { id: "mud", a: "water", b: "earth", name: "Mud", color: 0x6a4c2f, glow: 0xca9968, note: "Wet earth: sticky, slowing ground." },
  { id: "mist", a: "water", b: "air", name: "Mist", color: 0xc8dae4, glow: 0xe2edf4, note: "Hanging droplets: hides and cools." },
  { id: "sludge", a: "water", b: "poison", name: "Sludge", color: 0x403479, glow: 0x8575d1, note: "Toxic water: contaminates what it touches." },
  { id: "mercury", a: "water", b: "metal", name: "Mercury", color: 0xb2bcc7, glow: 0xe5eaf0, note: "Liquid metal: heavy, mirror-bright." },
  { id: "pearl", a: "water", b: "light", name: "Pearl", color: 0xd4eded, glow: 0xe0f5f5, note: "Light in water: iridescent nacre." },
  { id: "deepsea", a: "water", b: "shadow", name: "Deepsea", color: 0x161b5a, glow: 0x2f3ada, note: "The lightless deep." },
  { id: "reverie", a: "water", b: "psychic", name: "Reverie", color: 0xbb79d8, glow: 0xf0ddf8, note: "Dreaming tide: mind adrift." },
  { id: "trench", a: "water", b: "void", name: "Trench", color: 0x0f132e, glow: 0x2b3cab, note: "Where the ocean ends." },
  { id: "storm", a: "electric", b: "air", name: "Storm", color: 0x633b9b, glow: 0xffe14a, note: "Thunderheads: violet cloud lit by yellow bolts.", exception: "Storm is the cloud (violet) with the bolt as its glow (electric yellow): the colour code names a storm yellow-violet, outside the yellow..cyan arc." },
  { id: "blizzard", a: "ice", b: "air", name: "Blizzard", color: 0xdbecf0, glow: 0xe0f1f5, note: "Wind-driven snow: wide and blinding." },
  { id: "ore", a: "earth", b: "metal", name: "Ore", color: 0x84583e, glow: 0xd3a388, note: "Raw metal in rock: rust-brown and dense." },
  { id: "blight", a: "plant", b: "poison", name: "Blight", color: 0x326744, glow: 0x6cc68a, note: "Rotting growth: sickly dark green." },
  { id: "aurora", a: "light", b: "psychic", name: "Aurora", color: 0xf9a18b, glow: 0xffded6, note: "Dawn light of the mind: rose-gold veils." },
  { id: "abyss", a: "shadow", b: "void", name: "Abyss", color: 0x130e25, glow: 0x442e9e, note: "Darkness with nothing behind it." },
  { id: "bramble", a: "plant", b: "earth", name: "Bramble", color: 0x68822b, glow: 0xb9da6c, note: "Rooted thorns: olive and tough." },
  { id: "canopy", a: "plant", b: "air", name: "Canopy", color: 0x7dd4ab, glow: 0xdef7eb, note: "Leaves on the wind: light, rustling." },
  { id: "sparkvine", a: "plant", b: "electric", name: "Sparkvine", color: 0xa6f20d, glow: 0xddff99, note: "Charged creepers: chartreuse sparks." },
  { id: "frostbloom", a: "plant", b: "ice", name: "Frostbloom", color: 0xa3e0d2, glow: 0xdef7f1, note: "Flowers under hoarfrost." },
  { id: "sunbloom", a: "plant", b: "light", name: "Sunbloom", color: 0xcaf04c, glow: 0xf5fed7, note: "Sun-drunk flowers." },
  { id: "nightshade", a: "plant", b: "shadow", name: "Nightshade", color: 0x362a5a, glow: 0x755bc2, note: "Dark berries, deadly calm." },
  { id: "fulgurite", a: "earth", b: "electric", name: "Fulgurite", color: 0xcba448, glow: 0xf1e1bb, note: "Lightning glass fused from sand." },
  { id: "permafrost", a: "earth", b: "ice", name: "Permafrost", color: 0x9abac1, glow: 0xe4eff2, note: "Frozen ground: hard and cold." },
  { id: "dust", a: "earth", b: "air", name: "Dust", color: 0xbfac88, glow: 0xf3ede2, note: "Blowing grit: blinds." },
  { id: "amber", a: "earth", b: "light", name: "Amber", color: 0xf2a60d, glow: 0xffdd99, note: "Fossil sunlight." },
  { id: "tar", a: "earth", b: "poison", name: "Tar", color: 0x281b21, glow: 0x8f4d6e, note: "Black pitch: sticky and toxic." },
  { id: "cavern", a: "earth", b: "shadow", name: "Cavern", color: 0x3a293d, glow: 0x9959a6, note: "Underground dark." },
  { id: "magnet", a: "electric", b: "metal", name: "Magnet", color: 0x699bbf, glow: 0xd1e3f0, note: "Magnetised steel: pulls and repels." },
  { id: "cryovolt", a: "electric", b: "ice", name: "Cryovolt", color: 0x6ef7f7, glow: 0xd6ffff, note: "Frozen lightning." },
  { id: "radiance", a: "electric", b: "light", name: "Radiance", color: 0xfff585, glow: 0xfffcd6, note: "Pure brilliance." },
  { id: "synapse", a: "electric", b: "psychic", name: "Synapse", color: 0xff3369, glow: 0xffccda, note: "Thought at the speed of current." },
  { id: "froststeel", a: "ice", b: "metal", name: "Froststeel", color: 0xb6cad8, glow: 0xe2ecf3, note: "Rime on chrome." },
  { id: "diamond", a: "ice", b: "light", name: "Diamond dust", color: 0xd6f5f5, glow: 0xdcf9f9, note: "Glittering ice crystals in the sun." },
  { id: "blackice", a: "ice", b: "shadow", name: "Black ice", color: 0x242942, glow: 0x4d5eb2, note: "Invisible, treacherous ice." },
  { id: "corrosion", a: "metal", b: "poison", name: "Corrosion", color: 0x5c5c8a, glow: 0xacacd2, note: "Eating metal from within." },
  { id: "mindsteel", a: "metal", b: "psychic", name: "Mindsteel", color: 0xad7ab8, glow: 0xecdbf0, note: "Metal bent by will." },
  { id: "miasma", a: "poison", b: "shadow", name: "Miasma", color: 0x3b2659, glow: 0x8153c6, note: "Foul dark fog." },
  { id: "hex", a: "poison", b: "psychic", name: "Hex", color: 0xd926d9, glow: 0xf5a3f5, note: "A curse: poison of the mind." },
  { id: "twilight", a: "light", b: "shadow", name: "Twilight", color: 0xb24db2, glow: 0xe6b3e5, note: "Dusk: neither day nor night." },
  { id: "starfield", a: "light", b: "void", name: "Starfield", color: 0x1f1339, glow: 0x572eb8, note: "Points of light in endless dark." },
  { id: "oblivion", a: "psychic", b: "void", name: "Oblivion", color: 0x3c194d, glow: 0x9933cc, note: "Forgetting itself." },
  { id: "nightmare", a: "psychic", b: "shadow", name: "Nightmare", color: 0x552060, glow: 0xba47d1, note: "Fear given shape." },
  { id: "smog", a: "air", b: "poison", name: "Smog", color: 0x6c7393, glow: 0xbfc4d9, note: "Toxic haze." },
  { id: "halo", a: "air", b: "light", name: "Halo", color: 0xf7f7d4, glow: 0xfbfbda, note: "A ring of light in the sky." },
];

/** Strict rule: the secondary must reach this level for the typed pair to read as a hybrid. */
export const HYBRID_LEVEL = 0.45;
/** Body rule: the weaker parent's claimed-axis share must reach this (in [-1, 1], like affinity). */
export const HYBRID_BODY_MIN = 0.25;

function pairKey(x: ElementId, y: ElementId): string {
  return x < y ? `${x}+${y}` : `${y}+${x}`;
}

const BY_PAIR = new Map<string, Hybrid>();
for (const h of HYBRIDS) {
  const k = pairKey(h.a, h.b);
  if (h.a === h.b) throw new Error(`hybrid ${h.id}: a pair needs two different elements`);
  if (BY_PAIR.has(k)) throw new Error(`hybrid ${h.id}: duplicate pair ${k}`);
  BY_PAIR.set(k, h);
}

/** Order-insensitive lookup. */
export function hybridOf(a: ElementId, b: ElementId): Hybrid | null {
  if (a === b) return null;
  return BY_PAIR.get(pairKey(a, b)) ?? null;
}

export interface Identity {
  name: string;
  color: number;
  glow: number;
  hybrid: boolean;
  /** Hybrid id or element id. */
  id: string;
}

function elementIdentity(e: ElementId): Identity {
  return { id: e, name: ELEMENTS[e].name, color: ELEMENTS[e].color, glow: ELEMENTS[e].core, hybrid: false };
}

function hybridIdentity(h: Hybrid): Identity {
  return { id: h.id, name: h.name, color: h.color, glow: h.glow, hybrid: true };
}

/** Strict typed rule: hybrid when a secondary exists, the pair is known and secondaryLevel >= HYBRID_LEVEL. */
export function identityOf(primary: ElementId, secondary: ElementId | null, secondaryLevel: number): Identity {
  if (secondary && secondaryLevel >= HYBRID_LEVEL) {
    const h = hybridOf(primary, secondary);
    if (h) return hybridIdentity(h);
  }
  return elementIdentity(primary);
}

/** Axis weights each parent claims in the merged pair signature (larger |weight| wins; ties shared). */
export function claimedAxes(h: Hybrid): { a: Partial<Record<AxisId, number>>; b: Partial<Record<AxisId, number>> } {
  const sa = ELEMENTS[h.a].signature, sb = ELEMENTS[h.b].signature;
  const a: Partial<Record<AxisId, number>> = {}, b: Partial<Record<AxisId, number>> = {};
  const axes = new Set<AxisId>([...Object.keys(sa), ...Object.keys(sb)] as AxisId[]);
  for (const ax of axes) {
    const wa = sa[ax] ?? 0, wb = sb[ax] ?? 0;
    if (Math.abs(wa) >= Math.abs(wb) && wa !== 0) a[ax] = wa;
    if (Math.abs(wb) >= Math.abs(wa) && wb !== 0) b[ax] = wb;
  }
  // A parent dominated on every axis falls back to its whole signature (never an empty share).
  return {
    a: Object.keys(a).length ? a : { ...sa },
    b: Object.keys(b).length ? b : { ...sb },
  };
}

function share(axes: AxisVector, sig: Partial<Record<AxisId, number>>): number {
  let s = 0, w = 0;
  for (const [ax, wt] of Object.entries(sig) as [AxisId, number][]) {
    s += wt * axes[ax];
    w += Math.abs(wt);
  }
  return w > 0 ? s / w : 0;
}

/** Body score of a hybrid: min of the two parents' claimed-axis shares, in [-1, 1]. */
export function hybridScore(axes: AxisVector, h: Hybrid): { score: number; a: number; b: number } {
  const c = claimedAxes(h);
  const a = share(axes, c.a), b = share(axes, c.b);
  return { score: Math.min(a, b), a, b };
}

/** True when the two parents pull at least one axis in opposite directions (|weight| >= 0.2 each). */
export function opposedPair(h: Hybrid): boolean {
  const sa = ELEMENTS[h.a].signature, sb = ELEMENTS[h.b].signature;
  for (const [ax, wa] of Object.entries(sa) as [AxisId, number][]) {
    const wb = sb[ax] ?? 0;
    if (wa * wb < 0 && Math.min(Math.abs(wa), Math.abs(wb)) >= 0.2) return true;
  }
  return false;
}

/** Structural slice of a Phenotype (kept local so src/data never imports src/genome). */
export interface ElementalBody {
  axes: AxisVector;
  elements: { primary: ElementId; secondary: ElementId | null; secondaryLevel: number };
}

/**
 * Identity a renderer/UI should show: the strict typed hybrid first; else the best OPPOSED-pair body
 * hybrid that involves the primary or the secondary type and scores >= HYBRID_BODY_MIN; else the
 * primary element.
 */
export function identityOfPhenotype(ph: ElementalBody): Identity & { score: number } {
  const { primary, secondary, secondaryLevel } = ph.elements;
  const strict = identityOf(primary, secondary, secondaryLevel);
  if (strict.hybrid) return { ...strict, score: secondaryLevel };
  let best: Hybrid | null = null, bestScore = HYBRID_BODY_MIN;
  for (const h of HYBRIDS) {
    const typed = h.a === primary || h.b === primary || (secondary !== null && (h.a === secondary || h.b === secondary));
    if (!typed || !opposedPair(h)) continue;
    const { score } = hybridScore(ph.axes, h);
    if (score >= bestScore) {
      best = h;
      bestScore = score;
    }
  }
  return best ? { ...hybridIdentity(best), score: bestScore } : { ...strict, score: 0 };
}

/** HSL of a 0xRRGGBB colour: hue in degrees [0, 360), saturation and lightness in [0, 1]. */
export function hslOf(c: number): { h: number; s: number; l: number } {
  const r = ((c >> 16) & 255) / 255, g = ((c >> 8) & 255) / 255, b = (c & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  return { h, s, l };
}

/** True when hue `x` lies on the shorter arc between hues `p` and `q` (degrees), with `tol` slack. */
export function hueBetween(x: number, p: number, q: number, tol = 10): boolean {
  const norm = (v: number) => ((v % 360) + 360) % 360;
  let from = norm(p), span = norm(q - p);
  if (span > 180) {
    from = norm(q);
    span = 360 - span;
  }
  const off = norm(x - from + tol);
  return off <= span + 2 * tol;
}
