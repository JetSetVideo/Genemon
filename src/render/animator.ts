/**
 * Animator: turns a fighter's state into a skeleton Pose every frame, then passes it through
 * constrainPose() (dynamic coupled limits + chain budgets) before it reaches the mesh.
 * Layers (summed): breathing/idle (mood), emotion posture (fear crouch, anger lean, joy wag),
 * locomotion gait per body kind (trot, tripod, biped, serpent wave, blob paddle, wing flap),
 * attack phases (CHARGE wind-up -> ACTIVE strike -> REST recovery) shaped by the move's shape,
 * hit flinch (crits bigger), stagger wobble, KO collapse. Amplitudes are scaled by energy, anger
 * and sadness so the same move reads differently on a fresh angry creature and a tired sad one.
 * Body tilt follows the ground normal; squash & stretch follows impacts and elasticity.
 */
import { balanceOf, constrainPose, forwardKinematics, type Pose, type Skeleton, type Vec3 } from "../body/skeleton.ts";
import type { Move } from "../combat/moves.ts";
import type { Phase } from "../combat/battle.ts";
import type { Emotions, Phenotype } from "../genome/phenotype.ts";
import { clamp } from "../core/math.ts";
import type { AnimChannel, MorphHelix } from "../genome/morphTypes.ts";
import { boundTrait } from "../genome/helix.ts";

/**
 * Reference amplitude of each channel in the pre-helix animator: a channel's envelope multiplies the
 * motion by boundTrait(min gene, max gene, drive) / REF, so a creature without a helix animates exactly
 * as before and a helix bounds every motion between its two genes [P4-V2].
 */
const REF: Record<AnimChannel, number> = { breath: 0.03, gait: 0.45, tail: 0.3, wingFlap: 0.85, headBob: 0.15, windup: 0.6, strike: 0.7, recoil: 0.3, squash: 0.35 };

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
}

/** Fast rise to the peak then slower fall (continuous at the peak). */
export function impulse(p: number, peak: number): number {
  p = clamp(p, 0, 1);
  return p < peak ? Math.sin((Math.PI / 2) * (p / peak)) : Math.cos((Math.PI / 2) * ((p - peak) / (1 - peak)));
}

export class Animator {
  private gait = 0;
  private flap = 0;
  private hitK = 0;
  private hitSide = 1;
  private squashV = 0;
  private squash = 0;
  private frame = 0;
  private stability = 1;
  private lastPose: Pose = {};
  private roles = new Map<string, string>();
  private legs: { hip: string; knee: string; ankle: string; offset: number; front: boolean }[] = [];
  private spine: string[] = [];
  private tail: string[] = [];
  private segs: string[] = [];
  private pods: string[] = [];
  /** Indices of ground-contact joints (feet, pods, serpent belly) for grounding. */
  private contacts: number[] = [];

