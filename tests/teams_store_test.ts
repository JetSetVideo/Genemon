import { assert, assertEquals } from "./_assert.ts";
import { createGenemon, type Genemon, phenotypeOf } from "../src/genome/genemon.ts";
import { TEAM_CAPACITY } from "../src/combat/team.ts";
import type { Profile } from "../src/ui/profile.ts";
import {
  activePreset,
  createPreset,
  deletePreset,
  duplicatePreset,
  MAX_PRESETS,
  moveMember,
  presetsOf,
  pruneReleased,
  renamePreset,
  setActive,
  setMembers,
  setMembersChecked,
  slotsOf,
  syncFromTeam,
  toggleMember,
  withPresets,
} from "../src/ui/teamsStore.ts";

function pool(n: number, bias?: { stature: number; weight: number }): Genemon[] {
  return Array.from({ length: n }, (_, i) => createGenemon({ seed: 1000 + i * 31, owner: "me", level: 20, bias: bias ? { axes: bias, spread: 0.1 } : undefined }));
}

function legacy(collection: Genemon[], team: string[]): Profile {
  return { id: "me", team, collection } as unknown as Profile;
}

const C = pool(8);
const small = pool(4, { stature: -1, weight: -1 }).filter((g) => phenotypeOf(g).slots === 1);
const CS = [...C, ...small];

Deno.test("legacy profile without teams reads as one preset 'Team 1' from p.team", () => {
  const p = legacy(C, [C[0].id, C[1].id]);
  const ps = presetsOf(p);
  assertEquals(ps.list.length, 1);
  assertEquals(ps.list[0].name, "Team 1");
  assertEquals(ps.list[0].members, [C[0].id, C[1].id]);
  assertEquals(ps.active, ps.list[0].id);
  // invalid stored value also falls back
  (p as unknown as { teams: unknown }).teams = { active: 3, list: "x" };
  assertEquals(presetsOf(p).list[0].members, [C[0].id, C[1].id]);
});

Deno.test("withPresets writes teams and mirrors the active preset into p.team", () => {
  const p = legacy(C, [C[0].id]);
  let ps = createPreset(presetsOf(p), "Rain", [C[2].id, C[3].id]);
  const rain = ps.list[1];
  ps = setActive(ps, rain.id);
  withPresets(p, ps);
  assertEquals(p.team, [C[2].id, C[3].id]);
  const back = presetsOf(p);
  assertEquals(back.active, rain.id);
  assertEquals(back.list.map((t) => t.name), ["Team 1", "Rain"]);
  // mutating the returned value must not touch the profile
  back.list[0].members.push("zzz");
  assertEquals(presetsOf(p).list[0].members, [C[0].id]);
});

Deno.test("create / rename / duplicate: deterministic ids, max presets, clean names", () => {
  let ps = presetsOf(legacy(C, [C[0].id]));
  ps = createPreset(ps, "  Night   crew  ");
  assertEquals(ps.list[1].id, "t2");
  assertEquals(ps.list[1].name, "Night crew");
  ps = renamePreset(ps, "t2", "");
  assertEquals(ps.list[1].name, "Night crew", "empty rename keeps the name");
  ps = renamePreset(ps, "t2", "Owls");
  assertEquals(ps.list[1].name, "Owls");
  ps = duplicatePreset(ps, "t1");
  assertEquals(ps.list[2].id, "t3");
  assertEquals(ps.list[2].members, [C[0].id]);
  assertEquals(ps.list[2].name, "Team 1 copy");
  // same calls -> same ids (no randomness)
  const again = duplicatePreset(renamePreset(createPreset(presetsOf(legacy(C, [C[0].id])), "Night crew"), "t2", "Owls"), "t1");
  assertEquals(again.list.map((t) => t.id), ps.list.map((t) => t.id));
  for (let i = 0; i < 20; i++) ps = createPreset(ps, `x${i}`);
  assertEquals(ps.list.length, MAX_PRESETS);
  // ids are not reused after a delete
  const del = deletePreset(ps, "t8");
  assertEquals(createPreset(del, "new").list.at(-1)!.id, "t9");
});

