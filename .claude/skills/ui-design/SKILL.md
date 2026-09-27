---
name: ui-design
description: 修改 zen-gateway 管理后台（src/admin 下的页面、组件、样式、设计 token、颜色、字号、表格、密度、布局、悬停反馈、加载骨架或无障碍行为）时使用。给出由测试强制的对比度与禁用态规则、字号阶梯、密度算术、组件选用、反馈位置和状态区分。
paths:
  - "src/admin/**"
---

# 管理后台设计约束

本机单用户诊断工具：克制、密度适中、状态说清楚。实测数字与外部依据见 [reference.md](reference.md)。

## 硬规则（测试强制，改前先跑 `tests/design/contrast.test.ts`）

- 每个前景 token × 每个表面 token ≥ 4.5:1，两套皮肤 × 浅色深色都算；表面含 `surface-hover` / `surface-active`。新 token 必须归类进测试。
- 内容层（卡片、表格、表单、对话框正文）实色，层次只靠表面色调 + 1px 边框；阴影只有 `shadow-float`（对话框）与 `shadow-thumb`（分段滑块），源码扫描会拦其他阴影、`/NN` 透明色与字面色值。
- 毛玻璃只在导航层：侧栏 `zg-glass`、窄屏顶栏 `zg-glass-thick`、对话框遮罩 `zg-scrim`（只允许 Shell 与两个对话框使用）。透明度写在 `--zg-*-alpha`，测试按最坏背景算合成对比度；减少透明度 / 提高对比度时退回实色。
- 禁用态换实色（`disabled:bg-border-strong` 等），不用 `disabled:opacity-*`（源码扫描会拦）。
- `accent-fill` 只做填充，唯一前景是 `on-accent-fill`；不做整行或大面积背景。
- 状态用 `StatusIndicator`（图标 + 文字，空值会抛），行状态用 `RowMark` 左边框，不用背景色块。
- 每个视图最多一个 `PrimaryButton`；行内编辑打开时，页头按钮退为描边；嵌入别的页面的共用流程只用描边按钮。
- 视图状态（页面、标签、搜索、筛选、页码）进 hash URL，筛选组件受控。
- JSX 里不写 markdown，强调用 `Strong`。

## 字号与字体

- 阶梯（`tokens.css` 的 `@theme`）：`text-label-12/13/14` 单行、`text-copy-14` 多行说明（行高 1.7）、`text-heading-16` 面板标题、`text-heading-20`、`text-display-30` 指标与 wordmark。不写 `text-lg` / `text-3xl` 这类裸字号。
- 字重只用 400 / 500 / 600。`p` 默认行高 1.7；表格、标签、按钮 20px 行高。
- 中文字体栈：Inter → PingFang SC → Microsoft YaHei → 自托管 Noto Sans SC。衬线只用于纯拉丁（数字、wordmark）。

## 颜色与主题

- 所有颜色来自 `tokens.css` 的 `--zg-*` 字面量十六进制；`@theme` 只用 `var(--zg-*)`。
- 深色由 `<html data-theme>`、暖米白皮肤由 `data-skin="warm"` 控制（皮肤只换色板）；`index.html` 首屏脚本与 `theme.ts` 必须同步（`theme.test.tsx` 比对）。
- 悬停 `surface-hover`，按下 `surface-active`，主按钮悬停 `accent-fill-hover`；过渡只动颜色，时长走 `--default-transition-duration`（120ms），减弱动效时全局归零。

## 密度与布局

- 表格行高 36px（`--spacing-row`，`ROW_HEIGHT`），正文 14px，`PAGE_SIZE = 16`；三者一起改。
- 独立控件（按钮、输入框、筛选片、导航、标签）最小 44px；表格行内按钮用 `SecondaryButton compact`（32px，≥24px）。
- 单元格内容单行（`whitespace-nowrap`）；需要第二个信息就加列或同行排。
- 长任务（出口探测）状态归 `App`，离开页面不中断，`Shell` 底部显示任务指示。
- 外壳 `Shell`：md 及以上左侧栏常驻，展开 220px / 收起 64px（只剩图标，偏好存 localStorage）；导航项「图标 + 文字 + 徽标」固定间距对齐，收起时名称给 `aria-label` + `title`。底部是主题循环按钮与收起按钮（44px 图标按钮）。内容区流式铺满剩余宽度，不设 `max-w-*`；长段落在面板内用 `max-w-3xl` 限行长。
- 宽屏上能并排的就并排：状态 + 事实 + 操作同一行（`flex-wrap`），分步页左列标题、右列内容。
- md 以下侧栏收成顶栏 + 展开式抽屉（同一个 `<aside>`，不渲染两份导航）：打开时焦点进第一个导航项，Esc 关闭并还焦点给菜单按钮，点导航项自动收起。

