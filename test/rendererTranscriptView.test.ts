import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { installDomStub, type DomStub, type StubView } from './helpers/domStub.js'
import { createTranscriptView } from '../src/desktop/renderer/dom/transcriptView.js'
import { NO_DISCLOSURE } from '../src/desktop/renderer/model/thinking.js'
import type { DisclosureState } from '../src/desktop/renderer/model/thinking.js'
import type { TranscriptItem, TranscriptState } from '../src/desktop/renderer/model/transcript.js'
import type { ToolErrorCode } from '../src/harness/types.js'

/**
 * The third `dom/` unit test, and the one that covers the renderer's only scroll
 * logic. See `test/rendererWelcomeView.test.ts` for why this file is excluded from
 * the base TypeScript program and checked by `tsconfig.domtest.json` instead.
 *
 * The float button is the reason a DOM test is worth it here: whether it is
 * visible depends on three layout numbers, and `model/` cannot see any of them.
 */

const RENDERER = path.join(import.meta.dirname, '..', 'src', 'desktop', 'renderer')

function transcript(items: readonly TranscriptItem[] = [], overrides: Partial<TranscriptState> = {}): TranscriptState {
  return { items, generation: 0, toolProgress: undefined, isThinking: false, thinkingCount: 0, ...overrides }
}

interface Rendered {
  readonly stub: DomStub
  readonly container: HTMLElement
  readonly host: HTMLElement
  /** `[id, what the row showed when it was clicked]`, the absolute-answer pair. */
  readonly toggled: Array<readonly [string, boolean]>
  /** How many times a `TodoWrite` row asked the task panel to flash. */
  readonly taskClicks: () => number
  render(state: TranscriptState, disclosure?: DisclosureState): void
  jump(): StubView
  items(): readonly StubView[]
  column(): StubView
}

function mount(t: { after(fn: () => void): void }): Rendered {
  const stub = installDomStub()
  t.after(() => stub.uninstall())
  const container = stub.createContainer('transcript')
  const host = stub.createContainer('pane')
  const toggled: Array<readonly [string, boolean]> = []
  let taskClicks = 0
  const view = createTranscriptView(container, host, {
    onToggle: (id, expanded) => toggled.push([id, expanded]),
    onTaskStep: () => { taskClicks += 1 },
  })
  const jump = (): StubView => {
    const found = stub.inspect(host).children.find((child) => child.classes.includes('scroll-bottom'))
    assert.ok(found, 'no .scroll-bottom in the float host')
    return found
  }
  const column = (): StubView => {
    const children = stub.inspect(container).children
    const found = children.find((child) => child.classes.includes('transcript-column'))
    assert.ok(found, `no .transcript-column in the scroller (children: ${children.length})`)
    return found
  }
  return {
    stub,
    container,
    host,
    taskClicks: () => taskClicks,
    toggled,
    render: (state, disclosure = NO_DISCLOSURE) => view.render(state, disclosure),
    jump,
    // Through `.transcript-column`, the one box the items live in: the scroller
    // stays full width (its scrollbar belongs at the panel's edge) while the text
    // is capped at a reading measure. `the items paint inside one reading column`
    // below is what keeps this indirection honest.
    items: () => column().children,
    column,
  }
}

/** Places the reader `distance` px above the tail of a 1000px scroller. */
function scrolledUpBy(stub: DomStub, container: HTMLElement, distance: number): void {
  stub.setMetrics(container, { scrollHeight: 1000, clientHeight: 200, scrollTop: 800 - distance })
}

test('the float button is built once, outside the scroller, and starts hidden', (t) => {
  const { render, jump, stub, container, host } = mount(t)

  const before = jump().node
  assert.equal(jump().hidden, true, 'at the bottom of an empty transcript there is nowhere to jump to')
  assert.equal(jump().attributes.get('aria-label'), '回到最新')

  scrolledUpBy(stub, container, 400)
  render(transcript([{ id: 'a', kind: 'user', text: 'hi' }]))

  // Identity across a repaint: the button lives in the host, and `replace()` on
  // the scroller must not be able to reach it.
  assert.equal(jump().node, before)
  assert.equal(stub.inspect(host).children.filter((c) => c.classes.includes('scroll-bottom')).length, 1)
  assert.equal(stub.inspect(container).children.some((c) => c.classes.includes('scroll-bottom')), false)
})

