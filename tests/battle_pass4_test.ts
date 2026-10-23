// deno-lint-ignore-file no-explicit-any
/** Pass-4 engine features: bench + switching, start HP, cone, dash, stun interrupts, physical/special. */
import { assert, assertAlmostEquals, assertEquals } from "./_assert.ts";
import { Battle, moveCategory, SWITCH_COOLDOWN, SWITCH_ENTRY } from "../src/combat/battle.ts";
import { MOVE_BY_ID, mv, st } from "../src/combat/moves.ts";
import { createGenemon, phenotypeOf } from "../src/genome/genemon.ts";
import { hashSeed } from "../src/core/rng.ts";
import type { Team } from "../src/combat/team.ts";

function team(owner: string, n: number, seed: number, level = 20): Team {
  return { id: owner, owner, name: owner, members: Array.from({ length: n }, (_, i) => createGenemon({ seed: hashSeed(seed, owner, i), owner, level, bias: { kind: "quadruped", axes: { stature: -0.3 } } })) };
}

function battle(field?: number, extra: Record<string, unknown> = {}) {
  return new Battle({ seed: 42, arena: { seed: 42, kind: "meadow", weather: "clear", hour: 13 }, teams: [team("a", 3, 1), team("b", 3, 2)], field, ...extra });
}

Deno.test("[P4-B2] field=1 puts one fighter per side on the field and the rest on the bench", () => {
  const b = battle(1);
  const live = b.fighters.filter((f) => !f.benched);
  assertEquals(live.length, 2, "on field");
  assertEquals(b.bench(0).length, 2, "bench A");
  assertEquals(b.bench(1).length, 2, "bench B");
  assertEquals(b.enemiesOf(b.fighters[0]).length, 1, "only the enemy on the field is targetable");
  // Brawl (no field) keeps the legacy format: everyone fights.
  assertEquals(battle().fighters.filter((f) => !f.benched).length, 6, "brawl");
});

Deno.test("[P4-B2] a KO'd fighter is replaced from the bench after the throw delay, and the switch is recorded", () => {
  const b = battle(1);
  const first = b.fighters.find((f) => f.team === 1 && !f.benched)!;
  first.hp = 0.0001;
  (b as any).knockOut(first, b.fighters[0]);
  const ticks = Math.ceil((SWITCH_ENTRY + 0.1) / b.dt);
  for (let i = 0; i < ticks; i++) b.step();
  const onField = b.fighters.filter((f) => f.team === 1 && !f.benched && !f.ko);
  assertEquals(onField.length, 1, "a replacement entered");
  const r = b.run();
  assert(r.switches.some((s) => s.team === 1 && s.out === first.idx), "switch recorded");
});

Deno.test("[P4-B2] manual switch swaps the fighters, keeps HP, and the cooldown blocks a second switch", () => {
  const b = battle(1, { aiSwitch: false });
  const out = b.fighters.find((f) => f.team === 0 && !f.benched)!;
  const inn = b.bench(0)[0];
  out.hp = out.maxHp * 0.4;
  assert(b.requestSwitch(0, out.idx, inn.idx).ok, "first switch accepted");
  b.step();
  assert(out.benched && !inn.benched, "swapped");
  assertAlmostEquals(out.hp / out.maxHp, 0.4, 1e-9, "HP kept on the bench");
  const again = b.requestSwitch(0, inn.idx, out.idx);
  assert(!again.ok && again.why.includes("switch ready"), `cooldown: ${again.why}`);
  for (let i = 0; i < Math.ceil(SWITCH_COOLDOWN / b.dt) + 1; i++) b.step();
  if (b.winner === null) assert(b.canSwitch(0, inn.idx, out.idx).ok || inn.ko || out.ko, "cooldown expires");
});

Deno.test("[P4-B2] a recorded battle replays identically from its switch script", () => {
  const a = battle(1);
  const ra = a.run();
  const b = battle(1, { script: ra.switches, aiSwitch: false });
  const rb = b.run();
  assertEquals(rb.winner, ra.winner, "winner");
  assertAlmostEquals(rb.duration, ra.duration, 1e-9, "duration");
  assertEquals(JSON.stringify(rb.switches), JSON.stringify(ra.switches), "switches");
});

Deno.test("[P4-B1] startHp starts a Genemon at the carried HP fraction", () => {
  const t = team("a", 1, 9);
  const b = new Battle({ seed: 1, arena: { seed: 1, kind: "meadow", weather: "clear", hour: 13 }, teams: [t, team("b", 1, 3)], startHp: { [t.members[0].id]: 0.35 } });
  assertAlmostEquals(b.fighters[0].hp / b.fighters[0].maxHp, 0.35, 1e-9, "carried");
});

