import { expect, test } from "bun:test"
import { launchStatusText } from "../../src/tui/manager"

// T098: a redundant launch attempt for the SAME session/slug/locked goal is
// distinguished from a live run — the banner keeps the live run and never
// recommends aborting it — while unrelated, changed-lock and genuine failed
// launches retain explicit truthful recovery.

const live = { slug: "demo", sessionID: "ses_owner", lock: "live-lock", runId: "run1", status: "waiting" } as any
const attempt = (over: Record<string, unknown> = {}) => ({ slug: "demo", sessionID: "ses_owner", lock: "live-lock", fresh: false, status: "failed", result: "reservation refused; nothing started", expiresAt: 0, decisionId: "d1", updatedAt: 0, ...over }) as any

test("a failed duplicate attempt keeps the live run and never recommends aborting it", () => {
  const text = launchStatusText(attempt(), live)
  expect(text).toBeDefined()
  expect(text).toContain("existing run unchanged")
  expect(text).not.toMatch(/abort/i)
  // it reports the attempt, not a fabricated success
  expect(text).toContain("failed")
})

test("unrelated and changed-lock failures keep their own explicit recovery text", () => {
  const unrelated = launchStatusText(attempt({ slug: "other" }), live)
  expect(String(unrelated)).not.toContain("existing run unchanged")
  expect(String(unrelated)).toMatch(/failed|nothing started/i)
  const changedLock = launchStatusText(attempt({ lock: "different-lock" }), live)
  expect(String(changedLock)).not.toContain("existing run unchanged")
  expect(String(changedLock)).not.toMatch(/abort/i)
})

test("no attempt or a succeeded attempt shows no attempt banner", () => {
  expect(launchStatusText(undefined, live)).toBeUndefined()
  expect(launchStatusText(attempt({ status: "succeeded", result: "started" }), live)).toBeUndefined()
})
