import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DEFAULT_PORT, PortResolveError, resolvePort } from "../../src/store/port.ts";

const execFileAsync = promisify(execFile);
const PROJECT = resolve(import.meta.dirname, "..", "..");

/**
 * 端口解析的唯一真相 —— 以及「三处调用点都从它取值」这条约束。
 *
 * ## 为什么这一组必须存在
 *
 * 端口曾在三处各自手写解析:`server/index.ts`(真正监听的)、
 * `scripts/service.mjs`(健康等待要探的)、`vite.config.ts`(dev 代理要转发的)。
 *
 * 前两处脱节时(服务端改成读配置、脚本仍只认 ZG_PORT)集成测试会全红,
 * `service.test.ts` 的「端口解析与服务端一致」组守着它们 —— **但那组只覆盖两处**。
 * 第三处 `vite.config.ts` 若硬编码 `9876`,而配置的 `gateway.port` 是别的值,
 * 症状比"端口写错"隐蔽得多:dev server 照常起、页面照常开,只是 `/health`
 * 与 `/api` 被转发到**另一个进程** —— 若恰好另有服务
 * 监听 9876,admin 拿到的就是那个服务的响应。一个"看起来在工作但数据来自
 * 错误后端"的故障,不报任何错。
 *
 * 这是验证纪律第 4 条(守卫必须从唯一真相推导)的又一例,而且**是那条守卫
 * 自己的覆盖缺口**:它只钉了它恰好想到的那两处。所以下面除了逐项验证行为,
 * 还加了一条**结构性**断言:三个文件里都不得出现端口字面量。
 */

describe("resolvePort — 端口解析的唯一真相", () => {
  let root: string;
  let savedEnv: { port: string | undefined; dataDir: string | undefined };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "zg-port-"));
    savedEnv = { port: process.env["ZG_PORT"], dataDir: process.env["ZG_DATA_DIR"] };
    delete process.env["ZG_PORT"];
    delete process.env["ZG_DATA_DIR"];
  });

  afterEach(async () => {
    if (savedEnv.port === undefined) delete process.env["ZG_PORT"];
    else process.env["ZG_PORT"] = savedEnv.port;
    if (savedEnv.dataDir === undefined) delete process.env["ZG_DATA_DIR"];
    else process.env["ZG_DATA_DIR"] = savedEnv.dataDir;
    await rm(root, { recursive: true, force: true });
  });

  async function writeConfig(body: unknown): Promise<void> {
    await mkdir(join(root, "data"), { recursive: true, mode: 0o700 });
    await writeFile(join(root, "data", "config.json"), JSON.stringify(body), { mode: 0o600 });
  }

  it("读 config.json 的 gateway.port", async () => {
    await writeConfig({ version: 1, gateway: { port: 12345 } });
    expect(resolvePort(root)).toBe(12345);
  });

  it("ZG_PORT 优先于配置", async () => {
    await writeConfig({ version: 1, gateway: { port: 12345 } });
    process.env["ZG_PORT"] = "23456";
    expect(resolvePort(root)).toBe(23456);
  });

  it("配置不存在时用默认端口 —— 首启不该因此失败", () => {
    expect(resolvePort(root)).toBe(DEFAULT_PORT);
  });

  it("配置损坏时用默认端口,不抛错", async () => {
    /*
     * 刻意不在这里报错:服务端加载配置时会给出真正的原因(含 zod 的字段级报错),
     * 在这里抢先报一个「配置读不到」会把那条更有用的消息盖掉。
     */
    await mkdir(join(root, "data"), { recursive: true, mode: 0o700 });
    await writeFile(join(root, "data", "config.json"), "{ 这不是 JSON", { mode: 0o600 });
    expect(resolvePort(root)).toBe(DEFAULT_PORT);
  });

  it("配置里 port 不是合法端口时用默认值", async () => {
    for (const bad of [0, -1, 70000, 1.5, "8080", null, undefined, {}]) {
      await writeConfig({ version: 1, gateway: { port: bad } });
      expect(resolvePort(root), `port=${JSON.stringify(bad)}`).toBe(DEFAULT_PORT);
    }
  });

  it("非法 ZG_PORT **抛错**而不静默回落", async () => {
    /*
     * 回落会让「我明明设了 ZG_PORT」变成一个查不出的问题:服务起在别的端口上,
     * 而用户以为自己指定了。
     */
    await writeConfig({ version: 1, gateway: { port: 12345 } });
    for (const bad of ["abc", "0", "-1", "70000", "8080.5", " "]) {
      process.env["ZG_PORT"] = bad;
      expect(() => resolvePort(root), `ZG_PORT=${bad}`).toThrow(PortResolveError);
    }
  });

  it("空 ZG_PORT 视为未设置,不抛错", async () => {
    // 空串是 shell 里 `ZG_PORT= cmd` 的常见形态,把它当非法值会挡住正常用法。
    await writeConfig({ version: 1, gateway: { port: 12345 } });
    process.env["ZG_PORT"] = "";
    expect(resolvePort(root)).toBe(12345);
  });

  it("不传 root 时认 ZG_DATA_DIR", async () => {
    await writeConfig({ version: 1, gateway: { port: 15151 } });
    process.env["ZG_DATA_DIR"] = join(root, "data");
    expect(resolvePort()).toBe(15151);
  });
});

