// deno-lint-ignore-file no-explicit-any
/**
 * QA capture: real headless Chrome (WebGL via Metal) against the built bundle, fully offline.
 *   deno task build && deno task capture [round=1]
 * Writes artifacts/qa/round-N/: PNG shots, contact sheets (sheet-*.png), manifest.json (engine
 * snapshot per shot: camera mode/position, fighters, phases, strain, stability, triangles...) and
 * REPORT.md (console errors, blocked non-local requests, horizontal overflow, fps sample).
 * The shot list is generated from data (arenas x weathers, camera modes, starters), not typed by hand.
 */
import { chromium, type Page } from "playwright";
import { serveAsset } from "./serve.ts";

const ROUND = Number(Deno.args[0] ?? 1);
const OUT = `artifacts/qa/round-${ROUND}`;
const PORT = 8811;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const FIXED_TIME = new Date("2026-10-12T14:30:00");

await Deno.mkdir(OUT, { recursive: true });
for await (const f of Deno.readDir(OUT)) if (f.name.endsWith(".png") || f.name.endsWith(".json")) await Deno.remove(`${OUT}/${f.name}`);

const server = Deno.serve({ hostname: "127.0.0.1", port: PORT, onListen: () => {} }, (r) => serveAsset(r));
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--use-angle=metal", "--ignore-gpu-blocklist", "--enable-webgl"] });

interface Shot {
  file: string;
  title: string;
  viewport: string;
  snapshot: unknown;
}
const shots: Shot[] = [];
const consoleErrors: string[] = [];
const blocked: string[] = [];
const overflow: string[] = [];
const fpsSamples: { label: string; fps: number; frameMs: number; frameMsMax: number }[] = [];
const cameraErrors: string[] = [];

/** Resolve after two real rendered frames (a screenshot right after a state change can show the old frame). */
const nextFrames = (page: Page) => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));

async function newPage(width: number, height: number, mobile = false): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile });
  await ctx.clock.setFixedTime(FIXED_TIME);
  await ctx.route("**/*", (route) => {
    const u = route.request().url();
    if (u.startsWith(ORIGIN) || u.startsWith("data:") || u.startsWith("blob:")) return route.continue();
    blocked.push(u);
    return route.abort();
  });
  const page = await ctx.newPage();
  const tag = `${width}x${height}`;
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(`[${tag}] ${m.text()}`);
  });
  page.on("pageerror", (e) => consoleErrors.push(`[${tag}] pageerror: ${e.message}`));
  await page.goto(ORIGIN, { waitUntil: "load" });
  await page.waitForFunction(() => !!(globalThis as any).__GENEMON__, null, { timeout: 15000 });
  await page.waitForTimeout(800);
  return page;
}

async function shot(page: Page, file: string, title: string): Promise<void> {
  await page.waitForTimeout(120);
  await page.screenshot({ path: `${OUT}/${file}` });
  const vp = page.viewportSize();
  const snapshot = await page.evaluate(() => (globalThis as any).__GENEMON__.snapshot());
  // Overflow = any app region whose right edge passes the VISUAL viewport, or a panel that scrolls
  // sideways. (scrollWidth vs innerWidth was blind under mobile emulation: innerWidth widens with
  // the content, so it reported 0 while the phone layout was ~500 px wide.)
  const ov = await page.evaluate(() => {
    const vw = globalThis.visualViewport?.width ?? document.documentElement.clientWidth;
    const out: string[] = [];
    for (const id of ["topbar", "viewport", "panel", "nav"]) {
      const el = document.getElementById(id);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.right > vw + 1) out.push(`#${id} right ${Math.round(r.right)} > ${Math.round(vw)}`);
    }
    const p = document.getElementById("panel");
    if (p && p.scrollWidth > p.clientWidth + 1) out.push(`#panel scrolls sideways (${p.scrollWidth} > ${p.clientWidth})`);
    return out;
  });
  if (ov.length) overflow.push(`${file}: ${ov.join("; ")}`);
  // HUD rectangles (CSS px, relative to the 3D view) to cross-check against fighter boxes.
  const hud = await page.evaluate(() => {
    const v = document.getElementById("viewport")?.getBoundingClientRect();
    if (!v) return [];
    return [...document.querySelectorAll<HTMLElement>("#hud .hud-team, #hud .hud-feed, #view-tools")].filter((e) => e.offsetParent !== null).map((e) => {
      const r = e.getBoundingClientRect();
      return { cls: e.className || e.id, x0: Math.round(r.left - v.left), y0: Math.round(r.top - v.top), x1: Math.round(r.right - v.left), y1: Math.round(r.bottom - v.top) };
    });
  });
  shots.push({ file, title, viewport: `${vp?.width}x${vp?.height}`, snapshot: { ...snapshot, hudRects: hud } });
  console.log(`  -> ${file}`);
}

