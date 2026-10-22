/**
 * Arena statistics: a pure, deterministic read-out of an arena (ground composition, elevation, slope,
 * liquid / diggable / conductive shares, favoured elements, weather modifiers and plain-language hints)
 * for the pre-battle arena dossier [P4-A1]. Only cells inside the playable circle count, like
 * `Arena.groundShares()`. No DOM, no randomness.
 */
import { ELEMENT_IDS, type ElementId } from "../data/elements.ts";
import { GROUND_IDS, type GroundId, GROUNDS } from "../data/grounds.ts";
import { type Weather, type WeatherId, WEATHERS } from "../data/weather.ts";
import { ARENA_INFO, type ArenaKind, type ArenaSymmetry, generateArena, levelStepOf, PROP_DEFS, type PropKind } from "./arena.ts";

/** The subset of `Arena` the statistics read (a hand-built fake can satisfy it in tests). */
export interface ArenaLike {
  readonly spec: { readonly kind: ArenaKind; readonly seed: number };
  readonly n: number;
  readonly cell: number;
  readonly half: number;
  readonly radius: number;
  readonly heights: ArrayLike<number>;
  readonly grounds: ArrayLike<number>;
  readonly props: readonly unknown[];
  readonly waterLevel: number;
  heightAt(x: number, z: number): number;
  /** Pass-5 fields (optional so hand-built fakes still satisfy the interface). */
  readonly altitudeM?: number;
  readonly symmetry?: ArenaSymmetry;
  readonly levelStep?: number;
  readonly plateaus?: readonly unknown[];
}

export interface LevelBand {
  /** Band index (height / step, rounded). */
  level: number;
  /** Tread height (m above the arena floor reference). */
  h: number;
  share: number;
}

export interface GroundShare {
  ground: GroundId;
  name: string;
  share: number;
  /** 0xRRGGBB, as in GROUNDS. */
  color: number;
}

export interface WeatherSummary {
  id: WeatherId;
  name: string;
  visibility: number;
  wind: number;
  wetness: number;
  note: string;
  boosted: ElementId[];
  weakened: ElementId[];
  /** elementMult of every boosted / weakened element (for chips). */
  mult: Partial<Record<ElementId, number>>;
}

export interface ArenaStats {
  kind: ArenaKind;
  name: string;
  note: string;
  seed: number;
  radius: number;
  /** Grid cells inside the playable circle. */
  cells: number;
  /** Sorted by share, descending; shares sum to 1. */
  composition: GroundShare[];
  elevation: { min: number; max: number; mean: number; range: number };
  /** Degrees. steepShare = share of cells sloping over STEEP_DEG. */
  slope: { mean: number; max: number; steepShare: number };
  liquidShare: number;
  diggableShare: number;
  /** Share of cells with conductivity >= CONDUCTIVE (water, metal, salt...). */
  conductiveShare: number;
  conductivityMean: number;
  /** Share of solid (non-liquid) cells: quake-type moves travel through them. */
  solidShare: number;
  waterLevel: number;
  props: number;
  /** Altitude above sea level of the arena floor (m) [P5-W1]. */
  altitudeM: number;
  symmetry: ArenaSymmetry;
  /** Level bands inside the playable circle, lowest first; `step` metres apart. */
  levels: { step: number; bands: LevelBand[] };
  plateaus: number;
  /** Interior props (obstacles / cover inside the playable circle), solid ones, and per 100 m2. */
  cover: { inner: number; solid: number; per100m2: number; kinds: { kind: PropKind; name: string; count: number }[] };
  /** Top elements favoured by the ground affinity weighted by composition (+ weather elementMult - 1). */
  favours: { element: ElementId; score: number }[];
  weather: WeatherSummary | null;
  hints: string[];
}

export const STEEP_DEG = 25;
export const CONDUCTIVE = 1.2;
const TOP_FAVOURS = 4;

function pctText(v: number): string {
  return `${Math.round(v * 100)} %`;
}

function summarizeWeather(w: Weather): WeatherSummary {
  const entries = (Object.entries(w.elementMult) as [ElementId, number][])
    .sort((a, b) => Math.abs(b[1] - 1) - Math.abs(a[1] - 1) || ELEMENT_IDS.indexOf(a[0]) - ELEMENT_IDS.indexOf(b[0]));
  const mult: Partial<Record<ElementId, number>> = {};
  for (const [e, m] of entries) if (m !== 1) mult[e] = m;
  return {
    id: w.id,
    name: w.name,
    visibility: w.visibility,
    wind: w.wind,
    wetness: w.wetness,
    note: w.note,
    boosted: entries.filter(([, m]) => m > 1).map(([e]) => e),
    weakened: entries.filter(([, m]) => m < 1).map(([e]) => e),
    mult,
  };
}

