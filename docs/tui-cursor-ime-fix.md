# TUI 光标漂移 / IME 候选栏错位修复

## 问题描述

对话轮次增多后，TUI 中真实光标漂移到 InputBox 上方，导致 Windows 输入法（IME）候选栏错位、输入过程中字母跟随漂移。

## 根因分析

三层因果链：

### 1. thinking 消息驻留动态帧（触发条件）

`useAgentLoop.ts` 回合结束时调用 `commitLiveItemsExcludingThinking`，把非 thinking 项提交到 `<Static>`，但 **thinking-bearing 助手消息留在 `liveItems`**。下一条回复的完整内容（正文 + thinking + 工具调用结果）全部在动态帧中，长回复导致帧高超过终端行数。

### 2. ink 7.0.5 fullscreen 模式全屏重绘（放大器）

ink 的 `renderInteractiveFrame`（`node_modules/ink/build/ink.js`）检测到 `outputHeight >= viewportRows` 时：
- `outputToRender = output`（去掉尾部换行）
- `shouldClearTerminalForFrame` 恒为真 → 此后**每次 React commit** 都执行 `clearTerminal`（`ESC[3J`）+ 重写全量 `fullStaticOutput` + 动态帧
- 每次按键触发全屏清写 → 画面闪烁 + 光标全屏扫描

### 3. ink buildCursorSuffix off-by-one（直接原因）

`node_modules/ink/build/cursor-helpers.js` 的 `buildCursorSuffix` 假设光标在 `line = visibleLineCount`（输出以 `\n` 结尾时成立）。fullscreen 帧无尾部换行，光标实际在 `line = visibleLineCount - 1` → `moveUp` 多算一行 → 真实光标停在 InputBox 声明位置上方一行。IME 候选栏锚定在真实光标上，于是错位。

## 修复方案

### Part A: 根因修复 — thinking 消息全量提交到 Static

**文件：`src/tui/transcript.ts`**

新增 `commitAllLiveItemsToStatic` 函数，回合结束时把所有 liveItems（包括 thinking-bearing 助手消息）移入 staticItems。内部调用 `findRecentThinkingAssistant` / `findRecentCompletedToolCall` 维护 `TuiTranscriptState` 的元数据字段。

**文件：`src/tui/hooks/useAgentLoop.ts`**

- import 从 `commitLiveItemsExcludingThinking` → `commitAllLiveItemsToStatic`
- 回合结束调用从 `commitLiveItemsExcludingThinking` → `commitAllLiveItemsToStatic`
- `recentThinkingAssistant` 来源从 `findRecentLiveThinkingAssistant(transcript.liveItems)` → `transcript.recentThinkingAssistant`（state 字段，由 `commitAllLiveItemsToStatic` 和 `appendStaticTranscriptItem` 维护）
- 删除不再使用的 `findRecentLiveThinkingAssistant` 和 `isStreamingThinkingPreview` 函数

### Part B: Ctrl+O 原地展开 thinking（体验优化）

**文件：`src/tui/types.ts`**

`TUIDisplayItem` 的 `assistant` 类型新增 `expanded?: boolean` 字段。

**文件：`src/tui/components/App.tsx`**

- 新增 `expandedThinkingId` 状态 + `handleToggleExpandThinking` 回调
- `staticItems` 构建时注入 `expanded` 标记：`item.id === expandedThinkingId`
- `<Static key={...}>` 的 key 包含 `expandedThinkingId`，变化时触发 React 卸载重挂载 → ink 全量重渲染静态区 → thinking 在原位置以展开态呈现
- InputBox 在 `expandedThinkingId` 非空时隐藏（阻断输入）
- `isPermissionVisible` 包含 `expandedThinkingId`（阻断键盘快捷键）
- `isStreaming` 变为 true 时自动收起展开的 thinking

**文件：`src/tui/components/MessageList.tsx`**

- 新增 `expandedThinkingId` / `onToggleExpandThinking` props
- Ctrl+O handler 改造：thinking 项调用 `onToggleExpandThinking(id)`，tool/tool_group 仍走原有 live preview 路径
- 删除底部 fallback 渲染（原 `previewTarget?.kind === 'thinking'` 分支）
- `StaticDisplayItem` 传递 `expanded` 字段给 `DisplayItem`

