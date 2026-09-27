import { bulkCandidates, duplicateEgress } from "../../src/admin/components/BulkImportDialog.tsx";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkersPage } from "../../src/admin/pages/WorkersPage.tsx";
import { GatewayPage } from "../../src/admin/pages/GatewayPage.tsx";
import { ClientPage } from "../../src/admin/pages/ClientPage.tsx";
import { ProxyPage } from "../../src/admin/pages/ProxyPage.tsx";
import { ClashSection } from "../../src/admin/components/ClashSection.tsx";
import { ClashImportFlow } from "../../src/admin/components/ClashImportFlow.tsx";
import { OpenCodeConfigCard } from "../../src/admin/components/OpenCodeConfigCard.tsx";
import { bulkAnonymousWorkers, bulkWorkerName, nextIndex, tidyNodeName, suggestWorker, validateWorkerId, WORKER_NAME_MAX } from "../../src/shared/workerIds.ts";
import { versionFromDetected } from "../../src/admin/lib/consoleApi.ts";
import { parseHash } from "../../src/admin/lib/router.ts";
import * as adminApi from "../../src/admin/lib/api.ts";
import type { FetchState } from "../../src/admin/lib/api.ts";
import { ConfigPatchSchema, OpenCodeViewSchema, type OpenCodeView, type ProxyList, type ProxyView, type WorkerView } from "../../src/shared/contract.ts";
import { fakeOverview } from "./App.test.tsx";

/*
 * 控制台里的写操作：Worker 自动编号与批量导入、OpenCode 写入、凭证三态、
 * Relay Token 轮换、Clash 探测导入、代理启停删除。每个请求体都过真实契约。
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.location.hash = "";
});

const noop = () => {};

function worker(over: Partial<WorkerView> = {}): WorkerView {
  return {
    id: "anon-1",
    name: "",
    kind: "anonymous",
    enabled: true,
    proxyId: null,
    apiKey: { present: false, fingerprint: null },
    inPool: true,
    ready: true,
    cooldownRemainingMs: 0,
    consecutiveFails: 0,
    lastFailure: null,
    egressIp: null,
    ...over,
  };
}

function proxy(over: Partial<ProxyView> = {}): ProxyView {
  return {
    id: "p1",
    name: "节点一",
    type: "anytls",
    host: "127.0.0.1",
    port: 7897,
    enabled: true,
    source: "controller",
    bridgeId: "b1",
    clashNodeName: "节点一",
    direct: false,
    bridgeable: true,
    egressIp: null,
    password: { present: false, fingerprint: null },
    usedBy: [],
    resolvable: true,
    unresolvableReason: null,
    ...over,
  };
}

function proxyList(proxies: ProxyView[], over: Partial<ProxyList> = {}): ProxyList {
  return {
    proxies,
    clash: { enabled: true, selectionMode: "auto", activeBridgeId: null, bridges: [] },
    isolation: { groups: [], unknownWorkerIds: [], sharedGroups: [], isolated: false },
    subscriptions: [],
    ...over,
  };
}

const ready = <T,>(data: T): FetchState<T> => ({ status: "ready", data });

/** 捕获 patchConfig 的调用，并确认每个补丁都过 `ConfigPatchSchema`。 */
function spyPatch(result: "ok" | Error = "ok") {
  const spy = vi.spyOn(adminApi, "patchConfig");
  if (result === "ok") spy.mockResolvedValue(undefined);
  else spy.mockRejectedValue(result);
  return {
    spy,
    patches: () =>
      spy.mock.calls.map(([p]) => {
        const parsed = ConfigPatchSchema.safeParse(p);
        expect(parsed.success, JSON.stringify(p)).toBe(true);
        return p;
      }),
  };
}

/* ================================================================== *
 * Worker 编号
 * ================================================================== */

