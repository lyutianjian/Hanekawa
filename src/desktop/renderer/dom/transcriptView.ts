import { parseUnifiedPatch, type PatchRows } from '../model/diffRows.js'
import {
  groupHeaderLabel,
  isGroupExpanded,
  isLooseThinkingExpanded,
  isStepCollapsible,
  isStepExpanded,
  thinkingHeaderLabel,
  type DisclosureState,
} from '../model/thinking.js'
import {
  formatWorkedDuration,
  groupTranscript,
  toolStatusLabel,
  type ActivityGroup,
  type ActivityStep,
  type TranscriptEntry,
  type TranscriptItem,
  type TranscriptState,
} from '../model/transcript.js'
import { splitFileMentions } from '../model/userMessage.js'
import { button } from './controls.js'
import { diffNode } from './diffView.js'
import { append, el, replace, show, type Child } from './dom.js'
import { icon } from './icons.js'
import { markdownChildren } from './markdownView.js'

/**
 * Paints the transcript: loose items interleaved with activity groups (§2).
 *
 * There is no in-flight tool line any more. It was a singleton strip under the
 * scroller that named whatever tool was running, which since T4 is something the
 * running step's own head says — with its bead, its arguments and its elapsed
 * time — one line above where the strip used to sit. Two places saying the same
 * thing is one place too many, and the strip was the one that could not say
 * *which* of a batch's calls it meant.
 *
 * ## Two layers of disclosure
 *
 * A group is a whole turn: its head carries the boundary and the total, and each
 * step inside opens on its own. Every head is a `<button>` with `aria-expanded`,
 * and a folded body is **absent rather than `hidden`**: the transcript is
 * `aria-live="polite"`, so a hidden-but-present streaming block is text a screen
 * reader announces that nobody asked for (§8).
 *
 * ## Nodes are reused by id
 *
 * The file used to rebuild the whole subtree on every paint, and its header said
 * the fix — keying by id — could wait for a profile. §8 brought that day forward
 * for a correctness reason instead: steps now collapse *by themselves* when the
 * turn ends, which shortens the content above the reader. The browser's
 * `overflow-anchor` absorbs exactly that, but only while the anchor node survives
 * the paint; a `replace()` of the whole column destroys it and the reader is
 * thrown to a different place in the conversation.
 *
 * So each entry and each step keeps its element across paints, keyed by id. An
 * unchanged item is left untouched (its markdown is not even re-parsed); a changed
 * one is refilled *in place*, so the node the anchor points at is still there.
 * `replaceChildren` on the column then re-orders the same nodes rather than
 * building new ones.
 *
 * The jump-to-bottom button is built here rather than in `paneSession.ts` because
 * every piece of scroll knowledge in the renderer already lives in this file, and
 * `paneSession.ts` has no unit tests. It is appended to a host *outside* the
 * scroller: an absolutely positioned child of a scroll container would anchor to
 * the bottom of the content rather than to the viewport.
 */
export interface TranscriptView {
  /** `disclosure` is the pane's absolute answer for every group and step (§5.2). */
  render(state: TranscriptState, disclosure: DisclosureState): void
}

export interface TranscriptHandlers {
  /** `expanded` is what the row shows now, so the first click always inverts it. */
  onToggle(id: string, expanded: boolean): void
  /**
   * A `TodoWrite` row was clicked. It has no body — the checklist is drawn once,
   * above the composer — so the row's whole job is to point at it (§7.3).
   */
  onTaskStep(): void
}

