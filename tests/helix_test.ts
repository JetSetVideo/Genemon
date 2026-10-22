// Morph helix [SPEC P4-V2, P4-V3]: min/max gene pairs bounded by one equation, deterministic, heritable,
// rare asymmetry, manga eyes, teeth, bigger wings, animation envelopes.
import { assert, assertAlmostEquals, assertEquals } from "./_assert.ts";
import { type Genome, randomGenome } from "../src/genome/genome.ts";
import { express } from "../src/genome/phenotype.ts";
import { emptyConditions, xpForLevel } from "../src/genome/epigenetics.ts";
import { Rng } from "../src/core/rng.ts";
import { ANIM_CHANNELS, type EyeStyle } from "../src/genome/morphTypes.ts";
import {
  animGene,
  boundTrait,
  channelRange,
  deriveMorph,
  describeHelix,
  ensureMorph,
  helixOf,
  inheritMorph,
  MORPH_GENES,
  type MorphAlleles,
} from "../src/genome/helix.ts";

const N = 2000;
const sample = (() => {
  const out = [];
  for (let i = 0; i < N; i++) {
    const g = randomGenome(i + 1);
    const ph = express(g, emptyConditions());
    out.push({ g, ph, h: helixOf(g, ph) });
  }
  return out;
})();

Deno.test("helix: every animation channel has a min/max gene pair", () => {
  for (const ch of ANIM_CHANNELS) assert((MORPH_GENES as readonly string[]).includes(animGene(ch)), ch);
  const m = deriveMorph(randomGenome(7));
  for (const id of MORPH_GENES) {
    assertEquals(m[id].length, 2, id);
    for (const v of m[id]) assert(v >= 0 && v <= 1, `${id} allele ${v}`);
  }
});

Deno.test("[SPEC V2] determinism: same genome -> identical helix JSON", () => {
  for (const seed of [1, 42, 999, 123456]) {
    const a = randomGenome(seed), b = randomGenome(seed);
    const ha = JSON.stringify(helixOf(a, express(a, emptyConditions())));
    const hb = JSON.stringify(helixOf(b, express(b, emptyConditions())));
    assertEquals(ha, hb, `seed ${seed}`);
    assertEquals(JSON.stringify(deriveMorph(a)), JSON.stringify(deriveMorph(b)));
  }
});

Deno.test("[SPEC V2] every anim channel lo <= hi inside channelRange over 2000 genomes", () => {
  for (const { h } of sample) {
    for (const ch of ANIM_CHANNELS) {
      const [r0, r1] = channelRange(ch);
      const t = h.anim[ch];
      assert(t.lo <= t.hi, `${ch} lo ${t.lo} > hi ${t.hi}`);
      assert(t.lo >= r0 && t.hi <= r1, `${ch} [${t.lo}, ${t.hi}] outside [${r0}, ${r1}]`);
      assert(t.value >= t.lo && t.value <= t.hi, `${ch} value ${t.value}`);
      assertAlmostEquals(t.value, boundTrait(t, 0.5), 2e-3, `${ch} value = boundTrait(0.5)`);
    }
  }
  const [w0, w1] = channelRange("wingFlap");
  assertEquals([w0, w1], [0.3, 1.6]);
});

Deno.test("[SPEC V2] boundTrait: lo at 0, hi at 1, monotone in drive, clamped outside [0, 1]", () => {
  const pair = { lo: 0.2, hi: 0.9 };
  assertAlmostEquals(boundTrait(pair, 0), 0.2);
  assertAlmostEquals(boundTrait(pair, 1), 0.9);
  assertAlmostEquals(boundTrait(pair, -3), 0.2);
  assertAlmostEquals(boundTrait(pair, 7), 0.9);
  let prev = -Infinity;
  for (let i = 0; i <= 100; i++) {
    const v = boundTrait(pair, i / 100);
    assert(v >= prev, `not monotone at ${i}`);
    assert(v >= 0.2 && v <= 0.9);
    prev = v;
  }
});

Deno.test("[SPEC V2] FALSIFIER: a broken pair (lo > hi passed raw) is normalised by boundTrait", () => {
  const broken = { lo: 0.9, hi: 0.2 };
  // A naive lo + (hi - lo) * s would return 0.9 at drive 0 and 0.2 at drive 1 (inverted, decreasing).
  const naive = (d: number) => broken.lo + (broken.hi - broken.lo) * d;
  assert(naive(0) > naive(1), "the falsifier must really be inverted");
  assertAlmostEquals(boundTrait(broken, 0), 0.2);
  assertAlmostEquals(boundTrait(broken, 1), 0.9);
  assert(boundTrait(broken, 0.3) <= boundTrait(broken, 0.7), "normalised pair is monotone");
  // An out-of-range stored morph is rejected by ensureMorph and replaced by the derivation.
  const g = randomGenome(5);
  const bad = { ...deriveMorph(g), eyeStyle: [1.4, -2] } as unknown as MorphAlleles;
  assertEquals(JSON.stringify(ensureMorph({ ...g, morph: bad } as Genome)), JSON.stringify(deriveMorph(g)));
});

