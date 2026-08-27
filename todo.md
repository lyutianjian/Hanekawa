# Hanekawa 桌面端 — 待办

> 只讲没做完的事。架构与不变式在 `CLAUDE.md`／`AGENTS.md`，长什么样与为什么在 `design_guidance.md`。
> 状态：`[x]` 完成并验证 · `[~]` 部分完成 · `[ ]` 未开始。
> 「截图」指 `.smoke/20260826-015222/`（`npm run build:desktop && npm run smoke:desktop -- --kill-stale`
> 的产物，重跑会生成新目录）。该次是 S2 之后的基线：11 passed / 1 skipped（S1 需 `--paid-turn`），
> 视觉档尚未开工，所以下面每条视觉待办引用的文件名在这一份里仍然对得上。**例外**：`02a`（权限
> 对话框）已被 S5 重画、又被 S6 挪进画布；`03a`／`06a`／`07a`／`07b`（侧栏行三档、确认态、折叠态）
> 被 S7 重画。这几张最新的在 `.smoke/20260826-063326/`；`07a`／`08a` 又被 S8 加上了画布发丝与设置阅读列，
最新的（含新的 `08a-settings-wide`）在 `.smoke/20260826-065441/`；`09a`（选择器面板）被 S9 重画
（收进阅读列、浮在输入框上、生效行由 `● ` 改成图标槽），最新在 `.smoke/20260826-072416/`；`07a`（以及新增的 `07c`）又被 S10 重画——短会话的内容现在贴着输入框，
待下一次冒烟出图。S11 新增的 `11a`／`11b`／`11c` 是**浅色**档（全窗口／设置下拉／输入框浮层），
连同 `07c` 一起在 `.smoke/20260826-080750/`。其余视觉待办引用的截图未受影响。

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

### D4 四个阻塞对话框完全不能用鼠标 — 功能部分已修（S4）

`dom/overlayView.ts` 里 `addEventListener` 出现 **0 次**：`optionList()`（`overlayView.ts:136`）把每个
选项画成 `div.option`，内容是 `> [y] 允许一次` 这样的文本，没有 `role="option"`、没有 click。受影响的
是权限确认、AskUserQuestion、计划审批、退出计划模式——桌面端最关键的那几次交互只能用键盘
（`app.ts:760` 的全局 keydown 兜住了键盘路径，所以功能是通的，鼠标是死的）。`dom/suggestionsView.ts`
同样 0 个监听（命令／文件补全条也点不动）。对照组：`rewindView.ts:71,100`、`surfaceView.ts:54` 的行
是可点的，只是长得还是 TUI 的样子。

形态部分见 V5，建议同一档做完。

**已做（S4，只做功能）**：`optionList()` 现在给每行加 `role="option"`／`aria-selected`、容器加
`role="listbox"`，并挂 click 交出**行的槽位**；`suggestionsView` 挂 `mousedown` + `preventDefault`
（不是 click——accept 要读输入框的 caret）。槽位到 intent 的决策在 `model/` 里，和数字键共用一处：
`permissionIndexToIntent`／`enterPlanIndexToIntent`／`exitPlanIndexToIntent`（拒绝槽位仍然只移动焦点，
好让用户先打反馈）／`AskIntent` 的 `{kind:'select'}`；`paneSession` 的键鼠两个入口汇到同一组
`apply*Intent`。遮罩**不可点**——未作答的请求停着 agent loop，点背景关掉等于把请求丢了。
悬停只给 CSS 高亮 + 手型，不移动 `selectedIndex`（否则鼠标停在「允许」行会把安全默认挪走）。
**缺口已补（S5）**：多选题的「提交」按钮已长出来，走的还是 Enter 那条 `{kind:'commit'}`。
**回归**：新建 `test/rendererOverlayView.test.ts`（domStub，覆盖两个视图 + 源码扫描守卫），四个 model
测试各加点击用例，`rendererShellModel.test.ts` 钉住「点击与 Enter 同一处 `completionAcceptMode`」。
冒烟 S2 改为用真实 `Input.dispatchMouseEvent` 点「允许一次」作答（`cdp.mjs` 的 `mouseClick`，
`probes.overlay()` 补 `options` 的中心点）。**冒烟待在有显示器与凭据的机器上跑一次。**

### D5 侧栏看不出「当前是哪个会话」 — 已修（S7）

`styles.css:634` 只有 `.session-row.active .session-title { color: var(--text-primary) }`——激活行没有底色
胶囊，而 `--surface-active` 的胶囊被给了 `.selected`（键盘所在行）。`design_guidance.md` 三.2 写的是
「激活行 = `--surface-active` 胶囊 + 主文本色」。截图 `07a` 里八行有五行是亮的（开着 lane 的都亮），
真正显示中的那一个分辨不出来。同一处还要区分「已打开但不在前台」与「正在显示」两档。

