// Pass 6 lane render-complex [P6-C1 visuals, P6-E3/E4 visuals]: bodies driven by the complexity counts (from the
// one-eyed globe to the mythic colossus), evolution unlocks and forms (larva / cocoon / imago / molting), viable
// and inside the triangle budgets. Fixtures are hand-made (helix.p6 counts, ph.evo) so this lane does not depend
// on the genome / evolution producers' tuning.
import * as THREE from "../src/lib/three.ts";
import { assert, assertEquals } from "./_assert.ts";
import { BODY_KINDS, type BodyKind, randomGenome } from "../src/genome/genome.ts";
import { express, type Phenotype } from "../src/genome/phenotype.ts";
import { emptyConditions } from "../src/genome/epigenetics.ts";
import { helixOf } from "../src/genome/helix.ts";
import { type MorphHelix, P5_DEFAULTS } from "../src/genome/morphTypes.ts";
import type { BodyCounts, ComplexityTier, EvoState, MorphUnlock, PhaseForm } from "../src/genome/p6Types.ts";
import { bodyPlan6, buildSkeleton, clampCounts, constrainPose, type Skeleton, skeletonGenes } from "../src/body/skeleton.ts";
import { buildBody } from "../src/render/anatomy/body.ts";
import { buildFace, buildHead, buildJaw, eyeCountOf, eyePlacements } from "../src/render/anatomy/face.ts";
import { checkViability } from "../src/render/anatomy/viability.ts";
import { restPositions } from "../src/render/anatomy/hitbox.ts";
import { triCount } from "../src/render/anatomy/loft.ts";
import type { SkinMaterials } from "../src/render/anatomy/types.ts";

function mats(): SkinMaterials {
  const m = () => new THREE.MeshStandardMaterial();
  return { skin: m(), accent: m(), belly: m(), keratin: m(), membrane: m(), textures: [], baseEmissive: 0 };
}
const MATS = mats();

const counts = (c: Partial<BodyCounts>): BodyCounts => ({ eyes: 2, mouths: 1, heads: 1, wingPairs: 0, armPairs: 0, legPairs: 2, tentacles: 0, fingers: 4, tails: 1, ...c });
const MINIMAL = counts({ eyes: 1, legPairs: 0, tails: 0, fingers: 0 });
const WORST = counts({ eyes: 8, mouths: 2, heads: 1, wingPairs: 3, armPairs: 3, legPairs: 4, tentacles: 12, fingers: 7, tails: 3 });
const WORST2 = { ...WORST, heads: 2 };

function evoOf(form: PhaseForm, unlocks: MorphUnlock[] = [], phase = 1): EvoState {
  return { phase, phases: 5, form, name: form, kind: "gradual", unlocks, sizeMult: 1, progress: 0, level: 20, xpToNext: 100 };
}

interface Fx {
  ph: Phenotype;
  helix: MorphHelix;
  sk: Skeleton;
}
function fixture(kind: BodyKind, seed: number, o: { counts?: BodyCounts; tier?: ComplexityTier; evo?: EvoState; plan?: Record<string, number>; growth?: number } = {}): Fx {
  const g = randomGenome(seed, undefined, { kind, plan: o.plan ?? {} });
  const { evo: _e, ...ph0 } = express(g, emptyConditions());
  const ph: Phenotype = { ...ph0, growth: o.growth ?? 1, ...(o.evo ? { evo: o.evo } : {}) };
  const { p6: _p, ...hx0 } = helixOf(g, ph);
  const helix: MorphHelix = o.counts ? { ...hx0, p6: { version: 6, complexity: { score: 0.5, tier: o.tier ?? "common", oneIn: 3, counts: o.counts, colossal: o.tier === "mythic", colors: 3 } } } : hx0;
  return { ph, helix, sk: buildSkeleton(ph, skeletonGenes(helix)) };
}

