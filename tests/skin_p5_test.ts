// Skin-coat lane (pass 5, P5-V7 / P5-V8): pure texture painters, cel maths, shader injection, coats,
// scars, age and flames — headless (no DOM, no WebGL; DataTextures and geometry need neither).
import * as THREE from "../src/lib/three.ts";
import { assert, assertEquals } from "./_assert.ts";
import { BODY_KINDS, type BodyKind, randomGenome } from "../src/genome/genome.ts";
import { express, type Phenotype } from "../src/genome/phenotype.ts";
import { emptyConditions } from "../src/genome/epigenetics.ts";
import { buildSkeleton, type Skeleton } from "../src/body/skeleton.ts";
import { ANIM_CHANNELS, type CoatKind, type MorphHelix, P5_DEFAULTS, type SkinP5, type TailShape } from "../src/genome/morphTypes.ts";
import type { Scar } from "../src/genome/lifeTypes.ts";
import { buildBody } from "../src/render/anatomy/body.ts";
import {
  addOutlines,
  ageTint,
  applyScars,
  celQuantize,
  makeOutlineMaterial,
  makeSkinMaterials,
  scarPlacement,
  skinShared,
  swapMaterial,
  tickSkin,
} from "../src/render/anatomy/skin.ts";
import { buildCoat } from "../src/render/anatomy/coat.ts";
import { lum, overlayLayers, paintBelly, paintRelief, paintScar, paintSkin, Raster, type RGB, type ScarKind } from "../src/render/textures.ts";

const COATS: CoatKind[] = ["skin", "fur", "scales", "feathers", "leaves", "chitin", "slime", "bark", "crystal"];

function helix(skin: Partial<SkinP5> = {}, tailShape: TailShape = "taper"): MorphHelix {
  const anim = Object.fromEntries(ANIM_CHANNELS.map((c) => [c, { lo: 0.2, hi: 0.8, value: 0.5 }])) as MorphHelix["anim"];
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
    anim,
    p5: {
      ...P5_DEFAULTS,
      body: { ...P5_DEFAULTS.body, tail: { ...P5_DEFAULTS.body.tail, shape: tailShape } },
      skin: { ...P5_DEFAULTS.skin, ...skin },
    },
  };
}

function creature(kind: BodyKind, seed = 7): { ph: Phenotype; sk: Skeleton } {
  const g = randomGenome(seed, undefined, { kind, plan: {} });
  const ph = express(g, emptyConditions());
  return { ph, sk: buildSkeleton(ph) };
}
const withElement = (ph: Phenotype, primary: Phenotype["elements"]["primary"]): Phenotype => ({ ...ph, elements: { ...ph.elements, primary } });

const P = (o: Partial<SkinP5> = {}): SkinP5 => ({ ...P5_DEFAULTS.skin, ...o });
const colMean = (r: Raster, u: number) => r.meanLum(Math.floor(u * r.w) - 2, 0, Math.floor(u * r.w) + 3, r.h);

// ------------------------------------------------------------------ belly / back

Deno.test("belly texture is lighter than the back, and the back is countershaded along u", () => {
  for (const kind of ["quadruped", "serpent", "biped"] as BodyKind[]) {
    for (const seed of [3, 11, 29]) {
      const { ph } = creature(kind, seed);
      for (const k of [0.4, 0.8, 1]) {
        const back = paintSkin(ph, P({ bellyContrast: k, overlays: 0 }), seed, 64).map;
        const belly = paintBelly(ph, P({ bellyContrast: k }), "folds", seed, 64).map;
        const dorsal = colMean(back, 0.25);
        const bl = belly.meanLum(0, 0, 64, 64);
        assert(bl > dorsal + 0.03, `${kind}/${seed}/k${k}: belly ${bl.toFixed(3)} > dorsal ${dorsal.toFixed(3)}`);
        // Pattern-independent property: on a solid coat the ventral column is lighter than the dorsal saddle.
        const plain = paintSkin({ ...ph, pattern: "solid" }, P({ bellyContrast: k, overlays: 0 }), seed, 64).map;
        assert(colMean(plain, 0.75) > colMean(plain, 0.25) + 0.05 * k, `${kind}/${seed}: ventral column lighter than the dorsal saddle`);
      }
    }
  }
});

