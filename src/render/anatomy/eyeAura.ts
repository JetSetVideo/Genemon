/**
 * EyeAura (pass 4, lane face): a small render-only particle emitter for things leaking out of the eyes
 * (helix.eyes.aura): smoke (grey-violet wisps rising, NORMAL blending so it reads in daylight), flame
 * (element-coloured licks, additive), spark (short yellow-white crackles, additive), frost (pale cyan
 * motes drifting down) and tears (blue drops falling).
 *
 * Particles live in WORLD space: add `points` to the scene (not to the creature), and call
 * `update(dt, headWorldMatrix)` every frame with the head joint's `matrixWorld`; the emitters
 * (FaceParts.auraEmitters, head-joint space) are carried through that matrix, so smoke trails behind a
 * moving head. Math.random is allowed here: cosmetic jitter only, it never feeds the simulation.
 *
 * Pass 5: up to 8 eyes. The total emission grows like 2 sqrt(n / 2) past two eyes (`auraWeight`), not
 * linearly, so an eight-eyed creature smokes twice as much as a pair, not four times (less effect spam).
 */
import * as THREE from "../../lib/three.ts";
import type { EyeAura as AuraKind } from "../../genome/morphTypes.ts";

interface Profile {
  rate: number; // particles per second per emitter at intensity 1
  life: number; // seconds
  speed: number; // emitter-radius units per second
  gravity: number; // emitter-radius units per s^2 (+ = up)
  spread: number;
  size: number; // sprite size in emitter-radius units
  color: number;
  additive: boolean;
  opacity: number;
}

const PROFILES: Record<Exclude<AuraKind, "none">, Profile> = {
  smoke: { rate: 9, life: 1.5, speed: 1.3, gravity: 0.8, spread: 0.6, size: 2.4, color: 0x8a7f9e, additive: false, opacity: 0.55 },
  flame: { rate: 16, life: 0.5, speed: 2.4, gravity: 2.5, spread: 0.45, size: 1.6, color: 0xff5a1f, additive: true, opacity: 0.9 },
  spark: { rate: 14, life: 0.18, speed: 6, gravity: 0, spread: 1.6, size: 0.7, color: 0xfff3a0, additive: true, opacity: 1 },
  frost: { rate: 7, life: 1.7, speed: 0.6, gravity: -0.6, spread: 0.8, size: 0.9, color: 0xbff6ff, additive: false, opacity: 0.85 },
  tears: { rate: 3, life: 0.9, speed: 0.3, gravity: -9, spread: 0.15, size: 0.8, color: 0x3b8cff, additive: false, opacity: 0.95 },
};

function spriteTexture(kind: AuraKind): THREE.CanvasTexture | null {
  if (typeof document === "undefined") return null;
  const s = 64;
  const c = document.createElement("canvas");
  c.width = c.height = s;
  const g = c.getContext("2d")!;
  if (kind === "tears") {
    // A drop: round bottom, pointed top.
    g.fillStyle = "rgba(255,255,255,1)";
    g.beginPath();
    g.moveTo(s / 2, s * 0.08);
    g.quadraticCurveTo(s * 0.78, s * 0.55, s / 2, s * 0.9);
    g.quadraticCurveTo(s * 0.22, s * 0.55, s / 2, s * 0.08);
    g.fill();
  } else {
    const soft = kind === "smoke" ? 0.15 : kind === "spark" ? 0.55 : 0.35;
    const r = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    r.addColorStop(0, "rgba(255,255,255,1)");
    r.addColorStop(soft, "rgba(255,255,255,0.75)");
    r.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = r;
    g.fillRect(0, 0, s, s);
  }
  return new THREE.CanvasTexture(c);
}

/** Emission weight of `n` eye emitters: n up to 2, then 2 sqrt(n / 2) (8 eyes = 4, not 8). */
export function auraWeight(n: number): number {
  const k = Math.max(0, Math.round(Number.isFinite(n) ? n : 0));
  return k <= 2 ? k : 2 * Math.sqrt(k / 2);
}

export class EyeAura {
  readonly points: THREE.Points;
  private readonly geo = new THREE.BufferGeometry();
  private readonly mat: THREE.PointsMaterial;
  private readonly tex: THREE.CanvasTexture | null;
  private readonly prof: Profile | null;
  private readonly pos: Float32Array;
  private readonly col: Float32Array;
  private readonly vel: Float32Array;
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly base = new THREE.Color();
  private readonly world: THREE.Vector3[];
  private readonly emitters: THREE.Vector3[];
  private intensity = 1;
  private debt = 0;
  private next = 0;

