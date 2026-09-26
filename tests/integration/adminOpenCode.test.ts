import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCodeViewSchema } from "../../src/shared/contract.ts";
import { writeOpenCodeConfig, type VersionProbe } from "../../src/server/admin/opencode.ts";
import { majorOf, versionFor } from "../../src/shared/openCodeConfig.ts";
import { openCodeConfigSnippet, RELAY_TOKEN_PLACEHOLDER } from "../../src/shared/openCodeConfig.ts";
import { TOKEN, get, makeApp, makeConfig, post } from "./helpers/adminFixture.ts";

/*
 * 项目根 `opencode.json` 的检测与写入。项目根指向临时目录，版本探测注入，
 * 不调用真实 `opencode`，也绝不写仓库里的 opencode.json。
 */

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zg-opencode-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const file = () => join(root, "opencode.json");
const v2: VersionProbe = async () => "opencode v2.0.12";
const v1: VersionProbe = async () => "1.4.3";
const none: VersionProbe = async () => null;

function appWith(probe: VersionProbe = v2) {
  // 端口 9999 来自 makeConfig；effectivePort 取 config.gateway.port。
  return makeApp(makeConfig(), { admin: { openCode: { root, probeVersion: probe } } });
}

const ctx = (probe: VersionProbe = v2) => ({ root, port: 9999, relayToken: TOKEN, probeVersion: probe });

describe("版本解析", () => {
  it("取主版本号并按它选形状", () => {
    expect(majorOf("opencode v2.0.12")).toBe(2);
    expect(majorOf("1.4.3")).toBe(1);
    expect(majorOf("dev build")).toBeNull();
    expect(versionFor("1.4.3")).toBe("1");
    expect(versionFor("v3.1.0")).toBe("2");
    expect(versionFor(null)).toBe("2");
  });

  it("后台片段默认用占位符，不含真实 token", () => {
    const snippet = openCodeConfigSnippet(9999, "1");
    expect(JSON.parse(snippet).provider.opencode.options.apiKey).toBe(RELAY_TOKEN_PLACEHOLDER);
    expect(JSON.parse(openCodeConfigSnippet(9999, "2", "k")).providers.opencode.settings.apiKey).toBe("k");
  });
});

describe("GET /api/opencode", () => {
  it("文件不存在：exists=false、shape=null，报告探测到的版本", async () => {
    const { app } = appWith();
    const r = await get(app, "/api/opencode");
    expect(OpenCodeViewSchema.parse(r.body)).toEqual({
      path: "opencode.json",
      exists: false,
      detectedVersion: "opencode v2.0.12",
      shape: null,
      pointsToGateway: false,
      unwritableReason: null,
    });
  });

  it("未安装 opencode 时 detectedVersion 为 null", async () => {
    const { app } = appWith(none);
    expect((await get(app, "/api/opencode")).body["detectedVersion"]).toBeNull();
  });

  it("**apiKey 不是当前 token 时 pointsToGateway 为假**；响应不含 token", async () => {
    await writeFile(file(), JSON.stringify({ providers: { opencode: { settings: { baseURL: "http://127.0.0.1:9999/v1", apiKey: "stale-token" } } } }));
    const { app } = appWith();
    const stale = await get(app, "/api/opencode");
    expect(stale.body["shape"]).toBe("v2");
    expect(stale.body["pointsToGateway"]).toBe(false);

    await writeFile(file(), JSON.stringify({ providers: { opencode: { settings: { baseURL: "http://127.0.0.1:9999/v1", apiKey: TOKEN } } } }));
    const fresh = await get(app, "/api/opencode");
    expect(fresh.body["pointsToGateway"]).toBe(true);
    expect(JSON.stringify(fresh.body)).not.toContain(TOKEN);
  });

  it("baseURL 端口不对时 pointsToGateway 为假", async () => {
    await writeFile(file(), JSON.stringify({ provider: { opencode: { options: { baseURL: "http://127.0.0.1:1234/v1", apiKey: TOKEN } } } }));
    const { app } = appWith();
    const r = await get(app, "/api/opencode");
    expect(r.body["shape"]).toBe("v1");
    expect(r.body["pointsToGateway"]).toBe(false);
  });
});

