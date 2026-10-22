import { assert, assertAlmostEquals, assertEquals } from "./_assert.ts";
import { createGenemon, phenotypeOf } from "../src/genome/genemon.ts";
import { helixOf } from "../src/genome/helix.ts";
import { P5_DEFAULTS } from "../src/genome/morphTypes.ts";
import type { MorphHelix } from "../src/genome/morphTypes.ts";
import type { Phenotype } from "../src/genome/phenotype.ts";
import { ALL_MOVE_BY_ID, ALL_MOVES } from "../src/combat/kit.ts";
import {
  channelOfMove,
  perceive,
  RESONANCE_MAX,
  RESONANCE_MIN,
  resonanceMult,
  SENSE_DAMAGE_WEIGHT,
  SENSE_MEAN,
  senseDamageMult,
  sensesOf,
} from "../src/genome/senses.ts";
import {
  type LifeState,
  SENSE_BUDGET,
  SENSE_IDS,
  type SenseId,
  type SenseProfile,
} from "../src/genome/lifeTypes.ts";
import { newLifeState } from "../src/genome/lifeclock.ts";

function fixture(seed: number): { ph: Phenotype; helix: MorphHelix } {
  const g = createGenemon({ seed, level: 20 });
  const ph = phenotypeOf(g);
  return { ph, helix: helixOf(g.genome, ph) };
}
const sum = (p: SenseProfile) => SENSE_IDS.reduce((s, id) => s + p.acuity[id], 0);
function withEars(ph: Phenotype, ears: number): Phenotype {
  return { ...ph, plan: { ...ph.plan, ears } };
}
function withEyes(h: MorphHelix, eyes: Partial<typeof P5_DEFAULTS.eyes>, size?: number): MorphHelix {
  const p5 = h.p5 ?? P5_DEFAULTS;
  return {
    ...h,
    eyes: { ...h.eyes, size: size ?? h.eyes.size },
    p5: { ...p5, eyes: { ...p5.eyes, ...eyes } },
  };
}

Deno.test("senses: budget-neutral, bounded resonance, sane ranges over 40 creatures [P5-G1, B1]", () => {
  for (let seed = 1; seed <= 40; seed++) {
    const { ph, helix } = fixture(seed);
    const s = sensesOf(ph, helix);
    assertAlmostEquals(sum(s), SENSE_BUDGET, 1e-9, `acuity sum seed ${seed}`);
    for (const id of SENSE_IDS) {
      assert(s.acuity[id] > 0, `${id} acuity > 0`);
      assert(
        s.resonance[id] >= RESONANCE_MIN && s.resonance[id] <= RESONANCE_MAX,
        `${id} resonance in band: ${s.resonance[id]}`,
      );
      assert(typeof s.organ[id] === "string" && s.organ[id].length > 0, `${id} organ label`);
    }
    assert(s.fovHalf > 0 && s.fovHalf <= Math.PI, "fov in (0, pi]");
    assert(
      s.visionRange >= 3 && s.visionRange <= 45 && s.hearingRange >= 1.5 && s.hearingRange <= 30,
      "ranges",
    );
    // Double-edged: the mean resonance stays near neutral (nobody is more or less vulnerable overall).
    const meanRes = SENSE_IDS.reduce((t, id) => t + s.resonance[id], 0) / SENSE_IDS.length;
    assert(meanRes > 0.85 && meanRes < 1.15, `mean resonance ~1, got ${meanRes}`);
  }
});

