import assert from 'node:assert/strict'
import test from 'node:test'

import { installDomStub, type DomStub, type StubView } from './helpers/domStub.js'
import { cssBlocks, type Block } from './helpers/rendererCss.js'
import { createSettingsView } from '../src/desktop/renderer/dom/settingsView.js'
import {
  applySettingsIntent,
  createSettingsState,
  settingsView,
  type SettingsIntent,
  type SettingsState,
  type SettingsViewModel,
} from '../src/desktop/renderer/model/settings.js'
import type { WireSettingsSnapshot } from '../src/desktop/shellProtocol.js'

/**
 * The settings screen's *nodes* — the half `rendererSettingsModel.test.ts` calls
 * deliberately uncovered.
 *
 * Three things here cannot be model-tested, which is why this file exists at all:
 * the search box has to survive the nav column's `replace()` with its caret, the
 * pill dropdown's open key is derived in the DOM rather than in the view model,
 * and `focusout` has to tell "the user left" from "this view repainted".
 *
 * Not in the base TypeScript program (its `lib` has no DOM): excluded there,
 * checked by `tsconfig.domtest.json`, and `test/rendererImports.test.ts` asserts
 * the two lists agree.
 */

function snapshotOf(): WireSettingsSnapshot {
  return {
    projectRoot: 'C:\\repo\\alpha',
    projectName: 'alpha',
    saveTarget: 'C:\\repo\\alpha\\.myagent\\config.json',
    endpoints: [],
    models: [{ key: 'big', model: 'claude-big', endpoint: 'main', resolves: true }],
    routing: { main: 'big', plan: 'inherit', compact: 'inherit', subagent: [] },
    defaultModel: 'big',
    providers: ['anthropic'],
    subagentTypes: [],
    permissions: {
      localPath: 'C:\\repo\\alpha\\.myagent\\settings.local.json',
      mode: 'default',
      modeIsLocal: false,
      groups: [
        { behavior: 'allow', local: [], inherited: [] },
        { behavior: 'ask', local: [], inherited: [] },
        { behavior: 'deny', local: [], inherited: [] },
      ],
    },
    agents: [],
    mcpServers: [],
    contextManagement: {
      contextWindow: 200_000,
      summaryOutputTokens: 20_000,
      autoCompactBufferTokens: 13_000,
      manualCompactBufferTokens: 3_000,
      microCompactThresholdRatio: 0.9,
      autoCompactThresholdRatio: 0.93,
    },
    general: { localPath: 'C:\\repo\\alpha\\.myagent\\settings.local.json' },
  }
}

function stateOf(overrides: Partial<SettingsState> = {}): SettingsState {
  return {
    ...createSettingsState(),
    open: true,
    projectRoot: 'C:\\repo\\alpha',
    snapshot: snapshotOf(),
    projects: [
      { projectRoot: 'C:\\repo\\alpha', projectName: 'alpha' },
      { projectRoot: 'C:\\repo\\beta', projectName: 'beta' },
    ],
    ...overrides,
  }
}

interface Rendered {
  readonly stub: DomStub
  readonly container: HTMLElement
  readonly intents: SettingsIntent[]
  readonly keys: string[]
  view(): StubView
  render(state: SettingsState): void
  /** Feeds the intent back through the reducer, as `app.ts` does. */
  apply(intent: SettingsIntent): void
}

function mount(t: { after(fn: () => void): void }, initial = stateOf()): Rendered {
  const stub = installDomStub()
  t.after(() => stub.uninstall())
  const container = stub.createContainer('settings')
  const intents: SettingsIntent[] = []
  const keys: string[] = []
  let state = initial
  const dom = createSettingsView(
    container,
    (intent) => intents.push(intent),
    (chord) => {
      keys.push(chord.key)
      return true
    },
  )
  const render = (next: SettingsState): void => {
    state = next
    dom.render(settingsView(next))
  }
  render(initial)
  return {
    stub,
    container,
    intents,
    keys,
    view: () => stub.inspect(container),
    render,
    apply: (intent) => render(applySettingsIntent(state, intent).state),
  }
}

const child = (view: StubView, className: string): StubView => {
  const found = view.children.find((node) => node.classes.includes(className))
  assert.ok(found, `no .${className} in ${view.children.map((c) => c.className).join(' | ')}`)
  return found
}

/** Every node with a class, anywhere in the subtree. */
function findAll(view: StubView, className: string): StubView[] {
  const found: StubView[] = []
  const walk = (node: StubView): void => {
    if (node.classes.includes(className)) found.push(node)
    for (const kid of node.children) walk(kid)
  }
  walk(view)
  return found
}