**已做**：三档只靠文字色 + 胶囊，不加左侧竖条、不占用 badge 槽位——纯历史
`--text-secondary`（`:not(.open)` 那条不动）／已打开未在前台 = 主文本色无底色（`.session-open` 的默认色）／
正在显示 = `--surface-active` 胶囊 + 主文本色 + 600 字重。`.selected`（键盘光标）让出胶囊，改成
hover 底色 + `inset 0 0 0 1px var(--border-strong)` 中性发丝内描边，两根轴正交、可叠加显示；
**不**用 `--focus-ring`，`.sidebar-list:focus` 已有一层蓝外框。三条规则在样式表里的**先后顺序**承重
（`.selected` → `.active` → `.confirming`，同为一个类的选择器只能靠后来居上）。

### D6 删除确认把会话名顶掉了 — 已修（S7）

截图 `03a`：确认状态把整行文字换成「删除此会话？ [删除][取消]」，用户此刻看不到自己要删的是哪一个
（`.session-row.confirming`，`styles.css:684`）。改法：名字留在原位，确认按钮占右侧 `.session-actions`。

**已做**：`rowNode()` 的确认分支不再提前 `return`，**一条构造路径**——标题与 badge 照常画，只把
`.session-open` 置 `disabled`（名字看起来还能点却不作答，比不可点更糟），`.session-actions` 里
二选一放 `session-confirm-yes/no` 或 `session-delete`。「删除此会话？」整句删掉：268px 行宽下它和标题
只能活一个，而标题是用户唯一供不出的那一半；问句由行底色 `--surface-card` + 两颗按钮自己说，
无障碍走按钮的 `aria-label`。

### D7 冒烟驱动有两条断言已经过期（假红） — 已修（S0）

- `scripts/smoke/steps.mjs:526` `all four categories are live` 期望 4，实际 5：导航早已是五页
  （通用／外观／模型与服务商／权限／Agent）。
- `steps.mjs:551` `the shell still fills exactly one window` 期望 `shellHeight === viewport`，实际
  480 vs 520：无边框标题栏占 40px，`#shell` 本来就该比视口矮一个标题栏。

两条都按现状改判据（高度那条改成 `viewport - 标题栏高度`，**不要**放宽成 `>=`），否则 S8 永远红，
真回归会被淹掉。

### D8 侧栏折叠键有三个 — 已修（S7）

标题栏左上有 `◧`，侧栏头部还留着一个 `<`（`.sidebar-collapse`，截图 `07a`），折叠后又变成一条 44px
空轨道上挂一个 `>`（截图 `07b`）。规范里写明的是标题栏那个；侧栏里那个应当去掉，折叠态收到 0 宽。

**已做**：`.sidebar-collapse` 的按钮与两条规则一并删掉，头部只剩工作区行；折叠时连
`.sidebar-header` 一起 `hidden`，`#sidebar.collapsed` 从 `flex-basis: 44px` 改成 `0`。
顺带补 `#sidebar.collapsed + #canvas { margin-left: 8px }`——`#canvas` 是 `margin: 8px 8px 8px 0`，
它把侧栏当自己的左内衬，收到 0 宽后不补这条会贴死窗口左缘、不再「浮起」。

---

## 二、视觉打磨（按 `design_guidance.md` 的节次）

> 原则不变：「参考图里有、我们没有」不是待办。下面每条要么是规范已写而实现没跟上，要么是实机截图上
> 明显读错的东西。

### V1 画布浮不起来（三 / 四） — 已修（S8）

深色下 `--surface-base #0f0f11` 与 `--surface-canvas #17171a` 只差 8 个亮度级，`#canvas` 又没有边框、
没有阴影，截图 `07a` 上左右两栏读成一整块黑——「画布必须浮在基底之上」这条规范在深色主题里事实上
不成立。

**已做**：`#canvas` 加一条 `--border-subtle` 发丝（token 一个没动，浅色同样受益），且是
`outline: 1px solid var(--border-subtle)` + `outline-offset: -1px`，**不是 `border`**：`#overlay`／
`#rewind` 自 S6 起是 `absolute; inset: 0`（定位在 padding box），border 会把两层遮罩四边各内缩 1px，
撞上冒烟 S2 的「遮罩四边与画布四边逐边相等」——而 D7 定过判据只改不放宽。inset `box-shadow` 同样出局：
它画在自身背景之上、**子节点之下**，`#canvas-header` 会把顶边盖掉；outline 在所有子节点之后绘制，
也不进 `getBoundingClientRect()`。`overflow: hidden` 不裁自身 outline，圆角照常跟随。同一写法在
`.sidebar-list:focus` 已有先例。

### V2 空会话的画布是一大片空 — 已修（S10）

截图 `07a`：一条用户气泡贴在顶部，下面 900px 空白，输入框在最底。只有全新草稿才有欢迎页
（`.pane.empty`），一个「有历史但很短」的会话什么都不给。要么让短会话的内容贴着输入框往上排，要么在
空白里保留上下文胶囊条。

