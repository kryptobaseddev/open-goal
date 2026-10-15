import { expect, test } from "bun:test"
import { verifierCause, verdictsFromTranscript } from "../../src/server/app"

// T108: the goal engine's own verdict on this work exposed two bugs in the
// verifier diagnostics shipped earlier.
//  1. verifierCause scanned the whole transcript for "external_directory",
//     which matches the CONTENT of files the verifier read (the protected
//     test/host/verifier-diagnostics.test.ts literally contains that string),
//     so a round that was merely slow was reported as "denied
//     external_directory access". The real cause was the verifier burning its
//     budget trying to inspect git history it has no tool for.
//  2. A verifier that DOES call goal_verdict but lands just after the round
//     budget was recorded as "did not call goal_verdict". The call is in the
//     captured transcript, so it can still be used.

const part = (input: unknown, output: string) => ({ type: "assistant", parts: [{ type: "tool", tool: "read", state: { status: "completed", input, output } }] })
const call = (args: unknown) => ({ type: "assistant", parts: [{ type: "tool", tool: "goal_verdict", state: { status: "completed", input: typeof args === "string" ? args : JSON.stringify(args), output: "recorded" } }] })

test("reading a file that mentions external_directory is not a denial", () => {
  // The protected diagnostics test contains the phrase; reading it denies nothing.
  const quoted = part({ path: "test/host/verifier-diagnostics.test.ts" }, "denied external_directory access; add the folder to verification.read in the contract")
  expect(verifierCause([quoted], ["/repo"])).toBeUndefined()

  // A real denial result outside the project is still reported with its path.
  const denied = part({ path: "/elsewhere/other/notes.md" }, '{"error":{"type":"permission.rejected","message":"Permission denied: external_directory"}}')
  const cause = verifierCause([denied], ["/repo"])
  expect(cause).toContain("external_directory")
  expect(cause).toContain("/elsewhere/other/notes.md")

  // A denial inside a granted read root is not a denial either.
  expect(verifierCause([part({ path: "/repo/sibling/notes.md" }, "Permission denied: external_directory")], ["/repo/sibling"])).toBeUndefined()
})

test("a goal_verdict call captured in the transcript is usable when the inbox missed it", () => {
  const ids = new Set(["C1", "C2", "C3"])
  const verdict = { verdicts: [
    { id: "C1", verdict: "proven", reason: "file exists", evidence: [{ path: "done.txt", quote: "status: ok" }] },
    { id: "C3", verdict: "not_proven", reason: "not shown" },
  ] }
  expect(verdictsFromTranscript([call(verdict)], ids)).toHaveLength(2)
  expect(verdictsFromTranscript([call(verdict)], ids)[0]).toMatchObject({ id: "C1", verdict: "proven" })

  // Unknown criteria, impossible verdicts and unparseable calls are not answers.
  expect(verdictsFromTranscript([call({ verdicts: [{ id: "C9", verdict: "proven" }] })], ids)).toHaveLength(0)
  expect(verdictsFromTranscript([call({ verdicts: [{ id: "C1", verdict: "maybe" }] })], ids)).toHaveLength(0)
  expect(verdictsFromTranscript([call("{ not json")], ids)).toHaveLength(0)
  // A plain read is never mistaken for a verdict.
  expect(verdictsFromTranscript([part({ path: "goal_verdict" }, "goal_verdict")], ids)).toHaveLength(0)
})
