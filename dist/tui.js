// @bun
// src/tui/index.tsx
import { use as _$use } from "@opentui/solid";
import { memo as _$memo } from "@opentui/solid";
import { createComponent as _$createComponent } from "@opentui/solid";
import { effect as _$effect } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { createTextNode as _$createTextNode } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
import { createEffect, createSignal, For, onCleanup, Show, untrack } from "solid-js";
import { createStore, reconcile } from "solid-js/store";

// src/rpc.ts
var anyObject = { type: "object", additionalProperties: true };
var targetObject = { type: "object", properties: { key: { type: "string", minLength: 1, maxLength: 256 }, lock: { type: "string", minLength: 64, maxLength: 64 }, runId: { type: "string", minLength: 1, maxLength: 128 }, sessionID: { type: "string", minLength: 1, maxLength: 256 } }, required: ["key", "lock"], additionalProperties: false };
var GoalRpc = {
  id: "opencode-goal",
  methods: {
    provenance: {
      input: { type: "object", properties: { sessionID: { type: "string", minLength: 1, maxLength: 256 } }, additionalProperties: false },
      output: anyObject
    },
    snapshot: {
      input: { type: "object", properties: { sessionID: { type: "string", minLength: 1, maxLength: 256 } }, required: ["sessionID"], additionalProperties: false },
      output: anyObject
    },
    list: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: anyObject
    },
    details: {
      input: { type: "object", properties: { key: { type: "string", minLength: 1, maxLength: 256 } }, required: ["key"], additionalProperties: false },
      output: anyObject
    },
    review: {
      input: { type: "object", properties: { sessionID: { type: "string", minLength: 1, maxLength: 256 }, decisionId: { type: "string", minLength: 1, maxLength: 256 } }, required: ["sessionID"], additionalProperties: false },
      output: anyObject
    },
    manage: {
      input: { type: "object", properties: { sessionID: { type: "string", minLength: 1, maxLength: 256 }, action: { type: "string", enum: ["pause", "resume", "verify", "attach", "abort", "archive"] }, target: targetObject }, required: ["sessionID", "action", "target"], additionalProperties: false },
      output: anyObject
    },
    act: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string", minLength: 1, maxLength: 256 },
          action: { type: "string", enum: ["pause", "resume", "abort", "verify", "approve", "reject", "amend", "archive", "attach", "start", "start-next", "decompose"] },
          arg: { type: "string", maxLength: 2000 },
          decisionId: { type: "string", minLength: 1, maxLength: 256 }
        },
        required: ["sessionID", "action"],
        additionalProperties: false
      },
      output: anyObject
    }
  },
  events: {
    handoff: { schema: { type: "object", properties: { fromSessionID: { type: "string" }, toSessionID: { type: "string" }, slug: { type: "string" }, runId: { type: "string" }, fallback: { type: "string" } }, required: ["fromSessionID", "toSessionID", "slug", "runId"], additionalProperties: false } },
    updated: { schema: { type: "object", properties: { sessionID: { type: "string" }, view: anyObject }, required: ["sessionID"], additionalProperties: true } },
    notice: { schema: { type: "object", properties: { sessionID: { type: "string" }, level: { type: "string" }, text: { type: "string" }, attention: { type: "string" } }, required: ["text"], additionalProperties: true } },
    summary: { schema: { type: "object", properties: { sessionID: { type: "string" }, slug: { type: "string" }, status: { type: "string" }, headline: { type: "string" }, text: { type: "string" } }, required: ["sessionID", "text"], additionalProperties: true } },
    decision: {
      schema: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          slug: { type: "string" },
          kind: { type: "string", enum: ["needs_review", "paused-after-verdict", "blocked", "budget_limited", "amend-proposed", "supersede-ack", "complete", "start-picker", "owner-operation"] },
          title: { type: "string" },
          message: { type: "string" },
          question: { type: "string" },
          expiresAt: { type: "number" },
          choices: { type: "array", items: { type: "object", properties: { label: { type: "string" }, act: { type: "string" }, arg: { type: "string" }, run: { type: "string" } }, required: ["label"], additionalProperties: true } }
        },
        required: ["sessionID", "kind", "message", "choices"],
        additionalProperties: true
      }
    },
    "decision.resolved": {
      schema: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          kind: { type: "string" },
          decisionId: { type: "string" },
          via: { type: "string", enum: ["form", "dialog", "form-guidance", "amendment-invalidated"] }
        },
        required: ["sessionID", "kind", "via"],
        additionalProperties: true
      }
    },
    "decision.failed": {
      schema: { type: "object", properties: { sessionID: { type: "string" }, decisionId: { type: "string" }, message: { type: "string" } }, required: ["sessionID", "decisionId", "message"], additionalProperties: false }
    }
  }
};

// src/tui/format.ts
var STATUS = {
  running: { icon: "\u25B6", label: "running", tone: "success" },
  waiting: { icon: "\u25F7", label: "waiting", tone: "info" },
  verifying: { icon: "\u25D0", label: "verifying", tone: "info" },
  paused: { icon: "\u23F8", label: "paused", tone: "warning" },
  blocked: { icon: "\u26D4", label: "blocked", tone: "error" },
  needs_review: { icon: "\u2691", label: "needs review", tone: "warning" },
  budget_limited: { icon: "\u2298", label: "budget used", tone: "warning" },
  complete: { icon: "\u2713", label: "complete", tone: "success" },
  failed: { icon: "\u2717", label: "failed", tone: "error" },
  aborted: { icon: "\u25A0", label: "aborted", tone: "muted" },
  superseded: { icon: "\u21E2", label: "superseded", tone: "muted" }
};
var statusOf = (s) => STATUS[s] ?? { icon: "\xB7", label: s, tone: "muted" };
var fit = (text, width) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= width ? flat : `${flat.slice(0, Math.max(1, width - 1))}\u2026`;
};
function fmtDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60)
    return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60)
    return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60 ? ` ${String(m % 60).padStart(2, "0")}m` : ""}`;
}
var fmtTokens = (n) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
var elapsed = (view, now) => view.activeMs + (view.activeSince !== null ? Math.max(0, now - view.activeSince) : 0);
function bar(done, total, width = 10) {
  if (total <= 0)
    return "";
  const filled = Math.round(done / total * width);
  return "\u25A0".repeat(filled) + "\u25A1".repeat(width - filled);
}
var proven = (view) => view.criteria.filter((c) => c.status === "pass").length;
function usageParts(view, now) {
  const limit = (name) => view.budget.find((b) => b.name === name)?.limit;
  const time = `turn ${view.turn}${limit("turns") ? `/${limit("turns")}` : ""} \xB7 ${fmtDuration(elapsed(view, now))}${limit("wall") ? `/${fmtDuration(limit("wall"))}` : ""}`;
  const spend = [];
  if (view.usage.tokens || limit("tokens"))
    spend.push(`${fmtTokens(view.usage.tokens)}${limit("tokens") ? `/${fmtTokens(limit("tokens"))}` : ""} tok`);
  if (view.usage.cost || limit("cost"))
    spend.push(`$${view.usage.cost.toFixed(2)}${limit("cost") ? `/$${limit("cost")}` : ""}`);
  return { time, ...spend.length ? { spend: spend.join(" \xB7 ") } : {} };
}
var usageLine = (view, now) => {
  const u = usageParts(view, now);
  return u.spend ? `${u.time} \xB7 ${u.spend}` : u.time;
};
function pillText(view, now) {
  const st = statusOf(view.status);
  const steps = view.steps ?? [];
  const plan = steps.length ? `${steps.filter((s) => s.status === "done").length}/${steps.length} plan \xB7 ` : "";
  return `\u25CE ${st.icon} ${plan}${proven(view)}/${view.criteria.length} proven \xB7 t${view.turn} \xB7 ${fmtDuration(elapsed(view, now))}`;
}
var RESUME = "/goal resume";
function endStateCopy(status, slug) {
  switch (status) {
    case "complete":
      return { text: `\u25CE \u2713 complete \u2014 the loop has stopped. Follow-ups: the Goal panel (F9) and .opencode/goals/${slug}/`, tone: "success" };
    case "failed":
      return { text: `\u25CE \u2717 failed \u2014 the loop has stopped. What happened: the Goal panel (F9) and .opencode/goals/${slug}/`, tone: "error" };
    case "aborted":
      return { text: `\u25CE \u25A0 aborted \u2014 the loop has stopped. History stays in .opencode/goals/${slug}/`, tone: "muted" };
    default:
      return;
  }
}
function bannerText(view) {
  const st = statusOf(view.status);
  const terminal = endStateCopy(view.status, view.slug);
  if (terminal && view.status !== "running")
    return terminal;
  if (view.awaitingUser && ["running", "waiting", "verifying"].includes(view.status))
    return { text: "\u25CE The goal is waiting for your answer.", tone: "warning" };
  switch (view.status) {
    case "paused":
      return { text: `\u25CE ${st.icon} Goal paused \u2014 ${view.reason ?? ""} \xB7 ${RESUME}`, tone: "warning" };
    case "blocked":
      return { text: `\u25CE ${st.icon} Goal blocked \u2014 ${view.blocker?.reason ?? view.reason ?? ""} \xB7 fix it, then ${RESUME}`, tone: "error" };
    case "needs_review":
      return { text: `\u25CE ${st.icon} Goal needs review \u2014 ${view.reason ?? ""} \xB7 /goal approve <id> or ${RESUME}`, tone: "warning" };
    case "budget_limited":
      return { text: `\u25CE ${st.icon} Goal stopped at its budget \u2014 raise budget in goal.yaml and /goal start, or /goal abort`, tone: "warning" };
    default:
      return;
  }
}
function statusText(view, now) {
  const st = statusOf(view.status);
  const lines = [`${view.title} \u2014 ${st.icon} ${st.label}${view.reason ? ` (${view.reason})` : ""}`, `Outcome: ${view.outcome}`, usageLine(view, now), ""];
  for (const c of view.criteria)
    lines.push(`${c.status === "pass" ? "\u2713" : c.status === "fail" ? "\u2717" : c.status === "claimed" ? "\u25D0" : "\xB7"} ${c.id}${c.invariant ? " (invariant)" : ""} ${c.statement}${c.detail && c.status !== "pass" ? `
    ${c.detail.split(`
`)[0]}` : ""}`);
  if (view.steps.length) {
    lines.push("");
    for (const s of view.steps)
      lines.push(`${s.status === "done" ? "\u2713" : s.status === "active" ? "\u25B8" : "\xB7"} ${s.id} ${s.title}`);
  }
  if (view.progress)
    lines.push("", `Last progress: ${view.progress.note}${view.progress.next ? ` \u2192 ${view.progress.next}` : ""}`);
  if (view.verdict)
    lines.push("", `Last verdict (turn ${view.verdict.turn}): ${view.verdict.passed ? "passed" : "failed"}`, ...view.verdict.lines.map((l) => `  ${l.split(`
`)[0]}`));
  return lines.join(`
