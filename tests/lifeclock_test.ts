import { assert, assertAlmostEquals, assertEquals } from "./_assert.ts";
import { isValidEvent, Ledger } from "../src/core/ledger.ts";
import { createGenemon, type Genemon, phenotypeOf } from "../src/genome/genemon.ts";
import { eat } from "../src/genome/digestion.ts";
import { LIFE_PHASES } from "../src/genome/lifeTypes.ts";
import {
  addScar,
  canRank,
  circadian,
  DAY_MS,
  evolutionPath,
  lifeOf,
  lifePhase,
  MAX_SCARS,
  newLifeState,
  phaseDays,
  scarFromHit,
  tickLife,
} from "../src/genome/lifeclock.ts";

const mk = (seed = 8, ageDays?: number, level = 20): Genemon => createGenemon({ seed, level, ageDays });
const clone = (g: Genemon): Genemon => JSON.parse(JSON.stringify(g));

Deno.test("lifeclock: phases run egg -> ancient monotonically with age; phaseDays strictly increase [P5-G5]", () => {
  const g = mk(8, 0);
  const days = phaseDays(g);
  for (let i = 1; i < LIFE_PHASES.length; i++) {
    assert(
      days[LIFE_PHASES[i]] > days[LIFE_PHASES[i - 1]],
      `phase ${LIFE_PHASES[i]} after ${LIFE_PHASES[i - 1]}`,
    );
  }
  assertEquals(lifePhase(g), "egg");
  let last = 0;
  for (const age of [0, 0.5, 2, 10, 40, 80, 200, 400, 900]) {
    g.conditions.ageDays = age;
    const i = LIFE_PHASES.indexOf(lifePhase(g));
    assert(i >= last, `phase never goes back (age ${age})`);
    last = i;
  }
  assertEquals(lifePhase(g), "ancient");
  // Over many genomes, ageing (which lowers tempo and changes the size class) and hunger never
  // move a creature back a phase.
  for (let seed = 1; seed <= 15; seed++) {
    const h = mk(seed, 0, 1);
    let prev = 0;
    for (let age = 0; age <= 900; age += 7.5) {
      h.conditions.ageDays = age;
      h.conditions.hunger = (age / 7.5) % 2 === 0 ? 0 : 1;
      const i = LIFE_PHASES.indexOf(lifePhase(h));
      assert(i >= prev, `seed ${seed}: phase went back at day ${age}`);
      prev = i;
    }
    assertEquals(lifePhase(h), "ancient", `seed ${seed} ends ancient`);
  }
});

Deno.test("lifeclock: big bodies live longer than tiny ones", () => {
  const big = createGenemon({
    seed: 31,
    level: 30,
    bias: { axes: { stature: 1, weight: 0.6, tempo: 0 }, spread: 0.05 },
  });
  const tiny = createGenemon({
    seed: 31,
    level: 30,
    bias: { axes: { stature: -1, weight: -0.4, tempo: 0 }, spread: 0.05 },
  });
  const sb = phenotypeOf(big).sizeClass, st = phenotypeOf(tiny).sizeClass;
  assert(sb !== st, `fixtures differ in size class (${sb} vs ${st})`);
  assert(
    phaseDays(big).elder > phaseDays(tiny).elder,
    `elder day ${phaseDays(tiny).elder} (${st}) < ${phaseDays(big).elder} (${sb})`,
  );
});

Deno.test("lifeclock: tickLife ages by elapsed x timeScale, caps a catch-up at 30 days, one ledger row per tick", () => {
  const ledger = new Ledger("t");
  const a = mk(8, 12), b = clone(a);
  a.life = newLifeState(a, 0);
  b.life = newLifeState(b, 0);
  const tenMin = 10 * 60_000;
  const ra = tickLife(a, tenMin, { hour: 12, altitudeM: 0, ledger });
  const rb = tickLife(b, tenMin, { hour: 12, altitudeM: 0, timeScale: 1440, ledger });
  assertAlmostEquals(ra.elapsedDays, tenMin / DAY_MS, 1e-3, "real time");
  assertAlmostEquals(rb.elapsedDays, 10, 1e-3, "a day per minute");
  assertAlmostEquals(
    b.conditions.ageDays - a.conditions.ageDays,
    10 - tenMin / DAY_MS,
    0.01,
    "timeScale accelerates ageing",
  );
  assertEquals(ledger.query({ what: "genemon.life" }).length, 2, "one row per tick");
  for (const row of ledger.rows()) assert(isValidEvent(row), "flat valid row");
  const row = ledger.query({ what: "genemon.life" })[1];
  assertEquals(row.to, b.id);
  assertEquals(row.exits.ageDays, b.conditions.ageDays);
  const c = mk(8, 12);
  c.life = newLifeState(c, 0);
  const rc = tickLife(c, 100 * DAY_MS, { hour: 12, altitudeM: 0 });
  assertAlmostEquals(rc.elapsedDays, 30, 1e-9, "capped");
  assertEquals(c.life!.lastTick, 100 * DAY_MS, "re-anchored on real time");
  assert(rc.phaseAfter !== rc.phaseBefore || c.conditions.ageDays > 40, "a month changes the creature");
});

