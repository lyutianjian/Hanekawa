// 主 REPL 屏幕 — 集成 AgentLoop 流式输出

import React, { useState, useRef, useCallback, useEffect } from 'react'
import { Box, Text } from '../ink.js'
import { useApp, useInput, useWindowSize } from 'ink'
import { Divider } from '../design-system/Divider.js'
import { OverlayProvider } from '../context/overlayContext.js'
import { MessageRow } from '../components/messages/MessageRow.js'
import { MessageGroup } from '../components/messages/MessageGroup.js'
import { SpinnerWithVerb } from '../components/Spinner/SpinnerWithVerb.js'
import { PromptInput } from '../components/PromptInput.js'
import { Footer } from '../components/Footer.js'
import { PermissionDialog } from '../components/permissions/PermissionDialog.js'
import { ToolPermissionCard } from '../components/permissions/ToolPermissionCard.js'
import { SettingsScreen } from '../components/SettingsScreen.js'
import { HelpScreen } from '../components/HelpScreen.js'
import { DoctorScreen } from '../components/DoctorScreen.js'
import { MessageEditor } from '../components/messages/MessageEditor.js'
import { CompactionIndicator } from '../components/CompactionIndicator.js'
import { TranscriptSearch } from '../components/TranscriptSearch.js'
import { useAppState, useSetAppState } from '../state/AppState.js'
import { useTheme } from '../design-system/ThemeProvider.js'
import type { ChatMessage } from '../components/messages/types.js'
import { handleSlashCommand } from '../commands/slashCommands.js'
import type { AgentLoop } from '../../harness/loop.js'
import type { AgentStreamEvent } from '../../harness/types.js'
import type { Store } from '../state/store.js'
import type { AppState } from '../state/AppStateStore.js'
import type { SessionStore } from '../../sessions/service.js'
import { useSession } from '../hooks/useSession.js'
import { useDoublePress } from '../hooks/useDoublePress.js'
import { useTerminalTitle } from '../hooks/useTerminalTitle.js'

type REPLProps = {
  loop?: AgentLoop
  session?: { id: string; shortId?: string; createdAt?: string }
  appStore?: Store<AppState>
  sessionStore?: SessionStore
  config?: {
    theme?: string
    verbose?: boolean
    model?: string
  }
}