function findOne(view: StubView, className: string): StubView {
  const all = findAll(view, className)
  assert.equal(all.length, 1, `expected exactly one .${className}, found ${all.length}`)
  return all[0]!
}

// --- the nav column ----------------------------------------------------------

test('the nav draws one section per group, labelled, in order', (t) => {
  const nav = child(mount(t).view(), 'settings-nav')
  const groups = findAll(nav, 'settings-nav-group')

  assert.equal(groups.length, 3)
  assert.deepEqual(
    groups.map((group) => child(group, 'settings-nav-group-label').text),
    ['个人', '集成', '编码'],
  )
  assert.deepEqual(
    groups.map((group) => findAll(group, 'settings-nav-item').map((item) => item.text)),
    [['通用', '外观'], ['模型与服务商'], ['权限', 'Agent']],
  )
})

test('the close button stays at the bottom of the column, outside the replaced region', (t) => {
  const { view, render } = mount(t)
  const before = child(view(), 'settings-nav')
  const closeBefore = findOne(before, 'settings-nav-close').node
  // The list is what gets rebuilt; the search box and the close button are not.
  render(stateOf({ category: 'agent' }))
  const after = child(view(), 'settings-nav')
  assert.equal(findOne(after, 'settings-nav-close').node, closeBefore)
  assert.equal(after.children.at(-1)?.node, closeBefore)
})

// --- the search box ----------------------------------------------------------

test('the search input is built once, so typing cannot lose the caret', (t) => {
  const { view, render } = mount(t)
  const before = findOne(child(view(), 'settings-nav'), 'settings-search').node
  render(stateOf({ query: 'MCP' }))
  const after = findOne(child(view(), 'settings-nav'), 'settings-search').node

  // Identity, not equality: the nav list around it is replaced on every render.
  assert.equal(after, before)
})

test('typing filters per keystroke, not on blur', (t) => {
  const { view, stub, intents } = mount(t)
  const search = findOne(child(view(), 'settings-nav'), 'settings-search')
  assert.equal(search.tagName, 'INPUT')
  assert.equal(search.attributes.get('aria-label'), '搜索设置')

  const node = search.node as { value: string }
  node.value = 'MC'
  stub.dispatch(search.node, 'input')
  assert.deepEqual(intents, [{ kind: 'search', query: 'MC' }])
})

test('the search box keeps its own editing keys, but not Escape', (t) => {
  const { view, stub, container, keys } = mount(t)
  const search = findOne(child(view(), 'settings-nav'), 'settings-search')

  for (const key of ['Backspace', 'ArrowLeft', 'a']) {
    stub.dispatch(container, 'keydown', { target: search.node, key })
  }
  assert.deepEqual(keys, [], 'the input owns text editing')

  // Escape must still reach the model, or 关闭设置（Esc） becomes a lie the moment
  // focus enters the box.
  stub.dispatch(container, 'keydown', { target: search.node, key: 'Escape' })
  assert.deepEqual(keys, ['Escape'])
})

test('the box is emptied when the model clears the query, and never otherwise', (t) => {
  const { view, render } = mount(t)
  const search = findOne(child(view(), 'settings-nav'), 'settings-search')
  const node = search.node as { value: string }

  node.value = 'MCP'
  render(stateOf({ query: 'MCP' }))
  assert.equal(node.value, 'MCP', 'a render must not fight the typist')

  render(stateOf({ query: '' }))
  assert.equal(node.value, '', 'Escape-cleared means the box is cleared too')
})

test('an unmatched page says so in the body', (t) => {
  const { view, render } = mount(t)
  render(stateOf({ category: 'general', query: 'zzz-nothing' }))
  const body = child(view(), 'settings-body')

  assert.equal(findAll(body, 'settings-card').length, 0)
  assert.match(findOne(body, 'settings-empty').text, /zzz-nothing/)
})

// --- the pill dropdown -------------------------------------------------------

/** The routing card's main-role row: a `select` control on the provider page. */
function mainRoutingPill(view: StubView): StubView {
  const shells = findAll(child(view, 'settings-body'), 'settings-menu-shell')
  assert.ok(shells.length > 0, 'the provider page has row-level选择器')
  return shells[0]!
}

