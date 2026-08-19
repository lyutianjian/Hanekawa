# Hanekawa 桌面端适配 — 进度与待办

> 交接文档。**架构与不变式在 `CLAUDE.md`**，本文件只讲进度、决策留痕和没做完的事。
> 状态：`[x]` 完成并验证 · `[~]` 部分完成 · `[ ]` 未开始

---

## 目标

让 agent 内核被桌面 app（Electron）复用，TUI 与桌面端共享同一套 headless 运行时。
核心约 24.8k 行对 UI 完全无知（`src/` 中 `tui/` 之外 import `ink`/ANSI/stdout 的文件为 0），
终端的天花板 `transcript.ts`（Ink `<Static>` 不可回收）与 `layout.ts`（手工重算行高）在 DOM 里不存在。
选 Electron 而非 Tauri：依赖面（`child_process`、MCP stdio、fast-glob、shadow-git、patch-package）全是 Node。

---

## 已完成阶段

设计理由与不变式已写进 `CLAUDE.md`，此处只留时间线。

| 阶段 | 内容 | 测试基线 |
|---|---|---|
| 0 | 抽出 headless 运行时 `src/runtime/`（bridges/toolRegistry/mcp/createRuntime/bootstrap），`tui.tsx` 597→177 行 | 1386 |
| 0.5 | 缺陷清理 + `MessageQueue` 类化 + cwd 参数化 | 1394 |
| 1 | `SessionController` + `RuntimeSlot` + `queuePump`：turn 生命周期从 React hooks 下沉 | 1415 |
| 2a | 进程协议：`RuntimeChannel`、`HostEvent`/`HostCommand`、`SessionHost`/`SessionClient`、memory·node channel、权限 bridge 改排队 | 1468 |
| 2b | 协议补到「足以驱动一个渲染器」（11 个新命令、DTO 携带派生数据、`fileToolPreview` 下沉）+ 入站 zod 校验与两个防漂移守卫 + `run-command` 跨进程斜杠命令 + Electron 外壳（`main.ts`/`preload.ts`/channels、三个 tsconfig、`build:desktop`；修 4 个开机即死 bug） | 1703 |
| 3a | `ProjectRuntime`/`SessionScope` 拆分、`SessionPane` + `SessionWorkspace` | 1673 |
| 3b | 多标签协议：`open-pane`/`close-pane`/`list-panes` + `pane-list` 事件、`PaneRegistry`、一窗一 pane、渲染器标签栏；顺带 `list-commands` | 1818 |
| 3c | 渲染器可用视图：model/dom 模块、四个阻塞对话框、流式输出、Esc 中断、斜杠补全、四个 surface 面板、行级 diff | 1801 |
| 3d | 收 3b 的账（详见下面 main.ts 簿记一条）：`panes` Map 改 `BrowserWindow.id`、启动 `openPane({sessionId})` 恢复会话、`broadcastPaneListToOthers` 跨窗口广播、子进程字符串脚本补 dep | 1819 |
| 3e | Markdown 渲染（marked lexer → 自有 union，无 innerHTML）、`main.ts` 导航守卫 | 1846 |
| 3f | 面板键选/点选（`SurfaceAction`）、`@` 文件补全（纯半边下沉 + 序号守卫） | 1870 |
| 3g | rewind / checkpoint 面板：`rewindPresentation.ts` 共享决策、`/rewind` 斜杠命令（两端共享）、`#rewind` 独立模态层 | 1907 |
| 3h | 消息队列跨进程（归 host）+ 费用常驻：`enqueue-message`/`clear-queue`、`resolveUsageWithCost` 收掉三份重复、`#status-cost` | 1943 |
| 3i | 一个进程多个项目（core）：`CommandRegistry` 挂上 `ProjectRuntime`、三个字面量 cache source 在 mint 处绑 root、`multiProject.test.ts` | 1948 |
| 3i-pre | 清账：桌面端用户消息重复气泡（`applyRecord` 按 id 幂等）、`CommandRegistry.registerSkill`/`clearSkills` 让 `reloadSkills` 真的重注册 | 1951 |
| 3j | 桌面端打开第二个项目：`ProjectDirectory`（键=规范化 root、close→shutdown 顺序、唯一一份 `WirePaneInfo` 投影）、`focus-pane`/`open-project` 两条旁挂命令、`WirePaneInfo` 带 `projectRoot`/`projectName`、标签栏按项目分组（外来行只聚焦）、最后一个窗口关掉即 shutdown 该项目 | 1989 |

