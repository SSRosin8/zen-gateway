// doctor 第 6–7 层：经服务读模型目录，以及 --deep 下实测回显出口。
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DIRECT_EGRESS_ID } from "../../../src/shared/schema.ts";
import { isUsable, usedProxyIds } from "../../../src/core/routing/workerPool.ts";
import { safeErrorMessage } from "../../../src/shared/redact.ts";
import { humanAgo, humanMs } from "../report.mjs";

/**
 * 第 6 层：上游模型目录。走服务的 `/v1/models` 而不是自己打上游（纪律 #8：服务进程与 doctor 的 CA/代理可能不同）。
 * 502 = 目录从未拉到（上游不可达）；200 + 空 data = 目录拉到了但免费判定全滤掉，靠 `total`/`free` 区分。
 */
export async function layerCatalog(ctx) {
  const token = ctx.config.gateway.relayToken;
  let res;
  try {
    res = await fetch(`${ctx.instance.base}/v1/models`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    return {
      status: "fail",
      text: "无法访问服务的 /v1/models",
      detail: safeErrorMessage(err),
      nextStep: "服务刚才还健康，现在却不应答 —— 看日志：tail -50 " + join(ctx.dataDir, "zen-gateway.log"),
    };
  }

  if (res.status === 401) {
    return {
      status: "fail",
      text: "Relay Token 被拒（401）",
      detail: "doctor 用的是配置里的 gateway.relayToken,而服务不认它。",
      nextStep: "服务在用一份更旧的配置 —— npm run restart 让它重新加载。",
    };
  }

  const body = await res.json().catch(() => null);

  if (res.status === 502) {
    // CA 缺失是已实测成因，优先报；查的必须是服务进程的环境，而不是 doctor 自己的 process.env。
    const serverCa = await serverEnv(ctx.health?.pid, "NODE_EXTRA_CA_CERTS");
    const caHint =
      serverCa === null
        ? "无法读取服务进程的环境变量（非 Linux 或权限不足），请自行确认它启动时带了 NODE_EXTRA_CA_CERTS。"
        : serverCa === undefined
          ? "**服务进程没有设 NODE_EXTRA_CA_CERTS** —— 这是本机已实测过的成因。"
          : `服务进程的 NODE_EXTRA_CA_CERTS = ${serverCa}（已设，那么成因在别处）`;

    return {
      status: "fail",
      text: "上游模型目录拉不到（502）",
      detail: `${caHint}\n服务端日志里有被脱敏的具体原因（形如 fetch failed ← unable to get local issuer certificate）。`,
      nextStep:
        serverCa === undefined
          ? `重启并带上 CA:\n  npm stop && NODE_EXTRA_CA_CERTS=/path/to/your/ca-bundle.pem npm start\n（服务与 curl 可能使用不同信任库，curl 通不代表服务通。）`
          : `查出口与网络：\n  grep 目录拉取 ${join(ctx.dataDir, "zen-gateway.log")} | tail -5\n  npm run doctor -- --deep   # 实测 IP 回显目标的出口`,
    };
  }

  if (!res.ok) {
    return { status: "fail", text: `/v1/models 返回 ${res.status}`, detail: JSON.stringify(body).slice(0, 300) };
  }

  const meta = body?.zen_gateway_catalog;
  const free = Array.isArray(body?.data) ? body.data.length : 0;

  if (free === 0) {
    return {
      status: "fail",
      text: `目录可达（在架 ${meta?.total ?? "?"} 个）但免费集为空`,
      detail:
        `freeSuffix = ${JSON.stringify(ctx.config.models.freeSuffix)} · ` +
        `extraFreeIds = ${JSON.stringify(ctx.config.models.extraFreeIds)}\n` +
        `免费集 = (后缀命中 ∪ extraFreeIds) ∩ 在架目录 —— 三者之一不对就会空。`,
      nextStep:
        "上游把带 -free 后缀的模型全下架了，或 freeSuffix 被改错。\n" +
        "先刷新本机 /v1/models；如需外部对照，请使用配置中 gateway.baseUrl 对应的上游地址，并确认服务进程的 CA、代理和出口环境。",
    };
  }

  return {
    status: "pass",
    text: `模型目录正常：免费 ${free} 个 / 在架 ${meta?.total ?? "?"} 个`,
    detail:
      `槽位 ${meta?.slot ?? "?"} · ${meta?.fresh ? "新鲜" : "已过期（仍可用，后台会刷）"} · ` +
      `拉取于 ${humanAgo(Date.now() - (meta?.fetched_at ?? Date.now()))}\n` +
      `免费模型：${(body.data ?? []).slice(0, 6).map((m) => m.id).join(", ")}${free > 6 ? ` …（共 ${free} 个）` : ""}`,
  };
}

/**
 * 第 7 层（仅 `--deep`）：实测发往 IP 回显目标的公网出口。
 * 回显服务与 Zen 可能命中不同规则，所以本层不证明 Zen 流量隔离。
 * 桥接探测必须切 Clash selector，这是 doctor 唯一的副作用，运行前明确打印出来。
 */
export async function layerEgress(ctx) {
  if (!ctx.deep) {
    return { status: "skip", text: "回显出口实测已跳过（加 --deep 开启；它会发网络请求并切换 Clash 节点）" };
  }

  const { EgressService } = await import("../../../src/core/proxy/egress.ts");
  const { buildIsolationReport } = await import("../../../src/core/proxy/probe.ts");

  const cfg = ctx.config;
  const usable = cfg.workers.filter(isUsable);
  if (usable.length === 0) return { status: "skip", text: "没有可用 Worker,回显出口实测无意义" };

  console.log("      （正在实测 IP 回显目标的出口，可能要几十秒…）");
  console.log("      结果仅反映回显目标；Zen 实际出口需核对发往 opencode.ai 的连接。");
  if (cfg.clash.enabled) {
    console.log("      ⚠️ 桥接探测会切换 Clash selector —— 跑完后选中节点是最后探测的那个。");
  }

  const egress = new EgressService({
    timeouts: {
      headersTimeoutMs: cfg.gateway.headersTimeoutMs,
      bodyTimeoutMs: cfg.gateway.bodyTimeoutMs,
    },
  });

  try {
    const results = await egress.probeAll(cfg, usedProxyIds(cfg));
    const byProxy = new Map(results.map((r) => [r.proxyId, r.outcome]));

    const entries = usable.map((w) => {
      const outcome = byProxy.get(w.proxyId ?? DIRECT_EGRESS_ID);
      return {
        workerId: w.id,
        proxyId: w.proxyId,
        egressIp: outcome?.ok ? outcome.egressIp : null,
      };
    });

    const report = buildIsolationReport(entries);
    const lines = entries.map((e) => {
      const outcome = byProxy.get(e.proxyId ?? DIRECT_EGRESS_ID);
      const where = e.proxyId ?? "(本机直连)";
      return outcome?.ok
        ? `${e.workerId} → ${where}: ${outcome.egressIp} (${humanMs(outcome.latencyMs)}, via ${outcome.via})`
        : `${e.workerId} → ${where}: ✗ ${outcome?.failureKind ?? "?"} —— ${outcome?.reason ?? "未探测"}`;
    });

    if (report.sharedGroups.length > 0) {
      return {
        status: "warn",
        text: "回显出口共用：多个 Worker 访问 IP 回显目标时使用同一个公网 IP",
        detail:
          lines.join("\n") +
          "\n\n共用出口的组：\n" +
          report.sharedGroups.map((g) => `  ${g.egressIp}: ${g.workerIds.join(", ")}`).join("\n"),
        nextStep:
          "核对绑定的代理与回显目标命中的路由规则。\n" +
          "两个不同代理可能 NAT 到同一个公网 IP；Zen 实际出口还需核对其上游连接。",
      };
    }

    if (report.unknownWorkerIds.length > 0) {
      return {
        status: "warn",
        text: `${report.unknownWorkerIds.length} 个 Worker 的出口未能探出`,
        detail: lines.join("\n") + "\n\n尚未测出全部回显出口；这些结果也不证明 Zen 实际出口。",
        nextStep: "看上面失败的原因。桥接失败多半是混合端口不对（见第 5 层）或节点本身不通。",
      };
    }

    return {
      status: "pass",
      text: `回显出口独立：${report.groups.length} 个 Worker 访问 IP 回显目标时使用不同公网 IP`,
      detail: lines.join("\n") + "\n\nZen 实际出口尚未验证；Clash 桥接需在请求期间核对 /connections 的上游连接、chains 与 rule。",
    };
  } finally {
    // 关掉 dispatcher 池,否则 keep-alive 连接会把进程吊住。
    await egress.close().catch(() => {});
  }
}

/**
 * 读服务进程的环境变量。null = 读不到（非 Linux / 权限不足，不能下结论）；
 * undefined = 没设或空串（`NODE_EXTRA_CA_CERTS=` 对 Node 等同未设）；否则为非空值。
 */
async function serverEnv(pid, name) {
  if (pid === undefined) return null;
  try {
    const raw = await readFile(`/proc/${pid}/environ`, "utf8");
    const hit = raw.split("\0").find((e) => e.startsWith(`${name}=`));
    if (hit === undefined) return undefined;
    const value = hit.slice(name.length + 1);
    return value === "" ? undefined : value;
  } catch {
    return null;
  }
}
