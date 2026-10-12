/**
 * CreatureView: the 3D model of a Genemon, built FROM ITS SKELETON. One Object3D per joint (same
 * offsets/order as src/body/skeleton.ts) so a constrained Pose maps 1:1 onto rotations. Bones are
 * tapered capsules with socket spheres; torsos and heads are ellipsoids so segments blend into one
 * body; wings are membranes; horns, ears, spikes, fangs and eyes come from plan genes. Materials
 * carry density/elasticity cues: roughness, metalness (metal affinity), translucency (gas/void),
 * emissive glow (fire/electric/light...).
 */
import * as THREE from "../lib/three.ts";
import type { Pose, Skeleton } from "../body/skeleton.ts";
import type { Phenotype } from "../genome/phenotype.ts";
import { skinTextures } from "./textures.ts";
import { Rng } from "../core/rng.ts";

const UP = new THREE.Vector3(0, 1, 0);

export interface CreatureOptions {
  quality: "low" | "high";
  shadows: boolean;
}

export class CreatureView {
  readonly root = new THREE.Group();
  /** Tilt/squash container between the world placement and the skeleton. */
  readonly pivot = new THREE.Group();
  readonly joints: THREE.Object3D[] = [];
  readonly skin: THREE.MeshStandardMaterial;
  readonly accent: THREE.MeshStandardMaterial;
  readonly belly: THREE.MeshStandardMaterial;
  readonly eyeMats: THREE.MeshStandardMaterial[] = [];
  private textures: THREE.Texture[] = [];
  private baseEmissive: number;
  private pupils: THREE.Mesh[] = [];

