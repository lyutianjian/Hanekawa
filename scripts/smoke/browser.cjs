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
}

const server = createServer((request, response) => {
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
