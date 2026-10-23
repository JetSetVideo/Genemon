/**
 * GenospaceView: a population of Genemon plotted in a 3-axis sub-space of the 26 opposite-pole axes
 * (e.g. heat x moisture x luminance), coloured by primary element and sized by size class. Owned
 * Genemon are ringed. This is the "multidimensional spaces populated with Genemon" made visible;
 * the Data screen offers the axis choice and a PCA projection.
 */
import * as THREE from "../lib/three.ts";
import { AXIS_BY_ID, type AxisId } from "../data/axes.ts";
import { ELEMENTS } from "../data/elements.ts";
import type { Phenotype } from "../genome/phenotype.ts";
import { textSprite } from "./textures.ts";
import type { Stage, View } from "./stage.ts";

export interface GenoPoint {
  id: string;
  name: string;
  ph: Phenotype;
  owned: boolean;
  /** Optional precomputed coordinates (e.g. PCA) in [-1, 1]. */
  coords?: [number, number, number];
}

const SIZE_SCALE = { XS: 0.6, S: 0.8, M: 1, L: 1.3, XL: 1.6, XXL: 2 } as const;

export class GenospaceView implements View {
  private group = new THREE.Group();
  private mesh: THREE.InstancedMesh;
  private rings: THREE.Group = new THREE.Group();
  private ray = new THREE.Raycaster();
  readonly scale = 6;
  hovered: GenoPoint | null = null;

  constructor(private stage: Stage, readonly points: GenoPoint[], readonly axes: [AxisId, AxisId, AxisId] | "pca", dark: boolean) {
    const s = stage.scene;
    s.background = new THREE.Color(dark ? 0x070a10 : 0xf3f5f8);
    s.fog = null;
    const S = this.scale;
    const box = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(S * 2, S * 2, S * 2)), new THREE.LineBasicMaterial({ color: dark ? 0x2a3550 : 0xb8c2d0 }));
    this.group.add(box);
    const axisColors = [0xff5a5f, 0x3ddc84, 0x4c9aff];
    for (let a = 0; a < 3; a++) {
      const dir = new THREE.Vector3(a === 0 ? 1 : 0, a === 1 ? 1 : 0, a === 2 ? 1 : 0);
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([dir.clone().multiplyScalar(-S), dir.clone().multiplyScalar(S)]), new THREE.LineBasicMaterial({ color: axisColors[a] }));
      this.group.add(line);
      const id = axes === "pca" ? null : axes[a];
      const neg = id ? AXIS_BY_ID[id].neg : `PC${a + 1} -`;
      const pos = id ? AXIS_BY_ID[id].pos : `PC${a + 1} +`;
      const ln = textSprite(neg, "#" + axisColors[a].toString(16)), lp = textSprite(pos, "#" + axisColors[a].toString(16));
      ln.position.copy(dir.clone().multiplyScalar(-S - 0.8));
      lp.position.copy(dir.clone().multiplyScalar(S + 0.8));
      this.group.add(ln, lp);
    }
    this.mesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.12, 12, 8), new THREE.MeshStandardMaterial({ roughness: 0.4 }), points.length);
    const m = new THREE.Matrix4(), c = new THREE.Color();
    points.forEach((p, i) => {
      const v = this.coords(p);
      m.compose(v, new THREE.Quaternion(), new THREE.Vector3().setScalar(SIZE_SCALE[p.ph.sizeClass]));
      this.mesh.setMatrixAt(i, m);
      this.mesh.setColorAt(i, c.setHex(ELEMENTS[p.ph.elements.primary].color));
      if (p.owned) {
        const r = new THREE.Mesh(new THREE.TorusGeometry(0.22 * SIZE_SCALE[p.ph.sizeClass], 0.025, 6, 24), new THREE.MeshBasicMaterial({ color: dark ? 0xffffff : 0x111111 }));
        r.position.copy(v);
        this.rings.add(r);
      }
    });
    this.group.add(this.mesh, this.rings, new THREE.HemisphereLight(0xffffff, 0x223344, 1.4));
    const dl = new THREE.DirectionalLight(0xffffff, 1.5);
    dl.position.set(5, 8, 4);
    this.group.add(dl);
    s.add(this.group);
    stage.camera.position.set(S * 2.1, S * 1.4, S * 2.4);
    stage.controls.target.set(0, 0, 0);
    stage.controls.enabled = true;
    stage.controls.update();
  }

  private coords(p: GenoPoint): THREE.Vector3 {
    const S = this.scale;
    if (p.coords) return new THREE.Vector3(p.coords[0] * S, p.coords[1] * S, p.coords[2] * S);
    const [a, b, c] = this.axes as [AxisId, AxisId, AxisId];
    return new THREE.Vector3(p.ph.axes[a] * S, p.ph.axes[b] * S, p.ph.axes[c] * S);
  }

  /** Pick the Genemon under a normalised device coordinate (for hover cards). */
  pick(ndcX: number, ndcY: number): GenoPoint | null {
    this.ray.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.stage.camera);
    const hit = this.ray.intersectObject(this.mesh)[0];
    this.hovered = hit?.instanceId !== undefined ? this.points[hit.instanceId] : null;
    return this.hovered;
  }

  update(dt: number): void {
    this.group.rotation.y += dt * 0.05;
    for (const r of this.rings.children) r.lookAt(this.stage.camera.position);
  }

  snapshot(): Record<string, unknown> {
    return { points: this.points.length, owned: this.points.filter((p) => p.owned).length, axes: this.axes };
  }

  dispose(): void {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
    });
    this.group.removeFromParent();
    this.stage.scene.background = null;
    this.stage.controls.enabled = false;
  }
}
