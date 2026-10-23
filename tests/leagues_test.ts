import { assert, assertEquals } from "./_assert.ts";
import type { BattleResult } from "../src/combat/battle.ts";
import { autoTeam, type Team } from "../src/combat/team.ts";
import { Ledger } from "../src/core/ledger.ts";
import { hashSeed } from "../src/core/rng.ts";
import { createGenemon, type Genemon, phenotypeOf } from "../src/genome/genemon.ts";
import { canRank, lifePhase, phaseDays } from "../src/genome/lifeclock.ts";
import { eligibility, LEAGUE_IDS, LEAGUES, lastMatchKey, leagueOfRecord, PRIME_LEVEL_CAP, rankTier, TEAM_SLOTS, teamEligibility, TIERS } from "../src/ladder/leagues.ts";
import { Ladder } from "../src/ladder/mmr.ts";
import { rankedConditions } from "../src/ladder/ranked.ts";
import {
  getLadder,
  LADDER_KEY,
  LAST_MATCH_KEY,
  leagueLadder,
  loadLadder,
  loadLastMatch,
  recordBattle,
  recordLeagueBattle,
  resetLadder,
  saveLadder,
  standingOf,
  type StorageLike,
} from "../src/ui/ladderStore.ts";
import type { ArenaSpec } from "../src/world/arena.ts";

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

const NOW = 1_800_000_000_000;

function mon(seed: number, level = 20): Genemon {
  return createGenemon({ seed: hashSeed("lg", seed), owner: "max", level });
}
/** Same Genemon aged into a life phase (just past the phase start). */
function aged(g: Genemon, phase: "egg" | "adult" | "elder" | "ancient"): Genemon {
  const d = phaseDays(g);
  g.conditions.ageDays = phase === "egg" ? 0 : phase === "adult" ? d.adult * 1.6 : d[phase] + 1;
  return g;
}
function scar(g: Genemon, n: number): Genemon {
  g.life = { ...(g.life ?? {}), scars: Array.from({ length: n }, (_, i) => ({ atDay: i, part: "torso", severity: 0.5, from: "physical" as const, side: 1 as const, u: 0.5, angle: 0 })) } as Genemon["life"];
  return g;
}

function fakeResult(winner: 0 | 1 | 2): BattleResult {
  return {
    winner,
    reason: "ko",
    duration: 30,
    hpFrac: [0.5, 0.5],
    mvp: "",
    arena: "meadow",
    weatherStart: "clear",
    weatherEnd: "clear",
    hour: 13,
    reactions: {},
    fighters: [
      { id: "f0", name: "f0", team: 0, alive: winner !== 1, hpFrac: 0.5, tally: { dealt: 0, taken: 0, kos: 0, hits: 0, misses: 0, crits: 0, reactions: 0, casts: 0 } },
      { id: "f1", name: "f1", team: 1, alive: winner === 1, hpFrac: 0, tally: { dealt: 0, taken: 0, kos: 0, hits: 0, misses: 0, crits: 0, reactions: 0, casts: 0 } },
    ],
    knowledge: {},
    elementsUsed: {},
    damageTakenBy: {},
    moveUses: {},
    synergies: [[], []],
    switches: [],
    interrupts: 0,
  } as unknown as BattleResult;
}
function teams(): [Team, Team] {
  const pool = (o: string) => Array.from({ length: 6 }, (_, i) => createGenemon({ seed: hashSeed("lt", o, i), owner: o, level: 15 }));
  return [autoTeam(pool("max"), "max", 1, "balanced"), autoTeam(pool("rival"), "rival", 2, "balanced")];
}
const ARENA: ArenaSpec = { seed: 7, kind: "meadow", weather: "clear", hour: 13 };

