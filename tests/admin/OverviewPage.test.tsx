import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { OverviewPage, attentionItems, workerStatus } from "../../src/admin/pages/OverviewPage.tsx";
import { WorkersPage } from "../../src/admin/pages/WorkersPage.tsx";
import { parseHash } from "../../src/admin/lib/router.ts";
import type { Overview, WorkerView } from "../../src/shared/contract.ts";
import { fakeOverview } from "./App.test.tsx";
import { ROW_HEIGHT } from "../../src/admin/components/DataTable.tsx";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/*
 * Overview 页的组件契约。
 *
 * 用 Testing Library 表达，不做 HTML 字符串断言 —— 字符串断言
 * 正是字符串断言，无法迁移，其**契约意图**在这里重新表达。
 */

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

function withWorkers(workers: WorkerView[], extra: Partial<Overview> = {}): Overview {
  const inPool = workers.filter((w) => w.inPool);
  return fakeOverview({
    workers,
    pool: {
      ready: inPool.filter((w) => w.ready).length,
      total: inPool.length,
      health: inPool.length === 0 ? "empty" : inPool.every((w) => w.ready) ? "healthy" : "degraded",
    },
    ...extra,
  });
}

/* ================================================================== *
 * 「为什么没在用我这个账号」
 * ================================================================== */

describe("Worker 状态把三个事实分开", () => {
  it("停用 / 没 key / 冷却 / 就绪 各是不同的一句话", () => {
    /*
     * 这四种的下一步完全不同：去启用它 / 去填 key / 等 / 无事。
     * 合成「不可用」的话用户仍然不知道原因。
     */
    expect(workerStatus(worker({ enabled: false })).label).toBe("已停用");
    expect(
      workerStatus(worker({ apiKey: { present: false, fingerprint: null }, inPool: false })).label,
    ).toBe("缺少 API key");
    expect(workerStatus(worker({ ready: false, cooldownRemainingMs: 900_000, lastFailure: "rate_limit" })).label)
      .toContain("冷却中");
    expect(workerStatus(worker()).label).toBe("就绪");
  });

  it("冷却标签带剩余时间与失败类别 —— 那是「为什么」的答案", () => {
    const status = workerStatus(
      worker({ ready: false, cooldownRemainingMs: 900_000, lastFailure: "rate_limit" }),
    );
    expect(status.label).toContain("15分钟");
    expect(status.label).toContain("rate_limit");
  });

  it("四种状态的色调各不相同,且都不是 info", () => {
    const tones = [
      workerStatus(worker({ enabled: false })).tone,
      workerStatus(worker({ apiKey: { present: false, fingerprint: null } })).tone,
      workerStatus(worker({ ready: false })).tone,
      workerStatus(worker()).tone,
    ];
    expect(new Set(tones).size).toBe(4);
    expect(tones).not.toContain("info");
  });
});

/* ================================================================== *
 * 状态绝不只靠颜色
 * ================================================================== */

describe("状态必须同时有图标与文字", () => {
  it("每个状态指示器都带 aria-hidden 的图标 + 可读文字", () => {
    const { container } = render(<OverviewPage data={withWorkers([worker()])} />);

    const indicators = [...container.querySelectorAll("[data-tone]")];
    expect(indicators.length).toBeGreaterThan(0);

    /*
     * 六个语义色里 accent-fg ↔ error 的色相只差约 14°，二色性模拟下四个状态
     * 会塌缩到 ≤1.28 的可分辨度。所以颜色之外必须始终有字形与文字两条通道。
     */
    for (const el of indicators) {
      expect(el.querySelector('[aria-hidden="true"]')).not.toBeNull();
      expect(el.textContent?.trim()).not.toBe("");
    }
  });
});

/** Worker 页（Worker 表、出口列、共用标记现在都在这里）。 */
function Workers({ data, view = "#workers" }: { data: Overview; view?: string }) {
  return <WorkersPage data={data} view={parseHash(view)} navigate={() => {}} />;
}

/* ================================================================== *
 * 出口隔离（Worker 页）
 * ================================================================== */

const SHARED = {
  groups: [{ egressIp: "198.51.100.1", workerIds: ["w1", "w2"], proxyIds: ["p1", "p2"] }],
  unknownWorkerIds: [],
  sharedGroups: [{ egressIp: "198.51.100.1", workerIds: ["w1", "w2"], proxyIds: ["p1", "p2"] }],
  isolated: false,
};

describe("出口隔离", () => {
  it("共用出口标在对应 Worker 的行上，页头说出有几组", () => {
    const data = withWorkers([worker({ id: "w1" }), worker({ id: "w2" })], { isolation: SHARED });
    render(<Workers data={data} />);
    expect(screen.getByText(/1 组共用出口/)).toBeInTheDocument();
    for (const id of ["w1", "w2"]) {
      const row = screen.getByText(id).closest("tr")!;
      expect(within(row).getByText("共用")).toBeInTheDocument();
    }
  });

  it("「共用出口」筛选只留下共用的 Worker，未探测的不算共用", () => {
    const data = withWorkers([worker({ id: "w1" }), worker({ id: "w2" }), worker({ id: "w3", egressIp: null })], {
      isolation: { ...SHARED, unknownWorkerIds: ["w3"] },
    });
    render(<Workers data={data} view="#workers?status=shared" />);
    expect(screen.getByText("w1")).toBeInTheDocument();
    expect(screen.getByText("w2")).toBeInTheDocument();
    expect(screen.queryByText("w3")).not.toBeInTheDocument();
  });

  it("未探测的 Worker 标「未探测」，不显示成有出口", () => {
    const data = withWorkers([worker({ egressIp: null })], {
      isolation: { groups: [], unknownWorkerIds: ["w1"], sharedGroups: [], isolated: false },
    });
    render(<Workers data={data} />);
    const row = screen.getByText("w1").closest("tr")!;
    expect(within(row).getByText("未探测")).toBeInTheDocument();
    expect(within(row).queryByText("共用")).not.toBeInTheDocument();
  });
});

