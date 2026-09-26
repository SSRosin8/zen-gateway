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
import { dirname, join } from "node:path";
import { configExists, configPath, loadConfig, saveConfig, ConfigError } from "../src/store/config.ts";
import {
  discoverControllers,
  mergeControllerImport,
  NonLocalControllerError,
  planController,
} from "../src/core/proxy/clash/setupImport.ts";
import { safeErrorMessage } from "../src/shared/redact.ts";
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

// 探测、选分组与合并的实现在 `src/core/proxy/clash/setupImport.ts`，与管理面 `/api/clash/*` 共用。

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
  const knownSecrets = config.clash.bridges.map((b) => b.apiSecret);

  let discovered;
  try {
    discovered = await discoverControllers({
      ...(explicitApi !== undefined ? { explicitApi } : {}),
      ...(explicitSecret !== undefined ? { secret: explicitSecret } : {}),
      knownSecrets,
    });
  } catch (err) {
    if (err instanceof NonLocalControllerError) {
      line("fail", err.message);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
  const { tried } = discovered;
  const found = discovered.results.filter((r) => r.kind === "ok");
  const needAuth = discovered.results.filter((r) => r.kind === "auth");
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
    const outcome = await planController(ctrl);
    if (!outcome.ok) {
      line("fail", `${ctrl.apiBase}:${outcome.reason}`);
      if (outcome.detail !== undefined) detail(outcome.detail);
      continue;
    }
    const plan = outcome.plan;
    line(
      "pass",
      `${ctrl.apiBase}:分组「${plan.selector.name}」含 ${plan.usable} 个可用节点,代理端口 ${plan.mixedPort}`,
    );
    detail(`内核选路模式:${plan.mode}`);
    if (plan.otherSelectors.length > 0) detail(`其余分组:${plan.otherSelectors.join(", ")}`);
    // 只剩 GLOBAL 可选时必须说清后果（见 `pickSelector`），让用户去 Clash 里加分组。
    for (const warning of plan.warnings) {
      line("warn", warning);
      detail(
        "rule 模式下规则把流量导向别的分组,切 GLOBAL 不改变实际出口:\n" +
          "所有 Worker 会共用同一个公网 IP,而这个故障不报任何错。\n" +
          "建议在 Clash 配置里加一个 proxy-group(type: select)并让规则指向它,\n" +
          "然后重跑 setup。配好后务必用 npm run doctor -- --deep 验证隔离。",
      );
    }
    plans.push(plan);
  }

  if (plans.length === 0) {
    process.exitCode = 1;
    return;
  }

  /* ---------- 4. 合并进配置 ---------- */
  heading("4. 合并进配置");

  const merged = mergeControllerImport(config, plans);
  if (!merged.ok) {
    heading("5. 写入");
    line("fail", "合并后的配置未通过校验,已放弃写入");
    detail(merged.reason);
    nextStep("这是 setup 自己的缺陷(它生成了一份非法配置),你的 config.json 未被改动。");
    process.exitCode = 1;
    return;
  }
  const { summary } = merged;
  for (const warning of summary.warnings) nextStep(warning);

  line(
    "pass",
    `内核 +${summary.bridgesAdded} / 更新 ${summary.bridgesUpdated}，` +
      `代理 +${summary.proxiesAdded} / 更新 ${summary.proxiesUpdated}`,
  );
  detail(`Worker 未改动(${merged.next.workers.length} 个)—— 见下方说明。`);

  /* ---------- 5. 写入 ---------- */
  heading("5. 写入");
  const parsed = { data: merged.next };
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
