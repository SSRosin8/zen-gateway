import { useCallback, useEffect, useState } from "react";

/**
 * 配色偏好。
 *
 * 默认跟随系统的 `prefers-color-scheme`；用户在页头选择浅色或深色后写入
 * localStorage。实际生效的是 `<html data-theme>`，`tokens.css` 按它切换 token。
 *
 * `index.html` 里有一段首屏前执行的内联脚本做同样的解析，避免 React 挂载前
 * 先闪一帧浅色。那段脚本不能 import 这里的代码，所以 `tests/admin/theme.test.tsx`
 * 直接执行它并与 `resolveTheme` 的结果比对，两边的键名与判定不会悄悄分叉。
 */

export const THEME_KEY = "zg-theme";

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_OPTIONS: ReadonlyArray<{ value: ThemePreference; label: string }> = [
  { value: "system", label: "跟随系统" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
];

/** 主题按钮的循环顺序：跟随系统 → 浅色 → 深色 → 跟随系统。 */
export function nextPreference(pref: ThemePreference): ThemePreference {
  return pref === "system" ? "light" : pref === "light" ? "dark" : "system";
}

/** 侧栏收起状态的存储键；与配色一样是纯显示偏好，不进 URL。 */
export const SIDEBAR_KEY = "zg-sidebar";

const DARK_QUERY = "(prefers-color-scheme: dark)";

function isPreference(value: unknown): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

export function readPreference(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(THEME_KEY);
    return isPreference(stored) ? stored : "system";
  } catch {
    // 隐私模式等场景下 localStorage 可能抛错；退回跟随系统。
    return "system";
  }
}

function systemPrefersDark(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(DARK_QUERY).matches;
}

export function resolveTheme(pref: ThemePreference, prefersDark: boolean): ResolvedTheme {
  if (pref === "light" || pref === "dark") return pref;
  return prefersDark ? "dark" : "light";
}

export function applyTheme(theme: ResolvedTheme): void {
  document.documentElement.dataset.theme = theme;
}

/** 侧栏主题按钮使用的状态。选择「跟随系统」时订阅系统配色变化。 */
export function useTheme(): {
  preference: ThemePreference;
  setPreference: (pref: ThemePreference) => void;
} {
  const [preference, setPreferenceState] = useState<ThemePreference>(readPreference);

  useEffect(() => {
    applyTheme(resolveTheme(preference, systemPrefersDark()));
    if (preference !== "system" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(DARK_QUERY);
    const onChange = () => applyTheme(resolveTheme("system", media.matches));
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [preference]);

  const setPreference = useCallback((pref: ThemePreference) => {
    try {
      if (pref === "system") window.localStorage.removeItem(THEME_KEY);
      else window.localStorage.setItem(THEME_KEY, pref);
    } catch {
      // 写不进去时本次会话仍然生效，只是刷新后回到跟随系统。
    }
    setPreferenceState(pref);
  }, []);

  return { preference, setPreference };
}

/**
 * 皮肤：同一套组件与毛玻璃，两套色板。`cool` 是默认的冷灰蓝，`warm` 是改版前的暖米白。
 * 与配色（浅/深）正交，生效在 `<html data-skin>`；`index.html` 首屏脚本同样先读它。
 */
export const SKIN_KEY = "zg-skin";

export type Skin = "cool" | "warm";

export const SKIN_OPTIONS: ReadonlyArray<{ value: Skin; label: string }> = [
  { value: "cool", label: "冷灰蓝" },
  { value: "warm", label: "暖米白" },
];

export function readSkin(): Skin {
  try {
    return window.localStorage.getItem(SKIN_KEY) === "warm" ? "warm" : "cool";
  } catch {
    return "cool";
  }
}

export function applySkin(skin: Skin): void {
  if (skin === "warm") document.documentElement.dataset.skin = "warm";
  else delete document.documentElement.dataset.skin;
}

export function useSkin(): { skin: Skin; setSkin: (skin: Skin) => void } {
  const [skin, setState] = useState<Skin>(readSkin);
  useEffect(() => applySkin(skin), [skin]);
  const setSkin = useCallback((next: Skin) => {
    try {
      if (next === "cool") window.localStorage.removeItem(SKIN_KEY);
      else window.localStorage.setItem(SKIN_KEY, next);
    } catch {
      // 写不进去时本次会话仍然生效。
    }
    setState(next);
  }, []);
  return { skin, setSkin };
}
