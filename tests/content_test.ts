/**
 * Content contract tests: src/data/achievements.ts + src/data/quests.ts, plus drift checks that keep
 * docs/LISTS.md and docs/SCENARIOS.md honest (every scenario fixture must reference real ids, form a
 * legal team, and the data each mandated scenario relies on must hold today). Real rows written by
 * genemon.ts, battle.ts and market.ts are checked against the emitted part of CONTENT_EVENTS.
 * Run: deno test --allow-read tests/content_test.ts
 */
import { assert, assertEquals } from "./_assert.ts";
import {
  ACHIEVEMENT_BY_ID,
  ACHIEVEMENT_CATEGORIES,
  ACHIEVEMENTS,
  CONTENT_EVENTS,
  CONTENT_VOCAB,
  type Domain,
  eventWeight,
  type EventSpec,
  ME,
  parseFilterKey,
  progressesToday,
  resolveKey,
  REWARD_ITEMS,
  type Trigger,
  triggerMatches,
} from "../src/data/achievements.ts";
import { inTimeWindow, isPhysicalTrigger, type Quest, QUEST_BY_ID, QUEST_GIVERS, QUEST_KINDS, questAvailable, type QuestContext, QUESTS } from "../src/data/quests.ts";
import { AXIS_BY_ID, AXIS_IDS } from "../src/data/axes.ts";
import { ELEMENT_IDS, REACTIONS, reactionBetween, typeMultiplier } from "../src/data/elements.ts";
import { GROUND_IDS, GROUNDS, transformGround } from "../src/data/grounds.ts";
import { WEATHER_IDS, WEATHERS } from "../src/data/weather.ts";
import { EXPERIENCE_IDS, FOOD_IDS } from "../src/data/lifestyle.ts";
import { STATUS_IDS, TIER_LEVEL } from "../src/combat/moves.ts";
import { ALL_MOVE_BY_ID as MOVE_BY_ID, ALL_MOVES as MOVES } from "../src/combat/kit.ts";
import { type Abilities, express, POWER_BUDGET, SIZE_CLASSES, SLOT_COST } from "../src/genome/phenotype.ts";
import { BODY_KINDS, PATTERNS, randomGenome } from "../src/genome/genome.ts";
import { type Conditions, emptyConditions, xpForLevel } from "../src/genome/epigenetics.ts";
import { createGenemon, expose, feed, grantXp, live } from "../src/genome/genemon.ts";
import { type GEvent, Ledger, type Space } from "../src/core/ledger.ts";
import { Battle } from "../src/combat/battle.ts";
import { ARCHETYPES, arenaSpec, makeArchetype, team } from "../src/combat/scenario.ts";
import { autoTeam, type Team } from "../src/combat/team.ts";
import { AuctionHouse } from "../src/economy/market.ts";
import { ITEM_KINDS } from "../src/economy/items.ts";
import { ARENA_KINDS } from "../src/world/arena.ts";

const SPACE_VALUES: readonly Space[] = ["physical", "virtual", "arena", "lab", "market", "world", "sim", "ui", "device"];
/** Team capacity in slots (XS/S 1, M 2, L 3, XL 4). */
const TEAM_SLOTS = 6;
const ABILITY_KEYS: readonly (keyof Abilities)[] = ["fly", "swim", "dig", "phaseShift", "weatherShaper", "terraformer"];

type IdDomain = Exclude<Domain, "number" | "boolean" | "hour" | "text" | "player">;
/** Every id domain a payload key can declare, resolved against the module that owns it. */
const DOMAINS: Record<IdDomain, readonly string[]> = {
  element: ELEMENT_IDS,
  elementOrNone: [...ELEMENT_IDS, "none"],
  reaction: REACTIONS.map((r) => r.id),
  ground: GROUND_IDS,
  weather: WEATHER_IDS,
  food: FOOD_IDS,
  experience: EXPERIENCE_IDS,
  status: STATUS_IDS,
  move: MOVES.map((m) => m.id),
  moveShape: [...new Set(MOVES.map((m) => m.shape))],
  sizeClass: SIZE_CLASSES,
  bodyKind: BODY_KINDS,
  pattern: PATTERNS,
  questKind: QUEST_KINDS,
  achievementCategory: ACHIEVEMENT_CATEGORIES,
  poi: CONTENT_VOCAB.poi,
  battleMode: CONTENT_VOCAB.battleMode,
  dodgeReason: CONTENT_VOCAB.dodgeReason,
  ladderTier: CONTENT_VOCAB.ladderTier,
  itemKind: CONTENT_VOCAB.itemKind,
  arenaKind: CONTENT_VOCAB.arenaKind,
};

/** Every problem with one trigger (empty = valid). Shared by achievements, quest steps and giver arcs. */
function triggerErrors(label: string, t: Trigger): string[] {
  const spec = CONTENT_EVENTS[t.what];
  if (!spec) return [`${label}: unknown ledger event "${t.what}"`];
  const err: string[] = [];
  if (!Number.isInteger(t.count) || t.count < 1) err.push(`${label}: count ${t.count} must be an integer >= 1`);
  if (t.where !== undefined && !SPACE_VALUES.includes(t.where as Space) && !(CONTENT_VOCAB.poi as readonly string[]).includes(t.where)) {
    err.push(`${label}: where "${t.where}" is neither a Space nor a poi`);
  }
  for (const [raw, value] of Object.entries(t.filter ?? {})) {
    const { scope, key, op } = parseFilterKey(raw);
    const inEntries = resolveKey(spec, `entries.${key}`) !== undefined, inExits = resolveKey(spec, `exits.${key}`) !== undefined;
    if (scope === "any" && inEntries && inExits) err.push(`${label}: "${raw}" is ambiguous on ${t.what}; use entries./exits.`);
    const domain: Domain | undefined = resolveKey(spec, raw)?.domain;
    if (!domain) {
      err.push(`${label}: ${t.what} has no payload key "${raw}"`);
      continue;
    }
    if (domain === "player") {
      if (value !== ME || op !== "=") err.push(`${label}: "${raw}" names a player; content may only filter it as ${ME}`);
      continue;
    }
    if (domain === "text") {
      err.push(`${label}: "${raw}" filters a free-text key`);
      continue;
    }
    const numeric = domain === "number" || domain === "hour";
    if (op === ">=" || op === "<=") {
      if (!numeric || typeof value !== "number") err.push(`${label}: "${raw}" needs a numeric key and value`);
      continue;
    }
    if (numeric) {
      if (typeof value !== "number") err.push(`${label}: "${raw}" expects a number`);
      else if (domain === "hour" && !(Number.isInteger(value) && value >= 0 && value <= 23)) err.push(`${label}: hour ${value} outside 0-23`);
      continue;
    }
    if (domain === "boolean") {
      if (typeof value !== "boolean") err.push(`${label}: "${raw}" expects a boolean`);
      continue;
    }
    if (typeof value !== "string" || !DOMAINS[domain as IdDomain].includes(value)) {
      err.push(`${label}: ${raw}=${JSON.stringify(value)} is not a known ${domain}`);
    }
  }
  return err;
}

const allTriggers = (): [string, Trigger][] => [
  ...ACHIEVEMENTS.map((x): [string, Trigger] => [`achievement ${x.id}`, x.trigger]),
  ...QUESTS.flatMap((q) => q.steps.map((st): [string, Trigger] => [`quest ${q.id}/${st.id}`, st.trigger])),
  ...QUEST_GIVERS.flatMap((g) => g.arc.flatMap((stage, i): [string, Trigger][] => (stage.unlock ? [[`giver ${g.name} stage ${i + 1}`, stage.unlock]] : []))),
];

