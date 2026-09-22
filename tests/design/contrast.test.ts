import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { contrastRatio, parseTokenBlock, type TokenMap } from "./color.ts";

const CSS = readFileSync(new URL("../../src/admin/styles/tokens.css", import.meta.url), "utf8");

const LIGHT = parseTokenBlock(CSS, ":root");
const DARK = parseTokenBlock(CSS, '[data-theme="dark"]');

// 防回归：parseTokenBlock 第一版按选择器首次出现取块，而
// `[data-theme="dark"]` 也出现在 @custom-variant 声明里，于是深色主题
// 被静默解析成 :root 的内容，四十多条断言全在重复检查浅色主题。
if (LIGHT["bg"] === DARK["bg"]) {
  throw new Error("两个主题解析出同样的 bg —— token 解析有误，断言无效");
}

/** 承载文本或图标的 token —— 必须在每个表面上 ≥4.5:1。 */
const FOREGROUNDS = ["text", "text-muted", "accent-fg", "success", "warn", "error", "info"] as const;

/** 内容可以叠在上面的表面 token。 */
const SURFACES = ["bg", "surface", "surface-accent"] as const;

/**
 * 结构性 token —— 不承载文本，不参与 ≥4.5:1 规则。
 * 白名单是穷举的：任何新 token 若不在 FOREGROUNDS/SURFACES/STRUCTURAL 里，
 * 下面的「穷举覆盖」测试会失败，逼迫作者显式归类而不是默默漏掉。
 */
const STRUCTURAL = ["border", "border-strong", "accent-fill", "on-accent-fill"] as const;

const THEMES: Array<[string, TokenMap]> = [
  ["light", LIGHT],
  ["dark", DARK],
];

describe("设计 token 对比度", () => {
  it.each(THEMES)("%s：token 解析出字面量十六进制值", (_name, tokens) => {
    expect(Object.keys(tokens).length).toBeGreaterThan(10);
    for (const [key, value] of Object.entries(tokens)) {
      expect(value, key).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it.each(THEMES)("%s：每个 token 都被显式归类", (_name, tokens) => {
    const classified = new Set<string>([...FOREGROUNDS, ...SURFACES, ...STRUCTURAL]);
    const unclassified = Object.keys(tokens).filter((k) => !classified.has(k));
    expect(unclassified, "新 token 必须归类为前景/表面/结构性").toEqual([]);
  });

  it.each(THEMES)("%s：两个主题定义同一组 token", (_name, tokens) => {
    expect(Object.keys(tokens).sort()).toEqual(Object.keys(LIGHT).sort());
  });

  // 核心断言：前景 × 表面 的笛卡尔积全部 ≥4.5:1。
  for (const [theme, tokens] of THEMES) {
    for (const fg of FOREGROUNDS) {
      for (const surface of SURFACES) {
        it(`${theme}：${fg} 在 ${surface} 上 ≥4.5:1`, () => {
          const ratio = contrastRatio(tokens[fg]!, tokens[surface]!);
          expect(
            ratio,
            `${fg} ${tokens[fg]} on ${surface} ${tokens[surface]} = ${ratio.toFixed(2)}:1`,
          ).toBeGreaterThanOrEqual(4.5);
        });
      }
    }
  }

  // accent-fill 是填充，规则不同：要求压在它上面的文字够清晰。
  it.each(THEMES)("%s：on-accent-fill 在 accent-fill 上 ≥4.5:1", (_name, tokens) => {
    const ratio = contrastRatio(tokens["on-accent-fill"]!, tokens["accent-fill"]!);
    expect(ratio, `= ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
  });

  /*
   * 禁用 box-shadow 后，层次只剩「表面色调 + 1px 边框」。
   * 原 border 在 surface 上只有 1.077 —— 卡片叠在面板上时边框等于不存在，
   * 而第三个机制又被禁掉了。border-strong 补的就是这个缺口，
   * 所以它必须真的比 border 更可见，否则等于没加。
   */
  it.each(THEMES)("%s：border-strong 在 surface 上确实可见", (_name, tokens) => {
    const weak = contrastRatio(tokens["border"]!, tokens["surface"]!);
    const strong = contrastRatio(tokens["border-strong"]!, tokens["surface"]!);
    expect(strong).toBeGreaterThan(weak);
    expect(strong, `border-strong on surface = ${strong.toFixed(2)}:1`).toBeGreaterThanOrEqual(1.2);
  });
});

/*
 * 状态色的色相分布。
 *
 * 六个语义色里 accent-fg ↔ error 只差约 14°，二色性下四个状态会塌缩到
 * ≤1.28 的可分辨度（三色性下 1.01，即完全不可分）。这就是 StatusIndicator
 * 在类型上强制图标 + 文字标签的原因 —— 这里断言的是「色相靠得太近」这个
 * 事实本身成立，防止有人误以为调色就能解决，从而把图标要求当成可选项。
 */
describe("状态色色相分布", () => {
  function hue(hex: string): number {
    const n = parseInt(hex.slice(1), 16);
    const [r, g, b] = [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max === min) return 0;
    const d = max - min;
    let h: number;
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return ((h * 60) % 360 + 360) % 360;
  }

  it("accent 与 error 的色相差不足以单独区分状态", () => {
    const delta = Math.abs(hue(LIGHT["accent-fg"]!) - hue(LIGHT["error"]!));
    expect(delta).toBeLessThan(30);
  });
});
