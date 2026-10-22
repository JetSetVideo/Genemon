/**
 * LabView: one Genemon on a pedestal. It cycles idle -> charge -> active -> rest through its own
 * moves so the 3-phase animations can be inspected, and can overlay the SKELETON (bones, joints),
 * the centre of mass and the support polygon - the physics the model is built on.
 */
import * as THREE from "../lib/three.ts";
import { balanceOf, buildSkeleton, forwardKinematics, type Skeleton } from "../body/skeleton.ts";
import type { Genemon } from "../genome/genemon.ts";
import { phenotypeOf } from "../genome/genemon.ts";
import { helixOf } from "../genome/helix.ts";
import type { Move } from "../combat/moves.ts";
import { ALL_MOVE_BY_ID as MOVE_BY_ID } from "../combat/kit.ts";
import { hashSeed } from "../core/rng.ts";
import { Animator } from "./animator.ts";
import { CreatureView } from "./creature.ts";
import type { Stage, View } from "./stage.ts";
import { ELEMENTS } from "../data/elements.ts";

export class LabView implements View {
  private group = new THREE.Group();
  private creature: CreatureView | null = null;
  private animator: Animator | null = null;
  private sk: Skeleton | null = null;
  private overlay = new THREE.Group();
  private bones: THREE.LineSegments;
  private com: THREE.Mesh;
  private support: THREE.Line;
  private demoT = 0;
  private demoMove = 0;
  showSkeleton = false;
  autoRotate = true;
  stability = 0;
  strain = 0;
  phase: "idle" | "charge" | "active" | "rest" = "idle";