test('scrolling up reveals the float button and returning to the tail hides it', (t) => {
  const { jump, stub, container } = mount(t)

  scrolledUpBy(stub, container, 400)
  stub.dispatch(container, 'scroll')
  assert.equal(jump().hidden, false)

  // Inside the 24px slack the reader counts as being at the tail.
  scrolledUpBy(stub, container, 10)
  stub.dispatch(container, 'scroll')
  assert.equal(jump().hidden, true)
})

test('a paint re-decides visibility, because the content can move the verdict', (t) => {
  const { render, jump, stub, container } = mount(t)

  scrolledUpBy(stub, container, 400)
  render(transcript([{ id: 'a', kind: 'assistant', text: 'x' }]))
  assert.equal(jump().hidden, false)

  // A `turn-end` dropping its draft shortens the scroller under the reader, who is
  // now at the tail without ever having scrolled. No `scroll` event is fired here
  // on purpose: this is what the paint-time recompute is for.
  stub.setMetrics(container, { scrollHeight: 400 })
  render(transcript())
  assert.equal(jump().hidden, true)
})

test('clicking the float button jumps to the tail', (t) => {
  const { jump, stub, container } = mount(t)

  scrolledUpBy(stub, container, 400)
  stub.dispatch(container, 'scroll')
  stub.click(jump().node)

  assert.equal(stub.inspect(container).scrollTop, 1000)
  // The stub fires `scroll` from `scrollTo`, as the browser does, so the button
  // hides through the same path it takes for real rather than from the handler.
  assert.equal(jump().hidden, true)
})

test('the transcript follows the tail only when the reader is already there', (t) => {
  const { render, stub, container } = mount(t)

  stub.setMetrics(container, { scrollHeight: 1000, clientHeight: 200, scrollTop: 800 })
  render(transcript([{ id: 'a', kind: 'assistant', text: 'x' }]))
  assert.equal(stub.inspect(container).scrollTop, 1000, 'at the tail: follow it')

  scrolledUpBy(stub, container, 400)
  render(transcript([{ id: 'a', kind: 'assistant', text: 'xy' }]))
  assert.equal(stub.inspect(container).scrollTop, 400, 'reading back: stay put')
})

test('the items paint inside one reading column, and the scroller stays bare', (t) => {
  // The reading measure (design_guidance 四.2) is a box, not a `max-width` on the
  // scroller: the user bubble is right-aligned with `margin-left: auto`, which
  // only means "the right edge of the column" while the column is a real element,
  // and the scrollbar has to stay at the panel's edge rather than at 760px.
  // Verified by mutation: rendering the items straight into the scroller reds this.
  const { render, column, container, stub } = mount(t)

  render(transcript([
    { id: 'a', kind: 'user', text: 'hi' },
    { id: 'b', kind: 'assistant', text: 'ok' },
  ]))

  const children = stub.inspect(container).children
  // Also load-bearing since todo V2: the scroller is a flex column and the
  // column's `margin-top: auto` claims *all* of its free space. A second child
  // would split that space and a short conversation would stop meeting the
  // composer.
  assert.equal(children.length, 1, 'the scroller holds the column and nothing else')
  assert.equal(children[0]?.className, 'transcript-column')
  assert.deepEqual(column().children.map((item) => item.classes[0]), ['item', 'item'])

  // And it is rebuilt, not accumulated: `replace()` empties the scroller, so a
  // second paint must not leave two columns behind.
  render(transcript([{ id: 'a', kind: 'user', text: 'hi' }]))
  assert.equal(stub.inspect(container).children.length, 1)
})

