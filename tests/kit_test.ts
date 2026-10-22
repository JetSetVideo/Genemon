// Pass-4 move kit [P4-M1..M7]: categories, body-part power, limited learnsets, phase law, counters,
// the League-style 4-slot kit builder and the ~47 kit moves.
import { assert, assertEquals } from "./_assert.ts";
import { isDamaging, MOVE_BY_ID, MOVES, moveCost, st, type BodyPart, type Move } from "../src/combat/moves.ts";
import {
  ALL_MOVE_BY_ID,
  ALL_MOVES,
  bodyFactor,
  buildKit,
  categoryOf,
  counterValue,
  fieldStatus,
  interrupts,
  KIT_MOVES,
  kitSummary,
  learnCheck,
  partOf,
  phaseLaw,
  retimed,
  slotOf,
  utilityValue,
} from "../src/combat/kit.ts";
import { hashSeed } from "../src/core/rng.ts";
import { createGenemon, phenotypeOf } from "../src/genome/genemon.ts";
import type { Phenotype } from "../src/genome/phenotype.ts";
import { ANIM_CHANNELS, type MorphHelix } from "../src/genome/morphTypes.ts";

const pop = (n: number, level: number, base = 7000): Phenotype[] =>
  Array.from({ length: n }, (_, i) => phenotypeOf(createGenemon({ seed: base + i, level })));
const K = (id: string): Move => ALL_MOVE_BY_ID[id];

function helixWith(over: Partial<MorphHelix>): MorphHelix {
  const anim = Object.fromEntries(ANIM_CHANNELS.map((c) => [c, { lo: 0, hi: 1, value: 0.5 }])) as MorphHelix["anim"];
  return {
    version: 1,
    asymmetry: 0,
    asymmetricSide: 1,
    asymmetricParts: [],
    fractalDepth: 2,
    digits: 4,
    clawLength: 0.5,
    eyes: { style: "round", pupil: "full", size: 0.28, count: 2, irisColor: 0, scleraColor: 0xffffff, glow: 0, aura: "none", lidAngle: 0 },
    mouth: { width: 0.65, teeth: "fangs", teethCount: 6, toothLength: 0.3, tongue: true },
    wings: { kind: "none", span: 0, fingers: 0, detail: 0 },
    surface: { bump: 0.5, patternScale: 1, patternContrast: 0.5, plates: 0, sheen: 0.3, fur: 0.2 },
    fusion: 0.5,
    angularity: 0.5,
    anim,
    ...over,
  };
}

Deno.test("[SPEC M1] every kit move declares category, part and slot; legacy moves get sensible defaults", () => {
  assert(KIT_MOVES.length >= 40, `only ${KIT_MOVES.length} kit moves`);
  for (const m of KIT_MOVES) {
    assert(m.category && m.part && m.slot, `${m.id} lacks category/part/slot`);
    if (m.shape === "cone") {
      assert(m.category === "special" && (m.part === "mouth" || m.part === "eyes"), `${m.id} cone`);
      assert(m.arc !== undefined && m.arc >= 0.35 && m.arc <= 0.6 && m.range >= 4 && m.range <= 7, `${m.id} cone geometry`);
    }
    if (m.shape === "dash") assert(m.slot === "mobility" && m.category === "physical" && m.range >= 6 && m.range <= 10, `${m.id} dash`);
    if (m.slot === "ultimate") assert(m.tier === 3 && m.power >= 110 && m.power <= 160, `${m.id} ultimate`);
  }
  assertEquals([categoryOf(K("tackle")), partOf(K("tackle")), slotOf(K("tackle"))], ["physical", "mass", "basic"]);
  assertEquals([categoryOf(K("cinderSpit")), partOf(K("cinderSpit"))], ["special", "mouth"]);
  assertEquals([categoryOf(K("venomFang")), partOf(K("venomFang"))], ["physical", "jaw"]);
  assertEquals([categoryOf(K("shadowClaw")), partOf(K("shadowClaw"))], ["physical", "claws"]);
  assertEquals(partOf(K("ironRam")), "horns");
  assertEquals(partOf(K("prismRay")), "eyes");
  assertEquals([categoryOf(K("rest")), slotOf(K("rest"))], ["status", "utility"]);
  assertEquals(slotOf(K("takeFlight")), "mobility");
  assertEquals(slotOf(K("infernoBurst")), "ultimate");
  assertEquals(slotOf(K("roar")), "control");
  assertEquals(slotOf(K("cinderSpit")), "basic");
});

