# 活动组：桌面端 ChatView 的思考、工具调用与任务清单重构

本文只覆盖 **desktop 渲染层**（`src/desktop/renderer/`），外加 `src/tools/` 的一处数据补齐。TUI
（`src/tui/transcript.ts`）本轮不动 —— Ink 的 `<Static>` 无法回收已输出内容，「已完成 step 自动收起」
在终端里做不到。

可交互原型：`prototype/activity-group.html`（纯静态，双击打开；「重放这一轮」演示直播时的开合行为）。

---

## 1. 现状与问题

`model/transcript.ts` 把一次回合渲染成一条**平铺的 item 列表**。thinking 按「当前未封存的块」聚合
（`appendThinking`，`transcript.ts:283`）：一个 turn 内所有思考被追加进**同一个块**，而 `tool_use` /
`tool_result` 和工具之间的阶段性 assistant 文本，作为兄弟 item 追在这个块**后面**。

真实发生的顺序

```
思考A → Read(x) → 思考B → Bash(y) → 阶段说明 → 思考C → Edit(z) → 最终回答
```

被压成

```
[思考A+B+C 原地膨胀] → Read(x) → Bash(y) → 阶段说明 → 最终回答
```

**顺序信息完全丢失**：thinking 块在原地持续增长，把所有工具行往下顶，看不出哪次思考导致了哪次调用。
`transcript.ts:283` 的注释已经承认了这个取舍 —— 当时是为了让「一个折叠头拥有整个 turn 的耗时」。本设计
推翻该取舍。

第二个问题是**渲染器把现成的结构化数据全丢了**：

| 现成资产 | 现状 |
| --- | --- |
| `ToolResultRecord.display`（`summary` / `headerSuffix` / `detail` / `taskSnapshot`），**每个工具都在返回** | `recordItems` 完全无视，改用 `content` 第一行截断 160 字符（`transcript.ts:444`） |
| `tools/display.ts` 的 `userFacingName` / `getToolUseSummary` / `getActivityDescription`，TUI 在用 | 渲染器自己猜 input 的键名拼 `Tool(detail)`（`transcript.ts:437`） |
| `model/diffRows.ts` + `dom/diffView.ts`（带行号槽的真 diff） | 只服务权限对话框，转录里从不出现 |
| `taskSnapshot`（结构化任务项 + 计数） | 从未渲染 |
| `open-in-editor` IPC | 转录里的路径全是死文本 |

工具行的样式一共 8 行（`styles.css:1251`）：灰字 + 左边 2px 竖线 + 等宽。所以一次 Edit 在桌面端只剩
`Edit → Edited src/foo.ts`。TUI 反而比桌面端富得多。

---

## 2. 目标形态

用户消息之后是**一个活动组**，组内是**有序的、各自可折叠的 step**；最终回答留在组外，是唯一「正文」。
任务清单**不在组内** —— 它是会话级的，常驻在输入框上方（见 §7）。

```
[用户消息]

  已处理 7m 38s · 12 步 · 1 失败                              ● ● ● ● ● ● ●
  ────────────────────────────────────────────────────────────────────────
       思考 12s   ─────────────────────────────────
   ●   Read      src/desktop/renderer/model/transcript.ts        0.4s
       思考 4s    ─────────────────────────────────
   ●   Bash      npm test -- transcript                          3.2s     ← 红珠，默认展开
   ●   Edit      src/desktop/renderer/model/thinking.ts  +12 −3  0.2s
       先把模型层改完再动视图 —— 分组键定为 turnId。               ← 阶段文本，不可折叠
       已压缩上下文 · 128k → 42k  ────────

[最终回答，组外正文]
```

两层披露：外层组表达「这一轮干了哪些活」的边界与总耗时；内层每个 step 独立开合。

---

## 3. 视觉语言：灯珠

**灯珠是工具的唯一状态语汇。** 7px 圆点，位于行首，四态：

