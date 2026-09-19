# 提示缓存稳定性与长程循环 — 实施规格

这份文档是给**冷启动的后续会话**看的。症状、根因、改法、验收全在这里；不看它直接动 `harness/` 会把已经修对的部分改回去。

读顺序：§1 症状与根因 → §2 不变量（动手前必读）→ §3–§7 五个阶段 → §8 验收 → §9 不做的事。

本次会话只写规格，**未改动任何代码**。

**实施进度**：阶段 1（§3）、阶段 2（§4）、阶段 3（§5）、阶段 4（§6）、阶段 5（§7）均已落地。

阶段 5 的落点与 §7.1 略有出入：占用数不是挂在 wire 的 `snapshot` 事件旁，而是直接成为
`SessionControllerSnapshot.contextUsedTokens`——TUI 用的是 `SessionController`，不经过
`runtime/protocol`，只有放进快照本身两侧才真正读同一个字段（不变量 6）。因此 `host.ts` 的
`currentContextUsed()` 与 wire 上独立的 `contextUsedTokens` 字段一并删除，`SessionController`
自带 `SessionRecordLedger`（在 `reload` / `retarget` / 中断回滚三处 rebase），并在每条记录落库时
publish，使读文件期间的占用实时上涨。

---

## 1. 症状与根因

三个用户可见症状，四个独立成因。

| 症状 | 根因 | 位置 |
|---|---|---|
| 工具密集时缓存命中率暴跌 | A. thinking 块按滑动窗口从历史中剥离 | `src/harness/requestPrep.ts:95` |
| 同上 | B. tool_result 预算压缩的选择集每次请求重算 | `src/harness/requestPrep.ts:149` |
| 同上 | C. 缓存 TTL 默认 5 分钟 | `src/harness/cacheControl.ts:26` |
| 同上 | D. 会变的内容放在第 0 条 user 消息里 | `src/harness/contextBuilder.ts:209` |
| 上下文占用显示偏低 | E. 只读"上一次请求的 promptTokens"，而请求本身被裁剪过 | `src/runtime/protocol/host.ts:440`、`src/tui/components/StatusLine.tsx:75` |
| 长程任务报"超出工具限制" | F. 主会话硬上限 100 轮且抛错 | `src/harness/loop.ts:575`、`loop.ts:1031` |

### 1.1 为什么 A/B/D 会杀掉缓存

Anthropic 的提示缓存按**前缀**命中。请求体的 message 序列一旦在某个位置发生改写，该位置之后的全部内容从 `cache_read` 降级为 `cache_creation`。

三处都不是一次性改写，而是**每次迭代都在动、且动的位置随迭代前移**：

- **A**：`stripThinkingBlocksFromAssistantMessages` 只保留最近 3 轮 assistant 的 thinking，而 thinking 块确实上线（`src/config/providers/anthropicPayload.ts:125`）。每多一轮 assistant 消息，窗口前移一格，倒数第 4 轮的 thinking 被删 → 每轮一次中段改写。普通对话感觉不到是因为尾部内容小；工具循环里最近 3 轮裹着大块 `tool_result`，被作废的量很大。
- **B**：`selectToolResultsToCompact` 每次请求从零重算，"保护最近 10 条"（`RECENT_TOOL_RESULTS_TO_KEEP`，`requestPrep.ts:170`）也随迭代滑动。上一轮还完整的 `tool_result`，这一轮变成 `[summarized: ...]`。
- **D**：`buildUserContext` 产出的消息是 `allContextItems` 的**第 0 项**，其中含 `# activeSkills` 全文。`activateSkills`（`contextBuilder.ts:456`）由 `toolContext.readFiles` 触发 —— 循环中读到一个匹配 fileMatch skill 的文件，第 0 条消息就变了，**整段 message 历史一次性全废**。跨午夜的 `currentDate` 同理。

附带问题：`src/harness/cacheBreakDetection.ts` 只对 system / tools / model / betas 做 hash，**不看 message 历史**，所以 A/B/D 造成的断裂全部被归类成 `server_side`，诊断文件里看不到真因。

### 1.2 为什么显示偏低

`host.ts:440` 的 `currentContextUsed()` 取 `usage.lastRequest` 的 `promptTokens`。两层偏差叠加：

