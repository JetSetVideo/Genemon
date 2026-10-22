// Diagnostic: why do moves miss? Tabulates battle.miss reasons per move shape over a corpus.
//   deno run --allow-read tools/diag-miss.ts [battles=60]
import { Battle } from "../src/combat/battle.ts";
import { arenaSpec } from "../src/combat/scenario.ts";
import { autoTeam } from "../src/combat/team.ts";
import { ALL_MOVE_BY_ID as MOVE_BY_ID } from "../src/combat/kit.ts";
import { Ledger } from "../src/core/ledger.ts";
import { hashSeed } from "../src/core/rng.ts";
import { createGenemon, phenotypeOf } from "../src/genome/genemon.ts";
import { ARENA_KINDS } from "../src/world/arena.ts";

const N = Number(Deno.args[0] ?? 60);
const reasons: Record<string, Record<string, number>> = {};
const gaps: number[] = [];
const bySize: Record<string, { hit: number; miss: number }> = {};
for (let s = 0; s < N; s++) {
  const pool = Array.from({ length: 14 }, (_, i) => createGenemon({ seed: hashSeed("corpus", s, i), owner: "c", level: 15 + (s % 20) }));
  const A = autoTeam(pool.slice(0, 7), "A", s, (["big", "swarm", "balanced"] as const)[s % 3]);
  const B = autoTeam(pool.slice(7), "B", s + 1, (["balanced", "big", "swarm"] as const)[s % 3]);
  const sizeOf = new Map([...A.members, ...B.members].map((g) => [g.id, phenotypeOf(g).sizeClass]));
  const ledger = new Ledger("diag", 60000);
  new Battle({ seed: s, arena: arenaSpec(ARENA_KINDS[s % ARENA_KINDS.length], s), teams: [A, B], ledger }).run();
  for (const r of ledger.query({ what: /^battle\.(hit|miss)$/ })) {
    const m = MOVE_BY_ID[String(r.entries.move)];
    if (!m) continue;
    const key = `${m.shape}`;
    const sz = `${m.shape}:${sizeOf.get(r.who) ?? "?"}`;
    const b = (bySize[sz] ??= { hit: 0, miss: 0 });
    if (r.what === "battle.hit") {
      b.hit++;
      continue;
    }
    b.miss++;
    const why = r.why.startsWith("roll") ? "accuracy roll" : r.why.replace(/\s*\(.*$/, "");
    (reasons[key] ??= {})[why] = (reasons[key][why] ?? 0) + 1;
    const g = r.why.match(/gap (-?[\d.]+)/);
    if (g) gaps.push(Number(g[1]));
  }
}
console.log("Miss reasons by shape:");
for (const [k, v] of Object.entries(reasons)) console.log(" ", k, JSON.stringify(v));
gaps.sort((a, b) => a - b);
if (gaps.length) console.log(`melee out-of-reach gap (m): p10 ${gaps[Math.floor(gaps.length * 0.1)]} median ${gaps[Math.floor(gaps.length / 2)]} p90 ${gaps[Math.floor(gaps.length * 0.9)]} n=${gaps.length}`);
console.log("Hit rate by shape:size of attacker:");
for (const [k, v] of Object.entries(bySize).sort()) console.log(" ", k, `${Math.round((100 * v.hit) / Math.max(1, v.hit + v.miss))}% of ${v.hit + v.miss}`);