/* ================================================================== *
 * 凭证不显示（Worker 页）
 * ================================================================== */

describe("界面只显示凭证指纹", () => {
  it("显示 8 位指纹,不显示完整值", () => {
    render(<Workers data={withWorkers([worker()])} />);
    expect(screen.getAllByText("abcd1234").length).toBeGreaterThan(0);
  });

  it("未配置 key 的 Worker 明确显示未配置", () => {
    render(<Workers data={withWorkers([worker({ apiKey: { present: false, fingerprint: null }, inPool: false })])} />);
    expect(screen.getByText("未配置")).toBeInTheDocument();
  });
});

/* ================================================================== *
 * 概览 = 分诊台
 * ================================================================== */

describe("概览：需要处理", () => {
  const ids = (data: Overview) => attentionItems(data, { status: "loading" }, null).map((i) => i.id);

  it("没有 Worker 时第一条就是它，并给出去新建的按钮；不提 setup", () => {
    render(<OverviewPage data={withWorkers([])} />);
    const item = screen.getByText(/还没有 Worker，客户端请求会得到 503/).closest("li")!;
    expect(within(item).getByRole("link", { name: "新建 Worker" })).toHaveAttribute("href", "#workers");
    expect(screen.queryByText(/npm run setup/)).not.toBeInTheDocument();
  });

  it("目录拉不到显示「—」并列为 error；免费集为空是 warn，两者分开", () => {
    render(<OverviewPage data={withWorkers([worker()], { catalog: { slots: [], freeCount: null } })} />);
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.getByText("目录未拉到")).toBeInTheDocument();
    expect(ids(withWorkers([worker()], { catalog: { slots: [], freeCount: null } }))).toContain("catalog");
    expect(ids(withWorkers([worker()], { catalog: { slots: [], freeCount: 0 } }))).toContain("catalog-empty");
  });

  it("共用出口、缺 key、冷却、未探测、opencode 未指向、统计写失败、近期拒绝各成一条，按严重度排", () => {
    const data = withWorkers(
      [
        worker({ id: "w1" }),
        worker({ id: "w2" }),
        worker({ id: "w3", kind: "authenticated", apiKey: { present: false, fingerprint: null }, inPool: false }),
        worker({ id: "w4", ready: false, cooldownRemainingMs: 1000 }),
      ],
      {
        isolation: { ...SHARED, unknownWorkerIds: ["w4"] },
        catalog: { slots: [], freeCount: 3 },
        health: { ok: true, version: "t", uptimeSeconds: 1, pid: 1, storeWriteFailures: 7 },
      },
    );
    const opencode = {
      status: "ready" as const,
      data: { path: "opencode.json", exists: true, detectedVersion: null, shape: "v2" as const, pointsToGateway: false, unwritableReason: null },
    };
    const recent = { rejections: { not_free: 2 } } as unknown as Parameters<typeof attentionItems>[2];
    const items = attentionItems(data, opencode, recent);
    expect(items.map((i) => i.id)).toEqual(["shared", "no-key", "opencode", "cooling", "store", "rejected", "unprobed"]);
    expect(items.find((i) => i.id === "shared")!.action.href).toBe("#workers?status=shared");
  });

  it("没有要处理的事时说一切正常，且统计写失败为 0 不列出", () => {
    const data = withWorkers([worker()], { catalog: { slots: [], freeCount: 3 }, isolation: { groups: [], unknownWorkerIds: [], sharedGroups: [], isolated: true } });
    render(<OverviewPage data={data} />);
    expect(screen.getByText("一切正常，没有需要处理的事")).toBeInTheDocument();
    expect(screen.queryByText(/统计写失败/)).not.toBeInTheDocument();
  });

  it("概览不再有 Worker 表与探测按钮（它们在 Worker 页）", () => {
    render(<OverviewPage data={withWorkers([worker()])} />);
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /探测/ })).not.toBeInTheDocument();
  });
});

/* ================================================================== *
 * 无障碍
 * ================================================================== */

describe("无障碍与密度", () => {
  it("表格行高 36px，且与 tokens.css 的 --spacing-row 一致", () => {
    const { container } = render(<Workers data={withWorkers([worker()])} />);
    const row = container.querySelector("tr[data-row]");
    expect(row).not.toBeNull();
    expect(ROW_HEIGHT).toBe(36);
    expect((row as HTMLElement).style.height).toBe(`${ROW_HEIGHT}px`);
    const tokens = readFileSync(join(process.cwd(), "src/admin/styles/tokens.css"), "utf8");
    expect(/--spacing-row:\s*(\d+)px/.exec(tokens)?.[1]).toBe(String(ROW_HEIGHT));
  });

  it("「需要处理」的去处是链接，命中区 ≥44px", () => {
    render(<OverviewPage data={withWorkers([])} />);
    const link = screen.getByRole("link", { name: "新建 Worker" });
    expect(link.className).toContain("min-h-[44px]");
  });
});
