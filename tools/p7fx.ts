// deno-lint-ignore-file no-explicit-any
/**
 * Pass-7 lane fx probe (headless, no browser):
 *   deno run -A tools/p7fx.ts [N=400] [oldFxModule]
 * 1. distribution of the heritable fx genes (helix.p7.fx) and of the effect parameters derived from them
 *    over N random genomes: min / p10 / median / mean / p90 / max and the 80/20 share (share20);
 * 2. heredity: Pearson r of child vs mid-parent over N/2 breedings, against an unrelated-pair control
 *    (the control must stay near 0, or the metric is broken);
 * 3. real battles replayed through the FxDirector at 60 fps with the fighters' real signatures vs none:
 *    spawned / peak live particles / peak transients / motes;
 * 4. with `oldFxModule` (e.g. a copy of `git show HEAD:src/render/fx.ts`): per event type, spawn counts of
 *    the old director vs the new one with P7_DEFAULTS, budgets lifted (identity check).
 */
import * as THREE from "../src/lib/three.ts";
import { Battle, type BattleEvent } from "../src/combat/battle.ts";
import { arenaSpec } from "../src/combat/scenario.ts";
import { autoTeam } from "../src/combat/team.ts";
import { createGenemon } from "../src/genome/genemon.ts";
import { randomGenome } from "../src/genome/genome.ts";
import { breed } from "../src/genome/breeding.ts";
import { express } from "../src/genome/phenotype.ts";
import { emptyConditions } from "../src/genome/epigenetics.ts";
import { helixOf } from "../src/genome/helix.ts";
import { summarize } from "../src/genome/pareto.ts";
import { type FxP7, P7_DEFAULTS } from "../src/genome/p7Types.ts";
import { FxDirector, moteRate, scaledCount, SpawnBudget, streakLength, trailLife } from "../src/render/fx.ts";

if (Deno.args[0] === "--shots") {
  await shots(Deno.args[1] ?? "artifacts/p7/fx", Number(Deno.args[2] ?? 18731));
  Deno.exit(0);
}

/**
 * Real headless Chrome stills of the impacts (needs a built dist/ in the CWD: run on a scratch copy).
 *   deno task build && deno run -A tools/p7fx.ts --shots <outDir> [port]
 * A 1v1 battle is pinned (frozen), the director's per-frame update is suspended, one hit per element is
 * fed through the real consume() path and advanced by exactly `frames` x 1/60 s, then photographed from
 * a camera perpendicular to the strike (attacker on the left, sparks should fly to the right).
 */