`);
}

// src/tui/tracer.ts
var SPINNER = ["\u280B", "\u2819", "\u2839", "\u2838", "\u283C", "\u2834", "\u2826", "\u2827", "\u2807", "\u280F"];
var fmtCountdown = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  if (s < 60)
    return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(s % 60).padStart(2, "0")}s`;
};
var spinFrame = (now) => SPINNER[Math.floor(now / 120) % SPINNER.length];
function tracerLines(view, now, width = 40) {
  const a = view.activity;
  if (!["running", "waiting", "verifying"].includes(view.status))
    return [];
  if (!a) {
    return [{ text: fit(`\u25CE goal ${view.status} \xB7 turn ${view.turn}`, width), tone: "muted" }];
  }
  const elapsed = Math.max(0, Math.floor((now - a.since) / 1000));
  const elapsedText = `${fmtDuration(elapsed * 1000)}`;
  const left = a.until ? Math.max(0, a.until - now) : undefined;
  const leftText = left !== undefined ? fmtCountdown(left) : undefined;
  switch (a.kind) {
    case "verifier-child":
      return [{ text: fit(`${spinFrame(now)} verifier child running \u2014 ${elapsedText}${a.detail ? ` \xB7 ${a.detail}` : ""}`, width), tone: "info" }];
    case "verifying":
      return [{ text: fit(`${spinFrame(now)} verifying the claim \u2014 ${elapsedText}${a.detail ? ` \xB7 ${a.detail}` : " (host checks, then the verifier child)"}`, width), tone: "info" }];
    case "waiting":
      return [{ text: fit(`\u25F7 waiting \u2014 ${leftText ?? elapsedText}${left !== undefined ? " left" : ""}${a.detail ? ` \xB7 ${a.detail}` : ""}`, width), tone: "info" }];
    case "cooldown":
      return [{ text: fit(`\xB7 cooldown \u2014 next turn in ${leftText ?? "\u2026"}`, width), tone: "muted" }];
    case "turn":
    default:
      return [{ text: fit(`${spinFrame(now)} turn ${view.turn} in progress \u2014 ${elapsedText}${a.detail ? ` \xB7 ${a.detail}` : ""}`, width), tone: "success" }];
  }
}

// src/tui/dashboard.ts
var DASHBOARD_TABS = ["now", "progress", "decisions", "goals"];
var STATUS2 = {
  running: { icon: "\u25B6", label: "running", tone: "success" },
  waiting: { icon: "\u25F7", label: "waiting", tone: "info" },
  verifying: { icon: "\u25D0", label: "verifying", tone: "info" },
  paused: { icon: "\u23F8", label: "paused", tone: "warning" },
  blocked: { icon: "\u26D4", label: "blocked", tone: "error" },
  needs_review: { icon: "\u2691", label: "needs review", tone: "warning" },
  budget_limited: { icon: "\u2298", label: "budget used", tone: "warning" },
  complete: { icon: "\u2713", label: "complete", tone: "success" },
  failed: { icon: "\u2717", label: "failed", tone: "error" },
  aborted: { icon: "\u25A0", label: "aborted", tone: "muted" },
  superseded: { icon: "\u21E2", label: "superseded", tone: "muted" }
};
var statusOf2 = (s) => STATUS2[s] ?? { icon: "\xB7", label: s, tone: "muted" };
var provenCount = (view) => view.criteria.filter((c) => c.status === "pass").length;
function cardCompactLines(view, now, width = 40) {
  const st = statusOf2(view.status);
  const lines = [];
  const head = "\u25CE Goal";
  const right = `${st.icon} ${st.label}`;
  lines.push({ text: `${head}${" ".repeat(Math.max(1, width - head.length - right.length))}${right}`, tone: st.tone, bold: true });
  if (view.actionRequired)
    lines.push({ text: fit(`\u2691 ${view.actionRequired}`, width), tone: "error", bold: true, tab: "decisions" });
  lines.push({ text: fit(view.title, width), tone: "base", bold: true, tab: "now" });
  const total = view.criteria.length;
  lines.push({ text: `criteria ${bar(provenCount(view), total)} ${provenCount(view)}/${total}`, tone: provenCount(view) === total && total ? "success" : "muted" });
  const focus = [...view.criteria].sort((a, b) => a.status === "fail" ? -1 : b.status === "fail" ? 1 : a.status === "pass" ? 1 : b.status === "pass" ? -1 : 0).slice(0, 3);
  for (const c of focus) {
    const mark = c.status === "pass" ? "\u2713" : c.status === "fail" ? "\u2717" : "\xB7";
    const tone = c.status === "pass" ? "success" : c.status === "fail" ? "error" : "muted";
    lines.push({ text: fit(`${mark} ${c.id} ${c.statement}`, width), tone, tab: "progress" });
  }
  if (view.steps.length) {
    const current = view.steps.find((s) => s.status === "active") ?? view.steps.find((s) => s.status !== "done");
    if (current)
      lines.push({ text: fit(`\u25B8 ${current.id} ${current.title}`, width), tone: "base", tab: "now" });
  }
  const tokens = view.usage.tokens ? ` \xB7 ${fmtTokens(view.usage.tokens)} tok` : "";
  lines.push({ text: fit(`turn ${view.turn}${tokens}`, width), tone: view.budgetRatio >= 0.8 ? "warning" : "muted" });
  const stopped = endStateCopy(view.status, view.slug);
  if (stopped)
    lines.push({ text: fit(`\u25A0 loop stopped \u2014 follow-ups: .opencode/goals/${view.slug}/`, width), tone: stopped.tone });
  else if (view.progress)
    lines.push({ text: fit(`\u21BB ${view.progress.note}`, width), tone: "muted", tab: "now" });
  const tabs = [...new Set(lines.filter((l) => l.tab && l.text.includes("\u2026")).map((l) => l.tab))];
  const affordance = tabs.length ? `\u21B3 F9 \u2192 ${TAB_LABEL[tabs[0]]}${tabs.length > 1 ? ` (+${tabs.length - 1})` : ""}` : "\u21B3 full card \u2014 F9";
  lines.push({ text: fit(affordance, width), tone: "info" });
  return lines.slice(0, 12);
}
var wrap = (text, width) => {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat)
    return [];
  if (flat.length <= width)
    return [flat];
  const out = [];
  let line = "";
  for (const word of flat.split(" ")) {
    if (!line.length)
      line = word;
    else if (line.length + 1 + word.length <= width)
      line += ` ${word}`;
    else {
      out.push(line);
      line = word;
    }
  }
  if (line.length)
    out.push(line);
  return out.flatMap((l) => l.length <= width ? [l] : l.match(new RegExp(`.{1,${width}}`, "g")) ?? [l]);
};
var TAB_LABEL = { now: "Now", progress: "Progress", decisions: "Decisions", goals: "Goals" };
function cardAffordanceTab(view, now, width = 40) {
  const order = ["decisions", "progress", "now"];
  const truncated = new Set(cardCompactLines(view, now, width).filter((l) => l.tab && l.text.includes("\u2026")).map((l) => l.tab));
  return order.find((t) => truncated.has(t));
}
var humanKinds = new Set(["verdict", "approve", "reject", "amend-proposed", "amended", "blocked", "complete", "summary", "flag", "attached", "paused", "resumed", "aborted", "budget_limited", "superseded-by", "approve ", "reject "]);
function quickActRows(view) {
  const rows = [];
  if (["running", "waiting", "verifying"].includes(view.status)) {
    rows.push({ label: "Pause the goal", description: "stop the loop; /goal resume picks it up", act: "pause" });
    rows.push({ label: "Verify now", description: "run the host checks + verifier immediately", act: "verify" });
  } else if (view.status === "paused") {
    rows.push({ label: "Resume the goal", description: view.reason ?? "continue the loop", act: "resume" });
    rows.push({ label: "Verify now", description: "run the host checks + verifier immediately", act: "verify" });
  } else if (view.status === "blocked") {
    rows.push({ label: "Resolved \u2014 resume", description: view.blocker?.reason ?? "the blocker is fixed", act: "resume" });
    rows.push({ label: "Abort the goal", description: "stop for good; history stays", act: "abort" });
  } else if (view.status === "needs_review") {
    const unproven = view.criteria.filter((c) => !c.invariant && c.status !== "pass");
    for (const c of unproven.slice(0, 3))
      rows.push({ label: `Approve ${c.id} (final)`, description: c.statement, act: "approve", arg: c.id });
    rows.push({ label: "Verify now", description: "run the host checks + verifier immediately", act: "verify" });
  } else if (view.status === "budget_limited") {
    rows.push({ label: "Abort the goal", description: "stop at the budget", act: "abort" });
  } else if (isTerminalStatus(view.status)) {
    rows.push({ label: "Archive the goal", description: "demote to goals-archive/ (history intact)", act: "archive" });
    rows.push({ label: "Start the next goal", description: "open the write-goal interview", act: "start-next" });
  }
  rows.push({ label: "Pause/Resume/Verify are also one keystroke away", description: "/goal pause \xB7 /goal resume \xB7 /goal verify \u2014 or the palette (ctrl+p \u2192 Goal)" });
  return rows;
}
var TERMINAL_STATUSES = new Set(["complete", "failed", "aborted", "superseded"]);
var isTerminalStatus = (s) => TERMINAL_STATUSES.has(s);
var humanizedEvents = (view, n) => {
  const relevant = view.timeline.filter((e) => humanKinds.has(e.kind) || /^(owner|verdict|goal complete|summary|blocked|amended|flag)/i.test(e.text));
  return relevant.slice(-n).reverse();
};
function decisionRows(view) {
  const rows = [];
  if (view.actionRequired) {
    if (view.status === "needs_review") {
      const unproven = view.criteria.filter((c) => !c.invariant && c.status !== "pass");
      for (const c of unproven)
        rows.push({ label: `Approve ${c.id} (final)`, description: c.statement, act: "approve", arg: c.id });
      rows.push({ label: "Reject a criterion", description: "/goal reject <C#> <why>", act: "reject" });
    } else if (view.status === "blocked") {
      rows.push({ label: "Resolved \u2014 resume", description: view.blocker?.reason ?? "the blocker is fixed", act: "resume" });
      rows.push({ label: "Abort the goal", description: "stop for good; history stays", act: "abort" });
    } else if (view.status === "budget_limited") {
      rows.push({ label: "Raise budget and amend", description: "Describe the budget change in the Composer; review the agent's staged diff" });
      rows.push({ label: "Abort the goal", description: "stop at the budget", act: "abort" });
    }
  }
  if (view.status === "paused")
    rows.push({ label: "Resume the goal", description: view.reason ?? "", act: "resume" });
  if (view.status === "complete")
    rows.push({ label: "Archive the goal", description: "demote to goals-archive/ (history intact)", act: "archive" });
  if (view.amendments)
    rows.push({ label: "Confirm proposed amendment", description: "/goal amend confirm", act: "amend", arg: "confirm" });
  return rows;
}
function dialogDigest(title, text, maxLines = 14, maxCols = 100) {
  const lines = text.split(`
`).map((l) => l.length > maxCols ? `${l.slice(0, maxCols - 1)}\u2026` : l);
  const head = lines.slice(0, maxLines);
  const rest = lines.length - head.length;
  return [title, ...head, ...rest > 0 ? [`\u2026 +${rest} more lines \u2014 full text: the Goal panel (F9) or .opencode/goals/ evidence`] : []].join(`
`);
}
function dashboardLines(view, tab, now, width = 46, goals = []) {
  const st = statusOf2(view.status);
  const lines = [];
  const emit = (text, tone, bold = false) => {
    for (const part of wrap(text, width))
      lines.push({ text: part, tone, ...bold ? { bold: true } : {} });
  };
  const rule = () => lines.push({ text: "\u2500".repeat(Math.max(8, Math.min(width, 40))), tone: "muted" });
  const tabsHeader = DASHBOARD_TABS.map((t) => t === tab ? `[${TAB_LABEL[t]}]` : ` ${TAB_LABEL[t]} `).join("");
  lines.push({ text: fit(`\u25CE GOAL ${st.icon} ${st.label}`, width), tone: st.tone, bold: true });
  lines.push({ text: fit(tabsHeader, width), tone: "base", bold: true });
  rule();
  lines.push({ text: "", tone: "base" });
  if (tab === "now") {
    emit(view.title, "base", true);
    emit(view.outcome, "muted");
    lines.push(...tracerLines(view, now, width));
    const current = view.steps.find((s) => s.status === "active") ?? view.steps.find((s) => s.status !== "done");
    if (current)
      emit(`\u25B8 step ${current.id} ${current.title}`, "base");
    if (view.progress?.next)
      emit(`next: ${view.progress.next}`, "muted");
    if (view.actionRequired)
      emit(`\u2691 ${view.actionRequired}`, "error", true);
    else if (["running", "waiting", "verifying"].includes(view.status))
      emit("\u2713 nothing needed from you \u2014 the loop is working", "success");
    const events = humanizedEvents(view, 3);
    if (events.length) {
      lines.push({ text: "recent", tone: "base", bold: true });
      rule();
      for (const e of events)
        emit(`\xB7 ${e.text}`, "muted");
    }
  } else if (tab === "progress") {
    const groups = [
      ["Failed", view.criteria.filter((c) => c.status === "fail"), "error"],
      ["In progress", view.criteria.filter((c) => c.status !== "pass" && c.status !== "fail"), "muted"],
      ["Proven", view.criteria.filter((c) => c.status === "pass"), "success"]
    ];
    emit(`criteria ${bar(provenCount(view), view.criteria.length)} ${provenCount(view)}/${view.criteria.length}`, "base", true);
    for (const [label, items, tone] of groups) {
      if (!items.length)
        continue;
      lines.push({ text: label, tone, bold: true });
      rule();
      for (const c of items)
        emit(`${c.invariant ? "I" : "C"} ${c.id} \u2014 ${c.statement}${c.by ? ` (${c.by})` : ""}`, tone);
    }
    if (view.steps.length) {
      lines.push({ text: "plan", tone: "base", bold: true });
      rule();
      for (const s of view.steps)
        emit(`S ${s.id} ${s.status === "done" ? "\u2713" : s.status === "active" ? "\u25B8" : "\xB7"} ${s.title}`, s.status === "active" ? "info" : s.status === "done" ? "success" : "muted");
    }
    if (view.verdict) {
      lines.push({ text: `last verdict \u2014 ${view.verdict.passed ? "passed" : "failed"}`, tone: view.verdict.passed ? "success" : "warning", bold: true });
      for (const l of view.verdict.lines.slice(0, 3))
        emit(l.split(`
`)[0], view.verdict.passed ? "success" : "warning");
    }
  } else if (tab === "decisions") {
    lines.push({ text: "act on a row (\u2191\u2193 \xB7 enter)", tone: "base", bold: true });
    lines.push({ text: "", tone: "base" });
    const history = humanizedEvents(view, 6);
    if (history.length) {
      lines.push({ text: "history", tone: "base", bold: true });
      rule();
      for (const e of history)
        emit(`\xB7 ${e.text}`, "muted");
    }
  } else {
    const others = goals.filter((g) => g.slug !== view.slug);
    emit(`this goal: ${view.title} (${st.label})`, "base", true);
    if (others.length) {
      lines.push({ text: "other goals", tone: "base", bold: true });
      rule();
      for (const g of others)
        emit(`\xB7 ${g.slug} \u2014 ${g.title} (${g.status})${g.attachable ? " \xB7 attachable" : ""}`, g.terminal ? "muted" : "info");
    } else
      lines.push({ text: "no other goals in this project", tone: "muted" });
    if (view.steps.length) {
      lines.push({ text: "upcoming steps", tone: "base", bold: true });
      rule();
      for (const s of view.steps.filter((s) => s.status !== "done"))
        emit(`S ${s.id} \xB7 ${s.title}`, "muted");
    }
  }
  lines.push({ text: "", tone: "base" });
  lines.push({ text: fit("C criterion \xB7 I invariant \xB7 S plan step", width), tone: "muted" });
  lines.push({ text: fit("\u2191\u2193/tab/enter to act", width), tone: "muted" });
  return lines;
}

