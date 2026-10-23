/**
 * EVOLUTION PLANS [P6-E1..E5]: how a LINEAGE changes over its life. Pure, deterministic from the genome
 * alone (nature): the same genome always gets the same plan, legacy saves included (the plan reads the
 * seeds, the kind and the genetic axes; it never writes to the genome and never changes its id).
 *
 *   static        ~12 %: ONE phase, never changes form (still levels up)
 *   gradual       ~70 %: 2..6 phases, each bigger, unlocking parts (longer neck, bigger wings, arms...)
 *   metamorphosis  ~9 %: larva -> cocoon (cannot fight, cannot breed, shrinks) -> imago (a new form) [-> prime]
 *   molt           ~9 %: grows a shell, SHEDS it at a phase (armorShed: -defence, +speed), may regrow it
 *
 * Phase count over the whole population: 1..6, median 3, 6 rare (~3 %). Trait tendencies make the plan
 * heritable in spirit (hexapods lean to metamorphosis, hard bodies to molts, methodical blobs to static
 * forms; fast metabolisms to short XP curves, big statures to long ones) while a seeded draw decides.
 *
 * XP curves [P6-E2]: "short" (many short levels, xpMult 0.7), "normal", "long" (few long levels, xpMult 1.45,
 * max level 80). The geometric-mean multiplier over the population is ~1, and combat power still follows
 * the displayed level [SPEC B1], so the median power per level bracket does not drift (measured, see
 * docs/EVIDENCE.md pass-6 evolution lane).
 *
 * Sizes: `sizeMult` is 1 at the phase a lineage is in at the REFERENCE ADULT (level 20, 60 days, the same
 * reference the life clock uses), smaller before, slightly bigger after; so the reference adult keeps its
 * pass-5 size class exactly and later phases grow it a little (expected growth).
 */
import { complexityOf } from "./complexity.ts";
import { clamp01, r3, u01 } from "../core/math.ts";
import { hashSeed, Rng } from "../core/rng.ts";
import { type Conditions, levelOf as baseLevelOf, xpForLevel as baseXpForLevel } from "./epigenetics.ts";
import { type BodyKind, geneticAxes, type Genome } from "./genome.ts";
import type { EvolutionKind, EvolutionPlan, EvoState, MorphUnlock, PhaseDef, PhaseForm } from "./p6Types.ts";

export type XpCurve = EvolutionPlan["curve"];
export const XP_CURVES: Record<XpCurve, { xpMult: number; maxLevel: number; label: string }> = {
  short: { xpMult: 0.7, maxLevel: 100, label: "short levels" },
  normal: { xpMult: 1, maxLevel: 100, label: "normal levels" },
  long: { xpMult: 1.45, maxLevel: 80, label: "long levels" },
};

/** The reference adult (lifeclock.lifeRef): sizeMult = 1 at the phase active at this level and age. */
export const REF_LEVEL = 20;
export const REF_AGE_DAYS = 60;

/** Forms that are grown-up (achievements "coming of age", fertility defaults). */
export const MATURE_FORMS: readonly PhaseForm[] = ["adult", "prime", "elder", "imago"];

/** Plain words for each unlock (evolution path, sheet, ledger). */
export const UNLOCK_WORDS: Record<MorphUnlock, string> = {
  "neck+": "neck grows longer",
  "wings+": "wings grow bigger",
  "wingPair+": "an extra pair of wings",
  "arms+": "arms grow stronger",
  "armPair+": "an extra pair of arms",
  "fingers+": "more fingers on each hand",
  "tail+": "a longer tail",
  "horns+": "horns grow",
  "armor+": "armour plates thicken: +defence",
  "armorShed": "sheds its shell: -defence, +speed",
  "eyes+": "more eyes",
  "mouth+": "a second mouth",
  "tentacles+": "more tentacles",
  "size+": "grows bigger",
};

