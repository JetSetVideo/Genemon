/**
 * The Genemon PROFILE SHEET [P5-U3] - the Lab's default tab. One scrollable page with a table of
 * contents (every part is at most 2 clicks from the Lab: open Lab -> click a TOC chip): identity (name,
 * elements, size, age + life phase, parents), story (a narrative generated from the creature's own
 * record), character, statistics, attacks (the Q/W/E/R kit as move cards), associated objects (gear,
 * cosmetics, imprints), senses + resonance, digestion, scars and the evolution plan [P6-E1..E5]: kind, the
 * phases as a timeline (forms, unlocks, costs), the XP bar on the lineage's curve and the fertility window.
 * Section titles sit on shaded bands, one shade per family (widgets.sec, CSS .ui5-f-*) [P5-U4].
 */
import type { App } from "./app.ts";
import { ELEMENTS, type ElementId } from "../data/elements.ts";
import { EXPERIENCES, type ExperienceId, FOODS, type FoodId } from "../data/lifestyle.ts";
import { fertilityOf, type Genemon, phenotypeOf, STAGE_NAMES, stageName } from "../genome/genemon.ts";
import { evolutionPlanOf, KIND_WORDS, levelCurve, planSummary, XP_CURVES } from "../genome/evolution.ts";
import { evolutionPath, lifePath } from "../genome/lifeclock.ts";
import { type LifePhase, SENSE_IDS } from "../genome/lifeTypes.ts";
import type { Phenotype } from "../genome/phenotype.ts";
import { foodItemId, ITEMS } from "../economy/items.ts";
import { bar, fmt, h, hex } from "./dom.ts";
import { barRow, elChip, sec, statBars, statsBlock } from "./widgets.ts";
import { kitMoves, kitStrip } from "./moveCard.ts";
import { iconChip, itemIcon } from "./icons.ts";
import { cosmeticsOf, gearOf, takeOff, unequip } from "./bagStore.ts";
import { canRankOf, digestionFor, dietClassOf, fullnessOf, imprintsFor, lifePhaseOf, scarsFor, sensesFor } from "./lifeAdapter.ts";

const NA = (what: string) => h("p", { class: "muted ui5-na" }, `${what}: not available yet.`);

/** Guarded producer call (same contract as lifeAdapter.safe): a throwing module shows "not available". */
function safe<T>(f: () => T): T | null {
  try {
    return f();
  } catch (e) {
    console.warn("sheet:", e);
    return null;
  }
}

const TOC: readonly { id: string; label: string }[] = [
  { id: "sh-story", label: "Story" },
  { id: "sh-character", label: "Character" },
  { id: "sh-stats", label: "Stats" },
  { id: "sh-attacks", label: "Attacks" },
  { id: "sh-objects", label: "Objects" },
  { id: "sh-senses", label: "Senses" },
  { id: "sh-digestion", label: "Digestion" },
  { id: "sh-scars", label: "Scars" },
  { id: "sh-evolution", label: "Evolution" },
];

function elName(e: string): string {
  return ELEMENTS[e as ElementId]?.name ?? e;
}

function top<K extends string>(rec: Partial<Record<K, number>>, n: number): [K, number][] {
  return (Object.entries(rec) as [K, number][]).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, n);
}