1. 那是**裁剪后**的请求大小。`snipLargeToolResults`（`requestPrep.ts:86` → `src/harness/compact.ts:471`，`DEFAULT_SNIP_MAX_TOKENS = 10_000`）把任何超过 10k tokens 的 `tool_result` 整条丢掉、只留一行 `[Result truncated: ...]`；再叠加 B 的摘要压缩。读多少文件、跑多少测试，请求都撑不大。
2. 工具刚返回、下一次请求还没发出时，显示仍是上一次请求的值，追不上已经堆在历史里的 `tool_result`。

`host.ts:444` 那条 `countSessionRecordsTokens` 估算路径只在"恢复会话且本进程还没发过请求"时生效，正常运行中永远走不到。

`snipLargeToolResults` 还有独立的正确性问题：10k tokens ≈ 40KB，一次大 Bash 输出或 2000 行 Read 就超了，而且 snip 在结果落盘的**同一轮**就生效 —— 模型一次都没看到过那段输出。

### 1.3 为什么会撞轮次上限

`loop.ts:575` 是 `this.options.maxTurns ?? 100`。主会话没有任何调用方传 `maxTurns`（只有子 agent 定义传，见 `src/desktop/shellHost.ts:1625`），所以主会话默认 100 轮；`maxTurnsExceededBehavior` 也只有子 agent 设成 `'partial'`（`src/tools/AgentTool/AgentTool.ts` 构造 `AgentLoop` 处），主会话落到 `loop.ts:1031` 的 `throw new Error('Agent loop exceeded maximum tool iterations')`，整轮成果丢失。

而且这 100 个额度里还有不含工具调用的消耗：fallback 切换（`loop.ts:826`）、`max_tokens` 上限升级（`:888`）、截断续写恢复（`:903`）、`finishTurn` 的 `continueLoop`（stop hook，`:916`/`:934`/`:965`）。

### 1.4 参考材料

对照读过 `/Users/miyano/Documents/code/ClaudeCode`（Claude Code 的还原源码树）。**只借鉴机制，不粘贴代码** —— 本仓库的实现全部自写。对照结论：

- 它不按轮次剥历史里的 thinking（`src/utils/messages.ts` 只在签名非法或消息孤立时过滤）。
- 它的 tool_result 预算带持久化状态（`src/utils/toolResultStorage.ts`）：一条结果**被看过一次就冻结命运**，替换串逐字节存进 transcript 以便 resume 后重放；预算是**按单条消息**算的，不是跨整段历史算。注释明写目的是 "preserve prompt cache"。
- 它给 main thread 默认申请 1h TTL（`src/services/api/claude.ts:371`），不需要用户设环境变量。
- 它的上下文占用 = 最后一次 usage + 之后新增消息的粗估（`src/utils/tokens.ts:226`）。
- 它的交互式循环**不设轮次上限**（`src/query.ts:1705` 的判断是 `if (maxTurns && ...)`），到限也是发一条 `max_turns_reached` 后正常返回，不抛错。
- 大结果它落盘 + 给模型 preview 和文件路径，不丢弃。

---

## 2. 不变量

动手前先读。这些是本次修复必须成立、且很容易被顺手改坏的约束。

1. **请求前缀单调**：对同一个 session，第 N+1 次请求的 message 序列必须以第 N 次请求的序列为前缀（除去 compact 边界这一显式例外）。任何"每次请求重新决定裁剪哪里"的逻辑都违反它。
2. **裁剪决策一次性、可重放**：某条 `tool_result` 一旦以某种形态发给过模型，就永远保持那个形态，直到 compact 把它整段吃掉。决策要能落盘并在 `/resume` 后逐字节重建。
3. **压缩只能向尾部生长**：允许"新来的内容被压缩"，不允许"已发送过的内容被回溯压缩"。
4. **第 0 条 user 消息必须稳定**：随会话状态变化的内容（日期、激活的 skill、恢复的文件）只能放在历史**尾部**的 transient 位置。
5. **cache_control 标记形态在进程内不变**：`cacheControl.ts:24` 的 latch 是对的，不要为了"读设置更及时"去掉它 —— 标记形态一变就是一次整体断裂。
6. **显示数字只有一个来源**：TUI 与桌面必须读同一个字段，不允许各算一遍。
7. **`harness/` 不 import `runtime/`，渲染层不 import `harness/`**：`test/rendererImports.test.ts` 在守这条，新增的显示字段要在 `runtime/` 里算好再上线。
8. **压缩/子 agent/摘要的请求流不得污染主会话的缓存基线**：`cacheBreakDetection` 的 `source` 分区和 `onRequestUsage` 只挂主循环（`loop.ts:844`）这两点都是对的，别扩大。

