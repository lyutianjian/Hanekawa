import { createContext, useContext, useState, useEffect, useCallback } from 'react'
import type { ReactNode } from 'react'

export type ThemeMode = 'light' | 'dark' | 'auto'
export type ResolvedTheme = 'light' | 'dark'

export interface ThemeColors {
  // Message colors
  userMessage: string
  assistantMessage: string
  systemMessage: string

  // Accent colors
  accent: string
  error: string
  warning: string
  success: string

  // UI elements
  border: string
  spinner: string
  prompt: string
  dimmed: string
  background: string
  foreground: string

  // Interactive
  hoverBorder: string
  selectedBackground: string

  // Claude Code style colors
  claude: string
  claudeShimmer: string
  subtle: string
}

const darkColors: ThemeColors = {
  userMessage: '#E2E8F0',
  assistantMessage: '#F8F8F2',
  systemMessage: '#6C7086',

  accent: '#89B4FA',
  error: '#F38BA8',
  warning: '#FAB387',
  success: '#A6E3A1',

  border: '#45475A',
  spinner: '#89B4FA',
  prompt: '#89B4FA',
  dimmed: '#585B70',
  background: '#1E1E2E',
  foreground: '#CDD6F4',

  hoverBorder: '#585B70',
  selectedBackground: '#313244',

  // Claude Code style colors
  claude: '#D4A574',
  claudeShimmer: '#E8C9A0',
  subtle: '#6C7086',
}

const lightColors: ThemeColors = {
  userMessage: '#4C4F69',
  assistantMessage: '#1E1E2E',
  systemMessage: '#8C8FA1',

  accent: '#1E66F5',
  error: '#D20F39',
  warning: '#FE640B',
  success: '#40A02B',

  border: '#CCD0DA',
  spinner: '#1E66F5',
  prompt: '#1E66F5',
  dimmed: '#9CA0B0',
  background: '#EFF1F5',
  foreground: '#4C4F69',

  hoverBorder: '#ACB0BE',
  selectedBackground: '#E6E9EF',

  // Claude Code style colors
  claude: '#8B6914',
  claudeShimmer: '#A67C00',
  subtle: '#9399B2',
}

interface ThemeContextValue {
  mode: ThemeMode
  resolvedTheme: ResolvedTheme
  colors: ThemeColors
  setMode: (mode: ThemeMode) => void
}

function detectTerminalTheme(): 'light' | 'dark' {
  const colorfgbg = process.env.COLORFGBG;
  if (colorfgbg) {
    const bg = colorfgbg.split(';').pop();
    if (bg && parseInt(bg) < 6) return 'dark';
    if (bg && parseInt(bg) >= 6) return 'light';
  }
  return 'dark';
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

interface ThemeProviderProps {
  children: ReactNode
  defaultMode?: ThemeMode
}

export function ThemeProvider({ children, defaultMode = 'dark' }: ThemeProviderProps) {
  const [mode, setMode] = useState<ThemeMode>(defaultMode)
  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>(() => {
    if (defaultMode === 'auto') return detectTerminalTheme();
    return defaultMode;
  })

  useEffect(() => {
    if (mode === 'auto') {
      setResolvedTheme(detectTerminalTheme())
    } else {
      setResolvedTheme(mode)
    }
  }, [mode])

  const colors = resolvedTheme === 'dark' ? darkColors : lightColors

  const value: ThemeContextValue = {
    mode,
    resolvedTheme,
    colors,
    setMode: useCallback((newMode: ThemeMode) => setMode(newMode), []),
  }

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) {
    // Return default dark theme if used outside provider
    return {
      mode: 'dark',
      resolvedTheme: 'dark',
      colors: darkColors,
      setMode: () => {},
    }
  }
  return ctx
}

export { darkColors, lightColors }
export type { ThemeContextValue }
