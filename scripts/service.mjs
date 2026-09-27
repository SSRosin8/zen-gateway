#!/usr/bin/env node
/**
 * 单命令启停。核心问题是进程身份：PID 会被系统复用，发信号之前必须先验明身份
 * （判定见 `lib/instance.mjs`），认不准就拒绝，也不替用户杀不认识的进程。
 * 并发启动用排他锁文件（O_EXCL）防住，否则两个 start 会双双 spawn，
 * 状态文件里留下已死的 PID，活着的那个成为孤儿。
 */

import { spawn } from "node:child_process";
import { existsSync, openSync } from "node:fs";
import { chmod, mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { resolveAdminPort, resolvePort } from "../src/store/port.ts";
import { DIR_MODE, FILE_MODE } from "../src/store/paths.ts";
import { createInstance, dataDirOf, pidRunsScript } from "./lib/instance.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** data/ 可被 ZG_DATA_DIR 覆盖，让回归测试能把状态文件与端口一起隔离。 */
const DATA_DIR = dataDirOf(ROOT);
const LOCK_FILE = join(DATA_DIR, "zen-gateway.lock");
const LOG_FILE = join(DATA_DIR, "zen-gateway.log");
const ENTRY = join(ROOT, "dist", "server", "server", "index.js");
/** 本脚本自身的路径:用于确认锁的持有者是不是另一个 start。 */
const SCRIPT = fileURLToPath(import.meta.url);

/**
 * 端口从 `resolvePort()` 取，与服务端、`vite.config.ts` 共用一份解析（纪律 #4）。
 *
 * 传 root 必须与 DATA_DIR 的算法对应，否则会读到另一份 config.json：
 *   - `ZG_DATA_DIR` 已设 → 传 `undefined`（`paths.ts` 里显式 root 优先于环境变量）
 *   - 未设 → 传 `ROOT`，不能依赖 cwd（脚本可能从任意目录执行）
 *
 * 非法 `ZG_PORT` 时接住异常并退出 1，避免顶层栈泄漏安装路径。
 */
let PORT;
try {
  PORT = resolvePort(process.env.ZG_DATA_DIR ? undefined : ROOT);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

/** 身份判定与 `doctor.mjs` 共用 `lib/instance.mjs`，避免两者结论矛盾。 */
const instance = createInstance({ dataDir: DATA_DIR, port: PORT, entry: ENTRY });
const { readState, pidAlive, probeHealth, inspect } = instance;
const { stateFile: STATE_FILE, base: BASE } = instance;

const HEALTH_TIMEOUT_MS = 20_000;
const HEALTH_INTERVAL_MS = 250;
const STOP_TIMEOUT_MS = 10_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** mkdir 的 mode 只在创建时生效，已存在且权限松的 data/ 要额外纠正。 */
async function ensureDataDir() {
  await mkdir(DATA_DIR, { recursive: true, mode: DIR_MODE });
  try {
    const st = await stat(DATA_DIR);
    if ((st.mode & 0o777) !== DIR_MODE) await chmod(DATA_DIR, DIR_MODE);
  } catch {
    // 改不动不阻塞启动;doctor 会单独报这一项。
  }
}

async function writeState(pid) {
  await writeFile(
    STATE_FILE,
    `${JSON.stringify({ pid, port: PORT, startedAt: new Date().toISOString() })}\n`,
    { mode: FILE_MODE },
  );
}

/**
 * 判断锁的持有者状态。按持有者身份而不是锁文件年龄判断 ——
 * mtime 从不刷新，按年龄抢占会让慢启动时的两个 start 双双 spawn。
 *   - 内容不可解析 / 进程已死 / cmdline 不是本脚本（PID 复用） → 可抢占
 *   - 进程存活且确是本脚本 → 并发 start，拒绝
 *   - 读不到 /proc → 保守拒绝，并给出恢复提示
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

  const isOurs = await pidRunsScript(pid, [SCRIPT]);
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
        // 非 EEXIST（如锁路径是目录）：给一句明确的话，不 rethrow 出带安装路径的栈。
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
         * 锁路径删不掉，典型是它是个目录（readFile 得 EISDIR 被当成「锁已消失」）。
         * 刻意不递归删除来历不明的目录，报清楚让用户处理。
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

/**
 * 在默认浏览器里打开管理后台。只在显式 `--open` / `npm run open` 时调用 ——
 * 脚本、ssh 环境里弹浏览器是骚扰。不引 `open` 之类的包，避免扩大供应链面。
 * 命令与参数分开传、不带 `shell: true`，URL 绝不进 shell。
 * 失败不影响退出码（服务已起来），但要打一行提示。
 */
function openBrowser(url) {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    const child = spawn(command, [url], { stdio: "ignore", detached: true });
    // 不让它把父进程吊住 —— 浏览器进程通常活得比本脚本久。
    child.unref();
    child.on("error", (err) => {
      console.error(`无法打开浏览器(${err.code ?? "未知错误"}),请手工访问:${url}`);
    });
    return true;
  } catch (err) {
    console.error(`无法打开浏览器(${err?.code ?? "未知错误"}),请手工访问:${url}`);
    return false;
  }
}

/**
 * 管理后台 URL：网关进程在独立端口上伺服 `dist/admin`（`server/adminSite.ts`），
 * 端口与服务端同一份解析（`resolveAdminPort`）。`ZG_ADMIN_PORT=0` 时没有后台页面。
 */
let ADMIN_PORT;
try {
  ADMIN_PORT = resolveAdminPort();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
const ADMIN_URL = ADMIN_PORT === 0 ? null : `http://127.0.0.1:${ADMIN_PORT}`;

/** 启动成功后的一行提示：网关地址 + 后台地址。 */
function started(pid) {
  console.log(`zen-gateway 已启动(pid ${pid}) → ${BASE}`);
  if (ADMIN_URL !== null) console.log(`管理后台 → ${ADMIN_URL}`);
}

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
      if (ADMIN_URL !== null) console.log(`管理后台 → ${ADMIN_URL}`);
      if (WANT_OPEN && ADMIN_URL !== null) openBrowser(ADMIN_URL);
      return 0;
    }

    if (st.foreignOnPort) {
      console.error(`端口 ${PORT} 已被另一个进程占用(pid ${st.health.pid}),不是本脚本启动的。`);
      console.error("先停掉它,否则两个实例会抢同一份 data/。");
      return 1;
    }

    // 本服务存活但不健康时绝不再 spawn：新进程会 EADDRINUSE 退出，清理逻辑会删掉原实例的状态文件。
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
     * 状态文件指向确认不是本服务的进程（PID 已复用）：继续启动。与 stop 有意不对称 ——
     * stop 发 SIGTERM 不可逆必须认准身份，start 只需端口空闲（foreignOnPort 已在上面拦下）。
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
        started(child.pid);
        if (WANT_OPEN && ADMIN_URL !== null) openBrowser(ADMIN_URL);
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

  // 存活但两条身份途径都没给出肯定答案 —— 拒绝发信号（PID 可能已被复用）。
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
   * stop 失败就中止：否则 start 看到旧进程「存活且健康」会打印「已在运行」并返回 0，
   * 用户以为新版本已生效。
   */
  if (code !== 0) {
    console.error("stop 未成功,已中止 restart(避免误以为新版本已生效)。");
    return code;
  }
  return start();
}