async function shots(out: string, port: number): Promise<void> {
  const { chromium } = await import("playwright");
  const { serveAsset } = await import("./serve.ts");
  await Deno.mkdir(out, { recursive: true });
  const server = Deno.serve({ hostname: "127.0.0.1", port, onListen: () => {} }, (r) => serveAsset(r));
  const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, args: ["--use-angle=metal", "--ignore-gpu-blocklist", "--enable-webgl"] });
  const page = await (await browser.newContext({ viewport: { width: 1100, height: 760 } })).newPage();
  const errs: string[] = [];
  page.on("pageerror", (e) => errs.push(e.message));
  page.on("console", (m) => m.type() === "error" && errs.push(m.text()));
  await page.goto(`http://127.0.0.1:${port}`, { waitUntil: "load" });
  await page.waitForFunction(() => !!(globalThis as any).__GENEMON__);
  await page.evaluate(() => {
    const G = (globalThis as any).__GENEMON__;
    G.app.updateSettings({ speed: 3, camera: "auto" });
    G.battle({ arena: "meadow", weather: "clear", hour: 13, seed: 101, opponent: "rival", format: "1v1" });
  });
  await page.waitForFunction(() => (globalThis as any).__GENEMON__.app.battleView !== null, null, { timeout: 15000 });
  await page.waitForTimeout(2500);
  const ok = await page.evaluate(() => {
    const bv = (globalThis as any).__GENEMON__.app.battleView;
    bv.frozen = true;
    for (const el of document.querySelectorAll<HTMLElement>("#panel, #hud, #view-tools, #toast")) el.style.visibility = "hidden";
    return typeof bv.fx.impact === "function" && typeof bv.fx.clearAll === "function";
  });
  if (!ok) throw new Error("this build has no pass-7 FxDirector (impact/clearAll missing)");
  const manifest: Record<string, unknown>[] = [];
  const shot = async (name: string, el: string, sig: Record<string, number> | null, frames: number, motes = false) => {
    const info = await page.evaluate(([el, sig, frames, motes]) => {
      const bv = (globalThis as any).__GENEMON__.app.battleView, fx = bv.fx, b = bv.battle, stage = bv.stage;
      if (!fx.__orig) fx.__orig = fx.update.bind(fx);
      fx.update = () => {};
      fx.clearAll();
      const on = b.fighters.map((f: any, i: number) => ({ f, i })).filter((x: any) => !x.f.benched && !x.f.ko);
      const all = b.fighters.map((f: any, i: number) => ({ f, i }));
      const T = on.find((x: any) => x.f.team === 1) ?? on[0] ?? all[0];
      const A = on.find((x: any) => x.f.team !== T.f.team) ?? all.find((x: any) => x.f.team !== T.f.team) ?? all.find((x: any) => x.i !== T.i);
      // Keep the attacker 6 m away along its current bearing (a still frame, the simulation is pinned).
      if (Math.hypot(A.f.body.pos.x - T.f.body.pos.x, A.f.body.pos.z - T.f.body.pos.z) < 1) A.f.body.pos.x = T.f.body.pos.x - 6;
      fx.setFighterFx(A.i, sig);
      const tp = T.f.body.pos, ap = A.f.body.pos;
      let dx = tp.x - ap.x, dz = tp.z - ap.z;
      const d = Math.hypot(dx, dz) || 1;
      dx /= d;
      dz /= d;
      const yC = tp.y + T.f.ph.heightM * 0.5;
      // Strike point on the target's near surface (as the battle reports it), drawn scale included.
      const rr = T.f.body.radius * (bv.ds?.[T.i] ?? 1);
      const hx = tp.x - dx * rr, hz = tp.z - dz * rr;
      // Camera on the side of the strike: attacker left, target right.
      bv.setCameraMode("orbit");
      const R = 4.5 + rr * 2;
      stage.camera.position.set(hx + dz * R, yC + 1.2, hz - dx * R);
      stage.controls.target.set(hx, yC, hz);
      stage.camera.lookAt(stage.controls.target);
      stage.controls.update();
      if (motes) {
        for (let k = 0; k < frames; k++) {
          fx.ambient(T.i, tp.x, tp.y + T.f.ph.heightM * 0.5, tp.z, T.f.body.radius * 1.15, T.f.ph.heightM * 1.1, T.f.ph.elements.primary, 1 / 60);
          fx.__orig(b, 1 / 60, k / 60);
        }
      } else {
        fx.consume(b, [{ seq: 1e9, t: b.t, type: "hit", a: A.i, b: T.i, element: el, value: T.f.maxHp * 0.22, crit: false, pos: { x: hx, y: tp.y, z: hz } }], bv.headOf);
        for (let k = 0; k < frames; k++) fx.__orig(b, 1 / 60, k / 60);
      }
      const s = fx.stats();
      const W = stage.renderer.domElement.clientWidth, H = stage.renderer.domElement.clientHeight;
      const v = stage.controls.target.clone().project(stage.camera);
      // QA: where the live particles land on screen and how big they are drawn (gl_PointSize = size x 320 / depth).
      const P = { n: 0, inView: 0, x0: 1e9, y0: 1e9, x1: -1e9, y1: -1e9, px: 0 };
      const w = v.clone(), cam = stage.camera;
      const visit = (x: number, y: number, z: number, _a: number, _b: number, _c: number, size: number) => {
        P.n++;
        w.set(x, y, z);
        const depth = w.clone().applyMatrix4(cam.matrixWorldInverse).z;
        w.project(cam);
        const px = (w.x * 0.5 + 0.5) * W, py = (-w.y * 0.5 + 0.5) * H;
        if (w.z < 1 && px >= 0 && px <= W && py >= 0 && py <= H) P.inView++;
        P.x0 = Math.min(P.x0, px); P.y0 = Math.min(P.y0, py); P.x1 = Math.max(P.x1, px); P.y1 = Math.max(P.y1, py);
        P.px = Math.max(P.px, (size * 320) / Math.max(0.1, -depth));
      };
      fx.glow.forEachLive(visit);
      fx.smoke.forEachLive(visit);
      for (const k of ["x0", "y0", "x1", "y1", "px"] as const) P[k] = Math.round(P[k]);
      return {
        particles: P,
        canvas: [W, H],
        canvasLeft: Math.round(stage.renderer.domElement.getBoundingClientRect().left),
        canvasTop: Math.round(stage.renderer.domElement.getBoundingClientRect().top),
        sx: Math.round((v.x * 0.5 + 0.5) * W),
        sy: Math.round((-v.y * 0.5 + 0.5) * H), glowLive: s.glowLive, smokeLive: s.smokeLive, transients: s.transients, motes: s.motes, attacker: A.f.name, target: T.f.name, targetEl: T.f.ph.elements.primary };
    }, [el, sig, frames, motes] as const);
    await page.waitForTimeout(250);
    const path = `${out}/${name}.png`;
    const I = info as any, ax = I.canvasLeft + I.sx, ay = I.canvasTop + I.sy;
    const cx = Math.max(0, Math.min(1100 - 480, ax - 240)), cy = Math.max(0, Math.min(760 - 380, ay - 210));
    await page.screenshot({ path, clip: { x: cx, y: cy, width: 480, height: 380 } });
    manifest.push({ name, el, sig, frames, path, ...info });
    console.log(name, JSON.stringify(info));
  };
  const ELS = ["neutral", "fire", "water", "plant", "earth", "air", "electric", "ice", "metal", "poison", "light", "shadow", "psychic", "void"];
  const FRAMES: Record<string, number> = { electric: 4, light: 6, metal: 10 };
  for (const el of ELS) await shot(`impact-${el}`, el, null, FRAMES[el] ?? 14);
  await shot("sig-fire-default", "fire", { intensity: 1, trail: 0, sparkle: 0, pulse: 0, hueShift: 0 }, 6);
  await shot("sig-fire-extreme", "fire", { intensity: 1.6, trail: 1, sparkle: 0, pulse: 0, hueShift: 0.08 }, 6);
  await page.evaluate(() => {
    const bv = (globalThis as any).__GENEMON__.app.battleView;
    bv.battle.fighters.forEach((_f: any, i: number) => bv.fx.setFighterFx(i, { intensity: 1.3, trail: 0, sparkle: 1, pulse: 0, hueShift: 0 }));
  });
  await shot("sparkle-1-motes", "light", null, 150, true);
  await page.evaluate(() => {
    const bv = (globalThis as any).__GENEMON__.app.battleView;
    bv.battle.fighters.forEach((_f: any, i: number) => bv.fx.setFighterFx(i, { intensity: 1, trail: 0, sparkle: 0, pulse: 0, hueShift: 0 }));
  });
  await shot("sparkle-0-motes", "light", null, 150, true);
  await Deno.writeTextFile(`${out}/manifest.json`, JSON.stringify({ errors: errs, shots: manifest }, null, 2));
  console.log(`errors: ${errs.length}`, errs.slice(0, 5));
  await browser.close();
  await server.shutdown();
}

