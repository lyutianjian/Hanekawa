# Hanekawa 桌面端适配 — 进度与待办

> 交接文档。新 session 从这里开始读，不需要回溯之前的对话。

**状态标记**：`[x]` 已完成并验证 · `[~]` 部分完成 · `[ ]` 未开始 · `[!]` 需要人工介入

---

## 背景与目标

TUI 的优化已经触及终端本身的天花板：`transcript.ts`(576 行) 整个存在的理由只有 Ink `<Static>` 输出不可回收这一条约束，`layout.ts`(462 行) 是在手工重算每个组件的行高。这两类问题在 DOM 里根本不存在。

**目标**：让现有 agent 内核能被桌面 app（Electron）复用，TUI 与桌面端共享同一套 headless 运行时。

**已确认的有利结论**（实测，非估计）：

- `src/` 中 `tui/` 之外：import `ink` 或 `tui/` 的文件数 **0**；使用 `process.stdout/stdin/readline/isTTY` 的 **0**；出现 ANSI 转义的 **0**。
- 核心（harness/tools/config/sessions/services/prompts/commands/utils）约 **24.8k 行**，对 UI 完全无知；`src/tui/` 约 14.7k 行，其中约 **10k 是纯终端资产**（components/ + transcript/layout/ink/ansi/Markdown/cursorParking），桌面端不迁移、直接丢弃。**`fileToolPreview` 当初被误列在这份「丢弃」名单里——它是纯数据的，阶段 2b-1 已移入 `src/services/` 并挂上权限 DTO；`diff.ts` 同样是纯数据，但词级 diff 是渲染器的事，留在 `src/tui/`。**
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

## 阶段 2a — 会话协议与 host `[x]` 已完成

Stage 2 里所有**跨进程风险**都与 Electron 无关，先把它们做完并测透，Electron 就只剩一层适配器 + 渲染进程 UI。本阶段**不引入任何新依赖**，TUI 仍直连 `SessionController`，行为不变。

### 产出

- [x] `src/runtime/protocol/channel.ts` — `RuntimeChannel`（`post`/`onMessage`/`onClose`/`close`）。Electron IPC、`child_process`、`MessagePort` 都满足它，模块本身不 import 任何一个。
- [x] `src/runtime/protocol/wire.ts` — `HostEvent` / `HostCommand` 两条 JSON-only union。三个不可序列化类型各有替身：
  - `WireRunOverrides` 替 `AgentRunOverrides`（`model` 变成 key，由 host 解析；**故意不含 `hooks`**，hooks 属于 host 侧 settings，客户端不得注入）
  - `WireRuntimeSnapshot` 替 `RuntimeSlotSnapshot`（投影成元数据，**剥掉 `apiKey`**）
  - `PermissionRequestDto` 替 `PermissionRequest`（`Tool` 只留 `toolName`/`riskLevel`，`onAlwaysAllow` 变成响应上的 flag）
- [x] `src/runtime/protocol/pendingRequests.ts` — id 键控的等待表，`settleAll` 是通道死亡时的兜底。
- [x] `src/runtime/protocol/host.ts` — `SessionHost`：转发事件与两个快照、接管 4 个 UI bridge、持有 `AbortController`、执行命令。
- [x] `src/runtime/protocol/client.ts` — `SessionClient`：镜像 `onEvent` + `subscribe`/`getSnapshot`，**逐字段 diff** 后才换快照对象。
- [x] `src/runtime/protocol/memoryChannel.ts` — 每次 `post` 走 `structuredClone`，不可克隆的载荷当场炸。
- [x] `src/runtime/protocol/nodeChannel.ts` — `child_process` 传输，与 Electron IPC 同一套结构化克隆语义。
- [x] `src/runtime/recordLedger.ts` — `SessionRecordLedger`，从 `App.tsx` 的 `sessionRecordsRef` 抽出的框架无关部分（TUI 仍持有自己那份）。
- [x] `bridges.ts`：**只有权限 bridge 改成排队**（见下），其余三个兜底值原样不动。

### 权限提示生命周期（`todo.md` 原 130 行）

