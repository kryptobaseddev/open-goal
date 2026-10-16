import { expect, test } from "bun:test"
import { ownerAmendmentMessage } from "../../src/engine/owner-intent"

// T097: an authenticated owner continuation after an accepted amendment is
// honored even when the optional agent hint is absent or false; plain
// acceptance stays stopped, and a true hint without a real owner continuation
// never authorizes one. The reader derives continuation from the OWNER text,
// not from any tool-supplied flag.

const review = { createdAt: 1000, expiresAt: 9_999_999, expiryPolicy: "target" as const }
const owner = (text: string) => ({ type: "user", id: "msg_owner", text, time: { created: 1500 } })

test("plain acceptance does not authorize a continuation", () => {
  const accepted = ownerAmendmentMessage([owner("I accept")], review, "accept")
  expect(accepted).toBeDefined()
  expect(accepted!.continueGoal).toBeFalsy()
})

test("an explicit owner continuation is carried from the owner's own words", () => {
  for (const text of ["I accept and resume the goal", "I accept, continue the goal", "I accept, get it done", "I accept and finish it"]) {
    expect(ownerAmendmentMessage([owner(text)], review, "accept")?.continueGoal, text).toBe(true)
  }
})

test("a continuation request without acceptance is not consent, and is not acceptance", () => {
  // a true hint alone cannot create permission
  expect(ownerAmendmentMessage([owner("resume the goal")], review, "accept")).toBeUndefined()
  expect(ownerAmendmentMessage([owner("continue")], review, "accept")).toBeUndefined()
  // a false/absent hint is not consulted at all: the owner text is the only source
  expect(ownerAmendmentMessage([owner("I accept and resume the goal")], review, "accept")?.continueGoal).toBe(true)
})
