# 内置浏览器子系统 — 实施规格

这份文档是给**冷启动的后续会话**看的：阶段 1–5 全部落地，而中间的设计决策不写下来就会丢。

读顺序：§1 背景 → §2 已落地的真实 API（这是关键，不是设计稿）→ §3 不变量 → §4 各阶段的原计划与偏差 → §8 剩下的验收。

---

## 1. 背景

Hanekawa 原本只有 `WebFetch`，拿不到登录态页面、拿不到 JS 渲染后的内容、不能点击填表。本子系统给桌面端加一个真实浏览器：Electron `WebContentsView` 承载网页，主进程通过 CDP 注入采集与输入，把页面投影成模型能吃的文本；同一个实例人也能看、也能接管。

**结构性优势**：agent loop 就跑在 Electron 主进程里（`src/desktop/main.ts` 的 `createOccupant` 为每个 lane 造一个 `SessionHost`）。所以不需要任何进程间外壳——直接注入一个内置工具即可。截图也直接走现有 `ImageAttachmentService`。

**参考材料**：`/Users/miyano/Documents/code/kimi-browser-study/BROWSER-SUBSYSTEM.md`（对 Kimi Code 桌面版的逆向阅读笔记，1078 行，含 `source/browser/` 下抽出的 42 个文件）。

> 用法约束：**只借鉴机制，不粘贴代码**。那是已发布商业应用的反编译产物。本项目是个人学习用途，所有实现重写——重写反而更简洁，因为能砍掉 Kimi 为跨进程付出的那一层。

**范围**：桌面端专属。TUI 不注册 `Browser` 工具（见 §4.3 的注入路径）。

---

## 2. 已落地的 API（阶段 1–2）

以下是**代码里真实存在的签名**，不是计划。改它们之前先看用处。

### 2.1 `src/desktop/browser/tabs.ts`

```ts
export const BROWSER_PARTITION = 'persist:hanekawa-browser'
export const AUTOMATION_WORLD_ID = 1001   // 已导出，阶段 2 才会被用到

export class BrowserTabHost {
  attachWindow(window: BaseWindow): void
  detachWindow(): void
  createTab(lane: string, url?: string): string   // 返回 tabId
  closeTab(tabId: string): void
  closeLane(lane: string): void                   // detachLane 调用
  navigate(tabId: string, url: string): void
  goBack(tabId: string): void
  goForward(tabId: string): void
  reload(tabId: string): void
  takeOver(tabId: string): void                   // 目前只置标志，仲裁在阶段 5
  setBounds(tabId: string, rect: WireBrowserRect, visible: boolean): void
  describe(): WireBrowserTabInfo[]
  onChanged(listener: (tabs: WireBrowserTabInfo[]) => void): () => void
  dispose(): void
}

export class BrowserHostError extends Error { readonly code: string; readonly retryable: boolean }
```

内部 `TabEntry` 的字段（阶段 2 要用）：
`tabId · lane · view?: WebContentsView · generation · committedGeneration · domReadyGeneration · completeGeneration · requestedVisible · rect · url · title · loading · error · takenOver`

网页的 `webPreferences`：`sandbox: true` + `contextIsolation: true` + `nodeIntegration: false` + `backgroundThrottling: false` + **无 preload**。最后一条是安全模型的核心。

### 2.2 协议 `src/desktop/shellProtocol.ts`

命令（8 个）：`browser-create-tab` / `browser-close-tab` / `browser-navigate` / `browser-go-back` / `browser-go-forward` / `browser-reload` / `browser-take-over` / `browser-set-bounds`

事件：`{ type: 'browser-state'; tabs: WireBrowserTabInfo[] }`（全量列表，跨所有 lane）

类型：`WireBrowserRect { x, y, width, height }`、`WireBrowserTabInfo { tabId, lane, url, title, loading, canGoBack, canGoForward, error?, takenOver? }`、`WireShellBrowserCreateTabResult { tabId }`、`WireShellBrowserOkResult { ok: true }`

### 2.3 `src/desktop/shellHost.ts`

- `ShellHostDeps.browser?`：结构与 `BrowserTabHost` 的方法一一对应（`main.ts` 直接把实例传进去）
- `broadcastBrowserState(tabs)`：公开方法，与 `broadcastLanes()` 同级
- `detachLane` 的顺序：`lanes.delete` → `occupant.dispose()` → **`browser.closeLane(key)`** → `mux.closeLane` → `workspace.close`
- `requireBrowser()`：没有 browser 时抛错；唯一例外是 `browser-set-bounds`，静默丢弃

