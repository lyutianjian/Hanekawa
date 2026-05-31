import stringWidth from 'string-width'
import { shouldDisplayToolResult } from '../tools/display.js'
import type { TUIDisplayItem } from './types.js'

export const DEFAULT_INPUT_MAX_VISIBLE_LINES = 5
export const INPUT_CHROME_ROWS = 2
export const HIDDEN_MESSAGES_NOTICE_ROWS = 1

export interface WrappedInputLine {
  text: string
  start: number
  end: number
}

export interface InputWindow {
  lines: WrappedInputLine[]
  visibleLines: WrappedInputLine[]
  cursorLine: number
  cursorVisibleLine: number
  cursorCharIndex: number
  cursorDisplayCol: number
  firstVisibleLine: number
}

export interface TailViewportEntry<T> {
  item: T
  estimatedRows: number
}

export interface TailViewportResult<T> {
  entries: TailViewportEntry<T>[]
  hiddenCount: number
  estimatedRows: number
}

export interface ScrollViewportResult<T> {
  entries: TailViewportEntry<T>[]
  hiddenBeforeCount: number
  hiddenAfterCount: number
  estimatedRows: number
  maxScrollOffsetRows: number
  scrollOffsetRows: number
}

export function getStatusLineHeight(hasHint: boolean): number {
  return hasHint ? 2 : 1
}

export function getSafeTerminalWidth(columns: number | undefined, fallback = 80): number {
  const width = typeof columns === 'number' && Number.isFinite(columns) && columns > 0
    ? Math.floor(columns)
    : fallback
  return Math.max(1, width - 1)
}

export function estimateWelcomeBannerRows(width: number): number {
  return width < 70 ? 13 : 15
}

export function estimateSpinnerRows(input: { subText?: string; todoCount: number }): number {
  const visibleTodos = Math.min(input.todoCount, 6)
  const hiddenTodoRow = input.todoCount > visibleTodos ? 1 : 0
  return 1 + (input.subText ? 1 : 0) + visibleTodos + hiddenTodoRow
}

export function calculateMessageViewportRows(input: {
  terminalRows: number
  terminalColumns: number
  statusLineHeight: number
  inputBoxHeight: number
  spinnerRows: number
  overlayRows: number
}): number {
  const bannerRows = estimateWelcomeBannerRows(input.terminalColumns)
  const reservedRows = bannerRows
    + input.statusLineHeight
    + input.inputBoxHeight
    + input.spinnerRows
    + input.overlayRows
  return Math.max(0, input.terminalRows - reservedRows)
}

export function wrapInputLines(text: string, inputWidth: number): WrappedInputLine[] {
  const widthLimit = Math.max(1, inputWidth)
  if (text.length === 0) return [{ text: '', start: 0, end: 0 }]

  const lines: WrappedInputLine[] = []
  let line = ''
  let lineStart = 0
  let width = 0
  let index = 0

  while (index < text.length) {
    const char = text[index]!

    if (char === '\r') {
      index++
      continue
    }

    if (char === '\n') {
      lines.push({ text: line, start: lineStart, end: index })
      index++
      line = ''
      lineStart = index
      width = 0
      continue
    }

    const charWidth = Math.max(0, stringWidth(char))
    if (line.length > 0 && width + charWidth > widthLimit) {
      lines.push({ text: line, start: lineStart, end: index })
      line = ''
      lineStart = index
      width = 0
      continue
    }

    line += char
    width += charWidth
    index++
  }

  lines.push({ text: line, start: lineStart, end: text.length })
  return lines
}