/** Everything this lane builds for creature.ts: the body, every head and jaw volume, the first head's face. */
function buildAll(f: Fx, q: "low" | "high") {
  const body = buildBody(f.ph, f.sk, f.helix, MATS, q);
  let tris = body.triangles;
  const heads: THREE.Object3D[][] = [];
  const count = (objs: THREE.Object3D[]) => objs.forEach((o) => o.traverse((x) => ((x as THREE.Mesh).isMesh ? (tris += triCount((x as THREE.Mesh).geometry)) : 0)));
  f.sk.joints.forEach((j) => {
    if (j.role === "head") {
      const h = buildHead(j, f.ph, f.helix, MATS, q);
      heads.push(h);
      count(h);
    } else if (j.role === "jaw") count(buildJaw(j, f.helix, MATS, q));
  });
  const hi = f.sk.joints.findIndex((j) => j.role === "head");
  if (hi >= 0) {
    const ji = f.sk.joints.findIndex((j) => j.role === "jaw" && j.parent === hi);
    const face = buildFace(f.sk.joints[hi], ji >= 0 ? f.sk.joints[ji] : undefined, f.ph, f.helix, MATS, q);
    count([...face.head, ...face.jaw]);
  }
  return { body, tris, heads };
}

const sides = (sk: Skeleton, pred: (j: Skeleton["joints"][number]) => boolean) => sk.joints.filter((j) => j.side > 0 && pred(j)).length;
const meshes = (objs: THREE.Object3D[]) => {
  const out: THREE.Mesh[] = [];
  objs.forEach((o) => o.traverse((x) => (x as THREE.Mesh).isMesh && out.push(x as THREE.Mesh)));
  return out;
};

Deno.test("p6 render: no pass-6 data = the pass-5 skeleton, byte for byte; evo without unlocks keeps the same joints", () => {
  for (const kind of BODY_KINDS) {
    const f = fixture(kind, 5);
    const legacy = buildSkeleton(f.ph, f.helix.p5 ?? P5_DEFAULTS);
    assertEquals(f.sk.plan6, undefined);
    assertEquals(JSON.stringify(f.sk.joints), JSON.stringify(legacy.joints));
    const e = fixture(kind, 5, { evo: evoOf("juvenile") });
    assert(e.sk.plan6?.source === "evo", `${kind} evo plan`);
    // Same topology; same bones except that a pass-6 build never lets the first neck segment be swallowed
    // by the chest (it may only be LONGER than the pass-5 one).
    assertEquals(e.sk.joints.map((j) => `${j.id}:${j.role}:${j.parent}`).join("|"), legacy.joints.map((j) => `${j.id}:${j.role}:${j.parent}`).join("|"));
    e.sk.joints.forEach((j, i) => {
      if (j.role === "neck" || j.role === "head" || j.role === "jaw" || j.role === "horn" || j.role === "ear") assert(j.id !== "neck0" || j.length >= legacy.joints[i].length - 1e-9, `${kind} neck0`);
      else assertEquals(j.length.toFixed(6), legacy.joints[i].length.toFixed(6), `${kind} ${j.id}`);
    });
  }
});

Deno.test("p6 render: the minimal GLOBE is one round body with one eye and a small toothless mouth, whatever the kind", () => {
  for (const kind of BODY_KINDS) {
    const f = fixture(kind, 9, { counts: MINIMAL, tier: "minimal" });
    assert(f.sk.plan6!.globe, `${kind} globe`);
    assertEquals(f.sk.kind, "blob");
    assertEquals(f.sk.joints.map((j) => j.role).join(","), "root,head");
    const head = f.sk.joints[1];
    assertEquals(eyeCountOf(head, f.helix), 1);
    const face = buildFace(head, undefined, f.ph, f.helix, MATS, "high");
    assertEquals(face.head.filter((o) => o.userData.eye).length, 1);
    assertEquals(face.head.filter((o) => typeof o.userData.teeth === "number" || o.userData.beak).length, 0, "no teeth / beak");
    // The head volume IS the globe: its ellipsoid has radius ~ the height / 2 and sits on the ground.
    const rest = restPositions(f.sk)[1];
    const cy = rest[1] + head.dir[1] * head.length * 0.45;
    assert(Math.abs(cy - 0.95 * head.r0) < 0.03 * f.sk.height, `${kind} globe bottom on the ground: centre ${cy} r ${head.r0}`);
    const all = buildAll(f, "high");
    assert(checkViability(f.sk, all.body).ok, `${kind} globe viable`);
    assert(all.tris < 6000, `globe tris ${all.tris}`);
  }
});

