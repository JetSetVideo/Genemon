// deno-lint-ignore-file no-explicit-any
/**
 * Pass-6 showcase captures in real Chrome: loads artifacts/tmp/p6showcase.json (tools/p6showcase.ts, real seeds),
 * puts each Genemon in the Lab and photographs it (3/4 + side), plus a connectivity gap per creature.
 *   deno task build && deno run -A tools/p6shots.ts [outDir]
 */
import { chromium } from "playwright";
import { serveAsset } from "./serve.ts";
const OUT = Deno.args[0] ?? "artifacts/qa/p6-show";
await Deno.mkdir(OUT, { recursive: true });
const items = JSON.parse(await Deno.readTextFile("artifacts/tmp/p6showcase.json"));
const server = Deno.serve({ hostname: "127.0.0.1", port: 8828, onListen: () => {} }, (r) => serveAsset(r));
const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, args: ["--use-angle=metal", "--ignore-gpu-blocklist", "--enable-webgl"] });
const page = await (await browser.newContext({ viewport: { width: 1100, height: 900 } })).newPage();
const errs: string[] = [];
page.on("pageerror", (e) => errs.push(e.message));
page.on("console", (m) => m.type() === "error" && errs.push(m.text()));
await page.goto("http://127.0.0.1:8828", { waitUntil: "load" });
await page.waitForFunction(() => !!(globalThis as any).__GENEMON__);
await page.evaluate(() => (globalThis as any).__GENEMON__.go("lab"));
await page.waitForTimeout(700);
await page.evaluate(() => document.querySelector("#panel")!.classList.add("hidden"));
for (const it of items) {
  const info = await page.evaluate((x) => {
    const a = (globalThis as any).__GENEMON__.app;
    x.g.id = `${x.g.id}-${x.label}`;
    a.profile.collection.push(x.g);
    a.select(x.g.id);
    a.labView.autoRotate = false;
    const lv = a.labView, root = lv.creature.root;
    root.updateMatrixWorld(true);
    // connectivity: every mesh's min distance to another mesh, / body height
    const meshes: number[][][] = [];
    root.traverse((o: any) => {
      if (!o.isMesh || !o.visible || !o.geometry?.attributes?.position) return;
      if (o.material?.side === 1 && o.material?.type === "MeshBasicMaterial") return;
      const pos = o.geometry.attributes.position, v = new o.position.constructor(), pts: number[][] = [];
      const step = Math.max(1, Math.floor(pos.count / 200));
      for (let i = 0; i < pos.count; i += step) { v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld); pts.push([v.x, v.y, v.z]); }
      meshes.push(pts);
    });
    let worst = 0;
    meshes.forEach((m, i) => {
      let best = 1e9;
      for (let j = 0; j < meshes.length && best > 1e-3; j++) if (j !== i) for (const p of m) for (const q of meshes[j]) best = Math.min(best, Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]));
      worst = Math.max(worst, best);
    });
    const s = lv.snapshot?.() ?? {};
    return { tris: lv.creature.triangles(), worstGapOverH: +(worst / lv.creature.sk.height).toFixed(3), meshes: meshes.length, egg: !!lv["egg"], phase: s.phase };
  }, it);
  await page.waitForTimeout(500);
  for (const [tag, yaw, pitch] of [["34", 0.7, 0.25], ["side", Math.PI / 2, 0.1]] as const) {
    await page.evaluate(([y, p]) => (globalThis as any).__GENEMON__.app.labView.frame(y, p), [yaw, pitch]);
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${OUT}/${it.label}-${tag}.png`, clip: { x: 160, y: 60, width: 940, height: 840 } });
  }
  console.log(it.label.padEnd(20), JSON.stringify(info));
}
console.log("errors", errs);
await browser.close();
await server.shutdown();
