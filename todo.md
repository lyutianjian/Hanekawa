# Hanekawa 桌面端适配 — 进度与待办

> 交接文档。**架构与不变式在 `CLAUDE.md`**，本文件只讲进度、决策留痕和没做完的事。
> 状态：`[x]` 完成并验证 · `[~]` 部分完成 · `[ ]` 未开始

---

## 目标

让 agent 内核被桌面 app（Electron）复用，TUI 与桌面端共享同一套 headless 运行时。
终端的天花板就是 `transcript.ts`（存在的唯一理由是 Ink `<Static>` 不可回收）与 `layout.ts`（手工重算行高），
这两类问题在 DOM 里根本不存在。

实测前提（非估计）：`src/` 中 `tui/` 之外 import `ink`/`tui/` 的文件 **0** 个、用 `process.stdout/stdin/isTTY` 的 **0** 个、
出现 ANSI 的 **0** 个；核心约 24.8k 行对 UI 完全无知，`src/tui/` 约 14.7k 行里约 10k 是纯终端资产（不迁移）。
选 Electron 而非 Tauri：依赖面（`child_process`、MCP stdio、fast-glob、shadow-git、patch-package）全是 Node，
Tauri 还得挂 Node sidecar。

---

## 已完成阶段

| 阶段 | 内容 | 测试基线 |
|---|---|---|
| 0 | 抽出 headless 运行时 `src/runtime/`（`bridges`/`toolRegistry`/`mcp`/`createRuntime`/`bootstrap`），`tui.tsx` 597→177 行 | 1386 |
| 0.5 | 缺陷清理（denialState 绑死初始会话、plan-slug provider 后到者胜、`syncActiveModel` 白建 runtime、`sessionRecords` 不刷新）+ `MessageQueue` 类化 + cwd 参数化 | 1394 |
| 1 | `SessionController` + `RuntimeSlot` + `queuePump`：turn 生命周期从 React hooks 下沉，`useAgentLoop` 687→378 行 | 1415 |
| 2a | 进程协议：`RuntimeChannel`、`HostEvent`/`HostCommand`、`SessionHost`/`SessionClient`、memory·node channel、权限 bridge 改排队 | 1468 |
| 2b-1 | 把协议补到「足以驱动一个渲染器」：11 个新命令、`hello`→`WireHelloResult`、`fileToolPreview` 下沉并加上限、`permissionPresentation` 共享、DTO 携带派生数据 | 1534 |
| 2b-2a | `npm run build`（`rootDir: "src"`）、入站 zod 校验 + 两个防漂移守卫、`assertNever` 穷尽性、`modelPicker` 下沉 | 1592 |
| 2b-2b | `run-command` 跨进程斜杠命令 + `CommandEffect`、`/rewind` 写路径、四个共享模块、`App.tsx` 接入 `sessionSwitch.ts` | 1651 |
| 3a | `ProjectRuntime`/`SessionScope` 拆分、`SessionPane` + `SessionWorkspace`（多标签的 headless 那一半） | 1673 |
| 2b-2 | Electron 外壳：`main.ts`/`preload.ts`/`electronChannel.ts`/`bridgeChannel.ts` + 三个 tsconfig + `build:desktop`；修掉 4 个开机即死 bug | 1703 |
| 3c | 渲染器变可用视图：9 个 model 模块 + 5 个 dom 模块、四个阻塞对话框、流式输出、Esc 中断、斜杠命令与补全、四个 surface 面板、行级 diff | 1801 |
| 3b | 跨进程 workspace 协议：`open-pane`/`close-pane`/`list-panes` + `pane-list` 事件、`PaneRegistry`、`main.ts` 一窗一 pane、渲染器标签栏（`model/tabBar.ts` + `dom/tabBarView.ts`）；顺带 `list-commands` + `WireCommandInfo` | 1818 |
| 3d | 收 3b 的账：shell `panes` Map 改用 `BrowserWindow.id`、启动用 `openPane({ sessionId })`、`broadcastPaneListToOthers` 跨窗口广播、`test/protocolChildProcess.test.ts` 子进程字符串补齐三 dep；新增 `paneId follows controller across /clear` 用例 | 1819 |
| 3e | Markdown 渲染：`model/markdown.ts`（marked lexer → 自有 union）+ `dom/markdownView.ts`（只用 `el()`）、assistant 消息与计划正文接线、`main.ts` 导航守卫、CSS | 1846 |
| 3f | 选择与补全：四个面板可键选/点选（`SurfaceAction` + `moveSurfaceSelection`）、`@` 文件补全（`suggestions/atToken.ts` 拆分 + `file-suggestions` 命令 + 双源下拉与序号守卫） | 1870 |
| 3g | rewind / checkpoint 面板：`runtime/rewindPresentation.ts`（第三个共享 presentation 模块，含 `rewindStepsFor` 与五条结果文案）、`model/rewindPanel.ts` + `dom/rewindView.ts`、`/rewind` 斜杠命令（两端共享）、`keymap` 新增 `hasRewind` 档位、`#rewind` 独立模态层 | 1907 |
| 3h | 消息队列跨进程 + 费用常驻：`SessionController.submit` 补在途守卫、`SessionHost` 持有 `MessageQueue` 并驱动泵、`enqueue-message`/`clear-queue` + `queued-messages` 事件、`resolveUsageWithCost` 收掉三份重复、`model/queuedMessages.ts` + `dom/queueView.ts` + `#status-cost` | 1943 |

