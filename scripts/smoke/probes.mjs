/**
 * Everything this driver reads from or clicks in the page, as expression
 * builders.
 *
 * Two rules keep these safe to poll in a loop:
 *
 * - **Project, never dump.** `Runtime.evaluate` with `returnByValue` serialises
 *   whatever it is handed, so a probe returns counts, ids and short strings — not
 *   `innerHTML`, and never a node (which is not serialisable at all).
 * - **Prefer the app's own hooks.** Rows carry `data-session-id`, badges carry
 *   `aria-label`, panes carry the seeded marker in their text. Reading those means
 *   the driver breaks when the app's contract changes, which is the point, rather
 *   than when its layout is nudged.
 *
 * Clicks go through the app's real handlers (`.click()` on the element the view
 * wired), so a click and a keystroke cannot disagree about what a row means —
 * `activateRow` and `newSessionIntent` exist to make that true, and driving the
 * DOM element is what exercises them.
 *
 * One deliberate exception: `.click()` does not move focus. That matters for the
 * delete confirmation, whose `focusout` handler withdraws it
 * (`dom/sidebarView.ts:89-99`) — a synthetic mouse click leaves the confirmation
 * standing, which is what lets it be screenshotted.
 *
 * Note when editing: every probe below is a template literal, so **no backtick
 * may appear inside one**, including inside a comment. A stray one ends the
 * string and the module fails to parse — which is a build error here, but would
 * be a syntax error inside the page if it ever balanced.
 */

const json = (value) => JSON.stringify(value)

/** The sidebar: collapse state, groups, and every row's badge and flags. */
export const sidebar = () => `(() => {
  const container = document.getElementById('sidebar')
  const list = container.querySelector('.sidebar-list')
  const rows = [...container.querySelectorAll('.session-row')].map((row) => ({
    sessionId: row.dataset.sessionId,
    index: Number(row.dataset.index),
    title: (row.querySelector('.session-title') || {}).textContent || '',
    badge: (row.querySelector('.session-badge[aria-label]') || {}).ariaLabel || 'none',
    active: row.classList.contains('active'),
    selected: row.classList.contains('selected'),
    open: row.classList.contains('open'),
    confirming: row.classList.contains('confirming'),
  }))
  return {
    collapsed: container.classList.contains('collapsed'),
    listHidden: list ? list.hidden : null,
    footerHidden: (container.querySelector('.sidebar-footer') || {}).hidden ?? null,
    rowCount: rows.length,
    // Rows survive a collapse inside the hidden container: render() returns
    // before rebuilding the list (dom/sidebarView.ts:236-241), so "no rows"
    // only holds when the very first render is already collapsed. What collapse
    // actually guarantees is that none of them is on screen.
    visibleRowCount: [...container.querySelectorAll('.session-row')].filter(
      (row) => row.getClientRects().length > 0,
    ).length,
    rows,
    groups: [...container.querySelectorAll('.project-group')].map((group) => ({
      own: group.classList.contains('own'),
      label: (group.querySelector('.project-label') || {}).textContent || '',
      rows: group.querySelectorAll('.session-row').length,
    })),
    sections: [...container.querySelectorAll('.session-section-label')].map((node) => node.textContent),
    empty: container.querySelector('.sidebar-empty') !== null,
  }
})()`

/**
 * The pane subtrees.
 *
 * `visible` is `!hidden`: switching panes only flips visibility
 * (`paneSession.ts:182-191`), so the number of `.pane` elements is the number of
 * live lanes and exactly one of them is visible. `len` is the transcript's text
 * length — the cheapest possible "is it still growing" signal.
 */
export const panes = () => `(() => {
  const area = document.getElementById('transcript-area')
  return [...area.children].map((pane) => {
    const text = (pane.querySelector('.transcript') || {}).textContent || ''
    return {
      visible: !pane.hidden,
      len: text.length,
      head: text.slice(0, 80),
    }
  })
})()`

