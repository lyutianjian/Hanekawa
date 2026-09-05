import type { SessionControllerSnapshot } from '../../../runtime/sessionController.js'
import type { WireUsageCost } from '../../../runtime/protocol/wire.js'
import { statusUsageView } from '../model/usage.js'

/**
 * The status bar: usage, cost, and whether a turn is running.
 *
 * Split out of `composerView.ts` in 4e, when the composer grew its action bar
 * and the one file stopped being one thing. Two fields have since left it, both
 * for the same reason — one field, one place, or they drift:
 *
 * - the model, to the composer's chip beside the effort level it is read with;
 * - the permission mode (5e), to the composer's pill, beside the message it
 *   governs; and the session name, to the canvas header, which owns identity.
 *
 * `document.title` still happens here rather than in the header, and that is
 * deliberate: it is the desktop shell's end-to-end proof (the smoke driver reads
 * it from outside the process), and it means "a `hello()` came back" only as
 * long as it is written on the pane's path rather than off the lane list.
 */

export interface StatusView {
  render(snapshot: SessionControllerSnapshot, cost?: WireUsageCost): void
  renderSession(session: { id: string; title?: string; messageCount?: number }): void
}

export function createStatusView(els: {
  usage: HTMLElement
  cost: HTMLElement
  streaming: HTMLElement
}): StatusView {
  return {
    render(snapshot, cost) {
      // Empty while idle, not「空闲」: this line sits under the composer now, and
      // a permanent label for "nothing is happening" is noise the reference
      // builds do not carry (design_guidance 四.2).
      els.streaming.textContent = snapshot.isStreaming
        ? `生成中${snapshot.spinnerSubText ? `：${snapshot.spinnerSubText}` : ''}`
        : ''
      // Four numbers, not two: `model/usage.ts` owns which ones and how they
      // read. The hover carries the same counts unabbreviated.
      const usage = statusUsageView(snapshot.usage.total)
      els.usage.textContent = usage.text
      els.usage.title = usage.title
      // Absent rather than zero when the model has no complete pricing: "not
      // priced" and "free" are different answers, and the host already decided
      // which one this is (`resolveUsageWithCost`).
      els.cost.textContent = cost ? `${cost.currency} ${formatCost(cost.amount)}` : ''
    },

    renderSession(session) {
      const name = session.title ?? session.id
      // The window title is also the desktop shell's end-to-end proof: it is only
      // set after `hello()` returns, so reading it from outside the process shows
      // the whole chain worked.
      document.title = `Hanekawa — ${name}`
    },
  }
}

/**
 * Enough digits to see a cheap turn move the number, without a wall of zeros.
 *
 * Deliberately its own formatter rather than a shared one with `/cost`
 * (`commands/cost.ts`): that view has a whole row to fill and prints six
 * decimals, while this one sits in a status bar between four other fields.
 */
function formatCost(amount: number): string {
  if (amount === 0) return '0'
  if (amount < 0.01) return amount.toFixed(4)
  return amount.toFixed(2)
}
