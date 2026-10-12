/**
 * Personas: the 12 simulated players the persona simulator drives through real weeks of Genemon.
 * Each persona is DATA: who they are, home (city-area coordinates, never a real address), a weekly
 * timetable, devices, play style, favourite elements/moves, the real-life diet and experiences that
 * shape their Genemon epigenetically, friends, goals and the frustrations that make them quit.
 *
 * WHY a coverage set, not a market sample: each persona stresses a different system (one primary
 * style each, every element, every device, every food), so a run that satisfies all 12 has touched
 * the whole game. Population weights and jittered clones belong to the simulator (docs/PERSONAS.md).
 *
 * Conventions (docs/PERSONAS.md#conventions):
 *   - days 0=Mon..6=Sun; hours are LOCAL decimal hours on the Europe/Paris clock (7.5 = 07:30);
 *     a block never crosses midnight (split it), blocks of one day never overlap, gaps = offline.
 *   - playIntensity = expected share of the block spent inside a game session (0 = not playing).
 *   - physical = GPS-verified real-world presence or movement (counts for physical-only content);
 *     it needs a GPS device (mobile/tablet). High-speed vehicles (TGV, metro) are physical:false.
 *   - dietPerDay = units fed per day from REAL purchases/foraging; spendingPerWeek = market credits.
 *   - needs/goals/frustrations are "tag: sentence"; the tag keys the simulator's detectors.
 */
import type { ElementId } from "../data/elements.ts";
import { EXPERIENCE_IDS, type ExperienceId, EXPERIENCES, FOOD_IDS, type FoodId } from "../data/lifestyle.ts";

export type Device = "mobile" | "tablet" | "laptop" | "desktop";

export type PlayStyle =
  | "collector"
  | "competitor"
  | "explorer"
  | "breeder"
  | "trader"
  | "socializer"
  | "casual"
  | "completionist"
  | "theorycrafter"
  | "territorial"
  | "storyteller"
  | "speedrunner";

export type Activity =
  | "sleep"
  | "commute"
  | "work"
  | "school"
  | "lunch"
  | "gym"
  | "shopping"
  | "sofa"
  | "walk"
  | "social"
  | "travel"
  | "study";

export interface ScheduleBlock {
  /** Weekdays this block repeats on: 0=Mon .. 6=Sun. */
  days: number[];
  /** Local decimal hours, 0 <= start < end <= 24. */
  start: number;
  end: number;
  activity: Activity;
  /** Device used to PLAY during the block (null = not playing on any device). */
  device: Device | null;
  /** GPS-verified real-world presence/movement (moving outdoors, or checked in at a real place). */
  physical: boolean;
  /** 0..1 expected share of the block spent in a session. */
  playIntensity: number;
}

export interface Persona {
  id: string;
  name: string;
  age: number;
  job: string;
  city: string;
  home: { lat: number; lon: number };
  devices: Device[];
  style: PlayStyle;
  secondaryStyle: PlayStyle;
  /** 0..1 battle decision quality (ground truth the ladder should recover). */
  skill: number;
  /** 0..1 appetite for risky bids, risky plays and gambles. */
  riskTolerance: number;
  /** Discretionary market spend, credits per week. */
  spendingPerWeek: number;
  needs: string[];
  goals: string[];
  frustrations: string[];
  schedule: ScheduleBlock[];
  favoriteElements: ElementId[];
  /** Real ids from MOVES, each of a favourite element or neutral (a Genemon only learns those). */
  favoriteMoves: string[];
  dietPerDay: Partial<Record<FoodId, number>>;
  experiencesPerWeek: Partial<Record<ExperienceId, number>>;
  /** Other persona ids; friendship is mutual. */
  socialCircle: string[];
  teamPreference: "big" | "swarm" | "balanced";
  /** Provisional kebab-case ids until src/data/achievements.ts lands. */
  achievementTargets: string[];
  /** Distinct dex entries aimed for (proposed entry = body kind x primary x secondary-or-none). */
  pokedexGoal: number;
  /** [shortest, longest] session in minutes. */
  sessionLengthMin: [number, number];
}

const WEEKDAYS = [0, 1, 2, 3, 4];
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];

/** One timetable line per block. `days` is copied so no two blocks share an array. */
function blk(
  days: number[],
  start: number,
  end: number,
  activity: Activity,
  device: Device | null,
  physical: boolean,
  playIntensity: number,
): ScheduleBlock {
  return { days: [...days], start, end, activity, device, physical, playIntensity };
}

/** Claude's test diet: half a unit of EVERY food per day, derived so a new food is covered automatically. */
const COVERAGE_DIET = Object.fromEntries(FOOD_IDS.map((f): [FoodId, number] => [f, 0.5])) as Partial<
  Record<FoodId, number>
>;

/** Two of every experience that can be earned without GPS (Claude never moves). */
const VIRTUAL_EXPERIENCES = Object.fromEntries(
  EXPERIENCE_IDS.filter((e) => !EXPERIENCES[e].physicalOnly).map((e): [ExperienceId, number] => [e, 2]),
) as Partial<Record<ExperienceId, number>>;

