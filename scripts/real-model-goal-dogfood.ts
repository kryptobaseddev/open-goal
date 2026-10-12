// Explicitly automated QA owner, real model, installed immutable plugin.
// No credentials are written to artifacts; no production project is mutated.
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises"
import { realpathSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { GoalRpc } from "../src/rpc"
import { parseContract } from "../src/contract/parse"
import { artifactDiscrepancies, hashArtifact, isArtifactPath } from "../src/verify/artifact"
import { launchChoices } from "../src/engine/launches"

if (!process.argv.includes("--assert")) throw Error("Use --assert")
const endpoint = await Service.discover()
if (!endpoint) throw Error("No configured shared test host; refusing to start or change services")
const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
const info: any = await client.server.info()
const original: any = await client.session.get({ sessionID: process.env.OPENCODE_SESSION_ID! } as any)
if (!original.model || !original.agent) throw Error("Source model/agent unavailable; no silent provider fallback")
const resumeRoot = process.env.QA_RESUME_ROOT
const root = realpathSync(resumeRoot ?? await mkdtemp(join(tmpdir(), "opencode", "real-model-goal-")))
const evidence = join(root, "qa-evidence")
await mkdir(evidence, { recursive: true })
await mkdir(join(root, ".opencode"), { recursive: true })
if (!resumeRoot) {
await writeFile(join(root, "README.md"), "# Isolated real-model goal QA\nOnly QA marker files and goal artifacts belong here.\n")
await writeFile(join(root, ".gitignore"), ".opencode/goals/*/run.json\n.opencode/goals/*/ledger.jsonl\n.opencode/goals/*/evidence/\n.opencode/goals/.owner-*.json*\nqa-evidence/\n")
// Test a newly published immutable patch before changing the original
// goal's serving engine. This overrides only the isolated QA location.
if (process.env.OCGOAL_GIT_SPEC) await writeFile(join(root, ".opencode/opencode.json"), JSON.stringify({ plugins: ["-opencode-goal", process.env.OCGOAL_GIT_SPEC] }, null, 2))
}
function git(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "Goal QA", GIT_AUTHOR_EMAIL: "goal-qa@test.invalid", GIT_COMMITTER_NAME: "Goal QA", GIT_COMMITTER_EMAIL: "goal-qa@test.invalid" } })
  if (r.exitCode) throw Error(`git ${args[0]} failed`)
  return r.stdout.toString().trim()
}
if (!resumeRoot) {
  git(root, "init", "-q", "-b", "main")
  git(root, "add", "README.md", ".gitignore")
  git(root, "commit", "-q", "-m", "chore: seed isolated real-model QA")
}
const location = { directory: root }
const rpc: any = (client as any).rpc(GoalRpc)
const ref = `v${JSON.parse(await readFile(join(import.meta.dir, "../package.json"), "utf8")).version}`
const revision = git(join(import.meta.dir, ".."), "rev-parse", `${ref}^{commit}`)
const files = git(join(import.meta.dir, ".."), "ls-tree", "-r", "--name-only", revision).split("\n").filter(isArtifactPath)
const artifacts = Object.fromEntries(files.map((f) => [f, hashArtifact(Bun.spawnSync(["git", "show", `${revision}:${f}`], { cwd: join(import.meta.dir, ".."), stdout: "pipe" }).stdout)]))
const prior = resumeRoot ? JSON.parse(await readFile(join(evidence, "context.json"), "utf8")) : undefined
if (prior && (prior.serverPID !== info.pid || prior.location.directory !== root || prior.revision !== revision)) throw Error("Retry cannot bind a different host/location/release")
const author: any = prior ? await client.session.get({ sessionID: prior.authorID } as any)
  : await client.session.create({ location, title: "Real model goal interview QA", agent: original.agent, model: original.model } as any)
