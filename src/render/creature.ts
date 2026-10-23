/**
 * CreatureView: the 3D model of a Genemon, built FROM ITS SKELETON. One Object3D per joint (same
 * offsets/order as src/body/skeleton.ts) so a constrained Pose maps 1:1 onto rotations.
 *
 * Pass 4 [P4-V1, P4-V3]: the body is FUSED swept-section anatomy (src/render/anatomy/body.ts: lofted
 * torsos, necks, tails and limbs with muscle lobes, socket spheres at the hips and shoulders, horns
 * with tines, digits with claws, big membrane / feather / insect / fin wings, rare asymmetry); the
 * face is manga-structured (anatomy/face.ts: 8 eye styles, lids, catchlights, teeth kinds, beaks);
 * the skin is physical with a generated normal map, sheen/clearcoat and a rim term (anatomy/skin.ts);
 * eye auras (smoke, flame, spark, frost, tears) are render-only particles (anatomy/eyeAura.ts). Every
 * one of those traits is read from the morph helix (src/genome/helix.ts), whose min/max gene pairs
 * also bound the animation (src/render/animator.ts).
 */
import * as THREE from "../lib/three.ts";
import type { Pose, Skeleton } from "../body/skeleton.ts";
import type { Phenotype } from "../genome/phenotype.ts";
import { type MorphHelix, P5_DEFAULTS } from "../genome/morphTypes.ts";
import type { LifePhase, Scar } from "../genome/lifeTypes.ts";
import { buildBody } from "./anatomy/body.ts";
import { buildFace, buildHead, buildJaw } from "./anatomy/face.ts";
import { addOutlines, ageTint, applyScars, makeOutlineMaterial, makeSkinMaterials, type ScarSet, type SkinMaterialsP5, swapMaterial, tickSkin } from "./anatomy/skin.ts";
import { buildCoat, type CoatParts } from "./anatomy/coat.ts";
import { EyeAura } from "./anatomy/eyeAura.ts";

type Mat = THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial;

export interface CreatureOptions {
  quality: "low" | "high";
  shadows: boolean;
  helix: MorphHelix;
  /** Pass 5: scars and life phase (g.life?.scars, lifePhase(g)); absent = no scars, adult. */
  life?: { scars: readonly Scar[]; phase: LifePhase };
}

export class CreatureView {
  readonly root = new THREE.Group();
  /** Tilt/squash container between the world placement and the skeleton. */
  readonly pivot = new THREE.Group();
  readonly joints: THREE.Object3D[] = [];
  readonly skin: Mat;
  readonly accent: Mat;
  readonly belly: Mat;
  readonly keratin: Mat;
  readonly membrane: Mat;
  readonly eyeMats: THREE.Material[] = [];
  readonly aura: EyeAura | null = null;
  wingSurfaces: THREE.Mesh[] = [];
  private textures: THREE.Texture[] = [];
  private extraMats: THREE.Material[] = [];
  private baseEmissive: number;
  private pupils: THREE.Object3D[] = [];
  private lids: THREE.Object3D[] = [];
  private headObj: THREE.Object3D | null = null;
  private rimBase = 0;
  private blinkT = 2 + Math.random() * 3;
  private blink = 0;
  private ko = 0;
  private bodyTris = 0;
  private mats: SkinMaterialsP5;
  private coat: CoatParts | null = null;
  private scars: ScarSet | null = null;
  private ink: THREE.MeshBasicMaterial | null = null;
  private skinTime = 0;
  /** Pass-5 animation: minimum lid closure (sleepy / asleep) and the pupils' gaze rotation [P5-A2]. */
  private lidFloor = 0;
  private gazeQ = new THREE.Quaternion();
  private gazeE = new THREE.Euler();

