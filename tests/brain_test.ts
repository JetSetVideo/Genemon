// deno-lint-ignore-file no-explicit-any
/**
 * Pass 5 battle-brain lane [P5-A1, P5-B1, P5-B2]: the neural-shaped decision tree, perception
 * (facing, field of view, hearing), blind-side attacks, fewer powers (one rider per move, a status
 * cap, fewer zones), the battle tempo, and determinism.
 */
import { assert, assertAlmostEquals, assertEquals } from "./_assert.ts";
import {
  activations,
  BRAIN_WEIGHTS,
  type BrainFeatures,
  type BrainPsyche,
  defaultPerception,
  FEATURES,
  inFov,
  type Intent,
  INTENTS,
  moveBias,
  type MoveTraits,
  pickIntent,
  think,
} from "../src/combat/brain.ts";
import { Battle, MAX_TIME, MAX_ZONES, STATUS_CAP, TEMPO } from "../src/combat/battle.ts";
import { ALL_MOVE_BY_ID, ALL_MOVES } from "../src/combat/kit.ts";
import { MOVE_BY_ID, PROC_SCALE, secondaryEffects } from "../src/combat/moves.ts";
import { arenaSpec } from "../src/combat/scenario.ts";
import { autoTeam, type Team } from "../src/combat/team.ts";
import { isValidEvent, Ledger } from "../src/core/ledger.ts";
import { hashSeed, Rng } from "../src/core/rng.ts";
import { createGenemon, phenotypeOf } from "../src/genome/genemon.ts";
import { ARENA_KINDS } from "../src/world/arena.ts";

// ------------------------------------------------------------------ helpers
const BASE: BrainFeatures = {
  hp: 0.8,
  energy: 0.6,
  close: 0,
  mid: 1,
  far: 0,
  threat: 0,
  enemyResting: 0,
  enemyFacingMe: 0.5,
  seen: 1,
  allies: 0,
  alone: 0,
  typeAdv: 0,
  targetLow: 0.2,
  ranged: 0.5,
  canGuard: 0,
  canInterrupt: 0,
  temper: 0.5,
  wisdom: 0.5,
  fear: 0.2,
};
const PSY: BrainPsyche = { temper: 0.5, wisdom: 0.5, fear: 0.2, reach: 0.5, sociality: 0.5 };
const feat = (over: Partial<BrainFeatures>): BrainFeatures => ({ ...BASE, ...over });
const intentOf = (over: Partial<BrainFeatures>, psy: Partial<BrainPsyche> = {}) =>
  think(feat(over), { ...PSY, ...psy }, new Rng(1)).intent;

function team(owner: string, n: number, seed: number, bias: Record<string, unknown> = {}): Team {
  return {
    id: owner,
    owner,
    name: owner,
    members: Array.from(
      { length: n },
      (_, i) =>
        createGenemon({
          seed: hashSeed(seed, owner, i),
          owner,
          level: 25,
          bias: { kind: "quadruped", axes: { stature: -0.2 }, ...bias },
        }),
    ),
  };
}
function randomTeams(seed: number): [Team, Team] {
  const pool = Array.from(
    { length: 14 },
    (_, i) => createGenemon({ seed: hashSeed("brain", seed, i), level: 20 }),
  );
  return [autoTeam(pool.slice(0, 7), "A", seed), autoTeam(pool.slice(7), "B", seed + 1)];
}
const duel = (seed = 3, extra: Record<string, unknown> = {}) =>
  new Battle({
    seed,
    arena: { seed, kind: "meadow", weather: "clear", hour: 13 },
    teams: [team("a", 1, seed), team("b", 1, seed + 1)],
    ...extra,
  });

// ------------------------------------------------------------------ the model
Deno.test("[P5-B1] brain: 19 named features -> 8 named neurons with weights only on known features; activations in (0,1)", () => {
  assertEquals(INTENTS.length, 8);
  for (const id of INTENTS) {
    for (const k of Object.keys(BRAIN_WEIGHTS[id].w)) {
      assert((FEATURES as readonly string[]).includes(k), `${id} weighs unknown feature ${k}`);
    }
  }
  const a = activations(BASE, PSY);
  for (const id of INTENTS) assert(a[id] > 0 && a[id] < 1, `${id} ${a[id]}`);
});