export const KIND_WORDS: Record<EvolutionKind, string> = {
  static: "Static: one form for life",
  gradual: "Gradual growth",
  metamorphosis: "Metamorphosis: larva → cocoon → imago",
  molt: "Molt: sheds its armour",
};

// ------------------------------------------------------------------ tendencies (calibrated over 20 000 wild genomes)
const W_STATIC: Record<BodyKind, number> = { blob: 1.8, serpent: 1, quadruped: 0.85, biped: 0.85, hexapod: 0.7, avian: 0.85 };
const W_META: Record<BodyKind, number> = { hexapod: 2.4, serpent: 1.3, avian: 1.1, blob: 1, biped: 0.5, quadruped: 0.4 };
const W_MOLT: Record<BodyKind, number> = { hexapod: 1.6, serpent: 1.3, quadruped: 1, biped: 0.7, avian: 0.4, blob: 0.3 };
/** Base weights (gradual = 1); tuned so the shares land at static ~12 %, metamorphosis ~9 %, molt ~9 %. */
export const KIND_BASE = { static: 0.168, metamorphosis: 0.124, molt: 0.142 };
/** Phase-count weights for gradual (2..6) and molt (2..5) lineages; metamorphosis = 3 (60 %) or 4. */
const GRADUAL_N = [0.24, 0.4, 0.22, 0.1, 0.04];
const MOLT_N = [0.25, 0.4, 0.25, 0.1];

const UNLOCK_POOL: Record<BodyKind, [MorphUnlock, number][]> = {
  quadruped: [["neck+", 3], ["horns+", 3], ["tail+", 2], ["armor+", 1.5], ["fingers+", 0.5], ["eyes+", 0.5]],
  biped: [["arms+", 3], ["fingers+", 2.5], ["horns+", 2], ["tail+", 1], ["armPair+", 0.6], ["neck+", 0.8]],
  hexapod: [["armPair+", 1.5], ["armor+", 2.5], ["eyes+", 2], ["wings+", 1], ["horns+", 1.5], ["wingPair+", 0.6]],
  serpent: [["tail+", 3], ["horns+", 2], ["neck+", 2], ["armor+", 1], ["wingPair+", 0.4], ["eyes+", 0.6]],
  avian: [["wings+", 3.5], ["neck+", 2], ["tail+", 2], ["wingPair+", 0.7], ["horns+", 0.6]],
  blob: [["tentacles+", 3], ["eyes+", 2.5], ["mouth+", 0.8], ["arms+", 1], ["horns+", 0.5]],
};
/** Unlocks that can only happen once per plan (counts in p6Types BodyCounts stay in range). */
const ONCE: readonly MorphUnlock[] = ["wingPair+", "armPair+", "mouth+"];

const GRADUAL_NAMES: Record<number, [string, PhaseForm][]> = {
  2: [["Juvenile", "juvenile"], ["Adult", "adult"]],
  3: [["Juvenile", "juvenile"], ["Adult", "adult"], ["Prime", "prime"]],
  4: [["Hatchling", "juvenile"], ["Juvenile", "juvenile"], ["Adult", "adult"], ["Prime", "prime"]],
  5: [["Hatchling", "juvenile"], ["Juvenile", "juvenile"], ["Adult", "adult"], ["Prime", "prime"], ["Ascended", "elder"]],
  6: [["Hatchling", "juvenile"], ["Juvenile", "juvenile"], ["Subadult", "juvenile"], ["Adult", "adult"], ["Prime", "prime"], ["Ascended", "elder"]],
};

interface Draft {
  name: string;
  form: PhaseForm;
  atLevel: number;
  atAgeDays: number;
  unlocks: MorphUnlock[];
  fertile: boolean;
  /** Raw size relative to phase 1 (normalised to the reference phase at the end). */
  raw: number;
}