const authorID = author.id
const provenance = await rpc.provenance({ sessionID: authorID }, { location })
const errors = artifactDiscrepancies(provenance, { revision, artifacts, serverPID: info.pid, location: root, minVersion: "0.3.3" })
if (errors.length) throw Error(errors.join("\n"))
await writeFile(join(evidence, "provenance.json"), JSON.stringify(provenance, null, 2))
await writeFile(join(evidence, "context.json"), JSON.stringify({ automatedQATestOwner: true, providerIsFixture: false, endpoint: endpoint.url, serverPID: info.pid, location, authorID, originalModel: original.model, originalAgent: original.agent, revision, ref }, null, 2))
const seed = "Create a goal for this isolated QA project: use slug qa-interview. Write proof.txt with exactly status: ok on one line. This is a bounded QA test, not a request to edit production. Interview me with one native question before drafting; the test owner answers are: direct host file/contains checks, no human sign-off or verifier criterion, no budget, no other source files, fresh root launch preserving this model/agent. When the goal starts, write the marker and then call goal_wait for 300 seconds so the manager can inspect it; do not claim until the test owner resumes it. Do not create CLEO/MBX identities or change global settings/providers. The parent task is already tracked. Validate and use goal_prepare_launch({slug:qa-interview,fresh:true}) for the exact native launch review."
const previousFailure = prior ? JSON.parse(await readFile(join(evidence, "failure.json"), "utf8")) : undefined
if (prior) {
  await writeFile(join(evidence, "failure-before-retry.json"), JSON.stringify(previousFailure, null, 2))
  await writeFile(join(evidence, "author-transcript-before-retry.json"), await readFile(join(evidence, "author-transcript.json")))
  await client.session.prompt({ sessionID: authorID, text: "The fixed QA choices already match the validated draft. Request only its exact fresh-root launch review with goal_prepare_launch({slug:'qa-interview',fresh:true}); the automated QA owner will select the offered launch option after checking the draft. Do not infer launch consent from this request or redo the interview." } as any)
} else await client.session.command({ sessionID: authorID, name: "goal", text: seed } as any)
const answers: any[] = previousFailure?.answers ?? []
const answered = new Set<string>(answers.map((a) => a.formID))
const launchLabel = launchChoices.find((c) => c.value === "launch")!.label
let launched: any
try {
  const deadline = Date.now() + 300000
  while (Date.now() < deadline) {
    const forms: any[] = await (client.session.form as any).list({ sessionID: authorID })
    for (const form of forms) {
      if (answered.has(form.id)) continue
      const answer: Record<string, string> = {}
      const launch = form.fields.some((f: any) => f.options?.some((o: any) => o.label === launchLabel))
      if (launch) {
        const yaml = await readFile(join(root, ".opencode/goals/qa-interview/goal.yaml"), "utf8")
        const parsed = parseContract(yaml, { slug: "qa-interview" })
        if (!parsed.contract || parsed.contract.criteria.some((c) => !["file", "contains"].includes(c.check.kind) || (c.check as any).path !== "proof.txt") || parsed.contract.budget.turns || parsed.contract.budget.wallMs || parsed.contract.budget.tokens || parsed.contract.budget.cost_usd)
          throw Error("The real-model draft exceeded the fixed QA owner's proof/budget choices")
        if (!/new root session/i.test(JSON.stringify(form))) throw Error("Launch did not review the fixed fresh-root mode")
        if (!JSON.stringify(parsed.contract.criteria).includes("proof.txt")) throw Error("Draft omitted the fixed marker oracle")
        await writeFile(join(evidence, "reviewed-contract.yaml"), yaml)
      }
      for (const field of form.fields) {
        const options: any[] = field.options ?? []
        const choice = launch ? options.find((o) => o.label === launchLabel)
          : options.find((o) => /^Use stated scope(?: \(Recommended\))?$/.test(o.label))
            ?? options.find((o) => /fresh/i.test(o.label)) ?? options.find((o) => /host.only|direct.host|no.budget/i.test(o.label))
        if (choice) answer[field.key] = choice.value
        else if (field.custom) answer[field.key] = "Use the fixed QA choices: proof.txt = status: ok; direct host checks only, no verifier/human criterion, no budget, fresh root launch with the original model/agent."
        else throw Error("Unknown real-model question cannot be silently approved")
      }
      await writeFile(join(evidence, `form-${form.id}.json`), JSON.stringify({ form, answer, automatedQATestOwner: true }, null, 2))
      answered.add(form.id); answers.push({ formID: form.id, launch, answer })
      await (client.session.form as any).reply({ sessionID: authorID, formID: form.id, answer })
    }
    try { launched = JSON.parse(await readFile(join(root, ".opencode/goals/qa-interview/run.json"), "utf8")) } catch {}
    if (launched?.handoff?.fromSessionID === authorID && launched.status === "waiting") break
    await Bun.sleep(250)
  }
  if (!launched?.handoff || launched.sessionID === authorID || launched.status !== "waiting") throw Error("Real-model interview/approved fresh launch did not produce a held fresh root")
  const fresh: any = await client.session.get({ sessionID: launched.sessionID } as any)
  if (fresh.parentID || fresh.agent !== original.agent || JSON.stringify(fresh.model) !== JSON.stringify(original.model)) throw Error("Fresh root did not preserve source selections")
  if (!answers.some((a) => !a.launch) || !answers.some((a) => a.launch)) throw Error("No genuine native interview and launch forms were exercised")
  if ((await readFile(join(root, "proof.txt"), "utf8")).trim() !== "status: ok") throw Error("Real worker did not write its actual marker")
  await writeFile(join(evidence, "author-transcript.json"), JSON.stringify(await client.session.context({ sessionID: authorID } as any), null, 2))
  await writeFile(join(evidence, "fresh-transcript.json"), JSON.stringify(await client.session.context({ sessionID: launched.sessionID } as any), null, 2))
  await writeFile(join(evidence, "run.json"), JSON.stringify(launched, null, 2))
  await writeFile(join(evidence, "answers.json"), JSON.stringify(answers, null, 2))
  console.log(JSON.stringify({ pass: true, root, evidence, authorID, freshID: launched.sessionID, serverPID: info.pid, revision, automatedQATestOwner: true, providerIsFixture: false }))
} catch (error) {
  await writeFile(join(evidence, "failure.json"), JSON.stringify({ pass: false, error: String(error), launched, answers }, null, 2))
  await writeFile(join(evidence, "author-transcript.json"), JSON.stringify(await client.session.context({ sessionID: authorID } as any), null, 2))
  console.error(`REAL-MODEL-GOAL FAIL evidence=${evidence}: ${String(error)}`)
  process.exitCode = 1
}
