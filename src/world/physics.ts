/**
 * Physics: deterministic point-mass bodies on the arena surface. Friction comes from the ground
 * (ice slides, mud bogs), slopes pull bodies downhill unless traction holds them, water drags and
 * floats, flyers hover with a spring and are pushed by wind (inversely to their mass), bodies
 * collide with mass-weighted impulses, knockback is resisted by the balance stat and can stagger.
 * Fixed dt; no randomness - the battle owns the RNG.
 */
import { clamp, type V3, v3 } from "../core/math.ts";
import type { GroundId } from "../data/grounds.ts";
import type { Weather } from "../data/weather.ts";
import type { Arena } from "./arena.ts";

export const GRAVITY = 9.81;

export type BodyMode = "ground" | "fly" | "burrow" | "frozen";

export interface Body {
  id: string;
  pos: V3;
  vel: V3;
  mass: number;
  radius: number;
  height: number;
  yaw: number;
  mode: BodyMode;
  /** Hover height above the surface when flying. */
  flyAlt: number;
  elasticity: number;
  /** 0..1 stability vs knockback. */
  balance: number;
  maxSpeed: number;
  mobility: number;
  swimmer: boolean;
  /** Desired planar direction (unit or zero) and speed fraction 0..1. */
  intent: { x: number; z: number; speed: number };
  /** Point to face (target) or null to face the velocity. */
  face: V3 | null;
  stagger: number;
  grounded: boolean;
  groundId: GroundId;
  submerged: number;
  /** Last frame's sliding speed (velocity not explained by intent) for animation. */
  slide: number;
}

export interface PhysicsEvent {
  kind: "land" | "bump" | "splash" | "slide" | "wall";
  a: string;
  b?: string;
  pos: V3;
  value: number;
}

export function makeBody(id: string, o: Partial<Body> & Pick<Body, "mass" | "radius" | "height">): Body {
  return {
    id,
    pos: v3(),
    vel: v3(),
    yaw: 0,
    mode: "ground",
    flyAlt: 2.5,
    elasticity: 0.3,
    balance: 0.6,
    maxSpeed: 4,
    mobility: 1,
    swimmer: false,
    intent: { x: 0, z: 0, speed: 0 },
    face: null,
    stagger: 0,
    grounded: true,
    groundId: "grass",
    submerged: 0,
    slide: 0,
    ...o,
  };
}

/** Knockback / pull: velocity change resisted by mass and balance; strong hits stagger and lift. */
export function applyImpulse(b: Body, impulse: V3): number {
  if (b.mode === "frozen" || b.mode === "burrow") return 0;
  const resist = 0.55 + 0.9 * b.balance;
  const dvx = impulse.x / b.mass / resist, dvy = impulse.y / b.mass / resist, dvz = impulse.z / b.mass / resist;
  b.vel.x += dvx;
  b.vel.z += dvz;
  if (b.mode === "ground") b.vel.y += Math.max(0, dvy);
  else b.vel.y += dvy;
  const mag = Math.hypot(dvx, dvy, dvz);
  if (mag > 2.2 * (0.5 + b.balance)) b.stagger = Math.max(b.stagger, 0.25 + mag * 0.08);
  return mag;
}

