# 上游怪癖清单（OpenCode Zen）

每条记录**日期 + 触发条件 + 上游原始响应**作为证据。可用
`npm run discover:upstream` 随时重验（免 key 即可跑，上游行为一变就退出 1）。

不进 `npm test` / `validate`：需要网络，上游抖动不该让本地关卡变红。

---

## Phase 4 的范围比规划设想的窄，原因是实测出来的

规划里 Phase 4 是「经真实出口向 Zen 递进发请求，**逐字段**定位被拒原因」，
用来重新发现旧项目记录过的那些怪癖（拒收 `client_metadata`、tools 上限、
思考模型需重放 `reasoning_content`、effort-tier 别名拆分）。

**那件事现在做不到，而且不是工程问题。** 见下面「闸门短路在请求体校验之前」。
两条路都堵着：

- **免费模型**永远停在 403，请求体从未被上游看过
- **付费模型**能过体校验，但要真实计费，而本网关的前提就是只放行免费模型；
  在付费模型上测出的怪癖也未必适用于免费模型

所以字段级怪癖清单这一块**暂时无法交付**，不是被跳过。闸门若哪天放开，
`discover-upstream.mjs` 的那条探针会变红，届时这项工作重新可做。

---

## 1. 免费额度闸门对第三方客户端关闭

**日期**：2026-09-16 前后收紧；09-22、09-23 两次复验仍在

**触发**：`POST /zen/v1/chat/completions`，任何免费模型（`-free` 后缀或 `big-pickle`）

```
403 application/json
{"type":"error","error":{"type":"FreeTierError",
 "message":"Error from provider (Console): OpenCode's free tier can only be used from within OpenCode"}}
```

带有效 key 时消息**无** `Error from provider (Console): ` 前缀 —— 两条路不是
同一段上游代码，但结论一致。

**与 key 无关**（见 §2 的顺序说明）。维护者明确表态是反滥用措施
（anomalyco/opencode#49621）：*"We've been tightening our logic to fight abuse.
You cannot use the free tier in other harnesses."*

### 旧项目的匿名通道已关

旧项目（`opencode-manager`）的「匿名 Worker」**不是不带 key**，而是发字面量
`Bearer public` —— `src/proxy/upstream.ts:97` 的 `effectiveApiKey()`：
`kind === "anonymous_zen"` 时把 apiKey 替换成字符串 `"public"`。

它**曾经真的能用**：旧项目最后一次提交是 2026-09-17，而闸门在 09-16 前后
收紧 —— 成功使用就在这条线之前（同一时间窗里 `union-alpha` 也从目录消失了）。

按真实形态复测（含 `synthesizeCliHeaders=true` 时的整套 CLI 身份头：
`opencode-cli/1.0.0` + 四个 `x-opencode-*`）：**403**，通道已关。

> 这条探针常驻的意义：它是「匿名通道是否重新打开」的唯一监测点。

---

## 2. 闸门顺序是三段的：key 语法 → 免费闸门 → key 密钥验证

**日期**：2026-09-23（`discover-upstream.mjs` 第一次运行就查出来的）

| key 形态 | 免费模型 | 付费模型 |
|---|---|---|
| 语法非法（`bogus`） | 401 `Invalid API key` | 401 `AuthError` |
| **语法合法但密钥全错**（`oc_sk_0000_wrong…`） | **403 `FreeTierError`** | 401 `Invalid credential` |
| 真实 key | 403 `FreeTierError` | （未测 —— 会真实计费） |

**一个形状对、密钥全错的假 key，在免费模型上照样拿 403。**

> **这一条纠正了我先前的一个错误推理。** 我曾断言「有效 key 得 403 而虚构 key
> 得 401，这个差异本身就证明 key 有效」，并据此省掉了付费模型验证。那是错的：
> 403 不能证明 key 有效。
>
> 但「闸门与 key 无关」这个结论反而更硬了 —— 同一个假 key 在付费模型上会走到
> 密钥验证并失败，在免费模型上却没走到，证明闸门在密钥验证**之前**短路。
> 既然它触发时密钥尚未被检查，结果就不可能取决于 key 是否有效。
> 从「实测有效 key 也被拒」变成「任何 key 都到不了那一步」。

---

## 3. 闸门短路在请求体校验之前

**日期**：2026-09-23

**触发**：免 key + 免费模型，请求体故意坏掉

