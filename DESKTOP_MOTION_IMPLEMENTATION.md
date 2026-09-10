# Hanekawa Desktop 动效与交互实现技术文档

日期：2026-09-08
配套设计稿：[DESKTOP_MOTION_DESIGN.md](./DESKTOP_MOTION_DESIGN.md)
扫描基线：Git `2c6ae3d`，`src/desktop/renderer/`
状态：任务分解与实施计划；本文件不代表任何任务已经完成。

本文件把设计稿拆成 **22 个会话目标**（M01–M22），每个的规模按“一次会话内可以做完、跑绿窄测、提交一次”设计。设计决策以设计稿为准，本文件只负责“按什么顺序做、一次做多少、做到什么程度算完成”。

设计稿第 8 节给出的四步顺序是本文件分组的依据：**先恢复连续性（阶段一）→ 再统一呈现生命周期（阶段二）→ 落实 transcript 交接（阶段三）→ 最后调节节奏和强调（阶段四）**。顺序不能颠倒：在节点还会被重建的情况下调曲线，调出来的是错觉。

---

## 0. 使用方式

### 0.1 `[ ]` 是会话目标

方括号标在**会话**上，不标在更细的工作项上。一个方括号 = 一次会话 = 一个 commit。

- `[ ]` 未开始
- `[~]` 进行中（会话中途结束时用，必须同时在该会话的「本次进展」行写清做到哪一步）
- `[x]` 已完成并已提交
- `[-]` 已确认不做（必须写明原因）

第 1.2 节的总览表与各会话标题的方括号必须同步；只改一处视为未完成。

### 0.2 一次会话的工作流

1. 打开本文件，找到第一个 `[ ]` 的会话，从它的「目标 / 前置 / 涉及文件 / 工作项」开始——每个会话块都写成可以冷启动的形式，不需要先读完整份文档。
2. 读设计稿对应章节，再读「涉及」列出的文件与它们最近的测试文件。
3. 按「工作项」顺序实现，保持无关工作区改动不被顺带修改（当前工作区已有多模态输入相关的未提交改动，不要卷进来）。
4. 跑「验证」里的窄测试；跨层会话追加 `npm run typecheck`。
5. 全绿后把该会话的 `[ ]` 改成 `[x]`，总览表同步。
6. 提交：代码改动 + 本文件的标注放在**同一个 commit**：

   ```
   checkpoint: M04 keep nested painter nodes alive across cache hits
   ```

### 0.3 会话没做完怎么办

不要硬撑到上下文耗尽。规模标为「长」的会话都给了**建议断点**，到断点就：

1. 把该会话状态改成 `[~]`，在「本次进展」写明完成到第几个工作项。
2. 提交当前已通过测试的部分（`checkpoint: M05 (1/2) ...`）。
3. 下次会话从「本次进展」接着做，做完再改 `[x]`。

**每个 commit 之后仓库都必须 `npm run typecheck` 通过。** 允许动效尚未接通（状态机已加、样式未接），不允许留下类型错误或红测试。

### 0.4 工程约定（所有会话适用）

来自 `CLAUDE.md` 与设计稿第 8 节，每个会话都适用，块内不再重复：

- 相对导入带 `.js` 扩展名。renderer **不得** value-import `harness/`、`services/`、`sessions/`、`commands/`、`tui/`（`test/rendererImports.test.ts` 守这条）。
- **纯决策进 `renderer/model/`，DOM 与事件进 `renderer/dom/` 或 app shell。** 状态机、相位、时长常量属于 model；`addEventListener`、`focus()`、`classList` 属于 dom。不把决策放进 Electron 入口。
- **禁止 `innerHTML`**（`dom/dom.ts` 开篇的硬规则）。新节点一律经 `el()` / `append()` / `replace()` / `reconcile()`。
- 需要保留节点身份的地方用 `reconcile()`，**不用 `replace()`**：`replaceChildren` 会让每个子节点离开文档一次，CSS 动画因此被取消重启，`overflow-anchor` 也失去锚点。
- 每个浮层保留三种关闭方式：`dom/dismiss.ts` 的 `onPressOutside`（作用域是浮层**及其触发器**，不是外面那条 bar）、`focusout`、Escape。`focusout` 且 `relatedTarget === null` 是视图自身重绘，必须忽略。paint 内的 `focus()` 放在最后——它同步触发 `focusout`，重入的 paint 必须是最后生效的那个。
- 动画必须**可中断、可反向、可取消**，并在 pane 隐藏或销毁时清理。`transitionend` / `animationend` 处理器要过滤 `event.target` 与动画／属性名；每个等待结束的相位都要有兜底计时器（隐藏窗口不跑 transition，`prefers-reduced-motion` 压到 1ms，`display: none` 祖先直接取消）。
- **业务不等动画**：权限答复、焦点回归、阻塞请求结算、`onShellChanged` 不依赖动画时长。
- 时长与曲线只能来自 `styles.css` 的 `--motion-*` / `--ease-*` token；`test/rendererStyleTokens.test.ts:1697` 的「motion comes from the tokens」用例扫描所有 `transition` 声明，写死数值会红。改 token 值必须同步该文件的断言（当前钉在 `--motion-fast: 140ms`、`--motion-base: 220ms`、`--motion-slow: 320ms`、`--ease-standard: cubic-bezier(0.32, 0.72, 0, 1)`、`--ease-exit: cubic-bezier(0.4, 0, 1, 1)`）。
- 样式表只允许一个嵌套 at-rule：末尾的 `@media (prefers-reduced-motion: reduce)`（token 测试显式点名）。新增媒体查询会让该测试红。
- DOM 测试用 `test/helpers/domStub.ts`，纯决策优先写 model 测试。

---

## 1. 会话总览

### 1.1 依赖链

```text
阶段一 恢复连续性
M01 ─┬─> M02 ─> M03 ─┐
     ├─> M04 ─> M05  │
     ├─> M06         ├──> 阶段一完成
     ├─> M07         │
     ├─> M08         │
     └─> M09 ────────┘
                     │
阶段二 呈现生命周期   ├──> M10 ─┬─> M11 ─> M12
                     │         └─> M13
                     │                │
阶段三 transcript 交接│                ├─> M14 ─> M15 ─> M16
                     │
阶段四 节奏与强调     └──> M17 ─> M18
                             M19
阶段五 验收                        M20 ─> M21 ─> M22
```

自动折叠策略（设计稿 §7）已定为**方向 A**（2026-09-09，用户决定），M14 及下游 M15／M16 无阻塞项，详见附录 A。

M02–M09 在 M01 之后互不依赖，顺序可调；建议先做 M02/M03（F1，设计稿列为「首先修复」且影响最大），再做 M04/M05。M17 的曲线调整必须等阶段一、二落地，否则调的是被重建掩盖的假象。

### 1.2 总览表

| # | 会话目标 | 前置 | 规模 | 对应发现 | 状态 |
| --- | --- | --- | --- | --- | --- |
| M01 | 动效回归测试地基：节点身份与动画启动计数 | — | 中 | §2 证据分级 | `[x]` |
| M02 | F1 回合存活状态：model 层分离「回合活着」与「步骤完成」 | M01 | 中 | F1 | `[x]` |
| M03 | F1 DOM 接线：折叠与默认展开读同一套回合状态 | M02 | 中 | F1 | `[x]` |
| M04 | F2 painter 存活登记与内容更新分离 | M01 | 中 | F2 | `[x]` |
| M05 | F2 思考正文与 assistant Markdown 稳定块 | M04 | 长 | F2 | `[x]` |
| M06 | F3 会话标题栏：菜单容器不随快照重建 | M01 | 中 | F3 | `[x]` |
| M07 | F4 任务面板：内部节点身份与 `animationend` 过滤 | M01 | 中 | F4 | `[x]` |
| M08 | F4 设置开关：滑块保留身份、按字段更新 | M01 | 中 | F4 | `[x]` |
| M09 | F4 完成反馈绑定状态边沿，区分实时与历史 | M01 | 中 | F4 | `[x]` |
| M10 | 通用呈现相位状态机（model 层） | M02–M09 | 中 | F5 | `[x]` |
| M11 | 小浮层接入相位：菜单、补全、命令面板、tooltip | M10 | 长 | F5 | `[x]` |
| M12 | 模态、设置页、rewind 接入相位；遮罩与面板分离 | M10 | 中 | F5 | `[x]` |
| M13 | 内容展开／收起的双向连续过程 | M10 | 中 | F5 | `[ ]` |
| M14 | 自动折叠策略落地（方向 A） | M13 | 中 | §7 | `[ ]` |
| M15 | 视口策略统一：定位、跟随、锚点保护、结束整理 | M14 | 长 | F7 | `[ ]` |
| M16 | 权限请求形态交接与 transcript 可用高度 | M15 | 中 | §4 | `[ ]` |
| M17 | 语义时长 token 与更均匀的曲线 | M10–M13 | 中 | F5 | `[ ]` |
| M18 | 单一运行信号：去掉叠加的呼吸／光晕／扫光 | M17 | 中 | F6 | `[ ]` |
| M19 | 减少动态效果覆盖 CSS、JS 滚动与动画结算 | M15, M17 | 中 | F7 | `[ ]` |
| M20 | 全量 typecheck／测试／构建 | M16–M19 | 短 | — | `[ ]` |
| M21 | 三个代表场景的实机逐帧比较 | M20 | 中 | §9 | `[ ]` |
| M22 | 剩余验收矩阵、`README.md` 与签收 | M21 | 中 | §9 | `[ ]` |

