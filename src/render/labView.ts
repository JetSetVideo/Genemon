/**
 * LabView: one Genemon on a pedestal. It cycles idle -> charge -> active -> rest through its own
 * moves so the 3-phase animations can be inspected, and can overlay the SKELETON (bones, joints),
 * the centre of mass and the support polygon - the physics the model is built on.
 *
 * Pass 5 [P5-A2, P5-U2]: the head LOOKS at the viewer (the camera) or at a point (lookAt, e.g. the
 * object being dragged), with saccades; the life state (hunger, sleepiness / sleep, bloat, age tempo)
 * shapes the idle; feedReaction() plays the eat animation (head dips, chews, coloured crumbs at the
 * mouth, happy wiggle) and hitTest() is the drag-to-feed drop target (raycast against the creature).
 */
import * as THREE from "../lib/three.ts";
import { balanceOf, buildSkeleton, skeletonGenes, forwardKinematics, type Pose, type Skeleton } from "../body/skeleton.ts";
import { P5_DEFAULTS } from "../genome/morphTypes.ts";
import { buildEgg, eggFitObject, fetusPose } from "./anatomy/egg.ts";
import { lifePhase } from "../genome/lifeclock.ts";
import type { Genemon } from "../genome/genemon.ts";
import { phenotypeOf } from "../genome/genemon.ts";
import { helixOf } from "../genome/helix.ts";
import type { Move } from "../combat/moves.ts";
import { ALL_MOVE_BY_ID as MOVE_BY_ID } from "../combat/kit.ts";
import type { LifePhase } from "../genome/lifeTypes.ts";
import { hashSeed } from "../core/rng.ts";
import { Animator, animStateFromLife, type AnimState, type FeedKind } from "./animator.ts";
import { CreatureView } from "./creature.ts";
import { ParticlePool } from "./fx.ts";
import type { Stage, View } from "./stage.ts";
import { ELEMENTS } from "../data/elements.ts";

/** Client pixel -> normalised device coordinates inside a rect (null when outside or degenerate). */
export function clientToNdc(x: number, y: number, r: { left: number; top: number; width: number; height: number }): [number, number] | null {
  if (r.width <= 0 || r.height <= 0) return null;
  const u = (x - r.left) / r.width, v = (y - r.top) / r.height;
  if (u < 0 || u > 1 || v < 0 || v > 1) return null;
  return [u * 2 - 1, -(v * 2 - 1)];
}

/** Optional pass-5 cosmetics on CreatureView (pupils follow the gaze, lids droop when sleepy). */
type GazeAware = { setGaze?(yaw: number, pitch: number): void; setLids?(minClosed: number): void };

