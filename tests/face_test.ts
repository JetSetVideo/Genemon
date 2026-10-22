// Face / skin / eye-aura builders, headless (no document, no WebGL): geometry and wiring only.
import * as THREE from "../src/lib/three.ts";
import { assert, assertEquals } from "./_assert.ts";
import { createGenemon, phenotypeOf } from "../src/genome/genemon.ts";
import { buildSkeleton, type JointDef } from "../src/body/skeleton.ts";
import type { Phenotype } from "../src/genome/phenotype.ts";
import { ANIM_CHANNELS, type EyeStyle, type MorphHelix, type TeethKind } from "../src/genome/morphTypes.ts";
import { buildFace } from "../src/render/anatomy/face.ts";
import { makeSkinMaterials } from "../src/render/anatomy/skin.ts";
import { EyeAura } from "../src/render/anatomy/eyeAura.ts";

const STYLES: EyeStyle[] = ["round", "sparkle", "ring", "blank", "slit", "sharp", "sleepy", "compound"];
const TEETH: TeethKind[] = ["none", "fangs", "saw", "tusks", "needles", "beak", "molars"];

function helix(over: { eyes?: Partial<MorphHelix["eyes"]>; mouth?: Partial<MorphHelix["mouth"]> } = {}): MorphHelix {
  const anim = Object.fromEntries(ANIM_CHANNELS.map((c) => [c, { lo: 0.2, hi: 0.8, value: 0.5 }])) as MorphHelix["anim"];
  return {
    version: 1,
    asymmetry: 0,
    asymmetricSide: 1,
    asymmetricParts: [],
    fractalDepth: 1,
    digits: 3,
    clawLength: 0.4,
    eyes: { style: "round", pupil: "full", size: 0.3, count: 2, irisColor: 0xff5a1f, scleraColor: 0xffffff, glow: 0.6, aura: "smoke", lidAngle: 0.2, ...over.eyes },
    mouth: { width: 0.7, teeth: "fangs", teethCount: 4, toothLength: 0.3, tongue: true, ...over.mouth },
    wings: { kind: "none", span: 0, fingers: 0, detail: 0 },
    surface: { bump: 0.6, patternScale: 1, patternContrast: 0.5, plates: 0.4, sheen: 0.5, fur: 0.4 },
    fusion: 0.5,
    angularity: 0.3,
    anim,
  };
}

/** A real phenotype + skeleton with a head and a jaw. */
function subject(): { ph: Phenotype; head: JointDef; jaw: JointDef } {
  for (let s = 1; s < 200; s++) {
    const ph = phenotypeOf(createGenemon({ seed: s * 7919, level: 20 }));
    const sk = buildSkeleton(ph);
    const head = sk.joints.find((j) => j.role === "head");
    const jaw = sk.joints.find((j) => j.role === "jaw");
    if (head && jaw) return { ph, head, jaw };
  }
  throw new Error("no skeleton with head + jaw");
}

const S = subject();
const mats = makeSkinMaterials(S.ph, helix(), 42, "high");

function finiteObj(o: THREE.Object3D): boolean {
  let ok = true;
  o.updateMatrixWorld(true);
  o.traverse((x) => {
    const e = x.matrixWorld.elements;
    if (!e.every(Number.isFinite)) ok = false;
    const m = x as THREE.Mesh;
    if (m.isMesh || (x as THREE.Points).isPoints) {
      const p = (m.geometry.attributes.position as THREE.BufferAttribute).array;
      if (p.length === 0) ok = false;
      for (let i = 0; i < p.length; i++) if (!Number.isFinite(p[i])) ok = false;
    }
  });
  return ok;
}

const eyesOf = (f: ReturnType<typeof buildFace>) => f.head.filter((o) => o.userData.eye === true);
const countIn = (objs: THREE.Object3D[], key: string) => {
  let n = 0;
  for (const o of objs) o.traverse((x) => (n += x.userData[key] ? 1 : 0));
  return n;
};

