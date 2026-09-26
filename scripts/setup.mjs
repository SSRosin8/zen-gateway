#!/usr/bin/env node
/**
 * 一键自动配置：探测本机 Clash Controller → 发现 Selector → 导入节点 → 写进配置。
 *
 * 安全边界：只探 127.0.0.1 的固定端口白名单，绝不扫 LAN 或端口段；探不到就让用户手填。
 *
 * 混合端口必须从 Controller 的 `/configs` 读 `mixed-port`：它随内核配置变化，
 * 硬编码会让桥接静默连到没人监听的端口，而控制面仍是通的。
 *
 * 会改配置，所以：
 *   - 保留全部既有 Worker（连同 apiKey）与 Relay Token，不创建 Worker
 *   - 代理按 id 合并：同 id 更新连接信息，不动用户可能改过的 name/enabled
 *   - 写盘前把原文件备份成 `config.json.bak`
 *   - `--dry-run` 只打印将要做的改动，不落盘
 */

import { copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { configExists, configPath, loadConfig, saveConfig, ConfigError } from "../src/store/config.ts";
import { ConfigSchema } from "../src/shared/schema.ts";
import { isLoopbackAddress } from "../src/server/middleware/loopbackOnly.ts";
import { safeErrorMessage } from "../src/shared/redact.ts";
import { ClashController, ControllerError } from "../src/core/proxy/clash/controller.ts";
import { dataDirOf } from "./lib/instance.mjs";
import { detail, heading, line, nextStep } from "./lib/report.mjs";
import { checkArgs } from "./lib/args.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = dataDirOf(ROOT);
const ROOT_ARG = process.env.ZG_DATA_DIR ? undefined : ROOT;

// 参数校验放在任何副作用之前：错参数被忽略会变成一次真实写入（见 `lib/args.mjs`）。
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

/** 候选 Controller 端口 —— 固定白名单，仅 127.0.0.1。刻意短，探不到用 `--api` 手填。 */
const CANDIDATE_PORTS = [9090, 9097, 9091, 9093, 6170];

/** 每个候选的探测超时（本机通信）。 */
const PROBE_TIMEOUT_MS = 1_500;

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

/**
 * 探一个候选地址：`ok` 连上且鉴权过、`auth` 连上但要 secret、`absent` 没人监听。
 * `auth` 不能合进 `absent`，否则配了 secret 的 Clash 会被报成「没找到」。
 */
async function probeController(apiBase, secret) {
  const controller = new ClashController(
    { id: "setup-probe", apiBase, apiSecret: secret ?? "" },
    { timeoutMs: PROBE_TIMEOUT_MS },
  );
  try {
    const { version, isMeta } = await controller.version();
    return { kind: "ok", apiBase, secret: secret ?? "", version, isMeta };
  } catch (err) {
    if (err instanceof ControllerError && err.kind === "auth") return { kind: "auth", apiBase };
    return { kind: "absent", apiBase, why: safeErrorMessage(err) };
  }
}

/** 找出本机的 Controller。`--api` 显式指定时只探那一个。 */
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

    // 先免 secret 试，再用配置里已有的 secret 逐个试 —— 那是我们自己存的，不是猜测。
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

/**
 * 读取配置内核所需的全部信息，解析复用 `ClashController`，与 doctor 和转发路径
 * 同一份实现（纪律 #4）。
 */
async function readController(ctrl) {
  const controller = new ClashController({ id: "setup", apiBase: ctrl.apiBase, apiSecret: ctrl.secret });

  /*
   * 混合端口只能问内核；读不到时为 null，由调用方拒绝配置。`socks-port` / `port`
   * 不能替代：桥接 dispatcher 使用 HTTP CONNECT。
   * 选路模式读不到时按 `rule`（内核默认，也是保守的一侧，见 `pickSelector`）。
   */
  const runtime = await controller.runtimeConfig().catch(() => ({ mode: null, mixedPort: null }));

  // 节点列表是必需的：读不到直接失败，由调用方报告并跳过这个内核。
  const [selectors, nodes] = await Promise.all([controller.selectors(), controller.nodes()]);

  // 规则的目标分组，`GLOBAL` 陷阱的直接证据；旧内核可能没有 `/rules`，拿不到给 null。
  const routed = await controller.routedGroups().catch(() => null);

  return { mixedPort: runtime.mixedPort, mode: runtime.mode ?? "rule", selectors, nodes, routed };
}

/**
 * 挑一个 selector 分组。
 *
 * rule 模式下 `GLOBAL` 不参与选路，切它不改变实际出口：所有 Worker 共用同一个
 * 公网 IP，且不报任何错（只有 `doctor --deep` 能发现）。只按节点数排序时
 * 它可能因名称 tiebreak 被选中。
 *
 * 判据是规则实际导向哪里：读 `/rules`（`routedGroups()`），不在规则目标里的分组
 * 不参与选路。拿不到 `/rules` 时降级为按名字把 `GLOBAL` 排到最后。
 * `global` 模式下相反，`GLOBAL` 才是生效的那个。
 */
function pickSelector(selectors, nodes, mode, routed) {
  const nodeNames = new Set(nodes.map((n) => n.name));
  const ruleMode = mode !== "global";

  /*
   * 优先级（小者优先）：0 = `MATCH` 兜底目标，1 = 出现在某条规则里，
   * 2 = 规则里没出现（rule 模式下切了不生效）。拿不到 `/rules` 时退回按名字降级。
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
 * 代理 id，从节点名稳定推导：重跑 setup 时同一节点要落到同一个 id，
 * 否则 Worker 仍绑着陈旧条目。用 sha256 是因为节点名含空格、emoji 等
 * `IdSchema` 不允许的字符；前缀 `controller_` 与既有配置一致。
 */
function proxyIdFor(nodeName) {
  return `controller_${createHash("sha256").update(nodeName).digest("hex").slice(0, 24)}`;
}

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
   * `--dry-run` 时先问文件在不在，不能直接 loadConfig：它在文件不存在时会生成默认
   * 配置并写盘（含新 Relay Token），让「不会写盘」变成假话。doctor 第 1 层同理。
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
      // 拿不到端口就不能配这个内核，猜默认值会让桥接静默连到没人监听的端口。
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
    // 只剩 GLOBAL 可选时必须说清后果（见 `pickSelector`），让用户去 Clash 里加分组。
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
    // 内核 id 从地址推导，重跑 setup 落到同一个 id（`IdSchema` 允许 `.` 与 `-`）。
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
       * 只更新探测得来的事实（端口、secret、分组），保留用户可能改过的
       * `name` / `priority` / `enabled` —— 重新启用被停用的内核等于撤销用户的决定。
       */
      existing.apiBase = plan.ctrl.apiBase;
      existing.apiSecret = plan.ctrl.secret;
      existing.localProxyPort = plan.info.mixedPort;
      existing.selectorGroup = plan.selector.name;
      summary.bridgesUpdated += 1;
    }

    // 只导入这个分组里的节点 —— 分组外的节点切不过去。
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
          // host/port 指向本机 Clash 混合端口而不是节点真实地址：流量交给 Clash 按 selector 转出。
          host: "127.0.0.1",
          port: plan.info.mixedPort,
          enabled: true,
          source: "controller",
          controllerGroup: plan.selector.name,
          bridgeId,
          clashNodeName: node.name,
          // 这些节点的协议（anytls/vless/hysteria2…）undici 与 socks 都接不了，只能经桥接。
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
     * `activeBridgeId` 只在为空时设，`selectionMode` 完全不动 —— 不抢用户的选择。
     * 绝不指向停用的内核：manual 模式下 `pickBridge`（`pool.ts`）只在已启用内核里找，
     * 指过去会让每个桥接代理都失败，而 setup 仍报 ✓。
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
   * 写盘前先过 schema，在碰文件之前就知道合并结果是否合法 ——
   * 例如代理引用不存在的 bridgeId 会让整份配置加载失败，服务起不来。
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
    // config.json 整个文件都是凭证，自动改写前必须留可回退的副本（同目录、0600）。
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
