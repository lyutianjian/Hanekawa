# Hanekawa 桌面端适配 — 进度与待办

> 交接文档。**架构与不变式在 `CLAUDE.md`**，本文件只讲进度、决策留痕和没做完的事。
> 状态：`[x]` 完成并验证 · `[~]` 部分完成 · `[ ]` 未开始

---

## 目标

阶段 0–3j（已完成）：把 agent 内核抽成 headless 运行时，搬进 Electron，跑通协议层 36 条命令、
多标签、多项目、markdown、rewind、消息队列与费用。时间线见 git log（`34fbea0` 之前的 `3a`–`3j`）。

**阶段 4（本阶段）**：不再扩内核能力，把外壳从「能跑的开发者原型」做成产品形态——单窗口 +
侧边栏全量会话历史、设置界面、按 `design_guidance.md` 重做视觉。附带取消三档模型路由。

**进度**：4a、4b、4c、4e、**4d（含 4d-2，四个分类全部可用）** 完成；只剩 4f。
（4c、4e 都先于原定顺序做，理由见各自一节。）测试基线：阶段 4 起点 1989 → 现 **2198 条**。
连跑两次全量各红**一条不同的**已知间歇（`backgroundTasks` / `toolcall-integration`），两条单独跑都稳定全绿。

---

## 阶段 4 的六条决策

| # | 决策 |
|---|---|
| 1 | 单窗口；侧边栏**按项目分组**，保留 3j 的多项目能力，`ProjectDirectory` 不动 |
| 2 | 点开过的会话保持活着（独立 runtime），侧边栏显示运行中 / 等待授权徽标；**不给关闭按钮**，超上限按 LRU 静默释放 |
| 3 | 设置覆盖四块：Provider、权限、Agent、通用+MCP+上下文 |
| 4 | **effort 不进设置**，放在输入框右下角，随时可调 |
| 5 | 中文界面；共享 presentation 层加 `locale` 参数（桌面传 `zh`、TUI 传 `en`）；chrome 用系统无衬线，代码/diff/命令预览保持等宽 |
| 6 | **彻底移除三档模型机制**（`fast`/`balanced`/`powerful`），路由直接指向具体模型键，子 agent 默认 `inherit`。**已落地**：连带失去「plan 自动升档」与「compact 自动降档」，`compactModel` 是保留的逃生口 |

### 架构决定：单窗口 + lane 多路复用（4a 已落地）

「切换会话不中断运行中的会话」要求一个窗口里同时活着 N 个 `SessionController`（`submit` 拒绝并发
turn、`sessionSwitch` 会 `interrupt`，靠一个 host + `retarget` 做不到），于是是 N 个
`SessionPane` + N 个 `SessionHost` 对一个渲染进程。解法是在 `RuntimeChannel` 之上加一层**信道复用**
（信封 `{kind:'data'|'close', lane, body}`），而不是给 36 条命令都加 `paneId`——那会污染协议、破坏
TUI 与 `protocolChildProcess` 的字符串脚本。窗口级的设置/会话列表挂 `__shell` lane，不加 `HostCommand`
（`ConfigService` 在 `ProjectRuntime` 上，而 `ProjectDirectory` 只有外壳有）。`focus-pane` /
`open-project` 两条旁挂命令保留不动，只是桌面渲染器不再调 `focus-pane`——单窗口下激活是纯渲染器行为。

---

## 已完成

### 4a — 信道复用 + 单窗口骨架 `[x]`

- 新增 `src/runtime/protocol/laneChannel.ts`（`createLaneMux`）：lane 级 close 走**控制帧**（否则对端
  pane 消失时 `SessionClient` 的 pending 永悬）；未 attach 的 lane 入站**有界缓冲**（上限 256，溢出关
  lane 而非丢帧）。纯函数，纯 node 下可测。
- 新增 `src/desktop/shellHost.ts` + `shellProtocol.ts` + `renderer/shellClient.ts`（本期三条命令 +
  `lanes`/`activate` 两个事件）。做成 `SessionHost` 同款的类，因为 **`main.ts` 一行测试都没有**，
  决策必须落在可测模块；入站 zod `.strict()` + keyed `satisfies` + `_NoDrift`。**`SessionHost` 一行未动**。
- `main.ts`：只建一个 `BrowserWindow`（`ensureShell` 幂等）；lane key 由 `ShellHost` 自铸（单调、不复用，
  `/clear`、`/resume` 不动它）；`detachPane` → `ShellHost.detachLane` 是消亡路径唯一出口；最后一个 lane
  关掉即 shutdown 项目；`second-instance` = 聚焦唯一窗口 + `openProjectInteractive(cwd)`。
- `renderer/app.ts`：抽出 `paneSession.ts`（每 lane 会话级状态 + 草稿显式化 + 每 pane transcript DOM
  子树），`app.ts` = mux + ShellClient + paneSession map + activeLane + 全局键路由。背景 pane 只更状态
  不做 DOM。渲染器侧 value-import 白名单登记 `laneChannel.js`/`pendingRequests.js` + tsconfig.renderer include。
- 凭据：`test/laneChannel.test.ts`、`test/desktopShellHost.test.ts`（真 `ProjectDirectory` + 泛型假货，
  **零 `as unknown as`**）、`test/desktopMain.test.ts` 第五用例（单传输双侧 mux + 真 ShellHost + 双 lane
  端到端）。**未做真机冒烟**，整体后移到 4f（第 1、2、6 条即 4a 验收）。

### 4b — 侧边栏、会话历史、删除 `[x]`

- 纯模型 `renderer/model/sidebar.ts`：三级分组、时间分节（按**日历日**，`now` 入参注入）、徽标推导
  （`isStreaming` + `hasOverlay`，**没有新增 wire 字段**，`awaiting-input` 压过 `running`）、键盘导航、
  `Ctrl+B` 折叠。`dom/sidebarView.ts` 替换并删掉整套 tabBar 模型/视图/测试。
- shell 协议补 `list-sessions`（跨项目）/ `delete-session`。删除顺序：**先抓 `store` 与 `cwd`** →
  `store.resolve()` 拿解析后的 id → 关该会话的 lane（若开着）→ `deleteSessionArtifacts()`。侧栏内联二次确认。
