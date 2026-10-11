import { expect, test } from "bun:test"
import { directGoalCommand } from "../../src/server/intent"

test("known explicit shorthand is preserved, conversational text is not treated as a first-word command", () => {
  const known = ["demo", "next-goal"]
  for (const input of ["status", "list all", "start", "start demo", "start demo fresh", "pause", "resume next-goal", "approve C4", "reject C4 fix the copy", "amend confirm", "new build a feature"])
    expect(directGoalCommand(input, known), input).toBe(true)
  for (const input of ["", "start writing a reliable feature", "pause the import goal for now", "amend this to include retries", "show my goals", "start a goal", "list the unfinished goals", "approve the new scope", "start demo and delete everything", "resume unknown-goal"])
    expect(directGoalCommand(input, known), input).toBe(false)
})