Deno.test("[P4-M6] a stun landing on a charge interrupts it; a stun on an idle fighter does not", () => {
  const b = battle();
  const [f, e] = [b.fighters[0], b.fighters.find((x) => x.team === 1)!];
  const big = MOVE_BY_ID["solarBeam"];
  e.moves = [big];
  e.costs = [0];
  (b as any).startMove(e, big, f.idx);
  assertEquals(e.phase, "charge", "charging");
  (b as any).addStatus(e, "stunned", 1.2, f);
  assertEquals(e.phase, "idle", "interrupted");
  assertEquals(e.interrupted, 1, "counted");
  const idle = b.fighters.find((x) => x.team === 1 && x !== e)!;
  (b as any).addStatus(idle, "stunned", 1.2, f);
  assertEquals(idle.interrupted, 0, "idle not interrupted");
  // Stunned fighters neither act nor move.
  for (let i = 0; i < 10; i++) b.step();
  assertEquals(idle.phase, "idle", "stunned stays idle");
});

Deno.test("[P4-M2] a breath cone hits every enemy inside its arc and none behind the breather", () => {
  const b = battle();
  const f = b.fighters[0];
  const foes = b.fighters.filter((x) => x.team === 1);
  const cone = mv("testBreath", "Test Breath", "fire", "cone", 60, 1, 6, 0, 0, 0.5, 0.3, 0.5, [], 1, { category: "special", part: "mouth", arc: 0.5 });
  f.body.pos = { x: 0, y: f.body.pos.y, z: 0 };
  foes[0].body.pos = { x: 0, y: 0, z: 3 };
  foes[1].body.pos = { x: 0.6, y: 0, z: 4 };
  foes[2].body.pos = { x: 0, y: 0, z: -3 };
  f.move = cone;
  f.target = foes[0].idx;
  const before = foes.map((o) => o.hp);
  for (const o of b.fighters) (o.stats as any).evasion = 0;
  (f.stats as any).accuracy = 1;
  // Isolate the arc: no perception modifiers (keen senses read / overload, [P6-B1]) on this roll.
  (b as any).keen = () => 0;
  (b as any).strike(f);
  assert(foes[0].hp < before[0], "front target hit");
  assert(foes[1].hp < before[1], "second target inside the arc hit");
  assertEquals(foes[2].hp, before[2], "target behind untouched");
  assertEquals(moveCategory(cone), "special", "category");
});

Deno.test("[P4-M7] a dash carries the body toward its target and strikes on arrival", () => {
  const b = battle();
  const f = b.fighters[0], t = b.fighters.find((x) => x.team === 1)!;
  const dash = mv("testDash", "Test Dash", "neutral", "dash", 50, 1, 8, 0, 0, 0.3, 0.3, 0.4, [st("stunned", 1, 1)], 1, { category: "physical", part: "legs", slot: "mobility" });
  f.moves = [dash];
  f.costs = [0];
  f.body.pos = { x: -4, y: f.body.pos.y, z: 0 };
  t.body.pos = { x: 3, y: t.body.pos.y, z: 0 };
  const x0 = f.body.pos.x;
  // Isolate the dash: no perception modifiers (a keen target reads the wind-up, [P6-B1]) and no dodge.
  (b as any).keen = () => 0;
  for (const o of b.fighters) (o.stats as any).evasion = 0;
  (f.stats as any).accuracy = 1;
  (b as any).startMove(f, dash, t.idx);
  let hit = false;
  const hp0 = t.hp;
  for (let i = 0; i < 60 && !hit; i++) {
    b.step();
    hit = t.hp < hp0;
  }
  assert(f.body.pos.x > x0 + 3, `travelled ${f.body.pos.x - x0} m`);
  assert(hit, "struck on arrival");
  assertEquals(moveCategory(dash), "physical", "category");
  assertEquals(moveCategory(MOVE_BY_ID["tackle"]), "physical", "legacy contact = physical");
  assertEquals(moveCategory(MOVE_BY_ID["flameLance"]), "special", "legacy beam = special");
  assertEquals(moveCategory(MOVE_BY_ID["tailwind"]), "status", "legacy buff = status");
});

Deno.test("[P4-M1] the physical/special split is budget-neutral: geometric means are exactly 1", () => {
  for (let i = 0; i < 60; i++) {
    const ph = phenotypeOf(createGenemon({ seed: hashSeed("split", i), level: 10 }));
    assertAlmostEquals(ph.offense.physical * ph.offense.special, 1, 1e-12, "offense");
    assertAlmostEquals(ph.guard.physical * ph.guard.special, 1, 1e-12, "guard");
    assert(ph.offense.physical >= Math.exp(-0.3) - 1e-9 && ph.offense.physical <= Math.exp(0.3) + 1e-9, "bounded");
  }
  // A mighty heavy body leans physical; a wise focused one leans special.
  const brute = phenotypeOf(createGenemon({ seed: 5, bias: { axes: { might: 0.9, weight: 0.8, focus: -0.8, wisdom: -0.8 }, spread: 0.05 } }));
  const sage = phenotypeOf(createGenemon({ seed: 5, bias: { axes: { might: -0.8, weight: -0.6, focus: 0.9, wisdom: 0.9 }, spread: 0.05 } }));
  assert(brute.offense.physical > 1.1 && sage.offense.special > 1.1, `${brute.offense.physical} ${sage.offense.special}`);
});
