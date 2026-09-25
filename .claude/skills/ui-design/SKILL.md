---
name: ui-design
description: Use when changing anything under src/admin/ — pages, components, design tokens, colors, layout, accessibility. Encodes the measured contrast rules, the density decisions, and the traps that a naive change will fall into. Trigger on UI, 界面, 样式, CSS, token, 颜色, 对比度, 布局, 表格, 无障碍, layout, color, contrast, accessibility, dark mode.
---

# zen-gateway 管理后台的设计约束

一个本机单用户的诊断工具。观感取 Anthropic 的克制与透气，但**所有颜色值
都是实测重算过的**，不是品牌原值。

## 改颜色之前：那两条规则由构建期断言强制

`tests/design/contrast.test.ts` 在 `npm run validate` 里跑：

1. **任何前景 token × 任何表面 token ≥ 4.5:1**。Anthropic 官方品牌色里
   **有四个在米白底上不及格**（success 3.49 / accent 2.96 / info 2.78 /
   mid-gray 2.11）—— 所以 `tokens.css` 里的值是替代值。
2. **层次只靠「表面色调 + 1px 边框」，禁用 box-shadow**。因此边框必须真的
   可见：原 `--zg-border` 在 `--zg-surface` 上只有 **1.077**，
   所以另设 `--zg-border-strong`（1.345）。

改 token 时**跑一遍那个测试**，别凭眼睛。加新 token 也要加进那个笛卡尔积。

### 三个已经踩过的陷阱

- **`accent-fill` 只能做填充。** 它唯一合格的前景是 `on-accent-fill`（5.90），
  其余压上去全部不及格（`text-muted` 2.22、`accent-fg` 1.92）。
  所以它只能用在"只承载主文案的紧凑元素"上，**绝不能做整行背景** ——
  行内的时间/延迟/备注会不可读。目前只有两处用它，都是纯填充。
- **行状态用 3px 左边框实色，不用背景色块。** 实测 warn 在必要的 25% alpha
  下相对 `surface-accent` 只有 **1.41**（浅）/ 1.76（深）—— 肉眼与无状态行
  几乎无差别，等于没画。实色左边框是 5.29 / 7.96。
- **禁用态换实色，不降透明度。** `disabled:opacity-*` 会把底色与文字一起
  淡化：实测主按钮文字对比度从 5.90 掉到 **2.51**，而禁用态恰好是这些按钮
  最要紧的时刻（文案是「进行中…」「探测中…」，正是用户想读的那句）。
  既有的对比度关卡**看不见这个** —— 禁用态是合成出来的颜色，参与运算的
  两个 token 都没变。所以另有一节断言 + 一条"不准再用 opacity"的源码扫描。

## 颜色不能是唯一的信息通道

六个语义色里 `accent-fg` ↔ `error` 只差约 **14°** 色相，二色性下四个状态会
塌缩到 ≤1.28 的可分辨度（三色性下 1.01，即完全不可分）。

所以 `StatusIndicator` 在**类型与运行期都强制**图标 + 文字标签 ——
空 label 会抛。那不是防御性代码，是这条约束的落点。

## 密度：44px 与 12 行是一套算术

- 行高 **44px**（`--spacing-row`），同时满足触摸目标 ≥44px
- 正文 **14px**（`--text-base`）
- 直接后果是**一屏约 12 行**，所以 `PAGE_SIZE = 12`

规划原写 20，那与自己的密度结论矛盾。改页长时这三个数要一起算。

**出口隔离视图刻意不分页** —— 那个任务本身就是「一眼看全、找出共用出口的
节点」，分页会破坏它的意义。

## URL 是视图状态的唯一来源

页面、标签、搜索词、筛选、页码全部编码进 hash
（`#proxy?tab=isolation&q=hk&page=2`）。所以筛选组件是**受控**的，
自己不留状态 —— 留一份会与 URL 分叉，症状是「刷新后搜索词还在输入框里
但列表没过滤」。

**用 hash 而不是 History API**：网关**不伺服静态产物**（实测 `GET /` 返回
404），`pushState` 在 Vite 的 SPA fallback 下能工作而在别处不能 ——
同一份前端在两种部署下行为不同，且差异只在用户刷新时暴露。

**页码必须夹回范围内**。那是常态而不是边角：用户在第 3 页输入搜索词，
结果只剩 5 行。不夹的话显示一个空表，而用户不知道是"没有匹配"还是"翻过头了"。

## 写文案时

**不要写 markdown。** JSX 不渲染它，`**强调**` 会带着字面星号显示给用户。
第八轮实测六个页面共 27 处，而且集中在**最要紧的那些警告**上
（GLOBAL 分组陷阱、mixed-port 陷阱、免 key 通道已关闭、只能用真实 CLI）——
最需要被看清的句子显示得最糟。用 `<Strong>` 组件。

既有测试用 `/不要写/`、`/GLOBAL/` 这类正则，**正好落在星号之间**，
所以对它完全不敏感。现在有一条按整页扫描的断言。

## 三种失败必须分开报

`loading` / `offline`（网关没跑）/ `error`（响应不对）—— 它们的下一步完全
不同（等、`npm start`、`npm run build`）。合成一句「加载失败」会让用户猜。

同理：
- **「还不知道」绝不显示成成功**。空池时 `ready === total` 得到 `0 === 0`
  为真 —— 所以 `poolHealth` 有 `empty` 第三态。
- **子页面加载时不要替 Worker 池说话**。实测过：池 1/1 健康而
  `/api/proxies` 还在飞时，界面同时显示「检测中」与「尚未配置 Worker ·
  运行 npm run setup」—— 让一个装好的系统看起来要重装。
- **early return 会挡住最常见的输入**。`proxyStatus` 先判 `!enabled` 就
  return「已停用」，而 `resolveProxy` 对"已停用"返回的**正是**一个失败 ——
  于是最常见的那条不可解析路径永远显示不出原因。写完一串
  `if (...) return` 之后逐条问「被它拦下的那些输入，后面哪些分支本来也
  该对它们说话？」

## 凭证绝不进 DOM

前端**拿不到**原值：API 只给 `{present, fingerprint}`（sha256 前 8 位）。
订阅 URL 只给 `redactUrl` 后的展示串。用指纹而不是长度 —— 等长的两个 key
长度相同，于是「我改了没生效」在界面上不可见。

## 不引入的东西

- **不用 TanStack Table**（依赖装着但没用）：这里需要的是"过滤 + 排序 +
  切片"三个数组操作，每张表 4-6 列、几十行。引入它会让一个 30 行的需求
  变成一套 column helper 概念。
- **不用 react-router**：需要的全部功能是"读写 hash + 订阅变化"，60 行。
- **不用 react-query/swr**：两个请求。旧项目记在案的痛点之一是"为了行数
  而拆"，为一个小需求引入框架是它的近亲。
- **不做 i18n**：只维护中文。
