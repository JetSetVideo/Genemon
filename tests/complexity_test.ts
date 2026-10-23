// Pass 6 complexity spectrum [P6-C1, P6-C2]: tier shares over 30 000 wild genomes, the minimal globe, the
// mythic chimera's counts, the colossus measured XXL through express(), heritability / rare jumps / slow
// selection, determinism and legacy genomes (ids never move).
import { assert, assertEquals } from "./_assert.ts";
import { colossusBody, type Genome, genomeId, randomGenome } from "../src/genome/genome.ts";
import { breed, fuse, inheritCx } from "../src/genome/breeding.ts";
import { express } from "../src/genome/phenotype.ts";
import { emptyConditions, xpForLevel } from "../src/genome/epigenetics.ts";
import { describeHelix, helixOf } from "../src/genome/helix.ts";
import {
  COMPLEXITY_TIERS,
  complexityOf,
  complexityRaw,
  cxAllelesOf,
  deriveCx,
  isColossal,
  tierOdds,
  tierOfRaw,
  tierRank,
} from "../src/genome/complexity.ts";
import type { ComplexityTier } from "../src/genome/p6Types.ts";
import { hashSeed, Rng } from "../src/core/rng.ts";
import { AXIS_IDS } from "../src/data/axes.ts";
import { PLAN_GENES } from "../src/genome/genome.ts";

// Seeds far from the calibration range (1 .. 3 000 000).
const OFF = 20_000_000;
const N = 30_000;
const wild: Genome[] = Array.from({ length: N }, (_, i) => randomGenome(OFF + i));
const profiles = wild.map((g) => complexityOf(g));
const adult = () => {
  const c = emptyConditions();
  c.ageDays = 120;
  c.xp = xpForLevel(30);
  return c;
};
// Colossi and mythics from a wider scan (isColossal / complexityRaw are cheap: no morph genes).
const SCAN = 400_000;
const colossi: Genome[] = [];
const mythics: Genome[] = [];
for (let i = 0; i < SCAN; i++) {
  const g = randomGenome(OFF + N + i);
  if (isColossal(g)) colossi.push(g);
  if (mythics.length < 150 && complexityRaw(g) > 3.23 && complexityOf(g).tier === "mythic") mythics.push(g);
}

Deno.test("complexity [P6-C2]: tier shares over 30 000 wild genomes match tierOdds; the median sits in common", () => {
  const odds = tierOdds();
  assertEquals(COMPLEXITY_TIERS.join(), "minimal,simple,common,complex,elaborate,mythic");
  assert(Math.abs(Object.values(odds).reduce((s, v) => s + v, 0) - 1) < 1e-9, "odds sum to 1");
  const share = (t: ComplexityTier) => profiles.filter((p) => p.tier === t).length / N;
  const band: Record<ComplexityTier, [number, number]> = {
    minimal: [0.05, 0.08],
    simple: [0.19, 0.25],
    common: [0.38, 0.46],
    complex: [0.17, 0.23],
    elaborate: [0.08, 0.115],
    mythic: [6 / N, 45 / N], // expected 20 (1 in 1500)
  };
  for (const t of COMPLEXITY_TIERS) {
    const s = share(t);
    assert(s >= band[t][0] && s <= band[t][1], `${t} share ${s.toFixed(4)} outside ${band[t]}`);
    if (t !== "mythic") assert(Math.abs(s - odds[t]) / odds[t] < 0.12, `${t} ${s} vs odds ${odds[t]}`);
  }
  const below = share("minimal") + share("simple");
  assert(below < 0.5 && below + share("common") > 0.5, `median not in common (${below})`);
  assertEquals(profiles.find((p) => p.tier === "minimal")!.oneIn, Math.round(1 / odds.minimal));
  assertEquals(Math.round(1 / odds.mythic), 1500);
  for (const p of profiles) {
    assert(p.score >= 0 && p.score <= 1, `score ${p.score}`);
    assertEquals(p.colors, p.tier === "minimal" ? 2 : 3);
  }
  // Scores order the tiers.
  const meanScore = (t: ComplexityTier) => {
    const xs = profiles.filter((p) => p.tier === t);
    return xs.reduce((s, p) => s + p.score, 0) / xs.length;
  };
  for (let i = 1; i < COMPLEXITY_TIERS.length - 1; i++) {
    assert(meanScore(COMPLEXITY_TIERS[i]) > meanScore(COMPLEXITY_TIERS[i - 1]), `score order at ${COMPLEXITY_TIERS[i]}`);
  }
});