Deno.test("belly styles: scutes are transverse (rows), every style differs from plain folds", () => {
  const { ph } = creature("serpent", 5);
  const p = P({ bellyContrast: 0.8 });
  const folds = paintBelly(ph, p, "folds", 5, 64).map;
  for (const s of ["scutes", "fur", "plates", "feathers"] as const) {
    const m = paintBelly(ph, p, s, 5, 64).map;
    let diff = 0;
    for (let i = 0; i < m.data.length; i += 4) if (Math.abs(m.data[i] - folds.data[i]) > 0.02) diff++;
    assert(diff > 64 * 64 * 0.05, `${s} differs from folds (${diff} px)`);
  }
  // Scutes: row-to-row variation dominates column-to-column variation (transverse plates).
  const sc = paintBelly(ph, p, "scutes", 5, 64).map;
  const rowMeans = Array.from({ length: 64 }, (_, y) => sc.meanLum(10, y, 54, y + 1));
  const colMeans = Array.from({ length: 64 }, (_, x) => sc.meanLum(x, 0, x + 1, 64));
  const spread = (a: number[]) => Math.max(...a) - Math.min(...a);
  assert(spread(rowMeans) > 2 * spread(colMeans.slice(10, 54)), "scutes vary along v, not across u");
});

// ------------------------------------------------------------------ overlays

Deno.test("overlays: stripes layer changes pixels; layer order mottle < spots < stripes", () => {
  const { ph } = creature("quadruped", 9);
  const solid = { ...ph, pattern: "solid" as const };
  const a = paintSkin(solid, P({ stripes: 0, overlays: 0 }), 9, 64).map;
  const b = paintSkin(solid, P({ stripes: 0.9, overlays: 1 }), 9, 64).map;
  let diff = 0;
  for (let i = 0; i < a.data.length; i += 4) if (Math.abs(lum(a.data, i) - lum(b.data, i)) > 0.02) diff++;
  assert(diff > 64 * 64 * 0.08, `stripes changed ${diff} px`);
  // Stripes are dorsal: they change the back more than the belly line.
  const d = (u: number) => Math.abs(colMean(a, u) - colMean(b, u));
  assert(d(0.25) > d(0.75), "stripes fade toward the belly");
  assertEquals(overlayLayers(solid, P({ overlays: 3, stripes: 0.5 })), ["mottle", "spots", "stripes"]);
  assertEquals(overlayLayers(solid, P({ overlays: 0, stripes: 0 })), []);
  assertEquals(overlayLayers({ ...ph, pattern: "spots" }, P({ overlays: 2, stripes: 0 })), ["mottle"]);
  const weak = paintSkin(solid, P({ stripes: 0.2, overlays: 1 }), 9, 64).map;
  const dw = Math.abs(colMean(a, 0.25) - colMean(weak, 0.25));
  assert(d(0.25) > dw, "stripe strength scales the change");
});

// ------------------------------------------------------------------ relief per coat

Deno.test("relief: every coat paints a distinct height field (normal-map source)", () => {
  const { ph } = creature("quadruped", 4);
  const S = { patternScale: 1, patternContrast: 0.6, plates: 0.4, fur: 0.3 };
  const fields = COATS.map((c) => paintRelief(ph, S, c, 4, 64));
  for (let i = 0; i < COATS.length; i++) {
    for (let j = i + 1; j < COATS.length; j++) {
      let d = 0;
      for (let k = 0; k < fields[i].data.length; k += 4) d += Math.abs(fields[i].data[k] - fields[j].data[k]);
      assert(d / (64 * 64) > 0.01, `${COATS[i]} vs ${COATS[j]} relief differ`);
    }
  }
});

// ------------------------------------------------------------------ scars

