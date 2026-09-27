import type { ReactNode } from "react";
import type { PageId } from "../lib/router.ts";
import type { ThemePreference } from "../lib/theme.ts";

/**
 * 侧栏用的线性图标。内联 SVG 而不是图标库：一共十几个，都是 20px、1.75 描边、跟随文字颜色。
 * 图标一律 `aria-hidden`，可访问名称由所在的链接或按钮给出。
 */
function Svg({ children }: { children: ReactNode }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
    >
      {children}
    </svg>
  );
}

export const PAGE_ICON: Record<PageId, ReactNode> = {
  start: (
    <Svg>
      <path d="M5 12l5 5L20 7" />
    </Svg>
  ),
  overview: (
    <Svg>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
    </Svg>
  ),
  gateway: (
    <Svg>
      <rect x="3.5" y="4" width="17" height="6.5" rx="1.5" />
      <rect x="3.5" y="13.5" width="17" height="6.5" rx="1.5" />
      <path d="M7 7.25h.01M7 16.75h.01" />
    </Svg>
  ),
  proxy: (
    <Svg>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5c2.5 2.6 3.5 5.4 3.5 8.5s-1 5.9-3.5 8.5c-2.5-2.6-3.5-5.4-3.5-8.5s1-5.9 3.5-8.5z" />
    </Svg>
  ),
  workers: (
    <Svg>
      <circle cx="9" cy="8.5" r="3.5" />
      <path d="M2.5 20c.6-3.4 3.2-5.5 6.5-5.5s5.9 2.1 6.5 5.5" />
      <path d="M16 5.2a3.5 3.5 0 010 6.6M18 14.8c1.9.7 3.2 2.5 3.5 5.2" />
    </Svg>
  ),
  models: (
    <Svg>
      <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" />
      <path d="M4 7.5l8 4.5 8-4.5M12 12v9" />
    </Svg>
  ),
  usage: (
    <Svg>
      <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
    </Svg>
  ),
  diagnostics: (
    <Svg>
      <path d="M3 12h4l2.5-6 5 12 2.5-6h4" />
    </Svg>
  ),
};

export const THEME_ICON: Record<ThemePreference, ReactNode> = {
  system: (
    <Svg>
      <rect x="3" y="4" width="18" height="12.5" rx="1.5" />
      <path d="M8.5 20h7M12 16.5V20" />
    </Svg>
  ),
  light: (
    <Svg>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M4.6 4.6L6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4" />
    </Svg>
  ),
  dark: (
    <Svg>
      <path d="M20 14.5A8.5 8.5 0 019.5 4 8.5 8.5 0 1020 14.5z" />
    </Svg>
  ),
};

export function SidebarIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <Svg>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
      <path d={collapsed ? "M13 10l2 2-2 2" : "M16 10l-2 2 2 2"} />
    </Svg>
  );
}
