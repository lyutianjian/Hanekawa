# Desktop 动效实机验收记录

日期：2026-09-10。对应 [实现任务 M01–M22](./DESKTOP_MOTION_IMPLEMENTATION.md) 与 [设计稿](./DESKTOP_MOTION_DESIGN.md)。

四个原生 Windows 组合的 248 项检查全部通过。三个代表场景的结构空白样本均为 0；工具交接保持同一工作组，阅读锚点不被后续输出与回合结束拉走。保留 M17／M18 的语义时长和强度，无需回调 token。

- [原速预览与四组关键帧](./motion-evidence/index.html)
- [测量摘要、各阶段目标位置与原始记录 SHA-256](./motion-evidence/measurements.json)
- [预览采样方式与实际时长](./motion-evidence/previews.json)

## 1. 环境与证据边界

实机为 Windows、Intel Arc、2880×1620 显示器；Electron 43.4.0、Chromium 150.0.7871.224，支持 `interpolate-size: allow-keywords`。构建与测试使用 Node 24.18.1。CSS 视口统一为 1280×800。

| 记录目录（均位于 `.smoke/motion-validation/`） | 主题 | Windows 原生缩放 | 初始／记录中 DPR | 实际刷新率 | 检查 |
| --- | --- | --- | --- | --- | --- |
| `windows60-light100-capture` | 浅色 | 100% | 1 / 1 | 60Hz | 62 / 62 |
| `windows60-light125` | 浅色 | 125% | 1.25 / 1.25 | 60Hz | 62 / 62 |
| `windows120-dark100` | 深色 | 100% | 1 / 1 | 120Hz | 62 / 62 |
| `windows120-dark125` | 深色 | 125% | 1.25 / 1.25 | 120Hz | 62 / 62 |

这些记录通过 Windows 显示接口实际切换刷新率与主显示器缩放。原生模式不传 `--force-device-scale-factor`，CDP 的 `deviceScaleFactor` 为 0，仅统一 CSS 视口尺寸；启动时和录制中的真实 DPR 分别核对。每次结束后均读取并确认恢复到原来的 **200% / 120Hz**。前期 Chromium DPR override 的四组记录只作辅助验证，不替代这张原生矩阵。

流式场景使用仅监听 loopback 的 Anthropic SSE fixture，经过真实 provider、agent loop、TaskCreate／TaskUpdate／Read／Glob、记录流、bridge 与 renderer。权限与提问也走真实 Write／AskUserQuestion 路径。没有外部模型调用费用；报告不保存请求正文、请求头或凭据。

每次收到的 `requestAnimationFrame` 记录几何位置、节点身份、焦点、滚动位置、可见文本候选及呈现相位；另记 CSS start/end/cancel、DOM 移除观察和输入事件。**结构空白样本**指 transcript 内没有具有可见几何与文字的候选节点，不等于逐个物理显示刷新都做了像素检测。设置页打开时 transcript 按设计隐藏，其 `blankSamples` 不作为白屏失败。首次创建空会话也不纳入 live 工作组统计。

Performance filmstrip 在此 Chromium 版本达到 450 张后停止截图；性能轨道及 rAF 记录仍持续。完整流式预览改用已确认帧回执的 CDP screencast，共 **662 张原始图像**，覆盖 `turn-end`；其余三个组合保留完整性能／几何记录、较短的 filmstrip 和回合结束 PNG。短交互的 filmstrip 没有触及该上限。提交的 WebP 按原始时间戳抽样，最多 12.5fps，保持原速，末帧保留 100ms，时长已与编码文件核对；不是用于证明 60/120fps 的录屏。原始 `.gz` 和日志留在忽略目录，避免把体积很大的 trace 与本机临时路径日志提交进仓库。

## 2. 三个代表场景

### 2.1 流式思考 → 工具返回 → 后续正文

| 组合 | live rAF 样本 | 结构空白 | rAF 中位数 / P95 / 最大间隔（ms） | 实际收到的 rAF/s | 上翻后的锚点 Y（CSS px） |
| --- | ---: | ---: | --- | ---: | --- |
| 浅色 100% / 60Hz | 1264 | 0 | 16.7 / 16.8 / 33.4 | 59.91 | 183.69 → 183.69 |
| 浅色 125% / 60Hz | 1274 | 0 | 16.7 / 16.8 / 17.2 | 60.00 | 185.70 → 185.70 |
| 深色 100% / 120Hz | 2540 | 0 | 8.3 / 8.4 / 33.3 | 119.53 | 183.69 → 183.69 |
| 深色 125% / 120Hz | 2557 | 0 | 8.3 / 8.5 / 41.7 | 119.39 | 185.50 → 185.50 |

