# Hanekawa 桌面端适配 — 进度与待办

> 交接文档。**架构与不变式在 `CLAUDE.md`**，本文件只讲进度、决策留痕和没做完的事。
> 状态：`[x]` 完成并验证 · `[~]` 部分完成 · `[ ]` 未开始
> 已完成阶段（0–5）的记录已压缩为概要，完整过程与理由见 git 历史。

---

## 目标

**阶段 0–3j（已完成，归档）**：agent 内核抽成 headless 运行时搬进 Electron，跑通协议层命令、多标签、
多项目、markdown、rewind、消息队列与费用。时间线见 git log（`34fbea0` 之前）。

**阶段 4（已完成，归档）**：外壳从开发者原型做成产品形态——单窗口 + lane 多路复用、侧栏全量会话
历史、删除会话、设置界面、`design_guidance.md` 首轮视觉、真机冒烟（CDP 驱动纳入 git）。遗留缺陷见
下方「已知缺陷」。

**阶段 5（已完成，冒烟待跑）**：按重写后的 `design_guidance.md` 落地其中**能映射到现有能力**的部分 +
双主题；无对应后端的设计项（拉取请求、插件生态、语音、电脑操控、浏览器、Git、Worktrees、钩子界面、
通知铃铛、分栏/检查器等）**一律省略**。要点：双主题 + 「外观」设置页（默认跟随系统）；画布头栏 =
会话身份 + 「打开位置」（固定 `code <cwd>`，未装回可读错误）；侧栏头部 = 工作区下拉 + 会话搜索框；
思考链流式展开、turn 结束折叠；权限胶囊露 default / acceptEdits / plan / bypass，复用现有
`set-permission-mode`。子项概要见下。

---

## 阶段 5（已完成）

> 5a–5f 均已过 focused + 全量（基线见「验证」）+ typecheck 四段 + 变异验证 + `build:desktop`。
> **未跑的真机冒烟项**合并记在下方「阶段 5 新记的账」末尾。

- **5a** 双主题基础 + 「外观」设置页：`model/theme.ts` 管 `localStorage['ui-theme']`（默认
  `system`，跟随系统在 JS 里解析）；设置页新增纯客户端 `appearance` 分类
  （`SettingsOutcome.themePreference`，不发 wire）。
- **5b** 侧栏改造：工作区下拉（复用 `selectWorkspaceIntent`，零新 wire）、会话搜索框、`running`
  徽标换 spinner、footer 改用户档案行、菜单靠容器 `focusout` 关。
- **5c** 空状态欢迎页（`model/welcome.ts` + `dom/welcomeView.ts`，挂 `paneEl` 每 pane 一份）；前置
  立了 `test/helpers/domStub.ts` + `tsconfig.domtest.json`（第四个 TS 程序，`dom/` 首次有单测）；
  分支 seam 走 `WireHelloResult.gitBranch`（新 `src/runtime/gitBranch.ts`）。
- **5d** 对话流增强：浮动回到底部按钮、思考链折叠头 + 呼吸标签（`turn-end` 封存「已处理 Xm Xs」）、
  行内 `@` 文件胶囊（正则住 `runtime/suggestions/atToken.ts`）。
- **5e** 输入框 + 画布头栏：权限模式胶囊（直连 `set-permission-mode`）、发送键三态 + 进度环（纯
  视觉）、`model/canvasHeader.ts` + `dom/canvasHeaderView.ts`（全由 `WireLaneInfo` 推出，不碰
  `paneSession.ts`）；新 seam `open-in-editor`（`shellProtocol.ts` 命令 + `shellHost.ts` 严格
  schema + 新 `src/desktop/openInEditor.ts`）。顺带修 4f 效力档位英文账（`EFFORT_LABELS`）。
- **5f** 设置分组重构：三组导航（`nav` 换 `navGroups`）、设置搜索（`matchesQuery`）、`controls.ts`
  新 `pillSelect()` 胶囊下拉；domStub 扩 `dispatch`/`focus`/`activeElement`/`contains()` 并装
  `globalThis.Node`。

---

## 阶段 6（已完成，冒烟待跑）：按参考图重打磨 + `design_guidance.md` 重构