Deno.test("face: every eye style builds finite meshes with the right eye count", () => {
  for (const style of STYLES) {
    const f = buildFace(S.head, S.jaw, S.ph, helix({ eyes: { style } }), mats, "high");
    assertEquals(eyesOf(f).length, 2, `${style} eyes`);
    for (const o of [...f.head, ...f.jaw]) assert(finiteObj(o), `${style} finite`);
    if (style === "blank") assertEquals(f.pupils.length, 0, "blank has no pupils");
    else if (style !== "compound") assertEquals(f.pupils.length, 2, `${style} pupils`);
    // A catchlight on every non-blank eye.
    for (const e of eyesOf(f)) assert(countIn([e], "catchlight") >= (style === "blank" ? 0 : 1), `${style} catchlight`);
    if (style === "blank") assertEquals(countIn(eyesOf(f), "catchlight"), 0, "blank: no catchlight");
    if (style === "sparkle") assert(countIn(eyesOf(f), "catchlight") >= 4, "sparkle: 2+ stars per eye");
    if (style !== "compound") assertEquals(f.lids.length, 2, `${style} lids`);
    for (const lid of f.lids) assert(lid.userData.closed > lid.userData.open, "lid closes with +x");
  }
});

Deno.test("face: sleepy lids hang lower than round ones; sharp eyes are narrower", () => {
  const round = buildFace(S.head, S.jaw, S.ph, helix({ eyes: { style: "round", lidAngle: 0 } }), mats, "low");
  const sleepy = buildFace(S.head, S.jaw, S.ph, helix({ eyes: { style: "sleepy", lidAngle: 0 } }), mats, "low");
  const sharp = buildFace(S.head, S.jaw, S.ph, helix({ eyes: { style: "sharp" } }), mats, "low");
  assert(sleepy.lids[0].rotation.x > round.lids[0].rotation.x + 0.5, "sleepy lid lower");
  assert(eyesOf(sharp)[0].scale.y < 0.8, "sharp eye squashed vertically");
});

Deno.test("face: scaled pupils stay outside the iris shell (emotion scaling about the pupil pole)", () => {
  for (const style of ["round", "slit", "sparkle"] as const) {
    const f = buildFace(S.head, S.jaw, S.ph, helix({ eyes: { style } }), mats, "low");
    const eye = eyesOf(f)[0];
    const er = eye.userData.radius as number;
    for (const s of [0.35, 0.75, 1.35]) {
      for (const p of f.pupils) p.scale.setScalar(s);
      const pupil = f.pupils.find((p) => p.parent === eye) as THREE.Mesh;
      const pos = pupil.geometry.attributes.position;
      pupil.updateMatrix();
      const v = new THREE.Vector3();
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(pupil.matrix);
        assert(v.length() > er * 1.012, `${style} s=${s}: pupil vertex sank below the iris (${(v.length() / er).toFixed(4)} er)`);
      }
    }
  }
});

Deno.test("face: FALSIFIER - count 1/3/4 really yields 1/3/4 eyes (not 2)", () => {
  for (const count of [1, 3, 4]) {
    const f = buildFace(S.head, S.jaw, S.ph, helix({ eyes: { count, aura: "flame" } }), mats, "high");
    assertEquals(eyesOf(f).length, count, `count ${count}`);
    assertEquals(f.pupils.length, count, `pupils ${count}`);
    assertEquals(f.auraEmitters.length, count, `aura emitters ${count}`);
    // Distinct positions.
    const ps = eyesOf(f).map((e) => e.position);
    for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) assert(ps[i].distanceTo(ps[j]) > 1e-4, "eyes not stacked");
  }
});