test('loose items paint the way they always did', (t) => {
  const { render, items } = mount(t)

  render(transcript([
    { id: 'a', kind: 'user', text: 'hi' },
    { id: 'b', kind: 'tool', text: 'Bash(ls)', pending: true },
    { id: 'c', kind: 'tool', text: 'Bash failed', failed: true },
  ]))

  assert.deepEqual(items().map((item) => item.classes), [
    ['item', 'user'],
    ['item', 'tool', 'pending'],
    ['item', 'tool', 'failed'],
  ])
  assert.deepEqual(items().map((item) => item.text), ['hi', 'Bash(ls)', 'Bash failed'])
})

// --- the thinking disclosure (5d) -------------------------------------------

const liveThinking: TranscriptItem = { id: 'thinking-0', kind: 'thinking', text: '推理', pending: true }
const sealedThinking: TranscriptItem = {
  id: 'thinking-0', kind: 'thinking', text: '推理', summary: '已处理 7m 38s',
}

const thinking = (items: readonly StubView[]): StubView => {
  const found = items.find((item) => item.classes.includes('thinking'))
  assert.ok(found, 'no thinking item was painted')
  return found
}

test('a streaming block is open, breathing, and shows the live label', (t) => {
  const { render, items } = mount(t)
  render(transcript([liveThinking]))
  const block = thinking(items())

  assert.deepEqual(block.classes, ['item', 'thinking', 'pending', 'live'])
  const header = block.children[0]
  assert.equal(header?.tagName, 'BUTTON')
  assert.equal(header?.text, '正在思考')
  assert.equal(header?.attributes.get('aria-expanded'), 'true')
  assert.equal(block.children[1]?.className, 'thinking-body')
  assert.equal(block.children[1]?.text, '推理')
})

test('a sealed block is collapsed, shows the elapsed time, and drops its body', (t) => {
  const { render, items } = mount(t)
  render(transcript([sealedThinking]))
  const block = thinking(items())

  assert.deepEqual(block.classes, ['item', 'thinking', 'collapsed'])
  assert.equal(block.children[0]?.text, '已处理 7m 38s')
  assert.equal(block.children[0]?.attributes.get('aria-expanded'), 'false')
  // 「已处理 Xm Xs `⌵`」 (design_guidance 四.3): the caret trails the label. The
  // rule that flips it while the block is open matches on the class, so the
  // position is free to be the spec's. Verified by mutation: `trailingIcon` back
  // to `icon` reds this.
  assert.equal(block.children[0]?.children[0]?.className, 'btn-label')
  assert.equal(block.children[0]?.children.at(-1)?.tagName, 'svg')
  // Absent, not hidden: the transcript is an `aria-live` region, and a collapsed
  // block must not be read out.
  assert.equal(block.children.length, 1)
  assert.equal(block.text.includes('推理'), false)
})

test('the pane is absolute answer outranks the default, both ways', (t) => {
  const { render, items } = mount(t)

  render(transcript([sealedThinking]), new Map([['thinking-0', true]]))
  assert.equal(thinking(items()).classes.includes('collapsed'), false)
  assert.equal(thinking(items()).children[1]?.className, 'thinking-body')

  render(transcript([liveThinking]), new Map([['thinking-0', false]]))
  assert.equal(thinking(items()).classes.includes('collapsed'), true)
  assert.equal(thinking(items()).children.length, 1)
})

test('clicking the header reports the block id and what it showed', (t) => {
  const { render, items, stub, toggled } = mount(t)
  render(transcript([{ id: 'm1', kind: 'user', text: 'hi' }, sealedThinking]))

  // The second half is what makes the answer absolute: the pane stores the
  // opposite of what the row showed, so the first click always does the visible
  // thing whether or not a default was in force.
  stub.click(thinking(items()).children[0]?.node)
  assert.deepEqual(toggled, [['thinking-0', false]])
})

// --- activity groups (T7) ----------------------------------------------------

/**
 * A turn's items, the way the model hands them over: everything stamped with the
 * same `turnId` is one group, and the user's message stays outside it (§4.1, §4.4).
 */
