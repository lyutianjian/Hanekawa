import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { installDomStub, type DomStub, type StubView } from './helpers/domStub.js'
import { trackAnimationStarts, trackIdentity } from './helpers/motion.js'
import { createTranscriptView } from '../src/desktop/renderer/dom/transcriptView.js'
import { NO_DISCLOSURE } from '../src/desktop/renderer/model/thinking.js'
import type { DisclosureState } from '../src/desktop/renderer/model/thinking.js'
import type { TranscriptItem, TranscriptState } from '../src/desktop/renderer/model/transcript.js'
import type { ImageAttachmentRef } from '../src/media/types.js'
import { ANCHOR_REST_PX } from '../src/desktop/renderer/model/transcriptAnchor.js'
import type { WaitingInput } from '../src/desktop/renderer/model/waiting.js'
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
const RUNNING_T1: WaitingInput = { isStreaming: true, turnId: 't1', startedAt: undefined }

// M03: a tool result is not the end of its live turn.
test('M03 keeps the activity group mounted between short tools', (t) => {
  const view = mount(t)
  const identity = trackIdentity(view.column, '.group-steps')
  const activity = { isStreaming: true, turnId: 't1', startedAt: Date.now() }
  const tool: TranscriptItem = { id: 'a', kind: 'tool', text: 'read', turnId: 't1', pending: true,
    toolName: 'Read', tool: { displayName: 'Read', useSummary: 'a.ts' } }
  view.render(transcript([tool]), NO_DISCLOSURE, activity)
  const steps = identity.sample()
  const group = view.items()[0]!.node
  const first = view.items()[0]!.children[1]!.children[0]!.node
  assert.ok(steps)
  view.render(transcript([{ ...tool, pending: undefined }]), NO_DISCLOSURE, activity)
  assert.equal(identity.sample(), steps)
  view.render(transcript([{ ...tool, pending: undefined }, { ...tool, id: 'b' }]), NO_DISCLOSURE, activity)
  assert.equal(identity.sample(), steps)
  assert.equal(identity.replacements, 0)
  assert.equal(view.items()[0]!.node, group)
  assert.equal(view.items()[0]!.children[1]!.children[0]!.node, first)
  assert.equal(view.items()[0]!.classes.includes('done'), false)
  assert.equal(view.items()[0]!.classes.includes('collapsed'), false)
  view.render(transcript([tool]), new Map([['t1', false]]), activity)
  view.render(transcript([tool, { ...tool, id: 'b' }]), new Map([['t1', false]]), activity)
  assert.equal(identity.sample(), undefined, 'a manual fold survives the next step')
})

// M04: an unchanged parent paint must keep its nested head cache alive.
test('M04 keeps the thinking head through an unchanged streaming snapshot', (t) => {
  const view = mount(t)
  const identity = trackIdentity(view.column, '.thinking-step-head')
  const starts = trackAnimationStarts(view.column, '.step-rule', view.stub.observeMotion)
  t.after(starts.dispose)
  let head: unknown
  for (const text of ['A', 'AB', 'AB', 'ABC']) {
    view.render(transcript([{ id: 'th', kind: 'thinking', text, turnId: 't1', pending: true }]),
      NO_DISCLOSURE, { isStreaming: true, turnId: 't1', startedAt: undefined })
    head ??= identity.sample()
    assert.ok(head)
    assert.equal(identity.sample(), head)
  }
  assert.equal(starts.starts, 0)
  const items: TranscriptItem[] = [{ id: 'th', kind: 'thinking', text: 'ABC', turnId: 't1', pending: true }]
  view.render(transcript(items), new Map([['th', false]]), RUNNING_T1)
  view.stub.click(identity.sample() as HTMLElement)
  assert.deepEqual(view.toggled, [['th', false]], 'the surviving head reads the current ref')
  view.render(transcript(items, { generation: 1 }), NO_DISCLOSURE, RUNNING_T1)
  assert.notEqual(identity.sample(), head, 'a reset with reused ids clears the nested cache')
  view.stub.click(identity.sample() as HTMLElement)
  assert.deepEqual(view.toggled.at(-1), ['th', true], 'reset does not inherit the previous disclosure ref')
})

test('M05 keeps the thinking body and settled assistant blocks across deltas', (t) => {
  const view = mount(t)
  const body = trackIdentity(view.column, '.step-body')
  let firstBody: unknown
  let firstParagraph: unknown
  for (const text of ['A', 'AB', 'AB', 'ABC']) {
    view.render(transcript([
      { id: 'th', kind: 'thinking', text, turnId: 't1', pending: true },
      { id: 'answer', kind: 'assistant', text: `Stable.\n\n${text}`, pending: true },
    ]), NO_DISCLOSURE, RUNNING_T1)
    firstBody ??= body.sample()
    firstParagraph ??= view.items()[1]!.children[0]!.node
    assert.equal(body.sample(), firstBody)
    assert.equal(view.items()[1]!.children[0]!.node, firstParagraph)
    assert.equal(view.items()[1]!.children.some((node) => node.className === 'item-meta'), false)
  }
})

