/**
 * Who is driving the browser: nobody, the agent, or the person watching it.
 *
 * The browser is the one tool whose surface the user shares with the model in
 * real time — they see the same tab and can touch it. So each session that has
 * driven a tab is in one of three states, and every input the person makes is
 * read against it:
 *
 * - **idle** — the session has no turn running. The tab is the user's to use as
 *   they like: nothing they do is a takeover, because there is nothing to stop.
 *   It does mean the page may no longer be the one the agent last read, so the
 *   host drops that tab's snapshot and refs (`userInput` answers `stale`).
 * - **agent** — a turn is running and has used the browser. A press or a real
 *   keystroke in one of its tabs, or the panel's「接管」button, is the person
 *   reaching in, and moves the session to `user`. A wheel is only looking, and
 *   a lone modifier is not a keystroke.
 * - **user** — taken over. Every browser call the session makes is refused
 *   until the person hands control back (「交还」, or sending a message), which
 *   returns it to `agent`, or the turn ends, which returns it to `idle`.
 *
 * A turn starts on the first call that carries a turn the session was not seen
 * on (`observeTurn`) and ends when the runtime says so (`turnEnded`). Two more
 * decisions are worth stating:
 *
 * - **A revision, not a flag.** Operations are already in flight when a takeover
 *   lands or a turn ends. Bumping a per-session revision invalidates them at
 *   their next checkpoint without anything having to hold a reference to them.
 * - **Nothing here touches Electron.** It is a state machine over a few maps;
 *   `host.ts` calls it at each boundary, and the tests run it in-process.
 */

import { BrowserHostError } from './errors.js'

/**
 * The refusal the model reads.
 *
 * It is written as an instruction because it is one: a message the model must
 * obey is far more reliable sitting in the failed tool result it just caused
 * than in a system prompt it read a hundred turns ago.
 */
export const TAKEOVER_MESSAGE =
  'The user has manually taken over the browser. Stop browser actions and ask the user what they would like to do next. Do not retry during this turn; control returns when the user starts a new turn.'

/** What `observeTurn` found: the token later checks quote, and what it freed. */
export interface TurnObservation {
  revision: number
  /** Tabs whose takeover flag this turn cleared, for the panel to redraw. */
  released: string[]
}

/** Who is driving a session's tabs right now. */
export type BrowserDriver = 'idle' | 'agent' | 'user'

/**
 * What a person's input on a tab amounted to.
 *
 * - `takeover` — the owning session was mid-turn and is now blocked.
 * - `stale` — the owning session is idle; its reading of this page is no longer
 *   trustworthy and should be dropped.
 * - `ignored` — nothing to do: nobody owns the tab, it is already taken over,
 *   the agent is closing it, or the input was only looking.
 */
export type UserInputOutcome = 'takeover' | 'stale' | 'ignored'

export class BrowserOwnership {
  /** The session that last addressed a tab — the one a takeover blocks. */
  private readonly tabOwner = new Map<string, string>()
  private readonly blocked = new Set<string>()
  private readonly revisions = new Map<string, number>()
  private readonly turns = new Map<string, string>()
  /** Sessions whose turn is running (`agent`, or `user` when also blocked). */
  private readonly driving = new Set<string>()
  /** Sessions whose recorded turn has ended; a late call on it is refused. */
  private readonly ended = new Set<string>()
  /**
   * Tabs the agent is closing right now, reference counted.
   *
   * Closing a tab tears down its renderer, and a teardown is not a person
   * reaching for the keyboard. Counted rather than flagged because two closes
   * can overlap, and a plain flag would let the first one to finish uncover the
   * second.
   */
  private readonly agentClosing = new Map<string, number>()

  /**
   * Notes which turn a session is on, and returns the token its checks quote.
   *
   * A turn the session has not been seen on is a new turn: the block lifts and
   * the revision moves, which is what retires every operation still running from
   * the turn before.
   */
  observeTurn(sessionId: string, turnId?: string): TurnObservation {
    const current = this.revisions.get(sessionId) ?? 0
    // No turn at all is "nothing has changed": a caller outside a turn cannot
    // be the user asking for anything, so it neither lifts a block nor retires
    // the operations a real turn has in flight beside it.
    if (turnId === undefined) return { revision: current, released: [] }
    if (this.turns.get(sessionId) === turnId) {
      // The runtime already said this turn is over. A call still arriving on it
      // is a straggler, and letting it through would drive the browser while
      // the panel shows the session as idle.
      if (this.ended.has(sessionId)) {
        throw new BrowserHostError('OPERATION_ABORTED', 'The browser action belonged to a turn that has already ended.')
      }
      return { revision: current, released: [] }
    }

    this.turns.set(sessionId, turnId)
    this.ended.delete(sessionId)
    this.driving.add(sessionId)
    const revision = current + 1
    this.revisions.set(sessionId, revision)
    const released = this.blocked.delete(sessionId) ? this.tabsOf(sessionId) : []
    return { revision, released }
  }

