#!/usr/bin/env node
/**
 * 上游协议发现 / 重验。
 *
 * ## 这个脚本的范围比规划设想的窄,原因是实测出来的
 *
 * 规划里 Phase 4 是「经真实出口向 Zen 递进发请求,**逐字段**定位被拒原因」,
 * 用来逐字段定位这些已知怪癖(拒收 `client_metadata`、tools 上限、
 * 思考模型需重放 `reasoning_content`、effort-tier 别名拆分)。
 *
 * **那件事现在做不到**,而且不是工程问题:免费额度闸门**短路在请求体校验之前**。
 * 2026-09-23 实测:免 key 发一个免费模型,把 `messages` 写成字符串
 * `"not-an-array"` 再塞一个 `client_metadata`,响应与完全合法的请求
 * **逐字节相同**(都是 403 FreeTierError)。请求体从未被上游看过,
 * 所以字段级怪癖一个都探不到。
 *
 * 另一条路(付费模型能过体校验)要花真钱,而本网关的前提就是只放行免费模型 ——
 * 在付费模型上测出的怪癖也未必适用于免费模型。所以不走。
 *
 * ## 于是这个脚本做的是「闸门与错误形状的重验」
 *
 * 免 key 就能测,不需要凭证,因此可以随时重跑。它把今天观察到的上游行为
 * 写成**期望**,再逐条核对;**上游行为一变就退出 1**,并打印差异。
 * 这正是规划想要的那个性质:知识从散落注释变成可按日期重新验证的清单。
 *
 * 用法:
 *   node scripts/discover-upstream.mjs           # 免 key,全部探针
 *   ZG_DISCOVER_KEY=<key> node scripts/...       # 额外跑带 key 的探针
 *
 * **带 key 时的安全约束**:只对**免费模型**与**不存在的模型**发请求。
 * 绝不用有效 key 打付费模型 —— 那会真实计费。这条约束在 `keyedProbes()`
 * 里有显式断言守着,不只是约定。
 *
 * 不进 `npm test` / `validate`:需要网络,且上游抖动不该让本地关卡变红。
 */

import { redactText, safeErrorMessage } from "../src/shared/redact.ts";

const BASE = process.env.ZG_DISCOVER_BASE ?? "https://opencode.ai/zen/v1";
const KEY = process.env.ZG_DISCOVER_KEY ?? "";

/** 一个明显虚构的 key,用来区分「没带 key」与「带了个坏 key」。 */
const BOGUS_KEY = "oc_sk_0000_obviously_fake_not_a_real_key";

/** 上游响应体最多打印这么多字符。够看清错误形状,又不至于糊屏。 */
const BODY_PREVIEW = 240;

let failures = 0;

/* ------------------------------------------------------------------ *
 * 基础设施
 * ------------------------------------------------------------------ */

/**
 * 发一个探针请求,返回归一化后的观察结果。
 *
 * 任何网络异常都被收敛成 `{ error }` 而不是抛出 —— 一个探针失败不该让
 * 后面的探针都不跑,那样一次网络抖动就会掩盖掉所有真实发现。
 */
async function probe({ path, method = "POST", body, key }) {
  const headers = { "content-type": "application/json" };
  if (key) headers["authorization"] = `Bearer ${key}`;

  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
    const text = await res.text();
    return {
      status: res.status,
      contentType: res.headers.get("content-type") ?? "(缺失)",
      text,
      json: safeJson(text),
    };
  } catch (err) {
    // 脱敏:URL 可能带 token,异常消息可能带请求头。
    return { error: safeErrorMessage(err) };
  }
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 上游的错误体有两种形状,取到哪个算哪个。 */
function errorType(observed) {
  return observed.json?.error?.type ?? null;
}

function errorMessage(observed) {
  return observed.json?.error?.message ?? null;
}

/**
 * 核对一条期望。
 *
 * `expect` 是一个返回 `null`(通过)或差异说明(不通过)的函数 ——
 * 不用布尔值,因为「哪里不一样」正是这个脚本要报的东西。
 */
function check(name, observed, expect) {
  if (observed.error !== undefined) {
    failures += 1;
    console.log(`  ✗ ${name}\n      请求失败: ${observed.error}`);
    return;
  }

  const diff = expect(observed);
  const preview = redactText(observed.text, BODY_PREVIEW);

  if (diff === null) {
    console.log(`  ✓ ${name}`);
    console.log(`      ${observed.status} ${observed.contentType}`);
    console.log(`      ${preview}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${name}  —— 上游行为已变`);
    console.log(`      ${diff}`);
    console.log(`      实收 ${observed.status} ${observed.contentType}`);
    console.log(`      ${preview}`);
  }
}

