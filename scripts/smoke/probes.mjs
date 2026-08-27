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
    // Collapsed is zero width now, not a 44px rail (S7): the toggle it used to
    // keep reachable lives in the title bar.
    width: Math.round(container.getBoundingClientRect().width),
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

/**
 * The visible pane's conversation, as boxes.
 *
 * todo V2: a short history used to hang one bubble under the canvas header with
 * the rest of the canvas blank. The three facts fail separately — is this even
 * the short case (nothing to scroll), does the column meet the composer, and was
 * it actually pushed down rather than merely starting there.
 *
 * `null` when no pane is visible, so a step asserts on the shape rather than on
 * a zero that could mean either thing. No backticks in here: this is a template
 * literal.
 */
export const conversation = () => `(() => {
  const area = document.getElementById('transcript-area')
  const pane = [...area.children].find((node) => !node.hidden)
  if (!pane) return null
  const scroller = pane.querySelector('.transcript')
  const column = pane.querySelector('.transcript-column')
  if (!scroller || !column) return null
  const scrollerBox = scroller.getBoundingClientRect()
  const columnBox = column.getBoundingClientRect()
  const round = (box) => ({
    top: Math.round(box.top),
    bottom: Math.round(box.bottom),
    left: Math.round(box.left),
    right: Math.round(box.right),
  })
  return {
    items: column.children.length,
    // Equal means the conversation does not fill the scroller, which is the
    // only case this probe has anything to say about.
    scrollHeight: scroller.scrollHeight,
    clientHeight: scroller.clientHeight,
    scroller: round(scrollerBox),
    column: round(columnBox),
  }
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
    // The hint line is gone as of S5: a key is printed on the button it belongs
    // to, as a .kbd badge, and a key with no button is not printed at all.
    // (No backticks in here either — see the note below.)
    hotkeys: [...panel.querySelectorAll('.kbd')].map((node) => node.textContent),
    // Centres, so a step can aim a real mouse event at a row or a button. A rect
    // alone proves nothing about hit-testing (getBoundingClientRect answers in
    // full for a clipped or covered node), so the evidence is what the click does.
    // No backticks in here: this whole probe is a template literal.
    options: [...panel.querySelectorAll('.option')].map((node) => {
      const rect = node.getBoundingClientRect()
      return {
        label: node.textContent,
        selected: node.classList.contains('selected'),
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      }
    }),
    actions: [...panel.querySelectorAll('.dialog-btn')].map((node) => {
      const rect = node.getBoundingClientRect()
      return {
        label: node.textContent,
        primary: node.classList.contains('primary'),
        danger: node.classList.contains('danger'),
        selected: node.classList.contains('selected'),
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      }
    }),
  }
})()`

/**
 * Where the open dialog's scrim actually is (S6).
 *
 * Two questions, and only the second one is evidence: `getBoundingClientRect`
 * answers in full for a node that is covered or clipped, so matching rectangles
 * would still pass if the scrim were painted over the sidebar. `elementFromPoint`
 * is the hit test — what the mouse would reach at a point in the sidebar, and
 * what it would reach in the middle of the canvas.
 */
export const modalScope = () => `(() => {
  const rect = (id) => {
    const node = document.getElementById(id)
    if (!node) return null
    const box = node.getBoundingClientRect()
    return { left: Math.round(box.left), top: Math.round(box.top), right: Math.round(box.right), bottom: Math.round(box.bottom) }
  }
  const overlay = document.getElementById('overlay')
  const sidebar = document.getElementById('sidebar')
  const canvasBox = rect('canvas')
  const describe = (x, y) => {
    const hit = document.elementFromPoint(x, y)
    if (!hit) return { id: 'none', inSidebar: false, inOverlay: false }
    return {
      id: hit.id || hit.className || hit.tagName,
      inSidebar: sidebar ? sidebar.contains(hit) : false,
      inOverlay: overlay ? overlay.contains(hit) || hit === overlay : false,
    }
  }
  const sidebarBox = sidebar ? sidebar.getBoundingClientRect() : null
  return {
    overlay: rect('overlay'),
    canvas: canvasBox,
    sidebar: sidebarBox ? { left: Math.round(sidebarBox.left), right: Math.round(sidebarBox.right) } : null,
    atSidebar: sidebarBox ? describe(sidebarBox.left + sidebarBox.width / 2, sidebarBox.top + 120) : null,
    atCanvas: canvasBox ? describe((canvasBox.left + canvasBox.right) / 2, (canvasBox.top + canvasBox.bottom) / 2) : null,
  }
})()`

