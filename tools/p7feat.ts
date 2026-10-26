// deno-lint-ignore-file no-explicit-any
/**
 * Pass-7 feature magnitude probe [P7-G1]: for the showcase creatures (tools/p7showcase.ts, real seeds), build the
 * body twice - with the creature's own p7 genes and with ONE feature neutralised (P7_DEFAULTS value) - and report
 * what that feature adds: triangles, and the largest vertex displacement as a share of body height (same topology)
 * or the bounding-box growth. Answers "is the feature there, and is it big enough to see?" without a camera.
 *   deno run --allow-read tools/p7feat.ts
 */
import * as THREE from "../src/lib/three.ts";
import { phenotypeOf } from "../src/genome/genemon.ts";
import { buildSkeleton, skeletonGenes } from "../src/body/skeleton.ts";
import { helixOf } from "../src/genome/helix.ts";
import { buildBody } from "../src/render/anatomy/body.ts";
import { P7_DEFAULTS } from "../src/genome/p7Types.ts";
import type { MorphHelix } from "../src/genome/morphTypes.ts";

const m = () => new THREE.MeshStandardMaterial();
const MATS: any = { skin: m(), accent: m(), belly: m(), keratin: m(), membrane: m(), textures: [], baseEmissive: 0 };
const items = JSON.parse(await Deno.readTextFile("artifacts/tmp/p6showcase.json"));

function geo(ph: any, sk: any, h: MorphHelix) {
  const b = buildBody(ph, sk, h, MATS, "high");
  const pos: number[][] = [];
  let tris = 0;
  const box = new THREE.Box3();
  b.perJoint.forEach((objs: any[], j: number) => objs.forEach((o: any) => o.traverse((x: any) => {
    if (!x.isMesh) return;
    const a = x.geometry.getAttribute("position");
    tris += x.geometry.index ? x.geometry.index.count / 3 : a.count / 3;
    const arr: number[] = [];
    for (let i = 0; i < a.count * 3; i++) arr.push(a.array[i]);
    pos.push([j, ...arr]);
    x.geometry.computeBoundingBox();
    const bb = x.geometry.boundingBox.clone().translate(new THREE.Vector3(...sk.joints[j].rest ?? [0, 0, 0]));
    box.union(bb);
  })));
  return { pos, tris, size: box.getSize(new THREE.Vector3()) };
}

const FEATURES: [string, (p: any) => void][] = [
  ["ridges", (p) => (p.relief.ridges = 0)],
  ["flutes", (p) => (p.relief.flutes = 0)],
  ["segments", (p) => (p.relief.segments = 0)],
  ["knobs", (p) => (p.relief.knobs = 0)],
  ["facets", (p) => (p.relief.facets = 0)],
  ["horn pairs", (p) => (p.horns.pairs = Math.min(p.horns.pairs, 1))],
  ["horn branch", (p) => (p.horns.branch = 0)],
  ["horn curl", (p) => (p.horns.curl = 0)],
  ["spike rows", (p) => (p.spikes.rows = Math.min(p.spikes.rows, 1))],
  ["spike length", (p) => (p.spikes.length = 1)],
  ["extra ops", (p) => (p.ops = [])],
];

for (const it of items) {
  const g = it.g, ph = phenotypeOf(g), h = helixOf(g.genome, ph);
  const sk = buildSkeleton(ph, skeletonGenes(h));
  const full = geo(ph, sk, h);
  const H = sk.height;
  const rows: string[] = [];
  for (const [name, off] of FEATURES) {
    const p7 = structuredClone(h.p7 ?? P7_DEFAULTS);
    const before = JSON.stringify(p7);
    off(p7);
    if (JSON.stringify(p7) === before) continue;
    const base = geo(ph, sk, { ...h, p7 });
    let disp = 0, same = full.pos.length === base.pos.length;
    if (same) {
      for (let k = 0; k < full.pos.length && same; k++) {
        const a = full.pos[k], b = base.pos[k];
        if (a.length !== b.length) { same = false; break; }
        for (let i = 1; i < a.length; i += 3) disp = Math.max(disp, Math.hypot(a[i] - b[i], a[i + 1] - b[i + 1], a[i + 2] - b[i + 2]));
      }
    }
    const grow = Math.max(full.size.x - base.size.x, full.size.y - base.size.y, full.size.z - base.size.z);
    rows.push(`${name}: +${full.tris - base.tris} tris, ${same ? `max displacement ${(100 * disp / H).toFixed(1)} % of height` : `topology changed, bbox +${(100 * grow / H).toFixed(1)} % of height`}`);
  }
  console.log(`${it.label.padEnd(14)} (H ${H.toFixed(2)} m, ${full.tris} tris) ${rows.join(" | ") || "no p7 feature"}`);
}
