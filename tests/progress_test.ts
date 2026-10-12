/**
 * Progress engine (pure): real ledger rows -> content events (src/progress/events.ts) -> achievement
 * and quest progress with rewards (src/progress/progress.ts).
 * Run: deno test --allow-read tests/progress_test.ts
 */
import { assert, assertEquals } from "./_assert.ts";
import { type GEvent, Ledger, type Where } from "../src/core/ledger.ts";
import { ACHIEVEMENT_BY_ID, CONTENT_EVENTS } from "../src/data/achievements.ts";
import { QUEST_BY_ID, QUESTS } from "../src/data/quests.ts";
import { canProgress, ContentDeriver, deriveContentEvents } from "../src/progress/events.ts";
import {
  achievementUnlockRow,
  type IngestCtx,
  localDay,
  localWeek,
  MAX_ACTIVE,
  Progress,
  questCompleteRow,
  questReachable,
} from "../src/progress/progress.ts";
import { createGenemon } from "../src/genome/genemon.ts";
import { forgetProgress, loadProgress, progressKey, saveProgress } from "../src/ui/progressStore.ts";
import { autoTeam, type Team } from "../src/combat/team.ts";
import { Battle } from "../src/combat/battle.ts";
import { arenaSpec } from "../src/combat/scenario.ts";

const ARENA: Where = { x: 0, y: 0, z: 0, zone: "meadow", space: "arena" };
const LAB: Where = { x: 0, y: 0, z: 0, zone: "lab", space: "lab" };
/** Monday 12 October 2026, 12:00 CEST (UTC+2). */
const NOON = Date.UTC(2026, 9, 12, 10, 0);
const DAY_MS = 86_400_000;

let seq = 0;
function row(what: string, o: Partial<Omit<GEvent, "id" | "seq" | "what">> = {}): GEvent {
  seq++;
  return {
    id: `pt-${seq}`,
    seq,
    when: o.when ?? seq,
    where: o.where ?? ARENA,
    who: o.who ?? "system",
    what,
    why: o.why ?? "",
    from: o.from ?? "",
    to: o.to ?? "",
    entries: o.entries ?? {},
    exits: o.exits ?? {},
    ...(o.tags ? { tags: o.tags } : {}),
  };
}

const ctx = (profileId: string, extra: Partial<IngestCtx> = {}): IngestCtx => ({ profileId, hour: 12, now: NOON, level: 30, weather: "clear", physical: false, ...extra });

/** battle.start as battle.ts writes it: who = system, from / to = owners of side A / B. */
function battleStart(seed: number, owners: [string, string], teams: [string[], string[]], hour: number, weather = "clear"): GEvent {
  return row("battle.start", {
    from: owners[0],
    to: owners[1],
    why: "instant battle requested",
    tags: [`battle:${seed}`],
    entries: { seed, arena: "meadow", weather, hour, teamA: teams[0].join(","), teamB: teams[1].join(",") },
    exits: { synergiesA: "none", synergiesB: "none", fighters: teams[0].length + teams[1].length },
  });
}

function battleEnd(seed: number, owners: [string, string], winner: 0 | 1 | 2, hour: number, weather = "clear", weatherEnd = weather): GEvent {
  return row("battle.end", {
    from: owners[0],
    to: owners[1],
    why: "ko",
    tags: [`battle:${seed}`],
    entries: { arena: "meadow", weatherStart: weather, weatherEnd, hour, synergiesA: "none", synergiesB: "none" },
    exits: { winner, duration: 31.5, hpA: winner === 0 ? 0.6 : 0, hpB: winner === 1 ? 0.6 : 0, mvp: "x", reactions: "none" },
  });
}

const feed = (who: string, units: number, food = "berries") =>
  row("genemon.feed", { who, from: who, to: "m1", where: LAB, entries: { food, units }, exits: { hunger: 0.1, bond: 0.4 } });

const stepCount = (p: Progress, questId: string, stepId: string): number | undefined =>
  p.activeQuests().find((v) => v.quest.id === questId)?.steps.find((s) => s.step.id === stepId)?.count;

const isActive = (p: Progress, questId: string) => p.activeQuests().some((v) => v.quest.id === questId);

// ------------------------------------------------------------------------------------------ battles

