// Motion lane (pass 7): the heritable motion personality (helix.p7.motion) in the animator.
// - identity: no p7 / P7_DEFAULTS animate bit-identically to the frozen pass-6 animator;
// - each gene moves its measurable in the intended direction (numbers printed with `MOTION` prefix);
// - every joint stays inside constrainPose limits / budgets at the gene extremes, no NaN over long runs
//   with dt spikes, frame-rate independence at the extremes.
import { assert } from "./_assert.ts";
import { randomGenome } from "../src/genome/genome.ts";
import { express, type Phenotype } from "../src/genome/phenotype.ts";
import { emptyConditions } from "../src/genome/epigenetics.ts";
import { helixOf } from "../src/genome/helix.ts";
import type { MorphHelix } from "../src/genome/morphTypes.ts";
import { type MotionP7, P7_DEFAULTS } from "../src/genome/p7Types.ts";
import { buildSkeleton, forwardKinematics, type Pose, type Skeleton, skeletonGenes } from "../src/body/skeleton.ts";
import type { Move } from "../src/combat/moves.ts";
import type { Phase } from "../src/combat/battle.ts";
import { type AnimInput, type AnimOutput, Animator, motionOf, springStepDamped } from "../src/render/animator.ts";
import { Animator as Pass6Animator } from "../artifacts/p7/animator_pre_p7.ts";

type Kind = Phenotype["kind"];
interface Fixture {
  ph: Phenotype;
  sk: Skeleton;
  helix: MorphHelix;
}

function creature(kind: Kind, seed: number): Fixture {
  const g = randomGenome(seed, undefined, { kind });
  const ph = express(g, emptyConditions());
  const helix = helixOf(g, ph);
  return { ph, sk: buildSkeleton(ph, skeletonGenes(helix)), helix };
}

/** First seed of `kind` whose skeleton passes `ok` (deterministic fixture search). */
function find(kind: Kind, ok: (f: Fixture) => boolean, from = 1): Fixture {
  for (let s = from; s < from + 400; s++) {
    const f = creature(kind, s);
    if (f.sk.kind === kind && ok(f)) return f;
  }
  throw new Error(`no ${kind} fixture`);
}

const count = (sk: Skeleton, role: string) => sk.joints.filter((j) => j.role === role).length;

/** The helix with its motion genes replaced (other p7 genes kept); unspecified motion genes = defaults. */
function withMotion(h: MorphHelix, m: Partial<MotionP7>): MorphHelix {
  return { ...h, p7: { ...(h.p7 ?? P7_DEFAULTS), motion: { ...P7_DEFAULTS.motion, ...m } } };
}

const MAX: MotionP7 = { followThrough: 1, anticipation: 1, jitter: 1, sway: 1, bounce: 1, stiffness: 1.6 };
const MIN: MotionP7 = { followThrough: 0, anticipation: 0, jitter: 0, sway: 0, bounce: 0, stiffness: 0.6 };

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const still = () => 0.5;

const CALM = { joy: 0, anger: 0, fear: 0, sadness: 0, surprise: 0 } as unknown as Phenotype["psyche"]["emotions"];

function input(o: Partial<AnimInput> = {}): AnimInput {
  return {
    dt: 1 / 60,
    t: 0,
    phase: "idle",
    progress: 0,
    move: null,
    speed: 0,
    maxSpeed: 5,
    flying: false,
    burrowed: false,
    frozen: false,
    koT: 0,
    stagger: 0,
    emotions: CALM,
    energy01: 1,
    hp01: 1,
    lookYaw: 0,
    lookPitch: 0,
    normal: { x: 0, y: 1, z: 0 },
    liquid: false,
    ...o,
  };
}

const mv = (o: Partial<Move>) => ({ id: "t", name: "t", element: "neutral", shape: "melee", power: 90, accuracy: 1, range: 1, area: 0, speed: 0, charge: 1, active: 0.3, rest: 0.5, effects: [], tags: [], tier: 2, ...o }) as unknown as Move;
const BITE = mv({ id: "t-bite", part: "jaw" });
const BEAM = mv({ id: "t-beam", shape: "beam", tier: 3, slot: "ultimate", power: 130 } as Partial<Move>);
const BURST = mv({ id: "t-burst", shape: "burst", part: "mass" });

