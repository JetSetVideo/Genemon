// Body-morph lane (pass 5, P5-V2 / V3 / V5 / V6): growth bands + neoteny + fetal spiral, egg, morph operators,
// viability (connectivity / burial, with falsifiers), shoulders, limb variation, fractal arms, tentacles,
// serpent legs, tail shapes, element curvature, triangle budgets over many seeds. Helices are built BY HAND
// (the helix lane derives p5 concurrently).
import * as THREE from "../src/lib/three.ts";
import { assert, assertAlmostEquals, assertEquals } from "./_assert.ts";
import { BODY_KINDS, type BodyKind, randomGenome } from "../src/genome/genome.ts";
import { express, type Phenotype } from "../src/genome/phenotype.ts";
import { emptyConditions } from "../src/genome/epigenetics.ts";
import { Rng } from "../src/core/rng.ts";
import { babyFactor, bandValue, buildSkeleton, forwardKinematics, geneBand, GROWTH_LIMITS, type Skeleton } from "../src/body/skeleton.ts";
import { helixOf } from "../src/genome/helix.ts";
import { type MorphHelix, type MorphOp, type MorphOpKind, type MorphP5, P5_DEFAULTS, type TailShape } from "../src/genome/morphTypes.ts";
import type { SkinMaterials } from "../src/render/anatomy/types.ts";
import { buildBody, effectiveAngularity } from "../src/render/anatomy/body.ts";
import { buildFace } from "../src/render/anatomy/face.ts";
import { clampExponent, EXP_MAX, EXP_MIN, maxRingTurn, safeSection, type Section, sectionRing, triCount } from "../src/render/anatomy/loft.ts";
import { applyOps, OP_LIMITS, opsFor } from "../src/render/anatomy/ops.ts";
import { fractalPieces, resolution } from "../src/render/anatomy/limbs.ts";
import { checkViability } from "../src/render/anatomy/viability.ts";
import { buildEgg, curlAmount, eggFit, eggGeometry, fetusPose } from "../src/render/anatomy/egg.ts";
import { hitSpheres, restPositions } from "../src/render/anatomy/hitbox.ts";

function mats(): SkinMaterials {
  const m = () => new THREE.MeshStandardMaterial();
  return { skin: m(), accent: m(), belly: m(), keratin: m(), membrane: m(), textures: [], baseEmissive: 0 };
}

const TAILS: TailShape[] = ["taper", "club", "fin", "fan", "spade", "whip", "flame", "leaf", "rattle", "split"];
const OPS: MorphOpKind[] = ["carve", "merge", "compress", "decompress", "difference", "twist", "bulge", "pinch"];

function p5With(f: (p: MorphP5) => void): MorphP5 {
  const p = structuredClone(P5_DEFAULTS);
  f(p);
  return p;
}

/** A random but VALID pass-5 gene set (what the helix lane may produce, extremes included). */
function randomP5(seed: number): MorphP5 {
  const r = new Rng(seed);
  return p5With((p) => {
    const lo = r.range(0.75, 1), hi = r.range(1, 1.3);
    p.growth = {
      length: { lo, hi },
      strength: { lo: r.range(0.75, 1), hi: r.range(1, 1.3) },
      angle: { lo: r.range(-0.3, 0), hi: r.range(0, 0.3) },
      spiral: r.range(0.6, 1.6),
      neoteny: r.next(),
    };
    p.body = {
      shoulder: { width: r.range(0.8, 1.3), height: r.range(0.8, 1.3), hump: r.chance(0.3) ? r.range(0, 1) : 0 },
      tail: { shape: r.pick(TAILS), length: r.range(0.5, 2), curl: r.range(-1, 1), tipSize: r.range(0.5, 2) },
      armFractal: { depth: r.int(0, 4), branch: r.int(1, 4), ratio: r.range(0.35, 0.85), twist: r.range(-1, 1), mode: r.pick(["none", "branch", "spiral", "mandelbrot"] as const) },
      limbStyle: r.pick(["legs", "tentacles", "fins", "stumps"] as const),
      serpentLegs: r.int(0, 2),
      limbVariation: r.chance(0.3) ? r.range(0, 0.25) : 0,
      curvature: r.range(-1, 1),
      ops: Array.from({ length: r.int(0, 4) }, () => ({
        kind: r.pick(OPS),
        region: r.pick(["torso", "neck", "tail", "limb", "all", "head"] as const),
        u: r.next(),
        amount: r.range(-1, 1),
        width: r.range(0.05, 0.5),
        angle: r.range(-Math.PI, Math.PI),
      })),
    };
  });
}

function creature(kind: BodyKind, seed: number, growth: number, plan: Record<string, number> = {}): { ph: Phenotype; g: ReturnType<typeof randomGenome> } {
  const g = randomGenome(seed, undefined, { kind, plan });
  // Pass 6: these are PASS-5 invariants; the evolution phase (ph.evo: larva / cocoon forms, unlocks) changes
  // the build on purpose and is covered by tests/complex_p6_test.ts.
  const { evo: _evo, ...ph } = express(g, emptyConditions());
  return { ph: { ...ph, growth }, g };
}

function helixWith(g: ReturnType<typeof randomGenome>, ph: Phenotype, p5: MorphP5): MorphHelix {
  return { ...helixOf(g, ph), p5 };
}