/** Level / age thresholds of phases 2..n (both strictly increasing). */
function schedule(rng: Rng, n: number, ageK: number): { lv: number[]; age: number[] } {
  const lv = [1], age = [0];
  for (let i = 1; i < n; i++) {
    lv.push(lv[i - 1] + (i === 1 ? rng.int(6, 13) : rng.int(6, 11)));
    age.push(r3(age[i - 1] + (i === 1 ? rng.range(5, 14) : rng.range(8, 22)) * ageK));
  }
  return { lv, age };
}

function activeIndex(lv: readonly number[], age: readonly number[], level: number, ageDays: number): number {
  let k = 0;
  for (let i = 0; i < lv.length; i++) if (level >= lv[i] && ageDays >= age[i]) k = i;
  return k;
}

function pickUnlocks(rng: Rng, kind: BodyKind, used: Set<MorphUnlock>): MorphUnlock[] {
  const pool = UNLOCK_POOL[kind].filter(([u]) => !(ONCE.includes(u) && used.has(u)));
  const n = rng.chance(0.4) ? 2 : 1;
  const out: MorphUnlock[] = [];
  for (let i = 0; i < n; i++) {
    const left = pool.filter(([u]) => !out.includes(u));
    if (!left.length) break;
    const u = rng.weighted(left.map(([x]) => x), left.map(([, w]) => w));
    out.push(u);
    used.add(u);
  }
  return out;
}

/** Monotone growth: steps before the reference phase are larger than after it (adult size class stable). */
function grow(drafts: Draft[], rng: Rng, refIdx: number, pre: [number, number], post: [number, number]): void {
  for (let i = 1; i < drafts.length; i++) {
    const step = i <= refIdx ? rng.range(pre[0], pre[1]) : rng.range(post[0], post[1]);
    drafts[i].raw = drafts[i - 1].raw * (1 + step);
    if (step >= 0.06 && !drafts[i].unlocks.includes("size+")) drafts[i].unlocks.push("size+");
  }
}

const planCache = new Map<string, EvolutionPlan>();

/** The lineage's evolution plan: deterministic from the genome (seeds, kind, genetic axes). */
export function evolutionPlanOf(g: Genome): EvolutionPlan {
  const key = `${g.id}|${g.seeds.genotype}|${g.seeds.environment}|${g.kind}`;
  const hit = planCache.get(key);
  if (hit) return hit;
  const plan = buildPlan(g);
  if (planCache.size > 4000) planCache.clear();
  planCache.set(key, plan);
  return plan;
}