/** Statistics of an arena, optionally under a weather. Deterministic: same arena + weather = same object. */
export function arenaStats(a: ArenaLike, weather?: WeatherId): ArenaStats {
  const kind = a.spec.kind;
  const counts = new Map<number, number>();
  let cells = 0, hMin = Infinity, hMax = -Infinity, hSum = 0;
  let slopeSum = 0, slopeMax = 0, steep = 0;
  let liquid = 0, diggable = 0, conductive = 0, condSum = 0;
  const step = a.levelStep ?? levelStepOf(kind);
  const levelCounts = new Map<number, number>();
  const e = a.cell;
  const r2 = a.radius * a.radius;
  for (let j = 0; j < a.n; j++) {
    for (let i = 0; i < a.n; i++) {
      const x = i * a.cell - a.half, z = j * a.cell - a.half;
      if (x * x + z * z > r2) continue;
      const k = j * a.n + i;
      const gi = a.grounds[k];
      const g = GROUNDS[GROUND_IDS[gi]];
      cells++;
      counts.set(gi, (counts.get(gi) ?? 0) + 1);
      const h = a.heights[k];
      hMin = Math.min(hMin, h);
      hMax = Math.max(hMax, h);
      hSum += h;
      const lv = Math.round(h / step);
      levelCounts.set(lv, (levelCounts.get(lv) ?? 0) + 1);
      const gx = (a.heightAt(x + e, z) - a.heightAt(x - e, z)) / (2 * e);
      const gz = (a.heightAt(x, z + e) - a.heightAt(x, z - e)) / (2 * e);
      const deg = Math.atan(Math.hypot(gx, gz)) * 180 / Math.PI;
      slopeSum += deg;
      slopeMax = Math.max(slopeMax, deg);
      if (deg > STEEP_DEG) steep++;
      if (g.liquid) liquid++;
      if (g.diggable) diggable++;
      if (g.conductivity >= CONDUCTIVE) conductive++;
      condSum += g.conductivity;
    }
  }
  const total = Math.max(1, cells);
  const composition: GroundShare[] = [...counts.entries()]
    .sort((p, q) => q[1] - p[1] || p[0] - q[0])
    .map(([gi, c]) => {
      const g = GROUNDS[GROUND_IDS[gi]];
      return { ground: g.id, name: g.name, share: c / total, color: g.color };
    });
  const w = weather ? WEATHERS[weather] : null;
  const kindCounts = new Map<PropKind, number>();
  let inner = 0, solid = 0;
  for (const raw of a.props) {
    const p = raw as { kind?: string; inner?: boolean; solid?: boolean };
    if (!p.inner || !p.kind || !(p.kind in PROP_DEFS)) continue;
    inner++;
    if (p.solid) solid++;
    kindCounts.set(p.kind as PropKind, (kindCounts.get(p.kind as PropKind) ?? 0) + 1);
  }
  const area = Math.PI * a.radius * a.radius;
  const favours = ELEMENT_IDS.filter((el) => el !== "neutral")
    .map((el) => {
      let score = 0;
      for (const c of composition) score += c.share * (GROUNDS[c.ground].affinity[el] ?? 0);
      if (w) score += (w.elementMult[el] ?? 1) - 1;
      return { element: el, score };
    })
    .filter((f) => f.score > 1e-3)
    .sort((p, q) => q.score - p.score || ELEMENT_IDS.indexOf(p.element) - ELEMENT_IDS.indexOf(q.element))
    .slice(0, TOP_FAVOURS);
  const stats: ArenaStats = {
    kind,
    name: ARENA_INFO[kind].name,
    note: ARENA_INFO[kind].note,
    seed: a.spec.seed,
    radius: a.radius,
    cells,
    composition,
    elevation: cells ? { min: hMin, max: hMax, mean: hSum / cells, range: hMax - hMin } : { min: 0, max: 0, mean: 0, range: 0 },
    slope: { mean: slopeSum / total, max: slopeMax, steepShare: steep / total },
    liquidShare: liquid / total,
    diggableShare: diggable / total,
    conductiveShare: conductive / total,
    conductivityMean: condSum / total,
    solidShare: (cells - liquid) / total,
    waterLevel: a.waterLevel,
    props: a.props.length,
    altitudeM: a.altitudeM ?? ARENA_INFO[kind]?.altitudeM ?? 0,
    symmetry: a.symmetry ?? "none",
    levels: {
      step,
      bands: [...levelCounts.entries()].sort((p, q) => p[0] - q[0]).map(([level, c]) => ({ level, h: level * step, share: c / total })),
    },
    plateaus: a.plateaus?.length ?? 0,
    cover: {
      inner,
      solid,
      per100m2: area > 0 ? (inner / area) * 100 : 0,
      kinds: [...kindCounts.entries()].sort((p, q) => q[1] - p[1] || p[0].localeCompare(q[0])).map(([k, count]) => ({ kind: k, name: PROP_DEFS[k].name, count })),
    },
    favours,
    weather: w ? summarizeWeather(w) : null,
    hints: [],
  };
  stats.hints = arenaHints(stats);
  return stats;
}

