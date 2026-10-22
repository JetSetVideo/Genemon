// Face / skin / eye-aura builders, headless (no document, no WebGL): geometry and wiring only.
import * as THREE from "../src/lib/three.ts";
import { assert, assertEquals } from "./_assert.ts";
import { createGenemon, phenotypeOf } from "../src/genome/genemon.ts";
import { helixOf } from "../src/genome/helix.ts";
import { buildSkeleton, type JointDef } from "../src/body/skeleton.ts";
import type { Phenotype } from "../src/genome/phenotype.ts";
import { ANIM_CHANNELS, type BeakKind, type EyeLayout, type EyeShape, type EyeStyle, type MorphHelix, type MorphP5, P5_DEFAULTS, type TeethKind } from "../src/genome/morphTypes.ts";
import { beakGeometry, buildFace, buildHead, buildJaw, eyePlacements, headVolume, insideOutline, jawVolume } from "../src/render/anatomy/face.ts";
import { makeSkinMaterials } from "../src/render/anatomy/skin.ts";
import { auraWeight, EyeAura } from "../src/render/anatomy/eyeAura.ts";

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


// ====================================================================== pass 5 [P5-V4]
type P5Over = { eyes?: Partial<MorphP5["eyes"]>; mouth?: Partial<MorphP5["mouth"]>; growth?: Partial<MorphP5["growth"]> };
function helix5(o: P5Over = {}, base: Parameters<typeof helix>[0] = {}): MorphHelix {
  const p5: MorphP5 = structuredClone(P5_DEFAULTS);
  Object.assign(p5.eyes, o.eyes ?? {});
  Object.assign(p5.mouth, o.mouth ?? {});
  Object.assign(p5.growth, o.growth ?? {});
  const h = helix({ ...base, eyes: { aura: "none", ...base.eyes, count: p5.eyes.count } });
  return { ...h, p5 };
}
const adult = { ...S.ph, growth: 1 };
const headTris = (objs: THREE.Object3D[]) => {
  let n = 0;
  for (const o of objs) {
    o.traverse((x) => {
      const m = x as THREE.Mesh;
      if (m.isMesh) n += (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3;
    });
  }
  return Math.round(n);
};
const LAYOUTS: EyeLayout[] = ["row", "arc", "cluster", "stacked"];

Deno.test("p5 face: 1..8 eyes for every layout - counts, symmetry about the midline, no overlap", () => {
  for (let n = 1; n <= 8; n++) {
    for (const layout of n === 1 ? ["cyclops" as EyeLayout] : n === 2 ? ["pair" as EyeLayout] : LAYOUTS) {
      const hx = helix5({ eyes: { count: n, layout } });
      const f = buildFace(S.head, S.jaw, adult, hx, mats, "high");
      const eyes = eyesOf(f);
      assertEquals(eyes.length, n, `${n} ${layout}`);
      assertEquals(f.pupils.length, n, `${n} ${layout} pupils`);
      assertEquals(f.lids.length, n, `${n} ${layout} lids`);
      assertEquals(f.auraEmitters.length, n, `${n} ${layout} emitters`);
      for (const o of f.head) assert(finiteObj(o), `${n} ${layout} finite`);
      // Mirror symmetry: every eye has a mirror twin (x -> -x); odd counts put exactly one on the midline.
      const ps = eyes.map((e) => e.position);
      for (const p of ps) assert(ps.some((q) => Math.abs(q.x + p.x) < 1e-6 && Math.abs(q.y - p.y) < 1e-6 && Math.abs(q.z - p.z) < 1e-6), `${n} ${layout}: mirror twin`);
      assertEquals(ps.filter((p) => Math.abs(p.x) < 1e-6).length, n % 2, `${n} ${layout}: midline eyes`);
      for (let i = 0; i < eyes.length; i++) {
        for (let j = i + 1; j < eyes.length; j++) {
          const ri = eyes[i].userData.radius * Math.max(eyes[i].scale.x, eyes[i].scale.y);
          const rj = eyes[j].userData.radius * Math.max(eyes[j].scale.x, eyes[j].scale.y);
          assert(ps[i].distanceTo(ps[j]) >= ri + rj, `${n} ${layout}: eyes ${i}/${j} overlap`);
        }
      }
    }
  }
});

/** Head vertices in the eye's normalised frame (unit = eyeball radius x eye scale). */
function eyeLocal(headMesh: THREE.Mesh, eye: THREE.Object3D): THREE.Vector3[] {
  eye.updateMatrix();
  const inv = eye.matrix.clone().invert();
  const p = headMesh.geometry.attributes.position, r = eye.userData.radius as number;
  const out: THREE.Vector3[] = [];
  for (let i = 0; i < p.count; i++) out.push(new THREE.Vector3().fromBufferAttribute(p, i).applyMatrix4(inv).divideScalar(r));
  return out;
}

Deno.test("p5 face: eyes sit IN carved sockets - no head vertex inside an eyeball, socket floor dug behind it", () => {
  for (const [count, layout] of [[1, "cyclops"], [2, "pair"], [3, "arc"], [5, "cluster"], [8, "row"]] as [number, EyeLayout][]) {
    for (const socketDepth of [0, 0.5, 1]) {
      const hx = helix5({ eyes: { count, layout, socketDepth, brow: 0.8, scale: [1.2, 0.85, 1.1] } });
      const head = buildHead(S.head, adult, hx, mats, "high")[0] as THREE.Mesh;
      assertEquals(head.userData.sockets, count);
      const f = buildFace(S.head, S.jaw, adult, hx, mats, "high");
      for (const eye of eyesOf(f)) {
        const vs = eyeLocal(head, eye);
        for (const v of vs) assert(v.length() >= 1, `${count}/${socketDepth}: head vertex inside the eyeball (${v.length().toFixed(3)})`);
        // Carved: head vertices in the eye's footprint lie BEHIND the eyeball (the socket wall).
        const floor = vs.filter((v) => Math.hypot(v.x, v.y) < 0.6 && v.z < 0.5 && v.z > -2);
        assert(floor.length > 0 && floor.every((v) => v.z <= -0.75), `${count}/${socketDepth}: socket floor behind the eye`);
      }
    }
  }
});

Deno.test("p5 face: FALSIFIER - an uncarved ellipsoid head would swallow the embedded eyeballs", () => {
  const hx = helix5({ eyes: { socketDepth: 0.6 } });
  const f = buildFace(S.head, S.jaw, adult, hx, mats, "high");
  const H = headVolume(S.head);
  const g = new THREE.SphereGeometry(1, 40, 22);
  g.applyMatrix4(new THREE.Matrix4().makeScale(H.a, H.b, H.d));
  g.applyMatrix4(new THREE.Matrix4().makeBasis(H.f.side, H.f.up, H.f.fwd).setPosition(H.c));
  const plain = new THREE.Mesh(g);
  const inside = eyesOf(f).flatMap((e) => eyeLocal(plain, e)).filter((v) => v.length() < 0.98).length;
  assert(inside > 0, "the falsifier must really intersect");
});

Deno.test("p5 face: socketDepth sinks the eye, brow pushes the ridge out, babies have bigger eyes", () => {
  const at = (o: P5Over, ph = adult) => eyePlacements(S.head, ph, helix5(o))[1];
  const bulge = at({ eyes: { socketDepth: 0 } }), deep = at({ eyes: { socketDepth: 1 } });
  assert(deep.embed > bulge.embed * 2.5, `deep ${deep.embed} vs bulge ${bulge.embed}`);
  // Brow: the max outward displacement of head vertices vs a brow-less head.
  const H = headVolume(S.head);
  const rad = (m: THREE.Mesh) => {
    const p = m.geometry.attributes.position, v = new THREE.Vector3();
    let mx = 0;
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).sub(H.c);
      const k = Math.hypot(v.dot(H.f.side) / H.a, v.dot(H.f.up) / H.b, v.dot(H.f.fwd) / H.d);
      mx = Math.max(mx, k);
    }
    return mx;
  };
  const b0 = rad(buildHead(S.head, adult, helix5({ eyes: { brow: 0 } }), mats, "high")[0] as THREE.Mesh);
  const b1 = rad(buildHead(S.head, adult, helix5({ eyes: { brow: 1 } }), mats, "high")[0] as THREE.Mesh);
  assert(b0 < 1.001, `no brow: the head never grows (${b0})`);
  assert(b1 > 1.04, `brow ridge pushes out (${b1})`);
  // Neoteny: a hatchling's eyes are bigger than the adult's, more so with high neoteny.
  const baby = at({ growth: { neoteny: 1 } }, { ...S.ph, growth: 0.05 }), grown = at({ growth: { neoteny: 1 } });
  assert(baby.er > grown.er * 1.2, `baby eyes ${baby.er} vs adult ${grown.er}`);
  const lowN = at({ growth: { neoteny: 0 } }, { ...S.ph, growth: 0.05 });
  assert(baby.er > lowN.er, "neoteny enlarges baby eyes");
  // Spread / yaw / height move the eyes.
  const close = at({ eyes: { spread: 0, yaw: 0.05 } }), wide = at({ eyes: { spread: 1, yaw: 1.2 } });
  assert(wide.centre.x > close.centre.x + 0.1 * S.head.r0, "prey eyes wider apart");
  assert(wide.look.x > close.look.x + 0.3, "prey eyes look sideways");
  assert(at({ eyes: { height: 0.9 } }).centre.y > at({ eyes: { height: -0.5 } }).centre.y + 0.2 * S.head.r0, "height raises the eyes");
});

