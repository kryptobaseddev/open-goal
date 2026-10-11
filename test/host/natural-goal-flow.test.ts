import { expect, test } from "bun:test"
import { goalHost, newSession, script } from "./goal.helpers"
import { until } from "./harness"

test("bare /goal starts an actionable create-or-manage flow rather than only a status notice", async () => {
  const host = await goalHost(script(() => ({ text: "Ready for the goal interview." })))
  try {
    const sessionID = await newSession(host)
    await host.client.session.command({ sessionID, name: "goal", text: "" } as any)
    // Either an actual native choice form or a writer/manager agent turn is
    // an actionable flow. A toast listing slugs is not one.
    const flow = await until(async () => {
      const forms: any[] = await (host.client.session.form as any).list({ sessionID })
      return forms.length || host.fixture.requests.some((r) => r.tools?.length) ? true : undefined
    }, 5000)
    expect(flow).toBe(true)
  } finally { await host.stop() }
}, 30000)

test("an idea starting with start is preserved and reaches the write-goal interview", async () => {
  const host = await goalHost(script(() => ({ text: "Ready for the goal interview." })))
  try {
    const sessionID = await newSession(host)
    const idea = "start writing a reliable import feature with acceptance checks"
    await host.client.session.command({ sessionID, name: "goal", text: idea } as any)
    const request = await until(() => host.fixture.requests.find((r) => r.tools?.length && JSON.stringify(r.messages).includes(idea)), 5000)
    expect(request).toBeDefined()
    // Selected skill contents, not just the available-skill name/description.
    expect(JSON.stringify(request.messages)).toContain("A goal is a completion contract")
  } finally { await host.stop() }
}, 30000)
