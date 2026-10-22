// Anatomy lane (pass 4, P4-V1/P4-V3): loft geometry, body/limb/wing builders and hit spheres, headless.
import * as THREE from "../src/lib/three.ts";
import { assert, assertAlmostEquals, assertEquals } from "./_assert.ts";
import { BODY_KINDS, type BodyKind, randomGenome } from "../src/genome/genome.ts";
import { express, type Phenotype } from "../src/genome/phenotype.ts";
import { emptyConditions } from "../src/genome/epigenetics.ts";
import { buildSkeleton, type Skeleton } from "../src/body/skeleton.ts";
import { helixOf } from "../src/genome/helix.ts";
import type { MorphHelix } from "../src/genome/morphTypes.ts";
import type { SkinMaterials } from "../src/render/anatomy/types.ts";
import { clampExponent, loftGeometry, loftRings, boneRings, maxRingTurn, safeSection, sectionRing, type Station } from "../src/render/anatomy/loft.ts";
import { buildBody } from "../src/render/anatomy/body.ts";
import { buildDigits } from "../src/render/anatomy/limbs.ts";
import { hitHeight, hitRadiusXZ, hitSpheres, restPositions } from "../src/render/anatomy/hitbox.ts";

function mats(): SkinMaterials {
  const m = () => new THREE.MeshStandardMaterial();
  return { skin: m(), accent: m(), belly: m(), keratin: m(), membrane: m(), textures: [], baseEmissive: 0 };
}

function helix(over: Partial<MorphHelix> = {}): MorphHelix {
  const bt = { lo: 0.2, hi: 0.8, value: 0.5 };
  return {
    version: 1,
    asymmetry: 0,
    asymmetricSide: 1,
    asymmetricParts: [],
    fractalDepth: 2,
    digits: 4,
    clawLength: 0.5,
    eyes: { style: "round", pupil: "full", size: 0.3, count: 2, irisColor: 0x3366ff, scleraColor: 0xffffff, glow: 0, aura: "none", lidAngle: 0 },
    mouth: { width: 0.6, teeth: "fangs", teethCount: 4, toothLength: 0.2, tongue: false },
    wings: { kind: "membrane", span: 2.4, fingers: 4, detail: 0.8 },
    surface: { bump: 0.5, patternScale: 1, patternContrast: 0.5, plates: 0.3, sheen: 0.3, fur: 0.2 },
    fusion: 0.7,
    angularity: 0.4,
    anim: { breath: bt, gait: bt, tail: bt, wingFlap: bt, headBob: bt, windup: bt, strike: bt, recoil: bt, squash: bt },
    ...over,
  };
}

function creature(kind: BodyKind, seed = 7, plan: Record<string, number> = {}): { ph: Phenotype; sk: Skeleton; g: ReturnType<typeof randomGenome> } {
  const g = randomGenome(seed, undefined, { kind, plan });
  const ph = express(g, emptyConditions());
  return { ph, sk: buildSkeleton(ph), g };
}

/** Edges used by exactly one triangle after welding coincident positions (0 = closed surface). */
function boundaryEdges(geo: THREE.BufferGeometry): number {
  const P = geo.getAttribute("position");
  const key = (i: number) => `${P.getX(i).toFixed(5)},${P.getY(i).toFixed(5)},${P.getZ(i).toFixed(5)}`;
  const weld = new Map<string, number>();
  const id: number[] = [];
  for (let i = 0; i < P.count; i++) {
    const k = key(i);
    if (!weld.has(k)) weld.set(k, weld.size);
    id.push(weld.get(k)!);
  }
  const I = geo.index!;
  const edges = new Map<string, number>();
  for (let t = 0; t < I.count; t += 3) {
    const v = [id[I.getX(t)], id[I.getX(t + 1)], id[I.getX(t + 2)]];
    if (v[0] === v[1] || v[1] === v[2] || v[0] === v[2]) continue;
    for (let e = 0; e < 3; e++) {
      const a = v[e], b = v[(e + 1) % 3];
      const k = a < b ? `${a}-${b}` : `${b}-${a}`;
      edges.set(k, (edges.get(k) ?? 0) + 1);
    }
  }
  let open = 0;
  for (const c of edges.values()) if (c === 1) open++;
  return open;
}

