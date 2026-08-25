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
  | 'file'
  | 'chevron-left'
  | 'chevron-right'
  | 'chevron-down'
  | 'arrow-down'
  | 'dot'
  | 'spinner'
  | 'send'
  | 'stop'
  | 'gear'
  // --- the empty-state screen (5c) ---
  | 'thought-bubble'
  | 'megaphone'
  | 'hammer'
  | 'refresh'
  | 'monitor'
  | 'branch'

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
  // A sheet with a folded corner, for the inline file pills in a user message.
  file: {
    paths: [
      'M4 2.6h4.4L12 6.2v7.2a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V3.6a1 1 0 0 1 1-1z',
      'M8.4 2.6v3.6H12',
    ],
  },
  'chevron-left': { paths: ['M10 3.5 5.5 8l4.5 4.5'] },
  'chevron-right': { paths: ['M6 3.5 10.5 8 6 12.5'] },
  'chevron-down': { paths: ['M3.5 6 8 10.5 12.5 6'] },
  // A full arrow, not the chevron: the jump-to-bottom button is the only place
  // that means "go to the end", and a bare chevron there reads as "collapse".
  'arrow-down': { paths: ['M8 3.2v9.6', 'M4 8.8 8 12.8l4-4'] },
  dot: { paths: ['M8 5a3 3 0 1 1 0 6 3 3 0 0 1 0-6z'], filled: true },
  // A three-quarter ring with a gap, so a CSS rotation reads as spinning. Stroked
  // (not filled) so it inherits `currentColor` like every other outline.
  spinner: { paths: ['M8 3.5a4.5 4.5 0 1 1-4.5 4.5'] },
  send: { paths: ['M8 13V3.6', 'M3.8 7.8 8 3.5l4.2 4.3'] },
  stop: { paths: ['M5.2 5.2h5.6v5.6H5.2z'], filled: true },
  gear: {
    paths: [
      'M8 10a2 2 0 1 1 0-4 2 2 0 0 1 0 4z',
      'M12.9 9.5a1 1 0 0 0 .2 1.1l.1.1a1.2 1.2 0 1 1-1.7 1.7l-.1-.1a1 1 0 0 0-1.1-.2 1 1 0 0 0-.6.9v.2a1.2 1.2 0 0 1-2.4 0V13a1 1 0 0 0-.7-.9 1 1 0 0 0-1.1.2l-.1.1a1.2 1.2 0 1 1-1.7-1.7l.1-.1a1 1 0 0 0 .2-1.1 1 1 0 0 0-.9-.6h-.2a1.2 1.2 0 0 1 0-2.4H3a1 1 0 0 0 .9-.7 1 1 0 0 0-.2-1.1l-.1-.1a1.2 1.2 0 1 1 1.7-1.7l.1.1a1 1 0 0 0 1.1.2H6.6a1 1 0 0 0 .6-.9v-.2a1.2 1.2 0 0 1 2.4 0V3a1 1 0 0 0 .6.9 1 1 0 0 0 1.1-.2l.1-.1a1.2 1.2 0 1 1 1.7 1.7l-.1.1a1 1 0 0 0-.2 1.1v.1a1 1 0 0 0 .9.6h.2a1.2 1.2 0 0 1 0 2.4H13a1 1 0 0 0-.9.6z',
    ],
  },
  // --- the empty-state screen ---
  // A cloud with a terminal prompt inside it, per design_guidance 三.2①. Drawn at
  // 48px there, which is why the shapes are outlines and not detail.
  'thought-bubble': {
    paths: [
      'M5 12a2.6 2.6 0 0 1-.5-5.1 3.4 3.4 0 0 1 6.4-1.3A2.7 2.7 0 0 1 11.4 12z',
      'M6.2 9.6h3.6',
    ],
  },
  megaphone: { paths: ['M4.4 6.3 11.2 3.3v9.4L4.4 9.7z', 'M4.4 6.3H2.7v3.4h1.7', 'M6.7 10.1v2.6'] },
  hammer: { paths: ['M8.9 2.8l4.3 4.3-2 2-4.3-4.3z', 'M6.9 6.8 3 10.7l2.3 2.3 3.9-3.9'] },
  refresh: {
    paths: [
      'M3.2 8a4.8 4.8 0 0 1 8.2-3.4',
      'M12.8 8a4.8 4.8 0 0 1-8.2 3.4',
      'M11.4 2v2.7H8.7',
      'M4.6 14v-2.7h2.7',
    ],
  },
  monitor: {
    paths: [
      'M2.5 4.2a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v5.4a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z',
      'M8 10.6v2.2',
      'M6 12.8h4',
    ],
  },
  branch: {
    paths: [
      'M4.5 2.6a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z',
      'M4.5 10.4a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z',
      'M11.5 2.6a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z',
      'M4.5 5.6v4.8',
      'M11.5 5.6v1.4a2.5 2.5 0 0 1-2.5 2.5H7a2.5 2.5 0 0 0-2.5 2.5',
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
