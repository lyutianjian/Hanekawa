# Hanekawa 桌面端适配 — 进度与待办

> 交接文档。新 session 从这里开始读，不需要回溯之前的对话。
> 详细的阶段 0 实施计划存档在 `C:\Users\Miyano\.claude\plans\deep-rolling-flamingo.md`。

**状态标记**：`[x]` 已完成并验证 · `[~]` 部分完成 · `[ ]` 未开始 · `[!]` 需要人工介入

---

## 背景与目标

TUI 的优化已经触及终端本身的天花板：`transcript.ts`(576 行) 整个存在的理由只有 Ink `<Static>` 输出不可回收这一条约束，`layout.ts`(462 行) 是在手工重算每个组件的行高。这两类问题在 DOM 里根本不存在。

**目标**：让现有 agent 内核能被桌面 app（Electron）复用，TUI 与桌面端共享同一套 headless 运行时。

**已确认的有利结论**（实测，非估计）：

- `src/` 中 `tui/` 之外：import `ink` 或 `tui/` 的文件数 **0**；使用 `process.stdout/stdin/readline/isTTY` 的 **0**；出现 ANSI 转义的 **0**。
- 核心（harness/tools/config/sessions/services/prompts/commands/utils）约 **24.8k 行**，对 UI 完全无知；`src/tui/` 约 14.7k 行，其中约 **10.4k 是纯终端资产**（components/ + transcript/layout/ink/ansi/Markdown/cursorParking/diff/fileToolPreview），桌面端不迁移、直接丢弃。
- 跨界数据 `SessionRecord` 天生 JSON 可序列化（已在 JSONL 落盘），工具展示钩子返回纯字符串 → Electron 主/渲染进程分离几乎不需要新序列化层。

**技术选型**：Electron 而非 Tauri。依赖面（`child_process`、MCP SDK stdio transport、fast-glob、shadow-git、patch-package）全是 Node；Tauri 需要 Node sidecar，等于 Electron 但更绕。

---

## 阶段 0 — 抽出 headless 运行时 `[x]` 已完成

把 `src/tui/entrypoints/tui.tsx` 里与终端无关的装配逻辑搬进新的 `src/runtime/`，TUI 成为它的第一个消费者，**运行时行为零变化**。

### 产出

- [x] `src/runtime/types.ts` — `AgentSession`、`RuntimeHost`、`BootstrapOptions`
- [x] `src/runtime/errors.ts` — `RuntimeStartupError`（带 `code`），取代 10 处 `process.exit`
- [x] `src/runtime/bridges.ts` — 5 个 UI proxy 工厂 + `createUiBridges()`（从 `src/tui/hooks/*` 移出，hooks 保留 React 部分并转发导出）
- [x] `src/runtime/toolRegistry.ts` — 工具集所有者，保住 splice 数组同一性语义
- [x] `src/runtime/mcp.ts` — MCP 连接循环，trust 提示改为注入的 `confirmTrust` 回调
- [x] `src/runtime/createRuntime.ts` — 运行时工厂，闭包变量→显式 deps
- [x] `src/runtime/bootstrap.ts` — 启动装配，返回 `RuntimeHost`
- [x] `src/runtime/index.ts` — 公开导出
- [x] `tui.tsx` 597 → **177 行**（只剩 TTY 守卫、focus filter、argv/list/session 解析、`bootstrap()`、错误打印、消息拼装、`render()`、readline trust 提示）
- [x] `App.tsx` 仅 3 行改动：import + `AppRuntime` 改为 `AgentSession` 别名 + runtime 字面量补 `run` 委托。`src/tui/components/` 其余零改动。
- [x] 删除死代码 `activeLoops`（全仓库只写不读）

### 验证

