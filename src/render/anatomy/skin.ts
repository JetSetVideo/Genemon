/**
 * Skin materials. Pass 4 (lane face) + pass 5 (lane skin-coat) [P5-V7, P5-V8].
 *
 *  - skin (the BACK): colour map painted by textures.paintSkin (pattern + up to 3 overlays, stripes
 *    element-coloured) + a NORMAL map from the coat's relief (scales, fur, feathers, leaves, chitin,
 *    slime, bark, crystal; bare skin follows the pattern), coat-driven roughness / sheen / clearcoat /
 *    metalness / opacity, emissive glow for fire / electric / light, a fresnel RIM.
 *  - belly: its OWN colour + normal maps (textures.paintBelly: lighter, scutes / fur / plates / feathers /
 *    folds) so the ventral group of every loft (body.ts) reads as a belly.
 *  - accent, keratin (ivory), membrane (double-sided, translucent; FLAMES on fire creatures).
 *
 * ONE onBeforeCompile per material adds, on the standard / physical templates (every injection is
 * conditional on its anchor: a foreign shader is left untouched, never a compile error):
 *  - RIM (pass 4): `material.userData.rim` = { color, strength, power } uniforms (the views raise it).
 *  - CEL: the direct diffuse light is quantised into SkinP5.celBands tones (anti-aliased band edges,
 *    `celQuantize` is the same maths in TS) plus a hard specular highlight; normal map + rim kept.
 *  - COUNTERSHADE: a WORLD-space term (top darker, underside lighter and tinted toward the belly
 *    colour) so bellies differ even where a mesh has no belly group (heads, limbs, blobs).
 *  - AGE: desaturation + greying of the top coat for elders (`ageTint`).
 *  - FLAME: animated emissive flicker (noise scrolling with a time uniform) on fire wings (`tickSkin`).
 * Shared uniforms (time, age, cel bands) live in one `SkinShared` per creature: `skinShared(mats)`.
 *
 * Also here: `applyScars` (scar decals painted into per-joint copies of the skin colour texture),
 * `ageTint`, `tickSkin`, and the inverted-hull INK OUTLINE (`makeOutlineMaterial`, `addOutlines`).
 *
 * Headless (no `document`, Deno tests): no texture work unless `opts.textures` forces it (the painters
 * are pure and DataTextures need no GPU); materials come back without maps by default.
 */
import * as THREE from "../../lib/three.ts";
import type { CoatKind, MorphHelix, SkinP5 } from "../../genome/morphTypes.ts";
import { P5_DEFAULTS } from "../../genome/morphTypes.ts";
import type { Phenotype } from "../../genome/phenotype.ts";
import type { LifePhase, Scar } from "../../genome/lifeTypes.ts";
import type { Skeleton } from "../../body/skeleton.ts";
import {
  bellyStyle,
  countershadeColors,
  dataTexture,
  normalFromHeight,
  paintBelly,
  paintRelief,
  paintScar,
  paintSkin,
  Raster,
  rgbOf,
  scarKindOf,
  type ScarStroke,
} from "../textures.ts";
import type { SkinMaterials } from "./types.ts";

type Mat = THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial;
const clamp = (x: number, lo: number, hi: number) => (Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : lo);
const clamp01 = (x: number) => clamp(x, 0, 1);

// ====================================================================== shared state

type U<T> = { value: T };
/** Uniforms shared by every material of ONE creature. */
export interface SkinShared {
  time: U<number>;
  /** 0 young .. 1 ancient. */
  age: U<number>;
  celBands: U<number>;
  /** 0 = plain PBR .. 1 = full toon bands. */
  celMix: U<number>;
  /** Full-tone diffuse irradiance (L / albedo) of the brightest band; brighter light is capped to it. */
  celRef: U<number>;
  /** Tone of the darkest band as a fraction of celRef (shadow floor). */
  celFloor: U<number>;
}
/** Per-material uniforms. */
interface MatUniforms {
  rim: { color: U<THREE.Color>; strength: U<number>; power: U<number> };
  shade: U<number>;
  shadeBelly: U<THREE.Color>;
  flame: U<number>;
  flameColor: U<THREE.Color>;
  flameCore: U<THREE.Color>;
  shell: U<number>;
}
interface ShaderState {
  shared: SkinShared;
  u: MatUniforms;
  flags: { cel: boolean; shade: boolean; flame: boolean; shell: boolean };
}
const STATE = new WeakMap<THREE.Material, ShaderState>();
/** Base raster of a skin colour map (scars repaint copies of it). */
const RASTERS = new WeakMap<THREE.Material, Raster>();
/** Untouched roughness / clearcoat (ageTint is idempotent). */
const BASE = new WeakMap<THREE.Material, { rough: number; clear: number; sheen: number }>();

export function newSkinShared(celBands = 3, celMix = 1): SkinShared {
  return { time: { value: 0 }, age: { value: 0 }, celBands: { value: clamp(Math.round(celBands), 2, 5) }, celMix: { value: celMix }, celRef: { value: 1 }, celFloor: { value: 0.26 } };
}

/** The shared uniforms of a creature's materials (undefined for foreign materials). */
export function skinShared(mats: SkinMaterials): SkinShared | undefined {
  return STATE.get(mats.skin)?.shared;
}

// ====================================================================== cel maths (TS mirror of the GLSL)