- **新增 `src/runtime/deleteSession.ts`——「删一个会话」终于有了归属**。原计划只修 shadow-git，复查又
  grep 出 `.myagent/session-memory/<id>.json` 与 `.myagent/sessions/subagents/<id>/`。`SessionStore.delete`
  只能删它自己那三个文件（其余都在 `sessions/` 之上，反向调用是环），清单必须落在 `runtime/`。
  **以后新增 `.myagent/<x>/<sessionId>` 类工件都往这里登记。**
- LRU：`src/desktop/paneBudget.ts`（纯函数）。上限 4 个常驻，**永不驱逐**「活跃 / 正在跑 turn / 有未答
  阻塞请求」的 pane，全 pinned 时宁可超额。兑现决策 2 的「不给关闭按钮」：行上只有删除。`Ctrl+W` 保留。
- 凭据：`rendererSidebar` / `paneBudget` / `deleteSession` / `checkpointService`(+`removeShadowRepo`) /
  `desktopShellHost`(+6) / `rendererImports`(+「渲染器 `required()` 的每个 id 都在 index.html 里」——
  它在模块作用域就抛，改页面结构时是一扇空白窗口，两段 typecheck 都看不见)。

**完成注记（仍然有效的部分）**：

- 删除确认是侧栏内联 + 容器 keydown + `focusout` 撤销，`resolveKey`/`ShellState` 一行未动；代价是消费掉
  的按键必须 `stopPropagation()`——全局 handler 挂在 `document` 上，放一个 Enter 过去会既激活行又把
  composer 发出去。
- **「删完再 `broadcastLanes()`」被用例证伪并删掉**：`ShellClient` 按设计吞掉内容相同的重复 `lanes`。
  渲染器改用 delete 命令自己的回包当刷新信号，用例名钉住理由。
- **补严了 `rendererImports` 的一个洞**：原判据放行 `../shellProtocol.js` 这类**逃出 `renderer/` 的**
  说明符；改成解析真实路径判断，逃出的必须上白名单，白名单条目按**真正 import 它的文件**解析。
- `/simplify` 复查抓出并修掉四件：① **复用 `assertSafeSessionId` 时把 `'.'` 漏掉了，是删数据的回归**
  ——它原本按 `${id}.json` 形状校准，而 `removeShadowRepo` 是第一个把 id 当**整个目录名**用的调用方，
  `path.join(dir,'.')` collapse 回 `dir` 然后进 `rm -r`。**教训：复用校验规则时要问它是按哪个形状校准的。**
  ② `+ 新建会话` 与 `Ctrl+T` 目标项目不一致（已抽 `newSessionIntent()`）；③ `canCreate` 只关按钮不关
  快捷键，违反「key path and button must agree」；④ 侧栏整树重绘（`sameTaskList` 比 `outputBytes`，
  后台 `npm test` 会按输出刷新率重建每一行历史）——已加 `sidebarRenderSignature` 字段签名闸门 +
  折叠时不建行。

### 4c — 取消三档模型 `[x]`

破坏性变更，README / CLAUDE.md 都已记一笔。**先于 4a 做**：4c 自足、每步全绿，且是 4d/4e 的事实前置。

- `config/routing.ts` 删 `Tier`/`TierOrInherit`/`Profile`/`parseTierInput`/`resolveTier`；`Routing` 值变成
  `string`（模型键或 `'inherit'`）；`pickTier` → `pickRoutedModel`；`DEFAULT_ROUTING` 全 `'inherit'`。
- `config/service.ts` 删 profiles 相关六个方法；`resolveModelKeyFor` = 「查 routing → 是模型键就用 →
  否则 `inherit`/未配 → `defaultModel`」。`settings.ts` 补「`defaultModel` 必须是 `models` 里存在的键」
  ——**只在 `settings.models` 存在时判**，否则 models 只配在 `config.json` 的合法配置会被误报。
- `modelPicker.ts`：`tier` → `key`，入参收窄成结构化 `ModelPickerConfig`。连带改 `modelSwitch` /
  `providerRuntime` / `runOverrides` / `configTool` / `commands/provider` / `protocol/host` /
  `renderer/model/surfaces` / `ModelPickerDialog` / `App.tsx` / `ProviderPanel`（routing 页签换成下拉）。
- **迁移**：`getLegacyModelFindings()` 扫原始层，`bootstrap.ts` 的 `checkLegacyModelTiers` 出
  `RuntimeDiagnostic` 警告、**不拦启动**；三档 routing 值归一成 `'inherit'`，三档 `defaultModel` 落到
  第一个可解析的模型键。

**新增的四条不变式**（都做过变异验证）：

- `removeModel` 拒绝删除 routing 仍指向的模型（被删那条 profile 引用检查的正统继承者）；`renameModel`
  要把新键写回 routing。
- 迁移只在「三档字面量**且不是**真实模型键」时才动手：用户真有个叫 `fast` 的模型是合法新式配置。
- 模型键解析不了时 picker 行仍然**画出来**并说明原因——配置了却选不了的模型必须自己解释自己。
- routing 指向已不存在的键时**降级为 `inherit`** 而不是失败，这正是「删模型是可恢复的错误」的依据。

### 4e — 视觉重构（design_guidance 落地）`[x]`

**先于 4d 做**：guidance 描述得最具体的界面（卡片包裹的设置行、右对齐控件）**正是 4d 要建的**；反过来
4e 先立好令牌与 `styles.css`，4d 只是往已有的表里加设置行规则。

- 新增 `renderer/styles.css`（606 行内联表**逐字**搬出 → 换令牌 → 改结构，分三步以便回退），
  `copy-desktop-assets.mjs` 跟着拷，CSP 的 `style-src 'self'` 允许外部表。
- 令牌层级：`--surface-base`（外框/侧栏，**最暗**）→ `--surface-canvas` → `--surface-card` →
  `--surface-hover` → `--surface-active`；文本三级 + `--link`；语义点缀色五个，**只允许出现在
  `color`/`fill`/`border-*-color`，绝不做填充**。明暗阶因此**反转**了（旧表侧栏比画布亮）。
- 结构：`#canvas` 变成圆角 + `overflow: hidden` 的嵌套面板，靠 8px 外边距与侧栏分开（**间距代替竖线**）；
  `#surface`/`#queue`/`#suggestions` 改成浮在画布里的卡片；共去掉 8 条发丝线；用户消息改成右对齐气泡
  （`--user` 那个蓝色整个从调色板消失）。
