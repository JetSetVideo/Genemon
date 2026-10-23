/**
 * Coats, frills and flames (pass 5, lane skin-coat) [P5-V7]: the CHEAP geometry layered on the fused
 * anatomy. The coat's surface response (normal-map relief, gloss, wetness, roughness) is in skin.ts;
 * this module adds only what a normal map cannot draw on the silhouette:
 *
 *  - fur:      2-3 SHELLS (the body meshes re-drawn, pushed out along the normal in the vertex shader,
 *              alpha-tested strand noise), quality "high" only, on torso -> neck -> tail until the budget.
 *  - scales:   a dorsal row of small scutes (pyramids), high only.
 *  - feathers: card clusters — a neck ruff, shoulder / hip tufts, a tail fan.
 *  - leaves:   folded leaf cards along the spine and tail, a tail-tip cluster (plant creatures).
 *  - crystal:  faceted emissive shards on the back, shoulders and tail tip.
 *  - chitin, slime, bark, skin: no extra geometry (normal map + material only).
 *  - frills (any coat, SkinP5.frills): a scalloped membrane CREST along the back / neck / tail and, for
 *    strong frills, a neck COLLAR fan.
 *  - flames (fire creatures): animated additive flame cards at the tail tip and wing tips, driven by the
 *    creature's shared time uniform (tickSkin).
 *
 * Pass 6 colours [P6-K1] (Palette3 attribution via the skin materials' `roles`, textures.ts rolesOf):
 * frills = the membrane (WINGS role) fading into a TERTIARY edge (a gradient map along the card height),
 * feather ruff / tufts = WINGS role blended with the body, tail fan = TAIL role, leaves = MARKINGS role
 * pulled toward plant green, crystal shards = TERTIARY lit by the GLOW role.
 *
 * Every mesh is in its JOINT's local frame (types.ts), flagged `userData.coat = true` (no outline, no
 * shadow). Budget: < ~8k triangles at "high", a couple of hundred at "low" (tests/skin_p5_test.ts).
 * Deterministic: placement jitter comes from `Rng(seed)`.
 */
import * as THREE from "../../lib/three.ts";
import { Rng } from "../../core/rng.ts";
import type { JointDef, Skeleton } from "../../body/skeleton.ts";
import type { Phenotype } from "../../genome/phenotype.ts";
import type { CoatKind, MorphHelix } from "../../genome/morphTypes.ts";
import { P5_DEFAULTS } from "../../genome/morphTypes.ts";
import type { JointMeshes, SkinMaterials } from "./types.ts";
import { type ColourRoles, dataTexture, paintFeather, paintFurAlpha, paintLeaf, Raster, rgbOf, rolesOf } from "../textures.ts";
import { fireAmount, installSkinShader, matUniforms, newSkinShared, shareSkinShader, skinShared, type SkinMaterialsP5, type SkinShared } from "./skin.ts";

type V = THREE.Vector3;
type Quality = "low" | "high";
const clamp01 = (x: number) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

export interface CoatParts {
  kind: CoatKind;
  /** Meshes to attach per joint (fur shells are NOT here: they are added as children of the body meshes). */
  perJoint: JointMeshes;
  /** Fur shells (already children of their body mesh). */
  shells: THREE.Mesh[];
  materials: THREE.Material[];
  textures: THREE.Texture[];
  /** Triangles of everything built (shells included). */
  triangles: number;
  /** Triangles per feature (fur, scutes, feathers, leaves, crystal, frills, flames). */
  counts: Record<string, number>;
  dispose(): void;
}

export interface CoatOptions {
  /** Triangle budget for the whole coat (default 8000 high, 400 low). */
  budget?: number;
  /** Placement seed (deterministic look). */
  seed?: number;
}

// ------------------------------------------------------------------ joint frames

const UP = new THREE.Vector3(0, 1, 0);
const BACK = new THREE.Vector3(0, 0, -1);

