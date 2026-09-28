import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { UNDO_WINDOW_MS } from "../../src/admin/lib/rowNotes.ts";
import userEvent from "@testing-library/user-event";
import { App } from "../../src/admin/App.tsx";
import { probeTargets } from "../../src/admin/pages/OverviewPage.tsx";
import { WorkersPage } from "../../src/admin/pages/WorkersPage.tsx";
import { useProbe } from "../../src/admin/lib/api.ts";
import type { Overview } from "../../src/shared/contract.ts";
import { ProxyPage } from "../../src/admin/pages/ProxyPage.tsx";
import { UsagePage } from "../../src/admin/pages/UsagePage.tsx";
import { parseHash } from "../../src/admin/lib/router.ts";
import { PAGE_SIZE } from "../../src/admin/components/DataTable.tsx";
import {
  ProxyListSchema,
  StatsViewSchema,
  UNKNOWN_MODEL,
  type ProxyList,
  type ProxyView,
  type StatsView,
  type WorkerView,
} from "../../src/shared/contract.ts";
import { DIRECT_EGRESS_ID } from "../../src/shared/schema.ts";
import { fakeOverview } from "./App.test.tsx";

/*
 * 第二轮控制台打磨：概览的逐个出口探测与 Worker 表合并、代理池单行探测、
 * Worker 页不再重复打开新增表单、用量页的被拒模型明细。
 */

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.location.hash = "";
});

function worker(id: string, over: Partial<WorkerView> = {}): WorkerView {
  return {
    id,
    name: "",
    kind: "anonymous",
    enabled: true,
    proxyId: `p-${id}`,
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

function withWorkers(workers: WorkerView[]) {
  return fakeOverview({
    workers,
    pool: { ready: workers.length, total: workers.length, health: workers.length === 0 ? "empty" : "healthy" },
    isolation: { groups: [], unknownWorkerIds: workers.map((w) => w.id), sharedGroups: [], isolated: false },
  });
}

type Pending = { body: string; resolve: (value: unknown) => void };

/** 与 App 一样由外层持有探测状态，并在每探完一个时回调。 */
function ProbeHarness({ data, onProgress = () => {}, hash = "#workers" }: { data: Overview; onProgress?: () => void; hash?: string }) {
  const probe = useProbe(onProgress);
  return <WorkersPage data={data} view={parseHash(hash)} navigate={() => {}} probe={probe} />;
}

/** `/api/probe` 的请求挂起直到测试放行，用来观察「探到第几个」。 */
function stubProbe() {
  const pending: Pending[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((path: string, init?: RequestInit) => {
      if (path !== "/api/probe") return new Promise(() => {});
      return new Promise((resolve) => pending.push({ body: String(init?.body), resolve }));
    }),
  );
  const answer = (ok: boolean) => {
    const next = pending.shift()!;
    const id = (JSON.parse(next.body) as { proxyIds: string[] }).proxyIds[0]!;
    const result = ok
      ? { proxyId: id, ok: true, egressIp: "198.51.100.9", latencyMs: 12, via: "http://127.0.0.1/" }
      : { proxyId: id, ok: false, failureKind: "timeout", reason: "回显服务超时" };
    next.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, changed: ok, results: [result] }) });
  };
  return { pending, answer };
}

