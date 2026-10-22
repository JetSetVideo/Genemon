// deno-lint-ignore-file no-explicit-any
/**
 * Pass-5 browser probe (real headless Chrome, WebGL via Metal) against dist/:
 *   deno task build && deno run -A tools/p5probe.ts [outDir]
 * Screens: home platform, lab profile sheet, drag-to-feed (real pointer drag onto #scene), egg/fetus,
 * creature close-ups, a mid-fight battle, dex, market, batch, arena map. Collects console errors and
 * page errors, panel overflow and measured numbers into REPORT.json. A failing assertion is recorded,
 * never hidden.
 */
import { chromium, type Page } from "playwright";
import { serveAsset } from "./serve.ts";

const OUT = Deno.args[0] ?? "artifacts/qa/p5";
const PORT = 8823;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
await Deno.mkdir(OUT, { recursive: true });
const server = Deno.serve({ hostname: "127.0.0.1", port: PORT, onListen: () => {} }, (r) => serveAsset(r));
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--use-angle=metal", "--ignore-gpu-blocklist", "--enable-webgl"] });
const errors: string[] = [];
const checks: { name: string; ok: boolean; detail: unknown }[] = [];
const check = (name: string, ok: boolean, detail: unknown = null) => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name} ${detail === null ? "" : JSON.stringify(detail)}`);
};
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.clock.setFixedTime(new Date("2026-10-22T15:30:00"));
const page: Page = await ctx.newPage();
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
await page.goto(ORIGIN, { waitUntil: "load" });
await page.waitForFunction(() => !!(globalThis as any).__GENEMON__, null, { timeout: 20000 });
const frames = () => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
const wait = (ms: number) => page.waitForTimeout(ms);
const shot = async (f: string) => {
  await frames();
  await page.screenshot({ path: `${OUT}/${f}.png` });
};
const overflow = () => page.evaluate(() => {
  const p = document.querySelector("#panel") as HTMLElement;
  return p.scrollWidth - p.clientWidth;
});
const go = async (id: string) => {
  await page.evaluate((s) => (globalThis as any).__GENEMON__.go(s), id);
  await wait(900);
};

// ---- Home platform
await go("home");
await wait(2500);
await shot("01-home");
const home = await page.evaluate(() => (globalThis as any).__GENEMON__.snapshot().view);
check("home view has several creatures", (home?.creatures?.length ?? home?.actors?.length ?? 0) >= 2, { n: home?.creatures?.length ?? home?.actors?.length, keys: home ? Object.keys(home) : null });
check("home panel no overflow", (await overflow()) <= 0, await overflow());
const bands = await page.evaluate(() => [...document.querySelectorAll("#panel .section > .section-head")].map((e) => {
  const cs = getComputedStyle(e);
  return { t: e.textContent?.slice(0, 24), bg: cs.backgroundImage.slice(0, 60), fam: getComputedStyle(e.parentElement!).getPropertyValue("--fam").trim() };
}));
check("home section titles on coloured bands", bands.length > 0 && bands.every((b) => b.bg.includes("gradient")) && new Set(bands.map((b) => b.fam)).size >= Math.min(2, bands.length), bands);

// ---- Lab profile sheet
await go("lab");
await wait(1500);
await shot("02-lab-profile");
for (const [i, y] of [600, 1400, 2200, 3000].entries()) {
  await page.evaluate((yy) => document.querySelector("#panel")!.scrollTo(0, yy), y);
  await shot(`02-lab-profile-scroll${i + 1}`);
}
await page.evaluate(() => document.querySelector("#panel")!.scrollTo(0, 0));
const sections = await page.evaluate(() => [...document.querySelectorAll("#panel .ui5-sec-head h2")].map((e) => e.textContent));
check("profile sheet sections", sections.length >= 8, sections);
check("lab panel no overflow", (await overflow()) <= 0, await overflow());

// ---- Drag to feed: a pantry staple tile onto the creature
const tile = await page.evaluate(() => {
  const t = [...document.querySelectorAll<HTMLElement>("#panel .ui5-tile")].find((x) => !x.classList.contains("off"));
  if (!t) return null;
  t.scrollIntoView({ block: "center" });
  const r = t.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, title: t.title };
});
check("bag dock has a usable tile", !!tile, tile);
if (tile) {
  const before = await page.evaluate(() => {
    const a = (globalThis as any).__GENEMON__.app;
    const g = a.selectedGenemon();
    return { stomach: g.life?.digestion?.stomach?.length ?? 0, rows: a.ledger.counts()["genemon.feed"] ?? 0 };
  });
  const canvas = await page.evaluate(() => {
    const r = document.querySelector("#scene")!.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height * 0.55 };
  });
  await page.mouse.move(tile.x, tile.y);
  await page.mouse.down();
  for (let k = 1; k <= 12; k++) await page.mouse.move(tile.x + (canvas.x - tile.x) * k / 12, tile.y + (canvas.y - tile.y) * k / 12);
  await shot("03-dragging");
  await page.mouse.up();
  await wait(350);
  await shot("04-after-drop");
  const after = await page.evaluate(() => {
    const a = (globalThis as any).__GENEMON__.app;
    const g = a.selectedGenemon();
    const pop = document.querySelector(".ui5-pop");
    return { stomach: g.life?.digestion?.stomach?.length ?? 0, rows: a.ledger.counts()["genemon.feed"] ?? 0, popup: pop?.textContent ?? null, lab: a.labView?.snapshot?.() ?? null };
  });
  check("drop feeds (ledger genemon.feed +1)", after.rows === before.rows + 1, { before, rows: after.rows });
  check("food in the stomach", after.stomach >= 1, after.stomach);
  check("effects popup shown", !!after.popup, after.popup);
  await wait(1200);
  await shot("05-eating");
}

// ---- Creature close-ups: several genomes in the lab, incl. an egg and a fetus
const ids = await page.evaluate(() => {
  const a = (globalThis as any).__GENEMON__.app;
  return a.profile.collection.slice(0, 6).map((g: any) => g.id);
});
for (const [i, id] of ids.entries()) {
  await page.evaluate((x) => (globalThis as any).__GENEMON__.app.select(x), id);
  await wait(900);
  await shot(`06-creature-${i}`);
}
const eggInfo = await page.evaluate(() => {
  const G = (globalThis as any).__GENEMON__;
  const a = G.app;
  const mk = a.profile.collection[0];
  // Re-use createGenemon through the hatch path: clone a collection member as a newborn (ageDays tiny).
  const egg = structuredClone(mk);
  egg.id = mk.id + "-egg";
  egg.conditions.ageDays = 0.1;
  egg.conditions.xp = 0;
  egg.life = undefined;
  const fetus = structuredClone(egg);
  fetus.id = mk.id + "-fetus";
  fetus.conditions.ageDays = 0.6;
  a.profile.collection.push(egg, fetus);
  return { egg: egg.id, fetus: fetus.id };
});
for (const k of ["egg", "fetus"] as const) {
  await page.evaluate((x) => (globalThis as any).__GENEMON__.app.select(x), eggInfo[k]);
  await wait(900);
  await shot(`07-${k}`);
  const ph = await page.evaluate(() => (globalThis as any).__GENEMON__.app.labView?.snapshot?.());
  check(`${k} view snapshot`, !!ph, ph ? Object.keys(ph).slice(0, 12) : null);
}
await page.evaluate((x) => {
  const a = (globalThis as any).__GENEMON__.app;
  a.profile.collection = a.profile.collection.filter((g: any) => g.id !== x.egg && g.id !== x.fetus);
  a.select(a.profile.collection[0].id);
}, eggInfo);

// ---- Battle: play it in real time for a few seconds, screenshot, then finish synchronously
await go("arena");
await page.evaluate(() => (globalThis as any).__GENEMON__.app.startBattle({ arena: "meadow", weather: "auto", hour: 15, opponent: "rival", seed: 4242, format: "brawl" }));
await wait(6000);
await shot("08-battle-6s");
await wait(6000);
await shot("09-battle-12s");
const bsnap = await page.evaluate(() => {
  const v = (globalThis as any).__GENEMON__.snapshot().view;
  return { t: v?.t ?? v?.time, fighters: (v?.fighters ?? []).map((f: any) => ({ intent: f.intent, sees: f.sees?.length, phase: f.phase, onScreen: f.screen ?? f.box ?? null })), flashes: v?.flashes ?? v?.flashCount, particles: v?.particles };
});
check("battle fighters carry a brain intent", bsnap.fighters.some((f: any) => typeof f.intent === "string"), bsnap.fighters.slice(0, 4));
const res = await page.evaluate(() => {
  const a = (globalThis as any).__GENEMON__.app;
  const b = a.battleView.battle;
  let n = 0;
  while (b.winner === null && n++ < 200000) b.step();
  a.finishBattle();
  return { t: b.t, winner: b.winner, scars: a.profile.collection.reduce((s: number, g: any) => s + (g.life?.scars?.length ?? 0), 0) };
});
check("battle finishes", res.winner !== null, res);
await wait(800);
await shot("10-battle-result");

// ---- Other screens
for (const s of ["dex", "market", "batch", "settings", "world"]) {
  await go(s);
  await wait(1200);
  await shot(`11-${s}`);
  check(`${s} panel no overflow`, (await overflow()) <= 0, await overflow());
}

check("no console errors", errors.length === 0, errors.slice(0, 12));
await Deno.writeTextFile(`${OUT}/REPORT.json`, JSON.stringify({ checks, errors, home, bsnap, res }, null, 2));
await browser.close();
await server.shutdown();
console.log(`${checks.filter((c) => c.ok).length}/${checks.length} checks passed -> ${OUT}`);
