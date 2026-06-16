import test, { afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { createElement as h } from 'react'
import { cleanup, render } from 'ink-testing-library'
import { ToolCallBlock } from '../src/tui/components/ToolCallBlock.js'
import { TaskListBlock } from '../src/tui/components/TaskListBlock.js'
import { Spinner } from '../src/tui/components/Spinner.js'
import { AskUserQuestionDialog } from '../src/tui/components/AskUserQuestionDialog.js'
import { ExitPlanModeDialog } from '../src/tui/components/ExitPlanModeDialog.js'
import { PermissionDialog } from '../src/tui/components/PermissionDialog.js'
import { ModelPickerDialog, type ModelPickerDecision, type ModelPickerOption } from '../src/tui/components/ModelPickerDialog.js'
import { RestoreMode, type RestoreDecision } from '../src/tui/components/RestoreMode.js'
import { MessageList, StaticDisplayItem } from '../src/tui/components/MessageList.js'
import { TranscriptView } from '../src/tui/components/TranscriptView.js'
import type { CheckpointDiffSummary, CheckpointWithDiff } from '../src/services/checkpoint/checkpointService.js'
import type { PermissionDecisionSource, PermissionRequest, PermissionRule } from '../src/harness/permissions.js'
import type { TaskDisplaySnapshot } from '../src/harness/types.js'
import type { RiskLevel, Tool, ToolResult } from '../src/harness/types.js'
import type { PermissionDialogState, TUIDisplayItem } from '../src/tui/types.js'

afterEach(() => cleanup())

test('ToolCallBlock renders compact task summary and task list snapshot', () => {
  const item: Extract<TUIDisplayItem, { kind: 'tool_call' }> = {
    kind: 'tool_call',
    id: 'tool-1',
    toolUseId: 'call-1',
    tool: 'TaskList',
    input: {},
    status: 'done',
    result: 'Remaining tasks (1):\n#1 [pending] Implement UI\n\nCompleted tasks (1):\n#2 [completed] Inspect CC',
    resultDisplay: {
      summary: '1 remaining, 1 completed',
      detail: 'Remaining tasks (1):\n#1 [pending] Implement UI\n\nCompleted tasks (1):\n#2 [completed] Inspect CC',
      taskSnapshot: {
        counts: { total: 2, remaining: 1, pending: 1, inProgress: 0, completed: 1 },
        tasks: [
          { id: '1', status: 'pending', subject: 'Implement UI', description: '', blocks: [], blockedBy: [] },
          { id: '2', status: 'completed', subject: 'Inspect CC', description: '', blocks: [], blockedBy: [] },
        ],
      },
    },
    createdAt: '2026-05-31T00:00:00.000Z',
  }

  const frame = render(h(ToolCallBlock, { item })).lastFrame() ?? ''

  assert.match(frame, /TaskList/)
  assert.match(frame, /⎿/)
  assert.match(frame, /1 remaining, 1 completed/)
  assert.match(frame, /ctrl\+o to expand/)
  assert.doesNotMatch(frame, /Implement UI/)
  assert.doesNotMatch(frame, /Inspect CC/)
  assert.doesNotMatch(frame, /Remaining tasks/)
})

test('ToolCallBlock renders collapsed output through response prefix', () => {
  const item: Extract<TUIDisplayItem, { kind: 'tool_call' }> = {
    kind: 'tool_call',
    id: 'tool-1',
    toolUseId: 'call-1',
    tool: 'Read',
    input: { filePath: 'src/index.ts' },
    status: 'done',
    result: ['one', 'two', 'three', 'four', 'five'].join('\n'),
    createdAt: '2026-05-31T00:00:00.000Z',
  }

  const frame = render(h(ToolCallBlock, { item })).lastFrame() ?? ''

  assert.match(frame, /⎿/)
  assert.match(frame, /one/)
  assert.match(frame, /\.\.\. \+2 lines \(ctrl\+o to expand\)/)
  assert.doesNotMatch(frame, /\| /)
})

test('TaskListBlock renders completed, active, pending, and blocked tasks', () => {
  const snapshot: TaskDisplaySnapshot = {
    counts: { total: 4, remaining: 3, pending: 2, inProgress: 1, completed: 1 },
    activeTaskId: '2',
    tasks: [
      { id: '1', status: 'completed', subject: 'Design system architecture', description: '', blocks: [], blockedBy: [] },
      { id: '2', status: 'in_progress', subject: 'Implement authentication module', activeForm: 'Implementing auth module', description: '', blocks: [], blockedBy: [] },
      { id: '3', status: 'pending', subject: 'Write unit tests', description: '', blocks: [], blockedBy: ['2'] },
      { id: '4', status: 'pending', subject: 'Deploy to production', description: '', blocks: [], blockedBy: ['3'] },
    ],
  }

  const frame = render(h(TaskListBlock, { snapshot })).lastFrame() ?? ''

  assert.match(frame, /4 tasks \(1 done, 1 in progress, 2 open\)/)
  assert.match(frame, /✔/)
  assert.match(frame, /■/)
  assert.match(frame, /□/)
  assert.match(frame, /Design system architecture/)
  assert.match(frame, /Implementing auth module/)
  assert.match(frame, /Write unit tests/)
  assert.match(frame, /blocked by #2/)
  assert.match(frame, /Deploy to production/)
  assert.match(frame, /blocked by #3/)
})

test('Spinner renders current task text and task snapshot without generated prompt text', () => {
  const snapshot: TaskDisplaySnapshot = {
    counts: { total: 2, remaining: 1, pending: 0, inProgress: 1, completed: 1 },
    activeTaskId: '2',
    tasks: [
      { id: '1', status: 'completed', subject: 'Inspect ClaudeCode UI', description: '', blocks: [], blockedBy: [] },
      { id: '2', status: 'in_progress', subject: 'Polish tool output', activeForm: 'Polishing tool output', description: '', blocks: [], blockedBy: [] },
    ],
  }

  const frame = render(h(Spinner, { taskSnapshot: snapshot })).lastFrame() ?? ''

  assert.doesNotMatch(frame, /2 tasks \(1 done, 1 in progress, 0 open\)/)
  assert.match(frame, /⎿/)
  assert.match(frame, /⎿\s+✔\s+Inspect ClaudeCode UI/)
  assert.match(frame, /Polishing tool output/)
  assert.doesNotMatch(frame, /Generating\.\.\./)
  assert.doesNotMatch(frame, /Vibing\.\.\./)
})

test('TranscriptView renders provided prompt-order items expanded', () => {
  const items: TUIDisplayItem[] = [
    {
      kind: 'user',
      id: 'user-1',
      content: 'user asks for files',
      createdAt: '2026-05-31T00:00:00.000Z',
    },
    {
      kind: 'assistant',
      id: 'assistant-thinking-1',
      content: '',
      thinkingBlocks: [{ type: 'thinking', thinking: 'first reason\nsecond reason' }],
      createdAt: '2026-05-31T00:00:01.000Z',
    },
    {
      kind: 'tool_call',
      id: 'tool-1',
      toolUseId: 'call-1',
      tool: 'Bash',
      input: { command: 'printf lines' },
      status: 'done',
      result: 'line1\nline2\nline3\nline4',
      createdAt: '2026-05-31T00:00:02.000Z',
    },
    {
      kind: 'system',
      id: 'system-1',
      content: 'done marker',
      createdAt: '2026-05-31T00:00:03.000Z',
    },
  ]

  const frame = render(h(TranscriptView, {
    items,
    scrollOffsetRows: 0,
    onScrollOffsetRowsChange: () => {},
    onExit: () => {},
  })).lastFrame() ?? ''

  const userIndex = frame.indexOf('user asks for files')
  const thinkingIndex = frame.indexOf('first reason')
  const toolIndex = frame.indexOf('Bash')
  const expandedToolIndex = frame.indexOf('line4')
  const systemIndex = frame.indexOf('done marker')

  assert.ok(userIndex >= 0, 'user item should render')
  assert.ok(thinkingIndex > userIndex, 'thinking should render after user')
  assert.ok(toolIndex > thinkingIndex, 'tool should render after thinking')
  assert.ok(expandedToolIndex > toolIndex, 'tool output should be expanded')
  assert.ok(systemIndex > expandedToolIndex, 'live system item should render last')
  assert.doesNotMatch(frame, /ctrl\+o to expand/)
  assert.doesNotMatch(frame, /j\/k: scroll/)
  assert.doesNotMatch(frame, /g\/G: top\/bottom/)
  assert.match(frame, /ctrl\+o: exit/)
  assert.doesNotMatch(frame, /j\/k/)
  assert.doesNotMatch(frame, /g\/G/)
})

test('TranscriptView supports arrow and SGR wheel scrolling while ignoring removed shortcuts', async () => {
  const items: TUIDisplayItem[] = Array.from({ length: 60 }, (_, index) => ({
    kind: 'system',
    id: `system-${index}`,
    content: `transcript body ${index}`,
    createdAt: '2026-05-31T00:00:00.000Z',
  }))
  let exitCount = 0
  let scrollOffset = 0
  let scrollUpdateCount = 0

  const onScrollOffsetRowsChange = (update: (previous: number) => number) => {
    scrollUpdateCount++
    scrollOffset = update(scrollOffset)
  }

  const instance = render(h(TranscriptView, {
    items,
    scrollOffsetRows: 0,
    onScrollOffsetRowsChange,
    onExit: () => {
      exitCount++
    },
  }))
  const initialFrame = instance.lastFrame()

  for (const input of ['j', 'k', 'g', 'G', '\x1B[5~', '\x1B[6~', ' ', 'b']) {
    instance.stdin.write(input)
    await waitForInk()
  }

  assert.equal(exitCount, 0)
  assert.equal(scrollUpdateCount, 0)
  assert.equal(instance.lastFrame(), initialFrame)

  for (const input of ['\x1B[A', '\x1B[B']) {
    instance.stdin.write(input)
    await waitForInk()
  }

  assert.equal(exitCount, 0)
  assert.ok(scrollUpdateCount > 0)
  assert.equal(scrollOffset, 0)

  const updatesBeforeMouseClick = scrollUpdateCount
  for (const input of ['\x1B[<0;10;5M', '\x1B[<64;10;5m']) {
    instance.stdin.write(input)
    await waitForInk()
  }
  assert.equal(scrollUpdateCount, updatesBeforeMouseClick)

  instance.stdin.write('\x1B[<64;10;5M')
  await waitForInk()
  assert.equal(scrollOffset, 3)

  instance.stdin.write('\x1B[<65;10;5M')
  await waitForInk()
  assert.equal(scrollOffset, 0)

  instance.stdin.write('\x0F')
  await waitForInk()
  assert.equal(exitCount, 1)

  cleanup()
  const escapeInstance = render(h(TranscriptView, {
    items,
    scrollOffsetRows: 0,
    onScrollOffsetRowsChange: onScrollOffsetRowsChange,
    onExit: () => {
      exitCount++
    },
  }))

  escapeInstance.stdin.write('\x1B')
  await waitForEscape()
  assert.equal(exitCount, 2)
})

test('Spinner collapses hidden running tasks by status without task header', () => {
  const snapshot: TaskDisplaySnapshot = {
    counts: { total: 12, remaining: 3, pending: 3, inProgress: 0, completed: 9 },
    tasks: [
      { id: '1', status: 'completed', subject: 'Done 1', description: '', blocks: [], blockedBy: [] },
      { id: '2', status: 'completed', subject: 'Done 2', description: '', blocks: [], blockedBy: [] },
      { id: '3', status: 'completed', subject: 'Done 3', description: '', blocks: [], blockedBy: [] },
      { id: '4', status: 'completed', subject: 'Done 4', description: '', blocks: [], blockedBy: [] },
      { id: '5', status: 'completed', subject: 'Done 5', description: '', blocks: [], blockedBy: [] },
      { id: '6', status: 'completed', subject: 'Done 6', description: '', blocks: [], blockedBy: [] },
      { id: '7', status: 'completed', subject: 'Done 7', description: '', blocks: [], blockedBy: [] },
      { id: '8', status: 'completed', subject: 'Done 8', description: '', blocks: [], blockedBy: [] },
      { id: '9', status: 'completed', subject: 'Done 9', description: '', blocks: [], blockedBy: [] },
      { id: '10', status: 'pending', subject: 'Open 10', description: '', blocks: [], blockedBy: [] },
      { id: '11', status: 'pending', subject: 'Open 11', description: '', blocks: [], blockedBy: [] },
      { id: '12', status: 'pending', subject: 'Blocked 12', description: '', blocks: [], blockedBy: ['10'] },
    ],
  }

  const frame = render(h(Spinner, { taskSnapshot: snapshot })).lastFrame() ?? ''

  assert.doesNotMatch(frame, /12 tasks \(9 done, 0 in progress, 3 open\)/)
  assert.match(frame, /⎿/)
  assert.match(frame, /\+2 completed/)
})

test('Spinner renders nothing when inactive', () => {
  const frame = render(h(Spinner, { active: false })).lastFrame() ?? ''

  assert.equal(frame.trim(), '')
})

test('Spinner renders thinking and waiting stream modes', () => {
  const thinkingFrame = render(h(Spinner, { mode: 'thinking' })).lastFrame() ?? ''
  assert.match(thinkingFrame, /\.\.\..*\(\d+s/)

  cleanup()

  const waitingFrame = render(h(Spinner, { mode: 'waiting' })).lastFrame() ?? ''
  assert.match(waitingFrame, /Waiting for model\.\./)
})

test('Spinner briefly renders thought duration after thinking stops', async () => {
  mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 })
  try {
    const instance = render(h(Spinner, { mode: 'thinking' }))
    assert.match(instance.lastFrame() ?? '', /\.\.\..*\(\d+s/)

    mock.timers.tick(2500)
    instance.rerender(h(Spinner, { mode: 'requesting' }))
    await waitForInk()

    assert.match(instance.lastFrame() ?? '', /thought for 3s/)
  } finally {
    mock.timers.reset()
  }
})

test('MessageList renders assistant thinking blocks as folded status', () => {
  const items: TUIDisplayItem[] = [{
    kind: 'assistant',
    id: 'assistant-1',
    content: 'final answer',
    thinkingBlocks: [{
      type: 'thinking',
      thinking: 'private reasoning',
      signature: 'sig-1',
    }],
    createdAt: '2026-05-31T00:00:00.000Z',
  }]

  const frame = render(h(MessageList, { items })).lastFrame() ?? ''

  assert.match(frame, /Thinking/)
  assert.match(frame, /ctrl\+o to expand/)
  assert.match(frame, /final answer/)
  assert.doesNotMatch(frame, /private reasoning/)
})

test('MessageList renders thinking blocks in items list', async () => {
  const items: TUIDisplayItem[] = [{
    kind: 'assistant',
    id: 'assistant-thinking',
    content: 'final answer',
    thinkingBlocks: [{
      type: 'thinking',
      thinking: 'private reasoning\n\n- inspect files',
      signature: 'sig-1',
    }],
    createdAt: '2026-06-01T00:00:00.000Z',
  }]

  const instance = render(h(MessageList, { items, isStreaming: true }))
  const frame = instance.lastFrame() ?? ''

  // Streaming thinking is auto-expanded
  assert.match(frame, /private reasoning/)
})

test('MessageList never reveals redacted thinking content', async () => {
  const items: TUIDisplayItem[] = [{
    kind: 'assistant',
    id: 'assistant-redacted',
    content: 'final answer',
    thinkingBlocks: [{
      type: 'redacted_thinking',
      data: 'encrypted-private-data',
    }],
    createdAt: '2026-06-01T00:00:00.000Z',
  }]

  const instance = render(h(MessageList, { items, isStreaming: true }))
  const frame = instance.lastFrame() ?? ''

  // Redacted content must never appear in output
  assert.doesNotMatch(frame, /encrypted-private-data/)
})

test('AskUserQuestionDialog renders preview pane for single-select preview questions', () => {
  const frame = render(h(AskUserQuestionDialog, {
    request: {
      questions: [{
        question: 'Which layout should be used?',
        header: 'Layout',
        multiSelect: false,
        options: [
          { label: 'Dense', description: 'Compact table', preview: 'Dense table preview' },
          { label: 'Roomy', description: 'More spacing', preview: 'Roomy card preview' },
        ],
      }],
    },
    onResolve: () => {},
  })).lastFrame() ?? ''

  assert.match(frame, /\[Layout\]/)
  assert.match(frame, /Which layout should be used\?/)
  assert.match(frame, /Preview/)
  assert.match(frame, /Dense table preview/)
  assert.match(frame, /Other/)
})

test('ModelPickerDialog renders tier options and hints', () => {
  const frame = render(h(ModelPickerDialog, {
    options: modelPickerOptions(),
    onResolve: () => {},
  })).lastFrame() ?? ''

  assert.match(frame, /Select model/)
  assert.match(frame, /1\. Fast/)
  assert.match(frame, /fast-key \(openai: fast-id\)/)
  assert.match(frame, /2\. Balanced/)
  assert.match(frame, /balanced-key \(anthropic: balanced-id\)/)
  assert.match(frame, /default/)
  assert.match(frame, /current/)
  assert.match(frame, /3\. Powerful/)
  assert.match(frame, /Enter to set as default/)
  assert.match(frame, /s to use this session only/)
})

test('ModelPickerDialog resolves Enter as default and s as session-only', async () => {
  const decisions: Array<ModelPickerDecision | { action: 'cancel' }> = []
  const enterInstance = render(h(ModelPickerDialog, {
    options: modelPickerOptions(),
    onResolve: (decision) => decisions.push(decision),
  }))

  enterInstance.stdin.write('\r')
  await waitForInk()

  assert.equal(decisions[0]?.action, 'set-default')
  assert.equal(decisions[0]?.action === 'set-default' ? decisions[0].option.tier : '', 'fast')

  cleanup()
  const sessionInstance = render(h(ModelPickerDialog, {
    options: modelPickerOptions(),
    onResolve: (decision) => decisions.push(decision),
  }))

  sessionInstance.stdin.write('s')
  await waitForInk()

  assert.equal(decisions[1]?.action, 'session-only')
  assert.equal(decisions[1]?.action === 'session-only' ? decisions[1].option.tier : '', 'fast')
})

test('ModelPickerDialog supports arrows, numeric selection, Esc, and disabled rows', async () => {
  const decisions: Array<ModelPickerDecision | { action: 'cancel' }> = []
  const numericInstance = render(h(ModelPickerDialog, {
    options: modelPickerOptions(),
    onResolve: (decision) => decisions.push(decision),
  }))

  numericInstance.stdin.write('2')
  await waitForInk()
  numericInstance.stdin.write('\r')
  await waitForInk()

  assert.equal(decisions[0]?.action, 'set-default')
  assert.equal(decisions[0]?.action === 'set-default' ? decisions[0].option.tier : '', 'balanced')

  cleanup()
  const arrowInstance = render(h(ModelPickerDialog, {
    options: modelPickerOptions(),
    onResolve: (decision) => decisions.push(decision),
  }))

  arrowInstance.stdin.write('\x1B[B')
  await waitForInk()
  arrowInstance.stdin.write('s')
  await waitForInk()

  assert.equal(decisions[1]?.action, 'session-only')
  assert.equal(decisions[1]?.action === 'session-only' ? decisions[1].option.tier : '', 'balanced')

  cleanup()
  const cancelInstance = render(h(ModelPickerDialog, {
    options: modelPickerOptions(),
    onResolve: (decision) => decisions.push(decision),
  }))

  cancelInstance.stdin.write('\x1B')
  await waitForEscape()

  assert.equal(decisions[2]?.action, 'cancel')

  cleanup()
  const disabledInstance = render(h(ModelPickerDialog, {
    options: modelPickerOptions().map((option) => ({
      ...option,
      modelKey: undefined,
      disabledReason: 'No configured model resolves for this tier.',
    })),
    onResolve: (decision) => decisions.push(decision),
  }))

  disabledInstance.stdin.write('\r')
  disabledInstance.stdin.write('s')
  await waitForInk()

  assert.equal(decisions.length, 3)
})

test('ExitPlanModeDialog renders Claude-style approval choices', () => {
  const planContent = [
    '## Context',
    'Ship the aligned plan UI.',
    '',
    '## Implementation',
    ...Array.from({ length: 14 }, (_, index) => `- Step ${index + 1}`),
    '',
    '## Verification',
    'Run tests.',
  ].join('\n')
  const frame = render(h(ExitPlanModeDialog, {
    planContent,
    planFilePath: 'C:\\tmp\\plan.md',
    isAutoModeAvailable: true,
    isBypassAvailable: false,
    onResolve: () => {},
  })).lastFrame() ?? ''

  assert.match(frame, /Ready to code\?/)
  assert.match(frame, /Here is Hanekawa's plan:/)
  assert.match(frame, /Hanekawa has written up a plan and is ready to execute\. Would you like to proceed\?/)
  assert.match(frame, /Step 14/)
  assert.doesNotMatch(frame, /lines omitted from preview/)
  assert.match(frame, /Yes, clear context and use auto mode/)
  assert.match(frame, /Yes, and use auto mode/)
  assert.match(frame, /Yes, manually approve edits/)
  assert.match(frame, /No, keep planning/)
  assert.match(frame, /Feedback:/)
})

test('PermissionDialog renders Bash permission without always option', () => {
  const frame = renderPermission(permissionState([
    permissionRequest('Bash', { command: 'npm test' }, 'mode', 'dangerous'),
  ]))

  assert.match(frame, /Bash command/)
  assert.match(frame, /Command:/)
  assert.match(frame, /npm test/)
  assert.match(frame, /Yes, allow once/)
  assert.match(frame, /No, deny/)
  assert.doesNotMatch(frame, /always allow/)
})

test('PermissionDialog renders scoped always allow label from request rule', () => {
  const frame = renderPermission(permissionState([
    permissionRequest('Bash', { command: 'npm test' }, 'mode', 'dangerous', {
      alwaysAllowRule: permissionRule('Bash', 'allow', 'npm test', 'session'),
    }),
  ]))

  assert.match(frame, /Yes, always allow Bash:npm test/)
})

test('PermissionDialog renders matched permission rule explanation', () => {
  const frame = renderPermission(permissionState([
    permissionRequest('Bash', { command: 'npm run lint' }, 'ask rule', 'dangerous', {
      matchedRule: permissionRule('Bash', 'ask', 'npm \*'),
    }),
  ]))

  assert.match(frame, /Permission rule Bash:npm \* requires confirmation\./)
})

test('PermissionDialog renders pending count without expanding full queue', () => {
  const frame = renderPermission(permissionState([
    permissionRequest('Bash', { command: 'npm test' }, 'mode', 'dangerous'),
    permissionRequest('Write', { filePath: 'src/app.ts', content: 'export {}\n' }, 'mode', 'confirm'),
    permissionRequest('Agent', { subagent_type: 'explore', prompt: 'Find routes' }, 'mode', 'safe'),
  ], 1))

  assert.match(frame, /Write file/)
  assert.match(frame, /2\/3 pending/)
  assert.match(frame, /Also waiting: Bash, Agent:explore/)
  assert.match(frame, /Path: src\/app\.ts/)
  assert.doesNotMatch(frame, /1\. Bash/)
  assert.doesNotMatch(frame, /3\. Agent/)
})

test('RestoreMode renders checkpoint list with code diff summaries', () => {
  const frame = render(h(RestoreMode, {
    checkpoints: [
      rewindCheckpoint({
        messageId: 'older',
        messageContent: 'older prompt',
        timestamp: '2026-06-01T00:00:00.000Z',
        turnDiff: emptyRewindDiff(),
      }),
      rewindCheckpoint({
        messageId: 'newer',
        messageContent: 'newer prompt',
        timestamp: '2026-06-02T00:00:00.000Z',
        turnDiff: rewindDiff({ fileCount: 3, additions: 89, deletions: 1 }),
        isCurrent: true,
      }),
    ],
    onSelect: async () => {},
    onCancel: () => {},
  })).lastFrame() ?? ''

  assert.match(frame, /Rewind/)
  assert.match(frame, /Restore the code and\/or conversation to the point before/)
  assert.match(frame, /newer prompt/)
  assert.match(frame, /3 files changed\s+\+89\s+-1/)
  assert.match(frame, /older prompt/)
  assert.match(frame, /No code changes/)
  assert.match(frame, /> \(current\)/)
  assert.ok(frame.indexOf('older prompt') < frame.indexOf('newer prompt'))
  assert.ok(frame.indexOf('newer prompt') < frame.indexOf('(current)'))
})

test('RestoreMode selecting current cancels without rewinding', async () => {
  const decisions: RestoreDecision[] = []
  let cancelCount = 0
  const instance = render(h(RestoreMode, {
    checkpoints: [rewindCheckpoint()],
    onSelect: async (_checkpoint, decision) => {
      decisions.push(decision)
    },
    onCancel: () => {
      cancelCount++
    },
  }))

  instance.stdin.write('\r')
  await waitForInk()

  assert.equal(cancelCount, 1)
  assert.deepEqual(decisions, [])
})

test('RestoreMode confirm screen renders four options when code is unchanged', async () => {
  const instance = render(h(RestoreMode, {
    checkpoints: [rewindCheckpoint({ restoreDiff: emptyRewindDiff() })],
    onSelect: async () => {},
    onCancel: () => {},
  }))

  instance.stdin.write('\x1B[A')
  await waitForInk()
  instance.stdin.write('\r')
  await waitForInk()
  const frame = instance.lastFrame() ?? ''

  assert.match(frame, /Confirm you want to restore/)
  assert.match(frame, /1\. Restore conversation/)
  assert.match(frame, /2\. Summarize from here/)
  assert.match(frame, /3\. Summarize up to here/)
  assert.match(frame, /4\. Never mind/)
  assert.doesNotMatch(frame, /Restore code/)
})

test('RestoreMode confirm screen renders six options when code can be restored', async () => {
  const instance = render(h(RestoreMode, {
    checkpoints: [rewindCheckpoint({
      restoreDiff: rewindDiff({
        fileCount: 6,
        additions: 450,
        deletions: 588,
        firstFile: 'cosmic-sprouting-moore.md',
      }),
    })],
    onSelect: async () => {},
    onCancel: () => {},
  }))

  instance.stdin.write('\x1B[A')
  await waitForInk()
  instance.stdin.write('\r')
  await waitForInk()
  const frame = instance.lastFrame() ?? ''

  assert.match(frame, /1\. Restore code and conversation/)
  assert.match(frame, /2\. Restore conversation/)
  assert.match(frame, /3\. Restore code/)
  assert.match(frame, /4\. Summarize from here/)
  assert.match(frame, /5\. Summarize up to here/)
  assert.match(frame, /6\. Never mind/)
  assert.match(frame, /\+450 -588 in cosmic-sprouting-moore\.md/)
})

test('RestoreMode Never mind returns to checkpoint selection', async () => {
  const instance = render(h(RestoreMode, {
    checkpoints: [rewindCheckpoint({ restoreDiff: rewindDiff() })],
    onSelect: async () => {},
    onCancel: () => {},
  }))

  instance.stdin.write('\x1B[A')
  await waitForInk()
  instance.stdin.write('\r')
  await waitForInk()
  assert.match(instance.lastFrame() ?? '', /Confirm you want to restore/)

  instance.stdin.write('6')
  await waitForInk()
  const frame = instance.lastFrame() ?? ''

  assert.match(frame, /Restore the code and\/or conversation to the point before/)
  assert.doesNotMatch(frame, /Confirm you want to restore/)
})

test('RestoreMode numeric shortcut resolves selected restore decision', async () => {
  const decisions: RestoreDecision[] = []
  const instance = render(h(RestoreMode, {
    checkpoints: [rewindCheckpoint({ restoreDiff: rewindDiff() })],
    onSelect: async (_checkpoint, decision) => {
      decisions.push(decision)
    },
    onCancel: () => {},
  }))

  instance.stdin.write('\x1B[A')
  await waitForInk()
  instance.stdin.write('\r')
  await waitForInk()
  instance.stdin.write('3')
  await waitForInk()

  assert.deepEqual(decisions, ['restore-code'])
})

test('RestoreMode numeric shortcut resolves summary decisions', async () => {
  const decisions: RestoreDecision[] = []
  const instance = render(h(RestoreMode, {
    checkpoints: [rewindCheckpoint({ restoreDiff: rewindDiff() })],
    onSelect: async (_checkpoint, decision) => {
      decisions.push(decision)
    },
    onCancel: () => {},
  }))

  instance.stdin.write('\x1B[A')
  await waitForInk()
  instance.stdin.write('\r')
  await waitForInk()
  instance.stdin.write('4')
  await waitForInk()

  assert.deepEqual(decisions, ['summarize-from-here'])
})

test('RestoreMode renders Summarizing while summary action is pending', async () => {
  let resolveSelect!: () => void
  const pending = new Promise<void>((resolve) => {
    resolveSelect = resolve
  })
  const instance = render(h(RestoreMode, {
    checkpoints: [rewindCheckpoint({ restoreDiff: rewindDiff() })],
    onSelect: async () => pending,
    onCancel: () => {},
  }))

  instance.stdin.write('\x1B[A')
  await waitForInk()
  instance.stdin.write('\r')
  await waitForInk()
  instance.stdin.write('4')
  await waitForInk()

  assert.match(instance.lastFrame() ?? '', /Summarizing\.\.\./)
  resolveSelect()
  await waitForInk()
})

test('StaticDisplayItem renders welcome banner as a static header item', () => {
  const frame = render(h(StaticDisplayItem, {
    item: {
      kind: 'welcome_banner',
      id: 'welcome-session',
      sessionShortId: 'abc123',
      model: 'mimo-v2.5',
      providerName: 'anthropic',
      cwd: 'C:\\repo',
    },
  })).lastFrame() ?? ''

  assert.match(frame, /Welcome to Hanekawa|Hanekawa/)
  assert.match(frame, /abc123/)
  assert.match(frame, /mimo-v2\.5/)
})

function modelPickerOptions(): ModelPickerOption[] {
  return [
    {
      tier: 'fast',
      label: 'Fast',
      modelKey: 'fast-key',
      providerName: 'openai',
      modelId: 'fast-id',
      isCurrent: false,
      isDefault: false,
    },
    {
      tier: 'balanced',
      label: 'Balanced',
      modelKey: 'balanced-key',
      providerName: 'anthropic',
      modelId: 'balanced-id',
      isCurrent: true,
      isDefault: true,
    },
    {
      tier: 'powerful',
      label: 'Powerful',
      modelKey: 'powerful-key',
      providerName: 'openai',
      modelId: 'powerful-id',
      isCurrent: false,
      isDefault: false,
    },
  ]
}

function emptyRewindDiff(): CheckpointDiffSummary {
  return {
    fileCount: 0,
    additions: 0,
    deletions: 0,
    hasChanges: false,
  }
}

function rewindDiff(overrides: Partial<CheckpointDiffSummary> = {}): CheckpointDiffSummary {
  return {
    fileCount: 1,
    additions: 1,
    deletions: 0,
    firstFile: 'src/app.ts',
    hasChanges: true,
    ...overrides,
  }
}

function rewindCheckpoint(overrides: Partial<CheckpointWithDiff> = {}): CheckpointWithDiff {
  return {
    commitHash: 'abc123',
    messageId: 'msg-1',
    messageContent: 'rewind this prompt',
    timestamp: '2026-06-02T00:00:00.000Z',
    turnDiff: emptyRewindDiff(),
    restoreDiff: emptyRewindDiff(),
    isCurrent: false,
    ...overrides,
  }
}

async function waitForInk(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

async function waitForEscape(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 120))
}

function renderPermission(permState: PermissionDialogState): string {
  return render(h(PermissionDialog, {
    permState,
    respond: () => {},
    setActiveRequest: () => {},
  })).lastFrame() ?? ''
}

function permissionState(requests: PermissionRequest[], activeIndex = 0): PermissionDialogState {
  return {
    visible: true,
    activeRequestId: `permission-${activeIndex}`,
    requests: requests.map((request, index) => ({
      id: `permission-${index}`,
      request,
    })),
  }
}

function permissionRequest(
  toolName: string,
  input: unknown,
  source: PermissionDecisionSource = 'mode',
  riskLevel: RiskLevel = 'confirm',
  extra: Partial<PermissionRequest> = {},
): PermissionRequest {
  return {
    tool: permissionTool(toolName, riskLevel),
    input,
    reason: 'Current permission mode requires confirmation',
    source,
    denialStreak: 0,
    ...extra,
  }
}

function permissionTool(name: string, riskLevel: RiskLevel): Tool {
  return {
    name,
    description: '',
    riskLevel,
    inputSchema: {} as Tool['inputSchema'],
    execute: async (): Promise<ToolResult> => ({ ok: true, content: '' }),
  }
}

function permissionRule(
  toolName: string,
  behavior: PermissionRule['behavior'],
  contentPattern?: string,
  source: PermissionRule['source'] = 'config',
): PermissionRule {
  return {
    toolName,
    behavior,
    source,
    ...(contentPattern ? { contentPattern } : {}),
  }
}
