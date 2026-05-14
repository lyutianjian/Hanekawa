# Claude Code TUI 前端架构与交互逻辑参考文档

> 基于 `@anthropic-ai/claude-code` npm 包源码还原树的分析

---

## 一、启动链路与入口

```
src/main.tsx (808KB)
  → Commander.js CLI 参数解析
  → GrowthBook 分析初始化、密钥预取、MDM 设置
  → 认证、策略检查、设置屏幕
  → renderAndRun() / launchRepl()

src/replLauncher.tsx
  → 动态导入 App 和 REPL
  → renderAndRun(root, <App><REPL /></App>)
  → 懒加载模式保持启动速度

src/ink.ts
  → 自定义 Ink 包装器，自动注入 ThemeProvider
  → 重新导出主题化原语：Box (ThemedBox)、Text (ThemedText)、color()、useTheme
```

---

## 二、UI 组件层级树

```
ThemeProvider (由 ink.ts 自动注入)
  └─ BootstrapBoundary (错误边界)
      └─ FpsMetricsProvider
          └─ StatsProvider
              └─ AppStateProvider
                  └─ REPL (src/screens/REPL.tsx - 903KB，核心组件)
                      └─ FullscreenLayout
                          ├─ ScrollBox (虚拟滚动容器)
                          │   └─ VirtualMessageList
                          │       └─ MessageRow
                          │           └─ Message → 分发到各类消息组件
                          ├─ [底部插槽: Spinner, PromptInput, PermissionRequest]
                          ├─ [覆盖层插槽: 通知]
                          └─ [模态插槽: 斜杠命令对话框]
```

---

## 三、三个核心屏幕

| 文件 | 大小 | 用途 |
|------|------|------|
| `src/screens/REPL.tsx` | 903KB | 主交互会话 - 包含所有消息处理、查询编排、权限流、工具执行、历史导航、队友/蜂群协调、语音集成、快捷键绑定和完整渲染树 |
| `src/screens/ResumeConversation.tsx` | 60KB | 会话恢复 / 转录选择器 |
| `src/screens/Doctor.tsx` | 74KB | `/doctor` 诊断屏幕 |

---

## 四、设计系统 (`src/components/design-system/`)

### 4.1 主题系统

- **ThemeProvider.tsx**: 主题上下文提供者，支持 light/dark/auto，通过 OSC 11 实时监听终端主题变化
- **ThemedBox.tsx**: Box 组件，将主题颜色键（如 `borderColor`、`backgroundColor`）解析为原始 ANSI 颜色
- **ThemedText.tsx**: Text 组件，将主题颜色键解析为原始颜色，支持通过非活跃主题颜色实现 `dimColor`，支持跨 Box 的悬停颜色级联（`TextHoverColorContext`）
- **color.ts**: 柯里化的主题感知 `color()` 函数，用于命令式代码路径中的着色

### 4.2 颜色系统

- 颜色属性接受主题键（如 `'claude'`、`'claudeShimmer'`、`'error'`、`'subtle'`、`'warning'`），在渲染时解析为原始 ANSI 颜色
- `color()` 函数提供命令式场景下的主题感知着色

### 4.3 基础 UI 组件

| 组件 | 说明 |
|------|------|
| `Dialog.tsx` | 使用 box-drawing 字符的对话框框架 |
| `Divider.tsx` | 水平分隔线 |
| `FuzzyPicker.tsx` | 模糊搜索选择器（用于模型、主题等） |
| `KeyboardShortcutHint.tsx` | 快捷键提示徽章 |
| `ListItem.tsx` | 带选中状态的列表项 |
| `LoadingState.tsx` | 加载状态 |
| `Pane.tsx` | 带边框的内容窗格 |
| `ProgressBar.tsx` | Unicode 块字符进度条，使用 `[' ', '▏', '▎', '▍', '▌', '▋', '▊', '▉', '█']` 实现亚字符精度 |
| `StatusIcon.tsx` | 状态图标（勾选、错误、警告等） |
| `Tabs.tsx` | 标签栏组件 |

---

## 五、消息展示系统

### 5.1 消息管线

