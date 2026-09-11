# Prompt Audit Remediation

提示词审计（Claude API `audit`）结果的落地文档：把 12 条 finding 转成可执行的修复任务。已逐条对照当前代码核实，行号为核实后的实际行号（审计原文中 `compact.ts:395` 实为 `:414`，`agentTool.test.ts:1746/1760` 实为 `:1747/:1761`，`:1777` 实为 `:1778`）。

## 1. 结论摘要

审计覆盖 7 个提示面（系统提示段、模式提醒、子代理系统提示、后台调用提示、26 个工具描述、请求配置、规则文件）。工具描述与请求配置整体合格；问题集中在三类：

1. **对着无工具请求强调"禁止调用工具"**（compact 提示）。
2. **在权限系统已锁死的只读子代理前面再挂禁令横幅**（explore / plan 子代理）。
3. **plan mode 的流程编排**：固定 subagent 数量、按 5 轮周期重复注入同一条已在系统块常驻的规则。

共 12 条：High 3、Medium 7、Low 2（仅记录、不改）。改动全部为提示文本 + 少量常量/死代码清理，不涉及运行时语义。

## 2. 任务清单

按可独立落地的 hunk 组织。每个任务列出「改哪儿 / 改什么 / 配套测试 / 验证」。任务之间无依赖，可任意子集落地。

**状态标注约定**：每个任务标题前的方框表示完成状态 —— `[ ]` 未完成，`[x]` 已完成并通过验证。落地一个任务后，先跑该任务的「验证」命令，通过再把 `[ ]` 改成 `[x]`，然后连同代码改动一起 commit。未通过验证的任务保持 `[ ]`，并在任务末尾补一行说明卡在哪。

当前进度：**10/10 完成**。

### [x] T1 · 删除 compact 提示的 no-tools 前后缀（F1，High）

- **文件**：`src/prompts/compactPrompt.ts:7-17`（`NO_TOOLS_PREAMBLE`）、`:121-124`（`NO_TOOLS_TRAILER`）、`:133-140`（`getCompactPrompt`）
- **依据**：`src/harness/compact.ts:414` 构造摘要请求时传 `tools: []`，模型在 API 层就无工具可调。提示在威胁一个不可能发生的动作，且同一条规则前后各说一遍。
- **动作**：删除两个常量及其在 `getCompactPrompt` 中的拼接，`prompt` 直接以 `BASE_COMPACT_PROMPT` 起头。
- **配套测试**：`test/compact.test.ts:812`、`:916` 断言 `/CRITICAL: Respond with TEXT ONLY/`，改为断言仍存在的锚点，如 `/create a detailed summary of the conversation/`。
- **验证**：`node --import tsx --test test/compact.test.ts`

### [x] T2 · 删除 `<analysis>` 草稿区指令（F3，High）

- **文件**：`src/prompts/compactPrompt.ts:19-35`（`DETAILED_ANALYSIS_INSTRUCTION`）、`:40`（模板插槽）、`:58-60`（示例块中的 `<analysis>` 部分）
- **依据**：`anthropicPayload.ts` 默认发送 `thinking: { type: 'adaptive' }`，模型本就先推理后作答；而 `formatCompactSummary`（`compactPrompt.ts:166`）随即把 `<analysis>` 整块丢弃 —— 为删掉的文本付输出 token。对 Fable 5.1 另有 reasoning-extraction 触发拒答的风险。
- **动作**：删除常量、模板插槽、示例中的 `<analysis>` 段。**保留** `formatCompactSummary` 里的剥离正则，作为改动前已落盘会话的防御性解析。
- **配套测试**：`test/compact.test.ts:790`、`:896` 喂入含 `<analysis>` 的历史文本，测的是剥离逻辑，保持不变即可。
- **验证**：同 T1。

### [x] T3 · explore 子代理：横幅换成事实句 + 去掉字数上限（F2 + F7，High/Medium）

- **文件**：`src/tools/AgentTool/AgentTool.ts:153-161`（横幅）、`:172`（`under ~500 words`）
- **依据**：`EXPLORE_AGENT` 已设 `permissionMode: 'readonly'`、`lockPermissionMode: true`、`tools: ['Glob','Grep','Read','Bash']`、`disallowedTools: ['Agent','Write','Edit','Delete','MultiEdit']`（`:142-145`）—— 写工具根本不在子代理看到的 schema 里。唯一非显然、值得留的是 Bash 的只读契约。
- **动作**：
  - 横幅 6 行 → 一句：`You search and analyze existing code. You have Glob, Grep, Read, and Bash; Bash runs only commands the plan-mode safety analysis proves are read-only, and every other shell command is denied.`
  - `Keep your final report concise - under ~500 words.` → 受众化表述：按调用方问题所需长度作答，带文件路径与行号。
