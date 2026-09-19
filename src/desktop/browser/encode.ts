/**
 * Rows and segments into the text a model reads, and pages into that text.
 *
 * No new dependency: a compact table is thirty lines, and the thirty lines are
 * cheaper to own than a formatter whose output we would have to pin anyway. The
 * format is a tab-separated table because the collectors already collapsed every
 * run of whitespace into a single space — a tab cannot appear inside a field, so
 * the separator needs no escaping and costs one character.
 *
 * Column names appear once, in the header. That is the entire compression story
 * and it is worth roughly a third of the bytes of a JSON array of objects.
 */

import { BrowserHostError } from './errors.js'
import type { ElementRow } from './inject/elements.js'
import { MAX_CHARS_MAX, MAX_CHARS_MIN, PAGE_OVERHEAD_RESERVE } from './limits.js'

export const ELEMENT_COLUMNS = ['ref', 'role', 'name', 'text', 'value', 'href', 'flags'] as const

/** Flag name by row key, in the order they are emitted. */
const ELEMENT_FLAGS: ReadonlyArray<[keyof ElementRow, string]> = [
  ['visible', 'visible'],
  ['disabled', 'disabled'],
  ['checked', 'checked'],
  ['focused', 'focused'],
  ['required', 'required'],
]

export interface SnapshotHeadline {
  url: string
  title: string
  /** A page budget ran out during the scan; the rest never left the renderer. */
  scanTruncated: boolean
}

export function clampMaxChars(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.min(MAX_CHARS_MAX, Math.max(MAX_CHARS_MIN, Math.floor(value)))
}

/**
 * One element as one line.
 *
 * `text` is dropped when it merely repeats `name`, which is the common case for
 * links and buttons — the name *is* the text — and duplicating it doubles the
 * cost of the two widest columns.
 */
export function renderElementRow(row: ElementRow): string {
  const name = row.name ?? ''
  const text = row.text ?? ''
  const flags: string[] = []
  for (const [key, label] of ELEMENT_FLAGS) {
    if (row[key] === true) flags.push(label)
  }
  return [row.ref, row.role, name, text === name ? '' : text, row.value ?? '', row.href ?? '', flags.join(' ')].join(
    '\t',
  )
}

export function elementsHeader(head: SnapshotHeadline, total: number): string {
  return metaLine('elements', head, total) + '\n' + ELEMENT_COLUMNS.join('\t')
}

export function textHeader(head: SnapshotHeadline, total: number): string {
  return metaLine('text', head, total)
}

function metaLine(kind: string, head: SnapshotHeadline, total: number): string {
  const parts = [`# ${kind}`, `url=${head.url}`, `title=${head.title}`, `total=${total}`]
  if (head.scanTruncated) {
    parts.push('scanTruncated=true (page budget exhausted; narrow the scope or add a filter — paging cannot reach it)')
  }
  return parts.join('  ')
}

export interface PageSlice {
  text: string
  /** Where the next call resumes. Absent when this page was the last one. */
  nextOffset?: number
}

/**
 * As many lines as fit, measured as they are added.
 *
 * The accounting is per line rather than by re-encoding the whole slice each
 * time: the widths are already fixed by the time a line exists, so a running sum
 * gives the same answer as re-joining and is linear instead of quadratic over a
 * 2,000-row scan.
 *
 * A single line that cannot fit is an error, not an empty page. Returning
 * nothing would invite the caller to page forever through a document it can
 * never read a word of.
 */
export function paginateLines(
  header: string,
  lines: readonly string[],
  offset: number,
  maxChars: number,
  cursorFor: (nextOffset: number) => string,
): PageSlice {
  const start = Math.max(0, Math.floor(offset))
  if (start >= lines.length) return { text: header }

  const budget = maxChars - PAGE_OVERHEAD_RESERVE
  let used = header.length
  let end = start
  while (end < lines.length) {
    const line = lines[end] as string
    const next = used + line.length + 1
    if (next > budget) break
    used = next
    end += 1
  }

  if (end === start) {
    throw new BrowserHostError(
      'OUTPUT_LIMIT',
      `A single row needs more than the ${maxChars} character budget. Raise maxChars, or narrow the request.`,
    )
  }

  const body = lines.slice(start, end).join('\n')
  if (end >= lines.length) return { text: header + '\n' + body }
  return {
    text: header + '\n' + body + '\n' + `# more: ${lines.length - end} remaining  cursor=${cursorFor(end)}`,
    nextOffset: end,
  }
}
