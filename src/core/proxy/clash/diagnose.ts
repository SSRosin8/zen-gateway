import type { ClashBridge, Config } from "../../../shared/schema.ts";
import { safeErrorMessage } from "../../../shared/redact.ts";
import { probeBridges, selectBridge } from "./select.ts";
import { ClashController, ControllerError } from "./controller.ts";

/**
 * Clash 控制面、混合端口、择优结果与选路规则的分层诊断。`npm run doctor` 第 5 层与
 * `GET /api/diagnostics` 的 clash 层共用（纪律 #4）。只读：不切 selector。
 */

export type LayerResult = {
  status: "pass" | "warn" | "fail" | "skip";
  text: string;
  detail?: string;
  nextStep?: string;
};

/** Controller 是本机 HTTP；3 秒足以区分「没开」与「慢」。 */
const CONTROL_TIMEOUT_MS = 3_000;

/** 第 5 层。只在确有代理需要桥接时才把 Clash 不可用报成失败。 */
export async function diagnoseClash(cfg: Config): Promise<LayerResult> {
  const needsBridge = cfg.proxies.some((p) => p.enabled && !p.direct && p.bridgeable);

  if (!cfg.clash.enabled) {
    if (!needsBridge) {
      return { status: "skip", text: "Clash 未启用,且没有代理需要桥接 —— 跳过" };
    }
    // schema 的 superRefine 已拦这种组合；走到这里说明配置被外部改过，如实报出。
    return {
      status: "fail",
      text: "有代理只能经 Clash 桥接,但 clash.enabled 为 false",
      nextStep: "把 clash.enabled 设为 true,或停用那些只能桥接的代理。",
    };
  }

  const bridges = cfg.clash.bridges.filter((b) => b.enabled);
  if (bridges.length === 0) {
    return {
      status: needsBridge ? "fail" : "warn",
      text: "Clash 已启用但没有启用任何内核",
      nextStep: "npm run setup —— 自动探测本机 Clash Controller 并写进配置。",
    };
  }

  const results: Array<{ bridge: ClashBridge; controller: ClashController; ok: boolean; why: string }> = [];
  for (const bridge of bridges) {
    const controller = new ClashController(bridge, { timeoutMs: CONTROL_TIMEOUT_MS });
    try {
      const v = await controller.version();
      results.push({ bridge, controller, ok: true, why: `${v.isMeta ? "mihomo" : "clash"} ${v.version}` });
    } catch (err) {
      const why =
        err instanceof ControllerError && err.kind === "auth"
          ? `鉴权被拒(${err.status})—— apiSecret 不对`
          : // 绝不回显 apiSecret —— safeErrorMessage 兜住任何含凭证的底层消息。
            safeErrorMessage(err);
      results.push({ bridge, controller, ok: false, why });
    }
  }

  const ok = results.filter((r) => r.ok);
  const lines = results.map((r) => `${r.bridge.id} (${r.bridge.apiBase}): ${r.ok ? "✓ " : "✗ "}${r.why}`);

  if (ok.length === 0) {
    return {
      status: "fail",
      text: "没有一个 Clash 内核可连通",
      detail: lines.join("\n"),
      nextStep:
        "确认 Clash 正在运行且开了 External Controller。\n" +
        "若 apiSecret 不对:从 Clash 的配置或管理界面取得 secret，填进 clash.bridges[].apiSecret。\n" +
        "或跑 npm run setup 重新探测。",
    };
  }

  // 混合端口随内核配置而变；localProxyPort 不一致时桥接会连到没人监听的端口，而控制面仍是通的。
  const mismatches: string[] = [];
  const modes = new Map<string, string | null>();
  for (const r of ok) {
    // 读不到 /configs 时两项都按未知处理：端口不当作不一致，mode 由下方按 rule 兜底。
    const runtime = await r.controller.runtimeConfig().catch(() => ({ mode: null, mixedPort: null }));
    modes.set(r.bridge.id, runtime.mode);
    const actual = runtime.mixedPort;
    if (actual !== null && actual !== r.bridge.localProxyPort) {
      mismatches.push(`${r.bridge.id}: 配置写 ${r.bridge.localProxyPort},内核实际 ${actual}`);
    }
  }

  if (mismatches.length > 0) {
    return {
      status: "fail",
      text: "Clash 控制面可连,但混合端口与配置不一致",
      detail: [...lines, "", ...mismatches].join("\n"),
      nextStep:
        "把 clash.bridges[].localProxyPort 改成内核实际的 mixed-port(上面已给出)。\n" +
        "不改的话桥接会连到一个没人监听的端口:所有桥接代理传输失败,而控制面是通的。",
    };
  }

  // 择优复用 selectBridge（与批量探测第 0 段同一份逻辑，纪律 #4）。转发路径本身不探活，
  // 按 activeBridgeId 取内核，所以这里报的是「探活后应当用谁」。
  const health = await probeBridges(bridges, (bridge) => new ClashController(bridge), {
    redact: safeErrorMessage,
  });
  const selection = selectBridge(cfg.clash, health);

  const healthLines = health.map((h) => {
    const b = bridges.find((x) => x.id === h.bridgeId);
    const name = `${h.bridgeId} (${b?.selectorGroup ?? "?"})`;
    if (!h.alive) return `${name}: ✗ ${h.reason ?? "探活失败"}`;
    if (h.usableNodes === 0) return `${name}: ! 连得上但${h.reason ?? "分组里没有节点"}`;
    return `${name}: ✓ ${h.usableNodes} 个可用节点`;
  });

  if (selection.bridgeId === null) {
    return {
      status: needsBridge ? "fail" : "warn",
      text: `控制面可连，但择优选不出内核：${selection.reason}`,
      detail: [...lines, "", ...healthLines].join("\n"),
      nextStep:
        "检查 clash.bridges[].selectorGroup 是不是内核里真实存在的分组名。\n" +
        "manual 模式下还要确认 clash.activeBridgeId 指向一个已启用的内核。",
    };
  }

  const selectedHealthy = health.find((h) => h.bridgeId === selection.bridgeId);
  const degraded = selectedHealthy?.alive !== true || selectedHealthy.usableNodes === 0;
  const selectedBridge = bridges.find((b) => b.id === selection.bridgeId);
  const routingWarnings =
    selectedBridge === undefined ? [] : await routingWarningsFor(selectedBridge, modes, cfg.gateway.baseUrl);

  return {
    status: degraded || routingWarnings.length > 0 || ok.length < results.length ? "warn" : "pass",
    text: `${ok.length}/${results.length} 个 Clash 内核可连通 · 当前走 ${selection.bridgeId}`,
    detail: [...lines, "", ...healthLines, "", `择优：${selection.reason}`, ...routingWarnings].join("\n"),
    ...(degraded
      ? {
          nextStep:
            "当前选中的内核探活不通过 —— 桥接代理会全部失败。\n" +
            "manual 模式不会自动切换（那是刻意的）；改成 auto 或换一个内核。",
        }
      : {}),
  };
}

