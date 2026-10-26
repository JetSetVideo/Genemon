// deno-lint-ignore-file no-explicit-any
/**
 * Pass-7 geometry probe [P7-G1, P7-G2]: over N wild seeds (randomGenome -> express -> helixOf -> buildSkeleton ->
 * buildBody, low and high tier) report body triangles (median / mean / max), build time per body, cap breaches,
 * non-finite vertices, and how many seeds actually carry each p7 feature (reachability: not dead code).
 * Runs on any tree that has helix.p7 (it imports nothing pass-7-specific from src/render), so the SAME tool
 * measures a copy with the pass-6 render files for the before/after comparison.
 *   deno run -A tools/p7geo.ts [N=200] [--json path]
 */
import * as THREE from "../src/lib/three.ts";
import { randomGenome } from "../src/genome/genome.ts";
import { express } from "../src/genome/phenotype.ts";
import { emptyConditions } from "../src/genome/epigenetics.ts";
import { buildSkeleton, skeletonGenes } from "../src/body/skeleton.ts";
import { helixOf } from "../src/genome/helix.ts";
import { bodyTriangleCap, buildBody } from "../src/render/anatomy/body.ts";

const N = Number(Deno.args.find((a) => /^\d+$/.test(a)) ?? 200);
const jsonAt = Deno.args.indexOf("--json");
const m = () => new THREE.MeshStandardMaterial();
const MATS: any = { skin: m(), accent: m(), belly: m(), keratin: m(), membrane: m(), textures: [], baseEmissive: 0 };

const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))];
  return { min: s[0], median: q(0.5), mean: Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10, p90: q(0.9), max: s[s.length - 1] };
};
const finite = (b: any) => {
  let ok = true;
  b.perJoint.forEach((objs: any[]) => objs.forEach((o) => o.traverse((x: any) => {
    if (!x.isMesh) return;
    const a = x.geometry.getAttribute("position").array;
    for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) ok = false;
  })));
  return ok;
};

const tri: Record<string, number[]> = { low: [], high: [] };
const ms: Record<string, number[]> = { low: [], high: [] };
let overCap = 0, nonFinite = 0;
const has: Record<string, number> = {};
const bump = (k: string, on: boolean) => (has[k] = (has[k] ?? 0) + (on ? 1 : 0));
const kinds: Record<string, number> = {};
let opsTotal = 0;
for (let seed = 1; seed <= N; seed++) {
  const g = randomGenome(seed);
  const ph = express(g, emptyConditions());
  const helix = helixOf(g, ph);
  const sk = buildSkeleton(ph, skeletonGenes(helix));
  for (const q of ["low", "high"] as const) {
    const t0 = performance.now();
    const b = buildBody(ph, sk, helix, MATS, q);
    ms[q].push(performance.now() - t0);
    tri[q].push(b.triangles);
    if (sk.plan6 && b.triangles > bodyTriangleCap(sk, q)) overCap++;
    if (!finite(b)) nonFinite++;
  }
  const p7: any = (helix as any).p7;
  if (!p7) continue;
  const r = p7.relief;
  bump("relief.ridges>0", r.ridges > 0);
  bump("relief.flutes>0", r.flutes > 0);
  bump("relief.segments>0&depth>0", r.segments > 0 && r.segmentDepth > 0);
  bump("relief.knobs>=0.125 (>=1 knob pair)", Math.round(r.knobs * 4) >= 1);
  bump("relief.facets>0", r.facets > 0);
  bump("relief.scallop>0", r.scallop > 0);
  const hornJ = sk.joints.filter((j) => j.role === "horn" && j.side > 0).length;
  bump("horns.pairs>=1", p7.horns.pairs >= 1);
  bump("horns: extra pairs grown (pairs > skeleton pairs, horned skull)", hornJ > 0 && p7.horns.pairs > hornJ);
  bump("horns.branch>0 (on a horned skull)", hornJ > 0 && p7.horns.branch > 0);
  bump("horns.curl>0 (on a horned skull)", hornJ > 0 && p7.horns.curl > 0.01);
  bump("spikes.rows>=1", p7.spikes.rows >= 1);
  bump("spikes.rows>=2", p7.spikes.rows >= 2);
  bump("p7.ops>=1", p7.ops.length >= 1);
  for (const o of p7.ops) kinds[o.kind] = (kinds[o.kind] ?? 0) + 1;
  for (const k of new Set(p7.ops.map((o: any) => o.kind))) bump(`op kind ${k} (seeds)`, true);
  opsTotal += p7.ops.length;
}
const out = {
  seeds: N,
  triangles: { low: stats(tri.low), high: stats(tri.high) },
  buildMs: { low: stats(ms.low.map((x) => Math.round(x * 10) / 10)), high: stats(ms.high.map((x) => Math.round(x * 10) / 10)) },
  overCap,
  nonFinite,
  presence: Object.fromEntries(Object.entries(has).sort()),
  opKinds: kinds,
  opsTotal,
  perSeed: { low: tri.low, high: tri.high },
};
console.log(JSON.stringify({ ...out, perSeed: undefined }, null, 1));
if (jsonAt >= 0) await Deno.writeTextFile(Deno.args[jsonAt + 1], JSON.stringify(out, null, 1));