/** One pane, found by the fixture marker its transcript contains. */
export const paneByMarker = (marker) => `(() => {
  const area = document.getElementById('transcript-area')
  for (const pane of area.children) {
    const text = (pane.querySelector('.transcript') || {}).textContent || ''
    if (text.includes(${json(marker)})) return { found: true, visible: !pane.hidden, len: text.length }
  }
  return { found: false }
})()`

export const overlay = () => `(() => {
  const container = document.getElementById('overlay')
  const panel = document.getElementById('overlay-panel')
  const pick = (selector) => (panel.querySelector(selector) || {}).textContent || ''
  return {
    open: !container.hidden && container.getClientRects().length > 0,
    title: pick('.title'),
    subtitle: pick('.subtitle'),
    reason: pick('.reason'),
    block: pick('.block'),
    hint: pick('.hint'),
    hotkeys: [...panel.querySelectorAll('.hotkey')].map((node) => node.textContent),
  }
})()`

export const surface = () => `(() => {
  const container = document.getElementById('surface')
  return {
    // Both conditions: the settings screen hides its siblings from the
    // stylesheet, so the hidden *attribute* alone would report a panel as open
    // while nothing is on screen.
    open: !container.hidden && container.getClientRects().length > 0,
    attributeOpen: !container.hidden,
    // The surface paints its title as a bare h2 (dom/surfaceView.ts:34), not a
    // classed node like the overlay does.
    title: (container.querySelector('h2') || {}).textContent || '',
    rows: [...container.querySelectorAll('.row')].map((row) => ({
      id: row.dataset.rowId,
      label: (row.querySelector('.label') || {}).textContent || '',
      value: (row.querySelector('.value') || {}).textContent || '',
      selected: row.classList.contains('selected'),
    })),
  }
})()`

/**
 * The status bar plus the two fields that left it in 5e: the permission mode is
 * now the composer's pill, and the session name is the canvas header's. Both are
 * still read here, because the stages that assert on them are asking "what does
 * the window say about this session", not "what is in the status bar".
 */
export const status = () => `(() => {
  const text = (id) => (document.getElementById(id) || {}).textContent || ''
  const el = (selector) => document.querySelector(selector)
  return {
    mode: text('chip-permission'),
    usage: text('status-usage'),
    cost: text('status-cost'),
    streaming: text('status-streaming'),
    session: (el('#canvas-header .canvas-title') || {}).textContent || '',
    title: document.title,
  }
})()`

/** The canvas header: identity on the left, "open location" on the right. */
export const canvasHeader = () => `(() => {
  const header = document.getElementById('canvas-header')
  if (!header) return { present: false }
  const pick = (selector) => (header.querySelector(selector) || {}).textContent || ''
  return {
    present: true,
    hidden: header.hidden,
    title: pick('.canvas-title'),
    renaming: header.querySelector('.canvas-title-input') !== null,
    menuItems: [...header.querySelectorAll('.canvas-menu-item')].map((node) => node.textContent),
    openLocation: pick('.canvas-open-location'),
  }
})()`

export const clickHeaderMenu = () =>
  clickOr('#canvas-header .canvas-menu-trigger', 'the canvas header menu')

/**
 * The frameless window's title bar (6a).
 *
 * `menus` is what the window says instead of Electron's English File/Edit/View —
 * the stage-6 item is that this row exists at all, that its menus open, and that
 * `items` are the app's own commands rather than new ones. The drag region and
 * the OS-painted buttons on the right cannot be read from here: the overlay is
 * outside the document, so a screenshot is the only evidence.
 */
export const titleBar = () => `(() => {
  const bar = document.getElementById('titlebar')
  if (!bar) return { present: false }
  return {
    present: true,
    rail: bar.querySelector('.titlebar-rail') !== null,
    menus: [...bar.querySelectorAll('.titlebar-menu-trigger')].map((node) => node.textContent),
    open: [...bar.querySelectorAll('.titlebar-menu-trigger.open')].map((node) => node.textContent),
    items: [...bar.querySelectorAll('.titlebar-menu-item')].map((node) => node.textContent),
  }
})()`