---

## 3. 阶段 1 — 解除长程循环的硬上限（根因 F）

**独立、低风险，先做，单独验收。**

### 3.1 改法

- `loop.ts:575`：主会话不再落到 100。`maxTurns` 语义改成"未指定即不限"。实现上把 `for (let iteration = 0; iteration < maxTurns; iteration++)` 改成无上限循环 + 可选上限判断，保持子 agent 传入值时的行为不变。
- `loop.ts:1031` 的 `throw` 只在**显式传入了 `maxTurns`** 且行为不是 `'partial'` 时才可能到达。主会话走不到这里。
- 子 agent 路径完全不变：`AgentTool` 仍传 `maxTurns` + `maxTurnsExceededBehavior: 'partial'`，到限仍然是 `buildMaxTurnsExceededContent` 收尾。
- 不含工具调用的 `continue`（`:826`/`:888`/`:903`/`:916`/`:934`/`:965`）不再挤占额度 —— 无上限后这个问题自然消失；但**仍要保留各自已有的独立计数器**（`maxOutputTokensRecoveryCount` 与 `MAX_RECOVERY_COUNT`）防止死循环。

### 3.2 死循环的真正护栏

去掉轮次上限后，防失控靠这三条，都已存在，只需确认仍然生效：

- 用户中断（`signal`）在每轮开头检查（`loop.ts:600` 附近）。
- `tokenBudget` / `tokenWarningThreshold`（`loop.ts:923`–`:952`）。
- 自动压缩（`autoCompactIfNeeded`）保证上下文不爆。

不要新增"最多 N 轮"这类兜底 —— 那就是把同一个 bug 换个数字。

### 3.3 测试

`test/agentLoopMaxTurns.test.ts`（新建，或并入 `test/toolRunner.test.ts` 的同类用例）：

- 主会话跑 150 轮工具调用后正常收尾，不抛错。
- 子 agent 传 `maxTurns: 3` 时仍在第 3 轮后以 `'partial'` 收尾、内容含 max turns 提示。
- `max_tokens` 连续触发时 `maxOutputTokensRecoveryCount` 仍在 `MAX_RECOVERY_COUNT` 处截停。

---

## 4. 阶段 2 — 停止按轮次剥离历史 thinking（根因 A）

### 4.1 改法

- 删掉 `requestPrep.ts` 的 `stripThinkingBlocksFromAssistantMessages` 调用（`:65`）与 `RECENT_ASSISTANT_THINKING_TURNS_TO_KEEP`（`:16`）、`RequestPrepOptions.recentAssistantThinkingTurnsToKeep`（`:34`）。
- 保留 thinking 的合法性清理：签名缺失、`redacted_thinking` 处理、thinking-only 消息导致 API 400 的情形，仍需在 payload 层挡住（`anthropicPayload.ts:125` 已有合并逻辑，确认它对空 `content` 的处理不产生非法消息）。
- compact 时 thinking 随被压缩的历史一起消失 —— 这是唯一允许的清除路径。

### 4.2 顾虑与结论

顾虑是 thinking 占上下文。结论是它由 compact 统一回收，不该由"每轮偷偷删一点"来做：后者省下的 token 远小于它造成的重复 cache write 成本（一次中段改写要重写其后的全部前缀）。

### 4.3 测试

`test/requestPrep.test.ts`：

- 5 轮 assistant 消息、每轮带 thinking → 连续两次 `prepareRecordsForRequest` 的输出在公共前缀上**逐字段相等**。
- 现有断言里凡是期望"老轮次 thinking 被删"的，改成期望保留。

---

## 5. 阶段 3 — tool_result 裁剪决策持久化（根因 B + 1.2 的丢内容问题）

本阶段最大，单独验收。

### 5.1 数据模型

新增一份**按 session 持久化的裁剪台账**，语义与不变量 2/3 对应：

```
ToolResultTrimState {
  seen: Set<toolUseId>            // 已经以某种形态发给过模型的结果
  trimmed: Map<toolUseId, string> // 其中被替换的，存"模型看到的那个字符串"本身
}
```

