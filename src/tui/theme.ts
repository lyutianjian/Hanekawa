export const theme = {
  brand: '#E8A0BF',
  userPrefix: '#E8A0BF',
  assistantText: '#E0E0E0',
  dimText: '#808080',
  subtleText: '#909090',
  toolName: '#87CEEB',
  success: '#90EE90',
  error: '#FF6B6B',
  warning: '#FFD700',
  border: '#555555',
  spinner: '#8AB4F8',
  spinnerPalette: [
    { base: '#E8A0BF', shimmer: '#F6C4D9' },
    { base: '#F472B6', shimmer: '#F9A8D4' },
    { base: '#F08CA8', shimmer: '#FFC4D4' },
    { base: '#EFA08A', shimmer: '#FFC8B6' },
    { base: '#CBA6F7', shimmer: '#E2C8FF' },
    { base: '#D8B4FE', shimmer: '#E9D5FF' },
    { base: '#B8C0FF', shimmer: '#D5DBFF' },
  ],
  inputPrompt: '#E8A0BF',
  systemText: '#A0A0A0',
  taskRunning: '#8AB4F8',
  taskDone: '#90EE90',
  taskFailed: '#FF6B6B',
  taskDim: '#808080',
  codeBg: '#1E1E1E',
  codeInline: '#CBA6F7',
  // Syntax highlighting colors (used by cli-highlight theme + code block rendering)
  syntax: {
    keyword: '#CBA6F7',     // Purple — keywords (if, else, return, etc.)
    builtIn: '#F38BA8',     // Red — built-in objects/functions
    type: '#F9E2AF',        // Yellow — user-defined types
    literal: '#A6E3A1',     // Green — true, false, null
    number: '#FAB387',      // Orange — numeric literals
    regexp: '#F5C2E7',      // Pink — regex patterns
    string: '#A6E3A1',      // Green — string literals
    comment: '#6C7086',     // Gray — comments
    function: '#89B4FA',    // Blue — function names
    title: '#89B4FA',       // Blue — declaration names
    params: '#CDD6F4',      // Light gray — function parameters
    meta: '#F38BA8',        // Red — preprocessor/meta
    tag: '#F38BA8',         // Red — HTML/XML tags
    name: '#89B4FA',        // Blue — tag names
    attr: '#F9E2AF',        // Yellow — attributes
    section: '#89B4FA',     // Blue — section headings
    class: '#F9E2AF',       // Yellow — class names
    default: '#CDD6F4',     // Light gray — default/fallback
  },
} as const
