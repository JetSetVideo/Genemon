// Pass-5 morph genes [P5-V2..V7, P5-V4]: every genome gets a full MorphP5, deterministically and
// heritably; distributions over 2000 seeds (eye counts, coats by element / body, curvature by element,
// rare tentacles / serpent legs / limb drift, mostly-avian beaks, forked tongues on serpents).
import { assert, assertEquals } from "./_assert.ts";
import { P7_MORPH_GENES } from "../src/genome/helix7.ts";
import { type Genome, randomGenome } from "../src/genome/genome.ts";
import { express, type Phenotype } from "../src/genome/phenotype.ts";
import { emptyConditions } from "../src/genome/epigenetics.ts";
import { Rng } from "../src/core/rng.ts";
import type { CoatKind, MorphHelix, MorphP5 } from "../src/genome/morphTypes.ts";
import {
  deriveMorph,
  describeHelix,
  ensureMorph,
  helixOf,
  inheritMorph,
  MORPH_GENES,
  type MorphAlleles,
  P4_MORPH_GENES,
  P5_MORPH_GENES,
} from "../src/genome/helix.ts";

const N = 2000;
interface S {
  g: Genome;
  ph: Phenotype;
  h: MorphHelix;
  p: MorphP5;
}
const sample: S[] = (() => {
  const out: S[] = [];
  for (let i = 0; i < N; i++) {
    const g = randomGenome(i + 1);
    const ph = express(g, emptyConditions());
    const h = helixOf(g, ph);
    out.push({ g, ph, h, p: h.p5! });
  }
  return out;
})();
const frac = (xs: S[], f: (s: S) => boolean) => xs.filter(f).length / Math.max(1, xs.length);
const withMorph = (g: Genome, m: MorphAlleles) => ({ ...g, morph: m }) as Genome;
const expressP5 = (g: Genome) => helixOf(g, express(g, emptyConditions())).p5!;

Deno.test("p5: every genome gets a complete MorphP5 inside the contract ranges", () => {
  const inR = (v: number, lo: number, hi: number, what: string) =>
    assert(Number.isFinite(v) && v >= lo - 1e-9 && v <= hi + 1e-9, `${what} = ${v} outside [${lo}, ${hi}]`);
  for (const { h, p } of sample) {
    assert(p && p.version === 5, "p5 present");
    const e = p.eyes;
    assert(Number.isInteger(e.count) && e.count >= 1 && e.count <= 8, `count ${e.count}`);
    assertEquals(h.eyes.count, e.count, "EyeGenes.count mirrors p5.eyes.count");
    if (e.count === 1) assertEquals(e.layout, "cyclops");
    else if (e.count === 2) assertEquals(e.layout, "pair");
    else assert(["row", "arc", "cluster", "stacked"].includes(e.layout), e.layout);
    inR(e.height, -1, 1, "eye height");
    inR(e.spread, 0, 1, "spread");
    inR(e.yaw, 0, 1.3, "yaw");
    inR(e.tilt, -0.5, 0.5, "tilt");
    inR(e.socketDepth, 0, 1, "socket");
    for (const s of e.scale) inR(s, 0.75, 1.35, "eye scale");
    inR(e.brow, 0, 1, "brow");
    const m = p.mouth;
    inR(m.beakLength, 0, 0.9, "beakLength");
    if (m.beak === "none") assertEquals(m.beakLength, 0);
    else assert(m.beakLength > 0, "a beak has a length");
    inR(m.beakRound, 0, 1, "beakRound");
    for (const s of m.scale) inR(s, 0.7, 1.4, "mouth scale");
    inR(m.height, -1, 1, "mouth height");
    inR(m.tongueLength, 0, 1.2, "tongue");
    if (m.tongueFork) assert(m.tongueLength > 0, "a fork needs a tongue");
    inR(m.lipCurve, -1, 1, "lip");
    const g = p.growth;
    for (const band of [g.length, g.strength, g.angle]) assert(band.lo <= band.hi, "band lo <= hi");
    inR(g.length.lo, 0.7, 1.35, "length lo");
    inR(g.length.hi, 0.7, 1.35, "length hi");
    assert(g.angle.lo <= 0 && g.angle.hi >= 0, "angle band straddles 0");
    inR(g.spiral, 0.6, 1.6, "spiral");
    inR(g.neoteny, 0, 1, "neoteny");
    const b = p.body;
    inR(b.shoulder.width, 0.8, 1.35, "shoulder w");
    inR(b.shoulder.height, 0.85, 1.2, "shoulder h");
    inR(b.shoulder.hump, 0, 1, "hump");
    inR(b.tail.length, 0.4, 1.8, "tail length");
    inR(b.tail.curl, 0, 1, "tail curl");
    inR(b.tail.tipSize, 0.5, 2, "tail tip");
    const af = b.armFractal;
    assert(Number.isInteger(af.depth) && af.depth >= 0 && af.depth <= 4, `arm depth ${af.depth}`);
    assertEquals(af.depth === 0, af.mode === "none", "depth 0 <=> mode none");
    if (af.mode === "mandelbrot") assert(af.depth >= 3, "mandelbrot is deep");
    inR(af.branch, 2, 4, "branch");
    inR(af.ratio, 0.45, 0.75, "ratio");
    inR(af.twist, 0, 1.4, "twist");
    inR(b.limbVariation, 0, 0.25, "limb variation");
    inR(b.curvature, -1, 1, "curvature");
    assert(b.ops.length <= 4, "0..4 ops");
    for (const o of b.ops) {
      inR(o.u, 0, 1, "op u");
      inR(o.amount, -1, 1, "op amount");
      inR(o.width, 0, 1, "op width");
      assert(o.angle === 0 || Math.abs(o.angle - Math.PI) < 1e-2, "ops are dorsal or ventral (mirror-safe)");
    }
    const s = p.skin;
    inR(s.bellyContrast, 0, 1, "belly");
    inR(s.frills, 0, 1, "frills");
    inR(s.stripes, 0, 1, "stripes");
    assert(Number.isInteger(s.celBands) && s.celBands >= 2 && s.celBands <= 5, `cel ${s.celBands}`);
    inR(s.outline, 0, 1, "outline");
    assert(Number.isInteger(s.overlays) && s.overlays >= 0 && s.overlays <= 3, "overlays");
  }
});