describe("Worker 页：在用出口逐个探测", () => {
  it("探测目标只含候选池里的 Worker，直连记为 __direct__，重复出口只探一次", () => {
    const targets = probeTargets([
      worker("a", { proxyId: "p1" }),
      worker("b", { proxyId: "p1" }),
      worker("c", { proxyId: null }),
      worker("d", { proxyId: "p2", inPool: false }),
    ]);
    expect(targets).toEqual(["p1", DIRECT_EGRESS_ID]);
  });

  it("按钮显示已完成数，结果到一个标一个，失败原因标在对应行上", async () => {
    const user = userEvent.setup();
    const probe = stubProbe();
    const refresh = vi.fn();
    render(<ProbeHarness data={withWorkers([worker("a"), worker("b")])} onProgress={refresh} />);

    await user.click(screen.getByRole("button", { name: "探测在用出口" }));
    await waitFor(() => expect(probe.pending).toHaveLength(1));
    // 一次只发一个出口。
    expect(JSON.parse(probe.pending[0]!.body)).toEqual({ proxyIds: ["p-a"] });
    expect(screen.getByRole("button", { name: "探测中 0/2" })).toBeDisabled();
    const rowOf = (id: string) => screen.getByText(id).closest("tr")!;
    expect(within(rowOf("a")).getByText("探测中…")).toBeInTheDocument();

    probe.answer(true);
    await waitFor(() => expect(screen.getByRole("button", { name: "探测中 1/2" })).toBeInTheDocument());
    // 每探完一个就刷新，表里的 IP 随之更新。
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(within(rowOf("b")).getByText("探测中…")).toBeInTheDocument();

    probe.answer(false);
    await waitFor(() => expect(screen.getByRole("button", { name: "探测在用出口" })).toBeEnabled());
    expect(within(rowOf("b")).getByText("探测失败")).toBeInTheDocument();
    expect(within(rowOf("b")).getByText("回显服务超时")).toBeInTheDocument();
    expect(screen.getByText(/本轮探测了 2\/2 个出口，\s*1 个失败/)).toBeInTheDocument();
  });

  it("停止后不再发下一个出口", async () => {
    const user = userEvent.setup();
    const probe = stubProbe();
    render(<ProbeHarness data={withWorkers([worker("a"), worker("b"), worker("c")])} />);
    await user.click(screen.getByRole("button", { name: "探测在用出口" }));
    await waitFor(() => expect(probe.pending).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: "停止探测" }));
    probe.answer(true);
    await waitFor(() => expect(screen.getByRole("button", { name: "探测在用出口" })).toBeEnabled());
    expect(probe.pending).toHaveLength(0);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it("Worker 表分页", () => {
    const many = Array.from({ length: PAGE_SIZE + 3 }, (_, i) => worker(`w${String(i).padStart(2, "0")}`));
    render(<ProbeHarness data={withWorkers(many)} hash="#workers?page=2" />);
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(1 + 3);
    expect(screen.getByText(/共 19 条/)).toBeInTheDocument();
  });
});

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
    username: null,
    password: { present: false, fingerprint: null },
    usedBy: [],
    resolvable: true,
    unresolvableReason: null,
    ...over,
  };
}

function proxyList(proxies: ProxyView[]): ProxyList {
  return ProxyListSchema.parse({
    proxies,
    clash: { enabled: false, selectionMode: "auto", activeBridgeId: null, bridges: [] },
    isolation: { groups: [], unknownWorkerIds: [], sharedGroups: [], isolated: false },
    subscriptions: [],
  });
}