function turnItems(overrides: { pending?: boolean } = {}): TranscriptItem[] {
  const tool: TranscriptItem = {
    id: 'call-1',
    kind: 'tool',
    text: 'Read a.ts',
    toolName: 'Read',
    turnId: 't1',
    ...(overrides.pending === true ? { pending: true } : {}),
    tool: {
      displayName: 'Read',
      useSummary: 'a.ts',
      ...(overrides.pending === true
        ? {}
        : { headerSuffix: '240 行', resultSummary: 'Read 240 lines', detail: 'line one', durationMs: 400 }),
    },
  }
  return [
    { id: 'm1', kind: 'user', text: 'hi', turnId: 't1' },
    { id: 'th1', kind: 'thinking', text: '先看看这个文件', summary: '思考 2s', turnId: 't1' },
    tool,
  ]
}

const groupOf = (rendered: Rendered): StubView => {
  const found = rendered.items().find((item) => item.classes.includes('activity-group'))
  assert.ok(found, 'no activity group was painted')
  return found
}

test('a turn is one group: the user message outside it, its steps within', (t) => {
  const view = mount(t)
  view.render(transcript(turnItems({ pending: true })))

  assert.deepEqual(view.items().map((entry) => entry.classes[0]), ['item', 'activity-group'])
  const group = groupOf(view)
  // Running, so the group is open and the steps are real nodes under it.
  assert.deepEqual(group.classes, ['activity-group', 'running'])
  const head = group.children[0]
  assert.equal(head?.tagName, 'BUTTON')
  assert.equal(head?.text, '工作中 · 2 步')
  assert.equal(head?.attributes.get('aria-expanded'), 'true')
  assert.equal(group.children[1]?.className, 'group-steps')
  assert.deepEqual(
    group.children[1]?.children.map((step) => step.classes),
    [['step', 'thinking', 'collapsed'], ['step', 'tool', 'running']],
    'only the current step is open by default',
  )
})

test('a finished group collapses, and its steps are absent rather than hidden', (t) => {
  const view = mount(t)
  view.render(transcript(turnItems()))
  const group = groupOf(view)

  assert.equal(group.classes.includes('collapsed'), true)
  assert.equal(group.children[0]?.attributes.get('aria-expanded'), 'false')
  // The transcript is an `aria-live` region: a folded turn must not be readable.
  assert.equal(group.children.length, 1, 'a collapsed group holds nothing but its head')
  assert.equal(group.text.includes('line one'), false)
  // 「12 步里有一个红的」 without opening anything: one micro bead per tool step.
  const beads = group.children[0]?.children.find((child) => child.classes.includes('group-beads'))
  assert.deepEqual(beads?.children.map((one) => one.className), ['group-bead done'])
  assert.equal(beads?.attributes.get('aria-hidden'), 'true')
})

test('a step head is a button whose body exists only while it is open', (t) => {
  const view = mount(t)
  // Opened by hand: an absolute answer, so the sealed turn's default is overruled.
  view.render(transcript(turnItems()), new Map([['t1', true], ['call-1', true]]))
  const steps = groupOf(view).children[1]
  const tool = steps?.children[1]

  const head = tool?.children[0]
  assert.equal(head?.tagName, 'BUTTON')
  assert.equal(head?.attributes.get('aria-expanded'), 'true')
  // The bead is decoration; the state reaches a screen reader as words instead.
  assert.equal(head?.children[0]?.className, 'step-bead done')
  assert.equal(head?.children[0]?.attributes.get('aria-hidden'), 'true')
  assert.equal(head?.attributes.get('aria-label'), 'Read · a.ts · 240 行 · 完成')
  assert.deepEqual(
    head?.children.slice(1).map((part) => [part.className, part.text]),
    [['step-name', 'Read'], ['step-summary', 'a.ts'], ['step-suffix', '240 行'], ['step-duration', '0.4s']],
  )
  // 兜底 body: the result's own summary over `detail ?? content` (§6.2).
  assert.deepEqual(
    tool?.children[1]?.children.map((part) => [part.className, part.text]),
    [['step-body-head', 'Read 240 lines'], ['step-body-text', 'line one']],
  )

  view.render(transcript(turnItems()), new Map([['t1', true]]))
  const collapsed = groupOf(view).children[1]?.children[1]
  assert.equal(collapsed?.children.length, 1, 'folded: the head and nothing else')
  assert.equal(collapsed?.children[0]?.attributes.get('aria-expanded'), 'false')
})

