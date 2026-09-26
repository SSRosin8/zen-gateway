import { describe, expect, it } from "vitest";
import { stat, writeFile } from "node:fs/promises";
import { ConfigSchema, CONFIG_VERSION } from "../../src/shared/schema.ts";
import {
  configFile,
  DOCTOR,
  fakeApi,
  port,
  run,
  SETUP,
  startFakeClash,
  startServer,
  useScriptSandbox,
  writeConfig,
} from "./helpers/scriptSandbox.ts";

/*
 * setup 与 doctor 两个脚本共有的命令行约束:不回显凭证、拒绝未识别的参数。
 */

// 端口段见 useScriptSandbox 的说明。
useScriptSandbox(20200);

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
 * 未识别的参数
 * ================================================================== */

describe("两个脚本都拒绝未识别的参数", () => {
  /*
   * 这不是假想的形态 —— 想看用法时敲 `npm run setup - --help`，若 setup
   * 把两个参数都静默忽略，就会**执行完整的真实导入**：
   * 改写 `data/config.json` 并留一个 `.bak`。
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

  it("裸 `-` 也算未识别 —— `npm run setup - --help` 会产生它", async () => {
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

  it("doctor --help 明确 --deep 只测回显目标，不宣称 Zen 已隔离", async () => {
    const result = await run(DOCTOR, ["--help"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("IP 回显目标");
    expect(result.stdout).toContain("不证明 Zen 实际出口");
    expect(result.stdout).not.toContain("额外实测每个出口的公网 IP");
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
