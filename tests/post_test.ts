// Pure parts of src/render/post.ts (no WebGL in Deno): the declared settings table, the clamp, the
// quality gate, the auto-focus distance, the critically damped focus spring and the fog restore rule.
import { assert, assertAlmostEquals, assertEquals } from "./_assert.ts";
import * as THREE from "../src/lib/three.ts";
import { atmosphere, clampPost, DEFAULT_POST, focusDistanceFor, gatePost, POST_RANGES, type PostSettings, springStep } from "../src/render/post.ts";

const NUMERIC = ["aperture", "maxBlur", "focusDistance", "bloomStrength", "fogDensity", "vignette"] as const;

Deno.test("post table: every numeric setting is declared once, with min < max and the default inside", () => {
  assertEquals(POST_RANGES.map((r) => r.key).sort(), [...NUMERIC].sort());
  for (const r of POST_RANGES) {
    assert(r.min < r.max, `${r.key}: min < max`);
    assert(r.def >= r.min && r.def <= r.max, `${r.key}: default ${r.def} inside [${r.min}, ${r.max}]`);
    assert(r.step > 0 && r.step <= r.max - r.min, `${r.key}: usable slider step`);
    assertEquals(DEFAULT_POST[r.key], r.def, `${r.key}: DEFAULT_POST follows the table`);
  }
});

Deno.test("clampPost passes the defaults through unchanged and fills a missing / junk object", () => {
  assertEquals(clampPost(DEFAULT_POST), DEFAULT_POST);
  assertEquals(clampPost({}), DEFAULT_POST);
  assertEquals(clampPost(undefined), DEFAULT_POST);
  assertEquals(clampPost(null), DEFAULT_POST);
  assertEquals(clampPost("junk" as unknown as Partial<PostSettings>), DEFAULT_POST);
});

Deno.test("clampPost bounds every numeric key at both ends and replaces non-finite values by the default", () => {
  for (const r of POST_RANGES) {
    assertEquals(clampPost({ [r.key]: r.max + 1000 })[r.key], r.max, `${r.key} high`);
    assertEquals(clampPost({ [r.key]: r.min - 1000 })[r.key], r.min, `${r.key} low`);
    const mid = (r.min + r.max) / 2;
    assertEquals(clampPost({ [r.key]: mid })[r.key], mid, `${r.key} in range kept`);
    for (const bad of [NaN, Infinity, -Infinity, "3" as unknown as number]) {
      assertEquals(clampPost({ [r.key]: bad })[r.key], r.def, `${r.key} ${String(bad)} -> default`);
    }
  }
});

Deno.test("clampPost keeps valid booleans / focus mode and rejects junk ones", () => {
  const off = clampPost({ enabled: false, dof: false, bloom: false, focusMode: "manual" });
  assertEquals([off.enabled, off.dof, off.bloom, off.focusMode], [false, false, false, "manual"]);
  const junk = clampPost({ enabled: 1 as unknown as boolean, dof: "no" as unknown as boolean, focusMode: "macro" as unknown as "auto" });
  assertEquals([junk.enabled, junk.dof, junk.focusMode], [DEFAULT_POST.enabled, DEFAULT_POST.dof, DEFAULT_POST.focusMode]);
  // Every key of the settings is present after a clamp (a profile saved before a key existed migrates).
  assertEquals(Object.keys(clampPost({})).sort(), Object.keys(DEFAULT_POST).sort());
});

Deno.test("FALSIFIER: an out-of-range aperture is clamped (the clamp really runs)", () => {
  const r = POST_RANGES.find((x) => x.key === "aperture")!;
  const input = { ...DEFAULT_POST, aperture: r.max * 50 };
  const out = clampPost(input);
  assert(out.aperture !== input.aperture, "aperture must change");
  assertEquals(out.aperture, r.max);
  assertEquals(input.aperture, r.max * 50, "the input object is not mutated");
});

Deno.test("gatePost: low quality disables the composer, phones drop depth of field only", () => {
  assertEquals(gatePost(DEFAULT_POST, "high", false), DEFAULT_POST);
  assertEquals(gatePost(DEFAULT_POST, "low", false).enabled, false);
  const phone = gatePost(DEFAULT_POST, "high", true);
  assertEquals([phone.enabled, phone.dof, phone.bloom], [true, false, true]);
  assertEquals(gatePost({ aperture: 999 }, "high", false).aperture, 10, "the gate clamps too");
});

