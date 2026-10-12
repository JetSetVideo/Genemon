// Persona simulation: the 12 personas live N weeks in one shared world through the real engine.
//   deno task sim [weeks=4] [seed=1]
// Writes artifacts/sim/REPORT.md (readable tables) + artifacts/sim/report.json and prints a summary.
import { simulate, type SimReport } from "../src/sim/simulate.ts";

const weeks = Number(Deno.args[0] ?? 4);
const seed = Number(Deno.args[1] ?? 1);
if (!(weeks > 0) || !Number.isFinite(seed)) {
  console.error("usage: deno task sim [weeks>0] [seed]");
  Deno.exit(2);
}
// Fixed start (Monday 2026-10-05 00:00 Paris): a run must not depend on the wall clock.
const START_MS = Date.UTC(2026, 9, 4, 22, 0, 0);

const t0 = performance.now();
const r = simulate({ weeks, seed, startMs: START_MS });
const secs = (performance.now() - t0) / 1000;

const pct = (x: number | null) => (x === null ? "-" : `${Math.round(x * 100)}%`);
const wl = (t: { wins: number; losses: number; draws: number }) => `${t.wins}/${t.losses}/${t.draws}`;
const table = (head: string[], rows: (string | number)[][]) =>
  [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((x) => `| ${x.join(" | ")} |`)].join("\n");

function markdown(r: SimReport): string {
  const m = r.market, w = r.world, b = r.balance;
  const out: string[] = [];
  out.push(`# Persona simulation report`, ``, `Command: \`deno task sim ${weeks} ${seed}\` - ${r.meta.days} days, ${r.personas.length} personas, ${r.meta.rows} ledger rows, ${r.meta.marketRounds} market rounds, run time ${secs.toFixed(1)} s.`, ``);
  out.push(`## Players`, ``);
  out.push(table(
    ["persona", "style", "sessions", "play h (plan)", "phys h", "battles W/L/D", "ranked W/L/D", "rating (rank)", "collection", "dex / goal", "bred (max gen)", "achievements", "credits", "trades"],
    r.personas.map((p) => [
      `${p.name} (${p.id})`, `${p.style}/${p.secondaryStyle}`, p.sessions, `${p.playHours.toFixed(1)} (${p.expectedPlayHours.toFixed(1)})`, p.physicalHours.toFixed(1),
      wl(p.battles), wl(p.ranked), p.rating === null ? "unrated" : `${Math.round(p.rating)} (#${p.rank})`, p.collection, `${p.pokedex} / ${p.pokedexGoal}`,
      `${p.bred} (${p.maxGeneration})`, p.achievements.length, p.credits, p.trades,
    ]),
  ));
  out.push(``, `## Favourite moves, world and frustrations`, ``);
  out.push(table(
    ["persona", "top moves (casts)", "declared favourites cast", "places", "territories (claims/takeovers/lost)", "caught (on site)", "released", "denied physical", "companion", "frustrations"],
    r.personas.map((p) => [
      p.id, p.favouriteMoves.map((x) => `${x.move} ${x.uses}`).join(", ") || "-", p.declaredFavouriteCasts, p.placesDiscovered,
      `${p.territories} (${p.claims}/${p.takeovers}/${p.cellsLost})`, `${p.caught} (${p.caughtOnSite})`, p.released, p.deniedPhysical,
      `${p.companion.primary} L${p.companion.level} hunger ${p.companion.hunger}`, Object.entries(p.frustrations).map(([k, v]) => `${k} ${v}`).join(", ") || "-",
    ]),
  ));
  out.push(``, `## Hours played by hour of day`, ``);
  out.push(table(["persona", ...Array.from({ length: 24 }, (_, h) => String(h))], r.personas.map((p) => [p.id, ...p.hoursByHour.map((x) => (x > 0 ? x.toFixed(1) : "."))])));
  out.push(``, `## Balance`, ``);
  out.push(table(["style", "games", "W/L/D", "win rate"], b.winRateByStyle.map((s) => [s.style, s.games, wl(s), pct(s.winRate)])));
  out.push(``, `Rated ranked matches ${b.rankedMatches}; battles ${b.battles}; draw rate ${pct(b.drawRate)}; mean duration ${b.meanDurationS.toFixed(1)} s.`);
  out.push(`Rating spread: n=${b.ratingSpread.n} min ${b.ratingSpread.min} max ${b.ratingSpread.max} sd ${b.ratingSpread.sd} IQR ${b.ratingSpread.iqr}; Spearman(skill, rating) ${b.ratingSpread.spearmanSkill ?? "-"}.`);
  out.push(`Empty ranked queue by hour: ${b.emptyQueueByHour.join(" ")}`, ``);
  out.push(table(["element", "casts", "share"], b.elementUsage.map((e) => [e.element, e.casts, pct(e.share)])));
  out.push(``, `Element usage entropy (1 = perfectly even over 14): ${b.elementEntropy}`, ``);
  out.push(`## World`, ``);
  out.push(`Places ${w.places}, discovered ${w.placesDiscovered}; claims ${w.claims}, takeovers ${w.takeovers}, failed raids ${w.failedRaids}, cells lost while the owner slept ${w.lostWhileAsleep}.`);
  out.push(`Catches on site ${w.catchesOnSite}, virtual ${w.catchesVirtual}; by rarity ${JSON.stringify(w.catchesByRarity)}.`, ``);
  const els = [...new Set([...Object.keys(w.catchesByElement), ...Object.keys(w.releasesByElement)])].sort();
  out.push(table(["element", "caught", "released"], els.map((e) => [e, w.catchesByElement[e] ?? 0, w.releasesByElement[e] ?? 0])));
  out.push(``, `## Market`, ``);
  out.push(`Trades ${m.trades} (${m.personaTrades} involve a persona), units ${m.unitsTraded}, credits ${m.creditsTraded}; open listings ${m.openListings}; wallet Gini ${m.walletGini}.`);
  out.push(`Money: opening balances ${m.openingBalances}, reward faucet ${m.rewardFaucet}, NPC refills ${m.npcRefills}; supply ${JSON.stringify(m.moneySupply)}.`, ``);
  out.push(table(["item", "trades", "units", "median unit price", "list price", "median / list"], m.items.map((x) => [x.itemId, x.trades, x.units, x.median, x.list, x.drift])));
  out.push(``, `## Ledger rows by kind`, ``, table(["what", "rows"], Object.entries(r.meta.rowsByWhat).slice(0, 30)));
  return out.join("\n") + "\n";
}

