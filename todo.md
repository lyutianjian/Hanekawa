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
- [x] **5c — 空状态欢迎页**：新增 `model/welcome.ts`（`isTranscriptEmpty` 用
  `COUNTS_AS_CONVERSATION` 键表——`notice`/`error` 为 false，因为新草稿开局就带启动通知；`toolProgress`/
  `isThinking` 也算「已开始」）+ `dom/welcomeView.ts`（签名守卫，不可见时 `replace(container)` 丢掉子树
  而不只是 `hidden`，免得留下 Tab 停靠点）；Hero 拆 `titleBefore/projectLabel/titleAfter` 三段，中间是
  `button.welcome-project`（虚线下划线，`projectSwitchable` 为假时 disabled）；3 张卡点击**只**
  `composer.focus()`；胶囊条是 `span` 不是 `button`（只读），分支缺席时整条不产出。挂在 **pane 子树**
  `paneEl` 内（不是 index.html 单例），所以背景 pane 的 Hero 不会漏到活动 pane。`icons.ts` 加六个手绘图标
  （thought-bubble/megaphone/hammer/refresh/monitor/branch），卡片颜色走 `color` + `currentColor`，
  **零新 token**（`--accent-info/-tool/-review` 5a 就在了）。`app.ts` 的 `openWorkspaceSwitcher()` 组合
  「先展开侧栏 → toggle 菜单 → `sidebar.focusWorkspace()`」，最后一步是必需的：菜单靠容器 `focusout` 关。
  **前置一并做了**：① `test/helpers/domStub.ts` + `tsconfig.domtest.json`（第四个 TS 程序）+ typecheck 四段，
  `dom/` 第一次有单元测试；② git 分支 seam 走 `WireHelloResult.projectName/gitBranch` + 新
  `src/runtime/gitBranch.ts`。
  **验证**：新增 31 条（gitBranch 7 / protocolHost 1 / rendererWelcome 14 / rendererWelcomeView 8 /
  tsconfig 漂移守卫 1），全量 2245 pass / 1 fail（`backgroundTasks` 增量输出，单跑 8/8，见「已知不稳定」），
  typecheck 四段全过（并验证第四段非空：故意弄坏一个类型确认它会红），`build:desktop` emit 正常，
  九条变异验证全部报红在预期用例上。真机冒烟未跑（需显示器+凭据）。
- [x] **5d — 对话流增强**（本次）：三段各自独立可验。
  ① **浮动回到底部按钮**：`icons.ts` 加 `arrow-down`；`transcriptView.ts` 收第三个参数 `floatHost`（传的是
  `paneEl`，因为 `.pane` 才是定位祖先，而滚动容器里的绝对定位子节点会锚在**内容**底部而不是视窗底部，还会被
  每次 `replace()` 抹掉），按钮在 `render()` 外建一次、用 `hidden` 不丢子树（`[hidden]{display:none!important}`
  已经把它从布局/Tab 序/a11y 树里摘掉，单个 button 也没有子树要重建）；可见性由**同一个** `isScrolledToBottom`
  在 `scroll` 与 `render()` **两处**重算；点击走 `scrollTo({behavior:'smooth'})`。唯一的新 token
  `--shadow-float`（两个主题各一个值）。顺手删掉 `render()` 里那段等价于 `if (atBottom)` 的 `lastCount` 死逻辑。
  ② **思考链折叠头 + 呼吸标签**：`TranscriptItem` 加 `summary?`，`TranscriptState` 加**必填** `thinkingCount`；
  thinking 分组按「最后一条 pending 的 thinking 项」（不需要 turn 身份，`turn-end` 是唯一的封口处），id 来自
  计数器而**不是** `items.length`（丢草稿会让长度回缩、两条同号、一次 toggle 翻两条）；`turn-end` 与
  `applyRecord` 两处**只**再过滤 `DRAFT_ID`，改为封存（去 `pending`）+ 给最后一条挂 `summary`，**这一 turn
  有 thinking 就不再追加 `duration` 项**；新 `model/thinking.ts` 出两张脸的标签、`isThinkingCollapsed`
  （`Set` 记的是「与默认不一致」）、`pruneThinkingToggles`；折叠时 body 节点**不产出**（`.transcript` 是
  `aria-live`）；新导出 `formatWorkedDuration`，`formatTurnSummary` 出「已处理 7m 38s」。
  ③ **行内文件胶囊**：两条 `@` 正则提到 `runtime/suggestions/atToken.ts`（渲染器能进的那半），新
  `extractAtMentions` 带偏移并**按位置排序**（引号那遍先跑，不排序就会把句子读乱）；`harness/atMentions.ts`
  改为 import 那两条正则但**保留自己的两遍顺序**（引号优先是它的可观察行为，有用例钉着）；新
  `model/userMessage.ts` 的 `splitFileMentions` 原地切段，胶囊是 `span` 不是 `button`。
  **验证**：新增 39 条（transcript model 11 / thinking 4 / transcriptView 14 / userMessage 10（含一条
  fast-check 重组性质）/ atMentions 奇偶性 1 / styleTokens 1 — 另有既有用例扩写），全量 **2323 pass / 0 fail**，
  typecheck 四段全过，`build:desktop` emit 正常，十四条变异验证全部报红在预期用例上（含一次**判据太宽被抓**，
  见下）。真机冒烟未跑（需显示器+凭据）。
