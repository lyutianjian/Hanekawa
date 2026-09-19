# dev server 不可达 + 子进程卫生 — 工程规格（v2）

- 状态:Draft(v2,取代 2026-09-18 初稿)
- 日期:2026-09-19
- 范围:后台 shell 的生命周期归属与清理时机、`BashTool` 子进程 env
- 不含:模型提示词 / 技能层行为变更

> v2 相对初稿的变化:初稿 §3 断言"subagent 的 shell 挂在父 sessionId 下",**源码核实为错**(见 §2.1)。该错误把最该做的一项定价成"可选、较重",也让 W4 的 owner 追踪方案整个成为多余。v2 重排了优先级、砍掉一项、修正了两项的动机。

---

## 1. 现象

Windows 上用 Hanekawa 做前端开发,浏览器访问 `http://localhost:5173/` 经常被拒绝连接;换用 Claude Code(下称 CC)不复现。同时观察到 subagent 退出后它绑定的进程不会被 kill。

这是**两个独立原因**叠加出的同一个症状,必须分开处理:

- **A. 端口被占 → vite 跳端口**:旧 dev server 没被清理,新起的 vite 让出 5173 绑到 5174,用户仍然访问 5173 → 拒绝连接。**这是 Hanekawa 与 CC 的真实差异所在。**
- **B. IPv6-only 绑定 + 本机 `::1` 回环不通**:与 agent 无关,纯命令行同样复现(初稿 §2.2 已实测)。

---

## 2. 根因(已核实源码)

### 2.1 subagent 的后台 shell 无人可达(A 的主因)

`src/tools/AgentTool/AgentTool.ts:1505-1525` 的 `createSubAgentToolContext` 把 `sessionId` 设成了 `subAgentId`:

```ts
return { cwd, sessionId: subAgentId, readFiles: new Set(), ... }
```

`BashTool` 调 `registerShell({ sessionId: context.sessionId, ... })`(`BashTool.ts:337,454`),于是 subagent 起的后台 shell 被登记在 **agent id** 名下,而不是父 session 名下。后果:

| 通道 | 行为 |
|---|---|
| `stopAll(previousSessionId)`(`/clear`、session 切换) | 按父 id 过滤 → **漏掉** |
| 父 session 的 `getSnapshot(sessionId)` | 按 sessionId 过滤 → **UI 不显示** |
| `KillShell` / `BashOutput`(父 agent 调用) | `getInternal` 按 sessionId 查 → **kill 不到、读不到** |
| `stopAll(undefined)`(`shutdown`,`bootstrap.ts:363`) | 全杀 → **唯一兜底** |

即:subagent 起的 dev server 在整个 app 生命周期内一直占着 5173,任何人都够不着。这正是"subagent 退出时绑定的进程不会 kill 掉"的机制。

**初稿 §6-W4 的 owner 字段方案因此不必要**:隔离已经天然存在,不需要给 `registerShell` 加 `ownerAgentId`,不需要动 `InternalTask` / `BackgroundTaskSnapshot` / 持久化快照结构。

### 2.2 主 agent 跨轮重跑 dev server(A 的次因)

主 agent 的后台 shell 只在 `shutdown` / `/clear` 清理,这一点**与 CC 一致,且是对的**(每轮清理会杀掉 dev server,是回归)。但主 agent 在后续轮次再跑一次 `npm run dev` 时,没有任何机制先停掉自己上一次起的那个 → 跳端口。

### 2.3 IPv6 绑定(B)

Vite 默认 `server.host='localhost'`;Node 17+ 默认 `verbatim` DNS 顺序,Windows 上 `localhost` 先解析到 `::1`,vite 只监听 `[::1]:5173`;本机 `::1` 回环被 FlClash TUN 打断,三方(curl / Test-NetConnection / Invoke-WebRequest)均不可达。

初稿实测结论保留:

| 方案 | 结果 |
|---|---|
| 默认 `npm run dev` | 绑 `[::1]:5173`,不可达 |
| `NODE_OPTIONS=--dns-result-order=ipv4first` | 绑 `127.0.0.1:5173`,HTTP 200 ✅ |
| `vite.config` 设 `server.host:'127.0.0.1'` | 绑 `127.0.0.1:5173`,HTTP 200 ✅ |

**注意定性**:这是本机网络配置问题,对所有工具一视同仁,CC 也不修(`ClaudeCode/src/utils/subprocessEnv.ts` 不注入任何 IPv4 偏好)。修它属于防御性加固,不是在修 Hanekawa 的 bug。

### 2.4 当前脱敏的真实影响面

`BashTool.ts:42-53` 的 `SENSITIVE_ENV_VARS` 无条件删除 9 个 key。核实清单后:

- **不影响** `gh`(`GH_TOKEN`/`GITHUB_TOKEN` 不在清单)、`npm publish`(`NPM_TOKEN` 不在清单)。初稿 §3.1/§6-W2 称"会误伤 gh/npm publish"**不成立**。
- **确实打断** 用环境变量凭证的 `aws` CLI:`AWS_SECRET_ACCESS_KEY`、`AWS_SESSION_TOKEN` 都在清单里,被删后 `aws sts get-caller-identity` 直接失败。