Deno.test("p5: determinism - same genome -> identical p5; legacy pass-4 derivation untouched", () => {
  for (const seed of [3, 77, 4242, 99991]) {
    assertEquals(JSON.stringify(expressP5(randomGenome(seed))), JSON.stringify(expressP5(randomGenome(seed))));
  }
  // Pinned allele values of the pass-4 derivation (pass 5 appends genes: the pass-4 draws must not move).
  const m = deriveMorph(randomGenome(7));
  assertEquals(m.eyeStyle, [0.27370887994766235, 0.7218487001955509]);
  assertEquals(m["anim.squash"], [0.3629225834738463, 0.8801905566360801]);
  // Pass 7 appends its genes after pass 5 (src/genome/helix7.ts): the pass-4 and pass-5 draws keep their places.
  assertEquals(MORPH_GENES.length, P4_MORPH_GENES.length + P5_MORPH_GENES.length + P7_MORPH_GENES.length);
  assertEquals(MORPH_GENES.slice(P4_MORPH_GENES.length, P4_MORPH_GENES.length + P5_MORPH_GENES.length).join(), P5_MORPH_GENES.join(), "pass-5 genes second");
  assertEquals(MORPH_GENES.slice(0, P4_MORPH_GENES.length).join(), P4_MORPH_GENES.join(), "pass-4 genes first");
});