const N = Number(Deno.args[0] ?? 400);
const OLD = Deno.args[1];
const fxOf = (g: ReturnType<typeof randomGenome>): FxP7 => helixOf(g, express(g, emptyConditions())).p7?.fx ?? P7_DEFAULTS.fx;
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const GENES = ["intensity", "trail", "sparkle", "pulse", "hueShift"] as const;

// 1. Distribution.
const sigs: FxP7[] = [];
for (let s = 1; s <= N; s++) sigs.push(fxOf(randomGenome(s * 104729 + 17)));
const rows: Record<string, number[]> = {};
for (const k of GENES) rows[k] = sigs.map((x) => x[k]);
rows["derived.countMult(10 x intensity)"] = sigs.map((x) => scaledCount(10, x.intensity));
rows["derived.trailLife(0.2)"] = sigs.map((x) => trailLife(0.2, x.trail));
rows["derived.streakLength m"] = sigs.map((x) => streakLength(x.trail));
rows["derived.moteRate /s"] = sigs.map((x) => moteRate(x.sparkle));
rows["derived.pulseAmp"] = sigs.map((x) => 0.45 * x.pulse);
console.log(`# 1. fx genes over ${N} random genomes`);
console.log("param | min | p10 | median | mean | p90 | max | share20 | distinct");
for (const [k, xs] of Object.entries(rows)) {
  const d = summarize(xs);
  console.log([k, d.min, d.p10, d.median, d.mean, d.p90, d.max, d.share20, d.distinct].map((v) => (typeof v === "number" ? r3(v) : v)).join(" | "));
}

