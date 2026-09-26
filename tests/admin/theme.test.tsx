import { describe, expect, it, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../../src/admin/App.tsx";
import { THEME_KEY, resolveTheme, type ThemePreference } from "../../src/admin/lib/theme.ts";

/** jsdom 环境下 import.meta.url 不是 file: 协议，按 vitest 的 root（仓库根）解析。 */
const INDEX_HTML = join(process.cwd(), "src/admin/index.html");

/*
 * 配色：默认跟随系统，页头可切换，偏好存 localStorage，生效在 <html data-theme>。
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubMatchMedia(prefersDark: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: query.includes("dark") ? prefersDark : false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })),
  );
}

/** index.html 里首屏前执行的那段脚本。 */
function inlineThemeScript(): string {
  const html = readFileSync(INDEX_HTML, "utf8");
  const match = /<script>([\s\S]*?)<\/script>/.exec(html);
  if (match === null) throw new Error("index.html 里找不到首屏配色脚本");
  return match[1]!;
}

describe("配色解析", () => {
  it("跟随系统时按 prefers-color-scheme，显式选择时忽略系统", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("index.html 不再硬编码 data-theme", () => {
    const html = readFileSync(INDEX_HTML, "utf8");
    expect(html).not.toMatch(/<html[^>]*data-theme=/);
  });

  /*
   * 首屏脚本不能 import theme.ts，于是两份判定并存。这里执行那段脚本，
   * 与 `resolveTheme` 在全部输入组合上比对，防止键名或判定分叉。
   */
  const prefs: Array<ThemePreference | "garbage" | null> = ["system", "light", "dark", "garbage", null];
  for (const stored of prefs) {
    for (const prefersDark of [true, false]) {
      it(`首屏脚本与 resolveTheme 一致：存储=${String(stored)}，系统深色=${prefersDark}`, () => {
        stubMatchMedia(prefersDark);
        window.localStorage.clear();
        if (stored !== null) window.localStorage.setItem(THEME_KEY, stored);
        delete document.documentElement.dataset.theme;

        new Function(inlineThemeScript())();

        const pref: ThemePreference =
          stored === "light" || stored === "dark" ? stored : "system";
        expect(document.documentElement.dataset.theme).toBe(resolveTheme(pref, prefersDark));
      });
    }
  }
});

describe("页头配色选择", () => {
  it("是带标签的下拉框，切换后写入 data-theme 与 localStorage", async () => {
    stubMatchMedia(false);
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    const user = userEvent.setup();
    render(<App />);

    const select = screen.getByRole("combobox", { name: "配色" });
    expect(select).toHaveValue("system");
    expect(document.documentElement.dataset.theme).toBe("light");

    await user.selectOptions(select, "dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(window.localStorage.getItem(THEME_KEY)).toBe("dark");

    // 回到跟随系统时清掉存储，而不是存一个 "system"。
    await user.selectOptions(select, "system");
    expect(window.localStorage.getItem(THEME_KEY)).toBeNull();
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("刷新后恢复已保存的偏好", () => {
    stubMatchMedia(false);
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    window.localStorage.setItem(THEME_KEY, "dark");
    render(<App />);
    expect(screen.getByRole("combobox", { name: "配色" })).toHaveValue("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});