- **输入区改成胶囊复合框**：左下 `+`、右下「模型 · effort」胶囊、圆形发送按钮，兑现决策 4。新增纯模型
  `model/composer.ts`，复用 `config/effort.ts`。**删掉 `#status-model`**——状态栏留第二份必然漂移。
- 字体：chrome 用 `--font-ui`；`--font-mono` 显式重声明在 8 个选择器上（决策 3 的六个，**外加**
  `.transcript .item.tool` 与 `.tool-progress`——它们承载命令行与工具输出，比例字体下 `git status` 会掉列）。
  顺手修 7 处 `ch` 宽度（`ch` 是字符 `0` 的宽度，换比例字体后全部失准）。`lang` 改 `zh-CN`。
- 图标：新增 `dom/icons.ts`，用 `document.createElementNS` 造 SVG（`el()` 只会 `createElement`，HTML
  命名空间里的 `"svg"` 什么都不画；`innerHTML` 是硬规则）。
- 中文化：三个 presentation 模块加**可选** `locale`（默认 `'en'`）；`runtime/locale.ts` 与渲染器
  `model/locale.ts` 的 `UI_LOCALE` 是一处拼写，不是十二处 `'zh'` 字面量。
- 凭据：`rendererStyleTokens` / `rendererComposerChip` / `desktopBuild`（断言 `styles.css` 被拷贝，**并按
  HTML 里的相对引用反查**，以后漏进 copy 脚本会报红）/ 三个 presentation 测试各加「zh 用例 + 默认仍是英文」。

**完成注记（仍然有效的部分）**：

- **`--accent`（青绿，26 处）不对应任何单个新令牌**，它同时在干五件事，必须按职责拆开：品牌/标题/选中
  文字 → `--text-primary`，光标 → `--caret`，聚焦边框 → `--focus-ring`，状态字形与色条 → `--accent-info`，
  任务勾选 → `--accent-review`，主操作填充 → `--text-primary` 底 + `--surface-base` 字形。不拆就只是
  「换了色相的旧界面」。
- **计划里的四层令牌不够，补了第五层 `--surface-hover`**：面板**自身**就是 card 之后，面板内行的 hover
  同色 = 不可见；用 `--surface-active` 又让 hover 与选中不可分。四个状态本来就需要四级以上。
- **`#submit` 是全界面唯一的高对比填充，而且是中性的**（`--text-primary` 底）。用点缀色做按钮底正是
  guidance「95% 中性」要排除的那件事。
- **`locale` 选可选、默认 `'en'`，是被两条既有断言逼出来的**：`rewindPresentation` 按**函数身份**断言
  （只能加参数），`tuiRender` 断言英文帧。必填参数意味着改约 25 处终端调用点、零收益，且每处都是把
  `'zh'` 打进终端的机会。三个测试各加「不传参数仍是英文」——那是 TUI 与静默换语言之间唯一的闸门。
- `PERMISSION_OPTIONS` / `ENTER_PLAN_OPTIONS` / `EMPTY_PLAN_OPTIONS` 是常量且**被用作默认参数值**，
  所以保留英文常量、旁边加 `…Options(locale)` 函数。`riskLevel` 与权限来源两个 wire 枚举也要查表，
  不译的话中文对话框里会出现「dangerous - bash safety」。
- **`#composer-attach` 暂时接成「在光标处插入 `@`」**（`insertMentionToken`），因为没有对应的 host 命令；
  正好接上现成的 `@` 文件补全。留给 4f 冒烟。
- **未做真机冒烟**，整体留给 4f。**Step 3/4 的判据本质上是视觉的，没有任何用例能替代肉眼看一次窗口。**

### 4d — 设置界面（骨架 + Provider 全套）`[x]`

左下角 `⚙ 设置` 或 `Ctrl+,` 进入，占满 canvas（不是 modal），左侧分类 + 右侧卡片分组表单。权限 /
Agent / 通用+MCP+上下文 三块当期是禁用的占位分类，连同各自的决策留给了 4d-2（下一节）。

**动工前查出的两个事实，它们改变了设计形状**（都亲自核对过，对 4d-2 同样成立）：

- **`reloadSettings()` 会重读配置层**（`bootstrap.ts:143` 是 `await config.load(settings)`），所以**未
  `save()` 的内存改动会被它抹掉**。每次设置写入的顺序因此被钉死为
  `mutate → config.save() → project.reloadSettings() → 扇出`。顺序反了是**数据丢失**，而且回包看起来
  还是对的——到下一次拉取之前都装作成功。
- **`needsRuntimeRebuild` 只等于 `hooksChanged`**（`bootstrap.ts:141,146`），provider/model/routing 一律
  返回 `false`。照搬 `reload-settings` 的判据会得到一个「存盘了、界面也变了、但要重启才生效」的设置屏幕
  ——**在屏幕上与正常工作无法区分**。所以 `refreshAfterConfigChange` 接收显式的 `rebuild`。

- shell 协议补 `get-settings` / `settings-change` / `rename-session`：**一条命令带一个 `SettingsChange`
  可辨识联合**（`scope` 分卡片、`kind` 分操作），而不是十条命令；zod `.strict()` + keyed `satisfies` +
  `_NoSettingsDrift` 保证新增变体按名字失败。
- `WireSettingsSnapshot` 逐字段投影，**apiKey 一律掩码**（新增 `config/maskKey.ts`）。字段名叫
  `apiKeyMasked` 而**不是** `apiKey`——掩码值因此不可赋值给任何 `SettingsChange` 字段，「把 key 画出来
  再原样送回」根本编译不过。
- **Provider**：endpoints / models / routing（main / plan / compact / subagent[type]）全套增删改，复用
  `ConfigService` 现成九个方法 + `save()`；删除时的三条引用检查本就在里面，直接让它抛。
- `refreshAfterConfigChange()` 从 `SessionHost` 的 `reload-settings` 分支抽出（`WireReloadSettingsResult`
  逐字节不变，`protocolHost.test.ts` 零改动保持绿），由外壳按项目扇出——**`reloadSettings()` 每项目一次，
  不是每 lane 一次**。
- **兑现 4b 推过来的 `rename-session`**：与配置扇出**共用一次** `LaneOccupant` 拓宽
  （`refreshAfterConfigChange` + `refreshSessionMeta`）。`SessionController` 加轻量的 `refreshSessionMeta`
  （**带 id 断言守卫**，永远不能变成绕过 `sessionSwitch.ts` 的后门），而不是用 `retarget`——后者会
  interrupt 并清掉 usage / 工具进度 / checkpoint，为一个标题不值当。
