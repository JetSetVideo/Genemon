/**
 * FX: GPU point particles (additive glows + normal-blended smoke/dust), projectile meshes with
 * trails, beams, shockwave rings, lightning bolts, zone visuals (smoke clouds, wildfire, mud, bloom,
 * toxic water, blizzard, move fields) and a screen flash hook. Driven by BattleEvents.
 *
 * Pass 5 [P5-A1] calmer: fewer and smaller particles per event, a per-pool spawn BUDGET (token bucket:
 * a burst of events cannot flood the screen), caps on simultaneous rings / beams / bolts, shorter
 * trails, rate-based (frame-rate independent) streams, and the full-screen #flash goes through a
 * FlashLimiter (rare, weak, never twice within 1.6 s).
 *
 * Pass 7 [P7 lane fx]:
 *  - per-fighter EFFECTS SIGNATURE (`MorphP7.fx`, heritable, Pareto-shaped): `setFighterFx(idx, fx)`.
 *    intensity scales the counts (x intensity) and sizes (x sqrt intensity) of that fighter's effects,
 *    trail lengthens its projectile / dash / strike trails, sparkle emits ambient motes around its body
 *    (`ambient`), pulse drives its emissive glow (`pulseGlow`, applied by BattleView), hueShift turns the
 *    hue of its element colours (`shiftHex`, bounded +-0.08 turn). Every spawn still goes through the
 *    pool budgets; P7_DEFAULTS.fx reproduces the pass-6 counts, sizes and colours.
 *  - element-specific IMPACTS (`IMPACT_PROFILES`): embers rise, droplets fall + splash ring, branching
 *    sparks + short bolts, ice shards, earth debris with gravity + dust, poison bubbles swell and rise,
 *    shadow wisps sink, void wisps implode, leaves flutter (spin), light glints shrink, psychic rings,
 *    air swirls, metal sparks arc; all biased ALONG the strike direction; optional ground scorch decals
 *    (shared geometry, hard cap 8, fade out).
 *  - no per-spawn allocations (positional spawn, scratch colours), everything disposed.
 */
import * as THREE from "../lib/three.ts";
import { ELEMENTS, type ElementId } from "../data/elements.ts";
import type { Battle, BattleEvent, Zone } from "../combat/battle.ts";
import { Rng } from "../core/rng.ts";
import { type FxP7, P7_DEFAULTS } from "../genome/p7Types.ts";

const VERT = `attribute float size; attribute float alpha; attribute vec3 tint; varying float vA; varying vec3 vC;
void main(){ vA = alpha; vC = tint; vec4 mv = modelViewMatrix * vec4(position,1.0); gl_PointSize = size * (320.0 / max(0.1, -mv.z)); gl_Position = projectionMatrix * mv; }`;
const FRAG = `varying float vA; varying vec3 vC; void main(){ vec2 d = gl_PointCoord - 0.5; float r = dot(d,d)*4.0; if (r > 1.0) discard; gl_FragColor = vec4(vC, vA * (1.0 - r)); }`;
const ATTRS = ["position", "tint", "size", "alpha"] as const;

export class ParticlePool {
  readonly points: THREE.Points;
  private pos: Float32Array;
  private vel: Float32Array;
  private col: Float32Array;
  private size: Float32Array;
  private alpha: Float32Array;
  private life: Float32Array;
  private max: Float32Array;
  private grow: Float32Array;
  private grav: Float32Array;
  private drag: Float32Array;
  private spin: Float32Array;
  private head = 0;
  /** Particles ever spawned (QA / tests: budgets are measured on this). */
  spawned = 0;

  constructor(readonly capacity: number, additive: boolean) {
    this.pos = new Float32Array(capacity * 3);
    this.vel = new Float32Array(capacity * 3);
    this.col = new Float32Array(capacity * 3);
    this.size = new Float32Array(capacity);
    this.alpha = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.max = new Float32Array(capacity);
    this.grow = new Float32Array(capacity);
    this.grav = new Float32Array(capacity);
    this.drag = new Float32Array(capacity);
    this.spin = new Float32Array(capacity);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute("tint", new THREE.BufferAttribute(this.col, 3));
    g.setAttribute("size", new THREE.BufferAttribute(this.size, 1));
    g.setAttribute("alpha", new THREE.BufferAttribute(this.alpha, 1));
    this.points = new THREE.Points(g, new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    }));
    this.points.frustumCulled = false;
  }

  spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, color: THREE.Color, size: number, life: number, o: { grow?: number; gravity?: number; drag?: number; spin?: number } = {}): void {
    this.emit(x, y, z, vx, vy, vz, color, size, life, o.grow ?? 0, o.gravity ?? 0, o.drag ?? 0.5, o.spin ?? 0);
  }

  /** Allocation-free spawn (positional options). spin = horizontal velocity turn rate, rad/s. */
  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, color: THREE.Color, size: number, life: number, grow: number, gravity: number, drag: number, spin = 0): void {
    const i = this.head, i3 = i * 3;
    this.head = (this.head + 1) % this.capacity;
    this.pos[i3] = x;
    this.pos[i3 + 1] = y;
    this.pos[i3 + 2] = z;
    this.vel[i3] = vx;
    this.vel[i3 + 1] = vy;
    this.vel[i3 + 2] = vz;
    this.col[i3] = color.r;
    this.col[i3 + 1] = color.g;
    this.col[i3 + 2] = color.b;
    this.size[i] = size;
    this.life[i] = life;
    this.max[i] = life;
    this.grow[i] = grow;
    this.grav[i] = gravity;
    this.drag[i] = drag;
    this.spin[i] = spin;
    this.alpha[i] = 1;
    this.spawned++;
  }

  update(dt: number): void {
    for (let i = 0; i < this.capacity; i++) {
      if (this.life[i] <= 0) {
        this.alpha[i] = 0;
        continue;
      }
      const i3 = i * 3;
      this.life[i] -= dt;
      const k = Math.max(0, 1 - this.drag[i] * dt);
      this.vel[i3] *= k;
      this.vel[i3 + 1] = this.vel[i3 + 1] * k - this.grav[i] * dt;
      this.vel[i3 + 2] *= k;
      const sp = this.spin[i];
      if (sp !== 0) {
        const a = sp * dt, c = Math.cos(a), s = Math.sin(a), vx = this.vel[i3], vz = this.vel[i3 + 2];
        this.vel[i3] = vx * c - vz * s;
        this.vel[i3 + 2] = vx * s + vz * c;
      }
      this.pos[i3] += this.vel[i3] * dt;
      this.pos[i3 + 1] += this.vel[i3 + 1] * dt;
      this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
      this.size[i] = Math.max(0, this.size[i] + this.grow[i] * dt);
      const f = this.life[i] / this.max[i];
      this.alpha[i] = Math.min(1, f * 1.6) * Math.min(1, (1 - f) * 8 + 0.2);
    }
    const g = this.points.geometry;
    for (const a of ATTRS) (g.attributes[a] as THREE.BufferAttribute).needsUpdate = true;
  }

  /** Live particles (QA / tests). */
  alive(): number {
    let n = 0;
    for (let i = 0; i < this.capacity; i++) if (this.life[i] > 0) n++;
    return n;
  }

  /** Visit every live particle (QA / tests; no allocation). */
  forEachLive(fn: (x: number, y: number, z: number, vx: number, vy: number, vz: number, size: number, r: number, g: number, b: number) => void): void {
    for (let i = 0; i < this.capacity; i++) {
      if (this.life[i] <= 0) continue;
      const i3 = i * 3;
      fn(this.pos[i3], this.pos[i3 + 1], this.pos[i3 + 2], this.vel[i3], this.vel[i3 + 1], this.vel[i3 + 2], this.size[i], this.col[i3], this.col[i3 + 1], this.col[i3 + 2]);
    }
  }

  /** Kill every particle (tests, view reset). */
  clear(): void {
    this.life.fill(0);
    this.alpha.fill(0);
  }

  dispose(): void {
    this.points.geometry.dispose();
    (this.points.material as THREE.Material).dispose();
    this.points.removeFromParent();
  }
}