### 2.4 渲染层

`renderer/shellClient.ts`：`browserCreateTab/CloseTab/Navigate/GoBack/GoForward/Reload/TakeOver`（走 `send`，有回执）、`browserSetBounds(tabId, rect, visible)`（**直接 `channel.post`，不进 pending 账本**）、`getBrowserTabs()`、`onBrowserState(listener)`

`renderer/model/browserPanel.ts`（纯函数）：`BROWSER_WIDTH_{STORAGE_KEY,DEFAULT,MIN,MAX,VARIABLE}` · `clampBrowserWidth` · `parseBrowserWidth` · `browserWidthVariable` · `tabsForLane` · `resolveActiveTab` · `shouldShowBrowserView` · `normalizeAddress` · `addressLabel` · `tabLabel`

`renderer/dom/browserPanelView.ts`：`createBrowserPanelView(nodes, handlers) → { render, measure, dispose }` · `browserPanelNodes()`

`renderer/app.ts`：`browserOpen` 布尔 + `browserActiveTab: Map<lane, tabId>` + `renderBrowser()` + `toggleBrowserPanel()` + 面板 resizer 拖拽。标题栏「视图 → 显示 / 隐藏浏览器」走 `TitleBarAction` 的 `toggle-browser`。

### 2.5 共享测试设施的三处扩展

`test/helpers/domStub.ts` 被扩了（都按该文件「往这张表上加，别另起一张」的要求）：

1. `getBoundingClientRect()` 现在返回 `left/right/width`；`onLayout` 规则的水平一对是**可选**的，省略即 `NaN`（旧规则行为不变）
2. `window` 有了 `addEventListener` / `removeEventListener`（只存不派发——测量由视图的 `measure()` 显式驱动）
3. `StubElement` 有了 `blur()`

---

### 2.6 阶段 2 新增文件

```text
browser/errors.ts       BrowserHostError（从 tabs.ts 挪出来，tabs.ts 仍 re-export）
browser/limits.ts       所有预算常量（§5 那张表就是它）
browser/inject/dom.ts   注入脚本用的结构化 DOM 接口（主进程 lib 里没有 DOM）
browser/inject/semantics.ts  可序列化的共享判定：hkVisible/hkRole/hkName/hkSensitive/hkInteractive/hkWalk/hkTrim…
browser/inject/elements.ts   hkCollectElements(doc, win, g, opts) → ElementScanResult
browser/inject/text.ts       hkCollectText(doc, win, opts) → TextScanResult
browser/inject/bundle.ts     elementsScript(opts) / textScript(opts) / unwrap<T>(raw)
browser/cdp.ts          pageEvaluator(page) / requirePage(page, tabId)   ← 唯一碰 electron 的一层
browser/snapshotCache.ts SnapshotCache / ownerKey / SnapshotOwner
browser/encode.ts       renderElementRow / elementsHeader / textHeader / paginateLines / clampMaxChars
browser/projection.ts   BrowserProjection：elements() / text() / read(owner, cursor) / dropTab()
browser/debug.ts        临时调试入口，阶段 3 删掉
```

### 2.7 关键签名

```ts
// tabs.ts —— 受限访问器，别再加字段
export interface BrowserPage { tabId; contents: WebContents; contentsId: number; generation: number; domReady: boolean; complete: boolean }
BrowserTabHost.pageFor(tabId): BrowserPage | undefined

// projection.ts —— 不 import electron，靠注入 evaluate，所以整条链可纯测
type PageEvaluator = (script: string) => Promise<unknown>
class BrowserProjection {
  elements(owner: SnapshotOwner, evaluate: PageEvaluator, req: ElementsRequest): Promise<ProjectionPage>
  text(owner: SnapshotOwner, evaluate: PageEvaluator, req: TextRequest): Promise<ProjectionPage>
  read(owner: SnapshotOwner, cursor: string, maxChars?: number): ProjectionPage   // 不再回页面
  dropTab(tabId: string): void
}
interface ProjectionPage { text: string; snapshotId: string; cursor?: string; scanTruncated: boolean; total: number }
```

阶段 3 的工具层只需要：`requirePage(host.pageFor(tabId), tabId)` → `pageEvaluator(page)` → `projection.elements(owner, evaluate, req)`，owner 由 `page` 的三字段拼出来。

