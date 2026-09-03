import type { DiffRow, PreviewView } from '../model/diffRows.js'
import { el, replace } from './dom.js'

/** Renders a `PreviewView` — a line diff with a gutter, or the message form. */
export function previewNode(view: PreviewView): HTMLElement {
  const container = el('div')
  const heading = view.filePath ? `${view.title}: ${view.filePath}` : view.title
  container.appendChild(el('div', 'preview-title', heading))

  if (view.kind === 'message') {
    container.appendChild(el('div', 'block', view.message))
    return container
  }

  container.appendChild(el('div', 'block-label', view.summary))
  container.appendChild(diffNode(view.rows))
  return container
}

/**
 * The rows alone — the shared body under the permission preview and, since T13,
 * an editing tool's step. One diff look everywhere: the same gutters, the same
 * add/del paints, the same dashed elision rule.
 */
export function diffNode(rows: readonly DiffRow[]): HTMLElement {
  const diff = el('div', 'diff')
  replace(diff, ...rows.map(rowNode))
  return diff
}

function rowNode(row: DiffRow): HTMLElement {
  const node = el('div', `diff-row ${row.kind}`)
  // An elided row is not a line of the file: no gutter, and the elision itself
  // is a CSS dashed rule rather than a `⋯` glyph (§3 — no character states).
  if (row.kind === 'elided') {
    node.appendChild(el('span', 'rule'))
    node.appendChild(el('span', 'text', row.text))
    return node
  }
  node.appendChild(el('span', 'gutter', gutter(row)))
  node.appendChild(el('span', 'text', row.text))
  return node
}

function gutter(row: DiffRow): string {
  const left = row.oldLine === undefined ? '' : String(row.oldLine)
  const right = row.newLine === undefined ? '' : String(row.newLine)
  const sign = row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '
  return `${left.padStart(3)} ${right.padStart(3)} ${sign}`
}
