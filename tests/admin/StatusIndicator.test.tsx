import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusIndicator } from "../../src/admin/components/StatusIndicator.tsx";

/*
 * 契约:状态永不只靠颜色表达。
 *
 * 断言的是可访问的输出(文字节点、aria 属性),不是 HTML 字符串 ——
 * 旧项目的 UX 测试是 HTML 字符串断言,一改样式就全红,意图随之流失。
 */
describe("StatusIndicator", () => {
  it("同时渲染图标与文字标签", () => {
    render(<StatusIndicator tone="error" icon="✕" label="鉴权失败" />);
    expect(screen.getByText("鉴权失败")).toBeInTheDocument();
    expect(screen.getByText("✕")).toBeInTheDocument();
  });

  it("图标对屏幕阅读器隐藏,文字标签是唯一可读来源", () => {
    render(<StatusIndicator tone="warn" icon="!" label="限流冷却中" />);
    expect(screen.getByText("!")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText("限流冷却中")).not.toHaveAttribute("aria-hidden");
  });

  it("色调以 data 属性暴露,供测试与样式共同依赖", () => {
    const { container } = render(<StatusIndicator tone="success" icon="✓" label="就绪" />);
    expect(container.querySelector('[data-tone="success"]')).not.toBeNull();
  });

  /*
   * 去掉 icon 或 label 是 TS 编译错误,运行期测不到。
   * 这些测试守的是另一半:有人绕过类型(as any / 从 JS 调用)时,
   * 空值形态不能静默退化成一个只有颜色的状态。
   */
  it("空标签直接抛错,不静默退化为只有颜色", () => {
    expect(() => render(<StatusIndicator tone="info" icon="i" label="   " />)).toThrow(
      /label 不能为空/,
    );
  });

  /*
   * `icon: ReactNode` 曾经接受 null/undefined/false/"",四者都能通过
   * typecheck 并渲染出一个空的 aria-hidden span —— 第二条信息通道被
   * 静默丢掉,而这正是本组件唯一的存在理由。类型已改为排除这些形态,
   * 这里守运行期。
   */
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["false", false],
    ["空字符串", ""],
    ["空白字符串", "  "],
    ["空数组", []],
  ])("空图标(%s)直接抛错", (_label, icon) => {
    expect(() =>
      // 模拟绕过类型的调用方。
      render(<StatusIndicator tone="error" icon={icon as never} label="鉴权失败" />),
    ).toThrow(/icon 不能为空/);
  });

  it("合法图标正常渲染,不误报", () => {
    expect(() => render(<StatusIndicator tone="success" icon="✓" label="就绪" />)).not.toThrow();
  });
});
