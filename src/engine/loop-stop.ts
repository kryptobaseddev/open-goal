// v0.8.0 — what still stops the loop.
//
// The owner's policy removes lifecycle prompts, not safety. A human criterion,
// a real blocker and an outward/destructive act always stop and ask. Two more
// stops are stated by the contract this project is run under (C6): a first visit
// to a project the loop has never worked in, and an exhausted budget — unless the
// contract says otherwise. Those two are the only stops an owner can waive, and
// they are waived explicitly (`allowNewProjects`, `allowBudgetExhaustion`), never
// by inference.
//
// Pure: the adapter gathers the facts, this decides.

export type StopFacts = {
  /** A `human` criterion is waiting for owner sign-off. */
  humanCriterionPending?: boolean
  /** A blocker was reported (missing credential/access/decision). */
  blocker?: string
  /** The next step would publish, deploy, merge, delete, spend or reveal secrets. */
  outwardActRequired?: boolean
  /** The source contract's budget is used up. */
  budgetExhausted?: boolean
  /** The contract explicitly allows continuing past its budget. */
  allowBudgetExhaustion?: boolean
  /** The project the candidate belongs to, when a candidate exists. */
  candidateProject?: string
  currentProject: string
  /** Projects this loop has already worked in. */
  visitedProjects?: string[]
  /** The contract explicitly allows a first visit to a new project. */
  allowNewProjects?: boolean
}

export type StopDecision =
  | { stop: false }
  | { stop: true; code: "human" | "blocker" | "outward" | "budget" | "new-project"; reason: string }

export function loopStop(facts: StopFacts): StopDecision {
  if (facts.humanCriterionPending)
    return { stop: true, code: "human", reason: "a human criterion needs the owner's sign-off" }
  if (facts.blocker)
    return { stop: true, code: "blocker", reason: `a blocker needs the owner: ${facts.blocker}` }
  if (facts.outwardActRequired)
    return { stop: true, code: "outward", reason: "the next step is outward or destructive; the owner must authorize it" }
  if (facts.budgetExhausted && !facts.allowBudgetExhaustion)
    return { stop: true, code: "budget", reason: "the budget is exhausted and the contract does not allow continuing past it" }
  if (facts.candidateProject && facts.candidateProject !== facts.currentProject
    && !(facts.visitedProjects ?? []).includes(facts.candidateProject) && !facts.allowNewProjects)
    return { stop: true, code: "new-project", reason: `the candidate is in a project this loop has never worked in: ${facts.candidateProject}` }
  return { stop: false }
}
