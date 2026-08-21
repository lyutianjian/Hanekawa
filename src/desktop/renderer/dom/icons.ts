/**
 * The renderer's icons, built as real SVG nodes.
 *
 * `dom.ts`'s `el()` calls `createElement`, which cannot make an `<svg>` — SVG
 * lives in its own namespace, and an element created in the HTML namespace with
 * the tag name "svg" renders as nothing at all. So this file is the one place
 * that reaches for `createElementNS`. `innerHTML` is not an option here for the
 * same reason it is not an option anywhere in this tree (see `dom.ts`), even
 * though these strings are ours: the ban is worth more than the exception.
 *
 * Why icons at all: 4e moves the chrome to a proportional system font, and the
 * glyphs this shell was drawing — a 🗑 emoji, the U+27E8/27E9 angle brackets —
 * are exactly the characters that font does not have. A colour-emoji trash can
 * that ignores `color` was the single most visible thing in the old sidebar.
 *
 * Every icon inherits `currentColor`, so an icon is coloured by the rule that
 * colours its button. That is what keeps `--accent-*` on `color` rather than on
 * a `fill` the style test would have to special-case.
 */

const SVG_NS = 'http://www.w3.org/2000/svg'

export type IconName =
  | 'plus'
  | 'trash'
  | 'folder'
  | 'chevron-left'
  | 'chevron-right'
  | 'chevron-down'
  | 'dot'
  | 'send'
  | 'stop'
  | 'gear'

interface IconSpec {
  /** Path data on a 16×16 grid. */
  readonly paths: readonly string[]
  /** Filled shapes (the dot, the stop square) rather than stroked outlines. */
  readonly filled?: boolean
}

/**
 * Keyed `satisfies`, the same drift guard `commandSchema.ts` and
 * `SHELL_COMMAND_SCHEMAS` use: adding a name to `IconName` without drawing it
 * fails the build *by name* rather than rendering an empty box.
 */
const ICONS = {
  plus: { paths: ['M8 3.5v9', 'M3.5 8h9'] },
  trash: {
    paths: [
      'M3 4.5h10',
      'M6.5 4.5V3h3v1.5',
      'M4.6 4.5l.5 8a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.5-8',
    ],
  },
  folder: { paths: ['M2 5a1.5 1.5 0 0 1 1.5-1.5h2.2L7 5h5.5A1.5 1.5 0 0 1 14 6.5v5A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5z'] },
  'chevron-left': { paths: ['M10 3.5 5.5 8l4.5 4.5'] },
  'chevron-right': { paths: ['M6 3.5 10.5 8 6 12.5'] },
  'chevron-down': { paths: ['M3.5 6 8 10.5 12.5 6'] },
  dot: { paths: ['M8 5a3 3 0 1 1 0 6 3 3 0 0 1 0-6z'], filled: true },
  send: { paths: ['M8 13V3.6', 'M3.8 7.8 8 3.5l4.2 4.3'] },
  stop: { paths: ['M5.2 5.2h5.6v5.6H5.2z'], filled: true },
  gear: {
    paths: [
      'M8 10a2 2 0 1 1 0-4 2 2 0 0 1 0 4z',
      'M12.9 9.5a1 1 0 0 0 .2 1.1l.1.1a1.2 1.2 0 1 1-1.7 1.7l-.1-.1a1 1 0 0 0-1.1-.2 1 1 0 0 0-.6.9v.2a1.2 1.2 0 0 1-2.4 0V13a1 1 0 0 0-.7-.9 1 1 0 0 0-1.1.2l-.1.1a1.2 1.2 0 1 1-1.7-1.7l.1-.1a1 1 0 0 0 .2-1.1 1 1 0 0 0-.9-.6h-.2a1.2 1.2 0 0 1 0-2.4H3a1 1 0 0 0 .9-.7 1 1 0 0 0-.2-1.1l-.1-.1a1.2 1.2 0 1 1 1.7-1.7l.1.1a1 1 0 0 0 1.1.2H6.6a1 1 0 0 0 .6-.9v-.2a1.2 1.2 0 0 1 2.4 0V3a1 1 0 0 0 .6.9 1 1 0 0 0 1.1-.2l.1-.1a1.2 1.2 0 1 1 1.7 1.7l-.1.1a1 1 0 0 0-.2 1.1v.1a1 1 0 0 0 .9.6h.2a1.2 1.2 0 0 1 0 2.4H13a1 1 0 0 0-.9.6z',
    ],
  },
} as const satisfies Record<IconName, IconSpec>

export function icon(name: IconName, className = 'icon'): SVGSVGElement {
  const spec: IconSpec = ICONS[name]
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('class', className)
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('width', '16')
  svg.setAttribute('height', '16')
  // Decorative by default: every caller sits inside a button that already
  // carries an `aria-label`, and a second name would be read out twice.
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')

  for (const data of spec.paths) {
    const path = document.createElementNS(SVG_NS, 'path')
    path.setAttribute('d', data)
    if (spec.filled) {
      path.setAttribute('fill', 'currentColor')
    } else {
      path.setAttribute('fill', 'none')
      path.setAttribute('stroke', 'currentColor')
      path.setAttribute('stroke-width', '1.5')
      path.setAttribute('stroke-linecap', 'round')
      path.setAttribute('stroke-linejoin', 'round')
    }
    // `append()` in `dom.ts` is typed for an HTMLElement parent; an SVG element
    // is not one, so this file does its own appending.
    svg.appendChild(path)
  }
  return svg
}
