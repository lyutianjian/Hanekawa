# 活动组：技术实施文档（任务清单）

配套设计文档：`activity_group_design.md`。原型：`prototype/activity-group.html`。

## 执行约定

- **每完成一个任务点，立即 commit 一次**（一个任务 = 一个 commit）。提交信息格式：
  `AG-<任务号> <一句话描述该任务改变了什么>`，与仓库现有 `P4-5 …` 风格一致。
- 每个任务点的粒度按「一次 agent 会话能完整做完并跑过验收测试」控制。跨任务不留半成品：
  任务结束时 `npm run typecheck` 与该任务的验收测试必须全绿。
- 完成后把该任务的 `[ ]` 改成 `[x]`，并在同一个 commit 里带上本文件的改动。
- 顺序即依赖顺序。标注了「依赖」的任务不得提前开工；同一阶段内无依赖关系的可并行。
- 约束以 `CLAUDE.md` 为准，尤其：`model/transcript.ts` 必须 DOM-free、`applySessionEvent` 必须以
  `assertNever` 收尾、渲染器不得 value-import Node-only 层、深度只有两级、`--accent-*` 不填背景、
  间距/圆角/字号/动效一律走 token。

## 阶段总览

| 阶段 | 任务 | 交付 |
| --- | --- | --- |
| 0 数据与协议 | T1 | 工具显示名 DTO 投影 |
| 1 模型层 | T2–T6 | 分组、切段、合并、开合决策、任务面板模型 |
| 2 视图层 | T7–T11 | 两层披露渲染、灯珠、任务面板、接线、样式收口 |
| 3 专属展开体（二期） | T12–T16 | 编辑真 diff、Shell、检索、其余族 |
| 4 收尾 | T17 | 无障碍、回归、文档同步 |

---

## 阶段 0：数据与协议

### [x] T1 — 工具显示名 DTO 投影（§6.1）

**目标**：渲染器拿到 `displayName` / `useSummary` / `activityDescription`，不再自己猜 input 的键名。

**改动**
- `src/runtime/protocol/wire.ts`：新增 `ToolDisplayDto { displayName: string; useSummary: string;
  activityDescription?: string }`，以及每个携带记录的负载上的旁挂映射
  `toolDisplays?: Record<string /* tool_use record id */, ToolDisplayDto>`。
- `src/runtime/protocol/host.ts`：新增一个 `projectToolDisplays(records)` 助手，**在所有携带记录的
  出口统一调用** —— `forwardSessionEvent`（`type: 'record'` 与 `'transcript-reset'`）、`hello`、
  rewind 后的记录重发。数据源是 `src/tools/display.ts` 的 `getToolDisplay` /
  `getToolActivityDescription`，它保持唯一真相源。
- 不新增任何持久化字段，不改 JSONL 格式；旧会话经主进程投影同样生效。

**要点**
- 值必须能过 `structuredClone`：纯字符串，不带函数、不带工具对象。
- 命令 schema 若校验入站结构不受影响（这是出站事件）；但 `protocolWire` 的 DTO 断言要同步。

**验收**：`node --import tsx --test test/protocolWire.test.ts test/protocolHost.test.ts
test/protocolClientParity.test.ts`，新增一条「tool_use 记录附带 toolDisplays，且 transcript-reset 与
hello 走同一投影」的回归。

---

## 阶段 1：模型层（DOM-free，纯函数优先）

### [x] T2 — `model/transcript.ts` 分组骨架：回放路径（§4.1、§4.4）

**目标**：把平铺 items 变成「活动组 → step」两层结构，**先只做从记录重建（回放）**，直播路径留到 T3。

**改动**
- 新增导出类型：`ActivityGroup { turnId; steps; status: 'running'|'done'|'aborted'; durationMs?;
  stepCount; failedCount }`、`ActivityStep` 判别联合（`thinking` / `tool` / `text` / `subagent` /
  `system` / `task`）。
- `createTranscriptState(records)` 按 `turnId` 分组；无 `turnId` 的记录（`/clear` 提示、reset 系统
  消息、user 消息）留在组外，顺序不变。
- `thinkingBlocks` 缺失的旧会话：该组只有工具 step，不做任何标注（§10）。
- 相邻且中间无工具调用的 thinking 合并成一段（§4.3）。
- `TranscriptState.items` 暂时保留为派生视图或直接替换 —— 二选一在本任务里定下并写进模块头注释，
  后续任务不得再改结论。

