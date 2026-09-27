import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HintTip } from "../../src/admin/components/HintTip.tsx";

/*
 * 说明收进 ⓘ 之后，读屏、键盘和触屏用户也必须能读到：悬停、聚焦、点击三种方式都要能打开，
 * 且打开时按钮用 aria-describedby 指向浮层。
 */

describe("HintTip", () => {
  it("默认不占位置；悬停显示、移开收起", async () => {
    const user = userEvent.setup();
    render(<HintTip label="规则说明">冷却是分级的</HintTip>);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    const button = screen.getByRole("button", { name: "规则说明" });
    await user.hover(button);
    expect(screen.getByRole("tooltip")).toHaveTextContent("冷却是分级的");
    expect(button).toHaveAttribute("aria-describedby", screen.getByRole("tooltip").id);
    await user.unhover(button);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("键盘聚焦就显示，Esc 收起", async () => {
    const user = userEvent.setup();
    render(<HintTip label="规则说明">内容</HintTip>);
    await user.tab();
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("点击固定住（触屏没有悬停）：移开不收，再点一次才收", async () => {
    const user = userEvent.setup();
    render(<HintTip label="规则说明">内容</HintTip>);
    const button = screen.getByRole("button", { name: "规则说明" });
    await user.click(button);
    await user.unhover(button);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    await user.click(button);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("打开期间随滚动重算位置，跟着按钮走", async () => {
    const user = userEvent.setup();
    render(<HintTip label="规则说明">说明</HintTip>);
    const button = screen.getByRole("button", { name: "规则说明" });
    let top = 100;
    vi.spyOn(button, "getBoundingClientRect").mockImplementation(() => ({ top, bottom: top + 24, left: 40, right: 64, width: 24, height: 24, x: 40, y: top, toJSON: () => ({}) }));
    await user.click(button);
    expect(screen.getByRole("tooltip").style.top).toBe("130px");
    top = 20;
    fireEvent.scroll(document.body);
    expect(screen.getByRole("tooltip").style.top).toBe("50px");
  });
});