const go = (page: Page, s: string) => page.evaluate((x) => (globalThis as any).__GENEMON__.go(x), s);

async function startBattle(page: Page, o: { arena: string; weather: string; hour: number; seed: number; opponent?: string }): Promise<void> {
  await page.evaluate((opts) => {
    const G = (globalThis as any).__GENEMON__;
    G.app.updateSettings({ speed: 3, camera: "auto" });
    G.battle({ opponent: "rival", ...opts });
  }, o);
  await page.waitForFunction(() => (globalThis as any).__GENEMON__.app.battleView !== null, null, { timeout: 10000 });
}

/** Advance the battle until something is happening on screen (projectile, zone or an active strike). */
async function advanceToAction(page: Page, minT: number): Promise<void> {
  await page.waitForFunction((t) => {
    const b = (globalThis as any).__GENEMON__.app.battleView.battle;
    if (b.winner !== null) return true;
    const busy = b.projectiles.length > 0 || b.zones.length > 0 || b.fighters.some((f: any) => f.phase === "active" || f.phase === "charge");
    return b.t > t && busy;
  }, minT, { timeout: 60000, polling: 50 });
  await page.evaluate(() => {
    (globalThis as any).__GENEMON__.app.battleView.frozen = true;
  });
}

async function camera(page: Page, mode: string, yaw?: number): Promise<void> {
  await page.evaluate(([m, y]) => {
    const app = (globalThis as any).__GENEMON__.app;
    const bv = app.battleView;
    bv.setCameraMode(m);
    if (m === "orbit") {
      const c = bv.cam.debug.center;
      const R = Math.max(14, bv.cam.debug.distance * 0.9);
      app.stage.controls.target.copy(c);
      app.stage.camera.position.set(c.x + Math.sin(y as number) * R, c.y + R * 0.42, c.z + Math.cos(y as number) * R);
      app.stage.controls.update();
    } else {
      bv.cam.snap(bv.battle);
    }
  }, [mode, yaw ?? 0] as const);
  await nextFrames(page);
  await page.waitForTimeout(150);
  const got = await page.evaluate(() => (globalThis as any).__GENEMON__.app.battleView.cam.mode);
  if (got !== mode) throw new Error(`camera mode did not take effect: wanted ${mode}, got ${got}`);
}

async function sampleFps(page: Page, label: string): Promise<void> {
  await page.waitForTimeout(1500);
  const s = await page.evaluate(() => {
    const st = (globalThis as any).__GENEMON__.app.stage;
    return { fps: st.fps, frameMs: st.frameMsAvg, frameMsMax: st.frameMsMax };
  });
  fpsSamples.push({ label, ...s });
}

// ------------------------------------------------------------------ desktop: screens
console.log("Desktop 1440x900");
const page = await newPage(1440, 900);
await shot(page, "01-home.png", "Home screen (dark theme) with the team leader in the lab view");
await go(page, "lab");
await shot(page, "02-lab-overview.png", "Lab: overview tab (body, stats, emergent element affinity)");
await page.evaluate(() => (globalThis as any).__GENEMON__.app.updateSettings({ showSkeleton: true }));
await shot(page, "03-lab-skeleton.png", "Lab: skeleton overlay - bones (cyan), centre of mass (red), support polygon (yellow)");
await page.evaluate(() => (globalThis as any).__GENEMON__.app.updateSettings({ showSkeleton: false }));
await page.click('[data-tab="genome"]');
await shot(page, "04-lab-genome.png", "Lab: genome tab - 26 opposite-pole axes grouped by space, genetic vs expressed");
await go(page, "team");
await shot(page, "05-team.png", "Team: 6 slots sized by Genemon size class, attack order, synergies");
await go(page, "data");
await page.waitForTimeout(600);
await shot(page, "06-data-genospace.png", "Data: genospace (190 Genemon on heat x moisture x luminance) + ledger");
await go(page, "arena");
await shot(page, "07-arena-setup.png", "Arena setup: arena cards, conditions, opponent");
await page.evaluate(() => (globalThis as any).__GENEMON__.app.updateSettings({ theme: "light" }));
await go(page, "settings");
await shot(page, "08-settings-light.png", "Settings in the light theme");
await go(page, "lab");
await shot(page, "09-lab-light.png", "Lab in the light theme");
await page.evaluate(() => (globalThis as any).__GENEMON__.app.updateSettings({ theme: "dark" }));

