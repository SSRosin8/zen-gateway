import { describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { UsageChart, buildSeries, smoothPath } from "../../src/admin/components/UsageChart.tsx";
import type { DailyPoint } from "../../src/shared/contract.ts";

/*
 * 面积图必须**堆叠**：每个系列的上沿是它与下面各系列的累计，所以最上面那条线就是当天合计，
 * 与柱状图同一个 y 轴。不堆叠的面积会互相遮盖，也读不出合计。
 */

const point = (day: string, key: string, input: number): DailyPoint => ({
  day,
  key,
  inputTokens: input,
  outputTokens: 0,
  cacheReadTokens: 0,
  requests: 1,
});

// 两天、两个系列：a = [100, 300]、b = [200, 100]，合计 [300, 400]。
const points = [point("2026-09-20", "a", 100), point("2026-09-21", "a", 300), point("2026-09-20", "b", 200), point("2026-09-21", "b", 100)];
const today = "2026-09-21";

function edges(container: HTMLElement): Map<string, number[]> {
  const svg = container.querySelector("svg")!;
  const out = new Map<string, number[]>();
  // 上沿线：无填充、有描边的 path；按系列色区分。
  for (const p of svg.querySelectorAll('path[fill="none"]')) {
    // 每段的终点：M 的点、L 的点、C 的第三个点（前两个是控制点）。
    const ys = [...p.getAttribute("d")!.matchAll(/(?:[ML]|C(?:\s*[\d.]+,[\d.]+){2})\s*[\d.]+,([\d.]+)/g)].map((m) => Number(m[1]));
    out.set(p.getAttribute("stroke")!, ys);
  }
  return out;
}

describe("用量面积图", () => {
  it("堆叠：上层的上沿画在「下层 + 自己」的高度，不是自己的值", () => {
    // 两个系列每天都一样多：堆叠时上层上沿在下层上沿的两倍高；不堆叠时两条线重合。
    const same = [point("2026-09-20", "a", 100), point("2026-09-21", "a", 100), point("2026-09-20", "b", 100), point("2026-09-21", "b", 100)];
    const { container } = render(
      <UsageChart points={same} sinceDay="2026-09-20" metric="input" shape="line" seriesLabel="模型" today={new Date(`${today}T12:00:00Z`)} />,
    );
    expect(container.querySelector('[data-usage-chart="line"]')).not.toBeNull();
    // 填充区域另有一层，不只是两条线。
    expect(container.querySelectorAll("svg path[fill-opacity]")).toHaveLength(2);
    const [lower, upper] = [...edges(container).values()].sort((p, q) => q[0]! - p[0]!);
    const baseline = Math.max(...[...container.querySelectorAll("svg line")].map((l) => Number(l.getAttribute("y1"))));
    // 距基线的高度：上层正好是下层的两倍。
    expect(baseline - upper![0]!).toBeCloseTo(2 * (baseline - lower![0]!), 0);
  });

  it("柱状与面积共用同一个 y 轴顶（按当天合计取整）", () => {
    const label = (shape: "line" | "bar") => {
      const { container, unmount } = render(
        <UsageChart points={points} sinceDay="2026-09-20" metric="input" shape={shape} seriesLabel="模型" today={new Date(`${today}T12:00:00Z`)} />,
      );
      const ticks = [...container.querySelectorAll("svg text")].map((t) => t.textContent);
      unmount();
      return ticks;
    };
    expect(label("line")).toEqual(label("bar"));
  });
});

describe("系列颜色", () => {
  const day = "2026-09-21";
  const series = (names: string[], extra: string[] = []) =>
    buildSeries(
      [...names.map((n, i) => point(day, n, 1000 - i)), ...extra.map((n) => point(day, n, 1))],
      [day],
      "tokens",
    );

  it("可见的系列颜色两两不同，即使名字很多", () => {
    // 生成足够多的名字，保证散列必然撞槽（8 个槽、7 个可见系列）。
    for (let start = 0; start < 40; start++) {
      const names = Array.from({ length: 7 }, (_, i) => `model-${start * 7 + i}`);
      const slots = series(names, ["tail-a", "tail-b"]).filter((s) => s.slot !== null).map((s) => s.slot);
      expect(new Set(slots).size).toBe(7);
    }
  });

  it("同一个系列的颜色与名次、与并进「其他」的系列无关", () => {
    const seven = ["alpha", "beta", "gamma", "delta", "eps", "zeta", "eta"];
    const a = series(seven);
    const b = series([...seven].reverse(), ["aa-small", "ab-small", "ac-small"]);
    expect(b.at(-1)!.slot).toBeNull(); // 确实有并进「其他」的
    const slot = (list: typeof a, key: string) => list.find((s) => s.key === key)!.slot;
    for (const k of seven) expect(slot(b, k)).toBe(slot(a, k));
  });
});

describe("面积图的曲线", () => {
  const ys = (d: string) => [...d.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((m) => Number(m[2]));

  it("三天以上画成曲线（三次贝塞尔），经过每个数据点", () => {
    const pts = [[0, 100], [10, 40], [20, 80], [30, 80]] as const;
    const d = smoothPath(pts);
    expect(d).toMatch(/^M0\.0,100\.0 C/);
    expect(d).not.toContain(" L");
    // 每段终点正好是下一个数据点。
    const ends = [...d.matchAll(/C(?:\s*[\d.]+,[\d.]+){2}\s*([\d.]+),([\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
    expect(ends).toEqual([[10, 40], [20, 80], [30, 80]]);
  });

  it("不冲过头：控制点不越出相邻两点的范围（堆叠面积不会低于基线或压进别的层）", () => {
    // 骤降到 0 再骤升，是普通样条最容易冲到基线以下的形状。
    const pts = [[0, 50], [10, 250], [20, 250], [30, 50], [40, 250]] as const;
    const all = ys(smoothPath(pts));
    expect(Math.max(...all)).toBeLessThanOrEqual(250);
    expect(Math.min(...all)).toBeGreaterThanOrEqual(50);
    // 持平的一段保持水平：两个控制点都在 250 上。
    expect(smoothPath(pts)).toContain("C13.3,250.0 16.7,250.0 20.0,250.0");
  });

  it("反向传入得到同一条曲线：面积回程边与相邻层的上沿重合", () => {
    const pts = [[0, 10], [10, 30], [20, 25], [30, 60]] as const;
    const forward = smoothPath(pts);
    const back = smoothPath([...pts].reverse());
    const nums = (d: string) => [...d.matchAll(/-?[\d.]+/g)].map((m) => Number(m[0]));
    // 同一组贝塞尔段，只是方向相反：数值集合相同。
    expect(nums(back).sort((a, b) => a - b)).toEqual(nums(forward).sort((a, b) => a - b));
  });

  it("面积图的填充上下沿都是曲线，与相邻层的上沿共用同一组段", () => {
    const pts = ["2026-09-18", "2026-09-19", "2026-09-20", "2026-09-21"].flatMap((d, i) => [point(d, "a", 100 + i * 50), point(d, "b", 300 - i * 60)]);
    const { container } = render(
      <UsageChart points={pts} sinceDay="2026-09-18" metric="input" shape="line" seriesLabel="模型" today={new Date(`${today}T12:00:00Z`)} />,
    );
    const areas = [...container.querySelectorAll("svg path[fill-opacity]")].map((p) => p.getAttribute("d")!);
    expect(areas).toHaveLength(2);
    // 回程边只能是 C 段：只有一个 L（上沿终点接到下沿起点的那一竖）。
    for (const d of areas) expect(d.match(/ L/g)).toHaveLength(1);
    // 上层的下沿 = 下层的上沿（同一组贝塞尔段），所以层间没有缝。
    const edges = [...container.querySelectorAll('svg path[fill="none"]')].map((p) => p.getAttribute("d")!);
    const segs = (d: string) => new Set([...d.matchAll(/C[^C]*/g)].map((m) => m[0].trim()).flatMap((c) => c.match(/-?[\d.]+/g)!));
    const lowerEdge = edges.find((e) => areas.some((a) => a.startsWith(e)))!;
    const upperArea = areas.find((a) => !a.startsWith(lowerEdge))!;
    for (const n of segs(lowerEdge)) expect(segs(upperArea).has(n)).toBe(true);
  });

  it("少于三个点时退回直线", () => {
    expect(smoothPath([[0, 1], [10, 2]])).toBe("M0.0,1.0 L10.0,2.0");
    expect(smoothPath([])).toBe("");
  });
});

describe("横轴与窄屏", () => {
  it("横轴从这段时间里第一天有数据时开始，不画之前全是 0 的日子", () => {
    const { container } = render(
      <UsageChart points={points} sinceDay="2026-08-23" metric="input" shape="bar" seriesLabel="模型" today={new Date(`${today}T12:00:00Z`)} />,
    );
    const dayLabels = [...container.querySelectorAll("svg text")].map((t) => t.textContent).filter((t) => /^\d\d-\d\d$/.test(t ?? ""));
    expect(dayLabels).toEqual(["09-20", "09-21"]);
  });

  it("时间范围之外的数据不把横轴拉长", () => {
    const early = [...points, point("2026-09-01", "a", 5)];
    const { container } = render(
      <UsageChart points={early} sinceDay="2026-09-20" metric="input" shape="bar" seriesLabel="模型" today={new Date(`${today}T12:00:00Z`)} />,
    );
    const dayLabels = [...container.querySelectorAll("svg text")].map((t) => t.textContent).filter((t) => /^\d\d-\d\d$/.test(t ?? ""));
    expect(dayLabels[0]).toBe("09-20");
  });

  it("按容器实际宽度作画：窄容器的画布就是那么宽，刻度字不被整体缩小", async () => {
    // jsdom 没有布局：用一个立即回报 320px 的 ResizeObserver 代替浏览器。
    class FixedWidth {
      constructor(private cb: ResizeObserverCallback) {}
      observe() {
        this.cb([{ contentRect: { width: 320 } } as ResizeObserverEntry], this as unknown as ResizeObserver);
      }
      disconnect() {}
      unobserve() {}
    }
    vi.stubGlobal("ResizeObserver", FixedWidth);
    const { container } = render(
      <UsageChart points={points} sinceDay="2026-09-20" metric="input" shape="bar" seriesLabel="模型" today={new Date(`${today}T12:00:00Z`)} />,
    );
    await waitFor(() => expect(container.querySelector("svg")!.getAttribute("viewBox")).toMatch(/^0 0 320 /));
    vi.unstubAllGlobals();
  });
});

it("挂上时同步量一次宽度，不等 ResizeObserver 的首次回调", async () => {
  // 没有 ResizeObserver 回调的环境（后台标签）里也按容器宽度作画。
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
  const spy = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1100);
  const { container } = render(
    <UsageChart points={points} sinceDay="2026-09-20" metric="input" shape="bar" seriesLabel="模型" today={new Date(`${today}T12:00:00Z`)} />,
  );
  await waitFor(() => expect(container.querySelector("svg")!.getAttribute("viewBox")).toMatch(/^0 0 1100 /));
  spy.mockRestore();
  vi.unstubAllGlobals();
});
