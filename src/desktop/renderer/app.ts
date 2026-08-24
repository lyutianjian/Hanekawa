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
 * renderer-local act (the sidebar never asks the host to focus anything) —
 * which is the whole point of the single-window design: a background pane
 * keeps streaming and its prompts keep parking until the user comes back.
 *
 * It also owns the three pieces of bookkeeping that make the sidebar and the
 * resident-pane budget work, and that nothing else can hold: which lane was
 * activated when, each lane's last streaming state (the falling edge is the cue
 * to re-read the history), and the last pulled session list. The *decisions*
 * over that state live in `model/sidebar.ts` and `../paneBudget.ts`.
 */

import { createBridgeChannel } from './bridgeChannel.js'
import { createPaneSession, type PaneSession } from './paneSession.js'
import { ShellClient } from './shellClient.js'
import { SHELL_LANE } from '../shellProtocol.js'
import { DEFAULT_PANE_LIMIT, selectEvictions, type PaneBudgetEntry } from '../paneBudget.js'
import { createLaneMux } from '../../runtime/protocol/laneChannel.js'
import { resolveKey, type ShellState } from './model/keymap.js'
import {
  createSidebarState,
  moveSelection,
  selectWorkspaceIntent,
  sidebarChordToIntent,
  sidebarKeyToIntent,
  sidebarView as buildSidebarView,
  type SidebarIntent,
  type SidebarLaneStatus,
  type SidebarProjectSessions,
  type SidebarState,
} from './model/sidebar.js'
import { rewindKeyToIntent } from './model/rewindPanel.js'
import {
  applySettingsIntent,
  createSettingsState,
  loadSettings,
  runSettingsChanges,
  settingsChordToIntent,
  settingsKeyToIntent,
  settingsView,
  type SettingsIntent,
} from './model/settings.js'
import type { SettingsChange } from '../shellProtocol.js'
import {
  THEME_STORAGE_KEY,
  parseThemePreference,
  resolveTheme,
  systemThemeFromMatches,
  type ThemePreference,
} from './model/theme.js'
import { required } from './dom/dom.js'
import { createSettingsView } from './dom/settingsView.js'
import { createOverlayView } from './dom/overlayView.js'
import { createRewindView } from './dom/rewindView.js'
import { createSurfacePanel } from './dom/surfaceView.js'
import { createQueueView } from './dom/queueView.js'
import { createComposerView } from './dom/composerView.js'
import { createStatusView } from './dom/statusView.js'
import { createSuggestionsView } from './dom/suggestionsView.js'
import { createSidebarView } from './dom/sidebarView.js'

const bridge = window.hanekawa
if (!bridge) {
  document.body.textContent = 'Preload script not loaded; please reinstall the app.'
  throw new Error('Preload bridge is missing')
}

// Theme. The preference lives in localStorage; the resolved theme is written to
// `documentElement.dataset.theme`, which the stylesheet reads. "Follow system"
// is resolved here (in JS), so the sheet stays flat token blocks — see
// `model/theme.ts`. A light-preference user sees a brief dark frame first (the
// bare `:root` default): CSP forbids an inline pre-paint script.
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)')
let themePreference: ThemePreference = parseThemePreference(localStorage.getItem(THEME_STORAGE_KEY))
function applyResolvedTheme(preference: ThemePreference): void {
  document.documentElement.dataset.theme = resolveTheme(preference, systemThemeFromMatches(darkQuery.matches))
}
applyResolvedTheme(themePreference)
darkQuery.addEventListener('change', () => {
  if (themePreference === 'system') applyResolvedTheme(themePreference)
})

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
  attach: required<HTMLButtonElement>('composer-attach'),
  chipModel: required<HTMLButtonElement>('chip-model'),
  chipEffort: required<HTMLButtonElement>('chip-effort'),
}, {
  // Both halves of the chip go through the pane's surface path, so they open
  // the same pickers `/model` and `/effort` do — and persist the choice the
  // same way. See `dom/composerView.ts`'s header for why not `setModel`.
  onOpenModelPicker: () => void activePane()?.openModelPicker(),
  onOpenEffortPicker: () => void activePane()?.openEffortPicker(),
  onAttach: () => activePane()?.onComposerInput(),
})
const form = required<HTMLFormElement>('input-row')
const sidebarContainer = required('sidebar')
const canvas = required('canvas')
const rewindPanel = createRewindView(required('rewind'), required('rewind-panel'), (intent) => {
  activePane()?.handleRewindIntent(intent)
})

// --- the pane sessions ----------------------------------------------------------

const transcriptArea = required('transcript-area')
/** One live pane per lane, in attach order; the last entry is the fallback on removal. */
const paneSessions = new Map<string, PaneSession>()
let activeLane: string | undefined

