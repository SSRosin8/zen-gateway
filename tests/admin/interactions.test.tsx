import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../../src/admin/App.tsx";
import { WorkersPage, proxyOptionLabel } from "../../src/admin/pages/WorkersPage.tsx";
import { GatewayPage, validateMaxAttempts } from "../../src/admin/pages/GatewayPage.tsx";
import { ModelsPage } from "../../src/admin/pages/ModelsPage.tsx";
import { OverviewPage } from "../../src/admin/pages/OverviewPage.tsx";
import { ProxyPage, subscriptionStatus } from "../../src/admin/pages/ProxyPage.tsx";
import { UsagePage } from "../../src/admin/pages/UsagePage.tsx";
import { Nav } from "../../src/admin/components/Nav.tsx";
import { ClashSection } from "../../src/admin/components/ClashSection.tsx";
import { PAGES } from "../../src/admin/lib/router.ts";
import { parseHash } from "../../src/admin/lib/router.ts";
import { formatLocalTime } from "../../src/admin/lib/format.ts";
import * as adminApi from "../../src/admin/lib/api.ts";
import type { FetchState } from "../../src/admin/lib/api.ts";
import type {
  ModelList,
  Overview,
  ProxyList,
  ProxyView,
  StatsView,
  WorkerView,
} from "../../src/shared/contract.ts";
import { INITIAL_BATCH_VIEW } from "../../src/shared/contract.ts";
import { fakeOverview } from "./App.test.tsx";

/*
 * 交互层面的契约：确认对话框、行内编辑、出口下拉、保存结果、表格滚动、
 * 导航链接、页内标签、单一主操作、向导范围。全部用语义查询表达。
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.location.hash = "";
});

const noop = () => {};

function worker(overrides: Partial<WorkerView> = {}): WorkerView {
  return {
    id: "w1",
    name: "",
    kind: "authenticated",
    enabled: true,
    proxyId: "p1",
    apiKey: { present: true, fingerprint: "abcd1234" },
    inPool: true,
    ready: true,
    cooldownRemainingMs: 0,
    consecutiveFails: 0,
    lastFailure: null,
    egressIp: "198.51.100.1",
    ...overrides,
  };
}

function proxy(overrides: Partial<ProxyView> = {}): ProxyView {
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
    egressIp: "198.51.100.1",
    password: { present: false, fingerprint: null },
    usedBy: ["w1"],
    resolvable: true,
    unresolvableReason: null,
    ...overrides,
  };
}

function proxyList(proxies: ProxyView[], overrides: Partial<ProxyList> = {}): ProxyList {
  return {
    proxies,
    clash: { enabled: false, selectionMode: "auto", activeBridgeId: null, bridges: [] },
    isolation: { groups: [], unknownWorkerIds: [], sharedGroups: [], isolated: false },
    subscriptions: [],
    ...overrides,
  };
}

function withWorkers(workers: WorkerView[]): Overview {
  return fakeOverview({ workers, pool: { ready: workers.length, total: workers.length, health: workers.length === 0 ? "empty" : "healthy" } });
}

const readyProxies = (list: ProxyView[]): FetchState<ProxyList> => ({ status: "ready", data: proxyList(list) });

/* ================================================================== *
 * 表格
 * ================================================================== */

describe("表格在窄屏内部横向滚动", () => {
  it("每张表都在一个 overflow-x-auto 的滚动区域里", () => {
    const pages: Array<[string, () => React.ReactElement]> = [
      ["概览", () => <OverviewPage data={withWorkers([worker()])} />],
      ["Worker", () => <WorkersPage data={withWorkers([worker()])} view={parseHash("#workers")} navigate={noop} />],
      [
        "Clash 内核",
        () => (
          <ClashSection
            refresh={noop}
            clash={{
              enabled: true,
              selectionMode: "auto",
              activeBridgeId: "b1",
              bridges: [
                {
                  id: "b1",
                  name: "verge",
                  enabled: true,
                  priority: 100,
                  apiBase: "http://127.0.0.1:9097",
                  apiSecret: { present: false, fingerprint: null },
                  localProxyHost: "127.0.0.1",
                  localProxyPort: 7897,
                  selectorGroup: "Proxy",
                },
              ],
            }}
          />
        ),
      ],
      ["用量", () => <UsagePage data={stats()} days="30" onDays={noop} />],
    ];
    for (const [name, mount] of pages) {
      const { container, unmount } = render(mount());
      const tables = [...container.querySelectorAll("table")];
      expect(tables.length, `${name} 页没有表格`).toBeGreaterThan(0);
      for (const table of tables) {
        const region = table.closest('[role="region"]');
        expect(region, `${name} 页有表格不在滚动区域内`).not.toBeNull();
        // overflow-auto 覆盖横向（窄屏）与纵向（sticky 表头的滚动祖先）。
        expect(region!.className).toMatch(/\boverflow-(x-)?auto\b/);
        expect(region).toHaveAccessibleName();
      }
      unmount();
    }
  });
});

