/**
 * App: the orchestrator. Real-world context (top) -> profile + settings -> screens (DOM panel) and
 * the 3D stage (one active view). Starts instant battles, renders the battle HUD, folds results
 * back into Genemon and profiles, and exposes a debug/QA surface on globalThis.__GENEMON__.
 */
import { Ledger } from "../core/ledger.ts";
import { hashSeed } from "../core/rng.ts";
import { Battle, type BattleEvent, type BattleResult, applyBattleResult } from "../combat/battle.ts";
import { autoTeam, type Team } from "../combat/team.ts";
import { MOVE_BY_ID } from "../combat/moves.ts";
import { ELEMENTS } from "../data/elements.ts";
import { WEATHERS, type WeatherId } from "../data/weather.ts";
import { createGenemon, type Genemon, phenotypeOf } from "../genome/genemon.ts";
import { ARENA_INFO, type ArenaKind } from "../world/arena.ts";
import { BattleView } from "../render/battleView.ts";
import type { CameraMode } from "../render/battleCamera.ts";
import { GenospaceView } from "../render/genospaceView.ts";
import { LabView } from "../render/labView.ts";
import { Stage, type View } from "../render/stage.ts";
import { $, clear, h, hex, toast } from "./dom.ts";
import { type Profile, ProfileStore, type Settings, teamOf } from "./profile.ts";
import { readRealWorld, type RealWorld, Session } from "./realworld.ts";
import { SCREENS, type ScreenDef } from "./screens/registry.ts";

export interface BattleOptions {
  arena: ArenaKind;
  weather: WeatherId | "auto";
  hour: number | "real";
  opponent: "rival" | "profile" | "mirror" | "wild";
  opponentProfile?: string;
  seed?: number;
}

export class App {
  readonly ledger = new Ledger("app", 60000);
  readonly store: ProfileStore;
  readonly stage: Stage;
  readonly session: Session;
  profile: Profile;
  rw: RealWorld;
  screen = "home";
  battleView: BattleView | null = null;
  labView: LabView | null = null;
  genoView: GenospaceView | null = null;
  lastResult: BattleResult | null = null;
  lastBattle: { opts: BattleOptions; seed: number } | null = null;
  selected: string | null = null;
  private wild: Genemon[] | null = null;
  private hudTimer = 0;
  private feed: { text: string; color: string; t: number }[] = [];

  constructor() {
    this.rw = readRealWorld();
    this.store = new ProfileStore(localStorage, Date.now());
    this.profile = this.store.active();
    this.applyTheme();
    this.stage = new Stage($("#scene") as HTMLCanvasElement, { pixelRatio: this.profile.settings.pixelRatio, shadows: this.profile.settings.shadows });
    this.rw.device.gpu = this.stage.gpuInfo().renderer;
    this.session = new Session(this.ledger, this.rw.device);
    this.ledger.emit({
      when: Date.now(),
      where: { x: 0, y: 0, z: 0, zone: this.rw.device.timezone, space: "device" },
      who: "device",
      what: "device.gpu",
      why: "renderer probe",
      from: "webgl",
      to: "stage",
      entries: { renderer: this.rw.device.gpu ?? "unknown" },
      exits: { maxTexture: this.stage.gpuInfo().maxTexture },
    });
    this.buildNav();
    $("#btn-theme").addEventListener("click", () => this.updateSettings({ theme: this.profile.settings.theme === "dark" ? "light" : "dark" }));
    for (const el of document.querySelectorAll<HTMLElement>("[data-screen]")) el.addEventListener("click", () => this.go(el.dataset.screen!));
    document.addEventListener("keydown", (e) => this.key(e));
    $("#scene").addEventListener("pointermove", (e) => this.hover(e as PointerEvent));
    setInterval(() => this.tickChrome(), 1000);
    this.tickChrome();
    this.go("home");
    requestAnimationFrame(() => this.hudLoop());
  }

  // ---------------------------------------------------------------- chrome
  private applyTheme(): void {
    document.documentElement.dataset.theme = this.profile.settings.theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", this.profile.settings.theme === "dark" ? "#0d1117" : "#f4f6fa");
  }

  private buildNav(): void {
    const nav = clear($("#nav"));
    for (const s of SCREENS) {
      nav.append(h("button", { class: "nav-btn", "data-nav": s.id, title: s.hint, vars: { tab: s.color }, onclick: () => this.go(s.id) }, h("span", { class: "ico" }, s.icon), h("span", { class: "lbl" }, s.label)));
    }
  }