- 渲染器：`model/settings.ts` + `dom/settingsView.ts` + 新增 `dom/controls.ts`（`button()` 从
  `sidebarView.ts` 上移，加 `textField`/`selectField`）；`icons.ts` 加 `gear`；`index.html` 加 `#settings`；
  `styles.css` 加设置行规则（**没有新增 `:root` 令牌**）。
- 凭据：`rendererSettingsModel` / `settingsPersistence`（真 `ConfigService` + 临时目录）/
  `desktopShellHost`(30 → 47) / `protocolHost`(+3)。四条变异验证都是预期那条报红（save/reload 顺序、
  每项目一次 reload、掩码、`clearCachedSections`）。

**完成注记（仍然有效的部分）**：

- **`ShellLaneProject` 拿 `config` 而不是走 occupant**：一个项目一个 `ConfigService` 却有 N 条 lane，走
  occupant 等于随便挑一条；而且设置屏幕可以停在一个你并没有在看其 lane 列表的项目上。切片只列
  `ConfigService` 上**真实存在**的十二个成员——写 `setFallbackModel`（不存在）会打破
  `Satisfied<RuntimeHost, ShellLaneProject>`，这也是 `fallbackModel`/`compactModel` 本期只读的原因。
- `runSidebarIntent` 补了 `assertNeverIntent(value: never)`（原来没有 `default` 也没有 `assertNever`，
  漏一个 case 会编译通过且什么都不做）。变异验证过：删掉 `open-settings`，`tsc` 按变体名报错。
- **`as unknown as` 第六次应验，这次两边都点名了**：`desktopMain.test.ts` 的 `createOccupant` 不是 cast，
  `LaneOccupant` 拓宽时 tsc 直接报了它；同文件的 `fakeProject()` 仍是 `as unknown as ProjectRuntime`，
  `config` 与 `store.rename` 一声不响，手工补的。
- **未做真机冒烟**，留给 4f（第 8 条即本期验收）。**分类栏布局与 `min-height: 0` 本质上是视觉的。**

### 4d-2 — 权限 / Agent / 通用+MCP+上下文 `[x]`

四个分类全部可用。三条新决策：非 provider 的写入一律落 `settings.local.json`（一个 writer）；
MCP 重连**从不弹窗**，只认界面上的信任开关；上下文六个数走 `ConfigService`（见下面第 4 条事实）。

**动工前查实的七个事实，它们改变了设计形状**：

1. **`settings.autoCompact` / `autoCompactThreshold` 全仓无人消费**（只有 `configTool.ts` 读写；真正的
   阈值是 `agent.contextManagement.autoCompactThresholdRatio`）。**没进界面**——否则是两个死开关。
2. **`permissions.mode` 也是启动期快照**（`sessionScope.ts` 建 `PermissionGate` 时读一次，
   `reloadSettings()` 只调 `setConfigRules`）。所以那行写「对已经打开的会话无效，下一个新会话生效」——
   不是「重启后生效」，每开一个 pane 就是一个新 scope。
3. **`cache.ttl1h` 被按值捕获**（`createRuntime.ts` 的 `cacheRuntime: { settings: getSettings(), env }`），
   所以这个开关是本期**唯一**必须 `rebuild: true` 的设置写入。
4. **`agent.contextManagement` 不能写 settings 层**：`ConfigService.load()` 把 `config.json` 叠在 settings
   **之上**，写 settings 会被 config.json 静默压过。六个数因此走新增的 `setContextManagement()`。
   这是对「非 provider 一律写 local 层」的一处明示偏离，理由是可验证的层序。
5. **`mcp.trustedServers` 跨层求并集**：上层授予的信任在本地层撤销不了。开关因此有 `trustEditable`，
   置灰并说明——与「继承规则只读」同一条规则的另一面。
6. **`reloadSettings()` 校验失败会 throw**：一次坏写入让该项目的 reload 一直失败到手改文件为止。
   所以 `updateLocalSettings` 在**写盘前** `validateSettings`。
7. **`ManagedMcpClient.config` 私有且无 getter**：服务器清单读 settings（`ProjectRuntime.getSettings()`），
   连接状态读 `project.mcp`，不去问 client。

**新增的 seam**：

- `config/settings.ts` 导出 `localSettingsPath` / `loadLocalSettings` / `updateLocalSettings`（唯一 writer，
  按名字重写键、`undefined` 表示删除、写前校验）+ 四个具体写入器（权限整组、启动模式、MCP 信任、缓存）。
  `persistPermissionRule` 与 `trustMcpServerLocally` 收敛到同一个 writer 上。
- `ConfigService.setContextManagement(patch)`：非法值直接抛（token 数正整数、两个 ratio 落在 `(0,1]`），
  与 `removeModel` 同款让外壳把异常送回界面。
- `ProjectRuntime` 加 `getSettings()` / `listAgentDefinitions()` / `reloadMcpServers()`；`mcp` 改成
  **原地改写**（`splice`）而不是换对象——它是个值，换对象等于让所有持有者拿着启动时的快照。
- `ToolRegistry.removeServerTools(name)`：热重连前先摘掉旧服务器的工具，否则从 settings 里删掉的服务器
  的工具会永远留在每个 runtime 的工具数组里（注册表只听得到「连上的」服务器）。
- `shellHost.ts`：`applyProviderChange` 收窄成只吃 provider 变体（原样保留，它那三条引用检查的用例零改动），
  外面新增 `applySettingsEffect` 返回 `{ saveConfig, rebuild, scope, afterReload? }`。编排因此变成
  **mutate → 有条件 save → reload → afterReload → 有条件扇出**。`describeSettings` 变 async（要读本地层）。
- 渲染器：`SettingsControl` 加 `toggle` / `input` 两种，`controls.ts` 加 `toggleField`
  （`<button role="switch">`，不是 checkbox——checkbox 得先 un-style 才能 re-style），
  `rowNode` 的 switch 补 `assertNeverControl`（漏一个 kind 会画出**空控件格**，即「这项设置改不了」）。

**完成注记（仍然有效的部分）**：

