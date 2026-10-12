/**
 * Insights screen: the data-science layer, visible. Three sections, all computed on this device:
 *   (a) Win predictor: a neural network (src/ml/winModel.ts) trained on battles simulated here
 *       with the real engine, scored on battles it never saw against logistic regression, the
 *       ladder's own expectation and the base rate; calibration, feature importance, loss curves,
 *       and its forecast for YOUR team per arena (the model gives feedback).
 *   (b) Genome projection: PCA of the 26 axes of your collection + the seeded wild population
 *       (2D map here, PC1-PC3 in the 3D Genospace via mountInsights), components in words,
 *       k-means archetypes and which ones you do not own yet (src/ml/projection.ts).
 *   (c) Your play pattern: battles by hour of day, win rate by time of day (Wilson 95%), session.
 * Long work runs in setTimeout slices of ~40 ms (at most 20 battles each; the corpus job checks
 * the clock every 64 engine steps), so the UI never freezes; results are cached in this module.
 */
import type { App } from "../app.ts";
import type { Team } from "../../combat/team.ts";
import { r3 } from "../../core/math.ts";
import { hashSeed } from "../../core/rng.ts";
import { ELEMENTS, type ElementId } from "../../data/elements.ts";
import type { WeatherId } from "../../data/weather.ts";
import { type Genemon, phenotypeOf } from "../../genome/genemon.ts";
import { type AxisClustering, type AxisProjection, axisRows, clusterAxes, elbow, projectAxes } from "../../ml/projection.ts";
import { wilson } from "../../ml/stats.ts";
import {
  CorpusJob,
  type CorpusStats,
  type ModelId,
  type ModelScore,
  WIN_FEATURES,
  winFeatures,
  type WinModelReport,
  winPredictor,
  WinTrainer,
} from "../../ml/winModel.ts";
import { ARENA_INFO, ARENA_KINDS, type ArenaKind } from "../../world/arena.ts";
import { barChart, lineChart, scatter } from "../charts.ts";
import { bar, clear, fmt, h, hex, pct, section, select } from "../dom.ts";
import { teamOf } from "../profile.ts";
import { elChip } from "../widgets.ts";

type Draw = () => void;

/** Main-thread work per slice before the browser gets control back. */
const BUDGET_MS = 40;
/** At most this many battles per slice. */
const CHUNK_BATTLES = 20;
const SIZES = [200, 400, 800] as const;
const CLUSTER_SEED = 7;
const ELBOW_MAX = 8;
const GOOD = "#3ddc84", BAD = "#ff4d6d", GRID = "#56606e";

const MODEL_INFO: Record<ModelId, { tag: string; name: string; note: string; color: string }> = {
  nn: { tag: "NN", name: "Neural network", note: "all inputs, one hidden layer of tanh units", color: "#00f5d4" },
  logistic: { tag: "LR", name: "Logistic regression", note: "the same inputs, no hidden layer", color: "#ffd166" },
  conditions: { tag: "C8", name: "Logistic, conditions only", note: "only the ladder's 8 condition features", color: "#9b5de5" },
  ladder: { tag: "MMR", name: "Ladder expectation", note: "the live ladder's formula after one online pass over the training battles", color: "#00bbf9" },
  base: { tag: "BASE", name: "Base rate", note: "always predicts the training share of side-A wins", color: "#a7b3c6" },
};
const FEATURE = new Map(WIN_FEATURES.map((f) => [f.name, f]));

interface Trained {
  report: WinModelReport;
  battles: number;
  seed: number;
  stats: CorpusStats;
  simMs: number;
  trainMs: number;
}

interface Running {
  battles: number;
  seed: number;
  job: CorpusJob;
  trainer: WinTrainer | null;
  startedAt: number;
  simMs: number;
  trainStart: number;
  stop: boolean;
}

interface Population {
  key: string;
  gs: Genemon[];
  elements: ElementId[];
  owned: number;
  proj: AxisProjection;
  clusters: AxisClustering;
  elbow: number[];
}

// Module state: survives re-renders and screen changes for the whole session.
let trained: Trained | null = null;
let running: Running | null = null;
let corpusSize = 400;
let nextSeed = 1;
let clusterK = 5;
let message = "";
let popMemo: Population | null = null;
let forecastMemo: { key: string; rows: { kind: ArenaKind; weather: WeatherId; p: number }[] } | null = null;
/** DOM of the mounted screen, re-bound on every render (a running job updates whatever is shown). */
let mounted: {
  status: HTMLElement;
  progress: HTMLElement;
  results: HTMLElement;
  run: HTMLButtonElement;
  stop: HTMLButtonElement;
  size: HTMLSelectElement;
} | null = null;