/**
 * Cel band quantisation (TS mirror of the GLSL): light L relative to the full-tone reference `ref`
 * falls into one of `bands` equal bands (steps at k / bands, edges smoothed over `aa` like fwidth);
 * band k maps to the tone floor + (1 - floor) * k / (bands - 1). Returns that tone (fraction of ref):
 * monotone, in [floor, 1], exactly `bands` distinct values away from the edges.
 */
export function celQuantize(L: number, bands: number, aa = 0, floor = 0.26, ref = 1): number {
  const n = clamp(Math.round(bands), 2, 5);
  const z = (Math.max(0, L) / ref) * n - 0.5;
  const f = z - Math.floor(z);
  const w = Math.max(1e-4, aa);
  const s = clamp01((f - (0.5 - w)) / (2 * w));
  const b = clamp(Math.floor(z) + s * s * (3 - 2 * s), 0, n - 1);
  return floor + (1 - floor) * (b / (n - 1));
}

// ====================================================================== shader injection

const A_COMMON = "#include <common>";
const A_EMISSIVE = "#include <emissivemap_fragment>";
const A_AO = "#include <aomap_fragment>";
const A_NORMAL = "#include <normal_fragment_begin>";
const A_BEGIN_V = "#include <begin_vertex>";
const A_BEGINNORMAL_V = "#include <beginnormal_vertex>";

const GLSL_DECL = `
uniform vec3 gmRimColor;
uniform float gmRimStrength;
uniform float gmRimPower;
uniform float gmTime;
uniform float gmCelBands;
uniform float gmCelMix;
uniform float gmCelRef;
uniform float gmCelFloor;
uniform float gmShade;
uniform vec3 gmShadeBelly;
uniform float gmAge;
uniform float gmFlame;
uniform vec3 gmFlameColor;
uniform vec3 gmFlameCore;
float gmHash( vec2 p ) { return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 ); }
float gmNoise( vec2 p ) {
  vec2 i = floor( p ), f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( gmHash( i ), gmHash( i + vec2( 1.0, 0.0 ) ), f.x ), mix( gmHash( i + vec2( 0.0, 1.0 ) ), gmHash( i + vec2( 1.0, 1.0 ) ), f.x ), f.y );
}`;

/** Countershade + age, on the diffuse colour (before lighting; uses the geometric normal). */
const GLSL_SHADE = `
{
  vec3 gmUp = normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );
  float gmU = dot( nonPerturbedNormal, gmUp );
  float gmTop = max( gmU, 0.0 );
  float gmBot = max( - gmU, 0.0 );
  diffuseColor.rgb *= 1.0 - 0.32 * gmShade * gmTop;
  diffuseColor.rgb = mix( diffuseColor.rgb, gmShadeBelly, 0.75 * gmShade * smoothstep( - 0.15, 0.55, - gmU ) );
  diffuseColor.rgb *= 1.0 + 0.3 * gmShade * gmBot;
  float gmL = dot( diffuseColor.rgb, vec3( 0.299, 0.587, 0.114 ) );
  diffuseColor.rgb = mix( diffuseColor.rgb, vec3( gmL ), 0.4 * gmAge );
  diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.78, 0.76, 0.72 ) * max( gmL * 1.4, 0.35 ), 0.25 * gmAge * smoothstep( 0.2, 0.9, gmTop ) );
}`;

const GLSL_RIM = `
{ float gmF = 1.0 - saturate( dot( normal, normalize( vViewPosition ) ) );
  totalEmissiveRadiance += gmRimColor * gmRimStrength * pow( gmF, gmRimPower ); }`;

/** Countershade, part 2: a soft ground BOUNCE on the underside, so the belly stays lighter than the back
 * even in the shadow band of the cel lighting. */
const GLSL_BOUNCE = `
{ vec3 gmUp2 = normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );
  float gmDown = smoothstep( 0.0, 0.8, - dot( nonPerturbedNormal, gmUp2 ) );
  totalEmissiveRadiance += gmShadeBelly * diffuseColor.rgb * ( 0.55 * gmShade * gmDown ); }`;

const GLSL_FLAME = `
#ifdef GM_FLAME
{
  vec2 gmP = vUv * vec2( 5.0, 3.0 );
  float gmN1 = gmNoise( gmP + vec2( 0.0, - gmTime * 2.2 ) );
  float gmN2 = gmNoise( gmP * 2.3 + vec2( gmTime * 0.7, - gmTime * 3.1 ) );
  float gmFl = smoothstep( 0.35, 0.95, gmN1 * 0.65 + gmN2 * 0.45 );
  float gmFk = 0.75 + 0.25 * sin( gmTime * 13.0 + gmN2 * 6.0 );
  totalEmissiveRadiance += mix( gmFlameColor, gmFlameCore, gmFl * gmFl ) * gmFl * gmFk * gmFlame;
}
#endif`;

/**
 * Cel bands on the TOTAL diffuse (direct + ambient, so the sky gradient bands too) + a hard specular
 * highlight (after lighting, before output). Only the light INTENSITY is quantised (hue preserved), into
 * celBands tones between gmCelFloor and 1 of the full-tone irradiance gmCelRef: never brighter than the
 * reference, so element colours are not blown out. Same maths as `celQuantize`.
 */
