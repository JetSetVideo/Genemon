// Colossus vs six [P6-B1, P6-B2]: XXL fixtures, the team-quality score and composer, the ColossusJob harness
// (determinism, slicing, draws excluded, Wilson) and the colossus-facing battle mechanics. Small n: seconds.
import { assert, assertEquals } from "./_assert.ts";
import { Battle, TUNING } from "../src/combat/battle.ts";
import { arenaSpec, team } from "../src/combat/scenario.ts";
import { kitStrength, QUALITY_WEIGHTS, synergies, teamQuality } from "../src/combat/team.ts";
import { hashSeed } from "../src/core/rng.ts";
import { typeMultiplier } from "../src/data/elements.ts";
import { POWER_BUDGET, SLOT_COST } from "../src/data/sizeBudget.ts";
import { phenotypeOf } from "../src/genome/genemon.ts";
import {
  BATCH_ELEMENTS,
  buildColossus,
  colossusMatrix,
  colossusReportMarkdown,
  ColossusJob,
  composeSix,
  elementEdge,
  QUALITY_BRACKETS,
} from "../src/sim/batch.ts";

Deno.test("colossus: the GenomeBias recipe builds an XXL (6 slots) of every requested element at levels 10 / 25 / 50", () => {
  const stats = { built: 0, missedClass: 0, missedElement: 0 };
  for (const level of [10, 25, 50]) {
    for (const e of BATCH_ELEMENTS) {
      const g = buildColossus(e, hashSeed("ct", e, level), level, "c", stats);
      const ph = phenotypeOf(g);
      assertEquals(ph.sizeClass, "XXL", `${e} L${level} is ${ph.sizeClass} (${ph.massKg.toFixed(0)} kg)`);
      assertEquals(ph.slots, 6, "a colossus fills the team alone");
      assertEquals(ph.elements.primary, e, `${e} L${level} primary`);
    }
  }
  assertEquals(stats.built, 39);
  assertEquals(stats.missedClass + stats.missedElement, 0, "no recipe miss");
  // Budget [SPEC B1]: the colossus's power is its class budget, a little under six S bodies' worth per slot.
  assert(POWER_BUDGET.XXL / SLOT_COST.XXL < POWER_BUDGET.S, "XXL buys less than 1 S per slot");
});

Deno.test("colossus: teamQuality is in [0, 1], deterministic, and rewards coverage + mixed synergies", () => {
  const col = buildColossus("fire", 11, 25);
  const good = composeSix(col, "good", 7, 25);
  const poor = composeSix(col, "poor", 7, 25);
  const median = composeSix(col, "median", 7, 25);
  for (const s of [good, poor, median]) {
    assertEquals(s.members.length, 6);
    for (const g of s.members) assertEquals(phenotypeOf(g).slots, 1, "six small Genemon, one slot each");
    for (const k of ["score", "synergy", "offense", "defense", "diversity", "kit"] as const) assert(s.quality[k] >= 0 && s.quality[k] <= 1, `${k} ${s.quality[k]}`);
  }
  assertEquals(JSON.stringify(teamQuality(good.members, [col])), JSON.stringify(good.quality), "deterministic");
  assertEquals(JSON.stringify(composeSix(col, "good", 7, 25).members.map((g) => g.id)), JSON.stringify(good.members.map((g) => g.id)), "composer deterministic");
  assert(good.quality.score > median.quality.score && median.quality.score > poor.quality.score, `good ${good.quality.score} > median ${median.quality.score} > poor ${poor.quality.score}`);
  assert(good.quality.offense > poor.quality.offense && good.quality.defense > poor.quality.defense, "good covers the colossus's weaknesses");
  // Poor = one element, the one with the worst edge against the colossus.
  const pe = new Set(poor.members.map((g) => phenotypeOf(g).elements.primary));
  assertEquals(pe.size, 1, "poor six is mono-element");
  const e = [...pe][0];
  for (const x of BATCH_ELEMENTS) assert(elementEdge(e, col) <= elementEdge(x, col) + 1e-9, `${e} is the worst edge (vs ${x})`);
  assert(poor.quality.synergy < good.quality.synergy, `mono team: fewer mixed synergies (${poor.quality.synergy} < ${good.quality.synergy})`);
  assert(good.quality.synergy >= 0.5, `good six forms mixed synergies (${synergies(team("g", good.members)).map((s) => s.id).join(",")})`);
  const w = Object.values(QUALITY_WEIGHTS).reduce((a, b) => a + b, 0);
  assert(Math.abs(w - 1) < 1e-9, "weights sum to 1");
  assert(kitStrength(good.members[0]) > 0, "kit strength from damaging moves");
});