**要点**：`applySessionEvent` 保持对 `SessionEvent` 穷尽 + `assertNever`；模块保持 DOM-free。

**验收**：`test/rendererTranscriptModel.test.ts` 新增分组、切段、合并、旧会话降级、零 step turn 的
用例；`test/transcriptOrdering.test.ts` 保持绿。

### [x] T3 — 直播切段与最终回答降级（§4.2、§4.6）

**依赖**：T2。

**目标**：直播与回放走同一套切分，turn 结束前后画面不变形。

**改动**
- `message_start` **关闭上一个思考段并开启新的**（替换现有 `appendThinking` 往同一块追加的行为，
  连同 `transcript.ts:283` 那段解释取舍的注释一并改写）。
- `thinking_delta` 追加到当前段；`thinking_stop` 不再承担分段职责。
- 流式文本先作为「暂定最终答案」置于组外；其后一旦出现 `tool_use`，就地降级为组内最后一个
  step（阶段文本、完整展示、不可折叠）；`turn-end` 时仍在组外的即最终答案。
- `turn-end`：写入组的 `durationMs` / `aborted`，原 `duration` item 并入组头，不再单独成行（§5.3）；
  零 step 的 turn 退回今天的单行耗时，不画空组。

**验收**：`rendererTranscriptModel.test.ts` 新增「直播序列与用同一批记录回放，产出的组结构逐字段
相等」的对称性测试 —— 这是本设计的地基，必须有；外加降级、中断、零 step 三条。

### [x] T4 — tool_use / tool_result 合并成一个 step（§4.5）

**依赖**：T2、T3；消费 T1 的 DTO。

**改动**
- 一个工具 step 同时持有调用与结果：头 = 灯珠状态 + `displayName` + `useSummary` +
  `display.headerSuffix` + 耗时；体 = `display.detail ?? content`。
- 耗时 = `tool_result.createdAt − tool_use.createdAt`，不新增记录字段。
- 状态四态：`awaiting-approval` / `running` / `done` / `failed`（§3），由记录与
  `tool_approval` 的存在性推导，**颜色不是唯一载体**，状态同时以文本形式暴露给 T7。
- 删除 `toolCallSummary` / `toolResultSummary` 的猜键名逻辑（`transcript.ts:429–449`），改读 DTO；
  DTO 缺失时才回退到旧逻辑（旧协议兼容）。
- `TodoWrite` 归为 `task` 种类的不可展开单行（§4.4）。

**验收**：`rendererTranscriptModel.test.ts` 覆盖合并、耗时、失败态、DTO 缺失回退、`TodoWrite` 单行。

### [x] T5 — 开合决策：`model/thinking.ts` 泛化（§5）

**依赖**：T2–T4。

**目标**：把「对默认值的偏离」换成**绝对状态 + 动态默认值**。

**改动**
- 模块重命名/扩写为活动组与 step 的开合决策（保留 `thinkingHeaderLabel` 等仍有效的导出，或在
  重命名时同步 `test/rendererThinking.test.ts` 与所有 import）。
- 默认值表（§5.1）：turn 进行中 → 组展开、仅最后一个 step 展开；turn 结束 → 组收起、全部收起，
  **失败的 step 除外**；等待授权**不**自动展开。
- 用户手动点过的组 / step 记录**绝对状态**，此后不受自动收起摆布。
- `pruneThinkingToggles` 泛化为对组 id 与 step id 的剪枝，`transcript-reset` 后清理陈旧 id。

**验收**：`test/rendererThinking.test.ts` 补齐「手动收起当前 step → 追加下一个 step → 它必须保持
收起」这条曾经会翻车的用例，以及失败默认展开、等待授权不展开、reset 剪枝。

### [x] T6 — `model/tasks.ts`（新）：任务面板视图模型（§7.3）

**依赖**：无（可与 T2–T5 并行）。

**改动**
- 输入是记录列表，倒序找到第一条带 `display.taskSnapshot` 的 `tool_result`，产出
  `{ tasks, counts, activeTask, ratio, allDone }`；无快照时返回 `undefined`（面板整个不存在）。
