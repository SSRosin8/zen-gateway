#!/usr/bin/env node
/**
 * 单命令启停。
 *
 * 核心问题是**进程身份**:光凭 PID 文件里的数字不能证明那个进程是我们的服务。
 * PID 会被系统复用,于是「崩溃留下 PID 文件 → 系统把该 PID 分给别的进程 →
 * 用户 npm stop」这条路径会杀掉一个无关进程。所以任何发信号之前都必须先验明身份,
 * 两条独立途径:
 *
 *   1. /health 回报的 pid 与状态文件一致 —— 服务健康时的强证明
 *      (能应答我们端口的进程,就是占着这个端口的进程)
 *   2. /proc/<pid>/cmdline 含我们的入口路径 —— 服务卡死不应答时的兜底
 *
 * 两条都不成立就拒绝发信号,并说明原因。宁可让用户手工处理,
 * 也不能替他杀一个不知道是什么的进程。
 *
 * 并发启动用排他锁文件(O_EXCL)防住:两个 npm start 同时跑,
 * 没有锁的话会双双 spawn,一个抢到端口另一个 EADDRINUSE 退出,
 * 而后写者会把**已死**的 PID 留在状态文件里,活着的那个成为孤儿进程。
 */

import { spawn } from "node:child_process";
import { existsSync, openSync, readFileSync } from "node:fs";
import { chmod, mkdir, open, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * data/ 的位置可被 ZG_DATA_DIR 覆盖。
 *
 * 这不是纯为测试开的后门:本脚本先前完全没有测试,而审核在其中查出四个
 * 真实缺陷(误杀无关进程、restart 谎报成功、误删活实例的状态文件、并发
 * 双启动留下孤儿)。要让这些缺陷有常驻回归测试,就必须能把状态文件与端口
 * 一起隔离,否则测试之间、以及测试与用户真实实例之间会互相踩。
 */
const DATA_DIR = process.env.ZG_DATA_DIR ? resolve(process.env.ZG_DATA_DIR) : join(ROOT, "data");
const STATE_FILE = join(DATA_DIR, "zen-gateway.state.json");
const LOCK_FILE = join(DATA_DIR, "zen-gateway.lock");
const LOG_FILE = join(DATA_DIR, "zen-gateway.log");
const ENTRY = join(ROOT, "dist", "server", "server", "index.js");
/** 本脚本自身的路径:用于确认锁的持有者是不是另一个 start。 */
const SCRIPT = fileURLToPath(import.meta.url);

/**
 * 端口解析必须与 `src/server/index.ts` **完全一致**:
 * `ZG_PORT` > `config.json` 的 `gateway.port` > 9876。
 *
 * 两处若不一致,本脚本会去探一个没人监听的端口,然后在健康等待超时后报
 * 「启动失败」—— 而服务其实已经起来了。这是本阶段真实发生过的回归:
 * 服务端改成读配置里的 port、本脚本仍只认 ZG_PORT,6 条集成测试全红。
 *
 * 这里刻意**不**校验配置的其他部分,也绝不打印配置内容(整个文件都可能是凭证)。
 * 配置坏了由服务端在启动时如实报错,本脚本只需要一个用于探活的端口号。
 */
function resolvePort() {
  const fromEnv = process.env.ZG_PORT;
  if (fromEnv !== undefined && fromEnv !== "") {
    const parsed = Number(fromEnv);
    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) return parsed;
    // 非法值不静默回落:那会让「我明明设了 ZG_PORT」变成一个查不出的问题。
    console.error(`ZG_PORT 不是合法端口:${fromEnv}`);
    process.exit(1);
  }

  try {
    const raw = JSON.parse(readFileSync(join(DATA_DIR, "config.json"), "utf8"));
    const p = raw?.gateway?.port;
    if (Number.isInteger(p) && p >= 1 && p <= 65535) return p;
  } catch {
    // 配置不存在(首启)或不可解析 —— 用默认端口,服务端会报真正的原因。
  }

  return 9876;
}

const PORT = resolvePort();
const BASE = `http://127.0.0.1:${PORT}`;

