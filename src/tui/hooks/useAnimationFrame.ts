import { useState, useEffect, useRef, useCallback } from 'react'

/**
 * 动画帧驱动 hook — 复刻自 Claude Code 的 useAnimationFrame
 * 使用 setTimeout 代替 requestAnimationFrame（Ink 环境无 rAF）
 */
export function useAnimationFrame(interval: number): number {
  const [frame, setFrame] = useState(0)
  const frameRef = useRef(0)

  useEffect(() => {
    const timer = setInterval(() => {
      frameRef.current++
      setFrame(frameRef.current)
    }, interval)

    return () => clearInterval(timer)
  }, [interval])

  return frame
}