```
Messages.tsx (消息列表编排器)
  → 过滤、转换和渲染完整消息列表
  → MessageRow.tsx (单条消息行包装器)
      → 添加时间戳、模型标签、离屏冻结优化
      → Message.tsx (消息内容分发器)
          → 路由到正确的类型化消息组件
```

### 5.2 消息类型组件 (`src/components/messages/`)

**用户消息类型:**
- `UserTextMessage` - 普通用户文本
- `UserBashInputMessage` / `UserBashOutputMessage` - Bash 命令输入/输出
- `UserCommandMessage` - 斜杠命令
- `UserImageMessage` - 图片附件
- `UserToolResultMessage/` (7 个文件) - 工具结果变体：成功、错误、拒绝、取消等
- `UserPlanMessage` - 计划消息
- `UserTeammateMessage` - 队友消息

**助手消息类型:**
- `AssistantTextMessage` - 带 Markdown 渲染的流式文本
- `AssistantThinkingMessage` - 思维/推理块（带显示/隐藏切换）
- `AssistantToolUseMessage` - 工具使用显示（带输入展示和进度）
- `AssistantRedactedThinkingMessage` - 被编辑的思维块

**系统消息类型:**
- `SystemTextMessage` - 系统消息
- `SystemAPIErrorMessage` - API 错误显示
- `RateLimitMessage` - 速率限制警告
- `CompactBoundaryMessage` - 上下文压缩边界
- `GroupedToolUseContent` - 分组工具使用显示
- `CollapsedReadSearchContent` - 折叠的读取/搜索工具输出（带流式旋转器）

### 5.3 虚拟滚动 (`VirtualMessageList`)

- 基于高度缓存的虚拟滚动，每条消息独立缓存高度，在列宽变化时失效
- 粘性提示头部：跟踪滚动位置，显示最新用户提示的压缩版本
- 未读分隔符跟踪：滚动上方时出现"N 条新消息"药丸
- `OffscreenFreeze` 防止视口外消息的重新渲染

---

## 六、输入系统

### 6.1 输入管线层次

```
Layer 1: Ink 的 useInput 钩子
  → 原始键盘输入，解析为 Key 对象（ctrl, shift, meta, escape, return, tab 等）

Layer 2: usePasteHandler (usePasteHandler.ts)
  → 通过 isPasted 标志或大输入块检测粘贴
  → 100ms 防抖超时累积块，然后分派到 onPaste

Layer 3: useTextInput (useTextInput.ts)
  → 核心文本编辑引擎
  → mapKey(key) 将 Ink Key 对象映射到光标操作

Layer 4: 键绑定系统 (src/keybindings/)
  → 声明式键绑定层
  → 基于上下文的优先级：活跃上下文（如 "Autocomplete"、"Chat"）优先于 "Global"
  → 支持和弦序列："ctrl+k ctrl+s" 风格的多键组合
```

### 6.2 默认键绑定 (`src/keybindings/defaultBindings.ts`)

**全局上下文:**
| 快捷键 | 动作 |
|--------|------|
| `Ctrl+C` | 中断 |
| `Ctrl+D` | 退出 |
| `Ctrl+L` | 重绘 |
| `Ctrl+T` | 切换待办事项 |
| `Ctrl+O` | 切换转录 |
| `Ctrl+R` | 历史搜索 |

**聊天上下文:**
| 快捷键 | 动作 |
|--------|------|
| `Escape` | 取消 |
| `Enter` | 提交 |
| `Up/Down` | 历史导航 |
| `Ctrl+_` / `Ctrl+Shift+-` | 撤销 |
| `Ctrl+X Ctrl+E` / `Ctrl+G` | 外部编辑器 |
| `Ctrl+S` | 暂存 |
| `Ctrl+V`（非 Windows）/ `Alt+V`（Windows）| 图片粘贴 |

### 6.3 文本编辑快捷键

**Ctrl 组合:**
| 快捷键 | 动作 |
|--------|------|
| `Ctrl+A` | 行首 |
| `Ctrl+E` | 行尾 |
| `Ctrl+K` | 删除到行尾 |
| `Ctrl+U` | 删除到行首 |
| `Ctrl+W` | 删除单词 |
| `Ctrl+Y` | 粘贴（yank） |
| `Ctrl+H` | 删除前一个 token |

