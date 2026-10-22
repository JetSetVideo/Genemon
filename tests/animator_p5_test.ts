// Animation lane (pass 5, P5-A1 / P5-A2): pure helpers of the animator + headless Animator checks.
import { assert, assertAlmostEquals } from "./_assert.ts";
import { randomGenome } from "../src/genome/genome.ts";
import { express, type Phenotype } from "../src/genome/phenotype.ts";
import { emptyConditions } from "../src/genome/epigenetics.ts";
import { buildSkeleton, forwardKinematics, type Pose, type Skeleton } from "../src/body/skeleton.ts";
import type { Move } from "../src/combat/moves.ts";
import type { Phase } from "../src/combat/battle.ts";
import type { LifeState } from "../src/genome/lifeTypes.ts";
import {
  ageTempo,
  type AnimInput,
  Animator,
  animStateFromLife,
  distributeLook,
  type LookLimits,
  slitherEnvelope,
  slitherWave,
  springAngle,
  springStep,
  wrapAngle,
} from "../src/render/animator.ts";
import { FlashLimiter, SpawnBudget } from "../src/render/fx.ts";
import { clientToNdc } from "../src/render/labView.ts";

function creature(kind: Phenotype["kind"], seed = 7): { ph: Phenotype; sk: Skeleton } {
  const g = randomGenome(seed, undefined, { kind });
  const ph = express(g, emptyConditions());
  return { ph, sk: buildSkeleton(ph) };
}

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

const BITE = { id: "t-bite", name: "bite", element: "neutral", shape: "melee", power: 90, accuracy: 1, range: 1, area: 0, speed: 0, charge: 1, active: 0.3, rest: 0.5, effects: [], tags: [], tier: 2, part: "jaw" } as unknown as Move;

/** Run an animator for `secs` at `fps`; `at(t)` gives the per-frame overrides. Returns the last output. */
function run(a: Animator, secs: number, fps: number, at: (t: number) => Partial<AnimInput> = () => ({}), t0 = 0) {
  const dt = 1 / fps;
  const n = Math.round(secs * fps);
  let out = a.update(input({ dt, t: t0, ...at(t0) }));
  for (let k = 1; k <= n; k++) {
    const t = t0 + k * dt;
    out = a.update(input({ dt, t, ...at(t) }));
  }
  return out;
}

function headY(sk: Skeleton, pose: Pose, lift: number): number {
  const fk = forwardKinematics(sk, pose);
  return fk.end[sk.index.get("head")!].y + lift;
}

const still = () => 0.5;

// ------------------------------------------------------------------ springs

Deno.test("springStep: critically damped, converges without overshoot from rest", () => {
  for (const fps of [24, 60, 144]) {
    let x = 1, v = 0, prev = 1;
    for (let k = 0; k < fps * 3; k++) {
      [x, v] = springStep(x, v, 0, 6, 1 / fps);
      assert(x <= prev + 1e-12, `monotonic at ${fps} fps`);
      assert(x >= -1e-12, `no overshoot at ${fps} fps (x=${x})`);
      prev = x;
    }
    assert(x < 2e-3, `converged at ${fps} fps: ${x}`);
  }
});

Deno.test("springStep: frame-rate independent (closed form)", () => {
  const sim = (fps: number) => {
    let x = 0.8, v = -0.3;
    for (let k = 0; k < fps; k++) [x, v] = springStep(x, v, 0.2, 5, 1 / fps);
    return [x, v];
  };
  const [a, av] = sim(30), [b, bv] = sim(144);
  const [c, cv] = springStep(0.8, -0.3, 0.2, 5, 1);
  assertAlmostEquals(a, c, 1e-9);
  assertAlmostEquals(b, c, 1e-9);
  assertAlmostEquals(av, cv, 1e-9);
  assertAlmostEquals(bv, cv, 1e-9);
});

