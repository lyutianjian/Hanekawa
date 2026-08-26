# Hanekawa 桌面端 — 待办

> 只讲没做完的事。架构与不变式在 `CLAUDE.md`／`AGENTS.md`，长什么样与为什么在 `design_guidance.md`。
> 状态：`[x]` 完成并验证 · `[~]` 部分完成 · `[ ]` 未开始。
> 「截图」指 `.smoke/20260826-015222/`（`npm run build:desktop && npm run smoke:desktop -- --kill-stale`
> 的产物，重跑会生成新目录）。该次是 S2 之后的基线：11 passed / 1 skipped（S1 需 `--paid-turn`），
> 视觉档尚未开工，所以下面每条视觉待办引用的文件名在这一份里仍然对得上。

---

## 一、缺陷

### D1 删除当前显示的会话会把整个应用退掉 — 已修（S1）

**复现**：只开着一个会话（只有一条 lane）时，从侧栏或画布头栏 `⋯` 删除它 → 窗口消失。

**根因**（一条直路，三处）：

1. `shellHost.ts:763` — `deleteSession()` 对开着的会话先 `detachLane(lane, 'session-deleted')`。
2. `shellHost.ts:577-579` — `detachLane` 结尾：`this.lanes.size === 0` 时调 `onAllLanesClosed`。
3. `main.ts:380-386` — `onAllLanesClosed` 在非 darwin 上直接 `app.quit()`。

「删掉最后一个会话」和「关掉最后一个面板」在 `detachLane` 里是同一个事件，而用户意图完全不同：
前者是「清理这条历史」，后者才是「我不要这个窗口了」。冒烟 S4 之所以全绿，是因为它删的时候还有
别的 lane 开着，走不到这个分支。

**修法（建议）**：让删除路径不触发 `onAllLanesClosed`（`reason` 已在参数里，但 `'session-deleted'`
目前和 `'pane-closed'` 同权），改为在同一个项目里建一个新的草稿会话并激活——空窗口比退出更接近预期，
也和「新会话是内存草稿」的既有行为一致。`deleteSession` 的四步顺序（id 先解析、lane 先于文件）是
承重的，新 lane 必须在 `deleteSessionArtifacts` 之后建，否则新草稿会被同一次清理扫到。

**回归**：`test/desktopShellHost.test.ts` 加「删掉唯一一条 lane 不调 `onAllLanesClosed`」；冒烟 S4
扩一条单 lane 分支。

### D2 退出之后 electron 进程还留在后台 — 已修（S2，防御性）

`main.ts:130-141` 的 `before-quit` 是 `preventDefault()` → `await teardown()` → `.finally(app.quit)`。
**`teardown()` 没有超时**：它 await 到 `bootstrap.ts:265` 的 `shutdown()`，第一步
`backgroundTasks.stopAll()` 等真实子进程退出，第二步逐个 `mcpClient.close()`。任何一个不肯退的子进程
都会让那个 promise 永远不 resolve，第二次 `app.quit()` 就永远不发——而窗口已经在 `teardown()` 第一段
被 `destroy()` 了，看到的正是「界面没了、进程还在」。

还有一处顺序缝：D1 的路径上 `detachLane` 已经 `void closeProject(...)`，而 `closeProject` 用
`this.closing` 去重（`projectDirectory.ts:194`），所以随后的 `shutdownAll()` 会**跳过**这个还在飞的
项目而不是等它——退出与项目 teardown 因此是并发的。

**已做**：看门狗落在 `ProjectDirectory.shutdownAll(reason, { timeoutMs })`（而不是 `main.ts` 里内联——
`main.ts` 进不了单测），`main.ts` 的 `teardown()` 传 `SHUTDOWN_DEADLINE_MS`；在飞的 `closeProject`
promise 记在 `closing: Map` 上，`shutdownAll` 连它一起 `allSettled`。**没有真机复现**（按拍板：只做防御），
所以「机制未证实」这句仍然成立——两条缝都是代码上确认的，不是抓到的现场。要复现的话手法照旧：
开一个长跑的 Bash 后台任务再退出。

### D3 设置里的胶囊下拉被卡片裁掉 — 已修（S3）

