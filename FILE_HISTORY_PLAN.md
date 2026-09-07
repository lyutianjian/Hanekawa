# Checkpoint 重构实施文档：shadow-git → file-history

状态：实施中（2026-09-07 核验：T0–T4 已完成，下一个任务是 T5）
影响面：`/rewind` 的「恢复代码」能力，以及它背后的整套快照机制。其余功能不受影响。

---

## 1. 背景与问题

现状实现是 `src/services/checkpoint/checkpointService.ts`：每个会话在 `<cwd>/.myagent/shadow-git/<sessionId>/` 建一个独立的 shadow git 仓库，每个 turn 开始前阻塞地执行 `git add --all` + `git commit`，把**整棵工作树**快照一遍。

实测数据（根目录 `C:\Users\Miyano\Documents\code`，一个装着多个项目的容器目录）：

| 指标 | 数值 |
|---|---|
| 首次 `git add --all`（冷，空 index） | 20.4 s |
| 第二、三次（热，增量） | 0.28 s / 0.24 s |
| 暂存文件数 | 6034 |
| shadow-git 总占用 | 52 GB / 36 个会话 |
| 单会话最大占用 | 9.4 GB |
| 被快照的项目树实际大小 | ~7 GB |

由此暴露两个独立缺陷：

1. **冷启动被稳态预算误杀。** 唯一一次全量 stage 落在第一个 turn 的关键路径上，套 `addTimeoutMs = 15_000`，超时即 `trip()` 永久熔断并删仓——后面那些 0.28 s 就能跑完的 turn 再无机会。用户看到的 `Checkpoints disabled for this session: staging the worktree did not finish within 15000ms.` 就是这条。
2. **零对象共享导致存储爆炸。** 每会话一个独立仓库，同一棵树被压缩存了 36 遍，快照存储达到被快照内容的 7 倍。

缺陷 1 可以打补丁（首次全量挪进 `init()`、冷启动超时不熔断），缺陷 2 是架构性的：成本正比于 worktree 大小 × 会话数，与「用户实际想回退什么」无关。

## 2. 技术选型

### 2.1 候选方案

| 方案 | 时间成本 | 空间成本 | 捕获范围 | 复杂度 |
|---|---|---|---|---|
| A. 维持 shadow-git + 打补丁 | 冷启动 O(树大小)，稳态 O(变更) | O(树大小 × 会话数) | 工作树任意变化 | 已有，低 |
| B. 单仓库多 ref（project 级共享 shadow repo，会话用 ref 区分） | 同上，但只冷启动一次 | O(树大小 + 增量) | 工作树任意变化 | 中高（删会话要删 ref + gc，并发写 index 要加锁） |
| C. file-history：按文件、按需备份（Claude Code 的做法） | O(本轮编辑文件数) | O(编辑过的文件 × 版本数) | **仅 agent 工具改过的文件** | 中 |

### 2.2 选定：方案 C

参考实现是 `C:\Users\Miyano\Documents\code\ClaudeCode\src\utils\fileHistory.ts`。核心机制：

- **只跟踪 agent 自己动过的文件。** 写工具在写之前调用 `fileHistoryTrackEdit()`（`FileEditTool.ts:435`、`FileWriteTool.ts:259`、`NotebookEditTool.ts:312`、`BashTool.tsx:393`），`trackedFiles` 集合由此长出。成本与 worktree 大小完全解耦。
- **备份就是文件副本**：`copyFile` 到 `~/.claude/file-history/<sessionId>/<sha256(路径)前16位>@v<N>`，`chmod` 保留权限。用 `copyFile` 而非 `readFile+writeFile`，注释明确指出后者在大文件上会 OOM。
- **每轮 snapshot 只遍历 tracked 集合**，用 `checkOriginFileChanged()` 三级判断是否需要新版本：先比 `mode`/`size`，再用「原文件 mtime < 备份 mtime ⇒ 未变」短路，最后才读内容比对。未变则复用上一版引用，N 轮不动的文件只存一份。
- **快照数上限** `MAX_SNAPSHOTS = 100`，超出从头淘汰；另有单调递增的 `snapshotSequence`，因为触顶后 `snapshots.length` 不再变化，不能用作活动信号。
- **跨会话去重**：resume 时 `link()` 硬链接旧会话的 backup，失败才 fallback 到 `copyFile`。
- **失败是逐文件的**，记日志后继续处理下一个文件，不存在全局熔断。

