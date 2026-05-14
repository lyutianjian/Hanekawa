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
  text: '#e8e8e8',
  inactive: '#888888',
  claude: '#cc785c',
  claudeShimmer: '#e8a87c',
  success: '#50fa7b',
  error: '#ff5555',
  warning: '#f1fa8c',
  suggestion: '#8be9fd',
  permission: '#f1fa8c',
  border: '#666666',
  background: '#1e1e1e',
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