**起因**：真机截图与参考图逐块对比，差距集中在窗口外框、侧栏信息密度、画布顶部状态条、正文行长、
输入框五处；同时 `design_guidance.md` 仍把没有后端的设计项写成规范、浅色 token 与实现不符。
**做法**：先把文档重构成「与实现一致 + 可执行 + 标注哪条测试守哪句」，再按它落地。

- [x] **文档重构**：`design_guidance.md` 整篇重写——「不实现」表、以实现为准的 token 表、五节结构
  规范、**有意偏离参考图**一览、G1–G10 改进清单、防退化清单（每条括注守它的测试名）。
- [x] **6e 设置**：开关 ON 改 accent 填充 + 新中性 token `--surface-knob`（白滑块，两主题同值）；
  `rendererStyleTokens` 的 accent-fill 守卫加**具名例外** `ACCENT_FILL_EXCEPTIONS`（带非空断言，
  例外失配也报红）；分组卡片补发丝边框 + `--radius-lg`；H1 15→20px。
- [x] **6c 画布与对话流**：`#status` 从画布顶部搬到输入框下沿、空闲渲染空串（不再常驻「空闲」）；
  新 `.transcript-column` / `.composer-column` 居中阅读列（~760px，滚动条仍在面板边缘）；轮次间距
  10→16px、`line-height: 1.65`、正文 13→14px；用户气泡 `10px 14px` + `--radius-lg`；细滚动条
  （`scrollbar-width` + `::-webkit-scrollbar*`，都是普通选择器块，平解析器仍成立）。
- [x] **6d 输入框**：占位符改「随心输入」（长句说明进 `?` 浮层）；随列宽居中；`padding` 加大；
  发送/停止键 28→30px。
