/**
 * Ranked play: which battles move rating, and who picks their conditions.
 *
 * WHY (round-1 critic, X1 + X6): rating and XP were free. Rematch re-ran the same seed and paid a
 * win again and again, and the player picked arena, weather and hour for a battle that moved MMR
 * (storm for an electric team, an eclipse night for shadow). Two rules close both:
 *   1. A seed pays rating, XP and W/L ONCE per profile (`isRated`, `rewardedSeeds` on the profile).
 *   2. In a ranked battle the LADDER draws the arena (`rankedConditions`). The hour is the player's
 *      REAL hour and the weather is today's REAL weather when the arena has it: living by day or by
 *      night is the game's premise, so the real world is a condition, not a choice - the
 *      condition-aware MMR prices it in the expectation instead.
 * Custom setups (picked arena/weather/hour), mirror and wild battles are practice: unrated.
 *
 * WHO calls it: App.startRanked / App.finishBattle (src/ui/app.ts). Pure and deterministic: the same
 * profile, match number and day always draw the same arena and seed.
 */
import { hashSeed, Rng } from "../core/rng.ts";
import type { WeatherId } from "../data/weather.ts";
import { ARENA_INFO, ARENA_KINDS, type ArenaKind } from "../world/arena.ts";
import type { LeagueId } from "./leagues.ts";

export interface RankedDraw {
  arena: ArenaKind;
  weather: WeatherId;
  hour: number;
  seed: number;
}

/**
 * Draw the conditions of ranked match number `matchNo` of `profileId` on local day `day` in `league`
 * [P6-R1]. Each league has its OWN draw: Prime keeps the pre-pass-6 stream (same inputs, same arena and
 * seed as before), Eternal hashes the league in, so the two ladders never share a seed or an arena order.
 */
export function rankedConditions(profileId: string, matchNo: number, day: number, realHour: number, realWeather: WeatherId, league: LeagueId = "prime"): RankedDraw {
  const salt = league === "prime" ? [] : [league];
  const rng = new Rng(hashSeed("ranked", profileId, matchNo, day, ...salt));
  const arena = rng.pick(ARENA_KINDS);
  const fits = ARENA_INFO[arena].weathers;
  const weather = fits.includes(realWeather) ? realWeather : rng.pick(fits);
  const hour = ((realHour % 24) + 24) % 24;
  return { arena, weather, hour, seed: hashSeed("ranked-seed", profileId, matchNo, day, ...salt) % 2147483647 };
}

/** A finished battle moves rating only when it was ranked, against a real opponent, on a seed not yet rewarded. */
export function isRated(o: { ranked?: boolean; opponent: string }, seed: number, rewardedSeeds: readonly number[]): boolean {
  return o.ranked === true && o.opponent !== "mirror" && o.opponent !== "wild" && !rewardedSeeds.includes(seed);
}
