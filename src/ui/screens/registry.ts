/** The UI tree: one entry per screen. Navigation, colours and hints are generated from this list. */
import type { App } from "../app.ts";
import { renderHome } from "./home.ts";
import { renderArena } from "./arena.ts";
import { renderTeam } from "./team.ts";
import { renderLab } from "./lab.ts";
import { renderData } from "./data.ts";
import { renderSettings } from "./settings.ts";
import { renderLadder, renderMarket, renderWorld } from "./later.ts";

export interface ScreenDef {
  id: string;
  label: string;
  icon: string;
  color: string;
  hint: string;
  /** Which 3D view accompanies the screen. */
  view?: "lab" | "genospace" | "keep";
  /** Optional custom 3D view mounted when the screen opens (takes precedence over `view`). */
  mount?(app: App): void;
  render(app: App): HTMLElement;
}

export const SCREENS: readonly ScreenDef[] = [
  { id: "home", label: "Home", icon: "⌂", color: "#4cc9f0", hint: "Your day, your Genemon, quick actions", view: "lab", render: renderHome },
  { id: "arena", label: "Arena", icon: "⚔", color: "#ff6b35", hint: "Instant battles in 3D arenas", view: "lab", render: renderArena },
  { id: "team", label: "Team", icon: "❖", color: "#ffd166", hint: "6 slots: big Genemon cost more; synergies; attack order", view: "lab", render: renderTeam },
  { id: "lab", label: "Lab", icon: "⚗", color: "#3ddc84", hint: "Inspect, feed, grow, breed, mutate, morph, fuse", view: "lab", render: renderLab },
  { id: "world", label: "World", icon: "◎", color: "#9b5de5", hint: "Map, places, territories (physical vs virtual)", view: "keep", render: renderWorld },
  { id: "market", label: "Market", icon: "⚖", color: "#f15bb5", hint: "Auction house: timers, promotions, sellers", view: "keep", render: renderMarket },
  { id: "ladder", label: "Ladder", icon: "♛", color: "#00bbf9", hint: "Condition-aware MMR and match conditions", view: "keep", render: renderLadder },
  { id: "data", label: "Data", icon: "∿", color: "#00f5d4", hint: "Ledger, graphs, genospace, hardware & session", view: "genospace", render: renderData },
  { id: "settings", label: "Settings", icon: "⚙", color: "#a7b3c6", hint: "Theme, quality, camera, profiles", view: "keep", render: renderSettings },
];
