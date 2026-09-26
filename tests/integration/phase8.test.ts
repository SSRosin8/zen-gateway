import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile, spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { ConfigSchema, CONFIG_VERSION, type Config } from "../../src/shared/schema.ts";

const execFileAsync = promisify(execFile);
const PROJECT = resolve(import.meta.dirname, "..", "..");
const DOCTOR = join(PROJECT, "scripts", "doctor.mjs");
const SETUP = join(PROJECT, "scripts", "setup.mjs");
const ENTRY = join(PROJECT, "dist", "server", "server", "index.js");

/*
 * Phase 8 的两个脚本。
 *
 * 只有真把脚本跑起来才测得到它们:`tsc` 看不到 `.mjs`,而这两个脚本的
 * 价值全在「分层判断对不对」「会不会改坏配置」上,那些都是行为。
 *
 * 每个用例用独立的临时 data/ 与独立端口,互不干扰,也绝不碰用户的真实实例。
 * Clash Controller 用一个**假的本机 HTTP 服务**冒充 —— 不依赖真实 Clash,
 * 否则这些测试会在没开 Clash 的机器上红,而红的原因与被测逻辑无关。
 */

let dataDir: string;
let port: number;
let fakeClash: Server | undefined;
let fakeClashPort: number;
let strays: number[];

// 避开 service.test.ts 的 19876+ 段与真实服务。
let nextPort = 19940;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "zg-p8-"));
  port = nextPort++;
  fakeClashPort = nextPort++;
  strays = [];
});

afterEach(async () => {
  for (const pid of strays) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* 已退出 */
    }
  }
  if (fakeClash !== undefined) {
    await new Promise<void>((r) => fakeClash!.close(() => r()));
    fakeClash = undefined;
  }
  await rm(dataDir, { recursive: true, force: true });
});

type RunResult = { code: number; stdout: string; stderr: string };