### 2.3 取舍（必须明确接受）

**能力收窄：新方案只能回退 agent 通过工具改过的文件。** 用户在编辑器里的手工修改、构建产物、`git checkout`、以及 bash 命令里未被识别的写入，都不再被捕获，也不会被回滚。

这个收窄在两个方向上都是可接受的，甚至是改进：

- `/rewind` 的实际语义是「撤销 agent 刚才干的事」，全树回滚会连带把用户自己的手工修改一起回退掉，属于危险的越权。
- 代价换来的是：冷启动消失、存储降到 MB 级、`isUnsnapshottableRoot` / `addBudgetMs` / `maxFiles` 整套熔断逻辑可以删除——**任何根目录都能正常工作**，包括全局工作区（home）和上面那个 59 G 的容器目录。

BashTool 的写入追踪需要解析命令提取路径，风险与收益都低，列为最后的可选任务（T10）。在 T10 完成前，`Bash` 造成的文件变化不受保护——这一点需要在 rewind UI 或文档中对用户明示。

## 3. 目标与非目标

**目标**

- 每个 turn 的快照开销与 worktree 大小无关。
- 单会话快照存储从 GB 级降到 MB 级。
- 删除「checkpoints 因为根目录太大而被永久关闭」这一整类失败。
- 保持 `/rewind` 三种模式（`restore-conversation` / `restore-code` / `restore-code-and-conversation`）的现有 UI 与文案不变。

**非目标**

- 不捕获 agent 工具之外的文件变化（见 2.3）。
- 不改变会话 JSONL 的记录格式与对话回退（`truncate`）逻辑。
- 不为历史会话提供迁移：旧的 shadow-git 快照直接作废（数据已于制定本文档时清理）。

## 4. 设计

### 4.1 磁盘布局

```
~/.myagent/file-history/<sessionId>/
    snapshots.jsonl          # append-only，重建 state 用
    <hash16>@v1              # 备份文件，内容即某版本的文件副本
    <hash16>@v2
    ...
```

放在全局目录（`getGlobalMyAgentDir()`）而非 `<cwd>/.myagent/`，理由：

- 不进入项目工作树，不会被任何扫描/快照机制递归吞掉（旧 shadow-git 就是把 52 G 塞进了被扫描的树里）。
- 与 CC 的 `~/.claude/file-history/` 一致。
- 会话 id 全局唯一，不需要按 project 分层。

**注意**：会话记录本身仍在 `<cwd>/.myagent/sessions/`，两者分离。删除会话必须同时删两处（T2）。

### 4.2 数据结构

```ts
type BackupFileName = string | null   // null = 该版本下文件不存在

interface FileBackup {
  backupFileName: BackupFileName
  version: number
  backupTime: string                  // ISO，wire 安全（CC 用 Date，我们用字符串以便 JSONL 往返）
}

interface FileHistorySnapshot {
  messageId: string                   // 与会话中的 user message id 对齐
  trackedFileBackups: Record<string, FileBackup>   // key = 相对 cwd 的路径
  timestamp: string
}

interface FileHistoryState {
  snapshots: FileHistorySnapshot[]
  trackedFiles: Set<string>
  snapshotSequence: number
}
```

路径 key 用相对 cwd 的形式（CC 的 `maybeShortenFilePath`），cwd 外的路径保持绝对。备份文件名对**绝对路径**取 sha256 前 16 位，避免相对/绝对混用导致同一文件两份备份。

### 4.3 持久化

选 append-only `snapshots.jsonl`，**不**写进 `<cwd>/.myagent/sessions/index.json`。理由：`index.json` 是全项目共享的单文件，每次 upsert 全量重写；把每会话上百个 snapshot × 每个 snapshot 数十个文件条目塞进去会造成严重写放大。JSONL 与既有 `RecordStream` 的形态一致，重建靠重放。

