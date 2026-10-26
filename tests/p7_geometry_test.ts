// Pass 7 lane GEOMETRY [P7-G1, P7-G2]: the seven new morph operators (ridge, flute, facet, scallop, segment, knob,
// spiral), the pass-5 angle-convention fix, the relief / horn / spike genes in the body builder, and robustness:
// identity at P7_DEFAULTS, >= 200 wild seeds, every p7 field forced to its bounds, 6 ops of every kind at
// amount +-1 per region, and viability for ANY fusion in [0, 1] (the Pareto remap reaches the bounds).
// Values are never pinned per seed: the Pareto calibration (src/data/paretoCalib.ts) moves helix values.
import * as THREE from "../src/lib/three.ts";
import { assert, assertEquals } from "./_assert.ts";
import { BODY_KINDS, type BodyKind, randomGenome } from "../src/genome/genome.ts";
import { express, type Phenotype } from "../src/genome/phenotype.ts";
import { emptyConditions } from "../src/genome/epigenetics.ts";
import { Rng } from "../src/core/rng.ts";
import { buildSkeleton, type Skeleton, skeletonGenes } from "../src/body/skeleton.ts";
import { helixOf } from "../src/genome/helix.ts";
import { type MorphHelix, type MorphOp, type MorphOpKind, type MorphP5, type MorphRegion, P5_DEFAULTS, type TailShape } from "../src/genome/morphTypes.ts";
import { type MorphP7, P7_DEFAULTS } from "../src/genome/p7Types.ts";
import type { BodyCounts } from "../src/genome/p6Types.ts";
import { bodyTriangleCap, buildBody, curlPath } from "../src/render/anatomy/body.ts";
import { checkViability } from "../src/render/anatomy/viability.ts";
import { EXP_MAX, EXP_MIN, MAX_TURN, maxRingTurn, safeSection, type Section, sectionRing } from "../src/render/anatomy/loft.ts";
import { applyOps, applyRelief, bandProfile, OP_LIMITS, sanitizeRelief } from "../src/render/anatomy/ops.ts";
import type { BodyParts, SkinMaterials } from "../src/render/anatomy/types.ts";

function mats(): SkinMaterials {
  const m = () => new THREE.MeshStandardMaterial();
  return { skin: m(), accent: m(), belly: m(), keratin: m(), membrane: m(), textures: [], baseEmissive: 0 };
}
const MATS = mats();
const HALF_PI = Math.PI / 2;
const P7_KINDS: MorphOpKind[] = ["ridge", "flute", "facet", "scallop", "segment", "knob", "spiral"];
const ALL_KINDS: MorphOpKind[] = ["carve", "merge", "compress", "decompress", "difference", "twist", "bulge", "pinch", ...P7_KINDS];
const REGIONS: MorphRegion[] = ["torso", "neck", "tail", "limb", "all"];

// ------------------------------------------------------------------ helpers
const R = 64;
const radiusAt = (s: Section, theta: number) => {
  const ring = sectionRing(s, R);
  const k = ((Math.round((theta / (2 * Math.PI)) * R) % R) + R) % R;
  return Math.hypot(ring[k][0], ring[k][1]);
};
/** Max mirror error of a section about the dorsal axis: point k vs point R/2 - k (x -> -x). */
function mirrorError(s: Section, n = R): number {
  const ring = sectionRing(s, n);
  let e = 0;
  for (let k = 0; k < n; k++) {
    const m = ring[((n / 2 - k) % n + n) % n];
    e = Math.max(e, Math.abs(ring[k][0] + m[0]), Math.abs(ring[k][1] - m[1]));
  }
  return e;
}
const op = (kind: MorphOpKind, amount: number, angle = HALF_PI, width = 0.3, u = 0.5, region: MorphRegion = "torso"): MorphOp => ({ kind, region, u, amount, width, angle });
const guardOk = (s: Section, n = 20) => {
  const ring = sectionRing(safeSection(s, n), n);
  if (!ring.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y))) return false;
  const t = maxRingTurn(ring);
  return t < MAX_TURN || t <= maxRingTurn(sectionRing({ rx: s.rx, ry: s.ry }, n)) * 1.05 + 1e-9;
};