/**
 * Token bucket for particle spawns: `rate` particles per second refill up to `burst`. take(n) returns
 * how many of the n requested may spawn now (a flood of events degrades to a steady trickle).
 */
export class SpawnBudget {
  private tokens: number;
  constructor(readonly rate: number, readonly burst: number) {
    this.tokens = burst;
  }
  refill(dt: number): void {
    this.tokens = Math.min(this.burst, this.tokens + this.rate * Math.max(0, dt));
  }
  take(n: number): number {
    const k = Math.max(0, Math.min(Math.floor(n), Math.floor(this.tokens)));
    this.tokens -= k;
    return k;
  }
  get available(): number {
    return this.tokens;
  }
}

/**
 * Full-screen flash gate: strengths are scaled down and capped, and a flash within `gap` seconds of
 * the previous one is dropped (unless it is clearly stronger). Returns the strength to show (0 = none).
 */
export class FlashLimiter {
  private last = -Infinity;
  private lastS = 0;
  constructor(readonly gap = 1.6, readonly scale = 0.45, readonly cap = 0.24, readonly min = 0.05) {}
  request(strength: number, now: number): number {
    const s = Math.min(this.cap, strength * this.scale);
    if (s < this.min) return 0;
    if (now - this.last < this.gap && s <= this.lastS * 1.5) return 0;
    this.last = now;
    this.lastS = s;
    return s;
  }
}

/** Stochastic rounding of an expected count (rate x dt) so slow frames and fast frames emit alike. */
function countOf(expected: number, u: number): number {
  const n = Math.floor(expected);
  return n + (u < expected - n ? 1 : 0);
}

// ---------------------------------------------------------------------------------------------------
// Pass 7: the effects signature (pure helpers, tested in tests/p7_fx_test.ts)
// ---------------------------------------------------------------------------------------------------

/** Declared bounds of every FxP7 gene (src/genome/p7Types.ts). */
export const FX_BOUNDS: Record<keyof FxP7, readonly [number, number]> = {
  intensity: [0.6, 1.6],
  trail: [0, 1],
  sparkle: [0, 1],
  pulse: [0, 1],
  hueShift: [-0.08, 0.08],
};
/** The pass-6 look (identity). */
export const DEFAULT_FX: Readonly<FxP7> = Object.freeze({ ...P7_DEFAULTS.fx });

/** Clamp a (possibly partial / corrupt) signature into its bounds; missing or NaN genes = the default. */
export function clampFx(fx?: Partial<FxP7> | null): FxP7 {
  const out = { ...DEFAULT_FX };
  if (!fx) return out;
  for (const k of Object.keys(FX_BOUNDS) as (keyof FxP7)[]) {
    const v = fx[k];
    if (typeof v === "number" && Number.isFinite(v)) out[k] = Math.min(FX_BOUNDS[k][1], Math.max(FX_BOUNDS[k][0], v));
  }
  return out;
}

const _hsl = { h: 0, s: 0, l: 0 };
/** Shift `color` in place by `turns` of hue (clamped to +-0.08). 0 = untouched (bit-exact identity). */
export function shiftColor(color: THREE.Color, turns: number): THREE.Color {
  const t = Math.min(FX_BOUNDS.hueShift[1], Math.max(FX_BOUNDS.hueShift[0], Number.isFinite(turns) ? turns : 0));
  if (t === 0) return color;
  color.getHSL(_hsl);
  return color.setHSL((((_hsl.h + t) % 1) + 1) % 1, _hsl.s, _hsl.l);
}
const _shc = new THREE.Color();
/** Hex helper of shiftColor (tests, mesh colours). */
export function shiftHex(hex: number, turns: number): number {
  return shiftColor(_shc.setHex(hex), turns).getHex();
}

/** Trail particle lifetime: base at trail 0, 2.5x base at trail 1 (monotone). */
export function trailLife(base: number, trail: number): number {
  return base * (1 + 1.5 * Math.min(1, Math.max(0, trail)));
}
/** Trail emission rate: base at trail 0, 2x at trail 1 (denser, so the longer trail does not dot). */
export function trailRate(base: number, trail: number): number {
  return base * (1 + Math.min(1, Math.max(0, trail)));
}
/**
 * Strike streak length in metres (0 = no streak: the pass-6 look). LINEAR in the gene so the 80/20 shape
 * of the population (share20) carries over unchanged to the drawn effect.
 */
export function streakLength(trail: number): number {
  return 2.4 * Math.min(1, Math.max(0, Number.isFinite(trail) ? trail : 0));
}
/** Particle count of a fighter's effect: n x intensity (identity at 1). */
export function scaledCount(n: number, intensity: number): number {
  return intensity === 1 ? n : Math.round(n * intensity);
}
/**
 * Ambient mote rate (motes/s) from sparkle: 12 x sparkle (0 = none). Linear, no floor: the typical Genemon
 * (sparkle ~0.01) emits a mote every ~8 s, the rare sparkly one (sparkle ~1) 12 per second.
 */
export function moteRate(sparkle: number): number {
  return 12 * Math.min(1, Math.max(0, Number.isFinite(sparkle) ? sparkle : 0));
}
/**
 * Emissive glow pulse added to a creature's emissive intensity at time t: in [0, pulse * 0.45], a slow
 * breathing wave (0.55..0.85 Hz, faster for deeper pulses), phase-offset per fighter. pulse 0 = 0.
 */
export function pulseGlow(pulse: number, t: number, phase = 0): number {
  const p = Math.min(1, Math.max(0, Number.isFinite(pulse) ? pulse : 0));
  if (p === 0) return 0;
  const hz = 0.55 + 0.3 * p;
  return p * 0.45 * (0.5 + 0.5 * Math.sin(Math.PI * 2 * hz * t + phase));
}

