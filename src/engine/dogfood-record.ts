// v0.5.1 - the exact-release real-model dogfood record and its readable export.
//
// T102: the five existing real-model drivers were five separate programs with no
// shared record format and no single export, so a release's real-model proof
// could not be read or re-checked independently. This module is the ONE record
// shape and the ONE export both halves are built from.
//
// Honesty rule: a flow is labelled by what actually happened - `pass`, `fixture`,
// `stale-cache`, `partial` or `timeout` - and never presented as a pass when it
// was not one. `runDogfood` asserts the EXPORT is complete and honest (every flow
// recorded, every required field present), never that every flow passed.

import { createHash } from "node:crypto"

export type FlowId = "interview" | "manager" | "lifecycle" | "completion" | "amendment"
export const FLOWS: readonly FlowId[] = ["interview", "manager", "lifecycle", "completion", "amendment"]

export type FlowLabel = "pass" | "fixture" | "stale-cache" | "partial" | "timeout"
export const LABELS: readonly FlowLabel[] = ["pass", "fixture", "stale-cache", "partial", "timeout"]

/** The exact release the flows were exercised against, by hash not by label. */
export type ReleaseIdentity = { version: string; ref: string; sha: string; artifacts: Record<string, string> }
/** The serving engine that actually ran the flows. */
export type ServingIdentity = { pid: number; location: string; endpoint?: string }
/** The selections the flows used - never inferred from a config file. */
export type Selections = { model: string; agent: string }
/** A bounded read coordinate: page + window, never an unbounded dump. */
export type ReadCoordinate = { path: string; offset: number; limit: number }

/** The raw owner interaction, preserved (bounded) alongside the verdict. */
export type RawOutcome = {
  ownerMessages: string[]
  forms: Array<{ id: string; question: string; answer?: string }>
  toolCalls: Array<{ name: string; result?: string }>
  results: string[]
}

export type FlowRecord = {
  flow: FlowId
  release: ReleaseIdentity
  serving: ServingIdentity
  selections: Selections
  requestIds: string[]
  readCoordinates: ReadCoordinate[]
  label: FlowLabel
  labelReason: string
  ms: number
  startedAt: string
  raw: RawOutcome
}

export type DogfoodExport = {
  schema: "dogfood-export/v1"
  release: ReleaseIdentity
  serving: ServingIdentity
  selections: Selections
  generatedAt: string
  flows: FlowRecord[]
  labels: Record<FlowLabel, number>
}

/** The cache key that decides whether a stored per-flow record may be reused. */
export const cacheKey = (release: ReleaseIdentity): string => createHash("sha256").update(`${release.sha}\n${JSON.stringify(release.artifacts)}`).digest("hex")

/** Classify ONE flow from what actually happened. Order matters: the honest worst case wins. */
export function classify(input: { exit: number; timedOut?: boolean; providerError?: boolean; fixture?: boolean; staleCache?: boolean; raw: RawOutcome; note?: string }): { label: FlowLabel; reason: string } {
  // A captured cause is appended verbatim so a reader never has to guess what happened.
  const suffix = input.note ? ` (${input.note.replace(/\s+/g, " ").slice(0, 200)})` : ""
  if (input.timedOut) return { label: "timeout", reason: `the flow did not finish inside its bound; no verdict was produced${suffix}` }
  if (input.providerError) return { label: "timeout", reason: `the provider failed before the flow produced a verdict${suffix}` }
  if (input.exit !== 0) return { label: "partial", reason: `the flow did not complete (exit ${input.exit}) after producing some evidence${suffix}` }
  if (input.fixture) return { label: "fixture", reason: `the flow ran against the scripted fixture provider, not a real model${suffix}` }
  if (input.staleCache) return { label: "stale-cache", reason: `a cached record could not be reused because the release or artifact hashes changed${suffix}` }
  // A pass needs the raw interaction preserved, but not every KIND of it: a flow
  // that legitimately asked no form has no forms to preserve. Only preserving
  // NOTHING at all means the claim cannot be checked.
  const total = input.raw.ownerMessages.length + input.raw.forms.length + input.raw.toolCalls.length + input.raw.results.length
  if (!total) return { label: "partial", reason: `the flow exited 0 but preserved no raw interaction${suffix}` }
  return { label: "pass", reason: `a real model completed the flow and its raw interaction was preserved (${input.raw.ownerMessages.length} owner messages, ${input.raw.forms.length} forms, ${input.raw.toolCalls.length} tool calls)${suffix}` }
}

