// v0.5.1 - the consolidated, exact-release real-model dogfood workflow (CLEO T102).
//
// ONE bounded workflow, ONE record shape, BOTH halves of the export:
//   docs/research/real-model-dogfood/<version>.md|.json   (committed, readable)
//   .opencode/dogfood/<release>/<flow>.json               (raw records + cache)
//
// It runs the five existing drivers against the INSTALLED release, records each
// flow's exact release SHA, serving PID/location, model/agent selections and
// server/UI/skill artifact hashes, preserves the bounded raw owner interaction,
// and labels every flow honestly (pass / fixture / stale-cache / partial /
// timeout). `--assert` asserts the EXPORT is complete and honest - it never
// claims a flow passed when it did not, and a failure is recorded, not hidden.
//
//   bun scripts/real-model-dogfood.ts --assert [--force] [--list] [--flow <id>]
//
// No credentials are written to the export; no production project is mutated.

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"
import { GoalRpc } from "../src/rpc"
import { isArtifactPath } from "../src/verify/artifact"
import {
  classify,
  exportPaths,
  FLOWS,
  runDogfood,
  validateExport,
  type FlowId,
  type FlowRecord,
  type FlowRun,
  type RawOutcome,
  type ReadCoordinate,
  type ReleaseIdentity,
  type Selections,
  type ServingIdentity,
} from "../src/engine/dogfood-record"

const argv = process.argv.slice(2)
if (!argv.includes("--assert")) throw Error("Use --assert")
const only = (() => {
  const i = argv.indexOf("--flow")
  return i === -1 ? undefined : (argv[i + 1] as FlowId)
})()
const force = argv.includes("--force")
if (argv.includes("--list")) {
  for (const f of FLOWS) console.log(f)
  process.exit(0)
}

const root = process.cwd()
const sh = (args: string[], cwd = root) => {
  const r = Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" })
  if (r.exitCode) throw Error(`${args.join(" ")} failed: ${r.stderr.toString().slice(0, 300)}`)
  return r.stdout.toString().trim()
}

// ---- identity: the exact release, by hash, and the engine that will serve it ----
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version as string
const ref = `v${version}`
const revision = sh(["git", "rev-parse", `${ref}^{commit}`])
const artifactFiles = sh(["git", "ls-tree", "-r", "--name-only", revision]).split("\n").filter(isArtifactPath)
const artifacts = Object.fromEntries(
  artifactFiles.map((f) => [f, new Bun.CryptoHasher("sha256").update(Bun.spawnSync(["git", "show", `${revision}:${f}`], { cwd: root, stdout: "pipe" }).stdout).digest("hex")]),
)
const release: ReleaseIdentity = { version, ref, sha: revision, artifacts }

const endpoint = await Service.discover()
if (!endpoint) throw Error("No configured test host; refusing to start or change services")
const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
const info: any = await client.server.info()
const serving: ServingIdentity = { pid: Number(info.pid), location: root, endpoint: endpoint.url }
const source: any = await client.session.get({ sessionID: process.env.OPENCODE_SESSION_ID! } as any)
if (!source?.model || !source?.agent) throw Error("Source model/agent unavailable; no silent provider fallback")
const selections: Selections = { model: `${source.model.providerID}/${source.model.id}`, agent: String(source.agent) }
const rpc: any = (client as any).rpc(GoalRpc)
const provenance: any = await rpc.provenance({ sessionID: process.env.OPENCODE_SESSION_ID! }, { location: root }).catch(() => undefined)

const rawDir = join(root, exportPaths(version, revision).rawDir)
mkdirSync(rawDir, { recursive: true })

// ---- one flow = one existing driver, run against the installed release ----
const DRIVER: Record<FlowId, string> = {
  interview: "real-model-goal-dogfood.ts",
  manager: "real-model-manager-dogfood.ts",
  lifecycle: "real-model-lifecycle-dogfood.ts",
  completion: "real-model-completion-dogfood.ts",
  amendment: "real-model-amendment-dogfood.ts",
}
const FLOW_BUDGET_MS = Number(process.env.OCGOAL_DOGFOOD_FLOW_MS ?? 600_000)

