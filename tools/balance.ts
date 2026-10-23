// Balance harness: measures the game, never tunes it silently.
//   deno task balance [seedsPerPair=10]
// 1. Element matrix: mono-element duels at the SAME size class (M, 2 slots each), every pair, both
//    sides. Each creature keeps its element's full axis signature; only stature is searched so the
//    size class matches (light / gas / void bodies are less dense and would otherwise land in a
//    smaller class with a smaller power budget, which measures size, not element).
// 2. Big vs swarm at EQUAL slot counts (XL vs 4 S, L vs 3 S, M vs 2 S).
// 3. Random-team corpus: draw rate, durations, hit rate per move shape, moves learned vs used,
//    damage per energy -> meta share (input of moveCost's meta multiplier) in artifacts/balance/meta.json.
import { Battle } from "../src/combat/battle.ts";
import { arenaSpec, team } from "../src/combat/scenario.ts";
import { autoTeam } from "../src/combat/team.ts";
import { moveCost } from "../src/combat/moves.ts";
import { ALL_MOVE_BY_ID as MOVE_BY_ID, ALL_MOVES as MOVES } from "../src/combat/kit.ts";
import { Ledger } from "../src/core/ledger.ts";
import { hashSeed } from "../src/core/rng.ts";
import { ELEMENT_IDS, ELEMENTS, type ElementId } from "../src/data/elements.ts";
import { createGenemon, type Genemon, phenotypeOf } from "../src/genome/genemon.ts";
import type { SizeClass } from "../src/genome/phenotype.ts";
import { ARENA_KINDS } from "../src/world/arena.ts";
import { wilsonLike } from "./_stats.ts";

const SEEDS = Number(Deno.args[0] ?? 10);
const t0 = performance.now();
const EL = ELEMENT_IDS.filter((e) => e !== "neutral");
const STATURE_GUESS: Record<SizeClass, number> = { XS: -0.85, S: -0.5, M: 0.05, L: 0.55, XL: 0.85, XXL: 1 };
const STATURES = Array.from({ length: 20 }, (_, i) => -0.95 + i * 0.1);
let built = 0, failed = 0;

/** A creature of element `e` and size class `want`, keeping the element's whole axis signature. */
function elemental(e: ElementId, seed: number, want: SizeClass): Genemon | null {
  const axes: Record<string, number> = {};
  for (const [k, v] of Object.entries(ELEMENTS[e].signature)) axes[k] = Math.max(-0.95, Math.min(0.95, (v as number) * 0.95));
  const order = STATURES.slice().sort((a, b) => Math.abs(a - STATURE_GUESS[want]) - Math.abs(b - STATURE_GUESS[want]));
  for (let k = 0; k < 4; k++) {
    for (const stature of order) {
      const g = createGenemon({ seed: hashSeed(seed, e, k, want), owner: "bal", level: 25, bias: { axes: { ...axes, stature }, spread: 0.14, plan: { quality: 0.5 } } });
      const ph = phenotypeOf(g);
      if (ph.elements.primary === e && ph.sizeClass === want) {
        built++;
        return g;
      }
    }
  }
  failed++;
  return null;
}

// ---------------------------------------------------------------- 1. element matrix (M vs M)
const matrix: Record<string, Record<string, { w: number; n: number }>> = {};
const powerByEl: Record<string, number[]> = {};
let duels = 0;
for (const a of EL) {
  matrix[a] = {};
  for (const b of EL) {
    const cell = { w: 0, n: 0 };
    for (let s = 0; s < SEEDS; s++) {
      const ga = elemental(a, s * 2 + 1, "M"), gb = elemental(b, s * 2 + 2, "M");
      if (!ga || !gb) continue;
      (powerByEl[a] ??= []).push(phenotypeOf(ga).power);
      const side = s % 2;
      const teams = side === 0 ? [team("A", [ga]), team("B", [gb])] as const : [team("B", [gb]), team("A", [ga])] as const;
      const r = new Battle({ seed: hashSeed(a, b, s), arena: arenaSpec(ARENA_KINDS[s % ARENA_KINDS.length], s, "clear", (s * 7 + 3) % 24), teams: [teams[0], teams[1]] }).run();
      duels++;
      if (r.winner === 2) continue;
      cell.n++;
      if (r.winner === side) cell.w++;
    }
    matrix[a][b] = cell;
  }
}
const elementTotals = EL.map((a) => {
  let w = 0, n = 0;
  for (const b of EL) if (b !== a) (w += matrix[a][b].w), (n += matrix[a][b].n);
  const pw = powerByEl[a] ?? [];
  return { e: a, w, n, power: pw.length ? pw.reduce((x, y) => x + y, 0) / pw.length : 0, mirror: matrix[a][a], ...wilsonLike(w, n) };
}).sort((x, y) => y.p - x.p);
const lopsided: { a: string; b: string; p: number; n: number }[] = [];
for (const a of EL) for (const b of EL) if (a < b && matrix[a][b].n >= 4) lopsided.push({ a, b, p: matrix[a][b].w / matrix[a][b].n, n: matrix[a][b].n });
lopsided.sort((x, y) => Math.abs(y.p - 0.5) - Math.abs(x.p - 0.5));
const inBand = elementTotals.filter((r) => r.p >= 0.35 && r.p <= 0.65).length;