Deno.test("senses: bigger ears => more hearing AND more sonic resonance, other senses pay [P5-G2]", () => {
  const { ph, helix } = fixture(7);
  const small = sensesOf(withEars(ph, 0.05), helix);
  const big = sensesOf(withEars(ph, 0.95), helix);
  assert(
    big.acuity.hearing > small.acuity.hearing * 1.5,
    `hearing ${small.acuity.hearing} -> ${big.acuity.hearing}`,
  );
  assert(big.hearingRange > small.hearingRange, "hears farther");
  assert(big.resonance.hearing > small.resonance.hearing, "resonates more");
  const roar = ALL_MOVE_BY_ID["roar"];
  assertEquals(channelOfMove(roar), "hearing");
  assert(
    resonanceMult(big, channelOfMove(roar)) > resonanceMult(small, channelOfMove(roar)),
    "a roar hurts big ears more",
  );
  assertAlmostEquals(sum(big), SENSE_BUDGET, 1e-9);
  assert(big.acuity.vision < small.acuity.vision, "budget: vision pays for the ears");
});

Deno.test("senses: more / wider eyes widen the field of view, bigger eyes see farther", () => {
  const { ph, helix } = fixture(11);
  const narrow = sensesOf(ph, withEyes(helix, { count: 2, yaw: 0.1, spread: 0.1 }));
  const wide = sensesOf(ph, withEyes(helix, { count: 6, yaw: 1.2, spread: 0.9 }));
  assert(wide.fovHalf > narrow.fovHalf + 0.8, `fov ${narrow.fovHalf} -> ${wide.fovHalf}`);
  const smallEyes = sensesOf(ph, withEyes(helix, {}, 0.13));
  const bigEyes = sensesOf(ph, withEyes(helix, {}, 0.44));
  assert(
    bigEyes.visionRange > smallEyes.visionRange * 1.5,
    `range ${smallEyes.visionRange} -> ${bigEyes.visionRange}`,
  );
  assert(bigEyes.resonance.vision > smallEyes.resonance.vision, "big eyes are dazzled more");
});

Deno.test("senses: a long forked tongue smells and tastes more (snakes)", () => {
  const { ph, helix } = fixture(3);
  const p5 = helix.p5 ?? P5_DEFAULTS;
  const none = sensesOf(ph, {
    ...helix,
    mouth: { ...helix.mouth, tongue: false },
    p5: { ...p5, mouth: { ...p5.mouth, tongueLength: 0, tongueFork: false } },
  });
  const fork = sensesOf(ph, {
    ...helix,
    mouth: { ...helix.mouth, tongue: true },
    p5: { ...p5, mouth: { ...p5.mouth, tongueLength: 1.1, tongueFork: true } },
  });
  assert(fork.acuity.smell > none.acuity.smell, "smell");
  assert(fork.acuity.taste > none.acuity.taste * 1.5, "taste");
  assert(fork.organ.smell.includes("forked"), fork.organ.smell);
});

Deno.test("senses: channelOfMove maps the real catalogue (named cases + share)", () => {
  const want: Record<string, SenseId | null> = {
    roar: "hearing",
    dreadHowl: "hearing",
    thunderClap: "hearing",
    dazzle: "vision",
    blindingFlash: "vision",
    petrifyGaze: "vision",
    psiBeam: "psychic",
    mindLock: "psychic",
    sparkBolt: "electro",
    thunderBeam: "electro",
    magnetPull: "magnet",
    ironRam: "magnet",
    quake: "vibration",
    burrow: "vibration",
    earthshatter: "vibration",
    miasma: "smell",
    toxicBreath: "smell",
    toxicSpit: "taste",
    venomFang: "touch",
    emberBite: "thermal",
    frostBreath: "thermal",
    tackle: "touch",
    bodySlam: "touch",
    seedShot: null,
  };
  for (const [id, ch] of Object.entries(want)) {
    const m = ALL_MOVE_BY_ID[id];
    assert(m, `move ${id} exists`);
    assertEquals(channelOfMove(m), ch, `channel of ${id}`);
  }
  const mapped = ALL_MOVES.filter((m) => channelOfMove(m) !== null).length;
  const share = mapped / ALL_MOVES.length;
  console.log(
    `channelOfMove: ${mapped}/${ALL_MOVES.length} moves travel through a sense (${
      (share * 100).toFixed(0)
    } %)`,
  );
  assert(share >= 0.6 && share < 1, `a decent share maps, not all: ${share}`);
  const used = new Set(ALL_MOVES.map(channelOfMove).filter((c) => c !== null));
  for (const id of SENSE_IDS) assert(used.has(id), `some move uses ${id}`);
});

