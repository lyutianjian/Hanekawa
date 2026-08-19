import { basename, resolve } from 'node:path'
import { normalizeCaseForComparison } from '../utils/paths.js'
import type { SessionMeta } from '../sessions/service.js'
import type { WirePaneInfo } from './protocol/wire.js'
import type { SessionWorkspace } from './sessionWorkspace.js'
import type { RuntimeHost } from './types.js'

/**
 * Every project open in one process, and the pane bookkeeping that spans them.
 *
 * A {@link SessionWorkspace} is one project's panes; this is the tier above it —
 * the answer to "which projects are open", "which project owns this pane", and
 * "what does the whole tab topology look like". It exists because the Electron
 * main process cannot be tested (`app.requestSingleInstanceLock()` runs at module
 * top level, so `main.ts` cannot even be imported under plain node), and every
 * decision that used to live in a module-level variable there is a decision
 * nothing could cover. Windows, dialogs and channels stay in the shell; the
 * bookkeeping lives here.
 *
 * What is deliberately *not* here: `bootstrap()`. The shell owns the MCP trust
 * prompt and the error dialogs, so it builds the project and hands the assembled
 * halves to {@link ProjectDirectory.add}. That keeps this module free of the
 * filesystem and makes the tests plain object literals.
 */

/**
 * The slice of `SessionPane` this module touches, declared structurally for the
 * same reason `PaneRegistry` is (`protocol/host.ts`): it documents the surface
 * by type, and a test does not have to build a real pane — which would mean a
 * real controller, a real runtime slot and a real scope.
 *
 * `getSession()` rather than a stored id, because the id moves: `/clear` and
 * `/resume` retarget the controller, and the pane reads through to it.
 */
export interface PaneLike {
  getSession(): SessionMeta
}

/** The project half: a root to key on, and the one call that stops background work. */
export interface DirectoryProject {
  readonly cwd: string
  shutdown(reason: string): Promise<void>
}

/** The pane half. `closeAll` is the fixed-order teardown `SessionWorkspace` owns. */
export interface DirectoryWorkspace {
  list(): readonly PaneLike[]
  closeAll(): void
}

export interface ProjectEntry<
  P extends DirectoryProject = RuntimeHost,
  W extends DirectoryWorkspace = SessionWorkspace,
> {
  /**
   * The normalized key, not the path the caller passed. Kept on the entry so a
   * shell that wants to log or compare roots uses the same string the map does.
   */
  readonly root: string
  /** As the caller gave it, for display: `projectName` is derived from this. */
  readonly cwd: string
  readonly project: P
  readonly workspace: W
}

/**
 * Two roots are the same project when they resolve to the same path, modulo
 * case on the platforms where the filesystem does not care.
 *
 * `normalizeCaseForComparison` is `src/utils/paths.ts`'s, so this agrees with
 * the rest of the codebase about what "the same directory" means — the whole
 * point of a single key is that opening `C:\Repo` twice does not bootstrap a
 * second `ProjectRuntime` over the same `.myagent/`.
 */
export function projectRootKey(cwd: string): string {
  return normalizeCaseForComparison(resolve(cwd))
}

/**
 * A directory entry's display name.
 *
 * `basename` is empty for a filesystem root (`C:\`, `/`), so those fall back to
 * the path itself rather than rendering a nameless tab group.
 */
export function projectDisplayName(cwd: string): string {
  const resolved = resolve(cwd)
  return basename(resolved) || resolved
}

/**
 * The generic parameters default to the real types, so the shell writes
 * `new ProjectDirectory()` and gets `entry.project` typed as a full
 * `RuntimeHost` (it needs `store`, `openScope`, `initialModelKey`, …).
 *
 * A test writes `new ProjectDirectory<FakeProject, FakeWorkspace>()` and needs
 * **no `as unknown as`** — the constraints still check that the fake has the
 * members this class actually calls, which is exactly the compiler help a cast
 * would have thrown away.
 */
export class ProjectDirectory<
  P extends DirectoryProject = RuntimeHost,
  W extends DirectoryWorkspace = SessionWorkspace,