Deno.test("[PROGRESS] a night win (hour 23) progresses Night Shift and not High Noon", () => {
  const owners: [string, string] = ["max", "rival"];
  const p = new Progress("max");
  const night = ctx("max", { hour: 23 });
  p.ingest(battleStart(701, owners, [["m1", "m2"], ["r1"]], 23), night);
  const res = p.ingest(battleEnd(701, owners, 0, 23), night);
  assertEquals(p.achievementProgress("night-shift"), 1, "a win at 23h counts at night");
  assertEquals(p.achievementProgress("high-noon"), 0, "...and not as a win between 11h and 13h");
  assertEquals(p.achievementProgress("weather-clear"), 1, "the sky at the start was clear");
  assertEquals(p.achievementProgress("untouchable"), 1, "no KO on the winning side: flawless");
  assert(res.unlocked.some((a) => a.id === "first-victory"), "the first win unlocks First Victory");
  assertEquals(res.credits, ACHIEVEMENT_BY_ID["first-victory"].reward.credits, "and returns its credits");

  const q = new Progress("max");
  const noon = ctx("max", { hour: 12 });
  q.ingest(battleStart(702, owners, [["m1"], ["r1"]], 12), noon);
  q.ingest(battleEnd(702, owners, 0, 12), noon);
  assertEquals(q.achievementProgress("high-noon"), 1, "the same win at noon counts for High Noon");
  assertEquals(q.achievementProgress("night-shift"), 0, "...and not at night");
  q.ingest(battleStart(703, owners, [["m1"], ["r1"]], 12), noon);
  q.ingest(battleEnd(703, owners, 1, 12), noon);
  assertEquals(q.achievementProgress("first-victory"), 1, "a loss is not a win");
  assertEquals(q.achievementProgress("arena-regular"), 1);
});

Deno.test("[PROGRESS] the profile's side comes from battle.start, also when it is team B", () => {
  const d = new ContentDeriver();
  const tag = ["battle:704"];
  const both = (r: GEvent) => ({ alice: d.derive(r, { profileId: "alice", hour: 12 }), bob: d.derive(r, { profileId: "bob", hour: 12 }) });
  const whats = (xs: GEvent[]) => xs.map((x) => x.what);
  assertEquals(both(battleStart(704, ["alice", "bob"], [["a1", "a2"], ["b1"]], 21, "rain")).bob[0].who, "bob");

  const react = both(row("battle.reaction", { who: "b1", from: "electric", to: "water", tags: tag, entries: { a: "electric", b: "water" }, exits: { reaction: "conduction", damageMult: 1.5, zone: "conduction" } }));
  assertEquals(react.alice, [], "b1 is not one of alice's fighters");
  assertEquals(whats(react.bob), ["battle.reaction"]);
  assertEquals(react.bob[0].entries.weather, "rain", "the current sky is added for weather filters");

  const hit = both(row("battle.hit", { who: "b1", from: "b1", to: "a1", when: 5000, tags: tag, entries: { move: "sparkBolt", type: 2, crit: false }, exits: { damage: 30, hp: 0, hpFrac: 0 } }));
  assertEquals(hit.alice, []);
  assertEquals([hit.bob[0].entries.element, hit.bob[0].entries.contact, hit.bob[0].entries.weatherId], ["electric", false, "rain"]);

  const ko = both(row("battle.ko", { who: "b1", from: "b1", to: "a1", when: 5000, tags: tag, entries: { t: 5 }, exits: { team: 0 } }));
  assertEquals(ko.alice, [], "alice's fighter fell: not alice's KO");
  assertEquals([ko.bob[0].entries.move, ko.bob[0].entries.element, ko.bob[0].entries.night], ["sparkBolt", "electric", true], "the KO blow is the same-tick hit; 21h is night");

  const miss = both(row("battle.miss", { who: "a2", from: "a2", to: "b1", tags: tag, entries: { move: "quake" }, exits: { hp: 40 } }));
  assertEquals([miss.alice.length, whats(miss.bob)], [0, ["battle.miss"]], "a miss counts for the dodger (dodge content)");

  const status = both(row("battle.status", { who: "a2", from: "a2", to: "a2", tags: tag, entries: { status: "shielded", duration: 5 }, exits: { active: 1 } }));
  assertEquals([whats(status.alice), status.bob.length], [["battle.status"], 0], "a self-buff counts for its applier");

  const end = both(battleEnd(704, ["alice", "bob"], 1, 21, "rain"));
  assertEquals(whats(end.bob), ["battle.win"], "winner 1 = side B = bob");
  assertEquals(whats(end.alice), ["battle.loss"]);
  const win = end.bob[0];
  assertEquals([win.entries.teamSize, win.entries.enemyCount, win.entries.hour, win.entries.night, win.entries.weather], [1, 2, 21, true, "rain"]);
  assertEquals([win.exits.survivors, win.exits.flawless, win.exits.reactions, win.exits.reason], [1, true, 1, "ko"]);
  assertEquals(end.alice[0].entries.teamSize, 2);
  assertEquals(d.derive(battleEnd(704, ["alice", "bob"], 1, 21, "rain"), { profileId: "carol", hour: 12 }), [], "not in the battle: nothing");

  const p = new Progress("bob");
  const c = ctx("bob", { hour: 21 });
  p.ingest(battleStart(705, ["alice", "bob"], [["a1"], ["b1"]], 21), c);
  p.ingest(battleEnd(705, ["alice", "bob"], 1, 21), c);
  assertEquals([p.achievementProgress("first-victory"), p.achievementProgress("night-shift")], [1, 1], "Progress counts bob's win as team B");
});

