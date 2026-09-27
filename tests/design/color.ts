/**
 * WCAG 对比度计算 + token 文件解析。
 *
 * 存在的理由：Anthropic 官方品牌色里有四个在米白底上不及格，这是算出来才发现的。
 * 如果只在设计阶段人工核一次，之后任何人调一次色值都会静默破坏无障碍，
 * 所以对比度是 `npm run validate` 的一部分，而不是一次性的人工步骤。
 *
 * 本文件自身也必须进 typecheck（tsconfig.test.json）——
 * 它实现的是这道关卡赖以成立的算术，不能是唯一没人检查的地方。
 */

export type TokenMap = Record<string, string>;

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function relativeLuminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`不是 6 位十六进制颜色：${hex}`);
  const n = parseInt(m[1]!, 16);
  const r = channel((n >> 16) & 0xff);
  const g = channel((n >> 8) & 0xff);
  const b = channel(n & 0xff);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * 去掉 CSS 注释。
 *
 * 必须在解析之前做，否则注释里的色值会被当成真的声明。
 * 实测过的失败形态：真实声明是不及格的 `--zg-warn: #8a6a12`，
 * 后面跟一句 `/* 压深前的值：--zg-warn: #75580d *\/`，
 * 解析器按「最后匹配生效」读出 #75580d，**断言全绿而线上 CSS 不合规**。
 * tokens.css 里本来就有一条引用旧色值的注释，离触发只差一次文档编辑。
 */
export function stripComments(css: string): string {
  // 用等长空格替换，保持后续 indexOf 的位置语义不变。
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length));
}

/**
 * 找出**全部**匹配该选择器的块体(不含花括号)。
 *
 * 必须找全部,不能只取第一个:CSS 允许同一选择器出现多次,后出现的覆盖先出现的。
 * 只解析首个块时,在文件末尾追加一个 `:root { --zg-warn: #ffff00 }` 就能让
 * 线上颜色被改掉而**断言全绿** —— 实测确认过,产物 CSS 里是后者生效。
 * 同理适用于第二个 `@theme` 块。
 *
 * 必须匹配「选择器紧跟 `{`」而不是选择器的首次出现:
 * `[data-theme="dark"]` 也出现在文件顶部的 `@custom-variant` 声明里,
 * 按首次出现取块会拿到 :root 的内容,于是深色主题被静默当成浅色来断言。
 */
function findBlocks(css: string, selector: string): string[] {
  const bodies: string[] = [];
  for (let from = 0; ; ) {
    const at = css.indexOf(selector, from);
    if (at === -1) break;

    const rest = css.slice(at + selector.length);
    const brace = /^\s*\{/.exec(rest);
    /*
     * 选择器必须是整条规则的开头（前面是块边界或空白），否则 `[data-theme="dark"]` 会匹配到
     * `:root[data-skin="warm"][data-theme="dark"] {` 的尾巴，把暖色深色并进默认深色。
     */
    const before = css.slice(0, at).trimEnd();
    const startsRule = before === "" || before.endsWith("}") || before.endsWith("{") || before.endsWith(";");
    if (!brace || !startsRule) {
      from = at + selector.length;
      continue;
    }

    const open = at + selector.length + brace[0].length - 1;
    const close = css.indexOf("}", open);
    if (close === -1) throw new Error(`选择器块不完整：${selector}`);

    bodies.push(css.slice(open + 1, close));
    from = close + 1;
  }
  return bodies;
}

/**
 * 从 tokens.css 中取出某个选择器下的全部 `--zg-*` 声明。
 *
 * **只接受字面量十六进制值**:token 层不允许 `var()` 间接引用、命名颜色或
 * 运行期计算的颜色,否则这里无法静态断言,整套规则也就失去强制力。
 * 遇到非十六进制的 `--zg-*` 声明直接报错 —— 先前是静默跳过,于是
 * `--zg-ring: red` 这类 token 既不被校验对比度,也能通过「每个 token 都被
 * 显式归类」的穷举检查,等于凭空开了个后门。
 */
export function parseTokenBlock(rawCss: string, selector: string): TokenMap {
  const css = stripComments(rawCss);
  const bodies = findBlocks(css, selector);
  if (bodies.length === 0) throw new Error(`tokens.css 中找不到选择器块：${selector}`);

  const out: TokenMap = {};
  for (const body of bodies) {
    for (const line of body.split(";")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("--zg-")) continue;

      const m = /^--zg-([a-z0-9-]+)\s*:\s*(.+)$/.exec(trimmed);
      if (!m) throw new Error(`${selector} 中有无法解析的 token 声明：${trimmed.slice(0, 40)}`);

      const [, key, rawValue] = m as unknown as [string, string, string];
      const value = rawValue.trim();
      // 透明度不是颜色：`--zg-*-alpha` 由 `parseAlphaBlock` 单独读出并参与合成色断言。
      if (key.endsWith("-alpha")) continue;
      if (!/^#[0-9a-fA-F]{6}$/.test(value)) {
        throw new Error(
          `--zg-${key} 的值必须是 6 位字面量十六进制（收到 ${value.slice(0, 20)}）——` +
            "token 层不允许 var()、命名颜色或运行期计算值,否则对比度无法静态断言",
        );
      }
      // 重复键报错而非后者覆盖:同一个 token 写两遍时,「哪个生效」
      // 取决于 CSS 层叠而不是本解析器,静默取一个必然与线上不一致。
      // 跨块重复同理 —— 追加一个同选择器的块正是绕过关卡的方式。
      if (key in out) throw new Error(`${selector} 中 --zg-${key} 重复声明`);
      out[key] = value.toLowerCase();
    }
  }
  return out;
}