- [x] `createPromptProxy` 的 `async () => false` 改为**排队等待 UI**，新增 `clearPrompt()` / `drainPending()`。终端里这个窗口只有几毫秒，桌面端渲染进程慢启动会误拒真实工具调用。
- [x] 四个 hook 的 unmount 现在都会**先结清自己 resolver map 里的在途请求**再摘钩。原先只有 `usePermission` 有 `denyPending` 且只挂在中断上，另外三个完全没有 drain —— UI 消失后 `PlanModeManager` / AskUserQuestion 会永远挂着。
- [x] **没有统一四个兜底值**：`test/useEnterPlanPermission.test.ts` 钉住了 enter-plan 的「预挂载自动批准」，headless 调用方依赖它；`todo.md:164` 也明确要求不要统一。只有权限 bridge 排队。
- [x] `SessionHost` 在 `channel.onClose` 时按 kind 分别结清（拒绝 / 拒绝 / **批准** / 拒绝）。这是唯一的兜底：`ToolRunner.run` **不把 signal 传进** `permissionGate.approve`（`toolRunner.ts:109`），中断根本解不开一个挂起的提示。

### 中断跨进程

- [x] `interrupt` 只带 `reason: 'user-cancel' | 'exit'`，`AbortController` 留在 host。两个 sentinel 都必须活着——`'exit'` 故意躲开 `isUserCancelAbort`，退出时不写 `turn_interruption`。

### 验证

- [x] `npx tsc --noEmit` 干净
- [x] `npm run test` — **1468 passed / 0 failed**（较 1415 基线新增 53 个）
- [x] `test/protocolWire.test.ts`（8）：每个 `SessionEvent` 变体过 `structuredClone`、union 覆盖度、四个兜底值的**不对称性**、memory channel 克隆与关闭传播
- [x] `test/protocolHost.test.ts`（9）：事件顺序、subagent progress 以数组过界、`hello` 重放且**不泄漏 apiKey**、两个中断 sentinel、权限 DTO 形状、**`onAlwaysAllow` 在 resolve 之前触发**、客户端死亡时四种兜底、换模型带上完整 ledger、失败命令回 `fail`
- [x] `test/protocolClient.test.ts`（9）：**同样内容的快照不改变 `getSnapshot()` 身份**（`useSyncExternalStore` 契约）、usage 按值比较、命令 resolve/reject、host 死亡时拒绝在途命令
- [x] `test/protocolChildProcess.test.ts`（5）：**真实 fork**，一个 turn 的事件跨进程按序到达、快照不带 apiKey、权限提示往返、杀掉 host 释放在途命令、Node IPC 静默吞掉函数（正是 memoryChannel 要克隆的原因）
- [x] `test/bridgesPending.test.ts`（6）
- [x] **手动冒烟未执行**（需 TTY + 真实 key）。协议层在 TUI 里是惰性的，这一轮只需回归：跑一个含工具调用的 turn → 权限弹窗批准 → 「always allow」→ 工具执行中 Ctrl+C → `/model` 切换 → `/skills reload` → `/clear` → `/resume` → 退出无残留进程。

---

## 阶段 2b-1 — 协议补全与共享展示层 `[x]` 已完成

Stage 2b 原本写成「装 Electron + 写外壳」。三份探查后确认这个描述埋了错误的因果：**挡路的不是 Electron，是协议不完整**。`tui.tsx` 给 `App` 的 22 个 prop 就是权威缺口清单——一个只拿 `SessionClient` 的渲染进程，列模型 / 列会话 / 建会话 / reload / 持久化 effort / shutdown / 后台任务全都无命令可用，`hello` 只回 `{ sessionId }`，连初始 transcript 都画不出来。

本阶段把 `SessionClient` 做成**充分**接口，Electron 因此只剩三件纯增量的事。

### 产出