/**
 * 选中的分组是否真的参与选路。rule 模式下不出现在任何规则里的分组（如 `GLOBAL`）切了不改变流量，
 * 所有 Worker 共用本机出口，而控制面与探测全都正常。
 */
async function routingWarningsFor(
  bridge: ClashBridge,
  modes: ReadonlyMap<string, string | null>,
  baseUrl: string,
): Promise<string[]> {
  const warnings: string[] = [];
  try {
    const controller = new ClashController(bridge, { timeoutMs: CONTROL_TIMEOUT_MS });
    // 读不到 mode 按内核默认 rule 处理：误判成 rule 最多多一条警告，误判成 global 会漏掉故障。
    const mode = (modes.has(bridge.id) ? modes.get(bridge.id)! : await readMode(controller)) ?? "rule";
    if (mode === "global") return warnings;

    const routed = await controller.routedGroups();
    const group = bridge.selectorGroup;
    if (!routed.targets.has(group)) {
      warnings.push(
        `⚠️ 分组「${group}」**不出现在任何路由规则里** —— rule 模式下切它不会改变任何流量。`,
        `   规则实际导向:${[...routed.targets].map(([k, v]) => `${k}(${v} 条)`).join("、")}` +
          `${routed.fallback === null ? "" : `;兜底(MATCH)→ ${routed.fallback}`}`,
        `   后果:所有 Worker 访问回显目标时共用同一个公网 IP；Zen 实际连接仍需核对。`,
      );
    } else if (routed.fallback !== null && routed.fallback !== group) {
      // 分组承载部分规则但不是兜底：探测与转发的目标 host 可能命中不同分支。
      warnings.push(
        `! 分组「${group}」承载 ${routed.targets.get(group)} 条规则，而兜底(MATCH)指向「${routed.fallback}」。`,
        `   转发到上游与探测打 IP 回显服务可能命中**不同的规则分支** ——`,
        `   --deep 仅测 IP 回显目标；Zen 实际出口需在请求期间核对 /connections 的上游连接、chains 与 rule。`,
      );
    }
    // 上游 host 可能先命中私网 `IPCIDR → DIRECT`（企业 DNS 解析到内网）：Zen 请求全部直连共用出口，
    // 而回显探测打的是另一个域名，报告看起来仍是隔离的。
    const upstreamHost = new URL(baseUrl).hostname;
    const route = await controller.upstreamRoute(upstreamHost);
    if (route.kind === "matched" && route.proxy !== group) {
      warnings.push(
        `⚠️ 上游 ${upstreamHost} 命中第 ${route.index} 条规则 ${route.type},${route.payload} → ${route.proxy}` +
          `${route.ip === null ? "" : `(内核解析为 ${route.ip})`},不经过分组「${group}」。`,
        `   后果:所有 Worker 的 Zen 请求都走 ${route.proxy},共用同一个出口;切换 selector 不改变它。`,
        `   处理:在 Clash 规则最前面加 DOMAIN-SUFFIX,${upstreamHost},${group}` +
          `${route.ip === null ? "" : `,或让内核用公网 DNS 解析该域名`}。`,
      );
    } else if (route.kind === "unknown") {
      warnings.push(
        `! 上游 ${upstreamHost} 在第 ${route.index} 条规则(${route.type})处无法离线判定;` +
          `Zen 实际出口需在请求期间核对 /connections。`,
      );
    }
  } catch {
    // 旧内核没有 /rules：这一项只是加分，不报。
  }
  return warnings;
}

/** 读选路模式；读不到返回 null。选中内核未参与混合端口核对时才需要单独读。 */
async function readMode(controller: ClashController): Promise<string | null> {
  try {
    return (await controller.runtimeConfig()).mode;
  } catch {
    return null;
  }
}
