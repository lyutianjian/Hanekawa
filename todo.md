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

- [x] **5a — 双主题基础 + 外观设置页**：`styles.css` 加 `:root[data-theme="light"]` 覆盖块（中性守
  ≤20 饱和度；doc 未给的 `--accent-warn/-danger`、`--diff-*` 选定 amber-600/red-600 + GitHub 风格）；
  新 `model/theme.ts` 管 `localStorage['ui-theme']`（`system|dark|light`，默认 `system`，跟随系统在
  JS 里解析，CSS 不用 `@media`）；设置页加 `appearance` 分类（纯客户端，走新的
  `SettingsOutcome.themePreference` 通道，不发 wire）。
- [x] **5b — 侧栏改造**：工作区下拉（`SidebarWorkspace`+`workspacesOf`，选中走 `selectWorkspaceIntent`
  ——有 lane 则 switch、无则 newSession，复用现有意图零新 wire）；会话搜索框（持久节点不进
  `replace()` 区、`input` 事件驱动、真值住 `app.ts` 不回写，`noMatches` 与 `isEmpty` 分开）；
  `running` 徽标换 spinner 弧线图标；footer 齿轮改用户档案行样式；`workspaceMenuOpen` 靠容器
  `focusout` 关。
- [x] **5c — 空状态欢迎页**：`model/welcome.ts`（`isTranscriptEmpty` 按 `COUNTS_AS_CONVERSATION` 键表）
  + `dom/welcomeView.ts`（签名守卫，不可见时 `replace()` 丢子树）；Hero 项目名是
  `button.welcome-project`（不可切换时 disabled）、三张卡只 `composer.focus()`、胶囊只读且分支缺席
  整条不产出；挂 **pane 子树 `paneEl`**（每 pane 一份，非 index.html 单例）。**前置一并做了**：
  `test/helpers/domStub.ts` + `tsconfig.domtest.json`（第四个 TS 程序，`dom/` 第一次有单测）+
  git 分支 seam 走 `WireHelloResult.gitBranch` + 新 `src/runtime/gitBranch.ts`。
- [x] **5d — 对话流增强**：① 浮动回到底部按钮（挂 `paneEl`、`hidden` 不丢子树，可见性由同一个
  `isScrolledToBottom` 在 `scroll` 与 `render()` 两处重算；唯一新 token `--shadow-float`）；
  ② 思考链折叠头 + 呼吸标签（`TranscriptItem` 加 `summary`、id 来自 `thinkingCount` 计数器，
  `turn-end`/`applyRecord` 封存并挂「已处理 Xm Xs」、该 turn 不再追加 `duration` 项；折叠时 body
  节点不产出；新 `model/thinking.ts` + `formatWorkedDuration`）；③ 行内文件胶囊（`@` 两条正则提到
  `runtime/suggestions/atToken.ts`，`extractAtMentions` 带偏移按位置排序；`splitFileMentions` 原地
  切段，胶囊是 `span`）。
- [x] **5e — 输入框 + 画布头栏**：① 权限模式胶囊（`permissionPillView` 四模式，直接调
  `set-permission-mode`——模式是活的 gate 的状态，没有要持久化的东西；菜单开合住视图本地布尔，
  选中/Esc/`focusout` 三处收口 + `deactivate()` 调 `closeMenus()`）；② 发送按钮
  idle/ready/streaming 三态 + 进度环（**只改视觉**：生成中仍是「加入队列」，`■` 仍是旁边独立键，
  见决策留痕）；③ 画布头栏 `model/canvasHeader.ts` + `dom/canvasHeaderView.ts`（全由
  `WireLaneInfo` 推出，**不碰 `paneSession.ts`**；重命名输入框是持久节点、只在 idle→renaming
  回写一次；两步删除复用 app.ts 已有的 `deleteSession()`）；④ 状态栏删 `#status-mode` 与
  `#status-session`，`document.title` 仍留在 `statusView.renderSession`（它是冒烟的端到端证据）。
  顺带修掉 4f 那条账：效力选择器改用 `EFFORT_LABELS`。