const has = (t: Trigger, what: string, filter: Record<string, unknown> = {}) =>
  t.what === what && Object.entries(filter).every(([k, v]) => t.filter?.[k] === v);

// ------------------------------------------------------------------------------------------ content

Deno.test("[CONTENT] ids are unique: achievements, quests, quest steps, givers, titles", () => {
  const dup = (xs: string[]) => xs.filter((x, i) => xs.indexOf(x) !== i);
  assertEquals(dup(ACHIEVEMENTS.map((x) => x.id)), [], "duplicate achievement ids");
  assertEquals(dup(QUESTS.map((q) => q.id)), [], "duplicate quest ids");
  assertEquals(dup(QUEST_GIVERS.map((g) => g.name)), [], "duplicate giver names");
  assertEquals(dup(ACHIEVEMENTS.flatMap((x) => (x.reward.title ? [x.reward.title] : []))), [], "duplicate titles");
  for (const q of QUESTS) assertEquals(dup(q.steps.map((st) => st.id)), [], `duplicate step ids in ${q.id}`);
  for (const x of [...ACHIEVEMENTS, ...QUESTS]) assert(/^[a-z0-9]+(-[a-z0-9]+)*$/.test(x.id), `id "${x.id}" is not kebab-case`);
});

Deno.test("[CONTENT] coverage: >= 60 achievements over every category, >= 40 quests over every kind", () => {
  assert(ACHIEVEMENTS.length >= 60, `only ${ACHIEVEMENTS.length} achievements`);
  assert(QUESTS.length >= 40, `only ${QUESTS.length} quests`);
  for (const c of ACHIEVEMENT_CATEGORIES) assert(ACHIEVEMENTS.some((x) => x.category === c), `no achievement in category ${c}`);
  for (const k of QUEST_KINDS) assert(QUESTS.some((q) => q.kind === k), `no quest of kind ${k}`);
  for (const tier of [1, 2, 3, 4]) assert(ACHIEVEMENTS.some((x) => x.tier === tier), `no tier-${tier} achievement`);
  assert(QUESTS.filter((q) => q.physicalOnly).length >= 10, "fewer than 10 physical quests");
  assert(QUESTS.filter((q) => !q.physicalOnly).length >= 20, "fewer than 20 sofa-completable quests");
});

Deno.test("[CONTENT] rewards are positive and achievement credits rise with tier", () => {
  const band: Record<number, [number, number]> = { 1: [1, 200], 2: [150, 800], 3: [500, 3000], 4: [2500, 20000] };
  for (const x of ACHIEVEMENTS) {
    assert(Number.isInteger(x.reward.credits) && x.reward.credits > 0, `${x.id}: credits must be a positive integer`);
    const [lo, hi] = band[x.tier];
    assert(x.reward.credits >= lo && x.reward.credits <= hi, `${x.id}: tier ${x.tier} pays ${x.reward.credits}, band ${lo}-${hi}`);
  }
  const mean = (tier: number) => {
    const xs = ACHIEVEMENTS.filter((x) => x.tier === tier).map((x) => x.reward.credits);
    return xs.reduce((s, v) => s + v, 0) / xs.length;
  };
  assert(mean(1) < mean(2) && mean(2) < mean(3) && mean(3) < mean(4), "mean credits must rise strictly with tier");
  for (const q of QUESTS) {
    assert(Number.isInteger(q.reward.credits) && q.reward.credits > 0, `${q.id}: credits must be a positive integer`);
    assert(Number.isInteger(q.reward.xp) && q.reward.xp > 0, `${q.id}: xp must be a positive integer`);
    assert(Number.isInteger(q.minLevel) && q.minLevel >= 1 && q.minLevel <= 100, `${q.id}: minLevel ${q.minLevel}`);
    assert(q.steps.length >= 1 && q.steps.length <= 4, `${q.id}: needs 1-4 steps`);
  }
});

Deno.test("[CONTENT] physical quests pay a credit premium per step but never more XP per step (power parity)", () => {
  const median = (xs: number[]) => {
    const s = [...xs].sort((x, y) => x - y);
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  };
  const perStep = (physical: boolean, key: "credits" | "xp") =>
    median(QUESTS.filter((q) => q.physicalOnly === physical).map((q) => q.reward[key] / q.steps.length));
  assert(perStep(true, "credits") >= perStep(false, "credits"), `physical ${perStep(true, "credits")} cr/step < sofa ${perStep(false, "credits")}`);
  assert(perStep(true, "xp") <= perStep(false, "xp"), `physical ${perStep(true, "xp")} xp/step > sofa ${perStep(false, "xp")}: walking must not buy power`);
});

Deno.test("[CONTENT] every trigger names a known ledger event with valid keys, values and counts >= 1", () => {
  const triggers = allTriggers();
  assert(triggers.length > ACHIEVEMENTS.length + QUESTS.length, "trigger walk missed something");
  const errors = triggers.flatMap(([label, t]) => triggerErrors(label, t));
  assertEquals(errors, [], "invalid triggers");
});

Deno.test("[CONTENT] the trigger checker itself can fail (typos are caught)", () => {
  assert(triggerErrors("x", { what: "battle.reacton", count: 1 }).length === 1, "unknown event not caught");
  assert(triggerErrors("x", { what: "battle.reaction", count: 0 }).length === 1, "count 0 not caught");
  assert(triggerErrors("x", { what: "battle.reaction", count: 1, filter: { reaction: "smog" } }).length === 1, "bad reaction id not caught");
  assert(triggerErrors("x", { what: "genemon.feed", count: 1, filter: { food: "spicyPeper" } }).length === 1, "bad food id not caught");
  assert(triggerErrors("x", { what: "world.visit", count: 1, filter: { poi: "supermaket" } }).length === 1, "bad poi not caught");
  assert(triggerErrors("x", { what: "genemon.specialize", count: 1, filter: { secondary: "water" } }).length === 1, "ambiguous scope not caught");
  assert(triggerErrors("x", { what: "battle.win", count: 1, filter: { "mode>=": 3 } }).length === 1, "numeric op on an id key not caught");
  assert(triggerErrors("x", { what: "battle.win", count: 1, where: "moon" }).length === 1, "bad where not caught");
});

Deno.test("[CONTENT] physical quests use only physical-only experiences or world events; sofa quests use none", () => {
  for (const q of QUESTS) {
    const physical = q.steps.map((st) => isPhysicalTrigger(st.trigger));
    if (q.physicalOnly) assert(physical.every(Boolean), `${q.id}: a step can progress from the sofa`);
    else assert(!physical.some(Boolean), `${q.id}: a sofa quest needs real-world presence`);
    if (q.kind === "physical") assert(q.physicalOnly, `${q.id}: kind physical must be physicalOnly`);
    if (q.kind === "sofa") assert(!q.physicalOnly, `${q.id}: kind sofa must not be physicalOnly`);
  }
  assert(isPhysicalTrigger({ what: "genemon.experience", filter: { experience: "nightWalk" } }), "nightWalk is physical-only");
  assert(!isPhysicalTrigger({ what: "genemon.experience", filter: { experience: "swimming" } }), "swimming is a sofa experience");
  assert(isPhysicalTrigger({ what: "world.visit" }), "world.* is physical");
  assert(isPhysicalTrigger({ what: "genemon.catch", filter: { physical: true } }), "physical: true is physical");
  assert(!isPhysicalTrigger({ what: "genemon.catch" }), "an unfiltered catch is not physical");
});

