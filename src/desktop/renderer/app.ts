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
 * 3. Decisions live in `model/`, which is DOM-free and unit-tested; this file,
 *    `dom/` and `paneSession.ts` only turn those decisions into nodes and
 *    events. That split is mandatory rather than tidy — a `model/` module
 *    imported by a test is compiled in the base tsconfig program, which has no
 *    DOM lib.
 *
 * This file owns the window, not any conversation: the lane mux over the
 * bridge, one `ShellClient` on the `__shell` lane, one `PaneSession` per pane
 * lane, and the singleton views the *active* pane drives. Switching panes is a
 * renderer-local act (the tab bar never asks the host to focus anything) —
 * which is the whole point of the single-window design: a background pane
 * keeps streaming and its prompts keep parking until the user comes back.
 */

import { createBridgeChannel } from './bridgeChannel.js'
import { createPaneSession, type PaneSession } from './paneSession.js'
import { ShellClient } from './shellClient.js'
import { SHELL_LANE } from '../shellProtocol.js'
import { createLaneMux } from '../../runtime/protocol/laneChannel.js'
import { resolveKey, type ShellState } from './model/keymap.js'
import {
  createTabBarState,
  tabBarKeyToIntent,
  tabBarView as buildTabBarView,
  type TabBarIntent,
  type TabBarState,
} from './model/tabBar.js'
import { rewindKeyToIntent } from './model/rewindPanel.js'
import { required } from './dom/dom.js'
import { createOverlayView } from './dom/overlayView.js'
import { createRewindView } from './dom/rewindView.js'
import { createSurfacePanel } from './dom/surfaceView.js'
import { createQueueView } from './dom/queueView.js'
import { createComposerView, createStatusView, createSuggestionsView } from './dom/composerView.js'
import { createTabBarView } from './dom/tabBarView.js'

const bridge = window.hanekawa
if (!bridge) {
  document.body.textContent = 'Preload script not loaded; please reinstall the app.'
  throw new Error('Preload bridge is missing')
}

// One transport, many lanes: session traffic rides per-pane lanes untouched,
// and the reserved `__shell` lane speaks for the window.
const mux = createLaneMux(createBridgeChannel(bridge, window))
const shellClient = new ShellClient(mux.lane(SHELL_LANE))

// --- the singleton views ------------------------------------------------------

