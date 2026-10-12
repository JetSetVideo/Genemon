/**
 * Intelligent battle camera ("broadcast director").
 * AUTO mode alternates two shots like a sports broadcast:
 *   - ACTION: when a fighter charges or strikes a damaging move, frame that attacker and its target
 *     (held >= 1.4 s so the cut does not jitter), lower and closer, from the side of their axis;
 *   - WIDE: otherwise frame every living fighter (+ projectiles, + large zones).
 * Readability equation: the framed subjects must stay inside |NDC| < 0.85; if any leaves the box
 * the shot widens by 60%/s, otherwise it tightens by 15%/s. Occlusion: the sight line is sampled
 * against terrain, props (trees, pillars, crystals, rocks) and the stands; the camera rises until
 * it is clear. Lens: trauma^2 shake, FOV punch and dutch roll on crits / KOs / lightning.
 * Smoothing is frame-rate independent exponential damping. Modes: auto | orbit | top | side | low | follow.
 */
import * as THREE from "../lib/three.ts";
import type { Battle, Fighter } from "../combat/battle.ts";
import { displayScale } from "./display.ts";

export type CameraMode = "auto" | "orbit" | "top" | "side" | "low" | "follow";

const damp = (a: number, b: number, lambda: number, dt: number) => a + (b - a) * (1 - Math.exp(-lambda * dt));
const UP = new THREE.Vector3(0, 1, 0);

interface Focus {
  a: number;
  t: number;
  until: number;
}

export class BattleCamera {
  mode: CameraMode = "auto";
  shakeScale = 1;
  private pos = new THREE.Vector3(0, 12, 26);
  private look = new THREE.Vector3();
  private side = 1;
  private trauma = 0;
  private fovPunch = 0;
  private roll = 0;
  private distK = 1;
  /** Height of the HUD band at the top of the frame, in NDC units (0 = none, 2 = the whole frame). */
  safeTop = 0;
  private t = 0;
  private focus: Focus | null = null;
  readonly debug = { center: new THREE.Vector3(), radius: 0, distance: 0, elevation: 0, outside: 0, shot: "wide", focus: "" };

  constructor(readonly cam: THREE.PerspectiveCamera) {}

  addTrauma(x: number): void {
    this.trauma = Math.min(1, this.trauma + x);
  }

  punch(deg: number, rollRad = 0): void {
    this.fovPunch = Math.max(this.fovPunch, deg);
    this.roll += rollRad;
  }

  /** Snap (no smoothing) - used when a battle starts, the mode changes, or a capture needs it. */
  snap(b: Battle): void {
    this.update(b, 10);
  }

  private chooseFocus(b: Battle): Focus | null {
    const f = this.focus;
    if (f) {
      const A = b.fighters[f.a], T = b.fighters[f.t];
      if (A && T && !A.ko && !T.ko && this.t < f.until) return f;
    }
    let best: Fighter | null = null, bestScore = 0;
    for (const x of b.fighters) {
      if (x.ko || !x.move || x.move.power <= 0 || (x.phase !== "charge" && x.phase !== "active")) continue;
      const tgt = b.fighters[x.target];
      if (!tgt || tgt.ko || tgt === x) continue;
      const score = x.move.power * (x.phase === "active" ? 1.3 : 1) * (1 + x.ph.slots * 0.05);
      if (score > bestScore) {
        bestScore = score;
        best = x;
      }
    }
    if (!best || !best.move) return null;
    const left = Math.max(0, best.phaseDur - best.phaseT) + best.move.active + best.move.rest * 0.5;
    return { a: best.idx, t: best.target, until: this.t + Math.max(1.4, left) };
  }

  private occluded(b: Battle, p: THREE.Vector3): boolean {
    const a = b.arena;
    if (a.heightAt(p.x, p.z) > p.y - 0.4) return true;
    if (Math.hypot(p.x, p.z) > a.half + 1 && p.y < 6.8) return true; // tiered stands
    for (const pr of a.props) {
      if (pr.kind === "reed" || pr.kind === "dune") continue;
      const top = a.heightAt(pr.x, pr.z) + (pr.kind === "tree" ? 5 : pr.kind === "pillar" ? 4.2 : 2.4) * pr.scale;
      if (p.y < top && Math.hypot(p.x - pr.x, p.z - pr.z) < 1.7 * pr.scale) return true;
    }
    return false;
  }

