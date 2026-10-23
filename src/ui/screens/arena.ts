import type { App, BattleFormat, BattleOptions } from "../app.ts";
import { ARENA_INFO, ARENA_KINDS, type ArenaKind, type ArenaSpec, type ArenaSymmetry, generateArena, SPAWN_SLOTS } from "../../world/arena.ts";
import { hashSeed } from "../../core/rng.ts";
import { WEATHER_IDS, WEATHERS, type WeatherId } from "../../data/weather.ts";
import { $, fmt, h, section, select } from "../dom.ts";
import type { GroundId } from "../../data/grounds.ts";
import { ArenaPreview, drawArenaMinimap, minimapPick, SIDE_COLORS } from "../../render/arenaPreview.ts";
import { arenaStats, previewSeed } from "../../world/arenaStats.ts";
import { renderArenaDossier } from "../arenaDossier.ts";
import { renderGauntletPanel } from "../gauntletPanel.ts";
import { lootList } from "../icons.ts";
import { LEAGUES, type LeagueId } from "../../ladder/leagues.ts";
import { leagueLadder } from "../ladderStore.ts";
import { renderRankedPanel } from "../rankedPanel.ts";

const opts: BattleOptions = { arena: "meadow", weather: "auto", hour: "real", opponent: "rival", format: "brawl" };

/** Arena preview + dossier state [P4-A1]: survives panel re-renders; the highlight resets with the arena. */
const dossier: { open: boolean; topology: boolean; highlight: GroundId | null } = { open: true, topology: false, highlight: null };
let preview: ArenaPreview | null = null;

/**
 * Map choices [P5-W1]: the previewed layout IS the practice battle's map (passed as `arenaSeed`), with
 * its symmetry, prop density and the chosen start slot (`spawn`; the opponent starts on its image).
 */
export interface MapChoice {
  spawn?: number;
  arenaSeed?: number;
  symmetry?: ArenaSymmetry;
  density?: number;
}
const map: { reroll: number; spawn: number; symmetry: ArenaSymmetry; density: number } = { reroll: 0, spawn: 0, symmetry: "none", density: 1 };
const DENSITIES: { v: number; label: string }[] = [{ v: 0.4, label: "Sparse" }, { v: 1, label: "Normal" }, { v: 2, label: "Dense" }];

/** Seed of the previewed layout: the kind's representative layout until the player re-rolls it. */
function layoutSeed(k: ArenaKind): number {
  return map.reroll === 0 ? previewSeed(k) : hashSeed(previewSeed(k), "layout", map.reroll) % 2147483647;
}

function previewSpec(k: ArenaKind, weather: WeatherId, hour: number): ArenaSpec {
  return { seed: layoutSeed(k), kind: k, weather, hour, symmetry: map.symmetry, density: map.density };
}

/** Does this preview show exactly the chosen layout? */
function sameLayout(p: ArenaPreview | null, k: ArenaKind): p is ArenaPreview {
  const sp = p?.arena.spec;
  return !!sp && sp.kind === k && sp.seed === layoutSeed(k) && sp.symmetry === map.symmetry && sp.density === map.density;
}

/** Practice options + the map choice (typed so the extra fields pass before and after BattleOptions gains them). */
function withMap(o: BattleOptions): BattleOptions {
  const out: BattleOptions & MapChoice = { ...o, spawn: map.spawn, arenaSeed: layoutSeed(o.arena), symmetry: map.symmetry, density: map.density };
  return out;
}

function resolveWeather(app: App, k: ArenaKind): WeatherId {
  const ws = ARENA_INFO[k].weathers;
  return opts.weather !== "auto" ? opts.weather : ws.includes(app.rw.weather) ? app.rw.weather : ws[0];
}

/** The preview if it is still the stage's active view (another screen may have replaced it). */
function livePreview(app: App): ArenaPreview | null {
  return preview && app.stage.view === preview ? preview : null;
}

function showArenaPreview(app: App): void {
  const kind = opts.arena;
  if (sameLayout(livePreview(app), kind)) return;
  const s = app.profile.settings;
  const hour = opts.hour === "real" ? app.hourNow() : opts.hour;
  preview = new ArenaPreview(app.stage, previewSpec(kind, resolveWeather(app, kind), hour), { shadows: s.shadows, dark: s.theme === "dark", topology: dossier.topology, spawn: map.spawn });
  if (dossier.highlight) preview.setHighlight(dossier.highlight);
  app.mountView(preview);
}

