// CLEO 2026.10.8 treats `bun test`'s subcommand as a script path named
// ./test (a directory). Give typed evidence an actual, fingerprinted entry
// file without changing any test, expectation, result or covered file list.
import { lstatSync, realpathSync } from "node:fs"
import { isAbsolute, relative, resolve } from "node:path"

const root = realpathSync(process.cwd())
const files = process.argv.slice(2)
if (!files.length) throw Error("Explicit .test.ts/.test.tsx files required; whole-suite execution is refused")
for (const file of files) {
  const path = resolve(root, file), rel = relative(root, path)
  if (file.startsWith("-") || isAbsolute(file) || rel.startsWith("..") || /[?*\[\]{}]/.test(file)
    || !/\.test\.tsx?$/.test(file) || !lstatSync(path).isFile() || realpathSync(path) !== path)
    throw Error(`Not an explicit unredirected in-project test file: ${file}`)
}
const child = Bun.spawn([process.execPath, "test", ...files], { cwd: root, stdin: "inherit", stdout: "inherit", stderr: "inherit" })
process.exitCode = await child.exited
