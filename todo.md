# Hanekawa 桌面端适配 — 进度与待办

> 交接文档。**架构与不变式在 `CLAUDE.md`**，本文件只讲进度、决策留痕和没做完的事。
> 状态：`[x]` 完成并验证 · `[~]` 部分完成 · `[ ]` 未开始

---

## 目标

阶段 0–3j（已完成）：把 agent 内核抽成 headless 运行时，搬进 Electron，跑通协议层
36 条命令、多标签、多项目、markdown、rewind、消息队列与费用。基线 1989 tests / 39 suites。
详细时间线见 git log（`34fbea0` 之前的 `3a`–`3j` 各次提交）。

**阶段 4（本阶段）**：不再扩内核能力，把外壳从「能跑的开发者原型」做成产品形态——
单窗口 + 侧边栏全量会话历史、设置界面、按 `design_guidance.md` 重做视觉。
附带取消三档模型路由。

**进度**：4a、4b、4c、4e 已完成；**4d 完成骨架 + Provider 全套**（4c 与 4e 都先于原定顺序做，
理由见各自一节；4a 的落地见 4a 一节的完成注记）。
4d 的其余三块拆成 4d-2，4f 未开始。

---

## 阶段 4 的六条决策

| # | 决策 |
|---|---|
| 1 | 单窗口；侧边栏**按项目分组**，保留 3j 的多项目能力，`ProjectDirectory` 不动 |
| 2 | 点开过的会话保持活着（独立 runtime），侧边栏显示运行中 / 等待授权徽标；**不给关闭按钮**，超过上限按 LRU 静默释放 |
| 3 | 设置覆盖四块：Provider、权限、Agent、通用+MCP+上下文 |
| 4 | **effort 不进设置**，放在输入框右下角，随时可调 |
| 5 | 中文界面；共享 presentation 层加 `locale` 参数，桌面传 `zh`、TUI 传 `en`；chrome 用系统无衬线，代码/diff/命令预览保持等宽 |
| 6 | **彻底移除三档模型机制**（`fast`/`balanced`/`powerful`），路由直接指向具体模型键，子 agent 默认 `inherit`。**已落地**：连带失去「plan 自动升档」与「compact 自动降档」——没有档就没得升，`compactModel` 是保留的逃生口 |

### 架构决定：单窗口 + lane 多路复用

「切换会话不中断运行中的会话」意味着一个窗口里要同时活着 N 个 `SessionController`
——`SessionController.submit` 拒绝并发 turn，`sessionSwitch` 会 `interrupt`，
所以靠一个 host 加 `retarget` 做不到。必须 N 个 `SessionPane` + N 个 `SessionHost`，
但只有一个渲染进程。

现在 `createElectronMainChannel` 靠 `event.sender !== target` 隔离各 pane 的流量
（`src/desktop/ipc/electronChannel.ts:131`）。一个窗口里所有 pane 共用一个
`webContents`，这条判据失效。解法是在 `RuntimeChannel` 之上加一层**信道复用**，
而不是给 36 条命令都加 `paneId` 字段（那会污染协议、破坏 TUI 与
`protocolChildProcess` 的字符串脚本）。

```
                  ┌──────────── main ────────────┐   ┌──── renderer ────┐
ProjectDirectory ─┤ SessionHost(lane a) ─┐        │   │ ┌ SessionClient a │
                  │ SessionHost(lane b) ─┤ LaneMux├───┤ │ SessionClient b │ ← 只有一个可见
                  │ ShellHost (__shell) ─┘        │   │ └ ShellClient     │
                  └──────────────────────────────┘   └──────────────────┘
                             一条 ipcMain 信道，信封 { lane, body }
```

- 设置放 `__shell` 而不是加 `HostCommand`：设置是窗口级屏幕不是会话视图，
  `ConfigService` 挂在 `ProjectRuntime` 上而 `ProjectDirectory` 只有外壳有。
- `focus-pane` / `open-project` 两条旁挂命令**保留不动**（TUI、`desktopMain.test.ts`、
  `/resume` 走 `open-pane` 的路径都还用），只是桌面渲染器不再调 `focus-pane`——
  单窗口下激活是纯渲染器行为。

---

## 待办

### 4a — 信道复用 + 单窗口骨架 `[x]`

视觉不动，先把「一个窗口 N 个活 pane」跑通。

- [x] 新增 `src/runtime/protocol/laneChannel.ts`：`createLaneMux(transport)` → `{ lane(key),
  closeLane(key), close() }`。lane 级 close 走**控制帧**（否则 `SessionClient` 的 pending 请求
  在对端 pane 消失时永悬）；未 attach 的 lane 入站消息**有界缓冲**（上限 256，溢出关 lane
  而非丢帧）。纯函数，`createMemoryChannelPair` 纯 node 下测；控制帧与缓冲上限均已变异验证。
- [x] 新增 `src/desktop/shellHost.ts` + `shellProtocol.ts` + `renderer/shellClient.ts`。本期只做
  `panes` / `open-session` / `open-project` 三条（`lanes` / `activate` 两个事件 + reply/fail）。
  做成 `SessionHost` 同款的类——**`main.ts` 一行测试都没有**，决策必须落在可测模块；入站
  zod `.strict()` + keyed `satisfies` 表 + `_NoDrift`（抄 commandSchema 手法）。**`SessionHost`
  一行未动**——shell 行为全走现成可选回调，绕开 protocolChildProcess 的字符串脚本陷阱。
- [x] 改 `src/desktop/main.ts`：只建一个 `BrowserWindow`（`ensureShell` 幂等）；lane key 由
  `ShellHost` 自铸（单调、不复用，`/clear`、`/resume` 不动它）；`detachPane` → `ShellHost.detachLane`
  （消亡路径唯一出口，先删 map）；「最后一个 lane 关掉即 shutdown 项目」；`before-quit` 顺序不变；
  `second-instance` = 聚焦唯一窗口 + `openProjectInteractive(cwd)`。
- [x] 改 `src/desktop/renderer/app.ts`：抽出 `paneSession.ts`（每 lane 会话级状态 + 草稿显式化 +
  每 pane transcript DOM 子树 `.pane > .transcript + .tool-progress`），`app.ts` = mux +
  ShellClient(`__shell`) + paneSession map + activeLane + 全局键路由。背景 pane 只更状态不做 DOM；
  `deactivate()` 存草稿并清**绘制**（不清状态）。tab bar 数据源换成 `shellClient.getLanes()`，
  切换纯本地（渲染器不再调 `focus-pane`），`/exit` 只关本 pane。