/**
 * When each lane was last activated. A monotonic counter rather than a clock,
 * because `paneBudget` orders on it and two activations inside a millisecond are
 * a real tie.
 */
const lastActiveTick = new Map<string, number>()
let tick = 0
/** Lanes already asked to close for budget reasons, so a repeat pass is a no-op. */
const evicting = new Set<string>()

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
      // Every pane repaints the sidebar, not just the active one: the badges are
      // per row, so a background pane starting a turn has to show up. Cached
      // state only — the view's own signature guard absorbs the ticks that
      // change nothing, and the filesystem pull hangs off `turn-end` below.
      renderSidebar()
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
  if (!lastActiveTick.has(lane)) lastActiveTick.set(lane, tick)

  // A finished turn is when the store's derived fields move — the title a
  // session gets from its first message, its `messageCount`, its `updatedAt`.
  // The event says so directly; watching `isStreaming` for a falling edge was a
  // per-lane map reconstructing a signal already on the wire. It also fires for
  // an aborted or failed turn, which move those fields too.
  session.client.onEvent((event) => {
    if (event.type !== 'turn-end') return
    void refreshSessions()
    // A pane pinned by its turn is evictable again the moment the turn ends.
    applyPaneBudget()
  })

  void session.start().catch((error) => {
    session.note(`Failed to start: ${describe(error)}`, 'error')
  })
}

function activateLane(lane: string): void {
  if (!paneSessions.has(lane) || activeLane === lane) return
  activePane()?.deactivate()
  activeLane = lane
  lastActiveTick.set(lane, ++tick)
  paneSessions.get(lane)!.activate()
  applyPaneBudget()
  renderSidebar()
}

function removePaneSession(lane: string): void {
  const session = paneSessions.get(lane)
  if (!session) return
  paneSessions.delete(lane)
  lastActiveTick.delete(lane)
  evicting.delete(lane)
  session.dispose()
  if (activeLane === lane) {
    activeLane = undefined
    // Nothing is active now; the composer showed the removed pane's draft.
    composer.clear()
    // The most recently *used* pane, not the most recently attached: the same
    // order `paneBudget` evicts by, so the fallback is the one the budget would
    // have protected.
    const next = [...paneSessions.keys()].sort(
      (a, b) => (lastActiveTick.get(b) ?? 0) - (lastActiveTick.get(a) ?? 0),
    )[0]
    if (next !== undefined) activateLane(next)
  }
  renderSidebar()
}

// --- the resident-pane budget ---------------------------------------------------

/** What each live lane contributes that no wire field carries. Built once per pass. */
function laneStatuses(): Map<string, SidebarLaneStatus> {
  const statuses = new Map<string, SidebarLaneStatus>()
  for (const [lane, session] of paneSessions) {
    statuses.set(lane, {
      streaming: session.client.getSnapshot().isStreaming,
      // `hasOverlay` is "a blocking request is drawn *or* parked" — the pane
      // folds every request into its queue whether or not it is painting.
      blocked: session.shellState().hasOverlay,
    })
  }
  return statuses
}

/**
 * Releases the coldest idle panes when too many are resident.
 *
 * Closing a pane is not closing a session: the session stays on disk and the
 * sidebar keeps its row, just without a lane. The decision is
 * `paneBudget.selectEvictions`, which never picks the active pane, one running a
 * turn, or one holding an unanswered prompt — the last because a pane's teardown
 * drains its bridge with a *denial*, so evicting it would fail the user's tool
 * call instead of asking about it.
 */
function applyPaneBudget(): void {
  const statuses = laneStatuses()
  const entries: PaneBudgetEntry[] = [...paneSessions.keys()].map((lane) => ({
    lane,
    active: lane === activeLane,
    streaming: statuses.get(lane)?.streaming ?? false,
    blocked: statuses.get(lane)?.blocked ?? false,
    lastActiveTick: lastActiveTick.get(lane) ?? 0,
  }))

  for (const lane of selectEvictions({ entries, limit: DEFAULT_PANE_LIMIT })) {
    if (evicting.has(lane)) continue
    const session = paneSessions.get(lane)
    const paneId = session?.client.getSession()?.id
    if (!session || paneId === undefined) continue
    evicting.add(lane)
    // Through the lane's own client, exactly like a close from the sidebar: it
    // reaches whichever `SessionWorkspace` owns the pane.
    void session.client.closePane(paneId).catch(() => {
      // The pane may already be gone; the `lanes` diff is the source of truth.
      evicting.delete(lane)
    })
  }
}

// --- the sidebar ----------------------------------------------------------------

/** History, as last pulled. Kept so a repaint never has to reach the host. */
let projects: readonly SidebarProjectSessions[] = []
let collapsed = false
let selectedIndex = -1
let pendingDelete: string | undefined
let searchQuery = ''
let workspaceMenuOpen = false
let sessionsInFlight = false
let sessionsAgain = false

