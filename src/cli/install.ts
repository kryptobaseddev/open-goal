// `cleo-goal install --project`: register this plugin in the PROJECT's OpenCode
// v2 config (`.opencode/opencode.json`, key `plugins`). Idempotent. Never the
// user-global config: `opencode plugin add` only writes the global file, which is
// why this exists.
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, writeSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join, relative, resolve, sep } from "node:path"

export const INSTALL_SCHEMA_VERSION = 1
export const PACKAGE_NAME = "@cleocode/goal"
/** Specs that name this plugin, whatever the version: the npm package and the git repo it was installed from before npm. */
const IDENTITIES = [PACKAGE_NAME, "github:kryptobaseddev/open-goal", "github:kryptobaseddev/opencode-goal", "open-goal", "opencode-goal"]
export const PROJECT_CONFIG = join(".opencode", "opencode.json")

type Options = Record<string, unknown>
export type PluginEntry = string | [string, Options] | { package: string; options?: Options }

export type InstallResult = {
  schemaVersion: typeof INSTALL_SCHEMA_VERSION
  action: "installed" | "already-present" | "updated" | "dry-run"
  file: string
  spec: string
  plugins: PluginEntry[]
}

export class InstallError extends Error {}

const specOf = (entry: PluginEntry): string => (typeof entry === "string" ? entry : Array.isArray(entry) ? entry[0] : entry.package)

/** The spec without its version, tag or ref: `@cleocode/goal@0.8.1` → `@cleocode/goal`. */
export function identity(spec: string): string {
  const hash = spec.indexOf("#")
  const bare = hash === -1 ? spec : spec.slice(0, hash)
  const at = bare.lastIndexOf("@")
  return at > 0 ? bare.slice(0, at) : bare
}

const isOurs = (entry: PluginEntry) => IDENTITIES.includes(identity(specOf(entry)))

const withSpec = (entry: PluginEntry, spec: string): PluginEntry =>
  typeof entry === "string" ? spec : Array.isArray(entry) ? [spec, entry[1]] : { ...entry, package: spec }

const canonical = (path: string) => {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

const inside = (child: string, parent: string) => {
  const rel = relative(parent, child)
  return !(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
}

/**
 * Refuse anything that is user-global OpenCode config: the home directory as a
 * project, a project under the config dirs, and (T13871) a `.opencode` dir or
 * `opencode.json` that resolves, through a symlink, into a config dir or
 * anywhere outside the project.
 */
function assertProjectScoped(root: string, home: string) {
  const r = canonical(root)
  const h = canonical(home)
  if (r === h) throw new InstallError(`refusing to install into the home directory (${h}): its .opencode/ is user-global; run from a project`)
  const globals = [...new Set([canonical(process.env.XDG_CONFIG_HOME || join(h, ".config")), canonical(join(h, ".config")), canonical(join(h, ".opencode"))])]
  const underGlobal = (path: string) => globals.find((g) => inside(path, g))
  const g = underGlobal(r)
  if (g) throw new InstallError(`refusing to install under ${g}: that is user-global config; run from a project`)
  for (const target of [join(root, ".opencode"), join(root, PROJECT_CONFIG)]) {
    if (!existsSync(target)) continue
    const real = canonical(target)
    const global = underGlobal(real)
    if (global) throw new InstallError(`refusing to write ${target}: it resolves to ${real}, inside user-global ${global}`)
    if (!inside(real, r)) throw new InstallError(`refusing to write ${target}: it resolves to ${real}, outside the project ${r}`)
  }
}

function readPlugins(path: string): { config: Record<string, unknown>; plugins: PluginEntry[] } {
  if (!existsSync(path)) return { config: {}, plugins: [] }
  let config: unknown
  try {
    config = JSON.parse(readFileSync(path, "utf8"))
  } catch (error) {
    throw new InstallError(`${path} is not valid JSON (${error instanceof Error ? error.message : String(error)}); left untouched`)
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new InstallError(`${path} is not a JSON object; left untouched`)
  const record = config as Record<string, unknown>
  const plugins = record.plugins ?? []
  if (!Array.isArray(plugins)) throw new InstallError(`${path}: "plugins" is not an array; left untouched`)
  return { config: record, plugins: plugins as PluginEntry[] }
}

function writeAtomic(path: string, text: string) {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  const fd = openSync(tmp, "wx", 0o644)
  try {
    writeSync(fd, text)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, path)
}

/** Add (or move to `spec`) this plugin in `<root>/.opencode/opencode.json`. */
export function installProject(root: string, spec: string, options: { dryRun?: boolean; home?: string } = {}): InstallResult {
  assertProjectScoped(root, options.home ?? homedir())
  const path = join(root, PROJECT_CONFIG)
  if (!existsSync(path) && existsSync(`${path}c`)) {
    throw new InstallError(`${PROJECT_CONFIG}c exists; add "${spec}" to its "plugins" by hand (JSONC is not rewritten, to keep its comments)`)
  }
  const { config, plugins } = readPlugins(path)
  const ours = plugins.findIndex(isOurs)
  const next = ours === -1 ? [...plugins, spec] : plugins.map((entry, i) => (i === ours ? withSpec(entry, spec) : entry)).filter((entry, i) => i <= ours || !isOurs(entry))
  const action = ours === -1 ? "installed" : specOf(plugins[ours]!) === spec && plugins.filter(isOurs).length === 1 ? "already-present" : "updated"
  const result = { schemaVersion: INSTALL_SCHEMA_VERSION, file: PROJECT_CONFIG, spec, plugins: action === "already-present" ? plugins : next } as const
  if (options.dryRun) return { ...result, action: "dry-run" }
  if (action !== "already-present") {
    mkdirSync(join(root, ".opencode"), { recursive: true })
    // A symlinked opencode.json inside the project is written through, never replaced by a file.
    writeAtomic(existsSync(path) ? canonical(path) : path, `${JSON.stringify({ ...config, plugins: next }, null, 2)}\n`)
  }
  return { ...result, action }
}
