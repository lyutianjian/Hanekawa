export type KeyBindingContext = 'global' | 'chat' | 'autocomplete'

export interface KeyBinding {
  key: string
  ctrl?: boolean
  shift?: boolean
  meta?: boolean
  action: string
  context: KeyBindingContext
}

export interface KeyBindingHandler {
  action: string
  handler: () => void
}

export interface KeyBindingsConfig {
  global?: {
    interrupt?: string
    exit?: string
    clear?: string
    toggleTodo?: string
    toggleTranscript?: string
    historySearch?: string
  }

  chat?: {
    cancel?: string
    submit?: string
    historyUp?: string
    historyDown?: string
    undo?: string
    externalEditor?: string
    stage?: string
    imagePaste?: string
  }

  editing?: {
    lineStart?: string
    lineEnd?: string
    killLine?: string
    killLineBackward?: string
    killWord?: string
    yank?: string
    deleteToken?: string
    wordBackward?: string
    wordForward?: string
    deleteWordForward?: string
    yankPop?: string
  }

  autocomplete?: {
    accept?: string
    next?: string
    previous?: string
    close?: string
  }
}
