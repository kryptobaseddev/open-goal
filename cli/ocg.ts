#!/usr/bin/env node
// The `cleo-goal` bin (alias `ocg`, "open cleo goal"). Published as
// dist/cli.js (built by scripts/build-cli.mjs) so it runs on plain Node.
//
//   cleo-goal --version             the package version
//   cleo-goal status --json         the live goal, schemaVersion 1 (CLEO's read contract)
//   cleo-goal install --project [--spec <npm-or-git spec>] [--json] [--dry-run]
//                                   register the plugin in .opencode/opencode.json
//   ocg tick    CLEO's Stop dispatcher spawns this with the harness Stop JSON on
//               stdin. JSON ONLY on stdout, logs on stderr, nothing when no goal
//               is live. It records the turn, decides, and runs the verification
//               of a claim.
//   ocg claim   The agent-side claim surface for a harness that has no OCG tools:
//               it records a claim on the live run through OCG's own store, so the
//               next tick can verify it. (OpenCode agents use the goal_claim tool.)
//
// We deliberately do NOT install our own Stop hook in any harness: CLEO's
// dispatcher owns Stop, and a second entry would tick twice.
import { readFileSync } from "node:fs"
import pkg from "../package.json"
import { InstallError, installProject, PACKAGE_NAME } from "../src/cli/install"
import { goalStatus } from "../src/cli/status"
import { fingerprint } from "../src/util/git"
import { Store } from "../src/engine/store"
import { tick } from "../src/engine/tick"
import { verifyClaim } from "../src/verify/pipeline"

const argv = process.argv.slice(2)
const sub = argv[0]
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name)
  return i === -1 ? undefined : argv[i + 1]
}
const root = process.cwd()
const store = new Store(root)
const USAGE = [
  "usage: cleo-goal --version",
  "       cleo-goal status --json",
  "       cleo-goal install --project [--spec <npm-or-git spec>] [--json] [--dry-run]",
  "       cleo-goal tick   (reads the harness Stop JSON on stdin; writes JSON on stdout)",
  "       cleo-goal claim --summary <text> [--evidence C1=<note> ...]",
]
const usage = (): never => {
  for (const line of USAGE) console.error(line)
  process.exit(2)
}

if (sub === "--version" || sub === "-v" || sub === "version") {
  process.stdout.write(`cleo-goal ${pkg.version}\n`)
  process.exit(0)
}

if (sub === "status") {
  if (!argv.includes("--json")) usage()
  try {
    process.stdout.write(`${JSON.stringify(goalStatus(store))}\n`)
    process.exit(0)
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, error: error instanceof Error ? error.message : String(error) })}\n`)
    process.exit(1)
  }
}

if (sub === "install") {
  const spec = flag("--spec") ?? `${PACKAGE_NAME}@${pkg.version}`
  if (!argv.includes("--project") || spec.startsWith("--")) usage()
  const json = argv.includes("--json")
  try {
    const result = installProject(root, spec, { dryRun: argv.includes("--dry-run") })
    process.stdout.write(json ? `${JSON.stringify(result)}\n` : `${result.action}: ${result.spec} in ${result.file}\n`)
    process.exit(0)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!(error instanceof InstallError)) console.error(`cleo-goal install: ${message}`)
    process.stdout.write(json ? `${JSON.stringify({ schemaVersion: 1, error: message })}\n` : `error: ${message}\n`)
    process.exit(1)
  }
}

if (sub === "claim") {
  const summary = flag("--summary") ?? ""
  if (!summary) {
    console.error("usage: ocg claim --summary <text> [--evidence C1=<note> ...]")
    process.exit(2)
  }
  const evidence: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--evidence") continue
    const pair = argv[i + 1] ?? ""
    const eq = pair.indexOf("=")
    if (eq > 0) evidence[pair.slice(0, eq)] = pair.slice(eq + 1)
  }
  const live = store
    .slugs()
    .map((slug) => store.readRun(slug))
    .filter((state): state is NonNullable<typeof state> => Boolean(state) && !["complete", "failed", "aborted", "superseded"].includes(state!.status))
    .sort((a, b) => (b!.updatedAt ?? 0) - (a!.updatedAt ?? 0))[0]
  if (!live) {
    console.error("no live goal here; nothing to claim")
    process.exit(1)
  }
  live.claim = { at: Date.now(), turn: live.turn, summary, evidence }
  live.updatedAt = Date.now()
  store.writeRun(live)
  store.ledger(live.slug, { type: "claim", turn: live.turn, source: "ocg-claim", evidence: Object.keys(evidence).length })
  console.error(`ocg claim: recorded on ${live.slug} (turn ${live.turn})`)
  process.stdout.write(`${JSON.stringify({ ok: true, slug: live.slug, turn: live.turn, criteria: Object.keys(evidence) })}\n`)
  process.exit(0)
}

if (sub !== "tick") usage()

// Read stdin to EOF (the harness Stop JSON). Its content is mined for a
// transcript path when the harness supplies one; otherwise the tick degrades.
const readStdin = async (): Promise<string> => {
  let text = ""
  process.stdin.setEncoding("utf8")
  for await (const chunk of process.stdin) text += chunk
  return text
}
const payload = await readStdin().catch(() => "")
if (payload.trim()) console.error(`ocg tick: received ${payload.length} bytes of Stop payload`)

const result = await tick({
  root,
  store,
  fingerprint: () => fingerprint(root),
  payload,
  readTranscript: (path: string) => {
    try {
      return readFileSync(path, "utf8")
    } catch {
      return undefined
    }
  },
  // Host checks only: a contract that asks for the independent verifier child is
  // the adapter's mechanism, and the tick does not claim to run one.
  verify: (state, contract, contractText) => verifyClaim(contract, state, { root, contractText }),
}).catch((error: unknown) => {
  // A crash is never the answer. Empty stdout means "no live goal" to the
  // dispatcher, which would silently drop the run; holding keeps the session
  // alive and the reason goes to stderr where it belongs.
  console.error(`ocg tick: failed (${error instanceof Error ? error.message : String(error)}); holding the session`)
  return { stdout: JSON.stringify({ final: false }), log: [] }
})
for (const line of result.log) console.error(line) // logs ONLY on stderr
if (result.stdout) process.stdout.write(`${result.stdout}\n`) // JSON ONLY on stdout
process.exit(0)
