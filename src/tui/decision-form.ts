/** Forward an actual owner dialog choice into the exact native question.
 * Never match on a label alone or interpret free commentary as a choice. */
export function decisionFormAnswer(forms: readonly any[], question: string, label: string): { formID: string; answer: Record<string, string> } | undefined {
  for (const form of forms) {
    if (form.state?.status && form.state.status !== "pending") continue
    if (form.fields?.length !== 1) continue
    const field = form.fields[0]
    if (!field.key || field.title !== question && field.description !== question) continue
    const option = field.options?.find((o: any) => o.label === label && typeof o.value === "string")
    if (option) return { formID: form.id, answer: { [field.key]: option.value } }
  }
}
