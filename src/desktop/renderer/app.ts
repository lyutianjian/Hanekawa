/**
 * The renderer for the Electron desktop shell: wiring only.
 *
 * Everything this file knows about the host arrives through `window.hanekawa`,
 * which the preload exposes via `contextBridge`. Anything imported here is
 * bundled by esbuild into `dist/desktop/renderer/app.js`.
 *
 * Three architectural rules, each with a test behind it:
 *
 * 1. Deep-import `runtime/protocol/client.js`, not the protocol barrel — the
 *    barrel transitively pulls `host.ts`/`permissionDto.ts`, which pull
 *    `node:fs` (`test/protocolClientParity.test.ts`).
 * 2. No value import of `harness/`, `services/`, `sessions/`, `commands/` or
 *    `tui/`, and no Node global. `test/rendererImports.test.ts` is the guard,
 *    because neither typecheck pass can see either problem: the renderer program
 *    already contains ~130 host files through the wire types, which is also how
 *    `@types/node`'s globals get into scope despite `"types": []`.
 * 3. Decisions live in `model/`, which is DOM-free and unit-tested; this file and
 *    `dom/` only turn those decisions into nodes and events. That split is
 *    mandatory rather than tidy — a `model/` module imported by a test is compiled
 *    in the base tsconfig program, which has no DOM lib.
 */

import { SessionClient } from '../../runtime/protocol/client.js'
import { createBridgeChannel } from './bridgeChannel.js'
import {
  classifyInput,
  commandEffectToIntent,
} from './model/commandRouting.js'
import {
  acceptCompletion,
  applyFileResponse,
  beginFileRequest,
  closeCompletions as clearCompletions,
  commandCompletions,
  fileCompletionQuery,
  moveCompletion,
  NO_COMPLETIONS,
  type CompletionState,
} from './model/completion.js'
import { resolveKey, type ShellState } from './model/keymap.js'
import {
  applySessionEvent,
  createTranscriptState,
  type TranscriptState,
} from './model/transcript.js'
import {
  createTabBarState,
  tabBarKeyToIntent,
  tabBarView as buildTabBarView,
  type TabBarState,
} from './model/tabBar.js'
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
  activateSurfaceRow,
  backgroundTasksView,
  effortPickerView,
  initialSurfaceSelection,
  isSupportedSurface,
  modelPickerView,
  moveSurfaceSelection,
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
  rewindKeyToIntent,
  rewindViewModel,
  runRewind,
  type RewindIntent,
  type RewindState,
} from './model/rewindPanel.js'
import { queuedMessagesView } from './model/queuedMessages.js'
import { required } from './dom/dom.js'
import { createTranscriptView } from './dom/transcriptView.js'
import { createOverlayView } from './dom/overlayView.js'
import { createRewindView } from './dom/rewindView.js'
import { createQueueView } from './dom/queueView.js'
import { createSurfacePanel } from './dom/surfaceView.js'
import { createComposerView, createStatusView, createSuggestionsView } from './dom/composerView.js'
import { createTabBarView } from './dom/tabBarView.js'
import type {
  AskUserQuestionRequest,
  AskUserQuestionResult,
  PersistedQueuedMessage,
} from '../../harness/types.js'
import type { ExitDialogInput, ExitPlanDecision } from '../../harness/planModeManager.js'
import type { PermissionRequestDto, UiRequest, WireCommandInfo, WirePaneInfo } from '../../runtime/protocol/wire.js'

const bridge = window.hanekawa
if (!bridge) {
  document.body.textContent = 'Preload script not loaded; please reinstall the app.'
  throw new Error('Preload bridge is missing')
}

const client = new SessionClient(createBridgeChannel(bridge, window))

const transcriptView = createTranscriptView(required('transcript'), required('tool-progress'))
const overlay = createOverlayView(required('overlay'), required('overlay-panel'))
const rewindPanel = createRewindView(required('rewind'), required('rewind-panel'), (intent) => {
  handleRewindIntent(intent)
})
const surface = createSurfacePanel(required('surface'), (action) => {
  void runSurfaceAction(action)
})
const suggestions = createSuggestionsView(required('suggestions'))
const queueStrip = createQueueView(required('queue'), () => {
  void client.clearQueue().catch((error) => note(describe(error), 'error'))
})
const status = createStatusView({
  model: required('status-model'),
  mode: required('status-mode'),
  usage: required('status-usage'),
  cost: required('status-cost'),
  streaming: required('status-streaming'),
  session: required('status-session'),
})
const composer = createComposerView({
  input: required<HTMLTextAreaElement>('input'),
  submit: required<HTMLButtonElement>('submit'),
  stop: required<HTMLButtonElement>('stop'),
})
const form = required<HTMLFormElement>('input-row')
const tabBarContainer = required('tab-bar')