Deno.test("[PROGRESS] real battle.ts rows: one outcome per owner, exact survivors and reactions per side", () => {
  const ledger = new Ledger("progress-real");
  const pool = Array.from({ length: 8 }, (_, i) => createGenemon({ seed: 4200 + i, level: 25 }));
  const teams: [Team, Team] = [autoTeam(pool.slice(0, 4), "alice", 11), autoTeam(pool.slice(4), "bob", 12)];
  const d = new ContentDeriver();
  const got: Record<"alice" | "bob", GEvent[]> = { alice: [], bob: [] };
  const alice = new Progress("alice");
  ledger.subscribe((r) => {
    for (const who of ["alice", "bob"] as const) got[who].push(...d.derive(r, { profileId: who, hour: 23 }));
    alice.ingest(r, ctx("alice", { hour: 23 }));
  });
  const result = new Battle({ seed: 4242, arena: arenaSpec("lake", 4242, "rain", 23), teams, ledger }).run();
  const outcome = (who: "alice" | "bob") => got[who].filter((e) => e.what === "battle.win" || e.what === "battle.loss" || e.what === "battle.draw");
  assertEquals([outcome("alice").length, outcome("bob").length], [1, 1], "exactly one outcome each");
  const expected = result.winner === 2 ? ["battle.draw", "battle.draw"] : result.winner === 0 ? ["battle.win", "battle.loss"] : ["battle.loss", "battle.win"];
  assertEquals([outcome("alice")[0].what, outcome("bob")[0].what], expected);
  for (const who of ["alice", "bob"] as const) for (const e of got[who]) assertEquals(e.who, who, `${e.what} attributed to ${who}`);
  const ids = [new Set(teams[0].members.map((g) => g.id)), new Set(teams[1].members.map((g) => g.id))];
  for (const e of got.alice.filter((x) => x.what === "battle.hit")) {
    assert(ids[0].has(e.from), "alice's hits are struck by alice's fighters");
    assert(typeof e.entries.element === "string" && typeof e.entries.weatherId === "string", "element and sky added");
  }
  assert(got.alice.some((x) => x.what === "battle.decide") && got.bob.some((x) => x.what === "battle.decide"), "both sides decide");
  if (result.winner !== 2) {
    const side = result.winner;
    const win = (side === 0 ? outcome("alice") : outcome("bob"))[0];
    const alive = result.fighters.filter((f) => f.team === side && f.alive).length;
    const reactions = result.fighters.filter((f) => f.team === side).reduce((s, f) => s + f.tally.reactions, 0);
    assertEquals(win.exits.survivors, alive, "survivors = fighters of the winning side still standing");
    assertEquals(win.exits.reactions, reactions, "reactions = those caused by the winning side");
    assertEquals([win.entries.hour, win.entries.night, win.entries.weather], [23, true, "rain"]);
  }
  assertEquals(alice.achievementProgress("night-shift"), result.winner === 0 ? 1 : 0, "Night Shift moves only if alice won");
});

