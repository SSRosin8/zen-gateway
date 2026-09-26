# ui-design 参考：实测数字与依据

SKILL.md 只放规则；这里记录数字从哪来，改 token 或密度前先看。
对比度数值由 `tests/design/contrast.test.ts` 重算，以测试为准。

## 对比度（WCAG 相对亮度）

- Anthropic 品牌色在米白底上不及格：success 3.49、accent 2.96、info 2.78、mid-gray 2.11，所以 `tokens.css` 用的是重算后的替代值。
- `border` 在 `surface` 上只有 1.077，看不见；卡片叠在面板上用 `border-strong`（1.345）。
- `accent-fill` 上的前景：`on-accent-fill` 5.90；`text-muted` 2.22、`accent-fg` 1.92、`error` 2.09，都不及格。
- 警告行用 25% alpha 背景时，相对 `surface-accent` 只有 1.41（浅）/ 1.76（深）；实色左边框 5.29 / 7.96。
- 用 `opacity-60` 做禁用态：主按钮文字 5.90 → 2.51（浅）/ 2.91（深）。实色禁用态：`text` 在 `border-strong` 上 11.80 / 7.94。
- `accent-fg` 与 `error` 色相只差约 14°；二色性下四个状态的可分辨度 ≤1.28，三色性下 1.01，所以状态必须带图标和文字。

## 悬停与按下 token

| token | 浅色 | 深色 | 相对 surface | 最紧的前景 |
|---|---|---|---|---|
| surface-hover | #e9e6dc | #2a2926 | 1.08 / 1.15 | accent-fg 4.81 / error 5.11 |
| surface-active | #e4e0d4 | #312f2b | 1.14 / 1.25 | accent-fg 4.55 / error 4.69 |
| accent-fill-hover | #cc6c4c | #e38a6b | — | on-accent-fill 5.11 / 7.12 |

浅色主题下 surface-hover 刻意压得很轻（Radix 色阶里 3→4 级的步长）：再深的话，
`accent-fg` 压在按下态上会跌破 4.5。深色主题下主按钮悬停时提亮，不压暗。

## 密度算术

- 行高 36px，表头约 36px。1280×800 视口扣掉页头（约 90）、导航（45）、面板头与筛选（约 110）、外边距之后，表格区约 600px，放 16 行（576px）+ 表头，所以 `PAGE_SIZE = 16`。
- 之前的数字：44px 行高、12 行一页（行本身兼作触摸目标）。改成紧凑，是因为行不可点击，而 WCAG 2.2 AA 2.5.8 只要求目标 ≥24px（或有足够间距）；44px 仍用于独立控件（Apple HIG 的最小命中区）。
- 行内按钮实测 50×32px。

## 浏览器实测（Chrome 154 headless，CDP，连接本机网关实时数据）

- 1280 与 390 宽，浅色与深色，6 个页面加代理池的另外 2 个标签，共 8 个视图：页面没有横向溢出；表格行高都是 36px；代理与模型页每页 16 行；每个视图主按钮 ≤1 个；控制台没有错误。
- 吸顶表头：视口高 500 时，代理与模型表格容器滚动约 239px，表头相对容器仍在 0px，elementFromPoint 命中表头，背景实色，下边框 1px，box-shadow 为 none。
- 悬停与按下：用 CDP Input.dispatchMouseEvent 驱动真实指针，表格行、筛选片、标签、导航、主按钮、行内按钮、危险按钮的计算背景色在 hover 和 active 时都变了（浅色 `rgb(233,230,220)` → `rgb(228,224,212)`）。headless Chrome 默认不匹配 `(hover: hover)`，需要加 `--blink-settings=primaryHoverType=2,availableHoverTypes=2`，否则 Tailwind 4 的 `hover:` 不生效。
- 宽度（旧）：顶栏布局下 `max-w-5xl` 与 `max-w-6xl` 的表格横向溢出都是 0px。改为侧栏外壳后内容区流式铺满，长段落改在面板内限行长；新的实测见下节。

## 类型与字体

- 中文 14px 下多行说明行高 1.7；单行 20px 行高。字重限 400/500/600：CJK 字形的 700 在 14px 下显得糊。
- 系统中文字体排在自托管 Noto 前面：macOS 和 Windows 上用 PingFang SC / 微软雅黑，不必下载 Noto 字形；Linux 回落到 Noto。

## 外部依据

- Linear 设计刷新（降低颜色噪音、克制使用强调色）：https://linear.app/now/behind-the-latest-design-refresh
- Vercel Geist 字号阶梯（label / copy / heading 分工）：https://vercel.com/geist/typography
- Radix 色阶（1–2 背景、3–5 组件状态，含悬停和按下）：https://www.radix-ui.com/colors/docs/palette-composition/understanding-the-scale
- GitHub Primer 数据表（密度、吸顶表头、空单元格写词）：https://primer.style/product/components/data-table/guidelines/
- GitHub Primer 通知与消息（内联反馈优先、不用 toast）：https://primer.style/product/ui-patterns/notification-messaging/
- Apple HIG 字体与最小点击区域：https://developer.apple.com/design/human-interface-guidelines/typography
- WCAG 2.2 2.5.8 目标尺寸（最小）：https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html
