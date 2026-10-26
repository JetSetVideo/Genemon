// Lane fx (pass 7): per-fighter effects signature (MorphP7.fx) + element-specific impacts in the
// FxDirector. Headless: three.js objects need no WebGL; a minimal Battle stand-in feeds the director.
import * as THREE from "../src/lib/three.ts";
import { assert, assertEquals } from "./_assert.ts";
import type { Battle, BattleEvent } from "../src/combat/battle.ts";
import { ELEMENT_IDS, ELEMENTS, type ElementId } from "../src/data/elements.ts";
import { P7_DEFAULTS } from "../src/genome/p7Types.ts";
import { randomGenome } from "../src/genome/genome.ts";
import { express } from "../src/genome/phenotype.ts";
import { emptyConditions } from "../src/genome/epigenetics.ts";
import { helixOf } from "../src/genome/helix.ts";
import {
  clampFx,
  DEFAULT_FX,
  FX_BOUNDS,
  FxDirector,
  IMPACT_PROFILES,
  moteRate,
  pulseGlow,
  scaledCount,
  shiftHex,
  streakLength,
  trailLife,
  TRANSIENT_CAP,
} from "../src/render/fx.ts";
import { EyeAura } from "../src/render/anatomy/eyeAura.ts";

type FakeProj = { id: number; owner: number; pos: { x: number; y: number; z: number }; vel: { x: number; y: number; z: number }; radius: number; element: ElementId };

function fakeBattle(projectiles: FakeProj[] = []): Battle {
  const fighter = (x: number, idx: number) => ({ idx, team: idx as 0 | 1, body: { pos: { x, y: 0, z: 0 } }, ph: { heightM: 1.2 }, maxHp: 100, move: null });
  return { fighters: [fighter(-3, 0), fighter(3, 1)], projectiles, zones: [], arena: { heightAt: () => 0 } } as unknown as Battle;
}
const head = (_i: number) => new THREE.Vector3(0, 1, 0);
let seq = 0;
function hit(el: ElementId, value = 30, crit = false, a = 0, b = 1): BattleEvent {
  return { seq: ++seq, t: 0, type: "hit", a, b, element: el, value, crit, pos: { x: b === 1 ? 3 : -3, y: 0, z: 0 } };
}
function hueOf(r: number, g: number, b: number): number {
  const hsl = { h: 0, s: 0, l: 0 };
  new THREE.Color(r, g, b).getHSL(hsl);
  return hsl.h;
}
const hueDist = (a: number, b: number) => Math.min(Math.abs(a - b), 1 - Math.abs(a - b));

Deno.test("[P7 fx] budgets and transient caps hold under a burst of 1000 events at intensity 1.6", () => {
  const scene = new THREE.Scene();
  const fx = new FxDirector(scene);
  fx.setFighterFx(0, { intensity: 1.6, trail: 1, sparkle: 1, pulse: 1, hueShift: 0.08 });
  fx.setFighterFx(1, { intensity: 1.6, trail: 1, sparkle: 1, pulse: 1, hueShift: -0.08 });
  const b = fakeBattle();
  const evs: BattleEvent[] = [];
  for (let i = 0; i < 1000; i++) evs.push(hit(ELEMENT_IDS[i % ELEMENT_IDS.length], 20 + (i % 80), i % 3 === 0, i % 2, 1 - (i % 2)));
  fx.consume(b, evs, head);
  let s = fx.stats();
  assert(s.glowSpawned <= fx.glowBudget.burst, `glow burst ${s.glowSpawned} > ${fx.glowBudget.burst}`);
  assert(s.smokeSpawned <= fx.smokeBudget.burst, `smoke burst ${s.smokeSpawned} > ${fx.smokeBudget.burst}`);
  for (const k of Object.keys(TRANSIENT_CAP) as (keyof typeof TRANSIENT_CAP)[]) assert(s.transients[k] <= TRANSIENT_CAP[k], `${k} ${s.transients[k]}`);
  // Then 2 s at 60 fps with 1000 more events spread over the frames + ambient motes every frame.
  const dt = 1 / 60;
  let sent = 0;
  for (let f = 0; f < 120; f++) {
    const batch: BattleEvent[] = [];
    while (sent < ((f + 1) * 1000) / 120) batch.push(hit(ELEMENT_IDS[sent % ELEMENT_IDS.length], 40, sent++ % 4 === 0, sent % 2, 1 - (sent % 2)));
    fx.consume(b, batch, head);
    fx.ambient(0, -3, 0.6, 0, 0.8, 1.2, "fire", dt);
    fx.ambient(1, 3, 0.6, 0, 0.8, 1.2, "ice", dt);
    fx.update(b, dt, f * dt);
    s = fx.stats();
    for (const k of Object.keys(TRANSIENT_CAP) as (keyof typeof TRANSIENT_CAP)[]) assert(s.transients[k] <= TRANSIENT_CAP[k], `${k} ${s.transients[k]} frame ${f}`);
  }
  const T = 120 * dt + 1e-9;
  assert(s.glowSpawned <= fx.glowBudget.burst + fx.glowBudget.rate * T, `glow ${s.glowSpawned}`);
  assert(s.smokeSpawned <= fx.smokeBudget.burst + fx.smokeBudget.rate * T, `smoke ${s.smokeSpawned}`);
  assert(s.glowLive <= fx.glow.capacity && s.smokeLive <= fx.smoke.capacity);
  fx.dispose();
});

