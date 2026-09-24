import {
  BROWSER_TOOL_NAME,
  WAIT_FOR_DEFAULT_MS,
  WAIT_FOR_LOAD_DEFAULT_MS,
  WAIT_FOR_LOAD_MAX_MS,
  WAIT_FOR_MAX_MS,
} from './constants.js'

export { BROWSER_TOOL_NAME }

export const DESCRIPTION = `Drive a real browser: open tabs, navigate, and read pages as text the way a person sees them.

Unlike WebFetch, this runs a full browser: JavaScript executes, logins persist between calls, and what you read is the rendered page rather than its HTML source. The user sees the same tabs in a side panel and can take a tab back at any time.

Every call names an \`operation\`. The fields each one takes:

- \`browser.get_state\` — no fields. Lists this session's tabs: tabId, url, title, flags.
- \`browser.create_tab\` — optional \`url\`. Opens a tab and returns its tabId. With a url it also starts loading it.
- \`browser.close_tab\` — \`tabId\`.
- \`tab.navigate\` — \`tabId\`, \`url\`. Returns as soon as the navigation starts; follow it with tab.wait_for_load.
- \`tab.go_back\`, \`tab.go_forward\`, \`tab.reload\` — \`tabId\`. The tab's own history buttons; like tab.navigate, follow them with tab.wait_for_load. Going back or forward fails when the history has no page in that direction.
- \`tab.wait_for_load\` — \`tabId\`, optional \`timeoutMs\` (default ${WAIT_FOR_LOAD_DEFAULT_MS}, max ${WAIT_FOR_LOAD_MAX_MS}).
- \`page.elements.snapshot\` — \`tabId\`, optional \`scope\`, \`role\`, \`text\`, \`interactiveOnly\`, \`visibleOnly\`, \`limit\`, \`maxChars\`, \`cursor\`. A table of the operable elements: ref, role, name, text, value, href, flags. The \`offscreen\` flag marks an element that is rendered but scrolled out of the viewport: page.click and page.type still reach it, but page.screenshot will not show it.
- \`page.text.snapshot\` — \`tabId\`, optional \`scope\`, \`visibleOnly\`, \`limit\`, \`maxChars\`, \`cursor\`. The page's readable text.
- \`page.screenshot\` — \`tabId\`. Attaches a picture of the visible area; use it for layout questions, not for reading text.
- \`page.click\` — \`tabId\`, \`ref\` or \`selector\`, optional \`button\`, \`clickCount\`. A real press at the element's centre, after scrolling it into view.
- \`page.type\` — \`tabId\`, \`ref\` or \`selector\`, \`text\`, optional \`clear\`, \`submit\`. Focuses the field and types into it.
- \`page.scroll\` — \`tabId\`, optional \`direction\` (up/down/top/bottom, default down), \`amount\`, or a \`ref\`/\`selector\` to bring into view.
- \`page.wait_for\` — \`tabId\`, \`selector\` and/or \`text\`, optional \`state\` (visible/hidden), \`timeoutMs\` (default ${WAIT_FOR_DEFAULT_MS}, max ${WAIT_FOR_MAX_MS}).

Usage:
- Start with browser.create_tab, then tab.wait_for_load, then a snapshot. A snapshot of a page that has not loaded fails rather than describing a blank document.
- To act on something: take a page.elements.snapshot, then pass a row's \`ref\` to page.click or page.type. A \`ref\` is only valid until the next snapshot or navigation; a \`selector\` never expires but is re-resolved against whatever matches now. When both are given, \`ref\` wins.
- An action reports what it did, not what the page became. Read the result with a fresh snapshot, and use page.wait_for first when the page updates asynchronously — tab.wait_for_load only answers for navigations.
- page.type does not fire a key event per character, so a page that reacts to individual keystrokes may not notice. \`submit\` presses a real Enter.
- Snapshots are paged. When the output ends with a \`# more:\` line, pass that \`cursor\` back with the same operation to continue; the cursor reads the snapshot that was already taken, so the page cannot shift under you. A cursor stops working once the tab navigates.
- \`scanTruncated=true\` in the header means a page budget ran out mid-scan. Paging cannot reach what it dropped — narrow the request with \`scope\`, \`role\` or \`text\` instead.
- Password, one-time-code and card fields are never projected: their text and value come back empty by design, and what you type into one is never echoed back.
- There is no \`prompt\` parameter — pages come back for you to read, not summarized by another model.
- Navigation asks the user for permission per host, the same way WebFetch does.
- If a call comes back saying the user has taken over the browser, they are driving it themselves: stop, tell them what you were doing, and ask what they want. Retrying in the same turn fails again — control returns on their next message.`