- [x] **模块下沉**：`messageQueue` / `promptHistory` / `rewindSummary` / `suggestions/*` 从 `src/tui/` 移入 `src/runtime/`（全部深度守恒，被搬文件自身 import 一行未改），新增 `runtime/suggestions/index.ts` 桶。搬迁前先补了 `test/fileSuggestions.test.ts`（该文件此前**零覆盖**，却做路径穿越防护与 gitignore 过滤）。
- [x] **`fileToolPreview` → `src/services/`** 并加尺寸上限。`capFileToolPreview` 分级：两个预算内**按对象身份原样返回**；超 200 行/侧截断并把丢弃行数记进 `elided`；没有换行可切的（minified 单行）降级为 `kind:'message'`。`defaultReadFile` 先 `statSync`，超 2 MB 不读——但必须用**与 `undefined` 不同的哨兵**，否则 `Write` 会把「太大读不了的既存文件」说成「将要创建」。
- [x] **`runtime/permissionPresentation.ts`**：`PermissionDialog.tsx` 的纯逻辑整体搬出并按 `PermissionRequestDto` 重打类型。新增 `permissionToneForRequest` 返回**语义**（`danger`/`caution`/`normal`）而非 theme 颜色。
- [x] **DTO 携带派生数据**：`preview` + `destructiveWarnings` 在 host 侧算好。这是关键分层决定——否则渲染器为了画一个警告条就要 import `harness/`。`toPermissionDto` 移入 `protocol/permissionDto.ts`，`cwd` 必填。
- [x] **TUI 改吃 DTO**：`usePermission` 用 `liveRef` 留住活的 `PermissionRequest`（与 `host.ts` 的 `livePermissionRequests` 同构），`respond(id, approved, alwaysAllow?)`。「always allow」的副作用从组件迁进 hook，形状正是 wire 上的 `UiResponse`。
- [x] **11 个新 `HostCommand`**：`list-models` / `resolve-model` / `set-default-model` / `list-sessions` / `create-session` / `reload-agents` / `reload-skills` / `reload-settings` / `list-background-tasks` / `peek-task-output` / `kill-task` / `shutdown`。`hello` 扩成 `WireHelloResult`（含 `records`、`notices`、`cwd`、`configuredEffortLevel`）。
- [x] **`runtime/startupNotices.ts`**、**`runtime/sessionSwitch.ts`** 两个共享模块，`tui.tsx` 改用前者（行为等价）。
- [x] **`SessionClient` 15 个新方法** + `getBackgroundTasks()`（逐字段 diff）+ 容忍传输死亡的 `shutdown()`。

### 顺带修掉的两个真缺陷

1. [x] **客户端 `permissionMode` 会陈旧** — `EnterPlanMode`/`ExitPlanMode` 经 `PlanModeManager` → `PermissionGate` 改模式，根本不碰 `RuntimeSlot`，而 host 只订阅了 `RuntimeSlot`。补 `permissionGate.onModeChange`。
2. [x] **`retarget` 后 loop 仍绑旧会话** — 原实现只做 ledger rebase + `controller.retarget`，没有 `createRuntime` + `RuntimeSlot.replace`，也跳过了 `backgroundTasks.restoreSession` 与孤儿 agent 对账。策略抽进 `sessionSwitch.ts`。**`App.tsx` 暂留自己那份**：协议层是惰性的而 TUI 的 resume 路径是活的，两边同时改会让一个回归有两个嫌疑人；等 TUI 真正接到 `SessionClient` 时统一（`App.tsx:616` 附近）。

### 验证

- [x] `npx tsc --noEmit` 干净
- [x] `npm run test` — **1534 passed / 0 failed / 39 suites**（较 1468 基线新增 66 个）
- [x] `test/protocolClientParity.test.ts` 是本阶段**验收标准**：23 个 App prop → `SessionClient` 成员的映射表（对真实实例校验）、与 `tui.tsx` 实际传的 prop 交叉核对、外加源码级断言「`client.ts` 只 type-import harness」。两半都做过**变异验证**（加一个值 import、加一个新 prop，均能被测出）。
- [x] `test/usePermission.test.ts`（6）：DTO 而非活对象进对话框、**「always allow」早于 resolve**（同样变异验证过：宏任务延迟会被测出，微任务不会——因为微任务仍先于 gate 的 await 续体）、denyPending 清空、卸载结清在途请求
- [x] `test/fileToolPreview.test.ts`（15）含**上限内返回同一对象身份**与超大文件降级；`test/permissionPresentation.test.ts`（40）；`test/fileSuggestions.test.ts`（17）；`test/sessionSwitch.test.ts`（6）
- [x] `protocolHost.test.ts` 新增 9 条（B1、B2、后台任务合并、**模型列表不含 apiKey/baseUrl**、hello 形状等）；`protocolWire.test.ts` 补 `UiRequest`/`UiResponse` 的 `structuredClone` 覆盖（此前只钉了事件侧）
- [ ] **手动冒烟未执行**（需 TTY + 真实 key）。本轮唯一动到活 TUI 的是权限对话框：① 文件写入的 diff 预览与改动前逐字一致 ② 200 行以上文件的「... (N more lines)」计数 ③ 破坏性 Bash 仍显示 `DANGER` 且默认选中 `[N]` ④ **选 `[A]` 后规则真的生效**（直接验证 `onAlwaysAllow` 新时序）⑤ 多个请求排队时 Tab 切换与 `Also waiting:` ⑥ 工具执行中 Ctrl+C ⑦ `/model` → `/clear` → `/resume`