await Deno.mkdir("artifacts/sim", { recursive: true });
await Deno.writeTextFile("artifacts/sim/report.json", JSON.stringify(r, null, 2) + "\n");
await Deno.writeTextFile("artifacts/sim/REPORT.md", markdown(r));

const b = r.balance, m = r.market, w = r.world;
const top = [...r.personas].filter((p) => p.rating !== null).sort((x, y) => (x.rank ?? 99) - (y.rank ?? 99));
const lines = [
  `sim ${weeks} week(s), seed ${seed}: ${r.meta.days} days, ${r.personas.length} personas, ${r.meta.rows} ledger rows, ${secs.toFixed(1)} s`,
  `sessions ${r.personas.reduce((s, p) => s + p.sessions, 0)}, play hours ${r.personas.reduce((s, p) => s + p.playHours, 0).toFixed(0)} (timetable plan ${r.personas.reduce((s, p) => s + p.expectedPlayHours, 0).toFixed(0)}), physical ${r.personas.reduce((s, p) => s + p.physicalHours, 0).toFixed(0)} h`,
  `battles ${b.battles} (rated ranked ${b.rankedMatches}), draw rate ${pct(b.drawRate)}, mean ${b.meanDurationS.toFixed(1)} s`,
  `ladder: ${top.slice(0, 3).map((p) => `#${p.rank} ${p.id} ${Math.round(p.rating!)}`).join(", ")} ... last ${top.at(-1)?.id ?? "-"} ${Math.round(top.at(-1)?.rating ?? 0)}`,
  `rating spread sd ${b.ratingSpread.sd}, range ${Math.round(b.ratingSpread.min)}-${Math.round(b.ratingSpread.max)}, Spearman(skill, rating) ${b.ratingSpread.spearmanSkill ?? "-"}`,
  `win rate by style: ${b.winRateByStyle.map((s) => `${s.style} ${pct(s.winRate)}`).join(", ")}`,
  `empty ranked queue: ${r.personas.reduce((s, p) => s + p.queueEmpty, 0)} times; unrated personas: ${r.personas.filter((p) => p.rating === null).map((p) => p.id).join(", ") || "none"}`,
  `elements cast: ${b.elementUsage.slice(0, 4).map((e) => `${e.element} ${pct(e.share)}`).join(", ")} ... entropy ${b.elementEntropy}`,
  `catches ${w.catchesOnSite} on site + ${w.catchesVirtual} virtual, releases ${Object.values(w.releasesByElement).reduce((s, x) => s + x, 0)}, bred ${r.personas.reduce((s, p) => s + p.bred, 0)}`,
  `world: ${w.placesDiscovered}/${w.places} places discovered, claims ${w.claims}, takeovers ${w.takeovers}, lost while asleep ${w.lostWhileAsleep}`,
  `territories: ${Object.entries(w.territories).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`,
  `market: ${m.trades} trades (${m.personaTrades} with personas), ${m.creditsTraded} credits, open listings ${m.openListings}, wallet Gini ${m.walletGini}`,
  `achievements: ${r.personas.map((p) => `${p.id} ${p.achievements.length}`).join(", ")}`,
  `pokedex: ${r.personas.map((p) => `${p.id} ${p.pokedex}/${p.pokedexGoal}`).join(", ")}`,
  `frustrations: ${Object.entries(r.personas.reduce((acc, p) => { for (const [k, v] of Object.entries(p.frustrations)) acc[k] = (acc[k] ?? 0) + v; return acc; }, {} as Record<string, number>)).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`,
];
console.log(lines.join("\n"));
console.log(`wrote artifacts/sim/REPORT.md and artifacts/sim/report.json (run time ${secs.toFixed(1)} s)`);
