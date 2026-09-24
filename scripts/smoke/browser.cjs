/**
 * The agent browser against real Chromium: the paths a stub DOM cannot prove.
 *
 * The Electron main process of `npm run smoke:browser`; `scripts/smoke-browser.mjs`
 * launches it with a private profile and removes that profile once Electron
 * has exited — Chromium keeps writing to it until then.
 *
 * It drives `DesktopBrowserHost` over that profile and a loopback server,
 * never the user's config, projects or browser partition data. What it checks
 * is behaviour only a real renderer has — beforeunload and user activation,
 * elementFromPoint, a native <select>, a key chord — and it exits non-zero if
 * any step fails, after printing each step.
 *
 * CommonJS on purpose: the built modules are ESM and are loaded with
 * `import()`, but an ESM *entry* point has been seen never to start at all in
 * a headless Linux container, while this one runs everywhere.
 */

const { app, BaseWindow } = require('electron')
const { createServer } = require('node:http')

const profile = process.argv.find((arg) => arg.startsWith('--smoke-profile='))?.slice('--smoke-profile='.length)
if (!profile) throw new Error('The browser smoke requires --smoke-profile=<directory>')
app.setPath('userData', profile)
app.setPath('sessionData', profile)

const PAGES = {
  '/stay': `<!doctype html><title>Stay</title>
    <button id="arm" style="width:200px;height:40px">arm</button>
    <button id="disarm" style="width:200px;height:40px">disarm</button>
    <div id="cover-host" style="position:relative;width:200px;height:40px">
      <button id="covered" style="width:200px;height:40px">covered</button>
      <div id="banner" style="position:absolute;inset:0;background:#fc0" role="dialog" aria-label="Cookie banner"></div>
    </div>
    <select id="country"><option value="">Choose</option><option value="fr">France</option></select>
    <label id="terms-label"><input id="terms" type="checkbox" style="opacity:0;position:absolute"> Accept terms</label>
    <p id="prose">Order <b>confirmed</b> today</p>
    <script>
      document.getElementById('arm').onclick = () => {
        window.onbeforeunload = (event) => { event.preventDefault(); event.returnValue = '' }
        document.body.insertAdjacentHTML('beforeend', '<p id="armed">armed</p>')
      }
      document.getElementById('disarm').onclick = () => { window.onbeforeunload = null }
      document.getElementById('country').onchange = (e) => { document.title = 'picked ' + e.target.value }
    </script>`,
  '/next': '<!doctype html><title>Next</title><p>next page</p>',
  // Bootstrap's reboot sets this; an animated scroll leaves a rect read right
  // after it at the old position.
  '/smooth': `<!doctype html><title>Smooth</title>
    <style>html { scroll-behavior: smooth }</style>
    <div style="height:3000px">top</div>
    <button id="far" style="width:200px;height:40px" onclick="document.title = 'clicked'">far</button>
    <div style="height:3000px">bottom</div>`,
  '/spa': `<!doctype html><title>Spa</title>
    <button id="push" style="width:200px;height:40px" onclick="history.pushState({}, '', '/spa/two')">push</button>`,
}

const server = createServer((request, response) => {
  if (request.url === '/report.csv') {
    response.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="report 1.csv"' })
    response.end('a,b\n1,2\n')
    return
  }
  const page = PAGES[new URL(request.url ?? '/', 'http://x').pathname]
  response.writeHead(page === undefined ? 404 : 200, { 'content-type': 'text/html; charset=utf-8' })
  response.end(page ?? 'not found')
})
let origin = ''

let failed = false
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failed = true
}

async function codeOf(promise) {
  try {
    await promise
    return 'none'
  } catch (error) {
    return error?.code ?? String(error)
  }
}