Deno.test("leagues [P6-R1]: two leagues, separate ladder keys, Prime keeps the legacy keys, cap 50 vs none", () => {
  assertEquals([...LEAGUE_IDS], ["prime", "eternal"]);
  assertEquals(LEAGUES.prime.ladderKey, "genemon.ladder", "Prime IS the pre-pass-6 ladder (migration = same key)");
  assertEquals(LADDER_KEY, LEAGUES.prime.ladderKey);
  assertEquals(LAST_MATCH_KEY, "genemon.ladder.last");
  assert(LEAGUES.eternal.ladderKey !== LEAGUES.prime.ladderKey && lastMatchKey("eternal") !== LAST_MATCH_KEY, "Eternal has its own keys");
  assertEquals([LEAGUES.prime.levelCap, LEAGUES.eternal.levelCap], [PRIME_LEVEL_CAP, null]);
  assertEquals(PRIME_LEVEL_CAP, 50);
  for (const p of ["egg", "fetus", "cocoon", "ancient"]) assert(LEAGUES.prime.refusedPhases.includes(p), `prime refuses ${p}`);
  for (const p of ["elder", "ancient", "cocoon"]) assert(!LEAGUES.eternal.refusedPhases.includes(p), `eternal admits ${p}`);
});

Deno.test("leagues [P6-R1]: Prime refuses the unborn, ancients, scarred elders and Lv > 50; Eternal admits all born Genemon", () => {
  const adult = aged(mon(1, 20), "adult");
  assertEquals(lifePhase(adult), "adult");
  assert(eligibility("prime", adult, NOW).ok && eligibility("eternal", adult, NOW).ok, "an adult fights in both");

  const egg = aged(mon(2, 1), "egg");
  for (const l of LEAGUE_IDS) {
    const e = eligibility(l, egg, NOW);
    assert(!e.ok && e.why.includes("not born"), `${l}: egg refused (${e.why})`);
  }

  const ancient = aged(mon(3, 30), "ancient");
  assertEquals(lifePhase(ancient), "ancient");
  const pa = eligibility("prime", ancient, NOW);
  assert(!pa.ok && pa.why.includes("Eternal"), `prime refuses the ancient and points to Eternal: ${pa.why}`);
  assert(eligibility("eternal", ancient, NOW).ok, "eternal admits the ancient: old Genemon keep ranking");

  const fitElder = aged(mon(4, 28), "elder");
  assertEquals(lifePhase(fitElder), "elder");
  assert(eligibility("prime", fitElder, NOW).ok, "an unscarred elder still ranks in Prime (lifeclock.canRank)");
  const wornElder = scar(aged(mon(4, 28), "elder"), 9);
  assert(!canRank(wornElder).ok, "fixture: lifeclock refuses this elder");
  assert(!eligibility("prime", wornElder, NOW).ok, "prime follows canRank");
  assert(eligibility("eternal", wornElder, NOW).ok, "eternal admits the battle-worn elder");

  const capped = aged(mon(5, PRIME_LEVEL_CAP), "adult");
  const over = aged(mon(5, PRIME_LEVEL_CAP + 8), "adult");
  assertEquals(phenotypeOf(capped).level, PRIME_LEVEL_CAP);
  assert(phenotypeOf(over).level > PRIME_LEVEL_CAP, "fixture above the cap");
  assert(eligibility("prime", capped, NOW).ok, "Lv 50 is inside the cap");
  const po = eligibility("prime", over, NOW);
  assert(!po.ok && po.why.includes("cap"), `prime refuses Lv > 50: ${po.why}`);
  assert(eligibility("eternal", over, NOW).ok, "eternal has no level cap");
});

Deno.test("leagues: Prime never admits what lifeclock.canRank refuses; Eternal admits every born Genemon that fits 6 slots", () => {
  let refusedByClock = 0;
  for (let i = 0; i < 160; i++) {
    const g = mon(100 + i, 5 + (i % 60));
    const d = phaseDays(g);
    g.conditions.ageDays = (i % 8) * d.ancient / 6;
    if (i % 5 === 0) scar(g, i % 12);
    const p = eligibility("prime", g, NOW), e = eligibility("eternal", g, NOW);
    if (!canRank(g).ok) {
      refusedByClock++;
      assert(!p.ok, `prime admitted ${g.name}: canRank says ${canRank(g).why}`);
    }
    const born = lifePhase(g) !== "egg" && lifePhase(g) !== "fetus";
    assertEquals(e.ok, born && phenotypeOf(g).slots <= TEAM_SLOTS, `eternal ${g.name} (${lifePhase(g)}): ${e.why}`);
    if (p.ok) assert(e.ok, "anything Prime admits, Eternal admits");
    assert(p.why.length > 0 && e.why.length > 0, "every verdict has a reason");
    assertEquals(eligibility("prime", g, NOW), p, "deterministic");
  }
  assert(refusedByClock > 10, `the sweep must exercise refusals (${refusedByClock})`);
});

