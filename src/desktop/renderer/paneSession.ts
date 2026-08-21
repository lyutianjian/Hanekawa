/**
 * One lane's worth of renderer state.
 *
 * The single-window shell keeps N panes alive at once, and everything that
 * belongs to exactly one conversation lives here: the session client, the
 * transcript state *and its own DOM subtree* (visibility-toggled, so a switch
 * repaints nothing and scroll positions survive), the four blocking-request
 * dialogs, completions, the queue strip's mirror, the surface picker state,
 * the rewind panel, and the composer draft while the pane is in the
 * background.
 *
 * Everything else — the status bar, the composer, the tab bar, the overlay
 * panels — is a singleton the *active* pane drives. A background pane still
 * folds every event into its state (a permission request parks; a turn keeps
 * streaming), it just does not paint. `activate()` replays the whole surface
 * once, which is the entire cost of switching.
 *
 * Same rules as the old `app.ts`: decisions live in `model/`, this file only
 * wires them; a blocking request must always be answered; the draft is only
 * authoritative in the composer while active and is banked on `deactivate()`.
 */

import { SessionClient } from '../../runtime/protocol/client.js'
import type { RuntimeChannel } from '../../runtime/protocol/channel.js'
import type {
  AskUserQuestionRequest,
  AskUserQuestionResult,
  PersistedQueuedMessage,
} from '../../harness/types.js'
import type { ExitDialogInput, ExitPlanDecision } from '../../harness/planModeManager.js'
import type { PermissionRequestDto, UiRequest, WireCommandInfo, WirePaneInfo } from '../../runtime/protocol/wire.js'
import type { ComposerView } from './dom/composerView.js'
import type { StatusView } from './dom/statusView.js'
import type { SuggestionsView } from './dom/suggestionsView.js'
import type { OverlayView } from './dom/overlayView.js'
import type { RewindPanel } from './dom/rewindView.js'
import type { SurfacePanel } from './dom/surfaceView.js'
import type { QueueDom } from './dom/queueView.js'
import { append, el, show } from './dom/dom.js'
import { createTranscriptView, type TranscriptView } from './dom/transcriptView.js'
import { classifyInput, commandEffectToIntent } from './model/commandRouting.js'
import {
  acceptCompletion as applyCompletion,
  applyFileResponse,
  beginFileRequest,
  closeCompletions as clearCompletions,
  commandCompletions,
  fileCompletionQuery,
  moveCompletion as moveCompletionState,
  NO_COMPLETIONS,
  type CompletionState,
} from './model/completion.js'
import type { ShellState } from './model/keymap.js'
import { applySessionEvent, createTranscriptState, type TranscriptState } from './model/transcript.js'
import {
  activeIndex,
  activeRequest,
  addUiRequest,
  createUiQueue,
  cycleActive,
  permissionRequests,
  removeUiRequest,
  type UiQueueState,
} from './model/uiQueue.js'
import {
  initialPermissionIndex,
  permissionKeyToIntent,
  permissionResponseFor,
  permissionViewModel,
} from './model/permissionDialog.js'
import {
  applyAskIntent,
  askKeyToIntent,
  askViewModel,
  createAskState,
  type AskState,
} from './model/askUserQuestion.js'
import {
  applyExitPlanIntent,
  createExitPlanState,
  enterPlanKeyToIntent,
  enterPlanViewModel,
  exitPlanKeyToIntent,
  exitPlanViewModel,
  type ExitPlanState,
} from './model/planDialogs.js'
import {
  activateSurfaceRow as chooseSurfaceRow,
  backgroundTasksView,
  effortPickerView,
  initialSurfaceSelection,
  isSupportedSurface,
  modelPickerView,
  moveSurfaceSelection as stepSurfaceSelection,
  resumePickerView,
  type SupportedSurface,
  type SurfaceAction,
  type SurfaceView,
} from './model/surfaces.js'
import {
  applyRewindIntent,
  beginRewindRun,
  createRewindState,
  failRewindRun,
  rewindViewModel,
  runRewind,
  type RewindIntent,
  type RewindState,
} from './model/rewindPanel.js'
import { queuedMessagesView } from './model/queuedMessages.js'