  /**
   * @param kind      helix.eyes.aura
   * @param emitters  FaceParts.auraEmitters (head-joint space)
   * @param radius    eye radius in head-joint units (sizes and speeds scale with it)
   * @param color     element glow colour (used by flame; others keep their own code colour)
   */
  constructor(readonly kind: AuraKind, emitters: THREE.Vector3[], private readonly radius: number, color: number, quality: "low" | "high" = "high") {
    this.prof = kind === "none" ? null : { ...PROFILES[kind], color: kind === "flame" ? color : PROFILES[kind].color };
    this.emitters = emitters.map((e) => e.clone());
    this.world = emitters.map(() => new THREE.Vector3());
    const cap = Math.max(1, Math.ceil(auraWeight(emitters.length))) * (quality === "high" ? 40 : 20);
    this.pos = new Float32Array(cap * 3);
    this.col = new Float32Array(cap * 4);
    this.vel = new Float32Array(cap * 3);
    this.age = new Float32Array(cap).fill(1);
    this.life = new Float32Array(cap).fill(1);
    this.geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3));
    this.geo.setAttribute("color", new THREE.BufferAttribute(this.col, 4));
    this.tex = spriteTexture(kind);
    const p = this.prof;
    if (p) this.base.setHex(p.color);
    this.mat = new THREE.PointsMaterial({
      size: (p?.size ?? 1) * radius,
      map: this.tex,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      opacity: p?.opacity ?? 1,
      blending: p?.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      sizeAttenuation: true,
    });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
    this.points.visible = p !== null;
  }

  /** Charging a move raises the emission (0 = off .. 2 = blazing). */
  setIntensity(k: number): void {
    this.intensity = Math.max(0, Math.min(2, Number.isFinite(k) ? k : 0));
  }

  /** Number of live particles (QA / tests). */
  alive(): number {
    let n = 0;
    for (let i = 0; i < this.age.length; i++) if (this.age[i] < this.life[i]) n++;
    return n;
  }

  update(dt: number, headWorldMatrix: THREE.Matrix4): void {
    const p = this.prof;
    if (!p || !(dt > 0)) return;
    dt = Math.min(dt, 0.1);
    const scale = this.radius * headWorldMatrix.getMaxScaleOnAxis();
    for (let e = 0; e < this.emitters.length; e++) this.world[e].copy(this.emitters[e]).applyMatrix4(headWorldMatrix);
    const cap = this.age.length;
    // Spawn.
    this.debt += p.rate * (0.35 + this.intensity) * auraWeight(this.emitters.length) * dt;
    while (this.debt >= 1) {
      this.debt -= 1;
      const i = this.next;
      this.next = (this.next + 1) % cap;
      const w = this.world[Math.floor(Math.random() * this.world.length)];
      const j = (k: number) => (Math.random() - 0.5) * k;
      this.pos[i * 3] = w.x + j(scale * 0.6);
      this.pos[i * 3 + 1] = w.y + j(scale * 0.4);
      this.pos[i * 3 + 2] = w.z + j(scale * 0.6);
      const up = this.kind === "tears" || this.kind === "frost" ? -0.3 : 1;
      this.vel[i * 3] = j(p.spread) * p.speed * scale;
      this.vel[i * 3 + 1] = (up + j(p.spread)) * p.speed * scale * (this.kind === "spark" ? j(2) : 1);
      this.vel[i * 3 + 2] = j(p.spread) * p.speed * scale;
      this.age[i] = 0;
      this.life[i] = p.life * (0.7 + Math.random() * 0.6);
    }
    // Integrate + fade.
    const g = p.gravity * scale;
    for (let i = 0; i < cap; i++) {
      if (this.age[i] >= this.life[i]) {
        this.col[i * 4 + 3] = 0;
        continue;
      }
      this.age[i] += dt;
      const t = Math.min(1, this.age[i] / this.life[i]);
      this.vel[i * 3 + 1] += g * dt;
      if (this.kind === "smoke") {
        this.vel[i * 3] *= 1 - 0.6 * dt;
        this.vel[i * 3 + 2] *= 1 - 0.6 * dt;
      }
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      // Flame and spark are hotter at birth (kept under ~1.6x so the element hue survives ACES).
      const heat = p.additive ? 1 + 0.6 * (1 - t) : 1;
      this.col[i * 4] = this.base.r * heat;
      this.col[i * 4 + 1] = this.base.g * heat;
      this.col[i * 4 + 2] = this.base.b * heat;
      this.col[i * 4 + 3] = this.kind === "smoke" ? Math.sin(Math.PI * t) : 1 - t;
    }
    (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    this.points.removeFromParent();
    this.geo.dispose();
    this.mat.dispose();
    this.tex?.dispose();
  }
}