Deno.test("[PROGRESS] a battle counts once per seed (X1): replays and abandoned battles count nothing", () => {
  const owners: [string, string] = ["max", "rival"];
  const p = new Progress("max");
  const c = ctx("max", { hour: 23 });
  const hit = (seed: number) => row("battle.hit", { who: "m1", from: "m1", to: "r1", tags: [`battle:${seed}`], entries: { move: "sparkBolt", type: 2, crit: false }, exits: { damage: 30, hp: 10, hpFrac: 0.1 } });
  const fight = (seed: number, end = true) => {
    p.ingest(battleStart(seed, owners, [["m1"], ["r1"]], 23), c);
    p.ingest(hit(seed), c);
    return end ? p.ingest(battleEnd(seed, owners, 0, 23), c) : undefined;
  };
  const counters = () => [p.achievementProgress("arena-regular"), p.achievementProgress("know-your-types")];
  p.ingest(battleStart(801, owners, [["m1"], ["r1"]], 23), c);
  p.ingest(hit(801), c);
  assertEquals(counters(), [0, 0], "a battle's events are held until its outcome");
  p.ingest(battleEnd(801, owners, 0, 23), c);
  assertEquals(counters(), [1, 1], "...and counted at battle.end");
  const replay = fight(801)!;
  assertEquals([replay.credits, replay.unlocked.length, replay.questSteps.length], [0, 0, 0], "a replayed seed pays nothing");
  assertEquals(counters(), [1, 1], "...and counts nothing");
  fight(802, false);
  fight(803);
  assertEquals(counters(), [2, 2], "the abandoned 802 never counts, 803 does");
  fight(802);
  assertEquals(counters(), [3, 3], "802 played to the end later is a first play (the app did not pay it either)");
  assertEquals(p.adoptBattles([804, 804, Number.NaN, ""]), 1, "seeds from Profile.rewardedSeeds");
  fight(804);
  assertEquals(counters(), [3, 3], "an adopted seed is a replay");
  const back = Progress.fromJSON(JSON.parse(JSON.stringify(p.toJSON())), "max");
  back.ingest(battleStart(803, owners, [["m1"], ["r1"]], 23), c);
  back.ingest(battleEnd(803, owners, 0, 23), c);
  assertEquals(back.achievementProgress("arena-regular"), 3, "counted seeds survive a save / load");
});

// ------------------------------------------------------------------------------------------ quests

Deno.test("[PROGRESS] a physical-only quest step ignores rows with physical=false", () => {
  const p = new Progress("max");
  const c = ctx("max", { physical: true });
  p.refresh(c);
  assert(isActive(p, "daily-steps"), "Daily Steps is offered while physically present");
  const walk = (physical: boolean) => row("genemon.experience", { who: "max", from: "max", to: "m1", where: LAB, entries: { experience: "travelKm", units: 2, physical }, exits: { xp: 500 } });
  const r1 = p.ingest(walk(false), c);
  assertEquals(stepCount(p, "daily-steps", "walk"), 0, "a walk logged from the sofa does not move the step");
  assertEquals(r1.completed, []);
  assertEquals(p.achievementProgress("first-steps"), 0, "physical achievements follow the same gate");
  p.ingest(row("genemon.experience", { who: "max", from: "max", to: "m1", where: { ...LAB, space: "physical" }, entries: { experience: "travelKm", units: 2, physical: false }, exits: { xp: 500 } }), c);
  assertEquals(stepCount(p, "daily-steps", "walk"), 0, "an explicit physical=false wins over a physical place");
  const r2 = p.ingest(walk(true), c);
  assert(r2.completed.some((q) => q.id === "daily-steps"), "a real 2 km walk completes Daily Steps");
  assertEquals(p.achievementProgress("first-steps"), 2, "km are weighted by entries.units");
  const sofa = new Progress("max");
  sofa.refresh(ctx("max", { physical: false }));
  assert(sofa.activeQuests().every((v) => !v.quest.physicalOnly), "no errand is offered on the sofa");
});

Deno.test("[PROGRESS] presence is inferred from physical rows for 30 min and errands follow it", () => {
  const p = new Progress("max");
  const at = (min: number) => ctx("max", { physical: undefined, now: NOON + min * 60_000 });
  p.refresh(at(0));
  assert(p.activeQuests().every((v) => !v.quest.physicalOnly), "no proof of presence yet: no errand");
  assert(!p.isPresent(NOON));
  p.ingest(row("genemon.experience", { who: "max", to: "m1", where: LAB, entries: { experience: "sunbathing", units: 1, physical: true }, exits: { xp: 10 } }), at(1));
  assert(p.isPresent(NOON + 60_000) && p.activeQuests().some((v) => v.quest.physicalOnly), "a physical row proves presence: errands are offered");
  p.ingest({ id: "qc-sofa", seq: 0, ...questCompleteRow(QUEST_BY_ID["daily-breakfast"], "max", NOON + 2 * 60_000) }, at(2));
  assert(p.isPresent(NOON + 3 * 60_000), "a sofa quest's completion (physical=false) does not end presence");
  assert(p.isPresent(NOON + 31 * 60_000) && !p.isPresent(NOON + 32 * 60_000), "presence lasts PRESENCE_MS after the last proof");
});