describe("三处调用点都从 resolvePort 取值", () => {
  /** 三个需要知道端口的文件。 */
  const SITES = [
    "src/server/index.ts",
    "scripts/service.mjs",
    "vite.config.ts",
  ] as const;

  it("每个文件都 import resolvePort", async () => {
    for (const site of SITES) {
      const text = await readFile(join(PROJECT, site), "utf8");
      expect(text, `${site} 必须从 store/port.ts 取端口`).toMatch(
        /import\s*\{[^}]*resolvePort[^}]*\}\s*from\s*["'][^"']*store\/port\.ts["']/,
      );
    }
  });

  it("**没有任何文件出现端口字面量** —— 这是先前漏掉 vite.config.ts 的根因", async () => {
    /*
     * 行为断言(下一条)只能证明"当前值一致";而一旦有人写回字面量,
     * 只要那个字面量恰好等于当前配置,行为断言就不会红。所以这里加一条
     * 结构性断言,直接禁掉字面量本身。
     *
     * 只在代码里禁:注释与文档要能自由地讲"默认是 9876"。
     */
    for (const site of SITES) {
      const text = await readFile(join(PROJECT, site), "utf8");
      const code = text
        // 块注释
        .replace(/\/\*[\s\S]*?\*\//g, "")
        /*
         * 行注释。
         *
         * `(?<!:)` 不可省:没有它,`http://127.0.0.1:9876` 里的 `//` 会被当成
         * 行注释起点,于是整行被删掉 —— 而 URL 恰恰是端口字面量最可能出现的
         * 地方,这条断言会对真正要防的形态完全失效。
         *
         * 少了它,变异测试把 vite 代理改回硬编码 9876 后,只有行为断言变红、
         * 这条结构断言依然绿 —— 一个结构上无法失败的空壳。
         */
        .replace(/(?<!:)\/\/[^\n]*/g, "");
      const hits = [...code.matchAll(/\b(98[0-9]{2}|7890|17891)\b/g)].map((m) => m[0]);
      expect(hits, `${site} 的代码里不得出现端口字面量(注释里可以)`).toEqual([]);
    }
  });

  it("`store/port.ts` 是唯一允许写默认端口的地方", async () => {
    const text = await readFile(join(PROJECT, "src/store/port.ts"), "utf8");
    // 它必须真的定义了那个默认值,否则上一条断言等于禁掉了所有人却没人负责。
    expect(text).toMatch(/export const DEFAULT_PORT = \d+/);
    expect(DEFAULT_PORT).toBe(9876);
  });

  it("vite 的 dev 代理目标 = resolvePort() 的结果", async () => {
    /*
     * 行为断言:直接加载 vite.config.ts 读它算出来的 target。
     *
     * 它正是那个 bug 会被抓住的地方 —— 硬编码 9876 时,
     * 只要 config.json 里是别的端口,它就会红。
     */
    const mod = (await import("../../vite.config.ts")) as {
      default: { server?: { proxy?: Record<string, { target: string }> } };
      createViteConfig: () => { server?: { proxy?: Record<string, { target: string }> } };
    };
    const proxy = mod.default.server?.proxy;
    expect(proxy).toBeDefined();

    const expected = `http://127.0.0.1:${resolvePort(PROJECT)}`;
    expect(proxy!["/health"]!.target).toBe(expected);
    expect(proxy!["/api"]!.target).toBe(expected);
  });

  it("Vite 代理在设置 ZG_DATA_DIR 时读取该目录的配置端口", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "zg-vite-data-"));
    const dataDir = join(dataRoot, "data");
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    await writeFile(
      join(dataDir, "config.json"),
      JSON.stringify({ version: 1, gateway: { port: 24680 } }),
      { mode: 0o600 },
    );

    const previous = process.env.ZG_DATA_DIR;
    try {
      process.env.ZG_DATA_DIR = dataDir;
      const mod = (await import("../../vite.config.ts")) as {
        createViteConfig: () => { server?: { proxy?: Record<string, { target: string }> } };
      };
      const proxy = mod.createViteConfig().server?.proxy;
      expect(proxy?.["/health"]?.target).toBe("http://127.0.0.1:24680");
      expect(proxy?.["/api"]?.target).toBe("http://127.0.0.1:24680");
    } finally {
      if (previous === undefined) delete process.env.ZG_DATA_DIR;
      else process.env.ZG_DATA_DIR = previous;
      await rm(dataRoot, { recursive: true, force: true });
    }
  });
});