interface Frame {
  dir: V;
  dorsal: V;
  lat: V;
}
/** Bone axis, dorsal (the back: up, or -Z for upright bones) and lateral axes of a joint at rest. */
export function jointFrame(j: JointDef): Frame {
  const dir = new THREE.Vector3(j.dir[0], j.dir[1], j.dir[2]).normalize();
  const ref = Math.abs(dir.dot(UP)) > 0.85 ? BACK : UP;
  const dorsal = ref.clone().addScaledVector(dir, -ref.dot(dir)).normalize();
  const lat = new THREE.Vector3().crossVectors(dir, dorsal).normalize();
  return { dir, dorsal, lat };
}
const radiusAt = (j: JointDef, t: number) => j.r0 + (j.r1 - j.r0) * t;

// ------------------------------------------------------------------ geometry batches (one mesh per joint x material)

class Batch {
  pos: number[] = [];
  nor: number[] = [];
  uv: number[] = [];
  idx: number[] = [];
  vert(p: V, n: V, u: number, v: number): number {
    this.pos.push(p.x, p.y, p.z);
    this.nor.push(n.x, n.y, n.z);
    this.uv.push(u, v);
    return this.pos.length / 3 - 1;
  }
  tri(a: number, b: number, c: number) {
    this.idx.push(a, b, c);
  }
  get tris() {
    return this.idx.length / 3;
  }
  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

/** A (folded) card: base B, length axis A (unit), width axis W (unit), 6 vertices / 4 triangles. */
function card(b: Batch, B: V, A: V, W: V, w: number, l: number, fold = 0): void {
  const N = new THREE.Vector3().crossVectors(W, A).normalize();
  const ids: number[] = [];
  for (const v of [0, 1]) {
    for (const x of [-1, 0, 1]) {
      const p = B.clone().addScaledVector(A, l * v).addScaledVector(W, (w / 2) * x).addScaledVector(N, fold * w * (1 - Math.abs(x)) * (v === 0 ? 0.3 : 1));
      ids.push(b.vert(p, N, (x + 1) / 2, v));
    }
  }
  b.tri(ids[0], ids[1], ids[4]);
  b.tri(ids[0], ids[4], ids[3]);
  b.tri(ids[1], ids[2], ids[5]);
  b.tri(ids[1], ids[5], ids[4]);
}

/** Faceted shard: a k-gon column with a pointed tip, base buried in the body (flat-shaded material). */
function shard(b: Batch, B: V, A: V, h: number, r: number, k: number, spin: number): void {
  const ref = Math.abs(A.dot(UP)) > 0.9 ? BACK : UP;
  const X = ref.clone().addScaledVector(A, -ref.dot(A)).normalize();
  const Y = new THREE.Vector3().crossVectors(A, X);
  const ring = (t: number, rr: number) =>
    Array.from({ length: k }, (_, i) => {
      const a = spin + (i / k) * Math.PI * 2;
      return B.clone().addScaledVector(A, h * t).addScaledVector(X, Math.cos(a) * rr).addScaledVector(Y, Math.sin(a) * rr);
    });
  const r0 = ring(0, r * 0.85), r1 = ring(0.62, r);
  const tip = B.clone().addScaledVector(A, h);
  for (let i = 0; i < k; i++) {
    const j = (i + 1) % k;
    const n = new THREE.Vector3().subVectors(r1[i], B).addScaledVector(A, -0.62 * h).normalize();
    const a = b.vert(r0[i], n, 0, 0), c = b.vert(r0[j], n, 1, 0), d = b.vert(r1[j], n, 1, 0.6), e = b.vert(r1[i], n, 0, 0.6);
    b.tri(a, c, d);
    b.tri(a, d, e);
    const t = b.vert(tip, n, 0.5, 1);
    b.tri(e, d, t);
  }
}

// ------------------------------------------------------------------ flame material

const FLAME_VS = `
uniform float gmTime;
varying vec2 vUv;
void main() {
  vUv = uv;
  vec3 p = position;
  p.x += sin( gmTime * 6.0 + position.y * 9.0 ) * 0.12 * uv.y * uv.y * length( position ) ;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( p, 1.0 );
}`;
const FLAME_FS = `
uniform float gmTime;
uniform vec3 gmColor;
uniform vec3 gmCore;
uniform float gmIntensity;
varying vec2 vUv;
float h21( vec2 p ) { return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 ); }
float n21( vec2 p ) {
  vec2 i = floor( p ), f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( h21( i ), h21( i + vec2( 1.0, 0.0 ) ), f.x ), mix( h21( i + vec2( 0.0, 1.0 ) ), h21( i + vec2( 1.0, 1.0 ) ), f.x ), f.y );
}
void main() {
  float y = vUv.y;
  float x = ( vUv.x - 0.5 ) * 2.0;
  float n = n21( vec2( vUv.x * 3.0, y * 4.0 - gmTime * 3.2 ) ) * 0.6 + n21( vec2( vUv.x * 7.0, y * 9.0 - gmTime * 5.0 ) ) * 0.4;
  float w = pow( max( 1.0 - y, 0.0 ), 0.7 ) * sin( 3.14159 * min( 1.0, y * 1.8 + 0.12 ) );
  float a = smoothstep( w, w - 0.35, abs( x ) + ( n - 0.5 ) * 0.5 * y ) * smoothstep( 1.0, 0.75, y + n * 0.2 );
  vec3 col = mix( gmCore, gmColor, clamp( y * 1.6 + n * 0.4 - 0.1, 0.0, 1.0 ) ) * ( 1.0 + 0.6 * ( 1.0 - y ) * ( 1.0 - abs( x ) ) );
  gl_FragColor = vec4( col * a * gmIntensity, a );
}`;

function flameMaterial(time: { value: number }, color: number, amount: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      gmTime: time,
      gmColor: { value: new THREE.Color(color) },
      gmCore: { value: new THREE.Color(0xff9a20) },
      gmIntensity: { value: 0.55 + 0.4 * amount },
    },
    vertexShader: FLAME_VS,
    fragmentShader: FLAME_FS,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
}