export function createTranscriptView(
  container: HTMLElement,
  floatHost: HTMLElement,
  handlers: TranscriptHandlers,
): TranscriptView {
  const jump = button(
    'scroll-bottom',
    '',
    '回到最新',
    () => container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' }),
    { icon: 'arrow-down' },
  )
  jump.hidden = true
  floatHost.appendChild(jump)

  // One column inside the scroller, not a `max-width` on the scroller itself: the
  // reading column is ~760px (design_guidance 四.2) while the scrollbar has to stay
  // at the panel's edge, and the user bubble's right alignment is `margin-left:
  // auto` — which only means "right of the column" if the column is a real box.
  //
  // Built once and kept: it is the scroller's only child, and rebuilding it would
  // undo the node reuse below at the very first level.
  const column = el('div', 'transcript-column')
  container.appendChild(column)

  const cache = new Map<string, CachedNode>()

  function syncJump(): void {
    show(jump, !isScrolledToBottom(container))
  }

  // Both halves are needed, and they share the one predicate so they cannot
  // disagree at its 24px boundary. `scroll` is the obvious trigger; the paint
  // below is the other one, because the *content* can move the verdict with no
  // scroll event at all — a `turn-end` dropping a draft or a `transcript-reset`
  // shortens the scroller under a reader who is then already at the tail.
  container.addEventListener('scroll', syncJump)

  return {
    render(state, disclosure) {
      const atBottom = isScrolledToBottom(container)
      const painter = createPainter(cache, disclosure, handlers)
      const nodes = groupTranscript(state.items).map((entry) => entryNode(painter, entry))
      painter.prune()
      column.replaceChildren(...nodes)

      // Follow the tail only if the user was already there, so reading back
      // through a long turn is not yanked away on every token.
      if (atBottom) container.scrollTop = container.scrollHeight
      syncJump()
    },
  }
}

// --- node reuse --------------------------------------------------------------

interface CachedNode {
  readonly node: HTMLElement
  /** What the node was last painted from; compared by identity, member by member. */
  signature: readonly unknown[]
}

interface Painter extends TranscriptHandlers {
  readonly disclosure: DisclosureState
  /**
   * The node for `key`, refilled only when `signature` changed.
   *
   * Every member of a signature is compared with `===`, which is why it is made of
   * the model's own values: an unchanged item hands back the same `text` *string
   * reference*, so an untouched entry costs one identity check rather than a
   * re-parse of its markdown.
   */
  node(key: string, className: string, signature: readonly unknown[], fill: () => Child[]): HTMLElement
  prune(): void
}

function createPainter(
  cache: Map<string, CachedNode>,
  disclosure: DisclosureState,
  handlers: TranscriptHandlers,
): Painter {
  const live = new Set<string>()
  return {
    disclosure,
    onToggle: handlers.onToggle,
    onTaskStep: handlers.onTaskStep,
    node(key, className, signature, fill) {
      live.add(key)
      const cached = cache.get(key)
      if (cached && cached.node.className === className && sameSignature(cached.signature, signature)) {
        return cached.node
      }
      // Reused even when the content changed: it is the node the scroll anchor
      // points at, so it is refilled rather than replaced.
      const node = cached?.node ?? el('div', className)
      node.className = className
      replace(node)
      append(node, fill())
      cache.set(key, { node, signature })
      return node
    },
    prune() {
      for (const key of [...cache.keys()]) {
        if (!live.has(key)) cache.delete(key)
      }
    },
  }
}