  tickChrome(): void {
    this.rw = { ...readRealWorld(), device: this.rw.device };
    const w = WEATHERS[this.rw.weather];
    $("#context-chip").textContent = `${this.rw.now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · ${this.rw.dayPhase} · ${this.rw.season} · ${w.name} · ${this.rw.moonName}`;
    $("#btn-profile").textContent = `${this.profile.kind === "ai" ? "🤖" : "🙂"} ${this.profile.name} · ${Math.round(this.profile.mmr)}`;
    $("#fps").textContent = `${Math.round(this.stage.fps)} fps · ${this.stage.frameMsAvg.toFixed(1)} ms`;
  }

  hourNow(): number {
    return this.profile.settings.hourMode === "real" ? this.rw.hour : this.profile.settings.hour;
  }

  updateSettings(patch: Partial<Settings>): void {
    Object.assign(this.profile.settings, patch);
    this.save();
    this.applyTheme();
    this.stage.applyQuality({ pixelRatio: this.profile.settings.pixelRatio, shadows: this.profile.settings.shadows });
    if (this.battleView) {
      this.battleView.cam.shakeScale = this.profile.settings.shake;
      this.battleView.speed = this.profile.settings.speed;
    }
    if (this.labView) this.labView.showSkeleton = this.profile.settings.showSkeleton;
    this.log("ui.settings", "settings changed", Object.keys(patch).join(","), JSON.stringify(patch).slice(0, 120));
    if (this.screen === "settings" || "theme" in patch) this.render();
  }

  save(): void {
    this.store.save(this.profile);
  }

  switchProfile(id: string): void {
    const p = this.store.switchTo(id);
    if (!p) return;
    this.profile = p;
    this.selected = null;
    this.applyTheme();
    this.log("ui.profile.switch", "user switched profile", id, p.name);
    this.go("home");
  }

  log(what: string, why: string, to: string, detail = ""): void {
    this.ledger.emit({ when: Date.now(), where: { x: 0, y: 0, z: 0, zone: this.screen, space: "ui" }, who: this.profile.id, what, why, from: this.screen, to, entries: { detail }, exits: {} });
  }

  // ---------------------------------------------------------------- navigation
  go(screen: string): void {
    const def = SCREENS.find((s) => s.id === screen) ?? SCREENS[0];
    if (this.screen !== def.id) this.log("ui.navigate", "user opened a screen", def.id);
    this.screen = def.id;
    this.session.visit(def.id);
    for (const b of document.querySelectorAll<HTMLElement>("[data-nav]")) b.classList.toggle("active", b.dataset.nav === def.id);
    if (def.id !== "arena" && this.battleView && this.battleView.battle.winner !== null) this.closeBattle();
    this.render();
    this.ensureView(def);
  }

  render(): void {
    const def = SCREENS.find((s) => s.id === this.screen)!;
    const panel = clear($("#panel"));
    panel.append(def.render(this));
  }

  private ensureView(def: ScreenDef): void {
    if (this.battleView && def.id === "arena") return;
    if (def.mount) {
      def.mount(this);
      return;
    }
    const want = def.view ?? "lab";
    if (want === "lab") this.showLab(this.selectedGenemon());
    if (want === "genospace") this.showGenospace();
  }

  /** Mount any 3D view (world map, ...) as the active one, closing battle / lab / genospace views. */
  mountView(v: View): void {
    this.closeBattle();
    this.labView = null;
    this.genoView = null;
    clear($("#view-tools"));
    this.stage.setView(v);
  }

  selectedGenemon(): Genemon {
    const team = teamOf(this.profile);
    return this.profile.collection.find((g) => g.id === this.selected) ?? team[0] ?? this.profile.collection[0];
  }

  select(id: string): void {
    this.selected = id;
    if (this.labView) this.labView.setGenemon(this.selectedGenemon());
    else this.showLab(this.selectedGenemon());
    this.render();
  }

  showLab(g: Genemon): void {
    if (this.labView && !this.battleView) {
      this.labView.setGenemon(g);
      return;
    }
    this.closeBattle();
    this.genoView = null;
    clear($("#view-tools"));
    this.labView = new LabView(this.stage, g, this.profile.settings.theme === "dark");
    this.labView.showSkeleton = this.profile.settings.showSkeleton;
    this.stage.setView(this.labView);
  }

  wildPool(): Genemon[] {
    if (!this.wild) {
      this.wild = Array.from({ length: 180 }, (_, i) => createGenemon({ seed: hashSeed("wild", i), owner: "wild", level: 8 + (i % 30) }));
    }
    return this.wild;
  }

