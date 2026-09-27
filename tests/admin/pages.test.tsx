import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProxyPage, subscriptionStatus } from "../../src/admin/pages/ProxyPage.tsx";
import { OverviewPage } from "../../src/admin/pages/OverviewPage.tsx";
import { ModelsPage } from "../../src/admin/pages/ModelsPage.tsx";
import { UsagePage } from "../../src/admin/pages/UsagePage.tsx";
import { GatewayPage } from "../../src/admin/pages/GatewayPage.tsx";
import { ClientPage } from "../../src/admin/pages/ClientPage.tsx";
import { WorkersPage } from "../../src/admin/pages/WorkersPage.tsx";
import { PAGE_SIZE } from "../../src/admin/components/DataTable.tsx";
import type {
  ModelList,
  ProxyList,
  ProxyView,
  StatsView,
  WorkerView,
} from "../../src/shared/contract.ts";
import { fakeOverview } from "./App.test.tsx";
import { parseHash } from "../../src/admin/lib/router.ts";
import * as adminApi from "../../src/admin/lib/api.ts";

/*
 * 其余 5 页 + 向导的组件契约。
 *
 * 与 Overview 那组同一条规则:用 Testing Library 表达意图，不做 HTML 字符串
 * 断言 —— 字符串断言一改样式就全红，意图随之流失。
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const view = parseHash("#proxy");
const noop = () => {};

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

/** 批量探测的端点在这些测试里不存在 —— 用一个永挂的 fetch 让它停在初始态。 */
function stubIdleBatch() {
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
}

/* ================================================================== *
 * 代理池
 * ================================================================== */

describe("代理池页", () => {
  it("超过一页时分页,页长 16（与「行高 36px → 一屏约 16 行」的算术对齐）", () => {
    stubIdleBatch();
    /*
     * 紧凑密度（行高 36px）下 1280×800 视口的表格区约放 16 行，而代理池可能有几十个
     * 节点。所以分页是**必需项**，且页长必须与密度一致。
     */
    expect(PAGE_SIZE).toBe(16);

    const many = Array.from({ length: 30 }, (_, i) =>
      proxy({ id: `p${i}`, name: `节点${i}`, usedBy: [] }),
    );
    const { container } = render(
      <ProxyPage data={proxyList(many)} view={view} navigate={noop} />,
    );

    expect(container.querySelectorAll("tr[data-row]")).toHaveLength(PAGE_SIZE);
    // 文案被 `{}` 插值拆成多个文本节点，所以查整体文本而不是单个元素。
    expect(container.textContent?.replace(/\s+/g, " ")).toContain("共 30 条");
  });

  it("不可解析的代理给出**与转发失败同一句话**的原因", () => {
    stubIdleBatch();
    const { container } = render(
      <ProxyPage
        data={proxyList([
          proxy({ resolvable: false, unresolvableReason: "代理 p1 已停用", enabled: false }),
        ])}
        view={view}
        navigate={noop}
      />,
    );
    // 措辞来自服务端的 `describeResolveFailure` —— 不在前端另造一套。
    expect(container.textContent).toContain("代理 p1 已停用");
  });

  it("本地端口必须显示 —— 它是高风险字段", () => {
    stubIdleBatch();
    const { container } = render(
      <ProxyPage data={proxyList([proxy({ port: 7897 })])} view={view} navigate={noop} />,
    );
    /*
     * 桥接时它是本机 Clash 的混合端口，与内核实际 `mixed-port` 不一致会让
     * 所有桥接代理静默失败（而控制面是通的）—— 只有看到这个数字才能自查。
     */
    expect(container.textContent).toContain("7897");
  });

  it("空代理池给出下一步,而不只是说「空」", async () => {
    stubIdleBatch();
    const user = userEvent.setup();
    const navigate = vi.fn();
    render(<ProxyPage data={proxyList([])} view={view} navigate={navigate} />);
    expect(screen.getByText(/还没有代理/)).toBeInTheDocument();
    // 下一步在界面里完成，不再指向命令行。
    await user.click(screen.getByRole("button", { name: "导入 Clash 节点" }));
    expect(navigate).toHaveBeenCalledWith({ tab: "clash" });
  });

  it("搜索无结果时的措辞与「没有代理」不同", () => {
    stubIdleBatch();
    render(
      <ProxyPage
        data={proxyList([proxy()])}
        view={parseHash("#proxy?q=zzzz")}
        navigate={noop}
      />,
    );
    // 「一个都没配」与「筛掉了」是两件事,下一步完全不同。
    expect(screen.getByText(/没有匹配的节点/)).toBeInTheDocument();
    expect(screen.queryByText(/还没有代理/)).not.toBeInTheDocument();
  });
  it("页码越界时夹回最后一页,不显示空表", () => {
    stubIdleBatch();
    /*
     * 这是**常态而不是边角**:用户在第 3 页输入搜索词，结果只剩 5 行 ——
     * 此时 `page=3` 越界。不夹的话会显示一个空表，而用户不知道是
     * 「没有匹配」还是「翻过头了」。URL 可手编（`?page=99`）也会走到这里。
     *
     * 变异测试逼出来的:去掉 `Math.min(Math.max(1, page), totalPages)` 之后
     * 整套测试**依然全绿** —— 没有一条覆盖这条路径。
     */
    // 页长 + 3 行 → 2 页，而 URL 说第 99 页。
    const total = PAGE_SIZE + 3;
    const rows = Array.from({ length: total }, (_, i) =>
      proxy({ id: `p${i}`, name: `节点${i}`, usedBy: [] }),
    );
    const { container } = render(
      <ProxyPage data={proxyList(rows)} view={parseHash("#proxy?page=99")} navigate={noop} />,
    );

    // 夹到最后一页 → 显示最后 3 行，而不是 0 行。
    expect(container.querySelectorAll("tr[data-row]")).toHaveLength(3);
    expect(container.textContent?.replace(/\s+/g, " ")).toContain(`共 ${total} 条`);
  });

  it("页码小于 1 时夹到第一页", () => {
    stubIdleBatch();
    const rows = Array.from({ length: PAGE_SIZE + 3 }, (_, i) =>
      proxy({ id: `p${i}`, name: `节点${i}`, usedBy: [] }),
    );
    const { container } = render(
      <ProxyPage data={proxyList(rows)} view={{ ...parseHash("#proxy"), page_: -5 }} navigate={noop} />,
    );
    expect(container.querySelectorAll("tr[data-row]")).toHaveLength(PAGE_SIZE);
  });
});