**已做（S10）**：按前者，且**所有会话统一**，不分档。`.transcript`（滚动容器）改成 flex 列，
`.transcript-column` 取 `margin: auto auto 0` + `flex-shrink: 0`。三件事都是承重的：
① auto 上外边距在内容溢出时自然归零，所以长会话逐像素不变——`justify-content: flex-end` 是这条的
错误写法，它会让滚动容器里溢出内容的**顶部滚不到**；② `flex-shrink: 0` 少不得，列是 flex 项，
默认会被压到容器高度、内容溢出到一个没人滚的盒子外面；③ 列必须是滚动容器的**唯一**子节点，
多一个兄弟就会分掉那份剩余空间（`transcriptView.ts` 的 `replace()` 本来就只放一个，已有用例钉住）。
DOM、`model/`、`dom/` 一行没改，**也没在 TS 里量任何高度**（V8 那个口子仍未开）。空状态
（`.pane.empty .transcript { flex: 0 0 auto }`）不参与，Hero 照旧居中。

### V3 `#surface` / `#queue` 是两块通栏板砖（四.2） — 已修（S9）

截图 `09a`：思考强度选择器从画布左边缘一路铺到右边缘，`--radius-md`、无边框，和它自己的触发点
（输入框右下角的胶囊）隔了整整一屏（`styles.css:951` / `:982`）。至少收进 `.composer-column` 那条
760px 阅读列并换 `--radius-lg` + 发丝边；更好的是锚在胶囊上的浮层——那要么按坐标定位（现有决策明确
拒绝），要么挪进 `#composer` 的定位壳里，**推荐后者**。

**已做（S9）**：按后者，且 `#suggestions` 一起收（同一形状、同一位置，留一块通栏只会变成新的读错点）。
三者移进 `.composer-column` 里的新定位壳 `#composer-popovers`（`absolute; left/right: 0; bottom: 100%`，
`flex-direction: column` 所以 DOM 顺序即视觉顺序，`#queue` 落在最下、紧贴输入框——它讲的正是「下一条会发
什么」）。`.composer-column` 补 `position: relative` 当包含块，并**不许有 `overflow`**——理由与
`.settings-column`（D3/V7）逐字相同。壳 `pointer-events: none`、三块面板各自 `auto`：三块全收起时壳仍在
输入框上方，`gap` 的空隙也是它的地盘，少这条就会吃掉对话流的点击。`z-index: 4`：高过对话流与
`.scroll-bottom`（都没有 z-index），低过全表所有菜单（5–6），因而低过 `#rewind: 9` / `#overlay: 10`。
面板本身去掉 `margin` 与 `flex`，`--radius-md` → `--radius-lg` + `--border-subtle` 发丝 + `--shadow-float`；
`max-height` 三档（40/30/22vh）与自己的滚动条保留，`#canvas` 的 `overflow: hidden` 是最后一道保险。
`#canvas.settings-open >` 那张清单删掉这三条选择器——它们现在是 `#input-row` 的后代，隐藏输入框即隐藏，
与 5g 的 `#status` 同一情形；`probes.surface()` 判 open 靠 `getClientRects()` 而不是 `hidden` 属性，语义不变。
`app.ts` 与三个视图模块一行没改（都走 `getElementById`）。

### V4 胶囊下拉的 `⌵` 在左边（六） — 已修（S9）

规范写「左图标 + 文本 + `⌵`」，实际是 `⌵ 跟随系统`（截图 `08a-settings-外观`）：`controls.ts:29` 的
`button()` 无条件把 icon 插在 label 之前。给 `pillSelect` 一个显式的 `trailingIcon` 参数，别让排布靠
调用点记着。

**已做（S9）**：`button()` 的 options 加 `trailingIcon`，`icon` 收窄成「前置图标」；`⌵` 三处一起后置——
`pillSelect`（六）、侧栏工作区行（三.2「项目名 + `⌵`」）、思考链折叠头（四.3「已处理 Xm Xs `⌵`」）。
`composerView.ts` 手搓的权限胶囊本来就是尾置，不动。样式上 `.settings-pill`／`.sidebar-workspace` 的
`.btn-label` 补 `flex: 1 1 auto`（否则长标签会把箭头顶出胶囊，工作区行还要靠它才轮到名字截断）；
`.icon` 全局已是 `flex: 0 0 auto`，不再重复声明。折叠头展开时的 180° 旋转按类命中，与位置无关。

### V5 对话框的语气还是 TUI 的（四 / 六）— 已修（上半 S5，下半 S6）

`[↑↓] 移动　[Y/N/A] 快选　[Enter] 确定　[Esc] 拒绝` 这类提示行、`> [y]` 前缀、`● ` 标记都是 TUI 的
转写，`model/{permissionDialog,askUserQuestion,planDialogs,rewindPanel}.ts` 里各有一份 `hint`。桌面端
应当是主按钮／次按钮 + 快捷键角标，危险动作用 `--accent-danger` 描边（不是填充，见规范七.4），预览块
保留等宽。**上半已按 S5 做完**（`hint` 四份全删、按钮条落地）。

**下半（S6，已做）**：`overlay` 与 `rewind` 从 `position: fixed` 罩满窗口改成 `absolute` 罩住 `#canvas`，
侧栏在对话框打开时保持全亮、可点——停住的只是那一条 lane 的 agent loop。详见动手路径 S6。