test('both disclosure levels report their own id and what they showed', (t) => {
  const view = mount(t)
  view.render(transcript(turnItems()))

  const group = groupOf(view)
  view.stub.click(group.children[0]?.node)
  assert.deepEqual(view.toggled, [['t1', false]], 'the group answers under its turn id')

  view.render(transcript(turnItems()), new Map([['t1', true]]))
  const steps = groupOf(view).children[1]
  view.stub.click(steps?.children[0]?.children[0]?.node)
  view.stub.click(steps?.children[1]?.children[0]?.node)
  assert.deepEqual(view.toggled.slice(1), [['th1', false], ['call-1', false]])
})

test('nodes are kept by id across paints, so the scroll anchor survives', (t) => {
  // The reason this stopped being a performance question: steps collapse *by
  // themselves* when the turn ends, and `overflow-anchor` can only absorb that
  // while the node it points at outlives the paint. Verified by mutation:
  // rebuilding the column every render reds every identity assertion below.
  const view = mount(t)
  view.render(transcript(turnItems({ pending: true })))
  const before = {
    column: view.column().node,
    message: view.items()[0]?.node,
    group: groupOf(view).node,
    step: groupOf(view).children[1]?.children[0]?.node,
  }

  // A later paint of the same turn, with the tool now settled: fresh item objects
  // throughout, as the model mints them.
  view.render(transcript(turnItems()), new Map([['t1', true]]))
  assert.equal(view.column().node, before.column)
  assert.equal(view.items()[0]?.node, before.message, 'an untouched message is not rebuilt')
  assert.equal(groupOf(view).node, before.group)
  assert.equal(groupOf(view).children[1]?.children[0]?.node, before.step, 'the step is refilled in place')

  // And a node whose entry is gone does not linger in the cache: `transcript-reset`
  // restarts the id counter, so a kept node would come back holding another
  // block's content.
  view.render(transcript([{ id: 'reset-notice-0', kind: 'notice', text: '已清空' }]))
  view.render(transcript(turnItems({ pending: true })))
  assert.notEqual(groupOf(view).children[1]?.children[0]?.node, before.step)
})

// --- the edit family's real diff (T13) ---------------------------------------

/**
 * The unified patch an editing tool ships in `display.detail` (T12): one hunk,
 * one change — `+1 −1` on the head, five rows in the body.
 */
const EDIT_PATCH = [
  '--- a/a.ts',
  '+++ b/a.ts',
  '@@ -1,4 +1,4 @@',
  ' one',
  ' two',
  '-three',
  '+THREE',
  ' four',
].join('\n')

/** Two hunks, so both the skipped head and the gap between them are elided. */
const GAP_PATCH = [
  '--- a/b.ts',
  '+++ b/b.ts',
  '@@ -10,3 +10,3 @@',
  ' x',
  '-y',
  '+Y',
  ' z',
  '@@ -40,3 +40,3 @@',
  ' p',
  '-q',
  '+Q',
  ' r',
].join('\n')

function editStep(overrides: { detail?: string; toolName?: string } = {}): TranscriptItem {
  return {
    id: 'edit-1',
    kind: 'tool',
    text: 'Edit a.ts',
    toolName: overrides.toolName ?? 'Edit',
    turnId: 't1',
    tool: {
      displayName: 'Edit',
      useSummary: 'a.ts',
      resultSummary: 'Edited a.ts',
      ...(overrides.detail === undefined ? {} : { detail: overrides.detail }),
      content: 'Edited a.ts',
      durationMs: 200,
    },
  }
}