---

## 阶段 2b-2a — 构建步骤与协议硬化 `[x]` 已完成

2b-2 在这次会话里做不完，原因是硬约束：**装不上 Electron**。npm registry 指向内网 Nexus 镜像
`http://172.16.9.57:8081/repository/npm-group/`，`npm view electron version` 与 `npm ping` 都
`ECONNRESET`（`npm view react version` 能出结果，所以镜像是半通的，只是不代理 electron），而
`npm i -D electron` 还要再从 GitHub releases 拉一个上百 MB 的二进制。

于是先做 **2b-2 里不需要 Electron 的那个子集** + 两项 2b-1 遗留。选择标准是每一件都能在今天验证：
不需要 TTY、不需要真实 API key、不需要 Electron。

### 产出

- [x] **构建步骤**（原 2b-2 第一条 bullet）。`tsconfig.build.json` extends 基座并加
  `rootDir: "src"` / `include: ["src/**/*"]`，`npm run build`，`engines: node >= 22`。
  **不加 `main`/`exports`**——本仓库不作为库被消费，Electron 的 `main` 会指向 `dist/desktop/main.js`，
  那个文件属于 2b-2。依赖零新增（TypeScript **7.0.2** 原生移植版本来就支持 emit）。
- [x] **`rootDir: "src"` 是载荷所在，不是排版**。裸 `tsc` 会把 `rootDir` 推断成仓库根（`include`
  同时含 `src/` 与 `test/`），emit 到 `dist/src/**` 深一层，于是
  `src/harness/otlp.ts:38` 的 `require('../../package.json')` 解析成 `dist/package.json`，**在模块顶层抛**。
  设了 `rootDir` 深度就守恒（`src/harness/` 与 `dist/harness/` 都在根下两层），这行免费活下来。
  但耦合是隐形的，所以顺手把 require 包进 try/catch 落到已有的 `'0.0.0'` 兜底——
  **变异验证过**：删掉 `rootDir` 后 `dist/src/harness/otlp.js` 仍能 import，只是版本降级。
- [x] **`test/distBuild.test.ts`（8 个）**：emit → 断言 `dist/harness/` 而非 `dist/src/`、`.tsx` 也 emit、
  用 `createRequire` 复现 otlp 那次解析、四个入口在**纯 node** 下 import。
  最后一条是反空转守卫：断言子进程 `execArgv` 里没有 `--import`/`--require`。
  **不能**用「import 一个 `.ts` 应当失败」来证明没有 loader——Node 22.18+ 原生剥类型，
  `.ts` 在完全没有 loader 时也能 import，两种情况分不开（这一条是写的时候被测试本身抓出来的）。
- [x] **入站命令校验**：`src/runtime/protocol/commandSchema.ts`，`zod/v3` 的
  `discriminatedUnion` 覆盖 24 个变体，全 `.strict()`。`handleMessage` 不再裸 cast。
  两个防漂移守卫**都做过变异验证**：① 键控 `satisfies Record<HostCommand['type'], …>` 表——加变体不加
  schema 会报 `Property 'ping' is missing`；② `MutuallyAssignable` 断言——字段类型改了会红。
- [x] **`execute()` 的穷尽性此前根本没有被编译器强制**。CLAUDE.md 原文说「加了 variant 不写 case 就
  `tsc` 红」，**实测是假的**：`execute` 返回 `Promise<unknown>`，`undefined` 可赋给 `unknown`，
  `noImplicitReturns` 又是关的，第 25 个变体编译全绿。现在 switch 之后加了
  `assertNever(command)`——**它不是 `default` 分支**，且是让那条红线第一次真正成立的东西。
