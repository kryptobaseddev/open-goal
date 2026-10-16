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
// The host runs this check without OPENCODE_SESSION_ID in the environment, so
// RESOLVE a source session rather than assuming one: prefer the env var, else the
// first session in this project that carries a model and an agent. The drivers
// need the same id, so it is passed through to them below.
const asList = (l: any): any[] => (Array.isArray(l) ? l : (l?.data ?? l?.sessions ?? []))
const sessionList = await client.session.list({ location: root }).then(asList).catch(() => [] as any[])
const envSession = typeof process.env.OPENCODE_SESSION_ID === "string" && process.env.OPENCODE_SESSION_ID.startsWith("ses") ? process.env.OPENCODE_SESSION_ID : undefined
const sourceSessionID: string | undefined = envSession ?? sessionList.find((s: any) => s?.model?.id && s?.agent)?.id
if (!sourceSessionID) throw Error("No source session with a model/agent is available; refusing to guess the selections")
const source: any = await client.session.get({ sessionID: sourceSessionID } as any)
if (!source?.model || !source?.agent) throw Error("Source model/agent unavailable; no silent provider fallback")
const selections: Selections = { model: `${source.model.providerID}/${source.model.id}`, agent: String(source.agent) }
const rpc: any = (client as any).rpc(GoalRpc)
const provenance: any = await rpc.provenance({ sessionID: sourceSessionID }, { location: root }).catch(() => undefined)

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

// The five drivers are ONE chained scenario, not five independent programs: the
// interview CREATES the isolated QA project, and manager/lifecycle/completion
// REQUIRE QA_RESUME_ROOT and RESUME that same root (for the interview that env
// means "retry an existing root"). The shared root is threaded through a state
// file, so a second run (the start rehearsal or the completing check) resumes the
// same project instead of inventing a new one.
const statePath = join(rawDir, "state.json")
const readState = (): { qaRoot?: string } => {
  try {
    return JSON.parse(readFileSync(statePath, "utf8"))
  } catch {
    return {}
  }
}
const writeState = (s: { qaRoot?: string }) => writeFileSync(statePath, JSON.stringify(s, null, 2))
const NEEDS_ROOT: readonly FlowId[] = ["manager", "lifecycle", "completion"]

/**
 * Bounded: walk the driver's evidence, read small JSON, and extract the raw
 * owner interaction + the identifiers a reader needs to find the records. Reads
 * are capped (files, size, depth) so a runaway directory cannot blow up the run.
 */
function collectEvidence(dir: string, cap = 40): { requestIds: string[]; readCoordinates: ReadCoordinate[]; raw: RawOutcome } {
  const requestIds = new Set<string>()
  const readCoordinates: ReadCoordinate[] = []
  const raw: RawOutcome = { ownerMessages: [], forms: [], toolCalls: [], results: [] }
  const formQuestion = new Map<string, string>()
  const answers: Array<{ formID: string; answer: unknown }> = []
  const idRe = /"(?:requestId|requestID|sessionID)":\s*"((?:ses|req|msg)_[A-Za-z0-9]+)"/g
  const walk = (d: string, depth = 0) => {
    if (depth > 6 || readCoordinates.length >= cap) return
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
      readCoordinates.push({ path: relative(root, p), offset: 0, limit: 4096 })
      let body = ""
      try {
        body = readFileSync(p, "utf8")
      } catch {
        continue
      }
      for (const m of body.matchAll(idRe)) requestIds.add(m[1]!)
      // The QUESTION definitions, so an answer can be paired with its question.
      if (/^form-.*\.json$/.test(name)) {
        try {
          const f = JSON.parse(body).form ?? {}
          const q = f.fields?.[0]?.title ?? f.title ?? "(question)"
          if (f.id) formQuestion.set(String(f.id), String(q).slice(0, 300))
        } catch {
          /* ignore */
        }
      }
      if (name === "answers.json") {
        try {
          for (const a of JSON.parse(body)) if (a?.formID) answers.push({ formID: String(a.formID), answer: a.answer })
        } catch {
          /* ignore */
        }
      }
      if (/transcript/.test(name)) {
        try {
          const parsed = JSON.parse(body)
          const arr: any[] = Array.isArray(parsed) ? parsed : (parsed.messages ?? [])
          for (const entry of arr.slice(-80)) {
            if (typeof entry?.id === "string" && /^(msg|ses)_/.test(entry.id)) requestIds.add(entry.id)
            const parts: any[] = Array.isArray(entry?.content) ? entry.content : []
            const textOf = (ps: any[]) => ps.map((x) => (typeof x?.text === "string" ? x.text : "")).filter(Boolean).join(" ")
            if (String(entry?.type) === "user") {
              const t = parts.length ? textOf(parts) : String(entry?.text ?? "")
              if (t) raw.ownerMessages.push(t.slice(0, 400))
            }
            for (const part of parts) {
              if (part?.type !== "tool") continue
              const out = Array.isArray(part?.state?.content) ? textOf(part.state.content) : String(part?.state?.output ?? "")
              raw.toolCalls.push({ name: String(part?.name ?? "tool"), ...(out ? { result: out.replace(/\s+/g, " ").slice(0, 200) } : {}) })
            }
            if (String(entry?.type) === "tool" && entry?.name) raw.toolCalls.push({ name: String(entry.name) })
          }
        } catch {
          /* not a transcript we can parse; the bounded read coordinate still points at it */
        }
      }
    }
  }
  walk(dir)
  for (const a of answers.slice(0, 20)) raw.forms.push({ id: a.formID, question: formQuestion.get(a.formID) ?? "(question)", ...(a.answer ? { answer: JSON.stringify(a.answer).slice(0, 160) } : {}) })
  return { requestIds: [...requestIds].slice(0, 12), readCoordinates: readCoordinates.slice(0, cap), raw }
}