各阶段的设计理由已全部写进 `CLAUDE.md`。下面只留**没进那份文档、但下一轮仍要知道**的东西。

### 决策留痕

- **`activateModelKey` 与 `switchModel` 故意分两层**：`set-model` 只把当前 runtime 指到别处，`/model` 才是用户
  表达偏好、才回写 tier。把持久化折进下层，fallback 激活或选择器预览就会改写用户默认值。
- **`ToolRegistry.refresh()` 把 Agent 工具移到末尾是对的，不要"修"**：新建 runtime 恒为
  `buildRuntimeTools()` + `push(agentTool)`，refresh 重现这个顺序才能让「MCP 重连过的 runtime」与「新建的」
  工具数组逐位相同 —— 工具顺序是 prompt 缓存键的一部分。
- **`bootstrap()` 的步骤顺序有意义**：MCP 连接必须在 `registerBuiltinCommands()` 之前；整个 `bootstrap()`
  必须在 Ink `render()` 之前完成（trust 提示要抢在 Ink 接管 stdin 前）。
- **`createRuntime` 里的 `onActiveSessionChange?.(id)` 放在所有会抛的校验之后**：模型 key 无效时不能已经把
  会话级状态切过去了。
- **`cacheBreakDetection` 的 root 编进 source 字符串本身**（`@root-<sha256 前 8 位>`）：旁挂一张 `source → root`
  表挡不住两个项目铸出同名 source（同一 session id，或 `compact` 这类固定字面量）。
- **三条启动错误分支确认不可达已删**；真问题是名字拼错时 `resolveModelReference` 返回 `undefined` 与「没配置」
  无法区分而被静默忽略 —— 改为校验原始配置字符串，`fallbackModel`/`compactModel` 出 `RuntimeDiagnostic` 警告
  而不拦启动。
- **跨进程 `SessionStore` 安全**：`fileLock.ts` 的 `O_EXCL` 锁套在原有进程内 mutex **内层**（进程内链条先便宜地
  排好自己人，syscall 每个临界区一次）；超时**放行而非死等**；`repairRecords` 的整文件重写也进锁；
  `writeJsonFile` 改 tmp+rename（`index.json` 原本是唯一没走原子写的）。
- **shell 的 `panes` Map 改用 `BrowserWindow.id` 而不是 session id 作键**：session id 在 `/clear`、`/resume` 后
  会动，window id 不会动。`paneId` 字段仍然保留只用于渲染器侧的 `WirePaneInfo`（一个 pane 一个 session 的不变量）；
  shell 这边任何 `panes.set/get/delete` 都走窗口 id，`onPaneOpened` 用线性扫描定位（`workspace` 自身已经是这么做的，
  不引入第二份会漂移的索引）。`onPaneClosed` 改成闭包到自己的 `entryWindow`，不再用 map 查找 —— 因为那条 callback
  拿到的 `paneId` 永远是 host 视角的**当前**会话 id，而 map 键是**开窗时**的会话 id，两边从来就对不上。
- **`broadcastPaneListToOthers(ignoredEntry)` 在 shell 层补上 host 跨窗口看不见的广播**：host 的
  `broadcastPaneList` 只到自己 channel（这是 31 个 `HostCommand` 同构切片的硬约束，不是疏忽）；shell 的 fan-out
  跳过发起者，因为 host 已经把它自己的更新送到了发起窗口 —— 重复推送 `SessionClient.onPanesChanged` 是幂等替换
  但更省事。OS 关窗路径（`'closed'` 回调）也要广播一次，因为那条不经过 host。
- **3f：面板行的动作走 `run-command` 而不是 client 的直通 setter**（`model/surfaces.ts` 的 `SurfaceAction`）。
  这条正是上面「`activateModelKey` 与 `switchModel` 故意分两层」的下游后果 —— 点一行走 `client.setModel`
  会把 tier 持久化悄悄丢掉。`resume-picker` 是例外，因为 `/resume` 根本不收参数，于是复用标签栏已经定义好的
  `open-pane`（一个 session 一个 pane）。`background-tasks` 只给 peek 不给 kill。
- **3f：`@` 补全的拆分线是「依赖」而不是「职责」**。`extractAtCompletionToken`/`applyFileSuggestion` 零 import，
  搬进 `suggestions/atToken.ts` 上渲染器 allowlist；`generateFileSuggestions` 要 `node:fs` + `fuse.js` +
  gitignore，留在 `fileSuggestions.ts` 并 re-export 前者，所以 TUI 侧一行没动。代价是每次击键一趟 IPC，
  而**没有任何东西保证这些回答按序到达** —— 序号守卫（`model/completion.ts` 的 `seq`）因此是必需品而不是优化。
  每次状态迁移都 bump，所以「打了 `@` 又改打 `/`」和「按 Esc 关掉下拉」都会让在途回答作废。
