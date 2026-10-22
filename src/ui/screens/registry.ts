/** The UI tree: one entry per screen. Navigation, colours and hints are generated from this list. */
import type { App } from "../app.ts";
import { mountHome, renderHome } from "./home.ts";
import { renderBatch } from "./batch.ts";
import { mountArena, renderArena } from "./arena.ts";
import { renderTeam } from "./team.ts";
import { renderDex } from "./dex.ts";
import { renderLab } from "./lab.ts";
import { mountWorld, renderWorld } from "./world.ts";
import { renderMarket } from "./market.ts";
import { renderLadder } from "./ladder.ts";
import { renderAchievements } from "./quests.ts";
import { renderData } from "./data.ts";
import { renderSettings } from "./settings.ts";

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
  { id: "home", label: "Home", icon: "⌂", color: "#4cc9f0", hint: "Your day, your quests, your Genemon, quick actions", view: "lab", mount: mountHome, render: renderHome },
  { id: "arena", label: "Arena", icon: "⚔", color: "#ff6b35", hint: "Ranked and practice battles in 3D arenas", view: "lab", mount: mountArena, render: renderArena },
  { id: "team", label: "Team", icon: "❖", color: "#ffd166", hint: "6 slots: big Genemon cost more; synergies; attack order", view: "lab", render: renderTeam },
  { id: "dex", label: "Collection", icon: "◫", color: "#7bdff2", hint: "All my Genemon, saved teams, the Dex and the Hatch button", view: "lab", render: renderDex },
  { id: "lab", label: "Lab", icon: "⚗", color: "#3ddc84", hint: "Inspect, feed, grow, breed, mutate, morph, fuse", view: "lab", render: renderLab },
  { id: "world", label: "World", icon: "◎", color: "#9b5de5", hint: "Map around your home: discover, claim, shop, train, catch (in person vs virtual)", mount: mountWorld, render: renderWorld },
  { id: "market", label: "Market", icon: "⚖", color: "#f15bb5", hint: "Auction house: timers, bids, buyouts, promotions; company, NPC and player sellers", view: "keep", render: renderMarket },
  { id: "ladder", label: "Ladder", icon: "♛", color: "#00bbf9", hint: "Condition-aware MMR and match conditions", view: "keep", render: renderLadder },
  { id: "achievements", label: "Feats", icon: "★", color: "#e9b949", hint: "Achievements by category, locked and unlocked, with progress", view: "keep", render: renderAchievements },
  { id: "data", label: "Data", icon: "∿", color: "#00f5d4", hint: "Ledger, graphs, genospace, hardware & session", view: "genospace", render: renderData },
  { id: "batch", label: "Batch", icon: "⧉", color: "#e76f51", hint: "Batch breeding and archetype matchup matrices (fast / powerful / clever / tank / sensory / swarm)", view: "keep", render: renderBatch },
  { id: "settings", label: "Settings", icon: "⚙", color: "#a7b3c6", hint: "Theme, quality, camera, profiles", view: "keep", render: renderSettings },
];
