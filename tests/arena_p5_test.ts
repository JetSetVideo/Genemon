// [P5-W1] arenas: height levels, altitude, prop density / cover, symmetric ranked maps, spawn slots.
import { assert, assertAlmostEquals, assertEquals } from "./_assert.ts";
import { Rng } from "../src/core/rng.ts";
import { GROUND_IDS, GROUNDS } from "../src/data/grounds.ts";
import {
  type Arena,
  ARENA_INFO,
  ARENA_KINDS,
  type ArenaKind,
  type ArenaSymmetry,
  generateArena,
  PROP_DEFS,
  rankedSymmetry,
  SPAWN_SLOTS,
  spawnAnchor,
  terrace,
} from "../src/world/arena.ts";
import { arenaStats } from "../src/world/arenaStats.ts";

const gen = (kind: ArenaKind, seed: number, symmetry: ArenaSymmetry = "none", density?: number) =>
  generateArena({ seed, kind, weather: ARENA_INFO[kind].weathers[0], hour: 12, symmetry, density });

const SEEDS = [1, 7, 4242];

/** Largest |h(x,z) - h(image)| over the grid (exact index image) and over random points (bilinear). */
function asymmetry(a: Arena, sym: Exclude<ArenaSymmetry, "none">): { grid: number; ground: number; sampled: number } {
  const n = a.n;
  let grid = 0, ground = 0, sampled = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      const m = sym === "mirror" ? j * n + (n - 1 - i) : (n - 1 - j) * n + (n - 1 - i);
      grid = Math.max(grid, Math.abs(a.heights[k] - a.heights[m]));
      if (a.grounds[k] !== a.grounds[m]) ground++;
    }
  }
  const rng = new Rng(99);
  for (let t = 0; t < 400; t++) {
    const x = rng.range(-a.radius, a.radius), z = rng.range(-a.radius, a.radius);
    const hx = sym === "mirror" ? a.heightAt(-x, z) : a.heightAt(-x, -z);
    sampled = Math.max(sampled, Math.abs(a.heightAt(x, z) - hx));
  }
  return { grid, ground, sampled };
}

Deno.test("[P5-W1] mirror and rotational arenas are exactly symmetric: heights, grounds, props, spawns", () => {
  for (const sym of ["mirror", "rotational"] as const) {
    for (const kind of ARENA_KINDS) {
      for (const seed of SEEDS) {
        const a = gen(kind, seed, sym);
        const tag = `${sym} ${kind}/${seed}`;
        const d = asymmetry(a, sym);
        assertEquals(d.grid, 0, `${tag} grid heights`);
        assertEquals(d.ground, 0, `${tag} grounds`);
        assert(d.sampled < 1e-4, `${tag} heightAt(x,z) vs image: ${d.sampled}`);
        // Every prop has its image (same kind and scale) in the list.
        for (const p of a.props) {
          const ix = -p.x, iz = sym === "mirror" ? p.z : -p.z;
          assert(a.props.some((q) => q.kind === p.kind && Math.abs(q.x - ix) < 1e-9 && Math.abs(q.z - iz) < 1e-9 && q.scale === p.scale), `${tag} prop ${p.kind} at ${p.x.toFixed(2)},${p.z.toFixed(2)} has no image`);
        }
        for (const p of a.plateaus) {
          const ix = -p.x, iz = sym === "mirror" ? p.z : -p.z;
          assert(a.plateaus.some((q) => Math.abs(q.x - ix) < 1e-9 && Math.abs(q.z - iz) < 1e-9 && q.r === p.r) || Math.hypot(ix - p.x, iz - p.z) < 0.5, `${tag} plateau image`);
        }
        assertEquals(a.spawns.side0.length, SPAWN_SLOTS.length, `${tag} spawn count`);
        a.spawns.side0.forEach((s0, i) => {
          const s1 = a.spawns.side1[i];
          assertAlmostEquals(s1.x, -s0.x, 1e-9, `${tag} spawn ${i} x`);
          assertAlmostEquals(s1.z, sym === "mirror" ? s0.z : -s0.z, 1e-9, `${tag} spawn ${i} z`);
          assertAlmostEquals(s1.y, s0.y, 1e-4, `${tag} spawn ${i} starts at the same height`);
          assertEquals(a.groundIdAt(s1.x, s1.z), a.groundIdAt(s0.x, s0.z), `${tag} spawn ${i} same ground`);
        });
      }
    }
  }
});