- [ ] **5e — 输入框 + 画布头栏**：composer 加权限模式胶囊（4 模式，调已有 `set-permission-mode`，删状态栏
  那份模式文字）；发送按钮 idle/ready/streaming 三态 + 进度环；画布头栏（会话身份 + ⋯ 菜单复用
  `rename-session`/`delete-session` + 「打开位置」）。
- [x] **5f — 设置分组重构**（本次；跳序做的，5d/5e 仍未开始）：三段各自独立可验。
  ① **分组**：`SettingsNavItem` 加 `group`，新 `SettingsNavGroup`，`SettingsViewModel.nav` **换成**
  `navGroups`（不并存两份——`src`/`test` 各只有一个消费者，两份同一列表正是过滤器自相矛盾的来源）；
  归组是 `groupOf()` 一个 `default`-less switch，**开在全部五个分类上而不是 `HostCategory`**（`appearance`
  是渲染器本地的，但它仍是导航里的一页）；映射为 个人=通用+外观｜集成=模型与服务商｜编码=权限+Agent；
  `settings-nav-spacer` 连节点带规则一起删（导航列改成 search + 可滚动 `settings-nav-list` + 常驻返回按钮）。
  ② **搜索框**：`SettingsState.query` + 导出的纯 `matchesQuery(query, ...haystack)`（trim + 小写 + 子串，
  空查询恒真）。匹配**只认屏幕上真有的文字**：分类标签，或该页任一卡片的 `title`/`note`/行 `label`/行 `detail`
  （不认 `warning`、选项标签、按钮 title——那些是派生的，会让「为什么这行命中」无法解释）。导航过滤掉不命中的页
  但**当前页永不掉出**，所以导航不可能空、无需空态；正文里**靠 title/note 命中的卡片保留全部行**（搜「MCP」
  要看到服务器列表，不是一张空卡），否则只留命中行；全不命中给 `searchEmpty` 一行。查询住 `SettingsState`
  而不是 `app.ts`：设置界面只由自己的 intent 重绘，model 可以是唯一权威。DOM 侧搜索框**在 `render()` 外建一次**
  （沿 5b 侧栏先例），只有 `settings-nav-list` 进 `replace()`；容器 keydown 对 `event.target===search` 早返回
  **但放 Escape 过**（否则焦点一进搜索框，按钮上写的「关闭设置（Esc）」就成了假话）；唯一一次回写是
  `view.query===''` 时清空输入框——`input` 是同步的，所以它只可能和「非打字来源清空了查询」对齐，打不起来。
  ③ **胶囊下拉**：`controls.ts` 新增 `pillSelect()`（触发器 + `role="listbox"`），`SettingsControl.kind==='select'`
  **不动**（`assertNeverControl` 与全部既有 model 断言因此原样保绿），开态是 `SettingsState.openMenu` 单键字段
  （一次只开一个），键在 DOM 里推成 `row:${row.id}`。intent 是 `toggle-menu` + **幂等**的 `close-menu`
  （比 5b 那个「只在开着时才发 toggle」的形状严格更好，顺手免掉视图里的镜像变量）。`cleared` 里加
  `openMenu: undefined`，于是「选完就关」免费且无法遗漏；四个 spread `state` 的分支显式补上。
  **只换设置行内的 select**：头部项目选择器与表单字段仍是原生 `<select>`（只穿了胶囊皮）——原生的键盘/读屏
  完整性是免费的，而表单是键盘流程。键盘自己实现了 Enter/Space（`button()` 免费）、Esc、Tab、
  ArrowDown/ArrowUp 循环、Home/End；焦点用 `event.target` 定位而**不读** `document.activeElement`。
  Esc 五层顺序（由内到外）：下拉 → 表单 → 删除确认 → 查询 → 关屏。CSS：菜单挂 `position: relative` 的
  `.settings-menu-shell`（**不挂 `.settings-row`**），因为 `.settings-body` 会滚动、一个轴非 visible 就连另一个
  一起裁；**零新 token、零新图标**（design doc 的 `#17171a`/`#34343b`/`9999px`/`4px 12px` 正好就是
  `--surface-canvas`/`--border-strong`/`--radius-pill`）。
  **前置一并做了**：`test/helpers/domStub.ts` 扩出 `dispatch(node,type,{target,relatedTarget,key})` /
  `focus` / `activeElement` / 元素 `contains()`，并**装了 `globalThis.Node`**——`focusout` 处理器里
  `next instanceof Node` 在没有该绑定时是 ReferenceError，这是 5b 起就无法 DOM 测的真正原因。
  新 `test/rendererSettingsView.test.ts`（19 条）是 `dom/` 的第二个单测。
  **验证**：新增 39 条（settings model 18 / settingsView DOM 19 / styleTokens 1 / 其余为既有用例扩写），
  全量 **2284 pass / 0 fail**（三条已知不稳定这次都绿），typecheck 四段全过，`build:desktop` emit 正常，
  七条变异验证全部报红在预期用例上（含一次**判据太宽被抓**，见下）。真机冒烟未跑（需显示器+凭据）。
