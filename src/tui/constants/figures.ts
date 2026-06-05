// Centralized TUI symbol constants.
// Mirrors Claude Code's src/constants/figures.ts pattern. Hanekawa keeps
// platform-agnostic glyphs (no darwin/win32 detection) for simplicity.

export const STATUS_DOT = '\u25cf'             // ● BLACK CIRCLE — tool status indicator
export const RESPONSE_PREFIX = '  \u23bf  '     // '  ⎿  ' — tool result / nested-content gutter
export const TREE_BRANCH = '\u251c\u2500'      // ├─ — non-last tree connector
export const TREE_LAST = '\u2514\u2500'        // └─ — last-item tree connector
export const TREE_PIPE = '\u2502'              // │  — vertical continuation
export const TICK = '\u2713'                   // ✓
export const CROSS = '\u2717'                  // ✗
export const CIRCLE_OPEN = '\u25cc'            // ◌
export const MIDDLE_DOT = '\u00b7'             // · (separator in stat lines)
export const ELLIPSIS = '\u2026'               // …

// Collapsed-group hint display delay. Fast-completing batches shouldn't flicker
// a hint line; hold the summary for at least this long before showing it.
export const MIN_HINT_DISPLAY_MS = 700

// Maximum lines shown before a tool result collapses. Must match the
// historical ToolCallBlock default so scrollback is stable across versions.
export const COLLAPSE_LINES = 3
