import { useState, useCallback, useRef } from 'react';
import { DisplayMessage, SystemMessageVariant } from '../types.js';

function generateId(): string {
  return Math.random().toString(36).substring(2, 15);
}

export function useMessageManager() {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const streamBufferRef = useRef<string>('');
  const flushTimerRef = useRef<NodeJS.Timeout | null>(null);
  const streamingMessageIdRef = useRef<string | null>(null);

  const addUserMessage = useCallback((content: string) => {
    const message: DisplayMessage = {
      id: generateId(),
      role: 'user',
      content,
      timestamp: Date.now(),
    };
    setMessages(prev => [...prev, message]);
    return message.id;
  }, []);

  const addAssistantPlaceholder = useCallback(() => {
    const message: DisplayMessage = {
      id: generateId(),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      isStreaming: true,
    };
    setMessages(prev => [...prev, message]);
    streamingMessageIdRef.current = message.id;
    return message.id;
  }, []);

  const flushStreamBuffer = useCallback(() => {
    const text = streamBufferRef.current;
    if (!text || !streamingMessageIdRef.current) return;

    streamBufferRef.current = '';

    setMessages(prev => prev.map(msg =>
      msg.id === streamingMessageIdRef.current
        ? { ...msg, content: msg.content + text }
        : msg
    ));
  }, []);

  const appendStreamText = useCallback((text: string) => {
    streamBufferRef.current += text;

    if (!flushTimerRef.current) {
      flushTimerRef.current = setTimeout(() => {
        flushStreamBuffer();
        flushTimerRef.current = null;
      }, 50);
    }
  }, [flushStreamBuffer]);

  const finalizeAssistantMessage = useCallback((finalContent: string) => {
    flushStreamBuffer();

    setMessages(prev => prev.map(msg =>
      msg.id === streamingMessageIdRef.current
        ? { ...msg, content: finalContent, isStreaming: false }
        : msg
    ));

    streamingMessageIdRef.current = null;
  }, [flushStreamBuffer]);

  const addToolMessage = useCallback((toolUse: any, toolResult: any) => {
    const message: DisplayMessage = {
      id: generateId(),
      role: 'tool_use',
      toolUse,
      toolResult,
      timestamp: Date.now(),
    };
    setMessages(prev => [...prev, message]);
  }, []);

  const addSystemMessage = useCallback((content: string, variant: SystemMessageVariant = 'info') => {
    const message: DisplayMessage = {
      id: generateId(),
      role: 'system',
      content,
      variant,
      timestamp: Date.now(),
    };
    setMessages(prev => [...prev, message]);
  }, []);

  const clearMessages = useCallback(() => {
    setMessages([]);
    streamBufferRef.current = '';
    streamingMessageIdRef.current = null;
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
  }, []);

  return {
    messages,
    addUserMessage,
    addAssistantPlaceholder,
    appendStreamText,
    finalizeAssistantMessage,
    addToolMessage,
    addSystemMessage,
    clearMessages,
  };
}