describe("出口页：节点探测", () => {
  const two = () => proxyList([proxy(), proxy({ id: "p2", name: "节点二", clashNodeName: "节点二" })]);

  it("每行「探测」只探这一个节点，结果写在那一行", async () => {
    const user = userEvent.setup();
    const probe = stubProbe();
    const refresh = vi.fn();
    render(<ProxyPage data={two()} view={parseHash("#proxy")} navigate={() => {}} refresh={refresh} />);
    const row = () => screen.getByText("节点二").closest("tr")!;
    await user.click(within(row()).getByRole("button", { name: "探测" }));
    await waitFor(() => expect(probe.pending).toHaveLength(1));
    expect(JSON.parse(probe.pending[0]!.body)).toEqual({ proxyIds: ["p2"] });
    expect(within(row()).getByText("探测中…")).toBeInTheDocument();
    // 一次只探一个：其他行的按钮也禁用。
    const other = screen.getByText("节点一").closest("tr")!;
    expect(within(other).getByRole("button", { name: "探测" })).toBeDisabled();

    probe.answer(true);
    await waitFor(() => expect(within(row()).getByText(/回显 198\.51\.100\.9 · 12ms/)).toBeInTheDocument());
    expect(refresh).toHaveBeenCalled();
  });

  it("多选后批量探测逐个进行，每行各自出结果", async () => {
    const user = userEvent.setup();
    const probe = stubProbe();
    render(<ProxyPage data={two()} view={parseHash("#proxy")} navigate={() => {}} />);
    await user.click(screen.getByRole("checkbox", { name: "全选本页" }));
    const bar = screen.getByRole("toolbar", { name: "批量操作" });
    expect(bar).toHaveTextContent("已选 2 项");
    await user.click(within(bar).getByRole("button", { name: "探测" }));
    await waitFor(() => expect(probe.pending).toHaveLength(1));
    probe.answer(true);
    await waitFor(() => expect(probe.pending).toHaveLength(1));
    probe.answer(false);
    await waitFor(() => expect(within(screen.getByText("节点二").closest("tr")!).getByText(/timeout/)).toBeInTheDocument());
    expect(within(screen.getByText("节点一").closest("tr")!).getByText(/回显 198/)).toBeInTheDocument();
  });

  it("逐个探测中途出错：已探到的结果保留，只有出错的那个标错", async () => {
    const user = userEvent.setup();
    const three = proxyList([proxy(), proxy({ id: "p2", name: "节点二" }), proxy({ id: "p3", name: "节点三" })]);
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((path: string, init?: RequestInit) => {
        if (path !== "/api/probe") return new Promise(() => {});
        calls += 1;
        if (calls === 2) return Promise.reject(new Error("网关连不上"));
        const id = (JSON.parse(String(init?.body)) as { proxyIds: string[] }).proxyIds[0]!;
        const result = { proxyId: id, ok: true, egressIp: "198.51.100.9", latencyMs: 12, via: "http://127.0.0.1/" };
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, changed: true, results: [result] }) });
      }),
    );
    render(<ProxyPage data={three} view={parseHash("#proxy")} navigate={() => {}} />);
    await user.click(screen.getByRole("checkbox", { name: "全选本页" }));
    await user.click(within(screen.getByRole("toolbar", { name: "批量操作" })).getByRole("button", { name: "探测" }));
    const row = (name: string) => screen.getByText(name).closest("tr")!;
    await waitFor(() => expect(within(row("节点二")).getByText(/未连接到网关服务/)).toBeInTheDocument());
    expect(within(row("节点一")).getByText(/回显 198\.51\.100\.9/)).toBeInTheDocument();
    expect(within(row("节点三")).getByText(/未探测/)).toBeInTheDocument();
    expect(within(row("节点三")).queryByText(/未连接到网关服务/)).not.toBeInTheDocument();
  });

  it("批测结束后：排队状态不再显示；单独探测过的节点以新结果为准", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const batch = {
      state: "done", screenTotal: 2, screenDone: 2, mainTotal: 2, mainDone: 1, cancelRequested: true,
      addedWorkerIds: [], failureKind: "cancelled", elapsedMs: 1000,
      nodes: [{ proxyId: "p1", state: "failed", reason: "timeout:超时" }, { proxyId: "p2", state: "queued" }],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn((path: string, init?: RequestInit) => {
        if (path === "/api/batch-probe") return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(batch) });
        if (path === "/api/probe") {
          const id = (JSON.parse(String(init?.body)) as { proxyIds: string[] }).proxyIds[0]!;
          const result = { proxyId: id, ok: true, egressIp: "198.51.100.9", latencyMs: 12, via: "http://127.0.0.1/" };
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, changed: true, results: [result] }) });
        }
        return new Promise(() => {});
      }),
    );
    render(<ProxyPage data={two()} view={parseHash("#proxy")} navigate={() => {}} />);
    const row = (name: string) => screen.getByText(name).closest("tr")!;
    expect(await within(row("节点一")).findByText("探测失败")).toBeInTheDocument();
    expect(within(row("节点二")).queryByText("排队中")).not.toBeInTheDocument();

    await user.click(within(row("节点一")).getByRole("button", { name: "探测" }));
    await waitFor(() => expect(within(row("节点一")).getByText(/回显 198/)).toBeInTheDocument());
    // 行内提示 10 秒后消失，之后也不回到上一批的「探测失败」。
    act(() => vi.advanceTimersByTime(UNDO_WINDOW_MS + 1));
    expect(within(row("节点一")).queryByText(/回显 198/)).not.toBeInTheDocument();
    expect(within(row("节点一")).queryByText("探测失败")).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it("停用在行内显示结果并可撤销，撤销发回原状态", async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((path: string, init?: RequestInit) => {
        if (path === "/api/config") bodies.push(JSON.parse(String(init?.body)));
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, changed: true }) });
      }),
    );
    render(<ProxyPage data={two()} view={parseHash("#proxy")} navigate={() => {}} />);
    const row = () => screen.getByText("节点一").closest("tr")!;
    await user.click(within(row()).getByRole("button", { name: "停用" }));
    expect(await within(row()).findByText("已停用")).toBeInTheDocument();
    await user.click(within(row()).getByRole("button", { name: "撤销" }));
    await waitFor(() => expect(within(row()).getByText("已撤销")).toBeInTheDocument());
    expect(bodies).toEqual([
      { proxies: { update: { p1: { enabled: false } } } },
      { proxies: { update: { p1: { enabled: true } } } },
    ]);
  });
});

