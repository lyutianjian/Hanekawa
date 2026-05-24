import test from 'node:test'
import assert from 'node:assert/strict'
import { formatDiagnostic, summarizeDiagnosticsForTui } from '../src/harness/diagnostics.js'

test('formatDiagnostic includes severity, code, and message', () => {
  assert.equal(
    formatDiagnostic({ severity: 'warning', code: 'malformed_jsonl', message: 'line 2 failed' }),
    'warning:malformed_jsonl: line 2 failed',
  )
})

test('summarizeDiagnosticsForTui aggregates repair diagnostics into one message', () => {
  const summary = summarizeDiagnosticsForTui([
    { severity: 'warning', code: 'malformed_jsonl', message: 'bad line' },
    { severity: 'warning', code: 'tool_protocol_repaired', message: 'orphan tool' },
    { severity: 'warning', code: 'tool_protocol_repaired', message: 'orphan result' },
    { severity: 'info', code: 'legacy_missing_turn_id', message: 'legacy' },
  ])

  assert.equal(summary, 'Session repaired: skipped 1 malformed JSONL line, repaired 2 tool records.')
})

test('summarizeDiagnosticsForTui omits non-user-facing diagnostics', () => {
  const summary = summarizeDiagnosticsForTui([
    { severity: 'info', code: 'legacy_missing_turn_id', message: 'legacy' },
  ])

  assert.equal(summary, undefined)
})