// 2. Heredity.
function pearson(a: number[], b: number[]): number {
  const n = a.length, ma = a.reduce((s, v) => s + v, 0) / n, mb = b.reduce((s, v) => s + v, 0) / n;
  let c = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) {
    c += (a[i] - ma) * (b[i] - mb);
    va += (a[i] - ma) ** 2;
    vb += (b[i] - mb) ** 2;
  }
  return va > 0 && vb > 0 ? c / Math.sqrt(va * vb) : 0;
}
const pairs = Math.max(20, Math.floor(N / 2));
const mid: Record<string, number[]> = {}, kid: Record<string, number[]> = {}, ctl: Record<string, number[]> = {};
for (const k of GENES) {
  mid[k] = [];
  kid[k] = [];
  ctl[k] = [];
}
for (let i = 0; i < pairs; i++) {
  const a = randomGenome(9000 + i * 2), b = randomGenome(9001 + i * 2), c = breed(a, b, 77 + i), u = randomGenome(500000 + i);
  const fa = fxOf(a), fb = fxOf(b), fc = fxOf(c), fu = fxOf(u);
  for (const k of GENES) {
    mid[k].push((fa[k] + fb[k]) / 2);
    kid[k].push(fc[k]);
    ctl[k].push(fu[k]);
  }
}
console.log(`\n# 2. heredity over ${pairs} breedings: r(child, mid-parent) vs r(unrelated, mid-parent)`);
for (const k of GENES) console.log(`${k}: r=${r3(pearson(mid[k], kid[k]))} control=${r3(pearson(mid[k], ctl[k]))}`);