// ------------------------------------------------------------------ every registered screen
// Roster-driven: the ids come from the nav, which is generated from SCREENS (src/ui/screens/
// registry.ts), so a newly registered screen is captured without editing this list.
const SHOT_ALREADY = new Set(["home", "lab", "team", "data", "arena", "settings"]);
const roster: string[] = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("#nav [data-nav]")].map((b) => b.dataset.nav!));
let rosterShots = 0;
for (const id of roster) {
  if (SHOT_ALREADY.has(id)) continue;
  await go(page, id);
  await page.waitForTimeout(id === "world" ? 1500 : 700);
  await shot(page, `screen-${id}.png`, `Screen "${id}" (roster-driven: every screen in the registry is captured)`);
  rosterShots++;
}
console.log(`Screens: ${roster.length} registered, ${SHOT_ALREADY.size} in the fixed set, ${rosterShots} roster shots`);
if (rosterShots + [...SHOT_ALREADY].filter((s) => roster.includes(s)).length !== roster.length) throw new Error("a registered screen was not captured");

// ------------------------------------------------------------------ creature gallery + phase strip
console.log("Creature gallery");
const nStarters: number = await page.evaluate(() => (globalThis as any).__GENEMON__.app.profile.collection.length);
const gallery: string[] = [];
for (let i = 0; i < nStarters; i++) {
  for (const [angle, yaw, pitch] of [["34", 0.75, 0.32], ["side", Math.PI / 2, 0.12]] as const) {
    const meta = await page.evaluate(([idx, y, p]) => {
      const app = (globalThis as any).__GENEMON__.app;
      const g = app.profile.collection[idx];
      app.select(g.id);
      app.stage.paused = true;
      const lv = app.labView;
      lv.autoRotate = false;
      lv.creature.root.rotation.y = 0;
      const want: number[] = lv.frame(y, p);
      return { name: `${g.name}-${lv.creature.ph.kind}`, want };
    }, [i, yaw, pitch] as const);
    await nextFrames(page);
    const got: number[] = await page.evaluate(() => (globalThis as any).__GENEMON__.app.stage.camera.position.toArray());
    const miss = Math.hypot(got[0] - meta.want[0], got[1] - meta.want[1], got[2] - meta.want[2]);
    if (miss > 0.01) cameraErrors.push(`${meta.name} ${angle}: camera ${got.map((v) => v.toFixed(2))} != requested ${meta.want.map((v) => v.toFixed(2))}`);
    const file = `creature-${String(i).padStart(2, "0")}-${angle}-${meta.name.replace(/[^a-z0-9-]/gi, "")}.png`;
    await shot(page, file, `Creature ${meta.name} (${angle === "34" ? "three-quarter front" : "side"} view)`);
    gallery.push(file);
  }
}
const phases: string[] = [];
for (const phase of ["charge", "active", "rest"]) {
  await page.evaluate(() => {
    const app = (globalThis as any).__GENEMON__.app;
    app.select(app.profile.collection[0].id);
    app.stage.paused = false;
  });
  await page.waitForFunction((p) => (globalThis as any).__GENEMON__.app.labView.phase === p, phase, { timeout: 20000, polling: 16 });
  await page.waitForTimeout(phase === "active" ? 40 : 200);
  await page.evaluate(() => ((globalThis as any).__GENEMON__.app.stage.paused = true));
  const file = `phase-${phase}.png`;
  await shot(page, file, `Attack phase: ${phase} (lab demo cycle of the first Genemon's moves)`);
  phases.push(file);
}
await page.evaluate(() => ((globalThis as any).__GENEMON__.app.stage.paused = false));

// ------------------------------------------------------------------ battles: multi-angle + arena x weather matrix
console.log("Battle multi-angle");
await startBattle(page, { arena: "meadow", weather: "clear", hour: 13, seed: 101 });
await sampleFps(page, "battle meadow 1440x900");
await advanceToAction(page, 5);
const angles: string[] = [];
for (const [mode, yaw] of [["auto", 0], ["top", 0], ["side", 0], ["low", 0], ["follow", 0], ["orbit", 0], ["orbit", 2.1], ["orbit", 4.2]] as const) {
  await camera(page, mode, yaw);
  const file = `battle-angle-${mode}${mode === "orbit" ? `-${Math.round(yaw * 57.3)}` : ""}.png`;
  await shot(page, file, `Meadow battle, same frozen instant, camera ${mode}${mode === "orbit" ? ` yaw ${Math.round(yaw * 57.3)} deg` : ""}`);
  angles.push(file);
}
await page.evaluate(() => {
  const app = (globalThis as any).__GENEMON__.app;
  app.battleView.setCameraMode("auto");
  app.battleView.frozen = false;
});
await page.waitForFunction(() => (globalThis as any).__GENEMON__.app.lastResult !== null, null, { timeout: 120000, polling: 100 });
await page.waitForTimeout(600);
await shot(page, "battle-result.png", "Battle result panel (meadow, seed 101)");