```jsonc
// messages 是字符串而非数组，外加一个规划点名要发现的 client_metadata
{"model":"big-pickle","messages":"not-an-array","client_metadata":{"x":1}}
```

响应与**完全合法**的请求**逐字节相同**（同一个 403 FreeTierError）。

**直接后果**：请求体从未被上游看过，所以字段级怪癖一个都探不到 ——
这正是 Phase 4 范围缩减的根据。`discover-upstream.mjs` 里有一条探针专门
守着这个事实（它比对两次响应的字节是否相同）。

---

## 4. 模型存在性检查先于鉴权（免 key 时）

**日期**：2026-09-23

**触发**：免 key（或语法非法的 key）+ 一个不存在的模型 id

```
401 text/plain;charset=UTF-8
{"type":"error","error":{"type":"ModelError","message":"Model zzz-does-not-exist-free is not supported"}}
```

而免 key + **付费**模型是 `401 AuthError: Missing API key.` —— 两者状态码相同、
`error.type` 不同。

**对 Phase 6 有用**：这给「模型是否在架」提供了一条**免 key 即可用**的校验途径。

**对本网关的风险提示**：上游把 401 同时用于「鉴权失败」与「模型不存在」，
而 `classifyStatus` 把 401 归 `auth` → `shouldCooldown` 为真。若上游哪天在
**带 key** 的请求上也这么返回，一个拼错的模型名就会把健康 Worker 逐个打进冷却。
今天不成立（见 §5），Phase 6 补上目录交集正好消掉这个暴露面。

---

## 5. 带 key 时不存在的模型是 400，不是 401

**日期**：2026-09-22 首测，09-23 复验

**触发**：有效 key + 已下架或不存在的模型 id

```
400
{"error":{"type":"server_error","message":"Upstream request failed: Model is unavailable."}}
```

**这条对正确性有直接影响**：400 归 `bad_request` —— 不重试、不归咎 Worker
（不变量 #4）。若它是 401 就会归 `auth` → 冷却健康 Worker。
所以 `discover-upstream.mjs` 里那条探针实际在守护
「坏模型名不会拖累 Worker 池」这个性质。

> 这也纠正了我写在规划里的一个**推测**：我原先写「上游返回 404 → 归为 `auth`
> → 换 Worker 重试后仍失败」。实测行为比推测的**更好**。

---

## 6. 错误响应的 content-type 不一致，且 401 上是错的

**日期**：2026-09-22 首测，09-23 复验

| 状态码 | content-type | 体 |
|---|---|---|
| 401 | `text/plain;charset=UTF-8` | **JSON** ← 不一致 |
| 403 | `application/json` | JSON |
| 400 | `application/json` | JSON |

**本网关原样透传，这是正确处置** —— 不替上游纠错，否则用户永远不知道上游
实际发了什么。但客户端若按 content-type 决定解析方式，会在 401 上解析失败
而在 403 上正常。这种「只有某些错误码解析不了」的症状极难归因。

---

## 7. 模型目录**按账号**区分，但免费子集一致

**日期**：2026-09-22（账号 A）、09-23（账号 B）、09-23 晚（三账号同测，**推翻了前两次的结论**）

`GET /zen/v1/models` 免鉴权可读，但不同身份看到不同的目录。这条结论**被修正过两次**，
两次都是"样本变大之后前一个结论站不住"，所以把过程完整记下来：

| 轮次 | 样本 | 当时的结论 |
|---|---|---|
| 09-22 | 1 个账号 + 免 key | 目录是 **per-Worker** 的，缓存键必须含 Worker 身份 |
| 09-23 | 2 个账号 + 免 key | 两个账号**差异项完全相同** → 不是账号个体差异，而是「带 key／免 key」两种**身份** |
| 09-23 晚 | **3 个账号** + 免 key | **上一条也是错的** —— 账号个体差异真实存在 |

第三轮的实测（三轮重复，数字稳定；且全部经**同一个本机出口**发出，排除地域差异）：

| 身份 | 总数 | 免费集 |
|---|---|---|
| 免 key | 79 | 10 |
| worker-11 | **41** | 9 |
| worker-12 | **41** | 9 |
| worker-13 | **79** | 9 |

两个付费账号看到 41 个模型，第三个看到 79 —— 所以「差异只来自带 key／免 key」是假的。
（前一轮之所以得出那个结论，是因为那两个账号恰好权限相同。**两个样本一致不足以
排除个体差异**，而我当时把它写成了结构性结论。）

