import { assert, assertEquals } from "./_assert.ts";
import { phenotypeOf } from "../src/genome/genemon.ts";
import { dayKey, HATCH_CHOICES, hatchCost, hatchedOn, hatchGenemon, recordHatch } from "../src/ui/hatch.ts";

function share(element: Parameters<typeof hatchGenemon>[0]["element"], want: string, n: number): number {
  let hit = 0;
  for (let i = 0; i < n; i++) if (phenotypeOf(hatchGenemon({ seed: 7 + i * 7919, owner: "me", element })).elements.primary === want) hit++;
  return hit / n;
}

Deno.test("most plain hatches are neutral (>= 60 % of 500)", () => {
  const s = share("plain", "neutral", 500);
  assert(s >= 0.6, `plain neutral share ${s}`);
  const any = share("any", "neutral", 500);
  assert(any >= 0.6, `any neutral share ${any}`);
  assert(any < 1, "the 'any' lottery sometimes gives an element");
});

Deno.test("a water egg hatches water in >= 70 %", () => {
  const s = share("water", "water", 200);
  assert(s >= 0.7, `water share ${s}`);
  const f = share("fire", "fire", 200);
  assert(f >= 0.7, `fire share ${f}`);
});

Deno.test("hatching is deterministic per seed; newborns are level 3 eggs (age 0), small", () => {
  const a = hatchGenemon({ seed: 42, owner: "me", element: "plain" });
  const b = hatchGenemon({ seed: 42, owner: "me", element: "plain" });
  assertEquals(a, b);
  assert(hatchGenemon({ seed: 43, owner: "me" }).id !== a.id, "other seed, other Genemon");
  const ph = phenotypeOf(a);
  assertEquals(ph.level, 3);
  assertEquals(a.conditions.ageDays, 0); // pass 5: a hatch starts as an EGG (lifePhase egg -> fetus -> hatchling) [P5-V2]
  assert(ph.slots <= 2, `newborn slots ${ph.slots}`);
  assert(a.moves.length > 0, "a newborn knows at least one move");
  assert(HATCH_CHOICES.includes("any") && HATCH_CHOICES.includes("plain") && HATCH_CHOICES.includes("water"));
});

Deno.test("hatch cost: first free each day, then non-decreasing", () => {
  assertEquals(hatchCost(0), 0);
  assertEquals(hatchCost(1), 40);
  assertEquals(hatchCost(2), 60);
  assertEquals(hatchCost(3), 90);
  for (let i = 0; i < 30; i++) assert(hatchCost(i + 1) >= hatchCost(i), `cost(${i + 1}) >= cost(${i})`);
  const day = dayKey(new Date(2026, 9, 22, 10));
  assertEquals(day, "2026-10-22");
  let rec = recordHatch(undefined, day);
  rec = recordHatch(rec, day);
  assertEquals(hatchedOn(rec, day), 2);
  assertEquals(hatchedOn(rec, "2026-10-23"), 0, "the counter resets the next day");
  assertEquals(recordHatch(rec, "2026-10-23").count, 1);
});
