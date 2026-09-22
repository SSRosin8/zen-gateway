import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const PROJECT = resolve(import.meta.dirname, "..", "..");
const SCRIPT = join(PROJECT, "scripts", "migrate-config.mjs");

/*
 * 全部凭证都是明显虚构的。IP 用 RFC 5737 文档段，域名用 .invalid。
 * 绝不把真实 settings.json 当 fixture —— 那会让凭证进到仓库里。
 */
const FAKE = {
  authKey1: "zen-fake-KEY-DO-NOT-USE-0001",
  authKey2: "zen-fake-KEY-DO-NOT-USE-0002",
  subToken: "FAKE-SUBSCRIPTION-TOKEN-999",
  clashSecret: "fake-controller-secret-xyz",
};

function oldSettings(overrides: Record<string, unknown> = {}) {
  return {
    baseUrl: "https://opencode.ai/zen/v1",
    relayAccessToken: "",
    synthesizeCliHeaders: false,
    cliUserAgent: "opencode-cli/1.0.0",
    cliClient: "cli",
    cliProject: "default",
    accounts: [
      { id: "", apiKey: "", kind: "anonymous_zen", enabled: true, proxyId: "p-alpha" },
      { id: "signed-in", apiKey: FAKE.authKey1, enabled: true, proxyId: "p-gone" },
      { id: "inferred", apiKey: FAKE.authKey2, enabled: true, proxyId: null },
    ],
    routingStrategy: "anonymous_first",
    proxyPool: [
      {
        id: "p-alpha",
        name: "节点甲",
        type: "socks5",
        host: "192.0.2.10",
        port: 1080,
        enabled: true,
        source: "manual",
        usable: true,
        egressIp: "198.51.100.7",
      },
      {
        id: "p-bridge",
        name: "节点乙",
        type: "vless",
        host: "192.0.2.11",
        port: 443,
        enabled: true,
        source: "subscription",
        subscriptionId: "sub-1",
        usable: false,
        bridgeable: true,
        clashType: "vless",
      },
      {
        id: "p-dead",
        name: "节点丙",
        type: "tuic",
        host: "192.0.2.12",
        port: 443,
        enabled: true,
        source: "manual",
        usable: false,
        bridgeable: false,
      },
    ],
    proxySubscriptions: [
      {
        id: "sub-1",
        name: "订阅一",
        url: `https://sub.example.invalid/link/${FAKE.subToken}`,
        enabled: true,
        lastFetchedAt: "2026-09-01T00:00:00.000Z",
        lastError: `upstream said token=${FAKE.subToken} invalid`,
        lastImportCount: 2,
        lastFormat: "clash-yaml",
      },
    ],
    clashBridge: {
      enabled: false,
      apiBase: "http://127.0.0.1:9090",
      apiSecret: FAKE.clashSecret,
      localProxyHost: "127.0.0.1",
      localProxyPort: 7890,
      selectorGroup: "GLOBAL",
      selectionMode: "auto",
      bridges: [],
      activeBridgeId: null,
    },
    port: 9876,
    ...overrides,
  };
}

let oldRoot: string;

beforeEach(async () => {
  oldRoot = await mkdtemp(join(tmpdir(), "zg-old-"));
  await mkdir(join(oldRoot, "data"), { recursive: true });
});

afterEach(async () => {
  await rm(oldRoot, { recursive: true, force: true });
});

async function writeOld(settings: unknown): Promise<void> {
  await writeFile(join(oldRoot, "data", "settings.json"), JSON.stringify(settings, null, 2), "utf8");
}

async function migrate(args: string[] = ["--dry-run"]) {
  return run(process.execPath, [SCRIPT, oldRoot, ...args], { cwd: PROJECT });
}