/** A long scripted life touching every animator branch (12 s cycle). */
function scene(t: number): Partial<AnimInput> {
  const c = t % 12;
  const emo = { ...CALM, joy: c < 3 ? 0.8 : 0, anger: c > 6 ? 0.6 : 0, fear: c > 9 ? 0.5 : 0, surprise: c > 4 && c < 5 ? 1 : 0 } as typeof CALM;
  const base: Partial<AnimInput> = { emotions: emo, lookYaw: Math.sin(t * 0.7) * 1.6, lookPitch: Math.sin(t * 0.3) * 0.4, energy01: 0.5 + 0.5 * Math.cos(t * 0.2) };
  if (c < 1.5) return base;
  if (c < 3) return { ...base, speed: 3.5, liquid: c > 2.5 };
  if (c < 4) return { ...base, phase: "charge" as Phase, progress: c - 3, move: BITE };
  if (c < 4.3) return { ...base, phase: "active" as Phase, progress: (c - 4) / 0.3, move: BITE };
  if (c < 5) return { ...base, phase: "rest" as Phase, progress: (c - 4.3) / 0.7, move: BITE };
  if (c < 6) return { ...base, phase: "charge" as Phase, progress: c - 5, move: BEAM, flying: c > 5.5 };
  if (c < 6.4) return { ...base, phase: "active" as Phase, progress: (c - 6) / 0.4, move: BEAM, flying: true, speed: 2 };
  if (c < 7) return { ...base, phase: "charge" as Phase, progress: (c - 6.4) / 0.6, move: BURST, stagger: 1 };
  if (c < 7.3) return { ...base, phase: "active" as Phase, progress: (c - 7) / 0.3, move: BURST };
  if (c < 8) return { ...base, frozen: c > 7.6, burrowed: c < 7.5 };
  if (c < 9.5) return { ...base, state: { asleep: true, sleepy: 1, hunger: 0.8, bloat: 0.5, tempo: 0.7 } };
  if (c < 10.5) return { ...base, speed: 1.2, state: { hunger: 1 } };
  return { ...base, koT: c - 10.5 + 0.001 };
}

/** Frame dt schedule: mixed rates and occasional spikes (deterministic). */
function dtAt(k: number): number {
  if (k % 97 === 50) return 0.25;
  if (k % 41 === 7) return 0;
  return [1 / 60, 1 / 30, 1 / 144, 1 / 75][k % 4];
}

/** Drive one animator through a script; `ev` fires one-shot reactions at frame k. */
function drive(a: { update(i: AnimInput): AnimOutput; hit(s: number, c: boolean): void; land(s: number): void; feed(k?: "food" | "gear" | "cosmetic"): void }, frames: number, each: (k: number, out: AnimOutput) => void, dtf = dtAt, script = scene) {
  let t = 0;
  for (let k = 0; k < frames; k++) {
    const dt = dtf(k);
    t += dt;
    if (k % 90 === 30) a.hit(0.3 + 0.5 * ((k / 90) % 2), k % 180 === 30);
    if (k % 300 === 120) a.land(4);
    if (k % 500 === 200) a.feed(k % 1000 === 200 ? "food" : "gear");
    each(k, a.update(input({ dt, t, ...script(t) })));
  }
}

function samePose(sk: Skeleton, a: AnimOutput, b: AnimOutput, where: string): void {
  for (const j of sk.joints) {
    const x = a.pose[j.id], y = b.pose[j.id];
    for (let ax = 0; ax < 3; ax++) assert(Object.is(x?.[ax], y?.[ax]), `${where}: ${j.id}[${ax}] ${x?.[ax]} != ${y?.[ax]}`);
  }
  const sc = (o: AnimOutput) => [o.lift, o.bodyRoll, o.bodyPitch, o.squash[0], o.squash[1], o.jaw, o.lids, o.gaze[0], o.gaze[1], o.charge, o.strain, o.chewing, o.stability];
  const p = sc(a), q = sc(b);
  for (let n = 0; n < p.length; n++) assert(Object.is(p[n], q[n]), `${where}: scalar ${n} ${p[n]} != ${q[n]}`);
}

// ------------------------------------------------------------------ identity

