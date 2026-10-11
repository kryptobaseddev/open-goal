// Git installs must ship these bytes: the host's Solid TSX filter skips node_modules.
import { readFile, mkdir, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../", import.meta.url))
// Bun's source labels follow cwd, even with root set; keep the bytes path-independent.
process.chdir(root)
const require = createRequire(import.meta.url)
// Reuse the pinned renderer's Babel/Solid universal compiler, only at build time.
const { transformSolidSource } = await import(join(dirname(require.resolve("@opentui/solid/bun-plugin")), "solid-transform.js"))
const result = await Bun.build({
  entrypoints: [join(root, "src/tui/index.tsx")],
  root,
  target: "bun",
  format: "esm",
  packages: "external", // Solid/OpenTUI belong to the host; never bundle a second runtime.
  plugins: [{
    name: "goal-solid-universal",
    setup(build) {
      build.onLoad({ filter: /\.tsx$/ }, async ({ path }) => ({
        contents: await transformSolidSource(await readFile(path, "utf8"), { filename: path, moduleName: "@opentui/solid" }),
        loader: "js",
      }))
    },
  }],
})
if (!result.success) throw new AggregateError(result.logs, "TUI build failed")
if (result.outputs.length !== 1) throw new Error("Expected one self-contained TUI module")
const files = {
  "tui.js": await result.outputs[0].text(),
  "tui.d.ts": 'declare const plugin: typeof import("../src/tui/index").default\nexport default plugin\n',
}
await mkdir(join(root, "dist"), { recursive: true })
for (const [name, contents] of Object.entries(files)) {
  const path = join(root, "dist", name)
  if (process.argv.includes("--check")) {
    if (await readFile(path, "utf8") !== contents) throw new Error(`Stale generated TUI: dist/${name}; run bun run build:tui`)
  } else await writeFile(path, contents)
}