Deno.test("focusDistanceFor: median distance, even count averages the middle pair", () => {
  const cam = { x: 0, y: 0, z: 0 };
  assertEquals(focusDistanceFor(cam, [{ x: 3, y: 0, z: 4 }]), 5);
  assertEquals(focusDistanceFor(cam, [{ x: 10, y: 0, z: 0 }, { x: 0, y: 2, z: 0 }, { x: 0, y: 0, z: 7 }]), 7);
  assertEquals(focusDistanceFor(cam, [{ x: 2, y: 0, z: 0 }, { x: 4, y: 0, z: 0 }, { x: 6, y: 0, z: 0 }, { x: 100, y: 0, z: 0 }]), 5);
  // Works with THREE.Vector3 too (the PostFX passes its pooled vectors).
  assertEquals(focusDistanceFor(new THREE.Vector3(1, 1, 1), [new THREE.Vector3(1, 1, 9)]), 8);
});

Deno.test("focusDistanceFor ignores non-finite points and returns NaN when nothing is usable", () => {
  const cam = { x: 0, y: 0, z: 0 };
  assertEquals(focusDistanceFor(cam, [{ x: NaN, y: 0, z: 0 }, { x: 0, y: Infinity, z: 0 }, { x: 0, y: 0, z: 6 }]), 6);
  assert(Number.isNaN(focusDistanceFor(cam, [])), "empty -> NaN");
  assert(Number.isNaN(focusDistanceFor(cam, [{ x: NaN, y: NaN, z: NaN }])), "all junk -> NaN");
});

Deno.test("focusDistanceFor with a view direction uses view depth and skips points behind the camera", () => {
  const cam = { x: 0, y: 0, z: 0 }, fwd = { x: 0, y: 0, z: -2 }; // not normalised on purpose
  // (3, 0, -4): euclidean 5, view depth 4.
  assertAlmostEquals(focusDistanceFor(cam, [{ x: 3, y: 0, z: -4 }], fwd), 4, 1e-12);
  // A point behind the camera is not a focus candidate.
  assertAlmostEquals(focusDistanceFor(cam, [{ x: 0, y: 0, z: 9 }, { x: 0, y: 0, z: -6 }], fwd), 6, 1e-12);
  // A degenerate direction falls back to euclidean distance.
  assertEquals(focusDistanceFor(cam, [{ x: 3, y: 0, z: -4 }], { x: 0, y: 0, z: 0 }), 5);
});

Deno.test("springStep is critically damped: converges, never overshoots from rest, stable for big dt", () => {
  let s = { x: 0, v: 0 };
  let prev = 0;
  for (let k = 0; k < 120; k++) {
    s = springStep(s.x, s.v, 10, 6, 1 / 60);
    assert(s.x <= 10 + 1e-9, "no overshoot");
    assert(s.x >= prev - 1e-12, "monotone approach");
    prev = s.x;
  }
  assertAlmostEquals(s.x, 10, 0.01, "settled within 2 s");
  const big = springStep(0, 0, 10, 6, 100);
  assertAlmostEquals(big.x, 10, 1e-6, "huge dt lands on the target");
  assert(Number.isFinite(big.v));
  assertEquals(springStep(3, 1, 10, 6, 0), { x: 3, v: 1 }, "dt 0 is a no-op");
});

Deno.test("atmosphere installs a FogExp2 (clamped density) and restores only its own fog", () => {
  const scene = new THREE.Scene();
  const base = new THREE.FogExp2(0x112233, 0.01);
  scene.fog = base;
  const undo = atmosphere(scene, { color: 0xabcdef, density: 0.02 });
  assert(scene.fog instanceof THREE.FogExp2 && scene.fog !== base, "a new FogExp2");
  assertEquals((scene.fog as THREE.FogExp2).color.getHex(), 0xabcdef);
  assertAlmostEquals((scene.fog as THREE.FogExp2).density, 0.02, 1e-12);
  undo();
  assertEquals(scene.fog, base, "restored");
  // Density 0 still installs a fog object (no shader recompiles); junk density -> 0; huge density capped.
  atmosphere(scene, { color: 0, density: 0 });
  assertEquals((scene.fog as unknown as THREE.FogExp2).density, 0);
  atmosphere(scene, { color: 0, density: NaN });
  assertEquals((scene.fog as unknown as THREE.FogExp2).density, 0);
  atmosphere(scene, { color: 0, density: 5 });
  assert((scene.fog as unknown as THREE.FogExp2).density <= 0.2, "capped");
  // A newer view's fog is never undone by an older restore.
  const undoOld = atmosphere(scene, { color: 1, density: 0.01 });
  const newer = new THREE.FogExp2(2, 0.03);
  scene.fog = newer;
  undoOld();
  assertEquals(scene.fog, newer);
});
