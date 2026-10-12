// Persona simulator invariants (src/sim/simulate.ts): determinism, seed sensitivity, the physical
// gate, a zero-sum shared ladder and timetable discipline. Short runs (2-3 days) keep the suite fast.
import { assert, assertAlmostEquals, assertEquals } from "./_assert.ts";
import { type GEvent, Ledger } from "../src/core/ledger.ts";
import { EXPERIENCES, type ExperienceId } from "../src/data/lifestyle.ts";
import { type Persona, personaById, PERSONAS, playBlocks } from "../src/sim/personas.ts";
import { simulate } from "../src/sim/simulate.ts";

const START = Date.UTC(2026, 9, 4, 22, 0, 0); // Monday 2026-10-05 00:00 Paris (UTC+2)
const OFF = 2 * 3_600_000, DAY = 86_400_000;
const DAYS = 2 / 7; // two days

function recorded(opts: { weeks: number; seed: number; personas?: Persona[] }) {
  const ledger = new Ledger("sim-test", 1);
  const rows: GEvent[] = [];
  ledger.subscribe((r) => rows.push(r));
  const report = simulate({ ...opts, startMs: START, ledger, battlesPerSession: 2 });
  return { report, rows };
}

const base = recorded({ weeks: DAYS, seed: 1 });

Deno.test("sim: same seed -> identical report and identical ledger", () => {
  const again = recorded({ weeks: DAYS, seed: 1 });
  assertEquals(JSON.stringify(again.report), JSON.stringify(base.report), "report");
  assertEquals(again.rows.length, base.rows.length, "row count");
  assertEquals(JSON.stringify(again.rows.slice(-50)), JSON.stringify(base.rows.slice(-50)), "last rows");
});

Deno.test("sim: a different seed changes seed-sensitive outcomes", () => {
  const other = recorded({ weeks: DAYS, seed: 2 }).report;
  const sig = (r: typeof base.report) => JSON.stringify(r.personas.map((p) => [p.sessions, p.battles, p.caught, p.favouriteMoves, p.rating]));
  assert(sig(other) !== sig(base.report), "seed 2 should not replay seed 1");
  assert(base.report.meta.rows > 0 && other.meta.rows > 0, "both runs emit rows");
});

Deno.test("sim: a sofa-only persona never performs a physical action", () => {
  // Hugo is a desktop/laptop player: every play block is virtual (docs/PERSONAS.md).
  const hugo = personaById("hugo");
  assert(hugo !== undefined, "hugo exists");
  const sofa: Persona = { ...hugo, schedule: hugo.schedule.map((b) => ({ ...b, physical: false })) };
  const { report, rows } = recorded({ weeks: 3 / 7, seed: 5, personas: [sofa, personaById("lea")!] });
  const physical = rows.filter((r) => r.who === "hugo" && r.where.space === "physical");
  assertEquals(physical.length, 0, "no physical row for the sofa persona");
  const denied = rows.filter((r) => r.who === "hugo" && r.what === "sim.action" && r.entries.physical === true);
  assertEquals(denied.length, 0, "no on-site action attempt");
  const lived = rows.filter((r) => r.who === "hugo" && r.what === "genemon.live" && EXPERIENCES[r.entries.experience as ExperienceId]?.physicalOnly);
  assertEquals(lived.length, 0, "no physical-only experience credited");
  const p = report.personas.find((x) => x.id === "hugo")!;
  assertEquals(p.physicalActions, 0, "physicalActions");
  assertEquals(p.caughtOnSite, 0, "caughtOnSite");
  assertEquals(p.physicalHours, 0, "physical hours");
});

Deno.test("sim: the shared ladder is zero-sum across personas", () => {
  const r = recorded({ weeks: 3 / 7, seed: 3 }).report;
  const sum = r.personas.reduce((s, p) => s + p.ratingDelta, 0);
  assertAlmostEquals(sum, 0, 0.5, "sum of rating deltas");
  const rated = r.personas.filter((p) => p.ranked.games > 0);
  if (r.balance.rankedMatches > 0) assert(rated.length >= 2, "rated matches involve two personas");
  const games = r.personas.reduce((s, p) => s + p.ranked.games, 0);
  assertEquals(games, 2 * r.balance.rankedMatches, "each rated match counted on both sides");
});

Deno.test("sim: every persona plays only inside its own timetable", () => {
  const { report, rows } = recorded({ weeks: DAYS, seed: 1 });
  const starts = rows.filter((r) => r.what === "sim.session.start");
  assert(starts.length > 0, "sessions happened");
  for (const row of starts) {
    const p = personaById(row.who)!;
    const local = row.when + OFF;
    const weekday = ((Math.floor(local / DAY) + 3) % 7 + 7) % 7;
    const start = Number(row.entries.start) / 60, end = Number(row.entries.end) / 60;
    assertEquals(Number(row.entries.weekday), weekday, "weekday");
    const inside = playBlocks(p, weekday).some((b) => b.start <= start + 1e-9 && end <= b.end + 1e-9 && b.physical === row.entries.physical);
    assert(inside, `${p.id} session ${start}-${end} on day ${weekday} is outside its play blocks`);
  }
  // the hour histogram agrees: no minutes in hours with no play block at all
  for (const p of report.personas) {
    const persona = personaById(p.id)!;
    const allowed = new Set<number>();
    for (let d = 0; d < 7; d++) for (const b of playBlocks(persona, d)) for (let h = Math.floor(b.start); h < Math.ceil(b.end); h++) allowed.add(h);
    p.hoursByHour.forEach((x, h) => assert(x === 0 || allowed.has(h), `${p.id} played at hour ${h}`));
  }
});

Deno.test("sim: every action leaves a ledger row and personas cover the roster", () => {
  const { report, rows } = base;
  assertEquals(report.personas.length, PERSONAS.length, "12 personas");
  assertEquals(rows.length, report.meta.rows, "report counts every row");
  for (const p of report.personas) {
    const sessions = rows.filter((r) => r.who === p.id && r.what === "sim.session.start").length;
    assertEquals(sessions, p.sessions, `${p.id} sessions are rows`);
    const catches = rows.filter((r) => r.who === p.id && r.what === "genemon.catch").length;
    assertEquals(catches, p.caught, `${p.id} catches are rows`);
  }
});