  constructor(readonly ph: Phenotype, readonly sk: Skeleton, seed: number, readonly o: CreatureOptions) {
    const m = makeSkinMaterials(ph, o.helix, seed, o.quality);
    this.mats = m;
    this.skin = m.skin;
    this.accent = m.accent;
    this.belly = m.belly;
    this.keratin = m.keratin;
    this.membrane = m.membrane;
    this.textures.push(...m.textures);
    this.baseEmissive = m.baseEmissive;
    const rim = this.skin.userData.rim as { strength: { value: number } } | undefined;
    this.rimBase = rim?.strength.value ?? 0;
    const seg = o.quality === "high" ? 16 : 9;
    const shadow = o.shadows;
    const add = (parent: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material) => {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = shadow;
      mesh.receiveShadow = false;
      parent.add(mesh);
      return mesh;
    };
    this.root.add(this.pivot);
    for (const j of sk.joints) {
      const obj = new THREE.Group();
      obj.name = j.id;
      obj.position.set(j.offset[0], j.offset[1], j.offset[2]);
      (j.parent < 0 ? this.pivot : this.joints[j.parent]).add(obj);
      this.joints.push(obj);
    }
    // Fused anatomy for every joint except the head and the jaw (the face builder owns those).
    const body = buildBody(ph, sk, o.helix, m, o.quality);
    this.bodyTris = body.triangles;
    this.extraMats.push(...(body.materials ?? []));
    body.perJoint.forEach((objs, i) => {
      for (const x of objs) {
        x.traverse((y) => {
          y.castShadow = shadow;
          y.receiveShadow = false;
        });
        this.joints[i].add(x);
      }
    });
    this.wingSurfaces = body.wings;
    // Pass 5 [P5-V7]: coat cards / shards / fur shells (high), frills, fire flames.
    // A minimal globe stays a globe [P6-C1]: no shards, leaves, feathers or frills on it.
    if (o.helix.p6?.complexity.tier !== "minimal") {
      this.coat = buildCoat(sk, ph, o.helix, m, o.quality, body.perJoint, { seed });
      this.coat.perJoint.forEach((objs, i) => {
        for (const x of objs) this.joints[i].add(x);
      });
    }
    // Head and jaw volumes (face.ts places eyes and teeth on exactly these ellipsoids), glowing tail tip.
    const tailEnds = new Set(sk.joints.filter((x, i) => x.role === "tail" && !sk.joints.some((c) => c.parent === i && c.role === "tail")).map((x) => x.id));
    sk.joints.forEach((j, i) => {
      const obj = this.joints[i];
      const dir = new THREE.Vector3(j.dir[0], j.dir[1], j.dir[2]);
      if (j.role === "head" || j.role === "jaw") {
        // Head surface with carved eye sockets + brow ridges, and the mouth-scaled jaw (face.ts owns both).
        const parts = j.role === "head" ? buildHead(j, ph, o.helix, m, o.quality) : buildJaw(j, o.helix, m, o.quality);
        for (const x of parts) {
          x.traverse((y) => {
            y.castShadow = shadow;
            y.receiveShadow = false;
          });
          obj.add(x);
        }
      } else if (tailEnds.has(j.id) && ph.glow > 0.35) {
        const mat = new THREE.MeshBasicMaterial({ color: ph.palette.glow });
        this.extraMats.push(mat);
        const tip = add(obj, new THREE.SphereGeometry(j.r1 * 2.2, seg, seg), mat);
        tip.position.copy(dir.clone().multiplyScalar(j.length));
      }
    });
    const hi = sk.joints.findIndex((j) => j.role === "head");
    if (hi >= 0) {
      const ji = sk.joints.findIndex((j) => j.role === "jaw" && j.parent === hi);
      const face = buildFace(sk.joints[hi], ji >= 0 ? sk.joints[ji] : undefined, ph, o.helix, m, o.quality);
      for (const x of face.head) this.joints[hi].add(x);
      if (ji >= 0) for (const x of face.jaw) this.joints[ji].add(x);
      this.pupils = face.pupils;
      this.lids = face.lids;
      this.eyeMats.push(...face.eyeMaterials);
      this.headObj = this.joints[hi];
      if (o.helix.eyes.aura !== "none" && face.auraEmitters.length > 0) {
        this.aura = new EyeAura(o.helix.eyes.aura, face.auraEmitters, o.helix.eyes.size * sk.joints[hi].r0, ph.palette.glow, o.quality);
      }
    }
    // Pass 6: second heads carry their own face (pupils, lids, eye materials) so they blink and look too.
    for (const obj of this.joints) {
      for (const x of obj.children) {
        const f = x.userData.face as { pupils: THREE.Object3D[]; lids: THREE.Object3D[]; eyeMaterials: THREE.Material[] } | undefined;
        if (f) {
          this.pupils.push(...f.pupils);
          this.lids.push(...f.lids);
          this.eyeMats.push(...f.eyeMaterials);
        }
      }
    }
    // Pass 5 [P5-V8]: scars on their own body part, elder tint; then the ink outline (budgeted).
    const jointSet = new Set<THREE.Object3D>(this.joints);
    if (o.life && o.life.scars.length > 0) {
      this.scars = applyScars(m, o.life.scars, sk);
      this.scars.byJoint.forEach((mat, i) => swapMaterial(this.joints[i], this.skin, mat, (x) => jointSet.has(x)));
    }
    if (o.life) ageTint(m, o.life.phase);
    this.ink = makeOutlineMaterial(ph, (o.helix.p5 ?? P5_DEFAULTS).skin, sk.height);
    if (this.ink) {
      const colossus = sk.plan6?.tier === "mythic" || sk.joints.length > 64;
      const cap = o.quality === "high" ? (colossus ? 58000 : 38000) : (colossus ? 19000 : 14000);
      const budget = Math.max(0, Math.min(o.quality === "high" ? 12000 : 3000, cap - this.triangles()));
      addOutlines([this.root], this.ink, budget, [this.keratin]);
    }
  }

  applyPose(pose: Pose): void {
    for (let i = 0; i < this.joints.length; i++) {
      const a = pose[this.sk.joints[i].id];
      if (a) this.joints[i].rotation.set(a[0], a[1], a[2]);
      else this.joints[i].rotation.set(0, 0, 0);
    }
  }

