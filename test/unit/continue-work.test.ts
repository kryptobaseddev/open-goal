import { describe, expect, test } from "bun:test"
import { readyCleoTask } from "../../src/engine/continue-work"

// v0.8.0 follow-up — C4 says "the next ready CLEO item". A parent's acceptance
// is a rollup, not work: the selector must prefer a leaf task and report the
// parent it skipped instead of starting it.

const payload = (value: unknown) => JSON.stringify(value)

const runner = (tasks: Record<string, unknown>, suggestions: string[]) => async (command: string, args: string[]) => {
  if (command !== "cleo") return { stdout: "", exit: 127 }
  if (args[0] === "next") return { stdout: payload({ success: true, data: { suggestions: suggestions.map((id) => ({ id })) } }), exit: 0 }
  if (args[0] === "show") {
    const task = tasks[args[1]!]
    return task ? { stdout: payload({ success: true, data: { task } }), exit: 0 } : { stdout: payload({ success: false }), exit: 1 }
  }
  return { stdout: "", exit: 1 }
}

describe("readyCleoTask", () => {
  test("skips a suggested epic and returns the next leaf task", async () => {
    const run = runner(
      {
        T010: { id: "T010", type: "epic", status: "pending", title: "Parent epic", acceptance: ["all children done"] },
        T011: { id: "T011", type: "task", status: "pending", title: "Leaf work", acceptance: ["the marker exists"] },
      },
      ["T010", "T011"],
    )
    const ready = await readyCleoTask(run, "cleo")
    expect(ready.task?.id).toBe("T011")
    expect(ready.task?.acceptance).toEqual(["the marker exists"])
    expect(ready.skipped).toEqual([{ id: "T010", type: "epic", title: "Parent epic" }])
  })

  test("returns no task when only parents are ready, reporting each skip", async () => {
    const run = runner(
      {
        T010: { id: "T010", type: "epic", status: "pending", title: "Parent epic" },
        T001: { id: "T001", type: "saga", status: "pending", title: "Root saga" },
      },
      ["T010", "T001"],
    )
    const ready = await readyCleoTask(run, "cleo")
    expect(ready.task).toBeUndefined()
    expect(ready.skipped.map((s) => s.id)).toEqual(["T010", "T001"])
  })

  test("skips terminal suggestions and treats a CLI failure as no work", async () => {
    const done = runner({ T010: { id: "T010", type: "task", status: "done", title: "Already done" } }, ["T010"])
    expect((await readyCleoTask(done, "cleo")).task).toBeUndefined()
    const broken: any = async () => ({ stdout: "", exit: 1 })
    expect((await readyCleoTask(broken, "cleo")).task).toBeUndefined()
  })
})
