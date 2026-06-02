import test, { afterEach } from 'node:test'
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
import { MessageList, StaticDisplayItem } from '../src/tui/components/MessageList.js'
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

test('MessageList shows recent completed tool detail as a live Ctrl+O preview', async () => {
  const recent: Extract<TUIDisplayItem, { kind: 'tool_call' }> = {
    kind: 'tool_call',
    id: 'tool-1',
    toolUseId: 'call-1',
    tool: 'Read',
    input: { filePath: 'a.txt' },
    status: 'done',
    result: ['one', 'two', 'three', 'four'].join('\n'),
    createdAt: '2026-05-31T00:00:00.000Z',
  }

  const instance = render(h(MessageList, {
    items: [],
    recentCompletedToolCall: recent,
    isOverlayActive: false,
  }))

  assert.doesNotMatch(instance.lastFrame() ?? '', /four/)
  instance.stdin.write('\x0f')
  await new Promise((resolve) => setImmediate(resolve))

  assert.match(instance.lastFrame() ?? '', /four/)
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
