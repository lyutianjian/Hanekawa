import type { KeybindingBlock } from './types.js'

export const DEFAULT_BINDINGS: KeybindingBlock[] = [
  {
    context: 'Global',
    bindings: {
      'ctrl+c': 'app:interrupt',
      'ctrl+d': 'app:exit',
      'ctrl+l': 'app:redraw',
    },
  },
  {
    context: 'Chat',
    bindings: {
      'escape': 'chat:cancel',
      'enter': 'chat:submit',
      'up': 'history:previous',
      'down': 'history:next',
      'ctrl+s': 'chat:stash',
    },
  },
  {
    context: 'Confirmation',
    bindings: {
      'y': 'confirm:yes',
      'n': 'confirm:no',
      'enter': 'confirm:yes',
      'escape': 'confirm:no',
    },
  },
  {
    context: 'Scroll',
    bindings: {
      'pageup': 'scroll:pageUp',
      'pagedown': 'scroll:pageDown',
      'ctrl+home': 'scroll:top',
      'ctrl+end': 'scroll:bottom',
    },
  },
]
