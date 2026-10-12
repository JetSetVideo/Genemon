/**
 * Ladder screen: the condition-aware MMR (src/ladder/mmr.ts) as the player sees it - standings,
 * why the last match moved the rating, what the ladder has learned each condition is worth, the
 * player's results per arena / weather / combo with Wilson 95% intervals, and the best and worst
 * combos. Data: getLadder() and the last-match summary written by recordBattle()
 * (src/ui/ladderStore.ts). Every win rate is shown with its interval, never bare.
 */
import type { App } from "../app.ts";
import { sigmoid } from "../../core/math.ts";
import { ELEMENT_IDS, type ElementId } from "../../data/elements.ts";
import { type Weather, WEATHERS } from "../../data/weather.ts";
import { EXTRA_CONTEXT_FEATURES } from "../../ladder/context.ts";
import { COMBO_FEATURE, type ConditionEntry, CONTEXT_FEATURES, type Ladder } from "../../ladder/mmr.ts";
import { ARENA_INFO } from "../../world/arena.ts";
import { bar, fmt, h, pct, section } from "../dom.ts";
import { getLadder, type LastMatch, loadLastMatch } from "../ladderStore.ts";
import { elChip } from "../widgets.ts";

const LABELS: Record<string, string> = {
  typeAdvantage: "Type advantage",
  arenaAffinity: "Arena ground",
  weatherAffinity: "Weather",
  powerDiff: "Team power",
  synergyDiff: "Team synergy",
  sizeDiff: "Size and mass",
  reachDiff: "Reach",
  [COMBO_FEATURE]: "Combo track record",
  rhythmFit: "Time of day",
};
/** Opponent ids that are not local profiles. */
const OTHER_PLAYERS: Record<string, string> = { rival: "Rival trainer", wild: "Wild swarm", mirror: "Mirror" };
const FEATURES = [...CONTEXT_FEATURES, ...EXTRA_CONTEXT_FEATURES];
const NOTES = new Map(FEATURES.map((f) => [f.name, f.note]));
const ELEMENTS_SET = new Set<string>(ELEMENT_IDS);
const GOOD = "#3ddc84", BAD = "#ff4d6d";
/** Decisive games a combo needs before it can rank as best/worst. */
const MIN_COMBO_GAMES = 3;
const COMBO_ROWS = 5;
const TABLE_ROWS = 12;

const label = (name: string): string => LABELS[name] ?? name;
const arenaName = (k: string): string => (ARENA_INFO as Partial<Record<string, { name: string }>>)[k]?.name ?? k;
const weatherName = (k: string): string => (WEATHERS as Partial<Record<string, Weather>>)[k]?.name ?? k;

/** "+1.23" / "−0.40" / "0.00" (rounded before choosing the sign). */
function signed(v: number, d = 2): string {
  const r = Math.round(v * 10 ** d) / 10 ** d;
  return `${r > 0 ? "+" : r < 0 ? "−" : ""}${fmt(Math.abs(r), d)}`;
}

function playerName(app: App, id: string): string {
  const p = app.store.get(id);
  if (p) return `${p.kind === "ai" ? "🤖" : "🙂"} ${p.name}`;
  return OTHER_PLAYERS[id] ?? id;
}

/** "air+fire" as two element chips; synergy ids ("bellows") as text. */
function comboCell(key: string): HTMLElement {
  const parts = key.split("+");
  if (parts.length === 2 && parts.every((p) => ELEMENTS_SET.has(p))) {
    return h("span", { class: "row" }, elChip(parts[0] as ElementId), elChip(parts[1] as ElementId));
  }
  return h("span", { class: "mono", title: "team synergy" }, key);
}

/** "arena:volcano" -> "Ember Caldera", "weather:storm" -> "Thunderstorm". */
function offsetLabel(key: string): string {
  if (key.startsWith("arena:")) return arenaName(key.slice(6));
  if (key.startsWith("weather:")) return weatherName(key.slice(8));
  return key;
}

// ------------------------------------------------------------------------------------ sections