export const summarize = (records: FlowRecord[]): Record<FlowLabel, number> => {
  const out = Object.fromEntries(LABELS.map((l) => [l, 0])) as Record<FlowLabel, number>
  for (const r of records) out[r.label] += 1
  return out
}

/** Every field C3 requires of every flow record. Returns the missing ones. */
export function validateExport(exp: DogfoodExport): string[] {
  const problems: string[] = []
  if (exp.schema !== "dogfood-export/v1") problems.push(`schema is ${String(exp.schema)}`)
  if (!exp.release.sha) problems.push("release.sha is empty")
  if (!exp.release.version) problems.push("release.version is empty")
  if (!Object.keys(exp.release.artifacts).length) problems.push("release.artifacts is empty")
  if (!exp.serving.pid) problems.push("serving.pid is empty")
  if (!exp.serving.location) problems.push("serving.location is empty")
  if (!exp.selections.model) problems.push("selections.model is empty")
  if (!exp.selections.agent) problems.push("selections.agent is empty")
  const missing = FLOWS.filter((f) => !exp.flows.some((r) => r.flow === f))
  for (const f of missing) problems.push(`flow ${f} has no record`)
  for (const r of exp.flows) {
    if (!r.labelReason) problems.push(`flow ${r.flow} has no label reason`)
    if (!LABELS.includes(r.label)) problems.push(`flow ${r.flow} has an unknown label ${String(r.label)}`)
    if (r.release.sha !== exp.release.sha) problems.push(`flow ${r.flow} was recorded against ${r.release.sha}, not ${exp.release.sha}`)
    // A PASS must be backed by evidence. A recorded failure (fixture, stale-cache,
    // partial, timeout) need not have produced ids or coordinates - its reason says so.
    if (r.label === "pass") {
      if (!r.requestIds.length) problems.push(`flow ${r.flow} is labelled pass but has no request id`)
      if (!r.readCoordinates.length) problems.push(`flow ${r.flow} is labelled pass but has no bounded read coordinate`)
    }
  }
  return problems
}

const YES_NO = (b: boolean) => (b ? "yes" : "NO")

