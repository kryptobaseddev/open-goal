// T180 — owner-approved contract memory. A goal must not silently contradict a
// decision the owner already accepted, so contract validation compares its
// outcome and stop rules against a plain, text-readable projection of accepted
// ADRs. The projection is optional and advisory:
//
//   * absent  → validation behaves exactly as today (one stat, no read);
//   * present → a contradiction is a WARNING, never an error, so a contract that
//               parses today keeps parsing, and the contract is never rewritten.
//
// The plugin stays CLEO-optional: nothing here reads `.cleo/cleo.db` or runs the
// `cleo` CLI. The projection is `docs/adr/decisions.json` (format documented in
// `docs/research/adr-guard.md`) and `scripts/adr-guard.ts` compiles it from the
// ADR markdown sources.
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { Issue } from "./types"

/** Root-relative projection of accepted decisions. Absent ⇒ the guard is off. */
export const ADR_DECISIONS_PATH = "docs/adr/decisions.json"

/**
 * How one accepted ADR forbids something. A bare string is always a literal
 * phrase — never a regex — so a phrase is matched as written. An explicit
 * `{ regex }` is compiled case-insensitively; an invalid regex is ignored
 * (a malformed projection must never fail validation).
 */
export type AdrForbidden = string | { phrase: string } | { regex: string }

/**
 * One accepted decision, reduced to the three things the guard can actually
 * reason about: what the ADR is called, what subject it names, and what it
 * decided. `forbidden` is the ADR's own declaration of what contradicts it.
 */
export type AdrDecision = {
  /** The ADR handle the warning names, e.g. `adr-001-goal-store-root-surface`. */
  slug: string
  /**
   * The phrase(s) that name the subject, matched literally and case-insensitively
   * on whitespace-normalised text. Several phrases mean "any of these names the
   * subject" (e.g. the concept and the paths it covers); each one is still an
   * exact phrase, never a word-fragment or a regex.
   */
  subject: string | string[]
  /** The accepted decision, quoted back in the warning. */
  statement: string
  /** Phrases/regexes the ADR declares contradictory. Empty ⇒ prose inference is NOT attempted. */
  forbidden: AdrForbidden[]
  /** Only `accepted` (or absent) decisions are enforced. */
  status?: string
}

/** A contract field the guard reads: the outcome and each stop rule. */
export type AdrField = { path: string; text: string }

/** A contradiction, with the contract clause that carries it. */
export type AdrContradiction = { reason: "forbidden" | "negation"; fragment: string; phrase: string }

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "")
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

/** Lowercase, punctuation-flattened text used for every comparison. */
const norm = (text: string) =>
  text
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/[^a-z0-9/.\- ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()

const tokens = (text: string) => norm(text).split(" ").filter(Boolean)

/**
 * Words that carry no subject of their own. A shared run of these alone ("the
 * run shall") is not evidence that two statements are about the same thing.
 */
const STOP = new Set([
  "the", "and", "or", "a", "an", "of", "to", "in", "on", "for", "with", "is", "are", "be", "been", "being", "was", "were",
  "it", "this", "that", "these", "those", "as", "at", "by", "from", "into", "than", "then", "so", "if", "when", "must",
  "shall", "will", "should", "can", "may", "not", "no", "any", "all", "each", "its", "their", "there", "which", "while",
  "has", "have", "had", "does", "do", "did", "but", "also", "only", "same", "such", "per", "via", "one", "two", "own",
])

/** A negation cue: the only polarity signal the guard trusts. */
const NEGATION =
  /\b(?:not|never|no|none|cannot|without|forbidd?en|prohibit(?:ed|s)?|disallow(?:ed|s)?|deprecat(?:ed|es)?|reject(?:ed|s)?|avoid(?:ed|s)?|neither|nor)\b|n['’]t\b/i

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** Validate one projection entry; anything malformed is dropped, never raised. */
function decision(raw: unknown): AdrDecision | undefined {
  if (!isRecord(raw)) return undefined
  const slug = str(raw.slug)
  const subjects = (Array.isArray(raw.subject) ? raw.subject : [raw.subject]).map(str).filter(Boolean)
  const statement = str(raw.statement)
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(slug) || !subjects.length || !statement) return undefined
  const status = str(raw.status)
  if (status && status !== "accepted") return undefined
  const forbidden: AdrForbidden[] = []
  for (const entry of Array.isArray(raw.forbidden) ? raw.forbidden : []) {
    if (typeof entry === "string" && entry.trim()) forbidden.push(entry.trim())
    else if (isRecord(entry) && str(entry.phrase)) forbidden.push({ phrase: str(entry.phrase) })
    else if (isRecord(entry) && str(entry.regex)) forbidden.push({ regex: str(entry.regex) })
  }
  return { slug, subject: subjects.length === 1 ? subjects[0]! : subjects, statement, forbidden, ...(status ? { status } : {}) }
}

/**
 * Read a projection value. Accepts the documented `{ version, decisions: [] }`
 * object or a bare array; every invalid entry is skipped. A projection is an
 * advisory hint, so a broken one must never turn into a validation error.
 */
export function parseAdrDecisions(raw: unknown): AdrDecision[] {
  const list = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.decisions) ? raw.decisions : []
  return list.flatMap((entry) => {
    const parsed = decision(entry)
    return parsed ? [parsed] : []
  })
}

/**
 * Load the project's projection. Absent, unreadable, malformed JSON or a
 * directory where the file should be ⇒ `[]` (today's behaviour exactly). This
 * is the ONLY I/O the guard performs, and an absent projection costs one stat.
 */
