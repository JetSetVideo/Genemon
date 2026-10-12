import { assert, assertAlmostEquals, assertEquals } from "./_assert.ts";
import { Battle, type BattleResult } from "../src/combat/battle.ts";
import { autoTeam, synergies, type Team } from "../src/combat/team.ts";
import { Ledger } from "../src/core/ledger.ts";
import { sigmoid } from "../src/core/math.ts";
import { hashSeed, Rng } from "../src/core/rng.ts";
import { ELEMENT_IDS, type ElementId } from "../src/data/elements.ts";
import { WEATHER_IDS } from "../src/data/weather.ts";
import { createGenemon, phenotypeOf } from "../src/genome/genemon.ts";
import {
  MATCH_FEATURES,
  matchContext,
  matchResultFrom,
  RHYTHM_FEATURE,
  teamCombos,
  winConditionOf,
} from "../src/ladder/context.ts";
import { COMBO_FEATURE, CONTEXT_FEATURES, Ladder } from "../src/ladder/mmr.ts";
import {
  getLadder,
  LADDER_KEY,
  LAST_MATCH_KEY,
  loadLadder,
  loadLastMatch,
  recordBattle,
  recordMatch,
  resetLadder,
  saveLadder,
  type StorageLike,
  TOP_CONTRIBUTIONS,
} from "../src/ui/ladderStore.ts";
import { ARENA_KINDS, type ArenaSpec } from "../src/world/arena.ts";

class FakeStorage implements StorageLike {
  readonly data = new Map<string, string>();
  getItem(k: string): string | null {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.data.set(k, String(v));
  }
  removeItem(k: string): void {
    this.data.delete(k);
  }
}

const PREFS = ["big", "swarm", "balanced"] as const;

function randomTeam(seed: number, owner: string): Team {
  const pool = Array.from({ length: 7 }, (_, i) =>
    createGenemon({ seed: hashSeed(seed, owner, i), owner, level: 5 + ((seed * 7 + i * 3) % 40) }));
  return autoTeam(pool, owner, seed, PREFS[seed % PREFS.length]);
}

/** n random (team, team, arena) triples: mixed sizes, levels, arenas, weathers and hours. */
function pairs(n: number, seed: number): { A: Team; B: Team; arena: ArenaSpec }[] {
  const rng = new Rng(seed);
  return Array.from({ length: n }, (_, i) => ({
    A: randomTeam(seed * 1000 + i, "alice"),
    B: randomTeam(seed * 1000 + i + 500, "bob"),
    arena: { seed: seed * 100 + i, kind: rng.pick(ARENA_KINDS), weather: rng.pick(WEATHER_IDS), hour: rng.range(0, 24) },
  }));
}

/** The same Genemon fielded by another owner under fresh ids (the app's mirror opponent). */
function mirrorOf(t: Team, owner = "mirror"): Team {
  return { id: `team-${owner}`, owner, name: owner, members: t.members.map((g) => ({ ...structuredClone(g), id: `${g.id}-m` })) };
}

function fakeResult(winner: 0 | 1 | 2, reason: "ko" | "timeout", alive: [boolean[], boolean[]] = [[true], [false]]): BattleResult {
  const fighters = alive.flatMap((side, team) =>
    side.map((a, i) => ({
      id: `f${team}${i}`,
      name: `f${team}${i}`,
      team: team as 0 | 1,
      alive: a,
      hpFrac: a ? 0.5 : 0,
      tally: { dealt: 0, taken: 0, kos: 0, hits: 0, misses: 0, crits: 0, reactions: 0, casts: 0 },
    }))
  );
  return {
    winner,
    reason,
    duration: 30,
    hpFrac: [0.5, 0.5],
    mvp: "",
    arena: "meadow",
    weatherStart: "clear",
    weatherEnd: "clear",
    hour: 13,
    reactions: {},
    fighters,
    knowledge: {},
    elementsUsed: {},
    damageTakenBy: {},
    moveUses: {},
    synergies: [[], []],
  };
}

/** A ladder that has already learned that every condition matters (weight `w` each), fresh players. */
function learnedLadder(w: number): Ladder {
  const j = new Ladder().toJSON();
  j.weights = Object.fromEntries(MATCH_FEATURES.map((n) => [n, w]));
  return Ladder.fromJSON(j);
}