`.settings-card` 有 `overflow: hidden`（`styles.css:1584-1590`），而 `pillSelect()` 的菜单是挂在行内
`.settings-menu-shell` 上的 `position: absolute`（`styles.css:1727`，`top: calc(100% + 4px)`）。
外观页的「主题」卡片只有一行，菜单向下展开的三行整个落在卡片边界之外，被裁掉；`.settings-body` 的
`overflow-y: auto`（`styles.css:1551`）是第二层裁剪。

卡片的 `overflow: hidden` 不是装饰（行分隔线要被圆角裁住），不能直接删。三条可选：① 菜单向上翻
（但「不按坐标翻转」是现有决策）；② 去掉卡片级 `overflow`，让行自己裁；③ 菜单挂到设置屏这一层的
定位壳上（仍不做 body 级 portal）。**推荐 ②**：改动最小且不引入坐标测量。顺带：`.settings-menu`
缺 `box-shadow: var(--shadow-float)`，而标题栏／画布／输入框三个菜单都有，浅色下它会糊在正文上。

**已做**：按 ②。`.settings-card` 去掉 `overflow: hidden`，底部两角改由 `.settings-card > :last-child`
自己裁（照搬 `.md > :last-child` 的写法，一条规则同时覆盖最后一行的 hover 底色、页脚和空态）；
`.settings-menu` 补 `box-shadow: var(--shadow-float)`。`.settings-body` 的 `overflow-y: auto` 不动——
它是 scroll container，溢出撑大滚动区而不是裁掉。**回归**：`rendererSettingsView.test.ts` 加「展开的
菜单在屏内没有裁剪祖先」（选择器级，domStub 算不了布局，带两条非空守卫）；`rendererStyleTokens.test.ts`
加「四个浮层菜单都有 `--shadow-float`」。CSS 解析器抽到 `test/helpers/rendererCss.ts` 两处共用。
**实证**：冒烟 S8 的 `外观` 页新增三条断言（菜单确实伸出卡片 / 在视口内 / `elementFromPoint` 打得到
最后一项——被裁的元素命中不到，而 `getBoundingClientRect` 对被裁元素照样返回完整矩形），截图
`08a-settings-menu-open`。已在本机跑过 `--only=S8`：33 条断言全绿。

### D4 四个阻塞对话框完全不能用鼠标

`dom/overlayView.ts` 里 `addEventListener` 出现 **0 次**：`optionList()`（`overlayView.ts:136`）把每个
选项画成 `div.option`，内容是 `> [y] 允许一次` 这样的文本，没有 `role="option"`、没有 click。受影响的
是权限确认、AskUserQuestion、计划审批、退出计划模式——桌面端最关键的那几次交互只能用键盘
（`app.ts:760` 的全局 keydown 兜住了键盘路径，所以功能是通的，鼠标是死的）。`dom/suggestionsView.ts`
同样 0 个监听（命令／文件补全条也点不动）。对照组：`rewindView.ts:71,100`、`surfaceView.ts:54` 的行
是可点的，只是长得还是 TUI 的样子。

形态部分见 V5，建议同一档做完。

### D5 侧栏看不出「当前是哪个会话」

`styles.css:634` 只有 `.session-row.active .session-title { color: var(--text-primary) }`——激活行没有底色
胶囊，而 `--surface-active` 的胶囊被给了 `.selected`（键盘所在行）。`design_guidance.md` 三.2 写的是
「激活行 = `--surface-active` 胶囊 + 主文本色」。截图 `07a` 里八行有五行是亮的（开着 lane 的都亮），
真正显示中的那一个分辨不出来。同一处还要区分「已打开但不在前台」与「正在显示」两档。

### D6 删除确认把会话名顶掉了

截图 `03a`：确认状态把整行文字换成「删除此会话？ [删除][取消]」，用户此刻看不到自己要删的是哪一个
（`.session-row.confirming`，`styles.css:684`）。改法：名字留在原位，确认按钮占右侧 `.session-actions`。

### D7 冒烟驱动有两条断言已经过期（假红） — 已修（S0）

- `scripts/smoke/steps.mjs:526` `all four categories are live` 期望 4，实际 5：导航早已是五页
  （通用／外观／模型与服务商／权限／Agent）。
- `steps.mjs:551` `the shell still fills exactly one window` 期望 `shellHeight === viewport`，实际
  480 vs 520：无边框标题栏占 40px，`#shell` 本来就该比视口矮一个标题栏。