// --- state ------------------------------------------------------------------

let transcript: TranscriptState = createTranscriptState()
let queue: UiQueueState = createUiQueue()
let completions: CompletionState = NO_COMPLETIONS
let commands: WireCommandInfo[] = []
let panes: readonly WirePaneInfo[] = Object.freeze([])
/**
 * This window's own project root, from `hello.cwd` (already normalized host-side).
 *
 * Undefined until `hello()` resolves; the tab bar treats that as "everything is
 * mine", which is true at that point — the only pane it knows about is this one.
 */
let ownProjectRoot: string | undefined
/**
 * Messages the host is holding until the running turn ends.
 *
 * A mirror of `client.getQueuedMessages()` rather than the source: the host owns
 * the queue and pumps it on events this window never sent, so the only correct
 * move here is to draw whatever the last `queued-messages` event said.
 */
let queued: readonly PersistedQueuedMessage[] = Object.freeze([])
/**
 * The picker currently on screen, and the row the keyboard is on.
 *
 * Undefined while a command *view* is showing: those rows are facts, not
 * choices, so there is nothing to select.
 */
let surfaceView: SurfaceView | undefined
let surfaceIndex = 0
/** The `/rewind` panel's state while it is open; undefined when it is not. */
let rewind: RewindState | undefined
/** The session the panel above belongs to, so a rebind can retire it. */
let boundSessionId: string | undefined

/**
 * Maps a tab-bar intent to a side effect. The renderer never closes the
 * `BrowserWindow` itself — that is the host's job — so the host's
 * `SessionHost` is told via `client.closePane`, and the matching
 * `pane-list` event will fire after the workspace has dropped the pane.
 */
const tabBarView = createTabBarView(tabBarContainer, (intent) => {
  switch (intent.kind) {
    case 'switch':
      // Every row in the bar is a pane that already exists, so a click is a
      // focus — not an open. That is also what makes another project's tab
      // clickable at all: only the shell can find its window, and `focus-pane`
      // is handed straight to it. `false` means the bar is stale.
      void client
        .focusPane(intent.paneId)
        .then((focused) => {
          if (!focused) void refreshPanes()
        })
        .catch((error) => note(describe(error), 'error'))
      return
    case 'close':
      void client.closePane(intent.paneId).catch((error) => note(describe(error), 'error'))
      return
    case 'new':
      void client.openPane({}).catch((error) => note(describe(error), 'error'))
      return
    case 'open-project':
      // The shell puts up a native directory picker; nothing comes back here
      // except a `pane-list` once the new project's first window is up.
      void client.openProject().catch((error) => note(describe(error), 'error'))
      return
  }
})

/**
 * Builds the bar's state from the wire panes list and the host's reported
 * active session. A pane is "active" when its session id matches the one
 * the host is bound to; that is the only sane answer on the renderer side
 * since each renderer is its own process.
 *
 * `ownProjectRoot` is what makes a row's project *this* window's or somebody
 * else's, which decides grouping order and whether the row can be closed.
 */
function currentTabBarState(): TabBarState {
  return createTabBarState(panes, client.getSession()?.id, ownProjectRoot)
}

function renderTabBar(): void {
  tabBarView.render(buildTabBarView(currentTabBarState()))
}

/** Re-reads the topology after a focus that found nothing, so the bar self-heals. */
async function refreshPanes(): Promise<void> {
  try {
    panes = await client.listPanes()
  } catch {
    return
  }
  renderTabBar()
}

/** One resolver per outstanding request, keyed the way the queue is. */
const resolvers = new Map<string, (response: unknown) => void>()

/** Per-dialog cursor state, discarded when its request is answered. */
let permissionIndex = 0
let askState: AskState | undefined
let enterPlanIndex = 0
let exitPlan: ExitPlanState | undefined

