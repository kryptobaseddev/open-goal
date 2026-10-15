import { expect, test } from "bun:test"
import { startHost } from "./harness"

// T107: the harness used to reserve a port by opening and closing a listener.
// The number is free in that window, so a parallel test host (or anything
// else) can take it before the child binds it — the stress run reproduced the
// consequence as "Failed to start server. Is port 62624 in use?" and, worse, a
// squatter that answers the readiness poll would be accepted as this host's
// server. The guard: ask for port 0, learn the port from the child's own
// listening line, and require the answering server to be that child.
//
// OCGOAL_HOST_PORT forces the first attempt, so this test can hold the port.

const quietScript = () => ({ text: "Nothing to do." })

test("a taken port is retried, and the host only ever talks to the child it spawned", async () => {
  // A squatter that would happily answer a readiness poll on the forced port.
  let squatRequests = 0
  const squatter = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => { squatRequests++; return new Response(JSON.stringify({ pid: 1, version: "squatter" }), { headers: { "content-type": "application/json" } }) } })
  const taken = squatter.port
  process.env.OCGOAL_HOST_PORT = String(taken)
  let host: Awaited<ReturnType<typeof startHost>> | undefined
  try {
    host = await startHost({ script: quietScript })
    // The host started on a different port and its server is its own child.
    expect(host.port).not.toBe(taken)
    expect(host.url).toBe(`http://127.0.0.1:${host.port}`)
    const probes = squatRequests
    const info: any = await host.client.server.info()
    // The squatter answered the readiness probe (that is how it was detected),
    // but it was never ACCEPTED: our client now talks to the spawned child, and
    // no further traffic reaches the squatter.
    expect(info.pid).toBe(host.childPid)
    expect(info.pid).not.toBe(1)
    expect(squatRequests).toBe(probes)
  } finally {
    delete process.env.OCGOAL_HOST_PORT
    squatter.stop(true)
    await host?.stop()
  }
}, 90000)
