import { assert, assertAlmostEquals, assertEquals } from "./_assert.ts";
import { createGenemon, phenotypeOf } from "../src/genome/genemon.ts";
import type { Phenotype } from "../src/genome/phenotype.ts";
import { FOODS } from "../src/data/lifestyle.ts";
import {
  bloatOf,
  capacityOf,
  dietOf,
  digest,
  eat,
  efficiencyOf,
  formatPreview,
  fullnessOf,
  HOUR_MS,
  hoursPerUnitOf,
} from "../src/genome/digestion.ts";
import { newLifeState } from "../src/genome/lifeclock.ts";

function fixture(seed = 4) {
  const g = createGenemon({ seed, level: 20 });
  const ph = phenotypeOf(g);
  return { g, ph, life: newLifeState(g, 0) };
}
const withPrimary = (ph: Phenotype, primary: Phenotype["elements"]["primary"]): Phenotype => ({
  ...ph,
  elements: { ...ph.elements, primary },
});

Deno.test("digestion: diet class follows element and axes [P5-G3]", () => {
  const { ph } = fixture();
  assertEquals(dietOf(withPrimary(ph, "earth")), "lithovore");
  assertEquals(dietOf(withPrimary(ph, "metal")), "lithovore");
  assertEquals(dietOf(withPrimary(ph, "electric")), "energivore");
  assertEquals(dietOf(withPrimary(ph, "light")), "energivore");
  const neutral = withPrimary(ph, "neutral");
  const carn = {
    ...neutral,
    axes: {
      ...neutral.axes,
      temper: 0.8,
      might: 0.6,
      vitality: -0.2,
      appetite: 0,
      hardness: 0,
      luminance: 0,
    },
  };
  const herb = {
    ...neutral,
    axes: {
      ...neutral.axes,
      temper: -0.6,
      might: -0.2,
      vitality: 0.7,
      appetite: 0,
      hardness: 0,
      luminance: 0,
    },
  };
  assertEquals(dietOf(carn), "carnivore");
  assertEquals(dietOf(herb), "herbivore");
  assertEquals(dietOf({ ...carn, axes: { ...carn.axes, appetite: 0.9 } }), "omnivore");
  // Diet match decides efficiency.
  const litho = withPrimary(ph, "earth");
  assert(efficiencyOf(litho, "minerals") > efficiencyOf(litho, "meat"), "lithovore: stone > meat");
  assert(efficiencyOf(carn, "meat") > efficiencyOf(carn, "greens"), "carnivore: meat > greens");
  assert(efficiencyOf(carn, "meat", 0.6) > efficiencyOf(carn, "meat", 0.1), "a finer palate absorbs more");
  for (const f of Object.keys(FOODS) as (keyof typeof FOODS)[]) {
    const e = efficiencyOf(ph, f);
    assert(e >= 0.2 && e <= 1.4, `efficiency band ${f}: ${e}`);
  }
});

Deno.test("digestion: capacity grows with body size; metabolism sets digestion speed", () => {
  const { ph } = fixture();
  const cap = (sizeClass: Phenotype["sizeClass"]) => capacityOf({ ...ph, sizeClass });
  assert(
    cap("XS") < cap("S") && cap("S") < cap("M") && cap("M") < cap("L") && cap("L") < cap("XL"),
    "monotone in size class",
  );
  const fast = { ...ph, axes: { ...ph.axes, tempo: 0.9 } },
    slow = { ...ph, axes: { ...ph.axes, tempo: -0.9 } };
  assert(hoursPerUnitOf(fast) < hoursPerUnitOf(slow), "fast metabolism digests faster");
  assert(hoursPerUnitOf(ph, 400) > hoursPerUnitOf(ph, 60), "elders digest slower");
  assert(hoursPerUnitOf(ph, 60, -5) > hoursPerUnitOf(ph, 60, 25), "cold slows digestion");
});