- [x] 凭据：`test/laneChannel.test.ts`（11 条）、`test/desktopShellHost.test.ts`（22 条，真
  `ProjectDirectory` + 泛型假货，**零 `as unknown as`**，closeLane/最后 lane shutdown/幂等三条
  不变式变异验证）、`test/desktopMain.test.ts` 第五用例（单传输双侧 mux + 真 ShellHost + 双 lane
  SessionHost/SessionClient + 出货 ShellClient 端到端）。全量 2023 pass / 0 fail。

**完成注记**：lane 复用信封 `{kind:'data'|'close', lane, body}`；renderer 侧 value-import 登记
`laneChannel.js`/`pendingRequests.js` 白名单 + tsconfig.renderer include；`ShellHost` 泛型
`<P, PaneT, W>` 默认值陷阱与 close-pane 自毁路径详见「决策留痕」。**未做真机冒烟**——CDP 冒烟
整体后移到 4f（第 1、2、6 条即 4a 验收），当前凭据是 desktopMain 第五用例的端到端通道。

### 4b — 侧边栏、会话历史、删除 `[x]`

- [x] 纯模型 `renderer/model/sidebar.ts`：分组（活动 pane 的项目在前，`groupRows` 稳定分区，
  「项目 → 时间分节 → 会话」三级）、时间分节（按**日历日**而非流逝小时，`now` 由入参注入）、
  徽标推导（`running` / `awaiting-input` 由该 pane 的 `getSnapshot().isStreaming` 与
  `shellState().hasOverlay` 得出，**没有新增 wire 字段**；`awaiting-input` 压过 `running`）、
  键盘导航、`Ctrl+B` 折叠。
- [x] `dom/sidebarView.ts`；删 `dom/tabBarView.ts` / `model/tabBar.ts` /
  `test/rendererTabBarModel.test.ts`（21 条）。`index.html` body 改成 `#shell = #sidebar + #canvas`，
  CSS 仍内联（4e 重做）；`#overlay`/`#rewind` 仍是 body 直接子节点，`position: fixed` 盖满窗口。
- [x] shell 协议补 `list-sessions`（跨项目）/ `delete-session`。删除顺序：**先抓 `store` 与 `cwd`**
  → `store.resolve()` 拿解析后的 id → 关该会话的 lane（若开着）→ `deleteSessionArtifacts()`。
  删除走侧栏内联二次确认。
- [x] **新增 `src/runtime/deleteSession.ts`——「删一个会话」终于有了归属**。原计划只修 shadow-git，
  复查 grep 出**另外两处同类泄漏**：`.myagent/session-memory/<id>.json` 与
  `.myagent/sessions/subagents/<id>/`。`SessionStore.delete` 只能删它自己那三个文件（其余都在
  `sessions/` 之上的层，反向调用是环），清单必须落在 `runtime/`（同时依赖 `harness/` 与
  `services/` 的那一层）。以后新增 `.myagent/<x>/<sessionId>` 类工件都往这里登记。
- [x] LRU：新增 `src/desktop/paneBudget.ts`（纯函数）。上限 4 个常驻，**永不驱逐**「活跃 / 正在跑
  turn / 有未答阻塞请求」的 pane；全 pinned 时宁可超额。驱逐 = 该 lane 自己的 `closePane` →
  `onPaneClosed` → `detachLane`。兑现决策 2 的**「不给关闭按钮」**：行上只有删除，释放常驻额度是
  LRU 的事，用户不该被要求去想「运行时」。`Ctrl+W` 保留（不是按钮）。
- [x] 凭据：`test/rendererSidebar.test.ts`（30 条）、`test/paneBudget.test.ts`（11 条）、
  `test/desktopShellHost.test.ts`（22 → 30，补 list/delete 六条）、`test/checkpointService.test.ts`
  （+4 条 `removeShadowRepo`）、`test/deleteSession.test.ts`（4 条，逐工件断言）、
  `test/rendererImports.test.ts`（+1 条「渲染器 `required()` 的每个 id 都在 index.html 里」——
  `required()` 在 `app.ts` 模块作用域就抛，改页面结构时是一扇空白窗口加一行 console，两段
  typecheck 都看不见）。全量 2063 tests / 2062 pass（唯一红的是已知环境依赖那条）。

**完成注记**：

- **`rename-session` 推迟到 4d**：会话正开着时改名要刷新 `SessionController` 私有的 `SessionMeta`
  并推 `session-changed`，而 `ShellHost` 的 occupant 是**故意不透明**的（只有 `dispose()`），
  够不到那个 host。「让外壳对某条 lane 的 host 说话」与 4d 的 `refreshAfterConfigChange()` 扇出
  是同一个形状，应一起设计，而不是为改名单独把 `LaneOccupant` 拓宽一次。
- **`resolveKey` / `ShellState` 一行未动**。删除确认做成侧栏内联确认 + 容器自带 keydown
  （Esc 取消、Enter 确认）+ `focusout` 撤销就够了；代价是消费掉的按键必须 `stopPropagation()`——
  全局 handler 挂在 `document` 上，放一个 Enter 过去会既激活行又把 composer 的内容发出去。
- **计划里的「删完再 `broadcastLanes()`」被用例证伪并删掉**：`ShellClient` 按设计吞掉内容相同的
  重复 `lanes`（身份稳定），删闭着的会话那条广播唤不醒监听器，删开着的会话 `detachLane` 已广播过。
  渲染器改为**用 delete 命令自己的回包**当刷新信号，并写成用例
  （「deleting a closed session leaves the topology untouched」）钉住这个理由。
- **顺手补严了 `test/rendererImports.test.ts` 的一个洞**：原判据让 `../shellProtocol.js`（4a 起
  就有）和 `../paneBudget.js` 这类**逃出 `renderer/` 的**说明符一路放行。改成解析真实路径判断是否
  仍在 `renderer/` 内，逃出的必须上白名单；白名单条目按**真正 import 它的文件**解析，而不是猜
  `src/<rest>`。已变异验证。
- **`/simplify` 复查（四个角度并行）抓出的四件事，都已修**：
  ① **复用共享 id 闸门时把 `'.'` 漏掉了，是删数据的回归**——`assertSafeSessionId` 原本按
  `${id}.json` 那个形状校准（`'.'` 落成 `..json`，无害），而 `removeShadowRepo` 是第一个把 id
  当**整个目录名**用的调用方，`path.join(dir,'.')` collapse 回 `dir` 然后进 `rm -r`。教训：复用
  校验规则时要问它是按**哪个形状**校准的。
  ② **`+ 新建会话` 按钮与 `Ctrl+T` 目标项目不一致**——按钮发无 root 的 `{kind:'new'}`，
  `ShellHost` 回退到 `directory.entries()[0]`（**最先打开的**项目）。已抽 `newSessionIntent()`，
  与 `activateRow` 同款。
  ③ **`canCreate` 只关按钮不关快捷键**，违反「key path and button must agree」。已修。
  ④ **侧栏整树重绘**：`onShellChanged` 由 `client.subscribe()` 驱动，而 `sameTaskList` 比
  `outputBytes`——后台跑个 `npm test` 就会按输出刷新率重建**每一行历史**。已加
  `sidebarRenderSignature` 字段签名闸门（`applySnapshot`/`applyLanes` 同款纪律）+ 折叠时直接不建行。
