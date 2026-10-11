import { expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { amendmentDiff, amendedState } from "../../src/engine/amendment"
import { AmendmentStore } from "../../src/engine/amendments"
import { parseContract } from "../../src/contract/parse"
import { initialRun } from "../../src/engine/state"
import { Store } from "../../src/engine/store"

const yaml = `schema: goal/v1
id: amend-demo
title: Review the marker
intent: {verbatim: prove the marker}
outcome: marker exists
non_goals: [other files]
criteria:
  - id: C1
    statement: marker exists
    check: {kind: file, path: marker.txt}
  - id: C2
    statement: owner reviews marker
    check: {kind: human, ask: review marker}
plan:
  - {id: S1, title: marker, proves: [C1]}
`

test("amendment invalidation covers statement, check, essentialness and invariant role, but not key ordering", () => {
  const prior = parseContract(yaml).contract!
  for (const mutate of [
    (c: typeof prior) => { c.criteria[0]!.statement += " changed" },
    (c: typeof prior) => { c.criteria[0]!.check = { kind: "file", path: "other.txt" } },
    (c: typeof prior) => { c.criteria[0]!.essential = false },
    (c: typeof prior) => { c.invariants.push(c.criteria.shift()!) },
  ]) {
    const next = structuredClone(prior)
    mutate(next)
    expect(amendmentDiff(prior, next).changed).toEqual(["C1"])
    expect(amendmentDiff(prior, next).unchanged).toEqual(["C2"])
  }
  const reordered = structuredClone(prior)
  reordered.criteria[0]!.check = Object.fromEntries(Object.entries(prior.criteria[0]!.check).reverse()) as typeof prior.criteria[number]["check"]
  expect(amendmentDiff(prior, reordered).changed).toEqual([])
})

test("accepted diff retains unchanged evidence, updates plan/title/priority, and never resumes or asserts a verdict", () => {
  const parsed = parseContract(yaml), prior = parsed.contract!
  const state = initialRun(prior, { sessionID: "ses_owner", runId: "run_owner", lock: parsed.lock })
  state.status = "paused"
  state.criteria.C1 = { status: "pass", by: "host", rejections: 1, detail: "historical proof" }
  state.criteria.C2 = { status: "pass", by: "human", rejections: 0, detail: "keep" }
  state.steps.S1 = "done"
  state.verdict = { at: 1, turn: 1, passed: true, lines: [] }
  const next = structuredClone(prior)
  next.title += " amended"
  next.priority = "high"
  next.criteria[0]!.statement += " revised"
  next.plan[0]!.title += " revised"
  const result = amendedState(state, prior, next, "new-lock", "owner accepted", 2)
  expect(result.status).toBe("paused")
  expect(result.title).toBe(next.title)
  expect(result.priority).toBe("high")
  expect(result.criteria.C1).toEqual({ status: "unknown", rejections: 0 })
  expect(result.criteria.C2).toEqual(state.criteria.C2)
  expect(result.steps.S1).toBe("pending")
  expect(result.verdict).toBeUndefined()
  expect(state.criteria.C1.status).toBe("pass") // calculation is not an in-place approval
})

test("accepted amendment recovers a torn contract/run write from its journal without duplicate acceptance or lost evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "ocgoal-amend-commit-"))
  try {
    const store = new Store(root)
    const parsed = parseContract(yaml, { slug: "amend-demo" })
    mkdirSync(store.dir("amend-demo"), { recursive: true })
    writeFileSync(store.contractPath("amend-demo"), yaml)
    const state = initialRun(parsed.contract!, { sessionID: "ses_owner", runId: "run_owner", lock: parsed.lock })
    state.status = "paused"
    state.criteria.C2 = { status: "pass", by: "human", rejections: 0, detail: "preserved proof" }
    store.writeRun(state)
    const reviews = new AmendmentStore(join(store.goalsDir, ".owner-amendments.json"))
    const nextText = yaml.replace("statement: marker exists", "statement: marker exists and follows revised semantics")
    const next = parseContract(nextText, { slug: "amend-demo" })
    const p = reviews.create({ sessionID: state.sessionID, targetSessionID: state.sessionID, slug: state.slug, runId: state.runId, lock: state.lock, nextLock: next.lock, nextText, rationale: "owner asked for revised semantics", diff: amendmentDiff(parsed.contract!, next.contract!), title: "Review marker", question: "Review exact diff", createdAt: Date.now(), expiresAt: Date.now() + 60000, issuerPID: process.pid })
    expect(() => store.commitAmendment(p)).toThrow("no host-recorded acceptance")
    reviews.reserve(p.id)
    const approved = reviews.writeAhead(p.id, { state: amendedState(state, parsed.contract!, next.contract!, next.lock, "owner accepted", 3), acceptedAt: 3 })
    const writeRun = store.writeRun.bind(store)
    store.writeRun = () => { throw new Error("simulated crash after contract rename") }
    expect(() => store.commitAmendment(approved)).toThrow("simulated crash")
    expect(store.readContract(state.slug)?.lock).toBe(next.lock)
    expect(store.readRun(state.slug)?.lock).toBe(state.lock)
    store.writeRun = writeRun
    const recovered = new Store(root).commitAmendment(new AmendmentStore(reviews.file).get(p.id)!)
    expect(recovered.criteria.C2).toEqual(state.criteria.C2)
    expect(recovered.criteria.C1.status).toBe("unknown")
    expect(recovered.lock).toBe(next.lock)
    store.commitAmendment(approved) // replay/redo cannot duplicate generation
    expect(store.readRun(state.slug)?.amendments.filter((a) => a.status === "accepted")).toHaveLength(1)
    expect(store.recent(state.slug, 100).filter((e) => e.type === "amended")).toHaveLength(1)
    expect(readFileSync(join(store.dir(state.slug), "evidence", state.runId, `contract-${state.lock}.yaml`), "utf8")).toBe(yaml)
    writeFileSync(store.contractPath(state.slug), yaml.replace("title: Review the marker", "title: An unrelated generation"))
    expect(() => store.commitAmendment(approved)).toThrow("changed outside the reviewed generation")
  } finally { rmSync(root, { recursive: true, force: true }) }
})
