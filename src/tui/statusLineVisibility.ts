export type PromptScreen = 'prompt' | 'transcript'
export type PromptMode = 'idle' | 'running' | 'restore' | 'resume' | 'tasks' | 'exiting'

export function shouldRenderStatusLine(screen: PromptScreen, mode: PromptMode): boolean {
  return screen === 'prompt' && mode !== 'restore' && mode !== 'resume' && mode !== 'tasks'
}