function finiteParts(p: BodyParts): boolean {
  let ok = true;
  p.perJoint.forEach((objs) =>
    objs.forEach((o) =>
      o.traverse((x) => {
        const m = x as THREE.Mesh;
        if (!m.isMesh) return;
        const a = m.geometry.getAttribute("position").array as ArrayLike<number>;
        for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) ok = false;
      })
    )
  );
  return ok;
}
function positions(p: BodyParts): number[] {
  const out: number[] = [];
  [...p.perJoint.keys()].sort((a, b) => a - b).forEach((k) =>
    p.perJoint.get(k)!.forEach((o) =>
      o.traverse((x) => {
        const m = x as THREE.Mesh;
        if (m.isMesh) out.push(...Array.from(m.geometry.getAttribute("position").array as ArrayLike<number>));
      })
    )
  );
  return out;
}

interface Wild {
  ph: Phenotype;
  helix: MorphHelix;
  sk: Skeleton;
}
function wild(seed: number, kind?: BodyKind, plan: Record<string, number> = {}): Wild {
  const g = kind ? randomGenome(seed, undefined, { kind, plan }) : randomGenome(seed);
  const ph = express(g, emptyConditions());
  const helix = helixOf(g, ph);
  return { ph, helix, sk: buildSkeleton(ph, skeletonGenes(helix)) };
}
function withP7(h: MorphHelix, p7: MorphP7): MorphHelix {
  return { ...h, p7 };
}
const P7_MAX: MorphP7 = {
  ...P7_DEFAULTS,
  relief: { ridges: 5, flutes: 8, segments: 12, segmentDepth: 1, knobs: 1, facets: 1, scallop: 1 },
  horns: { pairs: 3, branch: 3, curl: 1.5 },
  spikes: { rows: 3, length: 2, density: 2 },
};
const P7_MIN: MorphP7 = {
  ...P7_DEFAULTS,
  relief: { ridges: 0, flutes: 0, segments: 0, segmentDepth: 0, knobs: 0, facets: 0, scallop: 0 },
  horns: { pairs: 0, branch: 0, curl: 0 },
  spikes: { rows: 0, length: 0.5, density: 0.5 },
};
/**
 * Every body invariant at once: finite, inside the triangle cap (pass-6 skeletons), viable. Some pass-6 colossi on
 * the low tier are ALREADY over their cap at P7_DEFAULTS (measured, pass 7): there p7 must add nothing on top.
 */
function invariants(w: Wild, helix: MorphHelix, q: "low" | "high", label: string, viable = true): BodyParts {
  const b = buildBody(w.ph, w.sk, helix, MATS, q);
  assert(finiteParts(b), `${label}: NaN / Infinity vertex`);
  if (w.sk.plan6) {
    const cap = bodyTriangleCap(w.sk, q);
    const limit = b.triangles <= cap ? cap : Math.max(cap, buildBody(w.ph, w.sk, withP7(w.helix, P7_DEFAULTS), MATS, q).triangles);
    assert(b.triangles <= limit, `${label}: ${b.triangles} > cap ${cap} (pass-6 body ${limit})`);
  }
  if (viable) {
    const v = checkViability(w.sk, b);
    assert(v.ok, `${label}: floating ${v.floating.map((f) => f.mesh)} buried ${v.buried.map((f) => f.mesh)}`);
  }
  return b;
}

// ------------------------------------------------------------------ (a) operators