function finite(geo: THREE.BufferGeometry): boolean {
  const a = geo.getAttribute("position");
  for (let i = 0; i < a.count * 3; i++) if (!Number.isFinite((a.array as ArrayLike<number>)[i])) return false;
  return true;
}

function faceTris(sk: Skeleton, ph: Phenotype, hx: MorphHelix, q: "low" | "high"): number {
  const hi = sk.joints.findIndex((j) => j.role === "head");
  if (hi < 0) return 0;
  const ji = sk.joints.findIndex((j) => j.role === "jaw" && j.parent === hi);
  const f = buildFace(sk.joints[hi], ji >= 0 ? sk.joints[ji] : undefined, ph, hx, mats(), q);
  let n = 0;
  for (const o of [...f.head, ...f.jaw]) o.traverse((x) => {
    const m = x as THREE.Mesh;
    if (m.isMesh) n += triCount(m.geometry);
  });
  return n;
}

// ------------------------------------------------------------------ P5-V2 growth

Deno.test("growth: a legacy call (no genes) builds the legacy skeleton: no dev, no node growth", () => {
  const { ph } = creature("quadruped", 3, 0.4);
  const a = buildSkeleton(ph), b = buildSkeleton(ph, undefined);
  assertEquals(a.dev, undefined);
  assert(a.joints.every((j) => j.grow === undefined), "no grow on legacy joints");
  assertEquals(JSON.stringify(a.joints), JSON.stringify(b.joints));
});

Deno.test("growth: every node's length / strength / bend lies in its GrowthGenes band, and the band IS applied", () => {
  let checked = 0;
  for (const kind of BODY_KINDS) {
    for (let seed = 1; seed <= 6; seed++) {
      for (const growth of [0, 0.1, 0.5, 1]) {
        const { ph } = creature(kind, seed, growth, { horns: 0.8, ears: 0.8 });
        const genes = randomP5(seed * 31 + kind.length);
        const sk = buildSkeleton(ph, genes);
        // Neutral bands, same neoteny / body: the ratio of the two skeletons isolates the band multipliers.
        const neutral = buildSkeleton(ph, p5With((p) => {
          p.growth = { ...genes.growth, length: { lo: 1, hi: 1 }, strength: { lo: 1, hi: 1 }, angle: { lo: 0, hi: 0 } };
          p.body = genes.body;
        }));
        assertEquals(sk.joints.length, neutral.joints.length);
        const [lL, lH] = geneBand(genes.growth.length, GROWTH_LIMITS.length);
        const [sL, sH] = geneBand(genes.growth.strength, GROWTH_LIMITS.strength);
        const [aL, aH] = geneBand(genes.growth.angle, GROWTH_LIMITS.angle);
        sk.joints.forEach((j, i) => {
          const gr = j.grow!;
          assert(gr.length >= lL - 1e-9 && gr.length <= lH + 1e-9, `${kind} ${j.id} length ${gr.length} not in [${lL}, ${lH}]`);
          assert(gr.strength >= sL - 1e-9 && gr.strength <= sH + 1e-9, `${kind} ${j.id} strength`);
          assert(gr.bend >= aL - 1e-9 && gr.bend <= aH + 1e-9, `${kind} ${j.id} bend`);
          const n = neutral.joints[i];
          // Sizes derived from an already-scaled parent: the jaw (head length), horn / ear radii (head radius),
          // serpent legs (segment radius), bones lengthened to emerge from their parent (atLeast).
          if (j.role === "jaw" || j.chain.startsWith("leg-s")) return;
          if (j.role !== "horn" && j.role !== "ear") assertAlmostEquals(j.r0 / n.r0, gr.strength, 1e-6, `${kind} ${j.id} applied strength`);
          const lr = j.length / n.length;
          if (Math.abs(lr - gr.length) > 1e-6) {
            // Only the emerge rule may change a length, and only to keep the node at a minimum size.
            assert(["tail0", "neck0"].includes(j.id) || /hip|shoulder|knee|tip$/.test(j.id), `${kind} ${j.id} applied length ${lr} vs ${gr.length}`);
          } else checked++;
        });
      }
    }
  }
  assert(checked > 2000, `checked ${checked}`);
});

Deno.test("growth: band expression is lo + (hi - lo) * smoothstep(drive), with ordered bands and safety limits", () => {
  assertEquals(bandValue({ lo: 0.8, hi: 1.2 }, GROWTH_LIMITS.length, 0), 0.8);
  assertEquals(bandValue({ lo: 0.8, hi: 1.2 }, GROWTH_LIMITS.length, 1), 1.2);
  assertAlmostEquals(bandValue({ lo: 0.8, hi: 1.2 }, GROWTH_LIMITS.length, 0.5), 1, 1e-12);
  assertEquals(geneBand({ lo: 1.2, hi: 0.8 }, GROWTH_LIMITS.length), [0.8, 1.2]);
  assertEquals(geneBand({ lo: -5, hi: 9 }, GROWTH_LIMITS.length), [0.5, 1.6]);
  assert(Number.isFinite(bandValue({ lo: Number.NaN, hi: 1 }, GROWTH_LIMITS.length, 0.3)), "NaN gene stays finite");
});