- [ ] **新增 seam（跨层，谨慎）**：① `shellProtocol.ts`+`shellHost.ts`+`main.ts` 加 `open-in-editor`
  命令 `spawn('code', [cwd])`（补 `desktopShellHost` 用例）；~~② host 读 `<cwd>/.git/HEAD`~~ —— ② 已在 5c
  落地，走 `WireHelloResult.gitBranch`，见下方决策留痕。

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

- ~~**`paneSession.ts` 与整个 `dom/` 没有任何单元测试**~~ —— `dom/` 部分已在 5c 解决：
  `test/helpers/domStub.ts` + `tsconfig.domtest.json`（第四个 TS 程序），`test/rendererWelcomeView.test.ts`
  是范例。**`paneSession.ts` 仍无单元测试**，`renderTranscript()` 里那次 `welcome.render` 与
  `classList.toggle('empty')` 只有冒烟能看见。
- **系统提示语没有本地化**：真机上一次 turn 里出现的 `Effort set to: low` / `Switched to step-3.5-flash.`
  都还是英文，夹在全中文界面里。4e 的 `locale` 只加在三个 presentation 模块上，这些
  note 来自命令与运行时的 note 路径（TUI 也在用），是另一条通路。
  （`Worked for 3.6s` 已在 5d 修掉——它来自渲染器自己的 `formatTurnSummary`，现在是「已处理 Xm Xs」。）
- **效力选择器里的档位是英文原值**（`surfaces.ts` 的 `label: level`），而胶囊用的是 `EFFORT_LABELS` 的
  中文（`低/中/高/极高/最高`）。同一个概念在相邻两个控件里两种写法，选一种。