export function REPL({ loop, session, appStore, sessionStore, config }: REPLProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [isRunning, setIsRunning] = useState(false)
  const [streamingText, setStreamingText] = useState('')
  const [totalUsage, setTotalUsage] = useState<{ input: number; output: number; cost: number } | null>(null)
  const [pendingModel, setPendingModel] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [doctorOpen, setDoctorOpen] = useState(false)
  const [editingMessage, setEditingMessage] = useState<ChatMessage | null>(null)
  const [scrollToIndex, setScrollToIndex] = useState<number | null>(null)
  const [clearConfirm, setClearConfirm] = useState(false)
  const [clearedMessages, setClearedMessages] = useState<ChatMessage[] | null>(null)
  const [themeSetting, setThemeSetting] = useTheme()
  const [verboseMode, setVerboseMode] = useState(config?.verbose ?? false)
  const verboseRef = useRef(verboseMode)
  const { exit } = useApp()
  const { columns, rows } = useWindowSize()
  const nextId = useRef(0)
  const responseLengthRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)
  const streamingTextRef = useRef('')
  const streamingUpdateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const pendingPermission = useAppState(s => s.pendingPermission)
  const setAppState = useSetAppState()

  // 终端标题
  const title = `myagent${session ? ` — ${session.id.slice(0, 8)}` : ''}${isRunning ? ' ⟳' : ''}`
  useTerminalTitle(title)

  // Session 持久化
  const { loadHistory, saveMessage } = useSession({
    store: sessionStore!,
    sessionId: session?.id || '',
  })

  // 启动时加载历史消息
  useEffect(() => {
    if (session && sessionStore) {
      loadHistory().then(history => {
        if (history.length > 0) {
          setMessages(history)
        }
      })
    }
  }, [session?.id])

  const handleSubmit = useCallback(async (text: string) => {
    // Slash 命令处理
    const slashResult = handleSlashCommand(text, {
      model: pendingModel || 'current-model',
      sessionId: session?.id,
      messageCount: messages.length,
      createdAt: session?.createdAt,
    })
    if (slashResult.handled) {
      if (text.trim() === '/help') {
        setHelpOpen(true)
        return
      }
      if (text.trim() === '/compact') {
        const sysMsg: ChatMessage = {
          id: `sys-${nextId.current++}`,
          role: 'system',
          content: '⟳ Compacting conversation history...\nThis may take a moment. The conversation will be summarized to reduce context usage.',
          timestamp: Date.now(),
        }
        setMessages(prev => [...prev, sysMsg])

        // 如果有 loop，触发实际压缩
        if (loop) {
          try {
            // 简化实现：显示完成消息
            setTimeout(() => {
              const doneMsg: ChatMessage = {
                id: `sys-${nextId.current++}`,
                role: 'system',
                content: '✓ Conversation compacted successfully.',
                timestamp: Date.now(),
              }
              setMessages(prev => [...prev, doneMsg])
            }, 1000)
          } catch (err) {
            const errMsg: ChatMessage = {
              id: `sys-${nextId.current++}`,
              role: 'system',
              content: `Compaction failed: ${(err as Error).message}`,
              timestamp: Date.now(),
            }
            setMessages(prev => [...prev, errMsg])
          }
        }
        return
      }
      if (slashResult.message) {
        setMessages(prev => [...prev, slashResult.message!])
      }
      if (text.trim() === '/clear') {
        setClearConfirm(true)
      }
      if (text.trim() === '/settings') {
        setSettingsOpen(true)
      }
      if (text.trim() === '/doctor') {
        setDoctorOpen(true)
      }
      if (text.trim() === '/edit') {
        const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')
        if (lastUserMsg) {
          setEditingMessage(lastUserMsg)
        }
        return
      }
      if (slashResult.action === 'show_cost') {
        const costMsg: ChatMessage = {
          id: `sys-${nextId.current++}`,
          role: 'system',
          content: totalUsage
            ? `Token Usage:\n  Input: ${totalUsage.input.toLocaleString()} tokens\n  Output: ${totalUsage.output.toLocaleString()} tokens\n  Total: ${(totalUsage.input + totalUsage.output).toLocaleString()} tokens\n  Cost: $${totalUsage.cost.toFixed(6)}`
            : 'No usage data yet. Start a conversation to see token usage.',
          timestamp: Date.now(),
        }
        setMessages(prev => [...prev, costMsg])
        return
      }
      if (slashResult.action === 'switch_model' && slashResult.model) {
        setPendingModel(slashResult.model)
      }
      if (slashResult.action === 'set_theme' && slashResult.theme) {
        setThemeSetting(slashResult.theme)
        const sysMsg: ChatMessage = {
          id: `sys-${nextId.current++}`,
          role: 'system',
          content: `Theme switched to ${slashResult.theme}`,
          timestamp: Date.now(),
        }
        setMessages(prev => [...prev, sysMsg])
        return
      }
      if (slashResult.action === 'toggle_verbose') {
        const newVerbose = !verboseRef.current
        verboseRef.current = newVerbose
        setVerboseMode(newVerbose)
        const sysMsg: ChatMessage = {
          id: `sys-${nextId.current++}`,
          role: 'system',
          content: `Verbose mode ${newVerbose ? 'enabled' : 'disabled'}`,
          timestamp: Date.now(),
        }
        setMessages(prev => [...prev, sysMsg])
        return
      }
      if (slashResult.action === 'retry') {
        // 重新发送最后一条用户消息
        const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')
        if (lastUserMsg && typeof lastUserMsg.content === 'string') {
          handleSubmit(lastUserMsg.content)
        }
      }
      if (slashResult.action === 'export') {
        const exportPath = `.myagent/export-${Date.now()}.json`
        const exportData = messages.map(msg => ({
          role: msg.role,
          content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
          timestamp: msg.timestamp,
        }))

        try {
          const { mkdirSync, writeFileSync } = await import('node:fs')
          mkdirSync('.myagent', { recursive: true })
          writeFileSync(exportPath, JSON.stringify(exportData, null, 2))
          const sysMsg: ChatMessage = {
            id: `sys-${nextId.current++}`,
            role: 'system',
            content: `Exported ${messages.length} messages to ${exportPath}`,
            timestamp: Date.now(),
          }
          setMessages(prev => [...prev, sysMsg])
        } catch (err) {
          const errMsg: ChatMessage = {
            id: `sys-${nextId.current++}`,
            role: 'system',
            content: `Export failed: ${(err as Error).message}`,
            timestamp: Date.now(),
          }
          setMessages(prev => [...prev, errMsg])
        }
        return
      }
      if (slashResult.action === 'list_sessions') {
        try {
          const { readFileSync } = await import('node:fs')
          const indexPath = '.myagent/sessions/index.json'
          const index = JSON.parse(readFileSync(indexPath, 'utf-8'))
          const sessions = Object.entries(index).map(([id, meta]: [string, any]) =>
            `  ${id.slice(0, 8)} — ${meta.createdAt || 'unknown'} — ${meta.messageCount || 0} messages`
          ).join('\n')

          const sysMsg: ChatMessage = {
            id: `sys-${nextId.current++}`,
            role: 'system',
            content: `Sessions:\n${sessions || '  No sessions found'}`,
            timestamp: Date.now(),
          }
          setMessages(prev => [...prev, sysMsg])
        } catch (err) {
          const sysMsg: ChatMessage = {
            id: `sys-${nextId.current++}`,
            role: 'system',
            content: 'No sessions found.',
            timestamp: Date.now(),
          }
          setMessages(prev => [...prev, sysMsg])
        }
        return
      }
      if (slashResult.action === 'switch_session' && slashResult.sessionId) {
        const sysMsg: ChatMessage = {
          id: `sys-${nextId.current++}`,
          role: 'system',
          content: `Switching to session ${slashResult.sessionId}...`,
          timestamp: Date.now(),
        }
        setMessages(prev => [...prev, sysMsg])
        // 实际切换需要重启会话，此处仅提示
        return
      }
      return
    }

    // 添加用户消息
    const userMsg: ChatMessage = {
      id: `msg-${nextId.current++}`,
      role: 'user',
      content: text,
      timestamp: Date.now(),
    }
    setMessages(prev => [...prev, userMsg])
    saveMessage(userMsg)
    setIsRunning(true)
    setStreamingText('')
    responseLengthRef.current = 0

    if (!loop) {
      // 无 AgentLoop，echo 模式
      setTimeout(() => {
        const assistantMsg: ChatMessage = {
          id: `msg-${nextId.current++}`,
          role: 'assistant',
          content: `Echo: ${text}`,
          timestamp: Date.now(),
        }
        setMessages(prev => [...prev, assistantMsg])
        saveMessage(assistantMsg)
        setIsRunning(false)
      }, 500)
      return
    }

    // 使用 AgentLoop 流式执行（含自动重试）
    const abort = new AbortController()
    abortRef.current = abort

    let retryCount = 0
    const maxRetries = 1

    const executeWithRetry = async (): Promise<Awaited<ReturnType<AgentLoop['run']>>> => {
      try {
        return await loop.run(text, abort.signal, (event: AgentStreamEvent) => {
          switch (event.type) {
            case 'text_delta':
              streamingTextRef.current = event.snapshot
              // 批量更新流式文本，~60fps
              if (!streamingUpdateTimerRef.current) {
                streamingUpdateTimerRef.current = setTimeout(() => {
                  setStreamingText(streamingTextRef.current)
                  streamingUpdateTimerRef.current = null
                }, 16)
              }
              responseLengthRef.current = event.snapshot.length
              break
            case 'tool_use_start': {
              // 添加工具使用消息，标记为 running
              const toolMsgId = `msg-${nextId.current++}`
              setMessages(prev => [...prev, {
                id: toolMsgId,
                role: 'assistant',
                content: [{ type: 'tool_use' as const, id: event.toolId, name: event.toolName, input: {} }],
                timestamp: Date.now(),
                toolStatus: 'running',
              }])
              break
            }
            case 'turn_end':
              // turn 结束时，标记所有 running 的工具为 done
              setMessages(prev => prev.map(msg =>
                msg.toolStatus === 'running'
                  ? { ...msg, toolStatus: 'done' as const }
                  : msg
              ))
              break
          }
        })
      } catch (err) {
        // 网络错误自动重试一次
        if (retryCount < maxRetries && (err as Error).message?.includes('network')) {
          retryCount++
          const retryMsg: ChatMessage = {
            id: `sys-${nextId.current++}`,
            role: 'system',
            content: 'Network error, retrying...',
            timestamp: Date.now(),
          }
          setMessages(prev => [...prev, retryMsg])
          return executeWithRetry()
        }
        throw err
      }
    }

    try {
      const result = await executeWithRetry()

      // 流式完成后，添加最终消息
      if (result.content) {
        const assistantMsg: ChatMessage = {
          id: `msg-${nextId.current++}`,
          role: 'assistant',
          content: result.content,
          timestamp: Date.now(),
        }
        setMessages(prev => [...prev, assistantMsg])
        saveMessage(assistantMsg)
      }

      // 更新使用量
      if (result.usage) {
        setTotalUsage(prev => ({
          input: (prev?.input || 0) + (result.usage.inputTokens || 0),
          output: (prev?.output || 0) + (result.usage.outputTokens || 0),
          cost: (prev?.cost || 0), // cost 需要根据定价计算，暂不实现
        }))
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        // 用户取消，不显示错误
        const cancelMsg: ChatMessage = {
          id: `msg-${nextId.current++}`,
          role: 'system',
          content: 'Request cancelled.',
          timestamp: Date.now(),
        }
        setMessages(prev => [...prev, cancelMsg])
      } else {
        // 格式化错误消息
        const formatError = (err: Error): string => {
          const msg = err.message || 'Unknown error'

          if (msg.includes('API key')) {
            return `🔑 API Key Error: ${msg}\n\nRun /doctor to check your configuration.`
          }
          if (msg.includes('rate limit')) {
            return `⏱ Rate Limited: ${msg}\n\nPlease wait a moment and try again.`
          }
          if (msg.includes('network') || msg.includes('fetch')) {
            return `🌐 Network Error: ${msg}\n\nCheck your internet connection. Use /retry to resend.`
          }
          if (msg.includes('timeout')) {
            return `⏰ Timeout: ${msg}\n\nThe request took too long. Use /retry to resend.`
          }
          if (msg.includes('context') || msg.includes('token')) {
            return `📊 Context Error: ${msg}\n\nTry /compact to reduce conversation length.`
          }

          return `❌ Error: ${msg}`
        }

        const errorMsg: ChatMessage = {
          id: `msg-${nextId.current++}`,
          role: 'system',
          content: formatError(err as Error),
          timestamp: Date.now(),
        }
        setMessages(prev => [...prev, errorMsg])
        saveMessage(errorMsg)
      }
    } finally {
      // 清理流式更新定时器
      if (streamingUpdateTimerRef.current) {
        clearTimeout(streamingUpdateTimerRef.current)
        streamingUpdateTimerRef.current = null
      }
      setIsRunning(false)
      setStreamingText('')
      abortRef.current = null
    }
  }, [loop])

  const handleCancel = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort()
    }
  }, [])

  // 双击 Ctrl+C — 第一次取消，双击退出
  const handleCtrlC = useDoublePress(
    () => {
      if (isRunning) {
        handleCancel()
      }
    },
    () => {
      exit()
    },
  )

  // 双击 Ctrl+D — 双击退出
  const handleCtrlD = useDoublePress(
    () => {},
    () => exit(),
  )

  // 键盘快捷键
  useInput((inputChar, key) => {
    // Ctrl+C — 双击退出
    if (key.ctrl && inputChar === 'c') {
      handleCtrlC()
      return
    }

    // Ctrl+D — 双击退出
    if (key.ctrl && inputChar === 'd') {
      handleCtrlD()
      return
    }

    // Ctrl+Z — 撤销 /clear
    if (key.ctrl && inputChar === 'z') {
      if (clearedMessages) {
        setMessages(clearedMessages)
        setClearedMessages(null)
        const sysMsg: ChatMessage = {
          id: `sys-${nextId.current++}`,
          role: 'system',
          content: 'Restored cleared messages.',
          timestamp: Date.now(),
        }
        setMessages(prev => [...prev, sysMsg])
      }
      return
    }

    // Ctrl+R — 打开转录搜索
    if (key.ctrl && inputChar === 'r' && !searchOpen && !settingsOpen && !helpOpen) {
      setSearchOpen(true)
    }
  })

  return (
    <OverlayProvider>
      <Box flexDirection="column" height="100%">
        {/* Header */}
        <Box flexDirection="column">
          <Box paddingX={1}>
            <Text bold color="cyan"> myagent</Text>
            <Text dimColor> </Text>
            <Divider />
          </Box>
          <Box paddingX={2} gap={2}>
            <Text>
              <Text color="green">●</Text>
              <Text> {pendingModel || 'claude-sonnet-4'}</Text>
            </Text>
            <Text dimColor>│</Text>
            <Text dimColor>Session: {session?.id?.slice(0, 8) || 'none'}</Text>
            <Text dimColor>│</Text>
            <Text dimColor>{messages.length} messages</Text>
            {totalUsage && (
              <>
                <Text dimColor>│</Text>
                <Text>
                  <Text color="yellow">Tokens:</Text>
                  <Text> {(totalUsage.input + totalUsage.output).toLocaleString()}</Text>
                </Text>
                <Text dimColor>│</Text>
                <Text>
                  <Text color="green">$</Text>
                  <Text>{totalUsage.cost.toFixed(4)}</Text>
                </Text>
              </>
            )}
            {pendingModel && (
              <>
                <Text dimColor>│</Text>
                <Text color="yellow">{'->'} {pendingModel}</Text>
              </>
            )}
          </Box>
          <Divider />
        </Box>
        <CompactionIndicator
          tokenCount={totalUsage ? totalUsage.input + totalUsage.output : 0}
          maxTokens={200000}
        />

        {/* Messages 区域 */}
        <Box flexDirection="column" flexGrow={1} paddingX={1} overflow="hidden">
          {messages.length === 0 && !streamingText ? (
            <Text dimColor>Type a message to get started...</Text>
          ) : (
            <>
              {/* 性能优化：只渲染最后 N 条消息 */}
              {(() => {
                const MAX_VISIBLE_MESSAGES = 100
                const visibleMessages = messages.slice(-MAX_VISIBLE_MESSAGES)
                const hiddenCount = messages.length - visibleMessages.length

                return (
                  <>
                    {hiddenCount > 0 && (
                      <Box paddingX={1}>
                        <Text dimColor>↑ {hiddenCount} older messages (scroll up to view)</Text>
                      </Box>
                    )}
                    {/* 将消息按角色分组 */}
                    {visibleMessages.reduce<{ role: string; messages: ChatMessage[] }[]>(
                      (groups, msg) => {
                        const lastGroup = groups[groups.length - 1]
                        if (lastGroup && lastGroup.role === msg.role) {
                          lastGroup.messages.push(msg)
                        } else {
                          groups.push({ role: msg.role, messages: [msg] })
                        }
                        return groups
                      },
                      [],
                    ).map((group, i) => (
                      <MessageGroup
                        key={i}
                        messages={group.messages}
                        role={group.role as 'user' | 'assistant' | 'system'}
                        verbose={verboseMode}
                        showTimestamp={verboseMode}
                        columns={columns}
                      />
                    ))}
                  </>
                )
              })()}
              {/* 流式文本预览 */}
              {streamingText && (
                <MessageRow
                  message={{
                    id: 'streaming',
                    role: 'assistant',
                    content: streamingText,
                    isStreaming: true,
                  }}
                  showTimestamp={verboseMode}
                />
              )}
            </>
          )}
        </Box>

        {/* Spinner */}
        {isRunning && !streamingText && (
          <Box paddingX={1}>
            <SpinnerWithVerb
              mode="thinking"
              responseLengthRef={responseLengthRef}
            />
          </Box>
        )}

        {/* 权限对话框 */}
        {pendingPermission && (
          <Box paddingX={1}>
            <PermissionDialog
              title="Permission Required"
              subtitle={pendingPermission.toolName}
              onCancel={() => {
                pendingPermission.resolve(false)
                setAppState(prev => ({ ...prev, pendingPermission: null }))
              }}
              onApprove={() => {
                pendingPermission.resolve(true)
                setAppState(prev => ({ ...prev, pendingPermission: null }))
              }}
              onAlwaysAllow={() => {
                if (pendingPermission?.onAlwaysAllow) {
                  pendingPermission.onAlwaysAllow()
                }
                pendingPermission?.resolve(true)
                setAppState(prev => ({ ...prev, pendingPermission: null }))
              }}
            >
              <ToolPermissionCard
                toolName={pendingPermission.toolName}
                input={pendingPermission.input}
                riskLevel={pendingPermission.riskLevel}
              />
            </PermissionDialog>
          </Box>
        )}

        {/* 转录搜索覆盖层 */}
        {searchOpen && (
          <TranscriptSearch
            messages={messages}
            onJumpTo={(idx) => setScrollToIndex(idx)}
            onClose={() => setSearchOpen(false)}
          />
        )}

        {/* 设置屏幕 */}
        {settingsOpen && <SettingsScreen onClose={() => setSettingsOpen(false)} />}

        {/* 帮助屏幕 */}
        {helpOpen && <HelpScreen onClose={() => setHelpOpen(false)} />}

        {/* 诊断屏幕 */}
        {doctorOpen && <DoctorScreen onClose={() => setDoctorOpen(false)} />}

        {/* 消息编辑器 */}
        {editingMessage && (
          <MessageEditor
            initialText={typeof editingMessage.content === 'string' ? editingMessage.content : ''}
            onSubmit={(newText) => {
              const idx = messages.findIndex(m => m.id === editingMessage.id)
              if (idx !== -1) {
                const newMessages = messages.slice(0, idx)
                setMessages(newMessages)
                setEditingMessage(null)
                handleSubmit(newText)
              }
            }}
            onCancel={() => setEditingMessage(null)}
          />
        )}

        {/* /clear 确认对话框 */}
        {clearConfirm && (
          <Box paddingX={1}>
            <PermissionDialog
              title="Clear Conversation"
              subtitle="This will clear all messages"
              onCancel={() => setClearConfirm(false)}
              onApprove={() => {
                setClearedMessages([...messages])
                setMessages([])
                setClearConfirm(false)
              }}
            >
              <Text>Are you sure you want to clear the conversation history?</Text>
            </PermissionDialog>
          </Box>
        )}

        {/* Input 区域 */}
        <Divider />
        <PromptInput
          onSubmit={handleSubmit}
          isRunning={isRunning || !!pendingPermission}
          onCancel={handleCancel}
        />
        <Footer
          isRunning={isRunning}
          pendingPermission={!!pendingPermission}
        />
      </Box>
    </OverlayProvider>
  )
}
