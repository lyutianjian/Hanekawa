export type ThemeName = 'dark' | 'light'
export type ThemeSetting = ThemeName | 'auto'

export type Theme = {
  text: string
  inactive: string
  claude: string
  claudeShimmer: string
  success: string
  error: string
  warning: string
  suggestion: string
  permission: string
  border: string
  background: string
}

export const DARK_THEME: Theme = {
  text: '#e0e0e0',
  inactive: '#808080',
  claude: '#cc785c',
  claudeShimmer: '#e8a87c',
  success: '#4caf50',
  error: '#f44336',
  warning: '#ff9800',
  suggestion: '#64b5f6',
  permission: '#d4a853',
  border: '#555555',
  background: '#1a1a1a',
}

export const LIGHT_THEME: Theme = {
  text: '#333333',
  inactive: '#999999',
  claude: '#cc785c',
  claudeShimmer: '#e8a87c',
  success: '#2e7d32',
  error: '#c62828',
  warning: '#e65100',
  suggestion: '#1565c0',
  permission: '#8b6914',
  border: '#cccccc',
  background: '#ffffff',
}

export function getTheme(name: ThemeName): Theme {
  return name === 'light' ? LIGHT_THEME : DARK_THEME
}