- **`sessions/index.json` 每个 turn 结束都被整目录扫一遍**：`SessionStore.list()` 的 `localeCompare`
  只是表层，真正贵的是它下面的 `readIndex → recoverIndex`——`readdir` 整个 sessions 目录，对不在 index 里的
  `.jsonl` 还要 `readFileSync` + 全量解析。4b 之后这条路每个 turn 走一次（每项目一次）。

---

### 5d 新记的账

- **`.pane { position: relative }` 没有任何用例**：删掉它全量仍然全绿（变异验证实测），而按钮会改锚到
  `#canvas` 并飘到输入框上。同 `.pane.empty` 那条，只能靠冒烟。
- **`rendererStyleTokens` 那条按钮守卫这次又被判据太宽咬了**：删掉 `.thinking-header { … }` 整块，全量仍然
  全绿——因为 `.thinking-header .icon` 与 `.item.thinking.live .thinking-header` 都满足它的 lookahead（拒绝
  紧跟伪类，不拒绝「作为后代出现」）。补法**没有**去改那条通用守卫（要区分「状态限定类」得给 parser 一个它
  没有的概念，5f 那条账仍然成立），而是新加一条 `the transcript controls carry a rule of their own`：点名
  `.thinking-header` / `.scroll-bottom`，要求存在**整条选择器就等于该类**的规则。加类要手动进那张单子。
- **`pruneThinkingToggles` 的调用点在 `paneSession.ts`，仍无单测**：函数本身有用例，「每次绘制都剪」这件事
  没有。同一文件里第三份只靠冒烟的视图状态（另两份是 `welcome.render` 与 `classList.toggle('empty')`）。
- **`--shadow-float` 在 `rendererStyleTokens` 的中性/彩色分类里是**未分类的**：分类循环 `if (!value.startsWith('#')) continue`
  会静默跳过它。将来若出现 `#` 值的 `--shadow-*`，那条用例会以一个很费解的理由报红。
- **`test/helpers/domStub.ts` 的**元素**成员没有漂移守卫**：源码扫描只覆盖 `document.<member>`。本次新增
  四个（`scrollTop`/`scrollHeight`/`clientHeight`/`scrollTo`）。
- **没有 `prefers-reduced-motion`**：任何 `@media` 都会让 `the stylesheet parses exactly` 报红（styles.css:97
  明文写着），而 `@keyframes` 能过。呼吸与 spinner 一样无条件跑。要做得先教那个 parser 认 at-rule。
- **去掉思维链的 240 尾截断之后，`transcriptView` 每 token 全量重建在长链上明显更贵**：加剧既有 3e 那条
  （建节点没有 LRU），不是新的一类问题。
- **靠底部的浮动按钮可能压在多行 `.tool-progress` 上**：按钮定位在 `.pane` 右下 12px，而工具进度行是
  `pre-wrap` 可换行的。明文接受（进度行是瞬态的，且文字左对齐）。
- **待跑的冒烟项**：向上滚动露出圆按钮、点它平滑回到底部、按钮不与工具进度行/输入框重叠且在圆角裁剪内、
  浅色模式阴影可见；真实 turn 结束后思考链自动折叠成真的「已处理 Xm Xs」（要 `--paid-turn`）；呼吸动画在跑
  且克制；折叠态按 pane 独立并活过一次 pane 切换；经真实 `@` 补全打出来的路径渲染成胶囊。

### 5f 新记的账

- **`rendererStyleTokens` 的「静息态规则」判据比它自称的宽**：4f 那条按钮守卫的
  `\.([A-Za-z][\w-]*)(?![\w-:])` 只拒绝紧跟**伪类**的类名，**不拒绝紧跟 `.` 的**，所以
  `.settings-pill.open` 单独存在就能骗过它——把 `.settings-pill { … }` 整块删掉，那条用例仍然全绿
  （实测）。5f 新加的 `the controls built inside controls.ts are styled too` 用的是更严的
  `(?![\w\-:.\[])`，但**只对它自己那四个类生效**；原来那条守卫的洞没补（补它要重跑一遍全部类名，
  可能连带报红既有类），独立一档。