- 字符串本身入盘，不存"生成规则"—— 规则改了、格式化改了，都不能让 resume 后的前缀变一个字节。
- 落盘位置：会话 JSONL 里新增一种记录（如 `tool_result_trim`），走 `RecordStream` 追加，与现有记录同源。**不要**新开一个 sidecar 文件。
- `/resume` 时从记录重建：在 message 里出现过、但台账里没有替换项的 `toolUseId`，一律进 `seen`（**冻结**，永不再被替换）。
- 子 agent：构造时克隆父台账（fork 类 agent 需要与父完全相同的决策才能共享缓存）；后台 agent resume 时从它自己的 sidechain 记录重建。

### 5.2 裁剪规则改写

`requestPrep.ts` 的两处合并成一条走台账的路径：

- `selectToolResultsToCompact`（`:149`）：预算改成**按单次 assistant 轮次的新增 `tool_result` 聚合量**计算，而不是跨整段历史求和；候选集只含 `seen` 之外的结果；`RECENT_TOOL_RESULTS_TO_KEEP` 这个滑动保护窗随之删除（冻结语义已经覆盖了它要解决的问题）。
- `snipLargeToolResults`（`requestPrep.ts:86` / `compact.ts:471`）：
  - 阈值 10k tokens 提高到与新预算一致的量级（参考量级：单条上限按字符算、总量 200k 字符级别；具体数值在实施时定，写进常量并注释理由）。
  - 超限时**不再丢内容**：把完整输出写进会话目录下的附件区，替换文本给出「前若干行预览 + 落盘路径 + 原始大小」，让模型能用 Read 取回。
  - 落盘失败时退化为"截断 + 说明"，不得让请求失败。
- 两条路径的结果都写进 `trimmed` 并追加记录；下一次请求走 Map 查表重放，不重新判断。

### 5.3 与 compact 的关系

- `progressiveCompact.ts` 的时间触发 micro-compact（`TIME_BASED_MC_GAP_THRESHOLD_MINUTES = 60`）保持原样：它已经明确只在缓存基本确定过期时才动手，注释也写了这个理由。
- compact 发生后，被吃掉的 `toolUseId` 在台账里成为惰性条目，不需要清理（id 是 UUID，永不会被再次查到）。

### 5.4 测试

`test/requestPrep.test.ts` + 新建 `test/toolResultTrimState.test.ts`：

- 构造 30 条大 `tool_result`，逐轮追加并每轮调 `prepareRecordsForRequest`：任意两次相邻输出，公共前缀部分**逐字节相等**。
- 一条结果第一次被替换后，其后 10 次请求的替换串完全相同。
- 从记录重建台账 → 重建后的输出与原始运行的输出相同。
- 超限结果落盘后，替换文本里的路径可读、内容与原始输出一致。

---

## 6. 阶段 4 — 缓存标记与前缀布局（根因 C + D）

### 6.1 TTL 默认 1h（C）

- `cacheControl.ts:26` 的默认值从"env 开关"改成"默认开启，可显式关闭"：`settings.cache.ttl1h === false` 或 `MYAGENT_PROMPT_CACHE_1H=0` 才回到 5 分钟。
- 保留 `latchedTtl1h` 的进程内 latch（不变量 5）。
- `test/cacheControl.test.ts` / `test/cacheControl.invariant.test.ts`：更新默认值断言，补一条"显式关闭仍生效"。

### 6.2 第 0 条消息稳定化（D）

- `contextBuilder.ts:209` 的 `allContextItems` 顺序调整：`buildUserContext` 产出的 `meta:user-context` 只保留**整个会话内不变**的部分；`# activeSkills`、`currentDate`、post-compact 恢复内容移到 `buildTransientUserContext` 所在的**尾部**位置。
- `meta:post-compact-restore`（`:535`）同样移到尾部 —— 它现在插在历史前面。
- 效果：循环中途激活一个 fileMatch skill，只在尾部追加，不作废任何已缓存前缀。
- 副作用确认：`repairToolResultPairing` 不能因为尾部多了一条 user 消息而把它插到 `tool_use` / `tool_result` 之间 —— 尾部 transient 消息必须排在成对的 tool 块**之后**。`test/sessionInvariants.test.ts` 补用例。

### 6.3 断裂归因补齐

`cacheBreakDetection.ts` 增加一路 message 前缀指纹：