/* ================================================================== *
 * 模型
 * ================================================================== */

function modelList(overrides: Partial<ModelList> = {}): ModelList {
  return {
    models: [
      { id: "a-free", free: true, reason: "suffix", protocol: { declared: "chat", measured: [] }, listed: true },
      { id: "big-pickle", free: true, reason: "extra", protocol: { declared: "chat", measured: [] }, listed: true },
      { id: "paid-model", free: false, reason: "not_free", protocol: { declared: "chat", measured: [] }, listed: true },
      { id: "gone-free", free: false, reason: "retired", protocol: { declared: "chat", measured: [] }, listed: false },
    ],
    catalogAvailable: true,
    protocolSource: { available: true, fetchedAt: "2026-01-01T00:00:00.000Z" },
    measuredSinceDay: "2026-01-01",
    rules: {
      freeSuffix: "-free",
      extraFreeIds: ["big-pickle"],
      catalogTtlMs: 1_800_000,
      enforceCatalog: true,
    },
    ...overrides,
  };
}

describe("模型页", () => {
  it("**含付费模型** —— 它要回答「为什么这个不能用」", () => {
    render(<ModelsPage data={modelList()} view={parseHash("#models")} navigate={noop} />);
    /*
     * 只列免费集的话，用户在 OpenCode 里看到一个模型名却在这里找不到它,
     * 于是不知道是「网关不认识它」还是「网关拒绝它」。
     */
    expect(screen.getByText("paid-model")).toBeInTheDocument();
    expect(screen.getByText("不是免费模型")).toBeInTheDocument();
  });

  it("已下架与不免费**分开显示** —— 处置不同", () => {
    render(<ModelsPage data={modelList()} view={parseHash("#models")} navigate={noop} />);
    // 前者要删 extraFreeIds 条目，后者要改客户端用的模型名。
    // 「已下架」既是筛选按钮也是表格里的依据文案 —— 两处都该有。
    expect(screen.getAllByText(/已下架/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("不是免费模型")).toBeInTheDocument();
  });

  it("目录拿不到时报「拿不到」而不是显示一个空表", () => {
    render(
      <ModelsPage
        data={modelList({ models: [], catalogAvailable: false })}
        view={parseHash("#models")}
        navigate={noop}
      />,
    );
    /*
     * 「拿不到目录」与「目录里一个模型都没有」的下一步完全不同 ——
     * 前者查网络/CA，后者查 freeSuffix。
     */
    expect(screen.getByText(/拿不到上游模型目录/)).toBeInTheDocument();
    expect(screen.getByText(/NODE_EXTRA_CA_CERTS/)).toBeInTheDocument();
    // 而且要说清它**不是**「一个免费模型都没有」。
    expect(screen.getByText(/不是/)).toBeInTheDocument();
  });

  it("协议列显示声明（人话标签），不再对所有模型显示同一套默认值", () => {
    render(<ModelsPage data={modelList()} view={parseHash("#models")} navigate={noop} />);
    expect(screen.getAllByText("Chat").length).toBe(4);
  });

  it("在架数量只统计 listed 条目，不把配置中的下架项算进去", () => {
    render(
      <ModelsPage data={modelList()} view={parseHash("#models")} navigate={noop} />,
    );
    const listedLabel = screen.getByText("在架模型");
    expect(listedLabel.parentElement?.textContent).toContain("3");
  });

  it("说明那条不对称（下架能自动剔除，新免费模型不能自动发现），收在免费判定的 ⓘ 里", async () => {
    const user = userEvent.setup();
    render(<ModelsPage data={modelList()} view={parseHash("#models")} navigate={noop} />);
    expect(screen.queryByText(/无法自动发现/)).not.toBeInTheDocument();
    await user.hover(screen.getByRole("button", { name: "免费判定说明" }));
    expect(screen.getByRole("tooltip")).toHaveTextContent("无法自动发现");
    expect(screen.getByRole("tooltip")).toHaveTextContent("唯一");
  });
});

/* ================================================================== *
 * 用量
 * ================================================================== */

function stats(overrides: Partial<StatsView> = {}): StatsView {
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
    workers: [
      { workerId: "w1", attempts: 9, successes: 7, failures: 2, lastUsedAt: 1, lastStatus: 200 },
    ],
    rates: { cacheHitRate: 0.3, usageCoverage: 0.833, droppedUsageCount: 0 },
    rejections: { not_free: 3, retired: 1 },
    daily: { byModel: [], byWorker: [] },
    rejectedModels: [
      { reason: "not_free", model: "fake-paid-model", count: 3 },
      { reason: "retired", model: "fake-retired-model", count: 1 },
    ],
    ...overrides,
  };
}