Deno.test("p6 render: counts drive the skeleton (legs, arms with hands, wings, tails, tentacles) on every kind", () => {
  for (const kind of BODY_KINDS) {
    const f = fixture(kind, 12, { counts: WORST, tier: "mythic" });
    const sk = f.sk;
    assertEquals(sides(sk, (j) => j.role === "wingRoot"), 3, `${kind} wing pairs`);
    assertEquals(sides(sk, (j) => j.role === "shoulder" && j.chain.startsWith("arm")), 3, `${kind} arm pairs`);
    assertEquals(sides(sk, (j) => j.role === "wrist" && j.chain.startsWith("arm")), 3, `${kind} hands`);
    const mains = sk.joints.filter((j) => j.role === "pod" && j.chain.startsWith("tent") && !j.chain.endsWith("b")).length;
    assertEquals(mains, 12, `${kind} tentacles`);
    assert(sk.joints.some((j) => j.chain.endsWith("b") && j.chain.startsWith("tent")), `${kind} fractal tentacle branches`);
    const tailChains = new Set(sk.joints.filter((j) => j.role === "tail").map((j) => j.chain)).size + (sk.kind === "serpent" ? 1 : 0);
    assertEquals(tailChains, 3, `${kind} tails`);
    const legs = sides(sk, (j) => (j.role === "hip" || j.role === "shoulder") && j.chain.startsWith("leg"));
    const want = kind === "blob" ? 0 : kind === "biped" || kind === "avian" ? 4 : 4;
    if (kind !== "blob") assertEquals(legs, want, `${kind} leg pairs`);
    // The animator understands every new joint: roles it already drives, chains with budgets.
    for (const j of sk.joints) if (j.role === "tail" || j.role === "neck") assert(sk.chains[j.chain], `${kind} ${j.id} chain budget`);
    const r = constrainPose(sk, Object.fromEntries(sk.joints.map((j) => [j.id, [0.3, 0.3, 0.3]])));
    assert(Number.isFinite(r.strain), "constrainPose finite");
    // Hands carry the counted 7 fingers (a fractal-hand gene replaces fingers by a fractal: pass-5 rule).
    const af = f.helix.p5?.body.armFractal;
    const noFractal = { ...f, helix: { ...f.helix, p5: { ...(f.helix.p5 ?? P5_DEFAULTS), body: { ...(f.helix.p5 ?? P5_DEFAULTS).body, armFractal: { ...(af ?? P5_DEFAULTS.body.armFractal), mode: "none" as const } } } } };
    const body = buildBody(noFractal.ph, sk, noFractal.helix, MATS, "low");
    const wrist = sk.joints.findIndex((j) => j.role === "wrist" && j.chain.startsWith("arm"));
    const digits = (body.perJoint.get(wrist) ?? []).find((o) => typeof o.userData.digits === "number");
    assertEquals(digits?.userData.digits, 7, `${kind} fingers`);
  }
});

Deno.test("p6 render: mythic faces: 8 complex eyes (eye crown / compound clusters) and a second mouth (chest maw or second head)", () => {
  const f = fixture("quadruped", 14, { counts: WORST, tier: "mythic" });
  const head = f.sk.joints.find((j) => j.role === "head")!;
  assertEquals(eyeCountOf(head, f.helix), 8);
  assert(head.face!.complex, "complex eyes");
  const eyes = eyePlacements(head, f.ph, f.helix);
  assertEquals(eyes.length, 8);
  for (let i = 0; i < eyes.length; i++) for (let k = i + 1; k < eyes.length; k++) assert(eyes[i].centre.distanceTo(eyes[k].centre) > 1.05 * (eyes[i].er + eyes[k].er), "eyes do not overlap");
  const face = buildFace(head, undefined, f.ph, f.helix, MATS, "high");
  let rings = 0;
  for (const o of face.head) o.traverse((x) => x.userData.limbal && rings++);
  assertEquals(rings, 8, "a limbal ring on every complex eye");
  const all = buildAll(f, "high");
  const maws = [...all.body.perJoint.values()].flat().filter((o) => o.userData.maw);
  assertEquals(maws.length, 1, "chest maw");
  assert((all.body.materials ?? []).length === 1, "maw throat material returned for disposal");
  // Two heads: the second mouth is the second head's; eyes split 6 + 2; the second head carries its own face.
  const t = fixture("biped", 14, { counts: WORST2, tier: "mythic" });
  const heads = t.sk.joints.filter((j) => j.role === "head");
  assertEquals(heads.map((h) => h.id).join(","), "head,head_2");
  assert(t.sk.index.has("jaw_2") && t.sk.index.has("neck0_2"), "jaw_2 / neck_2");
  assertEquals(heads.map((h) => eyeCountOf(h, t.helix)).join("+"), "6+2");
  const h2 = buildHead(heads[1], t.ph, t.helix, MATS, "low");
  assertEquals(h2.filter((o) => o.userData.eye).length, 2, "second head eyes");
  assert(h2.some((o) => o.userData.mouthLine), "second head mouth");
  assertEquals([...buildBody(t.ph, t.sk, t.helix, MATS, "low").perJoint.values()].flat().filter((o) => o.userData.maw).length, 0, "no chest maw with two heads");
  // The two heads do not overlap.
  const rp = restPositions(t.sk);
  const c = heads.map((h) => new THREE.Vector3(...rp[t.sk.index.get(h.id)!]).addScaledVector(new THREE.Vector3(...h.dir), 0.45 * h.length));
  assert(c[0].distanceTo(c[1]) > 1.6 * heads[0].r0, `heads apart ${c[0].distanceTo(c[1])} vs r ${heads[0].r0}`);
});