// src/contract/types.ts
var HOST_KINDS = ["command", "file", "contains", "absent", "diff"];
var CHECK_KINDS = [...HOST_KINDS, "verifier", "human"];
var priorityWeight = (p) => p === "high" ? 3 : p === "medium" ? 2 : p === "low" ? 1 : 0;

// src/tui/manager.ts
var terminal = new Set(["complete", "failed", "aborted", "superseded"]);
var goalKey = (goal) => goal.key ?? `${goal.archived ? "archive" : "live"}:${goal.slug}:${goal.runId ?? "draft"}`;
var graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
var columns = (text) => Bun.stringWidth(text, { ambiguousIsNarrow: false });
function fitColumns(text, width) {
  const flat = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
  const limit = Math.max(1, Math.floor(width));
  if (columns(flat) <= limit)
    return flat;
  const suffix = columns("\u2026") <= limit ? "\u2026" : ".";
  let out = "";
  for (const { segment } of graphemes.segment(flat)) {
    if (columns(out + segment + suffix) > limit)
      break;
    out += segment;
  }
  return out + suffix;
}
var targetOf = (goal) => ({ key: goalKey(goal), lock: goal.lock ?? "", ...goal.runId ? { runId: goal.runId } : {}, ...goal.sessionID ? { sessionID: goal.sessionID } : {} });
function launchStatusText(launch) {
  if (!launch || launch.status === "succeeded")
    return;
  if (launch.status === "executing")
    return `Starting ${launch.slug} \xB7 ${launch.activity?.detail ?? "owner-approved admission"} \xB7 no run yet`;
  if (launch.status === "pending" || launch.status === "interrupted")
    return `Launch review ${launch.slug} \xB7 pending in Composer \xB7 nothing started`;
  return `Launch ${launch.slug} \xB7 ${launch.status} \xB7 ${launch.result ?? "nothing started; inspect the review"}`;
}
function managerActions(goal, actorSessionID, actorHasGoal) {
  const rows = [];
  if (goal.sessionID && goal.sessionState === "present")
    rows.push({ label: "Open goal session", description: "Deliberately jump after viewing these details", action: "jump" });
  if (goal.valid !== false && !goal.archived && goal.runId) {
    if (["running", "waiting", "verifying"].includes(goal.status))
      rows.push({ label: "Pause selected goal", description: "Stop only this goal's loop", action: "pause" });
    if (["paused", "blocked", "needs_review"].includes(goal.status))
      rows.push({ label: "Resume selected goal", description: "Continue this stopped run", action: "resume" });
    if (!terminal.has(goal.status) && goal.status !== "verifying")
      rows.push({ label: "Verify selected goal", description: "Run its declared host checks and verifier", action: "verify" });
    if (goal.attachable && !actorHasGoal && goal.sessionID !== actorSessionID)
      rows.push({ label: "Attach selected goal here", description: "Move its ownership; preserve history and progress", action: "attach" });
    if (!terminal.has(goal.status))
      rows.push({ label: "Abort selected goal", description: "Requires a native confirmation; preserves history", action: "abort" });
    else
      rows.push({ label: "Archive selected goal", description: "Requires a native confirmation; preserves history", action: "archive" });
  }
  rows.push({ label: "Back to all goals", description: "Collapse details without changing sessions", action: "back" });
  return rows;
}
function orderedGoals(goals, sessionID) {
  const here = (g) => !g.archived ? g.sessionID === sessionID ? 2 : g.handoff?.fromSessionID === sessionID || !g.runId && g.launch?.sessionID === sessionID ? 1 : 0 : 0;
  return [...goals].sort((a, b) => here(b) - here(a) || priorityWeight(b.priority) - priorityWeight(a.priority) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}
function sidebarCards(goals, sessionID, width = 40, maxLines = 12) {
  const active = orderedGoals(goals.filter((g) => !g.archived && !g.terminal && !terminal.has(g.status)), sessionID);
  const capacity = Math.max(1, Math.floor((maxLines - 2) / 5));
  const visible = active.slice(0, capacity);
  return {
    total: active.length,
    hidden: Math.max(0, active.length - visible.length),
    cards: visible.map((goal) => {
      const here = goal.sessionID === sessionID;
      const where = !goal.sessionID ? goal.launch?.sessionID === sessionID ? "author here" : "draft" : here ? "here" : "elsewhere";
      const tone = goal.status === "blocked" ? "error" : ["running", "waiting", "verifying"].includes(goal.status) ? "success" : "warning";
      const steps = goal.steps ?? [];
      const plan = steps.length ? `${steps.filter((s) => s.status === "done").length}/${steps.length} plan \xB7 ` : "";
      const handoffPointer = goal.handoff?.fromSessionID === sessionID && goal.sessionID ? `${fitColumns(goal.slug, Math.max(1, width - 17))} \xB7 ses\u2026${goal.sessionID.slice(-8)}` : undefined;
      return { key: goalKey(goal), goal, tone, title: fitColumns(goal.title, Math.max(1, width - 2)), description: fitColumns(`${goal.status}${goal.launch?.status === "executing" ? " \xB7 starting" : goal.launch?.status === "expired" ? " \xB7 review expired" : ""} \xB7 ${where}`, Math.max(1, width - 2)), progress: fitColumns(`${goal.handoff?.fromSessionID === sessionID ? "from here \xB7 " : ""}${plan}${goal.proven}/${goal.total} proven \xB7 ${goal.agent ?? "agent unknown"}`, width), handoffPointer: handoffPointer ? fitColumns(handoffPointer, width) : undefined };
    }),
    pointer: fitColumns(active.length > visible.length ? `+${active.length - visible.length} ${active.length - visible.length === 1 ? "goal" : "goals"} \u2014 F9 manager` : "F9 goals manager", width)
  };
}

// src/tui/navigation.ts
function openGoalSession(ui, sessionID) {
  try {
    if (ui.tabs?.enabled() && ui.tabs.open(sessionID) && ui.tabs.focus(sessionID))
      return "tab";
  } catch {}
  ui.router.navigate({ type: "session", sessionID });
  return "route";
}

// src/tui/pointer-select.ts
function pointerSelect(control, event, rowHeight) {
  if (event.button !== 0 || event.isDragging)
    return;
  const row = Math.floor((event.y - control.y) / rowHeight);
  const visible = Math.max(1, Math.floor(control.height / rowHeight));
  if (row < 0 || row >= visible || event.x < control.x || event.x >= control.x + control.width)
    return;
  const first = Math.max(0, Math.min(control.getSelectedIndex() - Math.floor(visible / 2), control.options.length - visible));
  const index = first + row;
  if (index >= control.options.length)
    return;
  event.stopPropagation();
  event.preventDefault();
  control.focus();
  control.setSelectedIndex(index);
  control.selectCurrent();
}

// src/tui/index.tsx
var SIDEBAR_WIDTH = 40;
var PANEL_NAME = "goal-dashboard";
var tui_default = {
  id: "opencode-goal",
  async setup(context) {
    const rpc = context.client.rpc(GoalRpc);
    const [views, setViews] = createStore({});
    const [launches, setLaunches] = createStore({});
    const currentLaunch = (sessionID) => [...launches[sessionID] ?? []].sort((a, b) => Number(b.status === "executing") - Number(a.status === "executing") || (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
    const [now, setNow] = createSignal(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    const requested = new Set;
    const [goalsList, setGoalsList] = createSignal([]);
    const [goalsState, setGoalsState] = createSignal("loading");
    const [selectedGoalKey, setSelectedGoalKey] = createSignal();
    const [selectedDetails, setSelectedDetails] = createSignal();
    const [managerNotice, setManagerNotice] = createSignal();
    let detailRequest = 0;
    let goalsFetchedAt = 0;
    let goalsRequested = false;
    let goalsInFlight = false;
    let goalsRefreshAgain = false;
    let goalsDirectory;
    let disposed = false;
    let focusManagerSection;
    const mountedPanels = new Map;
    const currentMountedPanel = () => {
      const route = context.ui.router.current();
      return route.type === "session" ? mountedPanels.get(route.sessionID) : undefined;
    };
    const locationOf = (sessionID) => (sessionID ? context.data.session.get(sessionID)?.location : undefined) ?? context.location ?? context.data.location?.default();
    const ensureGoals = async (force = false) => {
      goalsRequested = true;
      const route = context.ui.router.current();
      const location = locationOf(route.type === "session" ? route.sessionID : undefined);
      const directory = location?.directory;
      if (goalsDirectory !== directory) {
        goalsDirectory = directory;
        goalsFetchedAt = 0;
        setGoalsList([]);
        setGoalsState("loading");
        setSelectedGoalKey(undefined);
        setSelectedDetails(undefined);
      }
      if (goalsInFlight) {
        if (force)
          goalsRefreshAgain = true;
        return;
      }
      if (!force && Date.now() - goalsFetchedAt < 4000)
        return;
      goalsInFlight = true;
      goalsFetchedAt = Date.now();
      try {
        const listed = await rpc.list({}, location ? {
          location
        } : undefined);
        if (disposed || goalsDirectory !== directory)
          return;
        if (!Array.isArray(listed?.goals))
          throw new Error("Goal inventory missing");
        setGoalsList(listed.goals);
        setGoalsState("ready");
      } catch {
        if (!disposed && goalsDirectory === directory)
          setGoalsState("error");
      } finally {
        goalsInFlight = false;
        if (!disposed && goalsRefreshAgain) {
          goalsRefreshAgain = false;
          ensureGoals(true);
        }
      }
    };
    const STALE_MS = 4000;
    const fetchedAt = new Map;
    const fetchView = async (sessionID) => {
      fetchedAt.set(sessionID, Date.now());
      try {
        const location = locationOf(sessionID);
        const result = await rpc.snapshot({
          sessionID
        }, location ? {
          location
        } : undefined);
        setViews(sessionID, reconcile(result?.view ?? null));
        if (Array.isArray(result?.launches))
          setLaunches(sessionID, reconcile(result.launches));
      } catch {}
    };
    const ensure = (sessionID) => {
      if (requested.has(sessionID))
        return;
      requested.add(sessionID);
      fetchView(sessionID);
    };
    const offUpdated = rpc.events.on("updated", (event) => {
      const data = event.data ?? {}, {
        sessionID,
        view,
        launch
      } = data;
      if (typeof sessionID === "string") {
        if ("view" in data)
          setViews(sessionID, reconcile(view ?? null));
        if (launch && typeof launch.decisionId === "string")
          setLaunches(sessionID, reconcile([...(launches[sessionID] ?? []).filter((p) => p.decisionId !== launch.decisionId), launch]));
      }
      if (goalsRequested)
        ensureGoals(true);
    });
    const offNotice = rpc.events.on("notice", (event) => {
      const data = event.data ?? {};
      const current = context.ui.router.current();
      const here = current.type === "session" && current.sessionID === data.sessionID;
      if (data.panel && here) {
        const view = views[data.sessionID];
        context.ui.dialog.alert({
          title: "Goal",
          message: view ? statusText(view, Date.now()) : String(data.text)
        });
      } else {
        context.ui.toast.show({
          title: "Goal",
          message: String(data.text ?? ""),
          variant: data.level ?? "info",
          duration: data.level === "error" ? 8000 : 5000,
          ...data.sessionID ? {
            sessionID: data.sessionID
          } : {}
        });
      }
      if (data.attention)
        context.attention.notify({
          title: "Goal",
          message: String(data.text ?? ""),
          notification: {
            when: "blurred"
          },
          sound: {
            name: data.attention,
            when: "blurred"
          }
        });
    });
    const openDecisions = new Map;
    const pendingSummaries = new Map;
    const flushSummary = (sessionID) => {
      const queued = pendingSummaries.get(sessionID);
      pendingSummaries.delete(sessionID);
      if (!queued)
        return;
      context.ui.dialog.alert({
        title: `Goal summary \u2014 ${queued.status}`,
        message: dialogDigest(queued.headline, queued.text)
      });
    };
    const offSummary = rpc.events.on("summary", (event) => {
      const data = event.data ?? {};
      const current = context.ui.router.current();
      if (current.type !== "session" || current.sessionID !== data.sessionID) {
        context.ui.toast.show({
          title: "Goal summary",
          message: String(data.headline ?? data.text ?? ""),
          variant: "info",
          ...data.sessionID ? {
            sessionID: data.sessionID
          } : {}
        });
        return;
      }
      if (openDecisions.has(data.sessionID)) {
        pendingSummaries.set(data.sessionID, {
          headline: String(data.headline ?? "summary"),
          text: String(data.text ?? data.headline ?? ""),
          status: String(data.status ?? "")
        });
        context.ui.toast.show({
          title: "Goal summary queued",
          message: String(data.headline ?? "the full summary opens after the decision"),
          variant: "info",
          ...data.sessionID ? {
            sessionID: data.sessionID
          } : {}
        });
        return;
      }
      context.ui.dialog.alert({
        title: `Goal summary \u2014 ${data.status ?? ""}`,
        message: dialogDigest(String(data.headline ?? "summary"), String(data.text ?? data.headline ?? ""))
      });
    });
    const offData = context.data.listen(({
      details
    }) => {
      if (details?.type === "server.connected") {
        for (const id of requested)
          fetchView(id);
        if (goalsRequested)
          ensureGoals(true);
      }
    });
    const offHandoff = rpc.events.on("handoff", (event) => {
      const data = event.data ?? {};
      const route = context.ui.router.current();
      if (typeof data.toSessionID !== "string" || typeof data.fromSessionID !== "string")
        return;
      if (route.type === "session" && route.sessionID === data.fromSessionID)
        openGoalSession(context.ui, data.toSessionID);
      else
        context.ui.toast.show({
          title: "Goal running elsewhere",
          message: `${data.slug} is running in ${data.toSessionID}; original history is preserved.`,
          variant: "info"
        });
      ensureGoals(true);
    });
    const refreshIfStale = (sessionID) => {
      if (Date.now() - (fetchedAt.get(sessionID) ?? 0) <= STALE_MS)
        return;
      fetchedAt.set(sessionID, Date.now());
      fetchView(sessionID);
    };
    const ticker = setInterval(() => {
      for (const id of requested)
        refreshIfStale(id);
      if (goalsRequested)
        ensureGoals();
    }, STALE_MS);
    let panelFocusPending = false;
    const openPanel = () => {
      panelFocusPending = true;
      const id = currentSession();
      const v = id ? views[id] : undefined;
      const target = v ? cardAffordanceTab(v, now(), SIDEBAR_WIDTH) : undefined;
      if (target)
        setTab(target);
      context.ui.panel.open(PANEL_NAME);
    };
    const togglePanel = () => {
      const mounted = currentMountedPanel();
      if (mounted || context.ui.panel.current()?.name === PANEL_NAME) {
        if (mounted)
          mounted.close();
        else
          context.ui.panel.close();
      } else
        openPanel();
    };
    const [tab, setTab] = createSignal("now");
    const expandGoal = (goal) => {
      setManagerNotice(undefined);
      openPanel();
      setSelectedGoalKey(goalKey(goal));
      setSelectedDetails(goal);
      setTab("goals");
      ensureGoals(true);
      fetchDetails(goal);
    };
    const fetchDetails = async (goal) => {
      const ticket = ++detailRequest;
      const id = currentSession(), location = id ? locationOf(id) : undefined;
      try {
        const result = await rpc.details({
          key: goalKey(goal)
        }, location ? {
          location
        } : undefined);
        if (!disposed && ticket === detailRequest && selectedGoalKey() === goalKey(goal) && result?.goal)
          setSelectedDetails(result.goal);
      } catch {}
    };
    const selectedGoal = () => {
      const row = goalsList().find((g) => goalKey(g) === selectedGoalKey());
      const detail = selectedDetails();
      return row && detail && goalKey(detail) === goalKey(row) && detail.lock === row.lock && detail.sessionID === row.sessionID ? {
        ...detail,
        ...row,
        details: detail.details
      } : row;
    };
    const manageSelected = async (row) => {
      const goal = selectedGoal(), sessionID = currentSession();
      if (row.action === "back") {
        setSelectedGoalKey(undefined);
        setSelectedDetails(undefined);
        setManagerNotice(undefined);
        return;
      }
      if (!goal || !sessionID) {
        setManagerNotice({
          message: "The selected goal or active session is unavailable. Reopen the manager with F9.",
          tone: "warning"
        });
        return;
      }
      if (row.action === "jump") {
        if (!goal.sessionID || goal.sessionState !== "present") {
          setManagerNotice({
            message: "This goal's session is not available for navigation.",
            tone: "warning"
          });
          return;
        }
        try {
          if (goal.sessionID === sessionID) {
            const panel = currentMountedPanel();
            if (panel)
              panel.close();
            else
              context.ui.panel.close();
          } else
            openGoalSession(context.ui, goal.sessionID);
        } catch (error) {
          setManagerNotice({
            message: `Navigation unavailable: ${String(error)}`,
            tone: "warning"
          });
        }
        return;
      }
      const location = locationOf(sessionID);
      try {
        const result = await rpc.manage({
          sessionID,
          action: row.action,
          target: targetOf(goal)
        }, location ? {
          location
        } : undefined);
        setManagerNotice({
          message: String(result.message),
          tone: result.pending ? "muted" : result.ok ? "success" : "warning"
        });
        ensureGoals(true);
        if (!result.pending)
          fetchDetails(goal);
      } catch (error) {
        setManagerNotice({
          message: `Operation unavailable: ${String(error)}`,
          tone: "warning"
        });
      }
    };
    const color = (tone) => {
      const t = context.theme;
      if (tone === "base")
        return t.text.base;
      if (tone === "muted")
        return t.text.muted;
      return t.text.feedback?.[tone]?.base ?? t.text.base;
    };
    const disposers = [];
    disposers.push(context.ui.slot({
      append: "sidebar.content",
      render: (input) => {
        ensure(input.sessionID);
        refreshIfStale(input.sessionID);
        ensureGoals();
        const width = typeof input.width === "number" ? input.width : SIDEBAR_WIDTH;
        const model = () => sidebarCards(goalsList(), input.sessionID, width);
        return (() => {
          var _el$ = _$createElement("box"), _el$5 = _$createElement("select");
          _$insertNode(_el$, _el$5);
          _$setProp(_el$, "id", "goal-sidebar");
          _$setProp(_el$, "flexDirection", "column");
          _$setProp(_el$, "maxHeight", 12);
          _$insert(_el$, _$createComponent(Show, {
            get when() {
              return model().total;
            },
            get children() {
              return [(() => {
                var _el$2 = _$createElement("text"), _el$3 = _$createTextNode(`Goals (`), _el$4 = _$createTextNode(`)`);
                _$insertNode(_el$2, _el$3);
                _$insertNode(_el$2, _el$4);
                _$setProp(_el$2, "height", 1);
                _$setProp(_el$2, "flexShrink", 0);
                _$setProp(_el$2, "wrapMode", "none");
                _$setProp(_el$2, "truncate", true);
                _$insert(_el$2, () => model().total, _el$4);
                _$effect((_$p) => _$setProp(_el$2, "fg", color("base"), _$p));
                return _el$2;
              })(), _$createComponent(For, {
                get each() {
                  return model().cards.map((c) => c.key);
                },
                children: (key) => {
                  const card = () => model().cards.find((c) => c.key === key);
                  const expand = () => {
                    const current = card();
                    if (current)
                      expandGoal(current.goal);
                  };
                  return (() => {
                    var _el$6 = _$createElement("box"), _el$7 = _$createElement("select"), _el$8 = _$createElement("text");
                    _$insertNode(_el$6, _el$7);
                    _$insertNode(_el$6, _el$8);
                    _$setProp(_el$6, "flexDirection", "column");
                    _$setProp(_el$6, "marginTop", 1);
                    _$setProp(_el$6, "flexShrink", 0);
                    _$setProp(_el$7, "id", `goal-card:${key}`);
                    _$setProp(_el$7, "height", 2);
                    _$setProp(_el$7, "flexShrink", 0);
                    _$setProp(_el$7, "showDescription", true);
                    _$setProp(_el$7, "showSelectionIndicator", false);
                    _$setProp(_el$7, "onSelect", expand);
                    _$setProp(_el$7, "onMouseUp", expand);
                    _$setProp(_el$8, "height", 1);
                    _$setProp(_el$8, "flexShrink", 0);
                    _$setProp(_el$8, "wrapMode", "none");
                    _$setProp(_el$8, "truncate", true);
                    _$insert(_el$8, () => card()?.progress ?? "");
                    _$insert(_el$6, _$createComponent(Show, {
                      get when() {
                        return card()?.handoffPointer;
                      },
                      children: (pointer) => (() => {
                        var _el$9 = _$createElement("text");
                        _$setProp(_el$9, "id", `goal-handoff-pointer:${key}`);
                        _$setProp(_el$9, "height", 1);
                        _$setProp(_el$9, "flexShrink", 0);
                        _$setProp(_el$9, "wrapMode", "none");
                        _$setProp(_el$9, "truncate", true);
                        _$insert(_el$9, pointer);
                        _$effect((_$p) => _$setProp(_el$9, "fg", color("muted"), _$p));
                        return _el$9;
                      })()
                    }), null);
                    _$effect((_p$) => {
                      var _v$ = [{
                        name: card()?.title ?? "",
                        description: card()?.description ?? "",
                        value: key
                      }], _v$2 = color("base"), _v$3 = color(card()?.tone ?? "muted"), _v$4 = color("muted");
                      _v$ !== _p$.e && (_p$.e = _$setProp(_el$7, "options", _v$, _p$.e));
                      _v$2 !== _p$.t && (_p$.t = _$setProp(_el$7, "textColor", _v$2, _p$.t));
                      _v$3 !== _p$.a && (_p$.a = _$setProp(_el$7, "descriptionColor", _v$3, _p$.a));
                      _v$4 !== _p$.o && (_p$.o = _$setProp(_el$8, "fg", _v$4, _p$.o));
                      return _p$;
                    }, {
                      e: undefined,
                      t: undefined,
                      a: undefined,
                      o: undefined
                    });
                    return _el$6;
                  })();
                }
              })];
            }
          }), _el$5);
          _$setProp(_el$5, "id", "goal-sidebar-manager");
          _$setProp(_el$5, "height", 1);
          _$setProp(_el$5, "flexShrink", 0);
          _$setProp(_el$5, "showDescription", false);
          _$setProp(_el$5, "onSelect", () => {
            openPanel();
            setTab("goals");
            ensureGoals(true);
          });
          _$setProp(_el$5, "onMouseUp", () => {
            openPanel();
            setTab("goals");
            ensureGoals(true);
          });
          _$effect((_$p) => _$setProp(_el$5, "options", [{
            name: goalsState() === "error" ? "Retry goals \u2014 F9 manager" : model().pointer,
            description: "Open the project Goals manager",
            value: "manager"
          }], _$p));
          return _el$;
        })();
      }
    }));
    disposers.push(context.ui.slot({
      append: "prompt.footer.status",
      render: (input) => {
        if (input.sessionID)
          ensure(input.sessionID);
        return _$createComponent(Show, {
          get when() {
            return _$memo(() => !!input.sessionID)() ? views[input.sessionID] : undefined;
          },
          children: (view) => (() => {
            var _el$0 = _$createElement("text");
            _$insert(_el$0, () => pillText(view(), now()));
            _$effect((_$p) => _$setProp(_el$0, "fg", color(view().status === "running" ? "success" : "muted"), _$p));
            return _el$0;
          })()
        });
      }
    }));
    disposers.push(context.ui.slot({
      append: "session.composer.top",
      render: (input) => {
        ensure(input.sessionID);
        const tracer = () => {
          const view = views[input.sessionID];
          return view ? tracerLines(view, now(), 80) : [];
        };
        const banner = () => {
          const view = views[input.sessionID];
          return view ? bannerText(view) : undefined;
        };
        return (() => {
          var _el$1 = _$createElement("box");
          _$setProp(_el$1, "flexDirection", "column");
          _$setProp(_el$1, "paddingLeft", 1);
          _$setProp(_el$1, "paddingRight", 1);
          _$insert(_el$1, _$createComponent(Show, {
            get when() {
              return launchStatusText(currentLaunch(input.sessionID));
            },
            children: (line) => (() => {
              var _el$10 = _$createElement("text");
              _$setProp(_el$10, "id", "goal-launch-admission");
              _$setProp(_el$10, "wrapMode", "none");
              _$setProp(_el$10, "truncate", true);
              _$insert(_el$10, line);
              _$effect((_$p) => _$setProp(_el$10, "fg", color(currentLaunch(input.sessionID)?.status === "executing" ? "muted" : "warning"), _$p));
              return _el$10;
            })()
          }), null);
          _$insert(_el$1, _$createComponent(For, {
            get each() {
              return tracer();
            },
            children: (line) => (() => {
              var _el$11 = _$createElement("text");
              _$setProp(_el$11, "wrapMode", "none");
              _$setProp(_el$11, "truncate", true);
              _$insert(_el$11, () => line.text);
              _$effect((_$p) => _$setProp(_el$11, "fg", color(line.tone), _$p));
              return _el$11;
            })()
          }), null);
          _$insert(_el$1, _$createComponent(Show, {
            get when() {
              return banner();
            },
            children: (b) => (() => {
              var _el$12 = _$createElement("text");
              _$setProp(_el$12, "wrapMode", "none");
              _$setProp(_el$12, "truncate", true);
              _$insert(_el$12, () => b().text);
              _$effect((_$p) => _$setProp(_el$12, "fg", color(b().tone), _$p));
              return _el$12;
            })()
          }), null);
          return _el$1;
        })();
      }
    }));
    disposers.push(context.ui.slot({
      append: "session.panel",
      render: (input) => {
        if (input.name !== PANEL_NAME)
          return null;
        const mount = {
          close: () => {
            if (typeof input.close === "function")
              input.close();
            else
              context.ui.panel.close();
          }
        };
        mountedPanels.set(input.sessionID, mount);
        onCleanup(() => {
          if (mountedPanels.get(input.sessionID) === mount)
            mountedPanels.delete(input.sessionID);
        });
        ensure(input.sessionID);
        ensureGoals();
        const view = () => views[input.sessionID];
        if (!view() && !selectedGoalKey())
          setTab("goals");
        const width = () => typeof input.width === "number" ? input.width : 46;
        if (input.name === PANEL_NAME && panelFocusPending && typeof input.focus === "function") {
          panelFocusPending = false;
          try {
            input.focus();
          } catch {}
        }
        const rows = () => view() && tab() === "decisions" ? [...decisionRows(view()), ...quickActRows(view())] : [];
        const managerRows = () => orderedGoals(goalsList(), input.sessionID);
        const actions = () => {
          const g = selectedGoal();
          return g ? managerActions(g, input.sessionID, !!view() && !["complete", "failed", "aborted", "superseded"].includes(view().status)) : [];
        };
        const focusControl = (control) => {
          const scheduled = setTimeout(() => {
            try {
              input.focus?.();
              control.focus();
            } catch {}
          }, 0);
          onCleanup(() => clearTimeout(scheduled));
        };
        let managerControl, actionsControl, detailsControl, closeControl, lastFocusedControl;
        let resizeFocusTimer;
        onCleanup(() => clearTimeout(resizeFocusTimer));
        const rememberFocus = (control) => {
          control.on?.("focused", () => {
            lastFocusedControl = control;
          });
        };
        const restoreAfterResize = () => {
          if (tab() !== "goals" || mountedPanels.get(input.sessionID) !== mount || !lastFocusedControl)
            return;
          const route = context.ui.router.current();
          if (route.type !== "session" || route.sessionID !== input.sessionID)
            return;
          clearTimeout(resizeFocusTimer);
          resizeFocusTimer = setTimeout(() => {
            if (mountedPanels.get(input.sessionID) !== mount || (context.data.session.form?.list(input.sessionID, locationOf(input.sessionID))?.length ?? 0) > 0)
              return;
            input.focus?.();
            lastFocusedControl?.focus();
          }, 0);
        };
        context.renderer?.on?.("resize", restoreAfterResize);
        onCleanup(() => context.renderer?.off?.("resize", restoreAfterResize));
        createEffect(() => {
          if (input.focused === true && tab() === "goals")
            untrack(() => focusControl(selectedGoal() ? actionsControl : managerControl));
        });
        const cycleSection = () => {
          const controls = [managerControl, detailsControl, actionsControl, closeControl].filter((c) => c && c.visible !== false);
          if (!controls.length)
            return;
          const at = controls.findIndex((c) => c.focused);
          input.focus?.();
          controls[(at + 1) % controls.length].focus();
        };
        focusManagerSection = cycleSection;
        onCleanup(() => {
          if (focusManagerSection === cycleSection)
            focusManagerSection = undefined;
        });
        return _$createComponent(Show, {
          get when() {
            return tab() !== "goals";
          },
          get fallback() {
            return (() => {
              var _el$13 = _$createElement("box"), _el$14 = _$createElement("text"), _el$15 = _$createElement("b"), _el$17 = _$createElement("select"), _el$18 = _$createElement("text");
              _$insertNode(_el$13, _el$14);
              _$insertNode(_el$13, _el$17);
              _$insertNode(_el$13, _el$18);
              _$setProp(_el$13, "id", "goal-manager");
              _$setProp(_el$13, "flexDirection", "column");
              _$setProp(_el$13, "paddingLeft", 1);
              _$setProp(_el$13, "paddingRight", 1);
              _$setProp(_el$13, "height", "100%");
              _$setProp(_el$13, "minHeight", 0);
              _$setProp(_el$13, "overflow", "hidden");
              _$insertNode(_el$14, _el$15);
              _$setProp(_el$14, "height", 1);
              _$setProp(_el$14, "flexShrink", 0);
              _$setProp(_el$14, "wrapMode", "none");
              _$setProp(_el$14, "truncate", true);
              _$insertNode(_el$15, _$createTextNode(`Goals manager \xB7 this project`));
              _$use((control) => {
                closeControl = control;
                rememberFocus(control);
              }, _el$17);
              _$setProp(_el$17, "id", "goal-manager-close");
              _$setProp(_el$17, "height", 1);
              _$setProp(_el$17, "flexShrink", 0);
              _$setProp(_el$17, "options", [{
                name: "Close manager \xB7 F9: return to sidebar",
                description: "Return to this session's basic sidebar without changing the goal",
                value: "close"
              }]);
              _$setProp(_el$17, "showDescription", false);
              _$setProp(_el$17, "onSelect", () => {
                if (typeof input.close === "function")
                  input.close();
                else
                  context.ui.panel.close();
              });
              _$setProp(_el$17, "onMouseUp", () => {
                if (typeof input.close === "function")
                  input.close();
                else
                  context.ui.panel.close();
              });
              _$setProp(_el$18, "height", 1);
              _$setProp(_el$18, "flexShrink", 0);
              _$setProp(_el$18, "wrapMode", "none");
              _$setProp(_el$18, "truncate", true);
              _$insert(_el$18, () => fitColumns("Tab: focus \xB7 \u2191\u2193: select \xB7 Enter: activate", width() - 2));
              _$insert(_el$13, _$createComponent(Show, {
                get when() {
                  return goalsState() === "loading";
                },
                get children() {
                  var _el$19 = _$createElement("text");
                  _$insertNode(_el$19, _$createTextNode(`Loading project goals\u2026`));
                  _$effect((_$p) => _$setProp(_el$19, "fg", color("muted"), _$p));
                  return _el$19;
                }
              }), null);
              _$insert(_el$13, _$createComponent(Show, {
                get when() {
                  return goalsState() === "error";
                },
                get children() {
                  var _el$21 = _$createElement("text");
                  _$insertNode(_el$21, _$createTextNode(`Inventory unavailable; F9 retries.`));
                  _$effect((_$p) => _$setProp(_el$21, "fg", color("error"), _$p));
                  return _el$21;
                }
              }), null);
              _$insert(_el$13, _$createComponent(Show, {
                get when() {
                  return managerRows().length;
                },
                get fallback() {
                  return _$createComponent(Show, {
                    get when() {
                      return goalsState() === "ready";
                    },
                    get children() {
                      var _el$24 = _$createElement("text");
                      _$insertNode(_el$24, _$createTextNode(`No goals \u2014 /goal starts the interview.`));
                      _$effect((_$p) => _$setProp(_el$24, "fg", color("muted"), _$p));
                      return _el$24;
                    }
                  });
                },
                get children() {
                  var _el$23 = _$createElement("select");
                  _$use((control) => {
                    managerControl = control;
                    rememberFocus(control);
                    if (!selectedGoal())
                      focusControl(control);
                  }, _el$23);
                  _$setProp(_el$23, "id", "goal-manager-list");
                  _$setProp(_el$23, "flexShrink", 0);
                  _$setProp(_el$23, "showDescription", true);
                  _$setProp(_el$23, "onMouseDown", (event) => {
                    event.stopPropagation();
                    event.preventDefault();
                  });
                  _$setProp(_el$23, "onMouseUp", (event) => {
                    input.focus?.();
                    pointerSelect(managerControl, event, 2);
                  });
                  _$setProp(_el$23, "onSelect", (_index, option) => {
                    const goal = managerRows().find((g) => goalKey(g) === option?.value);
                    if (goal) {
                      setSelectedGoalKey(goalKey(goal));
                      setSelectedDetails(goal);
                      fetchDetails(goal);
                    }
                  });
                  _$effect((_p$) => {
                    var _v$5 = selectedGoal() ? 2 : Math.min(8, Math.max(2, managerRows().length * 2)), _v$6 = managerRows().map((g) => ({
                      name: fitColumns(`${g.title}${g.archived ? " [archived]" : ""}`, width() - 4),
                      description: fitColumns(`${g.status}${g.launch?.status === "executing" ? " \xB7 starting" : g.launch?.status === "expired" ? " \xB7 review expired" : ""} \xB7 ${g.proven}/${g.total} proven`, width() - 4),
                      value: goalKey(g)
                    })), _v$7 = !selectedGoal();
                    _v$5 !== _p$.e && (_p$.e = _$setProp(_el$23, "height", _v$5, _p$.e));
                    _v$6 !== _p$.t && (_p$.t = _$setProp(_el$23, "options", _v$6, _p$.t));
                    _v$7 !== _p$.a && (_p$.a = _$setProp(_el$23, "focused", _v$7, _p$.a));
                    return _p$;
                  }, {
                    e: undefined,
                    t: undefined,
                    a: undefined
                  });
                  return _el$23;
                }
              }), null);
              _$insert(_el$13, _$createComponent(Show, {
                get when() {
                  return selectedGoal();
                },
                children: (goal) => (() => {
                  var _el$26 = _$createElement("box"), _el$27 = _$createElement("text"), _el$28 = _$createElement("text"), _el$30 = _$createElement("text"), _el$32 = _$createElement("scrollbox"), _el$33 = _$createElement("text"), _el$34 = _$createElement("b"), _el$36 = _$createElement("text"), _el$37 = _$createElement("text"), _el$38 = _$createElement("text"), _el$42 = _$createElement("text"), _el$43 = _$createElement("b"), _el$45 = _$createElement("select");
                  _$insertNode(_el$26, _el$27);
                  _$insertNode(_el$26, _el$28);
                  _$insertNode(_el$26, _el$30);
                  _$insertNode(_el$26, _el$32);
                  _$insertNode(_el$26, _el$42);
                  _$insertNode(_el$26, _el$45);
                  _$setProp(_el$26, "id", "goal-manager-details");
                  _$setProp(_el$26, "flexDirection", "column");
                  _$setProp(_el$26, "flexGrow", 1);
                  _$setProp(_el$26, "flexShrink", 1);
                  _$setProp(_el$26, "minHeight", 0);
                  _$setProp(_el$26, "marginTop", 1);
                  _$setProp(_el$27, "height", 1);
                  _$setProp(_el$27, "flexShrink", 0);
                  _$setProp(_el$27, "wrapMode", "none");
                  _$setProp(_el$27, "truncate", true);
                  _$insert(_el$27, () => fitColumns(`${goal().status} \xB7 ${goal().proven}/${goal().total} host-proven \xB7 ${goal().agent ?? "agent unknown"}`, width() - 2));
                  _$setProp(_el$28, "height", 1);
                  _$setProp(_el$28, "flexShrink", 0);
                  _$setProp(_el$28, "wrapMode", "none");
                  _$setProp(_el$28, "truncate", true);
                  _$insert(_el$28, () => fitColumns(`Session: ${goal().sessionTitle ?? goal().sessionID ?? "unassigned"}`, width() - 2));
                  _$insert(_el$26, _$createComponent(Show, {
                    get when() {
                      return managerNotice();
                    },
                    children: (notice) => (() => {
                      var _el$46 = _$createElement("text");
                      _$setProp(_el$46, "id", "goal-manager-feedback");
                      _$setProp(_el$46, "height", 1);
                      _$setProp(_el$46, "flexShrink", 0);
                      _$setProp(_el$46, "wrapMode", "none");
                      _$setProp(_el$46, "truncate", true);
                      _$insert(_el$46, () => fitColumns(notice().message, width() - 2));
                      _$effect((_$p) => _$setProp(_el$46, "fg", color(notice().tone), _$p));
                      return _el$46;
                    })()
                  }), _el$30);
                  _$insert(_el$26, _$createComponent(Show, {
                    get when() {
                      return goal().steps?.length;
                    },
                    get children() {
                      var _el$29 = _$createElement("text");
                      _$setProp(_el$29, "height", 1);
                      _$setProp(_el$29, "flexShrink", 0);
                      _$setProp(_el$29, "wrapMode", "none");
                      _$setProp(_el$29, "truncate", true);
                      _$insert(_el$29, () => fitColumns(`Plan: ${goal().steps?.filter((s) => s.status === "done").length}/${goal().steps?.length} done \xB7 ${goal().steps?.find((s) => s.status === "active")?.title ?? "no active step"}`, width() - 2));
                      _$effect((_$p) => _$setProp(_el$29, "fg", color("muted"), _$p));
                      return _el$29;
                    }
                  }), _el$30);
                  _$insertNode(_el$30, _$createTextNode(`Details \xB7 Tab to focus \xB7 wheel/PgUp/PgDn scroll`));
                  _$setProp(_el$30, "height", 1);
                  _$setProp(_el$30, "flexShrink", 0);
                  _$setProp(_el$30, "wrapMode", "none");
                  _$setProp(_el$30, "truncate", true);
                  _$insertNode(_el$32, _el$33);
                  _$insertNode(_el$32, _el$36);
                  _$insertNode(_el$32, _el$37);
                  _$insertNode(_el$32, _el$38);
                  _$use((control) => {
                    detailsControl = control;
                    rememberFocus(control);
                  }, _el$32);
                  _$setProp(_el$32, "id", "goal-manager-detail-text");
                  _$setProp(_el$32, "flexGrow", 1);
                  _$setProp(_el$32, "flexShrink", 1);
                  _$setProp(_el$32, "minHeight", 1);
                  _$setProp(_el$32, "scrollX", false);
                  _$setProp(_el$32, "scrollY", true);
                  _$setProp(_el$32, "viewportOptions", {
                    overflow: "hidden"
                  });
                  _$setProp(_el$32, "contentOptions", {
                    flexDirection: "column"
                  });
                  _$setProp(_el$32, "onMouseDown", () => {
                    input.focus?.();
                    detailsControl?.focus();
                  });
                  _$insertNode(_el$33, _el$34);
                  _$insertNode(_el$34, _$createTextNode(`Outcome`));
                  _$setProp(_el$36, "wrapMode", "word");
                  _$insert(_el$36, () => `Goal: ${goal().slug}`);
                  _$setProp(_el$37, "wrapMode", "word");
                  _$insert(_el$37, () => goal().outcome ?? goal().title);
                  _$setProp(_el$38, "wrapMode", "word");
                  _$insert(_el$38, () => `Session ID: ${goal().sessionID ?? "unassigned"}`);
                  _$insert(_el$32, _$createComponent(Show, {
                    get when() {
                      return launchStatusText(goal().launch);
                    },
                    children: (line) => (() => {
                      var _el$47 = _$createElement("text");
                      _$setProp(_el$47, "wrapMode", "word");
                      _$insert(_el$47, line);
                      _$effect((_$p) => _$setProp(_el$47, "fg", color("warning"), _$p));
                      return _el$47;
                    })()
                  }), null);
                  _$insert(_el$32, _$createComponent(Show, {
                    get when() {
                      return goal().details?.criteria?.length;
                    },
                    get children() {
                      var _el$39 = _$createElement("text"), _el$40 = _$createElement("b");
                      _$insertNode(_el$39, _el$40);
                      _$insertNode(_el$40, _$createTextNode(`Evidence`));
                      _$effect((_$p) => _$setProp(_el$39, "fg", color("base"), _$p));
                      return _el$39;
                    }
                  }), null);
                  _$insert(_el$32, _$createComponent(For, {
                    get each() {
                      return goal().details?.criteria ?? [];
                    },
                    children: (criterion) => (() => {
                      var _el$48 = _$createElement("text");
                      _$setProp(_el$48, "wrapMode", "word");
                      _$insert(_el$48, () => `${criterion.id} [${criterion.status}] ${criterion.statement}${criterion.by ? ` (${criterion.by})` : ""}`);
                      _$effect((_$p) => _$setProp(_el$48, "fg", color(criterion.status === "fail" ? "error" : "muted"), _$p));
                      return _el$48;
                    })()
                  }), null);
                  _$insert(_el$32, _$createComponent(For, {
                    get each() {
                      return goal().issues ?? [];
                    },
                    children: (issue) => (() => {
                      var _el$49 = _$createElement("text");
                      _$setProp(_el$49, "wrapMode", "word");
                      _$insert(_el$49, issue);
                      _$effect((_$p) => _$setProp(_el$49, "fg", color("error"), _$p));
                      return _el$49;
                    })()
                  }), null);
                  _$insertNode(_el$42, _el$43);
                  _$setProp(_el$42, "height", 1);
                  _$setProp(_el$42, "flexShrink", 0);
                  _$insertNode(_el$43, _$createTextNode(`Actions \xB7 \u2191\u2193 and Enter, or click`));
                  _$use((control) => {
                    actionsControl = control;
                    rememberFocus(control);
                    focusControl(control);
                  }, _el$45);
                  _$setProp(_el$45, "id", "goal-manager-actions");
                  _$setProp(_el$45, "flexShrink", 0);
                  _$setProp(_el$45, "showDescription", false);
                  _$setProp(_el$45, "focused", true);
                  _$setProp(_el$45, "onMouseDown", (event) => {
                    event.stopPropagation();
                    event.preventDefault();
                  });
                  _$setProp(_el$45, "onMouseUp", (event) => {
                    input.focus?.();
                    pointerSelect(actionsControl, event, 1);
                  });
                  _$setProp(_el$45, "onSelect", (_index, option) => {
                    if (option?.value)
                      manageSelected(option.value);
                  });
                  _$effect((_p$) => {
                    var _v$0 = color("base"), _v$1 = color("muted"), _v$10 = color("muted"), _v$11 = color("base"), _v$12 = color("muted"), _v$13 = color("base"), _v$14 = color("muted"), _v$15 = color("base"), _v$16 = Math.min(8, actions().length), _v$17 = actions().map((r) => ({
                      name: r.label,
                      description: r.description,
                      value: r
                    }));
                    _v$0 !== _p$.e && (_p$.e = _$setProp(_el$27, "fg", _v$0, _p$.e));
                    _v$1 !== _p$.t && (_p$.t = _$setProp(_el$28, "fg", _v$1, _p$.t));
                    _v$10 !== _p$.a && (_p$.a = _$setProp(_el$30, "fg", _v$10, _p$.a));
                    _v$11 !== _p$.o && (_p$.o = _$setProp(_el$33, "fg", _v$11, _p$.o));
                    _v$12 !== _p$.i && (_p$.i = _$setProp(_el$36, "fg", _v$12, _p$.i));
                    _v$13 !== _p$.n && (_p$.n = _$setProp(_el$37, "fg", _v$13, _p$.n));
                    _v$14 !== _p$.s && (_p$.s = _$setProp(_el$38, "fg", _v$14, _p$.s));
                    _v$15 !== _p$.h && (_p$.h = _$setProp(_el$42, "fg", _v$15, _p$.h));
                    _v$16 !== _p$.r && (_p$.r = _$setProp(_el$45, "height", _v$16, _p$.r));
                    _v$17 !== _p$.d && (_p$.d = _$setProp(_el$45, "options", _v$17, _p$.d));
                    return _p$;
                  }, {
                    e: undefined,
                    t: undefined,
                    a: undefined,
                    o: undefined,
                    i: undefined,
                    n: undefined,
                    s: undefined,
                    h: undefined,
                    r: undefined,
                    d: undefined
                  });
                  return _el$26;
                })()
              }), null);
              _$effect((_p$) => {
                var _v$8 = color("base"), _v$9 = color("muted");
                _v$8 !== _p$.e && (_p$.e = _$setProp(_el$14, "fg", _v$8, _p$.e));
                _v$9 !== _p$.t && (_p$.t = _$setProp(_el$18, "fg", _v$9, _p$.t));
                return _p$;
              }, {
                e: undefined,
                t: undefined
              });
              return _el$13;
            })();
          },
          get children() {
            return _$createComponent(Show, {
              get when() {
                return view();
              },
              children: (v) => (() => {
                var _el$50 = _$createElement("box");
                _$setProp(_el$50, "flexDirection", "column");
                _$setProp(_el$50, "paddingLeft", 1);
                _$setProp(_el$50, "paddingRight", 1);
                _$insert(_el$50, _$createComponent(For, {
                  get each() {
                    return dashboardLines(v(), tab(), now(), width(), goalsList());
                  },
                  children: (line) => (() => {
                    var _el$52 = _$createElement("text");
                    _$setProp(_el$52, "wrapMode", "none");
                    _$setProp(_el$52, "truncate", true);
                    _$insert(_el$52, (() => {
                      var _c$ = _$memo(() => !!line.bold);
                      return () => _c$() ? (() => {
                        var _el$53 = _$createElement("b");
                        _$insert(_el$53, () => line.text);
                        return _el$53;
                      })() : line.text;
                    })());
                    _$effect((_$p) => _$setProp(_el$52, "fg", color(line.tone), _$p));
                    return _el$52;
                  })()
                }), null);
                _$insert(_el$50, _$createComponent(Show, {
                  get when() {
                    return rows().length;
                  },
                  get children() {
                    var _el$51 = _$createElement("select");
                    _$setProp(_el$51, "showDescription", true);
                    _$setProp(_el$51, "focused", true);
                    _$setProp(_el$51, "onSelect", (_index, option) => {
                      const row = option?.value;
                      if (row?.act)
                        act(row.act, row.arg);
                      else
                        context.ui.toast.show({
                          title: "Goal",
                          message: `Run: ${row?.description ?? row?.label ?? ""}`,
                          variant: "info"
                        });
                    });
                    _$effect((_$p) => _$setProp(_el$51, "options", rows().map((r) => ({
                      name: r.label,
                      description: r.description,
                      value: r
                    })), _$p));
                    return _el$51;
                  }
                }), null);
                return _el$50;
              })()
            });
          }
        });
      }
    }));
    const currentSession = () => {
      const route = context.ui.router.current();
      return route.type === "session" ? route.sessionID : undefined;
    };
    const act = async (action, arg, decision) => {
      const sessionID = decision?.sessionID ?? currentSession();
      if (!sessionID)
        return;
      const location = locationOf(sessionID);
      try {
        const result = await rpc.act({
          sessionID,
          action,
          ...arg ? {
            arg
          } : {},
          ...decision ? {
            decisionId: decision.decisionId
          } : {}
        }, location ? {
          location
        } : undefined);
        context.ui.toast.show({
          title: "Goal",
          message: result.message,
          variant: result.ok ? "success" : "warning"
        });
      } catch (error) {
        context.ui.toast.show({
          title: "Goal",
          message: `Goal plugin unavailable: ${String(error)}`,
          variant: "error"
        });
      }
    };
    const hasGoal = () => {
      const id = currentSession();
      return !!(id && views[id]);
    };
    const openDecisionIdentity = new Map;
    const offDecision = rpc.events.on("decision", (event) => {
      const data = event.data ?? {};
      const choices = data.choices ?? [];
      const route = context.ui.router.current();
      if (choices.some((c) => c.act) && route.type === "session" && route.sessionID === data.sessionID) {
        const mounted = mountedPanels.get(data.sessionID);
        if (mounted)
          mounted.close();
        else if (context.ui.panel?.current?.()?.name === PANEL_NAME)
          context.ui.panel.close();
      }
      if (typeof data.sessionID === "string" && typeof data.decisionId === "string" && choices.some((c) => c.act)) {
        openDecisions.set(data.sessionID, 1);
        openDecisionIdentity.set(data.sessionID, data.decisionId);
      }
      context.ui.toast.show({
        title: "Goal decision",
        message: choices.some((c) => c.act) ? "Owner decision pending in this session's Composer. No operation executed." : String(data.message ?? "Goal guidance is available in the manager."),
        variant: "info",
        ...data.sessionID ? {
          sessionID: data.sessionID
        } : {}
      });
    });
    const offResolved = rpc.events.on("decision.resolved", (event) => {
      const data = event.data ?? {};
      if (data.message)
        context.ui.toast.show({
          title: "Goal decision",
          message: data.message,
          variant: "success"
        });
      if (openDecisionIdentity.get(data.sessionID) !== data.decisionId)
        return;
      openDecisions.delete(data.sessionID);
      openDecisionIdentity.delete(data.sessionID);
      flushSummary(data.sessionID);
    });
    const offFailed = rpc.events.on("decision.failed", (event) => {
      const data = event.data ?? {};
      context.ui.toast.show({
        title: "Goal decision",
        message: String(data.message ?? "Owner operation did not execute; inspect the goal and request a new review."),
        variant: "warning",
        duration: 8000
      });
      if (openDecisionIdentity.get(data.sessionID) === data.decisionId) {
        openDecisions.delete(data.sessionID);
        openDecisionIdentity.delete(data.sessionID);
        flushSummary(data.sessionID);
      }
    });
    disposers.push(context.ui.slot({
      append: "app",
      render: () => {
        context.keymap.layer(() => ({
          mode: "global",
          commands: [{
            id: "goal.attach",
            title: "Goal: manage or attach a project goal",
            group: "Goal",
            palette: true,
            enabled: () => true,
            run: () => {
              setTab("goals");
              openPanel();
            }
          }, {
            id: "goal.panel",
            title: "Goal: toggle dashboard",
            group: "Goal",
            palette: true,
            bind: "f9",
            enabled: () => true,
            run: () => togglePanel()
          }, {
            id: "goal.dashboard.tab",
            title: "Goal: next dashboard tab",
            group: "Goal",
            palette: true,
            bind: "tab",
            enabled: () => hasGoal() || !!currentMountedPanel() || context.ui.panel.current()?.name === PANEL_NAME,
            run: () => {
              if (tab() === "goals" && (currentMountedPanel() || context.ui.panel.current()?.name === PANEL_NAME) && focusManagerSection) {
                focusManagerSection();
                return;
              }
              const order = DASHBOARD_TABS;
              setTab(order[(order.indexOf(tab()) + 1) % order.length]);
            }
          }, {
            id: "goal.status",
            title: "Goal: show status",
            group: "Goal",
            palette: true,
            enabled: hasGoal,
            run: () => {
              const view = views[currentSession()];
              if (view)
                context.ui.dialog.alert({
                  title: "Goal",
                  message: statusText(view, Date.now())
                });
            }
          }, {
            id: "goal.pause",
            title: "Goal: pause",
            group: "Goal",
            palette: true,
            enabled: hasGoal,
            run: () => act("pause")
          }, {
            id: "goal.resume",
            title: "Goal: resume",
            group: "Goal",
            palette: true,
            enabled: hasGoal,
            run: () => act("resume")
          }, {
            id: "goal.verify",
            title: "Goal: verify now",
            group: "Goal",
            palette: true,
            enabled: hasGoal,
            run: () => act("verify")
          }, {
            id: "goal.approve",
            title: "Goal: open native review in Composer",
            group: "Goal",
            palette: true,
            enabled: () => !!currentSession(),
            run: async () => {
              const sessionID = currentSession();
              if (!sessionID)
                return;
              const location = locationOf(sessionID);
              try {
                const result = await rpc.review({
                  sessionID
                }, location ? {
                  location
                } : undefined);
                context.ui.toast.show({
                  title: "Goal review",
                  message: result.message,
                  variant: result.ok ? "info" : "warning"
                });
              } catch (error) {
                context.ui.toast.show({
                  title: "Goal review",
                  message: String(error),
                  variant: "warning"
                });
              }
            }
          }, {
            id: "goal.abort",
            title: "Goal: abort",
            group: "Goal",
            palette: true,
            enabled: hasGoal,
            run: async () => {
              const sessionID = currentSession();
              if (!sessionID)
                return;
              const location = locationOf(sessionID);
              try {
                const listed = await rpc.list({}, location ? {
                  location
                } : undefined);
                const goal = listed?.goals?.find((g) => g.sessionID === sessionID && g.runId === views[sessionID]?.runId && !g.archived);
                if (!goal) {
                  context.ui.toast.show({
                    title: "Goal",
                    message: "Current target changed; inspect its details before aborting.",
                    variant: "warning"
                  });
                  return;
                }
                const result = await rpc.manage({
                  sessionID,
                  action: "abort",
                  target: targetOf(goal)
                }, location ? {
                  location
                } : undefined);
                context.ui.toast.show({
                  title: "Goal",
                  message: result.message,
                  variant: result.ok ? "info" : "warning"
                });
              } catch (error) {
                context.ui.toast.show({
                  title: "Goal",
                  message: String(error),
                  variant: "warning"
                });
              }
            }
          }]
        }));
        return null;
      }
    }));
    return () => {
      disposed = true;
      offHandoff();
      clearInterval(timer);
      clearInterval(ticker);
      offUpdated?.();
      offNotice?.();
      offSummary?.();
      offDecision?.();
      offResolved?.();
      offFailed?.();
      offData?.();
      for (const dispose of disposers.splice(0))
        dispose();
    };
  }
};
export {
  tui_default as default
};