function sameSignature(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

// --- entries -----------------------------------------------------------------

function entryNode(painter: Painter, entry: TranscriptEntry): HTMLElement {
  return entry.kind === 'group' ? groupNode(painter, entry.group) : itemNode(painter, entry.item)
}

/**
 * A turn as one group: a head that summarises it, and its steps.
 *
 * The head is rebuilt on every paint even when the group is unchanged — it holds
 * a click handler bound to the disclosure state it was painted under, and there is
 * no `removeEventListener` bookkeeping worth the alternative. Reuse lives one
 * level down instead, on the steps, which is where the scroll anchor and the cost
 * both are.
 */
function groupNode(painter: Painter, group: ActivityGroup): HTMLElement {
  const expanded = isGroupExpanded(group, painter.disclosure)
  const classes = ['activity-group', group.status]
  if (!expanded) classes.push('collapsed')
  return painter.node(`group:${group.turnId}`, classes.join(' '), rebuild(), () => [
    groupHead(painter, group, expanded),
    expanded
      ? el('div', 'group-steps', ...group.steps.map((step, index) => stepNode(painter, group, step, index)))
      : undefined,
  ])
}

function groupHead(painter: Painter, group: ActivityGroup, expanded: boolean): HTMLElement {
  const label = groupHeaderLabel(group)
  const head = button('group-head', label, label, () => painter.onToggle(group.turnId, expanded))
  head.setAttribute('aria-expanded', expanded ? 'true' : 'false')
  // 「12 步里有一个红的」 without opening anything (§3). Decoration only: the count
  // and the failures are already in the label the button is named by.
  if (!expanded) {
    const beads = group.steps.filter(hasBead)
    if (beads.length > 0) {
      const strip = el('span', 'group-beads', ...beads.map((step) => bead(step, 'group-bead')))
      strip.setAttribute('aria-hidden', 'true')
      head.appendChild(strip)
    }
  }
  return head
}

/**
 * A signature that can never match the last one, i.e. 「refill me every paint」.
 *
 * The group's own children are one head plus the step nodes, and the head holds a
 * handler bound to the disclosure it was painted under. Rebuilding it is cheap and
 * keeps the reuse where it matters — the step nodes it re-inserts are the cached
 * ones, so the scroll anchor still survives.
 */
function rebuild(): readonly unknown[] {
  return [{}]
}

function stepPending(step: ActivityStep): boolean {
  return 'pending' in step && step.pending === true
}

function hasBead(step: ActivityStep): boolean {
  return step.kind === 'tool' || step.kind === 'task' || step.kind === 'subagent'
}

/**
 * The bead — the tool's only *visual* status vocabulary (§3), which is exactly
 * why it is `aria-hidden`: the state also reaches the accessible name of the head
 * in words, because colour may not be the only carrier.
 */
function bead(step: ActivityStep, className: string): HTMLElement {
  const status = 'status' in step ? step.status : stepPending(step) ? 'running' : 'done'
  const node = el('span', `${className} ${status}`)
  node.setAttribute('aria-hidden', 'true')
  return node
}

// --- steps -------------------------------------------------------------------

function stepNode(painter: Painter, group: ActivityGroup, step: ActivityStep, index: number): HTMLElement {
  const expanded = isStepExpanded(group, index, painter.disclosure)
  switch (step.kind) {
    case 'thinking':
      return thinkingStep(painter, step, expanded)
    case 'tool':
    case 'subagent':
      return toolStep(painter, step, expanded)
    case 'task':
      return taskStep(painter, step)
    case 'text':
      // Staged prose: full markdown, shown whole, never folded (§4.4).
      return painter.node(`step:${step.id}`, 'step text md', [step.text], () => markdownChildren(step.text))
    case 'system':
      return painter.node(
        `step:${step.id}`,
        step.failed === true ? 'step system failed' : 'step system',
        [step.text],
        () => [el('span', 'step-label', step.text), rule()],
      )
  }
}

/**
 * A `TodoWrite` row: one line, no body, ever (§4.4). The checklist it wrote is
 * drawn once — above the composer, where it stays useful after the group folds —
 * so clicking the row flashes *that* panel rather than repeating the list here.
 *
 * A `<button>` with no `aria-expanded`, because nothing here opens: the row is a
 * pointer, not a disclosure.
 */
function taskStep(painter: Painter, step: Extract<ActivityStep, { kind: 'task' }>): HTMLElement {
  return painter.node(`step:${step.id}`, `step task ${step.status}`, [step.text, step.status], () => {
    const label = `${step.text} · ${toolStatusLabel(step.status)}`
    const head = button('step-head', '', label, () => painter.onTaskStep())
    append(head, [bead(step, 'step-bead'), el('span', 'step-label', step.text)])
    return [head]
  })
}

/**
 * A thinking step: no bead — it is not an execution and has no outcome — and a
 * hairline to its right instead (§3).
 */
function thinkingStep(painter: Painter, step: Extract<ActivityStep, { kind: 'thinking' }>, expanded: boolean): HTMLElement {
  const classes = ['step', 'thinking']
  if (step.pending === true) classes.push('live')
  if (!expanded) classes.push('collapsed')
  // Fields rather than the step object: `toStep` mints a new one on every paint,
  // so an object identity would mean 「always different」 and no reuse at all. The
  // strings it carries *are* the item's own, so `===` still settles in one compare.
  return painter.node(`step:${step.id}`, classes.join(' '), [step.text, step.summary, expanded], () => {
    const label = thinkingHeaderLabel(step)
    const head = button('step-head thinking-step-head', label, label, () =>
      painter.onToggle(step.id, expanded))
    head.setAttribute('aria-expanded', expanded ? 'true' : 'false')
    head.appendChild(rule())
    return [head, expanded ? el('div', 'step-body', step.text) : undefined]
  })
}

type ToolLike = Extract<ActivityStep, { kind: 'tool' | 'subagent' }>

/**
 * The edit family (§6.2): tools whose result ships a unified patch in
 * `display.detail`. The family is the design's own assignment — a `Bash` output
 * that happens to parse as a diff stays a terminal block, not a diff — and a
 * member whose `detail` does not parse (an old record, a foreign tool with the
 * same name) simply falls back to the plain body.
 */
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])

