/** @jsxImportSource @opentui/solid */
// TUI plugin: a live goal card in the sidebar, a status pill under the prompt,
// a banner when the owner is needed, notices as toasts and desktop attention,
// and palette commands. Fed only by the server's GoalRpc (S6), never by files.
import type { Plugin } from "@opencode/plugin/tui"
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { GoalRpc, type GoalSummary, type GoalView } from "../rpc"
import { bannerText, pillText, statusText, type Tone } from "./format"
import { tracerLines } from "./tracer"
import { cardAffordanceTab, dashboardLines, decisionRows, dialogDigest, DASHBOARD_TABS, quickActRows, type DashboardTab } from "./dashboard"
import { fitColumns, goalKey, managerActions, orderedGoals, sidebarCards, targetOf, wrapColumns, type ManagerAction } from "./manager"
import { openGoalSession } from "./navigation"
import { decisionFormAnswer } from "./decision-form"
import { pointerSelect } from "./pointer-select"

type Context = Plugin.Context

const SIDEBAR_WIDTH = 40
/** The name this plugin opens and renders in the session.panel slot. */
const PANEL_NAME = "goal-dashboard"

export default {
  id: "opencode-goal",
  async setup(context: Context) {
    const rpc = context.client.rpc(GoalRpc as any) as any
    const [views, setViews] = createStore<Record<string, GoalView | null>>({})
    const [now, setNow] = createSignal(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    const requested = new Set<string>()
    const [goalsList, setGoalsList] = createSignal<GoalSummary[]>([])
    const [goalsState, setGoalsState] = createSignal<"loading" | "ready" | "error">("loading")
    const [selectedGoalKey, setSelectedGoalKey] = createSignal<string>()
    const [selectedDetails, setSelectedDetails] = createSignal<GoalSummary>()
    let detailRequest = 0
    let goalsFetchedAt = 0
    let goalsRequested = false
    let goalsInFlight = false
    let goalsRefreshAgain = false
    let goalsDirectory: string | undefined
    let disposed = false

    const locationOf = (sessionID?: string) => (sessionID ? (context.data.session.get(sessionID) as any)?.location : undefined) ?? context.location ?? context.data.location?.default()
    const ensureGoals = async (force = false) => {
      goalsRequested = true
      const route = context.ui.router.current()
      const location = locationOf(route.type === "session" ? route.sessionID : undefined)
      const directory = location?.directory
      if (goalsDirectory !== directory) {
        goalsDirectory = directory
        goalsFetchedAt = 0
        setGoalsList([])
        setGoalsState("loading")
        setSelectedGoalKey(undefined)
        setSelectedDetails(undefined)
      }
      if (goalsInFlight) { if (force) goalsRefreshAgain = true; return }
      if (!force && Date.now() - goalsFetchedAt < 4000) return
      goalsInFlight = true
      goalsFetchedAt = Date.now()
      try {
        const listed = await rpc.list({}, location ? { location } : undefined)
        if (disposed || goalsDirectory !== directory) return
        if (!Array.isArray(listed?.goals)) throw new Error("Goal inventory missing")
        setGoalsList(listed.goals as GoalSummary[])
        setGoalsState("ready")
      } catch {
        if (!disposed && goalsDirectory === directory) setGoalsState("error")
      } finally {
        goalsInFlight = false
        if (!disposed && goalsRefreshAgain) { goalsRefreshAgain = false; void ensureGoals(true) }
      }
    }
    // T058: events are the fast path, not the only path. A subscription that
    // attaches before the plugin registers, a dropped stream, or a reconnect
    // must never freeze the dashboard at its first snapshot (the live defect:
    // stuck on S1, 0/N criteria for a whole run). Renders and a periodic
    // ticker re-fetch snapshots that went stale, so the view converges.
    const STALE_MS = 4000
    const fetchedAt = new Map<string, number>()
    const fetchView = async (sessionID: string) => {
      fetchedAt.set(sessionID, Date.now())
      try {
        const location = locationOf(sessionID)
        const result = await rpc.snapshot({ sessionID }, location ? { location } : undefined)
        setViews(sessionID, reconcile((result?.view ?? null) as GoalView | null))
      } catch {
        // the server plugin may not be loaded for this location; show nothing
      }
    }
    const ensure = (sessionID: string) => {
      if (requested.has(sessionID)) return
      requested.add(sessionID)
      void fetchView(sessionID)
    }

    const offUpdated = rpc.events.on("updated", (event: any) => {
      const { sessionID, view } = event.data ?? {}
      if (typeof sessionID === "string") {
        setViews(sessionID, reconcile((view ?? null) as GoalView | null))
      }
      if (goalsRequested) void ensureGoals(true)
    })
    const offNotice = rpc.events.on("notice", (event: any) => {
      const data = event.data ?? {}
      const current = context.ui.router.current()
      const here = current.type === "session" && current.sessionID === data.sessionID
      if (data.panel && here) {
        const view = views[data.sessionID]
        void context.ui.dialog.alert({ title: "Goal", message: view ? statusText(view, Date.now()) : String(data.text) })
      } else {
        context.ui.toast.show({ title: "Goal", message: String(data.text ?? ""), variant: (data.level ?? "info") as any, duration: data.level === "error" ? 8000 : 5000, ...(data.sessionID ? { sessionID: data.sessionID } : {}) })
      }
      if (data.attention)
        void context.attention.notify({ title: "Goal", message: String(data.text ?? ""), notification: { when: "blurred" }, sound: { name: data.attention, when: "blurred" } })
    })
    // T045: the post-goal summary lands as a dialog for the owner (headline
    // as the toast, full text — provenance caveats, scope audit, follow-ups —
    // in the dialog), only for the session the goal belongs to.
    // T065: dialogs are not scrollable — the full text once overflowed off
    // the screen; dialogs carry a screen-fit digest, the panel keeps the rest.
    // T066: sequencing state — dialogs stay FIRST at a transition; a summary
    // arriving while a decision dialog is open queues behind it and renders
    // as the screen-fit digest when the decision closes.
    const openDecisions = new Map<string, number>()
    const pendingSummaries = new Map<string, { headline: string; text: string; status: string }>()
    const flushSummary = (sessionID: string) => {
      const queued = pendingSummaries.get(sessionID)
      pendingSummaries.delete(sessionID)
      if (!queued) return
      void context.ui.dialog.alert({
        title: `Goal summary — ${queued.status}`,
        message: dialogDigest(queued.headline, queued.text),
      })
    }
    const offSummary = rpc.events.on("summary", (event: any) => {
      const data = event.data ?? {}
      const current = context.ui.router.current()
      if (current.type !== "session" || current.sessionID !== data.sessionID) {
        context.ui.toast.show({ title: "Goal summary", message: String(data.headline ?? data.text ?? ""), variant: "info", ...(data.sessionID ? { sessionID: data.sessionID } : {}) })
        return
      }
      // T066: at a transition the decision dialog renders FIRST — a summary
      // arriving while one is open queues behind it (headline as a toast so
      // nothing is silent) and renders as the digest when the decision closes.
      if (openDecisions.has(data.sessionID)) {
        pendingSummaries.set(data.sessionID, { headline: String(data.headline ?? "summary"), text: String(data.text ?? data.headline ?? ""), status: String(data.status ?? "") })
        context.ui.toast.show({ title: "Goal summary queued", message: String(data.headline ?? "the full summary opens after the decision"), variant: "info", ...(data.sessionID ? { sessionID: data.sessionID } : {}) })
        return
      }
      void context.ui.dialog.alert({
        title: `Goal summary — ${data.status ?? ""}`,
        message: dialogDigest(String(data.headline ?? "summary"), String(data.text ?? data.headline ?? "")),
      })
    })
    // A dialog choice is the owner's real choice, but the native question
    // must settle too. Executing rpc.act beside it leaves the model blocked
    // in question and every later command deferred forever (T082).
    const dialogChoices = new Map<string, { sessionID: string; question: string; label: string }>()
    const replyingChoices = new Set<string>()
    const replyDialogChoice = async (id: string) => {
      const choice = dialogChoices.get(id)
      if (!choice || replyingChoices.has(id)) return
      replyingChoices.add(id)
      const location = locationOf(choice.sessionID)
      try {
        await context.data.session.form.sync(choice.sessionID, location)
        if (dialogChoices.get(id) !== choice) return
        const answer = decisionFormAnswer(context.data.session.form.list(choice.sessionID, location) ?? [], choice.question, choice.label)
        if (!answer) return // question may still be being created; retry on event/reconnect
        await context.data.session.form.reply({ sessionID: choice.sessionID, ...answer }, location)
        dialogChoices.delete(id)
      } catch (error) {
        dialogChoices.delete(id)
        context.ui.toast.show({ title: "Goal decision", message: `Native choice could not be delivered; the review remains available: ${String(error)}`, variant: "warning" })
      } finally { replyingChoices.delete(id) }
    }
    const offData = context.data.listen(({ details }: any) => {
      if (details?.type === "server.connected") {
        for (const id of requested) void fetchView(id)
        if (goalsRequested) void ensureGoals(true)
      }
      if (details?.type === "form.asked" || details?.type === "server.connected")
        for (const id of dialogChoices.keys()) void replyDialogChoice(id)
    })
    const offHandoff = rpc.events.on("handoff", (event: any) => {
      const data = event.data ?? {}
      const route = context.ui.router.current()
      if (typeof data.toSessionID !== "string" || typeof data.fromSessionID !== "string") return
      if (route.type === "session" && route.sessionID === data.fromSessionID) openGoalSession(context.ui, data.toSessionID)
      else context.ui.toast.show({ title: "Goal running elsewhere", message: `${data.slug} is running in ${data.toSessionID}; original history is preserved.`, variant: "info" })
      void ensureGoals(true)
    })
    const refreshIfStale = (sessionID: string) => {
      if (Date.now() - (fetchedAt.get(sessionID) ?? 0) <= STALE_MS) return
      fetchedAt.set(sessionID, Date.now())
      void fetchView(sessionID)
    }
    const ticker = setInterval(() => {
      // A terminal (or empty) snapshot is not terminal for the SESSION:
      // another goal can start here while its updated event is missed.
      // Refresh every requested session, including old completed goals.
      for (const id of requested) refreshIfStale(id)
      if (goalsRequested) void ensureGoals()
      for (const id of dialogChoices.keys()) void replyDialogChoice(id)
    }, STALE_MS)

    // T056: the panel opens ON DEMAND (the v0.2 auto-open displaced the
    // sidebar); the toggle command is keybindable beside OpenCode's
    // session.sidebar toggle. T073: opening from the card's expand affordance
    // lands on the tab whose content the sidebar truncated — the affordance
    // is a click-through, not a dead hint.
    let panelFocusPending = false
    const openPanel = () => {
      panelFocusPending = true // T074 sign-off fix: the panel TAKES focus on open so tab/↑↓/enter reach it (with the composer focused, tab cycled nothing)
      const id = currentSession()
      const v = id ? views[id] : undefined
      const target = v ? cardAffordanceTab(v, now(), SIDEBAR_WIDTH) : undefined
      if (target) setTab(target)
      context.ui.panel.open(PANEL_NAME)
    }
    const togglePanel = () => {
      // The host changes active panel ownership when tabs change. A local
      // boolean becomes stale and turns the first F9 into an invisible close.
      if (context.ui.panel.current()?.name === PANEL_NAME) {
        context.ui.panel.close()
      } else openPanel()
    }
    const [tab, setTab] = createSignal<DashboardTab>("now")
    const expandGoal = (goal: GoalSummary) => {
      openPanel()
      setSelectedGoalKey(goalKey(goal))
      setSelectedDetails(goal)
      setTab("goals") // expand here; never jump or attach on mere selection
      void ensureGoals(true)
      void fetchDetails(goal)
    }
    const fetchDetails = async (goal: GoalSummary) => {
      const ticket = ++detailRequest
      const id = currentSession(), location = id ? locationOf(id) : undefined
      try {
        const result = await rpc.details({ key: goalKey(goal) }, location ? { location } : undefined)
        if (!disposed && ticket === detailRequest && selectedGoalKey() === goalKey(goal) && result?.goal) setSelectedDetails(result.goal)
      } catch { /* Summary stays visible, with unknown detail fields unclaimed. */ }
    }
    const selectedGoal = () => {
      const row = goalsList().find((g) => goalKey(g) === selectedGoalKey())
      const detail = selectedDetails()
      return row && detail && goalKey(detail) === goalKey(row) && detail.lock === row.lock && detail.sessionID === row.sessionID ? { ...detail, ...row, details: detail.details } : row
    }
    const manageSelected = async (row: ManagerAction) => {
      const goal = selectedGoal(), sessionID = currentSession()
      if (row.action === "back") { setSelectedGoalKey(undefined); setSelectedDetails(undefined); return }
      if (!goal || !sessionID) return
      if (row.action === "jump") { if (goal.sessionID && goal.sessionState === "present") openGoalSession(context.ui, goal.sessionID); return }
      const location = locationOf(sessionID)
      try {
        const result = await rpc.manage({ sessionID, action: row.action, target: targetOf(goal) }, location ? { location } : undefined)
        context.ui.toast.show({ title: "Selected goal", message: result.message, variant: result.pending ? "info" : result.ok ? "success" : "warning" })
        void ensureGoals(true)
        if (!result.pending) void fetchDetails(goal)
      } catch (error) { context.ui.toast.show({ title: "Selected goal", message: `Operation unavailable: ${String(error)}`, variant: "warning" }) }
    }

    const color = (tone: Tone) => {
      const t = context.theme as any
      if (tone === "base") return t.text.base
      if (tone === "muted") return t.text.muted
      return t.text.feedback?.[tone]?.base ?? t.text.base
    }

    const disposers: Array<() => void> = []

    disposers.push(
      context.ui.slot({
        append: "sidebar.content",
        render: (input: { sessionID: string }) => {
          ensure(input.sessionID)
          refreshIfStale(input.sessionID) // T058: focus renders refresh a stale card
          void ensureGoals()
          const width = typeof (input as any).width === "number" ? (input as any).width : SIDEBAR_WIDTH
          const model = () => sidebarCards(goalsList(), input.sessionID, width)
          return (
            <box id="goal-sidebar" flexDirection="column" maxHeight={12}>
              <Show when={model().total}>
                <text fg={color("base")} wrapMode="none" truncate>Goals ({model().total})</text>
                <For each={model().cards.map((c) => c.key)}>
                  {(key) => {
                    const card = () => model().cards.find((c) => c.key === key)
                    const expand = () => { const current = card(); if (current) expandGoal(current.goal) }
                    return (
                      <box flexDirection="column" marginTop={1}>
                        <select id={`goal-card:${key}`} height={2}
                          options={[{ name: card()?.title ?? "", description: card()?.description ?? "", value: key }]}
                          showDescription showSelectionIndicator={false}
                          textColor={color("base")} descriptionColor={color(card()?.tone ?? "muted")}
                          onSelect={expand} onMouseUp={expand} />
                        <text fg={color("muted")} wrapMode="none" truncate>{card()?.progress ?? ""}</text>
                      </box>
                    )
                  }}
                </For>
              </Show>
              <select id="goal-sidebar-manager" height={1} showDescription={false}
                options={[{ name: goalsState() === "error" ? "Retry goals — F9 manager" : model().pointer, description: "Open the project Goals manager", value: "manager" }]}
                onSelect={() => { openPanel(); setTab("goals"); void ensureGoals(true) }}
                onMouseUp={() => { openPanel(); setTab("goals"); void ensureGoals(true) }} />
            </box>
          )
        },
      } as any),
    )

    disposers.push(
      context.ui.slot({
        append: "prompt.footer.status",
        render: (input: { sessionID?: string }) => {
          if (input.sessionID) ensure(input.sessionID)
          return (
            <Show when={input.sessionID ? views[input.sessionID] : undefined}>
              {(view) => <text fg={color(view().status === "running" ? "success" : "muted")}>{pillText(view(), now())}</text>}
            </Show>
          )
        },
      } as any),
    )

    disposers.push(
      context.ui.slot({
        append: "session.composer.top",
        render: (input: { sessionID: string }) => {
          ensure(input.sessionID)
          // Slot render runs once on mount. Derive inside JSX accessors so
          // the Solid store remains tracked across progress/status changes
          // and, critically, replacement by a NEW run in this session.
          const tracer = () => {
            const view = views[input.sessionID]
            return view ? tracerLines(view, now(), 80) : []
          }
          const banner = () => {
            const view = views[input.sessionID]
            return view ? bannerText(view) : undefined
          }
          return (
            <box flexDirection="column" paddingLeft={1} paddingRight={1}>
              <For each={tracer()}>
                {(line) => (
                  <text fg={color(line.tone)} wrapMode="none" truncate>
                    {line.text}
                  </text>
                )}
              </For>
              <Show when={banner()}>
                {(b) => (
                  <text fg={color(b().tone)} wrapMode="none" truncate>
                    {b().text}
                  </text>
                )}
              </Show>
            </box>
          )
        },
      } as any),
    )

    disposers.push(
      context.ui.slot({
        append: "session.panel",
        render: (input: any) => {
          if (input.name !== PANEL_NAME) return null
          ensure(input.sessionID)
          void ensureGoals()
          const view = () => views[input.sessionID]
          if (!view() && !selectedGoalKey()) setTab("goals")
          const width = typeof input.width === "number" ? input.width : 46
          // T074 sign-off fix: focus the panel once on open (the composer
          // otherwise keeps swallowing tab/↑↓)
          if (input.name === PANEL_NAME && panelFocusPending && typeof input.focus === "function") {
            panelFocusPending = false
            try {
              input.focus()
            } catch {
              // focus is best-effort; the palette/palette-command still works
            }
          }
          // T074 sign-off fix: the Decisions tab is ALWAYS interactive —
          // open decision rows first, then the always-applicable quick acts
          const rows = () => view() && tab() === "decisions" ? [...decisionRows(view()!), ...quickActRows(view()!)] : []
          const managerRows = () => orderedGoals(goalsList(), input.sessionID)
          const actions = () => { const g = selectedGoal(); return g ? managerActions(g, input.sessionID, !!view() && !["complete", "failed", "aborted", "superseded"].includes(view()!.status)) : [] }
          // The host's panel transition restores input ownership AFTER the
          // slot renders. `focused` on a newly mounted Select alone loses
          // that race to the composer. Focus the scope and concrete control
          // once after mount; never reclaim focus on every progress tick.
          const focusControl = (control: any) => {
            const scheduled = setTimeout(() => {
              try { input.focus?.(); control.focus() } catch { /* unavailable panel scope */ }
            }, 0)
            onCleanup(() => clearTimeout(scheduled))
          }
          let managerControl: any, actionsControl: any
          return (
            <Show when={tab() !== "goals"} fallback={
              <box id="goal-manager" flexDirection="column" paddingLeft={1} paddingRight={1}>
                <text fg={color("base")} wrapMode="none" truncate><b>Goals manager · this project</b></text>
                <text fg={color("muted")} wrapMode="none" truncate>{fitColumns("↑↓ select · enter expands · jump is explicit", width - 2)}</text>
                <Show when={goalsState() === "loading"}><text fg={color("muted")}>Loading project goals…</text></Show>
                <Show when={goalsState() === "error"}><text fg={color("error")}>Inventory unavailable; F9 retries.</text></Show>
                <Show when={managerRows().length} fallback={<Show when={goalsState() === "ready"}><text fg={color("muted")}>No goals — /goal starts the interview.</text></Show>}>
                  <select id="goal-manager-list" ref={(control: any) => { managerControl = control; if (!selectedGoal()) focusControl(control) }} height={selectedGoal() ? 2 : Math.min(8, Math.max(2, managerRows().length * 2))}
                    options={managerRows().map((g) => ({ name: fitColumns(`${g.title}${g.archived ? " [archived]" : ""}`, width - 4), description: fitColumns(`${g.status} · ${g.proven}/${g.total} · ${g.agent ?? "agent unknown"}`, width - 4), value: goalKey(g) }))}
                    showDescription focused={!selectedGoal()}
                    onMouseDown={(event: any) => { event.stopPropagation(); event.preventDefault() }}
                    onMouseUp={(event: any) => { input.focus?.(); pointerSelect(managerControl, event, 2) }}
                    onSelect={(_index: number, option: any) => { const goal = managerRows().find((g) => goalKey(g) === option?.value); if (goal) { setSelectedGoalKey(goalKey(goal)); setSelectedDetails(goal); void fetchDetails(goal) } }} />
                </Show>
                <Show when={selectedGoal()}>
                  {(goal) => (
                    <box id="goal-manager-details" flexDirection="column" marginTop={1}>
                      <scrollbox id="goal-manager-detail-text" height={Math.max(4, Math.min(8, (input.height ?? 24) - actions().length - 6))}>
                      <For each={wrapColumns(goal().outcome ?? goal().title, width - 2)}>{(line) => <text fg={color("base")}>{line}</text>}</For>
                      <text fg={color("muted")} wrapMode="none" truncate>{fitColumns(`${goal().status} · ${goal().proven}/${goal().total} · ${goal().agent ?? "agent unknown"}`, width - 2)}</text>
                      <For each={wrapColumns(`session: ${goal().sessionID ?? "unassigned"}`, width - 2)}>{(line) => <text fg={color("muted")}>{line}</text>}</For>
                      <For each={goal().details?.criteria ?? []}>{(criterion) => (
                        <For each={wrapColumns(`${criterion.id} [${criterion.status}] ${criterion.statement}${criterion.by ? ` (${criterion.by})` : ""}`, width - 2)}>{(line) => <text fg={color(criterion.status === "fail" ? "error" : "muted")}>{line}</text>}</For>
                      )}</For>
                      <For each={goal().issues ?? []}>{(issue) => <For each={wrapColumns(issue, width - 2)}>{(line) => <text fg={color("error")}>{line}</text>}</For>}</For>
                      </scrollbox>
                      <select id="goal-manager-actions" ref={(control: any) => { actionsControl = control; focusControl(control) }} height={Math.min(8, actions().length)}
                        options={actions().map((r) => ({ name: r.label, description: r.description, value: r }))}
                        showDescription={false} focused
                        onMouseDown={(event: any) => { event.stopPropagation(); event.preventDefault() }}
                        onMouseUp={(event: any) => { input.focus?.(); pointerSelect(actionsControl, event, 1) }}
                        onSelect={(_index: number, option: any) => { if (option?.value) void manageSelected(option.value) }} />
                    </box>
                  )}
                </Show>
              </box>
            }>
            <Show when={view()}>
              {(v) => (
                <box flexDirection="column" paddingLeft={1} paddingRight={1}>
                  <For each={dashboardLines(v(), tab(), now(), width, goalsList() as any)}>
                    {(line) => (
                      <text fg={color(line.tone)} wrapMode="none" truncate>
                        {line.bold ? <b>{line.text}</b> : line.text}
                      </text>
                    )}
                  </For>
                  <Show when={rows().length}>
                    <select
                      options={rows().map((r) => ({ name: r.label, description: r.description, value: r }))}
                      showDescription
                      focused
                      onSelect={(_index: number, option: any) => {
                        const row = option?.value as { act?: string; arg?: string; label: string; description?: string } | undefined
                        if (row?.act) void act(row.act, row.arg)
                        else context.ui.toast.show({ title: "Goal", message: `Run: ${row?.description ?? row?.label ?? ""}`, variant: "info" })
                      }}
                    />
                  </Show>
                </box>
              )}
            </Show>
            </Show>
          )
        },
      } as any),
    )

    // Palette commands live in a keymap layer owned by the app slot's render
    // component (createComponent gives it a stable owner; T050). T064: the
    // layer MUST be mode:"global" — a layer without a mode defaults to
    // "base", and base-mode layers are unreachable whenever a modal is open
    // (the command palette itself registers mode:"modal",
    // packages/tui/src/ui/dialog-select.tsx), so the palette listed zero
    // Goal commands live. Proven by pty A/B: mode:"global" lists all 8,
    // mode-less lists none. Matches the host's own palette layer (app.tsx
    // Keymap.createLayer(() => ({ mode: "global", ... }))).
    const currentSession = () => {
      const route = context.ui.router.current()
      return route.type === "session" ? route.sessionID : undefined
    }
    const act = async (action: string, arg?: string, decision?: { sessionID: string; decisionId: string }) => {
      const sessionID = decision?.sessionID ?? currentSession()
      if (!sessionID) return
      const location = locationOf(sessionID)
      try {
        const result = await rpc.act({ sessionID, action, ...(arg ? { arg } : {}), ...(decision ? { decisionId: decision.decisionId } : {}) }, location ? { location } : undefined)
        context.ui.toast.show({ title: "Goal", message: result.message, variant: result.ok ? "success" : "warning" })
      } catch (error) {
        context.ui.toast.show({ title: "Goal", message: `Goal plugin unavailable: ${String(error)}`, variant: "error" })
      }
    }
    const hasGoal = () => {
      const id = currentSession()
      return !!(id && views[id])
    }
    // T050: decision dialogs. Every engine decision payload renders as a
    // selectable dialog wired to rpc.act — the owner picks instead of typing
    // commands. Choices without an act (guidance-only) fall back to an alert.
    // T066: the dialog stays open until answered; its close flushes any
    // queued summary digest for the same session.
    const openDecisionIdentity = new Map<string, string>()
    const offDecision = rpc.events.on("decision", (event: any) => {
      const data = event.data ?? {}
      const current = context.ui.router.current()
      const here = current.type === "session" && current.sessionID === data.sessionID
      const choices = (data.choices ?? []) as Array<{ label: string; act?: string; arg?: string; run?: string }>
      if (!here) {
        context.ui.toast.show({ title: "Goal decision", message: `${String(data.message ?? "").slice(0, 160)} (${choices.map((c) => c.run ?? c.label).slice(0, 3).join(" · ")})`, variant: "warning", ...(data.sessionID ? { sessionID: data.sessionID } : {}) })
        return
      }
      void (async () => {
        const actionable = choices.filter((c) => c.act)
        const guidance = choices.filter((c) => !c.act)
        if (!actionable.length) {
          await context.ui.dialog.alert({ title: `Goal — ${data.kind ?? "decision"}`, message: `${data.message ?? ""}\n\n${choices.map((c) => `• ${c.run ?? c.label}`).join("\n")}` })
          return
        }
        openDecisions.set(data.sessionID, (openDecisions.get(data.sessionID) ?? 0) + 1)
        openDecisionIdentity.set(data.sessionID, data.decisionId)
        try {
          // T067: guidance-only choices render as visible rows (they carry
          // no act; picking one shows how to run them) instead of being
          // dropped — the complete dialog once showed Archive alone.
          const pick = await context.ui.dialog.select({
            title: `Goal — ${data.kind ?? "decision"}`,
            options: [
              ...actionable.map((c, i) => ({ title: c.label, value: String(i), description: c.run ?? "" })),
              // T070: guidance rows are marked as guidance in the copy itself
              ...guidance.map((c, i) => ({ title: `ℹ ${c.label}`, value: `guide:${i}`, description: `guidance — ${c.run ?? ""}` })),
            ],
          })
          if (pick === undefined || pick === null) return
          if (String(pick).startsWith("guide:")) {
            const row = guidance[Number(String(pick).slice(6))]
            context.ui.toast.show({ title: "Goal guidance", message: row?.run ?? row?.label ?? "", variant: "info", duration: 8000 })
            return
          }
          const chosen = actionable[Number(pick)]
          if (chosen?.act) {
            if (typeof data.question === "string" && typeof data.decisionId === "string") {
              dialogChoices.set(data.decisionId, { sessionID: data.sessionID, question: data.question, label: chosen.label })
              await replyDialogChoice(data.decisionId)
            } else await act(chosen.act, chosen.arg, { sessionID: data.sessionID, decisionId: data.decisionId })
          }
        } finally {
          const depth = (openDecisions.get(data.sessionID) ?? 1) - 1
          if (depth <= 0) openDecisions.delete(data.sessionID)
          else openDecisions.set(data.sessionID, depth)
          if (openDecisionIdentity.get(data.sessionID) === data.decisionId) openDecisionIdentity.delete(data.sessionID)
          flushSummary(data.sessionID)
        }
      })()
    })

    // T075: answering either surface suppresses the other. When the native
    // form (or any other owner act) resolves the decision, any open decision
    // dialog for that session closes — the pick already happened.
    const offResolved = rpc.events.on("decision.resolved", (event: any) => {
      const data = event.data ?? {}
      dialogChoices.delete(data.decisionId)
      if (openDecisionIdentity.get(data.sessionID) !== data.decisionId) return
      const depth = openDecisions.get(data.sessionID) ?? 0
      if (!depth) return
      openDecisions.delete(data.sessionID)
      try {
        context.ui.dialog.clear()
      } catch {
        // no dialog open on this attachment
      }
      flushSummary(data.sessionID)
    })

    // T049: goals are reachable from any session. When this session has no
    // goal, the palette still lists the project's goals so the owner can
    // attach one here instead of hunting for the session that started it.
    const attachables = async (): Promise<Array<{ slug: string; title: string; status: string }>> => {
      const sessionID = currentSession()
      if (!sessionID) return []
      const location = locationOf(sessionID)
      const listed = await rpc.list({}, location ? { location } : undefined)
      return ((listed?.goals ?? []) as Array<{ slug: string; title: string; status: string; attachable?: boolean }>).filter((g) => g.attachable)
    }
    disposers.push(
      context.ui.slot({
        append: "app",
        render: () => {
          context.keymap.layer(() => ({
            mode: "global" as const,
            commands: [
              {
                id: "goal.attach",
                title: "Goal: attach/switch to a goal",
                group: "Goal",
                palette: true,
                enabled: () => true,
                run: async () => {
                  try {
                    const goals = await attachables()
                    if (!goals.length) {
                      context.ui.toast.show({ title: "Goal", message: "No attachable goal in this project (none is live and stopped). /goal list shows everything.", variant: "info" })
                      return
                    }
                    const pick = await context.ui.dialog.select({
                      title: "Attach which goal to this session?",
                      options: goals.map((g) => ({ title: `${g.slug} — ${g.title}`, value: g.slug, description: g.status })),
                    })
                    if (pick) await act("attach", pick)
                  } catch (error) {
                    context.ui.toast.show({ title: "Goal", message: `Goal plugin unavailable: ${String(error)}`, variant: "error" })
                  }
                },
              },
              {
                id: "goal.panel",
                title: "Goal: toggle dashboard",
                group: "Goal",
                palette: true,
                // T056/T074: the documented default was leader+g, but OpenCode
                // 2.0.22 plugin keymap binds cannot join the leader chord
                // (spike S28: leader+g / ctrl+x g / bare g never dispatch —
                // the host's which-key table lists only host commands; a
                // host tui.json bind for a plugin id did not dispatch
                // either). F9 is the proven direct default (pty A/B); owners
                // can rebind via their own tui.json on upgrades that fix the
                // leader table.
                bind: "f9",
                enabled: () => true,
                run: () => togglePanel(),
              },
              {
                id: "goal.dashboard.tab",
                title: "Goal: next dashboard tab",
                group: "Goal",
                palette: true,
                bind: "tab",
                enabled: () => hasGoal() || context.ui.panel.current()?.name === PANEL_NAME,
                run: () => {
                  const order = DASHBOARD_TABS
                  setTab(order[(order.indexOf(tab()) + 1) % order.length]!)
                },
              },
              {
                id: "goal.status",
                title: "Goal: show status",
                group: "Goal",
                palette: true,
                enabled: hasGoal,
                run: () => {
                  const view = views[currentSession()!]
                  if (view) void context.ui.dialog.alert({ title: "Goal", message: statusText(view, Date.now()) })
                },
              },
              { id: "goal.pause", title: "Goal: pause", group: "Goal", palette: true, enabled: hasGoal, run: () => act("pause") },
              { id: "goal.resume", title: "Goal: resume", group: "Goal", palette: true, enabled: hasGoal, run: () => act("resume") },
              { id: "goal.verify", title: "Goal: verify now", group: "Goal", palette: true, enabled: hasGoal, run: () => act("verify") },
              {
                id: "goal.approve",
                title: "Goal: approve a criterion",
                group: "Goal",
                palette: true,
                enabled: hasGoal,
                run: async () => {
                  const view = views[currentSession()!]
                  if (!view) return
                  const pick = await context.ui.dialog.select({
                    title: "Approve which criterion?",
                    options: view.criteria.filter((c) => !c.invariant && c.status !== "pass").map((c) => ({ title: `${c.id} ${c.statement}`, value: c.id, description: c.kind })),
                  })
                  if (pick) await act("approve", pick)
                },
              },
              {
                id: "goal.abort",
                title: "Goal: abort",
                group: "Goal",
                palette: true,
                enabled: hasGoal,
                run: async () => {
                  const ok = await context.ui.dialog.confirm({ title: "Abort the goal?", message: "The run stops for good; its ledger and evidence stay on disk.", label: { confirm: "Abort", cancel: "Keep running" } })
                  if (ok) await act("abort")
                },
              },
            ],
          }))
          return null
        },
      } as any),
    )

    return () => {
      disposed = true
      offHandoff()
      clearInterval(timer)
      clearInterval(ticker)
      offUpdated?.()
      offNotice?.()
      offSummary?.()
      offDecision?.()
      offResolved?.()
      offData?.()
      for (const dispose of disposers.splice(0)) dispose()
    }
  },
}