Deno.test("ladder context: every caller feature present, finite, within [-1.5, 1.5] over 50 random pairs, and each varies", () => {
  const callerFeatures = CONTEXT_FEATURES.map((f) => f.name).filter((n) => n !== COMBO_FEATURE);
  const nonZero = new Map<string, number>();
  for (const { A, B, arena } of pairs(50, 1)) {
    const ctx = matchContext(A, B, arena);
    assertEquals(ctx.names.length, ctx.features.length);
    assertEquals(new Set(ctx.names).size, ctx.names.length, "unique names");
    for (const n of callerFeatures) assert(ctx.names.includes(n), `missing ${n}`);
    assert(ctx.names.includes(RHYTHM_FEATURE), "the hour enters as rhythmFit");
    assert(!ctx.names.includes(COMBO_FEATURE), "comboEdge is derived by the ladder");
    assertEquals([...ctx.names].sort(), [...MATCH_FEATURES].sort());
    ctx.features.forEach((x, i) => {
      assert(Number.isFinite(x) && Math.abs(x) <= 1.5, `${ctx.names[i]} = ${x}`);
      if (x !== 0) nonZero.set(ctx.names[i], (nonZero.get(ctx.names[i]) ?? 0) + 1);
    });
  }
  for (const n of MATCH_FEATURES) assert((nonZero.get(n) ?? 0) >= 5, `${n} is non-zero in only ${nonZero.get(n) ?? 0}/50 pairs`);
});

Deno.test("ladder context: antisymmetric - swapping the teams negates every feature", () => {
  for (const { A, B, arena } of pairs(30, 2)) {
    const ab = matchContext(A, B, arena), ba = matchContext(B, A, arena);
    assertEquals(ba.names, ab.names);
    ab.features.forEach((x, i) => assertAlmostEquals(ba.features[i], -x, 1e-12, ab.names[i]));
  }
});

Deno.test("ladder context: identical teams give 0 on every feature and a rating-only expectation", () => {
  for (const { A, arena } of pairs(10, 3)) {
    for (const twin of [A, mirrorOf(A), structuredClone(A)]) {
      const ctx = matchContext(A, twin, arena);
      ctx.features.forEach((x, i) => assertEquals(Math.abs(x), 0, ctx.names[i]));
      assertEquals(teamCombos(twin), teamCombos(A));
    }
    const rec = recordMatch(learnedLadder(2), fakeResult(0, "ko"), [A, mirrorOf(A)], arena, 0);
    assertAlmostEquals(rec.expected, rec.ratingOnly, 1e-12, "no condition can favour either side");
  }
});

Deno.test("ladder context: pre-match only - identical before and after running the battle", () => {
  for (const seed of [4, 5]) {
    const [{ A, B, arena }] = pairs(1, seed);
    const spec = structuredClone(arena);
    const before = matchContext(A, B, arena);
    const combos = [teamCombos(A), teamCombos(B)];
    const r = new Battle({ seed, arena, teams: [A, B] }).run();
    assertEquals(arena, spec, "the battle must not touch the spec");
    assertEquals(matchContext(A, B, arena), before, "context changed after the battle");
    assertEquals([teamCombos(A), teamCombos(B)], combos);
    for (const res of [r, fakeResult(0, "ko"), fakeResult(1, "timeout"), fakeResult(2, "ko", [[false], [false]])]) {
      const m = matchResultFrom(res, [A, B], arena, before, 1);
      assert(m.context === before, "the context is taken as given, never rebuilt from the result");
      assertEquals([m.combosA, m.combosB], combos);
    }
  }
});

Deno.test("ladder context: teamCombos is deterministic, sorted, deduplicated and order-independent", () => {
  for (const { A, B } of pairs(10, 6)) {
    for (const t of [A, B]) {
      const c = teamCombos(t);
      assertEquals(teamCombos(t), c);
      assertEquals(teamCombos({ ...t, members: [...t.members].reverse() }), c, "member order");
      assertEquals(teamCombos(structuredClone(t)), c, "clone");
      assertEquals([...c].sort(), c, "sorted");
      assertEquals(new Set(c).size, c.length, "unique");
      for (const s of synergies(t)) assert(c.includes(s.id), `synergy ${s.id}`);
      const prim = t.members.map((g) => phenotypeOf(g).elements.primary);
      for (let i = 0; i < prim.length; i++) {
        for (let j = i + 1; j < prim.length; j++) assert(c.includes([prim[i], prim[j]].sort().join("+")), `pair ${prim[i]}/${prim[j]}`);
      }
      for (const k of c.filter((x) => x.includes("+"))) {
        const [x, y] = k.split("+");
        assert(ELEMENT_IDS.includes(x as ElementId) && ELEMENT_IDS.includes(y as ElementId) && x <= y, k);
      }
    }
  }
});

