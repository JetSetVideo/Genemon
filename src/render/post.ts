/**
 * Post-processing and atmosphere [P4-V1]: depth-of-field focus on the fighters, bloom on emissives only,
 * an optional vignette and exponential fog tied to the weather's sky colour.
 *
 * Pipeline (only when at least one effect is on; otherwise a plain renderer.render fallback):
 *   RenderPass (linear HDR into a HalfFloat MSAA target)
 *   -> BokehPass (focus = view depth in metres, auto-focused on the camera's subjects)
 *   -> UnrealBloomPass (threshold >= 1.0: only toneMapped:false / HDR emissives bloom)
 *   -> vignette ShaderPass (linear multiply)
 *   -> OutputPass (the renderer's ACES tone mapping + sRGB, ONCE, straight to the canvas, so
 *      preserveDrawingBuffer screenshots keep working).
 * The pure parts (settings table + clamp, quality gate, focus distance, the critically damped spring)
 * carry no WebGL and are unit-tested in tests/post_test.ts.
 */
import * as THREE from "../lib/three.ts";
import { BokehPass, EffectComposer, OutputPass, RenderPass, ShaderPass, UnrealBloomPass } from "../lib/post.ts";

export interface PostSettings {
  /** Master switch: false renders straight to the canvas (no composer cost). */
  enabled: boolean;
  dof: boolean;
  /** Lens opening, UI units (x APERTURE_SCALE per metre of defocus = bokeh UV blur). */
  aperture: number;
  /** Largest blur, in UV units of the frame. */
  maxBlur: number;
  focusMode: "auto" | "manual";
  /** Manual focus distance in metres (view depth). */
  focusDistance: number;
  bloom: boolean;
  bloomStrength: number;
  /** Multiplier on the weather's own fog density (1 = as the weather defines it). */
  fogDensity: number;
  /** Corner darkening 0..1 (0 = off). */
  vignette?: number;
}

type NumericKey = "aperture" | "maxBlur" | "focusDistance" | "bloomStrength" | "fogDensity" | "vignette";

export interface PostRange {
  key: NumericKey;
  min: number;
  max: number;
  def: number;
  step: number;
  unit: string;
  note: string;
}

/** Every numeric post setting with its declared range: the clamp, the defaults and the UI sliders read this. */
export const POST_RANGES: readonly PostRange[] = [
  { key: "aperture", min: 0, max: 10, def: 1.2, step: 0.1, unit: "", note: "lens opening; bigger = shallower depth of field" },
  { key: "maxBlur", min: 0, max: 0.02, def: 0.004, step: 0.001, unit: "uv", note: "cap on the blur radius (fraction of the frame)" },
  { key: "focusDistance", min: 1, max: 80, def: 14, step: 0.5, unit: "m", note: "manual focus distance (view depth)" },
  { key: "bloomStrength", min: 0, max: 2, def: 0.6, step: 0.05, unit: "", note: "glow of HDR emissives (threshold fixed >= 1)" },
  { key: "fogDensity", min: 0, max: 3, def: 1, step: 0.05, unit: "x", note: "multiplier on the weather's fog density" },
  { key: "vignette", min: 0, max: 1, def: 0.18, step: 0.05, unit: "", note: "corner darkening" },
];

/** Bokeh uniform per UI aperture unit per metre of defocus (10 m off-focus at aperture 2.5 = 0.0025 uv). */
export const APERTURE_SCALE = 1e-4;
/** Linear-HDR luminance above which a pixel blooms: >= 1 so lit ground never veils the frame. */
export const BLOOM_THRESHOLD = 1.0;
const BLOOM_RADIUS = 0.4;
/** Auto-focus spring stiffness (rad/s): critically damped, settles in ~0.7 s, never overshoots. */
const FOCUS_OMEGA = 6;
/** Hard cap on any fog density written to the scene (beyond this the arena vanishes). */
const FOG_MAX = 0.2;

const range = (k: NumericKey): PostRange => POST_RANGES.find((r) => r.key === k)!;

export const DEFAULT_POST: PostSettings = {
  enabled: true,
  dof: true,
  aperture: range("aperture").def,
  maxBlur: range("maxBlur").def,
  focusMode: "auto",
  focusDistance: range("focusDistance").def,
  bloom: true,
  bloomStrength: range("bloomStrength").def,
  fogDensity: range("fogDensity").def,
  vignette: range("vignette").def,
};