  /** Charge glow / element aura on the skin, eyes and rim, 0..1. */
  setCharge(k: number, color?: number): void {
    const map = this.skin.emissiveMap;
    const rest = typeof this.skin.userData.emissiveRest === "number" ? this.skin.userData.emissiveRest : map ? 0.9 : this.baseEmissive;
    this.skin.emissiveIntensity = rest + k * 0.9;
    this.accent.emissiveIntensity = this.baseEmissive * 0.6 + k * 1.2;
    if (color !== undefined) {
      this.accent.emissive.setHex(k > 0.05 ? color : this.ph.palette.glow);
      if (!map) this.skin.emissive.setHex(k > 0.05 ? color : this.ph.palette.glow);
    }
    for (const mat of this.eyeMats) {
      const b = mat.userData.glowBase;
      if (typeof b === "number") (mat as THREE.MeshStandardMaterial).emissiveIntensity = b * (1 + 1.5 * k);
    }
    const rim = this.skin.userData.rim as { strength: { value: number } } | undefined;
    if (rim) rim.strength.value = this.rimBase + 0.6 * k;
    this.aura?.setIntensity(1 + k);
    this.scars?.sync();
  }

  /** Emotion read on the eyes: fear widens pupils, anger narrows them. */
  setPupils(fear: number, anger: number): void {
    const s = Math.max(0.35, 0.75 + 0.6 * fear - 0.35 * anger);
    for (const p of this.pupils) p.scale.set(s, s, s * s);
  }

  /** Pupils follow the gaze: eye-space yaw (+ left) and pitch (+ down), radians, about +-0.3 [P5-A2]. */
  setGaze(yaw: number, pitch: number): void {
    this.gazeE.set(pitch * 0.8, yaw * 0.8, 0);
    this.gazeQ.setFromEuler(this.gazeE);
    for (const p of this.pupils) {
      const base = (p.userData.basePos ??= p.position.clone()) as THREE.Vector3;
      const bq = (p.userData.baseQuat ??= p.quaternion.clone()) as THREE.Quaternion;
      p.position.copy(base).applyQuaternion(this.gazeQ);
      p.quaternion.copy(this.gazeQ).multiply(bq);
    }
  }

  /** Minimum lid closure 0..1 (sleepy / asleep); blinks still close fully on top [P5-A2]. */
  setLids(minClosed: number): void {
    this.lidFloor = Math.max(0, Math.min(1, minClosed));
  }

  setTint(frozen: boolean, ko: number): void {
    this.skin.color.setHex(frozen ? 0x9fdcff : 0xffffff);
    if (this.mats.limbs !== this.skin) this.mats.limbs.color.setHex(frozen ? 0x9fdcff : 0xffffff);
    const op = 1 - this.ph.translucency * 0.55;
    for (const m of [this.skin, this.accent, this.belly, this.mats.limbs]) {
      m.transparent = m.transparent || ko > 0;
      m.opacity = op * (1 - ko * 0.75);
    }
    this.ko = ko;
    this.scars?.sync();
    if (this.ink) this.ink.visible = ko < 0.3;
  }

  /** Per-frame cosmetics: blinks + eye aura (render-only randomness). Called by the views. */
  tick(dt: number): void {
    this.skinTime += dt;
    tickSkin(this.mats, this.skinTime);
    this.blinkT -= dt;
    if (this.blinkT <= 0) {
      this.blink += dt / 0.14;
      if (this.blink >= 2) {
        this.blink = 0;
        this.blinkT = 2.5 + Math.random() * 4;
      }
    }
    const c = this.ko > 0.5 ? 1 : Math.max(this.lidFloor, this.blink <= 0 ? 0 : 1 - Math.abs(1 - this.blink));
    for (const l of this.lids) l.rotation.x = l.userData.open + (l.userData.closed - l.userData.open) * c;
    if (this.aura && this.headObj) {
      let scene: THREE.Object3D = this.root;
      while (scene.parent) scene = scene.parent;
      if (scene !== this.root && this.aura.points.parent !== scene) scene.add(this.aura.points);
      this.aura.points.visible = this.root.visible;
      this.aura.update(dt, this.headObj.matrixWorld);
    }
  }

  triangles(): number {
    let n = 0;
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        const g = m.geometry;
        n += (g.index ? g.index.count : g.attributes.position.count) / 3;
      }
    });
    return Math.round(n);
  }

  /** Triangle count of the fused anatomy alone (measured by the builder). */
  bodyTriangles(): number {
    return this.bodyTris;
  }

  dispose(): void {
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.geometry.dispose();
    });
    for (const m of new Set<THREE.Material>([this.skin, this.accent, this.belly, this.keratin, this.membrane, this.mats.limbs, this.mats.detail, ...this.eyeMats, ...this.extraMats])) m.dispose();
    this.coat?.dispose();
    this.scars?.dispose();
    this.ink?.dispose();
    for (const t of this.textures) t.dispose();
    this.aura?.points.removeFromParent();
    this.aura?.dispose();
    this.root.removeFromParent();
  }
}
