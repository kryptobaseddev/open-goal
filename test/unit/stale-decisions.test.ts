import { expect, test } from "bun:test"
import { decisionStaleness, sameTarget, staleDecision } from "../../src/engine/stale-decisions"

// v0.8.0 C3 (pure half) — a decision whose target moved, whose clock expired or
// which was already answered is stale and must never be re-presented. A merely
// dismissed review is still unanswered and may be re-presented.

const lock = "a".repeat(64)
const target = { slug: "demo", runId: "r1", sessionID: "s1", lock, status: "paused" }
const request = { status: "pending", expiresAt: 0, expiryPolicy: "target" as const }
const bound = { slug: "demo", runId: "r1", sessionID: "s1", lock }

test("a live target-bound review is not stale", () => {
  expect(decisionStaleness(request, target)).toEqual({ stale: false })
  expect(staleDecision(request, bound, target)).toEqual({ stale: false })
})

test("an answered, rejected, cancelled or failed decision is never re-presented", () => {
  for (const status of ["succeeded", "rejected", "commented", "cancelled", "failed", "expired"]) {
    const d = decisionStaleness({ ...request, status }, target)
    expect(d.stale, status).toBe(true)
    if (!d.stale) throw new Error("expected stale")
    expect(d.code).toBe("answered")
    expect(d.reason).toContain(status)
  }
})

test("an expired timed review is stale; a target-bound one never expires by clock", () => {
  const timed = { status: "pending", expiresAt: 1000 }
  const d = decisionStaleness(timed, target, 1001)
  expect(d.stale).toBe(true)
  if (!d.stale) throw new Error("expected stale")
  expect(d.code).toBe("expired")
  expect(decisionStaleness({ ...timed, expiresAt: 9999 }, target, 1001)).toEqual({ stale: false })
  expect(decisionStaleness({ ...request, expiresAt: 1 }, target, 9_999_999)).toEqual({ stale: false })
})

test("a superseded target silences its decision", () => {
  const d = decisionStaleness(request, { ...target, status: "superseded" })
  expect(d.stale).toBe(true)
  if (!d.stale) throw new Error("expected stale")
  expect(d.code).toBe("superseded")
})

test("a changed generation, run or session invalidates the review", () => {
  expect(staleDecision(request, bound, { ...target, lock: "b".repeat(64) }).stale).toBe(true)
  expect(staleDecision(request, bound, { ...target, runId: "r2" }).stale).toBe(true)
  expect(staleDecision(request, bound, { ...target, sessionID: "s2" }).stale).toBe(true)
  expect(staleDecision(request, bound, undefined).stale).toBe(true)
  const changed = staleDecision(request, bound, { ...target, lock: "b".repeat(64) })
  if (!changed.stale) throw new Error("expected stale")
  expect(changed.code).toBe("target-changed")
})

test("a status change on the same generation does not silence an unanswered review", () => {
  expect(staleDecision(request, bound, { ...target, status: "running" })).toEqual({ stale: false })
})

test("a dismissed (interrupted) review is unanswered, not stale", () => {
  expect(decisionStaleness({ ...request, status: "interrupted" }, target)).toEqual({ stale: false })
})

test("sameTarget compares the exact tuple, including absent fields", () => {
  expect(sameTarget(bound, target)).toBe(true)
  expect(sameTarget(bound, { ...target, runId: undefined })).toBe(false)
  expect(sameTarget(bound, undefined)).toBe(false)
})
