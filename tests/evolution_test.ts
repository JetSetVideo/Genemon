/**
 * Pass 6 evolution plans [P6-E1..E5]: kind / phase-count / curve distributions, exact levels on every XP curve,
 * monotone phases, cumulative unlocks, metamorphosis and molt shapes, fertility windows, determinism and legacy
 * genomes. Every test here can fail (thresholds are bands around the measured shares, not tautologies).
 */
import { assert, assertEquals } from "./_assert.ts";
import { hashSeed } from "../src/core/rng.ts";
import { Ledger } from "../src/core/ledger.ts";
import { randomGenome, type Genome } from "../src/genome/genome.ts";
import { emptyConditions } from "../src/genome/epigenetics.ts";
import { express } from "../src/genome/phenotype.ts";
import { complexityOf } from "../src/genome/complexity.ts";
import {
  evolutionPlanOf,
  fertileNow,
  levelCurve,
  phaseIndexAt,
  phaseOf,
  REF_AGE_DAYS,
  REF_LEVEL,
  unlocksUpTo,
  windowAtOrAfter,
  XP_CURVES,
} from "../src/genome/evolution.ts";
import { age, canBreed, createGenemon, fertilityOf, type Genemon, grantXp, phenotypeOf, stageName, stageOf } from "../src/genome/genemon.ts";
import { canFight, canRank, evolutionPath } from "../src/genome/lifeclock.ts";
import type { EvolutionKind, EvolutionPlan } from "../src/genome/p6Types.ts";

const wild = (s: number): Genome => randomGenome(s, hashSeed(s, "env"));
const N = 5000;
const plans: { s: number; g: Genome; p: EvolutionPlan }[] = [];
for (let s = 0; s < N; s++) {
  const g = wild(s);
  plans.push({ s, g, p: evolutionPlanOf(g) });
}
// Pass 6: minimal globes never gain parts and are size-capped (phenotype.ts): lineage-shape tests pick non-globes.
const firstOf = (pred: (p: EvolutionPlan) => boolean) => plans.find((x) => pred(x.p) && complexityOf(x.g).tier !== "minimal")!;
const condAt = (plan: EvolutionPlan, level: number, ageDays: number) => {
  const c = emptyConditions();
  c.xp = levelCurve(plan).xpForLevel(level);
  c.ageDays = ageDays;
  return c;
};

Deno.test("[P6-E1] kind and phase-count distributions over 5000 wild genomes: static ~12 %, median 3, max 6 (rare)", () => {
  const kinds: Record<EvolutionKind, number> = { static: 0, gradual: 0, metamorphosis: 0, molt: 0 };
  const counts = [0, 0, 0, 0, 0, 0, 0];
  for (const { p } of plans) {
    kinds[p.kind]++;
    counts[p.phases.length]++;
    assert(p.phases.length >= 1 && p.phases.length <= 6, `phase count ${p.phases.length}`);
    if (p.kind === "static") assertEquals(p.phases.length, 1, "static = one phase");
    else assert(p.phases.length >= 2, `${p.kind} has >= 2 phases`);
  }
  const share = (k: EvolutionKind) => kinds[k] / N;
  assert(share("static") >= 0.1 && share("static") <= 0.14, `static ${share("static")}`);
  assert(share("metamorphosis") >= 0.07 && share("metamorphosis") <= 0.11, `metamorphosis ${share("metamorphosis")}`);
  assert(share("molt") >= 0.07 && share("molt") <= 0.11, `molt ${share("molt")}`);
  const sorted = plans.map((x) => x.p.phases.length).sort((a, b) => a - b);
  assertEquals(sorted[Math.floor(N / 2)], 3, "median phase count");
  assertEquals(sorted[N - 1], 6, "max phase count");
  for (let n = 1; n <= 6; n++) assert(counts[n] > 0, `some lineages have ${n} phase(s)`);
  assert(counts[6] / N < 0.05, `6 phases rare: ${counts[6] / N}`);
  assert(counts[2] > 0.1 * N && counts[4] > 0.1 * N, "a real spread around the median");
});