Deno.test("p7 ops: each new kind changes the section the intended way", () => {
  const base: Section = { rx: 1, ry: 1, exp: 2 };
  // ridge: a sharp crest at the angle, nothing 90 degrees away; negative = a sharp keel groove.
  const rg = applyOps(base, 0.5, [op("ridge", 1)]);
  assert(radiusAt(rg, HALF_PI) > 1.25, `ridge crest ${radiusAt(rg, HALF_PI)}`);
  assert(Math.abs(radiusAt(rg, 0) - 1) < 1e-6, "ridge is narrow");
  assert(radiusAt(applyOps(base, 0.5, [op("ridge", -1)]), HALF_PI) < 0.8, "negative ridge = groove");
  // flute: 4..6 grooves, none on the dorsal axis itself (half-step offset), evenly spaced.
  const fl = applyOps(base, 0.5, [op("flute", -1, 0)]);
  assertEquals(fl.lobes!.length, 6);
  assert(fl.lobes!.every((l) => l.amp < 0), "flute grooves are negative");
  assert(radiusAt(fl, HALF_PI + Math.PI / 6) < 0.85 && radiusAt(fl, HALF_PI) > radiusAt(fl, HALF_PI + Math.PI / 6) + 0.05, "grooves between the axes");
  assertEquals(applyOps(base, 0.5, [op("flute", -0.2, 0)]).lobes!.length, 4);
  // facet: exponent toward EXP_MAX (positive) / EXP_MIN (negative) plus six alternating planes.
  const fa = applyOps(base, 0.5, [op("facet", 1, 0)]);
  assert(fa.exp! > 2.3 && fa.exp! <= EXP_MAX, `facet exp ${fa.exp}`);
  assert(applyOps(base, 0.5, [op("facet", -1, 0)]).exp! < 1.85, "negative facet = diamond");
  assertEquals(fa.lobes!.length, 6);
  // scallop: radius ripple ALONG u (crest at the centre, trough a third of the window away).
  const sc = (u: number) => applyOps(base, u, [op("scallop", 1, 0, 0.6)]).rx;
  assert(sc(0.5) > 1.1 && sc(0.5 + 0.2) < 1, `scallop ripple ${sc(0.5)} / ${sc(0.7)}`);
  // segment: periodic constrictions inside the window, identity outside.
  const sg = (u: number) => applyOps(base, u, [op("segment", -1, 0, 0.6)]).rx;
  const sgs = Array.from({ length: 121 }, (_, i) => sg(i / 120));
  const minima = sgs.filter((v, i) => i > 0 && i < 120 && v < sgs[i - 1] && v < sgs[i + 1] && v < 0.97).length;
  assert(minima >= 3, `segment bands: ${minima} constrictions`);
  assertEquals(applyOps(base, 0.98, [op("segment", -1, 0, 0.4)]).rx, 1, "identity outside the window");
  // knob: a sharp, local boss: strong at its station, gone well inside the op width.
  const kn = (u: number) => radiusAt(applyOps(base, u, [op("knob", 1, HALF_PI, 0.3)]), HALF_PI);
  assert(kn(0.5) > 1.3 && kn(0.66) < 1.02, `knob local: ${kn(0.5)} / ${kn(0.66)}`);
  // spiral: the crest angle winds with u (two crests, mirror pair).
  const sp = (u: number) => applyOps(base, u, [op("spiral", 1, HALF_PI, 0.4)]).lobes!;
  assert(Math.abs(sp(0.6)[0].angle - sp(0.4)[0].angle) > 0.5, "spiral winds along u");
  assertEquals(sp(0.6).length, 2);
});