`● ` 那处只在 `surfaceView.ts`，**已随 S9 改掉**：`'● '`／`'  '` 的文字前缀（等宽终端对齐列的写法，
在比例字体下既没对齐、又混进了行的可访问名）换成每行常驻的 12px 定宽槽 `.row-mark`，命中的那行往里放
一枚 `dot` 图标。命令视图的行不长这个槽——那是一张事实表，没有「正在生效」这回事。

### V6 权限预览里还有英文

截图 `02a`：中文标题下面是 `Create file: smoke-write-target.txt` / `smoke-write-target.txt will be
created`。这些来自工具预览与运行时 note 路径（TUI 也在用），不在渲染器那三个 presentation 模块的
`locale` 里。独立一档，且要连 TUI 一起想。

### V7 设置正文没有阅读列 — 已修（S8）

截图 `08a`：卡片通栏，行左边是「界面主题」，右边控件在 1000px 之外。对话流已经有 760px 阅读列，设置
正文也该有一条（宽一些，比如 880px），否则「行右侧控件严格右对齐」在宽窗口下反而变成缺陷。

**已做**：`.settings-body` 里常驻一个 `.settings-column`（`max-width: 880px; margin: 0 auto`），
`settingsView.ts` 的 `replace()` 目标从 `body` 改成 `column`——两个节点两件事：body 仍是全宽滚动容器
（`overflow-y: auto` 不动），滚动条因此留在画布边缘，与 `.transcript-column` 逐字同一个取舍。
880 而不是 760：设置行是两端对齐的「左标签 / 右控件」，760 会把控件挤到标签上。
`.settings-column` **不给任何 `overflow`**——它现在在胶囊下拉的祖先链上（D3）。
默认 1200 窗口下 body 内容宽本来就不到 880，夹取不生效，页面观感不变；宽窗口才是这条的用武之地。

### V8 窄窗口下侧栏不让位

截图 `08a-settings-squeezed`（1000×520）：268px 固定侧栏 + 设置的二级导航 = 一半宽度给了导航。没有
`@media` 可用（样式测试的解析器不认 at-rule），断点只能在 JS 里做：由 `app.ts` 按窗口宽度写一个
`data-*` 到 `documentElement`，样式表用属性选择器命中。**这会开「渲染器在 TS 里做布局决策」的先例，
动手前先确认要不要开这个口子。**

### V9 浅色主题从未在实机上看过 — 已修（S11）

`:root[data-theme="light"]` 全套 token 都在，但截图全是深色，冒烟也没有切主题的步骤。`--shadow-float`
与 `--surface-card` 在纯白画布上的表现、以及 Windows 三键 overlay 跟着换色，都只有真机能看。加一条
冒烟步骤：切浅色 → 截图 → 切回。

**已做（S11）**：新增冒烟步骤 `S11`，走设置屏 `外观` 页的胶囊下拉——和用户同一条路，不在页面里直接改
`dataset.theme`。三处取舍是承重的：① **先点「深色」再点「浅色」**，不假设基线是深色（偏好默认是
`跟随系统`，开发者的系统本来就可能是浅色，那样「每个 token 都变了」会空过）；② **原生三键只验线路、
不验像素**——overlay 由 OS 画在文档够不到的 chrome 上（`main.ts:92` 的 `WINDOW_CHROME`），
`Page.captureScreenshot` 只拍页面，与「原生模态拍不到」是同一个盲区，所以断言止步于
`set-window-theme` 答 `ok`（它钉的是主进程没抛也没阻塞）；③ **跑完必须把偏好还回去**——主题偏好在
`localStorage` 里，而 `main.ts` 从不设 `userData`，`--cwd=` 隔离不到它，那是开发者本人的窗口，
所以复原走 `finally`，且 `null`（从没设过）复原成 `removeItem` 而不是 `system`。
调色盘断言分三条（分开失败）：具名 token 逐个换成浅色值 ／ `--surface-knob` 与 `--surface-scrim`
两处故意例外不变 ／ `#canvas` 的实际底色等于 `--surface-canvas` 且正文亮度低于它——最后这条抓的是
「半套生效」留下的白底浅字，token 变了不等于规则用上了。

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

**[x] S4 · 对话框可点（D4，只做功能）** — 前置：S0。
`overlayView.ts` 的 `optionList()` 加 `role="option"` + click，`suggestionsView.ts` 用 `mousedown`；键盘
路径（`app.ts` 的全局 keydown）不变，两条路径共用 `model/` 里的槽位→intent 函数，`paneSession` 汇到
同一组 `apply*Intent`。悬停只做 CSS（**不**移动 `selectedIndex`），遮罩不可点。多选题的提交留给 S5。
回归：新建 `test/rendererOverlayView.test.ts`（domStub，同时覆盖 suggestions，已进
`tsconfig.domtest.json` 的 include 与基础 `exclude`）+ 四个 model 测试的点击用例 +
`completionAcceptMode` 的一致性用例；冒烟 S2 改用真实鼠标点击作答。变异验证：去掉 click / 让拒绝槽位
直接作答 / 把 `mousedown` 换回 `click`，报红的正是对应那条。**冒烟待在有显示器与凭据的机器上跑一次。**

