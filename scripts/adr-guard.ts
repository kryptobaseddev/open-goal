#!/usr/bin/env bun
// T180 — compile the ADR projection the contract validator reads.
//
// Accepted ADRs live in CLEO, but the plugin must stay CLEO-optional: the parser
// may not read `.cleo/cleo.db` or run the `cleo` CLI, and a non-CLEO owner must
// still be able to keep an owner-approved decision on disk. So the projection is
// a plain file, `docs/adr/decisions.json`, and this script compiles it from
// checked-in markdown sources:
//
//   docs/adr/<slug>.md        the readable source (frontmatter + prose)
//   docs/adr/decisions.json   the projection the validator reads
//
//   bun scripts/adr-guard.ts generate            # write the projection
//   bun scripts/adr-guard.ts generate --check    # fail when it is stale
//   bun scripts/adr-guard.ts check <goal.yaml>   # print the warnings for one goal
//
// No network, no CLEO CLI, no database. Format: docs/research/adr-guard.md.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { parse as parseYaml } from "yaml"
import { ADR_DECISIONS_PATH, type AdrDecision, type AdrForbidden, parseAdrDecisions } from "../src/contract/adr-guard"
import { formatIssues, parseContract } from "../src/contract/parse"

/** Where the readable ADR sources live, project-relative. */
export const ADR_SOURCE_DIR = "docs/adr"
/** Bumped only if the projection shape changes incompatibly. */
export const PROJECTION_VERSION = 1

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "")
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

/** The `---` frontmatter block of a markdown file, as raw YAML text. */
export function frontmatter(text: string): string | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
  return match?.[1]
}

/**
 * One source file → one decision. Malformed frontmatter is an ERROR here (this
 * is a build step, so a typo must not silently drop an accepted decision), while
 * the runtime loader stays silent about a broken projection.
 */
export function decisionFromSource(file: string, text: string): { decision?: AdrDecision; error?: string } {
  const yaml = frontmatter(text)
  if (!yaml) return { error: `${file}: no --- frontmatter block` }
  let raw: unknown
  try {
    raw = parseYaml(yaml)
  } catch (error) {
    return { error: `${file}: frontmatter is not valid YAML (${error instanceof Error ? error.message : String(error)})` }
  }
  if (!isRecord(raw)) return { error: `${file}: frontmatter must be a mapping` }
  const slug = str(raw.adr)
  const subjects = (Array.isArray(raw.subject) ? raw.subject : [raw.subject]).map(str).filter(Boolean)
  const statement = str(raw.statement)
  if (!slug) return { error: `${file}: frontmatter needs \`adr: <slug>\`` }
  if (!subjects.length) return { error: `${file}: frontmatter needs \`subject: <the words naming the subject>\`` }
  if (!statement) return { error: `${file}: frontmatter needs \`statement: <the accepted decision>\`` }
  const status = str(raw.status) || "accepted"
  const forbidden: AdrForbidden[] = []
  for (const entry of Array.isArray(raw.forbidden) ? raw.forbidden : []) {
    if (typeof entry === "string" && entry.trim()) forbidden.push(entry.trim())
    else if (isRecord(entry) && str(entry.phrase)) forbidden.push({ phrase: str(entry.phrase) })
    else if (isRecord(entry) && str(entry.regex)) {
      try {
        new RegExp(str(entry.regex), "i")
        forbidden.push({ regex: str(entry.regex) })
      } catch {
        return { error: `${file}: \`regex\` is not a valid regular expression: ${str(entry.regex)}` }
      }
    } else if (isRecord(entry) && str(entry.note)) {
      // A prose-only entry is allowed in the source but projects to nothing:
      // the guard never infers a match from prose.
    } else return { error: `${file}: each \`forbidden\` entry must be a phrase, {phrase} or {regex}` }
  }
  return { decision: { slug, status, subject: subjects.length === 1 ? subjects[0]! : subjects, statement, forbidden } }
}

/** Compile source files deterministically: sorted by slug, fixed field order. */
export function compileSources(sources: readonly { file: string; text: string }[]): { decisions: AdrDecision[]; errors: string[] } {
  const errors: string[] = []
  const decisions: AdrDecision[] = []
  for (const source of sources) {
    const parsed = decisionFromSource(source.file, source.text)
    if (parsed.error) errors.push(parsed.error)
    else if (parsed.decision) decisions.push(parsed.decision)
  }
  const seen = new Set<string>()
  for (const d of decisions) {
    if (seen.has(d.slug)) errors.push(`${ADR_SOURCE_DIR}: duplicate ADR slug "${d.slug}"`)
    seen.add(d.slug)
  }
  decisions.sort((a, b) => a.slug.localeCompare(b.slug))
  return { decisions, errors }
}