const HEALTH_TIMEOUT_MS = 20_000;
const HEALTH_INTERVAL_MS = 250;
const STOP_TIMEOUT_MS = 10_000;

/** data/ 与其中的文件都可能含凭证,一律只对属主开放。 */
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * 基础设施
 * ------------------------------------------------------------------ */

/**
 * mkdir 的 mode 只在**创建时**生效。已存在且权限松的 data/ 不会被纠正,
 * 于是日志与状态文件所在目录可能是 755,其他本地用户能列出并读取。
 */
async function ensureDataDir() {
  await mkdir(DATA_DIR, { recursive: true, mode: DIR_MODE });
  try {
    const st = await stat(DATA_DIR);
    if ((st.mode & 0o777) !== DIR_MODE) await chmod(DATA_DIR, DIR_MODE);
  } catch {
    // 改不动不阻塞启动;doctor 会单独报这一项。
  }
}

async function readState() {
  try {
    const raw = JSON.parse(await readFile(STATE_FILE, "utf8"));
    const pid = Number.parseInt(raw?.pid, 10);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    return { pid, port: Number(raw?.port) || PORT, startedAt: raw?.startedAt ?? null };
  } catch {
    return null;
  }
}

async function writeState(pid) {
  await writeFile(
    STATE_FILE,
    `${JSON.stringify({ pid, port: PORT, startedAt: new Date().toISOString() })}\n`,
    { mode: FILE_MODE },
  );
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = 进程存在但不属于当前用户 —— 存活,但绝不是我们启的。
    return err?.code === "EPERM";
  }
}

/**
 * 身份验证途径 2:进程的 cmdline 是否指向我们的入口。
 *
 * 服务卡死不应答 /health 时,这是唯一还能用的证明。没有它就只能在
 * 「拒绝停止一个卡死的服务」和「盲杀一个 PID」之间二选一。
 */
async function pidLooksLikeOurs(pid) {
  try {
    const cmdline = await readFile(`/proc/${pid}/cmdline`, "utf8");
    return cmdline.split("\0").some((arg) => arg === ENTRY);
  } catch {
    // 非 Linux 或无权读取 → 这条途径不可用,交给调用方判断。
    return null;
  }
}

async function probeHealth(timeoutMs = 1000) {
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const body = await res.json();
    return body?.ok === true ? body : null;
  } catch {
    return null;
  }
}

/**
 * 把「端口上在跑什么」「状态文件指向什么」「它是不是我们的」一次问清。
 *
 * 只读,不做任何清理 —— 先前的实现顺手删陈旧状态文件,结果在
 * 「本服务存活但不健康」这条路径上删掉了**活着的**实例的状态文件,
 * 之后 stop 与 status 都报「未在运行」,只能手工 ss/kill 收场。
 */
async function inspect() {
  const state = await readState();
  const health = await probeHealth();
  const alive = state !== null && pidAlive(state.pid);

  let identity = "unknown";
  if (alive) {
    if (health !== null) {
      // 能应答我们端口的进程就是占着这个端口的进程。
      identity = health.pid === state.pid ? "ours" : "foreign";
    } else {
      const byCmdline = await pidLooksLikeOurs(state.pid);
      if (byCmdline === true) identity = "ours";
      else if (byCmdline === false) identity = "foreign";
    }
  }

  return {
    state,
    health,
    alive,
    identity,
    healthy: health !== null,
    /** 端口上有服务,但不是状态文件记录的那个(或根本没有状态文件)。 */
    foreignOnPort: health !== null && (state === null || health.pid !== state.pid),
  };
}

/**
 * 锁持有者的 cmdline 是否指向本脚本。
 *
 * 必须按路径解析后比较,不能直接字符串相等:`npm start` 执行的是
 * `node scripts/service.mjs`,cmdline 里是**相对路径**,而 `SCRIPT` 是绝对路径。
 * 直接比较会把一个真正并发的 start 判成「PID 被复用」并抢掉它的锁 ——
 * 恰好重新引入这把锁要防止的双 spawn。
 *
 * 相对路径要相对**持有者的 cwd**解析,所以先读 /proc/<pid>/cwd;
 * 读不到就退回本进程的 cwd(同一个 npm 脚本通常同 cwd)。
 */