Deno.test("[PROGRESS] the store's storage helpers: key per profile, corrupt data starts fresh, forget removes", () => {
  const mem = new Map<string, string>();
  const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
  const p = new Progress("max-1");
  p.ingest(feed("max-1", 2, "spicyPepper"), ctx("max-1"));
  saveProgress(storage, p);
  assertEquals([...mem.keys()], ["genemon.progress.max-1"]);
  assertEquals(progressKey("max-1"), "genemon.progress.max-1");
  assertEquals(loadProgress(storage, "max-1").toJSON(), p.toJSON(), "saved and loaded alike");
  assertEquals(loadProgress(storage, "other").achievementProgress("hot-stuff"), 0, "another profile starts empty");
  mem.set(progressKey("max-2"), "{not json");
  assertEquals(loadProgress(storage, "max-2").unlockedCount, 0, "unreadable data: a fresh Progress, no throw");
  forgetProgress(storage, "max-1");
  assertEquals(mem.has("genemon.progress.max-1"), false);
});

Deno.test("[PROGRESS] time windows gate progress, not only the offer", () => {
  const p = new Progress("max");
  const morning = ctx("max", { hour: 8, physical: true });
  p.refresh(morning);
  assert(isActive(p, "daily-sun-salute"), "Sun Salute (07-11h, clear) is offered at 8h");
  const sun = () => row("genemon.experience", { who: "max", to: "m1", where: LAB, entries: { experience: "sunbathing", units: 1, physical: true }, exits: { xp: 10 } });
  p.ingest(sun(), ctx("max", { hour: 12, physical: true }));
  assertEquals(stepCount(p, "daily-sun-salute", "sun"), 0, "sunbathing at noon is outside the window");
  const r = p.ingest(sun(), ctx("max", { hour: 9, physical: true }));
  assert(r.completed.some((q) => q.id === "daily-sun-salute"), "at 9h it counts");
});

Deno.test("[PROGRESS] reward credits are returned exactly once (also after a save / load)", () => {
  const p = new Progress("max");
  const c = ctx("max");
  const bid = () => row("market.bid", { who: "max", where: { ...ARENA, zone: "market", space: "market" }, entries: { listingId: "L1", itemId: "lure.fire", qty: 1, amount: 60, minBid: 50, prevBid: 0, msLeft: 9000 }, exits: { currentBid: 60, endsAt: 1, extended: false, refundTo: "", refundAmount: 0, balance: 440 } });
  const r1 = p.ingest(bid(), c);
  assertEquals(r1.unlocked.map((a) => a.id), ["paddle-up"]);
  assertEquals(r1.credits, ACHIEVEMENT_BY_ID["paddle-up"].reward.credits);
  const r2 = p.ingest(bid(), c);
  assertEquals([r2.unlocked.length, r2.credits], [0, 0], "the same achievement never pays twice");
  const back = Progress.fromJSON(JSON.parse(JSON.stringify(p.toJSON())), "max");
  const r3 = back.ingest(bid(), c);
  assertEquals([r3.unlocked.length, r3.credits], [0, 0], "nor after a reload");
  assertEquals(p.earned().credits, ACHIEVEMENT_BY_ID["paddle-up"].reward.credits);
  const adopted = new Progress("max");
  adopted.adoptUnlocked(["paddle-up"], NOON);
  assertEquals(adopted.ingest(bid(), c).credits, 0, "ids already in profile.achievements are adopted without reward");
});

Deno.test("[PROGRESS] daily quests reset on a new local day", () => {
  const day1 = ctx("max", { now: Date.UTC(2026, 9, 12, 8, 0), hour: 10 });
  const day2 = ctx("max", { now: Date.UTC(2026, 9, 13, 8, 0), hour: 10 });
  const a = new Progress("max");
  a.ingest(feed("max", 2), day1);
  assertEquals(stepCount(a, "daily-breakfast", "feed"), 2);
  a.refresh(day2);
  assertEquals(stepCount(a, "daily-breakfast", "feed"), 0, "yesterday's unfinished daily starts over");

  const b = new Progress("max");
  const r1 = b.ingest(feed("max", 3), day1);
  assert(r1.completed.some((q) => q.id === "daily-breakfast"), "3 portions complete Breakfast Bowl");
  assertEquals(r1.xp, QUEST_BY_ID["daily-breakfast"].reward.xp);
  const r2 = b.ingest(feed("max", 3), day1);
  assert(!r2.completed.some((q) => q.id === "daily-breakfast"), "not twice the same day");
  const r3 = b.ingest(feed("max", 3), day2);
  assert(r3.completed.some((q) => q.id === "daily-breakfast"), "offered and completed again the next day");
  assertEquals(b.completions("daily-breakfast"), 2);
  const story = new Progress("max");
  story.ingest(feed("max", 3), day1);
  const once = story.completions("story-rill-1") + story.completions("sofa-concert");
  story.refresh(day2);
  assert(story.activeQuests().every((v) => v.quest.kind === "daily" || v.acceptedAt === day1.now), "non-daily quests survive midnight");
  assertEquals(story.completions("story-rill-1") + story.completions("sofa-concert"), once);
});

