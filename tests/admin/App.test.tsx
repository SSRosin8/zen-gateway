import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { App } from "../../src/admin/App.tsx";

/*
 * 首次启动这一眼最容易误导人:Worker 数为 0 时若走 `ready === total`,
 * 界面会显示「全部就绪」,而实际什么都没配。这里守的就是这条路径
 * 在真实渲染下的结果,不只是 poolHealth 的返回值。
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("App 首次启动", () => {
  it("空 Worker 池显示「尚未配置」而非「全部就绪」", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    render(<App />);

    expect(screen.getByText("尚未配置 Worker")).toBeInTheDocument();
    expect(screen.queryByText("全部就绪")).not.toBeInTheDocument();
  });

  it("空池用中性色调,不用成功色", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    const { container } = render(<App />);

    const pool = screen.getByText("尚未配置 Worker").closest("[data-tone]");
    expect(pool).toHaveAttribute("data-tone", "neutral");
    expect(container.querySelector('[data-tone="success"]')).toBeNull();
  });

  it("健康接口不可达时显示未连接,不假装运行中", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("ECONNREFUSED"))));
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText("未连接到网关服务")).toBeInTheDocument();
    });
  });

  it("健康接口返回后显示版本", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              ok: true,
              version: "0.1.0",
              uptimeSeconds: 12,
              pid: 4242,
              storeWriteFailures: 0,
            }),
        }),
      ),
    );
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText("运行中 · v0.1.0")).toBeInTheDocument();
    });
  });

  it("HTTP 500 带 JSON 体时显示未连接,不当成正常响应", async () => {
    // 不检查 r.ok 的话,错误响应体会被送去 HealthSchema.parse。
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 500,
          json: () =>
            Promise.resolve({
              ok: true,
              version: "伪造",
              uptimeSeconds: 0,
              pid: 1,
              storeWriteFailures: 0,
            }),
        }),
      ),
    );
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText("未连接到网关服务")).toBeInTheDocument();
    });
    expect(screen.queryByText(/伪造/)).not.toBeInTheDocument();
  });
});