function shellState(): ShellState {
  return {
    hasOverlay: activeRequest(queue) !== undefined,
    hasRewind: rewind !== undefined,
    hasSurface: surface.isOpen(),
    completions: completions.kind,
    isStreaming: client.getSnapshot().isStreaming,
    inputEmpty: composer.value().trim().length === 0,
  }
}

function renderSurface(): void {
  if (surfaceView) surface.showSurface(surfaceView, surfaceIndex)
}

function hideSurface(): void {
  surface.hide()
  surfaceView = undefined
  surfaceIndex = 0
}

/**
 * Runs whatever the chosen row asked for.
 *
 * The panel closes first, because every one of these changes what the panel was
 * describing — a stale model picker still listing the old current tier is worse
 * than no picker. Exhaustive by `assertNever`: a fourth action kind must be a
 * compile error here rather than a click that does nothing.
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

function assertNever(value: never): never {
  throw new Error(`Unhandled surface action: ${JSON.stringify(value)}`)
}

// --- the rewind panel -------------------------------------------------------

/**
 * Opens `/rewind`.
 *
 * The dismissible panel is closed first: a surface does not block the composer,
 * so a user can open `/model`, type `/rewind` and submit it, which would
 * otherwise leave two panels stacked.
 *
 * A failed checkpoint read still opens the panel, empty — the same choice the
 * terminal makes (`App.tsx`'s `handleEnterRestoreMode`). Showing "No checkpoints
 * available" explains itself; a command that appears to do nothing does not.
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

function renderRewind(): void {
  if (rewind) rewindPanel.render(rewindViewModel(rewind))
}

function closeRewindPanel(): void {
  rewind = undefined
  rewindPanel.hide()
  composer.focus()
}

/** One path for both the key map and a click, since both produce an intent. */
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
 * Runs the chosen decision, then closes.
 *
 * The transcript is *not* rebuilt here: the host's `afterRewind()` reloads the
 * session and pushes a `transcript-reset`, which the regular `onEvent` path
 * already folds in. A failure keeps the panel open with the reason on it, so a
 * different option is one keystroke away.
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

function renderTranscript(): void {
  transcriptView.render(transcript)
}

function renderQueue(): void {
  queueStrip.render(queuedMessagesView(queued))
}

function note(text: string, level: 'system' | 'error' = 'system'): void {
  transcript = applySessionEvent(transcript, { type: 'notice', level, content: text }).state
  renderTranscript()
}

// --- the four blocking requests ---------------------------------------------

/**
 * Parks a request until the user answers it.
 *
 * Every one of these *must* be answered: `PermissionGate.approve` has no timeout
 * and `ToolRunner.run` does not pass its abort signal into it, so a dropped
 * request parks the agent loop for the life of the window. `SessionClient.answer`
 * catches a throw from here and falls back to the kind's own default, which is the
 * second net under the same rule.
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
let preparedId: string | undefined
function prepareActive(): void {
  const active = activeRequest(queue)
  if (active?.requestId === preparedId) return
  preparedId = active?.requestId

  askState = undefined
  exitPlan = undefined
  enterPlanIndex = 0
  if (!active) return

  if (active.kind === 'permission') permissionIndex = initialPermissionIndex(active.payload)
  if (active.kind === 'ask-user-question') askState = createAskState(active.payload)
  if (active.kind === 'exit-plan') exitPlan = createExitPlanState(active.payload)
}

function renderOverlay(): void {
  const active = activeRequest(queue)
  if (!active) {
    overlay.hide()
    composer.focus()
    return
  }

  switch (active.kind) {
    case 'permission': {
      const others = permissionRequests(queue)
        .filter((entry) => entry.requestId !== active.requestId)
        .map((entry) => entry.payload)
      overlay.permission(permissionViewModel({
        request: active.payload,
        selectedIndex: permissionIndex,
        activeIndex: activeIndex(queue),
        total: queue.entries.length,
        others,
      }))
      return
    }
    case 'ask-user-question': {
      const view = askState ? askViewModel(askState) : undefined
      if (!view) {
        // An empty request cannot be drawn; answer it rather than showing nothing.
        settle(active.requestId, { kind: 'rejected', feedback: 'No questions were asked.' })
        return
      }
      overlay.ask(view)
      return
    }
    case 'enter-plan':
      overlay.enterPlan(enterPlanViewModel(enterPlanIndex))
      return
    case 'exit-plan':
      if (exitPlan) overlay.exitPlan(exitPlanViewModel(exitPlan))
      return
  }
}

/** Routes a keystroke to whichever dialog is on top. Returns true if consumed. */
function handleOverlayKey(event: KeyboardEvent): void {
  const active = activeRequest(queue)
  if (!active) return
  const chord = {
    key: event.key,
    shiftKey: event.shiftKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
  }

  switch (active.kind) {
    case 'permission': {
      const view = permissionViewModel({ request: active.payload, selectedIndex: permissionIndex })
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
      if (intent.kind === 'answer') settle(active.requestId, permissionResponseFor(intent.action))
      return
    }

    case 'ask-user-question': {
      if (!askState) return
      const outcome = applyAskIntent(askState, askKeyToIntent(chord, askState))
      askState = outcome.state
      if ('result' in outcome) settle(active.requestId, outcome.result)
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
      if (intent.kind === 'answer') settle(active.requestId, intent.approved)
      return
    }

    case 'exit-plan': {
      if (!exitPlan) return
      const outcome = applyExitPlanIntent(exitPlan, exitPlanKeyToIntent(chord, exitPlanViewModel(exitPlan)))
      exitPlan = outcome.state
      if ('decision' in outcome) settle(active.requestId, outcome.decision)
      else renderOverlay()
      return
    }
  }
}