CC 的对照:脱敏由 `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` 门控,仅在 GHA 不可信上下文生效,本地完全不脱敏。

---

## 3. 目标 / 非目标

**目标**
1. subagent 结束后,它起的后台 shell 不再成为谁都够不着的孤儿。
2. 主 agent 重启 dev server 时不跳端口。
3. Windows 上默认 `npm run dev` 起的 node dev server 绑到可达地址。
4. 合法 CLI(`aws` 等)不被脱敏打断。

**非目标**
- 不做"每轮清理"(会杀掉 dev server)。
- 不改 subagent 的 sessionId 归属设计(§2.1 的归属本身是对的,它服务于读状态隔离;问题只在无人清理)。
- 不引入 Windows Job Object / `wmic` 递归杀(`taskkill /T` 与 CC 一致即可)。
- 不改模型提示词 / 技能层(§6 留作后续)。

---

## 4. 工作项

### W1(P0)— subagent 退出时清理其后台 shell

**动机**:§2.1。这是 Hanekawa 与 CC 的真实差异,也是用户直接观察到的现象。

**方案**:在 subagent 回合结束处调 `backgroundTasks.stopAll(subAgentId, 'Subagent exited')`。因为 shell 已经登记在 `subAgentId` 名下,这一句天然只杀该 subagent 自己的 shell,**不会波及主 agent**。

**挂钩点(已定)**:subagent 是可续聊的(`AgentTool.ts` 的 `continuation.resume` / `SendMessage`),"退出"因此有两个候选时机。**采用每个回合结束**(`runSubagent` 的 `finally`,`AgentTool.ts:900`):语义是"subagent 不该持有跨回合存活的后台进程",清理最彻底,与 CC 的 `killShellTasksForAgent` 时机一致。

已知代价,接受:subagent 起的 dev server 在它返回时即停,之后 `SendMessage` 续聊需重起。若某个工作流确实需要 subagent 起长命进程,正确做法是让主 agent 起,而不是放宽这里的清理。

(未采用的备选:在 `registry.ts:513` `trimAgentContinuations` 驱逐 continuation 时清理 —— 保留跨回合进程,但孤儿存活更久,且驱逐由 LRU 触发、时机不可预测。)

**改动点**
- `AgentTool.ts:900` `runSubagent` 的 `finally`:加清理调用。
- `runBackgroundSubagent`(`AgentTool.ts:743-...`):后台 subagent 走的是同一个 `runSubagent`,确认 (a) 方案下自动覆盖,无需重复加。
- 清理需在 `subagentStop` hook 之后执行(hook 可能读 shell 输出)。

**验收**
- subagent 内 `run_in_background` 起的进程,在 subagent 返回后 `ps` 查不到。
- 同一轮里主 agent 自己的后台 shell 不受影响。
- 已有 subagent 测试全绿。

**工作量 / 风险**:~1h / 低。

---

### W2(P1)— dev server 重启卫生

**动机**:§2.2。

**方案**:`BashTool` 在 `run_in_background` 路径上,若命令匹配 dev server 模式,先停掉同 session 内命令相同的仍在 running 的旧 shell,再 spawn 新的。

**范围要窄**(避免误杀):
- 仅 `run_in_background: true` 路径;
- 仅当命令匹配 dev server 模式(`npm|pnpm|yarn|bun run dev|preview`、`vite`、`next dev`、`nuxt dev`、`astro dev`);
- 仅杀**命令字符串完全相同**的旧任务(不做模糊匹配)。

**改动点**
- `registry.ts`:新增 `killShellsByCommand(sessionId, command, reason)`。
- `BashTool.ts:329-341`:spawn 前调用。

**验收**:同 session 内连续两次 `npm run dev`,旧的被停、新的稳定绑 5173,不跳端口;命令不同的两个后台 shell 互不影响。

**工作量 / 风险**:~2-3h / 低。

---

### W3(P2)— Windows 注入 `--dns-result-order=ipv4first`

**动机**:§2.3。防御性加固,不是 Hanekawa 的 bug。

**方案**:`buildSubprocessEnv()`(`BashTool.ts:55-78`)末尾,win32-only 把 `--dns-result-order=ipv4first` **追加**到已有 `NODE_OPTIONS`(不覆盖、已存在则不重复追加)。macOS/Linux 完全不动。

**范围注记**:`NODE_OPTIONS` 会作用于该 shell 下所有 node 调用(含 `npm install`/build),`ipv4first` 对这些基本无害。若要更精准可按命令模式条件注入,但会把一处集中逻辑打散,初版不做。

**验收**
- Win 上默认 `npm run dev` → `netstat` 显示 `127.0.0.1:5173 LISTENING`,`curl http://localhost:5173/` 200。
- 已有 `NODE_OPTIONS` 值被保留,`ipv4first` 追加在后;重复调用不重复追加。
- macOS/Linux 下 `NODE_OPTIONS` 不被写入。

