// Persona roster invariants: the 12 simulated players must be well-formed data the persona simulator
// can trust (valid ids, sane timetables, coherent devices/GPS/lifestyle) and must keep the roster's
// coverage promises (styles, devices, cities, elements). See docs/PERSONAS.md.
import { assert, assertEquals } from "./_assert.ts";
import { ELEMENT_IDS } from "../src/data/elements.ts";
import { MOVE_BY_ID } from "../src/combat/moves.ts";
import { EXPERIENCE_IDS, EXPERIENCES, FOOD_IDS } from "../src/data/lifestyle.ts";
import { type Device, personaById, PERSONAS, playBlocks, type ScheduleBlock } from "../src/sim/personas.ts";

const DEVICES: readonly Device[] = ["mobile", "tablet", "laptop", "desktop"];
const GPS_DEVICES: readonly Device[] = ["mobile", "tablet"];
const DAYS = [0, 1, 2, 3, 4, 5, 6];

/** Reference city centres (lat, lon): a home must sit inside its declared city. */
const CITY_CENTRES: Record<string, { lat: number; lon: number }> = {
  Paris: { lat: 48.8566, lon: 2.3522 },
  Lyon: { lat: 45.764, lon: 4.8357 },
  Marseille: { lat: 43.2965, lon: 5.3698 },
  Lille: { lat: 50.6292, lon: 3.0573 },
  Brussels: { lat: 50.8503, lon: 4.3517 },
  Annecy: { lat: 45.8992, lon: 6.1294 },
};

function km(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/** Every overlapping pair among the blocks active on `day` (touching ends are allowed). */
function overlapsOn(schedule: readonly ScheduleBlock[], day: number): string[] {
  const today = schedule.filter((b) => b.days.includes(day));
  const out: string[] = [];
  for (let i = 0; i < today.length; i++) {
    for (let j = i + 1; j < today.length; j++) {
      const a = today[i], b = today[j];
      if (a.start < b.end && b.start < a.end) {
        out.push(`${a.activity} ${a.start}-${a.end} x ${b.activity} ${b.start}-${b.end}`);
      }
    }
  }
  return out;
}

/** Number of connected components of an undirected graph given by a neighbour function. */
function components(ids: readonly string[], neighbours: (id: string) => readonly string[]): number {
  const seen = new Set<string>();
  let n = 0;
  for (const start of ids) {
    if (seen.has(start)) continue;
    n++;
    seen.add(start);
    const stack = [start];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      for (const nb of neighbours(cur)) {
        if (!seen.has(nb)) {
          seen.add(nb);
          stack.push(nb);
        }
      }
    }
  }
  return n;
}

const weeklyPlayBlocks = (id: string) => DAYS.reduce((s, d) => s + playBlocks(personaById(id)!, d).length, 0);

Deno.test("personas: exactly 12 personas with unique ids, and personaById round-trips", () => {
  assertEquals(PERSONAS.length, 12, "roster size");
  const ids = PERSONAS.map((p) => p.id);
  assertEquals(new Set(ids).size, 12, "unique ids");
  for (const p of PERSONAS) assert(personaById(p.id) === p, `personaById(${p.id})`);
  assert(personaById("nobody") === undefined, "unknown id must be undefined");
});

Deno.test("personas: every favourite move exists in MOVE_BY_ID and is learnable from a favourite element", () => {
  for (const p of PERSONAS) {
    assert(p.favoriteMoves.length >= 3, `${p.id}: at least 3 favourite moves`);
    assertEquals(new Set(p.favoriteMoves).size, p.favoriteMoves.length, `${p.id}: duplicate favourite move`);
    assertEquals(new Set(p.favoriteElements).size, p.favoriteElements.length, `${p.id}: duplicate element`);
    for (const e of p.favoriteElements) assert(ELEMENT_IDS.includes(e), `${p.id}: unknown element ${e}`);
    for (const id of p.favoriteMoves) {
      const m = MOVE_BY_ID[id];
      assert(m !== undefined, `${p.id}: unknown move ${id}`);
      // A Genemon only learns moves of its primary/secondary element or neutral (genemon.ts learnset).
      assert(
        m.element === "neutral" || p.favoriteElements.includes(m.element),
        `${p.id}: ${id} is ${m.element}`,
      );
    }
  }
});