  constructor(readonly sk: Skeleton, readonly ph: Phenotype, readonly helix?: MorphHelix) {
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
    sk.joints.forEach((j, idx) => j.contact && this.contacts.push(idx));
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

  hit(strength: number, crit: boolean): void {
    this.hitK = clamp(this.hitK + strength * (crit ? 2 : 1), 0, 1.6);
    this.hitSide = -this.hitSide;
    this.squashV -= strength * (crit ? 6 : 3) * (0.4 + this.ph.elasticity);
  }

  land(speed: number): void {
    this.squashV -= Math.min(6, speed) * (0.3 + this.ph.elasticity);
  }

  update(i: AnimInput): AnimOutput {
    const pose: Pose = {};
    const add = (id: string | undefined, x = 0, y = 0, z = 0) => {
      if (!id || !this.roles.has(id)) return;
      const a = (pose[id] ??= [0, 0, 0]);
      a[0] += x;
      a[1] += y;
      a[2] += z;
    };
    const e = i.emotions;
    const arousal = clamp(e.anger + e.fear * 0.7 + e.surprise * 0.5, 0, 1.5);
    const amp = (0.65 + 0.35 * i.energy01) * (1 + 0.35 * e.anger) * (1 - 0.3 * e.sadness);
    const H = this.sk.height;
    if (i.frozen) return this.finish(this.lastPose, i, 0);

    // Idle breathing and emotion posture.
    const br = Math.sin(i.t * (1.3 + 1.6 * arousal) * Math.PI);
    const eBreath = this.env("breath", clamp(0.3 + 0.5 * arousal, 0, 1));
    for (const s of this.spine) add(s, br * 0.03 * (1 + arousal) * eBreath);
    add("neck0", -0.12 * e.joy + 0.3 * e.sadness + 0.15 * e.fear + 0.08 * e.anger);
    add("head", -0.1 * e.joy + 0.25 * e.sadness + 0.15 * e.fear, 0, Math.sin(i.t * 0.7) * 0.05 * e.surprise);
    for (const [k, t] of this.tail.entries()) {
      const wag = Math.sin(i.t * (2 + 8 * e.joy) - k * 0.6) * (0.08 + 0.4 * e.joy) * this.env("tail", clamp(0.3 + 0.6 * e.joy, 0, 1));
      add(t, (0.35 * e.fear - 0.25 * e.anger - 0.1) / (k + 1), wag);
    }
    for (const lg of this.legs) add(lg.knee, 0.18 * e.fear + 0.1 * (1 - i.hp01));
    // Looking at the target.
    const ly = clamp(i.lookYaw, -1.2, 1.2), lp = clamp(i.lookPitch, -0.6, 0.6);
    add("neck0", lp * 0.35, ly * 0.45);
    add("head", lp * 0.5, ly * 0.55);

    // Locomotion.
    const legLen = H * 0.45;
    const sp = clamp(i.speed / Math.max(0.5, i.maxSpeed), 0, 1.6);
    if (i.flying) {
      this.flap += i.dt * (2.2 + 2.5 * sp) * Math.PI * 2 / Math.sqrt(Math.max(0.5, H));
      // Wing beats bounded by the wingFlap min/max genes: effort (speed, arousal, energy) drives them.
      const flap = this.flapAmp(clamp(0.35 + 0.4 * sp + 0.2 * arousal, 0, 1) * (0.7 + 0.3 * i.energy01));
      for (const j of this.sk.joints) {
        if (j.role === "wingRoot") add(j.id, 0, 0, j.side * Math.sin(this.flap) * flap);
        if (j.role === "wingMid") add(j.id, 0, 0, j.side * Math.sin(this.flap - 0.6) * flap * 0.62);
        if (j.role === "wingTip") add(j.id, 0, 0, j.side * Math.sin(this.flap - 1.1) * flap * 0.4);
      }
      for (const lg of this.legs) add(lg.hip, 0.7), add(lg.knee, 0.9);
      for (const t of this.tail) add(t, -0.1);
    } else if (i.burrowed) {
      for (const s of this.spine) add(s, 0.2);
    } else {
      this.gait += i.dt * (i.speed / Math.max(0.2, legLen * 1.6)) * Math.PI * 2;
      const A = clamp(0.2 + 0.45 * sp, 0, 0.75) * amp * (i.liquid ? 0.7 : 1) * this.env("gait", clamp(sp, 0, 1));
      if (sp > 0.05) {
        for (const lg of this.legs) {
          const ph = this.gait + lg.offset;
          add(lg.hip, -A * Math.sin(ph));
          add(lg.knee, Math.max(0, Math.sin(ph + Math.PI / 2)) * A * 1.4);
          add(lg.ankle, A * 0.5 * Math.sin(ph));
        }
        for (const j of this.sk.joints) {
          if (j.role === "shoulder" && j.chain.startsWith("arm")) add(j.id, 0.6 * A * Math.sin(this.gait + (j.side > 0 ? Math.PI : 0)));
          if (j.role === "elbow") add(j.id, -0.4 * A);
        }
        for (const [k, s] of this.segs.entries()) add(s, 0, Math.sin(this.gait * 0.8 - k * 0.7) * 0.32 * amp);
        for (const [k, p] of this.pods.entries()) add(p, Math.sin(this.gait + (k * Math.PI * 2) / Math.max(1, this.pods.length)) * 0.4 * A);
        for (const s of this.spine) add(s, 0, Math.sin(this.gait) * 0.05 * A);
      } else if (this.sk.kind === "serpent") {
        for (const [k, s] of this.segs.entries()) add(s, 0, Math.sin(i.t * 1.2 - k * 0.6) * 0.12);
      }
      // Folded wings: sweep back (+y on the left = -y on the right: side * y) and lift the tips slightly.
      for (const j of this.sk.joints) {
        if (j.role === "wingRoot") add(j.id, 0, j.side * 0.6, j.side * 0.3);
        if (j.role === "wingMid") add(j.id, 0, j.side * 1.1, -j.side * 0.15);
        if (j.role === "wingTip") add(j.id, 0, j.side * 0.5, 0);
      }
    }
    let lift = this.sk.kind === "biped" || this.sk.kind === "avian" ? Math.abs(Math.sin(this.gait)) * 0.04 * H * sp : 0;
    if (this.sk.kind === "blob") lift += Math.max(0, Math.sin(this.gait * 2)) * 0.06 * H * sp;

    // Attack phases.
    let charge = 0;
    if (i.move && i.phase !== "idle") {
      const m = i.move, p = i.progress;
      const melee = m.shape === "melee" || m.shape === "dig" || m.shape === "dash";
      const ranged = m.shape === "projectile" || m.shape === "beam" || m.shape === "zone" || m.shape === "cone";
      // Big moves read big: the wind-up and the strike grow with the move's power (ultimates ~1.5x) [P4-M5].
      const weight = 0.8 + 0.45 * clamp(m.power / 90, 0, 1.6);
      const selfMove = !melee && !ranged && m.shape !== "burst";
      if (i.phase === "charge") {
        charge = p;
        const w = Math.sin((Math.PI / 2) * p) * amp * weight * this.env("windup", clamp(m.power / 140, 0, 1));
        for (const s of this.spine) add(s, -0.22 * w / Math.max(1, this.spine.length / 2));
        for (const lg of this.legs) add(lg.knee, 0.35 * w), add(lg.hip, (lg.front ? 0.15 : -0.1) * w);
        if (melee) add("neck0", 0.2 * w), add("head", -0.25 * w), add("jaw", 0.25 * w);
        if (ranged) add("neck0", -0.35 * w), add("jaw", 0.45 * w);
        if (selfMove) add("neck0", -0.3 * w), add("head", -0.3 * w);
        for (const j of this.sk.joints) {
          if (j.role === "shoulder" && j.chain.startsWith("arm")) add(j.id, -1.3 * w);
          if (j.role === "elbow") add(j.id, -1.0 * w);
          if (j.role === "wingRoot") add(j.id, 0, 0, j.side * 0.6 * w);
        }
        for (const t of this.tail) add(t, -0.25 * w);
        for (const [k, s] of this.segs.entries()) add(s, 0, Math.sin(k * 1.1) * 0.25 * w);
      } else if (i.phase === "active") {
        const s = impulse(p, m.shape === "cone" ? 0.12 : 0.25) * amp * weight * this.env("strike", clamp(m.power / 140, 0, 1));
        charge = 1 - p;
        if (melee) {
          for (const sp2 of this.spine) add(sp2, 0.3 * s / Math.max(1, this.spine.length / 2));
          add("neck0", 0.35 * s);
          add("head", 0.35 * s);
          add("jaw", 0.65 * (1 - p));
          for (const lg of this.legs) if (lg.front) add(lg.hip, -0.7 * s), add(lg.knee, -0.1 * s);
        } else if (ranged) {
          add("neck0", 0.3 * s);
          // A breath holds the jaw wide open for the whole active phase.
          add("jaw", m.shape === "cone" ? 0.65 * amp : 0.65 * s);
          for (const sp2 of this.spine) add(sp2, -0.12 * s);
        } else if (m.shape === "burst") {
          for (const lg of this.legs) add(lg.hip, (lg.front ? -0.4 : 0.4) * s);
          add("head", -0.4 * s);
          add("jaw", 0.6 * s);
        } else {
          add("neck0", -0.45 * s);
          add("head", -0.5 * s);
        }
        for (const j of this.sk.joints) {
          if (j.role === "shoulder" && j.chain.startsWith("arm")) add(j.id, (-1.3 + 1.9 * s) * (melee ? 1 : 0.5));
          if (j.role === "wingRoot") add(j.id, 0, 0, j.side * -0.9 * s);
        }
      } else if (i.phase === "rest") {
        const r = (1 - p) * amp;
        add("neck0", 0.18 * r);
        add("head", 0.15 * r);
        for (const s of this.spine) add(s, br * 0.05 * r);
        for (const t of this.tail) add(t, 0.2 * r);
      }
    }

    // Hit reaction, stagger, KO.
    this.hitK = Math.max(0, this.hitK - i.dt * 3);
    if (this.hitK > 0) {
      const rk = this.hitK * this.env("recoil", clamp(this.hitK / 1.6, 0, 1));
      for (const s of this.spine) add(s, -0.28 * rk, 0, 0.18 * rk * this.hitSide);
      add("head", -0.4 * rk, 0.2 * rk * this.hitSide);
    }
    if (i.stagger > 0) for (const s of this.spine) add(s, 0, 0, Math.sin(i.t * 16) * 0.15);
    let roll = 0;
    if (i.koT > 0) {
      const k = clamp(i.koT / 0.8, 0, 1);
      for (const lg of this.legs) add(lg.knee, 1.3 * k), add(lg.hip, 0.3 * k);
      add("neck0", 0.6 * k);
      add("head", 0.5 * k);
      for (const t of this.tail) add(t, 0.3 * k);
      // Slump onto one side; grounding in finish() (all joints when KO) keeps the body ON the floor.
      roll = 0.35 * k;
    }
    return this.finish(pose, i, charge, roll, lift);
  }

  private finish(pose: Pose, i: AnimInput, charge: number, roll = 0, lift = 0): AnimOutput {
    const c = constrainPose(this.sk, pose);
    this.lastPose = c.pose;
    // Squash & stretch spring (elastic bodies wobble longer).
    const k = 60, damp = 6 - 4 * this.ph.elasticity;
    this.squashV += (-k * this.squash - damp * this.squashV) * i.dt;
    this.squash += this.squashV * i.dt;
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
    return {
      pose: c.pose,
      strain: c.strain,
      stability: this.stability,
      squash: [1 - sq * 0.5, 1 + sq, 1 - sq * 0.5],
      bodyPitch: pitch,
      bodyRoll: tilt + roll,
      lift: lift + ground,
      charge,
    };
  }
}
