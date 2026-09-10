import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { installDomStub, type DomStub, type StubView } from './helpers/domStub.js'
import { createTaskPanelView } from '../src/desktop/renderer/dom/taskPanelView.js'
import type { TaskPanelItem, TaskPanelState } from '../src/desktop/renderer/model/tasks.js'

/**
 * The task panel's DOM (`activity_group_design.md` §7.2).
 *
 * `model/tasks.ts` already decides everything about the checklist itself
 * (`test/rendererTasks.test.ts`), so what is left for a DOM test is exactly what
 * a pure model cannot hold: that an empty state leaves *no node* rather than a
 * blank strip, that the panel node survives a repaint (an entrance animation on
 * a rebuilt node replays once per streamed token), and that the fold the view
 * owns locally survives one too.
 *
 * Lives in `tsconfig.domtest.json` for the reason `test/rendererWelcomeView.test.ts`
 * records: the base program has no DOM lib.
 */

const RENDERER = path.join(import.meta.dirname, '..', 'src', 'desktop', 'renderer')

function item(overrides: Partial<TaskPanelItem> & { id: string }): TaskPanelItem {
  const status = overrides.status ?? 'pending'
  const subject = overrides.subject ?? overrides.id
  return { status, subject, label: subject, ...overrides }
}

function state(tasks: readonly TaskPanelItem[], overrides: Partial<TaskPanelState> = {}): TaskPanelState {
  const completed = tasks.filter((task) => task.status === 'completed').length
  const inProgress = tasks.filter((task) => task.status === 'in_progress').length
  const pending = tasks.filter((task) => task.status === 'pending').length
  const activeTask = tasks.find((task) => task.status === 'in_progress')
  return {
    tasks,
    counts: { total: tasks.length, remaining: pending + inProgress, pending, inProgress, completed },
    ...(activeTask ? { activeTask } : {}),
    ratio: tasks.length === 0 ? 0 : completed / tasks.length,
    allDone: tasks.length > 0 && completed === tasks.length,
    ...overrides,
  }
}

interface Mounted {
  readonly stub: DomStub
  readonly container: HTMLElement
  render(next: TaskPanelState | undefined): void
  flash(): void
  hide(): void
  /** The panel, or `undefined` when the host is empty. */
  panel(): StubView | undefined
  head(): StubView
  /** The custom property the fill's width resolves. */
  progress(): string | undefined
}

function mount(t: { after(fn: () => void): void }): Mounted {
  const stub = installDomStub()
  t.after(() => stub.uninstall())
  const container = stub.createContainer('task-panel-host')
  const view = createTaskPanelView(container)
  const panel = (): StubView | undefined => stub.inspect(container).children[0]
  const find = (className: string): StubView => {
    const found = panel()?.children.find((child) => child.classes.includes(className))
    assert.ok(found, `no .${className} in the panel`)
    return found
  }
  return {
    stub,
    container,
    render: (next) => view.render(next),
    flash: () => view.flash(),
    hide: () => view.hide(),
    panel,
    head: () => find('task-panel-head'),
    progress: () => {
      const node = panel()?.node as { style: { properties: Map<string, string> } } | undefined
      return node?.style.properties.get('--task-progress')
    },
  }
}

const THREE = [
  item({ id: 'a', subject: '读代码', status: 'completed' }),
  item({ id: 'b', subject: '改代码', status: 'in_progress', label: '正在改代码' }),
  item({ id: 'c', subject: '跑测试' }),
]

test('no checklist means no panel at all, not an empty strip', (t) => {
  const view = mount(t)
  view.render(undefined)
  assert.equal(view.stub.inspect(view.container).children.length, 0)
  // And it is the *absence* of a node, not a hidden one: `#task-panel:empty`
  // takes the host out of the flow, so nothing has to reserve the space.
  assert.equal(view.stub.inspect(view.container).nodes.length, 0)
})

test('the collapsed panel is the bar, the count and the running task', (t) => {
  const view = mount(t)
  view.render(state(THREE))

  const panel = view.panel()
  assert.ok(panel)
  assert.ok(panel.classes.includes('collapsed'), 'the panel opens folded')
  assert.equal(view.progress(), String(1 / 3), 'the fill resolves its width from the completed share')

  const head = view.head()
  assert.equal(head.attributes.get('aria-expanded'), 'false')
  assert.equal(head.text, '1/3正在改代码', 'the head reads the count and the active task’s activeForm')

  // The bar is there and the list is not: a folded body must be absent rather
  // than hidden, the same rule the transcript's disclosure follows.
  assert.ok(panel.children.some((child) => child.classes.includes('task-progress')))
  assert.ok(!panel.children.some((child) => child.classes.includes('task-list')))
})

test('the head folds the list open, and the rows are read-only with a bead each', (t) => {
  const view = mount(t)
  view.render(state(THREE))
  view.stub.click(view.head().node)

  const panel = view.panel()
  assert.ok(panel && !panel.classes.includes('collapsed'))
  assert.equal(view.head().attributes.get('aria-expanded'), 'true')

  const list = panel.children.find((child) => child.classes.includes('task-list'))
  assert.ok(list, 'the open panel draws the whole checklist')
  assert.equal(list.children.length, 3)
  assert.deepEqual(
    list.children.map((row) => row.classes.filter((name) => name !== 'task-row')),
    [['completed'], ['in_progress'], ['pending']],
  )
  for (const row of list.children) {
    assert.equal(row.tagName, 'DIV', 'a row is not a control; the model owns the list')
    const bead = row.children[0]
    assert.ok(bead?.classes.includes('task-bead'))
    assert.equal(bead.attributes.get('aria-hidden'), 'true', 'the bead is a picture; the words are the label')
  }
  assert.equal(list.children[1]?.text, '正在改代码')

  view.stub.click(view.head().node)
  assert.ok(view.panel()?.classes.includes('collapsed'), 'the head folds it back')
})