  constructor(private stage: Stage, private genemon: Genemon, dark: boolean) {
    const s = stage.scene;
    s.background = new THREE.Color(dark ? 0x0d1117 : 0xe9edf2);
    s.fog = null;
    const ped = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 3.6, 0.5, 64), new THREE.MeshStandardMaterial({ color: dark ? 0x1f2733 : 0xc9d1db, roughness: 0.7, metalness: 0.2 }));
    ped.position.y = -0.25;
    ped.receiveShadow = true;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(3.25, 0.04, 8, 96).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x4cc9f0 }));
    ring.position.y = 0.01;
    const key = new THREE.DirectionalLight(0xffffff, 2.4);
    key.position.set(5, 9, 6);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    const rim = new THREE.DirectionalLight(0x88aaff, 1.2);
    rim.position.set(-6, 4, -6);
    this.group.add(ped, ring, key, rim, new THREE.HemisphereLight(0xffffff, 0x334455, 0.8));
    this.bones = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x00e5ff, depthTest: false, transparent: true }));
    this.bones.renderOrder = 20;
    this.com = new THREE.Mesh(new THREE.SphereGeometry(0.06, 12, 8), new THREE.MeshBasicMaterial({ color: 0xff3b6b, depthTest: false }));
    this.com.renderOrder = 21;
    this.support = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffd166, depthTest: false }));
    this.support.renderOrder = 20;
    this.overlay.add(this.bones, this.com, this.support);
    this.group.add(this.overlay);
    s.add(this.group);
    stage.controls.enabled = true;
    this.setGenemon(genemon);
  }

  setGenemon(g: Genemon): void {
    this.genemon = g;
    this.creature?.dispose();
    const ph = phenotypeOf(g);
    this.sk = buildSkeleton(ph);
    const helix = helixOf(g.genome, ph);
    this.creature = new CreatureView(ph, this.sk, hashSeed(g.genome.id, "skin"), { quality: "high", shadows: true, helix });
    this.animator = new Animator(this.sk, ph, helix);
    this.group.add(this.creature.root);
    this.frame(0.6, 0.3);
  }

  /**
   * Frame the creature from a yaw/pitch (radians) using its bounding sphere, so a 0.3 m hatchling
   * and a 4 m giant fill the view alike. Returns the camera position for capture verification.
   */
  frame(yaw: number, pitch: number): [number, number, number] {
    if (!this.creature) return [0, 0, 0];
    this.creature.root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(this.creature.root);
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const cam = this.stage.camera;
    const fit = Math.min(cam.fov, cam.fov * Math.max(0.6, cam.aspect)) * Math.PI / 360;
    const d = Math.max(0.8, (sphere.radius / Math.sin(fit)) * 1.12);
    const c = sphere.center;
    cam.position.set(c.x + Math.sin(yaw) * Math.cos(pitch) * d, c.y + Math.sin(pitch) * d, c.z + Math.cos(yaw) * Math.cos(pitch) * d);
    this.stage.controls.target.copy(c);
    this.stage.controls.update();
    return [cam.position.x, cam.position.y, cam.position.z];
  }

  get current(): Genemon {
    return this.genemon;
  }

  private move(): Move | null {
    const ids = this.genemon.moves;
    return ids.length ? MOVE_BY_ID[ids[this.demoMove % ids.length]] ?? null : null;
  }

  update(dt: number, t: number): void {
    if (!this.creature || !this.animator || !this.sk) return;
    const ph = this.creature.ph;
    this.demoT += dt;
    const m = this.move();
    const plan: [typeof this.phase, number][] = [["idle", 2.2], ["charge", m ? m.charge / ph.stats.rate : 1], ["active", m?.active ?? 0.3], ["rest", m ? m.rest / ph.stats.rate : 0.5]];
    let acc = 0, idx = 0;
    const total = plan.reduce((s, p) => s + p[1], 0);
    const tt = this.demoT % total;
    for (; idx < plan.length; idx++) {
      if (tt < acc + plan[idx][1]) break;
      acc += plan[idx][1];
    }
    idx = Math.min(idx, plan.length - 1);
    const [phase, dur] = plan[idx];
    if (phase === "idle" && this.phase === "rest") this.demoMove++;
    this.phase = phase;
    const progress = (tt - acc) / dur;
    const out = this.animator.update({
      dt,
      t,
      phase,
      progress,
      move: phase === "idle" ? null : m,
      speed: 0,
      maxSpeed: ph.stats.spd,
      // Fliers spend every other demo cycle in the air so the wing beats can be inspected [P4-V3].
      flying: ph.abilities.fly && Math.floor(this.demoT / total) % 2 === 1,
      burrowed: false,
      frozen: false,
      koT: 0,
      stagger: 0,
      emotions: ph.psyche.emotions,
      energy01: 1,
      hp01: 1,
      lookYaw: Math.sin(t * 0.4) * 0.5,
      lookPitch: 0.1,
      normal: { x: 0, y: 1, z: 0 },
      liquid: false,
    });
    if (phase === "active" && progress < 0.1) this.animator.hit(0, false);
    this.creature.applyPose(out.pose);
    this.creature.pivot.scale.set(...out.squash);
    this.creature.pivot.position.y = out.lift;
    this.creature.setCharge(out.charge * (m ? Math.min(1.3, m.power / 60) : 0), m ? ELEMENTS[m.element].color : undefined);
    this.creature.setPupils(ph.psyche.emotions.fear, ph.psyche.emotions.anger);
    this.creature.tick(dt);
    if (this.autoRotate) this.creature.root.rotation.y += dt * 0.25;
    this.stability = out.stability;
    this.strain = out.strain;
    this.overlay.visible = this.showSkeleton;
    if (this.showSkeleton) this.drawSkeleton(out.pose);
  }

  private drawSkeleton(pose: Record<string, [number, number, number]>): void {
    const sk = this.sk!;
    const root = this.creature!.root;
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, root.rotation.y, 0));
    const fk = forwardKinematics(sk, pose, root.position.clone(), q);
    const pts: number[] = [];
    sk.joints.forEach((_, i) => pts.push(fk.pos[i].x, fk.pos[i].y, fk.pos[i].z, fk.end[i].x, fk.end[i].y, fk.end[i].z));
    this.bones.geometry.dispose();
    this.bones.geometry = new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    const bal = balanceOf(sk, fk, root.position.y);
    this.com.position.copy(bal.com);
    const contacts: number[] = [];
    sk.joints.forEach((j, i) => {
      if (j.contact) contacts.push(fk.end[i].x, 0.02, fk.end[i].z);
    });
    if (contacts.length >= 6) contacts.push(contacts[0], contacts[1], contacts[2]);
    this.support.geometry.dispose();
    this.support.geometry = new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(contacts, 3));
  }

  snapshot(): Record<string, unknown> {
    const ph = this.creature?.ph;
    return { genemon: this.genemon.name, kind: ph?.kind, phase: this.phase, stability: this.stability, strain: this.strain, joints: this.sk?.joints.length, triangles: this.creature?.triangles() };
  }

  dispose(): void {
    this.creature?.dispose();
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
    });
    this.group.removeFromParent();
    this.stage.scene.background = null;
    this.stage.controls.enabled = false;
  }
}

export function labSeedOf(g: Genemon): number {
  return hashSeed(g.genome.id, "lab");
}