const later = (draws: Draw[]): void => queueMicrotask(() => requestAnimationFrame(() => draws.forEach((d) => d())));

/** "+1.23" / "−0.40" (rounded before choosing the sign). */
function signed(v: number, d = 2): string {
  const r = Math.round(v * 10 ** d) / 10 ** d;
  return `${r > 0 ? "+" : r < 0 ? "−" : ""}${fmt(Math.abs(r), d)}`;
}

const finite = (v: number): number => (Number.isFinite(v) ? r3(v) : -1);
const scoreOf = (rep: WinModelReport, id: ModelId): ModelScore | undefined => rep.scores.find((s) => s.id === id);
const chip = (text: string, color: string, title = ""): HTMLElement => h("span", { class: "el", vars: { el: color }, title }, text);

// ------------------------------------------------------------------------------------ (a) predictor

function startTraining(app: App): void {
  if (running) return;
  running = {
    battles: corpusSize,
    seed: nextSeed,
    job: new CorpusJob(corpusSize, nextSeed),
    trainer: null,
    startedAt: performance.now(),
    simMs: 0,
    trainStart: 0,
    stop: false,
  };
  message = "";
  syncControls();
  setTimeout(() => pump(app), 0);
}

function pump(app: App): void {
  const r = running;
  if (!r) return;
  if (r.stop) {
    running = null;
    syncControls(`Stopped after ${r.job.done} battles; nothing was kept.`);
    return;
  }
  const deadline = performance.now() + BUDGET_MS;
  const yieldNow = (): boolean => performance.now() >= deadline;
  try {
    if (!r.trainer) {
      if (r.job.advance(yieldNow, CHUNK_BATTLES)) {
        r.simMs = performance.now() - r.startedAt;
        r.trainStart = performance.now();
        r.trainer = new WinTrainer(r.job.rows, r.seed);
      }
    } else if (r.trainer.advance(yieldNow)) {
      finish(app, r, r.trainer.report());
      return;
    }
  } catch (e) {
    running = null;
    syncControls(`Failed: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  syncControls();
  setTimeout(() => pump(app), 0);
}

function finish(app: App, r: Running, report: WinModelReport): void {
  const trainMs = performance.now() - r.trainStart;
  trained = { report, battles: r.battles, seed: r.seed, stats: { ...r.job.stats }, simMs: r.simMs, trainMs };
  running = null;
  nextSeed = r.seed + 1;
  forecastMemo = null;
  const ll = (id: ModelId): number => finite(scoreOf(report, id)?.logLoss ?? NaN);
  app.ledger.emit({
    when: Date.now(),
    where: { x: 0, y: 0, z: 0, zone: "insights", space: "sim" },
    who: app.profile.id,
    what: "ml.winModel.trained",
    why: "win predictor trained on a freshly simulated corpus and scored on held-out battles",
    from: `corpus:${r.seed}`,
    to: "winModel",
    entries: {
      battles: r.battles,
      seed: r.seed,
      features: report.names.length,
      hidden: report.options.hidden,
      epochs: report.curve.bestEpoch,
      nTrain: report.nTrain,
      nHoldout: report.nHoldout,
    },
    exits: {
      nnLogLoss: ll("nn"),
      nnAccuracy: finite(scoreOf(report, "nn")?.accuracy ?? NaN),
      logisticLogLoss: ll("logistic"),
      conditionsLogLoss: ll("conditions"),
      ladderLogLoss: ll("ladder"),
      baseLogLoss: ll("base"),
      simMs: Math.round(r.simMs),
      trainMs: Math.round(trainMs),
    },
    tags: ["ml"],
  });
  syncControls(`Done: ${r.battles} battles simulated in ${fmt(r.simMs / 1000, 1)} s, models trained in ${fmt(trainMs / 1000, 1)} s.`);
  if (mounted && mounted.results.isConnected) {
    const draws: Draw[] = [];
    clear(mounted.results).append(resultsView(app, trained, draws));
    requestAnimationFrame(() => draws.forEach((d) => d()));
  }
}

function progressText(r: Running): { text: string; frac: number } {
  if (!r.trainer) {
    const s = (performance.now() - r.startedAt) / 1000;
    return { text: `Simulating battle ${Math.min(r.battles, r.job.done + 1)} of ${r.battles} · ${fmt(s, 1)} s`, frac: r.job.done / r.battles };
  }
  const p = r.trainer.progress;
  const what: Record<string, string> = {
    select: "network, early-stopping run",
    nn: "network, final fit",
    logistic: "logistic baseline",
    conditions: "conditions-only baseline",
    report: "scoring the held-out battles",
    done: "done",
  };
  return { text: `Training: ${what[p.phase]} · epoch ${p.epoch} of ${p.epochs}`, frac: p.fraction };
}

function syncControls(msg?: string): void {
  if (msg !== undefined) message = msg;
  if (!mounted || !mounted.status.isConnected) return;
  const r = running;
  mounted.run.disabled = !!r;
  mounted.size.disabled = !!r;
  mounted.run.textContent = trained ? "↻ Train on a fresh corpus" : "▶ Simulate & train";
  mounted.stop.classList.toggle("hidden", !r);
  mounted.progress.classList.toggle("hidden", !r);
  if (r) {
    const p = progressText(r);
    mounted.status.textContent = p.text;
    (mounted.progress.firstElementChild as HTMLElement | null)?.style.setProperty("--w", `${(Math.min(1, p.frac) * 100).toFixed(1)}%`);
  } else {
    mounted.status.textContent = message;
  }
}

function verdict(rep: WinModelReport): string[] {
  const nn = scoreOf(rep, "nn"), lr = scoreOf(rep, "logistic"), cond = scoreOf(rep, "conditions");
  const lad = scoreOf(rep, "ladder"), base = scoreOf(rep, "base");
  const out: string[] = [];
  if (!nn || !base) return out;
  const sig = (s: ModelScore): boolean => Math.abs(s.vsNN) > 2 * s.vsNNSE;
  out.push(base.vsNN > 0 && sig(base)
    ? `The network beats always guessing the base rate by ${fmt(base.vsNN, 3)} log-loss (${fmt(base.vsNN / base.vsNNSE, 1)} standard errors) and calls ${pct(nn.accuracy)} of the held-out winners.`
    : `The network does not clearly beat the base rate on this corpus (difference ${signed(base.vsNN, 3)} ± ${fmt(base.vsNNSE, 3)}).`);
  if (lr) {
    out.push(!sig(lr)
      ? `It ties logistic regression on the same inputs (${signed(lr.vsNN, 3)} ± ${fmt(lr.vsNNSE, 3)}): at this sample size the outcome is close to a linear function of these features, so the hidden layer has little to add yet.`
      : lr.vsNN < 0
      ? `Logistic regression on the same inputs is better by ${fmt(-lr.vsNN, 3)}: with ${rep.nTrain} training battles the network's extra flexibility costs more than it finds.`
      : `It beats logistic regression on the same inputs by ${fmt(lr.vsNN, 3)}: interactions between features matter.`);
  }
  if (cond && lr && cond.logLoss < lr.logLoss) {
    out.push(`The ladder's 8 condition features alone score ${fmt(cond.logLoss, 3)} vs ${fmt(lr.logLoss, 3)} with the team summaries added: the extra columns are mostly noise at this size.`);
  }
  if (lad && cond) {
    out.push(`The live ladder's expectation after one online pass reaches ${fmt(lad.logLoss, 3)} (base rate ${fmt(base.logLoss, 3)}); fitted offline, the same 8 conditions reach ${fmt(cond.logLoss, 3)}: the ladder's online learner needs many more matches than this.`);
  }
  return out;
}

