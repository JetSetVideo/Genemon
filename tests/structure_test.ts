// Pass 6 nature x nurture [P6-N1]: attractor weights (sum 1, one dominant, consistent with the body kind),
// nurture from REAL activity ids (swimming -> fins, gym -> arms / shoulders, flight -> wings, km -> legs,
// fights -> armour / horns), saturating and capped, plain-language reasons, and the helix bent by ph.nurture.
import { assert, assertAlmostEquals, assertEquals } from "./_assert.ts";
import { type Genome, randomGenome } from "../src/genome/genome.ts";
import { express, type Phenotype } from "../src/genome/phenotype.ts";
import { type Conditions, emptyConditions } from "../src/genome/epigenetics.ts";
import { helixOf } from "../src/genome/helix.ts";
import { complexityOf } from "../src/genome/complexity.ts";
import { ATTRACTOR_IDS, ATTRACTORS, BATTLE_SOURCES, dominantAttractor, natureOf, nurtureOf } from "../src/genome/structure.ts";
import { NURTURE_CAP, type AttractorId, type NurtureTrait } from "../src/genome/p6Types.ts";
import { EXPERIENCE_IDS, FOOD_IDS } from "../src/data/lifestyle.ts";
import { GROUND_IDS } from "../src/data/grounds.ts";

const N = 3000;
const wild: Genome[] = Array.from({ length: N }, (_, i) => randomGenome(40_000_000 + i));
const TRAITS: NurtureTrait[] = ["neckLength", "legLength", "armSize", "shoulderWidth", "wingSpan", "tailLength", "armor", "finSize", "girth", "hornSize", "eyeSize", "furDensity"];
const life = (f: (c: Conditions) => void) => {
  const c = emptyConditions();
  f(c);
  return c;
};

Deno.test("structure: ten attractors, real fedBy ids, known traits", () => {
  assertEquals(ATTRACTOR_IDS.join(), "globe,quadruped,biped,avian,serpent,hexapod,cephalopod,larval,armored,chimera");
  const real = new Set<string>([...EXPERIENCE_IDS, ...FOOD_IDS, ...GROUND_IDS, ...BATTLE_SOURCES]);
  for (const a of ATTRACTORS) {
    assert(a.fedBy.length >= 3, `${a.id} fedBy`);
    for (const id of a.fedBy) assert(real.has(id), `${a.id}: ${id} is not a real activity / food / ground id`);
    for (const t of Object.keys(a.pulls)) assert(TRAITS.includes(t as NurtureTrait), `${a.id}: trait ${t}`);
  }
  const by = Object.fromEntries(ATTRACTORS.map((a) => [a.id, a]));
  assert(by.cephalopod.fedBy.includes("swimming") && by.cephalopod.pulls.finSize! > 1, "swimming feeds fins");
  assert(by.biped.fedBy.includes("gymTraining") && by.biped.pulls.armSize! > 1, "gym feeds arms");
  assert(by.avian.fedBy.includes("flightTime") && by.avian.pulls.wingSpan! > 1, "flight feeds wings");
  assert(by.quadruped.fedBy.includes("travelKm") && by.quadruped.pulls.legLength! > 1, "running feeds legs");
  assert(by.armored.fedBy.includes("battles") && by.armored.pulls.armor! > 1, "fights feed armour");
});

Deno.test("nature: weights sum to 1, usually one dominant, consistent with the body kind", () => {
  const allowed: Record<Genome["kind"], AttractorId[]> = {
    quadruped: ["quadruped", "chimera"],
    biped: ["biped", "chimera"],
    avian: ["avian", "chimera"],
    serpent: ["serpent", "chimera"],
    hexapod: ["hexapod", "chimera"],
    blob: ["globe", "cephalopod", "chimera"],
  };
  let strong = 0;
  for (const g of wild) {
    const w = natureOf(g);
    const sum = ATTRACTOR_IDS.reduce((s, id) => s + w[id], 0);
    assertAlmostEquals(sum, 1, 1e-9, "weights sum to 1");
    for (const id of ATTRACTOR_IDS) assert(w[id] >= 0 && w[id] <= 1, `${id} ${w[id]}`);
    const dom = dominantAttractor(w);
    assert(allowed[g.kind].includes(dom), `${g.kind} dominated by ${dom}`);
    if (w[dom] >= 0.45) strong++;
    const p = complexityOf(g);
    if (p.tier === "minimal") assertEquals(dom, "globe");
    if (g.kind === "blob" && p.counts.tentacles > 0 && p.tier !== "mythic") assertEquals(dom, "cephalopod");
  }
  assert(strong / N >= 0.9, `one dominant attractor in ${strong / N}`);
  // Secondary tendencies follow the genes: hard spiky genomes lean armoured, long segmented legless ones larval.
  const hard = wild.filter((g) => g.axes.hardness[0] + g.axes.hardness[1] > 1);
  const soft = wild.filter((g) => g.axes.hardness[0] + g.axes.hardness[1] < -1);
  const mean = (gs: Genome[], id: AttractorId) => gs.reduce((s, g) => s + natureOf(g)[id], 0) / gs.length;
  assert(mean(hard, "armored") > 2 * mean(soft, "armored"), "hardness feeds the armoured tendency");
  assertEquals(JSON.stringify(natureOf(wild[0])), JSON.stringify(natureOf(structuredClone(wild[0]))), "deterministic");
});