export const surface = () => `(() => {
  const container = document.getElementById('surface')
  const composer = document.getElementById('composer')
  const column = document.querySelector('.composer-column')
  const transcript = document.getElementById('transcript-area')
  const box = container.getClientRects().length > 0 ? container.getBoundingClientRect() : null
  const columnBox = column ? column.getBoundingClientRect() : null
  const composerBox = composer ? composer.getBoundingClientRect() : null
  return {
    // Both conditions: the settings screen hides its siblings from the
    // stylesheet, so the hidden *attribute* alone would report a panel as open
    // while nothing is on screen. Since S9 the panel is inside \`#input-row\`, so
    // what the settings screen hides is its ancestor — the rect is still the
    // honest reading, and the attribute still is not.
    open: !container.hidden && container.getClientRects().length > 0,
    attributeOpen: !container.hidden,
    // todo V3: the panel is one stack floating on the composer's upper edge, on
    // the reading column's own axis. Three separate facts, because they fail
    // separately: does it share the column, is it *above* the composer, and does
    // it leave the transcript's height alone (a float, not a flex sibling).
    rect: box
      ? { left: Math.round(box.left), right: Math.round(box.right), top: Math.round(box.top), bottom: Math.round(box.bottom) }
      : null,
    column: columnBox
      ? { width: Math.round(columnBox.width), left: Math.round(columnBox.left), right: Math.round(columnBox.right) }
      : null,
    composerTop: composerBox ? Math.round(composerBox.top) : null,
    // todo V9, same question as the settings menu's: a floating panel on a white
    // page is separated by its shadow, not by its hairline.
    shadow: getComputedStyle(container).boxShadow,
    background: getComputedStyle(container).backgroundColor,
    transcriptHeight: transcript ? Math.round(transcript.getBoundingClientRect().height) : 0,
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
  const titleBar = document.getElementById('titlebar')
  const composer = document.getElementById('input-row')
  const active = document.activeElement
  const canvas = document.getElementById('canvas')
  const column = container.querySelector('.settings-column')
  // The reading column against the box it is centred in (todo V7). \`body\` is the
  // scroller and keeps its full width; only its content box is the measure to
  // compare against, so the padding is taken out here rather than in the step.
  const bodyStyle = body ? getComputedStyle(body) : null
  const bodyBox = body ? body.getBoundingClientRect() : null
  const columnBox = column ? column.getBoundingClientRect() : null
  const canvasStyle = canvas ? getComputedStyle(canvas) : null
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
    // The strip has two sources that must agree: \`#titlebar\`'s CSS height and
    // \`titleBarOverlay.height\` in \`main.ts\` (the OS paints its three buttons on
    // the same band). Measuring it lets one assertion cover both.
    titleBarHeight: titleBar ? Math.round(titleBar.getBoundingClientRect().height) : 0,
    composerHidden: composer ? getComputedStyle(composer).display === 'none' : null,
    column: columnBox
      ? { width: Math.round(columnBox.width), left: Math.round(columnBox.left), right: Math.round(columnBox.right) }
      : null,
    // Derived from \`clientWidth\`, not from the bounding rect: once the form is
    // long enough to scroll, the scrollbar eats into the padding box, and
    // \`right - paddingRight\` would claim ~10px the column can never have.
    bodyContent: body && bodyBox && bodyStyle
      ? (() => {
          const left = Math.round(bodyBox.left + parseFloat(bodyStyle.paddingLeft))
          const width = Math.round(
            body.clientWidth - parseFloat(bodyStyle.paddingLeft) - parseFloat(bodyStyle.paddingRight),
          )
          return { left, right: left + width }
        })()
      : null,
    // todo V1/S8: the canvas hairline is an \`outline\`, never a \`border\` — a border
    // would inset \`#overlay\`'s \`inset: 0\` by 1px and break S2's per-edge equality.
    canvasHairline: canvasStyle
      ? { outlineWidth: canvasStyle.outlineWidth, borderTopWidth: canvasStyle.borderTopWidth }
      : null,
  }
})()`

/**
 * The resolved theme, the preference behind it, and what the palette actually
 * paints (todo V9).
 *
 * Three readings rather than one, because they fail separately: the attribute
 * (`app.ts` resolved the preference and wrote it), the tokens (the light block
 * layered on) and the paint (a rule really used them). A half-applied palette —
 * the failure that light-mode blindness produces — changes the attribute and
 * leaves the paint dark-on-dark, so the attribute alone proves nothing.
 *
 * `stored` is `localStorage['ui-theme']`, which lives in Electron's *default*
 * userData: `--cwd=` does not isolate it, so a step that changes it owes the
 * developer's machine a restore.
 */
