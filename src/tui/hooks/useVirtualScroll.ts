import { useState, useEffect, useRef, useCallback, useMemo } from 'react'

type VirtualScrollOptions = {
  itemCount: number
  estimatedItemHeight: number
  viewportHeight: number
  overscan?: number
  scrollOffset: number
}

type VirtualScrollResult = {
  startIndex: number
  endIndex: number
  totalHeight: number
  offsetY: number
}

export function useVirtualScroll({
  itemCount,
  estimatedItemHeight,
  viewportHeight,
  overscan = 5,
  scrollOffset,
}: VirtualScrollOptions): VirtualScrollResult {
  const itemHeightsRef = useRef<Map<number, number>>(new Map())

  const totalHeight = useMemo(() => {
    let height = 0
    for (let i = 0; i < itemCount; i++) {
      height += itemHeightsRef.current.get(i) ?? estimatedItemHeight
    }
    return height
  }, [itemCount, estimatedItemHeight])

  const { startIndex, endIndex, offsetY } = useMemo(() => {
    let accumulated = 0
    let start = 0

    // 找到起始索引
    for (let i = 0; i < itemCount; i++) {
      const h = itemHeightsRef.current.get(i) ?? estimatedItemHeight
      if (accumulated + h > scrollOffset) {
        start = i
        break
      }
      accumulated += h
    }

    // 应用 overscan
    start = Math.max(0, start - overscan)

    // 找到结束索引
    let end = start
    let visibleHeight = 0
    for (let i = start; i < itemCount; i++) {
      visibleHeight += itemHeightsRef.current.get(i) ?? estimatedItemHeight
      end = i
      if (visibleHeight >= viewportHeight + overscan * estimatedItemHeight) {
        break
      }
    }
    end = Math.min(itemCount - 1, end + overscan)

    // 计算 offsetY
    let offset = 0
    for (let i = 0; i < start; i++) {
      offset += itemHeightsRef.current.get(i) ?? estimatedItemHeight
    }

    return { startIndex: start, endIndex: end, offsetY: offset }
  }, [itemCount, estimatedItemHeight, viewportHeight, overscan, scrollOffset])

  const measureItem = useCallback((index: number, height: number) => {
    itemHeightsRef.current.set(index, height)
  }, [])

  return { startIndex, endIndex, totalHeight, offsetY }
}