  showGenospace(axes: GenospaceView["axes"] = ["heat", "moisture", "luminance"], coords?: Map<string, [number, number, number]>): void {
    this.closeBattle();
    this.labView = null;
    const pts = [...this.profile.collection.map((g) => ({ g, owned: true })), ...this.wildPool().map((g) => ({ g, owned: false }))]
      .map(({ g, owned }) => ({ id: g.id, name: g.name, ph: phenotypeOf(g), owned, coords: coords?.get(g.id) }));
    this.genoView = new GenospaceView(this.stage, pts, axes, this.profile.settings.theme === "dark");
    this.stage.setView(this.genoView);
  }

  private hover(e: PointerEvent): void {
    const tip = $("#tooltip");
    if (!this.genoView) {
      tip.classList.add("hidden");
      return;
    }
    const r = (e.target as HTMLElement).getBoundingClientRect();
    const p = this.genoView.pick(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    if (!p) {
      tip.classList.add("hidden");
      return;
    }
    tip.textContent = `${p.name} · ${p.ph.elements.primary}${p.ph.elements.secondary ? "/" + p.ph.elements.secondary : ""} · ${p.ph.sizeClass} · ${p.ph.kind}${p.owned ? " · yours" : ""}`;
    tip.style.setProperty("left", `${e.clientX - r.left}px`);
    tip.style.setProperty("top", `${e.clientY - r.top}px`);
    tip.classList.remove("hidden");
  }

  // ---------------------------------------------------------------- battles
  opponentTeam(o: BattleOptions, seed: number): Team {
    const mine = teamOf(this.profile);
    const avgLevel = Math.round(mine.reduce((s, g) => s + phenotypeOf(g).level, 0) / Math.max(1, mine.length));
    switch (o.opponent) {
      case "profile": {
        const p = this.store.get(o.opponentProfile ?? "") ?? this.store.list().find((x) => x.id !== this.profile.id);
        if (p) return { id: `team-${p.id}`, owner: p.id, name: `${p.name}'s team`, members: teamOf(p).map((g) => structuredClone(g)) };
        break;
      }
      case "mirror":
        return { id: "mirror", owner: "mirror", name: "Mirror", members: mine.map((g) => ({ ...structuredClone(g), id: g.id + "-m" })) };
      case "wild": {
        const pool = Array.from({ length: 6 }, (_, i) => createGenemon({ seed: hashSeed(seed, "wild", i), owner: "wild", level: avgLevel }));
        return autoTeam(pool, "wild", seed, "swarm");
      }
    }
    const pool = Array.from({ length: 9 }, (_, i) => createGenemon({ seed: hashSeed(seed, "rival", i), owner: "rival", level: avgLevel + 1 }));
    const t = autoTeam(pool, "rival", seed, "balanced");
    return { ...t, name: "Rival trainer" };
  }

  startBattle(o: BattleOptions): void {
    const seed = o.seed ?? (Date.now() % 2147483647);
    const mine = teamOf(this.profile);
    if (mine.length === 0) {
      toast("Your team is empty - add Genemon in the Team screen.");
      return;
    }
    const A: Team = { id: `team-${this.profile.id}`, owner: this.profile.id, name: `${this.profile.name}'s team`, members: mine };
    const B = this.opponentTeam(o, seed);
    const weather = o.weather === "auto" ? (ARENA_INFO[o.arena].weathers.includes(this.rw.weather) ? this.rw.weather : ARENA_INFO[o.arena].weathers[0]) : o.weather;
    const hour = o.hour === "real" ? this.hourNow() : o.hour;
    const battle = new Battle({ seed, arena: { seed, kind: o.arena, weather, hour }, teams: [A, B], ledger: this.ledger, when0: Date.now() });
    this.labView = null;
    this.genoView = null;
    const s = this.profile.settings;
    this.battleView = new BattleView(this.stage, battle, { shadows: s.shadows, quality: s.quality, shake: s.shake, speed: s.speed, camera: s.camera });
    this.battleView.onEvents((ev) => this.onBattleEvents(ev));
    this.stage.setView(this.battleView);
    this.lastBattle = { opts: o, seed };
    this.lastResult = null;
    this.feed = [];
    this.buildHud();
    this.buildViewTools();
    if (this.screen !== "arena") this.go("arena");
    else this.render();
  }

  closeBattle(): void {
    if (!this.battleView) return;
    this.battleView = null;
    this.stage.setView(null);
    $("#hud").classList.add("hidden");
    clear($("#view-tools"));
  }

  private onBattleEvents(ev: BattleEvent[]): void {
    const b = this.battleView?.battle;
    if (!b) return;
    const name = (i?: number) => (i === undefined ? "?" : b.fighters[i]?.name ?? "?");
    for (const e of ev) {
      let text = "";
      let color = hex(ELEMENTS[e.element ?? "neutral"].color);
      if (e.type === "hit" && e.label !== "conduction") text = `${name(e.a)} ${MOVE_BY_ID[e.move ?? ""]?.name ?? e.move} → ${name(e.b)} −${Math.round(e.value ?? 0)}${e.crit ? " CRIT!" : ""}`;
      else if (e.type === "hit") text = `⚡ current chains to ${name(e.b)} −${Math.round(e.value ?? 0)}`;
      else if (e.type === "ko") text = `💥 ${name(e.b)} is knocked out${e.a !== undefined ? ` by ${name(e.a)}` : ""}`;
      else if (e.type === "reaction") text = `✦ ${e.label} reaction`;
      else if (e.type === "clash") text = `✦ projectiles clash (${e.label})`;
      else if (e.type === "weather") text = `☁ weather → ${e.label}`;
      else if (e.type === "terrain") text = `▦ ground → ${e.label}`;
      else if (e.type === "lightning") text = `⚡ lightning strikes ${name(e.b)}`;
      else if (e.type === "fail") text = `✖ ${name(e.a)}: ${e.label}`;
      else if (e.type === "status" && ["frozen", "burrowed", "airborne", "liquid", "paralyzed"].includes(e.label ?? "")) text = `${name(e.a)} is ${e.label}`;
      else if (e.type === "end") {
        this.finishBattle();
        continue;
      }
      if (e.type === "ko") color = "#ff4d6d";
      if (text) this.feed.push({ text, color, t: performance.now() });
    }
    if (this.feed.length > 4) this.feed.splice(0, this.feed.length - 4);
  }

  private finishBattle(): void {
    const bv = this.battleView;
    if (!bv || this.lastResult) return;
    const b = bv.battle;
    const r = b.result();
    this.lastResult = r;
    const teams = b.setup.teams;
    // Only the player's own Genemon learn from this battle (opponents are copies or NPCs).
    applyBattleResult(r, [teams[0], { ...teams[1], members: [] }]);
    // Local Elo until the condition-aware ladder (src/ladder/mmr.ts) is integrated.
    const oppRating = this.lastBattle?.opts.opponent === "profile" ? (this.store.get(teams[1].owner)?.mmr ?? 1500) : 1500;
    const exp = 1 / (1 + Math.pow(10, (oppRating - this.profile.mmr) / 400));
    const score = r.winner === 2 ? 0.5 : r.winner === 0 ? 1 : 0;
    const delta = Math.round(24 * (score - exp));
    this.profile.mmr += delta;
    const st = this.profile.stats;
    st.battles++;
    if (r.winner === 0) st.wins++;
    else if (r.winner === 1) st.losses++;
    else st.draws++;
    this.profile.history.unshift({ when: Date.now(), arena: r.arena, weather: r.weatherStart, hour: Math.round(r.hour), won: r.winner, opponent: teams[1].name, duration: Math.round(r.duration), reactions: Object.values(r.reactions).reduce<number>((s, v) => s + (v ?? 0), 0), mvp: b.fighters.find((f) => f.id === r.mvp)?.name ?? "", mmrDelta: delta });
    this.profile.history = this.profile.history.slice(0, 60);
    this.save();
    this.render();
  }

  // ---------------------------------------------------------------- HUD
  private buildHud(): void {
    const hud = clear($("#hud"));
    hud.classList.remove("hidden");
    const b = this.battleView!.battle;
    const side = (t: 0 | 1) => h("div", { class: `hud-team ${t ? "right" : ""}` }, ...b.fighters.filter((f) => f.team === t).map((f) =>
      h("div", { class: "fcard", "data-f": f.idx },
        h("div", { class: "top" }, h("span", { class: "el", vars: { el: hex(ELEMENTS[f.types[0]].color) } }, f.types[0]), h("span", { class: "nm" }, `${f.name}`), h("span", { class: "size" }, f.ph.sizeClass), h("span", { class: "ph" }, "")),
        h("div", { class: "bars" }, h("div", { class: "bar hp" }, h("i", {})), h("div", { class: "bar en" }, h("i", {}))),
        h("div", { class: "st" }, ""))
    ));
    hud.append(h("div", { class: "hud-teams" }, side(0), side(1)), h("div", { class: "hud-bottom" }, h("div", { class: "hud-feed" }), h("div", { class: "hud-meta mono" })));
  }

  private buildViewTools(): void {
    const tools = clear($("#view-tools"));
    const modes: CameraMode[] = ["auto", "orbit", "top", "side", "low", "follow"];
    for (const m of modes) {
      tools.append(h("button", { class: `btn small ${this.profile.settings.camera === m ? "on" : ""}`, "data-cam": m, title: `Camera: ${m}`, onclick: () => {
        this.battleView?.setCameraMode(m);
        this.updateSettings({ camera: m });
        for (const b of tools.querySelectorAll<HTMLElement>("[data-cam]")) b.classList.toggle("on", b.dataset.cam === m);
      } }, m));
    }
    tools.append(h("button", { class: "btn small", title: "Pause / resume (Space)", onclick: () => this.togglePause() }, "⏯"));
  }

  togglePause(): void {
    this.stage.paused = !this.stage.paused;
    toast(this.stage.paused ? "Paused" : "Resumed", 900);
  }

  private hudLoop(): void {
    requestAnimationFrame(() => this.hudLoop());
    const now = performance.now();
    if (now - this.hudTimer < 90 || !this.battleView) return;
    this.hudTimer = now;
    const b = this.battleView.battle;
    for (const f of b.fighters) {
      const card = document.querySelector<HTMLElement>(`.fcard[data-f="${f.idx}"]`);
      if (!card) continue;
      card.classList.toggle("ko", f.ko);
      const hp = f.hp / f.maxHp;
      (card.querySelector(".hp i") as HTMLElement).style.setProperty("--w", `${(hp * 100).toFixed(1)}%`);
      (card.querySelector(".hp i") as HTMLElement).style.setProperty("--c", hp > 0.5 ? "#3ddc84" : hp > 0.25 ? "#ffd166" : "#ff4d6d");
      (card.querySelector(".en i") as HTMLElement).style.setProperty("--w", `${((f.energy / f.stats.energy) * 100).toFixed(1)}%`);
      (card.querySelector(".en i") as HTMLElement).style.setProperty("--c", "#4cc9f0");
      const ph = card.querySelector(".ph") as HTMLElement;
      ph.className = `ph ${f.phase}`;
      ph.textContent = f.ko ? "KO" : f.phase === "idle" ? "" : `${f.phase}${f.move ? " · " + f.move.name : ""}`;
      const st = [...f.status.keys()].join(" · ");
      const emo = f.emotions.anger > 0.55 ? "😠" : f.emotions.fear > 0.55 ? "😨" : f.emotions.joy > 0.7 ? "😄" : "";
      (card.querySelector(".st") as HTMLElement).textContent = [emo, st].filter(Boolean).join(" ");
    }
    const feed = document.querySelector(".hud-feed");
    if (feed) {
      clear(feed as HTMLElement);
      for (const x of this.feed) feed.append(h("div", { vars: { c: x.color } }, x.text));
    }
    const meta = document.querySelector(".hud-meta");
    if (meta) meta.textContent = `${ARENA_INFO[b.arena.spec.kind].name} · ${b.weatherDef.name} · ${String(Math.floor(b.setup.arena.hour)).padStart(2, "0")}h · t ${b.t.toFixed(1)}s${b.winner !== null ? " · END" : ""}`;
  }

  private key(e: KeyboardEvent): void {
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    if (e.code === "Space" && this.battleView) {
      e.preventDefault();
      this.togglePause();
    }
    const idx = ["Digit1", "Digit2", "Digit3", "Digit4", "Digit5", "Digit6"].indexOf(e.code);
    if (idx >= 0 && this.battleView) {
      const m = (["auto", "orbit", "top", "side", "low", "follow"] as CameraMode[])[idx];
      this.battleView.setCameraMode(m);
      this.updateSettings({ camera: m });
    }
  }

  // ---------------------------------------------------------------- QA / AI surface
  snapshot(): Record<string, unknown> {
    return {
      screen: this.screen,
      profile: { id: this.profile.id, name: this.profile.name, mmr: this.profile.mmr, collection: this.profile.collection.length, team: this.profile.team.length, theme: this.profile.settings.theme },
      view: this.stage.view?.snapshot?.() ?? null,
      ledger: { size: this.ledger.size, counts: this.ledger.counts() },
      realWorld: { hour: this.rw.hour, dayPhase: this.rw.dayPhase, season: this.rw.season, weather: this.rw.weather, device: this.rw.device },
      fps: this.stage.fps,
      frameMs: this.stage.frameMsAvg,
      frameMsMax: this.stage.frameMsMax,
    };
  }
}
