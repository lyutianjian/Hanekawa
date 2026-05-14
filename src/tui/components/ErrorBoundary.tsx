import React, { Component, ErrorInfo, ReactNode } from 'react'
import { Box, Text, useInput } from 'ink'

const MAX_RETRIES = 3

interface Props {
  children: ReactNode
  fallback?: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
  errorInfo: ErrorInfo | null
  retryCount: number
}

function ErrorFallback({ error, onRetry, retryCount }: { error: Error; onRetry: () => void; retryCount: number }) {
  useInput((input, key) => {
    if ((key.return || input === 'r') && retryCount < MAX_RETRIES) {
      onRetry()
    }
  })

  const canRetry = retryCount < MAX_RETRIES

  return (
    <Box flexDirection="column" padding={1} borderStyle="round" borderColor="red">
      <Text color="red" bold>
        ⚠ Something went wrong
      </Text>
      <Text color="red">
        {error.message}
      </Text>
      <Box marginTop={1}>
        {canRetry ? (
          <Text color="gray">
            Press Enter or 'r' to retry ({MAX_RETRIES - retryCount} attempts remaining)
          </Text>
        ) : (
          <Text color="red">
            Maximum retries reached. Type /clear to reset.
          </Text>
        )}
      </Box>
    </Box>
  )
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
      retryCount: 0,
    }
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return {
      hasError: true,
      error,
    }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    this.setState({
      errorInfo,
    })
    console.error('ErrorBoundary caught:', error, errorInfo)
  }

  handleRetry = () => {
    this.setState(prevState => ({
      hasError: false,
      error: null,
      errorInfo: null,
      retryCount: prevState.retryCount + 1,
    }))
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback
      }

      return (
        <ErrorFallback
          error={this.state.error!}
          onRetry={this.handleRetry}
          retryCount={this.state.retryCount}
        />
      )
    }

    return this.props.children
  }
}
