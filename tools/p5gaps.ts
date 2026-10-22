// deno-lint-ignore-file no-explicit-any
/**
 * Connectivity probe [P5-V3] in real Chrome: for 16 creatures (profile + wild), every mesh's minimum distance
 * to any other mesh, reported when > 4 % of body height. `--fake` injects a floating copy into the first
 * creature to prove the metric can fail.  deno task build && deno run -A tools/p5gaps.ts [--fake]
 */
import { chromium } from "playwright";
import { serveAsset } from "./serve.ts";
const server = Deno.serve({ hostname: "127.0.0.1", port: 8826, onListen: () => {} }, (r) => serveAsset(r));
const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, args: ["--use-angle=metal", "--ignore-gpu-blocklist", "--enable-webgl"] });
const page = await (await browser.newContext({ viewport: { width: 1100, height: 900 } })).newPage();
await page.goto("http://127.0.0.1:8826", { waitUntil: "load" });
await page.waitForFunction(() => !!(globalThis as any).__GENEMON__);
await page.evaluate(() => (globalThis as any).__GENEMON__.go("lab"));
await page.waitForTimeout(600);
const out = await page.evaluate((Deno_FAKE: boolean) => {
  const a = (globalThis as any).__GENEMON__.app;
  for (const w of a.wildPool().slice(0, 10)) if (!a.profile.collection.some((g: any) => g.id === w.id)) a.profile.collection.push(w);
  const res: any[] = [];
  for (const g of a.profile.collection.slice(0, 16)) {
    a.select(g.id);
    const lv = a.labView;
    const root = lv.creature.root;
    if (Deno_FAKE && res.length === 0) { const src = root.getObjectByProperty('isMesh', true); const fake = src.clone(); fake.name = 'FAKE'; fake.position.y += 50; root.add(fake); }
    root.updateMatrixWorld(true);
    const body: number[][] = [];
    const parts: { name: string; c: number[]; flame: boolean }[] = [];
    root.traverse((o: any) => {
      if (!o.isMesh || !o.geometry?.attributes?.position) return;
      const pos = o.geometry.attributes.position;
      const flame = (o.material?.type === "MeshBasicMaterial" && o.material?.side !== 1) || o.renderOrder === 3;
      const ink = o.material?.side === 1 && o.material?.type === "MeshBasicMaterial";
      if (ink) return;
      const v = new o.position.constructor();
      let cx = 0, cy = 0, cz = 0;
      const step = Math.max(1, Math.floor(pos.count / 400));
      let n = 0;
      for (let i = 0; i < pos.count; i += step) {
        v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
        if (!flame) body.push([v.x, v.y, v.z]);
        cx += v.x; cy += v.y; cz += v.z; n++;
      }
      parts.push({ name: o.name || o.parent?.name || "?", c: [cx / n, cy / n, cz / n], flame });
    });
    const h = lv.creature.sk.height;
    // every mesh: min distance from its sampled vertices to any OTHER mesh's sampled vertices
    const meshes: { name: string; pts: number[][] }[] = [];
    root.traverse((o: any) => {
      if (!o.isMesh || !o.geometry?.attributes?.position || !o.visible) return;
      if (o.material?.side === 1 && o.material?.type === "MeshBasicMaterial") return;
      const pos = o.geometry.attributes.position, v = new o.position.constructor(), pts: number[][] = [];
      const step = Math.max(1, Math.floor(pos.count / 300));
      for (let i = 0; i < pos.count; i += step) { v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld); pts.push([v.x, v.y, v.z]); }
      let nm = o.name || ""; let q = o.parent; while (!nm && q) { nm = q.name; q = q.parent; }
      meshes.push({ name: `${nm}:${o.material?.type ?? ""}`, pts });
    });
    const flames: any[] = [];
    meshes.forEach((m, i) => {
      let best = 1e9;
      for (let j = 0; j < meshes.length && best > 1e-3; j++) {
        if (j === i) continue;
        for (const a of m.pts) for (const b of meshes[j].pts) { const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); if (d < best) best = d; }
      }
      if (best / h > 0.04) flames.push([m.name, +(best / h).toFixed(3)]);
    });
    res.push({ name: g.name, kind: lv.creature.ph.kind, el: lv.creature.ph.elements.primary, tail: (lv.creature.o.helix.p5 ?? {}).body?.tail, flamesGapOverH: flames });
  }
  return res;
}, Deno.args.includes("--fake"));
for (const r of out) console.log(JSON.stringify(r));
await browser.close(); await server.shutdown();
