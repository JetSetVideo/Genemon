// deno-lint-ignore-file no-explicit-any
/** Creature close-ups (3/4, side, front) for 16 creatures in the Lab: deno run -A tools/p5close.ts [outDir] */import { chromium } from "playwright";
import { serveAsset } from "./serve.ts";
const OUT = Deno.args[0] ?? "artifacts/qa/p5-close";
await Deno.mkdir(OUT, { recursive: true });
const server = Deno.serve({ hostname: "127.0.0.1", port: 8825, onListen: () => {} }, (r) => serveAsset(r));
const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, args: ["--use-angle=metal", "--ignore-gpu-blocklist", "--enable-webgl"] });
const page = await (await browser.newContext({ viewport: { width: 1100, height: 900 } })).newPage();
const errs: string[] = [];
page.on("pageerror", (e) => errs.push(e.message));
await page.goto("http://127.0.0.1:8825", { waitUntil: "load" });
await page.waitForFunction(() => !!(globalThis as any).__GENEMON__);
await page.evaluate(() => (globalThis as any).__GENEMON__.go("lab"));
await page.waitForTimeout(800);
// a varied set: the profile's collection + wild genomes of every kind
const n = await page.evaluate(() => {
  const a = (globalThis as any).__GENEMON__.app;
  const wild = a.wildPool ? a.wildPool() : [];
  for (const w of wild.slice(0, 10)) if (!a.profile.collection.some((g: any) => g.id === w.id)) a.profile.collection.push(w);
  document.querySelector("#panel")!.classList.add("hidden");
  return a.profile.collection.length;
});
for (let i = 0; i < Math.min(n, 16); i++) {
  const info = await page.evaluate((k) => {
    const a = (globalThis as any).__GENEMON__.app;
    const g = a.profile.collection[k];
    a.select(g.id);
    a.labView.autoRotate = false;
    return `${k}-${g.name}`;
  }, i);
  await page.waitForTimeout(700);
  for (const [tag, yaw, pitch] of [["34", 0.7, 0.25], ["side", Math.PI / 2, 0.1], ["front", 0.0, 0.15]] as const) {
    await page.evaluate(([y, p]) => (globalThis as any).__GENEMON__.app.labView.frame(y, p), [yaw, pitch]);
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${OUT}/${info}-${tag}.png`, clip: { x: 160, y: 60, width: 940, height: 840 } });
  }
}
console.log("errors", errs);
await browser.close(); await server.shutdown();