function stats(): StatsView {
  return {
    sinceDay: "2026-08-27",
    requests: 7,
    attempts: 9,
    models: [
      {
        model: "a-free",
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadTokens: 300,
        cacheWriteTokens: 0,
        requestsWithUsage: 5,
        requestsWithoutUsage: 1,
        requestsDroppedUsage: 0,
      },
    ],
    workers: [{ workerId: "w1", attempts: 9, successes: 7, failures: 2, lastUsedAt: 1, lastStatus: 200 }],
    rates: { cacheHitRate: 0.3, usageCoverage: 0.833, droppedUsageCount: 0 },
    rejections: {},
    rejectedModels: [],
  };
}

/* ================================================================== *
 * Worker 删除确认
 * ================================================================== */

describe("删除 Worker 需要确认", () => {
  it("点删除只打开对话框，焦点在取消上，取消后不发请求", async () => {
    const user = userEvent.setup();
    const patch = vi.spyOn(adminApi, "patchConfig").mockResolvedValue(undefined);
    render(<WorkersPage data={withWorkers([worker()])} view={parseHash("#workers")} navigate={noop} />);

    await user.click(screen.getByRole("button", { name: "删除" }));
    const dialog = screen.getByRole("dialog", { name: "删除 Worker" });
    expect(patch).not.toHaveBeenCalled();
    expect(within(dialog).getByText("w1")).toBeInTheDocument();
    expect(dialog.textContent).toContain("无法从后台找回");
    expect(within(dialog).getByRole("button", { name: "取消" })).toHaveFocus();

    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(patch).not.toHaveBeenCalled();
  });

  it("确认后才删除，并显示成功结果", async () => {
    const user = userEvent.setup();
    const patch = vi.spyOn(adminApi, "patchConfig").mockResolvedValue(undefined);
    render(<WorkersPage data={withWorkers([worker()])} view={parseHash("#workers")} navigate={noop} />);

    await user.click(screen.getByRole("button", { name: "删除" }));
    const confirm = within(screen.getByRole("dialog")).getByRole("button", { name: "确认删除" });
    // 破坏性按钮用 error 描边。
    expect(confirm.className).toContain("border-error");
    await user.click(confirm);

    expect(patch).toHaveBeenCalledWith({ workers: { delete: ["w1"] } });
    expect(await screen.findByText("已删除")).toBeInTheDocument();
  });

  it("Esc 关闭对话框且不删除", async () => {
    const user = userEvent.setup();
    const patch = vi.spyOn(adminApi, "patchConfig").mockResolvedValue(undefined);
    render(<WorkersPage data={withWorkers([worker()])} view={parseHash("#workers")} navigate={noop} />);
    await user.click(screen.getByRole("button", { name: "删除" }));
    const dialog = screen.getByRole("dialog");
    dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(patch).not.toHaveBeenCalled();
  });
});

/* ================================================================== *
 * 行内编辑
 * ================================================================== */