- [x] **`buildModelPickerOptions` → `src/runtime/modelPicker.ts`**，逐字搬迁，
  `ModelPickerOption` 一并移入（runtime 不能反向 import `src/tui/`），
  `ModelPickerDialog.tsx` 再导出所以所有 import 端零改动。挂上 `WireModelsResult.pickerOptions`，
  `SessionClient.listModels()` 自动带上，**没有新增客户端方法**。

### 顺带修掉的真 bug

1. [x] **无法识别的命令回报「成功」**。`type` 没有 case 时会穿过 switch 底部，
   host 回 `{type:'reply', result: undefined}`——调用方的 promise **resolve** 了，
   看起来像命令跑通了。现在回 `fail`。（不是挂起：先前写的「永久泄漏」判断有误，实测是 resolve。）
2. [x] **`set-permission-mode` 可以直接送 `'bypass'`**。进程边界的另一半是信任级别更低的渲染进程。
   现在非法 mode 直接 `fail` 且不进 `PermissionGate`（测试里配了 spy，并断言合法 mode 仍然生效，
   免得断言空转）。

### 两个差点写错的地方（都已核实）

- **不要用 `PERMISSION_MODES` 建 schema**：它是 Shift+Tab 的**循环顺序**，只有 4 个值，
  故意不含 `'readonly'`；而 `PermissionMode` 有 5 个。照抄会开始拒绝一个合法 mode。
- **`set-effort.level` 必须是 `z.string()` 而非 effort 枚举**：数字 effort 是原始 token 预算，
  以十进制字符串到达，`RuntimeSlot.applyEffort` 原样保留。`WireRunOverrides.effort` 才是枚举——
  两个不同的字段。

### 验证

- [x] `npx tsc --noEmit` 干净
- [x] `npm run test` — **1592 passed / 0 failed / 39 suites**（较 1534 基线新增 58 个）
- [x] `npm run build` + 纯 node import `dist/runtime/bootstrap.js`
- [x] `test/protocolCommandSchema.test.ts`（38）、`test/distBuild.test.ts`（8）、
  `test/modelPicker.test.ts`（8，此前**零覆盖**）、`protocolHost.test.ts` 新增 4 条
- [x] **不需要手动冒烟**：三件事对运行中的 TUI 全是惰性的——构建步骤不碰 `dev:tui`（仍走
  `bin/hanekawa.mjs` 的 tsx 路径），命令校验只在 `SessionHost` 上而 TUI 不构造它，
  modelPicker 是等价搬迁且 `tuiRender.test.ts` 已覆盖对话框。

### 留给下一轮

- **`typescript` 在 `package.json` 里是 `"latest"`**（实际 7.0.2）。用不固定的 major 做 emit 是真实风险，
  但改 spec 就要动 `package-lock.json`，而当前网络下 `npm install` 不可靠。**网络恢复后固定它。**
- `todo.md` 原 198 行那条 2b-1 权限对话框手动冒烟**仍未执行**。

---

## 阶段 2b-2 — Electron 外壳 `[ ]` 未开始

构建步骤已完成（见 2b-2a），剩下的都需要能装包。

- [x] ~~构建步骤~~ — 已在 2b-2a 完成
- [ ] `npm i -D electron` + 渲染进程打包器；主进程 = 现有 Node 全栈 + `bootstrap()` + `RuntimeSlot`/`SessionController` + `SessionHost`；渲染进程 = 新 UI + `SessionClient`，**深 import `protocol/client.js` 而非桶**（桶经 `host.ts` 传递性拉进 `node:fs`）
- [ ] `src/desktop/ipc/` 写 `ipcMain`/`ipcRenderer` 适配器。`createNodeProcessChannel` **不能直接复用**——`NodeIpcTarget` 的结构（`send`/`on('message')`）与 Electron 的 `on(channel, (event, ...args))` / `webContents.send` 不匹配，需要约 50 行新适配器。握手照 `test/protocolChildProcess.test.ts` 的 `__ready` 模式。
- [ ] MCP trust 提示：`confirmMcpTrust` 在**任何 channel 存在之前**运行，做成 `UiRequest` 需要一个 pre-`hello` 阶段；或先用原生 `dialog.showMessageBox`。
- [ ] 把 `App.tsx` 的会话切换改接 `sessionSwitch.ts`（见阶段 2b-1 缺陷 2 的留尾）
- [ ] 无需迁移：Ink patches、focus filter、alt-screen、`transcript.ts`、`layout.ts`