function buildPlan(g: Genome): EvolutionPlan {
  const minimal = complexityOf(g).tier === "minimal";
  const rng = new Rng(hashSeed(g.seeds.genotype, g.seeds.environment, "evo-plan"));
  const ax = geneticAxes(g);
  const k = g.kind;
  const stature01 = u01(ax.stature), tempo01 = u01(ax.tempo), hard01 = u01(ax.hardness);
  const ageK = 0.85 + 0.4 * stature01;

  // ---- kind
  const kinds: EvolutionKind[] = ["static", "gradual", "metamorphosis", "molt"];
  const kindW = [
    KIND_BASE.static * W_STATIC[k] * (0.5 + u01(ax.structure)),
    1,
    KIND_BASE.metamorphosis * W_META[k] * (0.6 + 0.8 * u01(ax.altitude)),
    KIND_BASE.molt * W_MOLT[k] * (0.3 + 1.4 * hard01),
  ];
  const drawn = rng.weighted(kinds, kindW);
  // A minimal globe has no armour to shed and no wings to unfold: it is static or a plain grower.
  const kind: EvolutionKind = minimal && (drawn === "molt" || drawn === "metamorphosis") ? "gradual" : drawn;

  // ---- XP curve (fast metabolisms level in short steps, big statures in long ones)
  const curve = rng.weighted<XpCurve>(["short", "normal", "long"], [1 + 1.2 * (tempo01 - 0.5), 2, 1 + 1.2 * (stature01 - 0.5)]);

  const drafts: Draft[] = [];
  const used = new Set<MorphUnlock>();
  if (kind === "static") {
    drafts.push({ name: "Adult", form: "adult", atLevel: 1, atAgeDays: 0, unlocks: [], fertile: true, raw: 1 });
  } else if (kind === "gradual") {
    const n = rng.weighted([2, 3, 4, 5, 6], GRADUAL_N);
    const { lv, age } = schedule(rng, n, ageK);
    GRADUAL_NAMES[n].forEach(([name, form], i) =>
      drafts.push({ name, form, atLevel: lv[i], atAgeDays: age[i], unlocks: i === 0 ? [] : pickUnlocks(rng, k, used), fertile: MATURE_FORMS.includes(form), raw: 1 })
    );
    grow(drafts, rng, activeIndex(lv, age, REF_LEVEL, REF_AGE_DAYS), [0.04, 0.1], [0.02, 0.05]);
  } else if (kind === "metamorphosis") {
    const lc = rng.int(8, 14);
    const ac = r3(rng.range(8, 18) * ageK);
    const ai = r3(ac + rng.range(3, 7));
    const wingy = k === "hexapod" || k === "avian" || (k === "serpent" && rng.chance(0.6)) || (k === "blob" && rng.chance(0.4)) || rng.chance(0.25);
    const imagoUnlocks: MorphUnlock[] = wingy ? ["wingPair+", "wings+"] : k === "blob" ? ["tentacles+", "eyes+"] : ["arms+", "horns+"];
    imagoUnlocks.push("size+");
    // The cocoon shrinks (the larva digests itself), the imago is bigger than the larva ever was.
    const larvaRaw = 1, cocoonRaw = rng.range(0.85, 0.93), imagoRaw = rng.range(1.15, 1.3);
    drafts.push({ name: "Larva", form: "larva", atLevel: 1, atAgeDays: 0, unlocks: [], fertile: false, raw: larvaRaw });
    // Imago needs AGE only beyond the cocoon (same level): a cocoon cannot fight, so it could never earn the XP.
    drafts.push({ name: "Cocoon", form: "cocoon", atLevel: lc, atAgeDays: ac, unlocks: [], fertile: false, raw: cocoonRaw });
    drafts.push({ name: "Imago", form: "imago", atLevel: lc, atAgeDays: ai, unlocks: imagoUnlocks, fertile: true, raw: imagoRaw });
    if (rng.chance(0.4)) {
      const lp = lc + rng.int(8, 14), ap = r3(ai + rng.range(15, 35) * ageK);
      drafts.push({ name: "Prime imago", form: "prime", atLevel: lp, atAgeDays: ap, unlocks: [wingy ? "wings+" : "horns+"], fertile: true, raw: imagoRaw * (1 + rng.range(0.02, 0.05)) });
    }
  } else {
    const n = rng.weighted([2, 3, 4, 5], MOLT_N);
    const { lv, age } = schedule(rng, n, ageK);
    const base: [string, PhaseForm, MorphUnlock[], boolean][] = n === 2
      ? [["Shelled", "juvenile", ["armor+"], false], ["Molted", "adult", ["armorShed"], true]]
      : [["Juvenile", "juvenile", [], false], ["Armoured", "adult", ["armor+"], true], ["Molting", "molting", ["armorShed"], false], ["Regrown", "prime", ["armor+"], true], ["Ancient shell", "elder", ["armor+", "horns+"], true]];
    if (n === 3) base[2] = ["Molted", "prime", ["armorShed"], true];
    for (let i = 0; i < n; i++) {
      const [name, form, unlocks, fertile] = base[i];
      drafts.push({ name, form, atLevel: lv[i], atAgeDays: age[i], unlocks: [...unlocks], fertile, raw: 1 });
    }
    grow(drafts, rng, activeIndex(lv, age, REF_LEVEL, REF_AGE_DAYS), [0.04, 0.1], [0.02, 0.05]);
  }

  const refIdx = activeIndex(drafts.map((d) => d.atLevel), drafts.map((d) => d.atAgeDays), REF_LEVEL, REF_AGE_DAYS);
  const refRaw = drafts[refIdx].raw;
  const phases: PhaseDef[] = drafts.map((d, i) => ({
    index: i + 1,
    name: d.name,
    form: d.form,
    atLevel: d.atLevel,
    atAgeDays: d.atAgeDays,
    sizeMult: i === refIdx ? 1 : r3(d.raw / refRaw),
    // Pass 6 [P6-C1]: a minimal globe stays a globe: it may grow (size+) but never gains parts.
    unlocks: minimal ? d.unlocks.filter((u) => u === "size+") : d.unlocks,
    fertile: d.fertile,
  }));

  // ---- fertility: windows of `fertileDays` every `cycleDays`, the first opening at `offsetDays`
  // (static lineages: maturity age; others: the first fertile phase's age plus a seeded offset).
  const cycleDays = r3(rng.range(6, 14));
  const fertileDays = r3(cycleDays * rng.range(0.3, 0.45));
  const firstFertile = phases.find((p) => p.fertile);
  const offsetDays = r3((kind === "static" ? rng.range(6, 12) * ageK : (firstFertile?.atAgeDays ?? 0)) + rng.range(0, 0.5 * cycleDays));
  const c = XP_CURVES[curve];
  return { kind, phases, curve, xpMult: c.xpMult, maxLevel: c.maxLevel, fertility: { cycleDays, fertileDays, offsetDays } };
}