Deno.test("ladder context: matchResultFrom maps owners, score and win condition", () => {
  const [{ A, B, arena }] = pairs(1, 11);
  const ctx = matchContext(A, B, arena);
  const m = matchResultFrom(fakeResult(0, "ko", [[true, true], [false]]), [A, B], arena, ctx, 42);
  assertEquals([m.a, m.b, m.scoreA, m.winCondition, m.arena, m.weather, m.when], [A.owner, B.owner, 1, "sweep", arena.kind, arena.weather, 42]);
  assertEquals([m.combosA, m.combosB], [teamCombos(A), teamCombos(B)]);
  const lost = matchResultFrom(fakeResult(1, "ko", [[false], [true, false]]), [A, B], arena, ctx, 0);
  assertEquals([lost.scoreA, lost.winCondition], [0, "ko"]);
  const drawn = matchResultFrom(fakeResult(2, "timeout"), [A, B], arena, ctx, 0);
  assertEquals([drawn.scoreA, drawn.winCondition], [0.5, "timeout"]);
  assertEquals(winConditionOf(fakeResult(2, "ko", [[false], [false]])), "draw");
  assertEquals(winConditionOf(fakeResult(0, "timeout")), "timeout");
});

Deno.test("ladder store: save/load round trip with a fake Storage, and both copies continue identically", () => {
  const storage = new FakeStorage();
  const lad = new Ladder();
  pairs(6, 7).forEach(({ A, B, arena }, i) => recordMatch(lad, fakeResult((i % 3) as 0 | 1 | 2, i % 2 ? "ko" : "timeout"), [A, B], arena, i * 1000));
  assert(saveLadder(storage, lad));
  assert(storage.getItem(LADDER_KEY) !== null, `stored under ${LADDER_KEY}`);
  const back = loadLadder(storage);
  assertEquals(back.toJSON(), lad.toJSON());
  const [{ A, B, arena }] = pairs(1, 8);
  const x = recordMatch(lad, fakeResult(0, "ko"), [A, B], arena, 9000);
  const y = recordMatch(back, fakeResult(0, "ko"), [A, B], arena, 9000);
  assertEquals(y.last, x.last);
  assertEquals(back.toJSON(), lad.toJSON());
});

Deno.test("ladder store: corrupt, foreign or missing JSON gives a fresh ladder", () => {
  const fresh = JSON.stringify(new Ladder().toJSON());
  const v = new Ladder();
  v.record({ a: "x", b: "y", scoreA: 1, context: { names: [], features: [] }, arena: "meadow", weather: "clear", when: 0, combosA: [], combosB: [] });
  const valid = v.toJSON();
  const bad = [
    "{not json",
    "",
    "null",
    "42",
    '"genemon.ladder"',
    "[]",
    JSON.stringify({ kind: "other", version: 1 }),
    JSON.stringify({ ...valid, version: 2 }),
    JSON.stringify({ ...valid, players: { x: { rating: "1500", games: 1, wins: 1, losses: 0, draws: 0 } } }),
    JSON.stringify({ ...valid, options: { ...valid.options, k: "24" } }),
    JSON.stringify({ ...valid, weights: { typeAdvantage: null } }),
    JSON.stringify({ ...valid, tallies: { global: { arena: { meadow: 3 } }, players: {} } }),
    JSON.stringify(valid).slice(0, 60),
  ];
  for (const raw of bad) {
    const s = new FakeStorage();
    s.setItem(LADDER_KEY, raw);
    const l = loadLadder(s);
    assertEquals(l.matches, 0, `"${raw.slice(0, 30)}"`);
    assertEquals(JSON.stringify(l.toJSON()), fresh, `"${raw.slice(0, 30)}"`);
  }
  assertEquals(loadLadder(new FakeStorage()).matches, 0, "missing key");
  const throwing: StorageLike = {
    getItem: () => {
      throw new Error("SecurityError");
    },
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
    removeItem: () => {},
  };
  assertEquals(loadLadder(throwing).matches, 0, "unreadable storage");
  assertEquals(saveLadder(throwing, new Ladder()), false, "a refused write is reported, not thrown");
  const ok = new FakeStorage();
  ok.setItem(LADDER_KEY, JSON.stringify(valid));
  assertEquals(loadLadder(ok).matches, 1, "a valid ladder still loads");
  ok.setItem(LAST_MATCH_KEY, "{oops");
  assertEquals(loadLastMatch(ok), null);
});