  constructor(readonly ph: Phenotype, readonly sk: Skeleton, seed: number, o: CreatureOptions = { quality: "high", shadows: true }) {
    const rng = new Rng(seed);
    const tex = skinTextures(ph, seed, o.quality === "high" ? 256 : 128);
    this.textures.push(tex.map);
    if (tex.emissive) this.textures.push(tex.emissive);
    const metal = Math.max(0, ph.elements.affinity.metal);
    const transparent = ph.translucency > 0.05;
    this.baseEmissive = ph.glow * 0.45;
    this.skin = new THREE.MeshStandardMaterial({
      map: tex.map,
      roughness: ph.roughness,
      metalness: metal > 0.35 ? 0.55 : 0.04,
      emissive: new THREE.Color(ph.palette.glow),
      emissiveMap: tex.emissive ?? null,
      emissiveIntensity: tex.emissive ? 0.9 : this.baseEmissive,
      transparent,
      opacity: 1 - ph.translucency * 0.55,
    });
    this.accent = new THREE.MeshStandardMaterial({
      color: ph.palette.accent,
      roughness: Math.max(0.2, ph.roughness - 0.2),
      metalness: metal > 0.35 ? 0.7 : 0.1,
      emissive: new THREE.Color(ph.palette.glow),
      emissiveIntensity: this.baseEmissive * 0.6,
      transparent,
      opacity: 1 - ph.translucency * 0.4,
      side: THREE.DoubleSide,
    });
    this.belly = new THREE.MeshStandardMaterial({ color: ph.palette.belly, roughness: 0.8, transparent, opacity: 1 - ph.translucency * 0.5 });
    const seg = o.quality === "high" ? 14 : 8;
    const shadow = o.shadows;
    const add = (parent: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material) => {
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = shadow;
      m.receiveShadow = false;
      parent.add(m);
      return m;
    };
    this.root.add(this.pivot);
    const H = sk.height;
    for (const j of sk.joints) {
      const obj = new THREE.Group();
      obj.name = j.id;
      obj.position.set(j.offset[0], j.offset[1], j.offset[2]);
      (j.parent < 0 ? this.pivot : this.joints[j.parent]).add(obj);
      this.joints.push(obj);
      const dir = new THREE.Vector3(j.dir[0], j.dir[1], j.dir[2]);
      const mid = dir.clone().multiplyScalar(j.length / 2);
      const q = new THREE.Quaternion().setFromUnitVectors(UP, dir);
      const qz = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
      switch (j.role) {
        case "root":
        case "spine":
        case "chest":
        case "segment": {
          if (sk.kind === "blob" && j.role === "root") {
            const m = add(obj, new THREE.SphereGeometry(j.r0, seg * 2, seg), this.skin);
            m.position.copy(mid).multiplyScalar(0.2);
            m.scale.set(1, 0.92, 1);
            break;
          }
          const m = add(obj, new THREE.SphereGeometry(1, seg * 2, seg), this.skin);
          m.position.copy(mid);
          m.quaternion.copy(qz);
          const rr = Math.max(j.r0, j.r1);
          m.scale.set(rr, rr * 1.05, j.length / 2 + rr * 0.55);
          if (ph.plan.spikes > 0.55 && j.role !== "segment") this.spikes(obj, dir, j.length, rr, Math.round(ph.plan.spikes * 3), seg);
          break;
        }
        case "head": {
          const r = j.r0;
          const head = add(obj, new THREE.SphereGeometry(1, seg * 2, seg), this.skin);
          head.position.copy(mid).multiplyScalar(0.9);
          head.quaternion.copy(qz);
          head.scale.set(r, r * 0.95, j.length * 0.62);
          this.eyes(obj, dir, j.length, r, seg, rng);
          break;
        }
        case "jaw": {
          const m = add(obj, new THREE.SphereGeometry(1, seg, seg), this.belly);
          m.position.copy(mid);
          m.quaternion.copy(qz);
          m.scale.set(j.r0 * 1.05, j.r0 * 0.5, j.length / 2);
          if (ph.axes.temper > 0.2 || ph.plan.jaw > 0.6) {
            const fang = new THREE.ConeGeometry(j.r0 * 0.16, j.r0 * 0.6, 6);
            for (const s of [-1, 1]) {
              const f = add(obj, fang, new THREE.MeshStandardMaterial({ color: 0xf6f1e4, roughness: 0.4 }));
              f.position.copy(dir.clone().multiplyScalar(j.length * 0.85)).add(new THREE.Vector3(s * j.r0 * 0.45, j.r0 * 0.35, 0));
            }
          }
          break;
        }
        case "horn": {
          const m = add(obj, new THREE.ConeGeometry(j.r0, j.length, seg), this.accent);
          m.position.copy(mid);
          m.quaternion.copy(q);
          break;
        }
        case "ear": {
          const m = add(obj, new THREE.ConeGeometry(j.r0, j.length, 4), this.skin);
          m.position.copy(mid);
          m.quaternion.copy(q);
          m.scale.set(1, 1, 0.35);
          break;
        }
        case "wingRoot":
        case "wingMid":
        case "wingTip": {
          this.capsule(obj, j.r0, j.r1, j.length, dir, q, mid, seg, add);
          // Membrane: a quad hinged on the bone, trailing BACKWARD from it (t = side * up x dir), so it
          // folds and flaps with the bone instead of standing out as a flat horizontal plate.
          const t = new THREE.Vector3().crossVectors(UP, dir).normalize().multiplyScalar(j.side || 1);
          const chord = { wingRoot: [0.5, 0.38], wingMid: [0.38, 0.25], wingTip: [0.25, 0.05] }[j.role as "wingRoot" | "wingMid" | "wingTip"];
          const a = new THREE.Vector3(), b = dir.clone().multiplyScalar(j.length);
          const c = b.clone().addScaledVector(t, H * chord[1]), d = a.clone().addScaledVector(t, H * chord[0]);
          const mem = new THREE.BufferGeometry().setFromPoints([a, b, c, a, c, d]);
          mem.computeVertexNormals();
          add(obj, mem, this.accent);
          break;
        }
        case "ankle": {
          const m = add(obj, new THREE.SphereGeometry(1, seg, seg / 2), this.belly);
          m.position.copy(mid);
          m.quaternion.copy(qz);
          m.scale.set(j.r0 * 1.25, j.r0 * 0.7, j.length / 2 + j.r0 * 0.5);
          break;
        }
        default:
          this.capsule(obj, j.r0, j.r1, j.length, dir, q, mid, seg, add);
          if (j.role === "tail" && j.id === `tail${sk.joints.filter((x) => x.role === "tail").length - 1}` && ph.glow > 0.35) {
            const tip = add(obj, new THREE.SphereGeometry(j.r1 * 2.2, seg, seg), new THREE.MeshBasicMaterial({ color: ph.palette.glow }));
            tip.position.copy(dir.clone().multiplyScalar(j.length));
          }
      }
    }
  }

  private capsule(obj: THREE.Object3D, r0: number, r1: number, len: number, dir: THREE.Vector3, q: THREE.Quaternion, mid: THREE.Vector3, seg: number, add: (p: THREE.Object3D, g: THREE.BufferGeometry, m: THREE.Material) => THREE.Mesh) {
    const cyl = add(obj, new THREE.CylinderGeometry(r1, r0, len, seg, 1, true), this.skin);
    cyl.position.copy(mid);
    cyl.quaternion.copy(q);
    add(obj, new THREE.SphereGeometry(r0 * 1.04, seg, seg / 2), this.skin);
    const end = add(obj, new THREE.SphereGeometry(r1, seg, seg / 2), this.skin);
    end.position.copy(dir.clone().multiplyScalar(len));
  }

