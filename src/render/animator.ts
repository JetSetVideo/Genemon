/**
 * Animator: turns a fighter's state into a skeleton Pose every frame, then passes it through
 * constrainPose() (dynamic coupled limits + chain budgets) before it reaches the mesh.
 *
 * Pass 5 [P5-A1, P5-A2] - smoother, slower, head-aware and state-aware:
 * - Two layers. POSTURE targets (emotion posture, life state, attack phases, KO, feeding) are low-pass
 *   filtered per joint and per axis by an exact critically-damped spring (springStep: frame-rate
 *   independent, never overshoots a step), whose stiffness depends on the phase (slow idle / rest
 *   blends, a fast but never instant strike). OSCILLATORS (breath, gait, wag, slither, flaps, chew,
 *   sniff, tremor) run on accumulated phases (a frequency change never jumps the phase) and are added
 *   on top with spring-smoothed amplitudes, so nothing snaps between phases.
 * - Head-aware: a Gaze (eyes saccade to a fixation, the head follows on a slower spring) is distributed
 *   over the chest, neck and head within each joint's limits and the neck chain budget
 *   (distributeLook); the residual the head could not reach is returned for the pupils (out.gaze).
 * - State-aware: hunger (droop + sniff bursts), sleepiness / sleep (lids, slow deep breath, head low,
 *   legs fold), bloat (slow, waddle), age tempo (elders slower), charging driven by the move's body
 *   PART (mouth/jaw opens wide, claws raise the limbs, horns lower the head, tail cocks, wings spread),
 *   a ROAR on special / ultimate charges, KO collapse.
 * - Serpents slither: a travelling sine of the yaw along root + segments (slitherWave) whose phase
 *   velocity follows the ground speed, and REAR UP on a charge / strike (front lifts, rear stays down).
 * - Mouths: the jaw breathes, chews (feed()) and roars.
 * Every amplitude still goes through env() = boundTrait(helix.anim[ch]) / REF [P4-V2].
 *
 * Pass 7 [P7 motion lane] - a heritable MOTION PERSONALITY (`helix.p7.motion`, Pareto-shaped genes):
 * - followThrough: tail / neck(+head) chains and ears LAG the body (overlapping action): each chain joint's
 *   world angle is tracked by an underdamped spring (springStepDamped) whose stiffness falls and whose
 *   overshoot grows toward the tip; the chain's local angles are rebuilt from the lagged world angles.
 * - anticipation: a counter-motion opposite to the coming strike late in the wind-up (inside the windup
 *   envelope w), so the strike starts from further back.
 * - jitter: idle micro-saccades of the head, ear / tail-tip twitches, a fine spine tremor, from a
 *   per-creature deterministic noise stream; events are timed inside the frame (frame-rate independent).
 * - sway: a slow idle weight shift (body roll, spine lean, level head, a drifting neck).
 * - bounce: a vertical bob in the gait (high between footfalls) and a squash kick at each footfall.
 * - stiffness: multiplies every posture / flinch / jaw / squash / follow-through spring omega.
 * Two input-driven improvements: hit(strength, crit, fromYaw) recoils AWAY from the attacker, and
 * AnimInput.turnRate banks the body into a turn, leads with the head, trails the tail.
 * Identity: with no helix.p7 (or P7_DEFAULTS) and no fromYaw / turnRate, every pose is bit-identical to
 * the pass-6 animator (tests/p7_motion_test.ts drives both side by side).
 */
import { balanceOf, constrainPose, forwardKinematics, type Pose, type Skeleton, type Vec3 } from "../body/skeleton.ts";
import type { Move } from "../combat/moves.ts";
import type { Phase } from "../combat/battle.ts";
import type { Emotions, Phenotype } from "../genome/phenotype.ts";
import { clamp } from "../core/math.ts";
import type { AnimChannel, MorphHelix } from "../genome/morphTypes.ts";
import type { LifePhase, LifeState } from "../genome/lifeTypes.ts";
import { boundTrait } from "../genome/helix.ts";
import { type MotionP7, P7_DEFAULTS } from "../genome/p7Types.ts";

/**
 * Reference amplitude of each channel in the pre-helix animator: a channel's envelope multiplies the
 * motion by boundTrait(min gene, max gene, drive) / REF, so a creature without a helix animates exactly
 * as before and a helix bounds every motion between its two genes [P4-V2].
 */
const REF: Record<AnimChannel, number> = { breath: 0.03, gait: 0.45, tail: 0.3, wingFlap: 0.85, headBob: 0.15, windup: 0.6, strike: 0.7, recoil: 0.3, squash: 0.35 };

const TAU = Math.PI * 2;

// ------------------------------------------------------------------ pure helpers (tested)

/**
 * One step of an exact critically-damped spring toward `target` (stiffness omega, rad/s). Closed form,
 * so the result does not depend on how dt is sliced (frame-rate independent), and from rest it
 * approaches a step target monotonically (no overshoot). Returns [x, v].
 */
export function springStep(x: number, v: number, target: number, omega: number, dt: number): [number, number] {
  if (dt <= 0 || omega <= 0) return [x, v];
  const e = x - target;
  const k = v + omega * e;
  const ex = Math.exp(-omega * dt);
  return [target + (e + k * dt) * ex, (v - omega * k * dt) * ex];
}

/**
 * One exact step of a damped spring toward `target` with damping ratio `zeta` (< 1 = underdamped: it
 * overshoots a step by exp(-pi zeta / sqrt(1 - zeta^2))). Closed form, so frame-rate independent for a
 * held target. zeta >= 1 falls back to the critically damped springStep. Returns [x, v].
 */
export function springStepDamped(x: number, v: number, target: number, omega: number, zeta: number, dt: number): [number, number] {
  if (zeta >= 1) return springStep(x, v, target, omega, dt);
  if (dt <= 0 || omega <= 0) return [x, v];
  const z = Math.max(0.05, zeta);
  const wd = omega * Math.sqrt(1 - z * z);
  const e = x - target;
  const ex = Math.exp(-z * omega * dt), c = Math.cos(wd * dt), s = Math.sin(wd * dt);
  const B = (v + z * omega * e) / wd;
  return [target + ex * (e * c + B * s), ex * (v * c - ((omega * omega * e + z * omega * v) / wd) * s)];
}

/**
 * Damped spring step toward a target that moves LINEARLY from `from` to `to` during dt (first-order
 * hold): exact, so a smoothly moving target gives the same trajectory at any frame rate. The particular
 * solution of x'' + 2 zeta w x' + w^2 (x - (a + r t)) = 0 is a + r t - 2 zeta r / w; the rest is homogeneous.
 */
export function springStepRamp(x: number, v: number, from: number, to: number, omega: number, zeta: number, dt: number): [number, number] {
  if (dt <= 0 || omega <= 0) return [x, v];
  const r = (to - from) / dt, lagK = (2 * Math.min(1, zeta) * r) / omega;
  const [y, vy] = springStepDamped(x - (from - lagK), v - r, 0, omega, zeta, dt);
  return [y + to - lagK, vy + r];
}

/** Motion-personality genes clamped to their declared ranges (P7_DEFAULTS when absent). */
export function motionOf(helix?: MorphHelix): MotionP7 {
  const m = (helix?.p7 ?? P7_DEFAULTS).motion;
  const u = (x: number) => (Number.isFinite(x) ? clamp(x, 0, 1) : 0);
  return {
    followThrough: u(m.followThrough),
    anticipation: u(m.anticipation),
    jitter: u(m.jitter),
    sway: u(m.sway),
    bounce: u(m.bounce),
    stiffness: Number.isFinite(m.stiffness) ? clamp(m.stiffness, 0.6, 1.6) : 1,
  };
}