async function cmdlinePointsAtScript(pid) {
  let cmdline;
  try {
    cmdline = await readFile(`/proc/${pid}/cmdline`, "utf8");
  } catch {
    return null; // 无法判断
  }

  let cwd = process.cwd();
  try {
    cwd = await readlink(`/proc/${pid}/cwd`);
  } catch {
    /* 退回本进程 cwd */
  }

  return cmdline
    .split("\0")
    .filter(Boolean)
    .some((arg) => arg === SCRIPT || resolve(cwd, arg) === SCRIPT);
}

/**
 * 判断锁的持有者状态。
 *
 * 不能只看「锁文件有多旧」:先前的逻辑是
 * `stale = 持有者已死 || 年龄 > 60s`,于是一把**活着的**锁只要超过 60s 就会被
 * 抢占 —— 慢磁盘或高负载下两次相隔 61s 的 start 会双双 spawn,正是这把锁
 * 要防止的事。mtime 也从不刷新,所以「年龄」根本不代表持有者是否还在工作。
 *
 * 改为按持有者身份判断,与停止服务时同一套思路:
 *   - 内容不可解析 → 崩溃在写入中途,可抢占
 *   - 进程已死 → 可抢占
 *   - 进程存活但 cmdline 不是本脚本 → PID 被复用,可抢占
 *   - 进程存活且确是本脚本 → 真的有并发 start,拒绝(不看年龄)
 *   - 无法判断(读不到 /proc) → 保守拒绝,并给出恢复提示
 */
async function lockHolder() {
  let raw;
  try {
    raw = await readFile(LOCK_FILE, "utf8");
  } catch {
    return { state: "gone" };
  }

  const pid = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) return { state: "garbage" };
  if (pid === process.pid) return { state: "live", pid }; // 自己的锁,不该抢
  if (!pidAlive(pid)) return { state: "dead", pid };

  const isOurs = await cmdlinePointsAtScript(pid);
  if (isOurs === null) return { state: "unknown", pid };
  return isOurs ? { state: "live", pid } : { state: "reused", pid };
}

/** 排他锁:防止两个 start 同时 spawn。 */
async function acquireLock() {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(LOCK_FILE, "wx", FILE_MODE);
      await handle.writeFile(`${process.pid}\n`, "utf8");
      await handle.close();
      return { ok: true };
    } catch (err) {
      if (err?.code !== "EEXIST") {
        /*
         * 不是「已存在」而是别的错误,例如锁路径被建成了目录(EISDIR)。
         * 先前直接 rethrow,于是抛出未捕获异常:堆栈里带安装路径,退出码 1
         * 而不是有意义的失败。这里给一句明确的话。
         */
        return { ok: false, reason: `无法创建锁文件(${err?.code ?? "未知错误"}):${LOCK_FILE}` };
      }

      const holder = await lockHolder();
      if (holder.state === "live") {
        return { ok: false, reason: `另一个 start 正在进行中(pid ${holder.pid})。` };
      }
      if (holder.state === "unknown") {
        return {
          ok: false,
          reason:
            `锁被 pid ${holder.pid} 持有,但无法确认它是否为本脚本。\n` +
            `请手工确认后删除:${LOCK_FILE}`,
        };
      }

      // gone / garbage / dead / reused —— 都可以安全抢占。
      try {
        await rm(LOCK_FILE, { force: true });
      } catch (err) {
        /*
         * 锁路径存在但删不掉,最典型的是它是个**目录**:
         * open 得到 EEXIST → readFile 得到 EISDIR(被当成「锁已消失」)
         * → rm 抛 ERR_FS_EISDIR 且无人接住 → 未捕获异常 + 堆栈里带安装路径。
         *
         * 刻意不做递归删除:那个目录不是我们建的,recursive 删一个来历不明的
         * 目录是不可逆的破坏性操作。报清楚,让用户自己处理。
         */
        return {
          ok: false,
          reason:
            `锁路径无法删除(${err?.code ?? "未知错误"}):${LOCK_FILE}\n` +
            "若它是个目录或权限不对,请手工清理后重试。",
        };
      }
    }
  }
  return { ok: false, reason: "反复抢锁失败,可能有并发 start 在竞争。" };
}