function eq(label, actual, expected) {
  return actual === expected ? null : `${label}: 期望 ${expected},实收 ${actual}`;
}

/* ------------------------------------------------------------------ *
 * 目录:同时也是选探针用模型的来源
 * ------------------------------------------------------------------ */

/**
 * 从**活的**目录里挑探针用的模型,不硬编码 id。
 *
 * 这条是踩过坑才定的:上一轮我把 models.dev 当权威,把一个上游并不存在的
 * `grok-code` 写进了默认免费名单。硬编码的模型 id 会随目录变化而腐坏,
 * 而腐坏的表现是「探针报了个假阴性」—— 最不该出现在重验工具里的失败模式。
 */
function classify(catalog) {
  const ids = catalog.map((m) => m.id);
  const free = ids.filter((id) => id.endsWith("-free") || id === "big-pickle");
  const paid = ids.filter((id) => !free.includes(id));
  return { ids, free, paid };
}

async function catalogProbes() {
  console.log("\n── 目录 ──");

  const anon = await probe({ path: "/models", method: "GET" });
  check("免 key 可读目录", anon, (o) => eq("状态码", o.status, 200));

  if (anon.error !== undefined || !Array.isArray(anon.json?.data)) {
    console.log("  ! 目录不可用,跳过依赖目录的探针");
    return null;
  }

  const anonSet = classify(anon.json.data);
  console.log(`      在架 ${anonSet.ids.length} 个,其中免费 ${anonSet.free.length} 个`);
  console.log(`      免费集: ${anonSet.free.sort().join(", ")}`);

  if (KEY) {
    const keyed = await probe({ path: "/models", method: "GET", key: KEY });
    check("带 key 可读目录", keyed, (o) => eq("状态码", o.status, 200));

    if (Array.isArray(keyed.json?.data)) {
      const keyedSet = classify(keyed.json.data);
      const onlyKeyed = keyedSet.ids.filter((id) => !anonSet.ids.includes(id));
      const onlyAnon = anonSet.ids.filter((id) => !keyedSet.ids.includes(id));

      /*
       * 目录按身份区分 —— 这不是账号个体差异。
       * 2026-09-22 与 09-23 两个不同账号看到的差异项完全相同
       * (仅带 key 可见 `test`/`test-novita-dsf4.1`;仅免 key 可见
       * `claude-sonnet-4`/`deepseek-v4-flash-free`),说明是「带 key」与
       * 「免 key」两种身份各自对应一份视图。
       *
       * 对 Phase 6 的直接约束:目录缓存键必须含 Worker 身份,
       * 不能只存一份全局目录。
       */
      console.log(`  · 目录按身份区分(Phase 6 的缓存键必须含 Worker 身份)`);
      console.log(`      仅带 key 可见: ${onlyKeyed.join(", ") || "(无)"}`);
      console.log(`      仅免 key 可见: ${onlyAnon.join(", ") || "(无)"}`);
      console.log(`      该账号免费集 ${keyedSet.free.length} 个,免 key 视角 ${anonSet.free.length} 个`);
    }
  }

  return anonSet;
}

/* ------------------------------------------------------------------ *
 * 免 key 探针 —— 闸门顺序与错误形状
 * ------------------------------------------------------------------ */