// ------------------------------------------------------------------ level curve
/** The lineage's XP curve; levelOf(xpForLevel(n)) === n for every n in 1..maxLevel. */
export function levelCurve(plan: EvolutionPlan): { xpForLevel(level: number): number; levelOf(xp: number): number } {
  return {
    xpForLevel: (level: number) => baseXpForLevel(Math.min(level, plan.maxLevel), plan.xpMult),
    levelOf: (xp: number) => baseLevelOf(xp, plan.xpMult, plan.maxLevel),
  };
}

/** Continuous level (for progress bars): 1 + cbrt(xp / (8 xpMult)), capped at maxLevel. */
export function levelFloat(plan: EvolutionPlan, xp: number): number {
  return Math.min(plan.maxLevel, 1 + Math.cbrt(Math.max(0, xp) / (8 * plan.xpMult)));
}

// ------------------------------------------------------------------ expressed state
/** Index (0-based) of the phase reached at this level AND age. Monotone in both. */
export function phaseIndexAt(plan: EvolutionPlan, level: number, ageDays: number): number {
  let k = 0;
  plan.phases.forEach((p, i) => {
    if (level >= p.atLevel && ageDays >= p.atAgeDays) k = i;
  });
  return k;
}

/** Cumulative unlocks from phase 1 to phase `index` (1-based) included. */
export function unlocksUpTo(plan: EvolutionPlan, index: number): MorphUnlock[] {
  return plan.phases.slice(0, Math.max(1, index)).flatMap((p) => p.unlocks);
}

export function phaseOf(plan: EvolutionPlan, level: number, ageDays: number, c: Conditions): EvoState {
  const i = phaseIndexAt(plan, level, ageDays);
  const cur = plan.phases[i], next = plan.phases[i + 1];
  let progress = 1;
  if (next) {
    const lf = Math.max(level, Math.min(level + 0.999, levelFloat(plan, c.xp)));
    const pl = next.atLevel > cur.atLevel ? clamp01((lf - cur.atLevel) / (next.atLevel - cur.atLevel)) : 1;
    const pa = next.atAgeDays > cur.atAgeDays ? clamp01((ageDays - cur.atAgeDays) / (next.atAgeDays - cur.atAgeDays)) : 1;
    progress = r3(Math.min(pl, pa));
  }
  const curve = levelCurve(plan);
  return {
    phase: cur.index,
    phases: plan.phases.length,
    form: cur.form,
    name: cur.name,
    kind: plan.kind,
    unlocks: unlocksUpTo(plan, cur.index),
    sizeMult: cur.sizeMult,
    progress,
    level,
    xpToNext: level >= plan.maxLevel ? 0 : Math.max(0, curve.xpForLevel(level + 1) - c.xp),
  };
}