/** How an element's impact particles move (per element; distinct at a glance). */
export interface ImpactProfile {
  /** "glow" = additive pool, "smoke" = normal-blended pool (reads in daylight, opaque bits). */
  pool: "glow" | "smoke";
  /** burst = hemisphere; ring = flat expanding circle; fountain = thrown up, falls; implode = drawn inward. */
  shape: "burst" | "ring" | "fountain" | "implode";
  speed: number;
  up: number;
  /** + falls, - rises (m/s^2). */
  gravity: number;
  drag: number;
  life: number;
  size: number;
  grow: number;
  /** Horizontal swirl rad/s; `alt` alternates its sign per particle (flutter instead of vortex). */
  spin: number;
  alt: boolean;
  /** Bias of the velocities along the strike direction 0..1. */
  orient: number;
  /** Every Nth particle takes the element's core colour. */
  coreEvery: number;
  /** Secondary effect. */
  extra: "none" | "splash" | "bolts" | "debris" | "halo";
  /** Ground scorch / stain colour on heavy hits (undefined = none). */
  scorch?: number;
}

export const IMPACT_PROFILES: Record<ElementId, ImpactProfile> = {
  neutral: { pool: "smoke", shape: "burst", speed: 1, up: 0.5, gravity: 4, drag: 2, life: 1, size: 1, grow: 0, spin: 0, alt: false, orient: 0.5, coreEvery: 3, extra: "none" },
  fire: { pool: "glow", shape: "burst", speed: 0.8, up: 1, gravity: -2.4, drag: 2.8, life: 1.4, size: 1.15, grow: -0.15, spin: 0, alt: false, orient: 0.35, coreEvery: 2, extra: "none", scorch: 0x1d140e },
  water: { pool: "glow", shape: "fountain", speed: 1, up: 0.8, gravity: 14, drag: 0.4, life: 1.3, size: 1, grow: 0, spin: 0, alt: false, orient: 0.3, coreEvery: 2, extra: "splash" },
  plant: { pool: "smoke", shape: "burst", speed: 0.7, up: 1.3, gravity: 1.4, drag: 3.5, life: 2, size: 1, grow: 0, spin: 5, alt: true, orient: 0.2, coreEvery: 3, extra: "none" },
  earth: { pool: "smoke", shape: "fountain", speed: 1, up: 0.9, gravity: 16, drag: 0.25, life: 1.4, size: 1.3, grow: 0, spin: 0, alt: false, orient: 0.4, coreEvery: 4, extra: "debris", scorch: 0x4a3a28 },
  air: { pool: "glow", shape: "burst", speed: 1, up: 0.6, gravity: -0.4, drag: 1.4, life: 1.3, size: 0.9, grow: 0.5, spin: 7, alt: false, orient: 0.2, coreEvery: 2, extra: "none" },
  electric: { pool: "glow", shape: "burst", speed: 2, up: 0.2, gravity: 0, drag: 7, life: 0.45, size: 0.6, grow: 0, spin: 0, alt: false, orient: 0.5, coreEvery: 2, extra: "bolts", scorch: 0x1e1e22 },
  ice: { pool: "glow", shape: "burst", speed: 1.5, up: 0.25, gravity: 7, drag: 1, life: 1, size: 0.7, grow: -0.2, spin: 0, alt: false, orient: 0.7, coreEvery: 2, extra: "none", scorch: 0xd8f4ff },
  metal: { pool: "glow", shape: "burst", speed: 1.8, up: 0.7, gravity: 10, drag: 0.6, life: 0.9, size: 0.45, grow: 0, spin: 0, alt: false, orient: 0.85, coreEvery: 1, extra: "none" },
  poison: { pool: "glow", shape: "burst", speed: 0.45, up: 1.2, gravity: -0.9, drag: 3, life: 2, size: 1, grow: 0.35, spin: 1.2, alt: true, orient: 0.1, coreEvery: 3, extra: "none", scorch: 0x35204a },
  light: { pool: "glow", shape: "burst", speed: 0.35, up: 0.3, gravity: 0, drag: 6, life: 0.6, size: 2, grow: -1.2, spin: 0, alt: false, orient: 0, coreEvery: 1, extra: "none" },
  shadow: { pool: "smoke", shape: "burst", speed: 0.6, up: -0.2, gravity: 1, drag: 3.2, life: 2, size: 1.4, grow: 0.9, spin: 1.5, alt: true, orient: 0.2, coreEvery: 4, extra: "none" },
  psychic: { pool: "glow", shape: "ring", speed: 1.1, up: 0, gravity: 0, drag: 1.6, life: 1.2, size: 0.8, grow: 0, spin: 2.5, alt: false, orient: 0, coreEvery: 2, extra: "halo" },
  void: { pool: "smoke", shape: "implode", speed: 1, up: 0, gravity: 0.6, drag: 2, life: 1.2, size: 1.2, grow: -0.3, spin: -3, alt: false, orient: 0, coreEvery: 2, extra: "none" },
};

/** Simultaneous transient caps (oldest of the kind is retired first). */
export const TRANSIENT_CAP: Record<"beam" | "ring" | "bolt" | "decal", number> = { beam: 3, ring: 5, bolt: 5, decal: 8 };
/** Ground scorch decals: seconds on the ground, peak opacity. */
const SCORCH = { life: 5, peak: 0.42 };

type TransientKind = "beam" | "ring" | "bolt" | "decal";
interface Transient {
  obj: THREE.Object3D;
  life: number;
  max: number;
  kind: TransientKind;
}

const ZONE_LOOK: Record<string, { color: number; additive: boolean; rate: number; size: number; rise: number; decal?: number }> = {
  smoke: { color: 0x8c8c8c, additive: false, rate: 22, size: 2.2, rise: 0.6 },
  wildfire: { color: 0xff7a1a, additive: true, rate: 28, size: 0.9, rise: 2.2, decal: 0x2a1a10 },
  firestorm: { color: 0xff5a10, additive: true, rate: 44, size: 1.1, rise: 3.5 },
  magma: { color: 0xff4a12, additive: true, rate: 16, size: 0.8, rise: 1, decal: 0x5a1a08 },
  conduction: { color: 0xfff27a, additive: true, rate: 44, size: 0.4, rise: 0.2 },
  mud: { color: 0x5a4127, additive: false, rate: 3, size: 0.6, rise: 0.2, decal: 0x4a3420 },
  freeze: { color: 0xdff6ff, additive: true, rate: 7, size: 0.35, rise: 0.4 },
  contamination: { color: 0x9b4dff, additive: true, rate: 14, size: 0.5, rise: 0.8, decal: 0x3a2050 },
  mist: { color: 0xcfe6ff, additive: false, rate: 14, size: 2, rise: 0.3 },
  dust: { color: 0xc8a878, additive: false, rate: 16, size: 1.8, rise: 0.5 },
  bloom: { color: 0x8dff7a, additive: true, rate: 11, size: 0.35, rise: 1.2, decal: 0x2f6b32 },
  blizzard: { color: 0xffffff, additive: true, rate: 38, size: 0.3, rise: 0.5 },
  blight: { color: 0x6a5a2a, additive: false, rate: 8, size: 0.8, rise: 0.4, decal: 0x3a3a1a },
};

