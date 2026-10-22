import { assert, assertEquals } from "./_assert.ts";
import { AXIS_IDS, type AxisVector } from "../src/data/axes.ts";
import { ELEMENT_IDS, ELEMENTS } from "../src/data/elements.ts";
import { FOODS } from "../src/data/lifestyle.ts";
import {
  HYBRID_LEVEL,
  hybridOf,
  HYBRIDS,
  hybridScore,
  hslOf,
  hueBetween,
  identityOf,
  identityOfPhenotype,
  opposedPair,
} from "../src/data/hybrids.ts";
import { randomGenome } from "../src/genome/genome.ts";
import { createGenemon, feed, phenotypeOf } from "../src/genome/genemon.ts";

const zeroAxes = (): AxisVector => Object.fromEntries(AXIS_IDS.map((a) => [a, 0])) as AxisVector;
const axesOf = (o: Partial<AxisVector>): AxisVector => ({ ...zeroAxes(), ...o });

Deno.test("[HYBRID] >= 30 unordered pairs, unique, symmetric lookup, no self pairs", () => {
  assert(HYBRIDS.length >= 30, `only ${HYBRIDS.length} hybrids`);
  const ids = new Set(HYBRIDS.map((h) => h.id));
  assertEquals(ids.size, HYBRIDS.length, "hybrid ids unique");
  assertEquals(new Set(HYBRIDS.map((h) => h.color)).size, HYBRIDS.length, "hybrid colours unique");
  for (const h of HYBRIDS) {
    assert(h.a !== "neutral" && h.b !== "neutral", `${h.id}: neutral does not hybridise`);
    assertEquals(hybridOf(h.a, h.b), h);
    assertEquals(hybridOf(h.b, h.a), h, `${h.id}: order-insensitive`);
  }
  for (const e of ELEMENT_IDS) assertEquals(hybridOf(e, e), null);
  let pairs = 0;
  for (const x of ELEMENT_IDS) for (const y of ELEMENT_IDS) if (x < y && hybridOf(x, y)) pairs++;
  assertEquals(pairs, HYBRIDS.length, "every hybrid is reachable by exactly one unordered pair");
  assertEquals(hybridOf("fire", "water")?.name, "Steam");
  assertEquals(hybridOf("earth", "fire")?.name, "Magma");
  assertEquals(hybridOf("air", "electric")?.name, "Storm");
  assertEquals(hybridOf("ice", "water")?.name, "Glacier");
});

Deno.test("[HYBRID] colour code: element hues, steam pale grey-white, hybrids between parents or documented", () => {
  const hue = (c: number) => hslOf(c).h;
  const fire = hue(ELEMENTS.fire.color);
  assert(fire >= 0 && fire <= 30, `fire hue ${fire}`);
  const water = hue(ELEMENTS.water.color);
  assert(water >= 200 && water <= 230, `water hue ${water}`);
  const el = hue(ELEMENTS.electric.color);
  assert(el >= 45 && el <= 60, `electric hue ${el}`);
  const plant = hue(ELEMENTS.plant.color);
  assert(plant >= 90 && plant <= 140, `plant hue ${plant}`);
  const ice = hue(ELEMENTS.ice.color);
  assert(ice >= 180 && ice <= 200, `ice hue ${ice}`);
  const steam = hslOf(hybridOf("fire", "water")!.color);
  assert(steam.s < 0.2 && steam.l > 0.8, `steam must be pale grey-white: s ${steam.s} l ${steam.l}`);
  const magma = hslOf(hybridOf("fire", "earth")!.color);
  assert(magma.h <= 30 && magma.s > 0.7 && magma.l < 0.5, "magma deep orange-red");
  const glacier = hslOf(hybridOf("water", "ice")!.color);
  assert(glacier.h >= 180 && glacier.h <= 215 && glacier.l > 0.7, "glacier pale cyan");
  const exceptions: string[] = [];
  for (const h of HYBRIDS) {
    const x = hue(h.color), p = hue(ELEMENTS[h.a].color), q = hue(ELEMENTS[h.b].color);
    if (h.exception) {
      assert(h.exception.length > 20, `${h.id}: an exception must say why`);
      exceptions.push(h.id);
      continue;
    }
    assert(hueBetween(x, p, q), `${h.id}: hue ${x.toFixed(0)} not between ${h.a} ${p.toFixed(0)} and ${h.b} ${q.toFixed(0)}`);
  }
  assertEquals(exceptions.sort(), ["steam", "storm"], "only documented exceptions");
  // hueBetween itself can fail (rule 9: a check that cannot fail is not a check).
  assert(!hueBetween(120, 16, 50), "green is not between red and yellow");
  assert(hueBetween(350, 331, 16), "wraps through 0");
  assert(!hueBetween(180, 331, 16), "cyan is not between pink and red");
});