export const theme = () => `(() => {
  const root = document.documentElement
  const style = getComputedStyle(root)
  const token = (name) => style.getPropertyValue(name).trim()
  const paintOf = (node) => {
    if (!node) return null
    const own = getComputedStyle(node)
    return { background: own.backgroundColor, color: own.color }
  }
  return {
    resolved: root.dataset.theme || 'none',
    stored: localStorage.getItem('ui-theme'),
    // Named, not swept: a sweep would compare whatever happens to be declared
    // and could not tell a missing override from a token that has none.
    tokens: {
      '--surface-base': token('--surface-base'),
      '--surface-canvas': token('--surface-canvas'),
      '--surface-card': token('--surface-card'),
      '--surface-hover': token('--surface-hover'),
      '--surface-active': token('--surface-active'),
      '--text-primary': token('--text-primary'),
      '--text-secondary': token('--text-secondary'),
      '--border-subtle': token('--border-subtle'),
      '--border-strong': token('--border-strong'),
      '--shadow-float': token('--shadow-float'),
    },
    // The two the light block deliberately does not override (styles.css:33-39):
    // the knob sits on a saturated blue in both themes, and both scrims must dim
    // by the same amount or stacking them reads as a bug.
    fixed: {
      '--surface-knob': token('--surface-knob'),
      '--surface-scrim': token('--surface-scrim'),
    },
    canvas: paintOf(document.getElementById('canvas')),
    body: paintOf(document.body),
  }
})()`

/**
 * An open pill dropdown, and whether anything is clipping it (todo D3).
 *
 * `lastItemHit` is the assertion that matters, and it is the only one available:
 * a clipped element still reports its full `getBoundingClientRect()`, so the
 * geometry alone cannot tell "hangs out of the card" from "cut off at its edge".
 * Hit testing can — `elementFromPoint` returns what is actually painted at a
 * point, and a clipped-away option is not.
 *
 * `menuBottom > cardBottom` is the non-vacuity half: if the menu no longer
 * extends past its card, this probe stopped exercising the defect.
 */
export const settingsMenu = () => `(() => {
  const menu = document.querySelector('#settings .settings-menu')
  if (!menu) return { open: false }
  const items = [...menu.querySelectorAll('.settings-menu-item')]
  const last = items[items.length - 1]
  const card = menu.closest('.settings-card')
  const body = document.getElementById('settings-body')
  const box = last ? last.getBoundingClientRect() : null
  const x = box ? Math.round(box.left + box.width / 2) : 0
  const y = box ? Math.round(box.top + box.height / 2) : 0
  const inViewport = box ? y > 0 && y < window.innerHeight && x > 0 && x < window.innerWidth : false
  const hit = inViewport ? document.elementFromPoint(x, y) : null
  const own = getComputedStyle(menu)
  return {
    open: true,
    itemCount: items.length,
    labels: items.map((item) => item.textContent),
    // todo V9: the float shadow D3 added is the thing that only matters on a
    // white page — on the dark canvas the border does the separating.
    shadow: own.boxShadow,
    background: own.backgroundColor,
    menuBottom: Math.round(menu.getBoundingClientRect().bottom),
    cardBottom: card ? Math.round(card.getBoundingClientRect().bottom) : 0,
    bodyBottom: body ? Math.round(body.getBoundingClientRect().bottom) : 0,
    inViewport,
    // Not identity with the item: the hit may land on a child of it.
    lastItemHit: hit ? menu.contains(hit) : false,
    hitClass: hit ? (hit.className || hit.tagName) : 'none',
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

/** The first row-level pill on the current settings page. */
export const clickSettingsPill = () => clickOr('#settings .settings-pill', 'settings pill')

/** Settings nav items are identified by their visible label, which is their id. */
export const clickSettingsNav = (label) => `(() => {
  const item = [...document.querySelectorAll('.settings-nav-item')].find((node) => node.textContent === ${json(label)})
  if (!item) throw new Error('no settings category labelled ' + ${json(label)})
  item.click()
  return true
})()`

/** An option in an open pill dropdown, by its visible label (dom/controls.ts:188). */
export const clickSettingsMenuItem = (label) => `(() => {
  const item = [...document.querySelectorAll('#settings .settings-menu-item')].find(
    (node) => node.textContent === ${json(label)},
  )
  if (!item) throw new Error('no dropdown option labelled ' + ${json(label)})
  item.click()
  return true
})()`

/**
 * Writes `localStorage['ui-theme']` directly.
 *
 * The one probe that bypasses the app's own path, and it exists for exactly one
 * job: S11's `finally`. The preference is not isolated by `--cwd=`, so a step
 * that dies mid-switch would otherwise leave the developer's real window in a
 * theme they did not pick. Everything a step *asserts* still goes through the
 * settings screen.
 */
export const setStoredTheme = (value) => `(() => {
  const next = ${json(value)}
  if (next === null) localStorage.removeItem('ui-theme')
  else localStorage.setItem('ui-theme', next)
  return localStorage.getItem('ui-theme')
})()`