Deno.test("[P7 fx] signatures are clamped into the declared bounds; real helix values are already inside", () => {
  const wild = clampFx({ intensity: 9, trail: -2, sparkle: NaN, pulse: 4, hueShift: -1 });
  assertEquals(wild, { intensity: 1.6, trail: 0, sparkle: 0, pulse: 1, hueShift: -0.08 });
  assertEquals(clampFx(null), { ...P7_DEFAULTS.fx });
  assertEquals(DEFAULT_FX, P7_DEFAULTS.fx);
  let seen = 0;
  for (let s = 1; s <= 120; s++) {
    const g = randomGenome(s * 7919);
    const fx = helixOf(g, express(g, emptyConditions())).p7?.fx;
    if (!fx) continue;
    seen++;
    for (const k of Object.keys(FX_BOUNDS) as (keyof typeof FX_BOUNDS)[]) {
      assert(fx[k] >= FX_BOUNDS[k][0] - 1e-9 && fx[k] <= FX_BOUNDS[k][1] + 1e-9, `seed ${s} ${k}=${fx[k]}`);
    }
    assertEquals(clampFx(fx), fx, `seed ${s}`);
  }
  assert(seen > 0, "helixOf produced no p7.fx");
});

Deno.test("[P7 fx] hueShift is bounded and applied to the fighter's impact colours", () => {
  for (const el of ELEMENT_IDS) assertEquals(shiftHex(ELEMENTS[el].color, 0), ELEMENTS[el].color, el);
  // Clamped: asking for half a turn gives the same as the 0.08 bound.
  assertEquals(shiftHex(0xff5a1f, 0.5), shiftHex(0xff5a1f, 0.08));
  assertEquals(shiftHex(0xff5a1f, -3), shiftHex(0xff5a1f, -0.08));
  const c0 = new THREE.Color(0xff5a1f), c1 = new THREE.Color(shiftHex(0xff5a1f, 0.08));
  const d = hueDist(hueOf(c0.r, c0.g, c0.b), hueOf(c1.r, c1.g, c1.b));
  assert(Math.abs(d - 0.08) < 0.01, `hue moved ${d}`);
  // In the director: fighter 0 shifted, fighter 1 default; the same fire hit gives different hues.
  const hues = (shift: number) => {
    const fx = new FxDirector(new THREE.Scene());
    fx.setFighterFx(0, { ...P7_DEFAULTS.fx, hueShift: shift });
    fx.consume(fakeBattle(), [hit("fire", 30)], head);
    const hs: number[] = [];
    fx.glow.forEachLive((_x, _y, _z, _vx, _vy, _vz, _s, r, g, b) => hs.push(hueOf(r, g, b)));
    fx.dispose();
    return hs;
  };
  const base = hues(0), up = hues(0.08);
  assert(base.length > 0 && up.length === base.length, `${base.length} vs ${up.length}`);
  const moved = base.map((h, i) => hueDist(h, up[i]));
  assert(Math.max(...moved) <= 0.0801 + 0.01, `max hue move ${Math.max(...moved)}`);
  assert(moved.some((m) => m > 0.05), "hue shift not applied");
});