Deno.test("[HYBRID] identityOf strict rule: secondaryLevel >= HYBRID_LEVEL, order-insensitive", () => {
  assertEquals(identityOf("fire", "water", HYBRID_LEVEL).name, "Steam");
  assertEquals(identityOf("water", "fire", 0.6).name, "Steam");
  assert(identityOf("fire", "water", 0.6).hybrid);
  const weak = identityOf("fire", "water", HYBRID_LEVEL - 0.01);
  assertEquals([weak.name, weak.hybrid, weak.color], ["Fire", false, ELEMENTS.fire.color]);
  assertEquals(identityOf("fire", null, 0).name, "Fire");
  assertEquals(identityOf("neutral", null, 0).name, "Neutral");
});

Deno.test("[HYBRID] body rule needs BOTH parents expressed", () => {
  const steam = hybridOf("fire", "water")!;
  const pureWater = axesOf({ moisture: 0.85, form: 0.4 });
  const pureFire = axesOf({ heat: 0.8, moisture: -0.5, temper: 0.4 });
  const hotWet = axesOf({ heat: 0.45, temper: 0.3, moisture: 0.4, form: 0.2 });
  assert(hybridScore(pureWater, steam).score < 0.05, "a water creature is not steam");
  assert(hybridScore(pureFire, steam).score < 0, "a dry fire creature is not steam");
  assert(hybridScore(hotWet, steam).score >= 0.25, "hot and wet is steam");
  const body = (axes: AxisVector, primary: "fire" | "water") => ({ axes, elements: { primary, secondary: null, secondaryLevel: 0 } });
  assertEquals(identityOfPhenotype(body(pureWater, "water")).name, "Water");
  assertEquals(identityOfPhenotype(body(hotWet, "water")).name, "Steam");
  assertEquals(identityOfPhenotype(body(hotWet, "fire")).name, "Steam");
  // Compatible pairs (no opposed axis) never use the body rule: they can be typed together.
  assert(opposedPair(steam) && !opposedPair(hybridOf("fire", "earth")!), "fire/water opposed, fire/earth compatible");
  const hotHard = axesOf({ heat: 0.6, temper: 0.4, hardness: 0.5, weight: 0.5, substance: 0.5, altitude: -0.5 });
  assertEquals(identityOfPhenotype(body(hotHard, "fire")).name, "Fire", "magma needs the typed secondary");
});

Deno.test("[HYBRID] strong foods: ~4x a staple's per-unit nudge", () => {
  const max = (n: Record<string, number | undefined>) => Math.max(...Object.values(n).map((v) => Math.abs(v ?? 0)));
  assert(max(FOODS.emberChili.nudge) >= 3.5 * max(FOODS.spicyPepper.nudge), "ember chili vs spicy pepper");
  assert(max(FOODS.springWater.nudge) >= 3.5 * max(FOODS.fish.nudge), "spring water vs fish");
  assert((FOODS.frostMint.nudge.heat ?? 0) < 0 && (FOODS.toxicCap.nudge.vitality ?? 0) < 0);
  assert((FOODS.voidSalt.nudge.substance ?? 0) < 0 && (FOODS.nightPlum.nudge.luminance ?? 0) < 0);
});