/** Angle wrapped to (-pi, pi]. */
export function wrapAngle(a: number): number {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

/** Critically-damped spring on an angle: takes the short way round, result wrapped. */
export function springAngle(x: number, v: number, target: number, omega: number, dt: number): [number, number] {
  const [nx, nv] = springStep(x, v, x + wrapAngle(target - x), omega, dt);
  return [wrapAngle(nx), nv];
}

/** Smoothstep 0..1. */
export function smooth01(x: number): number {
  x = clamp(x, 0, 1);
  return x * x * (3 - 2 * x);
}

/** Fast rise to the peak then slower fall (continuous at the peak). */
export function impulse(p: number, peak: number): number {
  p = clamp(p, 0, 1);
  return p < peak ? Math.sin((Math.PI / 2) * (p / peak)) : Math.cos((Math.PI / 2) * ((p - peak) / (1 - peak)));
}

/** Pitch / yaw ranges (radians) one joint of a look chain may take. */
export interface LookLimits {
  pitch: [number, number];
  yaw: [number, number];
}

/**
 * Spread a look (yaw + = left, pitch + = down) over a chain of joints (chest .. neck .. head), each
 * clamped to its own range; what a saturated joint cannot take is handed to the others. Returns one
 * [pitch, yaw] per joint. The sum equals the request when the chain can reach it, else the chain's
 * extreme; no joint ever leaves its range.
 */
export function distributeLook(yaw: number, pitch: number, chain: LookLimits[], weights?: number[]): [number, number][] {
  const out: [number, number][] = chain.map(() => [0, 0]);
  const w = weights ?? chain.map((_, i) => i + 1);
  for (const axis of [0, 1] as const) {
    let rest = axis === 0 ? pitch : yaw;
    const free = new Set(chain.map((_, i) => i).filter((i) => w[i] > 0));
    for (let pass = 0; pass < chain.length + 1 && free.size > 0 && Math.abs(rest) > 1e-9; pass++) {
      let ws = 0;
      for (const i of free) ws += w[i];
      let given = 0;
      for (const i of [...free]) {
        const [lo, hi] = axis === 0 ? chain[i].pitch : chain[i].yaw;
        const want = out[i][axis] + (rest * w[i]) / ws;
        const got = clamp(want, Math.min(lo, hi), Math.max(lo, hi));
        given += got - out[i][axis];
        out[i][axis] = got;
        if (got !== want) free.delete(i);
      }
      rest -= given;
    }
  }
  return out;
}

/**
 * Serpent travelling wave, unit amplitude: segment k of n (0 = behind the head) at wave phase `phase`.
 * The crest sits where phase - kappa k = pi/2, so as the phase grows the crest moves to larger k: the
 * wave travels TAIL-WARD (what pushes a snake forward).
 */
export function slitherWave(k: number, n: number, phase: number, waves = 1.2): number {
  const kappa = (TAU * waves) / Math.max(1, n);
  return Math.sin(phase - kappa * k);
}

/** Slither amplitude along the body: small behind the head (it stays aimed), largest at the tail. */
export function slitherEnvelope(k: number, n: number): number {
  return 0.4 + 0.6 * (n > 1 ? k / (n - 1) : 1);
}

/** Age tempo: how fast a life phase moves (elders slower, hatchlings a little brisker). */
export function ageTempo(phase?: LifePhase): number {
  switch (phase) {
    case "fetus":
    case "egg":
      return 0.6;
    case "hatchling":
      return 1.1;
    case "juvenile":
      return 1.05;
    case "elder":
      return 0.78;
    case "ancient":
      return 0.62;
    default:
      return 1;
  }
}

/** Life-state drives of the animation (0..1 each; tempo multiplies speeds, 1 = a rested adult). */
export interface AnimState {
  hunger: number;
  sleepy: number;
  asleep: boolean;
  bloat: number;
  tempo: number;
}
export const AWAKE: AnimState = { hunger: 0, sleepy: 0, asleep: false, bloat: 0, tempo: 1 };

/**
 * Animation drives from a LifeState (pure; consumers pass the phase / circadian state they computed):
 * stomach fullness below a third reads as hunger, fullness past capacity as bloat, fatigue as
 * sleepiness. A missing LifeState is a rested, fed adult.
 */
export function animStateFromLife(life: LifeState | undefined, o: { phase?: LifePhase; asleep?: boolean; alertness?: number } = {}): AnimState {
  const tempo = ageTempo(o.phase);
  if (!life) return { ...AWAKE, tempo, asleep: !!o.asleep, sleepy: o.alertness !== undefined ? clamp(1 - o.alertness, 0, 1) : 0 };
  const d = life.digestion;
  let full = 0;
  for (const it of d.stomach) full += it.units * (1 - clamp(it.digested, 0, 1));
  const ratio = full / Math.max(0.01, d.capacity);
  const fatigue = clamp(life.fatigue, 0, 1);
  const alert = o.alertness !== undefined ? clamp(1 - o.alertness, 0, 1) : 0;
  return {
    hunger: clamp(1 - ratio / 0.33, 0, 1),
    bloat: clamp((ratio - 1) / 0.5, 0, 1),
    sleepy: Math.max(clamp((fatigue - 0.35) / 0.65, 0, 1), alert),
    asleep: !!o.asleep,
    tempo,
  };
}

/**
 * Gaze: eyes SACCADE (a fast jump) to a fixation near the target, hold it a while (sometimes glancing
 * away when calm), and the head follows the eyes on a slower critically-damped spring. Render-only
 * randomness (`rand`, Math.random by default) never reaches the simulation.
 */
export class Gaze {
  /** Head angles (what the neck chain is asked to do). */
  yaw = 0;
  pitch = 0;
  /** Eye angles (where the eyes actually point, head space included). */
  eyeYaw = 0;
  eyePitch = 0;
  private vy = 0;
  private vp = 0;
  private evy = 0;
  private evp = 0;
  private fixY = 0;
  private fixP = 0;
  private hold = 0;
  constructor(private rand: () => number = Math.random) {}

  update(targetYaw: number, targetPitch: number, weight: number, dt: number, tempo = 1, calm = 0.5): void {
    const ty = targetYaw * weight, tp = targetPitch * weight;
    this.hold -= dt;
    // A big target move re-fixates at once; otherwise re-fixate when the hold runs out.
    if (this.hold <= 0 || Math.abs(ty - this.fixY) > 0.35 || Math.abs(tp - this.fixP) > 0.3) {
      const glance = this.rand() < 0.18 * calm;
      this.fixY = ty + (glance ? (this.rand() - 0.5) * 0.9 : (this.rand() - 0.5) * 0.08);
      this.fixP = tp + (glance ? (this.rand() - 0.3) * 0.3 : (this.rand() - 0.5) * 0.05);
      this.hold = (glance ? 0.35 + 0.4 * this.rand() : 0.7 + 1.6 * this.rand()) / Math.max(0.3, tempo);
    }
    // Saccade: eyes ~0.1 s; head: ~0.8 s (slower with age).
    [this.eyeYaw, this.evy] = springStep(this.eyeYaw, this.evy, this.fixY, 34, dt);
    [this.eyePitch, this.evp] = springStep(this.eyePitch, this.evp, this.fixP, 34, dt);
    const w = 4.2 * tempo;
    [this.yaw, this.vy] = springStep(this.yaw, this.vy, this.fixY, w, dt);
    [this.pitch, this.vp] = springStep(this.pitch, this.vp, this.fixP, w, dt);
  }
}

// ------------------------------------------------------------------ animator

export interface AnimInput {
  dt: number;
  t: number;
  phase: Phase;
  progress: number;
  move: Move | null;
  speed: number;
  maxSpeed: number;
  flying: boolean;
  burrowed: boolean;
  frozen: boolean;
  koT: number;
  stagger: number;
  emotions: Emotions;
  energy01: number;
  hp01: number;
  /** Target direction in creature space: yaw (rad, + = left) and pitch (rad, + = down). */
  lookYaw: number;
  lookPitch: number;
  /** Ground normal in creature space. */
  normal: { x: number; y: number; z: number };
  liquid: boolean;
  /** 0 = nothing to look at (gaze relaxes forward), 1 = look at (lookYaw, lookPitch). Default 1. */
  lookWeight?: number;
  /** Life-state drives (hunger, sleep, bloat, age tempo); absent = a rested adult [P5-A2]. */
  state?: Partial<AnimState>;
  /**
   * Body heading rate (rad/s, + = turning toward + lookYaw, i.e. left). Absent = no turn reaction
   * (pass-6 behaviour). Present: the body banks into the turn, the head leads it, the tail trails.
   */
  turnRate?: number;
}

export interface AnimOutput {
  pose: Pose;
  strain: number;
  stability: number;
  squash: Vec3;
  bodyPitch: number;
  bodyRoll: number;
  lift: number;
  charge: number;
  /** Eye residual (yaw, pitch) the head did not take: for the pupils, clamped to +-0.3 rad. */
  gaze: [number, number];
  /** Minimum lid closure 0 (open) .. 1 (shut): sleepy / asleep / KO. */
  lids: number;
  /** Jaw opening actually applied (rad), for mouth FX. */
  jaw: number;
  /** 0..1 while a feed reaction chews (FX at the mouth). */
  chewing: number;
}

export type FeedKind = "food" | "gear" | "cosmetic";

/** Posture spring stiffness per phase (rad/s): slow blends in and out, a quick but never instant strike. */
const OMEGA: Record<Phase, number> = { idle: 4, charge: 6, active: 18, rest: 3.2 };
/** Feed reaction timeline (s): dip, chew, happy wiggle. */
const FEED = { dip: 0.55, chew: 2.0, end: 2.9 };

export class Animator {
  private gait = 0;
  private flap = 0;
  private hitK = 0;
  private hitV = 0;
  private hitT = 0;
  private hitSide = 1;
  private squashV = 0;
  private squash = 0;
  private frame = 0;
  private stability = 1;
  private lastPose: Pose = {};
  private lastOut: AnimOutput | null = null;
  private roles = new Map<string, string>();
  private legs: { hip: string; knee: string; ankle: string; offset: number; front: boolean }[] = [];
  private spine: string[] = [];
  private tail: string[] = [];
  private segs: string[] = [];
  private pods: string[] = [];
  private necks: string[] = [];
  private arms: { id: string; side: number }[] = [];
  private elbows: string[] = [];
  private wings: { id: string; role: string; side: number }[] = [];
  /** Indices of ground-contact joints (feet, pods, serpent belly) for grounding. */
  private contacts: number[] = [];
  /** Look chain (chest?, necks, head) with its static ranges. */
  private lookIds: string[] = [];
  private lookLim: LookLimits[] = [];
  private lookW: number[] = [];
  /** Posture springs: per joint [x, y, z, vx, vy, vz]. */
  private springs = new Map<string, Float64Array>();
  private primed = false;
  // Oscillator phases (accumulated: a frequency change never jumps them).
  private brPh = 0;
  private wagPh = 0;
  private slPh = 0;
  private sniffPh = 0;
  private sniffFast = 0;
  private wobPh = 0;
  private chewPh = 0;
  // Smoothed scalar drives [value, velocity].
  private sm = new Map<string, [number, number]>();
  readonly gaze: Gaze;
  /** Feed reaction clock (s since feed(), < 0 = none) and its kind. */
  private feedT = -1;
  private feedKind: FeedKind = "food";
  // ---- pass 7: motion personality (all inert at P7_DEFAULTS)
  /** Clamped motion genes (P7_DEFAULTS when the helix has no p7). */
  readonly motion: MotionP7;
  /** Follow-through chains: joint ids base -> tip, ancestor ids, lagged world angles F / velocities V
   *  per joint and axis ([k * 2 + axis], axes pitch / yaw), ear side (0 = a chain, +-1 = an ear). */
  private ftChains: { ids: string[]; anc: string[]; F: Float64Array; V: Float64Array; T: Float64Array; ear: number; tail: boolean }[] = [];
  private ftPrimed = false;
  /** Directed hit: recoil pitch factor (+1 = from the front) and lateral factor; null side = legacy flinch. */
  private hitDirected = false;
  private hitPitchK = 1;
  private hitLat = 0;
  /** Jitter: deterministic per-creature noise state, micro-saccade target / spring, twitch clock. */
  private nz = 1;
  private jitT = 0;
  private jitTY = 0;
  private jitTP = 0;
  private jitY = 0;
  private jitVY = 0;
  private jitP = 0;
  private jitVP = 0;
  private twT = 0.8;
  private twAge = 1e3;
  private twJ = 0;
  private twS = 1;
  private tremPh = 0;
  private twitchers: { id: string; axis: number; amp: number }[] = [];
  private swayPh = 0;
  private lastFoot = NaN;

  constructor(readonly sk: Skeleton, readonly ph: Phenotype, readonly helix?: MorphHelix, rand: () => number = Math.random) {
    this.gaze = new Gaze(rand);
    for (const j of sk.joints) this.roles.set(j.id, j.role);
    const hips = sk.joints.filter((j) => j.role === "hip" || (j.role === "shoulder" && j.chain.startsWith("leg")));
    hips.forEach((h) => {
      const knee = sk.joints.find((k) => k.parent === sk.index.get(h.id) && k.role === "knee");
      const ankle = knee ? sk.joints.find((a) => a.parent === sk.index.get(knee.id)) : undefined;
      if (!knee || !ankle) return;
      const front = h.role === "shoulder";
      const left = h.side > 0;
      let offset = 0;
      if (sk.kind === "quadruped") offset = (front ? !left : left) ? 0 : Math.PI;
      else if (sk.kind === "hexapod") {
        const k = Number(h.id.match(/(\d)/)?.[1] ?? 0);
        offset = ((k + (left ? 0 : 1)) % 2) * Math.PI;
      } else offset = left ? 0 : Math.PI;
      this.legs.push({ hip: h.id, knee: knee.id, ankle: ankle.id, offset, front });
    });
    this.spine = sk.joints.filter((j) => j.role === "spine" || j.role === "chest").map((j) => j.id);
    this.tail = sk.joints.filter((j) => j.role === "tail").map((j) => j.id);
    this.segs = sk.joints.filter((j) => j.role === "segment").map((j) => j.id);
    this.pods = sk.joints.filter((j) => j.role === "pod").map((j) => j.id);
    this.necks = sk.joints.filter((j) => j.role === "neck").map((j) => j.id);
    this.arms = sk.joints.filter((j) => j.role === "shoulder" && j.chain.startsWith("arm")).map((j) => ({ id: j.id, side: j.side }));
    this.elbows = sk.joints.filter((j) => j.role === "elbow").map((j) => j.id);
    this.wings = sk.joints.filter((j) => j.role.startsWith("wing")).map((j) => ({ id: j.id, role: j.role, side: j.side }));
    sk.joints.forEach((j, idx) => j.contact && this.contacts.push(idx));
    // Look chain: chest (a little, not for serpents/blobs), every neck joint, the head. Neck ranges are
    // shrunk to the neck chain budget so constrainPose never rescales the look; the head keeps 75 % of
    // its yaw range (its coupling narrows it when the neck turns).
    const neckBudget = sk.chains.neck?.budget;
    const nN = Math.max(1, this.necks.length);
    const lim = (id: string, share = 1): LookLimits | null => {
      const i = sk.index.get(id);
      if (i === undefined) return null;
      const L = sk.joints[i].limits;
      return { pitch: [L[0][0] * share, L[0][1] * share], yaw: [L[1][0] * share, L[1][1] * share] };
    };
    const chest = sk.kind !== "serpent" && sk.kind !== "blob" ? this.spine[this.spine.length - 1] : undefined;
    if (chest) {
      const l = lim(chest, 0.5);
      if (l) this.lookIds.push(chest), this.lookLim.push(l), this.lookW.push(0.35);
    }
    for (const id of this.necks) {
      const l = lim(id);
      if (!l) continue;
      if (neckBudget) {
        const by = (neckBudget[1] / nN) * 0.9, bx = (neckBudget[0] / nN) * 0.9;
        l.yaw = [Math.max(l.yaw[0], -by), Math.min(l.yaw[1], by)];
        l.pitch = [Math.max(l.pitch[0], -bx), Math.min(l.pitch[1], bx)];
      }
      this.lookIds.push(id), this.lookLim.push(l), this.lookW.push(1);
    }
    const hl = lim("head", 0.75);
    if (hl) this.lookIds.push("head"), this.lookLim.push(hl), this.lookW.push(1.4);

    // ---- pass 7 motion personality
    this.motion = motionOf(helix);
    // Per-creature deterministic noise seed (render-only): skeleton shape + mass.
    let h = 2166136261 >>> 0;
    for (const v of [sk.joints.length, Math.round(sk.height * 1e4), Math.round(sk.totalMass * 100), Math.round(ph.elasticity * 1e4)]) {
      h = Math.imul(h ^ (v & 0xffffffff), 16777619) >>> 0;
    }
    this.nz = h || 1;
    this.twT = 0.4 + 1.6 * this.rnd();
    // Follow-through chains: every tail chain, every neck chain (+ the head on the main neck), each ear.
    const ancestors = (n: number): string[] => {
      const out: string[] = [];
      for (let p = sk.joints[n].parent; p >= 0; p = sk.joints[p].parent) out.push(sk.joints[p].id);
      return out;
    };
    const groups = new Map<string, number[]>();
    sk.joints.forEach((j, n) => {
      if (j.role === "tail" || j.role === "neck") {
        const key = `${j.role}:${j.chain}`;
        const g = groups.get(key);
        if (g) g.push(n);
        else groups.set(key, [n]);
      }
    });
    const headIdx = sk.index.get("head");
    for (const [key, idx] of groups) {
      const tip = idx[idx.length - 1];
      if (key.startsWith("neck") && headIdx !== undefined && sk.joints[headIdx].parent === tip) idx.push(headIdx);
      const n = idx.length;
      this.ftChains.push({ ids: idx.map((k) => sk.joints[k].id), anc: ancestors(idx[0]), F: new Float64Array(n * 2), V: new Float64Array(n * 2), T: new Float64Array(n * 2), ear: 0, tail: key.startsWith("tail") });
    }
    sk.joints.forEach((j, n) => {
      if (j.role === "ear") this.ftChains.push({ ids: [j.id], anc: ancestors(n), F: new Float64Array(2), V: new Float64Array(2), T: new Float64Array(2), ear: j.side >= 0 ? 1 : -1, tail: false });
    });
    // Twitchers (jitter): ears flick (z), tail tips flick (yaw); the head nods when there are neither.
    for (const c of this.ftChains) {
      if (c.ear) this.twitchers.push({ id: c.ids[0], axis: 2, amp: 0.25 });
      else if (c.tail) this.twitchers.push({ id: c.ids[c.ids.length - 1], axis: 1, amp: 0.3 });
    }
    if (this.twitchers.length === 0 && this.roles.has("head")) this.twitchers.push({ id: "head", axis: 0, amp: 0.06 });
  }

  /** Render-only deterministic noise in [0, 1) (mulberry32 on the creature seed). */
  private rnd(): number {
    let t = (this.nz = (this.nz + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Envelope of a channel at a drive in [0, 1], relative to the legacy amplitude (1 = unchanged). */
  env(ch: AnimChannel, drive: number): number {
    if (!this.helix) return 1;
    return boundTrait(this.helix.anim[ch], drive) / REF[ch];
  }

  /** Absolute wing-flap amplitude (rad) bounded by the min/max genes. */
  flapAmp(drive: number): number {
    return this.helix ? boundTrait(this.helix.anim.wingFlap, drive) : 0.85;
  }

  /**
   * A hit landed. `fromYaw` (optional, creature space, + = left, 0 = straight ahead) is where the blow
   * came from: the body recoils AWAY from it (pitches back from a frontal blow, lurches forward from
   * behind, bends and tips away from a side blow). Without it, the pass-6 alternating flinch.
   */
  hit(strength: number, crit: boolean, fromYaw?: number): void {
    this.hitT = clamp(this.hitT + strength * (crit ? 1.6 : 1), 0, 1.4);
    this.hitSide = -this.hitSide;
    this.squashV -= strength * (crit ? 4.5 : 2.2) * (0.4 + this.ph.elasticity);
    if (fromYaw !== undefined && Number.isFinite(fromYaw)) {
      const c = Math.cos(fromYaw), s = Math.sin(fromYaw);
      this.hitDirected = true;
      // A side blow still flinches back a little (startle); |pitchK|, |lat| <= 1 keep the legacy envelope.
      this.hitPitchK = clamp(c + 0.3 * (1 - Math.abs(c)), -1, 1);
      this.hitLat = -s;
    } else this.hitDirected = false;
  }

  land(speed: number): void {
    this.squashV -= Math.min(5, speed) * (0.25 + this.ph.elasticity);
  }

  /** Start a feed reaction: head dips, chews (food) or inspects (gear / cosmetic), then a happy wiggle. */
  feed(kind: FeedKind = "food"): void {
    this.feedT = 0;
    this.feedKind = kind;
  }

  /** True while a feed reaction plays. */
  get feeding(): boolean {
    return this.feedT >= 0;
  }

  /** Spring-smoothed scalar (critically damped, omega rad/s). */
  private smooth(key: string, target: number, omega: number, dt: number): number {
    let s = this.sm.get(key);
    if (!s) this.sm.set(key, (s = [target, 0]));
    const r = springStep(s[0], s[1], target, omega, dt);
    s[0] = r[0];
    s[1] = r[1];
    return s[0];
  }

  update(i: AnimInput): AnimOutput {
    if (i.frozen && this.lastOut) return this.finish(this.lastPose, i, 0, 0, 0, this.lastOut.gaze, this.lastOut.lids, this.lastOut.jaw, 0);
    const dt = Math.max(0, Math.min(i.dt, 0.1));
    const P: Pose = {}; // posture targets (spring-smoothed)
    const O: Pose = {}; // oscillators (added after smoothing)
    const put = (pose: Pose) => (id: string | undefined, x = 0, y = 0, z = 0) => {
      if (!id || !this.roles.has(id)) return;
      const a = (pose[id] ??= [0, 0, 0]);
      a[0] += x;
      a[1] += y;
      a[2] += z;
    };
    const p = put(P), o = put(O);
    const necks = (pose: Pose, x: number, y = 0) => {
      const n = Math.max(1, this.necks.length);
      for (const id of this.necks) put(pose)(id, x / n, y / n);
    };

    // ---- drives (smoothed so a state change eases in over ~1-2 s)
    const st = { ...AWAKE, ...(i.state ?? {}) };
    const hunger = this.smooth("hunger", clamp(st.hunger, 0, 1), 1.5, dt);
    const sleepy = this.smooth("sleepy", clamp(st.sleepy, 0, 1), 1.2, dt);
    const asleep = this.smooth("asleep", st.asleep && i.phase === "idle" && i.koT <= 0 ? 1 : 0, 0.9, dt);
    const bloat = this.smooth("bloat", clamp(st.bloat, 0, 1), 1.5, dt);
    const tempo = clamp(st.tempo, 0.4, 1.4) * (1 - 0.22 * bloat) * (1 - 0.25 * sleepy);
    const e = i.emotions;
    const arousal = this.smooth("arousal", clamp(e.anger + e.fear * 0.7 + e.surprise * 0.5, 0, 1.5) * (1 - asleep), 2, dt);
    const amp = (0.65 + 0.35 * i.energy01) * (1 + 0.35 * e.anger) * (1 - 0.3 * e.sadness);
    const H = this.sk.height;
    const serpent = this.sk.kind === "serpent";
    const mo = this.motion;
    const stiff = mo.stiffness;

    // ---- breathing (slow; deeper and slower asleep, quicker when aroused) and emotion posture
    const brHz = (0.32 + 0.45 * arousal) * tempo * (1 - 0.35 * asleep) + 0.08 * (1 - i.energy01);
    this.brPh += dt * TAU * brHz;
    const br = Math.sin(this.brPh);
    const eBreath = this.env("breath", clamp(0.3 + 0.5 * arousal, 0, 1));
    const deep = 1 + 0.7 * asleep + 0.3 * bloat;
    for (const s of this.spine) o(s, br * 0.03 * (1 + arousal) * eBreath * deep);
    necks(P, -0.12 * e.joy + 0.3 * e.sadness + 0.15 * e.fear + 0.08 * e.anger);
    p("head", -0.1 * e.joy + 0.25 * e.sadness + 0.15 * e.fear);
    o("head", 0, 0, Math.sin(this.brPh * 0.5) * 0.05 * e.surprise);
    this.wagPh += dt * TAU * (0.3 + 1.1 * e.joy) * tempo;
    for (const [k, t] of this.tail.entries()) {
      const wag = Math.sin(this.wagPh - k * 0.6) * (0.08 + 0.4 * e.joy) * (1 - 0.8 * asleep) * this.env("tail", clamp(0.3 + 0.6 * e.joy, 0, 1));
      p(t, (0.35 * e.fear - 0.25 * e.anger - 0.1) / (k + 1));
      o(t, 0, wag);
    }
    for (const lg of this.legs) p(lg.knee, 0.18 * e.fear + 0.1 * (1 - i.hp01));

    // ---- life state: hungry (droop + sniff), sleepy / asleep (head low, legs fold), bloated, old
    const stoop = clamp((1 - clamp(st.tempo, 0.4, 1)) / 0.4, 0, 1);
    necks(P, 0.22 * hunger + 0.3 * sleepy + 0.5 * asleep + 0.15 * stoop);
    p("head", 0.1 * hunger + 0.15 * sleepy + 0.25 * asleep);
    for (const s of this.spine) p(s, (0.04 * bloat + 0.04 * stoop) / Math.max(1, this.spine.length / 2));
    if (!serpent) for (const lg of this.legs) p(lg.knee, 0.12 * bloat + 0.85 * asleep), p(lg.hip, (lg.front ? -0.25 : 0.3) * asleep);
    for (const [k, t] of this.tail.entries()) p(t, 0.15 * asleep / (k + 1), 0.3 * asleep);
    if (serpent) for (const s of this.segs) p(s, 0, 0.25 * asleep);
    // Sniff bursts: every ~3 s a quick nose twitch, stronger the hungrier.
    this.sniffPh += dt * TAU * 0.33 * tempo;
    this.sniffFast += dt * TAU * 6;
    const sniff = Math.pow(Math.max(0, Math.sin(this.sniffPh)), 6) * hunger * (1 - asleep) * this.env("headBob", clamp(hunger, 0, 1));
    o("head", Math.sin(this.sniffFast) * 0.045 * sniff);

    // ---- locomotion (oscillators with smoothed amplitudes)
    const legLen = H * 0.45;
    const sp = this.smooth("speed", clamp(i.speed / Math.max(0.5, i.maxSpeed), 0, 1.6), 5, dt);
    const fly = this.smooth("fly", i.flying ? 1 : 0, 3, dt);
    let roll = 0;
    if (fly > 0.02) {
      this.flap += dt * (1.8 + 2.2 * sp) * TAU / Math.sqrt(Math.max(0.5, H)) * tempo;
      // Wing beats bounded by the wingFlap min/max genes: effort (speed, arousal, energy) drives them.
      const flap = this.flapAmp(clamp(0.35 + 0.4 * sp + 0.2 * arousal, 0, 1) * (0.7 + 0.3 * i.energy01)) * fly;
      for (const w of this.wings) {
        if (w.role === "wingRoot") o(w.id, 0, 0, w.side * Math.sin(this.flap) * flap);
        if (w.role === "wingMid") o(w.id, 0, 0, w.side * Math.sin(this.flap - 0.6) * flap * 0.62);
        if (w.role === "wingTip") o(w.id, 0, 0, w.side * Math.sin(this.flap - 1.1) * flap * 0.4);
      }
      for (const lg of this.legs) p(lg.hip, 0.7 * fly), p(lg.knee, 0.9 * fly);
      for (const t of this.tail) p(t, -0.1 * fly);
    }
    if (i.burrowed) for (const s of this.spine) p(s, 0.2);
    // Folded wings (ground): sweep back and drape along the flanks.
    for (const w of this.wings) {
      const g = 1 - fly;
      if (w.role === "wingRoot") p(w.id, 0, w.side * 0.7 * g, -w.side * 0.35 * g);
      if (w.role === "wingMid") p(w.id, 0, w.side * 1.2 * g, -w.side * 0.25 * g);
      if (w.role === "wingTip") p(w.id, 0, w.side * 0.6 * g, 0);
    }
    const ground = (1 - fly) * (i.burrowed ? 0 : 1);
    this.gait += dt * (i.speed / Math.max(0.2, legLen * 1.6)) * TAU * ground;
    const moving = smooth01((sp - 0.03) / 0.12) * ground;
    const A = clamp(0.2 + 0.45 * sp, 0, 0.75) * amp * (i.liquid ? 0.7 : 1) * this.env("gait", clamp(sp, 0, 1)) * moving;
    if (A > 1e-4) {
      for (const lg of this.legs) {
        const ph = this.gait + lg.offset;
        o(lg.hip, -A * Math.sin(ph));
        o(lg.knee, Math.max(0, Math.sin(ph + Math.PI / 2)) * A * 1.4);
        o(lg.ankle, A * 0.5 * Math.sin(ph));
      }
      for (const a of this.arms) o(a.id, 0.6 * A * Math.sin(this.gait + (a.side > 0 ? Math.PI : 0)));
      for (const el of this.elbows) o(el, -0.4 * A);
      if (!serpent) for (const [k, s] of this.segs.entries()) o(s, 0, Math.sin(this.gait * 0.8 - k * 0.7) * 0.32 * amp * moving);
      for (const [k, pd] of this.pods.entries()) o(pd, Math.sin(this.gait + (k * TAU) / Math.max(1, this.pods.length)) * 0.4 * A);
      for (const s of this.spine) o(s, 0, Math.sin(this.gait) * 0.05 * A);
      // Bounce [P7]: the spine pitches with the vertical bob (twice per stride, nose dips at footfalls).
      if (mo.bounce > 0) for (const s of this.spine) o(s, -mo.bounce * 0.06 * A * Math.cos(2 * this.gait) / Math.max(1, this.spine.length / 2));
    }
    // Serpent slither: travelling yaw wave along root + segments, phase velocity from the ground speed
    // (wave speed ~ body speed over a wavelength of the body / 1.2), a slow idle undulation at rest.
    if (serpent && ground > 0) {
      const body = ["root", ...this.segs];
      const n = body.length;
      const segLen = this.sk.joints[0].length;
      const lambda = Math.max(0.2, (n * segLen) / 1.2);
      this.slPh += dt * (0.9 * tempo + (TAU * i.speed) / lambda);
      const sA = (0.07 * (1 - asleep) + 0.22 * clamp(sp, 0, 1.2)) * amp * this.env("gait", clamp(0.3 + sp, 0, 1));
      for (let k = 0; k < n; k++) o(body[k], 0, sA * slitherEnvelope(k, n) * slitherWave(k, n, this.slPh));
      // The head stays aimed: the neck cancels the root's swing.
      necks(O, 0, -sA * slitherEnvelope(0, n) * slitherWave(0, n, this.slPh));
    }
    // Bloated waddle (side to side, slower than the gait).
    roll += Math.sin(this.gait * 0.5 + this.brPh * 0.25) * 0.07 * bloat * this.env("gait", 0.5);
    let lift = this.sk.kind === "biped" || this.sk.kind === "avian" ? Math.abs(Math.sin(this.gait)) * 0.04 * H * sp * moving : 0;
    if (this.sk.kind === "blob") lift += Math.max(0, Math.sin(this.gait * 2)) * 0.06 * H * sp * moving;
    // Bounce [P7]: the body rides high between footfalls (|cos gait| = 0 at each footfall, where
    // sin gait = +-1 plants a foot) and each footfall kicks the squash spring. Serpents glide.
    if (mo.bounce > 0 && !serpent && moving > 1e-3) {
      const bA = mo.bounce * 0.07 * H * clamp(sp, 0, 1.2) * moving * this.env("gait", clamp(sp, 0, 1));
      lift += bA * Math.abs(Math.cos(this.gait));
      const foot = Math.floor((this.gait - Math.PI / 2) / Math.PI);
      if (foot !== this.lastFoot) {
        // Kick per footfall scaled by the step period, so a fast cadence never piles the squash up.
        const stepT = Math.PI / Math.max(1e-3, (i.speed / Math.max(0.2, legLen * 1.6)) * TAU);
        if (Number.isFinite(this.lastFoot)) this.squashV -= mo.bounce * 1.1 * clamp(sp, 0, 1.2) * moving * (0.3 + this.ph.elasticity) * clamp(stepT / 0.3, 0.15, 1);
        this.lastFoot = foot;
      }
    }
    // Turn reaction [P7, input-driven]: bank into the turn, the head leads it, the tail trails outward.
    let turn = 0;
    if (i.turnRate !== undefined) {
      turn = this.smooth("turn", clamp(Number.isFinite(i.turnRate) ? i.turnRate : 0, -4, 4), 6, dt);
      const tk = clamp(0.35 + 0.65 * sp, 0, 1.2) * ground;
      roll += clamp(-0.05 * turn * tk, -0.15, 0.15);
      necks(P, 0, clamp(0.1 * turn, -0.3, 0.3));
      for (const [k, t] of this.tail.entries()) p(t, 0, clamp(-0.08 * turn, -0.25, 0.25) / (k + 1));
    }

    // ---- attack phases (posture targets; the phase spring blends them)
    let charge = 0;
    let jawOpen = 0;
    let jawOsc = 0;
    if (i.move && i.phase !== "idle") {
      const m = i.move, pr = i.progress;
      const melee = m.shape === "melee" || m.shape === "dig" || m.shape === "dash";
      const ranged = m.shape === "projectile" || m.shape === "beam" || m.shape === "zone" || m.shape === "cone";
      // Big moves read big: the wind-up and the strike grow with the move's power (ultimates ~1.5x) [P4-M5].
      const weight = 0.8 + 0.45 * clamp(m.power / 90, 0, 1.6);
      const selfMove = !melee && !ranged && m.shape !== "burst";
      const part = m.part ?? (m.shape === "cone" || m.shape === "beam" ? "mouth" : melee ? "jaw" : undefined);
      const roar = m.slot === "ultimate" || m.tier === 3;
      if (i.phase === "charge") {
        charge = pr;
        const w = Math.sin((Math.PI / 2) * pr) * amp * weight * this.env("windup", clamp(m.power / 140, 0, 1));
        for (const s of this.spine) p(s, -0.22 * w / Math.max(1, this.spine.length / 2));
        for (const lg of this.legs) p(lg.knee, 0.35 * w), p(lg.hip, (lg.front ? 0.15 : -0.1) * w);
        if (melee) necks(P, 0.2 * w), p("head", -0.25 * w), (jawOpen += 0.2 * w);
        if (ranged) necks(P, -0.35 * w), (jawOpen += 0.3 * w);
        if (selfMove) necks(P, -0.3 * w), p("head", -0.3 * w);
        // Wind-up by the delivering body part.
        switch (part) {
          case "mouth":
          case "jaw":
            jawOpen += 0.35 * w; // breath / bite: the mouth opens wide
            break;
          case "claws":
            for (const a of this.arms) p(a.id, -0.6 * w);
            for (const el of this.elbows) p(el, -0.5 * w);
            for (const lg of this.legs) if (lg.front) p(lg.hip, -0.5 * w), p(lg.knee, 0.4 * w);
            break;
          case "horns":
            necks(P, 0.35 * w), p("head", 0.25 * w);
            break;
          case "tail":
            for (const [k, t] of this.tail.entries()) p(t, -0.45 * w / (k + 1), 0.3 * w);
            break;
          case "wings":
            for (const wg of this.wings) if (wg.role === "wingRoot") p(wg.id, 0, -wg.side * 0.5 * w, wg.side * 0.5 * w);
            break;
          case "legs":
            for (const lg of this.legs) p(lg.knee, 0.3 * w);
            break;
          case "mass":
            for (const s of this.spine) p(s, -0.15 * w / Math.max(1, this.spine.length / 2));
            break;
          case "eyes":
          case "aura":
            necks(P, -0.2 * w), p("head", -0.15 * w);
            break;
        }
        for (const a of this.arms) p(a.id, -1.3 * w);
        for (const el of this.elbows) p(el, -1.0 * w);
        for (const wg of this.wings) if (wg.role === "wingRoot") p(wg.id, 0, 0, wg.side * 0.6 * w);
        for (const t of this.tail) p(t, -0.25 * w);
        if (!serpent) for (const [k, s] of this.segs.entries()) p(s, 0, Math.sin(k * 1.1) * 0.25 * w);
        // ROAR on a special / ultimate: late in the charge the head stretches up, jaw wide, a tremor.
        if (roar) {
          const r = smooth01((pr - 0.45) / 0.4) * w;
          necks(P, -0.3 * r), p("head", -0.2 * r);
          jawOpen += 0.45 * r;
          o("head", 0, Math.sin(i.t * 27) * 0.035 * r);
          for (const s of this.spine) o(s, 0, 0, Math.sin(i.t * 23) * 0.015 * r);
        }
        if (serpent) this.rearUp(P, w, pr);
        // Anticipation [P7]: late in the wind-up, a counter-motion OPPOSITE to the coming strike (the body
        // loads back before it springs), scaled by the windup envelope w so the genes never exceed it.
        if (mo.anticipation > 0) {
          const c = mo.anticipation * w * smooth01((pr - 0.15) / 0.6);
          const nSp = Math.max(1, this.spine.length / 2);
          if (melee) {
            for (const s of this.spine) p(s, -0.2 * c / nSp);
            necks(P, -0.4 * c), p("head", -0.2 * c);
            for (const lg of this.legs) {
              if (lg.front) p(lg.hip, 0.4 * c), p(lg.knee, 0.15 * c);
              else p(lg.knee, 0.3 * c);
            }
          } else if (ranged) {
            for (const s of this.spine) p(s, 0.1 * c / nSp);
            necks(P, -0.35 * c), p("head", -0.15 * c);
          } else if (m.shape === "burst") {
            for (const lg of this.legs) p(lg.hip, (lg.front ? 0.3 : -0.3) * c), p(lg.knee, 0.25 * c);
            p("head", 0.25 * c);
          } else {
            necks(P, 0.25 * c), p("head", 0.2 * c);
          }
          for (const a of this.arms) p(a.id, -0.5 * c);
          for (const el of this.elbows) p(el, -0.35 * c);
          for (const wg of this.wings) if (wg.role === "wingRoot") p(wg.id, 0, 0, wg.side * 0.4 * c);
          for (const [k, t] of this.tail.entries()) p(t, -0.2 * c / (k + 1));
          if (serpent) this.rearUp(P, 0.6 * c, pr);
        }
      } else if (i.phase === "active") {
        const s = impulse(pr, m.shape === "cone" ? 0.12 : 0.25) * amp * weight * this.env("strike", clamp(m.power / 140, 0, 1));
        charge = 1 - pr;
        if (melee) {
          for (const sp2 of this.spine) p(sp2, 0.3 * s / Math.max(1, this.spine.length / 2));
          necks(P, 0.35 * s);
          p("head", 0.35 * s);
          jawOpen += 0.65 * (1 - pr);
          for (const lg of this.legs) if (lg.front) p(lg.hip, -0.7 * s), p(lg.knee, -0.1 * s);
        } else if (ranged) {
          necks(P, 0.3 * s);
          // A breath holds the jaw wide open for the whole active phase.
          jawOpen += m.shape === "cone" ? 0.65 * amp : 0.65 * s;
          for (const sp2 of this.spine) p(sp2, -0.12 * s);
        } else if (m.shape === "burst") {
          for (const lg of this.legs) p(lg.hip, (lg.front ? -0.4 : 0.4) * s);
          p("head", -0.4 * s);
          jawOpen += 0.6 * s;
        } else {
          necks(P, -0.45 * s);
          p("head", -0.5 * s);
        }
        for (const a of this.arms) p(a.id, (-1.3 + 1.9 * s) * (melee ? 1 : 0.5));
        for (const wg of this.wings) if (wg.role === "wingRoot") p(wg.id, 0, 0, wg.side * -0.9 * s);
        // A rearing serpent strikes DOWN from its raised posture, settling as the strike ends.
        if (serpent) {
          this.rearUp(P, (1 - pr) * amp * weight, 1);
          if (melee) necks(P, 0.5 * s), p("head", 0.2 * s);
        }
      } else if (i.phase === "rest") {
        const r = (1 - pr) * amp;
        necks(P, 0.18 * r);
        p("head", 0.15 * r);
        for (const t of this.tail) p(t, 0.2 * r);
      }
    }

    // ---- feed reaction: dip, chew / inspect, happy wiggle (lab)
    let chewing = 0;
    let wiggle = 0;
    if (this.feedT >= 0) {
      this.feedT += dt;
      const f = this.feedT;
      const dip = smooth01(f / FEED.dip) * (1 - smooth01((f - FEED.chew) / 0.4));
      if (this.feedKind === "food") {
        necks(P, 0.45 * dip), p("head", 0.3 * dip);
        if (f > FEED.dip * 0.7 && f < FEED.chew) {
          chewing = smooth01((f - FEED.dip * 0.7) / 0.2) * (1 - smooth01((f - FEED.chew + 0.25) / 0.25));
          this.chewPh += dt * TAU * 2.4 * tempo;
          jawOsc += 0.2 * (0.5 - 0.5 * Math.cos(this.chewPh)) * chewing * Math.min(1.5, this.env("headBob", 0.6));
          o("head", 0.05 * Math.sin(this.chewPh) * chewing * this.env("headBob", 0.6));
        }
      } else {
        // Gear / cosmetic: sniff-inspect, then a proud lift (gear) or a preening side look (cosmetic).
        necks(P, 0.3 * dip * (f < FEED.dip * 2 ? 1 : 0.3));
        if (this.feedKind === "gear") necks(P, -0.35 * smooth01((f - FEED.dip * 2) / 0.5) * (1 - smooth01((f - FEED.end + 0.3) / 0.3)));
        else necks(P, 0, Math.sin(f * 3.2) * 0.4 * smooth01((f - FEED.dip) / 0.5) * (1 - smooth01((f - FEED.end + 0.4) / 0.4)));
        o("head", Math.sin(this.sniffFast) * 0.04 * (f < FEED.dip * 2 ? dip : 0));
      }
      wiggle = smooth01((f - FEED.chew) / 0.25) * (1 - smooth01((f - FEED.end + 0.35) / 0.35));
      if (wiggle > 0) {
        const wp = f * TAU * 2.6;
        for (const s of this.spine) o(s, 0, Math.sin(wp) * 0.1 * wiggle * this.env("tail", 0.8));
        for (const [k, t] of this.tail.entries()) o(t, 0, Math.sin(wp * 1.3 - k * 0.7) * 0.45 * wiggle * this.env("tail", 1));
        if (serpent) for (const [k, s] of this.segs.entries()) o(s, 0, Math.sin(wp - k * 0.8) * 0.2 * wiggle);
        roll += Math.sin(wp) * 0.06 * wiggle;
        if (f - dt < FEED.chew + 0.05 && f >= FEED.chew + 0.05) this.squashV -= 2.2 * (0.4 + this.ph.elasticity);
      }
      if (f > FEED.end) this.feedT = -1;
    }

    // ---- KO: a slow collapse (legs fold, head to the ground, slump on one side)
    let lids = clamp(0.55 * sleepy + asleep, 0, 1);
    if (i.koT > 0) {
      const k = smooth01(i.koT / 1.3);
      for (const lg of this.legs) p(lg.knee, 1.3 * k), p(lg.hip, 0.3 * k);
      necks(P, 0.6 * k);
      p("head", 0.5 * k);
      for (const t of this.tail) p(t, 0.3 * k);
      if (serpent) for (const s of this.segs) p(s, 0, 0.12 * k);
      // Slump onto one side; grounding in finish() (all joints when KO) keeps the body ON the floor.
      roll += 0.35 * k;
      lids = Math.max(lids, k);
    }

    // ---- smooth the posture (exact critically-damped spring per joint and axis)
    const omega = (i.koT > 0 ? 3 : OMEGA[i.phase]) * tempo * (1 - 0.5 * asleep) * stiff;
    const pose: Pose = {};
    for (const j of this.sk.joints) {
      const tgt = P[j.id] ?? [0, 0, 0];
      let s = this.springs.get(j.id);
      if (!s) this.springs.set(j.id, (s = new Float64Array([tgt[0], tgt[1], tgt[2], 0, 0, 0])));
      if (!this.primed) s.set([tgt[0], tgt[1], tgt[2], 0, 0, 0]);
      for (let a = 0; a < 3; a++) {
        const r = springStep(s[a], s[a + 3], tgt[a], omega, dt);
        s[a] = r[0];
        s[a + 3] = r[1];
      }
      const osc = O[j.id];
      if (s[0] !== 0 || s[1] !== 0 || s[2] !== 0 || osc) pose[j.id] = [s[0] + (osc?.[0] ?? 0), s[1] + (osc?.[1] ?? 0), s[2] + (osc?.[2] ?? 0)];
    }
    this.primed = true;

    // ---- mouth: the jaw breathes (subtle), opens on wind-ups / strikes / roars, chews (smoothed)
    const jawBreath = (0.02 + 0.03 * (0.5 + 0.5 * br) * (0.4 + arousal + 0.6 * (1 - i.energy01))) * eBreath * (1 - 0.6 * asleep) + 0.04 * hunger * (1 - asleep);
    const jawT = this.smooth("jaw", clamp(jawOpen, 0, 0.65), (i.phase === "active" ? 20 : 9) * stiff, dt);
    const jaw = clamp(jawT + jawBreath + jawOsc, 0, 0.65);
    if (this.roles.has("jaw")) pose.jaw = [jaw, 0, 0];
    if (this.roles.has("jaw_2")) pose["jaw_2"] = [jaw, 0, 0];

    // ---- head-aware look: the gaze (saccades + head follow) over chest / neck / head
    // A target right behind fades the look back to forward (no head sweep across the +-pi wrap).
    const tgtYaw = wrapAngle(i.lookYaw);
    const behind = 1 - smooth01((Math.abs(tgtYaw) - 1.8) / 0.8);
    const lw = (i.lookWeight ?? 1) * behind * (1 - asleep) * (i.koT > 0 ? 0 : 1) * (this.feedT >= 0 && this.feedKind === "food" ? 0.3 : 1);
    this.gaze.update(clamp(tgtYaw, -2.2, 2.2), clamp(i.lookPitch, -0.9, 0.9), lw, dt, tempo, clamp(1 - arousal, 0, 1));
    const look = distributeLook(this.gaze.yaw, this.gaze.pitch, this.lookLim, this.lookW);
    let headYaw = 0, headPitch = 0;
    look.forEach(([lp, ly], k) => {
      const id = this.lookIds[k];
      const a = (pose[id] ??= [0, 0, 0]);
      a[0] += lp;
      a[1] += ly;
      headYaw += ly;
      headPitch += lp;
    });
    const gaze: [number, number] = [clamp(this.gaze.eyeYaw - headYaw, -0.3, 0.3), clamp(this.gaze.eyePitch - headPitch, -0.3, 0.3)];

    // ---- pass 7: jitter (idle micro-motion) and sway (slow weight shift), strongest when idle
    if (mo.jitter > 0 || mo.sway > 0) {
      const idleK = this.smooth("p7idle", (i.phase === "idle" ? 1 - 0.7 * moving : 0.3) * (1 - asleep) * (i.koT > 0 ? 0 : 1), 3, dt);
      if (mo.jitter > 0) this.jitterStep(pose, dt, idleK * (1 + 0.5 * clamp(arousal, 0, 1)), tempo);
      if (mo.sway > 0) roll += this.swayStep(pose, dt, idleK, tempo);
    }

    // ---- hit flinch (spring toward a decaying impulse: a soft, quick recoil), stagger wobble
    this.hitT = Math.max(0, this.hitT - dt * 2.4);
    [this.hitK, this.hitV] = springStep(this.hitK, this.hitV, this.hitT, 22 * stiff, dt);
    if (this.hitK > 1e-3) {
      const rk = this.hitK * this.env("recoil", clamp(this.hitK / 1.4, 0, 1));
      if (this.hitDirected) {
        // Away from the attacker: pitch back (front) / forward (behind), bend, turn and tip away (side).
        const pk = this.hitPitchK, lat = this.hitLat;
        for (const s of this.spine) {
          const a = (pose[s] ??= [0, 0, 0]);
          a[0] -= 0.26 * rk * pk;
          a[2] -= 0.16 * rk * lat;
        }
        const a = (pose.head ??= [0, 0, 0]);
        a[0] -= 0.36 * rk * pk;
        a[1] += 0.18 * rk * lat;
        roll -= 0.08 * rk * lat;
      } else {
        for (const s of this.spine) {
          const a = (pose[s] ??= [0, 0, 0]);
          a[0] -= 0.26 * rk;
          a[2] += 0.16 * rk * this.hitSide;
        }
        const a = (pose.head ??= [0, 0, 0]);
        a[0] -= 0.36 * rk;
        a[1] += 0.18 * rk * this.hitSide;
      }
    }
    const stag = this.smooth("stagger", i.stagger > 0 ? 1 : 0, 6, dt);
    this.wobPh += dt * 9;
    if (stag > 1e-3) for (const s of this.spine) (pose[s] ??= [0, 0, 0])[2] += Math.sin(this.wobPh) * 0.1 * stag;

    // ---- pass 7: follow-through (tails, neck + head, ears lag the body; overlapping action)
    if (mo.followThrough > 0) this.followStep(pose, dt, i.turnRate !== undefined && Number.isFinite(i.turnRate) ? clamp(i.turnRate, -6, 6) : 0);

    return this.finish(pose, i, charge, roll, lift, gaze, lids, jaw, chewing);
  }

  /**
   * Follow-through [P7]: per chain and axis (pitch, yaw), the WORLD angle of joint k (ancestors + the
   * chain up to k) is tracked by an underdamped spring (zeta 1 -> 0.4 with the gene) whose omega falls
   * toward the tip, so the tip lags most and overshoots most; local angles are rebuilt from the lagged
   * world angles and blended in by the gene (each joint's change capped at 0.6 rad, then constrainPose).
   * Ears flop on z against the head's pitch / yaw motion. A body turn shifts the lagged tail angles.
   */
  private followStep(pose: Pose, dt: number, turnRate: number): void {
    const ft = this.motion.followThrough, st = this.motion.stiffness;
    const zeta = 1 - 0.6 * ft;
    const prime = !this.ftPrimed;
    this.ftPrimed = true;
    for (const c of this.ftChains) {
      const n = c.ids.length;
      if (c.ear) {
        let W = 0;
        for (const id of c.anc) {
          const a = pose[id];
          if (a) W += a[0] + 0.5 * c.ear * a[1];
        }
        if (prime) (c.F[0] = W), (c.V[0] = 0), (c.T[0] = W);
        const r = springStepRamp(c.F[0], c.V[0], c.T[0], W, (11 * st) / (1 + 0.8 * ft), zeta, dt);
        c.T[0] = W;
        c.F[0] = r[0];
        c.V[0] = r[1];
        (pose[c.ids[0]] ??= [0, 0, 0])[2] += c.ear * ft * 1.4 * clamp(r[0] - W, -0.4, 0.4);
        continue;
      }
      for (let ax = 0; ax < 2; ax++) {
        let base = 0;
        for (const id of c.anc) base += pose[id]?.[ax] ?? 0;
        if (c.tail && ax === 1 && !prime && turnRate !== 0) for (let k = 0; k < n; k++) (c.F[k * 2 + 1] -= turnRate * dt), (c.T[k * 2 + 1] -= turnRate * dt);
        let cum = base, prevF = base;
        for (let k = 0; k < n; k++) {
          const a = (pose[c.ids[k]] ??= [0, 0, 0]);
          const drv = a[ax];
          cum += drv;
          const q = k * 2 + ax;
          if (prime) (c.F[q] = cum), (c.V[q] = 0), (c.T[q] = cum);
          const r = springStepRamp(c.F[q], c.V[q], c.T[q], cum, (14 * st) / (1 + (1.8 * ft * (k + 1)) / n), zeta, dt);
          c.T[q] = cum;
          c.F[q] = r[0];
          c.V[q] = r[1];
          a[ax] = drv + ft * clamp(r[0] - prevF - drv, -0.6, 0.6);
          prevF = r[0];
        }
      }
    }
  }

  /**
   * Jitter [P7]: micro-saccades of the head (a new tiny offset every 0.1-0.6 s, reached by a fast
   * spring), ear / tail-tip twitches (a quick flick, x e^(1-x) shaped) and a fine spine tremor. Events fire
   * at their exact time inside the frame (the frame is split there), so 30 and 120 fps agree.
   */
  private jitterStep(pose: Pose, dt: number, k: number, tempo: number): void {
    const J = this.motion.jitter, wS = 38 * this.motion.stiffness, tp = Math.max(0.4, tempo);
    let rem = dt;
    while (rem > 1e-9) {
      const h = Math.min(rem, Math.max(0, this.jitT), Math.max(0, this.twT));
      if (h > 0) {
        [this.jitY, this.jitVY] = springStep(this.jitY, this.jitVY, this.jitTY, wS, h);
        [this.jitP, this.jitVP] = springStep(this.jitP, this.jitVP, this.jitTP, wS, h);
        this.twAge += h;
        this.jitT -= h;
        this.twT -= h;
        rem -= h;
      }
      if (this.jitT <= 1e-12) {
        this.jitTY = (this.rnd() - 0.5) * 0.14 * J;
        this.jitTP = (this.rnd() - 0.5) * 0.08 * J;
        this.jitT = (0.15 + 0.85 * this.rnd()) / ((0.6 + J) * tp);
      }
      if (this.twT <= 1e-12) {
        this.twAge = 0;
        this.twJ = Math.min(this.twitchers.length - 1, Math.floor(this.rnd() * this.twitchers.length));
        this.twS = this.rnd() < 0.5 ? -1 : 1;
        this.twT = (1 + 3.5 * this.rnd()) / ((0.35 + J) * tp);
      }
    }
    const eH = this.env("headBob", clamp(0.3 + 0.7 * J, 0, 1));
    if (this.roles.has("head")) {
      const a = (pose.head ??= [0, 0, 0]);
      a[0] += this.jitP * k * eH;
      a[1] += this.jitY * k * eH;
    }
    const tw = this.twitchers[this.twJ];
    if (tw && this.twAge < 1.2) {
      const x = this.twAge / 0.07;
      (pose[tw.id] ??= [0, 0, 0])[tw.axis] += tw.amp * J * x * Math.exp(1 - x) * this.twS * k * this.env("tail", J);
    }
    this.tremPh += dt * TAU * 9;
    const tr = 0.005 * J * k * (Math.sin(this.tremPh) + 0.6 * Math.sin(this.tremPh * 1.73 + 1));
    for (const s of this.spine) (pose[s] ??= [0, 0, 0])[0] += tr;
  }

  /**
   * Sway [P7]: a slow (~6-10 s) idle weight shift: the body rolls and the spine leans to one side, the
   * hips shift under it, the head stays level, the neck drifts in a slow figure. Returns the body roll.
   */
  private swayStep(pose: Pose, dt: number, k: number, tempo: number): number {
    const S = this.motion.sway;
    this.swayPh += dt * TAU * (0.1 + 0.06 * S) * Math.max(0.4, tempo);
    const s = Math.sin(this.swayPh) * S * k * this.env("gait", 0.3);
    const nSp = Math.max(1, this.spine.length);
    for (const id of this.spine) (pose[id] ??= [0, 0, 0])[2] += (0.08 * s) / nSp;
    if (this.roles.has("head")) (pose.head ??= [0, 0, 0])[2] -= 0.05 * s;
    if (this.sk.kind !== "serpent") for (const lg of this.legs) (pose[lg.hip] ??= [0, 0, 0])[2] += 0.06 * s;
    const nN = Math.max(1, this.necks.length);
    const drift = (0.1 * S * k * Math.sin(this.swayPh * 0.5 + 1.3)) / nN;
    for (const id of this.necks) (pose[id] ??= [0, 0, 0])[1] += drift;
    return 0.05 * s;
  }

  /**
   * Serpent rear-up: the root pitches the front UP (and its tail-ward end down), the first ~40 % of the
   * segments bend back to level so the rear stays on the ground, the neck lifts the head. Bounded by the
   * root / segment limits and the body chain budget (constrainPose). `w` = wind-up strength.
   */
  private rearUp(P: Pose, w: number, pr: number): void {
    const A = clamp(0.33 * w * this.env("windup", clamp(0.4 + 0.4 * pr, 0, 1)), 0, 0.33);
    const a = (P.root ??= [0, 0, 0]);
    a[0] -= A;
    const nBack = Math.max(1, Math.round(this.segs.length * 0.4));
    for (let k = 0; k < nBack && k < this.segs.length; k++) (P[this.segs[k]] ??= [0, 0, 0])[0] += A / nBack;
    const n = Math.max(1, this.necks.length);
    for (const id of this.necks) (P[id] ??= [0, 0, 0])[0] -= (1.4 * A) / n;
    (P.head ??= [0, 0, 0])[0] += 0.6 * A;
  }

  private finish(pose: Pose, i: AnimInput, charge: number, roll: number, lift: number, gaze: [number, number], lids: number, jaw: number, chewing: number): AnimOutput {
    const c = constrainPose(this.sk, pose);
    this.lastPose = c.pose;
    // Squash & stretch spring (elastic bodies wobble longer), sub-stepped so it is frame-rate independent.
    const st = this.motion.stiffness;
    const k = 60 * st * st, damp = (6 - 4 * this.ph.elasticity) * st;
    let left = Math.max(0, Math.min(i.dt, 0.1));
    while (left > 1e-6) {
      const h = Math.min(left, 1 / 120);
      this.squashV += (-k * this.squash - damp * this.squashV) * h;
      this.squash += this.squashV * h;
      left -= h;
    }
    // Squash is bounded by the squash min/max genes (an elastic body deforms more) [P4-V2].
    const sqMax = this.helix ? boundTrait(this.helix.anim.squash, this.ph.elasticity) : 0.35;
    const sq = clamp(this.squash, -sqMax, sqMax);
    // Grounding from forward kinematics: when knees bend the BODY lowers so the feet stay planted
    // (a crouch reads as a crouch, never as legs lifting off the floor). Standing uses the contact
    // joints; a knocked-out body uses every joint so nothing sinks below the ground.
    const fk = forwardKinematics(this.sk, c.pose);
    let ground = 0;
    if (!i.flying && !i.burrowed) {
      let low = Infinity;
      const idx = i.koT > 0 ? this.sk.joints.map((_, n) => n) : this.contacts;
      for (const n of idx) {
        const j = this.sk.joints[n];
        low = Math.min(low, fk.end[n].y - j.r1, fk.pos[n].y - j.r0);
      }
      if (Number.isFinite(low)) ground = -low;
    }
    // Static balance (centre of mass vs support polygon) from the same FK, first frame then every 8.
    if (this.frame++ % 8 === 0) this.stability = balanceOf(this.sk, fk, -ground).stability;
    const n = i.normal;
    const pitch = Math.atan2(n.z, n.y) * 0.75;
    const tilt = -Math.atan2(n.x, n.y) * 0.75;
    const out: AnimOutput = {
      pose: c.pose,
      strain: c.strain,
      stability: this.stability,
      squash: [1 - sq * 0.5, 1 + sq, 1 - sq * 0.5],
      bodyPitch: pitch,
      bodyRoll: tilt + roll,
      lift: lift + ground,
      charge,
      gaze,
      lids,
      jaw,
      chewing,
    };
    this.lastOut = out;
    return out;
  }
}
