# Hanekawa 桌面端适配 — 进度与待办

> 交接文档。**架构与不变式在 `CLAUDE.md`**，本文件只讲进度、决策留痕和没做完的事。
> 状态：`[x]` 完成并验证 · `[~]` 部分完成 · `[ ]` 未开始

---

## 目标

**阶段 0–3j（已完成，归档）**：把 agent 内核抽成 headless 运行时，搬进 Electron，跑通协议层命令、
多标签、多项目、markdown、rewind、消息队列与费用。时间线见 git log（`34fbea0` 之前）。

**阶段 4（已完成，归档）**：把外壳从「能跑的开发者原型」做成产品形态——单窗口 + lane 多路复用、
侧边栏全量会话历史、删除会话、设置界面（Provider / 权限 / Agent / 通用+MCP+上下文）、按
`design_guidance.md` 首轮重做视觉、取消三档模型路由、真机冒烟（CDP，驱动已纳入 git）。
子阶段 4a–4f 均已落地验证；实现细节见 git log 与 `CLAUDE.md`，遗留缺陷见下方「已知缺陷」。

**阶段 5（本阶段）**：`design_guidance.md` 已被重写扩展为完整组件解剖 + 双主题规范。把其中**能映射到
现有能力**的部分落地 + 新增双主题。无对应后端的设计项（拉取请求、已安排、插件生态、语音、宠物、
电脑操控、浏览器、Git、Worktrees、钩子界面、通知铃铛、分栏对比、右侧检查器）**一律省略**。

### 阶段 5 已确认的决策

| 主题 | 决策 |
|---|---|
| 无后端项 | **一律省略**，只做映射到现有功能的界面 |
| 主题 | **双主题 + 新增「外观」设置页**，默认**跟随系统**，可手动切深/浅 |
| 画布头栏 | **会话身份(图标+标题+⋯菜单) + 「打开位置」**；省略分栏/检查器 |
| 打开位置 | **固定 `code <cwd>`**，未装 VS Code 回可读错误 |
| 侧栏头部 | **工作区下拉(=项目切换) + 会话搜索框**；铃铛省略 |
| 推荐卡 | **仅视觉引导**，点击只聚焦输入框 |
| 上下文胶囊 | 显 **项目 + 本地 + 分支**（分支读本地 git HEAD），均只读 |
| 思考链折叠头 | **流式展开，turn 结束自动折叠**成「已处理 Xm Xs ⌵」 |
| 权限胶囊 | 菜单露 **default / acceptEdits / plan / bypass**，复用现有 `set-permission-mode` |

---

## 阶段 5 待办

- [x] **5a — 双主题基础 + 外观设置页**：`styles.css` 加 `:root[data-theme="light"]` 覆盖块（按
  design_guidance「六、1」逐值填浅色，中性守 ≤20 饱和度：用 `#1a1a1e`/`#686b75` 而非 doc 的 `#111827`/`#6b7280`；
  `--accent-warn/-danger` 与 `--diff-*` doc 未给，选定 amber-600/red-600 + GitHub 风格 diff 色）；`app.ts` +
  新增纯函数 `model/theme.ts` 处理 `localStorage['ui-theme']`（`system|dark|light`，默认 `system`）与
  `prefers-color-scheme` 订阅，写 `documentElement.dataset.theme`（跟随系统在 JS 里解析，CSS 不用 `@media`）；
  `model/settings.ts` 加 `appearance` 分类（客户端卡片，走新的 `SettingsOutcome.themePreference` 通道，不发 wire；
  `cardsFor` 收窄成 `Exclude<…,'appearance'>` 保穷尽守卫，`settingsView` 在 snapshot 守卫前早返回 appearance）。
  `rendererStyleTokens.test.ts` 已改双主题两组（parser 读两个 token 块、palette/阶梯/中性各按 dark+light 参数化，
  阶梯用 `sign` 承接浅色反转）；新增 `rendererTheme.test.ts`；`rendererSettingsModel.test.ts` 补 appearance 用例。
  **验证**：focused 四件套 76 pass、typecheck 三段全过、protocol/desktop 回归全绿。
