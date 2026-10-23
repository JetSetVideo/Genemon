/**
 * THE Ranked control [P6-R2]: one split control (league toggle Prime | Eternal + start) used on Home
 * and in the Arena. Before the fight it shows, at a glance, the chosen league's rating and tier and the
 * team as that league sees it: who fights (green chips) and who sits out and why (struck chips with the
 * reason). The league choice is remembered (localStorage "genemon.ranked.league").
 *
 * Data: src/ladder/leagues.ts (eligibility, tiers) and src/ui/ladderStore.ts (one ladder per league).
 * Start: App.startRanked(opponent, opponentProfile, spawn, league); the app filters the team with the
 * same `teamEligibility`, so what the chips show is exactly who fights.
 */
import type { App } from "./app.ts";
import { isLeagueId, LEAGUE_IDS, LEAGUES, type LeagueId, rankTier, type TeamEligibility, teamEligibility } from "../ladder/leagues.ts";
import { fmt, h } from "./dom.ts";
import { leagueLadder, type Standing, standingOf } from "./ladderStore.ts";
import { teamOf } from "./profile.ts";

export const LEAGUE_PREF_KEY = "genemon.ranked.league";

let chosen: LeagueId | null = null;

/** The league the Ranked control is set to (remembered across sessions). */
export function rankedLeague(): LeagueId {
  if (chosen === null) {
    try {
      const v = globalThis.localStorage?.getItem(LEAGUE_PREF_KEY);
      chosen = isLeagueId(v) ? v : "prime";
    } catch {
      chosen = "prime";
    }
  }
  return chosen;
}

export function setRankedLeague(l: LeagueId): void {
  chosen = l;
  try {
    globalThis.localStorage?.setItem(LEAGUE_PREF_KEY, l);
  } catch {
    // Private mode / quota: the choice still holds for this session.
  }
}

export interface RankedPanelOptions {
  /** Home: a tighter layout (no blurb). */
  compact?: boolean;
  opponent?: "rival" | "profile";
  opponentProfile?: string;
  /** Start slot (Arena map choice). */
  spawn?: number;
}

/** App.startRanked as the panel calls it (league last, so the pre-pass-6 signature stays valid). */
type StartRanked = (opponent?: "rival" | "profile", opponentProfile?: string, spawn?: number, league?: LeagueId) => void;

/** Start a rated battle of `league` (also usable by tools: `startRankedIn(app, "eternal")`). */
export function startRankedIn(app: App, league: LeagueId, o: RankedPanelOptions = {}): void {
  setRankedLeague(league);
  const start: StartRanked = app.startRanked.bind(app);
  start(o.opponent ?? "rival", o.opponentProfile, o.spawn, league);
}

/** The player's standing in a league (rating, games, W/L/D, place). */
export function leagueStanding(app: App, league: LeagueId): Standing {
  return standingOf(leagueLadder(app, league), app.profile.id, league);
}

/** "Gold" tier badge (colour via a CSS custom property). */
export function tierBadge(s: Standing): HTMLElement {
  const t = rankTier(s.rating, s.games);
  return h("span", { class: `p6r-tier p6r-tier-${t.id}`, vars: { tier: t.color }, title: t.next !== null ? `${t.name}: next tier at ${t.next}` : t.name }, t.name);
}

/** One chip per team member: who fights, who sits out and why. */
export function eligibilityChips(el: TeamEligibility): HTMLElement {
  return h("div", { class: "p6r-chips", "data-league": el.league },
    ...el.rows.map((r) =>
      h("span", { class: `p6r-chip ${r.ok ? "ok" : "out"}`, "data-genemon": r.id, "data-eligible": String(r.ok), title: `${r.name} · Lv ${r.level} · ${r.phase} · ${r.slots} slot${r.slots > 1 ? "s" : ""}: ${r.why}` },
        h("span", { class: "p6r-mark" }, r.ok ? "✓" : "✕"),
        h("b", {}, r.name),
        h("span", { class: "p6r-lv" }, `Lv ${r.level}`),
        r.ok ? null : h("span", { class: "p6r-why" }, r.why))));
}

/** The split Ranked control. */
export function renderRankedPanel(app: App, o: RankedPanelOptions = {}): HTMLElement {
  const league = rankedLeague();
  const def = LEAGUES[league];
  const el = teamEligibility(league, teamOf(app.profile), Date.now());
  const st = leagueStanding(app, league);
  const n = el.fighters.length, out = el.out.length;
  const pick = (l: LeagueId) => {
    if (l === rankedLeague()) return;
    setRankedLeague(l);
    app.render();
  };
  return h("div", { class: `p6r-panel ${o.compact ? "compact" : ""}`, "data-ranked-league": league },
    h("div", { class: "p6r-split" },
      h("div", { class: "p6r-seg", role: "group", "aria-label": "Ranked league" },
        ...LEAGUE_IDS.map((l) =>
          h("button", { class: `p6r-opt ${l === league ? "on" : ""}`, type: "button", "data-league": l, "aria-pressed": String(l === league), title: LEAGUES[l].blurb, onclick: () => pick(l) }, LEAGUES[l].name))),
      h("button", {
        class: "btn primary p6r-go",
        type: "button",
        "data-action": "ranked-battle",
        disabled: n === 0,
        title: n === 0 ? `Nobody in your team can fight in ${def.name}` : `${def.name} ranked battle: the ladder draws the arena; your real hour and today's weather apply`,
        onclick: () => startRankedIn(app, league, o),
      }, `♛ Ranked · ${def.name}`)),
    h("div", { class: "p6r-meta" },
      tierBadge(st),
      h("span", { class: "p6r-rating mono", title: `${def.name} rating (condition-aware MMR)` }, fmt(st.rating)),
      h("span", { class: "muted" }, st.games ? `${st.wins}W ${st.losses}L ${st.draws}D${st.place !== null ? ` · #${st.place} of ${st.players}` : ""}${st.provisional ? " · provisional" : ""}` : "no game yet"),
      h("span", { class: "p6r-count" }, `${n} fight${out ? ` · ${out} sit${out === 1 ? "s" : ""} out` : ""}`)),
    eligibilityChips(el),
    n === 0 ? h("p", { class: "p6r-none" }, league === "prime" ? "Nobody can fight in Prime: switch to Eternal, where every Genemon ranks." : "Your team is empty or unhatched: add Genemon in the Team screen.") : null,
    o.compact ? null : h("p", { class: "muted p6r-blurb" }, def.blurb));
}