function metricsTable(rep: WinModelReport): HTMLElement {
  const best = Math.min(...rep.scores.map((s) => s.logLoss));
  return h("table", { class: "t" },
    h("tr", {},
      h("th", {}, "Model"),
      h("th", { title: "Mean cross-entropy on the held-out battles (lower is better; 0.693 = a coin flip) ± its standard error" }, "Log-loss"),
      h("th", { title: "This model's log-loss minus the network's on the same battles (> 0: the network is better) ± paired standard error" }, "vs NN"),
      h("th", { title: "Share of decisive held-out battles whose winner it called" }, "Acc."),
      h("th", { title: "Mean squared error of the predicted probability (lower is better)" }, "Brier")),
    ...rep.scores.map((s) => {
      const info = MODEL_INFO[s.id];
      return h("tr", {},
        h("td", { title: info.note }, chip(info.tag, info.color, info.note), " ", info.name),
        h("td", { class: "mono" }, s.logLoss === best ? h("b", {}, fmt(s.logLoss, 3)) : fmt(s.logLoss, 3), h("span", { class: "muted" }, ` ±${fmt(s.logLossSE, 3)}`)),
        h("td", { class: "mono" }, s.id === "nn" ? "–" : `${signed(s.vsNN, 3)} ±${fmt(s.vsNNSE, 3)}`),
        h("td", {}, pct(s.accuracy)),
        h("td", { class: "mono" }, fmt(s.brier, 3)));
    }));
}