全轮滚动范围分别为 1871、1829.6、1871、1868.8px，包含主动“回到最新”和向上滚轮；**`upward-reading` 阶段的锚点 X/Y 变化均为 0**。统计中少量较长帧间隔已保留，不宣称每个物理刷新都满帧。

四组均满足：思考标题／状态线／正文在无变化事件和文字增量中维持身份与焦点；打开的菜单维持原容器及焦点项；整轮工作组的呼吸只启动 **1 次**；工具间歇没有整组收起。任务数值不变阶段的进度宽度变化为 **0px**。任务进度整轮因真实数值变化启动两次宽度过渡。

稳定段落、代码和 TeX 节点保持；文本从临时 assistant 项归入工作组后，实际文本选择仍在。DOM 移除观察会记录这次树内迁移，但节点对象、连接状态与选择均保持，不能把该观察等同于重建。历史恢复与再次展开不播放 `bead-pop`。

结论：满足 F1–F4、方向 A 和上翻保护要求。[22.12 秒完整原速预览](./motion-evidence/stream.webp)。

### 2.2 详情展开／收起

测量序列为已展开 → 收起 90ms → 反向 → 完整收起 → 再次展开。

| 组合 | rAF 样本 | 结构空白 | rAF 中位数 / P95（ms） | 正文不同高度数 | 触发标题 Y 变化 / 滚动位移 |
| --- | ---: | ---: | --- | ---: | --- |
| 浅色 100% / 60Hz | 99 | 0 | 16.7 / 16.8 | 31 | 0 / 0px |
| 浅色 125% / 60Hz | 100 | 0 | 16.7 / 16.8 | 34 | 0 / 0px |
| 深色 100% / 120Hz | 189 | 0 | 8.3 / 8.5 | 61 | 0 / 0px |
| 深色 125% / 120Hz | 191 | 0 | 8.3 / 8.4 | 64 | 0 / 0px |

标题稳定在约 `(272, 218.94)`，正文起点约 `(296, 243.44)`，从 90px 连续缩小；最终 body 移出 DOM，再次打开才新建 body，标题始终同一节点。每组收到 4 次 height transitionrun，对应四个目标变化；完成反馈 animationstart 为 **0**。

结论：反向从当前高度接续，正文清理发生在收起结算后，标题不被甩走。[原速预览](./motion-evidence/disclosure.webp)。

### 2.3 侧栏与菜单进出场

| 组合 | rAF 样本 | 结构空白 | rAF 中位数 / P95（ms） | 侧栏不同宽度数 | transcript 滚动位移 |
| --- | ---: | ---: | --- | ---: | ---: |
| 浅色 100% / 60Hz | 109 | 0 | 16.7 / 16.8 | 9 | 0px |
| 浅色 125% / 60Hz | 111 | 0 | 16.7 / 16.8 | 9 | 0px |
| 深色 100% / 120Hz | 208 | 0 | 8.3 / 8.4 | 17 | 0px |
| 深色 125% / 120Hz | 209 | 0 | 8.3 / 8.4 | 17 | 0px |

侧栏在 `(0, 40)` 由 237px 收到约 211.4px 后反向回到 237px，flex-basis 启动 **2 次**。菜单开 → 关 → 反向开 → 最终关，opacity／transform 各启动 **4 次**；另外两次属于侧栏内部。菜单 Y 变化 8px，容器始终同一节点；反向后可点，最终 `closed / inert / hidden`，无残留阻挡。该场景无 CSS keyframe animationstart。

结论：布局与小浮层节奏可辨，反向连续，退出完成后交互正常。[原速预览](./motion-evidence/layout.webp)。

## 3. 扩展场景与视觉核对

| 场景 | 实际证据与结论 |
| --- | --- |
| 历史恢复 | 关闭原 lane 后从持久化 session 重新打开；工作组直接处于折叠终态，完成动画启动 0 次 |
| 权限批准／拒绝 | 四次高度交接：60Hz 每次 24 个高度值，120Hz 每次 46–47 个；composer 本身同一节点，约 100px ↔ 239px；输入与 bridge 答复、shell 解阻均先于视觉移除，退出中键入保留 |
| 模态提问 | 连续两问保持同一面板；Enter 答复后焦点立即回到输入；真正的 `y` 键入不被退出面板截获；可见退出样本 12 / 13 / 24 / 25 均有遮罩覆盖；面板 transform 无缩放 |
| 设置开关 | 真实保存与 reload 保持 toggle／knob 身份；60Hz 11 个、120Hz 21 个位置；值变化且最终解除 pending |
| 动态切换减少动态效果 | 菜单入场途中启用后立即结算、transform 为 none；退出清理正常，侧栏仍可操作；恢复偏好不重播任务面板入场 |
| 深浅色与缩放 | 四组关键帧和原分辨率阅读 PNG 已逐项查看；字体、代码、工具行与原界面层级一致，选区可读；大面板不缩放文字，小菜单按设计轻缩放，边界未出现新增接缝；单一状态信号可见，无完全消失的循环 |