Deno.test("neoteny: babies have a bigger head, shorter thicker limbs; the baby features fade with growth (later with neoteny)", () => {
  for (const kind of ["quadruped", "biped", "hexapod", "avian"] as const) {
    // Neutral bands isolate neoteny (the default bands also make a baby a little weaker).
    const genes = p5With((p) => (p.growth = { ...p.growth, neoteny: 0.6, length: { lo: 1, hi: 1 }, strength: { lo: 1, hi: 1 } }));
    const at = (growth: number) => {
      const { ph } = creature(kind, 5, growth);
      const sk = buildSkeleton(ph, genes);
      const head = sk.joints.find((j) => j.role === "head")!;
      const legs = sk.joints.filter((j) => j.role === "knee");
      const legLen = legs.reduce((s, j) => s + j.length, 0) / legs.length;
      const legR = legs.reduce((s, j) => s + j.r0, 0) / legs.length;
      return { head: head.r0 / sk.height, legLen: legLen / sk.height, legR: legR / legLen, baby: sk.dev!.baby };
    };
    const b = at(0.02), a = at(1);
    assert(b.baby > 0.95 && a.baby === 0, `${kind} baby ${b.baby} -> ${a.baby}`);
    assert(b.head > a.head * 1.25, `${kind} head ${b.head} vs ${a.head}`);
    assert(b.legLen < a.legLen * 0.85, `${kind} legs ${b.legLen} vs ${a.legLen}`);
    assert(b.legR > a.legR * 1.3, `${kind} limb thickness ${b.legR} vs ${a.legR}`);
  }
  // Neoteny holds baby proportions longer.
  assert(babyFactor(0.5, 1) > babyFactor(0.5, 0) + 0.3, "neoteny delays");
  for (let g = 0; g < 1; g += 0.1) assert(babyFactor(g + 0.1, 0.4) <= babyFactor(g, 0.4) + 1e-12, "monotone fade");
});

Deno.test("fetus: the curled spiral uses spiral x 2pi turns, uncurls monotonically with growth, and the egg encloses it", () => {
  for (const kind of BODY_KINDS) {
    const { ph } = creature(kind, 8, 0.05, { tail: 0.8 });
    const sk = buildSkeleton(ph, P5_DEFAULTS);
    for (const spiral of [0.6, 1, 1.6]) {
      const pose = fetusPose(sk, 0, spiral);
      // Summed |rotation| on the curl path equals the requested turns.
      const path = sk.joints.filter((j) =>
        kind === "serpent" ? (j.role === "root" || (j.role === "segment" && j.chain === "body")) : ["spine", "chest", "neck", "head", "tail"].includes(j.role) || (j.role === "segment" && (j.chain === "abdomen" || j.chain === "stack"))
      );
      const sum = path.reduce((s, j) => s + Math.abs((pose[j.id] ?? [0, 0, 0])[kind === "serpent" ? 1 : 0]), 0);
      assertAlmostEquals(sum, spiral * 2 * Math.PI * curlAmount(0), 1e-6, `${kind} spiral ${spiral}`);
    }
    // Curled into a ball: the enclosing egg of the fetus is much smaller than the uncurled body's.
    const size = (g: number) => eggFit(sk, fetusPose(sk, g, 1.2)).width;
    // (A blob is already a ball: nothing to curl but its pods.)
    if (kind !== "blob") assert(size(0) < 0.8 * size(1), `${kind} curls: egg ${size(0).toFixed(3)} vs uncurled ${size(1).toFixed(3)}`);
    if (kind !== "blob") assert(size(0) <= size(0.5) + 1e-9 && size(0.5) <= size(1) + 1e-9, `${kind} uncurls as it grows`);
    let prev = Infinity;
    for (let g = 0; g <= 1.0001; g += 0.1) {
      const c = curlAmount(g);
      assert(c <= prev + 1e-12, "monotone uncurl");
      prev = c;
    }
    assertEquals(Object.keys(fetusPose(sk, 1, 1)).length, 0, "fully grown = no curl");
    // Egg fit: every joint point is inside the egg ellipsoid.
    const pose = fetusPose(sk, 0.1, 1);
    const egg = eggFit(sk, pose);
    const fk = forwardKinematics(sk, pose);
    for (const p of [...fk.pos, ...fk.end]) {
      const dx = (p.x - egg.center[0]) / (egg.width / 2), dy = (p.y - egg.center[1]) / (egg.height / 2), dz = (p.z - egg.center[2]) / (egg.width / 2);
      assert(Math.hypot(dx, dy, dz) <= 1.0001, `${kind} joint outside the egg`);
    }
    assertAlmostEquals(egg.lift + egg.center[1] - egg.height / 2, 0, 1e-9, "lift rests the egg on the ground");
  }
});

Deno.test("egg: shell geometry is finite, vertex-coloured, seeded (same seed same egg; another seed differs)", () => {
  const a = eggGeometry(0.4, 0.52, 0xff6633, 42, "high"), b = eggGeometry(0.4, 0.52, 0xff6633, 42, "high"), c = eggGeometry(0.4, 0.52, 0xff6633, 43, "high");
  assert(finite(a), "finite");
  const ca = a.getAttribute("color").array as Float32Array, cb = b.getAttribute("color").array as Float32Array, cc = c.getAttribute("color").array as Float32Array;
  assertEquals(Array.from(ca), Array.from(cb));
  assert(ca.some((v, i) => Math.abs(v - cc[i]) > 1e-3), "another seed lays another egg");
  assert(ca.every((v) => v >= 0 && v <= 1), "colours in range");
  a.computeBoundingBox();
  assertAlmostEquals(a.boundingBox!.max.y - a.boundingBox!.min.y, 0.52, 1e-3);
  const low = eggGeometry(0.4, 0.52, 0x3366ff, 1, "low");
  assert(triCount(low) < triCount(a), "low quality is lighter");
  const mesh = buildEgg({ center: [0, 0.3, 0], width: 0.4, height: 0.52, lift: 0 }, 0x33ff66, 9, "low", { opacity: 0.6 });
  assert((mesh.material as THREE.MeshStandardMaterial).transparent, "candling egg is translucent");
  assertEquals(mesh.position.y, 0.3);
});

