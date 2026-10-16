import { expect, test } from "bun:test"
import { ownerAmendmentMessage } from "../../src/engine/owner-intent"

// T096: an explicit owner acceptance arriving AFTER review staging but BEFORE
// its native form binds must reach the exact typed resolver once. The reader
// must not require a bound form id, must reject text from before staging, and
// later contradictory input must win (so an early reply cannot be replayed past
// a newer "do not accept").

const review = { createdAt: 1000, expiresAt: 9_999_999, expiryPolicy: "target" as const }
const owner = (text: string, created: number) => ({ type: "user", id: `msg_${created}`, text, time: { created } })

test("an acceptance after staging resolves without a bound form or a fabricated reply", () => {
  // no formID anywhere — the pre-form arrival still reaches the resolver
  expect(ownerAmendmentMessage([owner("I accept", 1200)], review, "accept")).toMatchObject({ id: "msg_1200" })
  expect(ownerAmendmentMessage([owner("I accept, resume the goal", 1400)], review, "accept")?.continueGoal).toBe(true)
})

test("pre-staging text and later contradictory input never authorize acceptance", () => {
  expect(ownerAmendmentMessage([owner("I accept", 500)], review, "accept")).toBeUndefined()
  // a later contradiction is the latest message and must not accept
  expect(ownerAmendmentMessage([owner("I accept", 1200), owner("do not accept it", 1300)], review, "accept")).toBeUndefined()
  expect(ownerAmendmentMessage([owner("I accept", 1200), owner("actually, reject it", 1300)], review, "accept")).toBeUndefined()
})
