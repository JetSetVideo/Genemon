// deno-lint-ignore-file no-explicit-any
/**
 * Pass-5 long-loop probe in real Chrome [P5-L1, P5-D1, P5-G3..G5]: demo time scale ages the team
 * (fake clock fast-forward), phases advance, the stomach digests, overfeeding past the limit needs the
 * "no food limit" toggle and bloats, unlimited credits top up, an ancient Genemon is benched from ranked.
 *   deno task build && deno run -A tools/p5life.ts
 */
import { chromium } from "playwright";
import { serveAsset } from "./serve.ts";
const server = Deno.serve({ hostname: "127.0.0.1", port: 8827, onListen: () => {} }, (r) => serveAsset(r));
const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, args: ["--use-angle=metal", "--ignore-gpu-blocklist", "--enable-webgl"] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await ctx.clock.install({ time: new Date("2026-10-22T10:00:00") });
const page = await ctx.newPage();
const errs: string[] = [];
page.on("pageerror", (e) => errs.push(e.message));
page.on("console", (m) => m.type() === "error" && errs.push(m.text()));
await page.goto("http://127.0.0.1:8827", { waitUntil: "load" });
await page.clock.runFor(3000);
await page.waitForFunction(() => !!(globalThis as any).__GENEMON__);
const checks: [string, boolean, unknown][] = [];
const check = (n: string, ok: boolean, d: unknown) => { checks.push([n, ok, d]); console.log(ok ? "PASS" : "FAIL", n, JSON.stringify(d)); };
const state = () => page.evaluate(() => {
  const a = (globalThis as any).__GENEMON__.app;
  return { credits: a.profile.credits, rows: a.ledger.counts()["genemon.life"] ?? 0, team: a.profile.collection.slice(0, 3).map((g: any) => ({ age: +g.conditions.ageDays.toFixed(1), phase: a.life?.phaseOf?.(g) ?? null, hunger: +g.conditions.hunger.toFixed(2), stomach: g.life?.digestion?.stomach?.length ?? 0 })) };
});
const s0 = await state();
// 1. feed one, then a week per real minute for 10 minutes
await page.evaluate(() => {
  const a = (globalThis as any).__GENEMON__.app;
  a.updateSettings({ dev: { timeScale: 10080, unlimitedCredits: true, noFoodLimit: false } });
  return true;
});
await page.clock.runFor(10 * 60_000);
const s1 = await state();
check("time scale ages the team (~70 days in 10 min)", s1.team[0].age - s0.team[0].age > 40, { s0: s0.team, s1: s1.team });
check("genemon.life ledger rows written", s1.rows > s0.rows, { before: s0.rows, after: s1.rows });
check("unlimited credits topped up", s1.credits >= 1e9, s1.credits);
// 2. overfeeding: refused without the toggle, accepted with it, bloat follows
const feed = await page.evaluate(() => {
  const G = (globalThis as any).__GENEMON__;
  const a = G.app;
  const g = a.profile.collection[0];
  return { g: g.id };
});
const over = await page.evaluate((gid) => {
  const a = (globalThis as any).__GENEMON__.app;
  a.updateSettings({ dev: { timeScale: 1, unlimitedCredits: true, noFoodLimit: false } });
  const mod = a.constructor; void mod;
  // the Lab path: genemon.feedLife is in the bundle only through the UI; drive the Lab's feed button
  a.select(gid);
  a.go("lab");
  return true;
}, feed.g);
void over;
await page.clock.runFor(1500);
const res = await page.evaluate(async () => {
  const a = (globalThis as any).__GENEMON__.app;
  const lifeBtn = [...document.querySelectorAll<HTMLButtonElement>("#panel [data-tab]")].find((b) => b.dataset.tab === "life");
  lifeBtn?.click();
  await new Promise((r) => setTimeout(r, 50));
  const x10 = [...document.querySelectorAll<HTMLButtonElement>("#panel button")].find((b) => b.textContent === "×10");
  const g = a.selectedGenemon();
  const refusedBefore = a.ledger.counts()["genemon.feed.refused"] ?? 0;
  for (let i = 0; i < 4; i++) x10?.click();
  const refused = (a.ledger.counts()["genemon.feed.refused"] ?? 0) - refusedBefore;
  const capacity = g.life?.digestion?.capacity;
  const full1 = g.life.digestion.stomach.reduce((s: number, it: any) => s + it.units * (1 - it.digested), 0);
  a.updateSettings({ dev: { timeScale: 1, unlimitedCredits: true, noFoodLimit: true } });
  for (let i = 0; i < 3; i++) [...document.querySelectorAll<HTMLButtonElement>("#panel button")].find((b) => b.textContent === "×10")?.click();
  const full2 = g.life.digestion.stomach.reduce((s: number, it: any) => s + it.units * (1 - it.digested), 0);
  return { found: !!x10, refused, capacity, full1: +full1.toFixed(2), full2: +full2.toFixed(2), anim: a.labView?.snapshot?.()?.life ?? null };
});
check("stomach capacity refuses a feast", res.refused > 0 && res.full1 <= res.capacity + 10, res);
check("no-food-limit overfeeds past capacity", res.full2 > res.capacity, res);
// 3. age one Genemon to ancient and try a ranked battle
const rank = await page.evaluate(() => {
  const a = (globalThis as any).__GENEMON__.app;
  const team = a.profile.team;
  const g = a.profile.collection.find((x: any) => x.id === team[0]);
  g.conditions.ageDays = 5000;
  const phase = a.life.phaseOf(g);
  const cr = a.life.canRank(g);
  a.startRanked();
  const b = a.battleView?.battle;
  const inBattle = b ? b.fighters.some((f: any) => f.id === g.id) : null;
  return { phase, cr, battle: !!b, inBattle };
});
check("an ancient Genemon is benched from ranked", rank.phase === "ancient" && rank.cr.ok === false && rank.inBattle === false, rank);
check("no page errors", errs.length === 0, errs.slice(0, 8));
await browser.close();
await server.shutdown();
console.log(`${checks.filter((c) => c[1]).length}/${checks.length} passed`);