export interface PaneSessionDeps {
  /** The lane key. Stable across `/clear` and `/resume`; identifies this pane. */
  lane: string
  channel: RuntimeChannel
  /** `#transcript-area`; this pane's subtree is appended here. */
  mount: HTMLElement
  overlay: OverlayView
  rewindPanel: RewindPanel
  surface: SurfacePanel
  suggestions: SuggestionsView
  queueStrip: QueueDom
  status: StatusView
  composer: ComposerView
  /** Shell chrome (the tab bar) re-renders from the active session. */
  onShellChanged?: () => void
  /** `/exit` was accepted by the host — close whatever this shell calls "this pane". */
  onExit: () => void
  /** The lane died from the host side (pane closed, window closing). */
  onClosed?: () => void
}

export interface PaneSession {
  readonly lane: string
  readonly client: SessionClient
  readonly paneEl: HTMLElement
  /** The pane topology this pane's client last heard about. */
  readonly panes: readonly WirePaneInfo[]
  readonly ownProjectRoot: string | undefined
  readonly rewind: RewindState | undefined
  isActive(): boolean
  activate(): void
  deactivate(): void
  dispose(): void
  /** The `hello()` startup sequence: records, notices, queue, commands, panes. */
  start(): Promise<void>
  shellState(): ShellState
  note(text: string, level?: 'system' | 'error'): void
  // --- keyboard entry points (routed here by the app's global handler) ---
  handleOverlayKey(event: KeyboardEvent): void
  handleRewindIntent(intent: RewindIntent): void
  acceptCompletion(mode: 'accept' | 'submit'): Promise<void>
  moveCompletion(direction: 'up' | 'down'): void
  closeCompletions(): void
  hideSurface(): void
  moveSurfaceSelection(direction: 'up' | 'down'): void
  activateSurfaceRow(): void
  interrupt(): Promise<void>
  send(): Promise<void>
  queueMessage(): Promise<void>
  /** The form/button path: the same send-or-queue verdict as the keymap. */
  submitFromForm(): Promise<void>
  onComposerInput(): void
  // --- panel entry points ---
  openRewindPanel(): Promise<void>
  /**
   * The composer chip's two halves. They open the *same* surfaces `/model` and
   * `/effort` do, so the chip cannot drift from the slash commands — and so
   * choosing from it still persists through `run-command`.
   */
  openModelPicker(): Promise<void>
  openEffortPicker(): Promise<void>
  runSurfaceAction(action: SurfaceAction): Promise<void>
  clearQueue(): Promise<void>
  refreshPanes(): Promise<void>
}

