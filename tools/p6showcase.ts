// deno-lint-ignore-file no-explicit-any
/**
 * Pass-6 showcase genomes from REAL seeds (no hand-made fixtures): a minimal globe, a mythic colossus, a
 * metamorphosis lineage at its larva / cocoon / imago phases, a molt lineage before / after the shed, and a
 * 5-6 phase gradual grower at phases 1 / 3 / last. Writes artifacts/tmp/p6showcase.json for tools/p6shots.ts.
 *   deno run --allow-read --allow-write=artifacts tools/p6showcase.ts
 */
import { createGenemon, phenotypeOf, type Genemon } from "../src/genome/genemon.ts";
import { complexityOf, isColossal } from "../src/genome/complexity.ts";
import { evolutionPlanOf } from "../src/genome/evolution.ts";
import { randomGenome } from "../src/genome/genome.ts";

const out: { label: string; g: Genemon; info: string }[] = [];
const at = (genome: ReturnType<typeof randomGenome>, seed: number, level: number, ageDays: number, label: string) => {
  const g = createGenemon({ seed, owner: "showcase", genome, level, ageDays });
  const ph = phenotypeOf(g);
  out.push({ label, g, info: `${ph.kind} ${ph.sizeClass} ${ph.slots} slots ${complexityOf(g.genome).tier} phase ${ph.evo?.phase}/${ph.evo?.phases} ${ph.evo?.form} unlocks ${ph.evo?.unlocks.join(",")} ${ph.heightM.toFixed(2)} m` });
};
let globe = false, colossus = 0, meta = false, molt = false, grad = false;
for (let s = 1; s < 400000 && (!globe || colossus < 2 || !meta || !molt || !grad); s++) {
  const genome = randomGenome(s);
  if (!globe && complexityOf(genome).tier === "minimal") {
    at(genome, s, 20, 60, "globe");
    globe = true;
    continue;
  }
  if (colossus < 2 && isColossal(genome)) {
    at(genome, s, 30, 90, `colossus-${colossus}`);
    colossus++;
    continue;
  }
  const plan = evolutionPlanOf(genome);
  if (!meta && plan.kind === "metamorphosis" && plan.phases.length >= 3) {
    for (const p of plan.phases) at(genome, s, Math.max(p.atLevel, 1), p.atAgeDays + 0.5, `meta-${p.index}-${p.form}`);
    meta = true;
  } else if (!molt && plan.kind === "molt") {
    for (const p of plan.phases) at(genome, s, Math.max(p.atLevel, 1), p.atAgeDays + 0.5, `molt-${p.index}-${p.form}`);
    molt = true;
  } else if (!grad && plan.kind === "gradual" && plan.phases.length >= 5) {
    for (const p of plan.phases) at(genome, s, Math.max(p.atLevel, 1), p.atAgeDays + 0.5, `grad-${p.index}-${p.form}`);
    grad = true;
  }
}
for (const o of out) console.log(o.label.padEnd(22), o.info);
await Deno.writeTextFile("artifacts/tmp/p6showcase.json", JSON.stringify(out.map((o) => ({ label: o.label, g: o.g }))));
