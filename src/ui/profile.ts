/**
 * Profiles: every player (human or AI - "you and me") has a profile saved in localStorage with its
 * settings (theme, quality, camera...), collection of Genemon, ordered team, credits, ladder stats,
 * pokedex and achievements. Profiles can be exported/imported as JSON.
 */
import { hashSeed } from "../core/rng.ts";
import { createGenemon, type Genemon } from "../genome/genemon.ts";
import { autoTeam } from "../combat/team.ts";
import type { CameraMode } from "../render/battleCamera.ts";
import type { BodyKind } from "../genome/genome.ts";
import type { AxisVector } from "../data/axes.ts";

export interface Settings {
  theme: "dark" | "light";
  quality: "low" | "high";
  pixelRatio: number;
  shadows: boolean;
  camera: CameraMode;
  shake: number;
  speed: number;
  hourMode: "real" | "fixed";
  hour: number;
  showSkeleton: boolean;
  units: "metric" | "imperial";
}

export interface BattleRecordLite {
  when: number;
  arena: string;
  weather: string;
  hour: number;
  won: 0 | 1 | 2;
  opponent: string;
  duration: number;
  reactions: number;
  mvp: string;
  mmrDelta: number;
}

export interface Profile {
  id: string;
  name: string;
  kind: "human" | "ai";
  createdAt: number;
  seed: number;
  settings: Settings;
  credits: number;
  collection: Genemon[];
  team: string[];
  mmr: number;
  stats: { battles: number; wins: number; losses: number; draws: number };
  history: BattleRecordLite[];
  pokedex: string[];
  achievements: string[];
  home: { lat: number; lon: number } | null;
  friends: string[];
}

export const DEFAULT_SETTINGS: Settings = {
  theme: "dark",
  quality: "high",
  pixelRatio: 2,
  shadows: true,
  camera: "auto",
  shake: 1,
  speed: 1,
  hourMode: "real",
  hour: 13,
  showSkeleton: false,
  units: "metric",
};

const STARTERS: { label: string; kind?: BodyKind; axes: Partial<AxisVector> }[] = [
  { label: "ember", kind: "quadruped", axes: { heat: 0.8, moisture: -0.5, stature: 0.5, temper: 0.4, reach: -0.6 } },
  { label: "tide", kind: "serpent", axes: { moisture: 0.85, form: 0.4, reach: 0.6 } },
  { label: "sprout", kind: "biped", axes: { vitality: 0.85, moisture: 0.3, stature: -0.6 } },
  { label: "volt", kind: "hexapod", axes: { conductivity: 0.85, tempo: 0.6, stature: -0.5 } },
  { label: "boulder", kind: "quadruped", axes: { hardness: 0.7, weight: 0.7, substance: 0.5, altitude: -0.6, stature: 0.6 } },
  { label: "gust", kind: "avian", axes: { altitude: 0.9, weight: -0.7, tempo: 0.4 } },
  { label: "gloom", kind: "blob", axes: { luminance: -0.8, substance: -0.4, rhythm: -0.6 } },
  { label: "frost", kind: "quadruped", axes: { heat: -0.85, hardness: 0.3, stature: -0.2 } },
  { label: "lumen", kind: "biped", axes: { luminance: 0.85, wisdom: 0.5, rhythm: 0.5 } },
  { label: "psy", kind: "blob", axes: { wisdom: 0.85, focus: 0.5, form: 0.4 } },
];

export function starterCollection(owner: string, seed: number): Genemon[] {
  return STARTERS.map((s, i) =>
    createGenemon({ seed: hashSeed(seed, s.label, i), owner, level: 14 + (i % 4) * 4, bias: { axes: s.axes, kind: s.kind, spread: 0.25 } })
  );
}

export function newProfile(name: string, kind: "human" | "ai", now: number, settings: Partial<Settings> = {}): Profile {
  const id = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${(hashSeed(name, now) % 46656).toString(36)}`;
  const seed = hashSeed(id, "seed");
  const collection = starterCollection(id, seed);
  const team = autoTeam(collection, id, seed, "balanced").members.map((g) => g.id);
  return {
    id,
    name,
    kind,
    createdAt: now,
    seed,
    settings: { ...DEFAULT_SETTINGS, ...settings },
    credits: 500,
    collection,
    team,
    mmr: 1500,
    stats: { battles: 0, wins: 0, losses: 0, draws: 0 },
    history: [],
    pokedex: collection.map((g) => g.genome.id),
    achievements: [],
    home: null,
    friends: [],
  };
}

const INDEX = "genemon.profiles";
const ACTIVE = "genemon.active";
const KEY = (id: string) => `genemon.profile.${id}`;

export class ProfileStore {
  private cache = new Map<string, Profile>();

  constructor(private storage: Storage, now: number) {
    if (this.ids().length === 0) {
      const max = newProfile("Max", "human", now);
      const claude = newProfile("Claude", "ai", now + 1, { theme: "dark" });
      max.friends = [claude.id];
      claude.friends = [max.id];
      this.save(max);
      this.save(claude);
      this.storage.setItem(ACTIVE, max.id);
    }
  }

  ids(): string[] {
    try {
      return JSON.parse(this.storage.getItem(INDEX) ?? "[]");
    } catch {
      return [];
    }
  }

  list(): Profile[] {
    return this.ids().map((id) => this.get(id)).filter((p): p is Profile => !!p);
  }

  get(id: string): Profile | null {
    if (this.cache.has(id)) return this.cache.get(id)!;
    try {
      const raw = this.storage.getItem(KEY(id));
      if (!raw) return null;
      const p = JSON.parse(raw) as Profile;
      p.settings = { ...DEFAULT_SETTINGS, ...p.settings };
      this.cache.set(id, p);
      return p;
    } catch {
      return null;
    }
  }

  active(): Profile {
    const id = this.storage.getItem(ACTIVE) ?? this.ids()[0];
    return this.get(id) ?? this.list()[0];
  }

  switchTo(id: string): Profile | null {
    const p = this.get(id);
    if (p) this.storage.setItem(ACTIVE, id);
    return p;
  }

  save(p: Profile): void {
    this.cache.set(p.id, p);
    try {
      this.storage.setItem(KEY(p.id), JSON.stringify(p));
    } catch (e) {
      console.warn("profile save failed (storage full?)", e);
    }
    const ids = this.ids();
    if (!ids.includes(p.id)) this.storage.setItem(INDEX, JSON.stringify([...ids, p.id]));
  }

  create(name: string, kind: "human" | "ai", now: number): Profile {
    const p = newProfile(name, kind, now);
    this.save(p);
    return p;
  }

  remove(id: string): void {
    this.storage.removeItem(KEY(id));
    this.cache.delete(id);
    this.storage.setItem(INDEX, JSON.stringify(this.ids().filter((x) => x !== id)));
  }

  exportJSON(id: string): string {
    return JSON.stringify(this.get(id), null, 1);
  }

  importJSON(text: string): Profile {
    const p = JSON.parse(text) as Profile;
    if (!p || typeof p.id !== "string" || !Array.isArray(p.collection)) throw new Error("not a Genemon profile");
    p.settings = { ...DEFAULT_SETTINGS, ...p.settings };
    this.save(p);
    return p;
  }
}

export function teamOf(p: Profile): Genemon[] {
  return p.team.map((id) => p.collection.find((g) => g.id === id)).filter((g): g is Genemon => !!g);
}