- **`rendererStyleTokens` 的按钮扫描仍跳过 `controls.ts`**，所以 `.settings-pill` /
  `.settings-menu-item` / `.settings-toggle` 只靠 5f 那条显式清单覆盖；清单里加类名要手动。
- **靠正文滚动区底部的行，菜单会把滚动区撑长而不向上翻转**。翻转需要按次测量坐标，而样式测试只允许
  内联 `height`，body 级 portal 因此不是选项。明文接受。
- **胶囊菜单没有 typeahead**，原生 `<select>` 本来免费有。
- **点界面内不可聚焦的装饰（行标签、卡片标题）不会关菜单**（不触发 `focusout`）——这条承自 5b 的工作区菜单，
  两处同一个洞。要补得加 `document` 级 `mousedown`，为一个装饰性弹层加全局监听，没做。
- **`close-menu` 会在任何一次「焦点离开设置界面」时发出，哪怕没有菜单开着**：reducer 里返回同一个
  state 对象，但 `app.ts` 仍会整屏重绘一次。无害，未优化。
- **无 snapshot 时导航搜索只匹配页面标签**：四个宿主页的卡片还不存在。首个 `get-settings` 回来后的
  下一次渲染自动纠正，陈旧性上界 = 一次往返。
- **头部项目选择器与表单里带 `choices` 的字段仍是原生 `<select>`**，只是重新贴了胶囊样式。design doc
  五.3.③.2 说的是卡片行的右侧控件列，这次就只做到那里。
- **`.settings-nav-group-label` 是纯装饰的 `div`**，不是 `<h2>`/`role=group`；读屏上三段之间没有语义边界。

### 5c 新记的账

- **`.pane.empty` 这个类没有任何用例**。它由 `paneSession.ts` 的 `renderTranscript()` 设置，那个文件没有
  单元覆盖，而样式测试无从得知一个类有没有被应用上——把 `classList.toggle` 整行删掉，全量仍然全绿
  （变异验证实测）。要冒烟项，要么就一直是账。
- **分支胶囊会陈旧**：`gitBranch` 在 `hello` 时读一次，会话中途 `git switch` 到 pane 重建之前都不会更新。
  明文接受，逃生口见决策留痕。
- **待跑的冒烟项**：新 pane 上 Hero 在（含项目名/本地/分支三个胶囊）、点卡片只把焦点给输入框、点项目名
  弹出侧栏工作区菜单、发一条消息后 Hero 消失。本次没有显示器与凭据，**未跑**。

## 决策留痕（只留 `CLAUDE.md` 未覆盖的）

- **5d：thinking 按「最后一条 pending 的 thinking 项」分组，不按 `turn-start.messageId`**。不需要在 state 里
  带 turn 身份，`turn-end` 成为唯一的封口处，中途 `transcript-reset` 也不会让分组挂在一个已经不存在的 turn 上。
  id 来自 `thinkingCount` 计数器而**不是** `items.length`：丢草稿会让列表回缩，两条可能同号，一次 toggle 翻两条。
- **5d：一 turn 一项，代价是时间顺序交织**。今天 thinking 在每次 assistant 记录落地时被删，所以工具往返之后的
  第二段思考渲染在工具行**之后**；合并之后它回到 turn 顶部，落在引发它的工具行之上，工具密集的长 turn 里活文本
  也会长在滚动尾部之上。买到的是「一个 turn 只有一个耗时归属、一个一致的折叠标签」。逃生口：改回每块一项、
  摘要只挂最后一块。
- **5d：`pending` 不能兼职「折叠位」**。它驱动 `.item.pending::after` 的 `▌`，留着会画出多个光标，提前清掉又
  会让折叠头在 turn 中途没有耗时可显。默认折叠态是 `pending !== true`，而 pane 里那个 `Set` 记的是**「用户与
  默认不一致」**而不是「折叠着」——这才让 turn 中途的展开活过封存那一刻，且不需要第二个字段。
