import { expect, test } from "bun:test"
import { buildHandoff, handoffDigest, HANDOFF_DIGEST_LIMIT } from "../../src/engine/handoff"

// v0.8.0 D1 — the launch handoff is built from facts the host already holds and
// is explicitly not authority. The digest is bounded; the full file is on disk.

const facts = {
  slug: "next-goal",
  title: "Next goal",
  fromSessionID: "ses_from",
  toSessionID: "ses_to",
  prior: { slug: "done-goal", runId: "r1", lock: "a".repeat(64), status: "complete", turn: 9, evidence: ".opencode/goals/done-goal/evidence/r1/", summary: "9/9 proven" },
  repo: { head: "abc123", branch: "main", dirty: [] },
  baseline: [{ id: "C1", pass: false }, { id: "I1", pass: true }],
  nextAction: { step: "S1", title: "author the red tests" },
  authority: { trust: ["goal.yaml", "docs/HANDOFF-v0.8.0.md"], stale: ["docs/HANDOFF.md (v0.3.x body)"] },
  evidence: [".opencode/goals/done-goal/evidence/r1/"],
  now: 1_000,
}

test("the handoff names the prior run, lock, baseline, next action and stale docs", () => {
  const h = buildHandoff(facts)
  expect(h.schema).toBe("opencode-goal/handoff/v1")
  expect(h.markdown).toContain("done-goal")
  expect(h.markdown).toContain("r1")
  expect(h.markdown).toContain("a".repeat(64))
  expect(h.markdown).toContain("C1: failing")
  expect(h.markdown).toContain("S1: author the red tests")
  expect(h.markdown).toContain("docs/HANDOFF.md (v0.3.x body)")
  expect(h.markdown).toContain("context, not authority")
  expect(h.data.prior?.runId).toBe("r1")
})

test("a first goal says so instead of inventing a prior run", () => {
  const h = buildHandoff({ ...facts, prior: undefined })
  expect(h.markdown).toContain("No prior run")
  expect(h.data.prior).toBeUndefined()
})

test("the digest is bounded and says where the full handoff is", () => {
  const huge = `# Handoff\n${"x".repeat(HANDOFF_DIGEST_LIMIT * 2)}`
  const digest = handoffDigest(huge)
  expect(digest.length).toBeLessThanOrEqual(HANDOFF_DIGEST_LIMIT)
  expect(digest).toContain("handoff.md")
})

test("a short document is carried whole", () => {
  const h = buildHandoff(facts)
  expect(handoffDigest(h.markdown)).toBe(h.markdown.trim())
})
