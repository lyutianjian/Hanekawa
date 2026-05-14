import { useState, useCallback, useRef } from 'react'
import type { ChatMessage } from '../components/messages/types.js'
import type { SessionStore } from '../../sessions/service.js'
import type { SessionRecord } from '../../harness/types.js'

type UseSessionOptions = {
  store: SessionStore
  sessionId: string
}

export function useSession({ store, sessionId }: UseSessionOptions) {
  const [isLoaded, setIsLoaded] = useState(false)
  const messageCountRef = useRef(0)

  // 从 session 加载历史消息
  const loadHistory = useCallback(async (): Promise<ChatMessage[]> => {
    try {
      const records = await store.loadRecords(sessionId)
      const messages: ChatMessage[] = []

      for (const record of records) {
        if (record.type === 'message') {
          messages.push({
            id: record.id || `hist-${messages.length}`,
            role: record.role as ChatMessage['role'],
            content: record.content,
            timestamp: new Date(record.createdAt).getTime(),
          })
        }
      }

      messageCountRef.current = messages.length
      setIsLoaded(true)
      return messages
    } catch (err) {
      console.error('Failed to load session history:', err)
      setIsLoaded(true)
      return []
    }
  }, [store, sessionId])

  // 保存消息到 session
  const saveMessage = useCallback(async (message: ChatMessage) => {
    try {
      const record: SessionRecord = {
        type: 'message',
        id: message.id,
        role: message.role as 'user' | 'assistant' | 'system',
        content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
        createdAt: new Date(message.timestamp || Date.now()).toISOString(),
      }
      await store.appendRecord(sessionId, record)
    } catch {
      // 静默失败，不阻塞 UI
    }
  }, [store, sessionId])

  return { loadHistory, saveMessage, isLoaded }
}