- [x] **5b — 侧栏改造**：工作区下拉（`model/sidebar.ts` 加 `SidebarWorkspace` + `workspacesOf`，触发器显活动
  项目名、菜单列全部已知项目；选中走新纯函数 `selectWorkspaceIntent`——该项目有 lane 则 `switch`，无则
  `newSessionIntent`，复用现有意图零新 wire）；会话搜索框（`SidebarState.searchQuery` + `sidebarView` 建 group
  前按 title 大小写不敏感子串过滤；`noMatches` 与 `isEmpty` 分开两种空态；搜索框是**持久节点**不进 `replace()`
  区、`input` 事件驱动、`app.ts` 持真值不回写，容器 keydown 对 `event.target===search` 早返回免得 Backspace/
  方向键被当成删行/移光标）；`running` 徽标换 `icons.ts` 新增 `spinner` 弧线图标 + `@keyframes spin`（awaiting-input
  仍静态点）；footer 齿轮从胶囊重排成用户档案行样式（图标+「设置」左对齐、`?` 帮助本就不存在故无需删）；
  `workspaceMenuOpen` 由触发器翻转、选中/焦点离开侧栏（复用 `focusout`，仅在 open 时发 toggle 故只会关）关闭。
  signature 补 `searchQuery`/`workspaceMenuOpen`/`workspaceName`/workspace 项，变异表加两行并做了变异验证。
  **验证**：focused（sidebar+styleTokens+imports+theme）全过、typecheck 三段全过、全量 2214 pass / 0 fail、
  `build:desktop` emit 正常。真机冒烟未跑（需显示器+凭据）。
- [ ] **5c — 空状态欢迎页**：新增 `model/welcome.ts` + `dom/welcomeView.ts`，transcript 为空时显示；
  Hero 标题（项目名虚线下划线可点切项目）；3 张推荐卡（仅视觉引导，点击只聚焦输入框）；
  上下文胶囊条（项目 + 本地 + 分支）。
- [ ] **5d — 对话流增强**：思考链可折叠头（流式展开 / 完成折叠成「已处理 Xm Xs ⌵」，折叠态存 `paneSession`）；
  用户消息内文件胶囊（`transcriptView.ts` 文本 token 化）；浮动回到底部按钮；「正在思考」呼吸标签。
- [ ] **5e — 输入框 + 画布头栏**：composer 加权限模式胶囊（4 模式，调已有 `set-permission-mode`，删状态栏
  那份模式文字）；发送按钮 idle/ready/streaming 三态 + 进度环；画布头栏（会话身份 + ⋯ 菜单复用
  `rename-session`/`delete-session` + 「打开位置」）。
- [ ] **5f — 设置分组重构**：`SettingsNavItem` 加 `group`，分个人/集成/编码三段（只收纳已有页，无后端页不出现，
  分组用穷尽 switch）；顶部搜索设置框；原生 `<select>` 改胶囊下拉观感。
- [ ] **新增 seam（跨层，谨慎）**：① `shellProtocol.ts`+`shellHost.ts`+`main.ts` 加 `open-in-editor`
  命令 `spawn('code', [cwd])`（补 `desktopShellHost` 用例）；② host 读 `<cwd>/.git/HEAD` 给渲染器提供
  分支字符串（读失败则分支胶囊不显示，不阻塞）。

---

## 待办（阶段 4 遗留，记账未修）

下面是记账未修的缺陷，每条都是独立的一档。

### 已知缺陷（记账未修）

- **3e 遗留两条**：① **代码块没有语法高亮** —— TUI 用的 `cli-highlight` 出 ANSI 且是
  Node 侧的，浏览器侧要另选一个能进 renderer bundle（无 Node 依赖）的库，独立一档；
  ② `markdownNode` 每次重建整棵子树、`transcriptView` 每 token 全量重画 —— 解析有
  LRU 兜着，**建节点没有**。真机上长会话流式若卡，按 `transcriptView` 文件头写的那条路
  走（按 item id 建 key 增量更新），不要回头去搞 static/live 分区。