/** 只打开浏览器。服务没在跑时报错而不静默打开，否则用户会去排查前端。 */
async function open_() {
  const st = await inspect();
  if (!(st.identity === "ours" && st.healthy)) {
    console.error("服务未在运行,先 npm start。");
    return 1;
  }
  if (ADMIN_URL === null) {
    console.error("ZG_ADMIN_PORT=0,没有启动管理后台页面。");
    return 1;
  }
  return openBrowser(ADMIN_URL) ? 0 : 1;
}

/*
 * 用 Map 而不是对象字面量：`actions[cmd]` 会命中 Object.prototype 成员，
 * `service.mjs hasOwnProperty` 就能越过「未知命令」检查并抛出带路径的栈。
 */
const ACTIONS = new Map([
  ["start", start],
  ["stop", stop],
  ["status", status],
  ["restart", restart],
  ["open", open_],
]);

/** 先摘掉 `--open` 再取第一个位置参数作命令，`start --open` 与 `--open start` 都成立。 */
const argv = process.argv.slice(2);
const WANT_OPEN = argv.includes("--open");
const positional = argv.filter((a) => !a.startsWith("--"));

const cmd = positional[0] ?? "status";
const action = ACTIONS.get(cmd);
if (!action) {
  console.error(`未知命令:${cmd}(可用:${[...ACTIONS.keys()].join(" / ")})`);
  process.exit(2);
}
process.exit(await action());