type P3 = { x: number; y: number; z: number };

export class FxDirector {
  readonly glow = new ParticlePool(2400, true);
  readonly smoke = new ParticlePool(1400, false);
  /** Spawn budgets per pool (particles/s, burst). */
  readonly glowBudget = new SpawnBudget(700, 260);
  readonly smokeBudget = new SpawnBudget(380, 160);
  /** Ambient motes (sparkle) have their own small bucket ON TOP of the glow budget (they also take from it). */
  readonly moteBudget = new SpawnBudget(48, 12);
  readonly flashes = new FlashLimiter();
  private clock = 0;
  private transients: Transient[] = [];
  private projectiles = new Map<number, THREE.Mesh>();
  private decals = new Map<number, THREE.Mesh>();
  private rng = new Rng(99);
  private c = new THREE.Color();
  private cA = new THREE.Color();
  private cB = new THREE.Color();
  private ringGeo = new THREE.RingGeometry(0.85, 1, 48).rotateX(-Math.PI / 2);
  private sphereGeo = new THREE.SphereGeometry(1, 12, 8);
  private scorchGeo = new THREE.CircleGeometry(1, 28).rotateX(-Math.PI / 2);
  private sigs: FxP7[] = [];
  private moteDebt: number[] = [];
  onFlash: (strength: number, color: number) => void = () => {};
  /** Flashes actually shown (QA). */
  flashCount = 0;
  /** Ambient motes spawned (QA). */
  motes = 0;

  constructor(private scene: THREE.Scene) {
    scene.add(this.glow.points, this.smoke.points);
  }

  /** Teach the director a fighter's effects signature (MorphP7.fx), clamped to its bounds. */
  setFighterFx(idx: number, fx?: Partial<FxP7> | null): void {
    this.sigs[idx] = clampFx(fx);
    this.moteDebt[idx] = 0;
  }

  /** A fighter's effects signature (the pass-6 identity when unknown). */
  sigOf(idx: number | undefined): Readonly<FxP7> {
    return (idx !== undefined && this.sigs[idx]) || DEFAULT_FX;
  }

  /** Element colour of a fighter's effects into `out` (hue-shifted by its signature). */
  tintInto(out: THREE.Color, idx: number | undefined, el: ElementId, core = false): THREE.Color {
    out.setHex(core ? ELEMENTS[el].core : ELEMENTS[el].color);
    return shiftColor(out, this.sigOf(idx).hueShift);
  }

  /** Shared scratch colour version of tintInto (consume immediately). */
  tint(idx: number | undefined, el: ElementId, core = false): THREE.Color {
    return this.tintInto(this.c, idx, el, core);
  }

  /** Every flash goes through the limiter (no full-screen flash spam). */
  flash(strength: number, color: number): void {
    const s = this.flashes.request(strength, this.clock);
    if (s > 0) {
      this.flashCount++;
      this.onFlash(s, color);
    }
  }

  private budgetOf(pool: ParticlePool): SpawnBudget {
    return pool === this.glow ? this.glowBudget : this.smokeBudget;
  }

  /** Add a transient, retiring the oldest of its kind past the cap. */
  private addTransient(tr: Transient): void {
    let n = 0, oldest = -1;
    for (let i = 0; i < this.transients.length; i++) {
      if (this.transients[i].kind !== tr.kind) continue;
      if (oldest < 0) oldest = i;
      n++;
    }
    if (n >= TRANSIENT_CAP[tr.kind] && oldest >= 0) {
      this.retire(this.transients[oldest]);
      this.transients.splice(oldest, 1);
    }
    this.scene.add(tr.obj);
    this.transients.push(tr);
  }

  private isShared(g: THREE.BufferGeometry | undefined): boolean {
    return g === this.ringGeo || g === this.scorchGeo || g === this.sphereGeo;
  }

  private retire(tr: Transient): void {
    tr.obj.removeFromParent();
    tr.obj.traverse((o) => {
      const mm = o as THREE.Mesh;
      if (mm.isMesh || (o as THREE.LineSegments).isLineSegments) {
        if (!this.isShared(mm.geometry)) mm.geometry?.dispose();
        (mm.material as THREE.Material)?.dispose();
      }
    });
  }

  private col(e: ElementId, core = false): THREE.Color {
    return this.c.setHex(core ? ELEMENTS[e].core : ELEMENTS[e].color);
  }

  burst(at: P3, el: ElementId, n: number, speed: number, size: number, life = 0.6, up = 0.5): void {
    const pool = el === "earth" || el === "neutral" || el === "shadow" || el === "void" ? this.smoke : this.glow;
    n = this.budgetOf(pool).take(n);
    for (let k = 0; k < n; k++) {
      const a = this.rng.range(0, Math.PI * 2), b = this.rng.range(-0.2, 1);
      const s = speed * this.rng.range(0.4, 1);
      pool.emit(at.x, at.y, at.z, Math.cos(a) * s, (b + up) * s, Math.sin(a) * s, this.col(el, k % 3 === 0), size * this.rng.range(0.6, 1.3), life * this.rng.range(0.6, 1.2), 0, 4, 2);
    }
  }

  /**
   * Element-specific impact [P7]: `n` particles (x the attacker's intensity) moving by the element's
   * IMPACT_PROFILES row, biased along the strike direction (dx, dz: unit horizontal vector, 0 = none),
   * plus the element's secondary effect. `heavy` (0..1) gates rings / bolts / scorch. Returns spawned.
   */
  impact(at: P3, el: ElementId, n: number, speed: number, size: number, life: number, dx: number, dz: number, who?: number, heavy = 0, groundY = at.y): number {
    const P = IMPACT_PROFILES[el], sig = this.sigOf(who);
    const pool = P.pool === "glow" ? this.glow : this.smoke;
    n = this.budgetOf(pool).take(scaledCount(n, sig.intensity));
    const base = this.tintInto(this.cA, who, el, false), core = this.tintInto(this.cB, who, el, true);
    const sz = size * P.size * Math.sqrt(sig.intensity), sp = speed * P.speed;
    for (let k = 0; k < n; k++) {
      let vx = 0, vy = 0, vz = 0, x = at.x - dx * 0.15, y = at.y, z = at.z - dz * 0.15;
      const a = this.rng.range(0, Math.PI * 2), s = sp * this.rng.range(0.4, 1);
      if (P.shape === "ring") {
        const ar = (Math.PI * 2 * k) / Math.max(1, n) + this.rng.range(-0.12, 0.12), sr = sp * this.rng.range(0.85, 1);
        vx = Math.cos(ar) * sr;
        vz = Math.sin(ar) * sr;
        vy = this.rng.range(-0.08, 0.08) * sr;
      } else if (P.shape === "fountain") {
        vx = Math.cos(a) * s * 0.45;
        vz = Math.sin(a) * s * 0.45;
        vy = sp * (P.up + this.rng.range(0, 0.3));
      } else if (P.shape === "implode") {
        const r = 0.5 + sz * 2.2, b = this.rng.range(-0.6, 0.9);
        x += Math.cos(a) * r;
        z += Math.sin(a) * r;
        y += b * r * 0.6;
        // Converges on the hit point: with linear drag the travel is v0 / drag, so v0 = r x drag.
        const inward = r * P.drag * this.rng.range(0.9, 1.05);
        vx = -Math.cos(a) * inward;
        vz = -Math.sin(a) * inward;
        vy = -b * 0.6 * inward;
      } else {
        const b = this.rng.range(-0.2, 1);
        vx = Math.cos(a) * s;
        vz = Math.sin(a) * s;
        vy = (b + P.up) * s;
      }
      // Spray axis on the strike line, rebounding off the struck surface (toward the attacker's side, where
      // the camera sees it) instead of flying into the target's body and being hidden by it.
      if (P.orient > 0) {
        vx -= dx * s * P.orient * 1.6;
        vz -= dz * s * P.orient * 1.6;
      }
      const spin = P.spin === 0 ? 0 : P.spin * this.rng.range(0.6, 1.4) * (P.alt && k % 2 === 1 ? -1 : 1);
      pool.emit(x, y, z, vx, vy, vz, k % P.coreEvery === 0 ? core : base, sz * this.rng.range(0.6, 1.3), life * P.life * this.rng.range(0.6, 1.2), P.grow, P.gravity, P.drag, spin);
    }
    if (n > 0) this.impactExtra(at, el, P, heavy, groundY, who);
    return n;
  }