Deno.test("complexity [P6-C1]: a minimal genome is a GLOBE - blob, one eye, two colours, no parts; the helix says so", () => {
  const globes = wild.filter((_, i) => profiles[i].tier === "minimal").slice(0, 400);
  assert(globes.length >= 300, `globes ${globes.length}`);
  for (const g of globes) {
    const p = complexityOf(g);
    assertEquals(g.kind, "blob");
    assertEquals(JSON.stringify(p.counts), JSON.stringify({ eyes: 1, mouths: 1, heads: 1, wingPairs: 0, armPairs: 0, legPairs: 0, tentacles: 0, fingers: 0, tails: 0 }));
    const h = helixOf(g, express(g, emptyConditions()));
    assertEquals(h.eyes.count, 1);
    assertEquals(h.p5!.eyes.count, 1);
    assertEquals(h.p5!.eyes.layout, "cyclops");
    assertEquals(h.wings.kind, "none");
    assertEquals(h.digits, 0);
    assert(h.p5!.body.limbStyle !== "tentacles", "a globe has no tentacles");
    assertEquals(h.p6!.complexity.tier, "minimal");
    assert(describeHelix(h).some((l) => l.startsWith("Complexity: minimal globe")), "described as a globe");
  }
  // Only blobs are globes: no other kind is ever minimal.
  for (let i = 0; i < N; i++) if (wild[i].kind !== "blob") assert(profiles[i].tier !== "minimal", wild[i].kind);
});

Deno.test("complexity [P6-C1]: mythic chimeras carry 6-8 eyes, 2 mouths, >=2 wing and arm pairs, tentacles, many fingers", () => {
  assert(mythics.length >= 100, `mythic sample ${mythics.length}`);
  for (const g of mythics) {
    const c = complexityOf(g).counts;
    assert(c.eyes >= 6 && c.eyes <= 8, `eyes ${c.eyes}`);
    assertEquals(c.mouths, 2);
    assert(c.wingPairs >= 2 && c.armPairs >= 2, `wings ${c.wingPairs} arms ${c.armPairs}`);
    assert(c.tentacles >= 4 && c.fingers >= 5 && c.tails >= 1, JSON.stringify(c));
    const h = helixOf(g, express(g, emptyConditions()));
    assertEquals(h.eyes.count, c.eyes);
    assert(h.wings.kind !== "none", "a chimera has wings");
    assertEquals(h.p5!.body.limbStyle, "tentacles");
    assertEquals(h.digits, c.fingers);
  }
  assert(mythics.some((g) => complexityOf(g).counts.heads === 2), "some mythics have two heads");
  // Below mythic: one head, at most 2 wing / arm pairs, at most 5 fingers.
  for (const p of profiles) {
    if (p.tier === "mythic") continue;
    assertEquals(p.counts.heads, 1);
    assert(p.counts.wingPairs <= 2 && p.counts.armPairs <= 2 && p.counts.fingers <= 5, JSON.stringify(p.counts));
  }
});

Deno.test("complexity [P6-C2]: colossi are ~1 in 5000, all mythic, and come out XXL through express() when grown", () => {
  const rate = colossi.length / SCAN;
  assert(colossi.length >= 45 && colossi.length <= 130, `colossi ${colossi.length} / ${SCAN} (1 in ${(1 / rate).toFixed(0)})`);
  let xxl = 0;
  for (const g of colossi) {
    const p = complexityOf(g);
    assert(p.colossal && p.tier === "mythic" && g.kind !== "blob", "colossal => mythic, never a blob");
    assertEquals(p.oneIn, 5000);
    assert(p.counts.tentacles >= 6 && p.counts.wingPairs >= 2 && p.counts.armPairs >= 2 && p.counts.eyes >= 6, JSON.stringify(p.counts));
    if (express(g, adult()).sizeClass === "XXL") xxl++;
  }
  // From the genes alone a GROWN colossus is XXL; young ones need the phenotype line (colossi hatch near full
  // size), which the evolution lane owns - measured separately, not asserted here.
  assert(xxl / colossi.length >= 0.95, `grown colossi XXL ${xxl}/${colossi.length}`);
  // FALSIFIER (pass 6, orchestrator): XXL is RESERVED for colossi. The heaviest NON-colossal bodies (colossus body
  // genes forced onto ordinary genomes) are capped below the XXL threshold, so XXL can only come from complexity.
  let heavyXXL = 0, heavy = 0;
  for (let s = 1; heavy < 60; s++) {
    const g0 = randomGenome(s);
    if (isColossal(g0)) continue;
    const h = structuredClone(g0);
    colossusBody(h);
    heavy++;
    if (express(h, adult()).sizeClass === "XXL") heavyXXL++;
  }
  assertEquals(heavyXXL, 0, "a heavy non-colossus never fills 6 slots");
  // colossusBody only raises the body genes and is deterministic.
  const g0 = randomGenomeNoColossus(colossi[0].seeds.genotype);
  const a = structuredClone(g0), b = structuredClone(g0);
  colossusBody(a);
  colossusBody(b);
  assertEquals(JSON.stringify(a), JSON.stringify(b));
  assert(a.axes.stature[0] >= g0.axes.stature[0] && a.axes.stature[0] >= 0.95, "stature raised");
  assertEquals(genomeId(a), colossi[0].id, "randomGenome = pass-5 draws + colossusBody");
});