/** Plain-language sentences a player can act on, derived only from the numbers above. */
export function arenaHints(s: ArenaStats): string[] {
  const out: string[] = [];
  const top = s.composition[0];
  if (top) out.push(`Mostly ${top.name.toLowerCase()} (${pctText(top.share)} of the floor).`);
  const share = (g: GroundId) => s.composition.find((c) => c.ground === g)?.share ?? 0;
  if (s.solidShare >= 0.5) out.push(`Fliers dodge quake-type moves here: ${pctText(s.solidShare)} of the floor is solid ground that carries the shock.`);
  else out.push(`Quake-type moves fizzle over water: only ${pctText(s.solidShare)} of the floor is solid ground.`);
  if (s.diggableShare > 0) out.push(`${pctText(s.diggableShare)} of the ground can be dug: burrowers can hide there.`);
  else out.push("Nothing here can be dug: burrowers stay on the surface.");
  if (s.conductiveShare > 0) {
    const metal = share("metal") + share("salt");
    const what = metal > s.conductiveShare / 2 ? "Metal conducts" : "Water conducts";
    out.push(`${what}: electric chains through ${pctText(s.conductiveShare)} of the floor.`);
  }
  if (s.liquidShare >= 0.15) out.push(`Swimmers rule ${pctText(s.liquidShare)} of the floor; walkers wade slowly through it.`);
  const lava = share("lava");
  if (lava > 0) out.push(`Lava burns whoever stands in it (${pctText(lava)} of the floor).`);
  const ice = share("ice");
  if (ice > 0.02) out.push(`Ice is slippery: dashes overshoot on ${pctText(ice)} of the floor.`);
  if (s.slope.steepShare >= 0.03) out.push(`Steep: ${pctText(s.slope.steepShare)} of cells slope over ${STEEP_DEG} deg.`);
  else if (s.slope.mean < 6) out.push(`Flat floor (mean slope ${s.slope.mean.toFixed(1)} deg): long lines of sight for ranged moves.`);
  if (s.elevation.range >= 3) out.push(`High ground: ${s.elevation.range.toFixed(1)} m between the lowest and the highest point.`);
  const bands = s.levels.bands.filter((b) => b.share >= 0.03).length;
  if (bands >= 3) out.push(`${bands} height levels ${s.levels.step.toFixed(2).replace(/0$/, "")} m apart${s.plateaus ? `, ${s.plateaus} plateau${s.plateaus > 1 ? "s" : ""} with a ramp` : ""}: the high ground sees further and is harder to rush.`);
  if (s.cover.solid >= 6) out.push(`Dense cover: ${s.cover.solid} solid obstacles (${s.cover.kinds.slice(0, 3).map((k) => k.name.toLowerCase()).join(", ")}) block bodies and lines of sight.`);
  else if (s.cover.inner > 0) out.push(`Light cover: ${s.cover.inner} props inside the ring, ${s.cover.solid} of them solid.`);
  if (s.symmetry !== "none") out.push(`Symmetric map (${s.symmetry === "mirror" ? "mirrored left-right" : "rotated 180 deg"}): both sides start on equivalent ground.`);
  if (s.altitudeM >= 1500) out.push(`Altitude ${Math.round(s.altitudeM)} m: thin, cold air.`);
  else if (s.altitudeM <= 50) out.push(`Sea level (${Math.round(s.altitudeM)} m): dense, humid air.`);
  const w = s.weather;
  if (w) {
    if (w.boosted.length || w.weakened.length) {
      const b = w.boosted.length ? `boosts ${w.boosted.join(", ")}` : "";
      const k = w.weakened.length ? `weakens ${w.weakened.join(", ")}` : "";
      out.push(`${w.name} ${[b, k].filter(Boolean).join(" and ")}.`);
    }
    if (w.visibility < 0.8) out.push(`Visibility ${pctText(w.visibility)}: ranged accuracy drops, close combat pays.`);
    if (w.wind >= 4) out.push(`Strong wind (${w.wind} m/s) pushes projectiles and light bodies.`);
    if (w.wetness >= 0.5) out.push("Everyone gets wet: electric damage conducts better.");
  }
  return out;
}

export interface ArenaWeatherStats {
  id: WeatherId;
  weather: Weather;
  stats: ArenaStats;
}

/** Representative layout of an arena kind for previews (a battle draws its own seed). */
export function previewSeed(kind: ArenaKind): number {
  return ARENA_KINDS_SEED[kind];
}
const ARENA_KINDS_SEED: Record<ArenaKind, number> = {
  meadow: 101, lake: 202, volcano: 303, canyon: 404, tundra: 505, swamp: 606, crystal: 707, city: 808, beach: 909, forest: 1010,
};

/** The arena's possible weathers (ARENA_INFO[kind].weathers), each with its statistics. */
export function arenaWeathers(kind: ArenaKind, arena?: ArenaLike): ArenaWeatherStats[] {
  const ws = ARENA_INFO[kind].weathers;
  const a = arena ?? generateArena({ seed: previewSeed(kind), kind, weather: ws[0], hour: 12 });
  return ws.map((id) => ({ id, weather: WEATHERS[id], stats: arenaStats(a, id) }));
}
