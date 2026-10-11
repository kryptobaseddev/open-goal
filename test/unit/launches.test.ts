import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LaunchStore, launchChoices } from "../../src/engine/launches"
import { selectedReviewChoice } from "../../src/engine/owner-reviews"

test("launch target/hash/mode and exact form binding survive reload; reservation is one-use", () => {
  const root = mkdtempSync(join(tmpdir(), "ocgoal-launch-store-"))
  try {
    const file = join(root, "requests.json")
    const store = new LaunchStore(file)
    const now = Date.now()
    const p = store.create({ sessionID: "ses_owner", slug: "demo", lock: "immutable-lock", fresh: true, title: "Demo", question: "Review demo", createdAt: now, expiresAt: now + 60000, issuerPID: process.pid })
    const options = launchChoices.map((c) => ({ value: c.value, label: c.label }))
    expect(store.bind({ id: "unrelated", sessionID: p.sessionID, fields: [{ key: "q0", title: "Which words do you prefer?", options }] })).toBeUndefined()
    expect(store.bind({ id: "wrong-session", sessionID: "ses_other", fields: [{ key: "action", title: p.question, options }] })).toBeUndefined()
    expect(store.bind({ id: "matching", sessionID: p.sessionID, fields: [{ key: "action", title: p.question, options }] })?.fieldKey).toBe("action")
    const recovered = new LaunchStore(file)
    expect(recovered.byForm(p.sessionID, "matching")).toMatchObject({ slug: "demo", lock: "immutable-lock", fresh: true, status: "pending" })
    expect(recovered.reserve(p.id)?.status).toBe("executing")
    expect(store.reserve(p.id)).toBeUndefined()
    recovered.update(p.id, { status: "succeeded", result: "started" })
    expect(store.reserve(p.id)).toBeUndefined()
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test("expired and replaced decisions cannot execute, and fallback question descriptions correlate exactly", () => {
  const root = mkdtempSync(join(tmpdir(), "ocgoal-launch-expiry-"))
  try {
    const store = new LaunchStore(join(root, "requests.json"))
    const base = { sessionID: "ses_owner", slug: "demo", lock: "lock", fresh: false, title: "Demo", question: "Review", createdAt: Date.now(), issuerPID: process.pid }
    const expired = store.create({ ...base, expiresAt: Date.now() - 1 })
    expect(store.reserve(expired.id)).toBeUndefined()
    expect(store.get(expired.id)?.status).toBe("expired")
    const old = store.create({ ...base, expiresAt: Date.now() + 60000 })
    const next = store.create({ ...base, fresh: true, expiresAt: Date.now() + 60000 })
    expect(store.get(old.id)?.status).toBe("cancelled")
    expect(store.reserve(old.id)).toBeUndefined()
    const form = { id: "question-fallback", sessionID: base.sessionID, fields: [{ key: "q0", title: "Goal", description: next.question, options: launchChoices.map((c) => ({ value: c.label, label: c.label })) }] }
    expect(store.bind(form)?.id).toBe(next.id)
    expect(store.byForm(base.sessionID, form.id)?.fieldKey).toBe("q0")
    const bound = store.byForm(base.sessionID, form.id)!
    expect(selectedReviewChoice(bound, launchChoices, { q0: "launch" })).toBeUndefined()
    expect(selectedReviewChoice(bound, launchChoices, { q0: "Start goal now (Recommended)" })?.value).toBe("launch")
    expect(selectedReviewChoice(bound, launchChoices, { unrelated: "Start goal now (Recommended)" })).toBeUndefined()
    expect(selectedReviewChoice(bound, launchChoices, { q0: ["Start goal now (Recommended)"] })).toBeUndefined()
  } finally { rmSync(root, { recursive: true, force: true }) }
})