两种记录：`{"kind":"snapshot",...}` 新增快照，`{"kind":"update",...}` 追加/修正最新快照的某个 backup（对应 CC 的 `isSnapshotUpdate`，由 `trackEdit` 回填触发）。重放时按序应用。

`SessionStore.getCheckpointMappings` / `addCheckpointMapping` 与 `meta.checkpoints` 字段保留但停止写入（旧数据只读、不再被 rewind 使用），在 T9 决定是否删除。

### 4.4 服务接口

新增 `src/services/fileHistory/fileHistoryService.ts`，替代 `CheckpointService`：

```ts
class FileHistoryService {
  constructor(cwd: string, sessionId: string, limits?: FileHistoryLimits)

  init(): Promise<void>                              // 读 snapshots.jsonl 重建 state；无文件即空 state
  dispose(): void

  trackEdit(filePath: string): Promise<void>         // 写工具在写之前调用
  makeSnapshot(messageId: string): Promise<void>     // 每个 turn 开始时调用
  rewindTo(messageId: string): Promise<{ success: boolean; error?: string }>

  hasAnyChanges(messageId: string): Promise<boolean>          // 早退版，给 rewind 选项可见性用
  getDiffStats(messageId: string): Promise<CheckpointDiffSummary>   // 给面板展示用
  listSnapshots(): FileHistorySnapshot[]
}
```

**messageId 的来源（与 CC 的有意差异）**：`loop.ts:327` 的 `turnId` 是一个新 UUID，**不等于** `sessionController` 传给 `loop.run()` 的 `messageId`，而 checkpoint 映射一直是按后者建的。因此不要用 `ToolContext.currentTurnId`。设计上让服务自己记住「当前 snapshot 的 messageId」（由 `makeSnapshot` 设定），`trackEdit` 只需要路径——这样 ToolContext 只需新增一个不易用错的钩子。

`limits` 只保留 `maxSnapshots`（默认 100）。`addBudgetMs` / `addTimeoutMs` / `maxFiles` / `isUnsnapshottableRoot` / 熔断 `trip()` 全部删除。

### 4.5 调用链改动

```
写工具 (Edit/Write/MultiEdit/NotebookEdit/Delete)
   └─ context.trackFileEdit?.(absPath)        ← 新增 ToolContext 钩子（T3）
SessionController.submit()
   └─ makeSnapshot(messageId)                 ← 替换 createCheckpoint（T4）
protocol host 'checkpoints' / 'restore-code'
   └─ 按 messageId 而非 commitHash 寻址        ← 跨层字段迁移（T5）
```

`AgentTool` 派生的子 agent 上下文必须继承 `trackFileEdit`，否则 subagent 的编辑不受保护。

## 5. 任务规划

**约定：每完成一个任务就 commit 一次。** 每个 commit 必须自身通过 `npm run typecheck`，不留半截状态。commit message 用 `checkpoint: <任务简述>`（如 `checkpoint: add FileHistoryService core`），正文写清该任务做了什么、留了什么未做。跨层字段迁移（T5）不可拆分成多个 commit，否则中间态编译不过。

任务顺序是有依赖的：T1→T2→T3→T4→T5 必须按序，T6 起可调整。

2026-09-07 核验：当前 HEAD 为 `4b96389`。T1、T2、T3 的实现提交分别是 `911571f`、`d3020f9`、`3e2e94c`。现有文件历史、写工具/钩子、会话删除、SessionController/Workspace 等 10 个相关测试文件合计 **255 通过、1 跳过**（Windows 跳过权限保留测试），`npm run typecheck` 通过。T1 的并发备份问题已另外在隔离目录中复现，见下方未勾选项。

---

### [x] T0 — 清理与文档基线

- [x] 删除 `C:\Users\Miyano\Documents\code\.myagent\shadow-git`（52 GB，已完成）
- [x] 提交本文档

核验：旧 shadow-git 目录不存在，本文档已随 `e3be3c2`（`gui`）提交；本次核验开始时工作树干净。原计划的独立文档提交标题未使用。