// ---------------------------------------------------------------- 2. big vs swarm at equal slots
const sizeRows: { label: string; p: number; lo: number; hi: number; n: number; draws: number }[] = [];
for (const [label, bigClass, smallCount] of [["XL vs 4 S", "XL", 4], ["L vs 3 S", "L", 3], ["M vs 2 S", "M", 2]] as const) {
  let w = 0, n = 0, draws = 0, made = 0;
  for (let s = 0; made < SEEDS * 6 && s < SEEDS * 20; s++) {
    const big = elemental(EL[s % EL.length], s + 900, bigClass);
    const smalls = Array.from({ length: smallCount }, (_, k) => elemental(EL[(s * 5 + 3 + k) % EL.length], s * 31 + k, "S"));
    if (!big || smalls.some((x) => !x)) continue;
    made++;
    const side = s % 2;
    const A = team("big", [big]), B = team("swarm", smalls as Genemon[]);
    const r = new Battle({ seed: hashSeed(label, s), arena: arenaSpec(ARENA_KINDS[s % ARENA_KINDS.length], s, "clear", (s * 7 + 3) % 24), teams: side === 0 ? [A, B] : [B, A] }).run();
    if (r.winner === 2) {
      draws++;
      continue;
    }
    n++;
    if (r.winner === side) w++;
  }
  sizeRows.push({ label, ...wilsonLike(w, n), n, draws });
}

// ---------------------------------------------------------------- 3. random-team corpus
const usage: Record<string, number> = {};
const learned: Record<string, number> = {};
const dmg: Record<string, number> = {};
const shapeHits: Record<string, { hit: number; miss: number }> = {};
let draws = 0;
const durations: number[] = [];
const reactionTotals: Record<string, number> = {};
const CORPUS = SEEDS * 20;
for (let s = 0; s < CORPUS; s++) {
  const pool = Array.from({ length: 14 }, (_, i) => createGenemon({ seed: hashSeed("corpus", s, i), owner: "c", level: 15 + (s % 20) }));
  const A = autoTeam(pool.slice(0, 7), "A", s, (["big", "swarm", "balanced"] as const)[s % 3]);
  const B = autoTeam(pool.slice(7), "B", s + 1, (["balanced", "big", "swarm"] as const)[s % 3]);
  for (const g of [...A.members, ...B.members]) for (const m of g.moves) learned[m] = (learned[m] ?? 0) + 1;
  const ledger = new Ledger("bal", 50000);
  const r = new Battle({ seed: s, arena: arenaSpec(ARENA_KINDS[s % ARENA_KINDS.length], s, "clear", (s * 7) % 24), teams: [A, B], ledger }).run();
  durations.push(r.duration);
  if (r.winner === 2) draws++;
  for (const [m, c] of Object.entries(r.moveUses)) usage[m] = (usage[m] ?? 0) + c;
  for (const [k, v] of Object.entries(r.reactions)) reactionTotals[k] = (reactionTotals[k] ?? 0) + (v ?? 0);
  for (const row of ledger.query({ what: /^battle\.(hit|miss)$/ })) {
    const m = MOVE_BY_ID[String(row.entries.move)];
    if (!m) continue;
    const sh = (shapeHits[m.shape] ??= { hit: 0, miss: 0 });
    if (row.what === "battle.hit") {
      sh.hit++;
      dmg[m.id] = (dmg[m.id] ?? 0) + Number(row.exits.damage);
    } else sh.miss++;
  }
}
const totalUses = Object.values(usage).reduce((a, b) => a + b, 0);
const share: Record<string, number> = {};
for (const m of MOVES) share[m.id] = (usage[m.id] ?? 0) / Math.max(1, totalUses);
const moveRows = MOVES.map((m) => {
  const uses = usage[m.id] ?? 0;
  const cost = moveCost(m);
  return { id: m.id, element: m.element, shape: m.shape, learned: learned[m.id] ?? 0, uses, share: share[m.id], cost, metaCost: moveCost(m, { share }), dmgPerUse: uses ? (dmg[m.id] ?? 0) / uses : 0, dmgPerEnergy: uses ? (dmg[m.id] ?? 0) / uses / cost : 0 };
}).sort((a, b) => b.uses - a.uses);
durations.sort((a, b) => a - b);
const neverLearned = moveRows.filter((r) => r.learned === 0).map((r) => r.id);
const learnedUnused = moveRows.filter((r) => r.learned > 0 && r.uses === 0).map((r) => `${r.id} (${r.learned})`);