- [x] `npx tsc --noEmit` 干净
- [x] `npm run test` — **1386 passed / 0 failed**（新增 12 个）
- [x] `test/toolRegistry.test.ts`（5 个）：数组引用同一性、Agent 工具刷新后唯一且在末尾、`unregister` 后不再被触碰、单服务器替换不影响其他
- [x] `test/runtimeBootstrap.test.ts`（7 个）：启动错误码、effort 钳制、runtime 元数据、权限 bridge 接进 gate、MCP 拒信任 fail-open、可恢复中断检测
- [x] `test/tuiCursorSource.test.ts`（对 `tui.tsx` 做源码字符串匹配）仍绿 — `render` 按计划留在入口
- [x] **手动冒烟未执行**：`npm run dev:tui` → 跑一个 turn → 权限弹窗 → `/model` 切换 → `/clear` → `/resume` → Ctrl+C 中断 → 退出无残留进程。需要 TTY + 真实 API key，请本地过一遍。
- [x] **MCP 冒烟未执行**：若本机有 MCP 配置，确认状态行文案与改动前逐字一致、trust 提示仍在 Ink 挂载前出现、断线重连后工具数恢复。

### 阶段 0 遗留的可选项

- [x] 把 `src/tui/providerRuntime.ts` 和 `src/tui/permissionMode.ts` 里的三个纯函数移入 `src/runtime/` — 已随阶段 1 完成（展示字符串 `permissionModeStatusLabel` / `permissionModeTitle` 留在 `src/tui/permissionMode.ts`）。

---

## 阶段 0.5 — 缺陷清理与阶段 1 机械前置 `[x]` 已完成

commit `9151326`（会话绑定）+ `093d3ac`（队列实例化 / cwd 参数化）。

### 已修的缺陷

- [x] **#1 `denialStateStore` 绑死初始 session** — `bootstrap.ts` 改为闭包持有可变 `activeSessionId`，由新的 `CreateRuntimeDeps.onActiveSessionChange` 在每次 `createRuntime` 时更新。附带发现并修掉：`PermissionGate.hydrateDenialState()` 的 `denialStateLoaded` 是一次性闩，会话切换后旧 session 的 streak 会被**写进新 session**；新增 `PermissionGate.resetDenialState()` 在会话切换时调用。
- [x] **#5 `setPlanSlugProvider` 最后一个 runtime 胜出** — 新增 `PermissionGate.clearPlanSlugProvider(provider)`，按**函数身份**守卫后在 `dispose()` 里拆卸，晚到的 dispose 无法清掉新 runtime 的 provider。
- [x] **#3 `syncActiveModel` 构造并丢弃整个 runtime** — 改为 `providerConfig.getModel(modelKey)`。另修掉一个原实现里的隐藏 bug：`{...nextRuntime}` 展开把 `run` 一起复制了，导致 fallback 激活后 `runtime.run` 指向**已 dispose 的 loop**（App 目前只用 `runtime.loop`，所以没炸）。
- [x] **#2 `sessionRecords` 启动后不再刷新** — 拆成两份：`sessionRecords` state 仍是「transcript 上次重建时的记录」（`useAgentLoop` 的 effect 依赖它的身份，不能随记录到达而变，否则每条记录都会清零 usage 累计）；新增 `sessionRecordsRef` 由 `onRecordExternal` 按 id 去重追加，喂给三处 `createRuntime`。`/rewind` 只重置 ref（`rebaseSessionRecords`），不动 state，避免连带清零 usage。

### 已完成的阶段 1 前置

