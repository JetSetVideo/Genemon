/**
 * Skin materials (pass 4, lane face): physical materials for one creature, driven by the phenotype and
 * the helix surface genes.
 *
 *  - skin: colour map (skinTextures) + a NORMAL map generated from a height canvas that matches the
 *    pattern (scales / plates -> raised tiles with grooves sized by surface.plates; spots / mottle -> soft
 *    bumps; stripes / rings -> ridges; veins -> raised veins; fur -> fine directional noise), normalScale
 *    from surface.bump, roughness from ph.roughness, sheen (fur) and clearcoat (wet / chitin via
 *    surface.sheen) on the high tier, metalness from metal affinity, opacity for gas / void bodies,
 *    emissive glow for fire / electric / light, and a fresnel RIM tinted toward the element glow.
 *  - accent, belly, keratin (ivory, low roughness), membrane (double-sided, translucent, accent hue).
 *
 * The rim is injected with onBeforeCompile by string replacement on the standard / physical fragment
 * shader; when an anchor is missing the hook is a no-op (never a compile error). Its uniforms are exposed
 * on `material.userData.rim` = { color, strength, power } (each a { value } uniform) so the view can
 * raise the rim while charging.
 *
 * Headless (no `document`, Deno tests): no canvas work at all; materials come back without maps.
 */
import * as THREE from "../../lib/three.ts";
import { Rng } from "../../core/rng.ts";
import type { MorphHelix } from "../../genome/morphTypes.ts";
import type { Phenotype } from "../../genome/phenotype.ts";
import { skinTextures } from "../textures.ts";
import type { SkinMaterials } from "./types.ts";

type Mat = THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial;
const clamp = (x: number, lo: number, hi: number) => (Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : lo);
const grey = (v: number, a = 1) => `rgba(${v | 0},${v | 0},${v | 0},${a})`;

// ------------------------------------------------------------------ height + normal maps (browser only)