**Meta 组合:**
| 快捷键 | 动作 |
|--------|------|
| `Meta+B` | 上一个单词 |
| `Meta+F` | 下一个单词 |
| `Meta+D` | 删除后一个单词 |
| `Meta+Y` | 粘贴循环（yank-pop） |

### 6.4 双击检测 (`useDoublePress`)

- 800ms 时间窗口内的双击检测
- 用于 Ctrl+C、Ctrl+D 和 Escape
- 第一次按下显示通知，第二次在超时内执行动作

---

## 七、自动补全系统 (`useTypeahead`)

### 7.1 Token 检测

### 7.1 Token 检测

通过正则表达式模式在光标位置识别：
- `@file` - 文件路径补全
- `#channel` - Slack 频道建议
- `/command` - 斜杠命令建议
- `$variable` - Shell 变量补全
- `@user` - 用户提及

### 7.2 补全源

- 斜杠命令建议 (`generateCommandSuggestions`)
- 文件/目录补全 (`getPathCompletions`、`getDirectoryCompletions`)
- Shell 补全 (`getShellCompletions`)
- Shell 历史补全
- 统一建议 (`generateUnifiedSuggestions`)

### 7.3 导航

- `Tab`/`Enter` 接受
- `Up`/`Down` 循环选择
- `Escape` 关闭
- 选择保留：建议更新时，`getPreservedSelection` 尝试通过匹配 ID 保持相同项目选中

---

## 八、状态管理架构

### 8.1 三层状态系统

```
Layer 1: 全局模块单例状态 (src/bootstrap/state.ts)
  → 纯 JavaScript 对象，完全在 React 之外
  → 通过导出的 getter/setter 函数访问
  → 无 React 订阅机制

Layer 2: React Store (src/state/)
  → 自定义 Store<T> 实现
  → getState / setState / subscribe
  → 使用 Object.is 进行身份检查

Layer 3: React Hooks + 外部 Store
  → useAppState(selector) 使用 useSyncExternalStore
  → 选择器模式确保仅在所选值变化时重新渲染
```

### 8.2 全局状态 (`src/bootstrap/state.ts`)

DAG 叶节点 - 几乎不从代码库其他部分导入（仅 `crypto`、`lodash` 和类型导入），避免循环依赖。

包含：
- **会话标识**: `sessionId`、`parentSessionId`、`projectRoot`、`cwd`
- **成本/使用量跟踪**: `totalCostUSD`、`totalAPIDuration`、`totalToolDuration`、`modelUsage`
- **遥测**: OpenTelemetry `meter`、`loggerProvider`、`tracerProvider`
- **功能标志**: `isInteractive`、`kairosActive`、`sessionBypassPermissionsMode`
- **Beta 头部锁存**: `afkModeHeaderLatched`、`fastModeHeaderLatched` 等（防止提示缓存失效）
- **API 状态**: `lastAPIRequest`、`lastAPIRequestMessages`、`lastMainRequestId`

### 8.3 AppState Store (`src/state/AppStateStore.ts`)

中央 React 级状态：
- **UI 状态**: `expandedView`、`viewSelectionMode`、`activeOverlays`
- **模型**: `mainLoopModel`、`mainLoopModelForSession`
- **工具权限**: `toolPermissionContext`
- **MCP**: `mcp.clients`、`mcp.tools`、`mcp.commands`、`mcp.resources`
- **插件**: `plugins.enabled`、`plugins.disabled`、`plugins.commands`
- **任务**: `tasks`、`todos`、`agentNameRegistry`
- **推测**: `speculation`、`speculationSessionTimeSavedMs`
- **通知**: `notifications.current`、`notifications.queue`
- **桥接状态**: `replBridgeEnabled`、`replBridgeConnected` 等
- **团队上下文**: `teamContext`、`inbox`、`workerSandboxPermissions`

### 8.4 消息状态管理

消息通过 `useState<Message[]>` 管理（不在全局 store 中）。这是一个刻意的选择 - 消息是高频的，store 的 `Object.is` 比较会导致不必要的重新渲染。

---

## 九、权限系统

### 9.1 权限请求路由 (`PermissionRequest.tsx`)

通过 `permissionComponentForTool(tool)` 将工具映射到权限组件：

