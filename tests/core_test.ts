import { assert, assertAlmostEquals, assertEquals } from "./_assert.ts";
import { Rng, hashSeed } from "../src/core/rng.ts";
import { AXIS_IDS } from "../src/data/axes.ts";
import { ELEMENT_IDS, reactionBetween, typeMultiplier } from "../src/data/elements.ts";
import { randomGenome, BODY_KINDS } from "../src/genome/genome.ts";
import { emptyConditions, epigeneticShift, EPIGENETIC_CAP } from "../src/genome/epigenetics.ts";
import { express, POWER_BUDGET } from "../src/genome/phenotype.ts";
import { breed, fuse, morph, mutate } from "../src/genome/breeding.ts";
import { createGenemon, feed, phenotypeOf, expose } from "../src/genome/genemon.ts";
import { balanceOf, buildSkeleton, constrainPose, forwardKinematics } from "../src/body/skeleton.ts";
import { Ledger, isValidEvent } from "../src/core/ledger.ts";
import { MOVES, moveCost } from "../src/combat/moves.ts";

Deno.test("rng: same seed reproduces, sequential seeds are not correlated on first draw", () => {
  const a = new Rng(42), b = new Rng(42);
  for (let i = 0; i < 10; i++) assertEquals(a.next(), b.next());
  let hi = 0;
  for (let s = 0; s < 500; s++) if (new Rng(s).next() > 0.5) hi++;
  assert(hi > 200 && hi < 300, `first draws biased: ${hi}/500 above 0.5`);
});

Deno.test("genome: deterministic from seed, id stable, alleles in range", () => {
  const g1 = randomGenome(7), g2 = randomGenome(7), g3 = randomGenome(8);
  assertEquals(g1.id, g2.id);
  assert(g1.id !== g3.id, "different seeds must differ");
  for (const id of AXIS_IDS) for (const v of g1.axes[id]) assert(v >= -1 && v <= 1, `allele out of range ${id}`);
});

Deno.test("epigenetics: lifestyle shifts are bounded by the cap and point the right way", () => {
  const c = emptyConditions();
  c.exposure.lava = 10000;
  c.diet.spicyPepper = 10000;
  const s = epigeneticShift(c);
  assert(s.heat > 0.45 && s.heat <= EPIGENETIC_CAP + 1e-9, `heat shift ${s.heat}`);
  for (const id of AXIS_IDS) assert(Math.abs(s[id]) <= EPIGENETIC_CAP + 1e-9, `cap exceeded on ${id}`);
});

Deno.test("phenotype [SPEC B1]: combat power is normalised to the size-class budget", () => {
  for (let seed = 0; seed < 200; seed++) {
    const g = createGenemon({ seed, level: 20 });
    const ph = phenotypeOf(g);
    const q = ph.plan.quality;
    const expected = 100 * POWER_BUDGET[ph.sizeClass] * (1 + 0.12 * (2 * q - 1)) * (1 + 19 / 30) * (0.55 + 0.45 * ph.growth);
    assertAlmostEquals(ph.power, expected, expected * 1e-6, `seed ${seed}`);
    assert(ph.massKg > 0 && Number.isFinite(ph.massKg), "mass");
    assert(g.moves.length >= 2, `moves for seed ${seed}: ${g.moves}`);
  }
});

Deno.test("phenotype: raising a creature in water grows its water affinity (space shapes the body)", () => {
  const g = createGenemon({ seed: 99, level: 10 });
  const before = phenotypeOf(g).elements.affinity.water;
  expose(g, "deepWater", 400);
  feed(g, "fish", 300);
  const after = phenotypeOf(g).elements.affinity.water;
  assert(after > before + 0.1, `water affinity ${before} -> ${after}`);
});

Deno.test("type chart: every element has a strength and a weakness; fire+water reacts to smoke", () => {
  for (const e of ELEMENT_IDS) {
    if (e === "neutral") continue;
    const strong = ELEMENT_IDS.some((d) => typeMultiplier(e, [d]) > 1);
    const weak = ELEMENT_IDS.some((a) => typeMultiplier(a, [e]) > 1);
    assert(strong, `${e} has no strength`);
    assert(weak, `${e} has no weakness`);
  }
  assertEquals(reactionBetween("water", "fire")?.id, "smoke");
  assertEquals(reactionBetween("electric", "water")?.id, "conduction");
});