/** Three crossed vertical quads (6 triangles) rising from P along `up`. */
function flameCards(b: Batch, P: V, up: V, h: number): void {
  const ref = Math.abs(up.dot(BACK)) > 0.9 ? UP : BACK;
  const X = new THREE.Vector3().crossVectors(up, ref).normalize();
  for (let i = 0; i < 3; i++) {
    const W = X.clone().applyAxisAngle(up, (i / 3) * Math.PI);
    const N = new THREE.Vector3().crossVectors(W, up).normalize();
    const B = P.clone().addScaledVector(up, -h * 0.12);
    const a = b.vert(B.clone().addScaledVector(W, -h * 0.3), N, 0, 0);
    const c = b.vert(B.clone().addScaledVector(W, h * 0.3), N, 1, 0);
    const d = b.vert(B.clone().addScaledVector(W, h * 0.3).addScaledVector(up, h), N, 1, 1);
    const e = b.vert(B.clone().addScaledVector(W, -h * 0.3).addScaledVector(up, h), N, 0, 1);
    b.tri(a, c, d);
    b.tri(a, d, e);
  }
}

// ------------------------------------------------------------------ frill edge (pass 6)

/** Pure: a 4 x 32 gradient (row 0 = v 0 = the frill base) from `base` to the `edge` colour over the top ~30 %. */
export function frillEdgeRaster(base: number, edge: number, h = 32): Raster {
  const r = new Raster(4, h, rgbOf(base));
  const e = rgbOf(edge);
  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h;
    const t = Math.min(1, Math.max(0, (v - 0.62) / 0.26));
    for (let x = 0; x < 4; x++) r.blend(x, y, e, t * t * (3 - 2 * t));
  }
  return r;
}

// ------------------------------------------------------------------ the builder

