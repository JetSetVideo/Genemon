/**
 * WorldView: the player's neighbourhood as a 3D map (the World screen's "Google map").
 * - Terrain: WorldMap.heightAt sampled over a 6 km square around the centre (1 unit = 25 m,
 *   heights x3), vertex-coloured by groundAt, so each place disc shows its own ground.
 * - Places: a pillar + glowing sphere coloured per kind, a footprint ring at the place radius and
 *   a constant-size name label (dimmed until this profile discovers the place).
 * - Territory: every owned cell as a translucent tile draped on the terrain, yours in the accent
 *   colour, others in a hue hashed from the owner id; opacity follows the decayed garrison.
 * - The avatar: a floating pin over the avatar's place.
 * - Relief and density [P5-W1]: altitude bands in the terrain colours, contour lines every 10 m
 *   (bold every 50 m), ▲ peak / ▼ hollow altitude labels (WorldMap.reliefMarks), and an instanced
 *   cover layer of trees, rocks and scrub (WorldMap.coverAt) on a jittered 60 m lattice.
 * Scene axes: x = east, y = up, z = SOUTH (north is -z, away from the default camera).
 * Read-only over the world: the World screen performs every action, then calls refresh().
 */
import * as THREE from "../lib/three.ts";
import type { V3 } from "../core/math.ts";
import { hashSeed, Rng } from "../core/rng.ts";
import { GROUNDS } from "../data/grounds.ts";
import type { Place, PlaceKind, WorldMap } from "../world/worldmap.ts";
import { textSprite } from "./textures.ts";
import type { Stage, View } from "./stage.ts";

/** Metres per scene unit. */
export const MAP_UNIT_M = 25;
/** Vertical exaggeration of the terrain and of every altitude drawn on it. */
export const MAP_HEIGHT_X = 3;
/** Side of the terrain square in metres (a generated neighbourhood reaches 2.5 km from home). */
export const MAP_SIZE_M = 6000;
/** Terrain samples per side - 1 (40 m between samples). */
const SEGMENTS = 150;
const PILLAR_H = 4;
const PIN_Y = 10.5;
/** Label height as a fraction of the projection scale (~20 px on a 700 px tall view). */
const LABEL_H = 0.026;
const MIN_DIST = 6;
const MAX_DIST = 380;
/** Keep the camera above the ground: polar angle from straight up <= ~76 deg. */
const MAX_POLAR = 1.32;
const BG = { dark: 0x0b1220, light: 0xdbe6f0 } as const;
/** Contour interval and the bold every-Nth line (metres). */
export const CONTOUR_M = 10;
const CONTOUR_MAJOR = 5;
/** Cover lattice spacing (m) and the instance caps per kind. */
const COVER_STEP_M = 60;
const COVER_CAP = { trees: 4500, rocks: 1500, scrub: 2500 } as const;
const ACCENT = { dark: 0x4cc9f0, light: 0x0077b6 } as const;

/** Marker colour per place kind (also used by the World screen's kind chips). */
export const PLACE_COLORS: Record<PlaceKind, number> = {
  home: 0xffb703,
  supermarket: 0x2a9d8f,
  gym: 0xe76f51,
  park: 0x6a994e,
  lake: 0x1d70d6,
  forest: 0x2d6a4f,
  cafe: 0xa47148,
  school: 0x8d99ae,
  office: 0x6c757d,
  station: 0xc9a227,
  museum: 0xb5838d,
  beach: 0xd4a373,
  mountain: 0x8a5a44,
  hospital: 0xd62828,
  library: 0xc9184a,
  stadium: 0x0096c7,
  farmersMarket: 0x80b918,
  river: 0x48a9d6,
  arena: 0xf72585,
  dungeon: 0x3c3c64,
  portal: 0x9b5de5,
  pool: 0x00b4d8,
  garden: 0x52b788,
  harbour: 0x3a5a98,
  landmark: 0xf4a261,
  plaza: 0x8e7dbe,
};