- **4b 未做真机冒烟**——按 todo 原安排整体留给 4f（第 3、4、6、7 条即 4b 的验收）。当前凭据是
  四组纯函数用例 + `desktopShellHost` 的端到端删除路径 + `desktopBuild` 的「bundle 只因缺 DOM 而失败」。

### 4c — 取消三档模型 `[x]`

破坏性变更，README / CLAUDE.md 都已记一笔。**先于 4a 做**：4c 自足、每步保持全绿，而且是
4d/4e 的事实前置——4d 的 Provider 卡片要渲染 routing、4e 的胶囊要显示模型，按三档做完再拆等于
同一块界面做两遍。

- [x] `src/config/routing.ts`：删 `Tier` / `TierOrInherit` / `Profile` / `parseTierInput` /
  `resolveTier`；`Routing` 值类型变成 `string`（模型键或 `'inherit'`）；`pickTier` →
  `pickRoutedModel`；`DEFAULT_ROUTING` 全部改 `'inherit'`。
- [x] `src/config/service.ts`：删 `profiles` / `activeProfile` 与
  `setProfile` / `removeProfile` / `setActiveProfile` / `getActiveProfile` / `findTierForModel`；
  `resolveModelReference` 只认模型键；`resolveModelKeyFor` 变成「查 routing → 是模型键就用 →
  否则 `inherit`/未配 → `defaultModel`」。
- [x] `src/config/settings.ts` 去掉 `profiles`/`activeProfile`，校验补「`defaultModel` 必须是
  `models` 里存在的键」——**只在 `settings.models` 存在时判**，否则 models 只配在 `config.json`
  的合法配置会被误报。
- [x] `src/runtime/modelPicker.ts`：`ModelPickerOption.tier` 换成 `key`，枚举 `knownModelKeys`；
  入参收窄成结构化 `ModelPickerConfig`（测试因此不再需要 `as unknown as ConfigService`）。
- [x] 连带：`modelSwitch.ts`、`providerRuntime.ts`（scope 去掉 `'profiles'`）、`runOverrides.ts`、
  `configTool.ts`、`commands/provider.ts`、`protocol/host.ts`、`renderer/model/surfaces.ts`、
  `ModelPickerDialog.tsx`、`App.tsx`、`ProviderPanel.tsx`（删 profiles 页签，routing 页签换成
  「`inherit` + 模型键」下拉）。
- [x] **迁移**：`ConfigService.load()` 扫原始层，`getLegacyModelFindings()` 暴露；`bootstrap.ts`
  的 `checkLegacyModelTiers` 转成 `RuntimeDiagnostic` 警告，**不拦启动**。三档 routing 值归一成
  `'inherit'`，三档 `defaultModel` 落到第一个可解析的模型键。
- [x] 测试：`modelRouting`（重写，29 条）/ `modelPicker`（重写）/ `providerPanel` / `modelSwitch` /
  `protocolHost` / `rendererShellModel` / `tuiRender` / `config` / `providerRuntime` /
  `runOverrides` / `commands`。

**新增的四条不变式**（都做过变异验证，报红的是预期那条）：

- `removeModel` 拒绝删除 routing 仍指向的模型——这是被删掉那条 profile 引用检查的正统继承者；
  `renameModel` 同样要把新键写回 routing。
- 迁移只在「三档字面量**且不是**真实模型键」时才动手：用户真有个叫 `fast` 的模型、
  `routing.main: "fast"` 是合法的新式配置，改写它是拿想象中的问题去破坏能跑的设置。
- 模型键解析不了时，picker 行仍然**画出来**并说明原因，而不是丢掉——配置了却选不了的模型必须
  自己解释自己。
- routing 指向已不存在的键时**降级为 `inherit`** 而不是失败，这正是「删模型是可恢复的错误」的依据。

### 4e — 视觉重构（design_guidance 落地）`[x]`

**先于 4d 做**：`design_guidance.md` 描述得最具体的界面（卡片包裹的设置行、右对齐控件）**正是
4d 要建的**。先做 4d 等于把约 400 行设置界面 CSS 内联进 `index.html`，再在 4e 全部重写一遍；
反过来 4e 先立好令牌与 `styles.css`，4d 只是往已有的表里加设置行规则。

- [x] 新增 `src/desktop/renderer/styles.css`（`index.html` 的 606 行内联表**逐字**搬出，再换令牌、
  再改结构，分三步以便回退），`build:desktop` 的 `copy-desktop-assets.mjs` 跟着拷。CSP 的
  `style-src 'self'` 允许外部表。
- [x] 设计令牌按 guidance 的层级：`--surface-base`（外框/侧栏，**最暗**）→ `--surface-canvas`
  （主面板）→ `--surface-card` → `--surface-hover` → `--surface-active`；文本三级 + `--link`；
  语义点缀色五个，**只允许出现在 `color`/`fill`/`border-*-color`，绝不做填充**。明暗阶因此
  **反转**了（旧表里侧栏 `#232323` 比画布 `#1a1a1a` 亮）。
- [x] 结构：`#canvas` 变成 `--radius-lg` + `overflow: hidden` 的嵌套面板，靠 8px 外边距与侧栏分开
  （**间距代替竖线**）；`#surface` / `#queue` / `#suggestions` 从「顶边线 + 底色」改成浮在画布里的
  卡片；共去掉 8 条发丝线；用户消息改成右对齐 `--surface-card` 气泡（`--user` 那个蓝色因此整个
  从调色板里消失）。圆角层级 large/medium/pill。
- [x] **输入区改成胶囊复合框**：左下 `+`、右下「模型 · effort」胶囊、圆形发送按钮。兑现决策 4。
  新增纯模型 `model/composer.ts`（`composerChipView` / `EFFORT_LABELS` / `submitLabel` /
  `insertMentionToken`），复用 `src/config/effort.ts`。**删掉了 `#status-model`**——模型与 effort
  已在胶囊里，状态栏留第二份必然漂移。