Deno.test("p5: a pass-4 save keeps its alleles and gains DETERMINISTIC pass-5 genes", () => {
  const g = randomGenome(31);
  // A pass-4 stored morph: different from the derivation, without any p5.* key.
  const rng = new Rng(5);
  const p4 = Object.fromEntries(P4_MORPH_GENES.map((id) => [id, [rng.next(), rng.next()]])) as unknown as MorphAlleles;
  const filled = ensureMorph(withMorph(g, p4));
  for (const id of P4_MORPH_GENES) assertEquals(filled[id], p4[id], `${id} kept`);
  const d = deriveMorph(g);
  for (const id of P5_MORPH_GENES) assertEquals(filled[id], d[id], `${id} filled from the id`);
  assertEquals(JSON.stringify(ensureMorph(withMorph(g, p4))), JSON.stringify(filled), "stable across reloads");
  // FALSIFIER: an invalid p5 allele is replaced, a valid one is kept.
  const partial = { ...p4, "p5.socket": [0.11, 0.22], "p5.coat": [3, -1] } as unknown as MorphAlleles;
  const f2 = ensureMorph(withMorph(g, partial));
  assertEquals(f2["p5.socket"], [0.11, 0.22]);
  assertEquals(f2["p5.coat"], d["p5.coat"]);
});

Deno.test("p5 distribution: eye counts 1..8 - two ~75 %, one ~12 % (cyclops + globes), 3-8 rare", () => {
  const counts = new Map<number, number>();
  for (const { p } of sample) counts.set(p.eyes.count, (counts.get(p.eyes.count) ?? 0) + 1);
  const f = (n: number) => (counts.get(n) ?? 0) / N;
  // Pass 6 [P6-C1]: minimal globes (~6.5 % of wild genomes) are one-eyed by definition, on top of the
  // ~6 % recessive cyclopes: one eye ~12 %, two eyes ~74 %.
  assert(f(2) >= 0.68 && f(2) <= 0.86, `two eyes ${f(2)}`);
  assert(f(1) >= 0.06 && f(1) <= 0.17, `one eye ${f(1)}`);
  const cyc = sample.filter((s) => s.h.p6!.complexity.tier !== "minimal");
  const cf = cyc.filter((s) => s.p.eyes.count === 1).length / cyc.length;
  assert(cf >= 0.03 && cf <= 0.09, `recessive cyclops (non-globes) ${cf}`);
  const many = [3, 4, 5, 6, 7, 8].reduce((s, n) => s + f(n), 0);
  assert(many >= 0.08 && many <= 0.2, `3-8 eyes ${many}`);
  for (const n of [3, 4, 5, 6, 7, 8]) assert((counts.get(n) ?? 0) > 0, `${n} eyes never appear`);
  // Hexapods (arthropod plans) carry many eyes more often than the rest.
  const hex = sample.filter((s) => s.ph.kind === "hexapod"), rest = sample.filter((s) => s.ph.kind !== "hexapod");
  assert(frac(hex, (s) => s.p.eyes.count > 2) > frac(rest, (s) => s.p.eyes.count > 2), "hexapods many-eyed more often");
  // Outline shapes: all seven appear, round is the most common.
  const shapes = new Set(sample.map((s) => s.p.eyes.shape));
  for (const sh of ["round", "almond", "tear", "crescent", "hooded", "diamond", "oval"]) assert(shapes.has(sh as never), `shape ${sh}`);
});

Deno.test("p5 distribution: coats follow element and body plan", () => {
  const coat = (xs: S[], c: CoatKind[]) => frac(xs, (s) => c.includes(s.p.skin.coat));
  const by = (f: (s: S) => boolean) => sample.filter(f);
  const plant = by((s) => s.ph.elements.primary === "plant");
  const earth = by((s) => s.ph.elements.primary === "earth");
  const serp = by((s) => s.ph.kind === "serpent");
  const hex = by((s) => s.ph.kind === "hexapod");
  const avian = by((s) => s.ph.kind === "avian");
  const wetBlob = by((s) => s.ph.kind === "blob" && (s.ph.elements.primary === "water" || s.ph.elements.primary === "poison"));
  const fire = by((s) => s.ph.elements.primary === "fire" && s.ph.kind !== "avian");
  const furry = by((s) => (s.ph.kind === "quadruped" || s.ph.kind === "biped") && s.h.surface.fur > 0.5);
  for (const [xs, name] of [[plant, "plant"], [earth, "earth"], [serp, "serpent"], [hex, "hexapod"], [avian, "avian"], [wetBlob, "wet blob"]] as const) {
    assert(xs.length >= 15, `${name} sample ${xs.length}`);
  }
  assert(coat(plant, ["leaves"]) >= 0.4, `plant leaves ${coat(plant, ["leaves"])}`);
  assert(coat(earth, ["bark", "crystal"]) >= 0.3, `earth bark/crystal ${coat(earth, ["bark", "crystal"])}`);
  assert(coat(serp, ["scales"]) >= 0.6, `serpent scales ${coat(serp, ["scales"])}`);
  assert(coat(hex, ["chitin"]) >= 0.55, `hexapod chitin ${coat(hex, ["chitin"])}`);
  assert(coat(avian, ["feathers"]) >= 0.55, `avian feathers ${coat(avian, ["feathers"])}`);
  assert(coat(wetBlob, ["slime"]) >= 0.5, `wet blob slime ${coat(wetBlob, ["slime"])}`);
  const ff = coat(fire, ["feathers"]);
  assert(ff > 0.05 && ff < 0.5, `fire feathers SOMETIMES ${ff}`);
  assert(coat(furry, ["fur"]) >= 0.4, `furry mammals fur ${coat(furry, ["fur"])}`);
  // Bellies are countershaded: usually 0.4-0.9.
  assert(frac(sample, (s) => s.p.skin.bellyContrast >= 0.4 && s.p.skin.bellyContrast <= 0.9) >= 0.85, "belly band");
});