- **3f：面板导航只在输入框为空时抢键**。面板不阻塞，用户完全可能开着 `/model` 再打一句话；无条件吃 Enter
  就变成选模型。副作用是面板与补全下拉**构造上互斥**（补全的前提是打了 `/` 或 `@`，那时 `inputEmpty` 必为假）。
- **3g：rewind 面板的键位档位在 overlay 之下、其余一切之上**。它 modal 但**不阻塞** —— 权限提示扣着 agent
  loop（`interrupt()` 放不掉），rewind 只扣着用户，所以让位；但它压住下拉、压住 surface、压住输入框，因为
  确认屏上每个选项都在毁工作，键不能漏下去。对应地它有自己的容器（`#rewind`，`z-index: 5`，在 `#overlay`
  的 10 之下），而不是跟四个阻塞对话框抢同一个 panel —— rewind 开着时来一条权限提示，画在它**上面**。
- **3g：`SUPPORTED_SURFACES` 是「画成行列表的 surface」，不是「本 shell 处理的 surface」**。
  `rewind-panel` 故意不在里面，由 `app.ts` 在 `isSupportedSurface` **之前**按名字分流。所以那个谓词返回
  `false` **不等于**这个 surface 被忽略（`provider-panel` 才是真忽略）—— 三处注释都改了措辞，因为原话
  「四个里实现四个、忽略 provider-panel」现在会把读者引到错的结论上。
- **3g：`restore-code` 报告失败、`truncate-session` 抛失败，这条不对称必须在执行器里抹平**。
  host 侧 `restore-code` 返回 `{ success:false }`（`host.ts:513`），忘了看 `success` 就会把一次失败的
  git 恢复当成功报出去；`runRewind` 把它转成 throw。反过来 `truncate-session` 找不到消息就抛，于是
  「陈旧的 checkpoint 列表」会浮上来而不是静默 no-op。
- **3g：`restore-code-and-conversation` 先截断、后回滚文件**，这个顺序**就是**那条部分失败文案存在的理由
  （JSONL 已经剪了、git 却失败）。顺序编进 `rewindStepsFor` 而不是各自的调用处，两个 shell 都从那里读。
  变异验证：把顺序倒过来，4 条用例报红，包含两条专讲「哪一半落地了」的。
- **3g：渲染器不重建 transcript**。`SessionHost.afterRewind()` 已经 `invalidateRecordsCache` →
  `controller.reload()` → `ledger.rebase()`，`reload()` 自己发 `transcript-reset`；回复里的 `records`
  只作旁证，再折一次就是双份重绘。
- **3g：`session-changed` 一到就关面板**。`/clear`、`/resume` 之后手上那份 checkpoint 属于旧会话，
  每个选项都会解析到新会话从没有过的 message id，留着只换来一句 "Message not found"。
- **3g：`handleEnterRestoreMode` 必须挪到 `useCommands({…})` 调用之前**（App.tsx）。`useCommands` 在 637
  行结束、原定义在 757 行，直接引用是 TDZ 错误 —— 与 `openBackgroundTasks`/`openResumePicker` 已经建立的
  「先定义后 useCommands」惯例一致，不加 ref 间接层。
- **3g：共享模块的 re-export 用「函数身份」钉死**（`test/rewindPresentation.test.ts` 的 `===` 断言）。
  这正是本文件「测的实现必须就是出货的实现」那条的预防性应用：`RestoreMode.tsx` 里换成第二份实现，
  行为测试全都还是绿的，只有身份断言会红。已变异验证。
- **3h：消息队列归 host，而不是渲染器 —— 这是两端所有权唯一分叉的地方**（TUI 侧仍是 `App.tsx` 持有）。
  两个结构性理由：① 它靠 `store.appendRecord` 持久化，让渲染器持有就得开一条 `append-record` 命令，
  把整个 `SessionRecord` 联合体交给协议里**不受信的那一端**去校验；② 泵的判据要读只有 host 知道的状态。
  连带后果：`sessionSwitch.ts` 那句「It belongs to the shell rather than the host」当场作废，已改写成
  「哪一侧持有取决于 shell」。
- **3h：`uiBlocked` 只算四个阻塞请求**（`pendingKinds.size > 0`），rewind 面板与 surface 不算 ——
  它们扣着用户但不扣着 agent loop。这就是 `queuePump.ts` 早先留的那条「终端用任意 overlay、
  桌面端用待答权限提示」分界线第一次真的被用上。
- **3h：负向断言必须给泵留时间预算，否则测的是竞态不是闸门**。`pumpQueue` 是脱钩的
  （`void (async () => …)`），第一步 `dequeue` 还要落盘；紧跟 enqueue 回复就断言「什么都没发」，
  闸门开着也照样绿。**变异验证第一次跑就暴露了这点**：把 `uiBlocked` 改成 `false`，用例仍然通过。
  于是有了 `givePumpAChance()`（150ms，是放行路径实测 ~30ms 的舒适倍数）。两条闸门现在各自被
  对应用例钉死：改 `uiBlocked` 只红「权限提示挡住队列」，改 `turnActive` 只红另外两条。