Deno.test("face: eyes sit on the upper half of the face and in front of the head centre", () => {
  const f = buildFace(S.head, S.jaw, S.ph, helix(), mats, "high");
  const fwd = new THREE.Vector3(...S.head.dir).normalize();
  for (const e of eyesOf(f)) {
    assert(e.position.y > 0, `eye above the head axis (y=${e.position.y})`);
    assert(e.position.dot(fwd) > S.head.length * 0.45, "eye on the front half");
  }
  const ys = eyesOf(f).map((e) => e.position.x);
  assert(Math.min(...ys) < 0 && Math.max(...ys) > 0, "two eyes are on both sides");
});

Deno.test("face: teeth kinds, per-side counts, beak, tusks, tongue", () => {
  for (const teeth of TEETH) {
    const n = 5;
    const f = buildFace(S.head, S.jaw, S.ph, helix({ mouth: { teeth, teethCount: n } }), mats, "high");
    for (const o of [...f.head, ...f.jaw]) assert(finiteObj(o), `${teeth} finite`);
    const halves = [...f.head, ...f.jaw].filter((o) => typeof o.userData.teeth === "number");
    if (teeth === "none" || teeth === "beak") assertEquals(halves.length, 0, `${teeth}: no teeth`);
    else {
      assertEquals(halves.length, 4, `${teeth}: upper L/R + lower L/R`);
      for (const h of halves) {
        assertEquals(h.userData.teeth, n, `${teeth} per side`);
        assertEquals(h.userData.tips.length, n, `${teeth} tips placed`);
      }
      assertEquals(f.head.filter((o) => o.userData.teeth).length, 2, "upper teeth on the head");
      assertEquals(f.jaw.filter((o) => o.userData.teeth).length, 2, "lower teeth on the jaw");
    }
    const beaks = [...f.head, ...f.jaw].filter((o) => o.userData.beak);
    assertEquals(beaks.length, teeth === "beak" ? 2 : 0, `${teeth} beak`);
    assert(f.jaw.some((o) => o.userData.tongue), "tongue on the jaw");
  }
  // Tusks rise: the outermost lower tip sits above (jaw-up) the jaw rim and is the longest tooth.
  const t = buildFace(S.head, S.jaw, S.ph, helix({ mouth: { teeth: "tusks", teethCount: 3, toothLength: 0.4 } }), mats, "low");
  const lower = t.jaw.find((o) => o.userData.teeth && o.userData.side === 1)!;
  const tips = lower.userData.tips as number[][];
  assert(tips[2][1] > tips[0][1], "tusk tip higher than the small teeth");
});

Deno.test("face: teeth count follows teethCount (falsifier for a fixed count)", () => {
  const a = buildFace(S.head, S.jaw, S.ph, helix({ mouth: { teeth: "needles", teethCount: 2 } }), mats, "low");
  const b = buildFace(S.head, S.jaw, S.ph, helix({ mouth: { teeth: "needles", teethCount: 11 } }), mats, "low");
  const per = (f: ReturnType<typeof buildFace>) => f.head.find((o) => o.userData.teeth)!.userData.teeth;
  assertEquals(per(a), 2);
  assertEquals(per(b), 11);
});

Deno.test("face: mouth spec is normalised, forward and scales with width; no jaw still works", () => {
  const narrow = buildFace(S.head, S.jaw, S.ph, helix({ mouth: { width: 0.3 } }), mats, "high");
  const wide = buildFace(S.head, S.jaw, S.ph, helix({ mouth: { width: 1 } }), mats, "high");
  for (const f of [narrow, wide]) {
    assert(Math.abs(f.mouth.dir.length() - 1) < 1e-9, "dir normalised");
    assert(f.mouth.dir.z > 0.7, `dir forward (+Z), got ${f.mouth.dir.z}`);
    assert(f.mouth.origin.z > S.head.length * 0.5, "origin on the head front");
    assert([f.mouth.origin.x, f.mouth.origin.y, f.mouth.origin.z].every(Number.isFinite), "origin finite");
  }
  assert(wide.mouth.width > narrow.mouth.width * 1.5, "width gene widens the mouth");
  const nj = buildFace(S.head, undefined, S.ph, helix({ mouth: { teeth: "saw" } }), mats, "low");
  assertEquals(nj.jaw.length, 0, "no jaw meshes without a jaw");
  assertEquals(nj.head.filter((o) => o.userData.teeth).length, 2, "upper teeth only");
});