**[x] S5 · 对话框语气（V5 上半）** — 前置：S4。
四份 `hint` 换成 `actions: DialogAction[]`（新模块 `model/dialogActions.ts`，同时给出点击回传的
`OverlayAction`）。**混合形态**：选项本身就是动作的（权限 / 进入计划 / 回退确认屏）→ 选项即按钮，
按钮带 `slot`，点击仍走原来那四个 `*IndexToIntent`（新增 `rewindActionToIntent`）；选项是内容的
（Ask、退出计划）→ 保留行列表，按钮条只放对话框级的 `primary`/`secondary`。**主按钮是中性抬升面**
（`--surface-active` + `--border-strong` + 主文本色），不是实心——规范五写明全界面唯一一处大实心是
`#submit`；危险动作只用 `--accent-danger` 描边与文字。**hint 行整条删掉**：键印在它所属的按钮上
（`.kbd` 等宽角标），没有按钮的 `↑↓`／`Tab` 不再印字。顺带：`> [`／`] ` 前缀清掉，Ask 的假数字角标
删掉（`askKeyToIntent` 本来就不认数字），`[x]` 换成 13px 勾选盒（**中性**填充，不是 accent），
`[header]` 换成胶囊。S4 的缺口（多选只能勾不能提交）由 Ask 的「提交」按钮补上。
**退出计划的次按钮 = Esc**（空反馈 reject），是全应用唯一一颗会丢弃已输入内容的按钮，
`planDialogs.ts` 里写了注释钉住——让它改走 `commit` 会更友好，但那是键盘做不到的事。
**回归**：`rendererOverlayView.test.ts` 扩到三个视图（+rewindView，省掉再开一对 tsconfig 清单条目），
新增「按钮带 slot 答 slot / 不带则按 role」「面板里再没有 `>` `[` `↑↓`」「勾选盒与 aria-checked」；
四个 model 测试各加 `actions` 用例（含 Ask 的提交/取消、退出计划的次按钮与 Esc 等价、rewind 的
danger 只落在改文件的决策上）；`rendererStyleTokens.test.ts` 加**第四张**具名清单
（`dialog-actions` / `dialog-btn` / `kbd`，判据是「选择器**结尾**恰是 `.dialog-btn`」——这组规则挂在
`#overlay-panel` / `#rewind-panel` 下，不属于任何一个）。冒烟 `probes.overlay()` 删 `hint`、
`hotkeys` 改读 `.kbd`（大写）、新增 `actions` 中心点；S2 改为点按钮。
**变异验证**（各红一条）：`.dialog-btn` 静息规则挂到 `.primary` 上 → 新清单红；`danger` 改成
`background` → accent 填充守卫红；把 `> [` 前缀塞回行里 → 前缀扫描红；给退出计划的次按钮加 `slot`
→ 退出计划那条红；Ask 的「提交」改回「选择」→ Ask 两条红。
**实证**：本机跑过整轮冒烟（`--kill-stale`）：11 passed / 1 skipped（S1 仍需 `--paid-turn`），
S2 的 16 条断言含真实鼠标点「允许一次」**按钮**，截图 `02a-permission-dialog`。
按钮条里**只有一颗 primary**（`允许一次`）：`拒绝` 是 Esc 干的事，`始终允许` 会写下一条活得比这次请求久的
规则，两者都不该长得像推荐答案——这条在 model 测试与冒烟里各钉了一遍。
**注意**：S8R（设置跨重启）在第一轮跑里红过一次、重跑即绿（第一轮 15.2s vs 0.2s，像是重启竞态），
与本档无关，但是个已知的间歇性假红。

**[x] S6 · overlay 定位（V5 下半）** — 前置：S5。排在 S7/S8 之前，因为它动 `#canvas` 的定位与层叠。
`#overlay` 与 `#rewind`（**两个一起**，同一条理由：请求属于某条 lane）移进 `<main id="canvas">`，放在
`#settings` 之后作为最后两个子节点，`position: fixed` → `absolute; inset: 0`。`#canvas` 补
`position: relative` 当包含块；它已有的 `overflow: hidden` 顺带把遮罩裁进画布圆角，不必再给遮罩加
`border-radius`。**`#canvas` 故意不写 `z-index`**——写了它就成为层叠上下文，两层遮罩会被困在里面、
被侧栏自己的浮层盖住；保持 `auto`，改由 `#rewind: 9` / `#overlay: 10` 明确压过全表所有 5–6 的浮层
（原来它们靠「在 body 最后」取胜，移进画布后这条依据没了）。罩住**整个画布含头栏**：头栏的 ⋯ 能改名
和删会话，未作答的请求上不该可点。侧栏保持全亮可点。`settings-open` 的兄弟隐藏清单不加这两个 id：
设置屏不停 agent loop，请求会停，请求就该压在设置屏之上。两层的 `aria-modal="true"` 一并去掉——它对
读屏器的意思是「对话框以外全部惰性」，而侧栏并不惰性；`role="dialog"` 保留。顺带修掉 `settingsView.ts` 顶部那句已经失真的
「`#overlay`/`#rewind` 是 fixed、罩住侧栏」注释；`design_guidance.md` 三.3 补「作用域是一条 lane」一条。
**回归**：`rendererOverlayView.test.ts` 新增两条——① 结构（两层都在 `<main id="canvas">` 切片内、在
`#settings` 之后、rewind 在 overlay 之前；反证：`#sidebar` 不在切片内）；② 定位与层叠（两者
`absolute` + `inset: 0`，`#canvas` 是 `relative`，全表再没有 `position: fixed`，`#overlay` > `#rewind` >
其余每一个 `z-index`，且 `#canvas` 没有 `z-index`）。复用 `helpers/rendererCss.ts` 的 `cssBlocks()`。
**变异验证**：改回 `fixed` / 删 `#canvas` 的 `relative` / 把 overlay 的 z-index 调到 5 / 把 overlay 挪回
body —— 四次各只红一条，对应那条。
**实证**：本机跑过 `--only=S2`（`--kill-stale`）：S2 19 条断言全绿（原 16 条 + 新 3 条：遮罩四边与
`#canvas` 四边逐边相等、侧栏中心点的 `elementFromPoint` 命中 `#sidebar` 而不是遮罩、画布中心点命中遮罩），
`probes.mjs` 新增 `modalScope()`。截图 `.smoke/20260826-055834/02a-permission-dialog`：侧栏未被压暗。