Deno.test("[P5-W1] FALSIFIER: a free (symmetry none) arena is measurably asymmetric", () => {
  let worst = 0;
  for (const kind of ARENA_KINDS) worst = Math.max(worst, asymmetry(gen(kind, 7), "mirror").grid);
  assert(worst > 0.3, `the symmetry metric must be able to fail (max mirror gap ${worst})`);
  // And breaking one cell of a symmetric arena is caught.
  const a = gen("meadow", 7, "mirror");
  a.heights[5 * a.n + 3] += 0.5;
  assert(asymmetry(a, "mirror").grid >= 0.5, "a tampered cell is detected");
});

Deno.test("[P5-W1] rankedSymmetry: deterministic, always symmetric, both kinds occur, beach mirrors", () => {
  const seen = new Set<string>();
  for (let seed = 0; seed < 60; seed++) {
    for (const kind of ARENA_KINDS) {
      const s = rankedSymmetry(kind, seed);
      assertEquals(rankedSymmetry(kind, seed), s, "deterministic");
      assert(s === "mirror" || s === "rotational", s);
      seen.add(s);
    }
    assertEquals(rankedSymmetry("beach", seed), "mirror");
  }
  assertEquals(seen.size, 2);
});

Deno.test("[P5-W1] altitude: every kind has a base altitude, overridable, and altitudeAt adds the terrain", () => {
  for (const kind of ARENA_KINDS) {
    const a = gen(kind, 3);
    assert(Number.isFinite(ARENA_INFO[kind].altitudeM), kind);
    assertEquals(a.altitudeM, ARENA_INFO[kind].altitudeM);
    assertAlmostEquals(a.altitudeAt(1.5, -2), a.altitudeM + a.heightAt(1.5, -2), 1e-9);
  }
  assert(ARENA_INFO.volcano.altitudeM > ARENA_INFO.meadow.altitudeM && ARENA_INFO.meadow.altitudeM > ARENA_INFO.beach.altitudeM, "volcano > meadow > beach");
  const hi = generateArena({ seed: 3, kind: "meadow", weather: "clear", hour: 12, altitudeM: 2800 });
  assertEquals(hi.altitudeM, 2800);
  assertEquals(arenaStats(hi).altitudeM, 2800);
});

Deno.test("[P5-W1] height levels: terraced bands (>= 3 bands over 3 % of the floor except the flat swamp)", () => {
  // terrace(): flat treads at multiples of the step.
  assertAlmostEquals(terrace(0.1, 1, 0.4), 0, 1e-9);
  assertAlmostEquals(terrace(0.9, 1, 0.4), 1, 1e-9);
  assertAlmostEquals(terrace(-1.05, 1, 0.4), -1, 1e-9);
  assertEquals(terrace(0.37, 0, 0.5), 0.37, "step 0 = identity");
  for (const kind of ARENA_KINDS) {
    if (kind === "swamp") continue;
    for (const seed of SEEDS) {
      const s = arenaStats(gen(kind, seed));
      const sum = s.levels.bands.reduce((t, b) => t + b.share, 0);
      assertAlmostEquals(sum, 1, 1e-9, `${kind} band shares`);
      const bands = s.levels.bands.filter((b) => b.share >= 0.03).length;
      assert(bands >= 3, `${kind}/${seed}: ${bands} bands ${JSON.stringify(s.levels.bands.map((b) => [b.level, b.share.toFixed(2)]))}`);
    }
  }
  // Plateaus exist, are raised, and stay off the water.
  // The top stands above the foot of its ramp (towards the centre) for most plateaus (terrain relief
  // and canyon walls may tilt a few).
  let plateaus = 0, raised = 0;
  for (const kind of ARENA_KINDS) {
    for (const seed of SEEDS) {
      const a = gen(kind, seed);
      for (const p of a.plateaus) {
        plateaus++;
        assert(!a.groundAt(p.x, p.z).liquid, `${kind} plateau on liquid`);
        const foot = a.heightAt(p.x + Math.cos(p.rampAngle) * (p.r + 3.5), p.z + Math.sin(p.rampAngle) * (p.r + 3.5));
        if (a.heightAt(p.x, p.z) >= foot + a.levelStep * 0.5) raised++;
      }
    }
  }
  assert(plateaus >= 25, `plateaus generated: ${plateaus}`);
  assert(raised / plateaus >= 0.75, `raised plateaus ${raised}/${plateaus}`);
});

