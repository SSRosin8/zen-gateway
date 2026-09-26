#!/usr/bin/env node
/**
 * 上游协议重验：把当前观察到的闸门顺序与错误形状写成期望逐条核对，
 * 上游行为一变就退出 1 并打印差异。免费额度闸门先于请求体校验，
 * 所以结果不解释为字段级兼容性；付费模型要花真钱且不适用于本网关，不测。
 *
 * 用法:
 *   node scripts/discover-upstream.mjs           # 免 key,全部探针
 *   ZG_DISCOVER_KEY=<key> node scripts/...       # 额外跑带 key 的探针
 *
 * 带 key 时只对免费模型与不存在的模型发请求 —— 有效 key 打付费模型会真实计费，
 * `keyedProbes()` 里有显式断言守着。
 * 不进 `npm test` / `validate`：需要网络，上游抖动不该让本地关卡变红。
 */

import { redactText, redactUrl, safeErrorMessage } from "../src/shared/redact.ts";
import { checkArgs } from "./lib/args.mjs";

// 在发出任何请求之前校验：`--help` 或拼错的参数不能变成一次真实的上游探测。
checkArgs({
  command: "npm run discover:upstream",
  summary: "上游协议重验：逐条核对闸门顺序与错误形状，行为变化时退出 1。需要网络。",
  flags: [],
});

const BASE = process.env.ZG_DISCOVER_BASE ?? "https://opencode.ai/zen/v1";
const KEY = process.env.ZG_DISCOVER_KEY ?? "";

/** 一个明显虚构的 key,用来区分「没带 key」与「带了个坏 key」。 */
const BOGUS_KEY = "oc_sk_0000_obviously_fake_not_a_real_key";

/** 上游响应体最多打印这么多字符。够看清错误形状,又不至于糊屏。 */
const BODY_PREVIEW = 240;

let failures = 0;

/**
 * 发一个探针请求，返回归一化后的观察结果。网络异常收敛成 `{ error }` 而不是抛出，
 * 一个探针失败不该让后面的探针都不跑。
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

/** 核对一条期望。`expect` 返回 `null`（通过）或差异说明 —— 「哪里不一样」正是要报的东西。 */
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

/** 从活的目录里挑探针用的模型，硬编码 id 会随目录变化而腐坏。 */
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

      // 不同身份看到不同目录视图：目录缓存键必须含 Worker 身份。
      console.log(`  · 目录按身份区分(缓存键必须含 Worker 身份)`);
      console.log(`      仅带 key 可见: ${onlyKeyed.join(", ") || "(无)"}`);
      console.log(`      仅免 key 可见: ${onlyAnon.join(", ") || "(无)"}`);
      console.log(`      该账号免费集 ${keyedSet.free.length} 个,免 key 视角 ${anonSet.free.length} 个`);
    }
  }

  return anonSet;
}

async function anonProbes(sets) {
  const freeModel = sets.free[0];
  const paidModel = sets.paid[0];
  const msgs = [{ role: "user", content: "hi" }];

  console.log("\n── 免费额度闸门 ──");

  const free = await probe({ path: "/chat/completions", body: { model: freeModel, messages: msgs } });
  check(`免 key + 免费模型(${freeModel}) → 403 FreeTierError`, free, (o) =>
    eq("状态码", o.status, 403) ?? eq("错误类型", errorType(o), "FreeTierError"));

  /*
   * 同一免费模型、故意坏掉的请求体。若上游校验了体应得到不同错误；
   * 实测逐字节相同 —— 闸门短路在体校验之前，字段级怪癖探不到。
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

  // 模型存在性检查先于鉴权：免 key 发不存在的 id 得到 ModelError，可免 key 校验目录交集。
  const ghost = await probe({
    path: "/chat/completions",
    body: { model: "zzz-does-not-exist-free", messages: msgs },
  });
  check("免 key + 不存在的模型 → 401 **ModelError**(存在性先于鉴权)", ghost, (o) =>
    eq("状态码", o.status, 401) ?? eq("错误类型", errorType(o), "ModelError"));

  /*
   * 闸门顺序三段：key 语法 → 免费额度闸门 → key 密钥验证。
   *   语法非法 key            + 免费模型 → 401 AuthError
   *   语法合法但密钥错        + 免费模型 → 403 FreeTierError
   *   语法合法但密钥错        + 付费模型 → 401（走到了验证并失败）
   * 因此 403 不能证明 key 有效；闸门在密钥验证之前短路，结果与 key 是否有效无关。
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
   * 上游在 401 上用 `text/plain` 发送 JSON 体，403 上是 `application/json`。
   * 网关原样透传不替上游纠错；按 content-type 解析的客户端会只在 401 上失败。
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

  console.log("\n── 字面量 `Bearer public` ──");

  /*
   * 这里的「匿名」是字面量 `Bearer public`，与不带 key 命中上游不同分支
   * （免 key 在 `/responses`/`/messages` 上是 500），结论不能互相推广。
   * 已知的成功使用早于 2026-09-16 前后的闸门收紧；这条探针是该通道是否
   * 重新打开的唯一监测点。
   */
  const legacyPublic = await probe({
    path: "/chat/completions",
    body: { model: freeModel, messages: msgs },
    key: "public",
  });
  check("`Bearer public` → 当前观察为 403", legacyPublic, (o) =>
    eq("状态码", o.status, 403) ?? eq("错误类型", errorType(o), "FreeTierError"));

  return { freeModel, paidModel };
}

async function keyedProbes(sets) {
  console.log("\n── 带 key(仅免费模型与不存在的模型) ──");

  const freeModel = sets.free[0];
  const msgs = [{ role: "user", content: "hi" }];

  // 安全断言：有效 key 打付费模型会真实计费，发请求前确认模型在免费集里。
  if (!sets.free.includes(freeModel)) {
    throw new Error(`拒绝发送:${freeModel} 不在免费集内,带 key 请求它可能产生费用`);
  }

  const free = await probe({ path: "/chat/completions", body: { model: freeModel, messages: msgs }, key: KEY });
  check(`有效 key + 免费模型(${freeModel}) → 仍是 403 FreeTierError`, free, (o) =>
    eq("状态码", o.status, 403) ?? eq("错误类型", errorType(o), "FreeTierError"));

  // 带 key 与免 key 的 403 消息不同（免 key 带 `Error from provider (Console): ` 前缀），走的是不同上游代码。
  check("带 key 的 403 消息**无** `Error from provider` 前缀(与免 key 不同路)", free, (o) => {
    const m = errorMessage(o) ?? "";
    if (m.includes("Error from provider")) return "期望无该前缀,但出现了 —— 上游可能已统一两条路";
    return m.includes("free tier can only be used from within OpenCode") ? null : `消息形态已变: ${m}`;
  });

  /*
   * 带 key 时不存在的模型是 400 而非 401：400 归 `bad_request`，不重试、不归咎 Worker
   * （不变量 #4）。若是 401 就会归 `auth` → `shouldCooldown`，拼错的模型名会把健康
   * Worker 逐个打进冷却。
   */
  const ghost = await probe({
    path: "/chat/completions",
    body: { model: "zzz-does-not-exist-free", messages: msgs },
    key: KEY,
  });
  check("有效 key + 不存在的模型 → **400**(不是 401,故不会冷却 Worker)", ghost, (o) =>
    eq("状态码", o.status, 400));
}

async function main() {
  console.log(`上游协议重验 — ${new Date().toISOString().slice(0, 10)}`);
  console.log(`baseUrl: ${redactUrl(BASE)}`);
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
