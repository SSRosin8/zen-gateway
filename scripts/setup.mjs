#!/usr/bin/env node
/**
 * 一键自动配置。
 *
 * 探测本机 Clash Controller → 发现 Selector → 导入节点 → 写进配置。
 * 手动做这件事是五步流程。
 *
 * ## 安全边界:只扫 localhost 的固定白名单
 *
 * **绝不扫 LAN,绝不扫端口段。** 这是明确的安全约束,理由不止是
 * 礼貌:一个会扫网段的工具在不受控网络上运行就是一次未授权的端口扫描,
 * 而它带来的便利(自动发现别人机器上的 Clash)本项目根本不需要 ——
 * 本网关只用本机的 Clash 做桥接。
 *
 * 白名单只包含少量常见的本机 Controller 端口。探不到就让用户手填，而不是靠扫描猜。
 *
 * ## 为什么必须从 Controller 的 `/configs` 读 `mixed-port`
 *
 * 混合端口不是稳定的文档默认值，且 `port`/`socks-port` 可能都为 0；端口随
 * 内核配置变化，必须从 Controller 读取。
 * **正因为它会变**,硬编码任何一个值(包括这里提到的这几个)都会让桥接
 * 静默连到一个没人监听的端口:所有桥接代理传输失败,而控制面明明是通的。
 * 那是个极难自查的故障,所以端口只能问内核。
 *
 * ## 这个脚本会改配置,所以它必须先备份、且默认不覆盖已有内容
 *
 * 与 `doctor.mjs` 相反(那个绝对只读)。但「自动配置」不等于「可以丢掉
 * 用户手写的东西」:config.json 里有 Relay Token 与 Zen API key,
 * 那是整个文件里最不能丢的两样。所以:
 *
 *   - 保留全部既有 Worker(连同 apiKey)与 Relay Token
 *   - 代理按 id 合并:同 id 更新连接信息,不动用户可能改过的 name/enabled
 *   - 写盘前把原文件备份成 `config.json.bak`
 *   - `--dry-run` 只打印将要做的改动,不落盘
 *
 * ## Worker 与出口分开
 *
 * setup 只负责发现出口，不猜测用户要创建多少认证或匿名 Worker；已有的两种
 * Worker 都会原样保留。管理页面和配置补丁提供完整的新增、编辑、删除、绑定。
 */

import { copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { configExists, configPath, loadConfig, saveConfig, ConfigError } from "../src/store/config.ts";
import { ConfigSchema } from "../src/shared/schema.ts";
import { isLoopbackAddress } from "../src/server/middleware/loopbackOnly.ts";
import { safeErrorMessage } from "../src/shared/redact.ts";
import { isGroupType } from "../src/shared/clashNodeTypes.ts";
import { dataDirOf } from "./lib/instance.mjs";
import { detail, heading, line, nextStep } from "./lib/report.mjs";
import { checkArgs } from "./lib/args.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = dataDirOf(ROOT);
const ROOT_ARG = process.env.ZG_DATA_DIR ? undefined : ROOT;

/*
 * 参数校验放在**任何副作用之前** —— 这个脚本会写 `data/config.json`，
 * 也就是唯一一份凭证存储。未识别的参数若被静默忽略并照常执行完整导入，
 * `npm run setup -- --help` 的后果就是一次真实写入而不是一段用法说明。
 * 理由写在 `lib/args.mjs`。
 */
checkArgs({
  command: "npm run setup",
  summary: "zen-gateway 自动配置：探测本机 Clash Controller → 导入出口（不创建 Worker）。",
  flags: [
    { flag: "--dry-run", help: "只报会做什么，不写盘" },
    { flag: "--api", takesValue: true, help: "显式指定 Controller 地址（跳过端口探测）" },
    { flag: "--secret", takesValue: true, help: "Controller 的 secret" },
  ],
});

const DRY_RUN = process.argv.includes("--dry-run");

/**
 * 候选 Controller 端口 —— **固定白名单,仅 127.0.0.1**。
 *
 * 9090 是常见默认值，其余是少量候选。列表刻意短：探不到就让用户用 `--api` 手填，
 * 那比把列表扩成一个端口段要好 —— 见文件头的安全边界。
 */
const CANDIDATE_PORTS = [9090, 9097, 9091, 9093, 6170];

/** 每个候选的探测超时。本机通信,给 1.5s 足够,而探 5 个也只要几秒。 */
const PROBE_TIMEOUT_MS = 1_500;

/* ------------------------------------------------------------------ *
 * Controller 探测
 * ------------------------------------------------------------------ */

function ensureSlash(base) {
  const u = new URL(base);
  u.search = "";
  u.hash = "";
  if (!u.pathname.endsWith("/")) u.pathname = `${u.pathname}/`;
  return u.href;
}

function isLocalControllerUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      (url.hostname === "localhost" || isLoopbackAddress(url.hostname))
    );
  } catch {
    return false;
  }
}

