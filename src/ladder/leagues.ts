/**
 * The two ranked leagues [P6-R1]: PRIME and ETERNAL. Old Genemon never die: they leave Prime when they
 * are past their prime and keep ranking in Eternal, which has its own ladder, rating, history and draw.
 *
 * PRIME (the main ladder)
 *   - Level cap 50 per fighter. WHY 50: power grows linearly with level (phenotype.ts:
 *     `1 + (level - 1) / 30`), so Lv 50 is x2.63 the power of Lv 1 and Lv 100 would be x4.3. Every
 *     life-clock expectation sits well below 50 (adult Lv 16, elder 25, ancient 35: lifeclock
 *     PHASE_LEVEL), so a Genemon that lives a normal life is never capped; only grinders and the
 *     short-curve lineages of pass 6 (many quick levels) reach it, and the cap stops a level race from
 *     deciding the main ladder. It is also the classic "flat rules" level of the genre.
 *   - Refuses the unborn (egg, fetus), the pupating (cocoon form of a metamorphosis lineage) and those
 *     past their prime (lifeclock.canRank: ancients, scarred elders).
 *   - A colossus (XXL, 6 slots) is admitted when it fits the 6-slot team rule: it then fights alone.
 * ETERNAL
 *   - Every born Genemon: elders, ancients, scarred veterans, colossi, cocoons; no level cap.
 *   - Only eggs / fetuses sit out (they cannot fight at all) and a body larger than the team's 6 slots.
 *
 * Migration: Prime keeps the legacy ladder key ("genemon.ladder"), so the existing ladder, its learned
 * weights and the player's MMR ARE the Prime ladder; Eternal starts fresh under its own key. History
 * rows written before pass 6 carry no league and count as Prime (`leagueOfRecord`).
 *
 * Pure (no DOM, no clock): callers pass `now`.
 */
import type { Genemon } from "../genome/genemon.ts";
import { phenotypeOf } from "../genome/genemon.ts";
import { canRank, lifePhase } from "../genome/lifeclock.ts";
import type { LeagueDef, LeagueId } from "../genome/p6Types.ts";

export type { LeagueDef, LeagueId };

/** Slots of a team (SLOT_COST: XS/S 1, M 2, L 3, XL 4, XXL 6). */
export const TEAM_SLOTS = 6;
/** Prime's level cap (see the header for why 50). */
export const PRIME_LEVEL_CAP = 50;

export const LEAGUE_IDS: readonly LeagueId[] = ["prime", "eternal"];

export const LEAGUES: Record<LeagueId, LeagueDef> = {
  prime: {
    id: "prime",
    name: "Prime",
    blurb: `The main ladder. Fighters up to level ${PRIME_LEVEL_CAP}, in their prime: no eggs, no cocoons, no ancients or battle-worn elders.`,
    levelCap: PRIME_LEVEL_CAP,
    refusedPhases: ["egg", "fetus", "cocoon", "ancient"],
    ladderKey: "genemon.ladder",
  },
  eternal: {
    id: "eternal",
    name: "Eternal",
    blurb: "Every Genemon is welcome: elders, ancients, colossi, no level cap. Its own rating: old Genemon keep ranking here.",
    levelCap: null,
    refusedPhases: ["egg", "fetus"],
    ladderKey: "genemon.ladder.eternal",
  },
};

export function isLeagueId(x: unknown): x is LeagueId {
  return x === "prime" || x === "eternal";
}

/** Storage key of a league's "why did my rating move" summary (Prime = the legacy key). */
export function lastMatchKey(league: LeagueId): string {
  return `${LEAGUES[league].ladderKey}.last`;
}

export interface Eligibility {
  ok: boolean;
  why: string;
}

