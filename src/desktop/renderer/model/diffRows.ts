import { diffLines } from 'diff'
import type { FileToolPreview } from '../../../services/fileToolPreview.js'

/**
 * A file-tool preview turned into rows a view can paint one per line.
 *
 * `PermissionRequestDto.preview` arrives as two whole strings (`oldText` /
 * `newText`) already bounded by `capFileToolPreview`; turning them into a diff
 * is the viewer's job, which is why `src/tui/diff.ts` stayed in the TUI. This is
 * the DOM half of that decision, kept pure and line-oriented because a browser
 * can afford real line numbers and a gutter.
 *
 * DOM-free on purpose: `test/` imports this module, and a test import drags a
 * file into the base tsconfig program, which has no DOM lib. See
 * `renderer/bridgeChannel.ts` for the same reason.
 */

export type DiffRowKind = 'add' | 'del' | 'ctx' | 'elided'

export interface DiffRow {
  readonly kind: DiffRowKind
  readonly text: string
  /** 1-based, present on the side the row exists in. */
  readonly oldLine?: number
  readonly newLine?: number
}

export interface DiffPreviewView {
  readonly kind: 'diff'
  readonly title: string
  readonly filePath?: string
  readonly summary: string
  readonly rows: readonly DiffRow[]
}

export interface MessagePreviewView {
  readonly kind: 'message'
  readonly title: string
  readonly filePath?: string
  readonly message: string
}

export type PreviewView = DiffPreviewView | MessagePreviewView

/** Rows beyond this are collapsed into one `elided` row. Display-only. */
export const DEFAULT_MAX_DIFF_ROWS = 240

/**
 * How many lines of unchanged text to keep either side of a change.
 *
 * Without this a one-line edit to a 200-line file renders 200 rows of context
 * and the change is invisible.
 */
export const DIFF_CONTEXT_LINES = 3

export function previewView(
  preview: FileToolPreview,
  options: { maxRows?: number; contextLines?: number } = {},
): PreviewView {
  // `capFileToolPreview` degrades a diff it cannot cut (a minified single line,
  // or a file too large to read) into this shape, so it is a normal outcome
  // rather than an error path.
  if (preview.kind === 'message') {
    return {
      kind: 'message',
      title: preview.title,
      ...(preview.filePath !== undefined ? { filePath: preview.filePath } : {}),
      message: preview.message,
    }
  }

  const all = diffRowsFor(preview.oldText, preview.newText, options.contextLines ?? DIFF_CONTEXT_LINES)
  const maxRows = options.maxRows ?? DEFAULT_MAX_DIFF_ROWS
  const rows = all.length > maxRows
    ? [...all.slice(0, maxRows), elidedRow(all.length - maxRows)]
    : all

  return {
    kind: 'diff',
    title: preview.title,
    ...(preview.filePath !== undefined ? { filePath: preview.filePath } : {}),
    summary: summaryFor(preview),
    rows: preview.elided ? [...rows, elidedRow(droppedLines(preview.elided))] : rows,
  }
}

/**
 * The host tells us how many lines it *dropped* per side, not how many it kept.
 * Reporting the larger side is the honest single number: a 300-line rewrite
 * elides ~300 on both, and summing would claim 600.
 */
export function droppedLines(elided: { oldLines: number; newLines: number }): number {
  return Math.max(elided.oldLines, elided.newLines)
}

function summaryFor(preview: Extract<FileToolPreview, { kind: 'diff' }>): string {
  return preview.elided
    ? `${preview.summary} (${droppedLines(preview.elided)} more lines not shown)`
    : preview.summary
}

function elidedRow(count: number): DiffRow {
  return { kind: 'elided', text: `… ${count} more line${count === 1 ? '' : 's'}` }
}

/**
 * Line rows with a bounded window of context around each change.
 *
 * Exported for the test to drive directly; `previewView` is what a view calls.
 */
export function diffRowsFor(
  oldText: string,
  newText: string,
  contextLines: number = DIFF_CONTEXT_LINES,
): DiffRow[] {
  const rows: DiffRow[] = []
  let oldLine = 1
  let newLine = 1

  // Each part is a run of lines that was added, removed, or left alone.
  const parts = diffLines(oldText, newText).map((part) => ({
    added: part.added === true,
    removed: part.removed === true,
    lines: splitLines(part.value),
  }))

  parts.forEach((part, index) => {
    if (part.added) {
      for (const text of part.lines) {
        rows.push({ kind: 'add', text, newLine })
        newLine += 1
      }
      return
    }
    if (part.removed) {
      for (const text of part.lines) {
        rows.push({ kind: 'del', text, oldLine })
        oldLine += 1
      }
      return
    }

    // Unchanged: keep the tail of the run before a change and the head of the
    // run after one, and collapse whatever is left in the middle.
    const isFirst = index === 0
    const isLast = index === parts.length - 1
    const head = isFirst ? 0 : contextLines
    const tail = isLast ? 0 : contextLines

    if (part.lines.length <= head + tail) {
      for (const text of part.lines) {
        rows.push({ kind: 'ctx', text, oldLine, newLine })
        oldLine += 1
        newLine += 1
      }
      return
    }

    part.lines.forEach((text, lineIndex) => {
      const inHead = lineIndex < head
      const inTail = lineIndex >= part.lines.length - tail
      if (inHead || inTail) {
        rows.push({ kind: 'ctx', text, oldLine, newLine })
      } else if (lineIndex === head) {
        rows.push(elidedRow(part.lines.length - head - tail))
      }
      oldLine += 1
      newLine += 1
    })
  })

  return rows
}

/**
 * `diffLines` keeps the newline on each line, so the final split produces a
 * trailing empty entry for text that ends in one. Dropping it is what stops
 * every diff ending in a phantom blank row.
 */
function splitLines(value: string): string[] {
  const lines = value.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}