/**
 * The family's own body data, or `undefined` when this step is not one of its
 * patches. Parsed once per fill — the painter's signature already holds the tool
 * detail, so a repaint that changes nothing costs nothing.
 */
function editPatch(step: ToolLike): PatchRows | undefined {
  if (step.kind !== 'tool' || step.toolName === undefined || !EDIT_TOOLS.has(step.toolName)) return undefined
  return step.tool.detail === undefined ? undefined : parseUnifiedPatch(step.tool.detail)
}

/** `+12 −3` — the patch's own two counts, the head's suffix (§6.2). */
function patchStats(patch: PatchRows): string {
  return `+${patch.added} −${patch.deleted}`
}

function toolStep(painter: Painter, step: ToolLike, expanded: boolean): HTMLElement {
  const status = step.kind === 'tool' ? step.status : step.pending === true ? 'running' : 'done'
  const classes = ['step', step.kind, status]
  if (!expanded) classes.push('collapsed')
  // `step.tool` is the item's own detail object, so it changes reference exactly
  // when the result merges in — see `thinkingStep` for why not the step itself.
  const detail = step.kind === 'tool' ? step.tool : undefined
  return painter.node(`step:${step.id}`, classes.join(' '), [step.text, detail, status, expanded], () => {
    const patch = editPatch(step)
    // A capped patch's counts are partial — `+0 −17` on a whole-file rewrite
    // whose adds were cut — so the suffix stays off rather than lying.
    const stats = patch !== undefined && !patch.capped ? patchStats(patch) : undefined
    const head = button('step-head', '', stepAccessibleName(step, status, stats), () =>
      painter.onToggle(step.id, expanded))
    head.setAttribute('aria-expanded', expanded ? 'true' : 'false')
    append(head, [bead(step, 'step-bead'), ...headParts(step, stats)])
    return [head, expanded ? stepBody(step, patch) : undefined]
  })
}

/**
 * `Read` + `src/a.ts` + the result's own suffix + the call's elapsed time — the
 * head reads left to right as 「什么工具、对什么、结果如何、花了多久」 (§4.5).
 * The edit family inserts its patch counts where a suffix would sit, because for
 * those tools the counts *are* the result's note.
 */
function headParts(step: ToolLike, stats: string | undefined): Child[] {
  if (step.kind === 'subagent') return [el('span', 'step-name', step.text)]
  const { displayName, useSummary, headerSuffix, durationMs } = step.tool
  return [
    el('span', 'step-name', displayName),
    useSummary ? el('span', 'step-summary', useSummary) : undefined,
    stats === undefined ? undefined : el('span', 'step-suffix', stats),
    headerSuffix === undefined ? undefined : el('span', 'step-suffix', headerSuffix),
    durationMs === undefined ? undefined : el('span', 'step-duration', formatWorkedDuration(durationMs)),
  ]
}

/** The state in words, because the bead is `aria-hidden` and colour is not a name. */
function stepAccessibleName(step: ToolLike, status: string, stats: string | undefined): string {
  const label = toolStatusLabel(status as Parameters<typeof toolStatusLabel>[0])
  if (step.kind === 'subagent') return `${step.text} · ${label}`
  const { displayName, useSummary, headerSuffix } = step.tool
  return [displayName, useSummary, stats, headerSuffix, label]
    .filter((part) => part && part.length > 0)
    .join(' · ')
}

/**
 * A step's expanded body, by family (§6.2).
 *
 * The edit family is a real diff: the unified patch the tools ship in
 * `display.detail` (T12), parsed back into the same rows the permission dialog
 * paints — line gutters included. Its result summary is not repeated above the
 * rows; the head already says what file and how much.
 *
 * Everything else is still the fallback family (§6.2 兜底): the result's own
 * summary over `detail ?? content` — which is also what an edit step without a
 * parseable patch gets, an old record's `Edited x` among them (§10), without
 * erroring. The terminal block and the grouped search list are T14–T15.
 *
 * Nothing to show yields no body at all rather than an empty box: a call with no
 * result yet is the common case, and an empty disclosure is noise.
 */