| 工具 | 权限组件 |
|------|----------|
| `FileEditTool` | `FileEditPermissionRequest` |
| `FileWriteTool` | `FileWritePermissionRequest` |
| `BashTool` | `BashPermissionRequest` |
| `WebFetchTool` | `WebFetchPermissionRequest` |
| `NotebookEditTool` | `NotebookEditPermissionRequest` |
| `SkillTool` | `SkillPermissionRequest` |
| `AskUserQuestionTool` | `AskUserQuestionPermissionRequest` |
| `GlobTool`/`GrepTool`/`FileReadTool` | `FilesystemPermissionRequest` |
| 未知工具 | `FallbackPermissionRequest` |

### 9.2 权限处理模式

- **交互式处理器** (`interactiveHandler.ts`): 向用户显示权限对话框
- **协调器处理器** (`coordinatorHandler.ts`): 委托给协调器
- **蜂群工作者处理器** (`swarmWorkerHandler.ts`): 通过邮箱向团队领导发送权限请求

### 9.3 权限模式

`PermissionMode` 决定权限模型：
- `'default'` - 默认模式
- `'plan'` - 计划模式
- `'bypassPermissions'` - 绕过权限
- `'acceptEdits'` - 接受编辑
- `'auto'` - 自动模式

---

## 十、Spinner 与动画系统

### 10.1 Spinner 架构

```
Spinner.tsx (主编排器)
  → SpinnerWithVerb / BriefSpinner / BriefIdleStatus / Spinner
  → 处理思维状态、任务列表、提示、预算显示、队友树

SpinnerAnimationRow.tsx (动画行)
  → 字形动画 + 闪烁文本 + 经过时间 + Token 计数器 + 停滞检测 + 思维发光

SpinnerGlyph.tsx (旋转字形字符)
  → 循环遍历默认字符及其反转

GlimmerMessage.tsx / ShimmerChar.tsx / FlashingChar.tsx
  → 字符级闪烁效果
```

### 10.2 动画驱动

- `useAnimationFrame(interval)` 钩子驱动所有动画（Spinner 行 50ms，简略模式 120ms）
- `useShimmerAnimation` 计算文本上的移动高亮索引
- `useStalledAnimation` 检测 Token 停止流动（3 秒无新 Token），将 Spinner 变红
- 所有动画尊重 `prefersReducedMotion` 设置

### 10.3 SpinnerMode 类型

```typescript
type SpinnerMode = 'thinking' | 'streaming' | 'tool'
```

---

## 十一、Overlay 与模态系统

### 11.1 Overlay 上下文 (`src/context/overlayContext.tsx`)

- `useRegisterOverlay(id, enabled)`: 任何覆盖层组件调用此函数在 `AppState.activeOverlays` Set 中注册自身
- `useIsOverlayActive()`: 返回是否有任何覆盖层打开，用于防止用户只想关闭覆盖层时取消请求
- `useIsModalOverlayActive()`: 返回是否有任何非自动补全覆盖层打开，用于在模态对话框活跃时禁用 TextInput 焦点

### 11.2 非模态覆盖层

自动补全被明确列为非模态（`NON_MODAL_OVERLAYS`），允许在显示建议时继续输入。

### 11.3 Select 组件 (`src/components/CustomSelect/select.tsx`)

- 支持 `OptionWithDescription<T>`，包含文本或内联输入类型
- 布局模式：`compact`（每选项一行）、`expanded`（多行带间距）、`compact-vertical`（索引 + 下方描述）
- 特性：`visibleOptionCount`（可滚动视口）、`highlightText` 模糊高亮、`hideIndexes`、`disableSelection`
- 内联输入选项：可在选择列表中嵌入可编辑文本字段

---

## 十二、全屏布局 (`FullscreenLayout`)

### 12.1 布局结构

- ScrollBox + 底部插槽 + 覆盖层 + 模态窗格 + 粘性头部 + "N 条新消息"药丸 + 未读分隔符跟踪
- 使用绝对定位的覆盖层
- 模态窗格带有 `▔` 分隔线，绘制在 ScrollBox 和底部插槽之上
- 通过 `useTerminalViewport` 支持鼠标跟踪

### 12.2 滚动键盘处理 (`ScrollKeybindingHandler`)