Deno.test("p5 face: eye outlines - non-round openings drawn on the 1.09 shell, mirrored per side", () => {
  const SHAPES: EyeShape[] = ["round", "almond", "tear", "crescent", "hooded", "diamond", "oval"];
  for (const sh of SHAPES) assert(insideOutline(sh, 0, 0.05, 1), `${sh} contains the centre`);
  assert(!insideOutline("almond", 0, 0.75, 1) && insideOutline("round", 0, 0.75, 1), "almond is narrower than round");
  assert(!insideOutline("diamond", 0.5, 0.45, 1) && insideOutline("round", 0.5, 0.45, 1), "diamond cuts the corners");
  assert(!insideOutline("hooded", 0, 0.5, 1) && insideOutline("round", 0, 0.5, 1), "hooded lid flattens the top");
  assert(insideOutline("tear", -0.55, -0.42, 1) !== insideOutline("tear", 0.55, -0.42, 1), "tear is asymmetric (inner corner droops)");
  for (const sh of SHAPES) {
    const f = buildFace(S.head, S.jaw, adult, helix5({ eyes: { shape: sh } }), mats, "low");
    for (const eye of eyesOf(f)) {
      const mask = eye.children.find((c) => c.userData.outline === sh) as THREE.Mesh;
      assert(mask, `${sh} mask`);
      const p = mask.geometry.attributes.position, r = eye.userData.radius as number;
      for (let i = 0; i < p.count; i++) {
        const k = Math.hypot(p.getX(i), p.getY(i), p.getZ(i)) / r;
        assert(Math.abs(k - 1.09) < 1e-4, `${sh}: mask vertex off its shell (${k})`);
      }
    }
  }
});