Deno.test("deletePreset never deletes the last one and moves active", () => {
  let ps = presetsOf(legacy(C, [C[0].id]));
  assertEquals(deletePreset(ps, "t1").list.length, 1, "delete-last refused");
  ps = createPreset(createPreset(ps, "B"), "C");
  ps = setActive(ps, "t2");
  ps = deletePreset(ps, "t2");
  assertEquals(ps.list.map((t) => t.id), ["t1", "t3"]);
  assertEquals(ps.active, "t3", "active moves to the neighbour");
  ps = deletePreset(ps, "t3");
  assertEquals(ps.active, "t1");
  assertEquals(deletePreset(ps, "t1").list.length, 1);
  assertEquals(setActive(ps, "nope").active, "t1", "unknown id refused");
});

Deno.test("setMembers drops unknown ids and duplicates, keeps order, refuses slot overflow", () => {
  let ps = presetsOf(legacy(C, []));
  ps = setMembers(ps, "t1", [C[3].id, "ghost", C[1].id, C[3].id], C);
  assertEquals(ps.list[0].members, [C[3].id, C[1].id]);
  const big = pool(4, { stature: 1, weight: 1 });
  const bigSlots = big.map((g) => phenotypeOf(g).slots);
  assert(bigSlots.reduce((a, b) => a + b, 0) > TEAM_CAPACITY, `test pool must overflow: ${bigSlots}`);
  const all = [...C, ...big];
  const r = setMembersChecked(ps, "t1", big.map((g) => g.id), all);
  assert(!r.ok, "overflow refused");
  assert(r.reason.includes("slots"), r.reason);
  assertEquals(r.presets.list[0].members, [C[3].id, C[1].id], "unchanged on refusal");
  // toggle refuses once the next one does not fit
  let t = presetsOf(legacy(all, []));
  let refused = false;
  for (const g of big) {
    const x = toggleMember(t, "t1", g.id, all);
    if (!x.ok) refused = true;
    t = x.presets;
  }
  assert(refused, "toggle refused on overflow");
  assert(slotsOf(t.list[0].members, all) <= TEAM_CAPACITY);
});

Deno.test("toggleMember adds then removes; moveMember reorders and clamps", () => {
  assert(small.length >= 3, "need 3 one-slot Genemon");
  let ps = presetsOf(legacy(CS, []));
  for (const g of small.slice(0, 3)) ps = toggleMember(ps, "t1", g.id, CS).presets;
  const [a, b, c] = small.map((g) => g.id);
  assertEquals(ps.list[0].members, [a, b, c]);
  ps = moveMember(ps, "t1", c, -1);
  assertEquals(ps.list[0].members, [a, c, b]);
  ps = moveMember(ps, "t1", a, -5);
  assertEquals(ps.list[0].members, [a, c, b], "clamped at the top");
  ps = moveMember(ps, "t1", a, 2);
  assertEquals(ps.list[0].members, [c, b, a]);
  ps = toggleMember(ps, "t1", b, CS).presets;
  assertEquals(ps.list[0].members, [c, a]);
  assert(!toggleMember(ps, "t1", "ghost", CS).ok, "unknown genemon refused");
});

Deno.test("pruneReleased and syncFromTeam drop released ids from every preset", () => {
  let ps = presetsOf(legacy(C, [C[0].id, C[1].id]));
  ps = createPreset(ps, "B", [C[1].id, C[2].id]);
  const keep = C.filter((g) => g.id !== C[1].id).map((g) => g.id);
  const pr = pruneReleased(ps, keep);
  assertEquals(pr.list[0].members, [C[0].id]);
  assertEquals(pr.list[1].members, [C[2].id]);
  // p.team edited elsewhere (old Team screen) wins for the active preset
  const s = syncFromTeam(ps, [C[2].id, C[0].id], C.map((g) => g.id));
  assertEquals(activePreset(s).members, [C[2].id, C[0].id]);
  assertEquals(s.list[1].members, [C[1].id, C[2].id]);
  assert(syncFromTeam(s, [C[2].id, C[0].id], C.map((g) => g.id)) === s, "no-op returns the same value");
});
