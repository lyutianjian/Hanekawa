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
  completionsFor,
  moveCompletion,
  acceptCompletion,
  NO_COMPLETIONS,
  type CompletionState,
} from './model/commandRouting.js'
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
  backgroundTasksView,
  effortPickerView,
  isSupportedSurface,
  modelPickerView,
  resumePickerView,
  type SupportedSurface,
} from './model/surfaces.js'
import { required } from './dom/dom.js'
import { createTranscriptView } from './dom/transcriptView.js'
import { createOverlayView } from './dom/overlayView.js'
import { createSurfacePanel } from './dom/surfaceView.js'
import { createComposerView, createStatusView, createSuggestionsView } from './dom/composerView.js'
import { createTabBarView } from './dom/tabBarView.js'
import type { AskUserQuestionRequest, AskUserQuestionResult } from '../../harness/types.js'
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
const surface = createSurfacePanel(required('surface'))
const suggestions = createSuggestionsView(required('suggestions'))
const status = createStatusView({
  model: required('status-model'),
  mode: required('status-mode'),
  usage: required('status-usage'),
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
 * Maps a tab-bar intent to a side effect. The renderer never closes the
 * `BrowserWindow` itself — that is the host's job — so the host's
 * `SessionHost` is told via `client.closePane`, and the matching
 * `pane-list` event will fire after the workspace has dropped the pane.
 */
const tabBarView = createTabBarView(tabBarContainer, (intent) => {
  switch (intent.kind) {
    case 'switch':
      // Switching is a request to focus the clicked tab. Each renderer owns
      // exactly one pane (this one), so the only meaningful switch is to a
      // *different* session — that requires opening the other pane.
      void client.openPane({ sessionId: intent.paneId }).catch((error) =>
        note(describe(error), 'error'),
      )
      return
    case 'close':
      void client.closePane(intent.paneId).catch((error) => note(describe(error), 'error'))
      return
    case 'new':
      void client.openPane({}).catch((error) => note(describe(error), 'error'))
      return
  }
})

/**
 * Builds the bar's state from the wire panes list and the host's reported
 * active session. A pane is "active" when its session id matches the one
 * the host is bound to; that is the only sane answer on the renderer side
 * since each renderer is its own process.
 */
function currentTabBarState(): TabBarState {
  return createTabBarState(panes, client.getSession()?.id)
}

function renderTabBar(): void {
  tabBarView.render(buildTabBarView(currentTabBarState()))
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
    hasSurface: surface.isOpen(),
    hasCompletions: completions.suggestions.length > 0,
    isStreaming: client.getSnapshot().isStreaming,
    inputEmpty: composer.value().trim().length === 0,
  }
}

function renderTranscript(): void {
  transcriptView.render(transcript)
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
      surface.showCommandView(intent.view.title, intent.rows)
      return
    case 'open-surface':
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

async function openSurface(name: SupportedSurface): Promise<void> {
  try {
    switch (name) {
      case 'model-picker':
        surface.showSurface(modelPickerView(await client.listModels()))
        return
      case 'effort-picker': {
        const runtime = client.getRuntimeSnapshot()
        surface.showSurface(effortPickerView({
          current: runtime?.effort ?? '',
          ...(runtime?.maxEffort ? { maxEffort: runtime.maxEffort } : {}),
        }))
        return
      }
      case 'background-tasks':
        surface.showSurface(backgroundTasksView(await client.listBackgroundTasks()))
        return
      case 'resume-picker':
        surface.showSurface(resumePickerView({
          sessions: await client.listSessions(),
          ...(client.getSession() ? { currentSessionId: client.getSession()!.id } : {}),
        }))
        return
    }
  } catch (error) {
    note(`Could not open ${name}: ${describe(error)}`, 'error')
  }
}

client.subscribe(() => {
  const snapshot = client.getSnapshot()
  status.render(snapshot)
  composer.setStreaming(snapshot.isStreaming)
  const runtime = client.getRuntimeSnapshot()
  if (runtime) status.renderRuntime(runtime)
  const session = client.getSession()
  if (session) status.renderSession(session)
  // The active tab follows the session the host is bound to.
  renderTabBar()
})

// --- input ------------------------------------------------------------------

function refreshCompletions(): void {
  completions = completionsFor(composer.value(), commands)
  suggestions.render(completions)
}

function closeCompletions(): void {
  completions = NO_COMPLETIONS
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
      void client.openPane({ sessionId: tabBarIntent.paneId }).catch((error) => note(describe(error), 'error'))
    } else if (tabBarIntent.kind === 'close') {
      void client.closePane(tabBarIntent.paneId).catch((error) => note(describe(error), 'error'))
    } else if (tabBarIntent.kind === 'new') {
      void client.openPane({}).catch((error) => note(describe(error), 'error'))
    }
    return
  }

  switch (action) {
    case 'overlay':
      event.preventDefault()
      handleOverlayKey(event)
      return
    case 'accept-completion': {
      event.preventDefault()
      const applied = acceptCompletion(completions)
      if (applied) composer.setValue(applied.text, applied.cursorPos)
      closeCompletions()
      return
    }
    case 'submit-completion': {
      event.preventDefault()
      const applied = acceptCompletion(completions)
      closeCompletions()
      if (!applied) return
      // Accept *and* run, the way the terminal does; Tab is accept-only.
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
      surface.hide()
      return
    case 'interrupt':
      event.preventDefault()
      void client.interrupt('user-cancel').catch((error) => note(describe(error), 'error'))
      return
    case 'submit':
      event.preventDefault()
      void send()
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
  // Enter is handled by the global key map, which knows about the streaming gate;
  // this is the button path, and it must apply the same rule.
  if (client.getSnapshot().isStreaming) return
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

  status.render(client.getSnapshot())
  const runtime = client.getRuntimeSnapshot()
  if (runtime) status.renderRuntime(runtime)
  // Only after `hello()` resolves, which is what makes the window title an
  // end-to-end proof readable from outside the process.
  status.renderSession(hello.session)
  composer.setStreaming(client.getSnapshot().isStreaming)

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