- **其余 `"latest"` 依赖**（`tsx`、`zod`、`openai` 等）未钉版本；它们不参与 emit，
  要清理另开一条。
- **`PaneSession` 有四个成员已无人调用**：`panes` / `refreshPanes`（4a 起就死了——tab bar 换成
  `shellClient.getLanes()` 之后没人读）、`ownProjectRoot` / `isActive`（4b 死的，侧栏改从
  `WireLaneInfo` 与 activeLane 推）。无害。留给任何一次单独提交。
- **`StartupPermissionMode` 的类型比校验宽**：它是 `Exclude<PermissionMode,'plan'>`，所以类型上还允许
  `'readonly'`，而 `validateSettings` 只认 default / acceptEdits / bypass——写 `readonly` 的设置文件
  根本加载不了。4d-2 在投影处加了 `startupMode()` 兜到 `'default'`，但源头那对不齐没修。
- **自定义 agent 定义不能写 `permissionMode: readonly`**：`agentDefinitionLoader` 的
  `parseOptionalPermissionMode` 只认 default / plan / acceptEdits / bypass，而内置的 `explore` / `plan`
  两个 agent 用的正是 `'readonly'`。文件会被跳过并只打一行 warning。4d-2 写用例时踩到，未修。
- **`settings.autoCompact` / `autoCompactThreshold` 无人消费**（4d-2 查实）。
  要么接上真正的自动压缩，要么删掉它们和 `configTool` 里的两条——独立一档。
- **`Ctrl+W` / 侧栏关闭不检查 `blocked`**，而 LRU 驱逐是**绝不**碰有未答阻塞请求的 pane 的
  （`paneBudget.isPinned`）。两者机制相同但情境不同：驱逐用户没要求，`Ctrl+W` 是用户明确要求。
  要做得更好得加个确认，是新范围——记账未做。
- **`SessionStore.list()` 用 `localeCompare` 排 ISO 串**（`sessions/service.ts`），比 `<` 慢约两个
  数量级。本来只在 `/resume` 时跑一次，4b 之后每个 turn 结束都跑一次。真正的成本见下面 4f 那条。
- **`sidebarRenderSignature` 是字符串比较**，行数极多时 O(rows) 建串。够用；真要更进一步是按 item id
  做增量行更新（与 `transcriptView` 那条同一条路）。
- **MCP 服务器本身仍不能在界面上增删改**（`McpServerConfig` 没有写入 API），`hooks` 也没有界面；
  `fallbackModel` / `compactModel` 依旧只读（`ConfigService` 没有对应 setter）。
- 已修（勿再记账）：`.myagent/shadow-git/<id>` 删会话时泄漏（4b `removeShadowRepo`）、
  `runSidebarIntent` 缺穷尽检查（4d `assertNeverIntent`）、`settings.local.json` 没有「写整组」
  与 untrust（4d-2 `updateLocalSettings`）、MCP 连接只在 bootstrap 发生一次（4d-2 `reloadMcpServers`）、
  答完权限后徽标不消 / 设置界面 Esc 是死的 / `.sidebar-settings` 没有样式（4f）。

### 4f 新记的账

- **`paneSession.ts` 与整个 `dom/` 没有任何单元测试**（测试运行器里没有 DOM，devDeps 里也没有 jsdom）。
  4f 修的两个 bug 都在这里，**唯一的凭据是冒烟的 S2 / S8**。要么给渲染器加一个最小 DOM stub
  （`el()` 只用到 `createElement`/`appendChild`/`replaceChildren`/`hidden`/`classList`），要么继续把
  决策往 `model/` 挪。独立一档。**（阶段 5 会大量动 `dom/`，这条更值得先做。）**