export function stepPhysics(bodies: Body[], arena: Arena, weather: Weather, dt: number): PhysicsEvent[] {
  const ev: PhysicsEvent[] = [];
  for (const b of bodies) {
    if (b.mode === "frozen") {
      b.vel = v3();
      continue;
    }
    const g = arena.groundAt(b.pos.x, b.pos.z);
    b.groundId = g.id;
    const terrain = arena.heightAt(b.pos.x, b.pos.z);
    const surface = g.liquid ? Math.max(terrain, arena.waterLevel) : terrain;
    const mu = g.friction * weather.frictionMult;
    const intentX = b.intent.x * b.intent.speed, intentZ = b.intent.z * b.intent.speed;
    const stag = b.stagger > 0 ? 0.15 : 1;

    if (b.mode === "fly") {
      const target = surface + b.flyAlt;
      b.vel.y += ((target - b.pos.y) * 9 - b.vel.y * 4) * dt;
      const ax = (intentX * b.maxSpeed * 1.25 - b.vel.x) * 2.2, az = (intentZ * b.maxSpeed * 1.25 - b.vel.z) * 2.2;
      b.vel.x += ax * dt * stag;
      b.vel.z += az * dt * stag;
      const windPush = weather.wind * 0.6 / Math.sqrt(Math.max(1, b.mass / 15));
      b.vel.x += windPush * dt;
      b.grounded = false;
      b.submerged = 0;
    } else if (b.mode === "burrow") {
      b.pos.y = terrain - b.height * 0.7;
      b.vel.x = intentX * b.maxSpeed * 0.8;
      b.vel.z = intentZ * b.maxSpeed * 0.8;
      b.vel.y = 0;
      b.grounded = true;
    } else {
      // Launched (knockback, bounce) or clearly above the surface -> ballistic; otherwise stick to it.
      const airborne = b.vel.y > 0.6 || b.pos.y > surface + 0.35;
      if (airborne) {
        b.vel.y -= GRAVITY * dt;
        b.grounded = false;
      } else {
        // Traction: how much of the desired velocity change the ground lets the legs apply.
        const swimK = g.liquid ? (b.swimmer ? 1.05 : 0.6) : 1;
        const want = b.maxSpeed * g.moveCost * swimK;
        const dvx = intentX * want - b.vel.x, dvz = intentZ * want - b.vel.z;
        const dvl = Math.hypot(dvx, dvz);
        const maxDv = Math.max(0.6, mu * GRAVITY * 1.6) * dt * stag * (g.liquid ? 2.5 : 1);
        const k = dvl > maxDv ? maxDv / dvl : 1;
        b.vel.x += dvx * k;
        b.vel.z += dvz * k;
        // Slopes: gravity component beyond what static friction holds.
        const { gx, gz } = arena.gradientAt(b.pos.x, b.pos.z);
        const slope = Math.hypot(gx, gz);
        if (!g.liquid && slope > mu * 0.9) {
          const a = GRAVITY * (slope - mu * 0.9) / Math.sqrt(1 + slope * slope);
          b.vel.x -= (gx / slope) * a * dt;
          b.vel.z -= (gz / slope) * a * dt;
        }
        // Kinetic friction when not actively moving.
        if (b.intent.speed < 0.05) {
          const sp = Math.hypot(b.vel.x, b.vel.z);
          if (sp > 0) {
            const dec = Math.min(sp, mu * GRAVITY * dt * 1.4);
            b.vel.x -= (b.vel.x / sp) * dec;
            b.vel.z -= (b.vel.z / sp) * dec;
          }
        }
        if (g.liquid) {
          const drag = (1.2 + g.depth) * dt;
          b.vel.x *= 1 - drag * 0.5;
          b.vel.z *= 1 - drag * 0.5;
        }
        // Landing.
        if (b.pos.y < surface) {
          if (b.vel.y < -3) {
            ev.push({ kind: g.liquid ? "splash" : "land", a: b.id, pos: { ...b.pos }, value: -b.vel.y });
          }
          b.vel.y = b.vel.y < -2 ? -b.vel.y * b.elasticity * 0.35 : 0;
          b.pos.y = surface;
        } else {
          b.pos.y = surface;
          if (b.vel.y < 0) b.vel.y = 0;
        }
        b.grounded = true;
      }
      b.submerged = g.liquid ? clamp((arena.waterLevel - terrain) / Math.max(0.1, b.height), 0, 1) : 0;
      const sideSlip = Math.hypot(b.vel.x - intentX * b.maxSpeed, b.vel.z - intentZ * b.maxSpeed);
      b.slide = b.grounded ? sideSlip : 0;
      if (b.slide > 2.5 && mu < 0.2) ev.push({ kind: "slide", a: b.id, pos: { ...b.pos }, value: b.slide });
    }
    // Speed cap and integration.
    const cap = b.maxSpeed * 3.5;
    const sp = Math.hypot(b.vel.x, b.vel.z);
    if (sp > cap) {
      b.vel.x *= cap / sp;
      b.vel.z *= cap / sp;
    }
    b.pos.x += b.vel.x * dt;
    b.pos.y += b.vel.y * dt;
    b.pos.z += b.vel.z * dt;
    // Arena bounds.
    const d = Math.hypot(b.pos.x, b.pos.z);
    const lim = arena.radius - b.radius * 0.5;
    if (d > lim) {
      const nx = b.pos.x / d, nz = b.pos.z / d;
      b.pos.x = nx * lim;
      b.pos.z = nz * lim;
      const vr = b.vel.x * nx + b.vel.z * nz;
      if (vr > 0) {
        b.vel.x -= (1 + 0.3 + 0.4 * b.elasticity) * vr * nx;
        b.vel.z -= (1 + 0.3 + 0.4 * b.elasticity) * vr * nz;
        if (vr > 3) ev.push({ kind: "wall", a: b.id, pos: { ...b.pos }, value: vr });
      }
    }
    // Facing.
    const fx = b.face ? b.face.x - b.pos.x : b.vel.x, fz = b.face ? b.face.z - b.pos.z : b.vel.z;
    if (Math.hypot(fx, fz) > 0.05) {
      const want = Math.atan2(fx, fz);
      let diff = want - b.yaw;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      const rate = (2.5 + 5 * b.mobility) / Math.sqrt(Math.max(1, b.mass / 40));
      b.yaw += clamp(diff, -rate * dt, rate * dt);
    }
    if (b.stagger > 0) b.stagger = Math.max(0, b.stagger - dt);
  }
  // Mass-weighted collisions (ignores burrowed bodies; fliers only collide with fliers).
  for (let i = 0; i < bodies.length; i++) {
    for (let j = i + 1; j < bodies.length; j++) {
      const a = bodies[i], c = bodies[j];
      if (a.mode === "burrow" || c.mode === "burrow") continue;
      if ((a.mode === "fly") !== (c.mode === "fly")) continue;
      const dx = c.pos.x - a.pos.x, dz = c.pos.z - a.pos.z;
      const d = Math.hypot(dx, dz);
      const min = a.radius + c.radius;
      if (d >= min || d < 1e-6) continue;
      const nx = dx / d, nz = dz / d;
      const overlap = min - d;
      const wa = c.mass / (a.mass + c.mass), wc = a.mass / (a.mass + c.mass);
      a.pos.x -= nx * overlap * wa;
      a.pos.z -= nz * overlap * wa;
      c.pos.x += nx * overlap * wc;
      c.pos.z += nz * overlap * wc;
      const rel = (c.vel.x - a.vel.x) * nx + (c.vel.z - a.vel.z) * nz;
      if (rel < 0) {
        const e = 0.2 + 0.4 * (a.elasticity + c.elasticity) / 2;
        const jImp = (-(1 + e) * rel) / (1 / a.mass + 1 / c.mass);
        a.vel.x -= (jImp / a.mass) * nx;
        a.vel.z -= (jImp / a.mass) * nz;
        c.vel.x += (jImp / c.mass) * nx;
        c.vel.z += (jImp / c.mass) * nz;
        if (Math.abs(rel) > 1.5) ev.push({ kind: "bump", a: a.id, b: c.id, pos: { x: a.pos.x + nx * a.radius, y: a.pos.y, z: a.pos.z + nz * a.radius }, value: jImp });
      }
    }
  }
  return ev;
}