// ------------------------------------------------------------------ P5-V3 operators

Deno.test("ops: every operator keeps sections valid (exponent bounds, sharpest turn < 0.6 rad after the guard, bounded scale)", () => {
  const r = new Rng(77);
  let n = 0;
  for (let it = 0; it < 400; it++) {
    const base: Section = { rx: r.range(0.1, 0.4), ry: r.range(0.1, 0.4), exp: r.range(1.75, 2.45), lobes: [{ angle: Math.PI / 2, amp: r.range(-0.1, 0.2), sharp: r.range(2, 8) }] };
    const ops: MorphOp[] = Array.from({ length: r.int(1, 5) }, () => ({ kind: r.pick(OPS), region: "torso", u: r.next(), amount: r.range(-1.5, 1.5), width: r.range(0, 0.6), angle: r.range(-4, 4) }));
    for (const u of [0, 0.25, 0.5, 0.75, 1]) {
      const s = applyOps(base, u, ops);
      assert(s.exp! >= EXP_MIN && s.exp! <= EXP_MAX, "exponent");
      // Twist mixes the two radii, so the bound is on the pair: never thinner / fatter than the guard allows.
      const lo = Math.min(base.rx, base.ry) * OP_LIMITS.scaleMin, hi = Math.max(base.rx, base.ry) * OP_LIMITS.scaleMax;
      for (const v of [s.rx, s.ry]) assert(v >= lo * 0.999 && v <= hi * 1.001, `radius ${v} not in [${lo}, ${hi}]`);
      const ring = sectionRing(safeSection(s, 20), 20);
      assert(ring.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y)), "finite ring");
      assert(maxRingTurn(ring) < 0.6 || maxRingTurn(ring) <= maxRingTurn(sectionRing({ rx: s.rx, ry: s.ry }, 20)) * 1.05 + 1e-9, `turn ${maxRingTurn(ring)}`);
      n++;
    }
  }
  assert(n === 2000);
  assertEquals(clampExponent(applyOps({ rx: 1, ry: 1, exp: 9 }, 0.5, [{ kind: "pinch", region: "torso", u: 0.5, amount: 1, width: 0.2, angle: 0 }]).exp), EXP_MAX);
});

Deno.test("ops: each operator does what it says, only near its station (falsifiers)", () => {
  const base: Section = { rx: 1, ry: 1, exp: 2 };
  const radiusAt = (s: Section, theta: number) => {
    const ring = sectionRing(s, 64);
    const k = Math.round((theta / (2 * Math.PI)) * 64) % 64;
    return Math.hypot(ring[(k + 64) % 64][0], ring[(k + 64) % 64][1]);
  };
  const op = (kind: MorphOpKind, amount = 1, angle = Math.PI / 2): MorphOp => ({ kind, region: "torso", u: 0.5, amount, width: 0.2, angle });
  assert(radiusAt(applyOps(base, 0.5, [op("carve")]), Math.PI / 2) < 0.7, "carve digs at the angle");
  assertAlmostEquals(radiusAt(applyOps(base, 0.5, [op("carve")]), -Math.PI / 2), 1, 1e-6, "carve leaves the other side");
  assert(radiusAt(applyOps(base, 0.5, [op("difference")]), Math.PI / 2) < 0.7, "difference removes");
  assert(radiusAt(applyOps(base, 0.5, [op("merge")]), Math.PI / 2) > 1.25, "merge adds");
  assert(radiusAt(applyOps(base, 0.5, [op("bulge")]), Math.PI / 2) > 1.3, "bulge adds");
  const cmp = applyOps(base, 0.5, [op("compress", 1, Math.PI / 2)]);
  assert(cmp.ry < 0.7 && cmp.rx > 1.05, `compress along dorsal: ${cmp.rx}, ${cmp.ry}`);
  const dec = applyOps(base, 0.5, [op("decompress", 1, 0)]);
  assert(dec.rx > 1.3 && dec.ry < 0.95, "decompress along lateral");
  const pin = applyOps(base, 0.5, [op("pinch")]);
  assert(pin.rx < 0.75 && pin.ry < 0.75, "pinch waists");
  const tw = applyOps({ rx: 1, ry: 1, lobes: [{ angle: 0, amp: 0.2, sharp: 4 }] }, 0.5, [op("twist", 1)]);
  assertAlmostEquals(tw.lobes![0].angle, Math.PI / 3, 1e-9, "twist rotates the lobes");
  const tw2 = applyOps({ rx: 1, ry: 0.5 }, 0.5, [op("twist", 1)]);
  assert(tw2.rx < 1 && tw2.ry > 0.5, "twist turns the ellipse axes");
  // Far from the station: identity.
  const far = applyOps(base, 0.95, [op("carve"), op("pinch"), op("bulge")]);
  assertEquals([far.rx, far.ry], [1, 1]);
  assertEquals(far.lobes!.length, 0);
  // Regions: "all" reaches every body region but never the face lane's head.
  const ops: MorphOp[] = [{ ...op("carve"), region: "all" }, { ...op("pinch"), region: "tail" }, { ...op("bulge"), region: "head" }];
  assertEquals(opsFor(ops, "tail").length, 2);
  assertEquals(opsFor(ops, "torso").length, 1);
  assertEquals(opsFor(ops, "head").length, 1);
});