async function run(script: string, args: string[] = [], env: Record<string, string> = {}): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [script, ...args], {
      env: { ...process.env, ZG_DATA_DIR: dataDir, ZG_PORT: String(port), ...env },
      cwd: PROJECT,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

const configFile = () => join(dataDir, "config.json");

async function writeConfig(overrides: Record<string, unknown> = {}): Promise<Config> {
  const config = ConfigSchema.parse({
    version: CONFIG_VERSION,
    gateway: { relayToken: "test-token-not-a-real-secret", port },
    ...overrides,
  });
  await writeFile(configFile(), JSON.stringify(config, null, 2), { mode: 0o600 });
  return config;
}

/** 起一个真实服务实例。返回 pid。 */
async function startServer(env: Record<string, string> = {}): Promise<number> {
  const child = spawn(process.execPath, [ENTRY], {
    cwd: PROJECT,
    env: { ...process.env, ZG_DATA_DIR: dataDir, ZG_PORT: String(port), ...env },
    stdio: "ignore",
    detached: true,
  });
  child.unref();
  strays.push(child.pid!);

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
      if (res.ok) return child.pid!;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("服务在 20s 内未就绪");
}

/**
 * 一个冒充 Clash Controller 的本机 HTTP 服务。
 *
 * 只实现 setup/doctor 真正会问的三条:`/version`、`/configs`、`/proxies`。
 * `secret` 非空时校验 Bearer —— 那条分支(「连上了但要鉴权」)必须可测,
 * 它是 setup 里最容易被合并进「没找到」的一态。
 */
async function startFakeClash(opts: {
  secret?: string;
  mode?: string;
  mixedPort?: number | null;
  socksPort?: number;
  selectors?: Record<string, string[]>;
  nodes?: string[];
  /**
   * `/rules` 的目标分组（缺口 #22 的判据）。
   *
   * `undefined` = 不提供 `/rules`（旧内核形态）→ setup 退回按名字降级。
   * 给了就形如 `{ MATCH: "Proxy", Domain: ["DIRECT", "Proxy"] }` ——
   * 这里简化成"兜底目标 + 其余出现过的目标"。
   */
  rules?: { fallback: string; others?: string[] };
  /**
   * `true` = `/configs` 返 404（读不到选路模式）。
   *
   * doctor 此时按 `rule` 处理，那是**保守**的一侧 —— 误判成 rule 最坏只是
   * 多一条可核对的警告，误判成 global 会漏掉「切了不生效」的真故障。
   * 而那条默认值只有在 `/configs` 不可读时才走到，所以要能造出这个形态。
   */
  noConfigs?: boolean;
}): Promise<void> {
  const secret = opts.secret ?? "";
  const nodes = opts.nodes ?? ["节点A", "节点B"];
  const selectors = opts.selectors ?? { Proxy: nodes };

  fakeClash = createServer((req, res) => {
    if (secret !== "" && req.headers.authorization !== `Bearer ${secret}`) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "Unauthorized" }));
      return;
    }
    const url = new URL(req.url ?? "/", "http://x");
    const json = (body: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (url.pathname === "/version") return json({ version: "v1.19.31", meta: true });
    if (url.pathname === "/configs") {
      if (opts.noConfigs === true) {
        res.writeHead(404);
        res.end();
        return;
      }
      const body: Record<string, unknown> = { mode: opts.mode ?? "rule" };
      if (opts.mixedPort !== null) body["mixed-port"] = opts.mixedPort ?? 7897;
      else body["mixed-port"] = 0;
      if (opts.socksPort !== undefined) body["socks-port"] = opts.socksPort;
      return json(body);
    }
    if (url.pathname === "/rules") {
      if (opts.rules === undefined) {
        res.writeHead(404);
        res.end();
        return;
      }
      const rules: Array<{ type: string; proxy: string }> = [];
      for (const other of opts.rules.others ?? []) rules.push({ type: "Domain", proxy: other });
      // mihomo 报 "Match"（首字母大写）—— 归一化在生产代码里。
      rules.push({ type: "Match", proxy: opts.rules.fallback });
      return json({ rules });
    }
    if (url.pathname === "/proxies") {
      const proxies: Record<string, unknown> = {};
      for (const name of nodes) proxies[name] = { type: "AnyTLS", history: [{ delay: 120 }] };
      for (const [group, options] of Object.entries(selectors)) {
        proxies[group] = { type: "Selector", now: options[0] ?? "", all: options };
      }
      proxies["DIRECT"] = { type: "Direct" };
      return json({ proxies });
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((r) => fakeClash!.listen(fakeClashPort, "127.0.0.1", () => r()));
}

const fakeApi = () => `http://127.0.0.1:${fakeClashPort}`;

/* ================================================================== *
 * doctor:只读
 * ================================================================== */

describe("doctor 是只读的", () => {
  it("配置不存在时报缺失,且**不替用户生成**", async () => {
    /*
     * `loadConfig` 在文件不存在时会生成一份默认配置并写盘(含新 Relay Token)
     * —— 那对服务端是对的(首启),对诊断工具是错的:跑一次 doctor 就改了状态。
     *
     * 这条断言把「doctor 只读」钉住。变异测试:把 doctor 里的 `configExists`
     * 前置判断删掉(直接 loadConfig),这条必须转红。
     */
    const result = await run(DOCTOR);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("配置不存在");
    await expect(readFile(configFile(), "utf8")).rejects.toThrow(/ENOENT/);
  });

  it("不会跑数据库迁移 —— 库以 readOnly 打开", async () => {
    await writeConfig();
    /*
     * doctor 绝不能升级数据库档位:一个旧档位的库被一次「跑下 doctor 看看」
     * 升级掉是不可逆的,而用户可能正想用旧版程序读它。
     *
     * ## 这个 fixture 花了两次才对,两次都是变异测试逼出来的
     *
     * 1. **必须先起服务**:第 3 层在第 2 层之后,服务没跑时 doctor 在第 2 层
     *    就停了 —— 那样这条测试落在「路径不存在」那一类,断言永远绿。
     * 2. **库必须是真正空的文件**,不能只把已有库的 `user_version` 改回 0:
     *    那种库里表还在,于是 `migrate()` 撞上 `table worker_stats already
     *    exists` 而失败回滚,档位仍是 0 —— 变异体因此**看起来**没迁移。
     *    删掉文件重建后,区分状态才出现:变异体留下档位 3,真实实现留下 0。
     */
    await startServer();

    const { DatabaseSync } = await import("node:sqlite");
    const dbFile = join(dataDir, "runtime.db");
    // 服务已经建好并迁移过库了 —— 整个删掉,换成一个档位 0 的空文件。
    for (const suffix of ["", "-wal", "-shm"]) {
      await rm(`${dbFile}${suffix}`, { force: true });
    }
    const db = new DatabaseSync(dbFile);
    db.exec("PRAGMA user_version = 0");
    db.close();

    const result = await run(DOCTOR);
    // 确认真的走到了第 3 层 —— 否则下面的断言测的是「没跑过」而不是「只读」。
    expect(result.stdout).toContain("3. 统计库");

    const after = new DatabaseSync(dbFile, { readOnly: true });
    const version = (after.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    after.close();
    expect(version).toBe(0);
  }, 40_000);

  it("**不改权限** —— 过松的 config.json 与 data/ 要被报出来而不是被悄悄修掉", async () => {
    /*
     * 第八轮审核实测查出的一个真实缺陷。
     *
     * `loadConfig` 默认会把 `config.json` chmod 到 0600、`data/` 到 0700。
     * 那对**服务**是对的（凭证不该赌一句警告会被看见），但对诊断工具是错的,
     * 而 doctor 的文件头明写着「不改权限」。实测:755/644 跑完 doctor
     * 变成 700/600 —— 一次「跑下 doctor 看看」改掉了两个 inode 的权限。
     *
     * 更要紧的是第二层后果:**它把该报告的问题修掉了**。于是「权限过松」
     * 这一项在 doctor 里永远报不出来 —— 一个诊断工具结构上无法诊断
     * 它自己负责的一类问题。
     *
     * 断言同时钉两件事:权限**没被改**，且问题**被报出来**。
     * 只断言前者的话,一个什么都不查的实现也能通过。
     */
    await writeConfig();
    await chmod(configFile(), 0o644);
    await chmod(dataDir, 0o755);

    const result = await run(DOCTOR);

    // 一、报出来了（两项各自点名，而不是一句笼统的「权限有问题」）。
    expect(result.stdout).toContain("权限过松");
    expect(result.stdout).toContain("config.json 权限 644");
    expect(result.stdout).toContain("权限 755");

    // 二、真的没改。
    const fileMode = (await stat(configFile())).mode & 0o777;
    const dirMode = (await stat(dataDir)).mode & 0o777;
    expect(fileMode).toBe(0o644);
    expect(dirMode).toBe(0o755);

    /*
     * 三、它是 warn 而不是 fail —— 服务照样能跑,用户需要看到后面的层。
     * 若它阻断，「权限过松」会把一个能用的系统报成不能用。
     */
    expect(result.stdout).toContain("2. 服务");
  }, 40_000);
});

/* ================================================================== *
 * doctor:分层
 * ================================================================== */

describe("doctor 只报第一个失败的层", () => {
  it("第 1 层失败时不检查后面的层", async () => {
    await writeFile(configFile(), "{ not json", { mode: 0o600 });

    const result = await run(DOCTOR);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("配置无法加载(malformed)");
    expect(result.stdout).toContain("后续 6 层未检查");

    /*
     * 断言**后面的层真的没跑**,而不只是那句「未检查」被打了出来。
     *
     * 这条区别是变异测试逼出来的:把 `break` 删掉之后,那句「后续 6 层未检查」
     * **照样打印**(它在 break 之前),于是只检查那句话的版本依然全绿 ——
     * 而此时它已经是一句**假话**:后面的层全跑了。
     *
     * 所以要验的是标题行不存在。逐层标题形如 `── 3. 统计库 ──`。
     */
    for (const later of ["2. 服务", "3. 统计库", "4. Worker", "5. Clash 控制面", "6. 模型目录"]) {
      expect(result.stdout).not.toContain(`── ${later} ──`);
    }
  });

  it("配置的四种失败各有不同的下一步建议", async () => {
    /*
     * `ConfigError.kind` 是专为 doctor 准备的稳定分类,而分类的价值在于
     * **处置不同**。若四种给同一句建议,那个分类就是死信息。
     */
    await writeFile(configFile(), "{ not json", { mode: 0o600 });
    const malformed = await run(DOCTOR);

    await writeFile(configFile(), JSON.stringify({ version: 1, gateway: { relayToken: "tooshort" } }), {
      mode: 0o600,
    });
    const invalid = await run(DOCTOR);

    expect(malformed.stdout).toContain("修正 JSON 语法");
    expect(invalid.stdout).toContain("按上面的字段路径逐条修正");
    // 两条建议必须真的不同。
    expect(malformed.stdout).not.toContain("按上面的字段路径逐条修正");
  });

  it("服务没在跑时报第 2 层,并提到 NODE_EXTRA_CA_CERTS", async () => {
    await writeConfig();

    const result = await run(DOCTOR);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("服务未在运行");
    // 这条提示是规划要求「进交付物」的那条 —— 漏了它症状是「目录为空但不报错」。
    expect(result.stdout).toContain("NODE_EXTRA_CA_CERTS");
  });
});

describe("doctor 的第 6 层区分上游不可达与免费集为空", () => {
  it("上游拉不到时报 502 一侧,并指出服务进程缺 CA", async () => {
    await writeConfig({
      workers: [{ id: "w1", kind: "authenticated", apiKey: "fake-key-not-real", proxyId: null }],
    });
    /*
     * 服务**刻意不带** `NODE_EXTRA_CA_CERTS` 启动,而测试进程(以及 doctor)
     * 可能带着 —— 这正是纪律 #8 要验的事:doctor 报的必须是**服务进程**的
     * 环境,不是自己的。
     *
     * 若 doctor 读 `process.env` 而不是 `/proc/<服务pid>/environ`,
     * 在带 CA 的环境里跑这条会得到「已设,成因在别处」,断言转红。
     */
    await startServer({ NODE_EXTRA_CA_CERTS: "" });

    const result = await run(DOCTOR, [], {
      NODE_EXTRA_CA_CERTS: "/etc/ssl/certs/ca-certificates.crt",
    });

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("上游模型目录拉不到(502)");
    expect(result.stdout).toContain("服务进程没有设 NODE_EXTRA_CA_CERTS");
  }, 40_000);
});

/* ================================================================== *
 * setup:安全边界
 * ================================================================== */

describe("setup 的探测范围", () => {
  it("只探 127.0.0.1 的固定白名单,不扫 LAN、不扫端口段", async () => {
    await writeConfig();

    const result = await run(SETUP, ["--dry-run"]);

    /*
     * 这是规划明确列出的安全约束。断言输出里报告的候选**全部**是 127.0.0.1,
     * 且数量是个小的固定集合 —— 若有人把它改成扫端口段,数量会爆掉。
     */
    const tried = /已探测\(仅 127\.0\.0\.1\):(.+)/.exec(result.stdout)?.[1] ?? "";
    const candidates = tried.split(", ").filter(Boolean);

    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.length).toBeLessThanOrEqual(8);
    for (const c of candidates) {
      expect(new URL(c).hostname).toBe("127.0.0.1");
    }
  });

  it("「连上了但要 secret」与「没找到」是两态", async () => {
    await writeConfig();
    await startFakeClash({ secret: "a-secret-we-do-not-know" });

    const result = await run(SETUP, ["--api", fakeApi(), "--dry-run"]);

    expect(result.code).toBe(1);
    /*
     * 把 auth 合进 absent 是最容易犯的错:那会让一个配了 secret 的 Clash
     * 被报成「没找到」,用户于是去查 Clash 是否运行 —— 而它正在运行。
     */
    expect(result.stdout).toContain("需要 secret");
    expect(result.stdout).not.toContain("没有找到本机的 Clash Controller");
  });
});

/* ================================================================== *
 * setup:不丢用户数据
 * ================================================================== */

describe("setup 不动用户自己的东西", () => {
  it("保留 Relay Token、Worker 的 key、以及被停用的内核", async () => {
    const token = "user-token-must-survive-setup";
    await startFakeClash({});
    /*
     * 已存在的内核**必须是 setup 这次会重新发现的那一个**(同 id),
     * 否则走不到「更新已有条目」那条分支,而关于它的断言就是空壳 ——
     * 变异测试实测过:把 `existing.enabled = true` 注进更新分支时,
     * 用一个探测不到的端口(9999)做 fixture 的版本**依然全绿**。
     *
     * id 由 setup 从 apiBase 推导(`bridge-<host>-<port>`),所以这里
     * 照同一个规则构造 —— 让 fixture 与被测代码指向同一个条目。
     */
    const rediscoveredId = `bridge-127.0.0.1-${fakeClashPort}`;
    await writeFile(
      configFile(),
      JSON.stringify(
        ConfigSchema.parse({
          version: CONFIG_VERSION,
          gateway: { relayToken: token, port },
          workers: [{ id: "mine", kind: "authenticated", apiKey: "MY-KEY", proxyId: null }],
          clash: {
            enabled: true,
            selectionMode: "manual",
            activeBridgeId: null,
            bridges: [
              {
                id: rediscoveredId,
                name: "用户改过的名字",
                enabled: false,
                apiBase: fakeApi(),
                apiSecret: "",
                localProxyPort: 1080,
                selectorGroup: "Proxy",
              },
            ],
          },
        }),
      ),
      { mode: 0o600 },
    );

    const result = await run(SETUP, ["--api", fakeApi()]);
    expect(result.code).toBe(0);

    const after = JSON.parse(await readFile(configFile(), "utf8")) as Config;

    expect(after.gateway.relayToken).toBe(token);
    expect(after.workers).toHaveLength(1);
    expect(after.workers[0]!.apiKey).toBe("MY-KEY");

    // 确认真的走了「更新」而不是「新增」—— 否则下面的断言又是空壳。
    expect(after.clash.bridges).toHaveLength(1);
    const old = after.clash.bridges.find((b) => b.id === rediscoveredId);
    // 探测得来的事实要更新:端口从 1080 改成内核实际报告的值。
    expect(old?.localProxyPort).toBe(7897);
    // 而用户刻意停用的内核不该被重新启用 —— 那是撤销他的决定。
    expect(old?.enabled).toBe(false);
    expect(old?.name).toBe("用户改过的名字");
    // 他选的 manual 模式也不动。
    expect(after.clash.selectionMode).toBe("manual");
  });

  it("重跑不会重复添加(id 从节点名稳定推导)", async () => {
    await writeConfig();
    await startFakeClash({ nodes: ["节点A", "节点B", "节点C"] });

    await run(SETUP, ["--api", fakeApi()]);
    const first = JSON.parse(await readFile(configFile(), "utf8")) as Config;

    await run(SETUP, ["--api", fakeApi()]);
    const second = JSON.parse(await readFile(configFile(), "utf8")) as Config;

    /*
     * 不稳定的 id(随机或序号)会让每次 setup 都新增一批代理,而旧的那批
     * 仍被 Worker 引用 —— 配置越长越乱,Worker 绑的出口悄悄变成陈旧条目。
     */
    expect(first.proxies).toHaveLength(3);
    expect(second.proxies).toHaveLength(3);
    expect(second.proxies.map((p) => p.id).sort()).toEqual(first.proxies.map((p) => p.id).sort());
    expect(second.clash.bridges).toHaveLength(1);
  });

  it("写盘前备份,且备份是改动**之前**的内容", async () => {
    await writeConfig();
    await startFakeClash({});

    await run(SETUP, ["--api", fakeApi()]);

    const backup = JSON.parse(await readFile(`${configFile()}.bak`, "utf8")) as Config;
    const current = JSON.parse(await readFile(configFile(), "utf8")) as Config;

    // config.json 整个文件都是凭证,自动改写必须有可回退的副本。
    expect(backup.clash.bridges).toHaveLength(0);
    expect(current.clash.bridges).toHaveLength(1);
  });

  it("--dry-run 完全不写盘", async () => {
    const before = await writeConfig();
    await chmod(configFile(), 0o644);
    await chmod(dataDir, 0o755);
    const beforeFileStat = await stat(configFile());
    const beforeDirStat = await stat(dataDir);
    await startFakeClash({});

    await run(SETUP, ["--api", fakeApi(), "--dry-run"]);

    const after = JSON.parse(await readFile(configFile(), "utf8")) as Config;
    expect(after).toEqual(before);
    await expect(readFile(`${configFile()}.bak`, "utf8")).rejects.toThrow(/ENOENT/);
    expect((await stat(configFile())).mode & 0o777).toBe(0o644);
    expect((await stat(dataDir)).mode & 0o777).toBe(0o755);
    expect((await stat(configFile())).mtimeMs).toBe(beforeFileStat.mtimeMs);
    expect((await stat(dataDir)).mtimeMs).toBe(beforeDirStat.mtimeMs);
  });
});

/* ================================================================== *
 * setup:端口与分组的判断
 * ================================================================== */

describe("setup 从 Controller 读端口,不硬编码", () => {
  it("采用内核实际报告的 mixed-port,而不是文档默认的 7890", async () => {
    await writeConfig();
    // 一个刻意与任何常见默认值都不同的端口。
    await startFakeClash({ mixedPort: 24680 });

    await run(SETUP, ["--api", fakeApi()]);
    const after = JSON.parse(await readFile(configFile(), "utf8")) as Config;

    /*
     * 硬编码任何一个值都会让桥接静默连到没人监听的端口:所有桥接代理
     * 传输失败,而控制面明明是通的 —— 本项目最难自查的故障之一。
     */
    expect(after.clash.bridges[0]!.localProxyPort).toBe(24680);
    for (const proxy of after.proxies) expect(proxy.port).toBe(24680);
  });

  it("mixed-port 为 0 时拒绝把 socks-port 冒充 HTTP 混合端口", async () => {
    await writeConfig();
    await startFakeClash({ mixedPort: null, socksPort: 13579 });

    const result = await run(SETUP, ["--api", fakeApi()]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("无法从 /configs 读出可用的代理端口");
    const after = JSON.parse(await readFile(configFile(), "utf8")) as Config;
    expect(after.clash.bridges).toHaveLength(0);
  });

  it("三个端口都为 0 时**拒绝配置**,而不是猜一个默认值", async () => {
    await writeConfig();
    await startFakeClash({ mixedPort: null });

    const result = await run(SETUP, ["--api", fakeApi()]);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("无法从 /configs 读出可用的代理端口");
    const after = JSON.parse(await readFile(configFile(), "utf8")) as Config;
    expect(after.clash.bridges).toHaveLength(0);
  });
});

describe("setup 对 GLOBAL 分组的处置", () => {
  it("rule 模式下宁选 Proxy 也不选 GLOBAL(即使节点数相同)", async () => {
    await writeConfig();
    /*
     * 实测出来的陷阱:本机 GLOBAL 与 Proxy 都是 69 个可用节点,按名字
     * tiebreak 会选中 GLOBAL —— 而 rule 模式下 GLOBAL **不参与选路**,
     * 切它什么都不改变。后果是所有 Worker 共用同一个公网 IP,
     * 而出口隔离正是本项目存在的理由。这个故障不报任何错。
     */
    const nodes = ["节点A", "节点B"];
    await startFakeClash({ mode: "rule", nodes, selectors: { GLOBAL: nodes, Proxy: nodes } });

    await run(SETUP, ["--api", fakeApi()]);
    const after = JSON.parse(await readFile(configFile(), "utf8")) as Config;

    expect(after.clash.bridges[0]!.selectorGroup).toBe("Proxy");
  });

  it("**按规则的实际目标选分组** —— 名字启发式会选错的那个形态（缺口 #22）", async () => {
    /*
     * 先前的判据是**名字**：rule 模式下把叫 `GLOBAL` 的降级。
     * 登记时就写明了它的漏洞：一个名字不叫 GLOBAL 却同样不参与选路的分组
     * 仍会被选中。
     *
     * 这里构造正是那个形态：两个分组 `Airport`（节点多）与 `Proxy`（节点少），
     * 都不叫 GLOBAL，而规则的兜底目标是 **`Proxy`**。
     * 按名字＋节点数会选 `Airport`（69 > 2，且字母序也在前）——
     * 而切它什么都不会改变，因为规则从不把流量导向它。
     *
     * 真实判据来自 `/rules`：实测本机 556 条规则里 `Proxy` 382 条、
     * `GLOBAL` 零条，而 MATCH 指向 `Proxy`。
     */
    const many = Array.from({ length: 69 }, (_, i) => `节点${i}`);
    await startFakeClash({
      mode: "rule",
      nodes: many,
      selectors: { Airport: many, Proxy: many.slice(0, 2) },
      // 规则只把流量导向 Proxy —— Airport 从不出现。
      rules: { fallback: "Proxy", others: ["DIRECT"] },
    });
    await writeConfig();

    const result = await run(SETUP, ["--api", fakeApi()]);

    expect(result.code).toBe(0);
    // 选了规则实际导向的那个，而不是节点更多、名字更靠前的那个。
    expect(result.stdout).toContain("分组「Proxy」");
    expect(result.stdout).not.toContain("分组「Airport」");
  }, 40_000);

  it("**兜底(MATCH)目标优先于只承载部分规则的分组** —— 转发到上游走的是兜底那条", async () => {
    /*
     * 上一条区分的是「在规则里」与「不在规则里」。这一条区分更细的一档：
     * 两个分组**都**出现在规则里，只有一个是兜底（`MATCH`）目标。
     *
     * 为什么兜底更优先：转发到 `opencode.ai` 时命中的是兜底那条规则
     * —— 一条 MATCH 覆盖所有没被前面规则匹配掉的域名。一个只承载
     * 「某几个国内域名走它」的分组即使规则条数更多，也不是上游流量实际
     * 走的那个。这正是缺口 #4（探测目标与转发目标不同域）的核心。
     *
     * 构造：`Partial` 节点更多（按节点数会选它）且承载一条规则，
     * 而兜底指向节点更少的 `Fallback`。少了 rank 0 这一档，两者都是
     * 「在规则里」，于是节点数决定胜负 —— 选错。
     */
    const many = Array.from({ length: 69 }, (_, i) => `节点${i}`);
    await startFakeClash({
      mode: "rule",
      nodes: many,
      selectors: { Partial: many, Fallback: many.slice(0, 2) },
      // 两个分组都在规则里，但兜底是 Fallback。
      rules: { fallback: "Fallback", others: ["Partial", "DIRECT"] },
    });
    await writeConfig();

    const result = await run(SETUP, ["--api", fakeApi()]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("分组「Fallback」");
    expect(result.stdout).not.toContain("分组「Partial」");
  }, 40_000);

  it("**doctor 报出「选中的分组不参与选路」**（缺口 #22/#4）", async () => {
    /*
     * 这是那个"不报任何错"的故障：控制面通、切换返回 204、探测也能拿到 IP，
     * 只是每个 Worker 拿到**同一个** IP。先前只有 `--deep` 的隔离报告会发现它，
     * 而那需要用户想到去跑。
     *
     * 现在 doctor 第 5 层直接查 `/rules`：选中的分组若不出现在任何规则里，
     * 就报 warn 并说清后果。实测本机 `GLOBAL` 正是零条规则。
     */
    const nodes = ["节点A", "节点B"];
    await startFakeClash({
      mode: "rule",
      nodes,
      selectors: { GLOBAL: nodes, Proxy: nodes },
      // 规则只导向 Proxy —— GLOBAL 零条。
      rules: { fallback: "Proxy", others: ["DIRECT"] },
    });
    // 配置**刻意**指向 GLOBAL（用户手改、或旧版 setup 选的）。
    await writeConfig({
      workers: [{ id: "w1", kind: "authenticated", apiKey: "fake-key-not-real", proxyId: "p1" }],
      proxies: [
        {
          id: "p1", name: "桥接节点", type: "anytls", host: "127.0.0.1", port: 7897,
          source: "controller", bridgeId: "b1", clashNodeName: "节点A",
          direct: false, bridgeable: true, egressIp: null,
        },
      ],
      clash: {
        enabled: true,
        selectionMode: "manual",
        activeBridgeId: "b1",
        bridges: [
          {
            id: "b1", name: "假内核", apiBase: fakeApi(), apiSecret: "",
            localProxyPort: 7897, selectorGroup: "GLOBAL",
          },
        ],
      },
    });
    await startServer();

    const result = await run(DOCTOR);

    expect(result.stdout).toContain("── 5. Clash 控制面 ──");
    expect(result.stdout).toContain("不出现在任何路由规则里");
    // 要说清后果 —— 否则用户不知道这条警告为什么要紧。
    expect(result.stdout).toContain("共用同一个公网 IP");
    /*
     * 这一层的**状态**也必须升到 warn，不只是详情里多几行字。
     *
     * 状态决定行首标记（`!` 对 `✓`）与结尾汇总是否列出这一条。少了提升，
     * doctor 会一边在第 5 层印出「共用同一个公网 IP」、一边把那一层标成
     * 通过 —— 一条自相矛盾的输出比没有输出更糟。
     *
     * 断言查的是行首标记而不是结尾的「N 条告警」：这个形态下第 6 层
     * （真上游目录）必然失败，doctor 就此 break，永远走不到结尾汇总。
     */
    expect(result.stdout).toMatch(/! 1\/1 个 Clash 内核可连通/);
    expect(result.stdout).not.toMatch(/✓ 1\/1 个 Clash 内核可连通/);
  }, 40_000);

  it("读不到选路模式时**仍然检查**（默认按 rule，保守的那一侧）", async () => {
    /*
     * `/configs` 不可读时 doctor 把 mode 当 `rule` —— 那是内核默认值，
     * 也是保守的一侧。默认成 `global` 会跳过整项检查，于是
     * 「切了不生效」这个本来就不报错的故障彻底静默。
     *
     * 这条形态是那行默认值的**唯一**触发路径：其余用例的假内核都供着
     * `/configs`，所以把 `?? "rule"` 改成 `?? "global"` 在它们眼里毫无差别。
     */
    const nodes = ["节点A", "节点B"];
    await startFakeClash({
      noConfigs: true,
      nodes,
      selectors: { GLOBAL: nodes, Proxy: nodes },
      rules: { fallback: "Proxy", others: ["DIRECT"] },
    });
    await writeConfig({
      workers: [{ id: "w1", kind: "authenticated", apiKey: "fake-key-not-real", proxyId: "p1" }],
      proxies: [
        {
          id: "p1", name: "桥接节点", type: "anytls", host: "127.0.0.1", port: 7897,
          source: "controller", bridgeId: "b1", clashNodeName: "节点A",
          direct: false, bridgeable: true, egressIp: null,
        },
      ],
      clash: {
        enabled: true,
        selectionMode: "manual",
        activeBridgeId: "b1",
        bridges: [
          {
            id: "b1", name: "假内核", apiBase: fakeApi(), apiSecret: "",
            localProxyPort: 7897, selectorGroup: "GLOBAL",
          },
        ],
      },
    });
    await startServer();

    const result = await run(DOCTOR);

    expect(result.stdout).toContain("不出现在任何路由规则里");
    // 同上：查行首标记，不查结尾汇总（第 6 层会先失败并 break）。
    expect(result.stdout).toMatch(/! 1\/1 个 Clash 内核可连通/);
  }, 40_000);

  it("拿不到 `/rules` 时退回按名字降级 —— 降级而不是失败", async () => {
    /*
     * 旧内核可能没有 `/rules` 端点。那时启发式对最常见的形态仍然有效
     * （本机 GLOBAL 与 Proxy 节点数相同），所以退回它而不是放弃配置。
     */
    const nodes = ["节点A", "节点B"];
    // 不给 rules → 假 Clash 对 /rules 返 404。
    await startFakeClash({ mode: "rule", nodes, selectors: { GLOBAL: nodes, Proxy: nodes } });
    await writeConfig();

    const result = await run(SETUP, ["--api", fakeApi()]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("分组「Proxy」");
  }, 40_000);

  it("global 模式下 GLOBAL 不再被降级", async () => {
    await writeConfig();
    // 只有 GLOBAL 一个分组,且内核确实是 global 模式 —— 此时它是对的那个。
    const nodes = ["节点A", "节点B"];
    await startFakeClash({ mode: "global", nodes, selectors: { GLOBAL: nodes } });

    const result = await run(SETUP, ["--api", fakeApi()]);
    const after = JSON.parse(await readFile(configFile(), "utf8")) as Config;

    expect(after.clash.bridges[0]!.selectorGroup).toBe("GLOBAL");
    // 不该出现那条「切换它可能不生效」的告警。
    expect(result.stdout).not.toContain("切换它可能不生效");
  });

  it("rule 模式下只有 GLOBAL 可用时照样配,但必须告警", async () => {
    await writeConfig();
    const nodes = ["节点A"];
    await startFakeClash({ mode: "rule", nodes, selectors: { GLOBAL: nodes } });

    const result = await run(SETUP, ["--api", fakeApi()]);
    const after = JSON.parse(await readFile(configFile(), "utf8")) as Config;

    expect(after.clash.bridges[0]!.selectorGroup).toBe("GLOBAL");
    // 用户必须知道这件事才能去 Clash 里加一个分组。
    expect(result.stdout).toContain("切换它可能不生效");
  });
});

/* ================================================================== *
 * setup:不建没有 key 的 Worker
 * ================================================================== */

describe("setup 刻意不创建 Worker", () => {
  it("只配出口,并说明认证与匿名 Worker 都可由用户创建", async () => {
    await writeConfig();
    await startFakeClash({});

    const result = await run(SETUP, ["--api", fakeApi()]);
    const after = JSON.parse(await readFile(configFile(), "utf8")) as Config;

    /*
     * 规划原文是「为每个可用出口建匿名 Worker」,而匿名(免 key)通道已被
     * 上游关闭。建一批没有 key 的 Worker 只会得到一池必定失败的条目 ——
     * `isUsable()` 把它们全过滤掉,而用户看到「已建 N 个 Worker」却一个都不能用。
     */
    expect(after.workers).toHaveLength(0);
    expect(after.proxies.length).toBeGreaterThan(0);
    expect(result.stdout).toContain("匿名 Worker");
  });
});

/* ================================================================== *
 * 凭证不进输出
 * ================================================================== */

describe("两个脚本都不回显凭证", () => {
  it("setup 的输出不含 Controller secret", async () => {
    const secret = "controller-secret-must-not-leak";
    await writeConfig();
    await startFakeClash({ secret });

    const result = await run(SETUP, ["--api", fakeApi(), "--secret", secret]);

    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain(secret);
    expect(result.stderr).not.toContain(secret);
  });

  it("doctor 的输出不含 Relay Token 与 Controller secret", async () => {
    const secret = "another-secret-must-not-leak";
    const token = "relay-token-must-not-leak-either";
    await startFakeClash({ secret: "wrong-on-purpose" });
    await writeFile(
      configFile(),
      JSON.stringify(
        ConfigSchema.parse({
          version: CONFIG_VERSION,
          gateway: { relayToken: token, port },
          workers: [{ id: "w1", kind: "authenticated", apiKey: "k", proxyId: "p1" }],
          proxies: [
            {
              id: "p1",
              name: "n",
              type: "anytls",
              host: "127.0.0.1",
              port: 7897,
              source: "controller",
              bridgeId: "b1",
              clashNodeName: "节点A",
              direct: false,
              bridgeable: true,
            },
          ],
          clash: {
            enabled: true,
            activeBridgeId: "b1",
            bridges: [
              {
                id: "b1",
                name: "fake",
                apiBase: fakeApi(),
                apiSecret: secret,
                localProxyPort: 7897,
                selectorGroup: "Proxy",
              },
            ],
          },
        }),
      ),
      { mode: 0o600 },
    );
    await startServer();

    const result = await run(DOCTOR);

    // 鉴权失败那条路径最容易顺手把 secret 拼进错误信息。
    expect(result.stdout).toContain("鉴权被拒");
    expect(result.stdout).not.toContain(secret);
    expect(result.stdout).not.toContain(token);
  }, 40_000);
});

/* ================================================================== *
 * doctor 第 4 层报运行期就绪态（缺口 #24）
 * ================================================================== */

describe("doctor 第 4 层问服务要就绪态，而不是自己算", () => {
  it("服务在跑时报的是**就绪**数，不只是配置形态", async () => {
    /*
     * 这一层先前只报配置形态，并在输出里写着「是否就绪 doctor 查不到」——
     * 而 Phase 9 之后那句话不再成立：`GET /api/overview` 带 `ready` 与
     * `cooldownRemainingMs`，且 doctor 本来就已经在问服务（第 6 层查 /v1/models）。
     *
     * **关键是"问"而不是"算"**：在 doctor 里重新实现一遍冷却判定会是第二份
     * 并行真相（纪律 #4），且必然与调度器分叉 —— 那时 doctor 说「就绪」
     * 而转发说「在冷却」，两句话都出自本项目。
     */
    await writeConfig({
      workers: [{ id: "w1", kind: "authenticated", apiKey: "fake-key-not-real", proxyId: null }],
    });
    await startServer();

    const result = await run(DOCTOR);

    // 先确认真的走到了第 4 层 —— 否则下面的断言测的是「没跑过」。
    expect(result.stdout).toContain("── 4. Worker ──");
    // 就绪数（新）而不是「N 个 Worker 可用」（旧的纯配置形态措辞）。
    expect(result.stdout).toMatch(/\d+\/\d+ 个 Worker 就绪/);
    // 那句「doctor 查不到」的免责声明不该再出现 —— 它现在查得到了。
    expect(result.stdout).not.toContain("是否**就绪**(不在冷却中)\n   doctor 查不到");
  }, 40_000);

  it("拿不到运行期状态时**降级**成只报形态，而不是失败", async () => {
    /*
     * 服务可能刚好在重启，或 `/api/overview` 因某个原因不可用。
     * 那时配置形态本身仍然是有效信息 —— 报不出就绪态不该让整层变红。
     *
     * ## 这个 fixture 花了两次
     *
     * 第一版用一个**假服务器**冒充（只答 /health，其余 404）。不成立：
     * 第 2 层的身份判定**正确地**把它报成「端口被另一个进程占用」，
     * 于是第 4 层根本不执行 —— 那是「路径不存在」那一类，断言测不到降级。
     * 而那个拒绝恰好证明了身份判定是承重的。
     *
     * 改用**真实服务 + 立刻杀掉**：doctor 的第 2 层读状态文件与 `/health`，
     * 它在服务刚死时仍可能通过（状态文件还在），而 `/api/overview` 已经不应答。
     * 若第 2 层也失败，断言 `4. Worker` 不出现同样是对的结论 ——
     * 所以这里断言的是「要么降级、要么第 4 层没跑」，而**绝不是** fail。
     */
    await writeConfig({
      workers: [{ id: "w1", kind: "authenticated", apiKey: "fake-key-not-real", proxyId: null }],
    });
    const pid = await startServer();

    // 杀掉服务 —— 状态文件留着，而端点不再应答。
    process.kill(pid, "SIGKILL");
    await new Promise((r) => setTimeout(r, 300));

    const result = await run(DOCTOR);

    /*
     * 关键断言：**第 4 层绝不因为"拿不到运行期状态"而报 fail**。
     *
     * 两种可接受的结局：第 2 层就停了（服务确实没了），或第 4 层降级成
     * 只报形态。不可接受的是第 4 层红着 —— 那会把「服务重启中」
     * 报成「Worker 配置有问题」，指向一个完全错误的方向。
     */
    const reachedLayer4 = result.stdout.includes("── 4. Worker ──");
    if (reachedLayer4) {
      expect(result.stdout).toContain("仅配置形态");
      expect(result.stdout).toContain("未检查");
    } else {
      // 第 2 层先失败 —— 那是对的，而且它必须是"服务未在运行"一类。
      expect(result.stdout).toContain("2. 服务");
    }
  }, 40_000);
});

/* ================================================================== *
 * 未识别的参数（第十轮审核实际踩到的那个）
 * ================================================================== */

describe("两个脚本都拒绝未识别的参数", () => {
  /*
   * 这不是假想的形态 —— 第十轮审核的一个子 agent 想看用法，敲了
   * `npm run setup - --help`，而 setup 把两个参数都静默忽略并**执行了完整的
   * 真实导入**：写 `data/config.json`（代理 3→72、桥接 2→3）加一个 `.bak`。
   * `data/config.json` 是唯一一份凭证存储（Worker apiKey、Relay Token、
   * Controller secret），所以「想读用法反而改写了凭证」是最坏的一种误用后果。
   *
   * 那个脚本自己有 `--dry-run`，也就是它承认「写盘前该让人先看一眼」——
   * 而未识别参数被忽略恰好绕过了那个机会。
   */

  it("**`setup --help` 打印用法且一个字节都不写**", async () => {
    const result = await run(SETUP, ["--help"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("用法");
    expect(result.stdout).toContain("--dry-run");
    // 这条是全部要点：读用法不该有副作用。
    await expect(stat(configFile())).rejects.toThrow();
  });

  it("**`setup` 对未识别参数退出码非 0 且不写盘**", async () => {
    const result = await run(SETUP, ["--typo"]);

    expect(result.code).not.toBe(0);
    expect(result.stdout).toContain("未识别的参数");
    expect(result.stdout).toContain("--typo");
    await expect(stat(configFile())).rejects.toThrow();
  });

  it("裸 `-` 也算未识别 —— 那正是审核踩到的写法", async () => {
    const result = await run(SETUP, ["-", "--help"]);

    /*
     * `--help` 在第二位。校验按顺序走，先撞上 `-` 就停 —— 报错优先于帮助，
     * 因为「参数写错了」比「这是帮助」更需要被看见。
     */
    expect(result.code).not.toBe(0);
    expect(result.stdout).toContain("未识别的参数: -");
    await expect(stat(configFile())).rejects.toThrow();
  });

  it("带值的 flag 缺值时报错，而不是把下一个参数当值吃掉", async () => {
    const result = await run(SETUP, ["--api"]);

    expect(result.code).not.toBe(0);
    expect(result.stdout).toContain("--api 需要一个值");
    await expect(stat(configFile())).rejects.toThrow();
  });

  it("带值的 flag **正常传值时不被误判**为未识别", async () => {
    /*
     * 与上一条配对：少了它，一个「把所有带值 flag 都当未识别」的实现
     * 也能让前面几条通过。这里只要求它**走过了参数校验**（错误信息不是
     * 「未识别」），后续探测失败与否无关。
     */
    const result = await run(SETUP, ["--api", "http://127.0.0.1:1", "--secret", "x"]);

    expect(result.stdout).not.toContain("未识别的参数");
    expect(result.stdout).not.toContain("需要一个值");
  });

  it("`doctor` 同样拒绝，而合法的 `--deep` 不受影响", async () => {
    const bad = await run(DOCTOR, ["--typo"]);
    expect(bad.code).not.toBe(0);
    expect(bad.stdout).toContain("未识别的参数");

    /*
     * `--deep` 只验**没有被参数校验拦下**（它会真发网络请求，这里不跑到那步）。
     * 判据是错误信息不含「未识别」—— 第 1 层配置不存在会让它早早退出。
     */
    const good = await run(DOCTOR, ["--deep"]);
    expect(good.stdout).not.toContain("未识别的参数");
  });

  it("`--help` 提示 npm 调用要加 `--` —— 那是这个陷阱的高频入口", async () => {
    /*
     * `npm run setup --dry-run` 会被 npm 自己吃掉 flag，脚本收不到，
     * 于是「我加了 --dry-run 它却写盘了」。症状与未识别参数被忽略完全一样，
     * 所以用法里必须写清。
     */
    const result = await run(SETUP, ["--help"]);
    expect(result.stdout).toContain("--");
    expect(result.stdout).toMatch(/npm run setup -- /);
  });
});