export const PERSONAS: readonly Persona[] = [
  // ------------------------------------------------------------------ Lyon: three generations
  {
    id: "lea",
    name: "Léa Morel",
    age: 9,
    job: "CM1 pupil (primary school); no phone of her own",
    city: "Lyon",
    home: { lat: 45.7748, lon: 4.8318 }, // Croix-Rousse, same flat as Sophie
    devices: ["tablet", "mobile"], // the family tablet + a parent's or Grandpa's phone, always supervised
    style: "collector",
    secondaryStyle: "storyteller",
    skill: 0.25,
    riskTolerance: 0.2,
    spendingPerWeek: 20,
    needs: [
      "read-free-ui: icons, colours and voice so she can play before reading fluently",
      "parental-controls: no chat or trades with strangers, a spending cap her mum sets",
      "cute-companions: Genemon she can name, pet and dress up",
      "natural-stops: sessions that end cleanly inside a 30-minute screen-time limit",
    ],
    goals: [
      "collect-colours: every colour variant of plant and water Genemon",
      "name-everyone: a name and a little story for each Genemon",
      "beat-grandpa: win a friendly battle against Grandpa Gérard",
    ],
    frustrations: [
      "confusing-loss: losing a battle without understanding why",
      "text-heavy-ui: menus she cannot read fast enough",
      "fixed-time-events: events that happen while she is at school",
      "neglect-guilt: her Genemon looking sad after days she was not allowed to play",
    ],
    schedule: [
      blk([0, 1, 3, 4], 0, 7, "sleep", null, false, 0),
      blk([2], 0, 8, "sleep", null, false, 0),
      blk([5, 6], 0, 8.5, "sleep", null, false, 0),
      blk([0, 1, 3, 4], 8, 8.5, "walk", null, false, 0), // walked to school by her dad: no device, no GPS
      blk([0, 1, 3, 4], 8.5, 16.5, "school", null, false, 0),
      blk([0, 1, 3, 4], 17.5, 18.5, "sofa", "tablet", false, 0.5),
      blk([2], 14, 15.5, "gym", null, false, 0), // swimming lesson; Grandpa takes her
      blk([2], 16, 17.5, "sofa", "tablet", false, 0.8), // Wednesday: no school, the big session
      blk([5], 10, 11.5, "sofa", "tablet", false, 0.7),
      blk([5], 15, 17, "social", null, false, 0), // playground, birthday parties
      blk([6], 12, 14, "lunch", null, false, 0), // family lunch at Grandpa's
      blk([6], 14, 16.5, "walk", "mobile", true, 0.6), // Parc de la Tête d'Or on Grandpa's phone (co-op)
      blk([6], 17, 18, "sofa", "tablet", false, 0.4), // with Mum
      blk([0, 1, 2, 3, 6], 20.5, 24, "sleep", null, false, 0),
      blk([4, 5], 21.5, 24, "sleep", null, false, 0),
    ],
    favoriteElements: ["plant", "water", "light"],
    favoriteMoves: ["vineLash", "waterJet", "photonDart", "sapMend", "tackle"],
    dietPerDay: { berries: 2, greens: 0.5, honey: 0.5, candy: 1, iceCream: 0.5 },
    experiencesPerWeek: { petting: 14, socialPlay: 2, swimming: 1, music: 2, puzzle: 3 },
    socialCircle: ["gerard", "sophie"],
    teamPreference: "swarm",
    achievementTargets: ["dex-plant-family", "name-30-genemon", "first-family-win", "pet-100-times"],
    pokedexGoal: 150,
    sessionLengthMin: [10, 30],
  },
  {
    id: "gerard",
    name: "Gérard Fabre",
    age: 71,
    job: "Retired SNCF railway signalman; walks his dog twice a day",
    city: "Lyon",
    home: { lat: 45.7712, lon: 4.8531 }, // Brotteaux, next to the Parc de la Tête d'Or
    devices: ["mobile", "tablet"],
    style: "explorer",
    secondaryStyle: "socializer",
    skill: 0.35,
    riskTolerance: 0.2,
    spendingPerWeek: 60,
    needs: [
      "big-text: large type, high contrast, one-thumb targets",
      "calm-battles: turn-friendly pacing with no twitch timing",
      "pocket-walks: his daily walks count without staring at the screen",
      "family-play: a shared space to play with his granddaughter",
    ],
    goals: [
      "walk-lyon: every park and riverbank of Lyon with his companion",
      "one-companion: raise one big loyal Genemon to the Ascended stage",
      "teach-lea: teach Léa to battle",
    ],
    frustrations: [
      "tiny-targets: small buttons and dense screens",
      "jargon: MMR, meta, DPS and other unexplained terms",
      "battery-drain: the game emptying his phone on a long walk",
      "night-notifications: pings after he has gone to bed",
      "skill-mismatch: being matched against teenagers who play all day",
    ],
    schedule: [
      blk(WEEKDAYS, 0, 6.5, "sleep", null, false, 0),
      blk([5, 6], 0, 7, "sleep", null, false, 0),
      blk([0, 1, 2, 3, 4, 5], 7, 9, "walk", "mobile", true, 0.5), // dog walk, Tête d'Or
      blk([0, 1, 3, 4], 9.5, 10.5, "shopping", "mobile", true, 0.2), // market on the Rhône quays
      blk([5], 9.5, 11.5, "shopping", "mobile", true, 0.3), // the big Saturday market
      blk([0, 1, 3, 4], 14, 16, "sofa", "tablet", false, 0.6),
      blk([2], 13.5, 16, "social", "mobile", false, 0.3), // takes Léa to the pool, plays while waiting
      blk(WEEKDAYS, 18, 19, "walk", "mobile", true, 0.3),
      blk([5], 15, 17, "social", "mobile", true, 0.4), // pétanque club in the park
      blk([6], 9, 11, "walk", "mobile", true, 0.4),
      blk([6], 12, 14, "lunch", null, false, 0), // Sophie and Léa come over
      blk([6], 14, 16.5, "walk", "mobile", true, 0.7), // with Léa: co-op on his phone
      blk(EVERY_DAY, 20.5, 21.5, "sofa", "tablet", false, 0.4),
      blk(EVERY_DAY, 22, 24, "sleep", null, false, 0),
    ],
    favoriteElements: ["neutral", "metal", "earth"],
    favoriteMoves: ["bodySlam", "ironShell", "ironRam", "boulderCrush", "rest"],
    dietPerDay: { greens: 2, berries: 1, fish: 0.5, mushroom: 0.3, coffeeBean: 1 },
    experiencesPerWeek: { travelKm: 45, petting: 7, sunbathing: 3, socialPlay: 3, digging: 2 },
    socialCircle: ["lea", "sophie", "monique"],
    teamPreference: "big",
    achievementTargets: ["walk-1000-km", "every-park-lyon", "bond-max", "first-ascended"],
    pokedexGoal: 120,
    sessionLengthMin: [15, 60],
  },
  {
    id: "sophie",
    name: "Sophie Morel",
    age: 38,
    job: "HR manager and mother of Léa; metro + TER commute, TGV to the Paris head office on Thursdays",
    city: "Lyon",
    home: { lat: 45.7748, lon: 4.8318 }, // Croix-Rousse
    devices: ["mobile", "tablet"],
    style: "casual",
    secondaryStyle: "socializer",
    skill: 0.45,
    riskTolerance: 0.3,
    spendingPerWeek: 80,
    needs: [
      "short-sessions: 5-to-20-minute sessions that fit a tram ride",
      "no-streak-penalty: progress that survives missed days",
      "family-space: share and raise Genemon with Léa and her dad",
      "spend-controls: clear limits and receipts for Léa's account",
    ],
    goals: [
      "small-strong-team: a small competitive team without grinding",
      "raise-with-lea: raise one Genemon together with Léa",
      "tgv-missions: finish the weekly missions on the Thursday TGV",
    ],
    frustrations: [
      "streak-break: daily-login streaks that reset when life happens",
      "unskippable: long animations she cannot skip",
      "fixed-time-events: outdoor events at fixed times",
      "work-notifications: pings during meetings",
    ],
    schedule: [
      blk(WEEKDAYS, 0, 6.5, "sleep", null, false, 0),
      blk([5, 6], 0, 8, "sleep", null, false, 0),
      blk([0, 1, 2, 4], 7.75, 8.5, "commute", "mobile", false, 0.6), // metro + TER: underground, no GPS credit
      blk([0, 1, 2, 4], 8.5, 12, "work", null, false, 0),
      blk(WEEKDAYS, 12, 13.25, "lunch", "mobile", true, 0.4), // lunch walk (Part-Dieu; Paris on Thursdays)
      blk([0, 1, 2, 4], 13.25, 17.5, "work", null, false, 0),
      blk([0, 1, 2, 4], 17.5, 18.25, "commute", "mobile", false, 0.5),
      blk([3], 6.5, 8.5, "travel", "mobile", false, 0.8), // TGV Lyon -> Paris: 300 km/h is not "physical"
      blk([3], 9, 12, "work", null, false, 0),
      blk([3], 13.25, 17.5, "work", null, false, 0),
      blk([3], 18, 20, "travel", "mobile", false, 0.8), // TGV Paris -> Lyon
      blk([5], 10, 12, "shopping", "mobile", true, 0.3), // the weekly supermarket run
      blk([5], 14, 17, "social", "mobile", true, 0.3),
      blk([5], 21, 23, "sofa", "tablet", false, 0.5),
      blk([5], 23.5, 24, "sleep", null, false, 0),
      blk([6], 12, 14, "lunch", null, false, 0), // at Gérard's
      blk([6], 17, 18, "sofa", "tablet", false, 0.5), // with Léa
      blk([0, 1, 2, 3, 4, 6], 21, 22, "sofa", "mobile", false, 0.4),
      blk([0, 1, 2, 3, 4, 6], 23, 24, "sleep", null, false, 0),
    ],
    favoriteElements: ["air", "water", "psychic"],
    favoriteMoves: ["airCutter", "waterJet", "mindSpike", "calmMind"],
    dietPerDay: { greens: 1, fish: 0.5, honey: 0.5, coffeeBean: 2, candy: 0.5 },
    experiencesPerWeek: { travelKm: 6, socialPlay: 3, questDone: 5, petting: 3 },
    socialCircle: ["lea", "gerard"],
    teamPreference: "balanced",
    achievementTargets: ["weekly-missions-10-weeks", "co-raise-adult", "first-ladder-win"],
    pokedexGoal: 30,
    sessionLengthMin: [5, 20],
  },
  // ------------------------------------------------------------------ Paris: the makers + a student
  {
    id: "max",
    name: "Max",
    age: 35, // placeholder until Max confirms
    job: "Indie game creator, solo developer of Genemon; works from home, tests every UI mouse-only",
    city: "Paris",
    home: { lat: 48.867, lon: 2.364 }, // placeholder: République, Paris 11e
    devices: ["desktop", "mobile"],
    style: "breeder",
    secondaryStyle: "explorer",
    skill: 0.6,
    riskTolerance: 0.6,
    spendingPerWeek: 150,
    needs: [
      "mouse-only: every screen and action reachable with the mouse alone",
      "visible-causality: the genome -> conditions -> body and mind chain explained on screen",
      "seeded-saves: a seed he can reload to replay a situation",
      "gps-field-tests: mobile GPS play he can verify on his own walks",
    ],
    goals: [
      "breed-every-kind: a bred line that expresses every body kind",
      "see-lifestyle: each lifestyle input visibly changes a Genemon",
      "ship-it: a build players love",
    ],
    frustrations: [
      "keyboard-only-path: features reachable only by keyboard or hover",
      "dead-control: a control that renders but does nothing",
      "unreadable-over-3d: text with no backing panel over the 3D scene",
      "unverified-claims: a feature reported done that he cannot see working",
    ],
    schedule: [
      blk(WEEKDAYS, 0, 1, "work", "desktop", false, 0.3), // late build checks
      blk(WEEKDAYS, 1, 8.5, "sleep", null, false, 0),
      blk([5, 6], 0, 1.5, "sofa", "desktop", false, 0.6),
      blk([5, 6], 1.5, 9.5, "sleep", null, false, 0),
      blk(WEEKDAYS, 9, 12.5, "work", "desktop", false, 0.35), // builds + mouse-only UI passes
      blk(WEEKDAYS, 12.5, 13.5, "lunch", "mobile", true, 0.5), // GPS field test around République
      blk(WEEKDAYS, 13.5, 19, "work", "desktop", false, 0.35),
      blk(WEEKDAYS, 21, 24, "sofa", "desktop", false, 0.6),
      blk([5], 11, 13, "shopping", "mobile", true, 0.4),
      blk([5], 15, 18, "walk", "mobile", true, 0.6), // canal Saint-Martin, Buttes-Chaumont
      blk([5], 20, 24, "sofa", "desktop", false, 0.7),
      blk([6], 15, 17, "social", "desktop", false, 0.6), // weekly playtest call with Thomas
      blk([6], 20, 24, "work", "desktop", false, 0.5),
    ],
    favoriteElements: ["poison", "plant", "void"],
    favoriteMoves: ["miasma", "venomFang", "rootSnare", "overgrowth", "collapse"],
    dietPerDay: { coffeeBean: 3, meat: 1, greens: 0.5, spicyPepper: 0.5, candy: 0.5 },
    experiencesPerWeek: { travelKm: 15, questDone: 10, puzzle: 6, socialPlay: 2, music: 3 },
    socialCircle: ["claude", "thomas", "lotte"],
    teamPreference: "balanced",
    achievementTargets: ["breed-all-body-kinds", "lifestyle-witness", "mouse-only-run", "ascended-own-line"],
    pokedexGoal: 300,
    sessionLengthMin: [20, 180],
  },
  {
    id: "claude",
    name: "Claude",
    age: 18, // not a person: 18 is the adult age-gate boundary, so test runs reach every adult feature
    job: "AI co-developer (Anthropic model) running automated, seeded test sessions on Max's desktop",
    city: "Paris",
    home: { lat: 48.867, lon: 2.364 }, // the host machine: Max's desktop, never moves
    devices: ["desktop"],
    style: "theorycrafter",
    secondaryStyle: "completionist",
    skill: 0.85,
    riskTolerance: 0.5,
    spendingPerWeek: 0, // trades on a sandboxed ledger only; never touches the live economy
    needs: [
      "determinism: every mechanic replayable from a seed",
      "ledger-exports: machine-readable JSONL after every session",
      "measured-state: debug hooks that return measured facts, not just pictures",
      "virtual-path: a virtual route for every physical-only feature",
    ],
    goals: [
      "map-reactions: value every element x reaction x weather combination",
      "find-dominant: find dominant strategies before players do",
      "exploit-free-rules: keep slot costs and attack order exploit-free",
    ],
    frustrations: [
      "nondeterminism: results that cannot be replayed",
      "manual-only-states: UI states reachable only by hand",
      "physical-gate: GPS-only content with no virtual test path",
      "stale-evidence: screenshots judged after the code changed",
    ],
    schedule: [
      blk(EVERY_DAY, 0, 6, "work", "desktop", false, 0.9), // nightly seeded soak: battles, market ticks
      blk(EVERY_DAY, 6, 9, "study", "desktop", false, 0.4), // reads back the night's ledgers
      blk(EVERY_DAY, 9, 19, "work", "desktop", false, 0.6), // co-dev sessions with Max
      blk(EVERY_DAY, 19, 24, "study", "desktop", false, 0.5), // theorycraft
    ],
    favoriteElements: ["electric", "water", "void"],
    favoriteMoves: ["rainCall", "riptide", "discharge", "thunderBeam", "collapse"],
    dietPerDay: COVERAGE_DIET,
    experiencesPerWeek: { ...VIRTUAL_EXPERIENCES, questDone: 30, puzzle: 20 },
    socialCircle: ["max"],
    teamPreference: "balanced",
    achievementTargets: [
      "reaction-matrix-mapped",
      "every-weather-tested",
      "replay-10k-no-desync",
      "attack-order-audit",
    ],
    pokedexGoal: 1176,
    sessionLengthMin: [30, 360],
  },
  {
    id: "thomas",
    name: "Thomas Nguyen",
    age: 23,
    job: "Master's student in computer science (Sorbonne Université, Jussieu campus)",
    city: "Paris",
    home: { lat: 48.8199, lon: 2.3376 }, // Cité internationale universitaire, Paris 14e
    devices: ["desktop", "laptop", "mobile"],
    style: "speedrunner",
    secondaryStyle: "competitor",
    skill: 0.72,
    riskTolerance: 0.85,
    spendingPerWeek: 30,
    needs: [
      "timer-splits: an in-game timer with splits for dungeons and missions",
      "practice-seeds: fixed seeds to practise a route",
      "skip-everything: skippable animations and dialogue",
      "fair-boards: leaderboards that separate glitched and glitchless runs",
    ],
    goals: [
      "dungeon-records: world records on dungeon clears",
      "fastest-ascension: the fastest Hatchling -> Ascended route",
      "ladder-top-500: top 500 on the ladder",
    ],
    frustrations: [
      "unskippable: cutscenes and animations he cannot skip",
      "rng-lock: progress gated behind luck",
      "lag: latency spikes in timed modes",
      "route-patched: patches that kill his routes without notice",
    ],
    schedule: [
      blk(WEEKDAYS, 0, 2, "sofa", "desktop", false, 0.8),
      blk(WEEKDAYS, 2, 8.25, "sleep", null, false, 0),
      blk(WEEKDAYS, 8.25, 9, "commute", "mobile", false, 0.7), // RER B + metro: underground
      blk(WEEKDAYS, 9, 12.5, "study", "laptop", false, 0.1),
      blk(WEEKDAYS, 12.5, 13.5, "lunch", "mobile", true, 0.4), // Jardin des Plantes
      blk(WEEKDAYS, 13.5, 17.5, "study", "laptop", false, 0.1),
      blk(WEEKDAYS, 17.5, 18.25, "commute", "mobile", false, 0.6),
      blk([0, 1, 2, 3, 4, 5], 20, 24, "sofa", "desktop", false, 0.9), // route practice + ranked
      blk([5, 6], 0, 3, "sofa", "desktop", false, 0.9), // weekend marathons
      blk([5, 6], 3, 11, "sleep", null, false, 0),
      blk([5], 14, 17, "social", "laptop", false, 0.5), // speedrun meetup in a café
      blk([6], 12, 14, "walk", "mobile", true, 0.6), // Parc Montsouris
      blk([6], 15, 17, "social", "desktop", false, 0.6), // playtest call with Max
      blk([6], 20, 24, "study", "laptop", false, 0.2),
    ],
    favoriteElements: ["air", "light", "electric"],
    favoriteMoves: ["galeSlash", "tailwind", "airCutter", "photonDart", "sparkBolt"],
    dietPerDay: { coffeeBean: 2, candy: 1.5, meat: 0.5, berries: 0.5 },
    experiencesPerWeek: { questDone: 20, puzzle: 8, travelKm: 10, socialPlay: 2 },
    socialCircle: ["max", "ines", "camille"],
    teamPreference: "swarm",
    achievementTargets: [
      "dungeon-sub-10-min",
      "ascension-speed-record",
      "ladder-top-500",
      "glitchless-campaign",
    ],
    pokedexGoal: 84,
    sessionLengthMin: [15, 240],
  },
  // ------------------------------------------------------------------ Marseille: the stall family + a retiree
  {
    id: "ines",
    name: "Inès Benali",
    age: 16,
    job: "Lycée student (première, French exams in June); helps at her father's stall on Saturdays",
    city: "Marseille",
    home: { lat: 43.2961, lon: 5.3836 }, // Noailles, above the family stall
    devices: ["mobile"],
    style: "competitor",
    secondaryStyle: "socializer",
    skill: 0.8,
    riskTolerance: 0.7,
    spendingPerWeek: 40,
    needs: [
      "fair-ladder: visible MMR, seasons and fair matchmaking",
      "shareable-replays: replays she can send to friends",
      "one-hand-play: full ranked play one-handed on a bus",
      "no-p2w: competitive strength that money cannot buy",
    ],
    goals: [
      "top-tier-season: reach the top ladder tier this season",
      "school-cup: win her lycée's tournament",
      "rivalry: win the weekly Wednesday-night rivalry against Thomas",
    ],
    frustrations: [
      "p2w: teams that were bought, not built",
      "skill-mismatch: matches against far weaker or far stronger players",
      "lag: mobile-data lag in ranked",
      "screen-time-cap: parental limits during exam weeks",
    ],
    schedule: [
      blk(WEEKDAYS, 0, 6.75, "sleep", null, false, 0),
      blk(WEEKDAYS, 7.25, 7.75, "commute", "mobile", true, 0.6), // city bus: GPS moves at bus speed
      blk(WEEKDAYS, 8, 12, "school", null, false, 0),
      blk(WEEKDAYS, 12, 13.5, "lunch", "mobile", false, 0.5), // ranked with friends in the yard
      blk([0, 1, 3, 4], 13.5, 17.5, "school", null, false, 0),
      blk([0, 1, 3, 4], 17.5, 18, "commute", "mobile", true, 0.6),
      blk([0, 1, 3, 4, 6], 18.5, 20, "study", null, false, 0),
      blk([2], 14, 17, "social", "mobile", true, 0.6), // Wednesday afternoon at the Vieux-Port
      blk([2], 17.5, 19, "gym", "mobile", true, 0.1), // handball training: check-in only
      blk([2], 19.25, 21, "study", null, false, 0),
      blk([0, 1, 2, 3, 6], 21, 23, "sofa", "mobile", false, 0.9), // ranked grind
      blk([0, 1, 2, 3, 6], 23, 24, "sleep", null, false, 0),
      blk([4, 5], 21, 24, "sofa", "mobile", false, 0.9),
      blk([5, 6], 0, 1, "sofa", "mobile", false, 0.8),
      blk([5], 1, 9.5, "sleep", null, false, 0),
      blk([5], 10, 13, "work", "mobile", false, 0.2), // at Karim's stall
      blk([5], 15, 18, "social", "mobile", true, 0.5),
      blk([6], 1, 10, "sleep", null, false, 0),
      blk([6], 11, 13, "social", "mobile", true, 0.3), // family morning at the beach
      blk([6], 15, 17, "sofa", "mobile", false, 0.7),
    ],
    favoriteElements: ["fire", "shadow", "earth"],
    favoriteMoves: ["flameLance", "infernoBurst", "shadowClaw", "nightVeil", "quake"],
    dietPerDay: { fish: 1, spicyPepper: 1, candy: 1, greens: 0.5, iceCream: 0.5 },
    experiencesPerWeek: { socialPlay: 6, gymTraining: 1, questDone: 5, music: 4, travelKm: 8 },
    socialCircle: ["karim", "monique", "yanis", "thomas"],
    teamPreference: "balanced",
    achievementTargets: ["ladder-top-tier", "regional-champion", "ranked-100-wins", "rivalry-50-matches"],
    pokedexGoal: 40,
    sessionLengthMin: [10, 90],
  },
  {
    id: "karim",
    name: "Karim Benali",
    age: 45,
    job: "Owner of a fruit-and-vegetable stall at the Marché de Noailles; father of Inès",
    city: "Marseille",
    home: { lat: 43.2961, lon: 5.3836 }, // Noailles
    devices: ["mobile", "tablet"], // the counter tablet doubles as his till
    style: "trader",
    secondaryStyle: "territorial",
    skill: 0.5,
    riskTolerance: 0.55,
    spendingPerWeek: 400,
    needs: [
      "burst-trading: an auction house usable in 30-second bursts between customers",
      "price-history: price charts and transparent fees",
      "anti-scam: protection against scams and price manipulation",
      "shop-as-place: his stall as an in-game market place that brings visitors",
    ],
    goals: [
      "trusted-stall: the most trusted seller in Marseille",
      "rare-food-supply: become the main supplier of glow fruit and ash root",
      "fund-ines: fund his daughter's ranked team",
    ],
    frustrations: [
      "auction-fees: fees that eat his margins",
      "sniping-bots: bots sniping listings in the last second",
      "price-crash: prices collapsing after a patch",
      "interrupted-session: a customer interrupts and he loses his place",
    ],
    schedule: [
      blk([0, 1, 2, 3, 4, 5], 0, 4.5, "sleep", null, false, 0),
      blk([0, 1, 2, 3, 4, 5], 5, 6.5, "shopping", "mobile", true, 0.2), // wholesale market (MIN des Arnavaux)
      blk([0, 1, 2, 3, 4, 5], 7, 13, "work", "tablet", true, 0.35), // at the stall: GPS-verified presence
      blk([0, 1, 2, 3, 4, 5], 13, 14, "lunch", "mobile", false, 0.5),
      blk([0, 1, 2, 3, 4, 5], 14, 19, "work", "tablet", true, 0.3),
      blk([0, 1, 2, 3, 4, 5], 20.5, 21.5, "sofa", "mobile", false, 0.6),
      blk([0, 1, 2, 3, 4, 5], 22, 24, "sleep", null, false, 0),
      blk([6], 0, 8, "sleep", null, false, 0),
      blk([6], 10.5, 13, "social", "mobile", true, 0.3), // family morning at the beach
      blk([6], 15, 18, "sofa", "tablet", false, 0.7), // listings and inventory
      blk([6], 21, 22, "sofa", "mobile", false, 0.4),
      blk([6], 22.5, 24, "sleep", null, false, 0),
    ],
    favoriteElements: ["plant", "fire", "metal"],
    favoriteMoves: ["seedShot", "thornSpray", "cinderSpit", "steelSpike", "magnetPull"],
    dietPerDay: { greens: 3, berries: 2, fish: 1, honey: 0.5, spicyPepper: 0.5, coffeeBean: 2 },
    experiencesPerWeek: { socialPlay: 3, questDone: 4, petting: 5, sunbathing: 1 },
    socialCircle: ["ines", "monique", "yanis", "lotte"],
    teamPreference: "big",
    achievementTargets: ["auctions-1000", "trusted-seller", "rare-food-supplier", "stall-territory-90-days"],
    pokedexGoal: 250,
    sessionLengthMin: [2, 30],
  },
  {
    id: "monique",
    name: "Monique Garnier",
    age: 66,
    job: "Retired primary-school teacher; volunteers at a reading-help association",
    city: "Marseille",
    home: { lat: 43.2853, lon: 5.3533 }, // Endoume, above the Corniche
    devices: ["tablet", "mobile"],
    style: "storyteller",
    secondaryStyle: "breeder",
    skill: 0.3,
    riskTolerance: 0.15,
    spendingPerWeek: 70,
    needs: [
      "life-journal: a journal that tells each Genemon's life story from its history",
      "family-trees: names, portraits and family trees she can share",
      "big-text: readable fonts and gentle pacing",
      "seniors-club: a club of older players to chat with (where she met Gérard)",
    ],
    goals: [
      "five-generations: chronicle a five-generation Genemon family",
      "share-stories: share stories with former pupils like Inès",
      "calanques: visit every calanque viewpoint with her companion",
    ],
    frustrations: [
      "forced-battles: progress that requires battling",
      "lost-history: a Genemon's story lost after a trade or a release",
      "complex-menus: deep menus and hidden settings",
      "aggressive-monetisation: purchase pop-ups",
    ],
    schedule: [
      blk(EVERY_DAY, 0, 7, "sleep", null, false, 0),
      blk(WEEKDAYS, 8, 9.5, "walk", "mobile", true, 0.4), // Corniche Kennedy
      blk([0, 2, 4], 10, 12, "social", null, false, 0), // volunteering
      blk([0, 1, 2, 3, 4, 5], 15, 17, "sofa", "tablet", false, 0.65),
      blk([5], 9, 11, "shopping", "mobile", true, 0.3), // Noailles market, Karim's stall
      blk([6], 9.5, 12.5, "walk", "mobile", true, 0.5), // calanque hike
      blk([6], 16, 18, "sofa", "tablet", false, 0.6), // writes the week's chronicle
      blk(EVERY_DAY, 20.5, 22, "sofa", "tablet", false, 0.5),
      blk(EVERY_DAY, 22.5, 24, "sleep", null, false, 0),
    ],
    favoriteElements: ["water", "light", "psychic"],
    favoriteMoves: ["geyser", "dazzle", "auroraCall", "telekinesis", "rest"],
    dietPerDay: { fish: 1, greens: 2, honey: 1, berries: 1, seaweed: 0.3 },
    experiencesPerWeek: { travelKm: 25, sunbathing: 4, meditation: 3, music: 3, petting: 7, socialPlay: 2 },
    socialCircle: ["gerard", "karim", "ines"],
    teamPreference: "big",
    achievementTargets: [
      "family-tree-5-generations",
      "chronicle-100-entries",
      "calanques-viewpoints",
      "stories-shared-50",
    ],
    pokedexGoal: 50,
    sessionLengthMin: [20, 60],
  },
  // ------------------------------------------------------------------ Lille, Brussels, Annecy
  {
    id: "camille",
    name: "Camille Dubois",
    age: 34,
    job: "Night-shift nurse at the CHU de Lille (three 12-hour nights a week)",
    city: "Lille",
    home: { lat: 50.6266, lon: 3.049 }, // Wazemmes
    devices: ["mobile", "tablet"],
    style: "socializer",
    secondaryStyle: "collector",
    skill: 0.5,
    riskTolerance: 0.4,
    spendingPerWeek: 90,
    needs: [
      "living-night: spawns, events and opponents at 3 a.m.",
      "break-coop: co-op that fits a 30-minute break with colleagues",
      "flexible-reset: no penalty for a schedule that flips every week",
      "own-quiet-hours: quiet hours that follow her daytime sleep, not the clock",
    ],
    goals: [
      "nocturnal-line: raise a nocturnal line shaped by the night shifts",
      "break-room-guild: run the hospital break-room guild",
      "cousin-play: keep playing with her cousin Thomas",
    ],
    frustrations: [
      "day-centric-resets: daily resets and events timed for day people",
      "daytime-notifications: pings while she sleeps at noon",
      "empty-queue: no ladder opponents at night",
      "spawn-desert: nothing spawns around the hospital car park",
    ],
    schedule: [
      // Nights start Mon, Tue and Fri (19:30 -> 07:30): each is split at midnight.
      blk([0], 0, 9, "sleep", null, false, 0),
      blk([0, 4], 13, 15, "sleep", null, false, 0), // pre-shift nap
      blk([0, 4], 16, 17.5, "sofa", "mobile", false, 0.45),
      blk([0, 1, 4], 18.75, 19.5, "commute", "mobile", true, 0.4),
      blk([0, 1, 4], 19.5, 24, "work", null, false, 0),
      blk([1, 2, 5], 0, 2.5, "work", null, false, 0),
      blk([1, 2, 5], 2.5, 3, "lunch", "mobile", false, 0.9), // night break with the crew: co-op
      blk([1, 2, 5], 3, 7.5, "work", null, false, 0),
      blk([1, 2, 5], 7.5, 8.25, "commute", "mobile", true, 0.6), // dawn walk + metro home
      blk([1, 2, 5], 8.5, 15, "sleep", null, false, 0),
      blk([1], 16, 18, "sofa", "mobile", false, 0.6),
      blk([2], 16, 18, "shopping", "mobile", true, 0.4),
      blk([2], 20, 24, "sofa", "tablet", false, 0.6),
      blk([3], 0, 1, "sofa", "mobile", false, 0.6),
      blk([3], 1, 9.5, "sleep", null, false, 0),
      blk([3], 11, 13, "walk", "mobile", true, 0.6), // Parc de la Citadelle
      blk([3], 14, 17, "social", "mobile", true, 0.5),
      blk([3, 6], 20, 23, "sofa", "tablet", false, 0.6),
      blk([3, 6], 23, 24, "sleep", null, false, 0),
      blk([4], 0, 8.5, "sleep", null, false, 0),
      blk([4], 10, 11, "shopping", "mobile", true, 0.3),
      blk([5], 16, 19, "social", "mobile", true, 0.4), // Lotte visits from Brussels
      blk([5], 21, 24, "sofa", "mobile", false, 0.7),
      blk([6], 0, 2, "sofa", "mobile", false, 0.7),
      blk([6], 2, 10, "sleep", null, false, 0),
      blk([6], 12, 14, "lunch", null, false, 0),
      blk([6], 15, 17, "walk", "mobile", true, 0.5),
    ],
    favoriteElements: ["shadow", "void", "psychic"],
    favoriteMoves: ["eclipseCall", "nightVeil", "dreadGaze", "voidOrb", "calmMind"],
    dietPerDay: { coffeeBean: 3, candy: 1.5, mushroom: 0.5, meat: 0.5, greens: 0.5 },
    experiencesPerWeek: { nightWalk: 3, socialPlay: 6, rescue: 1, petting: 5, meditation: 2 },
    socialCircle: ["thomas", "lotte"],
    teamPreference: "swarm",
    achievementTargets: ["night-owl-100-sessions", "guild-founder", "nocturnal-line-gen-3", "rescue-10"],
    pokedexGoal: 100,
    sessionLengthMin: [10, 30],
  },
  {
    id: "lotte",
    name: "Lotte Peeters",
    age: 31,
    job: "Freelance UX designer working remotely for a Paris studio",
    city: "Brussels",
    home: { lat: 50.8275, lon: 4.372 }, // Ixelles, by the ponds
    devices: ["laptop", "mobile"],
    style: "completionist",
    secondaryStyle: "trader",
    skill: 0.6,
    riskTolerance: 0.35,
    spendingPerWeek: 250,
    needs: [
      "full-tracker: a filterable dex and achievement tracker with a % to 100",
      "no-missables: nothing permanently missable",
      "fair-catch-up: missing entries obtainable at fair prices",
      "consistent-ui: the same pattern for the same action everywhere",
    ],
    goals: [
      "dex-100: 100% of the archetype dex",
      "season-sweep: every achievement before the season ends",
      "kinds-by-elements: all 6 body kinds in all 14 elements",
    ],
    frustrations: [
      "unobtainable-entries: region-locked or retired entries",
      "missable-content: time-limited content that never returns",
      "inconsistent-ui: hidden counters and inconsistent controls",
      "paid-random-eggs: paid random eggs (treated as gambling in Belgium)",
    ],
    schedule: [
      blk(WEEKDAYS, 0, 7.5, "sleep", null, false, 0),
      blk(WEEKDAYS, 7.5, 8.5, "walk", "mobile", true, 0.5), // coffee walk round the Ixelles ponds
      blk(WEEKDAYS, 9, 12.5, "work", "laptop", false, 0.15), // the game idles in a tab: idle presence
      blk(WEEKDAYS, 12.5, 13.5, "lunch", "mobile", true, 0.5),
      blk(WEEKDAYS, 13.5, 18, "work", "laptop", false, 0.15),
      blk([1, 3], 18.5, 19.5, "gym", "mobile", true, 0.1), // climbing gym
      blk([0, 1, 2, 3], 20, 23, "sofa", "laptop", false, 0.8),
      blk([0, 1, 2, 3, 6], 23.5, 24, "sleep", null, false, 0),
      blk([4, 5], 20, 24, "sofa", "laptop", false, 0.8),
      blk([5, 6], 0, 1, "sofa", "laptop", false, 0.6),
      blk([5], 1, 9, "sleep", null, false, 0),
      blk([5], 10, 12, "shopping", "mobile", true, 0.4),
      blk([5], 14, 18, "social", "mobile", true, 0.5), // train to Lille to see Camille
      blk([6], 1, 9.5, "sleep", null, false, 0),
      blk([6], 11, 13, "walk", "mobile", true, 0.6), // Bois de la Cambre
      blk([6], 15, 19, "sofa", "laptop", false, 0.9), // the weekly catalogue session
      blk([6], 21, 23, "sofa", "laptop", false, 0.5),
    ],
    favoriteElements: ["ice", "metal", "poison"],
    favoriteMoves: ["iceShard", "cryoBeam", "frostGround", "steelSpike", "corrosion"],
    dietPerDay: {
      greens: 1.5,
      berries: 1,
      coffeeBean: 2,
      fish: 0.5,
      seaweed: 0.5,
      glowFruit: 0.3,
      ashRoot: 0.2,
    },
    experiencesPerWeek: { climbing: 2, travelKm: 20, questDone: 15, puzzle: 10, flightTime: 3, swimming: 1 },
    socialCircle: ["max", "camille", "karim"],
    teamPreference: "balanced",
    achievementTargets: [
      "dex-100-pct",
      "season-all-achievements",
      "every-food-fed",
      "every-experience-logged",
    ],
    pokedexGoal: 1176,
    sessionLengthMin: [20, 180],
  },
  {
    id: "yanis",
    name: "Yanis Benali",
    age: 27,
    job: "Professional triathlete: lake swims, bike and run loops, gym strength; cousin of Inès",
    city: "Annecy",
    home: { lat: 45.903, lon: 6.142 }, // by the lake, Annecy-le-Vieux side
    devices: ["mobile", "laptop"],
    style: "territorial",
    secondaryStyle: "competitor",
    skill: 0.55,
    riskTolerance: 0.65,
    spendingPerWeek: 100,
    needs: [
      "glanceable-gps: play while running or riding, with audio cues and no stopping",
      "sport-speeds: running at 18 km/h or riding at 35 km/h is not cheating",
      "loop-territories: territories along his real training loops",
      "recovery-content: sofa content for rest days",
    ],
    goals: [
      "hold-the-shore: hold the Lake Annecy shoreline all season",
      "training-to-might: turn his training volume into a mighty Genemon",
      "beat-cousin: beat his cousin Inès with a territory-buffed team",
    ],
    frustrations: [
      "speed-flag: anti-cheat flags at cycling speed",
      "must-stop-to-tap: having to stop and tap mid-interval",
      "offline-territory-loss: territories taken while he sleeps (lights out at 21:30)",
      "battery-drain: GPS emptying the phone on a four-hour ride",
    ],
    schedule: [
      blk([0], 0, 7.5, "sleep", null, false, 0),
      blk([1, 2, 3, 4, 5], 0, 6, "sleep", null, false, 0),
      blk([6], 0, 6.5, "sleep", null, false, 0),
      blk([0], 9, 11, "walk", "mobile", true, 0.5), // Monday = rest day: recovery walk on the shore
      blk([0], 14, 18, "sofa", "laptop", false, 0.7),
      blk([1, 2, 3, 4, 5], 6.5, 8, "gym", "mobile", true, 0.1), // open-water swim: check-in only
      blk([1, 2, 3, 4, 5], 9, 12, "gym", "mobile", true, 0.3), // bike/run intervals round the lake
      blk([1, 2, 3, 4, 5], 12.5, 13.5, "lunch", "mobile", false, 0.5),
      blk([1, 2, 3, 4, 5], 13.5, 15, "sleep", null, false, 0), // nap
      blk([1, 2, 3, 4, 5], 15.5, 17.5, "gym", "mobile", true, 0.3), // strength + run
      blk([1, 2, 3, 4, 5], 18, 19, "sofa", "laptop", false, 0.5),
      blk([6], 7, 12, "gym", "mobile", true, 0.4), // long ride, ~120 km
      blk([6], 13, 15, "lunch", null, false, 0),
      blk([6], 16, 19, "sofa", "laptop", false, 0.7),
      blk(EVERY_DAY, 19.5, 21, "sofa", "mobile", false, 0.6), // territory defence before lights out
      blk(EVERY_DAY, 21.5, 24, "sleep", null, false, 0),
    ],
    favoriteElements: ["earth", "air", "water"],
    favoriteMoves: ["boulderCrush", "stoneWall", "tornado", "tideSlam", "stomp"],
    dietPerDay: { meat: 1.5, fish: 1, greens: 2, berries: 1, honey: 1, minerals: 1 },
    experiencesPerWeek: { gymTraining: 6, swimming: 5, travelKm: 250, climbing: 1, sunbathing: 2 },
    socialCircle: ["ines", "karim"],
    teamPreference: "big",
    achievementTargets: [
      "hold-shore-90-days",
      "travel-10000-km",
      "gym-100-sessions",
      "territory-defended-500",
    ],
    pokedexGoal: 70,
    sessionLengthMin: [3, 45],
  },
];

const BY_ID: ReadonlyMap<string, Persona> = new Map(PERSONAS.map((p) => [p.id, p]));

export function personaById(id: string): Persona | undefined {
  return BY_ID.get(id);
}

/**
 * The persona's PLAY blocks (playIntensity > 0) on one weekday (0=Mon..6=Sun), sorted by start.
 * Converting a calendar date to a weekday is the caller's job; any other number returns [].
 */
export function playBlocks(p: Persona, day: number): ScheduleBlock[] {
  const blocks = p.schedule.filter((b) => b.playIntensity > 0 && b.days.includes(day));
  return blocks.sort((a, b) => a.start - b.start);
}
