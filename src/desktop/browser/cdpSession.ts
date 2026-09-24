/**
 * A tab's debugger attachment, counted.
 *
 * CDP is attached on the first command and detached once nobody has needed it
 * for `CDP_IDLE_DETACH_MS`. Leaving it attached forever is what this replaces:
 * an attached debugger is the reason a user's DevTools fights the automation for
 * the channel, and it keeps the page in a state the user did not ask for.
 *
 * Users take a lease with `acquire()` for the whole of an action, not per
 * command, so a click's move/press/release — or a burst of actions — reuses one
 * attachment instead of attaching and detaching around every step. A lease can
 * also be held indefinitely by something that must not lose the attachment (an
 * emulation override dies with it); such a holder still loses it when the
 * debugger is taken away from outside, and has to take a fresh lease then.
 *
 * Electron-free: it is written against the few members of `WebContents` it
 * reads, so the counting can be asserted in a plain `node:test` process.
 */

import { BrowserHostError } from './errors.js'
import { CDP_IDLE_DETACH_MS } from './limits.js'

export interface CdpDebugger {
  isAttached(): boolean
  attach(protocolVersion?: string): void
  detach(): void
  sendCommand(method: string, commandParams?: any): Promise<any>
  on(event: 'detach', listener: (event: any, reason: string) => void): unknown
}

export interface CdpContents {
  readonly debugger: CdpDebugger
  isDestroyed(): boolean
  isDevToolsOpened(): boolean
  on(event: 'devtools-opened', listener: () => void): unknown
  on(event: 'destroyed', listener: () => void): unknown
}

export class CdpSession {
  private users = 0
  /**
   * Bumped whenever the attachment is lost. A lease taken before that cannot
   * release a count taken after it: the loss zeroes the count, and a stale
   * release decrementing a newer lease's count would detach under it.
   */
  private generation = 0
  private idle: NodeJS.Timeout | undefined

  constructor(
    private readonly contents: CdpContents,
    private readonly idleMs = CDP_IDLE_DETACH_MS,
  ) {
    // Detached from outside: DevTools took the target, the renderer went away,
    // or the target closed. Whatever held a lease no longer holds anything.
    contents.debugger.on('detach', () => this.lost())
    // Step aside rather than be kicked off mid-command; the next command is
    // refused for as long as DevTools stays open.
    contents.on('devtools-opened', () => {
      this.detach()
      this.lost()
    })
    contents.on('destroyed', () => this.lost())
  }

  /** Takes a lease; the returned function gives it back, once. */
  acquire(): () => void {
    this.cancelIdle()
    this.users++
    const epoch = this.generation
    let released = false
    return () => {
      if (released || epoch !== this.generation) return
      released = true
      this.users--
      if (this.users === 0) this.armIdle()
    }
  }

  /**
   * Which attachment a lease taken now belongs to. It changes each time the
   * attachment is lost, so a long-lived holder compares it to tell that its
   * lease — and whatever state rode on the attachment — is gone.
   */
  get epoch(): number {
    return this.generation
  }

  /** Whether the debugger is attached right now. For tests and diagnostics. */
  get attached(): boolean {
    return !this.contents.isDestroyed() && this.contents.debugger.isAttached()
  }

  readonly send = async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
    const contents = this.contents
    if (contents.isDestroyed()) {
      throw new BrowserHostError('PAGE_NOT_READY', 'The page is gone. Reload the tab and try again.', true)
    }
    if (contents.isDevToolsOpened()) throw devToolsOpen()
    try {
      if (!contents.debugger.isAttached()) contents.debugger.attach('1.3')
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new BrowserHostError(
        'PAGE_NOT_READY',
        `The browser could not open its input channel: ${detail}. If DevTools is open on this tab, ask the user to close it, then try again.`,
        true,
      )
    }
    // A command outside any lease still must not pin the attachment forever;
    // re-armed per command, so it never fires between two of them.
    if (this.users === 0) this.armIdle()
    try {
      return await contents.debugger.sendCommand(method, params ?? {})
    } catch (error) {
      if (contents.isDevToolsOpened()) throw devToolsOpen()
      const detail = error instanceof Error ? error.message : String(error)
      throw new BrowserHostError('PAGE_NOT_READY', `The input command ${method} failed: ${detail}`, true)
    }
  }

  private lost(): void {
    this.cancelIdle()
    this.users = 0
    this.generation++
  }

  private armIdle(): void {
    this.cancelIdle()
    this.idle = setTimeout(() => {
      this.idle = undefined
      this.detach()
    }, this.idleMs)
    // An idle detach is housekeeping; it must not keep the app alive at quit.
    this.idle.unref()
  }

  private cancelIdle(): void {
    if (this.idle === undefined) return
    clearTimeout(this.idle)
    this.idle = undefined
  }

  private detach(): void {
    if (this.contents.isDestroyed()) return
    try {
      if (this.contents.debugger.isAttached()) this.contents.debugger.detach()
    } catch {
      // Already gone between the check and the call; nothing is left to undo.
    }
  }
}

const sessions = new WeakMap<CdpContents, CdpSession>()

/** The one session per `WebContents`, created on first ask. */
export function cdpSessionFor(contents: CdpContents): CdpSession {
  let session = sessions.get(contents)
  if (session === undefined) {
    session = new CdpSession(contents)
    sessions.set(contents, session)
  }
  return session
}

function devToolsOpen(): BrowserHostError {
  return new BrowserHostError(
    'PAGE_NOT_READY',
    'DevTools is open on this tab, and the browser cannot drive a page while DevTools holds it. Ask the user to close DevTools, then try again.',
    true,
  )
}
