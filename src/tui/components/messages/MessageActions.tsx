import React, { useState } from 'react'
import { Box, Text } from '../../ink.js'
import { copyToClipboard } from '../../utils/clipboard.js'

type Props = {
  messageContent?: string
  onRetry?: () => void
  onClose: () => void
}

export function MessageActions({ messageContent, onRetry, onClose }: Props) {
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle')

  const handleCopy = async () => {
    if (messageContent) {
      const ok = await copyToClipboard(messageContent)
      setCopyStatus(ok ? 'copied' : 'failed')
      setTimeout(() => setCopyStatus('idle'), 2000)
    }
  }

  return (
    <Box paddingX={2} paddingY={1} flexDirection="column">
      <Text bold dimColor>Message Actions</Text>
      <Box marginTop={1}>
        {messageContent && (
          <Box>
            <Text color="cyan" bold>[c]</Text>
            <Text> {copyStatus === 'copied' ? 'Copied!' : copyStatus === 'failed' ? 'Failed' : 'Copy'}</Text>
            <Text dimColor>  </Text>
          </Box>
        )}
        {onRetry && (
          <Box>
            <Text color="cyan" bold>[r]</Text>
            <Text> Retry</Text>
            <Text dimColor>  </Text>
          </Box>
        )}
        <Box>
          <Text color="cyan" bold>[Esc]</Text>
          <Text> Close</Text>
        </Box>
      </Box>
    </Box>
  )
}
