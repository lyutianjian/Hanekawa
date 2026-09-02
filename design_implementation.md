# Hanekawa 桌面端改版 · 技术实施文档

> 输入是 `design_guidance.md`（2026 改版设计方案）。本文只回答**怎么做**：技术选型、拆分到单次
> agent 会话的任务、每个任务的验收命令。设计意图不在此重复，需要时按章节号回查设计文档。
>
> 任务粒度约定：一个任务 = 一次 agent 会话能读完相关文件、改完、跑完它自己那条验收命令。
> 任务之间只允许**单向前置**（后一个依赖前一个），不允许并行改同一个文件。
>
> 进度标记：每个任务前的 `[ ]` 在验收命令跑通后改成 `[x]`；只跑完改动、没跑验收命令的不算完成。完成后都要commit修改以便管理仓库。

---

## 〇 与设计文档的三处偏离（先拍板，后面全部按这里写）

| # | 设计文档写的 | 实施采用 | 原因 |
| --- | --- | --- | --- |
| 1 | 字号 token 叫 `--text-display/-title/-body/-ui/-meta/-micro/-code`（三.3） | 改叫 **`--type-*`**：`--type-display/-title/-body/-ui/-meta/-micro/-code` | `--text-` 是 `rendererStyleTokens.test.ts` 里**中性色**组的前缀（`NEUTRAL_PREFIXES`）。虽然分类循环会 `continue` 掉非 `#` 开头的值、当下不会红，但从此 `--text-*` 这个命名空间同时装颜色和字号，任何一次收紧分类断言都会炸。换前缀成本为零 |
| 2 | 七.4 说复核 `--font-code` 白名单 | 实际 token 是 **`--font-mono`**，白名单是 `MONOSPACED` 选择器数组 | 仓库里没有 `--font-code`。新增的是字号 token `--type-code`，与 `MONOSPACED` 正交，该数组本期不动 |
| 3 | 亮色块选择器写作 `[data-theme="light"]` | 实际是 **`:root[data-theme="light"]`** | 测试里 `LIGHT_SELECTOR` 常量逐字匹配，扁平解析器不做选择器归一化 |

另有一条设计文档已经说明、这里再钉一次的事实：`--shadow-modal` 是**主题相关**的（亮暗两个值），
所以它进亮色块、且**不得**出现在测试的 `THEME_INDEPENDENT` 列表里；`--space-*`、`--radius-*`、
`--motion-*`、`--ease-*`、`--type-*`、`--font-*` 全部主题无关，必须进 `THEME_INDEPENDENT`。

---

## 一 技术选型

### 1.1 字体：npm 取源 + 入库自持，不在构建期解析 node_modules

| 决策点 | 选择 | 理由 |
| --- | --- | --- |
| 字体来源 | `@fontsource-variable/inter`、`@fontsource-variable/source-serif-4`、`@fontsource/jetbrains-mono`，装为 **devDependency** | Fontsource 已按 `unicode-range` 切好 `latin` / `latin-ext` 子集并提供 woff2，不需要自己跑 `pyftsubset`，也就不需要给仓库引入 Python 工具链 |
| 落盘方式 | 由一次性脚本从 node_modules 拷进 **`src/desktop/renderer/fonts/`（入库、纳入 git）** | `copy-desktop-assets.mjs` 是一个纯拷贝脚本，构建期不解析依赖树；字体入库后离线可构建、`npm ci` 失败也不会产出无字体的窗口。字体是资产不是依赖 |
| 文件清单 | Inter Variable `latin` + `latin-ext`（2）、Source Serif 4 Variable `latin` + `latin-ext`（2）、JetBrains Mono 400/500 `latin` + `latin-ext`（4），共 **8 个 woff2**，预计 400–600KB | 可变字重两个文件覆盖 400/500/600，比三份静态字重小；JetBrains Mono 无可变版，取两个静态字重 |
| 声明位置 | 新建 **`src/desktop/renderer/fonts.css`**，`index.html` 单独 `<link>` | `styles.css` 的扁平解析器只放行 `@keyframes` 与末尾那条 `prefers-reduced-motion`，`@font-face` 进去必红（七.5） |
| 加载策略 | 全部 `font-display: swap`；对 Inter Variable `latin` 与 Source Serif 4 Variable `latin` 各加一条 `<link rel="preload" as="font" type="font/woff2" crossorigin>` | 首屏（欢迎页大标题 + 侧边栏）同时用到无衬线与衬线 |
| CSP | 不改 | `default-src 'self'` 已覆盖 `font-src`，字体与页面同源同盘 |