Deno.test("[P6-E2] XP curves: short / normal / long shares, multipliers and max levels", () => {
  const n = { short: 0, normal: 0, long: 0 };
  for (const { p } of plans) {
    n[p.curve]++;
    assertEquals(p.xpMult, XP_CURVES[p.curve].xpMult);
    assertEquals(p.maxLevel, XP_CURVES[p.curve].maxLevel);
  }
  assert(n.short / N > 0.18 && n.short / N < 0.32, `short ${n.short / N}`);
  assert(n.long / N > 0.18 && n.long / N < 0.32, `long ${n.long / N}`);
  assert(XP_CURVES.short.xpMult < 1 && XP_CURVES.long.xpMult > 1, "short < 1 < long");
  assert(XP_CURVES.long.maxLevel < XP_CURVES.short.maxLevel, "short curves go higher");
  // Population mean comparable: geometric-mean multiplier within 5 % of the global curve.
  const gm = Math.exp(plans.reduce((s, x) => s + Math.log(x.p.xpMult), 0) / N);
  assert(Math.abs(gm - 1) < 0.05, `geometric mean xpMult ${gm}`);
});

Deno.test("[P6-E2] every curve: levelOf(xpForLevel(n)) === n, one xp short stays n-1, createGenemon(level n) is level n", () => {
  for (const curve of ["short", "normal", "long"] as const) {
    const { g, p } = firstOf((q) => q.curve === curve);
    const lc = levelCurve(p);
    for (let n = 1; n <= p.maxLevel; n++) {
      assertEquals(lc.levelOf(lc.xpForLevel(n)), n, `${curve} level ${n}`);
      if (n > 1) assertEquals(lc.levelOf(lc.xpForLevel(n) - 1), n - 1, `${curve} just below level ${n}`);
    }
    assertEquals(lc.levelOf(1e12), p.maxLevel, `${curve} capped at ${p.maxLevel}`);
    for (const n of [1, 2, 5, 10, 16, 25, 33, 50, p.maxLevel]) {
      const gm = createGenemon({ seed: 1, genome: g, level: n });
      assertEquals(phenotypeOf(gm).level, n, `${curve} createGenemon level ${n}`);
    }
  }
  // Across many genomes at the batch brackets.
  for (const { s } of plans.slice(0, 300)) for (const n of [10, 25, 50]) assertEquals(phenotypeOf(createGenemon({ seed: s, level: n })).level, n, `seed ${s} level ${n}`);
  const long = firstOf((q) => q.curve === "long");
  assert(levelCurve(long.p).xpForLevel(30) > levelCurve(firstOf((q) => q.curve === "short").p).xpForLevel(30), "long levels cost more xp");
});

Deno.test("[P6-E1, E3] phases are monotone in level and age; sizes grow (except the cocoon); the reference adult has sizeMult 1", () => {
  for (const { p } of plans.slice(0, 2000)) {
    p.phases.forEach((ph, i) => {
      assertEquals(ph.index, i + 1);
      if (i === 0) {
        assertEquals(ph.atLevel, 1);
        assertEquals(ph.atAgeDays, 0);
        return;
      }
      const prev = p.phases[i - 1];
      assert(ph.atLevel >= prev.atLevel, "levels non-decreasing");
      assert(ph.atAgeDays > prev.atAgeDays, "ages strictly increasing");
      if (p.kind !== "metamorphosis") assert(ph.sizeMult >= prev.sizeMult, `${p.kind} grows: ${prev.sizeMult} -> ${ph.sizeMult}`);
    });
    assertEquals(p.phases[phaseIndexAt(p, REF_LEVEL, REF_AGE_DAYS)].sizeMult, 1, "reference phase sizeMult 1");
    let last = 0;
    for (let lv = 1; lv <= 60; lv += 3) {
      let lastAge = -1;
      for (let d = 0; d <= 200; d += 7) {
        const k = phaseIndexAt(p, lv, d);
        assert(k >= lastAge, "monotone in age");
        lastAge = k;
      }
      const k = phaseIndexAt(p, lv, 400);
      assert(k >= last, "monotone in level");
      last = k;
    }
    assertEquals(phaseIndexAt(p, p.maxLevel, 1e6), p.phases.length - 1, "everything reached eventually");
  }
});

