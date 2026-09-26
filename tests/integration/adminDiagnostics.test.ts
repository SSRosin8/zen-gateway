import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { DiagnosticsSchema, ProbeReportSchema } from "../../src/shared/contract.ts";
import { openRuntimeDb } from "../../src/store/db/open.ts";
import { BatchProbeStore } from "../../src/store/db/batchProbeStore.ts";
import { BatchProbeRunner } from "../../src/server/admin/batchRunner.ts";
import { parseCatalog } from "../../src/core/models/catalog.ts";
import { allSecretValues } from "../../src/server/admin/project.ts";
import type { Config } from "../../src/shared/schema.ts";
import { startFakeClash } from "./helpers/fakeClash.ts";
import { CLASH_SECRET, get, makeApp, makeConfig, post } from "./helpers/adminFixture.ts";
import { dataDir, port, startServer, useScriptSandbox, writeConfig } from "./helpers/scriptSandbox.ts";

/*
 * 进程内诊断 `GET /api/diagnostics` 与深度诊断 `POST /api/diagnostics/deep`，
 * 以及首启自动写 opencode.json 的真实入口。
 */

useScriptSandbox(20300);

const layerOf = (body: unknown, id: string) =>
  DiagnosticsSchema.parse(body).layers.find((l) => l.id === id)!;

describe("GET /api/diagnostics", () => {
  it("五层齐全，顺序固定，且不含凭证", async () => {
    const config = makeConfig();
    const { app } = makeApp(config);
    const r = await get(app, "/api/diagnostics");
    expect(r.status).toBe(200);
    const layers = DiagnosticsSchema.parse(r.body).layers;
    expect(layers.map((l) => l.id)).toEqual(["config", "store", "workers", "clash", "catalog"]);
    const text = JSON.stringify(r.body);
    for (const s of allSecretValues(config)) expect(text).not.toContain(s);
    expect(text).not.toContain(CLASH_SECRET);
  });

  it("没有 Worker 时 workers 层 fail，其他层仍给出结果（不在第一个失败处停下）", async () => {
    const { app } = makeApp(makeConfig({ workers: [], proxies: [], clash: { enabled: false, bridges: [] } }));
    const r = await get(app, "/api/diagnostics");
    expect(layerOf(r.body, "workers").status).toBe("fail");
    expect(layerOf(r.body, "clash").status).toBe("skip");
    expect(layerOf(r.body, "config").status).toBe("pass");
  });

  it("Clash 内核连不上时 clash 层 fail", async () => {
    const config = makeConfig();
    config.clash.bridges[0]!.apiBase = "http://127.0.0.1:1";
    const { app } = makeApp(config);
    expect(layerOf((await get(app, "/api/diagnostics")).body, "clash").status).toBe("fail");
  });

  it("混合端口与内核实际不一致时 clash 层 fail，并给出两个端口", async () => {
    const fake = await startFakeClash({ mixedPort: 24680 });
    try {
      const config = makeConfig();
      config.clash.bridges[0]!.apiBase = fake.apiBase;
      const { app } = makeApp(config);
      const layer = layerOf((await get(app, "/api/diagnostics")).body, "clash");
      expect(layer.status).toBe("fail");
      expect(layer.details.join("\n")).toContain("配置写 7897,内核实际 24680");
      expect(fake.hits).toContain("/configs");
    } finally {
      await fake.close();
    }
  });

  it("目录拉不到时 catalog 层 fail，并报服务进程是否设了 CA", async () => {
    const { app } = makeApp(makeConfig(), { admin: { ensureCatalog: async () => null } });
    const layer = layerOf((await get(app, "/api/diagnostics")).body, "catalog");
    expect(layer.status).toBe("fail");
    expect(layer.details.join("\n")).toContain("NODE_EXTRA_CA_CERTS");
  });

  it("目录可达时报免费数与在架数", async () => {
    const snapshot = parseCatalog({ data: [{ id: "a-free" }, { id: "paid" }] }, "keyed", Date.now());
    const { app } = makeApp(makeConfig(), { admin: { ensureCatalog: async () => snapshot } });
    const layer = layerOf((await get(app, "/api/diagnostics")).body, "catalog");
    expect(layer.status).toBe("pass");
    expect(layer.summary).toContain("免费 1 个 / 在架 2 个");
  });

  it("磁盘上的配置坏了时 config 层 fail，提醒不要重启", async () => {
    const { app } = makeApp(makeConfig(), {
      admin: {
        diskConfigCheck: async () => {
          throw new Error("config.json 不是合法 JSON");
        },
      },
    });
    const layer = layerOf((await get(app, "/api/diagnostics")).body, "config");
    expect(layer.status).toBe("fail");
    expect(layer.nextStep).toContain("不要重启");
  });

  it("统计库不可用时 store 层 warn", async () => {
    const { app } = makeApp(makeConfig(), { stats: false });
    expect(layerOf((await get(app, "/api/diagnostics")).body, "store").status).toBe("warn");
  });
});