const GLSL_CEL = `
{
  float gmAl = max( dot( diffuseColor.rgb, vec3( 0.299, 0.587, 0.114 ) ), 1e-3 );
  vec3 gmDD = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse;
  float gmLi = dot( gmDD, vec3( 0.299, 0.587, 0.114 ) ) / gmAl;
  float gmZ = gmLi / gmCelRef * gmCelBands - 0.5;
  float gmW = fwidth( gmZ ) * 0.75 + 1e-4;
  float gmB = clamp( floor( gmZ ) + smoothstep( 0.5 - gmW, 0.5 + gmW, fract( gmZ ) ), 0.0, gmCelBands - 1.0 );
  float gmLq = gmCelRef * mix( gmCelFloor, 1.0, gmB / ( gmCelBands - 1.0 ) );
  float gmK = mix( 1.0, gmLq / max( gmLi, 1e-4 ), gmCelMix );
  reflectedLight.directDiffuse *= gmK;
  reflectedLight.indirectDiffuse *= gmK;
  float gmSp = dot( reflectedLight.directSpecular, vec3( 0.299, 0.587, 0.114 ) );
  vec3 gmSpHard = reflectedLight.directSpecular / max( gmSp, 1e-4 ) * smoothstep( 0.16, 0.22, gmSp ) * 0.55;
  reflectedLight.directSpecular = mix( reflectedLight.directSpecular, gmSpHard, gmCelMix * 0.7 );
}`;

const GLSL_SHELL_DECL = "uniform float gmShell;";
const GLSL_SHELL = `
transformed += normalize( objectNormal ) * gmShell;`;

/**
 * Installs the pass-5 skin shader (rim + cel + countershade + age + optional flame / fur-shell push)
 * on a standard / physical material. Every replacement is anchor-guarded.
 */
export function installSkinShader(mat: Mat, shared: SkinShared, u: MatUniforms, flags: ShaderState["flags"]): void {
  STATE.set(mat, { shared, u, flags });
  mat.userData.rim = u.rim;
  // Keep the template's own defines (STANDARD / PHYSICAL); flame needs vUv.
  const md = mat as unknown as { defines?: Record<string, string> };
  if (flags.flame) md.defines = { ...(md.defines ?? {}), USE_UV: "", GM_FLAME: "" };
  mat.onBeforeCompile = (shader) => {
    const fs = shader.fragmentShader;
    if (fs.includes(A_COMMON) && fs.includes(A_EMISSIVE) && fs.includes("vViewPosition")) {
      Object.assign(shader.uniforms, {
        gmRimColor: u.rim.color,
        gmRimStrength: u.rim.strength,
        gmRimPower: u.rim.power,
        gmTime: shared.time,
        gmCelBands: shared.celBands,
        gmCelMix: shared.celMix,
        gmCelRef: shared.celRef,
        gmCelFloor: shared.celFloor,
        gmShade: u.shade,
        gmShadeBelly: u.shadeBelly,
        gmAge: shared.age,
        gmFlame: u.flame,
        gmFlameColor: u.flameColor,
        gmFlameCore: u.flameCore,
      });
      const shadeOk = flags.shade && fs.includes(A_NORMAL);
      let out = fs.replace(A_COMMON, `${A_COMMON}\n${GLSL_DECL}`);
      out = out.replace(A_EMISSIVE, `${shadeOk ? GLSL_SHADE : ""}\n${A_EMISSIVE}\n${GLSL_RIM}\n${shadeOk ? GLSL_BOUNCE : ""}\n${flags.flame ? GLSL_FLAME : ""}`);
      if (flags.cel && out.includes(A_AO) && out.includes("reflectedLight")) out = out.replace(A_AO, `${A_AO}\n${GLSL_CEL}`);
      shader.fragmentShader = out;
    }
    const vs = shader.vertexShader;
    if (flags.shell && vs.includes(A_COMMON) && vs.includes(A_BEGIN_V) && vs.includes(A_BEGINNORMAL_V)) {
      shader.uniforms.gmShell = u.shell;
      shader.vertexShader = vs.replace(A_COMMON, `${A_COMMON}\n${GLSL_SHELL_DECL}`).replace(A_BEGIN_V, `${A_BEGIN_V}\n${GLSL_SHELL}`);
    }
  };
  const key = `gm-skin5-${+flags.cel}${+flags.shade}${+flags.flame}${+flags.shell}`;
  mat.customProgramCacheKey = () => key;
}

/** Fresh per-material uniforms. */
export function matUniforms(o: { rimColor?: THREE.Color; rim?: number; rimPower?: number; shade?: number; belly?: THREE.Color; flame?: number; flameColor?: THREE.Color; flameCore?: THREE.Color; shell?: number } = {}): MatUniforms {
  return {
    rim: { color: { value: (o.rimColor ?? new THREE.Color(0xffffff)).clone() }, strength: { value: o.rim ?? 0 }, power: { value: o.rimPower ?? 3 } },
    shade: { value: o.shade ?? 0 },
    shadeBelly: { value: (o.belly ?? new THREE.Color(0xffffff)).clone() },
    flame: { value: o.flame ?? 0 },
    flameColor: { value: (o.flameColor ?? new THREE.Color(0xff5a1f)).clone() },
    flameCore: { value: (o.flameCore ?? new THREE.Color(0xffd166)).clone() },
    shell: { value: o.shell ?? 0 },
  };
}

