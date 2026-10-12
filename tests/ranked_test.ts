import { assert, assertEquals } from "./_assert.ts";
import { isRated, rankedConditions } from "../src/ladder/ranked.ts";
import { ARENA_INFO, ARENA_KINDS } from "../src/world/arena.ts";

Deno.test("ranked [SPEC L3]: the ladder draws the arena deterministically; hour and fitting weather stay real", () => {
  const a = rankedConditions("max", 7, 20373, 23.5, "rain");
  assertEquals(a, rankedConditions("max", 7, 20373, 23.5, "rain"), "same inputs, same draw");
  assert(ARENA_KINDS.includes(a.arena), "a real arena");
  assert(ARENA_INFO[a.arena].weathers.includes(a.weather), `weather ${a.weather} fits ${a.arena}`);
  assertEquals(a.hour, 23.5, "the real hour is kept");
  // Many draws: every arena appears (no fixed home field) and real weather is kept whenever it fits.
  const seen = new Set<string>();
  for (let n = 0; n < 200; n++) {
    const d = rankedConditions("max", n, 20373, 14, "clear");
    seen.add(d.arena);
    if (ARENA_INFO[d.arena].weathers.includes("clear")) assertEquals(d.weather, "clear", `${d.arena} has clear weather`);
  }
  assertEquals(seen.size, ARENA_KINDS.length, "every arena is drawn");
  assert(rankedConditions("max", 1, 20373, 14, "clear").seed !== rankedConditions("max", 2, 20373, 14, "clear").seed, "a new match, a new seed");
});

Deno.test("ranked [SPEC L4]: a seed pays once; practice, mirror and wild battles never move rating", () => {
  assert(isRated({ ranked: true, opponent: "rival" }, 42, []), "fresh ranked battle is rated");
  assert(!isRated({ ranked: true, opponent: "rival" }, 42, [42]), "a rematch of a rewarded seed is not");
  assert(!isRated({ ranked: false, opponent: "rival" }, 42, []), "practice (picked conditions) is not");
  assert(!isRated({ opponent: "profile" }, 42, []), "unflagged battles are not");
  assert(!isRated({ ranked: true, opponent: "mirror" }, 42, []), "mirror is not");
  assert(!isRated({ ranked: true, opponent: "wild" }, 42, []), "wild is not");
  assert(isRated({ ranked: true, opponent: "profile" }, 43, [42]), "you vs me, fresh seed, is rated");
});