// ------------------------------------------------------------------ fertility [P6-E5]
const mod = (a: number, m: number) => ((a % m) + m) % m;

/** Start (age, days) of the first fertility window opening at or after `day`. */
export function windowAtOrAfter(plan: EvolutionPlan, day: number): number {
  const f = plan.fertility;
  if (day <= f.offsetDays) return f.offsetDays;
  const pos = mod(day - f.offsetDays, f.cycleDays);
  return pos < 1e-9 || f.cycleDays - pos < 1e-9 ? day : day + f.cycleDays - pos;
}

/**
 * Can this lineage breed now? Needs a fertile phase (not a larva, cocoon, molting or juvenile form), maturity
 * (age >= offsetDays) and an open window of the cycle. `nextWindowDay` = the age at which the NEXT window opens
 * (when fertile now: the one after the current window; null when no later phase is ever fertile).
 * `until` = the age at which the current window closes (fertile only).
 */
export function fertileNow(plan: EvolutionPlan, phase: number, ageDays: number): { fertile: boolean; why: string; nextWindowDay: number | null; until: number | null } {
  const f = plan.fertility;
  const p = plan.phases[Math.max(0, Math.min(plan.phases.length - 1, phase - 1))];
  const days = (d: number) => `${Math.round(d * 10) / 10}`;
  if (!p.fertile) {
    const later = plan.phases.find((q) => q.index > p.index && q.fertile);
    const why = p.form === "cocoon" ? "cocoon: cannot breed until it emerges" : p.form === "molting" ? "molting: too vulnerable to breed" : `${p.name.toLowerCase()}: too young to breed`;
    if (!later) return { fertile: false, why: `${why}; no fertile phase ahead`, nextWindowDay: null, until: null };
    return {
      fertile: false,
      why: `${why} (fertile from ${later.name}: level ${later.atLevel}, day ${days(later.atAgeDays)})`,
      nextWindowDay: windowAtOrAfter(plan, Math.max(ageDays, later.atAgeDays)),
      until: null,
    };
  }
  if (ageDays < f.offsetDays) return { fertile: false, why: `not mature yet: first fertile window at day ${days(f.offsetDays)}`, nextWindowDay: f.offsetDays, until: null };
  let pos = mod(ageDays - f.offsetDays, f.cycleDays);
  if (f.cycleDays - pos < 1e-9) pos = 0; // floating guard: exactly at a window's start
  const start = ageDays - pos;
  if (pos < f.fertileDays - 1e-9) {
    return { fertile: true, why: `fertile window open for ${days(f.fertileDays - pos)} more day(s)`, nextWindowDay: start + f.cycleDays, until: start + f.fertileDays };
  }
  const next = start + f.cycleDays;
  return { fertile: false, why: `between fertility windows: the next opens on day ${days(next)} (in ${days(next - ageDays)} d)`, nextWindowDay: next, until: null };
}

/** One-line summary: "Metamorphosis · 3 phases · long levels". */
export function planSummary(plan: EvolutionPlan): string {
  const kind = plan.kind === "static" ? "Static" : plan.kind === "gradual" ? "Gradual" : plan.kind === "metamorphosis" ? "Metamorphosis" : "Molt";
  return `${kind} · ${plan.phases.length} phase${plan.phases.length > 1 ? "s" : ""} · ${XP_CURVES[plan.curve].label}`;
}
