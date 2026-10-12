/**
 * Skeleton: the base of every Genemon model. A body plan (quadruped, biped, hexapod, serpent,
 * avian, blob) is generated from the phenotype as a joint tree. Each joint has angle LIMITS that
 * are not fixed: they are re-computed every frame from the CURRENT angles of the connected joints
 * (couplings: a flexed hip narrows the knee, a twisted neck narrows the head's yaw...) and every
 * chain (spine, neck, tail) has a total bend BUDGET. constrainPose() is the single gate every
 * animation passes through. FK + mass give the centre of mass; contact points give the support
 * polygon; their relation is the balance margin used by animation and physics.
 *
 * Frame convention: creature space, +Z forward, +Y up, side +1 = +X. Positive X rotation pitches a
 * forward-pointing bone DOWN (jaw opens, head nods); for a downward bone it swings the end BACK.
 */
import { Euler, Quaternion, Vector3 } from "../lib/three.ts";
import type { Phenotype } from "../genome/phenotype.ts";

export type JointRole =
  | "root"
  | "spine"
  | "chest"
  | "neck"
  | "head"
  | "jaw"
  | "tail"
  | "hip"
  | "knee"
  | "ankle"
  | "shoulder"
  | "elbow"
  | "wrist"
  | "wingRoot"
  | "wingMid"
  | "wingTip"
  | "pod"
  | "horn"
  | "ear"
  | "segment";

type Range = [number, number];
export type Vec3 = [number, number, number];
export type Axis3 = 0 | 1 | 2;

export interface Coupling {
  src: string;
  srcAxis: Axis3;
  axis: Axis3;
  loLin: number;
  loAbs: number;
  hiLin: number;
  hiAbs: number;
}

export interface JointDef {
  id: string;
  role: JointRole;
  parent: number;
  side: -1 | 0 | 1;
  offset: Vec3;
  dir: Vec3;
  length: number;
  r0: number;
  r1: number;
  limits: [Range, Range, Range];
  couplings: Coupling[];
  chain: string;
  contact: boolean;
  mass: number;
}

export interface Skeleton {
  kind: Phenotype["kind"];
  joints: JointDef[];
  index: Map<string, number>;
  chains: Record<string, { joints: number[]; budget: Vec3 }>;
  height: number;
  rootHeight: number;
  totalMass: number;
  mobility: number;
}

export type Pose = Record<string, Vec3>;

// Base limits per role (radians) before mobility scaling: [x, y, z].
const ROLE_LIMITS: Record<JointRole, [Range, Range, Range]> = {
  root: [[-0.35, 0.35], [0, 0], [-0.3, 0.3]],
  spine: [[-0.3, 0.3], [-0.35, 0.35], [-0.15, 0.15]],
  chest: [[-0.3, 0.3], [-0.35, 0.35], [-0.15, 0.15]],
  segment: [[-0.25, 0.25], [-0.55, 0.55], [-0.1, 0.1]],
  neck: [[-0.7, 0.6], [-0.8, 0.8], [-0.25, 0.25]],
  head: [[-0.5, 0.5], [-0.6, 0.6], [-0.3, 0.3]],
  jaw: [[0, 0.65], [0, 0], [0, 0]],
  tail: [[-0.6, 0.6], [-0.7, 0.7], [0, 0]],
  hip: [[-0.9, 0.9], [-0.2, 0.2], [-0.3, 0.3]],
  shoulder: [[-0.9, 0.9], [-0.25, 0.25], [-0.35, 0.35]],
  knee: [[-0.05, 1.5], [0, 0], [0, 0]],
  elbow: [[-2.0, 0.05], [0, 0], [0, 0]],
  ankle: [[-0.7, 0.7], [0, 0], [-0.15, 0.15]],
  wrist: [[-0.6, 0.6], [-0.2, 0.2], [-0.3, 0.3]],
  wingRoot: [[-0.4, 0.4], [-0.5, 0.75], [-1.1, 1.1]],
  wingMid: [[-0.2, 0.2], [-0.2, 1.3], [-0.9, 0.9]],
  wingTip: [[-0.1, 0.1], [-0.3, 0.7], [-0.6, 0.6]],
  pod: [[-0.6, 0.6], [-0.3, 0.3], [-0.6, 0.6]],
  horn: [[0, 0], [0, 0], [0, 0]],
  ear: [[0, 0], [0, 0], [-0.3, 0.3]],
};
const FIXED_ROLES: JointRole[] = ["jaw", "horn"];

