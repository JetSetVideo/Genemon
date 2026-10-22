import { assert, assertAlmostEquals, assertEquals } from "./_assert.ts";
import { Arena, ARENA_INFO, ARENA_KINDS, generateArena } from "../src/world/arena.ts";
import { GROUND_IDS } from "../src/data/grounds.ts";
import { arenaStats, arenaWeathers, previewSeed } from "../src/world/arenaStats.ts";

const gen = (kind: typeof ARENA_KINDS[number], seed = previewSeed(kind)) => generateArena({ seed, kind, weather: ARENA_INFO[kind].weathers[0], hour: 12 });

Deno.test("arenaStats: composition sums to 1, sorted, slope max >= mean, hints for every kind", () => {
  for (const k of ARENA_KINDS) {
    for (const seed of [previewSeed(k), 7, 4242]) {
      const s = arenaStats(gen(k, seed), ARENA_INFO[k].weathers[0]);
      const sum = s.composition.reduce((acc, c) => acc + c.share, 0);
      assertAlmostEquals(sum, 1, 1e-9, `${k}/${seed} composition`);
      for (let i = 1; i < s.composition.length; i++) assert(s.composition[i - 1].share >= s.composition[i].share, `${k} sorted`);
      assert(s.cells > 1000, `${k} cells ${s.cells}`);
      assert(s.slope.max >= s.slope.mean, `${k} slope max ${s.slope.max} < mean ${s.slope.mean}`);
      assert(s.slope.steepShare >= 0 && s.slope.steepShare <= 1, `${k} steepShare`);
      assert(s.elevation.max >= s.elevation.mean && s.elevation.mean >= s.elevation.min, `${k} elevation order`);
      assertAlmostEquals(s.liquidShare + s.solidShare, 1, 1e-9, `${k} liquid + solid`);
      for (const v of [s.liquidShare, s.diggableShare, s.conductiveShare]) assert(v >= 0 && v <= 1, `${k} share range`);
      assert(s.hints.length >= 3, `${k} hints ${s.hints.length}`);
      assert(s.hints.every((h) => h.length > 10 && !h.includes("NaN") && !h.includes("undefined")), `${k} hint text`);
      assert(s.weather !== null && s.weather.id === ARENA_INFO[k].weathers[0], `${k} weather summary`);
    }
  }
});

Deno.test("arenaStats: deterministic for a fixed seed, sensitive to the seed", () => {
  const a = JSON.stringify(arenaStats(gen("canyon", 99), "sandstorm"));
  const b = JSON.stringify(arenaStats(gen("canyon", 99), "sandstorm"));
  assertEquals(a, b);
  const c = JSON.stringify(arenaStats(gen("canyon", 100), "sandstorm"));
  assert(a !== c, "a different seed must change the stats");
});

Deno.test("arenaStats: volcano favours fire; lake is wetter than meadow; canyon is steeper than meadow", () => {
  for (const seed of [previewSeed("volcano"), 1, 2, 3]) {
    const v = arenaStats(gen("volcano", seed));
    assertEquals(v.favours[0]?.element, "fire", `volcano seed ${seed} favours ${JSON.stringify(v.favours)}`);
  }
  const vh = arenaStats(gen("volcano"), "heatwave");
  assertEquals(vh.favours[0].element, "fire");
  assert(vh.favours[0].score > arenaStats(gen("volcano")).favours[0].score, "heatwave adds to fire");
  assert(vh.weather!.boosted.includes("fire") && vh.weather!.weakened.includes("ice"), "heatwave chips");
  for (const seed of [1, 2, 3]) {
    const lake = arenaStats(gen("lake", seed)), meadow = arenaStats(gen("meadow", seed));
    assert(lake.liquidShare > meadow.liquidShare, `lake ${lake.liquidShare} <= meadow ${meadow.liquidShare}`);
    assert(arenaStats(gen("canyon", seed)).slope.mean > meadow.slope.mean, "canyon steeper");
  }
  assertEquals(arenaStats(gen("tundra")).favours[0].element, "ice");
});

Deno.test("arenaWeathers: one entry per ARENA_INFO weather, same geometry, weather-specific favours", () => {
  for (const k of ARENA_KINDS) {
    const ws = arenaWeathers(k);
    assertEquals(ws.map((w) => w.id), ARENA_INFO[k].weathers);
    for (const w of ws) {
      assertEquals(w.stats.weather?.id, w.id);
      assertEquals(w.stats.composition, ws[0].stats.composition);
    }
  }
  const lake = arenaWeathers("lake");
  const storm = lake.find((w) => w.id === "storm")!.stats, clear = lake.find((w) => w.id === "clear")!.stats;
  assert(storm.favours.some((f) => f.element === "electric") && !clear.favours.some((f) => f.element === "electric"), "storm favours electric on the lake");
  assert(storm.hints.some((h) => h.startsWith("Strong wind")), "storm wind hint");
});

Deno.test("FALSIFIER: a hand-built all-water flat arena reports liquidShare 1, no slope, nothing to dig", () => {
  const a = new Arena({ seed: 1, kind: "lake", weather: "clear", hour: 12 });
  a.grounds.fill(GROUND_IDS.indexOf("water"));
  a.heights.fill(-1);
  a.waterLevel = 0;
  const s = arenaStats(a);
  assertEquals(s.liquidShare, 1);
  assertEquals(s.composition.length, 1);
  assertEquals(s.composition[0].ground, "water");
  assertEquals(s.diggableShare, 0);
  assertEquals(s.conductiveShare, 1);
  assertEquals(s.slope.max, 0);
  assertEquals(s.slope.steepShare, 0);
  assertEquals(s.elevation.range, 0);
  assertEquals(s.favours[0].element, "water");
  assert(s.hints.some((h) => h.startsWith("Water conducts: electric chains through 100 %")), JSON.stringify(s.hints));
  assert(s.hints.some((h) => h.startsWith("Quake-type moves fizzle")), "no solid ground");
  // and the inverse: one dry cell in the middle must make it < 1 (the metric can fail).
  const mid = (a.n >> 1) * a.n + (a.n >> 1);
  a.grounds[mid] = GROUND_IDS.indexOf("stone");
  assert(arenaStats(a).liquidShare < 1, "one stone cell lowers the liquid share");
});