  private spikes(obj: THREE.Object3D, dir: THREE.Vector3, len: number, r: number, n: number, seg: number) {
    const geo = new THREE.ConeGeometry(r * 0.18, r * 0.7, Math.max(4, seg / 2));
    for (let i = 0; i < n; i++) {
      const m = new THREE.Mesh(geo, this.accent);
      m.position.copy(dir.clone().multiplyScalar(len * (0.25 + 0.5 * (i / Math.max(1, n - 1))))).add(new THREE.Vector3(0, r * 1.0, 0));
      m.castShadow = true;
      obj.add(m);
    }
  }

  private eyes(obj: THREE.Object3D, dir: THREE.Vector3, len: number, r: number, seg: number, rng: Rng) {
    const ph = this.ph;
    const er = r * (0.2 + 0.18 * ph.plan.eyes);
    const iris = new THREE.MeshStandardMaterial({ color: ph.palette.eye, roughness: 0.25, emissive: new THREE.Color(ph.palette.eye), emissiveIntensity: ph.axes.luminance < -0.3 ? 0.6 : 0.08 });
    const white = new THREE.MeshStandardMaterial({ color: 0xf8f8f2, roughness: 0.3 });
    const pupil = new THREE.MeshBasicMaterial({ color: 0x0b0b10 });
    this.eyeMats.push(iris, white);
    const side = new THREE.Vector3(1, 0, 0);
    const fwd = dir.clone().normalize();
    // "Up" on the face = world up made orthogonal to the head axis. The old cross product pointed DOWN
    // for a forward-facing head (+Z x +X = +Y, then negated), which put the eyes in the lower half of
    // the head, mostly buried (round-1 artist review). A head pointing straight up has no such
    // component: its face looks forward (+Z) instead.
    const up = UP.clone().sub(fwd.clone().multiplyScalar(UP.dot(fwd)));
    if (up.lengthSq() < 1e-4) up.set(0, 0, 1);
    else up.normalize();
    const positions: THREE.Vector3[] = [];
    for (const s of [-1, 1]) positions.push(fwd.clone().multiplyScalar(len * 0.62).add(side.clone().multiplyScalar(s * r * 0.55)).add(up.clone().multiplyScalar(r * 0.38)));
    if (ph.plan.eyes > 0.88 || rng.chance(ph.plan.eyes > 0.75 ? 0.3 : 0)) positions.push(fwd.clone().multiplyScalar(len * 0.55).add(up.clone().multiplyScalar(r * 0.75)));
    for (const p of positions) {
      const w = new THREE.Mesh(new THREE.SphereGeometry(er, seg, seg / 2), white);
      w.position.copy(p);
      obj.add(w);
      const i = new THREE.Mesh(new THREE.SphereGeometry(er * 0.62, seg, seg / 2), iris);
      i.position.copy(p).add(fwd.clone().multiplyScalar(er * 0.5));
      obj.add(i);
      const pu = new THREE.Mesh(new THREE.SphereGeometry(er * 0.32, 8, 6), pupil);
      pu.position.copy(p).add(fwd.clone().multiplyScalar(er * 0.82));
      obj.add(pu);
      this.pupils.push(pu);
    }
  }

  applyPose(pose: Pose): void {
    for (let i = 0; i < this.joints.length; i++) {
      const a = pose[this.sk.joints[i].id];
      if (a) this.joints[i].rotation.set(a[0], a[1], a[2]);
      else this.joints[i].rotation.set(0, 0, 0);
    }
  }

  /** Charge glow / element aura on the skin, 0..1. */
  setCharge(k: number, color?: number): void {
    this.skin.emissiveIntensity = (this.skin.emissiveMap ? 0.9 : this.baseEmissive) + k * 0.9;
    this.accent.emissiveIntensity = this.baseEmissive * 0.6 + k * 1.2;
    if (color !== undefined) {
      this.accent.emissive.setHex(k > 0.05 ? color : this.ph.palette.glow);
      if (!this.skin.emissiveMap) this.skin.emissive.setHex(k > 0.05 ? color : this.ph.palette.glow);
    }
  }

  /** Emotion read on the eyes: fear widens pupils, anger narrows them. */
  setPupils(fear: number, anger: number): void {
    const s = 0.75 + 0.6 * fear - 0.35 * anger;
    for (const p of this.pupils) p.scale.setScalar(Math.max(0.35, s));
  }

  setTint(frozen: boolean, ko: number): void {
    const t = frozen ? 0x9fdcff : 0xffffff;
    this.skin.color.setHex(t);
    const op = 1 - this.ph.translucency * 0.55;
    for (const m of [this.skin, this.accent, this.belly]) {
      m.transparent = m.transparent || ko > 0;
      m.opacity = op * (1 - ko * 0.75);
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

  dispose(): void {
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.geometry.dispose();
    });
    for (const m of [this.skin, this.accent, this.belly, ...this.eyeMats]) m.dispose();
    for (const t of this.textures) t.dispose();
    this.root.removeFromParent();
  }
}
