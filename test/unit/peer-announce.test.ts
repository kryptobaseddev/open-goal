import { expect, test } from "bun:test"
import { announceDue, announcementText, candidateFromReply } from "../../src/engine/peer-announce"

// v0.8.0 C5 (pure half) — one outstanding announcement at a time, a cooldown
// floor, and replies become candidates rather than instructions.

test("an idle loop with no history announces", () => {
  expect(announceDue({}, 10_000, 60_000)).toEqual({ due: true })
})

test("an unanswered announcement blocks a second one no matter how much time passes", () => {
  expect(announceDue({ outstanding: { id: "m1", at: 0 } }, 10_000_000, 60_000)).toEqual({ due: false, reason: "outstanding" })
})

test("the cooldown floor prevents an announce storm across rapid idle transitions", () => {
  expect(announceDue({ lastAt: 10_000 }, 40_000, 60_000)).toEqual({ due: false, reason: "cooldown" })
  expect(announceDue({ lastAt: 10_000 }, 70_001, 60_000)).toEqual({ due: true })
})

test("once the outstanding announcement is answered, a later idle transition may announce again", () => {
  expect(announceDue({ lastAt: 10_000 }, 10_000 + 60_000, 60_000)).toEqual({ due: true })
})

test("the announcement names the project and the last goal, and labels replies as candidates", () => {
  const text = announcementText({ project: "/p/x", slug: "demo", taskId: "T123" })
  expect(text).toContain("/p/x")
  expect(text).toContain("demo")
  expect(text).toContain("T123")
  expect(text).toContain("candidate")
  expect(text).not.toContain("already said yes")
})

test("a peer reply with a task id becomes a CLEO-shaped candidate, verbatim and labelled peer", () => {
  const c = candidateFromReply({ id: "m9", from: "peer@host", text: "Could you take T456? It is small.\nDetails below.", at: 5 }, "/p/x")
  expect(c.source).toBe("peer")
  expect(c.taskId).toBe("T456")
  expect(c.project).toBe("/p/x")
  expect(c.title).toBe("Could you take T456? It is small.")
  expect(c.from).toBe("peer@host")
  expect(c.messageId).toBe("m9")
})

test("a reply without a task id is still a candidate, with the first non-empty line as its title", () => {
  const c = candidateFromReply({ id: "m10", from: "p", text: "\n\nfix the release notes please", at: 6, project: "/p/y" }, "/p/x")
  expect(c.taskId).toBeUndefined()
  expect(c.project).toBe("/p/y")
  expect(c.title).toBe("fix the release notes please")
})
