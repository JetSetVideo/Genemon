/**
 * ArenaPreview [P4-A1]: one arena seen from the OUTSIDE before a battle. Frames the whole stadium,
 * auto-orbits slowly until the player drags, and can overlay iso-height contours (topology) and a
 * ground highlight (dims every other ground type). Weather and hour can be switched live.
 *
 * Shared-state discipline (Stage.setView disposes the OLD view after the NEW one is constructed):
 * - never set shared OrbitControls limits; distance / polar angle are clamped per frame in update();
 * - controls.enabled and scene.fog are re-asserted per frame while this view is active, because the
 *   previous view's dispose() may reset them after our constructor ran;
 * - dispose() only resets scene.fog if it is still ours, and leaves controls.enabled to the next view.
 */
import * as THREE from "../lib/three.ts";
import { GROUND_IDS, type GroundId, GROUNDS } from "../data/grounds.ts";
import { type WeatherId, WEATHERS } from "../data/weather.ts";
import { type Arena, type ArenaKind, type ArenaSpec, generateArena } from "../world/arena.ts";
import { ArenaView } from "./arenaView.ts";
import type { Stage, View } from "./stage.ts";

export interface ArenaPreviewOptions {
  shadows: boolean;
  dark?: boolean;
  /** Start with the contour overlay on. */
  topology?: boolean;
}

/** Camera framing, in multiples of the arena size (side length). */
const DIST0 = 1.7, DIST_MIN = 0.75, DIST_MAX = 2.6;
const ELEV0 = 35 * Math.PI / 180;
/** Polar angle limits (from +Y): never under the stands' horizon, never straight down. */
const POLAR_MIN = 0.12, POLAR_MAX = 1.36;
const ORBIT_SPEED = 0.12;
/** Battle-camera distance the weather fog densities were tuned for. */
const FOG_REF = 28;

export class ArenaPreview implements View {
  readonly arena: Arena;
  private av: ArenaView;
  private weather: WeatherId;
  private hour: number;
  private fog: THREE.FogExp2;
  private fogBase = 0;
  private contours: THREE.LineSegments;
  private contourLevels = 0;
  private highlightMesh: THREE.Mesh;
  private highlight: GroundId | null = null;
  private topology: boolean;
  private autoOrbit = true;
  private yaw = 0.6;
  private readonly target = new THREE.Vector3();
  private readonly onStart = () => {
    this.autoOrbit = false;
  };
  private readonly tmp = new THREE.Vector3();
  private readonly sph = new THREE.Spherical();

  constructor(private stage: Stage, spec: ArenaSpec, private o: ArenaPreviewOptions) {
    this.arena = generateArena(spec);
    this.weather = spec.weather;
    this.hour = spec.hour;
    this.topology = !!o.topology;
    this.av = new ArenaView(this.arena, stage.scene, o.shadows);
    this.fog = new THREE.FogExp2(0xffffff, 0);
    this.applyConditions();
    this.contours = this.buildContours();
    this.contours.visible = this.topology;
    this.av.group.add(this.contours);
    this.highlightMesh = this.buildHighlight();
    this.highlightMesh.visible = false;
    this.av.group.add(this.highlightMesh);
    // Frame the whole stadium from outside.
    const a = this.arena;
    this.target.set(0, Math.max(0, a.waterLevel) * 0.3 + 0.5, 0);
    const d = a.size * DIST0;
    const cam = stage.camera;
    cam.position.set(Math.sin(this.yaw) * Math.cos(ELEV0) * d, this.target.y + Math.sin(ELEV0) * d, Math.cos(this.yaw) * Math.cos(ELEV0) * d);
    stage.controls.target.copy(this.target);
    stage.controls.enabled = true;
    stage.controls.update();
    cam.lookAt(this.target);
    stage.controls.addEventListener("start", this.onStart);
  }

  get kind(): ArenaKind {
    return this.arena.spec.kind;
  }

  /** Weather and hour currently previewed. */
  get conditions(): { weather: WeatherId; hour: number } {
    return { weather: this.weather, hour: this.hour };
  }

  setWeather(w: WeatherId): void {
    if (w === this.weather) return;
    this.weather = w;
    this.applyConditions();
  }

  setHour(h: number): void {
    this.hour = ((h % 24) + 24) % 24;
    this.applyConditions();
  }

  setTopology(on: boolean): void {
    this.topology = on;
    this.contours.visible = on;
  }

