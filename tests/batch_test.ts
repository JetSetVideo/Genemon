// Batch lab [P5-X1]: archetype builders, matchup matrix (draws excluded, Wilson, flags that CAN fail),
// batch breeding (determinism, selection pressure, best child). Small n so the file runs in seconds.
import { assert, assertEquals } from "./_assert.ts";
import { u01 } from "../src/core/math.ts";
import { hashSeed } from "../src/core/rng.ts";
import { createGenemon, type Genemon, phenotypeOf } from "../src/genome/genemon.ts";
import { SLOT_COST } from "../src/genome/phenotype.ts";
import {
  ARCHETYPE_BY_ID,
  type ArchetypeId,
  BATCH_ARCHETYPES,
  type BatchArchetype,
  batchReportMarkdown,
  breedBatch,
  BreedJob,
  buildSide,
  classifyArchetype,
  DOMINANT_ROW,
  emptyBuildStats,
  gauntletFitness,
  matchupMatrix,
  MatrixJob,
} from "../src/sim/batch.ts";

const A = ARCHETYPE_BY_ID;

Deno.test("batch: six archetypes incl. fast / powerful / clever / tank / sensory; none sets stature", () => {
  const ids = BATCH_ARCHETYPES.map((a) => a.id);
  assertEquals(new Set(ids).size, ids.length, "unique ids");
  for (const id of ["fast", "powerful", "clever", "tank", "sensory", "swarm"] as const) assert(ids.includes(id), `missing ${id}`);
  for (const a of BATCH_ARCHETYPES) assert(a.axes.stature === undefined, `${a.id} must not buy size with stature`);
  assert((A.sensory.plan?.ears ?? 0) > 0.8 && (A.sensory.plan?.eyes ?? 0) > 0.8, "sensory = big ears and eyes");
});

Deno.test("batch: buildSide fields the slot budget at the right class, the requested element, equal power per slot", () => {
  const stats = emptyBuildStats();
  const perSlot: Record<string, number> = {};
  for (const a of BATCH_ARCHETYPES) {
    let sum = 0, n = 0;
    for (const slots of [2, 3]) {
      for (const e of ["fire", "water", "metal"] as const) {
        const side = buildSide(a, e, slots, hashSeed("t", a.id, slots, e), 25, "t", stats);
        assertEquals(side.reduce((s, g) => s + SLOT_COST[phenotypeOf(g).sizeClass], 0), slots, `${a.id} slots ${slots}`);
        if (a.swarm) assertEquals(side.length, slots, "swarm = one S body per slot");
        else assertEquals(side.length, 1);
        for (const g of side) (sum += phenotypeOf(g).power / phenotypeOf(g).slots), n++;
      }
    }
    perSlot[a.id] = sum / n;
  }
  assertEquals(stats.missed, 0, "every body reached its size class");
  assert(stats.elementHits / stats.built >= 0.85, `element emerged in ${stats.elementHits}/${stats.built}`);
  const vals = Object.values(perSlot), lo = Math.min(...vals), hi = Math.max(...vals);
  assert(hi / lo < 1.12, `power per slot spread ${JSON.stringify(perSlot)} (budget [SPEC B1])`);
});

Deno.test("batch: archetypes differ in SHAPE (fast is faster and dodgier, tank harder, powerful hits harder)", () => {
  const prof = (id: ArchetypeId) => {
    const ph = phenotypeOf(buildSide(A[id], "fire", 2, hashSeed("shape", id))[0]);
    return ph.stats;
  };
  const fast = prof("fast"), tank = prof("tank"), pow = prof("powerful");
  assert(fast.spd > tank.spd && fast.spd > pow.spd, "fast is fastest");
  assert(fast.evasion > tank.evasion, "fast dodges more");
  assert(tank.def > fast.def, "tank has more defence");
  assert(pow.atk > fast.atk && pow.atk > tank.atk, `powerful hits hardest (${pow.atk} vs ${fast.atk} / ${tank.atk})`);
});

Deno.test("batch: classifyArchetype recovers the archetype of a full-strength body", () => {
  for (const id of ["fast", "powerful", "tank", "sensory", "swarm"] as const) {
    let hit = 0;
    for (let s = 0; s < 4; s++) if (classifyArchetype(buildSide(A[id], "water", 2, hashSeed("cls", id, s))[0]) === id) hit++;
    assert(hit >= 3, `${id} classified ${hit}/4`);
  }
});

