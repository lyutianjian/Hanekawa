import type { SessionMeta } from '../sessions/service.js'
import type { WirePaneInfo } from '../runtime/protocol/wire.js'

/**
 * The shell protocol: what the single desktop window's `__shell` lane carries.
 *
 * Session traffic (36 `HostCommand`s and their events) flows on per-pane lanes
 * untouched. This is the lane *beside* them — the one that speaks for the
 * window rather than for any one session, so the renderer can ask about and
 * steer the lane topology itself.
 *
 * Deliberately small. Commands answer "what lanes exist", "open or focus a
 * session as a lane", and "open a project"; events announce topology changes
 * and activation requests. Settings live here too in phase 4d — a settings
 * screen is a window-level surface, not a session view — which is why the lane
 * exists from the start rather than being bolted on later.
 *
 * The reply/fail envelopes are the same shapes `SessionClient` speaks, so the
 * renderer's shell client reuses `PendingRequests` and the fail path unchanged.
 * Only this file is shared with the renderer, so it must stay browser-safe:
 * type-only imports, no zod (the host-side schemas live in `shellHost.ts`),
 * no Node builtins.
 */

/**
 * The reserved lane key for shell traffic. Not a lane `ShellHost` mints — it
 * exists on both muxes from construction and no session may ever claim it.
 */
export const SHELL_LANE = '__shell'

/**
 * A wire pane plus the lane key it currently lives on.
 *
 * `paneId` (the session id) moves under `/clear` and `/resume`; the lane key
 * does not. Everything on the renderer that wants a stable handle on an open
 * session — tab rows, close buttons, activation — goes through `lane`.
 */
export interface WireLaneInfo extends WirePaneInfo {
  lane: string
}

// --- renderer → main ---------------------------------------------------------

export type ShellCommand =
  /** The full lane topology, across every open project. */
  | { type: 'panes'; id: string }
  /**
   * Opens a session as a lane, or focuses its existing lane. Without
   * `sessionId` a fresh draft is minted. `projectRoot` is the normalized key
   * the `lanes` events carry; omitted, the first open project answers.
   */
  | { type: 'open-session'; id: string; sessionId?: string; title?: string; projectRoot?: string }
  /**
   * Every session on disk, per project — the sidebar's history, which is a
   * superset of the lane topology (most sessions are not open).
   *
   * A pull rather than a pushed event: the renderer already refreshes on every
   * topology change and at turn end, and a push would either fire on every
   * snapshot tick or need its own change detection on the store.
   */
  | { type: 'list-sessions'; id: string }
  /**
   * Deletes a session: its lane if one is open, its three files, and its shadow
   * repo. `projectRoot` is required — sessions live per project, and guessing
   * would delete out of the wrong one.
   */
  | { type: 'delete-session'; id: string; projectRoot: string; sessionId: string }
  /**
   * Hands a directory to the shell, exactly like the `open-project` host
   * command: `ok` means accepted, not that a project is open — without `path`
   * the user still has a directory dialog to answer.
   */
  | { type: 'open-project'; id: string; path?: string }

// --- main → renderer ---------------------------------------------------------

export type ShellEvent =
  /**
   * The lane topology changed. Pushed on every open, close and session switch
   * (a switch moves `paneId` under a lane, which is a topology change even
   * though no lane opened or closed).
   */
  | { type: 'lanes'; lanes: WireLaneInfo[] }
  /**
   * A request that the renderer make `lane` the active pane. Activation is a
   * renderer concern in a single window — the main process can only ask.
   */
  | { type: 'activate'; lane: string }
  | { type: 'reply'; id: string; result: unknown }
  | { type: 'fail'; id: string; message: string }

// --- reply payloads ----------------------------------------------------------

export interface WireShellPanesResult {
  lanes: WireLaneInfo[]
}

export interface WireShellOpenSessionResult {
  lane: string
  pane: WireLaneInfo
}

/**
 * A session as the sidebar needs it: the four fields a row reads.
 *
 * Projected field by field rather than shipping `SessionMeta`, which was the
 * first attempt. `SessionMeta` is already a wire type elsewhere
 * (`WireSessionsResult`, `session-changed`) so reusing it looked free — but this
 * command answers with *every* session in *every* open project, and two of the
 * fields nobody here reads grow without bound: `checkpoints` gains an entry per
 * turn, and `denialState` accumulates streaks. At a few hundred sessions that is
 * hundreds of kilobytes `structuredClone`d across the preload boundary on every
 * pull, and retained for as long as the renderer holds the list.
 */
export interface WireSessionSummary {
  id: string
  title?: string
  updatedAt: string
  messageCount: number
}

/** One project's session history. */
export interface WireShellProjectSessions {
  projectRoot: string
  projectName: string
  sessions: WireSessionSummary[]
}

export interface WireShellSessionsResult {
  /** In the order projects were opened, which is `ProjectDirectory`'s order. */
  projects: WireShellProjectSessions[]
}

export interface WireShellDeleteSessionResult {
  ok: true
}

export interface WireShellOpenProjectResult {
  ok: true
}