Deno.test("scars: pale core, darker edges, every kind paints", () => {
  const base: RGB = [0.35, 0.45, 0.3];
  const r = new Raster(128, 128, base);
  paintScar(r, { u: 0.5, v: 0.5, dir: 0, length: 0.4, width: 0.03, kind: "slash", seed: 1 }, base);
  const b = lum(base);
  const core = r.meanLum(60, 63, 68, 65);
  assert(core > b + 0.15, `core pale (${core.toFixed(2)} vs ${b.toFixed(2)})`);
  const edge = Math.min(r.meanLum(60, 66, 68, 67), r.meanLum(60, 61, 68, 62));
  assert(edge < b - 0.03, `edge darker (${edge.toFixed(2)})`);
  for (const kind of ["claw", "burn", "frost", "bolt", "acid"] as ScarKind[]) {
    const q = new Raster(64, 64, base);
    paintScar(q, { u: 0.5, v: 0.5, dir: 0.6, length: 0.4, width: 0.03, kind, seed: 3 }, base);
    let n = 0;
    for (let i = 0; i < q.data.length; i += 4) if (Math.abs(lum(q.data, i) - b) > 0.05) n++;
    assert(n > 20, `${kind} changed ${n} px`);
  }
});

Deno.test("scars: placement on the right body part, per-joint textures, sync, swap", () => {
  const { ph, sk } = creature("quadruped", 13);
  const scars: Scar[] = [
    { atDay: 3, part: "torso", severity: 0.8, from: "physical", side: 1, u: 0.5, angle: 0.4 },
    { atDay: 4, part: "tail", severity: 0.4, from: "fire", side: -1, u: 0.9, angle: 0 },
    { atDay: 5, part: "head", severity: 0.6, from: "electric", side: 1, u: 0.5, angle: 0.2 },
    { atDay: 6, part: "limb.l1", severity: 0.5, from: "ice", side: -1, u: 0.2, angle: 1 },
  ];
  const pl = scarPlacement(scars, sk);
  assertEquals(pl.length, 4);
  assert(["root", "spine", "chest", "segment"].includes(sk.joints[pl[0].joint].role), "torso scar on the torso");
  if (sk.joints.some((j) => j.role === "tail")) assertEquals(sk.joints[pl[1].joint].role, "tail");
  assertEquals(sk.joints[pl[2].joint].role, "head");
  assert(["hip", "shoulder"].includes(sk.joints[pl[3].joint].role), "limb scar on a limb root");
  assertEquals(pl[1].stroke.kind, "burn");
  assertEquals(pl[2].stroke.kind, "bolt");
  assertEquals(pl[0].stroke.kind, "claw");
  for (const p of pl) assert(p.stroke.u >= 0 && p.stroke.u < 1 && p.stroke.v > 0 && p.stroke.v < 1, "uv in range");

  // Headless default: no painted texture -> placements only.
  const bare = makeSkinMaterials(ph, helix(), 13, "high");
  const s0 = applyScars(bare, scars, sk);
  assertEquals(s0.byJoint.size, 0);
  assertEquals(s0.placements.length, 4);

  const mats = makeSkinMaterials(ph, helix(), 13, "low", { textures: true });
  const set = applyScars(mats, scars, sk);
  assert(set.byJoint.size >= 3, `scarred joints ${set.byJoint.size}`);
  const tm = set.byJoint.get(pl[0].joint)!;
  const a = (mats.skin.map as THREE.DataTexture).image.data as Uint8Array;
  const b = (tm.map as THREE.DataTexture).image.data as Uint8Array;
  let diff = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
  assert(diff > 50, `scar texture differs from the base (${diff} bytes)`);
  assert(tm.onBeforeCompile !== mats.skin.onBeforeCompile && tm.userData.rim === mats.skin.userData.rim, "copy shares the rim uniforms");
  mats.skin.opacity = 0.3;
  mats.skin.emissiveIntensity = 2;
  set.sync();
  assertEquals(tm.opacity, 0.3);
  assertEquals(tm.emissiveIntensity, 2);
  // swapMaterial: replaces inside arrays, stops at child joints.
  const joint = new THREE.Group(), child = new THREE.Group();
  const m1 = new THREE.Mesh(new THREE.BoxGeometry(), [mats.skin, mats.belly]);
  const m2 = new THREE.Mesh(new THREE.BoxGeometry(), mats.skin);
  joint.add(m1, child);
  child.add(m2);
  assertEquals(swapMaterial(joint, mats.skin, tm, (o) => o === child), 1);
  assertEquals((m1.material as THREE.Material[])[0], tm);
  assertEquals(m2.material, mats.skin);
  set.dispose();
});

