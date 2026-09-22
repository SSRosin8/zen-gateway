import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PROJECT = resolve(import.meta.dirname, "..", "..");
const SCRIPT = join(PROJECT, "scripts", "service.mjs");
const ENTRY = join(PROJECT, "dist", "server", "server", "index.js");

/*
 * service.mjs 先前完全没有测试，审核在其中查出四个真实缺陷：
 * 误杀 PID 复用后的无关进程、restart 在 stop 失败后谎报成功、
 * 启动失败时误删活实例的状态文件、并发 start 双启动留下孤儿。
 * 这些都只有把脚本真的跑起来才测得到，故为集成测试。
 *
 * 每个用例用独立的临时 data/ 与独立端口，互不干扰，也不碰用户的真实实例。
 */

let dataDir: string;
let port: number;
/** 需要在用例结束后确保被清理的进程。 */
let strays: number[];

// 避开常用端口与其他用例；每个用例递增。
let nextPort = 19876;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "zg-svc-"));
  port = nextPort++;
  strays = [];
});

afterEach(async () => {
  // 先尝试用脚本自己停，再兜底强杀，避免测试遗留监听进程。
  await run(["stop"]).catch(() => {});
  for (const pid of strays) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* 已退出 */
    }
  }
  await rm(dataDir, { recursive: true, force: true });
});

type RunResult = { code: number; stdout: string; stderr: string };

async function run(args: string[]): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [SCRIPT, ...args], {
      env: { ...process.env, ZG_DATA_DIR: dataDir, ZG_PORT: String(port) },
      cwd: PROJECT,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

const statePath = () => join(dataDir, "zen-gateway.state.json");

async function writeState(pid: number): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await writeFile(statePath(), JSON.stringify({ pid, port }), "utf8");
}

async function stateExists(): Promise<boolean> {
  try {
    await stat(statePath());
    return true;
  } catch {
    return false;
  }
}

/** 一个与本服务无关的长命进程，用来模拟 PID 被系统复用。 */
function spawnUnrelated(): number {
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},600000)"], {
    stdio: "ignore",
    detached: true,
  });
  child.unref();
  strays.push(child.pid!);
  return child.pid!;
}

/**
 * 一个 cmdline 含入口路径、但**不监听端口**的进程 ——
 * 即「确实是本服务、但不健康」这一态。
 */