Deno.test("personas: schedule blocks sit within 0-24 with start < end and never overlap within a day", () => {
  for (const p of PERSONAS) {
    for (const b of p.schedule) {
      const tag = `${p.id} ${b.activity} ${b.start}-${b.end}`;
      assert(b.days.length > 0, `${tag}: no days`);
      assertEquals(new Set(b.days).size, b.days.length, `${tag}: duplicate day`);
      for (const d of b.days) assert(Number.isInteger(d) && d >= 0 && d <= 6, `${tag}: bad day ${d}`);
      assert(Number.isFinite(b.start) && Number.isFinite(b.end), `${tag}: non-finite hours`);
      assert(b.start >= 0 && b.end <= 24 && b.start < b.end, `${tag}: hours out of range`);
    }
    for (const d of DAYS) assertEquals(overlapsOn(p.schedule, d), [], `${p.id} day ${d} overlaps`);
  }
  // The checker itself must be able to fail.
  const bad: ScheduleBlock[] = [
    { days: [2], start: 8, end: 12, activity: "work", device: null, physical: false, playIntensity: 0 },
    { days: [2, 3], start: 11, end: 13, activity: "lunch", device: null, physical: false, playIntensity: 0 },
  ];
  assertEquals(overlapsOn(bad, 2).length, 1, "fabricated overlap must be reported");
  assertEquals(overlapsOn(bad, 3).length, 0, "no overlap on a day with one block");
});

Deno.test("personas: each persona has >= 3 play blocks per week; playBlocks filters by weekday and sorts", () => {
  for (const p of PERSONAS) {
    assert(weeklyPlayBlocks(p.id) >= 3, `${p.id}: only ${weeklyPlayBlocks(p.id)} play blocks per week`);
    for (const d of DAYS) {
      const blocks = playBlocks(p, d);
      for (const b of blocks) {
        assert(b.playIntensity > 0 && b.days.includes(d), `${p.id}: wrong block on day ${d}`);
      }
      for (let i = 1; i < blocks.length; i++) {
        assert(blocks[i - 1].start <= blocks[i].start, `${p.id}: unsorted`);
      }
      const expected = p.schedule.filter((b) => b.playIntensity > 0 && b.days.includes(d)).length;
      assertEquals(blocks.length, expected, `${p.id} day ${d} play block count`);
    }
    assertEquals(playBlocks(p, 7).length, 0, `${p.id}: day 7 is not a weekday`);
    assertEquals(playBlocks(p, -1).length, 0, `${p.id}: day -1 is not a weekday`);
  }
});

Deno.test("personas: play needs a listed device, GPS needs a mobile or tablet, every device is used, all 4 covered", () => {
  const covered = new Set<Device>();
  for (const p of PERSONAS) {
    assert(p.devices.length > 0, `${p.id}: no device`);
    assertEquals(new Set(p.devices).size, p.devices.length, `${p.id}: duplicate device`);
    for (const dev of p.devices) {
      assert(DEVICES.includes(dev), `${p.id}: unknown device ${dev}`);
      covered.add(dev);
      assert(
        p.schedule.some((b) => b.device === dev && b.playIntensity > 0),
        `${p.id}: ${dev} listed but never used`,
      );
    }
    for (const b of p.schedule) {
      const tag = `${p.id} ${b.activity} ${b.start}-${b.end}`;
      if (b.playIntensity > 0) assert(b.device !== null, `${tag}: playing without a device`);
      if (b.device !== null) assert(p.devices.includes(b.device), `${tag}: device ${b.device} not listed`);
      if (b.physical) {
        assert(b.device !== null && GPS_DEVICES.includes(b.device), `${tag}: GPS without a GPS device`);
      }
    }
  }
  assertEquals([...covered].sort(), [...DEVICES].sort(), "all four devices covered");
});

Deno.test("personas: social circles are valid, not self, mutual, and form one connected graph", () => {
  const ids = PERSONAS.map((p) => p.id);
  for (const p of PERSONAS) {
    assert(p.socialCircle.length > 0, `${p.id}: no friends`);
    assertEquals(new Set(p.socialCircle).size, p.socialCircle.length, `${p.id}: duplicate friend`);
    for (const f of p.socialCircle) {
      assert(f !== p.id, `${p.id}: friend of itself`);
      const other = personaById(f);
      assert(other !== undefined, `${p.id}: unknown friend ${f}`);
      assert(other.socialCircle.includes(p.id), `${p.id} -> ${f} is one-way`);
    }
  }
  assertEquals(components(ids, (id) => personaById(id)!.socialCircle), 1, "one social component");
  // The traversal must be able to report a split graph.
  const fake: Record<string, string[]> = { a: ["b"], b: ["a"], c: [] };
  assertEquals(components(["a", "b", "c"], (id) => fake[id]), 2, "fabricated split graph");
});