### 2.8 落地时与规格的偏差

- **注入不走 CDP**，走 `WebContents.executeJavaScriptInIsolatedWorld`（Electron 43 里这个方法在 `WebContents` 上，**不在** `mainFrame` 上）。文件仍叫 `cdp.ts`，阶段 4 的输入会在那里真的用上 `debugger`。
- **缓存里存的是渲染好的行**（`{ kind, header, lines }`），不是结构化行对象：翻页因此是纯字符串算术，且第二页天然不可能来自第二次扫描。
- **分页按行长累加**而不是每 push 重编码一次——编码结果是逐行拼接，两者答案相同，但累加是线性的，2000 行不会退化成二次方。
- **表是 TSV**：采集侧 `hkTrim` 已经把所有空白折成单空格，所以字段里不可能出现制表符，分隔符零转义成本。
- 输出格式：首行 `# elements  url=…  title=…  total=N  [scanTruncated=true (…)]`，次行列名 `ref/role/name/text/value/href/flags`，末行 `# more: N remaining  cursor=<uuid>:<offset>`。

### 2.9 阶段 2 的测试

`test/browserEncode.test.ts` · `test/browserSnapshotCache.test.ts` · `test/browserProjection.test.ts` · `test/browserInject.test.ts`（共 35 个，全绿）。

最后一个值得单说：它把 `elementsScript()` 产出的字符串丢进 `node:vm`，配一份手写 DOM stub 真跑。**这是唯一能发现「bundle 漏列了某个 hk 函数」的手段**——那种错误编译期完全看不见，只会在真实页面上炸成 `ReferenceError`。结果用 `JSON.parse(JSON.stringify(...))` 过一道，模拟 Electron 的结构化克隆（顺带验证 undefined 键确实不过境）。

### 2.10 阶段 3 新增文件与真实 API

```text
runtime/protocol/browserHost.ts   纯类型 BrowserHost（tools/ 与 desktop/ 唯一的交汇点）
desktop/browser/host.ts           DesktopBrowserHost：tabs + projection + 会话→lane 归属
tools/BrowserTool/constants.ts    工具名、operation 表、只读集合、wait_for_load 预算
tools/BrowserTool/schema.ts       browserInputSchema（严格判别联合）/ browserApiInputSchema（扁平）
tools/BrowserTool/validate.ts     validateBrowserInput / fieldsFor（从 schema 反读字段，防漂移）
tools/BrowserTool/encode.ts       renderTabs / describeTab / hostOf（标签页 TSV）
tools/BrowserTool/prompt.ts       DESCRIPTION
tools/BrowserTool/BrowserTool.ts  createBrowserTool(host)
```

```ts
// 按 sessionId 而不是 lane 定址：工具只知道自己在哪个会话里
interface BrowserHost {
  listTabs(sessionId): Promise<BrowserTabState[]>
  createTab(sessionId, url?): Promise<BrowserTabState>
  closeTab(sessionId, tabId): Promise<void>
  navigate(sessionId, tabId, url): Promise<BrowserTabState>
  waitForLoad(sessionId, tabId, { timeoutMs, signal? }): Promise<BrowserTabState>
  elements(sessionId, tabId, req): Promise<BrowserSnapshot>
  text(sessionId, tabId, req): Promise<BrowserSnapshot>
  readSnapshot(sessionId, tabId, cursor, maxChars?): Promise<BrowserSnapshot>
  screenshot(sessionId, tabId): Promise<BrowserScreenshot>
}
```

`BootstrapOptions.extraTools?: Tool[]` 已加；`main.ts` 模块级 `browserHost` + `browserTool`，`ensureProject` 的 `bootstrap()` 传入。TUI 不传，工具在 TUI 里根本不存在。

**与原计划的偏差（都是有意的）**：