/**
 * 读出某个选择器下的 `--zg-*-alpha` 百分比（0–1）。只接受 `NN%`：其余写法同样报错，
 * 否则一个写错的透明度会让合成色断言在默认值上通过。
 */
export function parseAlphaBlock(rawCss: string, selector: string): Record<string, number> {
  const css = stripComments(rawCss);
  const out: Record<string, number> = {};
  for (const body of findBlocks(css, selector)) {
    for (const line of body.split(";")) {
      const m = /^--zg-([a-z0-9-]+-alpha)\s*:\s*(.+)$/.exec(line.trim());
      if (!m) continue;
      const pct = /^(\d{1,3})%$/.exec(m[2]!.trim());
      if (!pct || Number(pct[1]) > 100) throw new Error(`--zg-${m[1]} 必须是 0–100%（收到 ${m[2]}）`);
      if (m[1]! in out) throw new Error(`${selector} 中 --zg-${m[1]} 重复声明`);
      out[m[1]!] = Number(pct[1]) / 100;
    }
  }
  return out;
}

/** 把前景色按 alpha 叠在背景色上（sRGB 线性插值，与 `color-mix(in srgb, …)` 一致）。 */
export function composite(fg: string, bg: string, alpha: number): string {
  const rgb = (h: string) => {
    const n = parseInt(h.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const f = rgb(fg);
  const b = rgb(bg);
  return `#${f.map((v, i) => Math.round(v * alpha + b[i]! * (1 - alpha)).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * 解析 `@theme` 块里的 `--color-*` 映射。
 *
 * 必须一起检查：token 定义得再对，只要 @theme 里少一条映射，
 * Tailwind 就不会生成对应的工具类，`text-warn` 直接消失，
 * 组件渲染出一个没有颜色类的状态 —— 而只看 :root 的关卡对此全无感知。
 * 实测删掉 `--color-warn` 后断言照样全绿。
 *
 * 返回 `--color-X` → 其引用的 token 名（`var(--zg-Y)` 里的 Y），
 * 字面量色值则记为 `#rrggbb` 形态以便单独拒绝。
 */
export function parseThemeMappings(rawCss: string): Record<string, string> {
  const css = stripComments(rawCss);
  const bodies = findBlocks(css, "@theme");
  if (bodies.length === 0) throw new Error("tokens.css 中找不到 @theme 块");

  const out: Record<string, string> = {};
  for (const body of bodies) {
    for (const line of body.split(";")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("--color-")) continue;

      const viaVar = /^--color-([a-z0-9-]+)\s*:\s*var\(\s*--zg-([a-z0-9-]+)\s*\)$/.exec(trimmed);
      if (viaVar) {
        const name = viaVar[1]!;
        if (name in out) throw new Error(`@theme 中 --color-${name} 重复声明`);
        out[name] = viaVar[2]!;
        continue;
      }
      // 非 var() 形态一律记下原值,供「只能引用 var(--zg-*)」那条断言拒绝。
      const literal = /^--color-([a-z0-9-]+)\s*:\s*(.+)$/.exec(trimmed);
      if (literal) {
        const name = literal[1]!;
        if (name in out) throw new Error(`@theme 中 --color-${name} 重复声明`);
        out[name] = literal[2]!.trim().toLowerCase();
      }
    }
  }
  return out;
}