Deno.test("type chart [SPEC B2]: every element has as many 2x strengths as 2x weaknesses", () => {
  for (const e of ELEMENT_IDS) {
    if (e === "neutral") continue;
    const strengths = ELEMENT_IDS.filter((d) => typeMultiplier(e, [d]) === 2).length;
    const weaknesses = ELEMENT_IDS.filter((a) => typeMultiplier(a, [e]) === 2).length;
    assertEquals(strengths, weaknesses, `${e}: ${strengths} strengths vs ${weaknesses} weaknesses`);
  }
});

Deno.test("breeding: child alleles come from the parents; fusion/morph/mutate produce valid genomes", () => {
  const a = randomGenome(1), b = randomGenome(2);
  const c = breed(a, b, 3, { mutationRate: 0 });
  assertEquals(c.generation, 1);
  for (const id of AXIS_IDS) {
    const [x, y] = c.axes[id];
    const fromA = a.axes[id].includes(x) || a.axes[id].includes(y);
    const fromB = b.axes[id].includes(x) || b.axes[id].includes(y);
    assert(fromA && fromB, `axis ${id} alleles not inherited`);
  }
  const f = fuse(a, b, 4);
  assert(f.mutations.includes("fusion"));
  const m = morph(a, b, 0.5);
  assert(m.id.startsWith("gm-"));
  const mu = mutate(a, 5, 0.5, ["heat"]);
  assert(mu.axes.heat[0] !== a.axes.heat[0] || mu.axes.heat[1] !== a.axes.heat[1], "mutation changed nothing");
});

Deno.test("skeleton: every body kind stands on the ground with finite joints", () => {
  for (const kind of BODY_KINDS) {
    for (let s = 0; s < 6; s++) {
      const g = randomGenome(hashSeed(kind, s), undefined, { kind });
      const ph = express(g, emptyConditions());
      const sk = buildSkeleton(ph);
      const fk = forwardKinematics(sk, {});
      let minY = Infinity;
      sk.joints.forEach((j, i) => {
        assert(Number.isFinite(fk.end[i].y), `${kind} joint ${j.id} not finite`);
        if (j.contact) minY = Math.min(minY, fk.end[i].y - j.r1, fk.pos[i].y - j.r0);
      });
      assertAlmostEquals(minY, 0, 1e-6, `${kind} seat`);
      const bal = balanceOf(sk, fk);
      if (kind === "quadruped" || kind === "hexapod" || kind === "blob") {
        assert(bal.margin > 0, `${kind} statically unstable at rest: margin ${bal.margin}`);
      }
    }
  }
});

Deno.test("skeleton [SPEC K1]: limits are dynamic - a forward hip forbids a straight knee", () => {
  const g = randomGenome(11, undefined, { kind: "quadruped" });
  const sk = buildSkeleton(express(g, emptyConditions()));
  const straight = constrainPose(sk, { hLhip: [0, 0, 0], hLknee: [0, 0, 0] }).pose.hLknee[0];
  const forward = constrainPose(sk, { hLhip: [-0.8, 0, 0], hLknee: [0, 0, 0] }).pose.hLknee[0];
  assert(forward > straight + 0.2, `knee min should rise with hip flexion: ${straight} -> ${forward}`);
  const wild = constrainPose(sk, { spine1: [3, 3, 3], chest: [3, 3, 3] });
  assert(wild.strain > 1, "chain budget should strain an impossible spine");
});

Deno.test("moves: every move has a positive cost and 3 phases", () => {
  for (const m of MOVES) {
    assert(moveCost(m) > 0, m.id);
    assert(m.charge > 0 && m.active > 0 && m.rest > 0, `${m.id} phases`);
  }
});

Deno.test("ledger: rows are valid flat 5W events", () => {
  const l = new Ledger("t");
  const g = createGenemon({ seed: 3 });
  feed(g, "berries", 2, { ledger: l, when: 1 });
  assert(l.size >= 1);
  for (const r of l.rows()) assert(isValidEvent(r), JSON.stringify(r));
});