Deno.test("ladder store: the recordBattle pure path is zero-sum and its summary matches the ladder", () => {
  const lad = new Ladder();
  const owners = ["max", "claude", "rival", "wild", "mirror"];
  const rng = new Rng(9);
  for (const [i, { A, B, arena }] of pairs(12, 9).entries()) {
    const teams: [Team, Team] = [{ ...A, owner: owners[i % 2] }, { ...B, owner: owners[2 + (i % 3)] }];
    const result = i < 2
      ? new Battle({ seed: i + 1, arena, teams }).run()
      : fakeResult(rng.pick([0, 1, 2] as const), rng.pick(["ko", "timeout"] as const));
    const rec = recordMatch(lad, result, teams, arena, i);
    assertEquals(rec.deltaA + rec.deltaB, 0, "zero-sum per match");
    const table = lad.table();
    assertAlmostEquals(table.reduce((s, r) => s + r.rating, 0), table.length * lad.base, 1e-6, "pool mean stays at base");
    const last = rec.last;
    assertEquals([last.a, last.b], [teams[0].owner, teams[1].owner]);
    assertAlmostEquals(last.expected, sigmoid(last.ratingLogit + last.contextLogit), 2e-3);
    assertAlmostEquals(last.deltaA, rec.deltaA, 1e-3);
    assertAlmostEquals(last.ratingA, lad.rating(last.a), 1e-3);
    assert(last.top.length <= TOP_CONTRIBUTIONS);
    for (let k = 1; k < last.top.length; k++) assert(Math.abs(last.top[k - 1].logit) >= Math.abs(last.top[k].logit), "largest first");
  }
});

Deno.test("ladder store: a win against the conditions pays more than a win the conditions handed over", () => {
  const scored = pairs(40, 10).map((p) => ({ ...p, z: matchContext(p.A, p.B, p.arena).features.reduce((s, x) => s + x, 0) }));
  const pick = scored.sort((x, y) => Math.abs(y.z) - Math.abs(x.z))[0];
  assert(Math.abs(pick.z) > 0.2, `need clearly unequal conditions (z ${pick.z})`);
  const [fav, dog] = pick.z > 0 ? [pick.A, pick.B] : [pick.B, pick.A];
  const as = (t: Team, owner: string): Team => ({ ...t, owner });
  const win = fakeResult(0, "ko", [[false, true], [false]]);
  const handed = recordMatch(learnedLadder(1), win, [as(fav, "p"), as(dog, "q")], pick.arena, 0);
  const earned = recordMatch(learnedLadder(1), win, [as(dog, "p"), as(fav, "q")], pick.arena, 0);
  assert(handed.expected > 0.5 && earned.expected < 0.5, `E ${handed.expected} / ${earned.expected}`);
  assert(earned.deltaA > handed.deltaA, `earned ${earned.deltaA} <= handed ${handed.deltaA}`);
  const loss = fakeResult(1, "ko", [[false], [false, true]]);
  const upset = recordMatch(learnedLadder(1), loss, [as(fav, "p"), as(dog, "q")], pick.arena, 0);
  const expectedLoss = recordMatch(learnedLadder(1), loss, [as(dog, "p"), as(fav, "q")], pick.arena, 0);
  assert(upset.deltaA < expectedLoss.deltaA, "losing when favoured costs more");
});

Deno.test("ladder store: recordBattle saves the ladder and the last match, emits one ledger row, skips self-play", () => {
  resetLadder();
  const storage = new FakeStorage();
  const ledger = new Ledger("t");
  const host = { ledger };
  const [{ A, B, arena }] = pairs(1, 12);
  const teams: [Team, Team] = [{ ...A, owner: "max" }, { ...B, owner: "rival" }];
  const out = recordBattle(host, fakeResult(0, "ko"), teams, arena, storage);
  assert(out.rated, "rated");
  assertEquals(out.deltaA + out.deltaB, 0);
  assert(out.deltaA > 0, "a win gains rating");
  const last = loadLastMatch(storage);
  assert(last !== null && last.a === "max" && last.b === "rival", "last match stored");
  assertAlmostEquals(last!.deltaA, out.deltaA, 1e-3);
  assertEquals(ledger.counts()["ladder.match"], 1);
  const lad = getLadder(host, storage);
  assert(getLadder(host, storage) === lad, "singleton");
  assertEquals(lad.matches, 1);
  assertEquals(loadLadder(storage).toJSON(), lad.toJSON(), "what is stored is what is live");
  const self = recordBattle(host, fakeResult(0, "ko"), [teams[0], { ...teams[1], owner: "max" }], arena, storage);
  assertEquals(self.rated, false);
  assertEquals(lad.matches, 1, "self-play not recorded");
  resetLadder();
});
