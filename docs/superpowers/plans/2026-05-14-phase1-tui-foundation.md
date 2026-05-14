# Phase 1: TUI 基础设施层实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立 Ink + React 渲染管线、主题系统、设计原语、外部状态管理和键绑定框架

**Architecture:** 自定义 Ink 层包裹 ThemeProvider 自动注入，外部 store + useSyncExternalStore 管理状态，声明式上下文键绑定系统。参考 Claude Code 源码但做适当简化（不使用 React Compiler，不实现 OSC 11 自动主题检测）。

**Tech Stack:** react, ink, @types/react, @types/ink, figures, typescript, tsx

**参考源码根目录:** `C:\Users\Miyano\Documents\code\ClaudeCode\src\`

---

## 并行执行策略

本计划分为 3 个可并行的 Stream，由多个 subagent 同时执行：

```
Stream A (基础设施)          Stream B (键绑定)           Stream C (Overlay)
Task 1: 依赖安装             Task 5: 键绑定类型          Task 7: Overlay 上下文
Task 2: store.ts
Task 3: theme.ts + ThemeProvider
Task 4: ThemedBox + ThemedText
       ↓                          ↓                         ↓
Stream D (设计原语 + 集成)
Task 8: Divider + Pane + Dialog + StatusIcon
Task 9: REPL 骨架 + 入口点
Task 10: 端到端验证
```

Stream A/B/C 可完全并行。Stream D 依赖 A/B/C 全部完成。

---

## 文件结构

```
src/tui/
  ink.tsx                          -- 自定义 Ink 入口
  design-system/
    theme.ts                       -- 主题类型和色板
    ThemeProvider.tsx               -- 主题上下文
    ThemedBox.tsx                   -- 主题感知 Box
    ThemedText.tsx                  -- 主题感知 Text
    Dialog.tsx                      -- 对话框框架
    Pane.tsx                        -- 内容窗格
    Divider.tsx                     -- 水平分隔线
    StatusIcon.tsx                  -- 状态图标
    ListItem.tsx                    -- 列表项
    color.ts                        -- 颜色工具
  state/
    store.ts                        -- 通用外部 store
    AppState.tsx                    -- AppState Provider + hooks
    AppStateStore.ts                -- AppState 类型定义
  keybindings/
    types.ts                        -- 键绑定类型
    defaultBindings.ts              -- 默认绑定
    resolver.ts                     -- 用户覆盖解析
    useKeybinding.ts                -- 键绑定 hook
  context/
    overlayContext.tsx               -- Overlay 跟踪
  screens/
    REPL.tsx                        -- 主 REPL 屏幕
  entrypoints/
    tui.tsx                         -- 新入口点
```

---

## Stream A: 基础设施（4 个 Task）

### Task 1: 依赖安装与构建配置

**Files:**
- Modify: `package.json`
- Modify: `tsconfig.json`

- [ ] **Step 1: 安装依赖**

```bash
cd C:\Users\Miyano\Documents\code\myagent
npm install react ink figures
npm install -D @types/react @types/ink
```

- [ ] **Step 2: 更新 tsconfig.json**

在 `compilerOptions` 中添加 JSX 支持：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "jsx": "react-jsx",
    "types": ["node"],
    "outDir": "dist"
  },
  "include": ["src/**/*.ts", "src/**/*.tsx", "test/**/*.ts"]
}
```

- [ ] **Step 3: 更新 package.json scripts**

添加 TUI 入口脚本：

```json
{
  "scripts": {
    "dev": "tsx src/entrypoints/cli.ts",
    "dev:tui": "tsx src/tui/entrypoints/tui.tsx",
    "typecheck": "tsc --noEmit",
    "test": "node --import tsx --test test/**/*.test.ts"
  }
}
```

- [ ] **Step 4: 验证安装**

```bash
npm run typecheck
```

Expected: 无错误（新文件还未创建，不会报错）

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json tsconfig.json
git commit -m "chore: add react, ink, figures dependencies and enable JSX"
```

---

### Task 2: 外部 Store

**Files:**
- Create: `src/tui/state/store.ts`

**Claude Code 参考:** `ClaudeCode/src/state/store.ts`（34 行）— 直接复刻，逻辑完全一致

- [ ] **Step 1: 创建 store.ts**

```typescript
// src/tui/state/store.ts
// 复刻自 ClaudeCode/src/state/store.ts

type Listener = () => void
type OnChange<T> = (args: { newState: T; oldState: T }) => void

