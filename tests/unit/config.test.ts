import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile, mkdir, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConfigError,
  configExists,
  configPath,
  dataDir,
  defaultConfig,
  generateRelayToken,
  loadConfig,
  saveConfig,
} from "../../src/store/config.ts";
import { ConfigSchema } from "../../src/shared/schema.ts";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zg-config-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** 直接写一份 config.json，绕过 saveConfig，用于构造各种坏文件。 */
async function writeRaw(text: string): Promise<void> {
  await mkdir(join(root, "data"), { recursive: true, mode: 0o700 });
  await writeFile(configPath(root), text, "utf8");
}

describe("首次启动", () => {
  it("文件不存在时生成默认配置并写盘", async () => {
    expect(await configExists(root)).toBe(false);

    const { config, created } = await loadConfig(root);

    expect(created).toBe(true);
    expect(await configExists(root)).toBe(true);
    expect(config.version).toBe(1);
    expect(config.workers).toEqual([]);
  });

  it("自动生成 Relay Token,不是空值", async () => {
    const { config } = await loadConfig(root);
    // 旧项目默认空 token 等于本机任何进程都能白用网关,而那是默认行为而非用户选择。
    expect(config.gateway.relayToken.length).toBeGreaterThanOrEqual(16);
    expect(config.gateway.relayToken).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("每次生成的 Token 不同", () => {
    const a = generateRelayToken();
    const b = generateRelayToken();
    expect(a).not.toBe(b);
  });

  it("写出的文件是 0600", async () => {
    await loadConfig(root);
    const st = await stat(configPath(root));
    expect(st.mode & 0o777).toBe(0o600);
  });

  it("data 目录是 0700", async () => {
    await loadConfig(root);
    const st = await stat(join(root, "data"));
    expect(st.mode & 0o777).toBe(0o700);
  });
});

describe("损坏与非法配置", () => {
  it("非法 JSON 报错且不回显文件内容", async () => {
    await writeRaw('{ "gateway": { "relayToken": "SUPER-SECRET-TOKEN-VALUE" } ,,, }');

    const err = await loadConfig(root).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConfigError);
    const text = `${(err as ConfigError).message}${(err as ConfigError).detail ?? ""}`;
    // V8 的 JSON 报错会带出错位置附近的原文片段 —— 这个文件每一行都可能是凭证。
    expect(text).not.toContain("SUPER-SECRET-TOKEN-VALUE");
    expect((err as ConfigError).kind).toBe("malformed");
  });

  it("校验失败时报出字段路径但不回显字段值", async () => {
    await writeRaw(
      JSON.stringify({
        version: 1,
        gateway: { relayToken: "太短", baseUrl: "https://ok.invalid/v1" },
      }),
    );

    const err = (await loadConfig(root).catch((e: unknown) => e)) as ConfigError;

    expect(err.kind).toBe("invalid");
    expect(err.message).toContain("gateway.relayToken");
    expect(err.message).not.toContain("太短");
  });

  it("损坏的配置绝不被自动覆盖", async () => {
    const original = '{ "broken": true ,,, }';
    await writeRaw(original);

    await loadConfig(root).catch(() => {});

    // 自动覆盖会把用户的配置连同凭证一起丢掉。
    expect(await readFile(configPath(root), "utf8")).toBe(original);
  });

  it("顶层不是对象时报 malformed", async () => {
    await writeRaw("[1,2,3]");
    const err = (await loadConfig(root).catch((e: unknown) => e)) as ConfigError;
    expect(err.kind).toBe("malformed");
  });

  it("缺 version 时报错,不猜测格式", async () => {
    // 本项目不从任何旧项目导入配置 —— 缺 version 就是配置坏了。
    await writeRaw(JSON.stringify({ gateway: { relayToken: generateRelayToken() } }));
    const err = (await loadConfig(root).catch((e: unknown) => e)) as ConfigError;
    expect(err.kind).toBe("invalid");
    expect(err.message).toContain("version");
  });

  it.each([["字符串", "1"], ["小数", 1.5], ["零", 0], ["负数", -1]])(
    "version 是 %s 时报错",
    async (_label, version) => {
      await writeRaw(JSON.stringify({ version, gateway: { relayToken: generateRelayToken() } }));
      const err = (await loadConfig(root).catch((e: unknown) => e)) as ConfigError;
      expect(err.kind).toBe("invalid");
    },
  );

  it("version 高于本程序支持时提示升级程序,不降级配置", async () => {
    await writeRaw(JSON.stringify({ version: 99, gateway: { relayToken: generateRelayToken() } }));
    const err = (await loadConfig(root).catch((e: unknown) => e)) as ConfigError;
    expect(err.message).toContain("升级");
  });

  it("未知字段被拒绝 —— 手工编辑拼错字段名必须立刻暴露", async () => {
    const cfg = defaultConfig();
    await writeRaw(JSON.stringify({ ...cfg, gatewy: {} }));
    const err = (await loadConfig(root).catch((e: unknown) => e)) as ConfigError;
    expect(err.kind).toBe("invalid");
  });
});

describe("权限修正", () => {
  it("加载时把 0644 的文件改回 0600", async () => {
    const cfg = defaultConfig();
    await writeRaw(JSON.stringify(cfg));
    await chmod(configPath(root), 0o644);

    await loadConfig(root);

    const st = await stat(configPath(root));
    expect(st.mode & 0o777).toBe(0o600);
  });

  it.each([0o755, 0o777, 0o750])("加载时把 %s 的 data/ 目录改回 0700", async (mode) => {
    /*
     * `mkdir(…, { mode })` 只在**创建时**生效,已存在且权限过松的 data/
     * 不会被纠正 —— 于是其他本地用户能列目录并读到 runtime.db 与日志。
     *
     * service.mjs 里有一份等价逻辑,但任何不经它的入口(脚本、测试、
     * `npm run dev:server`)都只走 config.ts,所以两处都需要。
     */
    const cfg = defaultConfig();
    await writeRaw(JSON.stringify(cfg));
    await chmod(join(root, "data"), mode);

    await loadConfig(root);

    expect((await stat(join(root, "data"))).mode & 0o777).toBe(0o700);
  });

  it("保存时也纠正过松的目录权限", async () => {
    const { config } = await loadConfig(root);
    await chmod(join(root, "data"), 0o755);

    await saveConfig(config, root);

    expect((await stat(join(root, "data"))).mode & 0o777).toBe(0o700);
  });
});

describe("ZG_DATA_DIR", () => {
  /*
   * service.mjs 认这个环境变量,config.ts 先前不认 —— 于是 service.mjs 在一个
   * 目录里管状态文件,而服务端从 `cwd/data` 读配置,凭证与运行时数据被劈成两份。
   * Phase 0-2 的服务端还不读配置,所以那只是个陷阱;Phase 3 起就是真 bug。
   */
  it("不传 root 时遵循 ZG_DATA_DIR", async () => {
    const override = await mkdtemp(join(tmpdir(), "zg-override-"));
    const previous = process.env["ZG_DATA_DIR"];
    process.env["ZG_DATA_DIR"] = override;
    try {
      expect(dataDir()).toBe(override);
      expect(configPath()).toBe(join(override, "config.json"));

      const { created } = await loadConfig();
      expect(created).toBe(true);
      expect((await stat(join(override, "config.json"))).mode & 0o777).toBe(0o600);
    } finally {
      if (previous === undefined) delete process.env["ZG_DATA_DIR"];
      else process.env["ZG_DATA_DIR"] = previous;
      await rm(override, { recursive: true, force: true });
    }
  });

  it("显式传入的 root 优先于环境变量", async () => {
    const previous = process.env["ZG_DATA_DIR"];
    process.env["ZG_DATA_DIR"] = "/tmp/should-be-ignored";
    try {
      // 测试用临时目录必须能压过环境变量,否则测试之间会互相踩。
      expect(dataDir(root)).toBe(join(root, "data"));
    } finally {
      if (previous === undefined) delete process.env["ZG_DATA_DIR"];
      else process.env["ZG_DATA_DIR"] = previous;
    }
  });
});

describe("保存", () => {
  it("往返一致", async () => {
    const { config } = await loadConfig(root);
    const next = { ...config, workers: [{ id: "w1", name: "", kind: "anonymous" as const, apiKey: "", enabled: true, proxyId: null }] };

    await saveConfig(next, root);
    const { config: reloaded, created } = await loadConfig(root);

    expect(created).toBe(false);
    expect(reloaded.workers).toHaveLength(1);
    expect(reloaded.workers[0]!.id).toBe("w1");
  });

  it("写盘前先过 schema —— 非法配置不落盘", async () => {
    const { config } = await loadConfig(root);
    const before = await readFile(configPath(root), "utf8");

    const bad = { ...config, gateway: { ...config.gateway, relayToken: "短" } };
    await expect(saveConfig(bad, root)).rejects.toThrow();

    expect(await readFile(configPath(root), "utf8")).toBe(before);
  });

  it("保存后不留临时文件", async () => {
    const { config } = await loadConfig(root);
    await saveConfig(config, root);

    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(join(root, "data"));
    expect(entries.filter((e) => e.includes(".tmp"))).toEqual([]);
  });

  it("保存的文件是 0600", async () => {
    const { config } = await loadConfig(root);
    await saveConfig(config, root);
    const st = await stat(configPath(root));
    expect(st.mode & 0o777).toBe(0o600);
  });

  it("多次保存幂等", async () => {
    const { config } = await loadConfig(root);
    await saveConfig(config, root);
    const first = await readFile(configPath(root), "utf8");
    await saveConfig(config, root);
    expect(await readFile(configPath(root), "utf8")).toBe(first);
  });
});

describe("原子写", () => {
  /*
   * README 的安全约束写着「`config.json` 0600 + **原子写**」，而第八轮审核实测:
   * 把 temp→fsync→rename 换成直接 `open(file,"w")` 写，全套测试**依然全绿** ——
   * 0600 那半条有测试（新写法也保留了 mode），原子那半条一条都没有。
   *
   * 「崩溃在写的中途」没法在单测里制造，但原子写有两个**可观测的后果**:
   * 1. 任何时刻读到的都是一份完整的 JSON（绝不会是截断的半个文件）；
   * 2. 写失败时不留下残骸，也不破坏原文件。
   *
   * 这个文件是唯一一份凭证存储 —— 一个被截断的 config.json 意味着
   * 所有 Worker 的 key 一起没了，而它只在下次启动时才被发现。
   */
  it("并发读到的永远是完整 JSON，不会是半个文件", async () => {
    const base = defaultConfig();
    await saveConfig(base, root);

    /*
     * 一边反复写一个**很大**的配置（大到非原子写必然分多次 syscall），
     * 一边反复读。每一次读到的都必须能 JSON.parse 成功。
     */
    /*
     * 过一遍 schema 构造，而不是手写一个对象字面量 —— 后者会漏掉
     * `enabled` 这类有默认值的必填字段，而 `saveConfig` 内部会 parse，
     * 于是测试挂在类型/校验上而不是在它想测的那条性质上。
     */
    const big = ConfigSchema.parse({
      ...base,
      proxies: Array.from({ length: 400 }, (_, i) => ({
        id: `p${i}`,
        name: `节点-${i}-${"x".repeat(80)}`,
        type: "http",
        host: "127.0.0.1",
        port: 18000 + i,
        source: "manual",
        direct: true,
        bridgeable: false,
        egressIp: null,
      })),
    });

    let reads = 0;
    let parseFailures = 0;
    let stop = false;
    const reader = (async () => {
      while (!stop) {
        try {
          const text = await readFile(configPath(root), "utf8");
          JSON.parse(text);
          reads += 1;
        } catch (err) {
          // ENOENT 不算失败:非原子写的另一种形态是「文件短暂不存在」，
          // 那同样是缺陷，但这里单独计 parse 失败更能指认「读到半个文件」。
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") parseFailures += 1;
          else parseFailures += 1;
        }
        await new Promise((r) => setImmediate(r));
      }
    })();

    for (let i = 0; i < 12; i += 1) {
      await saveConfig(i % 2 === 0 ? big : base, root);
    }
    stop = true;
    await reader;

    expect(reads).toBeGreaterThan(0);
    expect(parseFailures).toBe(0);
  });

  it("写失败时不留临时文件，也不动原文件", async () => {
    const base = defaultConfig();
    await saveConfig(base, root);
    const before = await readFile(configPath(root), "utf8");

    /*
     * 怎么让写**真的**失败:
     *
     * 第一版把 data/ 改成 0500 —— 没用。进程是目录的 owner，而 `saveConfig`
     * 开头就 `chmod(dir, DIR_MODE)` 把权限改回 0700 了（那是 `ensurePermissions`
     * 那条「权限不对就修正」的另一面）。所以那条测试测的是「它会自我修复」。
     *
     * 改用「把目标路径占成一个目录」:`rename(temp, file)` 会得到 EISDIR。
     * 这是一条真实可达的失败路径（用户手工在 data/ 里建了个同名目录，
     * 或某个工具留下的残骸），而且它落在 rename 那一步 ——
     * 正是原子写最要紧的那一步。
     */
    const { rm: rmOne, mkdir: mkdirOne, readdir } = await import("node:fs/promises");
    const dir = join(root, "data");
    await rmOne(configPath(root));
    await mkdirOne(configPath(root));

    await expect(
      saveConfig({ ...base, gateway: { ...base.gateway, port: 19999 } }, root),
    ).rejects.toThrow(ConfigError);

    // 没有残留的 .tmp —— 失败路径会清理掉临时文件。
    const left = (await readdir(dir)).filter((n) => n.endsWith(".tmp"));
    expect(left).toEqual([]);

    // 恢复成文件后，原内容仍可写回（证明失败没有留下别的副作用）。
    await rmOne(configPath(root), { recursive: true });
    await saveConfig(base, root);
    expect(await readFile(configPath(root), "utf8")).toBe(before);
  });
});