1. **8 个 operation，不是 12。** `page.click/type/scroll/wait_for` 需要 `input.ts`/`wait.ts`，那是阶段 4；提前登记会让模型调用一个必然抛错的能力。工具描述里明说「cannot click, type or scroll yet」。
2. **`browser.create_tab` 也参与 host scoping。** 带 url 的 create_tab 就是一次导航，和 `tab.navigate` 同一件事，没理由让它绕过 domain 规则。不带 url 时返回 `''`，domain 规则自然不匹配。
3. **会话→lane 由 `DesktopBrowserHost` 解析**（`shell?.host.laneForSessionId`）。没有 lane 的会话（窗口还没建、或子 agent 会话）拿到 `BROWSER_UNAVAILABLE` 而不是一个没人看得见的标签页。跨 lane 的 tabId 一律报 `TAB_NOT_FOUND`——别的 lane 的存在不是这个会话该学到的事。
4. **`waitForLoad` 以 `loading` 为准**（`navigate` 同步置 true，所以不会看到上一篇文档的完成态），从没导航过的标签页立即返回而不是等到超时。轮询 100ms，计时用 `performance.now()`。
5. **截图没有单独缓存**：图片进 `ImageAttachmentService`，那里已经有去重与落盘，32MB/60s 那条预算暂时没有对应实现。
6. `permissions.ts` 的 `HOST_SCOPED_TOOLS` 表已落地（`matchesRule` 的 domain 分支 + `buildSessionAllowRule` 两处）。不名 URL 的 operation **不提供** session allow 规则——否则「always allow 一次截图」会变成放行以后所有导航。

测试：`test/browserTool.test.ts`（8 个，纯桩 host）+ `test/permissions.test.ts` 新增 3 个 Browser 用例。

### 2.11 阶段 4 新增文件

```text
browser/input.ts              clickTarget / typeText / scrollPage / enqueueInput / isInputActive
browser/wait.ts               waitForCondition
browser/inject/actions.ts     hkQuery / hkFindTarget / hkResolveTarget / hkScrollPage / hkCheckCondition
```

`BrowserHost` 加了 `click` / `type` / `scroll` / `waitFor`，`BrowserTool` 的四个 operation 同时开放。测试：`test/browserInput.test.ts` · `test/browserWait.test.ts`（inject 的条件脚本进了 `browserInject.test.ts`）。

### 2.12 阶段 5 新增与真实 API

```text
browser/ownership.ts          BrowserOwnership（纯状态机，只 import errors.ts）
```

```ts
export const TAKEOVER_MESSAGE: string   // 错误消息即行为约束，见 §4.3
class BrowserOwnership {
  observeTurn(sessionId, turnId?): { revision: number; released: string[] }
  assertAllowed(sessionId, revision): void      // BROWSER_USER_TAKEOVER 或 OPERATION_ABORTED
  claim(tabId, sessionId): void
  takeOver(tabId): boolean                      // false = 没人可拦（agent 正在关它，或这标签页没主）
  isBlocked(sessionId): boolean
  expectAgentClose(tabId): () => void           // 引用计数
  dropTab(tabId): void
  tabsOf(sessionId): string[]
}
```

其余改动：

- **`BrowserHost` 的第一个参数由 `sessionId: string` 换成 `BrowserCaller { sessionId, turnId? }`。** 回合是地址的另一半：接管只挡到会话的下一个回合，实现必须分得清两个回合。`BrowserTool` 从 `context.currentTurnId` 取，不需要动 loop 一行（与原计划一致）。
- **`tabs.takeOver(tabId)` 现在只上报**，flag 由 `setTakenOver(tabId, boolean)` 落。谁在开这个标签页只有 `host.ts` 知道，没人在开的标签页不存在「被接管」。`onTakeOver(listener)` 是这条通路。
- **页内接管靠 `WebContents` 的 `input-event`**（不是 `before-input-event`：后者只有键盘）。只认 `keyDown` / `mouseDown` / `mouseWheel`，且 `isInputActive(contents)` 为真时一律忽略——CDP 派发的输入同样会触发这个事件，不挡就会被自己的 burst 打断。
- **`host.ts` 的每个 operation 以 `enter(caller)` 开头**：`observeTurn` → 释放 released 标签页的 flag → `assertAllowed`。await 边界用 `guard(caller, revision, signal)`，它同时是取消检查——阶段 3 留下的 `abortCheck` 被它取代。
- **面板的「接管」按钮**在地址栏尾部（`browser-takeover`），接管后变成禁用的「已接管」。没有「归还」按钮：归还就是用户发下一条消息。
- **`DesktopBrowserHost.dispose()`** 新增（退订 `onTakeOver`），`main.ts` 在 `browserTabs.dispose()` 之前调用。