### 仍然刻意推迟

- **斜杠命令的跨进程派发**（`run-command`）：`CommandContext` 有 34 个字段，其中 **8 个是没有返回值的渲染器副作用**（`writeLine`、`openCommandView`、`openModelPicker`、`openEffortPicker`、`openProviderPanel`、`openBackgroundTasks`、`openResumePicker`、半个 `clearMessages`）。它们在命令执行**中途**被推送，所以 `run-command` 不能是普通的请求/响应，需要新增一个 `HostEvent` 承载 effect union。这是独立的半天以上，且不阻塞别的。
- **`/rewind` 写路径**：入口是双击 Esc（`useKeyboardShortcuts.ts:377`），不是斜杠命令，所以**不被上一条阻塞**。读路径与 `restore-code` 已在线上；缺的是会话截断与摘要两半。摘要那半必须在 host 执行：`summarizeRecordsForRewind` 走 `AgentLoop` 的同一条串行队列并真的调 provider。纯逻辑早已抽在 `runtime/rewindSummary.ts`。
- **`buildModelPickerOptions` 的 DTO 化** — 已在 2b-2a 完成。
- **入站命令的 zod 校验** — 已在 2b-2a 完成。

---

## 阶段 3 — 桌面独有能力 `[ ]` 未开始

- [ ] 多标签会话 / 多项目窗口（cwd 参数化、队列实例化、`SessionController`/`RuntimeSlot`、协议层、跨进程文件锁、cacheBreak 按项目分区均已就绪；剩下的是每标签一套 slot+controller 的容器与生命周期）
- [ ] diff 面板、文件树等 DOM 才划算的 UI

---

## 已知缺陷 — 本轮全部处理

1. [x] **`settings` / `skills` 启动后不再重载** — `CreateRuntimeDeps` 的 `settings`/`skills` 改成 `getSettings()`/`getSkills()`，对齐原本就能工作的 `getAgentDefinitions`。`RuntimeHost` 新增 `reloadSkills()` 与 `reloadSettings()`，后者返回 `{needsRuntimeRebuild}`（hooks 是构造期捕获的，权限规则与 config 层则是实时读取），并复用现成的 `permissionGate.setConfigRules`。新增 `/skills reload`，形状对齐 `/agents reload`。
2. [x] **`ToolRegistry.refresh()` 把 Agent 工具移到末尾** — **查证后确认这是对的，不改**。新建 runtime 恒为 `buildRuntimeTools()` + `push(agentTool)`，Agent 必在末尾；refresh 重现这个顺序，才能让「MCP 重连过的 runtime」与「新建 runtime」的工具数组逐位相同。保留原索引反而会让「在服务器连上之前建好的 runtime」把 Agent 卡在数组中间，而工具顺序是 prompt 缓存键的一部分。原因已写进代码注释。
3. [x] **三条不可达的启动错误分支** — 确认不可达：`resolveModelReference` 只会返回 `resolveModel` 已经认可的 key，而 `getModel` 就是 `resolveModel`。但底下藏着真问题：**名字拼错时返回 `undefined`，与「没配置」无法区分，于是被静默忽略**。改为校验**原始配置字符串**（排除空值与 `inherit`）：`fallbackModel`/`compactModel` 出 `RuntimeDiagnostic` 警告而不抛（可选配置降级不该拦启动），`defaultModel` 则区分「没配置」与「配了但解析不了」。三个错误码已从 `RuntimeStartupErrorCode` 删除。
4. [x] **`cacheBreakDetection` 状态是进程级的** — root 现在**编进 source 字符串本身**（`@root-<sha256 前 8 位>`），因为旁挂一张 `source → root` 表挡不住两个项目铸出同名 source（同一个 session id，或 `compact` 这类固定字面量）的情况。两张快照 Map 因此自动按项目分区，诊断文件也落到各自项目下。新增 `displayCacheSource()` 供输出与文件名剥掉后缀 —— 用摘要而非原始路径，是因为这个字符串会被 OpenAI 路径哈希进 `prompt_cache_key`，也会打进 debug 输出。