- **系统提示语没有本地化**：真机上一次 turn 里出现的 `Effort set to: low` / `Switched to step-3.5-flash.` /
  `Worked for 3.6s` 都还是英文，夹在全中文界面里。4e 的 `locale` 只加在三个 presentation 模块上，这些
  note 来自命令与运行时的 note 路径（TUI 也在用），是另一条通路。
- **效力选择器里的档位是英文原值**（`surfaces.ts` 的 `label: level`），而胶囊用的是 `EFFORT_LABELS` 的
  中文（`低/中/高/极高/最高`）。同一个概念在相邻两个控件里两种写法，选一种。
- **`sessions/index.json` 每个 turn 结束都被整目录扫一遍**：`SessionStore.list()` 的 `localeCompare`
  只是表层，真正贵的是它下面的 `readIndex → recoverIndex`——`readdir` 整个 sessions 目录，对不在 index 里的
  `.jsonl` 还要 `readFileSync` + 全量解析。4b 之后这条路每个 turn 走一次（每项目一次）。

---

## 决策留痕（只留 `CLAUDE.md` 未覆盖的）

- **4b：侧栏的两个键入口必须分开**。全局那个（`sidebarChordToIntent`）在 `resolveKey` **之前**解析，
  所以不带 ctrl/meta 必须恒返回 `'none'`；侧栏聚焦那个（`sidebarKeyToIntent`）挂在容器上，方向键/Enter
  因此不会从 composer 手里抢走。合成一个入口就必然要么让方向键全局生效，要么给 `resolveKey` 加一档。
- **4b：分组的 `own` 语义变了**。旧 tab bar 里 `own` 决定「能不能关」，所以
  `ownProjectRoot === undefined` 解释成「全部是自己的」；侧栏里 `own` 只决定**组的顺序**，把每组都置顶
  等于都不置顶，所以 undefined 解释成「都不是」。只有**跨项目**切换才重排，同项目内列表永不动。
- **4b：徽标不新增 wire 字段是可行的**，`getSnapshot().isStreaming` + `shellState().hasOverlay` 就够。
  代价是 `onShellChanged` 要给**每个** pane 重绘侧栏。
- **4b：盘上拉取只挂四个时机**（启动 / `lanes` 事件 / 某 pane 的 `isStreaming` **下降沿** / 删除之后），
  绝不挂 snapshot tick——`onShellChanged` 一个 turn 里会响多次。
- **4b：驱逐宁可超额也不杀正在跑的**。`selectEvictions` 在「剩下的全 pinned」时返回**不足数**。多留一个
  常驻 pane 只花内存；驱逐一个停着提示的 pane 会让它的 bridge 以**拒绝**收尾，用户的工具调用静默失败。
- **4b：`removeShadowRepo` 的参数闸门不是洁癖**。`delete-session.sessionId` 是线上字符串，直通一次
  `rm(recursive)`；`''` / `'..'` / 带分隔符都会解析到 `.myagent/shadow-git` 本身。调用方必须传
  `store.resolve()` 之后的 id：`store.delete` 认前缀，`removeShadowRepo` 不认。
- **4a：`ShellHost` 的泛型默认值陷阱**：约束 `W extends ShellLaneWorkspace<PaneT>` 引用了前面的类型参数，
  而**默认值**在 `PaneT` 未解算时就要满足约束。解法：默认值写结构切片 `ShellLaneWorkspace<PaneT>`，
  main.ts 显式写全三元组。
- **4a：close-pane 是自毁命令，reply 天然丢失**：渲染器的 pending 由 lane close 触发
  `failAllPending('The host disconnected')` 吸收；测试里是 `assert.rejects(/disconnected/)`。
- **4a：渲染器初始化一律拉取**：Electron 会丢弃 preload 监听器注册前投递的 IPC，所以 renderer 启动只信
  `shellClient.panes()` 拉取 + 之后的 `lanes` 事件。
- **4a：`deactivate()` 清绘制不清状态**：单例面板上一个 pane 的 paint 若不清，切 pane 后会画着别人的
  对话框，而键盘路由只认 active pane。状态留在 paneSession 里，`activate()` 一次性重绘回来。