`fonts.css` 不得含任何 `:root`/token 声明——它只有 `@font-face`。字体栈 token（`--font-ui` /
`--font-serif` / `--font-mono`）仍留在 `styles.css` 的 `:root`，由 `rendererStyleTokens` 钉死。

### 1.2 资产拷贝：清单从「逐文件」升为「文件 + 目录」

`scripts/copy-desktop-assets.mjs` 保留现有的 `[from, to]` 数组语义，增加一个 `directories` 数组，
用 `node:fs` 的 `cpSync(from, to, { recursive: true })`（Node 22 原生，无新依赖）。
`destRoot` 可重定向的现有契约不变（`desktopBuild.test.ts` 构建到临时目录）。

### 1.3 CSS 组织：不引入预处理器、不引入 CSS-in-JS

`styles.css` 仍是**一份手写扁平表**。理由是 `test/helpers/rendererCss.ts` 的解析器就是这份表的
类型系统：任何构建期 CSS 工具都会让「token 是被断言钉死的决定」这条机制失效。间距/圆角/字号
统一走自定义属性，就是本项目的「预处理器」。

### 1.4 侧边栏折叠：三态枚举 + `transitionend` + 兜底定时器

不引入动画库。`sidebarView` 的折叠状态从 `boolean` 升为
`'expanded' | 'collapsing' | 'collapsed' | 'expanding'` 四态（设计文档五.2 的「视觉折叠中」中间态）：

- 状态迁移由视图自己驱动，`transitionend`（监听 `flex-basis`，`event.target === #sidebar` 才认）
  推进，外加一条 `--motion-slow` 时长 + 60ms 余量的 `setTimeout` 兜底（`transitionend` 在标签页
  不可见、动画被 `prefers-reduced-motion` 压到 1ms 等情况下不可靠）。
- 定时器与监听器必须在下一次迁移开始时清理，避免迟到的回调把刚展开的侧边栏又卸掉。
- 该状态必须进 `sidebarRenderSignature`（`renderer/model/`），否则渲染守卫会吞掉中间帧。
- 分组展开/收起改 `grid-template-rows: 0fr → 1fr` + `overflow: hidden`，纯 CSS，不动 TS 状态。

### 1.5 测试与验证工具：沿用现状

`node:test` + `test/helpers/rendererCss.ts` + `test/helpers/domStub.ts`，不新增测试框架。
真机验证只有 `npm run smoke:desktop`（需要显示器与凭据；它会碰标题栏高度并负责恢复开发者的主题偏好）。

对比度这件事**不引入运行时依赖**：在 `rendererStyleTokens.test.ts` 里加一个本地 `contrast()`
纯函数（已有 `luminance()`，补一个 `(L1+0.05)/(L2+0.05)` 即可），把设计文档二.2 的对比度承诺
变成断言——这是防止后人把 `--accent-brand` 拿去当正文色的唯一机制。

---

## 二 阶段与任务

四期对应设计文档八。**每期最后一个任务是该期的收口验证**，不要把验证摊进每个任务。

### P1 — 换皮（token + 字体 + 窗口色），零 DOM 改动