function stepBody(step: ToolLike, patch: PatchRows | undefined): HTMLElement | undefined {
  if (step.kind === 'subagent') return el('div', 'step-body', step.text)
  if (patch !== undefined) return el('div', 'step-body', diffNode(patch.rows))
  const { resultSummary, detail, content } = step.tool
  const text = detail ?? content
  if (resultSummary === undefined && (text === undefined || text.length === 0)) return undefined
  return el(
    'div',
    'step-body',
    resultSummary === undefined ? undefined : el('div', 'step-body-head', resultSummary),
    // Clipping is the stylesheet's (T8): `max-height` plus scrolling *inside* the
    // block, so a long output never turns the group itself into a scroll window.
    text === undefined || text.length === 0 ? undefined : el('pre', 'step-body-text', text),
  )
}

/** The hairline that stands in for a bead on a row that has no outcome (§3). */
function rule(): HTMLElement {
  const node = el('span', 'step-rule')
  node.setAttribute('aria-hidden', 'true')
  return node
}

// --- loose items -------------------------------------------------------------

function itemNode(painter: Painter, item: TranscriptItem): HTMLElement {
  const classes = ['item', item.kind]
  if (item.pending) classes.push('pending')
  if (item.failed) classes.push('failed')
  const key = `item:${item.id}`
  // Only the assistant writes markdown. A tool line, a user message and a notice
  // are commands, paths and diagnostics — they have to read back character for
  // character, so `*` stays a `*` there.
  //
  // The draft is rendered the same way while it streams: a half-written fence is
  // just a code block whose end has not arrived, and the parse cache means the
  // cost is one parse of the draft rather than one of every settled message.
  if (item.kind === 'assistant') {
    return painter.node(key, `${classes.join(' ')} md`, [item.text], () => markdownChildren(item.text))
  }
  if (item.kind === 'thinking') return looseThinkingNode(painter, item, classes, key)
  if (item.kind === 'user') return painter.node(key, classes.join(' '), [item.text], () => userParts(item))
  return painter.node(key, classes.join(' '), [item.text], () => [item.text])
}

/**
 * The user's bubble, with every `@` mention drawn as a pill in place.
 *
 * Still character-for-character: the pill's label is the mention's own substring and
 * nothing around it is touched, which is what `splitFileMentions` guarantees. A
 * `<span>`, not a `<button>`: clicking it does nothing, and a control that does
 * nothing is a worse lie than plain text (the same call 5c made for the context
 * pills).
 */
function userParts(item: TranscriptItem): Child[] {
  return splitFileMentions(item.text).map((segment) =>
    segment.kind === 'text'
      ? segment.text
      : el('span', 'file-chip', icon('file'), el('span', 'file-chip-label', segment.label)),
  )
}

/**
 * A thinking block from a record with no `turnId` — it joins no group, so it keeps
 * the standalone disclosure it has always had.
 */
function looseThinkingNode(
  painter: Painter,
  item: TranscriptItem,
  classes: string[],
  key: string,
): HTMLElement {
  const expanded = isLooseThinkingExpanded(item, painter.disclosure)
  if (!expanded) classes.push('collapsed')
  // Driven by the item, never by `TranscriptState.isThinking`: that flag goes false
  // on `thinking_stop` while the block is still arriving.
  if (item.pending === true) classes.push('live')
  return painter.node(key, classes.join(' '), [item, expanded], () => {
    const label = thinkingHeaderLabel(item)
    // 「已处理 Xm Xs `⌵`」 (design_guidance 四.3): the glyph follows the label and
    // still flips to point up while the block is open — that rule matches on the
    // class, not on the position.
    const header = button('thinking-header', label, label, () => painter.onToggle(item.id, expanded), {
      trailingIcon: 'chevron-down',
    })
    header.setAttribute('aria-expanded', expanded ? 'true' : 'false')
    return [header, expanded ? el('div', 'thinking-body', item.text) : undefined]
  })
}

function isScrolledToBottom(container: HTMLElement): boolean {
  // A few pixels of slack: fractional scroll heights never land exactly.
  return container.scrollHeight - container.scrollTop - container.clientHeight < 24
}