Deno.test("[P5-B1] brain: every intent is reachable from a state that should trigger it", () => {
  const cases: [Intent, Partial<BrainFeatures>, Partial<BrainPsyche>][] = [
    ["aggress", {
      hp: 1,
      energy: 1,
      typeAdv: 1,
      enemyResting: 1,
      temper: 0.9,
      fear: 0,
      enemyFacingMe: 0.1,
      ranged: 0.3,
    }, { temper: 0.9, fear: 0 }],
    ["kite", { ranged: 1, close: 1, mid: 0, temper: 0.1, hp: 0.6, enemyFacingMe: 1 }, {
      temper: 0.1,
      reach: 1,
    }],
    ["flank", { enemyFacingMe: 1, ranged: 0, allies: 1, wisdom: 1, fear: 0, mid: 1, hp: 0.6, temper: 0.3 }, {
      wisdom: 1,
      temper: 0.3,
      fear: 0,
    }],
    ["guard", { threat: 1, canGuard: 1, hp: 0.4, wisdom: 0.8, temper: 0.1, ranged: 0.3, canInterrupt: 0 }, {
      wisdom: 0.8,
      temper: 0.1,
    }],
    ["interrupt", { threat: 1, canInterrupt: 1, wisdom: 1, energy: 1, canGuard: 0, hp: 0.9 }, { wisdom: 1 }],
    ["finish", {
      targetLow: 1,
      temper: 0.4,
      energy: 1,
      typeAdv: 0,
      hp: 0.5,
      fear: 0.2,
      enemyFacingMe: 0.2,
      ranged: 0.3,
    }, { temper: 0.4 }],
    ["retreat", { hp: 0.05, fear: 1, temper: 0, seen: 1 }, { fear: 1, temper: 0 }],
    ["regroup", { alone: 1, hp: 0.5, fear: 0.4, temper: 0.1, enemyFacingMe: 0.3, ranged: 0.4 }, {
      sociality: 1,
      temper: 0.1,
    }],
  ];
  for (const [want, f, p] of cases) {
    const got = intentOf(f, p);
    assertEquals(
      got,
      want,
      `state ${JSON.stringify(f)}: ${JSON.stringify(think(feat(f), { ...PSY, ...p }, new Rng(1)).neurons)}`,
    );
  }
});

Deno.test("[P5-B1] brain: the psyche shapes the weights (wild -> aggress, fearful -> retreat, wise -> flank)", () => {
  const x = feat({ hp: 0.35, fear: 0.5 });
  const calm = activations(x, { ...PSY, temper: 0 }), wild = activations(x, { ...PSY, temper: 1 });
  assert(wild.aggress > calm.aggress && wild.retreat < calm.retreat, "temper raises aggress, lowers retreat");
  const brave = activations(x, { ...PSY, fear: 0 }), scared = activations(x, { ...PSY, fear: 1 });
  assert(scared.retreat > brave.retreat, "fear amplifies retreat");
  const naive = activations(feat({ enemyFacingMe: 1, ranged: 0 }), { ...PSY, wisdom: 0 }),
    wise = activations(feat({ enemyFacingMe: 1, ranged: 0 }), { ...PSY, wisdom: 1 });
  assert(wise.flank > naive.flank, "wisdom amplifies flank");
});

Deno.test("[P5-B1] brain: argmax output, stickiness, and the Rng is consumed only on an exact tie", () => {
  const flat = Object.fromEntries(INTENTS.map((i) => [i, 0.5])) as Record<Intent, number>;
  const picks = new Set<Intent>();
  for (let s = 0; s < 40; s++) picks.add(pickIntent(flat, new Rng(s)));
  assert(picks.size >= 4, `an 8-way tie is broken by the Rng (${[...picks].join(",")})`);
  assertEquals(pickIntent({ ...flat, kite: 0.52 }, new Rng(1)), "kite", "argmax");
  assertEquals(
    pickIntent({ ...flat, kite: 0.52 }, new Rng(1), "guard"),
    "guard",
    "stickiness keeps a near-equal current intent",
  );
  assertEquals(
    pickIntent({ ...flat, kite: 0.6 }, new Rng(1), "guard"),
    "kite",
    "a clear winner overrides stickiness",
  );
  const r = new Rng(77), ref = new Rng(77);
  think(BASE, PSY, r);
  assertEquals(r.next(), ref.next(), "no tie -> the fighter's random stream is untouched");
  // Determinism of the pass itself.
  assertEquals(JSON.stringify(think(BASE, PSY, new Rng(5))), JSON.stringify(think(BASE, PSY, new Rng(5))));
});