## 组件索引

- `Panel`：页面内的一块内容，标题 + 可选操作；`Metric`：面板顶部 2–4 个关键数字。
- `StaleBanner` / `FallbackView`（`StatusViews.tsx`）：断连横幅与首次加载三态。
- `ClashImportFlow`（快速开始与出口页共用）、`OpenCodeConfigCard`（快速开始与客户端接入页共用）：同一流程只有一个组件。
- `SecretField`：已保存凭证的三态编辑（留空不改 / 设置新值 / 清空），必填凭证 `allowClear={false}`。
- `WorkerEditor`、`BulkImportDialog`：Worker 新增编辑与从 Clash 节点批量导入（一次 `workers.create`）。
- `PrimaryButton` / `SecondaryButton`（`danger`、`compact`）：唯一主操作 / 其余操作。
- `FilterChip` / `segmentClass` + `SEGMENTED_TRACK`：分段控件，筛选与时间范围用 `aria-pressed`，页内标签用 tablist；选中段是实色滑块 + 加粗。
- `FIELD` / `TEXTAREA`（`lib/styles.ts`）：输入框、下拉框、文本域的唯一类名。
- `DataTable`：分页 + 行内展开，带筛选的表传 `total`（总数多于一页时固定一整页高度，切筛选不跳）；`SimpleTable`：不分页小表；`TableFilters`：搜索 + 状态筛选。
- `TableSkeleton` / `Skeleton`：首次加载占位；`Truncate`：任何需要截断的文字（自动带 `title`）。
- `Mono`：id、IP、端口、指纹、模型名；`Strong`：句内强调。状态与反馈组件见下文。

## 表格规则

- 全部包在 `TableScroll` 里：横向在内部滚，纵向限高，表头 `sticky top-0` 实色底 + 下边框。
- 表格用 `border-separate` + 单元格边框（collapse 下吸顶表头的边框不跟着走）。
- 数字列 `numeric`（右对齐、等宽数字）；行悬停变 `surface-hover`，行不是点击目标；页码夹回范围；列表表（含 Clash 内核表）都用 `DataTable` 分页。
- 空单元格写词（「未引用」「无响应」「本机直连」「未探测」）；「—」只用于指标或比值「还没有数据」。

## 反馈选用

- 不用 toast。表单结果用 `FormStatus`，紧贴触发它的按钮；行操作结果与撤销用 `useRowNotes` + `RowNoteView` 留在那一行；次要行操作进 `RowMenu`（原生 popover）。
- 规则类说明放 `Panel` / `PageHeader` 的 `hint`（`HintTip`：悬停、聚焦、点击都能打开），不占正文；操作前必须看到的（错误、空状态下一步、确认后果、安全警告）仍写在页面上。
- 页面级（与网关断连）用 `StaleBanner`；对话框内的错误留在对话框。
- 自明的状态变化（切标签、展开、筛选）不提示成功；复制等无可见结果的操作才短暂改按钮文字；复制一律走 `lib/clipboard.ts`（局域网 http 非安全上下文退回 `execCommand`）。
- 破坏性或改全局状态的操作先 `ConfirmDialog`，焦点落在「取消」。

## 状态分开报

- 首次加载 `loading`（骨架 + 「检测中」）、`offline`（`npm start`）、`error`（响应异常）各自一种界面，不合并。
- 「还不知道」不显示成成功（`poolHealth` 的 `empty`）；拿不到数据时不替 Worker 池下结论。
- 首次成功后的失败保留页面与未保存表单，只加 `StaleBanner`。
- 写完一串 early return，逐条确认被拦下的输入是否仍需要说明原因。

## 交互与可访问性

- 导航与标签是真实 `<a href="#...">`（导航选中是实色圆角胶囊 + `aria-current`，标签 tablist / `aria-selected` / `aria-controls`）。
- 首启未完成且 URL 没指定页面时落到快速开始（判据等 `/api/opencode` 到齐）；侧栏徽标显示进度，完成后消失。
- 截断必须可找回：用 `Truncate`，不要裸写 `truncate` 类（测试扫描）。
- 骨架 `aria-hidden`，加载文字给读屏；打开行内表单时焦点移到第一个字段；焦点环 2px `accent-fg`。

## 文案

写给用户能据此行动的事实，不写实现。时间用 `formatLocalTime`（完整 ISO 放 `title`），时长用 `humanMs`。

## 凭证展示

- 已保存凭证只显示 `{present, fingerprint}`；订阅 URL 只显示 `redactUrl` 结果，编辑时不回填。
- 新 key 在密码框输入，保存后清空；`opencode.json` 由服务端写入真实 token，复制的片段只用占位符。

## 不引入的依赖

不引入表格库、对话框或弹层库、react-router、react-query / swr、i18n、toast 库、动画库。
