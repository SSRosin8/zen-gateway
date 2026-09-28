import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { App } from "../../src/admin/App.tsx";
import { WorkersPage } from "../../src/admin/pages/WorkersPage.tsx";
import { ProxyPage } from "../../src/admin/pages/ProxyPage.tsx";
import { UsagePage } from "../../src/admin/pages/UsagePage.tsx";
import { parseHash } from "../../src/admin/lib/router.ts";
import * as adminApi from "../../src/admin/lib/api.ts";
import type { ProxyList, ProxyView, StatsView, WorkerView } from "../../src/shared/contract.ts";
import { fakeOverview } from "./App.test.tsx";

/*
 * 界面打磨后的约束：截断可找回全文、首次加载有骨架且仍报文字状态、
 * 反馈出现在触发它的操作旁、表头吸顶、空单元格用词而不是符号。
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
    username: null,
    password: { present: false, fingerprint: null },
    usedBy: ["w1"],
    resolvable: true,
    unresolvableReason: null,
    ...overrides,
  };
}

function proxyList(proxies: ProxyView[]): ProxyList {
  return {
    proxies,
    clash: { enabled: false, selectionMode: "auto", activeBridgeId: null, bridges: [] },
    isolation: { groups: [], unknownWorkerIds: [], sharedGroups: [], isolated: false },
    subscriptions: [],
  };
}

function withWorkers(workers: WorkerView[]) {
  return fakeOverview({ workers, pool: { ready: workers.length, total: workers.length, health: "healthy" } });
}

const idleFetch = () => vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));

describe("截断的文字能找回全文", () => {
  it("每个 truncate 元素都带与全文一致的 title", () => {
    idleFetch();
    const longName = "一个非常长的节点名称 · 用来确认截断之后仍能在悬停时看到全部文字 · 0123456789";
    const { container } = render(
      <ProxyPage data={proxyList([proxy({ name: longName, usedBy: ["w1", "w2", "w3"] })])} view={parseHash("#proxy")} navigate={noop} />,
    );
    const truncated = [...container.querySelectorAll(".truncate")];
    // 输入集非空：节点名与「被引用」两处。
    expect(truncated.length).toBeGreaterThanOrEqual(2);
    for (const el of truncated) {
      expect(el.getAttribute("title"), el.textContent ?? "").toBe(el.textContent);
    }
    expect(screen.getByTitle(longName)).toBeInTheDocument();
  });

  it("源码里不再有裸写的 truncate 类 —— 一律经 Truncate 组件（它负责 title）", () => {
    const root = join(process.cwd(), "src/admin");
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith(".tsx") ? [join(dir, e.name)] : [],
      );
    const files = walk(root);
    expect(files.length).toBeGreaterThan(8);
    const offenders = files.filter((f) => {
      if (f.endsWith("Panel.tsx")) return false; // Truncate 自身的定义
      return /className=[^>]*\btruncate\b/.test(readFileSync(f, "utf8"));
    });
    expect(offenders).toEqual([]);
  });
});

describe("首次加载", () => {
  it("显示骨架，同时保留「检测中」文字；骨架对读屏隐藏", () => {
    idleFetch();
    const { container } = render(<App />);
    expect(screen.getByText("检测中")).toBeInTheDocument();
    const skeleton = container.querySelector('[data-skeleton="table"]');
    expect(skeleton).not.toBeNull();
    expect(skeleton).toHaveAttribute("aria-hidden", "true");
    // 未连接与响应异常不走骨架 —— 那两种状态要给出下一步，不是「等」。
    expect(screen.queryByText("未连接到网关服务")).not.toBeInTheDocument();
  });

  it("离线时不显示骨架", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))));
    const { container } = render(<App />);
    await screen.findByText("未连接到网关服务");
    expect(container.querySelector("[data-skeleton]")).toBeNull();
  });
});

describe("反馈出现在触发它的操作旁", () => {
  it("行内编辑保存失败：错误在编辑器里，不在列表上方", async () => {
    const user = userEvent.setup();
    vi.spyOn(adminApi, "patchConfig").mockRejectedValue(new Error("配置写入失败"));
    const { container } = render(
      <WorkersPage data={withWorkers([worker({ id: "w1" }), worker({ id: "w2" })])} view={parseHash("#workers")} navigate={noop} />,
    );
    const row = container.querySelector('tr[data-row="w2"]') as HTMLElement;
    await user.click(within(row).getByRole("button", { name: "编辑" }));
    const form = screen.getByRole("form", { name: "编辑 Worker w2" });
    await user.click(within(form).getByRole("button", { name: "保存" }));
    const alert = await screen.findByRole("alert");
    expect(form.contains(alert)).toBe(true);
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });

  it("编辑器打开时本视图仍只有一个主按钮（编辑器的保存）", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <WorkersPage data={withWorkers([worker()])} view={parseHash("#workers")} navigate={noop} />,
    );
    await user.click(screen.getByRole("button", { name: "新增 Worker" }));
    const primaries = [...container.querySelectorAll("button")].filter((b) => b.className.includes("bg-accent-fill"));
    expect(primaries.map((b) => b.textContent)).toEqual(["保存"]);
    // 收起入口仍在，只是退为描边按钮。
    expect(screen.getByRole("button", { name: "收起" })).toBeInTheDocument();
  });
});

describe("表格结构", () => {
  it("表头单元格吸顶、实色底，行内按钮是紧凑尺寸但 ≥24px", () => {
    const { container } = render(
      <WorkersPage data={withWorkers([worker()])} view={parseHash("#workers")} navigate={noop} />,
    );
    const headers = [...container.querySelectorAll("th")];
    expect(headers.length).toBeGreaterThan(3);
    for (const th of headers) {
      expect(th.className).toMatch(/\bsticky\b/);
      expect(th.className).toMatch(/\btop-0\b/);
      expect(th.className).toMatch(/\bbg-surface\b/);
      expect(th).toHaveAttribute("scope", "col");
    }
    const edit = within(container.querySelector("tr[data-row]") as HTMLElement).getByRole("button", { name: "编辑" });
    // min-h-8 = 32px：低于独立控件的 44px，高于 WCAG 2.2 AA 2.5.8 的 24px。
    expect(edit.className).toContain("min-h-8");
    expect(edit.className).not.toContain("min-h-[44px]");
  });
});

describe("空单元格用词，不用符号", () => {
  it("未被引用的代理写「未引用」", () => {
    idleFetch();
    render(<ProxyPage data={proxyList([proxy({ usedBy: [] })])} view={parseHash("#proxy")} navigate={noop} />);
    expect(screen.getByText("未引用")).toBeInTheDocument();
  });

  it("没有状态码的 Worker 写「无响应」；比值为 null 仍是「—」", () => {
    const data: StatsView = {
      sinceDay: null,
      requests: 1,
      attempts: 1,
      models: [],
      workers: [{ workerId: "w1", attempts: 1, successes: 0, failures: 1, lastUsedAt: 1, lastStatus: null }],
      rates: { cacheHitRate: null, usageCoverage: null, droppedUsageCount: 0 },
      rejections: {},
      daily: { byModel: [], byWorker: [] },
      rejectedModels: [],
    };
    render(<UsagePage data={data} days="all" onDays={noop} view={{ by: "worker", shape: "line", metric: "tokens" }} />);
    expect(screen.getByText("无响应")).toBeInTheDocument();
    // 指标卡的「—」是「还没有数据」的约定，与表格空单元格不同。
    expect(screen.getAllByText("—")).toHaveLength(2);
  });
});
