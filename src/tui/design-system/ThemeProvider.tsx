import React, { createContext, useContext, useState } from 'react'
import { type Theme, type ThemeName, type ThemeSetting, getTheme } from './theme.js'

type ThemeContextValue = {
  themeSetting: ThemeSetting
  setThemeSetting: (setting: ThemeSetting) => void
  currentTheme: Theme
}

const ThemeContext = createContext<ThemeContextValue | null>(null)
const DEFAULT_THEME: ThemeName = 'dark'

type ThemeProviderProps = {
  children: React.ReactNode
  initialTheme?: ThemeSetting
}

export function ThemeProvider({ children, initialTheme }: ThemeProviderProps) {
  const [themeSetting, setThemeSetting] = useState<ThemeSetting>(initialTheme ?? DEFAULT_THEME)
  const resolvedName: ThemeName = themeSetting === 'auto' ? DEFAULT_THEME : themeSetting
  const currentTheme = getTheme(resolvedName)

  return (
    <ThemeContext.Provider value={{ themeSetting, setThemeSetting, currentTheme }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme(): [Theme, (setting: ThemeSetting) => void] {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider')
  return [ctx.currentTheme, ctx.setThemeSetting]
}

export function useThemeSetting(): ThemeSetting {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useThemeSetting must be used within ThemeProvider')
  return ctx.themeSetting
}