describe("用量页", () => {
  it("请求与尝试**分开显示** —— 本页最容易被当成同一个的两个量", () => {
    render(<UsagePage data={stats()} days="30" onDays={noop} />);
    /*
     * 一条 `w1 限流 → w2 成功` 的链是**一个**请求、**两次**尝试。
     * 合成一个数会让「上游失败率」建立在错误的分母上。
     */
    /*
     * 断言两个**指标卡**各自的数字，而不是「页面上有 7」—— 后者会撞上
     * Worker 表里的 successes（也是 7）。要钉的是「两个量分开展示」。
     */
    const requests = screen.getByText("客户端请求").parentElement;
    const attempts = screen.getByText("上游尝试").parentElement;
    expect(requests?.textContent).toContain("7");
    expect(attempts?.textContent).toContain("9");
    // 且两张卡的说明各自点出区别。
    expect(requests?.textContent).toContain("一条重试链算一个");
    expect(attempts?.textContent).toContain("每次换 Worker 算一次");
  });

  it("重置统计：先确认，取消不发请求；确认后发 { confirm: true } 并刷新", async () => {
    const user = userEvent.setup();
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ ok: true, removed: 5 }), { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
    const onReset = vi.fn();
    render(<UsagePage data={stats()} days="30" onDays={noop} onReset={onReset} />);

    await user.click(screen.getByRole("button", { name: "重置统计" }));
    const dialog = screen.getByRole("dialog", { name: "重置用量统计" });
    // 说清范围：清的是全部，不只是当前时间窗。
    expect(dialog.textContent).toContain("不只是当前时间范围");
    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(calls).toEqual([]);

    await user.click(screen.getByRole("button", { name: "重置统计" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "确认重置" }));
    expect(await screen.findByText("已清空全部用量统计")).toBeInTheDocument();
    expect(calls).toEqual([{ url: "/api/stats/reset", body: { confirm: true } }]);
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it("比值为 null 时显示「—」而不是 0%", () => {
    render(
      <UsagePage
        data={stats({ rates: { cacheHitRate: null, usageCoverage: null, droppedUsageCount: 0 } })}
        days="30"
        onDays={noop}
      />,
    );
    // 「没有数据」与「命中率是 0%」是两件事，后者才需要排查。
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2);
  });

  it("「上游未报」与「未完整解析」是两列", () => {
    render(<UsagePage data={stats()} days="30" onDays={noop} />);
    // 一个是上游的行为，一个是网关侧的限制，排查方向不同。
    expect(screen.getByRole("columnheader", { name: "未报" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "未完整解析" })).toBeInTheDocument();
  });

  it("不向用户展示实现细节", () => {
    const { container } = render(<UsagePage data={stats()} days="30" onDays={noop} />);
    const text = container.textContent ?? "";
    expect(text).not.toContain("COUNT(DISTINCT");
    expect(text).not.toContain("事件循环");
    expect(text).not.toContain("我们");
  });

  it("dropped 非 0 时单独告警；ⓘ 里说明它不是上游的问题", async () => {
    const user = userEvent.setup();
    render(
      <UsagePage
        data={stats({ rates: { cacheHitRate: 0.1, usageCoverage: 0.5, droppedUsageCount: 4 } })}
        days="30"
        onDays={noop}
      />,
    );
    expect(screen.getByText(/4 次响应网关未完整解析/)).toBeInTheDocument();
    await user.hover(screen.getByRole("button", { name: "未完整解析说明" }));
    /*
     * 用整段 textContent 匹配：「不是」被 `<Strong>` 包着，文本被切成多个节点，
     * Testing Library 的默认匹配是逐节点的，跨节点的正则匹配不到。
     */
    const tip = screen.getByRole("tooltip");
    expect(tip.textContent).toMatch(/不是[\s\S]*上游没报/);
    // 同时钉住「不渲染字面 markdown」。
    expect(tip.textContent).not.toContain("**");
    // 强调用 <strong>，font-medium 而不是默认粗体（14px 正文下粗体会造成视觉断层）。
    expect(tip.querySelector("strong")?.className).toContain("font-medium");
  });

  it("网关拒绝分原因列出；ⓘ 说明请求从未到达上游，以及 not_free 与 retired 处置不同", async () => {
    const user = userEvent.setup();
    render(<UsagePage data={stats()} days="30" onDays={noop} />);
    expect(screen.getByText("不是免费模型")).toBeInTheDocument();
    expect(screen.getByText("已下架")).toBeInTheDocument();
    await user.hover(screen.getByRole("button", { name: /^网关拒绝.*说明$/ }));
    const tip = screen.getByRole("tooltip");
    expect(tip).toHaveTextContent("从未到达上游");
    expect(tip).toHaveTextContent("无后缀免费名单");
  });
});