Deno.test("[P6-E3] unlocks are cumulative in the expressed state", () => {
  const { p } = firstOf((q) => q.kind === "gradual" && q.phases.length >= 4);
  let prevLen = 0;
  for (const ph of p.phases) {
    const st = phaseOf(p, ph.atLevel, ph.atAgeDays, condAt(p, ph.atLevel, ph.atAgeDays));
    assertEquals(st.phase, ph.index, "phase reached exactly at its thresholds");
    assertEquals(st.unlocks.join(","), p.phases.slice(0, ph.index).flatMap((q) => q.unlocks).join(","), "cumulative");
    assertEquals(st.unlocks.join(","), unlocksUpTo(p, ph.index).join(","));
    assert(st.unlocks.length >= prevLen, "never loses an unlock");
    prevLen = st.unlocks.length;
  }
  assert(prevLen >= p.phases.length - 1, "a gradual lineage unlocks something at every phase");
  const unlocking = plans.filter((x) => x.p.kind === "gradual").flatMap((x) => x.p.phases.flatMap((q) => q.unlocks));
  for (const u of ["neck+", "wings+", "wingPair+", "arms+", "fingers+", "horns+", "armor+", "tail+"]) assert(unlocking.includes(u as never), `${u} occurs`);
});

Deno.test("[P6-E4] metamorphosis = larva -> cocoon -> imago; the cocoon shrinks, cannot breed, and the imago needs age only", () => {
  const metas = plans.filter((x) => x.p.kind === "metamorphosis");
  assert(metas.length > 100, "enough metamorphosis lineages");
  for (const { p } of metas) {
    assertEquals(p.phases.slice(0, 3).map((q) => q.form).join(","), "larva,cocoon,imago");
    const [larva, cocoon, imago] = p.phases;
    assert(cocoon.sizeMult < larva.sizeMult && imago.sizeMult > larva.sizeMult, "shrinks in the cocoon, then grows");
    assert(!larva.fertile && !cocoon.fertile && imago.fertile, "only the imago breeds");
    assertEquals(imago.atLevel, cocoon.atLevel, "a cocoon cannot fight for xp: imago gated by age only");
    assert(fertileNow(p, 2, cocoon.atAgeDays + 0.1).why.includes("cocoon"), "cocoon reason");
  }
});

Deno.test("[P6-E4] molt lineages shed their armour (armorShed after armor+); static never changes form", () => {
  const molts = plans.filter((x) => x.p.kind === "molt");
  assert(molts.length > 100);
  for (const { p } of molts) {
    const all = p.phases.flatMap((q) => q.unlocks);
    assert(all.includes("armorShed"), "sheds");
    assert(all.indexOf("armor+") < all.indexOf("armorShed"), "had armour before shedding it");
  }
  const { p } = firstOf((q) => q.kind === "static");
  for (const [lv, d] of [[1, 0], [30, 60], [p.maxLevel, 500]]) {
    const st = phaseOf(p, lv, d, condAt(p, lv, d));
    assertEquals(st.phase, 1);
    assertEquals(st.sizeMult, 1);
    assertEquals(st.unlocks.length, 0);
    assertEquals(st.progress, 1);
  }
});

Deno.test("[P6-E5] fertility windows: only in fertile phases, after maturity, inside the cycle; reasons and next window", () => {
  for (const { p } of plans.slice(0, 400)) {
    const f = p.fertility;
    assert(f.fertileDays > 0 && f.fertileDays < f.cycleDays, "a window shorter than the cycle");
    let open = 0, total = 0;
    for (let d = 0; d <= 300; d += 0.25) {
      const k = phaseIndexAt(p, p.maxLevel, d);
      const r = fertileNow(p, k + 1, d);
      assert(r.why.length > 5, "a reason");
      if (r.fertile) {
        assert(p.phases[k].fertile, "fertile only in a fertile phase");
        assert(d >= f.offsetDays, "after maturity");
        assert(r.until !== null && r.until > d, "window closes later");
        assert(r.nextWindowDay !== null && r.nextWindowDay > d, "next window after this one");
      } else if (r.nextWindowDay !== null) {
        assert(r.nextWindowDay >= d - 1e-9, `next window ${r.nextWindowDay} not in the past (${d})`);
      }
      if (p.phases[k].fertile && d >= f.offsetDays) {
        total++;
        if (r.fertile) open++;
      }
    }
    if (total > 200) {
      const duty = open / total, want = f.fertileDays / f.cycleDays;
      assert(Math.abs(duty - want) < 0.06, `duty ${duty} vs ${want}`);
    }
    assertEquals(windowAtOrAfter(p, 0), f.offsetDays);
  }
});