test('an edit step carries its patch counts in the head and a real diff below', (t) => {
  const view = mount(t)
  view.render(transcript([editStep({ detail: EDIT_PATCH })]), new Map([['t1', true], ['edit-1', true]]))

  const step = groupOf(view).children[1]?.children[0]
  assert.deepEqual(step?.classes, ['step', 'tool', 'done'])
  const head = step?.children[0]
  // `Edit src/foo.ts · +12 −3` (§6.2): the counts sit where a suffix would,
  // because for this family they *are* the result's note.
  assert.deepEqual(
    head?.children.slice(1).map((part) => [part.className, part.text]),
    [['step-name', 'Edit'], ['step-summary', 'a.ts'], ['step-suffix', '+1 −1'], ['step-duration', '0.2s']],
  )
  assert.equal(head?.attributes.get('aria-label'), 'Edit · a.ts · +1 −1 · 完成')

  // The body is the same diff the permission dialog paints: gutters with both
  // line numbers, and nothing else — the result summary is not repeated over it.
  const body = step?.children[1]
  assert.equal(body?.className, 'step-body')
  assert.equal(body?.children.length, 1)
  const diff = body?.children[0]
  assert.equal(diff?.className, 'diff')
  assert.deepEqual(diff?.children.map((row) => row.classes), [
    ['diff-row', 'ctx'],
    ['diff-row', 'ctx'],
    ['diff-row', 'del'],
    ['diff-row', 'add'],
    ['diff-row', 'ctx'],
  ])
  assert.deepEqual(diff?.children[2]?.children.map((part) => [part.className, part.text]), [
    ['gutter', '  3     -'],
    ['text', 'three'],
  ])
})

test('a folded edit head keeps the counts, and the diff is absent rather than hidden', (t) => {
  const view = mount(t)
  view.render(transcript([editStep({ detail: EDIT_PATCH })]), new Map([['t1', true]]))

  const step = groupOf(view).children[1]?.children[0]
  assert.equal(step?.children.length, 1, 'folded: the head and nothing else')
  assert.equal(step?.children[0]?.children.some((part) => part.classes.includes('step-suffix')), true)
  assert.equal(step?.text.includes('one'), false, 'an `aria-live` region must not read the folded rows')
})

test('an edit record without a patch falls back to the plain body, without erroring', (t) => {
  const view = mount(t)
  view.render(transcript([editStep()]), new Map([['t1', true], ['edit-1', true]]))

  const step = groupOf(view).children[1]?.children[0]
  // No patch to count, so no suffix — the head is what it was before T13.
  assert.equal(step?.children[0]?.children.some((part) => part.classes.includes('step-suffix')), false)
  // And the body is the fallback family (§6.2 兜底): the summary over `content`.
  const body = step?.children[1]
  assert.deepEqual(body?.children.map((part) => [part.className, part.text]), [
    ['step-body-head', 'Edited a.ts'],
    ['step-body-text', 'Edited a.ts'],
  ])
})

test("a Bash output that happens to be a patch stays a terminal block, not a diff", (t) => {
  const view = mount(t)
  // `git diff` genuinely prints a unified patch — with colours, even. The family
  // is the design's own assignment by tool name (§6.2), so the output is the
  // terminal block's text, rows and all, and never a parsed `.diff`.
  view.render(
    transcript([bashStep({ content: EDIT_PATCH })]),
    new Map([['t1', true], ['bash-1', true]]),
  )

  const body = groupOf(view).children[1]?.children[0]?.children[1]
  assert.equal(body?.children.some((child) => child.classes.includes('diff')), false)
  assert.equal(body?.children[0]?.className, 'step-terminal')
  assert.equal(body?.children[0]?.text, EDIT_PATCH)
})

test('skipped lines draw as dashed rules with the count, never as glyphs', (t) => {
  const view = mount(t)
  view.render(transcript([editStep({ detail: GAP_PATCH })]), new Map([['t1', true], ['edit-1', true]]))

  const diff = groupOf(view).children[1]?.children[0]?.children[1]?.children[0]
  const elided = diff?.children.filter((row) => row.classes.includes('elided'))
  // Both the file head the first hunk skipped and the gap between the hunks.
  assert.deepEqual(elided?.map((row) => row.text), ['9 more lines not shown', '27 more lines not shown'])
  for (const row of elided ?? []) {
    // The rule is a span the sheet paints, and no gutter — an elided row is not
    // a line of the file.
    assert.deepEqual(row.children.map((part) => part.className), ['rule', 'text'])
  }
  // §3: the elision glyph is gone from the block entirely, in any form.
  assert.equal(diff?.text.includes('…'), false)
  assert.equal(diff?.text.includes('⋯'), false)
})