- **5d：toggle 集合每次绘制都按活着的 id 剪一次**。`transcript-reset` 把 `thinkingCount` 归零，而 `generation`
  只在被要求时才 bump，所以 id 复用会静默继承陈旧 toggle。与侧栏那条陈旧徽标同类。
- **5d：`正在思考` 与 `已处理 Xm Xs` 是同一个节点的两张脸，由 `item.pending` 驱动，绝不由 `state.isThinking`**。
  `thinking_stop` 会清 `isThinking` 而那一块还在流。**接受的后果**：不产出 thinking delta 的模型从 Enter 到第一个
  文字 token 之间**没有**任何「在忙」标签——它是思考阶段指示器，不是通用的在飞指示器（今天也是如此，合并没有
  让它更差）。
- **5d：折叠时思考正文从 DOM 里缺席，不是藏起来**。`.transcript` 是 `aria-live="polite"`，藏而不删的流式正文
  是没人要的朗读，也是 5c 避开的 Tab 停靠点。
- **5d：浮动按钮用 `hidden`，不丢子树**。`[hidden] { display:none !important }` 已经把它从布局、Tab 序、a11y
  树里摘掉，单个 `<button>` 也没有子树要重建；5c 丢子树是因为 Hero 有四个可聚焦控件。它挂 `paneEl` 而不是
  滚动容器内：`replace()` 每次绘制会清空滚动容器，而滚动容器里的绝对定位子节点锚的是**内容**底部。
- **5d：可见性在 `scroll` 与 `render()` 两处重算，共用一个 `isScrolledToBottom`**。只挂 `scroll` 会漏掉「内容
  变短」——`turn-end` 丢草稿、`transcript-reset` 都能让读者在没滚动的情况下变成「已在尾部」。共用一个判据是
  为了两处不会在那 24px 松弛的边界上互相矛盾。
- **5d：`@` 扫描器的两条正则提到 `runtime/suggestions/atToken.ts`，不在渲染器里抄一份**，但
  `harness/atMentions.ts` **保留自己的两遍顺序**（引号优先），只借正则。理由：`extractAtMentions` 按位置排序，
  而 harness 的顺序在附件上限处可观察且有用例钉着——统一顺序等于改 harness 行为，本阶段没那个必要。
  正则每次调用**新建**（都是 `/g`，共享实例会把 `lastIndex` 带给下一个调用者）。
- **5d：文件胶囊原地内联，正文逐字不变**。design doc 三.3① 说的是提到气泡开头，但这里的 mention 是句子的一部分
  （「把 @a.ts 搬到 @b.ts」），提走就等于改写用户原文并留下一个洞。胶囊标签去掉 `@` 与引号（图标已经说了那件事），
  但 segment 上保留源子串，于是「没有任何字符被丢弃或重排」是一条 fast-check 性质而不是注释里的说法。
- **5d：`formatWorkedDuration` 住 `model/transcript.ts`**，它唯一的消费者，且 `formatTurnSummary` 本来就在那儿。
  等 5e 的进度环要用到经过时间再提升为 `model/duration.ts`。不足一秒给一位小数：`已处理 0s` 读起来像坏了。

- **5f：`SettingsViewModel.nav` 换成 `navGroups`，不并存两份**。分组和搜索过滤都作用在同一份列表上，
  留两份视图迟早会分叉；两侧各只有一个消费者，换掉的成本是一处断言。
- **5f：`groupOf` 开在 `SettingsCategory` 而不是 `HostCategory`**。`cardsFor` 收窄成 `HostCategory` 是因为
  `appearance` 没有宿主数据，但它**有一页导航**，所以归组必须覆盖它——否则加第六个分类时，编译器只会拦住
  「没有卡片」，不会拦住「没有分组」。
- **5f：搜索只匹配屏幕上真有的文字**（分类标签 / 卡片 title、note / 行 label、detail），不匹配 `warning`、
  选项标签、按钮 title。派生文本命中会让用户无法解释「这行为什么在」。**明确不做跨页结果列表**：那需要给每张
  卡片挂「来自哪一页」、一个合成页和点击结果的导航语义；五个页面不值这个价，导航过滤已经回答了「在哪」。