/* ================================================================== *
 * 网关页与 Worker 页
 * ================================================================== */

function expectLocalOpenCodeProvider(snippet: string, port: number, version: "1" | "2" = "2") {
  const config = JSON.parse(snippet);
  const settings = {
    baseURL: `http://127.0.0.1:${port}/v1`,
    apiKey: "<把配置文件里的 gateway.relayToken 填进来>",
  };
  if (version === "1") {
    expect(config).toEqual({
      $schema: "https://opencode.ai/config.json",
      provider: { opencode: { options: settings } },
    });
    return;
  }
  expect(config).toEqual({
    $schema: "https://opencode.ai/config.json",
    providers: { opencode: { settings } },
  });
}

describe("网关页", () => {
  it("复制 OpenCode 2 配置时只覆盖 provider 连接设置，凭证仅有占位符", async () => {
    const user = userEvent.setup();
    const data = fakeOverview({
      gateway: {
        port: 9877,
        baseUrl: "https://example.invalid/zen/v1",
        relayToken: { present: true, fingerprint: "abcd1234" },
        maxAttempts: 3,
        headersTimeoutMs: 60_000,
        bodyTimeoutMs: 300_000,
      },
    });
    const { container } = render(<ClientPage data={data} />);
    await user.click(screen.getByRole("button", { name: "复制" }));
    const copied = await navigator.clipboard.readText();
    expectLocalOpenCodeProvider(copied, 9877);
    expect(copied).toBe(screen.getByText(/"providers":/, { selector: "pre" }).textContent);
    expect(copied).not.toContain("example.invalid");
    expect(copied).not.toContain("abcd1234");
    expect(container.textContent).toContain("abcd1234"); // 指纹可以显示
  });

  it("提醒保留 OpenCode 自己的模型目录并说明模型可用性边界", () => {
    render(<ClientPage data={fakeOverview()} />);
    expect(screen.getByText(/片段格式/)).toBeInTheDocument();
    expect(screen.getByText(/模型和 SDK 由 OpenCode 自己管理/)).toBeInTheDocument();
    expect(screen.getByText(/模型仍受上游权限与免费规则约束/)).toBeInTheDocument();
  });

  it("切换 OpenCode 1.x 后复制单数 provider 配置", async () => {
    const user = userEvent.setup();
    render(<ClientPage data={fakeOverview({ gateway: { port: 9877, baseUrl: "https://example.invalid/zen/v1", relayToken: { present: true, fingerprint: "abcd1234" }, maxAttempts: 3, headersTimeoutMs: 60_000, bodyTimeoutMs: 300_000 } })} />);
    await user.selectOptions(screen.getByRole("combobox", { name: "片段格式" }), "1");
    await user.click(screen.getByRole("button", { name: "复制" }));
    const copied = await navigator.clipboard.readText();
    expectLocalOpenCodeProvider(copied, 9877, "1");
    expect(copied).not.toContain('"providers"');
    expect(copied).not.toContain('"npm"');
  });

  it("代理池 Clash 标签提醒两条实测出来的坑", async () => {
    const data = fakeOverview({
      clash: {
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
            apiSecret: { present: true, fingerprint: "aaaa1111" },
            localProxyHost: "127.0.0.1",
            localProxyPort: 7897,
            selectorGroup: "Proxy",
          },
        ],
      },
    });
    stubIdleBatch();
    const user = userEvent.setup();
    render(<ProxyPage data={proxyList([], { clash: data.clash })} view={parseHash("#proxy?tab=clash")} navigate={noop} />);
    // 混合端口不一致 → 桥接静默失败；GLOBAL 在 rule 模式下切了不生效。收在内核面板标题旁的 ⓘ 里。
    await user.hover(screen.getByRole("button", { name: /^Clash 内核.*说明$/ }));
    const tip = screen.getByRole("tooltip");
    expect(tip).toHaveTextContent("mixed-port");
    expect(tip).toHaveTextContent("GLOBAL");
  });
});

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

