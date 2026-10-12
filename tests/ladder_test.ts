import { assert, assertAlmostEquals, assertEquals, assertThrows } from "./_assert.ts";
import { isValidEvent, Ledger } from "../src/core/ledger.ts";
import { r3, sigmoid } from "../src/core/math.ts";
import { Rng } from "../src/core/rng.ts";
import {
  Ladder,
  type LadderJSON,
  makeContext,
  type MatchContext,
  matchDataset,
  type MatchResult,
  RATING_COLUMN,
  WIN_CONDITION_K,
} from "../src/ladder/mmr.ts";
import { predictOutcomeModel } from "../src/ml/mlp.ts";
import { std, wilson } from "../src/ml/stats.ts";

const NO_CONTEXT: MatchContext = { names: [], features: [] };

function match(a: string, b: string, scoreA: 0 | 0.5 | 1, extra: Partial<MatchResult> = {}): MatchResult {
  return {
    a,
    b,
    scoreA,
    context: NO_CONTEXT,
    arena: "plains",
    weather: "clear",
    when: 0,
    combosA: [],
    combosB: [],
    ...extra,
  };
}

function veteran(rating: number) {
  return { rating, games: 30, wins: 15, losses: 15, draws: 0 };
}

/** A ladder state with chosen players/weights (starting from a real toJSON so every field exists). */
function seeded(players: LadderJSON["players"], weights: Record<string, number> = {}): Ladder {
  const j = new Ladder().toJSON();
  j.players = players;
  j.weights = weights;
  return Ladder.fromJSON(j);
}

const PLAYERS = ["p0", "p1", "p2", "p3", "p4", "p5"];

/** Equal-skill players; feature f0 decides the winner (plus a little noise); "noise" carries no signal. */
function conditionSeason(seed: number, n: number, ladder = new Ladder()): Ladder {
  const rng = new Rng(seed);
  for (let i = 0; i < n; i++) {
    const a = rng.pick(PLAYERS);
    let b = rng.pick(PLAYERS);
    while (b === a) b = rng.pick(PLAYERS);
    const f0 = rng.range(-1, 1), noise = rng.range(-1, 1);
    const scoreA = f0 + 0.15 * rng.normal() > 0 ? 1 : 0;
    ladder.record({
      a,
      b,
      scoreA,
      context: { names: ["f0", "noise"], features: [f0, noise] },
      arena: rng.pick(["plains", "volcano", "lagoon"]),
      weather: rng.pick(["clear", "rain"]),
      when: i * 1000,
      combosA: [rng.pick(["fire+air", "water+ice", "earth+metal"])],
      combosB: [rng.pick(["fire+air", "water+ice", "earth+metal"])],
    });
  }
  return ladder;
}

Deno.test("ladder: Elo update is zero-sum, K*(S-E), and conserves the rating pool", () => {
  const lad = new Ladder();
  const r = lad.record(match("ann", "bob", 1));
  assertAlmostEquals(r.expected, 0.5, 1e-12);
  assertAlmostEquals(r.k, 48, 1e-12, "both provisional: K = 24 * 2");
  assertAlmostEquals(r.deltaA, 24, 1e-9);
  assertAlmostEquals(r.deltaA + r.deltaB, 0, 1e-12);
  assertAlmostEquals(lad.rating("ann") + lad.rating("bob"), 3000, 1e-9);

  const rng = new Rng(1);
  const ids = ["a", "b", "c", "d", "e", "f", "g"];
  for (let i = 0; i < 400; i++) {
    const a = rng.pick(ids);
    let b = rng.pick(ids);
    while (b === a) b = rng.pick(ids);
    const out = lad.record(match(a, b, rng.pick([0, 0.5, 1] as const), {
      context: makeContext({ typeAdvantage: rng.range(-1, 1), powerDiff: rng.range(-1, 1) }),
      winCondition: rng.pick(["ko", "timeout", "sweep"]),
      combosA: [rng.pick(["x", "y"])],
      combosB: [rng.pick(["x", "y"])],
    }));
    assertAlmostEquals(out.deltaA + out.deltaB, 0, 1e-12, `match ${i} not zero-sum`);
  }
  const table = lad.table();
  const mean = table.reduce((s, row) => s + row.rating, 0) / table.length;
  assertAlmostEquals(mean, 1500, 1e-6, "the pool's mean rating must stay at base");
  for (let i = 1; i < table.length; i++) {
    assert(table[i - 1].rating >= table[i].rating, "table sorted by rating");
  }
});

