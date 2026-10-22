/**
 * Pure parts of the home-dex lane [P5-H1, P5-D1, P5-D2, P5-L1]: time-scale maths and the dev rules
 * (src/ui/devPanel.ts), the species key + research levels (src/ui/screens/dex.ts), the batch hatch
 * (src/ui/hatch.ts) and the platform graduations / layout (src/render/homeView.ts).
 * Run: deno test --no-check --allow-read tests/home_dex_test.ts
 */
import { assert, assertAlmostEquals, assertEquals } from "./_assert.ts";
import { createGenemon, phenotypeOf } from "../src/genome/genemon.ts";
import { BODY_KINDS } from "../src/genome/genome.ts";
import { ELEMENT_IDS } from "../src/data/elements.ts";
import { HYBRIDS } from "../src/data/hybrids.ts";
import {
  advanceHourOffset,
  catchUpFrom,
  clampScale,
  DAY_MS,
  devOf,
  fmtHour,
  gameDays,
  MAX_CATCHUP_DAYS,
  perRealMinute,
  scaledMs,
  scaleLabel,
  TIME_SCALES,
  topUpCredits,
  UNLIMITED_CREDITS,
} from "../src/ui/devPanel.ts";
import {
  allSpecies,
  bestFoodsFor,
  type DexMemory,
  noteSeen,
  rememberBest,
  RESEARCH_STEPS,
  researchOf,
  researchPoints,
  speciesKey,
  speciesOf,
  tallySpecies,
} from "../src/ui/screens/dex.ts";
import { hatchMany } from "../src/ui/hatch.ts";
import { fmtM, lerpAngle, placeAround, platformRadius, poleTicks, ringStep, rulerTicks, standRadius, wrapAngle } from "../src/render/homeView.ts";

// ---------------------------------------------------------------- time scale (P5-D1, P5-L1)
Deno.test("the four demo time scales: 1 min of real time = 1 min / 1 h / 1 day / 1 week", () => {
  assertEquals([...TIME_SCALES], [1, 60, 1440, 10080]);
  assertEquals(TIME_SCALES.map(perRealMinute), ["1 min", "1 h", "1 day", "1 week"]);
  assertAlmostEquals(gameDays(60_000, 1440), 1, 1e-12);
  assertAlmostEquals(gameDays(60_000, 10080), 7, 1e-12);
  assertAlmostEquals(gameDays(5_000, 60), 300_000 / DAY_MS, 1e-15);
  assertEquals(scaledMs(-5, 60), 0, "negative elapsed time never runs the clock backwards");
  assertEquals(scaleLabel(1), "1x · real time");
  assertEquals(scaleLabel(1440), "1440x · 1 min = 1 day");
});

Deno.test("bad time scales fall back to real time; huge ones are capped", () => {
  for (const bad of [0, -3, NaN, Infinity, 0.5]) assertEquals(clampScale(bad), 1, `scale ${bad}`);
  assertEquals(clampScale(1e9), 100800);
  assertEquals(devOf({}).timeScale, 1);
  assertEquals(devOf({ dev: { timeScale: -1, unlimitedCredits: true, noFoodLimit: false } }), { timeScale: 1, unlimitedCredits: true, noFoodLimit: false });
});

Deno.test("unlimited credits tops up to 1e9 and never lowers a balance; off = untouched", () => {
  const on = { timeScale: 1, unlimitedCredits: true, noFoodLimit: false };
  assertEquals(topUpCredits(12, on), UNLIMITED_CREDITS);
  assertEquals(topUpCredits(5e9, on), 5e9);
  assertEquals(topUpCredits(12, { ...on, unlimitedCredits: false }), 12);
});

Deno.test("offline catch-up starts at most 30 days back and never in the future", () => {
  const now = 1_800_000_000_000;
  assertEquals(catchUpFrom(now - 2 * DAY_MS, now), now - 2 * DAY_MS);
  assertEquals(catchUpFrom(now - 400 * DAY_MS, now), now - MAX_CATCHUP_DAYS * DAY_MS);
  assertEquals(catchUpFrom(now + DAY_MS, now), now);
  assertEquals(catchUpFrom(NaN, now), now);
});

Deno.test("demo clock: the creatures' hour runs (scale - 1)x ahead, wraps at 24 and resets at 1x", () => {
  assertAlmostEquals(advanceHourOffset(0, 60_000, 60), 59 / 60, 1e-12); // 1 real min at 60x = +59 min lead
  assertAlmostEquals(advanceHourOffset(23, 3_600_000, 2), 0, 1e-9); // 23 + 1 = 24 -> 0
  assertEquals(advanceHourOffset(5, 60_000, 1), 0);
  const h = advanceHourOffset(0, 60_000, 1440);
  assert(h >= 0 && h < 24, `hour ${h}`);
  assertEquals(fmtHour(13.5), "13:30");
  assertEquals(fmtHour(-1), "23:00");
});