// Installed before `hello()`, as before: the host may post a `ui-request` at any
// time, and with no handler the client answers the way a missing UI would.
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

// --- host events ------------------------------------------------------------

client.onEvent((event) => {
  const outcome = applySessionEvent(transcript, event)
  transcript = outcome.state
  renderTranscript()

  // The controller rolled back an interrupted prompt; the record is already gone
  // from disk, so dropping this destroys the user's message.
  if (outcome.restoreInput !== undefined) {
    composer.setValue(outcome.restoreInput, outcome.restoreInput.length)
    composer.focus()
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
      surface.showCommandView(intent.view.title, intent.rows)
      return
    case 'open-surface':
      // The rewind panel is a modal of its own rather than a row list, so it is
      // resolved by name before the four that build a `SurfaceView`.
      if (intent.surface === 'rewind-panel') {
        void openRewindPanel()
        return
      }
      // A shell without a panel for a surface ignores it by name; that is why the
      // five collapse into one wire variant.
      if (isSupportedSurface(intent.surface)) void openSurface(intent.surface)
      return
  }
})

/**
 * Tab-bar topology updates. The host pushes this whenever any pane opens or
 * closes; the renderer just re-renders the bar. The active tab is derived
 * from `client.getSession()`, so a `session-changed` event implicitly
 * re-paints the bar through the regular renderTabBar path.
 */
client.onPanesChanged((next) => {
  panes = next
  renderTabBar()
})

/**
 * Queue updates. Pushed on every mutation *and* on every session switch, since
 * the host is also the one that pumps — a row disappearing here is usually the
 * host having just sent it, not this window doing anything.
 */
client.onQueueChanged((next) => {
  queued = next
  renderQueue()
})

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

client.subscribe(() => {
  const snapshot = client.getSnapshot()
  status.render(snapshot, client.getCost())
  composer.setStreaming(snapshot.isStreaming)
  const runtime = client.getRuntimeSnapshot()
  if (runtime) status.renderRuntime(runtime)
  const session = client.getSession()
  if (session) status.renderSession(session)
  // A `/clear` or `/resume` rebinds the host to another session, and the
  // checkpoints on screen belong to the one it left: every option would resolve
  // to a message the new session has never heard of. Close rather than let the
  // user pick one and read "Message not found".
  if (session && session.id !== boundSessionId) {
    boundSessionId = session.id
    if (rewind) closeRewindPanel()
  }
  // The active tab follows the session the host is bound to.
  renderTabBar()
})

// --- input ------------------------------------------------------------------

/**
 * Recomputes the dropdown after a keystroke.
 *
 * Commands are answered from the list already in hand. A file mention is not:
 * the host has to read the filesystem, so the request goes out and the answer is
 * folded in later — and only if no newer request has been issued since, which is
 * what the echoed `seq` decides. Nothing here awaits, so typing never blocks on
 * IPC.
 */