/**
 * DIET STORY [P4-E2] with the real engine: a plain genome (all axes 0, spread 0.05) becomes FIRE on
 * ember chili, its palette turns red, then spring water mixed in makes it STEAM.
 */
Deno.test("[HYBRID] diet story: plain -> fire (red palette) -> steam", () => {
  const steam = hybridOf("fire", "water")!;
  const rows: string[] = [];
  let fireStillPrimaryAtSteam = 0;
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    for (const extraChili of [0, 30]) {
      const genome = randomGenome(seed, seed + 7, { axes: zeroAxes(), spread: 0.05 });
      const g = createGenemon({ seed, genome });
      const ph0 = phenotypeOf(g);
      assertEquals(ph0.elements.primary, "neutral", `seed ${seed}: a plain genome starts neutral`);
      let chili = 0;
      while (phenotypeOf(g).elements.primary !== "fire" && chili < 60) {
        feed(g, "emberChili", 1);
        chili++;
      }
      const ph1 = phenotypeOf(g);
      assertEquals(ph1.elements.primary, "fire", `seed ${seed}: fire after ${chili} chili`);
      const base0 = hslOf(ph0.palette.base), base1 = hslOf(ph1.palette.base);
      assert(base1.h <= 40 || base1.h >= 340, `seed ${seed}: fire base hue ${base1.h.toFixed(0)} must be red/orange`);
      assert(base1.s > 0.6 && base1.s > base0.s + 0.3, `seed ${seed}: the fire palette saturates`);
      assertEquals(identityOfPhenotype(ph1).name, "Fire", "no steam before any water");
      feed(g, "emberChili", extraChili);
      let water = 0;
      let id = identityOfPhenotype(phenotypeOf(g));
      while (id.id !== "steam" && water < 60) {
        feed(g, "springWater", 1);
        water++;
        id = identityOfPhenotype(phenotypeOf(g));
      }
      const ph2 = phenotypeOf(g);
      assertEquals(id.name, "Steam", `seed ${seed}: steam after ${water} spring water`);
      assertEquals([id.color, id.glow, id.hybrid], [steam.color, steam.glow, true], "the renderer gets the steam colours");
      if (ph2.elements.primary === "fire") fireStillPrimaryAtSteam++;
      const strict = identityOf(ph2.elements.primary, ph2.elements.secondary, ph2.elements.secondaryLevel);
      rows.push(
        `seed ${seed} +${extraChili}: neutral h${base0.h.toFixed(0)} s${base0.s.toFixed(2)} -> fire@${chili} chili h${
          base1.h.toFixed(0)
        } s${base1.s.toFixed(2)} -> steam@${water} water (types ${ph2.elements.primary}/${ph2.elements.secondary ?? "-"}, ` +
          `fire ${ph2.elements.affinity.fire.toFixed(2)} water ${ph2.elements.affinity.water.toFixed(2)}, body score ${
            id.score.toFixed(2)
          }, strict identity ${strict.name})`,
      );
    }
  }
  console.log(rows.join("\n"));
  assert(fireStillPrimaryAtSteam >= 1, "with enough chili the creature is still fire-typed when it turns steam");
});

Deno.test("[HYBRID] wild prevalence: hybrids are a minority of random genomes", () => {
  let hybrids = 0;
  const N = 300;
  const seen = new Set<string>();
  for (let s = 0; s < N; s++) {
    const g = createGenemon({ seed: 9000 + s });
    const id = identityOfPhenotype(phenotypeOf(g));
    if (id.hybrid) {
      hybrids++;
      seen.add(id.id);
    }
  }
  console.log(`wild hybrids: ${hybrids}/${N} (${[...seen].sort().join(", ")})`);
  assert(hybrids > 0, "some wild Genemon are hybrids");
  assert(hybrids < N * 0.3, `too many wild hybrids: ${hybrids}/${N} (the element colour code must stay the rule)`);
});
