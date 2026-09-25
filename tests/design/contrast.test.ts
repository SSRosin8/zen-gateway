import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  contrastRatio,
  parseThemeMappings,
  parseTokenBlock,
  stripComments,
  type TokenMap,
} from "./color.ts";

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
 * 结构性 token —— 不承载任意文本，不参与 ≥4.5:1 的笛卡尔积规则，
 * 但每一个都有下面单独的断言，不是「豁免」。
 */
const STRUCTURAL = ["border", "border-strong", "accent-fill", "on-accent-fill"] as const;

const CLASSIFIED = [...FOREGROUNDS, ...SURFACES, ...STRUCTURAL] as const;

const THEMES: Array<[string, TokenMap]> = [
  ["light", LIGHT],
  ["dark", DARK],
];

describe("token 解析本身", () => {
  it("注释被剥离，注释里的色值不会被当成声明", () => {
    /*
     * 实测过的失败形态：真实声明是不及格的 #8a6a12，后面跟一句
     * 「压深前的值：--zg-warn: #75580d」的注释，解析器按最后匹配生效
     * 读出 #75580d —— 53 条断言全绿而线上 CSS 不合规。
     * tokens.css 里本就有一条引用旧色值的注释，离触发只差一次文档编辑。
     */
    const masked = `:root {\n  --zg-warn: #8a6a12;\n  /* 旧值 --zg-warn: #75580d 备查 */\n}`;
    expect(parseTokenBlock(masked, ":root")["warn"]).toBe("#8a6a12");
  });

  it("注释里的花括号不会截断块", () => {
    const tricky = `:root {\n  /* 卡片用 .card { border } 表达层次 */\n  --zg-bg: #ffffff;\n}`;
    expect(parseTokenBlock(tricky, ":root")["bg"]).toBe("#ffffff");
  });

  it("同一 token 重复声明时报错，而不是静默取一个", () => {
    // 「哪个生效」取决于 CSS 层叠而非本解析器，静默取一个必然与线上不一致。
    const dup = `:root {\n  --zg-warn: #75580d;\n  --zg-warn: #8a6a12;\n}`;
    expect(() => parseTokenBlock(dup, ":root")).toThrow(/重复声明/);
  });

  it("stripComments 保持长度，位置语义不变", () => {
    const src = "a/* xx */b";
    expect(stripComments(src)).toHaveLength(src.length);
  });
});

