import { useRef, useCallback } from 'react'

/**
 * 双击检测 hook — 复刻自 ClaudeCode 的 useDoublePress
 * 在 timeWindow 内连续按两次触发 onDouble，第一次按显示 onFirst 提示
 */
export function useDoublePress(
  onFirst: () => void,
  onDouble: () => void,
  timeWindow = 800,
) {
  const lastPressRef = useRef(0)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const handlePress = useCallback(() => {
    const now = Date.now()
    const elapsed = now - lastPressRef.current

    if (elapsed < timeWindow) {
      // 双击
      clearTimeout(timeoutRef.current)
      lastPressRef.current = 0
      onDouble()
    } else {
      // 第一次
      lastPressRef.current = now
      onFirst()
      timeoutRef.current = setTimeout(() => {
        lastPressRef.current = 0
      }, timeWindow)
    }
  }, [onFirst, onDouble, timeWindow])

  return handlePress
}