Deno.test("leagues [P6-R2]: teamEligibility keeps team order, gives each bench a reason, and enforces the 6 slots", () => {
  const team = [aged(mon(11, 20), "adult"), aged(mon(12, 30), "ancient"), aged(mon(13, 1), "egg"), aged(mon(14, 22), "adult")];
  const p = teamEligibility("prime", team, NOW);
  const e = teamEligibility("eternal", team, NOW);
  assertEquals(p.rows.map((r) => r.id), team.map((g) => g.id), "one row per member, in order");
  const fitsSlots = (ids: string[]) => ids.reduce((s, id) => s + phenotypeOf(team.find((g) => g.id === id)!).slots, 0) <= TEAM_SLOTS;
  assert(!p.fighters.some((g) => g.id === team[1].id || g.id === team[2].id), "prime benches the ancient and the egg");
  assert(e.fighters.some((g) => g.id === team[1].id), "eternal fields the ancient (if it fits the slots)" + (fitsSlots([team[0].id, team[1].id]) ? "" : " - slot overflow"));
  assert(!e.fighters.some((g) => g.id === team[2].id), "an egg never fights");
  for (const t of [p, e]) {
    assertEquals(t.fighters.length + t.out.length, team.length);
    assert(t.slots <= TEAM_SLOTS, "fighters fit the slots");
    assert(t.out.every((o) => o.why.length > 0), "every bench has a reason");
    const order = t.fighters.map((g) => team.indexOf(g));
    assertEquals(order, [...order].sort((a, b) => a - b), "team order kept");
  }
  // Slot overflow: big bodies (>= 3 slots) in a row; the one that no longer fits sits out with a slot reason.
  const big: Genemon[] = [];
  for (let i = 0; big.length < 3 && i < 3000; i++) {
    const g = aged(createGenemon({ seed: hashSeed("big", i), owner: "max", level: 20 }), "adult");
    if (phenotypeOf(g).slots >= 3) big.push(g);
  }
  assertEquals(big.length, 3, "found three big bodies");
  const t = teamEligibility("eternal", big, NOW);
  assert(t.slots <= TEAM_SLOTS, `slots ${t.slots}`);
  assert(t.out.some((o) => o.why.includes("slot")), `a slot reason: ${JSON.stringify(t.out.map((o) => o.why))}`);
});

Deno.test("leagues: rank tiers are ordered, Unranked before the first game, a new player is Silver", () => {
  assertEquals(rankTier(1500, 0).id, "unranked");
  assertEquals(rankTier(1500, 1).id, "silver");
  assertEquals(rankTier(1300, 3).id, "bronze");
  assertEquals(rankTier(1950, 3).id, "master");
  let prev = -1;
  for (let r = 1200; r <= 2100; r += 10) {
    const i = TIERS.findIndex((t) => t.id === rankTier(r, 5).id);
    assert(i >= prev, `monotone at ${r}`);
    prev = i;
  }
});

Deno.test("leagues: history rows before pass 6 count as Prime; practice rows belong to no league", () => {
  assertEquals(leagueOfRecord({ kind: "ranked" }), "prime");
  assertEquals(leagueOfRecord({ kind: "forfeit" }), "prime");
  assertEquals(leagueOfRecord({}), "prime");
  assertEquals(leagueOfRecord({ kind: "ranked", league: "eternal" }), "eternal");
  assertEquals(leagueOfRecord({ kind: "practice", league: "eternal" }), null);
  assertEquals(leagueOfRecord({ kind: "replay" }), null);
});