- **`LIVE_CATEGORIES` 整套机制删掉了**（连 `SettingsNavItem.disabled`/`disabledReason` 与
  `select-category` 的守卫）。四个分类全活之后它是死代码，换成 `cardsFor` 的穷尽 `switch`——
  **编译期比运行时白名单强**：新增分类不实现就编译不过，而旧机制只会画一行灰的。
  变异验证过：删掉 `toggle` 的 case，tsc 在 `assertNeverControl` 上按变体名报错。
- **`config.save()` 变有条件是要紧的**，不是洁癖：它写的是**合并后的整个 `Config`**，而 settings 层的
  models/endpoints 已经被 `config.load(settings)` 合并进来了——为加一条权限规则调它，等于把 settings 层
  复制一份进 `config.json`。凭据是 `'a permissions edit does not write config.json'`。
- **`afterReload` 这一档是被 MCP 逼出来的**：`reloadMcpServers()` 读的是 runtime 手上的 settings，
  而那份只由 `reloadSettings()` 替换。放在 reload 之前，信任开关就会用**改动前**的信任列表重连，
  于是「打开开关」什么都不会发生。用例按 `log` 的相对顺序钉住。
- **`kind` 必须全联合唯一**：schema 表是 `Record<SettingsChange['kind'], …>`，dispatch 也按 `kind` 分派,
  所以不能有 `{scope:'agent', kind:'set-routing'}`。Agent 卡片的路由**复用** provider 的
  `set-subagent-routing` 与 `routingOptions()`，不另开一条通路。
- **权限组按「本地 / 继承」两段上线，不是给每条打标记**：`splitPermissionGroup` 用**计数**相减而不是集合
  相减——同一条字面量在项目层和本地层各有一份时，合并结果里真的有两条，能删的只有本地那条。
- **`FakeProject.reloadSettings()` 真的去读盘**（`loadMergedSettings(this.cwd)`）。设置层的写入走的是真
  文件，假货不跟着读就什么都观察不到——「假货必须真的做它要防的那件事」的又一次应验。为此
  `desktopShellHost` 与 `settingsPersistence` 都加了 HOME 隔离（`loadMergedSettings` 会读 `~/.myagent/`）。
- **`as unknown as` 第七次应验**：`ProjectRuntime` 加三个成员，四个 cast 出来的假 project 一声不响
  （`desktopMain` / `protocolHost` / `sessionWorkspace` / `desktopUiRoundTrip`），手工补的；
  而 `FakeProject implements ShellLaneProject` 与 `SETTINGS_CHANGE_SAMPLES` 的 keyed `satisfies`
  按成员名/变体名逐个报红。
- **`../../shellProtocol.js` 要单独上 `rendererImports` 白名单**：`model/settings.ts` 现在 value-import
  `CONTEXT_MANAGEMENT_FIELDS`，而白名单是按**说明符字符串**记的，`../shellProtocol.js` 不覆盖深一层的。
- **未做真机冒烟**，与 4d 一起留给 4f（第 8 条）。**分类栏布局、长表单滚动、开关的观感只能肉眼看。**

### 文档 `[x]`

- `CLAUDE.md` + `AGENTS.md`（逐字镜像，用 `diff <(sed -n '4,$p' …)` 验证第 4 行起一致，只有标题与
  guidance 行不同）：改「Electron shell」「The renderer」两节为「一个窗口 N lane」，新增 laneChannel /
  ShellHost / paneBudget / `removeShadowRepo` 闸门 / 侧栏三段 / `styles.css` 令牌系统与三条源码级不变式 /
  胶囊输入框 / `dom/icons.ts` 的 `createElementNS` / `locale` 默认 `en` 及其两条约束。
  4d-2 又补：`updateLocalSettings` 这个 seam 与三条合并语义、`config.json` 叠在 settings 之上、
  `ProjectRuntime` 三个新成员与 `mcp` 原地改写、`SettingsChange` 的 `kind` 全局唯一、设置写入的五段编排。
- `README.md` 新增「桌面设置界面」一节：每个分类写哪个文件（表格）、继承条目为什么只读、
  上下文六个数为什么要重启。这是用户唯一能提前知道的事。
- `design_guidance.md` 从「未落地的参考资料」变成 4e 的依据。**它只规定明暗阶顺序、圆角档位与组件解剖，
  没有任何十六进制值、px 字号或字体栈**——那套中性深色阶是 4e 造的，钉在 `rendererStyleTokens` 的
  「按值」那条用例里。

---

## 待办

### 4f — 真机冒烟（CDP，沿用 3j 的驱动）`[ ]`

一窗一 socket 全程持有，`window.hanekawa.send` 直接发协议命令 + 读 DOM。

1. [ ] 会话 A 跑长 turn 时切到 B → A 徽标「运行中」，切回 A 流式内容仍在续；
2. [ ] B 触发权限提示时切到 A → B 徽标「等待授权」，切回 B 提示还在、能答；
3. [ ] 侧栏删除会话 → 二次确认、行消失、`.myagent/` 下三个文件与 shadow-git 都没了；
4. [ ] 删除**正开着**的会话 → 先关 lane 再删，界面不留幽灵；
5. [ ] 开第二个项目 → 侧栏出现第二组；关掉某项目全部会话 → 该项目 shutdown
   （凭据：再开同一路径要重新 bootstrap）；
6. [ ] 连开 6 个会话 → LRU 静默释放最旧的空闲 pane，再点开能正常重建；
   正在跑的那个**不被**释放；
7. [ ] `Ctrl+B` 收起/展开侧栏；
8. [ ] 设置里改 endpoint / 加 model / 改 routing / 改权限规则 → 保存后状态栏跟着变、
   重启后仍在；改 provider 配置时另一个开着的会话也跟着重建 runtime；
   （四个分类都已实现并有用例；这里要看的是真机上的**视觉**——分类栏布局、
   `min-height: 0` 是否真的让长表单在屏幕内滚动而不是把输入框顶出窗口、开关的观感。
   顺手验：权限规则加/删后 `settings.local.json` 里只有本地那几条；MCP「重新连接」不弹原生窗。）
9. [ ] 输入框右下角改 effort → 状态与后续 turn 生效；
10. [ ] 收尾无残留 electron 进程。

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
  `WireLaneInfo` 与 activeLane 推）。无害（`onPanesChanged` 那条订阅仍会触发 `onShellChanged`，
  正是侧栏要的重绘）。**4e 动了 `paneSession.ts` 却没顺手收掉**；4d / 4d-2 也没有——删成员是独立的
  一次改动，不该混进设置改动里。留给任何一次单独提交。