| 任务 | 内容 | 产出文件 | 验收 |
| --- | --- | --- | --- |
| [x] **P1-1** 字体入库 | 装三个 fontsource devDependency；写一次性脚本或手工把 8 个 woff2 拷入 `src/desktop/renderer/fonts/`（保留 fontsource 的文件名，便于日后升级比对）；新建 `fonts.css` 写 8 条 `@font-face`（含 `unicode-range`、`font-display: swap`、可变字体的 `font-weight: 400 600` 区间）；`index.html` 加 `<link rel="stylesheet" href="./fonts.css">` 与两条 preload | `package.json`、`src/desktop/renderer/fonts/*`、`fonts.css`、`index.html` | `node --import tsx --test test/rendererStyleTokens.test.ts`（确认 `styles.css` 未被污染、html 断言仍过） |
| [x] **P1-2** 构建管线带上字体 | `copy-desktop-assets.mjs` 支持目录拷贝，清单加 `fonts.css` 与 `fonts/`；`desktopBuild.test.ts` 断言 `<dest>/desktop/renderer/fonts.css` 与至少一个 woff2 存在 | `scripts/copy-desktop-assets.mjs`、`test/desktopBuild.test.ts` | `node --import tsx --test test/desktopBuild.test.ts` |
| [x] **P1-3** 调色板换血 | 按设计文档二.2/二.3 重写 `styles.css` 的 `:root` 与 `:root[data-theme="light"]`：新增 `--accent-brand`、`--accent-brand-strong`、`--on-brand`、`--font-serif`；删除 `--surface-wash-warm`/`--surface-wash-mint`；`body` 背景退化为单一 `--surface-base`；diff 四色换暖纸系；`--shadow-modal` 新增（亮暗两值）。**同一次会话内**同步 `rendererStyleTokens.test.ts` 的钉死表（两份）、`THEME_INDEPENDENT`、中性/色度分类（`--on-brand` 归中性、两个 brand 归色度） | `styles.css`、`test/rendererStyleTokens.test.ts` | `node --import tsx --test test/rendererStyleTokens.test.ts test/rendererTheme.test.ts` |
| [x] **P1-4** 字体栈落地 + 对比度守卫 | `--font-ui`/`--font-mono` 换成含 Inter / JetBrains Mono 的新栈，新增 `--font-serif`；`body` 的 `font` 简写同步；数值类选择器加 `font-variant-numeric: tabular-nums`；`body` 加 `font-feature-settings: "cv05"`。测试侧：钉死表更新三条字体栈，新增 `contrast()` 断言——`--accent-brand-strong` 对 `--surface-canvas` ≥ 4.5、`--on-brand` 对 `--accent-brand-strong` ≥ 4.5、`--accent-brand` 只允许出现在非文本属性 | `styles.css`、`test/rendererStyleTokens.test.ts` | 同上 |
| [x] **P1-5** 窗口色与标题栏高度 | `main.ts` 的 `WINDOW_CHROME` 换新值并 `height: 40`；`styles.css` 的 `#titlebar height: 40px`；`scripts/smoke/steps.mjs` 的 `TITLE_BAR_HEIGHT: 32 → 40`；标题栏右内边距**实测后重钉**（设计文档九.2：在 40px 高度下量 Windows 控制条实际宽度，不要猜） | `src/desktop/main.ts`、`styles.css`、`scripts/smoke/steps.mjs` | `node --import tsx --test test/desktopMain.test.ts` |
| [x] **P1-6** P1 收口 | 跑全套渲染器测试组 + 类型检查 + 烟雾；修 P1-1..5 留下的连带断裂 | — | `npm run typecheck`；`node --import tsx --test test/renderer*.test.ts test/desktopBuild.test.ts`；`npm run smoke:desktop` |

> P1-3 与 P1-4 拆开是因为一次会话同时改颜色和字体，钉死表会有两处大 diff 互相掩盖失败原因。

### P2 — 尺度（间距、圆角、字号），改动面广但逐组件独立