- [x] 字体：chrome 用 `--font-ui`（Segoe UI Variable / -apple-system / system-ui / 中文回退）；
  `--font-mono` 显式重声明在 8 个选择器上——决策 3 的六个，**外加** `.transcript .item.tool` 与
  `.tool-progress`（它们承载命令行与工具输出，比例字体下 `git status` 会掉列）。顺手修了 7 处
  `ch` 宽度（`ch` 是字符 `0` 的宽度，换比例字体后全部失准）；`.diff-row .gutter` 保留 `8ch` 并
  **自己声明** `--font-mono`。`lang` 改 `zh-CN`。
- [x] 图标：新增 `dom/icons.ts`，`document.createElementNS` 造 SVG（`el()` 只会 `createElement`，
  HTML 命名空间里的 `"svg"` 什么都不画；`innerHTML` 是硬规则）。换掉 🗑（彩色 emoji，比例字体下
  最扎眼的一处）、⟨⟩、`+`、徽标 `●`。
- [x] 中文化：三个 presentation 模块加**可选** `locale`，默认 `'en'`；新增 `src/runtime/locale.ts`
  与渲染器侧 `model/locale.ts` 的 `UI_LOCALE`（一处拼写，不是十二处 `'zh'` 字面量）。桌面 12 处
  调用点 + 渲染器自有文案（含 `index.html` 的 placeholder 与 aria-label）全部中文。
- [x] 凭据：`test/rendererStyleTokens.test.ts`（12 条）、`test/rendererComposerChip.test.ts`
  （13 条）、`test/desktopBuild.test.ts`（断言 `styles.css` 被拷贝，**并按 HTML 里的相对引用反查**，
  以后新增资源漏进 copy 脚本会报红）、三个 presentation 测试各加「zh 用例 + 默认仍是英文」。
  **全量 2096 tests / 41 suites / 2096 pass / 0 fail**（基线 2063）。

**完成注记**：

- **`--accent`（青绿，26 处）不对应任何单个新令牌**，它同时在干五件事，必须按职责拆开：
  品牌/标题/选中文字 → `--text-primary`，光标 → `--caret`，聚焦边框 → `--focus-ring`，
  状态字形与色条 → `--accent-info`，任务勾选 → `--accent-review`，主操作填充 → `--text-primary`
  底 + `--surface-base` 字形。不拆就只是「换了色相的旧界面」。
- **计划里的四层令牌不够，补了第五层 `--surface-hover`**：把旧的 `--bg-input` 与 `--bg-raised`
  并进 `--surface-card` 之后，面板**自身**就是 card，于是面板内行的 hover 变成同色 = 不可见；
  用 `--surface-active` 又会让 hover 与选中不可分。四个状态（底 / 面板 / 悬停 / 选中）本来就需要
  四级以上。
- **`#submit` 是全界面唯一的高对比填充，而且是中性的**：`--text-primary` 底。用点缀色做按钮底
  正是 guidance「95% 中性」要排除的那件事。
- **`locale` 选可选、默认 `'en'`，是被两条既有断言逼出来的**：`test/rewindPresentation.test.ts`
  按**函数身份**断言（只能加参数，不能 fork 或包一层），而 `test/tuiRender.test.ts` 断言 TUI 的
  英文帧。必填参数意味着改约 25 处终端调用点、零收益，且每一处都是把 `'zh'` 打进终端的机会。
  三个测试各加了一条「不传参数仍是英文」——那是 TUI 与静默换语言之间唯一的闸门。
- **`PERMISSION_OPTIONS` / `ENTER_PLAN_OPTIONS` / `EMPTY_PLAN_OPTIONS` 是常量且被用作默认参数值**，
  所以保留为英文常量、旁边加 `…Options(locale)` 函数，而不是改成函数了事。
- **`riskLevel` 与权限来源两个 wire 枚举也要查表**：它们被原样打进副标题，不译的话中文对话框里
  会出现「dangerous - bash safety」。
- **`#composer-attach` 暂时接成「在光标处插入 `@`」**（`insertMentionToken`，含「词中先补空格」
  与「已有 `@` 不重复」两条），因为没有对应的 host 命令；正好接上现成的 `@` 文件补全。留给 4f
  冒烟。
- **4e 未做真机冒烟**——按 todo 原安排整体留给 4f。当前凭据是三组纯函数/源码级用例 +
  `desktopBuild` 的真实 esbuild + 拷贝链路 + `npm run build:desktop` 跑通。
  **Step 3/4 的判据本质上是视觉的，没有任何用例能替代肉眼看一次窗口。**

### 4d — 设置界面 `[~]`

**本期（骨架 + Provider 全套）已完成**；权限 / Agent / 通用+MCP+上下文 三块是禁用的占位分类，
连同它们各自的决策留在 4d-2。

左下角 `⚙ 设置` 或 `Ctrl+,` 进入，占满 canvas（不是 modal），左侧分类 + 右侧卡片分组表单。

**动工前查出的两个事实，它们改变了设计形状**（都亲自核对过）：

- **`reloadSettings()` 会重读配置层**。`src/runtime/bootstrap.ts:143` 是 `await config.load(settings)`，
  所以**未 `save()` 的内存改动会被它抹掉**。每次设置写入的顺序因此被钉死为
  `mutate → config.save() → project.reloadSettings() → 扇出`。顺序反了是**数据丢失**，
  而且回包看起来还是对的——到下一次拉取之前都装作成功。
- **`needsRuntimeRebuild` 只等于 `hooksChanged`**（`bootstrap.ts:141,146`）。provider / model / routing
  的改动它一律返回 `false`。照搬 `reload-settings` 分支的判据会得到一个「存盘了、界面也变了、
  但要重启才生效」的设置屏幕——**在屏幕上与正常工作无法区分**。所以 `refreshAfterConfigChange`
  接收显式的 `rebuild`，而不是读那个标志。

- [x] shell 协议补 `get-settings` / `settings-change` / `rename-session`：**一条命令带一个
  `SettingsChange` 可辨识联合**（`scope` 分卡片、`kind` 分操作），而不是十条命令；zod `.strict()`
  校验，keyed `satisfies` 表 + `_NoSettingsDrift` 保证新增变体按名字失败。
- [x] `WireSettingsSnapshot` 逐字段投影，**apiKey 一律掩码**（新增 `src/config/maskKey.ts`，
  从 `ProviderPanel.tsx` 逐字搬出）。字段名叫 `apiKeyMasked` 而**不是** `apiKey`——
  掩码值因此不可赋值给任何 `SettingsChange` 字段，「把 key 画出来再原样送回」根本编译不过。
- [x] **Provider**：endpoints / models / routing（main / plan / compact / subagent[type] → 具体模型
  或 inherit）全套增删改。复用 `ConfigService` 现成的九个方法 + `save()`；删除时的三条引用检查
  本就在里面，直接让它抛。
