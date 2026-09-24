/**
 * The side panel's 「子代理」 tab: the session's sub-agents as a list, and one of
 * them as a page — its task and its reply.
 *
 * Rebuilt only when what it shows changed: the pane repaints on every stream
 * delta, and a page rebuilt under the reader would drop their selection. The one
 * thing that moves on its own is a running agent's clock, ticked in place.
 */

import { button } from './controls.js'
import { el, replace, type Child } from './dom.js'
import { markdownChildren } from './markdownView.js'
import type { SubagentEntry } from '../model/subagentPanel.js'
import { formatWorkedDuration, toolStatusLabel } from '../model/transcript.js'

export interface SubagentPanelModel {
  readonly entries: readonly SubagentEntry[]
  /** The run on its own page; `undefined` (or a run no longer listed) is the list. */
  readonly selected: string | undefined
}

export interface SubagentPanelView {
  render(model: SubagentPanelModel): void
}

export function createSubagentPanelView(
  container: HTMLElement,
  onSelect: (id: string | undefined) => void,
): SubagentPanelView {
  let drawn: string | undefined
  let page: string | undefined
  let clocks: Array<{ node: HTMLElement; startedAt: number }> = []
  let timer: ReturnType<typeof setInterval> | undefined

  function tick(): void {
    for (const clock of clocks) clock.node.textContent = formatWorkedDuration(Date.now() - clock.startedAt)
  }

  /** The run's time: fixed once it has one, counting while it runs. */
  function duration(entry: SubagentEntry): HTMLElement | undefined {
    if (entry.durationMs !== undefined) return el('span', 'subagent-time', formatWorkedDuration(entry.durationMs))
    if (entry.status !== 'running' || entry.startedAt === undefined) return undefined
    const node = el('span', 'subagent-time')
    clocks.push({ node, startedAt: entry.startedAt })
    return node
  }

  function meta(entry: SubagentEntry, withStatus: boolean): HTMLElement {
    const parts = [
      withStatus ? toolStatusLabel(entry.status) : undefined,
      entry.model,
      entry.toolCount === undefined ? undefined : `${entry.toolCount} 工具`,
    ].filter((part) => part !== undefined && part.length > 0)
    return el('div', 'subagent-meta', parts.join(' · '), duration(entry))
  }

  function heading(entry: SubagentEntry): Child[] {
    const bead = el('span', `step-bead ${entry.status}`)
    bead.setAttribute('aria-hidden', 'true')
    return [
      bead,
      el('span', 'subagent-name', entry.name),
      entry.agentType === undefined ? undefined : el('span', 'step-tag', entry.agentType),
    ]
  }

  function liveLine(entry: SubagentEntry): HTMLElement | undefined {
    if (entry.live === undefined) return undefined
    return el(
      'div',
      'step-live',
      el('span', 'step-live-arrow', '↳'),
      el('span', 'step-name', entry.live.tool),
      entry.live.summary.length > 0 ? el('span', 'step-summary', entry.live.summary) : undefined,
    )
  }

  function row(entry: SubagentEntry): HTMLElement {
    const node = button('subagent-row', '', `${entry.name} · ${entry.description} · ${toolStatusLabel(entry.status)}`, () => onSelect(entry.id))
    replace(
      node,
      el('div', 'subagent-title', ...heading(entry)),
      entry.description.length > 0 ? el('div', 'subagent-desc', entry.description) : undefined,
      meta(entry, false),
      liveLine(entry),
    )
    return node
  }

  function section(label: string, ...body: Child[]): HTMLElement {
    return el('section', 'subagent-section', el('div', 'subagent-label', label), ...body)
  }

  function detail(entry: SubagentEntry): Child[] {
    const running = entry.status === 'running' || entry.status === 'awaiting-approval'
    return [
      button('subagent-back', '← 全部子代理', '返回子代理列表', () => onSelect(undefined)),
      el('div', 'subagent-title', ...heading(entry)),
      entry.description.length > 0 ? el('div', 'subagent-desc', entry.description) : undefined,
      meta(entry, true),
      liveLine(entry),
      entry.task === undefined ? undefined : section('任务', el('div', 'md', ...markdownChildren(entry.task))),
      entry.reply !== undefined
        ? section(
            '回复',
            el('div', 'md', ...markdownChildren(entry.reply)),
            entry.notes.length === 0 ? undefined : el('div', 'subagent-notes', entry.notes.join(' · ')),
          )
        : running ? el('p', 'subagent-empty', '运行中，完成后在这里显示回复') : undefined,
    ]
  }

  function render(model: SubagentPanelModel): void {
    const entry = model.selected === undefined ? undefined : model.entries.find((e) => e.id === model.selected)
    const signature = JSON.stringify(entry ?? model.entries)
    if (signature === drawn) return
    drawn = signature
    clocks = []
    const nextPage = entry?.id
    if (entry !== undefined) replace(container, ...detail(entry))
    else if (model.entries.length === 0) replace(container, el('p', 'subagent-empty', '当前会话还没有子代理'))
    else replace(container, ...model.entries.map(row))
    if (nextPage !== page) container.scrollTop = 0
    page = nextPage
    tick()
    if (clocks.length > 0) timer ??= setInterval(tick, 1000)
    else if (timer !== undefined) {
      clearInterval(timer)
      timer = undefined
    }
  }

  return { render }
}