**真正稳定的那条更窄**：差异**全在付费模型上**，免费子集三个账号
**完全一致**（各 9 个，逐 id 相同）。免 key 多出的那个是 `deepseek-v4-flash-free`。

总数在变（09-22 是 76，09-23 是 79/41），所以**任何硬编码的模型数字都会过期**，
测试里不能断言总数。

**对 Phase 6 的实际影响**：目录缓存按「带 key／免 key」**两个槽位**存，而依据是
上面那条更窄的性质（本网关只放行免费模型，交集要的恰好是一致的那个子集），
**不是**"目录按身份区分"。若免费子集哪天也按账号分化，两侧后果不对称：

- 缓存里**多**一个 → 上游 400 `Model is unavailable`（§5）→ `bad_request` → 不重试、不归咎 Worker，自限
- 缓存里**少**一个 → 误拒一个可用模型，所以判出"已下架"时会触发一次目录刷新

真出现那天的修法是并集：`/v1/models` 取所有启用 Worker 的并集，路由校验用该 Worker
自己的目录。代价是 N 次上游请求，眼下不值得。

---

## 8. `/messages` 面从 `x-api-key` 读凭证，只给 Bearer 会 500

**日期**：2026-09-23（免 key 与真实 key 各两次，真实 key 只打**免费模型**）

**这条对正确性的影响最大**，因为它的失败方式会连累整个 Worker 池。

| 发给 `/zen/v1/messages` 的凭证头 | 状态 | 体 |
|---|---|---|
| 仅 `Authorization: Bearer <key>` | **500** | `{"type":"error","error":{"type":"error","message":"Internal server error"}}` |
| 仅 `x-api-key: <key>` | 403 | `FreeTierError` |
| 两者都带 | 403 | `FreeTierError` |

403 `FreeTierError` 说明请求**已经走到免费额度闸门**（凭证被识别了），而 500 说明
它在那之前就崩了 —— 上游这个面从 `x-api-key` 读凭证，缺了就炸。另外两个面
（`/chat/completions`、`/responses`）都只认 Bearer，所以这是 Messages 面**独有**的要求。

**不修的后果**：500 经 `classifyStatus` 归 `upstream_error` → `isRetryable` 为真
且**归咎于 Worker** → 重试链把每个 Worker 依次试一遍，每个都记一次失败并进指数退避。
于是一个**配置完全正确**的网关，只要客户端用 Messages 面就会把整池 Worker 打进冷却，
而症状是"上游好像挂了"，完全指不到真实原因（少发了一个头）。

不变量 #4 要保的正是这件事，而这里破坏它的不是客户端的坏请求，是网关自己少发了一个头。

**独立印证**：旧项目 `src/relay/headers.ts` 在发 `anthropic-version` 时同样顺带把
Bearer key 镜像成 `x-api-key`。两处从不同入口撞到同一个要求。

`anthropic-version` 本身实测**对结果没有影响**（带与不带状态码相同），但协议要求它，
且必须由网关设定 —— 取自客户端头的话，一个伪造的旧版本号就是协议降级原语。

---

## 9. `/responses` 与 `/messages` 在免 key 时的错误形状与 `/chat/completions` 不同

**日期**：2026-09-23

同一个免费模型、同样免 key，三个面的响应不一样：

| 面 | 免 key | 带（语法合法的）坏 key |
|---|---|---|
| `/chat/completions` | 403 `FreeTierError` | 403 `FreeTierError` |
| `/responses` | **500** `Internal server error` | 403 `FreeTierError` |
| `/messages` | **500**（见 §8，缺 `x-api-key`） | 403 `FreeTierError`（带 `x-api-key` 时） |

免 key + **付费**模型是 401 `AuthError: Missing API key.`；免 key + **不存在**的模型是
401 `ModelError: Model xxx is not supported`（与 §4 一致，三个面都如此）。

**有用的地方**：「模型是否在架」这条校验在**三个面上都免 key 可用**，对目录交集有直接帮助。

**要当心的地方**：这些 500 都是**免 key 才出现**的形状，而转发链路上每个候选 Worker
都有 key（`isUsable` 只看 key），所以生产路径走不到。不要据此给 500 加特殊处置 ——
那会是一条永不执行的分支。
