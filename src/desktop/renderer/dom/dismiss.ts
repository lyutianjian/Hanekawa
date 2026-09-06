/**
 * "Click outside closes it", as one primitive.
 *
 * Every menu and popover in this renderer used to close on its container's
 * `focusout` alone, and that has a hole the views document one by one: a click
 * on an unfocusable decoration — the transcript's background, the canvas gutter
 * — moves no focus, so no `focusout` fires and the menu stays open. Worse, most
 * of these triggers are rebuilt by the very repaint that opens the menu, and
 * Chromium fires no `blur` for a focused node that is *removed*: focus is back
 * on `<body>` before the user's second click, so the container has nothing left
 * to lose focus from and `focusout` never fires again at all.
 *
 * So this listens where the click actually lands. Four things are load-bearing:
 *
 * 1. **Capture phase, on `document`.** Several subtrees stop propagation on
 *    their own pointer events — `controls.ts`'s `button()` stops every `click`
 *    it handles — and a bubbling listener would never hear those.
 * 2. **`keep` is the popover *and* its trigger, not the bar they sit in.** A
 *    press on the trigger of an open menu has to reach the trigger's own toggle
 *    as a close; answering it here would close the menu and let the `click` that
 *    follows re-open it, and the toggle would stop working. Everything else —
 *    including the rest of the header, the rest of the title bar, the rest of
 *    the rail — is *outside*, which is what makes a press on the blank space
 *    beside a menu dismiss it. Scoping to the whole container is why it did not.
 * 3. **Selectors, not nodes.** These menus are rebuilt by every repaint, and a
 *    streaming turn repaints per token; a captured node reference would be
 *    stale by the user's next click. An element may still be passed where the
 *    anchor really is persistent (the welcome hero's row, the composer's form).
 * 4. **Four event types, and `handler` must be idempotent.** `pointerdown` is
 *    the one the user reads as "I pressed somewhere else", and it precedes
 *    `click`, so a menu item still receives its own activation. `mousedown` and
 *    `click` follow it because a popover that will not close is worse than one
 *    told to close three times, and `contextmenu` because a right-click
 *    elsewhere is also "somewhere else". Every caller already answers an
 *    unchanged state without repainting — the rule `app.ts` spells out at
 *    `closeHeaderMenu` — so one gesture costs one close and two no-ops.
 *
 * This does not replace the `focusout` and Escape exits; keyboard users never
 * generate a press at all.
 */

/** A popover's own subtree: a CSS selector, or a node when the anchor is persistent. */
export type DismissAnchor = string | HTMLElement

/**
 * The presses that dismiss. `pointerdown` first — the rest only matter when
 * something upstream ate it, which is the failure this list exists to survive.
 */
const PRESS_EVENTS = ['pointerdown', 'mousedown', 'contextmenu', 'click'] as const

export function onPressOutside(
  keep: readonly DismissAnchor[],
  handler: () => void,
): () => void {
  const selector = keep.filter((anchor): anchor is string => typeof anchor === 'string').join(',')
  const nodes = keep.filter((anchor): anchor is HTMLElement => typeof anchor !== 'string')

  const inside = (target: unknown): boolean => {
    for (const node of nodes) {
      if (target instanceof Node && node.contains(target)) return true
    }
    // `closest` walks up from the pressed node, so a press on a menu item's own
    // label — a text node's parent `<span>` — is still inside the menu.
    return selector !== '' && target instanceof Element && target.closest(selector) !== null
  }

  const listener = (event: Event): void => {
    if (inside(event.target)) return
    handler()
  }

  for (const type of PRESS_EVENTS) document.addEventListener(type, listener, true)
  return () => {
    for (const type of PRESS_EVENTS) document.removeEventListener(type, listener, true)
  }
}