function list(words: readonly string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/** Parents: lineage holds genome ids; resolve them to Genemon of the collection (null = not owned). */
export function parentsOf(app: App, g: Genemon): { genomeId: string; g: Genemon | null }[] {
  return g.genome.lineage.map((id) => ({ genomeId: id, g: app.profile.collection.find((x) => x.genome.id === id) ?? null }));
}

/** The generated narrative, one paragraph per theme (origin, life, diet, fights, marks, notable rows). */
export function storyOf(app: App, g: Genemon, ph: Phenotype = phenotypeOf(g)): string[] {
  const c = g.conditions;
  const out: string[] = [];
  const parents = parentsOf(app, g);
  const el = `${elName(ph.elements.primary)}${ph.elements.secondary ? `/${elName(ph.elements.secondary)}` : ""}`;
  if (parents.length >= 2) {
    const names = parents.map((p) => p.g?.name ?? `a creature of genome ${p.genomeId}`);
    out.push(`${g.name} is a ${el} ${ph.kind} of generation ${g.genome.generation}, born from ${list(names)}.${g.genome.mutations.length ? ` It carries ${g.genome.mutations.length} mutation${g.genome.mutations.length > 1 ? "s" : ""} (${g.genome.mutations.slice(0, 3).join(", ")}).` : " No mutation touched its genes."}`);
  } else {
    out.push(`${g.name} is a wild-type ${el} ${ph.kind}: its genome came straight from the wild (generation ${g.genome.generation}).${g.genome.mutations.length ? ` ${g.genome.mutations.length} mutation(s) since.` : ""}`);
  }
  const lp = lifePhaseOf(g);
  out.push(`It is ${fmt(c.ageDays, 1)} days old${lp ? `, a ${lp.phase}` : ""}, level ${ph.level}, ${fmt(ph.heightM, 2)} m tall. By nature it is ${list(ph.psyche.character.slice(0, 3)) || "hard to read"}; its bond with you is ${c.bond >= 0.6 ? "strong" : c.bond >= 0.3 ? "growing" : "still fragile"} (${fmt(c.bond, 2)}).`);
  const meals = Object.values(c.diet).reduce((s: number, v) => s + (v ?? 0), 0);
  const foods = top<FoodId>(c.diet, 3);
  out.push(meals > 0
    ? `It has eaten ${fmt(meals)} portions, mostly ${list(foods.map(([f, n]) => `${FOODS[f]?.name ?? f} (${fmt(n)})`))}. ${c.hunger > 0.6 ? "Right now it is hungry." : c.hunger < 0.15 ? "Right now it is well fed." : ""}`
    : `Nobody has fed it by hand yet${c.hunger > 0.5 ? ", and it is hungry" : ""}.`);
  const exps = top<ExperienceId>(c.experiences, 2), places = top(c.exposure, 2);
  if (exps.length || places.length) {
    out.push(`${exps.length ? `It learned through ${list(exps.map(([e, n]) => `${EXPERIENCES[e]?.name ?? e} ×${fmt(n)}`))}. ` : ""}${places.length ? `It spent most of its time on ${list(places.map(([p, n]) => `${p} (${fmt(n)} h)`))}.` : ""}`);
  }
  const b = c.battles, fights = b.won + b.lost + b.draws;
  const hurt = top(b.damageTakenBy, 1)[0];
  out.push(fights > 0
    ? `In ${fights} battle${fights > 1 ? "s" : ""} it won ${b.won}, lost ${b.lost}${b.draws ? ` and drew ${b.draws}` : ""}, knocking out ${b.kos} opponent${b.kos === 1 ? "" : "s"}.${hurt ? ` ${elName(hurt[0])} moves hurt it most (${fmt(hurt[1])} damage taken).` : ""}`
    : "It has never fought.");
  const scars = scarsFor(g);
  if (scars.length) {
    const worst = scars.reduce((a, x) => (x.severity > a.severity ? x : a));
    out.push(`It carries ${scars.length} scar${scars.length > 1 ? "s" : ""}; the worst, on its ${worst.part}, came from a ${worst.from} hit on day ${fmt(worst.atDay, 0)}.`);
  }
  const rows = app.ledger.query({ what: /^genemon\.(evolve|specialize)$/, limit: 200 }).filter((r) => r.to === g.id).slice(-3);
  for (const r of rows) {
    const when = new Date(r.when).toLocaleDateString([], { month: "short", day: "numeric" });
    out.push(r.what === "genemon.evolve"
      ? `On ${when} it evolved into its ${r.exits.name || STAGE_NAMES[Number(r.exits.toStage)] || `phase ${r.exits.toStage}`} form${r.exits.unlocks ? ` (${String(r.exits.unlocks).split(",").join(", ")})` : ""}.`
      : `On ${when} its element drifted from ${elName(String(r.entries.primary))} to ${elName(String(r.exits.primary))}.`);
  }
  return out;
}

function chipLink(label: string, onClick: () => void, title = ""): HTMLElement {
  return h("button", { class: "ui5-link", title, onclick: onClick }, label);
}

function header(app: App, g: Genemon, ph: Phenotype): HTMLElement {
  const lp = lifePhaseOf(g);
  const rank = canRankOf(g);
  const parents = parentsOf(app, g);
  const nextPhase = lp ? (Object.entries(lp.starts) as [LifePhase, number][]).find(([, d]) => d > g.conditions.ageDays) : undefined;
  return sec("id", "Identity", { id: "sh-id", extra: h("span", { class: "size", title: `${ph.slots} team slot(s)` }, `${ph.sizeClass}·${ph.slots}`) },
    h("div", { class: "row" }, h("span", { class: "ui5-swatch", vars: { sw: hex(ph.palette.base) } }), elChip(ph.elements.primary), ph.elements.secondary ? elChip(ph.elements.secondary) : null,
      h("span", { class: "chip" }, ph.kind), h("span", { class: "chip" }, `Lv ${ph.level}`), lp ? h("span", { class: "chip ui5-phase" }, lp.phase) : null,
      ph.evo ? h("span", { class: "chip", title: `evolution phase ${ph.evo.phase}/${ph.evo.phases} (${ph.evo.kind})` }, `${ph.evo.name} ${ph.evo.phase}/${ph.evo.phases}`) : null,
      rank ? h("span", { class: `chip ${rank.ok ? "" : "ui5-bad"}`, title: rank.why }, rank.ok ? "can rank" : /not born/.test(rank.why) ? "too young to rank" : "retired from ranked") : null),
    h("dl", { class: "kv" },
      h("dt", {}, "Age"), h("dd", {}, `${fmt(g.conditions.ageDays, 1)} days${lp ? ` · ${lp.phase}` : ""}${nextPhase ? ` (${nextPhase[0]} at day ${fmt(nextPhase[1], 1)})` : ""}`),
      h("dt", {}, "Stage"), h("dd", {}, `${stageName(g, ph)}${ph.evo ? ` · phase ${ph.evo.phase}/${ph.evo.phases} (${ph.evo.form})` : ""} · growth ${Math.round(ph.growth * 100)}%`),
      h("dt", {}, "Body"), h("dd", {}, `${fmt(ph.heightM, 2)} m · ${fmt(ph.massKg, 1)} kg · ${ph.pattern}`),
      h("dt", {}, "Genome"), h("dd", { class: "mono" }, `${g.genome.id} · gen ${g.genome.generation}`),
      h("dt", {}, "Parents"), h("dd", { class: "row" }, ...(parents.length
        ? parents.map((p) => p.g ? chipLink(p.g.name, () => app.select(p.g!.id), "Open this parent's sheet") : h("span", { class: "muted mono", title: "not in your collection" }, p.genomeId))
        : [h("span", { class: "muted" }, "wild-born (no parents on record)")]))),
    h("nav", { class: "ui5-toc", "aria-label": "Sheet sections" }, ...TOC.map((t) => h("button", { class: "btn small", onclick: () => document.getElementById(t.id)?.scrollIntoView({ behavior: "smooth", block: "start" }) }, t.label))));
}

function character(ph: Phenotype): HTMLElement {
  const p = ph.psyche;
  const chips = (cls: string, words: readonly string[]) => h("div", { class: "row" }, ...words.map((w) => h("span", { class: `ui5-trait ${cls}` }, w)));
  const needs = (Object.entries(p.needs) as [string, number][]).sort((a, b) => b[1] - a[1]);
  return sec("character", "Character", { id: "sh-character" },
    h("h3", {}, "Traits"), chips("", p.character),
    h("h3", {}, "Passions"), chips("pos", p.passions),
    h("h3", {}, "Fears"), p.fears.length ? chips("neg", p.fears) : h("p", { class: "muted" }, "nothing much"),
    h("h3", {}, "Envies"), chips("", p.envies),
    h("h3", {}, "Needs"), h("div", { class: "ui5-bars" }, ...needs.map(([k, v]) => barRow(k, v, `${Math.round(v * 100)}%`, "#9b5de5"))));
}

function stats(app: App, ph: Phenotype): HTMLElement {
  const ref = { hp: 0, atk: 0, def: 0, spd: 0, power: 0 };
  for (const x of app.profile.collection) {
    const q = phenotypeOf(x);
    ref.hp = Math.max(ref.hp, q.stats.hp);
    ref.atk = Math.max(ref.atk, q.stats.atk);
    ref.def = Math.max(ref.def, q.stats.def);
    ref.spd = Math.max(ref.spd, q.stats.spd);
    ref.power = Math.max(ref.power, q.power);
  }
  return sec("stats", "Statistics", { id: "sh-stats" },
    h("p", { class: "muted" }, "HP, attack, defence, speed and power bars are relative to the best of your collection."),
    statBars(ph, ref),
    h("details", { class: "ui5-more" }, h("summary", {}, "All numbers"), statsBlock(ph)));
}

function attacks(g: Genemon): HTMLElement {
  const moves = kitMoves(g.moves);
  return sec("attacks", "Attacks", { id: "sh-attacks" },
    moves.length ? kitStrip(moves) : NA("Moves"),
    h("p", { class: "muted" }, "Each move runs charge (tell) → active (strike) → rest (vulnerable)."));
}

function objects(app: App, g: Genemon): HTMLElement {
  const p = app.profile;
  const gear = gearOf(p, g.id);
  const worn = Object.entries(cosmeticsOf(p, g.id));
  const imprints = imprintsFor(g);
  const after = (msg: string) => {
    app.save();
    app.labView?.setGenemon(g);
    app.log("ui.bag.unequip", msg, g.id);
    app.render();
  };
  return sec("objects", "Associated objects", { id: "sh-objects" },
    h("h3", {}, "Held gear"),
    gear
      ? h("div", { class: "ui5-obj" }, itemIcon(gear.itemId, 36), h("div", {}, h("b", {}, ITEMS[gear.itemId]?.name ?? gear.itemId), h("span", { class: "muted" }, ` ${ITEMS[gear.itemId]?.note ?? ""}`)),
        h("button", { class: "btn small", onclick: () => unequip(p, g.id) && after("gear back to the bag") }, "Unequip"))
      : h("p", { class: "muted" }, "None. Drag a gear piece from the bag onto the 3D view."),
    h("h3", {}, "Cosmetics"),
    worn.length
      ? h("div", {}, ...worn.map(([slot, id]) => h("div", { class: "ui5-obj" }, itemIcon(id, 32), h("div", {}, h("b", {}, ITEMS[id]?.name ?? id), h("span", { class: "muted" }, ` · ${slot}`)),
        h("button", { class: "btn small", onclick: () => takeOff(p, g.id, slot) && after(`cosmetic off (${slot})`) }, "Take off"))))
      : h("p", { class: "muted" }, "Nothing worn."),
    h("h3", {}, "Imprints (pass down to offspring)"),
    imprints.length
      ? h("div", {}, ...imprints.map((im) => h("div", { class: "ui5-obj" }, ITEMS[im.itemId] ? itemIcon(im.itemId, 28) : null,
        h("div", {}, h("b", {}, `${im.trait} ${im.strength > 0 ? "+" : ""}${fmt(im.strength, 2)}`), h("span", { class: "muted" }, ` from ${ITEMS[im.itemId]?.name ?? im.itemId}${im.generation ? ` · inherited ${im.generation} gen.` : " · acquired"}`)))))
      : h("p", { class: "muted" }, "No imprint yet: objects used for a long time leave a trace in the genes."));
}

function senses(g: Genemon): HTMLElement {
  const s = sensesFor(g);
  if (!s) return sec("life", "Senses & resonance", { id: "sh-senses" }, NA("Senses"));
  const max = Math.max(...SENSE_IDS.map((k) => s.acuity[k]), 1e-9);
  return sec("life", "Senses & resonance", { id: "sh-senses" },
    h("p", { class: "muted" }, `Sees ${fmt(s.visionRange, 1)} m in a ${Math.round(s.fovHalf * 2 * 180 / Math.PI)}° field, hears ${fmt(s.hearingRange, 1)} m all around. Every sense is double-edged: a sharp organ also RESONATES with moves that travel through it.`),
    h("div", { class: "ui5-senses" }, ...SENSE_IDS.map((k) => {
      const res = s.resonance[k];
      return h("div", { class: "ui5-sense", title: `organ: ${s.organ[k]}` },
        h("span", { class: "ui5-bl" }, k), bar(s.acuity[k] / max, "#00bbf9"),
        h("span", { class: `mono ui5-res ${res > 1.05 ? "hi" : res < 0.95 ? "lo" : ""}`, title: "incoming effect multiplier through this channel" }, `×${fmt(res, 2)}`),
        h("span", { class: "muted ui5-organ" }, s.organ[k]));
    })));
}

function digestion(g: Genemon): HTMLElement {
  const dg = digestionFor(g);
  if (!dg) return sec("life", "Digestion", { id: "sh-digestion" }, NA("Digestion"));
  const { d, fresh, bloat } = dg;
  const full = fullnessOf(d);
  return sec("life", "Digestion", { id: "sh-digestion" },
    h("dl", { class: "kv" },
      h("dt", {}, "Diet"), h("dd", {}, dietClassOf(g) ?? d.diet),
      h("dt", {}, "Stomach"), h("dd", {}, `${fmt(full.units, 1)} / ${fmt(d.capacity, 1)} units${fresh ? " (life clock not started)" : ""}`),
      h("dt", {}, "Digests"), h("dd", {}, `${fmt(d.hoursPerUnit, 1)} h per unit`),
      h("dt", {}, "Bloat"), h("dd", {}, bloat > 0 ? `${Math.round(bloat * 100)}% (overfed: slow and sleepy)` : "none")),
    barRow("Fullness", Math.min(1, full.frac), `${Math.round(full.frac * 100)}%`, full.frac > 1 ? "#ff4d6d" : "#3ddc84"),
    d.stomach.length
      ? h("div", { class: "ui5-stomach" }, ...d.stomach.map((it) => h("div", { class: "ui5-obj", title: `eaten ${new Date(it.eatenAt).toLocaleString()}` },
        ITEMS[foodItemId(it.food as FoodId)] ? iconChip(foodItemId(it.food as FoodId), 28) : null,
        h("div", {}, h("b", {}, `${FOODS[it.food as FoodId]?.name ?? it.food} ×${fmt(it.units, 1)}`), h("span", { class: "muted" }, ` · ${Math.round(it.digested * 100)}% digested`)))))
      : h("p", { class: "muted" }, "The stomach is empty."));
}

function scars(g: Genemon): HTMLElement {
  const sc = scarsFor(g);
  return sec("life", `Scars · ${sc.length}`, { id: "sh-scars" },
    sc.length
      ? h("div", { class: "ui5-bars" }, ...sc.slice().sort((a, b) => b.severity - a.severity).map((x) =>
        barRow(`${x.part}${x.side < 0 ? " (L)" : " (R)"}`, x.severity, `day ${fmt(x.atDay, 0)} · ${x.from}`, x.from === "physical" ? "#a7b3c6" : hex(ELEMENTS[x.from as ElementId]?.color ?? 0xa7b3c6))))
      : h("p", { class: "muted" }, "No scars yet. Hard fights leave marks that show on the body."));
}

const CURVE_COLOR: Record<string, string> = { short: "#00bbf9", normal: "#9b5de5", long: "#f9844a" };

/** The pass-5 life stages (egg .. ancient by age), kept under the evolution plan. */
function lifeStages(g: Genemon): HTMLElement {
  const steps = safe(() => lifePath(g));
  if (!steps) return NA("Life stages");
  const cur = steps.filter((s) => s.reached).length - 1;
  return h("ol", { class: "ui5-evo" }, ...steps.map((s, i) => h("li", { class: i < cur ? "done" : i === cur ? "now" : "todo" },
    h("div", { class: "ui5-evo-head" }, h("b", {}, s.name), h("span", { class: "muted" }, i === cur ? "◀ now" : s.reached ? "✓" : "")),
    i > 0 ? h("div", { class: "ui5-cost mono" }, `${fmt(s.cost.days, 1)} d · ${fmt(s.cost.xp)} xp · ${fmt(s.cost.food)} food · ${fmt(s.cost.credits)} c · bond ${fmt(s.cost.bond, 2)}`) : null,
    h("div", { class: "muted" }, s.properties.join(" · ")))));
}

/**
 * The evolution plan [P6-E1..E5]: kind + summary, the XP bar on the lineage's curve ("long levels" / "short
 * levels"), progress to the next phase, the phases as a timeline (form, thresholds, costs, unlocks in words)
 * and the fertility window now / next. The life stages (egg .. ancient) sit in a fold below.
 */
function evolution(g: Genemon, ph: Phenotype): HTMLElement {
  const plan = safe(() => evolutionPlanOf(g.genome));
  const steps = safe(() => evolutionPath(g));
  if (!plan || !steps) return sec("evolution", "Evolution", { id: "sh-evolution" }, NA("Evolution plan"));
  const evo = ph.evo;
  const curve = levelCurve(plan);
  const c = XP_CURVES[plan.curve];
  const lvl = ph.level, xp = g.conditions.xp;
  const atMax = lvl >= plan.maxLevel;
  const x0 = curve.xpForLevel(lvl), x1 = curve.xpForLevel(lvl + 1);
  const frac = atMax ? 1 : (xp - x0) / Math.max(1, x1 - x0);
  const fert = safe(() => fertilityOf(g));
  const f = plan.fertility;
  const next = evo && evo.phase < evo.phases ? plan.phases[evo.phase] : null;
  return sec("evolution", "Evolution", { id: "sh-evolution", extra: h("span", { class: "chip", title: "evolution kind · phases · XP curve" }, planSummary(plan)) },
    h("p", { class: "muted" }, `${KIND_WORDS[plan.kind]}${plan.kind === "gradual" ? ` through ${plan.phases.length} phases, bigger at each one` : ""}. Phases need BOTH the level and the age shown; levels follow this lineage's own XP curve.`),
    h("div", { class: "row" },
      h("span", { class: "chip", title: `xp per level ×${c.xpMult} vs the global curve` }, c.label),
      h("span", { class: "chip" }, `xp ×${c.xpMult}`),
      h("span", { class: "chip" }, `max Lv ${plan.maxLevel}`)),
    barRow(`Lv ${lvl}`, frac, atMax ? "max level" : `${fmt(xp - x0)} / ${fmt(x1 - x0)} xp → Lv ${lvl + 1}`, CURVE_COLOR[plan.curve] ?? "#9b5de5",
      plan.curve === "long" ? "Long levels: few levels, each with a long XP bar" : plan.curve === "short" ? "Short levels: many quick levels" : "Normal levels"),
    next && evo
      ? barRow("Next phase", evo.progress, `${Math.round(evo.progress * 100)}% → ${next.name} (Lv ${next.atLevel}, day ${fmt(next.atAgeDays, 1)})`, "#3ddc84")
      : h("p", { class: "muted" }, plan.phases.length === 1 ? "One form for life: it never changes shape." : "Final phase reached."),
    h("h3", {}, "Phases"),
    h("ol", { class: "ui5-evo" }, ...steps.map((s) => h("li", { class: s.current ? "now" : s.reached ? "done" : "todo" },
      h("div", { class: "ui5-evo-head" }, h("b", {}, `${s.index}. ${s.name}`), h("span", { class: "chip" }, s.form),
        s.sizeMult !== 1 ? h("span", { class: "muted mono", title: "height vs the reference adult" }, `×${fmt(s.sizeMult, 2)} size`) : null,
        h("span", { class: "muted" }, s.current ? "◀ now" : s.reached ? "✓" : "")),
      s.index > 1 ? h("div", { class: "ui5-cost mono" }, `Lv ${s.atLevel} · day ${fmt(s.atAgeDays, 1)} · +${fmt(s.cost.days, 1)} d · ${fmt(s.cost.xp)} xp · ${fmt(s.cost.food)} food · ${fmt(s.cost.credits)} c`) : null,
      h("div", { class: "muted" }, s.properties.join(" · "))))),
    h("h3", {}, "Fertility"),
    h("dl", { class: "kv" },
      h("dt", {}, "Now"), h("dd", { class: fert?.fertile ? "" : "muted" }, fert ? `${fert.fertile ? "fertile: " : "not fertile: "}${fert.why}` : "not available"),
      h("dt", {}, "Next window"), h("dd", {}, fert?.nextWindowDay != null ? `day ${fmt(fert.nextWindowDay, 1)} (in ${fmt(Math.max(0, fert.nextWindowDay - g.conditions.ageDays), 1)} d)` : "none ahead"),
      h("dt", {}, "Cycle"), h("dd", {}, `fertile ${fmt(f.fertileDays, 1)} d every ${fmt(f.cycleDays, 1)} d, first window on day ${fmt(f.offsetDays, 1)}, in fertile phases only`)),
    h("details", { class: "ui5-more" }, h("summary", {}, "Life stages (egg → ancient)"), lifeStages(g)));
}

/** The full profile page of one Genemon. */
export function renderGenemonSheet(app: App, g: Genemon): HTMLElement {
  const ph = phenotypeOf(g);
  return h("div", { class: "ui5-sheet" },
    header(app, g, ph),
    sec("story", "Story", { id: "sh-story" }, ...storyOf(app, g, ph).map((t) => h("p", {}, t))),
    character(ph),
    stats(app, ph),
    attacks(g),
    objects(app, g),
    senses(g),
    digestion(g),
    scars(g),
    evolution(g, ph));
}
