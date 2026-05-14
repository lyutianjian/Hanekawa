import { useState, useEffect, useCallback } from 'react'
import { getSuggestions } from './suggestions.js'
import type { Suggestion } from './suggestions.js'

interface UseTypeaheadResult {
  suggestions: Suggestion[]
  selectedIndex: number
  isOpen: boolean
  setSelectedIndex: (index: number) => void
  setIsOpen: (open: boolean) => void
  acceptSuggestion: () => Suggestion | null
  navigateUp: () => void
  navigateDown: () => void
}

export function useTypeahead(input: string, cwd: string): UseTypeaheadResult {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [isOpen, setIsOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    const fetchSuggestions = async () => {
      const newSuggestions = await getSuggestions(input, cwd)
      if (!cancelled) {
        setSuggestions(newSuggestions)
        setIsOpen(newSuggestions.length > 0)
        setSelectedIndex(0)
      }
    }

    if (input.startsWith('/') || input.includes('@') || input.match(/model\s+\w*$/i) || input.includes('$')) {
      fetchSuggestions()
    } else {
      setIsOpen(false)
    }

    return () => { cancelled = true }
  }, [input, cwd])

  const acceptSuggestion = useCallback((): Suggestion | null => {
    if (!isOpen || suggestions.length === 0) return null
    return suggestions[selectedIndex] ?? null
  }, [isOpen, suggestions, selectedIndex])

  const navigateUp = useCallback(() => {
    setSelectedIndex((prev) => (prev > 0 ? prev - 1 : suggestions.length - 1))
  }, [suggestions.length])

  const navigateDown = useCallback(() => {
    setSelectedIndex((prev) => (prev < suggestions.length - 1 ? prev + 1 : 0))
  }, [suggestions.length])

  return {
    suggestions,
    selectedIndex,
    isOpen,
    setSelectedIndex,
    setIsOpen,
    acceptSuggestion,
    navigateUp,
    navigateDown,
  }
}