- **3h：守卫要抛而不是静默 no-op**，且 `try` 必须紧跟 `streaming = true` 之后开。
  原本 `publish()` 与 `createCheckpoint()` 落在 `try` 之外，一个会抛的订阅者就能让 `streaming`
  永久卡住 —— 加守卫之前这只是转圈图标不消失，加了之后**后续每一次 submit 都会被拒**。
  `createCheckpoint` 自己吞掉一切异常，但 `publish()` 会同步调订阅者，而其中一个就是 channel post。
- **3h：费用由 host 算，不把 `ModelPricing` 送过界**。渲染器不能 value-import `harness/`
  （`FORBIDDEN_LAYERS`），而 allowlist 只放 `runtime/`+`config/`；把 `harness/usage.ts` 加进 allowlist
  会破坏「共享模块只做 type-only 跨层 import」那条既有约束。顺带收掉了**三份**重复的同一段投影
  （`protocol/commandContext.ts`、`tui/hooks/useCommands.ts`、以及本轮要新增的第三处），
  用「`/cost` 与状态栏必须报同一个数」这条行为断言钉死 —— 比函数身份断言更贴切，因为这里没有 re-export。
- **3h：`test/desktopMain.test.ts` 与 `test/desktopUiRoundTrip.test.ts` 的假 controller 都在
  `usage.total` 上撒谎**（写成 `null`，而 `SessionUsage.total` 不可空），只因为整个对象被 cast 才编译通过。
  host 现在要读它来派生费用，谎言当场炸成 `Cannot read properties of null`。修的是假货而不是给 host 加
  防御分支 —— 生产路径里 `createEmptySessionUsage()` 保证它非空。**这是本文件那条
  「`as unknown as` 关掉的正是编译器唯一能抓 API 谎言的机会」第三次应验。**
- **3h：`migrateTo` 与「什么都不做」在协议层完全同形，只有落盘那一侧能区分**。第一版 `/clear` 用例只看
  `queued-messages` 事件与「消息最终发出去了」，**变异验证直接放行**：不 rebind 的话
  `MessageQueue` 的内存快照原样保留、消息照样发，唯一的差别是后续 `message_queue` 记录写进了**被离开的
  那个会话**的日志 —— 重启后队列会重放进错误的对话。用例因此改成去读**新会话日志里的 enqueue 记录**
  与**旧会话日志里的补偿 `clear`**。教训比这条 bug 本身通用：**只要被测行为的差别在持久化侧，
  断言就不能只站在 wire 上。**
- **3h：四条不变式各自被对应用例钉死**（逐条变异验证过，且只红对应那条）：
  `uiBlocked→false` 红「权限提示挡住队列」、`turnActive→false` 红另外两条、
  `/clear` 去掉 `migrateTo` 红 `/clear` 那条、`/resume` 的 `reset` 换成 `migrateTo` 红 `/resume` 那条。

### 工作方法（本项目的验收惯例）

- **变异验证**：每加一条不变式，就把 bug 逐个塞回去，确认是**预期的那条**用例报红。已用它证伪过多条文档断言
  （例如「没有 `default` 分支就能强制穷尽」实测是假的）。
- **测的实现必须就是出货的实现**：renderer channel 曾有两份（测试一份、`app.ts` 内联一份），结果 main 侧工厂的
  两处 API 谎言被专门写的 mock 一路放行。
- **`as unknown as` 关掉的正是编译器唯一能抓 API 谎言的机会**：2b-2 四个开机即死 bug 里有三个藏在这种 cast 后面。
- **`test/protocolChildProcess.test.ts` 的 host 侧脚本是字符串**（写进临时 `.mjs`），`tsc` 看不见它 —— 改
  `SessionHost` 构造 deps 时必须手动同步那一段。阶段 3a 就是靠全量跑才发现它坏了，而 `tsc --noEmit` 全绿。
  **3b 又踩了一次，而且这次全量跑也没红**（新增的三个 dep 只在 pane 命令里用到，子进程从不发）—— 所以
  这条不能靠测试兜底，只能靠改 deps 时手动 grep。
- **真机验证不需要截图、不需要给产品加调试开关**：`electron . --remote-debugging-port=9222` +
  node 内置 `WebSocket` 直连 CDP，`Runtime.evaluate` 读 DOM、`Input.dispatchKeyEvent` 发真键、`Input.insertText` 打字。
  权限对话框用 `window.hanekawa.send({type:'run-tool', name:'Write', ...})` 零 API 花费触发。
  另有一条零侵入探针：`app.ts` 只在 `await client.hello()` **返回之后**才设 `document.title`，所以
  `Get-Process electron | Select MainWindowTitle` 给出 `Hanekawa — <会话标题>` 就等于整条链通了。

---

## 待办

### 阶段 3 — 桌面独有能力 `[~]`