function spawnUnhealthyOurs(): number {
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},600000)", ENTRY], {
    stdio: "ignore",
    detached: true,
  });
  child.unref();
  strays.push(child.pid!);
  return child.pid!;
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("命令分发", () => {
  /*
   * actions 先前是对象字面量，于是 actions[cmd] 会命中 Object.prototype：
   * `service.mjs hasOwnProperty` 越过「未知命令」检查后调用继承来的方法，
   * 抛未捕获 TypeError，堆栈里带着安装的绝对路径，退出码还是 1 而不是 2。
   */
  it.each(["hasOwnProperty", "valueOf", "toString", "constructor", "__proto__"])(
    "原型链成员 %s 被当作未知命令，退出码 2",
    async (cmd) => {
      const r = await run([cmd]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("未知命令");
    },
  );

  it("未知命令不打印堆栈或绝对路径", async () => {
    const r = await run(["hasOwnProperty"]);
    expect(r.stderr).not.toMatch(/\n\s+at /);
    expect(r.stderr).not.toContain(PROJECT);
  });

  it("普通拼写错误也是退出码 2", async () => {
    expect((await run(["staart"])).code).toBe(2);
  });
});

describe("生命周期", () => {
  it("未运行时 status 报未在运行", async () => {
    const r = await run(["status"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("未在运行");
  });

  it("start → status → stop 正常流转", async () => {
    const started = await run(["start"]);
    expect(started.code, started.stderr).toBe(0);
    expect(started.stdout).toContain("已启动");

    const status = await run(["status"]);
    expect(status.code).toBe(0);
    expect(status.stdout).toContain("运行中");

    const stopped = await run(["stop"]);
    expect(stopped.code).toBe(0);
    expect(stopped.stdout).toContain("已停止");
    expect(await stateExists()).toBe(false);
  });

  it("重复 start 幂等，不再起第二个进程", async () => {
    await run(["start"]);
    const again = await run(["start"]);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain("已在运行");
  });

  it("重复 stop 幂等", async () => {
    await run(["start"]);
    await run(["stop"]);
    const again = await run(["stop"]);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain("未在运行");
  });

  it("restart 在正常情况下确实重启（pid 变化）", async () => {
    await run(["start"]);
    const before = JSON.parse(await readFile(statePath(), "utf8")).pid;

    const r = await run(["restart"]);
    expect(r.code, r.stderr).toBe(0);

    const after = JSON.parse(await readFile(statePath(), "utf8")).pid;
    expect(after).not.toBe(before);
  });
});

describe("进程身份验证", () => {
  it("状态文件指向无关进程时，stop 拒绝发信号", async () => {
    /*
     * PID 复用的实际路径：崩溃或重启留下状态文件 → Linux 把该 PID
     * 分给别的进程 → 用户 npm stop。先前的实现会直接 SIGTERM 掉它。
     */
    const victim = spawnUnrelated();
    await writeState(victim);

    const r = await run(["stop"]);

    expect(r.code).toBe(1);
    expect(r.stderr).toContain("无法确认");
    expect(alive(victim), "无关进程被误杀了").toBe(true);
  });

  it("状态文件被 PID 复用污染时，start 忽略陈旧记录并正常启动", async () => {
    /*
     * 与 stop 的谨慎是**有意的不对称**：
     * stop 要发 SIGTERM，不可逆，认不准身份就必须拒绝；
     * start 只需要端口空闲，而那条陈旧记录毫无价值 —— 拒绝启动只会逼
     * 用户手工删文件，却挡不住任何危险。端口真被占用由 foreignOnPort 分支拦下。
     */
    const victim = spawnUnrelated();
    await writeState(victim);

    const r = await run(["start"]);

    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("忽略该陈旧记录");
    expect(alive(victim), "无关进程被误杀了").toBe(true);

    // 状态文件必须已改指向真正启动的实例，否则 stop 停不掉。
    const recorded = JSON.parse(await readFile(statePath(), "utf8")).pid;
    expect(recorded).not.toBe(victim);
    expect(alive(recorded)).toBe(true);
  });

  it("状态文件指向已死进程时，直接当作未运行并清理", async () => {
    // 一个几乎不可能存在的 pid。
    await writeState(999_999);
    const r = await run(["stop"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("未在运行");
    expect(await stateExists()).toBe(false);
  });

  it("本服务实例存活但不健康时，start 不再 spawn 也不删状态文件", async () => {
    /*
     * 先前实现在这条路径上两个 guard 都要求 healthy，于是会再 spawn 一个，
     * 新进程因 EADDRINUSE 立刻死掉，清理逻辑接着删掉**原实例**的状态文件，
     * 把活着的服务变成孤儿：stop 与 status 都报「未在运行」，只能手工 kill。
     */
    const ours = spawnUnhealthyOurs();
    await writeState(ours);

    const r = await run(["start"]);

    expect(r.code).toBe(1);
    expect(r.stderr).toContain("健康检查未通过");
    expect(alive(ours), "原实例被杀").toBe(true);
    expect(await stateExists(), "活实例的状态文件被误删").toBe(true);
  });

  it("本服务实例卡死时，stop 仍能靠 cmdline 认出它并停掉", async () => {
    // 没有 cmdline 这条途径，就只能在「拒绝停止卡死的服务」和「盲杀 PID」间二选一。
    const ours = spawnUnhealthyOurs();
    await writeState(ours);

    const r = await run(["stop"]);

    expect(r.code, r.stderr).toBe(0);
    expect(alive(ours)).toBe(false);
  });
});

describe("restart 的失败传播", () => {
  it("stop 失败时 restart 不继续启动，也不报成功", async () => {
    /*
     * 先前实现丢弃 stop 的返回码：stop 正确失败后，start 看到
     * 「存活且健康」便打印「已在运行」并返回 0 —— 用户以为部署了新版本，
     * 实际跑的还是旧进程。
     */
    const victim = spawnUnrelated();
    await writeState(victim);

    const r = await run(["restart"]);

    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("已中止 restart");
    expect(alive(victim)).toBe(true);
  });
});

describe("并发启动", () => {
  it("两个 start 同时跑，只有一个成功启动，且不留孤儿", async () => {
    /*
     * 无锁时两者都会 spawn：一个抢到端口，另一个 EADDRINUSE 退出，
     * 而后写者把**已死**的 pid 留在状态文件里 —— 活着的那个成为孤儿，
     * stop 报「未在运行」而端口一直被占。
     */
    const [a, b] = await Promise.all([run(["start"]), run(["start"])]);

    const outputs = [a.stdout, b.stdout];
    expect(outputs.filter((o) => o.includes("已启动"))).toHaveLength(1);

    // 状态文件里的 pid 必须是活着的那个，否则 stop 停不掉。
    const recorded = JSON.parse(await readFile(statePath(), "utf8")).pid;
    expect(alive(recorded)).toBe(true);

    const stopped = await run(["stop"]);
    expect(stopped.code, stopped.stderr).toBe(0);
    expect(alive(recorded), "stop 之后仍有进程存活（孤儿）").toBe(false);
  });
});

describe("文件权限", () => {
  it("新建的 data/ 是 700，状态文件与日志是 600", async () => {
    await run(["start"]);

    expect((await stat(dataDir)).mode & 0o777).toBe(0o700);
    expect((await stat(statePath())).mode & 0o777).toBe(0o600);
    expect((await stat(join(dataDir, "zen-gateway.log"))).mode & 0o777).toBe(0o600);
  });

  it("已存在且权限过松的 data/ 会被纠正", async () => {
    /*
     * mkdir 的 mode 只在创建时生效。不纠正的话，755 的 data/ 会让
     * 其他本地用户列出并读取其中的日志与配置。
     */
    await mkdir(dataDir, { recursive: true });
    await chmod(dataDir, 0o755);

    await run(["start"]);

    expect((await stat(dataDir)).mode & 0o777).toBe(0o700);
  });
});