Deno.test("p7 motion identity: no p7 / P7_DEFAULTS animate bit-identically to the frozen pass-6 animator", () => {
  let frames = 0;
  for (const [kind, seed] of [["quadruped", 3], ["biped", 4], ["serpent", 5], ["avian", 6], ["hexapod", 8], ["blob", 9]] as [Kind, number][]) {
    const f = creature(kind, seed);
    const noP7: MorphHelix = { ...f.helix };
    delete noP7.p7;
    const variants: [string, MorphHelix | undefined][] = [["no helix", undefined], ["helix without p7", noP7], ["P7_DEFAULTS", withMotion(f.helix, {})]];
    for (const [name, h] of variants) {
      const oldA = new Pass6Animator(f.sk, f.ph, h, mulberry(seed));
      const newA = new Animator(f.sk, f.ph, h, mulberry(seed));
      const outs: AnimOutput[] = [];
      drive(oldA, 1500, (_, o) => outs.push(o));
      drive(newA, 1500, (k, o) => {
        samePose(f.sk, o, outs[k], `${kind}#${seed} ${name} frame ${k}`);
        frames++;
      });
    }
  }
  console.log(`MOTION identity: ${frames} frames x every joint and output scalar bit-identical (Object.is) to the pass-6 animator`);
});

// ------------------------------------------------------------------ gene effects

/** Best lag (s) of `b` behind `a` by cross-correlation, searched over 0..maxLag. */
function lagOf(a: number[], b: number[], dt: number, maxLag = 0.45): number {
  let best = 0, bestC = -Infinity;
  const ma = a.reduce((s, x) => s + x, 0) / a.length, mb = b.reduce((s, x) => s + x, 0) / b.length;
  for (let L = 0; L <= Math.round(maxLag / dt); L++) {
    let c = 0;
    for (let k = 0; k + L < a.length; k++) c += (a[k] - ma) * (b[k + L] - mb);
    if (c > bestC) bestC = c, best = L;
  }
  return best * dt;
}

Deno.test("p7 followThrough: the tail tip lags the wag more (and more than the base); the head lags and overshoots a look step", () => {
  const f = find("quadruped", (x) => count(x.sk, "tail") >= 3);
  const tail = f.sk.joints.filter((j) => j.chain === "tail" && j.role === "tail").map((j) => j.id);
  const tip = tail[tail.length - 1], base = tail[0];
  const fps = 120;
  const series = (ft: number) => {
    const a = new Animator(f.sk, f.ph, withMotion(f.helix, { followThrough: ft }), still);
    const tipS: number[] = [], baseS: number[] = [];
    const joy = { ...CALM, joy: 0.4 } as typeof CALM;
    for (let k = 0; k < fps * 8; k++) {
      const o = a.update(input({ dt: 1 / fps, t: k / fps, emotions: joy }));
      if (k >= fps * 2) tipS.push(o.pose[tip][1]), baseS.push(o.pose[base][1]);
    }
    return { tipS, baseS };
  };
  const ref = series(0);
  const lags = [0, 0.5, 1].map((ft) => {
    const s = series(ft);
    return { ft, tip: lagOf(ref.tipS, s.tipS, 1 / fps), base: lagOf(ref.baseS, s.baseS, 1 / fps) };
  });
  console.log(`MOTION followThrough tail (${tail.length} joints, joy 0.4 wag) phase lag vs ft=0: ${lags.map((l) => `ft ${l.ft}: base ${l.base.toFixed(3)} s, tip ${l.tip.toFixed(3)} s`).join("; ")}`);
  assert(lags[1].tip > lags[0].tip && lags[2].tip > lags[1].tip, `tip lag not growing: ${JSON.stringify(lags)}`);
  assert(lags[2].tip > lags[2].base, `tip should lag more than the base: ${JSON.stringify(lags[2])}`);

  // Look step: the neck + head yaw sum reaches the target later and overshoots it with follow-through.
  const g = find("quadruped", (x) => count(x.sk, "neck") >= 2);
  const yawSum = (p: Pose) => g.sk.joints.filter((j) => j.role === "neck" || j.role === "head").reduce((s, j) => s + (p[j.id]?.[1] ?? 0), 0);
  const step = (ft: number) => {
    const a = new Animator(g.sk, g.ph, withMotion(g.helix, { followThrough: ft }), still);
    for (let k = 0; k < 120; k++) a.update(input({ dt: 1 / 60, t: k / 60 }));
    const ys: number[] = [];
    for (let k = 0; k < 240; k++) ys.push(yawSum(a.update(input({ dt: 1 / 60, t: 2 + k / 60, lookYaw: 0.6 })).pose));
    const fin = ys[ys.length - 1];
    const t50 = ys.findIndex((y) => y >= 0.5 * fin) / 60;
    return { ft, t50, overshoot: Math.max(...ys) / fin - 1 };
  };
  const st = [0, 1].map(step);
  console.log(`MOTION followThrough look step 0.6 rad: ${st.map((s) => `ft ${s.ft}: t50 ${s.t50.toFixed(3)} s, overshoot ${(100 * s.overshoot).toFixed(1)} %`).join("; ")}`);
  assert(st[1].t50 > st[0].t50, `no neck lag: ${JSON.stringify(st)}`);
  assert(st[1].overshoot > st[0].overshoot, `no overshoot growth: ${JSON.stringify(st)}`);
});

