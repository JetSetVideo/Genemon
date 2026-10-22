/**
 * Batch lab screen [P5-X1]: run the archetype matchup matrix and batch breeding ON THIS DEVICE.
 *   (a) Matrix: fast / powerful / clever / tank / sensory / swarm, every pair, sides swapped, win rate
 *       without draws, Wilson 95 % intervals, flags (row > 65 %, cell > 85 %), pros and cons per archetype.
 *   (b) Breed N generations from my team: tournament selection on the archetype gauntlet's win rate,
 *       Mendelian breed + mutate; the generation curve (fitness, diversity, archetype drift) and the best
 *       child joins the collection as a hatchling (same economy as the Lab's Breed button).
 *   (c) How the numbers are made: slot costs, power budgets, the power index.
 * Work runs in setTimeout slices of ~40 ms (MatrixJob / BreedJob from src/sim/batch.ts), so the UI never
 * freezes; results live in this module for the session.
 */
import type { App } from "../app.ts";
import { hashSeed } from "../../core/rng.ts";
import { createGenemon, type Genemon, phenotypeOf } from "../../genome/genemon.ts";
import { POWER_BUDGET, SIZE_CLASSES, SLOT_COST } from "../../genome/phenotype.ts";
import {
  ARCHETYPE_BY_ID,
  type ArchetypeId,
  BATCH_ARCHETYPES,
  BreedJob,
  type BreedBatchResult,
  classifyArchetype,
  DOMINANT_ROW,
  gauntletFitness,
  LOPSIDED_CELL,
  MatrixJob,
  type MatrixResult,
  MIN_FLAG_N,
} from "../../sim/batch.ts";
import { lineChart } from "../charts.ts";
import { bar, clear, h, pct, section, select, toast } from "../dom.ts";
import { teamOf } from "../profile.ts";
import { genemonCard } from "../widgets.ts";

const BUDGET_MS = 40;
const MATRIX_SIZES = ["4", "8", "16"] as const;
const GEN_OPTIONS = ["3", "5", "8"] as const;
const BREED_POP = 8;

// Module state: survives re-renders and screen changes for the session.
let matrixN: typeof MATRIX_SIZES[number] = "8";
let matrixRuns = 0;
let matrixJob: MatrixJob | null = null;
let matrixStop = false;
let matrixRes: MatrixResult | null = null;
let breedGens: typeof GEN_OPTIONS[number] = "5";
let breedRuns = 0;
let breedJob: BreedJob | null = null;
let breedStop = false;
let breedRes: BreedBatchResult | null = null;
let breedChild: Genemon | null = null;
let breedMsg = "";
let ui: { mStatus: HTMLElement; mOut: HTMLElement; mBtn: HTMLButtonElement; bStatus: HTMLElement; bOut: HTMLElement; bBtn: HTMLButtonElement } | null = null;

const label = (id: string) => ARCHETYPE_BY_ID[id as ArchetypeId]?.label ?? id;
const color = (id: string) => ARCHETYPE_BY_ID[id as ArchetypeId]?.color ?? "#a7b3c6";
const chip = (id: string) => h("span", { class: "el", vars: { el: color(id) } }, label(id));
const later = (fn: () => void) => queueMicrotask(() => requestAnimationFrame(fn));

// ------------------------------------------------------------------------------------------ (a) matrix

function startMatrix(): void {
  if (matrixJob) return;
  matrixRuns++;
  matrixStop = false;
  matrixJob = new MatrixJob(BATCH_ARCHETYPES, Number(matrixN), hashSeed("batch-ui", matrixRuns));
  paintMatrix();
  setTimeout(pumpMatrix, 0);
}