- [x] `refreshAfterConfigChange()` 从 `SessionHost` 的 `reload-settings` 分支抽出（`WireReloadSettingsResult`
  逐字节不变，`test/protocolHost.test.ts` 零改动保持绿），由外壳按项目扇出——
  **`reloadSettings()` 每项目一次，不是每 lane 一次**。
- [x] **兑现 4b 推过来的 `rename-session`**：与配置扇出**共用一次** `LaneOccupant` 拓宽
  （`refreshAfterConfigChange` + `refreshSessionMeta`，两个都是必需成员）。
  `SessionController` 加了轻量的 `refreshSessionMeta`（**带 id 断言守卫**，永远不能变成绕过
  `sessionSwitch.ts` 的后门），而不是用 `retarget`——后者会 interrupt 并清掉 usage / 工具进度 /
  checkpoint，为一个标题不值当。
- [x] 渲染器：纯模型 `model/settings.ts` + `dom/settingsView.ts` + 新增 `dom/controls.ts`
  （`button()` 从 `sidebarView.ts` 上移，加 `textField` / `selectField`）；`dom/icons.ts` 加 `gear`；
  `index.html` 加一个 `#settings`；`styles.css` 加设置行规则（**没有新增 `:root` 令牌**）。
- [x] 凭据：`test/rendererSettingsModel.test.ts`（35 条）、`test/settingsPersistence.test.ts`
  （9 条，真 `ConfigService` + 临时目录）、`test/desktopShellHost.test.ts`（30 → 47）、
  `test/protocolHost.test.ts`（+3）。**全量 2160 tests / 2160 pass / 0 fail**（基线 2096）。

**完成注记**：

- **`runSidebarIntent` 的陷阱已经堵死，不再是记账项**。原来它没有 `default` 也没有 `assertNever`，
  漏一个 case 会编译通过且什么都不做。现在加了 `assertNeverIntent(value: never)`，
  变异验证过：删掉 `open-settings` 那个 case，`tsc` 直接按变体名报错。
- **`ShellLaneProject` 拿 `config` 而不是走 occupant**：一个项目一个 `ConfigService` 却有 N 条 lane，
  走 occupant 等于随便挑一条；而且设置屏幕可以停在一个你并没有在看其 lane 列表的项目上。
  切片只列 `ConfigService` 上**真实存在**的十二个成员——写 `setFallbackModel`（不存在）会打破
  `Satisfied<RuntimeHost, ShellLaneProject>`，这也是 `fallbackModel`/`compactModel` 本期只读的原因。
- **`as unknown as` 第六次应验，而且这次两边都点名了**：`desktopMain.test.ts` 的 `createOccupant`
  不是 cast，所以 `LaneOccupant` 拓宽时 tsc 直接报了它；但同文件的 `fakeProject()` 仍是
  `as unknown as ProjectRuntime`，`config` 与 `store.rename` 一声不响，手工补的。
- **变异验证抓到一条「假货在撒谎」，掩码那条用例原本是空的**：`FakeConfig.resolveModel` 当初
  直接返回 `models[name]`，**没有像真的那样把 endpoint 的 `apiKey`/`baseUrl` 折进去**，
  于是把投影换成 `...resolveModel(key)` 的 spread 时用例全绿。把假货改成逐字镜像真实实现之后，
  同一个变异立刻报红。**教训：断言只值它的假货那么多钱**——凡是用例守的是「真实现会做 X」，
  假货就必须真的做 X。
- **四条变异验证都是预期那条报红**（save/reload 顺序、每项目一次 reload、掩码、
  `clearCachedSections`），手工 revert 后一律 grep 过回滚结果。
- **4d 未做真机冒烟**——按原安排留给 4f（第 8 条即本期验收）。当前凭据是纯函数用例 +
  `desktopShellHost` 的端到端往返 + `settingsPersistence` 的真实文件系统 + `build:desktop` 跑通。
  **分类栏布局与 `min-height: 0` 本质上是视觉的，没有任何用例能替代肉眼看一次窗口。**

### 4d-2 — 设置界面剩余三块 `[ ]`

三个坑各自需要一次决策，**已定但未实现**：

- **权限**：新增导出的「写整组」函数，只重写 `settings.local.json` **自己的**条目，仍走
  `writeSettingsAtomic`；继承自用户层/项目层的条目在界面上**只读**。
  理由：`mergeSettings` 把 `permissions.allow/deny/ask` 与所有 `hooks.*` **拼接**，
  把合并结果写回本地层会把上层条目复制一份进来。`settings.ts` 今天只有「追加单条」
  （`persistPermissionRule`），`writeSettingsAtomic` 与 `loadSettingsFile` 都未导出。
- **`agent.contextManagement`**：在 `bootstrap.ts:168` 被快照进 `scopeDeps`，`reloadSettings()`
  够不到，改完对**已开的 scope 无效**。六个数值在界面上标注**「重启后生效」**，不接重建路径。
- **MCP**：补真正的热重连（`src/mcp.ts` 的 `refreshMcpServerTools` / `connectManagedMcpServer`）
  + 信任开关。`trustMcpServerLocally` 只会追加、没有 untrust，`McpServerConfig` 完全没有写入 API，
  而且连接只在 bootstrap 发生一次——没有热重连的开关到下次启动前都是死的。
- **Agent**：`ProjectRuntime` 需补 `listAgentDefinitions()`（今天只有 `reloadAgentDefinitions()`
  返回计数）。展示 type/description/tools/permissionMode **只读**；可编辑的是它们的 routing
  与「重新加载」。
- 三块的界面骨架已经在那儿：`LIVE_CATEGORIES` 加一个名字，`SettingsChange` 加一组变体，
  `settingsView` 加一个 `providerCards` 同款的函数即可，**命令、schema、扇出都不用动**。


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
   （4d 已把 Provider 那半做完并有用例；这里要看的是真机上的**视觉**——分类栏布局、
   `min-height: 0` 是否真的让长表单在屏幕内滚动而不是把输入框顶出窗口。权限那半等 4d-2。）
9. [ ] 输入框右下角改 effort → 状态与后续 turn 生效；
10. [ ] 收尾无残留 electron 进程。

### 文档 `[x]`

