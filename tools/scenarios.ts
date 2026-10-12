// Scenario runner: plays each gameplay scenario over many seeds and writes a measured report.
//   deno task scenarios [seeds=120]
import { Battle, type BattleResult } from "../src/combat/battle.ts";
import { ARCHETYPES, arenaSpec, makeArchetype, team } from "../src/combat/scenario.ts";
import type { GroundId } from "../src/data/grounds.ts";
import { createGenemon, phenotypeOf } from "../src/genome/genemon.ts";
import { autoTeam } from "../src/combat/team.ts";
import { wilsonLike } from "./_stats.ts";

const N = Number(Deno.args[0] ?? 120);
const out: { id: string; title: string; metric: string; value: string; expect: string; pass: boolean; note: string }[] = [];

function decisive(rs: BattleResult[], side: 0 | 1) {
  const d = rs.filter((r) => r.winner !== 2);
  const w = d.filter((r) => r.winner === side).length;
  return { w, n: d.length, draws: rs.length - d.length, ...wilsonLike(w, d.length) };
}

// SC-01 big fire brawler vs two small plants
{
  const rs: BattleResult[] = [];
  let slotsFire = 0, slotsPlants = 0;
  for (let s = 0; s < N; s++) {
    const fire = makeArchetype(ARCHETYPES.bigFireBrawler, s);
    const plants = [makeArchetype(ARCHETYPES.smallPlant, s * 7 + 1), makeArchetype({ ...ARCHETYPES.smallPlant, label: "small plant b", kind: "hexapod" }, s * 7 + 2)];
    slotsFire += phenotypeOf(fire).slots;
    slotsPlants += plants.reduce((a, g) => a + phenotypeOf(g).slots, 0);
    rs.push(new Battle({ seed: s, arena: arenaSpec("meadow", s), teams: [team("fire", [fire]), team("plants", plants)] }).run());
  }
  const d = decisive(rs, 0);
  out.push({ id: "SC-01", title: "Big fire brawler (close attack) vs two small plants", metric: "fire win rate (decisive)", value: `${(d.p * 100).toFixed(1)}% [${(d.lo * 100).toFixed(0)}-${(d.hi * 100).toFixed(0)}] n=${d.n} draws=${d.draws}`, expect: ">= 70%", pass: d.lo >= 0.6 && d.p >= 0.7, note: `avg slots fire ${(slotsFire / N).toFixed(2)} vs plants ${(slotsPlants / N).toFixed(2)}` });
}

// SC-02 fire vs water attacks create smoke
{
  let withSmoke = 0, clashes = 0, smokeTotal = 0;
  for (let s = 0; s < N; s++) {
    const b = new Battle({ seed: s, arena: arenaSpec("meadow", s), teams: [team("fire", [makeArchetype(ARCHETYPES.fireSniper, s)]), team("water", [makeArchetype(ARCHETYPES.waterSniper, s + 1000)])] });
    const r = b.run();
    const smoke = r.reactions.smoke ?? 0;
    smokeTotal += smoke;
    if (smoke > 0) withSmoke++;
    clashes += b.events.filter((e) => e.type === "clash").length;
  }
  out.push({ id: "SC-02", title: "Fire vs water attacks create smoke", metric: "battles with >= 1 smoke cloud", value: `${withSmoke}/${N} (${smokeTotal} clouds, ${clashes} mid-air clashes)`, expect: ">= 80% of battles", pass: withSmoke / N >= 0.8, note: "smoke = fire meets water: projectile clash, fire on a wet target, or fire on water ground" });
}

// SC-03 electric conduction by ground: water > muddy water > stone
{
  const grounds: GroundId[] = ["water", "muddyWater", "stone"];
  const avg: Record<string, number> = {};
  for (const g of grounds) {
    let sum = 0, n = 0;
    for (let s = 0; s < Math.max(30, N / 3); s++) {
      const caster = makeArchetype({ ...ARCHETYPES.electricBolt, moves: ["sparkBolt", "staticFang"] }, s);
      const dummy = makeArchetype({ ...ARCHETYPES.heavyTarget, moves: ["tackle"] }, s + 500);
      const b = new Battle({ seed: s, arena: { ...arenaSpec("city", s), weather: "clear" }, teams: [team("volt", [caster]), team("dummy", [dummy])], maxTime: 25 });
      b.arena.setGround(0, 0, 60, g);
      b.arena.waterLevel = g === "stone" ? -100 : 2;
      for (let i = 0; i < b.arena.heights.length; i++) b.arena.heights[i] = 0;
      b.run();
      for (const e of b.events) {
        if (e.type === "hit" && e.element === "electric" && e.a === 0 && e.label !== "conduction") {
          sum += e.value ?? 0;
          n++;
        }
      }
    }
    avg[g] = n ? sum / n : 0;
  }
  const ok = avg.water > avg.muddyWater && avg.muddyWater > avg.stone;
  out.push({ id: "SC-03", title: "Electric connects on water, less on muddy water, least on stone", metric: "mean electric damage per hit", value: grounds.map((g) => `${g} ${avg[g].toFixed(1)}`).join(" > "), expect: "water > muddyWater > stone", pass: ok, note: "conductivity water 1.6 (x1.3 wet), muddy water 1.25, stone 0.7" });
}

