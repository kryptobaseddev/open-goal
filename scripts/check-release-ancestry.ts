// A release must come from main. The goal engine proves criteria against the
// bytes it can see, but it cannot see the release pipeline: v0.12.0 was tagged
// and published from a branch commit while main still carried 0.11.0, and every
// check passed. This is the one guard that would have refused it.
//
// Used by .github/workflows/release.yml before npm publish. The ancestry test is
// a pure function so it can be exercised without a repository.
import { spawnSync } from "node:child_process"

export type AncestryInput = { tag: string; mainRef: string; tagCommit: string; mainCommit: string; ancestor: boolean }

/** Why this tag may not be published, or undefined when it may. */
export function ancestryError(input: AncestryInput): string | undefined {
  if (!/^[a-f0-9]{40}$/.test(input.tagCommit)) return `the tag ${input.tag} does not resolve to a commit`
  if (!/^[a-f0-9]{40}$/.test(input.mainCommit)) return `${input.mainRef} does not resolve to a commit`
  if (!input.ancestor)
    return (
      `${input.tag} (${input.tagCommit.slice(0, 7)}) is not an ancestor of ${input.mainRef} (${input.mainCommit.slice(0, 7)}). ` +
      `A release must be built from a commit that is on ${input.mainRef}: merge the branch first, then tag the merge commit.`
    )
  return undefined
}

/** Run the guard against a real checkout. Exported for the workflow and tests. */
export function checkAncestry(
  tag: string,
  mainRef: string,
  run: (args: string[]) => { status: number | null; stdout: string; stderr: string } = (args) => {
    const r = spawnSync("git", args, { encoding: "utf8" })
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }
  },
): AncestryInput {
  const rev = (ref: string) => run(["rev-parse", "--verify", `${ref}^{commit}`]).stdout.trim()
  const tagCommit = rev(tag)
  const mainCommit = rev(mainRef)
  const ancestor = tagCommit && mainCommit ? run(["merge-base", "--is-ancestor", tagCommit, mainCommit]).status === 0 : false
  return { tag, mainRef, tagCommit, mainCommit, ancestor }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const option = (name: string, fallback?: string) => {
    const i = args.indexOf(name)
    return i >= 0 && args[i + 1] && !args[i + 1]!.startsWith("--") ? args[i + 1]! : fallback
  }
  const tag = option("--tag", process.env.GITHUB_REF_NAME)
  const mainRef = option("--main", "origin/main") ?? "origin/main"
  if (!tag) {
    console.error("INSTALL PROOF FAILED: no tag given (use --tag vX.Y.Z or GITHUB_REF_NAME)")
    process.exit(1)
  }
  let input: AncestryInput
  try {
    input = checkAncestry(tag, mainRef)
  } catch (error) {
    console.error(`INSTALL PROOF FAILED: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
  const why = ancestryError(input)
  if (why) {
    console.error(`RELEASE REFUSED: ${why}`)
    process.exit(1)
  }
  console.log(JSON.stringify({ ok: true, tag, tagCommit: input.tagCommit, mainRef, mainCommit: input.mainCommit }))
}