/** Connected components of the triangles in [start, start+count) (positions welded). */
function components(geo: THREE.BufferGeometry, start: number, count: number): number {
  const P = geo.getAttribute("position");
  const weld = new Map<string, number>();
  const id = (i: number) => {
    const k = `${P.getX(i).toFixed(5)},${P.getY(i).toFixed(5)},${P.getZ(i).toFixed(5)}`;
    if (!weld.has(k)) weld.set(k, weld.size);
    return weld.get(k)!;
  };
  const parent: number[] = [];
  const find = (x: number): number => (parent[x] === undefined ? (parent[x] = x) : parent[x] === x ? x : (parent[x] = find(parent[x])));
  const used = new Set<number>();
  const I = geo.index!;
  for (let t = start; t < start + count; t += 3) {
    const a = id(I.getX(t)), b = id(I.getX(t + 1)), c = id(I.getX(t + 2));
    used.add(a).add(b).add(c);
    parent[find(a)] = find(b);
    parent[find(b)] = find(c);
  }
  return new Set([...used].map(find)).size;
}

function finiteAttr(geo: THREE.BufferGeometry, name: string): boolean {
  const a = geo.getAttribute(name);
  if (!a) return false;
  for (let i = 0; i < a.count * a.itemSize; i++) if (!Number.isFinite((a.array as ArrayLike<number>)[i])) return false;
  return true;
}

const lobed = (exp: number): Station[] =>
  [0, 0.3, 0.6, 1].map((z, i) => ({
    z,
    rx: 0.3 + 0.05 * i,
    ry: 0.28,
    exp,
    lobes: [{ angle: Math.PI / 2, amp: -0.05, sharp: 8 }, { angle: -Math.PI / 2, amp: 0.15, sharp: 2.2 }, { angle: 0.8, amp: 0.07, sharp: 6 }, { angle: Math.PI - 0.8, amp: 0.07, sharp: 6 }],
  }));

Deno.test("loft: dome caps close the surface, normals finite and outward, UVs present", () => {
  for (const exp of [1.75, 2, 2.45]) {
    const geo = loftGeometry(lobed(exp), 20, true);
    assert(geo.index !== null, "indexed");
    assertEquals(boundaryEdges(geo), 0, `closed at exp ${exp}`);
    assert(finiteAttr(geo, "normal"), "finite normals");
    assert(finiteAttr(geo, "uv"), "uvs");
    assertEquals(geo.getAttribute("uv").count, geo.getAttribute("position").count);
    const P = geo.getAttribute("position"), N = geo.getAttribute("normal");
    let out = 0, tot = 0;
    for (let i = 0; i < P.count; i++) {
      if (P.getZ(i) < 0.05 || P.getZ(i) > 0.95) continue;
      tot++;
      if (P.getX(i) * N.getX(i) + P.getY(i) * N.getY(i) > 0) out++;
    }
    assert(out / tot > 0.97, `outward normals ${out}/${tot}`);
  }
  // Without caps the two end rings stay open: the check can fail.
  assert(boundaryEdges(loftGeometry(lobed(2), 20, false)) > 0, "open loft detected");
});

Deno.test("loft: a left-handed frame (bone pointing -Z) still gets outward normals", () => {
  const geo = loftRings(boneRings([0, 0, 0], [0, 0, -1], lobed(2), { t: [0, 0, -1], x: [1, 0, 0], y: [0, 1, 0] }), { radial: 16 });
  const P = geo.getAttribute("position"), N = geo.getAttribute("normal");
  let out = 0, tot = 0;
  for (let i = 0; i < P.count; i++) {
    if (P.getZ(i) > -0.05 || P.getZ(i) < -0.95) continue;
    tot++;
    if (P.getX(i) * N.getX(i) + P.getY(i) * N.getY(i) > 0) out++;
  }
  assert(out / tot > 0.97, `outward ${out}/${tot}`);
});

Deno.test("loft: superellipse exponent clamp and sharpest ring turn < 0.6 rad", () => {
  assertEquals(clampExponent(1), 1.75);
  assertEquals(clampExponent(3), 2.45);
  assertEquals(clampExponent(Number.NaN), 2);
  for (let e = 1.75; e <= 2.4501; e += 0.1) {
    for (const st of lobed(e)) assert(maxRingTurn(sectionRing(st, 20)) < 0.6, `turn at exp ${e.toFixed(2)}`);
  }
  // A square section corners (turn ~ 1.57); the guard softens an over-sharp lobe below the bound.
  assert(maxRingTurn([[1, 1], [-1, 1], [-1, -1], [1, -1]]) > 1.5, "metric can fail");
  const harsh = { rx: 0.3, ry: 0.3, exp: 2.45, lobes: [{ angle: 0, amp: 0.6, sharp: 24 }] };
  assert(maxRingTurn(sectionRing(harsh, 20)) > 0.6, "harsh lobe exceeds before the guard");
  assert(maxRingTurn(sectionRing(safeSection(harsh, 20), 20)) < 0.6, "guarded");
});