Deno.test("[SPEC M1] ids unique across ALL_MOVES and every kit move is affordable from a full energy bar", () => {
  const ids = ALL_MOVES.map((m) => m.id);
  assertEquals(new Set(ids).size, ids.length, "duplicate ids");
  assertEquals(ALL_MOVES.length, MOVES.length + KIT_MOVES.length);
  for (const m of KIT_MOVES) {
    assert(!MOVE_BY_ID[m.id], `${m.id} collides with a legacy id`);
    assert(moveCost(m) < 100, `${m.id} costs ${moveCost(m)} >= the 100 energy pool`);
  }
});

Deno.test("[SPEC M5] phase law: monotone, anchored, ultimates >= 3x slower to charge than the fastest basic", () => {
  let prev = phaseLaw(0);
  for (let p = 1; p <= 220; p++) {
    const t = phaseLaw(p);
    assert(t.charge >= prev.charge && t.active >= prev.active && t.rest >= prev.rest, `not monotone at ${p}`);
    prev = t;
  }
  for (const [a, b] of [[0, 1], [1, 3], [3, 6]]) {
    assert(phaseLaw(80, b).charge >= phaseLaw(80, a).charge, "area must lengthen");
    assert(phaseLaw(80, 0, b).rest >= phaseLaw(80, 0, a).rest, "effects must lengthen");
  }
  const near = (x: number, y: number) => Math.abs(x - y) <= 0.1 * y + 0.02;
  const w = phaseLaw(28), m = phaseLaw(60), s = phaseLaw(140);
  assert(near(w.charge, 0.25) && near(w.active, 0.12) && near(w.rest, 0.3), JSON.stringify(w));
  assert(near(m.charge, 0.6) && near(m.active, 0.25) && near(m.rest, 0.6), JSON.stringify(m));
  assert(near(s.charge, 2.4) && near(s.active, 0.9) && near(s.rest, 2.0), JSON.stringify(s));
  const basics = KIT_MOVES.filter((x) => x.slot === "basic");
  const fastest = Math.min(...basics.map((x) => x.charge));
  for (const u of KIT_MOVES.filter((x) => x.slot === "ultimate")) assert(u.charge >= 3 * fastest, `${u.id} charge ${u.charge} < 3 x ${fastest}`);
});

Deno.test("[SPEC M5] kit rows follow the law within 15 %; retimed keeps the move's identity", () => {
  for (const x of KIT_MOVES) {
    const t = phaseLaw(x.power, x.area, x.effects.length);
    for (const k of ["charge", "active", "rest"] as const) assert(Math.abs(x[k] - t[k]) <= 0.15 * t[k], `${x.id}.${k} ${x[k]} vs law ${t[k]}`);
  }
  const r = retimed(K("solarBeam"));
  assertEquals([r.id, r.power, r.effects.length, r.shape], ["solarBeam", 140, 0, "beam"]);
  assertEquals(r.charge, phaseLaw(140, 0, 0).charge);
  assert(retimed(K("rest")) === K("rest"), "utility moves are not retimed");
});

Deno.test("[SPEC M5] legacy damaging rows are re-timed by the law at the source; dig, terrain and utility keep theirs", () => {
  let lawed = 0;
  for (const m of MOVES) {
    const t = phaseLaw(m.power, m.area, m.effects.length);
    const onLaw = m.charge === t.charge && m.active === t.active && m.rest === t.rest;
    const exempt = !isDamaging(m) || m.shape === "dig" || m.shape === "terrain";
    if (!exempt) {
      assert(onLaw, `${m.id} is damaging but off the law: ${m.charge}/${m.active}/${m.rest} vs ${JSON.stringify(t)}`);
      lawed++;
    }
  }
  assert(lawed >= 55, `only ${lawed} legacy rows re-timed`);
  assertEquals(MOVE_BY_ID.burrow.active, 2.2, "the dig keeps its time underground");
  assertEquals(MOVE_BY_ID.rainCall.charge, 1.4, "a weather call keeps its hand timing");
  // Photon Dart was faster than the law for its power (12.8 % of all casts): no longer.
  assert(MOVE_BY_ID.photonDart.charge >= phaseLaw(46).charge, "photonDart on the law");
});

