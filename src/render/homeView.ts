/**
 * HomeView [P5-H1]: the main-menu stage. A round stone-and-glass PLATFORM engraved with GRADUATIONS
 * (concentric metre rings, a tick ruler along one radius, ring labels) and a vertical MEASURING POLE
 * with labelled height ticks every 0.25 m, so the true SIZE of each Genemon reads at a glance. The 2-6
 * team Genemon stand on it at true scale, idle-animated, and behave like friends: they turn to look at
 * each other, walk short paths, pair up to PLAY (approach, bump, hop), sleep when their circadian rhythm
 * says so, and the selected one is ringed, looks at the camera and gets a height line to the pole.
 * Click a creature -> `source.onPick(id)`.
 *
 * Render-only randomness (Math.random) drives the idle behaviour; it never feeds the simulation.
 * Creatures are built exactly like the Lab's (skeleton -> helix -> CreatureView + Animator), at quality
 * "low" when more than 3 share the platform. The pure layout helpers at the top are tested in
 * tests/home_dex_test.ts.
 */
import { P5_DEFAULTS } from "../genome/morphTypes.ts";
import { lifePhase } from "../genome/lifeclock.ts";
import * as THREE from "../lib/three.ts";
import { buildSkeleton } from "../body/skeleton.ts";
import { type Genemon, phenotypeOf } from "../genome/genemon.ts";
import type { Phenotype } from "../genome/phenotype.ts";
import { helixOf } from "../genome/helix.ts";
import { hashSeed } from "../core/rng.ts";
import { Animator } from "./animator.ts";
import { CreatureView } from "./creature.ts";
import type { Stage, View } from "./stage.ts";

// ---------------------------------------------------------------- pure layout helpers
export const POLE_STEP = 0.25;

/** "0.25 m", "1 m", "1.5 m". */
export function fmtM(m: number): string {
  return `${Number(m.toFixed(2))} m`;
}

/** Spacing of the concentric rings for a platform radius (m). */
export function ringStep(radius: number): number {
  return radius <= 2.2 ? 0.25 : radius <= 5 ? 0.5 : 1;
}

export interface Footprint {
  /** Ground radius of the body (m). */
  radius: number;
  /** Height (m). */
  height: number;
}

/** Radius of the circle the creatures stand on (their diameters + gaps laid around it). */
export function standRadius(fp: readonly Footprint[]): number {
  const arc = fp.reduce((s, f) => s + 2 * f.radius * 1.35, 0);
  return Math.max(0.6, arc / (2 * Math.PI));
}

/** Platform radius: room for the stand circle, the biggest body, the walks and the pole; 2 .. 14 m. */
export function platformRadius(fp: readonly Footprint[]): number {
  if (!fp.length) return 2.5;
  const maxR = Math.max(...fp.map((f) => f.radius)), maxH = Math.max(...fp.map((f) => f.height));
  const r = Math.max(2, standRadius(fp) + maxR * 1.7 + 0.5, maxH * 1.15 + 0.8);
  return Math.min(14, Math.ceil(r / 0.5) * 0.5);
}

/** Start spots on the stand circle (front half first), facing between the centre and the camera (+z). */
export function placeAround(fp: readonly Footprint[]): { x: number; z: number; yaw: number }[] {
  const rp = standRadius(fp);
  const total = fp.reduce((s, f) => s + 2 * f.radius * 1.35, 0);
  const span = Math.min(2 * Math.PI, total / rp);
  let a = -span / 2;
  return fp.map((f) => {
    const w = (2 * f.radius * 1.35) / rp;
    const th = fp.length === 1 ? 0 : a + w / 2;
    a += w;
    const x = fp.length === 1 ? 0 : rp * Math.sin(th), z = fp.length === 1 ? 0 : rp * Math.cos(th);
    const toCentre = Math.atan2(-x, -z);
    return { x, z, yaw: fp.length === 1 ? 0 : lerpAngle(toCentre, 0, 0.55) };
  });
}

/** Measuring-pole ticks every 0.25 m up to just above the tallest; labels thinned on tall poles. */
export function poleTicks(maxH: number): { y: number; major: boolean; label: string | null }[] {
  const top = Math.max(1, Math.ceil((maxH * 1.15) / POLE_STEP) * POLE_STEP);
  const every = top <= 3 ? 0.25 : top <= 6 ? 0.5 : 1;
  const out: { y: number; major: boolean; label: string | null }[] = [];
  for (let i = 1; i * POLE_STEP <= top + 1e-9; i++) {
    const y = i * POLE_STEP;
    const lab = Math.abs(y / every - Math.round(y / every)) < 1e-6;
    out.push({ y, major: Math.abs(y - Math.round(y)) < 1e-9, label: lab ? fmtM(y) : null });
  }
  return out;
}

/** Ruler ticks along one radius: 0.1 m steps (0.25 m on big platforms); size 2 on rings, 1 on halves. */
export function rulerTicks(radius: number): { r: number; size: 0 | 1 | 2 }[] {
  const step = radius <= 6 ? 0.1 : 0.25, ring = ringStep(radius);
  const out: { r: number; size: 0 | 1 | 2 }[] = [];
  for (let i = 1; i * step <= radius + 1e-9; i++) {
    const r = Number((i * step).toFixed(3));
    const on = (q: number) => Math.abs(r / q - Math.round(r / q)) < 1e-6;
    out.push({ r, size: on(ring) ? 2 : on(0.5) ? 1 : 0 });
  }
  return out;
}

export function wrapAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

export function lerpAngle(a: number, b: number, k: number): number {
  return a + wrapAngle(b - a) * k;
}