const MATRIX: { arena: string; weather: string; hour: number; seed: number; why: string }[] = [
  { arena: "lake", weather: "storm", hour: 21, seed: 202, why: "night thunderstorm over a lake: conduction, lightning, rain" },
  { arena: "volcano", weather: "heatwave", hour: 15, seed: 303, why: "lava caldera in a heatwave" },
  { arena: "tundra", weather: "snow", hour: 9, seed: 404, why: "frozen lake and snow, slippery ice" },
  { arena: "swamp", weather: "fog", hour: 6, seed: 505, why: "dawn fog over mud and muddy water" },
  { arena: "city", weather: "rain", hour: 22, seed: 606, why: "neon plaza at night in the rain, metal plates" },
  { arena: "canyon", weather: "sandstorm", hour: 17, seed: 707, why: "sandstorm in a canyon, late afternoon" },
  { arena: "crystal", weather: "eclipse", hour: 0, seed: 808, why: "crystal grotto at midnight during an eclipse" },
  { arena: "beach", weather: "wind", hour: 19, seed: 909, why: "windy beach at dusk, deep water" },
];
const matrix: string[] = [];
for (const m of MATRIX) {
  console.log(`Battle ${m.arena}/${m.weather}`);
  await page.evaluate(() => (globalThis as any).__GENEMON__.app.closeBattle());
  await startBattle(page, m);
  await advanceToAction(page, 6);
  await camera(page, "auto");
  const file = `arena-${m.arena}-${m.weather}-${m.hour}h.png`;
  await shot(page, file, `${m.arena} / ${m.weather} / ${m.hour}h: ${m.why}`);
  matrix.push(file);
}
await page.context().close();

// ------------------------------------------------------------------ tablet + mobile
for (const [w, hgt, mobile, label] of [[820, 1180, true, "tablet"], [390, 844, true, "mobile"]] as const) {
  console.log(`${label} ${w}x${hgt}`);
  const p = await newPage(w, hgt, mobile);
  await shot(p, `${label}-home.png`, `${label}: home screen`);
  await startBattle(p, { arena: "meadow", weather: "clear", hour: 13, seed: 101 });
  await sampleFps(p, `battle meadow ${label}`);
  await advanceToAction(p, 5);
  await camera(p, "auto");
  await shot(p, `${label}-battle.png`, `${label}: battle with HUD`);
  await p.evaluate(() => {
    const app = (globalThis as any).__GENEMON__.app;
    app.closeBattle();
    app.go("lab");
  });
  await shot(p, `${label}-lab.png`, `${label}: lab`);
  if (label === "mobile") {
    // The phone nav: 4 tabs + More; the sheet must open above the bar and fit the screen.
    await p.evaluate(() => document.querySelector<HTMLElement>("#nav .nav-more")?.click());
    await p.waitForTimeout(250);
    await shot(p, "mobile-more.png", "mobile: the More sheet (World, Market, Ladder, Feats, Data, Settings)");
    await p.evaluate(() => (globalThis as any).__GENEMON__.app.go("world"));
    await p.waitForTimeout(1500);
    await shot(p, "mobile-world.png", "mobile: World map (places around home, physical vs virtual)");
  }
  await p.context().close();
}