Deno.test("[PROGRESS] the quest log: at most 5, only reachable quests, story chains and drops", () => {
  const p = new Progress("max");
  const accepted = p.refresh(ctx("max", { physical: true }));
  const active = p.activeQuests();
  assertEquals(accepted.length, active.length);
  assert(active.length >= 3 && active.length <= MAX_ACTIVE, `${active.length} quests active`);
  assert(active.filter((v) => !v.quest.physicalOnly).length <= 3 && active.filter((v) => v.quest.physicalOnly).length <= 2, "3 sofa + 2 errand slots");
  for (const v of active) assert(questReachable(v.quest), `${v.quest.id} can progress on today's rows`);
  assert(active.some((v) => v.quest.kind === "daily") && active.some((v) => v.quest.kind === "story"), "a daily and a story chapter");
  assert(!active.some((v) => v.quest.after !== undefined), "chapter 2+ waits for chapter 1");
  const first = active.find((v) => !v.quest.physicalOnly)!.quest.id;
  assert(p.abandon(first));
  p.refresh(ctx("max", { physical: true, hour: 13 }));
  assert(!isActive(p, first), "a dropped quest is not offered again the same day");
  assert(!p.abandon("not-a-quest"));
  const low = new Progress("max");
  low.refresh(ctx("max", { level: 1 }));
  assert(low.activeQuests().every((v) => v.quest.minLevel <= 1), "minLevel gates the offer");
});

Deno.test("[PROGRESS] reachability: derived keys count, missing emitters do not, seen events do", () => {
  assert(questReachable(QUEST_BY_ID["daily-spar"]), "battle.win is derived from battle.end");
  assert(questReachable(QUEST_BY_ID["battle-close-quarters"]), "contact and weatherId are derived from the move and the sky");
  assert(questReachable(QUEST_BY_ID["breed-three-generations"]), "generation is read from the Lab's genemon.create");
  assert(questReachable(QUEST_BY_ID["story-echo-1"]), "quest.complete is written by the progress store");
  assert(!questReachable(QUEST_BY_ID["daily-window-shopping"]), "no market row seen yet");
  assert(!questReachable(QUEST_BY_ID["sofa-smoke-screen"]), "battle.miss exits.reason is not written");
  assert(!canProgress(ACHIEVEMENT_BY_ID["colossus"].trigger), "team slots and sizes are not in battle rows");
  assert(QUESTS.filter((q) => questReachable(q)).length >= 20, "a real quest log is possible today");
  assert(canProgress(QUEST_BY_ID["daily-window-shopping"].steps[0].trigger, { "market.bid": ["listingId", "amount"] }), "once seen, an event is live");
  assert(!canProgress(ACHIEVEMENT_BY_ID["pedigree"].trigger, { "market.sold": ["price", "sellerId"] }), "...but only with the keys really seen");
  const p = new Progress("max");
  const c = ctx("max");
  p.refresh(c);
  assert(!isActive(p, "daily-window-shopping"));
  p.ingest(row("market.bid", { who: "max", entries: { listingId: "L", amount: 5 }, exits: {} }), c);
  assert(p.seen()["market.bid"]?.includes("amount"), "the profile's market rows mark market.bid live");
});

// ------------------------------------------------------------------------------------------ lab & consumer rows

