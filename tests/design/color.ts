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
 * 解析器按「最后匹配生效」读出 #75580d，**53 条断言全绿而线上 CSS 不合规**。
 * tokens.css 里本来就有一条引用旧色值的注释，离触发只差一次文档编辑。
 */
export function stripComments(css: string): string {
  // 用等长空格替换，保持后续 indexOf 的位置语义不变。
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length));
}

/**
 * 从 tokens.css 中取出某个选择器块内的 `--zg-*` 声明。
 *
 * 故意只认字面量十六进制值：token 层不允许出现 `var()` 间接引用或
 * 运行期计算的颜色，否则这里就无法静态断言，规则也就失去强制力。
 *
 * 必须匹配「选择器紧跟 `{`」而不是选择器的首次出现：
 * `[data-theme="dark"]` 也出现在文件顶部的 `@custom-variant` 声明里，
 * 按首次出现取块会拿到 :root 的内容，于是深色主题被静默当成浅色来断言
 * —— 这正是本函数第一版的 bug。
 */
export function parseTokenBlock(rawCss: string, selector: string): TokenMap {
  const css = stripComments(rawCss);

  let open = -1;
  for (let from = 0; ; ) {
    const at = css.indexOf(selector, from);
    if (at === -1) break;
    const rest = css.slice(at + selector.length);
    const brace = /^\s*\{/.exec(rest);
    if (brace) {
      open = at + selector.length + brace[0].length - 1;
      break;
    }
    from = at + selector.length;
  }
  if (open === -1) throw new Error(`tokens.css 中找不到选择器块：${selector}`);

  const close = css.indexOf("}", open);
  if (close === -1) throw new Error(`选择器块不完整：${selector}`);
  const body = css.slice(open + 1, close);

  const out: TokenMap = {};
  for (const line of body.split(";")) {
    const m = /--zg-([a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*$/.exec(line.trim());
    if (!m) continue;
    const [, key, value] = m as unknown as [string, string, string];
    // 重复键报错而非后者覆盖：同一个 token 写两遍时，「哪个生效」
    // 取决于 CSS 层叠而不是本解析器，静默取一个必然与线上不一致。
    if (key in out) throw new Error(`${selector} 中 --zg-${key} 重复声明`);
    out[key] = value.toLowerCase();
  }
  return out;
}

/**
 * 解析 `@theme` 块里的 `--color-*` 映射。
 *
 * 必须一起检查：token 定义得再对，只要 @theme 里少一条映射，
 * Tailwind 就不会生成对应的工具类，`text-warn` 直接消失，
 * 组件渲染出一个没有颜色类的状态 —— 而只看 :root 的关卡对此全无感知。
 * 实测删掉 `--color-warn` 后 53 条断言照样全绿。
 *
 * 返回 `--color-X` → 其引用的 token 名（`var(--zg-Y)` 里的 Y），
 * 字面量色值则记为 `#rrggbb` 形态以便单独拒绝。
 */
export function parseThemeMappings(rawCss: string): Record<string, string> {
  const css = stripComments(rawCss);
  const at = css.indexOf("@theme");
  if (at === -1) throw new Error("tokens.css 中找不到 @theme 块");
  const open = css.indexOf("{", at);
  const close = css.indexOf("}", open);
  if (open === -1 || close === -1) throw new Error("@theme 块不完整");

  const out: Record<string, string> = {};
  for (const line of css.slice(open + 1, close).split(";")) {
    const trimmed = line.trim();
    const viaVar = /--color-([a-z0-9-]+)\s*:\s*var\(\s*--zg-([a-z0-9-]+)\s*\)$/.exec(trimmed);
    if (viaVar) {
      out[viaVar[1]!] = viaVar[2]!;
      continue;
    }
    const literal = /--color-([a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})$/.exec(trimmed);
    if (literal) out[literal[1]!] = literal[2]!.toLowerCase();
  }
  return out;
}