describe("Worker id 建议", () => {
  it("取现有最大序号 + 1，不填空洞；按类型分开编号", () => {
    expect(nextIndex([], "anonymous")).toBe(1);
    expect(nextIndex(["anon-1", "anon-3", "auth-7", "anon-x", "anon-02"], "anonymous")).toBe(4);
    expect(nextIndex(["anon-1", "auth-7"], "authenticated")).toBe(8);
    expect(suggestWorker(["anon-2"], "anonymous")).toEqual({ id: "anon-3", name: "匿名 3" });
    expect(suggestWorker([], "authenticated")).toEqual({ id: "auth-1", name: "认证 1" });
  });

  it("客户端校验：字符集、长度、唯一性", () => {
    const taken = new Set(["anon-1"]);
    expect(validateWorkerId("anon-2", taken)).toBeNull();
    expect(validateWorkerId("a.b_c:d-e", taken)).toBeNull();
    expect(validateWorkerId("", taken)).toMatch(/不能为空/);
    expect(validateWorkerId("有 空格", taken)).toMatch(/只允许/);
    expect(validateWorkerId("x".repeat(129), taken)).toMatch(/1 到 128/);
    expect(validateWorkerId("x".repeat(128), taken)).toBeNull();
    expect(validateWorkerId(" anon-1 ", taken)).toMatch(/已被占用/);
  });

  it("新增表单默认匿名、启用，id 与名称自动填好", async () => {
    const user = userEvent.setup();
    const { patches } = spyPatch();
    const data = fakeOverview({ workers: [worker({ id: "anon-1" }), worker({ id: "anon-4" })] });
    render(<WorkersPage data={data} view={parseHash("#workers")} navigate={noop} />);
    await user.click(screen.getByRole("button", { name: "新增 Worker" }));
    const form = screen.getByRole("form", { name: "新增 Worker" });
    expect(within(form).getByLabelText("类型")).toHaveValue("anonymous");
    expect(within(form).getByLabelText("ID")).toHaveValue("anon-5");
    expect(within(form).getByLabelText("名称")).toHaveValue("匿名 5");
    expect(within(form).getByRole("checkbox", { name: "启用" })).toBeChecked();
    await user.click(within(form).getByRole("button", { name: "保存" }));
    expect(patches()).toEqual([
      { workers: { create: [{ id: "anon-5", name: "匿名 5", kind: "anonymous", apiKey: "", proxyId: null, enabled: true }] } },
    ]);
  });

  it("切换类型时重新建议，但不覆盖用户改过的字段", async () => {
    const user = userEvent.setup();
    render(<WorkersPage data={fakeOverview({ workers: [worker({ id: "auth-2", kind: "authenticated" })] })} view={parseHash("#workers")} navigate={noop} />);
    await user.click(screen.getByRole("button", { name: "新增 Worker" }));
    const form = screen.getByRole("form", { name: "新增 Worker" });
    await user.selectOptions(within(form).getByLabelText("类型"), "authenticated");
    expect(within(form).getByLabelText("ID")).toHaveValue("auth-3");
    expect(within(form).getByLabelText("名称")).toHaveValue("认证 3");

    await user.clear(within(form).getByLabelText("名称"));
    await user.type(within(form).getByLabelText("名称"), "我的号");
    await user.selectOptions(within(form).getByLabelText("类型"), "anonymous");
    expect(within(form).getByLabelText("ID")).toHaveValue("anon-1");
    expect(within(form).getByLabelText("名称")).toHaveValue("我的号");

    await user.clear(within(form).getByLabelText("ID"));
    await user.type(within(form).getByLabelText("ID"), "custom");
    await user.selectOptions(within(form).getByLabelText("类型"), "authenticated");
    expect(within(form).getByLabelText("ID")).toHaveValue("custom");
  });

  it("id 重复或非法时不发请求，错误贴在字段旁", async () => {
    const user = userEvent.setup();
    const { spy } = spyPatch();
    render(<WorkersPage data={fakeOverview({ workers: [worker({ id: "anon-1" })] })} view={parseHash("#workers")} navigate={noop} />);
    await user.click(screen.getByRole("button", { name: "新增 Worker" }));
    const form = screen.getByRole("form", { name: "新增 Worker" });
    const id = within(form).getByLabelText("ID");
    await user.clear(id);
    await user.type(id, "anon-1");
    await user.click(within(form).getByRole("button", { name: "保存" }));
    expect(spy).not.toHaveBeenCalled();
    expect(within(form).getByRole("alert")).toHaveTextContent("已被占用");
    expect(id).toHaveAttribute("aria-invalid", "true");

    await user.clear(id);
    await user.type(id, "bad id");
    await user.click(within(form).getByRole("button", { name: "保存" }));
    expect(spy).not.toHaveBeenCalled();
    expect(within(form).getByRole("alert")).toHaveTextContent("只允许");
  });
});

/* ================================================================== *
 * 从 Clash 节点批量导入
 * ================================================================== */

