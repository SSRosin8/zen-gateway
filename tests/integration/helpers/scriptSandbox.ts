import { afterEach, beforeEach } from "vitest";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { ConfigSchema, CONFIG_VERSION, type Config } from "../../../src/shared/schema.ts";

/*
 * setup 与 doctor 两个脚本的运行沙箱。
 *
 * 只有真把脚本跑起来才测得到它们:`tsc` 看不到 `.mjs`,而这两个脚本的
 * 价值全在「分层判断对不对」「会不会改坏配置」上,那些都是行为。
 *
 * 每个用例用独立的临时 data/ 与独立端口,互不干扰,也绝不碰用户的真实实例。
 * Clash Controller 用一个**假的本机 HTTP 服务**冒充 —— 不依赖真实 Clash,
 * 否则这些测试会在没开 Clash 的机器上红,而红的原因与被测逻辑无关。
 *
 * 下面几个 `export let` 是 ESM 活绑定:用例读到的永远是当前用例的值。
 */

const execFileAsync = promisify(execFile);
const PROJECT = resolve(import.meta.dirname, "..", "..", "..");
export const DOCTOR = join(PROJECT, "scripts", "doctor.mjs");
export const SETUP = join(PROJECT, "scripts", "setup.mjs");
const ENTRY = join(PROJECT, "dist", "server", "server", "index.js");

export let dataDir: string;
export let port: number;
export let fakeClashPort: number;
let fakeClash: Server | undefined;
let strays: number[];

/**
 * 为当前测试文件注册沙箱。
 *
 * `firstPort` 由调用方给出,各文件的段必须互不重叠 —— 测试文件并行运行,
 * 且要避开 service.test.ts 的 19876+ 段与真实服务。每个用例占两个端口。
 */
export function useScriptSandbox(firstPort: number): void {
  let nextPort = firstPort;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "zg-scripts-"));
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
}

export type RunResult = { code: number; stdout: string; stderr: string };

export async function run(script: string, args: string[] = [], env: Record<string, string> = {}): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [script, ...args], {
      env: { ...process.env, ZG_DATA_DIR: dataDir, ZG_PROJECT_ROOT: dataDir, ZG_PORT: String(port), ...env },
      cwd: PROJECT,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

export const configFile = () => join(dataDir, "config.json");

/**
 * 默认上游指向一个不监听的回环端口：目录预热与第 6 层都确定地得到「不可达」，
 * 测试不连真实 Zen，也不因运行环境能否访问外网而改变结果。
 */
export const UNREACHABLE_UPSTREAM = "http://127.0.0.1:1/v1";

export async function writeConfig(overrides: Record<string, unknown> = {}): Promise<Config> {
  const config = ConfigSchema.parse({
    version: CONFIG_VERSION,
    gateway: { relayToken: "test-token-not-a-real-secret", port, baseUrl: UNREACHABLE_UPSTREAM },
    ...overrides,
  });
  await writeFile(configFile(), JSON.stringify(config, null, 2), { mode: 0o600 });
  return config;
}

/** 起一个真实服务实例。返回 pid。 */
export async function startServer(env: Record<string, string> = {}): Promise<number> {
  const child = spawn(process.execPath, [ENTRY], {
    cwd: PROJECT,
    env: { ...process.env, ZG_DATA_DIR: dataDir, ZG_PROJECT_ROOT: dataDir, ZG_PORT: String(port), ...env },
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
 * 只实现 setup/doctor 真正会问的几条:`/version`、`/configs`、`/proxies`、
 * `/rules`、`/dns/query`。`secret` 非空时校验 Bearer —— 那条分支
 * (「连上了但要鉴权」)必须可测,它是 setup 里最容易被合并进「没找到」的一态。
 */
export async function startFakeClash(opts: {
  secret?: string;
  mode?: string;
  mixedPort?: number | null;
  socksPort?: number;
  selectors?: Record<string, string[]>;
  nodes?: string[];
  /**
   * `/rules` 的目标分组（选分组的判据）。
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
  /** 显式规则表（含 payload），给了就代替 `rules`。 */
  ruleList?: Array<{ type: string; payload: string; proxy: string }>;
  /** `/dns/query` 对 A 记录的应答；不给则返回 404。 */
  dnsA?: string[];
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
    if (url.pathname === "/dns/query") {
      if (opts.dnsA === undefined) {
        res.writeHead(404);
        res.end();
        return;
      }
      const answer = url.searchParams.get("type") === "A" ? opts.dnsA.map((data) => ({ data })) : [];
      return json({ Answer: answer });
    }
    if (url.pathname === "/rules" && opts.ruleList !== undefined) return json({ rules: opts.ruleList });
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

export const fakeApi = () => `http://127.0.0.1:${fakeClashPort}`;
