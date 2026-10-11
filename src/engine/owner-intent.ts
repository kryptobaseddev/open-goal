/** Bounded owner-command spellings, not an NLP interpreter. The agent still
 * selects a typed action/target. Tool-supplied text is never consent: this
 * message must be fetched from the host's own session history. */
export function explicitResume(text: string): boolean {
  const value = text.trim()
  if (/\b(?:do not|don't|not|never)\s+(?:resume|continue)\b|\b(?:if|when|unless|until)\b/i.test(value)) return false
  return /^(?:please\s+)?(?:resume|continue)[.!]?$/i.test(value)
    || /^I (?:approve|authorize) you to resume[.!](?:\s|$)/i.test(value)
}

export function ownerResumeMessage(messages: readonly any[], generationAt: number, review?: { createdAt: number; expiresAt: number }) {
  for (const message of [...messages].reverse()) {
    if (message?.type !== "user" || message.metadata?.goal) continue
    if (typeof message.id !== "string" || typeof message.text !== "string" || typeof message.time?.created !== "number") return undefined
    if (message.time.created < generationAt) return undefined
    const text = message.text.trim()
    // Steering/questions and background synthetics do not revoke the owner's
    // existing directive. A later stop, contradiction or conditional does.
    if (/^(?:cancel|stop|pause|abort|reject)\b|\b(?:do not|don't|never)\s+(?:resume|continue)\b|\b(?:withdraw|revoke)\b.*\b(?:approval|consent)\b/i.test(text)
      || /^(?:resume|continue)\b.*\b(?:if|when|unless|until)\b/i.test(text)) return undefined
    const acceptsReview = review && message.time.created >= review.createdAt && message.time.created <= review.expiresAt
      && /^(?:I\s+)?(?:accept|approve)[.!]?$/i.test(text)
    if (explicitResume(text) || acceptsReview) return { id: message.id, text: message.text, createdAt: message.time.created }
  }
}