规模含义：短 = 半场会话即可；中 = 一次会话舒适完成；长 = 需要盯紧上下文，块内给了建议断点。

---

## M01 `[x]` 动效回归测试地基：节点身份与动画启动计数

**验收记录（2026-09-10）**：节点身份／移除／动画类重启追踪已接入；桩支持 `animationName` 与可控 `matchMedia`。解除标注后 M02／M03／M04／M06 四条回归均实际失败；恢复标注后指定窄测 92 通过、4 待修复，`npm run typecheck` 通过。

**前置**：无 · **规模**：中 · **设计稿**：§2、§9
**涉及**：`test/helpers/domStub.ts`、新增 `test/helpers/motion.ts`

设计稿第 2 节说得很明白：现有 84 项通过的测试**不验证 CSS 动画的实际播放过程**，断言某个 CSS 数值存在也不能替代动效验收。后面 18 个会话每一个都要证明「同一个节点还在、动画没重播」，这份地基必须先有，否则每个会话都会各写一套一次性断言。

**工作项**

1. 新增 `test/helpers/motion.ts`，提供三个能力：
   - **节点身份追踪**：给定容器与选择器，记录多次 render 之间某个节点是否是同一个对象引用（`trackIdentity(root, '.step-head')` → 每次采样返回节点，测试断言 `===`）。这是 F1／F2／F3／F4 全部四项的共用断言形式。
   - **重建计数**：统计某选择器下节点被替换的次数，用于「刷新 10 次，菜单被替换 0 次」这类断言。
   - **动画启动计数**：`domStub` 不跑真实 CSS，所以计数的对象是**触发条件**——节点离开过文档、`className` 上的动画类被移除后重新加上。把这两种「会重启动画」的事件记录下来，作为「不重播」的可判定代理。
2. 给 `domStub` 补齐动效相关的事件能力：确认可以派发带 `animationName` 的 `animationend`（现有 `StubEventInit` 已带 `transitionend` 的 `propertyName`，见 `test/helpers/domStub.ts:53`，按同样形状加 `animationName`），以及 `window.matchMedia` 的可控桩——M19 要用它测 `prefers-reduced-motion`，目前整个 renderer 只有 `app.ts:128` 的 `prefers-color-scheme` 用到 `matchMedia`，桩里没有。
3. 用现有的 F1／F2／F3 复现序列写三条**当前应当失败**的回归测试，落在各自的既有测试文件里（`rendererTranscriptView`、`rendererThinking`、`rendererCanvasHeaderView`），并用 `{ skip: true }` 或 `todo` 标注，注释指向本文件对应的 M 编号。它们在 M02／M04／M06 里被解除标注并转绿——这样每个修复会话开场就有一个可执行的失败用例。
4. 不引入任何动效框架、不引入无头浏览器。实机验证是 M21 的事。

**完成判据**：`test/helpers/motion.ts` 能被三个既有 renderer 测试文件引用；三条标注的回归测试描述准确、解除标注后确实红。
**验证**：`node --import tsx --test test/rendererTranscriptView.test.ts test/rendererThinking.test.ts test/rendererCanvasHeaderView.test.ts test/rendererRepaint.test.ts`
**提交**：`checkpoint: M01 add motion regression helpers and pending cases`

---

## M02 `[x]` F1 回合存活状态：model 层分离「回合活着」与「步骤完成」

**验收记录（2026-09-10）**：选择显式 `live` 参数，与标题使用相同来源；手动选择优先，中断不会被 live 复活。M02 回归转绿，指定模型测试 79 通过，typecheck 通过。DOM 接线由 M03 完成。

**前置**：M01 · **规模**：中 · **设计稿**：F1、§6.1
**涉及**：`src/desktop/renderer/model/transcript.ts`、`src/desktop/renderer/model/thinking.ts`、`src/desktop/renderer/model/waiting.ts`

问题在 `turnEntries`（`transcript.ts:1160`）：`running` 只看步骤里有没有 `pending`，所以最后一个工具返回、下一次推理还没开始的那一刻，整组就变成 `done`；`isGroupExpanded`（`thinking.ts:61`）又直接读这个 `status`，于是组收起、步骤被移除，下一个工具开始时再重建一遍。

真实的回合状态**已经存在**：`turnActivity(entries, input)`（`waiting.ts:108`）从会话自己的 `isStreaming` / `turnId` 算出 `liveGroupId`，组标题的可访问名 `groupHeaderName(group, live)` 就是靠它才没有在工具间歇里播报「已完成」（`thinking.ts:186` 的注释把这件事讲透了）。这个会话要做的是让**折叠**也读同一个来源。

**工作项**

1. 让 `ActivityGroup` 的状态能表达三件不同的事，而不是两件：步骤层面的进展、回合是否已结束、是否被中断。具体做法二选一，选定后在代码注释里写明理由：
   - 保持 `status` 不变，把 `live` 作为显式参数贯穿到 `isGroupExpanded` / `isStepExpanded`（改动最小，和 `groupHeaderName(group, live)` 已有的形状一致）；
   - 或者在 `groupTranscript` 的调用方把 `live` 合进 `ActivityGroup`（视图层读单一对象，但要保证 `groupTranscript` 仍是纯函数、`live` 由调用方注入）。
2. `isGroupExpanded(group, state, live)`：**`live === true` 时默认展开**，不再看 `status === 'running'`。用户手动选择（`DisclosureState` 里的绝对值）**始终优先**——这是 `thinking.ts` 开篇注释已经确立的规则，不能被新逻辑绕过。
3. `defaultStepExpanded` 同步：`group.status === 'running' && index === last` 里的第一个条件换成回合存活。失败步骤自开、等待授权步骤不自开这两条不变。
4. 中断（`interrupted`）优先级高于一切，保持现状：`turn_interruption` 记录决定 `aborted`，live 不能把已中断的回合说成还活着。
5. `groupHeaderLabel` / `groupActivityLabel` 的既有语义不动——设计稿说的是「标题已经对了，折叠错了」。

**完成判据**：M01 里那条 F1 用例转绿：`isStreaming: true` 的三步序列（工具执行中 → 工具返回 → 下一工具开始）里，组的展开状态**恒为展开**，`steps` 不被移除也不被重建。用户手动收起后，后续步骤到达不把它重新打开。
**验证**：`node --import tsx --test test/rendererThinking.test.ts test/rendererTranscriptModel.test.ts test/rendererWaiting.test.ts`
**提交**：`checkpoint: M02 base group disclosure on real turn liveness`

---

## M03 `[x]` F1 DOM 接线：折叠与默认展开读同一套回合状态

**验收记录（2026-09-10）**：组与步骤的展开读取真实 live 回合；live 组使用 running class。短工具交接保持 group、steps、step 身份，手动折叠优先。指定窄测 68 通过、1 项待 M04；`npm run typecheck` 通过。

**前置**：M02 · **规模**：中 · **设计稿**：F1
**涉及**：`src/desktop/renderer/dom/transcriptView.ts`

**工作项**

1. `groupNode`（`transcriptView.ts:530`）把 M02 的 live 传进 `isGroupExpanded`。它已经有 `const live = painter.liveGroupId === group.turnId`，本会话只是让展开判断也用上它。
2. class 列表的语义对齐：设计稿实测到的 `activity-group done live collapsed` 是自相矛盾的组合。live 期间不应出现 `done`——要么让 class 也走回合状态，要么在样式侧明确 `live` 覆盖 `done`。二选一，并在 `styles.css` 对应块写清楚哪一个是权威。
3. `stepsNode` 在收起时返回 `undefined`，正文因此离开 DOM——这是既有的折叠语义，**保留**（设计稿 §5.3 也要求收起完成后正文移出 DOM）。本会话只保证它不再因为工具间歇而触发。
4. 检查 `painter.node('group:…')` 的签名 `[head, steps]`：`steps` 为 `undefined` 与为节点之间来回切换正是重建的入口。M02 之后这个切换在一个回合内不该发生，用测试钉住。
5. 顺带核对：`stepNode` 的 `expanded` 变化会让 `step:` 节点的签名变化并重填，`.step.tool:not(.collapsed)` 上的 `unfold` 动画因此重播。回合内不再反复切 `collapsed` 后这条自然消失，不要在本会话额外改 `unfold`——那是 M13 的事。

