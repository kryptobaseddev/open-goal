import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LaunchStore, launchView } from "../../src/engine/launches"

test("distinct launch reviews reserve the draft/session once and expose admission without a run", () => {
  const root = mkdtempSync(join(tmpdir(), "launch-activity-"))
  try {
    const store = new LaunchStore(join(root, "launches.json"))
    const base = { slug: "demo", lock: "lock", fresh: false, title: "Demo", question: "Review", createdAt: Date.now(), expiresAt: Date.now() + 60000, issuerPID: process.pid }
    const first = store.create({ ...base, sessionID: "author1" })
    const other = store.create({ ...base, sessionID: "author2" })
    expect(store.reserve(first.id)?.status).toBe("executing")
    expect(store.reserve(other.id)).toBeUndefined()
    expect(store.get(other.id)?.status).toBe("pending")
    const sameSession = store.create({ ...base, slug: "different", sessionID: "author1" })
    expect(store.reserve(sameSession.id)).toBeUndefined()
    const activity = { phase: "check" as const, since: Date.now(), detail: "Rehearsing C2", completed: 0, total: 1, checkId: "C2" }
    store.activity(first.id, activity)
    const recovered = new LaunchStore(store.file).get(first.id)!
    expect(launchView(recovered)).toMatchObject({ decisionId: first.id, status: "executing", activity })
    expect(launchView(recovered)).not.toHaveProperty("runId")
    store.update(first.id, { status: "failed", result: "unrunnable" })
    expect(store.activity(first.id).activity).toBeUndefined()
    expect(() => store.activity(first.id, activity)).toThrow("not executing")
    expect(store.reserve(first.id)).toBeUndefined()
  } finally { rmSync(root, { recursive: true, force: true }) }
})
