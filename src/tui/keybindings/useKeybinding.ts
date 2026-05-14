import { useInput } from 'ink'
import { resolveAction } from './resolver.js'

type UseKeybindingOptions = {
  context?: string
  isActive?: boolean
}

export function useKeybinding(
  action: string,
  handler: () => void,
  options: UseKeybindingOptions = {},
) {
  const { context = 'Global', isActive = true } = options

  useInput((input, key) => {
    if (!isActive) return
    const resolved = resolveAction(input, key, context)
    if (resolved === action) handler()
  })
}
