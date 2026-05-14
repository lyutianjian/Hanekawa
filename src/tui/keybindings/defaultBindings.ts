import type { KeyBinding } from './types.js'

export const defaultBindings: KeyBinding[] = [
  // 全局上下文
  { key: 'c', ctrl: true, action: 'interrupt', context: 'global' },
  { key: 'd', ctrl: true, action: 'exit', context: 'global' },
  { key: 'l', ctrl: true, action: 'clear', context: 'global' },

  // 聊天上下文
  { key: 'escape', action: 'cancel', context: 'chat' },
  { key: 'return', action: 'submit', context: 'chat' },
  { key: 'up', action: 'history-up', context: 'chat' },
  { key: 'down', action: 'history-down', context: 'chat' },

  // 文本编辑
  { key: 'a', ctrl: true, action: 'line-start', context: 'chat' },
  { key: 'e', ctrl: true, action: 'line-end', context: 'chat' },
  { key: 'k', ctrl: true, action: 'kill-line', context: 'chat' },
  { key: 'u', ctrl: true, action: 'kill-line-backward', context: 'chat' },
  { key: 'w', ctrl: true, action: 'kill-word', context: 'chat' },
]
