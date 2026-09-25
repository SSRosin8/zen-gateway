import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { ProxyPage } from "../../src/admin/pages/ProxyPage.tsx";
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

/*
 * 其余 5 页 + 向导的组件契约。
 *
 * 与 Overview 那组同一条规则:用 Testing Library 表达意图，不做 HTML 字符串
 * 断言。旧项目的 8446 行 UX 测试正是字符串断言，无法迁移。
 */

afterEach(() => {
  vi.unstubAllGlobals();
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

  it("出口隔离标签**不分页** —— 一眼看全是它的全部意义", () => {
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
     * 「共用出口」出现两次:状态行的「未隔离 · 1 组共用出口」与那一组自己的
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
    expect(screen.getByText(/不是.*上游没报/)).toBeInTheDocument();
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

describe("网关页", () => {
  it("给出可复制的配置片段，但**不含 Relay Token 的值**", () => {
    const data = fakeOverview({
      gateway: {
        port: 9877,
        baseUrl: "https://example.invalid/zen/v1",
        relayToken: { present: true, fingerprint: "abcd1234" },
        maxAttempts: 3,
      },
    });
    const { container } = render(<GatewayPage data={data} />);

    expect(container.textContent).toContain("http://127.0.0.1:9877/v1");
    // 片段里只能是占位符 —— 把 token 渲染进 DOM 等于让它进截图与扩展。
    expect(container.textContent).toContain("gateway.relayToken");
    expect(container.textContent).toContain("abcd1234"); // 指纹可以显示
    expect(container.textContent).not.toContain("$schema\": \"x"); // 形状哨兵
  });

  it("提醒不要写 models 块", () => {
    render(<GatewayPage data={fakeOverview()} />);
    expect(screen.getByText(/不要写/)).toBeInTheDocument();
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

  it("**不渲染 Relay Token 的值** —— 只说去哪儿取", () => {
    const { container } = render(<Wizard data={fakeOverview()} />);
    expect(container.textContent).toContain("gateway.relayToken");
    // 向导里给的是占位符。
    expect(container.textContent).toContain("data/config.json");
  });

  it("每一步都给可直接跑的命令", () => {
    const { container } = render(<Wizard data={fakeOverview()} />);
    // 空状态的价值在于下一步 —— 与 doctor 的分层同一个理由。
    expect(container.textContent).toContain("npm run setup");
    expect(container.textContent).toContain("opencode run");
    expect(container.textContent).toContain("NODE_EXTRA_CA_CERTS");
  });

  it("说明免 key 通道已关 —— 否则用户会试着不填 key", () => {
    render(<Wizard data={fakeOverview()} />);
    expect(screen.getByText(/FreeTierError/)).toBeInTheDocument();
  });
});
