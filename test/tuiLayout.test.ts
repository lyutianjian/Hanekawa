import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import type { TUIDisplayItem } from '../src/tui/types.js'
import {
  buildInputWindow,
  calculateInputBoxGeometry,
  estimateDisplayItemRows,
  getSafeTerminalWidth,
  selectScrollableViewportEntries,
  selectTailViewportEntries,
} from '../src/tui/layout.js'

describe('TUI layout helpers', () => {
  it('clips long message history to the tail of the viewport', () => {
    const items = Array.from({ length: 12 }, (_, index) => makeSystemItem(index))
    const entries = items.map((item) => ({
      item,
      estimatedRows: estimateDisplayItemRows(item, 80),
    }))

    const viewport = selectTailViewportEntries(entries, 8)

    assert.ok(viewport.estimatedRows <= 8)
    assert.equal(viewport.entries.at(-1)?.item.id, 'system-11')
    assert.ok(viewport.hiddenCount > 0)
  })

  it('handles tiny viewports without throwing', () => {
    const items = [makeSystemItem(1), makeSystemItem(2)]
    const entries = items.map((item) => ({
      item,
      estimatedRows: estimateDisplayItemRows(item, 20),
    }))

    const viewport = selectTailViewportEntries(entries, 1)

    assert.ok(viewport.estimatedRows <= 1)
    assert.ok(viewport.hiddenCount >= 0)
  })

  it('selects the bottom of a transcript viewport by default', () => {
    const entries = makeFixedEntries(6, 2)

    const viewport = selectScrollableViewportEntries(entries, 5, 0)

    assert.equal(viewport.entries.at(-1)?.item.id, 'system-5')
    assert.equal(viewport.hiddenAfterCount, 0)
    assert.ok(viewport.hiddenBeforeCount > 0)
    assert.equal(viewport.scrollOffsetRows, 0)
  })

  it('keeps newer transcript entries hidden after scrolling upward', () => {
    const entries = makeFixedEntries(6, 2)

    const viewport = selectScrollableViewportEntries(entries, 5, 4)

    assert.equal(viewport.entries.at(-1)?.item.id, 'system-3')
    assert.equal(viewport.hiddenAfterCount, 2)
    assert.ok(viewport.hiddenBeforeCount > 0)
  })

  it('clamps transcript Home-style offsets to the top', () => {
    const entries = makeFixedEntries(6, 2)

    const viewport = selectScrollableViewportEntries(entries, 5, Number.MAX_SAFE_INTEGER)

    assert.equal(viewport.entries[0]?.item.id, 'system-0')
    assert.equal(viewport.hiddenBeforeCount, 0)
    assert.ok(viewport.hiddenAfterCount > 0)
    assert.equal(viewport.scrollOffsetRows, viewport.maxScrollOffsetRows)
  })

  it('shows all transcript entries when content fits', () => {
    const entries = makeFixedEntries(3, 2)

    const viewport = selectScrollableViewportEntries(entries, 10, 5)

    assert.deepEqual(viewport.entries.map((entry) => entry.item.id), ['system-0', 'system-1', 'system-2'])
    assert.equal(viewport.hiddenBeforeCount, 0)
    assert.equal(viewport.hiddenAfterCount, 0)
    assert.equal(viewport.maxScrollOffsetRows, 0)
    assert.equal(viewport.scrollOffsetRows, 0)
  })

  it('counts compact summaries only in transcript row estimates', () => {
    const compact: TUIDisplayItem = {
      kind: 'compact_boundary',
      id: 'compact-1',
      summary: 'summary line one\nsummary line two',
    }

    assert.ok(
      estimateDisplayItemRows(compact, 80, false, true)
      > estimateDisplayItemRows(compact, 80, false, false),
    )
  })

  it('counts expanded assistant thinking in transcript row estimates', () => {
    const assistant: TUIDisplayItem = {
      kind: 'assistant',
      id: 'assistant-thinking-1',
      content: 'final answer',
      thinkingBlocks: [{
        type: 'thinking',
        thinking: 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda\nsecond line of reasoning',
      }],
      createdAt: '2026-05-30T00:00:00.000Z',
    }

    const collapsedRows = estimateDisplayItemRows(assistant, 24, false)
    const expandedRows = estimateDisplayItemRows(assistant, 24, true)
    const viewport = selectScrollableViewportEntries([{
      item: assistant,
      estimatedRows: expandedRows,
    }], Math.max(1, collapsedRows), 0)

    assert.ok(expandedRows > collapsedRows)
    assert.ok(viewport.maxScrollOffsetRows > 0)
  })

  it('keeps the cursor line visible when long input is windowed', () => {
    const text = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda'
    const cursorPos = text.indexOf('theta')
    const window = buildInputWindow({
      text,
      cursorPos,
      inputWidth: 12,
      maxVisibleLines: 3,
    })

    assert.equal(window.visibleLines.includes(window.lines[window.cursorLine]!), true)
    assert.ok(window.cursorVisibleLine >= 0)
    assert.ok(window.cursorVisibleLine < window.visibleLines.length)
  })

  it('computes cursor display columns with CJK character widths', () => {
    const window = buildInputWindow({
      text: '你做s',
      cursorPos: 3,
      inputWidth: 20,
    })

    assert.equal(window.cursorDisplayCol, 5)
  })

  it('reserves one terminal column to avoid autowrap at the edge', () => {
    assert.equal(getSafeTerminalWidth(80), 79)
    assert.equal(getSafeTerminalWidth(1), 1)
    assert.equal(getSafeTerminalWidth(undefined), 79)
  })

  it('reserves prompt and cursor cells in input box geometry', () => {
    for (const columns of [120, 80, 40, 20, 5, 4, 1]) {
      const geometry = calculateInputBoxGeometry(columns)

      assert.equal(geometry.frameWidth, Math.max(1, columns - 1))
      assert.ok(geometry.inputWidth >= 1)
      if (columns >= 5) {
        assert.ok(geometry.inputWidth + 3 <= geometry.frameWidth)
      }
    }
  })
})

function makeSystemItem(index: number): TUIDisplayItem {
  return {
    kind: 'system',
    id: `system-${index}`,
    content: `system message ${index}`,
    createdAt: '2026-05-30T00:00:00.000Z',
  }
}

function makeFixedEntries(count: number, estimatedRows: number) {
  return Array.from({ length: count }, (_, index) => ({
    item: makeSystemItem(index),
    estimatedRows,
  }))
}
