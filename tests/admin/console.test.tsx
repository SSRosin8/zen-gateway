import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../../src/admin/App.tsx";
import { Shell } from "../../src/admin/components/Shell.tsx";
import { StartPage, onboardingProgress } from "../../src/admin/pages/StartPage.tsx";
import { DiagnosticsView } from "../../src/admin/pages/DiagnosticsPage.tsx";
import { PAGES, PAGE_LABEL } from "../../src/admin/lib/router.ts";
import { OpenCodeViewSchema, OverviewSchema, type OpenCodeView, type Overview } from "../../src/shared/contract.ts";
import type { FetchState } from "../../src/admin/lib/api.ts";
import { fakeOverview } from "./App.test.tsx";

/*
 * 控制台外壳与快速开始、诊断页：侧栏导航、窄屏抽屉、首启落点、步骤实时判据、
 * 诊断分层与 409。全部用语义查询表达。
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.location.hash = "";
});

const noop = () => {};

function opencodeView(over: Partial<OpenCodeView> = {}): OpenCodeView {
  return OpenCodeViewSchema.parse({
    path: "opencode.json",
    exists: false,
    detectedVersion: "2.0.12",
    shape: null,
    pointsToGateway: false,
    unwritableReason: null,
    ...over,
  });
}

const ready = <T,>(data: T): FetchState<T> => ({ status: "ready", data });

/** 已完成全部必需步骤的 overview。 */
function doneOverview(): Overview {
  return fakeOverview({
    catalog: { slots: [], freeCount: 5 },
    pool: { ready: 1, total: 1, health: "healthy" },
    proxies: { total: 2, enabled: 2, withEgressIp: 0 },
  });
}