- [x] **跨进程 workspace 协议**（多标签的另一半）。落地后与当初的预判有两处出入，记下来：
  - **"28 个 `HostCommand` 一个都不用改"是错的**，两层意义上：数字本身当时就抄错了（`HostCommand` 那时是
    **27** 个变体，`CLAUDE.md` 写着 28），而且确实得加命令 —— `open-pane`/`close-pane`/`list-panes` 加上
    渲染器补全要用的 `list-commands`，当时是 **31**（3f 又加了 `file-suggestions`，3h 又加了
    `enqueue-message`/`clear-queue`，现在 **34**）。真正没改的是那 27 条：pane 命令是**旁挂**的一层，
    不是把既有命令参数化。
  - **`SessionHost` 不自己建窗口**：它拿 `PaneRegistry`（`SessionWorkspace` 的结构化切片）解析 + 注册 pane，
    再通过 `onPaneOpened`/`onPaneClosed` 把 `BrowserWindow` 那步交回 shell。协议层不 import electron 的
    约束因此没破。
  - **"每个 pane 一对 `SessionHost`/`SessionClient`"确认成立**，`test/desktopMain.test.ts:270` 用两对真
    host/client + 一个共享 registry 覆盖；Electron 侧确实不需要多路复用。
- [ ] **一个进程多个项目**：被模块级 `src/commands/registry.ts`（B 项目的 skill 命令会漏进 A）与进程级
  `setCacheBreakDiagnosticsRoot` 挡住。多标签**同项目**不受此限。

### workspace 协议留下的缺陷（读代码查出，尚未修）

`main.ts` 在 node 下不可 import（模块顶层就 `app.requestSingleInstanceLock()`），所以窗口↔pane 的记账
一行测试都没有 —— 下面四条全落在那里。按修复顺序排：

- [x] **启动打开的是空白新会话，不是恢复的那个**（`main.ts:150,163-164`）：`main()` 取 `sessions.at(0)`
  引导、`workspace.adopt(host)` 把它注册成第一个 pane，然后 `await openPane({})` —— 无 `sessionId` 走
  else 分支**新建一个 draft** 并把窗口给了它。于是每次启动都是空会话，且标签栏里多一个没有窗口的幽灵
  pane。改成 `openPane({ sessionId: session.id })` 即可（会命中 `paneForSession` 拿到已 adopt 的那个）。
- [x] **`paneId` 用会话 id，而它会在 `/clear`、`/resume` 时移动**（`host.ts:896` + `main.ts:75,218,259-292`）：
  host 侧 `collectPanes()` 读的是**当前** session id，`main.ts` 的 `panes` Map 却按开窗时捕获的
  `entryPaneId` 建键。窗口内 `/clear` 之后两边分叉：Ctrl+W 发 `close-pane(新 id)` → host 扫描命中、真把
  pane 拆了 → `onPaneClosed(新 id)` 在 map 里查不到 → **窗口不销毁、`sessionHost` 不 dispose**；点标签页
  的 X（用的是陈旧的 `row.paneId`）则反过来报 `Pane not found`；活动标签高亮也丢。
  这正是 `CLAUDE.md` 里"按 session id 建索引每次 `/clear`、`/resume` 都要 re-key"警告过的事，在 shell 层
  被重新引入了。两条路：shell 收到 `session-changed` 就 re-key，或者给 pane 一个不随会话移动的 id。
- [x] **`pane-list` 从不跨窗口广播**（`host.ts:891`）：`broadcastPaneList()` 只 post 自己那条 channel，
  注释自己写着"真正的多 pane 广播是 shell 的活（它遍历每个 `SessionHost`）"，而 `main.ts` 没有这段遍历；
  OS 关窗路径（`main.ts:283`）更是一次都不广播。于是窗口 B 的标签栏永远停在旧拓扑。
- [x] **`test/protocolChildProcess.test.ts:105-111` 没跟着改**：子进程侧那段字符串脚本的
  `new SessionHost({...})` 缺 `workspace`/`onPaneOpened`/`onPaneClosed` 三个必填 dep。测试仍绿，只因为
  子进程从不发 pane 命令 —— 那里 `this.workspace` 是 `undefined`，真发一条 `list-panes` 就是 TypeError。
  **这就是本文件"工作方法"里那条陷阱的原样复现**：`tsc` 看不见字符串。
- [x] **把标题当成 modelKey 传**（`main.ts:216`，潜伏、当前不可达）：
  `adopt(scope, options.title ? { modelKey: options.title } : {})` —— `modelKey` 会喂给 `createRuntime`，
  无效 key 会抛。今天没有调用方传 `title`，host 侧同一逻辑（`host.ts:846`）是对的。


### 渲染器还缺的（阶段 3c 刻意留下）

- [x] **rewind / checkpoint 面板**（3g 落地）。与当初的预判有两处出入：
  - **"纯渲染器活"不完全成立**。读写命令确实都在 `SessionClient` 上了，但**入口**得从某处来 ——
    选了 `/rewind` 斜杠命令、走既定的 `CommandContext` → `COMMAND_CONTEXT_COVERAGE` → `open-surface`
    机制，于是宿主侧多了 6 处 1-3 行的改动（含 `CommandSurface` 加第六个值），TUI 也顺带有了 `/rewind`
    （原来只有 Esc-Esc）。换来的是两端入口一致、且 `/` 下拉里能看见它。
  - **决策的编排本身也是共享物**，不只是"选项列表"。`rewindStepsFor` + 五条结果文案 + 那条部分失败文案
    一起进了 `runtime/rewindPresentation.ts`，`App.tsx` 的 `handleRestoreSelect` 从 45 行的 if 链改成读
    步骤表。原来那份 `formatRestoreMessagePreview` 是 App.tsx 私有的，两端各写一份就会在引号里的文本上分叉。