describe("Worker 编辑表单在被编辑行的正下方", () => {
  it("展开在该行之后、下一行之前，焦点落在第一个字段", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <WorkersPage
        data={withWorkers([worker({ id: "w1" }), worker({ id: "w2" }), worker({ id: "w3" })])}
        view={parseHash("#workers")}
        navigate={noop}
        proxies={readyProxies([proxy()])}
      />,
    );

    const row2 = container.querySelector('tr[data-row="w2"]')!;
    await user.click(within(row2 as HTMLElement).getByRole("button", { name: "编辑" }));

    const form = screen.getByRole("form", { name: "编辑 Worker w2" });
    const expanded = form.closest("tr")!;
    expect(expanded.previousElementSibling).toBe(row2);
    expect(expanded.nextElementSibling).toBe(container.querySelector('tr[data-row="w3"]'));
    expect(expanded.querySelector("td")!.getAttribute("colspan")).toBe("7");
    expect(within(form).getByLabelText("名称")).toHaveFocus();
  });

  it("新增表单在表格上方，焦点落在 ID", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <WorkersPage data={withWorkers([worker()])} view={parseHash("#workers")} navigate={noop} />,
    );
    await user.click(screen.getByRole("button", { name: "新增 Worker" }));
    const form = screen.getByRole("form", { name: "新增 Worker" });
    expect(form.closest("tr")).toBeNull();
    const table = container.querySelector("table")!;
    // DOCUMENT_POSITION_FOLLOWING：表格在表单之后。
    expect(form.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(form).getByLabelText("ID")).toHaveFocus();
  });
});

/* ================================================================== *
 * 出口下拉
 * ================================================================== */

describe("Worker 出口从已有代理中选择", () => {
  it("下拉框含本机直连与每个代理的名称、id、回显 IP，停用的标出来", async () => {
    const user = userEvent.setup();
    const patch = vi.spyOn(adminApi, "patchConfig").mockResolvedValue(undefined);
    render(
      <WorkersPage
        data={withWorkers([worker({ proxyId: "p1" })])}
        view={parseHash("#workers")}
        navigate={noop}
        proxies={readyProxies([
          proxy({ id: "p1", name: "节点一", egressIp: "198.51.100.1" }),
          proxy({ id: "p2", name: "节点二", egressIp: null, enabled: false }),
        ])}
      />,
    );
    await user.click(screen.getByRole("button", { name: "编辑" }));
    const select = screen.getByRole("combobox", { name: "出口代理" });
    expect(select).toHaveValue("p1");
    const options = within(select).getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(["本机直连", "节点一（p1） · 198.51.100.1", "节点二（p2） · 已停用"]);

    await user.selectOptions(select, "");
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(patch.mock.calls[0]![0].workers?.update?.["w1"]).toMatchObject({ proxyId: null });
  });

  it("名称与 id 相同时不重复显示", () => {
    expect(proxyOptionLabel(proxy({ id: "p9", name: "p9", egressIp: null }))).toBe("p9");
  });

  it("引用了不在列表里的代理时保留该值并标出", async () => {
    const user = userEvent.setup();
    render(
      <WorkersPage
        data={withWorkers([worker({ proxyId: "gone" })])}
        view={parseHash("#workers")}
        navigate={noop}
        proxies={readyProxies([proxy()])}
      />,
    );
    await user.click(screen.getByRole("button", { name: "编辑" }));
    const select = screen.getByRole("combobox", { name: "出口代理" });
    expect(select).toHaveValue("gone");
    expect(within(select).getByRole("option", { name: /gone · 不在代理列表中/ })).toBeInTheDocument();
  });

  it("拿不到代理列表时退回文本输入并说明原因", async () => {
    const user = userEvent.setup();
    render(
      <WorkersPage
        data={withWorkers([worker()])}
        view={parseHash("#workers")}
        navigate={noop}
        proxies={{ status: "offline" }}
      />,
    );
    await user.click(screen.getByRole("button", { name: "编辑" }));
    expect(screen.getByRole("textbox", { name: "出口代理 ID（留空为本机直连）" })).toHaveValue("p1");
    expect(screen.getByRole("textbox", { name: "出口代理 ID（留空为本机直连）" })).toHaveAccessibleDescription(
      /拿不到代理列表（网关未连接）/,
    );
  });
});

/* ================================================================== *
 * 清空 key
 * ================================================================== */

