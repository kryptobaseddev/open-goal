import { expect, test } from "bun:test"
import { ownerAmendmentMessage } from "../../src/engine/owner-intent"
import { OwnerReviewStore, type ReviewRequest } from "../../src/engine/owner-reviews"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const review = { createdAt: 100, expiresAt: 200 }
const user = (text: string, created = 150) => ({ id: "msg-owner", type: "user", text, time: { created } })

test("unambiguous amendment acceptance is the actual latest owner message, not tool arguments", () => {
  for (const text of ["accept", "I accept the amendment", "I approve the ammendment", "Accept amendment", "please approve that proposal", "I accept the amendment get it done", "I approve the amendment, then resume the goal."])
    expect(ownerAmendmentMessage([user(text)], review, "accept")?.id).toBe("msg-owner")
  expect(ownerAmendmentMessage([user("I accept the amendment get it done")], review, "accept")?.continueGoal).toBe(true)
  expect(ownerAmendmentMessage([user("I accept the amendment")], review, "accept")?.continueGoal).toBe(false)
})

test("quoted, conditional, contradictory, stale, synthetic and worker assertions are not consent", () => {
  for (const text of ['The agent says "accept"', "accept if tests pass", "I do not accept", "accept but change the check", "I approve C13", "is accept an option?", "approve the launch", "I accept the amendment, never resume"])
    expect(ownerAmendmentMessage([user(text)], review, "accept")).toBeUndefined()
  expect(ownerAmendmentMessage([user("accept", 99)], review, "accept")).toBeUndefined()
  expect(ownerAmendmentMessage([user("accept", 201)], review, "accept")).toBeUndefined()
  expect(ownerAmendmentMessage([{ ...user("accept"), type: "assistant" }], review, "accept")).toBeUndefined()
  expect(ownerAmendmentMessage([{ ...user("accept"), metadata: { goal: { kind: "review" } } }], review, "accept")).toBeUndefined()
  expect(ownerAmendmentMessage([user("accept"), user("stop", 151)], review, "accept")).toBeUndefined()
})

test("target-bound reply survives elapsed time; reject/comment cannot masquerade as acceptance", () => {
  expect(ownerAmendmentMessage([user("accept", 250)], { ...review, expiryPolicy: "target" }, "accept")?.id).toBe("msg-owner")
  expect(ownerAmendmentMessage([user("reject the amendment")], review, "reject")?.id).toBe("msg-owner")
  expect(ownerAmendmentMessage([user("change the scope")], review, "comment")?.text).toBe("change the scope")
  expect(ownerAmendmentMessage([user('change C1 to "marker is ready" if needed')], review, "comment")?.id).toBe("msg-owner")
  expect(ownerAmendmentMessage([user("accept")], review, "comment")).toBeUndefined()
  expect(ownerAmendmentMessage([user("reject")], review, "accept")).toBeUndefined()
})

test("binding the actual chat spends it across store instances and failed or cancelled proposals", () => {
  const root = mkdtempSync(join(tmpdir(), "amendment-chat-consumption-"))
  try {
    const file = join(root, "reviews.json"), first = new OwnerReviewStore<ReviewRequest>(file, [])
    const input = { sessionID: "ses_owner", slug: "demo", lock: "lock", title: "Amend", question: "accept amendment?", createdAt: Date.now(), expiresAt: Date.now() + 60000, issuerPID: process.pid }
    const a = first.create(input)
    first.interruptForm(a.id)
    expect(first.bindOwnerMessage(a.id, "msg_owner")?.status).toBe("pending")
    expect(first.bindOwnerMessage(a.id, "msg_owner")).toBeUndefined()
    const second = new OwnerReviewStore<ReviewRequest>(file, [])
    const b = second.create(input) // previous review cancelled; its chat remains spent
    expect(second.bindOwnerMessage(b.id, "msg_owner")).toBeUndefined()
    expect(second.bindOwnerMessage(b.id, "msg_new")?.ownerMessageID).toBe("msg_new")
    expect(second.reserve(b.id)?.status).toBe("executing")
    second.update(b.id, { status: "failed", result: "attempt failed; consent is not reusable" })
    const recovered = new OwnerReviewStore<ReviewRequest>(file, []), c = recovered.create(input)
    expect(recovered.bindOwnerMessage(c.id, "msg_new")).toBeUndefined()
  } finally { rmSync(root, { recursive: true, force: true }) }
})