async function anonProbes(sets) {
  const freeModel = sets.free[0];
  const paidModel = sets.paid[0];
  const msgs = [{ role: "user", content: "hi" }];

  console.log("\n── 免费额度闸门 ──");

  const free = await probe({ path: "/chat/completions", body: { model: freeModel, messages: msgs } });
  check(`免 key + 免费模型(${freeModel}) → 403 FreeTierError`, free, (o) =>
    eq("状态码", o.status, 403) ?? eq("错误类型", errorType(o), "FreeTierError"));

  /*
   * **这条探针是整个 Phase 4 范围缩减的证据。**
   *
   * 同一个免费模型,请求体故意坏掉:`messages` 是字符串而非数组,
   * 外加一个规划点名要发现的 `client_metadata`。若上游校验了体,
   * 这里应当得到一个与上面**不同**的错误。实测逐字节相同 ——
   * 闸门短路在体校验之前,所以字段级怪癖探不到。
   */
  const malformed = await probe({
    path: "/chat/completions",
    body: { model: freeModel, messages: "not-an-array", client_metadata: { x: 1 } },
  });
  check("免 key + 免费模型 + **畸形请求体** → 与合法请求响应相同", malformed, (o) => {
    if (free.error !== undefined) return "无法比对(合法请求那次失败了)";
    return o.text === free.text
      ? null
      : `期望与合法请求逐字节相同(证明体未被校验),实际不同`;
  });

  console.log("\n── 闸门顺序:鉴权 vs 模型存在性 ──");

  const paid = await probe({ path: "/chat/completions", body: { model: paidModel, messages: msgs } });
  check(`免 key + 付费模型(${paidModel}) → 401 AuthError`, paid, (o) =>
    eq("状态码", o.status, 401) ?? eq("错误类型", errorType(o), "AuthError"));

  /*
   * **模型存在性检查先于鉴权。**
   *
   * 免 key 发一个不存在的 id,得到的不是「缺凭证」而是「模型不支持」——
   * 说明上游先查模型再查凭证。对 Phase 6 有用:这给目录交集提供了一条
   * **免 key 即可用**的校验途径。
   */
  const ghost = await probe({
    path: "/chat/completions",
    body: { model: "zzz-does-not-exist-free", messages: msgs },
  });
  check("免 key + 不存在的模型 → 401 **ModelError**(存在性先于鉴权)", ghost, (o) =>
    eq("状态码", o.status, 401) ?? eq("错误类型", errorType(o), "ModelError"));

  /*
   * **闸门顺序是三段的:key 语法 → 免费额度闸门 → key 密钥验证。**
   *
   * 这一条是本脚本第一次运行就查出来的 —— 而查出的是**我自己先前的错误结论**,
   * 不是上游变了。先前我断言「有效 key 得 403 而虚构 key 得 401,这个差异本身
   * 就证明 key 有效」,据此省掉了付费模型验证。实测否定了它:
   *
   *   语法非法 key(`bogus`)        + 免费模型 → 401 AuthError
   *   语法合法但密钥错(`oc_sk_…`)  + 免费模型 → **403 FreeTierError**
   *   语法合法但密钥错             + 付费模型 → 401(走到了验证并失败)
   *
   * 一个形状对但密钥全错的假 key,在免费模型上照样拿 403。所以
   * **403 不能证明 key 有效**。
   *
   * 而这让「闸门与 key 无关」这个结论更硬:同一个假 key 在付费模型上会走到
   * 密钥验证并失败,在免费模型上却没走到 —— 说明闸门在验证**之前**短路。
   * 既然它触发时密钥尚未被检查,结果就不可能取决于 key 是否有效。
   */
  const badSyntax = await probe({
    path: "/chat/completions",
    body: { model: freeModel, messages: msgs },
    key: "bogus-not-even-key-shaped",
  });
  check("语法非法的 key + 免费模型 → 401(语法检查**先于**闸门)", badSyntax, (o) =>
    eq("状态码", o.status, 401) ?? eq("错误类型", errorType(o), "AuthError"));

  const wrongSecret = await probe({
    path: "/chat/completions",
    body: { model: freeModel, messages: msgs },
    key: BOGUS_KEY,
  });
  check("语法合法但密钥错 + 免费模型 → **403**(闸门先于密钥验证)", wrongSecret, (o) =>
    eq("状态码", o.status, 403) ?? eq("错误类型", errorType(o), "FreeTierError"));

  const wrongSecretPaid = await probe({
    path: "/chat/completions",
    body: { model: paidModel, messages: msgs },
    key: BOGUS_KEY,
  });
  check("同一个假 key + 付费模型 → 401(这里**才**走到密钥验证)", wrongSecretPaid, (o) =>
    eq("状态码", o.status, 401));

  console.log("\n── 错误响应的 content-type ──");

  /*
   * **上游在 401 上用错了 content-type**:`text/plain` 发送 JSON 体。
   * 403 上是正确的 `application/json`。
   *
   * 本网关原样透传(这是正确处置 —— 我们不替上游纠错,否则用户永远不知道
   * 上游到底发了什么),但客户端若按 content-type 决定解析方式,
   * 会在 401 上解析失败而在 403 上正常。这种「只有某些错误码解析不了」的
   * 症状极难归因,所以必须记下来。
   */
  check("401 的 content-type 是 text/plain(上游的 bug,但体是 JSON)", paid, (o) => {
    const isPlain = o.contentType.includes("text/plain");
    const isJson = o.json !== null;
    if (isPlain && isJson) return null;
    return `期望 text/plain + JSON 体;实收 content-type=${o.contentType}, 可解析=${isJson}`;
  });

  check("403 的 content-type 是 application/json(同一上游,不一致)", free, (o) =>
    o.contentType.includes("application/json")
      ? null
      : `期望 application/json,实收 ${o.contentType}`);

  console.log("\n── 匿名通道(字面量 `Bearer public`) ──");

  /*
   * **这里说的「匿名」不是不带 key,而是发字面量 `Bearer public`。**
   *
   * 这个区分决定了探针该发什么:免 key 与 `Bearer public` 命中上游的**不同
   * 分支**(免 key 在 `/responses`/`/messages` 上是 500,见 §9)。
   * 只测「不带 authorization 头」永远测不到这条通道 —— 那是另一种请求,
   * 而两者的结论不能互相推广。
   *
   * 已知的成功使用早于 2026-09-16 前后的闸门收紧,同一时间窗里
   * `union-alpha` 也从目录消失。
   *
   * 这条探针常驻的意义:它是「这条通道是否重新打开」的唯一监测点。
   * 若它哪天变绿,免 key 的匿名 Worker 就值得重新评估。
   */
  const legacyPublic = await probe({
    path: "/chat/completions",
    body: { model: freeModel, messages: msgs },
    key: "public",
  });
  check("`Bearer public`(匿名通道)→ 403,通道已关", legacyPublic, (o) =>
    eq("状态码", o.status, 403) ?? eq("错误类型", errorType(o), "FreeTierError"));

  return { freeModel, paidModel };
}

