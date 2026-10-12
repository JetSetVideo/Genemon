/**
 * Procedural skin textures (browser only): base colour, belly gradient and the genome's PATTERN
 * (stripes, spots, mottle, rings, scales, gradient, veins) painted on a canvas. Veins also produce
 * an emissive map so glowing Genemon read in the dark.
 */
import * as THREE from "../lib/three.ts";
import { Rng } from "../core/rng.ts";
import type { Phenotype } from "../genome/phenotype.ts";

const hex = (c: number) => `#${c.toString(16).padStart(6, "0")}`;

export interface SkinTextures {
  map: THREE.CanvasTexture;
  emissive: THREE.CanvasTexture | null;
}

export function skinTextures(ph: Phenotype, seed: number, size = 256): SkinTextures {
  const rng = new Rng(seed);
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d")!;
  const { base, accent, belly } = ph.palette;
  const grad = g.createLinearGradient(0, 0, 0, size);
  grad.addColorStop(0, hex(base));
  grad.addColorStop(0.7, hex(base));
  grad.addColorStop(1, hex(belly));
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  // Fine grain so even "solid" skins are not flat plastic.
  for (let i = 0; i < 900; i++) {
    g.fillStyle = `rgba(${rng.next() < 0.5 ? "0,0,0" : "255,255,255"},${0.03 + rng.next() * 0.04})`;
    g.fillRect(rng.next() * size, rng.next() * size, 2, 2);
  }
  g.fillStyle = hex(accent);
  g.strokeStyle = hex(accent);
  const order = (ph.axes.structure + 1) / 2;
  let emissive: THREE.CanvasTexture | null = null;
  switch (ph.pattern) {
    case "stripes": {
      const n = 4 + Math.round(order * 6);
      for (let i = 0; i < n; i++) {
        const y = ((i + 0.5) / n) * size;
        g.lineWidth = size / (n * 2.6);
        g.beginPath();
        for (let x = 0; x <= size; x += 8) g.lineTo(x, y + Math.sin(x / size * Math.PI * 4 + i) * size * 0.03 * (1 - order));
        g.stroke();
      }
      break;
    }
    case "spots": {
      for (let i = 0; i < 26; i++) {
        g.beginPath();
        g.arc(rng.next() * size, rng.next() * size * 0.75, size * (0.02 + rng.next() * 0.05), 0, Math.PI * 2);
        g.fill();
      }
      break;
    }
    case "mottle": {
      g.globalAlpha = 0.45;
      for (let i = 0; i < 60; i++) {
        g.beginPath();
        g.ellipse(rng.next() * size, rng.next() * size, size * (0.03 + rng.next() * 0.08), size * (0.02 + rng.next() * 0.05), rng.next() * 3, 0, Math.PI * 2);
        g.fill();
      }
      g.globalAlpha = 1;
      break;
    }
    case "rings": {
      for (let i = 0; i < 6; i++) {
        g.fillRect(0, (i / 6) * size, size, size / 22);
      }
      break;
    }
    case "scales": {
      const s = size / 12;
      g.globalAlpha = 0.5;
      g.lineWidth = 1.5;
      for (let y = 0; y < size; y += s * 0.75) {
        for (let x = (y / (s * 0.75)) % 2 ? s / 2 : 0; x < size + s; x += s) {
          g.beginPath();
          g.arc(x, y, s / 2, 0, Math.PI);
          g.stroke();
        }
      }
      g.globalAlpha = 1;
      break;
    }
    case "gradient": {
      const gr = g.createLinearGradient(0, 0, size, size);
      gr.addColorStop(0, "rgba(0,0,0,0)");
      gr.addColorStop(1, hex(accent));
      g.fillStyle = gr;
      g.globalAlpha = 0.7;
      g.fillRect(0, 0, size, size);
      g.globalAlpha = 1;
      break;
    }
    case "veins": {
      const e = document.createElement("canvas");
      e.width = e.height = size;
      const eg = e.getContext("2d")!;
      eg.fillStyle = "#000";
      eg.fillRect(0, 0, size, size);
      eg.strokeStyle = hex(ph.palette.glow);
      g.lineWidth = eg.lineWidth = 2;
      for (let k = 0; k < 9; k++) {
        let x = rng.next() * size, y = rng.next() * size;
        g.beginPath();
        eg.beginPath();
        g.moveTo(x, y);
        eg.moveTo(x, y);
        for (let s = 0; s < 14; s++) {
          x += (rng.next() - 0.5) * 34;
          y += (rng.next() - 0.3) * 22;
          g.lineTo(x, y);
          eg.lineTo(x, y);
        }
        g.stroke();
        eg.stroke();
      }
      emissive = new THREE.CanvasTexture(e);
      emissive.colorSpace = THREE.SRGBColorSpace;
      emissive.wrapS = emissive.wrapT = THREE.RepeatWrapping;
      break;
    }
    case "solid":
      break;
  }
  const map = new THREE.CanvasTexture(c);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.anisotropy = 4;
  return { map, emissive };
}

/** Soft round sprite texture used by particles and glows. */
export function softDot(size = 64): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d")!;
  const r = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  r.addColorStop(0, "rgba(255,255,255,1)");
  r.addColorStop(0.4, "rgba(255,255,255,0.6)");
  r.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = r;
  g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  return t;
}

/** Text label sprite (axis names in Genospace, floating names). */
export function textSprite(text: string, color = "#ffffff", px = 28): THREE.Sprite {
  const c = document.createElement("canvas");
  const g = c.getContext("2d")!;
  g.font = `600 ${px}px system-ui, sans-serif`;
  const w = Math.ceil(g.measureText(text).width) + 16;
  c.width = w;
  c.height = px + 16;
  g.font = `600 ${px}px system-ui, sans-serif`;
  g.fillStyle = "rgba(0,0,0,0.45)";
  g.fillRect(0, 0, w, px + 16);
  g.fillStyle = color;
  g.textBaseline = "middle";
  g.fillText(text, 8, (px + 16) / 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  s.scale.set((w / (px + 16)) * 0.6, 0.6, 1);
  s.renderOrder = 10;
  return s;
}