验收：`git status` 干净，文档在仓库根。
commit：`checkpoint: plan file-history migration`

---

### [x] T1 — FileHistoryService 核心（纯新增，不接线）

- [x] 新建 `src/services/fileHistory/fileHistoryService.ts`，实现 4.2 的数据结构与 4.4 的接口，**先只做内存态 + 备份文件读写**，持久化留到 T2（`init()` 暂时返回空 state）
- [x] 备份写入：`copyFile` + `chmod` 保留权限；lazy mkdir（先试 copy，ENOENT 才 mkdir 后重试）；源文件 ENOENT ⇒ 记 `backupFileName: null`
- [x] 变更检测 `hasFileChanged()`：mode/size → mtime 短路 → 内容比对，三级
- [x] `trackEdit` 的三阶段结构（读状态 → 异步备份 → 提交，提交时重查是否已被并发 track），防止重复调用覆写 `@v1`
- [x] `rewindTo`：逐文件恢复，`backupFileName === null` 则 `unlink`；未变的文件不碰；单文件失败只记日志不中断
- [x] 新建 `test/fileHistoryService.test.ts`：备份/恢复往返、未变文件不产生新版本、文件被删除后回退能重建、权限保留、路径 key 相对化

核验（2026-09-07 补完）：并发覆写问题已修复——`trackEdit` 现在用 `inflightBackups`（路径 → 进行中的 Promise，在第一个 `await` 之前同步登记）去重，后到的调用 join 前一个而不再发起第二次 `copyFile`；复制之后的状态重查保留，但不再是唯一防线。`captureFirstVersion` 与 `rewindTo` 的失败分支改为 `console.warn` 记日志后继续。新增测试「并发 track 同一文件只产生一个 `@v1` 且回退得到原始内容」。

验收：`node --import tsx --test test/fileHistoryService.test.ts` 全绿；`npm run typecheck` 通过。
commit：`checkpoint: add FileHistoryService core`

---

### [x] T2 — 持久化与会话生命周期

- [x] `snapshots.jsonl` 的写入（`snapshot` / `update` 两种记录）与 `init()` 重放重建
- [x] `removeFileHistory(sessionId)` 替代 `removeShadowRepo`，沿用同样的 `assertSafeSessionId` 守卫（**这条是防注入的，不是防御性代码**：sessionId 来自 wire 的 `delete-session`，直接落进 `rm -r`）
- [x] 接入会话删除路径：原先调用 `removeShadowRepo` 的地方改为同时清理 file-history
- [x] 测试：重启后 state 可重建、`update` 记录正确回填、删除会话后目录消失、非法 sessionId 被拒

核验：持久化相关用例通过；额外通过 `deleteSessionArtifacts` 验证全局 file-history 目录被删除、其他会话目录保留。当前同时保留旧 shadow-git 清理，旧实现待 T9 删除。

验收：`node --import tsx --test test/fileHistoryService.test.ts` 全绿。
commit：`checkpoint: persist file history snapshots`

---

### [x] T3 — ToolContext 钩子与写工具接入

- [x] `src/harness/types.ts` 的 `ToolContext` 新增 `trackFileEdit?(filePath: string): Promise<void>`
- [x] `src/harness/toolRunner.ts` 透传（现有 `...context` 已覆盖）
- [x] `src/tools/AgentTool/AgentTool.ts` 的子 agent 上下文继承该钩子
- [x] 写工具在**写之前**调用：`FileEditTool.ts:82`、`FileWriteTool.ts:70`、`MultiEditTool.ts:122`、`NotebookEditTool.ts:395`、`FileDeleteTool.ts:37`
- [x] 钩子缺失（未接线的 context）时全部路径必须照常工作
- [x] 测试：每个写工具在执行后使对应路径进入 tracked 集合；钩子抛错不影响写入结果

验收：`node --import tsx --test test/trackFileEdit.test.ts test/tools.test.ts test/fileToolLineEndings.test.ts test/notebookEdit.test.ts test/toolRunner.test.ts test/agentTool.test.ts` 全绿。写工具测试实际位于这些文件中，原计划中的 `test/fileEditTool.test.ts` 不存在。
commit：`checkpoint: track file edits from write tools`