  /**
   * The runtime finished the session's turn: back to `idle`.
   *
   * A takeover ends with it — it existed to stop that turn, and the next one
   * would lift it anyway — and the revision moves so anything the turn left
   * running stops at its next checkpoint. Returns the session's tabs, for the
   * panel to redraw; empty for a session that never touched the browser.
   */
  turnEnded(sessionId: string): string[] {
    if (!this.turns.has(sessionId)) return []
    this.ended.add(sessionId)
    this.driving.delete(sessionId)
    this.blocked.delete(sessionId)
    this.revisions.set(sessionId, (this.revisions.get(sessionId) ?? 0) + 1)
    return this.tabsOf(sessionId)
  }

  driver(sessionId: string): BrowserDriver {
    if (this.blocked.has(sessionId)) return 'user'
    return this.driving.has(sessionId) ? 'agent' : 'idle'
  }

  /** The state of the session driving this tab; `idle` for a tab nobody drives. */
  tabDriver(tabId: string): BrowserDriver {
    const owner = this.tabOwner.get(tabId)
    return owner === undefined ? 'idle' : this.driver(owner)
  }

  /**
   * The check every operation makes before dispatching and after every await.
   *
   * Two reasons to stop, distinguished because they mean different things to the
   * model: it was told to stand down, or its turn simply ended underneath it.
   */
  assertAllowed(sessionId: string, revision: number): void {
    if (this.blocked.has(sessionId)) {
      throw new BrowserHostError('BROWSER_USER_TAKEOVER', TAKEOVER_MESSAGE)
    }
    if ((this.revisions.get(sessionId) ?? 0) !== revision) {
      throw new BrowserHostError('OPERATION_ABORTED', 'The browser action belonged to a turn that has already ended.')
    }
  }

  /** Records that this session is the one driving the tab. */
  claim(tabId: string, sessionId: string): void {
    this.tabOwner.set(tabId, sessionId)
  }

  /**
   * The user took the tab. Returns whether it counted.
   *
   * It counts only while the tab's session is mid-turn (`agent`): an idle
   * session has nothing to stop, a tab no session has driven has nobody to
   * block, and a tab the agent is closing is firing its own teardown events.
   */
  takeOver(tabId: string): boolean {
    if ((this.agentClosing.get(tabId) ?? 0) > 0) return false
    const owner = this.tabOwner.get(tabId)
    if (owner === undefined || this.driver(owner) !== 'agent') return false
    this.blocked.add(owner)
    return true
  }

  /**
   * The person used the page itself. `intent` is a press or a real keystroke;
   * anything else (a wheel, a lone modifier) is only looking.
   */
  userInput(tabId: string, intent: boolean): UserInputOutcome {
    if ((this.agentClosing.get(tabId) ?? 0) > 0) return 'ignored'
    const owner = this.tabOwner.get(tabId)
    if (owner === undefined) return 'ignored'
    switch (this.driver(owner)) {
      case 'idle':
        return 'stale'
      case 'agent':
        return intent && this.takeOver(tabId) ? 'takeover' : 'ignored'
      case 'user':
        return 'ignored'
    }
  }

  /**
   * The user handed a tab back, returning its session to `agent`. Returns the
   * tabs whose flag that cleared — the owner's, all of them: the block is per
   * session, so lifting it for one tab lifts it for every tab that session was
   * holding.
   *
   * Empty when the tab has no owner or its owner was not blocked, which makes a
   * second release a no-op rather than a second redraw.
   */
  release(tabId: string): string[] {
    const owner = this.tabOwner.get(tabId)
    if (owner === undefined || !this.blocked.delete(owner)) return []
    return this.tabsOf(owner)
  }

  isBlocked(sessionId: string): boolean {
    return this.blocked.has(sessionId)
  }

  /** Brackets an agent-initiated close so its teardown is not read as a takeover. */
  expectAgentClose(tabId: string): () => void {
    this.agentClosing.set(tabId, (this.agentClosing.get(tabId) ?? 0) + 1)
    let done = false
    return () => {
      if (done) return
      done = true
      const left = (this.agentClosing.get(tabId) ?? 1) - 1
      if (left > 0) this.agentClosing.set(tabId, left)
      else this.agentClosing.delete(tabId)
    }
  }

  /**
   * The tab is gone. Its owner stays blocked if it was: the takeover happened,
   * and closing the evidence is not how it gets undone — the turn ending is.
   */
  dropTab(tabId: string): void {
    this.tabOwner.delete(tabId)
    this.agentClosing.delete(tabId)
  }

  tabsOf(sessionId: string): string[] {
    const tabs: string[] = []
    for (const [tabId, owner] of this.tabOwner) {
      if (owner === sessionId) tabs.push(tabId)
    }
    return tabs
  }
}
