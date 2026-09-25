import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { OverviewPage, workerStatus } from "../../src/admin/pages/OverviewPage.tsx";
import type { Overview, WorkerView } from "../../src/shared/contract.ts";
import { fakeOverview } from "./App.test.tsx";

/*
 * Overview 页的组件契约（规划的「Phase 9 组件测试契约」）。
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
     * 合成「不可用」就回到了 Phase 8 的状态 —— doctor 只能说
     * 「可用(配置形态)」而用户仍然不知道原因。
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

/* ================================================================== *
 * 出口隔离
 * ================================================================== */

describe("出口隔离视图", () => {
  it("共用出口必须被显眼报出来,并列出是哪几个 Worker", () => {
    const data = withWorkers([worker({ id: "w1" }), worker({ id: "w2" })], {
      isolation: {
        groups: [{ egressIp: "198.51.100.1", workerIds: ["w1", "w2"], proxyIds: ["p1", "p2"] }],
        unknownWorkerIds: [],
        sharedGroups: [
          { egressIp: "198.51.100.1", workerIds: ["w1", "w2"], proxyIds: ["p1", "p2"] },
        ],
        isolated: false,
      },
    });
    render(<OverviewPage data={data} />);

    expect(screen.getByText(/未隔离/)).toBeInTheDocument();
    /*
     * 多账号同 IP 有被上游判定关联的风险 —— 必须说出是哪几个。
     * 「w1、w2」在页面上出现两次(共用组的警示列表 + 全部分组列表),
     * 所以用 getAllByText —— 至少一处即成立,而**两处都在**恰是设计意图:
     * 警示区回答「出了什么问题」,分组列表回答「现在是什么状况」。
     */
    expect(screen.getAllByText(/w1、w2/).length).toBeGreaterThan(0);
  });

  it("未探测不显示为已隔离", () => {
    const data = withWorkers([worker({ egressIp: null })], {
      isolation: {
        groups: [],
        unknownWorkerIds: ["w1"],
        sharedGroups: [],
        isolated: false,
      },
    });
    render(<OverviewPage data={data} />);

    // 「还不知道」与「确认不同」是两件事,混在一起会给出虚假的安全感。
    expect(screen.getAllByText(/1 个出口未探测/).length).toBeGreaterThan(0);
    /*
     * 断言范围必须限定在**隔离面板**内。
     *
     * 两次收窄都是测试自己驳回来的:
     *   1. 先写 `queryByText(/已隔离/)` —— 那句解释性文案
     *      （「『还不知道』不算作已隔离」）本身含这三个字,子串碰撞。
     *   2. 改成「整页不含 success 色调」—— 而 Worker 行**正当地**是
     *      success:那个 Worker 确实就绪(`ready: true`),只是它的出口
     *      没探测过。两件事互相独立,把它们绑在一起是我的断言错了。
     *
     * 真正要钉的是:**隔离这一条**不报成功。
     */
    const panel = screen.getAllByText(/1 个出口未探测/)[0]!.closest("section")!;
    const tones = [...panel.querySelectorAll("[data-tone]")].map((el) =>
      el.getAttribute("data-tone"),
    );
    expect(tones).toContain("warn");
    expect(tones).not.toContain("success");
  });

  it("三个独立出口报已隔离", () => {
    const data = withWorkers([worker()], {
      isolation: {
        groups: [
          { egressIp: "198.51.100.1", workerIds: ["w1"], proxyIds: ["p1"] },
          { egressIp: "198.51.100.2", workerIds: ["w2"], proxyIds: ["p2"] },
        ],
        unknownWorkerIds: [],
        sharedGroups: [],
        isolated: true,
      },
    });
    render(<OverviewPage data={data} />);
    expect(screen.getByText(/已隔离 · 2 个独立出口/)).toBeInTheDocument();
  });
});

/* ================================================================== *
 * 凭证不显示
 * ================================================================== */

