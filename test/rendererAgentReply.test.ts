import assert from 'node:assert/strict'
import test from 'node:test'
import { splitAgentReply } from '../src/desktop/renderer/model/agentReply.js'

const CONTINUE = 'Agent ID: general-1. Use SendMessage with this agent_id to continue the same sub-agent.'

test('splitAgentReply drops the continuation id and turns the other notices into notes', () => {
  assert.deepEqual(splitAgentReply(`报告\n\n${CONTINUE}`), { text: '报告', notes: [] })
  assert.deepEqual(splitAgentReply('报告'), { text: '报告', notes: [] })

  const full = [
    '报告',
    '[Tool result truncated: exceeded 100 chars; original 250 chars]',
    '[Sub-agent output may be incomplete: model stopped because it reached max output tokens.]',
    'Worktree: /tmp/wt/general-1\nBase ref: main\nChange summary:\n M a.ts\n?? b.ts',
    CONTINUE,
  ].join('\n\n')
  assert.deepEqual(splitAgentReply(full), {
    text: '报告',
    notes: [
      '回复过长，只保留前 100 字（原 250 字）',
      '达到输出上限，输出可能不完整',
      '在 worktree 中运行 · /tmp/wt/general-1（基于 main）',
    ],
  })
})

test('splitAgentReply translates the background start line', () => {
  assert.deepEqual(
    splitAgentReply(`Started general sub-agent "扫一遍 tools" in the background.\n\n${CONTINUE}`),
    { text: '已在后台启动 general 子代理「扫一遍 tools」。', notes: [] },
  )
})