Deno.test("leagues: each league draws its own ranked conditions; Prime's draw is unchanged", () => {
  const seeds = new Set<number>();
  for (let n = 0; n < 60; n++) {
    const p = rankedConditions("max", n, 20380, 14, "clear");
    assertEquals(rankedConditions("max", n, 20380, 14, "clear", "prime"), p, "prime = the pre-pass-6 draw");
    const e = rankedConditions("max", n, 20380, 14, "clear", "eternal");
    assertEquals(rankedConditions("max", n, 20380, 14, "clear", "eternal"), e, "deterministic");
    assert(e.seed !== p.seed, "a league never reuses the other's seed");
    seeds.add(p.seed);
    seeds.add(e.seed);
  }
  assertEquals(seeds.size, 120, "120 distinct seeds");
});

Deno.test("league store: legacy ladder data loads as Prime (MMR kept); an Eternal battle moves only the Eternal rating", () => {
  resetLadder();
  const storage = new FakeStorage();
  // A pre-pass-6 save: one ladder under the legacy key with the player's rating.
  const legacy = new Ladder();
  legacy.record({ a: "max", b: "rival", scoreA: 1, context: { names: [], features: [] }, arena: "meadow", weather: "clear", when: 0, combosA: [], combosB: [] });
  saveLadder(storage, legacy);
  const mmr = legacy.rating("max");
  assert(mmr > 1500, "fixture: the player won rating before pass 6");
  const ledger = new Ledger("t");
  const host = { ledger };
  assertEquals(getLadder(host, storage).rating("max"), mmr, "legacy ladder = Prime, MMR kept");
  assertEquals(leagueLadder(host, "prime", storage), getLadder(host, storage), "same instance");
  assertEquals(leagueLadder(host, "eternal", storage).rating("max"), 1500, "Eternal starts fresh at base");

  const t = teams();
  const out = recordLeagueBattle(host, "eternal", fakeResult(0), t, ARENA, storage);
  assert(out.rated && out.deltaA > 0, "eternal win rated");
  assertEquals(getLadder(host, storage).rating("max"), mmr, "Prime rating untouched");
  assert(leagueLadder(host, "eternal", storage).rating("max") > 1500, "Eternal rating moved");
  assertEquals(loadLadder(storage).rating("max"), mmr, "stored Prime untouched");
  assertEquals(loadLadder(storage, undefined, "eternal").matches, 1, "Eternal stored under its own key");
  assert(storage.getItem(LEAGUES.eternal.ladderKey) !== null);
  assertEquals(loadLastMatch(storage), null, "no Prime last-match written");
  assert(loadLastMatch(storage, "eternal") !== null, "Eternal last match");
  assertEquals(ledger.counts()["ladder.match"], 1, "one ladder.match row");

  const out2 = recordBattle(host, fakeResult(1), t, ARENA, storage);
  assert(out2.rated && out2.deltaA < 0, "prime loss rated via the legacy signature");
  assert(getLadder(host, storage).rating("max") < mmr, "Prime moved");
  assertEquals(leagueLadder(host, "eternal", storage).matches, 1, "Eternal untouched by a Prime battle");

  const sp = standingOf(getLadder(host, storage), "max", "prime");
  const se = standingOf(leagueLadder(host, "eternal", storage), "max", "eternal");
  assertEquals([sp.games, sp.wins, sp.losses], [2, 1, 1]);
  assertEquals([se.games, se.wins, se.losses], [1, 1, 0]);
  assertEquals(standingOf(leagueLadder(host, "eternal", storage), "nobody", "eternal").place, null);
  resetLadder();
});

Deno.test("league store: ladder.match rows carry the league", () => {
  resetLadder();
  const storage = new FakeStorage();
  const ledger = new Ledger("t2");
  const t = teams();
  recordLeagueBattle({ ledger }, "eternal", fakeResult(0), t, ARENA, storage);
  recordLeagueBattle({ ledger }, "prime", fakeResult(0), t, ARENA, storage);
  const rows = ledger.query({ what: "ladder.match" });
  assertEquals(rows.map((r) => r.entries.league), ["eternal", "prime"]);
  assertEquals(ledger.query({ tag: "eternal" }).length, 1, "tagged by league");
  resetLadder();
});
