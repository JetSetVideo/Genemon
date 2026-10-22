import { assert, assertEquals, assertThrows } from "./_assert.ts";
import {
  abandonRun,
  arenaFor,
  battleSeed,
  type GauntletRun,
  healBetween,
  isBoss,
  isGauntletRun,
  opponentFor,
  opponentLevel,
  recordRound,
  rewardsFor,
  roundReward,
  scoreOf,
  startRun,
} from "../src/combat/gauntlet.ts";
import { createGenemon, phenotypeOf } from "../src/genome/genemon.ts";
import { SIZE_CLASSES } from "../src/genome/phenotype.ts";
import { emptyGauntletState, FINISHED_KEPT, gauntletKey, GauntletStore, parseGauntletState, type StorageLike } from "../src/ui/gauntletStore.ts";

const champion = createGenemon({ seed: 4242, owner: "p1", level: 12 });
const NOW = 1_760_000_000_000;

function memStorage(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
}

const at = (run: GauntletRun, round: number): GauntletRun => ({ ...run, round });
const win = (hpFrac = 0.5) => ({ won: true, hpFrac, opponent: "X", level: 10, durationS: 20 });
const lose = { won: false, hpFrac: 0, opponent: "Y", level: 11, durationS: 30 };

Deno.test("gauntlet: opponents are deterministic per (seed, round) and differ between rounds and seeds", () => {
  const a = startRun(champion, "p1", 7, NOW), b = startRun(champion, "p1", 7, NOW + 999);
  const o1 = opponentFor(at(a, 3), 12), o2 = opponentFor(at(b, 3), 12);
  assertEquals(o1.genome.id, o2.genome.id, "same seed + round");
  assertEquals(o1.id, o2.id);
  assertEquals(o1.name, o2.name);
  assert(opponentFor(at(a, 4), 12).genome.id !== o1.genome.id, "another round is another opponent");
  assert(opponentFor(at(startRun(champion, "p1", 8, NOW), 3), 12).genome.id !== o1.genome.id, "another seed");
  assertEquals(battleSeed(at(a, 3)), battleSeed(at(b, 3)));
  assert(battleSeed(at(a, 3)) !== battleSeed(at(a, 4)));
  assertEquals(arenaFor(at(a, 3)), arenaFor(at(b, 3)));
  assertEquals(o1.owner, "gauntlet");
});

Deno.test("gauntlet: elements and body kinds vary along a run", () => {
  const run = startRun(champion, "p1", 11, NOW);
  const prim = new Set<string>(), kinds = new Set<string>();
  for (let r = 1; r <= 20; r++) {
    const ph = phenotypeOf(opponentFor(at(run, r), 12));
    prim.add(ph.elements.primary);
    kinds.add(ph.kind);
  }
  assert(prim.size >= 4, `only ${prim.size} primary elements in 20 rounds`);
  assert(kinds.size >= 3, `only ${kinds.size} body kinds in 20 rounds`);
});

Deno.test("gauntlet: levels rise with the round; every 5th round is a boss with a higher level", () => {
  assertEquals(opponentLevel(1, 12), 9);
  assertEquals(opponentLevel(1, 1), 1, "level floor");
  let prevNormal = 0;
  for (let r = 1; r <= 30; r++) {
    assertEquals(isBoss(r), r % 5 === 0, `round ${r}`);
    const lv = opponentLevel(r, 12);
    if (!isBoss(r)) {
      assert(lv >= prevNormal, `round ${r} level ${lv} < ${prevNormal}`);
      prevNormal = lv;
    } else {
      assert(lv > opponentLevel(r - 1, 12) && lv > opponentLevel(r + 1, 12), `boss round ${r} not above its neighbours`);
    }
  }
  assert(opponentLevel(30, 12) > opponentLevel(1, 12) + 15, "levels climb over a long run");
  const run = startRun(champion, "p1", 5, NOW);
  assertEquals(phenotypeOf(opponentFor(at(run, 5), 12)).level, opponentLevel(5, 12), "the Genemon really has that level");
  assert(opponentFor(at(run, 5), 12).name.startsWith("Boss "));
  assert(!isBoss(0) && !isBoss(4) && isBoss(10));
});

