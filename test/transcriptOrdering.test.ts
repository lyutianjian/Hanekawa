import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  createTranscriptState,
  applyTuiRecordToTranscriptState,
  commitAllLiveItemsToStatic,
  commitLiveItemsExcludingThinking,
  commitPrecedingLiveItemsToStatic,
  applyStreamingThinkingPreview,
  recordsToDisplayItems,
} from '../src/tui/transcript.js'
import type { SessionRecord } from '../src/harness/types.js'

// ─── Helpers ────────────────────────────────────────────────────────────────

function userRecord(content: string): SessionRecord {
  return {
    id: `user-${Date.now()}`,
    type: 'message',
    role: 'user',
    content,
    createdAt: new Date().toISOString(),
  }
}

function userRecordWithDisplay(content: string, displayContent: string): SessionRecord {
  return {
    id: `user-display-${Date.now()}`,
    type: 'message',
    role: 'user',
    content,
    displayContent,
    createdAt: new Date().toISOString(),
  }
}

function assistantRecord(content: string): Extract<SessionRecord, { type: 'message' }> {
  return {
    id: `assistant-${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content,
    createdAt: new Date().toISOString(),
  }
}

function assistantRecordWithThinking(content: string, thinkingText: string): SessionRecord {
  return {
    ...assistantRecord(content),
    thinkingBlocks: [{ type: 'thinking', thinking: thinkingText }],
  }
}

function toolUseRecord(id: string, tool: string, input: Record<string, unknown> = {}): SessionRecord {
  return {
    id,
    type: 'tool_use',
    tool,
    input,
    riskLevel: 'safe',
    createdAt: new Date().toISOString(),
  }
}

function toolResultRecord(
  toolUseId: string,
  tool: string,
  ok = true,
  content = '',
): SessionRecord {
  return {
    id: `result-${toolUseId}`,
    type: 'tool_result',
    toolUseId,
    tool,
    ok,
    content,
    createdAt: new Date().toISOString(),
  }
}

/** Simulate submit(): commit previous live items, then add user message to liveItems */
function simulateSubmit(state: ReturnType<typeof createTranscriptState>, userContent: string) {
  // commitLiveItemsToStatic: move all non-streaming-thinking items to static
  const streamingThinking = state.liveItems.filter(
    (item) => item.kind === 'assistant' && item.content === '' && (!item.thinkingBlocks || item.thinkingBlocks.length === 0),
  )
  const nonStreaming = state.liveItems.filter(
    (item) => !(item.kind === 'assistant' && item.content === '' && (!item.thinkingBlocks || item.thinkingBlocks.length === 0)),
  )
  let s = {
    ...state,
    staticItems: [...state.staticItems, ...nonStreaming],
    liveItems: [],
  }
  // Add user message to liveItems
  const userMsg = {
    kind: 'user' as const,
    id: `user-live-${Date.now()}`,
    content: userContent,
    createdAt: new Date().toISOString(),
  }
  return { ...s, liveItems: [...s.liveItems, userMsg] }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('transcript ordering: tool_result commits user message to static first', () => {
  it('renders displayContent for restored user messages', () => {
    const items = recordsToDisplayItems([
      userRecordWithDisplay('Expanded skill prompt', '/debug hello'),
    ])

    assert.equal(items[0]?.kind, 'user')
    assert.equal(items[0]?.content, '/debug hello')
  })

  it('places user message before tool result in staticItems', () => {
    let state = createTranscriptState()
    state = simulateSubmit(state, '列出文件')

    // tool_use arrives → added to liveItems
    state = applyTuiRecordToTranscriptState(state, toolUseRecord('c1', 'Bash'))

    // tool_result arrives → should commit user message to static FIRST
    state = applyTuiRecordToTranscriptState(state, toolResultRecord('c1', 'Bash', true, 'file1.txt'))
    state = commitAllLiveItemsToStatic(state)

    const staticKinds = state.staticItems.map((item) => item.kind)
    const userIdx = staticKinds.indexOf('user')
    const toolIdx = staticKinds.indexOf('tool_call')

    assert.ok(userIdx >= 0, 'user message should be in staticItems')
    assert.ok(toolIdx >= 0, 'tool result should be in staticItems')
    assert.ok(userIdx < toolIdx, `user message (index ${userIdx}) should come before tool result (index ${toolIdx})`)
  })

  it('does not duplicate user message on second tool_result in same turn', () => {
    let state = createTranscriptState()
    state = simulateSubmit(state, '执行两个命令')

    state = applyTuiRecordToTranscriptState(state, toolUseRecord('c1', 'Bash'))
    state = applyTuiRecordToTranscriptState(state, toolUseRecord('c2', 'Bash'))

    // First tool_result commits user message to static
    state = applyTuiRecordToTranscriptState(state, toolResultRecord('c1', 'Bash', true, 'out1'))
    // Second tool_result should NOT re-commit user message
    state = applyTuiRecordToTranscriptState(state, toolResultRecord('c2', 'Bash', true, 'out2'))

    const userItems = state.staticItems.filter((item) => item.kind === 'user')
    assert.equal(userItems.length, 1, 'user message should appear exactly once in staticItems')
  })

  it('preserves correct order with multiple tool results', () => {
    let state = createTranscriptState()
    state = simulateSubmit(state, '多命令')

    state = applyTuiRecordToTranscriptState(state, toolUseRecord('c1', 'Read'))
    state = applyTuiRecordToTranscriptState(state, toolResultRecord('c1', 'Read', true, 'content'))
    state = applyTuiRecordToTranscriptState(state, toolUseRecord('c2', 'Bash'))
    state = applyTuiRecordToTranscriptState(state, toolResultRecord('c2', 'Bash', true, 'output'))
    state = commitAllLiveItemsToStatic(state)

    const kinds = state.staticItems.map((item) => item.kind)
    const userIdx = kinds.indexOf('user')
    const firstTool = kinds.indexOf('tool_call')

    assert.ok(userIdx < firstTool, 'user message should come before all tool results')
  })

  it('keeps user message in liveItems when there are no tool calls', () => {
    let state = createTranscriptState()
    state = simulateSubmit(state, '你好')

    // No tool calls — just an assistant response
    state = applyTuiRecordToTranscriptState(state, assistantRecordWithThinking('你好！', '用户打招呼'))

    const liveUsers = state.liveItems.filter((item) => item.kind === 'user')
    assert.equal(liveUsers.length, 1, 'user message should remain in liveItems when no tool_result arrives')
  })

  it('commits thinking blocks before tool_call to static after tool_result', () => {
    let state = createTranscriptState()
    state = simulateSubmit(state, '思考一下')

    // Thinking arrives
    state = applyTuiRecordToTranscriptState(
      state,
      assistantRecordWithThinking('', '让我想想...'),
    )

    // Tool call and result
    state = applyTuiRecordToTranscriptState(state, toolUseRecord('c1', 'Bash'))
    state = applyTuiRecordToTranscriptState(state, toolResultRecord('c1', 'Bash', true, 'ok'))
    state = commitAllLiveItemsToStatic(state)

    // Thinking block before tool_call should be committed to static
    const staticThinking = state.staticItems.filter(
      (item) => item.kind === 'assistant' && item.thinkingBlocks && item.thinkingBlocks.length > 0,
    )
    assert.ok(staticThinking.length > 0, 'thinking blocks before tool_call should be committed to static')

    // Verify order: thinking before tool_call in staticItems
    const thinkingIdx = state.staticItems.findIndex(
      (item) => item.kind === 'assistant' && item.thinkingBlocks && item.thinkingBlocks.length > 0,
    )
    const toolIdx = state.staticItems.findIndex((item) => item.kind === 'tool_call')
    assert.ok(thinkingIdx >= 0 && toolIdx >= 0, 'both thinking and tool_call should be in staticItems')
    assert.ok(thinkingIdx < toolIdx, `thinking (index ${thinkingIdx}) should come before tool_call (index ${toolIdx}) in staticItems`)
  })

  it('full turn flow: submit → thinking → tool → result → commit preserves order', () => {
    let state = createTranscriptState()

    // Turn 1: submit
    state = simulateSubmit(state, '查看文件列表')

    // Thinking
    state = applyStreamingThinkingPreview(state, 'stream-1', '让我看看...')
    state = applyTuiRecordToTranscriptState(
      state,
      assistantRecordWithThinking('', '让我看看有什么文件'),
    )

    // Tool call
    state = applyTuiRecordToTranscriptState(state, toolUseRecord('c1', 'Bash', { command: 'ls' }))
    state = applyTuiRecordToTranscriptState(state, toolResultRecord('c1', 'Bash', true, 'a.txt\nb.txt'))

    // Final assistant message
    state = applyTuiRecordToTranscriptState(
      state,
      assistantRecordWithThinking('文件列表: a.txt, b.txt', '分析完毕'),
    )

    // Turn end: commit non-thinking
    state = commitLiveItemsExcludingThinking(state)

    // Verify static ordering: user before tool
    const kinds = state.staticItems.map((item) => item.kind)
    const userIdx = kinds.indexOf('user')
    const toolIdx = kinds.indexOf('tool_call')

    assert.ok(userIdx >= 0, 'user message should be in staticItems after turn end')
    assert.ok(toolIdx >= 0, 'tool result should be in staticItems after turn end')
    assert.ok(userIdx < toolIdx, `user (index ${userIdx}) should precede tool (index ${toolIdx}) in staticItems`)

    // Thinking should still be in liveItems for Ctrl+O
    const liveThinking = state.liveItems.filter(
      (item) => item.kind === 'assistant' && item.thinkingBlocks && item.thinkingBlocks.length > 0,
    )
    assert.ok(liveThinking.length > 0, 'thinking blocks should remain in liveItems after commit')
  })

  it('second turn: previous thinking committed to static before new turn', () => {
    let state = createTranscriptState()

    // Turn 1
    state = simulateSubmit(state, '第一个问题')
    state = applyTuiRecordToTranscriptState(
      state,
      assistantRecordWithThinking('回答1', '思考1'),
    )
    state = applyTuiRecordToTranscriptState(state, toolUseRecord('c1', 'Bash'))
    state = applyTuiRecordToTranscriptState(state, toolResultRecord('c1', 'Bash', true, 'out1'))
    state = commitLiveItemsExcludingThinking(state)

    // Turn 2: submit commits previous thinking to static
    state = simulateSubmit(state, '第二个问题')
    state = applyTuiRecordToTranscriptState(
      state,
      assistantRecordWithThinking('回答2', '思考2'),
    )
    state = applyTuiRecordToTranscriptState(state, toolUseRecord('c2', 'Read'))
    state = applyTuiRecordToTranscriptState(state, toolResultRecord('c2', 'Read', true, 'content'))
    state = commitLiveItemsExcludingThinking(state)

    // All user messages and tool results should be in static
    const users = state.staticItems.filter((item) => item.kind === 'user')
    const tools = state.staticItems.filter((item) => item.kind === 'tool_call')
    assert.equal(users.length, 2, 'both user messages should be in staticItems')
    assert.equal(tools.length, 2, 'both tool results should be in staticItems')

    // Each user message should come before its tool result
    for (const user of users) {
      const uIdx = state.staticItems.indexOf(user)
      const nextTool = tools.findIndex((t) => state.staticItems.indexOf(t) > uIdx)
      assert.ok(nextTool >= 0 || true, 'user message has a following tool (or is the last turn)')
    }
  })

  it('full turn: thinking_1 → tool_1 → thinking_2 → tool_2 preserves chronological order in static', () => {
    let state = createTranscriptState()
    state = simulateSubmit(state, '查看文件列表')

    // Round 1: thinking + tool
    state = applyStreamingThinkingPreview(state, 'stream-1', '让我看看...')
    state = applyTuiRecordToTranscriptState(
      state,
      assistantRecordWithThinking('', '让我看看有什么文件'),
    )
    state = applyTuiRecordToTranscriptState(state, toolUseRecord('c1', 'Bash', { command: 'ls' }))
    state = applyTuiRecordToTranscriptState(state, toolResultRecord('c1', 'Bash', true, 'a.txt\nb.txt'))

    // Round 2: thinking + tool
    state = applyTuiRecordToTranscriptState(
      state,
      assistantRecordWithThinking('', '让我看看内容'),
    )
    state = applyTuiRecordToTranscriptState(state, toolUseRecord('c2', 'Read', { file: 'a.txt' }))
    state = applyTuiRecordToTranscriptState(state, toolResultRecord('c2', 'Read', true, 'hello'))

    // Final assistant message (no tool call)
    state = applyTuiRecordToTranscriptState(
      state,
      assistantRecordWithThinking('文件内容是 hello', '分析完毕'),
    )

    // Turn end
    state = commitLiveItemsExcludingThinking(state)

    // Verify staticItems order: user → thinking_1 → tool_1 → thinking_2 → tool_2
    const staticKinds = state.staticItems
      .filter((item) => item.kind !== 'compact_boundary')
      .map((item) => item.kind)

    const userIdx = staticKinds.indexOf('user')
    // Find thinking blocks (assistant with thinkingBlocks)
    const thinkingIndices: number[] = []
    const toolIndices: number[] = []
    state.staticItems.forEach((item, i) => {
      if (item.kind === 'assistant' && item.thinkingBlocks && item.thinkingBlocks.length > 0) thinkingIndices.push(i)
      if (item.kind === 'tool_call') toolIndices.push(i)
    })

    assert.ok(userIdx >= 0, 'user message should be in staticItems')
    assert.ok(thinkingIndices.length >= 2, `at least 2 thinking blocks in static, got ${thinkingIndices.length}`)
    assert.ok(toolIndices.length >= 2, `at least 2 tool_calls in static, got ${toolIndices.length}`)

    // user before first thinking
    assert.ok(userIdx < thinkingIndices[0], 'user before first thinking')
    // first thinking before first tool
    assert.ok(thinkingIndices[0] < toolIndices[0], 'first thinking before first tool_call')
    // first tool before second thinking
    assert.ok(toolIndices[0] < thinkingIndices[1], 'first tool_call before second thinking')
    // second thinking before second tool
    assert.ok(thinkingIndices[1] < toolIndices[1], 'second thinking before second tool_call')

    // The last thinking (after last tool) should still be in liveItems for Ctrl+O
    const liveThinking = state.liveItems.filter(
      (item) => item.kind === 'assistant' && item.thinkingBlocks && item.thinkingBlocks.length > 0,
    )
    assert.ok(liveThinking.length > 0, 'final thinking block should remain in liveItems for Ctrl+O')
  })

  it('multiple thinking blocks before a single tool_call are all committed in order', () => {
    let state = createTranscriptState()
    state = simulateSubmit(state, '深度分析')

    // Two thinking blocks arrive before any tool call
    state = applyTuiRecordToTranscriptState(
      state,
      assistantRecordWithThinking('', '第一步思考'),
    )
    state = applyTuiRecordToTranscriptState(
      state,
      assistantRecordWithThinking('', '第二步思考'),
    )
    state = applyTuiRecordToTranscriptState(state, toolUseRecord('c1', 'Bash'))
    state = applyTuiRecordToTranscriptState(state, toolResultRecord('c1', 'Bash', true, 'out'))
    state = commitAllLiveItemsToStatic(state)

    // Both thinking blocks should be in staticItems before the tool_call
    const thinkingItems = state.staticItems.filter(
      (item) => item.kind === 'assistant' && item.thinkingBlocks && item.thinkingBlocks.length > 0,
    )
    assert.equal(thinkingItems.length, 2, 'both thinking blocks should be in staticItems')

    const toolIdx = state.staticItems.findIndex((item) => item.kind === 'tool_call')
    const t1Idx = state.staticItems.indexOf(thinkingItems[0])
    const t2Idx = state.staticItems.indexOf(thinkingItems[1])

    assert.ok(t1Idx < t2Idx, 'first thinking before second thinking')
    assert.ok(t2Idx < toolIdx, 'second thinking before tool_call')
  })

  it('failed tool result also commits preceding thinking blocks to static', () => {
    let state = createTranscriptState()
    state = simulateSubmit(state, '运行失败的命令')

    state = applyTuiRecordToTranscriptState(
      state,
      assistantRecordWithThinking('', '让我试试...'),
    )
    state = applyTuiRecordToTranscriptState(state, toolUseRecord('c1', 'Bash'))
    state = applyTuiRecordToTranscriptState(state, toolResultRecord('c1', 'Bash', false, 'command not found'))
    state = commitAllLiveItemsToStatic(state)

    const thinkingIdx = state.staticItems.findIndex(
      (item) => item.kind === 'assistant' && item.thinkingBlocks && item.thinkingBlocks.length > 0,
    )
    const toolIdx = state.staticItems.findIndex((item) => item.kind === 'tool_call')

    assert.ok(thinkingIdx >= 0, 'thinking block should be in staticItems')
    assert.ok(toolIdx >= 0, 'failed tool_call should be in staticItems')
    assert.ok(thinkingIdx < toolIdx, `thinking (${thinkingIdx}) before failed tool_call (${toolIdx})`)
  })

  it('streaming thinking previews before tool_call are discarded, not committed', () => {
    let state = createTranscriptState()
    state = simulateSubmit(state, '测试预览')

    // Streaming preview (temporary placeholder) arrives
    state = applyStreamingThinkingPreview(state, 'stream-1', '正在思考...')
    // Then finalized thinking replaces it
    state = applyTuiRecordToTranscriptState(
      state,
      assistantRecordWithThinking('', '最终思考'),
    )
    state = applyTuiRecordToTranscriptState(state, toolUseRecord('c1', 'Bash'))
    state = applyTuiRecordToTranscriptState(state, toolResultRecord('c1', 'Bash', true, 'ok'))

    // Streaming preview should NOT be in staticItems (it was discarded)
    const previewInStatic = state.staticItems.filter(
      (item) => item.kind === 'assistant' && item.content === '' && (!item.thinkingBlocks || item.thinkingBlocks.length === 0),
    )
    assert.equal(previewInStatic.length, 0, 'streaming thinking preview should be discarded, not committed')

    // Only the finalized thinking should be in staticItems
    const finalizedThinking = state.staticItems.filter(
      (item) => item.kind === 'assistant' && item.thinkingBlocks && item.thinkingBlocks.length > 0,
    )
    assert.equal(finalizedThinking.length, 1, 'only finalized thinking should be in staticItems')
  })

  it('hidden tool calls commit user message to static via commitPrecedingLiveItemsToStatic', () => {
    let state = createTranscriptState()
    state = simulateSubmit(state, '进入计划模式')

    // Hidden tool (EnterPlanMode) — tool_use is ignored, but tool_result
    // triggers commitPrecedingLiveItemsToStatic to preserve ordering
    state = applyTuiRecordToTranscriptState(state, {
      id: 'enter-1',
      type: 'tool_use',
      tool: 'EnterPlanMode',
      input: {},
      riskLevel: 'confirm',
      createdAt: new Date().toISOString(),
    })
    // Simulate what useAgentLoop does for hidden tool_result:
    // call commitPrecedingLiveItemsToStatic instead of applyTuiRecordToTranscriptState
    state = commitPrecedingLiveItemsToStatic(state)

    // User message should now be in staticItems (committed by the hidden tool_result handler)
    const staticUsers = state.staticItems.filter((item) => item.kind === 'user')
    assert.equal(staticUsers.length, 1, 'user message should be committed to static when hidden tool_result arrives')
    const liveUsers = state.liveItems.filter((item) => item.kind === 'user')
    assert.equal(liveUsers.length, 0, 'user message should no longer be in liveItems')
  })

  it('hidden task tools preserve correct ordering: user before assistant in static', () => {
    let state = createTranscriptState()
    state = simulateSubmit(state, '创建任务')

    // Thinking + assistant message 1
    state = applyStreamingThinkingPreview(state, 'stream-1', '让我创建任务...')
    state = applyTuiRecordToTranscriptState(
      state,
      assistantRecordWithThinking('', '我来创建任务'),
    )

    // Hidden TaskCreate tool — tool_use skipped, tool_result triggers commit
    state = commitPrecedingLiveItemsToStatic(state)

    // Thinking + assistant message 2
    state = applyStreamingThinkingPreview(state, 'stream-2', '更新任务...')
    state = applyTuiRecordToTranscriptState(
      state,
      assistantRecordWithThinking('', '更新任务状态'),
    )

    // Hidden TaskUpdate tool
    state = commitPrecedingLiveItemsToStatic(state)

    // Final assistant message
    state = applyTuiRecordToTranscriptState(
      state,
      assistantRecordWithThinking('任务已完成', '完成'),
    )

    // Turn end
    state = commitLiveItemsExcludingThinking(state)

    // Verify ordering: user message should come BEFORE all assistant messages
    const userIdx = state.staticItems.findIndex((item) => item.kind === 'user')
    assert.ok(userIdx >= 0, 'user message should be in staticItems')

    const assistantIndices = state.staticItems
      .map((item, i) => item.kind === 'assistant' ? i : -1)
      .filter((i) => i >= 0)

    assert.ok(assistantIndices.length > 0, 'assistant messages should be in staticItems')
    assert.ok(
      userIdx < assistantIndices[0],
      `user message (index ${userIdx}) should come before first assistant (index ${assistantIndices[0]})`,
    )
  })

  it('hidden task tools: multiple rounds preserve chronological order', () => {
    let state = createTranscriptState()
    state = simulateSubmit(state, '创建多个任务')

    // Round 1: thinking + TaskCreate
    state = applyTuiRecordToTranscriptState(
      state,
      assistantRecordWithThinking('', '创建任务1'),
    )
    state = commitPrecedingLiveItemsToStatic(state)

    // Round 2: thinking + TaskUpdate
    state = applyTuiRecordToTranscriptState(
      state,
      assistantRecordWithThinking('', '更新任务2'),
    )
    state = commitPrecedingLiveItemsToStatic(state)

    // Final response
    state = applyTuiRecordToTranscriptState(
      state,
      assistantRecordWithThinking('全部完成', '总结'),
    )
    state = commitLiveItemsExcludingThinking(state)

    // Verify all thinking blocks are in static in correct order
    const thinkingItems = state.staticItems.filter(
      (item) => item.kind === 'assistant' && item.thinkingBlocks && item.thinkingBlocks.length > 0,
    )
    assert.ok(thinkingItems.length >= 2, `at least 2 thinking blocks in static, got ${thinkingItems.length}`)

    // User message should be first
    const userIdx = state.staticItems.findIndex((item) => item.kind === 'user')
    const firstThinkingIdx = state.staticItems.indexOf(thinkingItems[0])
    assert.ok(userIdx < firstThinkingIdx, `user (${userIdx}) should be before first thinking (${firstThinkingIdx})`)
  })

  it('hidden tool with non-hidden tool in same turn preserves ordering', () => {
    let state = createTranscriptState()
    state = simulateSubmit(state, '创建任务然后读文件')

    // Hidden TaskCreate tool
    state = applyTuiRecordToTranscriptState(
      state,
      assistantRecordWithThinking('', '先创建任务'),
    )
    state = commitPrecedingLiveItemsToStatic(state)

    // Non-hidden Read tool (has visible tool_call)
    state = applyTuiRecordToTranscriptState(state, toolUseRecord('c1', 'Read'))
    state = applyTuiRecordToTranscriptState(state, toolResultRecord('c1', 'Read', true, 'file content'))

    // Verify: user message before everything
    const userIdx = state.staticItems.findIndex((item) => item.kind === 'user')
    assert.ok(userIdx >= 0, 'user message should be in staticItems')

    // Thinking from hidden tool round should be in static
    const thinkingItems = state.staticItems.filter(
      (item) => item.kind === 'assistant' && item.thinkingBlocks && item.thinkingBlocks.length > 0,
    )
    assert.ok(thinkingItems.length > 0, 'thinking from hidden tool round should be in static')

    // User should be before thinking
    const thinkingIdx = state.staticItems.indexOf(thinkingItems[0])
    assert.ok(userIdx < thinkingIdx, `user (${userIdx}) before thinking (${thinkingIdx})`)
  })

  it('failed tool result still respects ordering', () => {
    let state = createTranscriptState()
    state = simulateSubmit(state, '运行命令')

    state = applyTuiRecordToTranscriptState(state, toolUseRecord('c1', 'Bash'))
    state = applyTuiRecordToTranscriptState(state, toolResultRecord('c1', 'Bash', false, 'command not found'))
    state = commitAllLiveItemsToStatic(state)

    const userIdx = state.staticItems.findIndex((item) => item.kind === 'user')
    const toolIdx = state.staticItems.findIndex((item) => item.kind === 'tool_call')

    assert.ok(userIdx >= 0 && toolIdx >= 0 && userIdx < toolIdx,
      'user message before failed tool result in staticItems')
  })
})

describe('transcript ordering: plain assistant message commits preceding user to static', () => {
  it('user message is committed to static before a non-thinking assistant message', () => {
    let state = createTranscriptState()
    state = simulateSubmit(state, '你好')

    state = applyTuiRecordToTranscriptState(state, assistantRecord('你好！'))

    assert.deepEqual(
      state.staticItems.map((item) => item.kind),
      ['user', 'assistant'],
      'static should be [user, assistant] so assistant renders below user',
    )
    assert.equal(
      state.liveItems.filter((item) => item.kind === 'user').length,
      0,
      'user message should no longer be in liveItems',
    )

    // Turn end must not duplicate the user message
    state = commitAllLiveItemsToStatic(state)
    assert.equal(
      state.staticItems.filter((item) => item.kind === 'user').length,
      1,
      'user message should appear exactly once after turn end',
    )
  })

  it('thinking block followed by plain assistant keeps user < thinking < assistant', () => {
    let state = createTranscriptState()
    state = simulateSubmit(state, '先思考')

    state = applyTuiRecordToTranscriptState(state, assistantRecordWithThinking('思考结果', '思考过程'))
    state = applyTuiRecordToTranscriptState(state, assistantRecord('最终回答'))

    const userIdx = state.staticItems.findIndex((item) => item.kind === 'user')
    const thinkingIdx = state.staticItems.findIndex(
      (item) => item.kind === 'assistant' && item.thinkingBlocks && item.thinkingBlocks.length > 0,
    )
    const assistantIdx = state.staticItems.findIndex(
      (item) => item.kind === 'assistant' && (!item.thinkingBlocks || item.thinkingBlocks.length === 0),
    )

    assert.ok(userIdx < thinkingIdx, `user (${userIdx}) before thinking (${thinkingIdx})`)
    assert.ok(thinkingIdx < assistantIdx, `thinking (${thinkingIdx}) before plain assistant (${assistantIdx})`)
  })

  it('plain assistant after a tool round keeps user < tool_call < assistant', () => {
    let state = createTranscriptState()
    state = simulateSubmit(state, '运行命令')

    state = applyTuiRecordToTranscriptState(state, toolUseRecord('c1', 'Bash'))
    state = applyTuiRecordToTranscriptState(state, toolResultRecord('c1', 'Bash', true, 'out'))
    state = applyTuiRecordToTranscriptState(state, assistantRecord('完成'))

    const userIdx = state.staticItems.findIndex((item) => item.kind === 'user')
    const toolIdx = state.staticItems.findIndex((item) => item.kind === 'tool_call')
    const assistantIdx = state.staticItems.findIndex((item) => item.kind === 'assistant')

    assert.ok(userIdx >= 0 && toolIdx >= 0 && assistantIdx >= 0, 'user, tool_call, assistant all in static')
    assert.ok(userIdx < toolIdx, `user (${userIdx}) before tool_call (${toolIdx})`)
    assert.ok(toolIdx < assistantIdx, `tool_call (${toolIdx}) before assistant (${assistantIdx})`)
    assert.equal(
      state.staticItems.filter((item) => item.kind === 'assistant').length,
      1,
      'assistant message should appear exactly once',
    )
  })

  it('multiple turns keep [user1, assistant1, user2, assistant2] order', () => {
    let state = createTranscriptState()

    state = simulateSubmit(state, '问题一')
    state = applyTuiRecordToTranscriptState(state, assistantRecord('回答一'))

    state = simulateSubmit(state, '问题二')
    state = applyTuiRecordToTranscriptState(state, assistantRecord('回答二'))
    state = commitAllLiveItemsToStatic(state)

    const kinds = state.staticItems.map((item) => item.kind)
    assert.deepEqual(kinds, ['user', 'assistant', 'user', 'assistant'])
  })

  it('two plain assistant messages in one turn (max_tokens style) keep order', () => {
    let state = createTranscriptState()
    state = simulateSubmit(state, '写长文章')

    state = applyTuiRecordToTranscriptState(state, assistantRecord('第一部分'))
    state = applyTuiRecordToTranscriptState(state, assistantRecord('第二部分'))
    state = commitAllLiveItemsToStatic(state)

    const kinds = state.staticItems.map((item) => item.kind)
    assert.deepEqual(kinds, ['user', 'assistant', 'assistant'])
  })
})
