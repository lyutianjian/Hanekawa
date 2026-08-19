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

**进度**：4c 已完成（先做，理由见 4c 一节）。4a / 4b / 4d / 4e / 4f 未开始。

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

### 4a — 信道复用 + 单窗口骨架 `[ ]`

视觉不动，先把「一个窗口 N 个活 pane」跑通。

- [ ] 新增 `src/runtime/protocol/laneChannel.ts`：`createLaneMux(transport)` →
  `{ lane(key), closeLane(key), close() }`。lane 级 close 走**控制帧**，否则
  `SessionClient` 的 pending 请求在对端 pane 消失时永远悬着；未 attach 的 lane
  的入站消息**有界缓冲**。纯函数，用 `createMemoryChannelPair` 在纯 node 下测。
- [ ] 新增 `src/desktop/shellHost.ts` + `shellProtocol.ts`。本期只做
  `panes` / `open-session` / `open-project` 三条。做成 `SessionHost` 同款的类，
  因为 **`main.ts` 一行测试都没有**，凡是决策都必须落在可测模块里；入站同样
  zod `.strict()` 校验 + keyed `satisfies` 表。
- [ ] 改 `src/desktop/main.ts`：只建一个 `BrowserWindow`；`panes` 的键从
  `BrowserWindow.id` 换成 **lane key**（外壳自铸的单调 id，`/clear`、`/resume`
  都不动它——这正是当初选 window id 的理由，现在 lane key 顶上）；
  `openPane` → `openLane`；`detachPane` → `detachLane`，仍是三条消亡路径的唯一出口；
  「最后一个窗口关掉即 shutdown 项目」改为「最后一个 lane 关掉即 shutdown 项目」；
  `before-quit` 顺序不变；`second-instance` 改成「聚焦唯一窗口 + `openProject(cwd)`」。
- [ ] 改 `src/desktop/renderer/app.ts`：抽出 `paneSession.ts`（每 lane 一份
  `{ client, transcript, uiQueue, completions, rewind, draftText, transcriptEl }`），
  `app.ts` 退化为「按 activePane 渲染」+ 一个 `ShellClient`。`dom/*` 本就是
  `render(viewModel)` 的无状态渲染器，可跨 pane 复用；**唯一例外是 transcript**
  ——每 pane 一个 DOM 子树，只切显隐，滚动位置天然保留、切换零重绘。
- [ ] 凭据：`test/laneChannel.test.ts`（lane 关闭释放对端 pending / 未 attach 缓冲 /
  一个 lane 的消息不漏给另一个）、`test/desktopShellHost.test.ts`（真
  `ProjectDirectory` + 假 workspace，沿用 3j 的泛型假货手法，**零 `as unknown as`**）、
  `test/desktopMain.test.ts` 改造成驱动 lane mux。

### 4b — 侧边栏、会话历史、删除 `[ ]`

- [ ] 纯模型 `renderer/model/sidebar.ts`：分组（自己项目在前，`groupRows` 的顺序规则
  从 `model/tabBar.ts` 搬过来并扩成「项目 → 会话」两级）、时间分节、徽标推导
  （`running` / `awaiting-input` 由该 pane 的 `client.getSnapshot()` 与 uiQueue 得出，
  **不新增 wire 字段**）、键盘导航、`Ctrl+B` 折叠。
- [ ] `dom/sidebarView.ts`；删 `dom/tabBarView.ts` / `model/tabBar.ts` 及其测试。
- [ ] shell 协议补 `list-sessions`（跨项目）/ `delete-session` / `rename-session`。
  删除顺序：先关该会话的 lane（若开着）→ `SessionStore.delete()`
  （`sessions/service.ts:515`）→ **新增清理 `.myagent/shadow-git/<id>`**
  （今天泄漏；`checkpointService.ts:52` 是唯一知道该路径的地方，导出一个
  `removeShadowRepo(cwd, sessionId)`）。删除要二次确认。