Deno.test("p7 ops: every kind at amount +-1, stacked, stays valid (scale band, lobe cap, exponent, ring turn)", () => {
  const r = new Rng(707);
  let n = 0;
  for (let it = 0; it < 300; it++) {
    const base: Section = { rx: r.range(0.1, 0.4), ry: r.range(0.1, 0.4), exp: r.range(1.75, 2.45), lobes: [{ angle: HALF_PI, amp: r.range(-0.1, 0.2), sharp: r.range(2, 8) }] };
    const ops = Array.from({ length: r.int(1, 10) }, () => op(r.pick(ALL_KINDS), r.chance(0.5) ? 1 : -1, r.range(-4, 4), r.range(0, 1), r.next()));
    for (const u of [0, 0.2, 0.4, 0.5, 0.6, 0.8, 1]) {
      const s = applyOps(base, u, ops);
      assert(s.exp! >= EXP_MIN && s.exp! <= EXP_MAX, "exponent");
      const lo = Math.min(base.rx, base.ry) * OP_LIMITS.scaleMin, hi = Math.max(base.rx, base.ry) * OP_LIMITS.scaleMax;
      for (const v of [s.rx, s.ry]) assert(v >= lo * 0.999 && v <= hi * 1.001, `radius ${v} not in [${lo}, ${hi}]`);
      assert(s.lobes!.length - 1 <= OP_LIMITS.maxLobes, `lobe cap: ${s.lobes!.length}`);
      assert(s.lobes!.every((l) => Math.abs(l.amp) <= OP_LIMITS.lobeMax + 0.2 + 1e-9), "lobe amplitude");
      assert(guardOk(s), "ring turn guard");
      n++;
    }
  }
  assertEquals(n, 2100);
  // Six ops of every kind at +-1 on one section.
  for (const k of ALL_KINDS) {
    for (const a of [1, -1]) {
      const s = applyOps({ rx: 0.3, ry: 0.2, exp: 2.2 }, 0.5, Array.from({ length: 6 }, (_, i) => op(k, a, i % 2 ? HALF_PI : -HALF_PI, 0.5, 0.4 + 0.04 * i)));
      assert(guardOk(s) && Number.isFinite(s.rx) && Number.isFinite(s.ry), `${k} x6 at ${a}`);
    }
  }
});

Deno.test("p7 ops: bilateral mirror holds for every kind but twist, at ANY input angle", () => {
  const r = new Rng(11);
  for (const k of ALL_KINDS) {
    if (k === "twist") continue; // the one chiral op (documented): it rotates the section
    for (let it = 0; it < 40; it++) {
      const base: Section = { rx: r.range(0.5, 1.5), ry: r.range(0.5, 1.5), exp: r.range(1.8, 2.4), lobes: [{ angle: HALF_PI, amp: 0.1, sharp: 6 }, { angle: -HALF_PI, amp: -0.05, sharp: 3 }] };
      const s = applyOps(base, r.next(), [op(k, r.range(-1, 1), r.range(-4, 4), r.range(0.1, 0.9), r.next())]);
      assert(mirrorError(s) < 1e-9, `${k} breaks the mirror: ${mirrorError(s)}`);
    }
  }
  // twist really is chiral (the falsifier of the mirror metric).
  assert(mirrorError(applyOps({ rx: 1, ry: 0.6, lobes: [{ angle: HALF_PI, amp: 0.2, sharp: 6 }] }, 0.5, [op("twist", 1)])) > 1e-3, "mirror metric can fail");
});

Deno.test("p7 ops: one angle convention (loft frame); a pass-5 producer angle 0 / PI op is mirror-paired, never one-sided", () => {
  const base: Section = { rx: 1, ry: 1, exp: 2 };
  // Loft frame: PI/2 is the back (what tests/morph_p5_test.ts and helix7.ts use).
  const back = applyOps(base, 0.5, [op("carve", -1, HALF_PI)]);
  assert(radiusAt(back, HALF_PI) < 0.7 && Math.abs(radiusAt(back, 0) - 1) < 1e-6, "PI/2 carves the back only");
  // The pass-5 producer's 0 / PI (meant as dorsal / ventral) used to dent ONE flank: now both, symmetrically.
  for (const a of [0, Math.PI]) {
    const s = applyOps(base, 0.5, [op("merge", 1, a)]);
    assert(Math.abs(radiusAt(s, 0) - radiusAt(s, Math.PI)) < 1e-9 && radiusAt(s, 0) > 1.25, `angle ${a}: both flanks`);
    assert(mirrorError(s) < 1e-9, "mirror");
  }
});