Deno.test("[PROGRESS] Lab rows: bred / fused children become genemon.breed / genemon.fuse", () => {
  const p = new Progress("max");
  const c = ctx("max");
  const create = (who: string, why: string, child: string, gen: number) =>
    row("genemon.create", { who, why, from: "lab", to: child, where: { ...LAB, space: "ui" }, entries: { detail: `Zorbax gen ${gen}` } });
  const r1 = p.ingest(create("max", "bred Ava × Bo", "c1", 3), c);
  assert(r1.unlocked.some((a) => a.id === "matchmaker"), "a bred child is a breed");
  assert(r1.unlocked.some((a) => a.id === "third-generation"), "generation 3 read from the detail");
  p.ingest(create("max", "fused Ava + Bo", "c2", 2), c);
  assert(p.isUnlocked("two-become-one"), "a fused child is a fusion");
  p.ingest(create("max", "morphed 50%", "c3", 2), c);
  p.ingest(create("max", "mutated Ava", "c4", 1), c);
  p.ingest(create("claude", "bred X × Y", "c9", 1), c);
  assertEquals(p.achievementProgress("breeder"), 1, "morph, mutate and other players' children are no breed");
  p.ingest(row("genemon.breed", { who: "max", to: "c1", where: LAB, entries: { parentA: "a", parentB: "b", distance: 0.4 }, exits: { child: "c1", generation: 3, mutations: 0, kind: "biped", primary: "fire", sizeClass: "S" } }), c);
  assertEquals(p.achievementProgress("breeder"), 1, "a real genemon.breed row for the same child is not counted twice");
});

Deno.test("[PROGRESS] quest.complete / achievement.unlock rows written by the store count like any row", () => {
  const p = new Progress("max");
  const c = ctx("max");
  const put = (id: string, r: ReturnType<typeof questCompleteRow>) => p.ingest({ id, seq: 0, ...r }, c);
  for (let i = 0; i < 3; i++) put(`qc-${i}`, questCompleteRow(QUEST_BY_ID["daily-breakfast"], "max", NOON));
  assertEquals(p.achievementProgress("creature-of-habit"), 3, "daily completions");
  assertEquals(p.achievementProgress("lore-keeper"), 0, "story only");
  put("qc-p", questCompleteRow(QUEST_BY_ID["daily-steps"], "max", NOON));
  assertEquals(p.achievementProgress("out-and-about"), 1, "a physical quest counts for Out and About");
  assertEquals(p.achievementProgress("creature-of-habit"), 4, "Daily Steps is a daily too");
  put("au-1", achievementUnlockRow(ACHIEVEMENT_BY_ID["first-victory"], "max", NOON));
  assertEquals(p.achievementProgress("completionist"), 1);
  put("qc-x", questCompleteRow(QUEST_BY_ID["daily-breakfast"], "claude", NOON));
  assertEquals(p.achievementProgress("creature-of-habit"), 4, "another player's completion never counts");
});

// ------------------------------------------------------------------------------------------ robustness

Deno.test("[PROGRESS] toJSON / fromJSON round-trips counters, the quest log and rewards", () => {
  const owners: [string, string] = ["max", "rival"];
  const p = new Progress("max");
  const c = ctx("max", { hour: 23 });
  p.ingest(battleStart(706, owners, [["m1"], ["r1"]], 23), c);
  p.ingest(row("battle.reaction", { who: "m1", from: "fire", to: "water", tags: ["battle:706"], entries: { a: "fire", b: "water" }, exits: { reaction: "smoke", damageMult: 0.6, zone: "smoke" } }), c);
  p.ingest(battleEnd(706, owners, 0, 23), c);
  p.ingest(feed("max", 2, "spicyPepper"), c);
  const json = p.toJSON();
  const back = Progress.fromJSON(JSON.parse(JSON.stringify(json)), "max");
  assertEquals(back.toJSON(), json, "every counter survives");
  assertEquals([back.achievementProgress("reaction-smoke"), back.achievementProgress("hot-stuff")], [1, 2]);
  assert(back.isUnlocked("first-victory"));
  assertEquals(back.activeQuests().map((v) => [v.quest.id, v.steps.map((s) => s.count)]), p.activeQuests().map((v) => [v.quest.id, v.steps.map((s) => s.count)]));
  const next = feed("max", 1, "spicyPepper");
  p.ingest(next, c);
  back.ingest(next, c);
  assertEquals(back.toJSON(), p.toJSON(), "both go on identically");

  const junk = Progress.fromJSON({ profileId: "max", ach: { "hot-stuff": "9", gourmet: 3, nope: 4, constructor: 7 }, unlocked: "x", active: [{ id: "nope" }, { id: "daily-breakfast", steps: { feed: 99 } }, 5], day: "x", titles: [1, "Legend"] }, "max");
  assertEquals([junk.achievementProgress("hot-stuff"), junk.achievementProgress("gourmet"), junk.achievementProgress("constructor")], [0, 3, 0]);
  assertEquals(junk.activeQuests().map((v) => v.quest.id), ["daily-breakfast"]);
  assertEquals(stepCount(junk, "daily-breakfast", "feed"), 3, "clamped to the step count");
  assertEquals(junk.titles(), ["Legend"]);
  assertEquals(Progress.fromJSON({ profileId: "someone-else", ach: { gourmet: 3 } }, "max").achievementProgress("gourmet"), 0, "another profile's state is not adopted");
  for (const bad of [null, undefined, 42, "x", [], { active: "x", done: [1], seen: { "market.bid": "x" } }]) Progress.fromJSON(bad, "max").refresh(ctx("max"));
});