- **5f：无 snapshot 时不给 `searchEmpty`**。「还没有加载」和「没有匹配」是两件不同的事，屏幕不能在原因是
  前者时宣称后者——与侧栏把 `noMatches` 与 `isEmpty` 分开是同一条规矩。
- **5f：搜索框的那一次回写是有条件的**（`view.query === '' && search.value !== ''`）。侧栏的规矩是「绝不回写」，
  这里收敛成「绝不**无条件**回写」：`input` 事件是同步的，所以 model 与输入框只可能在**非打字来源**
  （Esc、重开界面）清空查询时不一致，回写打不到正在打字的人身上。少了这一句，「Esc 清空查询」就是假的。
- **5f：容器 keydown 对搜索框早返回，但放 Escape 过**。侧栏那份是一刀切（`event.target===search` 全放行），
  但设置界面的 Esc 是它自己写在按钮上的承诺，且 `settingsKeyToIntent` 才是决定「Esc 清查询还是关屏」的地方。
- **5f：`openMenu` 是单键字段 + 幂等 `close-menu`，不是 5b 的单 toggle**。5b 那个形状只在「视图镜像了开态、
  且仅在开着时才发」的前提下正确；幂等的 close 把正确性从视图挪回 reducer，顺手删掉镜像变量。开态键在 **DOM**
  里推成 `row:${row.id}`，所以 `SettingsControl` 一个字段都没动，`assertNeverControl` 与全部既有断言原样保绿。
- **5f：菜单挂 `.settings-menu-shell`（`position: relative`），不挂 `.settings-row`**，也不做 body 级 portal。
  `.settings-body` 是 `overflow-y: auto`，一个轴非 `visible` 会连另一个轴一起裁，所以必须有定位祖先；给行本身
  加定位会让它成为后来任何东西的包含块。portal 要按次测量坐标，而 `rendererStyleTokens` 只允许内联 `height`。
  代价是靠底部的行把滚动区撑长而不向上翻转，接受。
- **5f：只把行内 `select` 换成胶囊，头部项目选择器与表单字段留原生**。原生 `<select>` 的键盘、typeahead、
  读屏行为是免费的；表单是 Tab 流程，把字段换成 button+menu 会把 Tab 引进展开的菜单里，而项目选择器一旦误触
  会重载整屏。这是对 design doc 的一次**故意的部分实现**，doc 五.3.③.2 说的本来就是卡片行的右侧控件列。
- **5f：`pillSelect` 用 `event.target` 定位焦点，不读 `document.activeElement`**。keydown 在被聚焦的项上触发
  并冒泡到外壳，target 就是位置；顺带避免给 domStub 再加一个 document 成员（不过注释里提到这个名字就已经
  被那条源码扫描守卫抓了一次——它连注释一起扫，所以 stub 还是补了 `activeElement`）。
- **5f：domStub 必须装 `globalThis.Node`**。`focusout` 处理器里 `next instanceof Node` 在没有该绑定时是
  **ReferenceError**，不是 false——这就是 5b 的工作区菜单一直没法 DOM 测的真正原因，不是「stub 缺 focus」。

- **5c：git 分支放 `WireHelloResult`，不放 `WirePaneInfo`/`WireLaneInfo`，也不开新命令**。`WirePaneInfo`
  至少两处投影且是跨项目的，每处都要一个它并不总持有的 `cwd`，而且 shell 每次拓扑变化会按 pane 各读一次；
  新开 shell 命令要 `ShellCommand` 变体 + zod + dispatch + `assertNever` + client 方法 + 用例，为一个只读
  装饰性胶囊。代价是陈旧性上界 = pane 寿命，而欢迎页只在 transcript 为空时存在。**逃生口**：将来真要活的
  分支，一次性提升为 shell 命令，schema 的活付一次。