// ---------------------------------------------------------------- report
const pc = (p: number) => `${(p * 100).toFixed(0)}%`;
const lines = [
  "# Balance report",
  "",
  `Generated by \`deno task balance ${SEEDS}\` in ${((performance.now() - t0) / 1000).toFixed(1)} s (${duels} element duels, ${CORPUS} random-team battles; ${built} archetypes built, ${failed} could not be built at the requested class). Measured, not tuned.`,
  "",
  "## 1. Element win rates (mono-element duels, both M = 2 slots, every opponent element, decisive only)",
  "",
  `${inBand}/${EL.length} elements inside the 35-65% band.`,
  "",
  "| element | win rate | 95% CI | n | mean power | mirror (row side) |",
  "|---|---|---|---|---|---|",
  ...elementTotals.map((r) => `| ${ELEMENTS[r.e].name} | ${pc(r.p)} | ${pc(r.lo)}-${pc(r.hi)} | ${r.n} | ${r.power.toFixed(0)} | ${r.mirror.w}/${r.mirror.n} |`),
  "",
  "Most lopsided pairs (row element's win rate vs the column element):",
  "",
  ...lopsided.slice(0, 14).map((x) => `- ${x.a} vs ${x.b}: ${pc(x.p)} (n=${x.n})`),
  "",
  "## 2. Big vs swarm at equal slot count",
  "",
  "| matchup | big side win rate | 95% CI | n | draws |",
  "|---|---|---|---|---|",
  ...sizeRows.map((r) => `| ${r.label} | ${pc(r.p)} | ${pc(r.lo)}-${pc(r.hi)} | ${r.n} | ${r.draws} |`),
  "",
  "## 3. Random-team corpus",
  "",
  `- Draw rate: ${pc(draws / CORPUS)} (${draws}/${CORPUS}); duration p10 ${durations[Math.floor(CORPUS * 0.1)].toFixed(1)} s, median ${durations[Math.floor(CORPUS / 2)].toFixed(1)} s, p90 ${durations[Math.floor(CORPUS * 0.9)].toFixed(1)} s`,
  `- Hit rate by move shape: ${Object.entries(shapeHits).map(([k, v]) => `${k} ${pc(v.hit / Math.max(1, v.hit + v.miss))} (${v.hit + v.miss})`).join(", ")}`,
  `- Reactions per battle: ${Object.entries(reactionTotals).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${(v / CORPUS).toFixed(2)}`).join(", ") || "none"}`,
  `- Moves never learned by a corpus fighter (${neverLearned.length}/${MOVES.length}): ${neverLearned.join(", ") || "none"}`,
  `- Moves learned but never used (${learnedUnused.length}): ${learnedUnused.join(", ") || "none"}`,
  "",
  "| move | element | shape | learned by | uses | share | cost | cost with meta | dmg/use | dmg/energy |",
  "|---|---|---|---|---|---|---|---|---|---|",
  ...moveRows.filter((r) => r.uses > 0).map((r) => `| ${MOVE_BY_ID[r.id].name} | ${r.element} | ${r.shape} | ${r.learned} | ${r.uses} | ${(r.share * 100).toFixed(1)}% | ${r.cost} | ${r.metaCost} | ${r.dmgPerUse.toFixed(1)} | ${r.dmgPerEnergy.toFixed(2)} |`),
  "",
];
await Deno.mkdir("artifacts/balance", { recursive: true });
await Deno.writeTextFile("artifacts/balance/REPORT.md", lines.join("\n"));
await Deno.writeTextFile("artifacts/balance/meta.json", JSON.stringify({ generatedBy: `deno task balance ${SEEDS}`, battles: CORPUS, share }, null, 1));
await Deno.writeTextFile("artifacts/balance/matrix.json", JSON.stringify(matrix));
console.log(lines.slice(0, 48).join("\n"));