**完成判据**：DOM 层复现设计稿 F1 表格的三个时机，组节点、steps 节点、每个 step 节点全程同一引用；`collapsed` class 在回合内不出现。
**验证**：`node --import tsx --test test/rendererTranscriptView.test.ts test/rendererRepaint.test.ts`
**提交**：`checkpoint: M03 stop activity groups collapsing between tools`

---

## M04 `[x]` F2 painter 存活登记与内容更新分离

**验收记录（2026-09-10）**：缓存记录 fill 中的子 key，命中时递归登记存活，refs 使用同一集合清理；真实 generation 重置清空缓存。无变化快照后的标题、状态线与当前 disclosure 引用均保持，reset 重用 id 不继承旧引用。指定窄测 77 通过，typecheck 通过。

**前置**：M01 · **规模**：中 · **设计稿**：F2
**涉及**：`src/desktop/renderer/dom/transcriptView.ts`

问题在 `createPainter` 的 `node()`（`transcriptView.ts:468`）：`live.add(key)` 只在 `node()` 被调用时发生，而**内层 `node()` 调用写在外层的 `fill` 里**（`thinkingStep` 在 `transcriptView.ts:672` 的 fill 内部建 `thinking-head:` 节点）。外层命中缓存时 `fill` 不执行，内层的 key 这一帧没人认领，`prune()`（`transcriptView.ts:493`）就把它删了。节点当时还在页面上，但下一次文字增量会重建标题和扫光线——正是设计稿 F2 表格里「相同内容刷新 → 思考 ABC」那一格的 `否`。

同一个机制也会吃掉 `painter.ref`（`transcriptView.ts:483`），`thinkingStep` 的注释已经点出「ref 必须挂在 head 自己的 key 上」，但它保护的是 key 的选择，不是缓存命中这条路径。

**工作项**

1. 让存活登记与「是否需要重填」彻底分开。推荐做法：`node()` 在缓存命中时，把该 key **子树登记过的 key 一并标活**——即缓存条目除了 `node` 和 `signature`，再记一份 `children: readonly string[]`（这一次 fill 期间被登记的 key），命中时递归标活。
   - 备选做法（更简单但更粗）：`prune()` 只删除**其 `node` 已不在 `column` 子树内**的 key。若选它，必须说明为什么不会让缓存无限增长（`transcript-reset` 的清理路径要一起核对）。
   - 无论哪种，`prune()` 对 `refs` 的清理必须与 `cache` 用同一份存活集合，否则 head 会拿着第一帧的 ref 永远报告「已折叠」。
2. 保证 `transcript-reset` 与会话切换仍然彻底清空 `cache` 与 `refs`——`pruneDisclosure`（`thinking.ts:117`）的注释解释了为什么陈旧条目在新方案下更危险：手动答案是绝对值，不会被默认值纠正。
3. 不在本会话改任何 `fill` 的内容策略；这一步只修存活性。

**完成判据**：M01 里那条 F2 用例转绿——「思考 A → 思考 AB → 相同内容刷新 → 思考 ABC」四步中，`.thinking-step-head` 始终是同一节点，`.step-rule` 从未离开过文档；`prune` 在一次真正的 `transcript-reset` 后仍然清空缓存。
**验证**：`node --import tsx --test test/rendererTranscriptView.test.ts test/rendererThinking.test.ts`
**提交**：`checkpoint: M04 keep nested painter nodes alive across cache hits`

---

## M05 `[x]` F2 思考正文与 assistant Markdown 稳定块

**验收记录（2026-09-10）**：思考正文载体持久化；Markdown 以源位置分块并标明闭合状态，按解析语义复用节点，后到的链接定义仅更新受影响块。围栏、列表、表格、公式收口及流式 meta 缺省均覆盖。指定窄测 103 通过，typecheck 通过；仍使用 `katex.render`。

**前置**：M04 · **规模**：长 · **设计稿**：F2、§5.3
**涉及**：`src/desktop/renderer/dom/transcriptView.ts`、`src/desktop/renderer/dom/markdownView.ts`、`src/desktop/renderer/model/markdown.ts`

M04 修的是标题；正文仍然每次重建：思考正文是 `el('div', 'step-body', step.text)`（`transcriptView.ts:697`），每次文字变化都是新 div；assistant 消息是 `markdownChildren(item.text)`（`transcriptView.ts:1118`），一次增量重生成整条消息的 Markdown 子树——已经写完的第一段在第二段继续输出时也被替换。设计稿 §5.3 明确要求：正文连续可见，不用逐 token 淡入，也不用整块透明度变化掩盖重建。

**工作项**

1. **思考正文载体保持身份**：`step-body` 成为一个持久节点，文字增量只写 `textContent`。注意它是折叠的一半——`.step.thinking` 是 `grid-template-rows: auto 1fr` 的两轨网格，收起时正文整个移出 DOM（保留这条语义）；本项只要求「展开期间不换 body 节点」。
2. **Markdown 分块**：`model/markdown.ts` 已经是纯的（`marked` 私有实例 + TeX 查找扩展），把它的产出从「一整棵树」改成「一列块」，每块带一个稳定标识与一个「是否已闭合」的标记。未闭合的结构（还没收口的代码围栏、列表、表格、`$$` 公式）允许整块替换；已闭合的块必须复用。
3. `dom/markdownView.ts` 按块 `reconcile`：已稳定的块直接复用旧节点，只有变化的块重建。**KaTeX 仍走 `katex.render` 的 DOM 树形式**，不能改成 `renderToString`——`dom/dom.ts` 的 innerHTML 禁令仍然有效。
4. **建议断点** —— 思考正文（工作项 1）与 Markdown 分块的 model 部分（工作项 2）绿了就提交一次，DOM 接线（工作项 3、5）下次继续。
5. 结构收口单独验证：一个块从「未闭合」变成「已闭合」时会重建一次，这是允许的；要保证它**只重建那一块**，不带走整条消息。围栏、列表、表格、公式四种各写一条用例。
6. `metaRow`（`transcriptView.ts:1157`）跟着正文走，保持它在流式期间「没有记录就不出现」的现状，不要因为分块而让它闪现。

**完成判据**：连续增量下 assistant 消息的第一个已闭合块全程同一节点；四种结构的收口只重建自身；思考正文在展开期间同一节点；`test/rendererMarkdown.test.ts`、`test/rendererMarkdownView.test.ts` 无回归。
**验证**：`node --import tsx --test test/rendererMarkdown.test.ts test/rendererMarkdownView.test.ts test/rendererTranscriptView.test.ts` + `npm run typecheck`
**提交**：`checkpoint: M05 keep settled markdown blocks across streaming deltas`

---

## M06 `[x]` F3 会话标题栏：菜单容器不随快照重建

**验收记录（2026-09-10）**：完整视图签名跳过相同快照；标题、输入、菜单及操作项保留身份并按字段更新，入场由 hidden 边沿门控。10 次快照、标题与确认内容变化均不重建菜单，三种关闭路径及重命名焦点通过。相关测试含样式 64 通过，typecheck 通过。

**前置**：M01 · **规模**：中 · **设计稿**：F3
**涉及**：`src/desktop/renderer/dom/canvasHeaderView.ts`、`src/desktop/renderer/app.ts`、`src/desktop/renderer/model/canvasHeader.ts`

`paneSession.ts` 的 `statusRepaint` 每个快照都调 `onShellChanged`，`app.ts:260` 在里面调 `renderCanvasHeader()`；`render()` 每次都新建 `menuShell` 和 `.canvas-menu`（`canvasHeaderView.ts:142`、`:147`），而 `.canvas-menu` 固定带 `drop-in`（`styles.css:4417` 一带）。菜单打开后以完全相同的数据刷新 10 次，菜单被替换 10 次。

注意这个文件里有两处**必须保留**的既有修复，不要在重构中弄丢：`titleInput` 是持久节点、只在 idle→renaming 边沿写回；`focusout` 的 `relatedTarget === null` 守卫（`canvasHeaderView.ts:103`，注释详细记录了缺它会怎样自锁）。`onPressOutside(['.canvas-menu', '.canvas-menu-trigger'], …)` 按选择器而非节点注册，这一点在保留容器之后仍然成立，不必改。