Deno.test("p7 relief: ridges / flutes / facets / bands are symmetric, guarded, identity at zero", () => {
  const base: Section = { rx: 0.3, ry: 0.25, exp: 2.1, lobes: [{ angle: HALF_PI, amp: -0.05, sharp: 8 }] };
  const zero = sanitizeRelief(P7_DEFAULTS.relief);
  assert(applyRelief(base, 0.5, zero) === base, "identity (same object) at P7_DEFAULTS");
  const max = sanitizeRelief(P7_MAX.relief);
  for (let i = 0; i <= 40; i++) {
    const s = applyRelief(base, i / 40, max, 1, 12);
    assert(mirrorError(s) < 1e-9, "relief mirror");
    assert(guardOk(s), "relief guard");
    assert(s.rx >= base.rx * 0.77 && s.rx <= base.rx * 1.0001, "band depth <= 22 %");
  }
  assert(radiusAt(applyRelief({ rx: 1, ry: 1 }, 0.5, { ...zero, ridges: 1 }), HALF_PI) > 1.07, "one ridge on the spine");
  assert(radiusAt(applyRelief({ rx: 1, ry: 1 }, 0.5, { ...zero, flutes: 1 }), -HALF_PI) < 0.93, "one flute = the belly groove");
  // bands: constrictions at interior multiples of 1/bands, none at the chain ends.
  assert(bandProfile(0.25, 4) > 0.99 && bandProfile(0.125, 4) < 0.01 && bandProfile(0, 4) === 0 && bandProfile(1, 4) === 0, "band profile");
  // Garbage in: NaN / out-of-range genes are clamped.
  const g = sanitizeRelief({ ridges: 99, flutes: -3, segments: NaN, segmentDepth: 7, knobs: -1, facets: Infinity, scallop: 0.5 });
  assertEquals(g, { ridges: 5, flutes: 0, segments: 0, segmentDepth: 1, knobs: 0, facets: 0, scallop: 0.5 });
});

Deno.test("p7 horns: the ram curl never turns tighter than 1.4 x the horn radius and clears its previous turn", () => {
  for (const curl of [0.25, 0.75, 1.5]) {
    for (const d of [[0.35, 0.9, -0.35], [0, 1, 0], [0, 0, -1], [1, 0, 0]] as [number, number, number][]) {
      const r0 = 0.05, L = 0.3, n = 40;
      const rAt = (u: number) => r0 * Math.pow(1 - u, 0.9) + r0 * 0.05;
      const pts = curlPath([0, 0, 0], d, L, curl, rAt, r0, n);
      assert(pts.every((p) => p.every(Number.isFinite)), "finite");
      const step = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1], pts[1][2] - pts[0][2]);
      for (let i = 1; i + 1 < n; i++) {
        const a = pts[i - 1], b = pts[i], c = pts[i + 1];
        const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - b[0], c[1] - b[1], c[2] - b[2]];
        const cos = (e1[0] * e2[0] + e1[1] * e2[1] + e1[2] * e2[2]) / (Math.hypot(...e1) * Math.hypot(...e2));
        const turn = Math.acos(Math.max(-1, Math.min(1, cos)));
        assert(turn <= step / (1.3 * rAt(i / (n - 1))) + 1e-6, `curl ${curl}: turn ${turn} at ${i}`);
      }
      // Non-adjacent samples (more than ~half a turn apart along the path) never come closer than their radii.
      for (let i = 0; i < n; i++) {
        for (let j = i + 12; j < n; j++) {
          const dd = Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1], pts[i][2] - pts[j][2]);
          assert(dd > rAt(i / (n - 1)) + rAt(j / (n - 1)) - 1e-9 || j - i < 0.5 * n / Math.max(0.5, curl), `curl ${curl}: self-contact ${i}-${j}`);
        }
      }
    }
  }
});

// ------------------------------------------------------------------ (b) identity and wild seeds