顺带修掉一个真 bug：`inject/bundle.ts` 现在在脚本头部补一行 `__name` 恒等 shim。被 stringify 的是**编译后**的源码，esbuild 的 `--keep-names`（tsx 就是这么跑的）会把函数体里的 `const f = () => …` 改写成对模块级 `__name` 的调用，而那个 helper 不会跟着 `toString()` 过境——`page.wait_for` 在真页面上必然炸 `ReferenceError`。`browserInject.test.ts` 正是为这类错误存在的。

测试：`test/browserOwnership.test.ts`（6 个）+ `rendererBrowserPanelView.test.ts` 新增接管用例。

## 3. 不变量

改代码时这些不能破：

1. **`src/tools/` 永远不 import electron。** TUI 共用那份注册表。工具靠依赖注入拿 host（见 §4.3）。
2. **`generation` 只在 `beginNavigation()` 里 `+1`。** 任何缓存页面投影的东西都以它为准。改尺寸、隐藏、重挂载都不能看起来像换了文档。
3. **渲染层不 value-import** `harness/` `services/` `sessions/` `commands/` `tui/`（`test/rendererImports.test.ts` 守着）。
4. **「洞」的几何诚实**：占位元素和它到 `#shell` 之间不能有 `transform` 祖先；面板的框用 `outline` 不用 `border`（`border` 会进 `getBoundingClientRect()`）。
5. **原生视图不受样式约束**：`overflow`/`border-radius`/被别的面板盖住/窗口隐藏——统统不会让它停止绘制，必须显式 `setVisible(false)` 告诉它。
6. **卸载即隐藏**：视图 `dispose()` 必须推一次 `visible: false`，否则会留下一张悬在窗口上、底下什么都没有的网页。
7. **几何推送是 fire-and-forget**，不进 pending 账本。
8. 面板下沿贴底、只有上圆角——因为原生视图不被 `border-radius` 裁剪，圆角处会露出方角页面。

---

## 4. 各阶段

### 4.1 阶段 3 — 工具接入（已完成，见 §2.10）

以下为当初的计划原文，保留是因为它写了**为什么**这么设计；实际落地与它的差异列在 §2.10。

#### 原计划

新增 `src/runtime/protocol/browserHost.ts`（纯类型接口 `BrowserHost`，tools/ 与 desktop/ 共用）和 `src/tools/BrowserTool/{BrowserTool,schema,validate,encode,prompt,constants}.ts`。

**12 个 operation，一个工具**：
```
browser.get_state  browser.create_tab  browser.close_tab
tab.navigate  tab.wait_for_load
page.elements.snapshot  page.text.snapshot  page.screenshot
page.click  page.type  page.scroll  page.wait_for
```

- `inputSchema` 是严格的 zod discriminated union；`apiInputSchema`（`harness/types.ts` 上的逃生口）是**手写扁平 JSON Schema**：properties 取并集，`required` 只留共有的（实际只有 `operation`）。
- 代价要认：schema 不再自描述必填项。所以 `validateInput` 必须把失败加工成**可执行的教学文本**——分支级报错、缺 `tabId` 配专属补救指令（"Get tabId from browser.get_state or browser.create_tab"）、兜底才用 zod 原始 issue。目标是模型下一轮自愈。
- 其余字段：`riskLevel: 'confirm'`（照 `WebFetchTool` 的理由，绝不 `'safe'`）、`shouldDefer: true`、`isConcurrencySafeInput` 按 operation 判定。
- 在 `src/tools/inputAliases.ts` 的 `SPECS` 注册 `Browser` 的别名与数字强转。

**注入路径**（`src/tools/index.ts` 不改）：
```
main.ts 模块级 browserHost
  → ensureProject(cwd, { extraTools: [createBrowserTool(browserHost)] })
    → bootstrap(options)
      → bootstrap.ts:162  new ToolRegistry([...await getAllTools(bg), ...options.extraTools ?? []])
```
需要给 `BootstrapOptions`（`src/runtime/types.ts`）加可选 `extraTools?: Tool[]`。TUI 不传，工具自然不存在。

> 注意：`main.ts` 里的 `browserTabs` **已经是模块级**，正是为此——`openProject` 先 `ensureProject`（建 `ToolRegistry`）后 `ensureShell`，工具注册时窗口还不存在。

**截图**照 `src/tools/FileReadTool/FileReadTool.ts` 的 `tryReadImage` 四步：查 `getSupportsImageInput?.()` → 查 `context.imageAttachments` → `importImage(sessionId, bytes, name)` → 返回 `{ images: [ref] }`。**`content` 里绝不出现 base64**（`test/helpers/imageFixtures.ts` 的 `assertNoImageBytes` 查这个）。裁剪用已在依赖里的 `sharp`，不引 `nativeImage`。