两条都按现状改判据（高度那条改成 `viewport - 标题栏高度`，**不要**放宽成 `>=`），否则 S8 永远红，
真回归会被淹掉。

### D8 侧栏折叠键有三个

标题栏左上有 `◧`，侧栏头部还留着一个 `<`（`.sidebar-collapse`，截图 `07a`），折叠后又变成一条 44px
空轨道上挂一个 `>`（截图 `07b`）。规范里写明的是标题栏那个；侧栏里那个应当去掉，折叠态收到 0 宽。

---

## 二、视觉打磨（按 `design_guidance.md` 的节次）

> 原则不变：「参考图里有、我们没有」不是待办。下面每条要么是规范已写而实现没跟上，要么是实机截图上
> 明显读错的东西。

### V1 画布浮不起来（三 / 四）

深色下 `--surface-base #0f0f11` 与 `--surface-canvas #17171a` 只差 8 个亮度级，`#canvas` 又没有边框、
没有阴影，截图 `07a` 上左右两栏读成一整块黑——「画布必须浮在基底之上」这条规范在深色主题里事实上
不成立。可选：给 `#canvas` 加一条 `--border-subtle` 发丝边（最省，浅色下同样受益），或把
`--surface-canvas` 提一级。**改 token 必须同步 `test/rendererStyleTokens.test.ts` 的两张 map**（故意的）。

### V2 空会话的画布是一大片空

截图 `07a`：一条用户气泡贴在顶部，下面 900px 空白，输入框在最底。只有全新草稿才有欢迎页
（`.pane.empty`），一个「有历史但很短」的会话什么都不给。要么让短会话的内容贴着输入框往上排，要么在
空白里保留上下文胶囊条。

### V3 `#surface` / `#queue` 是两块通栏板砖（四.2）

截图 `09a`：思考强度选择器从画布左边缘一路铺到右边缘，`--radius-md`、无边框，和它自己的触发点
（输入框右下角的胶囊）隔了整整一屏（`styles.css:951` / `:982`）。至少收进 `.composer-column` 那条
760px 阅读列并换 `--radius-lg` + 发丝边；更好的是锚在胶囊上的浮层——那要么按坐标定位（现有决策明确
拒绝），要么挪进 `#composer` 的定位壳里，**推荐后者**。

### V4 胶囊下拉的 `⌵` 在左边（六）

规范写「左图标 + 文本 + `⌵`」，实际是 `⌵ 跟随系统`（截图 `08a-settings-外观`）：`controls.ts:29` 的
`button()` 无条件把 icon 插在 label 之前。给 `pillSelect` 一个显式的 `trailingIcon` 参数，别让排布靠
调用点记着。

### V5 对话框的语气还是 TUI 的（四 / 六）

`[↑↓] 移动　[Y/N/A] 快选　[Enter] 确定　[Esc] 拒绝` 这类提示行、`> [y]` 前缀、`● ` 标记都是 TUI 的
转写，`model/{permissionDialog,askUserQuestion,planDialogs,rewindPanel}.ts` 里各有一份 `hint`。桌面端
应当是主按钮／次按钮 + 快捷键角标，危险动作用 `--accent-danger` 描边（不是填充，见规范七.4），预览块
保留等宽。另外 `overlay` 是 `position: fixed` 罩满整个窗口（`styles.css:1195`），弹在侧栏之上；一个属于
某条 lane 的请求，罩住画布更讲得通。与 D4 同一档。

### V6 权限预览里还有英文

截图 `02a`：中文标题下面是 `Create file: smoke-write-target.txt` / `smoke-write-target.txt will be
created`。这些来自工具预览与运行时 note 路径（TUI 也在用），不在渲染器那三个 presentation 模块的
`locale` 里。独立一档，且要连 TUI 一起想。

### V7 设置正文没有阅读列

截图 `08a`：卡片通栏，行左边是「界面主题」，右边控件在 1000px 之外。对话流已经有 760px 阅读列，设置
正文也该有一条（宽一些，比如 880px），否则「行右侧控件严格右对齐」在宽窗口下反而变成缺陷。

### V8 窄窗口下侧栏不让位

截图 `08a-settings-squeezed`（1000×520）：268px 固定侧栏 + 设置的二级导航 = 一半宽度给了导航。没有
`@media` 可用（样式测试的解析器不认 at-rule），断点只能在 JS 里做：由 `app.ts` 按窗口宽度写一个
`data-*` 到 `documentElement`，样式表用属性选择器命中。**这会开「渲染器在 TS 里做布局决策」的先例，
动手前先确认要不要开这个口子。**