const NO_BODY_ROLES = new Set(["head", "jaw"]);

Deno.test("buildBody: every body kind, both qualities: meshes per joint, finite, triangles > 0", () => {
  const report: string[] = [];
  for (const kind of BODY_KINDS) {
    const { ph, sk, g } = creature(kind, 11, { horns: 0.9, ears: 0.9, spikes: 0.9, wings: 0.9 });
    const hx = helixOf(g, ph);
    for (const q of ["high", "low"] as const) {
      const parts = buildBody(ph, sk, hx, mats(), q);
      assert(parts.triangles > 0, `${kind} triangles`);
      sk.joints.forEach((j, i) => {
        if (NO_BODY_ROLES.has(j.role)) return;
        const flat = hx.wings.kind === "insect" || hx.wings.kind === "fin";
        if (flat && (j.role === "wingMid" || j.role === "wingTip")) return;
        const objs = parts.perJoint.get(i);
        assert(objs && objs.length > 0, `${kind}/${q}: no mesh for ${j.id}`);
        for (const o of objs) {
          const m = o as THREE.Mesh;
          assert(m.isMesh, "mesh");
          assert(finiteAttr(m.geometry, "position"), `${kind} ${j.id} finite positions`);
          assert(finiteAttr(m.geometry, "normal"), `${kind} ${j.id} finite normals`);
          assert(m.geometry.getAttribute("uv"), "uv");
        }
      });
      report.push(`${kind}/${q}: ${parts.triangles} tris, ${sk.joints.length} joints, wings=${hx.wings.kind}`);
    }
  }
  console.log(report.join("\n"));
});

Deno.test("buildBody: every wing kind builds surfaces on a winged quadruped", () => {
  const { ph, sk } = creature("quadruped", 5, { wings: 0.95 });
  assert(sk.joints.some((j) => j.role === "wingRoot"), "winged skeleton");
  for (const kind of ["membrane", "feather", "insect", "fin", "none"] as const) {
    const parts = buildBody(ph, sk, helix({ wings: { kind, span: 2.2, fingers: 3, detail: 0.9 } }), mats(), "high");
    assert(parts.wings.length >= 2, `${kind} surfaces ${parts.wings.length}`);
    for (const w of parts.wings) assert(finiteAttr(w.geometry, "position"), `${kind} finite`);
  }
});

/** Creature-space (rest) bounding box of a joint's meshes. */
function boxOf(sk: Skeleton, i: number, objs: THREE.Object3D[]): THREE.Box3 {
  const rest = restPositions(sk)[i];
  const box = new THREE.Box3();
  for (const o of objs) {
    const g = (o as THREE.Mesh).geometry;
    g.computeBoundingBox();
    box.union(g.boundingBox!.clone().translate(new THREE.Vector3(...rest)));
  }
  return box;
}

Deno.test("wings: an avian's wing surfaces span >= 2x the body height", () => {
  const { ph, sk } = creature("avian", 3);
  const hx = helix({ wings: { kind: "feather", span: 2.4, fingers: 3, detail: 0.7 } });
  const parts = buildBody(ph, sk, hx, mats(), "high");
  const box = new THREE.Box3();
  parts.perJoint.forEach((objs, i) => {
    const surf = objs.filter((o) => parts.wings.includes(o as THREE.Mesh));
    if (surf.length) box.union(boxOf(sk, i, surf));
  });
  const span = box.max.x - box.min.x;
  assert(span >= 2 * sk.height, `span ${span.toFixed(2)} vs height ${sk.height.toFixed(2)}`);
  // Membrane too, with the same request.
  const mem = buildBody(ph, sk, helix({ wings: { kind: "membrane", span: 2.4, fingers: 4, detail: 0.9 } }), mats(), "low");
  const b2 = new THREE.Box3();
  mem.perJoint.forEach((objs, i) => {
    const surf = objs.filter((o) => mem.wings.includes(o as THREE.Mesh));
    if (surf.length) b2.union(boxOf(sk, i, surf));
  });
  assert(b2.max.x - b2.min.x >= 2 * sk.height, `membrane span ${(b2.max.x - b2.min.x).toFixed(2)}`);
});

