import { assert, assertEquals } from "./_assert.ts";
import { createGenemon, phenotypeOf } from "../src/genome/genemon.ts";
import { helixOf } from "../src/genome/helix.ts";
import type { Imprint, LifeState } from "../src/genome/lifeTypes.ts";
import { newLifeState } from "../src/genome/lifeclock.ts";
import { sensesOf } from "../src/genome/senses.ts";
import {
  IMPRINT_AXIS_MAX,
  IMPRINT_MAX_INHERITED,
  imprintAxisShift,
  imprintFrom,
  imprintLooks,
  imprintTraitOf,
  inheritImprints,
} from "../src/genome/imprint.ts";

const mk = (seed = 2) => createGenemon({ seed, level: 15 });
const imp = (trait: Imprint["trait"], strength: number, itemId = `x.${trait}`, generation = 0): Imprint => ({
  itemId,
  trait,
  strength,
  since: 1,
  generation,
});
function lifeWith(imprints: Imprint[]): LifeState {
  const l = newLifeState(mk(), 0);
  l.imprints = imprints;
  return l;
}

Deno.test("imprint: items bend the trait they stand for (food axis, gear sense, cosmetics) [P5-G6]", () => {
  assertEquals(imprintTraitOf("food.emberChili")?.trait, "heat");
  assertEquals(imprintTraitOf("food.frostMint")?.sign, -1, "frost mint cools");
  assertEquals(imprintTraitOf("gear.focusLens")?.trait, "vision");
  assertEquals(imprintTraitOf("gear.emberFang")?.trait, "heat", "elemental gear -> element's main axis");
  assertEquals(imprintTraitOf("cosmetic.emberGlow")?.trait, "color");
  assertEquals(imprintTraitOf("cosmetic.tigerStripes")?.trait, "coat");
  assertEquals(imprintTraitOf("cosmetic.glowPaint")?.trait, "glow");
  assertEquals(imprintTraitOf("potion.heal"), null, "potions do not imprint");
  assertEquals(imprintTraitOf("nope.nothing"), null);
  const g = mk();
  assertEquals(imprintFrom(g, "ticket.arenaGold", 0), null);
  assertEquals(g.life, undefined, "no life state created for a non-imprinting item");
});

Deno.test("imprint: repeated use strengthens with diminishing returns, never past 1", () => {
  const g = mk();
  let prev = 0, prevGain = Infinity;
  for (let i = 0; i < 60; i++) {
    const im = imprintFrom(g, "food.emberChili", 1000 + i)!;
    assert(im.strength > prev || im.strength >= 0.995, `stronger each use (${prev} -> ${im.strength})`);
    const gain = im.strength - prev;
    assert(gain <= prevGain + 1e-3, "diminishing");
    assert(im.strength <= 1);
    assertEquals(im.since, 1000, "keeps the first time");
    prev = im.strength;
    prevGain = gain;
  }
  assertEquals(g.life!.imprints.length, 1, "one imprint per item and trait");
  const shift = imprintAxisShift(g.life);
  assert(shift.heat! > 0 && shift.heat! <= IMPRINT_AXIS_MAX, `bounded axis bend ${shift.heat}`);
});

Deno.test("imprint: a focus lens imprint sharpens vision through sensesOf (budget-neutral)", () => {
  const g = mk(5);
  const ph = phenotypeOf(g), helix = helixOf(g.genome, ph);
  const before = sensesOf(ph, helix, newLifeState(g, 0)).acuity.vision;
  for (let i = 0; i < 20; i++) imprintFrom(g, "gear.focusLens", i);
  const after = sensesOf(ph, helix, g.life).acuity.vision;
  assert(after > before, `vision ${before} -> ${after}`);
  assert(imprintLooks(g.life).senses.vision! > 0);
});

Deno.test("imprint: inheritance keeps the strongest per trait, halves it, bumps the generation, is seeded", () => {
  const a = lifeWith([imp("heat", 0.8, "food.emberChili"), imp("vision", 0.05), imp("coat", 0.6)]);
  const b = lifeWith([imp("heat", 0.2, "food.spicyPepper"), imp("wisdom", 0.7, "cosmetic.wizardHat", 1)]);
  let inheritedHeat = 0;
  for (let seed = 0; seed < 60; seed++) {
    const kids = inheritImprints(a, b, seed);
    assertEquals(JSON.stringify(kids), JSON.stringify(inheritImprints(a, b, seed)), "deterministic");
    assert(kids.length <= IMPRINT_MAX_INHERITED);
    assertEquals(new Set(kids.map((k) => k.trait)).size, kids.length, "one per trait");
    for (const k of kids) {
      assert(k.trait !== "vision", "weak imprints fade out");
      if (k.trait === "heat") {
        inheritedHeat++;
        assertEquals(k.strength, 0.4, "the strongest parent's, halved");
        assertEquals(k.itemId, "food.emberChili");
        assertEquals(k.generation, 1);
      }
      if (k.trait === "wisdom") assertEquals(k.generation, 2, "carried one more generation");
    }
  }
  assert(
    inheritedHeat > 30 && inheritedHeat < 60,
    `strong imprints usually pass (${inheritedHeat}/60), not always`,
  );
  assertEquals(inheritImprints(undefined, undefined, 1).length, 0);
  // Three generations of halving wash an imprint out.
  let line: LifeState | undefined = lifeWith([imp("heat", 1)]);
  let gens = 0;
  for (let i = 0; i < 10; i++) {
    let next: Imprint[] = [];
    for (let s = 0; s < 50 && next.length === 0; s++) next = inheritImprints(line, undefined, s * 7 + i);
    if (next.length === 0) break;
    line = lifeWith(next);
    gens++;
  }
  assert(gens >= 2 && gens <= 5, `fades after a few generations (${gens})`);
});