export function buildInputWindow(input: {
  text: string
  cursorPos: number
  inputWidth: number
  maxVisibleLines?: number
}): InputWindow {
  const lines = wrapInputLines(input.text, input.inputWidth)
  const cursorPos = clamp(input.cursorPos, 0, input.text.length)
  const cursorLine = findCursorLine(lines, cursorPos)
  const line = lines[cursorLine] ?? lines[0]!
  const cursorCharIndex = clamp(cursorPos - line.start, 0, line.text.length)
  const cursorDisplayCol = stringWidth(line.text.slice(0, cursorCharIndex))
  const maxVisibleLines = Math.max(1, input.maxVisibleLines ?? DEFAULT_INPUT_MAX_VISIBLE_LINES)
  const firstVisibleLine = lines.length <= maxVisibleLines
    ? 0
    : clamp(cursorLine - Math.floor(maxVisibleLines / 2), 0, lines.length - maxVisibleLines)
  const visibleLines = lines.slice(firstVisibleLine, firstVisibleLine + maxVisibleLines)

  return {
    lines,
    visibleLines,
    cursorLine,
    cursorVisibleLine: cursorLine - firstVisibleLine,
    cursorCharIndex,
    cursorDisplayCol,
    firstVisibleLine,
  }
}

export function calculateInputBoxHeight(input: {
  text: string
  cursorPos: number
  inputWidth: number
  maxVisibleLines?: number
}): number {
  return buildInputWindow(input).visibleLines.length + INPUT_CHROME_ROWS
}

export function selectTailViewportEntries<T>(
  entries: TailViewportEntry<T>[],
  viewportRows: number,
  hiddenNoticeRows = HIDDEN_MESSAGES_NOTICE_ROWS,
): TailViewportResult<T> {
  const availableRows = Math.max(0, viewportRows)
  if (availableRows === 0 || entries.length === 0) {
    return { entries: [], hiddenCount: entries.length, estimatedRows: 0 }
  }

  const totalRows = entries.reduce((sum, entry) => sum + Math.max(0, entry.estimatedRows), 0)
  if (totalRows <= availableRows) {
    return { entries, hiddenCount: 0, estimatedRows: totalRows }
  }

  const capacity = Math.max(1, availableRows - hiddenNoticeRows)
  const selected: TailViewportEntry<T>[] = []
  let usedRows = 0

  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!
    const rows = Math.max(0, entry.estimatedRows)
    if (selected.length > 0 && usedRows + rows > capacity) break
    selected.unshift({
      item: entry.item,
      estimatedRows: Math.min(rows, Math.max(1, capacity - usedRows)),
    })
    usedRows += rows
    if (usedRows >= capacity) break
  }

  const hiddenCount = entries.length - selected.length
  const noticeRows = hiddenCount > 0 ? hiddenNoticeRows : 0
  return {
    entries: selected,
    hiddenCount,
    estimatedRows: Math.min(availableRows, selected.reduce((sum, entry) => sum + entry.estimatedRows, 0) + noticeRows),
  }
}

export function selectScrollableViewportEntries<T>(
  entries: TailViewportEntry<T>[],
  viewportRows: number,
  scrollOffsetRows: number,
): ScrollViewportResult<T> {
  const availableRows = Math.max(0, viewportRows)
  const totalRows = entries.reduce((sum, entry) => sum + Math.max(0, entry.estimatedRows), 0)
  const maxScrollOffsetRows = Math.max(0, totalRows - availableRows)
  const clampedOffset = clamp(Math.floor(scrollOffsetRows), 0, maxScrollOffsetRows)

  if (availableRows === 0 || entries.length === 0) {
    return {
      entries: [],
      hiddenBeforeCount: entries.length,
      hiddenAfterCount: 0,
      estimatedRows: 0,
      maxScrollOffsetRows,
      scrollOffsetRows: clampedOffset,
    }
  }

  const viewportEnd = totalRows - clampedOffset
  const viewportStart = Math.max(0, viewportEnd - availableRows)
  const selected: TailViewportEntry<T>[] = []
  let rowCursor = 0

  for (const entry of entries) {
    const rows = Math.max(0, entry.estimatedRows)
    const entryStart = rowCursor
    const entryEnd = rowCursor + rows
    rowCursor = entryEnd

    if (rows === 0) continue
    if (entryEnd <= viewportStart) continue
    if (entryStart >= viewportEnd) break

    const visibleRows = Math.max(1, Math.min(entryEnd, viewportEnd) - Math.max(entryStart, viewportStart))
    selected.push({ item: entry.item, estimatedRows: visibleRows })
  }

  const firstSelected = selected[0]?.item
  const lastSelected = selected.at(-1)?.item
  const firstIndex = firstSelected === undefined
    ? entries.length
    : entries.findIndex((entry) => entry.item === firstSelected)
  const lastIndex = lastSelected === undefined
    ? -1
    : entries.findIndex((entry) => entry.item === lastSelected)

  return {
    entries: selected,
    hiddenBeforeCount: Math.max(0, firstIndex),
    hiddenAfterCount: Math.max(0, entries.length - lastIndex - 1),
    estimatedRows: selected.reduce((sum, entry) => sum + entry.estimatedRows, 0),
    maxScrollOffsetRows,
    scrollOffsetRows: clampedOffset,
  }
}