function norm3(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

class Builder {
  joints: JointDef[] = [];
  index = new Map<string, number>();
  constructor(private mobility: number) {}

  add(
    id: string,
    role: JointRole,
    parent: string | null,
    side: -1 | 0 | 1,
    offset: Vec3,
    dir: Vec3,
    length: number,
    r0: number,
    r1: number,
    chain: string,
    contact = false,
  ): string {
    const base = ROLE_LIMITS[role];
    const m = FIXED_ROLES.includes(role) ? 1 : this.mobility;
    const limits = base.map(([lo, hi]) => [lo * m, hi * m] as Range) as [Range, Range, Range];
    // Ranges are authored for the LEFT side (+X). Mirroring across the median plane keeps rotations
    // about X and negates rotations about Y and Z, so a right-side joint gets [-hi, -lo] on y and z.
    if (side < 0) {
      limits[1] = [-limits[1][1], -limits[1][0]];
      limits[2] = [-limits[2][1], -limits[2][0]];
    }
    this.index.set(id, this.joints.length);
    this.joints.push({
      id,
      role,
      parent: parent === null ? -1 : this.index.get(parent)!,
      side,
      offset,
      dir: norm3(dir),
      length,
      r0,
      r1,
      limits,
      couplings: [],
      chain,
      contact,
      mass: 0,
    });
    return id;
  }

  couple(target: string, c: Omit<Coupling, "loLin" | "loAbs" | "hiLin" | "hiAbs"> & Partial<Coupling>): void {
    const j = this.joints[this.index.get(target)!];
    j.couplings.push({ loLin: 0, loAbs: 0, hiLin: 0, hiAbs: 0, ...c });
  }

  /** Bone end of a joint, in its own frame = dir * length (used as child offset). */
  tip(id: string, along = 1): Vec3 {
    const j = this.joints[this.index.get(id)!];
    return [j.dir[0] * j.length * along, j.dir[1] * j.length * along, j.dir[2] * j.length * along];
  }
}

function legChain(
  b: Builder,
  prefix: string,
  parent: string,
  side: -1 | 1,
  at: Vec3,
  upper: number,
  lower: number,
  foot: number,
  r: number,
  front: boolean,
  dirs: { upper?: Vec3; lower?: Vec3; foot?: Vec3 } = {},
): void {
  const hipRole: JointRole = front ? "shoulder" : "hip";
  const hip = b.add(`${prefix}${hipRole}`, hipRole, parent, side, at, dirs.upper ?? [0, -1, 0], upper, r * 0.42, r * 0.3, `leg-${prefix}`);
  const knee = b.add(`${prefix}knee`, "knee", hip, side, b.tip(hip), dirs.lower ?? [0, -1, 0], lower, r * 0.3, r * 0.22, `leg-${prefix}`);
  const ankle = b.add(`${prefix}ankle`, "ankle", knee, side, b.tip(knee), dirs.foot ?? [0, 0, 1], foot, r * 0.22, r * 0.2, `leg-${prefix}`, true);
  // Dynamic couplings: a forward-swung hip forbids a fully straight knee; a flexed knee narrows the ankle.
  b.couple(knee, { src: hip, srcAxis: 0, axis: 0, loLin: -0.175, loAbs: 0.175 });
  b.couple(ankle, { src: knee, srcAxis: 0, axis: 0, loAbs: 0.2, hiAbs: -0.2 });
}

function headChain(b: Builder, parent: string, at: Vec3, neckDir: Vec3, ph: Phenotype, H: number, neckSegs: number, bodyR: number): void {
  const p = ph.plan;
  const neckLen = H * (0.1 + 0.16 * p.neck);
  let prev = parent;
  let off = at;
  for (let i = 0; i < neckSegs; i++) {
    prev = b.add(`neck${i}`, "neck", prev, 0, off, i === 0 ? neckDir : [0, 0.15, 1], neckLen / neckSegs, bodyR * (0.55 - 0.06 * i), bodyR * (0.47 - 0.06 * i), "neck");
    off = b.tip(prev);
  }
  const headR = H * (0.1 + 0.07 * p.head);
  const headLen = H * (0.18 + 0.12 * p.head);
  const head = b.add("head", "head", prev, 0, off, [0, -0.12, 1], headLen, headR, headR * 0.62, "head");
  b.couple(head, { src: prev, srcAxis: 1, axis: 1, loAbs: 0.3, hiAbs: -0.3 });
  b.couple("neck0", { src: parent, srcAxis: 0, axis: 0, loLin: -0.6, hiLin: -0.6 });
  b.add("jaw", "jaw", head, 0, [0, -headR * 0.38, headLen * 0.12], [0, -0.18, 1], headLen * (0.55 + 0.3 * p.jaw), headR * 0.42, headR * 0.26, "head");
  const hornPairs = Math.max(0, Math.round(3 * p.horns) - 1);
  for (let i = 0; i < hornPairs; i++) {
    for (const s of [-1, 1] as const) {
      b.add(`horn${i}${s > 0 ? "L" : "R"}`, "horn", head, s, [s * headR * (0.45 + 0.15 * i), headR * 0.75, headLen * (0.15 - 0.2 * i)], [s * 0.35, 0.9, -0.35 - 0.2 * i], H * (0.07 + 0.12 * p.horns) * (1 - 0.25 * i), headR * 0.2, headR * 0.02, "head");
    }
  }
  if (p.ears > 0.45) {
    for (const s of [-1, 1] as const) {
      b.add(`ear${s > 0 ? "L" : "R"}`, "ear", head, s, [s * headR * 0.72, headR * 0.45, -headLen * 0.05], [s * 0.65, 0.7, -0.25], H * 0.11 * p.ears, headR * 0.28, headR * 0.06, "head");
    }
  }
}

function tailChain(b: Builder, parent: string, at: Vec3, dir: Vec3, n: number, segLen: number, r: number): void {
  let prev = parent, off = at;
  for (let i = 0; i < n; i++) {
    const k = 1 - i / Math.max(1, n);
    prev = b.add(`tail${i}`, "tail", prev, 0, off, i === 0 ? dir : [0, 0.05, -1], segLen * (1 - 0.08 * i), r * k * 0.95 + r * 0.05, r * (k - 1 / n) * 0.95 + r * 0.04, "tail");
    off = b.tip(prev);
  }
}

function wingChain(b: Builder, parent: string, side: -1 | 1, at: Vec3, span: number, r: number): void {
  const root = b.add(`wing${side > 0 ? "L" : "R"}0`, "wingRoot", parent, side, at, [side, 0.12, -0.15], span * 0.42, r * 0.22, r * 0.14, `wing${side}`);
  const mid = b.add(`wing${side > 0 ? "L" : "R"}1`, "wingMid", root, side, b.tip(root), [side, 0.02, -0.25], span * 0.36, r * 0.14, r * 0.09, `wing${side}`);
  b.add(`wing${side > 0 ? "L" : "R"}2`, "wingTip", mid, side, b.tip(mid), [side, -0.05, -0.4], span * 0.3, r * 0.09, r * 0.02, `wing${side}`);
  b.couple(mid, { src: root, srcAxis: 2, axis: 2, loAbs: 0.3, hiAbs: -0.3 });
}

export function buildSkeleton(ph: Phenotype): Skeleton {
  const H = ph.heightM, p = ph.plan;
  const b = new Builder(ph.mobility);
  const chains: Skeleton["chains"] = {};
  switch (ph.kind) {
    case "quadruped": {
      const legLen = H * (0.32 + 0.22 * p.legLen);
      const bodyLen = H * (0.75 + 0.45 * p.segments);
      const r = H * (0.13 + 0.09 * p.girth) * (1 + 0.15 * Math.max(0, ph.axes.weight));
      const n = 2 + Math.round(2 * p.segments);
      const seg = bodyLen / n;
      let prev = b.add("root", "root", null, 0, [0, 0, 0], [0, 0, 1], seg, r * 0.92, r, "spine");
      for (let i = 1; i < n; i++) prev = b.add(i === n - 1 ? "chest" : `spine${i}`, i === n - 1 ? "chest" : "spine", prev, 0, b.tip(prev), [0, 0, 1], seg, r * (1 + 0.04 * i), r * (1 + 0.05 * i), "spine");
      headChain(b, "chest", [0, r * 0.35, seg * 0.95], [0, 0.75, 0.66], ph, H, 1 + Math.round(1.4 * p.neck), r);
      tailChain(b, "root", [0, r * 0.25, 0], [0, 0.3, -1], Math.round(5 * p.tail), H * (0.1 + 0.1 * p.tail), r * 0.45);
      for (const s of [-1, 1] as const) {
        const tag = s > 0 ? "L" : "R";
        legChain(b, `h${tag}`, "root", s, [s * r * 0.7, -r * 0.3, seg * 0.25], legLen * 0.5, legLen * 0.42, legLen * 0.2, r, false);
        legChain(b, `f${tag}`, "chest", s, [s * r * 0.75, -r * 0.3, seg * 0.7], legLen * 0.5, legLen * 0.42, legLen * 0.2, r, true);
        if (p.wings > 0.62 || ph.abilities.fly) wingChain(b, "chest", s, [s * r * 0.5, r * 0.65, seg * 0.4], H * (0.5 + 0.6 * p.wings), r);
      }
      break;
    }
    case "biped": {
      const legLen = H * (0.36 + 0.15 * p.legLen);
      const torso = H * (0.26 + 0.12 * p.segments);
      const r = H * (0.11 + 0.07 * p.girth) * (1 + 0.15 * Math.max(0, ph.axes.weight));
      const n = 2 + Math.round(p.segments);
      let prev = b.add("root", "root", null, 0, [0, 0, 0], [0, 1, 0.05], torso / n, r * 0.95, r, "spine");
      for (let i = 1; i < n; i++) prev = b.add(i === n - 1 ? "chest" : `spine${i}`, i === n - 1 ? "chest" : "spine", prev, 0, b.tip(prev), [0, 1, 0.04], torso / n, r * (1.02 + 0.05 * i), r * (1.05 + 0.04 * i), "spine");
      headChain(b, "chest", b.tip("chest", 0.95), [0, 1, 0.2], ph, H, 1, r);
      tailChain(b, "root", [0, 0, -r * 0.7], [0, -0.4, -1], p.tail > 0.35 ? Math.round(4 * p.tail) : 0, H * 0.12, r * 0.5);
      for (const s of [-1, 1] as const) {
        const tag = s > 0 ? "L" : "R";
        const sh = b.add(`a${tag}shoulder`, "shoulder", "chest", s, [s * r * 1.08, (torso / n) * 0.8, 0], [s * 0.22, -1, 0.05], H * 0.2, r * 0.32, r * 0.24, `arm-${tag}`);
        const el = b.add(`a${tag}elbow`, "elbow", sh, s, b.tip(sh), [0, -1, 0.15], H * 0.18, r * 0.24, r * 0.18, `arm-${tag}`);
        b.add(`a${tag}wrist`, "wrist", el, s, b.tip(el), [0, -1, 0.1], H * 0.07, r * 0.2, r * 0.16, `arm-${tag}`);
        b.couple(el, { src: sh, srcAxis: 0, axis: 0, loAbs: 0.4 });
        legChain(b, `l${tag}`, "root", s, [s * r * 0.55, -r * 0.1, 0], legLen * 0.5, legLen * 0.46, H * 0.12, r, false);
        if (p.wings > 0.62 || ph.abilities.fly) wingChain(b, "chest", s, [s * r * 0.4, (torso / n) * 0.7, -r * 0.6], H * (0.6 + 0.5 * p.wings), r);
      }
      break;
    }
    case "hexapod": {
      const legLen = H * (0.3 + 0.2 * p.legLen);
      const r = H * (0.12 + 0.06 * p.girth);
      const thorax = H * 0.38;
      b.add("root", "root", null, 0, [0, 0, 0], [0, 0, 1], thorax, r, r * 1.05, "spine");
      let prev = "root";
      const nAbd = 1 + Math.round(2 * p.segments);
      let off: Vec3 = [0, r * 0.1, 0];
      for (let i = 0; i < nAbd; i++) {
        prev = b.add(`abd${i}`, "segment", prev, 0, off, i === 0 ? [0, 0.15, -1] : [0, 0.05, -1], H * (0.18 + 0.1 * p.segments), r * (1.25 - 0.15 * i), r * (1.1 - 0.2 * i), "abdomen");
        off = b.tip(prev);
      }
      headChain(b, "root", [0, r * 0.2, thorax], [0, 0.3, 1], ph, H * 0.8, 1, r);
      for (const s of [-1, 1] as const) {
        for (let k = 0; k < 3; k++) {
          const tag = `${s > 0 ? "L" : "R"}${k}`;
          legChain(b, `x${tag}`, "root", s, [s * r * 0.9, -r * 0.2, thorax * (0.15 + 0.35 * k)], legLen * 0.45, legLen * 0.62, legLen * 0.25, r * 0.8, k === 0, {
            upper: [s * 1, 0.35, (k - 1) * 0.35],
            lower: [s * 0.35, -1, (k - 1) * 0.15],
            foot: [s * 0.2, -0.6, (k - 1) * 0.2 + 0.2],
          });
        }
      }
      break;
    }
    case "serpent": {
      const r = H * (0.07 + 0.05 * p.girth) * (1 + 0.15 * Math.max(0, ph.axes.weight));
      const n = 6 + Math.round(6 * p.segments);
      const segLen = (H * (1.6 + 0.8 * p.tail)) / n;
      b.add("root", "root", null, 0, [0, 0, 0], [0, 0, -1], segLen, r, r, "body", true);
      let prev = "root";
      for (let i = 1; i < n; i++) {
        const k = 1 - i / n;
        prev = b.add(`seg${i}`, "segment", prev, 0, b.tip(prev), [0, 0, -1], segLen, r * (0.4 + 0.6 * k) + 0.01, r * (0.4 + 0.6 * (k - 1 / n)) + 0.005, "body", true);
      }
      headChain(b, "root", [0, r * 0.4, 0], [0, 0.55, 0.85], ph, H * 0.85, 1 + Math.round(p.neck), r * 1.3);
      if (p.wings > 0.7 || ph.abilities.fly) for (const s of [-1, 1] as const) wingChain(b, "root", s, [s * r * 0.8, r * 0.5, -segLen], H * 0.9, r);
      break;
    }
    case "avian": {
      const legLen = H * (0.3 + 0.18 * p.legLen);
      const r = H * (0.12 + 0.06 * p.girth);
      const body = H * 0.42;
      b.add("root", "root", null, 0, [0, 0, 0], [0, 0.25, 1], body * 0.55, r, r * 1.1, "spine");
      b.add("chest", "chest", "root", 0, b.tip("root"), [0, 0.3, 1], body * 0.45, r * 1.1, r * 0.9, "spine");
      headChain(b, "chest", b.tip("chest", 0.9), [0, 0.85, 0.5], ph, H, 2 + Math.round(p.neck), r * 0.85);
      tailChain(b, "root", [0, r * 0.2, -r * 0.5], [0, 0.15, -1], 2, H * 0.18, r * 0.7);
      for (const s of [-1, 1] as const) {
        const tag = s > 0 ? "L" : "R";
        legChain(b, `l${tag}`, "root", s, [s * r * 0.5, -r * 0.5, body * 0.15], legLen * 0.48, legLen * 0.52, H * 0.12, r * 0.6, false, {
          upper: [0, -1, 0.25],
          lower: [0, -1, -0.3],
        });
        wingChain(b, "chest", s, [s * r * 0.75, r * 0.45, body * 0.1], H * (0.85 + 0.7 * p.wings), r);
      }
      break;
    }
    case "blob": {
      const R = H * (0.36 + 0.08 * p.girth);
      b.add("root", "root", null, 0, [0, 0, 0], [0, 1, 0], R * 0.8, R, R * 0.85, "stack");
      let prev = "root";
      const n = Math.round(2 * p.segments);
      for (let i = 0; i < n; i++) prev = b.add(`lobe${i}`, "segment", prev, 0, b.tip(prev), [0, 1, 0.08], R * 0.55 * (1 - 0.2 * i), R * (0.7 - 0.15 * i), R * (0.55 - 0.15 * i), "stack");
      b.add("head", "head", prev, 0, b.tip(prev, 0.7), [0, 0.1, 1], R * 0.5, R * (0.5 - 0.1 * n), R * 0.35, "head");
      const pods = 3 + Math.round(3 * p.legLen);
      for (let i = 0; i < pods; i++) {
        const a = (i / pods) * Math.PI * 2 + 0.3;
        const s: -1 | 0 | 1 = Math.cos(a) > 0.2 ? 1 : Math.cos(a) < -0.2 ? -1 : 0;
        const pod = b.add(`pod${i}`, "pod", "root", s, [Math.cos(a) * R * 0.6, -R * 0.35, Math.sin(a) * R * 0.6], [Math.cos(a), -0.75, Math.sin(a)], R * 0.55, R * 0.3, R * 0.18, `pod${i}`);
        b.add(`pod${i}tip`, "ankle", pod, s, b.tip(pod), [Math.cos(a), -0.9, Math.sin(a)], R * 0.25, R * 0.18, R * 0.12, `pod${i}`, true);
      }
      break;
    }
  }

  // Chain budgets (total bend per axis) scale with mobility.
  const m = ph.mobility;
  const budgets: Record<string, Vec3> = {
    spine: [0.6 * m, 0.7 * m, 0.3 * m],
    neck: [1.0 * m, 1.2 * m, 0.4 * m],
    tail: [1.2 * m, 1.8 * m, 0.1],
    body: [0.8 * m, 3.6 * m, 0.4 * m],
    abdomen: [0.6 * m, 0.8 * m, 0.2 * m],
    stack: [0.5 * m, 0.6 * m, 0.5 * m],
  };
  b.joints.forEach((j, i) => {
    if (!budgets[j.chain]) return;
    (chains[j.chain] ??= { joints: [], budget: budgets[j.chain] }).joints.push(i);
  });

  // Mass distribution proportional to bone volume, normalised to the phenotype mass.
  let vol = 0;
  for (const j of b.joints) {
    const rr = (j.r0 + j.r1) / 2;
    j.mass = Math.PI * rr * rr * Math.max(j.length, rr) + (j.role === "head" || j.role === "root" ? (4 / 3) * Math.PI * j.r0 ** 3 : 0);
    vol += j.mass;
  }
  for (const j of b.joints) j.mass = (j.mass / vol) * ph.massKg;

  const sk: Skeleton = { kind: ph.kind, joints: b.joints, index: b.index, chains, height: H, rootHeight: 0, totalMass: ph.massKg, mobility: m };
  // Seat the body: lift the root so the lowest contact surface touches y = 0 at rest.
  const fk = forwardKinematics(sk, {});
  let minY = Infinity;
  sk.joints.forEach((j, i) => {
    if (!j.contact) return;
    minY = Math.min(minY, fk.end[i].y - j.r1, fk.pos[i].y - j.r0);
  });
  if (!Number.isFinite(minY)) minY = 0;
  sk.rootHeight = -minY;
  sk.joints[0].offset = [0, sk.rootHeight, 0];
  return sk;
}

// ------------------------------------------------------------------ constraints

export interface ConstraintReport {
  pose: Pose;
  /** Total radians removed by limits + budgets ("strain"). */
  strain: number;
  perJoint: Record<string, number>;
}

/** Clamp a pose to dynamic limits (parents first, couplings use already-constrained angles), then budgets. */
export function constrainPose(sk: Skeleton, pose: Pose): ConstraintReport {
  const out: Pose = {};
  const perJoint: Record<string, number> = {};
  let strain = 0;
  for (const j of sk.joints) {
    const want = pose[j.id] ?? [0, 0, 0];
    const got: Vec3 = [0, 0, 0];
    for (let a = 0; a < 3; a++) {
      let [lo, hi] = j.limits[a];
      for (const c of j.couplings) {
        if (c.axis !== a) continue;
        const th = (out[c.src] ?? [0, 0, 0])[c.srcAxis];
        lo += c.loLin * th + c.loAbs * Math.abs(th);
        hi += c.hiLin * th + c.hiAbs * Math.abs(th);
      }
      if (lo > hi) lo = hi = (lo + hi) / 2;
      const v = Number.isFinite(want[a]) ? want[a] : 0;
      got[a] = v < lo ? lo : v > hi ? hi : v;
    }
    out[j.id] = got;
    const d = Math.abs(got[0] - want[0]) + Math.abs(got[1] - want[1]) + Math.abs(got[2] - want[2]);
    if (d > 1e-9) perJoint[j.id] = d;
    strain += Number.isFinite(d) ? d : 0;
  }
  for (const chain of Object.values(sk.chains)) {
    for (let a = 0; a < 3; a++) {
      let sum = 0;
      for (const i of chain.joints) sum += Math.abs(out[sk.joints[i].id][a]);
      if (sum > chain.budget[a] && sum > 0) {
        const k = chain.budget[a] / sum;
        for (const i of chain.joints) {
          const id = sk.joints[i].id;
          const before = out[id][a];
          out[id][a] = before * k;
          strain += Math.abs(before - out[id][a]);
          perJoint[id] = (perJoint[id] ?? 0) + Math.abs(before - out[id][a]);
        }
      }
    }
  }
  return { pose: out, strain, perJoint };
}

// ------------------------------------------------------------------ kinematics & balance

export interface FK {
  pos: Vector3[];
  end: Vector3[];
  quat: Quaternion[];
}

const _e = new Euler();
const _q = new Quaternion();
const _v = new Vector3();

/** World-space joint origins, bone ends and orientations for a pose (root at rootPos/rootQuat). */
export function forwardKinematics(sk: Skeleton, pose: Pose, rootPos = new Vector3(), rootQuat = new Quaternion()): FK {
  const n = sk.joints.length;
  const pos: Vector3[] = new Array(n), end: Vector3[] = new Array(n), quat: Quaternion[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const j = sk.joints[i];
    const pq = j.parent < 0 ? rootQuat : quat[j.parent];
    const pp = j.parent < 0 ? rootPos : pos[j.parent];
    const p = new Vector3(j.offset[0], j.offset[1], j.offset[2]).applyQuaternion(pq).add(pp);
    const a = pose[j.id] ?? [0, 0, 0];
    _e.set(a[0], a[1], a[2], "XYZ");
    const q = pq.clone().multiply(_q.setFromEuler(_e));
    pos[i] = p;
    quat[i] = q;
    end[i] = _v.set(j.dir[0], j.dir[1], j.dir[2]).multiplyScalar(j.length).applyQuaternion(q).add(p).clone();
  }
  return { pos, end, quat };
}

export function centerOfMass(sk: Skeleton, fk: FK): Vector3 {
  const c = new Vector3();
  let m = 0;
  sk.joints.forEach((j, i) => {
    c.addScaledVector(fk.pos[i].clone().add(fk.end[i]).multiplyScalar(0.5), j.mass);
    m += j.mass;
  });
  return m > 0 ? c.multiplyScalar(1 / m) : c;
}

function hull2(points: [number, number][]): [number, number][] {
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [], upper: [number, number][] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

function segDist(p: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy || 1e-12;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

export interface BalanceState {
  com: Vector3;
  contacts: number;
  /** Signed distance (m) of the COM ground projection inside the support polygon (negative = outside). */
  margin: number;
  /** margin normalised by body height. */
  stability: number;
}

/** Static balance: COM projection vs convex hull of ground contacts within tolerance of groundY. */
export function balanceOf(sk: Skeleton, fk: FK, groundY = 0): BalanceState {
  const com = centerOfMass(sk, fk);
  const tol = 0.08 * sk.height + 0.02;
  const pts: [number, number][] = [];
  sk.joints.forEach((j, i) => {
    if (!j.contact) return;
    const e = fk.end[i];
    if (e.y - j.r1 <= groundY + tol) pts.push([e.x, e.z]);
  });
  const c: [number, number] = [com.x, com.z];
  let margin: number;
  if (pts.length === 0) margin = -sk.height;
  else if (pts.length === 1) margin = -Math.hypot(c[0] - pts[0][0], c[1] - pts[0][1]);
  else {
    const h = hull2(pts);
    if (h.length < 3) margin = -segDist(c, h[0], h[h.length - 1]);
    else {
      let inside = true, dmin = Infinity;
      for (let i = 0; i < h.length; i++) {
        const a = h[i], b = h[(i + 1) % h.length];
        const cr = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
        if (cr < 0) inside = false;
        dmin = Math.min(dmin, segDist(c, a, b));
      }
      margin = inside ? dmin : -dmin;
    }
  }
  return { com, contacts: pts.length, margin, stability: margin / Math.max(0.05, sk.height) };
}