- `j`/`k` - 逐行滚动
- `PgUp`/`PgDn` - 逐页滚动
- `Home`/`End` - 跳转到顶部/底部

---

## 十三、终端集成

### 13.1 终端能力

| 功能 | 实现 |
|------|------|
| 响应式布局 | `useTerminalSize()` |
| 终端标题 | `useTerminalTitle()` |
| 焦点跟踪 | `useTerminalFocus()` |
| 标签页状态 | `useTabStatus()` (OSC 集成) |
| 剪贴板访问 | `setClipboard()` via OSC |
| 桌面通知 | `useTerminalNotification()` |
| 终端能力检测 | `TerminalQuerier` (`src/ink/terminal-querier.ts`) |
| OSC 支持检查 | `supportsTabStatus()` |
| 按键解析 | `src/ink/parse-keypress.ts` |

### 13.2 自定义 Ink 层 (`src/ink/`)

这是一个大幅定制的 Ink 分支/重新实现：

| 文件 | 大小 | 用途 |
|------|------|------|
| `ink.tsx` | 254KB | 核心 Ink 渲染器 - 协调器、DOM、树差异比较 |
| `screen.ts` | 51KB | 屏幕管理、备用屏幕缓冲区 |
| `render-node-to-output.ts` | 65KB | 节点到终端输出的渲染 |
| `render-to-screen.ts` | - | 带闪烁检测的屏幕渲染 |
| `render-border.ts` | - | 使用 box-drawing 字符的边框渲染 |
| `output.ts` | 27KB | 终端输出管理 |
| `log-update.ts` | 28KB | 高效终端覆写的日志更新 |
| `reconciler.ts` | 15KB | 终端 DOM 的 React 协调器 |
| `dom.ts` | 16KB | 终端元素的虚拟 DOM |
| `styles.ts` | 22KB | 样式解析（颜色、内边距、边框、外边距） |
| `selection.ts` | 36KB | 终端中的文本选择 |
| `parse-keypress.ts` | 24KB | 按键解析 |
| `ansi.tsx` | 34KB | ANSI 转义序列渲染 |

**新增组件:**
- `ScrollBox` - 可滚动容器
- `AlternateScreen` - 备用屏幕缓冲区
- `NoSelect` - 禁止选择的区域
- `RawAnsi` - 原始 ANSI 输出
- `Button`、`Link` - 交互元素

**新增钩子:**
- `useAnimationFrame` - 动画帧
- `useSelection` - 文本选择
- `useTabStatus` - 标签页状态
- `useTerminalFocus` - 终端焦点
- `useTerminalTitle` - 终端标题
- `useTerminalViewport` - 终端视口

---

## 十四、性能优化策略

### 14.1 React 编译器

代码库使用 `react/compiler-runtime` 进行自动记忆化（编译输出中可见 `_c(12)` 模式）。这就是为什么许多组件缺少显式 `useMemo`/`useCallback` 的原因。

### 14.2 功能标志与死代码消除

通过 `feature('KAIROS')`、`feature('VOICE_MODE')`、`feature('COORDINATOR_MODE')` 等进行条件导入，实现构建时死代码消除。

### 14.3 Ref 密集型性能优化

消息数组、时间引用和动画状态保存在 ref 中以避免重新渲染。REPL 组件（903KB）是最关键的性能热点，大量使用 `useSyncExternalStore`、`useDeferredValue` 和基于 ref 的手动缓存。

### 14.4 离屏冻结

`OffscreenFreeze` 组件防止已滚动出视口的消息重新渲染，优化长对话的性能。

### 14.5 虚拟滚动

`VirtualMessageList` 实现带高度缓存的虚拟滚动，在列宽变化时失效。冷启动批处理限制每次提交的成本。

### 14.6 懒加载

`launchRepl()` 动态导入 `App` 和 `REPL`。许多子功能使用条件 `require()` 进行死代码消除。

---

## 十五、REPL 对话流

### 15.1 查询流程