function currentSidebarState(): SidebarState {
  return createSidebarState({
    projects,
    lanes: shellClient.getLanes(),
    laneStatus: laneStatuses(),
    activeLane,
    collapsed,
    selectedIndex,
    pendingDelete,
    now: Date.now(),
    // Both buttons open something, which is wrong while a blocking dialog is up.
    canCreate: !(activePane()?.shellState().hasOverlay ?? false),
    searchQuery,
    workspaceMenuOpen,
  })
}

function renderSidebar(): void {
  sidebar.render(buildSidebarView(currentSidebarState()))
}

/**
 * Pulls the session history, coalescing concurrent callers.
 *
 * This is the only thing in the renderer that reaches the filesystem, so it runs
 * on four occasions and no others: startup, a topology change, a turn ending, and
 * a delete. A second request while one is in flight is folded into one more pass
 * rather than queued — the answer is a whole snapshot, so only the last one
 * matters.
 */
async function refreshSessions(): Promise<void> {
  if (sessionsInFlight) {
    sessionsAgain = true
    return
  }
  sessionsInFlight = true
  try {
    do {
      sessionsAgain = false
      const result = await shellClient.listSessions()
      projects = result.projects
      renderSidebar()
    } while (sessionsAgain)
  } catch (error) {
    // Keep the last good list: a sidebar that empties itself on a transient
    // failure looks like the sessions were deleted.
    activePane()?.note(`Failed to list sessions: ${describe(error)}`, 'error')
  } finally {
    sessionsInFlight = false
  }
}

function closeLane(lane: string): void {
  const session = paneSessions.get(lane)
  const paneId = session?.client.getSession()?.id
  if (!session || paneId === undefined) return
  void session.client.closePane(paneId).catch((error) => session.note(describe(error), 'error'))
}

function runSidebarIntent(intent: SidebarIntent): void {
  switch (intent.kind) {
    case 'switch':
      // Every live row is a pane that already exists, so switching is local — no
      // `focus-pane` round trip, nothing for the host to do.
      activateLane(intent.lane)
      return
    case 'open':
      void shellClient
        .openSession({ sessionId: intent.sessionId, projectRoot: intent.projectRoot })
        .catch((error) => activePane()?.note(describe(error), 'error'))
      return
    case 'close':
      closeLane(intent.lane)
      return
    case 'new':
      // "New session" is a window-level act, so it goes to the shell, targeting
      // the active pane's project.
      void shellClient
        .openSession(intent.projectRoot !== undefined ? { projectRoot: intent.projectRoot } : {})
        .catch((error) => activePane()?.note(describe(error), 'error'))
      return
    case 'open-project':
      // The shell puts up a native directory picker; the new project's first
      // lane arrives as a `lanes` event once it is up.
      void shellClient.openProject().catch((error) => activePane()?.note(describe(error), 'error'))
      return
    case 'open-settings':
      runSettingsIntent({ kind: 'open' })
      return
    case 'toggle-collapse':
      collapsed = !collapsed
      renderSidebar()
      return
    case 'search':
      searchQuery = intent.query
      renderSidebar()
      return
    case 'toggle-workspace-menu':
      workspaceMenuOpen = !workspaceMenuOpen
      renderSidebar()
      return
    case 'select-workspace':
      // Close the menu first, then resolve to a switch or a new session through
      // the model — the same "open or create" decision a row makes.
      workspaceMenuOpen = false
      renderSidebar()
      runSidebarIntent(selectWorkspaceIntent(currentSidebarState(), intent.projectRoot))
      return
    case 'request-delete':
      pendingDelete = intent.sessionId
      renderSidebar()
      return
    case 'cancel-delete':
      if (pendingDelete === undefined) return
      pendingDelete = undefined
      renderSidebar()
      return
    case 'confirm-delete':
      void deleteSession(intent.projectRoot, intent.sessionId)
      return
    case 'move':
      selectedIndex = moveSelection(buildSidebarView(currentSidebarState()), intent.direction)
      renderSidebar()
      return
    case 'none':
      return
    default:
      // Exhaustiveness, the `commandSchema.ts` discipline. Without it this
      // switch compiles with a variant missing and silently does nothing — a
      // sidebar button that looks wired and is not. A warn rather than a throw
      // because this runs on a keystroke, and a dead intent should not take the
      // window down.
      assertNeverIntent(intent)
  }
}

function assertNeverIntent(value: never): void {
  console.warn('Unhandled sidebar intent', value)
}

/**
 * Deletes a session for good.
 *
 * The confirmation is withdrawn *before* the request rather than after: the row
 * is about to disappear, and leaving it asking while the delete is in flight
 * invites a second Enter.
 */