// ------------------------------------------------------------------ cel

Deno.test("cel: band quantisation gives exactly N tones, monotone, bounded (never brighter than the reference)", () => {
  for (let n = 2; n <= 5; n++) {
    const tones = new Set<number>();
    let prev = -1;
    for (let i = 0; i < 1500; i++) {
      const L = (i + 0.5) / 1000; // 0 .. 1.5 x the reference: over-bright light is capped
      const q = celQuantize(L, n);
      assert(q >= prev - 1e-9, "monotone");
      assert(q >= 0.26 - 1e-9 && q <= 1, "bounded to [floor, 1]");
      prev = q;
      tones.add(Math.round(q * 1e6));
    }
    assertEquals(tones.size, n, `bands ${n}`);
  }
  assertEquals(celQuantize(0.5, 9), celQuantize(0.5, 5), "bands clamp to 2..5");
  assertEquals(celQuantize(0, 3), 0.26, "darkest band = shadow floor");
  assertEquals(celQuantize(5, 3), 1, "brightest band = full tone, never above");
  // Anti-aliased edge: a value between the two tones right at the step (L = 0.5 for 2 bands).
  const lo = celQuantize(0.49, 2), hi = celQuantize(0.51, 2), mid = celQuantize(0.5, 2, 0.05);
  assert(mid > lo && mid < hi, "aa edge is smooth");
});

Deno.test("shader: cel + countershade + age + rim injected on standard and physical; flame keeps STANDARD", () => {
  const { ph } = creature("avian", 21);
  for (const q of ["low", "high"] as const) {
    const m = makeSkinMaterials(withElement(ph, "fire"), helix({ celBands: 4 }), 21, q);
    for (const key of ["skin", "accent", "belly", "keratin", "membrane"] as const) {
      const lib = m[key] instanceof THREE.MeshPhysicalMaterial ? THREE.ShaderLib.physical : THREE.ShaderLib.standard;
      const shader = { fragmentShader: lib.fragmentShader, vertexShader: lib.vertexShader, uniforms: {} as Record<string, THREE.IUniform> };
      // deno-lint-ignore no-explicit-any
      m[key].onBeforeCompile(shader as any, undefined as any);
      const fs = shader.fragmentShader;
      for (const s of ["gmCelBands", "reflectedLight.indirectDiffuse *= gmK", "gmShadeBelly", "nonPerturbedNormal, gmUp", "gmAge", "gmRimStrength"]) assert(fs.includes(s), `${q}/${key}: ${s}`);
      assert(fs.indexOf("gmShadeBelly )") < fs.indexOf("#include <lights_physical_fragment>"), "countershade before lighting");
      assert(fs.indexOf("gmCelRef * mix( gmCelFloor") > fs.indexOf("#include <aomap_fragment>"), "cel after lighting");
      assertEquals((shader.uniforms.gmCelBands as THREE.IUniform).value, 4);
    }
    const defs = (m.membrane as unknown as { defines: Record<string, string> }).defines;
    assert("GM_FLAME" in defs && "USE_UV" in defs && "STANDARD" in defs, "flame defines keep STANDARD");
    assert(m.fire === 1, "fire creature burns");
  }
  const cold = makeSkinMaterials(withElement(ph, "water"), helix(), 21, "high");
  assertEquals(cold.fire, 0);
  assert(!("GM_FLAME" in ((cold.membrane as unknown as { defines?: Record<string, string> }).defines ?? {})), "no flame on water");
  const foreign = { fragmentShader: "void main() {}", vertexShader: "void main() {}", uniforms: {} as Record<string, THREE.IUniform> };
  // deno-lint-ignore no-explicit-any
  cold.skin.onBeforeCompile(foreign as any, undefined as any);
  assertEquals(foreign.fragmentShader, "void main() {}");
});