function calibrationView(rep: WinModelReport, draws: Draw[]): HTMLElement {
  const canvas = h("canvas", { class: "chart" });
  draws.push(() => {
    const pts: { x: number; y: number; color: string; r?: number }[] = [];
    for (let i = 0; i <= 40; i++) pts.push({ x: i / 20 - 1, y: i / 20 - 1, color: GRID, r: 1 });
    const maxN = Math.max(1, ...rep.calibration.map((b) => b.n), ...rep.calibrationLogistic.map((b) => b.n));
    const series = [[rep.calibrationLogistic, MODEL_INFO.logistic.color], [rep.calibration, MODEL_INFO.nn.color]] as const;
    for (const [bins, color] of series) {
      for (const b of bins) if (b.n > 0) pts.push({ x: 2 * b.meanP - 1, y: 2 * b.observed - 1, color, r: 2.5 + 4.5 * Math.sqrt(b.n / maxN) });
    }
    scatter(canvas, pts, "predicted →", "observed ↑");
  });
  const filled = rep.calibration.filter((b) => b.n > 0);
  return h("div", {},
    h("h3", {}, "Calibration (held-out battles)"),
    canvas,
    h("p", { class: "muted" },
      chip("NN", MODEL_INFO.nn.color), " network · ", chip("LR", MODEL_INFO.logistic.color),
      " logistic · grey diagonal = perfectly calibrated. Each dot is one 10% bin of predicted P(side A wins): left-right what the model said, up-down how often side A really won; bigger dot = more battles."),
    h("table", { class: "t" },
      h("tr", {}, h("th", {}, "NN said"), h("th", {}, "Battles"), h("th", {}, "Mean said"), h("th", {}, "A won"), h("th", {}, "95% interval")),
      ...filled.map((b) =>
        h("tr", {},
          h("td", {}, `${pct(b.lo)}–${pct(b.hi)}`),
          h("td", {}, String(b.n)),
          h("td", {}, pct(b.meanP)),
          h("td", {}, pct(b.observed)),
          h("td", { class: "muted" }, `${pct(b.ciLo)}–${pct(b.ciHi)}`))
      )));
}

function importanceView(rep: WinModelReport): HTMLElement {
  const top = rep.importance.slice(0, 10);
  const scale = Math.max(1e-9, ...top.map((f) => f.delta));
  const below = rep.importance.length - top.length;
  return h("div", {},
    h("h3", {}, "What the network relies on"),
    h("p", { class: "muted" }, "Permutation importance: shuffle one input across the held-out battles and measure how much worse the network gets (log-loss increase). Colour = direction from the logistic model: green when having more of it than the opponent helps, red when it hurts."),
    ...top.map((f) => {
      const info = FEATURE.get(f.name);
      const noise = f.delta <= 2 * f.sd;
      const shared = info?.group === "shared";
      const dir = shared
        ? "Same for both sides: it can only matter through interactions."
        : `Logistic weight ${signed(f.coef)} per standard deviation: ${f.coef >= 0 ? "more than the opponent helps" : "more than the opponent hurts"}.`;
      return h("div", {},
        h("div", { class: "row" },
          h("b", {}, info?.label ?? f.name),
          h("span", { class: "muted" }, info?.group ?? ""),
          h("span", { class: "spacer" }),
          h("span", { class: "mono" }, `${signed(f.delta, 3)}${noise ? " (noise)" : ""}`)),
        bar(Math.max(0, f.delta) / scale, shared ? GRID : f.coef >= 0 ? GOOD : BAD),
        h("p", { class: "muted" }, `${info?.note ?? ""} ${dir}`));
    }),
    below > 0 ? h("p", { class: "muted" }, `+ ${below} inputs with less influence.`) : null);
}

function curveView(rep: WinModelReport, draws: Draw[]): HTMLElement {
  const canvas = h("canvas", { class: "chart" });
  const c = rep.curve;
  if (c.validation.length > 0) {
    draws.push(() =>
      lineChart(canvas, [
        { values: c.train, color: MODEL_INFO.nn.color, label: "training loss" },
        { values: c.validation, color: "#ff9e00", label: "validation loss" },
      ])
    );
  } else {
    draws.push(() => lineChart(canvas, [{ values: rep.fitCurve, color: MODEL_INFO.nn.color, label: "training loss" }]));
  }
  return h("div", {},
    h("h3", {}, "Learning curve"),
    canvas,
    h("p", { class: "muted" },
      c.validation.length > 0
        ? `Loss per epoch of the early-stopping run (x axis: epochs 1-${c.train.length}). The validation battles are part of the training split, never the held-out ones. Validation loss was lowest after ${c.bestEpoch} epochs, so the final network was refitted on all ${rep.nTrain} training battles for ${c.bestEpoch} epochs. Training loss that keeps falling while validation rises = memorising.`
        : `Training loss per epoch (${rep.fitCurve.length} epochs, no early stopping).`));
}