| 状态 | 表现 |
| --- | --- |
| 等待授权 | `--accent-warn` 闪烁，同时行内出现「等待授权」字样 |
| 执行中 | `--text-tertiary` 灰色闪烁（`opacity 1 → .15`，`--motion-*` 之外的 1.1s 呼吸） |
| 完成 | `--accent-review` 绿，出现时一次 `scale(.4) → 1` 的 pop |
| 失败 | `--accent-danger` 红，同样的 pop |

规则：

- **思考行没有灯珠。** 它不是一次「执行」，没有成败可言。它缩进对齐到工具名的左缘，右侧用一条线代替
  状态图形：进行中是 `--accent-tool` 的流光扫过（`background-position` 动画），结束后是一条静止发丝线。
- **没有展开指针。** 不画 `⌄`、不画三角。整行即开关，`:hover` 的底色就是可点的全部暗示。
- **不用字符表达状态。** `✔ ✗ ○ ◐ ⋯` 一律换成图形：灯珠、CSS 虚线规（diff 省略行）、进度条填充。
- 组头收起时，右侧排出这一轮每个**工具** step 的 4px 微灯珠，不展开也能一眼看出「12 步里有一个红的」。

---

## 4. 数据模型

### 4.1 分组键：`turnId`

每条 `SessionRecord` 都带 `turnId`（`harness/types.ts:39,52,67`）。活动组以 `turnId` 为主键 ——
**不靠「遇到 user 消息就开新组」去猜**，直播与回放用同一个键。

### 4.2 step 的切分单位：一次模型请求

一条 assistant 记录 = 一次模型请求，自带 `thinkingBlocks`（`ChatMessage.thinkingBlocks`，已持久化）与
文本，其后跟随若干 `tool_use`。step 序列因此天然是：

```
思考段 → 阶段文本（若有）→ tool_use ×N → 下一次请求的思考段 → …
```

**直播与回放必须走同一套切分。** 直播时 `message_start` 关闭上一个思考段并开启新的（而不是像现在这样往
同一个块里追加）；回放时从 `thinkingBlocks` 重建同样的段。这条对称性是整个改动的地基：不对称的话，turn
结束前后画面会变形，`transcript-reset` 也会重排已经读过的内容。

### 4.3 thinking 段的合并规则

**相邻的、中间没有工具调用的 thinking 合并成一段。** 一次请求内可能切出多个 thinking block，它们之间没有
工具，切开只是噪音；一个完全没有工具调用的 turn，因此只有一段思考。

### 4.4 step 的种类

| 种类 | 头 | 展开体 | 可折叠 |
| --- | --- | --- | --- |
| 思考 | `思考 12s` + 发丝线，**无灯珠** | 推理全文 | 是 |
| 工具 | 灯珠 + `Read` + 参数 + 后缀 + 耗时 | 见 §6 分族 | 是 |
| 阶段文本 | 无头、无灯珠 | 完整 markdown | **否** |
| subagent | 灯珠 + `Agent` + `explore · 描述` + `opus · 12 工具` | 子转录（`subagent_transcript`） | 是 |
| 系统记录 | `已压缩上下文 · 128k → 42k` + 短发丝线 | —— | 否 |
| 任务更新 | 灯珠 + `TodoWrite` + `更新任务清单` + `3/6` | **无** —— 点击高亮上方任务面板 | 否 |

系统记录（`compact_boundary`、`turn_interruption`、`compact_attempt_failed`）留在**组内**作为不可折叠单行：
它们发生在 turn 中间，「压缩发生在第 7 步之后」本身就是顺序信息。没有 `turnId` 的 notice（`/clear` 提示、
reset 系统消息）天然在组外，不变。

### 4.5 工具 step 的合并

现在 `tool_result` **替换**掉 `tool_use` 行（`transcript.ts:317`）。新模型里一个 step 同时持有调用与结果：
头 = 灯珠 + 调用摘要 + 耗时 + 后缀，体 = 结果内容。耗时由 `tool_use.createdAt` 与 `tool_result.createdAt`
相减得出（无需新增记录字段）。

### 4.6 最终回答的判定

流式期间无法预知哪段文本是最后一段。规则：

1. 流式文本先作为「暂定最终答案」画在**组的正下方**（组外）。
2. 一旦其后出现 `tool_use`，它就地降级为组内最后一个 step（阶段文本，完整展示、不折叠）。
3. `turn-end` 时仍在组外的，即最终答案。

