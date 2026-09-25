#!/usr/bin/env node
/**
 * 分层诊断。
 *
 * ## 为什么要分层,而不是把所有检查平铺一遍
 *
 * 平铺的输出会同时报出「上游不可达」「Worker 不就绪」「目录为空」三条,
 * 而它们其实是**同一个根因的三个症状**(Clash 没开)。用户于是三条都去查,
 * 两条是白费的。分层的价值就是**只报第一个失败的层** —— 后面的层在它
 * 修好之前无法给出有意义的答案。
 *
 * 所以这里的层是**依赖顺序**,不是重要性顺序:
 *
 *   1. 配置可加载          ← 一切的前提
 *   2. 服务在跑且是我们的   ← 后面所有层都要问它
 *   3. 统计库写入正常      ← 报表数字可不可信
 *   4. Worker 配置可用      ← 转发的必要条件
 *   5. Clash 控制面        ← 桥接出口的必要条件
 *   6. 上游目录            ← 免费判定的依据
 *   7. 出口实测(--deep)   ← 要真发网络请求,默认不跑
 *
 * `warn` 不阻断后面的层(它表示「能用但有问题」),`fail` 阻断。
 *
 * ## 为什么目录那一层**问服务**,而不是自己去打上游
 *
 * 这是第七轮审核那条纪律(#8)的直接应用:**验证工具必须与产品代码共享
 * 同一套信任/配置**。本机 `opencode.ai` 被企业 CA 中间人,而 Node 不读系统
 * CA 库 —— 于是 `curl` 通而 `node` 不通。若 doctor 自己 fetch 上游,它拿到的
 * 结果反映的是 **doctor 进程**的 CA 环境,而真正要诊断的是**服务进程**的。
 * 两者可以不同(服务由 `npm start` 启动时带了 `NODE_EXTRA_CA_CERTS`,
 * 而用户手敲 `npm run doctor` 时没带),那样 doctor 会给出一个与现实相反的结论。
 *
 * 所以第 6 层走 `GET /v1/models`(经服务),并额外核对服务进程自己的
 * `NODE_EXTRA_CA_CERTS` —— 见那一层的说明。
 *
 * ## 只读
 *
 * doctor 绝不写任何东西:不建配置(缺配置就报缺)、不跑迁移
 * (库以 `readOnly` 打开)、不改权限、不切 selector。一个会改状态的诊断工具
 * 会让「跑一下 doctor 看看」本身变成一次变更。
 */

import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { resolvePort } from "../src/store/port.ts";
import { configExists, loadConfig, ConfigError } from "../src/store/config.ts";
import { HealthSchema } from "../src/shared/contract.ts";
import { isUsable } from "../src/core/routing/workerPool.ts";
import { safeErrorMessage } from "../src/shared/redact.ts";
import { probeBridges, selectBridge } from "../src/core/proxy/clash/select.ts";
import { ClashController } from "../src/core/proxy/clash/controller.ts";
import { createInstance, dataDirOf } from "./lib/instance.mjs";
import { detail, heading, humanMs, line, nextStep } from "./lib/report.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = dataDirOf(ROOT);
const ENTRY = join(ROOT, "dist", "server", "server", "index.js");
const DEEP = process.argv.includes("--deep");

/*
 * 端口解析复用 `src/store/port.ts` —— 与 service.mjs、vite.config.ts 同一处。
 *
 * 规划特别标注过这一条:先前这里写的诊断命令是从 `npm run status` 的输出里
 * grep 端口,而**服务没在跑时它只打印「未在运行」**,grep 拿不到数字、
 * curl 拼出畸形 URL。`resolvePort()` 与服务是否在跑无关,所以它才是该用的。
 * 更要紧的是:本机 9876 曾被旧项目占着而本网关是 9877,照抄默认值会拿到
 * **另一个进程**的 `{"ok":true}`,于是第 2 层「通过」而实际问的是别人。
 */