**工作项**

1. 给 `render()` 加一层相同视图跳过：把 `CanvasHeaderView` 的可见字段拼成签名，与上一次相同则**完全不碰 DOM**（`show()` 也不用重设）。签名要覆盖 `visible`、`title`、`renaming`、`menuOpen`、`menuItems` 的 id／label／danger、`openLocationLabel` / `openLocationTitle`。
2. 菜单容器持久化：`menuShell` 与 `.canvas-menu` 建一次并保留，开合用 `hidden` 切换，内容用 `reconcile` 更新。这样入场动画对应「关闭 → 打开」的真实边沿。样式侧照 `.project-menu` 的既有做法改成 `:not([hidden])` 门控——`styles.css` 里那条注释已经解释过为什么侧栏必须这么做，标题栏是同一个病。
3. 菜单项内容更新（标题变化、可用操作增减、删除确认文案切换）只改文字与 class，不重建 `.canvas-menu`。
4. `firstMenuItem?.focus()` 的「只在 closed→open 边沿」逻辑（`canvasHeaderView.ts:192`）保留，并保证它仍是 `render()` 的最后一步。
5. 键盘焦点保护写成用例：菜单打开、焦点在第二个菜单项上，连续 10 次相同数据刷新后焦点不动。

**完成判据**：相同数据刷新 10 次 → `.canvas-menu` 替换 0 次、`drop-in` 触发条件 0 次、焦点不移动；三种关闭方式仍然全部有效；重命名输入的 caret 在流式刷新中不丢。
**验证**：`node --import tsx --test test/rendererCanvasHeaderView.test.ts test/rendererCanvasHeader.test.ts`
**提交**：`checkpoint: M06 stop the session menu re-entering on every snapshot`

---

## M07 `[x]` F4 任务面板：内部节点身份与 `animationend` 过滤

**验收记录（2026-09-10）**：进度、head、任务行与珠子持久化，ratio 变化才写进度，点击读取当前数据；flash 仅由自身 task-flash 结算，hide 清空生命周期。指定窄测 31 通过，typecheck 通过。

**前置**：M01 · **规模**：中 · **设计稿**：F4
**涉及**：`src/desktop/renderer/dom/taskPanelView.ts`、`src/desktop/renderer/styles.css`

`paneSession.ts:612` 的 `streamRepaint` 每帧同时刷 transcript 和任务面板。面板外壳（`panel`）确实被保留了，但 `paint()` 的最后一行是 `replace(node, progressBar(), head, …)`（`taskPanelView.ts:70`）——进度条、标题、任务行每次都是新节点。`.task-progress-fill` 的 320ms 宽度过渡因此永远从头开始，`.task-bead.running` 的呼吸也具备重启条件。

`animationend` 监听器（`taskPanelView.ts:46`）不筛动画名也不筛 target：`rise-in` 入场结束、或任何子元素的动画结束，都会提前摘掉 `flash`。

**工作项**

1. `progressBar()` 的 track 与 fill 建一次并保留；每次 paint 只写 `--task-progress`。宽度过渡因此能从上次的值接续。
2. `head` 保留：文字与 `aria-expanded` 按字段更新，不重建按钮。注意 `paint()` 会在 head 的 click 里递归调用自己（`taskPanelView.ts:62`），保留节点后这条路径要重新核对不会重复注册监听器。
3. 任务行按 id `reconcile`：行在则改 class 与文字，不在则新建，消失则移除。状态珠（`.task-bead`）保持身份，运行状态的呼吸不重启。
4. `animationend` 处理器加两层过滤：`event.target === node` 且 `event.animationName === 'task-flash'`。这条是设计稿 §8「结束事件要过滤目标和动画／属性名称」的具体落点。
5. `hide()` 把 `panel = undefined` 之后要保证下次 `ensurePanel()` 重新注册监听器（现状如此，保留），并核对 `flash` 的 class 不会跨面板生命周期残留。
6. 面板整体的 `rise-in` 仍然只在「从无到有」时播放一次——这是文件顶部注释已有的承诺，本会话不要破坏它。

**完成判据**：任务数据不变但收到大量 token 时，进度 fill、head、每个任务行与状态珠全程同一节点；进度只在 `ratio` 变化时改属性；`flash` 只被 `task-flash` 自己的结束事件清除。
**验证**：`node --import tsx --test test/rendererTaskPanelView.test.ts test/rendererTasks.test.ts test/rendererRepaint.test.ts`
**提交**：`checkpoint: M07 keep task panel nodes and scope its animation end`

---

## M08 `[x]` F4 设置开关：滑块保留身份、按字段更新

**验收记录（2026-09-10）**：普通与组合开关按 key 复用，knob 保持身份；监听器读取当前 checked 值和回调，pending 拒绝再次操作。保存、reload、回退序列通过，指定窄测 141 通过，typecheck 通过。

**前置**：M01 · **规模**：中 · **设计稿**：F4
**涉及**：`src/desktop/renderer/dom/settingsView.ts`、`src/desktop/renderer/dom/controls.ts`

设置行本身走 `reconcile`，但 `toggleField()`（`controls.ts:105`）每次都 `el('button', …)` 新建开关和 `.settings-toggle-knob`，`settingsView.ts:500` 与 `:534`（`toggle-and-buttons` 分支）各调一次。140ms 的滑块位移因此缺少可以过渡的同一节点。

**工作项**

1. 给设置视图一个按 key 复用控件的小机制（形状参考同文件已有的 `context.keptInput('input:…')`：输入框已经是持久节点，开关照抄这条路）。key 用 `toggle:${row.id}`，`toggle-and-buttons` 用独立后缀避免撞车。
2. 复用的开关按字段更新：`aria-checked`、`on` class、`disabled`、`aria-label` / `title`。knob 节点不重建，位移因此有起点。
3. `onChange` 闭包捕获的是**当前** `value`：复用节点意味着监听器只注册一次，必须像 transcript 的 `DisclosureRef`（`transcriptView.ts:411`）那样通过可变引用读「现在显示的是什么」，否则第一帧的值会被永久记住。
4. `pending` 乐观态：设置改动遵守 `mutate → save if config changed → reload → after-reload action → optional refresh` 流程，`row.pending` 期间开关不可点。保存后的 reload 重绘**不能**把滑块动画归零——这正是本会话的验收点。
5. 选择器（`pillSelect`）的 `justOpened` 聚焦逻辑不动；本会话只处理开关。

**完成判据**：翻动开关 → 保存 → reload 全过程中 `.settings-toggle` 与其 knob 是同一节点；`pending` 期间不可点；失败回退回到原值且不重建节点。
**验证**：`node --import tsx --test test/rendererSettingsView.test.ts test/rendererSettingsModel.test.ts`
**提交**：`checkpoint: M08 keep the settings toggle node across saves`

---

## M09 `[x]` F4 完成反馈绑定状态边沿，区分实时与历史

**验收记录（2026-09-10）**：工具 head 与 bead 持久化，完成 class 仅由观察到的 running→done/failed 边沿触发；历史初始化、反复展开均不触发。结束事件筛 target/name，并有兜底与 pane 隐藏/reset 清理。相关窄测 107 通过，typecheck 通过。

**前置**：M01 · **规模**：中 · **设计稿**：F4、§5.2
**涉及**：`src/desktop/renderer/dom/transcriptView.ts`、`src/desktop/renderer/styles.css`

`.step-bead.done` 上挂着 `bead-pop`（缩放到 1.6 倍，`styles.css:1798` 一带）。因为 `toolStep` 的展开／收起会让 `step:` 节点重填、head 与 bead 一起重建（`transcriptView.ts:869`、`:875`），**重新查看一条已完成工具的详情也会播放一次「完成」弹动**；加载历史会话时每个已完成步骤同样具备播放条件。设计稿 §5.2 的规则是：加载／恢复历史直接展示历史状态，不批量播放完成效果。

**工作项**

1. 工具步骤的 head 与 bead 变成持久节点（形状照 `thinkingStep` 已经做过的 head 复用：`painter.node` 一个 `tool-head:${step.id}` 的 key + `painter.ref` 读点击时的展开态）。展开／收起只增删 body，不动 head。
2. 完成反馈绑定**状态边沿**：`running → done` 或 `running → failed` 的那一次转变才播放。实现上把「上一帧这个 step 的状态」记在 painter 的缓存条目里（或一个与 `refs` 同生命周期的 map，一起被 `prune`），只有边沿才加动画 class，`animationend` 上过滤 `animationName === 'bead-pop'` 后摘掉。
3. **历史恢复不算边沿**：会话加载／`/resume` 后的第一帧，所有步骤的「上一帧状态」应初始化为它们的当前状态，于是没有边沿、没有弹动。这条要有独立用例。
4. `.step-bead.awaiting-approval` 的 `blink`（闪至完全透明）与 `.step-bead.running` 的 `breathe` 暂时保留原样——它们的强度调整属于 M18，本会话只处理身份与边沿。
5. `stepAccessibleName` / `headParts` 的内容更新照旧按字段写，注意 `button()` 只在建节点时写 `title`／`aria-label`，复用节点后必须在 fill 里显式重写（`groupHead` 和 `thinkingStep` 的注释都记过这个坑）。