因为阶段文本是完整展示且紧邻组底，这次降级在视觉上**只有缩进与边距变化，位置不动**。真正的收束发生在
turn 结束、组整体折叠时 —— 那是用户预期中的动作。

---

## 5. 开合状态

### 5.1 默认值

| | 外层组 | 内层 step |
| --- | --- | --- |
| turn 进行中 | 展开 | 仅**当前**（最后一个）step 展开，之前的自动收起 |
| turn 结束 | 收起 | 全部收起，**失败的 step 除外**（默认展开） |

「只展开当前 step」是体感核心：实时看得到正在发生的事，已完成的步骤自动坍成一行往上堆，历史顺序一目了然，
且没有任何一段文字在中间无限膨胀。「失败默认展开」的理由：用户点开一个已结束的活动组，通常就是为了看那个失败。

**等待授权时不自动展开**：权限请求画在 composer 里，此刻用户的注意力在下面，转录里再弹开一块 diff 是抢焦点。

### 5.2 手动开合必须存**绝对值**，不能存「偏离」

现有 `model/thinking.ts` 存的是「对默认值的偏离」，因为那里的默认值是**静态**的（流中=展开，封存=折叠）。
新方案里 step 的默认值是**动态**的（「我是不是当前最后一个 step」），偏离语义会翻车：

> 用户手动收起了当前正在跑的 step（记为偏离）→ 下一个 step 追加进来 → 这个 step 的默认值变成「折叠」→
> 偏离让它**自己又展开了**。

因此：**用户一旦手动点过某个 step / 组，就为它记录绝对状态**，此后不再受自动收起摆布；没点过的才走 5.1 的
默认规则。

`transcript-reset` 时必须按现有 `pruneThinkingToggles` 的做法清理陈旧 id —— 该问题在新模型里依旧存在
（重置会让计数器归零、id 被另一个 step 复用）。

### 5.3 组头文案

- 正常收起：`已处理 7m 38s · 12 步`；有失败则追加 `· 1 失败`（**不**强制展开）。
- 进行中：`工作中 · N 步`。
- 中断（`aborted`，无耗时）：`已中断 · 5 步`。
- **零 step 的 turn**（秒回，无思考无工具）：不画空组，退回今天的单行耗时 —— 点开是空的折叠头是纯噪音。
- 现有的 `duration` item 并入组头，不再单独成行。

---

## 6. 工具 step 的展开体

### 6.1 显示名从哪来：主进程投影 DTO

`tools/display.ts` value-import 了 `getBuiltinTools()`，渲染器**不能**导入它（CLAUDE.md 的 Node-only 层
禁令）。**决定：由主进程投影成 DTO** —— `SessionHost` 送记录时顺手带上
`{ displayName, useSummary, activityDescription }`。`tools/display.ts` 保持唯一真相源，不新增持久化字段，
回放同样走主进程所以自然生效。（否决：渲染器复刻规则必然与 TUI 漂移；往 `ToolUseRecord` 加持久化字段既动
记录格式，旧会话又还是没有。）

结果侧的 `display.summary` / `headerSuffix` / `detail` 已经在记录上，是 plain data，直接读。

### 6.2 分族

| 族 | 头 | 展开体 |
| --- | --- | --- |
| 编辑 Edit/MultiEdit/Write/NotebookEdit | `Edit src/foo.ts · +12 −3` | **真 diff**，复用 `diffRows` + `diffView` |
| Shell Bash | `Bash npm test · 3.2s` | 终端块：等宽、`--surface-card` 底、失败整块转 `--text-danger` |
| 读取 Read | `Read src/foo.ts · 240 行` | 代码块，带行号，**不做语法高亮** |
| 检索 Grep/Glob | `Grep "turnId" · 8 处 / 3 文件` | 按文件分组的结果列表，**路径可点**（`open-in-editor`） |
| Agent | `Agent explore · opus · 12 工具` | prompt / response，子转录 |
| Web | `Fetched example.com · 24 KB` | 正文摘要 |
| 任务 TodoWrite | `TodoWrite 更新任务清单 · 3/6` | 无（见 §7） |
| 兜底 | `工具名 + display.summary` | `display.detail ?? content`，超 N 行折起 |