Deno.test("p5 face: beaks - five kinds, round beaks of several sizes, shovel flares, hooked droops", () => {
  const KINDS: Exclude<BeakKind, "none">[] = ["round", "hooked", "flat", "needle", "shovel"];
  for (const beak of KINDS) {
    const f = buildFace(S.head, S.jaw, adult, helix5({ mouth: { beak, beakLength: 0.4, beakRound: 0.6 } }, { mouth: { teeth: "beak" } }), mats, "high");
    const parts = [...f.head, ...f.jaw].filter((o) => o.userData.beak);
    assertEquals(parts.length, 2, `${beak}: upper + lower`);
    for (const o of parts) assert(finiteObj(o), `${beak} finite`);
    assertEquals(f.head.filter((o) => typeof o.userData.teeth === "number").length, 0, `${beak}: no teeth behind a beak`);
  }
  const len = (bl: number) => (buildFace(S.head, S.jaw, adult, helix5({ mouth: { beak: "round", beakLength: bl, beakRound: 0.9 } }), mats, "low").head.find((o) => o.userData.beak === "upper")!.userData.length as number);
  assert(len(0.45) > len(0.15) * 1.6, `round beak sizes ${len(0.15)} .. ${len(0.45)}`);
  const widthAt = (g: THREE.BufferGeometry, L: number, t: number) => {
    const p = g.attributes.position;
    let w = 0;
    for (let i = 0; i < p.count; i++) if (Math.abs(p.getZ(i) - t * L) < L * 0.06) w = Math.max(w, Math.abs(p.getX(i)));
    return w;
  };
  const shovel = beakGeometry("shovel", 1, 0.2, 0.7, "high");
  assert(widthAt(shovel, 1, 0.8) > widthAt(shovel, 1, 0.3) * 1.15, "shovel widens toward the tip");
  const needle = beakGeometry("needle", 1, 0.2, 0.05, "high"), round = beakGeometry("round", 1, 0.2, 0.95, "high");
  assert(widthAt(needle, 1, 0.5) < widthAt(round, 1, 0.5) * 0.5, "needle much thinner than round");
  assert(widthAt(round, 1, 0.9) > widthAt(needle, 1, 0.9) * 3, "round beak blunt at the tip");
  const hooked = beakGeometry("hooked", 1, 0.2, 0.4, "high");
  hooked.computeBoundingBox();
  assert(hooked.boundingBox!.min.y < -0.4, `hooked tip droops (${hooked.boundingBox!.min.y})`);
});