function refreshCompletions(): void {
  const text = composer.value()
  const query = fileCompletionQuery(text, composer.cursorPos())
  if (!query) {
    completions = commandCompletions(completions, text, commands)
    suggestions.render(completions)
    return
  }

  const started = beginFileRequest(completions)
  completions = started.state
  void client.fileSuggestions(query.input, query.cursorPos)
    .then((found) => {
      completions = applyFileResponse(completions, started.seq, found)
      suggestions.render(completions)
    })
    .catch(() => {
      // Completion is a convenience; a failed lookup must not disturb the
      // composer or clobber whatever the user has typed since.
    })
}

function closeCompletions(): void {
  completions = clearCompletions(completions)
  suggestions.render(completions)
}

document.addEventListener('keydown', (event) => {
  const action = resolveKey(
    { key: event.key, shiftKey: event.shiftKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey },
    shellState(),
  )

  // Tab-bar shortcuts are checked before the global keymap: a Ctrl+T is
  // always "new tab" regardless of the active dialog, mirroring the browser's
  // behavior. The keymap only knows shell-level transitions.
  const tabBarIntent = tabBarKeyToIntent(
    { key: event.key, shiftKey: event.shiftKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey },
    currentTabBarState(),
  )
  if (tabBarIntent.kind !== 'none') {
    event.preventDefault()
    if (tabBarIntent.kind === 'switch') {
      void client
        .focusPane(tabBarIntent.paneId)
        .then((focused) => {
          if (!focused) void refreshPanes()
        })
        .catch((error) => note(describe(error), 'error'))
    } else if (tabBarIntent.kind === 'close') {
      void client.closePane(tabBarIntent.paneId).catch((error) => note(describe(error), 'error'))
    } else if (tabBarIntent.kind === 'new') {
      void client.openPane({}).catch((error) => note(describe(error), 'error'))
    } else if (tabBarIntent.kind === 'open-project') {
      void client.openProject().catch((error) => note(describe(error), 'error'))
    }
    return
  }

  switch (action) {
    case 'overlay':
      event.preventDefault()
      handleOverlayKey(event)
      return
    case 'rewind':
      event.preventDefault()
      if (rewind) {
        handleRewindIntent(rewindKeyToIntent(
          { key: event.key, shiftKey: event.shiftKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey },
          rewind,
        ))
      }
      return
    case 'accept-completion': {
      event.preventDefault()
      const applied = acceptCompletion(completions, composer.value(), composer.cursorPos())
      if (applied) composer.setValue(applied.text, applied.cursorPos)
      closeCompletions()
      return
    }
    case 'submit-completion': {
      event.preventDefault()
      const applied = acceptCompletion(completions, composer.value(), composer.cursorPos())
      closeCompletions()
      if (!applied) return
      // Accept *and* run, the way the terminal does; Tab is accept-only. Only
      // command suggestions reach here — `keymap.ts` degrades a file mention to
      // `accept-completion`, because it is a fragment of a sentence, not a line.
      composer.setValue(applied.text.trim())
      void send()
      return
    }
    case 'move-completion-up':
      event.preventDefault()
      completions = moveCompletion(completions, 'up')
      suggestions.render(completions)
      return
    case 'move-completion-down':
      event.preventDefault()
      completions = moveCompletion(completions, 'down')
      suggestions.render(completions)
      return
    case 'close-completions':
      event.preventDefault()
      closeCompletions()
      return
    case 'close-surface':
      event.preventDefault()
      hideSurface()
      return
    case 'move-surface-up':
    case 'move-surface-down': {
      event.preventDefault()
      if (!surfaceView) return
      surfaceIndex = moveSurfaceSelection(
        surfaceView,
        surfaceIndex,
        action === 'move-surface-up' ? 'up' : 'down',
      )
      renderSurface()
      return
    }
    case 'activate-surface': {
      event.preventDefault()
      if (!surfaceView) return
      const chosen = activateSurfaceRow(surfaceView, surfaceIndex)
      if (chosen) void runSurfaceAction(chosen)
      return
    }
    case 'interrupt':
      event.preventDefault()
      void client.interrupt('user-cancel').catch((error) => note(describe(error), 'error'))
      return
    case 'submit':
      event.preventDefault()
      void send()
      return
    case 'enqueue':
      event.preventDefault()
      void queueMessage()
      return
    case 'newline':
    case 'none':
      return
  }
})

