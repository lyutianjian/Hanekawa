import { useState, useCallback, useRef } from 'react'

export interface StreamingState {
  text: string
  isStreaming: boolean
}

export function useStreaming() {
  const [text, setText] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const bufferRef = useRef('')

  const start = useCallback(() => {
    bufferRef.current = ''
    setText('')
    setIsStreaming(true)
  }, [])

  const append = useCallback((chunk: string) => {
    bufferRef.current += chunk
    setText(bufferRef.current)
  }, [])

  const finish = useCallback(() => {
    setIsStreaming(false)
    return bufferRef.current
  }, [])

  const reset = useCallback(() => {
    bufferRef.current = ''
    setText('')
    setIsStreaming(false)
  }, [])

  return { text, isStreaming, start, append, finish, reset }
}