Deno.test("[CONTENT] time windows lie within 0-24, quest weathers are real, availability gates work", () => {
  for (const q of QUESTS) {
    if (q.timeWindow) {
      const { startHour: a, endHour: b } = q.timeWindow;
      assert(Number.isInteger(a) && Number.isInteger(b) && a >= 0 && a <= 24 && b >= 0 && b <= 24, `${q.id}: window ${a}-${b}`);
      assert(a !== b, `${q.id}: empty window`);
    }
    if (q.weather) {
      assert(q.weather.length > 0, `${q.id}: empty weather list`);
      for (const w of q.weather) assert((WEATHER_IDS as readonly string[]).includes(w), `${q.id}: unknown weather ${w}`);
    }
  }
  const night = { startHour: 21, endHour: 4 };
  assert(inTimeWindow(night, 23) && inTimeWindow(night, 0) && inTimeWindow(night, 3.5), "wrapping window must cover the night");
  assert(!inTimeWindow(night, 4) && !inTimeWindow(night, 12), "wrapping window must exclude the day");
  assert(inTimeWindow({ startHour: 7, endHour: 11 }, 7) && !inTimeWindow({ startHour: 7, endHour: 11 }, 11), "window is [start, end)");
  const ctx: QuestContext = { level: 30, hour: 23, weather: "clear", physical: true, completed: new Set(), giverStages: {} };
  const q = (id: string): Quest => QUEST_BY_ID[id];
  assert(questAvailable(q("phys-shadow-hunt"), ctx), "shadow hunt at 23h in person");
  assert(!questAvailable(q("phys-shadow-hunt"), { ...ctx, physical: false }), "shadow hunt needs presence");
  assert(!questAvailable(q("phys-shadow-hunt"), { ...ctx, hour: 12 }), "shadow hunt is night-only");
  assert(!questAvailable(q("phys-shadow-hunt"), { ...ctx, level: 2 }), "shadow hunt has a level gate");
  assert(!questAvailable(q("phys-puddle-jumpers"), ctx) && questAvailable(q("phys-puddle-jumpers"), { ...ctx, weather: "rain" }), "rain-only quest");
  assert(!questAvailable(q("story-noctua-2"), ctx), "chapter 2 needs chapter 1");
  const done = new Set(["story-noctua-1"]);
  assert(!questAvailable(q("story-noctua-2"), { ...ctx, completed: done }), "chapter 2 needs Noctua at stage 2");
  assert(questAvailable(q("story-noctua-2"), { ...ctx, completed: done, giverStages: { Noctua: 2 } }), "chapter 2 opens at stage 2");
});

Deno.test("[CONTENT] story chains and givers: real quests, real stages, same giver, no cycles", () => {
  const giver = new Map(QUEST_GIVERS.map((g) => [g.name, g]));
  for (const g of QUEST_GIVERS) {
    assert(g.arc.length >= 2, `${g.name}: an evolving character needs 2+ stages`);
    assert(g.arc[0].unlock === null, `${g.name}: stage 1 is the starting state`);
    assert(g.arc.slice(1).every((st) => st.unlock !== null), `${g.name}: later stages need an unlock`);
    assert((ELEMENT_IDS as readonly string[]).includes(g.element), `${g.name}: element ${g.element}`);
    assert((CONTENT_VOCAB.poi as readonly string[]).includes(g.home), `${g.name}: home ${g.home}`);
    assert(QUESTS.some((q) => q.giver === g.name), `${g.name} gives no quest`);
  }
  for (const q of QUESTS) {
    const g = giver.get(q.giver);
    assert(g, `${q.id}: unknown giver ${q.giver}`);
    if (q.giverStage !== undefined) assert(Number.isInteger(q.giverStage) && q.giverStage >= 1 && q.giverStage <= g!.arc.length, `${q.id}: giverStage ${q.giverStage}`);
    if (q.after !== undefined) {
      const prev = QUEST_BY_ID[q.after];
      assert(prev, `${q.id}: after ${q.after} does not exist`);
      assertEquals(prev.giver, q.giver, `${q.id}: chain crosses givers`);
      assert((prev.giverStage ?? 1) <= (q.giverStage ?? 1), `${q.id}: chapter needs a lower stage than its predecessor`);
    }
    const seen = new Set<string>();
    for (let cur: Quest | undefined = q; cur?.after; cur = QUEST_BY_ID[cur.after]) {
      assert(!seen.has(cur.id), `${q.id}: cycle in story chain`);
      seen.add(cur.id);
    }
  }
});

Deno.test("[CONTENT] reward items are foods or declared REWARD_ITEMS, and every declared item is used", () => {
  const known = new Set<string>([...FOOD_IDS, ...REWARD_ITEMS]);
  const used = [...ACHIEVEMENTS.map((x) => x.reward.itemId), ...QUESTS.map((q) => q.reward.itemId)].filter((x): x is string => !!x);
  for (const id of used) assert(known.has(id), `unknown reward item ${id}`);
  for (const id of REWARD_ITEMS) assert(used.includes(id), `declared reward item ${id} is never handed out`);
});

Deno.test("[CONTENT] spec-mandated achievements exist", () => {
  const T = ACHIEVEMENTS.map((x) => x.trigger);
  assert(T.some((t) => has(t, "battle.reaction", { reaction: "smoke" }) && t.count >= 10), "create 10 smoke clouds");
  for (const r of REACTIONS) assert(T.some((t) => has(t, "battle.reaction", { reaction: r.id })), `no achievement for reaction ${r.id}`);
  assert(T.some((t) => has(t, "battle.reaction", { reaction: "conduction", ground: "water" })), "conduction on water");
  assert(T.some((t) => has(t, "battle.reaction", { reaction: "conduction", ground: "mud" })), "conduction on mud");
  assert(T.some((t) => has(t, "battle.win", { teamSize: 1 }) && Number(t.filter?.["enemyCount>="]) >= 3), "big Genemon beats a swarm");
  for (const w of WEATHER_IDS) assert(T.some((t) => has(t, "battle.win", { weather: w })), `no win-under-${w} achievement`);
  assert(T.some((t) => has(t, "genemon.breed") && Number(t.filter?.["generation>="]) >= 10), "breeding generations");
  assert(T.some((t) => has(t, "genemon.fuse")), "fusions");
  assert(T.some((t) => has(t, "world.visit", { poi: "gym" })) && T.some((t) => has(t, "genemon.experience", { experience: "gymTraining" })), "gym visits");
  assert(T.some((t) => has(t, "genemon.experience", { experience: "nightWalk" })), "night walks");
  assert(T.some((t) => has(t, "world.visit", { poi: "supermarket" })), "supermarket trips");
  assert(T.some((t) => has(t, "world.defend")), "territory defence");
  assert(T.some((t) => has(t, "market.sold", { sellerId: ME })), "auction sales");
  assert(ACHIEVEMENTS.some((x) => x.trigger.where === "physical"), "at least one achievement uses where");
});