Deno.test("[SPEC V3] asymmetry is RARE: 5 % .. 11 % of 2000 genomes, magnitude 0.1-0.4, 1-3 parts", () => {
  const asym = sample.filter((s) => s.h.asymmetry > 0);
  const rate = asym.length / N;
  assert(rate >= 0.05 && rate <= 0.11, `asymmetry rate ${rate}`);
  for (const { h } of asym) {
    assert(h.asymmetry >= 0.1 && h.asymmetry <= 0.4, `magnitude ${h.asymmetry}`);
    assert(h.asymmetricParts.length >= 1 && h.asymmetricParts.length <= 3, `parts ${h.asymmetricParts}`);
  }
  for (const { h } of sample) if (h.asymmetry === 0) assertEquals(h.asymmetricParts.length, 0);
  // Chaos raises the odds.
  const chaotic = sample.filter((s) => s.ph.axes.structure < -0.3);
  const ordered = sample.filter((s) => s.ph.axes.structure > 0.3);
  const r = (xs: typeof sample) => xs.filter((s) => s.h.asymmetry > 0).length / Math.max(1, xs.length);
  assert(r(chaotic) > r(ordered), `chaos ${r(chaotic)} vs order ${r(ordered)}`);
});

Deno.test("[SPEC V3] manga eyes: all 8 styles, ~80 % two eyes, pupil follows style, aura none >= 60 %", () => {
  const styles = new Set<EyeStyle>(sample.map((s) => s.h.eyes.style));
  for (
    const st of ["round", "sparkle", "ring", "blank", "slit", "sharp", "sleepy", "compound"] as EyeStyle[]
  ) {
    assert(styles.has(st), `eye style ${st} never appears`);
  }
  // Pass 5: 1..8 eyes, two stay the norm (~80 %); the full distribution is pinned in helix_p5_test.ts.
  const two = sample.filter((s) => s.h.eyes.count === 2).length / N;
  assert(two >= 0.74 && two <= 0.86, `two eyes ${two}`);
  for (const { h } of sample) {
    assert(h.eyes.count >= 1 && h.eyes.count <= 8);
    assertEquals(h.eyes.count, h.p5!.eyes.count, "EyeGenes.count mirrors p5.eyes.count");
  }
  const none = sample.filter((s) => s.h.eyes.aura === "none").length / N;
  assert(none >= 0.6, `aura none ${none}`);
  const pupil: Record<string, string> = {
    round: "full",
    sparkle: "star",
    ring: "hollow",
    blank: "none",
    slit: "slit",
  };
  for (const { h } of sample) {
    if (pupil[h.eyes.style]) assertEquals(h.eyes.pupil, pupil[h.eyes.style], h.eyes.style);
    assert(h.eyes.size >= 0.12 && h.eyes.size <= 0.45, `eye size ${h.eyes.size}`);
  }
  // Hexapods are the compound-eye body.
  const hex = sample.filter((s) => s.ph.kind === "hexapod");
  const cmp = hex.filter((s) => s.h.eyes.style === "compound").length / hex.length;
  assert(cmp >= 0.4, `hexapod compound ${cmp}`);
  // Iris colour is element-coded for non-neutral, non-dark primaries without a secondary.
  const mono = sample.find((s) => s.ph.elements.primary === "fire" && !s.ph.elements.secondary);
  if (mono) assertEquals(mono.h.eyes.irisColor, 0xff5a1f);
});

Deno.test("[SPEC V3] wings bigger and flapping more: avian span >= 2.0, avian flap lo >= 0.6", () => {
  const avian = sample.filter((s) => s.ph.kind === "avian");
  assert(avian.length > 20, `avian sample ${avian.length}`);
  for (const { h } of avian) {
    assertEquals(h.wings.kind, "feather");
    assert(h.wings.span >= 2.0 && h.wings.span <= 3.2, `avian span ${h.wings.span}`);
    assert(h.anim.wingFlap.lo >= 0.6, `avian flap lo ${h.anim.wingFlap.lo}`);
    assert(h.anim.wingFlap.hi <= 1.5, `avian flap hi ${h.anim.wingFlap.hi}`);
  }
  for (const { ph, h } of sample) {
    if (h.wings.kind === "none") assertEquals(h.wings.span, 0);
    else if (ph.kind !== "avian") assert(h.wings.span >= 1.2 && h.wings.span <= 2.6, `span ${h.wings.span}`);
    if (ph.kind !== "avian" && ph.plan.wings < 0.45) assertEquals(h.wings.kind, "none");
    assert(h.wings.fingers >= 0 && h.wings.fingers <= 5);
  }
});

