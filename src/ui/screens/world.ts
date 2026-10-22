/**
 * World screen: the 3D neighbourhood map (WorldView) plus the panel that acts on it. Places sit at
 * real lat/lon around your home; you discover them, claim and defend territory cells, shop and
 * train in person, battle at arenas, and catch or release Genemon that shift the local spawns.
 *
 * Presence: there is no real GPS yet (the strict CSP keeps the app offline). A clearly labelled
 * "Simulated GPS: I am physically here" toggle (default OFF) stands in for it; while it is off,
 * every physical-only action is refused and the engine's own reason is shown. Arenas, stadiums,
 * dungeons, portals, museums and libraries stay reachable through the virtual space.
 */
import type { App } from "../app.ts";
import { distXZ, type V3 } from "../../core/math.ts";
import { ELEMENTS } from "../../data/elements.ts";
import { GROUNDS } from "../../data/grounds.ts";
import { WEATHERS, type WeatherId } from "../../data/weather.ts";
import { phenotypeOf } from "../../genome/genemon.ts";
import { CONTOUR_M, MAP_SIZE_M, PLACE_COLORS, WorldView } from "../../render/worldView.ts";
import { type Place, PLACE_KIND_DEFS, type PlaceKind, type Rarity, type Verdict, type WorldMap } from "../../world/worldmap.ts";
import { bar, fmt, h, hex, pct, section, select, toast } from "../dom.ts";
import { elChip, genemonCard } from "../widgets.ts";
import {
  aOrAn,
  applyBuyFood,
  applyCatch,
  applyClaim,
  applyDefend,
  applyDiscover,
  applyRelease,
  applyTrain,
  battlePlan,
  type Candidate,
  catchVerdict,
  ecologyAt,
  ensureNeighbourhood,
  fmtDistance,
  getWorld,
  homeOf,
  type KindAction,
  kindAction,
  lookForWild,
  type MoveResult,
  moveAvatar,
  placeStatus,
  type PlaceStatus,
  presentAt,
  record,
  releaseVerdict,
  resolveAvatar,
  saveWorld,
  teamMembers,
  teamPower,
  topSpawns,
  visiblePlaces,
  type WorldSession,
  worldSession,
} from "../worldStore.ts";

/** The mounted map, so renderWorld can refresh / focus it (checked against the stage before use). */
let view: WorldView | null = null;

const MAX_LIST = 30;
const RARITY_COLORS: Record<Rarity, string> = { common: "#8d99ae", uncommon: "#2a9d8f", rare: "#0096c7", epic: "#9b5de5", legendary: "#e09f3e" };

interface Ready {
  world: WorldMap;
  s: WorldSession;
  home: Place;
  avatar: Place;
}

interface Ctx extends Ready {
  app: App;
  now: number;
  hour: number;
  weather: WeatherId;
  units: "metric" | "imperial";
  power: number;
  act: <V extends Verdict>(label: string, run: () => V, after?: (v: V) => void) => () => void;
}

/** World + this profile's neighbourhood + session, created on first use (saved when anything was generated). */
function ready(app: App): Ready | null {
  const world = getWorld(app);
  const before = world.places().length;
  ensureNeighbourhood(world, app.profile.id, Date.now(), app.profile.home);
  if (world.places().length !== before) saveWorld(localStorage, world);
  const s = worldSession(app.profile.id);
  const home = homeOf(world, app.profile.id);
  const avatar = resolveAvatar(world, s, app.profile.id);
  return home && avatar ? { world, s, home, avatar } : null;
}

/** The mounted view, only while it is the stage's active view for this world and profile. */
function liveView(app: App, world: WorldMap): WorldView | null {
  return view && app.stage.view === view && view.world === world && view.profileId === app.profile.id ? view : null;
}

export function mountWorld(app: App): void {
  const r = ready(app);
  if (!r) return;
  const dark = app.profile.settings.theme === "dark";
  const live = liveView(app, r.world);
  if (live) {
    live.setTheme(dark);
    live.refresh();
    live.setAvatar(r.avatar.id);
    return;
  }
  view = new WorldView(app.stage, r.world, { dark, centre: r.home.pos, profileId: app.profile.id });
  app.mountView(view);
  view.setAvatar(r.avatar.id);
}