async function ask(apiBase, path, secret, timeoutMs = PROBE_TIMEOUT_MS) {
  const res = await fetch(new URL(path, ensureSlash(apiBase)).href, {
    ...(secret ? { headers: { authorization: `Bearer ${secret}` } } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return res;
}

/**
 * 探一个候选地址。
 *
 * 三种结局要分开,因为处置完全不同:
 *   - `ok`       连上且鉴权过
 *   - `auth`     **连上了但要 secret** —— 这是个发现!只是缺凭证
 *   - `absent`   没人监听
 *
 * 把 `auth` 合进 `absent` 是最容易犯的错:那会让一个配了 secret 的 Clash
 * 被报成「没找到」,用户于是去检查 Clash 是否运行 —— 而它正在运行。
 */
async function probeController(apiBase, secret) {
  try {
    const res = await ask(apiBase, "version", secret);
    if (res.status === 401 || res.status === 403) return { kind: "auth", apiBase };
    if (!res.ok) return { kind: "absent", apiBase, why: `返回 ${res.status}` };
    const body = await res.json();
    return {
      kind: "ok",
      apiBase,
      secret: secret ?? "",
      version: typeof body?.version === "string" ? body.version : "unknown",
      isMeta: body?.meta === true,
    };
  } catch (err) {
    return { kind: "absent", apiBase, why: safeErrorMessage(err) };
  }
}

/**
 * 找出本机的 Controller。
 *
 * `--api` / `--secret` 显式指定时**只探那一个** —— 用户已经知道答案了,
 * 再去扫白名单只会让输出变吵。
 */
async function discoverControllers({ explicitApi, explicitSecret, knownSecrets }) {
  if (explicitApi !== undefined) {
    if (!isLocalControllerUrl(explicitApi)) {
      throw new Error("Controller 地址必须是本机 http 回环地址，不会向远程地址发送 secret");
    }
    const r = await probeController(explicitApi, explicitSecret);
    return { found: r.kind === "ok" ? [r] : [], needAuth: r.kind === "auth" ? [r] : [], tried: [explicitApi] };
  }

  const found = [];
  const needAuth = [];
  const tried = [];

  for (const port of CANDIDATE_PORTS) {
    const apiBase = `http://127.0.0.1:${port}`;
    tried.push(apiBase);

    /*
     * 先免 secret 试,再用**配置里已有的** secret 逐个试。
     *
     * 后者是关键:用户上次配好过一个内核,这次重跑 setup 不该因为"我们不知道
     * secret"而把它报成需要鉴权。已有配置正是 secret 的来源 —— 那不是猜测,
     * 是我们自己存的。
     */
    let result = await probeController(apiBase, undefined);
    if (result.kind === "auth") {
      for (const secret of knownSecrets) {
        if (secret === "") continue;
        const retry = await probeController(apiBase, secret);
        if (retry.kind === "ok") {
          result = retry;
          break;
        }
      }
    }

    if (result.kind === "ok") found.push(result);
    else if (result.kind === "auth") needAuth.push(result);
  }

  return { found, needAuth, tried };
}

/* ------------------------------------------------------------------ *
 * 从 Controller 取出要写进配置的东西
 * ------------------------------------------------------------------ */


async function readController(ctrl) {
  const secret = ctrl.secret;

  // 混合端口 —— 见文件头:这个值只能问内核。
  let mixedPort = null;
  /**
   * 选路模式。`rule`(默认)下 `GLOBAL` 分组不参与选路 —— 见 `pickSelector`。
   *
   * 读不到时按 `rule` 处理:那是内核默认值,也是**保守**的一侧
   * (把 GLOBAL 降级最坏只是选了另一个同样能用的分组;反过来则会选中一个
   * 切了不生效的分组,而那个故障不报任何错)。
   */
  let mode = "rule";
  try {
    const res = await ask(ctrl.apiBase, "configs", secret, 3000);
    if (res.ok) {
      const body = await res.json();
      if (typeof body?.mode === "string") mode = body.mode.toLowerCase();
      const p = body?.["mixed-port"];
      if (typeof p === "number" && p > 0) mixedPort = p;
      /*
       * `socks-port` 与 `port` 不能作为替代：桥接 dispatcher 明确使用 HTTP
       * CONNECT，而把 SOCKS 端口写成混合端口会让 setup 报成功、所有转发再失败。
       * 没有真正的 mixed-port 时交给调用方拒绝配置，要求用户在 Clash 中开启它。
       */
    }
  } catch {
    /* 下面会按 null 处理 */
  }

  const res = await ask(ctrl.apiBase, "proxies", secret, 5000);
  if (!res.ok) throw new Error(`读取节点列表失败:${res.status}`);
  const body = await res.json();
  const proxies = body?.proxies;
  if (proxies === null || typeof proxies !== "object") throw new Error("/proxies 返回的不是对象");

  const selectors = [];
  const nodes = [];
  for (const [name, value] of Object.entries(proxies)) {
    if (value === null || typeof value !== "object") continue;
    const type = typeof value.type === "string" ? value.type : "";
    if (type === "Selector") {
      selectors.push({
        name,
        now: typeof value.now === "string" ? value.now : "",
        options: Array.isArray(value.all) ? value.all.filter((x) => typeof x === "string") : [],
      });
      continue;
    }
    if (isGroupType(type)) continue;
    const history = Array.isArray(value.history) ? value.history : [];
    const last = history.at(-1);
    nodes.push({
      name,
      type,
      latencyMs: typeof last?.delay === "number" && last.delay > 0 ? last.delay : null,
    });
  }

  /*
   * 规则的目标分组 —— `GLOBAL` 陷阱的**直接证据**。
   *
   * 拿不到就给 null，`pickSelector` 会退回按名字降级那个启发式。
   * 旧内核可能没有 `/rules`，而那不该让整个 setup 失败。
   */
  let routed = null;
  try {
    const rulesRes = await ask(ctrl.apiBase, "rules", secret, 5000);
    if (rulesRes.ok) {
      const rulesBody = await rulesRes.json();
      const rules = rulesBody?.rules;
      if (Array.isArray(rules)) {
        const targets = new Map();
        let fallback = null;
        for (const r of rules) {
          const proxy = typeof r?.proxy === "string" ? r.proxy : "";
          if (proxy === "") continue;
          targets.set(proxy, (targets.get(proxy) ?? 0) + 1);
          if (typeof r?.type === "string" && r.type.toLowerCase() === "match") fallback = proxy;
        }
        routed = { targets, fallback };
      }
    }
  } catch {
    /* 退回启发式 */
  }

  return { mixedPort, mode, selectors, nodes, routed };
}

/**
 * 挑一个 selector 分组。
 *
 * ## `GLOBAL` 在 rule 模式下是个**陷阱**,必须排到最后
 *
 * 某些配置里 `GLOBAL` 与业务 selector 可能拥有相同节点数量；只按数量排序时
 * 会因名称 tiebreak 选中 `GLOBAL`。
 *
 * 但内核的 `mode` 是 **`rule`**,而 rule 模式下 `GLOBAL` **根本不参与选路**
 * (规则把流量导向 `Proxy` 这类分组)。于是切 `GLOBAL` 的选中节点**什么都
 * 不会改变**,实测它的 `now` 还停在 `DIRECT`:
 *
 *   → 所有 Worker 的流量都走本机直连出口
 *   → 它们共用同一个公网 IP
 *   → 回显出口与上游连接核对是本项目的重要诊断依据
 *
 * 这个故障**不报任何错**:控制面通、切换请求返回 204、探测也能拿到 IP ——
 * 只是每个 Worker 拿到的是**同一个** IP。只有 `doctor --deep` 的隔离报告
 * 会发现它,而那需要用户想到去跑。
 *
 * ## 判据是"规则实际导向哪里"，不是"名字"
 *
 * 按**名字**把 `GLOBAL` 降级只是个启发式，漏洞在于：
 * 一个名字不叫 GLOBAL 却同样不参与选路的分组仍会被选中。
 *
 * 所以读 `/rules`（`routedGroups()`）：那里有每条规则的目标分组与兜底
 * (`MATCH`) 规则。若选中的分组不出现在规则目标里，它就不参与选路；这就是直接
 * 证据，不依赖分组名称。
 *
 * 拿不到 `/rules` 时退回按名字降级（旧内核可能没有这个端点）——
 * **降级而不是失败**：那个启发式对最常见的形态仍然有效。
 *
 * `global` 模式下相反 —— 那时 `GLOBAL` 才是真正生效的那个，不降级。
 *
 * (本项目已经踩过一次同构的坑:vite 代理硬编码 9876 把请求转给了**另一个
 * 进程**,"看起来在工作但数据来自错误后端"。这一条是它在出口侧的形态。)
 */
function pickSelector(selectors, nodes, mode, routed) {
  const nodeNames = new Set(nodes.map((n) => n.name));
  const ruleMode = mode !== "global";

  /*
   * 优先级三档（小者优先）：
   *   0 = 规则的兜底目标（`MATCH` 指向它）—— 最强证据
   *   1 = 出现在某条规则里
   *   2 = 规则里完全没出现 —— rule 模式下它切了不生效
   *
   * 拿不到 `/rules` 时全部记 1（无信息），于是排序退回"按名字降级 + 可用节点数"。
   */
  const rank = (name) => {
    if (!ruleMode) return name === "GLOBAL" ? 0 : 1;
    if (routed === null) return name === "GLOBAL" ? 2 : 1;
    if (routed.fallback === name) return 0;
    return routed.targets.has(name) ? 1 : 2;
  };

  const scored = selectors
    .map((s) => ({
      selector: s,
      usable: s.options.filter((o) => nodeNames.has(o)).length,
      rank: rank(s.name),
    }))
    .filter((x) => x.usable > 0)
    .sort(
      (a, b) => a.rank - b.rank || b.usable - a.usable || a.selector.name.localeCompare(b.selector.name),
    );
  return scored[0] ?? null;
}

/**
 * 代理 id。
 *
 * 必须**从节点名稳定推导**,不能用随机值或序号:重跑 setup 时同一个节点
 * 要落到同一个 id,否则每次都新增一批代理,而旧的那批仍被 Worker 引用 ——
 * 配置会越长越乱,而 Worker 绑的出口悄悄变成一个陈旧条目。
 *
 * 用 sha256 而不是节点名本身:节点名含空格、冒号、emoji(实测
 * `🇺🇲 示例节点2 IPLC  VIP2 网址:example.invalid`),而 `IdSchema` 只允许
 * `[A-Za-z0-9._:-]`。前缀保留 `controller_` 与既有配置一致。
 */
function proxyIdFor(nodeName) {
  return `controller_${createHash("sha256").update(nodeName).digest("hex").slice(0, 24)}`;
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main() {
  console.log(`zen-gateway 自动配置${DRY_RUN ? "(--dry-run,不会写盘)" : ""}`);
  console.log(`data/ ${DATA_DIR}`);

  /* ---------- 1. 读现有配置 ---------- */
  heading("1. 现有配置");

  /*
   * `--dry-run` 时先问「文件在不在」,**不能直接 loadConfig**。
   *
   * `loadConfig` 在文件不存在时会**生成一份默认配置并写盘**(含新 Relay Token)。
   * 那对服务端是对的(首启该生成),但让 `--dry-run` 变成了一句假话:
   * 横幅打着「不会写盘」,而它刚刚落了一个 0600 文件和一个新 token。
   *
   * `doctor.mjs` 的第 1 层用 `configExists` 挡了同一个陷阱
   * （「跑一次 doctor 就把状态改了」）,这里必须同样挡住:
   * 否则空 data 目录跑 `--dry-run` 后会出现一个新生成的 relayToken。
   */
  if (DRY_RUN && !(await configExists(ROOT_ARG))) {
    line("fail", "配置不存在");
    detail("--dry-run 刻意不替你生成 —— 那会改变状态,而你只是想先看看。");
    nextStep("先 `npm start`（首启会生成默认配置与 Relay Token）,再跑本命令。");
    process.exitCode = 1;
    return;
  }

  let config;
  let created;
  try {
    const loaded = await loadConfig(ROOT_ARG, { readOnly: DRY_RUN });
    config = loaded.config;
    created = loaded.created;
  } catch (err) {
    if (err instanceof ConfigError) {
      line("fail", `配置无法加载(${err.kind})`);
      detail(err.message);
      nextStep(
        err.kind === "invalid" || err.kind === "malformed"
          ? "先修好 config.json —— setup 不会覆盖一份读不懂的配置(里面有你的 Relay Token 与 API key)。"
          : `检查权限与磁盘:ls -l ${configPath(ROOT_ARG)}`,
      );
      process.exitCode = 1;
      return;
    }
    throw err;
  }
  line("pass", created ? "已生成默认配置(首次运行)" : "配置可加载");
  detail(
    `Worker ${config.workers.length} 个 · 代理 ${config.proxies.length} 个 · ` +
      `Clash 内核 ${config.clash.bridges.length} 个`,
  );

  /* ---------- 2. 探测 Controller ---------- */
  heading("2. 探测本机 Clash Controller");
  const explicitApi = argValue("--api");
  const explicitSecret = argValue("--secret");
  // 已有配置里的 secret 是我们自己存的,不是猜测 —— 见 discoverControllers。
  const knownSecrets = [...new Set(config.clash.bridges.map((b) => b.apiSecret))];
  if (explicitSecret !== undefined) knownSecrets.unshift(explicitSecret);

  const { found, needAuth, tried } = await discoverControllers({
    explicitApi,
    explicitSecret,
    knownSecrets,
  });
  detail(`已探测(仅 127.0.0.1):${tried.join(", ")}`);

  if (found.length === 0) {
    if (needAuth.length > 0) {
      line("fail", `发现 ${needAuth.length} 个 Controller,但都需要 secret`);
      detail(needAuth.map((r) => r.apiBase).join(", "));
      nextStep(
          `从 Clash 的配置或管理界面取得 secret,然后:\n` +
          `  node scripts/setup.mjs --api ${needAuth[0].apiBase} --secret '<secret>'`,
      );
    } else {
      line("fail", "没有找到本机的 Clash Controller");
      nextStep(
        `确认 Clash 正在运行,且开了 External Controller。\n` +
          `若它监听在白名单之外的端口,显式指定:\n` +
          `  node scripts/setup.mjs --api http://127.0.0.1:<端口> --secret '<secret>'\n` +
          `（setup 刻意只探固定白名单,不扫端口段 —— 见脚本头的安全边界。）`,
      );
    }
    process.exitCode = 1;
    return;
  }

  for (const c of found) {
    line("pass", `${c.apiBase} → ${c.isMeta ? "mihomo" : "clash"} ${c.version}`);
  }

  /* ---------- 3. 读节点与分组 ---------- */
  heading("3. 发现 Selector 与节点");
  const plans = [];
  for (const ctrl of found) {
    let info;
    try {
      info = await readController(ctrl);
    } catch (err) {
      line("fail", `${ctrl.apiBase}:${safeErrorMessage(err)}`);
      continue;
    }

    if (info.mixedPort === null) {
      /*
       * 拿不到端口就**不能**配这个内核 —— 见文件头。猜一个默认值的后果是
       * 桥接静默连到没人监听的端口,而那是本项目最难自查的故障之一。
       */
      line("fail", `${ctrl.apiBase}:无法从 /configs 读出可用的代理端口`);
      detail("未读到有效的 mixed-port —— 桥接需要 HTTP 混合端口；socks-port / port 不能替代，请在 Clash 中开启 mixed-port。");
      continue;
    }

    const picked = pickSelector(info.selectors, info.nodes, info.mode, info.routed);
    if (picked === null) {
      line("fail", `${ctrl.apiBase}:没有找到含可出口节点的 Selector 分组`);
      detail(`分组 ${info.selectors.length} 个,节点 ${info.nodes.length} 个,但两者无交集。`);
      continue;
    }

    line(
      "pass",
      `${ctrl.apiBase}:分组「${picked.selector.name}」含 ${picked.usable} 个可用节点,代理端口 ${info.mixedPort}`,
    );
    detail(`内核选路模式:${info.mode}`);
    if (info.selectors.length > 1) {
      detail(
        `其余分组:${info.selectors
          .filter((s) => s.name !== picked.selector.name)
          .map((s) => s.name)
          .join(", ")}`,
      );
    }
    /*
     * 选了 GLOBAL 就必须说清后果 —— 见 `pickSelector`。
     * 走到这里意味着没有别的候选,那时 GLOBAL 是唯一选择,但它在 rule 模式下
     * 可能切了不生效,而用户需要知道这件事才能去 Clash 里加一个分组。
     */
    if (info.mode !== "global" && picked.selector.name === "GLOBAL") {
      line("warn", `只找到 GLOBAL 分组,而内核是 ${info.mode} 模式 —— 切换它可能不生效`);
      detail(
        "rule 模式下规则把流量导向别的分组,切 GLOBAL 不改变实际出口:\n" +
          "所有 Worker 会共用同一个公网 IP,而这个故障不报任何错。\n" +
          "建议在 Clash 配置里加一个 proxy-group(type: select)并让规则指向它,\n" +
          "然后重跑 setup。配好后务必用 npm run doctor -- --deep 验证隔离。",
      );
    }

    plans.push({ ctrl, info, selector: picked.selector });
  }

  if (plans.length === 0) {
    process.exitCode = 1;
    return;
  }

  /* ---------- 4. 合并进配置 ---------- */
  heading("4. 合并进配置");

  const next = structuredClone(config);
  next.clash.enabled = true;

  const summary = { bridgesAdded: 0, bridgesUpdated: 0, proxiesAdded: 0, proxiesUpdated: 0 };

  for (const plan of plans) {
    const url = new URL(plan.ctrl.apiBase);
    /*
     * 内核 id 从端口推导,稳定且可读。
     *
     * 重跑 setup 要落到同一个 id —— 否则每次新增一个内核条目,而代理仍引用
     * 旧的那个。`IdSchema` 允许 `.` 与 `-`，所以按地址生成的 bridge id 合法。
     */
    const bridgeId = `bridge-${url.hostname}-${url.port}`;
    const existing = next.clash.bridges.find((b) => b.id === bridgeId);

    if (existing === undefined) {
      next.clash.bridges.push({
        id: bridgeId,
        name: `${plan.ctrl.isMeta ? "mihomo" : "clash"} ${url.port}`,
        enabled: true,
        priority: 100,
        apiBase: plan.ctrl.apiBase,
        apiSecret: plan.ctrl.secret,
        localProxyHost: "127.0.0.1",
        localProxyPort: plan.info.mixedPort,
        selectorGroup: plan.selector.name,
      });
      summary.bridgesAdded += 1;
    } else {
      /*
       * 只更新**探测得来的事实**(端口、secret、分组),保留用户可能改过的
       * `name` / `priority` / `enabled`。
       *
       * `enabled` 尤其不能动:用户可能刻意停用了一个内核(本机就有一个
       * 不可达的条目可能因控制面鉴权失败而被停用，而 setup 把它重新启用等于
       * 撤销用户的决定。
       */
      existing.apiBase = plan.ctrl.apiBase;
      existing.apiSecret = plan.ctrl.secret;
      existing.localProxyPort = plan.info.mixedPort;
      existing.selectorGroup = plan.selector.name;
      summary.bridgesUpdated += 1;
    }

    // 只导入**这个分组里**的节点 —— 分组外的节点切不过去。
    const inGroup = new Set(plan.selector.options);
    for (const node of plan.info.nodes) {
      if (!inGroup.has(node.name)) continue;

      const id = proxyIdFor(node.name);
      const existingProxy = next.proxies.find((p) => p.id === id);

      if (existingProxy === undefined) {
        next.proxies.push({
          id,
          name: node.name,
          type: node.type.toLowerCase(),
          /*
           * host/port 指向**本机的 Clash 混合端口**,不是节点的真实地址 ——
           * 桥接的全部含义就是「流量交给本机 Clash,由它按 selector 转出去」。
           * 节点的真实地址我们既拿不到(Controller 不给)也不需要。
           */
          host: "127.0.0.1",
          port: plan.info.mixedPort,
          enabled: true,
          source: "controller",
          controllerGroup: plan.selector.name,
          bridgeId,
          clashNodeName: node.name,
          /*
           * `direct: false` —— 这些节点的协议(anytls/vless/hysteria2…)
           * undici 与 socks 都接不了,只能经 Clash 桥接。
           */
          direct: false,
          bridgeable: true,
          egressIp: null,
        });
        summary.proxiesAdded += 1;
      } else {
        existingProxy.port = plan.info.mixedPort;
        existingProxy.bridgeId = bridgeId;
        existingProxy.clashNodeName = node.name;
        existingProxy.controllerGroup = plan.selector.name;
        summary.proxiesUpdated += 1;
      }
    }

    /*
     * `activeBridgeId` 只在**为空时**设,不抢用户已选的。
     *
     * `selectionMode` 完全不动:它默认 `auto`,而用户若改成 `manual` 并选了
     * 一个内核,那是个明确的决定。
     *
     * **但绝不指向一个停用的内核。** 更新分支刻意保留
     * `enabled: false`（用户可能故意停用了某个内核），而这里若把
     * `activeBridgeId` 指过去,`pickBridge` 在 manual 模式下只在**已启用**的
     * 内核里找（`pool.ts`）→ 返回 null → 每个桥接代理都失败,
     * 而 setup 打的是 ✓ 并说「出口已配好」。
     * 不可达的内核可能因控制面鉴权失败而被停用。
     */
    if (next.clash.activeBridgeId === null) {
      const candidate = next.clash.bridges.find((b) => b.id === bridgeId);
      if (candidate?.enabled === true) next.clash.activeBridgeId = bridgeId;
      else nextStep(`内核 ${bridgeId} 处于停用状态,未设为当前内核 —— 启用它之后再跑一次。`);
    }
  }

  line(
    "pass",
    `内核 +${summary.bridgesAdded} / 更新 ${summary.bridgesUpdated}，` +
      `代理 +${summary.proxiesAdded} / 更新 ${summary.proxiesUpdated}`,
  );
  detail(`Worker 未改动(${next.workers.length} 个)—— 见下方说明。`);

  /* ---------- 5. 校验后写盘 ---------- */
  heading("5. 写入");

  /*
   * 写盘前先过 schema。
   *
   * `saveConfig` 自己也会 parse,但那时抛出的错误已经在"正在写你的配置"
   * 这个语境里 —— 而我们想在**碰文件之前**就知道合并结果是否合法。
   * 引用完整性尤其要紧:代理引用了不存在的 bridgeId 会让整份配置加载失败,
   * 于是一次 setup 把服务变成起不来。
   */
  const parsed = ConfigSchema.safeParse(next);
  if (!parsed.success) {
    line("fail", "合并后的配置未通过校验,已放弃写入");
    detail(
      parsed.error.issues
        .slice(0, 10)
        .map((i) => `${i.path.join(".") || "(根)"}: ${i.message}`)
        .join("\n"),
    );
    nextStep("这是 setup 自己的缺陷(它生成了一份非法配置),你的 config.json 未被改动。");
    process.exitCode = 1;
    return;
  }

  if (DRY_RUN) {
    line("skip", "--dry-run:未写盘");
    detail(
      `将写入 ${configPath(ROOT_ARG)}\n` +
        `内核 ${parsed.data.clash.bridges.length} 个 · 代理 ${parsed.data.proxies.length} 个`,
    );
  } else {
    /*
     * 备份。
     *
     * config.json 里有 Relay Token 与全部 Zen API key —— 整个文件都是凭证。
     * 一个自动化工具改它之前必须留一份可回退的副本,哪怕合并逻辑看起来是
     * 加法。备份与原文件同目录(继承 0700)且同样 0600。
     *
     * 首次运行(文件刚由 loadConfig 生成)时没什么可备份的,但照做也无害 ——
     * 少一个条件分支。
     */
    const file = configPath(ROOT_ARG);
    try {
      await copyFile(file, `${file}.bak`);
    } catch (err) {
      // 备份失败就不写 —— 没有回退手段的自动改写不值得做。
      line("fail", `无法备份 ${file}:${safeErrorMessage(err)}`);
      nextStep("手工备份后重试,或用 --dry-run 先看改动。");
      process.exitCode = 1;
      return;
    }

    await saveConfig(parsed.data, ROOT_ARG);
    line("pass", `已写入 ${file}`);
    detail(`原文件已备份为 ${file}.bak`);
  }

  /* ---------- 6. 下一步 ---------- */
  console.log("\n────────────────────────");

  const usableWorkers = parsed.data.workers.filter((w) => w.enabled && (w.kind === "anonymous" || w.apiKey.trim() !== ""));
  if (usableWorkers.length === 0) {
    console.log("出口已配好,但还没有可用的 Worker —— 可创建认证或匿名 Worker。");
    nextStep(
      `在 ${configPath(ROOT_ARG)} 的 workers 数组里加(认证 Worker 每个 key 一条，匿名 Worker 可免 key，绑不同出口才有隔离):\n` +
        parsed.data.proxies
          .slice(0, 2)
          .map(
            (p, i) =>
              `  { "id": "w${i + 1}", "kind": "authenticated", "apiKey": "<你的 key>", "proxyId": "${p.id}" }`,
          )
          .join("\n") +
        `\n  { "id": "anon-1", "kind": "anonymous", "proxyId": "${parsed.data.proxies[0]?.id ?? "<代理 id>"}" }` +
        `\n\n然后:npm run restart && npm run doctor`,
    );
    console.log(
      "\n说明:认证 Worker 需要真实 Zen API key；匿名 Worker 可以在管理页或配置中显式创建。",
    );
  } else {
    nextStep(
      "npm run restart && npm run doctor\n" +
        "验证回显出口（不代表 Zen 实际出口）:npm run doctor -- --deep",
    );
  }
}

await main();
