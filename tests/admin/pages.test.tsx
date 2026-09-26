import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProxyPage, subscriptionStatus } from "../../src/admin/pages/ProxyPage.tsx";
import { OverviewPage } from "../../src/admin/pages/OverviewPage.tsx";
import { ModelsPage } from "../../src/admin/pages/ModelsPage.tsx";
import { UsagePage } from "../../src/admin/pages/UsagePage.tsx";
import { GatewayPage } from "../../src/admin/pages/GatewayPage.tsx";
import { WorkersPage } from "../../src/admin/pages/WorkersPage.tsx";
import { Wizard } from "../../src/admin/pages/Wizard.tsx";
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
    clash: { enabled: false, activeBridgeId: null, bridges: [] },
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
  it("超过一页时分页,页长 12（与「一屏 12 行」的算术对齐）", () => {
    stubIdleBatch();
    /*
     * 密度选宽松（行高 44px）的直接后果是一屏约 12 行，而代理池可能有几十个
     * 节点（本机实测 69 个）。所以分页是**必需项**，且页长必须与密度一致 ——
     * 规划里先前写 20，那与自己的密度结论矛盾。
     */
    expect(PAGE_SIZE).toBe(12);

    const many = Array.from({ length: 30 }, (_, i) =>
      proxy({ id: `p${i}`, name: `节点${i}`, usedBy: [] }),
    );
    const { container } = render(
      <ProxyPage data={proxyList(many)} view={view} navigate={noop} />,
    );

    expect(container.querySelectorAll("tr[data-row]")).toHaveLength(12);
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

  it("本地端口必须显示 —— 它是 Phase 8 实测出的高风险字段", () => {
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

  it("回显出口标签**不分页** —— 一眼看全是它的全部意义", () => {
    stubIdleBatch();
    const groups = Array.from({ length: 20 }, (_, i) => ({
      egressIp: `198.51.100.${i + 1}`,
      workerIds: [`w${i}`],
      proxyIds: [`p${i}`],
    }));
    const { container } = render(
      <ProxyPage
        data={proxyList([], { isolation: { groups, unknownWorkerIds: [], sharedGroups: [], isolated: true } })}
        view={parseHash("#proxy?tab=isolation")}
        navigate={noop}
      />,
    );
    // 20 组全部渲染 —— 分页会破坏「找出共用出口的节点」这个任务。
    expect(container.querySelectorAll("li").length).toBeGreaterThanOrEqual(20);
    expect(screen.queryByText(/上一页/)).not.toBeInTheDocument();
    expect(screen.getByText("回显出口独立 · 20 个出口")).toBeInTheDocument();
    expect(screen.getByText(/仅反映 IP 回显目标的出口/)).toBeInTheDocument();
    expect(container.textContent).toContain("Zen 实际出口需核对发往 opencode.ai 的连接");
    expect(screen.queryByText(/已隔离/)).not.toBeInTheDocument();
  });

  it("共用出口的那一组用 error 边框标出来", () => {
    stubIdleBatch();
    const shared = { egressIp: "198.51.100.1", workerIds: ["w1", "w2"], proxyIds: ["p1", "p2"] };
    const { container } = render(
      <ProxyPage
        data={proxyList([], {
          isolation: { groups: [shared], unknownWorkerIds: [], sharedGroups: [shared], isolated: false },
        })}
        view={parseHash("#proxy?tab=isolation")}
        navigate={noop}
      />,
    );
    /*
     * 「共用出口」出现两次:状态行的「回显出口共用 · 1 组共用出口」与那一组自己的
     * 「⚠ 共用出口」标记。两处都要 —— 前者回答「有没有问题」,后者指出「是哪一组」。
     */
    expect(screen.getAllByText(/共用出口/).length).toBeGreaterThanOrEqual(2);
    expect(container.querySelector(".border-error")).not.toBeNull();
  });

  it("空代理池给出下一步,而不只是说「空」", () => {
    stubIdleBatch();
    render(<ProxyPage data={proxyList([])} view={view} navigate={noop} />);
    expect(screen.getByText(/还没有代理/)).toBeInTheDocument();
    expect(screen.getByText(/npm run setup/)).toBeInTheDocument();
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
     * 整套 83 条测试**依然全绿** —— 没有一条覆盖这条路径。
     */
    const rows = Array.from({ length: 15 }, (_, i) =>
      proxy({ id: `p${i}`, name: `节点${i}`, usedBy: [] }),
    );
    const { container } = render(
      // 15 行 → 2 页，而 URL 说第 99 页。
      <ProxyPage data={proxyList(rows)} view={parseHash("#proxy?page=99")} navigate={noop} />,
    );

    // 夹到最后一页 → 显示第 13-15 条（3 行），而不是 0 行。
    expect(container.querySelectorAll("tr[data-row]")).toHaveLength(3);
    expect(container.textContent?.replace(/\s+/g, " ")).toContain("共 15 条");
  });

  it("页码小于 1 时夹到第一页", () => {
    stubIdleBatch();
    const rows = Array.from({ length: 15 }, (_, i) =>
      proxy({ id: `p${i}`, name: `节点${i}`, usedBy: [] }),
    );
    const { container } = render(
      <ProxyPage data={proxyList(rows)} view={{ ...parseHash("#proxy"), page_: -5 }} navigate={noop} />,
    );
    expect(container.querySelectorAll("tr[data-row]")).toHaveLength(12);
  });
});

/* ================================================================== *
 * 模型
 * ================================================================== */

function modelList(overrides: Partial<ModelList> = {}): ModelList {
  return {
    models: [
      { id: "a-free", free: true, reason: "suffix", surfaces: ["chat"], listed: true },
      { id: "big-pickle", free: true, reason: "extra", surfaces: ["chat"], listed: true },
      { id: "paid-model", free: false, reason: "not_free", surfaces: ["chat"], listed: true },
      { id: "gone-free", free: false, reason: "retired", surfaces: ["chat"], listed: false },
    ],
    catalogAvailable: true,
    rules: {
      freeSuffix: "-free",
      extraFreeIds: ["big-pickle"],
      defaultSurfaces: ["chat", "responses"],
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

  it("显示协议面（`surfacesFor` 的第一个生产调用点，只作展示）", () => {
    render(<ModelsPage data={modelList()} view={parseHash("#models")} navigate={noop} />);
    // 缺口 #10:它不能接成放行闸门(默认值会让 /v1/messages 全被拒)。
    expect(screen.getAllByText("chat").length).toBeGreaterThan(0);
  });

  it("在架数量只统计 listed 条目，不把配置中的下架项算进去", () => {
    render(
      <ModelsPage data={modelList()} view={parseHash("#models")} navigate={noop} />,
    );
    const listedLabel = screen.getByText("在架模型");
    expect(listedLabel.parentElement?.textContent).toContain("3");
  });

  it("说明那条不对称（下架能自动剔除，新免费模型不能自动发现）", () => {
    render(<ModelsPage data={modelList()} view={parseHash("#models")} navigate={noop} />);
    expect(screen.getByText(/无法自动发现/)).toBeInTheDocument();
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

  it("「上游没报」与「我们丢了」是两列", () => {
    render(<UsagePage data={stats()} days="30" onDays={noop} />);
    // 处置方向相反:前者是上游的性质，后者说明我们的界定常量要改。
    expect(screen.getByText("未报")).toBeInTheDocument();
    expect(screen.getByText("我们丢了")).toBeInTheDocument();
  });

  it("dropped 非 0 时单独告警并说明它不是上游的问题", () => {
    render(
      <UsagePage
        data={stats({ rates: { cacheHitRate: 0.1, usageCoverage: 0.5, droppedUsageCount: 4 } })}
        days="30"
        onDays={noop}
      />,
    );
    expect(screen.getByText(/4 次响应我们没解析完整/)).toBeInTheDocument();
    /*
     * 用**整段的 textContent** 匹配,而不是 `getByText(/不是.*上游没报/)`。
     *
     * 那句话里「不是」被 `<Strong>` 包着（强调它),于是文本被切成多个节点,
     * 而 Testing Library 的默认匹配是逐节点的 —— 跨节点的正则匹配不到。
     * 用户看到的字一个没变,变的只是 DOM 结构。
     *
     * 这也是第八轮审核发现「六个页面渲染出字面 `**`」时,既有测试全都没报警的
     * 原因:它们用的正则（`/不要写/`、`/GLOBAL/`）恰好落在星号之间,
     * 于是对「有没有星号」完全不敏感。
     */
    const banner = screen.getByText(/4 次响应我们没解析完整/).closest("section");
    expect(banner?.textContent).toMatch(/不是[\s\S]*上游没报/);
    // 同时钉住「不渲染字面 markdown」—— 那是这次真正要防的回归。
    expect(banner?.textContent).not.toContain("**");
  });

  it("网关拒绝分原因列出,并说明 not_free 与 retired 处置不同", () => {
    render(<UsagePage data={stats()} days="30" onDays={noop} />);
    expect(screen.getByText("不是免费模型")).toBeInTheDocument();
    expect(screen.getByText("已下架")).toBeInTheDocument();
    expect(screen.getByText(/该改文档还是该改配置/)).toBeInTheDocument();
  });

  it("这些请求从未到达上游 —— 要说清楚", () => {
    render(<UsagePage data={stats()} days="30" onDays={noop} />);
    expect(screen.getByText(/从未到达上游/)).toBeInTheDocument();
  });
});

/* ================================================================== *
 * 网关页与 Worker 页
 * ================================================================== */

function expectLocalOpenCodeModels(snippet: string, port: number) {
  const config = JSON.parse(snippet);
  const settings = {
    baseURL: `http://127.0.0.1:${port}/v1`,
    apiKey: "<把配置文件里的 gateway.relayToken 填进来>",
  };
  expect(config).toEqual({
    providers: {
      opencode: {
        package: "aisdk:@ai-sdk/openai-compatible",
        settings,
        models: {
          "muse-spark-1.3-contributor-free": { package: "aisdk:@ai-sdk/openai", settings },
          "big-pickle": { package: "aisdk:@ai-sdk/openai-compatible", settings },
          "space-bunny-free": { package: "aisdk:@ai-sdk/openai-compatible", settings },
          "mimo-v2.6-flash-free": { package: "aisdk:@ai-sdk/openai-compatible", settings },
        },
      },
    },
  });
}

describe("网关页", () => {
  it("复制 OpenCode 2 配置时每个模型都指向网关，凭证仅有占位符", async () => {
    const user = userEvent.setup();
    const data = fakeOverview({
      gateway: {
        port: 9877,
        baseUrl: "https://example.invalid/zen/v1",
        relayToken: { present: true, fingerprint: "abcd1234" },
        maxAttempts: 3,
      },
    });
    const { container } = render(<GatewayPage data={data} />);
    await user.click(screen.getByRole("button", { name: "复制" }));
    const copied = await navigator.clipboard.readText();
    expectLocalOpenCodeModels(copied, 9877);
    expect(copied).toBe(screen.getByText(/"providers":/, { selector: "pre" }).textContent);
    expect(copied).not.toContain("example.invalid");
    expect(copied).not.toContain("abcd1234");
    expect(container.textContent).toContain("abcd1234"); // 指纹可以显示
  });

  it("提醒保留逐模型设置并说明模型可用性边界", () => {
    render(<GatewayPage data={fakeOverview()} />);
    expect(screen.getByText(/保留逐模型的/)).toBeInTheDocument();
    expect(screen.getByText(/模型仍受上游权限与免费规则约束/)).toBeInTheDocument();
  });

  it("Clash 已启用时提醒两条实测出来的坑", () => {
    const data = fakeOverview({
      clash: {
        enabled: true,
        activeBridgeId: "b1",
        bridges: [
          {
            id: "b1",
            name: "verge",
            enabled: true,
            apiBase: "http://127.0.0.1:9097",
            apiSecret: { present: true, fingerprint: "aaaa1111" },
            localProxyPort: 7897,
            selectorGroup: "Proxy",
          },
        ],
      },
    });
    render(<GatewayPage data={data} />);
    // 混合端口不一致 → 桥接静默失败；GLOBAL 在 rule 模式下切了不生效。
    expect(screen.getByText(/mixed-port/)).toBeInTheDocument();
    expect(screen.getByText(/GLOBAL/)).toBeInTheDocument();
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
  it("切换为匿名后隐藏并清空未提交的认证 key", async () => {
    const user = userEvent.setup();
    const patch = vi.spyOn(adminApi, "patchConfig").mockResolvedValue(undefined);
    render(<WorkersPage data={fakeOverview()} view={parseHash("#workers")} navigate={noop} />);

    await user.click(screen.getByRole("button", { name: "新增 Worker" }));
    await user.type(screen.getByLabelText("ID"), "anon-1");
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
    expect(screen.getByText("本机直连")).toBeInTheDocument();
    expect(screen.getByText("未探测")).toBeInTheDocument();
  });

  it("说明「已启用」不等于「在候选池里」", () => {
    render(
      <WorkersPage data={fakeOverview({ workers: [worker()] })} view={parseHash("#workers")} navigate={noop} />,
    );
    expect(screen.getByText(/不等于/)).toBeInTheDocument();
  });
});

/* ================================================================== *
 * 首启向导
 * ================================================================== */

describe("首启向导", () => {
  it("四步都有，且已完成的打勾", () => {
    const data = fakeOverview({
      catalog: { slots: [], freeCount: 10 },
      proxies: { total: 3, enabled: 3, withEgressIp: 3 },
    });
    const { container } = render(<Wizard data={data} />);

    expect(container.querySelectorAll("[data-step]")).toHaveLength(4);
    // 目录与代理都齐了 → 前两步打勾。
    expect(screen.getByText("上游目录能拉到")).toBeInTheDocument();
    expect(screen.getByText(/已拉到 10 个免费模型/)).toBeInTheDocument();
  });

  it("给出的配置让每个模型使用实际网关端口，凭证仅有占位符", () => {
    const data = fakeOverview();
    data.gateway.port = 19876;
    render(<Wizard data={data} />);
    const snippet = screen.getByText(/"providers":/, { selector: "pre" }).textContent ?? "";
    expectLocalOpenCodeModels(snippet, 19876);
    expect(screen.getByText(/保留逐模型的/)).toBeInTheDocument();
    expect(screen.getByText(/片段不保证上游接受这些模型/)).toBeInTheDocument();
  });

  it("每一步都给可直接跑的命令", () => {
    const { container } = render(<Wizard data={fakeOverview()} />);
    // 空状态的价值在于下一步 —— 与 doctor 的分层同一个理由。
    expect(container.textContent).toContain("npm run setup");
    expect(container.textContent).toContain("opencode run");
    expect(container.textContent).toContain("NODE_EXTRA_CA_CERTS");
  });

  it("说明匿名与认证 Worker 的 key 要求不同", () => {
    render(<Wizard data={fakeOverview()} />);
    expect(screen.getByText(/匿名 Worker 可以不填 key/)).toBeInTheDocument();
  });
});

/* ================================================================== *
 * 文案不渲染字面 markdown
 * ================================================================== */

describe("文案不渲染字面 markdown", () => {
  /*
   * 第八轮审核发现:六个页面共二十多处文案带着字面 `**` 显示给用户,
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
    [
      "代理池·隔离",
      () => (
        <ProxyPage
          data={proxyList([proxy()])}
          view={parseHash("#proxy?tab=isolation")}
          navigate={noop}
        />
      ),
    ],
    ["Worker", () => <WorkersPage data={fakeOverview()} view={parseHash("#workers")} navigate={noop} />],
    ["模型", () => <ModelsPage data={modelList()} view={parseHash("#models")} navigate={noop} />],
    ["用量", () => <UsagePage data={stats()} days="30" onDays={noop} />],
    ["向导", () => <Wizard data={fakeOverview()} />],
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

  it("强调改用 <strong> —— 语义留着，样式不用粗体", () => {
    /*
     * 修法不是「把星号删掉」(那会丢掉强调),而是换成一个组件。
     * 这条钉住它真的产出了 `<strong>`:否则下一个人会以为直接删星号就行。
     */
    const { container } = render(
      <ProxyPage data={proxyList([proxy()])} view={view} navigate={noop} />,
    );
    const strongs = container.querySelectorAll("strong");
    expect(strongs.length).toBeGreaterThan(0);
    // 用 font-medium 而不是默认的 font-bold —— 14px 正文下粗体会造成视觉断层。
    expect(strongs[0]!.className).toContain("font-medium");
  });
});

/* ================================================================== *
 * 订阅标签（Phase 10）
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
     * 第八轮在 `proxyStatus` 上踩过这个形态：`if (!enabled) return "已停用"`
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
    // 眼下没有"添加订阅"的表单，所以必须告诉用户去哪加。
    expect(screen.getByText(/subscriptions/)).toBeInTheDocument();
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
