/**
 * Stage: owns the WebGL renderer, scene, camera, resize and the frame loop. Exactly one View is
 * active (battle, lab turntable, genospace...). Quality settings (pixel ratio, shadows) apply live.
 */
import * as THREE from "../lib/three.ts";
import { OrbitControls } from "../lib/orbit.ts";

export interface View {
  update(dt: number, t: number): void;
  dispose(): void;
  snapshot?(): Record<string, unknown>;
}

export interface Quality {
  pixelRatio: number;
  shadows: boolean;
}

export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(48, 1, 0.1, 1200);
  readonly controls: OrbitControls;
  view: View | null = null;
  timeScale = 1;
  paused = false;
  fps = 0;
  /** CPU ms of the last frame, the mean and the max over the last ~1 s window. */
  frameMs = 0;
  frameMsAvg = 0;
  frameMsMax = 0;
  private clock = new THREE.Clock();
  private t = 0;
  private frames = 0;
  private fpsT = 0;
  private msSum = 0;
  private msMax = 0;
  private flashEl: HTMLElement | null;

  constructor(readonly canvas: HTMLCanvasElement, quality: Quality) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true, powerPreference: "high-performance" });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.applyQuality(quality);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.enabled = false;
    this.camera.position.set(0, 10, 24);
    this.flashEl = document.getElementById("flash");
    const ro = new ResizeObserver(() => this.resize());
    ro.observe(canvas.parentElement ?? canvas);
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  applyQuality(q: Quality): void {
    this.renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, q.pixelRatio));
    this.renderer.shadowMap.enabled = q.shadows;
  }

  resize(): void {
    const el = this.canvas.parentElement ?? this.canvas;
    const w = Math.max(1, el.clientWidth), h = Math.max(1, el.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setView(v: View | null): void {
    this.view?.dispose();
    this.view = v;
  }

  flash(strength: number, color: number): void {
    if (!this.flashEl) return;
    this.flashEl.style.background = `#${color.toString(16).padStart(6, "0")}`;
    this.flashEl.style.opacity = String(Math.min(0.85, strength));
    requestAnimationFrame(() => {
      if (this.flashEl) this.flashEl.style.opacity = "0";
    });
  }

  private frame(): void {
    const t0 = performance.now();
    const raw = Math.min(this.clock.getDelta(), 0.1);
    const dt = this.paused ? 0 : raw * this.timeScale;
    this.t += dt;
    if (this.controls.enabled) this.controls.update();
    this.view?.update(dt, this.t);
    this.renderer.render(this.scene, this.camera);
    this.frameMs = performance.now() - t0;
    this.frames++;
    this.fpsT += raw;
    this.msSum += this.frameMs;
    this.msMax = Math.max(this.msMax, this.frameMs);
    if (this.fpsT >= 1) {
      this.fps = this.frames / this.fpsT;
      this.frameMsAvg = this.msSum / this.frames;
      this.frameMsMax = this.msMax;
      this.frames = 0;
      this.fpsT = 0;
      this.msSum = 0;
      this.msMax = 0;
    }
  }

  /** Renderer facts for the hardware panel (GPU string when the browser exposes it). */
  gpuInfo(): { renderer: string; vendor: string; maxTexture: number } {
    const gl = this.renderer.getContext();
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    return {
      renderer: ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER)),
      vendor: ext ? String(gl.getParameter(ext.UNMASKED_VENDOR_WEBGL)) : String(gl.getParameter(gl.VENDOR)),
      maxTexture: Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)),
    };
  }
}