  setHighlight(g: GroundId | null): void {
    this.highlight = g;
    if (!g) {
      this.highlightMesh.visible = false;
      return;
    }
    this.paintHighlight(g);
    this.highlightMesh.visible = true;
  }

  /** Resume or stop the slow auto-orbit (a drag stops it). */
  setAutoOrbit(on: boolean): void {
    this.autoOrbit = on;
  }

  /** Re-frame the stadium (distance and elevation back to the defaults, orbit resumes). */
  reframe(): void {
    const d = this.arena.size * DIST0;
    const off = this.tmp.set(Math.sin(this.yaw) * Math.cos(ELEV0) * d, Math.sin(ELEV0) * d, Math.cos(this.yaw) * Math.cos(ELEV0) * d);
    this.stage.camera.position.copy(this.target).add(off);
    this.stage.controls.target.copy(this.target);
    this.autoOrbit = true;
  }

  private applyConditions(): void {
    const sceneFog = this.stage.scene.fog;
    this.av.setConditions(WEATHERS[this.weather], this.hour);
    // ArenaView created a battle-tuned FogExp2; keep its colour, own the object, scale density by distance.
    const made = this.stage.scene.fog;
    if (made instanceof THREE.FogExp2 && made !== sceneFog) {
      this.fog.color.copy(made.color);
      this.fogBase = made.density;
    }
    this.stage.scene.fog = this.fog;
  }