function grown(s: number, level: number, ageDays: number): Genemon {
  return createGenemon({ seed: s, level, ageDays });
}

Deno.test("[P6-E5] canBreed refuses outside a window with a reason and accepts two fertile Genemon", () => {
  const juvenile = firstOf((q) => q.kind === "gradual" && !q.phases[0].fertile);
  const j = createGenemon({ seed: 1, genome: juvenile.g, level: 1, ageDays: 1 });
  const other = createGenemon({ seed: 2, genome: juvenile.g, level: 1, ageDays: 1 });
  const r = canBreed(j, other);
  assert(!r.ok && /too young/.test(r.why), r.why);
  assert(!canBreed(j, j).ok, "not with itself");
  // Two adults placed inside their windows.
  const fertileAt = (g: Genome): Genemon => {
    const p = evolutionPlanOf(g);
    for (let d = p.fertility.offsetDays; d < 400; d += 0.5) {
      const gm = createGenemon({ seed: 3, genome: g, level: p.maxLevel, ageDays: d });
      if (fertilityOf(gm).fertile) return gm;
    }
    throw new Error("never fertile");
  };
  const a = fertileAt(plans[1].g), b = fertileAt(plans[2].g);
  const ok = canBreed(a, b);
  assert(ok.ok, ok.why);
  const p = evolutionPlanOf(a.genome);
  // Same creature a little later, between windows.
  const between = createGenemon({ seed: 3, genome: a.genome, level: p.maxLevel, ageDays: a.conditions.ageDays + p.fertility.fertileDays + 0.01 });
  const no = canBreed(between, b);
  assert(!no.ok && /between fertility windows|fertile window/.test(no.why), no.why);
});

Deno.test("[P6-E1] determinism and legacy genomes: same plan for a cloned / JSON-roundtripped / morph-less genome; ids unchanged", () => {
  // Genome ids of pass 5 (frozen from the pass-5 tree): the plan must never re-hash a genome.
  assertEquals(wild(0).id, "gm-f6cf6af0");
  assertEquals(wild(1).id, "gm-6fb95323");
  assertEquals(wild(2).id, "gm-12e9ba81");
  for (const { g, p } of plans.slice(0, 300)) {
    const legacy = JSON.parse(JSON.stringify(g)) as Genome;
    delete legacy.morph;
    assertEquals(JSON.stringify(evolutionPlanOf(legacy)), JSON.stringify(p), "legacy save, same plan");
    assertEquals(legacy.id, g.id, "id unchanged");
    assertEquals(JSON.stringify(evolutionPlanOf(structuredClone(g))), JSON.stringify(p), "clone, same plan");
  }
  const a = createGenemon({ seed: 77, level: 20 }), b = createGenemon({ seed: 77, level: 20 });
  assertEquals(JSON.stringify(phenotypeOf(a).evo), JSON.stringify(phenotypeOf(b).evo));
});