Deno.test("ladder: swapping sides mirrors every update (symmetry)", () => {
  const l1 = new Ladder(), l2 = new Ladder();
  const rng = new Rng(2);
  for (let i = 0; i < 60; i++) {
    const [x, y] = rng.shuffle(["xa", "yb", "zc"]).slice(0, 2);
    const S = rng.pick([0, 0.5, 1] as const);
    const ctx = makeContext({ typeAdvantage: rng.range(-1, 1), arenaAffinity: rng.range(-1, 1) });
    const neg = { names: ctx.names, features: ctx.features.map((v) => -v) };
    const cx = [rng.pick(["c1", "c2", "c3"])], cy = [rng.pick(["c1", "c2", "c3"])];
    const arena = rng.pick(["volcano", "lagoon"]), weather = rng.pick(["rain", "fog"]);
    const o1 = l1.record({
      a: x,
      b: y,
      scoreA: S,
      context: ctx,
      arena,
      weather,
      when: i,
      combosA: cx,
      combosB: cy,
    });
    const o2 = l2.record({
      a: y,
      b: x,
      scoreA: (1 - S) as 0 | 0.5 | 1,
      context: neg,
      arena,
      weather,
      when: i,
      combosA: cy,
      combosB: cx,
    });
    assertAlmostEquals(o1.expected, 1 - o2.expected, 1e-12, `match ${i}: E must mirror`);
    assertAlmostEquals(o1.deltaA, o2.deltaB, 1e-12, `match ${i}: deltas must mirror`);
  }
  for (const id of ["xa", "yb", "zc"]) assertAlmostEquals(l1.rating(id), l2.rating(id), 1e-9, id);
  const w1 = l1.weights(), w2 = l2.weights();
  assertEquals(Object.keys(w1), Object.keys(w2));
  for (const key of Object.keys(w1)) assertAlmostEquals(w1[key], w2[key], 1e-12, key);
  // Per-player tables mirror too (counts exactly; expected scores up to float rounding).
  const s1 = l1.conditionStats("xa"), s2 = l2.conditionStats("xa");
  for (const dim of ["byArena", "byWeather", "byCombo", "byWinCondition"] as const) {
    assertEquals(
      s1[dim].map((e) => [e.key, e.wins, e.losses, e.draws]),
      s2[dim].map((e) => [e.key, e.wins, e.losses, e.draws]),
      dim,
    );
    s1[dim].forEach((e, i) => assertAlmostEquals(e.expected, s2[dim][i].expected, 1e-12, `${dim} ${e.key}`));
  }
});

Deno.test("ladder: equal ratings + zero context give exactly 0.5; a 400-point gap gives 10:1", () => {
  const lad = new Ladder();
  assertEquals(lad.expected("a", "b", makeContext({ typeAdvantage: 0, arenaAffinity: 0 })), 0.5);
  assertEquals(lad.expected("a", "b", NO_CONTEXT), 0.5);
  const l2 = seeded({ hi: veteran(1900), lo: veteran(1500) });
  assertAlmostEquals(l2.expected("hi", "lo", NO_CONTEXT), 10 / 11, 1e-12);
  assertAlmostEquals(l2.expected("lo", "hi", NO_CONTEXT), 1 / 11, 1e-12);
  // Unknown players sit at base.
  assertEquals(lad.rating("ghost"), 1500);
  assertEquals(lad.games("ghost"), 0);
});

