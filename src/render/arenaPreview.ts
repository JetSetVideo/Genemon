/**
 * ArenaPreview [P4-A1]: one arena seen from the OUTSIDE before a battle. Frames the whole stadium,
 * auto-orbits slowly until the player drags, and can overlay iso-height contours (topology) and a
 * ground highlight (dims every other ground type). Weather and hour can be switched live.
 * Pass 5 [P5-W1]: start markers for both sides (the chosen slot glows, `setSpawn`), the symmetry
 * axis of a symmetric map, and `drawArenaMinimap` - a 2D top-down minimap (level bands, contours,
 * hillshade, water / lava, props, plateaus, spawn markers, symmetry axis) with `minimapPick` hit-testing.
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
import { type Arena, type ArenaKind, type ArenaSpec, generateArena, PROP_DEFS, SPAWN_SLOTS } from "../world/arena.ts";
import { ArenaView } from "./arenaView.ts";
import { textSprite } from "./textures.ts";
import type { Stage, View } from "./stage.ts";

export interface ArenaPreviewOptions {
  shadows: boolean;
  dark?: boolean;
  /** Start with the contour overlay on. */
  topology?: boolean;
  /** Chosen start slot of side 0 (default 0). */
  spawn?: number;
}

/** Team colours of the start markers (side 0 = you, side 1 = the opponent). */
export const SIDE_COLORS = ["#4cc9f0", "#ff6b6b"] as const;

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
  private spawn: number;
  private readonly markers = new THREE.Group();
  private readonly markerRings: THREE.Mesh[][] = [[], []];
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
    this.spawn = o.spawn ?? 0;
    this.buildMarkers();
    this.av.group.add(this.markers);
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

  /** The chosen start slot of side 0 (side 1 starts on its image). */
  get spawnSlot(): number {
    return this.spawn;
  }

  setSpawn(i: number): void {
    if (!Number.isInteger(i) || i < 0 || i >= this.arena.spawns.side0.length) return;
    this.spawn = i;
    this.paintMarkers();
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

  /** Start markers (a ring + a numbered tag per slot and side) and the symmetry axis. */
  private buildMarkers(): void {
    const a = this.arena;
    const ringGeo = new THREE.RingGeometry(0.75, 1.05, 32).rotateX(-Math.PI / 2);
    ([a.spawns.side0, a.spawns.side1] as const).forEach((list, side) => {
      const color = new THREE.Color(SIDE_COLORS[side]);
      list.forEach((p, i) => {
        const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false, fog: false, side: THREE.DoubleSide }));
        ring.position.set(p.x, p.y + 0.08, p.z);
        ring.renderOrder = 6;
        this.markerRings[side].push(ring);
        const tag = textSprite(side === 0 ? `${i + 1}` : `${i + 1}'`, SIDE_COLORS[side], 30);
        tag.scale.multiplyScalar(2.2);
        tag.position.set(p.x, p.y + 1.6, p.z);
        tag.name = `spawn-tag-${side}-${i}`;
        this.markers.add(ring, tag);
      });
    });
    if (a.symmetry !== "none") {
      const pts: THREE.Vector3[] = [];
      if (a.symmetry === "mirror") {
        for (let k = 0; k <= 40; k++) {
          const z = -a.radius + (2 * a.radius * k) / 40;
          pts.push(new THREE.Vector3(0, a.surfaceAt(0, z) + 0.1, z));
        }
      } else {
        for (let k = 0; k <= 48; k++) {
          const t = (k / 48) * Math.PI * 2, r = 1.6;
          pts.push(new THREE.Vector3(Math.cos(t) * r, a.surfaceAt(Math.cos(t) * r, Math.sin(t) * r) + 0.1, Math.sin(t) * r));
        }
      }
      const axis = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 0.8, gapSize: 0.5, transparent: true, opacity: 0.8, depthWrite: false, fog: false }));
      axis.computeLineDistances();
      axis.name = "symmetry-axis";
      axis.renderOrder = 6;
      this.markers.add(axis);
    }
    this.paintMarkers();
  }

  private paintMarkers(): void {
    for (let side = 0; side < 2; side++) {
      this.markerRings[side].forEach((ring, i) => {
        const on = i === this.spawn;
        ring.scale.setScalar(on ? 1.9 : 1);
        (ring.material as THREE.MeshBasicMaterial).opacity = on ? 1 : 0.45;
      });
    }
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
    const pulse = 1.9 + Math.sin(t * 3) * 0.15;
    for (let side = 0; side < 2; side++) this.markerRings[side][this.spawn]?.scale.setScalar(pulse);
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
      symmetry: this.arena.symmetry,
      density: this.arena.spec.density,
      altitudeM: this.arena.altitudeM,
      props: this.arena.props.length,
      innerProps: this.arena.innerProps().length,
      propMeshes: this.av.propMeshes,
      plateaus: this.arena.plateaus.length,
      spawn: this.spawn,
      spawnMarkers: this.markerRings[0].length + this.markerRings[1].length,
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

// ------------------------------------------------------------------ 2D minimap [P5-W1]

export interface MinimapOptions {
  /** Chosen start slot of side 0. */
  spawn: number;
  dark?: boolean;
  /** Slot under the pointer (drawn a little larger). */
  hover?: number | null;
}

/** Canvas pixels per metre and the centre, for a square canvas showing the playable circle + margin. */
function minimapFrame(a: Arena, w: number, h: number): { k: number; cx: number; cy: number } {
  const span = (a.radius + 1.6) * 2;
  return { k: Math.min(w, h) / span, cx: w / 2, cy: h / 2 };
}

/** Canvas pixel (CSS-scaled to the canvas' own resolution by the caller) -> arena metres. */
export function minimapToWorld(a: Arena, w: number, h: number, px: number, py: number): { x: number; z: number } {
  const f = minimapFrame(a, w, h);
  return { x: (px - f.cx) / f.k, z: (py - f.cy) / f.k };
}

/** Side-0 spawn slot under a canvas pixel (within ~1.8 m), or null. */
export function minimapPick(a: Arena, w: number, h: number, px: number, py: number): number | null {
  const p = minimapToWorld(a, w, h, px, py);
  return a.nearestSpawn(p.x, p.z, 0, 1.8 + 6 / minimapFrame(a, w, h).k);
}

const hexRgb = (c: number): [number, number, number] => [(c >> 16) & 255, (c >> 8) & 255, c & 255];

/**
 * Draw the top-down minimap: x to the right, z down (side 0 = you on the LEFT). Ground colours with
 * level-band shading + hillshade, contour lines between bands, liquids / lava, plateau outlines, props
 * (filled = solid cover, hollow = soft), the symmetry axis, and both sides' start markers (the chosen
 * one ringed; side 1's image marked "'"). Returns the number of drawn level bands (for QA).
 */
export function drawArenaMinimap(canvas: HTMLCanvasElement, a: Arena, o: MinimapOptions): number {
  const w = canvas.width, h = canvas.height;
  const g = canvas.getContext("2d");
  if (!g) return 0;
  const f = minimapFrame(a, w, h);
  const base = minimapBase(a, w, h, o.dark !== false);
  g.clearRect(0, 0, w, h);
  g.putImageData(base.img, 0, 0);
  drawOverlays(g, a, f, w, o);
  return base.bands;
}

const baseCache = new WeakMap<Arena, { w: number; h: number; version: number; dark: boolean; img: ImageData; bands: number }>();

/** The terrain raster of the minimap, cached per arena / size / ground version (hover redraws are cheap). */
function minimapBase(a: Arena, w: number, h: number, dark: boolean): { img: ImageData; bands: number } {
  const hit = baseCache.get(a);
  if (hit && hit.w === w && hit.h === h && hit.version === a.version && hit.dark === dark) return hit;
  const f = minimapFrame(a, w, h);
  const img = new ImageData(w, h);
  const d = img.data;
  const R2 = a.radius * a.radius, step = a.levelStep;
  const bands = new Set<number>();
  const level = (x: number, z: number) => Math.round(a.heightAt(x, z) / step);
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const x = (px + 0.5 - f.cx) / f.k, z = (py + 0.5 - f.cy) / f.k;
      const o4 = (py * w + px) * 4;
      if (x * x + z * z > R2) {
        d[o4 + 3] = 0;
        continue;
      }
      const gr = a.groundAt(x, z);
      let [r, gg, b] = hexRgb(gr.color);
      const lv = level(x, z);
      bands.add(lv);
      if (gr.liquid) {
        // Water and lava: flat, with a soft depth tint.
        const deep = THREE.MathUtils.clamp((a.waterLevel - a.heightAt(x, z)) * 0.25, 0, 0.35);
        r *= 1 - deep;
        gg *= 1 - deep;
        b *= 1 - deep * 0.5;
      } else {
        const { gx, gz } = a.gradientAt(x, z);
        const shade = THREE.MathUtils.clamp(1 + (gx + gz) * 0.55, 0.55, 1.35); // light from the north-west
        const band = 0.8 + 0.09 * THREE.MathUtils.clamp(lv, -3, 4) + (((lv % 2) + 2) % 2) * 0.07;
        r *= shade * band;
        gg *= shade * band;
        b *= shade * band;
        // Contour between bands: dark pixels where the level changes within ~1.5 px (a 2-3 px line).
        const e = 1.5 / f.k;
        if (level(x + e, z) !== lv || level(x, z + e) !== lv || level(x - e, z) !== lv || level(x, z - e) !== lv) {
          r *= 0.32;
          gg *= 0.32;
          b *= 0.32;
        }
      }
      d[o4] = Math.min(255, r);
      d[o4 + 1] = Math.min(255, gg);
      d[o4 + 2] = Math.min(255, b);
      d[o4 + 3] = 255;
    }
  }
  const out = { w, h, version: a.version, dark, img, bands: bands.size };
  baseCache.set(a, out);
  return out;
}