describe("Worker 页：新增表单只在明确要求时打开", () => {
  it("进入 Worker 页不会自动打开新增表单", async () => {
    const overview = fakeOverview({ workers: [], pool: { ready: 0, total: 0, health: "empty" } });
    vi.stubGlobal(
      "fetch",
      vi.fn((path: string) => {
        if (path === "/api/overview") return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(overview) });
        return new Promise(() => {});
      }),
    );
    window.location.hash = "#workers";
    render(<App />);
    await screen.findAllByRole("button", { name: "新增 Worker" });
    expect(screen.queryByRole("form", { name: "新增 Worker" })).not.toBeInTheDocument();
  });
});

describe("出口探测归 App：离开 Worker 页不中断，侧栏显示进度", () => {
  it("切到别的页面后探测继续，侧栏有任务指示；回到 Worker 页仍能看到本轮结果", async () => {
    const user = userEvent.setup();
    const pending: Pending[] = [];
    const overview = withWorkers([worker("a"), worker("b")]);
    vi.stubGlobal(
      "fetch",
      vi.fn((path: string, init?: RequestInit) => {
        if (path === "/api/overview") return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(overview) });
        if (path === "/api/probe") return new Promise((resolve) => pending.push({ body: String(init?.body), resolve }));
        return new Promise(() => {});
      }),
    );
    window.location.hash = "#workers";
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "探测在用出口" }));
    await waitFor(() => expect(pending).toHaveLength(1));

    await user.click(screen.getByRole("link", { name: "模型" }));
    const task = await screen.findByRole("status", { name: "探测出口 0/2" });
    expect(task).toHaveAttribute("href", "#workers");

    const answer = (id: string) =>
      pending.shift()!.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ ok: true, changed: true, results: [{ proxyId: id, ok: false, failureKind: "timeout", reason: "回显服务超时" }] }),
      });
    answer("p-a");
    await waitFor(() => expect(pending).toHaveLength(1));
    answer("p-b");
    await waitFor(() => expect(screen.queryByRole("status", { name: /探测出口/ })).not.toBeInTheDocument());

    await user.click(screen.getByRole("link", { name: "Worker" }));
    expect(await screen.findByText(/本轮探测了 2\/2 个出口/)).toBeInTheDocument();
  });
});