**完成判据**：已完成工具反复展开／收起，`bead-pop` 触发 0 次；加载历史会话，全部已完成步骤 `bead-pop` 触发 0 次；一次真实的 `running → done` 触发恰好 1 次。
**验证**：`node --import tsx --test test/rendererTranscriptView.test.ts test/rendererStyleTokens.test.ts`
**提交**：`checkpoint: M09 fire step completion feedback on the state edge only`

---

## M10 `[x]` 通用呈现相位状态机（model 层）

**验收记录（2026-09-10）**：新增纯 Phase 状态机、mounted/class 投影和分语义兜底常量；双向 intent/settled、连续反向与迟到结算全覆盖。业务与视觉退出分离写入模块契约，既有侧栏状态机保留。模型、样式测试及 typecheck 通过。

**前置**：M02–M09 · **规模**：中 · **设计稿**：F5、§8 第 2 步
**涉及**：新增 `src/desktop/renderer/model/presence.ts`、新增 `test/rendererPresence.test.ts`

设计稿 F5：多数菜单、弹窗、设置页有入场，关闭时直接 `hidden` 或移除；侧栏是目前唯一完整的实现。`model/sidebar.ts` 已经把这件事做对了——`SidebarCollapsePhase` 的四相位、纯函数 `nextCollapsePhase(current, want, event)`（对八个 `(phase, event)` 组合全覆盖，晚到的 `settled` 被丢弃）、`SIDEBAR_COLLAPSE_FALLBACK_MS = 380` 兜底、`sidebarContentMounted(phase)` 决定挂载时机。本会话把这套形状抽成所有浮层共用的一份。

**工作项**

1. `presence.ts` 提供：
   - `type Phase = 'closed' | 'entering' | 'open' | 'closing'`
   - `nextPhase(current: Phase, want: boolean, event: 'intent' | 'settled'): Phase`，纯函数，对八个组合全覆盖，与 `nextCollapsePhase` 同样的语义：`intent` 按意图起步，`settled` 只在方向一致时落定，方向不一致的 `settled` 是迟到回调，丢弃。**中途反向必须从当前相位接续**，不回到 `closed` 重播。
   - `isMounted(phase): boolean` —— `phase !== 'closed'`，即 `closing` 期间节点仍在 DOM（否则退出动画是「淡出一个不存在的东西」）。
   - `phaseClass(phase): string | undefined` —— 给 DOM 一个稳定的 class 名，样式侧据此挂入场／退出。
   - 每类浮层的兜底毫秒常量，值从 token 推导并由 `rendererStyleTokens` 钉住（照 `SIDEBAR_COLLAPSE_FALLBACK_MS` 与 `--motion-slow` 的现有断言，`test/rendererStyleTokens.test.ts:1385` 一带）。
2. 明确**业务动作与视觉退出分离**（设计稿 §5.2、§5.3）：`intent` 到达时立刻处理业务与焦点，`closing` 只负责画面。这一条写进模块顶部注释，因为它是权限对话框正确性的前提——那四个阻塞请求握着 agent loop，答复不能等动画。
3. 不改任何现有视图；`sidebar.ts` 的 `nextCollapsePhase` 本会话**不动**（它的 `expanded/collapsing/collapsed/expanding` 命名与语义已被侧栏测试与样式钉死，迁移与否放到 M11 之后再评估，并在那时写明结论）。
4. 纯模型测试：八个组合、连续反向、迟到 `settled`、兜底触发后再来一个真 `settled`。

**完成判据**：`nextPhase` 对八组输入的表格化测试全绿；连续三次反向不出现瞬移或残留相位；模块不 import 任何 DOM。
**验证**：`node --import tsx --test test/rendererPresence.test.ts test/rendererSidebar.test.ts test/rendererStyleTokens.test.ts`
**提交**：`checkpoint: M10 add a shared presence phase machine`

---

## M11 `[x]` 小浮层接入相位：菜单、补全、命令面板、tooltip

**验收记录（2026-09-10）**：所有小浮层（含分支选择器、设置下拉、图片预览）接入共用相位；关闭立即 inert、焦点回归，结算后清理；切换 pane 强制结算。菜单及 tooltip 随数据更新保留容器，二级菜单加入指针走廊容差。为支持中途反向，原 drop/rise/slide 轨迹改用 CSS transition，保留侧栏原四阶段。215 项相关测试与 typecheck 通过。

**前置**：M10 · **规模**：长 · **设计稿**：F5、§4、§5.2
**涉及**：`src/desktop/renderer/dom/titleBarView.ts`、`canvasHeaderView.ts`、`sidebarView.ts`、`suggestionsView.ts`、`surfaceView.ts`、`queueView.ts`、`composerView.ts`、`styles.css`

现状：`.titlebar-menu` / `.canvas-menu` / `.settings-menu` 有 `drop-in`，`.composer-menu` / `.chip-menu` 有 `rise-in`，`#surface` / `#suggestions` / `#queue` 有 `rise-in`，`.chip-flyout` 有 `slide-in`——**没有一个有退出**。

**工作项**

1. 每个浮层持有一个 `Phase`，开合改为 `intent`；`closing` 期间节点留在 DOM 并带退出 class，`settled`（`animationend` 或兜底计时器）后才卸载／`hidden`。
2. `animationend` 一律过滤 `event.target` 与 `event.animationName`——一个菜单项自己的动画结束不能结算容器的退出。
3. **三种关闭方式全部保留**，且都走同一个 `intent` 入口：`onPressOutside`（作用域含触发器）、`focusout`（`relatedTarget === null` 忽略）、Escape。M06 给标题栏加的签名跳过不能被相位重新引入的重绘绕过。
4. **内容更新不重播**：`open` 相位下的数据刷新只更新内容。这是 F3 的一般化，M06 只修了标题栏一处。
5. **命令面板与补全的列表**：容器只在首次打开时动，键盘上下移动选项即时更新、不做过渡（设计稿 §4）。
6. 二级菜单（`.chip-flyout`）增加鼠标意图容差：指针斜穿到子菜单的路径上不立刻收起。用一个小的延迟 + 指针位置判断，纯决策放 model。
7. **建议断点** —— 标题栏、会话菜单、侧栏项目菜单三处走通后提交一次；补全／命令面板／队列／二级菜单下次继续。
8. 样式侧：入场保持现有 `drop-in` / `rise-in` / `slide-in`（时长在 M17 统一调），新增对应的退出 keyframes 走 `--ease-exit`。注意 token 测试禁止新增嵌套 at-rule，`@keyframes` 是允许的。

**完成判据**：连续快速开关任一菜单能在中途反向，无瞬移、无残留遮罩、无不可点击状态；隐藏窗口下兜底计时器仍能结算；焦点行为与关闭方式无回归。
**验证**：`node --import tsx --test test/rendererCanvasHeaderView.test.ts test/rendererTitleBarView.test.ts test/rendererSidebarView.test.ts test/rendererCompletion.test.ts test/rendererComposerView.test.ts test/rendererQueuedMessages.test.ts` + `npm run typecheck`
**提交**：`checkpoint: M11 give popovers a visible exit phase`

---

## M12 `[x]` 模态、设置页、rewind 接入相位；遮罩与面板分离

**验收记录（2026-09-10）**：模态与 rewind 由稳定面板承担相位，遮罩独立淡入淡出且到面板退出结束才卸载。设置页保持文字比例及窗口工作区几何，关闭立即恢复输入焦点。请求先出队并答复，`hasOverlay` 仍只读取队列、与 closing DOM 无关，`onShellChanged` 保留。移除旧 ID 入场规则，防止覆盖反向过渡。163 项相关测试与 typecheck 通过；真实 bridge 时序在 M21 验证。

**前置**：M10 · **规模**：中 · **设计稿**：F5、§4
**涉及**：`src/desktop/renderer/dom/overlayView.ts`、`rewindView.ts`、`settingsView.ts`、`src/desktop/renderer/app.ts`、`styles.css`