Deno.test("colossus: ColossusJob is deterministic, sliceable, excludes draws, Wilson brackets p, pairs the brackets", () => {
  const a = colossusMatrix(2, 3, [25]);
  const b = colossusMatrix(2, 3, [25]);
  assertEquals(JSON.stringify(a.cells), JSON.stringify(b.cells), "same seed, same cells");
  assertEquals(a.battles, 1 * QUALITY_BRACKETS.length * 2);
  const job = new ColossusJob(2, 3, [25]);
  let slices = 0;
  while (!job.advance(() => false, 1)) slices++;
  assert(slices >= 4, "worked in slices");
  assertEquals(JSON.stringify(job.result().cells), JSON.stringify(a.cells), "sliced = one-shot");
  for (const c of [...a.cells.flat(), ...a.pooled]) {
    assertEquals(c.n, c.wins + c.losses, "decisive only");
    if (c.n) assert(Math.abs(c.p - c.wins / c.n) < 1e-12 && c.lo <= c.p && c.p <= c.hi, "Wilson brackets p");
    assert(c.quality.score >= 0 && c.quality.score <= 1, "mean quality in range");
  }
  assertEquals(a.colossusBuild.built, 2, "one colossus per (level, battle index), shared by the three brackets");
  const md = colossusReportMarkdown(a, b);
  assert(md.includes("## 6. Colossus vs six") && md.includes("held-out seed"), "report section");
});

Deno.test("colossus: the brackets order the outcome (good six > poor six vs the same colossi) and the verdict CAN fail", () => {
  // n=20 per bracket: the full-size verdict (n=48, three levels, held-out seed) is tools/batch.ts; this only guards the order.
  const r = colossusMatrix(20, 41, [25]);
  const [poor, , good] = r.pooled;
  assert(good.p > poor.p + 0.1, `good ${good.p} vs poor ${poor.p}`);
  // A +60 % colossus budget flips the verdict: fresh seeds so no cached phenotype carries the old budget.
  const saved = POWER_BUDGET.XXL;
  POWER_BUDGET.XXL = saved * 1.6;
  try {
    const boosted = colossusMatrix(8, 977, [25]);
    assert(!boosted.verdict.goodBeatsColossus || boosted.pooled[2].p < good.p, `boosted colossus: good six ${boosted.pooled[2].p}`);
    assert(boosted.flags.length > 0, "an out-of-band cell is flagged");
  } finally {
    POWER_BUDGET.XXL = saved;
  }
});

Deno.test("colossus: battle mechanics - softened type chart, narrow contact factor, focus fire, unstoppable", () => {
  const col = buildColossus("water", 5, 25);
  const six = composeSix(col, "median", 5, 25).members;
  const b = new Battle({ seed: 9, arena: arenaSpec("meadow", 9, "clear", 13), teams: [team("six", six), team("col", [col])] });
  const C = b.fighters.find((f) => f.team === 1)!;
  const S = b.fighters.filter((f) => f.team === 0);
  // Type chart to / from an XXL is raised to colossusTypeExp: electric (x2 on water) hits it for 2^exp.
  const k = (b as any).typeK("electric", C, S[0]);
  assert(Math.abs(k - Math.pow(typeMultiplier("electric", C.types), TUNING.colossusTypeExp)) < 1e-9, `typeK ${k}`);
  assert(k < typeMultiplier("electric", C.types), "softened");
  // Contact size factor with a colossus stays inside colossusSizeLo .. colossusSizeHi.
  const slam = { tags: ["contact", "massScaled"] } as never;
  const up = b.sizeK(C, S[0], slam), down = b.sizeK(S[0], C, slam);
  assert(up <= TUNING.colossusSizeHi + 1e-9 && down >= TUNING.colossusSizeLo - 1e-9, `size ${up} / ${down}`);
  // Focus fire: a second attacker on the same target hits harder; the first does not.
  assertEquals(b.focusFire(S[0], C), 1, "nobody hit it yet");
  (b as any).hitLog.set(C.idx, new Map([[S[1].idx, b.t]]));
  assert(Math.abs(b.focusFire(S[0], C) - (1 + TUNING.focusFire)) < 1e-9, "one ally converged");
  assertEquals(b.focusFire(S[1], C), 1, "its own hit does not count");
  // Unstoppable: a stun on the colossus's charge does not cancel it (it still loses the stunned time).
  const m = C.moves[0];
  assert(m, "colossus has a move");
  C.costs = C.costs.map(() => 0);
  (b as any).startMove(C, m, S[0].idx);
  (b as any).addStatus(C, "stunned", 1.2, S[0]);
  assertEquals(C.phase, "charge", "still charging");
  assertEquals(C.interrupted, 0, "not interrupted");
  const small = S[2];
  small.costs = small.costs.map(() => 0);
  (b as any).startMove(small, small.moves[0], C.idx);
  (b as any).addStatus(small, "stunned", 1.2, C);
  assertEquals(small.interrupted, 1, "a small body is interrupted");
});