Deno.test("p7 body: P7_DEFAULTS builds exactly the body of a helix without p7 (same vertex count and positions)", () => {
  for (const seed of [3, 17, 42, 99, 123, 256]) {
    const w = wild(seed);
    const { p7: _p, ...bare } = w.helix;
    const a = buildBody(w.ph, w.sk, bare as MorphHelix, MATS, "low");
    const b = buildBody(w.ph, w.sk, withP7(w.helix, P7_DEFAULTS), MATS, "low");
    assertEquals(a.triangles, b.triangles, `seed ${seed} triangles`);
    const pa = positions(a), pb = positions(b);
    assertEquals(pa.length, pb.length, `seed ${seed} vertex count`);
    for (let i = 0; i < pa.length; i++) assert(pa[i] === pb[i], `seed ${seed}: vertex coord ${i} differs`);
  }
});

Deno.test("p7 body: 200 wild seeds (their own p7 genes) are finite and inside the triangle caps", () => {
  let built = 0;
  for (let seed = 1; seed <= 200; seed++) {
    const w = wild(seed);
    invariants(w, w.helix, "low", `wild ${seed}`, false);
    built++;
  }
  assertEquals(built, 200);
  for (let seed = 1; seed <= 24; seed++) {
    const w = wild(seed * 31);
    invariants(w, w.helix, "high", `wild high ${seed * 31}`, false);
  }
});

// ------------------------------------------------------------------ (c) forced extremes

Deno.test("p7 body: every p7 field at its max and at its min, every kind, low and high: finite, capped, viable", () => {
  for (const kind of BODY_KINDS) {
    for (const seed of [2, 5]) {
      const w = wild(seed, kind, { horns: 0.9, ears: 0.9, spikes: 0.9, tail: 0.9, neck: 0.8, wings: seed % 2 ? 0.9 : 0.1 });
      for (const [name, p7] of [["max", P7_MAX], ["min", P7_MIN]] as const) {
        const p5: MorphP5 = { ...(w.helix.p5 ?? P5_DEFAULTS), body: { ...(w.helix.p5 ?? P5_DEFAULTS).body, tail: { ...(w.helix.p5 ?? P5_DEFAULTS).body.tail, length: 2, tipSize: 2.5 } } };
        const h = { ...withP7(w.helix, p7), p5 };
        for (const q of ["low", "high"] as const) invariants(w, h, q, `${kind}/${seed}/${name}/${q}`);
      }
    }
  }
});

Deno.test("p7 body: six ops of every kind at amount +1 and -1 on every region: finite, capped, viable", () => {
  for (const kind of BODY_KINDS) {
    const w = wild(4, kind, { horns: 0.9, spikes: 0.9, tail: 0.9, neck: 0.8 });
    for (const k of ALL_KINDS) {
      for (const a of [1, -1]) {
        const ops: MorphOp[] = Array.from({ length: 6 }, (_, i) => op(k, a, i % 3 === 2 ? -HALF_PI : HALF_PI, 0.9, 0.15 + 0.14 * i, REGIONS[i % REGIONS.length]));
        invariants(w, withP7(w.helix, { ...P7_MAX, ops }), "low", `${kind}/${k}/${a}`);
      }
    }
  }
});

Deno.test("p7 body: random p7 genes inside their bounds over 60 wild creatures: finite, capped, viable", () => {
  const r = new Rng(77007);
  for (let seed = 300; seed < 360; seed++) {
    const w = wild(seed);
    const p7: MorphP7 = {
      ...P7_DEFAULTS,
      ops: Array.from({ length: r.int(0, 6) }, () => op(r.pick(ALL_KINDS), r.range(-1, 1), r.pick([HALF_PI, -HALF_PI, 0]), r.range(0.08, 0.9), r.range(0.1, 0.9), r.pick(REGIONS))),
      relief: { ridges: r.int(0, 5), flutes: r.int(0, 8), segments: r.int(0, 12), segmentDepth: r.next(), knobs: r.next(), facets: r.next(), scallop: r.next() },
      horns: { pairs: r.int(0, 3), branch: r.int(0, 3), curl: r.range(0, 1.5) },
      spikes: { rows: r.int(0, 3), length: r.range(0.5, 2), density: r.range(0.5, 2) },
    };
    invariants(w, withP7(w.helix, p7), "low", `random p7 ${seed}`);
  }
});

