import { describe, expect, it } from "vitest";
import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import { ConfigSchema, CONFIG_VERSION, type Config } from "../../src/shared/schema.ts";
import {
  configFile,
  dataDir,
  fakeApi,
  fakeClashPort,
  port,
  run,
  SETUP,
  startFakeClash,
  useScriptSandbox,
  writeConfig,
} from "./helpers/scriptSandbox.ts";

/*
 * `scripts/setup.mjs` 的行为:探测范围、不丢用户数据、端口与分组的判断,
 * 以及刻意不创建 Worker。
 */

// 端口段见 useScriptSandbox 的说明。
useScriptSandbox(20100);

/* ================================================================== *
 * setup:安全边界
 * ================================================================== */

describe("setup 的探测范围", () => {
  it("只探 127.0.0.1 的固定白名单,不扫 LAN、不扫端口段", async () => {
    await writeConfig();

    const result = await run(SETUP, ["--dry-run"]);

    /*
     * 这是安全约束。断言输出里报告的候选**全部**是 127.0.0.1,
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

  it("**按规则的实际目标选分组** —— 名字启发式会选错的那个形态", async () => {
    /*
     * 先前的判据是**名字**：rule 模式下把叫 `GLOBAL` 的降级。
     * 它的漏洞是：一个名字不叫 GLOBAL 却同样不参与选路的分组
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
     * 走的那个。这正是「探测目标与转发目标不同域」的核心。
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
     * 不为每个可用出口建匿名 Worker:匿名(免 key)通道已被上游关闭。建一批没有 key 的 Worker 只会得到一池必定失败的条目 ——
     * `isUsable()` 把它们全过滤掉,而用户看到「已建 N 个 Worker」却一个都不能用。
     */
    expect(after.workers).toHaveLength(0);
    expect(after.proxies.length).toBeGreaterThan(0);
    expect(result.stdout).toContain("匿名 Worker");
  });
});
