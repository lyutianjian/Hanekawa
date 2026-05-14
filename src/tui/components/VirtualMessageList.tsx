import React, { useRef, useState, useCallback, useEffect } from 'react'
import { Box, Text, useInput } from '../ink.js'
import type { ChatMessage } from './messages/types.js'
import { MessageRow } from './messages/MessageRow.js'

type Props = {
  messages: ChatMessage[]
  columns: number
  verbose?: boolean
  autoScroll?: boolean
}

export function VirtualMessageList({ messages, columns, verbose, autoScroll = true }: Props) {
  const [scrollOffset, setScrollOffset] = useState(0)
  const containerRef = useRef<{ height: number }>({ height: 0 })
  const isAutoScrollRef = useRef(autoScroll)

  // 自动滚动到底部
  useEffect(() => {
    if (isAutoScrollRef.current) {
      setScrollOffset(Number.MAX_SAFE_INTEGER)
    }
  }, [messages.length])

  // 键盘滚动
  useInput((input, key) => {
    if (key.pageUp) {
      setScrollOffset(prev => Math.max(0, prev - 20))
      isAutoScrollRef.current = false
    } else if (key.pageDown) {
      setScrollOffset(prev => prev + 20)
    } else if (key.ctrl && key.home) {
      setScrollOffset(0)
      isAutoScrollRef.current = false
    } else if (key.ctrl && key.end) {
      setScrollOffset(Number.MAX_SAFE_INTEGER)
      isAutoScrollRef.current = true
    }
  })

  // 简单虚拟化：只渲染可见范围内的消息
  const estimatedLineHeight = 2
  const viewportHeight = 30 // 简化：固定视口高度
  const maxScroll = Math.max(0, messages.length * estimatedLineHeight - viewportHeight)
  const clampedScroll = Math.min(scrollOffset, maxScroll)

  const startIndex = Math.max(0, Math.floor(clampedScroll / estimatedLineHeight) - 5)
  const endIndex = Math.min(messages.length - 1, Math.ceil((clampedScroll + viewportHeight) / estimatedLineHeight) + 5)

  const visibleMessages = messages.slice(startIndex, endIndex + 1)

  return (
    <Box flexDirection="column" flexGrow={1} overflow="hidden">
      {/* 顶部占位 */}
      {startIndex > 0 && (
        <Box height={startIndex * estimatedLineHeight}>
          <Text dimColor>{`↑ ${startIndex} messages above`}</Text>
        </Box>
      )}

      {/* 可见消息 */}
      {visibleMessages.map(msg => (
        <MessageRow key={msg.id} message={msg} verbose={verbose} />
      ))}

      {/* 底部占位 */}
      {endIndex < messages.length - 1 && (
        <Box>
          <Text dimColor>{`↓ ${messages.length - 1 - endIndex} messages below`}</Text>
        </Box>
      )}
    </Box>
  )
}
