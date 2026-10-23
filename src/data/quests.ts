/**
 * Quests: short missions handed out by virtual characters (QUEST_GIVERS) and counted on the same
 * ledger triggers as achievements (Trigger, triggerMatches and CONTENT_EVENTS in ./achievements.ts).
 * Two play spaces, kept apart by isPhysicalTrigger():
 *  - SOFA quests (physicalOnly false) never contain a step that needs real-world presence;
 *  - PHYSICAL quests (physicalOnly true) are real errands: EVERY step is a world.* row (GPS-verified),
 *    a physical-only experience from lifestyle.ts, or a row filtered `physical: true`.
 * Quest givers EVOLVE with the players around them: each arc stage unlocks when the community in the
 * giver's home zone accumulates a ledger milestone, and story quests are gated on that stage
 * (giverStage) and on the previous chapter (after). Time windows use local hours and may wrap
 * midnight (21 -> 4). Tables, balance notes and how to add quests: docs/LISTS.md (Quests).
 */
import type { ElementId } from "./elements.ts";
import { EXPERIENCES, type ExperienceId } from "./lifestyle.ts";
import type { WeatherId } from "./weather.ts";
import { type FilterValue, ME, type Poi, type Trigger } from "./achievements.ts";

export const QUEST_KINDS = ["sofa", "physical", "social", "battle", "breeding", "market", "story", "daily", "weekly"] as const;
export type QuestKind = typeof QUEST_KINDS[number];

export interface QuestStep {
  /** Unique within its quest. */
  id: string;
  text: string;
  trigger: Pick<Trigger, "what" | "count" | "filter">;
}

export interface Quest {
  id: string;
  name: string;
  kind: QuestKind;
  minLevel: number;
  physicalOnly: boolean;
  steps: QuestStep[];
  reward: { credits: number; xp: number; itemId?: string };
  /** QuestGiver.name of the virtual character offering it. */
  giver: string;
  /** Local hours [startHour, endHour); startHour > endHour wraps midnight. */
  timeWindow?: { startHour: number; endHour: number };
  /** Offered only under these weathers (real weather for physical quests, world-cell weather otherwise). */
  weather?: WeatherId[];
  /** WHY the quest exists: the mechanic it teaches or the behaviour it rewards. */
  note: string;
  /** Story chaining: id of the quest that must be completed first. */
  after?: string;
  /** Story gating: arc stage (1-based) the giver must have reached. */
  giverStage?: number;
}

export interface QuestGiver {
  name: string;
  role: string;
  element: ElementId;
  home: Poi;
  /**
   * Arc stages in order. Stage 1 is the starting state (unlock null). Later stages unlock when the
   * whole community within the giver's home zone accumulates `unlock` (summed over all players):
   * the character visibly changes (shop, mood, own Genemon) and new story quests open.
   */
  arc: { title: string; unlock: Trigger | null; change: string }[];
}

/** True when progress needs real-world presence (GPS-verified world.* row, physical-only experience, physical: true). */
export function isPhysicalTrigger(t: Pick<Trigger, "what" | "filter">): boolean {
  if (t.what.startsWith("world.")) return true;
  if (t.filter?.physical === true) return true;
  const e = t.filter?.experience;
  return t.what === "genemon.experience" && typeof e === "string" && e in EXPERIENCES &&
    EXPERIENCES[e as ExperienceId].physicalOnly;
}

/** Whether a local hour (0-24) lies in [startHour, endHour); windows with startHour > endHour wrap midnight. */
export function inTimeWindow(w: { startHour: number; endHour: number }, hour: number): boolean {
  return w.startHour <= w.endHour ? hour >= w.startHour && hour < w.endHour : hour >= w.startHour || hour < w.endHour;
}

export interface QuestContext {
  level: number;
  /** Local hour 0-24. */
  hour: number;
  weather: WeatherId;
  /** The player is physically present (GPS session) rather than on the sofa. */
  physical: boolean;
  completed: ReadonlySet<string>;
  /** Current arc stage per giver name (missing = 1). */
  giverStages: Readonly<Record<string, number>>;
}

/** Can this quest be offered right now? One place for every gate (level, presence, hour, weather, story). */
export function questAvailable(q: Quest, c: QuestContext): boolean {
  if (c.level < q.minLevel) return false;
  if (q.physicalOnly && !c.physical) return false;
  if (q.timeWindow && !inTimeWindow(q.timeWindow, c.hour)) return false;
  if (q.weather && !q.weather.includes(c.weather)) return false;
  if (q.after && !c.completed.has(q.after)) return false;
  if (q.giverStage && (c.giverStages[q.giver] ?? 1) < q.giverStage) return false;
  return true;
}

const tr = (what: string, count: number, filter?: Record<string, FilterValue>): Trigger => ({ what, count, ...(filter ? { filter } : {}) });

const s = (id: string, text: string, what: string, count: number, filter?: Record<string, FilterValue>): QuestStep => ({
  id,
  text,
  trigger: tr(what, count, filter),
});

const exp = (experience: ExperienceId, extra: Record<string, FilterValue> = {}) => ({ experience, ...extra });

// ---------------------------------------------------------------- the characters