describe("从 Clash 节点批量导入匿名 Worker", () => {
  const nodes = [
    proxy({ id: "p1", name: "香港 01", clashNodeName: "香港 01" }),
    proxy({ id: "p2", name: "日本 01", clashNodeName: "日本 01" }),
    proxy({ id: "p3", name: "香港 02", clashNodeName: "香港 02" }),
    proxy({ id: "used", name: "已用", clashNodeName: "已用", usedBy: ["anon-1"] }),
    proxy({ id: "off", name: "停用", clashNodeName: "停用", enabled: false }),
    proxy({ id: "manual", name: "手工", clashNodeName: null, source: "manual", bridgeId: null, direct: true }),
  ];

  it("批量导入的名称去掉节点名里的广告域名与网址尾巴", () => {
    expect(tidyNodeName("🇯🇵 日本1 VIP1 网址:example.invalid")).toBe("🇯🇵 日本1 VIP1");
    expect(tidyNodeName("香港 IPLC 01 | 官网 proxy.invalid")).toBe("香港 IPLC 01");
    expect(tidyNodeName("美国 02 proxy.invalid")).toBe("美国 02");
    expect(tidyNodeName("网址:proxy.invalid")).toBe("网址:proxy.invalid");
    expect(bulkWorkerName("🇸🇬 新加坡 03 网址：proxy.invalid")).toBe("匿名 · 🇸🇬 新加坡 03");
  });

  it("名称按码点截到契约上限，不切坏 emoji", () => {
    const long = `🇺🇸${"节".repeat(300)}`;
    const name = bulkWorkerName(long);
    expect([...name].length).toBe(WORKER_NAME_MAX);
    expect(name.startsWith("匿名 · 🇺🇸")).toBe(true);
    expect(bulkAnonymousWorkers(["anon-2"], [{ id: "p", name: "n" }])).toEqual([
      { id: "anon-3", name: "匿名 · n", kind: "anonymous", apiKey: "", proxyId: "p", enabled: true },
    ]);
  });

  async function openDialog() {
    const user = userEvent.setup();
    const { patches } = spyPatch();
    const refresh = vi.fn();
    render(
      <WorkersPage
        data={fakeOverview({ workers: [worker({ id: "anon-1", proxyId: "used" }), worker({ id: "anon-7" })] })}
        view={parseHash("#workers")}
        navigate={noop}
        refresh={refresh}
        proxies={ready(proxyList(nodes))}
      />,
    );
    await user.click(screen.getByRole("button", { name: /从 Clash 节点导入/ }));
    const dialog = screen.getByRole("dialog", { name: "从 Clash 节点导入匿名 Worker" });
    return { user, patches, refresh, dialog };
  }

  it("只列未被引用、已启用的 Clash 节点，默认全选", async () => {
    const { dialog } = await openDialog();
    const list = within(dialog).getByRole("list", { name: "候选节点" });
    const boxes = within(list).getAllByRole("checkbox");
    expect(boxes.map((b) => b.closest("label")!.textContent)).toEqual(["香港 01", "日本 01", "香港 02"]);
    expect(boxes.every((b) => (b as HTMLInputElement).checked)).toBe(true);
    expect(within(dialog).getByText(/已选/)).toHaveTextContent("已选 3 / 3 个节点");
    expect(within(dialog).getByLabelText("筛选节点")).toHaveFocus();
  });

  it("筛选后全不选只影响可见项；提交是一次 PATCH，id 接着 anon-N", async () => {
    const { user, dialog, patches, refresh } = await openDialog();
    await user.type(within(dialog).getByLabelText("筛选节点"), "香港");
    expect(within(within(dialog).getByRole("list", { name: "候选节点" })).getAllByRole("checkbox")).toHaveLength(2);
    await user.click(within(dialog).getByRole("button", { name: "全不选" }));
    expect(within(dialog).getByText(/已选/)).toHaveTextContent("已选 1 / 3");
    await user.click(within(dialog).getByRole("button", { name: "全选" }));
    await user.clear(within(dialog).getByLabelText("筛选节点"));
    await user.click(within(dialog).getByRole("checkbox", { name: "日本 01" }));
    await user.click(within(dialog).getByRole("button", { name: "创建 2 个 Worker" }));

    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(patches()).toEqual([
      {
        workers: {
          create: [
            { id: "anon-8", name: "匿名 · 香港 01", kind: "anonymous", apiKey: "", proxyId: "p1", enabled: true },
            { id: "anon-9", name: "匿名 · 香港 02", kind: "anonymous", apiKey: "", proxyId: "p3", enabled: true },
          ],
        },
      },
    ]);
    expect(await screen.findByText("已从 Clash 节点新建 2 个匿名 Worker")).toBeInTheDocument();
  });

  it("回显 IP 与已用节点或前面的候选重复时标出，并可一键去掉", async () => {
    const all = [
      proxy({ id: "used", name: "已用", clashNodeName: "已用", usedBy: ["anon-1"], egressIp: "198.51.100.1" }),
      proxy({ id: "a", name: "甲", clashNodeName: "甲", egressIp: "198.51.100.1" }),
      proxy({ id: "b", name: "乙", clashNodeName: "乙", egressIp: "198.51.100.2" }),
      proxy({ id: "c", name: "丙", clashNodeName: "丙", egressIp: "198.51.100.2" }),
      proxy({ id: "d", name: "丁", clashNodeName: "丁", egressIp: null }),
    ];
    expect([...duplicateEgress(all, bulkCandidates(all))].sort()).toEqual(["a", "c"]);
  });

  it("一个都没选时提交按钮禁用", async () => {
    const { user, dialog, patches } = await openDialog();
    await user.click(within(dialog).getByRole("button", { name: "全不选" }));
    expect(within(dialog).getByRole("button", { name: "创建 0 个 Worker" })).toBeDisabled();
    expect(patches()).toEqual([]);
  });

  it("失败时留在对话框里显示原因", async () => {
    const user = userEvent.setup();
    spyPatch(new Error("Worker id 已存在:anon-8"));
    render(
      <WorkersPage data={fakeOverview({ workers: [worker({ id: "anon-7" })] })} view={parseHash("#workers")} navigate={noop} proxies={ready(proxyList(nodes))} />,
    );
    await user.click(screen.getByRole("button", { name: /从 Clash 节点导入/ }));
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /创建 \d+ 个 Worker/ }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Worker id 已存在");
  });
});

