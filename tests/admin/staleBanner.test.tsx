import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { StaleBanner } from "../../src/admin/components/StatusViews.tsx";
import type { StaleInfo } from "../../src/admin/lib/api.ts";

const stale = { lastSuccessAt: Date.now() - 5000, failure: { kind: "offline" } } as unknown as StaleInfo;

describe("StaleBanner", () => {
  it("断连恢复后短暂显示「已重新连接」", () => {
    const { rerender } = render(<StaleBanner stale={stale} />);
    expect(screen.getByText(/连接中断/)).toBeInTheDocument();
    rerender(<StaleBanner stale={null} />);
    expect(screen.getByText(/已重新连接/)).toBeInTheDocument();
  });

  it("被外层隐藏期间不显示；外层不再隐藏时不误报「已重新连接」", () => {
    const { rerender } = render(<StaleBanner stale={stale} />);
    // 外层（概览）也断了：这里隐藏，自己的端点仍是断的。
    rerender(<StaleBanner stale={stale} hidden />);
    expect(screen.queryByText(/连接中断|已重新连接/)).not.toBeInTheDocument();
    // 外层恢复，本端点仍断：应显示断连，而不是「已重新连接」。
    rerender(<StaleBanner stale={stale} />);
    expect(screen.getByText(/连接中断/)).toBeInTheDocument();
    rerender(<StaleBanner stale={null} hidden />);
    rerender(<StaleBanner stale={null} />);
    expect(screen.queryByText(/已重新连接/)).not.toBeInTheDocument();
  });
});
