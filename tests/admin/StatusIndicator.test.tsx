import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusIndicator } from "../../src/admin/components/StatusIndicator.tsx";
import { STATUS_ICON } from "../../src/admin/components/Icons.tsx";

/*
 * 契约:状态永不只靠颜色表达。
 *
 * 断言的是可访问的输出(文字节点、aria 属性),不是 HTML 字符串 ——
 * 把 UX 测试写成 HTML 字符串断言的话,一改样式就全红,意图随之流失。
 */
describe("StatusIndicator", () => {
  it("同时渲染图标与文字标签", () => {
    const { container } = render(<StatusIndicator tone="error" icon="cross" label="鉴权失败" />);
    expect(screen.getByText("鉴权失败")).toBeInTheDocument();
    expect(container.querySelector('[data-icon="cross"] svg')).not.toBeNull();
  });

  it("图标对屏幕阅读器隐藏,文字标签是唯一可读来源", () => {
    const { container } = render(<StatusIndicator tone="warn" icon="alert" label="限流冷却中" />);
    expect(container.querySelector('[data-icon="alert"]')).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText("限流冷却中")).not.toHaveAttribute("aria-hidden");
  });

  it("色调以 data 属性暴露,供测试与样式共同依赖", () => {
    const { container } = render(<StatusIndicator tone="success" icon="check" label="就绪" />);
    expect(container.querySelector('[data-tone="success"]')).not.toBeNull();
  });

  /*
   * 色觉障碍下颜色靠不住,图形是第二条通道:任意两个状态图标的形状都必须不同。
   * 比的是 SVG 内部结构,两个图标画成一样时这里会红。
   */
  it("每个状态图标的形状互不相同", () => {
    const shapes = Object.keys(STATUS_ICON).map((name) => {
      const { container, unmount } = render(<StatusIndicator tone="neutral" icon={name as keyof typeof STATUS_ICON} label="x" />);
      const html = container.querySelector("svg")?.innerHTML ?? "";
      unmount();
      return html;
    });
    expect(shapes.every((s) => s !== "")).toBe(true);
    expect(new Set(shapes).size).toBe(shapes.length);
  });

  /*
   * 去掉 icon 或 label 是 TS 编译错误,运行期测不到。
   * 这些测试守的是另一半:有人绕过类型(as any / 从 JS 调用)时,
   * 空值形态不能静默退化成一个只有颜色的状态。
   */
  it("空标签直接抛错,不静默退化为只有颜色", () => {
    expect(() => render(<StatusIndicator tone="info" icon="idle" label="   " />)).toThrow(/label 不能为空/);
  });

  /*
   * 先前 `icon` 接受任意字符。改成图标名后,旧写法(字符)与原型上的名字
   * (`toString`,`in` 判定会放过它)都不认识,必须抛错而不是渲染出空 span。
   */
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["false", false],
    ["空字符串", ""],
    ["空白字符串", "  "],
    ["空数组", []],
    ["旧写法的字符", "✕"],
    ["原型上的名字", "toString"],
  ])("不认识的图标(%s)直接抛错", (_label, icon) => {
    expect(() =>
      // 模拟绕过类型的调用方。
      render(<StatusIndicator tone="error" icon={icon as never} label="鉴权失败" />),
    ).toThrow(/icon 不能为空/);
  });

  it("合法图标正常渲染,不误报", () => {
    expect(() => render(<StatusIndicator tone="success" icon="check" label="就绪" />)).not.toThrow();
  });
});