/* ================================================================== *
 * OpenCode 写入
 * ================================================================== */

function opencodeView(over: Partial<OpenCodeView> = {}): OpenCodeView {
  return OpenCodeViewSchema.parse({
    path: "opencode.json",
    exists: false,
    detectedVersion: "1.4.0",
    shape: null,
    pointsToGateway: false,
    unwritableReason: null,
    ...over,
  });
}

describe("OpenCode 项目配置写入", () => {
  it("版本默认取检测值；写入发所选版本并回调刷新", async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((path: string, init?: { body?: string }) => {
        bodies.push({ path, body: JSON.parse(init?.body ?? "null") });
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(opencodeView({ exists: true, pointsToGateway: true, shape: "v1" })) });
      }),
    );
    const onWritten = vi.fn();
    render(<OpenCodeConfigCard status={ready(opencodeView())} onWritten={onWritten} />);
    expect(screen.getByRole("combobox", { name: "OpenCode 版本" })).toHaveValue("1");
    expect(screen.getByText("opencode.json 还不存在")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "写入 opencode.json" }));
    await waitFor(() => expect(onWritten).toHaveBeenCalledTimes(1));
    expect(bodies).toEqual([{ path: "/api/opencode/write", body: { version: "1" } }]);
    expect(await screen.findByText("已写入")).toBeInTheDocument();
  });

  it("已存在时按钮是重写；不能改写时说明原因", () => {
    render(<OpenCodeConfigCard status={ready(opencodeView({ exists: true, unwritableReason: "文件含注释" }))} onWritten={noop} />);
    expect(screen.getByRole("button", { name: "重写 opencode.json" })).toBeInTheDocument();
    expect(screen.getByText("不会改写：文件含注释")).toBeInTheDocument();
    expect(screen.getByText("opencode.json 未指向本网关")).toBeInTheDocument();
  });

  it("写入失败在按钮旁报出", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve({ ok: false, status: 400, json: () => Promise.resolve({ error: { type: "invalid_request", message: "文件无法解析" } }) })),
    );
    const onWritten = vi.fn();
    render(<OpenCodeConfigCard status={ready(opencodeView())} onWritten={onWritten} />);
    await user.click(screen.getByRole("button", { name: "写入 opencode.json" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("文件无法解析");
    expect(onWritten).not.toHaveBeenCalled();
  });

  it("版本解析：1.x → 1，2.x 或未安装 → 2", () => {
    expect(versionFromDetected("1.4.0")).toBe("1");
    expect(versionFromDetected("v1.0.3")).toBe("1");
    expect(versionFromDetected("2.0.12")).toBe("2");
    expect(versionFromDetected("10.0.0")).toBe("2");
    expect(versionFromDetected(null)).toBe("2");
  });
});