function drawOverlays(g: CanvasRenderingContext2D, a: Arena, f: { k: number; cx: number; cy: number }, w: number, o: MinimapOptions): void {
  const X = (x: number) => f.cx + x * f.k, Y = (z: number) => f.cy + z * f.k;
  const ink = o.dark === false ? "#0b0f15" : "#e8f1ff";
  // Playable ring.
  g.lineWidth = 2;
  g.strokeStyle = ink;
  g.globalAlpha = 0.6;
  g.beginPath();
  g.arc(f.cx, f.cy, a.radius * f.k, 0, Math.PI * 2);
  g.stroke();
  g.globalAlpha = 1;
  // Plateaus: dashed outline + ramp tick.
  const px1 = Math.max(1, w / 320);
  g.setLineDash([4 * px1, 3 * px1]);
  g.lineWidth = 2 * px1;
  for (const p of a.plateaus) {
    g.strokeStyle = "rgba(255, 209, 102, 0.95)";
    g.beginPath();
    g.arc(X(p.x), Y(p.z), p.r * f.k, 0, Math.PI * 2);
    g.stroke();
  }
  g.setLineDash([]);
  // Ramps: a white arrow running DOWN the gentle side of each plateau.
  for (const p of a.plateaus) {
    const c = Math.cos(p.rampAngle), sn = Math.sin(p.rampAngle);
    const x0 = X(p.x + c * p.r * 0.55), y0 = Y(p.z + sn * p.r * 0.55);
    const x1 = X(p.x + c * (p.r + 2.4)), y1 = Y(p.z + sn * (p.r + 2.4));
    const hl = 6 * px1;
    g.strokeStyle = "#ffffff";
    g.fillStyle = "#ffffff";
    g.lineWidth = 2.5 * px1;
    g.beginPath();
    g.moveTo(x0, y0);
    g.lineTo(x1, y1);
    g.stroke();
    g.beginPath();
    g.moveTo(x1 + c * hl, y1 + sn * hl);
    g.lineTo(x1 - sn * hl * 0.7, y1 + c * hl * 0.7);
    g.lineTo(x1 + sn * hl * 0.7, y1 - c * hl * 0.7);
    g.closePath();
    g.fill();
  }
  // Props.
  for (const p of a.props) {
    if (!p.inner) continue;
    const r = Math.max(2, p.radius * f.k);
    const px = X(p.x), py = Y(p.z);
    g.beginPath();
    switch (p.kind) {
      case "tree":
      case "bush":
        g.arc(px, py, p.kind === "tree" ? Math.max(3, r * 2.2) : r, 0, Math.PI * 2);
        break;
      case "pillar":
      case "ruin":
        g.rect(px - r, py - r * (p.kind === "ruin" ? 0.5 : 1), r * 2, r * (p.kind === "ruin" ? 1 : 2));
        break;
      case "crystal":
        g.moveTo(px, py - r * 1.3);
        g.lineTo(px + r, py);
        g.lineTo(px, py + r * 1.3);
        g.lineTo(px - r, py);
        g.closePath();
        break;
      default:
        g.arc(px, py, r, 0, Math.PI * 2);
    }
    const fill = { tree: "#1f5a28", bush: "#6fae4a", rock: "#3d3b38", pillar: "#e4e9ef", ruin: "#c9bfae", crystal: "#c9b6ff", reed: "#b6d36a", dune: "#f0e2a8" }[p.kind];
    g.globalAlpha = PROP_DEFS[p.kind].solid ? 0.95 : 0.55;
    g.fillStyle = fill;
    g.fill();
    g.globalAlpha = 1;
    g.lineWidth = 1;
    g.strokeStyle = "rgba(0,0,0,0.85)";
    g.lineWidth = 1.4 * px1;
    g.stroke();
  }
  // Symmetry axis.
  if (a.symmetry !== "none") {
    g.setLineDash([6 * px1, 5 * px1]);
    g.lineWidth = 2 * px1;
    g.strokeStyle = ink;
    g.beginPath();
    if (a.symmetry === "mirror") {
      g.moveTo(f.cx, Y(-a.radius));
      g.lineTo(f.cx, Y(a.radius));
    } else g.arc(f.cx, f.cy, 1.6 * f.k, 0, Math.PI * 2);
    g.stroke();
    g.setLineDash([]);
    g.fillStyle = ink;
    g.font = "600 11px system-ui, sans-serif";
    g.textAlign = "center";
    g.font = `700 ${Math.round(11 * px1)}px system-ui, sans-serif`;
    g.textBaseline = "middle";
    if (a.symmetry === "mirror") g.fillText("mirror", f.cx, Y(-a.radius) + 26 * px1);
    else g.fillText("180°", f.cx, f.cy);
  }
  // Start markers: side 1 (images) first, side 0 (choosable) on top.
  g.textAlign = "center";
  g.textBaseline = "middle";
  for (const side of [1, 0] as const) {
    const list = side === 0 ? a.spawns.side0 : a.spawns.side1;
    list.forEach((p, i) => {
      const on = i === o.spawn, hov = side === 0 && i === o.hover;
      const r = (on ? 11 : hov ? 10 : 8.5) * Math.max(0.8, w / 320);
      g.beginPath();
      g.arc(X(p.x), Y(p.z), r, 0, Math.PI * 2);
      g.fillStyle = side === 0 ? (on ? SIDE_COLORS[0] : "rgba(11,15,21,0.85)") : on ? SIDE_COLORS[1] : "rgba(11,15,21,0.6)";
      g.fill();
      g.lineWidth = on ? 3 : 1.5;
      g.strokeStyle = SIDE_COLORS[side];
      g.stroke();
      g.fillStyle = on ? "#0b0f15" : SIDE_COLORS[side];
      g.font = `700 ${Math.round(r * 1.2)}px system-ui, sans-serif`;
      g.fillText(side === 0 ? String(i + 1) : `${i + 1}'`, X(p.x), Y(p.z) + 0.5);
    });
  }
}

/** Slot labels for the start picker (SPAWN_SLOTS re-exported for the screen). */
export const SPAWN_LABELS: readonly string[] = SPAWN_SLOTS.map((s) => s.label);
