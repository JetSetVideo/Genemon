/**
 * The camera menu [P4-U3]: ONE collapsible glass panel (<details class="campanel">) that gathers every
 * camera and view option - mode (director / free orbit / top / side / low / follow, keys 1-6), follow
 * target, director pace, FOV, shake, depth of field (aperture, blur cap, auto/manual focus), bloom, fog,
 * vignette, playback speed, pause and reset. Stateless towards the App: everything comes in through
 * CameraPanelOptions and every change goes out through a callback, so this module never imports App.
 * Closed by default on phones (`compact`). No inline styles: dynamic colours go through CSS variables.
 */
import { h } from "./dom.ts";
import type { CameraMode } from "../render/battleCamera.ts";
import { POST_RANGES, type PostRange, type PostSettings } from "../render/post.ts";

export interface CameraFighterOption {
  idx: number;
  name: string;
  /** Side colour (SIDE_COLORS[team]) - shown as the option's dot colour. */
  color: string;
  team: 0 | 1;
  ko?: boolean;
}

export interface CameraPanelOptions {
  mode: CameraMode;
  fighters: readonly CameraFighterOption[];
  /** Fighter index the follow camera tracks; null = your side's lead. */
  follow: number | null;
  /** Director cut frequency multiplier (1 = default hold times). */
  pace: number;
  fov: number;
  shake: number;
  post: PostSettings;
  speed: number;
  paused: boolean;
  /** Phones: the panel starts closed. */
  compact: boolean;
  /** Explicit open state (e.g. kept across a rebuild); overrides `compact`. */
  open?: boolean;
  onMode(m: CameraMode): void;
  onFollow(idx: number | null): void;
  onPace(v: number): void;
  onFov(v: number): void;
  onShake(v: number): void;
  onPost(patch: Partial<PostSettings>): void;
  onSpeed(v: number): void;
  onPause(): void;
  onReset(): void;
}

interface Range {
  min: number;
  max: number;
  step: number;
}

/** Camera slider ranges (the BattleCamera clamps nothing itself, so the panel is the bound). */
const CAMERA_RANGES: { pace: Range; fov: Range; shake: Range } = {
  pace: { min: 0.5, max: 2, step: 0.1 },
  fov: { min: 30, max: 75, step: 1 },
  shake: { min: 0, max: 2, step: 0.05 },
};

/** What "reset view" restores (post settings are left alone: they are a look, not a view). */
export const CAMERA_DEFAULTS: { mode: CameraMode; follow: number | null; pace: number; fov: number; shake: number } = {
  mode: "auto",
  follow: null,
  pace: 1,
  fov: 48,
  shake: 1,
};

const MODES: { m: CameraMode; label: string; title: string }[] = [
  { m: "auto", label: "Director", title: "Auto director: cuts between action and wide shots" },
  { m: "orbit", label: "Free", title: "Free orbit: drag to turn, wheel to zoom" },
  { m: "top", label: "Top", title: "Top-down view" },
  { m: "side", label: "Side", title: "Side-on view" },
  { m: "low", label: "Low", title: "Low heroic angle" },
  { m: "follow", label: "Follow", title: "Follow one fighter" },
];

const SPEEDS = [0.5, 1, 2, 3];

const modeLabel = (m: CameraMode): string => MODES.find((x) => x.m === m)?.label ?? m;

const postRange = (k: PostRange["key"]): PostRange => POST_RANGES.find((r) => r.key === k)!;

function setPressed(b: HTMLElement, on: boolean): void {
  b.setAttribute("aria-pressed", String(on));
  b.classList.toggle("on", on);
}

function slider(label: string, r: Range, value: number, show: (v: number) => string, on: (v: number) => void, title = ""): { row: HTMLElement; input: HTMLInputElement } {
  const out = h("output", { class: "campanel-val mono" }, show(value));
  const input: HTMLInputElement = h("input", {
    type: "range",
    min: r.min,
    max: r.max,
    step: r.step,
    value,
    "aria-label": label,
    oninput: () => {
      const v = Number(input.value);
      out.textContent = show(v);
      on(v);
    },
  });
  return { row: h("label", { class: "campanel-row", title: title || undefined }, h("span", { class: "campanel-lbl" }, label), input, out), input };
}