const overlay = createOverlayView(required('overlay'), required('overlay-panel'))
const surface = createSurfacePanel(required('surface'), (action) => {
  void activePane()?.runSurfaceAction(action)
})
const suggestions = createSuggestionsView(required('suggestions'))
const queueStrip = createQueueView(required('queue'), () => {
  void activePane()?.clearQueue()
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
const rewindPanel = createRewindView(required('rewind'), required('rewind-panel'), (intent) => {
  activePane()?.handleRewindIntent(intent)
})

// --- the pane sessions ----------------------------------------------------------

const transcriptArea = required('transcript-area')
/** One live pane per lane, in attach order; the last entry is the fallback on removal. */
const paneSessions = new Map<string, PaneSession>()
let activeLane: string | undefined

function activePane(): PaneSession | undefined {
  return activeLane !== undefined ? paneSessions.get(activeLane) : undefined
}

function attachPaneSession(lane: string): void {
  if (paneSessions.has(lane)) return
  const session = createPaneSession({
    lane,
    channel: mux.lane(lane),
    mount: transcriptArea,
    overlay,
    rewindPanel,
    surface,
    suggestions,
    queueStrip,
    status,
    composer,
    onShellChanged: () => {
      // The bar's active row follows the active pane's session, so only the
      // active pane's changes repaint it. Topology itself arrives on the shell
      // lane instead.
      if (session.isActive()) renderTabBar()
    },
    onExit: () => {
      // `/exit` closes this pane, not the window: the single window holds every
      // other lane, and `window.close()` would take them all down.
      const paneId = session.client.getSession()?.id
      if (paneId !== undefined) {
        void session.client.closePane(paneId).catch((error) => session.note(describe(error), 'error'))
      }
    },
    onClosed: () => removePaneSession(lane),
  })
  paneSessions.set(lane, session)
  void session.start().catch((error) => {
    session.note(`Failed to start: ${describe(error)}`, 'error')
  })
}

function activateLane(lane: string): void {
  if (!paneSessions.has(lane) || activeLane === lane) return
  activePane()?.deactivate()
  activeLane = lane
  paneSessions.get(lane)!.activate()
  renderTabBar()
}

function removePaneSession(lane: string): void {
  const session = paneSessions.get(lane)
  if (!session) return
  paneSessions.delete(lane)
  session.dispose()
  if (activeLane === lane) {
    activeLane = undefined
    // Nothing is active now; the composer showed the removed pane's draft.
    composer.clear()
    const next = [...paneSessions.keys()].at(-1)
    if (next !== undefined) activateLane(next)
  }
  renderTabBar()
}

// --- the tab bar ----------------------------------------------------------------

/**
 * The bar's data comes from the shell lane — the one place that knows the
 * whole topology, pane ids and lane keys together. `ownProjectRoot` is
 * deliberately absent: in a single window every row has a live client that can
 * close its own pane, so every row is closable.
 */
function currentTabBarState(): TabBarState {
  return createTabBarState(shellClient.getLanes(), activePane()?.client.getSession()?.id, undefined)
}

function renderTabBar(): void {
  tabBarView.render(buildTabBarView(currentTabBarState()))
}

function laneByPaneId(paneId: string): string | undefined {
  return shellClient.getLanes().find((lane) => lane.paneId === paneId)?.lane
}

function runTabBarIntent(intent: TabBarIntent): void {
  switch (intent.kind) {
    case 'switch': {
      // Every row is a pane that already exists, so switching is local — no
      // `focus-pane` round trip, nothing for the host to do.
      const lane = laneByPaneId(intent.paneId)
      if (lane !== undefined) activateLane(lane)
      else void shellClient.panes().catch(() => {})
      return
    }
    case 'close': {
      // The row's own lane owns the pane; its client reaches the workspace
      // that can actually close it (which may be another project's).
      const lane = laneByPaneId(intent.paneId)
      const session = lane !== undefined ? paneSessions.get(lane) : undefined
      if (session) {
        void session.client.closePane(intent.paneId).catch((error) => session.note(describe(error), 'error'))
      }
      return
    }
    case 'new':
      // "New tab" is a window-level act, so it goes to the shell — the same
      // path the 4b sidebar will use — with the active pane's project as the
      // target.
      void shellClient
        .openSession({ ...(activePane()?.ownProjectRoot ? { projectRoot: activePane()!.ownProjectRoot } : {}) })
        .catch((error) => activePane()?.note(describe(error), 'error'))
      return
    case 'open-project':
      // The shell puts up a native directory picker; the new project's first
      // lane arrives as a `lanes` event once it is up.
      void shellClient.openProject().catch((error) => activePane()?.note(describe(error), 'error'))
      return
  }
}

const tabBarView = createTabBarView(tabBarContainer, (intent) => {
  runTabBarIntent(intent)
})

// --- the global key handler -------------------------------------------------------

/** What the key map sees when no pane is active: nothing is open, nothing blocks. */
const EMPTY_SHELL_STATE: ShellState = {
  hasOverlay: false,
  hasRewind: false,
  hasSurface: false,
  completions: 'none',
  isStreaming: false,
  inputEmpty: true,
}

document.addEventListener('keydown', (event) => {
  const chord = {
    key: event.key,
    shiftKey: event.shiftKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
  }

  // Tab-bar shortcuts are checked before the global keymap: a Ctrl+T is
  // always "new tab" regardless of the active dialog, mirroring the browser's
  // behavior. The keymap only knows shell-level transitions.
  const tabBarIntent = tabBarKeyToIntent(chord, currentTabBarState())
  if (tabBarIntent.kind !== 'none') {
    event.preventDefault()
    runTabBarIntent(tabBarIntent)
    return
  }

  const pane = activePane()
  switch (resolveKey(chord, pane?.shellState() ?? EMPTY_SHELL_STATE)) {
    case 'overlay':
      event.preventDefault()
      pane?.handleOverlayKey(event)
      return
    case 'rewind':
      event.preventDefault()
      if (pane?.rewind) pane.handleRewindIntent(rewindKeyToIntent(chord, pane.rewind))
      return
    case 'accept-completion':
      event.preventDefault()
      void pane?.acceptCompletion('accept')
      return
    case 'submit-completion':
      event.preventDefault()
      void pane?.acceptCompletion('submit')
      return
    case 'move-completion-up':
      event.preventDefault()
      pane?.moveCompletion('up')
      return
    case 'move-completion-down':
      event.preventDefault()
      pane?.moveCompletion('down')
      return
    case 'close-completions':
      event.preventDefault()
      pane?.closeCompletions()
      return
    case 'close-surface':
      event.preventDefault()
      pane?.hideSurface()
      return
    case 'move-surface-up':
      event.preventDefault()
      pane?.moveSurfaceSelection('up')
      return
    case 'move-surface-down':
      event.preventDefault()
      pane?.moveSurfaceSelection('down')
      return
    case 'activate-surface':
      event.preventDefault()
      pane?.activateSurfaceRow()
      return
    case 'interrupt':
      event.preventDefault()
      void pane?.interrupt()
      return
    case 'submit':
      event.preventDefault()
      void pane?.send()
      return
    case 'enqueue':
      event.preventDefault()
      void pane?.queueMessage()
      return
    case 'newline':
    case 'none':
      return
  }
})

required<HTMLTextAreaElement>('input').addEventListener('input', () => {
  activePane()?.onComposerInput()
})

form.addEventListener('submit', (event) => {
  event.preventDefault()
  // Enter is handled by the global key map, which decides between sending and
  // queueing; this is the button path and it must reach the same verdict.
  void activePane()?.submitFromForm()
})

required<HTMLButtonElement>('stop').addEventListener('click', () => {
  void activePane()?.interrupt()
})

// --- startup --------------------------------------------------------------------

// Topology arrives as events from here on; the diff against the live sessions
// is what attaches new lanes and retires gone ones.
shellClient.onLanes((lanes) => {
  const live = new Set(lanes.map((info) => info.lane))
  for (const info of lanes) attachPaneSession(info.lane)
  for (const lane of [...paneSessions.keys()]) {
    if (!live.has(lane)) removePaneSession(lane)
  }
  renderTabBar()
})

shellClient.onActivate((lane) => activateLane(lane))

void (async () => {
  // Pull the topology rather than trusting early pushes: anything main posted
  // before the bridge listener existed was dropped by Electron, so a pane
  // created before this point reaches the renderer only through this call.
  const lanes = await shellClient.panes()
  for (const info of lanes) attachPaneSession(info.lane)
  const first = lanes[0]
  if (first) activateLane(first.lane)
})().catch((error) => {
  document.body.textContent = `Failed to start: ${describe(error)}`
})

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