export function renderWorld(app: App): HTMLElement {
  const r = ready(app);
  if (!r) return h("div", {}, h("h1", {}, "World"), h("p", {}, "The world map could not be prepared for this profile."));
  liveView(app, r.world)?.setTheme(app.profile.settings.theme === "dark");
  const c: Ctx = {
    ...r,
    app,
    now: Date.now(),
    hour: app.hourNow(),
    weather: app.rw.weather,
    units: app.profile.settings.units,
    power: teamPower(teamMembers(app.profile)),
    act: (label, run, after) => () => {
      const at = Date.now();
      let v: Verdict;
      try {
        const out = run();
        v = out;
        after?.(out);
      } catch (e) {
        v = { ok: false, reason: e instanceof Error ? e.message : String(e) };
      }
      record(r.s, label, v, at);
      saveWorld(localStorage, r.world);
      toast(`${v.ok ? "✓" : "✖"} ${label}: ${v.reason}`, 3600);
      liveView(app, r.world)?.refresh();
      app.render();
    },
  };
  return h("div", {},
    h("h1", {}, "World"),
    h("p", {}, "Your neighbourhood as a living map: x east, y altitude, z north (on the map 1 unit = 25 m, heights ×3). Claim and defend territory, shop and train in person, discover places, and catch or release Genemon that change what spawns here. Arenas, stadiums, dungeons, portals, museums and libraries are reachable virtually."),
    h("p", { class: "muted" }, `Relief: lighter = higher, contour lines every ${CONTOUR_M} m (bold every ${CONTOUR_M * 5} m), ▲ peaks and ▼ hollows labelled with their altitude; trees, rocks and scrub show the natural cover.`),
    whereSection(c),
    activitySection(c.s),
    wildSection(c),
    releaseSection(c),
    placesSection(c),
  );
}

// ---------------------------------------------------------------- sections

function whereSection(c: Ctx): HTMLElement {
  const { world, s, avatar } = c;
  const st = placeStatus(world, s, c.app.profile.id, avatar, c.now);
  const presence = s.gps ? "physically here (simulated GPS)" : st.yourHome ? "at home, your base in the virtual space" : "your avatar is here in the virtual space";
  return section("Where you are",
    h("dl", { class: "kv" },
      h("dt", {}, "Place"), h("dd", {}, placeTitle(avatar)),
      h("dt", {}, "Presence"), h("dd", {}, presence),
      h("dt", { title: "Centre of the place (homes are stored as their 250 m cell centre)" }, "Lat, lon"), h("dd", { class: "mono" }, `${avatar.lat.toFixed(5)}, ${avatar.lon.toFixed(5)}`),
      h("dt", { title: `Local ENU metres from the world origin ${world.origin.lat.toFixed(4)}, ${world.origin.lon.toFixed(4)}` }, "x, y, z"),
      h("dd", { class: "mono" }, xyz(avatar.pos)),
      h("dt", {}, "Ground"), h("dd", {}, GROUNDS[world.groundAt(avatar.pos)].name),
      h("dt", { title: "Terrain altitude of the place centre, relative to the world's reference level" }, "Altitude"), h("dd", {}, altitudeText(c, avatar)),
      h("dt", {}, "Territory"), h("dd", {}, territoryText(c, st)),
      h("dt", { title: "Sum of your team's power index: the garrison you claim or defend with" }, "Team power"), h("dd", {}, fmt(c.power)),
      h("dt", {}, "Hour · weather"), h("dd", {}, `${hourLabel(c.hour)} · ${WEATHERS[c.weather].name}`)),
    h("label", { class: "row", title: "There is no real GPS yet: this is your own declaration" },
      h("input", {
        type: "checkbox",
        "data-world": "gps",
        checked: s.gps,
        onchange: (e: Event) => {
          s.gps = (e.target as HTMLInputElement).checked;
          c.app.log("ui.world.simulatedGps", s.gps ? "user declared physical presence (simulated GPS, no real fix)" : "simulated GPS switched off", avatar.id, s.gps ? "on" : "off");
          record(s, "Simulated GPS", { ok: true, reason: s.gps ? `ON: you declare you are physically at ${avatar.name}` : "OFF: physical-only actions are refused" }, Date.now());
          c.app.render();
        },
      }),
      h("b", {}, "Simulated GPS: I am physically here")),
    h("p", { class: "muted" }, "No real GPS yet: the app runs offline (strict CSP). While this is OFF, physical-only actions (claims, shopping, gym, check-ins, on-site and rare catches, releases) are refused with the engine's reason. Turning it ON is your own declaration that you stand at the place above; nothing verifies it."),
    h("div", { class: "row" },
      h("button", { class: "btn small", onclick: () => liveView(c.app, world)?.focus(avatar.id) }, "◎ Show me on the map"),
      st.yourHome ? null : h("button", { class: "btn small", "data-world": "home", onclick: goAct(c, c.home, "Back home") }, "⌂ Back home")));
}