### 决策留痕（只留 `CLAUDE.md` 未覆盖的）

- **`ToolRegistry.refresh()` 把 Agent 工具移到数组末尾是对的，不要"修"**：新建 runtime 恒为
  `buildRuntimeTools()` + `push(agentTool)`，refresh 重现该顺序，「MCP 重连过的 runtime」与「新建的」
  工具数组才逐位相同 —— 工具顺序是 prompt 缓存键的一部分。
- **`createRuntime` 里 `onActiveSessionChange?.(id)` 放在所有会抛的校验之后**：模型 key 无效时不能
  已经把会话级状态切过去。
- **配置串校验**：名字拼错时 `resolveModelReference` 返回 `undefined` 与「没配置」无法区分而被静默忽略 ——
  已改为校验原始配置字符串，`fallbackModel`/`compactModel` 出 `RuntimeDiagnostic` 警告而不拦启动
  （三条确认不可达的启动错误分支已删）。
- **main.ts 的窗↔pane 簿记（3d，3j 改过一次）**：`panes` Map 以
  `BrowserWindow.id` 为键 —— session id 随 `/clear`、`/resume` 移动，window id 不动；`paneId` 字段只用于
  渲染器侧 `WirePaneInfo`。`onPaneOpened` 用线性扫描定位（`workspace` 自身就这么做，不引入第二份会漂移的
  索引）。`onPaneClosed` 原本闭包到自己的 `entryWindow`，理由写的是「回调拿到的 `paneId` 是 host 视角的
  **当前**会话 id，与开窗时的键从来对不上」—— 前半句对（键是 window id），**结论错**：按 `paneId` 线性扫
  `pane.getSession().id` 就能找到，而闭包到自己的窗口意味着一个渲染器关别人的标签会关错窗口。3j 改成
  `findEntryBySessionId(paneId) ?? entry`。`broadcastPaneListToOthers` 跳过发起者（host 已把更新送到发起
  窗口，重复推送幂等但省事）；OS 关窗路径（`'closed'` 回调）也要广播一次，那条不经过 host。
- **App.tsx「先定义后 `useCommands`」惯例**：传进 `useCommands({…})` 的 handler 必须定义在调用之前
  （TDZ），`openBackgroundTasks`/`openResumePicker`/`handleEnterRestoreMode` 都遵守，不加 ref 间接层。
- **3j 的四个决策**（问过一轮，全部按推荐落地）：① 一个项目的最后一个窗口关掉就 `shutdown` 它
  （否则 MCP 子进程和后台任务留在没有 UI 能停它的进程里；重开只是一次 bootstrap，几百 ms）；② 入口是标签栏
  「Open project…」按钮 + `Ctrl+Shift+O`，不做原生 File 菜单（决策进 `model/tabBar.ts` 就能被纯函数测到，
  `main.ts` 只留 `showOpenDialog` 那几行）；③ 别的项目的标签**只能聚焦、不给关闭按钮**（`TabRow.closable`
  的注释本来就是为这种情况留的，host 的 `PaneRegistry` 语义因此完全不变）；④ 跨项目一律走 shell 旁挂命令，
  **没有**给 `open-pane` 加 `projectRoot`。
- **3j 顺手修的两条现存缺陷**（都不是本轮引入，但都被本轮的不变式/冒烟逼出来）：
  ① `main.ts` 的 `onPaneClosed` 无条件销毁**自己**的窗口 —— 单项目下点别人标签的 × 就会关错窗口，改成按
  关闭的那个 pane 的 id 查窗口（`getSessionMeta()` 在 `controller.dispose()` 之后仍返回最后的 meta）；
  ② `applySessionSwitch` 不广播 `pane-list` —— `/clear`、`/resume` 移动了 `paneId`，所有标签栏都留着旧 id，
  那一行还在画但关不掉（"Pane not found"）。顺带 `SessionClient.hello()` 现在记下会话：不然
  `getSession()` 整个首个会话都是 `undefined`，桌面端**没有任何标签被标成 active**。
- **`ProjectDirectory` 用泛型而不是 `as unknown as`**：默认类型参数给外壳完整的 `RuntimeHost`/
  `SessionWorkspace`，测试写 `new ProjectDirectory<FakeProject, FakeWorkspace>()` 就不需要任何 cast，
  约束仍然检查假货有没有被真正调用的那几个成员 —— 这是「`as unknown as` 关掉的正是编译器唯一能抓 API 谎言的
  机会」那条经验的正解，值得往别的假货上推。