Deno.test("[CONTENT] spec-mandated quests exist", () => {
  const steps = (q: Quest) => q.steps.map((st) => st.trigger);
  assert(QUESTS.filter((q) => q.kind === "daily" && !q.physicalOnly).length >= 5, "daily sofa missions");
  assert(
    QUESTS.some((q) => q.physicalOnly && steps(q).some((t) => has(t, "world.visit", { poi: "supermarket" })) && steps(q).some((t) => has(t, "world.purchase", { item: "spicyPepper" }))),
    "buy spicy peppers at the supermarket",
  );
  assert(
    QUESTS.some((q) => q.physicalOnly && steps(q).some((t) => has(t, "world.visit", { poi: "gym" }) && t.count >= 2) && steps(q).some((t) => has(t, "genemon.experience", { experience: "gymTraining" }))),
    "gym circuit",
  );
  assert(
    QUESTS.some((q) => q.timeWindow && inTimeWindow(q.timeWindow, 0) && !inTimeWindow(q.timeWindow, 12) && steps(q).some((t) => t.filter?.primary === "shadow" || t.filter?.targetElement === "shadow")),
    "night-only shadow hunt",
  );
  assert(
    QUESTS.some((q) => q.weather && q.weather.every((w) => w === "rain" || w === "storm") && steps(q).some((t) => t.filter?.primary === "water")),
    "rain-only water quest",
  );
  const arcs = QUEST_GIVERS.filter((g) => QUESTS.some((q) => q.giver === g.name && q.kind === "story" && (q.giverStage ?? 1) >= 2 && q.after));
  assert(arcs.length >= 4, `only ${arcs.length} givers have multi-stage story arcs`);
});

Deno.test("[CONTENT] triggerMatches / eventWeight semantics (and they can fail)", () => {
  type Row = Pick<GEvent, "what" | "where" | "entries" | "exits">;
  const row = (what: string, entries: Row["entries"], exits: Row["exits"] = {}, space: Space = "arena", zone = "stadium"): Row => ({
    what,
    where: { x: 0, y: 0, z: 0, zone, space },
    entries,
    exits,
  });
  const smoke = row("battle.reaction", { reaction: "smoke", ground: "water" }, { targets: 2, allies: 1 });
  assert(triggerMatches({ what: "battle.reaction", filter: { reaction: "smoke" } }, smoke), "equality");
  assert(!triggerMatches({ what: "battle.reaction", filter: { reaction: "mud" } }, smoke), "equality can fail");
  assert(!triggerMatches({ what: "battle.hit", filter: { reaction: "smoke" } }, smoke), "what must match");
  assert(triggerMatches({ what: "battle.reaction", filter: { "allies>=": 1 } }, smoke), "unscoped key falls back to exits");
  assert(!triggerMatches({ what: "battle.reaction", filter: { "entries.allies>=": 1 } }, smoke), "entries. scope does not look in exits");
  assert(!triggerMatches({ what: "battle.reaction", filter: { "targets>=": 3 } }, smoke), ">= can fail");
  assert(triggerMatches({ what: "battle.reaction", filter: { "targets<=": 2 } }, smoke), "<= inclusive");
  assert(triggerMatches({ what: "battle.reaction", filter: { "ground!=": "stone" } }, smoke), "!=");
  assert(!triggerMatches({ what: "battle.reaction", filter: { "ground!=": "water" } }, smoke), "!= can fail");
  assert(!triggerMatches({ what: "battle.reaction", filter: { weather: "rain" } }, smoke), "missing key never matches");
  assert(!triggerMatches({ what: "battle.reaction", filter: { "reaction>=": 1 } }, smoke), "numeric op on a string never matches");
  const evolve = row("genemon.evolve", { fromStage: 2 }, { toStage: 3 });
  assert(triggerMatches({ what: "genemon.evolve", filter: { "exits.toStage": 3 } }, evolve), "exits. scope");
  const shop = row("world.visit", { poi: "supermarket" }, {}, "physical", "supermarket");
  assert(triggerMatches({ what: "world.visit", where: "physical" }, shop) && triggerMatches({ what: "world.visit", where: "supermarket" }, shop), "where matches space or zone");
  assert(!triggerMatches({ what: "world.visit", where: "virtual" }, shop), "where can fail");
  assertEquals(parseFilterKey("exits.credits>="), { scope: "exits", key: "credits", op: ">=" });
  assertEquals(parseFilterKey("reaction"), { scope: "any", key: "reaction", op: "=" });
  assertEquals(eventWeight({ entries: { units: 2.5 } }), 2.5);
  assertEquals(eventWeight({ entries: {} }), 1);
  assertEquals(eventWeight({ entries: { units: -3 } }), 1);
  assertEquals(eventWeight({ entries: { units: "3" } }), 1);
  const terrain = { ...row("battle.terrain", { move: "frostGround", radius: 2 }, { cells: 9 }), from: "water", to: "ice" };
  assert(triggerMatches({ what: "battle.terrain", filter: { from: "water", to: "ice" } }, terrain), "from/to fall back to the GEvent envelope");
  assert(!triggerMatches({ what: "battle.terrain", filter: { to: "snow" } }, terrain), "envelope equality can fail");
  assert(!triggerMatches({ what: "battle.terrain", filter: { "entries.to": "ice" } }, terrain), "scoped keys never read the envelope");
  const sold = row("market.sold", { price: 60 }, { sellerId: "p1", buyerId: "p2" }, "market", "auction-house");
  assert(triggerMatches({ what: "market.sold", filter: { sellerId: ME } }, sold, "p1"), "ME = the player whose progress is counted");
  assert(!triggerMatches({ what: "market.sold", filter: { sellerId: ME } }, sold, "p2"), "ME can fail (p2 bought, did not sell)");
  assert(!triggerMatches({ what: "market.sold", filter: { sellerId: ME } }, sold), "ME without a player never matches");
});

Deno.test("[CONTENT] player keys only accept ME; requested keys resolve but do not progress today", () => {
  assert(triggerErrors("t", { what: "market.sold", count: 1, filter: { sellerId: "p1" } }).length > 0, "a literal player id is refused");
  assertEquals(triggerErrors("t", { what: "market.sold", count: 1, filter: { sellerId: ME, "price>=": 10 } }), []);
  const hit = CONTENT_EVENTS["battle.hit"];
  assertEquals(resolveKey(hit, "type>="), { domain: "number", source: "entries", requested: false });
  assertEquals(resolveKey(hit, "targetGround"), { domain: "ground", source: "entries", requested: true });
  assertEquals(resolveKey(CONTENT_EVENTS["battle.terrain"], "to"), { domain: "ground", source: "envelope", requested: false });
  assertEquals(resolveKey(hit, "nonsense"), undefined);
  assert(progressesToday({ what: "battle.hit", filter: { "type>=": 2 } }), "emitted key");
  assert(!progressesToday({ what: "battle.hit", filter: { targetGround: "water" } }), "requested key waits for its emitter");
  assert(!progressesToday({ what: "battle.win" }), "proposed event");
  assert(progressesToday({ what: "battle.terrain", filter: { from: "water", to: "ice" } }), "envelope keys are written today");
  assertEquals([...CONTENT_VOCAB.itemKind], [...ITEM_KINDS], "itemKind mirrors src/economy/items.ts ITEM_KINDS");
  assertEquals([...CONTENT_VOCAB.arenaKind], [...ARENA_KINDS], "arenaKind mirrors src/world/arena.ts ARENA_KINDS");
});