**[x] S7 · 侧栏三件套（D5 + D6 + D8）** — 前置：无，但排在 S6 之后避免和 overlay 抢 z-index。
三处都只动 `dom/sidebarView.ts` 与 `styles.css`，`model/sidebar.ts` 一行没改——`active`／`open`／
`confirmingDelete` 三个字段本来就在 `SidebarRow` 上，也已经进了 `sidebarRenderSignature`，缺的只是画法。
**行三档 + 光标另一根轴**见 D5，**确认态一条构造路径**见 D6，**唯一折叠控件 + 0 宽**见 D8。
**回归**：`rendererSidebarView.test.ts` 新增四条（头部只剩工作区且全树没有 `.sidebar-collapse` ／
折叠时五个区域全 `hidden` ／三档 class 分别是 `active+open`·`open`·无 ／确认态留名、`.session-open`
`disabled` 且点了不发 intent、两颗按钮在 `.session-actions` 里且分别发 `confirm-delete`·`cancel-delete`）；
`rendererStyleTokens.test.ts` 新增两条（激活行与光标不同形，且三条规则的**先后次序**被钉住 ／
`#sidebar.collapsed` 是 0 宽且画布补了 `margin-left`）。domStub 的 `StubView` 不暴露 `dataset`，
所以行的身份在测试里靠 `.session-title` 的文本认，不靠 `data-session-id`。
**变异验证**（五次各只红对应那一条）：删掉 `.active` 的 `background` ／把胶囊还给 `.selected` ／
把 `#sidebar.collapsed` 改回 `44px` ／把折叠按钮塞回头部 ／让确认分支重新提前 `return`。
**实证**：本机跑过整轮冒烟（`--kill-stale`）：11 passed / 1 skipped（S1 仍需 `--paid-turn`），
S7 7 条断言含新增的 `width === 0`，S3 的「确认时不显示标题」反转成「名字仍在屏上」。
截图 `.smoke/20260826-063326/`：`06a` 正是 D5 的原始场景（八行、四条 lane），现在 A3–A5 是主文本色、
A6 带胶囊加粗、其余为次文本色；`07b` 侧栏整列消失、画布四边保持 8px；`03a` 确认行留着
`SMOKE-A2 fixture session` 与右侧两颗按钮。
**已知无关间歇性假红**：全量跑了两轮，各红一条不同的、都与本档无关的用例——
`test/backgroundTasks.test.ts` 的「background Bash returns immediately」（拿到 `running` 而非 `completed`）
与 `test/toolcall-integration.test.ts`（整文件超时）；两条单跑都是绿的，是并发跑全量时等子进程的时序。
其余 2425 / 2426 条全绿。