  private buildContours(): THREE.LineSegments {
    const a = this.arena, n = a.n, H = a.heights;
    let lo = Infinity, hi = -Infinity;
    for (let k = 0; k < H.length; k++) {
      lo = Math.min(lo, H[k]);
      hi = Math.max(hi, H[k]);
    }
    const step = niceStep((hi - lo) / 14);
    const first = Math.ceil(lo / step) * step;
    const pos: number[] = [], col: number[] = [];
    const cLow = new THREE.Color(0x4cc9f0), cHigh = new THREE.Color(this.o.dark === false ? 0xff6b35 : 0xffd166), c = new THREE.Color();
    const lift = 0.06;
    const px = (i: number) => i * a.cell - a.half;
    let levels = 0;
    for (let lv = first; lv <= hi; lv += step) {
      levels++;
      const major = Math.abs(lv / (step * 5) - Math.round(lv / (step * 5))) < 1e-6;
      c.copy(cLow).lerp(cHigh, hi > lo ? (lv - lo) / (hi - lo) : 0);
      if (!major) c.multiplyScalar(0.75);
      for (let j = 0; j < n - 1; j++) {
        for (let i = 0; i < n - 1; i++) {
          // Corners in order around the cell: (i,j) (i+1,j) (i+1,j+1) (i,j+1).
          const cs: [number, number, number][] = [[i, j, H[j * n + i]], [i + 1, j, H[j * n + i + 1]], [i + 1, j + 1, H[(j + 1) * n + i + 1]], [i, j + 1, H[(j + 1) * n + i]]];
          const hits: number[] = [];
          for (let e = 0; e < 4; e++) {
            const p = cs[e], q = cs[(e + 1) % 4];
            if ((p[2] < lv) === (q[2] < lv)) continue;
            const t = (lv - p[2]) / (q[2] - p[2]);
            hits.push(px(p[0] + (q[0] - p[0]) * t), lv + lift, px(p[1] + (q[1] - p[1]) * t));
          }
          // 2 crossings = one segment; 4 (saddle) = two segments paired in edge order.
          for (let s = 0; s + 5 < hits.length; s += 6) {
            pos.push(...hits.slice(s, s + 6));
            col.push(c.r, c.g, c.b, c.r, c.g, c.b);
          }
        }
      }
    }
    this.contourLevels = levels;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    const m = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9, depthWrite: false, fog: false });
    const ls = new THREE.LineSegments(g, m);
    ls.renderOrder = 5;
    return ls;
  }

  private buildHighlight(): THREE.Mesh {
    const a = this.arena, n = a.n;
    const geo = new THREE.PlaneGeometry(a.size, a.size, n - 1, n - 1);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    for (let k = 0; k < pos.count; k++) pos.setY(k, a.surfaceAt(pos.getX(k), pos.getZ(k)) + 0.03);
    geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(pos.count * 4), 4));
    const m = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      fog: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    const mesh = new THREE.Mesh(geo, m);
    mesh.renderOrder = 4;
    return mesh;
  }

  private paintHighlight(g: GroundId): void {
    const a = this.arena;
    const geo = this.highlightMesh.geometry;
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const col = geo.attributes.color as THREE.BufferAttribute;
    const arr = col.array as Float32Array;
    const gi = GROUND_IDS.indexOf(g);
    const tint = new THREE.Color(GROUNDS[g].color).lerp(new THREE.Color(0xffffff), 0.35);
    for (let k = 0; k < pos.count; k++) {
      const [gx, gz] = a.toGrid(pos.getX(k), pos.getZ(k));
      const on = a.grounds[a.idx(Math.round(gx), Math.round(gz))] === gi;
      if (on) arr.set([tint.r, tint.g, tint.b, 0.22], k * 4);
      else arr.set([0.02, 0.03, 0.05, 0.72], k * 4);
    }
    col.needsUpdate = true;
  }

  update(dt: number, t: number): void {
    const st = this.stage, cam = st.camera, ctl = st.controls;
    // Re-assert what a late dispose() of the previous view may have reset.
    if (!ctl.enabled) ctl.enabled = true;
    if (st.scene.fog !== this.fog) st.scene.fog = this.fog;
    this.av.update(dt, WEATHERS[this.weather], t);
    const off = this.tmp.copy(cam.position).sub(ctl.target);
    this.sph.setFromVector3(off);
    if (this.autoOrbit) this.sph.theta += dt * ORBIT_SPEED;
    const size = this.arena.size;
    this.sph.radius = THREE.MathUtils.clamp(this.sph.radius, size * DIST_MIN, size * DIST_MAX);
    this.sph.phi = THREE.MathUtils.clamp(this.sph.phi, POLAR_MIN, POLAR_MAX);
    // Keep the pivot near the stadium so panning cannot lose it.
    const lim = this.arena.half;
    ctl.target.x = THREE.MathUtils.clamp(ctl.target.x, -lim, lim);
    ctl.target.z = THREE.MathUtils.clamp(ctl.target.z, -lim, lim);
    ctl.target.y = THREE.MathUtils.clamp(ctl.target.y, -2, 8);
    off.setFromSpherical(this.sph);
    cam.position.copy(ctl.target).add(off);
    cam.lookAt(ctl.target);
    this.yaw = this.sph.theta;
    // Weather fog was tuned for a ~28 m battle camera: thin it out with distance so the stadium stays legible.
    this.fog.density = this.fogBase * THREE.MathUtils.clamp(FOG_REF / this.sph.radius, 0.2, 1);
    if (this.highlight && this.highlightMesh.visible) {
      (this.highlightMesh.material as THREE.MeshBasicMaterial).opacity = 0.85 + Math.sin(t * 2.4) * 0.15;
    }
  }

  snapshot(): Record<string, unknown> {
    const cam = this.stage.camera;
    return {
      view: "arenaPreview",
      kind: this.arena.spec.kind,
      seed: this.arena.spec.seed,
      weather: this.weather,
      hour: this.hour,
      cameraDistance: Math.round(cam.position.distanceTo(this.stage.controls.target) * 100) / 100,
      polar: Math.round(this.sph.phi * 1000) / 1000,
      autoOrbit: this.autoOrbit,
      topology: this.topology,
      contourLevels: this.contourLevels,
      contourSegments: (this.contours.geometry.attributes.position as THREE.BufferAttribute).count / 2,
      highlight: this.highlight,
      fogDensity: Math.round(this.fog.density * 1e5) / 1e5,
    };
  }

  dispose(): void {
    this.stage.controls.removeEventListener("start", this.onStart);
    // ArenaView.dispose() nulls scene.fog unconditionally: keep whatever the NEXT view already set.
    const fog = this.stage.scene.fog;
    const mats = new Set<THREE.Material>();
    this.av.group.traverse((obj) => {
      const m = (obj as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(m)) m.forEach((x) => mats.add(x));
      else if (m) mats.add(m);
    });
    this.av.dispose(); // geometries (incl. contours + highlight, children of av.group) + removal
    for (const m of mats) {
      const map = (m as THREE.PointsMaterial).map;
      if (map) map.dispose();
      m.dispose();
    }
    this.stage.scene.fog = fog === this.fog ? null : fog;
  }
}

/** 1 / 2 / 2.5 / 5 x 10^k step closest above `raw`. */
function niceStep(raw: number): number {
  if (!(raw > 0)) return 0.25;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= raw) return m * p;
  return 10 * p;
}