describe("认证 Worker 的 key 只能通过改为匿名来去掉", () => {
  it("不再提供会被 schema 拒绝的「清空当前 key」", async () => {
    const user = userEvent.setup();
    render(<WorkersPage data={withWorkers([worker()])} view={parseHash("#workers")} navigate={noop} />);
    await user.click(screen.getByRole("button", { name: "编辑" }));
    expect(screen.queryByRole("checkbox", { name: /清空/ })).not.toBeInTheDocument();
    expect(screen.getByText(/要去掉已保存的 key，把类型改为匿名 Worker/)).toBeInTheDocument();
  });

  it("改为匿名时警告已保存的 key 会被删除，提交的是 kind 变更而不是 clear", async () => {
    const user = userEvent.setup();
    const patch = vi.spyOn(adminApi, "patchConfig").mockResolvedValue(undefined);
    render(<WorkersPage data={withWorkers([worker()])} view={parseHash("#workers")} navigate={noop} />);
    await user.click(screen.getByRole("button", { name: "编辑" }));
    expect(screen.queryByText(/已保存的 API key 会被删除/)).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("类型"), "anonymous");
    expect(screen.getByText(/已保存的 API key 会被删除/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "保存" }));
    const update = patch.mock.calls[0]![0].workers?.update?.["w1"];
    expect(update).toMatchObject({ kind: "anonymous" });
    expect(update).not.toHaveProperty("apiKey");
  });
});

/* ================================================================== *
 * 保存结果
 * ================================================================== */

