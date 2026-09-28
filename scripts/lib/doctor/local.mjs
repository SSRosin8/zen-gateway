// doctor 第 1–4 层：本机配置、服务进程、统计库与 Worker。全部只读。
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { configExists, loadConfig, ConfigError } from "../../../src/store/config.ts";
import { HealthSchema } from "../../../src/shared/contract.ts";
import { diagnoseWorkers } from "../../../src/core/routing/diagnose.ts";
import { safeErrorMessage } from "../../../src/shared/redact.ts";
import { humanMs } from "../report.mjs";

/** 第 1 层：配置可加载。 */
export async function layerConfig(ctx) {
  const root = process.env.ZG_DATA_DIR ? undefined : ctx.root;
  // 先问文件在不在：loadConfig 缺文件时会生成默认配置并写盘，诊断工具不能改状态。
  if (!(await configExists(root))) {
    return {
      status: "fail",
      text: "配置不存在",
      nextStep: `npm start —— 首次启动会自动生成默认配置与 Relay Token。\n（doctor 刻意不替你生成:那会改变状态。）`,
    };
  }

  try {
    // readOnly：默认路径会顺手 chmod，那样「权限过松」永远报不出来，跑 doctor 本身也成了变更。
    const { config, permissionIssues } = await loadConfig(root, { readOnly: true });
    ctx.config = config;
    const summary = `端口 ${config.gateway.port} · Worker ${config.workers.length} 个 · 代理 ${config.proxies.length} 个 · Clash ${config.clash.enabled ? "已启用" : "未启用"}`;

    if (permissionIssues.length > 0) {
      // 真实问题（config.json 整个是凭证），但服务照样能跑，所以 warn 不阻断。
      return {
        status: "warn",
        text: "配置可加载，但权限过松",
        detail: `${summary}\n${permissionIssues.join("\n")}`,
        nextStep: `chmod 600 ${join(ctx.dataDir, "config.json")} && chmod 700 ${ctx.dataDir}\n（下次 npm start 也会自动纠正 —— doctor 刻意只报不改。）`,
      };
    }

    return { status: "pass", text: "配置可加载", detail: summary };
  } catch (err) {
    if (err instanceof ConfigError) {
      const advice = {
        unreadable: `检查文件是否损坏或磁盘是否可读:${join(ctx.dataDir, "config.json")}`,
        malformed: `修正 JSON 语法。报错里给了大致字节位置,用编辑器跳过去看。`,
        invalid: `按上面的字段路径逐条修正。路径形如 workers.0.proxyId,指的是第 1 个 Worker。`,
        permission: `chmod 600 ${join(ctx.dataDir, "config.json")}`,
      }[err.kind];
      return { status: "fail", text: `配置无法加载(${err.kind})`, detail: err.message, nextStep: advice };
    }
    return { status: "fail", text: "配置无法加载", detail: safeErrorMessage(err) };
  }
}

/**
 * 第 2 层：端口上的进程是本服务且健康。
 * 身份判定与 service.mjs 共用 lib/instance.mjs，避免 doctor 与 npm stop 给出矛盾结论。
 */
export async function layerService(ctx) {
  const { instance } = ctx;
  const st = await instance.inspect();
  ctx.state = st;

  if (st.foreignOnPort) {
    // dev:server 不写状态文件；把它报成「陌生进程」会让用户去查自己刚启动的东西。
    // 它仍是本项目服务，后续层可以照常问它，所以只降为 warn。
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
      text: `端口 ${instance.port} 被另一个进程占用(pid ${st.health.pid})`,
      detail: "它能应答 /health,但既不是本脚本启动的实例,cmdline 也不像本项目。",
      nextStep: `先停掉它,或把 gateway.port 改成一个空闲端口。\n查证:ss -ltnp | grep ${instance.port}`,
    };
  }

  if (!st.healthy) {
    if (st.alive && st.identity === "ours") {
      return {
        status: "fail",
        text: `服务进程(pid ${st.state.pid})存活但健康检查未通过`,
        nextStep: `看日志:tail -50 ${join(ctx.dataDir, "zen-gateway.log")}\n或重启:npm run restart`,
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
      nextStep: `npm start\n（企业网络下需要 NODE_EXTRA_CA_CERTS,见 docs/usage.md —— 否则服务起得来，但 /v1/models 返回 502 upstream_unreachable。）`,
    };
  }

  // instance.mjs 为了 status 启动快不引 zod；doctor 在这里补契约级校验，暴露前后端版本不一致。
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

  if (instance.port !== ctx.port) {
    return {
      status: "warn",
      text: `服务运行中(pid ${ctx.health.pid}),但配置的端口已改为 ${ctx.port}`,
      detail: `当前监听 ${instance.base};客户端和 opencode.json 要等重启后才能改用新端口。`,
      nextStep: "npm run restart",
    };
  }
  return {
    status: "pass",
    text: `服务运行中(pid ${ctx.health.pid})`,
    detail: `v${ctx.health.version} · 已运行 ${humanMs(ctx.health.uptimeSeconds * 1000)} · ${instance.base}`,
  };
}

/**
 * 第 3 层：统计与亲和持久化写入正常。
 * store 吞掉写异常以免影响转发，但持续失败会产出看似「没人用」的全 0 报表；转发不受影响，所以只 warn。
 */
export async function layerStore(ctx) {
  const failures = ctx.health.storeWriteFailures;
  if (failures > 0) {
    return {
      status: "warn",
      text: `统计/亲和持久化累计写失败 ${failures} 次`,
      detail: "转发不受影响,但统计数字不可信(报表可能偏低或全 0)。",
      nextStep: `查磁盘与权限:df -h ${ctx.dataDir} && ls -l ${join(ctx.dataDir, "runtime.db")}\n日志里有具体原因:grep -i 'runtime\\|统计' ${join(ctx.dataDir, "zen-gateway.log")}`,
    };
  }

  // readOnly 打开：openDb() 会跑迁移，而档位升级不可逆。服务持有 WAL 库时并发只读是安全的。
  const dbFile = join(ctx.dataDir, "runtime.db");
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
    // 库不可读不是失败：index.ts 刻意不让它阻止启动。
    dbInfo = `统计库不可读(转发不受影响):${safeErrorMessage(err)}`;
  }

  return { status: "pass", text: "统计写入正常(0 次失败)", detail: dbInfo };
}

/** 第 4 层：至少一个可用 Worker。判定与管理面诊断共用 `diagnoseWorkers`。 */
export async function layerWorkers(ctx) {
  // 就绪态问服务而不是自己算冷却（纪律 #4）；拿不到时降级为只报配置形态。
  const runtime = await workerRuntime(ctx.instance);
  return diagnoseWorkers(ctx.config.workers, runtime, `在 ${join(ctx.dataDir, "config.json")} 的 workers 数组里加一个`);
}

/** 从 `/api/overview` 取 Worker 运行期状态；null 表示拿不到（第 2 层已确认健康，多半是恰好在重启）。 */
async function workerRuntime(instance) {
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