describe("POST /api/diagnostics/deep 与批量探测互斥", () => {
  let root: string;
  let db: DatabaseSync;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "zg-deep-"));
    db = await openRuntimeDb(root);
  });
  afterEach(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  /** 直连 Worker + 可控的假探测：让「批测正在进行」这一状态可以被精确保持住。 */
  function setup() {
    const config = makeConfig({ workers: [{ id: "w1", kind: "anonymous", proxyId: null }], proxies: [], clash: { enabled: false, bridges: [] } });
    let current: Config = config;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const holder = makeApp(config);
    const egress = holder.egress;
    const outcome = { ok: true as const, egressIp: "203.0.113.9", latencyMs: 1, via: "http://127.0.0.1/" };
    egress.probeProxy = async (_c, proxyId) => {
      await gate;
      return { proxyId: proxyId ?? "__direct__", outcome };
    };
    const batch = new BatchProbeRunner({
      configOf: () => current,
      applyConfig: async (next) => {
        current = next;
      },
      egress,
      store: new BatchProbeStore(db),
    });
    const { app } = makeApp(config, { admin: { batch, egress } });
    return { app, batch, release };
  }

  it("**批测进行中时深度诊断得 409**，批测结束后可以运行", async () => {
    const { app, batch, release } = setup();
    expect(batch.start()).toBe(true);
    const blocked = await post(app, "/api/diagnostics/deep");
    expect(blocked.status).toBe(409);
    expect((blocked.body as { error: { type: string } }).error.type).toBe("conflict");

    release();
    for (let i = 0; i < 100 && batch.snapshot().state !== "done"; i += 1) await new Promise((r) => setTimeout(r, 10));
    expect(batch.snapshot().state).toBe("done");

    const ok = await post(app, "/api/diagnostics/deep");
    expect(ok.status).toBe(200);
    expect(ProbeReportSchema.parse(ok.body).results[0]).toMatchObject({ ok: true, egressIp: "203.0.113.9" });
  });

  it("深度诊断进行中时批测无法启动", async () => {
    const { app, batch, release } = setup();
    const deep = post(app, "/api/diagnostics/deep");
    await new Promise((r) => setTimeout(r, 20));
    expect(batch.start()).toBe(false);
    release();
    expect((await deep).status).toBe(200);
    expect(batch.start()).toBe(true);
  });
});

describe("首启自动写 opencode.json（真实入口）", () => {
  it("新数据目录首启时在项目根生成 opencode.json，指向实际端口与真实 token", async () => {
    const root = await mkdtemp(join(tmpdir(), "zg-first-"));
    try {
      await startServer({ ZG_DATA_DIR: join(root, "data"), ZG_PROJECT_ROOT: root, PATH: "/nonexistent" });
      const config = JSON.parse(await readFile(join(root, "data", "config.json"), "utf8")) as Config;
      let doc: { providers?: { opencode?: { settings?: Record<string, string> } } } | null = null;
      for (let i = 0; i < 50 && doc === null; i += 1) {
        doc = await readFile(join(root, "opencode.json"), "utf8").then(JSON.parse, () => null);
        if (doc === null) await new Promise((r) => setTimeout(r, 50));
      }
      // PATH 里没有 opencode → 探测为 null → 默认 v2。
      expect(doc?.providers?.opencode?.settings).toEqual({
        baseURL: `http://127.0.0.1:${port}/v1`,
        apiKey: config.gateway.relayToken,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("**首启但项目根已有 opencode.json 时不覆盖**", async () => {
    const root = await mkdtemp(join(tmpdir(), "zg-first-"));
    try {
      const original = JSON.stringify({ providers: { opencode: { settings: { baseURL: "http://elsewhere.invalid/v1", apiKey: "user" } } } });
      await writeFile(join(root, "opencode.json"), original);
      await startServer({ ZG_DATA_DIR: join(root, "data"), ZG_PROJECT_ROOT: root, PATH: "/nonexistent" });
      await new Promise((r) => setTimeout(r, 500));
      expect(await readFile(join(root, "opencode.json"), "utf8")).toBe(original);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("**不是首启时不写**：已有 config.json 的数据目录", async () => {
    await writeConfig();
    await startServer({ PATH: "/nonexistent" });
    // 自动写在监听之后异步进行；等一段足以完成它的时间再断言文件不存在。
    await new Promise((r) => setTimeout(r, 500));
    // 沙箱把项目根指向数据目录本身。
    await expect(readFile(join(dataDir, "opencode.json"), "utf8")).rejects.toThrow(/ENOENT/);
  });
});