- [x] **费用显示**（3h 落地）：`ModelPricing` **没有**上 `WireRuntimeSnapshot` —— 改为 host 侧派生，
  `snapshot` 事件带 `cost?: { amount, currency }`，理由见上面的决策留痕。
- [x] **消息队列**（3h 落地）。与当初的预判有两处出入：
  - **"要记录流"这个前置条件不成立**。`MessageQueue` 要的只是 `store.appendRecord`，host 本来就有；
    真正的前置条件是另一条 —— `SessionController.submit` 的在途守卫，而那条当时就已经写在清单里了。
  - **"关闸而非排队"是权宜之计，这轮把它换掉了**：守卫进内核之后，`keymap.ts` 的 Enter 分支从
    `'none'` 改成 `'enqueue'`，`#submit` 按钮不再 disable 而是改字为 "Queue"（`requestSubmit()` 会忽略
    disabled 按钮，所以键路径与按钮路径必须同时改，漏一边就是静默吞掉点击）。

（标签栏已在 3b 补上、Markdown 已在 3e 补上、面板可点选与 `@` 文件补全已在 3f 补上、
rewind 面板已在 3g 补上、**消息队列与费用显示已在 3h 补上**，见上表；它们不在这份清单里过。）

**3e 顺带留下的两条**：① **代码块没有语法高亮** —— TUI 用的 `cli-highlight` 出 ANSI 且是 Node 侧的，
浏览器侧要另选一个能进 renderer bundle（无 Node 依赖）的库，是独立一档；② `markdownNode` 每次都重建整棵
子树，`transcriptView` 又是每 token 全量重画 —— 解析有 LRU 兜着，**建节点没有**。真机上若长会话流式发卡，
按 `transcriptView` 文件头写的那条路走（按 item id 建 key 增量更新），不要回头去搞 static/live 分区。

### 杂项

- [ ] **固定 `typescript` 版本**：`package.json` 里仍是 `"latest"`（实际 7.0.2），用不固定的 major 做 emit 是真实风险。
  卡在内网 npm 镜像（`http://172.16.9.57:8081/repository/npm-group/` 不代理 electron，`npm ping` `ECONNRESET`），
  网络恢复后做。
- [ ] **`design_guidance.md` 未落地**：一份 129 行的深色 UI 设计规范（Codex 桌面端提炼），目前渲染器完全没有
  按它实现。要么排期做视觉层，要么明确它只是参考资料。

### 未执行的手动冒烟（都需要 TTY + 真实 API key）

- [ ] **2b-1 的权限对话框 TUI 冒烟**（欠得最久，且后续几轮**都没碰过 TUI 渲染路径**，风险面没变化）：
  ① 文件写入 diff 预览与改动前逐字一致 ② 200 行以上文件的「... (N more lines)」计数
  ③ 破坏性 Bash 仍显示 `DANGER` 且默认选中 `[N]` ④ 选 `[A]` 后规则真的生效（验证 `onAlwaysAllow` 新时序）
  ⑤ 多请求排队时 Tab 切换与 `Also waiting:` ⑥ 工具执行中 Ctrl+C ⑦ `/model` → `/clear` → `/resume`
- [ ] **3a 的 `tui.tsx` pane 装配**（等价搬迁，参数逐字相同，其余对运行中的 TUI 全惰性）：
  启动 → 含工具调用的一个 turn → 权限弹窗 → `/clear` → `/resume` → `/model` → Ctrl+C 退出无残留进程。
  已知无害行为变化：`host.shutdown()` 现在会 dispose 初始 scope，退出时 `drainPending()` 把仍停泊的权限提示
  以 `false` 结清（改动前它们悬着直到进程退出）。
- [ ] **3c 的两件**：① 流式 token 与 `#tool-progress` 行、Stop 按钮与 Esc 中断；
  ② 多个权限提示同时排队时的 Tab 切换与 `Also waiting:` 行 —— 注意 `AgentLoop.runTool` 走 `enqueue()` 的单一
  在途槽，两次 `run-tool` **不可能**并发出两个提示，真并发只来自一个 turn 内被批处理的工具调用。
- [ ] **3b 的多窗口冒烟**（`main.ts` 没有任何测试覆盖，这是唯一的验证手段；上面四条缺陷就是读代码查出来的，
  修完必须真机复验）：启动看到的是**最近一个会话**而不是空 draft → Ctrl+T 开第二个窗口 →
  两个窗口的标签栏都列出两个 pane → 在窗口 A 里 `/clear` 后，A 自己的标签页仍可点可关、B 的标签栏也跟着更新
  → Ctrl+W 关掉 A，窗口真的消失 → 关掉最后一个窗口，`before-quit` 走完 `host.shutdown()`，无残留进程。
- [ ] **3d 修复的回归冒烟**：3b 那条按顺序走完，且额外加两点验证：
  ① 窗口 A 切到 `/resume` 一个旧会话（不是新建），A 的标签页仍可点可关（验证 `paneId` 在 `/resume` 后也没漂移）；
  ② Ctrl+W 与点标签页 X 两条关窗路径都试一遍，验证它们走的是同一份回调栈。