Deno.test("p7 anticipation: the wind-up pulls back deeper before a bite (opposite to the strike)", () => {
  const f = find("quadruped", (x) => count(x.sk, "neck") >= 1);
  const pitchSum = (p: Pose) => f.sk.joints.filter((j) => j.role === "neck" || j.role === "head").reduce((s, j) => s + (p[j.id]?.[0] ?? 0), 0);
  const run = (an: number) => {
    const a = new Animator(f.sk, f.ph, withMotion(f.helix, { anticipation: an }), still);
    for (let k = 0; k < 60; k++) a.update(input({ dt: 1 / 60, t: k / 60 }));
    let windMin = Infinity, strikeMax = -Infinity;
    for (let k = 0; k <= 60; k++) windMin = Math.min(windMin, pitchSum(a.update(input({ dt: 1 / 60, t: 1 + k / 60, phase: "charge", progress: k / 60, move: BITE })).pose));
    for (let k = 0; k <= 18; k++) strikeMax = Math.max(strikeMax, pitchSum(a.update(input({ dt: 1 / 60, t: 2 + k / 60, phase: "active", progress: k / 18, move: BITE })).pose));
    return { an, windMin, excursion: strikeMax - windMin };
  };
  const r = [0, 0.5, 1].map(run);
  console.log(`MOTION anticipation (bite, neck+head pitch, - = pulled back): ${r.map((x) => `a ${x.an}: wind-up min ${x.windMin.toFixed(3)} rad, strike excursion ${x.excursion.toFixed(3)} rad`).join("; ")}`);
  assert(r[1].windMin < r[0].windMin - 0.01 && r[2].windMin < r[1].windMin - 0.01, `wind-up not deeper: ${JSON.stringify(r)}`);
  assert(r[2].excursion > r[0].excursion, `strike excursion not larger: ${JSON.stringify(r)}`);
});

function std(xs: number[]): number {
  const m = xs.reduce((s, x) => s + x, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length);
}

Deno.test("p7 jitter and sway: idle variance grows with each gene", () => {
  const f = find("quadruped", (x) => count(x.sk, "tail") >= 1);
  const idle = (m: Partial<MotionP7>) => {
    const a = new Animator(f.sk, f.ph, withMotion(f.helix, m), still);
    const head: number[] = [], roll: number[] = [], spineZ: number[] = [];
    const sp = f.sk.joints.find((j) => j.role === "spine")!.id;
    for (let k = 0; k < 60 * 20; k++) {
      const o = a.update(input({ dt: 1 / 60, t: k / 60 }));
      if (k < 120) continue;
      // Frame-to-frame head motion (micro-motion) and slow posture spread.
      head.push(o.pose.head[0] + o.pose.head[1]);
      roll.push(o.bodyRoll);
      spineZ.push(o.pose[sp][2]);
    }
    const dHead = head.slice(1).map((h, k) => Math.abs(h - head[k]));
    return { headStd: std(head), headSpeed: dHead.reduce((s, x) => s + x, 0) / dHead.length * 60, rollStd: std(roll), spineZStd: std(spineZ) };
  };
  const j = [0, 0.5, 1].map((x) => ({ x, ...idle({ jitter: x }) }));
  const s = [0, 0.5, 1].map((x) => ({ x, ...idle({ sway: x }) }));
  console.log(`MOTION jitter idle 20 s: ${j.map((r) => `j ${r.x}: head std ${r.headStd.toFixed(4)} rad, mean head speed ${r.headSpeed.toFixed(4)} rad/s`).join("; ")}`);
  console.log(`MOTION sway idle 20 s: ${s.map((r) => `s ${r.x}: bodyRoll std ${r.rollStd.toFixed(4)} rad, spine z std ${r.spineZStd.toFixed(4)} rad`).join("; ")}`);
  assert(j[1].headStd > j[0].headStd && j[2].headStd > j[1].headStd, `jitter head std not growing ${JSON.stringify(j)}`);
  assert(j[2].headSpeed > 2 * j[0].headSpeed + 1e-3, `jitter head speed ${JSON.stringify(j)}`);
  assert(s[1].rollStd > s[0].rollStd && s[2].rollStd > s[1].rollStd, `sway roll std not growing ${JSON.stringify(s)}`);
  assert(s[2].spineZStd > s[0].spineZStd, `sway spine ${JSON.stringify(s)}`);
});

