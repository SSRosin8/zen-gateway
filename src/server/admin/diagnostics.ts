import type { Config } from "../../shared/schema.ts";
import type { DiagnosticLayer, Overview } from "../../shared/contract.ts";
import { diagnoseClash, type LayerResult } from "../../core/proxy/clash/diagnose.ts";
import { diagnoseWorkers } from "../../core/routing/diagnose.ts";
import { judgeFree } from "../../core/models/free.ts";
import type { CatalogSnapshot } from "../../core/models/catalog.ts";
import { safeErrorMessage } from "../../shared/redact.ts";
import { humanAgo } from "../../shared/duration.ts";
import { workerViews, type RuntimeWorkerState } from "./project.ts";

/**
 * 进程内分层诊断，对应 `npm run doctor` 能在服务内完成的那几层；「服务」层是隐含的
 * （能调到这里就说明服务在跑）。Worker 与 Clash 层与 doctor 共用 `diagnoseWorkers` / `diagnoseClash`。
 *
 * 与 doctor 不同，各层独立运行、不在第一个失败处停下：进程内配置恒已加载，各层没有
 * doctor 那种「上一层失败则下一层必然失败」的依赖，后台引导页需要同时看到各层状态。
 */

export type DiagnosticsDeps = {
  readonly config: Config;
  readonly runtime: readonly RuntimeWorkerState[];
  readonly health: Overview["health"];
  readonly statsAvailable: boolean;
  /** 只读重读磁盘上的配置，返回权限问题；抛错说明下次重启会加载失败。不传则跳过。 */
  readonly diskConfigCheck?: () => Promise<readonly string[]>;
  /** 按 `/v1/models` 同一路径取目录（可能发一次上游请求）；不传则目录层跳过。 */
  readonly ensureCatalog?: () => Promise<CatalogSnapshot | null>;
  /** 服务进程自己的环境，查 CA 用。 */
  readonly env: NodeJS.ProcessEnv;
};

function toLayer(id: DiagnosticLayer["id"], title: string, r: LayerResult): DiagnosticLayer {
  return {
    id,
    title,
    status: r.status,
    summary: r.text,
    details: r.detail === undefined ? [] : r.detail.split("\n"),
    ...(r.nextStep !== undefined ? { nextStep: r.nextStep } : {}),
  };
}

/** 单层抛错不能带走整个诊断，报成该层失败。 */
async function guarded(run: () => Promise<LayerResult> | LayerResult): Promise<LayerResult> {
  try {
    return await run();
  } catch (err) {
    return { status: "fail", text: "这一层的检查本身出错了", detail: safeErrorMessage(err) };
  }
}

async function configLayer(deps: DiagnosticsDeps): Promise<LayerResult> {
  const c = deps.config;
  const summary = `Worker ${c.workers.length} 个 · 代理 ${c.proxies.length} 个 · Clash ${c.clash.enabled ? "已启用" : "未启用"}`;
  if (deps.diskConfigCheck === undefined) return { status: "pass", text: "配置已加载", detail: summary };
  let issues: readonly string[];
  try {
    issues = await deps.diskConfigCheck();
  } catch (err) {
    return {
      status: "fail",
      text: "运行中的配置正常，但磁盘上的 config.json 已无法加载",
      detail: safeErrorMessage(err),
      nextStep: "修好 config.json 之前不要重启 —— 重启会加载失败。",
    };
  }
  if (issues.length > 0) {
    return {
      status: "warn",
      text: "配置已加载，但文件权限过松",
      detail: [summary, ...issues].join("\n"),
      nextStep: "chmod 600 data/config.json && chmod 700 data（下次启动也会自动纠正）。",
    };
  }
  return { status: "pass", text: "配置已加载", detail: summary };
}

function storeLayer(deps: DiagnosticsDeps): LayerResult {
  if (!deps.statsAvailable) {
    return {
      status: "warn",
      text: "运行时数据库不可用，统计与亲和持久化本次停用",
      detail: "转发不受影响；启动日志里有具体原因。",
      nextStep: "检查 data/ 的磁盘空间与权限后重启。",
    };
  }
  const failures = deps.health.storeWriteFailures;
  if (failures > 0) {
    return {
      status: "warn",
      text: `统计/亲和持久化累计写失败 ${failures} 次`,
      detail: "转发不受影响，但统计数字不可信（报表可能偏低或全 0）。",
      nextStep: "查 data/ 的磁盘与权限；服务日志里有具体原因。",
    };
  }
  return { status: "pass", text: "统计写入正常（0 次失败）" };
}

async function catalogLayer(deps: DiagnosticsDeps): Promise<LayerResult> {
  const ca = deps.env["NODE_EXTRA_CA_CERTS"];
  const caLine =
    ca === undefined || ca === ""
      ? "服务进程未设置 NODE_EXTRA_CA_CERTS"
      : "服务进程已设置 NODE_EXTRA_CA_CERTS";
  if (deps.ensureCatalog === undefined) {
    return { status: "skip", text: "出口服务不可用，未检查模型目录", detail: caLine };
  }

  const snapshot = await deps.ensureCatalog();
  if (snapshot === null) {
    const missingCa = ca === undefined || ca === "";
    return {
      status: "fail",
      text: "上游模型目录拉不到",
      detail: `${caLine}\n服务日志里有被脱敏的具体原因（形如 fetch failed ← unable to get local issuer certificate）。`,
      nextStep: missingCa
        ? "企业网络下需要带 CA 重启：npm stop && NODE_EXTRA_CA_CERTS=/path/to/ca-bundle.pem npm start"
        : "CA 已设，查出口与网络：服务日志中的「目录拉取」行，或到 Worker 页点「探测在用出口」。",
    };
  }

  const c = deps.config;
  const free = snapshot.entries.filter((e) => judgeFree(e.id, c.models, snapshot).free);
  if (free.length === 0) {
    return {
      status: "fail",
      text: `目录可达（在架 ${snapshot.entries.length} 个）但免费集为空`,
      detail: `freeSuffix = ${JSON.stringify(c.models.freeSuffix)} · extraFreeIds ${c.models.extraFreeIds.length} 条\n${caLine}`,
      nextStep: "免费集 = (后缀命中 ∪ extraFreeIds) ∩ 在架目录 —— 检查模型页的免费规则。",
    };
  }
  return {
    status: "pass",
    text: `模型目录正常：免费 ${free.length} 个 / 在架 ${snapshot.entries.length} 个`,
    detail: [
      `槽位 ${snapshot.slot} · 拉取于 ${humanAgo(Math.max(0, Date.now() - snapshot.fetchedAt))}`,
      caLine,
    ].join("\n"),
  };
}

export async function runDiagnostics(deps: DiagnosticsDeps): Promise<DiagnosticLayer[]> {
  // Worker 就绪态取自调度器，经 `workerViews` 与概览页同一份投影。
  const views = workerViews(deps.config, deps.runtime);
  const [config, clash, catalog] = await Promise.all([
    guarded(() => configLayer(deps)),
    guarded(() => diagnoseClash(deps.config)),
    guarded(() => catalogLayer(deps)),
  ]);
  return [
    toLayer("config", "配置", config),
    toLayer("store", "统计库", await guarded(() => storeLayer(deps))),
    toLayer(
      "workers",
      "Worker",
      await guarded(() => diagnoseWorkers(deps.config.workers, views, "在 Worker 页新建一个，或在 config.json 的 workers 数组里加")),
    ),
    toLayer("clash", "Clash 控制面", clash),
    toLayer("catalog", "模型目录", catalog),
  ];
}