原生 100% 的一次早期记录出现额外滚轮输入，trace 中可见它们发生在静止阅读测量期；该记录不作锚点静止的验收证据。后续保留输入事件并重新录制，最终四组均通过。没有为消除这类外部输入而修改产品滚动规则。

## 4. 实机发现并修复的问题

1. 会话菜单的 Escape 冒泡到 shell 会中断流式回合。现在只在菜单打开时消费 Escape；关闭菜单继续原回合。
2. 流式临时 ID 与持久化记录 ID 不同。增加每会话的呈现 ID 映射，canonical items 仍保持 replay 一致；disclosure 与 DOM 使用同一呈现身份。assistant 正文归组使用同一 painter key 和原子移动，并恢复 Chromium 调整的选区端点。
3. 通用交互选择器覆盖 composer 的 height transition；移除该覆盖。测量高度时暂停 transition，避免同一 paint 内 `auto → px → auto` 被 Chromium 当成零进度反向而缩短至零。
4. 减少动态效果改变时，已开始的 CSS transition 不会因 duration 改变自动重新计时。生命周期结算后取消这些旧 transition，直接采用终态。
5. 任务面板的裸入场 animation 会在恢复媒体偏好后重播。改为共用 presence 生命周期，只有真正出现才入场。
6. 既有 S2 冒烟在移动中的权限区取得按钮坐标。探针区分“仍可回答”与“视觉残留”，按真实布局结算状态等待后点击；避免点击旧坐标造成后续 lane 测试连锁失败。退出业务仍即时处理。

对应回归位于 `rendererCanvasHeaderView`、`rendererTranscriptModel`、`rendererTranscriptView`、`rendererStyleTokens`；权限／task／presence 的既有测试及真实 Electron 场景补足浏览器行为。

## 5. 自动化检查与复现

| 命令 | 最终结果 |
| --- | --- |
| `npm run typecheck` | 通过，保留全部 tsconfig 边界 |
| `npm run test` | 3366 通过、0 失败、1 项既有条件跳过 |
| `npm run build` | 通过 |
| `npm run build:desktop` | 通过 |
| `npm run smoke:desktop -- --port=9237 --model=step-3.5-flash-2603 --out=.smoke/motion-validation/final-smoke-pass` | 13 通过、0 失败、1 项未启用的 paid-turn 跳过；正常退出并恢复配置／注册表／renderer 偏好 |

带费用的 S1 未运行；这里的真实流式验收由本地 SSE fixture 完成。完整全量测试日志在 `.smoke/motion-validation/final-test.log`，普通桌面冒烟摘要在 `final-smoke-pass/summary.json`。

M22 另核对了 65 份原始录制文件的 SHA-256；6 段 WebP 的帧数、编码时长与尺寸均和预览索引一致。

不改变系统缩放的 Chromium 模式：

```powershell
npm run build:desktop
npm run smoke:motion -- --scale=1.25 --theme=dark --port=9237 --out=.smoke/motion-local
```

原生 Windows 模式（先只读确认支持；实际运行会在 finally 恢复）：

```powershell
.\scripts\motion-desktop.ps1 -NativeDpi -Inspect
.\scripts\motion-desktop.ps1 -NativeDpi -RefreshRate 60 -Scale 1 -Theme light -Port 9237 -Out .smoke/motion-60-light100
.\scripts\motion-desktop.ps1 -NativeDpi -RefreshRate 60 -Scale 1.25 -Theme light -Port 9237 -Out .smoke/motion-60-light125
.\scripts\motion-desktop.ps1 -NativeDpi -RefreshRate 120 -Scale 1 -Theme dark -Port 9237 -Out .smoke/motion-120-dark100
.\scripts\motion-desktop.ps1 -NativeDpi -RefreshRate 120 -Scale 1.25 -Theme dark -Port 9237 -Out .smoke/motion-120-dark125
```

录制完成后再压缩证据，避免图像编码污染性能测量：

```powershell
node scripts/smoke/motionEvidence.mjs motion-evidence .smoke/motion-60-light100 .smoke/motion-60-light125 .smoke/motion-120-dark100 .smoke/motion-120-dark125
```

Windows 相对 DPI 接口在不支持的平台会先失败，不写入注册表作为后备。只有任务测试窗口与临时项目参与；原始配置、项目注册表与本机显示状态在每轮后恢复。若要复查帧轨道，解压 `*-trace.json.gz` 后导入 DevTools Performance；`*-frames.json.gz` 与 `stream-capture.json.gz` 分别保留完整几何序列和长场景截图时间戳。