---

### [x] T4 — SessionController 接线

- [x] `sessionController.ts` 用 `FileHistoryService` 替换 `CheckpointService`：`createCheckpoint()` → `makeSnapshot()`，去掉 `checkpointReady` 的熔断语义（保留「服务不可用则跳过」的降级）
- [x] 删除 `disabled` 通知路径与那条中文/英文提示
- [x] `sessionWorkspace.ts` 的注入点 `createCheckpointService` 同步改名
- [x] `retarget` / `dispose` 的生命周期顺序保持不变
- [x] 把 `trackFileEdit` 接到该会话 scope 的 ToolContext 上（`SessionScope.setFileEditTracker` → `CreateRuntimeDeps.trackFileEdit` → `toolContext`，由 `createSessionPane` 装配）
- [x] 测试：`test/sessionController*.test.ts` 更新；新增「turn 开始产生 snapshot」「服务未就绪时 turn 照常跑」两条

顺带（为了让本次 commit 自身编译且 `/rewind` 不出现空档）：`FileHistoryService.getCheckpointsWithDiffs()` 已实现，`commitHash` 暂时携带 messageId 等 T5 收口；`turnDiff` 仍为空，留给 T6；`restoreDiff` 直接用 `getDiffStats()`。host/App 的 `restoreToCommit` 调用改为 `rewindTo`，`store.addCheckpointMapping` 不再写入。

验收：`npm run typecheck` + `node --import tsx --test test/sessionController.test.ts`。
commit：`checkpoint: wire file history into session controller`

---

### [ ] T5 — 协议与渲染层字段迁移（单次原子 commit）

`commitHash` 这个字段名贯穿 wire、host、client、TUI、renderer，必须一次改完。

- [ ] `CheckpointWithDiff.commitHash` → `messageId` 寻址（`Checkpoint` 类型本就带 `messageId`，可直接复用并删除 `commitHash`）
- [ ] `src/runtime/protocol/wire.ts`、`commandSchema.ts`（`restore-code` 的参数）、`client.ts:439`、`host.ts:823-827`
- [ ] `src/desktop/renderer/model/rewindPanel.ts:397,442` 的 `restoreCode(commitHash)` 签名
- [ ] `src/tui/components/App.tsx:815`
- [ ] wire 值必须能过 `structuredClone`；schema 保持 strict
- [ ] 测试：`test/protocolCommandSchema.test.ts`、`test/protocolHost.test.ts`、`test/rendererRewindPanel.test.ts` 同步更新

验收：`npm run typecheck` + `npm run test`（全量，这是跨层改动）。
commit：`checkpoint: address restores by message id`

---

### [ ] T6 — diff 统计接入 rewind 面板

- [x] `getDiffStats()` 用 `diffLines` 式的行级比对产出 `CheckpointDiffSummary`（沿用现有 DTO，UI 不动）
- [ ] `hasAnyChanges()` 早退版接到 `rewindPresentation.ts:147` 的 `hasCodeChanges`
- [ ] `turnDiff` / `restoreDiff` 的语义映射到新模型：`restoreDiff` = 当前 vs 目标 snapshot；`turnDiff` = 相邻两个 snapshot 之间
- [ ] 测试：`test/rewindSummary.test.ts`、`test/rewindPresentation.test.ts` 更新

验收：`node --import tsx --test test/rewindPresentation.test.ts test/rewindSummary.test.ts`。
commit：`checkpoint: compute rewind diffs from file history`

---

### [ ] T7 — 快照上限与备份回收

- [x] `MAX_SNAPSHOTS = 100` 淘汰最旧快照；`snapshotSequence` 单调递增（实际由 `DEFAULT_FILE_HISTORY_LIMITS.maxSnapshots = 100` 与 `evictOldSnapshots()` 实现，不使用 `snapshots.length` 当活动信号）
- [ ] **备份文件 GC**：淘汰快照后删除不再被任何存活快照引用的 backup 文件（CC 这里是泄漏的，我们补上）
- [ ] GC 必须先算引用集合再删，且失败只记日志
- [ ] 测试：淘汰后引用仍在的 backup 不被删、无引用的被删、`snapshotSequence` 不回退