Deno.test("p5 distribution: elements shape the parts (curvature, flame / leaf / fin tails)", () => {
  const mean = (el: string) => {
    const xs = sample.filter((s) => s.ph.elements.primary === el);
    return xs.reduce((a, s) => a + s.p.body.curvature, 0) / Math.max(1, xs.length);
  };
  assert(mean("water") > 0.4, `water curvy ${mean("water")}`);
  assert(mean("air") > 0.3, `air curvy ${mean("air")}`);
  assert(mean("psychic") > 0.2, `psychic curvy ${mean("psychic")}`);
  assert(mean("metal") < -0.5, `metal angular ${mean("metal")}`);
  assert(mean("earth") < -0.4, `earth angular ${mean("earth")}`);
  const tail = (el: string, shape: string) => frac(sample.filter((s) => s.ph.elements.primary === el), (s) => s.p.body.tail.shape === shape);
  assert(tail("fire", "flame") >= 0.35, `fire flame tail ${tail("fire", "flame")}`);
  assert(tail("plant", "leaf") >= 0.35, `plant leaf tail ${tail("plant", "leaf")}`);
  assert(tail("water", "fin") >= 0.3, `water fin tail ${tail("water", "fin")}`);
  assertEquals(frac(sample.filter((s) => s.ph.elements.primary !== "fire" && s.ph.elements.secondary !== "fire"), (s) => s.p.body.tail.shape === "flame"), 0, "flame tails need fire");
  // Colour code kept: a mono-fire creature still has the fire iris.
  const mono = sample.find((s) => s.ph.elements.primary === "fire" && !s.ph.elements.secondary);
  if (mono) assertEquals(mono.h.eyes.irisColor, 0xff5a1f);
});

Deno.test("p5 distribution: rare limbs - tentacles mostly blob/serpent, serpent legs rare, limb drift usually 0", () => {
  const tent = sample.filter((s) => s.p.body.limbStyle === "tentacles");
  assert(tent.length / N <= 0.08 && tent.length > 0, `tentacles ${tent.length / N}`);
  assert(frac(tent, (s) => s.ph.kind === "blob" || s.ph.kind === "serpent") >= 0.7, "tentacles mostly blob / serpent");
  const legs = sample.filter((s) => s.p.body.serpentLegs > 0);
  assert(legs.length > 0, "some serpents rear up on legs");
  for (const s of legs) assertEquals(s.ph.kind, "serpent");
  const serp = sample.filter((s) => s.ph.kind === "serpent");
  assert(legs.length / serp.length <= 0.12, `serpent legs rare ${legs.length / serp.length}`);
  const drift = frac(sample, (s) => s.p.body.limbVariation === 0);
  assert(drift >= 0.85 && drift < 1, `limbVariation 0 share ${drift}`);
  const humps = frac(sample, (s) => s.p.body.shoulder.hump > 0);
  assert(humps > 0 && humps < 0.2, `humps ${humps}`);
  for (const s of sample) if (s.ph.kind === "serpent" || s.ph.kind === "blob" || s.ph.kind === "avian") assertEquals(s.p.body.shoulder.hump, 0);
  const modes = new Set(sample.map((s) => s.p.body.armFractal.mode));
  for (const m of ["none", "branch", "spiral", "mandelbrot"]) assert(modes.has(m as never), `arm mode ${m}`);
  assert(frac(sample, (s) => s.p.body.armFractal.mode === "mandelbrot") < 0.05, "mandelbrot arms rare");
  const ops = sample.map((s) => s.p.body.ops.length);
  assert(ops.filter((n) => n <= 1).length / N >= 0.6, "most creatures 0-1 ops");
  assert(ops.some((n) => n === 4), "4 ops possible");
});