Deno.test("[SPEC V3] teeth, digits and fractal development follow the body", () => {
  for (const { ph, h } of sample) {
    assert(h.mouth.teethCount >= 0 && h.mouth.teethCount <= 12);
    assert(h.mouth.width >= 0.3 && h.mouth.width <= 1);
    assert(h.digits >= 0 && h.digits <= 5);
    assert(h.fractalDepth >= 0 && h.fractalDepth <= 3);
    if (ph.kind === "serpent" || ph.kind === "blob") assertEquals(h.digits, 0);
    if (ph.kind === "avian") assert(h.digits >= 3 && h.digits <= 4, `avian toes ${h.digits}`);
    if (h.mouth.teeth === "beak") assertEquals(ph.kind, "avian");
  }
  const avian = sample.filter((s) => s.ph.kind === "avian");
  assert(
    avian.filter((s) => s.h.mouth.teeth === "beak").length / avian.length >= 0.6,
    "avians mostly beaked",
  );
  const blobs = sample.filter((s) => s.ph.kind === "blob");
  assert(
    blobs.filter((s) => s.h.mouth.teeth === "none").length / blobs.length >= 0.5,
    "blobs mostly toothless",
  );
  // Older, higher-level creatures develop more detail.
  let young = 0, old = 0;
  for (const { g, h } of sample.slice(0, 400)) {
    const c = emptyConditions();
    c.xp = xpForLevel(40);
    c.ageDays = 60;
    young += h.fractalDepth;
    old += helixOf(g, express(g, c)).fractalDepth;
  }
  assert(old > young, `fractal old ${old} <= young ${young}`);
});

Deno.test("inheritance: Mendelian, one allele from each parent per gene", () => {
  const rng = new Rng(77);
  for (let k = 0; k < 50; k++) {
    const a = sample[2 * k].g, b = sample[2 * k + 1].g;
    const ma = ensureMorph(a), mb = ensureMorph(b);
    const child = inheritMorph(a, b, rng, 0);
    for (const id of MORPH_GENES) {
      const [x, y] = child[id];
      const fromA = (v: number) => ma[id].includes(v), fromB = (v: number) => mb[id].includes(v);
      assert((fromA(x) && fromB(y)) || (fromA(y) && fromB(x)), `${id} not one allele per parent`);
    }
  }
  // With the default mutation rate most genes still carry exactly the parental alleles.
  let same = 0, total = 0;
  for (let k = 0; k < 50; k++) {
    const a = sample[2 * k].g, b = sample[2 * k + 1].g;
    const pool = new Set([...MORPH_GENES.flatMap((id) => [...ensureMorph(a)[id], ...ensureMorph(b)[id]])]);
    const child = inheritMorph(a, b, rng);
    for (const id of MORPH_GENES) {
      total++;
      if (child[id].every((v) => pool.has(v))) same++;
      for (const v of child[id]) assert(v >= 0 && v <= 1);
    }
  }
  assert(same / total >= 0.9, `inherited unchanged ${same / total}`);
  // A stored morph wins over the derivation and is what helixOf expresses.
  const a = sample[0].g, b = sample[1].g;
  const child = { ...a, morph: inheritMorph(a, b, new Rng(3), 0) } as Genome;
  assertEquals(
    JSON.stringify(ensureMorph(child)),
    JSON.stringify((child as Genome & { morph: MorphAlleles }).morph),
  );
});

Deno.test("describeHelix: short readable lines", () => {
  const { h } = sample.find((s) => s.ph.kind === "avian")!;
  const lines = describeHelix(h);
  assert(lines.some((l) => l.startsWith("Eyes: ")));
  assert(lines.some((l) => l.startsWith("Wings: feather, span ")));
  assert(lines.some((l) => /^Wing flap \d\.\d\d-\d\.\d\d rad$/.test(l)));
  for (const l of lines) assert(l.length <= 160, `line too long: ${l}`);
  const asym = sample.find((s) => s.h.asymmetry > 0)!;
  assert(describeHelix(asym.h).some((l) => /^Asymmetric: (left|right) /.test(l)));
});
