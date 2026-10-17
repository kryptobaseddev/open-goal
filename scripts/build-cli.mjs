// The published bin: cli/ocg.ts bundled for plain Node, so `npm i -g @cleocode/goal`
// works on a machine without Bun. Committed (like dist/tui.js) so git installs ship it.
import { readFile, mkdir, writeFile, chmod } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../", import.meta.url))
// Bun's source labels follow cwd, even with root set; keep the bytes path-independent.
process.chdir(root)
const result = await Bun.build({
  entrypoints: [join(root, "cli/ocg.ts")],
  root,
  target: "node",
  format: "esm",
  minify: false,
})
if (!result.success) throw new AggregateError(result.logs, "CLI build failed")
if (result.outputs.length !== 1) throw new Error("Expected one self-contained CLI module")
const body = (await result.outputs[0].text()).replace(/^#!.*\n/, "")
const contents = `#!/usr/bin/env node\n${body}`
if (/\bBun\./.test(body)) throw new Error("dist/cli.js references the Bun global; the bin must run on plain Node")
const path = join(root, "dist", "cli.js")
if (process.argv.includes("--check")) {
  if (await readFile(path, "utf8").catch(() => "") !== contents) throw new Error("Stale generated CLI: dist/cli.js; run bun run build:cli")
} else {
  await mkdir(join(root, "dist"), { recursive: true })
  await writeFile(path, contents)
  await chmod(path, 0o755)
}