export function estimateDisplayItemRows(
  item: TUIDisplayItem,
  width: number,
  expanded = false,
  showCompactSummary = false,
): number {
  const contentWidth = Math.max(1, width)
  switch (item.kind) {
    case 'user':
      return 3 + estimateWrappedRows(item.content, Math.max(1, contentWidth - 2))
    case 'assistant':
      return item.content.trim()
        ? 2 + estimateWrappedRows(item.content, Math.max(1, contentWidth - 2))
        : 0
    case 'tool_call':
      return estimateToolCallRows(item, contentWidth, expanded)
    case 'compact_boundary':
      if (showCompactSummary && item.summary.trim()) {
        return 2 + estimateWrappedRows(`Compact summary\n${item.summary}`, contentWidth)
      }
      return 2 + estimateWrappedRows(displayItemText(item), contentWidth)
    case 'compact_attempt_failed':
    case 'system':
    case 'error':
      return 2 + estimateWrappedRows(displayItemText(item), contentWidth)
    case 'tool_progress':
      return estimateWrappedRows(item.content, Math.max(1, contentWidth - 2))
  }
}

export function estimateWrappedRows(text: string, width: number): number {
  const widthLimit = Math.max(1, width)
  const parts = text.length === 0 ? [''] : text.split(/\r?\n/)
  return parts.reduce((sum, part) => sum + Math.max(1, Math.ceil(Math.max(1, stringWidth(part)) / widthLimit)), 0)
}

function estimateToolCallRows(
  item: Extract<TUIDisplayItem, { kind: 'tool_call' }>,
  width: number,
  expanded: boolean,
): number {
  let rows = 1
  if (item.status === 'denied') rows += 1
  if (item.status === 'error' && item.result) {
    rows += (item.errorCode ? 1 : 0) + estimateWrappedRows(item.result, Math.max(1, width - 2))
  }
  if (item.status === 'done' && item.result && shouldDisplayToolResult(item.tool, item.input, item.result)) {
    if (item.resultDisplay) {
      if (!expanded) return rows + 1
      const detail = item.resultDisplay.detail ?? item.result
      return rows + 2 + estimateWrappedRows(detail, Math.max(1, width - 2))
    }
    const resultLines = item.result.split('\n').length
    if (expanded || resultLines <= 3) {
      rows += resultLines + (resultLines > 3 ? 1 : 0)
    } else {
      rows += 4
    }
  }
  return rows
}

function displayItemText(item: TUIDisplayItem): string {
  switch (item.kind) {
    case 'compact_boundary':
      return 'Conversation compacted (ctrl+o for history)'
    case 'compact_attempt_failed':
      return item.record.error
    case 'system':
    case 'error':
      return item.content
    default:
      return ''
  }
}

function findCursorLine(lines: WrappedInputLine[], cursorPos: number): number {
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    if (cursorPos <= line.end) return index
  }
  return Math.max(0, lines.length - 1)
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  if (value < min) return min
  if (value > max) return max
  return value
}