const clampN = (v: number) => Math.max(-1, Math.min(1, v));
const clamp01N = (v: number) => Math.max(0, Math.min(1, v));
/** The pass-5 genome of a seed (randomGenome's draws, colossus edit skipped): rebuilt from the same Rng stream. */
function randomGenomeNoColossus(seed: number): Genome {
  const g = randomGenome(seed);
  const rng = new Rng(hashSeed(seed, "genome"));
  const axes = structuredClone(g.axes), plan = structuredClone(g.plan);
  for (const id of AXIS_IDS) axes[id] = [clampN(rng.normal(0, 0.45)), clampN(rng.normal(0, 0.45))];
  for (const id of PLAN_GENES) plan[id] = [clamp01N(rng.normal(0.5, 0.22)), clamp01N(rng.normal(0.5, 0.22))];
  const out = { ...g, axes, plan };
  return { ...out, id: genomeId(out) };
}

Deno.test("complexity: the pre-bias rebuild really reproduces randomGenome's axis draws (the falsifier is valid)", () => {
  // For a NON-colossal seed the rebuild must equal randomGenome exactly (same Rng stream order).
  const g = randomGenome(4242);
  assert(!isColossal(g));
  const rng = new Rng(hashSeed(4242, "genome"));
  for (const id of AXIS_IDS) assertEquals(g.axes[id], [clampN(rng.normal(0, 0.45)), clampN(rng.normal(0, 0.45))], id);
  for (const id of PLAN_GENES) assertEquals(g.plan[id], [clamp01N(rng.normal(0.5, 0.22)), clamp01N(rng.normal(0.5, 0.22))], id);
});

Deno.test("complexity: counts agree with the body kind and the helix agrees with the counts", () => {
  for (let i = 0; i < 4000; i++) {
    const g = wild[i], p = profiles[i], c = p.counts;
    const mythic = p.tier === "mythic";
    assert(c.eyes >= 1 && c.eyes <= 8 && c.legPairs <= 4 && c.tentacles <= 12 && c.tails <= 3, JSON.stringify(c));
    if (!mythic) {
      if (g.kind === "avian") assert(c.wingPairs >= 1 && c.legPairs === (c.tentacles ? 0 : 1) && c.armPairs === 0, `avian ${JSON.stringify(c)}`);
      if (g.kind === "hexapod" && c.tentacles === 0) assertEquals(c.legPairs, 3);
      if (g.kind === "quadruped" && c.tentacles === 0) assert(c.legPairs === 2 && c.armPairs === 0, "quadruped");
      if (g.kind === "biped" && c.tentacles === 0) assert(c.legPairs === 1 && c.armPairs >= 1, "biped");
      if (g.kind === "serpent") assert(c.armPairs === 0 && c.legPairs <= 2 && c.fingers === 0, `serpent ${JSON.stringify(c)}`);
      if (g.kind === "blob") assert(c.armPairs === 0 && c.fingers === 0 && c.tails === 0, `blob ${JSON.stringify(c)}`);
    }
    const h = helixOf(g, express(g, emptyConditions()));
    assertEquals(h.p6!.version, 6);
    assertEquals(JSON.stringify(h.p6!.complexity), JSON.stringify(p));
    assertEquals(h.eyes.count, c.eyes, "eyes");
    assertEquals(h.wings.kind !== "none", c.wingPairs > 0, "wings presence");
    assertEquals(h.p5!.body.limbStyle === "tentacles", c.tentacles > 0, "tentacles");
    if (g.kind === "serpent") assertEquals(h.p5!.body.serpentLegs, c.legPairs, "serpent legs");
    else assertEquals(h.p5!.body.serpentLegs, 0);
    assertEquals(h.digits, c.fingers, "digits");
  }
  // Extra parts grow with the tier.
  const mean = (t: ComplexityTier, f: (c: typeof profiles[number]["counts"]) => number) => {
    const xs = profiles.filter((p) => p.tier === t);
    return xs.reduce((s, p) => s + f(p.counts), 0) / xs.length;
  };
  const parts = (c: typeof profiles[number]["counts"]) => c.wingPairs + c.armPairs + c.legPairs + c.tails + c.mouths + c.tentacles / 2;
  assert(mean("elaborate", parts) > mean("common", parts) && mean("common", parts) > mean("minimal", parts), "parts grow with the tier");
  assert(mean("elaborate", (c) => c.wingPairs) > mean("common", (c) => c.wingPairs), "elaborate bodies sprout wing pairs");
  assertEquals(tierRank("mythic"), 5);
});