- [x] **5f — 设置分组重构**（跳序做的）：① 导航分三组（个人=通用+外观｜集成=模型与服务商｜编码=权限+
  Agent），`SettingsViewModel.nav` 换成 `navGroups` 不并存两份，`settings-nav-spacer` 连节点带规则删除；
  ② 设置搜索（纯 `matchesQuery`：trim+小写+子串；匹配只认屏幕上真有的文字，当前页永不掉出导航，
  `searchEmpty` 与「无 snapshot」分开；查询住 `SettingsState`，搜索框在 `render()` 外建一次）；
  ③ `controls.ts` 新增 `pillSelect()`，行内 select 换胶囊下拉（`SettingsState.openMenu` 单键字段 +
  幂等 `close-menu`，Esc 由内到外五层，零新 token/零新图标；头部项目选择器与表单字段留原生
  `<select>`）。domStub 扩 `dispatch`/`focus`/`activeElement`/`contains()` 并装 `globalThis.Node`。

> 5a–5f 全部已过 focused + 全量（基线见「验证」）+ typecheck 四段 + 变异验证 + `build:desktop`；
> 实现细节见 git log 与下方决策留痕。**各阶段未跑的真机冒烟项**记在下方对应「新记的账」末尾。

- [x] **新增 seam（跨层，谨慎）**：① `open-in-editor` 已在 5e 落地——`shellProtocol.ts` 加命令（带
  `projectRoot`，host 解析成 `entry.cwd`）、`shellHost.ts` 加严格 schema + `onOpenInEditor` 回调
  （**被 await**，所以启动失败是 `fail` 而不是主进程里的原生框）、新 `src/desktop/openInEditor.ts`
  （不放 `main.ts`，那文件没有单测）+ `test/openInEditor.test.ts`；~~② host 读 `<cwd>/.git/HEAD`~~ ——
  ② 已在 5c 落地，走 `WireHelloResult.gitBranch`，见下方决策留痕。

**阶段 5 的待办到此清空。**

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
- ~~**效力选择器里的档位是英文原值**（`surfaces.ts` 的 `label: level`）~~ —— 5e 修掉：`effortPickerView`
  改用 `EFFORT_LABELS`，超上限那条的原因串也换成中文标签。命令行仍由原始档位拼（那是参数不是标签）。
- **`sessions/index.json` 每个 turn 结束都被整目录扫一遍**：`SessionStore.list()` 的 `localeCompare`
  只是表层，真正贵的是它下面的 `readIndex → recoverIndex`——`readdir` 整个 sessions 目录，对不在 index 里的
  `.jsonl` 还要 `readFileSync` + 全量解析。4b 之后这条路每个 turn 走一次（每项目一次）。

---

### 5e 新记的账

- **`deactivate()` 里那句 `composer.closeMenus()` 只有冒烟能看见**：`paneSession.ts` 仍无单测，
  `closeMenus()` 本身有用例（`rendererComposerView`），「切走 pane 时会调它」这件事没有。这是同一文件里
  第四份只靠冒烟的视图状态（另三份是 `welcome.render`、`classList.toggle('empty')`、`pruneThinkingToggles`）。
- **`app.ts` 的头栏状态同样没有单测**：`renderCanvasHeader` 的四个调用点（`onShellChanged` /
  `activateLane` / `removePaneSession` / `onLanes`）、以及「切 pane 时清掉进行中的重命名与待确认删除」
  都只在 `app.ts` 里，而 `app.ts` 是 wiring 层没有用例。model 与 view 两半都钉住了，接缝没有。
- **Windows 上「code 没装」是靠退出码判定的**：`cmd.exe` 本身永远能起来，所以 `spawn` 成功什么也不证明。
  `openInEditor` 因此等 `exit`，非 0 一律报「找不到 code 命令」——**任何**非 0 退出都会被说成没装。
  另有 5s 看门狗：前台不退出的启动器视为成功（否则渲染器的请求永远悬着）。
- **`test/helpers/domStub.ts` 的元素成员又多了三个**（`style.height`、`selectionStart`、
  `setSelectionRange`），仍然**没有漂移守卫**——源码扫描只覆盖 `document.<member>`（承自 5d 那条账）。