Deno.test("p7 bounce: the vertical bob of the gait grows with the gene, synced to footfalls", () => {
  for (const kind of ["quadruped", "biped"] as Kind[]) {
    const f = creature(kind, 21);
    // A size-relative walk (~1.5 body heights / s, half the top speed): about 2 strides / s.
    const speed = 1.5 * f.sk.height, maxSpeed = 2 * speed;
    const walk = (b: number) => {
      const a = new Animator(f.sk, f.ph, withMotion(f.helix, { bounce: b }), still);
      const lifts: number[] = [], sq: number[] = [];
      for (let k = 0; k < 60 * 6; k++) {
        const o = a.update(input({ dt: 1 / 60, t: k / 60, speed, maxSpeed }));
        if (k > 90) lifts.push(o.lift), sq.push(o.squash[1]);
      }
      return { b, lifts, bob: Math.max(...lifts) - Math.min(...lifts), squash: Math.max(...sq) - Math.min(...sq) };
    };
    const r = [0, 0.5, 1].map(walk);
    // The bounce-only component (same gait phase in every run): ~0 at each footfall, peaks between.
    const d = r[2].lifts.map((x, k) => x - r[0].lifts[k]);
    const dMin = Math.min(...d), dMax = Math.max(...d);
    console.log(`MOTION bounce ${kind} (H ${f.sk.height.toFixed(2)} m, speed ${speed.toFixed(2)} m/s): ${r.map((x) => `b ${x.b}: lift range ${x.bob.toFixed(4)} m, squash range ${x.squash.toFixed(4)}`).join("; ")}; bounce component ${dMin.toFixed(4)}..${dMax.toFixed(4)} m`);
    assert(r[1].bob > r[0].bob && r[2].bob > r[1].bob, `${kind} bob not growing ${JSON.stringify(r.map((x) => x.bob))}`);
    assert(r[2].squash > r[0].squash + 0.005, `${kind} no footfall squash ${JSON.stringify(r.map((x) => x.squash))}`);
    assert(dMin < 0.15 * dMax, `${kind} bounce never returns to the ground at footfalls: ${dMin}..${dMax}`);
  }
});

Deno.test("p7 stiffness: posture settle time shrinks as the spring omega multiplier grows", () => {
  const f = creature("quadruped", 3);
  const settle = (st: number) => {
    const a = new Animator(f.sk, f.ph, withMotion(f.helix, { stiffness: st }), still);
    for (let k = 0; k < 120; k++) a.update(input({ dt: 1 / 60, t: k / 60 }));
    const knee = f.sk.joints.find((j) => j.role === "knee")!.id;
    const xs: number[] = [];
    for (let k = 0; k < 600; k++) xs.push(a.update(input({ dt: 1 / 60, t: 2 + k / 60, phase: "charge", progress: 1, move: BITE })).pose[knee][0]);
    const x0 = xs[0], x1 = xs[xs.length - 1];
    return { st, t90: xs.findIndex((x) => Math.abs(x - x0) >= 0.9 * Math.abs(x1 - x0)) / 60 };
  };
  const r = [0.6, 1, 1.6].map(settle);
  console.log(`MOTION stiffness (knee to 90 % of a held wind-up): ${r.map((x) => `s ${x.st}: t90 ${x.t90.toFixed(3)} s`).join("; ")}`);
  assert(r[0].t90 > r[1].t90 && r[1].t90 > r[2].t90, `settle not shrinking ${JSON.stringify(r)}`);
});

// ------------------------------------------------------------------ input-driven improvements

