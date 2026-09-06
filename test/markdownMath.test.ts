import test from 'node:test'
import assert from 'node:assert/strict'

import {
  parseMarkdownBlocks,
  resetMarkdownCache,
  type MdBlock,
  type MdInline,
} from '../src/desktop/renderer/model/markdown.js'

/**
 * TeX detection in the renderer's markdown parser.
 *
 * Split from the typesetting on purpose: what reaches KaTeX is `dom/`'s problem
 * and needs a `document`, while *whether a run of characters is maths at all* is
 * a pure decision and is where every interesting failure lives. Both directions
 * matter and the second is the one prose pays for — a parser that never misses
 * an equation but eats "$5 and $10" has made the transcript worse, so the
 * negatives below outnumber the positives.
 */

test.beforeEach(() => resetMarkdownCache())

function mathsIn(blocks: readonly MdBlock[]): Array<{ tex: string; display: boolean }> {
  const found: Array<{ tex: string; display: boolean }> = []
  const walkInline = (inline: readonly MdInline[]): void => {
    for (const node of inline) {
      if (node.kind === 'math') found.push({ tex: node.tex, display: node.display })
      else if (node.kind === 'strong' || node.kind === 'em' || node.kind === 'del') {
        walkInline(node.children)
      } else if (node.kind === 'link') walkInline(node.children)
    }
  }
  const walk = (list: readonly MdBlock[]): void => {
    for (const block of list) {
      switch (block.kind) {
        case 'math': found.push({ tex: block.tex, display: true }); break
        case 'paragraph': walkInline(block.inline); break
        case 'heading': walkInline(block.inline); break
        case 'quote': walk(block.blocks); break
        case 'list': for (const item of block.items) walk(item.blocks); break
        case 'table':
          for (const cell of block.header) walkInline(cell)
          for (const row of block.rows) for (const cell of row) walkInline(cell)
          break
        default: break
      }
    }
  }
  walk(blocks)
  return found
}

const maths = (content: string): Array<{ tex: string; display: boolean }> =>
  mathsIn(parseMarkdownBlocks(content))

/** The rendered text of a parse, for asserting what stayed prose. */
function textOf(blocks: readonly MdBlock[]): string {
  const inline = (list: readonly MdInline[]): string => list.map((node) => {
    switch (node.kind) {
      case 'text': case 'code': return node.text
      case 'strong': case 'em': case 'del': return inline(node.children)
      case 'link': return inline(node.children)
      case 'math': return `<math:${node.tex}>`
      case 'break': return '\n'
    }
  }).join('')
  return blocks.map((block) => {
    switch (block.kind) {
      case 'paragraph': case 'heading': return inline(block.inline)
      case 'code': return block.text
      case 'math': return `<math:${block.tex}>`
      default: return ''
    }
  }).join('\n')
}

// ── the four delimiter pairs ──

test('`$$…$$` on its own is a display block', () => {
  const blocks = parseMarkdownBlocks('before\n\n$$a^2 + b^2 = c^2$$\n\nafter')
  assert.deepEqual(blocks.map((block) => block.kind), ['paragraph', 'math', 'paragraph'])
  assert.deepEqual(mathsIn(blocks), [{ tex: 'a^2 + b^2 = c^2', display: true }])
})

test('`\\[…\\]` is the same display block', () => {
  assert.deepEqual(maths('\\[a^2 + b^2\\]'), [{ tex: 'a^2 + b^2', display: true }])
})

test('`$…$` is inline maths', () => {
  assert.deepEqual(maths('the value $x^2$ here'), [{ tex: 'x^2', display: false }])
})

test('`\\(…\\)` is inline maths, not an escaped bracket pair', () => {
  // The regression this whole extension exists for. CommonMark reads `\(` as an
  // escape, so before the extension this reached the screen as `(x_1 + x_2)`
  // with the delimiters silently deleted.
  assert.deepEqual(maths('inline \\(x_1 + x_2\\) done'), [{ tex: 'x_1 + x_2', display: false }])
})

test('a display equation under its own lead-in line stays display', () => {
  // The shape a model actually emits: no blank line, so the `$$` lands inside a
  // paragraph. It must not silently demote to inline size.
  const blocks = parseMarkdownBlocks('Average height\n$$\\bar{h} = 42 + 3\\sqrt{2}$$')
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0]?.kind, 'paragraph')
  assert.deepEqual(mathsIn(blocks), [{ tex: '\\bar{h} = 42 + 3\\sqrt{2}', display: true }])
})