export const clickTitleBarMenu = (index = 0) =>
  clickOr(`#titlebar .titlebar-menu-shell:nth-of-type(${index + 1}) .titlebar-menu-trigger`, 'a title bar menu')

export const chip = () => `(() => ({
  model: (document.getElementById('chip-model') || {}).textContent || '',
  effort: (document.getElementById('chip-effort') || {}).textContent || '',
  permission: (document.getElementById('chip-permission') || {}).textContent || '',
  submitState: (document.getElementById('submit') || { className: '' }).className,
  progress: (document.getElementById('composer-progress') || {}).hidden,
}))()`

/**
 * The settings screen, including the numbers that stand in for "does the long
 * form scroll inside the window".
 *
 * `#settings-body`'s own overflow is the right question rather than the
 * composer's position: the composer is `display:none` while settings are open
 * (`styles.css:814-819`), so it cannot be pushed anywhere.
 */
export const settings = () => `(() => {
  const container = document.getElementById('settings')
  const body = document.getElementById('settings-body')
  const shell = document.getElementById('shell')
  const composer = document.getElementById('input-row')
  const active = document.activeElement
  return {
    open: !container.hidden,
    canvasOpen: document.getElementById('canvas').classList.contains('settings-open'),
    // Which element holds focus decides whether the screen's own keydown handler
    // (and therefore its documented Esc) can fire at all.
    focus: active ? (active.id || active.className || active.tagName) : 'none',
    focusInside: active ? container.contains(active) : false,
    nav: [...container.querySelectorAll('.settings-nav-item')].map((item) => ({
      label: item.textContent,
      selected: item.classList.contains('selected'),
    })),
    title: (container.querySelector('.settings-title') || {}).textContent || '',
    cards: [...container.querySelectorAll('.settings-card-title')].map((node) => node.textContent),
    rowCount: container.querySelectorAll('.settings-row').length,
    toggles: container.querySelectorAll('[role="switch"]').length,
    error: (container.querySelector('.settings-error') || {}).textContent || '',
    scrollHeight: body ? body.scrollHeight : 0,
    clientHeight: body ? body.clientHeight : 0,
    docScroll: document.documentElement.scrollHeight,
    viewport: window.innerHeight,
    shellHeight: shell ? Math.round(shell.getBoundingClientRect().height) : 0,
    composerHidden: composer ? getComputedStyle(composer).display === 'none' : null,
  }
})()`

// --- clicks ------------------------------------------------------------------

const clickOr = (selector, what) => `(() => {
  const node = document.querySelector(${json(selector)})
  if (!node) throw new Error('no ' + ${json(what)} + ' matching ' + ${json(selector)})
  node.click()
  return true
})()`

export const clickRow = (sessionId) =>
  clickOr(`.session-row[data-session-id="${sessionId}"] .session-open`, 'session row')

export const clickDelete = (sessionId) =>
  clickOr(`.session-row[data-session-id="${sessionId}"] .session-delete`, 'delete button')

export const clickConfirmYes = (sessionId) =>
  clickOr(`.session-row[data-session-id="${sessionId}"] .session-confirm-yes`, 'delete confirmation')

export const clickSurfaceRow = (rowId) => clickOr(`#surface .row[data-row-id="${rowId}"]`, 'surface row')

export const clickChipEffort = () => clickOr('#chip-effort', 'effort chip')

/** Settings nav items are identified by their visible label, which is their id. */
export const clickSettingsNav = (label) => `(() => {
  const item = [...document.querySelectorAll('.settings-nav-item')].find((node) => node.textContent === ${json(label)})
  if (!item) throw new Error('no settings category labelled ' + ${json(label)})
  item.click()
  return true
})()`