- **4a：darwin 最后一个 lane 关掉保留空窗口**（非 darwin 照旧 quit）。空窗口侧栏仍显示「+ 新建会话 /
  打开项目…」，这正是留它的用处。
- **main.ts 的 lane↔pane 簿记**：键必须是**不随 `/clear`、`/resume` 移动**的那个。按 `paneId` 线性扫
  `pane.getSession().id` 就能找到；闭包到自己意味着一个渲染器关别人的标签会关错窗口。
- **`ToolRegistry.refresh()` 把 Agent 工具移到数组末尾是对的**：工具顺序是 prompt 缓存键的一部分，
  「MCP 重连过的 runtime」与「新建的」工具数组必须逐位相同。
- **`createRuntime` 里 `onActiveSessionChange?.(id)` 放在所有会抛的校验之后**：模型 key 无效时不能已经
  把会话级状态切过去。
- **配置串校验**：名字拼错时 `resolveModelReference` 返回 `undefined` 与「没配置」无法区分而被静默忽略
  —— 已改为校验原始配置字符串，`fallbackModel`/`compactModel` 出 `RuntimeDiagnostic` 警告而不拦启动。
- **App.tsx「先定义后 `useCommands`」惯例**：传进 `useCommands({…})` 的 handler 必须定义在调用之前（TDZ）。
- **3j 的四个决策**：① 一个项目的最后一个窗口关掉就 `shutdown` 它；② 入口是「Open project…」按钮 +
  `Ctrl+Shift+O`，不做原生 File 菜单；③ 别的项目的标签**只能聚焦**；④ 跨项目一律走 shell 旁挂命令。

---

## 工作方法（本项目的验收惯例）

- **变异验证**：每加一条不变式，就把 bug 逐个塞回去，确认是**预期的那条**用例报红。**手工 patch/revert
  要 grep 回滚结果**：mutation 可能只删了调用行、注释留着，revert 的搜索串就对不上，全量跑变红才发现。
- **断言只值它的假货那么多钱**：变异验证抓到 `get-settings` 的掩码用例原本是**空的**——`FakeConfig.resolveModel`
  没有像真的那样把 endpoint 的 `apiKey` 折进去，于是真实泄漏 bug 一路全绿。凡是用例守的是「真实现会做 X，
  所以必须防着 X」，**假货就必须真的做 X**。
- **`as unknown as` 关掉的正是编译器唯一能抓 API 谎言的机会** —— 已七次应验。**正解是泛型或结构切片**：
  `ProjectDirectory<FakeProject, FakeWorkspace>`、把入参从 `ConfigService` 收窄成只含它真读几个成员的切片
  —— 测试传普通对象、零 cast，约束仍然检查假货。
- **真机冒烟先怀疑驱动，再怀疑 app**：判据是**先在没有 CDP 的情况下复现**，再拿 `git worktree` 建一份
  HEAD 基线对照。`Target.setDiscoverTargets` 会让新窗口的渲染器不启动，别开它。**驱动的失败信息必须带
  「最后看到的值」**——`waitFor` 只报「超时」时没法区分「应用没动」和「应用动错了」。
- **变异验证也会打在用例自己身上**：4f 给「每个按钮都得有样式」补的用例，第一版把 `:hover`/`:disabled`
  也算作「有规则」，把 bug 塞回去仍全绿——报废的是**判据**，不是实现。**变异验证失败时，先怀疑自己的
  判据太宽，别急着放过 bug。**
- **真机验证走 CDP，不加调试开关**：`electron . --remote-debugging-port=9222` + node 内置 `WebSocket`
  直连，`Runtime.evaluate` 读 DOM、`Input.dispatchKeyEvent` 发真键；权限对话框用 `run-tool` 零花费触发。
- **测的实现必须就是出货的实现**：renderer channel 曾有测试/出货两份，main 侧工厂的 API 谎言被专门写的
  mock 一路放行。
