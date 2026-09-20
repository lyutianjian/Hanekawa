/**
 * Who is driving the browser: the agent, or the person watching it.
 *
 * The browser is the one tool whose surface the user shares with the model in
 * real time — they see the same tab and can touch it. So there has to be an
 * answer to "both at once", and the answer is that the person wins immediately:
 * a keystroke or a press inside the page, or the panel's「接管」button, blocks
 * the session that has been driving that tab until its *next* turn.
 *
 * Three decisions are worth stating, because none of them is the obvious one:
 *
 * - **Control is handed back, not merely waited out.** Sending the agent a new
 *   message returns it, and so does the panel's「交还」button; both land in
 *   `release`, so the two are one state and cannot disagree. The agent's next
 *   turn still lifts a block that nobody handed back — that is the floor, not
 *   the only way down.
 * - **A revision, not a flag.** Operations are already in flight when a takeover
 *   lands. Bumping a per-session revision invalidates them at their next
 *   checkpoint without anything having to hold a reference to them.
 * - **Nothing here touches Electron.** It is a state machine over five maps;
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

export class BrowserOwnership {
  /** The session that last addressed a tab — the one a takeover blocks. */
  private readonly tabOwner = new Map<string, string>()
  private readonly blocked = new Set<string>()
  private readonly revisions = new Map<string, number>()
  private readonly turns = new Map<string, string>()
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
    if (turnId === undefined || this.turns.get(sessionId) === turnId) {
      return { revision: current, released: [] }
    }

    this.turns.set(sessionId, turnId)
    const revision = current + 1
    this.revisions.set(sessionId, revision)
    const released = this.blocked.delete(sessionId) ? this.tabsOf(sessionId) : []
    return { revision, released }
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
   * It does not count while the agent is closing that tab, and it cannot count
   * for a tab no session has driven — there is nobody to block, and pretending
   * otherwise would leave a flag on a tab that never had an owner.
   */
  takeOver(tabId: string): boolean {
    if ((this.agentClosing.get(tabId) ?? 0) > 0) return false
    const owner = this.tabOwner.get(tabId)
    if (owner === undefined) return false
    this.blocked.add(owner)
    return true
  }

  /**
   * The user handed a tab back. Returns the tabs whose flag that cleared — the
   * owner's, all of them: the block is per session, so lifting it for one tab
   * lifts it for every tab that session was holding.
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
   * and closing the evidence is not how it gets undone.
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
