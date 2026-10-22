/**
 * App: the orchestrator. Real-world context (top) -> profile + settings -> screens (DOM panel) and
 * the 3D stage (one active view). Starts instant battles, renders the battle HUD, folds results
 * back into Genemon and profiles, and exposes a debug/QA surface on globalThis.__GENEMON__.
 */
import { Ledger } from "../core/ledger.ts";
import { hashSeed } from "../core/rng.ts";
import { Battle, type BattleEvent, type BattleResult, applyBattleResult } from "../combat/battle.ts";
import { autoTeam, type Team } from "../combat/team.ts";
import { ALL_MOVE_BY_ID as MOVE_BY_ID } from "../combat/kit.ts";
import { ELEMENTS } from "../data/elements.ts";
import { WEATHERS, type WeatherId } from "../data/weather.ts";
import { createGenemon, type Genemon, grantXp, phenotypeOf } from "../genome/genemon.ts";
import { abandonRun, arenaFor, battleSeed, GAUNTLET_OWNER, isBoss, opponentFor, recordRound, roundReward, startRun } from "../combat/gauntlet.ts";
import { GauntletStore } from "./gauntletStore.ts";
import type { GauntletDeps } from "./gauntletPanel.ts";
import { ARENA_INFO, type ArenaKind } from "../world/arena.ts";
import { BattleView, SIDE_COLORS } from "../render/battleView.ts";
import { isRated, rankedConditions } from "../ladder/ranked.ts";
import { getLadder, recordBattle } from "./ladderStore.ts";
import { getProgress, resetProgress } from "./progressStore.ts";
import { battleLoot } from "../economy/loot.ts";
import { addItems, bagOf } from "./bagStore.ts";
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
  opponent: "rival" | "profile" | "mirror" | "wild" | "gauntlet";
  opponentProfile?: string;
  seed?: number;
  /** Rated battle: conditions drawn by the ladder (App.startRanked), never picked. */
  ranked?: boolean;
  /**
   * Battle format [P4-B2]: brawl = everyone at once (legacy); 1v1 / 2v2 / 3v3 = that many on the
   * field per side, the rest on the bench, thrown in on a KO or switched by the trainer.
   */
  format?: BattleFormat;
  /** Override my side (e.g. the gauntlet champion alone) and/or the opponent team. */
  mine?: Genemon[];
  opponentTeam?: Team;
  /** Starting HP fraction per Genemon id (gauntlet carries HP between rounds). */
  startHp?: Record<string, number>;
}