/** The exact bytes of the projection. Deterministic so `--check` is meaningful. */
export function renderProjection(decisions: readonly AdrDecision[]): string {
  const projection = {
    version: PROJECTION_VERSION,
    decisions: decisions.map((d) => ({
      slug: d.slug,
      status: d.status ?? "accepted",
      subject: d.subject,
      statement: d.statement,
      forbidden: d.forbidden,
    })),
  }
  return `${JSON.stringify(projection, null, 2)}\n`
}

/** Read every `*.md` under the source directory (project-relative or absolute). */
export function readSources(dir: string): { sources: { file: string; text: string }[]; errors: string[] } {
  if (!existsSync(dir)) return { sources: [], errors: [`no ADR sources directory at ${dir} — nothing to compile (create docs/adr/<slug>.md first)`] }
  return {
    sources: readdirSync(dir)
      .filter((name) => name.endsWith(".md"))
      .sort()
      .map((name) => ({ file: join(dir, name), text: readFileSync(join(dir, name), "utf8") })),
    errors: [],
  }
}

/** The projection loader for the CLI path: `--decisions <file>`. */
export function loadProjectionFile(file: string): AdrDecision[] {
  return parseAdrDecisions(JSON.parse(readFileSync(file, "utf8")))
}

type Args = { command: string; positional: string[]; src?: string; out?: string; decisions?: string; check: boolean }

export function parseArgs(argv: readonly string[]): Args {
  const args: Args = { command: "", positional: [], check: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === "--src") args.src = argv[++i]
    else if (arg === "--out") args.out = argv[++i]
    else if (arg === "--decisions") args.decisions = argv[++i]
    else if (arg === "--check") args.check = true
    else if (arg.startsWith("-")) throw new Error(`unknown flag ${arg}`)
    else if (!args.command) args.command = arg
    else args.positional.push(arg)
  }
  return args
}

const USAGE = `usage:
  bun scripts/adr-guard.ts generate [--src ${ADR_SOURCE_DIR}] [--out ${ADR_DECISIONS_PATH}] [--check]
  bun scripts/adr-guard.ts check <goal.yaml> [--decisions <projection.json>]

generate  compile ${ADR_SOURCE_DIR}/*.md into the projection the validator reads
check     print the ADR warnings for one goal.yaml (same warnings validation reports)`

function main(argv: readonly string[]): number {
  let args: Args
  try {
    args = parseArgs(argv)
  } catch (error) {
    console.error(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`)
    return 2
  }
  const root = process.cwd()

  if (args.command === "generate") {
    const src = resolve(root, args.src ?? ADR_SOURCE_DIR)
    const out = resolve(root, args.out ?? ADR_DECISIONS_PATH)
    const read = readSources(src)
    const compiled = compileSources(read.sources)
    const errors = [...read.errors, ...compiled.errors]
    if (errors.length) {
      for (const error of errors) console.error(`✗ ${error}`)
      return 1
    }
    const rendered = renderProjection(compiled.decisions)
    if (args.check) {
      const current = existsSync(out) ? readFileSync(out, "utf8") : undefined
      if (current !== rendered) {
        console.error(`! ${out} is stale — run \`bun scripts/adr-guard.ts generate\``)
        return 1
      }
      console.log(`✓ ${out} matches ${compiled.decisions.length} ADR source(s)`)
      return 0
    }
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, rendered)
    console.log(`✓ wrote ${out} (${compiled.decisions.length} accepted decision(s))`)
    return 0
  }

  if (args.command === "check") {
    const goalFile = args.positional[0]
    if (!goalFile) {
      console.error(USAGE)
      return 2
    }
    const text = readFileSync(resolve(root, goalFile), "utf8")
    const slug = dirname(goalFile).split("/").pop()
    const decisions = args.decisions ? loadProjectionFile(resolve(root, args.decisions)) : undefined
    const parsed = parseContract(text, { ...(slug ? { slug } : {}), projectRoot: root, ...(decisions ? { decisions } : {}) })
    console.log(formatIssues(parsed.issues))
    return parsed.issues.some((issue) => issue.level === "error") ? 1 : 0
  }

  console.error(USAGE)
  return 2
}

if (import.meta.main) process.exit(main(process.argv.slice(2)))