/* ================================================================== *
 * Relay Token 轮换
 * ================================================================== */

describe("Relay Token 轮换", () => {
  it("先确认；默认勾选同时重写 opencode.json，确认后先 rotate 再写文件", async () => {
    const user = userEvent.setup();
    const { patches, spy } = spyPatch();
    const writes: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((path: string, init?: { body?: string }) => {
        // 只记写请求：同页的局域网卡片会 GET /api/lan/status。
        if (path !== "/api/lan/status") writes.push({ path, body: JSON.parse(init?.body ?? "null") });
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(opencodeView({ exists: true, pointsToGateway: true })) });
      }),
    );
    render(<ClientPage data={fakeOverview()} opencode={ready(opencodeView({ exists: true, pointsToGateway: true, detectedVersion: "2.0.12" }))} />);

    await user.click(screen.getByRole("button", { name: "轮换 Relay Token" }));
    const dialog = screen.getByRole("dialog", { name: "轮换 Relay Token" });
    expect(dialog.textContent).toContain("401");
    expect(within(dialog).getByRole("button", { name: "取消" })).toHaveFocus();
    expect(within(dialog).getByRole("checkbox", { name: /同时把新 token 写入/ })).toBeChecked();
    expect(spy).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole("button", { name: "确认轮换" }));
    expect(await screen.findByText("已轮换，并已把新 token 写入 opencode.json")).toBeInTheDocument();
    expect(patches()).toEqual([{ gateway: { relayToken: { rotate: true } } }]);
    expect(writes).toEqual([{ path: "/api/opencode/write", body: { version: "2" } }]);
  });

  it("取消勾选则只轮换；opencode.json 未指向网关时重写提示常驻（由服务端判据驱动）", async () => {
    const user = userEvent.setup();
    const { patches } = spyPatch();
    const writes: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((path: string, init?: { body?: string }) => {
        if (path !== "/api/lan/status") writes.push({ path, body: JSON.parse(init?.body ?? "null") });
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(opencodeView({ exists: true, pointsToGateway: true })) });
      }),
    );
    const { rerender } = render(
      <ClientPage data={fakeOverview()} opencode={ready(opencodeView({ exists: true, pointsToGateway: true, detectedVersion: "2.0.12" }))} />,
    );
    expect(screen.queryByText(/没有指向本网关/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "轮换 Relay Token" }));
    const dialog = screen.getByRole("dialog", { name: "轮换 Relay Token" });
    await user.click(within(dialog).getByRole("checkbox", { name: /同时把新 token 写入/ }));
    await user.click(within(dialog).getByRole("button", { name: "确认轮换" }));
    expect(await screen.findByText("已轮换，新 token 立即生效")).toBeInTheDocument();
    expect(patches()).toHaveLength(1);
    expect(writes).toEqual([]);

    // 服务端判据变为「未指向」后（例如轮换后刷新），提示出现；重写后文件指向当前 token。
    rerender(<ClientPage data={fakeOverview()} opencode={ready(opencodeView({ exists: true, pointsToGateway: false, detectedVersion: "2.0.12" }))} />);
    const prompt = screen.getByText(/没有指向本网关/).closest("[data-rewrite-prompt]") as HTMLElement;
    await user.click(within(prompt).getByRole("button", { name: "重写 opencode.json" }));
    await within(prompt).findByText("已重写 opencode.json");
    expect(writes).toEqual([{ path: "/api/opencode/write", body: { version: "2" } }]);
  });

  it("取消不发请求", async () => {
    const user = userEvent.setup();
    const { spy } = spyPatch();
    render(<ClientPage data={fakeOverview()} />);
    await user.click(screen.getByRole("button", { name: "轮换 Relay Token" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "取消" }));
    expect(spy).not.toHaveBeenCalled();
  });
});

/* ================================================================== *
 * 运行参数与调度：单位换算
 * ================================================================== */