Deno.test("digits: the number of toes/claws matches helix.digits; serpents and blobs get none", () => {
  const { ph, sk } = creature("quadruped", 9);
  const ankle = sk.joints.find((j) => j.role === "ankle" && j.side < 0)!;
  for (const n of [1, 3, 5]) {
    const objs = buildDigits(ankle, ph, helix({ digits: n, fractalDepth: 2, clawLength: 0.6 }), mats(), "high");
    assertEquals(objs.length, 1);
    const m = objs[0] as THREE.Mesh;
    assertEquals(m.userData.digits, n);
    const mm = m.material as THREE.Material[];
    const kIdx = mm.findIndex((x) => x === (m.material as THREE.Material[])[mm.length - 1]);
    const grp = m.geometry.groups.find((g) => g.materialIndex === kIdx)!;
    assertEquals(components(m.geometry, grp.start, grp.count), n, `claws for ${n} digits`);
  }
  const s = creature("serpent", 9), b = creature("blob", 9);
  const bt = b.sk.joints.find((j) => j.role === "ankle")!;
  assertEquals(buildDigits(bt, b.ph, helix(), mats(), "high").length, 0);
  assertEquals(s.ph.kind, "serpent");
});

function mirrorPairs(sk: Skeleton): [number, number][] {
  const out: [number, number][] = [];
  sk.joints.forEach((j, i) => {
    if (j.side !== 1) return;
    const k = sk.index.get(j.id.replace(/L/g, "R"));
    if (k !== undefined && sk.joints[k].side === -1) out.push([i, k]);
  });
  return out;
}

Deno.test("symmetry: a symmetric helix mirrors exactly; an asymmetric helix does not", () => {
  const { ph, sk } = creature("quadruped", 21, { horns: 0.95, ears: 0.95, wings: 0.95 });
  const pairs = mirrorPairs(sk);
  assert(pairs.length >= 8, `pairs ${pairs.length}`);
  assert(pairs.some(([i]) => sk.joints[i].role === "horn"), "has horns");
  const diff = (hx: MorphHelix) => {
    const parts = buildBody(ph, sk, hx, mats(), "low");
    let worst = 0;
    for (const [l, r] of pairs) {
      const a = boxOf(sk, l, parts.perJoint.get(l) ?? []), b = boxOf(sk, r, parts.perJoint.get(r) ?? []);
      worst = Math.max(worst, Math.abs(a.min.x + b.max.x), Math.abs(a.max.x + b.min.x), Math.abs(a.min.y - b.min.y), Math.abs(a.max.y - b.max.y), Math.abs(a.min.z - b.min.z), Math.abs(a.max.z - b.max.z));
    }
    return worst;
  };
  assertAlmostEquals(diff(helix()), 0, 1e-6, "mirror");
  assert(diff(helix({ asymmetry: 0.5, asymmetricSide: -1, asymmetricParts: ["horn", "ear", "wing", "claw"] })) > 1e-3, "asymmetric differs");
});

Deno.test("hitSpheres: cover every joint and bone end; footprint and height are sane", () => {
  for (const kind of BODY_KINDS) {
    const { ph, sk, g } = creature(kind, 13, { horns: 0.9, ears: 0.9 });
    const hx = helixOf(g, ph);
    const spheres = hitSpheres(ph, sk, hx);
    const rest = restPositions(sk);
    const placed = spheres.map((s) => ({ p: new THREE.Vector3(...rest[s.joint]).add(new THREE.Vector3(...s.offset)), r: s.r }));
    sk.joints.forEach((j, i) => {
      const o = new THREE.Vector3(...rest[i]);
      const e = o.clone().add(new THREE.Vector3(...j.dir).multiplyScalar(j.length));
      for (const [name, p] of [["origin", o], ["end", e]] as const) {
        if (j.role === "jaw") continue;
        assert(placed.some((s) => s.p.distanceTo(p) <= s.r + 1e-6), `${kind}: ${j.id} ${name} uncovered`);
      }
    });
    const rxz = hitRadiusXZ(spheres, sk), h = hitHeight(spheres, sk);
    assert(rxz > 0.1 * sk.height && rxz < 3 * sk.height, `${kind} footprint ${rxz}`);
    // The top of the volume must clear every (non-wing) joint and stay within 2x the body scale.
    const top = Math.max(...sk.joints.map((j, i) => (j.role.startsWith("wing") ? 0 : rest[i][1])));
    assert(h > top && h < 2 * sk.height, `${kind} height ${h} vs top joint ${top}, scale ${sk.height}`);
  }
});