Deno.test("ladder: learns that a decisive condition matters; a win against the conditions pays more", () => {
  const lad = conditionSeason(7, 400);
  const w = lad.weights();
  assert(w.f0 > 0.5, `weight of the deciding feature should be clearly positive, got ${w.f0}`);
  assert(Math.abs(w.noise) < 0.3 * w.f0, `noise weight ${w.noise} should stay small vs f0 ${w.f0}`);
  assert(
    lad.explain("p0", "p1", { names: ["f0"], features: [0.8] }, { arena: "plains", weather: "clear" })
      .expected > 0.6,
  );

  const state = lad.toJSON();
  const unfavoured = Ladder.fromJSON(state).record(
    match("p0", "p1", 1, { context: { names: ["f0", "noise"], features: [-0.8, 0] } }),
  );
  const favoured = Ladder.fromJSON(state).record(
    match("p0", "p1", 1, { context: { names: ["f0", "noise"], features: [0.8, 0] } }),
  );
  assert(
    unfavoured.expected < 0.5 && favoured.expected > 0.5,
    `E ${unfavoured.expected} / ${favoured.expected}`,
  );
  assert(
    unfavoured.deltaA > 2 * favoured.deltaA,
    `underdog-in-conditions win +${unfavoured.deltaA.toFixed(2)} should beat favoured win +${
      favoured.deltaA.toFixed(2)
    }`,
  );
  // And losing a match the conditions handed you costs more than losing against them.
  const lostFav = Ladder.fromJSON(state).record(
    match("p0", "p1", 0, { context: { names: ["f0", "noise"], features: [0.8, 0] } }),
  );
  const lostUnfav = Ladder.fromJSON(state).record(
    match("p0", "p1", 0, { context: { names: ["f0", "noise"], features: [-0.8, 0] } }),
  );
  assert(lostFav.deltaA < lostUnfav.deltaA, "a favoured loss must cost more");
});

Deno.test("ladder: worked example from docs/AI-AND-DATA.md", () => {
  const players = { A: veteran(1600), B: veteran(1500) };
  const weights = { typeAdvantage: 1.2, arenaAffinity: 0.6 };
  const against = makeContext({ typeAdvantage: -0.5, arenaAffinity: -0.3 });
  const withIt = makeContext({ typeAdvantage: 0.5, arenaAffinity: 0.3 });
  const ex = seeded(players, weights).explain("A", "B", against);
  assertAlmostEquals(ex.ratingLogit, 0.575646, 1e-6);
  assertAlmostEquals(ex.contextLogit, -0.78, 1e-12);
  assertAlmostEquals(ex.ratingOnly, 0.640065, 1e-6);
  assertAlmostEquals(ex.expected, 0.449089, 1e-6);
  assertAlmostEquals(
    seeded(players, weights).record(match("A", "B", 1, { context: against })).deltaA,
    13.2219,
    1e-4,
  );
  assertAlmostEquals(
    seeded(players, weights).record(match("A", "B", 1, { context: withIt })).deltaA,
    4.9188,
    1e-4,
  );
  assertAlmostEquals(seeded(players).record(match("A", "B", 1, { context: against })).deltaA, 8.6384, 1e-4);
});

Deno.test("ladder: provisional K doubles for 10 games, a match uses the mean K, win conditions scale it", () => {
  const lad = seeded({
    v1: veteran(1500),
    v2: veteran(1500),
    n1: { rating: 1500, games: 0, wins: 0, losses: 0, draws: 0 },
  });
  const s = lad.toJSON();
  assertAlmostEquals(Ladder.fromJSON(s).record(match("v1", "v2", 1)).k, 24, 1e-12, "veterans");
  assertAlmostEquals(Ladder.fromJSON(s).record(match("v1", "n1", 1)).k, 36, 1e-12, "veteran vs newcomer");
  assertAlmostEquals(Ladder.fromJSON(s).record(match("n1", "fresh", 1)).k, 48, 1e-12, "two newcomers");
  const timeout = Ladder.fromJSON(s).record(match("v1", "v2", 1, { winCondition: "timeout" }));
  assertAlmostEquals(timeout.k, 24 * WIN_CONDITION_K.timeout, 1e-12);
  assertAlmostEquals(timeout.deltaA, timeout.k * (1 - timeout.expected), 1e-12);
  assertAlmostEquals(
    Ladder.fromJSON(s).record(match("v1", "v2", 1, { winCondition: "mystery" })).k,
    24,
    1e-12,
  );

  const fresh = new Ladder();
  for (let i = 0; i < 10; i++) fresh.record(match("x", `opp${i}`, 1));
  assertEquals(fresh.games("x"), 10);
  assert(fresh.table().find((r) => r.id === "x")!.provisional === false);
  assertAlmostEquals(
    fresh.record(match("x", "opp0", 1)).k,
    36,
    1e-12,
    "x is established, opp0 still provisional",
  );
});