Deno.test("ops: a carved torso really changes the built mesh, stays finite and viable", () => {
  const { ph, g } = creature("quadruped", 4, 0.8);
  const plain = P5_DEFAULTS;
  const carved = p5With((p) => (p.body.ops = [{ kind: "carve", region: "torso", u: 0.5, amount: 1, width: 0.4, angle: Math.PI / 2 }, { kind: "pinch", region: "tail", u: 0.5, amount: 1, width: 0.4, angle: 0 }]));
  const sk = buildSkeleton(ph, plain);
  const a = buildBody(ph, sk, helixWith(g, ph, plain), mats(), "low");
  const b = buildBody(ph, sk, helixWith(g, ph, carved), mats(), "low");
  const top = (parts: typeof a) => {
    let y = -Infinity;
    const spine = sk.joints.findIndex((j) => j.role === "spine" || j.role === "chest");
    const m = parts.perJoint.get(spine)![0] as THREE.Mesh;
    m.geometry.computeBoundingBox();
    y = m.geometry.boundingBox!.max.y;
    return y;
  };
  assert(top(b) < top(a) - 1e-3, `carved back is lower: ${top(b)} vs ${top(a)}`);
  b.perJoint.forEach((objs) => objs.forEach((o) => assert(finite((o as THREE.Mesh).geometry), "finite")));
  const v = checkViability(sk, b);
  assert(v.ok, JSON.stringify(v.floating.concat(v.buried)));
});

// ------------------------------------------------------------------ viability

Deno.test("viability: random gene sets over every kind and growth are connected, nothing floating or buried", () => {
  const bad: string[] = [];
  let n = 0;
  for (const kind of BODY_KINDS) {
    for (let seed = 1; seed <= 5; seed++) {
      for (const growth of [0.05, 0.5, 1]) {
        const { ph, g } = creature(kind, seed, growth, { horns: 0.8, ears: 0.8, spikes: 0.8, wings: seed % 2 ? 0.9 : 0.1 });
        const p5 = randomP5(seed * 97 + growth * 10 + kind.length);
        const sk = buildSkeleton(ph, p5);
        const parts = buildBody(ph, sk, helixWith(g, ph, p5), mats(), "low");
        const v = checkViability(sk, parts);
        n++;
        if (!v.ok) bad.push(`${kind}/${seed}/${growth}: floating ${v.floating.map((f) => f.mesh).join(",")} buried ${v.buried.map((f) => f.mesh).join(",")}`);
      }
    }
  }
  assertEquals(bad, [], bad.join("\n"));
  assert(n === 90);
});

Deno.test("viability FALSIFIERS: a fabricated floating part and a fabricated buried part are reported", () => {
  const { ph, g } = creature("quadruped", 2, 1);
  const sk = buildSkeleton(ph, P5_DEFAULTS);
  const hx = helixWith(g, ph, P5_DEFAULTS);
  const clean = buildBody(ph, sk, hx, mats(), "low");
  assert(checkViability(sk, clean).ok, "clean body passes");
  // Floating: a ball half a body height beside the tail tip, attached to the tail joint.
  const tail = sk.joints.findIndex((j) => j.role === "tail");
  const hip = sk.joints.findIndex((j) => j.role === "hip");
  const floatBody = buildBody(ph, sk, hx, mats(), "low");
  const ball = new THREE.Mesh(new THREE.SphereGeometry(0.05 * sk.height, 8, 6).translate(0.6 * sk.height, 0.5 * sk.height, 0), new THREE.MeshStandardMaterial());
  ball.name = "fake:floating";
  floatBody.perJoint.get(hip >= 0 ? hip : tail)!.push(ball);
  const vf = checkViability(sk, floatBody);
  assert(!vf.ok && vf.floating.some((f) => f.mesh === "fake:floating"), `floating reported: ${JSON.stringify(vf.floating)}`);
  assert(vf.floating.every((f) => f.mesh === "fake:floating"), "only the fake part");
  // Buried: a tiny ball at the centre of the chest, attached to the chest joint.
  const chest = sk.joints.findIndex((j) => j.role === "chest");
  const buriedBody = buildBody(ph, sk, hx, mats(), "low");
  const c = sk.joints[chest];
  const pebble = new THREE.Mesh(new THREE.SphereGeometry(0.2 * c.r0, 8, 6).translate(c.dir[0] * c.length * 0.5, c.dir[1] * c.length * 0.5, c.dir[2] * c.length * 0.5), new THREE.MeshStandardMaterial());
  pebble.name = "fake:buried";
  buriedBody.perJoint.get(chest)!.push(pebble);
  const vb = checkViability(sk, buriedBody);
  assert(!vb.ok && vb.buried.some((f) => f.mesh === "fake:buried"), `buried reported: ${JSON.stringify(vb.buried)}`);
  assertEquals(vb.floating.length, 0);
});