Deno.test("[P5-B1] intent biases are bounded and point the right way", () => {
  const ranged: MoveTraits = {
    damaging: true,
    ranged: true,
    close: false,
    interrupt: false,
    protect: false,
    heal: false,
    power: 50,
    charge: 1,
  };
  const melee: MoveTraits = { ...ranged, ranged: false, close: true };
  const stun: MoveTraits = { ...melee, interrupt: true, power: 30, charge: 0.6 };
  assert(moveBias("kite", ranged) > 1 && moveBias("kite", melee) < 1, "kite prefers range");
  assert(moveBias("retreat", melee) < 1, "retreat avoids contact");
  assert(moveBias("interrupt", stun) > moveBias("interrupt", melee), "interrupt prefers stuns");
  for (const i of INTENTS) {
    for (const m of [ranged, melee, stun]) {
      assert(moveBias(i, m) >= 0.55 && moveBias(i, m) <= 1.7, `${i} bias bounded`);
    }
  }
});

// ------------------------------------------------------------------ perception [P5-B2]
Deno.test("[P5-B2] defaultPerception: big eyes see further but narrower, big ears hear further, blobs see all around", () => {
  const ph = phenotypeOf(createGenemon({ seed: 11, level: 20, bias: { kind: "quadruped" } }));
  const big = defaultPerception({ ...ph, plan: { ...ph.plan, eyes: 1, ears: 1 } }),
    small = defaultPerception({ ...ph, plan: { ...ph.plan, eyes: 0, ears: 0 } });
  assert(
    big.visionRange > small.visionRange && big.fovHalf < small.fovHalf,
    `eyes trade range for width ${JSON.stringify([big, small])}`,
  );
  assert(big.hearingRange > small.hearingRange, "ears");
  assertEquals(defaultPerception({ ...ph, kind: "blob" }).fovHalf, Math.PI);
  assert(inFov(0, 1, 0, 0, 0, 5) && !inFov(0, 1, 0, 0, 0, -5), "yaw 0 looks along +z");
});

Deno.test("[P5-B2] a fighter sees what is in front, not behind; hears behind only within range; a provider plugs in", () => {
  const prov = () => ({ visionRange: 12, fovHalf: 1.2, hearingRange: 3 });
  const b = duel(4, { perception: prov });
  const [f, e] = b.fighters;
  assertEquals(f.perception, prov(), "setup.perception is used");
  f.body.pos = { x: 0, y: f.body.pos.y, z: 0 };
  f.body.yaw = 0;
  e.body.pos = { x: 0, y: e.body.pos.y, z: 6 };
  e.body.vel = { x: 0, y: 0, z: 0 };
  assert(b.canSee(f, e), "in front, 6 m: seen");
  e.body.pos = { x: 0, y: e.body.pos.y, z: -6 };
  assert(!b.canSee(f, e) && !b.canHear(f, e), "behind, 6 m, beyond hearing: unperceived");
  e.body.pos = { x: 0, y: e.body.pos.y, z: -2 };
  assert(!b.canSee(f, e) && b.canHear(f, e), "behind, 2 m: heard, not seen");
  f.known.clear();
  e.body.pos = { x: 0, y: e.body.pos.y, z: -6 };
  (b as any).perceive();
  assert(!b.knows(f, e) && !f.sees.includes(e.idx), "an unseen, unheard enemy is not known");
});