Deno.test("p6 render: evolution forms: larva grub, closed cocoon, winged imago", () => {
  const larva = fixture("hexapod", 16, { evo: evoOf("larva") });
  assertEquals(larva.sk.kind, "serpent");
  assert(larva.sk.joints.filter((j) => j.chain === "body").length >= 7, "segmented body");
  assertEquals(sides(larva.sk, (j) => j.role.startsWith("wing")), 0);
  assertEquals(sides(larva.sk, (j) => j.role === "hip" || j.role === "shoulder"), 5, "3 thoracic pairs + 2 prolegs");
  assertEquals(larva.sk.joints.filter((j) => j.role === "horn" || j.role === "ear").length, 0, "bare larval head");
  const body = larva.sk.joints.filter((j) => j.chain === "body");
  for (const j of larva.sk.joints.filter((x) => x.role === "hip" || x.role === "knee")) assert(j.length < body[0].r0, `${j.id} tiny leg`);
  const cocoon = fixture("hexapod", 16, { evo: evoOf("cocoon") });
  assertEquals(cocoon.sk.joints.length, 3);
  assert(!cocoon.sk.joints.some((j) => j.role === "head" || j.role === "hip" || j.role.startsWith("wing")), "no head, no limbs");
  const imago = fixture("hexapod", 16, { evo: evoOf("imago"), plan: { wings: 0.1 } });
  assert(sides(imago.sk, (j) => j.role === "wingRoot") >= 1, "imago wings");
  for (const f of [larva, cocoon, imago]) assert(checkViability(f.sk, buildBody(f.ph, f.sk, f.helix, MATS, "high")).ok, `${f.sk.plan6!.form} viable`);
});

Deno.test("p6 render: armour+ grows plates, molting cracks them into separate rooted pieces, armorShed removes them", () => {
  const shellsOf = (f: Fx) => [...buildBody(f.ph, f.sk, f.helix, MATS, "high").perJoint.values()].flat().filter((o) => o.userData.shell);
  const armoured = fixture("quadruped", 21, { evo: evoOf("adult", ["armor+"]) });
  const molting = fixture("quadruped", 21, { evo: evoOf("molting", ["armor+"]) });
  const shed = fixture("quadruped", 21, { evo: evoOf("adult", ["armor+", "armorShed"]) });
  const trunk = armoured.sk.joints.filter((j) => j.chain === "spine").length;
  assertEquals(shellsOf(armoured).length, trunk, "one plate per trunk joint");
  assertEquals(shellsOf(molting).length, 4 * trunk, "four cracked pieces per trunk joint");
  assertEquals(shellsOf(shed).length, 0, "shed");
  const thick = fixture("quadruped", 21, { evo: evoOf("adult", ["armor+", "armor+", "armor+"]) });
  const h = (f: Fx) => shellsOf(f).reduce((s, o) => s + new THREE.Box3().setFromObject(o).getSize(new THREE.Vector3()).y, 0);
  assert(h(thick) > h(armoured), "armor+ thickens");
  // Every cracked piece is its own mesh and each one is rooted (the viability check sees them one by one).
  const parts = buildBody(molting.ph, molting.sk, molting.helix, MATS, "high");
  const v = checkViability(molting.sk, parts);
  assert(v.ok, `molting viable ${JSON.stringify(v.floating)} ${JSON.stringify(v.buried)}`);
  // ...and the check can FAIL on them: lift one piece off the back.
  const piece = [...parts.perJoint.values()].flat().find((o) => o.userData.shell)!;
  piece.position.x += 3 * molting.sk.height;
  const bad = checkViability(molting.sk, parts);
  assert(bad.floating.some((x) => x.mesh === piece.name), "a lifted shell piece is reported floating");
});