// ---------------------------------------------------------------- the view
export interface HomeSource {
  team(): Genemon[];
  selected(): string | null;
  /** Circadian sleep (the life loop's last report); absent = always awake. */
  asleep?(g: Genemon): boolean;
  onPick?(id: string): void;
}

export interface HomeViewOptions {
  dark: boolean;
  shadows: boolean;
  /** Quality when 1-3 creatures share the platform (more = "low"). */
  quality: "high" | "low";
}

type ActState = "idle" | "walk" | "play" | "sleep";
type PlayStep = "approach" | "bump" | "hop";

interface Actor {
  g: Genemon;
  ph: Phenotype;
  cv: CreatureView;
  /** Placement group: its origin is the body's ground CENTRE (a skeleton root sits at one end). */
  body: THREE.Group;
  anim: Animator;
  radius: number;
  /** Half width (x) and half length (z) of the body at rest: the floor ring is this ellipse. */
  halfW: number;
  halfL: number;
  height: number;
  speed: number;
  /** Current ground speed (drives the gait). */
  v: number;
  x: number;
  z: number;
  yaw: number;
  state: ActState;
  timer: number;
  tx: number;
  tz: number;
  look: Actor | "camera" | null;
  partner: Actor | null;
  step: PlayStep;
  stepT: number;
  hop: number;
  lunge: number;
  hitDone: boolean;
  label: THREE.Sprite;
  zz: THREE.Sprite;
  ring: THREE.Mesh;
  tris: number;
}

const ACCENT = 0xffd166;