test('a row-level select is a closed pill, not a native control', (t) => {
  const shell = mainRoutingPill(mount(t).view())
  const trigger = child(shell, 'settings-pill')

  assert.equal(trigger.tagName, 'BUTTON')
  assert.equal(trigger.attributes.get('aria-haspopup'), 'listbox')
  assert.equal(trigger.attributes.get('aria-expanded'), 'false')
  assert.equal(findAll(shell, 'settings-menu').length, 0, 'closed means the menu is absent')
  // The label is the selected choice's text, not its raw value.
  assert.match(trigger.text, /big/)
})

test('the header project picker and the form fields stay native selects', (t) => {
  // The deliberate scope limit of stage 5f: a native `<select>` is keyboard- and
  // screen-reader-complete for free, and a form is a keyboard flow.
  const { view, apply } = mount(t)
  const header = child(child(view(), 'settings-body'), 'settings-header')
  assert.equal(findOne(header, 'settings-project').tagName, 'SELECT')

  apply({ kind: 'new-model' })
  const form = findOne(child(view(), 'settings-body'), 'settings-form')
  const selects = findAll(form, 'settings-select')
  assert.ok(selects.length > 0, 'the model form has choice fields')
  assert.deepEqual(new Set(selects.map((node) => node.tagName)), new Set(['SELECT']))
  assert.equal(findAll(form, 'settings-pill').length, 0)
})

test('clicking the trigger asks to toggle that row, keyed by its row id', (t) => {
  const { view, stub, intents } = mount(t)
  const trigger = child(mainRoutingPill(view()), 'settings-pill')
  stub.click(trigger.node)

  assert.deepEqual(intents, [{ kind: 'toggle-menu', menu: 'row:routing:main' }])
})

test('an open dropdown is a listbox of options, with the current one marked', (t) => {
  const { view, apply } = mount(t)
  apply({ kind: 'toggle-menu', menu: 'row:routing:main' })
  const shell = mainRoutingPill(view())

  assert.equal(child(shell, 'settings-pill').attributes.get('aria-expanded'), 'true')
  const menu = child(shell, 'settings-menu')
  assert.equal(menu.attributes.get('role'), 'listbox')
  const items = findAll(menu, 'settings-menu-item')
  assert.ok(items.length >= 2, 'inherit plus every model key')
  assert.deepEqual(new Set(items.map((item) => item.attributes.get('role'))), new Set(['option']))
  const selected = items.filter((item) => item.attributes.get('aria-selected') === 'true')
  assert.equal(selected.length, 1)
  assert.match(selected[0]!.text, /big/)
})

test('only one dropdown is open at a time', (t) => {
  const { view, apply } = mount(t)
  apply({ kind: 'toggle-menu', menu: 'row:routing:main' })
  apply({ kind: 'toggle-menu', menu: 'row:routing:plan' })

  assert.equal(findAll(child(view(), 'settings-body'), 'settings-menu').length, 1)
})

test('picking an option emits that row’s own change intent', (t) => {
  const { view, stub, intents, apply } = mount(t)
  apply({ kind: 'toggle-menu', menu: 'row:routing:main' })
  intents.length = 0
  const items = findAll(mainRoutingPill(view()), 'settings-menu-item')
  const inherit = items.find((item) => item.text.includes('inherit') || item.text.includes('继承'))
  assert.ok(inherit, items.map((item) => item.text).join(' | '))
  stub.click(inherit.node)

  assert.deepEqual(intents, [{ kind: 'set-routing', role: 'main', value: 'inherit' }])
})

test('the arrow keys walk an open menu and wrap', (t) => {
  const { view, stub, apply } = mount(t)
  apply({ kind: 'toggle-menu', menu: 'row:routing:main' })
  const shell = mainRoutingPill(view())
  const trigger = child(shell, 'settings-pill')
  const items = findAll(shell, 'settings-menu-item')

  stub.dispatch(shell.node, 'keydown', { target: trigger.node, key: 'ArrowDown' })
  assert.equal(stub.activeElement(), items[0]!.node, 'from the trigger, down lands on the first')

  stub.dispatch(shell.node, 'keydown', { target: items[0]!.node, key: 'ArrowUp' })
  assert.equal(stub.activeElement(), items.at(-1)!.node, 'and up from the first wraps to the last')

  stub.dispatch(shell.node, 'keydown', { target: items.at(-1)!.node, key: 'Home' })
  assert.equal(stub.activeElement(), items[0]!.node)
})

test('a closed pill opens on ArrowDown rather than swallowing the key', (t) => {
  const { view, stub, intents } = mount(t)
  const shell = mainRoutingPill(view())
  stub.dispatch(shell.node, 'keydown', {
    target: child(shell, 'settings-pill').node,
    key: 'ArrowDown',
  })

  assert.deepEqual(intents, [{ kind: 'toggle-menu', menu: 'row:routing:main' }])
})

