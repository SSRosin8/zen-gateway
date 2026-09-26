import { describe, expect, it } from "vitest";
import { TARGET_VERSION } from "../../src/store/db/migrations.ts";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PROJECT = resolve(import.meta.dirname, "..", "..");

/*
 * `scripts/*.mjs` 直接 import `src/` 下的 TypeScript,走的是 Node 的
 * **strip-only** 模式 —— 它只删类型标注,不做任何转换,因此不支持
 * 构造器参数属性、enum、namespace、装饰器等「需要生成代码」的语法。
 *
 * **tsc 完全看不到这个问题**:那些语法在 tsc 眼里完全合法。只有真的用
 * Node 跑一遍才会炸成 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX。
 *
 * 这条守卫曾经存在于迁移脚本的测试里(当时 ConfigError 用参数属性写成,
 * 正是这样被抓出来的),迁移功能删除后一并消失。setup.mjs 与
 * doctor.mjs 会 import 这些共享模块来复用 schema 与配置读写 —— 不复用就会
 * 退化成两份定义,脚本写出的配置迟早与 schema 不一致。所以守卫必须常驻。
 */

/** 以 .mjs 形式 import 指定模块并调用一小段代码,模拟 scripts/ 下的脚本。 */
async function runAsScript(body: string): Promise<{ stdout: string; stderr: string }> {
  const dir = await mkdtemp(join(tmpdir(), "zg-strip-"));
  // 放在项目内,否则相对 import 解析不到 src/ 与 node_modules。
  const file = join(PROJECT, `.zg-strip-probe-${process.pid}.mjs`);
  try {
    await writeFile(file, body, "utf8");
    return await execFileAsync(process.execPath, [file], { cwd: PROJECT });
  } finally {
    await rm(file, { force: true });
    await rm(dir, { recursive: true, force: true });
  }
}

describe("共享模块可被 .mjs 脚本直接 import(strip-only 模式)", () => {
  it("schema 可用", async () => {
    const { stdout } = await runAsScript(`
      import { ConfigSchema, CONFIG_VERSION } from "./src/shared/schema.ts";
      const cfg = ConfigSchema.parse({
        version: CONFIG_VERSION,
        gateway: { relayToken: "A".repeat(32) },
      });
      console.log("cooldown:", cfg.routing.cooldown.rateLimitMs);
    `);
    expect(stdout).toContain("cooldown: 900000");
  });

  it("config 存取可用 —— ConfigError 的定义方式是当年的触发点", async () => {
    const { stdout } = await runAsScript(`
      import { mkdtemp, rm } from "node:fs/promises";
      import { tmpdir } from "node:os";
      import { join } from "node:path";
      import { loadConfig, ConfigError, generateRelayToken } from "./src/store/config.ts";

      const root = await mkdtemp(join(tmpdir(), "zg-probe-"));
      try {
        const { config, created } = await loadConfig(root);
        console.log("created:", created, "token length:", config.gateway.relayToken.length);
        console.log("ConfigError is a class:", typeof ConfigError === "function");
        console.log("token generator:", generateRelayToken().length);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    `);
    expect(stdout).toContain("created: true");
    expect(stdout).toContain("ConfigError is a class: true");
  });

  it("脱敏与 IP 模块可用", async () => {
    const { stdout } = await runAsScript(`
      import { safeErrorMessage } from "./src/shared/redact.ts";
      import { isIpAddress, canonicalizeIp } from "./src/shared/ip.ts";
      console.log(safeErrorMessage(new Error("apiKey=zen-fake-SECRET-VALUE")));
      console.log("ip:", isIpAddress("192.0.2.1"), canonicalizeIp("2001:DB8::1"));
    `);
    expect(stdout).not.toContain("zen-fake-SECRET-VALUE");
    expect(stdout).toContain("ip: true 2001:db8::1");
  });

  it("sqlite 迁移可用", async () => {
    const { stdout } = await runAsScript(`
      import { mkdtemp, rm } from "node:fs/promises";
      import { tmpdir } from "node:os";
      import { join } from "node:path";
      import { openRuntimeDb } from "./src/store/db/open.ts";
      import { TARGET_VERSION } from "./src/store/db/migrations.ts";

      const root = await mkdtemp(join(tmpdir(), "zg-probe-db-"));
      try {
        const db = await openRuntimeDb(root);
        const row = db.prepare("PRAGMA user_version").get();
        console.log("version:", row.user_version, "target:", TARGET_VERSION);
        db.close();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    `);
    /*
     * 从唯一真相取值,不写档位字面量。
     *
     * 若写成 `/version: 1 target: 1/`,新增档位时它就会红,
     * 而红的原因与这条测试要验的事(共享模块能被 .mjs 直接 import)毫无关系。
     * 这正是纪律 #7 的「会漂的数字不该写进断言」:档位号每加一条迁移就变一次。
     *
     * 断言改成「实际档位等于目标档位」—— 那个性质与档位号无关,
     * 而它恰好是这条测试真正关心的:迁移跑完了。
     */
    const target = TARGET_VERSION;
    expect(stdout.trim()).toBe(`version: ${target} target: ${target}`);
  });

  it("出口链路模块可用(doctor 要用它做分层诊断)", async () => {
    const { stdout } = await runAsScript(`
      import { buildIsolationReport } from "./src/core/proxy/probe.ts";
      import { classifyStatus } from "./src/core/failures.ts";
      const report = buildIsolationReport([
        { workerId: "w1", proxyId: "p1", egressIp: "198.51.100.1" },
        { workerId: "w2", proxyId: "p2", egressIp: "198.51.100.1" },
      ]);
      console.log("shared:", report.sharedGroups.length, "isolated:", report.isolated);
      console.log("429 →", classifyStatus({ status: 429, headers: { get: () => null } }));
    `);
    expect(stdout).toContain("shared: 1 isolated: false");
    expect(stdout).toContain("429 → rate_limit");
  });
});