describe("migrate-config 脚本", () => {
  /*
   * 这条测试的真正价值在于「脚本能跑起来」本身。
   *
   * scripts/*.mjs 直接 import src/ 的 TypeScript,走的是 Node 的
   * strip-only 模式,它不支持构造器参数属性等语法。**tsc 完全看不到这个问题**,
   * 只有真的把脚本跑一遍才会暴露。Phase 8 的 setup/doctor 同样 import 共享模块,
   * 所以这条约束需要一个常驻的守卫。
   */
  it("能在 Node 的 strip-only TS 模式下运行", async () => {
    await writeOld(oldSettings());
    const { stdout } = await migrate();
    expect(stdout).toContain("迁移摘要");
  });

  it("输出不含任何凭证值", async () => {
    await writeOld(oldSettings());
    const { stdout, stderr } = await migrate();
    const all = stdout + stderr;

    for (const [name, secret] of Object.entries(FAKE)) {
      expect(all, `${name} 泄漏到了输出里`).not.toContain(secret);
    }
  });

  it("空的 relayAccessToken 会生成新 token 并明确告知", async () => {
    await writeOld(oldSettings());
    const { stdout } = await migrate();
    // 旧项目默认空 token = 本机任何进程都能白用网关。
    expect(stdout).toContain("relayAccessToken 为空");
    expect(stdout).toContain("客户端配置需同步更新");
  });

  it("保留合法的旧 token,不无谓地换掉", async () => {
    await writeOld(oldSettings({ relayAccessToken: "A".repeat(32) }));
    const { stdout } = await migrate();
    expect(stdout).not.toContain("已生成新 token");
  });

  it("id 为空串的账号被改名而非丢弃", async () => {
    await writeOld(oldSettings());
    const { stdout } = await migrate();
    expect(stdout).toContain("已改名为 migrated-N");
    expect(stdout).toMatch(/Worker\s+3/);
  });

  it("绑定已不存在代理的 Worker 被停用,而不是静默直连", async () => {
    await writeOld(oldSettings());
    const { stdout } = await migrate();
    /*
     * 静默退回直连意味着它和别的 Worker 共用同一个公网 IP,
     * 而出口隔离正是本项目存在的理由。
     */
    expect(stdout).toContain("已改为直连并停用");
  });

  it("既不能直连也不能桥接的代理被丢弃", async () => {
    await writeOld(oldSettings());
    const { stdout } = await migrate();
    expect(stdout).toContain("已丢弃");
    expect(stdout).toMatch(/代理\s+2/);
  });

  it("旧的顶层 Clash 字段被提升为内核条目,配置不会凭空消失", async () => {
    await writeOld(oldSettings());
    const { stdout } = await migrate();
    expect(stdout).toContain("legacy");
    expect(stdout).toMatch(/Clash 内核\s*1/);
  });

  it("写盘后的配置能被新 schema 加载,且不再带 union-alpha", async () => {
    const newRoot = await mkdtemp(join(tmpdir(), "zg-new-"));
    try {
      await writeOld(oldSettings());
      const { stdout } = await migrate(["--target", newRoot]);
      expect(stdout).toContain("已写入");

      const { loadConfig } = await import("../../src/store/config.ts");
      const { config, created } = await loadConfig(newRoot);

      // created=false 证明读到的是脚本写出的文件,而不是又生成了一份默认配置。
      expect(created).toBe(false);
      expect(config.workers).toHaveLength(3);
      expect(config.proxies).toHaveLength(2);

      /*
       * 旧代码把 big-pickle 与 union-alpha 都硬编码为特例免费模型,
       * 而 union-alpha 已从 Zen 目录消失 —— 这正是改成配置驱动的直接理由。
       */
      expect(config.models.extraFreeIds).toContain("big-pickle");
      expect(config.models.extraFreeIds).not.toContain("union-alpha");

      // 绑定已失效代理的 Worker 必须是停用状态,不能静默共用出口。
      const dangling = config.workers.find((w) => w.id === "signed-in");
      expect(dangling?.proxyId).toBeNull();
      expect(dangling?.enabled).toBe(false);

      // 没写 kind 但有 apiKey 的账号要推断成登录态,不能变成匿名。
      expect(config.workers.find((w) => w.id === "inferred")?.kind).toBe("authenticated");

      // 可能含 token 的旧 lastError 自由文本不迁移。
      expect(config.subscriptions[0]!.lastErrorKind).toBeNull();
    } finally {
      await rm(newRoot, { recursive: true, force: true });
    }
  });

  it("写出的 config.json 是 0600", async () => {
    const newRoot = await mkdtemp(join(tmpdir(), "zg-new-"));
    try {
      await writeOld(oldSettings());
      await migrate(["--target", newRoot]);

      const { stat } = await import("node:fs/promises");
      const st = await stat(join(newRoot, "data", "config.json"));
      expect(st.mode & 0o777).toBe(0o600);
    } finally {
      await rm(newRoot, { recursive: true, force: true });
    }
  });

  it("目标已存在且未加 --force 时拒绝覆盖", async () => {
    const newRoot = await mkdtemp(join(tmpdir(), "zg-new-"));
    try {
      await writeOld(oldSettings());
      await migrate(["--target", newRoot]);

      const err = (await migrate(["--target", newRoot]).catch((e: unknown) => e)) as {
        stderr?: string;
      };
      expect(String(err.stderr)).toContain("已存在");
    } finally {
      await rm(newRoot, { recursive: true, force: true });
    }
  });

  it("--force 覆盖前先备份,且备份也是 0600", async () => {
    const newRoot = await mkdtemp(join(tmpdir(), "zg-new-"));
    try {
      await writeOld(oldSettings());
      await migrate(["--target", newRoot]);
      const { stdout } = await migrate(["--target", newRoot, "--force"]);
      expect(stdout).toContain("已备份");

      const { readdir, stat } = await import("node:fs/promises");
      const backups = (await readdir(join(newRoot, "data"))).filter((f) => f.includes(".bak."));
      expect(backups).toHaveLength(1);

      // 备份文件同样是凭证文件。
      const st = await stat(join(newRoot, "data", backups[0]!));
      expect(st.mode & 0o777).toBe(0o600);
    } finally {
      await rm(newRoot, { recursive: true, force: true });
    }
  });

  it("源文件不存在时报错且不写盘", async () => {
    await rm(join(oldRoot, "data"), { recursive: true, force: true });
    const err = await migrate().catch((e: unknown) => e);
    expect(String((err as { stderr?: string }).stderr)).toContain("找不到");
  });

  it("源文件是坏 JSON 时不回显文件内容", async () => {
    await writeFile(
      join(oldRoot, "data", "settings.json"),
      `{ "relayAccessToken": "${FAKE.authKey1}" ,,, }`,
      "utf8",
    );
    const err = (await migrate().catch((e: unknown) => e)) as { stderr?: string; stdout?: string };
    const all = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    // V8 的 JSON 报错会带出错位置附近的原文片段。
    expect(all).not.toContain(FAKE.authKey1);
    expect(all).toContain("无法解析为 JSON");
  });

  it("顶层不是对象时报错", async () => {
    await writeOld([1, 2, 3]);
    const err = (await migrate().catch((e: unknown) => e)) as { stderr?: string };
    expect(String(err.stderr)).toContain("顶层必须是对象");
  });

  it("--dry-run 不写任何文件", async () => {
    await writeOld(oldSettings());
    const before = await readFile(join(oldRoot, "data", "settings.json"), "utf8");
    await migrate();
    expect(await readFile(join(oldRoot, "data", "settings.json"), "utf8")).toBe(before);
  });

  it("源目录与 --target 相同路径时仍能解析出位置参数", async () => {
    // 按字符串值排除 --target 的值会把位置参数一起滤掉，于是脚本只打印用法。
    await writeOld(oldSettings());
    const { stdout } = await migrate(["--target", oldRoot, "--dry-run"]);
    expect(stdout).toContain("迁移摘要");
    expect(stdout).not.toContain("用法:");
  });
});