Deno.test("ladder: conditionStats excludes draws from the win-rate denominator", () => {
  const lad = new Ladder();
  const seq: (0 | 0.5 | 1)[] = [1, 1, 1, 0, 0.5, 0.5];
  for (const s of seq) {
    lad.record(
      match("alice", "bob", s, {
        arena: "volcano",
        weather: "heatwave",
        combosA: ["fire+air"],
        combosB: ["water+ice"],
      }),
    );
  }
  lad.record(match("alice", "bob", 0.5, { arena: "lagoon", combosA: ["fire+air"], combosB: ["water+ice"] }));
  lad.record(match("alice", "bob", 0.5, { arena: "lagoon", combosA: ["fire+air"], combosB: ["water+ice"] }));

  const mine = lad.conditionStats("alice");
  assertEquals(mine.perspective, "alice");
  const volcano = mine.byArena.find((e) => e.key === "volcano")!;
  assertEquals([volcano.games, volcano.wins, volcano.losses, volcano.draws], [6, 3, 1, 2]);
  assertAlmostEquals(volcano.winRate, 0.75, 1e-12, "3 wins / 4 decisive, draws excluded");
  const ci = wilson(3, 4);
  assertAlmostEquals(volcano.lo, ci.lo, 1e-12);
  assertAlmostEquals(volcano.hi, ci.hi, 1e-12);
  assertAlmostEquals(volcano.score, 4 / 6, 1e-12, "score keeps draws as half points");
  const lagoon = mine.byArena.find((e) => e.key === "lagoon")!;
  assertEquals([lagoon.games, lagoon.winRate, lagoon.lo, lagoon.hi], [2, 0, 0, 1]);
  assertAlmostEquals(mine.byWeather.find((e) => e.key === "heatwave")!.winRate, 0.75, 1e-12);

  const bobs = lad.conditionStats("bob").byArena.find((e) => e.key === "volcano")!;
  assertAlmostEquals(bobs.winRate, 0.25, 1e-12);

  const global = lad.conditionStats();
  assertEquals(global.perspective, "favourite");
  const fire = global.byCombo.find((e) => e.key === "fire+air")!;
  assertEquals([fire.games, fire.wins, fire.losses, fire.draws], [8, 3, 1, 4]);
  assertAlmostEquals(fire.winRate, 0.75, 1e-12);
  assertAlmostEquals(global.byCombo.find((e) => e.key === "water+ice")!.winRate, 0.25, 1e-12);
  assertEquals(global.byArena.map((e) => [e.key, e.games]), [["volcano", 6], ["lagoon", 2]]);
  assertEquals(global.byWinCondition.find((e) => e.key === "draw")!.games, 4);
  assertEquals(lad.conditionStats("nobody").byArena, []);
});

Deno.test("ladder: best and worst combos rank by Wilson bounds", () => {
  const lad = new Ladder();
  const play = (combo: string, wins: number, games: number) => {
    for (let i = 0; i < games; i++) {
      lad.record(match("p", "q", i < wins ? 1 : 0, { combosA: [combo], combosB: ["mirror"] }));
    }
  };
  play("rainCall>thunderBeam", 8, 10);
  play("tackle>tackle", 2, 10);
  play("lucky", 1, 1);
  assertEquals(lad.bestCombos(1).map((e) => e.key), ["rainCall>thunderBeam"]);
  assertEquals(lad.worstCombos(1).map((e) => e.key), ["tackle>tackle"]);
  assert(!lad.bestCombos(10, 5).some((e) => e.key === "lucky"), "minGames filters thin evidence");
  assertEquals(lad.bestCombos(10).length, 4);
  // The derived comboEdge feature now prefers the proven combo.
  const ex = lad.explain("p", "q", NO_CONTEXT, {
    combosA: ["rainCall>thunderBeam"],
    combosB: ["tackle>tackle"],
  });
  const edge = ex.contributions.find((c) => c.name === "comboEdge")!;
  assert(edge.value > 0, `comboEdge should favour the proven combo, got ${edge.value}`);
});