- **5c：`hello` 现在会让出事件循环**（多了一次 `.git/HEAD` 读）。这不是纯内部细节：
  `test/protocolChildProcess.test.ts` 的「killing the host rejects the parent's in-flight commands」
  原本是**赛跑**——子进程的 `getCheckpointsWithDiffs` 立刻应答，谁先过 IPC 管道决定成败，`hello` 一让出
  就翻了面（实测 2/6 通过，HEAD 基线 6/6）。修法不是调 sleep，而是让子进程**真的**park 住那个命令
  （`__hang_checkpoints`），这样「命令在飞」是事实而不是时序巧合。凡是「杀掉宿主时正在飞的命令」这类断言，
  被测的那条命令必须是子进程答不出来的。
- **5c：欢迎页挂 pane 子树，不挂 index.html 单例**。「空」是*某个* transcript 的属性，而 transcript 是每
  pane 的；`paneEl` 已经按需要的生命周期做可见性切换。做成单例就要新 id、要在 `deactivate()` 里清绘制，
  并重新引入「上一个 pane 的绘制还留在屏上」那个坑。
- **5c：Hero 的项目名用回调而不是把工作区知识给 pane**。`runSidebarIntent` 需要 `currentSidebarState()`
  （遍历每个 pane 并读 composer）与 `state.lanes`，都是窗口级状态；把 `SidebarState` 或 `ShellClient`
  传进 pane 会反转「shell 才是拓扑权威」。`app.ts` 的 `openWorkspaceSwitcher()` 里那句
  `sidebar.focusWorkspace()` 不是装饰：菜单靠容器 `focusout` 关，焦点从未进过侧栏它就永不触发。

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
  判据太宽，别急着放过 bug。** 5f 第二次应验，而且是同一条守卫：它的 `(?![\w-:])` 拒绝伪类却不拒绝 `.`，
  于是 `.settings-pill.open` 一条就够骗过它；5f 还有一次是「大小写不敏感」的断言站在视图上，而那段被搜的
  文字恰好两种写法都能命中（`npx github-mcp` 里有小写 `mcp`），改成直接断言 `matchesQuery` 两个方向才抓住。
  5d 第三次应验，仍是那条守卫的**另一个**洞：它也不拒绝「作为后代出现」，所以只要留着 `.thinking-header .icon`，
  把 `.thinking-header { … }` 整块删掉仍然全绿——补法是新加一条点名清单用例（要求整条选择器就等于该类），
  而不是去改那条通用守卫（见「5d 新记的账」）。
  **凡是判据里有「某段文字命中」的，先确认那段文字不会用别的路径也命中。**
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
npm run typecheck                                     # 四段：base + preload + renderer + domtest
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

# 5c 新增（欢迎页 + DOM 地基 + 分支 seam）
node --import tsx --test test/rendererWelcome.test.ts test/rendererWelcomeView.test.ts \
  test/gitBranch.test.ts test/rendererImports.test.ts
npx tsc --noEmit -p tsconfig.domtest.json             # 第四段单独跑

# 5f 新增（设置分组 + 搜索 + 胶囊下拉）
node --import tsx --test test/rendererSettingsModel.test.ts test/rendererSettingsView.test.ts \
  test/rendererStyleTokens.test.ts test/rendererImports.test.ts

# 5d 新增（对话流：浮动按钮 + 思考链 + 文件胶囊）
node --import tsx --test test/rendererTranscriptView.test.ts test/rendererThinking.test.ts \
  test/rendererTranscriptModel.test.ts test/rendererUserMessage.test.ts test/atMentions.test.ts

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
**阶段 5 基线**：5b 后 2214 条；5c 后 2245 条；5f 后 2284 条；5d 后 **2323** 条，实测
**2323 pass / 0 fail**（三条已知不稳定这次都绿），typecheck **四段**全过。阶段 5 的新增用例应在此基线上累加。
**5f 待跑的冒烟项**：三段导航读作 个人/集成/编码 且只有五个真实页；输入「MCP」后 通用 仍在导航里且正文跳到
MCP 卡片；路由胶囊展开的菜单不被正文滚动区裁掉，选中 / Esc / 点别处都能关；Tab + 方向键能纯键盘操作展开的菜单。
**5d 待跑的冒烟项**：见上方「5d 新记的账」末尾那条。