### 工作方法（本项目的验收惯例）

- **变异验证**：每加一条不变式，就把 bug 逐个塞回去，确认是**预期的那条**用例报红（已用它证伪过多条
  文档断言，如「没有 `default` 分支就能强制穷尽」实测是假的）。3j 做了 7 条（`describePanes` 回落、外来行
  可关、`focus-pane` 恒真、`closeProject` 顺序、`samePaneList` 少比字段、`applySessionSwitch` 不广播、
  `hello` 不记会话），全部只红预期的那几条。**手工 patch/revert 要 grep 回滚结果**：本轮两次「以为改回去了」
  实际没匹配上（mutation 只删了调用行，注释留着，revert 的搜索串就对不上了），是全量跑变红才发现的。
- **真机冒烟先怀疑驱动，再怀疑 app**：3j 的冒烟卡了四轮，三轮都是 CDP 驱动自己的问题 ——
  ① 每步重新 attach/detach 一个 DevTools session 会和浏览器自己的簿记打架，socket 一掉就长得像 app 卡死
  （改成一窗一 socket 全程持有）；② 让窗口关闭**自己**的 pane 时不能 `await` 那个 evaluate 的回包，渲染器
  会在回包之前就被销毁；③ 「我的标签」要按 `.active` 找，不能按「第一个非外来标签」（同项目两个窗口时那是
  兄弟窗口的）。判据：**先在没有 CDP 的情况下复现**（本轮用改 `dist/desktop/main.js` 自动开第二个 pane +
  `did-finish-load`/`render-process-gone` 日志，一次就证明 app 侧是好的），再拿 `git worktree` + node_modules
  junction 建一份 HEAD 基线对照。`Target.setDiscoverTargets` 会让新窗口的渲染器不启动，别开它。
- **测的实现必须就是出货的实现**：renderer channel 曾有测试/出货两份，main 侧工厂的两处 API 谎言
  被专门写的 mock 一路放行。
- **`as unknown as` 关掉的正是编译器唯一能抓 API 谎言的机会** —— 已四次应验：2b-2 三个开机即死 bug；
  3h 假 controller 的 `usage.total: null`；3i 五个假 project 拿掉 `commands` 字段后 25 条全绿
  （`protocolHost.test.ts` 会红 11 条，其余三个测试文件完全不接）。给 `ProjectRuntime` 加字段必须手动
  grep 五处假货，`tsc` 帮不上忙。
- **`test/protocolChildProcess.test.ts` 的 host 侧脚本是字符串**（写进临时 `.mjs`），`tsc` 看不见 ——
  改 `SessionHost` 构造 deps 必须手动同步（3a、3b 各踩一次，3b 那次连全量跑都没红）。
- **负向断言要给异步留时间预算**（`givePumpAChance()` 150ms）：`pumpQueue` 脱钩、`dequeue` 还要落盘，
  紧跟 enqueue 就断言「什么都没发」测的是竞态不是闸门 —— 3h 第一次变异验证就因此放行。
- **被测行为的差别在持久化侧时，断言不能只站在 wire 上**：`/clear` 的 `migrateTo` 与「什么都不做」
  协议层完全同形，用例得读新会话日志里的 enqueue 记录与旧会话日志里的补偿 `clear`。
- **provider 回调里抛的断言会被摘要路径吞掉**，浮上来的是另一个外层断言（`test/loop.test.ts` 的
  `compactProvider`）—— 按报错行找会找错地方。
- **`protocolClientParity` 的 COVERAGE 表解析 `tui.tsx` 的 `<App` props 源码**，免费接住新 prop
  （已三次），别绕过它。
- **真机验证走 CDP，不加调试开关**：`electron . --remote-debugging-port=9222` + node 内置 `WebSocket`
  直连，`Runtime.evaluate` 读 DOM、`Input.dispatchKeyEvent` 发真键、`Input.insertText` 打字；权限对话框用
  `window.hanekawa.send({type:'run-tool', name:'Write', ...})` 零 API 花费触发。零侵入探针：`app.ts` 只在
  `await client.hello()` 返回后才设 `document.title`，`Get-Process electron | Select MainWindowTitle`
  给出 `Hanekawa — <会话标题>` 就等于整条链通了。

---

## 待办