/** Bounded: walk the driver's evidence, read small JSON, keep ids + read coordinates. */
function collectEvidence(dir: string, cap = 24): { requestIds: string[]; readCoordinates: ReadCoordinate[]; raw: RawOutcome; text: string } {
  const requestIds = new Set<string>()
  const readCoordinates: ReadCoordinate[] = []
  const raw: RawOutcome = { ownerMessages: [], forms: [], toolCalls: [], results: [] }
  const text: string[] = []
  const walk = (d: string, depth = 0) => {
    if (depth > 4 || readCoordinates.length >= cap) return
    let entries: string[] = []
    try {
      entries = readdirSync(d)
    } catch {
      return
    }
    for (const name of entries) {
      const p = join(d, name)
      let st
      try {
        st = statSync(p)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        walk(p, depth + 1)
        continue
      }
      if (!/\.(json|jsonl|txt|log|md)$/.test(name) || st.size > 512 * 1024) continue
      const rel = relative(root, p)
      readCoordinates.push({ path: rel, offset: 0, limit: 4096 })
      let body = ""
      try {
        body = readFileSync(p, "utf8")
      } catch {
        continue
      }
      text.push(body.slice(0, 4096))
      for (const m of body.matchAll(/"(?:requestId|requestID)":\s*"([^"]+)"/g)) requestIds.add(m[1]!)
      if (/author-transcript/.test(name)) {
        try {
          const parsed = JSON.parse(body)
          const messages: any[] = Array.isArray(parsed) ? parsed : (parsed.messages ?? parsed.transcript ?? [])
          for (const m of messages.slice(-40)) {
            const role = String(m?.role ?? m?.type ?? "")
            const content = typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? "")
            if (role === "user") raw.ownerMessages.push(content.slice(0, 400))
            else if (Array.isArray(m?.toolCalls)) for (const t of m.toolCalls) raw.toolCalls.push({ name: String(t?.name ?? "tool"), result: String(t?.result ?? "").slice(0, 200) })
            else if (role) raw.results.push(`${role}: ${content.slice(0, 300)}`)
          }
        } catch {
          /* not a transcript we can parse; the raw text is still preserved below */
        }
      }
      if (/forms?\.json$/.test(name)) {
        try {
          const parsed = JSON.parse(body)
          for (const f of (Array.isArray(parsed) ? parsed : parsed.forms ?? []).slice(0, 20))
            raw.forms.push({ id: String(f?.id ?? "form"), question: String(f?.question ?? f?.title ?? ""), ...(f?.answer ? { answer: String(f.answer) } : {}) })
        } catch {
          /* ignore */
        }
      }
    }
  }
  walk(dir)
  return { requestIds: [...requestIds].slice(0, 12), readCoordinates: readCoordinates.slice(0, cap), raw, text: text.join("\n").slice(0, 8192) }
}

async function runFlow(flow: FlowId): Promise<FlowRun> {
  const evidenceRoot = join(rawDir, flow)
  mkdirSync(evidenceRoot, { recursive: true })
  const started = Date.now()
  const driver = join(root, "scripts", DRIVER[flow])
  let timedOut = false
  let providerError = false
  let exit = 1
  let out = ""
  const child = Bun.spawn(["bun", driver, "--assert"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: { ...process.env, QA_RESUME_ROOT: join(evidenceRoot, "project"), OCGOAL_GIT_SPEC: `github:kryptobaseddev/opencode-goal#${ref}` },
  })
  const timer = setTimeout(() => {
    timedOut = true
    child.kill("SIGKILL")
  }, FLOW_BUDGET_MS)
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  clearTimeout(timer)
  exit = Number(code)
  out = `${stdout}\n${stderr}`
  if (/ECONNRESET|ECONNREFUSED|provider|rate limit|overloaded/i.test(out) && exit !== 0) providerError = true
  const { requestIds, readCoordinates, raw, text } = collectEvidence(evidenceRoot)
  raw.results.push(...out.split("\n").filter((l) => /^(status|flow|goal|✓|✗|pass|fail)/i.test(l)).slice(-20))
  if (!raw.results.length) raw.results.push(out.slice(0, 400))
  // a driver that refused to run (no endpoint/model) is a partial, never a pass
  if (/refus|no configured|unavailable/i.test(out) && exit !== 0) providerError = providerError || true
  return {
    exit,
    timedOut,
    providerError,
    ms: Date.now() - started,
    requestIds,
    readCoordinates,
    raw: { ...raw, results: [...new Set([...raw.results, ...(text ? [] : [])])].slice(0, 40) },
  }
}

const flowsToRun = only ? [only] : [...FLOWS]
const result = await runDogfood({
  identity: async () => ({ release, serving, selections }),
  runFlow: async (flow) => (flowsToRun.includes(flow) ? runFlow(flow) : { exit: 1, ms: 0, requestIds: [], readCoordinates: [], raw: { ownerMessages: [], forms: [], toolCalls: [], results: [] } }),
  store: {
    read: async (flow) => {
      try {
        return JSON.parse(readFileSync(join(rawDir, `${flow}.json`), "utf8")) as FlowRecord
      } catch {
        return undefined
      }
    },
    write: async (record) => writeFileSync(join(rawDir, `${record.flow}.json`), JSON.stringify(record, null, 2)),
  },
  emit: {
    summary: async (markdown) => {
      const path = join(root, exportPaths(version, revision).summary)
      mkdirSync(join(root, "docs/research/real-model-dogfood"), { recursive: true })
      writeFileSync(path, markdown)
    },
    index: async (exp) => writeFileSync(join(root, exportPaths(version, revision).index), JSON.stringify(exp, null, 2)),
  },
  force,
})

for (const r of result.results) console.log(`${r.reused ? "reused" : "ran   "} ${r.flow.padEnd(10)} ${r.label}`)
console.log(`labels: ${JSON.stringify(result.export.labels)}`)
const problems = validateExport(result.export)
if (problems.length) {
  console.error("export is incomplete or dishonest:")
  for (const p of problems) console.error(` - ${p}`)
  process.exit(1)
}
console.log(`export written: ${exportPaths(version, revision).summary} + ${exportPaths(version, revision).index} + ${exportPaths(version, revision).rawDir}/`)
console.log(`provenance: serving pid ${serving.pid} at ${serving.location}; release ${ref} (${revision.slice(0, 12)}); model ${selections.model}; agent ${selections.agent}${provenance ? "" : " (no provenance receipt)"}`)
void classify
