import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { OwnerReviewStore, reviewExpired, type ReviewRequest } from "../../src/engine/owner-reviews"

// Same target/nonce/value checks remain mandatory without a lifecycle clock.
const choices = [{ value: "resume", label: "Resume selected goal", description: "Only the exact reviewed run" }]
const input = () => ({ sessionID: "ses_owner", slug: "demo", lock: "sealed", title: "Native review", question: "Exact native review", createdAt: Date.now() - 3600000, expiresAt: 0, issuerPID: process.pid })

test("target-bound native reviews survive elapsed time and store reload, but are still one-use", () => {
  const root = mkdtempSync(join(tmpdir(), "target-review-"))
  try {
    const file = join(root, "reviews.json"), first = new OwnerReviewStore<ReviewRequest>(file, choices)
    const request = first.create({ ...input(), expiryPolicy: "target" })
    expect(reviewExpired(request)).toBe(false)
    const fresh = new OwnerReviewStore<ReviewRequest>(file, choices)
    const bound = fresh.bind({ id: "frm_actual", sessionID: request.sessionID, fields: [{ key: "q0", description: request.question, options: [{ value: "resume", label: choices[0]!.label }] }] })
    expect(bound?.formID).toBe("frm_actual")
    expect(fresh.reserve(request.id)?.status).toBe("executing")
    expect(first.reserve(request.id)).toBeUndefined()
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test("legacy timed and launch reviews still expire; target policy never authorizes unrelated fields", () => {
  const root = mkdtempSync(join(tmpdir(), "timed-review-"))
  try {
    const store = new OwnerReviewStore<ReviewRequest>(join(root, "reviews.json"), choices)
    const legacy = store.create(input())
    expect(reviewExpired(legacy)).toBe(true)
    expect(store.reserve(legacy.id)).toBeUndefined()
    const launch = store.create({ ...input(), expiryPolicy: "time" })
    expect(reviewExpired(launch)).toBe(true)
    expect(store.reserve(launch.id)).toBeUndefined()
    const target = store.create({ ...input(), expiryPolicy: "target" })
    expect(store.bind({ id: "frm_unrelated", sessionID: target.sessionID, fields: [{ key: "q0", description: "Another question", options: [{ value: "resume", label: choices[0]!.label }] }] })).toBeUndefined()
    expect(store.get(target.id)?.status).toBe("pending")
  } finally { rmSync(root, { recursive: true, force: true }) }
})