- **权限胶囊的菜单开合住在视图里，不在 reducer 里**：composer 是单例、没有 `SettingsState` 那样的状态机，
  所以 5f「正确性收回 reducer」那条在这里没有对应物。代价是「点界面内不可聚焦装饰不关菜单」的老洞第三次
  出现（5b 工作区菜单、5f 设置胶囊、5e 权限胶囊与头栏 `⋯`）。
- **头栏菜单往下开、权限胶囊菜单往上开**，两者都不做 body 级 portal，也都不按坐标翻转（同 5f 那条账）。
- **待跑的冒烟项**：胶囊四项菜单能改模式且状态栏……胶囊本身随之变；生成中发送键读「加入队列」、`■` 仍在
  旁边可点、进度环在转且克制；头栏 `⋯` 重命名后侧栏行同步改名（一次 `lanes` 广播）；两步删除；
  「打开位置」真的拉起 VS Code，未装时 transcript 里出现可读中文错误；设置界面打开时头栏跟着消失。
  本次没有显示器与凭据，**未跑**。（`probes.canvasHeader()` / `probes.clickHeaderMenu()` 已就位，
  S2 里加了一条「头栏与侧栏行同名」的断言。）

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

### 阶段 5

- **5e：发送按钮的三态是纯视觉，`■` 不与它合并**。design doc 四.2②.3 画的是生成中变 `■` 中止，但这个
  外壳把「中止」和「排队」当两个都想要的动作：合并之后中途排队就只剩 Enter 一条路，而 CLAUDE.md 明文要求
  `submitFromForm` 与 `keymap` 同判据。按钮在任何状态下都**不 disabled**（`requestSubmit()` 会静默吞掉
  disabled 按钮的点击），`idle` 只是「还没有可发的东西」。
- **5e：权限胶囊直连 `set-permission-mode`，不走斜杠命令**——与模型/效力两个胶囊相反，但理由一致：那两个
  要**持久化**（`/model`、`/effort` 才写 config），而权限模式就是活的 gate 的状态，设置页里的
  `permissions.mode` 只是**启动**模式。host 处理完会回推 runtime 快照，所以胶囊从和别人一样的路径重绘，
  不猜、不做乐观更新。`readonly` 有标签但不进菜单（内置 `explore`/`plan` 用它，用户不为一次会话挑它），
  快照带它时照样如实显示。
- **5e：画布头栏全部由 `WireLaneInfo` 推出，是窗口级视图**（`sessionTitle`/`projectRoot`/`projectName`
  都在上面，rename 会广播 `lanes`），所以 `paneSession.ts` 一行没加、也没有第二条取名字的路。
  重命名输入框是**持久节点**、只在 idle→renaming 回写一次（头栏会在流式期间每个快照 tick 重绘，
  重建就丢光标和半句话）；blur 也提交，但 `renameCommit` 把「没改」和「空」判成不发——`rename-session`
  要写 index 并广播给每条 lane。`pendingDelete` 存的是 **sessionId 不是布尔**，否则确认会跟着用户
  切到下一个会话。
- **5e：`document.title` 留在 `statusView.renderSession`，可见的会话名搬去头栏**。两者不是同一件事：
  窗口标题是冒烟从进程外读的端到端证据，只有写在 pane 的 `hello()` 之后才代表「整条链通了」；而头栏读
  lane 列表，比它早。
- **5e：`open-in-editor` 的回调被 `await`**（`onOpenProject` 是即发即忘）：编辑器最常见的失败就是没装，
  那必须变成渲染器能写进 transcript 的 `fail`。命令带 `projectRoot`（渲染器只有这个把手）而 host 交出去的
  是 `entry.cwd`——`root` 是规范化比较键，Windows 上被小写过，交给进程就是一个可能不存在的路径。
- **5d：thinking 按「最后一条 pending 的 thinking 项」分组、`turn-end` 是唯一封口处；id 来自
  `thinkingCount` 计数器而非 `items.length`**（丢草稿让列表回缩、两条同号、一次 toggle 翻两条）。一 turn
  一项的代价是时间顺序交织（工具往返后的第二段思考回到 turn 顶部）；逃生口：改回每块一项、摘要只挂
  最后一块。
