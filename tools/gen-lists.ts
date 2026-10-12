/**
 * Regenerates every `<!-- GEN:x -->` block of docs/LISTS.md from the live code.
 *
 * WHY: tables copied by hand are stale the moment the data changes (tests/content_test.ts fails
 * when a list entry is missing from the doc). The generators live INSIDE the doc (Appendix A:
 * gen_lists.ts, gen_content.ts) so the doc carries its own provenance; this tool extracts them,
 * runs them against this checkout, and splices each emitted block between the doc's matching
 * `<!-- GEN:x -->` / `<!-- /GEN:x -->` markers. Prose outside the markers is never touched.
 *
 * WHAT it prints: per script the number of blocks and the run time; then which blocks changed,
 * which doc blocks no script produced (left untouched) and which emitted blocks have no home.
 *
 * Usage: deno task lists
 */
const ROOT = decodeURIComponent(new URL("..", import.meta.url).pathname).replace(/\/$/, "");
const DOC = `${ROOT}/docs/LISTS.md`;
const TMP = `${ROOT}/artifacts/tmp/lists`;
const SCRIPTS = ["gen_lists.ts", "gen_content.ts"];
const OPEN = /^<!-- GEN:([\w-]+) -->\s*$/;
const CLOSE = /^<!-- \/GEN:([\w-]+) -->\s*$/;

/** The ```ts block that follows the `### <name>` heading of Appendix A. */
function extract(doc: string, name: string): string {
  const at = doc.indexOf(`### ${name}`);
  if (at < 0) throw new Error(`docs/LISTS.md Appendix A has no "### ${name}"`);
  const open = doc.indexOf("```ts\n", at);
  const close = open < 0 ? -1 : doc.indexOf("\n```", open + 6);
  if (open < 0 || close < 0) throw new Error(`no ts code block under "### ${name}"`);
  return doc.slice(open + 6, close + 1);
}

function trimBlank(lines: string[]): string[] {
  let a = 0, b = lines.length;
  while (a < b && lines[a].trim() === "") a++;
  while (b > a && lines[b - 1].trim() === "") b--;
  return lines.slice(a, b);
}

/** Generator output -> blocks keyed by GEN id (a block ends at the next marker or at EOF). */
function parseBlocks(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let id: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (id) out.set(id, trimBlank(buf));
    id = null;
    buf = [];
  };
  for (const line of text.split("\n")) {
    const open = OPEN.exec(line);
    if (open) {
      flush();
      id = open[1];
    } else if (CLOSE.test(line)) flush();
    else if (id) buf.push(line);
  }
  flush();
  return out;
}

/** Replace the body of every doc block that `blocks` regenerates; everything else is kept verbatim. */
function splice(doc: string, blocks: Map<string, string[]>) {
  const lines = doc.split("\n");
  const res: string[] = [];
  const changed: string[] = [], same: string[] = [], seen = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    res.push(lines[i]);
    const open = OPEN.exec(lines[i]);
    if (!open) continue;
    const id = open[1];
    const end = lines.findIndex((l, j) => j > i && CLOSE.exec(l)?.[1] === id);
    if (end < 0) throw new Error(`docs/LISTS.md: <!-- GEN:${id} --> has no closing marker`);
    seen.add(id);
    const body = blocks.get(id);
    if (!body) continue;
    (lines.slice(i + 1, end).join("\n") === body.join("\n") ? same : changed).push(id);
    res.push(...body);
    i = end - 1; // the closing marker itself is pushed by the next iteration
  }
  return {
    doc: res.join("\n"),
    changed,
    same,
    untouched: [...seen].filter((k) => !blocks.has(k)),
    orphan: [...blocks.keys()].filter((k) => !seen.has(k)),
  };
}

const before = await Deno.readTextFile(DOC);
await Deno.mkdir(TMP, { recursive: true });
await Deno.writeTextFile(`${TMP}/LISTS.before.md`, before);
const blocks = new Map<string, string[]>();
for (const name of SCRIPTS) {
  const src = `${TMP}/${name}`, out = `${TMP}/${name}.md`;
  await Deno.writeTextFile(src, extract(before, name));
  const t0 = performance.now();
  const r = await new Deno.Command(Deno.execPath(), {
    args: ["run", "--quiet", "--no-check", `--config=${ROOT}/deno.json`, "--allow-read", "--allow-write", src, ROOT, out],
    cwd: ROOT,
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  if (!r.success) {
    console.error(`${name} failed (exit ${r.code})`);
    Deno.exit(1);
  }
  const got = parseBlocks(await Deno.readTextFile(out));
  for (const [k, v] of got) blocks.set(k, v);
  console.log(`${name}: ${got.size} blocks in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
}
const res = splice(before, blocks);
if (res.doc !== before) await Deno.writeTextFile(DOC, res.doc);
console.log(`changed (${res.changed.length}): ${res.changed.join(", ") || "-"}`);
console.log(`unchanged (${res.same.length}); doc blocks no script produced (${res.untouched.length}): ${res.untouched.join(", ") || "-"}`);
if (res.orphan.length) console.log(`emitted blocks with no marker in the doc: ${res.orphan.join(", ")}`);
console.log(`previous doc saved to ${TMP}/LISTS.before.md`);