  private impactExtra(at: P3, el: ElementId, P: ImpactProfile, heavy: number, groundY: number, who?: number): void {
    const g = { x: at.x, y: groundY, z: at.z };
    if (P.extra === "splash" && heavy > 0.12) this.ring({ x: g.x, y: g.y - 0.1, z: g.z }, this.tint(who, el, true).getHex(), 1.1 + 1.6 * heavy, 0.5);
    if (P.extra === "halo" && heavy > 0.08) this.ring({ x: at.x, y: at.y - 0.15, z: at.z }, this.tint(who, el).getHex(), 1 + 1.4 * heavy, 0.45);
    if (P.extra === "debris") this.dust(g, 2 + Math.round(5 * heavy), 0x9a7a52, 0.7);
    if (P.extra === "bolts") {
      const branches = heavy > 0.25 ? 2 : 1, col = this.tint(who, el, true).getHex();
      for (let k = 0; k < branches; k++) {
        const a = this.rng.range(0, Math.PI * 2), r = this.rng.range(0.8, 1.6);
        this.boltXYZ(at.x, at.y, at.z, at.x + Math.cos(a) * r, at.y + this.rng.range(-0.6, 0.4), at.z + Math.sin(a) * r, col, 0.14, 5, 0.25);
      }
    }
    if (P.scorch !== undefined && heavy > 0.18) this.scorch(g, P.scorch, 0.5 + 1.2 * heavy);
  }