Deno.test("[SPEC M4][P5-B1] a zone's lingering field re-applies a SOFT status, never a stun / freeze / stagger lock", () => {
  // battle.ts spawnZone re-applies fieldStatus(m) to everyone inside the field; a control zone whose one
  // rider is a stun / freeze is a snap (no field at all). Pass 5: one rider per move, so the old rule
  // "list the soft status first" became "the field only ever carries a soft rider".
  const HARD = new Set(["stunned", "frozen", "staggered"]);
  let snaps = 0;
  for (const m of ALL_MOVES.filter((x) => x.shape === "zone")) {
    const st = fieldStatus(m);
    assert(st === null || !HARD.has(st), `${m.id}: field would lock with ${st}`);
    if (m.effects.some((e) => e.kind === "status" && !e.self && HARD.has(e.status!))) snaps++;
  }
  assert(snaps >= 4, `control zones (stun / freeze riders) ${snaps}`);
  // FALSIFIER: a zone whose rider is a stun yields no field status, a soft rider is kept.
  assertEquals(fieldStatus(K("whirlpool")), null, "whirlpool's rider is its stun: no field status");
  assertEquals(fieldStatus({ ...K("whirlpool"), effects: [st("wet", 0.6, 4)] }), "wet");
  assert(HARD.has(K("whirlpool").effects.find((e) => e.kind === "status" && !e.self)!.status!), "whirlpool still stuns on the cast");
});

Deno.test("[SPEC M4] utility slot: weather / terrain / heal / buff moves are learned again, weather by its element", () => {
  const n = 4000;
  const learned = new Map<string, number>();
  let utilityKits = 0, withControl = 0;
  for (let i = 0; i < n; i++) {
    const ph = phenotypeOf(createGenemon({ seed: hashSeed("kit-utility", i), level: 15 + (i % 20) }));
    const kit = buildKit(ph, `u-${i}`);
    assertEquals(kit.length, 4);
    if (kit.some((id) => slotOf(K(id)) === "utility")) utilityKits++;
    if (slotOf(K(kit[1])) === "control") withControl++;
    for (const id of kit) {
      learned.set(id, (learned.get(id) ?? 0) + 1);
      const m = K(id);
      if (m.shape === "weather") {
        assert(ph.abilities.weatherShaper, `${id} learned without weatherShaper`);
        assert(utilityValue(m, ph) > 0, `${id} does not raise ${ph.elements.primary}/${ph.elements.secondary}`);
      }
    }
  }
  const weather = ALL_MOVES.filter((m) => m.shape === "weather");
  assert(weather.length >= 9, "weather calls");
  for (const m of weather) assert((learned.get(m.id) ?? 0) > 0, `${m.id} never learned in ${n} kits`);
  const share = learned.size / ALL_MOVES.length;
  assert(share >= 0.85, `only ${learned.size}/${ALL_MOVES.length} moves learned`);
  // A support slot is common but not the rule: W stays control for most creatures.
  assert(utilityKits >= 0.08 * n && utilityKits <= 0.5 * n, `utility kits ${utilityKits}/${n}`);
  assert(withControl >= 0.9 * n, `control ${withControl}/${n}`);
  // utilityValue: Rain helps water, not fire; a buff and a heal are worth something.
  const ph = phenotypeOf(createGenemon({ seed: 1, level: 30 }));
  const water = { ...ph, elements: { ...ph.elements, primary: "water" as const, secondary: null } };
  const fire = { ...ph, elements: { ...ph.elements, primary: "fire" as const, secondary: null } };
  assert(utilityValue(K("rainCall"), water) > 0.9 && utilityValue(K("rainCall"), fire) === 0, "rain for water only");
  assert(utilityValue(K("rest"), ph) > 0 && utilityValue(K("tailwind"), ph) > 0);
});