- [x] `CLAUDE.md` + `AGENTS.md`（逐字镜像）：4a 起改「Electron shell」「The renderer」两节（一个
  窗口 N lane，不再是 window-per-pane）并新增 laneChannel / ShellHost 两段不变式；4b 的 tab bar
  段换成侧栏三段（两个键入口 / 历史与拓扑取并集 / 拉取只挂四个时机），`ShellHost` 段补
  `delete-session` 顺序与 `list-sessions`，新增 `paneBudget` 一段，`Sessions` 一节补
  `removeShadowRepo` 的闸门；4e 的「The renderer」补四段——`styles.css` 的令牌系统与三条源码级
  不变式、胶囊输入框与「胶囊走 `run-command` 而非 `setModel`」、`dom/icons.ts` 的
  `createElementNS`、`locale` 默认 `en` 及其两条约束，`Commands` 一节的测试计数与 copy 清单一并
  更新。用 `diff <(sed -n '4,$p' …)` 验证第 4 行起逐字一致（只有标题与 guidance 行不同）。
- [x] `design_guidance.md` 从「未落地的参考资料」变成 4e 的依据。**它只规定了明暗阶的顺序、圆角
  档位与组件解剖，没有任何十六进制值、px 字号或字体栈**——那套中性深色阶是 4e 造的，现在钉在
  `test/rendererStyleTokens.test.ts` 的「按值」那条用例里。

### 已知缺陷（记账未修）

- **3e 遗留两条**：① **代码块没有语法高亮** —— TUI 用的 `cli-highlight` 出 ANSI 且是
  Node 侧的，浏览器侧要另选一个能进 renderer bundle（无 Node 依赖）的库，独立一档；
  ② `markdownNode` 每次重建整棵子树、`transcriptView` 每 token 全量重画 —— 解析有
  LRU 兜着，**建节点没有**。真机上长会话流式若卡，按 `transcriptView` 文件头写的那条路
  走（按 item id 建 key 增量更新），不要回头去搞 static/live 分区。
- **`.myagent/shadow-git/<id>` 在删会话时泄漏** —— ~~4b 顺手修~~ **已修**（4b：`removeShadowRepo`，
  带「空 / 含分隔符 / 含 `..` 一律抛错」的闸门，因为那个 id 是从线上来的且直通 `rm -r`）。
- **其余 `"latest"` 依赖**（`tsx`、`zod`、`openai` 等）未钉版本；它们不参与 emit，
  要清理另开一条。
- **`PaneSession` 有四个成员已无人调用**：`panes` / `refreshPanes`（4a 起就死了——tab bar 换成
  `shellClient.getLanes()` 之后没人读）、`ownProjectRoot` / `isActive`（4b 死的，侧栏改从
  `WireLaneInfo` 与 activeLane 推）。无害（`onPanesChanged` 那条订阅仍会触发 `onShellChanged`，
  正是侧栏要的重绘）。**4e 动了 `paneSession.ts` 却没顺手收掉**；4d 也没有——删成员是独立的
  一次改动，不该混进设置改动里。留给 4d-2 或任何一次单独提交。
- ~~**`runSidebarIntent` 没有 `default` 也没有 `assertNever`**~~ **已修**（4d：加了
  `assertNeverIntent(value: never)`，变异验证过——删掉一个 case，`tsc` 按变体名报错）。
- **`Ctrl+W` / 侧栏关闭不检查 `blocked`**，而 LRU 驱逐是**绝不**碰有未答阻塞请求的 pane 的
  （`paneBudget.isPinned`，理由是 teardown 会以**拒绝**收尾、静默失败用户的工具调用）。
  两者机制相同但情境不同：驱逐用户没要求，`Ctrl+W` 是用户明确要求。要做得更好得加个确认，
  是新范围——记账未做。
- **`SessionStore.list()` 用 `localeCompare` 排 ISO 串**（`sessions/service.ts`），比 `<` 慢约两个
  数量级。本来只在 `/resume` 时跑一次，4b 之后每个 turn 结束都跑一次。先存后续。
- **`sidebarRenderSignature` 是字符串比较**，行数极多时 O(rows) 建串。比重建 DOM 便宜几个数量级，
  够用；真要更进一步是按 item id 做增量行更新（与 `transcriptView` 那条同一条路）。

---

## 决策留痕（只留 `CLAUDE.md` 未覆盖的）

- **4b：侧栏的两个键入口必须分开**。全局那个（`sidebarChordToIntent`）在 `resolveKey` **之前**解析，
  所以不带 ctrl/meta 必须恒返回 `'none'`——这是 4a 那条陷阱的直接延续。侧栏聚焦那个
  （`sidebarKeyToIntent`）挂在容器上，方向键/Enter 因此不会从 composer 手里抢走。合成一个入口
  就必然要么让方向键全局生效，要么给 `resolveKey` 加一档。
- **4b：分组的 `own` 语义变了，不是照搬**。旧 tab bar 里 `own` 决定「能不能关」，所以
  `ownProjectRoot === undefined` 解释成「全部是自己的」；侧栏里 `own` 只决定**组的顺序**，
  把每组都置顶等于都不置顶，所以 undefined 解释成「都不是」，线上顺序原样保留。
  只有**跨项目**切换才会重排，同项目内列表永不动。
- **4b：徽标不新增 wire 字段是可行的**，`getSnapshot().isStreaming` + `shellState().hasOverlay`
  就够（后者是「有阻塞请求被画着**或**停着」，背景 pane 也照样折进自己的队列）。
  代价是 `onShellChanged` 要给**每个** pane 重绘侧栏，不能再只在 `isActive()` 时重绘。
- **4b：盘上拉取只挂四个时机**（启动 / `lanes` 事件 / 某 pane 的 `isStreaming` **下降沿** /
  删除之后），绝不挂 snapshot tick——`onShellChanged` 由 `client.subscribe()` 驱动，一个 turn 里
  会响多次。下降沿是「标题 / `messageCount` / `updatedAt` 刚动过」的唯一便宜信号。
- **4b：驱逐宁可超额也不杀正在跑的**。`selectEvictions` 在「剩下的全 pinned」时返回**不足数**。
  多留一个常驻 pane 只花内存；驱逐一个停着提示的 pane 会让它的 bridge 以**拒绝**收尾，
  用户的工具调用于是静默失败——比超额糟得多。
- **4b：`removeShadowRepo` 的参数闸门不是洁癖**。`delete-session.sessionId` 是线上字符串，
  直通一次 `rm(recursive)`；`''` / `'..'` / 带分隔符都会解析到 `.myagent/shadow-git` 本身。
  同理调用方必须传 `store.resolve()` 之后的 id：`store.delete` 认前缀，`removeShadowRepo` 不认。
- **4b：`as unknown as` 又应验一次（第五次）**。`ShellLaneProject.store` 加 `list`/`delete` 后，
  `desktopShellHost.test.ts` 的 `implements` 假货被 tsc 按名字点出来了；而
  `desktopMain.test.ts` 的 `fakeProject()` 是 `as unknown as ProjectRuntime`，一声不响。
  手工补上了那两个成员。
