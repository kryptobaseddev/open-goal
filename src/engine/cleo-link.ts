// T027 — optional first-class CLEO linkage. When the project carries a CLEO
// workspace, the goal records the linkage THROUGH THE CLI ONLY (never by
// reading .cleo/*.db); the project-context.json config file may be read as a
// presence signal and fallback. No CLEO → the goal system behaves identically;
// there is no hard dependency either way.
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

export type CleoFacts = { source: "cli" | "config"; projectId?: string; projectTypes: string[]; detectedAt?: string }

export type Runner = (command: string, args: string[], timeoutMs?: number) => Promise<{ stdout: string; exit: number }>

/**
 * Detect CLEO linkage for a project root. Order: the `cleo` CLI (authoritative,
 * spawn with a hard timeout), then .cleo/project-context.json (presence +
 * config facts), then none. All failures degrade to undefined — never throw.
 */
export async function cleoFacts(projectRoot: string, run: Runner, timeoutMs = 2500): Promise<CleoFacts | undefined> {
  const config = join(projectRoot, ".cleo", "project-context.json")
  const hasConfig = existsSync(config)
  if (!hasConfig && !existsSync(join(projectRoot, ".cleo"))) return undefined
  try {
    const { stdout, exit } = await run("cleo", ["doctor", "project-identity"], timeoutMs)
    if (exit === 0 && stdout.trim()) {
      const parsed = JSON.parse(stdout)
      const data = parsed?.data ?? parsed
      const projectId = typeof data?.projectId === "string" ? data.projectId : typeof parsed?.projectId === "string" ? parsed.projectId : undefined
      return { source: "cli", projectId, projectTypes: [] }
    }
  } catch {
    // CLI missing, too slow, or errored — degrade to the config signal
  }
  if (!hasConfig) return undefined
  try {
    const parsed = JSON.parse(readFileSync(config, "utf8"))
    return { source: "config", projectTypes: Array.isArray(parsed?.projectTypes) ? parsed.projectTypes.map(String) : [], ...(parsed?.detectedAt ? { detectedAt: String(parsed.detectedAt) } : {}) }
  } catch {
    return { source: "config", projectTypes: [] }
  }
}

/** The ledger payload recorded when a goal starts in a CLEO-linked project. */
export function cleoLinkEvent(facts: CleoFacts | undefined) {
  return facts ? { type: "cleo-linked" as const, via: facts.source, ...(facts.projectId ? { projectId: facts.projectId } : {}), ...(facts.projectTypes.length ? { projectTypes: facts.projectTypes } : {}) } : undefined
}

// v0.5.0 — the CLEO health surface. Three states, no more: the CLI is absent,
// the CLI is present but this project is not initialized, or both are present.
// OCG never installs or initializes anything by itself: it reports the state and
// the EXACT command, and runs that command only when the owner asks for it.

export type CleoHealthState = "cli-absent" | "uninitialized" | "initialized"

/** Local string coercion (cleo-link.ts has no parser helpers). */
const asText = (v: unknown): string => (typeof v === "string" ? v.trim() : "")

export type CleoOffer = {
  kind: "install" | "init"
  /** The exact command OCG would run — only on an explicit owner choice. */
  command: string
  why: string
}

export type CleoHealth = {
  state: CleoHealthState
  cli: { present: boolean; version?: string }
  workspace: { present: boolean; path: string }
  projectId?: string
  offer?: CleoOffer
  /** One-line, state-accurate summary (never a claim that CLEO is usable). */
  detail: string
}

/** The documented global install for the CLEO CLI (verified against @cleocode/cleo). */
export const CLEO_INSTALL_COMMAND = "npm i -g @cleocode/cleo"
/** The documented in-project initializer (verified: `cleo init --help`). */
export const CLEO_INIT_COMMAND = "cleo init"

/**
 * Probe CLEO for a project root. `run` is invoked with `cleo --version` first to
 * decide whether the CLI exists at all (a spawn rejection means absent), then with
 * `cleo doctor project-identity` only when the workspace exists. Nothing here
 * mutates the machine, and no failure throws.
 */
export async function cleoHealth(projectRoot: string, run: Runner, timeoutMs = 2500): Promise<CleoHealth> {
  const cleoDir = join(projectRoot, ".cleo")
  const workspace = { present: existsSync(cleoDir), path: cleoDir }
  let present = false
  let version: string | undefined
  try {
    const { stdout, exit } = await run("cleo", ["--version"], timeoutMs)
    if (exit === 0) {
      present = true
      try {
        const parsed = JSON.parse(stdout)
        version = asText(parsed?.data?.version ?? parsed?.version) || undefined
      } catch {
        version = stdout.trim().split(/\s+/)[0] || undefined
      }
    }
  } catch {
    present = false // the spawn itself failed — no CLI on PATH
  }

  if (!present)
    return {
      state: "cli-absent",
      cli: { present: false },
      workspace,
      offer: { kind: "install", command: CLEO_INSTALL_COMMAND, why: "the cleo CLI is not on PATH, so no task board is reachable from this project" },
      detail: "CLEO CLI not found on PATH — goal tracking works exactly as before, with no CLEO integration",
    }

  if (!workspace.present)
    return {
      state: "uninitialized",
      cli: { present: true, ...(version ? { version } : {}) },
      workspace,
      offer: { kind: "init", command: CLEO_INIT_COMMAND, why: "this project has no .cleo workspace, so a goal's work has no durable task board yet" },
      detail: "CLEO CLI present, but this project has no .cleo workspace — a goal runs normally and records no task linkage",
    }

  let projectId: string | undefined
  try {
    const { stdout, exit } = await run("cleo", ["doctor", "project-identity"], timeoutMs)
    if (exit === 0 && stdout.trim()) {
      const parsed = JSON.parse(stdout)
      const data = parsed?.data ?? parsed
      projectId = asText(data?.trackedId ?? data?.projectId ?? parsed?.projectId) || undefined
    }
  } catch {
    // CLI answered --version but not this probe: still initialized (the
    // workspace exists); the id is simply unknown.
  }
  return {
    state: "initialized",
    cli: { present: true, ...(version ? { version } : {}) },
    workspace,
    ...(projectId ? { projectId } : {}),
    detail: `CLEO CLI present and this project is initialized${projectId ? ` (project ${projectId})` : ""} — goals can name and complete CLEO tasks`,
  }
}

/** Render a health probe as the owner/agent sees it. Pure; safe to unit-test. */
export function cleoHealthReport(health: CleoHealth): string {
  const version = health.cli.version ? ` (cleo ${health.cli.version})` : ""
  const head = `◎ CLEO — ${health.detail}`
  if (!health.offer) return [head, `Nothing to do: ${health.state === "initialized" ? "goals can link and complete CLEO tasks." : "no CLEO action is offered."}`].join("\n")
  return [head, `On your explicit choice only (OCG never runs this silently): ${health.offer.command}`, `Why: ${health.offer.why}. Run /goal cleo ${health.offer.kind} to do it, or /goal cleo to re-check.`].join("\n")
}