- [x] `messageQueue.ts` 模块级 5 个 `let` → `class MessageQueue`，由 `App` 持有。`subscribe`/`getSnapshot` 用箭头字段绑定，`useSyncExternalStore` 拿到稳定身份。`initializeMessageQueue`(resume) → `reset`，`migrateMessageQueue` → `migrateTo`。**非测试消费者只有 `App.tsx`**（`MessageList.tsx` 只 import 类型）。
- [x] cwd 参数化：
  - `services/sessionMemory/service.ts` 全部磁盘函数加 `cwd?`，并改用 `utils/paths.ts` 的 `getMyAgentDir(cwd)`（原本有个重复实现）。cwd 沿 `loop.ts` → `harness/compact.ts`(`CompactCheckInput.cwd`) → `SessionMemoryCompactParams.cwd` / `ExtractSessionMemoryParams.cwd` 贯通。
  - `utils/pathCompleter.ts` → `filePathCompleter(line, cwd = process.cwd())`，`path.resolve(directory)` 改为 `path.resolve(cwd, directory)`。
  - `services/context/projectContext.ts` 单槽缓存 → `Map<cwd, string>`；`clearProjectContextCache(cwd?)` 支持定向失效。
  - `harness/cacheBreakDetection.ts` **未走参数**：检测跑在 provider 内部，provider 没有 cwd。改为 `setCacheBreakDiagnosticsRoot(cwd)`，由 `bootstrap()` 调一次。该模块的快照 Map 本来就是进程级的，要真正按项目隔离得把整个模块分区 —— 那是另一件事。

### 验证

- [x] `npx tsc --noEmit` 干净
- [x] `npm run test` — **1394 passed / 0 failed**（新增 8 个）
- [x] 新增用例：`permissions.test.ts` ×2（slug provider 身份守卫、denial state 重置）、`runtimeBootstrap.test.ts` ×1（否决计数跟随最新 runtime 的 session）、`messageQueue.test.ts` ×2（retarget、双实例互不干扰）、`shortcuts.test.ts` ×1（不读 `process.cwd()`）、`sessionMemory.test.ts` ×1（同 session id 跨项目隔离）、`contextBuilder.test.ts` ×1（双 cwd 缓存不互相驱逐）
- [x] 手动冒烟仍未执行，见阶段 0

---

## 阶段 1 — 应用逻辑下沉为 `SessionController` `[x]` 已完成

把困在 React hooks 里的框架无关逻辑抽成事件流式的 `SessionController` + `RuntimeSlot`，hooks 退化成 `useSyncExternalStore` 消费者与事件订阅者。TUI 运行时行为零变化。

### 产出

- [x] `src/runtime/sessionController.ts` — turn 生命周期、AbortController、checkpoint、usage 累计、工具进度关联、中断回滚。独占 `RecordProxy` 三个 handler，对外只有 `onEvent(SessionEvent)` 单条流 + `subscribe`/`getSnapshot` 快照（`isStreaming`/`usage`/`taskSnapshot`/`spinnerSubText`）。
  - **不用 `node:events`**：事件种类固定且阶段 2 要整条走 IPC，单条 union 流能被 TypeScript 穷尽检查。
  - `turn-end` 带的是 `aborted`（signal 状态）而非「是否抛异常」—— 失败的 turn **不是** aborted，仍然要出 `✻ Worked for Xs`。
  - `transcript-reset` 带 `bumpGeneration`：回滚路径为 `false`（不能 remount `<Static>`），`reload()` 路径为 `true`。
- [x] `src/runtime/runtimeSlot.ts` — runtime + effort 归属。`replace()` 先装新的再 dispose 旧的；`patchModel()` 承接 fallback 元数据；`setEffort()`（用户动作，调用方负责持久化）与 `reapplyEffort()`（换 runtime 后重钳，不持久化）统一了原本散在 `App.tsx` 三处的 clamp 代码。
- [x] `src/runtime/queuePump.ts` — `canPumpQueue()` 把「turn 进行中」与「UI 被占用」拆成两个维度。
- [x] `src/runtime/{toolProgress,sessionUsage,interruptRollback,permissionMode,providerRuntime}.ts` — 从 `src/tui/` 搬入的纯模块。
- [x] `useAgentLoop.ts` 687 → **378 行**：只剩 transcript 状态、`transcriptGeneration`、`handleStreamEvent` 与 thinking 预览、4 个 spinner ref、`formatWorkedSummary`。
- [x] `App.tsx` 1298 → **1247 行**：删掉 `runtime` state / `runtimeRef` / `replaceRuntime` / `effortLevel` state / 第二个 `CheckpointService`。
- [x] `tui.tsx` 新建 `RuntimeSlot` 与 `SessionController` 并作为 prop 传入，`App` 的 6 个 runtime 相关 prop 合并成 2 个。