- 每次请求前记录"message 序列的滚动前缀 hash 列表"（或更省的：首个与上次不一致的 message 下标）。
- 检测到 cache read 跳水时，报告里给出 `messages_changed_at=<index>` 而不是笼统的 `server_side`。
- 只在 `MYAGENT_DEBUG_PROVIDER=1` 时计算完整指纹，常态路径不付这个开销。
- 这是阶段 2/3/4 的**验收工具**，建议先于它们落地。

---

## 7. 阶段 5 — 上下文占用显示（根因 E）

### 7.1 数字定义

唯一定义：**最后一次请求的 `promptTokens` + 该请求之后新增记录的估算**。

实现路径：

1. `loop.ts:844` 的 `onRequestUsage` 回调除 usage 外再带一个**锚点**：本次请求最后一条记录的 id（循环里已有 `lastResponseRecordId`，语义一致）。
2. `SessionController.handleRequestUsage`（`src/runtime/sessionController.ts:491`）存下 `{ usage, anchorRecordId }`。
3. 占用数在 `runtime/` 层算：`promptTokens(lastRequest) + countSessionRecordsTokens(锚点之后的记录)`，用 `SessionRecordLedger`（`src/runtime/recordLedger.ts`）取记录。
4. 结果作为 snapshot 的一个字段发布，TUI（`StatusLine.tsx:75`/`:88`）与桌面（`host.ts:415` 的 `contextUsedTokens`）都读它，不再各自从 `usage.lastRequest` 现算（不变量 6）。
5. 找不到锚点（compact 后、rewind 后）时退回全量估算 —— 即 `host.ts:444` 现有的路径，保留它的 `ledger.size` 记忆化。

### 7.2 性能

`postSnapshot` 在流式输出时每块都触发。因此：

- 估算结果按 `(anchorRecordId, ledger.size)` 记忆化。
- `countSessionRecordTokens` 对 `tool_result` 已有 `_tokens` 缓存，锚点之后通常只有几条记录，代价可接受。

### 7.3 顺带修正

`StatusLine.tsx:86` 的 `formatStats` 里 `hit:` 与 `in:` 仍用 `lastRequest` 的原始字段（这是"这一次请求"的事实，正确），只把**百分比与总量**换成新字段。

### 7.4 测试

`test/requestPrep.test.ts` 之外新建 `test/contextUsage.test.ts`：

- 请求返回 usage 后追加两条大 `tool_result` → 占用数按估算上涨。
- compact 之后 → 占用数下降到压缩后量级。
- 锚点记录不在 ledger 中（rewind）→ 退回全量估算，不抛错。
- `test/rendererImports.test.ts` 保持通过（新字段在 `runtime/` 算好再上线）。

---

## 8. 验收

每个阶段独立交付、独立验收，不合并提交。

**通用**：`npm run typecheck` + `npm test` 全绿。

**阶段 1**：起一个真实会话，让 agent 连续跑 120+ 轮工具调用（例如遍历仓库逐文件统计），不出现 `Agent loop exceeded maximum tool iterations`。

**阶段 2–4（缓存）**：开 `MYAGENT_DEBUG_PROVIDER=1` 跑一段 30+ 轮工具调用的真实任务，检查 `~/.myagent/diagnostics/` 与 stderr 的 `[hanekawa][cache]` 行：

- 稳定状态下每轮命中率不低于上一轮 —— 允许因新增 `tool_result` 产生 cache write 而使比率自然下探，但**不允许 `cache_read` 绝对值在没有 compact 的情况下下降**。这是最硬的判据。
- 阶段 4 落地后，`cache-break` 记录里不应再出现无法解释的 `server_side`（除真实的服务端逐出）。
- 单次 5 分钟以上的工具调用（跑全量测试）之后，下一轮仍然命中。

**阶段 5**：同一会话里，占用百分比随大文件读取单调上涨，与 `/cost` 的 token 量级一致，compact 后回落。

---

## 9. 不做的事

- **不引入 `cache_reference` / cache-editing**：参考实现有这条路径，但它依赖服务端特性与内部 flag，收益不确定，先不碰。
- **不给循环加新的"最多 N 轮"兜底**（见 §3.2）。
- **不改 `startToolUseSummary`**（`loop.ts:1556`）：它每个工具轮次多发一次小模型请求、把摘要追加到尾部。追加是缓存安全的，成本问题另案评估，不在本规格范围。
- **不合并 TUI 与桌面的状态栏渲染**：只统一数字来源，不动两套视图。
- **不动 `progressiveCompact.ts` 的时间触发策略**（§5.3）。