Deno.test("gauntlet: bosses are a bigger size class on average", () => {
  let boss = 0, normal = 0, nb = 0, nn = 0;
  for (let s = 0; s < 40; s++) {
    const run = startRun(champion, "p1", 1000 + s, NOW);
    for (const r of [4, 5, 6, 9, 10]) {
      const idx = SIZE_CLASSES.indexOf(phenotypeOf(opponentFor(at(run, r), 12)).sizeClass);
      if (isBoss(r)) (boss += idx, nb++);
      else (normal += idx, nn++);
    }
  }
  assert(boss / nb > normal / nn + 0.5, `boss mean class ${boss / nb} vs normal ${normal / nn}`);
});

Deno.test("gauntlet: recordRound win semantics, heal, clamp and immutability", () => {
  const run = startRun(champion, "p1", 9, NOW);
  assertEquals([run.round, run.streak, run.hpCarry, run.alive], [1, 0, 1, true]);
  const frozen = JSON.stringify(run);
  const r1 = recordRound(run, win(0.4));
  assertEquals(JSON.stringify(run), frozen, "input run untouched");
  assert(r1 !== run && r1.history !== run.history);
  assertEquals([r1.round, r1.streak, r1.alive], [2, 1, true]);
  assertEquals(r1.hpCarry, 0.4 + healBetween(1));
  assertEquals(r1.history.length, 1);
  assertEquals(r1.history[0].hpAfter, 0.4);
  const clamped = recordRound(r1, win(0.95));
  assertEquals(clamped.hpCarry, 1, "hpCarry clamps to 1");
  const weird = recordRound(r1, win(Number.NaN));
  assertEquals(weird.hpCarry, healBetween(2), "a non-finite hpFrac counts as 0");
  assertEquals(recordRound(r1, win(7)).history[1].hpAfter, 1, "hpFrac clamps to 1");
  // boss heal: winning round 5 heals 0.5
  const atBoss = at(run, 5);
  assertEquals(recordRound(atBoss, win(0.2)).hpCarry, 0.7);
  assert(recordRound(atBoss, win(0.2)).history[0].boss);
  assertEquals(healBetween(5), 0.5);
  assertEquals(healBetween(6), 0.25);
});

Deno.test("gauntlet FALSIFIER: a loss or a draw ends the run and a dead run cannot continue", () => {
  const r1 = recordRound(startRun(champion, "p1", 3, NOW), win(0.8));
  const dead = recordRound(r1, lose);
  assertEquals([dead.alive, dead.streak, dead.round], [false, 1, 2], "loss ends the run, streak kept, round not advanced");
  assertEquals(dead.history.length, 2);
  assertEquals(dead.history[1].won, false);
  assertThrows(() => recordRound(dead, win(1)), "recordRound on a dead run must throw");
  const draw = recordRound(r1, { ...lose, hpFrac: 0.3 });
  assertEquals(draw.alive, false, "a draw (won=false) ends the run too");
  assertEquals(r1.alive, true, "the earlier run is still alive (immutable)");
  const quit = abandonRun(r1);
  assertEquals([quit.alive, quit.gaveUp, quit.history.length], [false, true, 1]);
  assertEquals(abandonRun(dead), dead, "abandoning a finished run is a no-op");
  assertThrows(() => recordRound(quit, win()), "a given-up run cannot continue");
});