- [ ] **3e 的 Markdown 冒烟**（`guardNavigation` 和整个 DOM 层都没有测试覆盖）：
  ① 一个含标题、列表、表格与围栏代码块的回答，流式过程中不错位、定稿后排版正确；
  ② 计划对话框（`ExitPlanMode`）正文是富文本而不是裸 `#`/`-`；
  ③ 点回答里的一条 http 链接 → 走系统浏览器，**Electron 窗口不跳走**（这是 `setWindowOpenHandler` +
  `will-navigate` 唯一的验证手段）；
  ④ 让模型输出 `<img src=x onerror=alert(1)>` 与 `[x](javascript:alert(1))` → 页面显示字面文本、
  没有弹窗、DevTools 控制台无 CSP 报错；
  ⑤ 权限对话框里的命令块与 diff 仍然逐字（**没有**被 markdown 化）。
- [ ] **3f 的选择与补全冒烟**（`dom/surfaceView.ts`、`dom/composerView.ts` 与 `app.ts` 的接线都没有测试覆盖；
  模型层已被 `test/rendererCompletion.test.ts` + `test/rendererShellModel.test.ts` 钉死，缺的是真机那一段）：
  ① `/model` → ↑↓ 选中 → Enter，transcript 出现 "Model set to: …"、状态栏模型跟着变、面板自动关掉；
  ② 同一个面板改用鼠标点一行，结果一致（两条路走同一个 `runSurfaceAction`）；
  ③ 面板开着时先打几个字再按 Enter → **发消息而不是选模型**；Esc 仍然只关面板；
  ④ 打 `@src/desk` → 出现文件下拉 → Enter **只补全不提交**，Tab 同样；选目录不带尾空格、选文件带；
  ⑤ 快速连打再退格，下拉不闪回旧结果（序号守卫）；打 `@` 后改打 `/`，不会有文件结果盖上来；
  ⑥ `/tasks` 选一行 → 输出写进 transcript；`/resume` 选一个旧会话 → 对应窗口聚焦/新开，标签栏两边都更新。
- [ ] **3g 的 rewind 冒烟**（`dom/rewindView.ts` 与 `app.ts` 的接线没有测试覆盖，模型层已被
  `test/rendererRewindPanel.test.ts` 27 个用例钉死；其中 ③④ 会真花钱/真改工作树，最后做）：
  ① `/rewind` → 面板出现、光标停在 **"(current)"**、Esc 关掉；
  ② ↑ 选一个 checkpoint → Enter 进确认屏 → Esc **回到列表而不是关掉面板**；
  ③ 选 `Restore conversation` → transcript 重绘到那条消息之前、系统行是
     `Conversation rewound to before "…"`、面板自动关；
  ④ 一个改过文件的 checkpoint 选 `Restore code and conversation` → 工作树真回滚；
     再试一次 `Summarize up to here`（真实 provider 调用，慢）→ 出现 compact 边界；
  ⑤ 面板开着时让一个工具触发权限提示（`window.hanekawa.send({type:'run-tool',name:'Write',…})`）→
     提示画在 rewind 面板**之上**，答完之后 rewind 面板还在、还能用；
  ⑥ 面板开着按 Ctrl+W 仍然关窗（tab-bar 和弦在 keymap 之前解析）；按住普通字母键什么也不该发生；
  ⑦ 在窗口里 `/clear` → rewind 面板若开着应当**自动关掉**（不是留着报 "Message not found"）；
  ⑧ TUI 侧回归：`/rewind` 与 Esc-Esc 打开的是同一个面板，且五条结果文案与桌面端逐字相同。
- [ ] **3h 的队列与费用冒烟**（`dom/queueView.ts`、`dom/composerView.ts` 的状态栏与 `app.ts` 的接线都没有
  测试覆盖；模型层与协议层已被 `test/rendererQueuedMessages.test.ts` + `protocolHost` 的 10 条
  + `desktopUiRoundTrip` 的 2 条钉死，缺的是真机那一段。① 需要一个真的长 turn，所以要真实 API key）：
  ① 发一个长 turn → 流式中打字按 Enter → 消息进 `#queue` 条**而不是消失**、按钮字样是 "Queue"
     → turn 结束后自动发出、`#queue` 条自己消失；
  ② 连续入队两条 → 顺序正确、逐条发出（不是并发两个 turn）；
  ③ 入队后点 Clear → 条目清空，且 turn 结束后**不会**突然冒出来；
  ④ 入队后来一条权限提示 → 答完之前不泵，答完才泵（这条模型层测不到真实 `PermissionGate`）；
  ⑤ 入队后 `/clear` → 队列跟着新会话走（`migrateTo`）；`/resume` 一个旧会话 → 队列换成那个会话自己的
     （`reset`），不是带过去；
  ⑥ 关窗再开 → `hello.queuedMessages` 把还没发的那条重新画出来（队列是从会话日志重放的）；
  ⑦ 状态栏 `#status-cost` 随 turn 增长；`/cost` 的数字与它一致（有 `test/protocolHost.test.ts` 的
     行为断言兜着，但真机要确认状态栏那一格真的在画）；换到一个**没配 pricing** 的模型 → 那一格变空，
     而不是显示 0；
  ⑧ TUI 侧回归：Enter 排队、Esc-Esc 清队列、`/cost` 三者都没变（本轮只把 `getUsage` 换成了共享函数）。