describe("设计 token 对比度", () => {
  it.each(THEMES)("%s：token 解析出字面量十六进制值", (_name, tokens) => {
    expect(Object.keys(tokens).length).toBeGreaterThan(10);
    for (const [key, value] of Object.entries(tokens)) {
      expect(value, key).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it.each(THEMES)("%s：每个 token 都被显式归类", (_name, tokens) => {
    const classified = new Set<string>(CLASSIFIED);
    const unclassified = Object.keys(tokens).filter((k) => !classified.has(k));
    expect(unclassified, "新 token 必须归类为前景/表面/结构性").toEqual([]);
  });

  it.each(THEMES)("%s：每个已归类的名字都真的存在对应 token", (_name, tokens) => {
    // 反向检查：否则删掉一个 token 会让断言在 relativeLuminance 里抛
    // 「不是 6 位十六进制颜色：undefined」，而不是清楚地说少了哪个。
    const missing = CLASSIFIED.filter((k) => !(k in tokens));
    expect(missing).toEqual([]);
  });

  it("两个主题定义同一组 token", () => {
    // 先前写成「每个主题都和 LIGHT 比」，其中 light 那一次是和自己比，是个恒真断言。
    expect(Object.keys(DARK).sort()).toEqual(Object.keys(LIGHT).sort());
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
});

/*
 * accent-fill 是填充，不是表面。
 *
 * 它只有 on-accent-fill 一个合法前景（实测 5.90）。其余前景压在它上面
 * 全部不及格：text-muted 2.22、accent-fg 1.92、error 2.09，深色下
 * text-muted 更低到 1.28。
 *
 * 直接后果，Phase 9 必须遵守：**选中行不能用 accent-fill 做整行背景**。
 * 一旦那样做，行内的次要文字（时间、延迟、备注）就不可读。选中态与
 * 警告态同理，用 3px 左边框实色表达；accent-fill 只用在按钮、选中指示条
 * 这类只承载主文案的紧凑元素上。
 *
 * 下面第二条断言故意把「不合格」这件事也钉住：它记录的是这条限制的
 * 理由，避免后来者以为「把 accent-fill 加进 SURFACES 就好了」。
 */
describe("accent-fill 作为填充的约束", () => {
  it.each(THEMES)("%s：on-accent-fill 在 accent-fill 上 ≥4.5:1", (_name, tokens) => {
    const ratio = contrastRatio(tokens["on-accent-fill"]!, tokens["accent-fill"]!);
    expect(ratio, `= ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
  });

  it.each(THEMES)("%s：次要文字压在 accent-fill 上确实不可读", (_name, tokens) => {
    const ratio = contrastRatio(tokens["text-muted"]!, tokens["accent-fill"]!);
    expect(
      ratio,
      "若此处变为及格，说明 accent-fill 被调过，需重新评估它能否作行背景",
    ).toBeLessThan(4.5);
  });
});

/*
 * @theme 映射必须与 token 一起检查。
 *
 * token 定义得再对，只要 @theme 里少一条 --color-X 映射，Tailwind 就不会
 * 生成对应工具类：`text-warn` 直接消失，StatusIndicator 渲染出一个没有
 * 颜色类的状态。实测删掉 --color-warn 后 53 条断言照样全绿 ——
 * 这是连接「token 值」与「渲染像素」的唯一一环，不能不设关卡。
 */
describe("@theme 映射", () => {
  const mappings = parseThemeMappings(CSS);

  it("每个 token 都有对应的 --color-* 映射", () => {
    const mapped = new Set(Object.values(mappings));
    const unmapped = CLASSIFIED.filter((k) => !mapped.has(k));
    expect(unmapped, "缺映射的 token 不会生成工具类").toEqual([]);
  });

  it("--color-* 的名字必须与 token 同名", () => {
    /*
     * 先前只检查了映射的**值**(token 名),没检查**键**(工具类名)。
     * 于是把 `--color-warn` 改名成 `--color-warning` 照样全绿 ——
     * 而产物 CSS 里 `.text-warn` 直接消失,StatusIndicator 渲染出一个
     * 没有颜色类的状态。实测确认过这个洞。
     *
     * 工具类名由 --color-* 的后缀决定,所以它必须逐字等于 token 名:
     * 组件里写的是 `text-warn`,token 叫 `warn`,中间这条映射不能改名。
     */
    for (const token of CLASSIFIED) {
      expect(mappings[token], `缺 --color-${token},.text-${token}/.bg-${token} 不会生成`).toBe(
        token,
      );
    }
  });

  it("每个 --color-* 都引用一个真实存在的 token,不写字面色值", () => {
    // 字面色值绕开了整套对比度关卡;引用不存在的 token 则生成不出工具类。
    const bad = Object.entries(mappings).filter(([, value]) => !(value in LIGHT));
    expect(bad, "--color-* 只能是 var(--zg-<已定义 token>)").toEqual([]);
  });
});

/*
 * 状态色的色相分布。
 *
 * 六个语义色里 accent-fg ↔ error 只差约 14°，二色性下四个状态会塌缩到
 * ≤1.28 的可分辨度（三色性下 1.01，即完全不可分）。这就是 StatusIndicator
 * 在类型与运行期都强制图标 + 文字标签的原因 —— 这里断言的是「色相靠得太近」
 * 这个事实本身成立，防止有人误以为调色就能解决，从而把图标要求当成可选项。
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

/*
 * 禁用态的文字对比度。
 *
 * ## 为什么这一节必须存在
 *
 * 上面那套笛卡尔积检查的是**原始 token 两两组合**，而禁用态是**合成出来的**
 * 颜色:`disabled:opacity-60` 会把底色与文字一起往父表面混,于是一对
 * 本来 5.90 的组合在屏幕上只剩 2.51 —— 而没有任何一条 token 断言能看见它,
 * 因为参与运算的两个 token 都没变。
 *
 * 第八轮审核实测出这个洞:`PrimaryButton` 的注释写着「禁用态**保留文字
 * 对比度** —— 一个读不清的禁用按钮无法告诉用户它为什么禁用」,而实现
 * 用的正是 `opacity-60`,把那句话破坏得干干净净。三处按钮（主操作、
 * 代理池的次操作、表格翻页）全中,而禁用态恰好是这些按钮**最要紧**的时刻:
 * 文案是「进行中…」「探测中…」,正是用户想读的那一句。
 *
 * 所以现在的做法是**换实色**而不是降透明度,并在这里把结果钉住。
 */
describe("禁用态仍然可读", () => {
  /** 禁用态用到的实色组合 —— 与 `Panel.tsx` / `DataTable.tsx` 的类名一致。 */
  const DISABLED_PAIRS = [
    // 主操作:底色换成 border-strong，文字保持 text。
    { name: "主操作按钮", fg: "text", bg: "border-strong" },
    // 描边按钮（次操作、翻页）:底色是表面，文字降到 text-muted。
    { name: "描边按钮 on surface", fg: "text-muted", bg: "surface" },
    { name: "描边按钮 on bg", fg: "text-muted", bg: "bg" },
  ] as const;

  for (const theme of ["light", "dark"] as const) {
    const tokens: TokenMap = theme === "light" ? LIGHT : DARK;
    for (const pair of DISABLED_PAIRS) {
      it(`${theme} · ${pair.name} ≥4.5`, () => {
        const fg = tokens[pair.fg];
        const bg = tokens[pair.bg];
        expect(fg, `缺 token ${pair.fg}`).toBeDefined();
        expect(bg, `缺 token ${pair.bg}`).toBeDefined();
        expect(contrastRatio(fg!, bg!)).toBeGreaterThanOrEqual(4.5);
      });
    }
  }

  it("不再用 opacity 表达禁用 —— 它会把文字一起淡掉", () => {
    /*
     * 直接扫源码。这条断言的对象不是颜色而是**手法**:只要有人再写
     * `disabled:opacity-*`，合成后的对比度就脱离了上面所有 token 断言的视野。
     */
    const files = [
      "../../src/admin/components/Panel.tsx",
      "../../src/admin/components/DataTable.tsx",
      "../../src/admin/pages/ProxyPage.tsx",
    ];
    for (const rel of files) {
      const src = readFileSync(new URL(rel, import.meta.url), "utf8");
      // 注释里提到这个类名是允许的（那里在解释为什么不用它）。
      const code = stripComments(src);
      expect(code, `${rel} 又用了 disabled:opacity`).not.toMatch(/disabled:opacity-/);
    }
  });
});