/** Re-installs a creature's shader on a material clone, SHARING its uniforms (charge rim, time, age). */
export function shareSkinShader(from: Mat, to: Mat, extra: Partial<ShaderState["flags"]> = {}, uOverride?: Partial<MatUniforms>): boolean {
  const st = STATE.get(from);
  if (!st) return false;
  installSkinShader(to, st.shared, { ...st.u, ...uOverride }, { ...st.flags, ...extra });
  return true;
}

// ====================================================================== coat -> material response

interface CoatLook {
  rough: number;
  clear: number;
  clearRough: number;
  sheen: number;
  normal: number;
  metal: number;
  opacity: number;
  rim: number;
  rimPower: number;
  emissive: number;
}
const COAT_LOOK: Record<CoatKind, CoatLook> = {
  skin: { rough: 0, clear: 0, clearRough: 0.4, sheen: 0, normal: 1, metal: 0, opacity: 1, rim: 0, rimPower: 0, emissive: 0 },
  fur: { rough: 0.2, clear: 0, clearRough: 0.4, sheen: 1, normal: 0.8, metal: 0, opacity: 1, rim: 0.12, rimPower: -1, emissive: 0 },
  scales: { rough: -0.1, clear: 0.35, clearRough: 0.3, sheen: 0, normal: 1.25, metal: 0, opacity: 1, rim: 0.02, rimPower: 0, emissive: 0 },
  feathers: { rough: 0.1, clear: 0, clearRough: 0.4, sheen: 0.55, normal: 0.9, metal: 0, opacity: 1, rim: 0.08, rimPower: -0.6, emissive: 0 },
  leaves: { rough: 0.05, clear: 0.2, clearRough: 0.35, sheen: 0.2, normal: 1, metal: 0, opacity: 1, rim: 0.05, rimPower: 0, emissive: 0.03 },
  chitin: { rough: -0.3, clear: 0.9, clearRough: 0.12, sheen: 0, normal: 1.3, metal: 0.15, opacity: 1, rim: 0.05, rimPower: 0.5, emissive: 0 },
  slime: { rough: -0.45, clear: 1, clearRough: 0.04, sheen: 0, normal: 0.5, metal: 0, opacity: 0.88, rim: 0.2, rimPower: -0.8, emissive: 0.12 },
  bark: { rough: 0.35, clear: 0, clearRough: 0.5, sheen: 0, normal: 1.7, metal: 0, opacity: 1, rim: 0, rimPower: 0, emissive: 0 },
  crystal: { rough: -0.35, clear: 0.8, clearRough: 0.08, sheen: 0, normal: 1.2, metal: 0.2, opacity: 0.94, rim: 0.18, rimPower: -0.6, emissive: 0.15 },
};

const HOT_ELEMENTS = new Set(["fire", "electric", "light"]);

/** How strongly a creature burns (fire primary 1, fire secondary its level, flame tail at least 0.6). */
export function fireAmount(ph: Phenotype, helix: MorphHelix): number {
  const p5 = helix.p5 ?? P5_DEFAULTS;
  let f = ph.elements.primary === "fire" ? 1 : ph.elements.secondary === "fire" ? clamp01(ph.elements.secondaryLevel) : 0;
  if (p5.body.tail.shape === "flame") f = Math.max(f, 0.6);
  return f;
}

/** The pass-5 materials (a superset of SkinMaterials). */
export interface SkinMaterialsP5 extends SkinMaterials {
  shared: SkinShared;
  p5: SkinP5;
  coat: CoatKind;
  /** 0..1 flame strength (fire wings / tail tips). */
  fire: number;
}

export interface SkinOptions {
  /** Paint textures even without a DOM (tests). Default: only when `document` exists. */
  textures?: boolean;
}