// ------------------------------------------------------------------ contact sheets
async function sheet(name: string, files: string[], cols: number, title: string): Promise<void> {
  const cells = await Promise.all(files.map(async (f) => {
    const b64 = btoa(Array.from(await Deno.readFile(`${OUT}/${f}`), (c) => String.fromCharCode(c)).join(""));
    return `<figure><img src="data:image/png;base64,${b64}"><figcaption>${f}</figcaption></figure>`;
  }));
  const ctx = await browser.newContext({ viewport: { width: 1800, height: 1000 } });
  const p = await ctx.newPage();
  await p.setContent(`<html><body style="margin:0;background:#111;color:#ddd;font:14px system-ui"><h2 style="margin:8px 12px">${title}</h2>
    <div style="display:grid;grid-template-columns:repeat(${cols},1fr);gap:6px;padding:6px">${cells.join("")}</div>
    <style>figure{margin:0}img{width:100%;display:block;border:1px solid #333}figcaption{font-size:12px;padding:2px 4px}</style></body></html>`);
  await p.waitForTimeout(300);
  await p.screenshot({ path: `${OUT}/${name}`, fullPage: true });
  await ctx.close();
  console.log(`  sheet -> ${name}`);
}
await sheet("sheet-battle-angles.png", angles, 4, "Same battle instant from 8 camera angles (auto, top, side, low, follow, orbit x3)");
await sheet("sheet-arenas.png", matrix, 4, "Arena x weather x hour matrix (auto camera)");
await sheet("sheet-creatures.png", gallery, 4, "Starter Genemon - three-quarter and side views");
await sheet("sheet-phases.png", phases, 3, "Attack phases: charge -> active -> rest");
await sheet("sheet-screens.png", ["01-home.png", "02-lab-overview.png", "03-lab-skeleton.png", "04-lab-genome.png", "05-team.png", "06-data-genospace.png", "07-arena-setup.png", "08-settings-light.png", "09-lab-light.png"], 3, "Screens (desktop)");
await sheet("sheet-devices.png", ["tablet-home.png", "tablet-battle.png", "tablet-lab.png", "mobile-home.png", "mobile-battle.png", "mobile-lab.png"], 6, "Tablet (820x1180) and mobile (390x844)");

await browser.close();
await server.shutdown();

// Readability per battle shot: the smallest living fighter on screen (px tall) and any fighter box
// overlapping a HUD rectangle. Design floor (round-1 designer review): >= 48 px at 1440x900.
type Box = { x0: number; y0: number; x1: number; y1: number };
const sizeRows: string[] = [];
for (const s of shots) {
  const snap = s.snapshot as { view?: { fighters?: { name: string; hp: number; screen?: Box & { hPx: number; inFront: boolean } }[] }; hudRects?: (Box & { cls: string })[] };
  const fs = (snap.view?.fighters ?? []).filter((f) => f.hp > 0 && f.screen?.inFront);
  if (!fs.length) continue;
  const min = fs.reduce((a, f) => (f.screen!.hPx < a.screen!.hPx ? f : a));
  const hit = (a: Box, b: Box) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
  const overlaps = fs.filter((f) => (snap.hudRects ?? []).some((r) => hit(f.screen!, r))).map((f) => f.name);
  sizeRows.push(`| ${s.file} | ${s.viewport} | ${min.screen!.hPx} px (${min.name}) | ${overlaps.length ? overlaps.join(", ") : "-"} |`);
}

const report = [
  `# QA capture - round ${ROUND}`,
  "",
  `Generated by \`deno task capture ${ROUND}\` against dist/ (real headless Chrome, WebGL via ANGLE/Metal, clock fixed at ${FIXED_TIME.toISOString()}).`,
  "",
  `- Shots: ${shots.length} (+ 6 contact sheets)`,
  `- Console errors: ${consoleErrors.length}${consoleErrors.length ? "\n" + consoleErrors.map((e) => `  - ${e}`).join("\n") : ""}`,
  `- Blocked non-local requests: ${blocked.length}${blocked.length ? "\n" + blocked.slice(0, 10).map((e) => `  - ${e}`).join("\n") : " (the app is fully offline)"}`,
  `- Horizontal overflow: ${overflow.length ? overflow.join(", ") : "none"}`,
  `- Camera overrides that did not land: ${cameraErrors.length ? "\n" + cameraErrors.map((e) => `  - ${e}`).join("\n") : "none"}`,
  `- FPS samples (headless lab sample, not a device benchmark): ${fpsSamples.map((s) => `${s.label}: ${s.fps.toFixed(1)} fps, CPU ${s.frameMs.toFixed(1)} ms/frame mean, ${s.frameMsMax.toFixed(1)} ms max (1 s window)`).join("; ")}`,
  "",
  "| file | what it shows |",
  "|---|---|",
  ...shots.map((s) => `| ${s.file} | ${s.title} (${s.viewport}) |`),
  "",
  "## Readability: smallest living fighter and HUD overlap (battle shots)",
  "",
  "| file | viewport | smallest fighter on screen | fighters under a HUD box |",
  "|---|---|---|---|",
  ...sizeRows,
  "",
];
await Deno.writeTextFile(`${OUT}/REPORT.md`, report.join("\n"));
await Deno.writeTextFile(`${OUT}/manifest.json`, JSON.stringify({ round: ROUND, shots, consoleErrors, blocked, overflow, cameraErrors, fpsSamples }, null, 1));
console.log(report.slice(0, 8).join("\n"));
if (consoleErrors.length) Deno.exitCode = 1;