function wildSection(c: Ctx): HTMLElement {
  const { world, s, avatar } = c;
  const sensitive = world.sensitivePlaceAt(avatar.pos);
  const top = topSpawns(world.spawnTable(avatar.pos, c.hour, c.weather, c.now), 6);
  const max = top[0]?.weight ?? 1;
  const eco = ecologyAt(world, avatar.pos, c.now);
  const cand = s.candidate && s.candidate.placeId === avatar.id ? s.candidate : null;
  return section(`Wild Genemon at ${avatar.name}`,
    h("p", { class: "muted" }, `Spawn odds now (${hourLabel(c.hour)}, ${WEATHERS[c.weather].name}): place × ground × time of day × weather × local ecology.`),
    ...top.map((e) =>
      h("div", { class: "row" }, elChip(e.element), h("div", { class: "spacer" }, bar(e.weight / max, hex(ELEMENTS[e.element].color))), h("span", { class: "mono muted" }, pct(e.share)))
    ),
    h("p", { class: "muted" }, eco.length
      ? `Ecology here (releases +, catches −, fading over days): ${eco.slice(0, 5).map((e) => `${ELEMENTS[e.element].name} ${e.influence > 0 ? "+" : ""}${e.influence.toFixed(2)}`).join(", ")}`
      : "Ecology here: untouched. Releasing seeds an element here; catching thins it."),
    sensitive
      ? h("p", { class: "muted" }, `No wild Genemon at ${aOrAn(sensitive.kind)}: sensitive places are skipped.`)
      : h("button", { class: "btn primary", "data-world": "look", onclick: c.act("Look for wild Genemon", () => lookForWild(world, s, avatar, c.app.hourNow(), c.app.rw.weather, Date.now())) }, "🔍 Look for wild Genemon"),
    cand ? candidateBlock(c, cand) : null,
    h("p", { class: "muted" }, "Rare, epic and legendary spawns can only be caught on site. From the virtual space you can catch common and uncommon ones inside a dungeon or a portal."));
}

function candidateBlock(c: Ctx, cand: Candidate): HTMLElement {
  const v = catchVerdict(c.world, c.avatar, cand.spawn.rarity, presentAt(c.s, c.avatar.id), c.app.profile.id);
  return h("div", {},
    h("div", { class: "cards" }, genemonCard(cand.genemon)),
    h("dl", { class: "kv" },
      h("dt", {}, "Spawn"), h("dd", {}, h("span", { class: "row" }, elChip(cand.spawn.element), h("span", { class: "el", vars: { el: RARITY_COLORS[cand.spawn.rarity] } }, cand.spawn.rarity), `Lv ${cand.spawn.level}`)),
      h("dt", {}, "Catch"), h("dd", {}, v.ok ? `allowed (${v.reason})` : `refused: ${v.reason}`)),
    h("div", { class: "row" },
      h("button", { class: "btn primary", "data-world": "catch", onclick: c.act("Catch", () => applyCatch(c.world, c.s, c.app.profile, Date.now(), c.app.ledger), (r) => r.ok && c.app.save()) }, "Catch"),
      h("button", { class: "btn", "data-world": "ignore", onclick: c.act("Ignore", (): Verdict => {
        c.s.candidate = null;
        return { ok: true, reason: "it wandered off" };
      }) }, "Ignore")));
}