- [ ] LRU：新增 `src/desktop/paneBudget.ts`（纯函数）。上限 4 个常驻，
  **永不驱逐**「活跃 / 正在跑 turn / 有未答阻塞请求」的 pane。驱逐即 `detachLane`。
- [ ] 凭据：`test/rendererSidebar.test.ts`、`test/paneBudget.test.ts`、
  `test/desktopShellHost.test.ts` 补删除路径。

### 4c — 取消三档模型 `[x]`

破坏性变更，README / CLAUDE.md 都已记一笔。**先于 4a 做**：4c 自足、每步保持全绿，
而且它是 4d/4e 的事实前置——4d 的 Provider 卡片要渲染 routing、4e 的胶囊要显示模型，
按三档做完再拆等于同一块界面做两遍。

- [x] `src/config/routing.ts`：删 `Tier` / `TierOrInherit` / `Profile` /
  `parseTierInput` / `resolveTier`；`Routing` 的值类型变成 `string`（模型键或
  `'inherit'`）；`pickTier` → `pickRoutedModel`；`DEFAULT_ROUTING` 全部改 `'inherit'`。
- [x] `src/config/service.ts`：删 `profiles` / `activeProfile` 与
  `setProfile` / `removeProfile` / `setActiveProfile` / `getActiveProfile` /
  `findTierForModel`；`resolveModelReference` 只认模型键；`resolveModelKeyFor`
  变成「查 routing → 是模型键就用 → 否则 `inherit`/未配 → `defaultModel`」。
- [x] `src/config/settings.ts` 去掉 `profiles`/`activeProfile`，校验补
  「`defaultModel` 必须是 `models` 里存在的键」——**只在 `settings.models` 存在时判**，
  否则 models 只配在 `config.json` 的合法配置会被误报。
- [x] `src/runtime/modelPicker.ts`：`ModelPickerOption.tier` 换成 `key`，
  枚举 `knownModelKeys`。顺手把入参收窄成结构化的 `ModelPickerConfig`，
  测试因此不再需要 `as unknown as ConfigService`（见工作方法里那条）。
- [x] 连带：`modelSwitch.ts`、`providerRuntime.ts`（scope 去掉 `'profiles'`）、
  `runOverrides.ts`、`configTool.ts`、`commands/provider.ts`、`protocol/host.ts`、
  `renderer/model/surfaces.ts`、`ModelPickerDialog.tsx`、`App.tsx`、
  `ProviderPanel.tsx`（删 profiles 页签，routing 页签换成「`inherit` + 模型键」下拉）。
- [x] **迁移**：`ConfigService.load()` 扫原始层，`getLegacyModelFindings()` 暴露；
  `bootstrap.ts` 的 `checkLegacyModelTiers` 转成 `RuntimeDiagnostic` 警告，**不拦启动**。
  三档 routing 值归一成 `'inherit'`，三档 `defaultModel` 落到第一个可解析的模型键。
- [x] 测试：`modelRouting`（重写，29 条）/ `modelPicker`（重写）/ `providerPanel` /
  `modelSwitch` / `protocolHost` / `rendererShellModel` / `tuiRender` / `config` /
  `providerRuntime` / `runOverrides` / `commands`。

**新增的四条不变式**（都做过变异验证，报红的是预期那条）：

- `removeModel` 拒绝删除 routing 仍指向的模型 —— 这是被删掉那条 profile 引用检查的
  正统继承者，不是新增范围；`renameModel` 同样要把新键写回 routing。
- 迁移只在「三档字面量**且不是**真实模型键」时才动手：用户真有个叫 `fast` 的模型、
  `routing.main: "fast"` 是合法的新式配置，改写它是拿一个想象中的问题去破坏一个能跑的设置。
  （`resolveModelInput` 一直就是按「模型键优先」解这个歧义的。）