**权限**：`src/harness/permissions.ts` 把 host scoping 硬编码在 `WebFetch` 上，需泛化成一张 `HOST_SCOPED_TOOLS`（工具名 → URL 提取器）表，改两处：`matchesRule` 的 domain 分支、`buildSessionAllowRule`。`Browser` 只在 `tab.navigate` 时返回 URL，其余 operation 返回 undefined，domain 规则自然不匹配。**不要**把 `PREAPPROVED_HOSTS` 扩展到 Browser——那是 fetch-only 的静默放行名单。

### 4.2 阶段 4 — 输入与等待（已完成，见 §2.11）

以下为当初的计划原文；四个 operation 与 `browser/input.ts`、`browser/wait.ts`、`inject/actions.ts` 都已按它落地。

#### 原计划

`browser/input.ts` + `browser/wait.ts`，外加把 `page.click` / `page.type` / `page.scroll` / `page.wait_for` 这四个 operation 接进 `BrowserTool`（schema 的判别联合、`validate.ts` 的字段表、`READ_ONLY_OPERATIONS` 之外、`prompt.ts` 里那句 "cannot click, type or scroll yet" 要一并删掉）。`BrowserHost` 接口同步加方法——它是唯一的交汇点，改它就够。

- **每 tab 一条串行 Promise 链**，链上 `.catch(() => void 0)` 断开（一个输入失败不毒化后续）。队列自清理要比对任务身份（`if (pending.get(contents) === task)`），否则会删掉后来者的任务。
- `setInputActive` 用 `finally` 包住整段；这个标志同时是阶段 5 接管守卫的依据。
- 每个 await 前后插 `check()`，取消粒度到单条 CDP 命令。
- macOS 下 `Meta+a/c/x/v/z` 要走 CDP 的 `commands` 字段（`selectAll`/`copy`/…），否则系统编辑快捷键不生效。
- 等待：轮询 `Math.min(100, timeout)`，计时用 `performance.now()`（单调）。每次 await 后重新比对世代，文档变了就把结果降级成 evidence 而非报错。用错误对象上的 `retryable` **字段**区分"页面还没好"和"浏览器没了"。超时抛的错误自带 `lastObserved`，初值 `"Not observed yet."`。

### 4.3 阶段 5 — 抢占仲裁（已完成，见 §2.12）

以下为当初的计划原文；实际落地与它的差异列在 §2.12。

#### 原计划

`browser/ownership.ts`。**比 Kimi 简单一半**：`ToolContext` 已经带 `sessionId` 和 `currentTurnId`（turnId 在 `src/harness/loop.ts:502` 铸造），整个仲裁**不需要动 loop 一行**。

五个容器：`tabOwner` / `blocked` / `revisions` / `turns` / `agentClosing`（引用计数）。

每个 operation 入口两件事：
1. `observeTurn(sessionId, currentTurnId)` —— turnId 变了即新回合：解除 blocked、`revision += 1`。**接管自动解除，没有"归还控制"这个概念**；revision 递增让在途操作在下一个检查点自然作废。
2. `assertAllowed(sessionId, revision)` —— 被阻断就抛 `BROWSER_USER_TAKEOVER`。

`assertAllowed` 在每个 await 边界要调用**两次**（派发前、异步返回后），否则等待期间被抢走控制拦不住。

错误消息本身就是行为约束（比写在 system prompt 里更难被忽略）：
> The user has manually taken over the browser. Stop browser actions and ask the user what they would like to do next. Do not retry during this turn; control returns when the user starts a new turn.

**agent 自己关 tab 不算接管**：`expectAgentClose(tabId)` 返回 disposer，引用计数处理并发关闭。触发接管的三个事件：页面内 `keyDown`、页面内鼠标按下/滚轮、面板「接管」按钮；前两个的守卫是 `!isInputActive(contents)`（agent 正在输入时用户敲键不触发，避免自动化 burst 打到一半被抢）。

---

## 5. 预算与错误码