**[x] S8 · 画布浮起 + 设置阅读列（V1 + V7）** — 前置：S6 / S7。
`#canvas` 的发丝见 V1（是 `outline` 不是 `border`，理由承重），设置正文的 880px 阅读列见 V7。
**token 一个没改**，两张 map 与 `design_guidance.md` 的 token 表都不动。
**回归**：`rendererStyleTokens.test.ts` 扩「画布是被裁的圆角面板」（outline 用 `--border-subtle`、
`outline-offset: -1px`、**且不声明 `border`**——这条断言本身就是那个决定的文档）+ 新增「设置屏全宽滚动、
在列里阅读」（`.settings-column` 有 `max-width`、`margin: 0 auto`、无 `overflow`，`.settings-body` 仍是
`overflow-y: auto`）；`rendererSettingsView.test.ts` 新增「body 的直接子节点恰是一个 column，header／
cards／form 全在里面，换页后仍然如此」，带 `max-width` 规则的非空守卫。D3 的「展开的下拉没有裁剪祖先」
不用改，它遍历祖先链上每个类名，新节点自动进入判据。
**变异验证**（四次各只红对应那条）：outline 换 border → 画布那条红；`.settings-column` 去掉 `max-width`
并加 `overflow: hidden` → 恰好三条红（样式两条 + D3 裁剪链）；`replace(column,…)` 改回 `replace(body,…)`
→ 结构那条红。
**实证**：`probes.settings()` 新增 `column`／`bodyContent`／`canvasHairline`，`step8` 加五条断言——
1600×900 与 1000×520 各一对（列宽 `=== min(880, body 内容宽)`，左右余量相等），外加
「画布靠 outline 浮起而不是 border」（`outlineWidth === '1px'` 且 `borderTopWidth === '0px'`）。
宽窗口那一档是必要的：默认 1200 下夹取根本不生效，任何 `max-width` 都能过。`bodyContent` 用
`clientWidth` 推而不是包围盒——表单一长出滚动条，滚动条就吃进 padding box，`right - paddingRight`
会多算约 10px（第一轮就是这样红的）。截图新增 `08a-settings-wide`。
本机跑过整轮冒烟（`--kill-stale`）：**11 passed / 1 skipped**（S1 仍需 `--paid-turn`），S8 38 条断言，
S2 仍是 19 条全绿——遮罩四边与画布四边依旧逐边相等，这正是 outline 选择的验收。
截图 `.smoke/20260826-065441/`。全量单测 2428/2428 绿，`npm run typecheck` 四段绿。

**[x] S9 · 触发点与浮层（V3 + V4）** — 前置：S8。
`#surface` / `#suggestions` / `#queue`（**三个一起**）收进 `.composer-column` 的 760px 列并挪进
`#composer-popovers` 这个定位壳，`--radius-lg` + 发丝边 + 浮层阴影，不按坐标定位；`button()` 加显式
`trailingIcon`，`⌵` 在 `pillSelect`／侧栏工作区行／思考链折叠头三处一律后置。顺带清掉 V5 留下的
`surfaceView.ts` 的 `● ` 前缀。细节见 V3 / V4 / V5 三条。
**回归**：`rendererStyleTokens.test.ts` 新增「三块面板是浮在输入框上的一层，不是通栏板砖」
（壳的 `absolute`/`bottom: 100%`/`pointer-events: none`、`.composer-column` 是 `relative` 且**不声明**
`overflow`、三块面板的圆角发丝阴影与 `pointer-events: auto`、**都不再有 `margin`**，外加「`settings-open`
里不许再出现这三个直接子选择器」）；`rendererOverlayView.test.ts` 新增两条（三块面板在 `#input-row`
切片内、都在壳与 `#composer` 之间，反证 `#transcript-area` 不在切片内 ／ 生效行是图标槽而不是 `●`，
且每行都有那个槽），源码扫描守卫的清单加 `surfaceView.ts`；`rendererSettingsView.test.ts`／
`rendererSidebarView.test.ts`／`rendererTranscriptView.test.ts` 各加一条「`.btn-label` 在前、末子节点是
`svg`」。既有的 z-index 断言（`#overlay` > `#rewind` > 其余每一个）自动把新的第 4 层纳入判据，没改。
**变异验证**（八次各只红对应那一条）：壳改 `position: static` ／ 删壳的 `pointer-events` ／
给 `.composer-column` 加 `overflow: hidden` ／ 把 `margin` 还给 `#surface` ／ 三块面板搬回 `#canvas`
直接子节点 ／ `trailingIcon` 改回 `icon`（controls／sidebarView／transcriptView 各一次，各红一个文件）
／ 把 `● ` 前缀塞回去。
**实证**：本机跑过整轮冒烟（`--kill-stale`）：**11 passed / 1 skipped**（S1 仍需 `--paid-turn`），
S9 从 7 条涨到 11 条断言——面板左右缘与 `.composer-column` 逐边相等、列宽 ≤ 760、
`panel.bottom <= #composer.top`、开合前后 `#transcript-area` 高度不变（浮层不挤压对话流）；
`probes.surface()` 新增 `rect`／`column`／`composerTop`／`transcriptHeight`。S2 仍是 19 条、S8 仍是 38 条
全绿——遮罩四边与画布四边依旧逐边相等，设置阅读列未受影响。截图 `.smoke/20260826-072416/`
（`09a-effort-picker` 是这一档的验收图）。全量单测 2431/2431 绿，`npm run typecheck` 四段绿。

