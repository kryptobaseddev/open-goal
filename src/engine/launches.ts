import { OwnerReviewStore, type ReviewRequest } from "./owner-reviews"
export { processAlive } from "./owner-reviews"

export type LaunchRequest = ReviewRequest & { fresh: boolean }
export const launchChoices = [
  { value: "launch", label: "Start goal now (Recommended)", description: "Launch exactly this validated contract in the displayed session mode." },
  { value: "revise", label: "Revise this goal", description: "Return to the interview with changes; nothing launches." },
  { value: "save", label: "Save for later", description: "Keep the validated draft; nothing launches." },
] as const

export class LaunchStore extends OwnerReviewStore<LaunchRequest> {
  constructor(file: string) { super(file, launchChoices) }
}