function stats(over: Partial<StatsView> = {}): StatsView {
  return StatsViewSchema.parse({
    sinceDay: "2026-09-01",
    requests: 2,
    attempts: 2,
    models: [
      {
        model: "fake-free-model",
        inputTokens: 1000,
        outputTokens: 50,
        cacheReadTokens: 400,
        cacheWriteTokens: 0,
        requestsWithUsage: 2,
        requestsWithoutUsage: 0,
        requestsDroppedUsage: 0,
      },
    ],
    workers: [],
    rates: { cacheHitRate: 0.4, usageCoverage: 1, droppedUsageCount: 0 },
    rejections: { not_free: 4, model_missing: 1 },
    rejectedModels: [
      { reason: "not_free", model: "fake-paid-model", count: 4 },
      { reason: "model_missing", model: UNKNOWN_MODEL, count: 1 },
    ],
    daily: { byModel: [], byWorker: [] },
    ...over,
  });
}

describe("用量页", () => {
  it("网关拒绝列出被拒的模型名，占位符显示成人话", () => {
    render(<UsagePage data={stats()} days="30" onDays={() => {}} />);
    const table = screen.getByRole("region", { name: "网关拒绝明细" });
    const paid = within(table).getByText("fake-paid-model").closest("tr")!;
    expect(within(paid).getByText("不是免费模型")).toBeInTheDocument();
    expect(within(paid).getByText("4")).toBeInTheDocument();
    expect(within(table).getByText("未提供或名称不合法")).toBeInTheDocument();
    expect(within(table).queryByText(UNKNOWN_MODEL)).not.toBeInTheDocument();
  });

  it("合计 = 输入 + 输出；缓存读是输入的一部分，不再加一遍", () => {
    render(<UsagePage data={stats()} days="30" onDays={() => {}} />);
    const row = screen.getByText("fake-free-model").closest("tr")!;
    expect(within(row).getByText("1.1k")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "其中缓存读" })).toBeInTheDocument();
  });
});

describe("快速开始：请求到过网关后不再轮询统计", () => {
  it("看到请求后验证步骤打勾，之后不再拉 /api/stats", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((path: string) => {
        calls.push(path);
        if (path === "/api/overview") return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(fakeOverview()) });
        if (path.startsWith("/api/stats")) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(stats({ requests: 3 })) });
        return new Promise(() => {});
      }),
    );
    window.location.hash = "#start";
    render(<App />);
    await waitFor(() => expect(document.querySelector('[data-step="verify"]')).toHaveAttribute("data-done", ""));
    const before = calls.filter((p) => p.startsWith("/api/stats")).length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(35_000);
    });
    expect(calls.filter((p) => p.startsWith("/api/stats")).length).toBe(before);
    expect(document.querySelector('[data-step="verify"]')).toHaveAttribute("data-done", "");
  });
});

describe("Worker 详情的用量口径", () => {
  it("尝试计数标为累计，token 标出实际起始日：两者口径不同，不能写成同一个时间范围", async () => {
    const { WorkerDetail } = await import("../../src/admin/components/WorkerDetail.tsx");
    const data = stats({
      workers: [{ workerId: "a", attempts: 5000, successes: 4990, failures: 10, lastUsedAt: null, lastStatus: 200 }],
      daily: { byModel: [], byWorker: [{ day: "2026-09-20", key: "a", inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, requests: 1 }] },
    });
    render(<WorkerDetail worker={worker("a")} shared={false} stats={data} onClose={() => {}} onEdit={() => {}} />);
    expect(screen.getByText("上游尝试（累计）")).toBeInTheDocument();
    expect(screen.getByText("token（2026-09-01 起）")).toBeInTheDocument();
    expect(screen.queryByText(/当前时间范围/)).not.toBeInTheDocument();
  });
});
