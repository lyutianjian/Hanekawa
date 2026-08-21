import type { SessionControllerSnapshot } from '../../../runtime/sessionController.js'
import type { WireRuntimeSnapshot, WireUsageCost } from '../../../runtime/protocol/wire.js'

/**
 * The status bar.
 *
 * Split out of `composerView.ts` in 4e, when the composer grew its action bar
 * and the one file stopped being one thing.
 *
 * It no longer shows the model: that moved into the composer's chip, next to
 * the effort level it is always read together with. A second copy here would be
 * a second thing to keep in step with `renderRuntime`.
 */

export interface StatusView {
  render(snapshot: SessionControllerSnapshot, cost?: WireUsageCost): void
  renderRuntime(runtime: WireRuntimeSnapshot): void
  renderSession(session: { id: string; title?: string; messageCount?: number }): void
}

export function createStatusView(els: {
  mode: HTMLElement
  usage: HTMLElement
  cost: HTMLElement
  streaming: HTMLElement
  session: HTMLElement
}): StatusView {
  return {
    render(snapshot, cost) {
      els.streaming.textContent = snapshot.isStreaming
        ? `生成中${snapshot.spinnerSubText ? `：${snapshot.spinnerSubText}` : ''}`
        : '空闲'
      const total = snapshot.usage.total ?? { inputTokens: 0, outputTokens: 0 }
      els.usage.textContent = total.inputTokens === 0 && total.outputTokens === 0
        ? ''
        : `输入 ${format(total.inputTokens)} / 输出 ${format(total.outputTokens)}`
      // Absent rather than zero when the model has no complete pricing: "not
      // priced" and "free" are different answers, and the host already decided
      // which one this is (`resolveUsageWithCost`).
      els.cost.textContent = cost ? `${cost.currency} ${formatCost(cost.amount)}` : ''
    },

    renderRuntime(runtime) {
      els.mode.textContent = `模式：${runtime.permissionMode}`
    },

    renderSession(session) {
      const name = session.title ?? session.id
      // The window title is also the desktop shell's end-to-end proof: it is only
      // set after `hello()` returns, so reading it from outside the process shows
      // the whole chain worked.
      document.title = `Hanekawa — ${name}`
      els.session.textContent = name
    },
  }
}

function format(n: number): string {
  return n.toLocaleString('en-US')
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