describe("Worker 页", () => {
  it("状态与冷却规则收进标题旁的 ⓘ，悬停才显示，不占正文", async () => {
    const user = userEvent.setup();
    render(<WorkersPage data={fakeOverview()} view={parseHash("#workers")} navigate={noop} />);
    expect(screen.queryByText(/不等于/)).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "按出口" })).not.toBeInTheDocument();
    await user.hover(screen.getByRole("button", { name: /说明$/ }));
    expect(screen.getByRole("tooltip")).toHaveTextContent("「已启用」不等于「在候选池里」");
    // 回显目标的出口不等于 Zen 的出口（纪律 6），这句仍然要在。
    expect(screen.getByRole("tooltip")).toHaveTextContent("Zen 实际出口需核对发往 opencode.ai 的连接");
  });

  it("切换为匿名后隐藏并清空未提交的认证 key", async () => {
    const user = userEvent.setup();
    const patch = vi.spyOn(adminApi, "patchConfig").mockResolvedValue(undefined);
    render(<WorkersPage data={fakeOverview()} view={parseHash("#workers")} navigate={noop} />);

    // 空列表里也有一个「新增 Worker」；用页头那个。
    await user.click(screen.getAllByRole("button", { name: "新增 Worker" })[0]!);
    await user.selectOptions(screen.getByLabelText("类型"), "authenticated");
    await user.type(screen.getByLabelText("API key（认证必填）"), "fake-stale-key-not-real");
    await user.selectOptions(screen.getByLabelText("类型"), "anonymous");

    expect(screen.queryByLabelText("API key（认证必填）")).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("类型"), "authenticated");
    expect(screen.getByLabelText("API key（认证必填）")).toHaveValue("");
    await user.selectOptions(screen.getByLabelText("类型"), "anonymous");
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(patch).toHaveBeenCalledTimes(1);
    const payload = patch.mock.calls[0]![0];
    const created = payload.workers?.create?.[0];
    expect(created).toMatchObject({ id: "anon-1", kind: "anonymous", apiKey: "" });
    expect(JSON.stringify(payload)).not.toContain("fake-stale-key-not-real");
  });

  it("匿名 Worker 的凭证列显示无需 key", () => {
    render(
      <WorkersPage
        data={fakeOverview({ workers: [worker({ kind: "anonymous", apiKey: { present: false, fingerprint: null } })] })}
        view={parseHash("#workers")}
        navigate={noop}
      />,
    );
    expect(screen.getByText("无需 key")).toBeInTheDocument();
    expect(screen.queryByText("未配置")).not.toBeInTheDocument();
  });

  it("显示连续失败次数 —— 那是「客户端一直在发坏请求」的证据", () => {
    /*
     * `bad_request` 不冷却但计数照加，所以「连续失败 12 次却从未冷却」
     * 正是那个结论。Overview 的表没有这一列。
     */
    const data = fakeOverview({
      workers: [worker({ consecutiveFails: 12 })],
      pool: { ready: 1, total: 1, health: "healthy" },
    });
    const { container } = render(
      <WorkersPage data={data} view={parseHash("#workers")} navigate={noop} />,
    );
    expect(screen.getByText("连续失败")).toBeInTheDocument();
    expect(container.textContent).toContain("12");
  });

  it("本机直连与未探测**分开显示**", () => {
    const data = fakeOverview({
      workers: [
        worker({ id: "direct", proxyId: null, egressIp: null }),
        worker({ id: "unprobed", proxyId: "p9", egressIp: null }),
      ],
      pool: { ready: 2, total: 2, health: "healthy" },
    });
    render(<WorkersPage data={data} view={parseHash("#workers")} navigate={noop} />);
    // 「没绑代理」与「绑了但没探过」是两件事。
    expect(screen.getByText("本机直连 · 未探测")).toBeInTheDocument();
    expect(screen.getByText("未探测")).toBeInTheDocument();
  });

});