function releaseSection(c: Ctx): HTMLElement {
  const p = c.app.profile;
  const chosen = p.collection.find((g) => g.id === c.app.selected) ?? c.app.selectedGenemon();
  if (!chosen) return section("Release a Genemon here", h("p", { class: "muted" }, "No Genemon to release."));
  const v = releaseVerdict(c.world, c.s, p, chosen.id);
  const el = phenotypeOf(chosen).elements.primary;
  return section("Release a Genemon here",
    h("p", { class: "muted" }, `A released Genemon seeds its element in this ~100 m cell (+1 influence, half-life 2 days): ${ELEMENTS[el].name.toLowerCase()} spawns rise here for everyone. On site only.`),
    h("div", { class: "row" },
      select(p.collection.map((g) => ({ value: g.id, label: `${g.name} · ${phenotypeOf(g).elements.primary} · Lv ${phenotypeOf(g).level}` })), chosen.id, (id) => {
        c.app.selected = id;
        c.app.render();
      }),
      h("button", { class: "btn", "data-world": "release", onclick: c.act(`Release ${chosen.name}`, () => applyRelease(c.world, c.s, p, chosen.id, Date.now(), c.app.ledger), (r) => {
        if (!r.ok) return;
        c.app.selected = null;
        c.app.save();
      }) }, `Release ${chosen.name}`)),
    h("p", { class: "muted" }, v.ok ? `Allowed at ${c.avatar.name}.` : `Refused here: ${v.reason}`));
}

function placesSection(c: Ctx): HTMLElement {
  const list = visiblePlaces(c.world, c.app.profile.id, c.avatar.pos, c.home.pos, MAP_SIZE_M / 2);
  const shown = list.slice(0, MAX_LIST);
  return section(`Places (${list.length}, nearest first)`,
    h("p", { class: "muted" }, `Go walks there when Simulated GPS is on; otherwise only virtual-travel places can be reached. Claim needs you on site (power = team power ${fmt(c.power)}); Defend reinforces your own cell from anywhere. On the map: pins by kind, tiles = owned cells (yours in the accent colour, more opaque = stronger garrison), the floating pin = you.`),
    h("table", { class: "t" }, ...shown.map((p) => placeRow(c, p))),
    list.length > shown.length ? h("p", { class: "muted" }, `${list.length - shown.length} more places further away.`) : null);
}

function placeRow(c: Ctx, p: Place): HTMLElement {
  const pid = c.app.profile.id;
  const st = placeStatus(c.world, c.s, pid, p, c.now);
  const ka = kindAction(p.kind);
  const where = st.here ? "📍 you are here" : fmtDistance(distXZ(c.avatar.pos, p.pos), c.units);
  const known = st.yourHome ? "your home" : st.visited ? "visited" : st.discovered ? "discovered" : "undiscovered";
  const canGo = c.s.gps || PLACE_KIND_DEFS[p.kind].virtualTravel || st.yourHome;
  const go = st.here ? null : canGo
    ? h("button", { class: "btn small", "data-world": "go", onclick: goAct(c, p, `Go to ${p.name}`) }, c.s.gps ? "Go" : st.yourHome ? "Return home" : "Travel virtually")
    : h("span", { class: "muted", title: `Reachable on foot only: switch Simulated GPS on to walk to this ${p.kind}.` }, "walk only");
  return h("tr", { "data-place": p.id },
    h("td", {},
      placeTitle(p),
      h("div", { class: "muted" }, `${where} · ${known} · alt ${fmt(p.pos.y)} m · ${territoryText(c, st)}`)),
    h("td", {},
      h("div", { class: "row" },
        go,
        h("button", { class: "btn small", "data-world": "discover", onclick: c.act(`${st.discovered ? "Check in at" : "Discover"} ${p.name}`, () => applyDiscover(c.world, c.s, pid, p, Date.now(), { hour: c.app.hourNow(), weather: c.app.rw.weather })) }, st.discovered ? "Check in" : "Discover"),
        h("button", { class: "btn small", "data-world": "claim", onclick: c.act(`Claim at ${p.name}`, () => applyClaim(c.world, c.s, c.app.profile, p, Date.now())) }, "Claim"),
        h("button", { class: "btn small", "data-world": "defend", onclick: c.act(`Defend at ${p.name}`, () => applyDefend(c.world, c.app.profile, p, Date.now())) }, "Defend"),
        ka ? kindButton(c, p, ka) : null,
        h("button", { class: "btn small", title: "Show on the map", onclick: () => liveView(c.app, c.world)?.focus(p.id) }, "◎"))));
}

function activitySection(s: WorldSession): HTMLElement {
  return section("Activity",
    s.log.length
      ? h("div", { class: "feed" }, ...s.log.map((a) => h("div", { class: "ev" }, h("span", {}, clock(a.at)), h("span", { class: "what" }, a.action), h("span", {}, `${a.ok ? "✓" : "✖"} ${a.reason}`))))
      : h("p", { class: "muted" }, "Your world actions, and every refusal with the engine's reason, appear here."));
}