Deno.test("p7 body: a pass-6 colossus with every p7 field at max stays inside its cap on both tiers", () => {
  const WORST: BodyCounts = { eyes: 8, mouths: 2, heads: 2, wingPairs: 3, armPairs: 3, legPairs: 4, tentacles: 12, fingers: 7, tails: 3 };
  for (const kind of BODY_KINDS) {
    const g = randomGenome(9, undefined, { kind, plan: { horns: 0.9, spikes: 0.9 } });
    const { evo: _e, ...ph0 } = express(g, emptyConditions());
    const ph: Phenotype = { ...ph0, growth: 1 };
    const { p6: _p, ...hx0 } = helixOf(g, ph);
    const helix: MorphHelix = { ...hx0, p6: { version: 6, complexity: { score: 0.9, tier: "mythic", oneIn: 5000, counts: WORST, colossal: true, colors: 3 } }, p7: P7_MAX };
    const sk = buildSkeleton(ph, skeletonGenes(helix));
    for (const q of ["low", "high"] as const) invariants({ ph, helix, sk }, helix, q, `colossus ${kind}/${q}`, false);
  }
});

Deno.test("p7 body: the trunk is an exact mirror image with every p7 relief / spike / knob gene at max and every symmetric op", () => {
  for (const kind of ["quadruped", "hexapod", "avian", "biped"] as BodyKind[]) {
    const w = wild(6, kind, { spikes: 0.9, tail: 0.9 });
    const ops = ALL_KINDS.filter((k) => k !== "twist").map((k, i) => op(k, i % 2 ? 1 : -1, i % 3 ? HALF_PI : -HALF_PI, 0.5, 0.2 + 0.04 * i, "all"));
    const helix: MorphHelix = { ...w.helix, asymmetry: 0, asymmetricParts: [], p5: { ...(w.helix.p5 ?? P5_DEFAULTS), body: { ...(w.helix.p5 ?? P5_DEFAULTS).body, ops: [] } }, p7: { ...P7_MAX, ops } };
    const b = buildBody(w.ph, w.sk, helix, MATS, "low");
    let checked = 0;
    w.sk.joints.forEach((j, i) => {
      // Median joints whose bone lies in the median plane (a serpent's rest S-curve bends sideways: not a mirror).
      if (j.side !== 0 || !["root", "spine", "chest", "segment", "tail"].includes(j.role) || j.chain.startsWith("tent")) return;
      if (Math.abs(j.dir[0]) > 1e-9 || Math.abs(j.offset[0]) > 1e-9) return;
      const mesh = b.perJoint.get(i)?.find((o) => o.name.endsWith(":body")) as THREE.Mesh | undefined;
      if (!mesh) return;
      const P = mesh.geometry.getAttribute("position");
      const box = new THREE.Box3().setFromBufferAttribute(P as THREE.BufferAttribute);
      const tol = 1e-5 * Math.max(1e-3, box.getSize(new THREE.Vector3()).length());
      const key = (x: number, y: number, z: number) => `${Math.round(x / tol)},${Math.round(y / tol)},${Math.round(z / tol)}`;
      const set = new Set<string>();
      for (let v = 0; v < P.count; v++) set.add(key(P.getX(v), P.getY(v), P.getZ(v)));
      const has = (x: number, y: number, z: number) => {
        for (const dx of [-1, 0, 1]) for (const dy of [-1, 0, 1]) for (const dz of [-1, 0, 1]) if (set.has(key(x + dx * tol, y + dy * tol, z + dz * tol))) return true;
        return false;
      };
      let miss = 0;
      for (let v = 0; v < P.count; v++) if (!has(-P.getX(v), P.getY(v), P.getZ(v))) miss++;
      assert(miss === 0, `${kind} ${j.id}: ${miss} of ${P.count} vertices have no mirror twin`);
      checked++;
    });
    assert(checked >= 1, `${kind}: no trunk mesh checked`);
  }
});