### Part C: ink 7.0.5 off-by-one 补丁

**文件：`patches/ink+7.0.5.patch`**（patch-package 自动应用）

**`node_modules/ink/build/cursor-helpers.js`**

`buildCursorSuffix` 新增 `hasTrailingNewline = true` 参数。无尾部换行时 `cursorLine = visibleLineCount - 1`（修复 off-by-one）。`buildCursorOnlySequence` 透传该参数。

**`node_modules/ink/build/log-update.js`**

`createStandard` 和 `createIncremental` 两个渲染器均：
- 新增 `previousHasTrailingNewline` 状态
- render 时计算 `hasTrailingNewline = str.endsWith('\n')`
- 传递给所有 `buildCursorSuffix` 和 `buildCursorOnlySequence` 调用
- 在 clear/done/reset/sync 中正确重置

`buildReturnToBottom` 不需要修改——其公式 `down = previousLineCount - 1 - previousCursorPosition.y` 恰好兼容有/无尾部换行两种情况。

## 可能导致问题复发的后续改动

### 1. 将 thinking 消息重新放入 liveItems

如果某次改动让 thinking-bearing 助手消息在回合结束后重新驻留 liveItems（例如为了实现"原地展开"而不经过 Static 重渲染路径），帧溢出问题会立即复发。

**受影响的代码路径：**
- `commitAllLiveItemsToStatic` → 如果被改回 `commitLiveItemsExcludingThinking`
- `applyTuiRecordToTranscriptState` 中 `record.type === 'message'` 的 thinking 分支（line ~146-160）→ 如果改为不提交到 static

### 2. 升级 ink 依赖

ink 从 `7.0.5` 升级后，`patches/ink+7.0.5.patch` 会失效（patch-package 按版本号匹配）。新版本如果修了 off-by-one 则无需补丁；如果没修则需要重新制作补丁。

**检测方法：** 升级后在 fullscreen 帧（内容超过终端高度）中打字，观察 IME 候选栏是否对齐。

**缓解：** `package.json` 中 ink 版本已 pin 为 `^7.0.5`，patch-package 的 `postinstall` 脚本在补丁无法应用时会报错。

### 3. 修改 ink 渲染路径

以下改动会影响光标定位逻辑：
- 修改 `ink.tsx` 的 `render` 函数或 `CursorParkingController`
- 修改 `useDeclaredCursor` 的光标声明逻辑
- 改变 `<Static>` 的 key 生成策略（当前为 `${transcriptGeneration}-${expandedThinkingId}`）

### 4. 修改 InputBox 的行数计算

`layout.ts` 中的 `buildInputWindow` / `calculateInputBoxHeight` 影响 InputBox 实际占用行数。如果这些函数的返回值变了而 `expandedThinkingId` 的隐藏逻辑没同步调整，可能出现 InputBox 残留或闪烁。

### 5. 新增组件到动态帧

在 App.tsx 的 `<Static>` 和 `<InputBox>` 之间插入新组件（如新的 overlay、新的状态栏），会增加动态帧高度。如果新组件在流式期间持续渲染且行数不可控，可能重新导致帧溢出。

### 6. 修改 `commitAllLiveItemsToStatic` 的元数据维护

`commitAllLiveItemsToStatic` 内部调用 `findRecentThinkingAssistant` / `findRecentCompletedToolCall` 维护 state 字段。如果这两个函数的逻辑变了，或者新增了需要维护的元数据字段而忘记在提交函数中处理，Ctrl+O 展开或 recentCompletedToolCall 预览可能失效。

## 测试

```bash
# 运行 TUI 相关测试
node --import tsx --test test/tuiTranscript.test.ts test/tuiRender.test.ts test/tuiCursorParking.test.ts test/tuiCursorSync.test.ts test/tuiCursorSource.test.ts test/tuiLayout.test.ts

# TypeScript 类型检查
npx tsc --noEmit

# 端到端验证
bun run dev:tui
# 1. 诱发长回复（带 thinking），验证 IME 候选栏对齐
# 2. Ctrl+O 展开 thinking，验证原地展开 + InputBox 隐藏
# 3. 再按 Ctrl+O 收起，验证 InputBox 恢复
# 4. 展开状态下开始新对话，验证自动收起
```