async function runFlow(flow: FlowId, state: { qaRoot?: string }): Promise<FlowRun> {
  const started = Date.now()
  const driver = join(root, "scripts", DRIVER[flow])
  const emptyRaw = (): RawOutcome => ({ ownerMessages: [], forms: [], toolCalls: [], results: [] })
  if (NEEDS_ROOT.includes(flow) && !state.qaRoot)
    return { exit: 1, ms: 0, requestIds: [], readCoordinates: [], raw: emptyRaw(), note: `${flow} needs the shared QA root the interview flow creates, and there is none yet` }
  const env: Record<string, string> = { ...(process.env as Record<string, string>), OCGOAL_GIT_SPEC: `github:kryptobaseddev/opencode-goal#${ref}`, OPENCODE_SESSION_ID: sourceSessionID! }
  if (flow === "interview") {
    // ALWAYS a fresh isolated project: the dependents resume the root this run
    // creates. (Passing QA_RESUME_ROOT here means "retry an existing root", which
    // is wrong once that root already holds a launched goal.)
    delete env.QA_RESUME_ROOT
  } else if (NEEDS_ROOT.includes(flow)) env.QA_RESUME_ROOT = state.qaRoot!
  else delete env.QA_RESUME_ROOT // amendment runs on its own root
  const child = Bun.spawn(["bun", driver, "--assert"], { cwd: root, stdout: "pipe", stderr: "pipe", stdin: "ignore", env })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill("SIGKILL")
  }, FLOW_BUDGET_MS)
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  clearTimeout(timer)
  const exit = Number(code)
  const out = `${stdout}\n${stderr}`
  // The driver prints one JSON line carrying its isolated root + evidence dir.
  let evidenceDir: string | undefined
  for (const line of stdout.split("\n")) {
    const i = line.indexOf("{")
    if (i === -1) continue
    try {
      const parsed = JSON.parse(line.slice(i))
      if (parsed?.evidence) evidenceDir = String(parsed.evidence)
      if (parsed?.root && flow === "interview") {
        state.qaRoot = String(parsed.root)
        writeState(state)
      }
    } catch {
      /* not the success line */
    }
  }
  // A provider failure is a real model failure; a start-up crash is NOT - it is
  // reported as what it is (an incomplete flow) with its cause attached.
  const providerError = /ECONNRESET|ECONNREFUSED|rate.?limit|overloaded|no configured shared test host|no existing QA service/i.test(out)
  const note = out
    .split("\n")
    .map((l) => l.trim())
    .find((l) => /^(error|Error|✗|\{?"?success"?:false)/.test(l))
  const dir = evidenceDir ?? join(state.qaRoot ?? join(rawDir, flow), "qa-evidence")
  const { requestIds, readCoordinates, raw } = collectEvidence(dir)
  raw.results.push(...out.split("\n").filter((l) => l.trim()).slice(-20))
  return { exit, timedOut, providerError, ms: Date.now() - started, requestIds, readCoordinates, raw, ...(note ? { note } : {}) }
}

const flowsToRun = only ? [only] : [...FLOWS]
const state = readState()
const result = await runDogfood({
  identity: async () => ({ release, serving, selections }),
  runFlow: async (flow) => (flowsToRun.includes(flow) ? runFlow(flow, state) : { exit: 1, ms: 0, requestIds: [], readCoordinates: [], raw: { ownerMessages: [], forms: [], toolCalls: [], results: [] }, note: "not selected by --flow" }),
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
