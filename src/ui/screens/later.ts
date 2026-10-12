/**
 * Screens whose engines are being built by the builder agents (world map, auction house,
 * condition-aware ladder). They already show the real data available today and say plainly what
 * is pending, so nothing reads as delivered before it is wired (see docs/SPEC.md statuses).
 */
import type { App } from "../app.ts";
import { WEATHERS } from "../../data/weather.ts";
import { fmt, h, section } from "../dom.ts";

export function renderWorld(app: App): HTMLElement {
  const rw = app.rw;
  return h("div", {},
    h("h1", {}, "World"),
    h("p", {}, "A map of real places around you (x east, y altitude, z north) where you defend your home, shop food at the supermarket, train at the gym and claim territories. Some actions need you to physically move; arenas and dungeons can be reached virtually."),
    section("Your context",
      h("dl", { class: "kv" },
        h("dt", {}, "Time"), h("dd", {}, `${rw.now.toLocaleString()} (${rw.dayPhase})`),
        h("dt", {}, "Weather of the day"), h("dd", {}, WEATHERS[rw.weather].name),
        h("dt", {}, "Home"), h("dd", {}, app.profile.home ? `${app.profile.home.lat.toFixed(3)}, ${app.profile.home.lon.toFixed(3)}` : "not set (location is opt-in)"))),
    section("Status", h("p", { class: "muted" }, "Integration pending: the world-map engine (places, territories, spawn ecology, physical vs virtual rules) is being built in src/world/worldmap.ts - quest W1 in docs/QUESTS.md.")),
  );
}

export function renderMarket(_app: App): HTMLElement {
  return h("div", {},
    h("h1", {}, "Market"),
    h("p", {}, "A real auction house: timed listings, bids and buyouts, anti-sniping, company promotions, NPC traders and other players."),
    section("Status", h("p", { class: "muted" }, "Integration pending: the auction-house engine is being built in src/economy/market.ts - quest E1 in docs/QUESTS.md.")),
  );
}

export function renderLadder(app: App): HTMLElement {
  const ps = app.store.list().slice().sort((a, b) => b.mmr - a.mmr);
  const hist = app.profile.history;
  const by = (key: "arena" | "weather") => {
    const m = new Map<string, { w: number; n: number }>();
    for (const x of hist) {
      if (x.won === 2) continue;
      const k = x[key];
      const e = m.get(k) ?? { w: 0, n: 0 };
      e.n++;
      if (x.won === 0) e.w++;
      m.set(k, e);
    }
    return [...m.entries()].sort((a, b) => b[1].n - a[1].n);
  };
  return h("div", {},
    h("h1", {}, "Ladder"),
    h("p", {}, "MMR that does not only count the opponent's rating: arena, weather, type advantage, synergies and size are features of the expected score, so a win in bad conditions is worth more."),
    section("Profiles", h("table", { class: "t" }, h("tr", {}, h("th", {}, "#"), h("th", {}, "Profile"), h("th", {}, "MMR"), h("th", {}, "W/L/D")),
      ...ps.map((p, i) => h("tr", {}, h("td", {}, String(i + 1)), h("td", {}, `${p.kind === "ai" ? "🤖" : "🙂"} ${p.name}`), h("td", {}, fmt(p.mmr)), h("td", {}, `${p.stats.wins}/${p.stats.losses}/${p.stats.draws}`))))),
    section("Your conditions (decisive battles)",
      h("table", { class: "t" }, h("tr", {}, h("th", {}, "Arena"), h("th", {}, "Win rate"), h("th", {}, "n")), ...by("arena").map(([k, v]) => h("tr", {}, h("td", {}, k), h("td", {}, `${Math.round((v.w / v.n) * 100)}%`), h("td", {}, String(v.n))))),
      h("table", { class: "t" }, h("tr", {}, h("th", {}, "Weather"), h("th", {}, "Win rate"), h("th", {}, "n")), ...by("weather").map(([k, v]) => h("tr", {}, h("td", {}, k), h("td", {}, `${Math.round((v.w / v.n) * 100)}%`), h("td", {}, String(v.n)))))),
    section("Status", h("p", { class: "muted" }, "Today: plain Elo (K=24). Integration pending: the condition-aware MMR (learned context weights, best/worst combos, Wilson intervals) from src/ladder/mmr.ts - quest L1.")),
  );
}