Deno.test("springAngle: takes the short way round the circle", () => {
  let x = 3.0, v = 0;
  for (let k = 0; k < 120; k++) [x, v] = springAngle(x, v, -3.0, 8, 1 / 60);
  assertAlmostEquals(wrapAngle(x - -3.0), 0, 1e-3);
  // It went through +pi (short way, 0.28 rad) rather than through 0 (6 rad): never near 0.
  let y = 3.0, w = 0, minAbs = Infinity;
  for (let k = 0; k < 60; k++) {
    [y, w] = springAngle(y, w, -3.0, 8, 1 / 60);
    minAbs = Math.min(minAbs, Math.abs(y));
  }
  assert(minAbs > 2.5, `crossed through 0: ${minAbs}`);
});

// ------------------------------------------------------------------ look-at

Deno.test("distributeLook: each joint within its range; reachable looks are exact, others saturate", () => {
  const chain: LookLimits[] = [
    { pitch: [-0.3, 0.3], yaw: [-0.2, 0.2] },
    { pitch: [-0.6, 0.5], yaw: [-0.7, 0.7] },
    { pitch: [-0.4, 0.4], yaw: [-0.45, 0.45] },
  ];
  for (const [yaw, pitch] of [[0.5, 0.2], [-1.0, -0.5], [3, 2], [-3, -2], [0, 0]]) {
    const out = distributeLook(yaw, pitch, chain, [0.35, 1, 1.4]);
    let sy = 0, sp = 0;
    out.forEach(([p, y], i) => {
      assert(y >= chain[i].yaw[0] - 1e-12 && y <= chain[i].yaw[1] + 1e-12, `yaw joint ${i} ${y}`);
      assert(p >= chain[i].pitch[0] - 1e-12 && p <= chain[i].pitch[1] + 1e-12, `pitch joint ${i} ${p}`);
      sy += y;
      sp += p;
    });
    const maxY = 1.35, maxP = pitch > 0 ? 1.2 : 1.3;
    assertAlmostEquals(sy, Math.max(-maxY, Math.min(maxY, yaw)), 1e-9, `yaw sum for ${yaw}`);
    assertAlmostEquals(sp, Math.max(-maxP, Math.min(maxP, pitch)), 1e-9, `pitch sum for ${pitch}`);
  }
});

Deno.test("Animator: the head turns toward the target, clamped to the neck / head limits", () => {
  const { ph, sk } = creature("quadruped", 11);
  const a = new Animator(sk, ph, undefined, still);
  const near = run(a, 3, 60, () => ({ lookYaw: 0.6 }));
  const look = (pose: Pose) => sk.joints.filter((j) => j.role === "neck" || j.role === "head").reduce((s, j) => s + (pose[j.id]?.[1] ?? 0), 0);
  assert(look(near.pose) > 0.35, `head did not turn toward +0.6: ${look(near.pose)}`);
  const far = run(a, 3, 60, () => ({ lookYaw: 2.8 }));
  for (const j of sk.joints) {
    const v = far.pose[j.id];
    if (!v) continue;
    for (let ax = 0; ax < 3; ax++) assert(Number.isFinite(v[ax]), `finite ${j.id}`);
    if (j.role === "neck" || j.role === "head") {
      const [lo, hi] = j.limits[1];
      assert(v[1] >= lo - 1e-9 && v[1] <= hi + 1e-9, `${j.id} yaw ${v[1]} outside [${lo}, ${hi}]`);
    }
  }
  assert(Math.abs(far.gaze[0]) <= 0.3 + 1e-9, "pupil residual clamped");
});

// ------------------------------------------------------------------ serpents

Deno.test("slitherWave: the crest travels tail-ward as the phase advances; amplitude grows to the tail", () => {
  const n = 48;
  const crest = (phase: number) => {
    // First crest from the head (local maximum near +1).
    for (let k = 0; k < n; k++) if (slitherWave(k, n, phase) > 0.995) return k;
    return -1;
  };
  let prev = crest(Math.PI / 2 + 0.05);
  assert(prev >= 0, "crest found");
  for (let s = 1; s <= 6; s++) {
    const c = crest(Math.PI / 2 + 0.05 + s * 0.6);
    assert(c > prev, `crest moved head-ward: ${prev} -> ${c}`);
    prev = c;
  }
  assert(slitherEnvelope(n - 1, n) > slitherEnvelope(0, n), "tail swings wider than the neck");
});