function toggle(label: string, on: boolean, cb: (v: boolean) => void, title = ""): HTMLButtonElement {
  const b: HTMLButtonElement = h("button", {
    type: "button",
    class: `btn small campanel-tog${on ? " on" : ""}`,
    "aria-pressed": String(on),
    title: title || undefined,
    onclick: () => {
      const v = b.getAttribute("aria-pressed") !== "true";
      setPressed(b, v);
      cb(v);
      b.blur();
    },
  }, label);
  return b;
}

function segmented<T extends string | number>(
  label: string,
  opts: readonly { value: T; label: string; title?: string; key?: string; data?: Record<string, string> }[],
  current: T,
  cb: (v: T) => void,
  cls = "",
): HTMLElement {
  const g = h("div", { class: `campanel-seg ${cls}`.trim(), role: "group", "aria-label": label });
  for (const o of opts) {
    const attrs: Record<string, unknown> = {
      type: "button",
      class: `btn small${o.value === current ? " on" : ""}`,
      "aria-pressed": String(o.value === current),
      "data-v": String(o.value),
      title: o.title ? (o.key ? `${o.title} (key ${o.key})` : o.title) : undefined,
      "aria-keyshortcuts": o.key,
      onclick: (e: Event) => {
        for (const x of g.querySelectorAll<HTMLElement>("button")) setPressed(x, x.dataset.v === String(o.value));
        cb(o.value);
        (e.currentTarget as HTMLElement).blur();
      },
    };
    for (const [k, v] of Object.entries(o.data ?? {})) attrs[`data-${k}`] = v;
    g.append(h("button", attrs, o.label, o.key ? h("kbd", { class: "campanel-kbd", "aria-hidden": "true" }, o.key) : null));
  }
  return g;
}

