/**
 * WCAG 对比度计算 + token 文件解析。
 *
 * 存在的理由：Anthropic 官方品牌色里有四个在米白底上不及格，这是算出来才发现的。
 * 如果只在设计阶段人工核一次，之后任何人调一次色值都会静默破坏无障碍，
 * 所以对比度是 `npm run validate` 的一部分，而不是一次性的人工步骤。
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
export function parseTokenBlock(css: string, selector: string): TokenMap {
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
    if (m) out[m[1]!] = m[2]!.toLowerCase();
  }
  return out;
}
