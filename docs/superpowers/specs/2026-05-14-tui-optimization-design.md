# MyAgent TUI 全面优化设计文档

> 参考 Claude Code TUI 架构，对 MyAgent TUI 进行全面重构

---

## 一、项目概述

### 1.1 目标

将 MyAgent TUI 从当前的基础实现升级为参考 Claude Code 架构的高质量 TUI，包括：

- 三层状态管理架构
- 完整的设计系统
- 虚拟滚动
- 声明式键绑定系统
- 自动补全系统
- Overlay/模态系统
- 高级 Spinner 与动画系统
- 终端集成

### 1.2 约束

- 分阶段进行，每阶段完成后可独立使用
- 保持与现有 API 和配置格式的兼容性
- 基于 Ink 7 + React 19

---

## 二、架构设计

### 2.1 三层状态管理

```
Layer 1: 全局模块单例状态 (src/tui/state/global.ts)
  → 纯 JavaScript 对象，完全在 React 之外
  → 通过导出的 getter/setter 函数访问
  → 无 React 订阅机制
  → 包含: sessionId, projectRoot, cwd, totalCostUSD 等

Layer 2: React Store (src/tui/state/store.ts)
  → 自定义 Store<T> 实现
  → getState / setState / subscribe
  → 使用 Object.is 进行身份检查

Layer 3: React Hooks + 外部 Store (src/tui/state/hooks.ts)
  → useAppState(selector) 使用 useSyncExternalStore
  → 选择器模式确保仅在所选值变化时重新渲染
```

### 2.2 设计系统

```
src/tui/design-system/
  ├── ThemeProvider.tsx      # 主题上下文提供者
  ├── ThemedBox.tsx          # Box 组件，主题感知
  ├── ThemedText.tsx         # Text 组件，主题感知
  ├── color.ts               # 柯里化的主题感知 color() 函数
  ├── Dialog.tsx             # 对话框框架
  ├── Divider.tsx            # 水平分隔线
  ├── FuzzyPicker.tsx        # 模糊搜索选择器
  ├── ListItem.tsx           # 列表项
  ├── LoadingState.tsx       # 加载状态
  ├── Pane.tsx               # 内容窗格
  ├── ProgressBar.tsx        # 进度条
  ├── StatusIcon.tsx         # 状态图标
  └── Tabs.tsx               # 标签栏
```

### 2.3 消息系统

```
src/tui/components/messages/
  ├── MessageRow.tsx         # 消息行包装器
  ├── Message.tsx            # 消息内容分发器
  ├── UserTextMessage.tsx    # 用户文本消息
  ├── AssistantTextMessage.tsx # 助手文本消息 (带 Markdown 渲染)
  ├── AssistantThinkingMessage.tsx # 思维块
  ├── AssistantToolUseMessage.tsx # 工具使用显示
  ├── SystemTextMessage.tsx  # 系统消息
  ├── SystemAPIErrorMessage.tsx # API 错误
  ├── RateLimitMessage.tsx   # 速率限制警告
  └── CompactBoundaryMessage.tsx # 上下文压缩边界
```

### 2.4 虚拟滚动

```
src/tui/components/VirtualMessageList.tsx
  → 基于高度缓存的虚拟滚动
  → 每条消息独立缓存高度
  → 列宽变化时失效
  → 粘性提示头部
  → 未读分隔符跟踪
```

### 2.5 键绑定系统

```
src/tui/keybindings/
  ├── types.ts               # 键绑定类型定义
  ├── defaultBindings.ts     # 默认键绑定
  ├── useKeyBindings.ts      # 键绑定钩子
  └── KeyBindingHandler.tsx  # 键绑定处理器
```

### 2.6 自动补全系统

```
src/tui/typeahead/
  ├── useTypeahead.ts        # 自动补全钩子
  ├── suggestions.ts         # 建议生成
  └── TypeaheadPopup.tsx     # 补全弹窗
```

### 2.7 Overlay/模态系统

```
src/tui/overlay/
  ├── overlayContext.tsx      # Overlay 上下文
  ├── useRegisterOverlay.ts  # 注册 Overlay
  └── ModalPane.tsx          # 模态窗格
```

### 2.8 Spinner 与动画系统

```
src/tui/components/spinner/
  ├── Spinner.tsx            # 主编排器
  ├── SpinnerAnimationRow.tsx # 动画行
  ├── SpinnerGlyph.tsx       # 旋转字形
  ├── GlimmerMessage.tsx     # 闪烁消息
  └── useAnimationFrame.ts   # 动画帧钩子
```

---

## 三、分阶段实施计划

### 阶段 1: 设计系统与主题系统 (Week 1-2)