describe("POST /api/opencode/write", () => {
  it("新建：按探测到的版本选形状，写真实 token 与实际端口，0600", async () => {
    const { app } = appWith(v1);
    const r = await post(app, "/api/opencode/write", {});
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ exists: true, shape: "v1", pointsToGateway: true });
    expect(r.text).not.toContain(TOKEN);

    const doc = JSON.parse(await readFile(file(), "utf8"));
    expect(doc.provider.opencode.options).toEqual({ baseURL: "http://127.0.0.1:9999/v1", apiKey: TOKEN });
    expect((await stat(file())).mode & 0o777).toBe(0o600);
  });

  it("显式 version 覆盖探测结果", async () => {
    const { app } = appWith(v1);
    const r = await post(app, "/api/opencode/write", { version: "2" });
    expect(r.body["shape"]).toBe("v2");
  });

  it("已有文件只改 provider 的 baseURL/apiKey，保留其他键", async () => {
    await writeFile(
      file(),
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        theme: "dark",
        providers: { opencode: { settings: { baseURL: "http://old.invalid/v1", apiKey: "old", timeout: 5 } }, other: { x: 1 } },
      }),
    );
    const { app } = appWith(v1);
    const r = await post(app, "/api/opencode/write", {});
    expect(r.status).toBe(200);
    const doc = JSON.parse(await readFile(file(), "utf8"));
    // 沿用文件现有的 v2 形状，不因探测到 1.x 就另写一份 v1。
    expect(doc).toEqual({
      $schema: "https://opencode.ai/config.json",
      theme: "dark",
      providers: {
        opencode: { settings: { baseURL: "http://127.0.0.1:9999/v1", apiKey: TOKEN, timeout: 5 } },
        other: { x: 1 },
      },
    });
  });

  it("**非严格 JSON（JSONC）拒绝改写**，文件原样保留，原因不回显内容", async () => {
    const original = '{\n  // 用户注释 secret-in-comment\n  "theme": "dark",\n}\n';
    await writeFile(file(), original);
    const { app } = appWith();
    const view = await get(app, "/api/opencode");
    expect(view.body["unwritableReason"]).toContain("JSON");

    const r = await post(app, "/api/opencode/write", {});
    expect(r.status).toBe(422);
    expect(r.text).not.toContain("secret-in-comment");
    expect(await readFile(file(), "utf8")).toBe(original);
  });

  it("路径上的值不是对象时拒绝，而不是覆盖用户数据", async () => {
    await writeFile(file(), JSON.stringify({ providers: { opencode: "custom" } }));
    const { app } = appWith();
    const r = await post(app, "/api/opencode/write", {});
    expect(r.status).toBe(422);
    expect(JSON.parse(await readFile(file(), "utf8"))).toEqual({ providers: { opencode: "custom" } });
  });

  it("请求体 strict：未知版本得 400", async () => {
    const { app } = appWith();
    expect((await post(app, "/api/opencode/write", { version: "3" })).status).toBe(400);
  });

  it("未装配时报不可用，而不是写到进程 cwd", async () => {
    const { app } = makeApp(makeConfig());
    expect((await get(app, "/api/opencode")).status).toBe(500);
  });
});

describe("首启自动写（onlyIfMissing）", () => {
  it("文件不存在时创建", async () => {
    expect(await writeOpenCodeConfig(ctx(), { onlyIfMissing: true })).toEqual({ ok: true, action: "created" });
    expect(JSON.parse(await readFile(file(), "utf8")).providers.opencode.settings.apiKey).toBe(TOKEN);
  });

  it("**已有文件绝不覆盖**，即使它是合法 JSON 且指向别处", async () => {
    const original = JSON.stringify({ providers: { opencode: { settings: { baseURL: "http://elsewhere.invalid/v1", apiKey: "user" } } } });
    await writeFile(file(), original);
    expect(await writeOpenCodeConfig(ctx(), { onlyIfMissing: true })).toEqual({ ok: true, action: "unchanged" });
    expect(await readFile(file(), "utf8")).toBe(original);
  });

  it("已有 JSONC 文件也不报错、不改动", async () => {
    await writeFile(file(), "{ // c\n}");
    expect(await writeOpenCodeConfig(ctx(), { onlyIfMissing: true })).toEqual({ ok: true, action: "unchanged" });
    expect(await readFile(file(), "utf8")).toBe("{ // c\n}");
  });
});
