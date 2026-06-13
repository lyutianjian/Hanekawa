// Centralized TUI symbol constants.
// Mirrors Claude Code's src/constants/figures.ts pattern. Hanekawa keeps
// platform-agnostic glyphs (no darwin/win32 detection) for simplicity.

export const STATUS_DOT = '●'             // ● BLACK CIRCLE — tool status indicator
export const RESPONSE_PREFIX = ' ⎿  '     // ' ⎿  ' — tool result / nested-content gutter
export const TREE_BRANCH = '├─'      // ├─ — non-last tree connector
export const TREE_LAST = '└─'        // └─ — last-item tree connector
export const TREE_PIPE = '│'              // │  — vertical continuation
export const TICK = '✓'                   // ✓
export const CROSS = '✗'                  // ✗
export const CIRCLE_OPEN = '◌'            // ◌
export const MIDDLE_DOT = '·'             // · (separator in stat lines)
export const ELLIPSIS = '…'               // …

// ── Indent & prefix constants ──
export const INDENT_TOOL = 2                   // ToolCallBlock / list nesting paddingLeft
export const THINKING_PREFIX = '*'             // AssistantMessage thinking indicator
export const CONTENT_PREFIX = '●'         // ● AssistantMessage content indicator
export const PREFIX_WIDTH = 2                  // Width of prefix column in AssistantMessage

// Collapsed-group hint display delay. Fast-completing batches shouldn't flicker
// a hint line; hold the summary for at least this long before showing it.
export const MIN_HINT_DISPLAY_MS = 700

// Maximum lines shown before a tool result collapses. Must match the
// historical ToolCallBlock default so scrollback is stable across versions.
export const COLLAPSE_LINES = 3