Deno.test("complexity heritability [P6-C2]: mostly additive (child ~ mid-parent), rare jumps, Mendelian alleles", () => {
  const rng = new Rng(11);
  const pop = wild.slice(0, 3000);
  const raw = pop.map((g) => complexityRaw(g));
  const order = pop.map((_, i) => i).sort((a, b) => raw[a] - raw[b]);
  const low = order.slice(0, 300).map((i) => pop[i]), high = order.slice(-300).map((i) => pop[i]);
  const mean = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / xs.length;
  const popMean = mean(raw);
  const kids = (ps: Genome[]) => {
    const out: number[] = [];
    for (let i = 0; i + 1 < ps.length; i += 2) for (let k = 0; k < 3; k++) out.push(complexityRaw(breed(ps[i], ps[i + 1], rng.int(0, 1e9))));
    return out;
  };
  const hi = mean(kids(high)), lo = mean(kids(low));
  assert(hi > popMean + 0.8, `high parents -> child ${hi} vs population ${popMean}`);
  assert(lo < popMean - 0.5, `low parents -> child ${lo} vs population ${popMean}`);
  // Regression of child on mid-parent over random pairs: slope ~ 1 for an additive trait.
  const xs: number[] = [], ys: number[] = [];
  for (let i = 0; i + 1 < 1200; i += 2) {
    const a = pop[i], b = pop[i + 1];
    const c = breed({ ...a, kind: "quadruped" } as Genome, { ...b, kind: "quadruped" } as Genome, i);
    const cxMid = (g: Genome) => cxAllelesOf(g).reduce((s, p) => s + p[0] + p[1], 0);
    xs.push((cxMid(a) + cxMid(b)) / 2);
    ys.push(cxMid(c));
  }
  const mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0;
  for (let i = 0; i < xs.length; i++) [sxy, sxx] = [sxy + (xs[i] - mx) * (ys[i] - my), sxx + (xs[i] - mx) ** 2];
  const slope = sxy / sxx;
  assert(slope > 0.75 && slope < 1.25, `child-on-midparent slope ${slope}`);
  // Mendelian: with no mutation and no jump each child pair holds one allele of each parent.
  const a = pop[0], b = pop[1];
  const child = inheritCx(a, b, new Rng(3), 0, 0);
  const ca = cxAllelesOf(a), cb = cxAllelesOf(b);
  child.forEach((p, i) => assert((ca[i].includes(p[0]) && cb[i].includes(p[1])) || (ca[i].includes(p[1]) && cb[i].includes(p[0])), `pair ${i}`));
  // Rare jumps: ~2 % of births.
  let jumps = 0;
  for (let i = 0; i < 3000; i++) if (breed(pop[i % 1000], pop[(i * 7 + 1) % 1000], i).mutations.some((m) => m.startsWith("cx:jump"))) jumps++;
  assert(jumps / 3000 >= 0.01 && jumps / 3000 <= 0.035, `jump rate ${jumps / 3000}`);
  // Fusion is a chimera: every complexity allele at least as high as both parents' of the same rank.
  const f = fuse(a, b, 9);
  cxAllelesOf(f).forEach((p, i) => assert(Math.max(...p) >= Math.max(...ca[i]) && Math.max(...p) >= Math.max(...cb[i]), "fusion raises"));
});