function forecast(app: App, rep: WinModelReport): { kind: ArenaKind; weather: WeatherId; p: number }[] | null {
  const mine = teamOf(app.profile);
  if (mine.length === 0) return null;
  const hour = Math.round(app.hourNow() * 4) / 4;
  const key = `${trained?.seed}|${app.profile.id}|${mine.map((g) => `${g.id}:${g.conditions.xp}`).join(",")}|${hour}|${app.rw.weather}`;
  if (forecastMemo && forecastMemo.key === key) return forecastMemo.rows;
  const A: Team = { id: `team-${app.profile.id}`, owner: app.profile.id, name: app.profile.name, members: mine };
  const predict = winPredictor(rep.model);
  const rivalSeed = hashSeed("insights.rival", app.profile.id);
  const rows = ARENA_KINDS.map((kind) => {
    const weathers = ARENA_INFO[kind].weathers;
    const weather = weathers.includes(app.rw.weather) ? app.rw.weather : weathers[0];
    const B = app.opponentTeam({ arena: kind, weather, hour, opponent: "rival" }, rivalSeed);
    return { kind, weather, p: predict(winFeatures(A, B, { seed: hashSeed("insights.arena", kind), kind, weather, hour })) };
  });
  forecastMemo = { key, rows };
  return rows;
}

function forecastView(app: App, rep: WinModelReport, draws: Draw[]): HTMLElement {
  const rows = forecast(app, rep);
  if (!rows) return h("div", {}, h("h3", {}, "Where should you fight?"), h("p", { class: "muted" }, "Put Genemon in your team to get a forecast."));
  const canvas = h("canvas", { class: "chart" });
  draws.push(() => barChart(canvas, rows.map((r) => r.kind), rows.map((r) => Math.round(r.p * 100)), rows.map((r) => (r.p >= 0.5 ? GOOD : BAD))));
  const sorted = [...rows].sort((a, b) => b.p - a.p);
  const best = sorted[0], worst = sorted[sorted.length - 1];
  const spread = best.p - worst.p;
  return h("div", {},
    h("h3", {}, "Where should you fight? (the network's forecast)"),
    canvas,
    h("p", {},
      `Your current team against a rival trainer at your level, at ${fmt(app.hourNow(), 1)}h, in each arena's weather today: best `,
      h("b", {}, `${ARENA_INFO[best.kind].name} ${pct(best.p)}`),
      ", worst ",
      h("b", {}, `${ARENA_INFO[worst.kind].name} ${pct(worst.p)}`),
      "."),
    h("p", { class: "muted" },
      spread < 0.1
        ? "The arenas differ by less than 10 points: for this team the ground and weather matter less than the matchup itself."
        : "Learned from simulated battles, not from your own history: a forecast, not a promise. Retrain on a bigger corpus to sharpen it."));
}

function resultsView(app: App, t: Trained, draws: Draw[]): HTMLElement {
  const rep = t.report;
  const st = t.stats;
  return h("div", {},
    h("dl", { class: "kv" },
      h("dt", {}, "Corpus"),
      h("dd", {}, `${t.battles} simulated battles (seed ${t.seed}): side A won ${pct(st.aWins / Math.max(1, t.battles))}, ${st.draws} draws, ${st.timeouts} timeouts`),
      h("dt", {}, "This device"),
      h("dd", {}, `${fmt(t.simMs / Math.max(1, t.battles), 1)} ms per battle (${fmt(st.gameSeconds / Math.max(1, t.battles), 0)} s of game time each) · training ${fmt(t.trainMs / 1000, 1)} s`),
      h("dt", {}, "Split"),
      h("dd", {}, `${rep.nTrain} battles to learn from · ${rep.nHoldout} held out, never seen in training, to score`),
      h("dt", {}, "Network"),
      h("dd", {}, `${rep.names.length} inputs → ${rep.options.hidden} tanh → 1 sigmoid · ${rep.paramCount} weights · L2 ${rep.options.l2} · ${rep.curve.bestEpoch} epochs`)),
    metricsTable(rep),
    ...verdict(rep).map((line) => h("p", {}, line)),
    calibrationView(rep, draws),
    importanceView(rep),
    curveView(rep, draws),
    forecastView(app, rep, draws));
}