Deno.test("[CONTENT] real ledger rows from genemon.ts match the emitted contract and progress real content", () => {
  const ledger = new Ledger("content-test");
  const g = createGenemon({ seed: 11, owner: "tester" });
  feed(g, "spicyPepper", 3, { ledger, when: 1 });
  assert(live(g, "nightWalk", 2, { ledger, when: 2, physical: true }), "night walk accepted in person");
  assert(!live(g, "gymTraining", 1, { ledger, when: 3, physical: false }), "gym refused from the sofa");
  expose(g, "moss", 2, { ledger, when: 4 });
  grantXp(g, xpForLevel(25), { ledger, when: 5 });
  const whats = new Set(ledger.rows().map((r) => r.what));
  for (const w of ["genemon.feed", "genemon.experience", "genemon.experience.denied", "genemon.exposure", "genemon.xp", "genemon.levelUp"]) {
    assert(whats.has(w), `expected a ${w} row`);
  }
  for (const r of ledger.rows()) {
    const spec = CONTENT_EVENTS[r.what];
    assert(spec, `emitted event ${r.what} missing from CONTENT_EVENTS`);
    assertEquals(spec.status, "emitted", `${r.what} is emitted today`);
    assertEquals(Object.keys(r.entries).sort(), Object.keys(spec.entries).sort(), `${r.what} entries keys`);
    assertEquals(Object.keys(r.exits).sort(), Object.keys(spec.exits).sort(), `${r.what} exits keys`);
  }
  const progress = (t: Trigger) => ledger.rows().filter((r) => triggerMatches(t, r)).reduce((sum, r) => sum + eventWeight(r), 0);
  const ach = (id: string) => progress(ACHIEVEMENT_BY_ID[id].trigger);
  assertEquals(ach("hot-stuff"), 3, "3 peppers in one row count as 3 (units)");
  assertEquals(ach("well-fed"), 3);
  assertEquals(ach("moonlit-stroll"), 2);
  assertEquals(ach("gym-buddy"), 0, "a refused sofa gym session must not count");
  assertEquals(ach("moss-bed"), 1);
  assert(ach("seasoned") >= 1, "level 25 reached counts for Seasoned");
  const breakfast = QUEST_BY_ID["daily-breakfast"].steps[0].trigger;
  assert(progress(breakfast) >= breakfast.count, "Breakfast Bowl completes from real feed rows");
});

/** Is a real payload value inside its declared domain? */
function valueOk(d: Domain, v: unknown): boolean {
  if (d === "number") return typeof v === "number" && Number.isFinite(v);
  if (d === "hour") return typeof v === "number" && v >= 0 && v < 24;
  if (d === "boolean") return typeof v === "boolean";
  if (d === "text" || d === "player") return typeof v === "string";
  return typeof v === "string" && DOMAINS[d as IdDomain].includes(v);
}

/** Every way a real ledger row disagrees with the emitted part of its CONTENT_EVENTS spec. */
function rowErrors(r: GEvent): string[] {
  const spec: EventSpec | undefined = CONTENT_EVENTS[r.what];
  if (!spec) return [];
  const err: string[] = [];
  if (spec.status !== "emitted") err.push(`${r.what}: written by a module today but marked ${spec.status}`);
  for (const scope of ["entries", "exits"] as const) {
    const got = Object.keys(r[scope]).sort(), want = Object.keys(spec[scope]).sort();
    for (const k of got.filter((k) => !want.includes(k))) {
      err.push(`${r.what} ${scope}.${k} is written but not in the contract${spec.requested?.[scope]?.[k] ? " (it was requested: move it from requested to " + scope + ")" : ""}`);
    }
    for (const k of want.filter((k) => !got.includes(k))) err.push(`${r.what} ${scope}.${k} is in the contract but not written`);
    for (const [k, d] of Object.entries(spec[scope])) if (k in r[scope] && !valueOk(d, r[scope][k])) err.push(`${r.what} ${scope}.${k}=${JSON.stringify(r[scope][k])} is not a ${d}`);
  }
  for (const side of ["from", "to"] as const) {
    const d = spec.envelope?.[side];
    if (d && !valueOk(d, r[side])) err.push(`${r.what} envelope ${side}=${JSON.stringify(r[side])} is not a ${d}`);
  }
  return err;
}

Deno.test("[CONTENT] real rows from battle.ts and market.ts match the emitted contract and progress real content", () => {
  const ledger = new Ledger("content-battle");
  for (let s = 1; s <= 2; s++) {
    const pool = Array.from({ length: 14 }, (_, i) => createGenemon({ seed: s * 100 + i, level: 30 }));
    const teams: [Team, Team] = [autoTeam(pool.slice(0, 7), "alice", s), autoTeam(pool.slice(7), "bob", s + 50)];
    new Battle({ seed: s, arena: arenaSpec(s === 1 ? "lake" : "swamp", s, "rain", 2), teams, ledger }).run();
  }
  const plants = [makeArchetype(ARCHETYPES.smallPlant, 2), makeArchetype(ARCHETYPES.smallPlant, 3)];
  new Battle({ seed: 7, arena: arenaSpec("meadow", 7), teams: [team("alice", [makeArchetype(ARCHETYPES.bigFireBrawler, 1)]), team("bob", plants)], ledger }).run();
  new Battle({ seed: 8, arena: arenaSpec("lake", 8), teams: [team("alice", [makeArchetype(ARCHETYPES.electricBolt, 1)]), team("bob", [makeArchetype(ARCHETYPES.waterSniper, 1)])], ledger }).run();
  // Pass 6: the colossus / focus-fire mechanics changed the fixed-seed fights above; this duel reliably reacts (7 rows).
  new Battle({ seed: 9, arena: arenaSpec("lake", 9), teams: [team("alice", [makeArchetype(ARCHETYPES.fireSniper, 1)]), team("bob", [makeArchetype(ARCHETYPES.waterSniper, 2)])], ledger }).run();
  const ah = new AuctionHouse({ seed: 3, ledger });
  ah.deposit("p2", 5000, 0);
  ah.give("p1", "lure.fire", 3, 0);
  ah.give("p1", "map.nest", 1, 0);
  const lot = ah.post("p1", "player", "lure.fire", 3, 60, 90, 300_000, 0);
  ah.bid(lot.id, "p2", 60, 1_000);
  const instant = ah.post("p1", "player", "map.nest", 1, 80, 120, 300_000, 0);
  ah.bid(instant.id, "p2", 120, 2_000);
  ah.tick(360_000);

  const rows = ledger.rows();
  const errors = [...new Set(rows.flatMap(rowErrors))];
  assertEquals(errors, [], `real rows disagree with CONTENT_EVENTS:\n${errors.join("\n")}`);
  const seen = new Set(rows.map((r) => r.what));
  for (const w of ["battle.start", "battle.decide", "battle.hit", "battle.miss", "battle.reaction", "battle.status", "battle.ko", "battle.end", "market.post", "market.bid", "market.sold", "market.buyout"]) {
    assert(seen.has(w), `expected a real ${w} row`);
  }
  const unexercised = Object.entries(CONTENT_EVENTS).filter(([w, sp]) => sp.status === "emitted" && sp.emitter !== "src/genome/genemon.ts" && !seen.has(w)).map(([w]) => w);
  if (unexercised.length) console.log(`emitted events this run did not produce (checked by key only): ${unexercised.join(", ")}`);

  const progress = (t: Trigger, me?: string, who?: string) =>
    rows.filter((r) => (who === undefined || r.who === who) && triggerMatches(t, r, me)).reduce((sum, r) => sum + eventWeight(r), 0);
  const ach = (id: string, me?: string, who?: string) => progress(ACHIEVEMENT_BY_ID[id].trigger, me, who);
  assertEquals(ach("open-for-business", "p1"), 1, "p1 sold the lure lot at auction");
  assertEquals(ach("open-for-business", "p2"), 0, "p2 bought it: not a sale for p2");
  assertEquals(ach("collectors-eye", "p2"), 1, "p2 won one auction (the buyout is not an auction win)");
  assertEquals(ach("auction-house", undefined, "p1"), 2, "two listings by p1");
  const battleLive = ACHIEVEMENTS.filter((x) => x.category === "battle" && progressesToday(x.trigger));
  assert(battleLive.length >= 10, `only ${battleLive.length} battle achievements can progress on today's rows`);
  assert(battleLive.some((x) => progress(x.trigger) > 0), "four real battles progress at least one battle achievement");
  for (const x of ACHIEVEMENTS.filter((x) => progressesToday(x.trigger))) assertEquals(CONTENT_EVENTS[x.trigger.what].status, "emitted", x.id);
});