describe("网关页设置表单", () => {
  it("超时以秒显示、以毫秒提交；越界不发请求", async () => {
    const user = userEvent.setup();
    const { patches, spy } = spyPatch();
    render(<GatewayPage data={fakeOverview()} />);
    const form = screen.getByRole("form", { name: "运行参数" });
    const headers = within(form).getByLabelText("响应头超时（秒）");
    expect(headers).toHaveValue("60");
    await user.clear(headers);
    await user.type(headers, "0.5");
    await user.click(within(form).getByRole("button", { name: "保存运行参数" }));
    expect(spy).not.toHaveBeenCalled();
    expect(within(form).getByRole("alert")).toHaveTextContent("响应头超时必须是 1 到 600 秒之间的数");

    await user.clear(headers);
    await user.type(headers, "90");
    await user.click(within(form).getByRole("button", { name: "保存运行参数" }));
    await within(form).findByText("已保存");
    expect(patches()).toEqual([{ gateway: { maxAttempts: 3, headersTimeoutMs: 90_000, bodyTimeoutMs: 300_000 } }]);
  });

  it("调度：亲和时长以分钟显示，冷却以秒显示，提交毫秒", async () => {
    const user = userEvent.setup();
    const { patches } = spyPatch();
    render(<GatewayPage data={fakeOverview()} />);
    const form = screen.getByRole("form", { name: "调度" });
    expect(within(form).getByLabelText("会话亲和时长（分钟）")).toHaveValue("60");
    expect(within(form).getByLabelText("限流冷却（秒）")).toHaveValue("900");
    await user.selectOptions(within(form).getByLabelText("调度策略"), "mixed");
    await user.clear(within(form).getByLabelText("会话亲和时长（分钟）"));
    await user.type(within(form).getByLabelText("会话亲和时长（分钟）"), "5");
    await user.clear(within(form).getByLabelText("403 冷却（秒）"));
    await user.type(within(form).getByLabelText("403 冷却（秒）"), "2.5");
    await user.click(within(form).getByRole("button", { name: "保存调度设置" }));
    await within(form).findByText("已保存");
    expect(patches()).toEqual([
      {
        routing: {
          strategy: "mixed",
          affinityTtlMs: 300_000,
          cooldown: { rateLimitMs: 900_000, authFailMs: 60_000, forbiddenMs: 2_500, transportBaseMs: 2_000, transportMaxMs: 120_000 },
        },
      },
    ]);
  });
});

/* ================================================================== *
 * 凭证三态
 * ================================================================== */

const bridgeView = {
  id: "b1",
  name: "verge",
  enabled: true,
  priority: 100,
  apiBase: "http://127.0.0.1:9097",
  apiSecret: { present: true, fingerprint: "aaaa1111" },
  localProxyHost: "127.0.0.1",
  localProxyPort: 7897,
  selectorGroup: "Proxy",
};

describe("Clash 内核 secret 三态", () => {
  async function editBridge() {
    const user = userEvent.setup();
    const helpers = spyPatch();
    render(<ClashSection clash={{ enabled: true, selectionMode: "auto", activeBridgeId: "b1", bridges: [bridgeView] }} refresh={noop} />);
    await user.click(screen.getByRole("button", { name: "编辑" }));
    const form = screen.getByRole("form", { name: "编辑内核 b1" });
    return { user, form, ...helpers };
  }

  it("默认留空不改：补丁里没有 apiSecret", async () => {
    const { user, form, patches } = await editBridge();
    expect(within(form).getByText("aaaa1111")).toBeInTheDocument();
    await user.click(within(form).getByRole("button", { name: "保存内核" }));
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0]!.clash!.bridges!.update!.b1).not.toHaveProperty("apiSecret");
  });

  it("设置新值：密码框输入，发 {set}", async () => {
    const { user, form, patches } = await editBridge();
    await user.selectOptions(within(form).getByLabelText("控制面 secret的修改方式"), "set");
    const input = within(form).getByLabelText("新的控制面 secret");
    expect(input).toHaveAttribute("type", "password");
    await user.type(input, "fake-secret-not-real");
    await user.click(within(form).getByRole("button", { name: "保存内核" }));
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0]!.clash!.bridges!.update!.b1!.apiSecret).toEqual({ set: "fake-secret-not-real" });
  });

  it("清空：发 {clear:true}", async () => {
    const { user, form, patches } = await editBridge();
    await user.selectOptions(within(form).getByLabelText("控制面 secret的修改方式"), "clear");
    await user.click(within(form).getByRole("button", { name: "保存内核" }));
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0]!.clash!.bridges!.update!.b1!.apiSecret).toEqual({ clear: true });
  });

  it("删除内核先确认，说明会连带删除节点", async () => {
    const user = userEvent.setup();
    const { patches } = spyPatch();
    render(<ClashSection clash={{ enabled: true, selectionMode: "auto", activeBridgeId: "b1", bridges: [bridgeView] }} refresh={noop} />);
    await user.click(screen.getByRole("button", { name: "删除" }));
    const dialog = screen.getByRole("dialog", { name: "删除 Clash 内核" });
    expect(dialog.textContent).toContain("导入的全部代理节点");
    await user.click(within(dialog).getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(patches()).toEqual([{ clash: { bridges: { delete: ["b1"] } } }]));
  });
});