- 生命周期：全部完成后保留一轮，下一条用户消息发出时移除；`transcript-reset` 清空。
- 纯函数，DOM-free。

**验收**：新增 `test/rendererTasks.test.ts` —— 快照恢复、进度比例、当前项、全部完成保留一轮、
reset 清空。

---

## 阶段 2：视图层

### [x] T7 — `dom/transcriptView.ts`：两层披露渲染 + 按 id 复用节点（§8）

**依赖**：T2–T5。

**改动**
- 渲染组头（文案见 §5.3）+ 有序 step；每个 step 头是 `<button>` 带 `aria-expanded`；折叠时 body
  **不存在**而非 `hidden`。
- 放弃每次 `replace()` 重建整棵子树，改为**按 id 复用节点**（`transcriptView.ts:65`），否则自动
  收起会破坏 `overflow-anchor` 的滚动锚定。
- 展开体先只做兜底族：`display.summary` 头 + `display.detail ?? content` 体，超 N 行折起。
- 保持既有的 jump-to-bottom 与 `atBottom` 跟随逻辑。

**验收**：`test/rendererTranscriptView.test.ts`（`test/helpers/domStub.ts`）覆盖两层结构、
`aria-expanded`、折叠时 body 缺席、同 id 节点在重绘间被复用。

### [x] T8 — 灯珠与 step 行样式（§3、§9）

**依赖**：T7。

**改动**（`styles.css`，替换 `styles.css:1251` 起的 8 行工具样式）
- 7px 灯珠四态：等待授权 `--accent-warn` 闪烁、执行中 `--text-tertiary` 呼吸、完成
  `--accent-review` + pop、失败 `--accent-danger` + pop。思考行**无灯珠**，右侧改用发丝线 /
  `--accent-tool` 流光。
- 组头收起时右排 4px 微灯珠序列。
- **不画展开指针**，整行即开关，`:hover` 底色是唯一暗示；不用字符表达状态。
- step **不做卡片**：不得引入第三种阴影或圆角层级，分层靠缩进、留白、发丝线。
- 展开/收起用 `grid-template-rows: 0fr → 1fr`；循环动画只加在「存在性跟随状态」的元素上。
- 交给 `controls.ts` `button()` 的每个新类名都要有静息态规则。

**验收**：`node --import tsx --test test/rendererStyleTokens.test.ts`，同步更新其无法推断覆盖的
显式控件清单；`ACCENT_FILL_EXCEPTIONS` 保持三条不变。

### [x] T9 — 任务面板：DOM + 宿主（§7.2）

**依赖**：T6。

**改动**
- `src/desktop/renderer/index.html`：在 `.composer-column` 内、`#composer` **之上**新增在流宿主
  （**不是** `#composer-popovers` 里的绝对定位层）。
- 新增 `dom/taskPanelView.ts`：收起态 = 2px 进度条（`--accent-brand` 指示条用法）+ `3/6` + 当前
  任务标题截断；展开态 = 完整清单，每项一颗灯珠，完成项删除线并降到 `--text-tertiary`；只读，行
  不可点、不可编辑；无清单时**整个面板不存在**，出现时一次 `translateY(6px) → 0`。
- 样式：`--surface-card` + `--border-subtle` + `--radius-md`，**无阴影**。
- 权限请求期间照常显示（不受 `#composer.request-open` 影响）。

**验收**：新增 `test/rendererTaskPanelView.test.ts`；`rendererStyleTokens.test.ts` 绿。

### [x] T10 — `paneSession.ts` 接线

**依赖**：T5、T7、T9。

**改动**
- 开合状态集合由「thinking toggles」扩为「组与 step 的绝对状态」，剪枝调用点同步。
- 移除全局 `.tool-progress` 节点（`paneSession.ts:288`），进度并入当前 step 的头。
- 持有任务快照并在记录到达 / `transcript-reset` / pane 切换 / `/resume` 时更新面板。
- `TodoWrite` step 被点击时让上方面板闪一下描边，不在组内重复画清单。
- 任何影响 `hasOverlay` / `isStreaming` 的改动仍须调用 `onShellChanged`。

**验收**：`npm run typecheck` + `test/rendererBoot.test.ts`、`test/desktopUiRoundTrip.test.ts`、
`test/rendererImports.test.ts`。

### [x] T11 — 第一期收口：全量回归