/** The chain from the screen's root down to the first node carrying `className`. */
function pathTo(view: StubView, className: string): StubView[] {
  // `StubView` has no parent link, so the path is found on the way down.
  const walk = (node: StubView): StubView[] | undefined => {
    if (node.classes.includes(className)) return [node]
    for (const kid of node.children) {
      const below = walk(kid)
      if (below) return [node, ...below]
    }
    return undefined
  }
  const found = walk(view)
  assert.ok(found, `no .${className} anywhere in the screen`)
  return found
}

const CLIPPING = new Set(['hidden', 'clip'])

/** Rules whose whole selector is `.name` — the ones that apply to it unconditionally. */
function rulesFor(className: string): Block[] {
  return cssBlocks().filter((block) => block.selector === `.${className}`)
}

test('an open dropdown has no clipping ancestor inside the screen', (t) => {
  // D3: `.settings-card` used to carry `overflow: hidden`, and the 外观 page's
  // theme card is one row tall — every option of the menu below it was cut off.
  //
  // The judgement is selector-level because it has to be: `domStub` computes no
  // layout, so "is it visible" is not a question that can be asked here. What
  // this holds is the property the fix rests on — nothing between the menu and
  // the screen's root clips its overflow. `.settings-body` scrolls (`overflow-y:
  // auto`), which *extends* rather than cuts, and is the documented trade-off in
  // `styles.css`. The real proof is smoke step 8's `elementFromPoint` probe.
  const { view, apply } = mount(t)
  apply({ kind: 'toggle-menu', menu: 'row:routing:main' })
  const chain = pathTo(view(), 'settings-menu')

  // Non-vacuity, twice: the menu must really be inside the card (or this asserts
  // over a chain that never contained the offender), and that card must really
  // have rules in the sheet (or a rename turns the loop below into a no-op).
  const ancestors = chain.slice(0, -1)
  assert.ok(
    ancestors.some((node) => node.classes.includes('settings-card')),
    `the dropdown is not inside a card: ${ancestors.map((node) => node.className).join(' > ')}`,
  )
  assert.ok(rulesFor('settings-card').length > 0, 'styles.css has no `.settings-card` rule')

  for (const ancestor of ancestors) {
    for (const name of ancestor.classes) {
      for (const block of rulesFor(name)) {
        for (const decl of block.decls) {
          if (!['overflow', 'overflow-x', 'overflow-y'].includes(decl.prop)) continue
          assert.ok(
            !CLIPPING.has(decl.value),
            `.${name} { ${decl.prop}: ${decl.value} } clips the open dropdown below it`,
          )
        }
      }
    }
  }
})

// --- focus loss --------------------------------------------------------------

test('focus leaving the screen closes the menu; the view’s own repaint does not', (t) => {
  const { stub, container, intents } = mount(t)
  const outside = stub.createContainer('elsewhere')

  // `relatedTarget === null` is what this view's own `replace()` looks like, and
  // it happens on every single render.
  stub.dispatch(container, 'focusout', { relatedTarget: null })
  assert.deepEqual(intents, [])

  stub.dispatch(container, 'focusout', { relatedTarget: outside })
  assert.deepEqual(intents, [{ kind: 'close-menu' }])
})

test('moving focus from a trigger to its own item is not a departure', (t) => {
  const { view, stub, container, intents, apply } = mount(t)
  apply({ kind: 'toggle-menu', menu: 'row:routing:main' })
  intents.length = 0
  const item = findAll(mainRoutingPill(view()), 'settings-menu-item')[0]!

  stub.dispatch(container, 'focusout', { relatedTarget: item.node })
  assert.deepEqual(intents, [], 'the menu must survive being operated')
})

test('a closed screen is hidden and draws nothing', (t) => {
  const { view, render } = mount(t)
  render(stateOf({ open: false }))

  assert.equal(view().hidden, true)
})

// --- the view model this file renders ----------------------------------------

test('every view model field this file relies on is really produced', (t) => {
  // Non-vacuity: the assertions above read `openMenu`, `query` and `searchEmpty`
  // off the view model, so a rename that quietly dropped one would make several
  // of them pass against `undefined`.
  const view: SettingsViewModel = settingsView(
    stateOf({ category: 'general', query: 'zzz', openMenu: 'row:x' }),
  )
  assert.equal(view.query, 'zzz')
  assert.equal(view.openMenu, 'row:x')
  assert.ok(view.searchEmpty)
  assert.ok(view.navGroups.length > 0)
  void t
})