Deno.test("nurture: no life = nature, no shift, no reasons", () => {
  for (const g of wild.slice(0, 50)) {
    const n = nurtureOf(g, emptyConditions());
    const w = natureOf(g);
    for (const id of ATTRACTOR_IDS) assertAlmostEquals(n.weights[id], w[id], 1e-12);
    assertEquals(Object.keys(n.shift).length, 0);
    assertEquals(n.reasons.length, 0);
  }
});

Deno.test("nurture: swimming raises fins, gym arms and shoulders, flight wings, km legs, fights armour and horns", () => {
  const g = wild.find((x) => x.kind === "quadruped")!;
  const swim = nurtureOf(g, life((c) => (c.experiences.swimming = 40)));
  assert((swim.shift.finSize ?? 1) > 1.08, `swimming 40 -> finSize ${swim.shift.finSize}`);
  assert(swim.reasons[0].startsWith("Swimming x40 -> fins +"), swim.reasons[0]);
  const gym = nurtureOf(g, life((c) => (c.experiences.gymTraining = 40)));
  assert((gym.shift.armSize ?? 1) > 1.08 && (gym.shift.shoulderWidth ?? 1) > 1.06, JSON.stringify(gym.shift));
  assert(gym.weights.biped > natureOf(g).biped, "the gym leans toward the biped structure");
  const fly = nurtureOf(g, life((c) => (c.experiences.flightTime = 40)));
  assert((fly.shift.wingSpan ?? 1) > 1.08, JSON.stringify(fly.shift));
  const run = nurtureOf(g, life((c) => (c.experiences.travelKm = 60)));
  assert((run.shift.legLength ?? 1) > 1.08, JSON.stringify(run.shift));
  const fight = nurtureOf(g, life((c) => {
    c.battles.won = 30;
    c.battles.lost = 20;
    c.battles.kos = 25;
  }));
  assert((fight.shift.armor ?? 1) > 1.05 && (fight.shift.hornSize ?? 1) > 1.05, JSON.stringify(fight.shift));
  assert(fight.weights.armored > natureOf(g).armored, "fights lean armoured");
  // Real foods and grounds too.
  const iron = nurtureOf(g, life((c) => (c.diet.ironNut = 20)));
  assert((iron.shift.armor ?? 1) > 1.05, JSON.stringify(iron.shift));
  const sea = nurtureOf(g, life((c) => (c.exposure.deepWater = 60)));
  assert((sea.shift.finSize ?? 1) > 1.05, JSON.stringify(sea.shift));
  // FALSIFIER: an unrelated activity does not grow fins or arms.
  const music = nurtureOf(g, life((c) => (c.experiences.music = 200)));
  assertEquals(music.shift.finSize, undefined);
  assertEquals(music.shift.armSize, undefined);
});

Deno.test("nurture: nature first - the same swim grows a cephalopod's fins more than a quadruped's", () => {
  const ceph = wild.find((g) => dominantAttractor(natureOf(g)) === "cephalopod")!;
  const quad = wild.find((g) => g.kind === "quadruped")!;
  const c = life((x) => (x.experiences.swimming = 30));
  assert(nurtureOf(ceph, c).shift.finSize! > nurtureOf(quad, c).shift.finSize!, "aptitude follows the body plan");
});