共通：失败时错误码单独一行；输出块 `max-height` 后内部滚动（**这是块内滚动，不是把整个组塞进滚动窗**）。

### 6.3 一个必须补的数据缺口

编辑类工具的结果**不带 patch** —— `editFile.ts:71` 的 display 只有 `summary: "Edited x"`。要在转录里画真
diff，只能：(a) 工具侧补 `display.detail` 输出统一 patch 文本；(b) 复用同一 turn 权限请求阶段的 `preview`。
**(b) 不可靠** —— `acceptEdits` / `bypass` 模式下根本没有权限请求。

**决定：走 (a)，接受改动 `src/tools/` 的编辑类工具**，让它们在 `display.detail` 里输出统一 patch。这是本
设计唯一越出渲染层的改动。

### 6.4 分期

1. **第一期**：模型层重构（§4/§5）+ 灯珠视觉（§3）+ 任务面板（§7）+ 兜底展开体（`display.summary` /
   `detail`）。这一步就已经把「简陋」的根因解决了：所有工具立刻有了正确的摘要与可展开的细节。
2. **第二期**：编辑（真 diff，含 6.3 的工具侧补数据）、Shell、检索三族的专属展开体，以及路径可点。
3. **暂不做**：语法高亮（要引新依赖）。Bash 输出的 ANSI 先**剥离**转义序列（现在会原样打印乱码），彩色
   渲染留待有独立的 DOM 侧 ANSI→span 纯函数时再上。

---

## 7. 任务面板：会话级，常驻输入框上方

### 7.1 为什么不在组里

任务清单描述的是**接下来要做什么**，跨轮次有效；把它画在某一轮的活动组里，等于把一份全局状态钉死在历史的
某个位置上 —— 组一收起就看不见了，而它恰恰是最该一直看得见的东西。

### 7.2 位置与形态

`.composer-column` 内、`#composer` 之上的**在流**元素（不是 `#composer-popovers` 里的绝对定位层 ——
那三个是 transient 的，任务面板是常驻的，放进去会和 surface/suggestions/queue 的层叠与 pointer-events 打架）。
与输入框同轴同宽，所以它读起来是「输入框的一部分」而不是「转录的尾巴」。

- **收起态（默认）**：顶边一条 2px 进度条（`--accent-brand` 填充，宽度按完成比例，`--motion-slow` 过渡）+
  一行 `3/6` + 当前进行中任务的标题（截断）。
- **展开态**：完整清单，每项一颗灯珠 —— 完成绿、进行中灰闪、待办空心描边；完成项的文字加删除线并降到
  `--text-tertiary`。
- **只读**：清单的所有者是模型，行不可点、不可编辑。
- **无清单时整个面板不存在**（不是 `hidden` 占位），出现时一次 `translateY(6px) → 0` 的浮起。

### 7.3 数据与生命周期

- 数据源是最近一次 `TodoWrite` 的 `tool_result.display.taskSnapshot` —— 它是**快照**，最新的一份即全部真相，
  不需要累积。
- 会话级：换 pane / `/resume` 后，从记录里**倒序找到第一条**带 `taskSnapshot` 的 `tool_result` 即可恢复。
- 全部完成后保留一轮（进度条填满、当前项显示「全部完成」），下一条用户消息发出时移除 —— 已完成的清单不再是
  「接下来做什么」，但立刻消失会让人怀疑刚才有没有做完。
- `transcript-reset` 清空它。
- 转录里对应的 `TodoWrite` step 保留为**不可展开的单行**（顺序信息有价值：「第 7 步更新了清单」），点击它让
  上方面板闪一下描边，而不是在组内重复画一遍清单。

---

## 8. 无障碍与滚动

- **组头对朗读器保持稳定文案。** 转录是 `aria-live="polite"`；组头若跟着当前活动实时变化，朗读器会不停播报。
  变化的部分放在当前 step 的头上 —— 那才是真正的新内容。