  update(b: Battle, dt: number): void {
    this.t += Math.min(dt, 1);
    const alive = b.fighters.filter((f) => !f.ko);
    if (alive.length === 0) return;
    const at = (f: Fighter) => new THREE.Vector3(f.body.pos.x, f.body.pos.y + f.ph.heightM * displayScale(f.ph.heightM) * 0.5, f.body.pos.z);
    // Subjects: the action pair in AUTO when something is happening, otherwise everyone.
    this.focus = this.mode === "auto" ? this.chooseFocus(b) : null;
    const subjects = this.focus ? [b.fighters[this.focus.a], b.fighters[this.focus.t]] : alive;
    const pts: { p: THREE.Vector3; r: number; w: number }[] = subjects.map((f) => {
      const ds = displayScale(f.ph.heightM);
      return { p: at(f), r: Math.max(f.body.radius * ds, f.ph.heightM * ds * 0.6), w: 1 };
    });
    if (!this.focus) {
      for (const p of b.projectiles) pts.push({ p: new THREE.Vector3(p.pos.x, p.pos.y, p.pos.z), r: 0.6, w: 0.4 });
      for (const z of b.zones) if (z.radius > 1.5) pts.push({ p: new THREE.Vector3(z.pos.x, z.pos.y, z.pos.z), r: z.radius * 0.6, w: 0.25 });
    }
    const center = new THREE.Vector3();
    let wsum = 0;
    for (const x of pts) {
      center.addScaledVector(x.p, x.w);
      wsum += x.w;
    }
    center.multiplyScalar(1 / wsum);
    let radius = 1.5;
    for (const x of pts) if (x.w >= 0.9) radius = Math.max(radius, x.p.distanceTo(center) + x.r);
    // Shot axis: attacker -> target in an action shot, team centroids in a wide shot.
    let axis: THREE.Vector3;
    if (this.focus) axis = at(b.fighters[this.focus.t]).sub(at(b.fighters[this.focus.a]));
    else {
      const cA = new THREE.Vector3(), cB = new THREE.Vector3();
      let nA = 0, nB = 0;
      for (const f of alive) {
        if (f.team === 0) cA.add(at(f)), nA++;
        else cB.add(at(f)), nB++;
      }
      axis = nA && nB ? cB.multiplyScalar(1 / nB).sub(cA.multiplyScalar(1 / nA)) : new THREE.Vector3(1, 0, 0);
    }
    axis.y = 0;
    if (axis.lengthSq() < 0.01) axis.set(1, 0, 0);
    axis.normalize();
    const perp = new THREE.Vector3(-axis.z, 0, axis.x);
    const camSide = this.pos.clone().sub(center).dot(perp);
    if (Math.abs(camSide) > 2 && Math.sign(camSide) !== this.side) this.side = Math.sign(camSide);
    let dirH = perp.clone().multiplyScalar(this.side).applyAxisAngle(UP, 0.42 * this.side);
    let elev = this.focus ? 0.3 : 0.45;
    const maxAlt = Math.max(0, ...subjects.map((f) => f.body.pos.y - b.arena.heightAt(f.body.pos.x, f.body.pos.z)));
    elev += Math.min(0.35, maxAlt * 0.04);
    switch (this.mode) {
      case "top":
        elev = 1.35;
        break;
      case "side":
        dirH = perp.clone().multiplyScalar(this.side);
        elev = 0.18;
        break;
      case "low":
        elev = 0.08;
        dirH.applyAxisAngle(UP, 0.6);
        break;
      case "follow": {
        const lead = alive.find((f) => f.team === 0) ?? alive[0];
        dirH = new THREE.Vector3(-Math.sin(lead.body.yaw), 0, -Math.cos(lead.body.yaw));
        elev = 0.32;
        center.lerp(new THREE.Vector3(lead.body.pos.x, lead.body.pos.y + lead.ph.heightM, lead.body.pos.z), 0.5);
        break;
      }
    }
    // Anticipation: a big charge narrows the lens on the attacker.
    let fov = 48;
    if (this.focus) {
      const A = b.fighters[this.focus.a];
      if (A.phase === "charge" && A.move && A.move.power >= 70 && A.phaseT / Math.max(0.01, A.phaseDur) > 0.45) fov -= 5;
    }
    const aspect = this.cam.aspect || 1.6;
    const vHalf = THREE.MathUtils.degToRad(fov / 2);
    const half = Math.min(vHalf, Math.atan(Math.tan(vHalf) * aspect));
    const distance = THREE.MathUtils.clamp((radius / Math.sin(half)) * 1.1 * this.distK, 4.5, 60);
    // Occlusion: raise until the sight line clears terrain, props and stands. The aim is lifted by
    // the HUD band so the subjects sit in the free part of the frame below the cards.
    const target = center.clone();
    target.y += this.safeTop * 0.5 * radius;
    let desired = new THREE.Vector3();
    for (let k = 0; k < 8; k++) {
      desired = target.clone().add(dirH.clone().multiplyScalar(Math.cos(elev) * distance)).setY(target.y + Math.sin(elev) * distance);
      let blocked = false;
      for (let s = 2; s <= 12 && !blocked; s++) blocked = this.occluded(b, target.clone().lerp(desired, s / 12));
      if (!blocked || this.mode === "low" || this.mode === "side") break;
      elev = Math.min(1.3, elev + 0.12);
    }
    if (this.mode !== "orbit") {
      const lam = dt > 1 ? 1000 : this.focus ? 3 : 2.2;
      this.pos.set(damp(this.pos.x, desired.x, lam, dt), damp(this.pos.y, desired.y, lam, dt), damp(this.pos.z, desired.z, lam, dt));
      this.look.set(damp(this.look.x, target.x, lam * 1.6, dt), damp(this.look.y, target.y, lam * 1.6, dt), damp(this.look.z, target.z, lam * 1.6, dt));
      this.cam.position.copy(this.pos);
      this.cam.lookAt(this.look);
    }
    // Readability equation on the framed subjects (skipped on snaps: dt > 1 is not elapsed time). The
    // box excludes the HUD band at the top (safeTop, NDC units, set by the UI from the measured cards).
    this.cam.updateMatrixWorld();
    let outside = 0;
    for (const f of subjects) {
      const v = at(f).project(this.cam);
      if (Math.abs(v.x) > 0.85 || v.y > 0.85 - this.safeTop || v.y < -0.85 || v.z > 1) outside++;
    }
    if (dt <= 1) this.distK = THREE.MathUtils.clamp(this.distK * (outside > 0 ? 1 + 0.6 * dt : 1 - 0.15 * dt), 0.75, 1.8);
    // Lens: shake, FOV punch, dutch roll.
    this.trauma = Math.max(0, this.trauma - Math.min(dt, 1) * 1.1);
    this.fovPunch = damp(this.fovPunch, 0, 5, dt);
    this.roll = damp(this.roll, 0, 3, dt);
    const s = this.trauma * this.trauma * this.shakeScale;
    if (s > 0.001 && this.mode !== "orbit") {
      const n = (k: number) => Math.sin(this.t * 37 + k) * 0.6 + Math.sin(this.t * 23.3 + k * 2.1) * 0.4;
      this.cam.position.add(new THREE.Vector3(n(1), n(2), n(3)).multiplyScalar(0.45 * s));
      this.cam.rotateZ(n(4) * 0.04 * s);
    }
    this.cam.rotateZ(this.roll);
    this.cam.fov = fov - this.fovPunch;
    this.cam.updateProjectionMatrix();
    Object.assign(this.debug, {
      radius,
      distance,
      elevation: elev,
      outside,
      shot: this.focus ? "action" : "wide",
      focus: this.focus ? `${b.fighters[this.focus.a].name} -> ${b.fighters[this.focus.t].name}` : "",
    });
    this.debug.center.copy(center);
  }
}
