import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'

/**
 * `code <cwd>` — the canvas header's "open location".
 *
 * Its own module rather than a closure in `main.ts`, because `main.ts` has no
 * unit test (`app.requestSingleInstanceLock()` runs at import time) and the
 * platform branch below is exactly the kind of thing that is wrong in one
 * direction and silently fine in the other.
 *
 * Fixed to VS Code by the stage-5 decision table: no editor setting, no
 * `$EDITOR` lookup, one readable error when it is not installed.
 *
 * **Windows.** `code` there is `code.cmd`, which Node has refused to spawn
 * directly since 18.20 — so the command is `cmd.exe /c code "<cwd>"` with
 * `windowsVerbatimArguments`, and the path is quoted here by hand. That quoting
 * is safe rather than merely conventional: a Windows path cannot contain a
 * double quote, so the closing quote cannot be forged and `&` inside it stays
 * data. On POSIX there is no shell and the path is one `argv` entry.
 */

export interface SpawnOptions {
  detached: boolean
  stdio: 'ignore'
  windowsVerbatimArguments?: boolean
}

export type SpawnLike = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess

export interface OpenInEditorOptions {
  spawn?: SpawnLike
  /** Injected so both branches are testable from either host. */
  platform?: NodeJS.Platform
  /** The watchdog below. Exposed only so a test does not have to wait for it. */
  graceMs?: number
}

/** How long a launcher may stay alive before it is assumed to have worked. */
const DEFAULT_GRACE_MS = 5000

/**
 * Resolves once the editor has been launched, rejects when it cannot be.
 *
 * The verdict is `exit`, not `spawn`, and that is the whole reason this waits at
 * all: `code` is a launcher that hands the path to a running instance and
 * returns immediately, so its exit status is the answer. On Windows it is the
 * *only* answer available — the process that starts is `cmd.exe`, which starts
 * perfectly well whether or not `code` exists, so a `spawn`-based verdict would
 * report success for an editor that is not installed.
 *
 * The watchdog covers the other direction: a launcher that stays alive (an
 * editor started in the foreground) has plainly worked, and the renderer's
 * request must not hang waiting for it to exit.
 */
export function openInEditor(cwd: string, options: OpenInEditorOptions = {}): Promise<void> {
  const spawn = options.spawn ?? (nodeSpawn as unknown as SpawnLike)
  const windows = (options.platform ?? process.platform) === 'win32'

  return new Promise<void>((resolve, reject) => {
    const child = windows
      ? spawn('cmd.exe', ['/c', 'code', `"${cwd}"`], {
          detached: true,
          stdio: 'ignore',
          windowsVerbatimArguments: true,
        })
      : spawn('code', [cwd], { detached: true, stdio: 'ignore' })

    let settled = false
    const settle = (outcome: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(watchdog)
      outcome()
    }

    // Unreferenced: this timer must never be the reason the process stays up.
    const watchdog = setTimeout(() => {
      settle(() => {
        child.unref()
        resolve()
      })
    }, options.graceMs ?? DEFAULT_GRACE_MS)
    watchdog.unref?.()

    child.once('error', (error: NodeJS.ErrnoException) => {
      settle(() => reject(new Error(describeSpawnFailure(error))))
    })
    child.once('exit', (code: number | null) => {
      settle(() => {
        child.unref()
        if (code === 0 || code === null) resolve()
        else reject(new Error(NOT_INSTALLED))
      })
    })
  })
}

const NOT_INSTALLED =
  '找不到 VS Code 的 code 命令。请在 VS Code 里执行「Shell Command: Install \'code\' command in PATH」后重试。'

function describeSpawnFailure(error: NodeJS.ErrnoException): string {
  if (error.code === 'ENOENT') return NOT_INSTALLED
  return `无法打开 VS Code：${error.message}`
}