- **4a：`ShellHost` 的泛型默认值陷阱**：约束 `W extends ShellLaneWorkspace<PaneT>` 引用了
  前面的类型参数，而类型参数的**默认值**在 `PaneT` 未解算时就要满足约束——`SessionWorkspace`
  只有在 `PaneT` 已知为 `SessionPane` 时才代入，写不成默认值。解法：默认值写结构切片
  `ShellLaneWorkspace<PaneT>`，main.ts 显式写全三元组
  `new ShellHost<RuntimeHost, SessionPane, SessionWorkspace>(…)`。`PaneT` 必须单列：occupant
  工厂要真 pane 的 controller/runtimeSlot/scope，`PaneLike` 会把它们抹掉，逼出 cast。
- **4a：close-pane 是自毁命令，reply 天然丢失**：lane 的 host 在 `onPaneClosed` 里被
  `detachLane` → `occupant.dispose()` 自毁，`mux.closeLane` 的控制帧先于 reply 发出，reply 落进
  已关闭信道被丢弃。渲染器的 pending 由 lane close 触发 `failAllPending('The host
  disconnected')` 吸收——与旧「窗口销毁时 in-flight 命令」同形。测试里表现为
  `assert.rejects(/disconnected/)`，生产里 `/exit` 路径的 catch 只 note 一下（pane 已销毁，无害）。
- **4a：渲染器初始化一律拉取**：Electron 会丢弃 preload 监听器注册前投递的 IPC，所以
  renderer 启动只信 `shellClient.panes()` 拉取 + 之后的 `lanes` 事件，不信任何早期推送；
  main 侧先建 lane 后 loadFile 的时序因此只是便利而非正确性依赖。laneChannel 的有界缓冲
  兜住「main 建 lane 早于 renderer `lane(key)`」的窗口。
- **4a：`deactivate()` 清绘制不清状态**：单例面板（overlay/rewind/surface/suggestions/队列条）
  上一个 pane 的 paint 若不清，切 pane 后会画着别人的对话框，而键盘路由只认 active pane——
  画着却不可应答的对话框是陷阱。状态留在 paneSession 里，`activate()` 一次性重绘回来。
- **4a：tab bar 的 `ownProjectRoot` 恒传 `undefined`**：`model/tabBar.ts` 里 undefined ⇒ 全部
  own ⇒ 全部 closable——单窗口下每行都有自己的 lane client 能关自己的 pane（包括跨项目行，
  旧「focus-only」的存在理由是别的 window 的 host 够不着，lane 化后不成立）。分组仍按
  pane.projectRoot 生效。**4b 已用侧栏整套替换了 tabBar 模型**，`own` 的语义随之改变（见上）。
- **4a：darwin 最后一个 lane 关掉保留空窗口**（非 darwin 照旧 quit）。行为变化、一行可回退；
  空窗口的侧栏仍显示「+ 新建会话 / 打开项目…」（4b 起由 `SidebarView.isEmpty` 与
  `hasNewSession` / `hasOpenProject` 决定），这正是当初留它的用处。
- **`ToolRegistry.refresh()` 把 Agent 工具移到数组末尾是对的，不要"修"**：新建 runtime 恒为
  `buildRuntimeTools()` + `push(agentTool)`，refresh 重现该顺序，「MCP 重连过的 runtime」与
  「新建的」工具数组才逐位相同 —— 工具顺序是 prompt 缓存键的一部分。
- **`createRuntime` 里 `onActiveSessionChange?.(id)` 放在所有会抛的校验之后**：模型 key 无效时
  不能已经把会话级状态切过去。
- **配置串校验**：名字拼错时 `resolveModelReference` 返回 `undefined` 与「没配置」无法区分
  而被静默忽略 —— 已改为校验原始配置字符串，`fallbackModel`/`compactModel` 出
  `RuntimeDiagnostic` 警告而不拦启动。4c 的三档迁移沿用了这条（`checkLegacyModelTiers`
  就挂在 `checkOptionalModelReferences` 旁边）。
- **4c：`as unknown as` 的正解在这里也适用**。`buildModelPickerOptions` 的入参从
  `ConfigService` 收窄成结构化的 `ModelPickerConfig`（只含它真读的三个成员），
  测试就能传普通对象、不需要任何 cast，而约束仍然检查假货 —— 与 `ProjectDirectory`
  用泛型那条同源。给别的「只读几个成员」的函数推这个手法。
- **main.ts 的窗↔pane 簿记（3d，3j 改过一次；4a 将改为 lane↔pane）**：键必须是**不随
  `/clear`、`/resume` 移动**的那个。`onPaneClosed` 原本闭包到自己的 `entryWindow`，
  理由写的是「回调拿到的 `paneId` 是 host 视角的**当前**会话 id，与开窗时的键从来对不上」
  —— 前半句对，**结论错**：按 `paneId` 线性扫 `pane.getSession().id` 就能找到，而闭包到自己
  意味着一个渲染器关别人的标签会关错窗口。
- **App.tsx「先定义后 `useCommands`」惯例**：传进 `useCommands({…})` 的 handler 必须定义在
  调用之前（TDZ），不加 ref 间接层。
- **3j 的四个决策**：① 一个项目的最后一个窗口关掉就 `shutdown` 它（否则 MCP 子进程和后台任务
  留在没有 UI 能停它的进程里；重开只是一次 bootstrap，几百 ms）；② 入口是「Open project…」
  按钮 + `Ctrl+Shift+O`，不做原生 File 菜单（决策进 `model/` 就能被纯函数测到）；
  ③ 别的项目的标签**只能聚焦、不给关闭按钮**；④ 跨项目一律走 shell 旁挂命令，
  **没有**给 `open-pane` 加 `projectRoot`。
- **`ProjectDirectory` 用泛型而不是 `as unknown as`**：默认类型参数给外壳完整的
  `RuntimeHost`/`SessionWorkspace`，测试写 `new ProjectDirectory<FakeProject, FakeWorkspace>()`
  就不需要任何 cast，约束仍然检查假货有没有被真正调用的那几个成员 —— 这是
  「`as unknown as` 关掉的正是编译器唯一能抓 API 谎言的机会」那条经验的正解，
  值得往别的假货上推（4a 的 `ShellHost` 测试就用它）。

---

## 工作方法（本项目的验收惯例）

- **变异验证**：每加一条不变式，就把 bug 逐个塞回去，确认是**预期的那条**用例报红
  （已用它证伪过多条文档断言，如「没有 `default` 分支就能强制穷尽」实测是假的）。
  **手工 patch/revert 要 grep 回滚结果**：3j 两次「以为改回去了」实际没匹配上
  （mutation 只删了调用行，注释留着，revert 的搜索串就对不上了），是全量跑变红才发现的。