/** 按路径分派的假 fetch；未列出的路径永远挂起（不影响断言的端点）。 */
function routeFetch(routes: Record<string, unknown>) {
  const fn = vi.fn((path: string) => {
    const key = Object.keys(routes).find((k) => path === k);
    if (key === undefined) return new Promise(() => {});
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(routes[key]) });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("fixture 通过真实契约", () => {
  it("fakeOverview 与 opencodeView 都能被 schema 接受", () => {
    // 纪律 #12：fixture 不过契约的话，下面的 App 用例测到的是「响应异常」回退路径。
    expect(OverviewSchema.safeParse(fakeOverview()).success).toBe(true);
    expect(OverviewSchema.safeParse(doneOverview()).success).toBe(true);
    expect(OpenCodeViewSchema.safeParse(opencodeView()).success).toBe(true);
  });
});

/* ================================================================== *
 * 侧栏
 * ================================================================== */

describe("侧栏导航", () => {
  it("每页一个真实链接，当前页 aria-current，顺序与 PAGES 一致", () => {
    render(
      <Shell current="diagnostics" badge={null} version="9.9.9">
        <p>正文</p>
      </Shell>,
    );
    const nav = screen.getByRole("navigation", { name: "主导航" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((l) => l.getAttribute("href"))).toEqual(PAGES.map((p) => `#${p}`));
    expect(links.map((l) => l.textContent)).toEqual(PAGES.map((p) => PAGE_LABEL[p]));
    const current = within(nav).getByRole("link", { current: "page" });
    expect(current).toHaveAttribute("href", "#diagnostics");
    // 只有一个当前项。
    expect(links.filter((l) => l.getAttribute("aria-current") === "page")).toHaveLength(1);
  });

  it("首启未完成时快速开始带进度徽标，完成后不显示", () => {
    const { rerender } = render(
      <Shell current="overview" badge="2/4" version={null}>
        <p />
      </Shell>,
    );
    const start = screen.getByRole("link", { name: /快速开始/ });
    expect(within(start).getByLabelText("首启进度 2/4")).toHaveTextContent("2/4");
    rerender(
      <Shell current="overview" badge={null} version={null}>
        <p />
      </Shell>,
    );
    expect(screen.queryByLabelText(/首启进度/)).not.toBeInTheDocument();
  });

  it("窄屏菜单：按钮控制抽屉，打开后焦点进导航，Esc 关闭并还焦点，点导航项收起", async () => {
    const user = userEvent.setup();
    render(
      <Shell current="overview" badge={null} version={null}>
        <p />
      </Shell>,
    );
    const toggle = screen.getByRole("button", { name: "菜单" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    const drawer = document.getElementById(toggle.getAttribute("aria-controls")!)!;
    expect(drawer).not.toBeNull();
    expect(drawer.hasAttribute("data-open")).toBe(false);

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(drawer.hasAttribute("data-open")).toBe(true);
    expect(within(drawer).getAllByRole("link")[0]).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveFocus();

    await user.click(toggle);
    await user.click(within(drawer).getByRole("link", { name: "诊断" }));
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("配色按钮在侧栏里，且没有「配色」文字标签", () => {
    render(
      <Shell current="overview" badge={null} version={null}>
        <p />
      </Shell>,
    );
    const aside = screen.getByRole("navigation", { name: "主导航" }).closest("aside")!;
    expect(within(aside).getByRole("button", { name: /^配色：/ })).toBeInTheDocument();
    expect(within(aside).queryByText("配色")).not.toBeInTheDocument();
  });

  it("侧栏可收起与展开：收起后只剩图标，链接名称不变，偏好刷新后保留", async () => {
    window.localStorage.clear();
    const user = userEvent.setup();
    const { unmount } = render(
      <Shell current="overview" badge="1/4" version="9.9.9">
        <p />
      </Shell>,
    );
    const aside = screen.getByRole("navigation", { name: "主导航" }).closest("aside")!;
    const link = () => within(aside).getByRole("link", { name: "概览" });
    expect(aside.hasAttribute("data-collapsed")).toBe(false);
    expect(within(link()).getByText("概览")).toBeInTheDocument();

    await user.click(within(aside).getByRole("button", { name: "收起侧栏" }));
    expect(aside.hasAttribute("data-collapsed")).toBe(true);
    // 文字不再渲染，但可访问名称与当前页标记仍在。
    expect(within(link()).queryByText("概览")).not.toBeInTheDocument();
    expect(link()).toHaveAttribute("aria-current", "page");
    expect(link()).toHaveAttribute("title", "概览");
    // 首启进度退成圆点，仍可被读屏读到。
    expect(within(aside).getByLabelText("首启进度 1/4")).toBeInTheDocument();
    unmount();

    render(
      <Shell current="overview" badge={null} version={null}>
        <p />
      </Shell>,
    );
    const again = screen.getByRole("navigation", { name: "主导航" }).closest("aside")!;
    expect(again.hasAttribute("data-collapsed")).toBe(true);
    await user.click(within(again).getByRole("button", { name: "展开侧栏" }));
    expect(again.hasAttribute("data-collapsed")).toBe(false);
    expect(window.localStorage.getItem("zg-sidebar")).toBeNull();
  });
});

/* ================================================================== *
 * 首启落点
 * ================================================================== */

describe("首次打开的落点", () => {
  it("首启未完成且没有 hash 时落到快速开始", async () => {
    routeFetch({ "/api/overview": fakeOverview(), "/api/opencode": opencodeView() });
    render(<App />);
    await waitFor(() => expect(window.location.hash).toBe("#start"));
    expect(await screen.findByRole("heading", { name: "快速开始" })).toBeInTheDocument();
    expect(screen.getByRole("link", { current: "page" })).toHaveTextContent("快速开始");
  });

  it("首启已完成时不跳转，停在概览", async () => {
    routeFetch({ "/api/overview": doneOverview(), "/api/opencode": opencodeView({ exists: true, shape: "v2", pointsToGateway: true }) });
    render(<App />);
    await screen.findByRole("heading", { name: "概览" });
    // 等两个端点都到齐后再确认没有跳：判定依赖 OpenCode 状态。
    await waitFor(() => expect(screen.queryByLabelText(/首启进度/)).not.toBeInTheDocument());
    expect(window.location.hash).toBe("");
  });

  it("URL 已指定页面时尊重 URL，即使首启未完成", async () => {
    routeFetch({ "/api/overview": fakeOverview(), "/api/opencode": opencodeView() });
    window.location.hash = "#usage";
    render(<App />);
    await screen.findByLabelText(/首启进度/);
    expect(window.location.hash).toBe("#usage");
  });

  it("等待 OpenCode 状态期间用户点了别的页，状态到达后不再拉回快速开始", async () => {
    let releaseOpencode: (v: unknown) => void = () => {};
    const pending = new Promise((r) => (releaseOpencode = r));
    vi.stubGlobal(
      "fetch",
      vi.fn((path: string) => {
        if (path === "/api/overview") return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(fakeOverview()) });
        if (path === "/api/opencode") return pending.then(() => ({ ok: true, status: 200, json: () => Promise.resolve(opencodeView()) }));
        return new Promise(() => {});
      }),
    );
    render(<App />);
    await screen.findByRole("heading", { name: "概览" });
    window.location.hash = "#usage";
    releaseOpencode(null);
    await screen.findByLabelText(/首启进度/);
    expect(window.location.hash).toBe("#usage");
  });

  it("OpenCode 状态还没到时不下结论", async () => {
    // 只有 overview 回来；opencode 挂起 → 判据不全，不能跳转。
    routeFetch({ "/api/overview": doneOverview() });
    render(<App />);
    await screen.findByRole("heading", { name: "概览" });
    await new Promise((r) => setTimeout(r, 50));
    expect(window.location.hash).toBe("");
  });
});

/* ================================================================== *
 * 快速开始
 * ================================================================== */

describe("快速开始的步骤判据", () => {
  it("全空时四步都待完成", () => {
    const { container } = render(
      <StartPage data={fakeOverview()} opencode={ready(opencodeView())} refresh={noop} />,
    );
    const steps = [...container.querySelectorAll("[data-step]")].map((el) => el.getAttribute("data-step"));
    expect(steps).toEqual(["catalog", "clash", "workers", "opencode", "verify"]);
    expect(container.querySelectorAll("[data-done]")).toHaveLength(0);
    expect(screen.getAllByText("待完成")).toHaveLength(4);
  });

  it("每一步从各自的判据打勾", () => {
    const cases: Array<[string, Overview, FetchState<OpenCodeView>]> = [
      ["catalog", fakeOverview({ catalog: { slots: [], freeCount: 3 } }), ready(opencodeView())],
      ["clash", fakeOverview({ proxies: { total: 1, enabled: 1, withEgressIp: 0 } }), ready(opencodeView())],
      ["workers", fakeOverview({ pool: { ready: 0, total: 1, health: "degraded" } }), ready(opencodeView())],
      ["opencode", fakeOverview(), ready(opencodeView({ exists: true, pointsToGateway: true, shape: "v2" }))],
    ];
    for (const [id, data, oc] of cases) {
      const { container, unmount } = render(
        <StartPage data={data} opencode={oc} refresh={noop} />,
      );
      const done = [...container.querySelectorAll("[data-done]")].map((el) => el.getAttribute("data-step"));
      expect(done, id).toEqual([id]);
      unmount();
    }
  });

  it("免费集为 0 与目录未拉到不算完成", () => {
    expect(onboardingProgress(fakeOverview({ catalog: { slots: [], freeCount: 0 } }), ready(opencodeView())).steps.catalog).toBe(false);
    expect(onboardingProgress(fakeOverview(), ready(opencodeView())).steps.catalog).toBe(false);
  });

  it("文件存在但未指向网关、或状态拿不到时 OpenCode 步骤不算完成", () => {
    const data = doneOverview();
    expect(onboardingProgress(data, ready(opencodeView({ exists: true, shape: "v2" }))).complete).toBe(false);
    expect(onboardingProgress(data, { status: "loading" }).complete).toBe(false);
    expect(onboardingProgress(data, { status: "offline" }).complete).toBe(false);
    expect(onboardingProgress(data, ready(opencodeView({ exists: true, pointsToGateway: true }))).complete).toBe(true);
  });

  it("Clash 是可选步骤：没有代理也能完成", () => {
    const data = fakeOverview({ catalog: { slots: [], freeCount: 5 }, pool: { ready: 1, total: 1, health: "healthy" } });
    const p = onboardingProgress(data, ready(opencodeView({ exists: true, pointsToGateway: true })));
    expect(p.steps.clash).toBe(false);
    expect(p.complete).toBe(true);
  });

  it("验证命令可复制，并说明从项目根目录运行", async () => {
    const user = userEvent.setup();
    render(<StartPage data={fakeOverview()} opencode={ready(opencodeView())} refresh={noop} />);
    await user.click(screen.getByRole("button", { name: "复制命令" }));
    expect(await navigator.clipboard.readText()).toBe('opencode run --model opencode/big-pickle "Reply with exactly: OK"');
    expect(screen.getByText(/网关项目根目录/, { selector: "strong" })).toBeInTheDocument();
  });

  it("只差 OpenCode 配置时写入按钮是唯一主操作；否则没有主按钮", () => {
    const primaries = (c: HTMLElement) => [...c.querySelectorAll("button")].filter((b) => b.className.includes("bg-accent-fill"));
    const almost = fakeOverview({ catalog: { slots: [], freeCount: 5 }, pool: { ready: 1, total: 1, health: "healthy" } });
    const a = render(<StartPage data={almost} opencode={ready(opencodeView())} refresh={noop} />);
    expect(primaries(a.container).map((b) => b.textContent)).toEqual(["写入 opencode.json"]);
    a.unmount();
    const b = render(<StartPage data={fakeOverview()} opencode={ready(opencodeView())} refresh={noop} />);
    expect(primaries(b.container)).toHaveLength(0);
  });

  it("有代理时给出从 Clash 节点批量导入的入口，在本页打开对话框", async () => {
    const user = userEvent.setup();
    render(
      <StartPage
        data={fakeOverview({ proxies: { total: 3, enabled: 3, withEgressIp: 0 } })}
        opencode={ready(opencodeView())}
        refresh={noop}
      />,
    );
    await user.click(screen.getByRole("button", { name: "从 Clash 节点导入匿名 Worker" }));
    expect(screen.getByRole("dialog", { name: "从 Clash 节点导入匿名 Worker" })).toBeInTheDocument();
  });

  it("新增 Worker 在本页展开编辑器，保存后收起并报告，不跳到 Worker 页", async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((path: string, init?: { method?: string; body?: string }) => {
        if (path === "/api/config" && init?.method === "PATCH") bodies.push(JSON.parse(init.body ?? "null"));
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, changed: true }) });
      }),
    );
    const refresh = vi.fn();
    window.location.hash = "#start";
    render(<StartPage data={fakeOverview()} opencode={ready(opencodeView())} refresh={refresh} />);
    await user.click(screen.getByRole("button", { name: "新增 Worker" }));
    const form = screen.getByRole("form", { name: "新增 Worker" });
    await user.click(within(form).getByRole("button", { name: /保存|新增/ }));
    expect(await screen.findByText("已新增，立即生效")).toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "新增 Worker" })).not.toBeInTheDocument();
    expect(bodies).toHaveLength(1);
    expect(refresh).toHaveBeenCalled();
    expect(window.location.hash).toBe("#start");
  });
});