function pumpMatrix(): void {
  const job = matrixJob;
  if (!job) return;
  if (matrixStop) {
    matrixJob = null;
    paintMatrix(`Stopped after ${job.done}/${job.total} battles; nothing was kept.`);
    return;
  }
  const deadline = performance.now() + BUDGET_MS;
  let done = false;
  try {
    done = job.advance(() => performance.now() >= deadline, 16);
  } catch (e) {
    matrixJob = null;
    paintMatrix(`Failed: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  if (done) {
    matrixRes = job.result();
    matrixJob = null;
  }
  paintMatrix();
  if (!done) setTimeout(pumpMatrix, 0);
}

function matrixTable(m: MatrixResult): HTMLElement {
  const head = h("tr", {}, h("th", {}, "row \\ col"), ...m.ids.map((id) => h("th", {}, chip(id))), h("th", {}, "overall"));
  const rows = m.rows.map((r, i) =>
    h(
      "tr",
      {},
      h("th", {}, chip(r.id)),
      ...m.cells[i].map((c, j) => {
        if (c.n === 0) return h("td", { class: "bt5-cell bt5-na", title: `${c.draws} draws` }, "—");
        const hot = i !== j && c.n >= MIN_FLAG_N && c.p > LOPSIDED_CELL;
        const side = c.p >= 0.5 ? "bt5-win" : "bt5-loss";
        return h(
          "td",
          {
            class: `bt5-cell ${side}${i === j ? " bt5-mirror" : ""}${hot ? " bt5-hot" : ""}`,
            vars: { "bt5-k": `${Math.round(Math.abs(c.p - 0.5) * 200)}%` },
            title: `${label(c.a)} vs ${label(c.b)}: ${c.wins}-${c.losses}${c.draws ? `, ${c.draws} draws` : ""} · 95% ${pct(c.lo)}-${pct(c.hi)} · median ${c.medianDuration.toFixed(1)} s`,
          },
          pct(c.p),
        );
      }),
      h(
        "td",
        { class: `bt5-overall${r.overall.p > DOMINANT_ROW ? " bt5-hot" : ""}`, title: `95% ${pct(r.overall.lo)}-${pct(r.overall.hi)} · n=${r.overall.n} · ${r.overall.draws} draws` },
        h("b", {}, pct(r.overall.p)),
        h("span", { class: "muted" }, ` ${pct(r.overall.lo)}-${pct(r.overall.hi)}`),
      ),
    )
  );
  return h("table", { class: "t bt5-matrix" }, h("thead", {}, head), h("tbody", {}, ...rows));
}

function prosCons(m: MatrixResult): HTMLElement {
  return h(
    "table",
    { class: "t bt5-pros" },
    h("thead", {}, h("tr", {}, h("th", {}, "archetype"), h("th", {}, "pros"), h("th", {}, "cons"), h("th", {}, "median s"), h("th", {}, "dealt / taken"))),
    h(
      "tbody",
      {},
      ...m.rows.map((r) =>
        h(
          "tr",
          {},
          h("td", {}, chip(r.id)),
          h("td", { class: "bt5-pro" }, r.pros.join(" · ") || "—"),
          h("td", { class: "bt5-con" }, r.cons.join(" · ") || "—"),
          h("td", { class: "mono" }, r.medianDuration.toFixed(1)),
          h("td", { class: "mono" }, `${r.meanDealt.toFixed(0)} / ${r.meanTaken.toFixed(0)}`),
        )
      ),
    ),
  );
}

function paintMatrix(msg = ""): void {
  if (!ui || !ui.mOut.isConnected) return;
  const job = matrixJob;
  ui.mBtn.textContent = job ? "Stop" : matrixRes ? "Run again" : "Run the matrix";
  ui.mBtn.className = job ? "btn" : "btn primary";
  clear(ui.mStatus).append(
    job
      ? h("div", {}, h("p", { class: "muted" }, `Running ${job.done}/${job.total} battles…`), bar(job.done / job.total))
      : h("p", { class: "muted" }, msg || (matrixRes ? `${matrixRes.battles} battles (seed ${matrixRes.seed}), ${matrixRes.draws} draws. Hover a cell for its interval.` : "Not run yet.")),
  );
  const out = clear(ui.mOut);
  const m = matrixRes;
  if (!m) return;
  const v = m.verdict;
  out.append(
    matrixTable(m),
    h(
      "ul",
      { class: "bt5-verdict" },
      h("li", { class: v.noDominantRow ? "bt5-ok" : "bt5-bad" }, `No archetype above ${pct(DOMINANT_ROW)} overall: ${v.noDominantRow ? "yes" : "NO"}`),
      h("li", { class: v.noLopsidedCell ? "bt5-ok" : "bt5-bad" }, `No matchup above ${pct(LOPSIDED_CELL)}: ${v.noLopsidedCell ? "yes" : "NO"}`),
      h("li", { class: v.allHaveProsAndCons ? "bt5-ok" : "bt5-bad" }, `Every archetype beats one and loses to one: ${v.allHaveProsAndCons ? "yes" : "NO"}`),
      ...m.flags.map((f) => h("li", { class: "bt5-bad" }, f)),
    ),
    h("h3", {}, "Pros and cons (measured)"),
    prosCons(m),
    h("p", { class: "muted" }, `n = ${m.nPerCell} per pair is small: a cell's 95 % interval is wide. The CLI (deno task batch 48) runs the same matrix at scale and on a held-out seed.`),
  );
}

// ------------------------------------------------------------------------------------------ (b) breeding

function seedPopulation(app: App): Genemon[] {
  const team = teamOf(app.profile);
  return (team.length ? team : app.profile.collection).slice(0, 6);
}

function startBreed(app: App): void {
  if (breedJob) return;
  const seedPop = seedPopulation(app);
  if (seedPop.length === 0) {
    breedMsg = "Your collection is empty: hatch or catch a Genemon first.";
    paintBreed();
    return;
  }
  breedRuns++;
  breedStop = false;
  breedRes = null;
  breedChild = null;
  breedMsg = "";
  breedJob = new BreedJob(seedPop, Number(breedGens), BREED_POP, gauntletFitness(), hashSeed("batch-breed", app.profile.id, breedRuns), { owner: app.profile.id });
  paintBreed();
  setTimeout(() => pumpBreed(app), 0);
}

function pumpBreed(app: App): void {
  const job = breedJob;
  if (!job) return;
  if (breedStop) {
    breedJob = null;
    breedMsg = `Stopped after ${job.done}/${job.total} evaluations; no child was added.`;
    paintBreed();
    return;
  }
  const deadline = performance.now() + BUDGET_MS;
  let done = false;
  try {
    done = job.advance(() => performance.now() >= deadline, 1);
  } catch (e) {
    breedJob = null;
    breedMsg = `Failed: ${e instanceof Error ? e.message : String(e)}`;
    paintBreed();
    return;
  }
  if (done) {
    breedRes = job.result();
    breedJob = null;
    adopt(app, breedRes);
  }
  paintBreed();
  if (!done) setTimeout(() => pumpBreed(app), 0);
}

/** The best bred child joins the collection as a hatchling (level 5, 1 day old), like the Lab's Breed. */
function adopt(app: App, r: BreedBatchResult): void {
  const best = r.bestChild;
  if (!best) {
    breedMsg = "No child was bred.";
    return;
  }
  const seed = hashSeed("batch-adopt", best.genome.id, breedRuns);
  const child = createGenemon({ seed, owner: app.profile.id, level: 5, ageDays: 1, genome: best.genome });
  if (app.profile.collection.some((g) => g.id === child.id)) {
    breedMsg = `${child.name} is already in your collection.`;
    breedChild = child;
    return;
  }
  app.profile.collection.push(child);
  if (!app.profile.pokedex.includes(child.genome.id)) app.profile.pokedex.push(child.genome.id);
  app.log("genemon.create", "batch breeding", child.id, `${child.name} gen ${child.genome.generation}, gauntlet ${pct(r.bestChildFitness)} after ${r.generations.length - 1} generations`);
  app.save();
  breedChild = child;
  breedMsg = `${child.name} (gen ${child.genome.generation}, gauntlet win rate ${pct(r.bestChildFitness)} at its parents' level) joined your collection as a hatchling.`;
  toast(`${child.name} joined your collection (batch breeding).`);
}

function paintBreed(): void {
  if (!ui || !ui.bOut.isConnected) return;
  const job = breedJob;
  ui.bBtn.textContent = job ? "Stop" : `Breed ${breedGens} generations from my team`;
  ui.bBtn.className = job ? "btn" : "btn primary";
  clear(ui.bStatus).append(
    job
      ? h("div", {}, h("p", { class: "muted" }, `Generation ${job.curve.length}/${job.generations + 1} · ${job.done}/${job.total} evaluations…`), bar(job.done / job.total))
      : h("p", { class: "muted" }, breedMsg || "Not run yet."),
  );
  const out = clear(ui.bOut);
  const gens = job ? job.curve : breedRes?.generations ?? [];
  if (gens.length === 0) return;
  const fit = h("canvas", { class: "chart" }) as HTMLCanvasElement;
  const drift = h("canvas", { class: "chart" }) as HTMLCanvasElement;
  const last = gens[gens.length - 1];
  out.append(
    h("h3", {}, "Fitness and diversity per generation (%)"),
    fit,
    h("h3", {}, "Archetype drift (share of the population, %)"),
    drift,
    h(
      "dl",
      { class: "kv" },
      h("dt", {}, "Last generation"),
      h("dd", {}, `gen ${last.gen}: mean ${pct(last.meanFitness)}, best ${pct(last.bestFitness)} (${last.bestName}, ${label(last.bestArchetype)})`),
      h("dt", {}, "Power per slot"),
      h("dd", {}, `${gens[0].powerPerSlot.toFixed(0)} → ${last.powerPerSlot.toFixed(0)} (budget-normalised: selection reshapes, it cannot buy power)`),
      h("dt", {}, "Diversity"),
      h("dd", {}, `${gens[0].diversity.toFixed(2)} → ${last.diversity.toFixed(2)} (mean |allele difference|)`),
    ),
  );
  if (breedChild) {
    out.append(
      h("div", { class: "cards" }, genemonCard(breedChild)),
      h("p", { class: "muted" }, `Nearest archetype: ${label(classifyArchetype(breedChild))} · ${phenotypeOf(breedChild).sizeClass}`),
    );
  }
  later(() => {
    lineChart(fit, [
      { values: gens.map((g) => g.meanFitness * 100), color: "#3ddc84", label: "mean fitness" },
      { values: gens.map((g) => g.bestFitness * 100), color: "#ffd166", label: "best" },
      { values: gens.map((g) => g.diversity * 100), color: "#00bbf9", label: "diversity" },
    ]);
    lineChart(drift, BATCH_ARCHETYPES.map((a) => ({ values: gens.map((g) => (g.archetypeShare[a.id] ?? 0) * 100), color: a.color, label: a.label })));
  });
}

// ------------------------------------------------------------------------------------------ screen

function costsTable(): HTMLElement {
  return h(
    "table",
    { class: "t" },
    h("thead", {}, h("tr", {}, h("th", {}, "size class"), ...SIZE_CLASSES.map((c) => h("th", {}, c)))),
    h(
      "tbody",
      {},
      h("tr", {}, h("td", {}, "slot cost (of 6)"), ...SIZE_CLASSES.map((c) => h("td", { class: "mono" }, String(SLOT_COST[c])))),
      h("tr", {}, h("td", {}, "power budget"), ...SIZE_CLASSES.map((c) => h("td", { class: "mono" }, String(POWER_BUDGET[c])))),
      h("tr", {}, h("td", {}, "budget per slot"), ...SIZE_CLASSES.map((c) => h("td", { class: "mono" }, (POWER_BUDGET[c] / SLOT_COST[c]).toFixed(2)))),
    ),
  );
}

export function renderBatch(app: App): HTMLElement {
  const mBtn = h("button", { class: "btn primary", onclick: () => (matrixJob ? (matrixStop = true) : startMatrix()) }) as HTMLButtonElement;
  const bBtn = h("button", { class: "btn primary", onclick: () => (breedJob ? (breedStop = true) : startBreed(app)) }) as HTMLButtonElement;
  ui = { mStatus: h("div", {}), mOut: h("div", { class: "bt5-out" }), mBtn, bStatus: h("div", {}), bOut: h("div", { class: "bt5-out" }), bBtn };
  const seedPop = seedPopulation(app);
  const root = h(
    "div",
    { class: "bt5" },
    section(
      "Archetype matchups",
      h("p", {}, "Six archetypes with the SAME power budget, spent differently. Each pair fights at equal slots (one M or L body; the swarm brings that many S bodies), on every element and arena, sides swapped. Win rate excludes draws."),
      h("div", { class: "row bt5-arch" }, ...BATCH_ARCHETYPES.map((a) => h("span", { class: "el", vars: { el: a.color }, title: a.intent }, a.label))),
      h("div", { class: "row" }, h("span", { class: "muted" }, "battles per pair"), select(MATRIX_SIZES, matrixN, (v) => (matrixN = v)), mBtn),
      ui.mStatus,
      ui.mOut,
    ),
    section(
      "Batch breeding",
      h("p", {}, `Generation 0 = your team (${seedPop.length ? seedPop.map((g) => g.name).join(", ") : "empty"}), topped up to ${BREED_POP} with their children. Each candidate fights the six archetypes at its own slot count; tournament selection (3) breeds the winners, 1 elite survives, 35 % of children also mutate. The best child joins your collection.`),
      h("div", { class: "row" }, h("span", { class: "muted" }, "generations"), select(GEN_OPTIONS, breedGens, (v) => {
        breedGens = v;
        paintBreed();
      }), bBtn),
      ui.bStatus,
      ui.bOut,
    ),
    section(
      "How the numbers are made",
      h("p", {}, "Power index = √(effective HP × damage rate). Effective HP counts defence and evasion; damage rate counts attack, charge rate, energy regen, accuracy and crits. HP and attack are scaled so the index equals the size class's budget, so every point of speed, armour, accuracy or crit is paid for in HP and attack [SPEC B1]."),
      costsTable(),
      h("p", { class: "muted" }, "Hit chance = attacker accuracy × (1 − defender evasion, capped 35 %). Breeding: one allele from each parent per gene, mutation 3 % per gene (more for chaotic lineages)."),
    ),
  );
  paintMatrix();
  paintBreed();
  return root;
}
