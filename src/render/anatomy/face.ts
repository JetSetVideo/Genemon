/**
 * Face builder (pass 4, lane face): manga eye structures, eyelids, catchlights, mouth line, inner mouth,
 * teeth per kind, beak and tongue, built FROM the head / jaw JointDefs and the morph helix.
 *
 * Frames: every head mesh is in the HEAD joint frame, every jaw mesh in the JAW joint frame
 * (src/body/skeleton.ts: +Z forward, +Y up, side +1 = +X; positive X rotation opens the jaw).
 *
 * Head volume assumption (must match the head mesh of body.ts / creature.ts): an ellipsoid centred at
 * dir * 0.45 L with semi-axes (r, 0.95 r, 0.62 L) along (side, faceUp, dir). The jaw volume: an ellipsoid
 * centred at dir * L / 2 with semi-axes (1.05 r0, 0.5 r0, L / 2). Eyes sit ON the head surface (55 %
 * protruding), teeth hang from the lip line of the head and rise from the top rim of the jaw.
 *
 * Eye layering (all on concentric shells around the eye centre so nothing z-fights, and pupils can be
 * scaled about their own pole): sclera 1.00 er, iris 1.012, hot bead 1.02, pupil 1.05 (margin for setScalar emotion scaling),
 * catchlight 1.07, lid 1.11. Glowing eyes = saturated iris shell (emissive normalised by luminance) + a small hot bead in
 * the lower iris; the catchlight sits on the saturated UPPER half (a white dot on a hot centre is
 * invisible after ACES).
 */
import * as THREE from "../../lib/three.ts";
import type { JointDef } from "../../body/skeleton.ts";
import type { Phenotype } from "../../genome/phenotype.ts";
import type { EyeStyle, MorphHelix, PupilFill, TeethKind } from "../../genome/morphTypes.ts";
import type { FaceParts, SkinMaterials } from "./types.ts";

type V3 = THREE.Vector3;
const UP = new THREE.Vector3(0, 1, 0);
const clamp = (x: number, lo: number, hi: number) => (Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : lo);

interface Frame {
  fwd: V3;
  up: V3;
  side: V3;
}

/** Joint frame with the face-up fix: world up made orthogonal to the bone (a head pointing straight
 * up looks forward, +Z). `side` always leans +X so left/right labels survive. */
function frameOf(dir: readonly [number, number, number]): Frame {
  const fwd = new THREE.Vector3(dir[0], dir[1], dir[2]);
  if (fwd.lengthSq() < 1e-9) fwd.set(0, 0, 1);
  fwd.normalize();
  const up = UP.clone().addScaledVector(fwd, -UP.dot(fwd));
  if (up.lengthSq() < 1e-4) up.set(0, 0, 1);
  else up.normalize();
  const side = new THREE.Vector3().crossVectors(up, fwd).normalize();
  if (side.x < 0) side.negate();
  return { fwd, up, side };
}

interface Ellipsoid {
  f: Frame;
  c: V3;
  a: number; // side
  b: number; // up
  d: number; // forward
}

/** Point and outward normal on an ellipsoid at azimuth `az` (toward +side) and elevation `el`. */
function surface(e: Ellipsoid, az: number, el: number, k = 1): { p: V3; n: V3 } {
  const ds = Math.cos(el) * Math.sin(az), du = Math.sin(el), df = Math.cos(el) * Math.cos(az);
  const p = e.c.clone()
    .addScaledVector(e.f.side, ds * e.a * k)
    .addScaledVector(e.f.up, du * e.b * k)
    .addScaledVector(e.f.fwd, df * e.d * k);
  const n = new THREE.Vector3()
    .addScaledVector(e.f.side, ds / e.a)
    .addScaledVector(e.f.up, du / e.b)
    .addScaledVector(e.f.fwd, df / e.d)
    .normalize();
  return { p, n };
}

/** Quaternion whose local +Y is `axis` and local +Z leans toward `toward`. */
function orient(axis: V3, toward: V3): THREE.Quaternion {
  const y = axis.clone().normalize();
  const z = toward.clone().addScaledVector(y, -toward.dot(y));
  if (z.lengthSq() < 1e-8) z.set(y.y, y.z, y.x).addScaledVector(y, -y.dot(new THREE.Vector3(y.y, y.z, y.x)));
  z.normalize();
  const x = new THREE.Vector3().crossVectors(y, z).normalize();
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}