function rankingSection(app: App, ladder: Ladder): HTMLElement {
  const rows = ladder.table();
  const rated = new Set(rows.map((r) => r.id));
  const unrated = app.store.list().filter((p) => !rated.has(p.id));
  const me = app.profile.id;
  const nameCell = (id: string, extra: string) =>
    h("td", {}, id === me ? h("b", {}, playerName(app, id)) : playerName(app, id), extra ? h("span", { class: "muted" }, ` · ${extra}`) : null);
  return section("Ranking",
    h("table", { class: "t" },
      h("tr", {}, h("th", {}, "#"), h("th", {}, "Player"), h("th", {}, "Rating"), h("th", {}, "Games"), h("th", {}, "W/L/D")),
      ...rows.map((r, i) =>
        h("tr", {},
          h("td", {}, String(i + 1)),
          nameCell(r.id, [r.id === me ? "you" : "", r.provisional ? "provisional" : ""].filter(Boolean).join(" · ")),
          h("td", { class: "mono" }, fmt(r.rating)),
          h("td", {}, String(r.games)),
          h("td", {}, `${r.wins}/${r.losses}/${r.draws}`))
      ),
      ...unrated.map((p) =>
        h("tr", {},
          h("td", {}, "–"),
          nameCell(p.id, p.id === me ? "you · no ladder games" : "no ladder games"),
          h("td", { class: "mono" }, fmt(ladder.base)),
          h("td", {}, "0"),
          h("td", {}, "0/0/0"))
      )),
    h("p", { class: "muted" },
      `Provisional = fewer than ${ladder.provisionalGames} games: the rating moves ${fmt(ladder.provisionalMult)}× faster. Rival trainers, wild swarms and mirror matches are rated like any player.`));
}

function lastMatchSection(app: App, last: LastMatch): HTMLElement {
  const me = app.profile.id;
  const mine = last.a === me || last.b === me;
  const flip = last.b === me && last.a !== me;
  const s = flip ? -1 : 1;
  const E = flip ? 1 - last.expected : last.expected;
  const E0 = flip ? 1 - last.ratingOnly : last.ratingOnly;
  const delta = flip ? last.deltaB : last.deltaA;
  const score = flip ? 1 - last.scoreA : last.scoreA;
  const z = s * (last.ratingLogit + last.contextLogit);
  const opp = playerName(app, flip ? last.a : last.b);
  const who = mine ? "you" : playerName(app, last.a);
  const Who = mine ? "You" : who;
  const your = mine ? "your" : `${who}'s`;
  const outcome = score === 1 ? "won" : score === 0 ? "lost" : "drew";
  const conditions = E < E0 - 0.01
    ? `The conditions were against ${who}: they lowered the expected score from ${pct(E0)} to ${pct(E)}.`
    : E > E0 + 0.01
    ? `The conditions favoured ${who}: they raised the expected score from ${pct(E0)} to ${pct(E)}.`
    : "The conditions barely changed the expectation (the ladder weighs them by what it has learned so far).";
  const plain = last.k * (score - E0);
  const lesson = score === 1 && E < E0 - 0.01
    ? "A win against the conditions pays more than a win they hand over."
    : score === 0 && E > E0 + 0.01
    ? "Losing a match the conditions set up to win costs more."
    : score === 0 && E < E0 - 0.01
    ? "With the conditions against, this loss costs less."
    : score === 1 && E > E0 + 0.01
    ? "With the conditions helping, this win pays less."
    : "";
  const shown = last.top.reduce((acc, c) => acc + c.logit, 0);
  const rest = s * (last.contextLogit - shown);
  const effect = (logit: number): number => 100 * (sigmoid(z) - sigmoid(z - logit));
  return section("Why the last match moved your rating",
    h("p", {}, `${Who} ${outcome} against ${opp} in ${arenaName(last.arena)} (${weatherName(last.weather)}, ${last.winCondition || "result"}).`),
    h("dl", { class: "kv" },
      h("dt", {}, "Expected win chance"), h("dd", {}, `${pct(E)} with the conditions · ${pct(E0)} from the ratings alone`),
      h("dt", {}, "Rating change"), h("dd", {}, `${signed(delta, 1)} = K ${fmt(last.k, 1)} × (${fmt(score, 1)} − ${fmt(E, 2)})`),
      h("dt", {}, "Ratings alone"), h("dd", {}, `would have moved it ${signed(plain, 1)}`)),
    h("p", {}, `${conditions} ${lesson}`.trim()),
    h("table", { class: "t" },
      h("tr", {}, h("th", {}, "Condition"), h("th", {}, `For ${who}`), h("th", {}, "Weight"), h("th", {}, `Effect on ${your} win chance`)),
      ...last.top.map((c) => {
        const v = s * c.value;
        const side = Math.abs(v) < 0.02 ? "even" : v > 0 ? `favoured ${who}` : `favoured ${opp}`;
        const pts = effect(s * c.logit);
        const words = Math.abs(c.weight) < 0.005
          ? "none yet: weight not learned"
          : Math.abs(pts) < 0.05
          ? "negligible"
          : `${signed(pts, 1)} pts ${pts > 0 ? `for ${who}` : `against ${who}`}`;
        return h("tr", {},
          h("td", { title: NOTES.get(c.name) ?? "" }, label(c.name)),
          h("td", {}, `${signed(v)} (${side})`),
          h("td", { class: "mono" }, signed(c.weight)),
          h("td", {}, words));
      }),
      Math.abs(rest) > 0.0005
        ? h("tr", {}, h("td", { class: "muted" }, "All other conditions"), h("td", {}, ""), h("td", {}, ""), h("td", { class: "muted" }, `${signed(effect(rest), 1)} pts`))
        : null),
    h("p", { class: "muted" }, "For: how much the condition tilted the match (−1 … +1). Weight: what the ladder has learned the condition is worth in this arena and weather (log-odds per unit). Effect: points of expected score it added or removed."));
}