// ------------------------------------------------------------------ P5-V5 shoulders, limb variation, fractal arms

Deno.test("shoulders: width spreads the front pivots, height lifts them (soles stay down), hump raises the withers", () => {
  const { ph, g } = creature("quadruped", 6, 1);
  const base = buildSkeleton(ph, P5_DEFAULTS);
  const wide = buildSkeleton(ph, p5With((p) => (p.body.shoulder = { width: 1.3, height: 1.3, hump: 1 })));
  const fs = (sk: Skeleton) => sk.joints.find((j) => j.id === "fLshoulder")!;
  assert(fs(wide).offset[0] > fs(base).offset[0] * 1.25, "wider");
  assert(fs(wide).offset[1] > fs(base).offset[1], "higher");
  // Soles still on the ground: lowest contact at y = 0 for both.
  for (const sk of [base, wide]) {
    const fk = forwardKinematics(sk, {});
    const feet = sk.joints.flatMap((j, i) => (j.contact ? [fk.end[i].y - j.r1] : []));
    assert(Math.max(...feet) - Math.min(...feet) < 0.03 * sk.height, `feet level ${Math.max(...feet) - Math.min(...feet)}`);
  }
  const top = (p5: MorphP5) => {
    const parts = buildBody(ph, base, helixWith(g, ph, p5), mats(), "low");
    const chest = base.joints.findIndex((j) => j.role === "chest");
    const m = parts.perJoint.get(chest)![0] as THREE.Mesh;
    m.geometry.computeBoundingBox();
    return m.geometry.boundingBox!.max.y;
  };
  assert(top(p5With((p) => (p.body.shoulder.hump = 1))) > top(P5_DEFAULTS) * 1.08, "hump");
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

Deno.test("limbVariation: pairs drift from their goal (deterministically) yet stay mirror-symmetric, soles on the ground", () => {
  for (const kind of ["quadruped", "hexapod", "biped"] as const) {
    const { ph } = creature(kind, 12, 1);
    const p5 = p5With((p) => (p.body.limbVariation = 0.25));
    const sk = buildSkeleton(ph, p5), sk2 = buildSkeleton(ph, p5), plain = buildSkeleton(ph, P5_DEFAULTS);
    assertEquals(JSON.stringify(sk.joints), JSON.stringify(sk2.joints), "deterministic");
    let drifted = 0;
    sk.joints.forEach((j, i) => {
      if ((j.role === "hip" || j.role === "shoulder") && Math.abs(j.length / plain.joints[i].length - 1) > 0.005) drifted++;
    });
    assert(drifted > 0, `${kind}: no drift`);
    const rest = restPositions(sk);
    for (const [l, r] of mirrorPairs(sk)) {
      assertAlmostEquals(rest[l][0], -rest[r][0], 1e-9, `${kind} mirror x ${sk.joints[l].id}`);
      assertAlmostEquals(rest[l][1], rest[r][1], 1e-9);
      assertAlmostEquals(rest[l][2], rest[r][2], 1e-9);
      assertAlmostEquals(sk.joints[l].length, sk.joints[r].length, 1e-12);
    }
    const fk = forwardKinematics(sk, {});
    const feet = sk.joints.flatMap((j, i) => (j.contact ? [fk.end[i].y - j.r1] : []));
    assert(Math.max(...feet) - Math.min(...feet) < 0.04 * sk.height, `${kind} feet level ${(Math.max(...feet) - Math.min(...feet)) / sk.height}`);
  }
});

Deno.test("armFractal: deeper / bushier grows more segments, capped by the budget; modes differ; deterministic", () => {
  const res = resolution("high");
  const af = (depth: number, mode: "branch" | "spiral" | "mandelbrot", branch = 3) => ({ depth, branch, ratio: 0.6, twist: 0.4, mode });
  const n = (depth: number, mode: "branch" | "spiral" | "mandelbrot", budget = 999, branch = 3) => fractalPieces([0, 0, 0], [0, -1, 0], 0.1, 0.01, af(depth, mode, branch), res, budget, "skin").length;
  assertEquals(n(1, "branch"), 4);
  assertEquals(n(2, "branch"), 13);
  assertEquals(n(4, "branch", 24), 24, "budget caps");
  assertEquals(fractalPieces([0, 0, 0], [0, -1, 0], 0.1, 0.01, { ...af(3, "branch"), mode: "none" }, res, 99, "skin").length, 0);
  assert(n(3, "spiral") < n(3, "branch"), "spiral is a curl, not a bush");
  const pos = (mode: "branch" | "mandelbrot") => {
    const p = fractalPieces([0, 0, 0], [0, -1, 0], 0.1, 0.01, af(2, mode), res, 99, "skin");
    return Array.from(p[p.length - 1].geo.getAttribute("position").array as Float32Array).slice(0, 9).map((v) => v.toFixed(5)).join();
  };
  assert(pos("branch") !== pos("mandelbrot"), "mandelbrot orbit changes the branching");
  assertEquals(pos("mandelbrot"), pos("mandelbrot"));
  // In a body: a fractal hand is a real mesh on the biped wrist.
  const { ph, g } = creature("biped", 3, 1);
  const p5 = p5With((p) => (p.body.armFractal = af(3, "mandelbrot")));
  const sk = buildSkeleton(ph, p5);
  const parts = buildBody(ph, sk, helixWith(g, ph, p5), mats(), "high");
  const wrist = sk.joints.findIndex((j) => j.role === "wrist");
  assert(parts.perJoint.get(wrist)!.some((o) => o.name.endsWith(":fractal")), "fractal hand");
});

// ------------------------------------------------------------------ P5-V6 plans, tails, curvature

Deno.test("tentacles: blob and serpent grow 4-8 tapering curled tentacles that touch the ground", () => {
  for (const kind of ["blob", "serpent"] as const) {
    for (const legLen of [0, 0.5, 1]) {
      const { ph, g } = creature(kind, 7, 1, { legLen });
      const p5 = p5With((p) => (p.body.limbStyle = "tentacles"));
      const sk = buildSkeleton(ph, p5);
      const chains = new Set(sk.joints.filter((j) => j.chain.startsWith("tent")).map((j) => j.chain));
      assert(chains.size >= 4 && chains.size <= 8, `${kind} ${chains.size} tentacles`);
      const fk = forwardKinematics(sk, {});
      for (const c of chains) {
        const js = sk.joints.filter((j) => j.chain === c);
        for (let k = 1; k < js.length; k++) assert(js[k].r0 <= js[k - 1].r0 + 1e-9, "tapering");
        const tip = sk.index.get(js[js.length - 1].id)!;
        const base = sk.index.get(js[1].id)!;
        assert(fk.end[tip].y > fk.end[base].y, `${kind} ${c}: the tip curls up`);
        assert(js.some((j) => j.contact), "a contact segment");
      }
      if (kind === "blob") assertEquals(sk.joints.filter((j) => j.id.startsWith("pod") && j.role === "pod").length, 0, "tentacles replace pods");
      const parts = buildBody(ph, sk, helixWith(g, ph, p5), mats(), "low");
      const v = checkViability(sk, parts);
      assert(v.ok, `${kind} viability ${JSON.stringify(v.floating.concat(v.buried))}`);
    }
  }
  // A quadruped ignores the tentacle style (documented limitation): still legs.
  const q = buildSkeleton(creature("quadruped", 7, 1).ph, p5With((p) => (p.body.limbStyle = "tentacles")));
  assertEquals(q.joints.filter((j) => j.chain.startsWith("tent")).length, 0);
});

Deno.test("serpent legs: 1-2 sprawling pairs (front pair near the head), soles at the belly line", () => {
  for (const pairs of [0, 1, 2]) {
    const { ph } = creature("serpent", 5, 1);
    const sk = buildSkeleton(ph, p5With((p) => (p.body.serpentLegs = pairs)));
    assertEquals(sk.joints.filter((j) => j.role === "hip" || (j.role === "shoulder" && j.chain.startsWith("leg"))).length, pairs * 2);
    if (pairs === 0) continue;
    const fk = forwardKinematics(sk, {});
    const feet = sk.joints.flatMap((j, i) => (j.role === "ankle" ? [fk.end[i].y - j.r1] : []));
    for (const f of feet) assert(Math.abs(f) < 0.06 * sk.height, `sole ${f}`);
    const front = sk.joints.find((j) => j.id === "sL0shoulder")!;
    assert(restPositions(sk)[sk.index.get(front.id)!][2] > -0.45 * sk.height * 2, "front pair near the head end");
  }
});

Deno.test("tails: every tip shape builds (taper adds nothing), length scales the tail, curl bends it, hit sphere for bulky tips", () => {
  const { ph, g } = creature("quadruped", 9, 1, { tail: 0.9 });
  const sk = buildSkeleton(ph, P5_DEFAULTS);
  const last = sk.joints.map((j, i) => (j.role === "tail" ? i : -1)).filter((i) => i >= 0).pop()!;
  const tris = (shape: TailShape) => {
    const p5 = p5With((p) => (p.body.tail.shape = shape));
    const parts = buildBody(ph, sk, helixWith(g, ph, p5), mats(), "low");
    const m = parts.perJoint.get(last)![0] as THREE.Mesh;
    assert(finite(m.geometry), `${shape} finite`);
    const v = checkViability(sk, parts);
    assert(v.ok, `${shape} viability ${JSON.stringify(v.floating.concat(v.buried))}`);
    return triCount(m.geometry);
  };
  const taper = tris("taper");
  for (const s of TAILS) if (s !== "taper") assert(tris(s) > taper, `${s} adds a tip`);
  const tailLen = (p5: MorphP5) => buildSkeleton(ph, p5).joints.filter((j) => j.role === "tail").reduce((s, j) => s + j.length, 0);
  assert(tailLen(p5With((p) => (p.body.tail.length = 2))) > 1.8 * tailLen(P5_DEFAULTS), "longer tail");
  const tipY = (curl: number) => {
    const s2 = buildSkeleton(ph, p5With((p) => (p.body.tail.curl = curl)));
    const fk = forwardKinematics(s2, {});
    const i = s2.joints.map((j, k) => (j.role === "tail" ? k : -1)).filter((k) => k >= 0).pop()!;
    return fk.end[i].y;
  };
  assert(tipY(1) > tipY(0) && tipY(0) > tipY(-1), "curl bends the tail up / down");
  const hs = (shape: TailShape) => hitSpheres(ph, sk, helixWith(g, ph, p5With((p) => (p.body.tail = { ...p.body.tail, shape, tipSize: 2 })))).length;
  assertEquals(hs("club"), hs("taper") + 1, "club gets a hit sphere");
});

Deno.test("curvature: water/air (+) rounds the body, rock/metal (-) sharpens it; neoteny rounds babies", () => {
  assert(effectiveAngularity(0.4, -1, 0) > 0.4 && effectiveAngularity(0.4, 1, 0) < 0.4, "ordering");
  assert(effectiveAngularity(0.8, -1, 1) < effectiveAngularity(0.8, -1, 0), "babies are rounder");
  const { ph, g } = creature("quadruped", 10, 1);
  const sk = buildSkeleton(ph, P5_DEFAULTS);
  const sharp = (curv: number) => {
    const parts = buildBody(ph, sk, helixWith(g, ph, p5With((p) => (p.body.curvature = curv))), mats(), "high");
    const m = parts.perJoint.get(0)![0] as THREE.Mesh;
    // The root loft (bone along +Z) is written first in the merged mesh: pole, then rows of R + 1 = 21 vertices
    // in XY planes. The sharpest turn of a mid row is the section's corner: facets turn harder than curves.
    const P = m.geometry.getAttribute("position");
    const turns: number[] = [];
    for (let row = 3; row < 9; row++) {
      const ring: [number, number][] = [];
      for (let k = 0; k < 20; k++) ring.push([P.getX(1 + row * 21 + k), P.getY(1 + row * 21 + k)]);
      turns.push(maxRingTurn(ring));
    }
    return turns.sort((a, b) => a - b)[3];
  };
  assert(sharp(-1) > sharp(1), `angular ${sharp(-1)} vs curvy ${sharp(1)}`);
});

Deno.test("fire: a flame-tailed (or fire) creature grows flame tongues on its membrane / feather wings, still viable", () => {
  const { ph, g } = creature("quadruped", 5, 1, { wings: 0.95 });
  const sk = buildSkeleton(ph, P5_DEFAULTS);
  for (const kind of ["membrane", "feather"] as const) {
    const wingTris = (shape: TailShape) => {
      const hx = { ...helixWith(g, ph, p5With((p) => (p.body.tail.shape = shape))), wings: { kind, span: 2.2, fingers: 4, detail: 0.8 } };
      const parts = buildBody(ph, sk, hx, mats(), "low");
      const v = checkViability(sk, parts);
      assert(v.ok, `${kind}/${shape} ${JSON.stringify(v.floating.concat(v.buried))}`);
      let n = 0;
      parts.perJoint.forEach((objs) => objs.forEach((o) => o.name.includes("wing-bone") && (n += triCount((o as THREE.Mesh).geometry))));
      return n;
    };
    if (ph.elements.primary !== "fire") assert(wingTris("flame") > wingTris("taper"), `${kind} flames`);
  }
});

// ------------------------------------------------------------------ budgets + determinism

Deno.test("triangle budget: body + face < 40k (high) and < 15k (low) over many seeds and random gene sets", () => {
  let worstH = 0, worstL = 0, worstHW = "", worstLW = "";
  for (const kind of BODY_KINDS) {
    for (let seed = 1; seed <= 12; seed++) {
      const growth = (seed % 4) / 3;
      const { ph, g } = creature(kind, seed, growth, { horns: seed % 3 ? 0.95 : 0.2, ears: 0.9, spikes: 0.9, wings: seed % 2 ? 0.95 : 0.1 });
      const p5 = randomP5(seed * 7 + kind.length * 1000);
      if (seed % 3 === 0) p5.body.armFractal = { depth: 4, branch: 4, ratio: 0.8, twist: 0.5, mode: "branch" };
      const sk = buildSkeleton(ph, p5);
      const hx = helixWith(g, ph, p5);
      for (const q of ["high", "low"] as const) {
        const t = buildBody(ph, sk, hx, mats(), q).triangles + faceTris(sk, ph, hx, q);
        if (q === "high" && t > worstH) [worstH, worstHW] = [t, `${kind}/${seed}`];
        if (q === "low" && t > worstL) [worstL, worstLW] = [t, `${kind}/${seed}`];
      }
    }
  }
  console.log(`worst high ${worstH} (${worstHW}), worst low ${worstL} (${worstLW})`);
  assert(worstH < 40000, `high ${worstH} ${worstHW}`);
  assert(worstL < 15000, `low ${worstL} ${worstLW}`);
});

Deno.test("determinism: the same genes build the same geometry (no Math.random in the morph lane)", () => {
  const { ph, g } = creature("biped", 14, 0.3);
  const p5 = randomP5(14);
  p5.body.armFractal = { depth: 3, branch: 3, ratio: 0.6, twist: 0.7, mode: "mandelbrot" };
  const one = () => {
    const sk = buildSkeleton(ph, p5);
    const parts = buildBody(ph, sk, helixWith(g, ph, p5), mats(), "low");
    const out: number[] = [];
    parts.perJoint.forEach((objs) => objs.forEach((o) => o.traverse((x) => {
      const m = x as THREE.Mesh;
      if (m.isMesh) out.push(...Array.from(m.geometry.getAttribute("position").array as Float32Array).filter((_, i) => i % 97 === 0));
    })));
    return out;
  };
  assertEquals(one(), one());
});