export class LabView implements View {
  private group = new THREE.Group();
  private creature: CreatureView | null = null;
  private animator: Animator | null = null;
  private sk: Skeleton | null = null;
  private overlay = new THREE.Group();
  private bones: THREE.LineSegments;
  private com: THREE.Mesh;
  private support: THREE.Line;
  private crumbs = new ParticlePool(320, true);
  private demoT = 0;
  private demoMove = 0;
  private ray = new THREE.Raycaster();
  private lookPoint: THREE.Vector3 | null = null;
  private lifeOverride: Partial<AnimState> | null = null;
  private lifeState: AnimState = animStateFromLife(undefined);
  private feedColor = new THREE.Color(0xffffff);
  private feedKind: FeedKind = "food";
  private feedAge = -1;
  private egg: THREE.Mesh | null = null;
  private fetal: Pose | null = null;
  private headIdx = -1;
  private jawIdx = -1;
  private v1 = new THREE.Vector3();
  private v2 = new THREE.Vector3();
  showSkeleton = false;
  autoRotate = true;
  /** Look at the viewer when no lookAt point is set. */
  lookAtCamera = true;
  /** Life phase provider (lifeclock lane): elders animate slower. */
  lifePhaseOf: ((g: Genemon) => LifePhase) | null = null;
  stability = 0;
  strain = 0;
  phase: "idle" | "charge" | "active" | "rest" = "idle";
  /** Feed reactions played (QA). */
  feeds = 0;

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
    this.group.add(this.overlay, this.crumbs.points);
    s.add(this.group);
    stage.controls.enabled = true;
    this.setGenemon(genemon);
  }

  setGenemon(g: Genemon): void {
    this.genemon = g;
    this.creature?.dispose();
    const ph = phenotypeOf(g);
    const helix = helixOf(g.genome, ph);
    this.sk = buildSkeleton(ph, skeletonGenes(helix));
    const phase = lifePhase(g);
    this.creature = new CreatureView(ph, this.sk, hashSeed(g.genome.id, "skin"), { quality: "high", shadows: true, helix, life: { scars: g.life?.scars ?? [], phase } });
    // Egg / fetus [P5-V2]: the embryo curls in its fetal spiral inside a (translucent for a fetus) egg.
    this.egg?.removeFromParent();
    this.egg?.geometry.dispose();
    (this.egg?.material as THREE.Material | undefined)?.dispose();
    this.egg = null;
    this.fetal = null;
    if (phase === "egg" || phase === "fetus") {
      this.fetal = fetusPose(this.sk, Math.min(1, ph.growth / 0.25), (helix.p5 ?? P5_DEFAULTS).growth.spiral);
      this.creature.applyPose(this.fetal);
      const spec = eggFitObject(this.creature.pivot);
      this.egg = buildEgg(spec, ELEMENTS[ph.elements.primary].color, hashSeed(g.genome.id, "egg"), "high", { opacity: phase === "egg" ? 1 : 0.45 });
      this.creature.pivot.add(this.egg);
      this.creature.pivot.position.y = spec.lift;
    }
    this.animator = new Animator(this.sk, ph, helix);
    this.headIdx = this.sk.joints.findIndex((j) => j.role === "head");
    this.jawIdx = this.sk.joints.findIndex((j) => j.role === "jaw");
    this.feedAge = -1;
    this.refreshLife();
    this.group.add(this.creature.root);
    this.frame(0.6, 0.3);
  }

  /**
   * Life-state drives of the idle (hunger, sleepy, asleep, bloat, tempo). Pass the circadian state the
   * caller computed (e.g. `{ asleep: circ.asleep, sleepy: 1 - circ.alertness }`); null = from g.life.
   */
  setLifeState(s: Partial<AnimState> | null): void {
    this.lifeOverride = s;
    this.refreshLife();
  }

  private refreshLife(): void {
    const base = animStateFromLife(this.genemon.life, { phase: this.lifePhaseOf?.(this.genemon) });
    this.lifeState = { ...base, ...(this.lifeOverride ?? {}) };
  }

  /** Look at a world point (e.g. the object being dragged); null = back to the viewer. */
  lookAt(point: { x: number; y: number; z: number } | null): void {
    this.lookPoint = point ? new THREE.Vector3(point.x, point.y, point.z) : null;
  }

  /**
   * Look toward a client point (CSS px), e.g. the item being dragged: the point is unprojected at the
   * creature's depth. Outside the canvas (or null) = back to the viewer.
   */
  lookAtClient(clientX: number | null, clientY = 0): void {
    if (clientX === null || !this.creature) return this.lookAt(null);
    const ndc = clientToNdc(clientX, clientY, this.stage.renderer.domElement.getBoundingClientRect());
    if (!ndc) return this.lookAt(null);
    this.ray.setFromCamera(new THREE.Vector2(ndc[0], ndc[1]), this.stage.camera);
    const d = this.stage.camera.position.distanceTo(this.creature.root.getWorldPosition(this.v1));
    this.lookAt(this.ray.ray.at(d, new THREE.Vector3()));
  }

  /**
   * The eat animation [P5-U2]: food -> head dips, chews with coloured crumbs at the mouth, then a happy
   * wiggle; gear / cosmetic -> sniff, a proud lift or a preening look, sparkles. Wakes a sleeper.
   */
  feedReaction(color: number, kind: FeedKind = "food"): void {
    if (!this.animator) return;
    this.feedColor.setHex(color);
    this.feedKind = kind;
    this.feedAge = 0;
    this.feeds++;
    if (this.lifeState.asleep) this.lifeState = { ...this.lifeState, asleep: false };
    this.animator.feed(kind);
    this.phase = "idle";
    this.emitAtMouth(kind === "food" ? 10 : 16, kind === "food" ? 0.7 : 1.2, 0.06);
  }

  /**
   * Drop target for drag-to-feed: true when the client point (CSS px) is over the creature (exact
   * raycast against its meshes, or within the core of its bounding sphere for a forgiving drop).
   */
  hitTest(clientX: number, clientY: number): boolean {
    if (!this.creature) return false;
    const ndc = clientToNdc(clientX, clientY, this.stage.renderer.domElement.getBoundingClientRect());
    if (!ndc) return false;
    this.ray.setFromCamera(new THREE.Vector2(ndc[0], ndc[1]), this.stage.camera);
    this.creature.root.updateMatrixWorld(true);
    const sphere = new THREE.Box3().setFromObject(this.creature.root).getBoundingSphere(new THREE.Sphere());
    if (!this.ray.ray.intersectsSphere(sphere)) return false;
    if (this.ray.ray.intersectsSphere(new THREE.Sphere(sphere.center, sphere.radius * 0.5))) return true;
    return this.ray.intersectObject(this.creature.root, true).length > 0;
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

  /** Mouth position in world space (jaw tip, else the head's front). */
  private mouth(out: THREE.Vector3): THREE.Vector3 | null {
    if (!this.creature || !this.sk) return null;
    const idx = this.jawIdx >= 0 ? this.jawIdx : this.headIdx;
    if (idx < 0) return null;
    const j = this.sk.joints[idx];
    out.set(j.dir[0], j.dir[1], j.dir[2]).multiplyScalar(j.length * 0.85);
    return this.creature.joints[idx].localToWorld(out);
  }

  private emitAtMouth(n: number, speed: number, size: number): void {
    const at = this.mouth(this.v1);
    if (!at || !this.creature) return;
    const s = Math.max(0.4, this.creature.ph.heightM) * size;
    const c = this.feedColor;
    const food = this.feedKind === "food";
    for (let k = 0; k < n; k++) {
      const a = Math.random() * Math.PI * 2, up = food ? Math.random() * 0.6 : 0.4 + Math.random();
      const v = speed * (0.4 + 0.6 * Math.random());
      this.crumbs.spawn(at.x, at.y, at.z, Math.cos(a) * v, up * v, Math.sin(a) * v, c, s * (0.6 + 0.8 * Math.random()), 0.5 + 0.5 * Math.random(), { gravity: food ? 3 : -0.4, drag: 2 });
    }
  }

  /** Look target (yaw +left, pitch +down) in creature space from the head to a world point. */
  private lookAngles(point: THREE.Vector3): [number, number] {
    const cv = this.creature!;
    const head = this.headIdx >= 0 ? cv.joints[this.headIdx].getWorldPosition(this.v2) : cv.root.getWorldPosition(this.v2);
    const d = point.clone().sub(head);
    const q = cv.root.getWorldQuaternion(new THREE.Quaternion()).invert();
    d.applyQuaternion(q);
    return [Math.atan2(d.x, d.z), Math.atan2(-d.y, Math.hypot(d.x, d.z))];
  }

  update(dt: number, t: number): void {
    if (!this.creature || !this.animator || !this.sk) return;
    if (this.fetal) {
      this.creature.applyPose(this.fetal);
      this.creature.tick(dt);
      return;
    }
    const ph = this.creature.ph;
    const st = this.lifeState;
    const busy = this.animator.feeding || st.asleep;
    // The demo cycle pauses while eating or sleeping (idle only); idle phases are longer and calmer.
    if (!busy) this.demoT += dt;
    const m = this.move();
    const plan: [typeof this.phase, number][] = [["idle", 3.2], ["charge", (m ? m.charge / ph.stats.rate : 1) * 1.25], ["active", (m?.active ?? 0.3) * 1.15], ["rest", (m ? m.rest / ph.stats.rate : 0.5) * 1.3]];
    let acc = 0, idx = 0;
    const total = plan.reduce((s, p) => s + p[1], 0);
    const tt = this.demoT % total;
    for (; idx < plan.length; idx++) {
      if (tt < acc + plan[idx][1]) break;
      acc += plan[idx][1];
    }
    idx = Math.min(idx, plan.length - 1);
    let [phase, dur] = plan[idx];
    if (busy) [phase, dur] = ["idle", 1];
    if (phase === "idle" && this.phase === "rest") this.demoMove++;
    this.phase = phase;
    const progress = busy ? 0 : (tt - acc) / dur;
    // Look at the dragged object / given point, else the viewer.
    let lookYaw = 0, lookPitch = 0, lookWeight = 0;
    const target = this.lookPoint ?? (this.lookAtCamera ? this.stage.camera.position : null);
    if (target) {
      [lookYaw, lookPitch] = this.lookAngles(target);
      lookWeight = 1;
    }
    const out = this.animator.update({
      dt,
      t,
      phase,
      progress,
      move: phase === "idle" ? null : m,
      speed: 0,
      maxSpeed: ph.stats.spd,
      // Fliers spend every other demo cycle in the air so the wing beats can be inspected [P4-V3].
      flying: !busy && ph.abilities.fly && Math.floor(this.demoT / total) % 2 === 1,
      burrowed: false,
      frozen: false,
      koT: 0,
      stagger: 0,
      emotions: ph.psyche.emotions,
      energy01: 1,
      hp01: 1,
      lookYaw,
      lookPitch,
      lookWeight,
      normal: { x: 0, y: 1, z: 0 },
      liquid: false,
      state: st,
    });
    if (phase === "active" && progress < 0.1) this.animator.hit(0, false);
    this.creature.applyPose(out.pose);
    this.creature.pivot.scale.set(...out.squash);
    this.creature.pivot.rotation.set(0, 0, out.bodyRoll);
    this.creature.pivot.position.y = out.lift;
    this.creature.setCharge(out.charge * (m ? Math.min(1.3, m.power / 60) : 0), m ? ELEMENTS[m.element].color : undefined);
    this.creature.setPupils(ph.psyche.emotions.fear, ph.psyche.emotions.anger);
    const ga = this.creature as unknown as GazeAware;
    ga.setGaze?.(out.gaze[0], out.gaze[1]);
    ga.setLids?.(out.lids);
    this.creature.tick(dt);
    if (this.autoRotate) this.creature.root.rotation.y += dt * 0.25;
    // Feed FX: crumbs while chewing (food), sparkles during the reaction (gear / cosmetic).
    if (this.feedAge >= 0) {
      this.feedAge += dt;
      this.creature.root.updateMatrixWorld(true);
      const food = this.feedKind === "food";
      const rate = food ? 16 * out.chewing : this.feedAge < 2.4 ? 10 : 0;
      const n = Math.floor(rate * dt + Math.random());
      if (n > 0 && rate > 0) this.emitAtMouth(Math.min(3, n), food ? 0.5 : 0.9, food ? 0.035 : 0.05);
      if (!this.animator.feeding && this.feedAge > 0.5) this.feedAge = -1;
    }
    this.crumbs.update(dt);
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
    return {
      genemon: this.genemon.name,
      kind: ph?.kind,
      phase: this.phase,
      stability: this.stability,
      strain: this.strain,
      joints: this.sk?.joints.length,
      triangles: this.creature?.triangles(),
      feeding: this.animator?.feeding ?? false,
      feeds: this.feeds,
      life: this.lifeState,
      gaze: this.animator ? { yaw: Math.round(this.animator.gaze.yaw * 1000) / 1000, pitch: Math.round(this.animator.gaze.pitch * 1000) / 1000 } : null,
    };
  }

  dispose(): void {
    this.creature?.dispose();
    this.crumbs.dispose();
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