Deno.test("lifeclock: the long loop digests into conditions.diet and raises hunger without food", () => {
  const g = mk(8, 20);
  g.life = newLifeState(g, 0);
  const ph = phenotypeOf(g);
  const r = eat(g.life, "berries", 2, 0, ph);
  assert(r.ok);
  const before = g.conditions.diet.berries ?? 0;
  const rep = tickLife(g, DAY_MS, { hour: 12, altitudeM: 0 });
  assert(rep.absorbed.berries > 0, "absorbed");
  assertAlmostEquals(
    (g.conditions.diet.berries ?? 0) - before,
    rep.absorbed.berries,
    0.002,
    "caller-side diet updated",
  );
  assertEquals(g.life.digestion.stomach.length, 0, "digested in a day");
  const h = mk(8, 20);
  h.life = newLifeState(h, 0);
  h.conditions.hunger = 0.1;
  tickLife(h, DAY_MS, { hour: 12, altitudeM: 0 });
  assert(h.conditions.hunger > 0.25, `hunger rises: ${h.conditions.hunger}`);
});

Deno.test("lifeclock: tickLife is deterministic and lifeOf does not mutate", () => {
  const a = mk(15, 25);
  assertEquals(a.life, undefined);
  const l = lifeOf(a, 5);
  assertEquals(a.life, undefined, "lifeOf is read-only");
  assertEquals(l.lastTick, 5);
  const b = clone(a);
  for (const g of [a, b]) {
    g.life = newLifeState(g, 0);
    eat(g.life, "meat", 1, 0, phenotypeOf(g));
    tickLife(g, 3 * 3_600_000, { hour: 22, altitudeM: 2000, timeScale: 60 });
    tickLife(g, 6 * 3_600_000, { hour: 8, altitudeM: 2000, timeScale: 60 });
  }
  assertEquals(JSON.stringify(a), JSON.stringify(b));
  assert(a.life!.altitudeM > 0, "acclimatising toward 2000 m");
});

Deno.test("lifeclock: circadian peaks at the chronotype, sleeps opposite, bands 0.8..1.15 [P5-G4]", () => {
  const g = mk(8, 40);
  const life = newLifeState(g, 0);
  life.altitudeM = 0;
  const peak = circadian(life, life.chronotype, 0, 40);
  const trough = circadian(life, life.chronotype + 12, 0, 40);
  assert(!peak.asleep && trough.asleep, "awake at peak, asleep 12 h away");
  assert(peak.fight > 1 && trough.fight < 1, "fight follows the rhythm");
  assert(peak.alertness > trough.alertness);
  for (const hour of [0, 3, 6, 9, 12, 15, 18, 21]) {
    for (const alt of [0, 1500, 4500, 8000]) {
      for (const age of [5, 60, 200, 500]) {
        const c = circadian(life, hour, alt, age);
        for (const k of ["fight", "production", "fertility"] as const) {
          assert(c[k] >= 0.8 && c[k] <= 1.15, `${k} ${c[k]}`);
        }
        assert(c.alertness >= 0 && c.alertness <= 1 && c.peakHour >= 0 && c.peakHour < 24);
      }
    }
  }
  // Altitude: earlier peak; far from the acclimatised altitude the breath costs fight.
  const high = circadian(life, life.chronotype, 3000, 40);
  const dh = ((peak.peakHour - high.peakHour) + 24) % 24;
  assert(dh > 1.5 && dh < 2.5, `3000 m shifts the peak ~2 h earlier (${dh})`);
  const accl = { ...life, altitudeM: 3000 };
  assert(
    circadian(accl, high.peakHour, 3000, 40).fight > circadian(life, high.peakHour, 3000, 40).fight,
    "acclimatised breathes better",
  );
  // Age: flatter rhythm and earlier sleep.
  const oldPeak = circadian(life, life.chronotype, 0, 450),
    oldTrough = circadian(life, life.chronotype + 12, 0, 450);
  assert(oldPeak.fight - oldTrough.fight < peak.fight - trough.fight, "elders: flatter");
  assert(oldPeak.peakHour !== peak.peakHour, "elders: earlier peak");
  assert(oldPeak.fertility < peak.fertility, "elders: lower fertility");
});