### 阶段 3 — 桌面独有能力 `[x]`

- [x] **跨进程 workspace 协议**（3b+3d）：`HostCommand` 从 27 增到 34，pane 命令是**旁挂**的一层而非
  参数化既有命令；`SessionHost` 经 `PaneRegistry` 解析/注册、建窗经 `onPaneOpened`/`onPaneClosed` 交回
  shell；一 pane 一对 `SessionHost`/`SessionClient`，Electron 侧无需多路复用
  （`test/desktopMain.test.ts:270`）。
- [x] **一个进程多个项目 — core**（3i）：两个进程级全局清零（`CommandRegistry` 挂 runtime、字面量
  cache source 在 mint 处绑 root）；扫过 `src/` 其余模块级可变状态，**没有第三个阻塞点**（其余的都按
  session id / cwd 天然分区或守单个共享文件）；`test/multiProject.test.ts` 是唯一凭据。同项目多标签
  本就不受限。
- [x] **桌面端打开第二个项目**（3j）：`main.ts` 的两个模块级变量换成 `ProjectDirectory`（键=规范化 root，
  `add` 拒绝重复），`main()` 收敛成 `openProject(resolveCwd())` —— 首个项目和第 N 个走同一条路径；
  `HostCommand` 34 → 36（`focus-pane`/`open-project`，纯转交，host 不碰 workspace）；多项目下 pane 列表的
  权威移到 shell（`describePanes` 从**窗口** map 投影，所以「列出来的 ⇒ 能聚焦」为真），`onPaneListChanged`
  是跨窗口扇出的钩子；标签栏按项目分组、自己项目在前、`Ctrl+1-9` 打可见序、外来行只聚焦不可关；
  `second-instance` 带着自己的 cwd 进来就开那个项目。`main.ts` 仍然一行测试都没有，凭据是
  `test/projectDirectory.test.ts` + `test/desktopMain.test.ts` 的跨项目用例 + 下面那条真机冒烟。

### 已知缺陷（记账未修）

- **3e 遗留两条**：① **代码块没有语法高亮** —— TUI 用的 `cli-highlight` 出 ANSI 且是 Node 侧的，浏览器
  侧要另选一个能进 renderer bundle（无 Node 依赖）的库，独立一档；② `markdownNode` 每次重建整棵子树、
  `transcriptView` 每 token 全量重画 —— 解析有 LRU 兜着，**建节点没有**。真机上长会话流式若卡，按
  `transcriptView` 文件头写的那条路走（按 item id 建 key 增量更新），不要回头去搞 static/live 分区。

### 杂项

- [ ] **固定 `typescript` 版本**：`package.json` 里仍是 `"latest"`（实际 7.0.2），用不固定的 major 做
  emit 是真实风险。卡在内网 npm 镜像（`http://172.16.9.57:8081/repository/npm-group/` 不代理 electron，
  `npm ping` `ECONNRESET`），网络恢复后做。
- [ ] **`design_guidance.md` 未落地**：一份 129 行的深色 UI 设计规范（Codex 桌面端提炼），目前渲染器
  完全没有按它实现。要么排期做视觉层，要么明确它只是参考资料。

### 未执行的手动冒烟（都需要 TTY + 真实 API key）

- [x] **2b-1 的权限对话框 TUI 冒烟**（欠得最久，且后续几轮**都没碰过 TUI 渲染路径**，风险面没变化）：
  ① 文件写入 diff 预览与改动前逐字一致 ② 200 行以上文件的「... (N more lines)」计数
  ③ 破坏性 Bash 仍显示 `DANGER` 且默认选中 `[N]` ④ 选 `[A]` 后规则真的生效（验证 `onAlwaysAllow` 新时序）
  ⑤ 多请求排队时 Tab 切换与 `Also waiting:` ⑥ 工具执行中 Ctrl+C ⑦ `/model` → `/clear` → `/resume`
- [x] **3a 的 `tui.tsx` pane 装配**（等价搬迁，参数逐字相同，其余对运行中的 TUI 全惰性）：
  启动 → 含工具调用的一个 turn → 权限弹窗 → `/clear` → `/resume` → `/model` → Ctrl+C 退出无残留进程。
  已知无害行为变化：`host.shutdown()` 现在会 dispose 初始 scope，退出时 `drainPending()` 把仍停泊的权限提示
  以 `false` 结清（改动前它们悬着直到进程退出）。