Deno.test("p5 face: tongue inside the jaw, forked option; mouth scale per axis; lips", () => {
  const tongueOf = (fork: boolean, tongueLength = 0.8) => buildFace(S.head, S.jaw, adult, helix5({ mouth: { tongueLength, tongueFork: fork } }), mats, "high").jaw.find((o) => o.userData.tongue) as THREE.Mesh;
  const tip = (m: THREE.Mesh) => {
    const p = m.geometry.attributes.position, L = m.userData.length as number;
    let minAbsX = Infinity;
    for (let i = 0; i < p.count; i++) if (p.getZ(i) > 0.9 * L) minAbsX = Math.min(minAbsX, Math.abs(p.getX(i)));
    return minAbsX;
  };
  const forked = tongueOf(true), plain = tongueOf(false);
  assert(forked.userData.fork === true && plain.userData.fork === false, "fork flag");
  assert(tip(forked) > 0.01 * S.jaw.r0, `forked tip has a gap at the midline (${tip(forked)})`);
  assert(tip(plain) < 1e-6, "plain tongue tip on the midline");
  assert(tongueOf(false, 0.3).userData.length < plain.userData.length, "tongueLength drives the tongue");
  assertEquals(buildFace(S.head, S.jaw, adult, helix5({ mouth: { tongueLength: 0 } }), mats, "high").jaw.filter((o) => o.userData.tongue).length, 0, "no tongue at 0");
  // The tongue stays inside the jaw's length.
  const J = jawVolume(S.jaw, helix5());
  forked.updateMatrix();
  const p = forked.geometry.attributes.position, v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i).applyMatrix4(forked.matrix).sub(J.c);
    assert(v.dot(J.f.fwd) <= J.d * 1.0001, "tongue tip inside the jaw length");
  }
  // Mouth scale: x widens the mouth and the jaw, y deepens the gape, z lengthens the jaw volume.
  const wide = buildFace(S.head, S.jaw, adult, helix5({ mouth: { scale: [1.35, 1, 1] } }), mats, "high");
  const narrow = buildFace(S.head, S.jaw, adult, helix5({ mouth: { scale: [0.75, 1, 1] } }), mats, "high");
  assert(wide.mouth.width > narrow.mouth.width * 1.3, `mouth x scale ${narrow.mouth.width} -> ${wide.mouth.width}`);
  const j0 = jawVolume(S.jaw, helix5({ mouth: { scale: [1, 1, 1] } })), j1 = jawVolume(S.jaw, helix5({ mouth: { scale: [1.3, 1.4, 1.2] } }));
  assert(Math.abs(j1.a / j0.a - 1.3) < 1e-9 && Math.abs(j1.b / j0.b - 1.4) < 1e-9 && Math.abs(j1.d / j0.d - 1.2) < 1e-9, "jaw volume scales per axis");
  const jm = buildJaw(S.jaw, helix5({ mouth: { scale: [1.3, 1.4, 1.2] } }), mats, "low")[0] as THREE.Mesh;
  jm.geometry.computeBoundingSphere();
  assert(jm.userData.jawVolume === true && finiteObj(jm), "jaw mesh");
  // Lips: a lip ridge without a beak; smile lifts the corners of the mouth line above its centre.
  const smile = buildFace(S.head, S.jaw, adult, helix5({ mouth: { lipCurve: 1 } }), mats, "high");
  const frown = buildFace(S.head, S.jaw, adult, helix5({ mouth: { lipCurve: -1 } }), mats, "high");
  assert(smile.head.some((o) => o.userData.lip !== undefined), "lips");
  const cornerLift = (f: ReturnType<typeof buildFace>) => {
    const line = f.head.find((o) => o.userData.mouthLine) as THREE.Mesh;
    line.geometry.computeBoundingBox();
    return line.geometry.boundingBox!.max.y;
  };
  assert(cornerLift(smile) > cornerLift(frown), "smile corners above frown corners");
});

