// Typed three.js post-processing passes (see src/lib/three.ts for why every @deno-types hint is required:
// without them the addons type-check as `any`). Only src/render/post.ts imports this module.
// @deno-types="@types/three/examples/jsm/postprocessing/EffectComposer.d.ts"
export { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
// @deno-types="@types/three/examples/jsm/postprocessing/RenderPass.d.ts"
export { RenderPass } from "three/addons/postprocessing/RenderPass.js";
// @deno-types="@types/three/examples/jsm/postprocessing/BokehPass.d.ts"
export { BokehPass } from "three/addons/postprocessing/BokehPass.js";
// @deno-types="@types/three/examples/jsm/postprocessing/UnrealBloomPass.d.ts"
export { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
// @deno-types="@types/three/examples/jsm/postprocessing/ShaderPass.d.ts"
export { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
// @deno-types="@types/three/examples/jsm/postprocessing/OutputPass.d.ts"
export { OutputPass } from "three/addons/postprocessing/OutputPass.js";