// --- the shell family's terminal block (T14) --------------------------------

/**
 * The output of a command that used its terminal — colours, a progress line's
 * erase-and-jump, the lot. Exactly what prints as `[32m` garbage unstripped.
 */
const ANSI_OUTPUT = '\x1b[32mok\x1b[0m 42 passed\n\x1b[2K\x1b[1G\x1b[31m3 failed\x1b[0m'

function bashStep(overrides: {
  failed?: boolean
  errorCode?: ToolErrorCode
  content?: string
  detail?: string
} = {}): TranscriptItem {
  return {
    id: 'bash-1',
    kind: 'tool',
    text: 'Bash npm test',
    toolName: 'Bash',
    turnId: 't1',
    ...(overrides.failed === true ? { failed: true } : {}),
    tool: {
      displayName: 'Bash',
      useSummary: 'npm test',
      content: overrides.content ?? ANSI_OUTPUT,
      ...(overrides.detail === undefined ? {} : { detail: overrides.detail }),
      ...(overrides.errorCode === undefined ? {} : { errorCode: overrides.errorCode }),
      durationMs: 3200,
    },
  }
}

test('a Bash step opens into a terminal block with its output ANSI-stripped', (t) => {
  const view = mount(t)
  view.render(transcript([bashStep()]), new Map([['t1', true], ['bash-1', true]]))

  const step = groupOf(view).children[1]?.children[0]
  assert.deepEqual(step?.classes, ['step', 'tool', 'done'])
  // The block is the command's own output and nothing else — the head already
  // said what ran and how long, so there is no summary line above it (§6.2).
  const body = step?.children[1]
  assert.equal(body?.className, 'step-body')
  assert.deepEqual(body?.children.map((child) => child.className), ['step-terminal'])
  assert.equal(body?.children[0]?.tagName, 'PRE')
  // §6.4: the sequences are stripped, not printed — a real `npm test` line, not
  // the `[32m` garbage the raw string would show.
  assert.equal(body?.children[0]?.text, 'ok 42 passed\n3 failed')
  assert.equal(body?.text.includes('\x1b'), false)
})

test('a failed Bash step names its error code on its own line and reddens the whole block', (t) => {
  const view = mount(t)
  view.render(
    transcript([bashStep({ failed: true, errorCode: 'command_failed' })]),
    new Map([['t1', true], ['bash-1', true]]),
  )

  const step = groupOf(view).children[1]?.children[0]
  // `failed` is the class the stylesheet keys the whole terminal block's danger
  // colour on (`.step.failed .step-terminal`): the colour is never the only
  // carrier — the code is right there in words, above the output it failed on.
  assert.deepEqual(step?.classes, ['step', 'tool', 'failed'])
  const body = step?.children[1]
  assert.deepEqual(
    body?.children.map((child) => [child.className, child.text]),
    [['step-error', '错误码 command_failed'], ['step-terminal', 'ok 42 passed\n3 failed']],
  )
})

test('the terminal shows what the command printed, not the collapsed line’s extract', (t) => {
  const view = mount(t)
  // A backgrounded shell's `detail` is the one-line extract the collapsed row
  // reads; the full start message in `content` is the transcript the block owes
  // the reader — the task id is what they need to call BashOutput with.
  view.render(
    transcript([bashStep({ content: 'Task ID: bg-1\nPID: 123', detail: 'PID: 123' })]),
    new Map([['t1', true], ['bash-1', true]]),
  )

  const body = groupOf(view).children[1]?.children[0]?.children[1]
  assert.equal(body?.children[0]?.className, 'step-terminal')
  assert.equal(body?.children[0]?.text, 'Task ID: bg-1\nPID: 123')
})