### V9 浅色主题从未在实机上看过

`:root[data-theme="light"]` 全套 token 都在，但截图全是深色，冒烟也没有切主题的步骤。`--shadow-float`
与 `--surface-card` 在纯白画布上的表现、以及 Windows 三键 overlay 跟着换色，都只有真机能看。加一条
冒烟步骤：切浅色 → 截图 → 切回。

---

## 三、动手路径

每一档是一次会话的量：读少量模块 + 改 + 最窄用例 + typecheck。两处与「按缺陷编号排」的直觉不同：
**D7 提到最前**（假红不修，后面每一档的冒烟验收都是脏的，且 D1 要动同一个 `steps.mjs`）；
**D4/V5 拆成三档**（`overlayView` 的 0 个监听、四个 model 的 `hint`、`overlay` 的定位层级，一次做不完）。

**[x] S0 · 修冒烟驱动（D7）** — 前置：无，后面每档都依赖它。
`steps.mjs` 的分类数 4→5；「shell 填满窗口」拆成两条等值断言：标题栏 === `TITLE_BAR_HEIGHT`（40，
本地常量指回 `main.ts` 的 `WINDOW_CHROME`），`#shell` === `viewport - TITLE_BAR_HEIGHT`（**没有**放宽成
`>=`）。`probes.mjs` 的 `settings()` 新增 `titleBarHeight`，同时守住 `styles.css` 与 `main.ts` 两个高度源。
**冒烟本身待在有显示器与凭据的机器上跑一次**（`npm run build:desktop && npm run smoke:desktop -- --kill-stale`）。

**[x] S1 · 删除会话不再退应用（D1）** — 前置：S0。
`detachLane` 的尾巴（`closeProject` + `onAllLanesClosed`）抽成 `settleAfterLastLane`，并加显式的
`{ deferExit }` 参数（**不是**按 `reason` 分支——`reason` 是自由字符串，让它承担控制流会把每个新 reason
变成语义分支）；`deleteSession` 只在「删的是窗口最后一条 lane」时 defer，并在 `deleteSessionArtifacts`
**之后**开草稿 lane（`openLane` → `registerLane` 自带广播与激活），补开失败则回退到 `settleAfterLastLane`。
多项目下删掉某项目的最后一条 lane 仍照旧关掉那个项目。回归：`desktopShellHost.test.ts` 加四条（窗口最后
一条 lane 不调 `onAllLanesClosed` / 草稿在清理之后建 / 补开失败回退 / 多项目仍关项目）；冒烟新增末位步骤
`S4b`（收到单 lane → 删 → `liveness` + 新草稿 lane + 活动行）。变异验证：去掉 `deferExit` 分支，报红的正是
这几条。**冒烟本身待在有显示器与凭据的机器上跑一次。**

**[x] S2 · 退出挂住（D2）** — 前置：S1（同一条 detach 路径）。
只做防御，未复现。`shutdownAll(reason, { timeoutMs })` 是看门狗（**8s**，不是 5s：`terminateProcessTree`
在 posix 上合法最坏是 SIGTERM 等 5s + SIGKILL 等 1s，5s 会在正常杀进程路径上误触发并把子进程留成孤儿），
超时只停止等待、不取消任何东西；`closing` 从 `Set` 改成 `Map<root, Promise>`，`shutdownAll` 把在飞的
close 一并 await，`closeProject` 的重入调用拿到的也是同一个 promise（存进 map 的那份 `.catch` 掉，
因为 `settleAfterLastLane` 是 `void closeProject(...)`）。回归全在 `projectDirectory.test.ts`（三条新增 +
既有幂等用例加一条「重入调用真的等到关完」）；`desktopMain.test.ts` 不需要动，它从不导入 `main.ts`。
变异验证：`shutdownAll` 不带在飞的那批 → 第一条红；去掉 deadline → 第二条挂死。验收沿用冒烟 S10
（「优雅退出 + 无残留 electron 进程」），**待在有显示器与凭据的机器上跑一次**。