export function makeSkinMaterials(ph: Phenotype, helix: MorphHelix, seed: number, quality: "low" | "high", opts: SkinOptions = {}): SkinMaterialsP5 {
  const hi = quality === "high";
  const S = helix.surface;
  const p5 = (helix.p5 ?? P5_DEFAULTS).skin;
  const coat: CoatKind = p5.coat ?? "skin";
  const look = COAT_LOOK[coat] ?? COAT_LOOK.skin;
  const shared = newSkinShared(p5.celBands);
  const textures: THREE.Texture[] = [];
  let map: THREE.Texture | null = null, emissiveMap: THREE.Texture | null = null, normalMap: THREE.Texture | null = null;
  let bellyMap: THREE.Texture | null = null, bellyNormal: THREE.Texture | null = null;
  let skinRaster: Raster | null = null;
  const paint = opts.textures ?? typeof document !== "undefined";
  if (paint) {
    const size = hi ? 256 : 128;
    const sp = paintSkin(ph, p5, seed, size);
    skinRaster = sp.map;
    map = dataTexture(sp.map, true);
    textures.push(map);
    if (sp.emissive) {
      emissiveMap = dataTexture(sp.emissive, true);
      textures.push(emissiveMap);
    }
    normalMap = dataTexture(normalFromHeight(paintRelief(ph, S, coat, seed, size), 2.5), false);
    textures.push(normalMap);
    const bp = paintBelly(ph, p5, bellyStyle(ph, coat, S.plates, S.fur), seed, hi ? 128 : 64);
    bellyMap = dataTexture(bp.map, true);
    bellyNormal = dataTexture(normalFromHeight(bp.height, 2.2), false);
    textures.push(bellyMap, bellyNormal);
  }

  const metal = Math.max(0, ph.elements.affinity.metal ?? 0);
  let tr = clamp01(ph.translucency);
  const transparentBase = tr > 0.05;
  const hot = HOT_ELEMENTS.has(ph.elements.primary);
  const baseEmissive = clamp01(ph.glow) * 0.45 + (hot ? 0.06 : 0) + look.emissive;
  const bump = clamp01(S.bump);
  const sheenK = clamp01(S.sheen);
  const fur = Math.max(clamp01(S.fur), look.sheen > 0.9 ? 0.6 : 0);
  const rough = clamp(ph.roughness * (1 - 0.35 * sheenK) + 0.15 * fur + look.rough, 0.05, 1);
  const glowCol = new THREE.Color(ph.palette.glow);
  const baseCol = new THREE.Color(ph.palette.base);
  const white = new THREE.Color(0xffffff);
  const ns = (k: number) => new THREE.Vector2(1, 1).multiplyScalar((0.15 + 1.35 * bump) * k * look.normal);
  const opacity = (1 - tr * 0.55) * look.opacity;
  const transparent = transparentBase || opacity < 0.999;
  tr = Math.max(tr, 1 - look.opacity);
  const { belly: bellyRGB } = countershadeColors(ph, p5.bellyContrast);
  const bellyCol = new THREE.Color().setRGB(bellyRGB[0], bellyRGB[1], bellyRGB[2], THREE.SRGBColorSpace);
  // Slime / crystal: a faint self-glow in the body colour fakes translucency when there is no glow map.
  const selfGlow = look.emissive > 0 && !emissiveMap ? glowCol.clone().lerp(baseCol, coat === "slime" ? 0.7 : 0.3) : glowCol;

  const skinParams: THREE.MeshStandardMaterialParameters = {
    map,
    normalMap,
    normalScale: ns(1),
    roughness: rough,
    metalness: metal > 0.35 ? 0.55 : 0.04 + look.metal,
    emissive: selfGlow,
    emissiveMap,
    emissiveIntensity: emissiveMap ? 0.9 : baseEmissive,
    transparent,
    opacity,
    depthWrite: tr < 0.4,
  };
  const clear = Math.max(sheenK > 0.25 ? sheenK * 0.8 : 0, look.clear);
  const skin: Mat = hi
    ? new THREE.MeshPhysicalMaterial({
      ...skinParams,
      sheen: Math.max(fur, look.sheen),
      sheenRoughness: 0.75,
      sheenColor: baseCol.clone().lerp(white, 0.45),
      clearcoat: clear,
      clearcoatRoughness: look.clear > 0 ? look.clearRough : 0.4 - 0.3 * sheenK,
    })
    : new THREE.MeshStandardMaterial({ ...skinParams, roughness: look.clear > 0.5 ? Math.max(0.08, rough - 0.1) : rough });

  const accentParams: THREE.MeshStandardMaterialParameters = {
    color: ph.palette.accent,
    normalMap,
    normalScale: ns(0.6),
    roughness: Math.max(0.2, rough - 0.2),
    metalness: metal > 0.35 ? 0.7 : 0.1 + look.metal,
    emissive: glowCol,
    emissiveIntensity: baseEmissive * 0.6,
    transparent,
    opacity: (1 - tr * 0.4) * Math.max(look.opacity, 0.94),
    side: THREE.DoubleSide,
  };
  const accent: Mat = hi ? new THREE.MeshPhysicalMaterial({ ...accentParams, clearcoat: Math.max(sheenK * 0.6, look.clear * 0.7), clearcoatRoughness: 0.3 }) : new THREE.MeshStandardMaterial(accentParams);

  const bellyParams: THREE.MeshStandardMaterialParameters = {
    color: bellyMap ? 0xffffff : bellyCol,
    map: bellyMap,
    normalMap: bellyNormal ?? normalMap,
    normalScale: ns(bellyNormal ? 0.7 : 0.4),
    roughness: Math.max(0.35, Math.min(0.92, rough + 0.12)),
    transparent,
    opacity: (1 - tr * 0.5) * Math.max(look.opacity, 0.92),
  };
  const belly: Mat = hi && look.clear > 0.5 ? new THREE.MeshPhysicalMaterial({ ...bellyParams, clearcoat: look.clear * 0.6, clearcoatRoughness: 0.2 }) : new THREE.MeshStandardMaterial(bellyParams);

  const keratinCol = new THREE.Color(0xf2ead8).lerp(new THREE.Color(ph.palette.accent), 0.08);
  const keratin: Mat = hi
    ? new THREE.MeshPhysicalMaterial({ color: keratinCol, roughness: 0.3, clearcoat: 0.5, clearcoatRoughness: 0.25 })
    : new THREE.MeshStandardMaterial({ color: keratinCol, roughness: 0.32 });

  const fire = fireAmount(ph, helix);
  const memCol = new THREE.Color(ph.palette.accent).lerp(baseCol, 0.2);
  const membraneParams: THREE.MeshStandardMaterialParameters = {
    color: memCol,
    roughness: 0.55,
    emissive: glowCol,
    emissiveIntensity: baseEmissive * 0.5,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: clamp(0.82 - 0.3 * tr, 0.35, 0.9),
    depthWrite: false,
  };
  const membrane: Mat = hi ? new THREE.MeshPhysicalMaterial({ ...membraneParams, sheen: 0.35, sheenRoughness: 0.6, sheenColor: memCol.clone().lerp(white, 0.5) }) : new THREE.MeshStandardMaterial(membraneParams);

  // Fresnel rim tinted toward the element glow; fur widens and softens it; the coat adds its own sheen.
  const rimCol = baseCol.clone().lerp(white, 0.5).lerp(glowCol, 0.35 + 0.5 * clamp01(ph.glow));
  const rimStrength = 0.1 + 0.22 * fur + 0.25 * clamp01(ph.glow) + look.rim;
  const rimPower = Math.max(1.2, 3.2 - 1.4 * fur + look.rimPower);
  const bc = clamp01(p5.bellyContrast);
  const flameColor = new THREE.Color(0xff5a1f).lerp(glowCol, 0.25);
  const flameCore = new THREE.Color(0xffd166);
  const std = { cel: true, shade: true, flame: false, shell: false };
  installSkinShader(skin, shared, matUniforms({ rimColor: rimCol, rim: rimStrength, rimPower, shade: 0.35 + 0.65 * bc, belly: bellyCol }), std);
  installSkinShader(accent, shared, matUniforms({ rimColor: rimCol, rim: rimStrength * 0.8, rimPower, shade: 0.5 * bc, belly: bellyCol, flame: fire * 0.35, flameColor, flameCore }), { ...std, flame: fire > 0.05 });
  installSkinShader(belly, shared, matUniforms({ rimColor: rimCol, rim: rimStrength * 0.5, rimPower: rimPower + 0.5, shade: 0.3 * bc, belly: bellyCol }), std);
  installSkinShader(keratin, shared, matUniforms({ rimColor: rimCol, rim: 0.05, rimPower: 3, shade: 0.15 }), std);
  installSkinShader(membrane, shared, matUniforms({ rimColor: glowCol.clone().lerp(memCol, 0.4), rim: rimStrength * 0.8, rimPower: 2.2, shade: 0.3 * bc, belly: bellyCol, flame: fire, flameColor, flameCore }), { ...std, flame: fire > 0.05 });
  if (fire > 0.05) membrane.emissive.copy(flameColor);
  for (const m of [skin, accent, belly, keratin, membrane]) {
    BASE.set(m, { rough: m.roughness, clear: (m as THREE.MeshPhysicalMaterial).clearcoat ?? 0, sheen: (m as THREE.MeshPhysicalMaterial).sheen ?? 0 });
  }
  if (skinRaster) RASTERS.set(skin, skinRaster);

  return { skin, accent, belly, keratin, membrane, textures, baseEmissive, shared, p5, coat, fire };
}