Deno.test("p7 directed hit: recoil away from the attacker; turnRate banks into the turn and leads with the head", () => {
  const f = find("quadruped", (x) => count(x.sk, "tail") >= 1 && count(x.sk, "neck") >= 1);
  const sp = f.sk.joints.find((j) => j.role === "spine")!.id;
  const after = (fromYaw: number | undefined) => {
    const a = new Animator(f.sk, f.ph, f.helix, still);
    for (let k = 0; k < 60; k++) a.update(input({ dt: 1 / 60, t: k / 60 }));
    a.hit(0.8, false, fromYaw);
    let o = a.update(input({ dt: 1 / 60, t: 1 }));
    for (let k = 0; k < 6; k++) o = a.update(input({ dt: 1 / 60, t: 1 + k / 60 }));
    return { spinePitch: o.pose[sp][0], headYaw: o.pose.head[1], roll: o.bodyRoll };
  };
  const calm = after(undefined), front = after(0), back = after(Math.PI), left = after(Math.PI / 2), right = after(-Math.PI / 2);
  const q = (o: { spinePitch: number; headYaw: number; roll: number }) => `spine pitch ${o.spinePitch.toFixed(3)}, head yaw ${o.headYaw.toFixed(3)}, roll ${o.roll.toFixed(3)}`;
  console.log(`MOTION directed hit 0.8 (+7 frames): front ${q(front)} | back ${q(back)} | left ${q(left)} | right ${q(right)} | undirected ${q(calm)}`);
  assert(front.spinePitch < back.spinePitch - 0.05, "front blow should pitch back, rear blow forward");
  assert(left.headYaw < right.headYaw - 0.02, "a blow from the left turns the head right (away)");
  assert(left.roll > right.roll + 0.01, "a blow from the left tips the body right (away)");

  const turning = (rate: number | undefined) => {
    const a = new Animator(f.sk, f.ph, f.helix, still);
    let o = a.update(input({ dt: 1 / 60, t: 0, speed: 3, turnRate: rate }));
    for (let k = 1; k < 120; k++) o = a.update(input({ dt: 1 / 60, t: k / 60, speed: 3, turnRate: rate }));
    const neckYaw = f.sk.joints.filter((j) => j.role === "neck").reduce((s, j) => s + o.pose[j.id][1], 0);
    const tailYaw = f.sk.joints.filter((j) => j.role === "tail").reduce((s, j) => s + o.pose[j.id][1], 0);
    return { roll: o.bodyRoll, neckYaw, tailYaw };
  };
  const tl = turning(2), tn = turning(0);
  console.log(`MOTION turnRate +2 rad/s walking: roll ${tl.roll.toFixed(3)} (straight ${tn.roll.toFixed(3)}), neck yaw ${tl.neckYaw.toFixed(3)} (${tn.neckYaw.toFixed(3)}), tail yaw ${tl.tailYaw.toFixed(3)} (${tn.tailYaw.toFixed(3)})`);
  assert(tl.roll < tn.roll - 0.02, "banks into a left turn");
  assert(tl.neckYaw > tn.neckYaw + 0.05, "head leads the turn");
  assert(tl.tailYaw < tn.tailYaw - 0.02, "tail trails the turn");
});

// ------------------------------------------------------------------ bounds, NaN, frame rate

/** Within the dynamic (coupled) limits computed from the output pose, and within every chain budget. */
function checkLimits(sk: Skeleton, o: AnimOutput, where: string): number {
  let worst = 0;
  for (const j of sk.joints) {
    const v = o.pose[j.id];
    assert(v !== undefined, `${where}: ${j.id} missing`);
    for (let ax = 0; ax < 3; ax++) {
      assert(Number.isFinite(v[ax]), `${where}: ${j.id}[${ax}] not finite`);
      let [lo, hi] = j.limits[ax];
      for (const c of j.couplings) {
        if (c.axis !== ax) continue;
        const th = o.pose[c.src]?.[c.srcAxis] ?? 0;
        lo += c.loLin * th + c.loAbs * Math.abs(th);
        hi += c.hiLin * th + c.hiAbs * Math.abs(th);
      }
      if (lo > hi) lo = hi = (lo + hi) / 2;
      worst = Math.max(worst, lo - v[ax], v[ax] - hi);
    }
  }
  for (const [name, ch] of Object.entries(sk.chains)) {
    for (let ax = 0; ax < 3; ax++) {
      const sum = ch.joints.reduce((s, i) => s + Math.abs(o.pose[sk.joints[i].id][ax]), 0);
      assert(sum <= ch.budget[ax] + 1e-9, `${where}: chain ${name} axis ${ax} ${sum} > budget ${ch.budget[ax]}`);
    }
  }
  for (const x of [o.lift, o.bodyRoll, o.bodyPitch, o.squash[0], o.squash[1], o.jaw, o.lids, o.gaze[0], o.gaze[1], o.strain]) assert(Number.isFinite(x), `${where}: output not finite`);
  assert(Math.abs(o.bodyRoll) < 0.9, `${where}: roll ${o.bodyRoll}`);
  assert(o.jaw >= 0 && o.jaw <= 0.65, `${where}: jaw ${o.jaw}`);
  return worst;
}

