/**
 * BattleView: plays a Battle in 3D. Fixed-step simulation (speed setting, slow-motion on crits),
 * consumes battle events into FX / camera lens / animator reactions, and syncs every fighter's
 * body (physics) and pose (animator through the skeleton constraints) to its CreatureView.
 */
import * as THREE from "../lib/three.ts";
import { type Battle, type BattleEvent } from "../combat/battle.ts";
import { buildSkeleton } from "../body/skeleton.ts";
import { ELEMENTS } from "../data/elements.ts";
import { GROUNDS } from "../data/grounds.ts";
import { hashSeed } from "../core/rng.ts";
import { ArenaView } from "./arenaView.ts";
import { Animator } from "./animator.ts";
import { BattleCamera, type CameraMode } from "./battleCamera.ts";
import { CreatureView } from "./creature.ts";
import { FxDirector } from "./fx.ts";
import type { Stage, View } from "./stage.ts";
import { textSprite } from "./textures.ts";
import { displayScale } from "./display.ts";

/** Side colours: team 0 (you) sky blue, team 1 (rival) orange - shared by the 3D markers and the HUD. */
export const SIDE_COLORS = ["#38bdf8", "#fb923c"] as const;

interface SideMarker {
  ring: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  tag: THREE.Sprite;
  hpBack: THREE.Sprite;
  hp: THREE.Sprite;
}
/** Screen size of the floating tag and HP pip (sizeAttenuation off: units = height at 1 m depth). */
const TAG_H = 0.0215, PIP_W = 0.05, PIP_H = 0.0045;

export interface BattleViewOptions {
  shadows: boolean;
  quality: "low" | "high";
  shake: number;
  speed: number;
  camera: CameraMode;
}

export class BattleView implements View {
  readonly arenaView: ArenaView;
  readonly creatures: CreatureView[] = [];
  readonly animators: Animator[] = [];
  readonly fx: FxDirector;
  readonly cam: BattleCamera;
  speed: number;
  /** Pin the simulation (QA captures) - rendering keeps running. */
  frozen = false;
  private lastSeq = 0;
  private acc = 0;
  private slowmo = 0;
  private weather = "";
  private listeners: ((e: BattleEvent[]) => void)[] = [];
  private strain: number[] = [];
  private stability: number[] = [];
  private markers: SideMarker[] = [];
  /** Display scale per fighter (small bodies drawn larger; physics untouched). */
  private ds: number[] = [];

  constructor(private stage: Stage, readonly battle: Battle, o: BattleViewOptions) {
    this.speed = o.speed;
    this.arenaView = new ArenaView(battle.arena, stage.scene, o.shadows);
    this.fx = new FxDirector(stage.scene);
    this.fx.onFlash = (s, c) => stage.flash(s, c);
    this.cam = new BattleCamera(stage.camera);
    this.cam.mode = o.camera;
    this.cam.shakeScale = o.shake;
    stage.controls.enabled = o.camera === "orbit";
    for (const f of battle.fighters) {
      const sk = buildSkeleton(f.ph);
      const cv = new CreatureView(f.ph, sk, hashSeed(f.genemon.genome.id, "skin"), { quality: o.quality, shadows: o.shadows });
      const ds = displayScale(f.ph.heightM);
      cv.root.scale.setScalar(ds);
      this.ds.push(ds);
      stage.scene.add(cv.root);
      this.creatures.push(cv);
      this.animators.push(new Animator(sk, f.ph));
      this.strain.push(0);
      this.stability.push(1);
      this.markers.push(this.makeMarker(f.team, f.name, f.body.radius * ds));
    }
    this.syncCreatures(0, 0);
    this.cam.snap(battle);
  }