Deno.test("[P7 fx] projectile trail length is monotone in trail; strike streak too", () => {
  const extent = (trail: number) => {
    const p: FakeProj = { id: 1, owner: 0, pos: { x: 0, y: 1, z: 0 }, vel: { x: 12, y: 0, z: 0 }, radius: 0.3, element: "fire" };
    const b = fakeBattle([p]);
    const fx = new FxDirector(new THREE.Scene());
    fx.setFighterFx(0, { ...P7_DEFAULTS.fx, trail });
    fx.consume(b, [{ seq: ++seq, t: 0, type: "projectile", a: 0, b: 1, value: 1, element: "fire", pos: { ...p.pos } }], head);
    const dt = 1 / 60;
    for (let f = 0; f < 90; f++) {
      p.pos.x += p.vel.x * dt;
      fx.update(b, dt, f * dt);
    }
    let lo = Infinity, hi = -Infinity;
    fx.glow.forEachLive((x) => {
      lo = Math.min(lo, x);
      hi = Math.max(hi, x);
    });
    fx.dispose();
    return hi - lo;
  };
  const ts = [0, 0.25, 0.5, 0.75, 1];
  const ext = ts.map(extent);
  for (let i = 1; i < ext.length; i++) assert(ext[i] >= ext[i - 1] - 0.3, `trail extents ${ext.map((e) => e.toFixed(2))}`);
  assert(ext[4] > ext[0] * 2, `trail 1 should be > 2x trail 0: ${ext.map((e) => e.toFixed(2))}`);
  for (let i = 1; i < ts.length; i++) {
    assert(trailLife(0.2, ts[i]) > trailLife(0.2, ts[i - 1]));
    assert(streakLength(ts[i]) > streakLength(ts[i - 1]));
  }
  assertEquals(streakLength(0), 0);
  // trail 0 = the pass-6 projectile trail (life 0.2).
  assertEquals(trailLife(0.2, 0), 0.2);
});

Deno.test("[P7 fx] sparkle 0 spawns no motes; sparkle > 0 spawns motes around the body bounds", () => {
  const run = (sparkle: number) => {
    const fx = new FxDirector(new THREE.Scene());
    fx.setFighterFx(0, { ...P7_DEFAULTS.fx, sparkle });
    const b = fakeBattle();
    for (let f = 0; f < 180; f++) {
      fx.ambient(0, 5, 1, -2, 0.8, 2, "light", 1 / 60);
      fx.update(b, 1 / 60, f / 60);
    }
    const pts: number[][] = [];
    fx.glow.forEachLive((x, y, z) => pts.push([x, y, z]));
    const s = fx.stats();
    fx.dispose();
    return { motes: s.motes, spawned: s.glowSpawned, pts };
  };
  const none = run(0);
  assertEquals(none.motes, 0);
  assertEquals(none.spawned, 0);
  assertEquals(moteRate(0), 0);
  const some = run(0.6);
  assert(some.motes > 10, `motes ${some.motes}`);
  // Positioned from the bounds: within radius x 1.25 horizontally and inside the height band at birth.
  for (const [x, y, z] of some.pts) {
    assert(Math.hypot(x - 5, z + 2) < 0.8 * 1.25 + 0.6, `mote at ${x},${z}`);
    assert(y > 1 - 1.2 && y < 1 + 1.2 + 0.9, `mote height ${y}`);
  }
  const more = run(1);
  assert(more.motes > some.motes, `${more.motes} <= ${some.motes}`);
});