/** Pure: every key present, every number finite and inside its declared range; junk falls back to the default. */
export function clampPost(p: Partial<PostSettings> | null | undefined): PostSettings {
  const src = (p && typeof p === "object" ? p : {}) as Record<string, unknown>;
  const bool = (k: "enabled" | "dof" | "bloom"): boolean => typeof src[k] === "boolean" ? src[k] as boolean : DEFAULT_POST[k];
  const num = (k: NumericKey): number => {
    const r = range(k), v = src[k];
    return typeof v === "number" && Number.isFinite(v) ? Math.min(r.max, Math.max(r.min, v)) : r.def;
  };
  return {
    enabled: bool("enabled"),
    dof: bool("dof"),
    aperture: num("aperture"),
    maxBlur: num("maxBlur"),
    focusMode: src.focusMode === "manual" || src.focusMode === "auto" ? src.focusMode : DEFAULT_POST.focusMode,
    focusDistance: num("focusDistance"),
    bloom: bool("bloom"),
    bloomStrength: num("bloomStrength"),
    fogDensity: num("fogDensity"),
    vignette: num("vignette"),
  };
}

/**
 * Pure quality gate: low quality renders without the composer; phones keep bloom and vignette but drop
 * depth of field (the BokehPass re-renders the whole scene into a depth target every frame).
 */
export function gatePost(p: Partial<PostSettings> | null | undefined, quality: "low" | "high", mobile: boolean): PostSettings {
  const s = clampPost(p);
  if (quality === "low") s.enabled = false;
  if (mobile) s.dof = false;
  return s;
}

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/**
 * Pure: the median distance from the camera to the (living) subjects - the auto-focus target.
 * With `forward` (the camera's view direction) the distance is the VIEW DEPTH, which is what the bokeh
 * shader compares against (points behind the camera are skipped). Non-finite points are ignored;
 * returns NaN when nothing usable remains (the caller keeps its previous focus).
 */
export function focusDistanceFor(cameraPos: Vec3Like, subjects: readonly Vec3Like[], forward?: Vec3Like): number {
  let fx = 0, fy = 0, fz = 0;
  if (forward) {
    const n = Math.hypot(forward.x, forward.y, forward.z);
    if (Number.isFinite(n) && n > 1e-9) fx = forward.x / n, fy = forward.y / n, fz = forward.z / n;
    else forward = undefined;
  }
  const d: number[] = [];
  for (const p of subjects) {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) continue;
    const dx = p.x - cameraPos.x, dy = p.y - cameraPos.y, dz = p.z - cameraPos.z;
    const v = forward ? dx * fx + dy * fy + dz * fz : Math.hypot(dx, dy, dz);
    if (Number.isFinite(v) && v > 0) d.push(v);
  }
  if (d.length === 0) return NaN;
  d.sort((a, b) => a - b);
  const m = d.length >> 1;
  return d.length % 2 ? d[m] : (d[m - 1] + d[m]) / 2;
}

/**
 * Pure: one exact step of a critically damped spring (x'' = w^2 (target - x) - 2 w x'). Stable for any
 * dt, never overshoots a target approached from rest.
 */
export function springStep(x: number, v: number, target: number, omega: number, dt: number): { x: number; v: number } {
  if (!(dt > 0)) return { x, v };
  const d = x - target, e = Math.exp(-omega * dt), k = v + omega * d;
  return { x: target + (d + k * dt) * e, v: (v - omega * k * dt) * e };
}

/**
 * Exponential fog in the weather's sky colour. Always installs a FogExp2 (density 0 included) so the
 * fog shader define never toggles and no material recompiles. Returns a restore function that puts the
 * previous fog back ONLY if this fog is still the scene's (a View's dispose runs after the next view's
 * constructor, so it must not undo a newer view's fog).
 */
export function atmosphere(scene: THREE.Scene, o: { color: number; density: number }): () => void {
  const prev = scene.fog;
  const density = Number.isFinite(o.density) ? Math.min(FOG_MAX, Math.max(0, o.density)) : 0;
  const mine = new THREE.FogExp2(o.color, density);
  scene.fog = mine;
  return () => {
    if (scene.fog === mine) scene.fog = prev;
  };
}

