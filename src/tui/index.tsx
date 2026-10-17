/** @jsxImportSource @opentui/solid */
// TUI plugin: a live goal card in the sidebar, a status pill under the prompt,
// a banner when the owner is needed, notices as toasts and desktop attention,
// and palette commands. Fed only by the server's GoalRpc (S6), never by files.
import type { Plugin } from "@opencode/plugin/tui"
import { createEffect, createSignal, For, onCleanup, Show, untrack } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { GoalRpc, type GoalSummary, type GoalView, type LaunchView } from "../rpc"
import { bannerText, pillText, statusText, type Tone } from "./format"
import { tracerLines } from "./tracer"
import { cardAffordanceTab, dashboardLines, decisionRows, dialogDigest, DASHBOARD_TABS, quickActRows, type DashboardTab } from "./dashboard"
import { fitColumns, goalKey, launchStatusText, managerActions, orderedGoals, sidebarCards, targetOf, wrapColumns, type ManagerAction } from "./manager"
import { openGoalSession } from "./navigation"
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
    const [launches, setLaunches] = createStore<Record<string, LaunchView[]>>({})
    const currentLaunch = (sessionID: string) => [...(launches[sessionID] ?? [])].sort((a, b) => Number(b.status === "executing") - Number(a.status === "executing") || (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0]
    const [now, setNow] = createSignal(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    const requested = new Set<string>()
    const [goalsList, setGoalsList] = createSignal<GoalSummary[]>([])
    const [goalsState, setGoalsState] = createSignal<"loading" | "ready" | "error">("loading")
    const [selectedGoalKey, setSelectedGoalKey] = createSignal<string>()
    const [selectedDetails, setSelectedDetails] = createSignal<GoalSummary>()
    const [managerNotice, setManagerNotice] = createSignal<{ message: string; tone: Tone }>()
    let detailRequest = 0
    let goalsFetchedAt = 0
    let goalsRequested = false
    let goalsInFlight = false
    let goalsRefreshAgain = false
    let goalsDirectory: string | undefined
    let disposed = false
    let focusManagerSection: (() => void) | undefined
    // OpenCode 2.0.26 can render a fullscreen session.panel while
    // ui.panel.current() is null. Track the real mounted slot, not a guessed
    // global toggle flag, and use its own documented close capability.
    const mountedPanels = new Map<string, { close: () => void }>()
    const currentMountedPanel = () => {
      const route = context.ui.router.current()
      return route.type === "session" ? mountedPanels.get(route.sessionID) : undefined
    }

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
        if (Array.isArray(result?.launches)) setLaunches(sessionID, reconcile(result.launches as LaunchView[]))
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
      const data = event.data ?? {}, { sessionID, view, launch } = data
      if (typeof sessionID === "string") {
        // Launch-only notifications must not erase another live run's view.
        if ("view" in data) setViews(sessionID, reconcile((view ?? null) as GoalView | null))
        if (launch && typeof launch.decisionId === "string") setLaunches(sessionID, reconcile([...(launches[sessionID] ?? []).filter((p) => p.decisionId !== launch.decisionId), launch]))
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
    // A summary must not displace an unanswered native Composer decision.
    const openDecisions = new Map<string, number>()
    const pendingSummaries = new Map<string, { headline: string; text: string; status: string; title?: string; digest?: string }>()
    const summaryTitle = (data: any) => {
      const label = String(data.status ?? "summary").replace(/_/g, " ")
      return data.status === "complete" ? `✓ Goal complete — ${data.title ?? label}` : `Goal ${label}`
    }
    const summaryBody = (data: any) => String(data.digest ?? dialogDigest(String(data.headline ?? "summary"), String(data.text ?? "")))
    const flushSummary = (sessionID: string) => {
      const queued = pendingSummaries.get(sessionID)
      pendingSummaries.delete(sessionID)
      if (!queued) return
      void context.ui.dialog.alert({
        title: summaryTitle(queued),
        message: summaryBody(queued),
      })
    }
    const offSummary = rpc.events.on("summary", (event: any) => {
      const data = event.data ?? {}
      const current = context.ui.router.current()
      if (current.type !== "session" || current.sessionID !== data.sessionID) {
        context.ui.toast.show({ title: "Goal summary", message: String(data.headline ?? data.text ?? ""), variant: "info", ...(data.sessionID ? { sessionID: data.sessionID } : {}) })
        return
      }
      // Queue the digest behind an actual pending native review.
      if (openDecisions.has(data.sessionID)) {
        pendingSummaries.set(data.sessionID, { headline: String(data.headline ?? "summary"), text: String(data.text ?? data.headline ?? ""), status: String(data.status ?? ""), title: data.title ? String(data.title) : undefined, digest: data.digest ? String(data.digest) : undefined })
        context.ui.toast.show({ title: "Goal summary queued", message: String(data.headline ?? "the full summary opens after the decision"), variant: "info", ...(data.sessionID ? { sessionID: data.sessionID } : {}) })
        return
      }
      void context.ui.dialog.alert({
        title: summaryTitle(data),
        message: summaryBody(data),
      })
    })
    // Composer's core form is the sole decision surface. A notification
    // never synthesizes an answer or remembers a second popup choice.
    const offData = context.data.listen(({ details }: any) => {
      if (details?.type === "server.connected") {
        for (const id of requested) void fetchView(id)
        if (goalsRequested) void ensureGoals(true)
      }
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
      const mounted = currentMountedPanel()
      if (mounted || context.ui.panel.current()?.name === PANEL_NAME) {
        if (mounted) mounted.close(); else context.ui.panel.close()
      } else openPanel()
    }
    const [tab, setTab] = createSignal<DashboardTab>("now")
    const expandGoal = (goal: GoalSummary) => {
      setManagerNotice(undefined)
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
      if (row.action === "back") { setSelectedGoalKey(undefined); setSelectedDetails(undefined); setManagerNotice(undefined); return }
      if (!goal || !sessionID) { setManagerNotice({ message: "The selected goal or active session is unavailable. Reopen the manager with F9.", tone: "warning" }); return }
      if (row.action === "jump") {
        if (!goal.sessionID || goal.sessionState !== "present") { setManagerNotice({ message: "This goal's session is not available for navigation.", tone: "warning" }); return }
        try {
          // Focusing the already-current tab leaves its fullscreen manager
          // covering the conversation. Explicit activation must return to it.
          if (goal.sessionID === sessionID) { const panel = currentMountedPanel(); if (panel) panel.close(); else context.ui.panel.close() }
          else openGoalSession(context.ui, goal.sessionID)
        } catch (error) { setManagerNotice({ message: `Navigation unavailable: ${String(error)}`, tone: "warning" }) }
        return
      }
      const location = locationOf(sessionID)
      try {
        const result = await rpc.manage({ sessionID, action: row.action, target: targetOf(goal) }, location ? { location } : undefined)
        // Native toast overlays can take the keyboard focus away from the
        // selected action after a resize. Keep manager feedback in place;
        // actual owner decisions still reveal their Composer form.
        setManagerNotice({ message: String(result.message), tone: result.pending ? "muted" : result.ok ? "success" : "warning" })
        void ensureGoals(true)
        if (!result.pending) void fetchDetails(goal)
      } catch (error) { setManagerNotice({ message: `Operation unavailable: ${String(error)}`, tone: "warning" }) }
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
                <text height={1} flexShrink={0} fg={color("base")} wrapMode="none" truncate>Goals ({model().total})</text>
                <For each={model().cards.map((c) => c.key)}>
                  {(key) => {
                    const card = () => model().cards.find((c) => c.key === key)
                    const expand = () => { const current = card(); if (current) expandGoal(current.goal) }
                    return (
                      <box flexDirection="column" marginTop={1} flexShrink={0}>
                        <select id={`goal-card:${key}`} height={2} flexShrink={0}
                          options={[{ name: card()?.title ?? "", description: card()?.description ?? "", value: key }]}
                          showDescription showSelectionIndicator={false}
                          textColor={color("base")} descriptionColor={color(card()?.tone ?? "muted")}
                          onSelect={expand} onMouseUp={expand} />
                        <text height={1} flexShrink={0} fg={color("muted")} wrapMode="none" truncate>{card()?.progress ?? ""}</text>
                        <Show when={card()?.handoffPointer}>{(pointer) => <text id={`goal-handoff-pointer:${key}`} height={1} flexShrink={0} fg={color("muted")} wrapMode="none" truncate>{pointer()}</text>}</Show>
                      </box>
                    )
                  }}
                </For>
              </Show>
              <select id="goal-sidebar-manager" height={1} flexShrink={0} showDescription={false}
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
              <Show when={launchStatusText(currentLaunch(input.sessionID), views[input.sessionID])}>
                {(line) => <text id="goal-launch-admission" fg={color(currentLaunch(input.sessionID)?.status === "executing" ? "muted" : "warning")} wrapMode="none" truncate>{line()}</text>}
              </Show>
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
          const mount = { close: () => { if (typeof input.close === "function") input.close(); else context.ui.panel.close() } }
          mountedPanels.set(input.sessionID, mount)
          onCleanup(() => { if (mountedPanels.get(input.sessionID) === mount) mountedPanels.delete(input.sessionID) })
          ensure(input.sessionID)
          void ensureGoals()
          const view = () => views[input.sessionID]
          if (!view() && !selectedGoalKey()) setTab("goals")
          // PanelInput.width/focused are reactive host props; capturing a
          // number once leaves every wrapped line stale after a resize.
          const width = () => typeof input.width === "number" ? input.width : 46
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
          let managerControl: any, actionsControl: any, detailsControl: any, closeControl: any, lastFocusedControl: any
          let resizeFocusTimer: ReturnType<typeof setTimeout> | undefined
          onCleanup(() => clearTimeout(resizeFocusTimer))
          const rememberFocus = (control: any) => { control.on?.("focused", () => { lastFocusedControl = control }) }
          const restoreAfterResize = () => {
            if (tab() !== "goals" || mountedPanels.get(input.sessionID) !== mount || !lastFocusedControl) return
            const route = context.ui.router.current()
            if (route.type !== "session" || route.sessionID !== input.sessionID) return
            clearTimeout(resizeFocusTimer)
            resizeFocusTimer = setTimeout(() => {
              if (mountedPanels.get(input.sessionID) !== mount || (context.data.session.form?.list(input.sessionID, locationOf(input.sessionID))?.length ?? 0) > 0) return
              input.focus?.()
              lastFocusedControl?.focus()
            }, 0)
          }
          context.renderer?.on?.("resize", restoreAfterResize)
          onCleanup(() => context.renderer?.off?.("resize", restoreAfterResize))
          createEffect(() => {
            if (input.focused === true && tab() === "goals") untrack(() => focusControl(selectedGoal() ? actionsControl : managerControl))
          })
          const cycleSection = () => {
            const controls = [managerControl, detailsControl, actionsControl, closeControl].filter((c) => c && c.visible !== false)
            if (!controls.length) return
            const at = controls.findIndex((c) => c.focused)
            input.focus?.()
            controls[(at + 1) % controls.length].focus()
          }
          focusManagerSection = cycleSection
          onCleanup(() => { if (focusManagerSection === cycleSection) focusManagerSection = undefined })
          return (
            <Show when={tab() !== "goals"} fallback={
              <box id="goal-manager" flexDirection="column" paddingLeft={1} paddingRight={1} height="100%" minHeight={0} overflow="hidden">
                <text height={1} flexShrink={0} fg={color("base")} wrapMode="none" truncate><b>Goals manager · this project</b></text>
                <select id="goal-manager-close" ref={(control: any) => { closeControl = control; rememberFocus(control) }} height={1} flexShrink={0}
                  options={[{ name: "Close manager · F9: return to sidebar", description: "Return to this session's basic sidebar without changing the goal", value: "close" }]}
                  showDescription={false} onSelect={() => { if (typeof input.close === "function") input.close(); else context.ui.panel.close() }}
                  onMouseUp={() => { if (typeof input.close === "function") input.close(); else context.ui.panel.close() }} />
                <text height={1} flexShrink={0} fg={color("muted")} wrapMode="none" truncate>{fitColumns("Tab: focus · ↑↓: select · Enter: activate", width() - 2)}</text>
                <Show when={goalsState() === "loading"}><text fg={color("muted")}>Loading project goals…</text></Show>
                <Show when={goalsState() === "error"}><text fg={color("error")}>Inventory unavailable; F9 retries.</text></Show>
                <Show when={managerRows().length} fallback={<Show when={goalsState() === "ready"}><text fg={color("muted")}>No goals — /goal starts the interview.</text></Show>}>
                  <select id="goal-manager-list" ref={(control: any) => { managerControl = control; rememberFocus(control); if (!selectedGoal()) focusControl(control) }} height={selectedGoal() ? 2 : Math.min(8, Math.max(2, managerRows().length * 2))} flexShrink={0}
                    options={managerRows().map((g) => ({ name: fitColumns(`${g.title}${g.archived ? " [archived]" : ""}`, width() - 4), description: fitColumns(`${g.status}${g.launch?.status === "executing" ? " · starting" : g.launch?.status === "expired" ? " · review expired" : ""} · ${g.proven}/${g.total} proven`, width() - 4), value: goalKey(g) }))}
                    showDescription focused={!selectedGoal()}
                    onMouseDown={(event: any) => { event.stopPropagation(); event.preventDefault() }}
                    onMouseUp={(event: any) => { input.focus?.(); pointerSelect(managerControl, event, 2) }}
                    onSelect={(_index: number, option: any) => { const goal = managerRows().find((g) => goalKey(g) === option?.value); if (goal) { setSelectedGoalKey(goalKey(goal)); setSelectedDetails(goal); void fetchDetails(goal) } }} />
                </Show>
                <Show when={selectedGoal()}>
                  {(goal) => (
                    <box id="goal-manager-details" flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0} marginTop={1}>
                      <text height={1} flexShrink={0} fg={color("base")} wrapMode="none" truncate>{fitColumns(`${goal().status} · ${goal().proven}/${goal().total} host-proven · ${goal().agent ?? "agent unknown"}`, width() - 2)}</text>
                      <text height={1} flexShrink={0} fg={color("muted")} wrapMode="none" truncate>{fitColumns(`Session: ${goal().sessionTitle ?? goal().sessionID ?? "unassigned"}`, width() - 2)}</text>
                      <Show when={managerNotice()}>{(notice) => <text id="goal-manager-feedback" height={1} flexShrink={0} fg={color(notice().tone)} wrapMode="none" truncate>{fitColumns(notice().message, width() - 2)}</text>}</Show>
                      <Show when={goal().steps?.length}><text height={1} flexShrink={0} fg={color("muted")} wrapMode="none" truncate>{fitColumns(`Plan: ${goal().steps?.filter((s) => s.status === "done").length}/${goal().steps?.length} done · ${goal().steps?.find((s) => s.status === "active")?.title ?? "no active step"}`, width() - 2)}</text></Show>
                      <text height={1} flexShrink={0} fg={color("muted")} wrapMode="none" truncate>Details · Tab to focus · wheel/PgUp/PgDn scroll</text>
                      <scrollbox id="goal-manager-detail-text" ref={(control: any) => { detailsControl = control; rememberFocus(control) }} flexGrow={1} flexShrink={1} minHeight={1}
                        scrollX={false} scrollY={true} viewportOptions={{ overflow: "hidden" }} contentOptions={{ flexDirection: "column" }} onMouseDown={() => { input.focus?.(); detailsControl?.focus() }}>
                      <text fg={color("base")}><b>Outcome</b></text>
                      <text fg={color("muted")} wrapMode="word">{`Goal: ${goal().slug}`}</text>
                      <text fg={color("base")} wrapMode="word">{goal().outcome ?? goal().title}</text>
                      <text fg={color("muted")} wrapMode="word">{`Session ID: ${goal().sessionID ?? "unassigned"}`}</text>
                      <Show when={launchStatusText(goal().launch, goal())}>{(line) => <text fg={color("warning")} wrapMode="word">{line()}</text>}</Show>
                      <Show when={goal().details?.criteria?.length}><text fg={color("base")}><b>Evidence</b></text></Show>
                      <For each={goal().details?.criteria ?? []}>{(criterion) => (
                        <text fg={color(criterion.status === "fail" ? "error" : "muted")} wrapMode="word">{`${criterion.id} [${criterion.status}] ${criterion.statement}${criterion.by ? ` (${criterion.by})` : ""}`}</text>
                      )}</For>
                      <For each={goal().issues ?? []}>{(issue) => <text fg={color("error")} wrapMode="word">{issue}</text>}</For>
                      </scrollbox>
                      <text height={1} flexShrink={0} fg={color("base")}><b>Actions · ↑↓ and Enter, or click</b></text>
                      <select id="goal-manager-actions" ref={(control: any) => { actionsControl = control; rememberFocus(control); focusControl(control) }} height={Math.min(8, actions().length)} flexShrink={0}
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
                  <For each={dashboardLines(v(), tab(), now(), width(), goalsList() as any)}>
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
    // Owner-approved T086: lifecycle choices belong only in native Composer ask forms.
    // Preserve attention/result notifications, never open a duplicate dialog.
    const openDecisionIdentity = new Map<string, string>()
    const offDecision = rpc.events.on("decision", (event: any) => {
      const data = event.data ?? {}
      const choices = (data.choices ?? []) as Array<{ label: string; act?: string; arg?: string; run?: string }>
      const route = context.ui.router.current()
      // A full-screen Goals panel must not hide or retain Enter focus over
      // the sole native Composer question. Close only OUR panel here; never
      // dismiss an unrelated host dialog or jump to another session.
      if (choices.some((c) => c.act) && route.type === "session" && route.sessionID === data.sessionID) {
        const mounted = mountedPanels.get(data.sessionID)
        if (mounted) mounted.close()
        else if (context.ui.panel?.current?.()?.name === PANEL_NAME) context.ui.panel.close()
      }
      if (typeof data.sessionID === "string" && typeof data.decisionId === "string" && choices.some((c) => c.act)) {
        openDecisions.set(data.sessionID, 1)
        openDecisionIdentity.set(data.sessionID, data.decisionId)
      }
      context.ui.toast.show({ title: "Goal decision", message: choices.some((c) => c.act)
        ? "Owner decision pending in this session's Composer. No operation executed."
        : String(data.message ?? "Goal guidance is available in the manager."), variant: "info", ...(data.sessionID ? { sessionID: data.sessionID } : {}) })
    })

    // Only engine resolution closes pending review state. Never dismiss an
    // unrelated host dialog or synthesize native answers from notifications.
    const offResolved = rpc.events.on("decision.resolved", (event: any) => {
      const data = event.data ?? {}
      if (data.message) context.ui.toast.show({ title: "Goal decision", message: data.message, variant: "success" })
      if (openDecisionIdentity.get(data.sessionID) !== data.decisionId) return
      openDecisions.delete(data.sessionID)
      openDecisionIdentity.delete(data.sessionID)
      flushSummary(data.sessionID)
    })
    const offFailed = rpc.events.on("decision.failed", (event: any) => {
      const data = event.data ?? {}
      context.ui.toast.show({ title: "Goal decision", message: String(data.message ?? "Owner operation did not execute; inspect the goal and request a new review."), variant: "warning", duration: 8000 })
      if (openDecisionIdentity.get(data.sessionID) === data.decisionId) {
        openDecisions.delete(data.sessionID)
        openDecisionIdentity.delete(data.sessionID)
        flushSummary(data.sessionID)
      }
    })

    // Navigation lives in the existing Goals manager: expand a row before
    // deliberately attaching or jumping. No separate palette chooser.
    disposers.push(
      context.ui.slot({
        append: "app",
        render: () => {
          context.keymap.layer(() => ({
            mode: "global" as const,
            commands: [
              {
                id: "goal.attach",
                title: "Goal: Manage goals",
                group: "Goal",
                palette: true,
                enabled: () => true,
                run: () => { setTab("goals"); openPanel() },
              },
              {
                id: "goal.panel",
                title: "Goal: Toggle dashboard",
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
                title: "Goal: Next dashboard tab",
                group: "Goal",
                palette: true,
                bind: "tab",
                enabled: () => hasGoal() || !!currentMountedPanel() || context.ui.panel.current()?.name === PANEL_NAME,
                run: () => {
                  if (tab() === "goals" && (currentMountedPanel() || context.ui.panel.current()?.name === PANEL_NAME) && focusManagerSection) { focusManagerSection(); return }
                  const order = DASHBOARD_TABS
                  setTab(order[(order.indexOf(tab()) + 1) % order.length]!)
                },
              },
              {
                id: "goal.status",
                title: "Goal: Show status",
                group: "Goal",
                palette: true,
                enabled: hasGoal,
                run: () => {
                  const view = views[currentSession()!]
                  if (view) void context.ui.dialog.alert({ title: "Goal", message: statusText(view, Date.now()) })
                },
              },
              { id: "goal.pause", title: "Goal: Pause", group: "Goal", palette: true, enabled: hasGoal, run: () => act("pause") },
              { id: "goal.resume", title: "Goal: Resume", group: "Goal", palette: true, enabled: hasGoal, run: () => act("resume") },
              { id: "goal.verify", title: "Goal: Verify now", group: "Goal", palette: true, enabled: hasGoal, run: () => act("verify") },
              {
                id: "goal.approve",
                title: "Goal: Review in Composer",
                group: "Goal",
                palette: true,
                enabled: () => !!currentSession(),
                run: async () => {
                  const sessionID = currentSession()
                  if (!sessionID) return
                  const location = locationOf(sessionID)
                  try {
                    const result = await rpc.review({ sessionID }, location ? { location } : undefined)
                    context.ui.toast.show({ title: "Goal review", message: result.message, variant: result.ok ? "info" : "warning" })
                  } catch (error) { context.ui.toast.show({ title: "Goal review", message: String(error), variant: "warning" }) }
                },
              },
              {
                id: "goal.abort",
                title: "Goal: Abort",
                group: "Goal",
                palette: true,
                enabled: hasGoal,
                run: async () => {
                  const sessionID = currentSession()
                  if (!sessionID) return
                  const location = locationOf(sessionID)
                  try {
                    const listed = await rpc.list({}, location ? { location } : undefined)
                    const goal = (listed?.goals as GoalSummary[] | undefined)?.find((g) => g.sessionID === sessionID && g.runId === views[sessionID]?.runId && !g.archived)
                    if (!goal) { context.ui.toast.show({ title: "Goal", message: "Current target changed; inspect its details before aborting.", variant: "warning" }); return }
                    const result = await rpc.manage({ sessionID, action: "abort", target: targetOf(goal) }, location ? { location } : undefined)
                    context.ui.toast.show({ title: "Goal", message: result.message, variant: result.ok ? "info" : "warning" })
                  } catch (error) { context.ui.toast.show({ title: "Goal", message: String(error), variant: "warning" }) }
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
      offFailed?.()
      offData?.()
      for (const dispose of disposers.splice(0)) dispose()
    }
  },
}