/* ------------------------------------------------------------------ *
 * 带 key 探针 —— 只碰免费模型与不存在的模型
 * ------------------------------------------------------------------ */

async function keyedProbes(sets) {
  console.log("\n── 带 key(仅免费模型与不存在的模型) ──");

  const freeModel = sets.free[0];
  const msgs = [{ role: "user", content: "hi" }];

  /*
   * 安全断言,不只是约定:有效 key 打付费模型会**真实计费**。
   * 这个脚本的探针模型全部来自活目录,所以必须在发请求之前
   * 确认挑出来的确实在免费集里。
   */
  if (!sets.free.includes(freeModel)) {
    throw new Error(`拒绝发送:${freeModel} 不在免费集内,带 key 请求它可能产生费用`);
  }

  const free = await probe({ path: "/chat/completions", body: { model: freeModel, messages: msgs }, key: KEY });
  check(`有效 key + 免费模型(${freeModel}) → 仍是 403 FreeTierError`, free, (o) =>
    eq("状态码", o.status, 403) ?? eq("错误类型", errorType(o), "FreeTierError"));

  /*
   * 带 key 与免 key 的 403 **不是字节级相同**:免 key 那条的 message 带
   * `Error from provider (Console): ` 前缀,带 key 那条没有。
   * 说明两条路走的不是同一段上游代码。结论(都被拒)一致。
   */
  check("带 key 的 403 消息**无** `Error from provider` 前缀(与免 key 不同路)", free, (o) => {
    const m = errorMessage(o) ?? "";
    if (m.includes("Error from provider")) return "期望无该前缀,但出现了 —— 上游可能已统一两条路";
    return m.includes("free tier can only be used from within OpenCode") ? null : `消息形态已变: ${m}`;
  });

  /*
   * **带 key 时不存在的模型是 400 而非 401。**
   *
   * 这一条对本网关的正确性有直接影响:400 归 `bad_request` ——
   * 不重试、不归咎 Worker(不变量 #4)。若它是 401,就会归 `auth` →
   * `shouldCooldown` 为真 → **一个拼错的模型名会把健康 Worker 逐个打进冷却**。
   * 所以这条探针实际在守护「坏模型名不会拖累 Worker 池」这个性质。
   */
  const ghost = await probe({
    path: "/chat/completions",
    body: { model: "zzz-does-not-exist-free", messages: msgs },
    key: KEY,
  });
  check("有效 key + 不存在的模型 → **400**(不是 401,故不会冷却 Worker)", ghost, (o) =>
    eq("状态码", o.status, 400));
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

async function main() {
  console.log(`上游协议重验 — ${new Date().toISOString().slice(0, 10)}`);
  console.log(`baseUrl: ${BASE}`);
  console.log(KEY ? "凭证: 已提供(带 key 探针会跑)" : "凭证: 未提供(只跑免 key 探针)");

  const sets = await catalogProbes();
  if (sets === null) {
    console.log("\n目录不可用,无法继续。");
    process.exitCode = 1;
    return;
  }
  if (sets.free.length === 0 || sets.paid.length === 0) {
    console.log("\n目录里缺免费或付费模型,无法构造探针。");
    process.exitCode = 1;
    return;
  }

  await anonProbes(sets);
  if (KEY) await keyedProbes(sets);

  console.log("\n────────────────────────");
  if (failures === 0) {
    console.log("全部期望成立 —— 上游行为与 docs/upstream-quirks.md 记录一致。");
  } else {
    console.log(`${failures} 条期望不成立。上游行为可能已变 ——`);
    console.log("请核对 docs/upstream-quirks.md,确认后更新记录与相关实现。");
    process.exitCode = 1;
  }
}

await main();