export function loadAdrDecisions(root: string): AdrDecision[] {
  const file = join(root, ADR_DECISIONS_PATH)
  try {
    if (!existsSync(file)) return []
    return parseAdrDecisions(JSON.parse(readFileSync(file, "utf8")))
  } catch {
    return []
  }
}

/** Does the text name any of the ADR's subjects? No subject ⇒ never a match. */
const mentions = (text: string, subject: string | string[]) => {
  const haystack = ` ${norm(text)} `
  const needles = (Array.isArray(subject) ? subject : [subject]).map(norm).filter(Boolean)
  return needles.some((needle) => haystack.includes(` ${needle} `))
}

/**
 * The longest run of words two statements share. Three requirements, all three
 * load-bearing against false positives:
 *   - three words or more (two-word overlaps like "release is" are far too common);
 *   - at least one word of 4+ characters that is not a stop word;
 *   - the caller must additionally have found the ADR's subject in the text.
 * A single shared word never counts — that is where prose inference starts.
 */
function sharedRun(a: string[], b: string[]): string[] | undefined {
  let best: string[] = []
  for (let i = 0; i < a.length; i++)
    for (let j = 0; j < b.length; j++) {
      let k = 0
      while (i + k < a.length && j + k < b.length && a[i + k] === b[j + k]) k++
      if (k > best.length) best = a.slice(i, i + k)
    }
  return best.length >= 3 && best.some((word) => word.length >= 4 && !STOP.has(word)) ? best : undefined
}

/** Locate the shared run in the original text, tolerating punctuation between words. */
function locate(text: string, words: string[]): { index: number; length: number } | undefined {
  const re = new RegExp(words.map(escapeRe).join("[\\s,;:]+"), "i")
  const match = re.exec(text)
  return match ? { index: match.index, length: match[0].length } : undefined
}

/**
 * The comma/semicolon/sentence-delimited clause holding a phrase, plus whether
 * that clause is negated. Deliberately a clause, not a paragraph: an unrelated
 * "must not exceed the budget" earlier in the same sentence must not make the
 * subject look negated.
 */
function clauseAt(text: string, index: number, length: number): { fragment: string; negated: boolean } {
  const start = Math.max(0, index - 120)
  const before = text.slice(start, index)
  const boundary = Math.max(...[",", ";", "!", "?", ".", "\n"].map((char) => before.lastIndexOf(char)))
  const from = boundary >= 0 ? start + boundary + 1 : start
  const rest = text.slice(index + length, index + length + 120)
  const stop = rest.search(/[,;!?.\n]/)
  const to = index + length + (stop >= 0 ? stop : rest.length)
  const fragment = text.slice(from, to).trim()
  return { fragment, negated: NEGATION.test(fragment) }
}

/**
 * Does this contract text contradict this decision? Two explicit routes only:
 *
 *  1. `forbidden` — the ADR declares the phrase/regex itself. Always trusted.
 *  2. negation flip — the ADR and the text share a substantive 3+ word run about
 *     the ADR's named subject, and one clause is negated while the other is not.
 *
 * Nothing else is inferred from prose: an unknown ADR subject, a single shared
 * word, or the same polarity all stay silent.
 */
export function adrContradiction(text: string, decision: AdrDecision): AdrContradiction | undefined {
  if (!text.trim() || !mentions(text, decision.subject)) return undefined

  for (const entry of decision.forbidden) {
    if (typeof entry === "string" || "phrase" in entry) {
      const phrase = typeof entry === "string" ? entry : entry.phrase
      const needle = norm(phrase)
      if (needle && ` ${norm(text)} `.includes(` ${needle} `)) return { reason: "forbidden", fragment: phrase, phrase }
    } else {
      try {
        const match = new RegExp(entry.regex, "i").exec(text)
        if (match?.[0]) return { reason: "forbidden", fragment: match[0], phrase: entry.regex }
      } catch {
        // A malformed regex in the projection is ignored: advisory input only.
      }
    }
  }

  const words = sharedRun(tokens(decision.statement), tokens(text))
  if (!words) return undefined
  const accepted = locate(decision.statement, words)
  const stated = locate(text, words)
  if (!accepted || !stated) return undefined
  const left = clauseAt(decision.statement, accepted.index, accepted.length)
  const right = clauseAt(text, stated.index, stated.length)
  if (left.negated === right.negated) return undefined
  return { reason: "negation", fragment: right.fragment, phrase: words.join(" ") }
}

const clamp = (text: string, max = 160) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/** The advisory warning: names the ADR, quotes it, and never touches the contract. */
export function adrMessage(decision: AdrDecision, hit: AdrContradiction): string {
  const said =
    hit.reason === "forbidden"
      ? `this text says "${clamp(hit.fragment)}", which the ADR forbids`
      : `this text negates "${clamp(hit.phrase)}", the opposite of what the ADR accepts`
  return `contradicts accepted ADR "${decision.slug}" ("${clamp(decision.statement)}"): ${said} — agree with the ADR or supersede it; the contract is not rewritten`
}

/** One warning per (field, ADR): the first contradiction is reported, not every trace of it. */
export function adrIssues(fields: readonly AdrField[], decisions: readonly AdrDecision[]): Issue[] {
  const issues: Issue[] = []
  for (const field of fields) {
    for (const decision of decisions) {
      const hit = adrContradiction(field.text, decision)
      if (hit) issues.push({ level: "warning", path: field.path, message: adrMessage(decision, hit) })
    }
  }
  return issues
}
