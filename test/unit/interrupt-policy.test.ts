import { expect, test } from "bun:test"
import { restartDecision, type RestartFacts } from "../../src/engine/interrupt-policy"

// v0.8.0 C1 (pure half) — a clean restart resumes by itself; a changed
// contract, a repaired/divergent run or an interrupted write still pauses.

const facts = (over: Partial<RestartFacts> = {}): RestartFacts => ({
  status: "running",
  lock: "a".repeat(64),
  diskLock: "a".repeat(64),
  runIntact: true,
  ...over,
})

test("an unchanged lock and an intact run resume without an owner decision", () => {
  for (const status of ["running", "waiting", "verifying"] as const) {
    const d = restartDecision(facts({ status }))
    expect(d.action, status).toBe("resume")
    expect("reason" in d && d.reason).toContain("unchanged")
  }
})

test("the contract changing under the run still pauses and names both generations", () => {
  const d = restartDecision(facts({ diskLock: "b".repeat(64) }))
  expect(d.action).toBe("pause")
  if (d.action !== "pause") throw new Error("expected pause")
  expect(d.code).toBe("diverged")
  expect(d.reason).toContain("aaaaaaaaaaaa")
  expect(d.reason).toContain("bbbbbbbbbbbb")
})

test("a missing contract pauses instead of resuming against unknown bytes", () => {
  const d = restartDecision(facts({ diskLock: undefined }))
  expect(d.action).toBe("pause")
  if (d.action !== "pause") throw new Error("expected pause")
  expect(d.code).toBe("contract-missing")
})

test("a run repaired from its ledger is not resumed blindly", () => {
  const d = restartDecision(facts({ runIntact: false }))
  expect(d.action).toBe("pause")
  if (d.action !== "pause") throw new Error("expected pause")
  expect(d.code).toBe("not-intact")
})

test("an interrupted write pauses even when the lock matches", () => {
  const d = restartDecision(facts({ interruptedWrite: true }))
  expect(d.action).toBe("pause")
  if (d.action !== "pause") throw new Error("expected pause")
  expect(d.code).toBe("interrupted-write")
})

test("a stopped run is the owner's restart, not the host's", () => {
  for (const status of ["paused", "blocked", "needs_review", "budget_limited", "complete", "failed", "aborted", "superseded"] as const) {
    expect(restartDecision(facts({ status })).action, status).toBe("none")
  }
})

test("safety facts are checked before the lock (a repair never resumes on a matching lock)", () => {
  const d = restartDecision(facts({ runIntact: false, interruptedWrite: true, diskLock: "b".repeat(64) }))
  expect(d.action).toBe("pause")
  if (d.action !== "pause") throw new Error("expected pause")
  expect(d.code).toBe("not-intact")
})