Deno.test("face: aura emitters, one per eye, above the eyes", () => {
  const f = buildFace(S.head, S.jaw, S.ph, helix({ eyes: { aura: "smoke" } }), mats, "high");
  assertEquals(f.auraEmitters.length, eyesOf(f).length);
  eyesOf(f).forEach((e, i) => assert(f.auraEmitters[i].y > e.position.y, "emitter above its eye"));
});

Deno.test("skin: headless makeSkinMaterials returns all 5 materials without maps", () => {
  for (const q of ["low", "high"] as const) {
    const m = makeSkinMaterials(S.ph, helix(), 7, q);
    for (const k of ["skin", "accent", "belly", "keratin", "membrane"] as const) assert(m[k] && m[k].isMaterial, `${q} ${k}`);
    assertEquals(m.textures.length, 0, "no canvas, no textures");
    assertEquals(m.skin.map, null);
    assertEquals(m.skin.normalMap, null);
    assert(Number.isFinite(m.baseEmissive) && m.baseEmissive >= 0, "baseEmissive finite");
    assertEquals(m.membrane.side, THREE.DoubleSide);
    assert(m.keratin.roughness < 0.4, "keratin is glossy");
    assert(m.skin.userData.rim && typeof m.skin.onBeforeCompile === "function", "rim hook installed");
  }
  assert(makeSkinMaterials(S.ph, helix(), 7, "high").skin instanceof THREE.MeshPhysicalMaterial, "high tier is physical");
});

Deno.test("skin: rim injection patches a real shader and is a no-op on a foreign one", () => {
  const m = makeSkinMaterials(S.ph, helix(), 7, "high");
  const lib = THREE.ShaderLib.physical;
  const shader = { fragmentShader: lib.fragmentShader, vertexShader: lib.vertexShader, uniforms: {} as Record<string, THREE.IUniform> };
  // deno-lint-ignore no-explicit-any
  m.skin.onBeforeCompile(shader as any, undefined as any);
  // The physical template uses #include <common>; it must now declare and use the rim.
  assert(shader.fragmentShader.includes("gmRimStrength"), "rim injected");
  assert("gmRimColor" in shader.uniforms, "rim uniform bound");
  const foreign = { fragmentShader: "void main() {}", vertexShader: "", uniforms: {} as Record<string, THREE.IUniform> };
  // deno-lint-ignore no-explicit-any
  m.skin.onBeforeCompile(foreign as any, undefined as any);
  assertEquals(foreign.fragmentShader, "void main() {}", "failed replace leaves the shader untouched");
});

Deno.test("eye aura: emits finite world-space particles that follow the head matrix", () => {
  const f = buildFace(S.head, S.jaw, S.ph, helix({ eyes: { aura: "flame" } }), mats, "low");
  for (const kind of ["smoke", "flame", "spark", "frost", "tears"] as const) {
    const aura = new EyeAura(kind, f.auraEmitters, 0.05, 0xff5a1f, "low");
    const m = new THREE.Matrix4().makeTranslation(10, 2, -3);
    aura.setIntensity(1.5);
    for (let i = 0; i < 30; i++) aura.update(1 / 60, m);
    assert(aura.alive() > 0, `${kind} emits`);
    assert(finiteObj(aura.points), `${kind} finite`);
    const p = aura.points.geometry.attributes.position.array;
    assert(Math.abs(p[0] - 10) < 2, `${kind} follows the head (x near 10)`);
    aura.dispose();
  }
  const off = new EyeAura("none", f.auraEmitters, 0.05, 0, "low");
  off.update(0.1, new THREE.Matrix4());
  assertEquals(off.alive(), 0, "none emits nothing");
});