Deno.test("p5 distribution: beaks mostly avian with round beaks of several sizes; forked tongues on serpents", () => {
  const beaked = sample.filter((s) => s.p.mouth.beak !== "none");
  assert(frac(beaked, (s) => s.ph.kind === "avian") >= 0.9, "beaks mostly avian");
  const avian = sample.filter((s) => s.ph.kind === "avian");
  assert(frac(avian, (s) => s.p.mouth.beak !== "none") >= 0.6, "avians mostly beaked");
  const round = beaked.filter((s) => s.p.mouth.beak === "round").map((s) => s.p.mouth.beakLength);
  assert(round.length >= 20, `round beaks ${round.length}`);
  assert(Math.max(...round) - Math.min(...round) >= 0.15, `round beak sizes vary ${Math.min(...round)}..${Math.max(...round)}`);
  for (const s of beaked.filter((s) => s.p.mouth.beak === "round")) assert(s.p.mouth.beakRound >= 0.6, "round beaks are blunt");
  for (const s of beaked.filter((s) => s.p.mouth.beak === "needle")) assert(s.p.mouth.beakRound <= 0.2 && s.p.mouth.beakLength >= 0.5, "needle beaks long and sharp");
  const kinds = new Set(beaked.map((s) => s.p.mouth.beak));
  for (const k of ["round", "hooked", "flat", "needle", "shovel"]) assert(kinds.has(k as never), `beak ${k}`);
  const serpT = sample.filter((s) => s.ph.kind === "serpent" && s.p.mouth.tongueLength > 0);
  assert(frac(serpT, (s) => s.p.mouth.tongueFork) >= 0.8, "serpents fork their tongues");
  const mammalT = sample.filter((s) => s.ph.kind !== "serpent" && s.p.mouth.tongueLength > 0 && s.h.eyes.style !== "slit" && s.ph.pattern !== "scales" && s.p.skin.coat !== "scales");
  assert(frac(mammalT, (s) => s.p.mouth.tongueFork) < 0.1, "non-reptiles rarely fork");
  // A tongue gene with no visible tongue is 0 (MouthGenes.tongue false).
  for (const s of sample) if (!s.h.mouth.tongue) assertEquals(s.p.mouth.tongueLength, 0);
});