Deno.test("[PROGRESS] deriveContentEvents never throws and unknown rows derive nothing", () => {
  const shapes: unknown[] = [
    null, undefined, 0, "battle.end", [], {}, { what: 5 }, { what: "" },
    { what: "battle.end" }, { what: "battle.end", exits: null, entries: [] }, { what: "battle.end", from: "max", exits: { winner: "0" } },
    { what: "battle.start", tags: ["battle:9"], entries: { teamA: 5, teamB: null, seed: {} } }, { what: "battle.start", entries: { seed: 9 }, from: 1, to: {} },
    { what: "battle.hit", tags: "battle:9" }, { what: "battle.hit", tags: [null, 5, "battle:9"], who: 7, entries: { move: "constructor" } },
    { what: "battle.ko", tags: ["battle:9"], exits: { team: "0" } }, { what: "genemon.create", why: null, who: "max" },
    { what: "genemon.create", why: "bred", who: "max", entries: { detail: 5 } }, { what: "market.sold", exits: { sellerId: { x: 1 } } },
    { what: "genemon.feed", who: "max", entries: { units: NaN, food: Infinity }, where: "lab" },
  ];
  const names = [...Object.keys(CONTENT_EVENTS), "battle.lightning", "battle.draw", "genemon.create", "team.change", "ui.navigate", "ui.settings", "ui.profile.switch", "device.session.start", "device.gpu", "anything.else"];
  for (const what of names) {
    shapes.push({ what }, { what, who: "max", entries: { x: NaN }, exits: [] }, row(what, { who: "max", tags: ["battle:9"] }));
  }
  shapes.push(Object.defineProperty({}, "what", { get() { throw new Error("hostile row"); } }));
  for (const s of shapes) {
    for (const c of [{ profileId: "max", hour: 23 }, { profileId: "", hour: NaN }, null]) {
      const out = deriveContentEvents(s as GEvent, c as { profileId: string; hour: number });
      assert(Array.isArray(out), "always an array");
      for (const d of out) {
        assertEquals(d.who, "max");
        for (const v of [...Object.values(d.entries), ...Object.values(d.exits)]) assert(["number", "string", "boolean"].includes(typeof v), "flat payload");
      }
    }
  }
  const p = new Progress("max");
  for (const s of shapes) p.ingest(s as GEvent, ctx("max"));
  for (const what of ["team.change", "ui.navigate", "device.gpu", "battle.lightning", "anything.else"]) {
    assertEquals(deriveContentEvents(row(what, { who: "max", tags: ["battle:9"] }), { profileId: "max", hour: 12 }), [], `${what} derives nothing`);
  }
});

Deno.test("[PROGRESS] local day and week from (now, hour) across midnight and time zones", () => {
  const day = (m: number, d: number) => Math.floor(Date.UTC(2026, m, d) / DAY_MS);
  assertEquals(localDay(Date.UTC(2026, 9, 12, 21, 30), 23.5), day(9, 12), "23:30 CEST on the 12th");
  assertEquals(localDay(Date.UTC(2026, 9, 12, 22, 30), 0.5), day(9, 13), "00:30 CEST is the 13th while UTC is still on the 12th");
  assertEquals(localDay(Date.UTC(2026, 9, 13, 6, 0), 20), day(9, 12), "Honolulu (UTC-10): 20:00 on the 12th");
  assertEquals(localDay(Date.UTC(2026, 9, 12, 11, 0), 0), day(9, 13), "Auckland summer time (UTC+13)");
  assertEquals((day(9, 12) + 3) % 7, 0, "12 October 2026 is a Monday");
  assertEquals(localWeek(day(9, 12)), localWeek(day(9, 18)), "Monday to Sunday is one week");
  assertEquals(localWeek(day(9, 19)) - localWeek(day(9, 18)), 1, "a new week starts on Monday");
});