Deno.test("[P7 fx] every element has a distinct impact profile that behaves as named", () => {
  const keys = ["speed", "up", "gravity", "drag", "life", "size", "grow", "spin", "orient", "coreEvery"] as const;
  const vec = (el: ElementId) => keys.map((k) => Number(IMPACT_PROFILES[el][k]));
  for (let i = 0; i < ELEMENT_IDS.length; i++) {
    for (let j = i + 1; j < ELEMENT_IDS.length; j++) {
      const a = IMPACT_PROFILES[ELEMENT_IDS[i]], b = IMPACT_PROFILES[ELEMENT_IDS[j]];
      const va = vec(ELEMENT_IDS[i]), vb = vec(ELEMENT_IDS[j]);
      const dist = va.reduce((s, v, k) => s + Math.abs(v - vb[k]) / (1 + Math.abs(v) + Math.abs(vb[k])), 0);
      const cat = Number(a.pool !== b.pool) + Number(a.shape !== b.shape) + Number(a.extra !== b.extra);
      assert(dist + cat > 0.8, `${ELEMENT_IDS[i]} vs ${ELEMENT_IDS[j]} too similar (${dist.toFixed(2)} + ${cat})`);
    }
  }
  // Behaviour after 0.5 s: mean vertical velocity / spread of each impact.
  const probe = (el: ElementId) => {
    const fx = new FxDirector(new THREE.Scene());
    fx.consume(fakeBattle(), [hit(el, 60, true)], head);
    const b = fakeBattle();
    for (let f = 0; f < 30; f++) fx.update(b, 1 / 60, f / 60);
    let n = 0, vy = 0, r = 0, vh = 0;
    const pool = IMPACT_PROFILES[el].pool === "glow" ? fx.glow : fx.smoke;
    pool.forEachLive((x, y, z, vx, vY, vz) => {
      n++;
      vy += vY;
      r += Math.hypot(x - 3, y - 0.6, z);
      vh += Math.hypot(vx, vz);
    });
    fx.dispose();
    return { n, vy: vy / Math.max(1, n), r: r / Math.max(1, n), vh: vh / Math.max(1, n) };
  };
  const fire = probe("fire"), water = probe("water"), earth = probe("earth"), voidP = probe("void"), shadow = probe("shadow"), poison = probe("poison"), psychic = probe("psychic");
  assert(fire.vy > 0, `fire embers should rise: ${fire.vy}`);
  assert(poison.vy > 0, `poison bubbles should rise: ${poison.vy}`);
  assert(water.vy < 0 && earth.vy < 0, `water/earth should fall: ${water.vy} ${earth.vy}`);
  assert(shadow.vy < 0, `shadow wisps should sink: ${shadow.vy}`);
  assert(voidP.r < 1.2, `void should implode toward the hit: mean r ${voidP.r}`);
  // Void wisps start AROUND the hit and move INWARD (radial velocity < 0); a plain burst moves outward.
  {
    const fx = new FxDirector(new THREE.Scene());
    fx.consume(fakeBattle(), [hit("void", 60, true)], head);
    let rad = 0, n = 0;
    fx.smoke.forEachLive((x, y, z, vx, vy, vz) => {
      const dx = x - 3, dy = y - 0.6, dz = z, d = Math.hypot(dx, dy, dz) || 1;
      rad += (vx * dx + vy * dy + vz * dz) / d;
      n++;
    });
    fx.dispose();
    assert(n > 0 && rad / n < -0.5, `void radial velocity ${rad / n}`);
  }
  assert(Math.abs(psychic.vy) < psychic.vh * 0.25, `psychic ring should be flat: vy ${psychic.vy} vh ${psychic.vh}`);
  for (const p of [fire, water, earth, voidP, shadow, poison, psychic]) assert(p.n > 0);
});

Deno.test("[P7 fx] hit sparks spray along the strike line (rebounding off the struck surface)", () => {
  const meanVx = (a: 0 | 1) => {
    const fx = new FxDirector(new THREE.Scene());
    fx.consume(fakeBattle(), [hit("metal", 50, false, a, 1 - a)], head);
    let n = 0, vx = 0;
    fx.glow.forEachLive((_x, _y, _z, v) => {
      n++;
      vx += v;
    });
    fx.dispose();
    return vx / n;
  };
  // Attacker 0 at x=-3 hits fighter 1 at x=+3 (strike along +x): sparks rebound toward -x; the reverse
  // strike sprays toward +x.
  assert(meanVx(0) < -0.5, `${meanVx(0)}`);
  assert(meanVx(1) > 0.5, `${meanVx(1)}`);
});

Deno.test("[P7 fx] P7_DEFAULTS = no signature (identity), intensity scales counts, pulse 0 = no glow", () => {
  const evs = (): BattleEvent[] => [
    hit("fire", 30, true),
    { seq: ++seq, t: 0, type: "phase", label: "dash", a: 0, b: 1, element: "air", pos: { x: 2, y: 0, z: 0 } },
    { seq: ++seq, t: 0, type: "phase", label: "cone", a: 0, b: 1, element: "ice", value: 5, pos: { x: -3, y: 1, z: 0 } },
    { seq: ++seq, t: 0, type: "phase", label: "beam", a: 0, b: 1, element: "light", pos: { x: 3, y: 0, z: 0 } },
    { seq: ++seq, t: 0, type: "clash", element: "water", pos: { x: 0, y: 1, z: 0 } },
  ];
  const run = (sig?: typeof P7_DEFAULTS.fx) => {
    const fx = new FxDirector(new THREE.Scene());
    if (sig) fx.setFighterFx(0, sig);
    const b = fakeBattle();
    fx.consume(b, evs(), head);
    fx.update(b, 1 / 60, 0);
    const xs: number[] = [];
    fx.glow.forEachLive((x, y, z, _a, _b, _c, s, r, g, bb) => xs.push(x, y, z, s, r, g, bb));
    const s = fx.stats();
    fx.dispose();
    return { s, xs };
  };
  const a = run(), d = run({ ...P7_DEFAULTS.fx });
  assertEquals(d.s, a.s);
  assertEquals(d.xs, a.xs);
  const hi = run({ ...P7_DEFAULTS.fx, intensity: 1.6 }), lo = run({ ...P7_DEFAULTS.fx, intensity: 0.6 });
  assert(hi.s.glowSpawned > a.s.glowSpawned && a.s.glowSpawned > lo.s.glowSpawned, `${lo.s.glowSpawned} ${a.s.glowSpawned} ${hi.s.glowSpawned}`);
  assertEquals(scaledCount(17, 1), 17);
  assertEquals(scaledCount(10, 1.6), 16);
  for (let t = 0; t < 5; t += 0.13) {
    assertEquals(pulseGlow(0, t), 0);
    const p = pulseGlow(1, t);
    assert(p >= 0 && p <= 0.45 + 1e-9, `pulse ${p}`);
  }
  const ws = Array.from({ length: 40 }, (_, k) => pulseGlow(0.7, k * 0.1));
  assert(Math.max(...ws) - Math.min(...ws) > 0.2, "pulse should breathe");
});

