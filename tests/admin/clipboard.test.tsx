import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { copyText } from "../../src/admin/lib/clipboard.ts";
import { Cmd } from "../../src/admin/pages/StartPage.tsx";

/*
 * 从局域网 `http://<IP>:5173` 打开后台时不是安全上下文，浏览器不暴露
 * `navigator.clipboard`。旧实现 `navigator.clipboard?.writeText()` 此时什么都不做，
 * 按钮「没反应」。这里在没有 Clipboard API 的条件下验证退路与失败提示。
 */

const exec = vi.fn<(cmd: string) => boolean>();

function withoutClipboard() {
  // userEvent.setup() 会装一个假剪贴板；这里要的是「根本没有」。
  Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
  Object.defineProperty(document, "execCommand", { value: exec, configurable: true });
}

afterEach(() => {
  exec.mockReset();
  Reflect.deleteProperty(navigator, "clipboard");
  Reflect.deleteProperty(document, "execCommand");
});

describe("copyText", () => {
  it("没有 Clipboard API 时退回 execCommand，复制的是选中的原文，结束后不留节点", async () => {
    withoutClipboard();
    let selected = "";
    exec.mockImplementation(() => {
      selected = (document.activeElement as HTMLTextAreaElement | null)?.value ?? "";
      return true;
    });
    expect(await copyText("npm start")).toBe(true);
    expect(exec).toHaveBeenCalledWith("copy");
    expect(selected).toBe("npm start");
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("Clipboard API 拒绝时也走退路；两条都失败返回 false", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: () => Promise.reject(new Error("denied")) },
      configurable: true,
    });
    Object.defineProperty(document, "execCommand", { value: exec, configurable: true });
    exec.mockReturnValue(false);
    expect(await copyText("x")).toBe(false);
    expect(exec).toHaveBeenCalledWith("copy");
  });
});

describe("复制命令按钮", () => {
  it("无 Clipboard API 时照样复制并显示「已复制」；失败时明确提示手动复制", async () => {
    withoutClipboard();
    const user = userEvent.setup();
    withoutClipboard();
    exec.mockReturnValueOnce(true).mockReturnValueOnce(false);
    render(<Cmd text="npm start" copyable />);

    await user.click(screen.getByRole("button", { name: "复制命令" }));
    expect(await screen.findByRole("button", { name: "已复制" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "已复制" }));
    expect(await screen.findByRole("button", { name: "复制失败，请手动选中" })).toBeInTheDocument();
  });
});