// ------------------------------------------------------------------ fusion sweep (parent finding, pass 7)

const TAILS: TailShape[] = ["taper", "club", "fin", "fan", "spade", "whip", "flame", "leaf", "rattle", "split"];
const OPS5: MorphOpKind[] = ["carve", "merge", "compress", "decompress", "difference", "twist", "bulge", "pinch"];
/** tests/morph_p5_test.ts randomP5, verbatim (the 90 viability cases). */
function randomP5(seed: number): MorphP5 {
  const r = new Rng(seed);
  const p = structuredClone(P5_DEFAULTS);
  const lo = r.range(0.75, 1), hi = r.range(1, 1.3);
  p.growth = { length: { lo, hi }, strength: { lo: r.range(0.75, 1), hi: r.range(1, 1.3) }, angle: { lo: r.range(-0.3, 0), hi: r.range(0, 0.3) }, spiral: r.range(0.6, 1.6), neoteny: r.next() };
  p.body = {
    shoulder: { width: r.range(0.8, 1.3), height: r.range(0.8, 1.3), hump: r.chance(0.3) ? r.range(0, 1) : 0 },
    tail: { shape: r.pick(TAILS), length: r.range(0.5, 2), curl: r.range(-1, 1), tipSize: r.range(0.5, 2) },
    armFractal: { depth: r.int(0, 4), branch: r.int(1, 4), ratio: r.range(0.35, 0.85), twist: r.range(-1, 1), mode: r.pick(["none", "branch", "spiral", "mandelbrot"] as const) },
    limbStyle: r.pick(["legs", "tentacles", "fins", "stumps"] as const),
    serpentLegs: r.int(0, 2),
    limbVariation: r.chance(0.3) ? r.range(0, 0.25) : 0,
    curvature: r.range(-1, 1),
    ops: Array.from({ length: r.int(0, 4) }, () => ({ kind: r.pick(OPS5), region: r.pick(["torso", "neck", "tail", "limb", "all", "head"] as const), u: r.next(), amount: r.range(-1, 1), width: r.range(0.05, 0.5), angle: r.range(-Math.PI, Math.PI) })),
  };
  return p;
}

Deno.test("p7 robustness: the 90 pass-5 viability cases stay viable for EVERY fusion 0, 0.1 .. 1 (990 bodies)", () => {
  const bad: string[] = [];
  let n = 0;
  for (const kind of BODY_KINDS) {
    for (let seed = 1; seed <= 5; seed++) {
      for (const growth of [0.05, 0.5, 1]) {
        const g = randomGenome(seed, undefined, { kind, plan: { horns: 0.8, ears: 0.8, spikes: 0.8, wings: seed % 2 ? 0.9 : 0.1 } });
        const { evo: _e, ...ph0 } = express(g, emptyConditions());
        const ph: Phenotype = { ...ph0, growth };
        const p5 = randomP5(seed * 97 + growth * 10 + kind.length);
        const sk = buildSkeleton(ph, p5);
        const h0: MorphHelix = { ...helixOf(g, ph), p5 };
        for (let i = 0; i <= 10; i++) {
          const v = checkViability(sk, buildBody(ph, sk, { ...h0, fusion: i / 10 }, MATS, "low"));
          n++;
          if (!v.ok) bad.push(`${kind}/${seed}/${growth}/F${i / 10}: floating ${v.floating.map((f) => f.mesh)} buried ${v.buried.map((f) => f.mesh)}`);
        }
      }
    }
  }
  assertEquals(n, 990);
  assertEquals(bad, [], bad.join("\n"));
});