**依赖**：T1–T10。

**改动**：只修回归，不加新功能。跑 `npm run typecheck` 与完整 `npm run test`，重点关注
`rendererTranscript*`、`rendererThinking`、`transcriptOrdering`、`rendererStyleTokens`、
`desktopUiRoundTrip`、`protocol*`。第一期到此为止，「简陋」的根因已解决：所有工具有正确摘要与可
展开细节。

---

## 阶段 3：专属展开体（二期，§6.2）

### [x] T12 — 编辑类工具补 `display.detail` 统一 patch（§6.3）

**目标**：这是本设计**唯一越出渲染层**的改动。

**改动**：`src/tools/` 的 Edit / MultiEdit / Write / NotebookEdit（`editFile.ts:71` 起）在
`display.detail` 里输出统一 patch 文本。不改记录格式，不依赖权限请求的 `preview`（`acceptEdits` /
`bypass` 模式下根本没有权限请求）。

**验收**：`node --import tsx --test test/tools.test.ts test/fileToolPreview.test.ts
test/notebookEdit.test.ts`，新增 patch 文本格式的断言。

### [x] T13 — 编辑族展开体：真 diff

**依赖**：T12、T7。

**改动**：复用 `model/diffRows.ts` + `dom/diffView.ts`（今天只服务权限对话框）渲染带行号槽的真
diff；头显示 `Edit src/foo.ts · +12 −3`。旧记录没有 `display.detail` 时退回 `content` 一行，不报错。
省略行用 CSS 虚线规，不用字符。

**验收**：`test/rendererDiffRows.test.ts` + 转录视图新增用例。

### [x] T14 — Shell 族展开体 + ANSI 剥离

**依赖**：T7。

**改动**：Bash 展开体为终端块（等宽、`--surface-card` 底、失败整块转 `--text-danger`）；输出块
`max-height` 后**块内滚动**。ANSI 转义序列先**剥离**（现在原样打印乱码），彩色渲染留待有独立的
DOM 侧 ANSI→span 纯函数时再上。失败时错误码单独一行。

**验收**：ANSI 剥离写成纯函数并单测；视图用例覆盖失败整块变色。

### [x] T15 — 检索族展开体 + 路径可点

**依赖**：T7。

**改动**：Grep / Glob 按文件分组的结果列表，路径通过 `open-in-editor` IPC 可点 —— 该调用需
`await` 并携带 `projectRoot`，进程 spawn 留在 `src/desktop/openInEditor.ts`。

**验收**：`test/openInEditor.test.ts` + 视图用例（点击路径发出正确的命令负载）。

### [x] T16 — Read / Agent / Web 三族展开体

**依赖**：T7。

**改动**：Read = 带行号代码块，**不做语法高亮**（不引新依赖）；Agent = prompt / response +
子转录（`subagent_transcript`），头为 `Agent explore · opus · 12 工具`；Web = 正文摘要。

**验收**：各族一条视图用例 + 兜底族仍生效的回归。

---

## 阶段 4：收尾

### [x] T17 — 无障碍、滚动与文档同步（§8、§9）

**依赖**：全部。

**改动**
- 组头对朗读器保持**稳定文案**（转录是 `aria-live="polite"`），变化的部分只放在当前 step 的头上。
- 灯珠 `aria-hidden`，状态另以文本出现在可访问名里（「失败」「等待授权」）。
- 复核按 id 复用节点后的滚动锚定行为（自动收起不得把读者甩走）。
- 更新 `CLAUDE.md` 与 `AGENTS.md`（两者除标题与首句外保持同步）的渲染器不变量：活动组两层披露、
  灯珠是工具唯一状态语汇、任务面板归属 `.composer-column`、开合存绝对状态。
- 全量 `npm run typecheck` + `npm run test`；桌面冒烟 `npm run smoke:desktop`（需显示器与凭据）。

**验收**：全绿，且 `rendererStyleTokens.test.ts` 的显式清单与新控件一致。

---

## 明确不做

- TUI（`src/tui/transcript.ts`）本轮不动 —— Ink 的 `<Static>` 无法回收已输出内容。
- 语法高亮（要引新依赖）。
- ANSI 彩色渲染（先只剥离）。
- 旧会话缺 `thinkingBlocks` 的标注（接受降级，不提示）。
