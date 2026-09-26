import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { App } from "../../src/admin/App.tsx";
import type { Overview } from "../../src/shared/contract.ts";

/*
 * 首次启动这一眼最容易误导人:Worker 数为 0 时若走 `ready === total`,
 * 界面会显示「全部就绪」,而实际什么都没配。这里守的就是这条路径
 * 在真实渲染下的结果,不只是 poolHealth 的返回值。
 *
 * App 读 `/api/overview`(一个聚合端点):这一页每个数字都必须来自
 * **同一时刻**的状态,分多个请求拿会让「3 个 Worker / 2 个就绪 / 隔离成立」
 * 描述三个不同瞬间的系统。
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 一份最小但**合法**的 Overview —— 必须过 `OverviewSchema`,否则测的是回退路径。 */
export function fakeOverview(overrides: Partial<Overview> = {}): Overview {
  return {
    health: { ok: true, version: "9.9.9", uptimeSeconds: 42, pid: 1234, storeWriteFailures: 0 },
    gateway: {
      port: 9877,
      baseUrl: "https://example.invalid/zen/v1",
      relayToken: { present: true, fingerprint: "abcd1234" },
      maxAttempts: 3,
    },
    pool: { ready: 0, total: 0, health: "empty" },
    workers: [],
    isolation: { groups: [], unknownWorkerIds: [], sharedGroups: [], isolated: false },
    catalog: { slots: [], freeCount: null },
    clash: { enabled: false, activeBridgeId: null, bridges: [] },
    proxies: { total: 0, enabled: 0, withEgressIp: 0 },
    ...overrides,
  };
}

function stubOverview(body: unknown, ok = true) {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve({ ok, status: ok ? 200 : 500, json: () => Promise.resolve(body) })),
  );
}

describe("App 首次启动", () => {
  it("空 Worker 池显示「尚未配置」而非「全部就绪」", async () => {
    stubOverview(fakeOverview());
    render(<App />);

    // 等到真正拿到数据（向导出现），而不是停在加载态上断言。
    await waitFor(() => {
      expect(screen.getByText("先把它跑起来")).toBeInTheDocument();
    });
    expect(screen.getAllByText("尚未配置 Worker").length).toBeGreaterThan(0);
    expect(screen.queryByText("全部就绪")).not.toBeInTheDocument();
  });

  it("空池用中性色调,不用成功色", async () => {
    stubOverview(fakeOverview());
    const { container } = render(<App />);

    await waitFor(() => {
      expect(container.querySelector("[data-tone]")).not.toBeNull();
    });

    /*
     * 「尚未配置 Worker」这句在页面上出现**两次**（指标卡的 hint 与状态指示器），
     * 所以按文字取会拿到两个。这里要验的是**状态指示器**的色调，
     * 所以按 `[data-tone]` 取 —— 那是 StatusIndicator 独有的标记。
     */
    const tones = [...container.querySelectorAll("[data-tone]")].map((el) =>
      el.getAttribute("data-tone"),
    );
    // 空池那一条必须是中性；整页不得出现成功色（否则首启第一眼就是绿的）。
    expect(tones).toContain("neutral");
    expect(tones).not.toContain("success");
  });

  it("请求在途时不替 Worker 池下结论", () => {
    /*
     * 永不 resolve —— 首次加载还没有任何数字。此时既不能显示成功态，
     * 也不能说「尚未配置」：一个装好的系统会因此看起来需要重新配置。
     */
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    render(<App />);

    expect(screen.getByText("检测中")).toBeInTheDocument();
    expect(screen.queryByText("全部就绪")).not.toBeInTheDocument();
    expect(screen.queryByText("尚未配置 Worker")).not.toBeInTheDocument();
    expect(screen.queryByText(/npm run setup/)).not.toBeInTheDocument();
  });

  it("接口不可达时显示未连接,不假装运行中", async () => {
    // `fetch` 对连接被拒抛 TypeError —— 那是「网关没在跑」的信号。
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))));
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText("未连接到网关服务")).toBeInTheDocument();
    });
    // 并且要给出下一步,而不只是报失败。
    expect(screen.getByText(/npm start/)).toBeInTheDocument();
  });

  it("契约不匹配与「没在跑」是两种不同的报错", async () => {
    /*
     * 这两种失败的下一步完全不同:前者是前后端版本不一致(`npm run build`),
     * 后者是网关没启动(`npm start`)。合成一句「加载失败」会让用户猜 ——
     * 与 doctor 分层同一个理由。
     */
    stubOverview({ health: { ok: true } }); // 缺大量必填字段
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText("响应异常")).toBeInTheDocument();
    });
    expect(screen.getByText(/契约不匹配/)).toBeInTheDocument();
    expect(screen.queryByText("未连接到网关服务")).not.toBeInTheDocument();
  });

  it("拿到数据后显示版本与运行时长", async () => {
    stubOverview(fakeOverview());
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(/v9\.9\.9/)).toBeInTheDocument();
    });
  });
});