`overlayView.hide()` 是 `show(container, false)` + `replace(panel)`（`overlayView.ts:136`），没有退出过程；`#overlay` / `#rewind` 只有 140ms `fade-in`，`#settings` 只有 `rise-in`。

**工作项**

1. 三者接入 `Phase`。**先结算再退出**：`OverlaySelect` 的答复、rewind 的执行、设置页的关闭动作在 `intent` 那一刻就完成，`closing` 只是画面。注释里写死这条——那四个阻塞请求握着 agent loop（`overlayView.ts` 顶部注释已说明背景不可点正是因为不能被 dismiss）。
2. 遮罩与面板分成两条轨：遮罩自己的入／出时长，面板自己的位移与淡入。遮罩必须**连续覆盖**面板的退出过程，不能先消失让面板裸露在内容上。
3. 面板内容更新不重播容器——这一点模态框现在做对了（设计稿 §4 认可），接入相位后不要弄丢：`open` 相位内 `replace(panel, …)` 只换内容，容器 class 不重置。
4. 设置页整页不缩放文字（设计稿 §5.3：大页面与大块正文保持原始比例）。`rise-in` 里的 `scale(0.98)` 对整页不合适，改成只做位移与淡入；`.settings-menu` 等页内小浮层不受影响。
5. `hasOverlay` 变化仍要调 `onShellChanged`（renderer 不变式）。`closing` 期间 `hasOverlay` 应视为 **false**（业务上已结算），并为这一点写用例——否则一个正在淡出的模态会让 shell 以为还有阻塞请求。

**完成判据**：打开／关闭三类面板都有可见的双向过程；关闭的业务效果在动画开始前已完成；`closing` 期间没有未结算的阻塞请求；连续快速开关能反向。
**验证**：`node --import tsx --test test/rendererOverlayView.test.ts test/rendererRewindPanel.test.ts test/rendererSettingsView.test.ts test/rendererPermissionView.test.ts test/rendererPlanDialogViews.test.ts`
**提交**：`checkpoint: M12 add exit phases to modals, settings and rewind`

---

## M13 `[ ]` 内容展开／收起的双向连续过程

**前置**：M10 · **规模**：中 · **设计稿**：F5、§4、§5.3
**涉及**：`src/desktop/renderer/dom/transcriptView.ts`、`styles.css`、`src/desktop/renderer/dom/sidebarView.ts`

展开走 220ms 的 `unfold`（`grid-template-rows: auto 0fr → auto 1fr`，`styles.css:1753` 一带），**收起直接删除正文**。项目组折叠（`sidebarView.ts`）是本仓库已有的、双向都完整的实现，可以作为参考。

**工作项**

1. 思考／工具／子代理三种可折叠步骤接入 `Phase`：`closing` 期间正文留在 DOM 并反向播放 `unfold`，`settled` 后移出——设计稿 §5.3 明确要求「收起完成后正文仍应移出 DOM，维持既有折叠语义」。
2. **焦点与可访问性先于视觉**：收起的那一刻 `aria-expanded` 就变 `false`，焦点若在正文内立刻移回 head。不要等动画。
3. 中途反向：正在收起时再次点击，从当前高度接续展开，不归零重播（设计稿 §5.2「用户反向操作」）。
4. `unfold` 现在靠 `:not(.collapsed)` 的加减来控制播放（样式注释写明这是防重播的机制）。接入相位后播放条件变成相位 class，要重新核对：`open` 相位下的内容刷新**不得**重新触发。M03 之后回合内不再反复切 `collapsed`，这里是第二道保险。
5. 任务面板的展开／收起同样接入（`taskPanelView` 的 `expanded` 目前是直接重绘），复用同一套相位与时长。
6. 兜底计时器必需：`display: none` 的祖先（设置页打开时的 transcript）会直接取消 transition，没有兜底就永远停在 `closing`。

**完成判据**：三类步骤与任务面板的展开／收起都有可见的双向过程；中途反向不瞬移；收起完成后正文确实不在 DOM；焦点在收起瞬间就已回到 head。
**验证**：`node --import tsx --test test/rendererTranscriptView.test.ts test/rendererTaskPanelView.test.ts test/rendererStyleTokens.test.ts`
**提交**：`checkpoint: M13 make disclosure collapse a visible process`

---

## M14 `[ ]` 自动折叠策略落地（方向 A）

**前置**：M13 · **规模**：中 · **设计稿**：§7
**涉及**：`src/desktop/renderer/model/thinking.ts`、`src/desktop/renderer/model/transcript.ts`、`src/desktop/renderer/dom/transcriptView.ts`

**决策记录**：方向 A —— 执行中稳定，已打开的详情本轮保持，整轮完成后按规则收起。2026-09-09 由用户选定；依据是工具交接时画面最稳、便于追踪过程，代价（长任务占纵向空间、结束整理需保护阅读锚点）由本会话第 3 条与 M15 承担。

**工作项**

1. 先按三条不变式写测试，它们与具体策略无关：
   - 用户手动展开／收起**始终优先**于任何自动策略（`DisclosureState` 的绝对值语义，`thinking.ts` 开篇注释）。
   - 键盘焦点与文字选择受保护：自动收起不能把焦点扔到 `<body>`，也不能在用户选中正文时把它抽走。
   - 回合结束不无条件收走用户正在查看的内容。
2. 实现方向 A 的默认策略，全部落在 `model/thinking.ts` 的默认展开判定里，DOM 层不做第二套决策：回合执行期间已展开的详情保持展开，不因步骤推进自动收起；整轮完成后按规则收起。
3. 「整轮完成后的一次整理」是一次布局变化，与 M15 的留白回收协调为**同一次**变化，不要分两帧做。

**完成判据**：方向 A 的默认行为有测试；三条不变式各有独立用例；手动状态在整轮结束后仍然保持。
**验证**：`node --import tsx --test test/rendererThinking.test.ts test/rendererTranscriptView.test.ts`
**提交**：`checkpoint: M14 implement the chosen auto-collapse policy`

---

## M15 `[ ]` 视口策略统一：定位、跟随、锚点保护、结束整理

**前置**：M14 · **规模**：长 · **设计稿**：F7、§6.2
**涉及**：`src/desktop/renderer/dom/transcriptView.ts`、`src/desktop/renderer/model/transcriptAnchor.ts`、`styles.css`

transcript 同时叠着六件事：新问题置顶（`liftAnchor` + `--transcript-pad`）、流式底部跟随（`transcriptView.ts:342` 的 `container.scrollTop = container.scrollHeight`）、浏览器滚动锚定、内容折叠、`ResizeObserver` 的视口尺寸变化（`transcriptView.ts:263`）、回合结束后的留白回收（`.transcript-column.settling` 的 220ms `padding-bottom` 过渡）。

**已经做对、必须保留的两件事**：流式期间 `settling` class 摘掉，所以留白不做过渡（样式注释解释了带过渡会让 transcript 抖一整轮）；`ResizeObserver` 路径用 `moved: false`，所以调整窗口不会把读者拽回锚点。

**工作项**

1. 把六类事件收敛成一张**显式的视口策略表**，放进 `model/transcriptAnchor.ts`（或旁边新建一个纯模块）：输入是「事件类型 + 用户是否在底部 + 是否有回合在飞 + 锚点是否可测量」，输出是「不动 / 跟随尾部 / 一次定位到锚点 / 保护当前锚点」。DOM 层只执行，不再各自判断。设计稿 §6.2 的七行表格就是这张表的验收清单。
2. 用户上翻阅读时**不自动拉回尾部**——现状的 `if (!lifted && atBottom)` 已经是这个意思，把它纳入策略表并补齐用例。
3. 展开／收起详情时以触发标题与阅读位置为参照，布局变化不把操作目标甩走。M13 给了连续的高度变化，这里补上「变化期间保持触发行的视口位置」。
4. **建议断点** —— 策略表 + 纯模型测试绿了就提交一次，DOM 接线下次继续。
5. 回合结束的折叠（M14）与留白回收协调成**一次**布局变化：`settling` 的过渡与自动折叠同帧开始。用户正在阅读历史时优先保护视口，宁可不整理。
6. 「回到最新」（`transcriptView.ts:142` 的 `scrollTo({ behavior: 'smooth' })`）改成一次可打断的主动定位：滚轮、拖动或再次定位都能中断它。原生 smooth 不可打断也不读 reduced-motion，需要自己实现或改成即时定位——两种都可以，选定后写明理由（M19 会依赖这个结论）。
7. 权限区高度切换先留给 M16，本会话只保证策略表能容纳它。