- **5d：`pending` 不能兼职「折叠位」**（它驱动 `▌` 光标）。默认折叠态是 `pending !== true`，pane 里那个
  `Set` 记**「与默认不一致」**；且每次绘制按活着的 id 剪一次（`transcript-reset` 归零 `thinkingCount` 而
  `generation` 不 bump，id 复用会静默继承陈旧 toggle）。「正在思考 / 已处理 Xm Xs」是同一节点的两张脸，
  由 `item.pending` 驱动、**绝不由 `state.isThinking`**；不产 thinking delta 的模型从 Enter 到首个文字
  token 之间没有任何在忙标签（它是思考阶段指示器，非通用在飞指示器，接受）。
- **5d：折叠时思考正文从 DOM 缺席，不是藏起来**（`.transcript` 是 `aria-live="polite"`，也是 Tab 停靠点）。
  浮动按钮用 `hidden` 不丢子树、挂 `paneEl`（`replace()` 会清滚动容器，容器内绝对定位子节点锚的是
  **内容**底部）；可见性在 `scroll` 与 `render()` 两处共用 `isScrolledToBottom`（只挂 scroll 会漏
  「内容变短」——`turn-end` 丢草稿、`transcript-reset` 都能在没滚动的情况下变成「已在尾部」）。
- **5d：`@` 两条正则提到 `runtime/suggestions/atToken.ts`，渲染器不抄一份；harness 保留自己的两遍顺序**
  （引号优先是可观察行为，有用例钉着）；正则每次**新建**（`/g` 共享实例会把 `lastIndex` 带给下一个调用者）。
  文件胶囊原地内联、正文逐字不变（fast-check 性质），标签去 `@` 与引号但 segment 保留源子串。
  `formatWorkedDuration` 住 `model/transcript.ts`，等 5e 进度环要用再提升。
- **5f：`nav` 换 `navGroups` 不并存两份**（分组和搜索都作用在同一份列表上，两份迟早分叉）；`groupOf` 开在
  全部五个 `SettingsCategory` 上而非 `HostCategory`（`appearance` 没有宿主卡片**但有导航页**，编译器要能
  拦住「没有分组」）。搜索只认屏幕上真有的文字（分类标签、卡片 title/note、行 label/detail），不匹配
  `warning`/选项标签/按钮 title；无 snapshot 不给 `searchEmpty`（「还没加载」≠「没有匹配」）；明确不做
  跨页结果列表。
- **5f：`openMenu` 单键字段 + 幂等 `close-menu`**（比 5b「仅在开着时才发 toggle」严格更好，正确性收回
  reducer），键在 DOM 里推成 `row:${row.id}`；菜单挂 `position:relative` 的 `.settings-menu-shell` 而非
  `.settings-row`（一个轴非 `visible` 会连另一轴一起裁），不做 body 级 portal。只换行内 select：头部项目
  选择器与表单字段留原生（键盘/typeahead/读屏免费，表单是 Tab 流程，项目选择器误触会重载整屏）——
  对 design doc 五.3.③.2 的**故意部分实现**。`pillSelect` 用 `event.target` 定位焦点，不读
  `document.activeElement`。搜索框唯一一次回写是 `view.query===''` 时清空输入框（只对齐「非打字来源清空」，
  打不起来）；容器 keydown 对搜索框早返回**但放 Escape 过**。domStub 必须装 `globalThis.Node`——
  `instanceof Node` 无绑定时是 **ReferenceError 不是 false**。
- **5c：git 分支放 `WireHelloResult`**，不放 `WirePaneInfo`/`WireLaneInfo`、也不开新命令（`PaneInfo` 两处投影
  且跨项目，新开命令的 schema 活太贵；代价是陈旧性上界 = pane 寿命；逃生口：一次性提升为 shell 命令）。
  `hello` 因此让出事件循环：「杀掉宿主时在飞的命令」类断言必须让子进程**真的** park 住
  （`__hang_checkpoints`），不能靠时序赛跑。欢迎页挂 pane 子树不挂单例（「空」是每个 transcript 的属性）；
  Hero 项目名用回调拿窗口级状态（不把工作区知识给 pane）；`openWorkspaceSwitcher()` 里
  `sidebar.focusWorkspace()` 不是装饰——菜单靠容器 `focusout` 关，焦点从未进过侧栏它就永不触发。

