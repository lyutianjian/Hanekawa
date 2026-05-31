import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createElement as h } from 'react'
import { cleanup, render } from 'ink-testing-library'
import { ToolCallBlock } from '../src/tui/components/ToolCallBlock.js'
import { AskUserQuestionDialog } from '../src/tui/components/AskUserQuestionDialog.js'
import { ExitPlanModeDialog } from '../src/tui/components/ExitPlanModeDialog.js'
import type { TUIDisplayItem } from '../src/tui/types.js'

afterEach(() => cleanup())

test('ToolCallBlock renders Claude-style status dot and task summary', () => {
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
    },
    createdAt: '2026-05-31T00:00:00.000Z',
  }

  const frame = render(h(ToolCallBlock, { item })).lastFrame() ?? ''

  assert.match(frame, /●/)
  assert.match(frame, /TaskList/)
  assert.match(frame, /1 remaining, 1 completed/)
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