**工作量 / 风险**:~1h / 低。

---

### W4(P2)— 脱敏加门控

**动机**:§2.4。当前无条件脱敏打断了 `aws`。

**方案**:加开关 `HANEKAWA_SUBPROCESS_ENV_SCRUB`(读 `process.env`,默认 falsy = 本地不脱敏),仅当为真时执行 scrub 循环;`GIT_EDITOR`/`GIT_SEQUENCE_EDITOR` 设置与 customEnv 合并不受开关影响。

**明确不做**:不扩充 `SENSITIVE_ENV_VARS` 清单,不加 `*_TOKEN|_KEY|_SECRET` 通配。初稿 §6-W2 建议的大清单会把当前并不存在的"误伤 gh/npm"问题真造出来。清单保持现状,只加门控。

**验收**
- 默认(开关关):子进程 env 含 `ANTHROPIC_API_KEY`、`AWS_SECRET_ACCESS_KEY` 原值;`aws sts get-caller-identity` 可用。
- 开关开:清单内 key 被删。
- 现有两个 scrub 测试改为先置开关;新增"默认关 = 完整 env"一例。

**工作量 / 风险**:~1h / 低。

---

### 已砍除的初稿工作项

| 初稿项 | 处置 | 理由 |
|---|---|---|
| W1 Windows `detached: true` | **砍掉** | `terminateProcessTree`(`processTree.ts:10-17`)在 win32 走 `taskkill /PID <pid> /T`,按 pid 树杀,与进程组无关;`windowsHide: true` 已在位。改了不解决任何已知症状,纯形式对齐 |
| W4 owner 字段追踪 | **砍掉** | §2.1:shell 已登记在 agent id 下,隔离天然存在,无需 owner 字段与快照结构变更 |
| W2 清单扩充 + 通配 | **砍掉**,只留门控 | §2.4:会制造新的误伤 |

---

## 5. 顺序与总量

| 项 | 工作量 | 风险 | 优先级 |
|---|---|---|---|
| W1 subagent 退出清理 | ~1h | 低 | P0 |
| W2 dev server 重启卫生 | ~2-3h | 低 | P1 |
| W3 win32 ipv4first | ~1h | 低 | P2 |
| W4 脱敏门控 | ~1h | 低 | P2 |

**建议顺序**:W1 → W2 → W3 → W4,合计约半天。

建议 W1 做完先在 Windows 上单独验一轮(确认孤儿消失、症状缓解多少),再决定 W2-W4 的节奏 —— W1 与 W2 合起来若已闭环"跳端口",W3 的收益需重新评估。

**整体验收**
- subagent 起的后台进程在其结束后不存活。
- 连续两轮 `npm run dev` 不跳端口。
- Windows 上默认配置 `http://localhost:5173/` 返回 200。
- `aws` 等合法 CLI 在默认设置下不被脱敏打断。
- macOS/Linux 行为无回归;`npm test` 全绿,typecheck 0 错。

---

## 6. 后续 / 未来工作

- 技能层兜底:在 `web-design-engineer` 里教模型写 `server.host: '127.0.0.1'`(与 W3 正交,可并行)。
- 真正的"不可信上下文"探测(GHA 等价物),Hanekawa 暂无此场景。
- subagent 后台 shell 的可见性:即使 W1 清理了孤儿,subagent 运行期间它的 shell 对父 agent 与 UI 仍不可见。是否要在父 session 的 UI 里展示"某 subagent 的后台任务",是独立的产品问题。

---

## 7. 参考

**Hanekawa 源码**
- `src/tools/AgentTool/AgentTool.ts:1505-1525`(subAgent 的 sessionId = agentId)、`:900`(runSubagent finally)、`:743`(runBackgroundSubagent)
- `src/tools/BashTool/BashTool.ts:42-53`(SENSITIVE_ENV_VARS)、`:55-78`(buildSubprocessEnv)、`:329-341,454`(后台 spawn + registerShell)
- `src/services/backgroundTasks/registry.ts:98`(registerShell)、`:277`(stopAll)、`:513`(trimAgentContinuations)
- `src/services/backgroundTasks/processTree.ts:7-46`(终止路径)
- `src/runtime/bootstrap.ts:363`、`src/runtime/sessionSwitch.ts:91`(stopAll 调用点)

**CC 源码(对照)**
- `utils/subprocessEnv.ts:15-99`(门控脱敏,保留 GH_TOKEN,无 IPv4 偏好)
- `tasks/LocalShellTask/killShellTasks.ts:53-76`(per-subagent 退出清理)
- `utils/gracefulShutdown.ts:447`、`node_modules/tree-kill/index.js:27-30`

**本机环境**:Node v24.18.1(verbatim DNS 默认);FlClash TUN 适配器在位(IPv6 NoTraffic);防火墙排除端口仅 50000-50059;hosts 无 localhost 条目;`ProxyEnable=0`。