- [x] **3c 的两件**：① 流式 token 与 `#tool-progress` 行、Stop 按钮与 Esc 中断；
  ② 多个权限提示同时排队时的 Tab 切换与 `Also waiting:` 行 —— 注意 `AgentLoop.runTool` 走 `enqueue()` 的单一
  在途槽，两次 `run-tool` **不可能**并发出两个提示，真并发只来自一个 turn 内被批处理的工具调用。
- [x] **3b 的多窗口冒烟**（`main.ts` 没有任何测试覆盖，这是唯一的验证手段）：
  启动看到的是**最近一个会话**而不是空 draft → Ctrl+T 开第二个窗口 →
  两个窗口的标签栏都列出两个 pane → 在窗口 A 里 `/clear` 后，A 自己的标签页仍可点可关、B 的标签栏也跟着更新
  → Ctrl+W 关掉 A，窗口真的消失 → 关掉最后一个窗口，`before-quit` 走完 `host.shutdown()`，无残留进程。
- [x] **3d 修复的回归冒烟**：3b 那条按顺序走完，且额外加两点验证：
  ① 窗口 A 切到 `/resume` 一个旧会话（不是新建），A 的标签页仍可点可关（验证 `paneId` 在 `/resume` 后也没漂移）；
  ② Ctrl+W 与点标签页 X 两条关窗路径都试一遍，验证它们走的是同一份回调栈。
- [x] **3e 的 Markdown 冒烟**（`guardNavigation` 和整个 DOM 层都没有测试覆盖）：
  ① 一个含标题、列表、表格与围栏代码块的回答，流式过程中不错位、定稿后排版正确；
  ② 计划对话框（`ExitPlanMode`）正文是富文本而不是裸 `#`/`-`；
  ③ 点回答里的一条 http 链接 → 走系统浏览器，**Electron 窗口不跳走**（这是 `setWindowOpenHandler` +
  `will-navigate` 唯一的验证手段）；
  ④ 让模型输出 `<img src=x onerror=alert(1)>` 与 `[x](javascript:alert(1))` → 页面显示字面文本、
  没有弹窗、DevTools 控制台无 CSP 报错；
  ⑤ 权限对话框里的命令块与 diff 仍然逐字（**没有**被 markdown 化）。
- [x] **3f 的选择与补全冒烟**（`dom/surfaceView.ts`、`dom/composerView.ts` 与 `app.ts` 的接线都没有测试覆盖；
  模型层已被 `test/rendererCompletion.test.ts` + `test/rendererShellModel.test.ts` 钉死，缺的是真机那一段）：
  ① `/model` → ↑↓ 选中 → Enter，transcript 出现 "Model set to: …"、状态栏模型跟着变、面板自动关掉；
  ② 同一个面板改用鼠标点一行，结果一致（两条路走同一个 `runSurfaceAction`）；
  ③ 面板开着时先打几个字再按 Enter → **发消息而不是选模型**；Esc 仍然只关面板；
  ④ 打 `@src/desk` → 出现文件下拉 → Enter **只补全不提交**，Tab 同样；选目录不带尾空格、选文件带；
  ⑤ 快速连打再退格，下拉不闪回旧结果（序号守卫）；打 `@` 后改打 `/`，不会有文件结果盖上来；
  ⑥ `/tasks` 选一行 → 输出写进 transcript；`/resume` 选一个旧会话 → 对应窗口聚焦/新开，标签栏两边都更新。
- [x] **3g 的 rewind 冒烟**（`dom/rewindView.ts` 与 `app.ts` 的接线没有测试覆盖，模型层已被
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
- [x] **3h 的队列与费用冒烟**（`dom/queueView.ts`、`dom/composerView.ts` 的状态栏与 `app.ts` 的接线都没有
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

ps:手动冒烟测试基本完成，发现最大的问题是 user 发送后 message 会重复显示 —— **已修**（3i-pre）：
`turn-start` 用 `event.messageId` 先画一条，而那个 id 就是随后落盘的 `message` 记录 id
（`sessionController.ts:189` → `loop.ts:312`），renderer 的 `applyRecord` 又追加了一遍；现改为按 id 就地
替换（记录侧带 `displayContent`，是更权威的那一份）。TUI 没这毛病是因为它整条忽略 user 记录。