describe("保存结果区分成功与失败", () => {
  it("网关页：成功是 success 色调 + 图标 + 文字，在 polite 区域", async () => {
    const user = userEvent.setup();
    vi.spyOn(adminApi, "patchConfig").mockResolvedValue(undefined);
    render(<GatewayPage data={fakeOverview()} />);
    await user.click(screen.getByRole("button", { name: "保存运行参数" }));
    const ok = await screen.findByText("已保存");
    expect(ok.closest("[data-tone]")).toHaveAttribute("data-tone", "success");
    expect(ok.closest('[aria-live="polite"]')).not.toBeNull();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("网关页：服务端错误以 role=alert 报出", async () => {
    const user = userEvent.setup();
    vi.spyOn(adminApi, "patchConfig").mockRejectedValue(new Error("配置写入失败"));
    render(<GatewayPage data={fakeOverview()} />);
    await user.click(screen.getByRole("button", { name: "保存运行参数" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("配置写入失败");
    expect(alert.querySelector("[data-tone]")).toHaveAttribute("data-tone", "error");
  });

  it.each(["0", "11", "2.5", "", "abc"])("maxAttempts=%j 在提交前被拦下，不发请求", async (raw) => {
    const user = userEvent.setup();
    const patch = vi.spyOn(adminApi, "patchConfig").mockResolvedValue(undefined);
    render(<GatewayPage data={fakeOverview()} />);
    const input = screen.getByRole("spinbutton", { name: "最多尝试 Worker 数" });
    await user.clear(input);
    if (raw !== "") await user.type(input, raw);
    await user.click(screen.getByRole("button", { name: "保存运行参数" }));
    expect(patch).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("1 到 10 的整数");
  });

  it("validateMaxAttempts 接受边界值", () => {
    expect(validateMaxAttempts("1")).toEqual({ ok: true, value: 1 });
    expect(validateMaxAttempts(" 10 ")).toEqual({ ok: true, value: 10 });
    expect(validateMaxAttempts("10.0")).toEqual({ ok: true, value: 10 });
  });

  it("Worker 页：保存失败以 role=alert 报出", async () => {
    const user = userEvent.setup();
    vi.spyOn(adminApi, "patchConfig").mockRejectedValue(new Error("Worker id 已存在:w1"));
    render(<WorkersPage data={withWorkers([worker()])} view={parseHash("#workers")} navigate={noop} />);
    await user.click(screen.getByRole("button", { name: "新增 Worker" }));
    await user.selectOptions(screen.getByLabelText("类型"), "authenticated");
    await user.type(screen.getByLabelText("API key（认证必填）"), "fake-key-not-real");
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Worker id 已存在");
  });
});

/* ================================================================== *
 * 模型页保存后刷新自己的端点
 * ================================================================== */

function modelList(): ModelList {
  return {
    models: [{ id: "a-free", free: true, reason: "suffix", surfaces: ["chat"], listed: true }],
    catalogAvailable: true,
    rules: {
      freeSuffix: "-free",
      extraFreeIds: [],
      defaultSurfaces: ["chat", "responses"],
      catalogTtlMs: 1_800_000,
      enforceCatalog: true,
    },
  };
}

describe("模型页保存", () => {
  it("成功后调用 refresh，并显示成功状态", async () => {
    const user = userEvent.setup();
    vi.spyOn(adminApi, "patchConfig").mockResolvedValue(undefined);
    const refresh = vi.fn();
    render(<ModelsPage data={modelList()} view={parseHash("#models")} navigate={noop} refresh={refresh} />);
    await user.click(screen.getByRole("button", { name: "保存" }));
    await screen.findByText("已保存");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("App 里模型页的 refresh 重新请求 /api/models，而不只是 overview", async () => {
    const user = userEvent.setup();
    vi.spyOn(adminApi, "patchConfig").mockResolvedValue(undefined);
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((path: string) => {
        calls.push(path);
        const body = path.startsWith("/api/models") ? modelList() : fakeOverview({ workers: [worker()], pool: { ready: 1, total: 1, health: "healthy" } });
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
      }),
    );
    window.location.hash = "#models";
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "保存" }));
    await screen.findByText("已保存");
    await waitFor(() => expect(calls.filter((p) => p === "/api/models").length).toBe(2));
  });
});

/* ================================================================== *
 * 订阅时间
 * ================================================================== */

describe("订阅拉取时间", () => {
  it("按本地时间显示，完整 ISO 在 title 里", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    const iso = "2026-09-25T10:00:00.000Z";
    const sub = {
      id: "sub1",
      name: "机场一",
      urlRedacted: "https://sub.example.invalid/link?token=***",
      enabled: true,
      lastFetchedAt: iso,
      lastErrorKind: null,
      lastImportCount: 12,
      lastFormat: "clash",
      proxyCount: 12,
    };
    expect(subscriptionStatus(sub).label).toBe(`上次拉取 ${formatLocalTime(iso)}`);
    render(
      <ProxyPage
        data={proxyList([], { subscriptions: [sub] })}
        view={parseHash("#proxy?tab=subscriptions")}
        navigate={noop}
      />,
    );
    const label = screen.getByText(`上次拉取 ${formatLocalTime(iso)}`);
    expect(label.closest("[title]")).toHaveAttribute("title", iso);
  });
});

/* ================================================================== *
 * 导航与标签
 * ================================================================== */

describe("导航是真实链接", () => {
  it("每页一个 href=#page 的链接，当前页 aria-current", () => {
    render(<Nav current="proxy" />);
    const nav = screen.getByRole("navigation", { name: "主导航" });
    const links = within(nav).getAllByRole("link");
    expect(links).toHaveLength(PAGES.length);
    for (const [i, page] of PAGES.entries()) {
      expect(links[i]).toHaveAttribute("href", `#${page}`);
    }
    expect(within(nav).getByRole("link", { current: "page" })).toHaveAttribute("href", "#proxy");
  });
});

describe("代理池标签", () => {
  it("是 tablist/tab，选中项 aria-selected 并关联面板", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    const user = userEvent.setup();
    const navigate = vi.fn();
    render(<ProxyPage data={proxyList([proxy()])} view={parseHash("#proxy?tab=isolation")} navigate={navigate} />);
    const tablist = screen.getByRole("tablist", { name: "代理池视图" });
    const tabs = within(tablist).getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["列表", "回显出口", "订阅", "Clash"]);
    const selected = within(tablist).getByRole("tab", { selected: true });
    expect(selected).toHaveTextContent("回显出口");
    expect(selected).toHaveAttribute("href", "#proxy?tab=isolation");
    const panel = screen.getByRole("tabpanel");
    expect(selected.getAttribute("aria-controls")).toBe(panel.id);

    await user.click(within(tablist).getByRole("tab", { name: "订阅" }));
    expect(navigate).toHaveBeenCalledWith({ tab: "subscriptions" });
  });
});

/* ================================================================== *
 * 单一主操作
 * ================================================================== */

/** 主按钮的判据：accent-fill 底色，只有 PrimaryButton 用它。 */
function primaryButtons(container: HTMLElement) {
  return [...container.querySelectorAll("button")].filter((b) => b.className.includes("bg-accent-fill"));
}