Deno.test("digestion: eat refuses past capacity, swallows only what fits; ignoreCapacity force-feeds and bloats", () => {
  const { ph, life } = fixture();
  const cap = capacityOf(ph);
  const first = eat(life, "berries", cap, 0, ph);
  assert(first.ok && Math.abs(first.units - cap) < 0.002, `fills the stomach: ${first.why}`);
  const refused = eat(life, "meat", 1, 0, ph);
  assert(!refused.ok && refused.units === 0 && refused.why.startsWith("stomach full"), refused.why);
  assertEquals(life.digestion.stomach.length, 1, "nothing added on refusal");
  const forced = eat(life, "meat", 3, 0, ph, { ignoreCapacity: true });
  assert(forced.ok && forced.units === 3, "demo 'no food limit' overrides");
  assert(forced.fullness > cap, "past capacity");
  assert(bloatOf(life.digestion) > 0, "overfed -> bloat");
  const { life: l2 } = fixture();
  const partial = eat(l2, "fish", cap + 2, 0, ph);
  assert(partial.ok && partial.units < cap + 2 && partial.why.startsWith("only"), `partial: ${partial.why}`);
  assert(!eat(l2, "fish", 0, 0, ph).ok, "zero units refused");
});

Deno.test("digestion: digest absorbs over hours (units x efficiency), feeds hunger, empties the stomach", () => {
  const { ph, life } = fixture();
  const r = eat(life, "meat", 2, 0, ph);
  assert(r.ok);
  const h = life.digestion.hoursPerUnit = hoursPerUnitOf(ph);
  const half = digest(life, HOUR_MS * h * 1, ph);
  assertAlmostEquals(half.absorbed.meat, 1 * r.efficiency, 0.002, "one unit after hoursPerUnit hours");
  assert(half.hunger < 0, "fed");
  assert(Math.abs(fullnessOf(life.digestion) - 1) < 0.002, "one unit left");
  const rest = digest(life, HOUR_MS * h * 5, ph);
  assertAlmostEquals(rest.absorbed.meat, 1 * r.efficiency, 0.002, "the rest");
  assertEquals(life.digestion.stomach.length, 0, "empty");
  const none = digest(life, HOUR_MS * h * 6, ph);
  assertEquals(Object.keys(none.absorbed).length, 0, "nothing more");
  // Time never runs backwards.
  const back = digest(life, 0, ph);
  assertEquals(Object.keys(back.absorbed).length, 0);
});

Deno.test("digestion: preview lists hunger, growth and the food's own nudges with their signs", () => {
  const { ph, life } = fixture();
  const r = eat(life, "emberChili", 2, 0, ph);
  const by = Object.fromEntries(r.preview.map((p) => [p.label, p.delta]));
  assert(by.hunger < 0, "hunger drops");
  assert(by.growth > 0, "growth");
  assert(by.heat > 0 && by.temper > 0, "the chili's nudges");
  assertAlmostEquals(by.heat, FOODS.emberChili.nudge.heat! * 2 * r.efficiency, 0.001);
  assert(r.preview.some((p) => p.label.endsWith("affinity")), "element drift");
  const lines = formatPreview(r.preview);
  assert(lines.some((l) => /^heat \+0\.\d{3}$/.test(l)), lines.join(" | "));
  const toxic = eat(life, "toxicCap", 1, 0, ph, { ignoreCapacity: true });
  assert(toxic.preview.find((p) => p.label === "vitality")!.delta < 0, "toxic cap lowers vitality");
});

Deno.test("digestion: deterministic", () => {
  const run = () => {
    const { ph, life } = fixture(12);
    eat(life, "honey", 1.5, 0, ph);
    eat(life, "fish", 1, HOUR_MS, ph);
    return JSON.stringify([digest(life, HOUR_MS * 3, ph), digest(life, HOUR_MS * 9, ph), life.digestion]);
  };
  assertEquals(run(), run());
});
