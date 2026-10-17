import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DecisionStore, decisionChoices, shouldReaskDecision } from "../../src/engine/decisions"
import { selectedReviewChoice } from "../../src/engine/owner-reviews"
import { M } from "../../src/server/messages"

test("dynamic lifecycle choices bind exact session/question/field values and survive store reload", () => {
  const root = mkdtempSync(join(tmpdir(), "ocgoal-decisions-"))
  try {
    const file = join(root, "reviews.json")
    const store = new DecisionStore(file)
    const p = store.create({ sessionID: "ses_owner", slug: "demo", lock: "sealed-lock", title: "Sign off", question: "Exact native review", kind: "needs_review", target: { slug: "demo", runId: "run_demo", lock: "sealed-lock", status: "needs_review" }, message: M.needsSignOff(["C4"]), candidates: {}, extra: {}, createdAt: Date.now(), expiresAt: Date.now() + 60000, issuerPID: process.pid })
    const choices = decisionChoices(p)
    const options = choices.map((c) => ({ value: c.label, label: c.label }))
    expect(store.bind({ id: "other-form", sessionID: p.sessionID, fields: [{ key: "q0", title: "Unrelated wording choice", options }] })).toBeUndefined()
    expect(store.bind({ id: "other-session", sessionID: "ses_other", fields: [{ key: "q0", title: p.question, options }] })).toBeUndefined()
    const bound = store.bind({ id: "actual-form", sessionID: p.sessionID, fields: [{ key: "q0", title: "Goal", description: p.question, options }] })!
    expect(bound.id).toBe(p.id)
    expect(selectedReviewChoice(bound, choices, { q0: "Approve C4 (triggers verify)" })?.value).toBe("0")
    expect(selectedReviewChoice(bound, choices, { q0: "Approve C4 (triggers verify) is commentary; do not approve" })).toBeUndefined()
    expect(selectedReviewChoice(bound, choices, { q0: "0" })).toBeUndefined()
    expect(selectedReviewChoice(bound, choices, { unrelated: "Approve C4 (triggers verify)" })).toBeUndefined()
    const recovered = new DecisionStore(file)
    expect(recovered.byForm(p.sessionID, "actual-form")).toMatchObject({ id: p.id, target: p.target, status: "pending" })
    expect(recovered.reserve(p.id)?.status).toBe("executing")
    expect(store.reserve(p.id)).toBeUndefined() // form/dialog contend for ONE reservation
    recovered.update(p.id, { status: "succeeded", result: "Actual operation succeeded" })
    expect(store.reserve(p.id)).toBeUndefined()
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test("cancellation invalidates the old core form but retains the exact unresolved decision for a new presentation", () => {
  const root = mkdtempSync(join(tmpdir(), "ocgoal-decision-interrupt-"))
  try {
    const store = new DecisionStore(join(root, "reviews.json"))
    const p = store.create({ sessionID: "ses_owner", slug: "demo", lock: "lock", title: "Blocked", question: "Review blocked goal", kind: "blocked", target: { slug: "demo", lock: "lock", runId: "run_demo", status: "blocked" }, message: M.blocked("credential", "token is absent"), candidates: {}, extra: {}, createdAt: Date.now(), expiresAt: Date.now() + 60000, issuerPID: process.pid })
    const options = decisionChoices(p).map((c) => ({ value: c.label, label: c.label }))
    store.bind({ id: "old", sessionID: p.sessionID, fields: [{ key: "q0", title: p.question, options }] })
    expect(store.interruptForm(p.id)?.status).toBe("interrupted")
    expect(store.byForm(p.sessionID, "old")).toBeUndefined()
    expect(store.reserve(p.id)).toBeUndefined()
    const restored = store.reopenForm(p.id)!
    expect(restored.question).toBe(p.question)
    expect(restored.target).toEqual(p.target)
    expect(store.bind({ id: "new", sessionID: p.sessionID, fields: [{ key: "q0", title: restored.question, options }] })?.id).toBe(p.id)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test("re-ask policy: one ask per process, then silence until review or reload", () => {
  // a never-presented pending decision is asked on the turn end that follows
  expect(shouldReaskDecision({ alreadyAsked: false, status: "pending", stale: false, formOpen: false })).toEqual({ ask: true })
  // once the form has been offered, an unanswered turn end does not ask again
  expect(shouldReaskDecision({ alreadyAsked: true, status: "pending", stale: false, formOpen: false })).toEqual({ ask: false, reason: "already-asked" })
  // a dismissed form is restored explicitly, not by ordinary execution
  expect(shouldReaskDecision({ alreadyAsked: false, status: "interrupted", stale: false, formOpen: false })).toEqual({ ask: false, reason: "interrupted" })
  // a live form is never duplicated
  expect(shouldReaskDecision({ alreadyAsked: false, status: "pending", stale: false, formOpen: true })).toEqual({ ask: false, reason: "form-open" })
  // stale wins even over a never-asked decision
  expect(shouldReaskDecision({ alreadyAsked: false, status: "pending", stale: true, formOpen: false })).toEqual({ ask: false, reason: "stale" })
})