```
1. 用户通过 handlePromptSubmit() 提交输入
2. 输入经过 processUserInput 确定是命令、斜杠命令还是用户提示
3. QueryGuard 保留槽位（防止并发查询）
4. 调用 query()，传入消息数组、系统提示、工具等
5. API 流式返回响应；handleMessageFromStream 处理每个块
6. 工具使用收集为 StreamingToolUse[] 并在 Spinner 中显示
7. 流完成后，追加工具结果，可能触发新查询（用于工具使用循环）
8. 在回合开始时调用 snapshotOutputTokensForTurn() 进行预算跟踪
```

### 15.2 命令队列 (`messageQueueManager.ts`)

中央消息总线：
- **优先级**: `'now'`（用户输入）> `'next'`（正常）> `'later'`（任务通知）
- `useQueueProcessor` 监视队列，在没有活跃查询时排空它
- 桥接入站消息、cron 触发和队友消息都通过此队列路由

### 15.3 会话持久化

- `useLogMessages` 增量追加消息到转录 `.jsonl` 文件
- 跟踪 `lastRecordedLengthRef` 和 `firstMessageUuidRef` 以检测压缩 vs 增量追加
- 会话恢复读取 `.jsonl` 并通过 `deserializeMessages()` 反序列化消息

---

## 十六、关键钩子分类索引

### 核心 REPL / 对话流钩子

| 钩子 | 用途 |
|------|------|
| `useQueueProcessor` | 当无活跃查询且无 JSX UI 阻塞时处理排队命令 |
| `useCommandQueue` | 通过 `useSyncExternalStore` 订阅统一命令队列 |
| `useMainLoopModel` | 订阅活跃模型并在 GrowthBook 刷新时重新解析 |
| `useCancelRequest` | 注册 `chat:cancel` 和 `app:interrupt` 键绑定处理器 |
| `useSessionBackgrounding` | 处理 Ctrl+B 后台/前台会话切换 |
| `useLogMessages` | 增量追加消息到会话转录文件 |
| `useVirtualScroll` | 消息列表的虚拟滚动 |

### 输入 / 历史钩子

| 钩子 | 用途 |
|------|------|
| `useHistorySearch` | Ctrl+R 反向历史搜索 |
| `useInputBuffer` | 带防抖推送的撤销缓冲区 |
| `useArrowKeyHistory` | Up/Down 箭头键历史导航 |
| `useTextInput` | 核心文本输入状态 |
| `usePasteHandler` | 粘贴事件和多行文本输入 |
| `useTypeahead` | 输入的自动补全行为 |

### 工具 / 权限钩子

| 钩子 | 用途 |
|------|------|
| `useCanUseTool` | 工具使用的中央权限门控 |
| `useMergedTools` | 组合内置工具与 MCP 工具 |
| `useMergedCommands` | 合并内置斜杠命令与 MCP 提供的命令 |

### UI / 视觉钩子

| 钩子 | 用途 |
|------|------|
| `useBlink` | 光标/Spinner 的闪烁动画 |
| `useTerminalSize` | 订阅终端大小变化事件 |
| `useMinDisplayTime` | 确保加载 Spinner 的最小显示时间 |
| `useElapsedTime` | 跟踪经过时间用于显示 |

---

## 十七、组件文件统计

- **总组件文件数**: ~406 个
- **消息类型组件**: ~30+ 个
- **权限组件**: ~20+ 个
- **对话框/覆盖层组件**: ~30+ 个
- **设计系统组件**: ~15 个
- **Spinner/动画组件**: ~10 个
- **MCP 组件**: ~8 个
- **代理/蜂群组件**: ~10 个
- **后台任务组件**: ~10 个

---

## 十八、架构设计模式总结

1. **React 编译器自动记忆化** - 减少手动优化负担
2. **功能标志死代码消除** - 构建时裁剪未使用功能
3. **三层状态管理** - 全局单例 + React Store + Hooks
4. **Ref 密集型性能优化** - 避免不必要的重新渲染
5. **声明式键绑定系统** - 基于上下文的优先级和和弦序列
6. **虚拟滚动 + 离屏冻结** - 长对话的高效渲染
7. **自定义 Ink 分支** - 扩展终端能力（滚动、选择、点击、焦点）
8. **模块单例模式** - 避免循环依赖的 DAG 叶节点设计
9. **懒加载 + 条件导入** - 优化启动时间和包大小
10. **统一命令队列** - 中央消息总线处理所有异步输入源