describe("Clash 内核列表", () => {
  it("超过一页时能翻到后面的内核", async () => {
    const user = userEvent.setup();
    const bridges = Array.from({ length: 20 }, (_, i) => ({ ...bridgeView, id: `b${i + 1}`, name: `内核 ${String(i + 1).padStart(2, "0")}` }));
    render(<ClashSection clash={{ enabled: true, selectionMode: "auto", activeBridgeId: "b1", bridges }} refresh={noop} />);
    expect(screen.queryByText("内核 20")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "下一页" }));
    expect(screen.getByText("内核 20")).toBeInTheDocument();
  });
});

describe("订阅 URL 三态", () => {
  const sub = {
    id: "sub1",
    name: "机场一",
    urlRedacted: "https://sub.example.invalid/link?token=***",
    enabled: true,
    lastFetchedAt: null,
    lastErrorKind: null,
    lastImportCount: 0,
    lastFormat: null,
    proxyCount: 0,
  };

  async function editSub() {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    const user = userEvent.setup();
    const helpers = spyPatch();
    render(<ProxyPage data={proxyList([], { subscriptions: [sub] })} view={parseHash("#proxy?tab=subscriptions")} navigate={noop} refresh={noop} />);
    await user.click(screen.getByRole("button", { name: "编辑" }));
    return { user, form: screen.getByRole("form", { name: "编辑订阅 机场一" }), ...helpers };
  }

  it("编辑时不回填 URL，只显示脱敏串；留空不改不发 url，且不能清空", async () => {
    const { user, form, patches } = await editSub();
    const mode = within(form).getByLabelText("订阅地址的修改方式");
    expect(within(mode).queryByRole("option", { name: "清空" })).not.toBeInTheDocument();
    expect(within(form).getByText(sub.urlRedacted)).toBeInTheDocument();
    await user.click(within(form).getByRole("button", { name: "保存订阅" }));
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0]).toEqual({ subscriptions: { update: { sub1: { name: "机场一", enabled: true } } } });
  });

  it("设置新地址发 {set}，空地址被拦下", async () => {
    const { user, form, patches, spy } = await editSub();
    await user.selectOptions(within(form).getByLabelText("订阅地址的修改方式"), "set");
    await user.click(within(form).getByRole("button", { name: "保存订阅" }));
    expect(spy).not.toHaveBeenCalled();
    expect(within(form).getByRole("alert")).toHaveTextContent("不能为空");
    await user.type(within(form).getByLabelText("新的订阅地址"), "https://sub.example.invalid/new?token=fake");
    await user.click(within(form).getByRole("button", { name: "保存订阅" }));
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0]!.subscriptions!.update!.sub1!.url).toEqual({ set: "https://sub.example.invalid/new?token=fake" });
  });

  it("添加订阅：URL 用密码框，一次 create", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    const user = userEvent.setup();
    const { patches } = spyPatch();
    render(<ProxyPage data={proxyList([])} view={parseHash("#proxy?tab=subscriptions")} navigate={noop} refresh={noop} />);
    await user.click(screen.getByRole("button", { name: "添加订阅" }));
    const form = screen.getByRole("form", { name: "添加订阅" });
    await user.type(within(form).getByLabelText("ID"), "s2");
    await user.type(within(form).getByLabelText("名称"), "机场二");
    const url = within(form).getByLabelText(/订阅地址/);
    expect(url).toHaveAttribute("type", "password");
    await user.type(url, "https://sub.example.invalid/x");
    await user.click(within(form).getByRole("button", { name: "保存订阅" }));
    await waitFor(() =>
      expect(patches()).toEqual([{ subscriptions: { create: [{ id: "s2", name: "机场二", url: "https://sub.example.invalid/x", enabled: true }] } }]),
    );
  });
});

/* ================================================================== *
 * 代理节点启停与删除
 * ================================================================== */

