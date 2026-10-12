import { assert, assertEquals } from "./_assert.ts";
import { Battle } from "../src/combat/battle.ts";
import { ARCHETYPES, arenaSpec, makeArchetype, team } from "../src/combat/scenario.ts";
import { createGenemon } from "../src/genome/genemon.ts";
import { autoTeam, validateTeam } from "../src/combat/team.ts";
import { isValidEvent, Ledger } from "../src/core/ledger.ts";
import { ARENA_KINDS, generateArena } from "../src/world/arena.ts";

function randomTeams(seed: number) {
  const pool = Array.from({ length: 14 }, (_, i) => createGenemon({ seed: seed * 100 + i, level: 20 }));
  return [autoTeam(pool.slice(0, 7), "A", seed), autoTeam(pool.slice(7), "B", seed + 1)] as const;
}

Deno.test("arena: every kind generates finite heights inside the playable circle", () => {
  for (const kind of ARENA_KINDS) {
    const a = generateArena({ seed: 3, kind, weather: "clear", hour: 12 });
    for (const h of a.heights) assert(Number.isFinite(h), `${kind} height`);
    const shares = a.groundShares();
    assert(Object.keys(shares).length >= 2, `${kind} needs at least 2 ground types`);
  }
});

Deno.test("battle: completes, stays finite, and is deterministic for a seed", () => {
  for (let s = 1; s <= 6; s++) {
    const [A, B] = randomTeams(s);
    assert(validateTeam(A).ok && validateTeam(B).ok, "teams valid");
    const r1 = new Battle({ seed: s, arena: arenaSpec(ARENA_KINDS[s % ARENA_KINDS.length], s), teams: [A, B] }).run();
    const [A2, B2] = randomTeams(s);
    const r2 = new Battle({ seed: s, arena: arenaSpec(ARENA_KINDS[s % ARENA_KINDS.length], s), teams: [A2, B2] }).run();
    assertEquals(r1.winner, r2.winner, "winner deterministic");
    assertEquals(Math.round(r1.duration * 30), Math.round(r2.duration * 30), "duration deterministic");
    assert(r1.duration <= 90.05, `duration ${r1.duration}`);
    for (const f of r1.fighters) assert(Number.isFinite(f.hpFrac), "hp finite");
  }
});

Deno.test("battle: ledger rows are valid 5W events and cover decide/hit/end", () => {
  const [A, B] = randomTeams(9);
  const ledger = new Ledger("b");
  new Battle({ seed: 9, arena: arenaSpec("meadow", 9), teams: [A, B], ledger }).run();
  const counts = ledger.counts();
  assert((counts["battle.decide"] ?? 0) > 0, "decisions logged");
  assert((counts["battle.hit"] ?? 0) > 0, "hits logged");
  assertEquals(counts["battle.end"], 1);
  for (const r of ledger.rows()) assert(isValidEvent(r), `invalid row ${r.what}`);
});

Deno.test("scenario SC-01: a big fire brawler beats two small plants (>= 70%)", () => {
  let wins = 0, n = 0;
  for (let s = 0; s < 30; s++) {
    const fire = makeArchetype(ARCHETYPES.bigFireBrawler, s);
    const plants = [makeArchetype(ARCHETYPES.smallPlant, s * 7 + 1), makeArchetype({ ...ARCHETYPES.smallPlant, label: "small plant b", kind: "hexapod" }, s * 7 + 2)];
    const r = new Battle({ seed: s, arena: arenaSpec("meadow", s), teams: [team("fire", [fire]), team("plants", plants)] }).run();
    if (r.winner === 2) continue;
    n++;
    if (r.winner === 0) wins++;
  }
  assert(n > 0 && wins / n >= 0.7, `big fire won ${wins}/${n}`);
});