/** Build the panel. Re-render it on a new battle; use syncCameraPanel for key-driven changes. */
export function renderCameraPanel(o: CameraPanelOptions): HTMLElement {
  const post: PostSettings = { ...o.post };
  const open = o.open ?? !o.compact;
  const modeEl = h("b", { class: "campanel-mode" }, modeLabel(o.mode));
  const root = h("details", { class: "campanel", open },
    h("summary", { class: "campanel-sum", title: "Camera and view options" }, h("span", { "aria-hidden": "true" }, "🎥"), " Camera · ", modeEl));

  // --- mode + follow target
  const modes = segmented("Camera mode", MODES.map((x, i) => ({ value: x.m, label: x.label, title: x.title, key: String(i + 1), data: { cam: x.m } })), o.mode, (m) => {
    modeEl.textContent = modeLabel(m);
    o.onMode(m);
  }, "campanel-modes");
  const follow: HTMLSelectElement = h("select", {
    class: "campanel-follow",
    "aria-label": "Follow target",
    onchange: () => {
      const v = follow.value === "" ? null : Number(follow.value);
      o.onFollow(v);
      if (v !== null) {
        syncCameraPanel(root, { mode: "follow" });
        o.onMode("follow");
      }
      follow.blur();
    },
  }, h("option", { value: "", selected: o.follow === null }, "Lead (your side)"));
  for (const f of o.fighters) {
    follow.append(h("option", { value: f.idx, selected: o.follow === f.idx, disabled: !!f.ko, vars: { c: f.color } }, `● ${f.name}${f.team === 0 ? " · you" : " · rival"}${f.ko ? " · KO" : ""}`));
  }

  // --- director lens
  const pace = slider("Director pace", CAMERA_RANGES.pace, o.pace, (v) => `${v.toFixed(1)}×`, o.onPace, "How often the director cuts between shots");
  const fov = slider("Field of view", CAMERA_RANGES.fov, o.fov, (v) => `${Math.round(v)}°`, o.onFov);
  const shake = slider("Shake", CAMERA_RANGES.shake, o.shake, (v) => `${Math.round(v * 100)}%`, o.onShake, "Screen shake on hits, crits and KOs");

  // --- lens & atmosphere (post)
  const patch = (p: Partial<PostSettings>) => {
    Object.assign(post, p);
    refresh();
    o.onPost(p);
  };
  const R = (k: PostRange["key"]): Range => postRange(k);
  const fx = toggle("Effects", post.enabled, (v) => patch({ enabled: v }), "All post effects (off = fastest)");
  const dof = toggle("Depth of field", post.dof, (v) => patch({ dof: v }), "Blur what is not in focus");
  const aperture = slider("Aperture", R("aperture"), post.aperture, (v) => v.toFixed(1), (v) => patch({ aperture: v }), "Bigger = shallower focus");
  const blurCap = slider("Blur cap", R("maxBlur"), post.maxBlur, (v) => `${(v * 1000).toFixed(0)}‰`, (v) => patch({ maxBlur: v }), "Largest blur radius");
  const focusMode = segmented("Focus", [
    { value: "auto" as const, label: "Auto focus", title: "Focus follows the fighters on screen" },
    { value: "manual" as const, label: "Manual", title: "Fixed focus distance" },
  ], post.focusMode, (v) => patch({ focusMode: v }));
  const focusDist = slider("Focus distance", R("focusDistance"), post.focusDistance, (v) => `${v.toFixed(1)} m`, (v) => patch({ focusDistance: v }));
  const bloom = toggle("Bloom", post.bloom, (v) => patch({ bloom: v }), "Glow on bright emissive parts only");
  const bloomK = slider("Bloom strength", R("bloomStrength"), post.bloomStrength, (v) => v.toFixed(2), (v) => patch({ bloomStrength: v }));
  const fog = slider("Fog", R("fogDensity"), post.fogDensity, (v) => `${v.toFixed(2)}×`, (v) => patch({ fogDensity: v }), "Multiplier on the weather's fog");
  const vig = slider("Vignette", R("vignette"), post.vignette ?? 0, (v) => `${Math.round(v * 100)}%`, (v) => patch({ vignette: v }));

  function refresh(): void {
    const on = post.enabled, dofOn = on && post.dof;
    dof.disabled = !on;
    bloom.disabled = !on;
    aperture.input.disabled = !dofOn;
    blurCap.input.disabled = !dofOn;
    for (const b of focusMode.querySelectorAll<HTMLButtonElement>("button")) b.disabled = !dofOn;
    focusDist.input.disabled = !dofOn || post.focusMode !== "manual";
    bloomK.input.disabled = !on || !post.bloom;
    vig.input.disabled = !on;
  }

  // --- playback
  const speed = segmented("Speed", SPEEDS.map((s) => ({ value: s, label: s === 0.5 ? "½×" : `${s}×`, title: `Battle speed ${s}×` })), o.speed, (v) => o.onSpeed(v), "campanel-speed");
  const pause: HTMLButtonElement = h("button", {
    type: "button",
    class: `btn small campanel-pause${o.paused ? " on" : ""}`,
    "aria-pressed": String(o.paused),
    "aria-keyshortcuts": "Space",
    title: "Pause / resume (Space)",
    onclick: () => {
      o.onPause();
      pause.blur();
    },
  }, o.paused ? "▶ Resume" : "⏸ Pause");
  const reset = h("button", { type: "button", class: "btn small campanel-reset", title: "Back to the director with default lens settings", onclick: (e: Event) => {
    o.onReset();
    (e.currentTarget as HTMLElement).blur();
  } }, "↺ Reset view");

  root.append(h("div", { class: "campanel-body" },
    modes,
    h("label", { class: "campanel-row" }, h("span", { class: "campanel-lbl" }, "Follow"), follow),
    pace.row,
    fov.row,
    shake.row,
    h("h4", { class: "campanel-h" }, "Lens & atmosphere"),
    h("div", { class: "campanel-togs" }, fx, dof, bloom),
    aperture.row,
    blurCap.row,
    focusMode,
    focusDist.row,
    bloomK.row,
    fog.row,
    vig.row,
    h("h4", { class: "campanel-h" }, "Playback"),
    speed,
    h("div", { class: "campanel-togs" }, pause, reset)));
  refresh();
  return root;
}

/** Update the built panel in place (keyboard 1-6 / Space changed the state elsewhere). */
export function syncCameraPanel(root: HTMLElement, s: { mode?: CameraMode; paused?: boolean; speed?: number }): void {
  if (s.mode !== undefined) {
    const m = s.mode;
    const label = root.querySelector(".campanel-mode");
    if (label) label.textContent = modeLabel(m);
    for (const b of root.querySelectorAll<HTMLElement>(".campanel-modes button")) setPressed(b, b.dataset.cam === m);
  }
  if (s.speed !== undefined) {
    for (const b of root.querySelectorAll<HTMLElement>(".campanel-speed button")) setPressed(b, Number(b.dataset.v) === s.speed);
  }
  if (s.paused !== undefined) {
    const p = root.querySelector<HTMLElement>(".campanel-pause");
    if (p) {
      setPressed(p, s.paused);
      p.textContent = s.paused ? "▶ Resume" : "⏸ Pause";
    }
  }
}