| 值 | 用处 |
|---|---|
| 快照缓存 16 MB / TTL 120s / 最多 32 条 / FIFO | 快照是一次性顺序读的，不需要 LRU 的热度 |
| 截图缓存 32 MB / TTL 60s | 与快照是两个不同的数，不是笔误 |
| `maxChars` 2048–24000，元素默认 8000、文本默认 12000 | |
| `limit` 默认 100 | |
| `page.wait_for` 默认 10s / 上限 30s | |
| `tab.wait_for_load` 默认 15s / 上限 120s | |
| 页内：100ms 墙钟 / 10,000 节点 / 2,000 条 | |
| name ≤ 500，text/value ≤ 1000 | |

错误码（靠 `code` 字段分流，不靠子类）：
`BROWSER_USER_TAKEOVER` · `TAB_NOT_FOUND` · `PAGE_NOT_READY` · `NAVIGATION_FAILED` · `INVALID_REQUEST` · `OPERATION_ABORTED` · `BROWSER_UNAVAILABLE`（带 `retryable: true`）· `SNAPSHOT_EXPIRED` · `OUTPUT_LIMIT` · `WAIT_TIMEOUT` · `ELEMENT_NOT_INTERACTABLE` · `STALE_ELEMENT`

---

## 6. 安全

- 被控页面拿不到宿主能力：`sandbox` + `contextIsolation` + 无 `nodeIntegration` + **不注入 preload**
- 自动化在 isolated world 1001，与页面主 world 分离
- 独立持久分区，cookie 与主界面渲染器存储分开
- **敏感字段不参与 accessible name 兜底**：`autocomplete` 命中 `current-password`/`new-password`/`one-time-code`/`cc-number`/`cc-csc`，或 `input[type=password]` → text 强制置空、value 不下发。词表集中一处传给注入脚本。
- `main.ts` 的 `guardNavigation` 是给 app shell 那一个 `loadFile` 页面用的（拒绝一切 in-window 导航），**不能套用到浏览器 view**——后者本来就要导航到任意 URL，它有自己的策略（拦非 http(s)、popup 变新 tab）。

---

## 7. 验证

```bash
npm run typecheck          # 四个配置
npm test -- test/rendererBrowserPanel.test.ts
npm test -- test/rendererBrowserPanelView.test.ts
npm test                   # 全量
npm run build:desktop && npm run start:desktop
```

**全量套件基线**：阶段 5 落地后是 3548 tests / 25 fail（阶段 3 时为 3515 / 25，阶段 2 时为 3445 / 26）。失败项是环境性的（依赖 ripgrep 的 grep 用例、`ImageAttachmentService`、Windows 路径用例），且在 25–27 之间抖动。判断有无回归要跟这个基线比，别当成全绿仓库。

**优先写纯模型测试**（不需要 Electron）：`ownership.ts` 是纯状态机，完全不碰浏览器；`schema`/`validate`/`encode`/`snapshotCache` 都是纯函数。DOM 测试用 `test/helpers/domStub.ts`；新 DOM 测试要同时加进 `tsconfig.domtest.json` 的 `include` 和 `tsconfig.json` 的 `exclude`（有测试断言两张表一致）。

---

## 8. 已知待办

- ~~窗口 `minWidth` 仍是 900~~ 已改成 1000，面板默认宽度同时由 480 收到 408（侧栏 280 之后给 transcript 留约 310px）。面板宽度存在 `localStorage`，拖过分隔条的用户不受新默认值影响。
- **真页面验收尚未做**：`browser/debug.ts` 与 `maybeRunBrowserProbe` 已随阶段 3 删除，现在唯一的真页面入口就是让模型调用 `Browser` 工具本身。采集脚本至今只被 stub DOM 与 `node:vm` 验证过，真站点上跑一次仍是必须的。
- **截图路径没跑过真图**：`capturePage()` 在标签页不可见时返回 0×0，代码里以 `PAGE_NOT_READY` 报出并建议打开面板；这条分支只被推理过，没被观察过。
- **接管路径没在真页面上验过**：`input-event` 的守卫（agent 打字时用户敲键不该触发）是推理出来的，没被观察过。
- 阶段 1 的肉眼验收尚未做：开面板 → 导航 → 拖分隔条 → 切 lane 看标签页是否跟随 → 关 lane 确认无残留网页。
- `smoke-desktop.mjs` 尚未覆盖面板（CDP 截图**能**拍到 `WebContentsView` 内容，见 `scripts/smoke/cdp.mjs` 开头的说明，所以"洞被正确盖住"可以直接截图断言）。