Deno.test("tickSkin / ageTint: shared time, idempotent elder tint", () => {
  const { ph, sk } = creature("quadruped", 2);
  const m = makeSkinMaterials(withElement(ph, "fire"), helix(), 2, "high");
  tickSkin(m, 12.5);
  assertEquals(skinShared(m)!.time.value, 12.5);
  const coat = buildCoat(sk, withElement(ph, "fire"), helix(), m, "high");
  const flame = coat.materials.find((x) => (x as THREE.ShaderMaterial).isShaderMaterial) as THREE.ShaderMaterial;
  assert(flame && flame.uniforms.gmTime === skinShared(m)!.time, "coat flames share the creature time uniform");
  const r0 = m.skin.roughness;
  assertEquals(ageTint(m, "adult"), 0);
  assertEquals(ageTint(m, "elder"), 0.55);
  const r1 = m.skin.roughness;
  ageTint(m, "elder");
  assertEquals(m.skin.roughness, r1, "idempotent");
  assert(r1 > r0, "elders are rougher");
  assertEquals(ageTint(m, "ancient"), 1);
  assertEquals(skinShared(m)!.age.value, 1);
  ageTint(m, "juvenile");
  assertEquals(m.skin.roughness, r0, "young again restores");
  coat.dispose();
});

Deno.test("makeSkinMaterials with textures: DataTextures, belly has its own lighter map", () => {
  const { ph } = creature("serpent", 8);
  for (const coat of ["skin", "scales", "fur", "crystal"] as CoatKind[]) {
    const m = makeSkinMaterials(ph, helix({ coat, bellyContrast: 0.8 }), 8, "low", { textures: true });
    assert(m.skin.map && m.belly.map && m.skin.map !== m.belly.map, `${coat}: own belly map`);
    assert(m.belly.normalMap && m.belly.normalMap !== m.skin.normalMap, `${coat}: own belly normal map`);
    const lumOf = (t: THREE.Texture) => {
      const d = (t as THREE.DataTexture).image.data as Uint8Array;
      let s = 0;
      for (let i = 0; i < d.length; i += 4) s += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      return s / (d.length / 4);
    };
    assert(lumOf(m.belly.map!) > lumOf(m.skin.map!), `${coat}: belly lighter`);
    assert(m.textures.length >= 4, "textures tracked for disposal");
    for (const t of m.textures) t.dispose();
  }
});

// ------------------------------------------------------------------ coats

Deno.test("coats: triangle budgets across coats x body kinds x qualities (frills + fire on)", () => {
  const table: string[] = [];
  let lowMax = 0;
  for (const kind of BODY_KINDS) {
    const { ph, sk } = creature(kind, 17);
    const fiery = withElement(ph, "fire");
    for (const coat of COATS) {
      for (const q of ["low", "high"] as const) {
        const hx = helix({ coat, frills: 0.8 }, "flame");
        const mats = makeSkinMaterials(fiery, hx, 17, q);
        const body = buildBody(fiery, sk, hx, mats, q);
        const c = buildCoat(sk, fiery, hx, mats, q, body.perJoint, { seed: 17 });
        let measured = 0;
        c.perJoint.forEach((objs, ji) => {
          assert(ji >= 0 && ji < sk.joints.length, "valid joint");
          for (const o of objs) {
            const mesh = o as THREE.Mesh;
            const g = mesh.geometry;
            measured += g.index!.count / 3;
            const p = g.attributes.position.array as Float32Array;
            for (let i = 0; i < p.length; i++) assert(Number.isFinite(p[i]), "finite");
            assert(mesh.userData.coat === true, "flagged coat");
          }
        });
        for (const s of c.shells) measured += s.geometry.index ? s.geometry.index.count / 3 : 0;
        assertEquals(Math.round(measured), c.triangles, `${kind}/${coat}/${q}: counted = measured`);
        assert(c.triangles <= (q === "high" ? 8000 : 400), `${kind}/${coat}/${q}: ${c.triangles} tris`);
        if (q === "high") table.push(`${kind}/${coat}:${c.triangles}`);
        else lowMax = Math.max(lowMax, c.triangles);
        if (q === "high" && ["feathers", "leaves", "crystal"].includes(coat)) assert(c.counts[coat === "crystal" ? "crystal" : coat] > 0, `${kind}/${coat} has cards/shards`);
        if (q === "high" && coat === "fur" && kind !== "blob") assert(c.counts.fur > 0, `${kind}: fur shells built`);
        if (q === "low") assertEquals(c.counts.fur, 0, "no shells at low");
        assert(c.counts.flames > 0 || !sk.joints.some((j) => j.role === "tail" || j.role === "wingTip"), `${kind}: flames on fire tails / wings`);
        c.dispose();
      }
    }
  }
  console.log("coat triangles @high (frills 0.8, fire):", table.join(" "), "| max @low:", lowMax);
});