function heightCanvas(ph: Phenotype, helix: MorphHelix, seed: number, size: number): HTMLCanvasElement {
  const rng = new Rng((seed ^ 0x51ed27) >>> 0);
  const S = helix.surface;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d")!;
  g.fillStyle = grey(128);
  g.fillRect(0, 0, size, size);
  const ps = clamp(S.patternScale, 0.5, 2);
  const plates = clamp(S.plates, 0, 1);
  const contrast = 0.5 + 0.5 * clamp(S.patternContrast, 0, 1);
  const blob = (x: number, y: number, rad: number, v: number, a: number) => {
    const gr = g.createRadialGradient(x, y, 0, x, y, rad);
    gr.addColorStop(0, grey(v, a));
    gr.addColorStop(1, grey(v, 0));
    g.fillStyle = gr;
    g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  };
  // Low-frequency undulation so even smooth skins are not plastic.
  for (let i = 0; i < 10; i++) blob(rng.next() * size, rng.next() * size, size * (0.1 + rng.next() * 0.15), rng.next() < 0.5 ? 90 : 170, 0.35);

  if (ph.pattern === "scales" || plates > 0.3) {
    // Raised tiles separated by grooves. Scales follow the colour map's grid (size / 12).
    const per = ph.pattern === "scales" && plates <= 0.3 ? 12 : Math.max(3, Math.round((18 - 13 * plates) / ps));
    const s = size / per;
    if (ph.pattern === "scales") {
      for (let row = 0, y = 0; y < size + s; row++, y += s * 0.75) {
        for (let x = row % 2 ? s / 2 : 0; x < size + s; x += s) {
          const gr = g.createRadialGradient(x, y + s * 0.08, 0, x, y, s * 0.55);
          gr.addColorStop(0, grey(128 + 90 * contrast));
          gr.addColorStop(0.75, grey(140));
          gr.addColorStop(1, grey(128 - 80 * contrast));
          g.fillStyle = gr;
          g.beginPath();
          g.arc(x, y, s / 2, 0, Math.PI);
          g.fill();
        }
      }
    } else {
      const groove = Math.max(1, s * (0.05 + 0.06 * plates));
      for (let row = 0; row < per; row++) {
        const off = row % 2 ? s / 2 : 0;
        for (let col = -1; col <= per; col++) {
          const x = col * s + off, y = row * s;
          const gr = g.createLinearGradient(x, y, x + s, y + s);
          gr.addColorStop(0, grey(128 + 80 * contrast));
          gr.addColorStop(1, grey(128 + 20 * contrast));
          g.fillStyle = gr;
          g.fillRect(x + groove, y + groove, s - 2 * groove, s - 2 * groove);
        }
      }
      g.strokeStyle = grey(128 - 90 * contrast);
      g.lineWidth = groove;
      for (let row = 0; row <= per; row++) {
        g.beginPath();
        g.moveTo(0, row * s);
        g.lineTo(size, row * s);
        g.stroke();
      }
    }
  } else {
    switch (ph.pattern) {
      case "spots":
      case "mottle": {
        const nb = Math.round((ph.pattern === "spots" ? 30 : 60) / ps);
        for (let i = 0; i < nb; i++) blob(rng.next() * size, rng.next() * size, size * (0.025 + rng.next() * 0.06) * ps, 128 + 100 * contrast, 0.8);
        break;
      }
      case "stripes":
      case "rings": {
        const order = (ph.axes.structure + 1) / 2;
        const n = ph.pattern === "stripes" ? 4 + Math.round(order * 6) : 6;
        const w = size / (n * 2.2);
        for (let i = 0; i < n; i++) {
          const y = ph.pattern === "stripes" ? ((i + 0.5) / n) * size : (i / 6) * size + size / 44;
          const gr = g.createLinearGradient(0, y - w, 0, y + w);
          gr.addColorStop(0, grey(128, 0));
          gr.addColorStop(0.5, grey(128 + 95 * contrast));
          gr.addColorStop(1, grey(128, 0));
          g.fillStyle = gr;
          g.fillRect(0, y - w, size, 2 * w);
        }
        break;
      }
      case "veins": {
        g.strokeStyle = grey(128 + 90 * contrast);
        g.lineWidth = Math.max(1.5, size / 110);
        for (let k = 0; k < 9; k++) {
          let x = rng.next() * size, y = rng.next() * size;
          g.beginPath();
          g.moveTo(x, y);
          for (let s = 0; s < 14; s++) {
            x += (rng.next() - 0.5) * 34;
            y += (rng.next() - 0.3) * 22;
            g.lineTo(x, y);
          }
          g.stroke();
        }
        break;
      }
      default:
        break;
    }
  }
  const fur = clamp(S.fur, 0, 1);
  if (fur > 0.3) {
    // Fine directional strands.
    g.lineWidth = 1;
    const strands = Math.round(size * size * 0.05 * fur);
    for (let i = 0; i < strands; i++) {
      const x = rng.next() * size, y = rng.next() * size, l = 2 + rng.next() * 4;
      g.strokeStyle = grey(rng.next() < 0.5 ? 70 : 190, 0.35);
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + (rng.next() - 0.5) * 1.5, y + l);
      g.stroke();
    }
  }
  for (let i = 0; i < size * 5; i++) {
    g.fillStyle = grey(rng.next() < 0.5 ? 100 : 156, 0.5);
    g.fillRect(rng.next() * size, rng.next() * size, 1.5, 1.5);
  }
  return c;
}