- **`StartupPermissionMode` 的类型比校验宽**：它是 `Exclude<PermissionMode,'plan'>`，所以类型上还允许
  `'readonly'`，而 `validateSettings` 只认 default / acceptEdits / bypass——写 `readonly` 的设置文件
  根本加载不了。4d-2 在投影处加了 `startupMode()` 兜到 `'default'`，但源头那对不齐没修。
- **自定义 agent 定义不能写 `permissionMode: readonly`**：`agentDefinitionLoader` 的
  `parseOptionalPermissionMode` 只认 default / plan / acceptEdits / bypass，而内置的 `explore` / `plan`
  两个 agent 用的正是 `'readonly'`。文件会被跳过并只打一行 warning。4d-2 写用例时踩到，未修。
- **`settings.autoCompact` / `autoCompactThreshold` 无人消费**（4d-2 查实，见那一节的事实 1）。
  要么接上真正的自动压缩，要么删掉它们和 `configTool` 里的两条——独立一档。
- **`Ctrl+W` / 侧栏关闭不检查 `blocked`**，而 LRU 驱逐是**绝不**碰有未答阻塞请求的 pane 的
  （`paneBudget.isPinned`，理由是 teardown 会以**拒绝**收尾、静默失败用户的工具调用）。
  两者机制相同但情境不同：驱逐用户没要求，`Ctrl+W` 是用户明确要求。要做得更好得加个确认，
  是新范围——记账未做。
- **`SessionStore.list()` 用 `localeCompare` 排 ISO 串**（`sessions/service.ts`），比 `<` 慢约两个
  数量级。本来只在 `/resume` 时跑一次，4b 之后每个 turn 结束都跑一次。先存后续。
- **`sidebarRenderSignature` 是字符串比较**，行数极多时 O(rows) 建串。比重建 DOM 便宜几个数量级，
  够用；真要更进一步是按 item id 做增量行更新（与 `transcriptView` 那条同一条路）。
- **MCP 服务器本身仍不能在界面上增删改**（`McpServerConfig` 没有写入 API），`hooks` 也没有界面；
  `fallbackModel` / `compactModel` 依旧只读（`ConfigService` 没有对应 setter）。
- 已修（勿再记账）：`.myagent/shadow-git/<id>` 删会话时泄漏（4b `removeShadowRepo`）、
  `runSidebarIntent` 缺穷尽检查（4d `assertNeverIntent`）、`settings.local.json` 没有「写整组」
  与 untrust（4d-2 `updateLocalSettings`）、MCP 连接只在 bootstrap 发生一次（4d-2 `reloadMcpServers`）。

---

## 决策留痕（只留 `CLAUDE.md` 未覆盖的）

- **4b：侧栏的两个键入口必须分开**。全局那个（`sidebarChordToIntent`）在 `resolveKey` **之前**解析，
  所以不带 ctrl/meta 必须恒返回 `'none'`；侧栏聚焦那个（`sidebarKeyToIntent`）挂在容器上，方向键/Enter
  因此不会从 composer 手里抢走。合成一个入口就必然要么让方向键全局生效，要么给 `resolveKey` 加一档。
- **4b：分组的 `own` 语义变了，不是照搬**。旧 tab bar 里 `own` 决定「能不能关」，所以
  `ownProjectRoot === undefined` 解释成「全部是自己的」；侧栏里 `own` 只决定**组的顺序**，把每组都置顶
  等于都不置顶，所以 undefined 解释成「都不是」。只有**跨项目**切换才重排，同项目内列表永不动。
- **4b：徽标不新增 wire 字段是可行的**，`getSnapshot().isStreaming` + `shellState().hasOverlay` 就够
  （后者是「有阻塞请求被画着**或**停着」）。代价是 `onShellChanged` 要给**每个** pane 重绘侧栏。
- **4b：盘上拉取只挂四个时机**（启动 / `lanes` 事件 / 某 pane 的 `isStreaming` **下降沿** / 删除之后），
  绝不挂 snapshot tick——`onShellChanged` 一个 turn 里会响多次。下降沿是「标题 / `messageCount` /
  `updatedAt` 刚动过」的唯一便宜信号。
- **4b：驱逐宁可超额也不杀正在跑的**。`selectEvictions` 在「剩下的全 pinned」时返回**不足数**。多留一个
  常驻 pane 只花内存；驱逐一个停着提示的 pane 会让它的 bridge 以**拒绝**收尾，用户的工具调用静默失败。
- **4b：`removeShadowRepo` 的参数闸门不是洁癖**。`delete-session.sessionId` 是线上字符串，直通一次
  `rm(recursive)`；`''` / `'..'` / 带分隔符都会解析到 `.myagent/shadow-git` 本身。同理调用方必须传
  `store.resolve()` 之后的 id：`store.delete` 认前缀，`removeShadowRepo` 不认。
- **4a：`ShellHost` 的泛型默认值陷阱**：约束 `W extends ShellLaneWorkspace<PaneT>` 引用了前面的类型参数，
  而**默认值**在 `PaneT` 未解算时就要满足约束。解法：默认值写结构切片 `ShellLaneWorkspace<PaneT>`，
  main.ts 显式写全三元组。`PaneT` 必须单列：occupant 工厂要真 pane 的 controller/runtimeSlot/scope，
  `PaneLike` 会把它们抹掉、逼出 cast。
- **4a：close-pane 是自毁命令，reply 天然丢失**：lane 的 host 在 `onPaneClosed` 里被 `detachLane` →
  `dispose()` 自毁，`mux.closeLane` 的控制帧先于 reply 发出。渲染器的 pending 由 lane close 触发
  `failAllPending('The host disconnected')` 吸收（与旧「窗口销毁时 in-flight 命令」同形）；测试里是
  `assert.rejects(/disconnected/)`，生产里 `/exit` 路径的 catch 只 note 一下。
- **4a：渲染器初始化一律拉取**：Electron 会丢弃 preload 监听器注册前投递的 IPC，所以 renderer 启动只信
  `shellClient.panes()` 拉取 + 之后的 `lanes` 事件；main 侧先建 lane 后 loadFile 的时序只是便利而非
  正确性依赖，laneChannel 的有界缓冲兜住那个窗口。
