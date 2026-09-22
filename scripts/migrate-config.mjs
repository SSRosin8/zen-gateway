#!/usr/bin/env node
/**
 * 把旧项目 opencode-manager 的 data/settings.json 迁成 zen-gateway 的 data/config.json。
 *
 * 硬规则:**任何输出都不回显凭证值**。
 * 这个脚本处理的每一个 apiKey / relayAccessToken / apiSecret / 订阅 URL 都是凭证,
 * 而迁移输出天然会被粘到聊天窗口和 issue 里。所以只报字段名、计数和分类结果。
 *
 * 用法:
 *   node scripts/migrate-config.mjs <旧项目根目录> [--target <目录>] [--force] [--dry-run]
 */

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CONFIG_VERSION, ConfigSchema } from "../src/shared/schema.ts";
import { configExists, generateRelayToken, saveConfig } from "../src/store/config.ts";

const DEFAULT_TARGET = resolve(import.meta.dirname, "..");

/** 收集给用户看的说明；每条都必须是「结构性事实」而非字段值。 */
const notes = [];
const warnings = [];

function usage(code) {
  console.log(`用法: node scripts/migrate-config.mjs <旧项目根目录> [--target <目录>] [--force] [--dry-run]

  <旧项目根目录>  含 data/settings.json 的目录,例如 ../opencode-manager
  --target <目录> 写入哪个 zen-gateway 安装（默认当前项目）
  --force         覆盖已存在的 data/config.json(会先备份)
  --dry-run       只报将要发生什么,不写盘

本脚本不会打印任何凭证值。`);
  process.exit(code);
}

/* ------------------------------------------------------------------ *
 * 逐段转换
 * ------------------------------------------------------------------ */

function migrateWorkers(accounts) {
  if (!Array.isArray(accounts)) return [];
  const out = [];
  let unnamed = 0;

  for (const a of accounts) {
    if (!a || typeof a !== "object") continue;

    const apiKey = typeof a.apiKey === "string" ? a.apiKey : "";
    /*
     * 旧项目用空 apiKey 反推匿名。这里必须复刻那个推断,
     * 否则一个没写 kind 的登录态账号会被迁成匿名 Worker,
     * 然后带着 key 走匿名路径 —— 那是静默的行为改变。
     */
    const kind =
      a.kind === "anonymous_zen"
        ? "anonymous"
        : a.kind === "authenticated_zen"
          ? "authenticated"
          : apiKey.trim()
            ? "authenticated"
            : "anonymous";

    // 旧 schema 允许 id 为空串表示「默认直连账号」,新 schema 要求非空。
    let id = typeof a.id === "string" ? a.id.trim() : "";
    if (id === "") {
      unnamed += 1;
      id = `migrated-${unnamed}`;
    }

    out.push({
      id,
      name: typeof a.name === "string" ? a.name : "",
      kind,
      apiKey,
      enabled: a.enabled !== false,
      proxyId: typeof a.proxyId === "string" && a.proxyId !== "" ? a.proxyId : null,
    });
  }

  if (unnamed > 0) notes.push(`${unnamed} 个 Worker 原本 id 为空串,已改名为 migrated-N`);
  return out;
}

const DIRECT_TYPES = new Set(["http", "https", "socks4", "socks5"]);