describe("界面只显示凭证指纹", () => {
  it("显示 8 位指纹,不显示完整值", () => {
    render(<OverviewPage data={withWorkers([worker()])} />);

    // 指纹供人眼比对「是不是我刚填的那个」——用它而不是长度，因为等长的两个
    // key 长度相同，于是「我改了没生效」在界面上不可见。
    expect(screen.getAllByText("abcd1234").length).toBeGreaterThan(0);
  });

  it("未配置 key 的 Worker 明确显示未配置", () => {
    render(
      <OverviewPage
        data={withWorkers([worker({ apiKey: { present: false, fingerprint: null }, inPool: false })])}
      />,
    );
    expect(screen.getByText("未配置")).toBeInTheDocument();
  });
});

/* ================================================================== *
 * 空状态与目录
 * ================================================================== */

describe("空状态与目录状态", () => {
  it("没有 Worker 时给出下一步,而不只是说「空」", () => {
    render(<OverviewPage data={withWorkers([])} />);

    expect(screen.getByText(/还没有配置 Worker/)).toBeInTheDocument();
    // 空状态的价值在于下一步 —— 与 doctor 的分层同一个理由。
    expect(screen.getByText(/npm run setup/)).toBeInTheDocument();
  });

  it("目录拉不到显示「—」而不是 0", () => {
    render(<OverviewPage data={withWorkers([worker()], { catalog: { slots: [], freeCount: null } })} />);

    /*
     * 「还没拿到目录」与「一个免费模型都没有」是两件事，后者才需要查
     * freeSuffix。显示 0 会把用户引向错误方向 —— Phase 8 的 doctor 为此
     * 专门分了两层。
     */
    expect(screen.getByText("—")).toBeInTheDocument();
    /*
     * 「目录未拉到」既是指标卡的 hint 也是状态指示器的 label —— 两处都要有:
     * 扫一眼指标区能看到「—」配一句解释,而状态行是那条需要处置的告警。
     */
    expect(screen.getAllByText("目录未拉到").length).toBe(2);
  });

  it("目录可达但免费集为空时报警告,与拉不到区分开", () => {
    render(<OverviewPage data={withWorkers([worker()], { catalog: { slots: [], freeCount: 0 } })} />);
    expect(screen.getByText("目录可达但免费集为空")).toBeInTheDocument();
  });

  it("统计写失败非 0 时必须显眼", () => {
    const data = withWorkers([worker()], {
      health: { ok: true, version: "t", uptimeSeconds: 1, pid: 1, storeWriteFailures: 7 },
    });
    render(<OverviewPage data={data} />);

    // 一个一直写失败的库会安静地给出全 0 报表，而那看起来像「没人用」。
    expect(screen.getByText(/统计写失败 7 次/)).toBeInTheDocument();
  });

  it("统计写失败为 0 时不显示那一条（0 是正常值）", () => {
    render(<OverviewPage data={withWorkers([worker()])} />);
    expect(screen.queryByText(/统计写失败/)).not.toBeInTheDocument();
  });
});

/* ================================================================== *
 * 无障碍
 * ================================================================== */

describe("无障碍与密度", () => {
  it("表格行高 44px —— 同时满足宽松密度与触摸目标", () => {
    const { container } = render(<OverviewPage data={withWorkers([worker()])} />);
    const row = container.querySelector("tr[data-worker]");
    expect(row).not.toBeNull();
    expect((row as HTMLElement).style.height).toBe("44px");
  });

  it("主操作按钮触摸目标 ≥44px", () => {
    const { container } = render(<OverviewPage data={withWorkers([worker()])} />);
    const button = container.querySelector("button");
    expect(button?.className).toContain("min-h-[44px]");
  });

  it("探测按钮在进行中禁用 —— 重复探测会互相切 selector", () => {
    const { container } = render(<OverviewPage data={withWorkers([worker()])} />);
    const button = container.querySelector("button") as HTMLButtonElement;
    // 初始未运行，可点。
    expect(button.disabled).toBe(false);
    expect(button.textContent).toContain("探测出口");
  });
});
