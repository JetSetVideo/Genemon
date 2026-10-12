import type { App, BattleOptions } from "../app.ts";
import { ARENA_INFO, ARENA_KINDS, type ArenaKind } from "../../world/arena.ts";
import { WEATHER_IDS, WEATHERS, type WeatherId } from "../../data/weather.ts";
import { fmt, h, section, select } from "../dom.ts";

const opts: BattleOptions = { arena: "meadow", weather: "auto", hour: "real", opponent: "rival" };

export function renderArena(app: App): HTMLElement {
  const bv = app.battleView;
  const res = app.lastResult;
  const root = h("div", {});
  if (bv && !res) {
    const b = bv.battle;
    root.append(
      h("h1", {}, "Battle in progress"),
      h("p", {}, `${ARENA_INFO[b.arena.spec.kind].name} · started in ${WEATHERS[b.setup.arena.weather].name} · ${Math.floor(b.setup.arena.hour)}h (live weather: bottom of the 3D view). ${WEATHERS[b.setup.arena.weather].note}`),
      section("Controls",
        h("p", { class: "muted" }, "Camera buttons are on the right edge of the 3D view ", h("span", { class: "kbd-only" }, "(keys 1-6). Space pauses."), h("span", { class: "touch-only" }, "(tap them). ⏯ pauses.")),
        h("div", { class: "row" }, ...[0.5, 1, 2, 3].map((s) => h("button", { class: `btn small ${app.profile.settings.speed === s ? "on" : ""}`, onclick: () => app.updateSettings({ speed: s }) }, `${s}×`)),
          h("button", { class: "btn small", onclick: () => app.togglePause() }, "⏯ pause")),
        h("button", { class: "btn", onclick: () => {
          app.abandonBattle();
          app.go("arena");
        } }, app.lastBattle?.opts.ranked ? "Forfeit (counts as a loss)" : "Abandon practice battle")),
      section("Teams",
        ...b.setup.teams.map((t, i) => h("p", {}, h("b", {}, `${i === 0 ? "You" : "Opponent"}: `), `${t.name} - ${t.members.map((g) => g.name).join(", ")}`)),
        h("p", { class: "muted" }, `Synergies: ${b.synergies[0].map((s) => s.name).join(", ") || "none"} vs ${b.synergies[1].map((s) => s.name).join(", ") || "none"}`)),
    );
    return root;
  }
  if (res) {
    const b = bv?.battle;
    const won = res.winner === 0, draw = res.winner === 2;
    const rec = app.profile.history[0];
    root.append(
      h("h1", {}, draw ? "Draw" : won ? "Victory!" : "Defeat"),
      section("Result",
        h("dl", { class: "kv" },
          h("dt", {}, "Duration"), h("dd", {}, `${fmt(res.duration, 1)} s (${res.reason})`),
          h("dt", {}, "MVP"), h("dd", {}, b?.fighters.find((f) => f.id === res.mvp)?.name ?? "-"),
          h("dt", {}, "Reactions"), h("dd", {}, Object.entries(res.reactions).map(([k, v]) => `${k}×${v}`).join(", ") || "none"),
          h("dt", {}, "Weather"), h("dd", {}, res.weatherStart === res.weatherEnd ? res.weatherStart : `${res.weatherStart} → ${res.weatherEnd}`),
          h("dt", {}, "MMR"), h("dd", {}, rec ? `${rec.mmrDelta >= 0 ? "+" : ""}${rec.mmrDelta} → ${Math.round(app.profile.mmr)}` : "-")),
        h("table", { class: "t" },
          h("tr", {}, h("th", {}, "Genemon"), h("th", {}, "Side"), h("th", {}, "Dealt"), h("th", {}, "Hits"), h("th", {}, "Crits"), h("th", {}, "KOs"), h("th", {}, "HP")),
          ...res.fighters.map((f) => h("tr", {}, h("td", {}, f.name), h("td", {}, f.team === 0 ? "you" : "opp"), h("td", {}, fmt(f.tally.dealt)), h("td", {}, `${f.tally.hits}/${f.tally.hits + f.tally.misses}`), h("td", {}, String(f.tally.crits)), h("td", {}, String(f.tally.kos)), h("td", {}, `${Math.round(f.hpFrac * 100)}%`))))),
      h("div", { class: "row" },
        h("button", { class: "btn primary", title: "Replays the same seed: no XP, no rating", onclick: () => app.lastBattle && app.startBattle({ ...app.lastBattle.opts, seed: app.lastBattle.seed }) }, "↻ Rematch (same seed, unrated)"),
        h("button", { class: "btn", onclick: () => app.startBattle({ ...opts }) }, "New battle"),
        h("button", { class: "btn", onclick: () => {
          app.closeBattle();
          app.lastResult = null;
          app.go("arena");
        } }, "Close")),
      h("p", { class: "muted" }, "Same seed + same teams = the same battle (deterministic replays: the basis of online anti-cheat)."),
    );
    return root;
  }
  const others = app.store.list().filter((p) => p.id !== app.profile.id);
  root.append(
    h("h1", {}, "Arena"),
    h("p", {}, "Instant battle: your team (in attack order) against an opponent, in a physical 3D arena with its own ground types, topography and weather."),
    section("Arena",
      h("div", { class: "cards" }, ...ARENA_KINDS.map((k) => h("button", { class: `gcard ${opts.arena === k ? "sel" : ""}`, "data-arena": k, title: ARENA_INFO[k].note, onclick: () => {
        opts.arena = k as ArenaKind;
        app.render();
      } }, h("span", { class: "name" }, ARENA_INFO[k].name), h("span", { class: "muted" }, ARENA_INFO[k].note)))),
    ),
    section("Conditions",
      h("div", { class: "grid2" },
        h("label", { class: "field" }, "Weather", select(["auto", ...WEATHER_IDS] as ("auto" | WeatherId)[], opts.weather, (v) => {
          opts.weather = v;
        })),
        h("label", { class: "field" }, "Time of day", select(["real", "6", "9", "13", "18", "21", "0"], String(opts.hour), (v) => {
          opts.hour = v === "real" ? "real" : Number(v);
        }))),
      h("p", { class: "muted" }, opts.weather === "auto" ? `Auto uses today's real weather (${WEATHERS[app.rw.weather].name}) when it fits the arena.` : WEATHERS[opts.weather as WeatherId].note)),
    section("Opponent",
      h("label", { class: "field" }, "Who", select(["rival", "profile", "wild", "mirror"] as const, opts.opponent, (v) => {
        opts.opponent = v;
        app.render();
      })),
      opts.opponent === "profile" && others.length
        ? h("label", { class: "field" }, "Profile", select(others.map((p) => ({ value: p.id, label: `${p.name} (${Math.round(p.mmr)})` })), opts.opponentProfile ?? others[0].id, (v) => {
          opts.opponentProfile = v;
        }))
        : null,
      h("p", { class: "muted" }, { rival: "An AI trainer with a balanced team at your level.", profile: "Another profile's team (you vs me).", wild: "A swarm of wild Genemon.", mirror: "Your own team against itself." }[opts.opponent])),
    section("Ranked",
      h("p", { class: "muted" }, "Rated battles move your condition-aware MMR. The ladder draws the arena; your real hour and today's weather apply. Each seed pays XP and rating once."),
      h("div", { class: "row" },
        h("button", { class: "btn primary big", "data-action": "ranked-battle", onclick: () => app.startRanked(opts.opponent === "profile" ? "profile" : "rival", opts.opponent === "profile" ? (opts.opponentProfile ?? others[0]?.id) : undefined) }, "♛ Ranked battle"))),
    h("button", { class: "btn big", "data-action": "start-battle", title: "Practice: you pick the conditions, nothing is rated", onclick: () => app.startBattle({ ...opts }) }, "⚔ Practice battle (unrated)"),
  );
  return root;
}