// ------------------------------------------------------------------------------------------ docs: scenarios

interface Member {
  name?: string;
  size: string;
  primary: string;
  secondary?: string;
  level: number;
  moves: string[];
  abilities?: string[];
  axes?: Record<string, number>;
  kind?: string;
}
interface Arena {
  /** Natural arena (src/world/arena.ts ARENA_KINDS); required unless MODEL. */
  kind?: string;
  ground: string;
  weather: string;
  hour: number;
}
interface Expectation {
  metric: string;
  op: string;
  value: unknown;
  /** Design target the current data is predicted to miss: reported, never asserted. */
  target?: boolean;
  variant?: string;
  relativeTo?: string;
  move?: string;
  /** meanHitFactor: a numeric battle.hit entries key (conduction, rhythm, ground, team...). */
  factor?: string;
  reaction?: string;
  reason?: string;
  status?: string;
  side?: string;
  ground?: string;
  element?: string;
}
interface Regimen {
  level: number;
  ageDays: number;
  groups: { label: string; exposure: Record<string, number>; diet: Record<string, number> }[];
}
interface Fixture {
  id: string;
  title: string;
  tags: string[];
  status: string;
  arena: Arena;
  teamA: Member[];
  teamB: Member[];
  seeds: number;
  variants?: { label: string; arena?: Partial<Arena>; teamA?: Member[]; teamB?: Member[] }[];
  regimen?: Regimen;
  expect: Expectation[];
}

const METRICS = [
  "winRateA",
  "meanHitDamage",
  "meanHitFactor",
  "statusDamageRatio",
  "hitsWhileStatus",
  "reactionsPerHit",
  "battlesWithReaction",
  "clashReactionShare",
  "moveSuccess",
  "groundAfter",
  "groundShare",
  "slideDistance",
  "zoneAccuracyRatio",
  "statusUptime",
  "friendlyShare",
  "moveSpeed",
  "expressedElementShare",
  "superEffectiveChoice",
  "chargeInterruptRate",
];
const MOVE_METRICS = ["meanHitDamage", "meanHitFactor", "statusDamageRatio", "hitsWhileStatus", "reactionsPerHit", "moveSuccess", "groundAfter", "slideDistance", "chargeInterruptRate"];
/** Damage factors Battle.hit() logs today: the numeric entries of the emitted battle.hit contract. */
const HIT_FACTORS = Object.entries(CONTENT_EVENTS["battle.hit"].entries).filter(([, d]) => d === "number").map(([k]) => k);

const MANDATED_TAGS = [
  "user-big-fire-vs-small-plants",
  "user-fire-water-smoke",
  "user-electric-ground-ladder",
  "flyer-dodges-quake",
  "digger-needs-diggable-ground",
  "weather-flips-matchup",
  "terrain-freeze-slippery",
  "phase-shift-melt-form",
  "light-shadow-eclipse",
  "synergy-water-electric",
  "big-vs-swarm-slots",
  "night-day-rhythm",
];

async function scenarioFixtures(): Promise<Fixture[]> {
  const md = await Deno.readTextFile(new URL("../docs/SCENARIOS.md", import.meta.url));
  const blocks = [...md.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]);
  return blocks.map((b, i) => {
    try {
      return JSON.parse(b) as Fixture;
    } catch (e) {
      throw new Error(`SCENARIOS.md json block #${i + 1} does not parse: ${(e as Error).message}`);
    }
  }).filter((f) => typeof f.id === "string" && f.id.startsWith("SC-"));
}

function memberErrors(label: string, m: Member): string[] {
  const err: string[] = [];
  if (!(SIZE_CLASSES as readonly string[]).includes(m.size)) err.push(`${label}: size ${m.size}`);
  if (!(ELEMENT_IDS as readonly string[]).includes(m.primary)) err.push(`${label}: primary ${m.primary}`);
  if (m.secondary !== undefined && (!(ELEMENT_IDS as readonly string[]).includes(m.secondary) || m.secondary === m.primary)) err.push(`${label}: secondary ${m.secondary}`);
  if (!Number.isInteger(m.level) || m.level < 1 || m.level > 100) err.push(`${label}: level ${m.level}`);
  if (m.kind !== undefined && !(BODY_KINDS as readonly string[]).includes(m.kind)) err.push(`${label}: kind ${m.kind}`);
  for (const ab of m.abilities ?? []) if (!(ABILITY_KEYS as readonly string[]).includes(ab)) err.push(`${label}: ability ${ab}`);
  for (const [k, v] of Object.entries(m.axes ?? {})) {
    if (!(AXIS_IDS as readonly string[]).includes(k) || v < -1 || v > 1) err.push(`${label}: axis ${k}=${v}`);
  }
  if (!Array.isArray(m.moves) || m.moves.length < 1 || m.moves.length > 4) err.push(`${label}: 1-4 moves required`);
  for (const id of m.moves ?? []) {
    const mv = MOVE_BY_ID[id];
    if (!mv) {
      err.push(`${label}: unknown move ${id}`);
      continue;
    }
    if (mv.element !== "neutral" && mv.element !== m.primary && mv.element !== m.secondary) err.push(`${label}: ${id} (${mv.element}) not learnable by ${m.primary}/${m.secondary ?? "-"}`);
    if (m.level < TIER_LEVEL[mv.tier]) err.push(`${label}: ${id} is tier ${mv.tier}, needs level ${TIER_LEVEL[mv.tier]}`);
    if (mv.requires?.ability && !(m.abilities ?? []).includes(mv.requires.ability)) err.push(`${label}: ${id} requires ability ${mv.requires.ability}`);
  }
  return err;
}

function teamErrors(label: string, team: Member[]): string[] {
  if (!Array.isArray(team) || team.length === 0) return [`${label}: empty team`];
  const slots = team.reduce((s, m) => s + (SLOT_COST[m.size as keyof typeof SLOT_COST] ?? 99), 0);
  const err = team.flatMap((m, i) => memberErrors(`${label}[${i}]`, m));
  if (slots > TEAM_SLOTS) err.push(`${label}: ${slots} slots > ${TEAM_SLOTS}`);
  return err;
}

function arenaErrors(label: string, a: Partial<Arena>): string[] {
  const err: string[] = [];
  if (a.kind !== undefined && !(ARENA_KINDS as readonly string[]).includes(a.kind)) err.push(`${label}: arena kind ${a.kind}`);
  if (a.ground !== undefined && !(GROUND_IDS as readonly string[]).includes(a.ground)) err.push(`${label}: ground ${a.ground}`);
  if (a.weather !== undefined && !(WEATHER_IDS as readonly string[]).includes(a.weather)) err.push(`${label}: weather ${a.weather}`);
  if (a.hour !== undefined && !(Number.isInteger(a.hour) && a.hour >= 0 && a.hour <= 23)) err.push(`${label}: hour ${a.hour}`);
  return err;
}