Deno.test("ladder: toJSON/fromJSON round trip preserves state and future updates", () => {
  const lad = conditionSeason(11, 80);
  const copy = Ladder.fromJSON(JSON.parse(JSON.stringify(lad)));
  assertEquals(copy.table(), lad.table());
  assertEquals(copy.weights(), lad.weights());
  assertEquals(copy.conditionStats(), lad.conditionStats());
  assertEquals(copy.conditionStats("p2"), lad.conditionStats("p2"));
  assertEquals(copy.matches, 80);
  const next = match("p0", "p3", 1, {
    context: makeContext({ f0: -0.4, noise: 0.2 }),
    arena: "volcano",
    combosA: ["fire+air"],
  });
  assertEquals(copy.record(next), lad.record(next));
  assertEquals(copy.toJSON(), lad.toJSON());
});

Deno.test("ladder: one flat ladder.match ledger row per record; matchDataset feeds the outcome model", () => {
  const ledger = new Ledger("ladder-test");
  const lad = new Ladder({ ledger });
  const out = lad.record(match("ann", "bob", 1, {
    context: makeContext({ typeAdvantage: 0.25, weatherAffinity: -0.5 }),
    arena: "volcano",
    weather: "ashfall",
    when: 123456,
    winCondition: "ko",
    combosA: ["fire+earth"],
  }));
  assertEquals(ledger.size, 1);
  const row = ledger.rows()[0];
  assert(isValidEvent(row), "row must satisfy the ledger schema (flat entries/exits)");
  assertEquals([row.what, row.who, row.from, row.to, row.when], [
    "ladder.match",
    "ann",
    "ann",
    "bob",
    123456,
  ]);
  assertEquals([row.where.space, row.where.zone], ["arena", "volcano"]);
  assertEquals(row.entries["x.typeAdvantage"], 0.25);
  assertEquals(row.entries["x.weatherAffinity"], -0.5);
  assertEquals(row.entries.combosA, "fire+earth");
  assertEquals(row.exits.deltaA, r3(out.deltaA));

  const season = conditionSeason(5, 300, new Ladder({ ledger }));
  assertEquals(ledger.size, 1 + season.matches);
  const ds = matchDataset(ledger.rows());
  assertEquals(ds.names[0], RATING_COLUMN);
  assertEquals(ds.rows.length, ledger.size);
  const f0 = ds.names.indexOf("f0");
  assert(f0 > 0, `f0 column expected in ${ds.names.join(",")}`);
  const model = predictOutcomeModel(ds.rows, new Rng(3), { epochs: 150 });
  const probe = (v: number) => model.forward(ds.names.map((n) => (n === "f0" ? v : 0)))[0];
  assert(
    probe(0.8) > 0.7 && probe(-0.8) < 0.3,
    `model P(win|f0=+.8)=${probe(0.8)} P(win|f0=-.8)=${probe(-0.8)}`,
  );
});

Deno.test("ladder: rejects self-play, invalid scores and malformed contexts; neutralises non-finite features", () => {
  const lad = new Ladder();
  assertThrows(() => lad.record(match("a", "a", 1)), "self-play");
  assertThrows(() => lad.record(match("a", "b", 0.3 as 0)), "score 0.3");
  assertThrows(() => lad.expected("a", "b", { names: ["x"], features: [] }), "length mismatch");
  assertThrows(() => lad.expected("a", "b", { names: ["x", "x"], features: [1, 2] }), "duplicate names");
  assertThrows(() => lad.expected("a", "b", { names: ["x|arena:y"], features: [1] }), "reserved separator");
  assertEquals(lad.expected("a", "b", { names: ["f"], features: [NaN] }), 0.5);
  const out = lad.record(match("a", "b", 1, { context: { names: ["f"], features: [Infinity] } }));
  assert(Number.isFinite(out.deltaA) && Number.isFinite(lad.rating("a")), "ratings stay finite");
  assert(Object.values(lad.weights()).every(Number.isFinite), "weights stay finite");
  assertEquals(lad.matches, 1, "rejected records must not count");
});