- 模型键解析不了时，picker 行仍然**画出来**并说明原因，而不是丢掉——配置了却选不了的
  模型必须自己解释自己。
- routing 指向一个已不存在的键时**降级为 `inherit`** 而不是失败，这正是「删模型是可恢复的
  错误」的依据。

### 4d — 设置界面 `[ ]`

左下角 `⚙ 设置` 进入，占满 canvas（不是 modal），左侧分类 + 右侧卡片分组表单。

- [ ] shell 协议补 `get-settings` / `settings-change`：**一条命令带一个
  `SettingsChange` 可辨识联合**，而不是十条命令；zod `.strict()` 校验，
  keyed `satisfies` 表保证新增变体按名字失败。
- [ ] `WireSettingsSnapshot` 逐字段投影，**apiKey 一律掩码**——`resolveModel` 会把
  endpoint 的 key 折进返回值，一次 spread 就把用户所有 key 送进渲染器。
  （`ProviderPanel` 的 `maskKey` 搬到共享处。）
- [ ] **Provider**：endpoints / models / routing（main / plan / compact /
  subagent[type] → 具体模型或 inherit）。复用 `ConfigService` 现成的
  `setEndpoint` / `removeEndpoint` / `setModelConfig` / `removeModel` /
  `renameModel` / `setRouting` / `setDefaultModel` + `save()`；删除时的三条引用
  检查本就在里面。
- [ ] **权限**：启动模式 + allow/deny/ask 三组规则增删改。`settings.ts` 现在只有
  「追加单条」（`persistPermissionRule`），需补一个导出的「写整组」函数，仍走
  `writeSettingsAtomic` 落 `.myagent/settings.local.json`。
- [ ] **Agent**：列出 `AgentDefinitionLoader.list()`（内置四个 + 自定义），
  展示 type/description/tools/permissionMode，**只读**；可编辑的是它们的 routing
  与「重新加载」。`ProjectRuntime` 需补 `listAgentDefinitions()`（今天只有
  `reloadAgentDefinitions()` 返回计数）。
- [ ] **通用 + MCP + 上下文**：autoCompact 阈值、cache ttl1h、
  `agent.contextManagement` 六个数值、MCP server 列表与信任开关。
- [ ] 配置改完要让**同项目每个 pane** 的 runtime 重建：`SessionHost` 的
  `reload-settings` 分支已经是这套动作，抽成公开方法 `refreshAfterConfigChange()`，
  由外壳扇出——与 `onPaneListChanged` 完全同构。
- [ ] 凭据：`test/rendererSettingsModel.test.ts`、`test/desktopShellHost.test.ts`
  补 settings 往返、`test/settingsPersistence.test.ts`。

### 4e — 视觉重构（design_guidance 落地）`[ ]`

- [ ] 新增 `src/desktop/renderer/styles.css`，`build:desktop` 跟着拷。现在 500 行 CSS
  内联在 `index.html` 里，翻倍后不可维护；CSP 的 `style-src 'self'` 允许外部表。
- [ ] 设计令牌按 guidance 的四层：`--surface-base`（外框/侧栏）、`--surface-canvas`
  （主面板）、`--surface-card`（卡片/输入框）、`--surface-active`（选中/胶囊）；
  文本三级 + 链接色；语义点缀色**只用于图标与开关**。
- [ ] 结构：侧栏（固定宽，顶部标识+新建 / 中部分组 / 底部设置）+ 主画布包成
  12–16px 大圆角面板；圆角层级 large/medium/pill；设置行 = 左标题+说明 / 右控件。
- [ ] **输入区改成胶囊复合框**：左下 `+`，右下「模型 · effort」标签胶囊
  （走现有 `list-models` / `set-effort`）+ 圆形发送按钮。兑现决策 4。
- [ ] 字体：chrome 用 `Segoe UI Variable / -apple-system / system-ui`；
  `.md .md-code`、`.diff`、权限对话框的命令块与 diff **保持等宽**（必须逐字读）。
