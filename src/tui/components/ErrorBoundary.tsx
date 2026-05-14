import React, { Component, type ReactNode } from 'react'
import { Box, Text } from '../ink.js'

type Props = {
  children: ReactNode
  fallback?: ReactNode
}

type State = {
  hasError: boolean
  error?: Error
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error) {
    console.error('TUI Error:', error)
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback || (
        <Box flexDirection="column" padding={1}>
          <Text color="red" bold>Something went wrong</Text>
          <Text dimColor>{this.state.error?.message}</Text>
          <Box marginTop={1}>
            <Text dimColor>Press Ctrl+C to exit</Text>
          </Box>
        </Box>
      )
    }

    return this.props.children
  }
}