function regimenErrors(label: string, r: Regimen | undefined): string[] {
  if (!r || !Array.isArray(r.groups) || r.groups.length < 2) return [`${label}: a MODEL scenario needs a regimen with 2+ groups`];
  const err: string[] = [];
  if (!Number.isInteger(r.level) || r.level < 1 || r.level > 100) err.push(`${label}: level ${r.level}`);
  if (!(r.ageDays > 0)) err.push(`${label}: ageDays ${r.ageDays}`);
  for (const g of r.groups) {
    for (const [k, v] of Object.entries(g.exposure)) if (!(GROUND_IDS as readonly string[]).includes(k) || !(v >= 0)) err.push(`${label}/${g.label}: exposure ${k}=${v}`);
    for (const [k, v] of Object.entries(g.diet)) if (!(FOOD_IDS as readonly string[]).includes(k) || !(v >= 0)) err.push(`${label}/${g.label}: diet ${k}=${v}`);
  }
  return err;
}

const fixtureLabels = (f: Fixture) => ["main", ...(f.variants ?? []).map((v) => v.label), ...(f.regimen?.groups ?? []).map((g) => g.label)];

Deno.test("[DOCS] SCENARIOS.md: >= 25 fixtures, sequential ids, real ids, legal teams, mandated topics", async () => {
  const fx = await scenarioFixtures();
  assert(fx.length >= 25, `only ${fx.length} scenario fixtures`);
  fx.forEach((f, i) => assertEquals(f.id, `SC-${String(i + 1).padStart(2, "0")}`, "scenario ids must be sequential"));
  const err: string[] = [];
  for (const f of fx) {
    if (!f.title || !Array.isArray(f.tags) || f.tags.length === 0) err.push(`${f.id}: title and tags required`);
    if (!["ENGINE", "PROPOSAL", "MODEL", "DATA"].includes(f.status)) err.push(`${f.id}: status ${f.status}`);
    if (f.status !== "MODEL" && !f.arena.kind) err.push(`${f.id}: arena.kind is required (the natural arena the harness generates)`);
    if (!f.arena || f.arena.ground === undefined || f.arena.weather === undefined || f.arena.hour === undefined) err.push(`${f.id}: arena needs ground, weather, hour`);
    else err.push(...arenaErrors(`${f.id} arena`, f.arena));
    if (f.status === "MODEL") err.push(...regimenErrors(`${f.id} regimen`, f.regimen));
    else err.push(...teamErrors(`${f.id} teamA`, f.teamA), ...teamErrors(`${f.id} teamB`, f.teamB));
    if (!Number.isInteger(f.seeds) || f.seeds < 100) err.push(`${f.id}: seeds ${f.seeds} < 100`);
    const labels = fixtureLabels(f);
    if (new Set(labels).size !== labels.length) err.push(`${f.id}: duplicate variant labels`);
    for (const v of f.variants ?? []) {
      if (v.arena) err.push(...arenaErrors(`${f.id}/${v.label} arena`, v.arena));
      if (v.teamA) err.push(...teamErrors(`${f.id}/${v.label} teamA`, v.teamA));
      if (v.teamB) err.push(...teamErrors(`${f.id}/${v.label} teamB`, v.teamB));
    }
    const fixtureMoves = new Set([f.teamA, f.teamB, ...(f.variants ?? []).flatMap((v) => [v.teamA ?? [], v.teamB ?? []])].flat().flatMap((m) => m.moves));
    if (!Array.isArray(f.expect) || f.expect.length === 0) err.push(`${f.id}: no expectations`);
    for (const e of f.expect ?? []) {
      const l = `${f.id} expect ${e.metric}`;
      if (!METRICS.includes(e.metric)) err.push(`${l}: unknown metric`);
      if (![">=", "<=", "between", "=="].includes(e.op)) err.push(`${l}: op ${e.op}`);
      if (e.op === "between" && !(Array.isArray(e.value) && e.value.length === 2 && e.value[0] < e.value[1])) err.push(`${l}: between needs [lo, hi]`);
      if ((e.op === ">=" || e.op === "<=") && typeof e.value !== "number") err.push(`${l}: ${e.op} needs a number`);
      for (const ref of [e.variant, e.relativeTo]) if (ref !== undefined && !labels.includes(ref)) err.push(`${l}: unknown variant ${ref}`);
      if (MOVE_METRICS.includes(e.metric) && (!e.move || !fixtureMoves.has(e.move))) err.push(`${l}: needs a move used in the fixture (got ${e.move})`);
      if (e.metric === "meanHitFactor" && !HIT_FACTORS.includes(e.factor ?? "")) err.push(`${l}: factor ${e.factor} is not a damage factor battle.hit logs (${HIT_FACTORS.join(", ")})`);
      if (e.reaction !== undefined && !REACTIONS.some((r) => r.id === e.reaction)) err.push(`${l}: reaction ${e.reaction}`);
      if ((e.metric === "reactionsPerHit" || e.metric === "zoneAccuracyRatio" || e.metric === "friendlyShare") && !e.reaction) err.push(`${l}: needs a reaction`);
      if (e.reason !== undefined && !(CONTENT_VOCAB.dodgeReason as readonly string[]).includes(e.reason)) err.push(`${l}: reason ${e.reason}`);
      if (e.status !== undefined && !(STATUS_IDS as readonly string[]).includes(e.status)) err.push(`${l}: status ${e.status}`);
      if (e.metric === "statusUptime" && (!e.status || !e.side)) err.push(`${l}: needs status and side`);
      if (e.side !== undefined && e.side !== "A" && e.side !== "B") err.push(`${l}: side ${e.side}`);
      if (e.ground !== undefined && !(GROUND_IDS as readonly string[]).includes(e.ground)) err.push(`${l}: ground ${e.ground}`);
      if ((e.metric === "groundShare" || e.metric === "moveSpeed") && !e.ground) err.push(`${l}: needs a ground`);
      if (e.element !== undefined && !(ELEMENT_IDS as readonly string[]).includes(e.element)) err.push(`${l}: element ${e.element}`);
      if (e.metric === "expressedElementShare" && (!e.element || f.status !== "MODEL")) err.push(`${l}: needs an element and a MODEL regimen`);
      if (e.metric === "groundAfter" && (e.op !== "==" || !(GROUND_IDS as readonly string[]).includes(String(e.value)))) err.push(`${l}: == a ground id`);
      if (e.metric === "winRateA" && !e.relativeTo) {
        const vals = Array.isArray(e.value) ? e.value : [e.value];
        if (!vals.every((v) => typeof v === "number" && v >= 0 && v <= 1)) err.push(`${l}: win rates live in [0, 1]`);
      }
    }
  }
  assertEquals(err, [], "invalid scenario fixtures");
  for (const tag of MANDATED_TAGS) assert(fx.some((f) => f.tags.includes(tag)), `no scenario tagged ${tag}`);
});

