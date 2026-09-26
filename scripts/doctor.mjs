#!/usr/bin/env node
/**
 * 分层诊断：层按依赖顺序排列，只报第一个失败的层（同一根因的下游症状不重复报）。
 * `warn` 不阻断后续层，`fail` 阻断。各层实现见 `lib/doctor/`。
 *
 * 只读：不建配置、不跑迁移、不改权限；仅 `--deep` 会为回显探测切换 Clash selector。
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { resolvePort } from "../src/store/port.ts";
import { safeErrorMessage } from "../src/shared/redact.ts";
import { createInstance, dataDirOf } from "./lib/instance.mjs";
import { detail, heading, line, nextStep } from "./lib/report.mjs";
import { checkArgs } from "./lib/args.mjs";
import { layerConfig, layerService, layerStore, layerWorkers } from "./lib/doctor/local.mjs";
import { layerClashControl } from "./lib/doctor/clash.mjs";
import { layerCatalog, layerEgress } from "./lib/doctor/upstream.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = dataDirOf(ROOT);
const ENTRY = join(ROOT, "dist", "server", "server", "index.js");

// 与 setup 共用一份参数校验（纪律 #4）。
checkArgs({
  command: "npm run doctor",
  summary: "zen-gateway 分层诊断：只报第一个失败的层 + 下一步建议。",
  flags: [{ flag: "--deep", help: "额外实测 IP 回显目标的出口（会发请求并切 Clash 节点，不证明 Zen 实际出口）" }],
});

// 端口来自 store/port.ts：与服务是否在跑无关，也不照抄默认值（否则可能问到同机另一个进程）。
let PORT;
try {
  PORT = resolvePort(process.env.ZG_DATA_DIR ? undefined : ROOT);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

// altEntries 让 `npm run dev:server` 启动的实例也被认作本项目。
const instance = createInstance({
  dataDir: DATA_DIR,
  port: PORT,
  entry: ENTRY,
  altEntries: [join(ROOT, "src", "server", "index.ts")],
});

// 各层共享同一份上下文：重新取一遍会让两层看到不同状态，输出互相矛盾。
const ctx = {
  root: ROOT,
  dataDir: DATA_DIR,
  port: PORT,
  instance,
  deep: process.argv.includes("--deep"),
  config: null,
  health: null,
  state: null,
};

const LAYERS = [
  ["配置", layerConfig],
  ["服务", layerService],
  ["统计库", layerStore],
  ["Worker", layerWorkers],
  ["Clash 控制面", layerClashControl],
  ["模型目录", layerCatalog],
  ["回显出口实测", layerEgress],
];

async function main() {
  console.log(`zen-gateway 诊断 — ${new Date().toISOString().slice(0, 16).replace("T", " ")}`);
  console.log(`端口 ${PORT} · data/ ${DATA_DIR}`);

  let failedAt = null;
  const warnings = [];

  for (const [index, [name, fn]] of LAYERS.entries()) {
    heading(`${index + 1}. ${name}`);

    // 单层抛错不能带走整个 doctor，前面已通过的层仍要可见。
    let result;
    try {
      result = await fn(ctx);
    } catch (err) {
      result = {
        status: "fail",
        text: `这一层的检查本身出错了`,
        detail: safeErrorMessage(err),
        nextStep: "这是 doctor 自己的缺陷,不是你的配置问题。",
      };
    }

    line(result.status, result.text);
    if (result.detail !== undefined) detail(result.detail);

    if (result.status === "fail") {
      if (result.nextStep !== undefined) nextStep(result.nextStep);
      failedAt = { index: index + 1, name };
      const skipped = LAYERS.slice(index + 1);
      if (skipped.length > 0) {
        console.log(`\n  后续 ${skipped.length} 层未检查(${skipped.map(([n]) => n).join(" / ")})——`);
        console.log(`  它们都依赖这一层,先修上面那条。`);
      }
      break;
    }
    if (result.status === "warn") warnings.push(`${index + 1}. ${name}:${result.text}`);
  }

  console.log("\n────────────────────────");
  if (failedAt !== null) {
    console.log(`第 ${failedAt.index} 层(${failedAt.name})未通过。`);
    process.exitCode = 1;
    return;
  }
  if (warnings.length > 0) {
    console.log(`全部层可用,但有 ${warnings.length} 条告警:`);
    for (const w of warnings) console.log(`  ! ${w}`);
    // 告警不影响退出码：「能用但不理想」返回非 0 会让 `npm run doctor && …` 在可用系统上失败。
    return;
  }
  console.log("已执行的诊断检查全部通过；不代表每个模型可调用或 Zen 实际出口已隔离。");
  if (!ctx.deep) console.log("回显出口未实测 —— 可运行:npm run doctor -- --deep；Zen 实际出口仍需单独核对。");
}

await main();