Deno.test("personas: >= 9 distinct primary styles, and secondary style differs from primary", () => {
  const styles = new Set(PERSONAS.map((p) => p.style));
  assert(styles.size >= 9, `only ${styles.size} distinct primary styles`);
  for (const p of PERSONAS) assert(p.secondaryStyle !== p.style, `${p.id}: secondary equals primary`);
  const prefs = new Set(PERSONAS.map((p) => p.teamPreference));
  assertEquals([...prefs].sort(), ["balanced", "big", "swarm"], "every team preference represented");
});

Deno.test("personas: diet and experience keys are valid lifestyle ids with positive amounts", () => {
  for (const p of PERSONAS) {
    const diet = Object.entries(p.dietPerDay);
    assert(diet.length > 0, `${p.id}: empty diet`);
    for (const [food, units] of diet) {
      assert((FOOD_IDS as readonly string[]).includes(food), `${p.id}: unknown food ${food}`);
      assert(Number.isFinite(units) && units! > 0, `${p.id}: ${food} must be > 0`);
    }
    const exps = Object.entries(p.experiencesPerWeek);
    assert(exps.length > 0, `${p.id}: no experiences`);
    for (const [exp, units] of exps) {
      assert((EXPERIENCE_IDS as readonly string[]).includes(exp), `${p.id}: unknown experience ${exp}`);
      assert(Number.isFinite(units) && units! > 0, `${p.id}: ${exp} must be > 0`);
    }
  }
});

Deno.test("personas: physical-only experiences need physical play; gym training needs a gym visit", () => {
  for (const p of PERSONAS) {
    const physicalPlay = p.schedule.some((b) => b.physical && b.playIntensity > 0);
    for (const e of EXPERIENCE_IDS) {
      if ((p.experiencesPerWeek[e] ?? 0) > 0 && EXPERIENCES[e].physicalOnly) {
        assert(physicalPlay, `${p.id}: ${e} is physical-only but the persona never plays outdoors`);
      }
    }
    if ((p.experiencesPerWeek.gymTraining ?? 0) > 0) {
      assert(
        p.schedule.some((b) => b.activity === "gym" && b.physical),
        `${p.id}: gymTraining without a gym visit`,
      );
    }
  }
});

Deno.test("personas: roster spans ages 9-71 and >= 4 real cities incl. Paris and Lyon; homes sit in their city", () => {
  const ages = PERSONAS.map((p) => p.age);
  assertEquals(Math.min(...ages), 9, "youngest");
  assertEquals(Math.max(...ages), 71, "oldest");
  for (const a of ages) assert(Number.isInteger(a) && a >= 9 && a <= 71, `age ${a} outside 9-71`);
  const cities = new Set(PERSONAS.map((p) => p.city));
  assert(cities.size >= 4, `only ${cities.size} cities`);
  assert(cities.has("Paris") && cities.has("Lyon"), "Paris and Lyon required");
  for (const p of PERSONAS) {
    const centre = CITY_CENTRES[p.city];
    assert(centre !== undefined, `${p.id}: no reference centre for ${p.city}`);
    const d = km(p.home, centre);
    assert(d < 15, `${p.id}: home is ${d.toFixed(1)} km from ${p.city} (lat/lon swapped?)`);
  }
});