**完成判据**：设计稿 §6.2 七个场景逐条有测试；上翻后继续输出不被拉回；结束整理是一次变化而非两次；「回到最新」可被打断。
**验证**：`node --import tsx --test test/rendererTranscriptAnchor.test.ts test/rendererTranscriptView.test.ts` + `npm run typecheck`
**提交**：`checkpoint: M15 unify transcript viewport policy`

---

## M16 `[ ]` 权限请求形态交接与 transcript 可用高度

**前置**：M15 · **规模**：中 · **设计稿**：§4、§5.3
**涉及**：`src/desktop/renderer/dom/permissionRequestView.ts`、`composerView.ts`、`src/desktop/renderer/paneSession.ts`

现状：显示请求时输入与操作栏直接隐藏，高度可能明显变化，而这个高度直接从 transcript 的可用视口里扣。

**工作项**

1. 在同一个输入区内完成形态交接：请求进入时输入区变形而不是「一个消失、另一个出现」，接入 M10 的相位。
2. 高度变化通知 M15 的策略表，作为「大布局变化」处理：不与自动滚动叠加，读者的锚点受保护。
3. **答复立即结算**：批准／拒绝在 `intent` 那一刻就回给 bridge，视觉退出不得延迟，也不能留下未结算的阻塞请求（`paneSession.ts` 的 `enqueue` 注释：`PermissionGate.approve` 没有超时，掉一个请求就把 agent loop park 到 pane 结束）。
4. 焦点落点明确：请求出现时焦点进入操作按钮，退出后回到输入框。用例覆盖「退出动画进行中用户开始打字」——输入不能丢。
5. `hasOverlay` / `isStreaming` 变化仍调 `onShellChanged`。

**完成判据**：权限请求进入、批准／拒绝、退出全程输入区与视口连续；答复不等动画；焦点落点正确；退出中输入不丢。
**验证**：`node --import tsx --test test/rendererPermissionView.test.ts test/rendererComposerView.test.ts test/rendererShellModel.test.ts`
**提交**：`checkpoint: M16 hand over the composer to permission requests`

---

## M17 `[ ]` 语义时长 token 与更均匀的曲线

**前置**：M10–M13 · **规模**：中 · **设计稿**：§5.1
**涉及**：`src/desktop/renderer/styles.css`、`test/rendererStyleTokens.test.ts`、`src/desktop/renderer/model/sidebar.ts`、`src/desktop/renderer/model/presence.ts`

到这一步节点身份和相位都已就位，调曲线调的才是真东西。当前 `cubic-bezier(0.32, 0.72, 0, 1)` 对 220ms 动画在 81ms 就走完 90%，所以「220ms」体感上仍是一闪；建议换成 `cubic-bezier(0.22, 0, 0.22, 1)`，300ms 入场约在 187ms 到 90%。

**工作项**

1. 按设计稿 §5.1 的表引入**语义 token**（按压／微状态／小浮层入出／内容展开／大布局／页面面板／遮罩／完成反馈／运行呼吸／定位提示），初值照表。这是语义 token，不是给每个组件配一个常数——组件只引用语义名。
2. 现有 `--motion-fast/base/slow` 的去留要明确：或保留为底层刻度、语义 token 引用它们，或整体替换。选定后**同步 `test/rendererStyleTokens.test.ts`**——它在两处主题块（约 `:326` 与 `:425`）和必需 token 列表（约 `:503`）各钉了一份，以及 `:1697` 的「所有 transition 必须用 token」扫描。三处都要改，漏一处就红。
3. 曲线换成更均匀的一条；`--ease-exit` 保留给退出。
4. 侧栏兜底常量 `SIDEBAR_COLLAPSE_FALLBACK_MS`（`model/sidebar.ts:132`）与 M10 的各类兜底跟着新的大布局时长走，`rendererStyleTokens.test.ts:1385` 那条「兜底必须刚好在 `--motion-slow` 之后」的断言要一起更新。
5. 按压反馈（`#submit:active` / `#stop:active` 的 `scale(0.94)`）保留触觉感：按下即反馈、不等过渡结束才执行动作；释放轻柔回弹且不超调。
6. `.transcript-column.settling` 的时长走「大布局变化」语义。

**完成判据**：所有 transition／animation 的时长与曲线来自语义 token；token 测试三处断言同步且全绿；正常播放速度下（不靠慢放）能看出展开、收起、面板切换是有过程的。
**验证**：`node --import tsx --test test/rendererStyleTokens.test.ts test/rendererSidebar.test.ts test/rendererPresence.test.ts`
**提交**：`checkpoint: M17 introduce semantic motion tokens and a flatter curve`

---

## M18 `[ ]` 单一运行信号：去掉叠加的呼吸／光晕／扫光

**前置**：M17 · **规模**：中 · **设计稿**：F6、§6.3
**涉及**：`src/desktop/renderer/styles.css`、`src/desktop/renderer/dom/transcriptView.ts`

当前同一个「正在工作」被四五种循环同时表达：`.waiting-bead` 的 1.8s `breathe` **加上** `::after` 的 1.8s `halo` 扩散，`.waiting-label` 的 2.4s `sweep` 扫光，`.item.thinking.live .thinking-header` 的 2.4s `breathe`，`.step.thinking.live .step-rule` 的 1.8s `sheen`，侧栏与输入区的 0.9s `spin`。`.step-bead.awaiting-approval` 用 `blink 1.2s steps(1, end)` 闪至**完全透明**，`.step-bead.done` 放大到 **1.6 倍**。

**工作项**

1. **每个区域只留一个主要运行信号**。等待行（`.waiting`）现在同时有呼吸 + 光晕 + 扫光三层：择一。设计稿倾向保留柔和呼吸或扫光其一，同一条状态行不得同时呼吸、扩散、扫光。
2. 循环时长按 §5.1 调到 2600–3200ms；呼吸的 opacity 下限提到约 0.65，**不完全消失**。
3. `blink` 不再闪至 0：等待批准是要人回答，但完全消失会被读成异常。改成明显但不消失的节奏。
4. `bead-pop` 的 1.6 倍缩放收敛为「一次性完成反馈」（§5.1 的 180ms 语义）：状态颜色或图标的轻过渡，不再是弹动。M09 已经保证它只在真实边沿播放，这里只改强度。
5. **正文不呼吸**：`.item.thinking.live .thinking-header` 的呼吸与思考行的扫光二选一。
6. 每种状态仍必须有非颜色、非动效的文字表达——`toolStatusLabel` 与各 head 的 `aria-label` 是既有契约（bead 是 `aria-hidden`），`rendererStyleTokens.test.ts:1472` 一带还断言每个 `.step-bead.<state>` 带有 motion；改动效形式时这条断言要一起更新，不能简单删掉。
7. `spin` 保持 linear（持续旋转的唯一例外）。

**完成判据**：任一时刻同一区域只有一个循环动效；没有任何循环把元素带到 opacity 0；完成反馈不再是缩放弹动；状态的文字表达无回归；token 测试同步。
**验证**：`node --import tsx --test test/rendererStyleTokens.test.ts test/rendererTranscriptView.test.ts test/rendererWaiting.test.ts`
**提交**：`checkpoint: M18 reduce each region to one running signal`

---

## M19 `[ ]` 减少动态效果覆盖 CSS、JS 滚动与动画结算

**前置**：M15、M17 · **规模**：中 · **设计稿**：F7、§8
**涉及**：新增 `src/desktop/renderer/model/reducedMotion.ts`、`src/desktop/renderer/app.ts`、`dom/transcriptView.ts`、`sidebarView.ts`、`styles.css`

样式表末尾的 `@media (prefers-reduced-motion: reduce)` 已经把 CSS 动画压到 1ms、一次播放（用 1ms 而非 0 是为了 `transitionend` 仍然触发——这条注释保留）。它**覆盖不到 JavaScript**：`scrollTo({ behavior: 'smooth' })` 照旧平滑滚动。renderer 目前只有 `app.ts:128` 用 `matchMedia` 读 `prefers-color-scheme`，没有读 reduced-motion 的代码。

**工作项**

1. 照 `model/theme.ts` 的形状建 `model/reducedMotion.ts`：纯函数接收 `matches: boolean`，产出各处要用的决策（是否平滑滚动、是否播放位移／缩放、兜底计时器是否立即结算）。`matchMedia` 的订阅与接线留在 `app.ts`。
2. JS 滚动降级为即时定位：M15 决定的「回到最新」实现按这个偏好切换。流式跟随本来就是即时赋值，不受影响。
3. 相位状态机在 reduced-motion 下仍然走完 `entering → open` / `closing → closed`，只是时间趋近于零——**不能跳过 `settled`**，否则卸载逻辑不执行。兜底计时器在这个模式下要缩短到与 1ms CSS 一致的量级。
4. 保留静态状态与必要颜色反馈：位移、缩放、扫光、呼吸关闭，颜色与状态文字保留。已有的 marquee 特例（`.session-row:hover .session-title.marquee` 那三条规则，防止动画取消后名字被硬裁）保留。
5. 清理陈旧注释：设计稿 F7 提到「旧注释中『没有 reduced-motion 支持』的说法已与实际样式不符」——搜一遍 renderer 与 `todo.md`，把不准确的说法改掉。`styles.css:1519` 那条「token 测试的解析器只接受 `@keyframes`，所以这里没有 reduced-motion」是**准确的**，保留。
6. 测试用 M01 加进 `domStub` 的 `matchMedia` 桩。

