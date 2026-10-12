/** Tiny DOM helpers. Styles are only ever set through CSSOM custom properties (strict CSP). */

type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, unknown> & { vars?: Record<string, string | number>; class?: string };

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "vars") {
      for (const [n, x] of Object.entries(v as Record<string, string | number>)) el.style.setProperty(`--${n}`, String(x));
    } else if (k.startsWith("on") && typeof v === "function") {
      el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (k === "value" && "value" in el) {
      (el as HTMLInputElement).value = String(v);
    } else if (k === "checked" && "checked" in el) {
      (el as HTMLInputElement).checked = Boolean(v);
    } else if (v === true) {
      el.setAttribute(k, "");
    } else {
      el.setAttribute(k, String(v));
    }
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
  }
  return el;
}

export const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document): T => root.querySelector(sel) as T;

export function clear(el: HTMLElement): HTMLElement {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function hex(c: number): string {
  return `#${c.toString(16).padStart(6, "0")}`;
}

export function fmt(v: number, d = 0): string {
  return Number.isFinite(v) ? v.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d }) : "-";
}

export function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

export function bar(frac: number, color?: string): HTMLElement {
  return h("div", { class: "bar" }, h("i", { vars: { w: `${Math.max(0, Math.min(100, frac * 100)).toFixed(1)}%`, ...(color ? { c: color } : {}) } }));
}

export function section(title: string, ...children: Child[]): HTMLElement {
  return h("div", { class: "section" }, h("div", { class: "section-head" }, h("h2", {}, title)), ...children);
}

export function select<T extends string>(options: readonly T[] | readonly { value: T; label: string }[], value: T, onChange: (v: T) => void, attrs: Attrs = {}): HTMLSelectElement {
  const s = h("select", { ...attrs, onchange: (e: Event) => onChange((e.target as HTMLSelectElement).value as T) });
  for (const o of options) {
    const v = typeof o === "string" ? o : o.value, l = typeof o === "string" ? o : o.label;
    s.append(h("option", { value: v, selected: v === value }, l));
  }
  return s;
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(msg: string, ms = 2600): void {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), ms);
}

export function download(name: string, text: string, mime = "application/json"): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = h("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
