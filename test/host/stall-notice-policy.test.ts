import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { M, renderMessage } from "../../src/server/messages"
import { PLUGIN } from "./goal.helpers"

// T111: with autonomy.on_stall shipped, the stall notice must point the owner at
// /goal resume AND at the owner-set on_stall option that would have continued a
// genuinely working run. The findings doc records the exact wording.

test("the stall notice names the on_stall option and the owner's choices", () => {
  const notice = M.pausedStalled("stalled: no change the host could see for 3 turns", "pause")
  expect(notice.id).toBe("goal.paused.stalled")
  expect(notice.text).toContain("autonomy.on_stall")
  expect(notice.text).toContain('"pause"')
  expect(notice.text).toContain("/goal resume")
  expect(notice.text).toContain("/goal abort")
  // The rendered inline form keeps the same guidance.
  expect(renderMessage(notice)).toContain("/goal resume")

  // The continue policy is named too, so the owner sees the alternative value.
  expect(M.pausedStalled("stalled: no visible change for 2 turns while the agent kept working", "continue").text).toContain('"continue"')
})

test("the findings doc records the stall-notice wording", () => {
  const doc = readFileSync(join(PLUGIN, "docs/research/verifier-robustness-findings.md"), "utf8")
  expect(doc).toContain("autonomy.on_stall")
  expect(doc).toContain("/goal resume")
  expect(doc).toContain("so a stalled-but-active run keeps going")
})