### 跨进程 `SessionStore` 安全

- [x] `src/sessions/fileLock.ts` — `O_EXCL` 建锁 + PID/mtime 判陈旧，无新依赖。套在原有进程内 mutex **内层**：进程内链条便宜地排好自己人，文件锁只挡另一个进程，syscall 每个临界区一次而非每个排队者一次。
- [x] 超时后**放行而非死等**：为了别的进程卡住而永久挂起会话写入，比它防的交错更糟；底下每个写者不是 append 就是 tmp+rename。
- [x] `repairRecords` 的整文件重写补进 jsonl 锁（原先只有它的索引更新在锁内）。tmp+rename 抗崩溃但不抗交错。
- [x] `writeJsonFile`（`src/utils/json.ts`）改为 tmp+rename。`index.json` 是两个进程最先写坏的文件，而它原本是**唯一没走原子写**的那个。
- [x] `test/sessionFileLock.test.ts`（7）：互斥、抛异常也释放、陈旧锁被死进程让出、新鲜锁不被抢、记录持有者、**两个真实进程并发 append 一个 session 不丢记录也不撕行**

---

## 新 session 接手须知

**必读**：`CLAUDE.md`（架构与不变式）、`src/runtime/index.ts`（新门面的全部导出，含 `protocol/`）。

**改动 `src/runtime/` 时的红线**：

- `ToolRegistry` 必须用 `splice` 原地改写数组，**不能重新赋值** — 同一个数组引用被 Agent 工具的 `tools: () => runtimeTools` 闭包、`ToolRunner`、`AgentLoop` 三处持有且无法重新指向。`test/toolRegistry.test.ts` 钉住了这一点，也钉住了 Agent 工具必须在末尾（原因见已知缺陷 #2）。
- `bootstrap()` 里的步骤顺序有意义：MCP 连接必须在 `registerBuiltinCommands()` 之前，且整个 `bootstrap()` 必须在 Ink `render()` 之前完成（trust 提示要抢在 Ink 接管 stdin 前）。
- 5 个 bridge 的兜底值各不相同且都是刻意的：权限=拒绝、AskUserQuestion=拒绝、退出 plan=拒绝、**进入 plan=批准**、record=丢弃。不要"统一"它们。**只有权限 bridge 会排队**，其余三个立即回答——headless 调用方（直接驱动 `PlanModeManager` 的单测）依赖这一点。
- `createRuntime` 里的 `onActiveSessionChange?.(runtimeSession.id)` 放在所有会抛的校验**之后**：模型 key 无效时不能已经把会话级状态切过去了。
- `RuntimeSlot.replace()` 必须先装新 runtime 再 dispose 旧的：晚到的 dispose 会拆掉继任者的 plan-slug provider。
- `SessionController` **独占** `RecordProxy` 的三个 setter。UI 只能 `onEvent` 订阅，不能自己 `setHandler`，否则记录会被处理两次。
- `SessionEvent` 的 `turn-end.aborted` 是 signal 状态，不是「是否抛异常」；`transcript-reset.bumpGeneration` 只在真正换了会话视图时为 `true`。
- **协议层**：`SessionClient` 换快照前必须逐字段 diff，**后台任务列表同理**。`SessionController.publish` 是按引用比 `usage`/`taskSnapshot` 的，而反序列化出来的每条消息都是新对象图——照搬会让 `useSyncExternalStore` 无限重渲染。
- **协议层**：往 `HostEvent`/`HostCommand` 上加字段前先确认它过得了 `structuredClone`。`memoryChannel` 每次 `post` 都克隆就是为了当场炸出来；Node 的 `child_process.send` 默认走 JSON，会**静默吞掉**函数（`test/protocolChildProcess.test.ts` 有一条专门钉这个）。
- **协议层**：`execute()` **没有 `default` 分支**，但真正强制穷尽性的是 switch 之后那句
  `assertNever(command)`——**光靠没有 `default` 从来不起作用**（`execute` 返回 `Promise<unknown>`，
  `undefined` 可赋给 `unknown`，`noImplicitReturns` 关着），阶段 2b-2a 变异验证过。别加 default，
  也别删 `assertNever`。
