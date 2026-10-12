// Bundles main.ts + three.js into one local ESM file (dist/app.js). No CDN, no runtime fetches.
await Deno.mkdir("dist", { recursive: true });
const result = await new Deno.Command(Deno.execPath(), {
  args: [
    "bundle",
    "--platform=browser",
    "--format=esm",
    "--minify",
    "--keep-names",
    "--sourcemap=linked",
    "--output=dist/app.js",
    "main.ts",
  ],
  stdout: "inherit",
  stderr: "inherit",
}).output();
if (!result.success) Deno.exit(result.code);
await Promise.all([
  Deno.copyFile("web/index.html", "dist/index.html"),
  Deno.copyFile("web/styles.css", "dist/styles.css"),
  Deno.copyFile("web/manifest.webmanifest", "dist/manifest.webmanifest"),
  Deno.copyFile("web/icon.svg", "dist/icon.svg"),
]);
const js = await Deno.readTextFile("dist/app.js");
if (/\bfrom\s*["']https?:/.test(js)) throw Error("Runtime remote import in bundle");
console.log(`Built dist/app.js: ${(await Deno.stat("dist/app.js")).size} bytes (local-only bundle).`);