Deno.test("[P5-W1] density: interior props scale with spec.density, avoid lava / liquids / spawn corridors", () => {
  for (const kind of ARENA_KINDS) {
    for (const seed of SEEDS) {
      const zero = gen(kind, seed, "none", 0);
      const one = gen(kind, seed, "none", 1);
      const two = gen(kind, seed, "none", 2);
      // Density 0 leaves only the legacy rim landmarks (drawn at >= 0.78 R), none in the open floor.
      for (const p of zero.innerProps()) assert(Math.hypot(p.x, p.z) >= zero.radius * 0.78 - 1e-9, `${kind}/${seed} density 0 prop at ${Math.hypot(p.x, p.z).toFixed(1)} m`);
      assert(one.innerProps().length > zero.innerProps().length, `${kind}/${seed} density 1 adds interior props`);
      assert(two.innerProps().length >= one.innerProps().length, `${kind}/${seed} density 2 >= 1`);
      for (const p of one.innerProps()) {
        const g = one.groundIdAt(p.x, p.z);
        assert(g !== "lava", `${kind} prop on lava`);
        if (Math.hypot(p.x, p.z) < one.radius * 0.76) {
          if (p.kind === "reed") assert(GROUNDS[g].liquid || g === "mud", `${kind} reeds on dry ${g}`);
          else assert(!GROUNDS[g].liquid, `${kind} ${p.kind} on ${g}`);
        }
        assertAlmostEquals(p.radius, PROP_DEFS[p.kind].radius * p.scale, 1e-9);
      }
      // The legacy start line and every slot stay free of solid props (the formation can stand there).
      for (const s of [...one.spawns.side0, ...one.spawns.side1]) {
        for (const p of one.innerProps()) {
          if (p.solid) assert(Math.hypot(p.x - s.x, p.z - s.z) > p.radius + 1.5, `${kind}/${seed} ${p.kind} blocks a spawn`);
        }
      }
    }
  }
  const forest = arenaStats(gen("forest", 7)), swamp = arenaStats(gen("swamp", 7));
  assert(forest.cover.inner > swamp.cover.inner, "the forest is denser than the swamp");
  assert(forest.cover.per100m2 > 0 && forest.cover.kinds[0].kind === "tree", JSON.stringify(forest.cover));
});

Deno.test("[P5-W1] lava stays inside the crater (the lava sheet radius) for every symmetry", () => {
  const lava = GROUND_IDS.indexOf("lava");
  for (const sym of ["none", "mirror", "rotational"] as const) {
    for (const seed of [...SEEDS, 303]) {
      const a = gen("volcano", seed, sym);
      let cells = 0;
      for (let j = 0; j < a.n; j++) {
        for (let i = 0; i < a.n; i++) {
          if (a.grounds[j * a.n + i] !== lava) continue;
          cells++;
          const d = Math.hypot(i * a.cell - a.half, j * a.cell - a.half);
          assert(d < a.radius * 0.135, `lava at ${d.toFixed(2)} m (${sym}/${seed})`);
        }
      }
      assert(cells > 0, "the crater has lava");
    }
  }
});

