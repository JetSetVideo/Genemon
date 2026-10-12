import { assert, assertAlmostEquals, assertEquals } from "./_assert.ts";
import { Battle } from "../src/combat/battle.ts";
import { ARCHETYPES, arenaSpec, makeArchetype, team } from "../src/combat/scenario.ts";
import { createGenemon, type Genemon, phenotypeOf } from "../src/genome/genemon.ts";
import { autoTeam, synergies, type Team, validateTeam } from "../src/combat/team.ts";
import { isValidEvent, Ledger } from "../src/core/ledger.ts";
import { hashSeed } from "../src/core/rng.ts";
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

// ------------------------------------------------------------------ pass 2: review fixes pinned
const POOL = Array.from({ length: 1500 }, (_, i) => createGenemon({ seed: hashSeed("syn", i), level: 20 }));
const PHS = POOL.map((g) => phenotypeOf(g));
const NON_PAIR = new Set(["pack", "formation", "vanguard", "guardian", "prism", "resonance"]);
const mk = (members: Genemon[], owner = "A"): Team => ({ id: owner, owner, name: owner, members });

Deno.test("team [SPEC T2]: one dual-type Genemon cannot enable a pair synergy alone (X4)", () => {
  let checked = 0;
  for (let i = 0; i < POOL.length && checked < 4; i++) {
    const { primary, secondary } = PHS[i].elements;
    if (!secondary) continue;
    const a = PHS.findIndex((p) => p.elements.primary === primary && !p.elements.secondary);
    const b = PHS.findIndex((p) => p.elements.primary === secondary && !p.elements.secondary);
    if (a < 0 || b < 0) continue;
    const pair = synergies(mk([POOL[a], POOL[b]])).map((s) => s.id).filter((id) => !NON_PAIR.has(id));
    if (pair.length === 0) continue; // these two elements form no pair
    checked++;
    assertEquals(synergies(mk([POOL[i]])).map((s) => s.id), [], `${primary}/${secondary} alone must not enable ${pair.join(",")}`);
  }
  assert(checked >= 1, "the test found a dual-type Genemon whose two elements form a pair (otherwise it proves nothing)");
});

Deno.test("battle [SPEC T2]: a synergy dies with its enabler and its stat bonus is taken back (X4)", () => {
  const big = POOL.find((_, i) => PHS[i].slots >= 3)!, small = POOL.find((_, i) => PHS[i].slots === 1)!;
  const b = new Battle({ seed: 5, arena: arenaSpec("meadow", 5), teams: [mk([big, small]), randomTeams(5)[1]] });
  assert(b.synergies[0].some((s) => s.id === "guardian"), "a giant + a small one form Guardian");
  const fBig = b.fighters.find((f) => f.team === 0 && f.genemon === big)!, fSmall = b.fighters.find((f) => f.team === 0 && f.genemon === small)!;
  // deno-lint-ignore no-explicit-any
  (b as any).knockOut(fSmall, null);
  assert(!b.synergies[0].some((s) => s.id === "guardian"), "Guardian is gone once the small one is down");
  const kept = b.synergies[0].reduce((k, s) => k * (s.statMult?.evasion ?? 1), 1);
  assertAlmostEquals(fBig.stats.evasion, PHS[POOL.indexOf(big)].stats.evasion * kept, 1e-9, "the +15 % evasion was taken back");
});

Deno.test("battle [SPEC T3]: team order is a formation - the first half holds the front row", () => {
  const four = POOL.filter((_, i) => PHS[i].slots === 1).slice(0, 4);
  const b = new Battle({ seed: 2, arena: arenaSpec("meadow", 2), teams: [mk(four), randomTeams(2)[1]] });
  const R = b.arena.radius;
  const xs = b.fighters.filter((f) => f.team === 0).sort((p, q) => p.order - q.order).map((f) => f.body.pos.x);
  assertAlmostEquals(xs[0], xs[1], 1e-9, "orders 0 and 1 share the front row");
  assertAlmostEquals(xs[2], xs[3], 1e-9, "orders 2 and 3 share the back row");
  assert(xs[2] < xs[0] - 1.4, `the back row stands behind the front row (${xs[2].toFixed(2)} vs ${xs[0].toFixed(2)})`);
  assert(-xs[0] <= R * 0.3 + 1e-9 && -xs[0] >= 2.5, "the front line sits inside the size-scaled band");
});

Deno.test("battle: the start line scales with body size (small fights compact, big ones ~R x 0.3)", () => {
  const small = POOL.filter((_, i) => PHS[i].heightM < 0.4).slice(0, 2), big = POOL.filter((_, i) => PHS[i].heightM > 1.6).slice(0, 2);
  const gap = (t: Genemon[]) => {
    const b = new Battle({ seed: 3, arena: arenaSpec("meadow", 3), teams: [mk(t), mk(t.map((g) => ({ ...g, id: g.id + "-b" })), "B")] });
    return b.fighters[b.fighters.length - 1].body.pos.x - b.fighters[0].body.pos.x;
  };
  assert(small.length === 2 && big.length === 2, "pool has small and big Genemon");
  assert(gap(small) < 7, `small fighters start close (${gap(small).toFixed(1)} m)`);
  assert(gap(big) > gap(small) * 1.5, `big fighters start further apart (${gap(big).toFixed(1)} m)`);
});

Deno.test("battle [SPEC X8]: the timeout score is plain HP share (no slot double-weighting)", () => {
  const [A, B] = randomTeams(4);
  const b = new Battle({ seed: 4, arena: arenaSpec("meadow", 4), teams: [A, B] });
  const mine = b.fighters.filter((f) => f.team === 0);
  assert(new Set(mine.map((f) => f.ph.slots)).size > 1, "needs mixed sizes, or slot weighting would cancel out and the test could not fail");
  mine.forEach((f, i) => (f.hp = i === 0 ? 0 : f.maxHp));
  const want = mine.reduce((s, f) => s + f.hp, 0) / mine.reduce((s, f) => s + f.maxHp, 0);
  assertAlmostEquals(b.hpFrac()[0], want, 1e-12);
});