Deno.test("nurture: CAPPED - extreme lives stay within 1 +- NURTURE_CAP and never replace the dominant structure", () => {
  const extreme = life((c) => {
    for (const id of EXPERIENCE_IDS) c.experiences[id] = 1e6;
    for (const id of FOOD_IDS) c.diet[id] = 1e6;
    for (const id of GROUND_IDS) c.exposure[id] = 1e6;
    c.battles.won = 1e6;
    c.battles.kos = 1e6;
  });
  let kept = 0;
  const swimOnly = life((c) => (c.experiences.swimming = 1e6));
  for (const g of wild.slice(0, 600)) {
    for (const c of [extreme, swimOnly]) {
      const n = nurtureOf(g, c);
      for (const [t, v] of Object.entries(n.shift)) assert(v >= 1 - NURTURE_CAP - 1e-9 && v <= 1 + NURTURE_CAP + 1e-9, `${t} ${v}`);
      assertAlmostEquals(ATTRACTOR_IDS.reduce((s, id) => s + n.weights[id], 0), 1, 1e-9);
      const nat = natureOf(g);
      for (const id of ATTRACTOR_IDS) {
        // Each weight moves by at most a factor (1 + CAP) either way (bent by 1 + CAP tanh, renormalised).
        assert(n.weights[id] <= nat[id] * (1 + NURTURE_CAP) + 1e-12, `${id} grew ${nat[id]} -> ${n.weights[id]}`);
        assert(n.weights[id] >= nat[id] / (1 + NURTURE_CAP) - 1e-12, `${id} shrank ${nat[id]} -> ${n.weights[id]}`);
      }
    }
    if (dominantAttractor(nurtureOf(g, swimOnly).weights) === dominantAttractor(natureOf(g))) kept++;
  }
  assert(kept / 600 >= 0.95, `dominant structure kept under a lifetime of swimming: ${kept / 600}`);
  // Saturation: doubling an already huge practice barely moves the shift.
  const g = wild[1];
  const a = nurtureOf(g, life((c) => (c.experiences.gymTraining = 500))).shift.armSize!;
  const b = nurtureOf(g, life((c) => (c.experiences.gymTraining = 1000))).shift.armSize!;
  assert(b - a < 0.02 && b <= 1 + NURTURE_CAP, `saturates ${a} -> ${b}`);
});

Deno.test("helix: nurture bends the traits it drives (wings, tail, shoulders, eyes, plates); absent nurture = identity", () => {
  const winged = wild.filter((g) => complexityOf(g).counts.wingPairs > 0 && g.kind !== "avian").slice(0, 40);
  assert(winged.length >= 20, "winged sample");
  const bend = (g: Genome, c: Conditions) => {
    const ph = express(g, emptyConditions());
    const nat = helixOf(g, ph);
    const bent = helixOf(g, { ...ph, nurture: nurtureOf(g, c) } as Phenotype);
    return { nat, bent };
  };
  let grew = 0;
  for (const g of winged) {
    const { nat, bent } = bend(g, life((c) => (c.experiences.flightTime = 80)));
    if (bent.wings.kind !== "fin" && bent.wings.span > nat.wings.span) grew++;
    assert(bent.wings.span <= 3.6 && bent.wings.span >= 1.0, `span ${bent.wings.span}`);
  }
  assert(grew >= winged.length * 0.8, `flight grew wings in ${grew}/${winged.length}`);
  const g = wild.find((x) => x.kind === "quadruped" && complexityOf(x).counts.tails > 0)!;
  const gym = bend(g, life((c) => (c.experiences.gymTraining = 60)));
  assert(gym.bent.p5!.body.shoulder.width > gym.nat.p5!.body.shoulder.width || gym.nat.p5!.body.shoulder.width >= 1.45, "gym -> shoulders");
  const swim = bend(g, life((c) => (c.experiences.swimming = 80)));
  assert(swim.bent.p5!.body.tail.length > swim.nat.p5!.body.tail.length, "swimming -> tail");
  const night = bend(g, life((c) => (c.experiences.nightWalk = 80)));
  assert(night.bent.eyes.size >= night.nat.eyes.size, "night walks -> eyes");
  const armour = wild.find((x) => helixOf(x, express(x, emptyConditions())).surface.plates > 0.2)!;
  const iron = bend(armour, life((c) => (c.diet.ironNut = 40)));
  assert(iron.bent.surface.plates > iron.nat.surface.plates, "iron nuts -> plates");
  // Genes first: counts and kinds never change with nurture.
  assertEquals(JSON.stringify(iron.bent.p6), JSON.stringify(iron.nat.p6));
  assertEquals(iron.bent.eyes.count, iron.nat.eyes.count);
  // Absent nurture (pass-5 phenotype) and an empty nurture leave the helix identical.
  const ph = express(g, emptyConditions());
  assertEquals(JSON.stringify(helixOf(g, ph)), JSON.stringify(helixOf(g, { ...ph, nurture: nurtureOf(g, emptyConditions()) } as Phenotype)));
});