Deno.test("lifeclock: scars from heavy hits only, seeded; addScar caps; canRank retires ancients and scarred elders", () => {
  const g = mk(8, 40);
  assertEquals(scarFromHit(g, 0.2, "fire", "torso", 1), null, "light hit: no scar");
  let found = 0;
  for (let s = 0; s < 30; s++) {
    const a = scarFromHit(g, 0.7, "fire", "head", s), b = scarFromHit(g, 0.7, "fire", "head", s);
    assertEquals(JSON.stringify(a), JSON.stringify(b), "seeded");
    if (a) {
      found++;
      assert(a.severity > 0.7 && a.severity <= 1 && a.from === "fire" && a.part === "head");
    }
  }
  assert(found >= 20, `heavy hits usually scar (${found}/30)`);
  const light = scarFromHit(g, 0.3, "physical", "tail", 3) ?? scarFromHit(g, 0.3, "physical", "tail", 4)!;
  assert(light === null || light.severity < 0.3, "severity grows with the hit");
  for (let i = 0; i < MAX_SCARS + 5; i++) {
    addScar(g, {
      atDay: 40,
      part: "torso",
      severity: 0.1 + i * 0.01,
      from: "physical",
      side: 1,
      u: 0.5,
      angle: 0,
    });
  }
  assertEquals(g.life!.scars.length, MAX_SCARS, "capped");
  assert(g.life!.scars.every((s) => s.severity > 0.1), "drops the weakest");

  const young = mk(9, 40);
  assert(canRank(young).ok, `adult can rank: ${canRank(young).why}`);
  const egg = mk(9, 0);
  assert(!canRank(egg).ok, "egg cannot");
  const days = phaseDays(young);
  const elder = mk(9, (days.elder + days.ancient) / 2);
  assertEquals(lifePhase(elder), "elder");
  assert(canRank(elder).ok, "unscarred elder still ranks");
  for (let i = 0; i < 8; i++) {
    addScar(elder, {
      atDay: 1,
      part: "limb.l0",
      severity: 0.2,
      from: "physical",
      side: -1,
      u: 0.3,
      angle: 1,
    });
  }
  assert(!canRank(elder).ok && canRank(elder).why.includes("past its prime"), canRank(elder).why);
  const ancient = mk(9, days.ancient + 10);
  assertEquals(lifePhase(ancient), "ancient");
  assert(!canRank(ancient).ok, "ancient retired");
});

Deno.test("lifeclock: evolutionPath lists every phase with monotone cumulative costs and plain properties [P5-V1]", () => {
  const g = mk(8, 40);
  const path = evolutionPath(g);
  assertEquals(path.map((s) => s.phase).join(","), LIFE_PHASES.join(","));
  let cumDays = 0, cumXp = 0, cumBond = 0;
  path.forEach((s, i) => {
    assertEquals(s.stage, i);
    assert(s.properties.length >= 1, `${s.phase} has properties`);
    if (i > 0) {
      assert(s.cost.days > 0, `${s.phase} takes time`);
      assert(s.cost.days + cumDays > cumDays, "cumulative days increase");
    }
    assert(s.cost.xp >= 0 && s.cost.food >= 0 && s.cost.credits >= 0, "non-negative");
    assert(s.cost.bond >= cumBond, "bond requirement never drops");
    cumDays += s.cost.days;
    cumXp += s.cost.xp;
    cumBond = s.cost.bond;
  });
  assert(cumXp > 0, "xp costs exist");
  const reached = path.map((s) => s.reached);
  assert(reached[0] && !reached.slice(reached.indexOf(false)).some(Boolean), "reached is a prefix");
  assertEquals(path.filter((s) => s.reached).length, LIFE_PHASES.indexOf(lifePhase(g)) + 1);
  assert(path.find((s) => s.phase === "adult")!.properties.includes("eyes shrink to adult proportions"));
  assert(path.find((s) => s.phase === "elder")!.properties.includes("slower, wiser"));
  assert(path.find((s) => s.phase === "ancient")!.properties.some((p) => p.includes("cannot rank")));
  assert(
    path.find((s) => s.phase === "juvenile")!.properties.some((p) => /^\+\d+ % height$/.test(p)),
    "height gain in words",
  );
});