  /**
   * Who is whose: a ground ring in the side colour (stays on the ground under fliers, reads depth)
   * and a name tag + HP pip at a constant screen size above the head.
   */
  private makeMarker(team: 0 | 1, name: string, radius: number): SideMarker {
    const color = SIDE_COLORS[team];
    const w = Math.max(0.07, radius * 0.16);
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(radius * 1.12, radius * 1.12 + w, 48),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.renderOrder = 2;
    const tag = textSprite(name, color, 26);
    const tm = tag.material as THREE.SpriteMaterial;
    tm.sizeAttenuation = false;
    tag.scale.set((tag.scale.x / tag.scale.y) * TAG_H, TAG_H, 1);
    tag.center.set(0.5, -0.55);
    const pip = (c: string, o: number) => {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ color: c, transparent: true, opacity: o, depthTest: false, sizeAttenuation: false }));
      s.renderOrder = 11;
      return s;
    };
    const hpBack = pip("#0b0f14", 0.75), hp = pip(color, 1);
    hpBack.scale.set(PIP_W, PIP_H, 1);
    hpBack.center.set(0.5, 0);
    for (const o of [ring, tag, hpBack, hp]) this.stage.scene.add(o);
    return { ring, tag, hpBack, hp };
  }

  onEvents(fn: (e: BattleEvent[]) => void): void {
    this.listeners.push(fn);
  }

  setCameraMode(m: CameraMode): void {
    this.cam.mode = m;
    this.stage.controls.enabled = m === "orbit";
    if (m === "orbit") this.stage.controls.target.copy(this.cam.debug.center);
  }

  /** The UI reports how much of the frame its HUD cards cover at the top (fraction of the height). */
  setHudTop(frac: number): void {
    this.cam.safeTop = Math.max(0, Math.min(0.8, frac)) * 2;
  }

  private headOf = (idx: number): THREE.Vector3 => {
    const f = this.battle.fighters[idx];
    return new THREE.Vector3(f.body.pos.x, f.body.pos.y + f.ph.heightM * this.ds[idx] * 0.7, f.body.pos.z);
  };

  update(dt: number, t: number): void {
    const b = this.battle;
    if (!this.frozen) {
      this.slowmo = Math.max(0, this.slowmo - dt);
      this.acc += dt * this.speed * (this.slowmo > 0 ? 0.35 : 1);
      let steps = 0;
      while (this.acc >= b.dt && b.winner === null && steps < 12) {
        b.step();
        this.acc -= b.dt;
        steps++;
      }
      if (b.winner !== null) this.acc = 0;
    }
    const fresh = b.events.filter((e) => e.seq > this.lastSeq);
    if (fresh.length) {
      this.lastSeq = fresh[fresh.length - 1].seq;
      this.fx.consume(b, fresh, this.headOf);
      for (const e of fresh) this.react(e);
      for (const fn of this.listeners) fn(fresh);
    }
    if (b.weather !== this.weather) {
      this.weather = b.weather;
      this.arenaView.setConditions(b.weatherDef, b.setup.arena.hour);
    }
    this.syncCreatures(dt, t);
    this.fx.update(b, dt, t);
    this.arenaView.update(dt, b.weatherDef, t);
    this.cam.update(b, dt);
  }

  private react(e: BattleEvent): void {
    const b = this.battle;
    switch (e.type) {
      case "hit": {
        const t = b.fighters[e.b!];
        const k = Math.min(1, (e.value ?? 0) / Math.max(1, t.maxHp) * 3);
        this.animators[e.b!].hit(k, !!e.crit);
        this.cam.addTrauma(0.08 + 0.25 * k + (e.crit ? 0.45 : 0));
        if (e.crit) {
          this.cam.punch(7, (Math.random() - 0.5) * 0.08);
          this.slowmo = 0.45;
        }
        break;
      }
      case "ko":
        this.cam.addTrauma(0.5);
        this.cam.punch(5);
        this.slowmo = 0.7;
        break;
      case "lightning":
        this.cam.addTrauma(0.4);
        break;
      case "clash":
      case "reaction":
        this.cam.addTrauma(0.2);
        break;
      case "physics":
        if (e.a !== undefined && (e.label === "land" || e.label === "splash")) this.animators[e.a].land(e.value ?? 0);
        if (e.label === "bump") this.cam.addTrauma(0.06);
        break;
    }
  }

  private syncCreatures(dt: number, t: number): void {
    const b = this.battle;
    b.fighters.forEach((f, i) => {
      const cv = this.creatures[i];
      const body = f.body;
      cv.root.position.set(body.pos.x, body.pos.y, body.pos.z);
      cv.root.rotation.y = body.yaw;
      // Benched Genemon wait with their trainer, off the field [P4-B2].
      cv.root.visible = body.mode !== "burrow" && !f.benched;
      const target = b.fighters[f.target] && f.target !== f.idx ? b.fighters[f.target] : b.fighters.find((o) => o.team !== f.team && !o.ko && !o.benched);
      let lookYaw = 0, lookPitch = 0;
      if (target) {
        const dx = target.body.pos.x - body.pos.x, dz = target.body.pos.z - body.pos.z;
        let a = Math.atan2(dx, dz) - body.yaw;
        while (a > Math.PI) a -= Math.PI * 2;
        while (a < -Math.PI) a += Math.PI * 2;
        lookYaw = a;
        lookPitch = Math.atan2((body.pos.y + f.ph.heightM * 0.7) - (target.body.pos.y + target.ph.heightM * 0.6), Math.hypot(dx, dz));
      }
      const n = b.arena.normalAt(body.pos.x, body.pos.z);
      const cy = Math.cos(body.yaw), sy = Math.sin(body.yaw);
      const local = { x: n.x * cy - n.z * sy, y: n.y, z: n.x * sy + n.z * cy };
      const out = this.animators[i].update({
        dt,
        t: t + i * 0.37,
        phase: f.phase,
        progress: f.phaseDur > 0 ? f.phaseT / f.phaseDur : 0,
        move: f.move,
        speed: Math.hypot(body.vel.x, body.vel.z),
        maxSpeed: f.stats.spd,
        flying: body.mode === "fly",
        burrowed: body.mode === "burrow",
        frozen: f.status.has("frozen"),
        koT: f.ko ? b.t - f.koAt + 0.001 : 0,
        stagger: body.stagger,
        emotions: f.emotions,
        energy01: f.energy / f.stats.energy,
        hp01: f.hp / f.maxHp,
        lookYaw,
        lookPitch,
        normal: body.mode === "fly" ? { x: 0, y: 1, z: 0 } : local,
        liquid: GROUNDS[body.groundId].liquid,
      });
      cv.applyPose(out.pose);
      cv.pivot.scale.set(out.squash[0], out.squash[1], out.squash[2]);
      cv.pivot.rotation.set(out.bodyPitch, 0, out.bodyRoll);
      cv.pivot.position.y = out.lift - (body.submerged * f.ph.heightM * 0.35);
      const chargeColor = f.move ? ELEMENTS[f.move.element].color : undefined;
      cv.setCharge(out.charge * (f.move ? Math.min(1.3, f.move.power / 60) : 0), chargeColor);
      cv.setPupils(f.emotions.fear, f.emotions.anger);
      cv.setTint(f.status.has("frozen"), f.ko ? Math.min(1, (b.t - f.koAt) / 1.5) : 0);
      this.strain[i] = out.strain;
      this.stability[i] = out.stability;
      f.strain = out.strain;
      // Side marker: ring on the ground under the body, tag + HP pip above the head.
      const mk = this.markers[i];
      const gy = b.arena.heightAt(body.pos.x, body.pos.z);
      mk.ring.position.set(body.pos.x, gy + 0.04, body.pos.z);
      mk.ring.material.opacity = f.ko ? 0.2 : 0.85;
      const top = body.mode === "burrow" ? gy + 0.3 : body.pos.y + f.ph.heightM * this.ds[i] * 1.05 + 0.15;
      const frac = Math.max(0, f.hp / f.maxHp);
      for (const s of [mk.tag, mk.hpBack, mk.hp]) {
        s.position.set(body.pos.x, top, body.pos.z);
        s.visible = !f.ko && !f.benched;
      }
      mk.ring.visible = !f.benched;
      mk.hp.visible = !f.ko && !f.benched && frac > 0;
      mk.hp.scale.set(PIP_W * Math.max(0.01, frac), PIP_H, 1);
      // Fill anchored on the left edge of the background bar.
      mk.hp.center.set(0.5 / Math.max(0.01, frac), 0);
      if (f.phase === "charge" && f.move && Math.random() < 0.6) {
        const h = this.headOf(i);
        const c = new THREE.Color(ELEMENTS[f.move.element].color);
        const a = Math.random() * Math.PI * 2, r = f.ph.heightM * 0.9;
        this.fx.glow.spawn(h.x + Math.cos(a) * r, h.y + (Math.random() - 0.3) * r, h.z + Math.sin(a) * r, -Math.cos(a) * r * 2, 0.2, -Math.sin(a) * r * 2, c, 0.25 + 0.3 * (f.phaseT / Math.max(0.01, f.phaseDur)), 0.45, { drag: 1 });
      }
      // Sustained breath for the whole active phase of a cone move [P4-M2].
      if (f.phase === "active" && f.move?.shape === "cone" && !f.ko) {
        const h = this.headOf(i), aim = target ? Math.atan2(target.body.pos.x - body.pos.x, target.body.pos.z - body.pos.z) : body.yaw;
        h.x += Math.sin(aim) * f.body.radius * this.ds[i] * 0.8;
        h.z += Math.cos(aim) * f.body.radius * this.ds[i] * 0.8;
        this.fx.cone(h, aim, f.move.element, f.move.range, f.move.arc ?? 0.45, 10, 0.45 + 0.12 * f.ph.heightM);
      }
      // Stunned: dizzy sparks circling the head.
      if (f.status.has("stunned") && !f.ko && Math.random() < 0.7) {
        const h = this.headOf(i), a = t * 6 + i, r = 0.25 + f.ph.heightM * this.ds[i] * 0.35;
        this.fx.glow.spawn(h.x + Math.cos(a) * r, h.y + 0.25, h.z + Math.sin(a) * r, 0, 0.2, 0, new THREE.Color(0xfff3a0), 0.22, 0.3, { drag: 2 });
      }
      if (body.mode === "burrow" && Math.random() < 0.5) this.fx.dust({ x: body.pos.x, y: b.arena.heightAt(body.pos.x, body.pos.z), z: body.pos.z }, 2, 0x7a5a3a, 0.7);
    });
  }

  snapshot(): Record<string, unknown> {
    const b = this.battle;
    // On-screen box per fighter (CSS px inside the 3D view): feet and head projected through the
    // live camera, width from the body radius. Lets QA assert a minimum readable size.
    const cam = this.stage.camera, el = this.stage.renderer.domElement;
    const W = el.clientWidth, H = el.clientHeight;
    const box = (i: number) => {
      const f = b.fighters[i];
      const pts = [0, 1].flatMap((up) =>
        [-1, 1].map((s) => new THREE.Vector3(f.body.pos.x + s * f.body.radius * this.ds[i], f.body.pos.y + up * f.ph.heightM * this.ds[i], f.body.pos.z).project(cam))
      );
      const xs = pts.map((p) => (p.x * 0.5 + 0.5) * W), ys = pts.map((p) => (-p.y * 0.5 + 0.5) * H);
      const r = (v: number) => Math.round(v);
      return { x0: r(Math.min(...xs)), y0: r(Math.min(...ys)), x1: r(Math.max(...xs)), y1: r(Math.max(...ys)), hPx: r(Math.max(...ys) - Math.min(...ys)), inFront: pts.every((p) => p.z < 1) };
    };
    return {
      t: b.t,
      winner: b.winner,
      weather: b.weather,
      arena: b.arena.spec.kind,
      viewPx: [W, H],
      camera: { mode: this.cam.mode, ...this.cam.debug, center: this.cam.debug.center.toArray() },
      fighters: b.fighters.map((f, i) => ({
        name: f.name,
        team: f.team,
        kind: f.ph.kind,
        size: f.ph.sizeClass,
        hp: Math.round(f.hp),
        maxHp: Math.round(f.maxHp),
        phase: f.phase,
        move: f.move?.id ?? null,
        mode: f.body.mode,
        ground: f.body.groundId,
        pos: [f.body.pos.x, f.body.pos.y, f.body.pos.z].map((v) => Math.round(v * 100) / 100),
        screen: box(i),
        status: [...f.status.keys()],
        strain: Math.round(this.strain[i] * 1000) / 1000,
        stability: Math.round(this.stability[i] * 1000) / 1000,
        triangles: this.creatures[i].triangles(),
        benched: f.benched,
      })),
      switches: b.result().switches.length,
      zones: b.zones.map((z) => z.kind),
      projectiles: b.projectiles.length,
    };
  }

  dispose(): void {
    for (const c of this.creatures) c.dispose();
    for (const mk of this.markers) {
      this.stage.scene.remove(mk.ring, mk.tag, mk.hpBack, mk.hp);
      mk.ring.geometry.dispose();
      mk.ring.material.dispose();
      for (const s of [mk.tag, mk.hpBack, mk.hp]) {
        const m = s.material as THREE.SpriteMaterial;
        m.map?.dispose();
        m.dispose();
      }
    }
    this.fx.dispose();
    this.arenaView.dispose();
    this.stage.controls.enabled = false;
  }
}