- **断言只值它的假货那么多钱**（4d 新增）：变异验证抓到 `get-settings` 的掩码用例原本是**空的**——
  `FakeConfig.resolveModel` 直接返回 `models[name]`，没有像真的那样把 endpoint 的 `apiKey`
  折进去，于是「把投影换成 `...resolveModel(key)`」这个真实泄漏 bug 一路全绿。
  凡是用例守的是「真实现会做 X，所以我们必须防着 X」，**假货就必须真的做 X**，
  否则守的是一个不存在的世界。
- **真机冒烟先怀疑驱动，再怀疑 app**：3j 的冒烟卡了四轮，三轮都是 CDP 驱动自己的问题 ——
  ① 每步重新 attach/detach 一个 DevTools session 会和浏览器自己的簿记打架（改成一窗一 socket
  全程持有）；② 让窗口关闭自己的 pane 时不能 `await` 那个 evaluate 的回包；
  ③ 「我的标签」要按 `.active` 找。判据：**先在没有 CDP 的情况下复现**，再拿
  `git worktree` + node_modules junction 建一份 HEAD 基线对照。
  `Target.setDiscoverTargets` 会让新窗口的渲染器不启动，别开它。
- **测的实现必须就是出货的实现**：renderer channel 曾有测试/出货两份，main 侧工厂的两处
  API 谎言被专门写的 mock 一路放行。
- **`as unknown as` 关掉的正是编译器唯一能抓 API 谎言的机会** —— 已四次应验：2b-2 三个开机
  即死 bug；3h 假 controller 的 `usage.total: null`；3i 五个假 project 拿掉 `commands` 字段后
  25 条全绿。给 `ProjectRuntime` 加字段必须手动 grep 五处假货，`tsc` 帮不上忙。
- **`test/protocolChildProcess.test.ts` 的 host 侧脚本是字符串**（写进临时 `.mjs`），
  `tsc` 看不见 —— 改 `SessionHost` 构造 deps 必须手动同步（3a、3b 各踩一次，
  3b 那次连全量跑都没红）。这也是 `SessionHostDeps` 里几个成员**故意是可选**的原因。
- **负向断言要给异步留时间预算**（`givePumpAChance()` 150ms）：`pumpQueue` 脱钩、`dequeue`
  还要落盘，紧跟 enqueue 就断言「什么都没发」测的是竞态不是闸门。
- **被测行为的差别在持久化侧时，断言不能只站在 wire 上**：`/clear` 的 `migrateTo` 与
  「什么都不做」协议层完全同形，用例得读新会话日志里的 enqueue 记录与旧会话日志里的补偿 `clear`。
- **provider 回调里抛的断言会被摘要路径吞掉**，浮上来的是另一个外层断言 —— 按报错行找会找错地方。
- **`protocolClientParity` 的 COVERAGE 表解析 `tui.tsx` 的 `<App` props 源码**，免费接住新 prop
  （已三次），别绕过它。
- **真机验证走 CDP，不加调试开关**：`electron . --remote-debugging-port=9222` + node 内置
  `WebSocket` 直连，`Runtime.evaluate` 读 DOM、`Input.dispatchKeyEvent` 发真键；
  权限对话框用 `window.hanekawa.send({type:'run-tool', name:'Write', ...})` 零 API 花费触发。
  零侵入探针：`app.ts` 只在 `await client.hello()` 返回后才设 `document.title`。

---

## 验证

```bash
npm run typecheck                                     # 三段：base + preload + renderer
npm run test                                          # 全量，~42s
npm run build                                         # emit 到 dist/（只有桌面外壳需要）
npm run build:desktop                                 # tsc emit + 两个 esbuild bundle + 拷 index.html/styles.css
npm run start:desktop                                 # 真实 Electron，需要桌面
npm run dev:tui                                       # 手动冒烟，需 TTY

# 阶段 4 新增的四组（4a、4b、4e、4d 四组均已全绿）
node --import tsx --test test/laneChannel.test.ts test/desktopShellHost.test.ts
node --import tsx --test test/rendererSidebar.test.ts test/paneBudget.test.ts \
  test/checkpointService.test.ts test/rendererImports.test.ts
node --import tsx --test test/rendererStyleTokens.test.ts test/rendererComposerChip.test.ts \
  test/permissionPresentation.test.ts test/planPresentation.test.ts test/rewindPresentation.test.ts
node --import tsx --test test/rendererSettingsModel.test.ts test/settingsPersistence.test.ts \
  test/desktopShellHost.test.ts test/protocolHost.test.ts    # 4d

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

**已知不稳定**（三条都是**间歇**：既不要因为一次并发跑绿了就认为已修，也不要因为挂了就去找
自己的回归；判据一律是「单独跑是否稳定通过」）：

- `test/toolcall-integration.test.ts`：全量并发跑挂 `Unable to deserialize cloned data due to
  invalid or unsupported version` —— Node test runner 自己的 IPC 报错，不是断言失败；单独跑必过，
  未改动基线上同样复现。**`--test-concurrency=1` 串行也会红** —— 串行不是它的解药。
- `test/backgroundTasks.test.ts` 的 `background Bash returns immediately and BashOutput consumes
  incremental output`：全量并发偶尔超时红一次（用例本身要等真实子进程吐增量输出，1.7s 量级）；
  单独跑 3/3 全绿；与桌面端无交集。
- `test/agentTool.test.ts` 的 `parent bypass mode still takes precedence for background agents`
  （仅观察到一次）：单独跑 81/81 连过两轮，与改动零交集。

**已知环境依赖失败**（3g 查明，与桌面端无关，尚未修）：`test/config.test.ts` 的
`providers report dynamic ToolSearch support conservatively` 在设置了
`CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` 的环境里必定红。它不是间歇、也不是回归：
用例只 save/delete/restore 了 `HANEKAWA_DISABLE_EXPERIMENTAL_BETAS`，而它测的
`isExperimentalToolSearchBetaDisabled()`（`src/utils/toolSearch.ts:132-135`）读的是**两个**
变量的或，第二个还留在环境里。已用 `git stash` 在干净基线复现。修法是让该用例对两个变量
都做隔离（文件里已有 `setEnv` 助手）。

**注意：这条依赖的是环境变量，不是「在 Claude Code 里跑」。** 4b 那次记的是
2063 / 2062 pass / 1 fail；4e 落地后在**没有**设该变量的 shell 里实测
**2096 tests / 41 suites / 2096 pass / 0 fail**。所以看到这条红先 `echo`
一下那两个变量，别当成回归。