**目标:** 建立完整的设计系统，替换现有的静态主题

**任务:**
1. 创建 ThemeProvider 支持 light/dark/auto
2. 实现 ThemedBox 和 ThemedText 组件
3. 创建 color() 柯里化函数
4. 实现 Dialog, Divider, StatusIcon 等基础组件
5. 迁移现有组件使用设计系统

**输出:** 设计系统库 + 迁移后的组件

### 阶段 2: 状态管理架构 (Week 3-4)

**目标:** 实现三层状态管理架构

**任务:**
1. 创建全局模块单例状态
2. 实现自定义 Store<T>
3. 创建 useAppState 钩子
4. 迁移现有状态到新架构
5. 实现消息状态管理

**输出:** 状态管理库 + 迁移后的状态

### 阶段 3: 消息系统与虚拟滚动 (Week 5-6)

**目标:** 重构消息系统，实现虚拟滚动

**任务:**
1. 创建类型化消息组件
2. 实现消息管线 (MessageRow → Message → 类型化组件)
3. 实现虚拟滚动 (VirtualMessageList)
4. 实现离屏冻结 (OffscreenFreeze)
5. 实现粘性提示头部

**输出:** 消息系统 + 虚拟滚动

### 阶段 4: 输入系统与键绑定 (Week 7-8)

**目标:** 实现声明式键绑定系统

**任务:**
1. 创建键绑定类型系统
2. 实现默认键绑定
3. 创建 useKeyBindings 钩子
4. 实现文本编辑快捷键
5. 实现双击检测

**输出:** 键绑定系统

### 阶段 5: 自动补全与 Overlay (Week 9-10)

**目标:** 实现自动补全和 Overlay 系统

**任务:**
1. 实现 Token 检测
2. 创建补全源
3. 实现 TypeaheadPopup
4. 创建 Overlay 上下文
5. 实现模态系统

**输出:** 自动补全 + Overlay 系统

### 阶段 6: Spinner 动画与终端集成 (Week 11-12)

**目标:** 实现高级 Spinner 动画和终端集成

**任务:**
1. 创建动画系统 (useAnimationFrame)
2. 实现 Spinner 组件
3. 实现闪烁效果
4. 添加终端集成 (焦点跟踪、剪贴板等)
5. 性能优化

**输出:** 动画系统 + 终端集成

---

## 四、技术细节

### 4.1 状态管理实现

```typescript
// src/tui/state/global.ts
interface GlobalState {
  sessionId: string | null
  projectRoot: string
  cwd: string
  totalCostUSD: number
  totalAPIDuration: number
  totalToolDuration: number
}

let state: GlobalState = {
  sessionId: null,
  projectRoot: '',
  cwd: '',
  totalCostUSD: 0,
  totalAPIDuration: 0,
  totalToolDuration: 0,
}

export function getGlobalState(): GlobalState {
  return state
}

export function setGlobalState(partial: Partial<GlobalState>) {
  state = { ...state, ...partial }
}
```

```typescript
// src/tui/state/store.ts
type Listener<T> = (state: T) => void

export class Store<T> {
  private state: T
  private listeners = new Set<Listener<T>>()

  constructor(initialState: T) {
    this.state = initialState
  }

  getState(): T {
    return this.state
  }

  setState(partial: Partial<T>) {
    const prev = this.state
    this.state = { ...this.state, ...partial }
    if (Object.is(prev, this.state)) return
    this.listeners.forEach((l) => l(this.state))
  }

  subscribe(listener: Listener<T>): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
```

```typescript
// src/tui/state/hooks.ts
import { useSyncExternalStore } from 'react'

export function useAppState<T>(selector: (state: AppState) => T): T {
  return useSyncExternalStore(
    store.subscribe,
    () => selector(store.getState()),
  )
}
```

### 4.2 设计系统实现

```typescript
// src/tui/design-system/ThemeProvider.tsx
import { createContext, useContext, useState, useEffect } from 'react'

type Theme = 'light' | 'dark' | 'auto'

interface ThemeContextValue {
  theme: Theme
  resolvedTheme: 'light' | 'dark'
  setTheme: (theme: Theme) => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<Theme>('auto')
  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>('dark')

  useEffect(() => {
    if (theme === 'auto') {
      // 检测终端主题
      const isDark = true // 默认深色
      setResolvedTheme(isDark)
    } else {
      setResolvedTheme(theme)
    }
  }, [theme])

  return (
    <ThemeContext.Provider value={{ theme, resolvedTheme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme() {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider')
  return ctx
}
```

### 4.3 虚拟滚动实现