Deno.test("gauntlet: rewards and score rise with the streak; bosses pay a bonus", () => {
  let run = startRun(champion, "p1", 21, NOW);
  let prev = rewardsFor(run), prevScore = scoreOf(run);
  assertEquals(prev, { credits: 0, xp: 0 });
  for (let i = 0; i < 12; i++) {
    run = recordRound(run, { ...win(0.6), level: 10 + i });
    const r = rewardsFor(run), s = scoreOf(run);
    assert(r.credits > prev.credits && r.xp > prev.xp, `rewards did not rise at streak ${run.streak}`);
    assert(s > prevScore, `score did not rise at streak ${run.streak}`);
    prev = r;
    prevScore = s;
  }
  assert(roundReward(5).credits > roundReward(6).credits, "boss bonus");
  assert(roundReward(5).xp > roundReward(6).xp);
  const lost = recordRound(run, lose);
  assertEquals(rewardsFor(lost), rewardsFor(run), "a lost round pays nothing");
});

Deno.test("gauntlet store: round-trip, resume, best streak, finished list cap", () => {
  const st = memStorage();
  const store = new GauntletStore(st, "p1");
  assertEquals(store.current(), null);
  let run = startRun(champion, "p1", 1, NOW);
  run = recordRound(run, win(0.5));
  store.setCurrent(run);
  assert(st.data.has(gauntletKey("p1")), "written through immediately");
  const reload = new GauntletStore(st, "p1");
  assertEquals(reload.current(), run, "current run resumes after reload");
  assert(isGauntletRun(reload.current()));
  const dead = recordRound(recordRound(run, win(0.4)), lose);
  const fin = reload.finish(dead, NOW + 60_000);
  assertEquals(reload.current(), null, "finishing the current run clears it");
  assertEquals(reload.best(champion.id), 2);
  assertEquals(fin.score, scoreOf({ ...dead, alive: false }));
  assertEquals(reload.best("nobody"), 0);
  // a worse later run does not lower the record; finishing twice does not duplicate
  const short = recordRound(startRun(champion, "p1", 2, NOW + 1), lose);
  reload.finish(short, NOW + 70_000);
  reload.finish(short, NOW + 70_001);
  assertEquals(reload.best(champion.id), 2);
  const again = new GauntletStore(st, "p1");
  assertEquals(again.recent().length, 2);
  assertEquals(again.leaderboard()[0].id, dead.id, "leaderboard ranks by streak");
  assertEquals(again.bests()[0].name, champion.name);
  // setCurrent with a dead run archives it
  const other = recordRound(startRun(champion, "p1", 3, NOW + 2), lose);
  again.setCurrent(other, NOW + 80_000);
  assertEquals(again.current(), null);
  assertEquals(again.recent()[0].id, other.id);
  for (let i = 0; i < FINISHED_KEPT + 5; i++) again.finish(abandonRun(startRun(champion, "p1", 100 + i, NOW + i)), NOW + 90_000 + i);
  assertEquals(new GauntletStore(st, "p1").recent().length, FINISHED_KEPT, "last runs are capped");
  // profiles are separate keys
  assertEquals(new GauntletStore(st, "p2").current(), null);
});

Deno.test("gauntlet store: corrupt or foreign JSON fails closed to an empty state", () => {
  const empty = JSON.stringify(emptyGauntletState());
  for (const raw of ["{not json", "null", "[]", "42", JSON.stringify({ kind: "genemon.gauntlet", version: 2, current: null, best: {}, finished: [] }),
    JSON.stringify({ kind: "genemon.gauntlet", version: 1, current: { id: "x" }, best: {}, finished: [] }),
    JSON.stringify({ kind: "genemon.gauntlet", version: 1, current: null, best: { a: { streak: "9" } }, finished: [] }),
    JSON.stringify({ kind: "genemon.gauntlet", version: 1, current: { ...startRun(champion, "p1", 1, NOW), hpCarry: 3 }, best: {}, finished: [] })]) {
    assertEquals(JSON.stringify(parseGauntletState(raw)), empty, raw.slice(0, 60));
    const st = memStorage();
    st.setItem(gauntletKey("p1"), raw);
    const store = new GauntletStore(st, "p1");
    assertEquals(store.current(), null);
    assertEquals(store.recent().length, 0);
  }
  assertEquals(JSON.stringify(parseGauntletState(null)), empty);
});