/** Can `g` fight a rated battle of `league`? `now` is accepted for the contract (phases follow g.conditions.ageDays). */
export function eligibility(league: LeagueId, g: Genemon, _now: number): Eligibility {
  const def = LEAGUES[league];
  const ph = phenotypeOf(g);
  const phase = lifePhase(g);
  const form = ph.evo?.form ?? null;
  if (def.refusedPhases.includes(phase)) {
    if (phase === "egg" || phase === "fetus") return { ok: false, why: `${phase}: not born yet` };
    return { ok: false, why: `${phase}: past its prime, ranks in Eternal` };
  }
  if (form !== null && def.refusedPhases.includes(form)) {
    return { ok: false, why: form === "egg" ? "egg: not hatched yet" : `${form}: changing form, cannot fight in ${def.name}` };
  }
  if (form === "egg") return { ok: false, why: "egg: not hatched yet" };
  if (ph.slots > TEAM_SLOTS) return { ok: false, why: `${ph.slots} slots: larger than a ${TEAM_SLOTS}-slot team` };
  if (league === "prime") {
    const r = canRank(g);
    if (!r.ok) return { ok: false, why: `${r.why}; ranks in Eternal` };
  }
  if (def.levelCap !== null && ph.level > def.levelCap) {
    return { ok: false, why: `Lv ${ph.level} above the ${def.name} cap ${def.levelCap}` };
  }
  if (league === "eternal") {
    return { ok: true, why: phase === "ancient" || phase === "elder" ? `${phase}: welcome in Eternal` : `${phase}: can rank` };
  }
  return { ok: true, why: `${phase}, Lv ${ph.level}: can rank` };
}

export interface EligibilityRow extends Eligibility {
  id: string;
  name: string;
  level: number;
  phase: string;
  slots: number;
}

export interface TeamEligibility {
  league: LeagueId;
  /** One row per team member, in team order. */
  rows: EligibilityRow[];
  /** Who fights (team order). */
  fighters: Genemon[];
  /** Who sits out and why. */
  out: { g: Genemon; why: string }[];
  /** Slots the fighters use. */
  slots: number;
}

/**
 * The team as a league sees it: eligible members fight in team order while they fit the 6 slots;
 * the others sit out with a reason. Pure, deterministic.
 */
export function teamEligibility(league: LeagueId, team: readonly Genemon[], now: number): TeamEligibility {
  const rows: EligibilityRow[] = [];
  const fighters: Genemon[] = [];
  const out: { g: Genemon; why: string }[] = [];
  let slots = 0;
  for (const g of team) {
    const ph = phenotypeOf(g);
    let e = eligibility(league, g, now);
    if (e.ok && slots + ph.slots > TEAM_SLOTS) e = { ok: false, why: `no slot left (${slots}/${TEAM_SLOTS} used, needs ${ph.slots})` };
    if (e.ok) {
      slots += ph.slots;
      fighters.push(g);
    } else out.push({ g, why: e.why });
    rows.push({ ...e, id: g.id, name: g.name, level: ph.level, phase: ph.evo?.form === "cocoon" ? "cocoon" : lifePhase(g), slots: ph.slots });
  }
  return { league, rows, fighters, out, slots };
}

/** The league of a battle-history row: rows written before pass 6 (no league) are Prime. */
export function leagueOfRecord(rec: { league?: string; kind?: string }): LeagueId | null {
  if (rec.kind !== undefined && rec.kind !== "ranked" && rec.kind !== "forfeit") return null;
  return isLeagueId(rec.league) ? rec.league : "prime";
}

// ------------------------------------------------------------------------------ rank tiers

export type TierId = "unranked" | "bronze" | "silver" | "gold" | "platinum" | "diamond" | "master";
export interface RankTier {
  id: TierId;
  name: string;
  /** Badge colour (CSS hex). */
  color: string;
  /** Rating where this tier starts (null for unranked). */
  floor: number | null;
  /** Rating of the next tier (null at the top / unranked). */
  next: number | null;
}

/** Tier floors around the ladder's 1500 base: a new player starts at Silver. */
export const TIERS: readonly RankTier[] = [
  { id: "bronze", name: "Bronze", color: "#c98a5a", floor: -Infinity, next: 1425 },
  { id: "silver", name: "Silver", color: "#b8c4d6", floor: 1425, next: 1550 },
  { id: "gold", name: "Gold", color: "#ffd166", floor: 1550, next: 1675 },
  { id: "platinum", name: "Platinum", color: "#5ee0c8", floor: 1675, next: 1800 },
  { id: "diamond", name: "Diamond", color: "#7aa7ff", floor: 1800, next: 1950 },
  { id: "master", name: "Master", color: "#ff6bd6", floor: 1950, next: null },
];
const UNRANKED: RankTier = { id: "unranked", name: "Unranked", color: "#8a96a8", floor: null, next: null };

/** Tier of a rating; a player with no game is Unranked. */
export function rankTier(rating: number, games: number): RankTier {
  if (!(games > 0) || !Number.isFinite(rating)) return UNRANKED;
  for (let i = TIERS.length - 1; i >= 0; i--) {
    const t = TIERS[i];
    if (rating >= (t.floor ?? -Infinity)) return t;
  }
  return TIERS[0];
}
