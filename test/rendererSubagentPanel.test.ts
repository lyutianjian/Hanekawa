import test from 'node:test'
import assert from 'node:assert/strict'

import { subagentEntries } from '../src/desktop/renderer/model/subagentPanel.js'
import type { TranscriptItem } from '../src/desktop/renderer/model/transcript.js'

function agent(id: string, overrides: Partial<TranscriptItem> = {}, tool: Partial<NonNullable<TranscriptItem['tool']>> = {}): TranscriptItem {
  return {
    id,
    kind: 'tool',
    text: id,
    toolName: 'Agent',
    tool: { displayName: 'explore agent', useSummary: `job ${id}`, ...tool },
    ...overrides,
  }
}

test('running sub-agents come first in start order, then the finished newest first', () => {
  const entries = subagentEntries([
    agent('a'),
    agent('b', { pending: true }),
    { id: 'r', kind: 'tool', text: 'Read', toolName: 'Read', tool: { displayName: 'Read', useSummary: 'x' } },
    agent('c'),
    agent('d', { pending: true }),
  ])
  assert.deepEqual(entries.map((entry) => [entry.id, entry.status]), [
    ['b', 'running'], ['d', 'running'], ['c', 'done'], ['a', 'done'],
  ])
})

test('an entry carries the task, the fuller reply without the model-facing notices, and the run', () => {
  const [entry] = subagentEntries([agent('a', {}, {
    task: '找到所有用法',
    content: '完整的回复，比摘要长。\n\n[Sub-agent output may be incomplete.]'
      + '\n\nAgent ID: explore-1. Use SendMessage with this agent_id to continue the same sub-agent.',
    durationMs: 41_000,
    agentType: 'explore',
    subagent: { subagentType: 'explore', model: 'opus', toolUseCount: 12, summary: '短摘要' },
  })])
  assert.equal(entry?.task, '找到所有用法')
  assert.equal(entry?.reply, '完整的回复，比摘要长。')
  assert.deepEqual(entry?.notes, ['输出可能不完整'])
  assert.equal(entry?.model, 'opus')
  assert.equal(entry?.toolCount, 12)
  assert.equal(entry?.agentType, 'explore')
  assert.equal(entry?.durationMs, 41_000)
})

test('a running entry shows its latest tool and live count; a background start notice yields to the run summary', () => {
  const [running] = subagentEntries([agent('a', { pending: true }, {
    startedAt: '2026-09-24T10:00:00.000Z',
    live: { tool: 'Read', summary: 'notes.txt', toolCount: 3 },
  })])
  assert.deepEqual(running?.live, { tool: 'Read', summary: 'notes.txt', toolCount: 3 })
  assert.equal(running?.toolCount, 3)
  assert.equal(running?.startedAt, Date.parse('2026-09-24T10:00:00.000Z'))

  const [background] = subagentEntries([agent('b', {}, {
    content: 'Started explore sub-agent "scan" in the background.',
    subagent: { subagentType: 'explore', summary: '后台跑完的完整报告：扫描了全部工具目录，列出了每一处调用和对应的文件路径。' },
  })])
  assert.equal(background?.reply, '后台跑完的完整报告：扫描了全部工具目录，列出了每一处调用和对应的文件路径。')
})