/** Sobel tangent-space normal map (OpenGL convention, +Y up, CanvasTexture flipY on). */
function normalFromHeight(src: HTMLCanvasElement, strength: number): HTMLCanvasElement {
  const size = src.width;
  const d = src.getContext("2d")!.getImageData(0, 0, size, size).data;
  const h = (x: number, y: number) => d[((((y + size) % size) * size) + ((x + size) % size)) * 4] / 255;
  const out = document.createElement("canvas");
  out.width = out.height = size;
  const og = out.getContext("2d")!;
  const img = og.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (h(x + 1, y - 1) + 2 * h(x + 1, y) + h(x + 1, y + 1)) - (h(x - 1, y - 1) + 2 * h(x - 1, y) + h(x - 1, y + 1));
      const dy = (h(x - 1, y + 1) + 2 * h(x, y + 1) + h(x + 1, y + 1)) - (h(x - 1, y - 1) + 2 * h(x, y - 1) + h(x + 1, y - 1));
      let nx = -dx * strength, ny = dy * strength, nz = 1;
      const l = Math.hypot(nx, ny, nz);
      nx /= l;
      ny /= l;
      nz /= l;
      const i = (y * size + x) * 4;
      img.data[i] = (nx * 0.5 + 0.5) * 255;
      img.data[i + 1] = (ny * 0.5 + 0.5) * 255;
      img.data[i + 2] = (nz * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  og.putImageData(img, 0, 0);
  return out;
}

// ------------------------------------------------------------------ rim (fresnel) injection

const RIM_DECL = "#include <common>";
const RIM_AT = "#include <emissivemap_fragment>";

/** Adds a fresnel rim to the material's emissive radiance. A failed replace leaves the shader untouched. */
function addRim(mat: Mat, color: THREE.Color, strength: number, power: number): void {
  const rim = { color: { value: color.clone() }, strength: { value: strength }, power: { value: power } };
  mat.userData.rim = rim;
  mat.onBeforeCompile = (shader) => {
    const fs = shader.fragmentShader;
    if (!fs.includes(RIM_DECL) || !fs.includes(RIM_AT) || !fs.includes("vViewPosition")) return;
    shader.uniforms.gmRimColor = rim.color;
    shader.uniforms.gmRimStrength = rim.strength;
    shader.uniforms.gmRimPower = rim.power;
    shader.fragmentShader = fs
      .replace(RIM_DECL, `${RIM_DECL}\nuniform vec3 gmRimColor;\nuniform float gmRimStrength;\nuniform float gmRimPower;`)
      .replace(
        RIM_AT,
        `${RIM_AT}\n{ float gmF = 1.0 - saturate( dot( normal, normalize( vViewPosition ) ) );\n  totalEmissiveRadiance += gmRimColor * gmRimStrength * pow( gmF, gmRimPower ); }`,
      );
  };
  mat.customProgramCacheKey = () => "genemon-rim-v1";
}

// ------------------------------------------------------------------ materials

const HOT_ELEMENTS = new Set(["fire", "electric", "light"]);

export function makeSkinMaterials(ph: Phenotype, helix: MorphHelix, seed: number, quality: "low" | "high"): SkinMaterials {
  const hi = quality === "high";
  const S = helix.surface;
  const textures: THREE.Texture[] = [];
  let map: THREE.Texture | null = null, emissiveMap: THREE.Texture | null = null, normalMap: THREE.Texture | null = null;
  if (typeof document !== "undefined") {
    const size = hi ? 256 : 128;
    const t = skinTextures(ph, seed, size);
    map = t.map;
    emissiveMap = t.emissive;
    textures.push(t.map);
    if (t.emissive) textures.push(t.emissive);
    const nm = new THREE.CanvasTexture(normalFromHeight(heightCanvas(ph, helix, seed, size), 2.5));
    nm.colorSpace = THREE.NoColorSpace;
    nm.wrapS = nm.wrapT = THREE.RepeatWrapping;
    normalMap = nm;
    textures.push(nm);
  }

  const metal = Math.max(0, ph.elements.affinity.metal ?? 0);
  const tr = clamp(ph.translucency, 0, 1);
  const transparent = tr > 0.05;
  const hot = HOT_ELEMENTS.has(ph.elements.primary);
  const baseEmissive = clamp(ph.glow, 0, 1) * 0.45 + (hot ? 0.06 : 0);
  const bump = clamp(S.bump, 0, 1);
  const sheenK = clamp(S.sheen, 0, 1);
  const fur = clamp(S.fur, 0, 1);
  const rough = clamp(ph.roughness * (1 - 0.35 * sheenK) + 0.15 * fur, 0.05, 1);
  const glowCol = new THREE.Color(ph.palette.glow);
  const baseCol = new THREE.Color(ph.palette.base);
  const white = new THREE.Color(0xffffff);
  const ns = (k: number) => new THREE.Vector2(1, 1).multiplyScalar((0.15 + 1.35 * bump) * k);

  const skinParams: THREE.MeshStandardMaterialParameters = {
    map,
    normalMap,
    normalScale: ns(1),
    roughness: rough,
    metalness: metal > 0.35 ? 0.55 : 0.04,
    emissive: glowCol,
    emissiveMap,
    emissiveIntensity: emissiveMap ? 0.9 : baseEmissive,
    transparent,
    opacity: 1 - tr * 0.55,
    depthWrite: tr < 0.4,
  };
  const skin: Mat = hi
    ? new THREE.MeshPhysicalMaterial({
      ...skinParams,
      sheen: fur,
      sheenRoughness: 0.75,
      sheenColor: baseCol.clone().lerp(white, 0.45),
      clearcoat: sheenK > 0.25 ? sheenK * 0.8 : 0,
      clearcoatRoughness: 0.4 - 0.3 * sheenK,
    })
    : new THREE.MeshStandardMaterial(skinParams);

  const accentParams: THREE.MeshStandardMaterialParameters = {
    color: ph.palette.accent,
    normalMap,
    normalScale: ns(0.6),
    roughness: Math.max(0.2, rough - 0.2),
    metalness: metal > 0.35 ? 0.7 : 0.1,
    emissive: glowCol,
    emissiveIntensity: baseEmissive * 0.6,
    transparent,
    opacity: 1 - tr * 0.4,
    side: THREE.DoubleSide,
  };
  const accent: Mat = hi ? new THREE.MeshPhysicalMaterial({ ...accentParams, clearcoat: sheenK * 0.6, clearcoatRoughness: 0.3 }) : new THREE.MeshStandardMaterial(accentParams);

  const belly: Mat = new THREE.MeshStandardMaterial({
    color: ph.palette.belly,
    normalMap,
    normalScale: ns(0.4),
    roughness: Math.max(0.5, Math.min(0.9, rough + 0.15)),
    transparent,
    opacity: 1 - tr * 0.5,
  });

  const keratinCol = new THREE.Color(0xf2ead8).lerp(new THREE.Color(ph.palette.accent), 0.08);
  const keratin: Mat = hi
    ? new THREE.MeshPhysicalMaterial({ color: keratinCol, roughness: 0.3, clearcoat: 0.5, clearcoatRoughness: 0.25 })
    : new THREE.MeshStandardMaterial({ color: keratinCol, roughness: 0.32 });

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

  // Fresnel rim tinted toward the element glow; fur widens and softens it.
  const rimCol = baseCol.clone().lerp(white, 0.5).lerp(glowCol, 0.35 + 0.5 * clamp(ph.glow, 0, 1));
  const rimStrength = 0.1 + 0.22 * fur + 0.25 * clamp(ph.glow, 0, 1);
  const rimPower = 3.2 - 1.4 * fur;
  addRim(skin, rimCol, rimStrength, rimPower);
  addRim(accent, rimCol, rimStrength * 0.8, rimPower);
  addRim(belly, rimCol, rimStrength * 0.5, rimPower + 0.5);
  addRim(membrane, glowCol.clone().lerp(memCol, 0.4), rimStrength * 0.8, 2.2);

  return { skin, accent, belly, keratin, membrane, textures, baseEmissive };
}