/**
 * A patch of the sphere of radius R facing +Z: an ellipse (ax, ay) around (cx, cy), optionally an
 * annulus (`inner`) or an n-pointed star. Vertices lie exactly on the sphere, so layered patches never
 * intersect each other.
 */
function shellPatch(R: number, ax: number, ay: number, o: { cx?: number; cy?: number; inner?: number; star?: number; rings?: number; segs?: number } = {}): THREE.BufferGeometry {
  const rings = o.rings ?? 4, segs = o.segs ?? 24, inner = o.inner ?? 0, cx = o.cx ?? 0, cy = o.cy ?? 0;
  const pos: number[] = [], nor: number[] = [], uv: number[] = [], idx: number[] = [];
  const lim = R * 0.985;
  for (let i = 0; i <= rings; i++) {
    const u = inner + (1 - inner) * (i / rings);
    for (let j = 0; j <= segs; j++) {
      const ph = (j / segs) * Math.PI * 2;
      const k = o.star ? 0.3 + 0.7 * Math.pow(Math.abs(Math.cos((o.star * ph) / 2)), 3) : 1;
      let x = cx + u * k * ax * Math.cos(ph), y = cy + u * k * ay * Math.sin(ph);
      const rr = Math.hypot(x, y);
      if (rr > lim) {
        x *= lim / rr;
        y *= lim / rr;
      }
      const z = Math.sqrt(Math.max(0, R * R - x * x - y * y));
      pos.push(x, y, z);
      nor.push(x / R, y / R, z / R);
      uv.push(j / segs, i / rings);
    }
  }
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < segs; j++) {
      const a = i * (segs + 1) + j, b = a + segs + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/** A cone along +Y (base slightly embedded below y = 0) whose tip curves toward +Z by `bend` x len. */
function bentCone(rb: number, len: number, bend: number, radial = 7): THREE.BufferGeometry {
  const g = new THREE.ConeGeometry(rb, len, radial, 5);
  g.translate(0, len / 2 - len * 0.12, 0);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const t = clamp(p.getY(i) / len, 0, 1);
    p.setZ(i, p.getZ(i) + bend * len * t * t);
  }
  g.computeVertexNormals();
  return g;
}

