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
import type { MorphHelix } from "../genome/morphTypes.ts";
import { buildBody } from "./anatomy/body.ts";
import { buildFace } from "./anatomy/face.ts";
import { makeSkinMaterials } from "./anatomy/skin.ts";
import { EyeAura } from "./anatomy/eyeAura.ts";

type Mat = THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial;

export interface CreatureOptions {
  quality: "low" | "high";
  shadows: boolean;
  helix: MorphHelix;
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

  constructor(readonly ph: Phenotype, readonly sk: Skeleton, seed: number, readonly o: CreatureOptions) {
    const m = makeSkinMaterials(ph, o.helix, seed, o.quality);
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
    // Head and jaw volumes (face.ts places eyes and teeth on exactly these ellipsoids), glowing tail tip.
    const lastTail = `tail${sk.joints.filter((x) => x.role === "tail").length - 1}`;
    sk.joints.forEach((j, i) => {
      const obj = this.joints[i];
      const dir = new THREE.Vector3(j.dir[0], j.dir[1], j.dir[2]);
      const mid = dir.clone().multiplyScalar(j.length / 2);
      const qz = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
      if (j.role === "head") {
        const r = j.r0;
        const head = add(obj, new THREE.SphereGeometry(1, seg * 2, seg), this.skin);
        head.position.copy(mid).multiplyScalar(0.9);
        head.quaternion.copy(qz);
        head.scale.set(r, r * 0.95, j.length * 0.62);
      } else if (j.role === "jaw") {
        const jaw = add(obj, new THREE.SphereGeometry(1, seg, seg), this.belly);
        jaw.position.copy(mid);
        jaw.quaternion.copy(qz);
        jaw.scale.set(j.r0 * 1.05, j.r0 * 0.5, j.length / 2);
      } else if (j.id === lastTail && ph.glow > 0.35) {
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
    this.skin.emissiveIntensity = (map ? 0.9 : this.baseEmissive) + k * 0.9;
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
  }

  /** Emotion read on the eyes: fear widens pupils, anger narrows them. */
  setPupils(fear: number, anger: number): void {
    const s = Math.max(0.35, 0.75 + 0.6 * fear - 0.35 * anger);
    for (const p of this.pupils) p.scale.set(s, s, s * s);
  }

  setTint(frozen: boolean, ko: number): void {
    this.skin.color.setHex(frozen ? 0x9fdcff : 0xffffff);
    const op = 1 - this.ph.translucency * 0.55;
    for (const m of [this.skin, this.accent, this.belly]) {
      m.transparent = m.transparent || ko > 0;
      m.opacity = op * (1 - ko * 0.75);
    }
    this.ko = ko;
  }

  /** Per-frame cosmetics: blinks + eye aura (render-only randomness). Called by the views. */
  tick(dt: number): void {
    this.blinkT -= dt;
    if (this.blinkT <= 0) {
      this.blink += dt / 0.14;
      if (this.blink >= 2) {
        this.blink = 0;
        this.blinkT = 2.5 + Math.random() * 4;
      }
    }
    const c = this.ko > 0.5 ? 1 : this.blink <= 0 ? 0 : 1 - Math.abs(1 - this.blink);
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
    for (const m of [this.skin, this.accent, this.belly, this.keratin, this.membrane, ...this.eyeMats, ...this.extraMats]) m.dispose();
    for (const t of this.textures) t.dispose();
    this.aura?.points.removeFromParent();
    this.aura?.dispose();
    this.root.removeFromParent();
  }
}