- 折叠时 body **不存在**而非 `hidden`（现有规则保留）：`aria-live` 区域里一个隐藏但存在的流式块，是没人要求
  朗读的文本。
- 每个 step 头是 `<button>`，带 `aria-expanded`；灯珠是纯装饰（`aria-hidden`），状态另以文本形式出现在可访问
  名里（「失败」「等待授权」），**因为颜色不能是唯一的状态载体**。
- **按 id 复用节点。** 自动收起会让上方内容变矮，浏览器 `overflow-anchor` 本可吸收，但 `transcriptView.ts:65`
  每次 `replace()` 重建整棵子树，锚点失效。`transcriptView.ts` 顶部注释里「有性能问题再按 id keying」的那一天，
  会因为这个改动提前到来。

---

## 9. 视觉约束

沿用 `CLAUDE.md` 既有规矩，本设计不引入例外：

- **深度只有两级**（menu/popover 与 modal）。step **不做卡片**，不得引入第三种阴影或圆角层级；分层靠缩进、
  留白和发丝线。任务面板是一张描边卡（`--surface-card` + `--border-subtle` + `--radius-md`），**没有阴影**。
- `--accent-*` 不填背景，三处例外之外不加第四处。任务面板的进度条是 2px 的**指示条**，属于
  `--accent-brand` 作为「指示条」的既有用法；灯珠是图标级色块，同理。
- 间距 / 圆角 / 字号一律走 token（`--space-1..7`、`--radius-*`、七级 `--type-*`）。
- 动效走 `--motion-*` + 两条曲线。灯珠的闪烁与流光是**存在性跟随状态**的元素上的循环动画，允许；展开/收起用
  `grid-template-rows: 0fr → 1fr`（与侧栏分组同一手法），不加在会在自己底下重绘的转录条目上。
- 每个交给 `controls.ts` 的 `button()` 的类名都要有静息态 CSS 规则，否则 `rendererStyleTokens.test.ts` 会拦；
  其无法推断覆盖的显式控件清单需同步更新。

---

## 10. 兼容与降级

- **旧会话**：`thinkingBlocks` 缺失的历史 JSONL，其活动组只有工具、没有思考。**接受该降级，不做标注。**
- 旧记录没有 `display.detail` 的编辑调用，展开体退回 `content`（即 `Edited x` 一行），不报错。
- 权限请求、rewind、queue 等既有交互不受影响；任务面板在权限请求期间照常显示（它在 composer 之上，不被
  `#composer.request-open` 影响）。
- `model/transcript.ts` 仍必须 DOM-free（`test/` 导入它，基础 tsconfig 无 DOM lib），`applySessionEvent` 仍
  必须以 `assertNever` 收尾、对 `SessionEvent` 保持穷尽。

---

## 11. 受影响的模块

| 模块 | 变化 |
| --- | --- |
| `model/transcript.ts` | items 平铺 → 按 `turnId` 分组；thinking 按请求切段；tool_use/result 合并成一个 step |
| `model/thinking.ts` | 泛化为活动组/step 的开合决策（绝对状态 + 动态默认值 + 剪枝） |
| `model/tasks.ts`（新） | `taskSnapshot` → 面板视图模型（计数、当前项、进度比例） |
| `dom/transcriptView.ts` | 两层披露渲染；灯珠；按 id 复用节点；进度并入当前 step |
| `dom/taskPanelView.ts`（新） | 输入框上方的常驻面板 |
| `paneSession.ts` | 开合状态集合从「thinking toggles」扩为「组与 step」；移除全局 `.tool-progress` 节点；持有任务快照 |
| `index.html` / `styles.css` | `.composer-column` 内新增面板宿主；灯珠、step 行、展开体、面板样式 |
| 协议 / `SessionHost` | 工具显示名 DTO 投影（§6.1） |
| `src/tools/` 编辑类 | `display.detail` 补统一 patch（§6.3，第二期） |
| 测试 | 纯 model 测试优先：分组、切段、默认开合、绝对状态、剪枝、失败态、零 step 退化、快照恢复 |