/** Merge transformed parts into one non-indexed geometry (one draw call per half-jaw). */
function mergeParts(parts: { geo: THREE.BufferGeometry; m: THREE.Matrix4 }[]): THREE.BufferGeometry {
  const pos: number[] = [], nor: number[] = [];
  for (const { geo, m } of parts) {
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    g.applyMatrix4(m);
    if (!g.attributes.normal) g.computeVertexNormals();
    const pa = g.attributes.position.array, na = g.attributes.normal.array;
    for (let i = 0; i < pa.length; i++) pos.push(pa[i]);
    for (let i = 0; i < na.length; i++) nor.push(na[i]);
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  return out;
}

const luminance = (c: THREE.Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

interface EyeSlot {
  az: number;
  el: number;
  k: number;
  s: -1 | 0 | 1;
}

function eyeSlots(count: number): EyeSlot[] {
  const n = Math.round(clamp(count, 1, 4));
  if (n === 1) return [{ az: 0, el: 0.3, k: 1.18, s: 0 }];
  const out: EyeSlot[] = [{ az: -0.6, el: 0.3, k: 1, s: -1 }, { az: 0.6, el: 0.3, k: 1, s: 1 }];
  if (n === 3) out.push({ az: 0, el: 0.95, k: 0.6, s: 0 });
  if (n === 4) out.push({ az: -0.3, el: 0.98, k: 0.52, s: -1 }, { az: 0.3, el: 0.98, k: 0.52, s: 1 });
  return out;
}

/** Pupil shape actually drawn: the style decides, the helix pupil fill refines sharp / sleepy eyes. */
function pupilOf(style: EyeStyle, fill: PupilFill): PupilFill {
  switch (style) {
    case "round":
      return "full";
    case "sparkle":
      return "full";
    case "ring":
      return "hollow";
    case "blank":
    case "compound":
      return "none";
    case "slit":
      return "slit";
    default:
      return fill;
  }
}

/** Front-edge elevation of the open upper lid (rad): pi/2 = fully open, 0 = half covered. */
const LID_OPEN: Record<EyeStyle, number> = {
  round: 0.95,
  sparkle: 1.05,
  ring: 0.9,
  blank: 0.8,
  slit: 0.85,
  sharp: 0.42,
  sleepy: 0.1, // (1 - sin 0.1) / 2 = 45 % of the eye covered
  compound: 0,
};

export function buildFace(head: JointDef, jaw: JointDef | undefined, ph: Phenotype, helix: MorphHelix, mats: SkinMaterials, quality: "low" | "high"): FaceParts {
  const hi = quality === "high";
  const seg = hi ? 24 : 14;
  const r = Math.max(1e-3, head.r0), L = Math.max(1e-3, head.length);
  const hf = frameOf(head.dir);
  const H: Ellipsoid = { f: hf, c: hf.fwd.clone().multiplyScalar(L * 0.45), a: r, b: r * 0.95, d: L * 0.62 };
  const E = helix.eyes, M = helix.mouth;
  const style = E.style;
  const glow = clamp(E.glow, 0, 1);
  const lidAngle = clamp(E.lidAngle, -0.8, 0.8);

  const headObjs: THREE.Object3D[] = [];
  const jawObjs: THREE.Object3D[] = [];
  const pupils: THREE.Object3D[] = [];
  const lids: THREE.Object3D[] = [];
  const eyeMaterials: THREE.Material[] = [];
  const auraEmitters: V3[] = [];

  // ------------------------------------------------------------------ eye materials (shared by all eyes)
  const irisCol = new THREE.Color(E.irisColor);
  const glowing = glow > 0.35;
  const irisEmissive = Math.min(3, ((glowing ? 0.5 : 0.18) * (0.08 + glow)) / Math.max(0.1, luminance(irisCol)));
  const sclera = hi
    ? new THREE.MeshPhysicalMaterial({ color: E.scleraColor, roughness: 0.22, clearcoat: 1, clearcoatRoughness: 0.08 })
    : new THREE.MeshStandardMaterial({ color: E.scleraColor, roughness: 0.25 });
  if (style === "blank") {
    // White eyes: menace reads better with a faint inner light.
    sclera.emissive.setHex(E.scleraColor);
    sclera.emissiveIntensity = 0.14 + 0.4 * glow;
    sclera.userData.glowBase = sclera.emissiveIntensity;
  }
  const iris = new THREE.MeshStandardMaterial({
    color: irisCol,
    roughness: 0.18,
    emissive: irisCol,
    emissiveIntensity: irisEmissive,
    flatShading: style === "compound",
    metalness: style === "compound" ? 0.3 : 0,
  });
  iris.userData.glowBase = irisEmissive;
  const pupilMat = new THREE.MeshBasicMaterial({ color: 0x07070c });
  const white = new THREE.MeshBasicMaterial({ color: 0xffffff });
  eyeMaterials.push(sclera, iris, pupilMat, white);
  let bead: THREE.MeshBasicMaterial | null = null;
  if (glowing && style !== "blank") {
    // Hot bead: lighter than the shell and above 1.0 so it is the part that blooms.
    const hot = irisCol.clone().lerp(new THREE.Color(ph.palette.glow), 0.25).lerp(new THREE.Color(0xffffff), 0.35).multiplyScalar(1 + 1.6 * glow);
    bead = new THREE.MeshBasicMaterial({ color: hot });
    eyeMaterials.push(bead);
  }

  // ------------------------------------------------------------------ eyes
  const size = clamp(E.size, 0.12, 0.45);
  const fill = pupilOf(style, E.pupil);
  for (const [index, slot] of eyeSlots(E.count).entries()) {
    const er = size * r * slot.k;
    const { p, n } = surface(H, slot.az, slot.el);
    const centre = p.clone().addScaledVector(n, -er * 0.45);
    const look = n.clone().addScaledVector(hf.fwd, 0.6).normalize();
    const ey = hf.up.clone().addScaledVector(look, -hf.up.dot(look)).normalize();
    const ex = new THREE.Vector3().crossVectors(ey, look).normalize();
    const eye = new THREE.Group();
    eye.name = `eye${index}`;
    eye.userData = { eye: true, style, index, side: slot.s, radius: er };
    eye.position.copy(centre);
    eye.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(ex, ey, look));
    if (style === "sharp") eye.scale.set(1.08, 0.64, 0.9);
    headObjs.push(eye);

    if (style === "compound") {
      const dome = new THREE.Mesh(new THREE.IcosahedronGeometry(er * 1.04, hi ? 2 : 1), iris);
      eye.add(dome);
      const cl = new THREE.Mesh(new THREE.SphereGeometry(er * 0.12, 8, 6), white);
      cl.position.set(-er * 0.32, er * 0.4, er * 0.97);
      cl.userData.catchlight = true;
      eye.add(cl);
    } else {
      eye.add(new THREE.Mesh(new THREE.SphereGeometry(er, seg, seg / 2), sclera));
      if (style !== "blank") {
        const ir = er * (style === "sparkle" ? 0.78 : style === "sharp" ? 0.66 : 0.62);
        eye.add(new THREE.Mesh(shellPatch(er * 1.012, ir, ir, { rings: 3, segs: seg }), iris));
        if (bead) eye.add(new THREE.Mesh(shellPatch(er * 1.02, ir * 0.36, ir * 0.15, { cy: -ir * 0.64, rings: 2, segs: 16 }), bead));
        const pr = er * (style === "sparkle" ? 0.28 : 0.3);
        let pupil: THREE.Object3D | null = null;
        const R = er * 1.05;
        if (fill === "full") pupil = new THREE.Mesh(shellPatch(R, pr, pr, { rings: 2, segs: 20 }), pupilMat);
        else if (fill === "slit") pupil = new THREE.Mesh(shellPatch(R, pr * 0.3, ir * 0.82, { rings: 2, segs: 20 }), pupilMat);
        else if (fill === "star") pupil = new THREE.Mesh(shellPatch(R, pr * 1.2, pr * 1.2, { star: 4, rings: 2, segs: 32 }), pupilMat);
        else if (fill === "hollow") {
          // Hollow pupil: a dark ring with the iris colour still showing inside it.
          const ring = new THREE.Mesh(new THREE.TorusGeometry(pr, pr * 0.24, 8, seg), pupilMat);
          ring.position.z = Math.sqrt(R * R - pr * pr);
          pupil = ring;
        }
        if (pupil instanceof THREE.Mesh && fill !== "hollow") {
          // Re-centre the patch on its own pole so emotion scaling (setPupils) happens about the pupil,
          // not the eye centre: a pupil scaled about the eye centre would sink into the sclera.
          pupil.geometry.translate(0, 0, -R);
          pupil.position.z = R;
        }
        if (pupil) {
          pupil.userData.pupil = true;
          eye.add(pupil);
          pupils.push(pupil);
        }
        // Catchlight on the saturated upper half; sparkle eyes get stars instead of a dot.
        const hl = (geo: THREE.BufferGeometry) => {
          const m = new THREE.Mesh(geo, white);
          m.userData.catchlight = true;
          eye.add(m);
        };
        if (style === "sparkle") {
          hl(shellPatch(er * 1.07, er * 0.22, er * 0.22, { cx: -er * 0.27, cy: er * 0.3, star: 4, rings: 2, segs: 32 }));
          hl(shellPatch(er * 1.07, er * 0.11, er * 0.11, { cx: er * 0.24, cy: -er * 0.27, star: 4, rings: 2, segs: 24 }));
          hl(shellPatch(er * 1.07, er * 0.05, er * 0.05, { cx: er * 0.05, cy: er * 0.45, rings: 1, segs: 10 }));
        } else {
          hl(shellPatch(er * 1.07, er * 0.13, er * 0.11, { cx: -er * 0.25, cy: er * 0.27, rings: 2, segs: 14 }));
        }
      }
      // Upper lid: a skin hemisphere hinged on the eye centre. rotation.x = userData.open (front edge
      // above the iris) .. userData.closed (pi/2 covers the eye). Tilt (lidAngle) lives on the parent.
      const tilt = new THREE.Group();
      tilt.rotation.z = slot.s * lidAngle;
      const lid = new THREE.Group();
      const shell = new THREE.Mesh(new THREE.SphereGeometry(er * 1.11, seg, seg / 2, 0, Math.PI * 2, 0, Math.PI / 2), mats.skin);
      lid.add(shell);
      const e = LID_OPEN[style] - Math.max(0, -lidAngle) * 0.4;
      lid.rotation.x = -e;
      lid.userData = { lid: true, open: -e, closed: Math.PI / 2 };
      tilt.add(lid);
      eye.add(tilt);
      lids.push(lid);
    }
    auraEmitters.push(centre.clone().addScaledVector(ey, er * 0.95).addScaledVector(look, er * 0.45));
  }

  // ------------------------------------------------------------------ mouth line, cavity, mouth spec
  const width = clamp(M.width, 0.3, 1);
  const aw = 0.18 + 0.75 * width;
  const jaf = jaw ? frameOf(jaw.dir) : null;
  const jawOff = jaw ? new THREE.Vector3(jaw.offset[0], jaw.offset[1], jaw.offset[2]) : null;
  const lipUp = jaw && jawOff ? jawOff.dot(hf.up) + 0.1 * jaw.r0 : -0.33 * r;
  const elM = Math.asin(clamp(lipUp / H.b, -0.9, -0.05));
  const dark = new THREE.MeshStandardMaterial({ color: 0x2a0b12, roughness: 0.9 });
  eyeMaterials.push(dark);
  const corner = lidAngle > 0.15 ? -0.08 : 0.05;
  const lipPts: V3[] = [];
  for (let i = 0; i <= 12; i++) {
    const t = i / 6 - 1;
    lipPts.push(surface(H, t * aw, elM + corner * t * t, 1.004).p);
  }
  const line = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(lipPts), 24, r * (0.025 + 0.02 * width), 5), dark);
  line.userData.mouthLine = true;
  headObjs.push(line);
  if (jaw && jawOff && jaf) {
    const cav = new THREE.Mesh(new THREE.SphereGeometry(1, 14, 8), dark);
    cav.position.copy(jawOff).addScaledVector(jaf.fwd, jaw.length * 0.45).addScaledVector(hf.up, 0.05 * r);
    cav.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), hf.fwd);
    cav.scale.set(Math.max(0.2 * r, r * Math.sin(aw) * 0.85), 0.2 * r, jaw.length * 0.42);
    cav.userData.mouthCavity = true;
    headObjs.push(cav);
  }
  const front = surface(H, 0, elM);
  const mouth = {
    origin: front.p.clone().addScaledVector(front.n, 0.04 * r),
    dir: hf.fwd.clone().addScaledVector(front.n, 0.35).normalize(),
    width: 2 * H.a * Math.sin(aw) * Math.cos(elM),
  };

  // ------------------------------------------------------------------ teeth / beak / tongue
  const kind: TeethKind = M.teeth;
  const len = (0.05 + clamp(M.toothLength, 0, 0.6)) * r;
  const n = kind === "none" || kind === "beak" ? 0 : Math.round(clamp(M.teethCount, 1, 12));
  const J: Ellipsoid | null = jaw && jaf ? { f: jaf, c: jaf.fwd.clone().multiplyScalar(jaw.length / 2), a: jaw.r0 * 1.05, b: jaw.r0 * 0.5, d: jaw.length / 2 } : null;
  if (n > 0) {
    const half = (jawKey: "upper" | "lower", s: -1 | 1) => {
      const upper = jawKey === "upper";
      const ell = upper ? H : J!;
      const span = upper ? aw * 0.92 : 0.25 + 0.85 * width;
      const spacing = Math.max(1e-3, (ell.a * span) / n);
      const rb = Math.min(spacing * 0.48, len * 0.38);
      const parts: { geo: THREE.BufferGeometry; m: THREE.Matrix4 }[] = [];
      const tips: number[][] = [];
      const templates: THREE.BufferGeometry[] = [];
      const tmpl = (g: THREE.BufferGeometry) => (templates.push(g), g);
      const small = tmpl(bentCone(rb * 0.8, len * 0.35, 0));
      const plain = tmpl(bentCone(rb, len, 0, 6));
      for (let k = 0; k < n; k++) {
        const t = (k + 0.6) / (n + 0.4);
        const sp = upper ? surface(H, s * t * span, elM + 0.03, 0.985) : surface(J!, s * t * span, 0.7, 0.97);
        const axis = upper ? hf.up.clone().negate().addScaledVector(sp.n, 0.25) : ell.f.up.clone().addScaledVector(sp.n, 0.2);
        let geo = plain, tipLen = len, bend = 0;
        if (kind === "fangs") {
          const fang = k === (n >= 3 ? 1 : 0);
          geo = fang ? tmpl(bentCone(rb * 1.5, len * 1.25, -0.12)) : small;
          tipLen = fang ? len * 1.25 : len * 0.35;
          bend = fang ? -0.12 : 0;
        } else if (kind === "saw") {
          const g = new THREE.ConeGeometry(spacing * 0.55, len * 0.8, 3, 1);
          g.translate(0, len * 0.4 - len * 0.1, 0);
          g.scale(1, 1, 0.35);
          geo = tmpl(g);
          tipLen = len * 0.8;
        } else if (kind === "needles") {
          geo = tmpl(bentCone(Math.min(rb * 0.45, 0.03 * r), len * 1.1, -0.05, 4));
          tipLen = len * 1.1;
        } else if (kind === "molars") {
          const g = new THREE.BoxGeometry(spacing * 0.8, len * 0.45, spacing * 0.75);
          g.translate(0, len * 0.225 - len * 0.08, 0);
          geo = tmpl(g);
          tipLen = len * 0.45;
        } else if (kind === "tusks" && !upper && k === n - 1) {
          geo = tmpl(bentCone(rb * 2.1, len * 2.4, 0.35, 8));
          tipLen = len * 2.4;
          bend = 0.35;
        } else if (kind === "tusks") {
          geo = small;
          tipLen = len * 0.35;
        }
        // Tusks curve outward + forward; other teeth curve back into the mouth.
        const toward = kind === "tusks" ? ell.f.fwd.clone().addScaledVector(ell.f.side, s * 0.8) : ell.f.fwd.clone().negate();
        const q = orient(axis, toward);
        const m = new THREE.Matrix4().compose(sp.p, q, new THREE.Vector3(1, 1, 1));
        parts.push({ geo, m });
        const tipLocal = new THREE.Vector3(0, tipLen * 0.88, bend * tipLen * 0.77);
        const tip = tipLocal.applyMatrix4(m);
        tips.push([tip.x, tip.y, tip.z]);
      }
      const mesh = new THREE.Mesh(mergeParts(parts), mats.keratin);
      for (const g of templates) g.dispose();
      mesh.userData = { teeth: n, kind, jaw: jawKey, side: s, tips };
      (upper ? headObjs : jawObjs).push(mesh);
    };
    for (const s of [-1, 1] as const) {
      half("upper", s);
      if (J) half("lower", s);
    }
  }
  if (kind === "beak") {
    const rb = r * (0.26 + 0.24 * width), bl = r * (0.55 + 0.9 * clamp(M.toothLength, 0, 0.6));
    const base = surface(H, 0, elM + 0.22, 0.78);
    const up = new THREE.Mesh(bentCone(rb, bl, -0.35, hi ? 12 : 8), mats.keratin);
    up.quaternion.copy(orient(hf.fwd.clone().addScaledVector(hf.up, -0.25), hf.up.clone().negate()));
    up.position.copy(base.p);
    up.scale.set(0.85, 1, 1);
    up.userData.beak = "upper";
    headObjs.push(up);
    if (J) {
      const lb = surface(J, 0, 0.25, 0.7);
      const lo = new THREE.Mesh(bentCone(rb * 0.75, bl * 0.72, 0.12, hi ? 10 : 7), mats.keratin);
      lo.quaternion.copy(orient(J.f.fwd, J.f.up));
      lo.position.copy(lb.p);
      lo.scale.set(0.8, 1, 0.7);
      lo.userData.beak = "lower";
      jawObjs.push(lo);
    }
  }
  if (M.tongue && J && jaw) {
    const tc = new THREE.Color(0xd9576f).lerp(new THREE.Color(ph.palette.accent), 0.15);
    const tm = hi
      ? new THREE.MeshPhysicalMaterial({ color: tc, roughness: 0.45, clearcoat: 0.6, clearcoatRoughness: 0.3 })
      : new THREE.MeshStandardMaterial({ color: tc, roughness: 0.5 });
    eyeMaterials.push(tm);
    const tongue = new THREE.Mesh(new THREE.SphereGeometry(1, 14, 8), tm);
    tongue.position.copy(J.c).addScaledVector(J.f.up, jaw.r0 * 0.36).addScaledVector(J.f.fwd, jaw.length * 0.05);
    tongue.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), J.f.fwd);
    tongue.scale.set(jaw.r0 * 0.6, jaw.r0 * 0.18, jaw.length * 0.38);
    tongue.userData.tongue = true;
    jawObjs.push(tongue);
  }
  return { head: headObjs, jaw: jawObjs, pupils, lids, eyeMaterials, auraEmitters, mouth };
}