export function createPaneSession(deps: PaneSessionDeps): PaneSession {
  const { lane, channel } = deps
  const client = new SessionClient(channel)

  // One DOM subtree per pane. Visibility is the only thing that changes on a
  // switch: `show()` flips `hidden`, the scroll position stays where the user
  // left it, and no item is ever rebuilt because of a switch.
  const paneEl = el('div', 'pane')
  const transcriptEl = el('div', 'transcript')
  transcriptEl.setAttribute('aria-live', 'polite')
  const toolProgressEl = el('div', 'tool-progress')
  toolProgressEl.hidden = true
  append(paneEl, [transcriptEl, toolProgressEl])
  deps.mount.appendChild(paneEl)
  const transcriptView: TranscriptView = createTranscriptView(transcriptEl, toolProgressEl)

  // --- state -----------------------------------------------------------------

  let transcript: TranscriptState = createTranscriptState()
  let queue: UiQueueState = createUiQueue()
  let completions: CompletionState = NO_COMPLETIONS
  let commands: WireCommandInfo[] = []
  let panes: readonly WirePaneInfo[] = Object.freeze([])
  let ownProjectRoot: string | undefined
  /**
   * Messages the host is holding until the running turn ends — a mirror of
   * `client.getQueuedMessages()`, drawn from the last `queued-messages` event.
   */
  let queued: readonly PersistedQueuedMessage[] = Object.freeze([])
  let surfaceView: SurfaceView | undefined
  let surfaceIndex = 0
  let rewind: RewindState | undefined
  let boundSessionId: string | undefined
  /** One resolver per outstanding request, keyed the way the queue is. */
  const resolvers = new Map<string, (response: unknown) => void>()
  let permissionIndex = 0
  let askState: AskState | undefined
  let enterPlanIndex = 0
  let exitPlan: ExitPlanState | undefined
  let preparedId: string | undefined
  /** The composer text while this pane is not active; the composer owns it while it is. */
  let draftText = ''
  let active = false

  // --- rendering (state always updates; paint only when active) --------------

  function renderTranscript(): void {
    if (!active) return
    transcriptView.render(transcript)
  }

  function renderQueue(): void {
    if (!active) return
    deps.queueStrip.render(queuedMessagesView(queued))
  }

  function renderSurface(): void {
    if (!active) return
    if (surfaceView) deps.surface.showSurface(surfaceView, surfaceIndex)
  }

  function hideSurface(): void {
    surfaceView = undefined
    surfaceIndex = 0
    if (active) deps.surface.hide()
  }

  function renderRewind(): void {
    if (!active) return
    if (rewind) deps.rewindPanel.render(rewindViewModel(rewind))
  }

  function closeRewindPanel(): void {
    rewind = undefined
    if (active) {
      deps.rewindPanel.hide()
      deps.composer.focus()
    }
  }

  function renderStatus(): void {
    if (!active) return
    deps.status.render(client.getSnapshot(), client.getCost())
    deps.composer.setStreaming(client.getSnapshot().isStreaming)
    const runtime = client.getRuntimeSnapshot()
    // The chip is repainted even when the snapshot is missing, so a pane that
    // has not finished starting shows the placeholder rather than the previous
    // pane's model.
    deps.composer.renderRuntime(runtime)
    if (runtime) deps.status.renderRuntime(runtime)
    const session = client.getSession()
    if (session) deps.status.renderSession(session)
  }

  function renderSuggestions(): void {
    if (!active) return
    deps.suggestions.render(completions)
  }

  function note(text: string, level: 'system' | 'error' = 'system'): void {
    transcript = applySessionEvent(transcript, { type: 'notice', level, content: text }).state
    renderTranscript()
  }

  // --- the four blocking requests --------------------------------------------

  /**
   * Parks a request until the user answers it. Every one of these *must* be
   * answered: `PermissionGate.approve` has no timeout, so a dropped request
   * parks the agent loop for the life of the pane. `SessionClient.answer`
   * catches a throw from the handler and falls back per kind — the second net
   * under the same rule.
   */
  function enqueue<T>(request: UiRequest): Promise<T> {
    return new Promise<T>((resolve) => {
      queue = addUiRequest(queue, request)
      resolvers.set(request.requestId, resolve as (response: unknown) => void)
      prepareActive()
      renderOverlay()
    })
  }

  function settle(requestId: string, response: unknown): void {
    const resolve = resolvers.get(requestId)
    resolvers.delete(requestId)
    queue = removeUiRequest(queue, requestId)
    prepareActive()
    renderOverlay()
    resolve?.(response)
  }

  /** Resets the focused dialog's cursor state whenever the active request changes. */
  function prepareActive(): void {
    const activeRequestNow = activeRequest(queue)
    if (activeRequestNow?.requestId === preparedId) return
    preparedId = activeRequestNow?.requestId

    askState = undefined
    exitPlan = undefined
    enterPlanIndex = 0
    if (!activeRequestNow) return

    if (activeRequestNow.kind === 'permission') permissionIndex = initialPermissionIndex(activeRequestNow.payload)
    if (activeRequestNow.kind === 'ask-user-question') askState = createAskState(activeRequestNow.payload)
    if (activeRequestNow.kind === 'exit-plan') exitPlan = createExitPlanState(activeRequestNow.payload)
  }

  function renderOverlay(): void {
    const current = activeRequest(queue)
    if (!current) {
      if (active) {
        deps.overlay.hide()
        deps.composer.focus()
      }
      return
    }

    // An empty ask cannot be drawn — answer it rather than showing nothing,
    // even on a background pane: the loop is parked either way.
    if (current.kind === 'ask-user-question') {
      const view = askState ? askViewModel(askState) : undefined
      if (!view) {
        settle(current.requestId, { kind: 'rejected', feedback: 'No questions were asked.' })
        return
      }
      if (active) deps.overlay.ask(view)
      return
    }
    if (!active) return

    switch (current.kind) {
      case 'permission': {
        const others = permissionRequests(queue)
          .filter((entry) => entry.requestId !== current.requestId)
          .map((entry) => entry.payload)
        deps.overlay.permission(permissionViewModel({
          request: current.payload,
          selectedIndex: permissionIndex,
          activeIndex: activeIndex(queue),
          total: queue.entries.length,
          others,
        }))
        return
      }
      case 'enter-plan':
        deps.overlay.enterPlan(enterPlanViewModel(enterPlanIndex))
        return
      case 'exit-plan':
        if (exitPlan) deps.overlay.exitPlan(exitPlanViewModel(exitPlan))
        return
    }
  }

  /** Routes a keystroke to whichever dialog is on top. */
  function handleOverlayKey(event: KeyboardEvent): void {
    const current = activeRequest(queue)
    if (!current) return
    const chord = {
      key: event.key,
      shiftKey: event.shiftKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
    }

    switch (current.kind) {
      case 'permission': {
        const view = permissionViewModel({ request: current.payload, selectedIndex: permissionIndex })
        const intent = permissionKeyToIntent(chord, { selectedIndex: permissionIndex, options: view.options })
        if (intent.kind === 'move') {
          permissionIndex = intent.selectedIndex
          renderOverlay()
          return
        }
        if (intent.kind === 'cycle') {
          queue = cycleActive(queue, intent.direction)
          prepareActive()
          renderOverlay()
          return
        }
        if (intent.kind === 'answer') settle(current.requestId, permissionResponseFor(intent.action))
        return
      }

      case 'ask-user-question': {
        if (!askState) return
        const outcome = applyAskIntent(askState, askKeyToIntent(chord, askState))
        askState = outcome.state
        if ('result' in outcome) settle(current.requestId, outcome.result)
        else renderOverlay()
        return
      }

      case 'enter-plan': {
        const intent = enterPlanKeyToIntent(chord, { selectedIndex: enterPlanIndex })
        if (intent.kind === 'move') {
          enterPlanIndex = intent.selectedIndex
          renderOverlay()
          return
        }
        if (intent.kind === 'answer') settle(current.requestId, intent.approved)
        return
      }

      case 'exit-plan': {
        if (!exitPlan) return
        const outcome = applyExitPlanIntent(exitPlan, exitPlanKeyToIntent(chord, exitPlanViewModel(exitPlan)))
        exitPlan = outcome.state
        if ('decision' in outcome) settle(current.requestId, outcome.decision)
        else renderOverlay()
        return
      }
    }
  }

  // Installed before `hello()`: the host may post a `ui-request` at any time,
  // and with no handler the client answers the way a missing UI would.
  client.setHandlers({
    permission: (request: PermissionRequestDto) =>
      enqueue<{ approved: boolean; alwaysAllow?: boolean }>({
        kind: 'permission',
        requestId: crypto.randomUUID(),
        payload: request,
      }),
    askUserQuestion: (request: AskUserQuestionRequest) =>
      enqueue<AskUserQuestionResult>({
        kind: 'ask-user-question',
        requestId: crypto.randomUUID(),
        payload: request,
      }),
    enterPlan: () => enqueue<boolean>({ kind: 'enter-plan', requestId: crypto.randomUUID() }),
    exitPlan: (input: ExitDialogInput) =>
      enqueue<ExitPlanDecision>({
        kind: 'exit-plan',
        requestId: crypto.randomUUID(),
        payload: input,
      }),
  })

  // --- host events -------------------------------------------------------------

  client.onEvent((event) => {
    const outcome = applySessionEvent(transcript, event)
    transcript = outcome.state
    renderTranscript()

    // The controller rolled back an interrupted prompt; the record is already
    // gone from disk, so dropping this destroys the user's message.
    if (outcome.restoreInput !== undefined) {
      if (active) {
        deps.composer.setValue(outcome.restoreInput, outcome.restoreInput.length)
        deps.composer.focus()
      } else {
        draftText = outcome.restoreInput
      }
    }
    if (outcome.activeModel !== undefined) {
      note(`Switched to ${outcome.activeModel}.`)
    }
  })

  client.onCommandEffect((effect) => {
    const intent = commandEffectToIntent(effect)
    switch (intent.kind) {
      case 'write-line':
        note(intent.text)
        return
      case 'show-view':
        surfaceView = undefined
        surfaceIndex = 0
        if (active) deps.surface.showCommandView(intent.view.title, intent.rows)
        return
      case 'open-surface':
        // The rewind panel is a modal of its own rather than a row list, so it
        // is resolved by name before the four that build a `SurfaceView`.
        if (intent.surface === 'rewind-panel') {
          void openRewindPanel()
          return
        }
        if (isSupportedSurface(intent.surface)) void openSurface(intent.surface)
        return
    }
  })

  client.onPanesChanged((next) => {
    panes = next
    deps.onShellChanged?.()
  })

  client.onQueueChanged((next) => {
    queued = next
    renderQueue()
  })

  client.subscribe(() => {
    renderStatus()
    // A `/clear` or `/resume` rebinds the host to another session, and the
    // checkpoints on screen belong to the one it left: every option would
    // resolve to a message the new session has never heard of.
    const session = client.getSession()
    if (session && session.id !== boundSessionId) {
      boundSessionId = session.id
      if (rewind) closeRewindPanel()
    }
    deps.onShellChanged?.()
  })

  channel.onClose(() => deps.onClosed?.())

  // --- surfaces -----------------------------------------------------------------

  async function openSurface(name: SupportedSurface): Promise<void> {
    try {
      const view = await buildSurfaceView(name)
      surfaceView = view
      surfaceIndex = initialSurfaceSelection(view)
      renderSurface()
    } catch (error) {
      note(`Could not open ${name}: ${describe(error)}`, 'error')
    }
  }

  async function buildSurfaceView(name: SupportedSurface): Promise<SurfaceView> {
    switch (name) {
      case 'model-picker':
        return modelPickerView(await client.listModels())
      case 'effort-picker': {
        const runtime = client.getRuntimeSnapshot()
        return effortPickerView({
          current: runtime?.effort ?? '',
          ...(runtime?.maxEffort ? { maxEffort: runtime.maxEffort } : {}),
        })
      }
      case 'background-tasks':
        return backgroundTasksView(await client.listBackgroundTasks())
      case 'resume-picker':
        return resumePickerView({
          sessions: await client.listSessions(),
          ...(client.getSession() ? { currentSessionId: client.getSession()!.id } : {}),
        })
    }
  }

  /**
   * Runs whatever the chosen row asked for. The panel closes first: every one
   * of these changes what the panel was describing.
   */
  async function runSurfaceAction(action: SurfaceAction): Promise<void> {
    hideSurface()
    try {
      switch (action.kind) {
        case 'run-command':
          await client.runCommand(action.line)
          void refreshCommands()
          return
        case 'open-pane':
          await client.openPane({ sessionId: action.sessionId })
          return
        case 'peek-task': {
          const output = await client.peekTaskOutput(action.taskId)
          note(output.trim().length > 0 ? output : 'No new output.')
          return
        }
        default:
          return assertNever(action)
      }
    } catch (error) {
      note(describe(error), 'error')
    }
  }

  // --- the rewind panel ---------------------------------------------------------

  /**
   * Opens `/rewind`. The dismissible panel is closed first: a surface does not
   * block the composer, so a user can open `/model`, type `/rewind` and submit
   * it, which would otherwise leave two panels stacked. A failed checkpoint
   * read still opens the panel, empty — showing "No checkpoints available"
   * explains itself; a command that appears to do nothing does not.
   */
  async function openRewindPanel(): Promise<void> {
    hideSurface()
    try {
      rewind = createRewindState(await client.getCheckpoints())
    } catch (error) {
      rewind = failRewindRun(createRewindState([]), describe(error))
    }
    renderRewind()
  }

  function handleRewindIntent(intent: RewindIntent): void {
    if (!rewind) return
    const outcome = applyRewindIntent(rewind, intent)
    rewind = outcome.state

    if ('close' in outcome) {
      closeRewindPanel()
      return
    }
    if ('run' in outcome) {
      rewind = beginRewindRun(rewind)
      renderRewind()
      void executeRewind(outcome.run.decision, outcome.run.checkpoint)
      return
    }
    renderRewind()
  }

  /**
   * Runs the chosen decision, then closes. The transcript is *not* rebuilt
   * here: the host's `afterRewind()` reloads the session and pushes a
   * `transcript-reset`, which the regular `onEvent` path already folds in.
   */
  async function executeRewind(
    decision: Parameters<typeof runRewind>[1],
    checkpoint: Parameters<typeof runRewind>[2],
  ): Promise<void> {
    try {
      const result = await runRewind(client, decision, checkpoint)
      closeRewindPanel()
      note(result.message, result.partial ? 'error' : 'system')
    } catch (error) {
      if (!rewind) return
      rewind = failRewindRun(rewind, describe(error))
      renderRewind()
    }
  }

  // --- completions --------------------------------------------------------------

  /**
   * Recomputes the dropdown after a keystroke. Commands are answered from the
   * list already in hand; a file mention asks the host, and the answer is
   * folded in later — and only if no newer request has been issued since,
   * which is what the echoed `seq` decides. Nothing here awaits.
   */
  function refreshCompletions(): void {
    const text = deps.composer.value()
    const query = fileCompletionQuery(text, deps.composer.cursorPos())
    if (!query) {
      completions = commandCompletions(completions, text, commands)
      renderSuggestions()
      return
    }

    const started = beginFileRequest(completions)
    completions = started.state
    void client.fileSuggestions(query.input, query.cursorPos)
      .then((found) => {
        completions = applyFileResponse(completions, started.seq, found)
        renderSuggestions()
      })
      .catch(() => {
        // Completion is a convenience; a failed lookup must not disturb the
        // composer or clobber whatever the user has typed since.
      })
  }

  function closeCompletions(): void {
    completions = clearCompletions(completions)
    renderSuggestions()
  }

  // --- input --------------------------------------------------------------------

  async function send(): Promise<void> {
    const classified = classifyInput(deps.composer.value())
    if (classified.kind === 'empty') return
    deps.composer.clear()
    closeCompletions()

    try {
      if (classified.kind === 'command') {
        // A slash command runs host-side; an unknown one still comes back
        // handled, with the explanation arriving as a `write-line` beforehand.
        const result = await client.runCommand(classified.line)
        if (result.exit) deps.onExit()
        // The command set can change under us (`/skills reload`), so re-read it.
        void refreshCommands()
        return
      }
      await client.submit(classified.text)
    } catch (error) {
      note(`Failed: ${describe(error)}`, 'error')
    } finally {
      deps.composer.focus()
    }
  }

  /**
   * Hands the composer's text to the host's queue instead of starting a turn.
   * A slash command is *not* queued — commands are not prompts. The composer
   * is cleared optimistically, then restored on failure.
   */
  async function queueMessage(): Promise<void> {
    const classified = classifyInput(deps.composer.value())
    if (classified.kind === 'empty') return
    if (classified.kind === 'command') {
      await send()
      return
    }

    const text = classified.text
    deps.composer.clear()
    closeCompletions()
    try {
      await client.enqueueMessage(text)
    } catch (error) {
      deps.composer.setValue(text, text.length)
      note(`Failed to queue: ${describe(error)}`, 'error')
    } finally {
      deps.composer.focus()
    }
  }

  async function refreshCommands(): Promise<void> {
    try {
      commands = await client.listCommands()
    } catch {
      // Completion is a convenience; losing it must not break the composer.
    }
  }

  async function refreshPanes(): Promise<void> {
    try {
      panes = await client.listPanes()
    } catch {
      return
    }
    deps.onShellChanged?.()
  }

  // --- activation -----------------------------------------------------------------

  function activate(): void {
    if (active) return
    active = true
    show(paneEl, true)
    // The draft was banked when this pane went to the background; the composer
    // is the source of truth again from here until the next deactivation.
    deps.composer.setValue(draftText, draftText.length)
    deps.composer.autosize()
    renderTranscript()
    renderOverlay()
    renderRewind()
    if (surfaceView) {
      deps.surface.showSurface(surfaceView, surfaceIndex)
    } else {
      deps.surface.hide()
    }
    renderSuggestions()
    renderQueue()
    renderStatus()
    deps.composer.focus()
  }

  function deactivate(): void {
    if (!active) return
    draftText = deps.composer.value()
    active = false
    show(paneEl, false)
    // Clear the *paint* this pane left on the singleton panels, not the state:
    // a background pane's open dialogs must not leak onto whichever pane
    // becomes active, and `activate()` repaints from this pane's state when it
    // comes back. Keys never reach a background pane (the app routes to the
    // active one), so a painted-but-inert dialog would be a trap.
    deps.overlay.hide()
    deps.rewindPanel.hide()
    deps.surface.hide()
    deps.queueStrip.hide()
    deps.suggestions.render(NO_COMPLETIONS)
  }

  function dispose(): void {
    client.dispose()
    paneEl.remove()
  }

  // --- the hello sequence ----------------------------------------------------------

  async function start(): Promise<void> {
    const hello = await client.hello()

    transcript = createTranscriptState(hello.records)
    for (const notice of hello.notices) {
      transcript = applySessionEvent(transcript, {
        type: 'notice',
        level: 'system',
        content: notice.content,
      }).state
    }
    renderTranscript()
    renderStatus()

    boundSessionId = hello.session.id
    // Which project this pane belongs to, so the bar can tell its own tabs
    // from another project's. `projectRoot`, not `cwd`: the pane list carries
    // the normalized key, and on Windows the raw path may differ in case.
    ownProjectRoot = hello.projectRoot

    // Whatever the last window left waiting. The queue is replayed from the
    // session log, so this is not always empty even on a cold start.
    queued = hello.queuedMessages
    renderQueue()

    await refreshCommands()

    // Best-effort initial load; a `pane-list` event will arrive shortly after.
    try {
      panes = await client.listPanes()
    } catch {
      panes = Object.freeze([])
    }

    if (hello.initialQueuedPrompt) {
      if (active) {
        deps.composer.setValue(hello.initialQueuedPrompt, hello.initialQueuedPrompt.length)
      } else {
        draftText = hello.initialQueuedPrompt
      }
    }
    if (active) deps.composer.focus()
    deps.onShellChanged?.()
  }

  function shellState(): ShellState {
    return {
      hasOverlay: activeRequest(queue) !== undefined,
      hasRewind: rewind !== undefined,
      hasSurface: surfaceView !== undefined,
      completions: completions.kind,
      isStreaming: client.getSnapshot().isStreaming,
      inputEmpty: deps.composer.value().trim().length === 0,
    }
  }

  async function acceptCompletion(mode: 'accept' | 'submit'): Promise<void> {
    const applied = applyCompletion(completions, deps.composer.value(), deps.composer.cursorPos())
    if (mode === 'accept') {
      if (applied) deps.composer.setValue(applied.text, applied.cursorPos)
      closeCompletions()
      return
    }
    closeCompletions()
    if (!applied) return
    // Accept *and* run, the way the terminal does; Tab is accept-only. Only
    // command suggestions reach here — `keymap.ts` degrades a file mention to
    // accept-only, because it is a fragment of a sentence, not a line.
    deps.composer.setValue(applied.text.trim())
    await send()
  }

  function moveCompletion(direction: 'up' | 'down'): void {
    completions = moveCompletionState(completions, direction)
    renderSuggestions()
  }

  function moveSurfaceSelection(direction: 'up' | 'down'): void {
    if (!surfaceView) return
    surfaceIndex = stepSurfaceSelection(surfaceView, surfaceIndex, direction)
    renderSurface()
  }

  function activateSurfaceRow(): void {
    if (!surfaceView) return
    const chosen = chooseSurfaceRow(surfaceView, surfaceIndex)
    if (chosen) void runSurfaceAction(chosen)
  }

  async function interrupt(): Promise<void> {
    try {
      await client.interrupt('user-cancel')
    } catch (error) {
      note(describe(error), 'error')
    }
  }

  async function clearQueue(): Promise<void> {
    try {
      await client.clearQueue()
    } catch (error) {
      note(describe(error), 'error')
    }
  }

  async function submitFromForm(): Promise<void> {
    // The button path must reach the same verdict as the key map. The button
    // is not disabled mid-turn, so this branch is load-bearing.
    if (client.getSnapshot().isStreaming) {
      await queueMessage()
      return
    }
    await send()
  }

  return {
    lane,
    client,
    paneEl,
    get panes() {
      return panes
    },
    get ownProjectRoot() {
      return ownProjectRoot
    },
    get rewind() {
      return rewind
    },
    isActive: () => active,
    activate,
    deactivate,
    dispose,
    start,
    shellState,
    note,
    handleOverlayKey,
    handleRewindIntent,
    acceptCompletion,
    moveCompletion,
    closeCompletions,
    hideSurface,
    moveSurfaceSelection,
    activateSurfaceRow,
    interrupt,
    send,
    queueMessage,
    submitFromForm,
    onComposerInput: () => {
      deps.composer.autosize()
      refreshCompletions()
    },
    openRewindPanel,
    openModelPicker: () => openSurface('model-picker'),
    openEffortPicker: () => openSurface('effort-picker'),
    runSurfaceAction,
    clearQueue,
    refreshPanes,
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled surface action: ${JSON.stringify(value)}`)
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