**[x] S10 · 短会话的画布（V2）** — 前置：S8。
两种做法拍板取**前者**（内容贴输入框向上排），且不分档、所有会话统一。改动细节见 V2 一条：
只动 `styles.css` 两条规则，TS 一行没改。
**回归**：`rendererStyleTokens.test.ts` 新增「短会话贴着输入框，长会话仍从顶部滚」——`.transcript`
是 flex 列且**不声明 `justify-content`**（这条断言本身就是那个决定的文档）、`.transcript-column` 的
`margin` 以 `auto` 开头且 `flex-shrink: 0`、`.pane.empty .transcript` 仍是 `flex: 0 0 auto`；
`rendererTranscriptView.test.ts` 既有的「滚动容器只有一个子节点」补上第二条理由（剩余空间归那一个
auto 外边距）。
**变异验证**（四次各只红一条）：`margin` 改回 `0 auto` ／ 删 `flex-shrink: 0` ／ 换成
`justify-content: flex-end` ／ `.transcript` 去掉 `display: flex`。
**实证**：`probes.mjs` 新增 `conversation()`（可见 pane 的 `items` / `scrollHeight` / `clientHeight` /
滚动容器与阅读列两个矩形），S7 在折叠侧栏**之前**新增四条断言——有可见对话、这一档确实不足一屏
（`scrollHeight === clientHeight`，非空守卫，否则后两条空过）、`scroller.bottom - column.bottom === 12`
（`.transcript` 的 padding，精确判据，按 D7 先例不放宽）、`column.top - scroller.top > 12`（空白在上方，
证明列是被顶下去的而不是本来就在那）。宿主选 S7 是因为应用自举打开的正是最年轻的 fixture 会话
（`main.ts:213`），而一个 fixture 恰好只有一条 user 记录——V2 的原始场景。截图新增 `07c-short-session`。
全量单测 **2431/2432**（唯一一条红是 `backgroundTasks.test.ts` 那条已知间歇性假红，单跑 8/8 绿，
与本档无关），`npm run typecheck` 四段绿。**冒烟待在有显示器与凭据的机器上跑一次。**

**[x] S11 · 浅色主题冒烟（V9）** — 前置：S8 / S9（要看最终配色）。
加冒烟步骤：切浅色 → 截图 → 切回，确认 `--shadow-float` / `--surface-card` 在白底的表现，以及
`set-window-theme` 对 Windows 三键 overlay 的重绘。取舍见 V9 一条。
**只动冒烟驱动，`src/` 与单测一行没改**：`rendererStyleTokens.test.ts` 早已把浅色块解析并钉死
（只覆盖颜色 / 不新增 token / 主题无关的 token 不许重声明 / 亮度阶梯在浅色下反向），缺的从来不是
再解析一遍，而是一次真机上色。
**排在 S9 之后、S1 之前**：它是唯一一档会改变「所有东西长什么样」的步骤，放在最后一张深色视觉截图
之后；同时设置屏与输入框浮层已被 S8 / S9 证明可用，所以 S11 报红一定是主题本身。`item` 借 8
（主题住在设置屏的 `外观` 页），照 S4b 借 item 4 的先例——它不是第十一条验收项。
**新增探针**：`theme()`（`dataset.theme` / `localStorage['ui-theme']` / 十个具名 token / 两个故意例外 /
`#canvas` 与 `body` 的实际底色与字色）、`clickSettingsMenuItem(label)`、`setStoredTheme(value)`
（唯一绕过应用自身路径的探针，只给 `finally` 兜底用）；`settingsMenu()` 补 `labels`／`shadow`／
`background`，`surface()` 补 `shadow`／`background`。
**取值单位是个坑**：自定义属性回来的是样式表里写的字面量（`#ffffff`），而 computed 的
`background-color` 永远是 `rgb(...)`——第一轮就是这么红的。比色前先归一化（`steps.mjs` 的 `rgb()` /
`sameColour()`），别比字符串。
**变异验证**（四次，报红的正是对应那条）：删掉浅色块的 `--surface-canvas` → **两条**红
（「每个 token 都换了」，以及「深字浅底」——画布退回 `#17171a` 而正文已是 `#1a1a1e`，这恰好就是
「半套生效」的现场，两条一起红是对的）；给 `--surface-knob` 加一条浅色覆盖 → 「两处例外不变」红；
`.settings-menu` 的 `box-shadow` 改回 `none` → 浮层阴影那条红；把切回那步换成空操作 →
「跑完把偏好放回原样」红。
**实证**：本机跑过整轮冒烟：**12 passed / 1 skipped**（S1 仍需 `--paid-turn`），S11 11 条断言全绿；
S2 / S8 / S9 仍是 19 / 38 / 11 条全绿——主题档没有动到任何深色档的判据。
截图 `.smoke/20260826-080750/`：`11a` 白画布上发丝仍在、侧栏三档仍分得开、短会话仍贴着输入框；
`11b` 下拉伸出卡片且阴影托得住；`11c` 浮层浮在输入框上。**Windows 三键跟没跟着变浅只能用眼睛看**，
截图里没有那条带。全量单测 2432/2432 绿，`npm run typecheck` 四段绿。

### 排在路径外

- **V6**：来源在工具预览与运行时 note（TUI 共用），属于 `tools/` + `services/` 层的本地化。单独一档，
  且**先定 locale 归属层**，否则会在渲染器里长出第二套翻译。
- **V8**：要开「渲染器在 TS 里做布局决策」的先例，未排期，等拍板。

每档验收沿用惯例：先跑最窄的用例，再 `npm run typecheck`（四段）+ 全量；跨层改动（S1 / S2 / S6 / S8）
补 `build:desktop` 与冒烟；新加不变式要做变异验证（把 bug 塞回去，确认报红的是那条用例）。