export const QUEST_GIVERS: readonly QuestGiver[] = [
  {
    name: "Marla",
    role: "grocer of the corner supermarket",
    element: "plant",
    home: "supermarket",
    arc: [
      { title: "Corner Shop", unlock: null, change: "Half-empty shelves; asks players to shop for their Genemon in person." },
      { title: "Market Hall", unlock: tr("world.purchase", 2000), change: "Stocks fish, honey and glow fruit; her plant Genemon grows a light secondary type." },
      { title: "Harvest Festival", unlock: tr("world.purchase", 10000), change: "Hosts a monthly festival with rare seeds; becomes a trader at the virtual market too." },
    ],
  },
  {
    name: "Coach Brakk",
    role: "trainer at the local gym",
    element: "metal",
    home: "gym",
    arc: [
      { title: "Grumpy Coach", unlock: null, change: "Only believes in heavy bruisers." },
      { title: "Team Trainer", unlock: tr("genemon.experience", 5000, exp("gymTraining")), change: "Admits small fast Genemon train well; opens circuit training." },
      { title: "Champion's Mentor", unlock: tr("battle.win", 20000, { mode: "ranked" }), change: "Coaches ladder players; his own Genemon reaches Ascended." },
    ],
  },
  {
    name: "Noctua",
    role: "night keeper of the park",
    element: "shadow",
    home: "park",
    arc: [
      { title: "Afraid of the Dark", unlock: null, change: "Lost her lantern; asks players to walk with her after dusk." },
      { title: "Lantern Keeper", unlock: tr("genemon.experience", 1000, exp("nightWalk")), change: "Lights the park paths; shadow spawns appear around her at night." },
      { title: "Eclipse Warden", unlock: tr("battle.reaction", 500, { reaction: "eclipse" }), change: "Can call eclipse nights over her zone." },
    ],
  },
  {
    name: "Captain Rill",
    role: "ferry captain at the harbour",
    element: "water",
    home: "harbour",
    arc: [
      { title: "Stranded Captain", unlock: null, change: "His ferry sits in a dry dock." },
      { title: "Ferryman", unlock: tr("genemon.catch", 1000, { primary: "water" }), change: "Ferries resume; water spawns rise around the harbour." },
      { title: "Admiral of the Rains", unlock: tr("world.visit", 3000, { weather: "rain" }), change: "Raises rain over his zone during community events." },
    ],
  },
  {
    name: "Ode Sparkwright",
    role: "inventor in the old station",
    element: "electric",
    home: "station",
    arc: [
      { title: "Burned-out Tinkerer", unlock: null, change: "Fried his workshop by testing current on a wet floor." },
      { title: "Grid Builder", unlock: tr("battle.reaction", 2000, { reaction: "conduction" }), change: "Rebuilds the station grid; teaches conductivity." },
      { title: "Storm Engineer", unlock: tr("battle.win", 2000, { weather: "storm" }), change: "Harnesses storms; electric spawns cluster at the station." },
    ],
  },
  {
    name: "Professor Helix",
    role: "geneticist in the museum basement",
    element: "psychic",
    home: "museum",
    arc: [
      { title: "Lone Researcher", unlock: null, change: "Studies double helices alone." },
      { title: "Lab Director", unlock: tr("genemon.breed", 2000), change: "Opens a public breeding lab." },
      { title: "Genome Sage", unlock: tr("genemon.breed", 100, { "generation>=": 10 }), change: "Publishes lineages; fusion research opens." },
    ],
  },
  {
    name: "Granny Moss",
    role: "keeper of the community garden",
    element: "plant",
    home: "garden",
    arc: [
      { title: "Wilting Garden", unlock: null, change: "Her beds are dry and grey." },
      { title: "Greenhouse", unlock: tr("battle.reaction", 1000, { reaction: "bloom" }), change: "A greenhouse rises; plant Genemon regenerate faster nearby." },
      { title: "Forest Spirit", unlock: tr("battle.terrain", 5000, { to: "grass" }), change: "Her garden becomes a forest zone." },
    ],
  },
  {
    name: "Echo",
    role: "a ledger-born figure on the town plaza",
    element: "void",
    home: "plaza",
    arc: [
      { title: "Blank Slate", unlock: null, change: "A void silhouette that mirrors whoever talks to it." },
      { title: "Mirror", unlock: tr("quest.complete", 2000), change: "Takes the element most used by the players around it." },
      { title: "Voice of the Town", unlock: tr("quest.complete", 20000), change: "Narrates the town's week from the ledger and proposes community goals." },
    ],
  },
  {
    name: "Vell",
    role: "auctioneer of the market",
    element: "metal",
    home: "plaza",
    arc: [
      { title: "Pawnbroker", unlock: null, change: "Runs a single dusty stall." },
      { title: "Auction House", unlock: tr("market.sold", 2000), change: "Opens timed auctions and appraisals." },
      { title: "Exchange", unlock: tr("market.sold", 20000), change: "Publishes the town's price index." },
    ],
  },
  {
    name: "Warden Kestrel",
    role: "territory warden on the hill landmark",
    element: "air",
    home: "landmark",
    arc: [
      { title: "Scout", unlock: null, change: "Maps the town alone." },
      { title: "Warden", unlock: tr("world.claim", 1000), change: "Recognises claims and mediates raids." },
      { title: "High Warden", unlock: tr("world.defend", 5000, { "exits.won": true }), change: "Organises zone defence events." },
    ],
  },
  {
    name: "Referee Oona",
    role: "referee of the stadium",
    element: "neutral",
    home: "stadium",
    arc: [
      { title: "Rookie Referee", unlock: null, change: "Officiates friendly matches." },
      { title: "Head Referee", unlock: tr("battle.win", 50000), change: "Runs the ranked ladder in her zone." },
      { title: "Commissioner", unlock: tr("battle.win", 5000, { mode: "tournament" }), change: "Hosts seasonal tournaments." },
    ],
  },
];

// ---------------------------------------------------------------- the quests

/**
 * Physical quests pay a CREDIT premium for real-world time and effort (measured before it: 85 credits
 * per physical step vs 134 per sofa step). XP is deliberately NOT boosted, so walking earns money and
 * items, not combat power: a sofa player must stay competitive (docs/LISTS.md, Quests balance notes).
 */
const PHYSICAL_CREDIT_PREMIUM = 1.75;
const physicalCredits = (base: number) => Math.round((base * PHYSICAL_CREDIT_PREMIUM) / 10) * 10;


