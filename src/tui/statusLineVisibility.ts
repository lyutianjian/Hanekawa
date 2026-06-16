export type PromptScreen = 'prompt' | 'transcript'
export type PromptMode = 'idle' | 'running' | 'restore' | 'exiting'

export function shouldRenderStatusLine(screen: PromptScreen, mode: PromptMode): boolean {
  return screen === 'prompt' && mode !== 'restore'
}