const releaseLock = () => rm(LOCK_FILE, { force: true });

/* ------------------------------------------------------------------ *
 * 命令
 * ------------------------------------------------------------------ */

async function start() {
  await ensureDataDir();

  const lock = await acquireLock();
  if (!lock.ok) {
    console.error(lock.reason);
    return 1;
  }

  try {
    const st = await inspect();

    if (st.identity === "ours" && st.healthy) {
      console.log(`已在运行(pid ${st.state.pid}) → ${BASE}`);
      return 0;
    }

    if (st.foreignOnPort) {
      console.error(`端口 ${PORT} 已被另一个进程占用(pid ${st.health.pid}),不是本脚本启动的。`);
      console.error("先停掉它,否则两个实例会抢同一份 data/。");
      return 1;
    }

    /*
     * 本服务的实例存活但不健康。
     * 此时绝不能再 spawn:新进程会因 EADDRINUSE 立刻死掉,
     * 而清理逻辑会把**原实例**的状态文件一起删掉,把它变成孤儿。
     */
    if (st.identity === "ours" && !st.healthy) {
      console.error(`本服务实例(pid ${st.state.pid})存活但健康检查未通过。`);
      console.error(`先 npm stop,或查看日志:${LOG_FILE}`);
      return 1;
    }

    if (st.alive && st.identity === "unknown") {
      console.error(`状态文件记录的 pid ${st.state.pid} 存活,但无法确认是本服务。`);
      console.error(`请手工确认该进程后删除 ${STATE_FILE}`);
      return 1;
    }

    /*
     * 状态文件指向一个存活但**确认不是**本服务的进程(PID 已被系统复用)。
     *
     * 这里刻意继续启动,与 stop 的谨慎是**有意的不对称**:
     * stop 要发 SIGTERM,是不可逆的破坏性操作,认不准身份就必须拒绝;
     * start 只需要端口空闲,而那条陈旧记录对我们毫无价值 —— 拒绝启动
     * 只会逼用户手工删文件,却挡不住任何危险。
     *
     * 端口若真被别人占着,上面的 foreignOnPort 分支已经拦下了。
     */
    if (st.alive && st.identity === "foreign") {
      console.log(`状态文件中的 pid ${st.state.pid} 已属于其他进程,忽略该陈旧记录。`);
    }

    // 到这里:没有状态文件、记录的进程已死、或记录已被复用 —— 都可以安全启动。
    if (st.state !== null && !st.alive) await rm(STATE_FILE, { force: true });

    if (!existsSync(ENTRY)) {
      console.error(`未找到构建产物,先 npm run build`);
      return 1;
    }

    // 日志可能落进上游错误与堆栈,按凭证文件对待。
    const log = openSync(LOG_FILE, "a", FILE_MODE);
    try {
      await chmod(LOG_FILE, FILE_MODE);
    } catch {
      /* 已存在且改不动时不阻塞 */
    }

    const child = spawn(process.execPath, [ENTRY], {
      cwd: ROOT,
      detached: true,
      stdio: ["ignore", log, log],
      env: process.env,
    });
    child.unref();
    await writeState(child.pid);

    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const health = await probeHealth();
      if (health?.pid === child.pid) {
        console.log(`zen-gateway 已启动(pid ${child.pid}) → ${BASE}`);
        return 0;
      }
      if (!pidAlive(child.pid)) {
        console.error(`进程已退出,日志见 ${LOG_FILE}`);
        // 只删我们刚写的那份,不碰别人的。
        const current = await readState();
        if (current?.pid === child.pid) await rm(STATE_FILE, { force: true });
        return 1;
      }
      await sleep(HEALTH_INTERVAL_MS);
    }

    console.error(`启动后 ${HEALTH_TIMEOUT_MS / 1000}s 内未通过健康检查,日志见 ${LOG_FILE}`);
    return 1;
  } finally {
    await releaseLock();
  }
}