### 「React 是唯一真相源」清单 — 全部解决

| 项 | 处理 |
|---|---|
| token/费用累计 | 归 `SessionController`，remount 不再归零；resume 仍从零开始（与改动前一致，已确认不做落盘恢复）|
| `runtime` 实例 | 归 `RuntimeSlot`，替换顺序由 `test/runtimeSlot.test.ts` 钉住 |
| `effortLevel` | 归 `RuntimeSlot`，clamp 与 `loop.setEffort` 一处收口 |
| 两个 `CheckpointService` | 合一，由 controller 持有且 `init()` 过；restore 面板改读 `getCheckpointService()` |

### 验证

- [x] `npx tsc --noEmit` 干净
- [x] `npm run test` — **1415 passed / 0 failed**（新增 21 个）
- [x] `test/sessionController.test.ts`（11 个）：成功 turn 的事件顺序（`turn-start` 早于 `loop.run`）、失败 turn 的 `aborted === false`、回滚与非回滚两条中断路径、usage 累加与 `retarget` 归零、工具进度文案与 `listContent`、subagent 进度关联、`approvalToolUseId` 匹配、taskSnapshot 入快照、`dispose()` 摘钩、checkpoint init 失败时跳过
- [x] `test/runtimeSlot.test.ts`（7 个）、`test/queuePump.test.ts`（3 个）
- [x] **手动冒烟未执行**（需 TTY + 真实 key）。按风险逐条走：含工具调用的 turn → 工具执行中途 Ctrl+C（输入框回填、无残留用户消息）→ 模型刚回答时 Ctrl+C（显示 `Interrupted.`）→ 制造 API 错误（仍有 `✻ Worked for Xs`）→ `/model` 切换后 `/cost` 连续且 effort 被新模型钳制 → `/rewind` 能列出 checkpoint → 连发三条看队列排空 → `/clear` 与 `/resume` 后 usage 归零 → Ctrl+C 退出无残留进程。


---

## 阶段 2 — Electron 外壳 `[ ]` 未开始

- [ ] 主进程 = 现有 Node 全栈 + `bootstrap()` + `RuntimeSlot`/`SessionController`；渲染进程 = 新 UI，**绝不 import harness**（Bash + fs 工具跑在开了 nodeIntegration 的渲染进程是安全灾难）
- [ ] IPC 载荷就是 `SessionEvent` 流（单向推送，已按可序列化设计）+ 5 类 UI 请求（权限、AskUserQuestion、进入/退出 plan、record 回推）；`SessionControllerSnapshot` 走同一通道做 pull 状态
- [ ] **权限提示跨进程的生命周期要重设计**：`createPromptProxy` 初始值是 `async () => false`（静默拒绝）。TUI 里这窗口只有几毫秒，桌面端渲染进程慢启动或窗口被关会误拒。要改成「排队等待 UI」，并保留 `denyPending()` 语义在窗口销毁时兜底 resolve，否则 `ToolRunner` 永久挂起。
- [ ] 中断信号跨不了 IPC：`signal.reason === 'user-cancel'` 是进程内 sentinel，渲染进程只能发 `{sessionId, turnId}`，由主进程持有 `AbortController`。任何新的 `await toolRunner.run` 路径必须检查 `errorCode === 'aborted'` 并转成抛出的 `AbortError`。
- [ ] `SessionStore` 的锁是进程内静态 map，**无跨进程安全**。桌面 app 与 CLI 同时开同一项目会并发写，需要文件锁或单写入者。
- [ ] MCP trust 提示改为桌面 UI 流程（当前 readline 实现留在 `tui.tsx`，通过 `BootstrapOptions.confirmMcpTrust` 注入，桌面端换实现即可）
- [ ] 无需迁移：Ink patches（CJK 换行 + wrap-ansi 那对补丁）、focus filter、alt-screen、`transcript.ts`、`layout.ts`