/* ================================================================== *
 * 诊断
 * ================================================================== */

describe("诊断页", () => {
  const layers = {
    layers: [
      { id: "config", title: "配置", status: "pass", summary: "配置有效", details: [] },
      { id: "store", title: "存储", status: "warn", summary: "统计写失败 2 次", details: ["磁盘满"], nextStep: "清理磁盘" },
      { id: "clash", title: "Clash", status: "fail", summary: "控制面不可达", details: ["http://127.0.0.1:9097"], nextStep: "启动 Clash" },
      { id: "catalog", title: "目录", status: "skip", summary: "前一层失败", details: [] },
    ],
  } as const;

  it("逐层显示状态、详情与下一步，并指出第一个失败层", () => {
    const { container } = render(<DiagnosticsView data={structuredClone(layers) as never} refresh={noop} />);
    expect(screen.getByText("第一个失败层：Clash")).toBeInTheDocument();
    const clash = container.querySelector('[data-layer="clash"]') as HTMLElement;
    expect(within(clash).getByText("失败")).toBeInTheDocument();
    expect(within(clash).getByText("控制面不可达")).toBeInTheDocument();
    expect(within(clash).getByText("启动 Clash")).toBeInTheDocument();
    const skip = container.querySelector('[data-layer="catalog"]') as HTMLElement;
    expect(within(skip).getByText("跳过")).toBeInTheDocument();
    expect(container.querySelectorAll("[data-layer]")).toHaveLength(4);
  });

  it("深度出口测试先确认；409 时说明批量探测占用", async () => {
    const user = userEvent.setup();
    const posts: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((path: string, init?: { method?: string }) => {
        if (init?.method === "POST") posts.push(path);
        return Promise.resolve({
          ok: false,
          status: 409,
          json: () => Promise.resolve({ error: { type: "conflict", message: "批量探测进行中" } }),
        });
      }),
    );
    render(<DiagnosticsView data={structuredClone(layers) as never} refresh={noop} />);
    await user.click(screen.getByRole("button", { name: "深度出口测试" }));
    const dialog = screen.getByRole("dialog", { name: "开始深度出口测试" });
    expect(dialog.textContent).toContain("切换 Clash 分组");
    expect(within(dialog).getByRole("button", { name: "取消" })).toHaveFocus();
    expect(posts).toHaveLength(0);

    await user.click(within(dialog).getByRole("button", { name: "开始测试" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("批量探测正在运行");
    expect(posts).toEqual(["/api/diagnostics/deep"]);
  });

  it("其他错误原样显示，不套用 409 的说明", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: { type: "internal_error", message: "出口服务不可用" } }) }),
      ),
    );
    render(<DiagnosticsView data={structuredClone(layers) as never} refresh={noop} />);
    await user.click(screen.getByRole("button", { name: "深度出口测试" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "开始测试" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("出口服务不可用");
    expect(alert).not.toHaveTextContent("批量探测正在运行");
  });
});