Deno.test("ladder: arena/weather interactions learn WHERE a condition matters", () => {
  // f0 decides the match in a storm and is irrelevant in clear weather.
  const season = (interactions: boolean) => {
    const lad = new Ladder({ interactions });
    const rng = new Rng(1);
    for (let i = 0; i < 3000; i++) {
      const a = rng.pick(PLAYERS);
      let b = rng.pick(PLAYERS);
      while (b === a) b = rng.pick(PLAYERS);
      const weather = i % 2 === 0 ? "storm" : "clear";
      const f0 = rng.range(-1, 1);
      const scoreA = weather === "storm" ? (f0 + 0.15 * rng.normal() > 0 ? 1 : 0) : (rng.chance(0.5) ? 1 : 0);
      lad.record(
        match(a, b, scoreA, {
          context: { names: ["f0"], features: [f0] },
          weather,
          arena: rng.pick(["plains", "volcano", "lagoon"]),
        }),
      );
    }
    const eff = (weather: string) =>
      lad.explain("p0", "p1", { names: ["f0"], features: [1] }, { arena: "plains", weather }).contributions[0]
        .weight;
    return { storm: eff("storm"), clear: eff("clear"), weights: lad.weights() };
  };
  const on = season(true);
  assert(on.storm > 2, `effective storm weight ${on.storm}`);
  assert(on.clear < 0.25 * on.storm, `clear ${on.clear} should be far below storm ${on.storm}`);
  assert(on.weights["f0|weather:clear"] < 0, "the clear-weather offset must pull the shared weight down");
  const off = season(false);
  assertEquals(off.storm, off.clear, "without interactions one weight serves every weather");
});

Deno.test("ladder: when conditions dominate, condition-aware ratings track true skill better than classic Elo", () => {
  // 10 players with spread true skill; the outcome logit = skill gap + 4 * condition (strong).
  const ids = Array.from({ length: 10 }, (_, i) => `p${i}`);
  const skill = (id: string) => (Number(id.slice(1)) - 4.5) * 0.25;
  const truth = ids.map((id) => (skill(id) * 400) / Math.LN10);
  let rmseAware = 0, rmseElo = 0, sdElo = 0;
  for (const seed of [1, 2, 3]) {
    const aware = new Ladder();
    const elo = new Ladder({ lr: 0, interactions: false, comboFeature: false });
    const rng = new Rng(seed);
    for (let i = 0; i < 3000; i++) {
      const a = rng.pick(ids);
      let b = rng.pick(ids);
      while (b === a) b = rng.pick(ids);
      const f0 = rng.range(-1, 1);
      const scoreA = rng.next() < sigmoid(skill(a) - skill(b) + 4 * f0) ? 1 : 0;
      const r = match(a, b, scoreA, { context: { names: ["f0"], features: [f0] }, when: i });
      aware.record(r);
      elo.record(r);
    }
    const rmse = (l: Ladder) =>
      Math.sqrt(ids.reduce((s, id, i) => s + (l.rating(id) - 1500 - truth[i]) ** 2, 0) / ids.length);
    rmseAware += rmse(aware) / 3;
    rmseElo += rmse(elo) / 3;
    sdElo += std(ids.map((id) => elo.rating(id))) / 3;
  }
  assert(
    rmseAware < 0.8 * rmseElo,
    `aware RMSE ${rmseAware.toFixed(1)} vs classic Elo ${rmseElo.toFixed(1)}`,
  );
  assert(
    sdElo < std(truth),
    `classic Elo compresses the skill spread: sd ${sdElo.toFixed(1)} vs true ${std(truth).toFixed(1)}`,
  );
});