```typescript
// src/tui/components/VirtualMessageList.tsx
import { useState, useEffect, useRef, useCallback } from 'react'

interface VirtualMessageListProps {
  messages: DisplayMessage[]
  streamingMessageId?: string | null
  containerHeight: number
}

export function VirtualMessageList({ messages, streamingMessageId, containerHeight }: VirtualMessageListProps) {
  const [scrollTop, setScrollTop] = useState(0)
  const heightCache = useRef<Map<string, number>>(new Map())
  const [visibleRange, setVisibleRange] = useState({ start: 0, end: 20 })

  const totalHeight = messages.reduce((sum, msg) => {
    return sum + (heightCache.current.get(msg.id) ?? 3)
  }, 0)

  const updateVisibleRange = useCallback(() => {
    let accumulated = 0
    let start = 0
    let end = messages.length

    for (let i = 0; i < messages.length; i++) {
      const height = heightCache.current.get(messages[i].id) ?? 3
      if (accumulated + height > scrollTop) {
        start = i
        break
      }
      accumulated += height
    }

    for (let i = start; i < messages.length; i++) {
      const height = heightCache.current.get(messages[i].id) ?? 3
      if (accumulated > scrollTop + containerHeight) {
        end = i
        break
      }
      accumulated += height
    }

    setVisibleRange({ start, end })
  }, [messages, scrollTop, containerHeight])

  useEffect(() => {
    updateVisibleRange()
  }, [updateVisibleRange])

  const visibleMessages = messages.slice(visibleRange.start, visibleRange.end)

  return (
    <Box flexDirection="column">
      {visibleMessages.map((msg) => (
        <MessageRow
          key={msg.id}
          message={msg}
          onHeightChange={(height) => {
            heightCache.current.set(msg.id, height)
          }}
        />
      ))}
    </Box>
  )
}
```

### 4.4 键绑定系统实现

```typescript
// src/tui/keybindings/types.ts
export type KeyBindingContext = 'global' | 'chat' | 'autocomplete'

export interface KeyBinding {
  key: string
  ctrl?: boolean
  shift?: boolean
  meta?: boolean
  action: string
  context: KeyBindingContext
}

export interface KeyBindingDefinition {
  bindings: KeyBinding[]
  handler: (action: string) => void
}
```

```typescript
// src/tui/keybindings/defaultBindings.ts
import type { KeyBinding } from './types'

export const defaultBindings: KeyBinding[] = [
  // 全局上下文
  { key: 'c', ctrl: true, action: 'interrupt', context: 'global' },
  { key: 'd', ctrl: true, action: 'exit', context: 'global' },
  { key: 'l', ctrl: true, action: 'redraw', context: 'global' },

  // 聊天上下文
  { key: 'escape', action: 'cancel', context: 'chat' },
  { key: 'return', action: 'submit', context: 'chat' },
  { key: 'up', action: 'history-up', context: 'chat' },
  { key: 'down', action: 'history-down', context: 'chat' },
]
```

---

## 五、迁移策略

### 5.1 渐进式迁移

- 每个阶段完成后，现有功能继续工作
- 新组件与旧组件并存，逐步替换
- 保持 API 和配置格式兼容

### 5.2 测试策略

- 每个阶段编写单元测试
- 集成测试验证组件交互
- 手动测试验证用户体验

### 5.3 回滚策略

- 每个阶段独立，可单独回滚
- 保持 Git 分支清晰
- 关键节点创建标签

---

## 六、风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| 工作量过大 | 高 | 分阶段进行，每阶段独立可用 |
| 兼容性问题 | 中 | 渐进式迁移，保持 API 兼容 |
| 性能问题 | 中 | 虚拟滚动 + 离屏冻结 + 性能测试 |
| 学习曲线 | 低 | 详细文档 + 代码示例 |

---

## 七、成功标准

- [ ] 设计系统完整，支持 light/dark/auto 主题
- [ ] 三层状态管理架构清晰
- [ ] 虚拟滚动支持 1000+ 消息
- [ ] 键绑定系统支持和弦序列
- [ ] 自动补全支持文件路径、命令等
- [ ] Overlay/模态系统完整
- [ ] Spinner 动画流畅
- [ ] 终端集成完整
- [ ] 性能优于现有实现
- [ ] 代码可维护性提升

---

## 八、附录

### 8.1 参考文档

- Claude Code TUI 架构参考文档
- Ink 官方文档
- React 官方文档

### 8.2 相关文件

- `src/tui/` - TUI 源码目录
- `src/tui/screens/REPL.tsx` - 主 REPL 屏幕
- `src/tui/components/` - UI 组件
- `src/tui/hooks/` - React 钩子
- `src/tui/theme.ts` - 主题配置