**完成判据**：开启减少动态效果后 CSS 与 JS 都降级；所有相位仍能结算、节点仍被正确卸载；内容与操作完整可用；陈旧注释已修正。
**验证**：`node --import tsx --test test/rendererTranscriptView.test.ts test/rendererSidebarView.test.ts test/rendererStyleTokens.test.ts test/rendererTheme.test.ts` + 新增 `test/rendererReducedMotion.test.ts`
**提交**：`checkpoint: M19 honour reduced motion in JS as well as CSS`

---

## M20 `[ ]` 全量 typecheck／测试／构建

**前置**：M16–M19 · **规模**：短

```bash
npm run typecheck
npm run test
npm run build
npm run build:desktop
npm run smoke:desktop
```

**完成判据**：五条命令全绿；base / build / preload / renderer / DOM 五个 tsconfig 的 `rootDir` / `exclude` 边界未被破坏；`ink+7.0.6.patch` 与 `wrap-ansi+10.0.0.patch` 仍配对；`scripts/smoke-desktop.mjs` 的 teardown 仍恢复 renderer 偏好、`~/.myagent/config.json`、`~/.myagent/projects.json` 且不抛错。
**提交**：`checkpoint: M20 full typecheck, test, build and smoke pass`

---

## M21 `[ ]` 三个代表场景的实机逐帧比较

**前置**：M20 · **规模**：中 · **设计稿**：§9

设计稿点名：第一轮实机比较只选三个场景，先确认整套节奏，再推广。静态截图与 DOM stub 不能证明过程流畅。

**工作项**

1. 用 `npm run start:desktop` 起真实 Electron，对三个场景做**连续帧或性能记录**（DevTools Performance 的 frames 轨道即可）：
   - 流式思考 → 工具返回 → 后续输出
   - 详情展开／收起
   - 侧栏与菜单进出场
2. 每个场景记录：可见空白帧数、滚动位移、动画启动次数、目标元素位置、帧率。
3. 先覆盖常用窗口尺寸与 60Hz；有 120Hz 设备再补。
4. 深／浅色与 Windows 100%／125% 缩放下检查文字清晰度、扫光可见度、布局接缝。
5. 在本块下留一张**场景 × 结论**表。参数不合适就回到 M17／M18 调 token 值，**不要**在组件里写死一次性数值。
6. 当前机器无法验证的项（例如 120Hz）如实记为「待验收」，不用推测冒充。

**完成判据**：三个场景各有一份记录与结论；节奏定稿或明确列出需要回调的 token；表格已填。
**提交**：`checkpoint: M21 record on-device motion comparison for three scenes`

---

## M22 `[ ]` 剩余验收矩阵、`README.md` 与签收

**前置**：M21 · **规模**：中 · **设计稿**：§9

对照设计稿第 9 节逐项打勾。**任何一项未过则回到对应会话**，不得以「动画确实在播」代替交付。

| 验收场景 | 验收标准 | 会话 | 状态 |
| --- | --- | --- | --- |
| 思考增量中穿插无变化事件 | 标题与状态线保持节点、动画进度及焦点；不重新入场 | M04, M05 | `[ ]` |
| 连续多次短工具调用 | 回合状态不因工具间歇而结束，整组不反复消失重现 | M02, M03 | `[ ]` |
| 打开会话菜单后继续流式输出 | 容器入场一次；数据刷新不替换菜单，不丢焦点 | M06 | `[ ]` |
| 任务数据不变但收到大量 token | 进度填充与运行珠保持身份；进度只在数值变化时过渡 | M07 | `[ ]` |
| 修改设置开关 | 滑块在同一节点上完成位移，保存后的刷新不把动画归零 | M08 | `[ ]` |
| 已完成工具反复展开、恢复历史 | 不重复播放完成反馈；正文不批量重演入场 | M09 | `[ ]` |
| 长 Markdown 输出 | 稳定段落、代码块与公式保持连续；结构收口不造成整条消息闪灭 | M05 | `[ ]` |
| 上翻后继续输出／结束回合 | 可见内容锚点不被自动拉回尾部；结束折叠与留白回收协调为一次 | M14, M15 | `[ ]` |
| 连续开关菜单或侧栏 | 能在中途反向，无瞬移、残留遮罩或不可点击状态 | M11, M12 | `[ ]` |
| 权限请求进入、批准／拒绝、退出 | 输入区与视口连续交接；业务答复立即完成，焦点落点正确 | M16 | `[ ]` |
| 开启减少动态效果 | CSS 和 JS 均按偏好降级；内容与操作仍完整可用 | M19 | `[ ]` |
| 深／浅色与 Windows 缩放 | 100%／125% 下文字清晰度、扫光可见度、布局接缝 | M21 | `[ ]` |

**工作项**

1. 逐项验收并填表；未过的回到对应会话。
2. `README.md` 只写用户可见行为：动效整体节奏、减少动态效果的支持范围、自动折叠策略（方向 A）对阅读的影响。实现细节留在本文件与设计稿。
3. 把设计稿状态从 `v0.1 讨论稿` 更新为已实施，并回填第 5.1 节实机调校后的最终数值。

**提交**：`checkpoint: M22 sign off desktop motion acceptance`

---

## 附录 A 自动折叠策略的决策

**已决：方向 A**（设计稿 §7，2026-09-09 由用户选定）。

**行为**：执行中稳定，已打开的详情本轮保持；整轮完成后按规则收起。
**收益**：工具交接时画面最稳，便于追踪过程。
**代价**：长任务占纵向空间；结束整理要保护阅读锚点——由 M14 与 M15 协调为同一次布局变化。

前提是 M02（F1 回合判断）修好；并且必须保护用户手动展开、键盘焦点与文字选择。落地见 M14。

---

## 附录 B 风险与需要在实施中确认的项

| 风险 | 影响 | 处置 |
| --- | --- | --- |
| `domStub` 无法证明动画真的播放 | 阶段一全部会话的验收可能自欺 | M01 把「不重播」转成可判定的代理指标（节点是否离开文档、动画类是否重加）；真流畅性交给 M21 实机 |
| M04 的 painter 存活方案选错 | 缓存无限增长，或旧节点残留 | 两种方案都要求写明缓存上界与 `transcript-reset` 清理路径；测试覆盖一次真实 reset |
| M05 的 Markdown 分块 | 结构收口时可能整条消息闪灭 | 围栏／列表／表格／公式四种各有独立用例；KaTeX 仍走 DOM 树形式 |
| 相位状态机遍地开花 | 每个视图一套写法，等于没抽象 | M10 先出纯模块与全覆盖测试，M11／M12／M13 只允许引用它 |
| token 改动打散在三处断言 | `rendererStyleTokens` 反复红 | M17 块内已列出三处位置，一次改齐 |
| 兜底计时器与 `settled` 竞争 | 相位卡死或提前卸载 | `nextPhase` 对迟到 `settled` 的丢弃语义 + 每处兜底都有用例 |
| 动画延迟阻塞请求结算 | agent loop 被 park 到 pane 结束 | M12／M16 硬性要求先结算再退出，并各有一条用例 |
| 方向 A 下长任务占用纵向空间 | 长回合中 transcript 可读区被详情挤占 | M14 只在整轮完成后整理；若实机（M21）显示压迫感明显，回到设计稿 §7 再议，不在组件里加临时收起逻辑 |

---

## 附录 C 首版明确不做

引入动效框架（Framer Motion、GSAP、Web Animations API 封装层）、逐 token 淡入、弹簧／超调曲线、视图过渡 API（`startViewTransition`）、新增视觉资产（插画、Lottie、SVG 动画）、主题或密度的重新设计、TUI 侧的动效改动。

设计稿的定位是**保留式改进**：视觉变化 2/10，动效强度 5/10，既有产品一致性 9/10——集中改善状态交接与空间变化，使用现有界面元素承载动效。

任何一项若在实施中被要求加入，**先更新设计稿，再更新本文件的会话划分**，不要直接塞进某个会话。