Deno.test("[P5-B2] an unseen and unheard enemy is rarely targeted", () => {
  // f (side a) against two identical enemies at the same distance: one in front, one behind out of hearing.
  let known = 0, unknown = 0;
  for (let s = 0; s < 40; s++) {
    const t2 = team("b", 1, 99);
    const twin = { ...t2.members[0], id: t2.members[0].id + "-twin" };
    const b = new Battle({
      seed: s,
      arena: { seed: 1, kind: "meadow", weather: "clear", hour: 13 },
      teams: [team("a", 1, 98), { ...t2, members: [t2.members[0], twin] }],
      perception: () => ({ visionRange: 14, fovHalf: 1.2, hearingRange: 2 }),
    });
    const [f, e1, e2] = b.fighters;
    f.body.pos = { x: 0, y: 0, z: 0 };
    f.body.yaw = 0;
    e1.body.pos = { x: 0, y: 0, z: 5 };
    e2.body.pos = { x: 0, y: 0, z: -5 };
    for (const o of [e1, e2]) o.body.vel = { x: 0, y: 0, z: 0 };
    f.known.clear();
    (b as any).perceive();
    f.energy = f.stats.energy;
    (b as any).decide(f);
    if (f.target === e1.idx) known++;
    else if (f.target === e2.idx) unknown++;
  }
  assert(known + unknown >= 20, `decisions made ${known + unknown}`);
  assert(known >= 3 * unknown, `the perceived enemy is the usual target (${known} vs ${unknown})`);
});

Deno.test("[P5-B2] an attack from the blind side lands more often, crits more, and the victim turns to face it", () => {
  const b = duel(6);
  const [f, t] = b.fighters;
  const m = MOVE_BY_ID["tackle"];
  f.body.pos = { x: 0, y: 0, z: 0 };
  t.body.pos = { x: 0, y: 0, z: 1.5 };
  f.body.yaw = 0;
  t.body.yaw = Math.PI; // facing f
  const front = (b as any).hitChance(f, t, m);
  t.body.yaw = 0; // looking away
  assert(b.blindSide(t, f), "f is behind t");
  const behind = (b as any).hitChance(f, t, m);
  assert(behind > front, `blind-side hit chance ${behind} > front ${front}`);
  t.known.clear();
  (b as any).hit(f, t, m, 1, "test", t.body.pos);
  assert(t.turnTo?.idx === f.idx && b.knows(t, f), "the victim knows the attacker and turns to it");
  assert(
    b.events.some((e) => e.type === "flank" && e.a === f.idx && e.b === t.idx) || t.tally.taken === 0,
    "a landed blind-side hit emits a flank event",
  );
  // After a few ticks of turning, t faces f more than before.
  const before = Math.abs(t.body.yaw - Math.PI);
  for (let i = 0; i < 10; i++) b.step();
  assert(
    b.winner !== null ||
      Math.abs(Math.atan2(Math.sin(t.body.yaw - Math.PI), Math.cos(t.body.yaw - Math.PI))) < before,
    "t turned toward f",
  );
});

// ------------------------------------------------------------------ fewer powers [P5-B1]
Deno.test("[P5-B1] one secondary effect per move; target riders proc at PROC_SCALE except interrupts", () => {
  for (const m of ALL_MOVES) {
    assert(secondaryEffects(m).length <= 1, `${m.id} has ${secondaryEffects(m).length} riders`);
  }
  assertEquals(
    MOVE_BY_ID.tideSlam.effects.find((e) => e.status === "wet")?.chance,
    Math.round(0.6 * PROC_SCALE * 100) / 100,
    "a soft rider is scaled",
  );
  assertEquals(ALL_MOVE_BY_ID.headbutt.effects[0].chance, 0.5, "an interrupt keeps its odds");
  assertEquals(ALL_MOVE_BY_ID.mindLock.effects[0].chance, 0.55, "an interrupt keeps its odds");
});

Deno.test("[P5-B1] at most STATUS_CAP harmful statuses: the newest replaces the oldest; wet does not count", () => {
  const b = duel(8);
  const t = b.fighters[1], f = b.fighters[0];
  t.types = ["neutral"];
  for (const s of ["burn", "poisoned", "slowed"] as const) (b as any).addStatus(t, s, 3, f);
  (b as any).addStatus(t, "wet", 3, f);
  const harmful = [...t.status.keys()].filter((k) => k !== "wet");
  assertEquals(harmful.length, STATUS_CAP, `statuses ${[...t.status.keys()]}`);
  assert(
    !t.status.has("burn") && t.status.has("slowed") && t.status.has("wet"),
    "oldest (burn) replaced; wet kept",
  );
  // Tenacity still applies on top: a harmful status lasts 1 / (1 + 0.2 (slots - 1)) on a big body.
  assertAlmostEquals(
    t.status.get("wet")!,
    (3 * TEMPO) / (1 + 0.2 * (t.ph.slots - 1)),
    1e-9,
    "status durations run at the battle tempo",
  );
});

