/**
 * 「端口上那个进程是不是我们的」—— 实例身份判定的唯一实现，
 * `service.mjs`（能否发 SIGTERM）与 `doctor.mjs`（第 2 层）共用，避免两者给出矛盾结论。
 *
 * 两条独立途径：
 *   1. `/health` 回报的 pid 与状态文件一致 —— 服务健康时的强证明
 *   2. `/proc/<pid>/cmdline` 含我们的入口路径 —— 服务卡死不应答时的兜底
 * 两条都不成立就拒绝断言身份，宁可让用户手工处理，也不杀不认识的进程。
 *
 * 刻意不 import zod / HealthSchema：会让 `npm run status` 的启动时间翻倍
 * （见 `store/paths.ts`）。这里只做结构检查（`ok` + 整数 `pid` + `version`），
 * 足以挡住恰好回 `{"ok":true}` 的别的本机服务；完整契约由 `doctor.mjs` 再验。
 */

import { readFile, readlink } from "node:fs/promises";
import { join, resolve } from "node:path";

/**
 * 构造一个实例视图。`dataDir` / `port` / `entry` 必须成套使用，
 * 用 A 目录的状态文件去探 B 端口的健康是无意义的，所以在工厂里一处绑定。
 */
export function createInstance({ dataDir, port, entry, altEntries = [] }) {
  const stateFile = join(dataDir, "zen-gateway.state.json");
  const base = `http://127.0.0.1:${port}`;
  /**
   * 认得出「是我们的代码」的全部入口。`entry` 是构建产物（`npm start`），
   * `altEntries` 是其他启动方式（如 `npm run dev:server`，没有状态文件）。
   * `service.mjs` 只认 `entry`，`doctor.mjs` 要认全部。
   */
  const knownEntries = [entry, ...altEntries];

  /** 状态文件。内容不可信 —— pid 可能已被系统复用，也可能是半截写入。 */
  async function readState() {
    try {
      const raw = JSON.parse(await readFile(stateFile, "utf8"));
      const pid = Number.parseInt(raw?.pid, 10);
      if (!Number.isInteger(pid) || pid <= 0) return null;
      return { pid, port: Number(raw?.port) || port, startedAt: raw?.startedAt ?? null };
    } catch {
      return null;
    }
  }

  function pidAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      // EPERM = 进程存在但不属于当前用户 —— 存活，但绝不是我们启的。
      return err?.code === "EPERM";
    }
  }

  /** 探一次 `/health`。结构不合的一律当作「不是我们的服务」返回 null。 */
  async function probeHealth(timeoutMs = 1000) {
    try {
      const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) return null;
      const body = await res.json();
      if (body?.ok !== true) return null;
      // pid 是判定身份的那个字段，缺了它这次应答对我们毫无用处。
      if (typeof body.pid !== "number" || !Number.isInteger(body.pid)) return null;
      if (typeof body.version !== "string") return null;
      return body;
    } catch {
      return null;
    }
  }

  /**
   * 把「端口上在跑什么」「状态文件指向什么」「它是不是我们的」一次问清。
   *
   * 只读，不做任何清理：在「存活但不健康」路径上顺手删状态文件，
   * 会删掉活着的实例的记录，之后 stop/status 都报「未在运行」。
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
        const byCmdline = await pidRunsScript(state.pid, knownEntries);
        if (byCmdline === true) identity = "ours";
        else if (byCmdline === false) identity = "foreign";
      }
    }

    /*
     * 「端口上是本项目的服务，但不是 service.mjs 启的」（典型：dev:server）。
     * 只给事实不给结论：service.mjs 仍拒绝对它发信号，doctor 据此如实描述，
     * 而不是让用户去查一个其实是他自己启动的进程。只能靠 cmdline 判定。
     */
    let unregisteredOurs = false;
    if (health !== null && state === null) {
      unregisteredOurs = (await pidRunsScript(health.pid, knownEntries)) === true;
    }

    return {
      state,
      health,
      alive,
      identity,
      healthy: health !== null,
      /** 端口上有服务，但不是状态文件记录的那个（或根本没有状态文件）。 */
      foreignOnPort: health !== null && (state === null || health.pid !== state.pid),
      /** 那个「陌生」进程其实跑的是本项目的代码（典型：npm run dev:server）。 */
      unregisteredOurs,
    };
  }

  return { base, stateFile, readState, pidAlive, probeHealth, inspect };
}

/**
 * `data/` 的位置，与 `src/store/paths.ts` 的 `dataDir()` 保持同一套优先级。
 * 不 import 它：`.mjs` 引 TypeScript 要走 strip-only 模式，有额外启动开销。
 */
export function dataDirOf(root) {
  const override = process.env.ZG_DATA_DIR;
  return override !== undefined && override !== "" ? resolve(override) : join(root, "data");
}

/**
 * 进程的 cmdline 是否指向 `paths` 之一。cmdline 里的路径可能是相对的，必须按持有者的
 * cwd（`/proc/<pid>/cwd`）解析，读不到才退回本进程 cwd；直接比较会把真实并发判成 PID 复用。
 * 返回 `null` 表示途径不可用（非 Linux、无权读 /proc），与 `false`（确认不是）区分。
 */
export async function pidRunsScript(pid, paths) {
  let cmdline;
  try {
    cmdline = await readFile(`/proc/${pid}/cmdline`, "utf8");
  } catch {
    return null;
  }

  let cwd = process.cwd();
  try {
    cwd = await readlink(`/proc/${pid}/cwd`);
  } catch {
    /* 退回本进程 cwd */
  }

  const args = cmdline.split("\0").filter(Boolean);
  return args.some((arg) => paths.some((p) => arg === p || resolve(cwd, arg) === p));
}