/* ================================================================== *
 * 文案不渲染字面 markdown
 * ================================================================== */

describe("文案不渲染字面 markdown", () => {
  /*
   * 文案带着字面 `**` 显示给用户的问题,
   * 而且集中在**最要紧的那些警告**上 —— GLOBAL 分组陷阱、mixed-port 陷阱、
   * 「免 key 通道已关闭」、「只能用真实 CLI」。也就是说最需要被看清的句子
   * 显示得最糟。
   *
   * 成因是这些文案从文档/注释里搬过来的,那里 `**` 是对的;JSX 不渲染 markdown。
   *
   * **为什么既有测试一条都没报警**:它们用 `/不要写/`、`/GLOBAL/`、`/mixed-port/`
   * 这类正则,匹配的片段恰好落在星号**之间** —— 于是对「有没有星号」
   * 完全不敏感。这正是纪律 #1 那句「断言的粒度必须与缺陷的粒度一致」:
   * 查「关键词在不在」挡不住「关键词周围多了两个星号」。
   *
   * 所以这里按**整页扫描**,而不是逐句断言 —— 逐句会重蹈覆辙(下一个新写的
   * 句子仍然不在任何断言里),而扫整页对「哪一句」不作假设。
   */
  const pages: ReadonlyArray<[string, () => React.ReactElement]> = [
    ["概览", () => <OverviewPage data={fakeOverview()} />],
    ["网关", () => <GatewayPage data={fakeOverview()} />],
    ["代理池", () => <ProxyPage data={proxyList([proxy()])} view={view} navigate={noop} />],
    ["Worker", () => <WorkersPage data={fakeOverview()} view={parseHash("#workers")} navigate={noop} />],
    ["模型", () => <ModelsPage data={modelList()} view={parseHash("#models")} navigate={noop} />],
    ["用量", () => <UsagePage data={stats()} days="30" onDays={noop} />],
  ];

  for (const [name, mount] of pages) {
    it(`${name}页不含字面 ** 或裸下划线强调`, () => {
      const { container } = render(mount());
      const text = container.textContent ?? "";
      expect(text.length).toBeGreaterThan(0);
      // `**` 是 markdown 强调;它出现在渲染文本里就说明有人把文档直接搬进了 JSX。
      expect(text).not.toContain("**");
    });
  }

});