Deno.test("[P5-B1] zones: at most MAX_ZONES alive, a control zone is a snap (no field)", () => {
  const b = duel(9);
  const f = b.fighters[0];
  for (let i = 0; i < MAX_ZONES + 3; i++) {
    (b as any).spawnZone(
      "field",
      "fire",
      { x: i * 3 - 8, y: 0, z: 0 },
      1.5,
      10,
      f,
      ALL_MOVE_BY_ID.scorchField,
    );
  }
  assert(
    b.zones.filter((z) => z.ttl > 0).length <= MAX_ZONES,
    `alive ${b.zones.filter((z) => z.ttl > 0).length}`,
  );
  const c = duel(10);
  const [g, t] = c.fighters;
  g.move = ALL_MOVE_BY_ID.whirlpool;
  g.target = t.idx;
  const n0 = c.zones.length;
  (c as any).strike(g);
  assertEquals(c.zones.length, n0, "whirlpool (stun rider) leaves no field");
});

// ------------------------------------------------------------------ battle integration
Deno.test("[P5-A1] tempo: a charge lasts charge x TEMPO / rate", () => {
  const b = duel(12);
  const f = b.fighters[0];
  const m = ALL_MOVE_BY_ID.slice;
  f.moves = [m];
  f.costs = [0];
  (b as any).startMove(f, m, 1);
  assertAlmostEquals(f.phaseDur, (m.charge * TEMPO) / f.stats.rate, 1e-9);
});

Deno.test("[P5-B1] battle: fighters carry a brain; decide rows log the intent as flat scalars", () => {
  const [A, B] = randomTeams(5);
  const ledger = new Ledger("brain");
  const b = new Battle({ seed: 5, arena: arenaSpec("meadow", 5), teams: [A, B], ledger });
  b.run();
  const rows = ledger.query({ what: "battle.decide" });
  assert(rows.length > 10, `decide rows ${rows.length}`);
  const seen = new Set<string>();
  for (const r of rows) {
    assert(isValidEvent(r), "flat row");
    assert((INTENTS as readonly string[]).includes(String(r.exits.intent)), `intent ${r.exits.intent}`);
    assert(typeof r.exits.drive === "number" && typeof r.entries.perceived === "number", "drive + perceived");
    seen.add(String(r.exits.intent));
  }
  assert(seen.size >= 3, `only ${[...seen]} intents in a 7 v 7`);
  for (const f of b.fighters.filter((x) => x.brain)) {
    for (const i of INTENTS) {
      assert(f.brain!.neurons[i] >= 0 && f.brain!.neurons[i] <= 1, "neurons in [0,1]");
    }
  }
});

Deno.test("[P5-A1][P5-B1] determinism: same seed + teams = same battle (events, intents, result)", () => {
  for (const s of [2, 7]) {
    const run = () => {
      const [A, B] = randomTeams(s);
      const b = new Battle({
        seed: s,
        arena: arenaSpec(ARENA_KINDS[s % ARENA_KINDS.length], s),
        teams: [A, B],
      });
      const intents: string[] = [];
      while (b.winner === null) {
        b.step();
        if (b.tick % 15 === 0) intents.push(b.fighters.map((f) => f.brain?.intent ?? "-").join(""));
      }
      return JSON.stringify({
        r: b.result(),
        intents,
        ev: b.events.map((e) => [e.type, e.a, e.b, e.label, e.value]),
      });
    };
    assertEquals(run(), run(), `seed ${s}`);
  }
});

Deno.test("[P5-A1] pace: random 7 v 7 battles last ~40-55 s at the median, no timeouts", () => {
  const d: number[] = [];
  let timeouts = 0;
  for (let s = 0; s < 24; s++) {
    const [A, B] = randomTeams(100 + s);
    const r = new Battle({ seed: s, arena: arenaSpec(ARENA_KINDS[s % ARENA_KINDS.length], s), teams: [A, B] })
      .run();
    d.push(r.duration);
    if (r.reason === "timeout") timeouts++;
  }
  d.sort((a, b) => a - b);
  const med = d[Math.floor(d.length / 2)];
  assert(med >= 33 && med <= 62, `median ${med.toFixed(1)} s`);
  assert(
    timeouts === 0 && d[d.length - 1] < MAX_TIME,
    `timeouts ${timeouts}, max ${d[d.length - 1].toFixed(1)} s`,
  );
});