---

## 阶段 3 — 桌面独有能力 `[ ]` 未开始

- [ ] 多标签会话 / 多项目窗口（cwd 参数化、队列实例化、`SessionController`/`RuntimeSlot` 均已就绪；剩下的是每标签一套 slot+controller 的容器与生命周期）
- [ ] diff 面板、文件树等 DOM 才划算的 UI

---

## 已知缺陷（发现但**未修**）

按修复价值排序：

1. `settings` 与 `skills` 启动后不再重载（而 `agentDefinitions` 会重载），行为不一致。
2. `ToolRegistry.refresh()` 后 Agent 工具会被移到数组末尾（继承自原实现）。工具顺序影响 prompt 缓存，改之前想清楚。
3. **三条启动错误分支实际不可达**：`unknown_initial_model` / `unknown_fallback_model` / `unknown_compact_model`。`resolveModelReference` 只返回已通过 `resolveModel` 校验的 key，未知名字直接返回 `undefined`。已按行为零变化原则保留为守卫，测试只覆盖真正可达的 `invalid_settings` 和 `no_default_model`。
4. `cacheBreakDetection` 的诊断根目录是进程级的（见阶段 0.5）。多项目桌面端下，最后一个 `bootstrap()` 胜出。要真正隔离得把 `previousSnapshots` / `pendingChangesBySource` 一起按项目分区。

---

## 新 session 接手须知

**必读**：`CLAUDE.md`（架构与不变式）、`src/runtime/index.ts`（新门面的全部导出）。

**改动 `src/runtime/` 时的红线**：

- `ToolRegistry` 必须用 `splice` 原地改写数组，**不能重新赋值** — 同一个数组引用被 Agent 工具的 `tools: () => runtimeTools` 闭包、`ToolRunner`、`AgentLoop` 三处持有且无法重新指向。`test/toolRegistry.test.ts` 钉住了这一点。
- `bootstrap()` 里的步骤顺序有意义：MCP 连接必须在 `registerBuiltinCommands()` 之前，且整个 `bootstrap()` 必须在 Ink `render()` 之前完成（trust 提示要抢在 Ink 接管 stdin 前）。
- 5 个 bridge 的 pre-mount 兜底值各不相同且都是刻意的：权限=拒绝、AskUserQuestion=拒绝、退出 plan=拒绝、**进入 plan=批准**、record=丢弃。不要"统一"它们。
- `createRuntime` 里的 `onActiveSessionChange?.(runtimeSession.id)` 放在所有会抛的校验**之后**：模型 key 无效时不能已经把会话级状态切过去了。
- `RuntimeSlot.replace()` 必须先装新 runtime 再 dispose 旧的：晚到的 dispose 会拆掉继任者的 plan-slug provider。
- `SessionController` **独占** `RecordProxy` 的三个 setter。UI 只能 `onEvent` 订阅，不能自己 `setHandler`，否则记录会被处理两次。
- `SessionEvent` 的 `turn-end.aborted` 是 signal 状态，不是「是否抛异常」；`transcript-reset.bumpGeneration` 只在真正换了会话视图时为 `true`。

**验证命令**：

```bash
npm run typecheck
npm run test                                          # 1415 tests / 35 suites, ~38s
node --import tsx --test test/sessionController.test.ts test/runtimeSlot.test.ts test/queuePump.test.ts
node --import tsx --test test/toolRegistry.test.ts test/runtimeBootstrap.test.ts
npm run dev:tui                                       # 手动冒烟，需 TTY
```