// ====================================================================== per-frame + age

/** Per-frame: advances the flame / shimmer time of every material of the creature. */
export function tickSkin(mats: SkinMaterials, t: number): void {
  const st = STATE.get(mats.skin);
  if (st) st.shared.time.value = t;
}

/** 0 for egg .. adult, 0.55 elder, 1 ancient (a number is clamped to 0..1). */
export function ageAmount(phase: LifePhase | number): number {
  if (typeof phase === "number") return clamp01(phase);
  return phase === "ancient" ? 1 : phase === "elder" ? 0.55 : 0;
}

/**
 * Elders: greys / desaturates the coat (shader uniform, every material of the creature incl. scar
 * copies) and roughens it (less clearcoat and sheen). Idempotent; returns the age amount applied.
 */
export function ageTint(mats: SkinMaterials, phase: LifePhase | number): number {
  const a = ageAmount(phase);
  const st = STATE.get(mats.skin);
  if (st) st.shared.age.value = a;
  for (const m of [mats.skin, mats.accent, mats.belly, mats.membrane]) {
    const b = BASE.get(m);
    if (!b) continue;
    m.roughness = clamp(b.rough + 0.2 * a, 0, 1);
    if ((m as THREE.MeshPhysicalMaterial).isMeshPhysicalMaterial) {
      const p = m as THREE.MeshPhysicalMaterial;
      p.clearcoat = b.clear * (1 - 0.6 * a);
      p.sheen = b.sheen * (1 - 0.4 * a);
    }
  }
  return a;
}

// ====================================================================== scars [P5-V8]

export interface ScarPlacement {
  joint: number;
  stroke: ScarStroke;
  severity: number;
}

const TORSO_ROLES = new Set(["root", "spine", "chest", "segment"]);
const LIMB_UP = new Set(["hip", "shoulder"]);
const LIMB_LOW = new Set(["knee", "elbow"]);

