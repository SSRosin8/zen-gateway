import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { freePort } from "./helpers/freePort.ts";

const execFileAsync = promisify(execFile);
const PROJECT = resolve(import.meta.dirname, "..", "..");
const SCRIPT = join(PROJECT, "scripts", "service.mjs");
const ENTRY = join(PROJECT, "dist", "server", "server", "index.js");

/*
 * 这组测试守 service.mjs 的四类缺陷：
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


/*
 * 首启会生成指向真实 Zen 的默认配置，目录预热随即访问外网：结果随运行环境变化，
 * 生命周期用例也不该依赖网络。预先写一份上游不可达的最小配置；需要验证首启或
 * 端口解析的用例自己覆盖这份文件。
 */
async function writeOfflineConfig(): Promise<void> {
  await writeFile(
    join(dataDir, "config.json"),
    JSON.stringify({
      version: 1,
      gateway: { relayToken: "service-test-token-not-real", baseUrl: "http://127.0.0.1:1/v1" },
    }),
    { mode: 0o600 },
  );
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "zg-svc-"));
  port = await freePort();
  strays = [];
  await writeOfflineConfig();
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
      env: { ...process.env, ZG_DATA_DIR: dataDir, ZG_PROJECT_ROOT: dataDir, ZG_PORT: String(port) },
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

describe("优雅停机", () => {
  it("长 SSE 未结束时 stop 仍在脚本的等待时限内完成,且流被断开", async () => {
    const TOKEN = "service-shutdown-token-not-real";
    const upstreamStreams: import("node:http").ServerResponse[] = [];
    const { createServer } = await import("node:http");
    const upstream = createServer((req, res) => {
      if (req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "big-pickle" }] }));
        return;
      }
      // 只发一块就挂住,模拟一条持续很久的 SSE。
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"x"}}]}\n\n');
      upstreamStreams.push(res);
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    const upstreamPort = (upstream.address() as import("node:net").AddressInfo).port;
    try {
      await mkdir(dataDir, { recursive: true, mode: 0o700 });
      await writeFile(
        join(dataDir, "config.json"),
        JSON.stringify({
          version: 1,
          gateway: { relayToken: TOKEN, baseUrl: `http://127.0.0.1:${upstreamPort}/v1` },
          workers: [
            { id: "w1", name: "", kind: "authenticated", apiKey: "fake-key-not-real", enabled: true, proxyId: null },
          ],
        }),
        { mode: 0o600 },
      );
      const started = await run(["start"]);
      expect(started.code, started.stderr).toBe(0);

      const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "big-pickle", stream: true, messages: [] }),
      });
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      // 确认流真的开始了,停机时它是一条在途请求。
      expect((await reader.read()).done).toBe(false);
      const rest = (async () => {
        try {
          for (;;) if ((await reader.read()).done) return "ended";
        } catch {
          return "cut";
        }
      })();

      const t0 = Date.now();
      const stopped = await run(["stop"]);
      const elapsed = Date.now() - t0;
      expect(stopped.code, stopped.stderr).toBe(0);
      expect(stopped.stdout).toContain("已停止");
      // 脚本等 10 秒;停机须在它之前自行完成。
      expect(elapsed).toBeLessThan(10_000);
      expect(["ended", "cut"]).toContain(await rest);
    } finally {
      for (const s of upstreamStreams) s.destroy();
      upstream.closeAllConnections();
      await new Promise<void>((r) => upstream.close(() => r()));
    }
  }, 30_000);
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

