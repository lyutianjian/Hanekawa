import React, { Component, ErrorInfo, ReactNode } from 'react';
import { Box, Text, useInput } from 'ink';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
  retryCount: number;
}

function ErrorFallback({ error, onRetry }: { error: Error; onRetry: () => void }) {
  useInput((input, key) => {
    if (key.return || input === 'r') {
      onRetry();
    }
  });

  return (
    <Box flexDirection="column" padding={1} borderStyle="round" borderColor="error">
      <Text color="error" bold>
        ⚠ Something went wrong
      </Text>
      <Text color="error" dimColor>
        {error.message}
      </Text>
      <Box marginTop={1}>
        <Text color="dimmed">
          Press Enter or 'r' to retry, or type /clear to reset
        </Text>
      </Box>
    </Box>
  );
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
      retryCount: 0,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return {
      hasError: true,
      error,
    };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    this.setState({
      errorInfo,
    });
    console.error('ErrorBoundary caught:', error, errorInfo);
  }

  handleRetry = () => {
    this.setState(prevState => ({
      hasError: false,
      error: null,
      errorInfo: null,
      retryCount: prevState.retryCount + 1,
    }));
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <ErrorFallback
          error={this.state.error!}
          onRetry={this.handleRetry}
        />
      );
    }

    return this.props.children;
  }
}