- **协议层**：入站命令一律先过 `parseHostCommand`（`protocol/commandSchema.ts`）。schema 是 `HostCommand`
  的第二份描述，靠两个编译期守卫防漂移：键控 `satisfies` 表（按名字报缺哪个变体）+ `MutuallyAssignable`
  断言（报字段级漂移）。**`SessionClient` 不做对称校验**——那会把 zod 拉进渲染进程包体。
- **不要用 `PERMISSION_MODES` 建 schema / 校验 mode**：它是 Shift+Tab 的循环顺序，只有 4 个值，
  故意不含 `'readonly'`。`set-effort.level` 同理必须是 `string` 而非 effort 枚举（数字 effort 是
  原始 token 预算）。
- **构建产物**：`tsconfig.build.json` 的 `rootDir: "src"` 是载荷所在。去掉它，`tsc` 会推断仓库根并
  emit 到 `dist/src/**`，所有 `import.meta.url` 相对路径的解析深度就变了。`test/distBuild.test.ts` 钉住这点。
- **任何从 `ModelConfig` 投影出去的类型都要逐字段构造，绝不 spread**：`resolveModel` 会把 endpoint 的 `apiKey`/`baseUrl` 折进返回值。
- **`PermissionRequestDto` 携带派生数据**（`preview`、`destructiveWarnings`），目的是让渲染器不必 import `harness/`。加字段时保持这条：需要 host 侧代码才能算出来的东西，在 host 算完再上线。
- **「always allow」必须先触发回调再 resolve**：`PermissionGate` 在 `await this.prompt(...)` 的下一行读那个闭包标志。host 与 `usePermission` 两条路径都是如此，各有测试钉住。
- **切会话不等于 `controller.retarget`**：还要 `createRuntime` + `RuntimeSlot.replace`（replace 放最后）+ 后台任务恢复 + 孤儿 agent 对账，见 `runtime/sessionSwitch.ts`。
- **渲染器深 import `protocol/client.js`，不要走 `protocol/index.js`**：桶经 `host.ts`/`permissionDto.ts` 传递性拉进 `node:fs`。`test/protocolClientParity.test.ts` 钉住了 `client.ts` 只 type-import harness。

**验证命令**：

```bash
npm run typecheck
npm run test                                          # 1592 tests / 39 suites, ~40s
npm run build                                         # emit 到 dist/（只有桌面外壳需要）

node --import tsx --test test/protocolWire.test.ts test/protocolHost.test.ts \
  test/protocolClient.test.ts test/protocolClientParity.test.ts test/bridgesPending.test.ts
node --import tsx --test test/protocolCommandSchema.test.ts   # 入站校验 + 防漂移
node --import tsx --test test/distBuild.test.ts               # emit 后用纯 node 载入
node --import tsx --test test/protocolChildProcess.test.ts   # 真实进程边界
node --import tsx --test test/sessionFileLock.test.ts        # 含双进程并发写
node --import tsx --test test/permissionPresentation.test.ts test/usePermission.test.ts \
  test/fileToolPreview.test.ts test/fileSuggestions.test.ts test/sessionSwitch.test.ts \
  test/modelPicker.test.ts
node --import tsx --test test/toolRegistry.test.ts test/runtimeBootstrap.test.ts
npm run dev:tui                                       # 手动冒烟，需 TTY
```

**改文档时注意**：`AGENTS.md` 是 `CLAUDE.md` 的逐字镜像，只有第 1、3 行不同（Codex / Claude Code）。它**未被 git 跟踪**，但改了 `CLAUDE.md` 就要同步它。

**已知不稳定**：`test/toolcall-integration.test.ts` 在**全量并发跑**时偶发
`Unable to deserialize cloned data due to invalid or unsupported version` —— 这是 Node test runner
自己的 IPC 报错，不是断言失败。单独跑必过，且在**未改动的基线上同样复现**（基线两次全量跑里挂了一次）。
与本阶段改动无关，重跑即可。

