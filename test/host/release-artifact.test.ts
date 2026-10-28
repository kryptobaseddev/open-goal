import { expect, test } from "bun:test"
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GoalRpc } from "../../src/rpc"
import { artifactDiscrepancies, captureArtifactHashes, hashArtifact, isArtifactPath, type ArtifactHashes, type RuntimeProvenance } from "../../src/verify/artifact"
import { startHost, until } from "./harness"

const project = join(import.meta.dir, "../..")
function git(root: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], {
    cwd: root, stdout: "pipe", stderr: "pipe",
    env: { ...process.env, GIT_AUTHOR_NAME: "artifact-test", GIT_AUTHOR_EMAIL: "artifact@test.invalid", GIT_COMMITTER_NAME: "artifact-test", GIT_COMMITTER_EMAIL: "artifact@test.invalid" },
  })
  if (r.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.toString()}`)
  return r.stdout.toString().trim()
}
function hashesAtCommit(root: string, revision: string): ArtifactHashes {
  const names = git(root, "ls-tree", "-r", "--name-only", revision).split("\n").filter(isArtifactPath)
  return Object.fromEntries(names.map((name) => {
    const r = Bun.spawnSync(["git", "show", `${revision}:${name}`], { cwd: root, stdout: "pipe", stderr: "pipe" })
    if (r.exitCode) throw new Error(`Cannot read release artifact ${name}`)
    return [name, hashArtifact(r.stdout)]
  }))
}

async function inspectInstalled(spec: string) {
  // Same isolation as goal.helpers; never load a generated CLEO hook into
  // the fixture host or let its cache writes target the owner's HOME.
  delete process.env.CLEO_SESSION_ID
  delete process.env.CLEO_AGENT_ID
  process.env.CLEO_HEAVY_COMMAND_HOOK = "off"
  const host = await startHost({ plugins: [spec], git: true, script: () => ({ text: "ok" }) })
  try {
    const entry: any = await until(async () => {
      const listed: any = await host.client.plugin.list({ location: host.location } as any)
      return (listed?.data ?? listed).find((p: any) => ["open-goal", "opencode-goal"].includes(p.id) && p.state?.status === "active")
    }, 120000)
    const info: any = await host.client.server.info()
    const rpc: any = (host.client as any).rpc(GoalRpc)
    const observed: RuntimeProvenance = await rpc.provenance({}, { location: host.location })
    expect(observed.serverPID).toBe(info.pid)
    expect(observed.location).toBe(host.project)
    expect(observed.source.version).toBe(entry.source.version)
    expect(entry.features).toMatchObject({ server: true, tui: true, rpc: true })
    // Verify the exact package path the running instance reported, never
    // the newest cache directory (which may be another install entirely).
    expect(captureArtifactHashes(observed.packageRoot)).toEqual(observed.artifacts)
    return observed
  } finally { await host.stop() }
}

test("immutable Git installs prove revision AND bytes; the old cache fails even with the same version label", async () => {
  const root = mkdtempSync(join(tmpdir(), "ocgoal-artifact-repo-"))
  const repo = join(root, "package")
  mkdirSync(repo)
  try {
    for (const name of ["package.json", "server.ts", "tui.tsx", "rpc.ts", "dist", "src", "skills", "README.md", "LICENSE", "CHANGELOG.md"])
      cpSync(join(project, name), join(repo, name), { recursive: true })
    const freshUI = readFileSync(join(repo, "dist/tui.js"), "utf8")
    // Deliberately different immutable revisions, but IDENTICAL semantic
    // version labels. No tag moves and no editing the installed cache.
    writeFileSync(join(repo, "dist/tui.js"), `${freshUI}\n// older immutable compiled UI artifact\n`)
    git(repo, "init", "-q", "-b", "main")
    git(repo, "add", ".")
    git(repo, "commit", "-q", "-m", "old artifact")
    const oldRevision = git(repo, "rev-parse", "HEAD")
    git(repo, "tag", "artifact-old")
    writeFileSync(join(repo, "dist/tui.js"), freshUI)
    git(repo, "add", "dist/tui.js")
    git(repo, "commit", "-q", "-m", "new artifact")
    const revision = git(repo, "rev-parse", "HEAD")
    git(repo, "tag", "artifact-new")
    const expected = { revision, artifacts: hashesAtCommit(repo, revision) }
    const old = await inspectInstalled(`git+file://${repo}#artifact-old`)
    const fresh = await inspectInstalled(`git+file://${repo}#artifact-new`)
    expect(old.source.version).toBe(oldRevision)
    expect(old.packageVersion).toBe(fresh.packageVersion)
    const errors = artifactDiscrepancies(old, expected)
    expect(errors).toContain(`running revision ${oldRevision} differs from ${revision}`)
    expect(errors).toContain("artifact mismatch: dist/tui.js")
    expect(artifactDiscrepancies(fresh, expected)).toEqual([])
    // Correct registry SHA but wrong UI bytes also fails independently.
    expect(artifactDiscrepancies({ ...old, source: fresh.source }, expected)).toContain("artifact mismatch: dist/tui.js")
  } finally { rmSync(root, { recursive: true, force: true }) }
}, 240000)

test("the published release installs at its exact tag commit and all production artifact hashes", async () => {
  const version = JSON.parse(readFileSync(join(project, "package.json"), "utf8")).version
  const ref = process.env.OCGOAL_RELEASE_REF ?? `v${version}`
  const revision = git(project, "rev-parse", "--verify", `${ref}^{commit}`)
  const spec = process.env.OCGOAL_GIT_SPEC ?? `github:kryptobaseddev/open-goal#${ref}`
  const observed = await inspectInstalled(spec)
  expect(artifactDiscrepancies(observed, { revision, artifacts: hashesAtCommit(project, revision) })).toEqual([])
}, 180000)
