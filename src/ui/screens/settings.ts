import type { App } from "../app.ts";
import type { CameraMode } from "../../render/battleCamera.ts";
import { h, section, select, toast } from "../dom.ts";
import { forgetProgress } from "../progressStore.ts";
import { renderDevPanel } from "../devPanel.ts";

let newName = "";

export function renderSettings(app: App): HTMLElement {
  const s = app.profile.settings;
  const range = (label: string, min: number, max: number, step: number, value: number, on: (v: number) => void, fmtV = (v: number) => String(v)) => {
    const out = h("span", { class: "muted" }, fmtV(value));
    return h("label", { class: "field" }, h("span", { class: "row" }, label, out), h("input", { type: "range", min, max, step, value, oninput: (e: Event) => (out.textContent = fmtV(Number((e.target as HTMLInputElement).value))), onchange: (e: Event) => on(Number((e.target as HTMLInputElement).value)) }));
  };
  const profiles = app.store.list();
  return h("div", {},
    h("h1", {}, "Settings"),
    renderDevPanel(app),
    h("p", { class: "muted" }, `Saved in the profile "${app.profile.name}".`),
    section("Appearance",
      h("div", { class: "row" }, h("button", { class: `btn ${s.theme === "dark" ? "on" : ""}`, "data-theme-set": "dark", onclick: () => app.updateSettings({ theme: "dark" }) }, "🌙 Dark"), h("button", { class: `btn ${s.theme === "light" ? "on" : ""}`, "data-theme-set": "light", onclick: () => app.updateSettings({ theme: "light" }) }, "☀ Light")),
      h("label", { class: "field" }, "Units", select(["metric", "imperial"] as const, s.units, (v) => app.updateSettings({ units: v })))),
    section("Graphics",
      h("label", { class: "field" }, "Model quality", select(["high", "low"] as const, s.quality, (v) => app.updateSettings({ quality: v }))),
      range("Max pixel ratio", 0.5, 2, 0.25, s.pixelRatio, (v) => app.updateSettings({ pixelRatio: v }), (v) => `${v}x`),
      h("label", { class: "row muted" }, h("input", { type: "checkbox", checked: s.shadows, onchange: (e: Event) => app.updateSettings({ shadows: (e.target as HTMLInputElement).checked }) }), "Shadows")),
    section("Battle",
      h("label", { class: "field" }, "Default camera", select(["auto", "orbit", "top", "side", "low", "follow"] as CameraMode[], s.camera, (v) => app.updateSettings({ camera: v }))),
      range("Camera shake", 0, 1.5, 0.1, s.shake, (v) => app.updateSettings({ shake: v }), (v) => `${Math.round(v * 100)}%`),
      range("Battle speed", 0.5, 3, 0.5, s.speed, (v) => app.updateSettings({ speed: v }), (v) => `${v}x`)),
    section("Time of day",
      h("p", { class: "muted" }, "Real: arenas, rhythm buffs and spawns follow your local clock. Fixed: pick an hour."),
      h("label", { class: "field" }, "Mode", select(["real", "fixed"] as const, s.hourMode, (v) => app.updateSettings({ hourMode: v }))),
      s.hourMode === "fixed" ? range("Hour", 0, 23.5, 0.5, s.hour, (v) => app.updateSettings({ hour: v }), (v) => `${Math.floor(v)}:${v % 1 ? "30" : "00"}`) : null),
    section("Lab",
      h("label", { class: "row muted" }, h("input", { type: "checkbox", checked: s.showSkeleton, onchange: (e: Event) => app.updateSettings({ showSkeleton: (e.target as HTMLInputElement).checked }) }), "Show skeleton, centre of mass and support polygon")),
    section("Profiles (you and me)",
      ...profiles.map((p) => h("div", { class: "row" },
        h("span", { class: "spacer" }, `${p.kind === "ai" ? "🤖" : "🙂"} ${p.name} · MMR ${Math.round(p.mmr)} · ${p.collection.length} Genemon${p.id === app.profile.id ? " (active)" : ""}`),
        p.id !== app.profile.id ? h("button", { class: "btn small", onclick: () => app.switchProfile(p.id) }, "Switch") : null,
        p.id !== app.profile.id ? h("button", { class: "btn small", onclick: () => {
          app.store.remove(p.id);
          forgetProgress(localStorage, p.id);
          app.render();
        } }, "Delete") : null)),
      h("div", { class: "row" },
        h("input", { type: "text", placeholder: "New profile name", value: newName, oninput: (e: Event) => (newName = (e.target as HTMLInputElement).value) }),
        h("button", { class: "btn", onclick: () => {
          if (!newName.trim()) return toast("Type a name first.");
          const p = app.store.create(newName.trim(), "human", Date.now());
          newName = "";
          app.switchProfile(p.id);
        } }, "Create"),
        h("button", { class: "btn", onclick: () => {
          if (!newName.trim()) return toast("Type a name first.");
          const p = app.store.create(newName.trim(), "ai", Date.now());
          newName = "";
          toast(`AI profile ${p.name} created.`);
          app.render();
        } }, "Create AI")),
      h("label", { class: "field" }, "Import a profile (.json)", h("input", { type: "file", accept: "application/json", onchange: async (e: Event) => {
        const f = (e.target as HTMLInputElement).files?.[0];
        if (!f) return;
        try {
          const p = app.store.importJSON(await f.text());
          toast(`Imported ${p.name}.`);
          app.render();
        } catch (err) {
          toast(`Import failed: ${(err as Error).message}`);
        }
      } }))),
  );
}