- **`test/protocolChildProcess.test.ts` 的 host 侧脚本是字符串**（写进临时 `.mjs`），`tsc` 看不见 ——
  改 `SessionHost` 构造 deps 必须手动同步。这也是 `SessionHostDeps` 里几个成员**故意是可选**的原因。
- **负向断言要给异步留时间预算**（`givePumpAChance()` 150ms）：紧跟 enqueue 就断言「什么都没发」测的是
  竞态不是闸门。
- **被测行为的差别在持久化侧时，断言不能只站在 wire 上**：`/clear` 的 `migrateTo` 与「什么都不做」协议层
  完全同形，用例得读会话日志里的 enqueue / 补偿 `clear` 记录。
- **provider 回调里抛的断言会被摘要路径吞掉**，浮上来的是另一个外层断言 —— 按报错行找会找错地方。
- **`protocolClientParity` 的 COVERAGE 表解析 `tui.tsx` 的 `<App` props 源码**，免费接住新 prop，别绕过它。

---

## 验证

```bash
npm run typecheck                                     # 三段：base + preload + renderer
npm run test                                          # 全量，~42s
npm run build                                         # emit 到 dist/（只有桌面外壳需要）
npm run build:desktop                                 # tsc emit + 两个 esbuild bundle + 拷 index.html/styles.css
npm run start:desktop                                 # 真实 Electron，需要桌面
npm run dev:tui                                       # 手动冒烟，需 TTY

# 真机冒烟（要显示器 + 真实 endpoint/凭据，**不在 npm test 里**）
npm run build:desktop && npm run smoke:desktop        # 默认不花钱，十条里第 1 条 SKIP
npm run smoke:desktop -- --paid-turn                  # 加上唯一那次真实 turn
npm run smoke:desktop -- --only=S7,S2 --verbose       # 改驱动时的窄跑法
npm run smoke:desktop -- --kill-stale                 # 上一次的 electron 还占着单实例锁时
# 截图与 summary 落在 .smoke/<时间戳>/；summary 末尾列出每张图要看什么

# 阶段 5 相关（渲染器纯模型 + 设置持久化 + shell）
node --import tsx --test test/rendererStyleTokens.test.ts test/rendererSettingsModel.test.ts \
  test/rendererSidebar.test.ts test/rendererTranscriptModel.test.ts test/rendererComposerChip.test.ts
node --import tsx --test test/desktopShellHost.test.ts test/settingsPersistence.test.ts

# 既有主题（回归）
node --import tsx --test test/protocolWire.test.ts test/protocolHost.test.ts \
  test/protocolClientParity.test.ts test/protocolCommandSchema.test.ts
node --import tsx --test test/rendererImports.test.ts test/desktopMain.test.ts \
  test/desktopBuild.test.ts test/desktopUiRoundTrip.test.ts
```

**已知不稳定**（三条都是**间歇**，判据一律是「单独跑是否稳定通过」）：`test/toolcall-integration.test.ts`
（Node test runner IPC 报错，非断言失败；`--test-concurrency=1` 也会红）、`test/backgroundTasks.test.ts`
的增量输出用例（要等真实子进程，1.7s 量级）、`test/agentTool.test.ts` 的 bypass 用例（仅观察到一次）。

**已知环境依赖失败**（与桌面端无关）：`test/config.test.ts` 的
`providers report dynamic ToolSearch support conservatively` 在设置了
`CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` 的环境里必定红——用例只隔离了
`HANEKAWA_DISABLE_EXPERIMENTAL_BETAS`，而 `isExperimentalToolSearchBetaDisabled()` 读的是两个变量的或。
**这条依赖的是环境变量，不是「在 Claude Code 里跑」。** 看到它报红先 `echo` 一下那两个变量，别当成回归。

**阶段 4 基线**：4f 后全量共 2199 条，实测 2199 pass / 0 fail，typecheck 三段全过，真机冒烟十条全绿。
阶段 5 的新增用例应在此基线上累加。
