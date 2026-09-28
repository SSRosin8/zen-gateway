import { describe, expect, it } from "vitest";
import { chmod, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  configFile,
  dataDir,
  DOCTOR,
  fakeApi,
  port,
  run,
  startFakeClash,
  startServer,
  useScriptSandbox,
  writeConfig,
} from "./helpers/scriptSandbox.ts";

/*
 * `scripts/doctor.mjs` 的行为:只读、分层、只报第一个失败的层,
 * 以及各层给出的判断与下一步建议。
 */

// 端口段见 useScriptSandbox 的说明。
useScriptSandbox();

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
    // 漏了这条提示，症状是「目录为空但不报错」。
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
 * doctor:第 5 层核对选中的分组是否真的参与选路
 * ================================================================== */

describe("doctor 第 5 层核对选中分组与上游规则", () => {

  it("**doctor 报出「选中的分组不参与选路」**", async () => {
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

  it("doctor 报出上游 host 先命中私网直连规则（企业 DNS 解析到内网）", async () => {
    /*
     * 分组参与选路、也是兜底目标，但上游域名被解析到私网地址，
     * 于是更靠前的 `IPCIDR,10.0.0.0/8,DIRECT` 先命中：所有 Worker 的 Zen 请求
     * 直连、共用一个出口，而回显探测打另一个域名，报告仍显示隔离。
     */
    const nodes = ["节点A", "节点B"];
    await startFakeClash({
      mode: "rule",
      nodes,
      selectors: { Proxy: nodes },
      ruleList: [
        { type: "DomainSuffix", payload: "proxy.invalid", proxy: "DIRECT" },
        { type: "IPCIDR", payload: "10.0.0.0/8", proxy: "DIRECT" },
        { type: "Match", payload: "", proxy: "Proxy" },
      ],
      dnsA: ["10.20.30.40"],
    });
    await writeConfig({
      // 上游必须是域名才走 DNS 解析 + IP 规则判定；`.invalid` 保证真实解析不到外网。
      gateway: { relayToken: "test-token-not-a-real-secret", port, baseUrl: "https://upstream.invalid/zen/v1" },
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
            localProxyPort: 7897, selectorGroup: "Proxy",
          },
        ],
      },
    });
    await startServer();

    const result = await run(DOCTOR);

    expect(result.stdout).toContain("IPCIDR,10.0.0.0/8 → DIRECT");
    expect(result.stdout).toContain("内核解析为 10.20.30.40");
    expect(result.stdout).toContain("DOMAIN-SUFFIX,upstream.invalid,Proxy");
    expect(result.stdout).toMatch(/! 1\/1 个 Clash 内核可连通/);
  }, 40_000);

  it("上游解析到公网时不报私网直连", async () => {
    const nodes = ["节点A", "节点B"];
    await startFakeClash({
      mode: "rule",
      nodes,
      selectors: { Proxy: nodes },
      ruleList: [
        { type: "IPCIDR", payload: "10.0.0.0/8", proxy: "DIRECT" },
        { type: "Match", payload: "", proxy: "Proxy" },
      ],
      dnsA: ["203.0.113.9"],
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
            localProxyPort: 7897, selectorGroup: "Proxy",
          },
        ],
      },
    });
    await startServer();

    const result = await run(DOCTOR);

    expect(result.stdout).toContain("── 5. Clash 控制面 ──");
    expect(result.stdout).not.toContain("不经过分组");
    expect(result.stdout).toMatch(/✓ 1\/1 个 Clash 内核可连通/);
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

});

/* ================================================================== *
 * doctor 第 4 层报运行期就绪态
 * ================================================================== */

describe("doctor 第 4 层问服务要就绪态，而不是自己算", () => {
  it("服务在跑时报的是**就绪**数，不只是配置形态", async () => {
    /*
     * 这一层若只报配置形态，就得写「是否就绪 doctor 查不到」—— 而那句话
     * 不成立：`GET /api/overview` 带 `ready` 与
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
     * ## 为什么不用假服务器冒充
     *
     * 用一个**假服务器**冒充（只答 /health，其余 404）不成立：
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