function migrateProxies(pool) {
  if (!Array.isArray(pool)) return [];
  const out = [];
  let dropped = 0;

  for (const p of pool) {
    if (!p || typeof p !== "object") continue;

    const type = typeof p.type === "string" ? p.type : "";
    // 旧字段叫 usable,含义就是「能否不经 Clash 直接出口」。
    const direct = typeof p.usable === "boolean" ? p.usable : DIRECT_TYPES.has(type);
    const bridgeable = p.bridgeable === true;

    if (!direct && !bridgeable) {
      // 既不能直连也不能桥接 —— 留着只会让 UI 显示一个永远不可用的节点。
      dropped += 1;
      continue;
    }

    const entry = {
      id: String(p.id ?? ""),
      name: typeof p.name === "string" && p.name !== "" ? p.name : String(p.id ?? "未命名"),
      type: type || "http",
      host: typeof p.host === "string" ? p.host : "",
      port: Number(p.port ?? 0),
      enabled: p.enabled !== false,
      source: ["manual", "subscription", "controller"].includes(p.source) ? p.source : "manual",
      direct,
      bridgeable,
      egressIp: typeof p.egressIp === "string" && p.egressIp !== "" ? p.egressIp : null,
    };

    // 可选字段只在有值时加:strictObject 下 undefined 也算出现过。
    if (typeof p.username === "string" && p.username !== "") entry.username = p.username;
    if (typeof p.password === "string" && p.password !== "") entry.password = p.password;
    if (typeof p.subscriptionId === "string" && p.subscriptionId !== "") {
      entry.subscriptionId = p.subscriptionId;
    }
    if (typeof p.controllerGroup === "string" && p.controllerGroup !== "") {
      entry.controllerGroup = p.controllerGroup;
    }
    if (typeof p.bridgeId === "string" && p.bridgeId !== "") entry.bridgeId = p.bridgeId;
    if (typeof p.clashNodeName === "string" && p.clashNodeName !== "") {
      entry.clashNodeName = p.clashNodeName;
    }
    // 旧 clashType 是纯信息字段,新 schema 不留它。

    out.push(entry);
  }

  if (dropped > 0) notes.push(`${dropped} 个代理既不能直连也不能桥接,已丢弃`);
  return out;
}

function migrateSubscriptions(subs) {
  if (!Array.isArray(subs)) return [];
  return subs
    .filter((s) => s && typeof s === "object" && typeof s.url === "string")
    .map((s) => ({
      id: String(s.id ?? ""),
      name: typeof s.name === "string" && s.name !== "" ? s.name : String(s.id ?? "订阅"),
      url: s.url,
      enabled: s.enabled !== false,
      lastFetchedAt: typeof s.lastFetchedAt === "string" ? s.lastFetchedAt : null,
      /*
       * 旧 lastError 存的是上游原始错误文本,而订阅 URL 常把 token 带在 query 里,
       * 那段文本很可能已经含着 token。不迁移它,让它自然地在下次拉取时重新产生
       * 一个分类值 —— 迁移一段可能含凭证的自由文本不值得。
       */
      lastErrorKind: null,
      lastImportCount: Number(s.lastImportCount ?? 0),
      lastFormat: typeof s.lastFormat === "string" ? s.lastFormat : null,
    }));
}