/** The data each mandated scenario relies on, checked against today's modules. */
const PRECONDITIONS: Record<string, () => boolean> = {
  "user-big-fire-vs-small-plants": () =>
    typeMultiplier("fire", ["plant"]) === 2 && typeMultiplier("plant", ["fire"]) === 0.5 && POWER_BUDGET.L > 2 * POWER_BUDGET.S &&
    MOVE_BY_ID.emberBite.tags.includes("contact") && MOVE_BY_ID.infernoBurst.area > 0 && transformGround("grass", "fire") === "ash",
  "user-fire-water-smoke": () => {
    const r = reactionBetween("fire", "water");
    return r?.id === "smoke" && (r.zone?.radius ?? 0) > 0 && r.damageMult < 1;
  },
  "user-electric-ground-ladder": () =>
    reactionBetween("electric", "water")?.id === "conduction" && GROUNDS.water.conductivity > GROUNDS.muddyWater.conductivity &&
    GROUNDS.muddyWater.conductivity > GROUNDS.mud.conductivity && GROUNDS.mud.conductivity > GROUNDS.stone.conductivity &&
    GROUNDS.water.liquid && GROUNDS.muddyWater.liquid && !GROUNDS.mud.liquid && !GROUNDS.stone.liquid,
  "flyer-dodges-quake": () =>
    MOVE_BY_ID.quake.tags.includes("ground") && MOVE_BY_ID.takeFlight.requires?.ability === "fly" &&
    MOVE_BY_ID.takeFlight.effects.some((e) => e.status === "airborne" && e.self),
  "digger-needs-diggable-ground": () => GROUNDS.soil.diggable && !GROUNDS.stone.diggable && !GROUNDS.ice.diggable && MOVE_BY_ID.burrow.requires?.ability === "dig",
  "weather-flips-matchup": () =>
    typeMultiplier("fire", ["electric"]) === 1 && typeMultiplier("electric", ["fire"]) === 1 &&
    (WEATHERS.storm.elementMult.electric ?? 1) > 1 && (WEATHERS.storm.elementMult.fire ?? 1) < 1 && (WEATHERS.heatwave.elementMult.fire ?? 1) > 1,
  "terrain-freeze-slippery": () =>
    transformGround("water", "ice") === "ice" && GROUNDS.ice.friction < GROUNDS.water.friction / 4 &&
    MOVE_BY_ID.frostGround.effects.some((e) => e.kind === "ground" && e.ground === "ice"),
  "phase-shift-melt-form": () => MOVE_BY_ID.meltForm.requires?.ability === "phaseShift" && MOVE_BY_ID.meltForm.effects.some((e) => e.status === "liquid" && e.self),
  "light-shadow-eclipse": () =>
    reactionBetween("light", "shadow")?.id === "eclipse" && typeMultiplier("light", ["shadow"]) === 2 && typeMultiplier("shadow", ["light"]) === 2 &&
    (WEATHERS.eclipse.elementMult.shadow ?? 1) > 1 && (WEATHERS.eclipse.elementMult.light ?? 1) < 1,
  "synergy-water-electric": () => reactionBetween("water", "electric")?.id === "conduction" && reactionBetween("water", "psychic") === null,
  // Slots are the currency of power: one size class never buys more than +-20 % budget per slot.
  // Parity itself is MEASURED (tools/balance.ts section 2, [SPEC B3]); the old premise "XL budget
  // below 4 S" was refuted by the harness (XL won 28 % at 3.8, because a swarm brings N energy
  // pools, N evasion rolls and N status appliers).
  "big-vs-swarm-slots": () =>
    SLOT_COST.XL === 4 * SLOT_COST.S &&
    Object.entries(POWER_BUDGET).every(([c, b]) => Math.abs(b / SLOT_COST[c as keyof typeof SLOT_COST] - 1) <= 0.2),
  "night-day-rhythm": () => AXIS_BY_ID.rhythm.neg === "nocturnal" && AXIS_BY_ID.rhythm.pos === "diurnal",
};

Deno.test("[DOCS] SCENARIOS.md: the data every mandated scenario relies on holds today", () => {
  assertEquals(Object.keys(PRECONDITIONS).sort(), [...MANDATED_TAGS].sort(), "one precondition per mandated topic");
  const failing = Object.entries(PRECONDITIONS).filter(([, ok]) => !ok()).map(([tag]) => tag);
  assertEquals(failing, [], "scenario preconditions broken by a data change");
});

/** Run a MODEL fixture (lifestyle regimen) through the real express(): expressedElementShare per group. */
function runModel(f: Fixture): { label: string; ok: boolean; target: boolean; got: number }[] {
  const r = f.regimen!;
  const share = new Map<string, Record<string, number>>();
  for (const g of r.groups) {
    const count: Record<string, number> = {};
    for (let seed = 1; seed <= f.seeds; seed++) {
      const c: Conditions = emptyConditions();
      c.xp = xpForLevel(r.level);
      c.ageDays = r.ageDays;
      c.exposure = g.exposure as Conditions["exposure"];
      c.diet = g.diet as Conditions["diet"];
      const ph = express(randomGenome(seed), c);
      for (const el of new Set([ph.elements.primary, ph.elements.secondary])) if (el) count[el] = (count[el] ?? 0) + 1;
    }
    share.set(g.label, Object.fromEntries(ELEMENT_IDS.map((el) => [el, (count[el] ?? 0) / f.seeds])));
  }
  return f.expect.map((e) => {
    const of = (label: string) => share.get(label)?.[e.element ?? ""] ?? NaN;
    const v = of(e.variant ?? "main");
    const got = e.relativeTo ? v / Math.max(1e-9, of(e.relativeTo)) : v;
    const val = e.value as number | [number, number];
    const ok = e.op === ">=" ? got >= (val as number) : e.op === "<=" ? got <= (val as number) : e.op === "between" ? got >= (val as [number, number])[0] && got <= (val as [number, number])[1] : false;
    return { label: `${e.element} ${e.variant ?? "main"}${e.relativeTo ? `/${e.relativeTo}` : ""} ${e.op} ${JSON.stringify(e.value)}`, ok, target: !!e.target, got };
  });
}

Deno.test("[DOCS] SCENARIOS.md: MODEL scenarios run today against express() and their contracts hold", async () => {
  const fx = (await scenarioFixtures()).filter((f) => f.status === "MODEL");
  assert(fx.length >= 1, "no MODEL scenario to run");
  const results = fx.flatMap((f) => runModel(f).map((r) => ({ ...r, id: f.id })));
  assert(results.every((r) => Number.isFinite(r.got)), "a MODEL metric did not compute");
  const broken = results.filter((r) => !r.target && !r.ok).map((r) => `${r.id} ${r.label}: got ${r.got.toFixed(3)}`);
  assertEquals(broken, [], "MODEL scenario contracts");
  const missed = results.filter((r) => r.target && !r.ok);
  if (missed.length) console.log(`design targets missed today (see docs/SCENARIOS.md): ${missed.map((r) => `${r.id} ${r.label}: got ${r.got.toFixed(3)}`).join("; ")}`);
});

// ------------------------------------------------------------------------------------------ docs: lists

Deno.test("[DOCS] LISTS.md names every list entry (regenerate it when data changes)", async () => {
  const md = await Deno.readTextFile(new URL("../docs/LISTS.md", import.meta.url));
  const lists: Record<string, readonly string[]> = {
    axes: AXIS_IDS,
    elements: ELEMENT_IDS,
    reactions: REACTIONS.map((r) => r.id),
    grounds: GROUND_IDS,
    weathers: WEATHER_IDS,
    foods: FOOD_IDS,
    experiences: EXPERIENCE_IDS,
    bodyKinds: BODY_KINDS,
    patterns: PATTERNS,
    sizeClasses: SIZE_CLASSES,
    statuses: STATUS_IDS,
    moves: MOVES.map((m) => m.id),
    achievements: ACHIEVEMENTS.map((x) => x.id),
    quests: QUESTS.map((q) => q.id),
    givers: QUEST_GIVERS.map((g) => g.name),
    events: Object.keys(CONTENT_EVENTS),
    rewardItems: REWARD_ITEMS,
  };
  const missing = Object.entries(lists).flatMap(([list, ids]) => ids.filter((id) => !md.includes(`\`${id}\``)).map((id) => `${list}:${id}`));
  assertEquals(missing, [], "docs/LISTS.md is stale");
});