**[x] S3 · 设置下拉被裁 + 阴影（D3）** — 前置：无。最小一档。
去掉 `.settings-card` 的 `overflow: hidden`，底部圆角改由 `.settings-card > :last-child` 自身裁；
`.settings-menu` 补 `box-shadow: var(--shadow-float)`。回归：`rendererSettingsView.test.ts` 的选择器级
断言 + `rendererStyleTokens.test.ts` 的浮层阴影断言，解析器抽到 `test/helpers/rendererCss.ts`；冒烟 S8
加 `elementFromPoint` 实证与 `08a-settings-menu-open` 截图。变异验证：加回 `overflow: hidden` 只红新用例，
删掉阴影只红阴影那条。

**[ ] S4 · 对话框可点（D4，只做功能）** — 前置：S0。
`overlayView.ts` 的 `optionList()` 加 `role="option"` + click/hover，`suggestionsView.ts` 同办；键盘路径
（`app.ts:760`）不变，两条路径共用一个放在 `model/` 的 select 决策函数。回归：新建
`test/rendererOverlayView.test.ts`（照 `rendererTranscriptView.test.ts` 的 domStub 模式，记得进
`tsconfig.domtest.json` 的 include 与基础 `exclude`——`rendererImports.test.ts` 会查）。

**[ ] S5 · 对话框语气（V5 上半）** — 前置：S4。
`model/{permissionDialog,askUserQuestion,planDialogs,rewindPanel}.ts` 的 `hint` 换成主/次按钮 + 快捷键
角标数据，危险动作 `--accent-danger` **描边**；去掉 `> [y]`、`● ` 前缀，预览块保留等宽。新按钮类要在
`styles.css` 有 resting-state 规则并登记进 `rendererStyleTokens.test.ts` 的显式类名列表。

**[ ] S6 · overlay 定位（V5 下半）** — 前置：S5。排在 S7/S8 之前，因为它动 `#canvas` 的 stacking context。
`overlay` 从 `position: fixed` 罩满窗口改为罩住所属 lane 的画布（`#canvas` 的定位壳）。回归：
`rendererOverlayView.test.ts` 加层级断言 + 冒烟截图。

**[ ] S7 · 侧栏三件套（D5 + D6 + D8）** — 前置：无，但排在 S6 之后避免和 overlay 抢 z-index。
激活行 `--surface-active` 胶囊 + 主文本色，并区分「已打开但不在前台」与「正在显示」两档；确认删除时
名字留原位、按钮进 `.session-actions`；删掉 `.sidebar-collapse`，折叠态收到 0 宽。

**[ ] S8 · 画布浮起 + 设置阅读列（V1 + V7）** — 前置：S6 / S7。
`#canvas` 加一条 `--border-subtle` 发丝边（比提 `--surface-canvas` 省，浅色同样受益）；设置正文加
880px 阅读列。**改 token 必须同步 `rendererStyleTokens.test.ts` 的两张 map。**

**[ ] S9 · 触发点与浮层（V3 + V4）** — 前置：S8。
`#surface` / `#queue` 收进 `.composer-column` 的 760px 列，`--radius-lg` + 发丝边，并挪进 `#composer`
的定位壳（不按坐标定位）；`pillSelect` 加显式 `trailingIcon`，`controls.ts` 的 `button()` 不再无条件把
icon 前置。

**[ ] S10 · 短会话的画布（V2）** — 前置：S8。可与 S9 并行。
两种做法（内容贴输入框向上排 / 空白里留上下文胶囊条）在本档先定一个再实现。

**[ ] S11 · 浅色主题冒烟（V9）** — 前置：S8 / S9（要看最终配色）。
加冒烟步骤：切浅色 → 截图 → 切回，确认 `--shadow-float` / `--surface-card` 在白底的表现，以及
`set-window-theme` 对 Windows 三键 overlay 的重绘。

### 排在路径外

- **V6**：来源在工具预览与运行时 note（TUI 共用），属于 `tools/` + `services/` 层的本地化。单独一档，
  且**先定 locale 归属层**，否则会在渲染器里长出第二套翻译。
- **V8**：要开「渲染器在 TS 里做布局决策」的先例，未排期，等拍板。

每档验收沿用惯例：先跑最窄的用例，再 `npm run typecheck`（四段）+ 全量；跨层改动（S1 / S2 / S6 / S8）
补 `build:desktop` 与冒烟；新加不变式要做变异验证（把 bug 塞回去，确认报红的是那条用例）。