async function deleteSession(projectRoot: string, sessionId: string): Promise<void> {
  pendingDelete = undefined
  renderSidebar()
  try {
    await shellClient.deleteSession(projectRoot, sessionId)
  } catch (error) {
    activePane()?.note(`Failed to delete session: ${describe(error)}`, 'error')
  }
  // Always, even on failure: the host may have closed the lane before throwing.
  await refreshSessions()
}

// --- settings ---------------------------------------------------------------

/**
 * The settings screen. Window-level, like the sidebar — one instance, not one
 * per pane, because there is one `ConfigService` per *project* and the screen
 * can be pointed at a project none of the open lanes belong to.
 */
let settingsState = createSettingsState()
// Seed the model with the persisted theme so the appearance picker shows it.
settingsState = { ...settingsState, themePref: themePreference }

const settingsView_ = createSettingsView(
  required('settings'),
  (intent) => runSettingsIntent(intent),
  (chord) => {
    const intent = settingsKeyToIntent(chord, settingsState)
    if (intent.kind === 'none') return false
    runSettingsIntent(intent)
    return true
  },
)

function renderSettings(): void {
  canvas.classList.toggle('settings-open', settingsState.open)
  settingsView_.render(settingsView(settingsState))
}

function runSettingsIntent(intent: SettingsIntent): void {
  const outcome = applySettingsIntent(settingsState, intent)
  settingsState = outcome.state
  renderSettings()
  if (outcome.themePreference) {
    themePreference = outcome.themePreference
    localStorage.setItem(THEME_STORAGE_KEY, themePreference)
    applyResolvedTheme(themePreference)
  }
  if (outcome.load) void loadSettingsNow()
  if (outcome.changes) void runSettingsChangesNow(outcome.changes)
}

async function loadSettingsNow(): Promise<void> {
  settingsState = await loadSettings(shellClient, settingsState)
  renderSettings()
}

async function runSettingsChangesNow(changes: readonly SettingsChange[]): Promise<void> {
  settingsState = await runSettingsChanges(shellClient, settingsState, changes)
  renderSettings()
  // A provider edit can move the model every open lane runs on, and the status
  // bar reads it off the pane's own snapshot — which the host has already
  // re-posted from `refreshAfterConfigChange`. Nothing to pull here; the
  // sidebar is repainted only because the project list may have moved.
  renderSidebar()
}

const sidebar = createSidebarView(
  sidebarContainer,
  (intent) => runSidebarIntent(intent),
  (chord) => {
    const intent = sidebarKeyToIntent(chord, currentSidebarState())
    if (intent.kind === 'none') return false
    runSidebarIntent(intent)
    return true
  },
)

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

  // Sidebar chords are checked before the global keymap: a Ctrl+T is always
  // "new session" regardless of the active dialog, mirroring the browser's tab
  // behavior. Only safe because `sidebarChordToIntent` answers `'none'` for
  // anything without ctrl/meta — an unmodified key resolving there would shadow
  // every dialog in the window.
  //
  // That same modifier test is repeated here rather than left to the model, so a
  // plain keystroke never pays for `currentSidebarState()` — which walks every
  // pane and reads the composer draft once per pane, on every keypress while
  // typing.
  if (chord.ctrlKey || chord.metaKey) {
    // Settings first, and for the same reason: it answers `'none'` without
    // ctrl/meta, so a bare comma still reaches the composer.
    const settingsIntent = settingsChordToIntent(chord)
    if (settingsIntent.kind !== 'none') {
      event.preventDefault()
      runSettingsIntent(settingsIntent)
      return
    }
    const sidebarIntent = sidebarChordToIntent(chord, currentSidebarState())
    if (sidebarIntent.kind !== 'none') {
      event.preventDefault()
      runSidebarIntent(sidebarIntent)
      return
    }
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
  applyPaneBudget()
  renderSidebar()
  // A topology change is also a history change: a new draft appeared, or a
  // `/clear` moved a pane onto a session the last pull had never heard of.
  void refreshSessions()
})

shellClient.onActivate((lane) => activateLane(lane))

void (async () => {
  // Pull the topology rather than trusting early pushes: anything main posted
  // before the bridge listener existed was dropped by Electron, so a pane
  // created before this point reaches the renderer only through this call.
  //
  // The history pull is *not* repeated here: `panes()` applies the lane list
  // synchronously, which fires `onLanes` above, which already owns that trigger.
  const lanes = await shellClient.panes()
  for (const info of lanes) attachPaneSession(info.lane)
  const first = lanes[0]
  if (first) activateLane(first.lane)
  renderSidebar()
})().catch((error) => {
  document.body.textContent = `Failed to start: ${describe(error)}`
})

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
