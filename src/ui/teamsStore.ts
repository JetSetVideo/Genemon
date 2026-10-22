/**
 * Team presets (P4-R3): several saved teams, one active. Pure (no DOM): every function returns a NEW
 * TeamPresets value. The battle engine keeps reading `profile.team`, so `withPresets` mirrors the active
 * preset's members into it. A legacy profile without `teams` reads back as one preset "Team 1" built
 * from `profile.team` (backward compatible, nothing is lost).
 */
import { TEAM_CAPACITY } from "../combat/team.ts";
import { type Genemon, phenotypeOf } from "../genome/genemon.ts";
import type { Profile } from "./profile.ts";

export interface TeamPreset {
  id: string;
  name: string;
  /** Ordered Genemon ids: index 0 leads. */
  members: string[];
}

export interface TeamPresets {
  active: string;
  list: TeamPreset[];
  /** Id counter: the next preset gets `t<next>` (deterministic, never reused while the list lives). */
  next?: number;
}

export const MAX_PRESETS = 8;
export const MAX_NAME = 24;

type WithTeams = Profile & { teams?: unknown };

function cleanName(name: string, fallback: string): string {
  const n = String(name ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
  return n || fallback;
}

function idNum(id: string): number {
  const m = /^t(\d+)$/.exec(id);
  return m ? Number(m[1]) : 0;
}

function nextId(ps: TeamPresets): { id: string; next: number } {
  const n = Math.max(ps.next ?? 1, ...ps.list.map((t) => idNum(t.id) + 1), 1);
  return { id: `t${n}`, next: n + 1 };
}

function isPresets(v: unknown): v is TeamPresets {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (typeof o.active !== "string" || !Array.isArray(o.list) || o.list.length === 0) return false;
  return o.list.every((t) => {
    const x = t as Record<string, unknown>;
    return !!x && typeof x.id === "string" && typeof x.name === "string" && Array.isArray(x.members) && x.members.every((m) => typeof m === "string");
  });
}

function copy(ps: TeamPresets): TeamPresets {
  return { active: ps.active, next: ps.next, list: ps.list.map((t) => ({ id: t.id, name: t.name, members: [...t.members] })) };
}

/** The presets of a profile. Invalid or missing `teams` -> one preset "Team 1" from `p.team`. */
export function presetsOf(p: Profile): TeamPresets {
  const raw = (p as WithTeams).teams;
  if (isPresets(raw)) {
    const ps = copy(raw);
    ps.list = ps.list.slice(0, MAX_PRESETS);
    if (!ps.list.some((t) => t.id === ps.active)) ps.active = ps.list[0].id;
    return ps;
  }
  return { active: "t1", next: 2, list: [{ id: "t1", name: "Team 1", members: [...(p.team ?? [])] }] };
}

export function activePreset(ps: TeamPresets): TeamPreset {
  return ps.list.find((t) => t.id === ps.active) ?? ps.list[0];
}

/** Write the presets onto the profile AND mirror the active preset into `p.team` (the engine reads it). */
export function withPresets(p: Profile, ps: TeamPresets): Profile {
  const clean = copy(ps);
  (p as Profile & { teams?: TeamPresets }).teams = clean;
  p.team = [...activePreset(clean).members];
  return p;
}

/** Add a preset (refused silently past MAX_PRESETS: the same value comes back). */
export function createPreset(ps: TeamPresets, name: string, members: string[] = []): TeamPresets {
  if (ps.list.length >= MAX_PRESETS) return ps;
  const out = copy(ps);
  const { id, next } = nextId(out);
  out.list.push({ id, name: cleanName(name, `Team ${out.list.length + 1}`), members: [...new Set(members)] });
  out.next = next;
  return out;
}

export function renamePreset(ps: TeamPresets, id: string, name: string): TeamPresets {
  const out = copy(ps);
  const t = out.list.find((x) => x.id === id);
  if (t) t.name = cleanName(name, t.name);
  return out;
}

export function duplicatePreset(ps: TeamPresets, id: string): TeamPresets {
  const src = ps.list.find((x) => x.id === id);
  if (!src) return ps;
  return createPreset(ps, cleanName(`${src.name} copy`, "Copy"), src.members);
}

/** Delete a preset. The last one is never deleted; deleting the active one activates its neighbour. */
export function deletePreset(ps: TeamPresets, id: string): TeamPresets {
  const i = ps.list.findIndex((x) => x.id === id);
  if (i < 0 || ps.list.length <= 1) return ps;
  const out = copy(ps);
  out.list.splice(i, 1);
  if (out.active === id) out.active = out.list[Math.min(i, out.list.length - 1)].id;
  return out;
}

export function setActive(ps: TeamPresets, id: string): TeamPresets {
  if (!ps.list.some((x) => x.id === id)) return ps;
  const out = copy(ps);
  out.active = id;
  return out;
}

/** Slots used by a list of ids (unknown ids cost nothing). */
export function slotsOf(members: readonly string[], collection: readonly Genemon[]): number {
  return members.reduce((s, id) => {
    const g = collection.find((x) => x.id === id);
    return s + (g ? phenotypeOf(g).slots : 0);
  }, 0);
}

export interface MembersResult {
  presets: TeamPresets;
  ok: boolean;
  /** Why the change was refused (empty when ok). */
  reason: string;
}

/**
 * Replace a preset's members: unknown ids and duplicates are dropped, order kept. Refused (presets
 * unchanged, ok false) when the slots exceed TEAM_CAPACITY.
 */
export function setMembersChecked(ps: TeamPresets, id: string, members: readonly string[], collection: readonly Genemon[]): MembersResult {
  const t = ps.list.find((x) => x.id === id);
  if (!t) return { presets: ps, ok: false, reason: "no such team" };
  const known = new Set(collection.map((g) => g.id));
  const clean = [...new Set(members)].filter((m) => known.has(m));
  const slots = slotsOf(clean, collection);
  if (slots > TEAM_CAPACITY) return { presets: ps, ok: false, reason: `needs ${slots} slots > ${TEAM_CAPACITY}` };
  const out = copy(ps);
  out.list.find((x) => x.id === id)!.members = clean;
  return { presets: out, ok: true, reason: "" };
}

export function setMembers(ps: TeamPresets, id: string, members: readonly string[], collection: readonly Genemon[]): TeamPresets {
  return setMembersChecked(ps, id, members, collection).presets;
}

/** Add the Genemon to the end of the preset, or remove it if already in. Refused on slot overflow. */
export function toggleMember(ps: TeamPresets, id: string, genemonId: string, collection: readonly Genemon[]): MembersResult {
  const t = ps.list.find((x) => x.id === id);
  if (!t) return { presets: ps, ok: false, reason: "no such team" };
  if (t.members.includes(genemonId)) return setMembersChecked(ps, id, t.members.filter((m) => m !== genemonId), collection);
  if (!collection.some((g) => g.id === genemonId)) return { presets: ps, ok: false, reason: "unknown Genemon" };
  return setMembersChecked(ps, id, [...t.members, genemonId], collection);
}

/** Move a member up (delta < 0) or down (delta > 0) in the order; clamped at both ends. */
export function moveMember(ps: TeamPresets, id: string, genemonId: string, delta: number): TeamPresets {
  const t = ps.list.find((x) => x.id === id);
  if (!t) return ps;
  const i = t.members.indexOf(genemonId);
  if (i < 0) return ps;
  const j = Math.max(0, Math.min(t.members.length - 1, i + Math.trunc(delta)));
  if (j === i) return ps;
  const out = copy(ps);
  const m = out.list.find((x) => x.id === id)!.members;
  m.splice(i, 1);
  m.splice(j, 0, genemonId);
  return out;
}

/** Drop ids that left the collection (released, sold, fused away) from every preset. */
export function pruneReleased(ps: TeamPresets, collectionIds: readonly string[]): TeamPresets {
  const keep = new Set(collectionIds);
  const out = copy(ps);
  for (const t of out.list) t.members = t.members.filter((m) => keep.has(m));
  return out;
}

/**
 * Reconcile with `profile.team`, which older screens (Team, Lab release, Market) still edit directly:
 * the engine's team is the truth, so it overwrites the active preset's members; released ids are pruned
 * from every preset. Returns the same value when nothing differs.
 */
export function syncFromTeam(ps: TeamPresets, team: readonly string[], collectionIds: readonly string[]): TeamPresets {
  const pruned = pruneReleased(ps, collectionIds);
  const keep = new Set(collectionIds);
  const truth = team.filter((m) => keep.has(m));
  const act = activePreset(pruned);
  const same = act.members.length === truth.length && act.members.every((m, i) => m === truth[i]);
  if (same && JSON.stringify(pruned.list) === JSON.stringify(ps.list)) return ps;
  pruned.list.find((t) => t.id === act.id)!.members = [...truth];
  return pruned;
}

/** Which presets contain a Genemon (for the "in team" badges). */
export function presetsWith(ps: TeamPresets, genemonId: string): TeamPreset[] {
  return ps.list.filter((t) => t.members.includes(genemonId));
}