### 阶段 4 及更早

- **4b：侧栏的两个键入口必须分开**——全局 chord 在 `resolveKey` **之前**解析、不带 ctrl/meta 恒返回
  `'none'`；侧栏聚焦的挂容器，方向键/Enter 才不会从 composer 抢键。分组 `own` 语义变了：侧栏里只决定组
  序，`undefined` 解释成「都不是」（都置顶等于都不置顶），只有跨项目切换才重排。
- **4b：徽标不新增 wire 字段**（`isStreaming` + `hasOverlay` 够，代价是 `onShellChanged` 给每个 pane 重绘）；
  盘上拉取只挂四个时机（启动 / `lanes` / `isStreaming` 下降沿 / 删除后），**绝不挂 snapshot tick**。驱逐
  宁超额也不杀正在跑的（`selectEvictions` 剩下全 pinned 时返回**不足数**）；`removeShadowRepo` 必须收
  `store.resolve()` 之后的 id（线上字符串直通 `rm(recursive)`，`''`/`'..'`/带分隔符都会解析到
  shadow-git 本身）。
- **4a**：`ShellHost` 泛型默认值用结构切片 `ShellLaneWorkspace<PaneT>`，main.ts 显式写全三元组；
  close-pane 是自毁命令、reply 天然丢失（pending 由 `failAllPending` 吸收）；渲染器初始化一律拉取
  （Electron 丢弃 preload 注册前投递的 IPC）；`deactivate()` 清绘制不清状态；darwin 最后一个 lane 关掉
  保留空窗口（非 darwin 照旧 quit）；main.ts 的 lane↔pane 簿记按 `paneId` 线性扫（键必须不随 `/clear`、
  `/resume` 移动，闭包到自己会关错窗口）。
- **其余**：`ToolRegistry.refresh()` 把 Agent 工具移到数组末尾（工具顺序是 prompt 缓存键的一部分）；
  `createRuntime` 的 `onActiveSessionChange` 放在所有会抛的校验之后；`fallbackModel`/`compactModel`
  校验原始配置串（拼错 ≠ 没配置，否则被静默忽略）；App.tsx 先定义后 `useCommands`（TDZ）；3j 四决策——
  项目最后一个窗口关掉即 `shutdown`、入口「Open project…」+ `Ctrl+Shift+O` 不做原生 File 菜单、别的项目
  的标签只能聚焦、跨项目一律走 shell 旁挂命令。

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

# 5e 新增（权限胶囊 + 三态发送 + 画布头栏 + open-in-editor）
node --import tsx --test test/rendererComposerChip.test.ts test/rendererComposerView.test.ts   test/rendererCanvasHeader.test.ts test/rendererCanvasHeaderView.test.ts   test/rendererStyleTokens.test.ts test/rendererImports.test.ts
node --import tsx --test test/desktopShellHost.test.ts test/openInEditor.test.ts

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
**阶段 5 基线**：5b 后 2214 条；5c 后 2245 条；5f 后 2284 条；5d 后 2323 条；5e 后 **2362** 条，实测
**2362 pass / 0 fail**（三条已知不稳定这次都绿），typecheck **四段**全过，`build:desktop` 通过。
阶段 5 之后的新增用例应在此基线上累加。
**5f 待跑的冒烟项**：三段导航读作 个人/集成/编码 且只有五个真实页；输入「MCP」后 通用 仍在导航里且正文跳到
MCP 卡片；路由胶囊展开的菜单不被正文滚动区裁掉，选中 / Esc / 点别处都能关；Tab + 方向键能纯键盘操作展开的菜单。
**5d 待跑的冒烟项**：见上方「5d 新记的账」末尾那条。
**5e 待跑的冒烟项**：见上方「5e 新记的账」末尾那条。