- **4a：`deactivate()` 清绘制不清状态**：单例面板（overlay/rewind/surface/suggestions/队列条）上一个 pane
  的 paint 若不清，切 pane 后会画着别人的对话框，而键盘路由只认 active pane——画着却不可应答的对话框
  是陷阱。状态留在 paneSession 里，`activate()` 一次性重绘回来。
- **4a：darwin 最后一个 lane 关掉保留空窗口**（非 darwin 照旧 quit）。空窗口的侧栏仍显示「+ 新建会话 /
  打开项目…」（由 `SidebarView.isEmpty` 与 `hasNewSession`/`hasOpenProject` 决定），这正是留它的用处。
- **main.ts 的 lane↔pane 簿记（3d、3j、4a 各改过一次）**：键必须是**不随 `/clear`、`/resume` 移动**的
  那个。`onPaneClosed` 原本闭包到自己的 `entryWindow`，理由写的是「回调拿到的 `paneId` 是 host 视角的
  当前会话 id，与开窗时的键从来对不上」——前半句对，**结论错**：按 `paneId` 线性扫
  `pane.getSession().id` 就能找到，而闭包到自己意味着一个渲染器关别人的标签会关错窗口。
- **`ToolRegistry.refresh()` 把 Agent 工具移到数组末尾是对的，不要「修」**：新建 runtime 恒为
  `buildRuntimeTools()` + `push(agentTool)`，refresh 重现该顺序，「MCP 重连过的 runtime」与「新建的」
  工具数组才逐位相同 —— 工具顺序是 prompt 缓存键的一部分。
- **`createRuntime` 里 `onActiveSessionChange?.(id)` 放在所有会抛的校验之后**：模型 key 无效时不能已经
  把会话级状态切过去。
- **配置串校验**：名字拼错时 `resolveModelReference` 返回 `undefined` 与「没配置」无法区分而被静默忽略
  —— 已改为校验原始配置字符串，`fallbackModel`/`compactModel` 出 `RuntimeDiagnostic` 警告而不拦启动。
  4c 的三档迁移沿用这条（`checkLegacyModelTiers` 就挂在 `checkOptionalModelReferences` 旁边）。
- **App.tsx「先定义后 `useCommands`」惯例**：传进 `useCommands({…})` 的 handler 必须定义在调用之前
  （TDZ），不加 ref 间接层。
- **3j 的四个决策**：① 一个项目的最后一个窗口关掉就 `shutdown` 它（否则 MCP 子进程和后台任务留在没有
  UI 能停它的进程里；重开只是一次 bootstrap，几百 ms）；② 入口是「Open project…」按钮 +
  `Ctrl+Shift+O`，不做原生 File 菜单（决策进 `model/` 就能被纯函数测到）；③ 别的项目的标签**只能聚焦**；
  ④ 跨项目一律走 shell 旁挂命令，**没有**给 `open-pane` 加 `projectRoot`。

---

## 工作方法（本项目的验收惯例）

- **变异验证**：每加一条不变式，就把 bug 逐个塞回去，确认是**预期的那条**用例报红（已用它证伪过多条
  文档断言，如「没有 `default` 分支就能强制穷尽」实测是假的）。**手工 patch/revert 要 grep 回滚结果**：
  3j 两次「以为改回去了」实际没匹配上（mutation 只删了调用行，注释留着，revert 的搜索串就对不上了），
  是全量跑变红才发现的。
- **断言只值它的假货那么多钱**（4d 新增）：变异验证抓到 `get-settings` 的掩码用例原本是**空的**——
  `FakeConfig.resolveModel` 直接返回 `models[name]`，没有像真的那样把 endpoint 的 `apiKey` 折进去，
  于是「把投影换成 `...resolveModel(key)`」这个真实泄漏 bug 一路全绿。凡是用例守的是「真实现会做 X，
  所以我们必须防着 X」，**假货就必须真的做 X**，否则守的是一个不存在的世界。
- **`as unknown as` 关掉的正是编译器唯一能抓 API 谎言的机会** —— 已六次应验：2b-2 三个开机即死 bug；
  3h 假 controller 的 `usage.total: null`；3i 五个假 project 拿掉 `commands` 后 25 条全绿；4b
  `ShellLaneProject.store` 加成员时 `implements` 假货报红而 cast 的假 project 一声不响；4d
  `LaneOccupant` 拓宽时同一对再演一次。**正解是泛型或结构切片**：`ProjectDirectory<FakeProject,
  FakeWorkspace>`（4a 的 `ShellHost` 测试沿用）、`buildModelPickerOptions` 的入参从 `ConfigService`
  收窄成只含它真读三个成员的 `ModelPickerConfig` —— 测试传普通对象、零 cast，约束仍然检查假货。
  给别的「只读几个成员」的函数推这个手法。
- **真机冒烟先怀疑驱动，再怀疑 app**：3j 的冒烟卡了四轮，三轮都是 CDP 驱动自己的问题 —— ① 每步重新
  attach/detach 一个 DevTools session 会和浏览器自己的簿记打架（改成一窗一 socket 全程持有）；
  ② 让窗口关闭自己的 pane 时不能 `await` 那个 evaluate 的回包；③ 「我的标签」要按 `.active` 找。
  判据：**先在没有 CDP 的情况下复现**，再拿 `git worktree` + node_modules junction 建一份 HEAD 基线对照。
  `Target.setDiscoverTargets` 会让新窗口的渲染器不启动，别开它。
- **真机验证走 CDP，不加调试开关**：`electron . --remote-debugging-port=9222` + node 内置 `WebSocket`
  直连，`Runtime.evaluate` 读 DOM、`Input.dispatchKeyEvent` 发真键；权限对话框用
  `window.hanekawa.send({type:'run-tool', name:'Write', ...})` 零 API 花费触发。零侵入探针：`app.ts`
  只在 `await client.hello()` 返回后才设 `document.title`。
- **测的实现必须就是出货的实现**：renderer channel 曾有测试/出货两份，main 侧工厂的两处 API 谎言被专门
  写的 mock 一路放行。
- **`test/protocolChildProcess.test.ts` 的 host 侧脚本是字符串**（写进临时 `.mjs`），`tsc` 看不见 ——
  改 `SessionHost` 构造 deps 必须手动同步（3a、3b 各踩一次，3b 那次连全量跑都没红）。这也是
  `SessionHostDeps` 里几个成员**故意是可选**的原因。
- **负向断言要给异步留时间预算**（`givePumpAChance()` 150ms）：`pumpQueue` 脱钩、`dequeue` 还要落盘，
  紧跟 enqueue 就断言「什么都没发」测的是竞态不是闸门。
