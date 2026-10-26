/**
 * Pass-7 showcase from REAL seeds (no hand-made fixtures) [P7-D1, P7-G1]: for each pass-7 elaboration, the wild
 * Genemon (seeds 1..60000) that carries the most of it, plus a TYPICAL one (no signature, no elaboration), and a
 * family (two elaborate parents and their child) to show what heirs inherit. Writes artifacts/tmp/p6showcase.json
 * in the format tools/p6shots.ts photographs.
 *   deno run --allow-read --allow-write=artifacts tools/p7showcase.ts && deno task build && deno run -A tools/p6shots.ts artifacts/qa/p7-show
 */
import { createGenemon, type Genemon, phenotypeOf } from "../src/genome/genemon.ts";
import { type Genome, randomGenome } from "../src/genome/genome.ts";
import { breed } from "../src/genome/breeding.ts";
import { helixOf } from "../src/genome/helix.ts";
import type { MorphHelix } from "../src/genome/morphTypes.ts";

const mk = (genome: Genome, seed: number): Genemon => createGenemon({ seed, owner: "showcase", genome, level: 30, ageDays: 80 });
const hx = (g: Genemon): MorphHelix => helixOf(g.genome, phenotypeOf(g));

type Score = (h: MorphHelix) => number;
const FEATURES: [string, Score][] = [
  ["ridges", (h) => h.p7!.relief.ridges],
  ["segments", (h) => h.p7!.relief.segments * (0.5 + h.p7!.relief.segmentDepth)],
  ["knobs", (h) => h.p7!.relief.knobs],
  ["flutes", (h) => h.p7!.relief.flutes],
  ["horns", (h) => h.p7!.horns.pairs * 2 + h.p7!.horns.branch + h.p7!.horns.curl],
  ["spikes", (h) => h.p7!.spikes.rows * h.p7!.spikes.length],
  ["ops", (h) => h.p7!.ops.length],
];
const best = new Map<string, { s: number; seed: number }>();
let typical: number | null = null;
for (let seed = 1; seed <= 60000; seed++) {
  const h = hx(mk(randomGenome(seed), seed));
  for (const [name, f] of FEATURES) {
    const v = f(h), b = best.get(name);
    if (!b || v > b.s) best.set(name, { s: v, seed });
  }
  const p = h.p7!;
  if (typical === null && p.signature.length === 0 && p.ops.length === 0 && p.relief.ridges === 0 && p.relief.segments === 0 && p.spikes.rows <= 1) typical = seed;
}
const out: { label: string; g: Genemon }[] = [];
const describe = (label: string, g: Genemon) => {
  const h = hx(g), p = h.p7!;
  const ph = phenotypeOf(g);
  console.log(label.padEnd(16), `${ph.kind} ${ph.elements.primary} | ridges ${p.relief.ridges} flutes ${p.relief.flutes} seg ${p.relief.segments} knobs ${p.relief.knobs} | horns ${p.horns.pairs}/${p.horns.branch}/${p.horns.curl} spikes ${p.spikes.rows}x${p.spikes.length} | ops ${p.ops.map((o) => o.kind).join(",")} | sig ${p.signature.map((s) => s.gene).join(",")}`);
  out.push({ label, g });
};
if (typical !== null) describe("typical", mk(randomGenome(typical), typical));
for (const [name] of FEATURES) {
  const b = best.get(name)!;
  describe(`max-${name}`, mk(randomGenome(b.seed), b.seed));
}
// A family: the two most elaborate parents of the same kind found above (horns x spikes), and their child.
const pa = best.get("horns")!.seed, pb = best.get("spikes")!.seed;
const A = randomGenome(pa), B = randomGenome(pb);
describe("parent-A", mk(A, pa));
describe("parent-B", mk(B, pb));
describe("child-AB", mk(breed(A, B, 7), pa ^ pb));
await Deno.mkdir("artifacts/tmp", { recursive: true });
await Deno.writeTextFile("artifacts/tmp/p6showcase.json", JSON.stringify(out));
console.log(`wrote ${out.length} creatures`);