test('M09 completion plays once on the live edge and never on historical disclosure', (t) => {
  const view = mount(t)
  const starts = trackAnimationStarts(view.column, '.step-bead', view.stub.observeMotion, 'completing')
  t.after(starts.dispose)
  const tool: TranscriptItem = { id: 'tool', kind: 'tool', turnId: 't1', text: 'read',
    toolName: 'Read', tool: { displayName: 'Read', useSummary: 'a.ts', content: 'a' } }
  const paint = (pending: boolean, open: boolean): void => view.render(
    transcript([{ ...tool, pending }]), new Map([['t1', true], ['tool', open]]), RUNNING_T1,
  )
  paint(false, false)
  const identity = trackIdentity(view.column, '.step-bead')
  const statusBead = identity.sample()
  for (const open of [true, false, true]) paint(false, open)
  assert.equal(identity.sample(), statusBead)
  assert.equal(starts.starts, 0, 'history and reopening do not complete anything')
  paint(true, true)
  paint(false, true)
  assert.equal(starts.classStarts, 1)
  paint(false, false)
  paint(false, true)
  assert.equal(identity.sample(), statusBead)
  assert.equal(starts.classStarts, 1)
  view.stub.dispatch(statusBead as HTMLElement, 'animationend', { animationName: 'breathe' })
  assert.ok(view.stub.inspect(statusBead as HTMLElement).classes.includes('completing'))
  view.stub.dispatch(statusBead as HTMLElement, 'animationend', { animationName: 'bead-pop' })
  assert.equal(view.stub.inspect(statusBead as HTMLElement).classes.includes('completing'), false)
  paint(true, true)
  paint(false, true)
  view.stopClock()
  assert.equal(view.stub.inspect(statusBead as HTMLElement).classes.includes('completing'), false, 'hidden panes cancel feedback')
})

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
  /** `[path, line]` per clicked search row, the `open-in-editor` payload. */
  readonly opened: ReadonlyArray<readonly [string, number | undefined]>
  /** `[imageId, name]` per clicked image line under a user bubble (S12). */
  readonly openedImages: ReadonlyArray<readonly [string, string]>
  /** What each 复制 click handed the pane for the clipboard. */
  readonly copied: readonly string[]
  render(state: TranscriptState, disclosure?: DisclosureState, activity?: WaitingInput): void
  stopClock(): void
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
  const opened: Array<readonly [string, number | undefined]> = []
  const copied: string[] = []
  const openedImages: Array<readonly [string, string]> = []
  let taskClicks = 0
  const view = createTranscriptView(container, host, {
    onToggle: (id, expanded) => toggled.push([id, expanded]),
    onTaskStep: () => { taskClicks += 1 },
    onOpenPath: (path, line) => opened.push([path, line]),
    onOpenImage: (imageId, name) => openedImages.push([imageId, name]),
    onCopy: (text) => copied.push(text),
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
    opened,
    openedImages,
    copied,
    render: (state, disclosure = NO_DISCLOSURE, activity) => view.render(state, disclosure, activity),
    stopClock: () => view.stopClock(),
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
  // By class, not by the whole `className`: an idle paint also carries
  // `settling`, the class that lets the pad sink when a turn ends.
  assert.ok(children[0]?.classes.includes('transcript-column'))
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
  view.render(transcript(turnItems({ pending: true })), NO_DISCLOSURE, RUNNING_T1)

  assert.deepEqual(view.items().map((entry) => entry.classes[0]), ['item', 'activity-group'])
  const group = groupOf(view)
  // Running, so the group is open and the steps are real nodes under it.
  assert.deepEqual(group.classes, ['activity-group', 'running', 'live'])
  const head = group.children[0]
  assert.equal(head?.tagName, 'BUTTON')
  // One *action* — the tool call. The thinking step above it is a row in the
  // group but not work the turn did, and it is not counted.
  assert.equal(head?.children.find((node) => node.className === 'waiting-label')?.text, 'Read')
  assert.equal(head?.attributes.get('aria-expanded'), 'true')
  assert.equal(group.children[1]?.className, 'group-steps')
  assert.deepEqual(
    group.children[1]?.children.map((step) => step.classes),
    [['step', 'thinking', 'collapsed'], ['step', 'tool', 'running']],
    'only the current step is open by default',
  )
})