describe("端口解析与服务端一致", () => {
  /*
   * 服务端读 `config.gateway.port`，service.mjs 若不同步读取同一来源，
   * 脚本就会去探一个没人监听的端口，健康等待超时后报「启动失败」，
   * 而服务其实已经起来了。设了 ZG_PORT 的用例能抓到这一方向。
   *
   * 但**反方向需要单独覆盖**：用户在 config.json 里改 `gateway.port`、不设 ZG_PORT
   * 时两处是否仍一致？那恰恰是真实用户的用法（ZG_PORT 只是测试与调试用的）。
   * 下面两条把这个方向也钉住。
   */

  /** 只写出 port，其余字段交给服务端用默认值补齐。 */
  async function writeConfigPort(p: number): Promise<void> {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    await writeFile(
      join(dataDir, "config.json"),
      JSON.stringify({
        version: 1,
        gateway: { port: p, relayToken: "service-test-token-not-real", baseUrl: "http://127.0.0.1:1/v1" },
      }),
      { mode: 0o600 },
    );
  }

  /** 不注入 ZG_PORT 的 run —— 逼两处都从 config.json 解析端口。 */
  async function runWithoutEnvPort(args: string[]): Promise<RunResult> {
    // 显式标注为可选键的字典：字面量推导出的类型里没有 ZG_PORT，delete 会被拒。
    const env: NodeJS.ProcessEnv = { ...process.env, ZG_DATA_DIR: dataDir, ZG_PROJECT_ROOT: dataDir };
    delete env["ZG_PORT"];
    try {
      const { stdout, stderr } = await execFileAsync(process.execPath, [SCRIPT, ...args], {
        env,
        cwd: PROJECT,
      });
      return { code: 0, stdout, stderr };
    } catch (err) {
      const e = err as { code?: number; stdout?: string; stderr?: string };
      return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
    }
  }

  it("不设 ZG_PORT 时，两处都认 config.json 的 gateway.port", async () => {
    const configured = await freePort();
    await writeConfigPort(configured);

    const started = await runWithoutEnvPort(["start"]);
    expect(started.code, started.stderr).toBe(0);
    // 脚本打印的地址必须是配置里的端口 —— 若它回落到 9876，这里就会不符。
    expect(started.stdout).toContain(String(configured));

    // 而且服务真的在那个端口上应答（证明脚本探的与服务端听的是同一个）。
    const res = await fetch(`http://127.0.0.1:${configured}/health`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);

    const stopped = await runWithoutEnvPort(["stop"]);
    expect(stopped.code).toBe(0);
  });

  it("ZG_PORT 优先于 config.json —— 两处的优先级必须相同", async () => {
    // 配置里写一个端口，环境变量给另一个；服务必须听环境变量那个。
    const ignored = await freePort();
    await writeConfigPort(ignored);

    const started = await run(["start"]); // run() 会注入 ZG_PORT=port
    expect(started.code, started.stderr).toBe(0);

    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);

    // 配置里那个端口上不该有东西在听。
    await expect(fetch(`http://127.0.0.1:${ignored}/health`)).rejects.toThrow();
  });

  it("配置端口改了但还没重启：status/stop 仍找到运行中的实例，restart 换到新端口", async () => {
    /*
     * 后台可以改 `gateway.port`，而监听端口要重启才换。脚本若只按新端口探，
     * 会把运行中的实例报成「未在运行」，restart 停不掉它，新进程再启动就留下两个实例。
     */
    const first = await freePort();
    const second = await freePort();
    await writeConfigPort(first);
    expect((await runWithoutEnvPort(["start"])).code).toBe(0);

    await writeConfigPort(second);
    const st = await runWithoutEnvPort(["status"]);
    expect(st.code, st.stdout).toBe(0);
    expect(st.stdout).toContain(String(first));
    expect(st.stdout).toContain(`已改为 ${second}`);

    const restarted = await runWithoutEnvPort(["restart"]);
    expect(restarted.code, restarted.stderr).toBe(0);
    expect(restarted.stdout).toContain(String(second));
    await expect(fetch(`http://127.0.0.1:${first}/health`)).rejects.toThrow();
    expect((await fetch(`http://127.0.0.1:${second}/health`)).status).toBe(200);

    expect((await runWithoutEnvPort(["stop"])).code).toBe(0);
    await expect(fetch(`http://127.0.0.1:${second}/health`)).rejects.toThrow();
  });

  it("ZG_PORT 非法时明确报错，不静默回落", async () => {
    // 静默回落会让「我明明设了 ZG_PORT」变成一个查不出的问题。
    const env = { ...process.env, ZG_DATA_DIR: dataDir, ZG_PROJECT_ROOT: dataDir, ZG_PORT: "not-a-port" };
    const r = await execFileAsync(process.execPath, [SCRIPT, "status"], { env, cwd: PROJECT }).then(
      () => ({ code: 0, stderr: "" }),
      (err: { code?: number; stderr?: string }) => ({ code: err.code ?? 1, stderr: err.stderr ?? "" }),
    );

    expect(r.code).toBe(1);
    expect(r.stderr).toContain("ZG_PORT");
  });
});