function migrateClash(bridge) {
  const fallback = { enabled: false, selectionMode: "auto", activeBridgeId: null, bridges: [] };
  if (!bridge || typeof bridge !== "object") return fallback;

  const bridges = Array.isArray(bridge.bridges)
    ? bridge.bridges
        .filter((b) => b && typeof b === "object" && typeof b.apiBase === "string")
        .map((b) => ({
          id: String(b.id ?? ""),
          name: typeof b.name === "string" && b.name !== "" ? b.name : String(b.id ?? "内核"),
          enabled: b.enabled !== false,
          priority: Number(b.priority ?? 100),
          apiBase: b.apiBase,
          apiSecret: typeof b.apiSecret === "string" ? b.apiSecret : "",
          localProxyHost: typeof b.localProxyHost === "string" ? b.localProxyHost : "127.0.0.1",
          localProxyPort: Number(b.localProxyPort ?? 7890),
          selectorGroup: typeof b.selectorGroup === "string" ? b.selectorGroup : "GLOBAL",
        }))
    : [];

  /*
   * 旧结构把「第一个内核」平铺在顶层(apiBase/apiSecret/...),bridges[] 是后加的。
   * 如果 bridges[] 空而顶层有配置,那顶层就是唯一的内核,必须提升成一个条目,
   * 否则迁移后 Clash 配置凭空消失。
   */
  if (bridges.length === 0 && typeof bridge.apiBase === "string" && bridge.apiBase !== "") {
    bridges.push({
      id: "legacy",
      name: "旧配置内核",
      enabled: true,
      priority: 100,
      apiBase: bridge.apiBase,
      apiSecret: typeof bridge.apiSecret === "string" ? bridge.apiSecret : "",
      localProxyHost: typeof bridge.localProxyHost === "string" ? bridge.localProxyHost : "127.0.0.1",
      localProxyPort: Number(bridge.localProxyPort ?? 7890),
      selectorGroup: typeof bridge.selectorGroup === "string" ? bridge.selectorGroup : "GLOBAL",
    });
    notes.push("旧的顶层 Clash 配置已提升为一个名为 legacy 的内核条目");
  }

  const ids = new Set(bridges.map((b) => b.id));
  let activeBridgeId =
    typeof bridge.activeBridgeId === "string" && ids.has(bridge.activeBridgeId)
      ? bridge.activeBridgeId
      : null;
  if (activeBridgeId === null && bridges.length === 1) activeBridgeId = bridges[0].id;

  return {
    enabled: bridge.enabled === true,
    selectionMode: bridge.selectionMode === "manual" ? "manual" : "auto",
    activeBridgeId,
    bridges,
  };
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

function convert(old) {
  const workers = migrateWorkers(old.accounts);
  const proxies = migrateProxies(old.proxyPool);
  const subscriptions = migrateSubscriptions(old.proxySubscriptions);
  const clash = migrateClash(old.clashBridge);

  // 旧项目的 relay token 默认是空串,而新 schema 不允许空(空=本机任何进程都能白用)。
  const oldToken = typeof old.relayAccessToken === "string" ? old.relayAccessToken.trim() : "";
  let relayToken = oldToken;
  if (relayToken.length < 16 || !/^[A-Za-z0-9_-]+$/.test(relayToken)) {
    relayToken = generateRelayToken();
    warnings.push(
      oldToken === ""
        ? "旧配置的 relayAccessToken 为空(等于不设鉴权),已生成新 token —— 客户端配置需同步更新"
        : "旧 relayAccessToken 不满足新格式要求,已生成新 token —— 客户端配置需同步更新",
    );
  }

  // 引用完整性:指向已不存在代理的 Worker 会静默退回直连出口,和别的 Worker 共用公网 IP。
  const proxyIds = new Set(proxies.map((p) => p.id));
  let dangling = 0;
  for (const w of workers) {
    if (w.proxyId !== null && !proxyIds.has(w.proxyId)) {
      w.proxyId = null;
      w.enabled = false; // 宁可让它显式停用,也不要它悄悄共用出口。
      dangling += 1;
    }
  }
  if (dangling > 0) {
    warnings.push(`${dangling} 个 Worker 绑定的代理已不存在,已改为直连并停用(避免共用出口 IP)`);
  }

  // 只能桥接的代理在 clash 关闭时无法使用,schema 会拒绝;显式停用并说明。
  if (!clash.enabled) {
    let bridgeOnly = 0;
    for (const p of proxies) {
      if (!p.direct && p.bridgeable && p.enabled) {
        p.enabled = false;
        bridgeOnly += 1;
      }
    }
    if (bridgeOnly > 0) {
      notes.push(`${bridgeOnly} 个仅可桥接的代理已停用,因为 clash.enabled 为 false`);
    }
  }

  return {
    version: CONFIG_VERSION,
    gateway: {
      port: Number(old.port ?? 9876),
      baseUrl: typeof old.baseUrl === "string" && old.baseUrl !== "" ? old.baseUrl : undefined,
      relayToken,
    },
    routing: {
      strategy: ["anonymous_first", "authenticated_first", "mixed"].includes(old.routingStrategy)
        ? old.routingStrategy
        : "anonymous_first",
    },
    models: {
      // 旧代码把 big-pickle 与 union-alpha 硬编码为特例免费模型。
      // union-alpha 已从 Zen 目录消失,不再带过来 —— 这正是改成配置驱动的理由。
      extraFreeIds: ["big-pickle"],
    },
    workers,
    proxies,
    subscriptions,
    clash,
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) usage(0);

  const force = args.includes("--force");
  const dryRun = args.includes("--dry-run");

  const targetAt = args.indexOf("--target");
  if (targetAt !== -1 && !args[targetAt + 1]) usage(2);
  const newRoot = targetAt === -1 ? DEFAULT_TARGET : resolve(args[targetAt + 1]);

  // 按下标排除 --target 的值，而不是按字符串值：
  // 按值排除时，`<路径> --target <同一路径>` 会把位置参数也一起滤掉。
  const consumed = targetAt === -1 ? new Set() : new Set([targetAt, targetAt + 1]);
  const oldRoot = args.find((a, i) => !consumed.has(i) && !a.startsWith("--"));
  if (!oldRoot) usage(2);

  const source = join(resolve(oldRoot), "data", "settings.json");

  let old;
  try {
    // 绝不打印这段内容:整个文件都是凭证。
    old = JSON.parse(await readFile(source, "utf8"));
  } catch (err) {
    const code = err?.code;
    if (code === "ENOENT") {
      console.error(`找不到 ${source}`);
    } else if (code === "EACCES") {
      console.error(`无权读取 ${source}`);
    } else {
      // 不转发 JSON.parse 的原始消息:它会带出错位置附近的原文片段。
      console.error(`${source} 无法解析为 JSON`);
    }
    process.exit(1);
  }

  if (old === null || typeof old !== "object" || Array.isArray(old)) {
    console.error(`${source} 的顶层必须是对象`);
    process.exit(1);
  }

  const candidate = convert(old);

  const parsed = ConfigSchema.safeParse(candidate);
  if (!parsed.success) {
    console.error("迁移结果未通过新 schema 校验:");
    // 只输出路径与我们自己写的规则文案,不含字段值。
    for (const issue of parsed.error.issues.slice(0, 20)) {
      console.error(`  ${issue.path.map(String).join(".") || "(根)"}: ${issue.message}`);
    }
    process.exit(1);
  }
  const config = parsed.data;

  // 计数是安全的输出;值不是。
  console.log("迁移摘要:");
  console.log(`  Worker    ${config.workers.length}(启用 ${config.workers.filter((w) => w.enabled).length}）`);
  console.log(`  代理      ${config.proxies.length}（启用 ${config.proxies.filter((p) => p.enabled).length}）`);
  console.log(`  订阅      ${config.subscriptions.length}`);
  console.log(`  Clash 内核 ${config.clash.bridges.length}（enabled=${config.clash.enabled}）`);

  for (const n of notes) console.log(`  · ${n}`);
  for (const w of warnings) console.log(`  ⚠ ${w}`);

  if (dryRun) {
    console.log("\n--dry-run:未写盘。");
    return;
  }

  if ((await configExists(newRoot)) && !force) {
    console.error("\ndata/config.json 已存在。加 --force 覆盖（会先备份）。");
    process.exit(1);
  }

  if (await configExists(newRoot)) {
    const { chmod, copyFile } = await import("node:fs/promises");
    const backup = join(newRoot, "data", `config.json.bak.${Date.now()}`);
    await copyFile(join(newRoot, "data", "config.json"), backup);
    // 备份同样是凭证文件,继承 0600。
    await chmod(backup, 0o600);
    console.log(`\n已备份原配置到 data/${backup.split("/").pop()}`);
  }

  await saveConfig(config, newRoot);
  console.log("已写入 data/config.json（0600）");
  if (warnings.length > 0) {
    console.log("\n注意上面的 ⚠ 项:relay token 变了的话,OpenCode 侧的配置要同步改。");
  }
}

await main();
