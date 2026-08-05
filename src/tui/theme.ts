const grayscale = {
  white: '#FFFFFF',
  brand: '#F2F2F2',
  text: '#E0E0E0',
  tool: '#D0D0D0',
  success: '#C8C8C8',
  warning: '#B8B8B8',
  subtle: '#909090',
  dim: '#808080',
  border: '#555555',
  black: '#000000',
} as const

export const theme = {
  brand: grayscale.brand,
  userPrefix: grayscale.brand,
  assistantText: grayscale.text,
  dimText: grayscale.dim,
  subtleText: grayscale.subtle,
  toolName: grayscale.tool,
  statusDotSuccess: 'rgb(78,186,101)',
  statusDotFailed: 'rgb(255,107,128)',
  success: '#90EE90',
  error: '#FF6B6B',
  warning: '#FFD700',
  border: grayscale.border,
  spinner: grayscale.tool,
  spinnerPalette: [
    { base: '#707070', shimmer: '#D0D0D0' },
    { base: '#787878', shimmer: '#D8D8D8' },
    { base: '#808080', shimmer: '#E0E0E0' },
    { base: '#888888', shimmer: '#E8E8E8' },
    { base: '#909090', shimmer: '#F0F0F0' },
    { base: '#989898', shimmer: '#F8F8F8' },
    { base: '#A0A0A0', shimmer: grayscale.white },
  ],
  inputPrompt: grayscale.brand,
  systemText: '#A0A0A0',
  taskRunning: '#8AB4F8',
  taskDone: '#90EE90',
  taskFailed: '#FF6B6B',
  taskDim: grayscale.dim,
  codeBg: grayscale.black,
  codeInline: grayscale.tool,
  // Markdown retains its existing colors independently from the grayscale UI.
  markdown: {
    brand: '#60A5FA',
    dimText: '#808080',
    subtleText: '#909090',
    toolName: '#87CEEB',
    success: '#90EE90',
    error: '#FF6B6B',
    warning: '#FFD700',
    codeBg: '#1E1E1E',
    codeInline: '#CBA6F7',
  },
  // Syntax highlighting colors are intentionally excluded from the grayscale UI theme.
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
