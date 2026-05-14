import { useState, useEffect, useRef } from 'react'

type UseStalledAnimationOptions = {
  responseLengthRef: React.RefObject<number>
  threshold?: number // 停滞检测阈值（毫秒），默认 3000
  fadeDuration?: number // 强度渐变时长（毫秒），默认 2000
}

/**
 * 停滞检测 hook — 复刻自 ClaudeCode/src/components/Spinner/useStalledAnimation.ts
 * 检测 token 是否停止流动，返回 isStalled 和 intensity
 */
export function useStalledAnimation({
  responseLengthRef,
  threshold = 3000,
  fadeDuration = 2000,
}: UseStalledAnimationOptions) {
  const [isStalled, setIsStalled] = useState(false)
  const [intensity, setIntensity] = useState(0)
  const lastLengthRef = useRef(0)
  const lastChangeTimeRef = useRef(Date.now())
  const intervalRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined)

  useEffect(() => {
    const check = () => {
      const currentLength = responseLengthRef.current ?? 0

      // 新 token 到达，重置
      if (currentLength !== lastLengthRef.current) {
        lastLengthRef.current = currentLength
        lastChangeTimeRef.current = Date.now()
        setIsStalled(false)
        setIntensity(0)
        return
      }

      const elapsed = Date.now() - lastChangeTimeRef.current

      if (elapsed >= threshold) {
        setIsStalled(true)
        // 强度从 0 渐变到 1
        const fadeProgress = Math.min(1, (elapsed - threshold) / fadeDuration)
        setIntensity(fadeProgress)
      }
    }

    intervalRef.current = setInterval(check, 200)
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [responseLengthRef, threshold, fadeDuration])

  return { isStalled, intensity }
}
