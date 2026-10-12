// Typed three.js entry point. Deno does not auto-attach @types/three to npm:three, so every module
// imports THREE through this shim; without it all THREE usage silently type-checks as `any`.
// @deno-types="@types/three"
export * from "three";
