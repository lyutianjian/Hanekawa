import { Box, Text, useStdout } from 'ink'
import type { ThinkingBlock } from '../../harness/types.js'
import { theme } from '../theme.js'
import { THINKING_PREFIX, CONTENT_PREFIX, PREFIX_WIDTH } from '../constants/figures.js'
import { getSafeTerminalWidth } from '../layout.js'
import { Markdown } from './Markdown.js'
import { AssistantThinkingMessage } from './AssistantThinkingMessage.js'

interface AssistantMessageProps {
  content: string
  streamingContent?: string
  thinkingBlocks?: ThinkingBlock[]
  thinkingDurationMs?: number
  thinkingExpanded?: boolean
  thinkingPreview?: string
  isTranscriptMode?: boolean
}

export function AssistantMessage({ content, streamingContent, thinkingBlocks, thinkingDurationMs, thinkingExpanded = false, thinkingPreview, isTranscriptMode = false }: AssistantMessageProps) {
  const { stdout } = useStdout()
  const width = getSafeTerminalWidth(stdout?.columns)
  const hasContent = content.trim().length > 0
  const hasThinking = Boolean(thinkingBlocks?.length) || Boolean(thinkingPreview)
  if (!hasContent && !hasThinking) return null

  return (
    <Box flexDirection="column" marginY={1} width={width}>
      {hasThinking && (
        <Box flexDirection="row">
          <Box width={PREFIX_WIDTH} flexShrink={0}>
            <Text color={theme.subtleText}>{THINKING_PREFIX}</Text>
          </Box>
          <Box flexGrow={1}>
            <AssistantThinkingMessage blocks={thinkingBlocks ?? []} expanded={thinkingExpanded} thinkingDurationMs={thinkingDurationMs} thinkingPreview={thinkingPreview} isTranscriptMode={isTranscriptMode} />
          </Box>
        </Box>
      )}
      {(hasContent || streamingContent !== undefined) && (
        <Box flexDirection="column" marginTop={hasThinking ? 1 : 0}>
          <Box flexDirection="row">
            <Box width={PREFIX_WIDTH} flexShrink={0}>
              <Text color={theme.brand}>{CONTENT_PREFIX}</Text>
            </Box>
            <Box flexDirection="column" flexGrow={1} width={Math.max(1, width - PREFIX_WIDTH)}>
              <Markdown
                content={streamingContent !== undefined ? streamingContent : content}
                width={Math.max(1, width - PREFIX_WIDTH)}
              />
            </Box>
          </Box>
        </Box>
      )}
    </Box>
  )
}
