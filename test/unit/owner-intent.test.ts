import { expect, test } from "bun:test"
import { explicitResume, ownerResumeMessage } from "../../src/engine/owner-intent"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { OwnerReviewStore, type ReviewRequest } from "../../src/engine/owner-reviews"

test("bounded owner spellings do not turn quoted or conditional wording into approval", () => {
  for (const value of ["resume", "continue", "Please resume.", "I approve you to resume. You should be autonomous."])
    expect(explicitResume(value)).toBe(true)
  for (const value of ['The log says "resume"', "resume when I approve", "I approve you to resume. Do not resume it.", "I accept", "resume someone else's goal"])
    expect(explicitResume(value)).toBe(false)
})

test("source and generation are mandatory; steering does not revoke a genuine unconsumed directive", () => {
  const message = { id: "msg_owner", type: "user", text: "resume", time: { created: 100 } }
  expect(ownerResumeMessage([message], 90)?.id).toBe(message.id)
  expect(ownerResumeMessage([message], 101)).toBeUndefined()
  expect(ownerResumeMessage([{ ...message, type: "assistant" }], 90)).toBeUndefined()
  expect(ownerResumeMessage([{ ...message, metadata: { goal: { kind: "continue" } } }], 90)).toBeUndefined()
  expect(ownerResumeMessage([{ ...message, id: "msg_worker", type: "synthetic" }], 90)).toBeUndefined()
  expect(ownerResumeMessage([message, { ...message, id: "msg_worker", type: "synthetic" }], 90)?.id).toBe(message.id)
  expect(ownerResumeMessage([message, { ...message, id: "msg_question", text: "Is the evidence report stale?" }], 90)?.id).toBe(message.id)
  expect(ownerResumeMessage([message, { ...message, id: "msg_stop", text: "Do not resume." }], 90)).toBeUndefined()
})

test("I accept is an answer only to a specific current review, never a free-standing permission", () => {
  const message = { id: "msg_accept", type: "user", text: "I accept", time: { created: 100 } }
  expect(ownerResumeMessage([message], 90)).toBeUndefined()
  expect(ownerResumeMessage([message], 90, { createdAt: 95, expiresAt: 105 })?.id).toBe(message.id)
  expect(ownerResumeMessage([message], 90, { createdAt: 101, expiresAt: 105 })).toBeUndefined()
  expect(ownerResumeMessage([message], 90, { createdAt: 95, expiresAt: 99 })).toBeUndefined()
})

test("separate store instances cannot reserve different requests using the same owner message, even after failure/restart", () => {
  const root = mkdtempSync(join(tmpdir(), "owner-consumption-"))
  try {
    const file = join(root, "reviews.json"), first = new OwnerReviewStore<ReviewRequest>(file, [])
    const input = { sessionID: "ses_owner", slug: "demo", lock: "lock", title: "Resume", question: "resume", ownerMessageID: "msg_actual_owner",
      createdAt: Date.now(), expiresAt: Date.now() + 60000, issuerPID: process.pid }
    const a = first.create(input)
    expect(first.reserve(a.id)?.status).toBe("executing")
    const second = new OwnerReviewStore<ReviewRequest>(file, []), b = second.create(input)
    expect(second.reserve(b.id)).toBeUndefined()
    first.update(a.id, { status: "failed", result: "The operation was attempted; the choice stays consumed." })
    const recovered = new OwnerReviewStore<ReviewRequest>(file, []), c = recovered.create(input)
    expect(recovered.reserve(c.id)).toBeUndefined()
  } finally { rmSync(root, { recursive: true, force: true }) }
})