- **被测行为的差别在持久化侧时，断言不能只站在 wire 上**：`/clear` 的 `migrateTo` 与「什么都不做」协议层
  完全同形，用例得读新会话日志里的 enqueue 记录与旧会话日志里的补偿 `clear`。
- **provider 回调里抛的断言会被摘要路径吞掉**，浮上来的是另一个外层断言 —— 按报错行找会找错地方。
- **`protocolClientParity` 的 COVERAGE 表解析 `tui.tsx` 的 `<App` props 源码**，免费接住新 prop
  （已三次），别绕过它。

---

## 验证

```bash
npm run typecheck                                     # 三段：base + preload + renderer
npm run test                                          # 全量，~42s
npm run build                                         # emit 到 dist/（只有桌面外壳需要）
npm run build:desktop                                 # tsc emit + 两个 esbuild bundle + 拷 index.html/styles.css
npm run start:desktop                                 # 真实 Electron，需要桌面
npm run dev:tui                                       # 手动冒烟，需 TTY

# 阶段 4 的五组（4a、4b、4e、4d、4d-2 均已全绿）
node --import tsx --test test/laneChannel.test.ts test/desktopShellHost.test.ts
node --import tsx --test test/rendererSidebar.test.ts test/paneBudget.test.ts \
  test/checkpointService.test.ts test/rendererImports.test.ts
node --import tsx --test test/rendererStyleTokens.test.ts test/rendererComposerChip.test.ts \
  test/permissionPresentation.test.ts test/planPresentation.test.ts test/rewindPresentation.test.ts
node --import tsx --test test/rendererSettingsModel.test.ts test/settingsPersistence.test.ts \
  test/desktopShellHost.test.ts test/protocolHost.test.ts    # 4d
node --import tsx --test test/settingsPersistence.test.ts test/toolRegistry.test.ts \
  test/runtimeBootstrap.test.ts test/permissions.test.ts test/config.test.ts    # 4d-2 的内核侧

# 4c 触及的（已全绿）
node --import tsx --test test/modelPicker.test.ts test/modelRouting.test.ts \
  test/modelSwitch.test.ts test/providerPanel.test.ts test/providerRuntime.test.ts \
  test/config.test.ts test/runOverrides.test.ts

# 既有主题
node --import tsx --test test/protocolWire.test.ts test/protocolHost.test.ts \
  test/protocolClient.test.ts test/protocolClientParity.test.ts test/bridgesPending.test.ts \
  test/protocolCommandSchema.test.ts
node --import tsx --test test/protocolChildProcess.test.ts    # 真实进程边界（tsc 看不见的那段）
node --import tsx --test test/distBuild.test.ts               # emit 后用纯 node 载入
node --import tsx --test test/sessionScope.test.ts test/sessionWorkspace.test.ts \
  test/sessionSwitch.test.ts test/sessionFileLock.test.ts
node --import tsx --test test/multiProject.test.ts test/projectDirectory.test.ts \
  test/commands.test.ts test/commandSuggestions.test.ts test/skills.test.ts \
  test/cacheBreakDetection.test.ts                            # 项目隔离
node --import tsx --test test/electronChannel.test.ts test/bridgeChannel.test.ts \
  test/desktopMain.test.ts test/desktopBuild.test.ts
node --import tsx --test test/rendererImports.test.ts test/rendererShellModel.test.ts \
  test/rendererMarkdown.test.ts test/rendererTranscriptModel.test.ts \
  test/rendererPermissionView.test.ts test/rendererAskUserQuestionView.test.ts \
  test/rendererPlanDialogViews.test.ts test/rendererCompletion.test.ts \
  test/rendererRewindPanel.test.ts test/rendererQueuedMessages.test.ts \
  test/rendererDiffRows.test.ts test/desktopUiRoundTrip.test.ts
node --import tsx --test test/permissionPresentation.test.ts test/planPresentation.test.ts \
  test/rewindPresentation.test.ts test/restoreMode.test.ts test/restoreMode.property.test.ts \
  test/usePermission.test.ts test/fileToolPreview.test.ts
node --import tsx --test test/toolRegistry.test.ts test/runtimeBootstrap.test.ts \
  test/runOverrides.test.ts test/subagentInspection.test.ts
```

**已知不稳定**（三条都是**间歇**：既不要因为一次并发跑绿了就认为已修，也不要因为挂了就去找自己的回归；
判据一律是「单独跑是否稳定通过」）：

- `test/toolcall-integration.test.ts`：全量并发跑挂 `Unable to deserialize cloned data due to invalid or
  unsupported version` —— Node test runner 自己的 IPC 报错，不是断言失败；单独跑必过，未改动基线上同样
  复现。**`--test-concurrency=1` 串行也会红** —— 串行不是它的解药。
- `test/backgroundTasks.test.ts` 的 `background Bash returns immediately and BashOutput consumes
  incremental output`：全量并发偶尔超时红一次（要等真实子进程吐增量输出，1.7s 量级）；单独跑 3/3 全绿。
- `test/agentTool.test.ts` 的 `parent bypass mode still takes precedence for background agents`
  （仅观察到一次）：单独跑 81/81 连过两轮，与改动零交集。

**已知环境依赖失败**（3g 查明，与桌面端无关，尚未修）：`test/config.test.ts` 的
`providers report dynamic ToolSearch support conservatively` 在设置了
`CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` 的环境里必定红。它不是间歇、也不是回归：用例只
save/delete/restore 了 `HANEKAWA_DISABLE_EXPERIMENTAL_BETAS`，而它测的
`isExperimentalToolSearchBetaDisabled()`（`src/utils/toolSearch.ts:132-135`）读的是**两个**变量的或。
已用 `git stash` 在干净基线复现。修法是让该用例对两个变量都做隔离（文件里已有 `setEnv` 助手）。

**注意：这条依赖的是环境变量，不是「在 Claude Code 里跑」。** 看到它报红先 `echo` 一下那两个变量，
别当成回归；4e 落地后在**没有**设该变量的 shell 里实测 2096 pass / 0 fail，4d 后为 2160 pass / 0 fail，
4d-2 后全量共 **2198 条**：连跑两次各红一条不同的已知间歇（`backgroundTasks` / `toolcall-integration`），
两条单独跑都稳定全绿，与本期改动零交集。