// --- inline file pills (5d) --------------------------------------------------

test('a mention in the user bubble is a pill, interleaved with the text as typed', (t) => {
  const { render, items } = mount(t)
  render(transcript([{ id: 'm1', kind: 'user', text: '把 @a.ts 搬到 @"b c.ts"' }]))
  const bubble = items()[0]
  assert.ok(bubble)

  const shapes = bubble.nodes.map((node) => (typeof node === 'string' ? node : node.className))
  assert.deepEqual(shapes, ['把 ', 'file-chip', ' 搬到 ', 'file-chip'])
  const chips = bubble.children
  assert.deepEqual(chips.map((chip) => chip.tagName), ['SPAN', 'SPAN'], 'read-only, so not a button')
  assert.deepEqual(chips.map((chip) => chip.text), ['a.ts', 'b c.ts'])
  // The icon comes first, then the label — and the icon is a real SVG node.
  assert.equal(chips[0]?.children[0]?.tagName, 'svg')
  assert.equal(chips[0]?.children[1]?.className, 'file-chip-label')
})

test('a bubble with no mention is still a single text node', (t) => {
  const { render, items } = mount(t)
  render(transcript([{ id: 'm1', kind: 'user', text: 'mail me at foo@bar.com' }]))

  assert.deepEqual(items()[0]?.nodes, ['mail me at foo@bar.com'])
})

/**
 * The `TodoWrite` row (T10). It never opens — the checklist is drawn once, above
 * the composer — so it is a control that points at that panel instead.
 */
test('a TodoWrite step is a bodyless button that flashes the task panel', (t) => {
  const view = mount(t)
  view.render(transcript(
    [{
      id: 'todo-1',
      kind: 'tool',
      text: 'TodoWrite 3/6',
      toolName: 'TodoWrite',
      turnId: 't1',
      tool: { displayName: 'TodoWrite', useSummary: '3/6', detail: '- [x] one' },
    }],
    { toolProgress: undefined },
  ), new Map([['t1', true]]))

  const step = groupOf(view).children[1]?.children[0]
  assert.deepEqual(step?.classes, ['step', 'task', 'done'])
  const head = step?.children[0]
  assert.equal(head?.tagName, 'BUTTON')
  // No `aria-expanded`: nothing here opens, and a disclosure that never opens is
  // a lie to a screen reader.
  assert.equal(head?.attributes.get('aria-expanded'), undefined)
  // And no body, even though the result carried a `detail` the tool family would
  // have drawn.
  assert.equal(step?.children.length, 1)

  assert.equal(view.taskClicks(), 0)
  view.stub.click(head?.node)
  assert.equal(view.taskClicks(), 1)
  assert.deepEqual(view.toggled, [], 'the row folds nothing')
})

test('only the user bubble grows pills', (t) => {
  const { render, items } = mount(t)
  render(transcript([
    { id: 'a1', kind: 'assistant', text: 'see @a.ts' },
    { id: 't1', kind: 'tool', text: 'Read(@a.ts)' },
    { id: 'n1', kind: 'notice', text: 'wrote @a.ts' },
  ]))

  for (const item of items()) {
    assert.equal(item.children.some((child) => child.classes.includes('file-chip')), false, item.className)
  }
})

test('the stub carries every document member the dom helpers reach for', (t) => {
  const { stub } = mount(t)
  const sources = ['dom.ts', 'controls.ts', 'icons.ts', 'transcriptView.ts', 'markdownView.ts'].map((name) =>
    readFileSync(path.join(RENDERER, 'dom', name), 'utf8'),
  )
  const members = new Set<string>()
  for (const source of sources) {
    for (const match of source.matchAll(/\bdocument\.(\w+)/g)) members.add(match[1]!)
  }

  assert.ok(members.size >= 4, [...members].join(', '))
  for (const member of members) {
    assert.equal(stub.hasDocumentMember(member), true, `the stub is missing document.${member}`)
  }
})