> {
  /** Insertion-ordered by construction (`Map`), which is "the order projects were opened". */
  private readonly entries_ = new Map<string, ProjectEntry<P, W>>()
  /** Roots whose teardown is in flight, so a second close is a no-op rather than a double shutdown. */
  private readonly closing = new Set<string>()

  get size(): number {
    return this.entries_.size
  }

  /**
   * Registers an already-bootstrapped project.
   *
   * Throws on a duplicate root instead of replacing: two `ProjectRuntime`s over
   * one `.myagent/` means two `SessionStore`s appending to the same JSONL files
   * and two MCP connection sets. A caller that wants "open or focus" checks
   * {@link get} first — which is what makes the shell's dialog path idempotent.
   */
  add(project: P, workspace: W): ProjectEntry<P, W> {
    const root = projectRootKey(project.cwd)
    if (this.entries_.has(root)) {
      throw new Error(`Project is already open: ${project.cwd}`)
    }
    const entry: ProjectEntry<P, W> = { root, cwd: project.cwd, project, workspace }
    this.entries_.set(root, entry)
    return entry
  }

  get(cwd: string): ProjectEntry<P, W> | undefined {
    return this.entries_.get(projectRootKey(cwd))
  }

  entries(): readonly ProjectEntry<P, W>[] {
    return [...this.entries_.values()]
  }

  /**
   * Which project owns a pane, by identity.
   *
   * A scan, for the reason `SessionWorkspace.paneForSession` scans: a derived
   * answer cannot go stale, and a shell has a handful of tabs. An index keyed by
   * session id would need re-keying on every `/clear`.
   */
  entryForPane(pane: PaneLike): ProjectEntry<P, W> | undefined {
    for (const entry of this.entries_.values()) {
      if (entry.workspace.list().includes(pane)) return entry
    }
    return undefined
  }

  /**
   * The one projection of panes onto the wire.
   *
   * Takes the panes to describe rather than reading them out of the workspaces,
   * because the shell's set is narrower: a pane is registered in its workspace
   * *before* its window exists, and a tab the user cannot focus must not be
   * listed. The caller passes what it has windows for, and this fills in the
   * project fields.
   *
   * Field by field, never a spread — `SessionPane` carries the controller and
   * the runtime slot (`WirePaneInfo`).
   */
  describe(panes: Iterable<PaneLike>): WirePaneInfo[] {
    const out: WirePaneInfo[] = []
    for (const pane of panes) {
      const entry = this.entryForPane(pane)
      if (!entry) continue
      const session = pane.getSession()
      const info: WirePaneInfo = {
        paneId: session.id,
        sessionId: session.id,
        projectRoot: entry.root,
        projectName: projectDisplayName(entry.cwd),
      }
      if (session.title !== undefined) info.sessionTitle = session.title
      out.push(info)
    }
    return out
  }

  /**
   * Closes every pane of one project, then shuts the project down.
   *
   * The order is load-bearing and the reverse is a resource leak: `closeAll()`
   * runs each pane's fixed four-step teardown (`interrupt('exit')` → controller
   * → slot → scope), and `shutdown()` is the only call that stops background
   * tasks and MCP clients. Shutting down first would tear the tools out from
   * under panes that are still draining.
   *
   * Idempotent, and re-entrant-safe: `before-quit` can arrive while the last
   * window's `'closed'` handler is already here.
   */
  async closeProject(entry: ProjectEntry<P, W>, reason: string): Promise<void> {
    if (this.closing.has(entry.root)) return
    if (this.entries_.get(entry.root) !== entry) return
    this.closing.add(entry.root)
    this.entries_.delete(entry.root)
    try {
      entry.workspace.closeAll()
      await entry.project.shutdown(reason)
    } finally {
      this.closing.delete(entry.root)
    }
  }

  /**
   * Every project, in parallel. `allSettled` so one misbehaving MCP server
   * cannot keep the process alive on the way out.
   */
  async shutdownAll(reason: string): Promise<void> {
    await Promise.allSettled(this.entries().map((entry) => this.closeProject(entry, reason)))
  }
}
