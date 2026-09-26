import { beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema } from "../../src/shared/schema.ts";
import { OverviewSchema } from "../../src/shared/contract.ts";
import { applyConfigPatch } from "../../src/server/admin/patch.ts";
import {
  CLASH_SECRET,
  KEY_A,
  KEY_B,
  TOKEN,
  get,
  makeApp,
  makeConfig,
  patch,
} from "./helpers/adminFixture.ts";

/*
 * 管理 API 的配置写入：凭证三态语义、失败分类且不落盘、热更新、回环装配断言与原子落盘。
 */

/* ================================================================== *
 * 写入：凭证的三态语义
 * ================================================================== */

describe("配置写入不会静默抹掉凭证", () => {
  it("patch 里不提 apiKey 时它保持原值", () => {
    const config = makeConfig();
    const result = applyConfigPatch(config, { workers: { update: { w1: { name: "改个名" } } } });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    /*
     * 这是整个写入路径最危险的一条:前端**拿不到** apiKey 原值(投影只给
     * present),所以不能靠「回传原值」表达「不动它」。若用 `apiKey?: string`
     * 表达,一个未填的输入框会静默抹掉能用的 key,然后那个 Worker 被
     * `isUsable()` 过滤掉、界面上看起来仍然 enabled。
     */
    expect(result.config.workers[0]!.apiKey).toBe(KEY_A);
    expect(result.config.workers[0]!.name).toBe("改个名");
  });

  it("清空凭证必须显式说 clear,而 schema 仍有最终否决权", () => {
    const config = makeConfig();

    /*
     * ## 实测纠正了我的预期
     *
     * 我以为 `{clear:true}` 会把 apiKey 清成空串。实际被 **422 拒绝** ——
     * `WorkerSchema` 的 `refine` 要求「登录态 Worker 必须有 apiKey」，
     * 而全量校验在合并之后跑。
     *
     * **这是对的**：清掉 key 会让那个 Worker 被 `isUsable()` 过滤掉、
     * 界面上看起来仍然 enabled 却从不被选中 —— 一个静默失效的配置。
     * 与其允许它然后在界面上解释，不如在写入时就拒绝，让用户
     * 「要么换一个 key，要么停用它」。
     *
     * 所以 `clear` 的真实用途是 `relayToken` 这类**允许为空**的字段
     * （schema 上是 `.min(16)`，所以那里也会被拒）、以及将来
     * `proxies[].password` 这种确实可为空的凭证。保留这条路径 + 钉住
     * 「它不会静默成功」这个性质。
     */
    const cleared = applyConfigPatch(config, {
      workers: { update: { w1: { apiKey: { clear: true } } } },
    });
    expect(cleared.ok).toBe(false);
    if (!cleared.ok) {
      expect(cleared.failure.kind).toBe("invalid_config");
      // 报错要指到字段，且**不含 key 的值**。
      expect(cleared.failure.message).toContain("workers");
      expect(cleared.failure.message).not.toContain(KEY_A);
    }

    // 换成新值则正常生效。
    const replaced = applyConfigPatch(config, {
      workers: { update: { w1: { apiKey: { set: "new-key-value" } } } },
    });
    expect(replaced.ok).toBe(true);
    if (replaced.ok) expect(replaced.config.workers[0]!.apiKey).toBe("new-key-value");
  });

  it("停用一个 Worker 时不必也给 key —— 两件事互不牵连", () => {
    /*
     * 这条与上一条配套:既然「清 key」被拒,那么「我不想用这个账号了」
     * 的正确做法必须是可用的 —— 否则用户只剩「手工编辑 config.json」一条路。
     */
    const result = applyConfigPatch(makeConfig(), {
      workers: { update: { w1: { enabled: false } } },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.workers[0]!.enabled).toBe(false);
      // key 原样保留 —— 停用不是「用户修好了这个账号」,状态该留着。
      expect(result.config.workers[0]!.apiKey).toBe(KEY_A);
    }
  });

  it("proxyId: null 是「改为直连」,与缺席不同", () => {
    const config = makeConfig();

    const toDirect = applyConfigPatch(config, {
      workers: { update: { w1: { proxyId: null } } },
    });
    expect(toDirect.ok).toBe(true);
    if (toDirect.ok) expect(toDirect.config.workers[0]!.proxyId).toBeNull();

    const untouched = applyConfigPatch(config, { workers: { update: { w1: { name: "x" } } } });
    expect(untouched.ok).toBe(true);
    if (untouched.ok) expect(untouched.config.workers[0]!.proxyId).toBe("p1");
  });

  it("端到端:改配置后凭证一个都没变", async () => {
    const config = makeConfig();
    const { app, getConfig } = makeApp(config);

    const { status } = await patch(app, { workers: { update: { w1: { name: "美国出口" } } } });
    expect(status).toBe(200);

    const after = getConfig();
    expect(after.gateway.relayToken).toBe(TOKEN);
    expect(after.workers[0]!.apiKey).toBe(KEY_A);
    expect(after.workers[1]!.apiKey).toBe(KEY_B);
    expect(after.clash.bridges[0]!.apiSecret).toBe(CLASH_SECRET);
    expect(after.workers[0]!.name).toBe("美国出口");
  });
});