Deno.test("Animator serpent: slithers when moving and REARS UP on a charge (front up, rear down)", () => {
  const { ph, sk } = creature("serpent", 5);
  assert(sk.kind === "serpent", "fixture is a serpent");
  const a = new Animator(sk, ph, undefined, still);
  const idle = run(a, 2, 60);
  const y0 = headY(sk, idle.pose, idle.lift);
  // Moving: segments carry a yaw wave of both signs.
  const mv = run(a, 1.5, 60, () => ({ speed: 3 }), 2);
  const yaws = sk.joints.filter((j) => j.role === "segment").map((j) => mv.pose[j.id]?.[1] ?? 0);
  assert(yaws.some((y) => y > 0.02) && yaws.some((y) => y < -0.02), `no travelling wave: ${yaws.map((y) => y.toFixed(3))}`);
  // Charge a bite: the head lifts.
  const ch = run(a, 1.2, 60, (t) => ({ phase: "charge" as Phase, progress: Math.min(1, (t - 3.5) / 1), move: BITE }), 3.5);
  const y1 = headY(sk, ch.pose, ch.lift);
  assert(y1 > y0 + 0.03 * sk.height, `no rear-up: head ${y0.toFixed(3)} -> ${y1.toFixed(3)} (H ${sk.height.toFixed(2)})`);
  // The rear stays on the ground.
  const fk = forwardKinematics(sk, ch.pose);
  const last = sk.joints.length - 1 - [...sk.joints].reverse().findIndex((j) => j.role === "segment");
  assert(fk.end[last].y + ch.lift < 0.25 * sk.height, `tail lifted: ${fk.end[last].y + ch.lift}`);
});

// ------------------------------------------------------------------ smoothness & states

Deno.test("Animator: posture is frame-rate independent and never snaps between phases", () => {
  const { ph, sk } = creature("quadruped", 3);
  const plan = (t: number): Partial<AnimInput> => t < 1 ? {} : t < 2 ? { phase: "charge", progress: t - 1, move: BITE } : { phase: "rest", progress: Math.min(1, t - 2), move: BITE };
  const a30 = run(new Animator(sk, ph, undefined, still), 2.5, 30, plan);
  const a120 = run(new Animator(sk, ph, undefined, still), 2.5, 120, plan);
  let worst = 0;
  for (const j of sk.joints) for (let ax = 0; ax < 3; ax++) worst = Math.max(worst, Math.abs((a30.pose[j.id]?.[ax] ?? 0) - (a120.pose[j.id]?.[ax] ?? 0)));
  assert(worst < 0.03, `30 vs 120 fps differ by ${worst} rad`);
  // Max per-frame change of any joint at 60 fps across the idle -> charge -> active -> rest switches.
  const a = new Animator(sk, ph, undefined, still);
  let prev: Pose | null = null, jump = 0;
  for (let k = 0; k <= 240; k++) {
    const t = k / 60;
    const ph4: Partial<AnimInput> = t < 1 ? {} : t < 2 ? { phase: "charge", progress: t - 1, move: BITE } : t < 2.3 ? { phase: "active", progress: (t - 2) / 0.3, move: BITE } : { phase: "rest", progress: Math.min(1, (t - 2.3) / 0.7), move: BITE };
    const out = a.update(input({ dt: 1 / 60, t, ...ph4 }));
    if (prev) for (const j of sk.joints) for (let ax = 0; ax < 3; ax++) jump = Math.max(jump, Math.abs((out.pose[j.id]?.[ax] ?? 0) - (prev[j.id]?.[ax] ?? 0)));
    prev = out.pose;
  }
  assert(jump < 0.12, `a joint jumped ${jump} rad in one 60 fps frame`);
});

Deno.test("Animator states: asleep closes the lids and lowers the head; KO collapses it", () => {
  const { ph, sk } = creature("quadruped", 9);
  const awake = run(new Animator(sk, ph, undefined, still), 4, 60);
  const sleeper = run(new Animator(sk, ph, undefined, still), 6, 60, () => ({ state: { asleep: true, sleepy: 1 } }));
  assert(sleeper.lids > 0.9, `lids ${sleeper.lids}`);
  assert(headY(sk, sleeper.pose, sleeper.lift) < headY(sk, awake.pose, awake.lift) - 0.02 * sk.height, "asleep head not lower");
  const ko = run(new Animator(sk, ph, undefined, still), 3, 60, (t) => ({ koT: t + 0.001 }));
  assert(headY(sk, ko.pose, ko.lift) < headY(sk, awake.pose, awake.lift), "KO head not lower");
  assert(ko.lids >= 0.99, "KO eyes shut");
});