function predictorSection(app: App, draws: Draw[]): HTMLElement {
  const status = h("span", { class: "muted" });
  const progress = bar(0, MODEL_INFO.nn.color);
  const size = select(SIZES.map((n) => ({ value: String(n), label: `${n} battles` })), String(corpusSize), (v) => {
    corpusSize = Number(v);
  }, { title: "Corpus size: more battles = a better model and a longer wait" });
  const run = h("button", { class: "btn primary", onclick: () => startTraining(app) }, "▶ Simulate & train");
  const stop = h("button", { class: "btn small hidden", onclick: () => {
    if (running) running.stop = true;
  } }, "■ Stop");
  const results = h("div", {},
    trained
      ? resultsView(app, trained, draws)
      : h("p", {}, "No model yet. Press ▶: the real battle engine fights the corpus here, in slices, while the page stays usable; then the network and its baselines train (a few seconds in all)."));
  mounted = { status, progress, results, run, stop, size };
  syncControls();
  return section("Win predictor (neural network)",
    h("p", { class: "muted" },
      "Can a battle be called before it starts? A small neural network learns P(side A wins) from what is known beforehand: the ladder's 8 condition features (type advantage, arena, weather, power, synergy, size, reach, time of day), 10 team summaries (level, HP, attack, flyers...) and 4 shared conditions. It trains on battles simulated here with random teams at matched levels, then is scored on battles it never saw against logistic regression on the same inputs, the ladder's own expectation and the base rate."),
    h("div", { class: "row" }, size, run, stop),
    h("div", { class: "row" }, status),
    progress,
    results);
}

// ------------------------------------------------------------------------------------ (b) projection

function population(app: App): Population {
  const mine = app.profile.collection;
  const key = `${app.profile.id}|${clusterK}|${mine.map((g) => g.id).join(",")}|${
    axisRows(mine).map((r) => r.map((v) => v.toFixed(3)).join(" ")).join("|")
  }`;
  if (popMemo && popMemo.key === key) return popMemo;
  const gs = [...mine, ...app.wildPool()];
  const rows = axisRows(gs);
  const elements = gs.map((g) => phenotypeOf(g).elements.primary);
  popMemo = {
    key,
    gs,
    elements,
    owned: mine.length,
    proj: projectAxes(rows, 3),
    clusters: clusterAxes(rows, elements, clusterK, CLUSTER_SEED),
    elbow: elbow(rows, ELBOW_MAX, CLUSTER_SEED),
  };
  return popMemo;
}

function clusterBlock(app: App): HTMLElement {
  const pop = population(app);
  const yours = (members: readonly number[]): number => members.filter((i) => i < pop.owned).length;
  const missing = pop.clusters.clusters.filter((c) => yours(c.members) === 0);
  const pick = select(["3", "4", "5", "6", "7", "8"], String(clusterK), (v) => {
    clusterK = Number(v);
    block.replaceWith(clusterBlock(app));
  }, { title: "Number of archetypes (k)" });
  const block = h("div", {},
    h("div", { class: "row" }, h("h3", {}, "Archetypes (k-means)"), h("span", { class: "spacer" }), h("label", { class: "field" }, "k", pick)),
    h("table", { class: "t" },
      h("tr", {}, h("th", {}, "#"), h("th", {}, "Size"), h("th", {}, "Mostly"), h("th", { title: "Poles that set the archetype's centre apart from the population mean" }, "Stands out by"), h("th", {}, "Yours")),
      ...pop.clusters.clusters.map((c) =>
        h("tr", {},
          h("td", {}, String(c.id + 1)),
          h("td", {}, `${c.size} (${pct(c.share)})`),
          h("td", {}, elChip(c.dominant), h("span", { class: "muted" }, ` ${pct(c.dominantShare)}`)),
          h("td", {}, c.words),
          h("td", {}, yours(c.members) > 0 ? String(yours(c.members)) : h("span", { class: "muted" }, "none")))
      )),
    h("p", { class: "muted" }, "k-means++ on the full 26 axes of every Genemon shown (seeded: the same population always gives the same archetypes). Ranked by size."),
    pop.owned === 0
      ? null
      : missing.length === 0
      ? h("p", {}, "Your collection covers every archetype.")
      : h("p", {},
        `None of your Genemon belongs to ${missing.length === 1 ? "archetype" : "archetypes"} `,
        ...missing.flatMap((c, i) => [i > 0 ? (i === missing.length - 1 ? " and " : ", ") : "", h("b", {}, `#${c.id + 1}`), ` (${c.words}, mostly ${ELEMENTS[c.dominant].name})`]),
        ": catching one would widen your team's options."));
  return block;
}