export class HomeView implements View {
  private group = new THREE.Group();
  private platform = new THREE.Group();
  private actors: Actor[] = [];
  private mats: THREE.Material[] = [];
  private bg: THREE.Color;
  private fog: THREE.Fog;
  private key: THREE.DirectionalLight;
  private radius = 2.5;
  private poleTop = 1;
  private poleR = 0.02;
  private pole = new THREE.Vector3();
  private heightLine: THREE.Line;
  private heightMark: THREE.Mesh;
  private heightLabel: THREE.Sprite | null = null;
  private heightLabelFor = "";
  private sig = "";
  private sigT = 0;
  private occT = 0;
  private quality: "high" | "low" = "high";
  private ray = new THREE.Raycaster();
  private down: { x: number; y: number } | null = null;
  private t = 0;
  private builtAt = 0;
  private onDown = (e: PointerEvent) => (this.down = { x: e.clientX, y: e.clientY });
  private onUp = (e: PointerEvent) => {
    const d = this.down;
    this.down = null;
    if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6) return;
    const id = this.pickAt(e.clientX, e.clientY);
    if (id) this.source.onPick?.(id);
  };

  constructor(private stage: Stage, private source: HomeSource, private o: HomeViewOptions) {
    const s = stage.scene;
    this.bg = new THREE.Color(o.dark ? 0x121c2c : 0xe6ecf3);
    this.fog = new THREE.Fog(this.bg.getHex(), 30, 90);
    s.background = this.bg;
    s.fog = this.fog;
    const hemi = new THREE.HemisphereLight(0xffffff, o.dark ? 0x34425e : 0x9aa7b8, o.dark ? 1.35 : 1.2);
    this.key = new THREE.DirectionalLight(0xffffff, 2.8);
    this.key.castShadow = o.shadows;
    this.key.shadow.mapSize.set(2048, 2048);
    this.key.shadow.bias = -0.0005;
    const rim = new THREE.DirectionalLight(0x88b4ff, 1.1);
    rim.position.set(-8, 6, -9);
    this.group.add(hemi, this.key, this.key.target, rim, this.platform);
    this.heightLine = new THREE.Line(new THREE.BufferGeometry(), this.mat(new THREE.LineDashedMaterial({ color: ACCENT, dashSize: 0.08, gapSize: 0.05, transparent: true, opacity: 0.9 })));
    this.heightMark = new THREE.Mesh(new THREE.TorusGeometry(1, 0.18, 6, 24).rotateX(Math.PI / 2), this.mat(new THREE.MeshBasicMaterial({ color: ACCENT })));
    this.group.add(this.heightLine, this.heightMark);
    s.add(this.group);
    stage.controls.enabled = true;
    stage.canvas.addEventListener("pointerdown", this.onDown);
    stage.canvas.addEventListener("pointerup", this.onUp);
    this.rebuild();
  }

  private mat<T extends THREE.Material>(m: T): T {
    this.mats.push(m);
    return m;
  }

  private teamSig(team: Genemon[]): string {
    // Rebuild on team changes and on visible growth (5 % height steps), not on every life tick.
    return team.map((g) => {
      const ph = phenotypeOf(g);
      return `${g.id}:${ph.kind}:${Math.round(Math.log(Math.max(0.05, ph.heightM)) / Math.log(1.05))}`;
    }).join("|");
  }

  // ---------------------------------------------------------------- build
  private rebuild(): void {
    const team = this.source.team().slice(0, 6);
    this.sig = this.teamSig(team);
    this.clearActors();
    this.clearPlatform();
    this.quality = team.length > 3 ? "low" : this.o.quality;
    const built = team.map((g) => this.buildActor(g));
    const fp = built.map((a) => ({ radius: a.radius, height: a.height }));
    this.radius = platformRadius(fp);
    const maxH = fp.length ? Math.max(...fp.map((f) => f.height)) : 1;
    this.buildPlatform(this.radius, maxH);
    placeAround(fp).forEach((p, i) => {
      const a = built[i];
      a.x = p.x;
      a.z = p.z;
      a.yaw = p.yaw;
      a.timer = 0.5 + Math.random() * 2;
    });
    this.actors = built;
    for (const a of built) this.group.add(a.body, a.label, a.zz, a.ring);
    this.frameCamera(maxH);
    this.builtAt = this.t;
  }

  private buildActor(g: Genemon): Actor {
    const ph = phenotypeOf(g);
    const helix = helixOf(g.genome, ph);
    const sk = buildSkeleton(ph, helix.p5 ?? P5_DEFAULTS);
    const cv = new CreatureView(ph, sk, hashSeed(g.genome.id, "skin"), { quality: this.quality, shadows: this.o.shadows, helix, life: { scars: g.life?.scars ?? [], phase: lifePhase(g) } });
    const anim = new Animator(sk, ph, helix);
    cv.root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(cv.root);
    const size = box.getSize(new THREE.Vector3());
    // The skeleton root is at one end of a long body: re-centre it so that (x, z), the turns, the
    // footprint ring, the label and the separation all refer to the middle of the body.
    const body = new THREE.Group();
    cv.root.position.set(-(box.min.x + box.max.x) / 2, 0, -(box.min.z + box.max.z) / 2);
    body.add(cv.root);
    // Ground footprint: the geometric mean of width and length (a long tail or wide wings must not
    // claim a whole circle of their span).
    const radius = Math.max(0.08, 0.45 * Math.sqrt(Math.max(0.01, size.x) * Math.max(0.01, size.z)));
    // What the pole measures is the MESH standing at rest (a serpent lies low, horns add height), not
    // the phenotype's nominal size class height: label, height line and pole all use the measured top.
    const height = Math.max(0.05, box.max.y);
    cv.root.userData.genemonId = g.id;
    const label = this.textSprite(`${g.name} · ${fmtM(Number(height.toFixed(2)))}`, { fg: "#ffffff", bg: "rgba(13,17,23,0.72)", onTop: true });
    const zz = this.textSprite("z Z", { fg: "#bfe6ff", bg: null });
    zz.visible = false;
    const ring = new THREE.Mesh(new THREE.RingGeometry(1, 1.12, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: ph.palette.base, transparent: true, opacity: 0.55, depthWrite: false }));
    ring.position.y = 0.006;
    ring.renderOrder = 2;
    return {
      g, ph, cv, body, anim, radius, height, halfW: Math.max(0.06, size.x / 2), halfL: Math.max(0.06, size.z / 2),
      speed: Math.min(1.4, Math.max(0.18, 0.55 * Math.sqrt(Math.max(0.1, ph.heightM)))),
      v: 0,
      x: 0, z: 0, yaw: 0, state: "idle", timer: 1, tx: 0, tz: 0, look: null, partner: null,
      step: "approach", stepT: 0, hop: 0, lunge: 0, hitDone: false, label, zz, ring, tris: cv.triangles(),
    };
  }

  /** A camera-facing text label (canvas texture; world height set by the caller via scale). */
  private textSprite(text: string, o: { fg: string; bg: string | null; bold?: boolean; onTop?: boolean }): THREE.Sprite {
    const c = document.createElement("canvas");
    const ctx = c.getContext("2d")!;
    const px = 66, H = 96;
    const font = `${o.bold === false ? "" : "700 "}${px}px system-ui, -apple-system, Segoe UI, sans-serif`;
    ctx.font = font;
    const w = Math.ceil(ctx.measureText(text).width) + 40;
    c.width = w;
    c.height = H;
    ctx.font = font;
    if (o.bg) {
      ctx.fillStyle = o.bg;
      const r = 22;
      ctx.beginPath();
      ctx.moveTo(r, 3);
      ctx.arcTo(w - 3, 3, w - 3, H - 3, r);
      ctx.arcTo(w - 3, H - 3, 3, H - 3, r);
      ctx.arcTo(3, H - 3, 3, 3, r);
      ctx.arcTo(3, 3, w - 3, 3, r);
      ctx.fill();
    }
    ctx.fillStyle = o.fg;
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    if (!o.bg) {
      ctx.lineWidth = 9;
      ctx.strokeStyle = this.o.dark ? "rgba(0,0,0,0.75)" : "rgba(255,255,255,0.85)";
      ctx.strokeText(text, w / 2, H / 2 + 2);
    }
    ctx.fillText(text, w / 2, H / 2 + 2);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: !o.onTop, fog: false }));
    sp.userData.aspect = w / H;
    sp.renderOrder = o.onTop ? 30 : 10;
    return sp;
  }

  private sizeSprite(sp: THREE.Sprite, h: number): void {
    sp.scale.set(h * (sp.userData.aspect as number), h, 1);
  }

  private buildPlatform(R: number, maxH: number): void {
    const P = this.platform, dark = this.o.dark;
    const thick = Math.min(0.45, Math.max(0.14, R * 0.05));
    // Stone drum + glass top + rim.
    const stone = new THREE.Mesh(new THREE.CylinderGeometry(R * 1.015, R * 1.06, thick, 96), (new THREE.MeshStandardMaterial({ color: dark ? 0x2a3242 : 0xb9c2ce, roughness: 0.85, metalness: 0.05 })));
    stone.position.y = -thick / 2 - 0.004;
    stone.receiveShadow = true;
    const glass = new THREE.Mesh(new THREE.CircleGeometry(R, 96).rotateX(-Math.PI / 2), (new THREE.MeshStandardMaterial({ color: dark ? 0x24344c : 0xdfe7f0, roughness: 0.25, metalness: 0.15, transparent: true, opacity: 0.94 })));
    glass.receiveShadow = true;
    const rim = new THREE.Mesh(new THREE.TorusGeometry(R * 1.015, Math.max(0.012, R * 0.006), 8, 128).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x4cc9f0 }));
    const floor = new THREE.Mesh(new THREE.CircleGeometry(R * 7, 64).rotateX(-Math.PI / 2), (new THREE.MeshStandardMaterial({ color: dark ? 0x0a0f18 : 0xd3dae4, roughness: 1 })));
    floor.position.y = -thick - 0.01;
    floor.receiveShadow = true;
    P.add(stone, glass, rim, floor);
    // Concentric graduation rings (major every metre, labelled).
    const step = ringStep(R), lineW = Math.max(0.006, R * 0.0028);
    const ringMat = (new THREE.MeshBasicMaterial({ color: dark ? 0x7fd6ff : 0x1d6fa5, transparent: true, opacity: 0.75, depthWrite: false }));
    const majorMat = (new THREE.MeshBasicMaterial({ color: dark ? 0xc8f0ff : 0x0b4c78, transparent: true, opacity: 0.95, depthWrite: false }));
    const dir = new THREE.Vector3(1, 0, 0.62).normalize();
    const labelH = Math.min(0.42, Math.max(0.085, R * 0.05));
    for (let r = step; r <= R + 1e-6; r += step) {
      const major = Math.abs(r - Math.round(r)) < 1e-6;
      const w = major ? lineW * 1.8 : lineW;
      const ring = new THREE.Mesh(new THREE.RingGeometry(r - w, r + w, Math.max(48, Math.round(r * 48))).rotateX(-Math.PI / 2), major ? majorMat : ringMat);
      ring.position.y = 0.003;
      ring.renderOrder = 1;
      P.add(ring);
      if (major || step >= 0.5 || Math.abs(r * 2 - Math.round(r * 2)) < 1e-6) {
        const lab = this.textSprite(fmtM(Number(r.toFixed(2))), { fg: dark ? "#c8f0ff" : "#0b4c78", bg: null });
        this.sizeSprite(lab, labelH * (major ? 1 : 0.8));
        lab.position.set(dir.x * r + dir.z * labelH * 0.9, labelH * 0.55, dir.z * r - dir.x * labelH * 0.9);
        P.add(lab);
      }
    }
    // The ruler: ticks across one radius (0.1 m minor, 0.5 m mid, ring major).
    const perp = new THREE.Vector3(-dir.z, 0, dir.x);
    const pos: number[] = [];
    const quad = (cx: number, cz: number, along: number, across: number) => {
      const ax = dir.x * along, az = dir.z * along, px = perp.x * across, pz = perp.z * across;
      const p = [[cx - ax - px, cz - az - pz], [cx + ax - px, cz + az - pz], [cx + ax + px, cz + az + pz], [cx - ax + px, cz - az + pz]];
      for (const k of [0, 2, 1, 0, 3, 2]) pos.push(p[k][0], 0.004, p[k][1]);
    };
    quad((dir.x * R) / 2, (dir.z * R) / 2, R / 2, lineW);
    for (const t of rulerTicks(R)) quad(dir.x * t.r, dir.z * t.r, lineW * (t.size === 2 ? 1.6 : 1), [R * 0.012, R * 0.022, R * 0.036][t.size]);
    const ruler = new THREE.Mesh(new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)), (new THREE.MeshBasicMaterial({ color: dark ? 0xffffff : 0x0b2a44, side: THREE.DoubleSide, transparent: true, opacity: 0.9, depthWrite: false })));
    ruler.renderOrder = 1;
    P.add(ruler);
    // The measuring pole (survey rod: alternating 0.25 m bands, ticks, labels) at the back left.
    const ticks = poleTicks(maxH);
    const top = ticks.length ? ticks[ticks.length - 1].y : 1;
    this.poleTop = top;
    const pr = Math.min(0.09, Math.max(0.014, top * 0.011, R * 0.006));
    this.poleR = pr;
    // Left side, a little behind the centre: in view, rarely occluded by the creatures.
    this.pole.set(-R * 0.8, 0, -R * 0.2);
    const rod = new THREE.Group();
    rod.position.copy(this.pole);
    const bandA = (new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.6 }));
    const bandB = (new THREE.MeshStandardMaterial({ color: 0xe0403a, roughness: 0.6 }));
    const bandGeo = new THREE.CylinderGeometry(pr, pr, POLE_STEP, 12);
    for (let i = 0; i * POLE_STEP < top - 1e-9; i++) {
      const b = new THREE.Mesh(bandGeo, i % 2 ? bandB : bandA);
      b.position.y = POLE_STEP * (i + 0.5);
      b.castShadow = this.o.shadows;
      rod.add(b);
    }
    const base = new THREE.Mesh(new THREE.CylinderGeometry(pr * 4, pr * 5, pr * 2, 24), (new THREE.MeshStandardMaterial({ color: 0x39424f, metalness: 0.4, roughness: 0.5 })));
    base.position.y = pr;
    rod.add(base);
    const tickMat = (new THREE.MeshBasicMaterial({ color: dark ? 0xffffff : 0x111820 }));
    const poleLabelH = this.poleLabelH(R, top);
    // Ticks stick out towards the creatures (+x, across the camera's view); labels sit on the outer side.
    for (const t of ticks) {
      const len = t.major ? pr * 9 : t.label ? pr * 6 : pr * 4;
      const tk = new THREE.Mesh(new THREE.BoxGeometry(len, Math.max(0.006, pr * 0.45), pr * 0.6), tickMat);
      tk.position.set(len * 0.5, t.y, 0);
      rod.add(tk);
      if (t.label) {
        const lab = this.textSprite(t.label, { fg: t.major ? "#ffd166" : dark ? "#ffffff" : "#111820", bg: null });
        this.sizeSprite(lab, poleLabelH * (t.major ? 1.15 : 0.9));
        lab.position.set(-(pr * 2.5 + lab.scale.x * 0.5), t.y, 0);
        rod.add(lab);
      }
    }
    P.add(rod);
    // Lights and shadow camera sized to the platform.
    this.key.position.set(R * 0.9, R * 1.6 + maxH * 1.5, R * 1.1);
    const sc = this.key.shadow.camera;
    sc.left = -R * 1.25;
    sc.right = R * 1.25;
    sc.top = R * 1.25;
    sc.bottom = -R * 1.25;
    sc.near = 0.1;
    sc.far = R * 6 + maxH * 4;
    sc.updateProjectionMatrix();
    this.heightMark.scale.setScalar(pr * 2.4);
  }

  /** Pole label height: readable from the framing distance (grows with the platform), 0.07 .. 0.5 m. */
  private poleLabelH(R: number, top: number): number {
    return Math.min(0.5, Math.max(0.07, top * 0.05, R * 0.04));
  }

  private frameCamera(maxH: number): void {
    const cam = this.stage.camera, R = this.radius;
    const vf = (cam.fov * Math.PI) / 180, hf = 2 * Math.atan(Math.tan(vf / 2) * Math.max(0.4, cam.aspect));
    const pitch = 0.5;
    const needW = (R * 2.15) / (2 * Math.tan(hf / 2));
    const needH = (Math.max(this.poleTop, maxH) * 1.1 + R * 0.9 * Math.sin(pitch)) / (2 * Math.tan(vf / 2));
    const d = Math.max(needW, needH, 1.5);
    const target = new THREE.Vector3(0, Math.min(maxH * 0.35, R * 0.35), 0);
    cam.position.set(target.x + d * 0.12, target.y + Math.sin(pitch) * d, target.z + Math.cos(pitch) * d);
    this.stage.controls.target.copy(target);
    this.stage.controls.update();
    this.fog.near = d * 1.6;
    this.fog.far = d * 4.5;
  }

  private clearActors(): void {
    for (const a of this.actors) {
      a.cv.dispose();
      a.body.removeFromParent();
      for (const x of [a.label, a.zz, a.ring]) {
        disposeObject(x);
        x.removeFromParent();
      }
    }
    this.actors = [];
  }

  private clearPlatform(): void {
    this.platform.traverse(disposeObject);
    this.platform.clear();
  }

  // ---------------------------------------------------------------- behaviour
  private awakeOthers(a: Actor): Actor[] {
    return this.actors.filter((b) => b !== a && b.state !== "sleep");
  }

  private nextAction(a: Actor): void {
    const free = this.awakeOthers(a).filter((b) => b.state === "idle" && !b.partner);
    const r = Math.random();
    if (free.length && r < 0.38) {
      const b = free[Math.floor(Math.random() * free.length)];
      this.startPlay(a, b);
      return;
    }
    if (r < 0.75) {
      // A short walk to a free spot inside the platform (not through the pole).
      const lim = Math.max(0.1, this.radius - a.radius - 0.15);
      for (let k = 0; k < 8; k++) {
        const ang = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * lim;
        const tx = Math.sin(ang) * d, tz = Math.cos(ang) * d;
        const step = Math.hypot(tx - a.x, tz - a.z);
        if (step > Math.max(0.6, a.height * 3) || this.poleLane(tx, tz, a.radius) !== null) continue;
        a.tx = tx;
        a.tz = tz;
        a.state = "walk";
        a.timer = 8;
        return;
      }
    }
    const others = this.awakeOthers(a);
    a.look = others.length && Math.random() < 0.75 ? others[Math.floor(Math.random() * others.length)] : "camera";
    a.state = "idle";
    a.timer = 2 + Math.random() * 3;
  }

  private startPlay(a: Actor, b: Actor): void {
    for (const [x, y] of [[a, b], [b, a]] as const) {
      x.state = "play";
      x.partner = y;
      x.look = y;
      x.step = "approach";
      x.stepT = 0;
      x.timer = 7;
      x.hitDone = false;
    }
  }

  private endPlay(a: Actor): void {
    const b = a.partner;
    for (const x of b ? [a, b] : [a]) {
      x.partner = null;
      x.state = x.state === "sleep" ? "sleep" : "idle";
      x.hop = 0;
      x.lunge = 0;
      x.look = x === a ? b : a;
      x.timer = 1.5 + Math.random() * 2.5;
    }
  }

  /** Turn towards a yaw at a body-size-aware rate; returns the remaining angle. */
  private turn(a: Actor, want: number, dt: number): number {
    const d = wrapAngle(want - a.yaw);
    const rate = 2.6 / Math.max(0.6, Math.sqrt(a.height));
    a.yaw += Math.max(-rate * dt, Math.min(rate * dt, d));
    return Math.abs(wrapAngle(want - a.yaw));
  }

  /** Move towards (tx, tz); true when arrived. Returns the speed actually used (for the gait). */
  private walkTo(a: Actor, tx: number, tz: number, dt: number, stopAt: number): { arrived: boolean; v: number } {
    const dx = tx - a.x, dz = tz - a.z, dist = Math.hypot(dx, dz);
    if (dist <= stopAt) return { arrived: true, v: 0 };
    const off = this.turn(a, Math.atan2(dx, dz), dt);
    const v = off < 0.7 ? a.speed * (1 - off / 0.9) : 0;
    const s = Math.min(dist - stopAt, v * dt);
    a.x += Math.sin(a.yaw) * s;
    a.z += Math.cos(a.yaw) * s;
    return { arrived: false, v };
  }

  private behave(a: Actor, dt: number): void {
    const asleep = this.source.asleep ? safeBool(() => this.source.asleep!(a.g)) : false;
    if (asleep && a.state !== "sleep") {
      if (a.partner) this.endPlay(a);
      a.state = "sleep";
    } else if (!asleep && a.state === "sleep") {
      a.state = "idle";
      a.timer = 1 + Math.random() * 2;
    }
    a.timer -= dt;
    a.v = 0;
    switch (a.state) {
      case "sleep":
        a.look = null;
        break;
      case "idle": {
        if (a.look && a.look !== "camera") {
          const want = Math.atan2(a.look.x - a.x, a.look.z - a.z);
          // Small turns are done by the head; the body follows when the friend is far to the side.
          if (Math.abs(wrapAngle(want - a.yaw)) > 1.0) this.turn(a, want, dt);
        } else if (a.look === "camera" || this.source.selected() === a.g.id) this.turn(a, Math.atan2(this.stage.camera.position.x - a.x, this.stage.camera.position.z - a.z), dt * 0.6);
        if (a.timer <= 0) this.nextAction(a);
        break;
      }
      case "walk": {
        const r = this.walkTo(a, a.tx, a.tz, dt, 0.05 + a.radius * 0.2);
        a.v = r.v;
        if (r.arrived || a.timer <= 0) {
          a.state = "idle";
          const others = this.awakeOthers(a);
          a.look = others.length ? others[Math.floor(Math.random() * others.length)] : "camera";
          a.timer = 1.5 + Math.random() * 3;
        }
        break;
      }
      case "play": {
        const b = a.partner;
        if (!b || b.partner !== a || b.state !== "play") {
          this.endPlay(a);
          break;
        }
        a.stepT += dt;
        const gap = (a.radius + b.radius) * 1.02;
        if (a.step === "approach") {
          const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2, d = Math.max(1e-3, Math.hypot(a.x - b.x, a.z - b.z));
          const tx = mx + ((a.x - b.x) / d) * gap * 0.5, tz = mz + ((a.z - b.z) / d) * gap * 0.5;
          const r = this.walkTo(a, tx, tz, dt, 0.04 + a.radius * 0.1);
          a.v = r.v;
          const close = d <= gap * 1.25;
          if ((close && b.step === "approach") || a.stepT > 6) {
            for (const x of [a, b]) {
              x.step = "bump";
              x.stepT = 0;
              x.hitDone = false;
            }
          }
        } else if (a.step === "bump") {
          this.turn(a, Math.atan2(b.x - a.x, b.z - a.z), dt * 2);
          const p = Math.min(1, a.stepT / 0.6);
          a.lunge = Math.sin(Math.PI * p) * Math.min(a.radius, b.radius) * 0.35;
          if (p > 0.5 && !a.hitDone) {
            a.hitDone = true;
            a.anim.hit(0.35, false);
          }
          if (p >= 1) {
            a.step = "hop";
            a.stepT = 0;
            a.lunge = 0;
          }
        } else {
          const p = Math.min(1, a.stepT / 1.4);
          a.hop = Math.abs(Math.sin(Math.PI * 2 * p)) * Math.min(0.6, Math.max(0.04, a.height * 0.2));
          if (p >= 1 && b.stepT / 1.4 >= 1) this.endPlay(a);
          else if (p >= 1) a.hop = 0;
        }
        if (a.timer <= -2) this.endPlay(a);
        break;
      }
    }
  }

  /**
   * The SIGHT LANE of the measuring pole: the strip between the pole and the camera. A creature standing
   * in it hides the graduations, so walks avoid it and bodies are pushed out of it. Returns the push
   * (x, z) that clears the lane, or null when the spot is clear.
   */
  private poleLane(x: number, z: number, r: number): { x: number; z: number } | null {
    const cam = this.stage.camera.position;
    let lx = cam.x - this.pole.x, lz = cam.z - this.pole.z;
    const ll = Math.hypot(lx, lz) || 1;
    lx /= ll;
    lz /= ll;
    const rx = x - this.pole.x, rz = z - this.pole.z;
    const t = rx * lx + rz * lz;
    const need = r + 0.25 + this.radius * 0.04;
    if (t < -need) return null;
    const px = rx - t * lx, pz = rz - t * lz, d = Math.hypot(px, pz);
    if (d >= need) return null;
    // Push sideways, towards the platform centre when standing on the lane's axis.
    let nx = px, nz = pz;
    if (d < 1e-3) {
      nx = lz;
      nz = -lx;
      if (nx * -this.pole.x + nz * -this.pole.z < 0) {
        nx = -nx;
        nz = -nz;
      }
    }
    const n = Math.hypot(nx, nz) || 1;
    return { x: (nx / n) * (need - d), z: (nz / n) * (need - d) };
  }

  /** Keep bodies apart, inside the platform, off the pole and out of its sight lane. */
  private separate(): void {
    const R = this.radius;
    for (let i = 0; i < this.actors.length; i++) {
      const a = this.actors[i];
      for (let j = i + 1; j < this.actors.length; j++) {
        const b = this.actors[j];
        const dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz) || 1e-3;
        const min = (a.radius + b.radius) * 0.95;
        if (d < min) {
          const push = (min - d) / 2, nx = dx / d, nz = dz / d;
          a.x -= nx * push;
          a.z -= nz * push;
          b.x += nx * push;
          b.z += nz * push;
        }
      }
      const lane = this.poleLane(a.x, a.z, a.radius);
      if (lane) {
        // Eased, so a body slides out of the lane instead of popping.
        a.x += lane.x * 0.25;
        a.z += lane.z * 0.25;
      }
      const cd = Math.hypot(a.x, a.z), lim = Math.max(0, R - a.radius - 0.04);
      if (cd > lim) {
        a.x *= lim / cd;
        a.z *= lim / cd;
      }
    }
  }

  // ---------------------------------------------------------------- frame
  update(dt: number, t: number): void {
    this.t = t;
    // A view is built BEFORE the previous one is disposed (Lab/Arena dispose clear background and
    // controls): re-assert ours every frame.
    if (this.stage.scene.background !== this.bg) this.stage.scene.background = this.bg;
    if (this.stage.scene.fog !== this.fog) this.stage.scene.fog = this.fog;
    if (!this.stage.controls.enabled) this.stage.controls.enabled = true;
    this.sigT += dt;
    if (this.sigT > 2) {
      this.sigT = 0;
      const sig = this.teamSig(this.source.team().slice(0, 6));
      if (sig !== this.sig && t - this.builtAt > 3) this.rebuild();
    }
    const sel = this.source.selected();
    const cam = this.stage.camera.position;
    const labelH = Math.min(0.55, Math.max(0.09, this.radius * 0.055));
    for (const a of this.actors) this.behave(a, dt);
    this.separate();
    let selActor: Actor | null = null;
    for (const a of this.actors) {
      const v = a.v;
      const asleep = a.state === "sleep";
      const isSel = sel === a.g.id;
      if (isSel) selActor = a;
      const fx = Math.sin(a.yaw), fz = Math.cos(a.yaw);
      a.body.position.set(a.x + fx * a.lunge, a.hop, a.z + fz * a.lunge);
      a.body.rotation.y = a.yaw;
      // Head: friend, camera (selected / chosen) or down (asleep).
      let lookYaw = 0, lookPitch = asleep ? 0.55 : 0.05;
      const tgt = a.look === "camera" || (isSel && a.state === "idle") ? { x: cam.x, y: cam.y, z: cam.z } : a.look ? { x: a.look.x, y: a.look.height * 0.6, z: a.look.z } : null;
      if (tgt && !asleep) {
        lookYaw = Math.max(-1.1, Math.min(1.1, wrapAngle(Math.atan2(tgt.x - a.x, tgt.z - a.z) - a.yaw)));
        lookPitch = Math.max(-0.6, Math.min(0.6, Math.atan2(a.height * 0.7 - tgt.y, Math.hypot(tgt.x - a.x, tgt.z - a.z))));
      }
      const em = a.ph.psyche.emotions;
      const playing = a.state === "play";
      const out = a.anim.update({
        dt,
        t: t + a.radius * 7.3,
        phase: playing && a.step === "bump" ? "active" : "idle",
        progress: playing && a.step === "bump" ? Math.min(1, a.stepT / 0.6) : 0,
        move: null,
        speed: v,
        maxSpeed: a.speed * 1.5,
        flying: false,
        burrowed: false,
        frozen: false,
        koT: 0,
        stagger: 0,
        emotions: asleep ? { ...em, joy: 0.2, anger: 0, fear: 0, energy: 0.05 } : playing ? { ...em, joy: Math.max(em.joy, 0.85), energy: Math.max(em.energy, 0.8) } : em,
        energy01: asleep ? 0.15 : 1,
        hp01: 1,
        lookYaw,
        lookPitch,
        normal: { x: 0, y: 1, z: 0 },
        liquid: false,
      });
      a.cv.applyPose(out.pose);
      const sink = asleep ? 0.9 : 1;
      a.cv.pivot.scale.set(out.squash[0], out.squash[1] * sink, out.squash[2]);
      a.cv.pivot.rotation.set(out.bodyPitch, 0, out.bodyRoll);
      a.cv.pivot.position.y = out.lift;
      a.cv.setPupils(em.fear * 0.5, 0);
      a.cv.tick(dt);
      // Labels, sleep z's, floor ring (selected = gold, pulsing).
      this.sizeSprite(a.label, labelH);
      a.label.position.set(a.x, a.hop + a.height * 1.08 + labelH * 0.8, a.z);
      (a.label.material as THREE.SpriteMaterial).color.setHex(isSel ? ACCENT : 0xffffff);
      a.zz.visible = asleep;
      if (asleep) {
        this.sizeSprite(a.zz, labelH * (0.9 + 0.15 * Math.sin(t * 2)));
        a.zz.position.set(a.x + a.radius * 0.4, a.height * 0.95 + labelH * (1.6 + 0.25 * Math.sin(t * 1.3)), a.z);
      }
      // The floor ring hugs the body (an ellipse turning with it), so it never circles a neighbour.
      const k = isSel ? 1.18 + 0.04 * Math.sin(t * 4) : 1.08;
      a.ring.scale.set(a.halfW * k, 1, a.halfL * k);
      a.ring.position.set(a.x, 0.006, a.z);
      a.ring.rotation.y = a.yaw;
      const rm = a.ring.material as THREE.MeshBasicMaterial;
      rm.color.setHex(isSel ? ACCENT : a.ph.palette.base);
      rm.opacity = isSel ? 0.95 : 0.45;
    }
    this.stackLabels();
    this.occT += dt;
    if (this.occT > 0.3) {
      this.occT = 0;
      this.dimHidden(sel);
    }
    this.updateHeightLine(selActor);
  }

  /**
   * Name tags draw on top of everything (always readable); the tag of a creature hidden behind another
   * one is dimmed so it does not read as the front creature's tag.
   */
  private dimHidden(sel: string | null): void {
    const cam = this.stage.camera.position;
    const p = new THREE.Vector3(), dir = new THREE.Vector3();
    for (const a of this.actors) {
      p.set(a.x, a.hop + a.height * 0.6, a.z);
      const dist = cam.distanceTo(p);
      dir.copy(p).sub(cam).normalize();
      this.ray.set(cam, dir);
      this.ray.far = dist;
      const hidden = this.ray.intersectObjects(this.actors.filter((b) => b !== a).map((b) => b.body), true).some((h) => h.distance < dist - a.radius);
      (a.label.material as THREE.SpriteMaterial).opacity = hidden && sel !== a.g.id ? 0.4 : 1;
    }
    this.ray.far = Infinity;
  }

  /**
   * Labels of creatures standing close in screen space would overlap: nearest to the camera keeps its
   * spot, the ones behind are raised one label height at a time until they clear.
   */
  private stackLabels(): void {
    const cam = this.stage.camera;
    const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
    const byDist = [...this.actors].sort((p, q) => cam.position.distanceToSquared(p.label.position) - cam.position.distanceToSquared(q.label.position));
    const placed: THREE.Sprite[] = [];
    for (const a of byDist) {
      const L = a.label;
      for (let guard = 0; guard < 8; guard++) {
        const hit = placed.find((B) => {
          const dx = Math.abs((L.position.x - B.position.x) * right.x + (L.position.z - B.position.z) * right.z);
          return dx < (L.scale.x + B.scale.x) * 0.5 && Math.abs(L.position.y - B.position.y) < (L.scale.y + B.scale.y) * 0.55;
        });
        if (!hit) break;
        L.position.y = hit.position.y + (L.scale.y + hit.scale.y) * 0.6;
      }
      placed.push(L);
    }
  }

  /** The selected Genemon's head height carried to the pole by a dashed line and a ring marker. */
  private updateHeightLine(a: Actor | null): void {
    this.heightLine.visible = this.heightMark.visible = !!a;
    if (this.heightLabel) this.heightLabel.visible = !!a;
    if (!a) return;
    const y = a.height;
    const pts = [new THREE.Vector3(a.x, y, a.z), new THREE.Vector3(this.pole.x, y, this.pole.z)];
    this.heightLine.geometry.dispose();
    this.heightLine.geometry = new THREE.BufferGeometry().setFromPoints(pts);
    this.heightLine.computeLineDistances();
    this.heightMark.position.set(this.pole.x, y, this.pole.z);
    if (this.heightLabelFor !== `${a.g.id}:${y.toFixed(2)}`) {
      if (this.heightLabel) {
        disposeObject(this.heightLabel);
        this.heightLabel.removeFromParent();
      }
      this.heightLabel = this.textSprite(fmtM(Number(y.toFixed(2))), { fg: "#111820", bg: "rgba(255,209,102,0.95)", onTop: true });
      this.heightLabelFor = `${a.g.id}:${y.toFixed(2)}`;
      this.group.add(this.heightLabel);
    }
    const h = this.poleLabelH(this.radius, this.poleTop) * 1.1;
    const lab = this.heightLabel!;
    this.sizeSprite(lab, h);
    lab.position.set(this.pole.x + this.poleR * 10 + lab.scale.x * 0.5, y + h * 0.65, this.pole.z);
  }

  private pickAt(clientX: number, clientY: number): string | null {
    const r = this.stage.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(ndc, this.stage.camera);
    const hits = this.ray.intersectObjects(this.actors.map((a) => a.body), true);
    for (const hit of hits) {
      let o: THREE.Object3D | null = hit.object;
      while (o && o.userData.genemonId === undefined) o = o.parent;
      if (o) return o.userData.genemonId as string;
    }
    // Generous fallback (tiny creatures are hard to hit): the creature whose vertical axis passes
    // closest to the ray, relative to its size.
    let best: Actor | null = null, bd = Infinity;
    const v0 = new THREE.Vector3(), v1 = new THREE.Vector3();
    for (const a of this.actors) {
      v0.set(a.x, a.hop, a.z);
      v1.set(a.x, a.hop + a.height, a.z);
      const d = Math.sqrt(this.ray.ray.distanceSqToSegment(v0, v1)) / Math.max(0.15, a.radius, a.height * 0.35);
      if (d < bd) {
        bd = d;
        best = a;
      }
    }
    return best && bd < 1.3 ? best.g.id : null;
  }

  snapshot(): Record<string, unknown> {
    return {
      view: "home",
      radius: this.radius,
      ringStep: ringStep(this.radius),
      poleTop: this.poleTop,
      quality: this.quality,
      triangles: this.actors.reduce((s, a) => s + a.tris, 0),
      selected: this.source.selected(),
      actors: this.actors.map((a) => ({
        id: a.g.id,
        name: a.g.name,
        heightM: Number(a.ph.heightM.toFixed(3)),
        /** Measured standing height of the mesh at rest (what the pole and the label show). */
        standM: Number(a.height.toFixed(3)),
        radius: Number(a.radius.toFixed(3)),
        state: a.state,
        step: a.state === "play" ? a.step : null,
        partner: a.partner?.g.name ?? null,
        x: Number(a.x.toFixed(2)),
        z: Number(a.z.toFixed(2)),
        inPoleLane: this.poleLane(a.x, a.z, a.radius * 0.9) !== null,
        tris: a.tris,
      })),
    };
  }

  dispose(): void {
    this.stage.canvas.removeEventListener("pointerdown", this.onDown);
    this.stage.canvas.removeEventListener("pointerup", this.onUp);
    this.clearActors();
    this.clearPlatform();
    this.heightLine.geometry.dispose();
    this.heightMark.geometry.dispose();
    for (const m of this.mats) m.dispose();
    if (this.heightLabel) disposeObject(this.heightLabel);
    this.group.removeFromParent();
    if (this.stage.scene.fog === this.fog) this.stage.scene.fog = null;
    if (this.stage.scene.background === this.bg) this.stage.scene.background = null;
  }
}

/** Free a mesh / line / sprite: geometry, material(s) and a sprite's canvas texture. */
function disposeObject(o: THREE.Object3D): void {
  const m = o as THREE.Mesh;
  if (m.isMesh || (o as THREE.Line).isLine) m.geometry?.dispose();
  const mats = (o as THREE.Mesh).material;
  if (!mats) return;
  for (const x of Array.isArray(mats) ? mats : [mats]) {
    (x as THREE.SpriteMaterial).map?.dispose();
    x.dispose();
  }
}

function safeBool(f: () => boolean): boolean {
  try {
    return !!f();
  } catch {
    return false;
  }
}