export type BattleFormat = "brawl" | "1v1" | "2v2" | "3v3";
export const FORMAT_FIELD: Record<BattleFormat, number | undefined> = { brawl: undefined, "1v1": 1, "2v2": 2, "3v3": 3 };

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
  /** Drops of the last settled battle (shown on the result screen). */
  lastLoot: { itemId: string; qty: number; rarity: string }[] = [];
  lastBattle: { opts: BattleOptions; seed: number } | null = null;
  selected: string | null = null;
  private wild: Genemon[] | null = null;
  private gauntletStore: GauntletStore | null = null;
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
    // Achievements and quests follow every ledger row from now on (src/ui/progressStore.ts).
    getProgress(this);
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
    // Phones show 4 primary tabs + More (a sheet with the rest): nine 52-px tabs need 508 px and
    // cannot fit a 390-px phone. On wider screens the sheet is `display: contents` (a normal rail).
    const PRIMARY = new Set(["home", "arena", "team", "lab"]);
    const sheet = h("div", { class: "nav-sheet" });
    for (const s of SCREENS) {
      const b = h("button", {
        class: "nav-btn",
        "data-nav": s.id,
        title: s.hint,
        vars: { tab: s.color },
        onclick: () => {
          nav.classList.remove("open");
          this.go(s.id);
        },
      }, h("span", { class: "ico" }, s.icon), h("span", { class: "lbl" }, s.label));
      (PRIMARY.has(s.id) ? nav : sheet).append(b);
    }
    nav.append(
      sheet,
      h("button", { class: "nav-btn nav-more", title: "World, Market, Ladder, Feats, Data, Settings", onclick: () => nav.classList.toggle("open") }, h("span", { class: "ico" }, "⋯"), h("span", { class: "lbl" }, "More")),
    );
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
    resetProgress();
    this.profile = p;
    this.selected = null;
    this.applyTheme();
    getProgress(this);
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
      case "gauntlet": {
        const run = this.gauntlet().current();
        const champ = run ? this.profile.collection.find((g) => g.id === run.championId) : undefined;
        if (run && champ) return { id: `gauntlet-${run.id}-${run.round}`, owner: GAUNTLET_OWNER, name: `Gauntlet round ${run.round}${isBoss(run.round) ? " (boss)" : ""}`, members: [opponentFor(run, phenotypeOf(champ).level)] };
        break;
      }
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
    const gRun = o.opponent === "gauntlet" ? this.gauntlet().current() : null;
    const mine = o.mine ?? (o.opponent === "gauntlet" ? this.profile.collection.filter((g) => g.id === gRun?.championId) : teamOf(this.profile));
    if (mine.length === 0) {
      toast("Your team is empty - add Genemon in the Team screen.");
      return;
    }
    const A: Team = { id: `team-${this.profile.id}`, owner: this.profile.id, name: `${this.profile.name}'s team`, members: mine };
    const B = o.opponentTeam ?? this.opponentTeam(o, seed);
    const weather = o.weather === "auto" ? (ARENA_INFO[o.arena].weathers.includes(this.rw.weather) ? this.rw.weather : ARENA_INFO[o.arena].weathers[0]) : o.weather;
    const hour = o.hour === "real" ? this.hourNow() : o.hour;
    const battle = new Battle({ seed, arena: { seed, kind: o.arena, weather, hour }, teams: [A, B], ledger: this.ledger, when0: Date.now(), field: FORMAT_FIELD[o.format ?? "brawl"], startHp: o.startHp ?? (gRun ? { [gRun.championId]: gRun.hpCarry } : undefined) });
    this.labView = null;
    this.genoView = null;
    const s = this.profile.settings;
    this.battleView = new BattleView(this.stage, battle, { shadows: s.shadows, quality: s.quality, shake: s.shake, speed: s.speed, camera: s.camera });
    this.battleView.onEvents((ev) => this.onBattleEvents(ev));
    this.stage.setView(this.battleView);
    this.lastBattle = { opts: o, seed };
    this.lastResult = null;
    this.lastLoot = [];
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
      if (e.type === "hit" && !e.label?.startsWith("conduction")) text = `${name(e.a)} ${MOVE_BY_ID[e.move ?? ""]?.name ?? e.move} → ${name(e.b)} −${Math.round(e.value ?? 0)}${e.crit ? " CRIT!" : ""}`;
      else if (e.type === "hit") text = `⚡ current chains to ${name(e.b)} −${Math.round(e.value ?? 0)}${e.label === "conduction (ally)" ? " (friendly fire)" : ""}`;
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
      // KO lines by side: losing one of yours is red, knocking out a rival is gold.
      if (e.type === "ko") color = e.b !== undefined && this.battleView?.battle.fighters[e.b]?.team === 0 ? "#ff4d6d" : "#ffd166";
      if (text) this.feed.push({ text, color, t: performance.now() });
    }
    if (this.feed.length > 4) this.feed.splice(0, this.feed.length - 4);
  }

  private finishBattle(forfeit = false): void {
    const bv = this.battleView;
    if (!bv || this.lastResult) return;
    const b = bv.battle;
    const r: BattleResult = forfeit ? { ...b.result(), winner: 1, reason: "forfeit" } : b.result();
    this.lastResult = r;
    const teams = b.setup.teams;
    const opts = this.lastBattle?.opts;
    const seed = b.setup.seed;
    const paid = (this.profile.rewardedSeeds ??= []);
    const fresh = !paid.includes(seed);
    const ranked = !!opts && isRated(opts, seed, paid);
    // Rate FIRST: the condition-aware ladder reads only pre-match information, and applyBattleResult
    // below changes the Genemon (xp, records, so phenotypes).
    let delta = 0;
    if (ranked) {
      const rating = recordBattle(this, r, [teams[0], teams[1]], b.setup.arena);
      if (rating.rated) {
        const ladder = getLadder(this);
        delta = Math.round(rating.deltaA);
        this.profile.mmr = Math.round(ladder.rating(this.profile.id));
        const opp = opts?.opponent === "profile" ? this.store.get(teams[1].owner) : undefined;
        if (opp) {
          opp.mmr = Math.round(ladder.rating(opp.id));
          this.store.save(opp);
        }
      }
    }
    // XP and W/L are paid once per seed (X1); an abandoned PRACTICE battle pays and costs nothing.
    if (fresh && (!forfeit || ranked)) {
      // Only the player's own Genemon learn from this battle (opponents are copies or NPCs).
      if (!forfeit) applyBattleResult(r, [teams[0], { ...teams[1], members: [] }]);
      this.profile.rewardedSeeds = [seed, ...paid].slice(0, 300);
      const st = this.profile.stats;
      st.battles++;
      if (r.winner === 0) st.wins++;
      else if (r.winner === 1) st.losses++;
      else st.draws++;
      // Loot (P4-E1): paid once per seed like XP; read the streak BEFORE this battle joins history.
      if (!forfeit) {
        let streak = 0;
        while (streak < this.profile.history.length && this.profile.history[streak].won === 0) streak++;
        const won = r.winner === 0;
        const drops = battleLoot({
          seed,
          arena: r.arena,
          won,
          streak: won ? streak + 1 : 0,
          opponentLevel: Math.max(1, ...teams[1].members.map((m) => phenotypeOf(m).level)),
          dayIndex: Math.floor(Date.now() / 86_400_000),
          boss: opts?.opponent === "gauntlet" && teams[1].name.includes("boss"),
        });
        this.profile.bag = addItems(bagOf(this.profile), drops);
        this.lastLoot = drops;
        this.ledger.emit({
          when: Date.now(),
          where: { x: 0, y: 0, z: 0, zone: r.arena, space: "arena" },
          who: this.profile.id,
          what: "bag.loot",
          why: won ? "battle won" : "consolation drop",
          from: teams[1].owner,
          to: this.profile.id,
          entries: { seed, won, items: drops.map((d) => `${d.itemId}x${d.qty}`).join(",") },
          exits: { drops: drops.length, units: drops.reduce((s, d) => s + d.qty, 0) },
        });
      }
    }
    const kind = forfeit ? "forfeit" : ranked ? "ranked" : fresh ? "practice" : "replay";
    this.profile.history.unshift({ when: Date.now(), arena: r.arena, weather: r.weatherStart, hour: Math.round(r.hour), won: r.winner, opponent: teams[1].name, duration: Math.round(r.duration), reactions: Object.values(r.reactions).reduce<number>((s, v) => s + (v ?? 0), 0), mvp: b.fighters.find((f) => f.id === r.mvp)?.name ?? "", mmrDelta: delta, kind });
    this.profile.history = this.profile.history.slice(0, 60);
    this.ledger.emit({
      when: Date.now(),
      where: { x: 0, y: 0, z: 0, zone: r.arena, space: "arena" },
      who: this.profile.id,
      what: "battle.settled",
      why: `${kind}: ${ranked ? "rated by the condition-aware ladder" : fresh ? "unrated, first play of this seed" : "unrated replay"}`,
      from: this.profile.id,
      to: teams[1].owner,
      entries: { seed, ranked, fresh, forfeit, kind },
      exits: { mmrDelta: delta, mmr: this.profile.mmr, winner: r.winner },
    });
    if (opts?.opponent === "gauntlet") this.settleGauntlet(r, teams[1], seed);
    this.save();
    this.render();
  }

  // ---------------------------------------------------------------- gauntlet (P4-B1)
  /** The active profile's gauntlet store (re-targeted when the profile changes). */
  gauntlet(): GauntletStore {
    if (!this.gauntletStore || this.gauntletStore.profileId !== this.profile.id) this.gauntletStore = new GauntletStore(localStorage, this.profile.id);
    return this.gauntletStore;
  }

  gauntletDeps(): GauntletDeps {
    return { store: this.gauntlet(), start: (id) => this.startGauntlet(id), next: () => this.nextGauntlet(), abandon: () => this.abandonGauntlet() };
  }

  /** New run with one champion (a live run is given up first), then its first fight. */
  startGauntlet(championId: string): void {
    const champ = this.profile.collection.find((g) => g.id === championId);
    if (!champ) return;
    const gs = this.gauntlet(), now = Date.now();
    const old = gs.current();
    if (old?.alive) {
      const done = gs.finish(abandonRun(old), now);
      this.endGauntlet(done.id, done.streak, true);
    }
    const run = startRun(champ, this.profile.id, hashSeed(this.profile.id, champ.id, now), now);
    gs.setCurrent(run);
    this.ledger.emit({ when: now, where: { x: 0, y: 0, z: 0, zone: "gauntlet", space: "arena" }, who: this.profile.id, what: "gauntlet.start", why: "player started a gauntlet run", from: this.profile.id, to: champ.id, entries: { run: run.id, level: run.startLevel }, exits: { round: run.round, hpCarry: run.hpCarry } });
    this.nextGauntlet();
  }

  /** Fight the current run's next round: champion alone, carried HP, round seed and arena from the run. */
  nextGauntlet(): void {
    const run = this.gauntlet().current();
    if (!run?.alive) return;
    this.startBattle({ arena: arenaFor(run), weather: "auto", hour: "real", opponent: "gauntlet", seed: battleSeed(run) });
  }

  abandonGauntlet(): void {
    const gs = this.gauntlet(), run = gs.current();
    if (!run) return;
    const done = gs.finish(abandonRun(run), Date.now());
    this.endGauntlet(done.id, done.streak, true);
    this.render();
  }

  private endGauntlet(runId: string, streak: number, gaveUp: boolean): void {
    const best = this.gauntlet().recent().find((r) => r.id === runId);
    this.ledger.emit({ when: Date.now(), where: { x: 0, y: 0, z: 0, zone: "gauntlet", space: "arena" }, who: this.profile.id, what: "gauntlet.end", why: gaveUp ? "player gave up" : "round lost or drawn", from: this.profile.id, to: best?.championId ?? "", entries: { run: runId, gaveUp }, exits: { streak, score: best?.score ?? 0, rounds: best?.history.length ?? 0 } });
  }

  /** Fold a finished gauntlet battle into its run. Only the battle of the run's CURRENT round counts (a rematch of an old seed changes nothing). */
  private settleGauntlet(r: BattleResult, opp: Team, seed: number): void {
    const gs = this.gauntlet(), run = gs.current();
    if (!run || !run.alive || seed !== battleSeed(run)) return;
    const round = run.round, foe = opp.members[0], level = foe ? phenotypeOf(foe).level : 0;
    const won = r.winner === 0;
    const next = recordRound(run, { won, hpFrac: r.fighters.find((f) => f.id === run.championId)?.hpFrac ?? r.hpFrac[0], opponent: foe?.name ?? "?", level, durationS: r.duration });
    const pay = won ? roundReward(round) : { credits: 0, xp: 0 };
    const champ = this.profile.collection.find((g) => g.id === run.championId);
    if (won) {
      this.profile.credits += pay.credits;
      if (champ) grantXp(champ, pay.xp, { ledger: this.ledger, who: this.profile.id, why: "gauntlet round won" });
    }
    this.ledger.emit({ when: Date.now(), where: { x: 0, y: 0, z: 0, zone: r.arena, space: "arena" }, who: this.profile.id, what: "gauntlet.round", why: won ? "round won: HP carries over" : "round lost or drawn: the run ends", from: run.championId, to: foe?.id ?? GAUNTLET_OWNER, entries: { run: run.id, round, boss: isBoss(round), level, hpStart: run.hpCarry }, exits: { won, streak: next.streak, hpCarry: next.hpCarry, credits: pay.credits, xp: pay.xp, alive: next.alive } });
    if (next.alive) gs.setCurrent(next);
    else {
      gs.finish(next, Date.now());
      this.endGauntlet(next.id, next.streak, false);
      toast(`Gauntlet over: ${run.championName} won ${next.streak} round(s).`);
    }
  }

  /** Leave a running battle. A RANKED battle abandoned after it started is a forfeit loss (X1). */
  abandonBattle(): void {
    const b = this.battleView?.battle;
    if (b && b.winner === null && b.t > 0 && this.lastBattle?.opts.ranked) this.finishBattle(true);
    this.closeBattle();
  }

  /** A rated battle: the ladder draws the arena and seed; the hour and (when it fits) the weather are real (X6). */
  startRanked(opponent: "rival" | "profile" = "rival", opponentProfile?: string): void {
    const d = rankedConditions(this.profile.id, this.profile.stats.battles, Math.floor(Date.now() / 86_400_000), this.hourNow(), this.rw.weather);
    this.startBattle({ arena: d.arena, weather: d.weather, hour: d.hour, opponent, opponentProfile, seed: d.seed, ranked: true });
  }

  // ---------------------------------------------------------------- HUD
  private buildHud(): void {
    const hud = clear($("#hud"));
    hud.classList.remove("hidden");
    const b = this.battleView!.battle;
    const opp = b.setup.teams[1];
    const side = (t: 0 | 1) => h("div", { class: `hud-team ${t ? "right" : ""}`, vars: { side: SIDE_COLORS[t] } },
      h("div", { class: "hud-head" }, t === 0 ? "YOU" : `RIVAL · ${opp.name}`),
      ...b.fighters.filter((f) => f.team === t).map((f) =>
        h("div", {
          class: "fcard",
          "data-f": f.idx,
          title: `${f.name} · size ${f.ph.sizeClass} (${f.ph.slots} slot${f.ph.slots > 1 ? "s" : ""}) · ${f.types.join("/")}${t === 0 && b.setup.field ? " · on the bench: click to throw it in" : ""}`,
          onclick: t === 0 ? () => this.switchIn(f.idx) : undefined,
        },
          h("div", { class: "top" }, h("span", { class: "el", vars: { el: hex(ELEMENTS[f.types[0]].color) } }, f.types[0]), h("span", { class: "nm" }, `${f.name}`), h("span", { class: "ph" }, "")),
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

  /**
   * Throw a benched Genemon of mine into the field [P4-B2]: it replaces the active fighter with the
   * lowest HP share (the one that most needs a rest). One click on its HUD card.
   */
  switchIn(benchIdx: number): void {
    const b = this.battleView?.battle;
    if (!b) return;
    const inn = b.fighters[benchIdx];
    if (!inn || inn.team !== 0 || !inn.benched) return;
    const out = b.fighters.filter((f) => f.team === 0 && !f.benched && !f.ko).sort((x, y) => x.hp / x.maxHp - y.hp / y.maxHp)[0];
    if (!out) return;
    const r = b.requestSwitch(0, out.idx, inn.idx);
    toast(r.ok ? `${out.name}, come back! Go, ${inn.name}!` : `Cannot switch: ${r.why}`, 1400);
    this.log("battle.switch.request", r.ok ? "trainer switched" : r.why, inn.id, `${out.name} -> ${inn.name}`);
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
    // Tell the camera how much of the frame the top HUD cards cover, so it frames fighters below them.
    const vp = $("#viewport").getBoundingClientRect(), teams = document.querySelector<HTMLElement>("#hud .hud-teams");
    if (teams && vp.height > 0) this.battleView.setHudTop((teams.getBoundingClientRect().bottom - vp.top) / vp.height);
    for (const f of b.fighters) {
      const card = document.querySelector<HTMLElement>(`.fcard[data-f="${f.idx}"]`);
      if (!card) continue;
      card.classList.toggle("ko", f.ko);
      card.classList.toggle("bench", f.benched && !f.ko);
      const hp = f.hp / f.maxHp;
      (card.querySelector(".hp i") as HTMLElement).style.setProperty("--w", `${(hp * 100).toFixed(1)}%`);
      (card.querySelector(".hp i") as HTMLElement).style.setProperty("--c", hp > 0.5 ? "#3ddc84" : hp > 0.25 ? "#ffd166" : "#ff4d6d");
      (card.querySelector(".en i") as HTMLElement).style.setProperty("--w", `${((f.energy / f.stats.energy) * 100).toFixed(1)}%`);
      (card.querySelector(".en i") as HTMLElement).style.setProperty("--c", "#4cc9f0");
      const ph = card.querySelector(".ph") as HTMLElement;
      ph.className = `ph ${f.phase}`;
      ph.textContent = f.ko ? "KO" : f.benched ? "bench ↥" : f.phase === "idle" ? "" : `${f.phase}${f.move ? " · " + f.move.name : ""}`;
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