/** Screen mount (registry): opening the Arena tab shows the selected arena from the outside. */
export function mountArena(app: App): void {
  showArenaPreview(app);
}

/** League of the last battle (BattleOptions.league; absent = Prime, the pre-pass-6 ladder). */
function lastLeague(app: App): LeagueId {
  return (app.lastBattle?.opts as { league?: LeagueId } | undefined)?.league ?? "prime";
}

/** Re-render the panel without losing its scroll position. */
function keepScroll(app: App): void {
  const panel = $("#panel");
  const y = panel.scrollTop;
  app.render();
  panel.scrollTop = y;
}

/** The previewed arena (the live preview's, or a fresh one with the same layout). */
function shownArena(app: App): { arena: ReturnType<typeof generateArena>; weather: WeatherId } {
  const p = livePreview(app);
  if (sameLayout(p, opts.arena)) return { arena: p.arena, weather: p.conditions.weather };
  const weather = resolveWeather(app, opts.arena);
  return { arena: generateArena(previewSpec(opts.arena, weather, 12)), weather };
}

/**
 * Map & start [P5-W1]: the top-down minimap (level bands, contours, water / lava, props, plateaus,
 * symmetry axis, both sides' start markers). Click a numbered marker (or a button) to choose where
 * your team starts; the opponent starts on its mirror / rotated image.
 */
function mapSection(app: App): HTMLElement {
  const { arena } = shownArena(app);
  const dark = app.profile.settings.theme !== "light";
  const canvas = h("canvas", { class: "wm5-minimap", width: 400, height: 400, "data-arena-minimap": arena.spec.kind, role: "img", "aria-label": `Top-down map of ${ARENA_INFO[arena.spec.kind].name}: ${arena.spawns.side0.length} start points per side` });
  let hover: number | null = null;
  const draw = () => drawArenaMinimap(canvas, arena, { spawn: map.spawn, hover, dark });
  const pick = (e: MouseEvent): number | null => {
    const r = canvas.getBoundingClientRect();
    if (!(r.width > 0)) return null;
    return minimapPick(arena, canvas.width, canvas.height, ((e.clientX - r.left) / r.width) * canvas.width, ((e.clientY - r.top) / r.height) * canvas.height);
  };
  const choose = (i: number) => {
    map.spawn = i;
    livePreview(app)?.setSpawn(i);
    keepScroll(app);
  };
  canvas.addEventListener("pointermove", (e) => {
    const i = pick(e);
    if (i === hover) return;
    hover = i;
    canvas.classList.toggle("wm5-pick", i !== null);
    draw();
  });
  canvas.addEventListener("pointerleave", () => {
    hover = null;
    canvas.classList.remove("wm5-pick");
    draw();
  });
  canvas.addEventListener("click", (e) => {
    const i = pick(e);
    if (i !== null) choose(i);
  });
  draw();
  const slot = SPAWN_SLOTS[map.spawn] ?? SPAWN_SLOTS[0];
  const symText: Record<ArenaSymmetry, string> = { none: "Free layout", mirror: "Mirror (left = right)", rotational: "Rotated 180°" };
  return section("Map & start",
    h("div", { class: "wm5-map" },
      canvas,
      h("div", { class: "wm5-side" },
        h("p", { class: "muted" }, "Click a numbered start point (", h("b", { class: "wm5-you", vars: { c: SIDE_COLORS[0] } }, "you"), ") to choose where your team opens the fight; the opponent (", h("b", { class: "wm5-you", vars: { c: SIDE_COLORS[1] } }, "n'"), ") starts on its image. The practice battle is fought on exactly this layout."),
        h("div", { class: "row wm5-spawns", role: "group", "aria-label": "Start point" }, ...SPAWN_SLOTS.map((sl, i) =>
          h("button", { class: `btn small ${map.spawn === i ? "on" : ""}`, type: "button", "data-spawn": i, "aria-pressed": String(map.spawn === i), title: `Start on the ${sl.label.toLowerCase()}`, onclick: () => choose(i) }, `${i + 1} · ${sl.label}`))),
        h("dl", { class: "kv" },
          h("dt", {}, "Start"), h("dd", {}, `${map.spawn + 1} · ${slot.label}`),
          h("dt", {}, "Altitude"), h("dd", {}, `${fmt(arena.altitudeM)} m above sea level`),
          h("dt", {}, "Levels"), h("dd", {}, `bands every ${fmt(arena.levelStep, 2)} m · ${arena.plateaus.length} plateau${arena.plateaus.length === 1 ? "" : "s"}`),
          h("dt", {}, "Cover"), h("dd", {}, `${arena.innerProps().filter((p) => p.solid).length} solid · ${arena.innerProps().filter((p) => !p.solid).length} soft props`),
          h("dt", {}, "Layout"), h("dd", { class: "mono" }, `#${layoutSeed(arena.spec.kind)} · ${symText[map.symmetry]}`)),
        h("div", { class: "row", role: "group", "aria-label": "Symmetry" }, ...(["none", "mirror", "rotational"] as const).map((sy) =>
          h("button", { class: `btn small ${map.symmetry === sy ? "on" : ""}`, type: "button", "data-symmetry": sy, "aria-pressed": String(map.symmetry === sy), title: sy === "none" ? "Free layout (ranked maps are always symmetric)" : `${symText[sy]}: neither side has an advantage`, onclick: () => {
            map.symmetry = sy;
            dossier.highlight = null;
            showArenaPreview(app);
            keepScroll(app);
          } }, symText[sy]))),
        h("div", { class: "row", role: "group", "aria-label": "Prop density" }, ...DENSITIES.map((d) =>
          h("button", { class: `btn small ${map.density === d.v ? "on" : ""}`, type: "button", "data-density": d.v, "aria-pressed": String(map.density === d.v), title: "Rocks, trees, crystals, pillars and ruins inside the ring: cover and obstacles", onclick: () => {
            map.density = d.v;
            showArenaPreview(app);
            keepScroll(app);
          } }, d.label)),
          h("button", { class: "btn small", type: "button", "data-action": "arena-reroll", title: "Another layout of this arena", onclick: () => {
            map.reroll++;
            dossier.highlight = null;
            showArenaPreview(app);
            keepScroll(app);
          } }, "🎲 New layout"),
          map.reroll ? h("button", { class: "btn small", type: "button", title: "Back to the arena's reference layout", onclick: () => {
            map.reroll = 0;
            showArenaPreview(app);
            keepScroll(app);
          } }, "Reference layout") : null),
        h("p", { class: "muted wm5-legend" }, "Shading = height level (lighter = higher), dark lines = level edges, dashed gold = plateau (white arrow = its ramp, pointing down), filled shapes = solid cover, hollow = soft cover, dashed white = symmetry axis."))));
}

