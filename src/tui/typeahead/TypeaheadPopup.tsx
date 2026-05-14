import React from 'react'
import { Box, Text } from 'ink'
import type { Suggestion } from './suggestions.js'

interface TypeaheadPopupProps {
  suggestions: Suggestion[]
  selectedIndex: number
  onSelect: (suggestion: Suggestion) => void
}

export function TypeaheadPopup({ suggestions, selectedIndex, onSelect: _onSelect }: TypeaheadPopupProps) {
  if (suggestions.length === 0) return null

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      {suggestions.map((suggestion, index) => (
        <Box key={suggestion.value} flexDirection="row">
          <Text color={index === selectedIndex ? 'cyan' : undefined}>
            {index === selectedIndex ? '> ' : '  '}
          </Text>
          <Text
            color={index === selectedIndex ? 'white' : undefined}
            bold={index === selectedIndex}
          >
            {suggestion.label}
          </Text>
          <Text color="gray">
            {' '}{suggestion.description}
          </Text>
        </Box>
      ))}
    </Box>
  )
}