Deno.test("[P7 fx] eye aura follows the signature (rate x intensity, hue shift)", () => {
  const emitted = (intensity: number) => {
    const a = new EyeAura("spark", [new THREE.Vector3(0, 0, 0)], 0.1, 0xffffff, "high");
    a.setSignature({ intensity, hueShift: 0 });
    const m = new THREE.Matrix4();
    let n = 0;
    for (let f = 0; f < 30; f++) {
      a.update(1 / 60, m);
      n = Math.max(n, a.alive());
    }
    a.dispose();
    return n;
  };
  assert(emitted(1.6) > emitted(0.6), "intensity should raise the aura rate");
  const a = new EyeAura("smoke", [new THREE.Vector3()], 0.1, 0xffffff);
  const t0 = a.tint();
  a.setSignature({ intensity: 1, hueShift: 0 });
  assertEquals(a.tint(), t0);
  a.setSignature({ intensity: 1, hueShift: 0.08 });
  assert(a.tint() !== t0, "hue shift not applied to the aura");
  a.dispose();
});

Deno.test("[P7 fx] dispose releases every geometry and material the director created", () => {
  const scene = new THREE.Scene();
  const fx = new FxDirector(scene);
  fx.setFighterFx(0, { intensity: 1.4, trail: 1, sparkle: 1, pulse: 0.5, hueShift: 0.05 });
  const p: FakeProj = { id: 7, owner: 0, pos: { x: 0, y: 1, z: 0 }, vel: { x: 10, y: 0, z: 0 }, radius: 0.3, element: "water" };
  const b = fakeBattle([p]);
  fx.consume(b, [
    { seq: ++seq, t: 0, type: "projectile", a: 0, b: 1, value: 7, element: "water", pos: { x: 0, y: 1, z: 0 } },
    hit("fire", 60, true),
    hit("electric", 60, true),
    hit("water", 60, true),
    { seq: ++seq, t: 0, type: "phase", label: "beam", a: 0, b: 1, element: "light", pos: { x: 3, y: 0, z: 0 } },
    { seq: ++seq, t: 0, type: "lightning", pos: { x: 0, y: 0, z: 0 } },
  ], head);
  fx.update(b, 1 / 60, 0);
  const geos = new Set<THREE.BufferGeometry>(), mats = new Set<THREE.Material>();
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry) geos.add(m.geometry);
    if (m.material) for (const x of Array.isArray(m.material) ? m.material : [m.material]) mats.add(x);
  });
  assert(geos.size >= 5 && mats.size >= 6, `${geos.size} geos ${mats.size} mats`);
  const s = fx.stats();
  assert(s.transients.decal > 0 && s.transients.bolt > 0 && s.transients.ring > 0 && s.projectiles === 1, JSON.stringify(s));
  const gd = new Set<unknown>(), md = new Set<unknown>();
  geos.forEach((g) => g.addEventListener("dispose", () => gd.add(g)));
  mats.forEach((m) => m.addEventListener("dispose", () => md.add(m)));
  fx.dispose();
  assertEquals(gd.size, geos.size, "geometries disposed");
  assertEquals(md.size, mats.size, "materials disposed");
  assertEquals(scene.children.length, 0);
  assertEquals(fx.stats().projectiles, 0);
});