// SC-04 flyers cannot be hit by ground-tagged quakes
{
  let quakeHitsOnFlyers = 0, quakes = 0;
  for (let s = 0; s < Math.max(30, N / 3); s++) {
    const q = makeArchetype({ ...ARCHETYPES.quaker, level: 35, moves: ["quake", "stomp", "rockToss", "boulderCrush"] }, s);
    const f = makeArchetype({ ...ARCHETYPES.flyer, moves: ["takeFlight", "airCutter", "galeSlash"] }, s + 77);
    const b = new Battle({ seed: s, arena: arenaSpec("canyon", s), teams: [team("quake", [q]), team("fly", [f])] });
    b.run();
    for (const e of b.events) {
      if (e.type === "phase" && e.label === "charge" && e.move === "quake") quakes++;
    }
    const flyerIdx = 1;
    quakeHitsOnFlyers += b.events.filter((e) => e.type === "hit" && e.move === "quake" && e.b === flyerIdx && b.fighters[flyerIdx].body.mode === "fly").length;
  }
  out.push({ id: "SC-04", title: "Flyers dodge ground quakes", metric: "quake hits landed on an airborne target", value: `${quakeHitsOnFlyers} (quakes cast: ${quakes})`, expect: "0", pass: quakeHitsOnFlyers === 0, note: "ground-tagged moves skip targets in fly mode" });
}

// SC-05 diggers need diggable ground
{
  const res: Record<string, { fails: number; digs: number }> = {};
  for (const ground of ["soil", "stone"] as GroundId[]) {
    let fails = 0, digs = 0;
    for (let s = 0; s < 30; s++) {
      const d = makeArchetype({ ...ARCHETYPES.digger, moves: ["burrow", "boulderCrush"] }, s);
      const t = makeArchetype({ ...ARCHETYPES.heavyTarget, moves: ["tackle"] }, s + 9);
      const b = new Battle({ seed: s, arena: arenaSpec("meadow", s), teams: [team("dig", [d]), team("t", [t])], maxTime: 30 });
      b.arena.setGround(0, 0, 60, ground);
      b.run();
      digs += b.events.filter((e) => e.type === "status" && e.label === "burrowed").length;
      fails += b.events.filter((e) => e.type === "fail").length;
    }
    res[ground] = { fails, digs };
  }
  out.push({ id: "SC-05", title: "Diggers need diggable ground", metric: "burrows / failed digs", value: `soil ${res.soil.digs}/${res.soil.fails}, stone ${res.stone.digs}/${res.stone.fails}`, expect: "soil burrows > 0; stone burrows = 0", pass: res.soil.digs > 0 && res.stone.digs === 0, note: "the AI only picks dig on diggable ground; a dig cast that lands on stone fails" });
}

// SC-06 random balanced teams: side parity (no first-mover bias)
{
  const rs: BattleResult[] = [];
  const durations: number[] = [];
  for (let s = 0; s < N; s++) {
    const pool = Array.from({ length: 14 }, (_, i) => createGenemon({ seed: s * 1000 + i, level: 20 }));
    const A = autoTeam(pool.slice(0, 7), "A", s), B = autoTeam(pool.slice(7), "B", s + 1);
    const r = new Battle({ seed: s, arena: arenaSpec("meadow", s), teams: s % 2 ? [A, B] : [B, A] }).run();
    rs.push(r);
    durations.push(r.duration);
  }
  const d = decisive(rs, 0);
  durations.sort((a, b) => a - b);
  out.push({ id: "SC-06", title: "Random teams: side 0 vs side 1 parity", metric: "side-0 win rate (decisive)", value: `${(d.p * 100).toFixed(1)}% [${(d.lo * 100).toFixed(0)}-${(d.hi * 100).toFixed(0)}] n=${d.n} draws=${d.draws}`, expect: "CI contains 50%", pass: d.lo <= 0.5 && d.hi >= 0.5, note: `duration p10 ${durations[Math.floor(N * 0.1)].toFixed(1)}s, median ${durations[Math.floor(N / 2)].toFixed(1)}s, p90 ${durations[Math.floor(N * 0.9)].toFixed(1)}s` });
}

const lines = [
  "# Scenario report",
  "",
  `Generated by \`deno task scenarios ${N}\`. Each row is MEASURED by running the deterministic battle engine.`,
  "",
  "| id | scenario | metric | measured | expected | pass |",
  "|---|---|---|---|---|---|",
  ...out.map((o) => `| ${o.id} | ${o.title} | ${o.metric} | ${o.value} | ${o.expect} | ${o.pass ? "PASS" : "FAIL"} |`),
  "",
  "## Notes",
  ...out.map((o) => `- **${o.id}**: ${o.note}`),
  "",
];
await Deno.mkdir("artifacts/scenarios", { recursive: true });
await Deno.writeTextFile("artifacts/scenarios/REPORT.md", lines.join("\n"));
await Deno.writeTextFile("artifacts/scenarios/report.json", JSON.stringify(out, null, 2));
console.log(lines.join("\n"));
if (out.some((o) => !o.pass)) Deno.exitCode = 1;