Deno.test("p7 bounds: all genes at max and at min, every kind, 60 s at mixed rates with 0.25 s spikes: finite, inside limits and budgets", () => {
  const report: string[] = [];
  for (const [kind, seed] of [["quadruped", 3], ["biped", 4], ["serpent", 5], ["avian", 6], ["hexapod", 8], ["blob", 9]] as [Kind, number][]) {
    const f = creature(kind, seed);
    for (const [name, m] of [["max", MAX], ["min", MIN], ["defaults", P7_DEFAULTS.motion]] as [string, MotionP7][]) {
      const a = new Animator(f.sk, f.ph, withMotion(f.helix, m), mulberry(seed));
      let worst = 0, strain = 0, n = 0, maxRoll = 0;
      // ~60 s of simulated time: 4100 frames of the mixed schedule (mean dt ~ 0.0147 s incl. spikes).
      drive(a, 4100, (k, o) => {
        worst = Math.max(worst, checkLimits(f.sk, o, `${kind} ${name} frame ${k}`));
        strain += o.strain, n++, maxRoll = Math.max(maxRoll, Math.abs(o.bodyRoll));
      });
      report.push(`${kind}/${name}: worst limit excess ${worst.toExponential(1)} rad, mean strain ${(strain / n).toFixed(3)}, max |roll| ${maxRoll.toFixed(3)}`);
      assert(worst < 0.02, `${kind} ${name}: a joint left its coupled range by ${worst} rad`);
    }
  }
  console.log(`MOTION bounds: ${report.join("; ")}`);
});

Deno.test("p7 NaN: 60 s at 60 fps with all genes at max, dt spikes of 0.25 s every second, stays finite", () => {
  const f = find("quadruped", (x) => count(x.sk, "tail") >= 2 && count(x.sk, "ear") >= 1);
  const a = new Animator(f.sk, f.ph, withMotion(f.helix, MAX), mulberry(1));
  let frames = 0;
  drive(a, 3600, (k, o) => {
    checkLimits(f.sk, o, `frame ${k}`);
    frames++;
  }, (k) => (k % 60 === 59 ? 0.25 : 1 / 60));
  console.log(`MOTION NaN: ${frames} frames (60 s + 60 spikes of 0.25 s, all genes max, ${count(f.sk, "tail")} tail joints, ${count(f.sk, "ear")} ears): all finite and inside limits`);
});

