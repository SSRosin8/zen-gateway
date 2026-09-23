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

## 7. 模型目录按身份区分，不是全局单例

**日期**：2026-09-22（账号 A）、09-23（账号 B，差异项完全相同）

`GET /zen/v1/models` 免鉴权可读，但**带 key 与免 key 看到不同的目录**：

| | 总数 | 免费数 | 独有 |
|---|---|---|---|
| 带 key | 79 | 9 | `test`、`test-novita-dsf4.1` |
| 免 key | 79 | 10 | `claude-sonnet-4`、`deepseek-v4-flash-free` |

**两个不同账号看到同一组差异**，说明这不是账号个体差异，而是「带 key」与
「免 key」两种身份各自对应一份视图。

总数在变（09-22 是 76，09-23 是 79），所以**任何硬编码的模型数字都会过期**。

**对 Phase 6 的约束**：目录缓存键必须含 Worker 身份；`/v1/models` 用所有启用
Worker 的并集，而路由校验用**该 Worker 自己的**目录 —— 否则模型在 A 的目录里、
请求路由到 B，就会拿到 §5 那个 400。