function hash(n: number): number {
  let x = (n | 0) ^ 0x9e3779b9;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

/** Pure: which joint carries each scar and where it sits in that joint's UV square. */
export function scarPlacement(scars: readonly Scar[], sk: Skeleton): ScarPlacement[] {
  const out: ScarPlacement[] = [];
  const idx = (pred: (r: string, i: number) => boolean) => sk.joints.map((j, i) => (pred(j.role, i) ? i : -1)).filter((i) => i >= 0);
  const torso = idx((r) => TORSO_ROLES.has(r));
  scars.forEach((sc, n) => {
    const part = String(sc.part ?? "torso");
    const u = clamp01(sc.u ?? 0.5);
    let list: number[] = [];
    let local = u;
    if (part.startsWith("head")) list = idx((r) => r === "head");
    else if (part.startsWith("neck")) list = idx((r) => r === "neck");
    else if (part.startsWith("tail")) list = idx((r) => r === "tail");
    else if (part.startsWith("wing")) list = idx((r) => r === "wingRoot" || r === "wingMid");
    else if (part.startsWith("limb") || part.startsWith("leg") || part.startsWith("arm")) {
      const sided = sk.joints.map((j, i) => ({ j, i })).filter(({ j }) => LIMB_UP.has(j.role) && (j.side === sc.side || j.side === 0));
      const ups = sided.length ? sided : sk.joints.map((j, i) => ({ j, i })).filter(({ j }) => LIMB_UP.has(j.role));
      if (ups.length) {
        const digits = Number((part.match(/\d+/) ?? ["0"])[0]);
        const up = ups[digits % ups.length];
        const low = sk.joints.findIndex((j) => LIMB_LOW.has(j.role) && j.parent === up.i);
        list = u < 0.5 || low < 0 ? [up.i] : [low];
        local = u < 0.5 || low < 0 ? clamp01(u * 2) : clamp01(u * 2 - 1);
      }
    }
    if (list.length === 0) list = torso.length ? torso : [0];
    if (!part.startsWith("limb") && !part.startsWith("leg") && !part.startsWith("arm")) {
      const k = Math.min(list.length - 1, Math.floor(u * list.length));
      local = list.length > 1 ? clamp01(u * list.length - k) : u;
      list = [list[k]];
    }
    const sev = clamp01(sc.severity ?? 0.5);
    const seed = Math.floor((sc.atDay ?? 0) * 997 + n * 7919 + (sc.angle ?? 0) * 1000);
    const side = sc.side === -1 ? -1 : 1;
    const ut = (((0.25 + (side * (sc.angle ?? 0)) / (2 * Math.PI)) % 1) + 1) % 1;
    out.push({
      joint: list[0],
      severity: sev,
      stroke: {
        u: ut,
        v: clamp(local, 0.12, 0.88),
        dir: Math.PI * (0.15 + 0.7 * hash(seed)),
        length: 0.16 + 0.3 * sev,
        width: 0.01 + 0.018 * sev,
        kind: scarKindOf(String(sc.from ?? "physical"), sev),
        seed,
      },
    });
  });
  return out;
}

export interface ScarSet {
  /** Joint index -> its scarred copy of the skin material (assign with `swapMaterial`). */
  byJoint: Map<number, Mat>;
  placements: ScarPlacement[];
  materials: Mat[];
  textures: THREE.Texture[];
  /** Copies the live state (colour tint, emissive, opacity, roughness) of the skin onto the copies. */
  sync(): void;
  dispose(): void;
}

/**
 * Paints scar decals (pale tissue, darker edges; burns, frost, bolts, acid by the element that made
 * them) into per-joint COPIES of the skin colour texture, so a scar sits on its own body part instead
 * of repeating on every loft that shares the texture. Copies share the creature's shader uniforms.
 * Without a painted skin texture (headless) only `placements` is filled.
 */
export function applyScars(mats: SkinMaterials, scars: readonly Scar[], sk: Skeleton, maxJoints = 6): ScarSet {
  const placements = scarPlacement(scars, sk);
  const byJoint = new Map<number, Mat>();
  const materials: Mat[] = [];
  const textures: THREE.Texture[] = [];
  const base = RASTERS.get(mats.skin);
  if (base && placements.length) {
    const groups = new Map<number, ScarPlacement[]>();
    for (const p of placements) groups.set(p.joint, [...(groups.get(p.joint) ?? []), p]);
    const ranked = [...groups.entries()].sort((a, b) => b[1].reduce((s, p) => s + p.severity, 0) - a[1].reduce((s, p) => s + p.severity, 0)).slice(0, maxJoints);
    const baseRGB = rgbOf(0);
    for (const [joint, ps] of ranked) {
      const r = base.clone();
      for (const p of ps) {
        const i = r.at(p.stroke.u * r.w, p.stroke.v * r.h);
        baseRGB[0] = r.data[i];
        baseRGB[1] = r.data[i + 1];
        baseRGB[2] = r.data[i + 2];
        paintScar(r, p.stroke, [baseRGB[0], baseRGB[1], baseRGB[2]]);
      }
      const tex = dataTexture(r, true);
      const m = mats.skin.clone() as Mat;
      m.map = tex;
      shareSkinShader(mats.skin, m);
      BASE.set(m, BASE.get(mats.skin) ?? { rough: m.roughness, clear: 0, sheen: 0 });
      m.userData.scarred = true;
      byJoint.set(joint, m);
      materials.push(m);
      textures.push(tex);
    }
  }
  const sync = () => {
    const s = mats.skin;
    for (const m of materials) {
      m.color.copy(s.color);
      m.emissive.copy(s.emissive);
      m.emissiveIntensity = s.emissiveIntensity;
      m.opacity = s.opacity;
      m.transparent = s.transparent;
      m.roughness = s.roughness;
      if ((m as THREE.MeshPhysicalMaterial).isMeshPhysicalMaterial && (s as THREE.MeshPhysicalMaterial).isMeshPhysicalMaterial) {
        (m as THREE.MeshPhysicalMaterial).clearcoat = (s as THREE.MeshPhysicalMaterial).clearcoat;
        (m as THREE.MeshPhysicalMaterial).sheen = (s as THREE.MeshPhysicalMaterial).sheen;
      }
    }
  };
  return {
    byJoint,
    placements,
    materials,
    textures,
    sync,
    dispose: () => {
      for (const m of materials) m.dispose();
      for (const t of textures) t.dispose();
    },
  };
}

/**
 * Replaces material `from` by `to` on `root` and its descendants (inside material arrays too), without
 * descending into objects for which `stop` returns true (child joints). Returns the slots replaced.
 */
export function swapMaterial(root: THREE.Object3D, from: THREE.Material, to: THREE.Material, stop?: (o: THREE.Object3D) => boolean): number {
  let n = 0;
  const visit = (o: THREE.Object3D) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      if (Array.isArray(m.material)) {
        m.material = m.material.map((x) => {
          if (x === from) {
            n++;
            return to;
          }
          return x;
        });
      } else if (m.material === from) {
        m.material = to;
        n++;
      }
    }
    for (const c of o.children) if (!stop || !stop(c)) visit(c);
  };
  visit(root);
  return n;
}