/** Territory colour: the player's accent, or a stable hue per owner (never near the accent's cyan). */
export function ownerColor(ownerId: string, playerId: string, dark: boolean): number {
  if (ownerId === playerId) return dark ? ACCENT.dark : ACCENT.light;
  const hue = ((hashSeed(ownerId, "territory") % 300) + 230) % 360;
  return new THREE.Color().setHSL(hue / 360, 0.7, 0.55, THREE.SRGBColorSpace).getHex();
}

export interface WorldViewOptions {
  dark: boolean;
  /** Map centre in the world's local ENU metres (the profile's home). */
  centre: V3;
  profileId: string;
}

type Holder = THREE.Object3D & { geometry?: THREE.BufferGeometry; material?: THREE.Material | THREE.Material[] };

/** Dispose every geometry, material and texture under root once (sprites share three's quad: skipped). */
function disposeTree(root: THREE.Object3D): void {
  const geos = new Set<THREE.BufferGeometry>();
  const mats = new Set<THREE.Material>();
  const texs = new Set<THREE.Texture>();
  root.traverse((o) => {
    const x = o as Holder;
    if (x.geometry && !(o instanceof THREE.Sprite)) geos.add(x.geometry);
    const list = x.material === undefined ? [] : Array.isArray(x.material) ? x.material : [x.material];
    for (const m of list) {
      mats.add(m);
      const map = (m as THREE.Material & { map?: THREE.Texture | null }).map;
      if (map) texs.add(map);
    }
  });
  for (const g of geos) g.dispose();
  for (const m of mats) m.dispose();
  for (const t of texs) t.dispose();
}