Deno.test("[P5-W1] spawnAnchor: slot 0 is the legacy start line bit for bit; slots scale; bad slots fall back", () => {
  for (const sym of ["none", "mirror", "rotational"] as const) {
    const a = gen("canyon", 11, sym);
    for (const gap of [2.5, 3.7, a.radius * 0.3]) {
      const l = spawnAnchor(a, 0, 0, gap), r = spawnAnchor(a, 1, 0, gap);
      assertEquals(l.x, -gap);
      assertEquals(l.z, 0);
      assertEquals(r.x, gap);
      assertEquals(r.z, 0);
      for (let i = 1; i < SPAWN_SLOTS.length; i++) {
        const p = spawnAnchor(a, 0, i, gap), q = spawnAnchor(a, 1, i, gap);
        assertAlmostEquals(Math.hypot(p.x, p.z) / gap, Math.hypot(SPAWN_SLOTS[i].ux, SPAWN_SLOTS[i].uz) / -SPAWN_SLOTS[0].ux, 1e-9, `slot ${i} proportion`);
        assertAlmostEquals(q.x, -p.x, 1e-9);
        assertAlmostEquals(q.z, sym === "rotational" ? -p.z : p.z, 1e-9);
      }
    }
    assertEquals(spawnAnchor(a, 0, 99, 3), spawnAnchor(a, 0, 0, 3));
    assertEquals(spawnAnchor(a, 0, -1, 3), spawnAnchor(a, 0, 0, 3));
    assertEquals(spawnAnchor(a, 0, 1.5, 3), spawnAnchor(a, 0, 0, 3));
    assertEquals(a.nearestSpawn(a.spawns.side0[2].x + 0.3, a.spawns.side0[2].z, 0, 2), 2);
    assertEquals(a.nearestSpawn(0, 0, 0, 1), null);
  }
});

Deno.test("[P5-W1] solid props: collideProps pushes a body out, propOnSegment finds cover between two points", () => {
  const a = gen("forest", 7);
  const p = a.innerProps().find((q) => q.solid)!;
  assert(p, "a solid interior prop");
  const b = { pos: { x: p.x + 0.05, y: 0, z: p.z }, vel: { x: -2, y: 0, z: 0 }, radius: 0.5 };
  assert(a.collideProps(b) >= 1, "touching");
  assert(Math.hypot(b.pos.x - p.x, b.pos.z - p.z) >= p.radius + 0.4 - 1e-9, "pushed out");
  assert(b.vel.x >= 0, "inward velocity removed");
  const far = { pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, radius: 0.5 };
  assertEquals(a.collideProps(far), 0, "the centre is clear");
  const hit = a.propOnSegment(p.x - 3, p.z, p.x + 3, p.z);
  assert(hit !== null, "a prop between two points is cover");
  assertEquals(a.propOnSegment(p.x - 3, p.z + 40, p.x + 3, p.z + 40), null, "no cover far away");
});

Deno.test("[P5-W1] deterministic: same spec = same arena; seeds and symmetry change it", () => {
  const dump = (a: Arena) => JSON.stringify({ h: Array.from(a.heights), g: Array.from(a.grounds), p: a.props, s: a.spawns, pl: a.plateaus });
  for (const kind of ARENA_KINDS) {
    assertEquals(dump(gen(kind, 5, "mirror")), dump(gen(kind, 5, "mirror")), kind);
    assert(dump(gen(kind, 5)) !== dump(gen(kind, 6)), `${kind} seed`);
    assert(dump(gen(kind, 5)) !== dump(gen(kind, 5, "mirror")), `${kind} symmetry`);
  }
});