Deno.test("complexity [P6-C2]: selection climbs the ladder SLOWLY", () => {
  const rng = new Rng(5);
  const tier = (g: Genome) => tierOfRaw(complexityRaw(g), g.kind);
  // (a) Hard truncation selection (best 40 of 160 every generation): steady but slow climb.
  let pop = wild.slice(5000, 5160);
  const meanRaw = (gs: Genome[]) => gs.reduce((s, g) => s + complexityRaw(g), 0) / gs.length;
  const trace = [meanRaw(pop)];
  const mythicShare: number[] = [0];
  for (let gen = 0; gen < 8; gen++) {
    const best = pop.slice().sort((x, y) => complexityRaw(y) - complexityRaw(x)).slice(0, 40);
    const next: Genome[] = [];
    while (next.length < 160) next.push(breed(rng.pick(best), rng.pick(best), rng.int(0, 1e9)));
    pop = next;
    trace.push(meanRaw(pop));
    mythicShare.push(pop.filter((g) => tier(g) === "mythic").length / pop.length);
  }
  const t = trace.map((v) => v.toFixed(2)).join(" -> ");
  assert(trace[8] > trace[0] + 1.5, `selection climbs: ${t}`);
  for (let i = 1; i < trace.length; i++) assert(trace[i] - trace[i - 1] < 1.0, `one generation jumped: ${t}`);
  assert(trace[4] < 2.6 && mythicShare[4] < 0.15, `too fast after 4 generations: ${t}, mythic ${mythicShare[4]}`);
  // (b) A player's breeding line: 6 eggs per generation, the best two breed on. Generations to a first mythic.
  const gens: number[] = [];
  for (let trial = 0; trial < 30; trial++) {
    let a = wild[6000 + 2 * trial], b = wild[6001 + 2 * trial];
    let g = 1;
    for (; g <= 40; g++) {
      const kids = Array.from({ length: 6 }, () => breed(a, b, rng.int(0, 1e9))).sort((x, y) => complexityRaw(y) - complexityRaw(x));
      if (kids.some((k) => tier(k) === "mythic")) break;
      [a, b] = [kids[0], kids[1]];
    }
    gens.push(g);
  }
  gens.sort((x, y) => x - y);
  assert(gens[15] >= 5, `median generations to a first mythic ${gens[15]} (${gens.join(",")})`);
  assert(gens[15] <= 40, `breeding can climb at all: median ${gens[15]}`);
});

Deno.test("complexity: deterministic; legacy genomes keep their ids and get one stable profile", () => {
  for (const s of [1, 7, 42, 999, 123456]) {
    assertEquals(JSON.stringify(complexityOf(randomGenome(s))), JSON.stringify(complexityOf(randomGenome(s))));
  }
  // Pass-5 ids pinned (git HEAD before pass 6): non-colossal wild genomes and pass-5 children are unchanged.
  assertEquals([1, 7, 42, 999, 123456].map((s) => randomGenome(s).id).join(), "gm-6fb95323,gm-5c4f73b0,gm-6c4ac13b,gm-9583f630,gm-580eaf5f");
  assertEquals(breed(randomGenome(1), randomGenome(2), 5).id, "gm-4867cb59");
  // A legacy genome (no cxGenes, e.g. a saved child): its id stays, its profile is stable across reloads.
  const child = breed(randomGenome(3), randomGenome(4), 77);
  const legacy = JSON.parse(JSON.stringify(child)) as Genome;
  delete legacy.cxGenes;
  assertEquals(genomeId(legacy), child.id, "cxGenes are never hashed into the id");
  assertEquals(legacy.id, child.id);
  assertEquals(JSON.stringify(cxAllelesOf(legacy)), JSON.stringify(deriveCx(legacy)));
  const p1 = complexityOf(legacy), p2 = complexityOf(JSON.parse(JSON.stringify(legacy)));
  assertEquals(JSON.stringify(p1), JSON.stringify(p2));
  // Editing the complexity genes changes the profile but not the id.
  const edited = { ...child, cxGenes: child.cxGenes!.map(() => [0.99, 0.99]) } as Genome;
  assertEquals(genomeId(edited), child.id);
  assert(complexityRaw(edited) > complexityRaw(child), "higher alleles -> higher complexity");
  // Invalid stored alleles fall back to the derivation.
  const bad = { ...child, cxGenes: [[2, -1]] } as unknown as Genome;
  assertEquals(JSON.stringify(cxAllelesOf(bad)), JSON.stringify(deriveCx(bad)));
});