Deno.test("p6 render: gradual unlocks: neck+ lengthens the neck, wings+ grows the span, pairs / fingers / horns add parts", () => {
  const base = { plan: { wings: 0.1, neck: 0.4, horns: 0.6 } };
  const neckLen = (f: Fx) => f.sk.joints.filter((j) => j.role === "neck").reduce((s, j) => s + j.length, 0);
  const span = (f: Fx) => f.sk.joints.filter((j) => j.role.startsWith("wing") && j.side > 0 && !j.pair).reduce((s, j) => s + j.length, 0);
  const p1 = fixture("quadruped", 31, { ...base, evo: evoOf("juvenile") });
  const p3 = fixture("quadruped", 31, { ...base, evo: evoOf("adult", ["neck+", "wings+"]) });
  const p5 = fixture("quadruped", 31, { ...base, evo: evoOf("prime", ["neck+", "wings+", "neck+", "wings+", "horns+"]) });
  assert(neckLen(p3) > 1.5 * neckLen(p1) && neckLen(p5) > 1.3 * neckLen(p3), `neck ${neckLen(p1)} ${neckLen(p3)} ${neckLen(p5)}`);
  assertEquals(span(p1), 0);
  assert(span(p5) > 1.3 * span(p3) && span(p3) > 0, `wings ${span(p3)} ${span(p5)}`);
  const horns = (f: Fx) => f.sk.joints.filter((j) => j.role === "horn");
  assert(horns(p5).length > horns(p3).length || horns(p5)[0].length > horns(p3)[0].length, "horns+");
  const plain = fixture("biped", 33, { evo: evoOf("adult") });
  const pairs = fixture("biped", 33, { evo: evoOf("adult", ["armPair+", "wingPair+", "wingPair+", "fingers+", "fingers+"]) });
  assertEquals(sides(pairs.sk, (j) => j.role === "shoulder" && j.chain.startsWith("arm")), 2);
  assertEquals(sides(pairs.sk, (j) => j.role === "wingRoot"), sides(plain.sk, (j) => j.role === "wingRoot") + 2, "wingPair+ x2");
  const body = buildBody(pairs.ph, pairs.sk, pairs.helix, MATS, "low");
  const wrist = pairs.sk.joints.findIndex((j) => j.role === "wrist");
  const d = (body.perJoint.get(wrist) ?? []).find((o) => typeof o.userData.digits === "number");
  if (!pairs.helix.p5 || pairs.helix.p5.body.armFractal.mode === "none" || pairs.helix.p5.body.armFractal.depth < 1) assertEquals(d?.userData.digits, Math.min(7, Math.round(pairs.helix.digits) + 2), "fingers+");
  for (const f of [p1, p3, p5, pairs]) assert(checkViability(f.sk, buildBody(f.ph, f.sk, f.helix, MATS, "low")).ok, "viable");
});

/** Deterministic pseudo-random counts inside the contract ranges. */
function randomCounts(seed: number): BodyCounts {
  let s = seed * 2654435761 >>> 0;
  const r = () => ((s = (Math.imul(s ^ (s >>> 15), 2246822507) + 0x9e3779b9) >>> 0) / 4294967296);
  return clampCounts({ eyes: 1 + r() * 7, mouths: 1 + r(), heads: r() < 0.25 ? 2 : 1, wingPairs: r() * 3, armPairs: r() * 3, legPairs: r() * 4, tentacles: r() * 12, fingers: r() * 7, tails: r() * 3 });
}

