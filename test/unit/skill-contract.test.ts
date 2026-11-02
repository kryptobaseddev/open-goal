import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// T161 — the portable SKILL.md contract. The skill is how a worker learns the
// tools it may call; if a tool is renamed or removed and the skill still names
// it, the next goal is instructed into an unknown-tool error. This validates the
// contract instead of trusting the prose: portable frontmatter fields, a
// store-neutral description, and every declared tool actually registered.

const root = process.cwd()
const text = readFileSync(join(root, "skills/write-goal/SKILL.md"), "utf8")
const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text)
const yaml = (globalThis as any).Bun?.YAML
if (!front || !yaml) throw new Error("SKILL.md frontmatter or Bun.YAML is unavailable")

const meta = yaml.parse(front[1]!) as {
  name?: string
  description?: string
  license?: string
  metadata?: { version?: string; tools?: string }
}

test("the skill declares the portable frontmatter fields", () => {
  expect(meta.name).toBe("write-goal")
  expect(typeof meta.description).toBe("string")
  expect(meta.description!.length).toBeGreaterThan(80)
  expect(meta.license).toBe("MIT")
  expect(meta.metadata?.version).toMatch(/^\d+\.\d+\.\d+$/)
})

test("the description is store-neutral: it does not hard-code one store root", () => {
  // The store is a project setting (T150). A description that promises
  // .opencode/goals describes a layout most projects no longer use.
  expect(meta.description).not.toContain(".opencode/goals/goal")
  expect(meta.description).toContain("goal store")
})

test("every declared tool is a registered goal tool", () => {
  const declared = (meta.metadata?.tools ?? "").split(",").map((s) => s.trim()).filter(Boolean)
  expect(declared.length).toBeGreaterThan(8)
  const source = readFileSync(join(root, "src/server/app.ts"), "utf8")
  for (const name of declared) {
    expect(name.startsWith("goal_"), `${name} is a goal tool`).toBe(true)
    const bare = name.slice("goal_".length)
    // Registered as tool("name", …) or tool(\n  "name", … — the worker tools use
    // the multi-line form, so allow whitespace across the newline.
    const registered = new RegExp(`tool\\(\\s*"${bare}"`).test(source)
    expect(registered, `${name} is registered in src/server/app.ts`).toBe(true)
  }
})

test("the skill body does not instruct the worker to call an undeclared tool", () => {
  const declared = new Set((meta.metadata?.tools ?? "").split(",").map((s) => s.trim()).filter(Boolean))
  const called = [...text.matchAll(/\bgoal_[a-z_]+\b/g)].map((m) => m[0]!)
  const undeclared = [...new Set(called)].filter((name) => !declared.has(name))
  expect(undeclared).toEqual([])
})