Deno.test("[SPEC M2] bodyFactor stays in [0.7, 1.35] and averages ~1 per body part over 400 Genemon", () => {
  const phs = pop(400, 35);
  const byPart = new Map<BodyPart, number[]>();
  for (const ph of phs) {
    for (const m of ALL_MOVES) {
      const f = bodyFactor(m, ph);
      assert(f >= 0.7 && f <= 1.35, `${m.id} factor ${f}`);
      if (categoryOf(m) === "status") {
        assertEquals(f, 1);
        continue;
      }
      const part = partOf(m);
      if (!byPart.has(part)) byPart.set(part, []);
      byPart.get(part)!.push(f);
    }
  }
  for (const [part, fs] of byPart) {
    const mean = fs.reduce((s, x) => s + x, 0) / fs.length;
    assert(mean >= 0.9 && mean <= 1.1, `part ${part} mean factor ${mean.toFixed(3)}`);
  }
  assert(byPart.size >= 9, `only ${byPart.size} parts covered`);
});

Deno.test("[SPEC M2] a big mouth breathes harder, a heavy body crushes harder, a helix mouth is read", () => {
  const ph = pop(1, 35, 4242)[0];
  const big = { ...ph, plan: { ...ph.plan, jaw: 0.95, head: 0.9 } };
  const small = { ...ph, plan: { ...ph.plan, jaw: 0.1, head: 0.15 } };
  assert(bodyFactor(K("fireBreath"), big) > bodyFactor(K("fireBreath"), small), "mouth width must scale Fire Breath");
  const heavy = { ...ph, massKg: ph.massKg * 3 };
  const light = { ...ph, massKg: ph.massKg / 3 };
  assert(bodyFactor(K("crushingWeight"), heavy) > bodyFactor(K("crushingWeight"), light), "mass must scale Crushing Weight");
  const wide = helixWith({ mouth: { width: 1, teeth: "fangs", teethCount: 6, toothLength: 0.3, tongue: true } });
  const narrow = helixWith({ mouth: { width: 0.3, teeth: "fangs", teethCount: 6, toothLength: 0.3, tongue: true } });
  assert(bodyFactor(K("fireBreath"), ph, wide) > bodyFactor(K("fireBreath"), ph, narrow), "helix mouth width");
  assertEquals(bodyFactor(K("rest"), big), 1);
});

Deno.test("[SPEC M3] learnCheck refuses with human reasons: level, horns, size, energy, element, claws", () => {
  const young = pop(1, 5, 31)[0];
  const ultRes = learnCheck(K("titanSlam"), young);
  assert(!ultRes.ok && ultRes.reasons.some((r) => r.includes("level")), JSON.stringify(ultRes));
  const ph = pop(1, 35, 77)[0];
  const hornless = { ...ph, plan: { ...ph.plan, horns: 0.1 } };
  const hornRes = learnCheck(K("hornGore"), hornless);
  assert(!hornRes.ok && hornRes.reasons.includes("needs horns"), JSON.stringify(hornRes));
  assert(!learnCheck(K("hornGore"), { ...ph, plan: { ...ph.plan, horns: 0.9 } }).reasons.includes("needs horns"));
  const tiny = { ...ph, sizeClass: "S" as const };
  assert(learnCheck(K("crushingWeight"), tiny).reasons.includes("too small (needs M+)"));
  const tired = { ...ph, stats: { ...ph.stats, regen: 9.1 } };
  assert(learnCheck(K("titanSlam"), tired).reasons.includes("not enough energy (regen 9.1 < 10)"), JSON.stringify(learnCheck(K("titanSlam"), tired)));
  const cold = { ...ph, elements: { ...ph.elements, affinity: { ...ph.elements.affinity, fire: 0.12 } } };
  assert(learnCheck(K("meteor"), cold).reasons.includes("wrong element (fire affinity 0.12 < 0.45)"), JSON.stringify(learnCheck(K("meteor"), cold)));
  assert(learnCheck(K("slice"), ph, helixWith({ digits: 0 })).reasons.includes("needs claws"));
  assert(learnCheck(K("slice"), ph).ok, "a neutral basic is learnable at level 35");
});

