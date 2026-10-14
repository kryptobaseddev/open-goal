import { expect, test } from "bun:test"
import { ownerLaunchMessage, ownerResumeMessage } from "../../src/engine/owner-intent"

const target = { slug: "demo", lock: "a".repeat(64), fresh: false }
const displayed = [{ ...target, id: "review", at: 100 }]
const owner = (text: string, created = 200) => ({ type: "user", id: "owner-msg", text, time: { created } })

test("launch authority is an explicit actual owner instruction bound to displayed bytes and mode", () => {
  for (const text of ["Start the goal now.", "start the goal", "continue your goal", "Just go ahead and start the plan. I approve."])
    expect(ownerLaunchMessage([owner(text)], displayed, target)).toMatchObject({ id: "owner-msg", text, reviewId: "review" })
  for (const text of ['The agent said "start the goal"', "Start the goal if tests pass", "I approve", "start other", "Start in a fresh session"])
    expect(ownerLaunchMessage([owner(text)], displayed, target)).toBeUndefined()
  expect(ownerLaunchMessage([{ ...owner("Start the goal now."), type: "assistant" }], displayed, target)).toBeUndefined()
  expect(ownerLaunchMessage([{ ...owner("Start the goal now."), metadata: { goal: {} } }], displayed, target)).toBeUndefined()
  expect(ownerLaunchMessage([owner("Start the goal now.", 99)], displayed, target)).toBeUndefined()
  expect(ownerLaunchMessage([owner("Start the goal now.")], [], target)).toBeUndefined()
  expect(ownerLaunchMessage([owner("Start the goal now.")], displayed, { ...target, fresh: true })).toBeUndefined()
  expect(ownerLaunchMessage([owner("Start the goal now.")], displayed, { ...target, lock: "b".repeat(64) })).toBeUndefined()
})

test("steering preserves explicit launch intent; later stop, condition or another displayed target does not", () => {
  const directive = owner("continue your goal", 150)
  expect(ownerLaunchMessage([directive, owner("Why is the banner expired?")], displayed, target)).toMatchObject({ id: directive.id })
  for (const text of ["stop", "pause", "Do not start the goal", "Continue the goal if checks pass", "I revoke my approval"])
    expect(ownerLaunchMessage([directive, owner(text)], displayed, target)).toBeUndefined()
  expect(ownerLaunchMessage([directive], [...displayed, { ...target, slug: "other", id: "other", at: 180 }], target)).toBeUndefined()
  expect(ownerLaunchMessage([directive], [...displayed, { ...target, id: "same-represented", at: 180 }], target)).toMatchObject({ reviewId: "review" })
})

test("continue-your-goal is also a fresh same-generation resume directive, never a stale or conditional one", () => {
  expect(ownerResumeMessage([owner("continue your goal")], 100)).toMatchObject({ id: "owner-msg" })
  expect(ownerResumeMessage([owner("resume the goal")], 100)).toMatchObject({ id: "owner-msg" })
  expect(ownerResumeMessage([owner("continue your goal", 99)], 100)).toBeUndefined()
  expect(ownerResumeMessage([owner("continue your goal if tests pass")], 100)).toBeUndefined()
  expect(ownerResumeMessage([owner("continue your goal"), owner("Do not continue the goal")], 100)).toBeUndefined()
})