required<HTMLTextAreaElement>('input').addEventListener('input', () => {
  composer.autosize()
  refreshCompletions()
})

form.addEventListener('submit', (event) => {
  event.preventDefault()
  // Enter is handled by the global key map, which decides between sending and
  // queueing; this is the button path and it must reach the same verdict. The
  // button is no longer disabled mid-turn, so this branch is now load-bearing
  // rather than a guard against a click that could not happen.
  if (client.getSnapshot().isStreaming) {
    void queueMessage()
    return
  }
  void send()
})

required<HTMLButtonElement>('stop').addEventListener('click', () => {
  void client.interrupt('user-cancel').catch((error) => note(describe(error), 'error'))
})

async function send(): Promise<void> {
  const classified = classifyInput(composer.value())
  if (classified.kind === 'empty') return
  composer.clear()
  closeCompletions()

  try {
    if (classified.kind === 'command') {
      // A slash command runs host-side; an unknown one still comes back handled,
      // with the explanation arriving as a `write-line` effect beforehand.
      const result = await client.runCommand(classified.line)
      if (result.exit) window.close()
      // The command set can change under us (`/skills reload`), so re-read it.
      void refreshCommands()
      return
    }
    await client.submit(classified.text)
  } catch (error) {
    note(`Failed: ${describe(error)}`, 'error')
  } finally {
    composer.focus()
  }
}

/**
 * Hands the composer's text to the host's queue instead of starting a turn.
 *
 * A slash command is *not* queued — it runs immediately. Commands are not prompts:
 * `SessionController.submit` is not involved, so there is nothing to wait behind,
 * and queueing `/model` until the turn ended would be a surprising delay on
 * something the user expects to take effect now. (`keymap.ts` never routes a
 * command here anyway — the dropdown degrades Enter to accept-only mid-turn — but
 * the button path can, so the branch has to exist.)
 *
 * The composer is cleared optimistically, then restored on failure: the strip is
 * driven by the host's `queued-messages` event, so leaving the text in place until
 * the round trip lands would show the message twice.
 */
async function queueMessage(): Promise<void> {
  const classified = classifyInput(composer.value())
  if (classified.kind === 'empty') return
  if (classified.kind === 'command') {
    await send()
    return
  }

  const text = classified.text
  composer.clear()
  closeCompletions()
  try {
    await client.enqueueMessage(text)
  } catch (error) {
    composer.setValue(text, text.length)
    note(`Failed to queue: ${describe(error)}`, 'error')
  } finally {
    composer.focus()
  }
}

async function refreshCommands(): Promise<void> {
  try {
    commands = await client.listCommands()
  } catch {
    // Completion is a convenience; losing it must not break the composer.
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// --- startup ----------------------------------------------------------------

void (async () => {
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

  status.render(client.getSnapshot(), client.getCost())
  const runtime = client.getRuntimeSnapshot()
  if (runtime) status.renderRuntime(runtime)
  // Only after `hello()` resolves, which is what makes the window title an
  // end-to-end proof readable from outside the process.
  status.renderSession(hello.session)
  boundSessionId = hello.session.id
  // Which project this window belongs to, so the bar can tell its own tabs from
  // another project's. `projectRoot`, not `cwd`: the pane list carries the
  // normalized key, and on Windows the raw path may differ in case.
  ownProjectRoot = hello.projectRoot
  composer.setStreaming(client.getSnapshot().isStreaming)

  // Whatever the last window left waiting. The queue is replayed from the session
  // log, so this is not always empty even on a cold start.
  queued = hello.queuedMessages
  renderQueue()

  await refreshCommands()

  // Best-effort initial load. The bar's first render still works without it:
  // a single pane (this one) is implied, and a `pane-list` event from another
  // open / close will arrive shortly after.
  try {
    panes = await client.listPanes()
  } catch {
    panes = Object.freeze([])
  }
  renderTabBar()

  if (hello.initialQueuedPrompt) {
    composer.setValue(hello.initialQueuedPrompt, hello.initialQueuedPrompt.length)
  }
  composer.focus()
})().catch((error) => {
  note(`Failed to start: ${describe(error)}`, 'error')
})