async function run() {
  const { BrowserTabHost } = await import('../../dist/desktop/browser/tabs.js')
  const { DesktopBrowserHost } = await import('../../dist/desktop/browser/host.js')
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${server.address().port}`
  await app.whenReady()
  const window = new BaseWindow({ width: 1000, height: 800, show: true })
  const tabs = new BrowserTabHost()
  tabs.attachWindow(window)
  const host = new DesktopBrowserHost({ tabs, laneForSession: () => 'lane' })
  const caller = { sessionId: 'smoke', turnId: 'turn-1' }

  const tab = await host.createTab(caller, `${origin}/stay`)
  tabs.setBounds(tab.tabId, { x: 0, y: 0, width: 1000, height: 800 }, true)
  const loaded = await host.waitForLoad(caller, tab.tabId, { timeoutMs: 10_000 })
  check('the first page loads', loaded.url === `${origin}/stay`, loaded.url)

  // C: a covered target is refused and named; an uncovered one is pressed.
  const covered = await host.click(caller, tab.tabId, { selector: '#covered' }).catch((error) => error)
  check(
    'a covered button is refused, naming the banner',
    covered?.code === 'ELEMENT_NOT_INTERACTABLE' && /Cookie banner/.test(covered.message),
    covered?.message,
  )
  // The click is also the user activation Chromium requires before it will
  // honour a beforeunload refusal.
  await host.click(caller, tab.tabId, { selector: '#arm' })
  // The click's handler runs a moment after the press is acknowledged.
  await host.waitFor(caller, tab.tabId, { selector: '#armed', timeoutMs: 2000 })

  // B: the page refuses to be left.
  await host.navigate(caller, tab.tabId, `${origin}/next`)
  const refused = await codeOf(host.waitForLoad(caller, tab.tabId, { timeoutMs: 5000 }))
  check('a refused navigation ends the wait with NAVIGATION_FAILED', refused === 'NAVIGATION_FAILED', refused)
  const row = tabs.describe().find((entry) => entry.tabId === tab.tabId)
  check('the tab is no longer loading', row?.loading === false, JSON.stringify(row?.loading))
  check('the tab still shows the page that refused', row?.url === `${origin}/stay`, row?.url)
  const readable = await host.text(caller, tab.tabId, {}).catch((error) => error)
  check('the page it stayed on can still be read', typeof readable?.text === 'string', readable?.message)

  // A: text grouped by block, and wait_for on a split phrase.
  check('inline tags do not split a block', /(^|\n)text\tOrder confirmed today(\n|$)/.test(readable.text), readable.text)
  const waited = await codeOf(host.waitFor(caller, tab.tabId, { text: 'order confirmed', timeoutMs: 2000 }))
  check('wait_for finds a phrase split across inline tags', waited === 'none', waited)

  // E: a native select and a checkbox hidden behind its label.
  const picked = await host.selectOption(caller, tab.tabId, { selector: '#country', label: 'France' })
  check('select_option picks by label', /option 1 "France"/.test(picked.text), picked.text)
  // The title arrives through `page-title-updated`, a moment after the change.
  await new Promise((resolve) => setTimeout(resolve, 300))
  const titled = (await host.listTabs(caller)).find((entry) => entry.tabId === tab.tabId)
  check('the page saw the change event', titled?.title === 'picked fr', titled?.title)
  const ticked = await host.setChecked(caller, tab.tabId, { selector: '#terms', checked: true })
  check('set_checked clicks a hidden checkbox through its label', /through its label/.test(ticked.text), ticked.text)
  const again = await host.setChecked(caller, tab.tabId, { selector: '#terms', checked: true })
  check('set_checked is idempotent', /already checked/.test(again.text), again.text)

  // D + F: a key chord, then a navigation the URL wait follows.
  const keyed = await host.pressKey(caller, tab.tabId, { keys: ['Shift', 'Tab'] })
  check('press_key sends a chord', /pressed Shift\+Tab/.test(keyed.text), keyed.text)
  await host.click(caller, tab.tabId, { selector: '#disarm' })
  await host.navigate(caller, tab.tabId, `${origin}/next`)
  const arrived = await codeOf(host.waitFor(caller, tab.tabId, { url: `${origin}/next`, timeoutMs: 5000 }))
  check('wait_for url follows a navigation once the page lets go', arrived === 'none', arrived)
  const next = await host.waitForLoad(caller, tab.tabId, { timeoutMs: 5000 })
  check('the next page loads normally', next.url === `${origin}/next` && next.title === 'Next', next.url)

  // G: back and reload honour a refusal the same way navigate does.
  await host.navigate(caller, tab.tabId, `${origin}/stay`)
  await host.waitForLoad(caller, tab.tabId, { timeoutMs: 5000 })
  await host.click(caller, tab.tabId, { selector: '#arm' })
  await host.waitFor(caller, tab.tabId, { selector: '#armed', timeoutMs: 2000 })
  for (const action of ['reload', 'back']) {
    await host.history(caller, tab.tabId, action)
    const code = await codeOf(host.waitForLoad(caller, tab.tabId, { timeoutMs: 5000 }))
    check(`a refused ${action} ends the wait with NAVIGATION_FAILED`, code === 'NAVIGATION_FAILED', code)
    const still = await codeOf(host.waitFor(caller, tab.tabId, { selector: '#armed', timeoutMs: 500 }))
    check(`the page that refused the ${action} is still there`, still === 'none', still)
  }
  await host.click(caller, tab.tabId, { selector: '#disarm' })
  await host.history(caller, tab.tabId, 'back')
  const back = await host.waitForLoad(caller, tab.tabId, { timeoutMs: 5000 })
  check('back goes back once the page lets go', back.url === `${origin}/next`, back.url)
  await host.history(caller, tab.tabId, 'reload')
  const reloaded = await host.waitForLoad(caller, tab.tabId, { timeoutMs: 5000 })
  check('a reload the page allows still loads', reloaded.url === `${origin}/next` && reloaded.title === 'Next', reloaded.url)

  // I: back between pushState entries keeps the document and still ends the wait.
  await host.navigate(caller, tab.tabId, `${origin}/spa`)
  await host.waitForLoad(caller, tab.tabId, { timeoutMs: 5000 })
  await host.click(caller, tab.tabId, { selector: '#push' })
  await host.waitFor(caller, tab.tabId, { url: `${origin}/spa/two`, timeoutMs: 2000 })
  await host.history(caller, tab.tabId, 'back')
  const inPage = await host.waitForLoad(caller, tab.tabId, { timeoutMs: 3000 }).catch((error) => error)
  check('back across a pushState entry settles', inPage?.url === `${origin}/spa`, inPage?.url ?? inPage?.message)

  // H: a smooth-scrolling page does not leave an off-screen target off screen.
  await host.navigate(caller, tab.tabId, `${origin}/smooth`)
  await host.waitForLoad(caller, tab.tabId, { timeoutMs: 5000 })
  const far = await codeOf(host.click(caller, tab.tabId, { selector: '#far' }))
  check('an off-screen button on a smooth-scrolling page is clicked', far === 'none', far)
  await new Promise((resolve) => setTimeout(resolve, 300))
  const clicked = (await host.listTabs(caller)).find((entry) => entry.tabId === tab.tabId)
  check('the click reached the button', clicked?.title === 'clicked', clicked?.title)
  const scrolled = await host.scroll(caller, tab.tabId, { direction: 'top' })
  check('scrolling to the top reports where it landed', /y=0 of /.test(scrolled.text), scrolled.text)

  // I: the debugger is attached for input, steps aside for DevTools, and the
  // automation refuses — retryably, naming DevTools — until it is closed.
  const contents = tabs.pageFor(tab.tabId).contents
  check('input attached the debugger', contents.debugger.isAttached())
  const opened = new Promise((resolve) => contents.once('devtools-opened', resolve))
  contents.openDevTools({ mode: 'detach' })
  await opened
  check('opening DevTools detaches the automation', !contents.debugger.isAttached())
  const devToolsRefusal = await host.click(caller, tab.tabId, { selector: '#far' }).catch((error) => error)
  check(
    'a click with DevTools open is refused, retryably, naming DevTools',
    devToolsRefusal?.code === 'PAGE_NOT_READY' && devToolsRefusal.retryable === true && /DevTools/.test(devToolsRefusal.message),
    devToolsRefusal?.message,
  )
  const closed = new Promise((resolve) => contents.once('devtools-closed', resolve))
  contents.closeDevTools()
  await closed
  const after = await codeOf(host.click(caller, tab.tabId, { selector: '#far' }))
  check('closing DevTools gives the automation its channel back', after === 'none' && contents.debugger.isAttached(), after)

  // J: who is driving. Real input from the person, through Chromium's own
  // input pipeline, read against the three states.
  const rowOf = () => tabs.describe().find((entry) => entry.tabId === tab.tabId)
  const settle = () => new Promise((resolve) => setTimeout(resolve, 200))
  check('mid-turn the tab is drawn as the agent\'s', rowOf()?.agentActive === true, JSON.stringify(rowOf()))
  contents.sendInputEvent({ type: 'mouseWheel', x: 100, y: 100, deltaX: 0, deltaY: -120 })
  contents.sendInputEvent({ type: 'keyDown', keyCode: 'Shift' })
  contents.sendInputEvent({ type: 'keyUp', keyCode: 'Shift' })
  await settle()
  check('a wheel and a lone modifier are not a takeover', rowOf()?.takenOver !== true, JSON.stringify(rowOf()))
  contents.sendInputEvent({ type: 'mouseDown', x: 100, y: 100, button: 'left', clickCount: 1 })
  contents.sendInputEvent({ type: 'mouseUp', x: 100, y: 100, button: 'left', clickCount: 1 })
  await settle()
  check('a press mid-turn takes the tab over', rowOf()?.takenOver === true && rowOf()?.agentActive !== true, JSON.stringify(rowOf()))
  const blocked = await codeOf(host.listTabs(caller))
  check('the taken-over session is refused', blocked === 'BROWSER_USER_TAKEOVER', blocked)

  host.turnEnded(caller.sessionId)
  check('the turn ending hands the tab back to idle', rowOf()?.takenOver !== true && rowOf()?.agentActive !== true, JSON.stringify(rowOf()))
  const late = await codeOf(host.listTabs(caller))
  check('a straggler from the ended turn is refused', late === 'OPERATION_ABORTED', late)
  const idleCaller = { sessionId: caller.sessionId, turnId: 'turn-2' }
  const snapshot = await host.elements(idleCaller, tab.tabId, {})
  const ref = /\b(e\d+)\b/.exec(snapshot.text)?.[1]
  host.turnEnded(caller.sessionId)
  contents.sendInputEvent({ type: 'mouseDown', x: 5, y: 5, button: 'left', clickCount: 1 })
  contents.sendInputEvent({ type: 'mouseUp', x: 5, y: 5, button: 'left', clickCount: 1 })
  contents.sendInputEvent({ type: 'keyDown', keyCode: 'A' })
  await settle()
  check('a press between turns is not a takeover', rowOf()?.takenOver !== true, JSON.stringify(rowOf()))
  const nextTurn = { sessionId: caller.sessionId, turnId: 'turn-3' }
  const stale = await codeOf(host.click(nextTurn, tab.tabId, { ref }))
  check('a ref taken before the user touched the page misses', stale === 'STALE_ELEMENT', `${ref} → ${stale}`)
  check('the next turn draws the tab as the agent\'s again', rowOf()?.agentActive === true, JSON.stringify(rowOf()))
  contents.sendInputEvent({ type: 'keyDown', keyCode: 'A' })
  await settle()
  check('a keystroke mid-turn takes the tab over', rowOf()?.takenOver === true, JSON.stringify(rowOf()))

  // K: permissions and downloads, answered once for the whole partition.
  host.turnEnded(caller.sessionId)
  const downloader = { sessionId: caller.sessionId, turnId: 'turn-4' }
  const permission = await contents.executeJavaScript("navigator.permissions.query({ name: 'geolocation' }).then((status) => status.state)")
  check('a permission check is answered denied', permission === 'denied', permission)
  const second = await host.createTab(downloader, `${origin}/next`)
  await host.waitForLoad(downloader, second.tabId, { timeoutMs: 10_000 })
  const cancelled = new Promise((resolve) => {
    tabs.pageFor(second.tabId).contents.session.once('will-download', (_event, item) => setImmediate(() => resolve(item.getState())))
  })
  await host.navigate(downloader, second.tabId, `${origin}/report.csv`)
  const state = await Promise.race([cancelled, new Promise((resolve) => setTimeout(() => resolve('timeout'), 5000))])
  check('a download is cancelled', state === 'cancelled', state)
  const listed = (await host.listTabs(downloader)).find((entry) => entry.tabId === second.tabId)
  check(
    'get_state names the blocked download on its tab only',
    JSON.stringify(listed?.blockedDownloads) === '["report 1.csv"]' &&
      (await host.listTabs(downloader)).find((entry) => entry.tabId === tab.tabId)?.blockedDownloads === undefined,
    JSON.stringify(listed),
  )
  check('the tab still shows the page it was on', listed?.url === `${origin}/next`, listed?.url)
  const settled = await host.waitForLoad(downloader, second.tabId, { timeoutMs: 3000 }).then(() => 'none', (error) => error?.code ?? String(error))
  check('wait_for_load after a download link does not hang', settled !== 'TIMEOUT', settled)

  host.dispose()
  tabs.dispose()
  window.destroy()
}

void (async () => {
  try {
    await run()
  } catch (error) {
    check('the run completed', false, error?.stack ?? String(error))
  } finally {
    server.close()
    app.exit(failed ? 1 : 0)
  }
})()