const clampN = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export class WorldView implements View {
  readonly world: WorldMap;
  readonly profileId: string;
  private readonly stage: Stage;
  private readonly centre: V3;
  private readonly centreAlt: number;
  private readonly half = MAP_SIZE_M / 2;
  private readonly group = new THREE.Group();
  private readonly markers = new THREE.Group();
  private readonly cells = new THREE.Group();
  private readonly avatar = new THREE.Group();
  private readonly pin = new THREE.Group();
  private readonly pulse: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  private readonly avatarMat: THREE.MeshStandardMaterial;
  private readonly beamMat: THREE.MeshBasicMaterial;
  private readonly bg = new THREE.Color();
  private readonly fog: THREE.Fog;
  private readonly heads = new Map<string, THREE.Mesh>();
  private readonly tmp = new THREE.Vector3();
  private readonly terrainVertices: number;
  private dark: boolean;
  private avatarId: string | null = null;
  private focusId: string | null = null;
  private glide: { from: THREE.Vector3; to: THREE.Vector3; t: number } | null = null;
  private activated = false;
  private disposed = false;
  private lastT = 0;
  private counts = { places: 0, discovered: 0, territories: 0, own: 0 };
  private relief = { contourSegments: 0, labels: 0, trees: 0, rocks: 0, scrub: 0 };
  private readonly contourMats: THREE.LineBasicMaterial[] = [];

  constructor(stage: Stage, world: WorldMap, opts: WorldViewOptions) {
    this.stage = stage;
    this.world = world;
    this.profileId = opts.profileId;
    this.centre = { x: opts.centre.x, y: opts.centre.y, z: opts.centre.z };
    this.centreAlt = world.heightAt(opts.centre.x, opts.centre.z);
    this.dark = opts.dark;
    this.bg.setHex(opts.dark ? BG.dark : BG.light);
    this.fog = new THREE.Fog(this.bg.getHex(), 260, 620);
    const accent = this.accent();
    this.avatarMat = new THREE.MeshStandardMaterial({ color: accent, emissive: accent, emissiveIntensity: 0.55, roughness: 0.35, metalness: 0.1 });
    this.beamMat = new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.45, depthWrite: false });
    this.pulse = new THREE.Mesh(
      new THREE.RingGeometry(1.5, 2.1, 40).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.6, depthWrite: false, side: THREE.DoubleSide }),
    );
    const terrain = this.buildTerrain();
    this.terrainVertices = terrain.geometry.getAttribute("position").count;
    this.buildAvatar();
    const hemi = new THREE.HemisphereLight(0xeaf3ff, 0x40503a, 1.1);
    const sun = new THREE.DirectionalLight(0xfff2dc, 2.1);
    sun.position.set(120, 200, 80);
    this.group.add(terrain, this.cells, this.markers, this.avatar, this.compass(), hemi, sun);
    this.group.add(this.buildContours(terrain), this.buildReliefLabels(), this.buildCover());
    stage.scene.add(this.group);
    stage.camera.position.set(0, 55, 78);
    stage.controls.target.set(0, 0, 0);
    this.activate();
    stage.controls.update();
    this.refresh();
  }

  // ------------------------------------------------------------ public API

  /** Glide the camera to a place. */
  focus(placeId: string): boolean {
    const p = this.disposed ? null : this.world.place(placeId);
    if (!p) return false;
    const prev = this.focusId ? this.heads.get(this.focusId) : undefined;
    prev?.scale.setScalar(1);
    this.focusId = placeId;
    this.glide = { from: this.stage.controls.target.clone(), to: this.toScene(p.pos), t: 0 };
    return true;
  }

  /** Move the avatar marker to a place and focus it. */
  setAvatar(placeId: string): boolean {
    const p = this.disposed ? null : this.world.place(placeId);
    if (!p) return false;
    this.avatarId = placeId;
    this.placeAvatar(p);
    return this.focus(placeId);
  }

  /** Rebuild markers and territories from the world (call after every action). */
  refresh(): void {
    if (this.disposed) return;
    const now = Date.now();
    disposeTree(this.markers);
    this.markers.clear();
    disposeTree(this.cells);
    this.cells.clear();
    this.heads.clear();
    const pillar = new THREE.CylinderGeometry(0.2, 0.32, PILLAR_H, 8).translate(0, PILLAR_H / 2, 0);
    const ball = new THREE.SphereGeometry(1, 18, 12);
    const mats = new Map<string, THREE.Material>();
    const mat = (key: string, make: () => THREE.Material) => {
      let m = mats.get(key);
      if (!m) {
        m = make();
        mats.set(key, m);
      }
      return m;
    };
    let places = 0, discovered = 0;
    for (const p of this.world.places()) {
      if (p.ownerId !== null && p.ownerId !== this.profileId) continue; // never draw other players' homes
      if (!this.inMap(p.pos)) continue;
      places++;
      const known = p.discoveredBy.includes(this.profileId);
      if (known) discovered++;
      const color = PLACE_COLORS[p.kind];
      const base = this.toScene(p.pos);
      const marker = new THREE.Group();
      marker.position.copy(base);
      const stem = new THREE.Mesh(pillar, mat(`stem-${p.kind}`, () => new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.15 })));
      const head = new THREE.Mesh(
        ball,
        mat(`head-${p.kind}-${known}`, () =>
          new THREE.MeshStandardMaterial({
            color,
            emissive: color,
            emissiveIntensity: known ? 0.85 : 0.2,
            roughness: 0.3,
            transparent: !known,
            opacity: known ? 1 : 0.55,
          })),
      );
      head.position.y = PILLAR_H + 0.9;
      if (p.id === this.focusId) head.scale.setScalar(1.3);
      this.heads.set(p.id, head);
      const label = textSprite(p.name, known ? "#ffffff" : "#aab4c3");
      label.material.sizeAttenuation = false;
      label.material.needsUpdate = true;
      label.scale.multiplyScalar(LABEL_H / 0.6);
      label.position.y = PILLAR_H + 2.6;
      marker.add(stem, head, label);
      this.markers.add(marker, this.footprint(p, color, base));
    }
    let territories = 0, own = 0;
    const side = (this.world.cellSize * 0.92) / MAP_UNIT_M;
    for (const raw of this.world.toJSON().territories) {
      const t = this.world.territory(raw.cellId, now);
      if (t.ownerId === null) continue;
      const c = this.world.cellCenter(t.cellId);
      if (!this.inMap(c)) continue;
      territories++;
      if (t.ownerId === this.profileId) own++;
      const color = ownerColor(t.ownerId, this.profileId, this.dark);
      const base = this.toScene(c);
      const geo = new THREE.PlaneGeometry(side, side, 4, 4).rotateX(-Math.PI / 2);
      this.drape(geo, base.x, base.z, 0.3);
      const tile = new THREE.Mesh(
        geo,
        new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: 0.2 + 0.4 * clampN(t.defense / 400, 0, 1),
          depthWrite: false,
          side: THREE.DoubleSide,
          polygonOffset: true,
          polygonOffsetFactor: -3,
          polygonOffsetUnits: -3,
        }),
      );
      tile.position.set(base.x, 0, base.z);
      const edge = new THREE.LineLoop(this.outline(side / 2, base.x, base.z, 0.36), new THREE.LineBasicMaterial({ color }));
      edge.position.set(base.x, 0, base.z);
      this.cells.add(tile, edge);
    }
    const at = this.avatarId ? this.world.place(this.avatarId) : null;
    if (at) this.placeAvatar(at);
    this.counts = { places, discovered, territories, own };
  }

  /** Follow a theme switch without rebuilding the terrain. */
  setTheme(dark: boolean): void {
    if (dark === this.dark || this.disposed) return;
    this.dark = dark;
    this.bg.setHex(dark ? BG.dark : BG.light);
    this.fog.color.copy(this.bg);
    const accent = this.accent();
    this.avatarMat.color.setHex(accent);
    this.avatarMat.emissive.setHex(accent);
    this.beamMat.color.setHex(accent);
    this.pulse.material.color.setHex(accent);
    for (const m of this.contourMats) m.color.setHex(dark ? 0xe8f1ff : 0x1b2a3a);
    this.refresh();
  }

  update(): void {
    if (this.disposed) return;
    const now = performance.now() / 1000;
    const dt = this.lastT ? Math.min(0.1, now - this.lastT) : 0;
    this.lastT = now;
    // The previous view is disposed AFTER this one is built and may have cleared the scene.
    if (!this.activated) {
      this.activate();
      this.activated = true;
    }
    this.pin.position.y = PIN_Y + 0.45 * Math.sin(now * 2.2);
    this.pin.rotation.y += dt * 1.1;
    const k = (now * 0.55) % 1;
    this.pulse.scale.setScalar(1 + 1.6 * k);
    this.pulse.material.opacity = 0.65 * (1 - k);
    const c = this.stage.controls, cam = this.stage.camera;
    if (this.glide) {
      const g = this.glide;
      g.t = Math.min(1, g.t + dt / 0.8);
      const e = g.t * g.t * (3 - 2 * g.t);
      const delta = this.tmp.copy(g.from).lerp(g.to, e).sub(c.target);
      c.target.add(delta);
      cam.position.add(delta);
      if (g.t >= 1) this.glide = null;
    }
    const head = this.focusId ? this.heads.get(this.focusId) : undefined;
    if (head) head.scale.setScalar(1.3 + 0.18 * Math.sin(now * 4));
    this.clampCamera();
  }

  snapshot(): Record<string, unknown> {
    return {
      view: "world",
      places: this.counts.places,
      discovered: this.counts.discovered,
      territories: this.counts.territories,
      ownTerritories: this.counts.own,
      avatar: this.avatarId,
      focus: this.focusId,
      centre: this.world.toGeo(this.centre),
      metresPerUnit: MAP_UNIT_M,
      heightExaggeration: MAP_HEIGHT_X,
      mapSizeM: MAP_SIZE_M,
      terrainVertices: this.terrainVertices,
      contourIntervalM: CONTOUR_M,
      ...this.relief,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    disposeTree(this.group);
    this.group.removeFromParent();
    this.heads.clear();
    this.glide = null;
    // The next view was built before this dispose: only undo what is still ours.
    const scene = this.stage.scene;
    if (scene.background === this.bg) scene.background = null;
    if (scene.fog === this.fog) scene.fog = null;
  }

  // ------------------------------------------------------------ building

  private accent(): number {
    return this.dark ? ACCENT.dark : ACCENT.light;
  }

  private activate(): void {
    this.stage.scene.background = this.bg;
    this.stage.scene.fog = this.fog;
    this.stage.controls.enabled = true;
  }

  private sceneHeight(sx: number, sz: number): number {
    const h = this.world.heightAt(this.centre.x + sx * MAP_UNIT_M, this.centre.z - sz * MAP_UNIT_M);
    return ((h - this.centreAlt) * MAP_HEIGHT_X) / MAP_UNIT_M;
  }

  /** Local ENU metres -> scene units on the exaggerated terrain surface. */
  private toScene(p: V3, lift = 0): THREE.Vector3 {
    const sx = (p.x - this.centre.x) / MAP_UNIT_M, sz = -(p.z - this.centre.z) / MAP_UNIT_M;
    return new THREE.Vector3(sx, this.sceneHeight(sx, sz) + lift, sz);
  }

  private inMap(p: V3): boolean {
    return Math.abs(p.x - this.centre.x) <= this.half && Math.abs(p.z - this.centre.z) <= this.half;
  }

  private buildTerrain(): THREE.Mesh {
    const side = MAP_SIZE_M / MAP_UNIT_M;
    const geo = new THREE.PlaneGeometry(side, side, SEGMENTS, SEGMENTS).rotateX(-Math.PI / 2);
    const pos = geo.getAttribute("position") as THREE.BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const wx = this.centre.x + pos.getX(i) * MAP_UNIT_M, wz = this.centre.z - pos.getZ(i) * MAP_UNIT_M;
      const h = this.world.heightAt(wx, wz);
      pos.setY(i, ((h - this.centreAlt) * MAP_HEIGHT_X) / MAP_UNIT_M);
      c.setHex(GROUNDS[this.world.groundAt({ x: wx, y: h, z: wz })].color);
      // Altitude shading + alternating 10 m bands: the relief reads even from straight above.
      const band = (((Math.floor(h / CONTOUR_M) % 2) + 2) % 2) * 0.05;
      const shade = (0.8 + 0.4 * clampN((h + 70) / 140, 0, 1)) * (1 + band);
      colors[i * 3] = c.r * shade;
      colors[i * 3 + 1] = c.g * shade;
      colors[i * 3 + 2] = c.b * shade;
    }
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 }));
    mesh.name = "world-terrain";
    return mesh;
  }

  /** Iso-altitude lines every CONTOUR_M (marching squares over the terrain grid), bold every 5th. */
  private buildContours(terrain: THREE.Mesh): THREE.Group {
    const out = new THREE.Group();
    out.name = "world-contours";
    const pos = terrain.geometry.getAttribute("position") as THREE.BufferAttribute;
    const n = SEGMENTS + 1;
    // Scene y -> metres (inverse of buildTerrain's mapping).
    const toM = (y: number) => (y * MAP_UNIT_M) / MAP_HEIGHT_X + this.centreAlt;
    const H = new Float32Array(n * n);
    for (let k = 0; k < n * n; k++) H[k] = toM(pos.getY(k));
    let lo = Infinity, hi = -Infinity;
    for (const v of H) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    const minor: number[] = [], major: number[] = [];
    const lift = 0.12;
    for (let lv = Math.ceil(lo / CONTOUR_M) * CONTOUR_M; lv <= hi; lv += CONTOUR_M) {
      const dst = Math.round(lv / CONTOUR_M) % CONTOUR_MAJOR === 0 ? major : minor;
      const y = ((lv - this.centreAlt) * MAP_HEIGHT_X) / MAP_UNIT_M + lift;
      for (let j = 0; j < n - 1; j++) {
        for (let i = 0; i < n - 1; i++) {
          const ks = [j * n + i, j * n + i + 1, (j + 1) * n + i + 1, (j + 1) * n + i];
          const hits: number[] = [];
          for (let e = 0; e < 4; e++) {
            const a = ks[e], b = ks[(e + 1) % 4];
            if ((H[a] < lv) === (H[b] < lv)) continue;
            const t = (lv - H[a]) / (H[b] - H[a]);
            hits.push(pos.getX(a) + (pos.getX(b) - pos.getX(a)) * t, y, pos.getZ(a) + (pos.getZ(b) - pos.getZ(a)) * t);
          }
          for (let s = 0; s + 5 < hits.length; s += 6) dst.push(...hits.slice(s, s + 6));
        }
      }
    }
    const ink = this.dark ? 0xe8f1ff : 0x1b2a3a;
    for (const [arr, opacity] of [[minor, 0.18], [major, 0.42]] as const) {
      if (!arr.length) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(arr, 3));
      const mat = new THREE.LineBasicMaterial({ color: ink, transparent: true, opacity, depthWrite: false });
      this.contourMats.push(mat);
      out.add(new THREE.LineSegments(g, mat));
    }
    this.relief.contourSegments = (minor.length + major.length) / 6;
    return out;
  }

  /** ▲ peak and ▼ hollow labels with their altitude (constant screen size, like the place names). */
  private buildReliefLabels(): THREE.Group {
    const out = new THREE.Group();
    out.name = "world-relief-labels";
    const marks = this.world.reliefMarks(this.centre, this.half * 0.92, 5);
    for (const [list, glyph, color] of [[marks.peaks, "▲", "#ffd166"], [marks.lows, "▼", "#8ecae6"]] as const) {
      for (const p of list) {
        const label = textSprite(`${glyph} ${Math.round(p.y)} m`, color, 24);
        label.material.sizeAttenuation = false;
        label.material.needsUpdate = true;
        label.scale.multiplyScalar((LABEL_H * 0.8) / 0.6);
        label.position.copy(this.toScene(p, 1.6));
        out.add(label);
      }
    }
    this.relief.labels = marks.peaks.length + marks.lows.length;
    return out;
  }

  /** Instanced trees / rocks / scrub from WorldMap.coverAt on a jittered lattice (deterministic per world). */
  private buildCover(): THREE.Group {
    const out = new THREE.Group();
    out.name = "world-cover";
    const rng = new Rng(hashSeed(this.world.seed, "map-cover"));
    const N = Math.floor(MAP_SIZE_M / COVER_STEP_M);
    type Kind = keyof typeof COVER_CAP;
    const pts: Record<Kind, { x: number; y: number; z: number; s: number; r: number }[]> = { trees: [], rocks: [], scrub: [] };
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const jx = rng.range(-0.45, 0.45), jz = rng.range(-0.45, 0.45), s = rng.range(0.7, 1.35), r = rng.range(0, Math.PI * 2);
        const wx = this.centre.x - this.half + (i + 0.5 + jx) * COVER_STEP_M, wz = this.centre.z - this.half + (j + 0.5 + jz) * COVER_STEP_M;
        const c = this.world.coverAt(wx, wz);
        if (!c || pts[c].length >= COVER_CAP[c]) continue;
        const p = this.toScene({ x: wx, y: 0, z: wz });
        pts[c].push({ x: p.x, y: p.y, z: p.z, s, r });
      }
    }
    const geo: Record<Kind, THREE.BufferGeometry> = {
      trees: new THREE.ConeGeometry(0.34, 1.15, 6).translate(0, 0.55, 0),
      rocks: new THREE.DodecahedronGeometry(0.32, 0).translate(0, 0.12, 0),
      scrub: new THREE.IcosahedronGeometry(0.26, 0).translate(0, 0.14, 0),
    };
    const col: Record<Kind, number> = { trees: 0x2d6a4f, rocks: 0x8a8580, scrub: 0x7a9a46 };
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), v = new THREE.Vector3(), sc = new THREE.Vector3();
    for (const k of Object.keys(pts) as Kind[]) {
      const list = pts[k];
      this.relief[k] = list.length;
      if (!list.length) {
        geo[k].dispose();
        continue;
      }
      const im = new THREE.InstancedMesh(geo[k], new THREE.MeshStandardMaterial({ color: col[k], roughness: 0.9, flatShading: true }), list.length);
      list.forEach((p, i) => im.setMatrixAt(i, m.compose(v.set(p.x, p.y, p.z), q.setFromAxisAngle(up, p.r), sc.set(p.s, p.s * (k === "trees" ? 1.1 : 0.8), p.s))));
      im.instanceMatrix.needsUpdate = true;
      im.computeBoundingSphere();
      im.name = `world-cover-${k}`;
      out.add(im);
    }
    return out;
  }

  /** Lay a flat geometry (local x/z offsets around ox, oz) on the terrain surface + lift. */
  private drape(geo: THREE.BufferGeometry, ox: number, oz: number, lift: number): void {
    const pos = geo.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) pos.setY(i, this.sceneHeight(ox + pos.getX(i), oz + pos.getZ(i)) + lift);
    pos.needsUpdate = true;
    geo.computeBoundingSphere();
  }

  private outline(half: number, ox: number, oz: number, lift: number): THREE.BufferGeometry {
    const corners: [number, number][] = [[-half, -half], [half, -half], [half, half], [-half, half]];
    const pts: THREE.Vector3[] = [];
    for (let k = 0; k < 4; k++) {
      const [ax, az] = corners[k], [bx, bz] = corners[(k + 1) % 4];
      for (let i = 0; i < 4; i++) {
        const x = ax + ((bx - ax) * i) / 4, z = az + ((bz - az) * i) / 4;
        pts.push(new THREE.Vector3(x, this.sceneHeight(ox + x, oz + z) + lift, z));
      }
    }
    return new THREE.BufferGeometry().setFromPoints(pts);
  }

  /** The place's disc (its radius) as a ring draped on the ground. */
  private footprint(p: Place, color: number, base: THREE.Vector3): THREE.Mesh {
    const r = p.radius / MAP_UNIT_M;
    const w = clampN(r * 0.12, 0.18, 0.6);
    const geo = new THREE.RingGeometry(Math.max(0.05, r - w), r, 48, 1).rotateX(-Math.PI / 2);
    this.drape(geo, base.x, base.z, 0.18);
    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    );
    mesh.position.set(base.x, 0, base.z);
    return mesh;
  }

  private buildAvatar(): void {
    const tip = new THREE.Mesh(new THREE.ConeGeometry(1, 2.6, 20).rotateX(Math.PI).translate(0, 1.3, 0), this.avatarMat);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.95, 20, 14), this.avatarMat);
    head.position.y = 3.2;
    this.pin.add(tip, head);
    this.pin.position.y = PIN_Y;
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, PIN_Y, 6).translate(0, PIN_Y / 2, 0), this.beamMat);
    this.pulse.position.y = 0.4;
    this.avatar.add(this.pin, beam, this.pulse);
    this.avatar.visible = false;
  }

  private placeAvatar(p: Place): void {
    this.avatar.position.copy(this.toScene(p.pos));
    this.avatar.visible = true;
  }

  private compass(): THREE.Sprite {
    const n = textSprite("N", "#ffd166");
    n.material.sizeAttenuation = false;
    n.material.needsUpdate = true;
    n.scale.multiplyScalar((LABEL_H * 1.3) / 0.6);
    const edge = this.half / MAP_UNIT_M;
    n.position.set(0, this.sceneHeight(0, -edge) + 12, -edge);
    return n;
  }

  /** Keep the orbit above the ground, inside a sane zoom range and over the map (only while active). */
  private clampCamera(): void {
    const c = this.stage.controls, cam = this.stage.camera;
    const lim = this.half / MAP_UNIT_M + 10;
    const tx = clampN(c.target.x, -lim, lim), ty = clampN(c.target.y, -40, 40), tz = clampN(c.target.z, -lim, lim);
    if (tx !== c.target.x || ty !== c.target.y || tz !== c.target.z) {
      const d = this.tmp.set(tx - c.target.x, ty - c.target.y, tz - c.target.z);
      c.target.add(d);
      cam.position.add(d);
    }
    const off = this.tmp.copy(cam.position).sub(c.target);
    const d = off.length();
    if (d < 1e-6) return;
    const len = clampN(d, MIN_DIST, MAX_DIST);
    const minY = len * Math.cos(MAX_POLAR);
    if (len === d && off.y >= minY) return;
    off.setLength(len);
    if (off.y < minY) {
      const flat = Math.hypot(off.x, off.z) || 1;
      const horiz = Math.sqrt(Math.max(0, len * len - minY * minY));
      off.set((off.x / flat) * horiz, minY, (off.z / flat) * horiz);
    }
    cam.position.copy(c.target).add(off);
    cam.lookAt(c.target);
  }
}