Deno.test("[P6-E1..E4] express wires the plan: ph.evo, lineage level, height x sizeMult; stage = phase; cocoon cannot fight / rank", () => {
  for (const { s } of plans.slice(0, 200)) {
    const g = grown(s, 20, 36);
    const ph = phenotypeOf(g);
    assert(ph.evo, "ph.evo filled");
    assertEquals(ph.evo!.level, ph.level);
    assertEquals(stageOf(g, ph), ph.evo!.phase);
    assertEquals(g.stage, ph.evo!.phase);
    assertEquals(stageName(g, ph), ph.evo!.name);
  }
  // Height scales with the phase's sizeMult (same genome + conditions, a plan phase apart).
  const { g: gg, p } = firstOf((q) => q.kind === "gradual" && q.phases.length >= 3);
  const ph2 = p.phases[1], ph3 = p.phases[2];
  assert(ph3.atAgeDays - 0.01 > ph2.atAgeDays, "ages apart");
  const c2 = condAt(p, ph3.atLevel, ph3.atAgeDays - 0.01);
  const c3 = { ...c2, ageDays: ph3.atAgeDays };
  const e2 = express(gg, c2), e3 = express(gg, c3);
  assertEquals(e2.evo!.phase, 2);
  assertEquals(e3.evo!.phase, 3);
  const ratio = e3.heightM / e2.heightM;
  const growthRatio = (0.35 + 0.65 * e3.growth) / (0.35 + 0.65 * e2.growth);
  assert(Math.abs(ratio - growthRatio * ph3.sizeMult / ph2.sizeMult) < 1e-6, `height x sizeMult: ${ratio}`);
  // A cocoon cannot fight nor rank, and a molted shell trades defence for speed.
  const meta = firstOf((q) => q.kind === "metamorphosis");
  const cocoon = meta.p.phases[1];
  const cg = createGenemon({ seed: 5, genome: meta.g, level: cocoon.atLevel, ageDays: cocoon.atAgeDays + 0.5 });
  assertEquals(phenotypeOf(cg).evo!.form, "cocoon");
  assert(!canFight(cg).ok && canFight(cg).why.includes("cocoon"), canFight(cg).why);
  assert(!canRank(cg).ok && canRank(cg).why.includes("cocoon"), canRank(cg).why);
  assert(!fertilityOf(cg).fertile, "cocoon cannot breed");
  const free = createGenemon({ seed: 5, genome: meta.g, level: cocoon.atLevel, ageDays: meta.p.phases[2].atAgeDays + 0.5 });
  assert(canFight(free).ok, "the imago fights");
});

Deno.test("[P6-E1] a phase change writes ONE genemon.evolve row with the form and the unlocks", () => {
  const { g: genome, p } = firstOf((q) => q.kind === "gradual" && q.phases.length >= 3 && q.phases[1].unlocks.length > 0);
  const g = createGenemon({ seed: 9, genome, level: 1, ageDays: 0.5 });
  assertEquals(g.stage, 1);
  const ledger = new Ledger("evo-test");
  const target = p.phases[1];
  grantXp(g, levelCurve(p).xpForLevel(target.atLevel) - g.conditions.xp, { ledger, when: 1 });
  age(g, target.atAgeDays, { ledger, when: 2 });
  const rows = ledger.rows().filter((r) => r.what === "genemon.evolve");
  assert(rows.length >= 1, "evolve row");
  const r = rows.find((x) => x.exits.toStage === 2)!;
  assert(r, "row to phase 2");
  assertEquals(r.exits.form, target.form);
  assertEquals(r.exits.name, target.name);
  assertEquals(r.exits.unlocks, target.unlocks.join(","));
  assertEquals(r.exits.kind, "gradual");
  assertEquals(g.stage, phenotypeOf(g).evo!.phase);
});

Deno.test("[P6-E1..E5] lifeclock.evolutionPath is built from the plan: costs, unlock words, cocoon and molt properties", () => {
  const check = (pred: (p: EvolutionPlan) => boolean, words: RegExp) => {
    const { g: genome, p } = firstOf(pred);
    const g = createGenemon({ seed: 4, genome, level: 12, ageDays: 20 });
    const path = evolutionPath(g);
    assertEquals(path.length, p.phases.length);
    path.forEach((st, i) => {
      assertEquals(st.stage, i + 1);
      assert(st.cost.days >= 0 && st.cost.xp >= 0 && st.cost.food >= 0 && st.cost.credits === st.cost.food * 6, "costs");
      if (i > 0) assert(st.cost.days > 0 && st.cost.xp >= 0, "time between phases");
      assert(st.properties.length >= 1, "properties");
    });
    const reached = path.map((s) => s.reached);
    assert(reached[0] && !reached.slice(reached.indexOf(false) < 0 ? reached.length : reached.indexOf(false)).some(Boolean), "reached is a prefix");
    assertEquals(path.filter((s) => s.current).length, 1);
    assert(path.some((s) => s.properties.some((x) => words.test(x))), `property ${words}`);
  };
  check((p) => p.kind === "metamorphosis", /cocoon: cannot fight, cannot rank/);
  check((p) => p.kind === "molt", /sheds its shell: -defence, \+speed/);
  check((p) => p.kind === "static", /never changes form/);
  check((p) => p.kind === "gradual" && p.phases.some((q) => q.unlocks.includes("neck+")), /neck grows longer/);
  check((p) => p.kind === "gradual" && p.phases.some((q) => q.unlocks.includes("wingPair+")), /an extra pair of wings/);
});