Deno.test("coats: plain skin, no frills, no fire = no extra geometry", () => {
  const { ph, sk } = creature("quadruped", 6);
  const cool = withElement(ph, "water");
  for (const coat of ["skin", "chitin", "slime", "bark"] as CoatKind[]) {
    const hx = helix({ coat, frills: 0 });
    const c = buildCoat(sk, cool, hx, makeSkinMaterials(cool, hx, 6, "high"), "high");
    assertEquals(c.triangles, 0, coat);
  }
});

// ------------------------------------------------------------------ outline

Deno.test("outline: inverted hull within budget, skips small / transparent / coat meshes", () => {
  const c0 = creature("quadruped", 31);
  const ph = { ...c0.ph, translucency: 0 }, sk = c0.sk;
  const hx = helix({ outline: 0.6, coat: "feathers", frills: 0.6 });
  const mats = makeSkinMaterials(ph, hx, 31, "high");
  const body = buildBody(ph, sk, hx, mats, "high");
  const coat = buildCoat(sk, ph, hx, mats, "high", body.perJoint);
  const roots: THREE.Object3D[] = [];
  body.perJoint.forEach((o) => roots.push(...o));
  coat.perJoint.forEach((o) => roots.push(...o));
  const tiny = new THREE.Mesh(new THREE.SphereGeometry(0.0001, 6, 4), mats.skin);
  roots.push(tiny);
  const mat = makeOutlineMaterial(ph, hx.p5!.skin, sk.height)!;
  assert(mat && mat.side === THREE.BackSide, "back-face hull");
  const budget = Math.round(body.triangles * 0.5);
  const r = addOutlines(roots, mat, budget, [mats.keratin]);
  assert(r.triangles <= budget && r.triangles > 0, `outline tris ${r.triangles} <= ${budget}`);
  for (const h of r.meshes) {
    const p = h.parent as THREE.Mesh;
    assert(!p.userData.coat && p !== tiny, "no hull on coat / tiny meshes");
    const ms = Array.isArray(p.material) ? p.material : [p.material];
    assert(ms.every((m) => m.opacity >= 0.9 && m.depthWrite), "no hull on see-through meshes");
    assertEquals(h.geometry, p.geometry, "hull shares geometry");
    assert(!ms.includes(mats.keratin), "no hull around claws / teeth (skip list)");
  }
  const shader = { vertexShader: THREE.ShaderLib.basic.vertexShader, fragmentShader: THREE.ShaderLib.basic.fragmentShader, uniforms: {} as Record<string, THREE.IUniform> };
  // deno-lint-ignore no-explicit-any
  mat.onBeforeCompile(shader as any, undefined as any);
  assert(shader.vertexShader.includes("gmOutlineW") && "gmOutlineW" in shader.uniforms, "outline push injected");
  assertEquals(makeOutlineMaterial(ph, P({ outline: 0 }), 1), null);
  // A ghostly (translucent) creature gets no hull at all.
  const ghost = { ...c0.ph, translucency: 0.6 };
  const gm = makeSkinMaterials(ghost, hx, 31, "high");
  const gb = buildBody(ghost, sk, hx, gm, "high");
  const groots: THREE.Object3D[] = [];
  gb.perJoint.forEach((o) => groots.push(...o));
  assertEquals(addOutlines(groots, mat, 1e9).triangles, 0, "no ink hull through a ghost");
  coat.dispose();
});