| 任务 | 内容 | 验收 |
| --- | --- | --- |
| [x] **P2-1** 尺度 token 落地 | `:root` 新增 `--space-1..7`、`--radius-sm`、`--type-*` 七级；`--radius-lg 14→20`、`--radius-md 9→12`；`--reading-measure 1100→980`、`--reading-gutter 32→40`。同步钉死表与 `THEME_INDEPENDENT`。**本任务只加 token 与改这几个值，不改任何组件规则** | `rendererStyleTokens` |
| [ ] **P2-2** 窗口框推间距 | 侧边栏 268→280、会话行内边距 `6px 10px → 8px 12px`（行高约 34px）、项目标题行字号/字距、标题栏内部间距，全部换成 `--space-*` / `--type-*` | `rendererSidebarView`、`rendererSidebar`、`rendererCanvasHeaderView` |
| [ ] **P2-3** 对话流推间距 | 轮次间距 16→24、正文 `--type-body`、用户气泡 `--radius-lg` + `12px 16px`、思考块去掉 `opacity: 0.8`、工具行 `--type-code`、文件小胶囊 `--radius-sm`。`.transcript-column { margin-top: auto; flex-shrink: 0 }` **不得**改动 | `rendererTranscriptView`、`rendererUserMessage`、`rendererThinking`、`rendererDiffRows` |
| [ ] **P2-4** 输入区与设置页推间距 | 输入区内边距 `8px 12px → 12px 16px`，`--composer-overhang` 与内边距同步（两处数字一起动）；设置页卡片分隔从边框改 `--space-5` 留白，分区标题上 `--font-serif` + `--type-title` | `rendererComposerView`、`rendererComposerChip`、`rendererSettingsView` |
| [ ] **P2-5** 衬线白名单 + 收口 | 欢迎页/空状态大标题、设置分区标题、`#overlay-panel`/`#rewind-panel` 标题行三处上 `--font-serif`；在 `rendererStyleTokens.test.ts` 加一条断言：`var(--font-serif)` 只允许出现在这三组选择器（白名单数组，带非空性断言，与 `ACCENT_FILL_EXCEPTIONS` 同款写法）。跑全套渲染器测试 | `npm run typecheck` + `test/renderer*.test.ts` |

### P3 — 动效（曲线换代 + 侧边栏折叠三修）

| 任务 | 内容 | 验收 |
| --- | --- | --- |
| [ ] **P3-1** 动效刻度换代 | `--motion-fast 120→140`、`--motion-base 180→220`、`--motion-slow 240→320`、`--ease-standard` 换 `cubic-bezier(0.32, 0.72, 0, 1)`、新增 `--ease-exit`。同步钉死表与 `THEME_INDEPENDENT`。现有「每条 transition 必须引用 motion token 与 ease-standard」的断言需要放宽到「`--ease-standard` 或 `--ease-exit`」 | `rendererStyleTokens` |
| [ ] **P3-2** 折叠状态机（模型层） | 在 `renderer/model/` 内落地四态枚举与迁移函数（纯函数：`(current, wantCollapsed, event) → next`），并进 `sidebarRenderSignature`。**本任务不碰 DOM**，先把决定和它的测试做完 | `rendererShellModel` / `rendererSidebar`（模型侧） |
| [ ] **P3-3** 折叠 DOM 三修 | ①`#sidebar` 内加固定 `width: 280px; flex: 0 0 280px` 的内容壳，外层 `overflow: hidden`；②内容壳跑 `opacity` + `translateX(-8px)`，`show(false)`/停止建行推迟到 `transitionend` 或兜底定时器；③删除 `#sidebar.collapsed + #canvas { margin-left: 8px }`，`#canvas` 常驻 `margin-left: var(--space-2)`。清理定时器与监听器 | `node --import tsx --test test/rendererSidebarView.test.ts`（新增：中间态期间内容仍在 DOM、迁移完成后才卸载、重复切换不泄漏定时器） |
| [ ] **P3-4** 其余动效 | 分组展开改 `grid-template-rows: 0fr → 1fr` + `overflow: hidden` 配 `--motion-base`；`drop-in`/`rise-in`/`slide-in` 位移加到 8px 并加 `scale(0.98) → 1`；`#submit` 按下压暗到 `--accent-brand-strong`。**不加退出动画、主题切换不加过渡** | `rendererStyleTokens`、`rendererSidebarView` |
| [ ] **P3-5** P3 收口 | `prefers-reduced-motion` 那条 `@media` 仍能压住两个 `infinite` 动画且仍是唯一嵌套 at-rule；跑类型检查与烟雾 | `npm run typecheck`；`npm run smoke:desktop` |

### P4 — 组件质感（三条 accent-fill 例外在这里才被用上）

