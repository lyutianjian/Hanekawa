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
  const diff = el('div', 'diff')
  replace(diff, ...view.rows.map(rowNode))
  container.appendChild(diff)
  return container
}

function rowNode(row: DiffRow): HTMLElement {
  const node = el('div', `diff-row ${row.kind}`)
  node.appendChild(el('span', 'gutter', gutter(row)))
  node.appendChild(el('span', 'text', row.text))
  return node
}

function gutter(row: DiffRow): string {
  if (row.kind === 'elided') return '   ⋯   '
  const left = row.oldLine === undefined ? '' : String(row.oldLine)
  const right = row.newLine === undefined ? '' : String(row.newLine)
  const sign = row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '
  return `${left.padStart(3)} ${right.padStart(3)} ${sign}`
}