- [ ] 图标：`dom/icons.ts` 用 `document.createElementNS` 造 SVG——`dom.ts` 的 `el()`
  只会 `createElement`，而**禁用 `innerHTML` 是硬规则**。
- [ ] 中文化：`runtime/permissionPresentation.ts` / `planPresentation.ts` /
  `rewindPresentation.ts` 加 `locale: 'zh' | 'en'` 参数，字面量提成查表；
  桌面传 `zh`、TUI 传 `en`。`test/rewindPresentation.test.ts` 按**函数身份**断言，
  所以只能加参数、不能复制一份。渲染器自有文案直接写中文。
- [ ] 凭据：`test/rendererStyleTokens.test.ts`（源码级断言：视图只用语义变量、
  不出现十六进制字面量——与 `test/tuiTheme.test.ts` 同款手法）、三个 presentation
  测试补 zh 用例。

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
9. [ ] 输入框右下角改 effort → 状态与后续 turn 生效；
10. [ ] 收尾无残留 electron 进程。

### 文档 `[ ]`

- [ ] `CLAUDE.md` + `AGENTS.md`（逐字镜像）：改「Electron shell」「The renderer」
  两节（一个窗口 N lane，不再是 window-per-pane），新增 laneChannel / ShellHost
  两段不变式。~~`Providers` 一节删掉三档路由的描述~~（4c 已做，两文件已用 diff 验证仍逐字一致）。
- [ ] `design_guidance.md` 从「未落地的参考资料」变成 4e 的依据。

### 已知缺陷（记账未修）

- **3e 遗留两条**：① **代码块没有语法高亮** —— TUI 用的 `cli-highlight` 出 ANSI 且是
  Node 侧的，浏览器侧要另选一个能进 renderer bundle（无 Node 依赖）的库，独立一档；
  ② `markdownNode` 每次重建整棵子树、`transcriptView` 每 token 全量重画 —— 解析有
  LRU 兜着，**建节点没有**。真机上长会话流式若卡，按 `transcriptView` 文件头写的那条路
  走（按 item id 建 key 增量更新），不要回头去搞 static/live 分区。
- **`.myagent/shadow-git/<id>` 在删会话时泄漏** —— 4b 顺手修。
- **其余 `"latest"` 依赖**（`tsx`、`zod`、`openai` 等）未钉版本；它们不参与 emit，
  要清理另开一条。

---

## 决策留痕（只留 `CLAUDE.md` 未覆盖的）

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
npm run test                                          # 全量，~48s
npm run build                                         # emit 到 dist/（只有桌面外壳需要）
npm run build:desktop                                 # tsc emit + 两个 esbuild bundle + 拷 index.html/styles.css
npm run start:desktop                                 # 真实 Electron，需要桌面
npm run dev:tui                                       # 手动冒烟，需 TTY

# 阶段 4 新增的三组
node --import tsx --test test/laneChannel.test.ts test/desktopShellHost.test.ts \
  test/paneBudget.test.ts
node --import tsx --test test/rendererSidebar.test.ts test/rendererSettingsModel.test.ts \
  test/rendererStyleTokens.test.ts

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
`CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` 的环境里必定红（在 Claude Code 里跑 `npm run test`
就是这种环境）。它不是间歇、也不是回归：用例只 save/delete/restore 了
`HANEKAWA_DISABLE_EXPERIMENTAL_BETAS`，而它测的 `isExperimentalToolSearchBetaDisabled()`
（`src/utils/toolSearch.ts:132-135`）读的是**两个**变量的或，第二个还留在环境里。已用
`git stash` 在干净基线复现。修法是让该用例对两个变量都做隔离（文件里已有 `setEnv` 助手）。
**这种环境下应当只有这一条红**（3j 落地后实测 1988 pass / 1 fail）。
