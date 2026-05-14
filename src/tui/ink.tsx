// 复刻自 ClaudeCode/src/ink.ts
// 自动包裹 ThemeProvider

import React, { createElement, type ReactNode } from 'react'
import { render as inkRender, type RenderOptions, type Instance } from 'ink'
import { ThemeProvider } from './design-system/ThemeProvider.js'

function withTheme(node: ReactNode): ReactNode {
  return createElement(ThemeProvider, null, node)
}

export function render(node: ReactNode, options?: RenderOptions): Instance {
  return inkRender(withTheme(node), options)
}

// 重导出主题化组件
export { ThemedBox as Box } from './design-system/ThemedBox.js'
export { ThemedText as Text } from './design-system/ThemedText.js'
export { useTheme, useThemeSetting } from './design-system/ThemeProvider.js'

// 重导出 Ink 原语
export { useInput, useApp, useStdin, useWindowSize } from 'ink'