- **配套测试**：`test/agentTool.test.ts:1747`（横幅正则）、`:1778`（`/under ~500 words/`）需同步改写。`test/tuiRender.test.ts:294` 断言帧中**不含** `READ-ONLY MODE`，两种情况都绿。
- **验证**：`node --import tsx --test test/agentTool.test.ts`

### [x] T4 · plan 子代理：横幅换成事实句 + 收敛 `## Your Process`（F2 + F7，High/Medium）

- **文件**：`src/tools/AgentTool/AgentTool.ts:191-201`（横幅）、`:205-224`（四步流程）、`:236`（`REMEMBER:` 结尾）
- **依据**：同 T3（`PLAN_AGENT` 权限配置见 `:180-183`）。`no mv or cp` / `no redirect operators` / `/tmp` 这类枚举描述的是 harness 已焊死的笼子，并且对一个模型本不会犯的失败做禁令，反而可能锚定它。四步流程（Understand → Explore → Design → Detail）是模型默认规划弧的显式书写，写出来是约束而非信息。
- **动作**：
  - 横幅 → 一句：无文件编辑工具；Bash 仅限 plan-mode 安全分析判定为只读的命令。
  - `## Your Process` 四步 → 一段约束陈述：先用 Glob/Grep/Read 找既有 pattern、utility、相似特性再提新代码；追踪改动涉及的代码路径；交付带排期、依赖与权衡的实施策略。
  - 删除 `:236` 的 `REMEMBER:` 结尾。
  - **保留** `### Critical Files for Implementation`（`:230-234`）—— 调用方会解析这个格式。
- **配套测试**：`test/agentTool.test.ts:1761` 横幅正则改写（如 `/no file-editing tools/`）。
- **验证**：同 T3。

### [x] T5 · plan 审批规则收敛到单一出处（F5，Medium）

当前同一条规则出现在 5 处，模型需要花力气调和不同措辞；其中两处还写在"竞品工具"的描述里 —— 工具描述应是功能契约，不是行为偏好的载体。

- **保留唯一出处**：`src/harness/contextBuilder.ts:138` 的 `PLAN_MODE_SYSTEM_REMINDER`（plan 模式每轮都在动态系统块里）。
- **删除**：
  - `src/harness/planModeAttachments.ts:104` 整条 `**Important:** Use AskUserQuestion ONLY...`（同一块的 `:102` 已陈述回合结束规则）。
  - `src/tools/ExitPlanModeTool/prompt.ts` 末尾的 `**Important:**` 段 —— 与本文件第 8 行 "It signals that planning is done; the user then reviews..." 重复。
  - `src/tools/AskUserQuestionTool/prompt.ts` 的 `Plan mode note:` 整段，压缩为一行 bullet：plan 模式下用本工具澄清需求或在方案间选择，`${EXIT_PLAN_MODE_TOOL_NAME}` 负责请求方案批准。
- **注意**：`EXIT_PLAN_MODE_TOOL_NAME` 的 import 仍被引用，勿删。
- **验证**：`npm run typecheck`

### [x] T6 · plan 提醒去掉固定 subagent 数量（F4，Medium）

- **文件**：`src/harness/planModeAttachments.ts:65-91`（Phase 1 与 Phase 2）
- **依据**：扇出宽度正是模型依自身计划判断更准的事；现文本自相矛盾（`3 agents maximum` / `usually just 1` / `at least 1 by default`）。`it helps validate your understanding` 是作者的启发式，既不是约束也不改变成功判据，却每次注入都要付费。
- **动作**：Phase 1/2 收敛为结果陈述：设计前先探索；范围不确定或涉及多个区域时把广度优先搜索交给 `explore` 子代理，各给一个明确焦点；Phase 2 交给 `plan` 子代理时附上 Phase 1 的文件名、代码路径追踪、需求与约束。删除所有数量规定。
- **配套测试**：`test/planModeAttachments.test.ts` 中断言 full reminder 文案的用例按新文本调整。

### [x] T7 · 取消提醒的周期性重注入（F6，Medium）