export type Store<T> = {
  getState: () => T
  setState: (updater: (prev: T) => T) => void
  subscribe: (listener: Listener) => () => void
}

export function createStore<T>(
  initialState: T,
  onChange?: OnChange<T>,
): Store<T> {
  let state = initialState
  const listeners = new Set<Listener>()

  return {
    getState: () => state,

    setState: (updater: (prev: T) => T) => {
      const prev = state
      const next = updater(prev)
      if (Object.is(next, prev)) return
      state = next
      onChange?.({ newState: next, oldState: prev })
      for (const listener of listeners) listener()
    },

    subscribe: (listener: Listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
```

- [ ] **Step 2: 验证类型检查**

```bash
npm run typecheck
```

Expected: 无错误

- [ ] **Step 3: Commit**

```bash
git add src/tui/state/store.ts
git commit -m "feat(tui): add external store implementation"
```

---

### Task 3: 主题系统

**Files:**
- Create: `src/tui/design-system/theme.ts`
- Create: `src/tui/design-system/ThemeProvider.tsx`

**Claude Code 参考:** `ClaudeCode/src/components/design-system/ThemeProvider.tsx`（169 行）— 简化版：跳过 OSC 11 自动检测和 previewTheme 机制

- [ ] **Step 1: 创建 theme.ts**

```typescript
// src/tui/design-system/theme.ts
// 定义主题类型和色板

export type ThemeName = 'dark' | 'light'
export type ThemeSetting = ThemeName | 'auto'

export type Theme = {
  // 基础文本
  text: string
  inactive: string
  // 品牌色
  claude: string
  claudeShimmer: string
  // 语义色
  success: string
  error: string
  warning: string
  suggestion: string
  // UI 元素
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
```

- [ ] **Step 2: 创建 ThemeProvider.tsx**

```tsx
// src/tui/design-system/ThemeProvider.tsx
// 复刻自 ClaudeCode/src/components/design-system/ThemeProvider.tsx
// 简化：跳过 OSC 11 自动检测和 previewTheme

import React, { createContext, useContext, useState, useCallback } from 'react'
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

  // Phase 1: 'auto' 简化为默认使用 dark，后续可接入 OSC 11
  const resolvedName: ThemeName = themeSetting === 'auto' ? DEFAULT_THEME : themeSetting
  const currentTheme = getTheme(resolvedName)

  const value: ThemeContextValue = {
    themeSetting,
    setThemeSetting,
    currentTheme,
  }

  return (
    <ThemeContext.Provider value={value}>
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
```

- [ ] **Step 3: 验证类型检查**

```bash
npm run typecheck
```

- [ ] **Step 4: Commit**

```bash
git add src/tui/design-system/theme.ts src/tui/design-system/ThemeProvider.tsx
git commit -m "feat(tui): add theme system with ThemeProvider"
```

---

### Task 4: ThemedBox + ThemedText

**Files:**
- Create: `src/tui/design-system/ThemedBox.tsx`
- Create: `src/tui/design-system/ThemedText.tsx`
- Create: `src/tui/design-system/color.ts`

**Claude Code 参考:** `ClaudeCode/src/components/design-system/ThemedBox.tsx`（155 行）、`ThemedText.tsx`（123 行）— 复刻 resolveColor 逻辑和 TextHoverColorContext

- [ ] **Step 1: 创建 color.ts — resolveColor 工具函数**

```typescript
// src/tui/design-system/color.ts
// 复刻自 ClaudeCode/src/components/design-system/ThemedBox.tsx:42-50

import type { Theme } from './theme.js'

/**
 * 解析颜色值：如果是原始颜色前缀则直接返回，否则作为主题键解析
 */
export function resolveColor(color: string | undefined, theme: Theme): string | undefined {
  if (!color) return undefined
  // 原始颜色直接返回
  if (color.startsWith('rgb(') || color.startsWith('#') || color.startsWith('ansi256(') || color.startsWith('ansi:')) {
    return color
  }
  // 作为主题键解析
  return theme[color as keyof Theme] ?? color
}
```

- [ ] **Step 2: 创建 ThemedBox.tsx**

```tsx
// src/tui/design-system/ThemedBox.tsx
// 复刻自 ClaudeCode/src/components/design-system/ThemedBox.tsx
// 简化：只支持核心颜色 props

import React from 'react'
import { Box, type BoxProps } from 'ink'
import { useTheme } from './ThemeProvider.js'
import { resolveColor } from './color.js'
import type { Theme } from './theme.js'

type ThemedColorProps = {
  borderColor?: keyof Theme | string
  backgroundColor?: keyof Theme | string
}

type Props = Omit<BoxProps, 'borderColor' | 'backgroundColor'> & ThemedColorProps & {
  children?: React.ReactNode
}

export function ThemedBox({ borderColor, backgroundColor, ...rest }: Props) {
  const [theme] = useTheme()

  return (
    <Box
      {...rest}
      borderColor={resolveColor(borderColor, theme) as any}
      backgroundColor={resolveColor(backgroundColor, theme) as any}
    />
  )
}

export default ThemedBox
```

- [ ] **Step 3: 创建 ThemedText.tsx**

```tsx
// src/tui/design-system/ThemedText.tsx
// 复刻自 ClaudeCode/src/components/design-system/ThemedText.tsx
// 包含 TextHoverColorContext

import React, { createContext, useContext } from 'react'
import { Text, type TextProps } from 'ink'
import { useTheme } from './ThemeProvider.js'
import { resolveColor } from './color.js'
import type { Theme } from './theme.js'

export const TextHoverColorContext = createContext<keyof Theme | undefined>(undefined)

type Props = Omit<TextProps, 'color' | 'backgroundColor'> & {
  color?: keyof Theme | string
  backgroundColor?: keyof Theme | string
  children?: React.ReactNode
}

export function ThemedText({ color, backgroundColor, dimColor, ...rest }: Props) {
  const [theme] = useTheme()
  const hoverColor = useContext(TextHoverColorContext)

  let resolvedColor: string | undefined
  if (!color && hoverColor) {
    resolvedColor = resolveColor(hoverColor, theme)
  } else if (dimColor) {
    resolvedColor = theme.inactive
  } else {
    resolvedColor = resolveColor(color, theme)
  }

  return (
    <Text
      {...rest}
      color={resolvedColor as any}
      backgroundColor={resolveColor(backgroundColor, theme) as any}
      dimColor={dimColor}
    />
  )
}

export default ThemedText
```

- [ ] **Step 4: 验证类型检查**

```bash
npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add src/tui/design-system/color.ts src/tui/design-system/ThemedBox.tsx src/tui/design-system/ThemedText.tsx
git commit -m "feat(tui): add ThemedBox and ThemedText with resolveColor"
```

---

## Stream B: 键绑定系统（3 个 Task）

### Task 5: 键绑定类型与默认绑定

**Files:**
- Create: `src/tui/keybindings/types.ts`
- Create: `src/tui/keybindings/defaultBindings.ts`

**Claude Code 参考:** `ClaudeCode/src/keybindings/types.ts`、`defaultBindings.ts`（341 行）— 简化：只实现 Global、Chat、Confirmation、Scroll 四个上下文

- [ ] **Step 1: 创建 types.ts**

```typescript
// src/tui/keybindings/types.ts
// 复刻自 ClaudeCode/src/keybindings/types.ts

export type KeybindingContextName = string
export type KeybindingAction = string

export type ParsedKeystroke = {
  key?: string
  ctrl?: boolean
  alt?: boolean
  shift?: boolean
  meta?: boolean
}

export type ParsedBinding = {
  action: KeybindingAction
  keys: ParsedKeystroke[]
}

export type KeybindingBlock = {
  context?: KeybindingContextName
  bindings?: Record<string, KeybindingAction>
}
```

- [ ] **Step 2: 创建 defaultBindings.ts**

```typescript
// src/tui/keybindings/defaultBindings.ts
// 复刻自 ClaudeCode/src/keybindings/defaultBindings.ts
// 简化：只实现 Global、Chat、Confirmation、Scroll 四个上下文

import type { KeybindingBlock } from './types.js'

export const DEFAULT_BINDINGS: KeybindingBlock[] = [
  {
    context: 'Global',
    bindings: {
      'ctrl+c': 'app:interrupt',
      'ctrl+d': 'app:exit',
      'ctrl+l': 'app:redraw',
    },
  },
  {
    context: 'Chat',
    bindings: {
      'escape': 'chat:cancel',
      'enter': 'chat:submit',
      'up': 'history:previous',
      'down': 'history:next',
      'ctrl+s': 'chat:stash',
    },
  },
  {
    context: 'Confirmation',
    bindings: {
      'y': 'confirm:yes',
      'n': 'confirm:no',
      'enter': 'confirm:yes',
      'escape': 'confirm:no',
    },
  },
  {
    context: 'Scroll',
    bindings: {
      'pageup': 'scroll:pageUp',
      'pagedown': 'scroll:pageDown',
      'ctrl+home': 'scroll:top',
      'ctrl+end': 'scroll:bottom',
    },
  },
]
```

- [ ] **Step 3: Commit**

```bash
git add src/tui/keybindings/types.ts src/tui/keybindings/defaultBindings.ts
git commit -m "feat(tui): add keybinding types and default bindings"
```

---

### Task 6: 键绑定 Resolver + useKeybinding Hook

**Files:**
- Create: `src/tui/keybindings/resolver.ts`
- Create: `src/tui/keybindings/useKeybinding.ts`

**Claude Code 参考:** `ClaudeCode/src/keybindings/resolver.ts` — 简化实现

- [ ] **Step 1: 创建 resolver.ts**

```typescript
// src/tui/keybindings/resolver.ts
// 解析键绑定：将键盘输入映射到动作

import type { KeybindingAction, KeybindingBlock, ParsedKeystroke } from './types.js'
import { DEFAULT_BINDINGS } from './defaultBindings.js'

function parseKeystroke(input: string, key: { ctrl?: boolean; meta?: boolean; shift?: boolean; return?: boolean; escape?: boolean; upArrow?: boolean; downArrow?: boolean; pageUp?: boolean; pageDown?: boolean; home?: boolean; end?: boolean }): ParsedKeystroke {
  const parts: string[] = []
  if (key.ctrl) parts.push('ctrl')
  if (key.meta) parts.push('meta')
  if (key.shift) parts.push('shift')

  // 特殊键
  if (key.return) parts.push('enter')
  else if (key.escape) parts.push('escape')
  else if (key.upArrow) parts.push('up')
  else if (key.downArrow) parts.push('down')
  else if (key.pageUp) parts.push('pageup')
  else if (key.pageDown) parts.push('pagedown')
  else if (key.home) parts.push('home')
  else if (key.end) parts.push('end')
  else if (input) parts.push(input.toLowerCase())

  return { key: parts.join('+') }
}

function keystrokeToString(ks: ParsedKeystroke): string {
  return ks.key ?? ''
}

/**
 * 解析当前按键对应的动作
 */
export function resolveAction(
  input: string,
  key: Parameters<typeof parseKeystroke>[1],
  context: string,
  bindings: KeybindingBlock[] = DEFAULT_BINDINGS,
): KeybindingAction | undefined {
  const ks = parseKeystroke(input, key)
  const ksStr = keystrokeToString(ks)

  // 先查找当前上下文的绑定
  const contextBlock = bindings.find(b => b.context === context)
  if (contextBlock?.bindings?.[ksStr]) {
    return contextBlock.bindings[ksStr]
  }

  // 再查找 Global 上下文
  const globalBlock = bindings.find(b => b.context === 'Global')
  if (globalBlock?.bindings?.[ksStr]) {
    return globalBlock.bindings[ksStr]
  }

  return undefined
}
```

- [ ] **Step 2: 创建 useKeybinding.ts**

```tsx
// src/tui/keybindings/useKeybinding.ts
// 键绑定注册 hook

import { useInput } from 'ink'
import { resolveAction } from './resolver.js'

type UseKeybindingOptions = {
  context?: string
  isActive?: boolean
}

/**
 * 注册一个键绑定处理器
 * @param action 要监听的动作名（如 'chat:submit'）
 * @param handler 触发时的回调
 * @param options context: 上下文名，isActive: 是否激活
 */
export function useKeybinding(
  action: string,
  handler: () => void,
  options: UseKeybindingOptions = {},
) {
  const { context = 'Global', isActive = true } = options

  useInput((input, key) => {
    if (!isActive) return
    const resolved = resolveAction(input, key, context)
    if (resolved === action) {
      handler()
    }
  })
}
```

- [ ] **Step 3: Commit**

```bash
git add src/tui/keybindings/resolver.ts src/tui/keybindings/useKeybinding.ts
git commit -m "feat(tui): add keybinding resolver and useKeybinding hook"
```

---

## Stream C: Overlay 上下文（1 个 Task）

### Task 7: Overlay 上下文

**Files:**
- Create: `src/tui/context/overlayContext.tsx`

**Claude Code 参考:** `ClaudeCode/src/context/overlayContext.tsx`（150 行）— 简化：跳过 invalidatePrevFrame 调用

- [ ] **Step 1: 创建 overlayContext.tsx**

```tsx
// src/tui/context/overlayContext.tsx
// 复刻自 ClaudeCode/src/context/overlayContext.tsx
// 简化：跳过 invalidatePrevFrame 调用

import React, { createContext, useContext, useLayoutEffect, useState, useCallback } from 'react'

type OverlayContextValue = {
  activeOverlays: Set<string>
  registerOverlay: (id: string) => void
  unregisterOverlay: (id: string) => void
}

const OverlayContext = createContext<OverlayContextValue | null>(null)

export function OverlayProvider({ children }: { children: React.ReactNode }) {
  const [activeOverlays, setActiveOverlays] = useState<Set<string>>(new Set())

  const registerOverlay = useCallback((id: string) => {
    setActiveOverlays(prev => {
      if (prev.has(id)) return prev
      const next = new Set(prev)
      next.add(id)
      return next
    })
  }, [])

  const unregisterOverlay = useCallback((id: string) => {
    setActiveOverlays(prev => {
      if (!prev.has(id)) return prev
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }, [])

  return (
    <OverlayContext.Provider value={{ activeOverlays, registerOverlay, unregisterOverlay }}>
      {children}
    </OverlayContext.Provider>
  )
}

/**
 * 注册/注销覆盖层组件
 * 组件 mount 时注册，unmount 时自动注销
 */
export function useRegisterOverlay(id: string, enabled = true) {
  const ctx = useContext(OverlayContext)
  if (!ctx) throw new Error('useRegisterOverlay must be used within OverlayProvider')

  useLayoutEffect(() => {
    if (!enabled) return
    ctx.registerOverlay(id)
    return () => ctx.unregisterOverlay(id)
  }, [id, enabled, ctx.registerOverlay, ctx.unregisterOverlay])
}

/**
 * 检查是否有任何活跃的覆盖层
 */
export function useIsOverlayActive(): boolean {
  const ctx = useContext(OverlayContext)
  if (!ctx) return false
  return ctx.activeOverlays.size > 0
}

/**
 * 检查是否有模态覆盖层（排除非模态如 autocomplete）
 */
const NON_MODAL_OVERLAYS = new Set(['autocomplete'])

export function useIsModalOverlayActive(): boolean {
  const ctx = useContext(OverlayContext)
  if (!ctx) return false
  for (const id of ctx.activeOverlays) {
    if (!NON_MODAL_OVERLAYS.has(id)) return true
  }
  return false
}
```

- [ ] **Step 2: Commit**

```bash
git add src/tui/context/overlayContext.tsx
git commit -m "feat(tui): add overlay context for tracking active overlays"
```

---

## Stream D: 设计原语 + 集成（3 个 Task，依赖 A/B/C 完成）

### Task 8: 设计系统原语（Divider + Pane + Dialog + StatusIcon + ListItem）

**Files:**
- Create: `src/tui/design-system/Divider.tsx`
- Create: `src/tui/design-system/Pane.tsx`
- Create: `src/tui/design-system/Dialog.tsx`
- Create: `src/tui/design-system/StatusIcon.tsx`
- Create: `src/tui/design-system/ListItem.tsx`

**Claude Code 参考:** `Divider.tsx`（148 行）、`Pane.tsx`（76 行）、`Dialog.tsx`（137 行）、`StatusIcon.tsx`（94 行）— 逐一复刻

- [ ] **Step 1: 创建 Divider.tsx**

```tsx
// src/tui/design-system/Divider.tsx
// 复刻自 ClaudeCode/src/components/design-system/Divider.tsx

import React from 'react'
import { Text, useTerminalSize } from 'ink'
import type { Theme } from './theme.js'

type DividerProps = {
  width?: number
  color?: keyof Theme
  char?: string
  padding?: number
  title?: string
}

export function Divider({
  width,
  color,
  char = '─',
  padding = 0,
  title,
}: DividerProps) {
  const { columns: terminalWidth } = useTerminalSize()
  const effectiveWidth = Math.max(0, (width ?? terminalWidth) - padding)

  if (title) {
    // 简化：用 title.length 代替 stringWidth（CJK 字符可能不准但足够用）
    const titleWidth = title.length + 2
    const sideWidth = Math.max(0, effectiveWidth - titleWidth)
    const leftWidth = Math.floor(sideWidth / 2)
    const rightWidth = sideWidth - leftWidth
    return (
      <Text color={color as any} dimColor={!color}>
        {char.repeat(leftWidth)}{' '}{title}{' '}{char.repeat(rightWidth)}
      </Text>
    )
  }

  return (
    <Text color={color as any} dimColor={!color}>
      {char.repeat(effectiveWidth)}
    </Text>
  )
}
```

- [ ] **Step 2: 创建 Pane.tsx**

```tsx
// src/tui/design-system/Pane.tsx
// 复刻自 ClaudeCode/src/components/design-system/Pane.tsx
// 简化：不实现 useIsInsideModal，始终使用非模态渲染

import React from 'react'
import { Box } from 'ink'
import { Divider } from './Divider.js'
import type { Theme } from './theme.js'

type PaneProps = {
  children: React.ReactNode
  color?: keyof Theme
}

export function Pane({ children, color }: PaneProps) {
  return (
    <Box flexDirection="column" paddingTop={1}>
      <Divider color={color} />
      <Box flexDirection="column" paddingX={2}>{children}</Box>
    </Box>
  )
}
```

- [ ] **Step 3: 创建 Dialog.tsx**

```tsx
// src/tui/design-system/Dialog.tsx
// 复刻自 ClaudeCode/src/components/design-system/Dialog.tsx
// 简化：只实现核心 Escape 取消，不实现 useExitOnCtrlCDWithKeybindings

import React from 'react'
import { Box, Text } from 'ink'
import { Pane } from './Pane.js'
import { useKeybinding } from '../keybindings/useKeybinding.js'
import type { Theme } from './theme.js'

type DialogProps = {
  title: string
  subtitle?: string
  children: React.ReactNode
  onCancel: () => void
  color?: keyof Theme
  hideBorder?: boolean
}

export function Dialog({ title, subtitle, children, onCancel, color = 'permission', hideBorder }: DialogProps) {
  useKeybinding('confirm:no', onCancel, { context: 'Confirmation' })

  const content = (
    <Box flexDirection="column">
      <Box>
        <Text bold color={color as any}>{title}</Text>
        {subtitle && <Text dimColor> — {subtitle}</Text>}
      </Box>
      <Box marginTop={1}>{children}</Box>
    </Box>
  )

  if (hideBorder) return content

  return <Pane color={color}>{content}</Pane>
}
```

- [ ] **Step 4: 创建 StatusIcon.tsx**

```tsx
// src/tui/design-system/StatusIcon.tsx
// 复刻自 ClaudeCode/src/components/design-system/StatusIcon.tsx

import React from 'react'
import figures from 'figures'
import { Text } from 'ink'
import type { Theme } from './theme.js'

type Status = 'success' | 'error' | 'warning' | 'info' | 'pending' | 'loading'

type Props = {
  status: Status
  withSpace?: boolean
}

const STATUS_CONFIG: Record<Status, {
  icon: string
  color: keyof Theme | undefined
}> = {
  success: { icon: figures.tick, color: 'success' },
  error: { icon: figures.cross, color: 'error' },
  warning: { icon: figures.warning, color: 'warning' },
  info: { icon: figures.info, color: 'suggestion' },
  pending: { icon: figures.circle, color: undefined },
  loading: { icon: '…', color: undefined },
}

export function StatusIcon({ status, withSpace = false }: Props) {
  const config = STATUS_CONFIG[status]
  return (
    <Text color={config.color as any} dimColor={!config.color}>
      {config.icon}{withSpace && ' '}
    </Text>
  )
}
```

- [ ] **Step 5: 创建 ListItem.tsx**

```tsx
// src/tui/design-system/ListItem.tsx
// 简化版列表项组件

import React from 'react'
import { Box, Text } from 'ink'

type Props = {
  children: React.ReactNode
  selected?: boolean
  indicator?: string
}

export function ListItem({ children, selected = false, indicator = '▸' }: Props) {
  return (
    <Box>
      <Text color={selected ? 'green' : undefined} bold={selected}>
        {selected ? indicator : ' '}
      </Text>
      <Text bold={selected}>{children}</Text>
    </Box>
  )
}
```

- [ ] **Step 6: 验证类型检查**

```bash
npm run typecheck
```

- [ ] **Step 7: Commit**

```bash
git add src/tui/design-system/Divider.tsx src/tui/design-system/Pane.tsx src/tui/design-system/Dialog.tsx src/tui/design-system/StatusIcon.tsx src/tui/design-system/ListItem.tsx
git commit -m "feat(tui): add design system primitives (Divider, Pane, Dialog, StatusIcon, ListItem)"
```

---

### Task 9: AppState + 自定义 Ink 层 + REPL 骨架 + 入口点

**Files:**
- Create: `src/tui/state/AppStateStore.ts`
- Create: `src/tui/state/AppState.tsx`
- Create: `src/tui/ink.tsx`
- Create: `src/tui/screens/REPL.tsx`
- Create: `src/tui/entrypoints/tui.tsx`

**Claude Code 参考:** `AppState.tsx`（199 行）、`ink.ts`（86 行）— 复刻核心模式

- [ ] **Step 1: 创建 AppStateStore.ts**

```typescript
// src/tui/state/AppStateStore.ts
// 定义 myagent 的 AppState 类型

import type { ThemeSetting } from '../design-system/theme.js'

export type AppState = {
  themeSetting: ThemeSetting
  isRunning: boolean
  activeOverlays: Set<string>
  activeKeybindingContext: string
  verbose: boolean
}

export function getDefaultAppState(): AppState {
  return {
    themeSetting: 'dark',
    isRunning: false,
    activeOverlays: new Set(),
    activeKeybindingContext: 'Chat',
    verbose: false,
  }
}
```

- [ ] **Step 2: 创建 AppState.tsx**

```tsx
// src/tui/state/AppState.tsx
// 复刻自 ClaudeCode/src/state/AppState.tsx
// 简化：不包含 MailboxProvider/VoiceProvider

import React, { createContext, useContext, useState } from 'react'
import { useSyncExternalStore } from 'react'
import { createStore, type Store } from './store.js'
import { type AppState, getDefaultAppState } from './AppStateStore.js'

type AppStateStore = Store<AppState>

const AppStoreContext = createContext<AppStateStore | null>(null)
const HasAppStateContext = createContext(false)

export function AppStateProvider({
  children,
  initialState,
}: {
  children: React.ReactNode
  initialState?: AppState
}) {
  const [store] = useState(() => createStore(initialState ?? getDefaultAppState()))

  if (useContext(HasAppStateContext)) {
    throw new Error('AppStateProvider cannot be nested')
  }

  return (
    <HasAppStateContext.Provider value={true}>
      <AppStoreContext.Provider value={store}>
        {children}
      </AppStoreContext.Provider>
    </HasAppStateContext.Provider>
  )
}

function useAppStore(): AppStateStore {
  const store = useContext(AppStoreContext)
  if (!store) throw new Error('useAppStore must be used within AppStateProvider')
  return store
}

export function useAppState<T>(selector: (state: AppState) => T): T {
  const store = useAppStore()
  return useSyncExternalStore(
    store.subscribe,
    () => selector(store.getState()),
  )
}

export function useSetAppState(): (updater: (prev: AppState) => AppState) => void {
  return useAppStore().setState
}
```

- [ ] **Step 3: 创建 ink.tsx — 自定义 Ink 层**

```tsx
// src/tui/ink.tsx
// 复刻自 ClaudeCode/src/ink.ts
// 自动包裹 ThemeProvider

import React, { createElement, type ReactNode } from 'react'
import { render as inkRender, type RenderOptions, type Instance } from 'ink'
import { ThemeProvider } from './design-system/ThemeProvider.js'

function withTheme(node: ReactNode): ReactNode {
  return createElement(ThemeProvider, null, node)
}

export async function render(node: ReactNode, options?: RenderOptions): Promise<Instance> {
  return inkRender(withTheme(node), options)
}

// 重导出主题化组件
export { ThemedBox as Box } from './design-system/ThemedBox.js'
export { ThemedText as Text } from './design-system/ThemedText.js'
export { useTheme, useThemeSetting } from './design-system/ThemeProvider.js'

// 重导出 Ink 原语
export { default as BaseBox } from 'ink'
export { useInput, useApp, useStdin, useTerminalSize } from 'ink'
```

- [ ] **Step 4: 创建 REPL.tsx 骨架**

```tsx
// src/tui/screens/REPL.tsx
// 主 REPL 屏幕骨架 — Phase 1 使用简单文本列表

import React, { useState, useRef, useCallback } from 'react'
import { Box, Text, useInput, useApp, useTerminalSize } from 'ink'
import { Divider } from '../design-system/Divider.js'
import { useAppState, useSetAppState } from '../state/AppState.js'
import { resolveAction } from '../keybindings/resolver.js'
import { OverlayProvider } from '../context/overlayContext.js'

type Message = {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
}

type REPLProps = {
  // 后续 Phase 会接入 AgentLoop
}

export function REPL(_props: REPLProps) {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [cursorOffset, setCursorOffset] = useState(0)
  const { exit } = useApp()
  const { columns } = useTerminalSize()
  const setAppState = useSetAppState()

  // 键绑定处理
  useInput((inputChar, key) => {
    // Ctrl+C — 中断
    if (key.ctrl && inputChar === 'c') {
      // 双击退出逻辑留给后续 Phase
      return
    }
    // Ctrl+D — 退出
    if (key.ctrl && inputChar === 'd') {
      exit()
      return
    }
    // Ctrl+L — 清屏
    if (key.ctrl && inputChar === 'l') {
      console.clear()
      return
    }
    // Enter — 提交
    if (key.return) {
      if (input.trim()) {
        const userMsg: Message = { id: Date.now().toString(), role: 'user', content: input }
        setMessages(prev => [...prev, userMsg])
        // Phase 1: 模拟回复，后续接入 AgentLoop
        const assistantMsg: Message = {
          id: (Date.now() + 1).toString(),
          role: 'assistant',
          content: `Echo: ${input}`,
        }
        setMessages(prev => [...prev, assistantMsg])
        setInput('')
      }
      return
    }
    // Backspace
    if (key.backspace || key.delete) {
      setInput(prev => prev.slice(0, -1))
      return
    }
    // 普通字符
    if (inputChar && !key.ctrl && !key.meta) {
      setInput(prev => prev + inputChar)
    }
  })

  return (
    <OverlayProvider>
      <Box flexDirection="column" height="100%">
        {/* Header */}
        <Box paddingX={1}>
          <Text bold color="cyan">myagent</Text>
          <Text dimColor> — TUI Mode</Text>
        </Box>
        <Divider />

        {/* Messages 区域 */}
        <Box flexDirection="column" flexGrow={1} paddingX={1} overflow="hidden">
          {messages.length === 0 ? (
            <Text dimColor>Type a message to get started...</Text>
          ) : (
            messages.map(msg => (
              <Box key={msg.id} marginBottom={1}>
                <Text bold color={msg.role === 'user' ? 'blue' : 'green'}>
                  {msg.role === 'user' ? '> ' : '< '}
                </Text>
                <Text>{msg.content}</Text>
              </Box>
            ))
          )}
        </Box>

        {/* Input 区域 */}
        <Divider />
        <Box paddingX={1}>
          <Text color="cyan">{'> '}</Text>
          <Text>{input}</Text>
          <Text inverse>{' '}</Text>
        </Box>
      </Box>
    </OverlayProvider>
  )
}
```

- [ ] **Step 5: 创建 tui.tsx 入口点**

```tsx
// src/tui/entrypoints/tui.tsx
// 新 TUI 入口点

import React from 'react'
import { render } from '../ink.js'
import { AppStateProvider } from '../state/AppState.js'
import { REPL } from '../screens/REPL.js'

async function main() {
  render(
    <AppStateProvider>
      <REPL />
    </AppStateProvider>,
  )
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
```

- [ ] **Step 6: 验证类型检查**

```bash
npm run typecheck
```

- [ ] **Step 7: Commit**

```bash
git add src/tui/state/AppStateStore.ts src/tui/state/AppState.tsx src/tui/ink.tsx src/tui/screens/REPL.tsx src/tui/entrypoints/tui.tsx
git commit -m "feat(tui): add AppState, custom Ink layer, REPL skeleton and entry point"
```

---

### Task 10: 端到端验证

- [ ] **Step 1: 启动 TUI**

```bash
npm run dev:tui
```

Expected: 终端显示带主题色的 REPL 界面，有 Header、消息区域和输入提示

- [ ] **Step 2: 测试输入**

输入 `hello` 并按 Enter，验证：
- 用户消息显示为蓝色 `> hello`
- 模拟回复显示为绿色 `< Echo: hello`
- 输入框清空

- [ ] **Step 3: 测试键绑定**

- Ctrl+D：退出应用
- Ctrl+L：清屏
- Ctrl+C：无报错（中断逻辑留待后续 Phase）

- [ ] **Step 4: 测试主题**

修改 `AppStateStore.ts` 中 `getDefaultAppState` 的 `themeSetting` 为 `'light'`，重启验证颜色变化

- [ ] **Step 5: 最终 Commit**

```bash
git add -A
git commit -m "feat(tui): Phase 1 foundation complete — Ink + React + Theme + State + Keybindings"
```

---

## Phase 1 完成标志

- [x] `npm run dev:tui` 启动 TUI 界面
- [x] 主题化 Box/Text 渲染正确
- [x] useAppState selector 模式工作
- [x] 键绑定系统捕获 Ctrl+C/D/L
- [x] Overlay 注册/注销机制
- [x] 消息输入和模拟回复
- [x] 所有文件类型检查通过