Deno.test("p7 frame-rate independence at the gene extremes: 30 vs 120 fps end near the same pose", () => {
  // Same plan as the pass-5 test (idle -> walk -> charge -> rest, 2.5 s), then the full plan with a
  // strike (the pass-6 posture spring holds its target per frame, so a 0.3 s strike leaves a dt-dependent
  // residual that the rest spring then decays: measured for the defaults too, asserted after 1.5 s idle).
  const soft = (t: number): Partial<AnimInput> => t < 1 ? {} : t < 1.6 ? { speed: 1 } : t < 2 ? { phase: "charge", progress: (t - 1.6) / 0.4, move: BITE } : { phase: "rest", progress: Math.min(1, t - 2), move: BITE };
  const full = (t: number): Partial<AnimInput> =>
    t < 1 ? {} : t < 1.6 ? { speed: 1 } : t < 2.6 ? { phase: "charge", progress: t - 1.6, move: BITE } : t < 2.9 ? { phase: "active", progress: (t - 2.6) / 0.3, move: BITE } : t < 4 ? { phase: "rest", progress: Math.min(1, (t - 2.9) / 0.7), move: BITE } : {};
  const rows: string[] = [];
  for (const [kind, seed] of [["quadruped", 3], ["biped", 4], ["serpent", 5]] as [Kind, number][]) {
    const f = creature(kind, seed);
    let defW1 = 0;
    for (const [name, m] of [["defaults", P7_DEFAULTS.motion], ["max", MAX], ["min", MIN]] as [string, MotionP7][]) {
      const end = (fps: number, plan: (t: number) => Partial<AnimInput>, T: number) => {
        const a = new Animator(f.sk, f.ph, withMotion(f.helix, m), still);
        let o = a.update(input({ dt: 1 / fps, t: 0 }));
        for (let k = 1; k <= T * fps; k++) o = a.update(input({ dt: 1 / fps, t: k / fps, ...plan(k / fps) }));
        return o;
      };
      const diff = (plan: (t: number) => Partial<AnimInput>, T: number) => {
        const a30 = end(30, plan, T), a120 = end(120, plan, T);
        let worst = 0;
        for (const j of f.sk.joints) for (let ax = 0; ax < 3; ax++) worst = Math.max(worst, Math.abs(a30.pose[j.id][ax] - a120.pose[j.id][ax]));
        return worst;
      };
      const w1 = diff(soft, 2.5), w2 = diff(full, 4), w3 = diff(full, 5.5);
      rows.push(`${kind}/${name}: no-strike ${w1.toFixed(4)}, end of rest ${w2.toFixed(4)}, +1.5 s idle ${w3.toFixed(4)} rad`);
      // The pass-6 posture springs hold their target per frame (defaults: 0.015 quadruped .. 0.033 biped
      // arms); anticipation enlarges that target motion, follow-through rides on it. Bound: absolute 0.045
      // or 1.75x the defaults of the same creature, whichever is larger.
      if (name === "defaults") defW1 = w1;
      assert(w1 < Math.max(0.045, 1.75 * defW1), `${kind} ${name}: 30 vs 120 fps differ by ${w1} rad (no strike; defaults ${defW1})`);
      assert(w3 < 0.03, `${kind} ${name}: 30 vs 120 fps differ by ${w3} rad 1.5 s after a strike`);
    }
  }
  console.log(`MOTION frame-rate (worst joint |30 fps - 120 fps|): ${rows.join("; ")}`);
});

// ------------------------------------------------------------------ helpers + inheritance plumbing

Deno.test("springStepDamped: frame-rate independent, overshoots by the textbook ratio, falls back to critical", () => {
  const sim = (fps: number) => {
    let x = 1, v = 0;
    for (let k = 0; k < fps; k++) [x, v] = springStepDamped(x, v, 0, 7, 0.4, 1 / fps);
    return x;
  };
  assert(Math.abs(sim(30) - sim(144)) < 1e-9, "closed form");
  let x = 1, v = 0, min = 1;
  for (let k = 0; k < 600; k++) [x, v] = springStepDamped(x, v, 0, 7, 0.4, 1 / 120), min = Math.min(min, x);
  const expected = Math.exp((-Math.PI * 0.4) / Math.sqrt(1 - 0.16));
  assert(Math.abs(-min - expected) < 2e-3, `overshoot ${-min} vs ${expected}`);
  const [cx] = springStepDamped(1, 0, 0, 7, 1, 0.1);
  assert(cx > 0, "critical never crosses");
});

Deno.test("p7 motion genes reach the animator from the helix of real genomes (clamped to their ranges)", () => {
  const seen: Record<string, number[]> = {};
  for (let s = 1; s <= 60; s++) {
    const g = randomGenome(s);
    const ph = express(g, emptyConditions());
    const h = helixOf(g, ph);
    const a = new Animator(buildSkeleton(ph, skeletonGenes(h)), ph, h, still);
    const want = motionOf(h);
    for (const k of Object.keys(want) as (keyof MotionP7)[]) {
      assert(a.motion[k] === want[k], `seed ${s} ${k}`);
      (seen[k] ??= []).push(a.motion[k]);
    }
    assert(a.motion.stiffness >= 0.6 && a.motion.stiffness <= 1.6, "stiffness range");
  }
  const q = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return `min ${s[0].toFixed(2)} med ${s[s.length >> 1].toFixed(2)} max ${s[s.length - 1].toFixed(2)}`;
  };
  console.log(`MOTION genes over 60 random genomes (current calibration): ${Object.entries(seen).map(([k, xs]) => `${k} ${q(xs)}`).join("; ")}`);
  // Heads also see forward kinematics stay finite with a real helix.
  const f = creature("biped", 2);
  const o = new Animator(f.sk, f.ph, f.helix, still).update(input());
  assert(Number.isFinite(forwardKinematics(f.sk, o.pose).end[0].y), "fk finite");
});