export const QUESTS: readonly Quest[] = [
  // ---------------------------------------------------------------- daily
  {
    id: "daily-breakfast",
    name: "Breakfast Bowl",
    kind: "daily",
    minLevel: 1,
    physicalOnly: false,
    steps: [s("feed", "Serve 3 portions of any food.", "genemon.feed", 3)],
    reward: { credits: 30, xp: 40 },
    giver: "Marla",
    note: "Daily care loop: food drives growth (growthOf) and bond; the cheapest daily habit.",
  },
  {
    id: "daily-cuddles",
    name: "Morning Cuddles",
    kind: "daily",
    minLevel: 1,
    physicalOnly: false,
    steps: [s("pet", "Pet your Genemon 5 times.", "genemon.experience", 5, exp("petting"))],
    reward: { credits: 20, xp: 30 },
    giver: "Echo",
    note: "Mood and conviction nudges: a brave Genemon resists fear.",
  },
  {
    id: "daily-spar",
    name: "Daily Spar",
    kind: "daily",
    minLevel: 3,
    physicalOnly: false,
    steps: [s("win", "Win 3 battles of any mode.", "battle.win", 3)],
    reward: { credits: 40, xp: 80 },
    giver: "Referee Oona",
    note: "Keeps the ladder and the battle datasets fed every day.",
  },
  {
    id: "daily-brain-teaser",
    name: "Brain Teaser",
    kind: "daily",
    minLevel: 5,
    physicalOnly: false,
    steps: [s("puzzle", "Solve a puzzle with your Genemon.", "genemon.experience", 1, exp("puzzle"))],
    reward: { credits: 25, xp: 50 },
    giver: "Professor Helix",
    note: "Wisdom is the gate of weatherShaper (wisdom > 0.2): puzzles are the sofa path to weather moves.",
  },
  {
    id: "daily-chemistry",
    name: "Daily Chemistry",
    kind: "daily",
    minLevel: 5,
    physicalOnly: false,
    steps: [s("react", "Trigger 5 element reactions.", "battle.reaction", 5)],
    reward: { credits: 40, xp: 70 },
    giver: "Ode Sparkwright",
    note: "Teaches that elements interact in space (smoke, mud, conduction...), not only through the chart.",
  },
  {
    id: "daily-quiet-minute",
    name: "Quiet Minute",
    kind: "daily",
    minLevel: 1,
    physicalOnly: false,
    steps: [
      s("meditate", "Meditate once.", "genemon.experience", 1, exp("meditation")),
      s("music", "Play one music session.", "genemon.experience", 1, exp("music")),
    ],
    reward: { credits: 20, xp: 35 },
    giver: "Granny Moss",
    note: "Calm and joy: the psyche axes that make a Genemon steady under pressure.",
  },
  {
    id: "daily-window-shopping",
    name: "Window Shopping",
    kind: "daily",
    minLevel: 5,
    physicalOnly: false,
    steps: [s("bid", "Place one auction bid.", "market.bid", 1)],
    reward: { credits: 25, xp: 30 },
    giver: "Vell",
    note: "Keeps auction liquidity up so listings find buyers.",
  },
  {
    id: "daily-steps",
    name: "Daily Steps",
    kind: "daily",
    minLevel: 1,
    physicalOnly: true,
    steps: [s("walk", "Walk 2 km with your Genemon.", "genemon.experience", 2, exp("travelKm"))],
    reward: { credits: physicalCredits(50), xp: 80 },
    giver: "Coach Brakk",
    note: "The physical daily: km are counted by entries.units, so one long walk or several short ones both work.",
  },
  {
    id: "daily-sun-salute",
    name: "Sun Salute",
    kind: "daily",
    minLevel: 1,
    physicalOnly: true,
    steps: [s("sun", "Sunbathe outdoors with your Genemon.", "genemon.experience", 1, exp("sunbathing"))],
    reward: { credits: physicalCredits(40), xp: 60 },
    giver: "Granny Moss",
    timeWindow: { startHour: 7, endHour: 11 },
    weather: ["clear", "heatwave"],
    note: "Morning light pushes luminance, heat and the diurnal rhythm: the counterpart of night walks.",
  },
  {
    id: "daily-night-round",
    name: "Night Round",
    kind: "daily",
    minLevel: 5,
    physicalOnly: true,
    steps: [s("walk", "Take a night walk.", "genemon.experience", 1, exp("nightWalk"))],
    reward: { credits: physicalCredits(50), xp: 80 },
    giver: "Noctua",
    timeWindow: { startHour: 21, endHour: 2 },
    note: "Night walks push the rhythm axis nocturnal: night battles favour the result.",
  },
  // ---------------------------------------------------------------- weekly
  {
    id: "weekly-gym-circuit",
    name: "Gym Circuit",
    kind: "weekly",
    minLevel: 5,
    physicalOnly: true,
    steps: [
      s("checkin", "Check in at a gym on 3 different days.", "world.visit", 3, { poi: "gym" }),
      s("train", "Complete 3 training sessions there.", "genemon.experience", 3, exp("gymTraining")),
    ],
    reward: { credits: physicalCredits(300), xp: 400, itemId: "badge.gym" },
    giver: "Coach Brakk",
    note: "Gym circuits: the only strong `might` source (gymTraining) is physical; might shifts the stat SHAPE, not total power (SPEC B1).",
  },
  {
    id: "weekly-clutch",
    name: "Weekly Clutch",
    kind: "weekly",
    minLevel: 10,
    physicalOnly: false,
    steps: [s("breed", "Breed 2 children.", "genemon.breed", 2)],
    reward: { credits: 200, xp: 300, itemId: "egg.mystery" },
    giver: "Professor Helix",
    note: "Feeds the breeding economy and the generation ladder.",
  },
  {
    id: "weekly-ladder",
    name: "Ladder Week",
    kind: "weekly",
    minLevel: 12,
    physicalOnly: false,
    steps: [s("ranked", "Win 15 ranked battles.", "battle.win", 15, { mode: "ranked" })],
    reward: { credits: 350, xp: 500 },
    giver: "Referee Oona",
    note: "Weekly ranked volume keeps the condition-aware MMR fresh.",
  },
  {
    id: "weekly-new-places",
    name: "New Week, New Places",
    kind: "weekly",
    minLevel: 3,
    physicalOnly: true,
    steps: [s("visit", "Visit 5 places you have never been.", "world.visit", 5, { firstVisit: true })],
    reward: { credits: physicalCredits(250), xp: 350, itemId: "map.fragment" },
    giver: "Warden Kestrel",
    note: "Exploration spreads players over the map and uncovers new spawns and territories.",
  },
  {
    id: "weekly-big-shop",
    name: "The Big Shop",
    kind: "weekly",
    minLevel: 1,
    physicalOnly: true,
    steps: [
      s("visit", "Go to a supermarket.", "world.visit", 1, { poi: "supermarket" }),
      s("greens", "Buy 3 portions of leafy greens.", "world.purchase", 3, { item: "greens" }),
      s("fish", "Buy 2 portions of fish.", "world.purchase", 2, { item: "fish" }),
    ],
    reward: { credits: physicalCredits(200), xp: 250 },
    giver: "Marla",
    note: "The real-world diet loop: greens push vitality (plant), fish pushes moisture (water).",
  },
  {
    id: "weekly-weather-report",
    name: "Weather Report",
    kind: "weekly",
    minLevel: 12,
    physicalOnly: false,
    steps: [
      s("rain", "Win a battle in rain.", "battle.win", 1, { weather: "rain" }),
      s("snow", "Win a battle in snow.", "battle.win", 1, { weather: "snow" }),
      s("wind", "Win a battle in a gale.", "battle.win", 1, { weather: "wind" }),
    ],
    reward: { credits: 300, xp: 400, itemId: "lure.rain" },
    giver: "Captain Rill",
    note: "Pushes players to adapt teams to weather rather than run one comp everywhere.",
  },
  // ---------------------------------------------------------------- sofa
  {
    id: "sofa-ice-rink",
    name: "Ice Rink Practice",
    kind: "sofa",
    minLevel: 12,
    physicalOnly: false,
    steps: [
      s("freeze", "Freeze 3 patches of water into ice.", "battle.terrain", 3, { from: "water", to: "ice" }),
      s("ko", "Knock out an opponent standing on ice.", "battle.ko", 1, { ground: "ice" }),
    ],
    reward: { credits: 120, xp: 200 },
    giver: "Captain Rill",
    note: "Terrain changers: frozen water drops friction from 0.3 to 0.05, so knockback slides opponents far.",
  },
  {
    id: "sofa-smoke-screen",
    name: "Smoke Screen",
    kind: "sofa",
    minLevel: 5,
    physicalOnly: false,
    steps: [
      s("smoke", "Create 5 smoke clouds.", "battle.reaction", 5, { reaction: "smoke" }),
      s("hide", "Have 3 attacks miss because the attacker could not see.", "battle.miss", 3, { "exits.reason": "obscured" }),
    ],
    reward: { credits: 100, xp: 150 },
    giver: "Captain Rill",
    note: "Fire meets water: smoke blinds everyone inside, an escape tool as much as a damage reaction.",
  },
  {
    id: "sofa-know-your-ground",
    name: "Know Your Ground",
    kind: "sofa",
    minLevel: 5,
    physicalOnly: false,
    steps: [s("burrow", "Dig in with Burrow 5 times (on stone it is refused: pick soil, sand or mud).", "battle.decide", 5, { "exits.move": "burrow" })],
    reward: { credits: 100, xp: 150 },
    giver: "Granny Moss",
    note: "Diggers need diggable ground: Burrow is refused on stone, water, ice, metal, crystal and lava.",
  },
  {
    id: "sofa-over-the-quake",
    name: "Over the Quake",
    kind: "sofa",
    minLevel: 12,
    physicalOnly: false,
    steps: [s("dodge", "Let 2 Quakes pass under an airborne Genemon.", "battle.miss", 2, { move: "quake", "exits.reason": "airborne" })],
    reward: { credits: 150, xp: 250 },
    giver: "Warden Kestrel",
    note: "Flyers ignore ground-tagged moves while airborne: the counter to Quake teams.",
  },
  {
    id: "sofa-concert",
    name: "Concert for One",
    kind: "sofa",
    minLevel: 1,
    physicalOnly: false,
    steps: [
      s("music", "Play 5 music sessions.", "genemon.experience", 5, exp("music")),
      s("pet", "Pet your Genemon 3 times.", "genemon.experience", 3, exp("petting")),
    ],
    reward: { credits: 60, xp: 80 },
    giver: "Echo",
    note: "A gentle sofa loop for days without battles.",
  },
  {
    id: "sofa-genome-reading",
    name: "Genome Reading",
    kind: "sofa",
    minLevel: 3,
    physicalOnly: false,
    steps: [
      s("puzzle", "Solve 3 puzzles.", "genemon.experience", 3, exp("puzzle")),
      s("meditate", "Meditate twice.", "genemon.experience", 2, exp("meditation")),
    ],
    reward: { credits: 80, xp: 120 },
    giver: "Professor Helix",
    note: "Wisdom and order: wiser Genemon learn type knowledge faster.",
  },
  {
    id: "sofa-kindling-diet",
    name: "Kindling Diet",
    kind: "sofa",
    minLevel: 5,
    physicalOnly: false,
    steps: [
      s("peppers", "Feed 5 spicy peppers.", "genemon.feed", 5, { food: "spicyPepper" }),
      s("burn", "Land 20 fire hits.", "battle.hit", 20, { element: "fire" }),
    ],
    reward: { credits: 100, xp: 150 },
    giver: "Marla",
    note: "Diet and practice both push the heat axis: the sofa route to a fire specialisation.",
  },
  // ---------------------------------------------------------------- physical errands
  {
    id: "phys-peppers",
    name: "Peppers for the Furnace",
    kind: "physical",
    minLevel: 1,
    physicalOnly: true,
    steps: [
      s("visit", "Walk to a supermarket with your Genemon.", "world.visit", 1, { poi: "supermarket" }),
      s("buy", "Buy 3 spicy peppers for your fire Genemon.", "world.purchase", 3, { item: "spicyPepper" }),
    ],
    reward: { credits: physicalCredits(80), xp: 120, itemId: "spicyPepper" },
    giver: "Marla",
    note: "The archetypal errand: real shopping feeds the heat axis of a fire Genemon.",
  },
  {
    id: "phys-fishmonger",
    name: "Fishmonger Run",
    kind: "physical",
    minLevel: 1,
    physicalOnly: true,
    steps: [
      s("visit", "Go down to the harbour.", "world.visit", 1, { poi: "harbour" }),
      s("buy", "Buy 2 portions of fish.", "world.purchase", 2, { item: "fish" }),
    ],
    reward: { credits: physicalCredits(80), xp: 120 },
    giver: "Captain Rill",
    note: "Fish pushes moisture: the water counterpart of the pepper errand.",
  },
  {
    id: "phys-shadow-hunt",
    name: "Shadow Hunt",
    kind: "physical",
    minLevel: 8,
    physicalOnly: true,
    steps: [
      s("walk", "Take 2 night walks.", "genemon.experience", 2, exp("nightWalk")),
      s("catch", "Catch a shadow Genemon at a real night spawn.", "genemon.catch", 1, { physical: true, primary: "shadow", night: true }),
    ],
    reward: { credits: physicalCredits(150), xp: 250, itemId: "lure.night" },
    giver: "Noctua",
    timeWindow: { startHour: 21, endHour: 4 },
    note: "Night-only shadow hunt: shadow spawns and the nocturnal rhythm reward real night outings.",
  },
  {
    id: "phys-puddle-jumpers",
    name: "Puddle Jumpers",
    kind: "physical",
    minLevel: 3,
    physicalOnly: true,
    steps: [
      s("walk", "Walk 1 km in the rain.", "genemon.experience", 1, exp("travelKm")),
      s("catch", "Catch a water Genemon outdoors.", "genemon.catch", 1, { physical: true, primary: "water" }),
    ],
    reward: { credits: physicalCredits(120), xp: 180 },
    giver: "Captain Rill",
    weather: ["rain", "storm"],
    note: "Rain-only water quest: real rain raises water spawns.",
  },
  {
    id: "phys-rain-on-the-lake",
    name: "Rain on the Lake",
    kind: "physical",
    minLevel: 8,
    physicalOnly: true,
    steps: [
      s("visit", "Visit a lake while it rains.", "world.visit", 1, { poi: "lake", weather: "rain" }),
      s("catch", "Catch a water Genemon standing in water.", "genemon.catch", 1, { physical: true, primary: "water", ground: "water" }),
    ],
    reward: { credits: physicalCredits(150), xp: 220, itemId: "lure.rain" },
    giver: "Captain Rill",
    weather: ["rain"],
    note: "Rain-only water quest at a real lake: place, weather and ground line up.",
  },
  {
    id: "phys-summit",
    name: "Summit Run",
    kind: "physical",
    minLevel: 10,
    physicalOnly: true,
    steps: [
      s("visit", "Reach a mountain point of interest.", "world.visit", 1, { poi: "mountain" }),
      s("climb", "Climb twice.", "genemon.experience", 2, exp("climbing")),
    ],
    reward: { credits: physicalCredits(200), xp: 300 },
    giver: "Warden Kestrel",
    note: "Climbing pushes altitude toward soaring: the physical path to flight.",
  },
  {
    id: "phys-first-light",
    name: "First Light",
    kind: "physical",
    minLevel: 1,
    physicalOnly: true,
    steps: [
      s("visit", "Go to a park at dawn.", "world.visit", 1, { poi: "park" }),
      s("sun", "Sunbathe as the sun comes up.", "genemon.experience", 1, exp("sunbathing")),
    ],
    reward: { credits: physicalCredits(90), xp: 130 },
    giver: "Granny Moss",
    timeWindow: { startHour: 5, endHour: 8 },
    note: "Dawn routine for diurnal Genemon.",
  },
  {
    id: "phys-market-morning",
    name: "Market Morning",
    kind: "physical",
    minLevel: 1,
    physicalOnly: true,
    steps: [
      s("visit", "Visit a farmers' market.", "world.visit", 1, { poi: "farmersMarket" }),
      s("berries", "Buy 3 portions of berries.", "world.purchase", 3, { item: "berries" }),
      s("honey", "Buy a jar of honey.", "world.purchase", 1, { item: "honey" }),
    ],
    reward: { credits: physicalCredits(100), xp: 140, itemId: "honey" },
    giver: "Marla",
    timeWindow: { startHour: 7, endHour: 13 },
    note: "Morning-only market: berries for vitality, honey for joy.",
  },
  {
    id: "phys-lost-and-found",
    name: "Lost and Found",
    kind: "physical",
    minLevel: 5,
    physicalOnly: true,
    steps: [
      s("visit", "Search a park.", "world.visit", 1, { poi: "park" }),
      s("rescue", "Rescue a released Genemon.", "genemon.experience", 1, exp("rescue")),
    ],
    reward: { credits: physicalCredits(150), xp: 250 },
    giver: "Echo",
    note: "Released Genemon become rescues for players on site: a social loop through the map.",
  },
  {
    id: "phys-museum",
    name: "Fossil Hunt",
    kind: "physical",
    minLevel: 3,
    physicalOnly: true,
    steps: [
      s("museum", "Visit a museum.", "world.visit", 1, { poi: "museum" }),
      s("library", "Visit a library.", "world.visit", 1, { poi: "library" }),
    ],
    reward: { credits: physicalCredits(90), xp: 150, itemId: "scanner.dna" },
    giver: "Professor Helix",
    note: "Curiosity outings; the DNA scanner reward feeds the breeding lab.",
  },
  {
    id: "phys-plant-the-flag",
    name: "Plant the Flag",
    kind: "physical",
    minLevel: 10,
    physicalOnly: true,
    steps: [s("claim", "Claim a territory on site.", "world.claim", 1)],
    reward: { credits: physicalCredits(150), xp: 200 },
    giver: "Warden Kestrel",
    note: "Territory requires presence; defending it later is passive.",
  },
  {
    id: "phys-night-raid",
    name: "Night Raid",
    kind: "physical",
    minLevel: 15,
    physicalOnly: true,
    steps: [s("raid", "Win a raid on a rival territory.", "world.raid", 1, { "exits.won": true })],
    reward: { credits: physicalCredits(250), xp: 350 },
    giver: "Warden Kestrel",
    timeWindow: { startHour: 20, endHour: 2 },
    note: "Night raids favour nocturnal teams and quiet streets.",
  },
  {
    id: "phys-storm-chaser",
    name: "Storm Chaser",
    kind: "physical",
    minLevel: 12,
    physicalOnly: true,
    steps: [
      s("walk", "Walk 1 km under the storm (stay safe).", "genemon.experience", 1, exp("travelKm")),
      s("catch", "Catch an electric Genemon outdoors.", "genemon.catch", 1, { physical: true, primary: "electric" }),
    ],
    reward: { credits: physicalCredits(220), xp: 300, itemId: "lure.storm" },
    giver: "Ode Sparkwright",
    weather: ["storm"],
    note: "Storm-only: electric spawns peak. The client must show a safety warning first.",
  },
  {
    id: "phys-first-snow",
    name: "First Snow",
    kind: "physical",
    minLevel: 5,
    physicalOnly: true,
    steps: [
      s("walk", "Walk 2 km in the snow.", "genemon.experience", 2, exp("travelKm")),
      s("catch", "Catch an ice Genemon outdoors.", "genemon.catch", 1, { physical: true, primary: "ice" }),
    ],
    reward: { credits: physicalCredits(160), xp: 220 },
    giver: "Warden Kestrel",
    weather: ["snow"],
    note: "Snow-only: ice is rare in the wild (under 3% of primaries), real snow is the best place to find it.",
  },
  // ---------------------------------------------------------------- social
  {
    id: "social-playdate",
    name: "Playdate",
    kind: "social",
    minLevel: 3,
    physicalOnly: false,
    steps: [
      s("play", "Play with friends' Genemon 3 times.", "genemon.experience", 3, exp("socialPlay")),
      s("visit", "Visit a friend's habitat.", "social.visit", 1),
    ],
    reward: { credits: 80, xp: 120 },
    giver: "Echo",
    note: "Sociality grows synergy with teammates.",
  },
  {
    id: "social-swap-meet",
    name: "Swap Meet",
    kind: "social",
    minLevel: 8,
    physicalOnly: false,
    steps: [
      s("trade", "Complete a trade.", "social.trade", 1),
      s("gift", "Gift 2 portions of food.", "social.gift", 2),
    ],
    reward: { credits: 100, xp: 120 },
    giver: "Vell",
    note: "Seeds the peer-to-peer economy beside the auction house.",
  },
  {
    id: "social-raid-party",
    name: "Raid Party",
    kind: "social",
    minLevel: 15,
    physicalOnly: false,
    steps: [s("raid", "Win a co-op battle with 3 or more players.", "social.coop", 1, { "exits.won": true, "players>=": 3 })],
    reward: { credits: 250, xp: 350 },
    giver: "Referee Oona",
    note: "Co-op content that no single team can solo.",
  },
  {
    id: "social-sparring",
    name: "Sparring Partners",
    kind: "social",
    minLevel: 5,
    physicalOnly: false,
    steps: [s("win", "Win 3 friendly battles.", "battle.win", 3, { mode: "friendly" })],
    reward: { credits: 90, xp: 150 },
    giver: "Coach Brakk",
    note: "Friendly battles carry no MMR: a safe place to test teams.",
  },
  {
    id: "social-welcome-wagon",
    name: "Welcome Wagon",
    kind: "social",
    minLevel: 1,
    physicalOnly: false,
    steps: [
      s("friend", "Add a friend.", "social.friend", 1),
      s("gift", "Send them a gift.", "social.gift", 1),
    ],
    reward: { credits: 60, xp: 60 },
    giver: "Marla",
    note: "First-session social hook.",
  },
  // ---------------------------------------------------------------- battle
  {
    id: "battle-giants-challenge",
    name: "Giant's Challenge",
    kind: "battle",
    minLevel: 20,
    physicalOnly: false,
    steps: [s("win", "Win alone with a Genemon of 3+ slots against 3 or more enemies.", "battle.win", 1, { teamSize: 1, "mySlots>=": 3, "enemyCount>=": 3 })],
    reward: { credits: 300, xp: 450 },
    giver: "Coach Brakk",
    note: "Big vs swarm by slots: area moves and focus fire make one giant viable against many smalls.",
  },
  {
    id: "battle-swarm-tactics",
    name: "Swarm Tactics",
    kind: "battle",
    minLevel: 12,
    physicalOnly: false,
    steps: [s("win", "Beat a lone opponent with a team of 4 or more.", "battle.win", 1, { "teamSize>=": 4, enemyCount: 1 })],
    reward: { credits: 250, xp: 350 },
    giver: "Referee Oona",
    note: "The other side of the slot trade: many small bodies spread damage and surround.",
  },
  {
    id: "battle-conductivity-lab",
    name: "Conductivity Lab",
    kind: "battle",
    minLevel: 12,
    physicalOnly: false,
    steps: [
      s("water", "Chain 3 conduction shocks through water.", "battle.reaction", 3, { reaction: "conduction", ground: "water" }),
      s("muddy", "Chain 3 conduction shocks through muddy water.", "battle.reaction", 3, { reaction: "conduction", ground: "muddyWater" }),
      s("stone", "Land 3 electric hits on targets standing on stone.", "battle.hit", 3, { element: "electric", targetGround: "stone" }),
    ],
    reward: { credits: 250, xp: 400 },
    giver: "Ode Sparkwright",
    note: "Feel the ground conductivity ladder: water conducts best, muddy water less, stone least.",
  },
  {
    id: "battle-change-the-forecast",
    name: "Change the Forecast",
    kind: "battle",
    minLevel: 12,
    physicalOnly: false,
    steps: [
      s("weather", "Change the weather mid-battle.", "battle.weather", 1),
      s("win", "Win a battle in which the weather changed.", "battle.win", 1, { weatherChanged: true }),
    ],
    reward: { credits: 200, xp: 300 },
    giver: "Captain Rill",
    note: "Weather changers can flip a neutral matchup (fire vs electric: heatwave vs storm).",
  },
  {
    id: "battle-light-meets-shadow",
    name: "Light Meets Shadow",
    kind: "battle",
    minLevel: 12,
    physicalOnly: false,
    steps: [s("eclipse", "Make light and shadow collide 3 times.", "battle.reaction", 3, { reaction: "eclipse" })],
    reward: { credits: 200, xp: 300 },
    giver: "Noctua",
    note: "Eclipse: both sides blinded for a second; the sky decides who profits.",
  },
  {
    id: "battle-arena-shadow-hunt",
    name: "Arena Shadow Hunt",
    kind: "battle",
    minLevel: 8,
    physicalOnly: false,
    steps: [s("ko", "Knock out 3 shadow Genemon in night battles.", "battle.ko", 3, { targetElement: "shadow", night: true })],
    reward: { credits: 150, xp: 250 },
    giver: "Noctua",
    timeWindow: { startHour: 22, endHour: 4 },
    note: "Sofa version of the night-only shadow hunt: real local night, virtual arena.",
  },
  {
    id: "battle-close-quarters",
    name: "Close Quarters",
    kind: "battle",
    minLevel: 5,
    physicalOnly: false,
    steps: [s("melee", "Land 20 contact hits in fog.", "battle.hit", 20, { contact: true, weatherId: "fog" })],
    reward: { credits: 120, xp: 200 },
    giver: "Coach Brakk",
    weather: ["fog"],
    note: "Fog collapses ranged accuracy: melee builds get their day.",
  },
  {
    id: "battle-terraformers-trial",
    name: "Terraformer's Trial",
    kind: "battle",
    minLevel: 15,
    physicalOnly: false,
    steps: [
      s("ice", "Turn ground into ice twice.", "battle.terrain", 2, { to: "ice" }),
      s("stone", "Raise stone once.", "battle.terrain", 1, { to: "stone" }),
      s("grass", "Grow grass once.", "battle.terrain", 1, { to: "grass" }),
    ],
    reward: { credits: 300, xp: 450 },
    giver: "Granny Moss",
    note: "Reshaping the arena (reactions or terrain moves) is a team skill, not a single move.",
  },
  {
    id: "battle-water-and-wire",
    name: "Water and Wire",
    kind: "battle",
    minLevel: 12,
    physicalOnly: false,
    steps: [
      s("conduct", "Trigger 5 conduction reactions.", "battle.reaction", 5, { reaction: "conduction" }),
      s("win", "Win a battle with 3 or more reactions from your team.", "battle.win", 1, { "exits.reactions>=": 3 }),
    ],
    reward: { credits: 220, xp: 320 },
    giver: "Ode Sparkwright",
    note: "Synergy teams: a water partner wets targets, an electric partner chains through them. Mind friendly fire.",
  },
  // ---------------------------------------------------------------- breeding
  {
    id: "breed-clutch-one",
    name: "Clutch One",
    kind: "breeding",
    minLevel: 10,
    physicalOnly: false,
    steps: [s("breed", "Breed your first child.", "genemon.breed", 1)],
    reward: { credits: 100, xp: 200, itemId: "incubator" },
    giver: "Professor Helix",
    note: "Mendelian crossover: one allele from each parent per gene.",
  },
  {
    id: "breed-three-generations",
    name: "Three Generations",
    kind: "breeding",
    minLevel: 12,
    physicalOnly: false,
    steps: [s("gen3", "Breed a generation-3 Genemon.", "genemon.breed", 1, { "generation>=": 3 })],
    reward: { credits: 300, xp: 450 },
    giver: "Professor Helix",
    note: "Lineages accumulate and the ledger keeps the family tree.",
  },
  {
    id: "breed-fusion-trial",
    name: "Fusion Trial",
    kind: "breeding",
    minLevel: 20,
    physicalOnly: false,
    steps: [s("fuse", "Fuse two Genemon.", "genemon.fuse", 1)],
    reward: { credits: 350, xp: 500 },
    giver: "Professor Helix",
    note: "Fusion keeps the stronger pole per axis and grows the body: it costs more team slots.",
  },
  {
    id: "breed-chaos-theory",
    name: "Chaos Theory",
    kind: "breeding",
    minLevel: 15,
    physicalOnly: false,
    steps: [s("mutant", "Breed a child with 2 or more fresh mutations.", "genemon.breed", 1, { "mutations>=": 2 })],
    reward: { credits: 250, xp: 350 },
    giver: "Professor Helix",
    note: "Chaotic parents (structure < 0) mutate more: a deliberate risk lever.",
  },
  // ---------------------------------------------------------------- market
  {
    id: "market-open-stall",
    name: "Open Stall",
    kind: "market",
    minLevel: 5,
    physicalOnly: false,
    steps: [
      s("list", "List a lot.", "market.post", 1),
      s("sell", "Close a sale.", "market.sold", 1, { sellerId: ME }),
    ],
    reward: { credits: 100, xp: 120 },
    giver: "Vell",
    note: "First auction sale.",
  },
  {
    id: "market-going-once",
    name: "Going Once",
    kind: "market",
    minLevel: 5,
    physicalOnly: false,
    steps: [
      s("bid", "Place 3 bids.", "market.bid", 3),
      s("buy", "Win an auction.", "market.sold", 1, { buyerId: ME }),
    ],
    reward: { credits: 80, xp: 100 },
    giver: "Vell",
    note: "Buyer onboarding.",
  },
  {
    id: "market-pedigree",
    name: "Pedigree Sale",
    kind: "market",
    minLevel: 15,
    physicalOnly: false,
    steps: [s("sell", "Sell a Genemon of generation 3 or more.", "market.sold", 1, { sellerId: ME, kind: "genemon", "generation>=": 3 })],
    reward: { credits: 300, xp: 300 },
    giver: "Vell",
    note: "Links breeding to the economy: bred lineages are the premium lots.",
  },
  // ---------------------------------------------------------------- story arcs (chained, gated on the giver's stage)
  {
    id: "story-noctua-1",
    name: "The Owl Who Feared the Dark",
    kind: "story",
    minLevel: 3,
    physicalOnly: false,
    steps: [
      s("win", "Win a battle at night to show Noctua the dark is survivable.", "battle.win", 1, { night: true }),
      s("pet", "Calm your Genemon afterwards.", "genemon.experience", 2, exp("petting")),
    ],
    reward: { credits: 150, xp: 250 },
    giver: "Noctua",
    giverStage: 1,
    note: "Arc 1/3. Noctua's fear mirrors the conviction axis.",
  },
  {
    id: "story-noctua-2",
    name: "Lanterns",
    kind: "story",
    minLevel: 8,
    physicalOnly: false,
    steps: [
      s("blind", "Blind 5 opponents with light.", "battle.status", 5, { status: "blinded" }),
      s("eclipse", "Make light and shadow collide once.", "battle.reaction", 1, { reaction: "eclipse" }),
    ],
    reward: { credits: 300, xp: 450, itemId: "cosmetic.lantern" },
    giver: "Noctua",
    after: "story-noctua-1",
    giverStage: 2,
    note: "Arc 2/3, opens once the neighbourhood has walked 1,000 night walks with her.",
  },
  {
    id: "story-noctua-3",
    name: "Eclipse Night",
    kind: "story",
    minLevel: 20,
    physicalOnly: false,
    steps: [
      s("call", "Turn the sky to eclipse mid-battle.", "battle.weather", 1, { to: "eclipse" }),
      s("win", "Win under the eclipse.", "battle.win", 1, { weather: "eclipse" }),
    ],
    reward: { credits: 800, xp: 1000, itemId: "egg.shadow" },
    giver: "Noctua",
    after: "story-noctua-2",
    giverStage: 3,
    note: "Arc 3/3: weather changers flip light-vs-shadow matchups.",
  },
  {
    id: "story-helix-1",
    name: "The Double Helix",
    kind: "story",
    minLevel: 10,
    physicalOnly: false,
    steps: [
      s("puzzle", "Solve 2 genome puzzles.", "genemon.experience", 2, exp("puzzle")),
      s("breed", "Breed a child.", "genemon.breed", 1),
    ],
    reward: { credits: 150, xp: 250 },
    giver: "Professor Helix",
    giverStage: 1,
    note: "Arc 1/3: allele pairs and Mendelian inheritance.",
  },
  {
    id: "story-helix-2",
    name: "Generations",
    kind: "story",
    minLevel: 12,
    physicalOnly: false,
    steps: [
      s("gen3", "Breed a generation-3 Genemon.", "genemon.breed", 1, { "generation>=": 3 }),
      s("adult", "Raise a Genemon to a grown-up form (adult, imago...).", "genemon.evolve", 1, { "exits.mature": true }),
    ],
    reward: { credits: 400, xp: 600 },
    giver: "Professor Helix",
    after: "story-helix-1",
    giverStage: 2,
    note: "Arc 2/3: lineage plus life history (epigenetics) shape the adult.",
  },
  {
    id: "story-helix-3",
    name: "The Fusion Paradox",
    kind: "story",
    minLevel: 25,
    physicalOnly: false,
    steps: [
      s("fuse", "Fuse two Genemon.", "genemon.fuse", 1),
      s("win", "Win 5 battles.", "battle.win", 5),
    ],
    reward: { credits: 900, xp: 1200, itemId: "scanner.dna" },
    giver: "Professor Helix",
    after: "story-helix-2",
    giverStage: 3,
    note: "Arc 3/3: a fused body is stronger but heavier on slots; prove it still fits a team.",
  },
  {
    id: "story-rill-1",
    name: "Low Tide",
    kind: "story",
    minLevel: 1,
    physicalOnly: false,
    steps: [
      s("fish", "Feed 3 portions of fish.", "genemon.feed", 3, { food: "fish" }),
      s("swim", "Swim 3 times.", "genemon.experience", 3, exp("swimming")),
    ],
    reward: { credits: 120, xp: 180 },
    giver: "Captain Rill",
    giverStage: 1,
    note: "Arc 1/2: moisture from food and habit; a water secondary type can emerge.",
  },
  {
    id: "story-rill-2",
    name: "The Drowned Spark",
    kind: "story",
    minLevel: 10,
    physicalOnly: false,
    steps: [
      s("conduct", "Chain 5 conduction shocks through water.", "battle.reaction", 5, { reaction: "conduction", ground: "water" }),
      s("smoke", "Douse fire into smoke 3 times.", "battle.reaction", 3, { reaction: "smoke" }),
    ],
    reward: { credits: 350, xp: 500, itemId: "badge.harbour" },
    giver: "Captain Rill",
    after: "story-rill-1",
    giverStage: 2,
    note: "Arc 2/2: water is a liability against electricity and a shield against fire.",
  },
  {
    id: "story-ode-1",
    name: "Insulation",
    kind: "story",
    minLevel: 5,
    physicalOnly: false,
    steps: [
      s("stone", "Land 5 electric hits on targets on stone.", "battle.hit", 5, { element: "electric", targetGround: "stone" }),
      s("water", "Land 5 electric hits on targets in water.", "battle.hit", 5, { element: "electric", targetGround: "water" }),
    ],
    reward: { credits: 150, xp: 250 },
    giver: "Ode Sparkwright",
    giverStage: 1,
    note: "Arc 1/2: compare the damage numbers on stone and in water.",
  },
  {
    id: "story-ode-2",
    name: "The Grid",
    kind: "story",
    minLevel: 15,
    physicalOnly: false,
    steps: [
      s("magnet", "Magnetise metal 3 times.", "battle.reaction", 3, { reaction: "magnetize" }),
      s("storm", "Win 2 battles in a thunderstorm.", "battle.win", 2, { weather: "storm" }),
    ],
    reward: { credits: 400, xp: 600 },
    giver: "Ode Sparkwright",
    after: "story-ode-1",
    giverStage: 2,
    note: "Arc 2/2: electricity against metal, and the storm that empowers it.",
  },
  {
    id: "story-moss-1",
    name: "Seeds of Change",
    kind: "story",
    minLevel: 3,
    physicalOnly: false,
    steps: [
      s("grass", "Grow grass on bare ground 3 times.", "battle.terrain", 3, { to: "grass" }),
      s("bloom", "Water plants into a bloom twice.", "battle.reaction", 2, { reaction: "bloom" }),
    ],
    reward: { credits: 150, xp: 250 },
    giver: "Granny Moss",
    giverStage: 1,
    note: "Arc 1/2: plant attacks turn soil, mud and ash into grass (transformGround).",
  },
  {
    id: "story-moss-2",
    name: "Greenhouse",
    kind: "story",
    minLevel: 12,
    physicalOnly: false,
    steps: [
      s("moss", "Rest on moss for an hour, 5 times.", "genemon.exposure", 5, { ground: "moss", "hours>=": 1 }),
      s("bloom", "Make 5 blooms.", "battle.reaction", 5, { reaction: "bloom" }),
    ],
    reward: { credits: 350, xp: 500 },
    giver: "Granny Moss",
    after: "story-moss-1",
    giverStage: 2,
    note: "Arc 2/2: habitat exposure is an epigenetic input like food.",
  },
  {
    id: "story-echo-1",
    name: "Hello, Echo",
    kind: "story",
    minLevel: 1,
    physicalOnly: false,
    steps: [s("quests", "Complete 3 quests of any kind.", "quest.complete", 3)],
    reward: { credits: 100, xp: 150 },
    giver: "Echo",
    giverStage: 1,
    note: "Arc 1/3: Echo is built from the ledger of the players around it.",
  },
  {
    id: "story-echo-2",
    name: "Echo Learns to Walk",
    kind: "story",
    minLevel: 5,
    physicalOnly: true,
    steps: [
      s("walk", "Walk 5 km.", "genemon.experience", 5, exp("travelKm")),
      s("visit", "Show Echo 2 places it has never seen.", "world.visit", 2, { firstVisit: true }),
    ],
    reward: { credits: physicalCredits(250), xp: 400 },
    giver: "Echo",
    after: "story-echo-1",
    giverStage: 2,
    note: "Arc 2/3: the one physical chapter; Echo's map grows with the community's walks.",
  },
  {
    id: "story-echo-3",
    name: "Voice of the Town",
    kind: "story",
    minLevel: 20,
    physicalOnly: false,
    steps: [
      s("quests", "Complete 10 quests.", "quest.complete", 10),
      s("coop", "Win 2 co-op battles.", "social.coop", 2, { "exits.won": true }),
    ],
    reward: { credits: 900, xp: 1200, itemId: "egg.mystery" },
    giver: "Echo",
    after: "story-echo-2",
    giverStage: 3,
    note: "Arc 3/3: Echo starts proposing community goals from the ledger.",
  },
  {
    id: "story-brakk-1",
    name: "Tryouts",
    kind: "story",
    minLevel: 1,
    physicalOnly: true,
    steps: [
      s("visit", "Check in at the gym.", "world.visit", 1, { poi: "gym" }),
      s("train", "Train once.", "genemon.experience", 1, exp("gymTraining")),
    ],
    reward: { credits: physicalCredits(100), xp: 150 },
    giver: "Coach Brakk",
    giverStage: 1,
    note: "Arc 1/2: Brakk only respects what he sees you do.",
  },
  {
    id: "story-brakk-2",
    name: "Small but Fast",
    kind: "story",
    minLevel: 10,
    physicalOnly: false,
    steps: [s("ko", "Knock out 3 Large Genemon with Small ones.", "battle.ko", 3, { attackerSize: "S", targetSize: "L" })],
    reward: { credits: 350, xp: 500 },
    giver: "Coach Brakk",
    after: "story-brakk-1",
    giverStage: 2,
    note: "Arc 2/2: the coach learns small bodies win through tempo and evasion.",
  },
  {
    id: "story-marla-1",
    name: "Empty Shelves",
    kind: "story",
    minLevel: 1,
    physicalOnly: true,
    steps: [
      s("visit", "Shop at the supermarket twice this week.", "world.visit", 2, { poi: "supermarket" }),
      s("buy", "Buy 2 portions of greens.", "world.purchase", 2, { item: "greens" }),
    ],
    reward: { credits: physicalCredits(100), xp: 150 },
    giver: "Marla",
    giverStage: 1,
    note: "Arc 1/2: every purchase in her zone counts toward her Market Hall.",
  },
  {
    id: "story-marla-2",
    name: "Harvest Festival",
    kind: "story",
    minLevel: 8,
    physicalOnly: true,
    steps: [
      s("market", "Visit the farmers' market.", "world.visit", 1, { poi: "farmersMarket" }),
      s("glow", "Buy a glow fruit for the festival.", "world.purchase", 1, { item: "glowFruit" }),
    ],
    reward: { credits: physicalCredits(400), xp: 500, itemId: "glowFruit" },
    giver: "Marla",
    after: "story-marla-1",
    giverStage: 3,
    note: "Arc 2/2: unlocks only after the town made 10,000 purchases; Marla's Genemon changes with it.",
  },
];

export const QUEST_BY_ID: Record<string, Quest> = Object.fromEntries(QUESTS.map((q) => [q.id, q]));