test('TeX reaches the model verbatim: no entity decoding, no escape stripping', () => {
  // `decodeEntities` and the escape tokenizer both run on prose; neither may
  // touch the source string, because `&` and `\` are TeX's own syntax.
  assert.deepEqual(maths('$a &lt; b \\{c\\}$'), [{ tex: 'a &lt; b \\{c\\}', display: false }])
})

// ── prose that only looks like maths ──

test('prices are not equations', () => {
  const source = 'It costs $5 and $10, so $15 total.'
  assert.deepEqual(maths(source), [])
  assert.equal(textOf(parseMarkdownBlocks(source)), source)
})

test('a dollar with a space after it does not open, one with a space before does not close', () => {
  assert.deepEqual(maths('$ x $ and $y $ and $ z$'), [])
})

test('a shell variable inside a code span stays a code span', () => {
  const blocks = parseMarkdownBlocks('Use `$HOME` and `$PATH`, or `$(sub)`.')
  assert.deepEqual(mathsIn(blocks), [])
  assert.equal(textOf(blocks), 'Use $HOME and $PATH, or $(sub).')
})

test('a fenced block is never scanned for maths', () => {
  const blocks = parseMarkdownBlocks('```sh\necho $PATH\ntotal=$$\n```')
  assert.equal(blocks[0]?.kind, 'code')
  assert.deepEqual(mathsIn(blocks), [])
})

test('an escaped dollar does not open maths', () => {
  assert.deepEqual(maths('Escaped \\$100 and \\$200 stay prose.'), [])
})

test('an unclosed delimiter costs at most its own paragraph', () => {
  // Mid-stream this is every equation for one frame, so it has to degrade to
  // its own source rather than swallow the rest of the answer.
  const blocks = parseMarkdownBlocks('unclosed $x + y here\n\nthe next paragraph')
  assert.deepEqual(mathsIn(blocks), [])
  assert.equal(blocks.length, 2)
  assert.equal(textOf(blocks), 'unclosed $x + y here\nthe next paragraph')
})

test('an empty or blank pair is not maths', () => {
  // KaTeX renders nothing for either, so accepting them would put a gap in the
  // answer where a row of punctuation was typed.
  assert.deepEqual(maths('$$$$'), [])
  assert.deepEqual(maths('$$   $$'), [])
  assert.deepEqual(maths('\\[ \\]'), [])
})

// ── maths inside the other constructs ──

test('a table cell can hold an equation', () => {
  assert.deepEqual(maths('| a | b |\n| - | - |\n| $x^2$ | ok |'), [{ tex: 'x^2', display: false }])
})

test('a list item and a blockquote can hold one too', () => {
  assert.deepEqual(maths('- item $a_1$\n'), [{ tex: 'a_1', display: false }])
  assert.deepEqual(maths('> quoted $b_2$\n'), [{ tex: 'b_2', display: false }])
})

test('emphasis markers inside maths are not emphasis', () => {
  // `_` and `*` are TeX operators. The extension runs before the `em` tokenizer
  // precisely so a subscript pair cannot italicise the words between them.
  const blocks = parseMarkdownBlocks('$a_i * b_j$ and $c_k$')
  assert.deepEqual(mathsIn(blocks), [
    { tex: 'a_i * b_j', display: false },
    { tex: 'c_k', display: false },
  ])
})

test('the parse cache does not confuse maths with the prose it replaced', () => {
  // The LRU is keyed by content hash and length; a stale hit here would show the
  // previous message's equation under a new one's text.
  assert.deepEqual(maths('$x$'), [{ tex: 'x', display: false }])
  assert.deepEqual(maths('$y$'), [{ tex: 'y', display: false }])
  assert.deepEqual(maths('$x$'), [{ tex: 'x', display: false }])
})

test('the shared `marked` singleton is left alone', async () => {
  // `model/markdown.ts` lexes through its own `Marked` instance rather than
  // `marked.use()`, so importing it must not teach the TUI's parser about maths
  // as a side effect. Both run in this process under `node --test`.
  const { marked } = await import('marked')
  const tokens = marked.lexer('$x^2$')
  assert.ok(
    !JSON.stringify(tokens).includes('math'),
    'importing the renderer parser must not mutate the global marked instance',
  )
})