let PORT;
try {
  PORT = resolvePort(process.env.ZG_DATA_DIR ? undefined : ROOT);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

/**
 * 认得出全部启动方式。
 *
 * `npm start` 跑构建产物,`npm run dev:server` 跑 `src/server/index.ts` ——
 * 后者**没有状态文件**,若只认前者,doctor 会把用户自己刚启的开发服务器
 * 报成「端口被陌生进程占用」,并让他去 `ss -ltnp` 查一件他本来就知道的事。
 */
const instance = createInstance({
  dataDir: DATA_DIR,
  port: PORT,
  entry: ENTRY,
  altEntries: [join(ROOT, "src", "server", "index.ts")],
});

/**
 * 逐层收集的上下文。
 *
 * 后面的层要用前面的层已经拿到的东西(配置、health、token),而重新取一遍
 * 会让两层看到不同的状态 —— 诊断输出里两个互相矛盾的数字最没用。
 */
const ctx = { config: null, health: null, state: null };

/* ------------------------------------------------------------------ *
 * 各层
 * ------------------------------------------------------------------ */

/** 第 1 层:配置可加载。 */
async function layerConfig() {
  /*
   * 先问「文件在不在」,**不直接 loadConfig**。
   *
   * `loadConfig` 在文件不存在时会**生成一份默认配置并写盘**(含新 Relay Token)
   * —— 那对服务端是对的(首启),对诊断工具是错的:跑一次 doctor 就把状态改了,
   * 而用户只想知道现状。
   */
  if (!(await configExists(process.env.ZG_DATA_DIR ? undefined : ROOT))) {
    return {
      status: "fail",
      text: "配置不存在",
      nextStep: `npm start —— 首次启动会自动生成默认配置与 Relay Token。\n（doctor 刻意不替你生成:那会改变状态。）`,
    };
  }

  try {
    /*
     * `readOnly: true` —— doctor 不改权限。
     *
     * 默认路径会把 `config.json` chmod 到 0600、`data/` 到 0700。那对服务是对的
     * （凭证不该赌一句警告会被看见），但对诊断工具是错的:它把该**报告**的问题
     * 悄悄修掉了,于是「权限过松」这一项永远报不出来 —— 而且「跑一下 doctor
     * 看看」本身成了一次变更。第八轮审核实测:755/644 跑完变 700/600。
     */
    const { config, permissionIssues } = await loadConfig(
      process.env.ZG_DATA_DIR ? undefined : ROOT,
      { readOnly: true },
    );
    ctx.config = config;
    const summary = `端口 ${config.gateway.port} · Worker ${config.workers.length} 个 · 代理 ${config.proxies.length} 个 · Clash ${config.clash.enabled ? "已启用" : "未启用"}`;

    if (permissionIssues.length > 0) {
      /*
       * 权限过松是**真实问题**而不是提示:`data/` 可读意味着同机其他用户
       * 能读到 runtime.db 与日志,而 config.json 整个文件都是凭证。
       * 但它不阻断后面的层 —— 服务照样能跑,用户需要看到完整诊断。
       */
      return {
        status: "warn",
        text: "配置可加载，但权限过松",
        detail: `${summary}\n${permissionIssues.join("\n")}`,
        nextStep: `chmod 600 ${join(DATA_DIR, "config.json")} && chmod 700 ${DATA_DIR}\n（下次 npm start 也会自动纠正 —— doctor 刻意只报不改。）`,
      };
    }

    return { status: "pass", text: "配置可加载", detail: summary };
  } catch (err) {
    if (err instanceof ConfigError) {
      /*
       * `kind` 是为 doctor 准备的稳定分类(见 `ConfigError` 的注释),
       * 四种的下一步完全不同 —— 这正是分类存在的理由。
       */
      const advice = {
        unreadable: `检查文件是否损坏或磁盘是否可读:${join(DATA_DIR, "config.json")}`,
        malformed: `修正 JSON 语法。报错里给了大致字节位置,用编辑器跳过去看。`,
        invalid: `按上面的字段路径逐条修正。路径形如 workers.0.proxyId,指的是第 1 个 Worker。`,
        permission: `chmod 600 ${join(DATA_DIR, "config.json")}`,
      }[err.kind];
      return { status: "fail", text: `配置无法加载(${err.kind})`, detail: err.message, nextStep: advice };
    }
    return { status: "fail", text: "配置无法加载", detail: safeErrorMessage(err) };
  }
}

/**
 * 第 2 层:端口上那个进程是我们的服务,且健康。
 *
 * 身份判定走 `lib/instance.mjs` —— 与 `service.mjs` **同一份实现**。
 * 两份手写的判断会让 doctor 说「服务正常」而 `npm stop` 说「无法确认身份」,
 * 两句互相矛盾的话都出自本项目。
 */
async function layerService() {
  const st = await instance.inspect();
  ctx.state = st;

  if (st.foreignOnPort) {
    /*
     * 先分清「陌生进程」与「本项目但非 npm start 启动」。
     *
     * 后者最典型的形态是 `npm run dev:server`(它不写状态文件),而把它报成
     * 「端口被另一个进程占用」会让用户去查一个他自己刚启动的东西 ——
     * 一条指向错误方向的症状,比不报更糟。
     *
     * 这一态**不阻断**后面的层:那个进程确实是本项目的服务,统计库、Worker、
     * 目录都能正常问它。只是 `npm stop` 管不到它(没有状态文件作依据),
     * 所以降为 warn 并说清这一点。
     */
    if (st.unregisteredOurs) {
      ctx.health = HealthSchema.parse(st.health);
      return {
        status: "warn",
        text: `服务运行中(pid ${st.health.pid}),但不是 npm start 启动的`,
        detail:
          `跑的是本项目的代码(cmdline 已核对),没有状态文件 —— 典型是 npm run dev:server。\n` +
          `v${ctx.health.version} · 已运行 ${humanMs(ctx.health.uptimeSeconds * 1000)} · ${instance.base}\n` +
          `注意 npm stop / npm run status 管不到它(它们只认状态文件),要停就用 kill ${st.health.pid}。`,
      };
    }
    return {
      status: "fail",
      text: `端口 ${PORT} 被另一个进程占用(pid ${st.health.pid})`,
      detail: "它能应答 /health,但既不是本脚本启动的实例,cmdline 也不像本项目。",
      nextStep: `先停掉它,或把 gateway.port 改成一个空闲端口。\n查证:ss -ltnp | grep ${PORT}`,
    };
  }

  if (!st.healthy) {
    if (st.alive && st.identity === "ours") {
      return {
        status: "fail",
        text: `服务进程(pid ${st.state.pid})存活但健康检查未通过`,
        nextStep: `看日志:tail -50 ${join(DATA_DIR, "zen-gateway.log")}\n或重启:npm run restart`,
      };
    }
    if (st.alive) {
      return {
        status: "fail",
        text: `状态文件记录的 pid ${st.state.pid} 存活,但无法确认是本服务`,
        nextStep: `手工确认:ps -p ${st.state.pid} -o pid,cmd`,
      };
    }
    return {
      status: "fail",
      text: "服务未在运行",
      nextStep: `npm start\n（企业网络下需要 NODE_EXTRA_CA_CERTS,见 docs/usage.md —— 否则服务起得来但模型目录是空的。）`,
    };
  }

  /*
   * 过一遍完整契约,而不是只看 `ok === true`。
   *
   * `instance.mjs` 里已经做了结构检查(ok/pid/version),但它刻意不 import zod
   * —— 那会把 `npm run status` 的启动时间翻倍。doctor 允许慢,所以在这里补上
   * **契约级**校验:一个字段类型漂了的服务(比如 admin 与 server 版本不一致)
   * 应当在这里被指出来,而不是等 admin 在浏览器里 parse 失败。
   */
  const parsed = HealthSchema.safeParse(st.health);
  if (!parsed.success) {
    return {
      status: "fail",
      text: "服务应答了 /health,但响应不符合 HealthSchema",
      detail: parsed.error.issues.map((i) => `${i.path.join(".") || "(根)"}: ${i.message}`).join("\n"),
      nextStep: "服务端与本脚本版本不一致 —— npm run build 后重启。",
    };
  }
  ctx.health = parsed.data;

  return {
    status: "pass",
    text: `服务运行中(pid ${ctx.health.pid})`,
    detail: `v${ctx.health.version} · 已运行 ${humanMs(ctx.health.uptimeSeconds * 1000)} · ${instance.base}`,
  };
}

/**
 * 第 3 层:统计与亲和持久化的写入正常。
 *
 * 这一层报的是 `/health` 的 `storeWriteFailures` —— 两个 store 的累计写失败。
 * 它们**吞掉**写异常(诊断设施不该让转发失败),但吞掉不等于可以不知道:
 * 一个一直写失败的库会安静地给出**全 0 报表**,而那看起来像「没人用」。
 *
 * `warn` 而不是 `fail`:转发完全不受影响,后面的层照样有意义。
 */
async function layerStore() {
  const failures = ctx.health.storeWriteFailures;
  if (failures > 0) {
    return {
      status: "warn",
      text: `统计/亲和持久化累计写失败 ${failures} 次`,
      detail: "转发不受影响,但统计数字不可信(报表可能偏低或全 0)。",
      nextStep: `查磁盘与权限:df -h ${DATA_DIR} && ls -l ${join(DATA_DIR, "runtime.db")}\n日志里有具体原因:grep -i 'runtime\\|统计' ${join(DATA_DIR, "zen-gateway.log")}`,
    };
  }

  /*
   * 顺带报库的档位。以 **readOnly** 打开 —— doctor 绝不跑迁移。
   *
   * 普通 `openDb()` 会执行 `migrate()`,于是「跑一下 doctor 看看」会把一个
   * 旧档位的库升级掉,而那是不可逆的。实测 readOnly 下写操作被正确拒绝
   * (`attempt to write a readonly database`)。
   *
   * 服务正持有这个库(WAL 模式),并发只读是安全的。
   */
  const dbFile = join(DATA_DIR, "runtime.db");
  let dbInfo = "统计库未创建(转发不受影响)";
  try {
    const db = new DatabaseSync(dbFile, { readOnly: true });
    try {
      const version = db.prepare("PRAGMA user_version").get().user_version;
      const attempts = db.prepare("SELECT COUNT(*) AS n FROM upstream_attempts").get().n;
      const rejections = db.prepare("SELECT COALESCE(SUM(count),0) AS n FROM gateway_rejections").get().n;
      dbInfo = `档位 ${version} · 上游尝试 ${attempts} 条 · 网关拒绝 ${rejections} 次`;
    } finally {
      db.close();
    }
  } catch (err) {
    // 库不存在或打不开 —— 不是失败(`index.ts` 刻意让它不阻止启动)。
    dbInfo = `统计库不可读(转发不受影响):${safeErrorMessage(err)}`;
  }

  return { status: "pass", text: "统计写入正常(0 次失败)", detail: dbInfo };
}

/**
 * 第 4 层:至少有一个可用的 Worker。
 *
 * 判定用 `isUsable()` —— **调度器用的同一个函数**,不在这里另写一份
 * 「enabled 且 apiKey 非空」。两份并行判断必然分叉,而分叉后 doctor 会说
 * 「Worker 就绪」而调度器说「无可用 Worker」。
 *
 * 注意它按**有没有 key**判断而不按 `kind`:上游已于 2026-09-16 前后关闭
 * 免 key 的免费通道,所以一个空 key 的 Worker 发出去必定 403。
 */
async function layerWorkers() {
  const workers = ctx.config.workers;
  const usable = workers.filter(isUsable);

  if (workers.length === 0) {
    return {
      status: "fail",
      text: "没有配置任何 Worker",
      nextStep: `在 ${join(DATA_DIR, "config.json")} 的 workers 数组里加一个:\n  { "id": "w1", "kind": "authenticated", "apiKey": "<你的 Zen key>", "proxyId": null }\n（免 key 的匿名通道已被上游关闭,必须用真实 key。）`,
    };
  }

  if (usable.length === 0) {
    return {
      status: "fail",
      text: `${workers.length} 个 Worker 全部不可用(已停用或 apiKey 为空)`,
      detail: workers
        .map((w) => `${w.id}: ${!w.enabled ? "已停用" : "apiKey 为空"}`)
        .join("\n"),
      nextStep: "把 enabled 改为 true,并确认 apiKey 非空。",
    };
  }

  const bound = usable.filter((w) => w.proxyId !== null).length;
  const shape = `其中 ${bound} 个绑定了出口代理,${usable.length - bound} 个走本机直连。`;

  /*
   * 运行期就绪态 —— **问服务，不自己算**（缺口 #24）。
   *
   * 这一层先前只报配置形态，并在输出里写着「是否就绪 doctor 查不到」。
   * Phase 9 之后那句话不再成立：`GET /api/overview` 带 `ready` 与
   * `cooldownRemainingMs`，而 doctor 本来就已经在问服务（第 6 层查 /v1/models）。
   *
   * **关键是"问"而不是"算"**：在 doctor 里重新实现一遍冷却判定会是第二份
   * 并行真相（纪律 #4），且必然与调度器分叉 —— 那时 doctor 说「就绪」而
   * 转发说「在冷却」，两句话都出自本项目。
   *
   * 拿不到就退回只报形态（服务可能刚好在重启，或 `/api/overview` 因某个
   * 原因不可用）—— **降级而不是失败**：配置形态本身仍然是有效信息。
   */
  const runtime = await workerRuntime();

  if (runtime === null) {
    return {
      status: usable.length < workers.length ? "warn" : "pass",
      text: `${usable.length}/${workers.length} 个 Worker 可用(仅配置形态)`,
      detail:
        `${shape}\n` +
        `⚠️ 没能从 /api/overview 拿到运行期状态,所以「是否就绪(不在冷却中)」这一项未检查。\n` +
        `   doctor 刻意不自己算一遍冷却:那会是第二份并行真相,且必然与调度器分叉。`,
    };
  }

  const ready = runtime.filter((w) => w.ready);
  const cooling = runtime.filter((w) => w.inPool && !w.ready);
  const coolingLines = cooling.map(
    (w) =>
      `   ${w.id}: 冷却中 ${humanMs(w.cooldownRemainingMs)}` +
      `${w.lastFailure === null ? "" : `(${w.lastFailure})`}` +
      `${w.consecutiveFails > 0 ? ` · 连续失败 ${w.consecutiveFails} 次` : ""}`,
  );

  /*
   * 全员冷却是 fail 而不是 warn：此刻任何请求都会被 `all_cooling` 分支
   * 送到「最早恢复的那个」，也就是转发在这一刻是不可用的。
   * 部分冷却是 warn —— 池子还能工作。
   */
  const status =
    ready.length === 0 && runtime.some((w) => w.inPool)
      ? "fail"
      : cooling.length > 0 || usable.length < workers.length
        ? "warn"
        : "pass";

  return {
    status,
    text: `${ready.length}/${usable.length} 个 Worker 就绪(共配置 ${workers.length} 个)`,
    detail: [shape, ...coolingLines].join("\n"),
    ...(ready.length === 0 && runtime.some((w) => w.inPool)
      ? {
          nextStep:
            "全部 Worker 都在冷却 —— 此刻转发会打到最早恢复的那个。\n" +
            "若冷却类别是 auth,那是 key 配错了(固定 60 秒短退避,会反复暴露);\n" +
            "若是 rate_limit,那是上游限流,等它过去。",
        }
      : {}),
  };
}

/**
 * 从 `/api/overview` 取 Worker 的运行期状态。
 *
 * 返回 null 表示"拿不到" —— 调用方据此降级成只报配置形态。
 * **不在这里解释失败原因**：第 2 层已经确认服务健康，所以走到这里失败
 * 是个边角情况（刚好在重启），不值得多一层诊断输出。
 */
async function workerRuntime() {
  try {
    const res = await fetch(`${instance.base}/api/overview`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const body = await res.json();
    const workers = body?.workers;
    if (!Array.isArray(workers)) return null;
    return workers.map((w) => ({
      id: typeof w?.id === "string" ? w.id : "?",
      inPool: w?.inPool === true,
      ready: w?.ready === true,
      cooldownRemainingMs: typeof w?.cooldownRemainingMs === "number" ? w.cooldownRemainingMs : 0,
      consecutiveFails: typeof w?.consecutiveFails === "number" ? w.consecutiveFails : 0,
      lastFailure: typeof w?.lastFailure === "string" ? w.lastFailure : null,
    }));
  } catch {
    return null;
  }
}

/**
 * 第 5 层:Clash 控制面。
 *
 * 只在**确有桥接代理要用**时才检查 —— 全部代理都是直连时,Clash 没开完全正常,
 * 报一个失败会让用户去修一件不需要修的事。
 */
async function layerClashControl() {
  const cfg = ctx.config;
  const needsBridge = cfg.proxies.some((p) => p.enabled && !p.direct && p.bridgeable);

  if (!cfg.clash.enabled) {
    if (!needsBridge) {
      return { status: "skip", text: "Clash 未启用,且没有代理需要桥接 —— 跳过" };
    }
    /*
     * 这条其实 schema 已经拦住了(`superRefine` 里那条「只能桥接的代理,
     * 在 Clash 关闭时用不了」),所以走到这里意味着配置是从别处改的。
     * 留着:doctor 的价值之一就是把「不该发生」的状态如实报出来。
     */
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

  const results = [];
  for (const bridge of bridges) {
    try {
      const res = await fetch(new URL("version", ensureSlash(bridge.apiBase)).href, {
        ...(bridge.apiSecret === "" ? {} : { headers: { authorization: `Bearer ${bridge.apiSecret}` } }),
        signal: AbortSignal.timeout(3000),
      });
      if (res.status === 401 || res.status === 403) {
        results.push({ bridge, ok: false, why: `鉴权被拒(${res.status})—— apiSecret 不对` });
        continue;
      }
      if (!res.ok) {
        results.push({ bridge, ok: false, why: `返回 ${res.status}` });
        continue;
      }
      const body = await res.json();
      results.push({ bridge, ok: true, why: `${body?.meta === true ? "mihomo" : "clash"} ${body?.version ?? "?"}` });
    } catch (err) {
      // 绝不回显 apiSecret —— safeErrorMessage 兜住任何含凭证的底层消息。
      results.push({ bridge, ok: false, why: safeErrorMessage(err) });
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
        "若 apiSecret 不对:从 Clash 的配置里取 secret 填进 clash.bridges[].apiSecret。\n" +
        "或跑 npm run setup 重新探测。",
    };
  }

  /*
   * 顺带核对**混合端口**。
   *
   * 这是规划特别标注的一条:本机的混合端口**不是**文档默认的 7890,
   * 且实测值随内核而变(0dcloud 是 17891,Clash Verge 是 7897)。
   * 配置里的 `localProxyPort` 若与内核实际监听的 `mixed-port` 不一致,
   * 桥接会静默连到一个**没人监听的端口** —— 症状是所有桥接代理都传输失败,
   * 而控制面明明是通的。这一层是唯一能发现它的地方。
   */
  const mismatches = [];
  for (const r of ok) {
    const actual = await readMixedPort(r.bridge);
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

  /*
   * 报**择优结果**，而不只是"几个能连"（Phase 10）。
   *
   * 判据复用 `core/proxy/clash/select.ts` 的 `selectBridge` —— 与转发路径
   * 同一份逻辑。doctor 自己再实现一遍会是第三份并行真相（纪律 #4），
   * 而分叉的症状最难查：doctor 说"内核 A 可用"而网关实际在用 B。
   *
   * 这一层也顺带回答了一个此前答不上来的问题：多内核时"现在到底走哪个"。
   */
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

  return {
    status: degraded || ok.length < results.length ? "warn" : "pass",
    text: `${ok.length}/${results.length} 个 Clash 内核可连通 · 当前走 ${selection.bridgeId}`,
    detail: [...lines, "", ...healthLines, "", `择优：${selection.reason}`].join("\n"),
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
 * 第 6 层:上游模型目录。
 *
 * ## 这一层有三种结局,而规划原先只识别出两种
 *
 * | 结局 | HTTP | 含义 | 下一步 |
 * |---|---|---|---|
 * | 拉不到目录 | **502** | 上游不可达(网络/CA/出口) | 设 `NODE_EXTRA_CA_CERTS` 或查出口 |
 * | 拿到目录但免费集为空 | **200 + `data:[]`** | 目录通,而免费判定把它全滤掉了 | 查 `freeSuffix` / `extraFreeIds` |
 * | 正常 | 200 + 非空 | — | — |
 *
 * **实测纠正了规划的一处说法**:`docs/architecture.md` 缺口 #21 写的是
 * 「目录拉空与上游不可达在外部看起来一样,两者都让 `/v1/models` 返回
 * `data: []` 加 HTTP 200」—— 那不成立。`models.ts` 在从未成功拉到目录时
 * 返回的是 **502 `upstream_unreachable`**(它的注释写明了理由:空列表会让
 * OpenCode 显示「没有可用模型」,而那与「网关拿不到目录」是两件事)。
 *
 * 真正会给出 `200 + data:[]` 的是**第二种**:目录拉到了(`total: 80`)而
 * 免费集为空(`free: 0`)。实测把 `freeSuffix` 改成一个没有模型命中的值即可
 * 复现。所以这两层依然要分开 —— 只是分界线和原先记的不一样。
 * `zen_gateway_catalog.total` 与 `free` 两个字段正好把它们区分开。
 */
async function layerCatalog() {
  const token = ctx.config.gateway.relayToken;
  let res;
  try {
    res = await fetch(`${instance.base}/v1/models`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    return {
      status: "fail",
      text: "无法访问服务的 /v1/models",
      detail: safeErrorMessage(err),
      nextStep: "服务刚才还健康,现在却不应答 —— 看日志:tail -50 " + join(DATA_DIR, "zen-gateway.log"),
    };
  }

  if (res.status === 401) {
    return {
      status: "fail",
      text: "Relay Token 被拒(401)",
      detail: "doctor 用的是配置里的 gateway.relayToken,而服务不认它。",
      nextStep: "服务在用一份更旧的配置 —— npm run restart 让它重新加载。",
    };
  }

  const body = await res.json().catch(() => null);

  if (res.status === 502) {
    /*
     * 上游不可达。**CA 是本机已实测过的成因,所以优先报它。**
     *
     * 关键:要查的是**服务进程**的环境变量,不是 doctor 自己的 ——
     * 服务由 `npm start` 启动时可能带了 `NODE_EXTRA_CA_CERTS`,
     * 而用户手敲 `npm run doctor` 时没带(或反过来)。拿 doctor 自己的
     * `process.env` 去判断会给出一个与现实相反的结论。
     */
    const serverCa = await serverEnv("NODE_EXTRA_CA_CERTS");
    const caHint =
      serverCa === null
        ? "无法读取服务进程的环境变量(非 Linux 或权限不足),请自行确认它启动时带了 NODE_EXTRA_CA_CERTS。"
        : serverCa === undefined
          ? "**服务进程没有设 NODE_EXTRA_CA_CERTS** —— 这是本机已实测过的成因。"
          : `服务进程的 NODE_EXTRA_CA_CERTS = ${serverCa}(已设,那么成因在别处)`;

    return {
      status: "fail",
      text: "上游模型目录拉不到(502)",
      detail: `${caHint}\n服务端日志里有被脱敏的具体原因(形如 fetch failed ← unable to get local issuer certificate)。`,
      nextStep:
        serverCa === undefined
          ? `重启并带上 CA:\n  npm stop && NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt npm start\n（本机 opencode.ai 被企业 CA 中间人,而 Node 不读系统 CA 库 —— curl 通不代表 Node 通。）`
          : `查出口与网络:\n  grep 目录拉取 ${join(DATA_DIR, "zen-gateway.log")} | tail -5\n  npm run doctor -- --deep   # 实测各出口的公网 IP`,
    };
  }

  if (!res.ok) {
    return { status: "fail", text: `/v1/models 返回 ${res.status}`, detail: JSON.stringify(body).slice(0, 300) };
  }

  const meta = body?.zen_gateway_catalog;
  const free = Array.isArray(body?.data) ? body.data.length : 0;

  if (free === 0) {
    /*
     * 目录拿到了,但免费集是空的 —— 与「拉不到」是两件事,下一步完全不同。
     * `total` 区分了它们:有 total 而 free 为 0 说明免费判定把整份目录滤掉了。
     */
    return {
      status: "fail",
      text: `目录可达(在架 ${meta?.total ?? "?"} 个)但免费集为空`,
      detail:
        `freeSuffix = ${JSON.stringify(ctx.config.models.freeSuffix)} · ` +
        `extraFreeIds = ${JSON.stringify(ctx.config.models.extraFreeIds)}\n` +
        `免费集 = (后缀命中 ∪ extraFreeIds) ∩ 在架目录 —— 三者之一不对就会空。`,
      nextStep:
        "上游把带 -free 后缀的模型全下架了,或 freeSuffix 被改错。\n" +
        `核对在架目录:curl -s https://opencode.ai/zen/v1/models | grep -o '"id":"[^"]*free[^"]*"' | head`,
    };
  }

  return {
    status: "pass",
    text: `模型目录正常:免费 ${free} 个 / 在架 ${meta?.total ?? "?"} 个`,
    detail:
      `槽位 ${meta?.slot ?? "?"} · ${meta?.fresh ? "新鲜" : "已过期(仍可用,后台会刷)"} · ` +
      `拉取于 ${humanMs(Date.now() - (meta?.fetched_at ?? Date.now()))}前\n` +
      `免费模型:${(body.data ?? []).slice(0, 6).map((m) => m.id).join(", ")}${free > 6 ? ` …(共 ${free} 个)` : ""}`,
  };
}

/**
 * 第 7 层(仅 `--deep`):实测每个出口的公网 IP。
 *
 * 默认不跑:它要对每个代理各发一次真实网络请求(经 Clash 时还要切 selector),
 * 一次完整探测可能几十秒。而 doctor 的常用场景是「刚才还好好的,怎么不行了」,
 * 那时前六层足够定位。
 *
 * ## 为什么这一层不可省
 *
 * 控制面的 `/delay` 只证明节点可用,**不证明我们的流量真的从那个节点出去**。
 * 出口隔离的全部价值在于「两个 Worker 的流量从不同公网 IP 出去」,
 * 而这件事只能由我们自己的请求实测回显 IP 来证明。
 *
 * ## 这一层会切 Clash 的 selector —— 它是 doctor 唯一的副作用
 *
 * 桥接探测必须切 selector(那是进程外的全局状态),所以 `--deep` 跑完之后
 * selector 停在最后探测的那个节点上。这是探测本身的性质,不是可以避免的 ——
 * 但**必须说出来**,所以这里打一行,而不是让用户事后发现节点被换了。
 */
async function layerEgress() {
  if (!DEEP) {
    return { status: "skip", text: "出口实测已跳过(加 --deep 开启;它会真发网络请求并切换 Clash 节点)" };
  }

  const { EgressService } = await import("../src/core/proxy/egress.ts");
  const { buildIsolationReport } = await import("../src/core/proxy/probe.ts");

  const cfg = ctx.config;
  const usable = cfg.workers.filter(isUsable);
  if (usable.length === 0) return { status: "skip", text: "没有可用 Worker,出口实测无意义" };

  console.log("      (正在实测各出口的公网 IP,可能要几十秒…)");
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
    // 按 Worker 实际绑的出口去探 —— 探一个没人用的代理没有诊断价值。
    const proxyIds = [...new Set(usable.map((w) => w.proxyId))];
    const results = await egress.probeAll(cfg, proxyIds);
    const byProxy = new Map(results.map((r) => [r.proxyId, r.outcome]));

    const entries = usable.map((w) => {
      const outcome = byProxy.get(w.proxyId ?? "__direct__");
      return {
        workerId: w.id,
        proxyId: w.proxyId,
        egressIp: outcome?.ok ? outcome.egressIp : null,
      };
    });

    const report = buildIsolationReport(entries);
    const lines = entries.map((e) => {
      const outcome = byProxy.get(e.proxyId ?? "__direct__");
      const where = e.proxyId ?? "(本机直连)";
      return outcome?.ok
        ? `${e.workerId} → ${where}: ${outcome.egressIp} (${humanMs(outcome.latencyMs)}, via ${outcome.via})`
        : `${e.workerId} → ${where}: ✗ ${outcome?.failureKind ?? "?"} —— ${outcome?.reason ?? "未探测"}`;
    });

    if (report.sharedGroups.length > 0) {
      return {
        status: "warn",
        text: "出口**未**隔离:有多个 Worker 从同一个公网 IP 出去",
        detail:
          lines.join("\n") +
          "\n\n共用出口的组:\n" +
          report.sharedGroups.map((g) => `  ${g.egressIp}: ${g.workerIds.join(", ")}`).join("\n"),
        nextStep:
          "把这些 Worker 分别绑到不同出口的代理上。\n" +
          "注意两个不同代理可能 NAT 到同一个公网 IP —— 判据是上面实测的 IP,不是代理 id。",
      };
    }

    if (report.unknownWorkerIds.length > 0) {
      return {
        status: "warn",
        text: `${report.unknownWorkerIds.length} 个 Worker 的出口未能探出`,
        detail: lines.join("\n") + "\n\n「还不知道」与「确认不同」是两件事,所以不报告为已隔离。",
        nextStep: "看上面失败的原因。桥接失败多半是混合端口不对(见第 5 层)或节点本身不通。",
      };
    }

    return { status: "pass", text: `出口已隔离:${report.groups.length} 个 Worker 各自独占一个公网 IP`, detail: lines.join("\n") };
  } finally {
    // 关掉 dispatcher 池,否则 keep-alive 连接会把进程吊住。
    await egress.close().catch(() => {});
  }
}

/* ------------------------------------------------------------------ *
 * 辅助
 * ------------------------------------------------------------------ */

function ensureSlash(base) {
  const u = new URL(base);
  u.search = "";
  u.hash = "";
  if (!u.pathname.endsWith("/")) u.pathname = `${u.pathname}/`;
  return u.href;
}

/** 从 Controller 的 `/configs` 读混合端口。读不到返回 null(不当作不一致)。 */
async function readMixedPort(bridge) {
  try {
    const res = await fetch(new URL("configs", ensureSlash(bridge.apiBase)).href, {
      ...(bridge.apiSecret === "" ? {} : { headers: { authorization: `Bearer ${bridge.apiSecret}` } }),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const body = await res.json();
    const port = body?.["mixed-port"];
    return typeof port === "number" && port > 0 ? port : null;
  } catch {
    return null;
  }
}

/**
 * 读**服务进程**的一个环境变量。
 *
 * 三态,调用方必须区分:
 *   - `null`      读不到(非 Linux / 权限不足)—— 不能下结论
 *   - `undefined` 没设,**或设了空串**
 *   - 字符串      读到了,值非空
 *
 * 合成两态会让「读不到」被当成「没设」,于是 doctor 在 macOS 上会坚定地
 * 报一个它根本没验证过的结论。
 *
 * **空串按「没设」处理**:`NODE_EXTRA_CA_CERTS=` 对 Node 与真的没设等效
 * (它不会去加载任何额外 CA)。若按「已设」报告,doctor 会说「已设,成因在
 * 别处」而把用户引向错误方向 —— 这是本测试套件实测抓出来的。
 */
async function serverEnv(name) {
  const pid = ctx.health?.pid;
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

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

const LAYERS = [
  ["配置", layerConfig],
  ["服务", layerService],
  ["统计库", layerStore],
  ["Worker", layerWorkers],
  ["Clash 控制面", layerClashControl],
  ["模型目录", layerCatalog],
  ["出口实测", layerEgress],
];

async function main() {
  console.log(`zen-gateway 诊断 — ${new Date().toISOString().slice(0, 16).replace("T", " ")}`);
  console.log(`端口 ${PORT} · data/ ${DATA_DIR}`);

  let failedAt = null;
  const warnings = [];

  for (const [index, [name, fn]] of LAYERS.entries()) {
    heading(`${index + 1}. ${name}`);

    /*
     * 一层自己抛异常时**不能把整个 doctor 带走** —— 那会让用户连前面几层
     * 已经通过的信息都看不到,而诊断工具最不该做的就是自己崩掉。
     */
    let result;
    try {
      result = await fn();
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
      // 只报第一个失败的层 —— 后面的层在它修好之前给不出有意义的答案。
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
    /*
     * 告警**不影响退出码**。
     *
     * 出口未隔离、部分 Worker 不可用都属于「能用但不理想」,而退出码是给
     * 脚本用的信号 —— 让它对「能用」返回非 0 会让任何 `npm run doctor &&  …`
     * 的串联在一个可用的系统上失败。
     */
    return;
  }
  console.log("全部通过。");
  if (!DEEP) console.log("出口隔离未实测 —— 要验证它跑:npm run doctor -- --deep");
}

await main();