Deno.test("personas: special profiles max (desktop + mobile, GPS tests) and claude (any-hour desktop theorycrafter)", () => {
  const max = personaById("max")!;
  assert(max !== undefined, "max exists");
  assert(max.devices.includes("desktop") && max.devices.includes("mobile"), "max plays on desktop + mobile");
  assert(max.schedule.some((b) => b.physical && b.device === "mobile"), "max field-tests GPS on mobile");
  assert(max.socialCircle.includes("claude"), "max works with claude");

  const claude = personaById("claude")!;
  assert(claude !== undefined, "claude exists");
  assertEquals(claude.devices, ["desktop"], "claude is desktop-only");
  assertEquals(claude.style, "theorycrafter", "claude is a theorycrafter");
  assert(claude.schedule.every((b) => !b.physical), "claude never moves");
  assertEquals(claude.spendingPerWeek, 0, "claude never touches the live economy");
  for (const d of DAYS) {
    for (let h = 0; h < 24; h++) {
      assert(
        playBlocks(claude, d).some((b) => b.start <= h && b.end >= h + 1),
        `claude offline day ${d} ${h}h`,
      );
    }
  }
  for (const f of FOOD_IDS) assert((claude.dietPerDay[f] ?? 0) > 0, `claude's coverage diet misses ${f}`);
  for (const e of EXPERIENCE_IDS) {
    const units = claude.experiencesPerWeek[e] ?? 0;
    if (EXPERIENCES[e].physicalOnly) assertEquals(units, 0, `claude cannot earn physical-only ${e}`);
    else assert(units > 0, `claude's coverage misses virtual experience ${e}`);
  }
});

Deno.test("personas: favourite elements cover every element", () => {
  const liked = new Set(PERSONAS.flatMap((p) => p.favoriteElements));
  for (const e of ELEMENT_IDS) assert(liked.has(e), `no persona favours ${e}`);
});

Deno.test("personas: numeric fields stay in range and every play block can host the shortest session", () => {
  for (const p of PERSONAS) {
    assert(p.skill >= 0 && p.skill <= 1, `${p.id}: skill`);
    assert(p.riskTolerance >= 0 && p.riskTolerance <= 1, `${p.id}: riskTolerance`);
    assert(Number.isFinite(p.spendingPerWeek) && p.spendingPerWeek >= 0, `${p.id}: spending`);
    assert(Number.isInteger(p.pokedexGoal) && p.pokedexGoal > 0, `${p.id}: pokedexGoal`);
    const [lo, hi] = p.sessionLengthMin;
    assert(
      Number.isInteger(lo) && Number.isInteger(hi) && lo > 0 && lo <= hi && hi <= 1440,
      `${p.id}: sessions`,
    );
    for (const b of p.schedule) {
      assert(b.playIntensity >= 0 && b.playIntensity <= 1, `${p.id}: playIntensity ${b.playIntensity}`);
      if (b.playIntensity > 0) {
        assert(
          (b.end - b.start) * 60 >= lo,
          `${p.id} ${b.activity} ${b.start}-${b.end}: shorter than a session`,
        );
      }
    }
  }
});

Deno.test("personas: style intent — completionist aims widest, casual narrowest, trader spends most", () => {
  const by = (style: string) => PERSONAS.find((p) => p.style === style)!;
  const dex = PERSONAS.map((p) => p.pokedexGoal);
  assertEquals(by("completionist").pokedexGoal, Math.max(...dex), "completionist dex goal");
  assertEquals(by("casual").pokedexGoal, Math.min(...dex), "casual dex goal");
  assertEquals(
    by("trader").spendingPerWeek,
    Math.max(...PERSONAS.map((p) => p.spendingPerWeek)),
    "trader budget",
  );
});

Deno.test("personas: needs/goals/frustrations are 'tag: sentence' and achievement ids are kebab-case", () => {
  const tagged = /^[a-z0-9]+(-[a-z0-9]+)*: \S.*$/;
  const kebab = /^[a-z0-9]+(-[a-z0-9]+)*$/;
  for (const p of PERSONAS) {
    for (
      const [field, list] of [["needs", p.needs], ["goals", p.goals], [
        "frustrations",
        p.frustrations,
      ]] as const
    ) {
      assert(list.length >= 3, `${p.id}.${field}: at least 3 entries`);
      for (const s of list) assert(tagged.test(s), `${p.id}.${field}: "${s}" is not "tag: sentence"`);
      const tags = list.map((s) => s.slice(0, s.indexOf(":")));
      assertEquals(new Set(tags).size, tags.length, `${p.id}.${field}: duplicate tag`);
    }
    assert(p.achievementTargets.length >= 3, `${p.id}: at least 3 achievement targets`);
    for (const a of p.achievementTargets) {
      assert(kebab.test(a), `${p.id}: achievement "${a}" is not kebab-case`);
    }
    assertEquals(
      new Set(p.achievementTargets).size,
      p.achievementTargets.length,
      `${p.id}: duplicate achievement`,
    );
  }
});