test('task detail exit keeps rows until settlement and a rapid reopen reverses it', (t) => {
  const view = mount(t)
  view.render(state(THREE))
  view.stub.click(view.head().node)
  const list = view.panel()!.children.find((node) => node.classes.includes('task-list'))!.node
  view.stub.click(view.head().node)
  assert.equal(view.stub.inspect(list).classes.includes('presence-closing'), true)
  assert.equal(view.stub.inspect(list).attributes.has('inert'), true)
  view.stub.click(view.head().node)
  assert.equal(view.panel()!.children.find((node) => node.classes.includes('task-list'))!.node, list)
  view.stub.click(view.head().node)
  view.stub.dispatch(list, 'transitionend', { propertyName: 'height' })
  assert.equal(view.panel()!.children.some((node) => node.classes.includes('task-list')), false)
})

test('a repaint reuses the panel node and keeps the fold the user chose', (t) => {
  const view = mount(t)
  view.render(state(THREE))
  const before = view.panel()?.node
  view.stub.click(view.head().node)

  // The stream's shape: a record arrives, the pane repaints, and neither the
  // entrance animation nor the user's disclosure may be thrown away by it.
  view.render(state([...THREE.slice(0, 2), item({ id: 'c', subject: '跑测试', status: 'completed' })]))
  assert.equal(view.panel()?.node, before, 'a rebuilt panel would replay `rise-in` on every token')
  assert.equal(view.head().attributes.get('aria-expanded'), 'true', 'the fold is the view’s own state')
  assert.equal(view.progress(), String(2 / 3))
})

test('M07 keeps task progress, header, rows and beads through unchanged stream paints', (t) => {
  const view = mount(t)
  view.render(state(THREE))
  view.stub.click(view.head().node)
  const before = view.panel()!
  const rows = before.children.find((node) => node.classes.includes('task-list'))!.children
  for (let index = 0; index < 10; index += 1) view.render(state(THREE))
  const after = view.panel()!
  assert.equal(after.children[0]!.node, before.children[0]!.node)
  assert.equal(after.children[0]!.children[0]!.node, before.children[0]!.children[0]!.node)
  assert.equal(view.head().node, before.children[1]!.node)
  const nextRows = after.children.find((node) => node.classes.includes('task-list'))!.children
  for (const [index, row] of rows.entries()) {
    assert.equal(nextRows[index]!.node, row.node)
    assert.equal(nextRows[index]!.children[0]!.node, row.children[0]!.node)
  }
  view.render(state(THREE.map((task) => item({ ...task, status: 'completed' }))))
  view.stub.click(view.head().node)
  assert.equal(view.head().text, '3/3全部完成', 'the kept click handler reads the current state')
})

test('task flash settles only its own animation and never carries into a new panel', (t) => {
  const view = mount(t)
  view.render(state(THREE))
  view.flash()
  view.stub.dispatch(view.panel()!.node, 'animationend', { animationName: 'rise-in' })
  view.stub.dispatch(view.panel()!.node, 'animationend', { animationName: 'task-flash', target: view.head().node })
  assert.ok(view.panel()!.classes.includes('flash'))
  view.stub.dispatch(view.panel()!.node, 'animationend', { animationName: 'task-flash' })
  assert.equal(view.panel()!.classes.includes('flash'), false)
  view.flash()
  const before = view.panel()!.node
  view.hide()
  view.render(state(THREE))
  assert.notEqual(view.panel()!.node, before)
  assert.equal(view.panel()!.classes.includes('flash'), false)
})

test('a finished checklist says so, and losing the checklist takes the panel with it', (t) => {
  const view = mount(t)
  const done = THREE.map((task) => item({ ...task, status: 'completed' }))
  view.render(state(done))
  assert.equal(view.head().text, '3/3全部完成')
  assert.equal(view.progress(), '1')

  // `model/tasks.ts` retires the list on the next user message; the view's part
  // is that it leaves nothing behind when it does.
  view.render(undefined)
  assert.equal(view.stub.inspect(view.container).children.length, 0)
})

test('flash marks the panel once and needs a live panel to mark', (t) => {
  const view = mount(t)
  // The transcript's `TodoWrite` step points here rather than drawing the list a
  // second time (§7.3), and it may point at a session that has no panel.
  view.flash()
  assert.equal(view.panel(), undefined)

  view.render(state(THREE))
  view.flash()
  assert.ok(view.panel()?.classes.includes('flash'))
  view.flash()
  assert.deepEqual(
    view.panel()?.classes.filter((name) => name === 'flash'),
    ['flash'],
    'a second pulse must not stack a second class',
  )
})

test('the page mounts the panel in the composer column, above the composer', (t) => {
  void t
  // The host is the decision §7.2 turns on: in the flow next to `#composer`, not
  // inside `#composer-popovers`, whose shell is absolute and `pointer-events:
  // none`. A DOM test cannot see a layout, so the placement is asserted at
  // source level — the same device `rendererStyleTokens.test.ts` uses.
  const html = readFileSync(path.join(RENDERER, 'index.html'), 'utf8')
  const column = html.slice(html.indexOf('class="composer-column"'))
  const host = column.indexOf('id="task-panel"')
  const popovers = column.indexOf('id="composer-popovers"')
  const composer = column.indexOf('id="composer"')
  assert.ok(host > popovers, '#task-panel must not be one of the transient popovers')
  assert.ok(host < composer && host > 0, '#task-panel belongs above #composer, inside the composer column')
})