// ---------------------------------------------------------------- species + research (P5-D2)
Deno.test("species key = body plan x elemental identity; the Dex holds 6 x (14 + hybrids) entries", () => {
  const all = allSpecies();
  assertEquals(all.length, BODY_KINDS.length * (ELEMENT_IDS.length + HYBRIDS.length));
  assertEquals(new Set(all.map((s) => s.key)).size, all.length, "keys are unique");
  for (let i = 0; i < 60; i++) {
    const ph = phenotypeOf(createGenemon({ seed: 1000 + i * 37, owner: "t", level: 10 }));
    const sp = speciesOf(ph);
    assertEquals(sp.kind, ph.kind);
    assertEquals(sp.key, speciesKey(ph.kind, sp.identity));
    assert(all.some((x) => x.key === sp.key), `species ${sp.key} is in the Dex`);
    if (!sp.hybrid) assert(sp.identity === ph.elements.primary, "a non-hybrid species is its primary element");
    else assert(sp.parents !== null, "a hybrid species knows its parents");
  }
});

Deno.test("research: unseen -> seen -> owned (1) -> developed (2..5), monotone in owning / feeding / battling", () => {
  const z = { owned: 0, fed: 0, battles: 0, seen: false };
  assertEquals(researchOf(z).state, "unseen");
  assertEquals(researchOf({ ...z, seen: true }).state, "seen");
  assertEquals(researchOf({ ...z, seen: true, fed: 500, battles: 50 }).level, 0, "feeding without owning researches nothing");
  const one = researchOf({ ...z, owned: 1, seen: true });
  assertEquals([one.state, one.level, one.points], ["owned", 1, 10]);
  assertEquals(one.next, RESEARCH_STEPS[1]);
  assertEquals(researchOf({ ...z, owned: 1, seen: true, fed: 20 }).level, 2);
  assertEquals(researchOf({ ...z, owned: 1, seen: true, fed: 20 }).state, "developed");
  assertEquals(researchOf({ ...z, owned: 5, seen: true, fed: 200, battles: 40 }).level, 5);
  assertEquals(researchOf({ ...z, owned: 5, seen: true, fed: 200, battles: 40 }).frac, 1);
  // Caps: 5 owned, 200 food units, 100 battles.
  assertEquals(researchPoints({ ...z, owned: 99, fed: 9999, battles: 9999 }), 50 + 200 + 400);
  let prev = -1;
  for (let fed = 0; fed <= 400; fed += 7) {
    const r = researchOf({ ...z, owned: 2, seen: true, fed });
    assert(r.level >= prev, "more food never lowers the level");
    assert(r.frac >= 0 && r.frac <= 1, `frac ${r.frac}`);
    prev = r.level;
  }
});

Deno.test("research never regresses: the best score survives selling the last specimen", () => {
  const g = createGenemon({ seed: 77, owner: "t", level: 20 });
  g.conditions.battles.won = 10;
  const key = speciesOf(phenotypeOf(g)).key;
  const mem: DexMemory = { seen: {}, best: {} };
  const t1 = tallySpecies([g], mem);
  assertEquals(t1.get(key)!.owned, 1);
  assertEquals(t1.get(key)!.battles, 10);
  rememberBest(mem, t1);
  const lvl = researchOf(t1.get(key)!).level;
  assert(lvl >= 2, `10 battles develop the species (level ${lvl})`);
  const t2 = tallySpecies([], mem);
  const after = researchOf(t2.get(key)!);
  assertEquals(after.level, lvl);
  assertEquals(after.state, "developed");
});

Deno.test("noteSeen records each species once with its first time", () => {
  const mem: DexMemory = { seen: {}, best: {} };
  assertEquals(noteSeen(mem, ["biped:fire", "blob:steam", "biped:fire"], 5), 2);
  assertEquals(noteSeen(mem, ["biped:fire"], 9), 0);
  assertEquals(mem.seen["biped:fire"], 5);
  const t = tallySpecies([], mem);
  assertEquals(researchOf(t.get("blob:steam")!).state, "seen");
});