// ====================================================================== ink outline (inverted hull)

const A_PROJECT_V = "#include <project_vertex>";
const GLSL_OUTLINE_DECL = "uniform float gmOutlineW;\nuniform float gmOutlineS;";
const GLSL_OUTLINE = `
vec4 mvPosition = modelViewMatrix * vec4( transformed, 1.0 );
vec3 gmN = normalize( normalMatrix * normal );
mvPosition.xyz += gmN * ( gmOutlineW + gmOutlineS * max( - mvPosition.z, 0.0 ) );
gl_Position = projectionMatrix * mvPosition;`;

/**
 * One ink material per creature: back faces pushed out along the view-space normal by a world width
 * (scaled by the creature height and SkinP5.outline) plus a distance term so far creatures keep a line.
 * Null when the gene asks for no outline. `userData.outline` = { width, screen } uniforms.
 */
export function makeOutlineMaterial(ph: Phenotype, p5: SkinP5, height: number): THREE.MeshBasicMaterial | null {
  const k = clamp01(p5.outline);
  if (k < 0.05) return null;
  const ink = new THREE.Color(ph.palette.base).multiplyScalar(0.12).lerp(new THREE.Color(0x0d0f16), 0.6);
  const mat = new THREE.MeshBasicMaterial({ color: ink, side: THREE.BackSide });
  const width = { value: Math.max(0.05, height) * (0.003 + 0.009 * k) };
  const screen = { value: 0.0018 * k };
  mat.userData.outline = { width, screen };
  mat.onBeforeCompile = (shader) => {
    const vs = shader.vertexShader;
    if (!vs.includes(A_COMMON) || !vs.includes(A_PROJECT_V)) return;
    shader.uniforms.gmOutlineW = width;
    shader.uniforms.gmOutlineS = screen;
    shader.vertexShader = vs.replace(A_COMMON, `${A_COMMON}\n${GLSL_OUTLINE_DECL}`).replace(A_PROJECT_V, GLSL_OUTLINE);
  };
  mat.customProgramCacheKey = () => "gm-outline-v1";
  return mat;
}

const triOf = (g: THREE.BufferGeometry) => Math.round((g.index ? g.index.count : g.attributes.position?.count ?? 0) / 3);

/**
 * Adds an inverted-hull child (shared geometry, the ink material) to the LARGEST opaque meshes under
 * `roots` until `budget` triangles are spent. Skips see-through (opacity < 0.9, no depth write) / coat / outline
 * meshes, `userData.noOutline`, any mesh using a `skip` material (pass the keratin: a hull around thin
 * claws / teeth reads as a black blob) and meshes smaller than ~5 outline widths (catchlights, digits).
 */
export function addOutlines(roots: THREE.Object3D[], mat: THREE.MeshBasicMaterial, budget: number, skip: THREE.Material[] = []): { meshes: THREE.Mesh[]; triangles: number } {
  const w = (mat.userData.outline as { width: U<number> } | undefined)?.width.value ?? 0.01;
  const cands: { m: THREE.Mesh; tris: number }[] = [];
  const seen = new Set<THREE.Object3D>();
  for (const root of roots) {
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || seen.has(m) || m.userData.outline || m.userData.coat || m.userData.noOutline) return;
      seen.add(m);
      const ms = Array.isArray(m.material) ? m.material : [m.material];
      if (ms.some((x) => skip.includes(x) || (x.transparent && x.opacity < 0.9) || !x.depthWrite || (x as THREE.MeshBasicMaterial).isMeshBasicMaterial || x.side === THREE.BackSide)) return;
      const g = m.geometry;
      if (!g.attributes.normal) return;
      if (!g.boundingSphere) g.computeBoundingSphere();
      const s = Math.max(Math.abs(m.scale.x), Math.abs(m.scale.y), Math.abs(m.scale.z));
      if ((g.boundingSphere?.radius ?? 0) * s < 5 * w) return;
      cands.push({ m, tris: triOf(g) });
    });
  }
  cands.sort((a, b) => b.tris - a.tris);
  const meshes: THREE.Mesh[] = [];
  let spent = 0;
  for (const c of cands) {
    if (spent + c.tris > budget) continue;
    const hull = new THREE.Mesh(c.m.geometry, mat);
    hull.userData.outline = true;
    hull.castShadow = false;
    hull.receiveShadow = false;
    c.m.add(hull);
    meshes.push(hull);
    spent += c.tris;
  }
  return { meshes, triangles: spent };
}
