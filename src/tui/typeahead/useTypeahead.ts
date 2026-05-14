import { useState, useEffect, useCallback, useRef } from 'react'
import { getSuggestions } from './suggestions.js'
import type { Suggestion } from './suggestions.js'

const DEBOUNCE_MS = 150

export function useTypeahead(input: string, cwd: string) {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [isOpen, setIsOpen] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null)

  useEffect(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
    }

    if (!input.trim()) {
      setSuggestions([])
      setIsOpen(false)
      return
    }

    debounceTimerRef.current = setTimeout(async () => {
      const newSuggestions = await getSuggestions(input, cwd)
      setSuggestions(newSuggestions)
      setIsOpen(newSuggestions.length > 0)
      setSelectedIndex(0)
    }, DEBOUNCE_MS)

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
      }
    }
  }, [input, cwd])

  const navigateUp = useCallback(() => {
    setSelectedIndex(prev =>
      prev > 0 ? prev - 1 : suggestions.length - 1
    )
  }, [suggestions.length])

  const navigateDown = useCallback(() => {
    setSelectedIndex(prev =>
      prev < suggestions.length - 1 ? prev + 1 : 0
    )
  }, [suggestions.length])

  const acceptSuggestion = useCallback(() => {
    if (suggestions[selectedIndex]) {
      return suggestions[selectedIndex].value
    }
    return null
  }, [suggestions, selectedIndex])

  const close = useCallback(() => {
    setIsOpen(false)
  }, [])

  return {
    suggestions,
    isOpen,
    selectedIndex,
    navigateUp,
    navigateDown,
    acceptSuggestion,
    close,
  }
}