---

## 验证

```bash
npm run typecheck                                     # 三段：base + preload + renderer
npm run test                                          # 1943 tests / 39 suites, ~45s
npm run build                                         # emit 到 dist/（只有桌面外壳需要）
npm run build:desktop                                 # tsc emit + 两个 esbuild bundle + 拷 index.html
npm run start:desktop                                 # 真实 Electron，需要桌面
npm run dev:tui                                       # 手动冒烟，需 TTY

# 按主题跑
node --import tsx --test test/protocolWire.test.ts test/protocolHost.test.ts \
  test/protocolClient.test.ts test/protocolClientParity.test.ts test/bridgesPending.test.ts \
  test/protocolCommandSchema.test.ts
node --import tsx --test test/protocolChildProcess.test.ts    # 真实进程边界（tsc 看不见的那段）
node --import tsx --test test/distBuild.test.ts               # emit 后用纯 node 载入
node --import tsx --test test/sessionScope.test.ts test/sessionWorkspace.test.ts \
  test/sessionSwitch.test.ts test/sessionFileLock.test.ts
node --import tsx --test test/electronChannel.test.ts test/bridgeChannel.test.ts \
  test/desktopMain.test.ts test/desktopBuild.test.ts
node --import tsx --test test/rendererImports.test.ts test/rendererShellModel.test.ts \
  test/rendererMarkdown.test.ts test/rendererTranscriptModel.test.ts test/rendererPermissionView.test.ts \
  test/rendererAskUserQuestionView.test.ts test/rendererPlanDialogViews.test.ts \
  test/rendererCompletion.test.ts test/rendererRewindPanel.test.ts test/rendererQueuedMessages.test.ts \
  test/rendererDiffRows.test.ts test/rendererTabBarModel.test.ts test/desktopUiRoundTrip.test.ts
node --import tsx --test test/permissionPresentation.test.ts test/planPresentation.test.ts \
  test/rewindPresentation.test.ts test/restoreMode.test.ts test/restoreMode.property.test.ts \
  test/usePermission.test.ts test/fileToolPreview.test.ts test/modelPicker.test.ts
node --import tsx --test test/toolRegistry.test.ts test/runtimeBootstrap.test.ts \
  test/modelSwitch.test.ts test/runOverrides.test.ts test/subagentInspection.test.ts
```

**已知不稳定**：`test/toolcall-integration.test.ts` 在全量**并发**跑时会挂在
`Unable to deserialize cloned data due to invalid or unsupported version` —— 这是 Node test runner 自己的 IPC 报错，
不是断言失败。单独跑必过（3/3），在未改动的基线上同样复现，`--test-concurrency=1` 串行干净。
它是**间歇的**：既不要因为一次并发跑绿了就认为已修，也不要因为它挂了就去找自己的回归。

第二个（3f 期间观察到）：`test/backgroundTasks.test.ts` 的
`background Bash returns immediately and BashOutput consumes incremental output` 在全量并发跑时偶尔超时红一次
（该用例本身要等一个真实子进程吐增量输出，1.7s 量级）。单独跑 3/3 全绿，紧接着的全量跑也全绿；
它只 import `services/backgroundTasks/` 与三个 bash 工具，与桌面端毫无交集。同样是**间歇**，不要当回归追。

第三个（3h 期间观察到，只见过一次）：`test/agentTool.test.ts` 的
`parent bypass mode still takes precedence for background agents`。单独跑 81/81 连过两轮，
与 3h 改动零交集（不碰 `agentTool.ts` 也不碰权限门）。**注意 `toolcall-integration` 那条在
`--test-concurrency=1` 下也会红** —— 上面写的"串行干净"是 3g 时的观察，3h 期间串行跑 3 次里红了 2 次，
所以串行**不是**它的解药。3h 的实测分布：串行 3 轮里 1 轮全清（只剩下面那条环境依赖的），
另 2 轮多一条 `toolcall-integration`。基线（`git stash` 后）2 轮全清 —— 这个差值仍在间歇的方差内，
不要据此推断某轮改动引入了不稳定；判据是"单独跑是否稳定通过"。

**已知环境依赖失败**（3g 期间查明，与桌面端无关，尚未修）：`test/config.test.ts` 的
`providers report dynamic ToolSearch support conservatively` 在**设置了 `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`
的环境里必定红**（在 Claude Code 里跑 `npm run test` 就是这种环境）。它不是间歇、也不是回归：
用例只 save/delete/restore 了 `HANEKAWA_DISABLE_EXPERIMENTAL_BETAS`，而它测的
`isExperimentalToolSearchBetaDisabled()`（`src/utils/toolSearch.ts:132-135`）读的是**两个**变量的或；
第二个还留在环境里，于是 `AnthropicProvider.supportsDynamicToolSearch('claude-sonnet-4')` 返回 false，
第一条断言（期望 true）就挂。已用 `git stash` 在干净基线上复现。修法是让该用例对两个变量都做隔离
（文件里已有 `setEnv` 助手）。**在这种环境下 1943 里应当只有这一条红**（3h 落地后实测仍然如此）。
