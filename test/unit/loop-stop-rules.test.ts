import { expect, test } from "bun:test"
import { loopStop } from "../../src/engine/loop-stop"
import { nextWork, type WorkCandidate } from "../../src/engine/next-work"

// v0.8.0 C6 — the loop stops only where it must, and never past a first visit
// to a new project or an exhausted budget unless the contract says otherwise.

const currentProject = "/p/current"
const base = { currentProject }

test("a human criterion stops the loop and asks", () => {
  const d = loopStop({ ...base, humanCriterionPending: true })
  expect(d).toMatchObject({ stop: true, code: "human" })
})

test("a real blocker stops the loop and names it", () => {
  const d = loopStop({ ...base, blocker: "missing STRIPE_TEST_KEY" })
  expect(d).toMatchObject({ stop: true, code: "blocker" })
  if (!d.stop) throw new Error("expected stop")
  expect(d.reason).toContain("STRIPE_TEST_KEY")
})

test("an outward or destructive act stops the loop for authorization", () => {
  expect(loopStop({ ...base, outwardActRequired: true })).toMatchObject({ stop: true, code: "outward" })
})

test("a first visit to a new project stops unless the contract waives it", () => {
  const facts = { ...base, candidateProject: "/p/other" }
  expect(loopStop(facts)).toMatchObject({ stop: true, code: "new-project" })
  expect(loopStop({ ...facts, visitedProjects: ["/p/other"] })).toEqual({ stop: false })
  expect(loopStop({ ...facts, allowNewProjects: true })).toEqual({ stop: false })
})

test("an exhausted budget stops unless the contract waives it", () => {
  expect(loopStop({ ...base, budgetExhausted: true })).toMatchObject({ stop: true, code: "budget" })
  expect(loopStop({ ...base, budgetExhausted: true, allowBudgetExhaustion: true })).toEqual({ stop: false })
})

test("safety stops outrank the owner waivers", () => {
  expect(loopStop({ ...base, humanCriterionPending: true, allowNewProjects: true, allowBudgetExhaustion: true }))
    .toMatchObject({ stop: true, code: "human" })
})

const cleo = (over: Partial<WorkCandidate> = {}): WorkCandidate => ({
  source: "cleo", project: currentProject, taskId: "T1", title: "ready item", ...over,
})
const peer = (over: Partial<WorkCandidate> = {}): WorkCandidate => ({
  source: "peer", project: currentProject, title: "peer offer", from: "p@h", ...over,
})

const input = (over: Partial<Parameters<typeof nextWork>[0]> = {}) => ({
  candidates: [] as WorkCandidate[],
  currentProject,
  announce: {},
  now: 10_000,
  cooldownMs: 60_000,
  ...over,
})

test("a ready CLEO item is chosen before a peer offer, and starts", () => {
  const d = nextWork(input({ candidates: [peer(), cleo()] }))
  expect(d.kind).toBe("start")
  if (d.kind !== "start") throw new Error("expected start")
  expect(d.candidate.source).toBe("cleo")
  expect(d.candidate.taskId).toBe("T1")
})

test("with no work, an idle loop announces; an outstanding announcement holds", () => {
  expect(nextWork(input()).kind).toBe("announce")
  const held = nextWork(input({ announce: { outstanding: { id: "m1", at: 1 } } }))
  expect(held).toEqual({ kind: "hold", reason: "outstanding" })
  expect(nextWork(input({ announce: { lastAt: 9_000 } })).kind).toBe("hold")
})

test("a new-project candidate stops instead of starting, and no announce masks it", () => {
  const d = nextWork(input({ candidates: [cleo({ project: "/p/other" })] }))
  expect(d.kind).toBe("stop")
  if (d.kind !== "stop") throw new Error("expected stop")
  expect(d.code).toBe("new-project")
})

test("an exhausted budget stops a candidate, and the waiver starts it", () => {
  expect(nextWork(input({ candidates: [cleo()], budgetExhausted: true })).kind).toBe("stop")
  expect(nextWork(input({ candidates: [cleo()], budgetExhausted: true, allowBudgetExhaustion: true })).kind).toBe("start")
})

test("a human criterion outranks ready work", () => {
  const d = nextWork(input({ candidates: [cleo()], humanCriterionPending: true }))
  expect(d.kind).toBe("stop")
  if (d.kind !== "stop") throw new Error("expected stop")
  expect(d.code).toBe("human")
})

test("a candidate for a project already visited starts", () => {
  const d = nextWork(input({ candidates: [cleo({ project: "/p/other" })], visitedProjects: ["/p/other"] }))
  expect(d.kind).toBe("start")
})