function projectionSection(app: App, draws: Draw[]): HTMLElement {
  const pop = population(app);
  const { proj } = pop;
  if (pop.gs.length < 3) return section("Genome projection (PCA)", h("p", {}, "Not enough Genemon to project yet."));
  const map = h("canvas", { class: "chart" });
  draws.push(() => {
    const pts = pop.gs.map((_, i) => ({ x: proj.unit[i][0] ?? 0, y: proj.unit[i][1] ?? 0, color: hex(ELEMENTS[pop.elements[i]].color), r: i < pop.owned ? 5 : 2.5, owned: i < pop.owned }));
    // Wild first, yours on top.
    scatter(map, [...pts.filter((p) => !p.owned), ...pts.filter((p) => p.owned)], "PC1 →", "PC2 ↑");
  });
  const present = [...new Set(pop.elements)].sort((a, b) => pop.elements.filter((e) => e === b).length - pop.elements.filter((e) => e === a).length);
  const elbowCanvas = h("canvas", { class: "chart" });
  draws.push(() => lineChart(elbowCanvas, [{ values: pop.elbow, color: "#ff9e00", label: `inertia, k = 1 to ${pop.elbow.length}` }]));
  const maxExplained = Math.max(1e-9, ...proj.components.map((c) => c.explained));
  return section("Genome projection (PCA)",
    h("p", { class: "muted" },
      `Every Genemon is a point in 26 opposite-pole axes. Principal component analysis finds the directions along which ${pop.owned} of yours and ${pop.gs.length - pop.owned} wild ones differ most and flattens them to a map (big dots: yours; colour: primary element; each axis scaled to its range). The 3D view shows PC1-PC3: drag to orbit, hover a dot for its name.`),
    map,
    h("div", { class: "row" }, ...present.map((e) => elChip(e))),
    h("h3", {}, `What the axes mean (${pct(proj.explainedTotal)} of the diversity in 3 directions)`),
    ...proj.components.map((c) =>
      h("div", {},
        h("div", { class: "row" }, h("b", {}, `PC${c.index + 1}`), h("span", {}, c.words), h("span", { class: "spacer" }), h("span", { class: "mono" }, pct(c.explained))),
        bar(c.explained / maxExplained, "#ff9e00"),
        h("p", { class: "muted" }, `Toward + : ${c.top.map((t) => t.plus).join(", ")} · toward − : ${c.top.map((t) => t.minus).join(", ")}.`))
    ),
    clusterBlock(app),
    h("h3", {}, "How many archetypes? (elbow)"),
    elbowCanvas,
    h("p", { class: "muted" }, `Total squared distance of every Genemon to its archetype's centre for k = 1 to ${pop.elbow.length}. Where the curve stops dropping fast, more archetypes stop explaining much.`));
}

// ------------------------------------------------------------------------------------ (c) play pattern

const PERIODS: readonly [string, number, number][] = [
  ["Night 0-4h", 0, 4],
  ["Dawn 4-8h", 4, 8],
  ["Morning 8-12h", 8, 12],
  ["Afternoon 12-16h", 12, 16],
  ["Evening 16-20h", 16, 20],
  ["Late 20-24h", 20, 24],
];

function sessionView(app: App, battlesThisSession: number, draws: Draw[]): HTMLElement {
  const s = app.session;
  if (!s) return h("p", { class: "muted" }, "No session data on this device.");
  const activeMin = s.active() / 60000;
  const openMin = (Date.now() - s.startedAt) / 60000;
  const screens = Object.entries(s.screens).sort((a, b) => b[1] - a[1]);
  const canvas = h("canvas", { class: "chart" });
  if (screens.length > 0) draws.push(() => barChart(canvas, screens.map(([k]) => k), screens.map(([, v]) => v), "#4cc9f0"));
  return h("div", {},
    h("h3", {}, "This session"),
    h("dl", { class: "kv" },
      h("dt", {}, "Started"), h("dd", {}, new Date(s.startedAt).toLocaleTimeString()),
      h("dt", {}, "Active"), h("dd", {}, `${fmt(activeMin, 1)} min of ${fmt(openMin, 1)} min open`),
      h("dt", {}, "Clicks"), h("dd", {}, `${s.clicks} (${fmt(activeMin > 0 ? s.clicks / activeMin : 0, 1)} per active minute)`),
      h("dt", {}, "Battles"), h("dd", {}, `${battlesThisSession} this session${activeMin > 1 ? ` (${fmt((battlesThisSession / activeMin) * 60, 1)} per active hour)` : ""}`)),
    screens.length > 0 ? h("div", {}, h("p", { class: "muted" }, "Screens opened this session:"), canvas) : null);
}