async function stop() {
  const st = await inspect();

  if (st.state === null) {
    if (st.healthy) {
      console.error(`端口 ${PORT} 上有实例(pid ${st.health.pid}),但不是本脚本启动的,未停止。`);
      return 1;
    }
    console.log("未在运行");
    return 0;
  }

  if (!st.alive) {
    await rm(STATE_FILE, { force: true });
    if (st.healthy) {
      console.error(`状态文件已过期;端口上另有实例(pid ${st.health.pid}),未停止。`);
      return 1;
    }
    console.log("未在运行");
    return 0;
  }

  /*
   * 存活但两条身份途径都没给出肯定答案 —— 拒绝发信号。
   * 这正是 PID 复用会踩的坑:状态文件里的数字可能已经属于别人的进程。
   */
  if (st.identity !== "ours") {
    console.error(`无法确认 pid ${st.state.pid} 是本服务(端口无应答且 cmdline 不匹配),未发送信号。`);
    console.error(`请手工确认:ps -p ${st.state.pid} -o pid,cmd`);
    return 1;
  }

  const pid = st.state.pid;
  process.kill(pid, "SIGTERM");

  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) {
      await rm(STATE_FILE, { force: true });
      console.log(`已停止(pid ${pid})`);
      return 0;
    }
    await sleep(HEALTH_INTERVAL_MS);
  }

  console.error(`pid ${pid} 在 ${STOP_TIMEOUT_MS / 1000}s 内未响应 SIGTERM,未强杀。`);
  console.error(`如确认可强杀:kill -9 ${pid}`);
  return 1;
}

async function status() {
  const st = await inspect();

  if (st.identity === "ours" && st.healthy) {
    console.log(
      `运行中(pid ${st.state.pid}) · v${st.health.version} · 已运行 ${st.health.uptimeSeconds}s → ${BASE}`,
    );
    return 0;
  }
  if (st.foreignOnPort) {
    console.log(`端口 ${PORT} 上有非本脚本启动的实例(pid ${st.health.pid})`);
    return 1;
  }
  if (st.alive) {
    const who = st.identity === "ours" ? "本服务实例" : `pid ${st.state.pid}(身份未确认)`;
    console.log(`${who}存活但健康检查未通过,日志见 ${LOG_FILE}`);
    return 1;
  }
  console.log("未在运行");
  return 1;
}

async function restart() {
  const code = await stop();
  /*
   * stop 失败就不能继续。
   *
   * 先前实现丢弃了 stop 的返回码:遇到一个不响应 SIGTERM 的进程时,
   * stop 正确地失败了,而随后的 start 看到「存活且健康」便打印
   * 「已在运行」并返回 0 —— 用户以为部署了新版本,实际跑的还是旧进程。
   */
  if (code !== 0) {
    console.error("stop 未成功,已中止 restart(避免误以为新版本已生效)。");
    return code;
  }
  return start();
}

/* ------------------------------------------------------------------ *
 * 分发
 * ------------------------------------------------------------------ */

/*
 * 用 Map 而不是对象字面量。
 *
 * 对象字面量会让 actions[cmd] 命中 Object.prototype 上的成员:
 * `service.mjs hasOwnProperty` 能越过「未知命令」的检查,
 * 调用继承来的方法后抛出未捕获 TypeError,堆栈里带着安装的绝对路径,
 * 且退出码是 1 而不是「用法错误」的 2。
 */
const ACTIONS = new Map([
  ["start", start],
  ["stop", stop],
  ["status", status],
  ["restart", restart],
]);

const cmd = process.argv[2] ?? "status";
const action = ACTIONS.get(cmd);
if (!action) {
  console.error(`未知命令:${cmd}(可用:${[...ACTIONS.keys()].join(" / ")})`);
  process.exit(2);
}
process.exit(await action());