const VignetteShader = {
  uniforms: { tDiffuse: { value: null }, amount: { value: 0.25 } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float amount;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      vec2 d = vUv - 0.5;
      float v = 1.0 - amount * smoothstep(0.2, 1.0, dot(d, d) * 2.0);
      gl_FragColor = vec4(c.rgb * v, c.a);
    }`,
};

/**
 * The composer. Owned by the Stage (one per renderer); views only call setFocus(). Every pass is built
 * once and toggled through `.enabled`, so changing a setting never allocates GPU targets.
 */
export class PostFX {
  private readonly composer: EffectComposer;
  private readonly renderPass: RenderPass;
  private readonly bokeh: BokehPass;
  private readonly bloom: UnrealBloomPass;
  private readonly vignette: ShaderPass;
  private readonly output: OutputPass;
  private s: PostSettings;
  private readonly pts: THREE.Vector3[] = [];
  private nPts = 0;
  private focusX: number;
  private focusV = 0;
  private lastTarget: number;
  private readonly fwd = new THREE.Vector3();

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.PerspectiveCamera,
    settings: PostSettings,
    samples = 4,
  ) {
    this.s = clampPost(settings);
    this.focusX = this.lastTarget = this.s.focusDistance;
    const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples });
    rt.texture.name = "PostFX.rt";
    this.composer = new EffectComposer(renderer, rt);
    this.renderPass = new RenderPass(scene, camera);
    this.bokeh = new BokehPass(scene, camera, { focus: this.focusX, aperture: this.s.aperture * APERTURE_SCALE, maxblur: this.s.maxBlur });
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), this.s.bloomStrength, BLOOM_RADIUS, BLOOM_THRESHOLD);
    this.vignette = new ShaderPass(VignetteShader);
    this.output = new OutputPass();
    for (const p of [this.renderPass, this.bokeh, this.bloom, this.vignette, this.output]) this.composer.addPass(p);
    const size = renderer.getSize(new THREE.Vector2());
    this.setSize(size.x, size.y, renderer.getPixelRatio());
    this.apply(this.s);
  }

  /** CSS-pixel size and device pixel ratio (call from Stage.resize and after applyQuality). */
  setSize(w: number, h: number, dpr: number): void {
    this.composer.setPixelRatio(dpr);
    this.composer.setSize(Math.max(1, w), Math.max(1, h));
  }

  apply(settings: PostSettings): void {
    const s = this.s = clampPost(settings);
    this.bloom.strength = s.bloomStrength;
    this.bloom.threshold = BLOOM_THRESHOLD;
    this.bloom.enabled = s.enabled && s.bloom && s.bloomStrength > 0;
    this.vignette.uniforms.amount.value = s.vignette ?? 0;
    this.vignette.enabled = s.enabled && (s.vignette ?? 0) > 0;
    this.syncBokeh();
  }

  /**
   * Auto-focus subject(s): a world point, the living subjects (median view depth is used), or null for
   * "no subject" - auto mode then renders without depth of field rather than blurring a stale distance.
   */
  setFocus(p: Vec3Like | readonly Vec3Like[] | null): void {
    const list: readonly Vec3Like[] = p === null ? [] : Array.isArray(p) ? p : [p as Vec3Like];
    this.nPts = 0;
    for (const q of list) {
      if (!q || !Number.isFinite(q.x) || !Number.isFinite(q.y) || !Number.isFinite(q.z)) continue;
      if (this.pts.length <= this.nPts) this.pts.push(new THREE.Vector3());
      this.pts[this.nPts++].set(q.x, q.y, q.z);
    }
  }

  /** True when the composer runs this frame (false = plain renderer.render). */
  get active(): boolean {
    return this.s.enabled && (this.bokeh.enabled || this.bloom.enabled || this.vignette.enabled);
  }

  get focus(): number {
    return this.focusX;
  }

  /** `dt` = real (unscaled) frame time so focus keeps converging while the battle is paused. */
  render(dt: number): void {
    this.updateFocus(dt);
    if (!this.active) {
      this.renderer.render(this.scene, this.camera);
      return;
    }
    this.composer.render(dt);
  }

  snapshot(): Record<string, unknown> {
    return {
      active: this.active,
      dof: this.bokeh.enabled,
      focus: Math.round(this.focusX * 100) / 100,
      focusMode: this.s.focusMode,
      subjects: this.nPts,
      aperture: this.s.aperture,
      bloom: this.bloom.enabled,
      vignette: this.vignette.enabled,
    };
  }

  dispose(): void {
    for (const p of [this.renderPass, this.bokeh, this.bloom, this.vignette, this.output]) p.dispose();
    this.composer.dispose();
  }

  private updateFocus(dt: number): void {
    let target = this.lastTarget;
    if (this.s.focusMode === "manual") target = this.s.focusDistance;
    else if (this.nPts > 0) {
      this.camera.getWorldDirection(this.fwd);
      const d = focusDistanceFor(this.camera.position, this.pts.slice(0, this.nPts), this.fwd);
      if (Number.isFinite(d)) target = Math.max(0.5, d);
    }
    this.lastTarget = target;
    if (dt > 0.5) {
      this.focusX = target;
      this.focusV = 0;
    } else {
      const r = springStep(this.focusX, this.focusV, target, FOCUS_OMEGA, dt);
      this.focusX = r.x;
      this.focusV = r.v;
    }
    this.syncBokeh();
  }

  private syncBokeh(): void {
    const s = this.s;
    this.bokeh.enabled = s.enabled && s.dof && s.aperture > 0 && s.maxBlur > 0 && (s.focusMode === "manual" || this.nPts > 0);
    const u = this.bokeh.materialBokeh.uniforms;
    u.focus.value = this.focusX;
    u.aperture.value = s.aperture * APERTURE_SCALE;
    u.maxblur.value = s.maxBlur;
  }
}