function arenaDossier(app: App): HTMLElement {
  const { arena, weather } = shownArena(app);
  return renderArenaDossier(arenaStats(arena, weather), {
    open: dossier.open,
    topology: dossier.topology,
    highlight: dossier.highlight,
    onOpen: (open) => {
      dossier.open = open;
    },
    onWeather: (w) => {
      opts.weather = w;
      livePreview(app)?.setWeather(w);
      keepScroll(app);
    },
    onTopology: (on) => {
      dossier.topology = on;
      livePreview(app)?.setTopology(on);
    },
    onHighlight: (g) => {
      dossier.highlight = g;
      livePreview(app)?.setHighlight(g);
    },
  });
}

const FORMAT_HINT: Record<BattleFormat, string> = {
  brawl: "Everyone at once: the whole team fights together.",
  "1v1": "Stadium duel: one Genemon each on the field; the rest wait on the bench. Click a bench card in the HUD to throw it in.",
  "2v2": "Doubles: two on the field per side, the rest on the bench, thrown in on a KO or when you switch.",
  "3v3": "Triples: three on the field per side, with a bench.",
};

export function renderArena(app: App): HTMLElement {
  const bv = app.battleView;
  const res = app.lastResult;
  const root = h("div", {});
  if (bv && !res) {
    const b = bv.battle;
    root.append(
      h("h1", {}, app.lastBattle?.opts.ranked ? `Ranked battle · ${LEAGUES[lastLeague(app)].name}` : "Battle in progress"),
      h("p", {}, `${ARENA_INFO[b.arena.spec.kind].name} · started in ${WEATHERS[b.setup.arena.weather].name} · ${Math.floor(b.setup.arena.hour)}h (live weather: bottom of the 3D view). ${WEATHERS[b.setup.arena.weather].note}`),
      h("p", { class: "muted" }, `${b.arena.symmetry === "none" ? "Free layout" : b.arena.symmetry === "mirror" ? "Symmetric map (mirror)" : "Symmetric map (rotated 180°)"} · ${fmt(b.arena.altitudeM)} m altitude · ${b.arena.innerProps().filter((p) => p.solid).length} solid obstacles · ${b.arena.plateaus.length} plateau${b.arena.plateaus.length === 1 ? "" : "s"}.`),
      section("Controls",
        h("p", { class: "muted" }, "Camera buttons are on the right edge of the 3D view ", h("span", { class: "kbd-only" }, "(keys 1-6). Space pauses."), h("span", { class: "touch-only" }, "(tap them). ⏯ pauses.")),
        h("div", { class: "row" }, ...[0.5, 1, 2, 3].map((s) => h("button", { class: `btn small ${app.profile.settings.speed === s ? "on" : ""}`, onclick: () => app.updateSettings({ speed: s }) }, `${s}×`)),
          h("button", { class: "btn small", onclick: () => app.togglePause() }, "⏯ pause")),
        h("button", { class: "btn", onclick: () => {
          app.abandonBattle();
          app.go("arena");
        } }, app.lastBattle?.opts.ranked ? "Forfeit (counts as a loss)" : "Abandon practice battle")),
      section("Teams",
        ...b.setup.teams.map((t, i) => h("p", {}, h("b", {}, `${i === 0 ? "You" : "Opponent"}: `), `${t.name} - ${t.members.map((g) => g.name).join(", ")}`)),
        h("p", { class: "muted" }, `Synergies: ${b.synergies[0].map((s) => s.name).join(", ") || "none"} vs ${b.synergies[1].map((s) => s.name).join(", ") || "none"}`)),
    );
    return root;
  }
  if (res) {
    const b = bv?.battle;
    const won = res.winner === 0, draw = res.winner === 2;
    const rec = app.profile.history[0];
    root.append(
      h("h1", {}, draw ? "Draw" : won ? "Victory!" : "Defeat"),
      section("Result",
        h("dl", { class: "kv" },
          h("dt", {}, "Duration"), h("dd", {}, `${fmt(res.duration, 1)} s (${res.reason})`),
          h("dt", {}, "MVP"), h("dd", {}, b?.fighters.find((f) => f.id === res.mvp)?.name ?? "-"),
          h("dt", {}, "Reactions"), h("dd", {}, Object.entries(res.reactions).map(([k, v]) => `${k}×${v}`).join(", ") || "none"),
          h("dt", {}, "Weather"), h("dd", {}, res.weatherStart === res.weatherEnd ? res.weatherStart : `${res.weatherStart} → ${res.weatherEnd}`),
          ...(app.lastBattle?.opts.ranked
            ? [h("dt", {}, `${LEAGUES[lastLeague(app)].name} rating`), h("dd", { "data-result-league": lastLeague(app) }, rec ? `${rec.mmrDelta >= 0 ? "+" : ""}${rec.mmrDelta} → ${Math.round(leagueLadder(app, lastLeague(app)).rating(app.profile.id))}` : "-")]
            : [h("dt", {}, "Rating"), h("dd", {}, "unrated (practice)")]),
          h("dt", {}, "Loot"), h("dd", { "data-loot": "" }, lootList(app.lastLoot))),
        h("table", { class: "t" },
          h("tr", {}, h("th", {}, "Genemon"), h("th", {}, "Side"), h("th", {}, "Dealt"), h("th", {}, "Hits"), h("th", {}, "Crits"), h("th", {}, "KOs"), h("th", {}, "HP")),
          ...res.fighters.map((f) => h("tr", {}, h("td", {}, f.name), h("td", {}, f.team === 0 ? "you" : "opp"), h("td", {}, fmt(f.tally.dealt)), h("td", {}, `${f.tally.hits}/${f.tally.hits + f.tally.misses}`), h("td", {}, String(f.tally.crits)), h("td", {}, String(f.tally.kos)), h("td", {}, `${Math.round(f.hpFrac * 100)}%`))))),
      h("div", { class: "row" },
        app.lastBattle?.opts.opponent === "gauntlet" ? null : h("button", { class: "btn primary", title: "Replays the same seed: no XP, no rating", onclick: () => app.lastBattle && app.startBattle({ ...app.lastBattle.opts, seed: app.lastBattle.seed }) }, "↻ Rematch (same seed, unrated)"),
        h("button", { class: "btn", onclick: () => app.startBattle(withMap(opts)) }, "New battle"),
        h("button", { class: "btn", onclick: () => {
          app.closeBattle();
          app.lastResult = null;
          app.go("arena");
        } }, "Close")),
      h("p", { class: "muted" }, "Same seed + same teams = the same battle (deterministic replays: the basis of online anti-cheat)."),
    );
    if (app.lastBattle?.opts.opponent === "gauntlet") root.append(renderGauntletPanel(app, app.gauntletDeps()));
    return root;
  }
  const others = app.store.list().filter((p) => p.id !== app.profile.id);
  root.append(
    h("h1", {}, "Arena"),
    h("p", {}, "Instant battle: your team (in attack order) against an opponent, in a physical 3D arena with its own ground types, topography and weather."),
    section("Arena",
      // Compact picker (one click), then the dossier of the picked arena right under it: the
      // statistics are visible without scrolling past ten cards [P4-A1, P4-U1].
      h("div", { class: "row arena-pick" }, ...ARENA_KINDS.map((k) => h("button", { class: `btn small ${opts.arena === k ? "on" : ""}`, "data-arena": k, title: ARENA_INFO[k].note, onclick: () => {
        if (opts.arena !== k) {
          dossier.highlight = null;
          map.reroll = 0;
        }
        opts.arena = k as ArenaKind;
        showArenaPreview(app);
        keepScroll(app);
      } }, ARENA_INFO[k].name))),
      h("p", { class: "muted" }, ARENA_INFO[opts.arena].note),
      arenaDossier(app),
    ),
    mapSection(app),
    section("Conditions",
      h("div", { class: "grid2" },
        h("label", { class: "field" }, "Weather", select(["auto", ...WEATHER_IDS] as ("auto" | WeatherId)[], opts.weather, (v) => {
          opts.weather = v;
          livePreview(app)?.setWeather(resolveWeather(app, opts.arena));
          keepScroll(app);
        })),
        h("label", { class: "field" }, "Time of day", select(["real", "6", "9", "13", "18", "21", "0"], String(opts.hour), (v) => {
          opts.hour = v === "real" ? "real" : Number(v);
          livePreview(app)?.setHour(opts.hour === "real" ? app.hourNow() : opts.hour);
        }))),
      h("p", { class: "muted" }, opts.weather === "auto" ? `Auto uses today's real weather (${WEATHERS[app.rw.weather].name}) when it fits the arena.` : WEATHERS[opts.weather as WeatherId].note)),
    section("Format",
      h("div", { class: "row" }, ...(Object.keys(FORMAT_HINT) as BattleFormat[]).map((f) =>
        h("button", { class: `btn small ${opts.format === f ? "on" : ""}`, "data-format": f, title: FORMAT_HINT[f], onclick: () => {
          opts.format = f;
          app.render();
        } }, f === "brawl" ? "Brawl" : f))),
      h("p", { class: "muted" }, FORMAT_HINT[opts.format ?? "brawl"])),
    section("Opponent",
      h("label", { class: "field" }, "Who", select(["rival", "profile", "wild", "mirror"] as const, opts.opponent, (v) => {
        opts.opponent = v;
        app.render();
      })),
      opts.opponent === "profile" && others.length
        ? h("label", { class: "field" }, "Profile", select(others.map((p) => ({ value: p.id, label: `${p.name} (${Math.round(p.mmr)})` })), opts.opponentProfile ?? others[0].id, (v) => {
          opts.opponentProfile = v;
        }))
        : null,
      h("p", { class: "muted" }, { rival: "An AI trainer with a balanced team at your level.", profile: "Another profile's team (you vs me).", wild: "A swarm of wild Genemon.", mirror: "Your own team against itself.", gauntlet: "One Genemon against an endless line (use the Gauntlet panel below)." }[opts.opponent])),
    section("Ranked",
      renderRankedPanel(app, { opponent: opts.opponent === "profile" ? "profile" : "rival", opponentProfile: opts.opponent === "profile" ? (opts.opponentProfile ?? others[0]?.id) : undefined, spawn: map.spawn }),
      h("p", { class: "muted" }, `Rated battles move the chosen league's condition-aware rating. The ladder draws the arena; your real hour and today's weather apply. Each seed pays XP and rating once. Ranked maps are symmetric, so neither side starts on better ground; your start point (${map.spawn + 1} · ${(SPAWN_SLOTS[map.spawn] ?? SPAWN_SLOTS[0]).label.toLowerCase()}) applies. Opponent: ${opts.opponent === "profile" ? "the chosen profile" : "a rival trainer"}.`)),
    h("button", { class: "btn big", "data-action": "start-battle", title: "Practice: you pick the conditions, nothing is rated", onclick: () => app.startBattle(withMap(opts)) }, "⚔ Practice battle (unrated)"),
    renderGauntletPanel(app, app.gauntletDeps()),
  );
  return root;
}