- **文件**：`src/harness/planModeAttachments.ts:9-10, 30-34`；关联 `src/harness/planModeManager.ts:247-258`、`contextBuilder.ts:420-422`
- **依据**：`TURNS_BETWEEN_ATTACHMENTS = 5` × `FULL_REMINDER_EVERY_N_ATTACHMENTS = 5` ⇒ 约 70 行的完整 plan 提醒每 25 个 tool-use 回合重注入一次，sparse 版每 5 回合一次。而 `buildPlanModeSystemReminder` 已把同一条规则放进**每一轮**的动态系统块 —— 这条指令从未离开过上下文。每次重复都落在 prompt-cache 边界之外；在保留 thinking 的历史一致性校验下，"先注入后移除"的提醒还算一次 history edit。
- **动作**：
  - `shouldInjectPlanAttachment`：`toolUseTurnsSinceEntry === 0` 之后直接 `return undefined`，保留 entry / reentry / exit 三条路径。
  - 随之成为死代码，一并删除：`TURNS_BETWEEN_ATTACHMENTS`、`FULL_REMINDER_EVERY_N_ATTACHMENTS`、`buildSparsePlanModeReminder`（`:110-115`）、`PlanAttachmentKind` 的 `'sparse'` 分支，以及 `planModeManager.ts:256-258` 的 `sparse` 分支。
  - 更新 `test/planModeAttachments.test.ts:10-11, 45, 55-68, 94-99, 129-133`。
- **验证（本任务独有）**：这是唯一一条基于"模型保持力"的假设而非"代码已强制"的事实。合并前须做行为验证：跑一轮长 plan-mode 会话（≥30 个 tool-use 回合），确认只读约束与"回合必以 AskUserQuestion 或 ExitPlanMode 结束"在改动前后一致。不通过则只落地 T6，保留周期注入。
- **实际落地**：用户在了解上述风险后指示直接改。代码已落地，`typecheck` 通过、全量测试 3376 pass / 0 fail。**长会话行为验证仍未执行** —— 测试只覆盖了"注入决策函数不再按轮数返回提醒"这一结构性事实，覆盖不了"模型在 30 轮后是否仍守住只读约束"。若后续在 plan 模式长会话里观察到模型越权编辑，或回合不以 AskUserQuestion / ExitPlanMode 结束，先回退本任务的 commit 再排查其他原因。

### [x] T8 · 修齐 tool-use 摘要的契约不一致（F8，Medium）

- **文件**：`src/harness/toolUseSummary.ts:44`（system 提示写 `max 120 chars`）vs `:56`（`.slice(0, 200)`）
- **动作**：二选一。推荐把代码对齐提示：`.slice(0, 200)` → `.slice(0, 120)`。或者从提示里删掉数字，让截断本身成为契约。
- **验证**：`npm run typecheck` + 相关 harness 测试。

### [x] T9 · 消除两个系统段之间的长度指令重叠（F9，Medium）

- **文件**：`src/harness/contextBuilder.ts:117`、`:128`
- **依据**：`TONE_AND_STYLE_SECTION` 的 `Your responses should be short and concise.` 与三行之后 `OUTPUT_EFFICIENCY_SECTION` 的 `Brief is good — silent is not.` 部分冲突，模型要先调和两种措辞。`one or two sentences` 是对最需要留余地的那个输出面的硬夹。
- **动作**：
  - 删除 `:117` 的 `Your responses should be short and concise.` 一行。
  - `:128` `End-of-turn summary: one or two sentences. What changed and what's next.` → `End your turn with a short summary: what changed and what's next.`
  - `OUTPUT_EFFICIENCY_SECTION` 其余内容是针对当前模型（倾向少叙述）的正确再基线，**不动**。
- **验证**：`npm run typecheck` + 断言系统提示文案的测试。

### [x] T10 · 去掉两个工具描述里的强调标记（F10，Medium）

- **文件**：`src/tools/GrepTool/prompt.ts:18`、`src/tools/BashTool/prompt.ts:35`
- **依据**：规则本身正确，且放在被"引导离开"的 Bash 描述里是对的。过时的是大写 booster —— 当年治欠触发，如今造成过触发；Grep 那句还是对 Bash 契约的交叉引用。两个描述的其余部分是范本，勿动。
- **动作**：
  - Grep：`- ALWAYS search with this tool. NEVER run \`grep\` or \`rg\` through Bash.` → `- Search with this tool rather than running \`grep\` or \`rg\` through Bash.`
  - Bash：去掉 `IMPORTANT: ` 前缀，句首改为 `Avoid running ...`。紧随其后的理由句（"The dedicated tools let the user review and approve your work"）已承担分量。

