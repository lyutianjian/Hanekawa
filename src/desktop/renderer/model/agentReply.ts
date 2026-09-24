/**
 * The Agent tool's result is written for the parent model: after the
 * sub-agent's report it appends notices the model acts on (the continuation
 * id it passes to SendMessage, the worktree it may inspect, a truncation
 * warning). The reader gets the report alone, with each notice as a short
 * Chinese note under it.
 *
 * Every pattern here mirrors a formatter in `src/tools/AgentTool/AgentTool.ts`;
 * the renderer may not import `tools/`, so the formats are duplicated.
 */

export interface AgentReply {
  readonly text: string
  /** Quiet notes drawn under the reply, in reading order. */
  readonly notes: readonly string[]
}

/** Mirror of `appendAgentContinuationNotice`. Dropped: the id is the model's. */
const CONTINUATION = /\n*Agent ID: \S+\. Use SendMessage with this agent_id to continue the same sub-agent\.\s*$/

/** Mirror of `formatWorktreeNotice`, appended by `appendWorktreeNoticeToToolResult`. */
const WORKTREE = /\n*Worktree: (.+)\nBase ref: (.+)\nChange summary:\n[\s\S]*$/

/** Mirror of `appendTruncationNotice`. */
const INCOMPLETE = /\n*\[Sub-agent output may be incomplete(: model stopped because it reached max output tokens)?\.\]\s*$/

/** Mirror of `applyAgentResultBudget`. */
const BUDGET = /\n*\[Tool result truncated: exceeded (\d+) chars; original (\d+) chars\]\s*$/

/** Mirror of the background start line in `AgentTool.execute`. */
const BACKGROUND_START = /^Started (\S+) sub-agent "([\s\S]*)" in the background\.$/

/**
 * Peels the notices off the end of an Agent result, last appended first.
 * A notice that sits under anything the pattern does not know (a subagentStop
 * hook's output) stays in the text rather than being guessed at.
 */
export function splitAgentReply(content: string): AgentReply {
  let text = content.replace(CONTINUATION, '')
  const notes: string[] = []

  const worktree = WORKTREE.exec(text)
  if (worktree !== null) {
    notes.unshift(`在 worktree 中运行 · ${worktree[1]}（基于 ${worktree[2]}）`)
    text = text.slice(0, worktree.index)
  }
  const incomplete = INCOMPLETE.exec(text)
  if (incomplete !== null) {
    notes.unshift(incomplete[1] === undefined ? '输出可能不完整' : '达到输出上限，输出可能不完整')
    text = text.slice(0, incomplete.index)
  }
  const budget = BUDGET.exec(text)
  if (budget !== null) {
    notes.unshift(`回复过长，只保留前 ${budget[1]} 字（原 ${budget[2]} 字）`)
    text = text.slice(0, budget.index)
  }

  const started = BACKGROUND_START.exec(text.trim())
  if (started !== null) text = `已在后台启动 ${started[1]} 子代理「${started[2]}」。`
  return { text: text.trimEnd(), notes }
}
