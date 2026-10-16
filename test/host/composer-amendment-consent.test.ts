import { expect, test } from "bun:test"
import { ownerAmendmentMessage } from "../../src/engine/owner-intent"

// T095: a staged amendment is resolved ONLY from genuine Composer chat consent.
// The pure owner-message reader is the authority boundary: quoted, conditional,
// stale, synthetic and worker-only text must never read as acceptance, and it
// must match the exact reviewed amendment.

const review = { createdAt: 1000, expiresAt: 9_999_999, expiryPolicy: "target" as const }
const owner = (text: string, created = 1500) => ({ type: "user", id: "msg_owner", text, time: { created } })
const worker = (text: string, created = 1500) => ({ type: "user", id: "msg_worker", text, time: { created }, metadata: { goal: { slug: "demo" } } })

test("only genuine, unambiguous owner acceptance authorizes the exact amendment", () => {
  expect(ownerAmendmentMessage([owner("I accept")], review, "accept")).toMatchObject({ id: "msg_owner" })
  expect(ownerAmendmentMessage([owner("yes, I approve this amendment")], review, "accept")).toMatchObject({ id: "msg_owner" })
  expect(ownerAmendmentMessage([owner("I reject")], review, "reject")).toMatchObject({ id: "msg_owner" })
})

test("quoted, conditional, stale and worker-only input never authorizes acceptance", () => {
  expect(ownerAmendmentMessage([owner('the log says "I accept"')], review, "accept")).toBeUndefined()
  expect(ownerAmendmentMessage([owner("I accept if you think it is right")], review, "accept")).toBeUndefined()
  expect(ownerAmendmentMessage([owner("I accept when the build is green")], review, "accept")).toBeUndefined()
  expect(ownerAmendmentMessage([owner("I accept", 500)], review, "accept"), "before staging").toBeUndefined()
  expect(ownerAmendmentMessage([owner("I do not accept")], review, "accept")).toBeUndefined()
  expect(ownerAmendmentMessage([worker("I accept")], review, "accept"), "worker goal message").toBeUndefined()
  // a rejection is not an acceptance and vice versa
  expect(ownerAmendmentMessage([owner("I reject")], review, "accept")).toBeUndefined()
  expect(ownerAmendmentMessage([owner("I accept")], review, "reject")).toBeUndefined()
})

test("a clock-expired legacy review cannot be accepted", () => {
  const timed = { createdAt: 1000, expiresAt: 2000, expiryPolicy: "time" as const }
  expect(ownerAmendmentMessage([owner("I accept", 2500)], timed, "accept")).toBeUndefined()
  expect(ownerAmendmentMessage([owner("I accept", 1500)], timed, "accept")).toMatchObject({ id: "msg_owner" })
})