Deno.test("[SPEC M3] FALSIFIER: an impossible move is refused and a biased population fails the mean check", () => {
  const ph = pop(1, 35, 5)[0];
  const impossible: Move = { ...K("meteor"), id: "fake", tier: 3, element: "void", requires: { ability: "terraformer", kinds: [] }, part: "horns" };
  const r = learnCheck(impossible, { ...ph, plan: { ...ph.plan, horns: 0 }, abilities: { ...ph.abilities, terraformer: false } });
  assert(!r.ok && r.reasons.length >= 3, JSON.stringify(r));
  // The per-part mean check CAN fail: a population with every horn gene at 1 averages far above 1.1.
  const horned = pop(50, 35).map((p) => ({ ...p, plan: { ...p.plan, horns: 1 } }));
  const mean = horned.reduce((s, p) => s + bodyFactor(K("hornGore"), p), 0) / horned.length;
  assert(mean > 1.1, `biased mean ${mean} should fail the [0.9, 1.1] band`);
});

Deno.test("[SPEC M7] buildKit: deterministic, 4 distinct learnable ids, Q/W/E/R order", () => {
  const phs = pop(300, 35, 9100);
  let control = 0, ultimate = 0, mobility = 0, effect = 0;
  for (let i = 0; i < phs.length; i++) {
    const ph = phs[i];
    const kit = buildKit(ph, `seed-${i}`);
    assertEquals(kit, buildKit(ph, `seed-${i}`), "not deterministic");
    assertEquals(kit.length, 4, `kit ${kit}`);
    assertEquals(new Set(kit).size, 4, `duplicate in ${kit}`);
    for (const id of kit) assert(learnCheck(K(id), ph).ok, `${id} not learnable`);
    const slots = kit.map((id) => slotOf(K(id)));
    if (slots[1] === "control") control++;
    if (slots[2] === "mobility") mobility++;
    if (slots[3] === "ultimate") ultimate++;
    if (kit.some((id) => K(id).effects.some((e) => e.kind === "status" && !e.self))) effect++;
    assertEquals(slotOf(K(kit[0])) === "ultimate", false, "Q must not be an ultimate");
  }
  assert(control >= 0.8 * phs.length, `control ${control}/${phs.length}`);
  assert(ultimate >= 0.6 * phs.length, `ultimate ${ultimate}/${phs.length}`);
  assert(mobility >= 0.6 * phs.length, `mobility ${mobility}/${phs.length}`);
  assert(effect >= 0.9 * phs.length, `special effect ${effect}/${phs.length}`);
  const rows = kitSummary(buildKit(phs[0], "x"));
  assertEquals(rows.length, 4);
  assert(rows.every((r) => r.cost > 0 && r.charge > 0 && r.key.length === 1), JSON.stringify(rows));
});

Deno.test("[SPEC M6] counters: stun beats a charging ultimate, a dash dodges a slow beam, heavy hits punish rest", () => {
  const stun = K("mindLock"), ultimate = K("meteor"), basic = K("slice");
  assert(interrupts(stun) && !interrupts(basic) && !interrupts(ultimate));
  const vsCharge = counterValue(stun, ultimate, "charge", 0.2, 2.0);
  const vsIdle = counterValue(stun, ultimate, "idle", 0, 0);
  assert(vsCharge > vsIdle && vsCharge > 1.3, `stun vs charging ult ${vsCharge}, vs idle ${vsIdle}`);
  assert(vsCharge > counterValue(stun, basic, "charge", 0.5, 0.15), "a long strong charge is the better stun target");
  assert(counterValue(K("quickDash"), K("solarBeam"), "charge", 0.6, 0.8) > 1, "dash vs charging beam");
  assert(counterValue(K("titanSlam"), K("solarBeam"), "rest", 0.1, 2.0) > 1, "ultimate punishes rest");
  assert(counterValue(K("waterJet"), K("fireBreath"), "active", 0.5, 0.2) > 1, "water douses fire");
  assert(counterValue(K("meteor"), K("mindLock"), "charge", 0.1, 0.25) < 1, "long charge into an interrupt is penalised");
  assertEquals(counterValue(basic, null, "idle", 0, 0), 1);
  for (const a of KIT_MOVES) {
    for (const b of KIT_MOVES.slice(0, 12)) {
      for (const ph of ["charge", "active", "rest"] as const) {
        const v = counterValue(a, b, ph, 0.5, 1);
        assert(v >= 0 && v <= 2, `${a.id} vs ${b.id} ${ph}: ${v}`);
      }
    }
  }
});