describe("每个视图最多一个主操作", () => {
  it("订阅页的每行刷新是描边按钮，主操作只有批量探测", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    const sub = {
      id: "s",
      name: "n",
      urlRedacted: "https://sub.example.invalid/***",
      enabled: true,
      lastFetchedAt: null,
      lastErrorKind: null,
      lastImportCount: 0,
      lastFormat: null,
      proxyCount: 0,
    };
    const { container } = render(
      <ProxyPage
        data={proxyList([], { subscriptions: [sub, { ...sub, id: "s2" }] })}
        view={parseHash("#proxy?tab=subscriptions")}
        navigate={noop}
      />,
    );
    const primaries = primaryButtons(container);
    expect(primaries).toHaveLength(1);
    expect(primaries[0]).toHaveTextContent("开始批量探测");
  });

  it("App 里的 Worker 页只有一个主操作", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(fakeOverview()) })));
    window.location.hash = "#workers";
    const { container } = render(<App />);
    await screen.findByRole("heading", { name: "Worker（0/0）" });
    const primaries = primaryButtons(container);
    expect(primaries).toHaveLength(1);
    expect(primaries[0]).toHaveTextContent("新增 Worker");
  });
});

/* ================================================================== *
 * 批量探测确认
 * ================================================================== */

describe("开始批量探测前确认", () => {
  it("说明会切换 Clash 分组并可能新建 Worker，确认后才发 start", async () => {
    const user = userEvent.setup();
    const posts: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((_path: string, init?: { method?: string; body?: string }) => {
        if (init?.method === "POST") posts.push(init.body ?? "");
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ...INITIAL_BATCH_VIEW }) });
      }),
    );
    render(<ProxyPage data={proxyList([proxy()])} view={parseHash("#proxy")} navigate={noop} />);

    await user.click(screen.getByRole("button", { name: "开始批量探测" }));
    const dialog = screen.getByRole("dialog", { name: "开始批量探测" });
    expect(dialog.textContent).toContain("Clash");
    expect(dialog.textContent).toContain("新建对应的 Worker");
    expect(within(dialog).getByRole("button", { name: "取消" })).toHaveFocus();
    expect(posts).toHaveLength(0);

    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(posts).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "开始批量探测" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "开始探测" }));
    await waitFor(() => expect(posts).toEqual([JSON.stringify({ action: "start" })]));
  });
});

/* ================================================================== *
 * 概览去重
 * ================================================================== */

describe("概览不重复网关页与分组", () => {
  it("网关信息只有一行摘要和指向网关页的链接", () => {
    render(<OverviewPage data={withWorkers([worker()])} />);
    expect(screen.queryByRole("heading", { name: "网关" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Relay Token/)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /网关页/ })).toHaveAttribute("href", "#gateway");
  });

  it("回显出口是 Worker 表的一列，共用只标在共用的行上", () => {
    const shared = { egressIp: "198.51.100.1", workerIds: ["w1", "w2"], proxyIds: ["p1", "p2"] };
    const single = { egressIp: "198.51.100.2", workerIds: ["w3"], proxyIds: ["p3"] };
    render(
      <OverviewPage
        data={fakeOverview({
          workers: [
            worker({ id: "w1", egressIp: "198.51.100.1" }),
            worker({ id: "w2", egressIp: "198.51.100.1" }),
            worker({ id: "w3", egressIp: "198.51.100.2" }),
          ],
          pool: { ready: 3, total: 3, health: "healthy" },
          isolation: { groups: [shared, single], sharedGroups: [shared], unknownWorkerIds: [], isolated: false },
        })}
      />,
    );
    // 不再有单独的分组列表：每个出口不再额外占一行。
    expect(screen.queryByRole("list", { name: "回显出口分组" })).not.toBeInTheDocument();
    const table = screen.getByRole("table");
    expect(within(table).getByRole("columnheader", { name: "回显出口" })).toBeInTheDocument();
    const rowOf = (id: string) => within(table).getByText(id).closest("tr")!;
    expect(within(rowOf("w1")).getByText("共用")).toBeInTheDocument();
    expect(within(rowOf("w2")).getByText("共用")).toBeInTheDocument();
    expect(within(rowOf("w3")).queryByText("共用")).not.toBeInTheDocument();
  });
});