Deno.test("best foods follow an element signature (fish for water)", () => {
  const foods = bestFoodsFor({ moisture: 1, form: 0.4, heat: -0.2 });
  assert(foods.length > 0 && foods.length <= 3);
  assert(foods.includes("Fish"), foods.join(","));
  assertEquals(bestFoodsFor({}), []);
});

// ---------------------------------------------------------------- hatch 10 (P5-D1)
Deno.test("hatchMany: n distinct newborns, none already taken, deterministic per seed", () => {
  const a = hatchMany({ seed: 42, owner: "me", n: 10 });
  assertEquals(a.length, 10);
  assertEquals(new Set(a.map((g) => g.id)).size, 10);
  assertEquals(hatchMany({ seed: 42, owner: "me", n: 10 }).map((g) => g.id), a.map((g) => g.id));
  const b = hatchMany({ seed: 42, owner: "me", n: 10, taken: a.slice(0, 3).map((g) => g.id) });
  assert(b.every((g) => !a.slice(0, 3).some((x) => x.id === g.id)), "taken ids are skipped");
  assertEquals(hatchMany({ seed: 1, owner: "me", n: -4 }).length, 0);
  assert(a.every((g) => g.conditions.ageDays === 0), "newborns start as eggs (age 0)");
});

// ---------------------------------------------------------------- platform graduations (P5-H1)
Deno.test("measuring pole: 0.25 m ticks up to >= 115 % of the tallest, metres are major", () => {
  for (const maxH of [0.3, 0.9, 1.7, 3.2, 6.5]) {
    const t = poleTicks(maxH);
    const top = t[t.length - 1].y;
    assert(top >= maxH * 1.15 - 1e-9 && top >= 1, `top ${top} for ${maxH}`);
    t.forEach((x, i) => assertAlmostEquals(x.y, (i + 1) * 0.25, 1e-9));
    assert(t.filter((x) => x.major).every((x) => Number.isInteger(x.y)));
    assert(t.filter((x) => x.major).every((x) => x.label !== null), "every metre is labelled");
  }
  assertEquals(poleTicks(1).filter((x) => x.label).map((x) => x.label), ["0.25 m", "0.5 m", "0.75 m", "1 m", "1.25 m"]);
  assert(poleTicks(5).filter((x) => x.label).length < poleTicks(5).length, "tall poles thin their labels");
  assertEquals(fmtM(1.5), "1.5 m");
  assertEquals(fmtM(0.25), "0.25 m");
});

Deno.test("platform: rings and ruler scale with the radius; the radius fits the team", () => {
  assertEquals([ringStep(2), ringStep(4), ringStep(9)], [0.25, 0.5, 1]);
  const ticks = rulerTicks(3);
  assertAlmostEquals(ticks[0].r, 0.1, 1e-9);
  assertEquals(ticks.filter((t) => t.size === 2).length, 3 / ringStep(3));
  assertEquals(platformRadius([]), 2.5);
  const small = [{ radius: 0.2, height: 0.4 }, { radius: 0.25, height: 0.5 }];
  const big = [...small, { radius: 1.6, height: 3.8 }];
  assert(platformRadius(big) > platformRadius(small), "a giant widens the platform");
  assert(platformRadius(big) >= standRadius(big) + 1.6, "the stand circle and the giant fit inside");
  assert(platformRadius(Array.from({ length: 6 }, () => ({ radius: 9, height: 20 }))) <= 14, "capped at 14 m");
});

Deno.test("start spots: no two bodies overlap and all stand inside the platform", () => {
  for (const fp of [[{ radius: 0.3, height: 0.5 }, { radius: 0.5, height: 1 }], Array.from({ length: 6 }, (_, i) => ({ radius: 0.2 + i * 0.15, height: 0.4 + i * 0.4 }))]) {
    const R = platformRadius(fp), at = placeAround(fp);
    for (let i = 0; i < at.length; i++) {
      assert(Math.hypot(at[i].x, at[i].z) + fp[i].radius <= R, "inside the platform");
      for (let j = i + 1; j < at.length; j++) {
        const d = Math.hypot(at[i].x - at[j].x, at[i].z - at[j].z);
        assert(d >= (fp[i].radius + fp[j].radius) * 0.95, `bodies ${i}/${j} overlap: ${d.toFixed(2)}`);
      }
    }
  }
  assertEquals(placeAround([{ radius: 0.3, height: 1 }]), [{ x: 0, z: 0, yaw: 0 }]);
  assertAlmostEquals(wrapAngle(3 * Math.PI), Math.PI, 1e-9);
  assertAlmostEquals(lerpAngle(3, -3, 0.5), Math.PI, 0.01);
});
