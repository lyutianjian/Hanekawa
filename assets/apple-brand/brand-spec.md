# Apple MacBook Pro — Brand Spec

## 来源
- 参考页面: https://www.apple.com/macbook-pro/
- 采集日期: 2026-08-01

## 品牌资产

### Logo
- 形式: 内联 SVG（Apple 被咬一口的图标）
- 因为没有找到官方可用的 SVG URL，使用手工 SVG 路径绘制

### 产品图片
- OG/社交分享图: `https://www.apple.com/v/macbook-pro/ax/images/meta/macbook-pro__difvbgz1plsi_og.png?202607280409`
- Hero 产品图: 使用 OG 图作为 fallback（Hero 主图）
- 特性图: 使用 OG 图的多视角 crop

## 设计令牌（Design Tokens）

### 颜色
| Token | 十六进制 | 用途 |
|-------|---------|------|
| --color-bg-primary | #f5f5f7 | 页面全局背景 |
| --color-bg-dark | #000000 | Hero 暗区背景 |
| --color-bg-card | #ffffff | 卡片背景 |
| --color-bg-footer | #f5f5f7 | Footer 背景 |
| --color-text-primary | #1d1d1f | 主标题/正文 |
| --color-text-secondary | #86868b | 副标题/辅助文字 |
| --color-accent | #0071e3 | 链接/CTA 按钮文字 |
| --color-accent-hover | #0077ed | 链接悬停 |
| --color-border | #d2d2d7 | 边框/分隔线 |
| --color-nav-bg | rgba(255,255,255,0.72) | 导航栏背景 |

### 排版
| Token | 字体 | 权重 | 用途 |
|-------|------|------|------|
| --font-display | Inter | 600 | Hero 大标题 |
| --font-heading | Inter | 600 | 区块标题 |
| --font-body | Inter | 400 | 正文 |
| --font-label | Inter | 500 | 标签/小标题 |

### 字号阶梯
- hero-title: clamp(48px, 8vw, 96px)
- section-title: clamp(32px, 5vw, 56px)
- h3: 24px / 28px
- body: 17px / 1.47
- label: 12px / 14px

### 间距
- 基础单位: 8px
- 常用间距: 8, 16, 24, 32, 48, 64, 80, 120

### 圆角
- 导航/卡片: 18px
- 按钮: 980px (full pill)
- 图片容器: 24px
- Apple 典型的 "squircles" — 连续曲率圆角建模

### 阴影策略
- 无投影——Apple 页面不使用 box-shadow 做层次
- 用颜色和间距区分层级

### 动效
- easing: cubic-bezier(0.25, 0.1, 0.25, 1)
- scroll-triggered: fade-up + translateY(20px → 0)
- 导航 blur: 滚动过渡

## 页面结构验证
从 apple.com/macbook-pro 获取的页面包含以下模块（按顺序）:
1. 全局导航（sticky + backdrop-filter blur）
2. Hero（全屏暗色 + 大产品图 + 标题 + CTA）
3. 芯片介绍（三列布局，M4 / M4 Pro / M4 Max）
4. 特性亮点（性能、电池、显示屏等）
5. 横向对比（芯片规格对比工具）
6. Footer（淡灰简洁）
