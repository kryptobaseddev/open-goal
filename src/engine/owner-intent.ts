/** Bounded owner-command spellings, not an NLP interpreter. The agent still
 * selects a typed action/target. Tool-supplied text is never consent: this
 * message must be fetched from the host's own session history. */
export function explicitResume(text: string): boolean {
  const value = text.trim()
  if (/\b(?:do not|don't|not|never)\s+(?:resume|continue)\b|\b(?:if|when|unless|until)\b/i.test(value)) return false
  return /^(?:please\s+)?(?:resume|continue)[.!]?$/i.test(value)
    || /^(?:please\s+)?(?:resume|continue)\s+(?:(?:the|my|your)\s+)?goal[.!]?$/i.test(value)
    || /^I (?:approve|authorize) you to resume[.!](?:\s|$)/i.test(value)
}

export function ownerResumeMessage(messages: readonly any[], generationAt: number, review?: { createdAt: number; expiresAt: number; expiryPolicy?: "time" | "target" }) {
  for (const message of [...messages].reverse()) {
    if (message?.type !== "user" || message.metadata?.goal) continue
    if (typeof message.id !== "string" || typeof message.text !== "string" || typeof message.time?.created !== "number") return undefined
    if (message.time.created < generationAt) return undefined
    const text = message.text.trim()
    // Steering/questions and background synthetics do not revoke the owner's
    // existing directive. A later stop, contradiction or conditional does.
    if (/^(?:cancel|stop|pause|abort|reject)\b|\b(?:do not|don't|never)\s+(?:resume|continue)\b|\b(?:withdraw|revoke)\b.*\b(?:approval|consent)\b/i.test(text)
      || /^(?:resume|continue)\b.*\b(?:if|when|unless|until)\b/i.test(text)) return undefined
    // Caller must still match the exact live target; elapsed time alone is
    // not a revocation of a target-bound lifecycle question.
    const acceptsReview = review && message.time.created >= review.createdAt && (review.expiryPolicy === "target" || message.time.created <= review.expiresAt)
      && /^(?:I\s+)?(?:accept|approve)[.!]?$/i.test(text)
    if (explicitResume(text) || acceptsReview) return { id: message.id, text: message.text, createdAt: message.time.created }
  }
}

/** A typed amendment action still needs the host's actual latest owner
 * message. Quoted/design/conditional text and old replies are not consent. */
export function ownerAmendmentMessage(messages: readonly any[], review: { createdAt: number; expiresAt: number; expiryPolicy?: "time" | "target" }, action: "accept" | "reject" | "comment") {
  const message = [...messages].reverse().find((m) => m?.type === "user" && !m.metadata?.goal)
  if (!message || typeof message.id !== "string" || typeof message.text !== "string" || typeof message.time?.created !== "number"
    || message.time.created < review.createdAt || review.expiryPolicy !== "target" && message.time.created > review.expiresAt) return undefined
  const value = message.text.trim()
  if (!value || action !== "comment" && /["“”`]|\b(?:if|when|unless|until|do not|don't|never|not yet)\b/i.test(value)) return undefined
  const subject = "(?:\\s+(?:(?:this|that|the)\\s+)?(?:amendment|ammendment|proposal|review|change|it))?"
  const continuation = "(?:[,.]?\\s+(?:(?:and|then)\\s+)?(?:please\\s+)?(?:resume(?:\\s+(?:the\\s+)?goal)?|continue(?:\\s+(?:the\\s+)?goal)?|get\\s+it\\s+done|finish\\s+(?:it|the\\s+goal)))?"
  const accepting = new RegExp(`^(?:(?:yes|okay|ok)[,.]?\\s+)?(?:please\\s+)?(?:I\\s+)?(?:accept|approve)${subject}(?:\\s+now)?${continuation}[.!]?$`, "i").test(value)
  const rejecting = new RegExp(`^(?:please\\s+)?(?:I\\s+)?(?:reject|decline)${subject}[.!]?$`, "i").test(value)
  if (action === "accept" && !accepting || action === "reject" && !rejecting || action === "comment" && (accepting || rejecting)) return undefined
  return { id: message.id, text: message.text, createdAt: message.time.created,
    explicitAmendment: /\b(?:amendment|ammendment)\b/i.test(value),
    continueGoal: accepting && /\b(?:resume|continue|finish|get\s+it\s+done)\b/i.test(value) }
}

/** A new explicit chat directive authorizes the last actually displayed
 * contract, not an expired form answer or a worker-supplied consent string. */
export function ownerLaunchMessage(messages: readonly unknown[], displayed: readonly { id: string; slug: string; lock: string; fresh: boolean; at: number }[], target: { slug: string; lock: string; fresh: boolean }) {
  const latest = [...displayed].sort((a, b) => b.at - a.at)[0]
  if (!latest || latest.slug !== target.slug || latest.lock !== target.lock || latest.fresh !== target.fresh) return undefined
  for (const value of [...messages].reverse()) {
    if (!value || typeof value !== "object") continue
    const message = value as { type?: unknown; id?: unknown; text?: unknown; time?: { created?: unknown }; metadata?: { goal?: unknown } }
    if (message.type !== "user" || message.metadata?.goal) continue
    if (typeof message.id !== "string" || typeof message.text !== "string" || typeof message.time?.created !== "number") return undefined
    const text = message.text.trim()
    if (/^(?:cancel|stop|pause|abort|reject)\b|\b(?:do not|don't|never)\s+(?:start|launch|resume|continue)\b|\b(?:withdraw|revoke)\b.*\b(?:approval|consent)\b/i.test(text)) return undefined
    if (/\b(?:start|launch|resume|continue)\b.*\b(?:if|when|unless|until)\b/i.test(text)) return undefined
    if (/["“”`]|\b(?:if|when|unless|until|not yet)\b/i.test(text)) continue
    const explicit = /^(?:please\s+)?(?:start|launch)\s+(?:(?:the|this|my|your)\s+)?(?:goal|plan)(?:\s+now)?[.!]?$/i.test(text)
      || /^(?:please\s+)?continue\s+(?:(?:the|my|your)\s+)?goal[.!]?$/i.test(text)
      || /^Just go ahead and start the plan[.!]\s*I approve[.!]?$/i.test(text)
    if (!explicit) continue
    const at = message.time.created
    const review = displayed.filter((p) => p.at <= at).sort((a, b) => b.at - a.at)[0]
    if (!review || review.slug !== target.slug || review.lock !== target.lock || review.fresh !== target.fresh) return undefined
    return { id: message.id, text: message.text, createdAt: message.time.created, reviewId: review.id }
  }
}