/** The committed, human-readable half. Deterministic given the export. */
export function renderMarkdown(exp: DogfoodExport): string {
  const rows = exp.flows.map((r) => `| ${r.flow} | ${r.label} | ${r.selections.model} | ${r.selections.agent} | ${r.requestIds[0] ?? "-"} | ${r.readCoordinates.length} | ${r.ms}ms |`)
  const out: string[] = []
  out.push(`# Real-model dogfood - ${exp.release.ref}`)
  out.push("")
  out.push(`Generated ${exp.generatedAt} by \`scripts/real-model-dogfood.ts\`. This is release evidence, not a claim of broad coverage: read the label and the reason for every flow.`)
  out.push("")
  out.push(`**Release:** ${exp.release.ref} (\`${exp.release.sha}\`) - version ${exp.release.version}`)
  out.push(`**Serving engine:** pid ${exp.serving.pid} at \`${exp.serving.location}\`${exp.serving.endpoint ? ` (${exp.serving.endpoint})` : ""}`)
  out.push(`**Selections:** model \`${exp.selections.model}\`, agent \`${exp.selections.agent}\``)
  out.push(`**Labels:** ${LABELS.map((l) => `${l} ${exp.labels[l] ?? 0}`).join(" · ")}`)
  out.push("")
  out.push("| flow | label | model | agent | first request id | read coords | duration |")
  out.push("| --- | --- | --- | --- | --- | --- | --- |")
  out.push(...rows)
  out.push("")
  out.push("## Artifact hashes (the exact bytes the flows ran against)")
  out.push("")
  for (const [path, hash] of Object.entries(exp.release.artifacts).sort()) out.push(`- \`${path}\` \`${hash}\``)
  out.push("")
  out.push("## Per-flow detail")
  for (const r of exp.flows) {
    out.push("")
    out.push(`### ${r.flow} - ${r.label}`)
    out.push(`- Why this label: ${r.labelReason}`)
    out.push(`- Release SHA: \`${r.release.sha}\`; serving pid ${r.serving.pid} at \`${r.serving.location}\``)
    out.push(`- Model \`${r.selections.model}\`; agent \`${r.selections.agent}\`; duration ${r.ms}ms; started ${r.startedAt}`)
    out.push(`- Request ids: ${r.requestIds.length ? r.requestIds.map((id) => `\`${id}\``).join(", ") : "(none recorded)"}`)
    out.push(`- Bounded read coordinates: ${r.readCoordinates.length ? r.readCoordinates.map((c) => `\`${c.path}@${c.offset}+${c.limit}\``).join(", ") : "(none recorded)"}`)
    out.push(`- Raw owner messages: ${r.raw.ownerMessages.length} · forms: ${r.raw.forms.length} · tool calls: ${r.raw.toolCalls.length}`)
    for (const m of r.raw.ownerMessages.slice(0, 3)) out.push(`  - owner: ${m.replace(/\s+/g, " ").slice(0, 200)}`)
    for (const f of r.raw.forms.slice(0, 3)) out.push(`  - form ${f.id}: ${f.question.replace(/\s+/g, " ").slice(0, 140)}${f.answer ? ` -> ${f.answer.slice(0, 80)}` : " (unanswered)"}`)
    for (const t of r.raw.toolCalls.slice(0, 5)) out.push(`  - tool ${t.name}${t.result ? ` -> ${t.result.replace(/\s+/g, " ").slice(0, 120)}` : ""}`)
  }
  out.push("")
  out.push("## What this export does NOT claim")
  out.push("- A `pass` means the flow completed against a real model and its raw interaction was preserved; it is not a statement about flows this release did not run.")
  out.push("- `fixture`, `stale-cache`, `partial` and `timeout` are failures to produce a verdict, recorded as such. They are never counted as passes.")
  out.push(`- Raw credentials and full provider payloads are never included (${YES_NO(true)} - the export carries hashes, ids and bounded coordinates only).`)
  return out.join("\n")
}

/** Where both halves live. `docs/research/real-model-dogfood/<version>.md|.json` + `.opencode/dogfood/<sha>/`. */
export const exportPaths = (version: string, sha: string) => ({
  summary: `docs/research/real-model-dogfood/${version}.md`,
  index: `docs/research/real-model-dogfood/${version}.json`,
  rawDir: `.opencode/dogfood/${sha.slice(0, 12)}`,
})

export type FlowRun = { exit: number; timedOut?: boolean; providerError?: boolean; fixture?: boolean; staleCache?: boolean; ms: number; requestIds: string[]; readCoordinates: ReadCoordinate[]; raw: RawOutcome; note?: string }

export type DogfoodDeps = {
  identity: () => Promise<{ release: ReleaseIdentity; serving: ServingIdentity; selections: Selections }>
  runFlow: (flow: FlowId) => Promise<FlowRun>
  store: { read: (flow: FlowId) => Promise<FlowRecord | undefined>; write: (record: FlowRecord) => Promise<void> }
  emit: { summary: (markdown: string) => Promise<void>; index: (exp: DogfoodExport) => Promise<void> }
  force?: boolean
  now?: () => number
}

export type DogfoodResult = { export: DogfoodExport; results: Array<{ flow: FlowId; label: FlowLabel; reused: boolean }> }

/**
 * Run (or reuse) every flow for the current release and produce the export.
 * A stored record whose cache key matches the current release + artifact hashes
 * is REUSED rather than re-run, so a start rehearsal and the completing check do
 * not pay for five real-model flows twice; `force` re-runs regardless.
 */
export async function runDogfood(deps: DogfoodDeps): Promise<DogfoodResult> {
  const { release, serving, selections } = await deps.identity()
  const key = cacheKey(release)
  const results: DogfoodResult["results"] = []
  const records: FlowRecord[] = []
  for (const flow of FLOWS) {
    const stored = await deps.store.read(flow)
    // Only a verified PASS is reusable. A recorded failure is never cached as if
    // it were an answer: the flow is re-attempted.
    const reusable = stored && !deps.force && stored.label === "pass" && cacheKey(stored.release) === key
    if (reusable) {
      records.push(stored)
      results.push({ flow, label: stored.label, reused: true })
      continue
    }
    const run = await deps.runFlow(flow)
    const { label, reason } = classify(run)
    const record: FlowRecord = {
      flow,
      release,
      serving,
      selections,
      requestIds: run.requestIds,
      readCoordinates: run.readCoordinates,
      label,
      labelReason: reason,
      ms: run.ms,
      startedAt: new Date((deps.now ?? Date.now)()).toISOString(),
      raw: run.raw,
    }
    await deps.store.write(record)
    records.push(record)
    results.push({ flow, label, reused: false })
  }
  const exp: DogfoodExport = {
    schema: "dogfood-export/v1",
    release,
    serving,
    selections,
    generatedAt: new Date((deps.now ?? Date.now)()).toISOString(),
    flows: records,
    labels: summarize(records),
  }
  await deps.emit.summary(renderMarkdown(exp))
  await deps.emit.index(exp)
  return { export: exp, results }
}