验收：`node --import tsx --test test/fileHistoryService.test.ts`。
commit：`checkpoint: cap snapshots and collect unused backups`

---

### [ ] T8 —（可选）resume 跨会话继承

- [ ] `/resume` 恢复旧会话时，用 `link()` 硬链接旧会话的 backup 到新会话目录，EEXIST 跳过，其他错误 fallback 到 `copyFile`
- [ ] 失败的 snapshot 不记录，避免出现引用不存在备份的快照

验收：resume 后对旧 turn 执行 `restore-code` 成功。
commit：`checkpoint: carry file history across resume`

---

### [ ] T9 — 删除 shadow-git 实现与文档同步

- [ ] 删除 `src/services/checkpoint/checkpointService.ts`、`test/checkpointService.test.ts`、`test/checkpointService.property.test.ts`
- [ ] 启动时清理遗留的 `<cwd>/.myagent/shadow-git/`（一次性，静默失败）
- [ ] 决定 `meta.checkpoints` 字段去留（建议：保留读路径以兼容旧 JSONL，停止写入，并在 `SessionStore` 注释说明）
- [ ] 更新 `AGENTS.md` 与 `CLAUDE.md` 的「Renderer invariants」段落——现有那条 "Checkpoints use per-session shadow Git and never modify the working tree. Refuse unsnapshottable roots, keep shadow-repo exclusions..." 整条作废，改写为 file-history 的不变量。**两个文件除标题与首句外必须保持同步。**
- [ ] `README.md` 说明 `/rewind` 的新语义边界（只回退 agent 改过的文件）

验收：`npm run typecheck` + `npm run test` 全量绿；仓库内不再有 `shadow` 相关引用。
commit：`checkpoint: remove shadow git implementation`

---

### [ ] T10 —（可选）BashTool 写入追踪

- [ ] 从 bash 命令中提取将被写入的路径（可参考 CC 的 `utils/bash/parser.ts` 与 `BashTool.tsx:393`），在执行前 `trackEdit`
- [ ] 保守策略：只识别高置信度的重定向与常见写命令，识别不到就不追踪，**绝不因为解析失败而阻断命令执行**
- [ ] 测试：常见形态（`>`、`>>`、`tee`、`mv`、`cp`）被识别；管道与复合命令不误判

验收：`node --import tsx --test test/bashTool*.test.ts`。
commit：`checkpoint: track bash writes in file history`

---

## 6. 测试策略

- 优先窄测：每个任务先跑自己的测试文件；T5、T9 这类跨层改动跑全量 `npm run test` + `npm run typecheck`。
- 纯函数（变更检测、路径 key 归一、GC 引用计算）走单元测试；涉及 fs 的走临时目录，测试结束清理。
- 测试改变了会话/项目 scope 时记得重置模块缓存（见 CLAUDE.md 的工作流约定）。
- 遵循「简单任务少写测试、避免过度防御」的项目指令：不为每条错误分支补测试，重点覆盖备份/恢复往返、版本复用、GC 引用正确性这三处真正容易出错的地方。

## 7. 风险与回滚

| 风险 | 缓解 |
|---|---|
| T5 跨层改名遗漏，运行时才炸 | strict schema + `assertNever` 已覆盖大部分；改完跑全量 typecheck 与 test |
| GC 误删仍被引用的备份 → 回退时文件丢失 | 先算引用集合再删；`restoreBackup` 在备份缺失时记日志并跳过，绝不写空文件 |
| `trackEdit` 与并发写竞态覆写 `@v1` | 照搬 CC 的三阶段结构与「已 tracked 就不动 v1」判断 |
| 用户误以为 `/rewind` 还能回退手工修改 | README + rewind UI 文案明示边界（T9） |
| 中途放弃 | T1–T3 是纯新增，不影响现有行为；T4 之前任何时候都可以停下并回到 shadow-git |

回滚点：T4 之前，`git revert` 掉新增 commit 即可完全恢复原行为。T4 之后回滚需要同时 revert T4、T5。
