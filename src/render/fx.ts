/**
 * FX: GPU point particles (additive glows + normal-blended smoke/dust), projectile meshes with
 * trails, beams, shockwave rings, lightning bolts, zone visuals (smoke clouds, wildfire, mud, bloom,
 * toxic water, blizzard, move fields) and a screen flash hook. Driven by BattleEvents.
 *
 * Pass 5 [P5-A1] calmer: fewer and smaller particles per event, a per-pool spawn BUDGET (token bucket:
 * a burst of events cannot flood the screen), caps on simultaneous rings / beams / bolts, shorter
 * trails, rate-based (frame-rate independent) streams, and the full-screen #flash goes through a
 * FlashLimiter (rare, weak, never twice within 1.6 s).
 */
import * as THREE from "../lib/three.ts";
import { ELEMENTS, type ElementId } from "../data/elements.ts";
import type { Battle, BattleEvent, Zone } from "../combat/battle.ts";
import { Rng } from "../core/rng.ts";

const VERT = `attribute float size; attribute float alpha; attribute vec3 tint; varying float vA; varying vec3 vC;
void main(){ vA = alpha; vC = tint; vec4 mv = modelViewMatrix * vec4(position,1.0); gl_PointSize = size * (320.0 / max(0.1, -mv.z)); gl_Position = projectionMatrix * mv; }`;
const FRAG = `varying float vA; varying vec3 vC; void main(){ vec2 d = gl_PointCoord - 0.5; float r = dot(d,d)*4.0; if (r > 1.0) discard; gl_FragColor = vec4(vC, vA * (1.0 - r)); }`;

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
  private head = 0;

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

  spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, color: THREE.Color, size: number, life: number, o: { grow?: number; gravity?: number; drag?: number } = {}): void {
    const i = this.head;
    this.head = (this.head + 1) % this.capacity;
    this.pos.set([x, y, z], i * 3);
    this.vel.set([vx, vy, vz], i * 3);
    this.col.set([color.r, color.g, color.b], i * 3);
    this.size[i] = size;
    this.life[i] = life;
    this.max[i] = life;
    this.grow[i] = o.grow ?? 0;
    this.grav[i] = o.gravity ?? 0;
    this.drag[i] = o.drag ?? 0.5;
    this.alpha[i] = 1;
  }

  update(dt: number): void {
    for (let i = 0; i < this.capacity; i++) {
      if (this.life[i] <= 0) {
        this.alpha[i] = 0;
        continue;
      }
      this.life[i] -= dt;
      const k = Math.max(0, 1 - this.drag[i] * dt);
      this.vel[i * 3] *= k;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * k - this.grav[i] * dt;
      this.vel[i * 3 + 2] *= k;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.size[i] += this.grow[i] * dt;
      const f = this.life[i] / this.max[i];
      this.alpha[i] = Math.min(1, f * 1.6) * Math.min(1, (1 - f) * 8 + 0.2);
    }
    const g = this.points.geometry;
    for (const a of ["position", "tint", "size", "alpha"]) (g.attributes[a] as THREE.BufferAttribute).needsUpdate = true;
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

/** Simultaneous transient caps (oldest of the kind is retired first). */
const TRANSIENT_CAP: Record<"beam" | "ring" | "bolt" | "decal", number> = { beam: 3, ring: 5, bolt: 5, decal: 8 };

interface Transient {
  obj: THREE.Object3D;
  life: number;
  max: number;
  kind: "beam" | "ring" | "bolt" | "decal";
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

export class FxDirector {
  readonly glow = new ParticlePool(2400, true);
  readonly smoke = new ParticlePool(1400, false);
  /** Spawn budgets per pool (particles/s, burst). */
  readonly glowBudget = new SpawnBudget(700, 260);
  readonly smokeBudget = new SpawnBudget(380, 160);
  readonly flashes = new FlashLimiter();
  private clock = 0;
  private transients: Transient[] = [];
  private projectiles = new Map<number, THREE.Mesh>();
  private decals = new Map<number, THREE.Mesh>();
  private rng = new Rng(99);
  private c = new THREE.Color();
  private ringGeo = new THREE.RingGeometry(0.85, 1, 48).rotateX(-Math.PI / 2);
  private sphereGeo = new THREE.SphereGeometry(1, 12, 8);
  onFlash: (strength: number, color: number) => void = () => {};
  /** Flashes actually shown (QA). */
  flashCount = 0;

  constructor(private scene: THREE.Scene) {
    scene.add(this.glow.points, this.smoke.points);
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
    const same = this.transients.filter((x) => x.kind === tr.kind);
    if (same.length >= TRANSIENT_CAP[tr.kind]) {
      const old = same[0];
      this.retire(old);
      this.transients.splice(this.transients.indexOf(old), 1);
    }
    this.scene.add(tr.obj);
    this.transients.push(tr);
  }

  private retire(tr: Transient): void {
    tr.obj.removeFromParent();
    tr.obj.traverse((o) => {
      const mm = o as THREE.Mesh;
      if (mm.isMesh || (o as THREE.LineSegments).isLineSegments) {
        if (mm.geometry !== this.ringGeo) mm.geometry?.dispose();
        (mm.material as THREE.Material)?.dispose();
      }
    });
  }

  private col(e: ElementId, core = false): THREE.Color {
    return this.c.setHex(core ? ELEMENTS[e].core : ELEMENTS[e].color);
  }

  burst(at: { x: number; y: number; z: number }, el: ElementId, n: number, speed: number, size: number, life = 0.6, up = 0.5): void {
    const pool = el === "earth" || el === "neutral" || el === "shadow" || el === "void" ? this.smoke : this.glow;
    n = this.budgetOf(pool).take(n);
    for (let k = 0; k < n; k++) {
      const a = this.rng.range(0, Math.PI * 2), b = this.rng.range(-0.2, 1);
      const s = speed * this.rng.range(0.4, 1);
      pool.spawn(at.x, at.y, at.z, Math.cos(a) * s, (b + up) * s, Math.sin(a) * s, this.col(el, k % 3 === 0), size * this.rng.range(0.6, 1.3), life * this.rng.range(0.6, 1.2), { gravity: 4, drag: 2 });
    }
  }

  dust(at: { x: number; y: number; z: number }, n: number, color = 0xb8a68a, size = 0.8): void {
    this.c.setHex(color);
    n = this.smokeBudget.take(n);
    for (let k = 0; k < n; k++) {
      const a = this.rng.range(0, Math.PI * 2), s = this.rng.range(0.8, 2.5);
      this.smoke.spawn(at.x, at.y + 0.1, at.z, Math.cos(a) * s, this.rng.range(0.3, 1.2), Math.sin(a) * s, this.c, size, this.rng.range(0.6, 1.2), { grow: 1.2, drag: 2.5, gravity: 0.3 });
    }
  }

  ring(at: { x: number; y: number; z: number }, color: number, radius: number, life = 0.45): void {
    const m = new THREE.Mesh(this.ringGeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    m.position.set(at.x, at.y + 0.15, at.z);
    m.userData.radius = radius;
    m.userData.peak = 0.6;
    this.addTransient({ obj: m, life, max: life, kind: "ring" });
  }

  beam(from: THREE.Vector3, to: THREE.Vector3, el: ElementId, width: number): void {
    const len = from.distanceTo(to);
    const geo = new THREE.CylinderGeometry(width, width, len, 10, 1, true);
    geo.translate(0, len / 2, 0);
    geo.rotateX(Math.PI / 2);
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: ELEMENTS[el].color, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false }));
    m.position.copy(from);
    m.lookAt(to);
    const core = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: ELEMENTS[el].core, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false }));
    core.scale.set(0.4, 0.4, 1);
    m.add(core);
    m.userData.peak = 0.8;
    this.addTransient({ obj: m, life: 0.32, max: 0.32, kind: "beam" });
    const n = this.glowBudget.take(10);
    for (let k = 0; k < n; k++) {
      const t = k / Math.max(1, n);
      const p = from.clone().lerp(to, t);
      this.glow.spawn(p.x, p.y, p.z, this.rng.range(-0.6, 0.6), this.rng.range(-0.3, 1), this.rng.range(-0.6, 0.6), this.col(el, k % 2 === 0), width * 2.2, 0.32);
    }
  }

  bolt(from: THREE.Vector3, to: THREE.Vector3, color = 0xfff6a0, life = 0.25): void {
    const pts: number[] = [];
    let prev = from.clone();
    const n = 12;
    for (let k = 1; k <= n; k++) {
      const p = from.clone().lerp(to, k / n);
      if (k < n) p.add(new THREE.Vector3(this.rng.range(-0.6, 0.6), this.rng.range(-0.4, 0.4), this.rng.range(-0.6, 0.6)));
      pts.push(prev.x, prev.y, prev.z, p.x, p.y, p.z);
      prev = p;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending }));
    l.userData.peak = 0.9;
    this.addTransient({ obj: l, life, max: life, kind: "bolt" });
  }

  /**
   * Breath / spray cone [P4-M2]: particles leave the mouth along directions inside the arc. Called
   * once at the strike and every frame of the active phase (sustained breath). Smoky elements use the
   * normal-blended pool so the cone reads in daylight, glowing ones the additive pool.
   */
  cone(from: THREE.Vector3, yaw: number, el: ElementId, range: number, arc: number, n: number, size: number): void {
    const smoky = el === "earth" || el === "shadow" || el === "void" || el === "poison" || el === "neutral";
    const pool = smoky ? this.smoke : this.glow;
    n = this.budgetOf(pool).take(n);
    for (let k = 0; k < n; k++) {
      const a = yaw + this.rng.range(-arc, arc) * 0.9, up = this.rng.range(-0.12, 0.18);
      const sp = (range / 0.42) * this.rng.range(0.55, 1.05);
      pool.spawn(from.x, from.y, from.z, Math.sin(a) * sp, up * sp, Math.cos(a) * sp, this.col(el, k % 3 === 0), size * this.rng.range(0.6, 1.4), this.rng.range(0.32, 0.5), { grow: 2.2, drag: 1.6 });
    }
  }

  /**
   * Sustained breath stream for one frame: `rate` particles per second (frame-rate independent),
   * replacing the old fixed count per frame (10 per frame = 1200/s at 120 fps).
   */
  coneStream(from: THREE.Vector3, yaw: number, el: ElementId, range: number, arc: number, dt: number, size: number, rate = 55): void {
    const n = countOf(rate * dt, this.rng.next());
    if (n > 0) this.cone(from, yaw, el, range, arc, n, size);
  }

  /** Expected-count helper for per-frame emitters elsewhere (render-only). */
  countFor(rate: number, dt: number): number {
    return countOf(rate * dt, this.rng.next());
  }

  /** Dash streak from the start to the arrival point (dust at the feet + an element streak). */
  dashTrail(from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }, el: ElementId, size: number): void {
    const n = this.glowBudget.take(9);
    for (let k = 0; k < n; k++) {
      const t = k / Math.max(1, n - 1), x = from.x + (to.x - from.x) * t, z = from.z + (to.z - from.z) * t, y = from.y + (to.y - from.y) * t;
      this.glow.spawn(x, y + size * 0.6, z, this.rng.range(-0.2, 0.2), this.rng.range(0, 0.4), this.rng.range(-0.2, 0.2), this.col(el, k % 2 === 0), size * 0.6, 0.22 + 0.16 * t, { drag: 3 });
      if (k % 4 === 0) this.dust({ x, y, z }, 1, 0xb8a68a, size * 0.5);
    }
  }

  /** A trainer throws a Genemon in: a light column + a ring in the side colour where it lands. */
  throwIn(at: { x: number; y: number; z: number }, color: number, height: number): void {
    this.ring(at, color, 1.6 + height * 0.7, 0.6);
    this.c.setHex(color);
    const n = this.glowBudget.take(28);
    for (let k = 0; k < n; k++) {
      const a = this.rng.range(0, Math.PI * 2), r = this.rng.range(0, 0.5 + height * 0.4);
      this.glow.spawn(at.x + Math.cos(a) * r, at.y + this.rng.range(0, height * 1.4), at.z + Math.sin(a) * r, 0, this.rng.range(1, 3.5), 0, this.c, 0.35, this.rng.range(0.4, 0.9), { drag: 1.5 });
    }
    this.flash(0.12, color);
  }

  /** React to the battle's new events (positions in world space). */
  consume(b: Battle, events: BattleEvent[], headOf: (idx: number) => THREE.Vector3): void {
    for (const e of events) {
      const el = e.element ?? "neutral";
      switch (e.type) {
        case "projectile": {
          const m = new THREE.Mesh(this.sphereGeo, new THREE.MeshBasicMaterial({ color: ELEMENTS[el].core }));
          const halo = new THREE.Mesh(this.sphereGeo, new THREE.MeshBasicMaterial({ color: ELEMENTS[el].color, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }));
          halo.scale.setScalar(1.9);
          m.add(halo);
          const p = b.projectiles.find((x) => x.id === e.value);
          m.scale.setScalar(p ? p.radius : 0.3);
          this.scene.add(m);
          this.projectiles.set(e.value!, m);
          break;
        }
        case "projectileEnd": {
          const m = this.projectiles.get(e.value!);
          if (m) {
            this.burst(m.position, el, 7, 2.4, 0.26, 0.35);
            m.removeFromParent();
            (m.material as THREE.Material).dispose();
            this.projectiles.delete(e.value!);
          }
          break;
        }
        case "hit": {
          if (!e.pos) break;
          const t = b.fighters[e.b!];
          const at = { x: e.pos.x, y: t.body.pos.y + t.ph.heightM * 0.5, z: e.pos.z };
          const k = Math.min(1, (e.value ?? 0) / Math.max(1, t.maxHp));
          this.burst(at, el, Math.round(6 + 18 * k + (e.crit ? 10 : 0)), 2.5 + 3.5 * k, 0.22 + k * 0.22, 0.45);
          if (e.label === "conduction") this.bolt(headOf(e.a!), new THREE.Vector3(at.x, at.y, at.z));
          if (e.crit) {
            this.ring(at, ELEMENTS[el].color, 2 + 2 * k, 0.4);
            if (k > 0.3) this.flash(0.35 + k * 0.4, ELEMENTS[el].core);
          }
          break;
        }
        case "miss":
          if (e.pos) this.dust(e.pos, 6, 0xcfc6b0, 0.5);
          break;
        case "phase":
          if (e.label === "beam" && e.pos && e.a !== undefined) this.beam(headOf(e.a), new THREE.Vector3(e.pos.x, e.pos.y + b.fighters[e.b!].ph.heightM * 0.4, e.pos.z), el, 0.18);
          if (e.label === "emerge" && e.pos) this.dust(e.pos, 14, 0x8a6a44, 1);
          if (e.label === "cone" && e.pos && e.a !== undefined) {
            const f = b.fighters[e.a], tg = b.fighters[e.b ?? e.a];
            const yaw = Math.atan2(tg.body.pos.x - f.body.pos.x, tg.body.pos.z - f.body.pos.z);
            this.cone(new THREE.Vector3(e.pos.x, e.pos.y, e.pos.z), yaw, el, e.value ?? 5, f.move?.arc ?? 0.45, 36, 0.4 + 0.12 * f.ph.heightM);
          }
          if (e.label === "dash" && e.pos && e.a !== undefined) {
            const f = b.fighters[e.a];
            this.dashTrail(f.body.pos, e.pos, el, 0.4 + 0.3 * f.ph.heightM);
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

  /** Per-frame: projectile meshes + trails, zone visuals, transients, particle simulation. */
  update(b: Battle, dt: number, t: number): void {
    this.clock += dt;
    this.glowBudget.refill(dt);
    this.smokeBudget.refill(dt);
    for (const p of b.projectiles) {
      const m = this.projectiles.get(p.id);
      if (!m) continue;
      m.position.set(p.pos.x, p.pos.y, p.pos.z);
      const c = this.col(p.element);
      // Short trail: ~28 particles/s per projectile, short-lived.
      const n = this.glowBudget.take(countOf(28 * dt, this.rng.next()));
      for (let k = 0; k < n; k++) {
        this.glow.spawn(p.pos.x, p.pos.y, p.pos.z, this.rng.range(-0.3, 0.3), this.rng.range(-0.1, 0.4), this.rng.range(-0.3, 0.3), c, p.radius * 1.7, 0.2, { drag: 3 });
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
      if (mat) mat.opacity = f * ((tr.obj.userData.peak as number | undefined) ?? 1);
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
      pool.spawn(z.pos.x + Math.cos(a) * r, z.pos.y + 0.2, z.pos.z + Math.sin(a) * r, this.rng.range(-0.3, 0.3), look.rise * this.rng.range(0.5, 1.2), this.rng.range(-0.3, 0.3), this.c, look.size * this.rng.range(0.6, 1.4), this.rng.range(0.6, 1.6), { grow: look.additive ? -0.2 : 0.8, drag: 0.8 });
    }
    if (z.kind === "conduction" && this.rng.next() < 3 * dt) {
      const a = this.rng.range(0, Math.PI * 2);
      this.bolt(new THREE.Vector3(z.pos.x, z.pos.y + 0.3, z.pos.z), new THREE.Vector3(z.pos.x + Math.cos(a) * z.radius, z.pos.y + 0.2, z.pos.z + Math.sin(a) * z.radius), 0xfff27a, 0.12);
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

  dispose(): void {
    this.glow.dispose();
    this.smoke.dispose();
    for (const m of this.projectiles.values()) m.removeFromParent();
    for (const m of this.decals.values()) m.removeFromParent();
    for (const tr of this.transients) tr.obj.removeFromParent();
  }
}