// 3. Real battles replayed through the director.
function teams(seed: number) {
  const pool = Array.from({ length: 6 }, (_, i) => createGenemon({ seed: seed * 100 + i, level: 20 }));
  return [autoTeam(pool.slice(0, 3), "A", seed), autoTeam(pool.slice(3), "B", seed + 1)] as const;
}
function replay(b: Battle, events: BattleEvent[], withSig: boolean, lift = false) {
  const fx = new FxDirector(new THREE.Scene());
  if (lift) {
    (fx as any).glowBudget = new SpawnBudget(1e9, 1e9);
    (fx as any).smokeBudget = new SpawnBudget(1e9, 1e9);
  }
  if (withSig) b.fighters.forEach((f, i) => fx.setFighterFx(i, helixOf(f.genemon.genome, f.ph).p7?.fx));
  const head = (i: number) => new THREE.Vector3(b.fighters[i].body.pos.x, b.fighters[i].body.pos.y + b.fighters[i].ph.heightM * 0.7, b.fighters[i].body.pos.z);
  const dt = 1 / 60;
  let e = 0, peakGlow = 0, peakSmoke = 0, peakTr = 0;
  for (let t = 0; t <= b.t + 1; t += dt) {
    const batch: BattleEvent[] = [];
    while (e < events.length && events[e].t <= t) batch.push(events[e++]);
    if (batch.length) fx.consume(b, batch, head);
    b.fighters.forEach((f, i) => {
      if (!f.ko && !f.benched) fx.ambient(i, f.body.pos.x, f.body.pos.y + f.ph.heightM * 0.5, f.body.pos.z, f.body.radius * 1.15, f.ph.heightM * 1.1, f.ph.elements.primary, dt);
    });
    fx.update(b, dt, t);
    const s = fx.stats();
    peakGlow = Math.max(peakGlow, s.glowLive);
    peakSmoke = Math.max(peakSmoke, s.smokeLive);
    peakTr = Math.max(peakTr, s.transients.ring + s.transients.bolt + s.transients.beam + s.transients.decal);
  }
  const s = fx.stats();
  fx.dispose();
  return { secs: r3(b.t), glowSpawned: s.glowSpawned, smokeSpawned: s.smokeSpawned, motes: s.motes, peakGlow, peakSmoke, peakTransients: peakTr, flashes: fx.flashCount };
}
console.log("\n# 3. real battles (3v3, meadow) replayed at 60 fps: none = no signature, sig = real helix signatures");
const battles: { b: Battle; events: BattleEvent[] }[] = [];
for (let s = 1; s <= 4; s++) {
  const [A, B] = teams(s);
  const b = new Battle({ seed: s, arena: arenaSpec("meadow", s), teams: [A, B] });
  b.run();
  const events = b.events.slice();
  battles.push({ b, events });
  const sigTxt = b.fighters.map((f) => {
    const x = helixOf(f.genemon.genome, f.ph).p7?.fx ?? P7_DEFAULTS.fx;
    return `${f.ph.elements.primary}[i${r3(x.intensity)} t${r3(x.trail)} s${r3(x.sparkle)} p${r3(x.pulse)} h${r3(x.hueShift)}]`;
  }).join(" ");
  console.log(`seed ${s}: events ${events.length}; ${sigTxt}`);
  console.log(`  none: ${JSON.stringify(replay(b, events, false))}`);
  console.log(`  sig : ${JSON.stringify(replay(b, events, true))}`);
}

// 4. Identity against an older fx module (budgets lifted, defaults, per event type).
if (OLD) {
  const old = await import(new URL(OLD, `file://${Deno.cwd()}/`).href);
  console.log(`\n# 4. identity vs ${OLD}: spawns per event type (budgets lifted), old -> new(P7_DEFAULTS)`);
  const tally = (mk: () => any, isOld: boolean) => {
    const out: Record<string, number> = {};
    for (const { b, events } of battles) {
      const fx = mk();
      fx.glowBudget = new SpawnBudget(1e9, 1e9);
      fx.smokeBudget = new SpawnBudget(1e9, 1e9);
      let n = 0;
      if (isOld) {
        for (const pool of [fx.glow, fx.smoke]) {
          const orig = pool.spawn.bind(pool);
          pool.spawn = (...a: any[]) => {
            n++;
            return orig(...a);
          };
        }
      }
      const head = (i: number) => new THREE.Vector3(b.fighters[i].body.pos.x, b.fighters[i].body.pos.y + 1, b.fighters[i].body.pos.z);
      for (const e of events) {
        const before = isOld ? n : fx.glow.spawned + fx.smoke.spawned;
        fx.consume(b, [e], head);
        const after = isOld ? n : fx.glow.spawned + fx.smoke.spawned;
        const key = e.type + (e.type === "phase" || e.type === "physics" ? `:${e.label}` : "");
        out[key] = (out[key] ?? 0) + (after - before);
      }
      fx.dispose();
    }
    return out;
  };
  const a = tally(() => new old.FxDirector(new THREE.Scene()), true);
  const bb = tally(() => {
    const d = new FxDirector(new THREE.Scene());
    for (let i = 0; i < 8; i++) d.setFighterFx(i, P7_DEFAULTS.fx);
    return d;
  }, false);
  for (const k of [...new Set([...Object.keys(a), ...Object.keys(bb)])].sort()) {
    if ((a[k] ?? 0) === 0 && (bb[k] ?? 0) === 0) continue;
    console.log(`${k}: ${a[k] ?? 0} -> ${bb[k] ?? 0}${(a[k] ?? 0) === (bb[k] ?? 0) ? "  (equal)" : "  (CHANGED)"}`);
  }
}