function playSection(app: App, draws: Draw[]): HTMLElement {
  const s = app.session;
  const hist = app.profile.history.filter((r) => Number.isFinite(r.when));
  const thisSession = s ? hist.filter((r) => r.when >= s.startedAt).length : 0;
  if (hist.length === 0) {
    return section("Your play pattern",
      h("p", {}, "No battles yet: fight a few in the Arena and this section shows when you play and when you win."),
      h("button", { class: "btn primary", onclick: () => app.go("arena") }, "⚔ Go to the Arena"),
      sessionView(app, thisSession, draws));
  }
  const hours = new Array<number>(24).fill(0);
  for (const r of hist) hours[new Date(r.when).getHours()]++;
  const hourCanvas = h("canvas", { class: "chart" });
  draws.push(() => barChart(hourCanvas, hours.map((_, i) => String(i)), hours, "#9b5de5"));
  const periods = PERIODS.map(([label, lo, hi]) => {
    const rs = hist.filter((r) => {
      const hr = new Date(r.when).getHours();
      return hr >= lo && hr < hi;
    });
    const wins = rs.filter((r) => r.won === 0).length, losses = rs.filter((r) => r.won === 1).length;
    return { label, n: rs.length, wins, losses, draws: rs.length - wins - losses, ci: wilson(wins, wins + losses) };
  });
  const decisive = periods.filter((p) => p.wins + p.losses > 0);
  const rateCanvas = h("canvas", { class: "chart" });
  draws.push(() =>
    barChart(rateCanvas, decisive.map((p) => p.label.split(" ")[0]), decisive.map((p) => Math.round(p.ci.p * 100)), decisive.map((p) => (p.ci.p >= 0.5 ? GOOD : BAD)))
  );
  const ranked = periods.filter((p) => p.wins + p.losses >= 3).sort((a, b) => b.ci.lo - a.ci.lo);
  const peak = hours.indexOf(Math.max(...hours));
  return section("Your play pattern",
    h("p", { class: "muted" }, `Your last ${hist.length} battles (the profile keeps 60), by the local hour you played them.`),
    h("h3", {}, "Battles by hour of day"),
    hourCanvas,
    h("p", {}, `You battle most around ${peak}h (${hours[peak]} of ${hist.length}).`),
    h("h3", {}, "Win rate by time of day"),
    decisive.length > 0 ? rateCanvas : null,
    h("table", { class: "t" },
      h("tr", {}, h("th", {}, "When"), h("th", {}, "Battles"), h("th", {}, "W/L/D"), h("th", {}, "Win rate"), h("th", {}, "95% interval")),
      ...periods.filter((p) => p.n > 0).map((p) =>
        h("tr", {},
          h("td", {}, p.label),
          h("td", {}, String(p.n)),
          h("td", {}, `${p.wins}/${p.losses}/${p.draws}`),
          h("td", {}, p.wins + p.losses > 0 ? pct(p.ci.p) : "–"),
          h("td", { class: "muted" }, p.wins + p.losses > 0 ? `${pct(p.ci.lo)}–${pct(p.ci.hi)}` : "no decisive battle"))
      )),
    h("p", { class: "muted" },
      ranked.length > 0
        ? `Most reliably good: ${ranked[0].label} (at least ${pct(ranked[0].ci.lo)} with 95% confidence). Draws are left out of win rates; wide intervals mean few battles.`
        : "Fight at least 3 decisive battles in one time slot to compare slots: until then the intervals are too wide to say anything."),
    sessionView(app, thisSession, draws));
}

// ------------------------------------------------------------------------------------ screen

export function renderInsights(app: App): HTMLElement {
  const draws: Draw[] = [];
  const root = h("div", {},
    h("h1", {}, "Insights"),
    h("p", {}, "Data science on your game, computed on this device: a neural network that calls battles before they start, a map of where Genemon genomes differ, and when you play best."),
    predictorSection(app, draws),
    projectionSection(app, draws),
    playSection(app, draws));
  later(draws);
  return root;
}

/** 3D view of the screen: the Genospace in PCA coordinates (PC1-PC3, one common scale). */
export function mountInsights(app: App): void {
  const pop = population(app);
  const coords = new Map<string, [number, number, number]>();
  pop.gs.forEach((g, i) => {
    const u = pop.proj.uniform[i] ?? [];
    coords.set(g.id, [u[0] ?? 0, u[1] ?? 0, u[2] ?? 0]);
  });
  app.showGenospace("pca", coords);
}