function weightsSection(ladder: Ladder): HTMLElement {
  const w = ladder.weights();
  const st = ladder.conditionStats();
  const shares = (es: ConditionEntry[]) => {
    const n = es.reduce((acc, e) => acc + e.games, 0);
    return es.map((e) => ({ key: e.key, p: n > 0 ? e.games / n : 0 }));
  };
  const arenas = shares(st.byArena), weathers = shares(st.byWeather);
  const names = [...FEATURES.map((f) => f.name), ...Object.keys(w).filter((k) => !k.includes("|") && !NOTES.has(k))];
  const rows = names.map((name) => {
    // Effective weight (global + arena offset + weather offset) averaged over the matches played:
    // the split between global and offsets alone is not identifiable, only the sum is.
    const eff = (w[name] ?? 0) +
      arenas.reduce((acc, a) => acc + a.p * (w[`${name}|arena:${a.key}`] ?? 0), 0) +
      weathers.reduce((acc, x) => acc + x.p * (w[`${name}|weather:${x.key}`] ?? 0), 0);
    let top: { key: string; v: number } | null = null;
    for (const [k, v] of Object.entries(w)) {
      if (k.startsWith(`${name}|`) && Math.abs(v) > Math.abs(top?.v ?? 0)) top = { key: k.slice(name.length + 1), v };
    }
    return { name, eff, top };
  });
  const scale = Math.max(1, ...rows.map((r) => Math.abs(r.eff)));
  return section("What the ladder has learned",
    h("p", { class: "muted" }, "Learned weight of each condition (log-odds per unit), averaged over the arenas and weathers played. Green: the side a condition favours wins more often than the ratings alone predict, so it raises that side's expected score. Red: the favoured side does worse than expected. Near zero: no measurable effect yet - weights start at 0 and grow with every ladder match."),
    ...rows.map((r) =>
      h("div", {},
        h("div", { class: "row" }, h("b", {}, label(r.name)), h("span", { class: "spacer" }), h("span", { class: "mono" }, signed(r.eff))),
        bar(Math.abs(r.eff) / scale, r.eff >= 0 ? GOOD : BAD),
        h("p", { class: "muted" },
          NOTES.get(r.name) ?? "",
          r.top && Math.abs(r.top.v) >= 0.05 ? ` Strongest offset: ${offsetLabel(r.top.key)} ${signed(r.top.v)}.` : ""))
    ));
}

function entriesTable(title: string, keyHeader: string, es: readonly ConditionEntry[], cell: (key: string) => HTMLElement | string): HTMLElement {
  const shown = es.slice(0, TABLE_ROWS);
  return h("div", {},
    h("h3", {}, title),
    h("table", { class: "t" },
      h("tr", {}, h("th", {}, keyHeader), h("th", {}, "Games"), h("th", {}, "W/L/D"), h("th", {}, "Win rate"), h("th", {}, "95% interval"), h("th", { title: "Mean pre-match expected score: compare with the win rate" }, "Expected")),
      ...shown.map((e) => {
        const decisive = e.wins + e.losses > 0;
        return h("tr", {},
          h("td", {}, cell(e.key)),
          h("td", {}, String(e.games)),
          h("td", {}, `${e.wins}/${e.losses}/${e.draws}`),
          h("td", {}, decisive ? pct(e.winRate) : "–"),
          h("td", { class: "muted" }, decisive ? `${pct(e.lo)}–${pct(e.hi)}` : "no decisive game"),
          h("td", { class: "muted" }, pct(e.expected)));
      })),
    es.length > shown.length ? h("p", { class: "muted" }, `+ ${es.length - shown.length} more`) : null);
}