  /** Fading ground mark (scorch, stain, frost, crater) - shared geometry, at most TRANSIENT_CAP.decal. */
  scorch(at: P3, color: number, radius: number): void {
    const m = new THREE.Mesh(this.scorchGeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: SCORCH.peak, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    m.position.set(at.x, at.y + 0.05, at.z);
    m.scale.setScalar(radius);
    m.rotation.y = this.rng.range(0, Math.PI * 2);
    m.renderOrder = 1;
    m.userData.peak = SCORCH.peak;
    this.addTransient({ obj: m, life: SCORCH.life, max: SCORCH.life, kind: "decal" });
  }

  /** Strike trail [P7]: a short streak along the strike direction ending at the impact (trail > 0 only). */
  streak(at: P3, dx: number, dz: number, el: ElementId, who: number | undefined, size: number): number {
    const sig = this.sigOf(who), len = streakLength(sig.trail);
    if (len < 0.05 || (dx === 0 && dz === 0)) return 0;
    const n = this.glowBudget.take(scaledCount(Math.round(3 + 9 * sig.trail), sig.intensity));
    const c = this.tintInto(this.cA, who, el, true);
    for (let k = 0; k < n; k++) {
      const t = k / Math.max(1, n - 1), d = len * (1 - t);
      this.glow.emit(at.x - dx * d, at.y + this.rng.range(-0.05, 0.05), at.z - dz * d, dx * 1.2, 0, dz * 1.2, c, size * (0.5 + 0.5 * t) * Math.sqrt(sig.intensity), trailLife(0.12, sig.trail) * (0.4 + 0.6 * t), 0, 0, 4);
    }
    return n;
  }

  dust(at: P3, n: number, color = 0xb8a68a, size = 0.8): void {
    this.c.setHex(color);
    n = this.smokeBudget.take(n);
    for (let k = 0; k < n; k++) {
      const a = this.rng.range(0, Math.PI * 2), s = this.rng.range(0.8, 2.5);
      this.smoke.emit(at.x, at.y + 0.1, at.z, Math.cos(a) * s, this.rng.range(0.3, 1.2), Math.sin(a) * s, this.c, size, this.rng.range(0.6, 1.2), 1.2, 0.3, 2.5);
    }
  }

  ring(at: P3, color: number, radius: number, life = 0.45): void {
    const m = new THREE.Mesh(this.ringGeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    m.position.set(at.x, at.y + 0.15, at.z);
    m.userData.radius = radius;
    m.userData.peak = 0.6;
    this.addTransient({ obj: m, life, max: life, kind: "ring" });
  }

  beam(from: THREE.Vector3, to: THREE.Vector3, el: ElementId, width: number, who?: number): void {
    const len = from.distanceTo(to);
    const geo = new THREE.CylinderGeometry(width, width, len, 10, 1, true);
    geo.translate(0, len / 2, 0);
    geo.rotateX(Math.PI / 2);
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: this.tint(who, el).getHex(), transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false }));
    m.position.copy(from);
    m.lookAt(to);
    const core = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: this.tint(who, el, true).getHex(), transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false }));
    core.scale.set(0.4, 0.4, 1);
    m.add(core);
    m.userData.peak = 0.8;
    this.addTransient({ obj: m, life: 0.32, max: 0.32, kind: "beam" });
    const sig = this.sigOf(who);
    const n = this.glowBudget.take(scaledCount(10, sig.intensity));
    const base = this.tintInto(this.cA, who, el, false), cc = this.tintInto(this.cB, who, el, true);
    for (let k = 0; k < n; k++) {
      const t = k / Math.max(1, n);
      const px = from.x + (to.x - from.x) * t, py = from.y + (to.y - from.y) * t, pz = from.z + (to.z - from.z) * t;
      this.glow.emit(px, py, pz, this.rng.range(-0.6, 0.6), this.rng.range(-0.3, 1), this.rng.range(-0.6, 0.6), k % 2 === 0 ? cc : base, width * 2.2 * Math.sqrt(sig.intensity), trailLife(0.32, sig.trail), 0, 0, 0.5);
    }
  }

  bolt(from: THREE.Vector3, to: THREE.Vector3, color = 0xfff6a0, life = 0.25): void {
    this.boltXYZ(from.x, from.y, from.z, to.x, to.y, to.z, color, life, 12, 1);
  }

  /** Jagged line from a to b in `n` segments with jitter `amp` (x 0.6 / 0.4 / 0.6 m at amp 1). */
  private boltXYZ(ax: number, ay: number, az: number, bx: number, by: number, bz: number, color: number, life: number, n: number, amp: number): void {
    const pts = new Float32Array(n * 6);
    let px = ax, py = ay, pz = az;
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      let x = ax + (bx - ax) * t, y = ay + (by - ay) * t, z = az + (bz - az) * t;
      if (k < n) {
        x += this.rng.range(-0.6, 0.6) * amp;
        y += this.rng.range(-0.4, 0.4) * amp;
        z += this.rng.range(-0.6, 0.6) * amp;
      }
      pts.set([px, py, pz, x, y, z], (k - 1) * 6);
      px = x;
      py = y;
      pz = z;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pts, 3));
    const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending }));
    l.userData.peak = 0.9;
    this.addTransient({ obj: l, life, max: life, kind: "bolt" });
  }

  /**
   * Breath / spray cone [P4-M2]: particles leave the mouth along directions inside the arc. Called
   * once at the strike and every frame of the active phase (sustained breath). Smoky elements use the
   * normal-blended pool so the cone reads in daylight, glowing ones the additive pool.
   */
  cone(from: THREE.Vector3, yaw: number, el: ElementId, range: number, arc: number, n: number, size: number, who?: number): void {
    const smoky = el === "earth" || el === "shadow" || el === "void" || el === "poison" || el === "neutral";
    const pool = smoky ? this.smoke : this.glow;
    const sig = this.sigOf(who);
    n = this.budgetOf(pool).take(scaledCount(n, sig.intensity));
    const base = this.tintInto(this.cA, who, el, false), core = this.tintInto(this.cB, who, el, true), sz = size * Math.sqrt(sig.intensity);
    for (let k = 0; k < n; k++) {
      const a = yaw + this.rng.range(-arc, arc) * 0.9, up = this.rng.range(-0.12, 0.18);
      const sp = (range / 0.42) * this.rng.range(0.55, 1.05);
      pool.emit(from.x, from.y, from.z, Math.sin(a) * sp, up * sp, Math.cos(a) * sp, k % 3 === 0 ? core : base, sz * this.rng.range(0.6, 1.4), this.rng.range(0.32, 0.5), 2.2, 0, 1.6);
    }
  }

  /**
   * Sustained breath stream for one frame: `rate` particles per second (frame-rate independent),
   * replacing the old fixed count per frame (10 per frame = 1200/s at 120 fps).
   */
  coneStream(from: THREE.Vector3, yaw: number, el: ElementId, range: number, arc: number, dt: number, size: number, rate = 55, who?: number): void {
    const n = countOf(rate * dt, this.rng.next());
    if (n > 0) this.cone(from, yaw, el, range, arc, n, size, who);
  }

  /** Expected-count helper for per-frame emitters elsewhere (render-only). */
  countFor(rate: number, dt: number): number {
    return countOf(rate * dt, this.rng.next());
  }

  /** Dash streak from the start to the arrival point (dust at the feet + an element streak). */
  dashTrail(from: P3, to: P3, el: ElementId, size: number, who?: number): void {
    const sig = this.sigOf(who);
    const want = sig.trail > 0 ? Math.round(9 * (1 + sig.trail)) : 9;
    const n = this.glowBudget.take(scaledCount(want, sig.intensity));
    const base = this.tintInto(this.cA, who, el, false), core = this.tintInto(this.cB, who, el, true), sz = size * Math.sqrt(sig.intensity);
    for (let k = 0; k < n; k++) {
      const t = k / Math.max(1, n - 1), x = from.x + (to.x - from.x) * t, z = from.z + (to.z - from.z) * t, y = from.y + (to.y - from.y) * t;
      this.glow.emit(x, y + size * 0.6, z, this.rng.range(-0.2, 0.2), this.rng.range(0, 0.4), this.rng.range(-0.2, 0.2), k % 2 === 0 ? core : base, sz * 0.6, trailLife(0.22 + 0.16 * t, sig.trail), 0, 0, 3);
      if (k % 4 === 0) this.dust({ x, y, z }, 1, 0xb8a68a, size * 0.5);
    }
  }

  /** A trainer throws a Genemon in: a light column + a ring in the side colour where it lands. */
  throwIn(at: P3, color: number, height: number): void {
    this.ring(at, color, 1.6 + height * 0.7, 0.6);
    this.c.setHex(color);
    const n = this.glowBudget.take(28);
    for (let k = 0; k < n; k++) {
      const a = this.rng.range(0, Math.PI * 2), r = this.rng.range(0, 0.5 + height * 0.4);
      this.glow.emit(at.x + Math.cos(a) * r, at.y + this.rng.range(0, height * 1.4), at.z + Math.sin(a) * r, 0, this.rng.range(1, 3.5), 0, this.c, 0.35, this.rng.range(0.4, 0.9), 0, 0, 1.5);
    }
    this.flash(0.12, color);
  }

  /**
   * Ambient motes [P7 sparkle]: a few emissive specks drifting around a fighter's body (centre cx,cy,cz,
   * horizontal radius r, height h), rate moteRate(sparkle). They take from the mote bucket AND the glow
   * budget, and yield (spawn nothing) while combat effects have drained the glow budget below 35 %.
   */
  ambient(idx: number, cx: number, cy: number, cz: number, r: number, h: number, el: ElementId, dt: number): number {
    const sig = this.sigOf(idx), rate = moteRate(sig.sparkle);
    if (rate <= 0 || !(dt > 0)) return 0;
    const debt = (this.moteDebt[idx] ?? 0) + rate * dt;
    let n = Math.floor(debt);
    this.moteDebt[idx] = debt - n;
    if (n <= 0) return 0;
    if (this.glowBudget.available < this.glowBudget.burst * 0.35) return 0;
    n = this.moteBudget.take(n);
    n = this.glowBudget.take(n);
    const base = this.tintInto(this.cA, idx, el, false), core = this.tintInto(this.cB, idx, el, true);
    const sz = Math.min(0.42, 0.1 + 0.05 * r) * Math.sqrt(sig.intensity);
    for (let k = 0; k < n; k++) {
      const a = this.rng.range(0, Math.PI * 2), u = this.rng.range(-0.9, 0.9), rr = r * (0.9 + 0.35 * this.rng.next());
      const ring = Math.sqrt(1 - u * u);
      this.glow.emit(cx + Math.cos(a) * rr * ring, cy + u * h * 0.5, cz + Math.sin(a) * rr * ring, -Math.sin(a) * 0.25, this.rng.range(0.15, 0.45), Math.cos(a) * 0.25, k % 2 === 0 ? core : base, sz * this.rng.range(0.7, 1.3), this.rng.range(0.9, 1.6), -0.04, -0.05, 0.8, 1.2);
    }
    this.motes += n;
    return n;
  }

  /** React to the battle's new events (positions in world space). */
  consume(b: Battle, events: BattleEvent[], headOf: (idx: number) => THREE.Vector3): void {
    for (const e of events) {
      const el = e.element ?? "neutral";
      switch (e.type) {
        case "projectile": {
          const who = e.a;
          const m = new THREE.Mesh(this.sphereGeo, new THREE.MeshBasicMaterial({ color: this.tint(who, el, true).getHex() }));
          const halo = new THREE.Mesh(this.sphereGeo, new THREE.MeshBasicMaterial({ color: this.tint(who, el).getHex(), transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }));
          halo.scale.setScalar(1.9);
          m.add(halo);
          const p = b.projectiles.find((x) => x.id === e.value);
          m.scale.setScalar(p ? p.radius : 0.3);
          m.userData.owner = who ?? (p ? p.owner : -1);
          m.userData.dx = 0;
          m.userData.dz = 0;
          if (p) {
            const v = Math.hypot(p.vel.x, p.vel.z);
            if (v > 1e-6) {
              m.userData.dx = p.vel.x / v;
              m.userData.dz = p.vel.z / v;
            }
            m.position.set(p.pos.x, p.pos.y, p.pos.z);
          }
          this.scene.add(m);
          this.projectiles.set(e.value!, m);
          break;
        }
        case "projectileEnd": {
          const m = this.projectiles.get(e.value!);
          if (m) {
            const who = (m.userData.owner as number) >= 0 ? (m.userData.owner as number) : undefined;
            const gy = b.arena ? b.arena.heightAt(m.position.x, m.position.z) : m.position.y;
            this.impact(m.position, el, 7, 2.4, 0.26, 0.35, m.userData.dx as number, m.userData.dz as number, who, 0.1, gy);
            this.disposeProjectile(m);
            this.projectiles.delete(e.value!);
          }
          break;
        }
        case "hit": {
          if (!e.pos) break;
          const t = b.fighters[e.b!];
          const at = { x: e.pos.x, y: t.body.pos.y + t.ph.heightM * 0.5, z: e.pos.z };
          const k = Math.min(1, (e.value ?? 0) / Math.max(1, t.maxHp));
          let dx = 0, dz = 0;
          const src = e.a !== undefined ? b.fighters[e.a] : undefined;
          if (src && src !== t) {
            const ddx = at.x - src.body.pos.x, ddz = at.z - src.body.pos.z, d = Math.hypot(ddx, ddz);
            if (d > 1e-6) {
              dx = ddx / d;
              dz = ddz / d;
            }
          }
          const gy = b.arena ? b.arena.heightAt(at.x, at.z) : t.body.pos.y;
          this.impact(at, el, Math.round(6 + 18 * k + (e.crit ? 10 : 0)), 2.5 + 3.5 * k, 0.22 + k * 0.22, 0.45, dx, dz, e.a, Math.min(1, k * 3 + (e.crit ? 0.3 : 0)), gy);
          this.streak(at, dx, dz, el, e.a, 0.22 + k * 0.22);
          if (e.label === "conduction") this.bolt(headOf(e.a!), new THREE.Vector3(at.x, at.y, at.z));
          if (e.crit) {
            this.ring(at, this.tint(e.a, el).getHex(), 2 + 2 * k, 0.4);
            if (k > 0.3) this.flash(0.35 + k * 0.4, this.tint(e.a, el, true).getHex());
          }
          break;
        }
        case "miss":
          if (e.pos) this.dust(e.pos, 6, 0xcfc6b0, 0.5);
          break;
        case "phase":
          if (e.label === "beam" && e.pos && e.a !== undefined) this.beam(headOf(e.a), new THREE.Vector3(e.pos.x, e.pos.y + b.fighters[e.b!].ph.heightM * 0.4, e.pos.z), el, 0.18, e.a);
          if (e.label === "emerge" && e.pos) this.dust(e.pos, 14, 0x8a6a44, 1);
          if (e.label === "cone" && e.pos && e.a !== undefined) {
            const f = b.fighters[e.a], tg = b.fighters[e.b ?? e.a];
            const yaw = Math.atan2(tg.body.pos.x - f.body.pos.x, tg.body.pos.z - f.body.pos.z);
            this.cone(new THREE.Vector3(e.pos.x, e.pos.y, e.pos.z), yaw, el, e.value ?? 5, f.move?.arc ?? 0.45, 36, 0.4 + 0.12 * f.ph.heightM, e.a);
          }
          if (e.label === "dash" && e.pos && e.a !== undefined) {
            const f = b.fighters[e.a];
            this.dashTrail(f.body.pos, e.pos, el, 0.4 + 0.3 * f.ph.heightM, e.a);
          }
          break;
        case "interrupt":
          if (e.pos && e.b !== undefined) {
            const h = headOf(e.b);
            this.ring({ x: h.x, y: h.y - 0.2, z: h.z }, 0xffffff, 1.6, 0.45);
            this.burst({ x: h.x, y: h.y, z: h.z }, el, 10, 3, 0.24, 0.4);
          }
          break;
        case "switch":
          if (e.pos && e.a !== undefined) this.throwIn(e.pos, b.fighters[e.a].team === 0 ? 0x38bdf8 : 0xfb923c, b.fighters[e.a].ph.heightM);
          break;
        case "reaction":
          if (e.pos) {
            this.ring(e.pos, ELEMENTS[el].color, 2.6, 0.55);
            if (e.label === "eclipse") this.flash(0.8, 0xffffff);
          }
          break;
        case "clash":
          if (e.pos) {
            this.burst(e.pos, el, 16, 4, 0.34, 0.5);
            this.ring(e.pos, 0xffffff, 1.8, 0.4);
          }
          break;
        case "lightning":
          if (e.pos) {
            const to = new THREE.Vector3(e.pos.x, e.pos.y + 0.5, e.pos.z);
            this.bolt(to.clone().add(new THREE.Vector3(this.rng.range(-3, 3), 26, this.rng.range(-3, 3))), to, 0xffffff, 0.3);
            this.flash(0.6, 0xdfe8ff);
          }
          break;
        case "terrain":
          if (e.pos) this.dust(e.pos, 9, 0xdddddd, 0.8);
          break;
        case "ko":
          if (e.pos) {
            this.dust(e.pos, 18, 0x9a8a70, 1.2);
            this.ring(e.pos, 0xffffff, 2.8, 0.7);
          }
          break;
        case "physics":
          if (e.pos && (e.label === "land" || e.label === "bump")) this.dust(e.pos, Math.min(12, 2 + Math.round(e.value ?? 0)));
          if (e.pos && e.label === "splash") this.burst(e.pos, "water", 14, 3.5, 0.26, 0.55, 1.5);
          break;
        case "weather":
          // A weather change no longer flashes the whole screen (the arena re-lights itself).
          break;
      }
    }
  }

  private disposeProjectile(m: THREE.Mesh): void {
    m.removeFromParent();
    m.traverse((o) => ((o as THREE.Mesh).material as THREE.Material | undefined)?.dispose());
  }

  /** Per-frame: projectile meshes + trails, zone visuals, transients, particle simulation. */
  update(b: Battle, dt: number, t: number): void {
    this.clock += dt;
    this.glowBudget.refill(dt);
    this.smokeBudget.refill(dt);
    this.moteBudget.refill(dt);
    for (const p of b.projectiles) {
      const m = this.projectiles.get(p.id);
      if (!m) continue;
      const ddx = p.pos.x - m.position.x, ddz = p.pos.z - m.position.z, d = Math.hypot(ddx, ddz);
      if (d > 1e-4) {
        m.userData.dx = ddx / d;
        m.userData.dz = ddz / d;
      }
      m.position.set(p.pos.x, p.pos.y, p.pos.z);
      const who = (m.userData.owner as number) >= 0 ? (m.userData.owner as number) : undefined;
      const sig = this.sigOf(who);
      const c = this.tint(who, p.element);
      // Trail: ~28 particles/s per projectile at trail 0 (pass-6), denser and longer-lived with trail.
      const n = this.glowBudget.take(countOf(trailRate(28, sig.trail) * sig.intensity * dt, this.rng.next()));
      for (let k = 0; k < n; k++) {
        this.glow.emit(p.pos.x, p.pos.y, p.pos.z, this.rng.range(-0.3, 0.3), this.rng.range(-0.1, 0.4), this.rng.range(-0.3, 0.3), c, p.radius * 1.7 * Math.sqrt(sig.intensity), trailLife(0.2, sig.trail), 0, 0, 3);
      }
    }
    const live = new Set<number>();
    for (const z of b.zones) {
      live.add(z.id);
      this.zone(z, dt, t);
    }
    for (const [id, m] of this.decals) {
      if (!live.has(id)) {
        m.removeFromParent();
        (m.material as THREE.Material).dispose();
        m.geometry.dispose();
        this.decals.delete(id);
      }
    }
    for (let i = this.transients.length - 1; i >= 0; i--) {
      const tr = this.transients[i];
      tr.life -= dt;
      const f = Math.max(0, tr.life / tr.max);
      const mat = (tr.obj as THREE.Mesh).material as THREE.Material & { opacity: number };
      // Decals hold, then fade over the last 40 % of their life.
      const o = tr.kind === "decal" ? Math.min(1, f / 0.4) : f;
      if (mat) mat.opacity = o * ((tr.obj.userData.peak as number | undefined) ?? 1);
      if (tr.kind === "ring") tr.obj.scale.setScalar(0.3 + (1 - f) * (tr.obj.userData.radius as number));
      if (tr.kind === "beam") tr.obj.scale.set(f, f, 1);
      if (tr.life <= 0) {
        this.retire(tr);
        this.transients.splice(i, 1);
      }
    }
    this.glow.update(dt);
    this.smoke.update(dt);
  }

  private zone(z: Zone, dt: number, t: number): void {
    const look = z.kind === "field"
      ? { color: ELEMENTS[z.element].color, additive: true, rate: 18, size: 0.38, rise: 1.2, decal: ELEMENTS[z.element].color }
      : ZONE_LOOK[z.kind] ?? { color: 0xffffff, additive: true, rate: 10, size: 0.4, rise: 0.5 };
    const fade = Math.min(1, z.ttl / Math.max(0.3, z.maxTtl * 0.3));
    const pool = look.additive ? this.glow : this.smoke;
    const n = this.budgetOf(pool).take(countOf(look.rate * dt * z.radius * fade, this.rng.next()));
    this.c.setHex(look.color);
    for (let k = 0; k < n; k++) {
      const a = this.rng.range(0, Math.PI * 2), r = Math.sqrt(this.rng.next()) * z.radius;
      pool.emit(z.pos.x + Math.cos(a) * r, z.pos.y + 0.2, z.pos.z + Math.sin(a) * r, this.rng.range(-0.3, 0.3), look.rise * this.rng.range(0.5, 1.2), this.rng.range(-0.3, 0.3), this.c, look.size * this.rng.range(0.6, 1.4), this.rng.range(0.6, 1.6), look.additive ? -0.2 : 0.8, 0, 0.8);
    }
    if (z.kind === "conduction" && this.rng.next() < 3 * dt) {
      const a = this.rng.range(0, Math.PI * 2);
      this.boltXYZ(z.pos.x, z.pos.y + 0.3, z.pos.z, z.pos.x + Math.cos(a) * z.radius, z.pos.y + 0.2, z.pos.z + Math.sin(a) * z.radius, 0xfff27a, 0.12, 12, 1);
    }
    if (look.decal !== undefined) {
      let d = this.decals.get(z.id);
      if (!d) {
        d = new THREE.Mesh(new THREE.CircleGeometry(z.radius, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: look.decal, transparent: true, opacity: 0.45, depthWrite: false }));
        d.position.set(z.pos.x, z.pos.y + 0.06, z.pos.z);
        this.scene.add(d);
        this.decals.set(z.id, d);
      }
      (d.material as THREE.MeshBasicMaterial).opacity = 0.45 * fade * (0.85 + 0.15 * Math.sin(t * 3));
    }
  }

  /** QA counters (BattleView.snapshot, tests, tools/p7fx.ts). */
  stats(): { glowSpawned: number; smokeSpawned: number; glowLive: number; smokeLive: number; motes: number; projectiles: number; zoneDecals: number; transients: Record<TransientKind, number> } {
    const tr: Record<TransientKind, number> = { beam: 0, ring: 0, bolt: 0, decal: 0 };
    for (const x of this.transients) tr[x.kind]++;
    return {
      glowSpawned: this.glow.spawned,
      smokeSpawned: this.smoke.spawned,
      glowLive: this.glow.alive(),
      smokeLive: this.smoke.alive(),
      motes: this.motes,
      projectiles: this.projectiles.size,
      zoneDecals: this.decals.size,
      transients: tr,
    };
  }

  /** QA: drop every live particle and transient (projectile meshes and zone decals stay with the battle). */
  clearAll(): void {
    this.glow.clear();
    this.smoke.clear();
    for (const tr of this.transients) this.retire(tr);
    this.transients.length = 0;
  }

  /** Release every GPU resource this director created (pools, projectiles, transients, decals, shared geometry). */
  dispose(): void {
    this.glow.dispose();
    this.smoke.dispose();
    for (const m of this.projectiles.values()) this.disposeProjectile(m);
    this.projectiles.clear();
    for (const m of this.decals.values()) {
      m.removeFromParent();
      (m.material as THREE.Material).dispose();
      m.geometry.dispose();
    }
    this.decals.clear();
    for (const tr of this.transients) this.retire(tr);
    this.transients.length = 0;
    this.ringGeo.dispose();
    this.sphereGeo.dispose();
    this.scorchGeo.dispose();
  }
}