test('the thinking step’s head keeps its hairline only while the thought is live', (t) => {
  const view = mount(t)
  const thinkingStepOf = (): StubView => {
    const found = groupOf(view).children[1]?.children[0]
    assert.ok(found)
    return found
  }
  // The same turn twice — a pending tool below keeps the group open across both —
  // with the thought still arriving in the first paint and sealed in the second.
  const sealedTurn = turnItems({ pending: true })
  const liveTurn = sealedTurn.map((item) =>
    item.id === 'th1' ? { ...item, pending: true, summary: undefined } : item)

  view.render(transcript(liveTurn), NO_DISCLOSURE, RUNNING_T1)
  const head = thinkingStepOf().children[0]
  assert.deepEqual(head?.classes, ['step-head', 'thinking-step-head'])
  // Its own head class is what the sheet hangs the quiet resting state, the
  // text-only hover and the chevron's reveal on — a tool's head keeps the fill.
  // The hairline runs between the label and the chevron, and carries the sheen.
  assert.deepEqual(
    head?.children.map((child) => child.className || child.tagName),
    ['btn-label', 'step-rule', 'icon'],
  )

  // Sealed: the line was the waiting, so it goes. The head node itself stays —
  // that is what lets the sheen run instead of restarting once per token.
  view.render(transcript(sealedTurn), NO_DISCLOSURE, RUNNING_T1)
  const sealed = thinkingStepOf().children[0]
  assert.equal(sealed?.node, head?.node, 'the head is kept across the seal')
  assert.deepEqual(
    sealed?.children.map((child) => child.className || child.tagName),
    ['btn-label', 'icon'],
  )

  view.stub.click(sealed?.node)
  assert.deepEqual(view.toggled, [['th1', false]])
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
  // No bead strip: a dot per step along a finished head's right edge was a
  // second, wordless report of what the steps below already say — and beside
  // 「已处理」 it read as a verdict on the turn.
  const head = group.children[0]!
  assert.deepEqual(head.children.map((child) => child.className), ['btn-label'])
  assert.equal(head.children[0]!.attributes.get('aria-hidden'), 'true')
  assert.match(head.children[0]!.text, /^已完成|^已处理/)
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

test('the group head reads out a stable name while its visible label tracks activity', (t) => {
  const view = mount(t)
  view.render(transcript(turnItems({ pending: true })), NO_DISCLOSURE, RUNNING_T1)
  const running = groupOf(view).children[0]

  // Visible: the counter. Read out: the status alone — the label is out of the
  // accessibility tree, because this subtree is an `aria-live` region and the
  // count moves once per step (§8).
  assert.equal(running?.attributes.get('aria-label'), '工作中')
  const label = running?.children.find((child) => child.classes.includes('waiting-label'))
  assert.equal(label?.text, 'Read')
  assert.equal(label?.attributes.get('aria-hidden'), 'true')

  // Sealed, the head is written once, so it names the totals it now carries.
  view.render(transcript(turnItems()))
  const done = groupOf(view).children[0]
  assert.equal(done?.attributes.get('aria-label'), '已完成 · 1 步')
})

test('the group survives the automatic collapse it performs at turn end', (t) => {
  // The other half of §8's anchoring rule: the steps folding away is content
  // *disappearing* above the reader, and the browser can only hold their place
  // while the node the anchor points at outlives the paint.
  const view = mount(t)
  view.render(transcript(turnItems({ pending: true })), NO_DISCLOSURE, RUNNING_T1)
  const before = groupOf(view).node
  assert.equal(groupOf(view).children.length, 2)

  view.render(transcript(turnItems()))
  assert.equal(groupOf(view).node, before, 'the group is refilled in place, not replaced')
  assert.equal(groupOf(view).children.length, 1, 'and it folded itself while doing so')
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
  view.render(transcript(turnItems({ pending: true })), NO_DISCLOSURE, RUNNING_T1)
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
  view.render(transcript(turnItems({ pending: true })), NO_DISCLOSURE, RUNNING_T1)
  assert.notEqual(groupOf(view).children[1]?.children[0]?.node, before.step)
})

/**
 * Counts how many children `node` loses from here on.
 *
 * Keeping the *element* across paints is only half of the anchoring rule: it also
 * has to stay attached. A node that leaves the document — even for the rest of one
 * script turn — has its CSS animations cancelled and restarted, and stops being a
 * node `overflow-anchor` can hold a scroll position by. Identity assertions cannot
 * see that, because a node removed and re-appended in the same paint is still the
 * same object; only the removal itself is observable.
 */
function countDetaches(node: unknown): () => number {
  const element = node as { removeChild(child: unknown): void }
  const original = element.removeChild.bind(element)
  let count = 0
  element.removeChild = (child: unknown): void => {
    count += 1
    original(child)
  }
  return () => count
}

test('a streaming paint detaches nothing, so the open step keeps its fold and its anchor', (t) => {
  // The bug this is the regression for: the column was `replaceChildren`-ed and
  // the group `replace()`-d on every paint, so the open thinking step was pulled
  // out of the page and put back once per streamed token. `unfold` is 220ms and
  // the tokens are faster than that, so the body pumped up from zero height for
  // the whole turn and threw everything below it around.
  const streaming = (thought: string, answer: string): TranscriptItem[] => [
    { id: 'm1', kind: 'user', text: 'hi', turnId: 't1' },
    { id: 'thinking-0', kind: 'thinking', text: thought, pending: true, turnId: 't1' },
    ...(answer === ''
      ? []
      : [{ id: 'draft', kind: 'assistant', text: answer, turnId: 't1' } as TranscriptItem]),
  ]

  const view = mount(t)
  view.render(transcript(streaming('先', '')), NO_DISCLOSURE, RUNNING_T1)
  const group = groupOf(view)
  const steps = group.children[1]
  const step = steps?.children[0]
  assert.deepEqual(step?.classes, ['step', 'thinking', 'live'], 'the running turn opens its last step')

  const detached = {
    column: countDetaches(view.column().node),
    group: countDetaches(group.node),
    steps: countDetaches(steps?.node),
  }

  // The block streams on, and then the answer starts arriving under it.
  view.render(transcript(streaming('先看看', '')), NO_DISCLOSURE, RUNNING_T1)
  view.render(transcript(streaming('先看看这个文件', '')), NO_DISCLOSURE, RUNNING_T1)
  view.render(transcript(streaming('先看看这个文件', '好')), NO_DISCLOSURE, RUNNING_T1)
  view.render(transcript(streaming('先看看这个文件', '好的，')), NO_DISCLOSURE, RUNNING_T1)

  assert.equal(detached.column(), 0, 'the column re-orders in place; nothing is taken out of the page')
  assert.equal(detached.group(), 0, 'a refill of the group leaves the children it hands back where they are')
  assert.equal(detached.steps(), 0, 'and the open step never leaves its box')
  assert.equal(groupOf(view).children[1]?.children[0]?.node, step?.node, 'still the same step')
  assert.deepEqual(
    view.items().map((entry) => entry.classes[0]),
    ['item', 'activity-group', 'item'],
    'the answer joined the column at the end, outside the group',
  )
})

test('the group head is kept across paints, and still reports what it showed', (t) => {
  // It used to be rebuilt every paint because it closes over the disclosure it
  // reports; it reads that through a ref instead, so a reader who tabbed to it
  // does not lose focus once per token — and the ref, not the paint that built
  // the node, is what the click reports.
  const view = mount(t)
  view.render(transcript(turnItems({ pending: true })), NO_DISCLOSURE, RUNNING_T1)
  const head = groupOf(view).children[0]?.node
  assert.ok(head)

  view.render(transcript(turnItems({ pending: true })), NO_DISCLOSURE, RUNNING_T1)
  assert.equal(groupOf(view).children[0]?.node, head, 'an unchanged head is not rebuilt')

  // Sealed: the same node, renamed, and now reporting the collapse it performed.
  view.render(transcript(turnItems()))
  assert.equal(groupOf(view).children[0]?.node, head, 'the head survives the turn ending')
  assert.equal(groupOf(view).children[0]?.attributes.get('aria-label'), '已完成 · 1 步')
  assert.equal(groupOf(view).children[0]?.attributes.get('aria-expanded'), 'false')

  view.stub.click(head)
  assert.deepEqual(view.toggled, [['t1', false]], 'the kept head reports the paint that is on screen')
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

// --- the search family's grouped list (T15) ---------------------------------

/**
 * The `Grep` payload the tool actually prints: ripgrep rows (`path:line:text`,
 * no space), the Node fallback's `path:line: text` (one space), and — when the
 * result was paginated — the tool's own notice after a blank line.
 */
const GREP_CONTENT = [
  'src/harness/types.ts:39:  readonly turnId?: string',
  'src/harness/types.ts:52:  turnId: string',
  'src/desktop/renderer/model/transcript.ts:52:  turnId?: string',
  '',
  '[Showing results 1..3 of 812 total matches]',
].join('\n')

const GLOB_CONTENT = ['test/a.test.ts', 'test/b.test.ts', 'src/c.ts'].join('\n')

function searchStep(overrides: {
  toolName?: string
  content?: string
  failed?: boolean
} = {}): TranscriptItem {
  const toolName = overrides.toolName ?? 'Grep'
  return {
    id: 'search-1',
    kind: 'tool',
    text: `Search "turnId"`,
    toolName,
    turnId: 't1',
    ...(overrides.failed === true ? { failed: true } : {}),
    tool: {
      displayName: 'Search',
      useSummary: 'pattern: "turnId"',
      resultSummary: 'Found 3 matches across 2 files',
      content: overrides.content ?? GREP_CONTENT,
      durationMs: 900,
    },
  }
}

test('a Grep step carries its counts in the head and its hits grouped by file below', (t) => {
  const view = mount(t)
  view.render(transcript([searchStep()]), new Map([['t1', true], ['search-1', true]]))

  const step = groupOf(view).children[1]?.children[0]
  assert.deepEqual(step?.classes, ['step', 'tool', 'done'])
  // `Grep "turnId" · 3 处 / 2 文件` (§6.2): the counts are the parsed list's
  // own, sitting where a suffix would — the same place the edit family puts
  // its `+12 −3`.
  const head = step?.children[0]
  assert.deepEqual(
    head?.children.slice(1).map((part) => [part.className, part.text]),
    [
      ['step-name', 'Search'],
      ['step-summary', 'pattern: "turnId"'],
      ['step-suffix', '3 处 / 2 文件'],
      ['step-duration', '0.9s'],
    ],
  )
  assert.equal(head?.attributes.get('aria-label'), 'Search · pattern: "turnId" · 3 处 / 2 文件 · 完成')

  // The body: two file groups in first-seen order, the hits under their own
  // file, and the tool's truncation notice as the footnote — a truncated list
  // that looks complete is a lie about coverage.
  const list = step?.children[1]?.children[0]
  assert.equal(list?.className, 'step-search')
  const groups = list?.children.filter((child) => child.classes.includes('search-file')) ?? []
  assert.equal(groups.length, 2)
  assert.equal(groups[0]?.children[0]?.text, 'src/harness/types.ts')
  assert.equal(groups[0]?.children.length, 3, 'the head and two hits')
  assert.equal(groups[1]?.children[0]?.text, 'src/desktop/renderer/model/transcript.ts')
  assert.equal(list?.children.at(-1)?.className, 'step-search-note')
  assert.equal(list?.children.at(-1)?.text, '[Showing results 1..3 of 812 total matches]')
})

test('a hit row shows its line and its text, and names the file:line a click means', (t) => {
  const view = mount(t)
  view.render(transcript([searchStep()]), new Map([['t1', true], ['search-1', true]]))

  const groups = groupOf(view).children[1]?.children[0]?.children[1]?.children[0]?.children ?? []
  const hit = groups[0]?.children[1]
  assert.equal(hit?.tagName, 'BUTTON')
  assert.equal(hit?.className, 'search-hit')
  // The accessible name is the goto argument itself — the one string that
  // cannot be misread about what a click opens.
  assert.equal(hit?.attributes.get('aria-label'), 'src/harness/types.ts:39')
  assert.deepEqual(hit?.children.map((part) => [part.className, part.text]), [
    ['search-hit-line', '39'],
    ['search-hit-text', '  readonly turnId?: string'],
  ])
})

test('clicking a path and a hit emits the open-in-editor payload', (t) => {
  // The acceptance case for T15: the click leaves the view as exactly what the
  // tool printed — a cwd-relative path, plus the hit's own line — and the pane
  // turns that into the shell command. A file header has no line; a hit does.
  const view = mount(t)
  view.render(transcript([searchStep()]), new Map([['t1', true], ['search-1', true]]))

  const list = groupOf(view).children[1]?.children[0]?.children[1]?.children[0]
  view.stub.click(list?.children[0]?.children[0]?.node)
  view.stub.click(list?.children[0]?.children[1]?.node)

  assert.deepEqual(view.opened, [
    ['src/harness/types.ts', undefined],
    ['src/harness/types.ts', 39],
  ])
})

test('a Glob step is a flat list of clickable paths, counted in files', (t) => {
  const view = mount(t)
  view.render(
    transcript([searchStep({ toolName: 'Glob', content: GLOB_CONTENT })]),
    new Map([['t1', true], ['search-1', true]]),
  )

  const step = groupOf(view).children[1]?.children[0]
  // `N 个文件`, not `N 处 / M 文件` — a Glob's file *is* its hit.
  assert.equal(
    step?.children[0]?.children.find((part) => part.classes.includes('step-suffix'))?.text,
    '3 个文件',
  )
  const list = step?.children[1]?.children[0]
  assert.equal(list?.children.length, 3)
  assert.deepEqual(
    list?.children.map((row) => [row.className, row.children[0]?.text]),
    [
      ['search-file', 'test/a.test.ts'],
      ['search-file', 'test/b.test.ts'],
      ['search-file', 'src/c.ts'],
    ],
  )

  view.stub.click(list?.children[1]?.children[0]?.node)
  assert.deepEqual(view.opened, [['test/b.test.ts', undefined]])
})

test('an unparseable search payload falls back to the plain body, without erroring', (t) => {
  const view = mount(t)
  // A failed Grep's error string, or a multiline `-U` match with its `--`
  // separators: not a search list, and the family must not half-parse it into
  // groups nobody clicked. §6.2 兜底 draws it instead.
  view.render(
    transcript([searchStep({ content: 'Error: Invalid regular expression pattern.', failed: true })]),
    new Map([['t1', true], ['search-1', true]]),
  )

  const step = groupOf(view).children[1]?.children[0]
  assert.equal(step?.children[1]?.children.some((child) => child.classes.includes('step-search')), false)
  assert.deepEqual(
    step?.children[1]?.children.map((part) => [part.className, part.text]),
    [
      ['step-body-head', 'Found 3 matches across 2 files'],
      ['step-body-text', 'Error: Invalid regular expression pattern.'],
    ],
  )
  // And no counts were invented for a head that has no list behind it.
  assert.equal(step?.children[0]?.children.some((part) => part.classes.includes('step-suffix')), false)
})

// --- the read, agent and web families' bodies (T16) --------------------------

function readStep(overrides: { content?: string; failed?: boolean } = {}): TranscriptItem {
  return {
    id: 'read-1',
    kind: 'tool',
    text: 'Read a.ts',
    toolName: 'Read',
    turnId: 't1',
    ...(overrides.failed === true ? { failed: true } : {}),
    tool: {
      displayName: 'Read',
      useSummary: 'src/a.ts',
      resultSummary: 'Read 2 lines',
      content: overrides.content ?? 'one\ntwo\n',
      durationMs: 400,
    },
  }
}

test('a Read step opens into the file as a line-numbered code block', (t) => {
  const view = mount(t)
  view.render(transcript([readStep()]), new Map([['t1', true], ['read-1', true]]))

  const step = groupOf(view).children[1]?.children[0]
  // `Read src/foo.ts · 240 行` (§6.2): the count is the block's own, so the head
  // and the body can never disagree about how long the file is.
  const head = step?.children[0]
  assert.deepEqual(
    head?.children.slice(1).map((part) => [part.className, part.text]),
    [['step-name', 'Read'], ['step-summary', 'src/a.ts'], ['step-suffix', '2 行'], ['step-duration', '0.4s']],
  )
  assert.equal(head?.attributes.get('aria-label'), 'Read · src/a.ts · 2 行 · 完成')

  // The body is the file's own lines, one row each with its own number — and
  // no highlighting of any kind: the row is exactly the text the tool read.
  const body = step?.children[1]
  assert.equal(body?.className, 'step-body')
  const block = body?.children[0]
  assert.equal(block?.className, 'step-code')
  // A trailing newline is the last line's terminator, not an extra empty row:
  // the tool counts `one\ntwo\n` as 2 lines, and so does the block.
  assert.deepEqual(
    block?.children.map((row) => [
      row.children[0]?.text,
      row.children[1]?.text,
      row.children[1]?.className,
    ]),
    [['1', 'one', 'step-code-text'], ['2', 'two', 'step-code-text']],
  )
})

function agentStep(): TranscriptItem {
  return {
    id: 'agent-1',
    kind: 'tool',
    text: 'explore agent 扫一遍 tools/',
    toolName: 'Agent',
    turnId: 't1',
    tool: {
      displayName: 'explore agent',
      useSummary: '扫一遍 tools/',
      task: '找到 display 的**所有**用法',
      content: '22 个工具返回了 **display.summary**，其中 6 个带 detail。',
      resultSummary: 'Done (12 tool uses · 34k tokens · 5s)',
      headerSuffix: 'opus',
      durationMs: 41_000,
      subagent: {
        subagentType: 'explore',
        model: 'opus',
        toolUseCount: 12,
        // The run's own 8k-capped record of the same answer: the fuller
        // result content is what the body owes the reader.
        summary: '22 个工具返回了 display.summary。',
      },
    },
  }
}

test('an Agent step opens into its task and the sub-agent answer, with the run in the head', (t) => {
  const view = mount(t)
  view.render(transcript([agentStep()]), new Map([['t1', true], ['agent-1', true]]))

  const step = groupOf(view).children[1]?.children[0]
  // `Agent explore · opus · 12 工具` (§6.2): the run's model and tool count are
  // one suffix unit — and the result's own `headerSuffix` carries that same
  // model, so it stands down rather than saying `opus` twice on the row.
  const head = step?.children[0]
  assert.deepEqual(
    head?.children.slice(1).map((part) => [part.className, part.text]),
    [
      ['step-name', 'explore agent'],
      ['step-summary', '扫一遍 tools/'],
      ['step-suffix', 'opus · 12 工具'],
      ['step-duration', '41s'],
    ],
  )
  assert.equal(head?.attributes.get('aria-label'), 'explore agent · 扫一遍 tools/ · opus · 12 工具 · 完成')
  assert.equal(
    head?.children.filter((part) => part.classes.includes('step-suffix')).length,
    1,
    'the model is not drawn twice',
  )

  // The body is the conversation the call stands for: the task, then the
  // answer — prose, so markdown, with the `**` already a strong node rather
  // than markers a plain body would print.
  const body = step?.children[1]
  assert.equal(body?.className, 'step-body')
  const prompt = body?.children[0]
  assert.equal(prompt?.className, 'step-agent-prompt')
  assert.equal(prompt?.children[0]?.className, 'step-agent-label')
  assert.equal(prompt?.children[0]?.text, '任务')
  assert.equal(prompt?.children[1]?.className, 'step-agent-text md')
  assert.equal(prompt?.children[1]?.text, '找到 display 的所有用法')
  const response = body?.children[1]
  assert.equal(response?.className, 'step-agent-response')
  assert.equal(response?.children[0]?.text, '回复')
  assert.equal(response?.children[1]?.text, '22 个工具返回了 display.summary，其中 6 个带 detail。')
  // Markdown, and the fuller of the two renderings of the answer: the result
  // content, not the run's capped summary.
  assert.equal(response?.children[1]?.children[0]?.tagName, 'P')
  assert.equal(response?.children[1]?.children[0]?.children[0]?.tagName, 'STRONG')
})

function webStep(overrides: { failed?: boolean; errorCode?: ToolErrorCode } = {}): TranscriptItem {
  return {
    id: 'web-1',
    kind: 'tool',
    text: 'Fetch example.com',
    toolName: 'WebFetch',
    turnId: 't1',
    ...(overrides.failed === true ? { failed: true } : {}),
    tool: {
      displayName: 'Fetch',
      useSummary: 'example.com',
      resultSummary: 'Fetched example.com (24.3KB)',
      content: '# Title\n\nsome prose',
      ...(overrides.errorCode === undefined ? {} : { errorCode: overrides.errorCode }),
      durationMs: 1200,
    },
  }
}

test('a WebFetch step opens into the page as the markdown the tool made of it', (t) => {
  const view = mount(t)
  view.render(transcript([webStep()]), new Map([['t1', true], ['web-1', true]]))

  const step = groupOf(view).children[1]?.children[0]
  // The web family has no counts of its own — the fetch's own note stays where
  // the fallback put it, above the body.
  const head = step?.children[0]
  assert.deepEqual(
    head?.children.slice(1).map((part) => [part.className, part.text]),
    [['step-name', 'Fetch'], ['step-summary', 'example.com'], ['step-duration', '1s']],
  )

  // The body is the article: the tool already converted the page to markdown,
  // and rendering it as the `pre` the fallback uses would print `#` and `**`
  // as markers instead of the heading and emphasis they are.
  const body = step?.children[1]
  assert.deepEqual(
    body?.children.map((part) => part.className),
    ['step-body-head', 'step-web md'],
  )
  const article = body?.children[1]
  assert.equal(article?.children[0]?.tagName, 'H1')
  assert.equal(article?.children[0]?.text, 'Title')
  assert.equal(article?.children[1]?.tagName, 'P')
  assert.equal(article?.children[1]?.text, 'some prose')
})

test('the fallback body still serves the new families when their data is absent', (t) => {
  const view = mount(t)

  // An Agent step with nothing of its own — no task, no run, not even a
  // content the family could answer with (the shape an old or foreign record
  // leaves) — is the fallback family's to draw, not an error.
  view.render(transcript([{
    id: 'agent-old',
    kind: 'tool',
    text: 'Agent(找出问题)',
    toolName: 'Agent',
    turnId: 't1',
    tool: {
      displayName: 'Agent',
      useSummary: '找出问题',
      resultSummary: 'Done',
      detail: '报告',
    },
  }]), new Map([['t1', true], ['agent-old', true]]))
  const agentBody = groupOf(view).children[1]?.children[0]?.children[1]
  assert.equal(agentBody?.children.some((child) => child.classes.includes('step-agent-prompt')), false)
  assert.deepEqual(
    agentBody?.children.map((part) => [part.className, part.text]),
    [['step-body-head', 'Done'], ['step-body-text', '报告']],
  )

  // A failed fetch is a failure first: its own text drawn by the fallback —
  // under the step's `failed` class and its danger colour — not an article.
  view.render(
    transcript([webStep({ failed: true, errorCode: 'execution_failed' })]),
    new Map([['t1', true], ['web-1', true]]),
  )
  const failedBody = groupOf(view).children[1]?.children[0]?.children[1]
  assert.equal(failedBody?.children.some((child) => child.classes.includes('step-web')), false)
  assert.deepEqual(
    failedBody?.children.map((part) => [part.className, part.text]),
    [['step-body-head', 'Fetched example.com (24.3KB)'], ['step-body-text', '# Title\n\nsome prose']],
  )

  // A Read that read nothing has no lines to number: no code block, and no
  // invented `0 行` — the count is the block's own, and there is no block.
  view.render(transcript([readStep({ content: '' })]), new Map([['t1', true], ['read-1', true]]))
  const emptyRead = groupOf(view).children[1]?.children[0]
  assert.equal(emptyRead?.children[0]?.children.some((part) => part.classes.includes('step-suffix')), false)
  const emptyBody = emptyRead?.children[1]
  assert.equal(emptyBody?.children.some((child) => child.classes.includes('step-code')), false)
  assert.deepEqual(
    emptyBody?.children.map((part) => [part.className, part.text]),
    [['step-body-head', 'Read 2 lines']],
  )
})

// --- inline file pills (5d) --------------------------------------------------

test('a mention in the user bubble is a pill, interleaved with the text as typed', (t) => {
  const { render, items } = mount(t)
  render(transcript([{ id: 'm1', kind: 'user', text: '把 @a.ts 搬到 @"b c.ts"' }]))
  // The item is the column; the bubble is the node inside it that the meta row
  // hangs off of.
  const bubble = items()[0]?.children.find((child) => child.classes.includes('user-bubble'))
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

  const bubble = items()[0]?.children.find((child) => child.classes.includes('user-bubble'))
  assert.deepEqual(bubble?.nodes, ['mail me at foo@bar.com'])
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

test('a message carries a meta row: 复制, its model, its time — and a draft carries none', (t) => {
  const { render, items, copied, stub } = mount(t)
  const meta = (item: StubView): StubView | undefined =>
    item.children.find((child) => child.classes.includes('item-meta'))
  // Local time, so the expectation is derived the same way the view derives it.
  const at = new Date(2026, 4, 7, 14, 32).toISOString()

  // The streaming draft has neither a model nor a stamp, so there is no row at
  // all — an empty one would reserve height under a message that is still
  // growing.
  render(transcript([{ id: 'draft', kind: 'assistant', text: 'part', pending: true }]))
  assert.equal(meta(items()[0]!), undefined)

  render(transcript([{ id: 'a1', kind: 'assistant', text: 'part done', model: 'glm-5.3', createdAt: at }]))
  const row = meta(items()[0]!)
  assert.ok(row, 'the committed answer draws its meta row')
  assert.deepEqual(
    row.children.map((child) => [child.classes.join(' '), child.text]),
    [['item-copy', ''], ['item-model', 'glm-5.3'], ['item-time', '14:32']],
    '复制 first, the model in the middle, the time last',
  )
  // The transcript is `aria-live="polite"`: the labels are not what a reader
  // asked to have read out alongside the answer. The button is a real control
  // and names itself.
  assert.equal(row.children[1]!.attributes.get('aria-hidden'), 'true')
  assert.equal(row.children[2]!.attributes.get('aria-hidden'), 'true')
  assert.equal(row.children[0]!.attributes.get('aria-hidden'), undefined)
  assert.equal(row.children[0]!.attributes.get('aria-label'), '复制')

  stub.click(row.children[0]!.node)
  assert.deepEqual(copied, ['part done'], 'the pane is handed the message, not the rendered markdown')

  // The user's bubble has a time and a copy button, and no model to name.
  render(transcript([{ id: 'u1', kind: 'user', text: 'go', createdAt: at }]))
  const userRow = meta(items()[0]!)
  assert.ok(userRow)
  // Outside the bubble, under it: the row is a sibling of the surface, not one
  // of the things inside it.
  assert.deepEqual(
    items()[0]!.children.map((child) => child.className),
    ['user-bubble', 'item-meta'],
  )
  assert.deepEqual(
    userRow.children.map((child) => [child.classes.join(' '), child.text]),
    [['item-copy', ''], ['item-time', '14:32']],
  )
  stub.click(userRow.children[0]!.node)
  assert.deepEqual(copied, ['part done', 'go'])
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

// --- the waiting row ---------------------------------------------------------

/** What the pane hands the view about the turn in flight. */
function waiting(state: TranscriptState, startedAt: number | undefined): WaitingInput {
  return { isStreaming: true, startedAt, turnId: state.turnId }
}

test('the waiting row is the transcript’s tail while a turn is running and nothing is arriving', (t) => {
  const { render, items } = mount(t)
  const state = transcript([{ id: 'u1', kind: 'user', text: '改一下侧栏' }])

  render(state, NO_DISCLOSURE, waiting(state, Date.now() - 5000))

  const row = items()[items().length - 1]!
  assert.deepEqual(row.classes, ['waiting'], 'the row is the last thing in the column')
  assert.deepEqual(
    row.children.map((child) => [child.classes.join(' '), child.text]),
    [['waiting-bead', ''], ['waiting-label', '正在思考'], ['waiting-elapsed', '5s'], ['waiting-hint', 'Esc 中断']],
    'bead, label, elapsed, hint — in that order, and the clock is painted on the first frame',
  )
  // `.transcript` is `aria-live="polite"`: the label is what may be announced,
  // the counter must not be (it changes ten times a second) and neither the
  // bead nor the key hint is what a reader asked to hear alongside the answer.
  assert.equal(row.children[0]!.attributes.get('aria-hidden'), 'true')
  assert.equal(row.children[1]!.attributes.get('aria-hidden'), undefined)
  assert.equal(row.children[2]!.attributes.get('aria-hidden'), 'true')
  assert.equal(row.children[3]!.attributes.get('aria-hidden'), 'true')
})

test('once the turn opens a group, the head carries the status and the row is gone', (t) => {
  const view = mount(t)
  const live = turnItems({ pending: true })
  const startedAt = Date.now() - 6_000

  view.render(transcript(live, { turnId: 't1' }), NO_DISCLOSURE, {
    isStreaming: true,
    startedAt,
    turnId: 't1',
  })

  // Nothing at the tail: the status moved up to the head, where it stays for the
  // rest of the turn instead of walking down the page behind every step.
  assert.equal(view.items().some((item) => item.classes.includes('waiting')), false)
  const head = groupOf(view).children[0]!
  assert.ok(head.classes.includes('live'))
  assert.deepEqual(
    head.children.map((child) => [child.classes.join(' '), child.text]),
    [['waiting-bead', ''], ['waiting-label', 'Read'], ['waiting-elapsed', '6s'], ['waiting-hint', 'Esc 中断']],
    'the running tool’s own name, with the row’s bead, counter and hint',
  )
  // The head's accessible name is the stable one; the label tracks the turn and
  // this subtree is `aria-live`.
  assert.equal(head.children[1]!.attributes.get('aria-hidden'), 'true')
  assert.equal(head.attributes.get('aria-label'), '工作中')

  // The tool settles and the turn keeps running: the label falls back to
  // 「正在思考」 on the *same node*, so the sheen is not restarted.
  const between = turnItems()
  view.render(transcript(between, { turnId: 't1' }), NO_DISCLOSURE, { isStreaming: true, startedAt, turnId: 't1' })
  const still = groupOf(view).children[0]!
  assert.equal(still.node, head.node, 'the head is kept across the step settling')
  assert.equal(still.children[1]!.text, '正在思考')

  // Only the end of the turn seals it.
  view.render(transcript(between, { turnId: undefined }), NO_DISCLOSURE, {
    isStreaming: false,
    startedAt: undefined,
    turnId: undefined,
  })
  const sealed = groupOf(view).children[0]!
  assert.equal(sealed.classes.includes('live'), false)
  assert.match(sealed.text, /^已完成|^已处理/)
})

test('the waiting row keeps its node while it waits, and leaves when the answer starts', (t) => {
  const { render, items } = mount(t)
  const state = transcript([{ id: 'u1', kind: 'user', text: 'go' }])
  const startedAt = Date.now() - 1000

  render(state, NO_DISCLOSURE, waiting(state, startedAt))
  const first = items()[items().length - 1]!.node
  render(state, NO_DISCLOSURE, waiting(state, startedAt))
  assert.equal(items()[items().length - 1]!.node, first, 'a repaint must not rebuild the row under the reader')

  // The first delta lands: `model/waiting.ts` withdraws the row, and the view
  // has to take it off the page rather than leave a second indicator beside the
  // text that is now arriving.
  const arriving = transcript([
    { id: 'u1', kind: 'user', text: 'go' },
    { id: '__draft__', kind: 'assistant', text: '好', pending: true },
  ])
  render(arriving, NO_DISCLOSURE, waiting(arriving, startedAt))
  assert.equal(items().some((item) => item.classes.includes('waiting')), false)
})

test('the waiting clock ticks by itself, and stopClock stops it', async (t) => {
  const { render, items, stopClock } = mount(t)
  const state = transcript([{ id: 'u1', kind: 'user', text: 'go' }])
  const elapsed = (): string => {
    const row = items()[items().length - 1]!
    return row.children.find((child) => child.classes.includes('waiting-elapsed'))!.text
  }

  // Started just under the five-second threshold: the counter is empty on the
  // first paint and fills itself as the clock crosses it — the string moves
  // without a paint, which is the whole reason the row owns a timer.
  render(state, NO_DISCLOSURE, waiting(state, Date.now() - 4_900))
  assert.equal(elapsed(), '', 'a short wait is not worth a number')
  await new Promise((resolve) => setTimeout(resolve, 260))
  const ticked = elapsed()
  assert.notEqual(ticked, '', 'past five seconds the counter appears on its own')

  stopClock()
  await new Promise((resolve) => setTimeout(resolve, 260))
  assert.equal(elapsed(), ticked, 'a stopped clock keeps its last value')
})

test('the kept thinking head reports the disclosure it is showing, both ways', (t) => {
  // The regression the kept head introduced: its click closure is built once, so
  // it reads a mutable ref — and a ref whose key no `node()` claims is pruned and
  // rebuilt every paint, which left the head reporting 「folded」 forever and a row
  // that opened but would not close.
  const view = mount(t)
  const disclosure = new Map<string, boolean>()
  const items = turnItems({ pending: true })
  const paint = (): void => view.render(transcript(items), disclosure, RUNNING_T1)
  const head = (): StubView => {
    const found = groupOf(view).children[1]?.children[0]?.children[0]
    assert.ok(found)
    return found
  }

  paint()
  view.stub.click(head().node)
  assert.deepEqual(view.toggled, [['th1', false]], 'folded, so the click asks to open')

  disclosure.set('th1', true)
  paint()
  view.stub.click(head().node)
  assert.deepEqual(view.toggled, [['th1', false], ['th1', true]], 'open, so the same node asks to close')
})

// --- the newest question's place on screen ------------------------------------

/**
 * A 600px scroller with an 8px inset, holding a conversation `content` px tall,
 * with the newest bubble 72px into the column.
 *
 * Installed as a *rule* rather than written onto nodes: the bubble whose box
 * decides everything here does not exist until the paint that measures it, so
 * there is no earlier moment at which a test could have given it one. See
 * `DomStub.onLayout`.
 *
 * The rule moves with `scrollTop` and grows the column's box by the pad the view
 * last wrote — between them the stub answers the way a browser would, which is
 * the only way the two quantities the view subtracts can be checked at all.
 */
function laidOut(view: Rendered, content = 184): void {
  view.stub.setMetrics(view.container, { clientHeight: 600, scrollHeight: 600, scrollTop: 0 })
  view.stub.onLayout((node) => {
    if (node.classes.includes('transcript')) return { top: 100, bottom: 700 }
    const scrolled = view.container.scrollTop
    if (node.classes.includes('transcript-column')) {
      const pad = Number.parseFloat(node.styleProperties.get('--transcript-pad') ?? '0')
      return { top: 108 - scrolled, bottom: 108 + content + pad - scrolled }
    }
    if (node.classes.includes('user')) return { top: 180 - scrolled, bottom: 220 - scrolled }
    return undefined
  })
}

/**
 * A paint with a turn in flight.
 *
 * The lift is a *streaming* behaviour: the pad exists so the question being
 * answered can own the screen while the answer arrives, and a paint with no
 * turn running rests the pad on its floor instead (see the settling tests
 * below). So every test about where a new question lands has to say that a turn
 * is running, exactly as the pane does.
 */
function live(state: TranscriptState): WaitingInput {
  return waiting(state, undefined)
}

/** The pad the view wrote this paint, as the CSS length it wrote. */
function pad(view: Rendered): string | undefined {
  return view.column().styleProperties.get('--transcript-pad')
}

function currentPad(view: Rendered): number {
  return Number.parseFloat(pad(view) ?? '0')
}

test('a new question is lifted to the top of the viewport, and the pad is what lets it', (t) => {
  const view = mount(t)
  laidOut(view)

  const asked = transcript([{ id: 'a', kind: 'user', text: '你好' }])
  view.render(asked, undefined, live(asked))

  // The bubble starts 80px below the scroller's top edge, and it is the first
  // thing in the session — so it goes up to the scroller's own 8px padding, a
  // travel of 72px.
  assert.equal(view.container.scrollTop, 72, 'the scroller was not moved to the anchor')
  // 600 (the viewport) − 8 (the gap left above it) − 120 (the bubble's top to
  // the end of the scrollable content). Without it the scroller could not move.
  assert.equal(pad(view), '472px')
  // And the pad is *exactly* enough: the anchor's new offset is the scroller's
  // maximum, so a streaming turn's tail-follow lands on the same pixel rather
  // than a few past it.
  // 200 of conversation plus a 472 pad, less the 600 on screen.
  assert.equal(200 + 472 - 600, view.container.scrollTop)
})

test('a question with a turn above it keeps 64px of that turn on screen', (t) => {
  const view = mount(t)
  laidOut(view)

  const asked = transcript([
    { id: 'a', kind: 'user', text: '你好' },
    { id: 'b', kind: 'assistant', text: '你好呀' },
    { id: 'c', kind: 'user', text: '你是谁' },
  ])
  view.render(asked, undefined, live(asked))

  // 80px to the top, less the 64px of the previous answer left visible above it.
  assert.equal(view.container.scrollTop, 16)
  assert.equal(pad(view), '416px', 'and the pad is 56px shorter for the same reason')
})

test('the lift runs once per question, not once per streamed token', (t) => {
  const view = mount(t)
  laidOut(view)
  const items: TranscriptItem[] = [{ id: 'a', kind: 'user', text: '你好' }]

  const asked = transcript(items)
  view.render(asked, undefined, live(asked))
  assert.equal(view.container.scrollTop, 72)

  // The answer arriving must not re-run the lift: the reader may have scrolled
  // away, and a paint that hauls them back to the anchor on every chunk is the
  // yank the tail-follow has always been careful not to be.
  // 184 of conversation, 16 of scroller inset and the 472 pad the lift wrote —
  // the scroller now has somewhere to be scrolled *from*, and the reader has
  // gone back to the top of it.
  view.stub.setMetrics(view.container, { scrollTop: 0, scrollHeight: 672 })
  const answering = transcript([...items, { id: 'b', kind: 'assistant', text: '你好呀', pending: true }])
  view.render(answering, undefined, live(answering))
  assert.equal(view.container.scrollTop, 0, 'a repaint under the same question re-scrolled')
  // The pad is still rewritten, and unchanged because nothing under the anchor
  // grew. That is the regression this pins: `scrollHeight` carries the pad, so a
  // measurement that forgot to subtract it would read this paint's own blank as
  // content and drive the pad to its floor on the second frame of a turn.
  assert.equal(pad(view), '472px')
})

test('the pad shrinks as the answer grows, so the bubble holds still while it streams', (t) => {
  const view = mount(t)
  // The same conversation 200px longer.
  laidOut(view, 384)

  const asked = transcript([{ id: 'a', kind: 'user', text: '你好' }])
  view.render(asked, undefined, live(asked))

  assert.equal(pad(view), '272px', '472 − 200: exactly what the answer took')
})

test('a transcript with no question in it carries no pad', (t) => {
  const view = mount(t)
  laidOut(view)

  const asked = transcript([{ id: 'a', kind: 'user', text: '你好' }])
  view.render(asked, undefined, live(asked))
  assert.equal(pad(view), '472px')

  // `transcript-reset` and a pane showing only startup notices land here. The
  // pad has to go with the conversation, or the reset leaves a screenful of
  // blank under a transcript that has nothing holding it up.
  view.render(transcript([{ id: 'n', kind: 'notice', text: '会话已重置' }]))
  assert.equal(pad(view), '0px')
})

test('a pane with no layout writes nothing rather than a pad measured from nothing', (t) => {
  const view = mount(t)
  // No `onLayout` and no metrics: a background pane, whose every reading is zero
  // or `NaN`. Writing from that would leave a stale pad for the paint that
  // brings the pane back.
  const asked = transcript([{ id: 'a', kind: 'user', text: '你好' }])
  view.render(asked, undefined, live(asked))

  assert.equal(pad(view), undefined)
  assert.equal(view.container.scrollTop, 0)
})

test('a question painted before the pane had layout is lifted on the paint that can', (t) => {
  const view = mount(t)
  const state = transcript([{ id: 'a', kind: 'user', text: '你好' }])

  // A pane built in the background paints its first message with nothing to
  // measure. If that paint spent the anchor, the question would be stranded
  // wherever the flow left it for the whole of its turn.
  view.render(state, undefined, live(state))
  assert.equal(pad(view), undefined)

  laidOut(view)
  view.render(state, undefined, live(state))
  assert.equal(view.container.scrollTop, 72, 'the question was never lifted')
  assert.equal(pad(view), '472px')
})

test('the pad follows the viewport, which moves without the transcript repainting', (t) => {
  // Two real ones: the canvas header is `hidden` until the lane has a name, so
  // the first paint of a restored session measures a taller scroller than it
  // ends up in; and the composer takes a line off the transcript every time the
  // draft wraps. Neither repaints this view.
  const resizes: Array<() => void> = []
  const previous = (globalThis as { ResizeObserver?: unknown }).ResizeObserver
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    constructor(run: () => void) { resizes.push(run) }
    observe(): void {}
  }
  t.after(() => { (globalThis as { ResizeObserver?: unknown }).ResizeObserver = previous })

  const view = mount(t)
  laidOut(view)
  const asked = transcript([{ id: 'a', kind: 'user', text: '你好' }])
  view.render(asked, undefined, live(asked))
  assert.equal(pad(view), '472px')

  // 36px of canvas header arrives. A pad still measured against the old height
  // leaves the scroller 36px of travel it should not have, and the next
  // tail-follow spends it by sliding the question off its gap.
  view.stub.setMetrics(view.container, { clientHeight: 564 })
  for (const resize of resizes) resize()

  assert.equal(pad(view), '436px')
  assert.equal(view.container.scrollTop, 72, 'a resize is not a new question and must not re-scroll')
})

test('the turn ending hands the pad back, so the tail is not a screenful of blank', (t) => {
  const view = mount(t)
  laidOut(view)
  const asked = transcript([{ id: 'a', kind: 'user', text: '你好' }])

  view.render(asked, undefined, live(asked))
  assert.equal(pad(view), '472px', 'while the turn runs the question owns the screen')
  assert.equal(view.column().classes.includes('settling'), false, 'a pad that moves every token must not animate')

  // `turn-end`: the pane paints once more with `isStreaming` false. The room
  // above the question was for an answer that has now arrived, and keeping it
  // is what put a screenful of nothing between the last line and the composer.
  view.render(asked)
  assert.equal(pad(view), `${ANCHOR_REST_PX}px`)
  assert.ok(view.column().classes.includes('settling'), 'the drop is a sink, and the sheet needs the class to make it one')

  // And the next turn takes it straight back, with the transition off again.
  const again = transcript([...asked.items, { id: 'b', kind: 'user', text: '再问一句' }])
  view.render(again, undefined, live(again))
  assert.equal(view.column().classes.includes('settling'), false)
  assert.notEqual(pad(view), `${ANCHOR_REST_PX}px`)
})

test('a session opened with no turn running lands on its tail, not on its last question', (t) => {
  const view = mount(t)
  laidOut(view)
  view.stub.setMetrics(view.container, { scrollHeight: 2000 })

  // `/resume`, a session switch, a pane painted for the first time: the anchor
  // is new (nothing has been painted yet) but nothing is running. Lifting here
  // would open the conversation on its last question with the whole canvas
  // empty underneath it.
  view.render(transcript([
    { id: 'a', kind: 'user', text: '你好' },
    { id: 'b', kind: 'assistant', text: '你好呀' },
  ]))

  assert.equal(view.container.scrollTop, 2000, 'a restored session opens where the reader left off')
  assert.equal(pad(view), `${ANCHOR_REST_PX}px`)
})

// --- a user message's image lines (S12) ----------------------------------------

test('the images a user message carried draw as clickable fact lines under the bubble', (t) => {
  const { render, items, stub, openedImages } = mount(t)
  const image = (id: string, name: string, width: number, height: number): ImageAttachmentRef => ({
    id, ownerSessionId: 'session-1', name, mimeType: 'image/png', width, height, byteLength: 1024,
  })
  const images = [
    image('img-1', 'shot.png', 1920, 1080),
    image('img-2', 'loop.gif', 640, 480),
  ]
  render(transcript([{ id: 'm1', kind: 'user', text: '看这两张', images }]))

  const item = items()[0]!
  const lines = item.children.filter((child) => child.classes.includes('user-image-line'))
  assert.deepEqual(lines.map((line) => line.text), [
    '图片 1：shot.png，1920×1080',
    '图片 2：loop.gif，640×480',
  ])
  assert.deepEqual(lines.map((line) => line.attributes.get('role')), ['button', 'button'])

  stub.click(lines[0]!.node)
  stub.click(lines[1]!.node)
  assert.deepEqual(openedImages, [['img-1', 'shot.png'], ['img-2', 'loop.gif']])

  // Enter works too — the row is a real control, not a mouse-only affordance.
  stub.dispatch(lines[0]!.node, 'keydown', { key: 'Enter' })
  assert.deepEqual(openedImages.length, 3)
})

test('a user item without images paints no image line, and a repaint keeps the node', (t) => {
  const { render, items } = mount(t)
  render(transcript([{ id: 'm1', kind: 'user', text: '纯文字' }]))
  assert.deepEqual(items()[0]!.children.filter((child) => child.classes.includes('user-image-line')), [])

  // Unchanged repaint: the item's node is reused, the painter's own rule — so
  // a streaming turn cannot rebuild a row the pointer is on.
  const before = items()[0]!.node
  render(transcript([{ id: 'm1', kind: 'user', text: '纯文字' }]))
  assert.equal(items()[0]!.node, before)
})