Deno.test("p5 heritability: recessive eye counts breed true; Mendelian alleles carry the traits", () => {
  // Pass 6: globes (always one eye) and mythic chimeras (always 6-8) have their eye count fixed by the tier.
  const base = sample.filter((s) => s.ph.kind !== "hexapod" && s.h.p6!.complexity.tier !== "minimal" && s.h.p6!.complexity.tier !== "mythic")
    .map((s) => s.g).slice(0, 120);
  const set = (g: Genome, over: Partial<Record<string, [number, number]>>) => withMorph(g, { ...ensureMorph(g), ...over } as MorphAlleles);
  const rng = new Rng(9);
  let cyc = 0, many = 0, hetero = 0;
  for (let i = 0; i + 1 < base.length; i += 2) {
    const a = base[i], b = base[i + 1];
    // Two cyclops parents (both alleles low) -> cyclops child.
    const ca = set(a, { eyeCount: [0.05, 0.2] }), cb = set(b, { eyeCount: [0.1, 0.15] });
    const c1 = withMorph(a, inheritMorph(ca, cb, rng, 0));
    if (expressP5(c1).eyes.count === 1) cyc++;
    // Two many-eyed parents -> many-eyed child.
    const ma = set(a, { eyeCount: [0.9, 0.97] }), mb = set(b, { eyeCount: [0.92, 0.99] });
    const c2 = withMorph(a, inheritMorph(ma, mb, rng, 0));
    if (expressP5(c2).eyes.count >= 3) many++;
    // Cyclops x ordinary (recessive): the child carries one ordinary allele -> never a cyclops.
    const nb = set(b, { eyeCount: [0.5, 0.6] });
    const c3 = withMorph(a, inheritMorph(ca, nb, rng, 0));
    if (expressP5(c3).eyes.count !== 1) hetero++;
  }
  const n = base.length / 2;
  assertEquals(cyc, n, "cyclops x cyclops breeds true");
  assertEquals(many, n, "many x many breeds true");
  assertEquals(hetero, n, "cyclops is recessive");
  // Continuous traits: the child's expressed socket depth tracks its parent (same phenotype) far
  // better than an unrelated genome's alleles do.
  const fam: [number, number, number][] = [];
  for (let i = 0; i + 1 < 400; i += 2) {
    const a = sample[i].g, b = sample[i + 1].g;
    const child = withMorph(a, inheritMorph(a, b, rng));
    const stranger = withMorph(a, ensureMorph(sample[(i + 701) % N].g));
    fam.push([expressP5(a).eyes.socketDepth, expressP5(child).eyes.socketDepth, expressP5(stranger).eyes.socketDepth]);
  }
  const corr = (xs: number[], ys: number[]) => {
    const mx = xs.reduce((s, v) => s + v, 0) / xs.length, my = ys.reduce((s, v) => s + v, 0) / ys.length;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < xs.length; i++) {
      sxy += (xs[i] - mx) * (ys[i] - my);
      sxx += (xs[i] - mx) ** 2;
      syy += (ys[i] - my) ** 2;
    }
    return sxy / Math.sqrt(sxx * syy);
  };
  const rChild = corr(fam.map((f) => f[0]), fam.map((f) => f[1]));
  const rStranger = corr(fam.map((f) => f[0]), fam.map((f) => f[2]));
  assert(rChild > 0.5, `parent-child socket correlation ${rChild}`);
  assert(rChild > rStranger + 0.2, `child ${rChild} vs stranger ${rStranger}`);
  // Operators are seeded by the ORDER-FREE ops pair: swapping the alleles keeps the same operators.
  const g = sample.find((s) => s.p.body.ops.length >= 2)!.g;
  const m = ensureMorph(g);
  const swapped = withMorph(g, { ...m, "p5.ops": [m["p5.ops"][1], m["p5.ops"][0]] });
  assertEquals(JSON.stringify(expressP5(swapped).body.ops), JSON.stringify(expressP5(g).body.ops));
  // FALSIFIER: full mutation really moves alleles (the inheritance test above is not vacuous).
  const mut = inheritMorph(sample[0].g, sample[1].g, new Rng(1), 1);
  const pool = new Set(P5_MORPH_GENES.flatMap((id) => [...ensureMorph(sample[0].g)[id], ...ensureMorph(sample[1].g)[id]]));
  assert(P5_MORPH_GENES.some((id) => mut[id].some((v) => !pool.has(v))), "mutation 1 changes p5 alleles");
});

Deno.test("describeHelix lists the pass-5 traits", () => {
  const s = sample.find((x) => x.p.mouth.beak !== "none" && x.p.body.ops.length > 0) ?? sample.find((x) => x.p.mouth.beak !== "none")!;
  const lines = describeHelix(s.h);
  for (const head of ["Eye layout: ", "Mouth: ", "Coat: ", "Body: ", "Growth: "]) assert(lines.some((l) => l.startsWith(head)), `missing ${head}`);
  assert(lines.some((l) => / beak \(length /.test(l)), "beak described");
  for (const x of sample.slice(0, 300)) for (const l of describeHelix(x.h)) assert(l.length <= 160, `line too long: ${l}`);
  const forked = sample.find((x) => x.p.mouth.tongueFork)!;
  assert(describeHelix(forked.h).some((l) => l.includes("forked tongue")), "forked tongue described");
});
