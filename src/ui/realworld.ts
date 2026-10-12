/**
 * Real-world context at the TOP of the data flow: local time, day phase, season, moon phase, a
 * deterministic "weather of the day" (live weather APIs are an opt-in quest: CSP keeps the app
 * offline), the device/hardware profile and the session activity. Everything below (arena light,
 * rhythm buffs, spawns, quests) reads from here, and every probe is a ledger row.
 */
import { hashSeed, Rng } from "../core/rng.ts";
import type { Ledger } from "../core/ledger.ts";
import type { WeatherId } from "../data/weather.ts";

export type DayPhase = "night" | "dawn" | "morning" | "noon" | "afternoon" | "dusk" | "evening";
export type Season = "winter" | "spring" | "summer" | "autumn";

export interface DeviceInfo {
  platform: string;
  cores: number;
  memoryGB: number | null;
  touch: boolean;
  screen: string;
  dpr: number;
  formFactor: "mobile" | "tablet" | "laptop" | "desktop";
  connection: string | null;
  language: string;
  timezone: string;
  gpu?: string;
}

export interface RealWorld {
  now: Date;
  hour: number;
  dayPhase: DayPhase;
  season: Season;
  moon: number;
  moonName: string;
  weather: WeatherId;
  device: DeviceInfo;
}

export function dayPhaseOf(h: number): DayPhase {
  if (h < 5 || h >= 22) return "night";
  if (h < 7) return "dawn";
  if (h < 11) return "morning";
  if (h < 14) return "noon";
  if (h < 18) return "afternoon";
  if (h < 20) return "dusk";
  return "evening";
}

export function seasonOf(d: Date, southern = false): Season {
  const m = d.getMonth();
  const north: Season = m < 2 || m === 11 ? "winter" : m < 5 ? "spring" : m < 8 ? "summer" : "autumn";
  if (!southern) return north;
  return ({ winter: "summer", summer: "winter", spring: "autumn", autumn: "spring" } as const)[north];
}

/** Moon phase 0..1 (0 new, 0.5 full) from a known new moon and the synodic month. */
export function moonPhase(d: Date): number {
  const ref = Date.UTC(2000, 0, 6, 18, 14);
  const syn = 29.530588853 * 86400000;
  return (((d.getTime() - ref) % syn) + syn) % syn / syn;
}

export function moonName(p: number): string {
  const names = ["new moon", "waxing crescent", "first quarter", "waxing gibbous", "full moon", "waning gibbous", "last quarter", "waning crescent"];
  return names[Math.round(p * 8) % 8];
}

/** Deterministic weather of the day for a place (until live weather is opted in). */
export function weatherOfDay(d: Date, lat = 48.85): WeatherId {
  const day = Math.floor(d.getTime() / 86400000);
  const rng = new Rng(hashSeed(day, Math.round(lat)));
  const s = seasonOf(d, lat < 0);
  const table: Record<Season, [WeatherId, number][]> = {
    winter: [["clear", 3], ["snow", 3], ["fog", 2], ["rain", 2], ["wind", 1], ["aurora", 0.3]],
    spring: [["clear", 4], ["rain", 3], ["wind", 1.5], ["storm", 1], ["fog", 0.5]],
    summer: [["clear", 5], ["heatwave", 2], ["storm", 1.5], ["rain", 1], ["sandstorm", 0.3]],
    autumn: [["clear", 3], ["rain", 3], ["fog", 2], ["wind", 2], ["storm", 0.8]],
  };
  const t = table[s];
  return rng.weighted(t.map((x) => x[0]), t.map((x) => x[1]));
}

export function deviceInfo(): DeviceInfo {
  const nav = navigator as Navigator & { deviceMemory?: number; connection?: { effectiveType?: string } };
  const w = screen.width, hgt = screen.height;
  const touch = "ontouchstart" in globalThis || navigator.maxTouchPoints > 0;
  const minSide = Math.min(w, hgt);
  const formFactor = touch ? (minSide < 600 ? "mobile" : "tablet") : w < 1600 ? "laptop" : "desktop";
  return {
    platform: (nav as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? "unknown",
    cores: navigator.hardwareConcurrency ?? 1,
    memoryGB: nav.deviceMemory ?? null,
    touch,
    screen: `${w}x${hgt}`,
    dpr: globalThis.devicePixelRatio ?? 1,
    formFactor,
    connection: nav.connection?.effectiveType ?? null,
    language: navigator.language,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

export function readRealWorld(now = new Date()): RealWorld {
  const hour = now.getHours() + now.getMinutes() / 60;
  const moon = moonPhase(now);
  return {
    now,
    hour,
    dayPhase: dayPhaseOf(hour),
    season: seasonOf(now),
    moon,
    moonName: moonName(moon),
    weather: weatherOfDay(now),
    device: deviceInfo(),
  };
}

/** Session tracker: active time, screens, clicks - all ledger rows (space "device"/"ui"). */
export class Session {
  readonly startedAt = Date.now();
  screens: Record<string, number> = {};
  clicks = 0;
  private visibleSince = Date.now();
  activeMs = 0;

  constructor(ledger: Ledger, info: DeviceInfo) {
    ledger.emit({
      when: this.startedAt,
      where: { x: 0, y: 0, z: 0, zone: info.timezone, space: "device" },
      who: "device",
      what: "device.session.start",
      why: "app opened",
      from: info.platform,
      to: "genemon",
      entries: { cores: info.cores, memoryGB: info.memoryGB ?? -1, touch: info.touch, screen: info.screen, dpr: info.dpr, formFactor: info.formFactor },
      exits: { language: info.language },
    });
    document.addEventListener("visibilitychange", () => {
      const now = Date.now();
      if (document.hidden) this.activeMs += now - this.visibleSince;
      else this.visibleSince = now;
      ledger.emit({ when: now, where: { x: 0, y: 0, z: 0, zone: "app", space: "device" }, who: "device", what: document.hidden ? "device.session.pause" : "device.session.resume", why: "visibility change", from: "app", to: "app", entries: {}, exits: { activeMs: this.active() } });
    });
    document.addEventListener("click", () => this.clicks++, { capture: true });
  }

  active(): number {
    return this.activeMs + (document.hidden ? 0 : Date.now() - this.visibleSince);
  }

  visit(screen: string): void {
    this.screens[screen] = (this.screens[screen] ?? 0) + 1;
  }
}