function conditionsSection(app: App, ladder: Ladder): HTMLElement {
  const mine = ladder.conditionStats(app.profile.id);
  const fav = ladder.conditionStats();
  const played = ladder.games(app.profile.id) > 0;
  return section("Results by condition",
    h("p", { class: "muted" }, "Win rates exclude draws; the 95% Wilson interval shows how sure the number is (wide = few games). Expected is the ladder's mean pre-match win chance, so a win rate well above it means you beat the conditions there."),
    played
      ? h("div", {},
        entriesTable("Your arenas", "Arena", mine.byArena, arenaName),
        entriesTable("Your weathers", "Weather", mine.byWeather, weatherName),
        entriesTable("Your combos", "Combo", mine.byCombo, comboCell))
      : h("p", {}, `${playerName(app, app.profile.id)} has no ladder games yet.`),
    entriesTable("Favourite's results per arena (model check)", "Arena", fav.byArena, arenaName),
    h("p", { class: "muted" }, "Seen from the side the ladder favoured before each match: if the favourite wins far less often than expected in an arena, the model still misreads that arena."));
}

function combosSection(ladder: Ladder): HTMLElement {
  const best = ladder.bestCombos(Infinity, MIN_COMBO_GAMES).filter((e) => e.winRate > 0.5).slice(0, COMBO_ROWS);
  const worst = ladder.worstCombos(Infinity, MIN_COMBO_GAMES).filter((e) => e.winRate < 0.5).slice(0, COMBO_ROWS);
  const table = (title: string, es: readonly ConditionEntry[]) =>
    h("div", {},
      h("h3", {}, title),
      es.length
        ? h("table", { class: "t" },
          h("tr", {}, h("th", {}, "Combo"), h("th", {}, "W–L"), h("th", {}, "Win rate"), h("th", {}, "95% interval")),
          ...es.map((e) =>
            h("tr", {}, h("td", {}, comboCell(e.key)), h("td", {}, `${e.wins}–${e.losses}`), h("td", {}, pct(e.winRate)), h("td", { class: "muted" }, `${pct(e.lo)}–${pct(e.hi)}`))
          ))
        : h("p", { class: "muted" }, `No combo qualifies yet (needs ${MIN_COMBO_GAMES} decisive games).`));
  return section("Best and worst combos",
    h("div", { class: "grid2" }, table("Best", best), table("Worst", worst)),
    h("p", { class: "muted" }, `All players' matches. A combo (team synergy or pair of primary elements) is credited with the result of the side that fielded it. Best ranks by the low end of the 95% interval (confidently good), worst by the high end (confidently bad), so a lucky 1-0 never outranks an 8-2. The track record feeds back into the expected score as "${label(COMBO_FEATURE)}".`));
}

function featureListSection(): HTMLElement {
  return section("What counts",
    h("table", { class: "t" },
      ...FEATURES.map((f) => h("tr", {}, h("td", {}, label(f.name)), h("td", { class: "muted" }, f.note)))));
}

// ------------------------------------------------------------------------------------ screen

export function renderLadder(app: App): HTMLElement {
  const ladder = getLadder(app);
  const intro = h("p", {},
    "Your rating moves by K × (result − expected). The expected score uses both ratings AND the match conditions: type advantage, arena ground, weather, time of day, team power, synergy, size, reach and your combos' track record. A win when the conditions were against you pays more; a loss when they favoured you costs more. How much each condition matters is learned from every ladder match.");
  if (ladder.matches === 0) {
    return h("div", {},
      h("h1", {}, "Ladder"),
      intro,
      section("No ladder battles yet",
        h("p", {}, "Fight a few ladder battles to fill this page."),
        h("p", { class: "muted" }, "Every Arena battle counts, against a rival trainer, another profile, a wild swarm or your mirror."),
        h("button", { class: "btn primary", onclick: () => app.go("arena") }, "⚔ Go to the Arena")),
      featureListSection());
  }
  const last = loadLastMatch(localStorage);
  return h("div", {},
    h("h1", {}, "Ladder"),
    intro,
    rankingSection(app, ladder),
    last ? lastMatchSection(app, last) : null,
    weightsSection(ladder),
    conditionsSection(app, ladder),
    combosSection(ladder),
    h("p", { class: "muted" }, `${ladder.matches} ladder match${ladder.matches === 1 ? "" : "es"} recorded. Each one is a ladder.match row in the Data screen's ledger.`));
}