Deno.test("batch: matchupMatrix is deterministic, excludes draws, mirrors cells, Wilson brackets p", () => {
  const arch = [A.fast, A.powerful, A.tank];
  const m1 = matchupMatrix(arch, 4, 11);
  const m2 = matchupMatrix(arch, 4, 11);
  assertEquals(JSON.stringify(m1.cells), JSON.stringify(m2.cells), "same seed, same matrix");
  assertEquals(m1.battles, 6 * 4, "6 unordered pairs x 4");
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      const c = m1.cells[i][j];
      assertEquals(c.n, c.wins + c.losses, "decisive only");
      if (c.n) assert(Math.abs(c.p - c.wins / c.n) < 1e-12 && c.lo <= c.p && c.p <= c.hi, "Wilson brackets p");
      if (i !== j) {
        assertEquals(c.wins, m1.cells[j][i].losses, "complementary cells");
        assertEquals(c.draws, m1.cells[j][i].draws, "draws mirrored");
      } else assertEquals(c.wins + c.losses + c.draws, 4, "mirror cell counts its own battles");
    }
  }
  for (const r of m1.rows) assert(r.overall.n <= 8 && r.medianDuration > 0, "row aggregates exclude the mirror");
  const md = batchReportMarkdown(m1);
  assert(md.includes("## 4. Weights, costs and probabilities") && md.includes("power budget"), "report explains weights");
});

Deno.test("batch: sliced MatrixJob equals the one-shot matrix", () => {
  const arch = [A.clever, A.sensory];
  const job = new MatrixJob(arch, 4, 3);
  let slices = 0;
  while (!job.advance(() => false, 2)) slices++;
  assert(slices >= 4, "worked in several slices");
  assertEquals(JSON.stringify(job.result().cells), JSON.stringify(matchupMatrix(arch, 4, 3).cells));
});

Deno.test("batch: the dominance flag CAN fail (a +30 level archetype is flagged)", () => {
  const boosted: BatchArchetype = { ...A.fast, id: "boosted" as ArchetypeId, label: "Boosted", levelBonus: 30 };
  const m = matchupMatrix([boosted, A.powerful, A.tank], 6, 21);
  const row = m.rows[0];
  assert(row.overall.p > DOMINANT_ROW, `boosted overall ${row.overall.p}`);
  assert(!m.verdict.noDominantRow && m.flags.some((f) => f.startsWith("Boosted: DOMINANT")), m.flags.join("; "));
  assert(row.pros.some((p) => p.startsWith("beats")), "its pros list the archetypes it beats");
});

Deno.test("batch: breedBatch is deterministic, keeps popSize, reports every generation, returns a bred child", () => {
  const seedPop = [0, 1, 2].map((i) => createGenemon({ seed: hashSeed("bt5-seed", i), owner: "me", level: 20 }));
  const fit = (g: Genemon) => u01(phenotypeOf(g).axes.tempo);
  const r1 = breedBatch(seedPop, 3, 6, fit, 9, { owner: "me" });
  const r2 = breedBatch(seedPop, 3, 6, fit, 9, { owner: "me" });
  assertEquals(JSON.stringify(r1.generations), JSON.stringify(r2.generations), "deterministic");
  assertEquals(r1.generations.length, 4, "gen 0..3");
  assertEquals(r1.evaluations, 4 * 6);
  for (const g of r1.generations) {
    assertEquals(g.size, 6);
    const share = Object.values(g.archetypeShare).reduce((s, v) => s + v, 0);
    assert(Math.abs(share - 1) < 1e-9, "archetype shares sum to 1");
    assert(Number.isFinite(g.diversity) && g.diversity >= 0 && Number.isFinite(g.meanPower), "finite stats");
  }
  const c = r1.bestChild!;
  assert(c && !seedPop.some((s) => s.id === c.id), "best child is bred, not a seed");
  assert(c.genome.generation >= 1 && c.owner === "me", "child generation and owner");
  assertEquals(phenotypeOf(c).level, 20, "children keep the seed population's median level");
});

Deno.test("batch: tournament selection moves the population toward the fitness (it can fail)", () => {
  const seedPop = Array.from({ length: 8 }, (_, i) => createGenemon({ seed: hashSeed("bt5-sel", i), level: 20 }));
  const tempo = (g: Genemon) => u01(phenotypeOf(g).axes.tempo);
  const up = breedBatch(seedPop, 6, 12, tempo, 4);
  const down = breedBatch(seedPop, 6, 12, (g) => 1 - tempo(g), 4);
  const last = (r: typeof up) => r.generations[r.generations.length - 1];
  assert(last(up).meanFitness > up.generations[0].meanFitness + 0.05, `tempo rises ${up.generations[0].meanFitness} -> ${last(up).meanFitness}`);
  assert(last(up).meanStats.rate > last(down).meanStats.rate, "faster charge rate when selected for tempo");
});

Deno.test("batch: BreedJob with the real gauntlet fitness (small) runs battles and stays in [0, 1]", () => {
  const seedPop = [createGenemon({ seed: hashSeed("bt5-g", 1), level: 25 }), createGenemon({ seed: hashSeed("bt5-g", 2), level: 25 })];
  const job = new BreedJob(seedPop, 1, 3, gauntletFitness({ archetypes: [A.fast, A.tank] }), 2);
  let slices = 0;
  while (!job.advance(() => false, 1)) slices++;
  const r = job.result();
  assertEquals(r.generations.length, 2);
  assert(slices >= 4 && r.fitness.every((f) => f >= 0 && f <= 1), `fitness ${r.fitness}`);
  assert(r.generations[0].bestFitness >= r.generations[0].meanFitness, "best >= mean");
});