- [x] **3j 的多项目冒烟**（全部 CDP 自动化，零 API 花费；驱动脚本在
  `%TEMP%/hanekawa-smoke.mjs`，一窗一 socket 全程持有，用 `window.hanekawa.send` 直接发协议命令 +
  读 `#tab-bar` 的 DOM，最后 `taskkill` 收尾）。10 条全绿：
  ① 单项目：无分组标签、一个标签可关且被标成 active、`+` 与「Open project…」都在；
  ② `open-project` 带 path（避开点不到的原生框）→ 第二个窗口起来，两边标签栏都分成两组、各自项目在前；
  ③ 外来标签没有 ×；对它 `focus-pane` → `ok:true` 且窗口真被拿到前面，对幽灵 id → `ok:false`（自愈重拉）；
  ④ 对外来 pane 发 `close-pane` → host 拒绝（"Pane not found"），那个窗口安然无恙；
  ⑤ `Ctrl+T` 在**自己项目**里加一个标签，可见顺序是自己项目在前；
  ⑥ 项目 B 最后一个窗口关掉 → B 从 directory 摘掉并 shutdown（凭据：再 `open-project` 同一路径**新开了**
     一个窗口 —— 若还在 directory 里就只会聚焦、什么都不出现）；
  ⑦ 对**已开**的项目再 `open-project` → 不新开窗口；
  ⑧ `/clear` → 自己的标签 id 变了且仍可关，**另一个项目的窗口也看到了新 id**（这条就是上面修的第②个缺陷）；
  ⑨ `Ctrl+Shift+O` → 原生目录框弹出、app 仍然响应（**点取消需要人**，CDP 点不到原生模态）；
  ⑩ 收尾无残留 electron 进程。
  唯一"best-effort"的一条：点外来标签后靠 `document.hasFocus()` 判断窗口是否被拿到前面 —— OS 焦点在自动化下
  不保证，本轮实测是抬起来了，但没当断言。
---

## 验证

```bash
npm run typecheck                                     # 三段：base + preload + renderer
npm run test                                          # 1989 tests / 39 suites, ~48s
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
node --import tsx --test test/multiProject.test.ts test/commands.test.ts \
  test/commandSuggestions.test.ts test/skills.test.ts test/cacheBreakDetection.test.ts   # 项目隔离
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

**已知不稳定**（三条都是**间歇**：既不要因为一次并发跑绿了就认为已修，也不要因为挂了就去找自己的回归；
判据一律是「单独跑是否稳定通过」）：

- `test/toolcall-integration.test.ts`：全量并发跑挂 `Unable to deserialize cloned data due to invalid or
  unsupported version` —— Node test runner 自己的 IPC 报错，不是断言失败；单独跑必过，未改动基线上同样
  复现。**`--test-concurrency=1` 串行也会红**（3g 时观察串行干净，3h 期间 3 次里红 2 次）—— 串行不是它的解药。
- `test/backgroundTasks.test.ts` 的 `background Bash returns immediately and BashOutput consumes incremental
  output`（3f 观察）：全量并发偶尔超时红一次（用例本身要等真实子进程吐增量输出，1.7s 量级）；单独跑 3/3
  全绿；只 import `services/backgroundTasks/` 与三个 bash 工具，与桌面端无交集。
- `test/agentTool.test.ts` 的 `parent bypass mode still takes precedence for background agents`
  （3h 观察，仅一次）：单独跑 81/81 连过两轮，与 3h 改动零交集（不碰 `agentTool.ts` 也不碰权限门）。

**已知环境依赖失败**（3g 查明，与桌面端无关，尚未修）：`test/config.test.ts` 的
`providers report dynamic ToolSearch support conservatively` 在设置了 `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`
的环境里必定红（在 Claude Code 里跑 `npm run test` 就是这种环境）。它不是间歇、也不是回归：用例只
save/delete/restore 了 `HANEKAWA_DISABLE_EXPERIMENTAL_BETAS`，而它测的 `isExperimentalToolSearchBetaDisabled()`
（`src/utils/toolSearch.ts:132-135`）读的是**两个**变量的或，第二个还留在环境里。已用 `git stash` 在干净基线
复现。修法是让该用例对两个变量都做隔离（文件里已有 `setEnv` 助手）。**这种环境下 1989 里应当只有这一条红**
（3j 落地后实测 1988 pass / 1 fail；3i-pre 时实测 1948 pass / 2 fail，第二条是上面那条 `toolcall-integration`
的间歇 IPC 崩溃 —— 它一崩，runner 就把整个文件按 1 条计，总数会少显示一条；单独跑 3/3 全绿）。
