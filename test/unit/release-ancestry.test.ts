import { describe, expect, test } from "bun:test"
import { ancestryError, checkAncestry } from "../../scripts/check-release-ancestry"

// v0.12.0 was tagged and published from a branch commit while main still
// carried 0.11.0, and every goal check passed — the goal engine cannot see the
// release pipeline. This guard refuses a tag that is not on main.

const sha = (c: string) => c.repeat(40)

describe("release ancestry guard", () => {
  test("a tag that reaches main is accepted", () => {
    expect(ancestryError({ tag: "v0.12.2", mainRef: "origin/main", tagCommit: sha("a"), mainCommit: sha("b"), ancestor: true })).toBeUndefined()
  })

  test("a branch tag is refused and names both commits", () => {
    const why = ancestryError({ tag: "v0.12.0", mainRef: "origin/main", tagCommit: sha("a"), mainCommit: sha("b"), ancestor: false })!
    expect(why).toContain("v0.12.0 (aaaaaaa) is not an ancestor of origin/main (bbbbbbb)")
    expect(why).toContain("merge the branch first")
  })

  test("an unresolvable tag or ref is refused before ancestry is trusted", () => {
    expect(ancestryError({ tag: "v0", mainRef: "origin/main", tagCommit: "", mainCommit: sha("b"), ancestor: true })).toContain("does not resolve to a commit")
    expect(ancestryError({ tag: "v0", mainRef: "origin/main", tagCommit: sha("a"), mainCommit: "", ancestor: true })).toContain("does not resolve to a commit")
  })
})

describe("checkAncestry", () => {
  test("asks git for the tag, main and the ancestry question", () => {
    const asked: string[] = []
    const ran = checkAncestry("v1.0.0", "origin/main", (args) => {
      asked.push(args.join(" "))
      if (args[0] === "rev-parse" && args[2] === "v1.0.0^{commit}") return { status: 0, stdout: sha("a"), stderr: "" }
      if (args[0] === "rev-parse" && args[2] === "origin/main^{commit}") return { status: 0, stdout: sha("b"), stderr: "" }
      if (args[0] === "merge-base") return { status: 0, stdout: "", stderr: "" }
      return { status: 1, stdout: "", stderr: "" }
    })
    expect(ran).toMatchObject({ tag: "v1.0.0", mainRef: "origin/main", tagCommit: sha("a"), mainCommit: sha("b"), ancestor: true })
    expect(asked).toContain("merge-base --is-ancestor " + sha("a") + " " + sha("b"))
  })

  test("a missing main ref refuses", () => {
    const ran = checkAncestry("v1.0.0", "origin/main", (args) =>
      args[2] === "v1.0.0^{commit}" ? { status: 0, stdout: sha("a"), stderr: "" } : { status: 1, stdout: "", stderr: "" },
    )
    expect(ancestryError(ran)).toContain("origin/main does not resolve")
  })
})