const TORSO = new Set(["root", "spine", "chest", "segment"]);
const triOf = (g: THREE.BufferGeometry) => Math.round((g.index ? g.index.count : g.attributes.position?.count ?? 0) / 3);

export function buildCoat(
  sk: Skeleton,
  ph: Phenotype,
  helix: MorphHelix,
  mats: SkinMaterials,
  quality: Quality,
  body?: JointMeshes,
  opts: CoatOptions = {},
): CoatParts {
  const hi = quality === "high";
  const p5 = helix.p5 ?? P5_DEFAULTS;
  const kind: CoatKind = p5.skin.coat ?? "skin";
  const rng = new Rng(((opts.seed ?? 1) ^ 0xc0a7) >>> 0);
  const budget = opts.budget ?? (hi ? 8000 : 400);
  const shared: SkinShared = skinShared(mats) ?? newSkinShared(p5.skin.celBands);
  const materials: THREE.Material[] = [];
  const textures: THREE.Texture[] = [];
  const geometries: THREE.BufferGeometry[] = [];
  const perJoint: JointMeshes = new Map();
  const counts: Record<string, number> = { fur: 0, scutes: 0, feathers: 0, leaves: 0, crystal: 0, frills: 0, flames: 0 };
  const shells: THREE.Mesh[] = [];
  let spent = 0;

  const J = sk.joints;
  const ids = (pred: (j: JointDef) => boolean) => J.map((j, i) => (pred(j) ? i : -1)).filter((i) => i >= 0);
  const torso = ids((j) => TORSO.has(j.role));
  const neck = ids((j) => j.role === "neck");
  const tail = ids((j) => j.role === "tail");
  // The tail tip; a serpent's tail is the end of its body chain.
  const lastTail = tail.length ? tail[tail.length - 1] : ph.kind === "serpent" && torso.length > 1 ? torso[torso.length - 1] : -1;
  const wingTips = ids((j) => j.role === "wingTip");
  const limbRoots = ids((j) => j.role === "hip" || j.role === "shoulder");

  // Batches keyed by joint + material.
  const batches = new Map<string, { joint: number; mat: THREE.Material; b: Batch; feature: string }>();
  const batch = (joint: number, mat: THREE.Material, feature: string) => {
    const k = `${joint}|${mat.uuid}|${feature}`;
    let e = batches.get(k);
    if (!e) {
      e = { joint, mat, b: new Batch(), feature };
      batches.set(k, e);
    }
    return e.b;
  };
  const room = (tris: number) => spent + tris <= budget;
  const cardMaterial = (tex: THREE.Texture, color: THREE.Color): THREE.MeshStandardMaterial => {
    const m = new THREE.MeshStandardMaterial({ map: tex, color, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.7 });
    installSkinShader(m, shared, matUniforms({ shade: 0.4 }), { cel: true, shade: true, flame: false, shell: false });
    materials.push(m);
    return m;
  };
  const roles: ColourRoles = (mats as Partial<SkinMaterialsP5>).roles ?? rolesOf(ph);
  const baseC = new THREE.Color(roles.part.body), glowC = new THREE.Color(roles.glow), detailC = new THREE.Color(roles.detail);

  // ---------------------------------------------------------------- flames (fire) — first: they are the identity
  const fire = fireAmount(ph, helix);
  if (fire > 0.05) {
    const fm = flameMaterial(shared.time, 0xff3a0a, fire);
    materials.push(fm);
    const big = p5.body.tail.shape === "flame" ? 1.6 : 1;
    if (lastTail >= 0 && room(6)) {
      const j = J[lastTail];
      const f = jointFrame(j);
      const h = Math.max(j.r1 * 8, J[tail.length ? tail[0] : lastTail].r0 * 3, sk.height * 0.32) * (0.75 + 0.45 * fire) * big;
      flameCards(batch(lastTail, fm, "flames"), f.dir.clone().multiplyScalar(j.length), UP.clone(), h);
      spent += 6;
    }
    for (const w of wingTips) {
      if (!room(6)) break;
      const j = J[w];
      flameCards(batch(w, fm, "flames"), new THREE.Vector3(j.dir[0], j.dir[1], j.dir[2]).normalize().multiplyScalar(j.length), UP.clone(), Math.max(j.r0 * 4, sk.height * 0.12) * (0.5 + 0.5 * fire));
      spent += 6;
    }
  }

  // ---------------------------------------------------------------- frills: dorsal crest + collar
  const frills = clamp01(p5.skin.frills);
  if (frills > 0.15) {
    // Frill = the membrane colour with a TERTIARY edge (gradient map along the card height v) [P6-K1].
    const frillMat = mats.membrane.clone();
    const edgeTex = dataTexture(frillEdgeRaster(mats.membrane.color.getHex(), roles.detail), true);
    edgeTex.wrapT = THREE.ClampToEdgeWrapping;
    frillMat.map = edgeTex;
    frillMat.color.setHex(0xffffff);
    shareSkinShader(mats.membrane, frillMat);
    frillMat.userData.role = "frill";
    materials.push(frillMat);
    textures.push(edgeTex);
    const crestJoints = [...torso, ...neck, ...tail.slice(0, Math.max(1, Math.ceil(tail.length * 0.75)))];
    const segs = hi ? 6 : 3;
    for (const ji of crestJoints) {
      if (!room(segs * 2)) break;
      const j = J[ji];
      const f = jointFrame(j);
      const b = batch(ji, frillMat, "frills");
      const H = radiusAt(j, 0.5) * (0.35 + 0.9 * frills);
      const scallops = 1 + Math.round(2 * frills);
      let prevB = -1, prevT = -1;
      for (let s = 0; s <= segs; s++) {
        const t = 0.05 + 0.9 * (s / segs);
        const r = radiusAt(j, t);
        const h = H * (0.55 + 0.45 * Math.abs(Math.sin(Math.PI * scallops * t)));
        const base = f.dir.clone().multiplyScalar(j.length * t).addScaledVector(f.dorsal, r * 0.8);
        const top = base.clone().addScaledVector(f.dorsal, h).addScaledVector(f.dir, -h * 0.25);
        const ib = b.vert(base, f.lat, t, 0), it = b.vert(top, f.lat, t, 1);
        if (prevB >= 0) {
          b.tri(prevB, ib, it);
          b.tri(prevB, it, prevT);
        }
        prevB = ib;
        prevT = it;
      }
      spent += segs * 2;
    }
    // Collar fan (frilled lizard) around the neck tip, open backward, skipping the throat.
    const collarJ = neck.length ? neck[neck.length - 1] : torso.length ? torso[torso.length - 1] : -1;
    const K = hi ? 12 : 6;
    if (frills > 0.55 && collarJ >= 0 && room(K * 2)) {
      const j = J[collarJ];
      const f = jointFrame(j);
      const b = batch(collarJ, frillMat, "frills");
      const c = f.dir.clone().multiplyScalar(j.length * 0.9);
      const r0 = j.r1 * 0.85, r1 = j.r1 * (1.9 + 1.4 * frills);
      let pi = -1, po = -1;
      for (let i = 0; i <= K; i++) {
        const a = -Math.PI * 0.75 + (i / K) * Math.PI * 1.5; // 270 degrees centred on the dorsal side
        const radial = f.dorsal.clone().multiplyScalar(Math.cos(a)).addScaledVector(f.lat, Math.sin(a));
        const sc = 0.85 + 0.15 * Math.cos(i * Math.PI);
        const pIn = c.clone().addScaledVector(radial, r0);
        const pOut = c.clone().addScaledVector(radial, r1 * sc).addScaledVector(f.dir, -r1 * 0.35);
        const n = f.dir.clone();
        const ii = b.vert(pIn, n, i / K, 0), io = b.vert(pOut, n, i / K, 1);
        if (pi >= 0) {
          b.tri(pi, ii, io);
          b.tri(pi, io, po);
        }
        pi = ii;
        po = io;
      }
      spent += K * 2;
    }
  }

  // ---------------------------------------------------------------- coat-specific geometry
  if (kind === "feathers") {
    const tex = dataTexture(paintFeather(opts.seed ?? 1), true);
    textures.push(tex);
    const fm = cardMaterial(tex, new THREE.Color(roles.part.wings).lerp(baseC, 0.45));
    const tailC = new THREE.Color(roles.part.tail);
    const fanM = roles.part.tail === roles.part.wings ? fm : cardMaterial(tex, tailC.lerp(baseC, 0.2));
    const ruffJ = neck.length ? neck[neck.length - 1] : torso.length ? torso[torso.length - 1] : -1;
    const perCluster = hi ? 9 : 4;
    if (ruffJ >= 0) {
      const j = J[ruffJ];
      const f = jointFrame(j);
      const b = batch(ruffJ, fm, "feathers");
      for (let i = 0; i < perCluster && room(4); i++) {
        const a = -Math.PI * 0.8 + (i / Math.max(1, perCluster - 1)) * Math.PI * 1.6;
        const radial = f.dorsal.clone().multiplyScalar(Math.cos(a)).addScaledVector(f.lat, Math.sin(a));
        const B = f.dir.clone().multiplyScalar(j.length * 0.55).addScaledVector(radial, j.r1 * 0.75);
        const A = radial.clone().multiplyScalar(0.55).addScaledVector(f.dir, -0.85).normalize();
        const W = new THREE.Vector3().crossVectors(A, radial).normalize();
        const l = j.r1 * (1.5 + 0.5 * rng.next());
        card(b, B, A, W, l * 0.45, l, 0.1);
        spent += 4;
      }
    }
    for (const li of limbRoots) {
      const j = J[li];
      const f = jointFrame(j);
      const b = batch(li, fm, "feathers");
      const n = hi ? 4 : 1;
      for (let i = 0; i < n && room(4); i++) {
        const side = j.side || 1;
        const out = f.lat.clone().multiplyScalar(side);
        const B = f.dir.clone().multiplyScalar(j.length * (0.15 + 0.15 * i)).addScaledVector(out, j.r0 * 0.7);
        const A = f.dir.clone().addScaledVector(out, 0.35).normalize();
        const W = new THREE.Vector3().crossVectors(A, out).normalize();
        const l = j.r0 * (1.6 + 0.4 * rng.next());
        card(b, B, A, W, l * 0.45, l, 0.1);
        spent += 4;
      }
    }
    if (lastTail >= 0) {
      const j = J[lastTail];
      const f = jointFrame(j);
      const b = batch(lastTail, fanM, "feathers");
      const n = hi ? 7 : 3;
      for (let i = 0; i < n && room(4); i++) {
        const a = (i / Math.max(1, n - 1) - 0.5) * 1.6;
        const A = f.dir.clone().multiplyScalar(Math.cos(a)).addScaledVector(f.lat, Math.sin(a)).normalize();
        const B = f.dir.clone().multiplyScalar(j.length * 0.7);
        const l = Math.max(j.r0 * 4, sk.height * 0.18) * (0.85 + 0.3 * rng.next());
        card(b, B, A, f.dorsal.clone().cross(A).normalize(), l * 0.35, l, 0.05);
        spent += 4;
      }
    }
  } else if (kind === "leaves") {
    const tex = dataTexture(paintLeaf(opts.seed ?? 1), true);
    textures.push(tex);
    const leafC = new THREE.Color(roles.part.markings).lerp(new THREE.Color(0x3fbf4a), 0.55);
    const lm = cardMaterial(tex, leafC);
    const along = [...torso, ...neck, ...tail];
    const per = hi ? 2 : 1;
    for (const ji of along) {
      const j = J[ji];
      const f = jointFrame(j);
      const b = batch(ji, lm, "leaves");
      for (let k = 0; k < per; k++) {
        if (!room(4)) break;
        const t = per === 1 ? 0.5 : 0.3 + 0.4 * k;
        const side = (ji + k) % 2 ? 1 : -1;
        const r = radiusAt(j, t);
        const B = f.dir.clone().multiplyScalar(j.length * t).addScaledVector(f.dorsal, r * 0.75).addScaledVector(f.lat, side * r * 0.25);
        const A = f.dorsal.clone().multiplyScalar(0.75).addScaledVector(f.dir, -0.6).addScaledVector(f.lat, side * 0.45).normalize();
        const W = new THREE.Vector3().crossVectors(A, f.lat).normalize();
        const l = r * (1.3 + 0.5 * rng.next());
        card(b, B, A, W, l * 0.55, l, 0.22);
        spent += 4;
      }
    }
    if (lastTail >= 0) {
      const j = J[lastTail];
      const f = jointFrame(j);
      const b = batch(lastTail, lm, "leaves");
      for (let i = 0; i < 3 && room(4); i++) {
        const a = (i - 1) * 0.7;
        const A = f.dir.clone().multiplyScalar(Math.cos(a)).addScaledVector(f.lat, Math.sin(a)).addScaledVector(f.dorsal, 0.2).normalize();
        const l = Math.max(j.r0 * 4, sk.height * 0.14);
        card(b, f.dir.clone().multiplyScalar(j.length * 0.8), A, f.dorsal.clone().cross(A).normalize(), l * 0.5, l, 0.25);
        spent += 4;
      }
    }
  } else if (kind === "crystal") {
    const cm = new THREE.MeshStandardMaterial({
      color: detailC.clone().lerp(glowC, 0.35).lerp(new THREE.Color(0xffffff), 0.25),
      emissive: glowC,
      emissiveIntensity: 0.55,
      roughness: 0.12,
      metalness: 0.1,
      flatShading: true,
      transparent: true,
      opacity: 0.9,
    });
    installSkinShader(cm, shared, matUniforms({ rimColor: glowC, rim: 0.35, rimPower: 2 }), { cel: true, shade: false, flame: false, shell: false });
    materials.push(cm);
    const sites: { ji: number; t: number; n: number }[] = [
      ...torso.map((ji) => ({ ji, t: 0.5, n: hi ? 2 : 1 })),
      ...limbRoots.filter((ji) => J[ji].role === "shoulder").map((ji) => ({ ji, t: 0.1, n: 1 })),
      ...(lastTail >= 0 ? [{ ji: lastTail, t: 0.8, n: hi ? 3 : 1 }] : []),
    ];
    const k = hi ? 5 : 4;
    const per = k * 3;
    for (const s of sites) {
      const j = J[s.ji];
      const f = jointFrame(j);
      const b = batch(s.ji, cm, "crystal");
      for (let i = 0; i < s.n && room(per); i++) {
        const r = radiusAt(j, s.t);
        const out = j.role === "shoulder" ? f.lat.clone().multiplyScalar(j.side || 1).add(f.dorsal).normalize() : f.dorsal.clone();
        const A = out.clone().addScaledVector(f.dir, -0.35 + 0.3 * (rng.next() - 0.5)).addScaledVector(f.lat, (rng.next() - 0.5) * 0.6).normalize();
        const B = f.dir.clone().multiplyScalar(j.length * (s.t + 0.15 * (i - (s.n - 1) / 2))).addScaledVector(out, r * 0.7);
        const h = r * (0.9 + 0.8 * rng.next()) * (j.role === "tail" ? 1.6 : 1);
        shard(b, B, A, h, h * 0.2, k, rng.next() * 3);
        spent += per;
      }
    }
  } else if (kind === "scales" && hi) {
    const along = [...torso, ...tail];
    for (const ji of along) {
      const j = J[ji];
      const f = jointFrame(j);
      const b = batch(ji, mats.accent, "scutes");
      for (let i = 0; i < 3 && room(12); i++) {
        const t = 0.2 + 0.3 * i;
        const r = radiusAt(j, t);
        shard(b, f.dir.clone().multiplyScalar(j.length * t).addScaledVector(f.dorsal, r * 0.85), f.dorsal.clone().addScaledVector(f.dir, -0.6).normalize(), r * 0.4, r * 0.22, 4, Math.PI / 4);
        spent += 12;
      }
    }
  }

  // ---------------------------------------------------------------- fur shells (high only, body meshes required)
  if (kind === "fur" && hi && body) {
    const furTex = dataTexture(paintFurAlpha(opts.seed ?? 1, 64, 0.6), false);
    furTex.repeat.set(7, 7);
    textures.push(furTex);
    const groups = [torso, neck, tail];
    const meshesOf = (ji: number) => {
      const out: THREE.Mesh[] = [];
      for (const o of body.get(ji) ?? []) o.traverse((x) => (x as THREE.Mesh).isMesh && !x.userData.coat && out.push(x as THREE.Mesh));
      return out;
    };
    const left = budget - spent;
    const chosen: THREE.Mesh[] = [];
    let tris = 0;
    let nShells = 3;
    const torsoTris = torso.flatMap(meshesOf).reduce((s, m) => s + triOf(m.geometry), 0);
    if (torsoTris * 3 > left) nShells = 2;
    for (const g of groups) {
      const ms = g.flatMap(meshesOf);
      const t = ms.reduce((s, m) => s + triOf(m.geometry), 0);
      if ((tris + t) * nShells > left) continue;
      chosen.push(...ms);
      tris += t;
    }
    const furLen = (torso.length ? J[torso[0]].r0 : sk.height * 0.2) * (0.09 + 0.08 * clamp01(helix.surface.fur + 0.4));
    if (chosen.length && tris * nShells <= left) {
      for (let s = 0; s < nShells; s++) {
        const k = (s + 1) / nShells;
        const m = new THREE.MeshStandardMaterial({
          map: mats.skin.map,
          color: new THREE.Color(0xffffff).multiplyScalar(0.8 + 0.2 * k),
          alphaMap: furTex,
          alphaTest: 0.3 + 0.18 * k,
          roughness: 1,
          side: THREE.FrontSide,
        });
        if (!shareSkinShader(mats.skin, m, { shell: true }, { shell: { value: furLen * k } })) {
          installSkinShader(m, shared, matUniforms({ shell: furLen * k, shade: 0.4 }), { cel: true, shade: true, flame: false, shell: true });
        }
        materials.push(m);
        for (const src of chosen) {
          const sh = new THREE.Mesh(src.geometry, m);
          sh.userData.coat = true;
          sh.userData.noOutline = true;
          sh.castShadow = false;
          src.add(sh);
          shells.push(sh);
        }
      }
      spent += tris * nShells;
      counts.fur = tris * nShells;
    }
  }

  // ---------------------------------------------------------------- emit meshes
  for (const e of batches.values()) {
    if (e.b.tris === 0) continue;
    const g = e.b.geometry();
    geometries.push(g);
    const mesh = new THREE.Mesh(g, e.mat);
    mesh.userData.coat = true;
    mesh.userData.noOutline = true;
    mesh.castShadow = false;
    if (e.feature === "flames") mesh.renderOrder = 3;
    counts[e.feature] = (counts[e.feature] ?? 0) + e.b.tris;
    const list = perJoint.get(e.joint) ?? [];
    list.push(mesh);
    perJoint.set(e.joint, list);
  }
  const triangles = Object.values(counts).reduce((s, n) => s + n, 0);
  return {
    kind,
    perJoint,
    shells,
    materials,
    textures,
    triangles,
    counts,
    dispose: () => {
      for (const s of shells) s.removeFromParent();
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
      for (const t of textures) t.dispose();
    },
  };
}