// ---------------------------------------------------------------- actions

/** Go / travel / return: moves the session avatar, then the map marker. */
function goAct(c: Ctx, p: Place, label: string): () => void {
  return c.act(label, (): MoveResult => {
    const m = moveAvatar(c.world, c.s, c.app.profile.id, p.id, Date.now());
    if (m.ok && m.mode === "walk") c.app.log("ui.world.move", "simulated physical move (no real GPS fix)", p.id, p.kind);
    if (m.ok && m.mode === "return") c.app.log("ui.world.return", "avatar left the virtual space for home", p.id, p.kind);
    return m;
  }, (m) => {
    if (m.ok) liveView(c.app, c.world)?.setAvatar(p.id);
  });
}

function kindButton(c: Ctx, p: Place, ka: KindAction): HTMLElement {
  const gate = c.world.actionAllowed(ka.action, p, presentAt(c.s, p.id), c.app.profile.id);
  const title = gate.ok ? `${ka.action}: ${gate.reason}` : `Refused now: ${gate.reason}`;
  let onclick: () => void;
  switch (ka.id) {
    case "buy":
      onclick = c.act(ka.label, () => applyBuyFood(c.world, c.s, c.app.profile, p, Date.now(), c.app.ledger), (r) => r.ok && c.app.save());
      break;
    case "train":
      onclick = c.act(ka.label, () => applyTrain(c.world, c.s, c.app.profile, p, Date.now(), c.app.ledger), (r) => r.ok && c.app.save());
      break;
    case "battle":
      onclick = c.act(`Battle at ${p.name}`, () => battlePlan(c.world, c.s, c.app.profile.id, p, c.app.hourNow(), Date.now()), (plan) => {
        if (!plan.ok || !plan.battle) return;
        if (plan.move?.mode === "walk") c.app.log("ui.world.move", "simulated physical move (no real GPS fix)", p.id, p.kind);
        c.app.log("ui.world.battle", "battle started at a place", p.id, `${p.kind} -> ${plan.battle.arena}`);
        saveWorld(localStorage, c.world);
        c.app.startBattle(plan.battle);
      });
      break;
  }
  return h("button", { class: `btn small ${ka.id === "battle" ? "primary" : ""}`, "data-world": ka.id, title, onclick }, ka.label);
}

// ---------------------------------------------------------------- formatting

function kindChip(kind: PlaceKind): HTMLElement {
  return h("span", { class: "el", vars: { el: hex(PLACE_COLORS[kind]) } }, PLACE_KIND_DEFS[kind].name);
}

/** Kind chip + name (the name alone is dropped when it only repeats the kind, e.g. "Home"). */
function placeTitle(p: Place): HTMLElement {
  return h("div", { class: "row" }, kindChip(p.kind), p.name === PLACE_KIND_DEFS[p.kind].name ? null : h("b", {}, p.name));
}

function territoryText(c: Ctx, st: PlaceStatus): string {
  if (st.sensitive) return "no claims (sensitive place)";
  if (!st.owner) return "free cell";
  if (st.yours) return `your territory (garrison ${fmt(st.defense)})`;
  return `held by ${c.app.store.get(st.owner)?.name ?? st.owner} (garrison ${fmt(st.defense)})`;
}

/** "34 m · +12 m vs home · cover: trees" */
function altitudeText(c: Ctx, p: Place): string {
  const d = p.pos.y - c.home.pos.y;
  const cover = c.world.coverAt(p.pos.x, p.pos.z);
  const rel = p.id === c.home.id ? "your home" : `${d >= 0 ? "+" : "−"}${fmt(Math.abs(d))} m vs home`;
  return `${fmt(p.pos.y)} m · ${rel}${cover ? ` · cover: ${cover}` : ""}`;
}

function xyz(p: V3): string {
  const ew = p.x >= 0 ? `${fmt(p.x)} m E` : `${fmt(-p.x)} m W`;
  const ns = p.z >= 0 ? `${fmt(p.z)} m N` : `${fmt(-p.z)} m S`;
  return `x ${ew} · y ${fmt(p.y)} m alt · z ${ns}`;
}

function hourLabel(hour: number): string {
  const h24 = ((hour % 24) + 24) % 24;
  return `${String(Math.floor(h24)).padStart(2, "0")}:${String(Math.floor((h24 % 1) * 60)).padStart(2, "0")}`;
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