| 任务 | 内容 | 验收 |
| --- | --- | --- |
| [ ] **P4-1** 提交按钮与开关 | `#submit` 改品牌色实心（`background: var(--accent-brand-strong)` + `color: var(--on-brand)` + `--radius-pill`）；`.settings-toggle.on` 底色从 `--accent-info` 改 `--accent-brand`（滑块恒定白）。`ACCENT_FILL_EXCEPTIONS` 从 1 条扩到 2 条 | `rendererStyleTokens`、`rendererComposerView`、`rendererSettingsView` |
| [ ] **P4-2** 当前会话竖条 | `.session-row.active::before` 3px 品牌色圆角竖条，`transform: scaleY()` 从中心展开；`ACCENT_FILL_EXCEPTIONS` 补到 3 条。**会话行 CSS 顺序（`:hover` → `.selected` → `.active` → `.confirming`）是承重优先级，`.open` 仍不得有任何规则** | `rendererSidebarView`、`rendererStyleTokens` |
| [ ] **P4-3** 搜索框与 chip | 侧边栏搜索框改无边框凹槽（`--surface-card` + `--radius-pill`，聚焦加 1px `--focus-ring` 环）；权限 pill 与模型/强度 chip 改无边框 `--surface-card` 胶囊，只在 `:hover`/`.open` 升边框。每个新 class 都要有静息态规则，必要时补 `rendererStyleTokens.test.ts` 的显式控件清单 | `rendererSidebarView`、`rendererComposerChip`、`rendererRuntimeMenu` |
| [ ] **P4-4** 输入区与弹层质感 | 输入区 `:focus-within` 升 `--border-strong` + `--shadow-float`；菜单/弹层 `--radius-md` + `--shadow-float`，模态面板 `--radius-lg` + `--shadow-modal`。祖先链不得出现 `overflow` 裁剪；z 分层（弹层壳 4 / 菜单 5 / rewind 9 / overlay 10）不变；背景永不关闭阻塞请求 | `rendererOverlayView`、`rendererRewindPanel`、`rendererPermissionView`、`rendererStyleTokens` |
| [ ] **P4-5** 文档同步与总收口 | 更新 `CLAUDE.md` 与 `AGENTS.md` 的渲染器不变量段（洗色已删、accent-fill 三条例外、标题栏 40px、圆角与动效刻度、`--font-serif` 白名单、折叠中间态）——两份文件除标题与首句外必须逐字同步；把 `styles.css` 里 43 处 `design_guidance 三.3` 式引用重新指向改版后的章节号 | `npm run typecheck`；`npm run test`；`npm run smoke:desktop` |

---

## 三 每期固定验收命令

```bash
node --import tsx --test test/rendererStyleTokens.test.ts test/rendererSidebarView.test.ts \
  test/rendererSidebar.test.ts test/rendererSettingsView.test.ts test/rendererWelcomeView.test.ts \
  test/rendererCanvasHeaderView.test.ts test/rendererBoot.test.ts test/desktopBuild.test.ts
```

P1、P3 结束额外跑 `npm run typecheck` 与 `npm run smoke:desktop`；P4 结束跑 `npm run test` 全量。

---

## 四 全程不得触碰的既有约束

画布发丝线是 inset `outline`（不是 border、不是 box-shadow）；`.transcript-column` 的
`margin-top: auto` 底部对齐（不得换 `justify-content: flex-end`）；`#overlay`/`#rewind` 的
`inset: 0`；`app.ts` 中 `mux`/`shellClient` 必须构造在顶层主题块之前；渲染器不得 value-import
`harness/`/`services/`/`sessions/`/`commands/`/`tui/`；`.open` 不得有样式规则；不引入
`backdrop-filter` 或 `backgroundMaterial`；`body` 单独画窗口底、`#titlebar`/`#sidebar` 透明、
`#canvas` 不透明；`.project-heading` 与它的 `+` 是兄弟节点、右键菜单在流内绘制。

## 五 已知风险

1. **标题栏 40px 后的 Windows 控制条宽度**（设计文档九.2）未定。P1-5 必须实测，不实测就会在
   40px 下留下一段可拖拽但被系统按钮盖住的死区。
2. **烟雾测试要显示器和凭据**。P1-5 改了 `TITLE_BAR_HEIGHT` 却跑不了烟雾时，该任务算未完成，
   不要靠单测替代。
3. **字体入库使仓库增重约 0.5MB**。若后续要求瘦身，唯一正确的做法是继续切子集，不是改回
   构建期从 node_modules 解析（那会让离线构建产出无字体窗口且不报错）。
4. **`--accent-brand` 对纸只有 3.9:1**。P1-4 的对比度断言是这条纪律的唯一保障；如果那条断言
   因为难写被跳过，P4 一定会有人把品牌色写到正文上。
