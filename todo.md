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
    渲染器补全要用的 `list-commands`，现在是 **31**。真正没改的是那 27 条：pane 命令是**旁挂**的一层，
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

- [ ] **Markdown 渲染**：`marked` 出 HTML 串，而渲染器禁 `innerHTML`（模型产出里的 `onerror=` 不受 CSP 管），
  要先有 sanitizer 或手写块渲染器。目前 assistant 消息与计划正文都是 `white-space: pre-wrap` 纯文本。
- [ ] **文件树 / `@` 补全**：没有能列目录的 wire 消息。
- [ ] **rewind / checkpoint 面板**：四步破坏性流程。
- [ ] **费用显示**：`ModelPricing` 不在 `WireRuntimeSnapshot` 上。
- [ ] **消息队列**：要记录流；在 `SessionController.submit` 的在途守卫进内核之前，正确的临时行为是关闸而非排队。
- [ ] **面板可点选**：`/model` 列出三档但要靠 `/model <tier>` 选。要能点就得让渲染器知道每行对应哪条命令 ——
  一次小的协议决定。

（标签栏已在 3b 补上，见上表；它不在这份清单里过。）

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

---

## 验证

```bash
npm run typecheck                                     # 三段：base + preload + renderer
npm run test                                          # 1819 tests / 39 suites, ~40s
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
  test/rendererTranscriptModel.test.ts test/rendererPermissionView.test.ts \
  test/rendererAskUserQuestionView.test.ts test/rendererPlanDialogViews.test.ts \
  test/rendererDiffRows.test.ts test/rendererTabBarModel.test.ts test/desktopUiRoundTrip.test.ts
node --import tsx --test test/permissionPresentation.test.ts test/planPresentation.test.ts \
  test/usePermission.test.ts test/fileToolPreview.test.ts test/modelPicker.test.ts
node --import tsx --test test/toolRegistry.test.ts test/runtimeBootstrap.test.ts \
  test/modelSwitch.test.ts test/runOverrides.test.ts test/subagentInspection.test.ts
```

**已知不稳定**：`test/toolcall-integration.test.ts` 在全量**并发**跑时会挂在
`Unable to deserialize cloned data due to invalid or unsupported version` —— 这是 Node test runner 自己的 IPC 报错，
不是断言失败。单独跑必过（3/3），在未改动的基线上同样复现，`--test-concurrency=1` 串行干净。
它是**间歇的**：既不要因为一次并发跑绿了就认为已修，也不要因为它挂了就去找自己的回归。