Deno.test("p5 face: triangle budget - head + face + jaw under 6k (high) / 3.5k (low) for 1..8 eyes", () => {
  const worst = { high: 0, low: 0 };
  for (let n = 1; n <= 8; n++) {
    const hx = helix5({ eyes: { count: n, layout: n === 1 ? "cyclops" : n === 2 ? "pair" : "cluster" }, mouth: { tongueLength: 0.8, tongueFork: true } }, { mouth: { teeth: "fangs", teethCount: 6 } });
    for (const q of ["high", "low"] as const) {
      const f = buildFace(S.head, S.jaw, adult, hx, mats, q);
      const t = headTris([...buildHead(S.head, adult, hx, mats, q), ...buildJaw(S.jaw, hx, mats, q), ...f.head, ...f.jaw]);
      assert(t < (q === "high" ? 6000 : 3500), `${n} eyes ${q}: ${t} triangles`);
      worst[q] = Math.max(worst[q], t);
    }
  }
  console.log(`face triangles, worst case (6 fangs/side, forked tongue): high ${worst.high}, low ${worst.low}`);
});

Deno.test("p5 face: real helices from 300 genomes build finite heads and faces", () => {
  let built = 0;
  for (let s = 1; s <= 300; s++) {
    const g = createGenemon({ seed: s * 104729, level: 10 });
    const ph = phenotypeOf(g);
    const sk = buildSkeleton(ph);
    const head = sk.joints.find((j) => j.role === "head");
    if (!head) continue;
    const jaw = sk.joints.find((j) => j.role === "jaw" && j.parent === sk.joints.indexOf(head));
    const hx = helixOf(g.genome, ph);
    const f = buildFace(head, jaw, ph, hx, mats, "low");
    const h = buildHead(head, ph, hx, mats, "low");
    assertEquals(eyesOf(f).length, hx.p5!.eyes.count);
    for (const o of [...h, ...f.head, ...f.jaw]) assert(finiteObj(o), `seed ${s} finite`);
    built++;
  }
  assert(built > 200, `built ${built}`);
});

Deno.test("p5 eye aura: 8 eyes emit ~2x a pair, not 4x (sub-linear auraWeight)", () => {
  assertEquals([auraWeight(0), auraWeight(1), auraWeight(2)], [0, 1, 2]);
  assertEquals(auraWeight(8), 4);
  const run = (n: number) => {
    const em = Array.from({ length: n }, (_, i) => new THREE.Vector3(i * 0.01, 0, 0));
    const a = new EyeAura("smoke", em, 0.05, 0xffffff, "high");
    for (let i = 0; i < 60; i++) a.update(1 / 60, new THREE.Matrix4());
    const alive = a.alive();
    a.dispose();
    return alive;
  };
  const two = run(2), eight = run(8);
  assert(eight > two * 1.5 && eight < two * 3, `8 eyes ${eight} vs 2 eyes ${two}`);
});