describe("service.mjs 对非法 ZG_PORT 的处置", () => {
  it("报一句人话,不打栈、不泄漏安装路径", async () => {
    /*
     * `resolvePort` 在模块顶层被调用,抛错若不接住就是一段未捕获异常的栈 ——
     * 而那段栈**带着安装的绝对路径**。同类问题
     * (原型链命令分发泄漏路径且退出码错误)出现过,所以这条守卫要常驻。
     *
     * 退出码本身已由 `tests/integration/service.test.ts` 的
     * 「ZG_PORT 非法时明确报错」钉住(**1**),这里不重复断言它,只补它没覆盖的
     * 两件事:不打栈、不泄漏路径。
     *
     * 退出码不改成 2("用法错误该是 2",与未知命令一致):那是一个已被钉住的
     * 对外行为,合并端口解析不该顺手变更它。
     */
    const env: NodeJS.ProcessEnv = { ...process.env, ZG_PORT: "not-a-port" };
    let code = 0;
    let stderr = "";
    try {
      await execFileAsync(process.execPath, [join(PROJECT, "scripts", "service.mjs"), "status"], {
        env,
        cwd: PROJECT,
      });
    } catch (err) {
      const e = err as { code?: number; stderr?: string };
      code = e.code ?? 1;
      stderr = e.stderr ?? "";
    }

    expect(code).not.toBe(0);
    expect(stderr).toContain("ZG_PORT 不是合法端口");
    // 不得出现堆栈帧,也不得出现安装路径。
    expect(stderr).not.toMatch(/\n\s+at\s/);
    expect(stderr).not.toContain(PROJECT);
  });
});

describe("默认端口只有一个值", () => {
  it("schema 的默认端口与 DEFAULT_PORT 相同", async () => {
    // schema.ts 进浏览器构建、不能 import store，两处各写一次；这里防止它们分叉。
    const { ConfigSchema, CONFIG_VERSION } = await import("../../src/shared/schema.ts");
    const parsed = ConfigSchema.parse({ version: CONFIG_VERSION, gateway: { relayToken: "test-token-not-a-real-secret" } });
    expect(parsed.gateway.port).toBe(DEFAULT_PORT);
  });
});