## 3. 仅记录、不改动

| 编号 | 位置 | 判断 |
|---|---|---|
| F11 | `contextBuilder.ts:86` 安全段的 `IMPORTANT:` | 这是静态系统提示中三个 `IMPORTANT/CRITICAL` 之一；T1/T3/T4 落地后它成为唯一一个，届时该标记重新携带信息。不改。 |
| F12 | `contextBuilder.ts:352-361` 动态块在缓存边界之外 | 代码注释已显式写明取舍，且易变内容正确地排在稳定前缀之后 —— 这是有意且有记录的决策，不是隐式失效。T7 本身会缩小它。不改。 |

## 4. 落地与验证顺序

1. T1 + T2（同文件，配套 `test/compact.test.ts`）→ `node --import tsx --test test/compact.test.ts`
2. T3 + T4（同文件，配套 `test/agentTool.test.ts`）→ `node --import tsx --test test/agentTool.test.ts`
3. T5 + T9 + T10（纯文案）→ `npm run typecheck`
4. T8 → `npm run typecheck`
5. T6 → `node --import tsx --test test/planModeAttachments.test.ts`
6. T7 → 同上测试 **＋** 长 plan-mode 会话行为验证；不通过则回退本任务
7. 全量：`npm run typecheck && npm run test`

## 5. 落地记录

分两次提交：

1. T1–T6、T8–T10 —— `npm run typecheck` 通过，`npm run test` 3378 pass / 0 fail。
2. T7 —— 单独一次提交，便于出问题时整体回退。删除 `TURNS_BETWEEN_ATTACHMENTS`、`FULL_REMINDER_EVERY_N_ATTACHMENTS`、`buildSparsePlanModeReminder`、`PlanAttachmentKind` 的 `'sparse'` 成员及 `planModeManager` 的 `sparse` 分支后，`shouldInjectPlanAttachment` 只在 entry / re-entry / exit 三个转换点返回提醒。测试 3376 pass / 0 fail（净减 2 例：删掉的 sparse 用例合并为一条"注入后恒静默"的断言）。

除任务清单预判的测试改动外，实际还需要同步以下断言 —— 它们锚定在被删除的文案上：

| 测试 | 原断言 | 现断言 |
|---|---|---|
| `test/compact.test.ts` `getCompactPrompt returns structured prompt with 9 sections` | `/REMINDER: Do NOT call any tools/` | 反向断言不含 `/Do NOT call any tools/` 与 `/<analysis>/` |
| `test/compact.test.ts` `getCompactPrompt includes custom instructions when provided` | 自定义指令须排在 trailer 之前 | 改为须排在 base prompt 之后（trailer 已不存在） |
| `test/agentTool.test.ts` explore/plan 提示两例 | 匹配 `READ-ONLY MODE` 横幅与流程小标题 | 反向断言不含横幅，正向断言 Bash 只读契约与设计约束句 |
| `test/exitPlanModeTool.test.ts` `ExitPlanMode description includes approval contract` | `/ExitPlanMode inherently requests user approval/` | 反向断言不含 `/Is this plan okay/` |
| `test/planModeAttachments.test.ts` `reminders contain expected anchor text` | `/Use ExitPlanMode to request plan approval/`、`/AskUserQuestion ONLY to clarify/` | 反向断言两者均不在 full reminder 中，并新增不含固定 agent 数量的断言 |

这些反向断言是刻意的：它们把"规则只有一个出处""不写死数量"锁成回归覆盖，避免文案被无意重新引入。

`src/prompts/compactPrompt.ts` 的 `formatCompactSummary` 仍剥离 `<analysis>`，注释已改为说明这是对旧会话的防御性解析。

## 6. 原始审计的前提

- 目标模型为当前世代 Claude（Opus 5 / Fable 5.1）。仓库不硬编码 model ID（用户经 `ConfigService.defaultModel` 配置），但 `src/config/providers/anthropicPayload.ts:287-307` 已发送 adaptive thinking 与 `output_config.effort`（low…max），锁定了目标世代。
- 仓库同时提供 OpenAI 兼容 provider（`src/config/providers/openaiProvider.ts`）。本文所有改动均为 provider 中立的提示文本，不涉及 provider 切换。
- 无 provenance：211 个提交全是 squash 的 `checkpoint:`，`git blame` 取不到逐行动机。结论基于既有 pattern + 代码层强制检查，而非提交历史。