describe("代理节点操作", () => {
  it("被引用的节点不能删并说明原因；未引用的先确认再删；启停发 update", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    const user = userEvent.setup();
    const { patches } = spyPatch();
    const { container } = render(
      <ProxyPage
        data={proxyList([proxy({ id: "p1", name: "甲", usedBy: ["anon-1"] }), proxy({ id: "p2", name: "乙" })])}
        view={parseHash("#proxy")}
        navigate={noop}
        refresh={noop}
      />,
    );
    const row1 = container.querySelector('[data-row="p1"]') as HTMLElement;
    const row2 = container.querySelector('[data-row="p2"]') as HTMLElement;
    // 删除在行的「更多」菜单里；被引用时仍列出，但禁用并说明原因。
    await user.click(within(row1).getByRole("button", { name: "甲 的更多操作" }));
    const del1 = screen.getByRole("menuitem", { name: /^删除/ });
    expect(del1).toBeDisabled();
    expect(del1).toHaveAttribute("title", "被 anon-1 引用，先改绑这些 Worker");
    await user.keyboard("{Escape}");

    await user.click(within(row2).getByRole("button", { name: "乙 的更多操作" }));
    await user.click(screen.getByRole("menuitem", { name: "删除" }));
    await user.click(within(screen.getByRole("dialog", { name: "删除代理节点" })).getByRole("button", { name: "确认删除" }));
    await user.click(within(row1).getByRole("button", { name: "停用" }));
    await waitFor(() =>
      expect(patches()).toEqual([{ proxies: { delete: ["p2"] } }, { proxies: { update: { p1: { enabled: false } } } }]),
    );
  });
});

/* ================================================================== *
 * Clash 探测导入
 * ================================================================== */

describe("Clash 探测与导入", () => {
  it("需要 secret 时给密码框；先预览才能导入，两次请求分别是 dryRun true/false", async () => {
    const user = userEvent.setup();
    const calls: Array<{ path: string; body: unknown }> = [];
    const summary = { bridgesAdded: 1, bridgesUpdated: 0, proxiesAdded: 12, proxiesUpdated: 0, selectorGroup: "Proxy", mixedPort: 7897, warnings: ["分组名含空格"] };
    vi.stubGlobal(
      "fetch",
      vi.fn((path: string, init?: { body?: string }) => {
        const body = JSON.parse(init?.body ?? "null") as { dryRun?: boolean };
        calls.push({ path, body });
        const res =
          path === "/api/clash/discover"
            ? {
                controllers: [
                  { apiBase: "http://127.0.0.1:9090", status: "unreachable", reason: "连接被拒" },
                  { apiBase: "http://127.0.0.1:9097", status: "auth_required", reason: "需要 secret" },
                ],
              }
            : { ok: true, dryRun: body.dryRun, summary };
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(res) });
      }),
    );
    const onImported = vi.fn();
    render(<ClashImportFlow onImported={onImported} />);
    await user.click(screen.getByRole("button", { name: "探测 Clash" }));
    const secret = await screen.findByLabelText("控制面 secret");
    expect(secret).toHaveAttribute("type", "password");
    // 不可达的那个不能选；需要 secret 的被默认选中。
    const radios = screen.getAllByRole("radio");
    expect(radios[0]).toBeDisabled();
    expect(radios[1]).toBeChecked();
    expect(screen.getByRole("button", { name: "导入" })).toBeDisabled();

    await user.type(secret, "fake-secret-not-real");
    await user.click(screen.getByRole("button", { name: "预览" }));
    expect(await screen.findByText("预览（尚未写入）")).toBeInTheDocument();
    expect(screen.getByText("分组名含空格")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "导入" }));
    expect(await screen.findByText("已导入，立即生效")).toBeInTheDocument();
    expect(onImported).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([
      { path: "/api/clash/discover", body: {} },
      { path: "/api/clash/import", body: { apiBase: "http://127.0.0.1:9097", dryRun: true, secret: "fake-secret-not-real" } },
      { path: "/api/clash/import", body: { apiBase: "http://127.0.0.1:9097", dryRun: false, secret: "fake-secret-not-real" } },
    ]);
  });

  it("没探测到时说明下一步", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ controllers: [] }) })));
    render(<ClashImportFlow />);
    await user.click(screen.getByRole("button", { name: "探测 Clash" }));
    expect(await screen.findByText(/没有探测到本机 Clash 控制面/)).toBeInTheDocument();
  });
});