Deno.test("Animator feed(): chews (the jaw opens and closes) then ends", () => {
  const { ph, sk } = creature("biped", 4);
  const a = new Animator(sk, ph, undefined, still);
  run(a, 1, 60);
  a.feed("food");
  let lo = Infinity, hi = -Infinity, chewed = 0;
  for (let k = 0; k < 60 * 3.2; k++) {
    const out = a.update(input({ dt: 1 / 60, t: 1 + k / 60 }));
    if (out.chewing > 0.5) chewed++, lo = Math.min(lo, out.jaw), hi = Math.max(hi, out.jaw);
  }
  assert(chewed > 30, `chewing frames ${chewed}`);
  assert(hi - lo > 0.08, `jaw range while chewing ${lo}..${hi}`);
  assert(!a.feeding, "feed reaction ended");
});

Deno.test("animStateFromLife: empty stomach = hungry, overfull = bloated, elders slower", () => {
  const life = (units: number): LifeState => ({
    version: 1,
    digestion: { diet: "omnivore", stomach: units ? [{ food: "berry", units, eatenAt: 0, digested: 0 }] : [], capacity: 10, hoursPerUnit: 1, lastTick: 0 },
    scars: [],
    imprints: [],
    chronotype: 12,
    altitudeM: 0,
    lastTick: 0,
    fatigue: 0,
  });
  assertAlmostEquals(animStateFromLife(life(0)).hunger, 1, 1e-9);
  assertAlmostEquals(animStateFromLife(life(8)).hunger, 0, 1e-9);
  assertAlmostEquals(animStateFromLife(life(8)).bloat, 0, 1e-9);
  assert(animStateFromLife(life(14)).bloat > 0.5, "bloat");
  assertAlmostEquals(animStateFromLife(undefined).hunger, 0, 1e-9);
  assert(ageTempo("elder") < 1 && ageTempo("ancient") < ageTempo("elder"), "elders slower");
});

// ------------------------------------------------------------------ FX + lab helpers

Deno.test("FlashLimiter: weak, capped, never twice inside the gap", () => {
  const f = new FlashLimiter(1.6, 0.45, 0.24);
  const a = f.request(0.8, 0);
  assert(a > 0 && a <= 0.24, `first ${a}`);
  assertAlmostEquals(f.request(0.8, 0.5), 0, 0, "second inside the gap");
  assert(f.request(0.8, 1.7) > 0, "after the gap");
  assertAlmostEquals(f.request(0.05, 5), 0, 0, "too weak to show");
});

Deno.test("SpawnBudget: a flood degrades to the refill rate", () => {
  const b = new SpawnBudget(100, 50);
  assertAlmostEquals(b.take(80), 50, 0);
  assertAlmostEquals(b.take(10), 0, 0);
  b.refill(0.1);
  assertAlmostEquals(b.take(80), 10, 0);
  b.refill(10);
  assertAlmostEquals(b.available, 50, 1e-9);
});

Deno.test("clientToNdc: centre, corners, outside", () => {
  const r = { left: 100, top: 50, width: 400, height: 200 };
  const c = clientToNdc(300, 150, r)!;
  assertAlmostEquals(c[0], 0, 1e-12);
  assertAlmostEquals(c[1], 0, 1e-12);
  const tl = clientToNdc(100, 50, r)!;
  assertAlmostEquals(tl[0], -1, 1e-12);
  assertAlmostEquals(tl[1], 1, 1e-12);
  assert(clientToNdc(99, 60, r) === null && clientToNdc(200, 251, r) === null, "outside");
  assert(clientToNdc(1, 1, { left: 0, top: 0, width: 0, height: 10 }) === null, "degenerate");
});
