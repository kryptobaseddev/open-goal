import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { checkQuotes, decodeEntities, type VerifierVerdict } from "../../src/verify/pipeline"

// T108 (the live C5 failure). A verifier read a JUnit file, decoded it, and
// quoted the readable line — but the raw bytes carry entity escapes
// (`&#10;`, `&quot;`, `&lt;`), so the host's literal re-read rejected a correct
// quote as "quoted text not found". The re-read must accept the equivalent
// decoded text, for both the raw junit and a plain-text renderer of the line.

const root = mkdtempSync(join(tmpdir(), "ocgoal-quote-"))
const write = (rel: string, body: string) => {
  const path = join(root, rel)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body)
  return rel
}

const JUNIT = `<testsuite name="demo" tests="1">
  <testcase name="a &quot;quoted&quot; case&#10;second line" classname="C1">
    <failure message="expected &lt;ok&gt; but got &lt;bad&gt;">line one&#10;line two</failure>
  </testcase>
</testsuite>
`
const verdict = (quote: string, path = "result.xml"): VerifierVerdict => ({ id: "C1", verdict: "proven", reason: "quoted", evidence: [{ path, quote }] })

test("a decoded quote of an entity-escaped junit line is accepted", () => {
  write("result.xml", JUNIT)
  // The verifier quoted the readable line it decoded from the file.
  expect(checkQuotes(root, verdict('a "quoted" case\nsecond line')).ok).toBe(true)
  expect(checkQuotes(root, verdict("expected <ok> but got <bad>")).ok).toBe(true)
  expect(checkQuotes(root, verdict("line one line two")).ok).toBe(true)
  // Quoting the raw escaped form still works.
  expect(checkQuotes(root, verdict("a &quot;quoted&quot; case&#10;second line")).ok).toBe(true)
})

test("the plain-text renderer of the same line is accepted", () => {
  write("result.txt", 'name: a "quoted" case\nsecond line\nexpected <ok> but got <bad>\n')
  expect(checkQuotes(root, verdict('a "quoted" case second line', "result.txt")).ok).toBe(true)
  expect(checkQuotes(root, verdict("expected <ok> but got <bad>", "result.txt")).ok).toBe(true)
})

test("a quote that is genuinely absent is still rejected", () => {
  write("result.xml", JUNIT)
  expect(checkQuotes(root, verdict("this text appears nowhere in the file")).ok).toBe(false)
})

test("decodeEntities decodes numeric, hex and named escapes", () => {
  expect(decodeEntities("a&#10;b&quot;c&lt;d&gt;e&amp;f&#x41;")).toBe('a\nb"c<d>e&fA')
})
