// Recognize only the existing, explicit command shorthand. Everything
// conversational remains the owner's text for the agent to interpret; this
// is deliberately NOT a host-side NLP-to-shell parser.
export function directGoalCommand(text: string, slugs: readonly string[]): boolean {
  const [head = "", ...rest] = text.trim().split(/\s+/)
  const sub = head.toLowerCase()
  const arg = rest.join(" ")
  const named = (s: string) => slugs.includes(s)
  switch (sub) {
    case "new": case "write": return true
    case "status": case "help": return !arg
    case "list": return !arg || arg === "all"
    case "start": return !arg || named(rest[0] ?? "") && rest.slice(1).every((t) => ["fresh", "acknowledge-supersede"].includes(t))
    case "validate": case "pause": case "resume": case "abort": case "verify": case "archive": case "attach": case "revert":
      return !arg || rest.length === 1 && named(rest[0]!)
    case "cleo": return true
    case "amend": return !arg || arg === "confirm" || rest.length === 1 && named(rest[0]!)
    case "approve": return /^C\d+(?:\s+[a-z0-9-]+)?$/i.test(arg)
    case "reject": return /^C\d+(?:\s|$)/i.test(arg)
    default: return false
  }
}