- [x] **6b 侧栏**：头部只剩工作区 + 折叠（项目名不再被截断）；「新建会话 / 打开项目…」改成搜索框下方
  的 `.sidebar-nav-item` 行；footer 改「设置行 + `?`」，`SIDEBAR_HINT` 进 `?` 浮层（新 `helpOpen`
  进 state/view/**签名**与新 intent `toggle-help`）；会话行 `min-height: 32px`、13px；侧栏 268px。
- [x] **6a 无边框标题栏**：`main.ts` 加 `backgroundColor` + `titleBarStyle: 'hidden'` +
  `titleBarOverlay`（Windows 三键仍由系统画，**零窗口控制 IPC**）、非 darwin 清空应用菜单；新
  `model/titleBar.ts` + `dom/titleBarView.ts` 画 `◧` + 文件/视图/帮助，**每项只映射既有 intent**、
  不做「编辑」菜单；新 shell 命令 `set-window-theme`（严格 schema + `assertNever` 分支 +
  `onWindowTheme`，**无 overlay 的外壳答 `ok` 不 reject**）由 `applyResolvedTheme` 触发。
- [x] **新增用例**：`test/rendererSidebarView.test.ts`（5 条）、`test/rendererTitleBarView.test.ts`
  （7 条）、transcript 阅读列 1 条、`desktopShellHost` 的 `set-window-theme` 2 条；三份 domtest
  文件同时进 `tsconfig.json` 的 exclude 与 `tsconfig.domtest.json` 的 include（`rendererImports`
  守着这两张单子一致）。

- [x] **6f 白屏修复 + 启动守卫**（阶段 6 落地后发现）：6a 往 `applyResolvedTheme` 里加的
  `shellClient.setWindowTheme(...)`，其唯一调用点在**模块顶层**且排在 `const shellClient` **之前** ——
  TDZ 抛错、`app.ts` 顶层中断，全部单例视图与引导 IIFE 都没执行，窗口只剩 `index.html` 骨架
  （主题 token 已生效，因为 `dataset.theme` 那行在抛错之前）。修法：`mux` / `shellClient` 整体提到主题块
  之前（不包 `try`、不 `queueMicrotask` —— 那只是把崩溃换成静默不生效）；引导里 `panes()` 往返之后再
  幂等发一次 `setWindowTheme`（早发若被丢，浅色用户的三键区会一直是深色）。新
  `test/rendererBoot.test.ts`：把真 esbuild bundle 装进 domStub + 假 bridge（只答 `panes`）里跑起来，
  断言 `#titlebar` / `#sidebar` 非空、`<body>` 没有失败文案、`dataset.theme` 已解析。

### 阶段 6 新记的账

- **`WINDOW_CHROME`（`main.ts`）是 `styles.css` 之外唯一写死颜色的地方**，且**没有守卫**：它是
  OS 画的 overlay，文档够不着，只能与 `--surface-base` / `--text-secondary` 手工对齐。样式测试扫的是
  渲染器目录，看不见 `main.ts`。
- **`#titlebar` 右侧 148px 是硬编码的留白**：Windows 的三键宽度不是常量（缩放、语言、Win10/11 略有
  差异）。写窄了按钮会压在菜单上，写宽了右边多一块空。只有真机能看出来。
- **标题栏菜单第四次踩同一个洞**：点栏内不可聚焦装饰不会关菜单（承 5b / 5e / 5f），仍靠容器
  `focusout`，仍不做 body 级 portal，也不按坐标翻转。
- **`renderTitleBar()` 就是 `renderSidebar()`**：两者的活字段同源（collapsed / canCreate），所以合成
  一个调用点，代价是开一次菜单会连侧栏一起走一遍签名比较。
- **`app.ts` 的标题栏接线仍无单测**（承 5e 那条）：`runTitleBarAction` 的五个分支、`titleBarMenu` 的
  持有都在 wiring 层，model 与 view 两半都钉住了。**6f 之后 `app.ts` 不再是零覆盖**：
  `rendererBoot.test.ts` 守着「模块能求值完 + 首帧非空 + 启动发出 `panes` 与 `set-window-theme`」，
  但**只有这四条**——分支逻辑仍然只有冒烟看得见。
- **6f 第 2 步（引导里补发 `setWindowTheme`）没有守卫**：删掉它 `rendererBoot` 仍全绿，因为模块求值期
  那次已经满足了「发过 `set-window-theme`」。它防的是「早发被丢」这个未被证实的情形，纯防御。要钉住
  得让假 host 只在往返之后才接受命令，判据比它防的问题还长，明文接受。
- **domStub 的 `dataset` 也进了「无守卫的元素成员」清单**（6f 加）：`sidebarView` / `rewindView` /
  `surfaceView` 早就在写它，只是既有用例碰巧没走到那几行 —— 这类漂移仍然只有跑到才知道。
- **`darwin` 上没有这套外框**：`titleBarOverlay` 不设、应用菜单不清，`set-window-theme` 直接返回。
  没有 mac 机器验证过。
- **待跑的冒烟项**：**启动后侧栏 / 标题栏 / 输入框有内容、DevTools 控制台无报错**（6f 白屏的真机复现
  路径；`rendererBoot` 只能证明 bundle 在假 DOM 里活着，真 Chromium 与真 host 是另一回事）；
  无边框标题栏能拖动、三键可用、文件/视图/帮助能开且各项落到既有行为；侧栏头部项目名
  完整、`?` 浮层能开合、`新建会话 / 打开项目…` 成行；画布顶部无「空闲」条、状态在输入框下沿且空闲为空；
  正文成居中列、滚动条为细条；输入框占位符是「随心输入」；设置里开关 ON 为蓝底白滑块；深浅主题切换时
  三键区域跟着换色。本次没有显示器与凭据，**未跑**。
  （`probes.titleBar()` / `probes.clickTitleBarMenu()` 已就位；拖拽区与 OS 画的三键**读不到**——overlay 在
  文档之外，只有截图能作证。）

---

## 待办（记账未修）

下面是记账未修的缺陷，每条都是独立的一档。

### 已知缺陷（记账未修）

- **3e 遗留两条**：① **代码块没有语法高亮** —— `cli-highlight` 出 ANSI 且是 Node 侧的，浏览器侧要
  另选能进 renderer bundle（无 Node 依赖）的库，独立一档；② `markdownNode` 每次重建整棵子树、
  `transcriptView` 每 token 全量重画 —— 解析有 LRU 兜着，**建节点没有**（5d 去掉思考链 240 尾截断
  后长链上更贵）。真机上长会话流式若卡，按 `transcriptView` 文件头写的那条路走（按 item id 建 key
  增量更新），不要回头去搞 static/live 分区。
- **系统提示语没有本地化**（4f）：`Effort set to: low` / `Switched to step-3.5-flash.` 等仍是英文，
  夹在全中文界面里。4e 的 `locale` 只加在三个 presentation 模块上，这些 note 来自命令与运行时的
  note 路径（TUI 也在用），是另一条通路。
- **`sessions/index.json` 每个 turn 结束都被整目录扫一遍**（4f）：`SessionStore.list()` 用
  `localeCompare` 排 ISO 串（比 `<` 慢约两个数量级）只是表层，真正贵的是它下面的
  `readIndex → recoverIndex`——`readdir` 整个 sessions 目录，对不在 index 里的 `.jsonl` 还要
  `readFileSync` + 全量解析。4b 之后每项目每 turn 走一次。
- **其余 `"latest"` 依赖**（`tsx`、`zod`、`openai` 等）未钉版本；不参与 emit，要清理另开一条。
- **`PaneSession` 有四个成员已无人调用**：`panes` / `refreshPanes`（4a 死）、`ownProjectRoot` /
  `isActive`（4b 死）。无害，留给任何一次单独提交。
- **`StartupPermissionMode` 的类型比校验宽**：类型上允许 `'readonly'`，`validateSettings` 只认
  default / acceptEdits / bypass——写 `readonly` 的设置文件根本加载不了；4d-2 的 `startupMode()`
  只在投影处兜到 `'default'`，源头那对不齐没修。
- **自定义 agent 定义不能写 `permissionMode: readonly`**：`parseOptionalPermissionMode` 不认，而内置
  的 `explore` / `plan` 用的正是它；文件被跳过并只打一行 warning。
- **`settings.autoCompact` / `autoCompactThreshold` 无人消费**：要么接上真正的自动压缩，要么连
  `configTool` 里的两条一起删——独立一档。
- **`Ctrl+W` / 侧栏关闭不检查 `blocked`**（LRU 驱逐绝不碰有未答阻塞请求的 pane）；用户明确要求的
  关闭是另一情境，要做得更好得加确认，是新范围。
- **`sidebarRenderSignature` 是字符串比较**，行数极多时 O(rows) 建串；够用，真要更进一步是按
  item id 做增量行更新（与 `transcriptView` 那条同一条路）。
- **MCP 服务器不能在界面上增删改**（`McpServerConfig` 没有写入 API）、`hooks` 没有界面、
  `fallbackModel` / `compactModel` 只读（`ConfigService` 没有对应 setter）。
- 已修（勿再记账）：shadow-git 删会话泄漏（4b `removeShadowRepo`）、`runSidebarIntent` 穷尽检查
  （4d `assertNeverIntent`）、`settings.local.json` 写整组与 untrust（4d-2 `updateLocalSettings`）、
  MCP 只在 bootstrap 连一次（4d-2 `reloadMcpServers`）、权限徽标 / 设置 Esc / `.sidebar-settings`
  样式（4f）、`Worked for 3.6s` 本地化（5d `formatTurnSummary`）、效力档位英文标签（5e
  `EFFORT_LABELS`）、`dom/` 无单测（5c domStub）。

---

### 阶段 5 新记的账（5c–5f 合并）

- **`paneSession.ts` 仍无单元测试**（`dom/` 已在 5c 由 domStub 解决）：`welcome.render`、
  `classList.toggle('empty')`、`pruneThinkingToggles`、`deactivate()` 里的 `composer.closeMenus()`
  四份视图状态只有冒烟能看见。
- **`app.ts` 是 wiring 层、没有用例**：`renderCanvasHeader` 的四个调用点（`onShellChanged` /
  `activateLane` / `removePaneSession` / `onLanes`）与「切 pane 时清掉进行中的重命名与待确认删除」
  都只在这里；model 与 view 两半都钉住了，接缝没有。
- **`test/helpers/domStub.ts` 的元素成员没有漂移守卫**（源码扫描只覆盖 `document.<member>`）：已累计
  `scrollTop`/`scrollHeight`/`clientHeight`/`scrollTo`/`style.height`/`selectionStart`/
  `setSelectionRange`/`dispatch`/`focus`/`activeElement`/`contains()`，再长也没有守卫。
- **弹层菜单同一个洞（5b 工作区菜单起，5e/5f 连踩）**：点界面内**不可聚焦的装饰**不触发
  `focusout`、菜单不关；菜单都不做 body 级 portal、也不按坐标翻转（贴滚动区底部的行会把滚动区撑长，
  明文接受）；权限胶囊的菜单开合住在视图里不在 reducer（composer 单例、没有 `SettingsState` 那样的
  状态机）。
- **`rendererStyleTokens` 的静息态守卫判据偏宽**（只拒紧跟伪类，不拒 `.` 后缀、也不拒「作为后代
  出现」，4f/5f/5d 三次应验）：通用守卫的洞至今未补（补它要重跑全部类名、可能连带报红既有类，独立
  一档），靠点名清单兜——`.thinking-header` / `.scroll-bottom` 要求存在**整条选择器就等于该类**的
  规则，`controls.ts` 自建控件另有显式清单；按钮扫描本身仍跳过 `controls.ts`，加类要手动进对应清单。
- **没有 `prefers-reduced-motion`**：任何 `@media` 都会让「样式表可平解析」那条报红（styles.css 明文
  写着），`@keyframes` 能过，呼吸与 spinner 无条件跑；要做得先教那个 parser 认 at-rule。
- **Windows 上「code 没装」靠退出码判定**：`cmd.exe` 永远能起来，`spawn` 成功什么也不证明，
  `openInEditor` 等 `exit`、**任何**非 0 退出都被说成没装；另有 5s 看门狗，前台不退出的启动器视为
  成功（否则渲染器请求永远悬着）。
- **`.pane { position: relative }` 与 `.pane.empty` 没有任何用例**：删掉全量仍绿（变异验证实测，按钮
  会改锚到 `#canvas` 飘到输入框上），只能靠冒烟。
- **细碎接受项**：浮动回底按钮可能压多行 `.tool-progress`（瞬态）；分支胶囊会陈旧到 pane 重建
  （`gitBranch` 只在 `hello` 读一次，逃生口见决策留痕）；`close-menu` 没有菜单开着也空发一次整屏重绘
  （无害）；胶囊菜单没有 typeahead；无 snapshot 时导航搜索只匹配页面标签（一次往返后自愈）；头部项目
  选择器与带 `choices` 的表单字段留原生 `<select>`（对 design doc 的故意部分实现）；
  `.settings-nav-group-label` 是纯装饰 div、读屏无语义边界；`--shadow-float` 在 token 中性/彩色分类里
  未分类（非 `#` 值被静默跳过）。
- **待跑的冒烟项**（无显示器与凭据，**未跑**；`probes.canvasHeader()` / `probes.clickHeaderMenu()` /
  `probes.titleBar()` / `probes.clickTitleBarMenu()` 已就位，S2 里有「头栏与侧栏行同名」断言）：
  - 5c：新 pane 上 Hero 在（项目名/本地/分支三胶囊）、点卡片只聚焦输入框、点项目名弹工作区菜单、
    发一条消息后 Hero 消失。
  - 5d：向上滚动露出圆按钮、点它平滑回底、不与工具进度行/输入框重叠且在圆角裁剪内；浅色模式阴影
    可见；真实 turn 结束后思考链折叠成「已处理 Xm Xs」（要 `--paid-turn`）、呼吸动画在跑且克制；
    折叠态按 pane 独立并活过一次 pane 切换；经真实 `@` 补全的路径渲染成胶囊。
  - 5e：权限胶囊四项菜单能改模式且胶囊本身随之变；生成中发送键读「加入队列」、`■` 仍在旁边可点、
    进度环在转且克制；头栏 `⋯` 重命名后侧栏行同步改名（一次 `lanes` 广播）；两步删除；「打开位置」
    真的拉起 VS Code、未装时 transcript 里出现可读中文错误；设置界面打开时头栏跟着消失。
  - 5f：三段导航读作 个人/集成/编码 且只有五个真实页；输入「MCP」后「通用」仍在导航里且正文跳到
    MCP 卡片；胶囊展开的菜单不被正文滚动区裁掉，选中 / Esc / 点别处都能关；Tab + 方向键能纯键盘
    操作展开的菜单。

## 决策留痕（只留 `CLAUDE.md` 未覆盖的；完整理由见 git 历史）

### 阶段 5（要点）

> 已入 CLAUDE.md 不重复的三条：画布头栏全部由 `WireLaneInfo` 推出（rename 广播 `lanes`）；
> `document.title` 留在 `statusView.renderSession`；`open-in-editor` 被 `await`、host 交 `entry.cwd`
> 不交规范化比较键。

- **5e**：发送键三态纯视觉、`■` 不与它合并、任何状态都不 disabled（`requestSubmit()` 会静默吞掉
  disabled 的点击）；权限胶囊直连 `set-permission-mode` 不走斜杠（权限模式是活 gate 的状态、无需
  持久化）、不做乐观更新、`readonly` 有标签不进菜单；头栏重命名输入框是持久节点、只在 idle→
  renaming 回写一次（流式期间每 tick 重绘会丢光标），blur 也提交但「没改」和「空」都不发；
  `pendingDelete` 存 sessionId 不是布尔（否则确认跟着用户切到下一个会话）。
- **5d**：thinking 按「最后一条 pending 的 thinking 项」分组、`turn-end` 是唯一封口处；id 来自
  `thinkingCount` 计数器而非 `items.length`；默认折叠态 = `pending !== true`（`pending` 驱动 `▌`
  光标、不能兼职折叠位），pane 的 `Set` 只记「与默认不一致」且每次绘制按活着的 id 剪一次；「正在
  思考 / 已处理 Xm Xs」是同一节点的两张脸，只由 `item.pending` 驱动、绝不由 `state.isThinking`；
  折叠时正文从 DOM **缺席**而非藏起来（`aria-live` 与 Tab 停靠点）；浮动按钮 `hidden` 不丢子树、挂
  `paneEl`，可见性在 `scroll` 与 `render()` 两处重算；`@` 正则住
  `runtime/suggestions/atToken.ts`、渲染器不抄一份、每次**新建**（`/g` 共享实例会带 `lastIndex`），
  胶囊原地内联、正文逐字不变。
- **5f**：`nav` 换 `navGroups` 不并存两份；`groupOf` 开在全部五个 `SettingsCategory` 上
  （`appearance` 没有宿主卡片但有导航页）；搜索只认屏幕上真有的文字、无 snapshot 不给
  `searchEmpty`、明确不做跨页结果列表；`openMenu` 单键字段 + 幂等 `close-menu`（正确性收回
  reducer）；菜单挂 `position:relative` 的 `.settings-menu-shell`，不做 body 级 portal；只换行内
  select，头部项目选择器与表单字段留原生；`pillSelect` 用 `event.target` 定位焦点；搜索框唯一一次
  回写是 `view.query===''` 时清空；容器 keydown 对搜索框早返回但放 Escape 过。
- **5c**：git 分支放 `WireHelloResult`、不放 `WirePaneInfo`/`WireLaneInfo`、也不开新命令（陈旧性上界
  = pane 寿命，逃生口：一次性提升为 shell 命令）；**测试不变式**：`hello` 让出事件循环——「杀掉宿主
  时在飞的命令」类断言必须让子进程**真的** park 住（`__hang_checkpoints`），不能靠时序赛跑；欢迎页
  挂 pane 子树不挂单例（「空」是每个 transcript 的属性）；Hero 项目名用回调拿窗口级状态；
  `openWorkspaceSwitcher()` 里 `sidebar.focusWorkspace()` 不是装饰。

### 阶段 4 及更早（要点）

- **4b**：侧栏的两个键入口必须分开——全局 chord 在 `resolveKey` 之前解析、不带 ctrl/meta 恒返回
  `'none'`，侧栏聚焦的挂容器，方向键/Enter 才不会从 composer 抢键；分组 `own` 在侧栏里只决定组序
  （`undefined` 解释成「都不是」），只有跨项目切换才重排。徽标不新增 wire 字段（`isStreaming` +
  `hasOverlay` 够，代价是 `onShellChanged` 给每个 pane 重绘）；盘上会话拉取只挂四个时机（启动 /
  `lanes` / `isStreaming` 下降沿 / 删除后），**绝不挂 snapshot tick**；驱逐宁超额也不杀正在跑的
  （`selectEvictions` 剩下全 pinned 时返回**不足数**）；`removeShadowRepo` 必须收 `store.resolve()`
  之后的 id（线上字符串直通 `rm(recursive)`，`''`/`'..'`/带分隔符都会解析到 shadow-git 本身）。
- **4a**：`ShellHost` 泛型默认值用结构切片 `ShellLaneWorkspace<PaneT>`；close-pane 是自毁命令、
  reply 天然丢失（pending 由 `failAllPending` 吸收）；渲染器初始化一律拉取（Electron 丢弃 preload
  注册前投递的 IPC）；`deactivate()` 清绘制不清状态；darwin 最后一个 lane 关掉保留空窗口；
  lane↔pane 簿记按 `paneId` 线性扫（键必须不随 `/clear`、`/resume` 移动）。
- **其余**：`ToolRegistry.refresh()` 把 Agent 工具移到数组末尾（工具顺序是 prompt 缓存键的一部分）；
  `fallbackModel`/`compactModel` 校验原始配置串（拼错 ≠ 没配置，否则被静默忽略）；3j 四决策——
  项目最后一个窗口关掉即 `shutdown`、入口「Open project…」+ `Ctrl+Shift+O` 不做原生 File 菜单、
  别的项目的标签只能聚焦、跨项目一律走 shell 旁挂命令。

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
  而不是去改那条通用守卫（见「阶段 5 新记的账」）。
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

# 阶段 5 用例（渲染器模型/视图 + 样式 + imports + 分支 seam，一并跑；按域窄跑另见 AGENTS.md）
node --import tsx --test test/rendererWelcome.test.ts test/rendererWelcomeView.test.ts \
  test/rendererSettingsModel.test.ts test/rendererSettingsView.test.ts \
  test/rendererTranscriptModel.test.ts test/rendererTranscriptView.test.ts \
  test/rendererThinking.test.ts test/rendererUserMessage.test.ts test/atMentions.test.ts \
  test/rendererComposerChip.test.ts test/rendererComposerView.test.ts \
  test/rendererCanvasHeader.test.ts test/rendererCanvasHeaderView.test.ts \
  test/rendererSidebar.test.ts test/rendererStyleTokens.test.ts test/rendererImports.test.ts \
  test/gitBranch.test.ts
node --import tsx --test test/desktopShellHost.test.ts test/settingsPersistence.test.ts test/openInEditor.test.ts
npx tsc --noEmit -p tsconfig.domtest.json             # 第四段单独跑

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

**阶段 6 相关（标题栏 + 侧栏 + 对话流 + 设置）**：

```bash
node --import tsx --test test/rendererTitleBarView.test.ts test/rendererSidebarView.test.ts   test/rendererTranscriptView.test.ts test/rendererStyleTokens.test.ts test/rendererImports.test.ts
# 6f：启动守卫（自己 esbuild 一次 renderer bundle，~0.5s）
node --import tsx --test test/rendererBoot.test.ts test/desktopBuild.test.ts test/rendererImports.test.ts
node --import tsx --test test/desktopShellHost.test.ts test/protocolCommandSchema.test.ts
```

**当前基线**：5e 后全量 2362 条；阶段 6 后 2377 条；**6f 后 2379 条，实测 2379 pass / 0 fail**
（46s，`agentTool` 那条已知不稳定这次没复现），typecheck **四段**全过，`build:desktop` 通过；
之后的新增用例应在此基线上累加。（阶段 4 基线：2199 条、
typecheck 三段、真机冒烟十条全绿。）
**5c–5f 待跑的冒烟项**：合并记在上方「阶段 5 新记的账」末尾那条。
