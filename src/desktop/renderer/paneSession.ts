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
import type { PermissionMode } from '../../harness/permissions.js'
import type {
  PermissionRequestDto,
  UiRequest,
  WireCommandInfo,
  WireModelsResult,
  WirePaneInfo,
} from '../../runtime/protocol/wire.js'
import type { ComposerView } from './dom/composerView.js'
import type { StatusView } from './dom/statusView.js'
import type { SuggestionsView } from './dom/suggestionsView.js'
import type { OverlayView } from './dom/overlayView.js'
import type { PermissionRequestView } from './dom/permissionRequestView.js'
import type { RewindPanel } from './dom/rewindView.js'
import type { SurfacePanel } from './dom/surfaceView.js'
import type { QueueDom } from './dom/queueView.js'
import type { TaskPanelDom } from './dom/taskPanelView.js'
import { append, el, show } from './dom/dom.js'
import { createTranscriptView, type TranscriptView } from './dom/transcriptView.js'
import { createWelcomeView } from './dom/welcomeView.js'
import { isTranscriptEmpty, welcomeView } from './model/welcome.js'
import {
  createWorkspacePickerState,
  moveWorkspaceSelection,
  workspacePickerKeyToIntent,
  workspacePickerView,
  type WorkspaceOption,
  type WorkspacePickerIntent,
  type WorkspacePickerState,
} from './model/workspacePicker.js'
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
  selectCompletion,
  type CompletionState,
} from './model/completion.js'
import { completionAcceptMode, type ShellState } from './model/keymap.js'
import { NO_DISCLOSURE, pruneDisclosure, toggleDisclosure, type DisclosureState } from './model/thinking.js'
import {
  applySessionEvent,
  createTranscriptState,
  groupTranscript,
  type ToolDisplayLookup,
  type TranscriptState,
} from './model/transcript.js'
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
import type { OverlayAction } from './model/dialogActions.js'
import {
  initialPermissionIndex,
  permissionIndexToIntent,
  permissionKeyToIntent,
  permissionResponseFor,
  permissionViewModel,
  type PermissionIntent,
} from './model/permissionDialog.js'
import {
  applyAskIntent,
  askKeyToIntent,
  askViewModel,
  createAskState,
  type AskIntent,
  type AskState,
} from './model/askUserQuestion.js'
import {
  applyExitPlanIntent,
  createExitPlanState,
  enterPlanIndexToIntent,
  enterPlanKeyToIntent,
  enterPlanViewModel,
  exitPlanIndexToIntent,
  exitPlanKeyToIntent,
  exitPlanViewModel,
  type EnterPlanIntent,
  type ExitPlanIntent,
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
import { runtimeMenuView } from './model/runtimeMenu.js'
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
import {
  advanceTaskPanel,
  retireCompletedTaskPanel,
  taskPanelState,
  type TaskPanelState,
} from './model/tasks.js'

export interface PaneSessionDeps {
  /** The lane key. Stable across `/clear` and `/resume`; identifies this pane. */
  lane: string
  channel: RuntimeChannel
  /** `#transcript-area`; this pane's subtree is appended here. */
  mount: HTMLElement
  overlay: OverlayView
  /**
   * The permission request's home: the composer, not the modal layer. Held
   * separately from `overlay` because the two are painted on different nodes and
   * a request must never leave one of them behind — see `renderOverlay`.
   */
  permissionRequest: PermissionRequestView
  rewindPanel: RewindPanel
  surface: SurfacePanel
  suggestions: SuggestionsView
  queueStrip: QueueDom
  /** The resident strip above the composer; a singleton, like the composer itself. */
  taskPanel: TaskPanelDom
  status: StatusView
  composer: ComposerView
  /** Shell chrome (the tab bar) re-renders from the active session. */
  onShellChanged?: () => void
  /**
   * This pane's transcript just went from nothing to something — its first
   * input or output. The sidebar's row for a lane-only session appears on this
   * edge, and the history pull it triggers is what replaces the「未命名会话」
   * fallback with the session's real title.
   */
  onFirstContent?: () => void
  /**
   * Window-level: put this pane's own workspace on screen in the sidebar. The
   * switcher's row for the project the pane is already in resolves to this —
   * nothing to open, so the useful answer is "here it is".
   */
  onSwitchWorkspace?: () => void
  /**
   * Every workspace the shell knows, read at paint time rather than captured:
   * the list is `app.ts`'s (it owns the `list-sessions` pull) and it moves under
   * this pane whenever a project is added or removed.
   */
  workspaces?: () => WorkspaceListing
  /**
   * A row or action in the workspace picker was chosen. The pane reports it;
   * *acting* on it — opening a session, raising the directory picker — is
   * window-level and belongs to `app.ts`, exactly like `onSwitchWorkspace`.
   */
  onWorkspaceIntent?: (intent: WorkspacePickerIntent) => void
  /** `/exit` was accepted by the host — close whatever this shell calls "this pane". */
  onExit: () => void
  /** The lane died from the host side (pane closed, window closing). */
  onClosed?: () => void
}

/** What `app.ts` hands the picker: the workspaces, plus the global one's key. */
export interface WorkspaceListing {
  readonly options: readonly WorkspaceOption[]
  /** From `list-sessions`; `undefined` until the first pull answers. */
  readonly globalRoot: string | undefined
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
  /** Whether this pane's session has had any input or output yet. */
  hasConversation(): boolean
  /**
   * Repaint the empty state. `app.ts` calls it when the workspace list moves —
   * the picker reads that list, and nothing else would repaint an idle pane.
   */
  refreshWelcome(): void
  /**
   * Re-read the slash-command list. `app.ts` calls it after a settings change
   * that adds or removes skill commands — the composer's completion list is
   * cached per pane, and nothing else would notice a skill being switched off.
   */
  refreshCommands(): void
  // --- keyboard entry points (routed here by the app's global handler) ---
  handleOverlayKey(event: KeyboardEvent): void
  handleRewindIntent(intent: RewindIntent): void
  acceptCompletion(mode: 'accept' | 'submit'): Promise<void>
  moveCompletion(direction: 'up' | 'down'): void
  // --- mouse entry points (routed here by the two views' own listeners) ---
  /** An option row in the blocking dialog was clicked, by slot. */
  handleOverlayAction(action: OverlayAction): void
  /** A completion row was clicked, by slot. Accepts, and submits when Enter would. */
  acceptCompletionAt(index: number): Promise<void>
  closeCompletions(): void
  hideSurface(): void
  moveSurfaceSelection(direction: 'up' | 'down'): void
  activateSurfaceRow(): void
  interrupt(): Promise<void>
  /** The composer's permission pill; applies to the live gate, not to config. */
  setPermissionMode(mode: PermissionMode): Promise<void>
  send(): Promise<void>
  queueMessage(): Promise<void>
  /** The form/button path: the same send-or-queue verdict as the keymap. */
  submitFromForm(): Promise<void>
  onComposerInput(): void
  // --- panel entry points ---
  openRewindPanel(): Promise<void>
  /**
   * `/model` and `/effort`'s own `#surface` cards. Still reached by the slash
   * commands; the composer chip goes through `openRuntimeMenu` instead.
   */
  openModelPicker(): Promise<void>
  openEffortPicker(): Promise<void>
  /**
   * The composer chip's popover. Fetches the model list, folds it together with
   * the runtime snapshot, and hands the rows to the composer — which is a
   * singleton, so only the active pane may fill it.
   *
   * The rows are the *same* ones the two pickers above draw, and choosing one
   * runs the same `run-command`, so the chip cannot drift from the slash
   * commands and the choice still persists.
   */
  openRuntimeMenu(): Promise<void>
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
  // Before the transcript, so the startup notices a fresh draft carries read as a
  // footnote under the Hero rather than pushing it off the top of the canvas.
  const welcomeEl = el('div', 'welcome')
  const transcriptEl = el('div', 'transcript')
  transcriptEl.setAttribute('aria-live', 'polite')
  append(paneEl, [welcomeEl, transcriptEl])
  deps.mount.appendChild(paneEl)
  // `paneEl` is the float host: `.pane` is the positioned ancestor, and a button
  // placed inside the scroller would both be wiped by every repaint and anchor to
  // the bottom of the content instead of the viewport.
  const transcriptView: TranscriptView = createTranscriptView(transcriptEl, paneEl, {
    onToggle: (id, expanded) => toggleDisclosureAt(id, expanded),
    // The panel is a singleton the active pane drives, so a background pane
    // cannot reach it — and cannot be clicked either, since it does not paint.
    onTaskStep: () => {
      if (active) deps.taskPanel.flash()
    },
  })
  const welcome = createWelcomeView(welcomeEl, {
    onSwitchWorkspace: () => toggleWorkspacePicker(),
    onFocusComposer: () => deps.composer.focus(),
    onPickerIntent: (intent) => runWorkspacePickerIntent(intent),
    onPickerKey: (chord) => {
      const intent = workspacePickerKeyToIntent(chord, currentPickerView())
      if (intent.kind === 'none') return false
      runWorkspacePickerIntent(intent)
      return true
    },
  })

  // --- state -----------------------------------------------------------------

  /**
   * Tool captions, resolved host-side (T1) and asked for at the moment an item is
   * built — the client has already absorbed the map by the time it hands over the
   * event, and a caption outlives the payload that introduced it.
   */
  const toolDisplays: ToolDisplayLookup = (recordId) => client.getToolDisplay(recordId)

  let transcript: TranscriptState = createTranscriptState([], toolDisplays)
  /**
   * The activity groups and steps the user opened or closed by hand, as absolute
   * answers (§5.2). Per pane, like every other `let` here — a window-level map
   * would fold a step in a session the user never touched.
   */
  let disclosure: DisclosureState = NO_DISCLOSURE
  /**
   * The checklist above the composer, or `undefined` for no panel at all.
   *
   * Held here rather than derived from the transcript: the panel's source is the
   * newest `taskSnapshot`, which `TranscriptState` does not keep, and the pane
   * never keeps the record list either. `hello` and `transcript-reset` project it
   * from a whole list; every other record advances it one step (§7.3).
   */
  let taskPanel: TaskPanelState | undefined
  let queue: UiQueueState = createUiQueue()
  let completions: CompletionState = NO_COMPLETIONS
  let commands: WireCommandInfo[] = []
  let panes: readonly WirePaneInfo[] = Object.freeze([])
  let ownProjectRoot: string | undefined
  /** From `hello`, for the welcome screen's Hero and its context pills. */
  let projectName: string | undefined
  /** From `hello`: this pane runs in the global (home-rooted) workspace. */
  let projectGlobal = false
  let gitBranch: string | undefined
  /**
   * The welcome screen's workspace switcher. Per pane like every other `let`
   * here: the popover belongs to the Hero it hangs off, and a window-level one
   * would still be open over the session the user just opened from it.
   */
  let picker: WorkspacePickerState = createWorkspacePickerState()
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

  /**
   * The workspace picker's state, as the model wants it.
   *
   * Assembled per read rather than held: the options and the global root are
   * `app.ts`'s (they move when a project is added or removed), and the only
   * thing this pane owns is whether the popover is open and what is typed in it.
   */
  function currentPickerState(): WorkspacePickerState {
    const listing = deps.workspaces?.()
    return {
      ...picker,
      options: listing?.options ?? [],
      globalRoot: listing?.globalRoot,
      currentRoot: ownProjectRoot,
    }
  }

  function currentPickerView() {
    return workspacePickerView(currentPickerState())
  }

  /** The Hero's project name. Opens the switcher, or closes the open one. */
  function toggleWorkspacePicker(): void {
    if (deps.onWorkspaceIntent === undefined) return
    runWorkspacePickerIntent({ kind: picker.open ? 'close' : 'open' })
  }

  function runWorkspacePickerIntent(intent: WorkspacePickerIntent): void {
    switch (intent.kind) {
      case 'open':
        // A fresh cursor and an empty query every time: the popover is short
        // enough that resuming last time's filter reads as a broken list.
        picker = { ...picker, open: true, query: '', selectedIndex: -1 }
        renderTranscript()
        welcome.focusPicker()
        return
      case 'close':
        if (!picker.open) return
        picker = { ...createWorkspacePickerState(), open: false }
        renderTranscript()
        // Focus has to land somewhere the user expects, and the composer is
        // where they were going anyway.
        deps.composer.focus()
        return
      case 'search':
        // The cursor is dropped rather than clamped: the row it pointed at may
        // not be in the filtered list at all.
        picker = { ...picker, query: intent.query, selectedIndex: -1 }
        renderTranscript()
        return
      case 'move':
        picker = {
          ...picker,
          selectedIndex: moveWorkspaceSelection(currentPickerView(), intent.direction),
        }
        renderTranscript()
        return
      case 'reveal':
        // Nothing opens: the pane is already there. Close, then let the shell
        // put that project's group on screen.
        picker = createWorkspacePickerState()
        renderTranscript()
        deps.onSwitchWorkspace?.()
        return
      case 'pick':
      case 'new-project':
      case 'no-project':
        // Every one of these puts a different session on screen, so the popover
        // is withdrawn *before* the request rather than after — a picker left
        // open over an arriving conversation is a dialog nobody asked for.
        picker = createWorkspacePickerState()
        renderTranscript()
        deps.onWorkspaceIntent?.(intent)
        return
      case 'none':
        return
      default:
        assertNever(intent)
    }
  }

  function renderTranscript(): void {
    if (!active) return
    // Pruned every paint, not on reset: `transcript-reset` restarts the block
    // counter, so `thinking-0` can be minted again and would inherit the answer a
    // different block left behind — and an absolute answer would not even be
    // corrected by the default.
    disclosure = pruneDisclosure(groupTranscript(transcript.items), disclosure)
    transcriptView.render(transcript, disclosure)
    // The one place that decides whether this pane has a conversation, so the
    // transcript and the welcome screen cannot disagree about it.
    welcome.render(welcomeView({
      transcript,
      projectName,
      global: projectGlobal,
      branch: gitBranch,
      canSwitchWorkspace: deps.onWorkspaceIntent !== undefined,
      picker: currentPickerState(),
    }))
    paneEl.classList.toggle('empty', isTranscriptEmpty(transcript))
  }

  /**
   * The conversation-presence edge the sidebar's visibility hangs on. Tracked
   * here rather than in `app.ts` so the "empty → content" moment is one
   * decision, made where the transcript is folded.
   */
  let hadConversation = false
  function noteConversationState(): void {
    const has = !isTranscriptEmpty(transcript)
    if (has && !hadConversation) deps.onFirstContent?.()
    hadConversation = has
  }

  /** Whether this pane's session has had any input or output. */
  function hasConversation(): boolean {
    return !isTranscriptEmpty(transcript)
  }

  /** `expanded` is what that row shows right now, so the click inverts what is seen. */
  function toggleDisclosureAt(id: string, expanded: boolean): void {
    disclosure = toggleDisclosure(disclosure, id, expanded)
    renderTranscript()
  }

  function renderTaskPanel(): void {
    if (!active) return
    deps.taskPanel.render(taskPanel)
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
    const session = client.getSession()
    if (session) deps.status.renderSession(session)
  }

  function renderSuggestions(): void {
    if (!active) return
    deps.suggestions.render(completions)
  }

  function note(text: string, level: 'system' | 'error' = 'system'): void {
    transcript = applySessionEvent(transcript, { type: 'notice', level, content: text }, toolDisplays).state
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
      // The sidebar's `awaiting-input` badge is derived from `shellState().hasOverlay`
      // (`app.ts:242`), and the sidebar only repaints when it is told to. Without
      // this the badge rides on whatever unrelated snapshot tick happens next:
      // it appeared only because tool activity follows a permission request, and
      // it stayed on a row whose prompt had been answered until something else
      // moved. Both `hasOverlay` transitions have to announce themselves.
      deps.onShellChanged?.()
    })
  }

  function settle(requestId: string, response: unknown): void {
    const resolve = resolvers.get(requestId)
    resolvers.delete(requestId)
    queue = removeUiRequest(queue, requestId)
    prepareActive()
    renderOverlay()
    deps.onShellChanged?.()
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
        // The composer is only worth focusing once it is a composer again.
        deps.permissionRequest.hide()
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
      if (active) {
        deps.permissionRequest.hide()
        deps.overlay.ask(view)
      }
      return
    }
    if (!active) return

    switch (current.kind) {
      case 'permission': {
        const others = permissionRequests(queue)
          .filter((entry) => entry.requestId !== current.requestId)
          .map((entry) => entry.payload)
        // The one request that is not modal: it transforms the composer instead.
        // The modal layer is closed first, because a permission request can
        // arrive on top of a plan decision that was drawn there.
        deps.overlay.hide()
        deps.permissionRequest.show(permissionViewModel({
          request: current.payload,
          selectedIndex: permissionIndex,
          activeIndex: activeIndex(queue),
          total: queue.entries.length,
          others,
        }))
        return
      }
      case 'enter-plan':
        deps.permissionRequest.hide()
        deps.overlay.enterPlan(enterPlanViewModel(enterPlanIndex))
        return
      case 'exit-plan':
        if (exitPlan) {
          deps.permissionRequest.hide()
          deps.overlay.exitPlan(exitPlanViewModel(exitPlan))
        }
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
        applyPermissionIntent(
          current.requestId,
          permissionKeyToIntent(chord, { selectedIndex: permissionIndex, options: view.options }),
        )
        return
      }

      case 'ask-user-question': {
        if (!askState) return
        applyAsk(current.requestId, askKeyToIntent(chord, askState))
        return
      }

      case 'enter-plan':
        applyEnterPlanIntent(current.requestId, enterPlanKeyToIntent(chord, { selectedIndex: enterPlanIndex }))
        return

      case 'exit-plan': {
        if (!exitPlan) return
        applyExitPlan(current.requestId, exitPlanKeyToIntent(chord, exitPlanViewModel(exitPlan)))
        return
      }
    }
  }

  /**
   * Routes a click in the dialog: an option slot, or the button bar.
   *
   * A slot goes through the same `*IndexToIntent` its number key uses, and the
   * four `apply*` helpers below are shared with `handleOverlayKey` — so the mouse
   * cannot answer anything the keyboard would not, and a dialog that is drawn but
   * not focused (a background pane never paints) has nothing to click.
   *
   * `primary`/`secondary` exist only where an option is *not* an action: the ask
   * dialog (whose multi-select answer had no submit affordance at all before) and
   * the exit-plan dialog. The permission and enter-plan bars are made of slots,
   * so those two cases cannot arrive there.
   */
  function handleOverlayAction(action: OverlayAction): void {
    const current = activeRequest(queue)
    if (!current) return

    switch (current.kind) {
      case 'permission': {
        if (action.kind !== 'slot') return
        const view = permissionViewModel({ request: current.payload, selectedIndex: permissionIndex })
        applyPermissionIntent(current.requestId, permissionIndexToIntent(action.index, view.options))
        return
      }

      case 'ask-user-question': {
        if (!askState) return
        applyAsk(
          current.requestId,
          action.kind === 'slot'
            ? { kind: 'select', index: action.index }
            // Enter and Escape, by their buttons.
            : action.kind === 'primary'
              ? { kind: 'commit' }
              : { kind: 'cancel' },
        )
        return
      }

      case 'enter-plan':
        if (action.kind !== 'slot') return
        applyEnterPlanIntent(current.requestId, enterPlanIndexToIntent(action.index))
        return

      case 'exit-plan': {
        if (!exitPlan) return
        const view = exitPlanViewModel(exitPlan)
        applyExitPlan(
          current.requestId,
          action.kind === 'slot'
            ? exitPlanIndexToIntent(action.index, view)
            // 继续规划 is Escape: it rejects with no feedback, which is why the
            // model comments that it is the one button that can discard typing.
            : action.kind === 'primary'
              ? { kind: 'commit' }
              : { kind: 'reject' },
        )
        return
      }
    }
  }

  // The four intents, applied. Each one is reached from both the keyboard and the
  // mouse, so cursor state, `settle` and the repaint stay in one place per dialog.

  function applyPermissionIntent(requestId: string, intent: PermissionIntent): void {
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
    if (intent.kind === 'answer') settle(requestId, permissionResponseFor(intent.action))
  }

  function applyAsk(requestId: string, intent: AskIntent): void {
    if (!askState) return
    const outcome = applyAskIntent(askState, intent)
    askState = outcome.state
    if ('result' in outcome) settle(requestId, outcome.result)
    else renderOverlay()
  }

  function applyEnterPlanIntent(requestId: string, intent: EnterPlanIntent): void {
    if (intent.kind === 'move') {
      enterPlanIndex = intent.selectedIndex
      renderOverlay()
      return
    }
    if (intent.kind === 'answer') settle(requestId, intent.approved)
  }

  function applyExitPlan(requestId: string, intent: ExitPlanIntent): void {
    if (!exitPlan) return
    const outcome = applyExitPlanIntent(exitPlan, intent)
    exitPlan = outcome.state
    if ('decision' in outcome) settle(requestId, outcome.decision)
    else renderOverlay()
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
    const outcome = applySessionEvent(transcript, event, toolDisplays)
    transcript = outcome.state
    noteConversationState()
    renderTranscript()

    // Not a `default`-free switch, and deliberately so: the task panel cares
    // about three of a dozen event kinds, and `applySessionEvent` above is the
    // one that must stay exhaustive over `SessionEvent`.
    if (event.type === 'record') taskPanel = advanceTaskPanel(taskPanel, event.record)
    // `/clear`, `/resume` and a rewind all arrive here: the new record list is
    // the whole truth, and an empty one has no snapshot, so a cleared session
    // drops the panel without a case of its own.
    if (event.type === 'transcript-reset') taskPanel = taskPanelState(event.records)
    // The user starting something new, a beat before their record lands.
    if (event.type === 'turn-start') taskPanel = retireCompletedTaskPanel(taskPanel)
    renderTaskPanel()

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
   * The composer chip's popover. A failed model list still opens it: the effort
   * half is answerable from the snapshot alone, and a chip that silently refuses
   * to open reads as the app having hung.
   */
  async function openRuntimeMenu(): Promise<void> {
    let models: WireModelsResult | undefined
    try {
      models = await client.listModels()
    } catch (error) {
      note(`Could not list models: ${describe(error)}`, 'error')
    }
    if (!active) return
    deps.composer.showRuntimeMenu(runtimeMenuView({ runtime: client.getRuntimeSnapshot(), models }))
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
    renderTaskPanel()
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
    // The composer is a singleton too, so a background pane's request would
    // otherwise sit in the next pane's capsule and answer *its* gate.
    deps.permissionRequest.hide()
    deps.rewindPanel.hide()
    deps.surface.hide()
    deps.queueStrip.hide()
    // Emptied, not remembered: the strip is a singleton on the composer's axis,
    // so a background pane's checklist would otherwise hang over the session the
    // user just switched to. `activate()` repaints it from `taskPanel`.
    deps.taskPanel.hide()
    deps.suggestions.render(NO_COMPLETIONS)
    // The composer is a singleton the active pane drives, so an open permission
    // menu would hang over the next pane and act on *its* runtime.
    deps.composer.closeMenus()
  }

  function dispose(): void {
    client.dispose()
    paneEl.remove()
  }

  // --- the hello sequence ----------------------------------------------------------

  async function start(): Promise<void> {
    const hello = await client.hello()

    // Before the first paint, not with the other `hello` bookkeeping below: the
    // welcome screen names the project, and setting these after
    // `renderTranscript()` would show one frame of the「当前项目」fallback.
    projectName = hello.projectName
    projectGlobal = hello.projectIsGlobal
    gitBranch = hello.gitBranch

    transcript = createTranscriptState(hello.records, toolDisplays)
    for (const notice of hello.notices) {
      transcript = applySessionEvent(transcript, {
        type: 'notice',
        level: 'system',
        content: notice.content,
      }, toolDisplays).state
    }
    // Baseline, not an edge: a session opened *with* history already has its
    // content — only later transitions are "first content".
    hadConversation = !isTranscriptEmpty(transcript)
    // The reverse scan, once per pane: a session resumed mid-checklist gets its
    // panel back from the records alone (§7.3).
    taskPanel = taskPanelState(hello.records)
    renderTranscript()
    renderTaskPanel()
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

  /**
   * A clicked completion row: focus it, then accept it exactly as Enter would.
   *
   * `completionAcceptMode` is the keymap's own rule, so a click on `/model` runs
   * it and a click on an `@` mention only fills it in — the difference is not
   * restated here.
   */
  async function acceptCompletionAt(index: number): Promise<void> {
    completions = selectCompletion(completions, index)
    renderSuggestions()
    await acceptCompletion(completionAcceptMode(shellState()))
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

  /**
   * The composer's permission pill.
   *
   * Straight to `set-permission-mode` rather than through a slash command,
   * unlike the model and effort chips: there is nothing to persist here (the
   * mode belongs to the live gate) and the host posts a fresh runtime snapshot
   * on the way out, so the pill repaints from the same path everything else does
   * instead of holding an optimistic guess.
   */
  async function setPermissionMode(mode: PermissionMode): Promise<void> {
    try {
      await client.setPermissionMode(mode)
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
    hasConversation,
    refreshWelcome: renderTranscript,
    refreshCommands: () => {
      void refreshCommands()
    },
    handleOverlayKey,
    handleRewindIntent,
    acceptCompletion,
    moveCompletion,
    handleOverlayAction,
    acceptCompletionAt,
    closeCompletions,
    hideSurface,
    moveSurfaceSelection,
    activateSurfaceRow,
    interrupt,
    setPermissionMode,
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
    openRuntimeMenu,
    runSurfaceAction,
    clearQueue,
    refreshPanes,
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled variant: ${JSON.stringify(value)}`)
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