Deno.test("p6 render: viability stays green across kinds, seeds, random counts, growth and forms", () => {
  let n = 0;
  const forms: (EvoState | undefined)[] = [undefined, evoOf("larva"), evoOf("cocoon"), evoOf("imago"), evoOf("molting", ["armor+"]), evoOf("adult", ["neck+", "wingPair+", "armPair+", "tail+", "tentacles+", "horns+", "mouth+"])];
  for (const kind of BODY_KINDS) {
    for (let s = 1; s <= 5; s++) {
      const c = randomCounts(s * 31 + kind.length);
      const f = fixture(kind, 100 + s, { counts: c, tier: s === 1 ? "minimal" : "complex", evo: forms[s % forms.length], growth: s === 2 ? 0.3 : 1 });
      const v = checkViability(f.sk, buildBody(f.ph, f.sk, f.helix, MATS, "low"));
      assert(v.ok, `${kind}/${s} ${JSON.stringify(c)} form ${f.sk.plan6?.form}: floating ${v.floating.map((x) => x.mesh)} buried ${v.buried.map((x) => x.mesh)}`);
      n++;
    }
  }
  assertEquals(n, BODY_KINDS.length * 5);
});

Deno.test("p6 render: triangle budgets: normal < 40k / 15k, colossus (worst-case counts) < 60k / 20k", () => {
  let worstN = [0, 0], worstC = [0, 0];
  for (const kind of BODY_KINDS) {
    for (let s = 1; s <= 3; s++) {
      for (const evo of [undefined, evoOf("adult", ["neck+", "wings+", "wingPair+", "horns+", "armor+", "fingers+"]), evoOf("larva"), evoOf("molting", ["armor+"])]) {
        const f = fixture(kind, 200 + s, { evo, counts: counts({ legPairs: kind === "hexapod" ? 3 : kind === "quadruped" ? 2 : 1, wingPairs: 1, armPairs: kind === "biped" ? 1 : 0, eyes: 4 }), tier: "complex" });
        const hi = buildAll(f, "high").tris, lo = buildAll(f, "low").tris;
        worstN = [Math.max(worstN[0], hi), Math.max(worstN[1], lo)];
        assert(hi < 40000 && lo < 15000, `normal ${kind}/${s} ${f.sk.plan6?.form}: high ${hi} low ${lo}`);
      }
      for (const c of [WORST, WORST2]) {
        // Seeds 401..403 include the measured worst cases; odd seeds add horns / ears / spikes on top.
        const f = fixture(kind, 400 + s + (kind === "avian" ? 2 : 0), { counts: c, tier: "mythic", plan: s % 2 ? { horns: 1, ears: 1, spikes: 1 } : {} });
        const hi = buildAll(f, "high").tris, lo = buildAll(f, "low").tris;
        worstC = [Math.max(worstC[0], hi), Math.max(worstC[1], lo)];
        assert(hi < 60000 && lo < 20000, `colossus ${kind}/${s} heads ${c.heads}: high ${hi} low ${lo}`);
      }
    }
  }
  console.log(`worst normal: high ${worstN[0]} low ${worstN[1]}; worst colossus: high ${worstC[0]} low ${worstC[1]}`);
});

Deno.test("p6 render: a colossus's hands and hanging tentacles stay above the ground; the plan is deterministic", () => {
  for (const kind of BODY_KINDS) {
    const f = fixture(kind, 41, { counts: WORST, tier: "mythic" });
    const rp = restPositions(f.sk);
    const body = buildBody(f.ph, f.sk, f.helix, MATS, "low");
    body.perJoint.forEach((objs, i) => {
      const j = f.sk.joints[i];
      if (!j.chain.startsWith("arm")) return;
      for (const m of meshes(objs)) {
        const bb = new THREE.Box3().setFromBufferAttribute(m.geometry.getAttribute("position") as THREE.BufferAttribute);
        assert(rp[i][1] + bb.min.y > -0.02 * f.sk.height, `${kind} ${m.name} below ground: ${rp[i][1] + bb.min.y}`);
      }
    });
    const again = fixture(kind, 41, { counts: WORST, tier: "mythic" });
    assertEquals(JSON.stringify(again.sk.joints), JSON.stringify(f.sk.joints));
    assertEquals(JSON.stringify(bodyPlan6(f.ph, skeletonGenes(f.helix))), JSON.stringify(f.sk.plan6));
  }
});