/* ================================================================== *
 * 写入：失败要分类，且不落盘
 * ================================================================== */

describe("写入失败分类", () => {
  it("未知 Worker id → 404,**不静默跳过**", async () => {
    const { app, getConfig } = makeApp(makeConfig());
    const before = JSON.stringify(getConfig());

    const { status, body } = await patch(app, { workers: { update: { ghost: { name: "x" } } } });

    /*
     * 静默跳过会让「我明明改了」变成查不出的问题:响应 200、刷新后值没变,
     * 而用户不知道是 id 打错了还是没生效。
     */
    expect(status).toBe(404);
    expect((body["error"] as { type: string }).type).toBe("not_found");
    expect(JSON.stringify(getConfig())).toBe(before);
  });

  it("引用完整性被破坏 → 422,且不落盘", async () => {
    const { app, getConfig } = makeApp(makeConfig());
    const before = JSON.stringify(getConfig());

    const { status, body } = await patch(app, {
      workers: { update: { w1: { proxyId: "does-not-exist" } } },
    });

    /*
     * 一个指向已删除代理的 Worker 会静默退回本机直连出口,于是它和其他
     * Worker 共用同一个公网 IP —— 而出口隔离正是本项目存在的理由。
     * 这种失败必须在加载配置前就暴露。
     */
    expect(status).toBe(422);
    expect((body["error"] as { type: string }).type).toBe("invalid_config");
    expect(JSON.stringify(getConfig())).toBe(before);
  });

  it("删掉仍被引用的代理会被拒", () => {
    const config = makeConfig();
    // 删 p1 但 w1 还绑着它 —— 跨资源的不一致，管理面最容易产生的形态。
    const result = applyConfigPatch({ ...config, proxies: [config.proxies[1]!] }, {});
    expect(result.ok).toBe(false);
  });

  it("新建重复 id 被拒", () => {
    const result = applyConfigPatch(makeConfig(), {
      workers: { create: [{ id: "w1", name: "", apiKey: "k", proxyId: null, enabled: true }] },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe("invalid_config");
  });

  it("匿名 Worker 可以通过补丁完整创建、更新类型并删除", () => {
    const config = makeConfig({ workers: [] });
    const created = applyConfigPatch(config, {
      workers: {
        create: [{ id: "anon-1", kind: "anonymous", name: "公共额度", apiKey: "", proxyId: null, enabled: true }],
      },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.config.workers[0]).toMatchObject({ id: "anon-1", kind: "anonymous", apiKey: "", enabled: true });

    const changed = applyConfigPatch(created.config, {
      workers: { update: { "anon-1": { name: "改名", proxyId: null, enabled: false } } },
    });
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;
    expect(changed.config.workers[0]).toMatchObject({ kind: "anonymous", name: "改名", enabled: false });

    const removed = applyConfigPatch(changed.config, { workers: { delete: ["anon-1"] } });
    expect(removed.ok).toBe(true);
    if (removed.ok) expect(removed.config.workers).toHaveLength(0);
  });

  it("认证 Worker 切匿名会清掉旧 key，切回认证必须重新提供 key", async () => {
    const { app, getConfig } = makeApp(makeConfig());
    expect(getConfig().workers[0]!.apiKey).toBe(KEY_A);

    const anonymous = await patch(app, { workers: { update: { w1: { kind: "anonymous" } } } });
    expect(anonymous.status).toBe(200);
    expect(getConfig().workers[0]).toMatchObject({ kind: "anonymous", apiKey: "" });

    const authenticated = await patch(app, { workers: { update: { w1: { kind: "authenticated" } } } });
    expect(authenticated.status).toBe(422);
    expect(getConfig().workers[0]).toMatchObject({ kind: "anonymous", apiKey: "" });

    const restored = await patch(app, {
      workers: { update: { w1: { kind: "authenticated", apiKey: { set: "fake-key-replacement-not-real" } } } },
    });
    expect(restored.status).toBe(200);
    expect(getConfig().workers[0]).toMatchObject({ kind: "authenticated", apiKey: "fake-key-replacement-not-real" });
  });

  it("**同一请求里 `delete X` + `create X` 净效果是新建**", () => {
    /*
     * 文件头承诺「删掉一个又同名新建的净效果是新建，而不是建完又被删掉」，
     * 若重复 id 检查看的是 `next.workers`（那里还有待删的那个），
     * 这个请求就会被拒，**注释与行为相反**。用户想换一个 Worker 的 id/key
     * 时必须发两次请求，而中间那一刻配置里少了一个 Worker。
     */
    const config = makeConfig();
    const result = applyConfigPatch(config, {
      workers: {
        create: [{ id: "w1", name: "换过的", apiKey: "brand-new-key-value", proxyId: null, enabled: true }],
        delete: ["w1"],
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // 只剩一个 w1，且是**新的**那个 —— 删掉的是旧的（create 追加、delete 取首个匹配）。
    const w1 = result.config.workers.filter((w) => w.id === "w1");
    expect(w1).toHaveLength(1);
    expect(w1[0]!.name).toBe("换过的");
    expect(w1[0]!.apiKey).toBe("brand-new-key-value");
    expect(result.changed).toBe(true);
  });

  it("不在 delete 里的重复 id 仍然被拒", () => {
    /*
     * 上一条放开的只是"同请求内要删的那个"。单纯的重复新建必须照旧报错 ——
     * 否则那条检查就等于没有了。
     */
    const result = applyConfigPatch(makeConfig(), {
      workers: {
        create: [{ id: "w1", name: "撞了", apiKey: "k-some-value", proxyId: null, enabled: true }],
        delete: ["w2"],
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("invalid_config");
  });

  it("空 patch 不写盘", async () => {
    let applied = 0;
    const { app } = makeApp(makeConfig(), { onApply: () => (applied += 1) });

    const { status, body } = await patch(app, {});
    expect(status).toBe(200);
    expect(body["changed"]).toBe(false);
    // 无谓的写盘会顺带跑一次 Worker 池 re-sync,只增加出错机会。
    expect(applied).toBe(0);
  });

  it("**把字段写成当前值不算改** —— 表单式保存不该每次都写盘", async () => {
    /*
     * 若 `changed` 按"这个字段有没有出现在 patch 里"判定，
     * 把一个字段写成它**当前的值**也算改了。而管理 UI 提交的是整张表单
     * —— 网关页每次「保存」都会触发一次原子写 + Worker 池 re-sync，
     * 即使用户什么都没动。`admin.ts` 的注释承诺的正是相反的行为。
     *
     * `config.json` 是唯一一份凭证存储，写它不是免费的；而 re-sync 会让
     * 池重建一次，只增加出错机会。
     */
    const config = makeConfig();
    let applied = 0;
    const { app } = makeApp(config, { onApply: () => (applied += 1) });

    // 一、写成当前值 → 不算改，不写盘。
    const same = await patch(app, { gateway: { maxAttempts: config.gateway.maxAttempts } });
    expect(same.status).toBe(200);
    expect(same.body["changed"]).toBe(false);
    expect(applied).toBe(0);

    // 二、真的改一个值 → 算改，写盘。
    const diff = await patch(app, { gateway: { maxAttempts: config.gateway.maxAttempts + 1 } });
    expect(diff.status).toBe(200);
    expect(diff.body["changed"]).toBe(true);
    expect(applied).toBe(1);
  });

  it("整张表单原样回传（多字段全等于当前值）也不算改", () => {
    /*
     * 这是上一条的真实形态 —— UI 提交的不是单个字段。
     * 用纯函数直接验，不经 HTTP：要钉的是合并层的判定。
     */
    const config = makeConfig();
    const result = applyConfigPatch(config, {
      gateway: {
        maxAttempts: config.gateway.maxAttempts,
        headersTimeoutMs: config.gateway.headersTimeoutMs,
        bodyTimeoutMs: config.gateway.bodyTimeoutMs,
      },
      models: {
        freeSuffix: config.models.freeSuffix,
        extraFreeIds: [...config.models.extraFreeIds],
        catalogTtlMs: config.models.catalogTtlMs,
        enforceCatalog: config.models.enforceCatalog,
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(false);
  });

  it("`{set}` 成同一个凭证值也不算改", () => {
    /*
     * 凭证是三态写入里最容易误判的：前端拿不到原值，所以它**不会**回传
     * —— 但一个脚本可能会。写成同一个值仍然不该触发写盘。
     */
    const config = makeConfig();
    const result = applyConfigPatch(config, {
      gateway: { relayToken: { set: config.gateway.relayToken } },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(false);

    // 换一个值就该算改。
    const other = applyConfigPatch(config, {
      gateway: { relayToken: { set: "a-different-relay-token-value" } },
    });
    expect(other.ok).toBe(true);
    if (!other.ok) return;
    expect(other.changed).toBe(true);
  });

  it("请求体超过 1 MiB 被拒（管理面的 body 上限）", async () => {
    const { app } = makeApp(makeConfig());
    /*
     * 安全约束:管理 JSON 有上限,而 relay 透传对多模态保持无界。
     * 管理侧没有读 body 的代码时这条约束是**空洞成立**的,
     * 所以加端点时闸门必须同时到位。
     *
     * ## 载荷必须「超大但其余合法」
     *
     * 不能用 `name: "x".repeat(2MiB)` —— `WorkerPatchSchema` 有
     * `name.max(200)`,于是 schema 也会拒它,**两条路都返回 400**,
     * 断言无法区分。变异测试会存活:把上限改成 MAX_SAFE_INTEGER 后
     * 测试依然绿(它撞的是 schema 而不是上限)。
     *
     * 改用大量**合法**的 delete 项:每项都是合法字符串,总体积超 1 MiB。
     * 于是唯一会拒它的就是体积闸门。
     */
    const many = Array.from({ length: 30_000 }, (_, i) => `worker-${i}`.padEnd(40, "0"));
    const body = { workers: { delete: many } };
    expect(JSON.stringify(body).length).toBeGreaterThan(1024 * 1024);

    const { status, body: res } = await patch(app, body);
    expect(status).toBe(400);
    expect((res["error"] as { message: string }).message).toContain("上限");
  });

  it("**`POST /batch-probe` 也有上限** —— 上限属于闸门，不属于某个调用点", async () => {
    /*
     * `MAX_ADMIN_BODY_BYTES` 是 admin 模块的常量；若两个写端点里只有
     * `PATCH /config` 用它、`/batch-probe` 直接 `c.req.json()`，8 MiB 的体
     * 会被照常接受 —— "管理 JSON 有上限"这条约束**只覆盖了一半的写端点**。
     */
    const { app } = makeApp(makeConfig());
    const body = { action: "start", padding: "x".repeat(2 * 1024 * 1024) };
    expect(JSON.stringify(body).length).toBeGreaterThan(1024 * 1024);

    const res = await app.request(
      "http://127.0.0.1/api/batch-probe",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
      { remoteAddress: "127.0.0.1" } as never,
    );

    /*
     * 400 而不是 500：体积闸门排在 `deps.batch === undefined` 那个业务检查
     * **之前**。反过来的话，一个 8 MiB 的请求在 runner 未就绪时会先被完整
     * 读进内存再返回 500 —— 而闸门存在的理由正是"不要读那么多"。
     */
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error?: { message?: string } };
    expect(json.error?.message).toContain("上限");
  });

  it("**chunked 编码绕不过上限** —— `content-length` 可以缺席", async () => {
    /*
     * 先前的实现先查 `content-length`、再读完量一次。第一道对
     * `transfer-encoding: chunked` 无效（那个头根本不给），第二道在
     * 体已进内存之后。这里用流式请求体复现"没有 content-length"的形态：
     * 判据是网关**读入的字节数**，而不是它最终是否返回 400。
     */
    const { app } = makeApp(makeConfig());
    const CHUNK = 256 * 1024;
    const TOTAL = 16 * 1024 * 1024;
    let produced = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (produced >= TOTAL) {
          controller.close();
          return;
        }
        produced += CHUNK;
        controller.enqueue(new Uint8Array(CHUNK).fill(0x61));
      },
    });

    const res = await app.request(
      "http://127.0.0.1/api/config",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body,
        // @ts-expect-error duplex 是流式请求体必需的，TS 的 RequestInit 还没有它
        duplex: "half",
      },
      { remoteAddress: "127.0.0.1" } as never,
    );

    expect(res.status).toBe(400);
    // 上限 1 MiB，客户端想发 16 MiB —— 读入量必须停在上限附近。
    expect(produced / 1048576).toBeLessThan(1 + 2);
  }, 30_000);

  it("非 JSON 体被拒,且不回显体内容", async () => {
    const { app } = makeApp(makeConfig());
    const res = await app.request(
      "http://127.0.0.1/api/config",
      { method: "PATCH", headers: { "content-type": "application/json" }, body: "{ not json" },
      { remoteAddress: "127.0.0.1" } as never,
    );
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).not.toContain("not json");
  });
});

/* ================================================================== *
 * 热更新真的生效
 * ================================================================== */

describe("配置热更新", () => {
  it("改配置后调度器立刻看到新的 Worker 池 —— 不必重启", async () => {
    const config = makeConfig();
    const { app } = makeApp(config);

    const before = OverviewSchema.parse((await get(app, "/api/overview")).body);
    expect(before.pool.total).toBe(2);

    await patch(app, { workers: { update: { w2: { enabled: false } } } });

    /*
     * `Scheduler.#syncedFrom` 用**引用比较**判断「配置换了没有」,所以
     * `applyConfig` 必须换一个**新对象**。原地改会让引用不变 → 池不 re-sync
     * → 改了配置下一个请求还在用旧的池,而这个偏差**不报任何错**。
     */
    const after = OverviewSchema.parse((await get(app, "/api/overview")).body);
    expect(after.pool.total).toBe(1);
    expect(after.workers.find((w) => w.id === "w2")!.inPool).toBe(false);
  });

  it("applyConfigPatch 不改原配置对象（引用比较要成立）", () => {
    const config = makeConfig();
    const snapshot = JSON.stringify(config);

    const result = applyConfigPatch(config, { workers: { update: { w1: { name: "改了" } } } });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 原对象必须**没变** —— 否则引用比较看不出「配置换了」。
    expect(JSON.stringify(config)).toBe(snapshot);
    expect(result.config).not.toBe(config);
  });
});

/* ================================================================== *
 * 管理面仅回环（装配期断言）
 * ================================================================== */

describe("管理路由必须被 loopbackOnly 覆盖", () => {
  it("非回环来源一律 403", async () => {
    const { app } = makeApp(makeConfig(), { address: "203.0.113.9" });
    expect((await app.request("http://127.0.0.1/api/overview")).status).toBe(403);
    expect((await app.request("http://127.0.0.1/api/stats")).status).toBe(403);
    expect((await app.request("http://127.0.0.1/api/ping")).status).toBe(403);
  });

  it("绝不采信 X-Forwarded-For", async () => {
    const { app } = makeApp(makeConfig(), { address: "203.0.113.9" });
    const res = await app.request("http://127.0.0.1/api/overview", {
      headers: { "x-forwarded-for": "127.0.0.1" },
    });
    /*
     * 该头由客户端任意设置。若用它判断来源,一个远端请求只要带上
     * `X-Forwarded-For: 127.0.0.1` 就能拿到管理面权限。
     */
    expect(res.status).toBe(403);
  });

  it("IPv4-mapped IPv6 的本机请求要放行（双栈监听下的真实形态）", async () => {
    // 实测:客户端连 127.0.0.1 时 getConnInfo 报的就是这个形态。
    const { app } = makeApp(makeConfig(), { address: "::ffff:127.0.0.1" });
    expect((await app.request("http://127.0.0.1/api/ping")).status).toBe(200);
  });

  it("写入端点同样被回环闸门挡住", async () => {
    const { app, getConfig } = makeApp(makeConfig(), { address: "203.0.113.9" });
    const before = JSON.stringify(getConfig());
    const res = await app.request("http://127.0.0.1/api/config", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workers: { update: { w1: { name: "远端改的" } } } }),
    });
    expect(res.status).toBe(403);
    expect(JSON.stringify(getConfig())).toBe(before);
  });
});

/* ================================================================== *
 * 真实落盘
 * ================================================================== */

describe("配置写入是原子的且权限正确", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "zg-admin-"));
  });

  it("写盘后文件是 0600 且内容能重新加载", async () => {
    const { saveConfig, loadConfig } = await import("../../src/store/config.ts");
    const config = makeConfig();

    await saveConfig(config, root);

    const { stat } = await import("node:fs/promises");
    const st = await stat(join(root, "data", "config.json"));
    // 整个文件都是凭证 —— 只有属主可读写。
    expect(st.mode & 0o777).toBe(0o600);

    const reloaded = await loadConfig(root);
    expect(reloaded.config.workers[0]!.apiKey).toBe(KEY_A);

    await rm(root, { recursive: true, force: true });
  });

  it("写入的 JSON 不含任何多余字段（schema 是 strict）", async () => {
    const { saveConfig } = await import("../../src/store/config.ts");
    await saveConfig(makeConfig(), root);

    const text = await readFile(join(root, "data", "config.json"), "utf8");
    const parsed = ConfigSchema.safeParse(JSON.parse(text));
    expect(parsed.success).toBe(true);

    await rm(root, { recursive: true, force: true });
  });
});