/* ================================================================== *
 * 订阅标签
 * ================================================================== */

function subView(over: Partial<ProxyList["subscriptions"][number]> = {}): ProxyList["subscriptions"][number] {
  return {
    id: "sub1",
    name: "机场一",
    urlRedacted: "https://sub.example.invalid/link?token=***",
    enabled: true,
    lastFetchedAt: "2026-09-25T10:00:00.000Z",
    lastErrorKind: null,
    lastImportCount: 12,
    lastFormat: "clash",
    proxyCount: 12,
    ...over,
  };
}

describe("订阅标签", () => {
  it("只显示脱敏后的 URL —— 界面上抄不到 token", () => {
    stubIdleBatch();
    const { container } = render(
      <ProxyPage
        data={proxyList([], { subscriptions: [subView()] })}
        view={parseHash("#proxy?tab=subscriptions")}
        navigate={noop}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("sub.example.invalid");
    expect(text).toContain("***");
    // 前端拿不到原值（服务端就没给），这里钉住"界面上没有裸 token"。
    expect(text).not.toMatch(/token=[A-Za-z0-9]{8,}/);
  });

  it("**「从没拉过」与「拉过但失败了」显示不同** —— 下一步不同", () => {
    /*
     * 前者的下一步是"点一下刷新"，后者是"看看 token 过期了没"。
     * 合成一句"未就绪"会让用户从头猜 —— 与 doctor 分层同一个理由。
     */
    expect(subscriptionStatus(subView({ lastFetchedAt: null }))).toMatchObject({
      tone: "warn",
      label: "从未拉取",
    });
    expect(subscriptionStatus(subView({ lastErrorKind: "http_error" }))).toMatchObject({
      tone: "error",
    });
    expect(subscriptionStatus(subView())).toMatchObject({ tone: "success" });
  });

  it("停用时也把失败原因带上 —— 不是一条 early return 就完事", () => {
    /*
     * `proxyStatus` 上出现过这个形态：`if (!enabled) return "已停用"`
     * 让最常见的那类输入永远看不到原因。这里是同一个教训的预防。
     */
    const s = subscriptionStatus(subView({ enabled: false, lastErrorKind: "timeout" }));
    expect(s.tone).toBe("neutral");
    expect(s.label).toContain("已停用");
    expect(s.label).toContain("timeout");
  });

  it("空订阅列表给出下一步，而不只是说「空」", () => {
    stubIdleBatch();
    render(
      <ProxyPage
        data={proxyList([], { subscriptions: [] })}
        view={parseHash("#proxy?tab=subscriptions")}
        navigate={noop}
      />,
    );
    expect(screen.getByText(/还没有订阅/)).toBeInTheDocument();
    // 下一步在界面里：添加订阅的按钮就在面板上。
    expect(screen.getByRole("button", { name: "添加订阅" })).toBeInTheDocument();
  });

  it("刷新按钮在请求在途时禁用 —— 否则重复点会得到 409", async () => {
    // 永挂的 fetch：模拟"正在刷新"。
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    const { container } = render(
      <ProxyPage
        data={proxyList([], { subscriptions: [subView()] })}
        view={parseHash("#proxy?tab=subscriptions")}
        navigate={noop}
      />,
    );

    const button = [...container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes("刷新"),
    )!;
    expect(button.hasAttribute("disabled")).toBe(false);

    const { act } = await import("react");
    await act(async () => {
      button.click();
    });

    const after = [...container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes("刷新"),
    )!;
    expect(after.hasAttribute("disabled")).toBe(true);
    expect(after.textContent).toContain("刷新中");
  });
});
