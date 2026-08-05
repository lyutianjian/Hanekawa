import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildExitPlanModeOptions,
  elevatedExitPlanModeDecision,
  previewMarkdownLines,
} from '../src/tui/components/ExitPlanModeDialog.js'

test('ExitPlanModeDialog options show accept-edits when bypass is not available', () => {
  const options = buildExitPlanModeOptions({ isBypassAvailable: false })

  assert.deepEqual(
    options.map((option) => option.label),
    [
      'Yes, auto-accept edits',
      'Yes, manually approve edits',
      'No, keep planning',
    ],
  )
  assert.deepEqual(
    options.map((option) => option.kind),
    [
      'approve_acceptEdits_keep',
      'approve_restore_keep',
      'reject',
    ],
  )
})

test('ExitPlanModeDialog options show bypass when available', () => {
  const options = buildExitPlanModeOptions({ isBypassAvailable: true })

  assert.equal(options[0]?.kind, 'approve_bypass_keep')
  assert.equal(options[0]?.label, 'Yes, and bypass permissions')
})

test('ExitPlanModeDialog options replace elevated slots with bypass when available', () => {
  const options = buildExitPlanModeOptions({ isBypassAvailable: true })

  assert.deepEqual(
    options.map((option) => option.label),
    [
      'Yes, and bypass permissions',
      'Yes, manually approve edits',
      'No, keep planning',
    ],
  )
  assert.deepEqual(
    options.map((option) => option.kind),
    [
      'approve_bypass_keep',
      'approve_restore_keep',
      'reject',
    ],
  )
})

test('ExitPlanModeDialog Shift+Tab resolves to the keep-context elevated option', () => {
  assert.equal(elevatedExitPlanModeDecision({ isBypassAvailable: true }), 'approve_bypass_keep')
  assert.equal(elevatedExitPlanModeDecision({ isBypassAvailable: false }), 'approve_acceptEdits_keep')
})

test('ExitPlanModeDialog previewMarkdownLines truncates long content while preserving head and tail', () => {
  const content = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join('\n')
  const preview = previewMarkdownLines(content, 5)

  assert.match(preview, /^line 1\nline 2\nline 3/)
  assert.match(preview, /\[\.\.\. 8 lines omitted from preview \.\.\.\]/)
  assert.match(preview, /line 12$/)
  assert.equal(preview.split('\n').length, 5)
})

test('ExitPlanModeDialog preview leaves short plans untouched', () => {
  const content = 'line 1\nline 2'
  assert.equal(previewMarkdownLines(content, 5), content)
})