Deno.test("senses: resonanceMult is neutral without a channel and tracks acuity", () => {
  const { ph, helix } = fixture(5);
  const s = sensesOf(ph, helix);
  assertEquals(resonanceMult(s, null), 1);
  for (const m of ALL_MOVES) {
    const r = resonanceMult(s, channelOfMove(m)), k = senseDamageMult(s, m);
    assertAlmostEquals(k - 1, SENSE_DAMAGE_WEIGHT * (r - 1), 1e-12, `damage weight on ${m.id}`);
    assertAlmostEquals(senseDamageMult(s, m, 1), r, 1e-12);
  }
  for (const id of SENSE_IDS) {
    const r = resonanceMult(s, id);
    assert(r >= RESONANCE_MIN && r <= RESONANCE_MAX);
    if (s.acuity[id] > SENSE_MEAN * 1.05) assert(r > 1, `${id} above mean resonates > 1`);
    if (s.acuity[id] < SENSE_MEAN * 0.95) assert(r < 1, `${id} below mean resonates < 1`);
  }
});

Deno.test("senses: perceive uses yaw = atan2(dx, dz): front seen, behind only heard, far unaware [P5-B2]", () => {
  const { ph, helix } = fixture(9);
  const s: SenseProfile = { ...sensesOf(ph, helix), fovHalf: 1, visionRange: 10, hearingRange: 6 };
  const o = { x: 0, z: 0, yaw: 0 };
  const front = perceive(o, s, { x: 0, z: 5 });
  assert(front.seen && front.awareness >= 0.6, "in front, in range -> seen");
  const behind = perceive(o, s, { x: 0, z: -4 });
  assert(!behind.seen && behind.heard, "behind, close -> heard not seen");
  assert(behind.awareness < front.awareness, "hearing gives less awareness than sight");
  const silent = perceive(o, s, { x: 0, z: -4 }, 0);
  assert(!silent.heard, "silent target not heard");
  const far = perceive(o, s, { x: 0, z: -40 });
  assert(!far.seen && !far.heard && far.awareness === 0, "far behind -> unaware");
  const east = perceive({ x: 0, z: 0, yaw: Math.PI / 2 }, s, { x: 5, z: 0 });
  assert(east.seen, "yaw pi/2 faces +x");
  const tooFar = perceive(o, s, { x: 0, z: 12 });
  assert(!tooFar.seen, "beyond vision range not seen");
});

Deno.test("senses: head scars dim vision (sum only shrinks); a hearing imprint specialises hearing", () => {
  const g = createGenemon({ seed: 21, level: 20 });
  const ph = phenotypeOf(g), helix = helixOf(g.genome, ph);
  const base = sensesOf(ph, helix);
  const life: LifeState = newLifeState(g, 0);
  life.scars.push({ atDay: 10, part: "head", severity: 1, from: "physical", side: 1, u: 0.5, angle: 0 });
  const scarred = sensesOf(ph, helix, life);
  assert(scarred.acuity.vision < base.acuity.vision, "vision dimmed");
  assert(sum(scarred) < SENSE_BUDGET, "never above budget");
  const life2: LifeState = newLifeState(g, 0);
  life2.imprints.push({ itemId: "test", trait: "hearing", strength: 1, since: 0, generation: 0 });
  const imp = sensesOf(ph, helix, life2);
  assert(imp.acuity.hearing > base.acuity.hearing, "imprint bends hearing up");
  assertAlmostEquals(sum(imp), SENSE_BUDGET, 1e-9, "imprints stay budget-neutral");
  assertEquals(JSON.stringify(sensesOf(ph, helix, life2)), JSON.stringify(imp), "deterministic");
});
