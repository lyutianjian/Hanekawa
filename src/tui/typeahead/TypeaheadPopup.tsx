import React from 'react'
import { Box, Text } from 'ink'
import { Suggestion } from './suggestions.js'

interface TypeaheadPopupProps {
  suggestions: Suggestion[]
  selectedIndex: number
}

export function TypeaheadPopup({ suggestions, selectedIndex }: TypeaheadPopupProps) {
  if (suggestions.length === 0) return null

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
    >
      {suggestions.map((suggestion, index) => (
        <Box key={suggestion.value} flexDirection="row">
          <Text color={index === selectedIndex ? 'cyan' : 'gray'}>
            {index === selectedIndex ? '> ' : '  '}
          </Text>
          <Text
            color={index === selectedIndex ? 'white' : 'gray'}
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
