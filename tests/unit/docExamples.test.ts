import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ConfigSchema } from "../../src/shared/schema.ts";

/**
 * 文档里的配置示例必须真的能通过 schema。
 *
 * ## 为什么需要这道关卡
 *
 * 第六轮审核在 `docs/usage.md` 里查出一个示例**自己违反了同一份文档
 * 28 行前刚解释过的校验**:出口绑定示例(文档自称\"核心功能\")的 `w2`
 * 引用了一个未定义的代理 id —— 用户照抄会直接启动失败。
 *
 * 这类错误靠人读是抓不住的(我读过那段三次都没发现),但喂给
 * `ConfigSchema.safeParse` 一秒就出来。纪律里写着「配置示例喂给 schema
 * 的 safeParse 跑一遍」,先前那是一条**手工**约定,没有任何东西强制它 ——
 * 于是它被漏掉了。这个文件把它变成 `validate` 的一部分。
 *
 * ## 为什么解析 Markdown 而不是把示例抽成 fixture 文件
 *
 * 抽成 fixture 会让文档里的那份变成\"没人检查的副本\",错误照样能写进去。
 * 关卡必须钉住**用户真正会照抄的那几个字节**。
 */

/**
 * 占位符替换。
 *
 * 文档示例里的凭证写成 `<zen key>` / `<首启自动生成的 43 字符>` 这类占位符 ——
 * 那是**故意**的，示例不该带真值（纪律：测试与文档只用明显虚构的凭证）。
 * 但占位符过不了 schema 的字符集与长度校验，于是检查前统一换成合法的假值。
 *
 * 只替换 `<...>` 形态的字符串，不碰示例写下的任何真实取值 ——
 * 要检查的是**结构与引用**，不是占位符本身。
 */
function fillPlaceholders(value: unknown): unknown {
  if (typeof value === "string") {
    return /^<.*>$/.test(value) ? "P".repeat(43) : value;
  }
  if (Array.isArray(value)) return value.map(fillPlaceholders);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, fillPlaceholders(v)]),
    );
  }
  return value;
}

const USAGE_MD = fileURLToPath(new URL("../../docs/usage.md", import.meta.url));

/** 去掉 jsonc 的 `//` 行内注释,但不能碰 URL 里的 `//`。 */
function stripJsoncComments(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/(?<!:)\/\/.*$/, ""))
    .join("\n");
}

function jsoncBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/```jsonc\n([\s\S]*?)```/g)].map((m) => m[1]!);
}

/**
 * 只取**网关自己的** config 示例 —— 不是 `opencode.json`（那是客户端配置）。
 *
 * ## 判据：顶层键落在 `ConfigSchema` 的已知键集合里
 *
 * 先前的判据是「以 `{` 开头且含顶层 `version` 或 `workers`」，于是
 * `"subscriptions": [...]` 这种**片段示例**被静默跳过（第十轮审核查出：
 * 那个片段写错了没有任何东西会红）。片段不以 `{` 开头，而文档里用片段
 * 举例是很自然的写法 —— 下一个片段仍会被漏掉。
 *
 * 现在按键名判：片段自动补成 `{ ... }` 再看它的顶层键是否全在
 * `ConfigSchema` 的已知键里。这个集合从 schema 推导（纪律 #4），
 * 所以加字段时自动跟上。
 */
const CONFIG_KEYS = new Set(Object.keys(ConfigSchema.shape));

function gatewayConfigBlocks(blocks: string[]): Array<{ body: string; wasFragment: boolean }> {
  const out: Array<{ body: string; wasFragment: boolean }> = [];
  for (const b of blocks) {
    const raw = stripJsoncComments(b).trim();
    const wasFragment = !raw.startsWith("{");
    // 片段补成对象再判 —— `"subscriptions": [...]` → `{"subscriptions": [...]}`。
    const body = wasFragment ? `{${raw.replace(/,\s*$/, "")}}` : raw;

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      continue; // 不是合法 JSON 的块（伪代码、片段的片段）不在本关卡范围内。
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;

    const keys = Object.keys(parsed);
    if (keys.length === 0) continue;
    // 全部顶层键都是 Config 的键 —— 排除 `opencode.json`（`$schema`/`provider`）。
    if (!keys.every((k) => CONFIG_KEYS.has(k))) continue;

    out.push({ body, wasFragment });
  }
  return out;
}

describe("docs/usage.md 的配置示例", () => {
  const markdown = readFileSync(USAGE_MD, "utf8");
  const blocks = gatewayConfigBlocks(jsoncBlocks(markdown));

  it("确实找到了要检查的示例 —— 否则这个文件是个空壳", () => {
    /*
     * 这条断言存在的理由:如果正则哪天匹配不到任何东西(文档改了围栏语言、
     * 示例被挪走),下面那条 `for...of` 会**零次循环然后通过**,
     * 于是整个关卡静默失效。空输入集是变异存活的第三类,必须显式排除。
     *
     * **下界必须贴着实际块数**（第十轮审核）：先前写 `>= 2` 而实际就是 2，
     * 于是再漏一个也不会红 —— 一个"恰好等于实际值"的下界等于没有下界。
     * 本机实测 3 个（主配置、出口绑定、subscriptions 片段）。
     */
    expect(blocks.length).toBeGreaterThanOrEqual(3);
  });

  it("**片段示例也在检查范围内** —— 不以 `{` 开头的那些先前被静默跳过", () => {
    /*
     * `"subscriptions": [...]` 这类片段先前过不了「以 `{` 开头」那道判据，
     * 于是它写错了没有任何东西会红。片段是文档里很自然的写法，
     * 所以判据改成按顶层键名判（从 `ConfigSchema.shape` 推导）。
     */
    expect(blocks.some((b) => b.wasFragment), "一个片段示例都没匹配到？判据可能又收窄了").toBe(true);
  });

  it("每个示例都能通过 ConfigSchema —— 用户照抄不会启动失败", () => {
    for (const [index, block] of blocks.entries()) {
      // `gatewayConfigBlocks` 已经把片段补成对象并确认它是合法 JSON。
      const parsed: unknown = JSON.parse(block.body);

      // 示例是**片段**,缺的必填项用最小合法值补齐 ——
      // 要检查的是示例写下的那些字段,不是它有没有写全。
      // 占位符先换成合法假值,见 fillPlaceholders 的说明。
      const candidate = {
        version: 1,
        ...(fillPlaceholders(parsed) as Record<string, unknown>),
        gateway: {
          relayToken: "A".repeat(32),
          ...(((fillPlaceholders(parsed) as Record<string, unknown>).gateway as
            | Record<string, unknown>
            | undefined) ?? {}),
        },
      };

      const result = ConfigSchema.safeParse(candidate);
      if (!result.success) {
        const issues = result.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ");
        throw new Error(`第 ${index + 1} 个 jsonc 示例通不过 ConfigSchema —— ${issues}`);
      }
    }
  });

  it("引用完整性:示例里的 proxyId / bridgeId / activeBridgeId 都指向自己定义的东西", () => {
    /*
     * 这条与上一条不重复。ConfigSchema 的 superRefine 确实校验引用完整性,
     * 但**只在示例同时给出 workers 与 proxies 时**才有东西可查;
     * 而上一条补齐的是 gateway,不会补 proxies。所以这里显式针对
     * \"示例内部自洽\"再断言一次 —— 第六轮查出的正是这一类。
     */
    for (const [index, block] of blocks.entries()) {
      const cfg = JSON.parse(block.body) as {
        workers?: Array<{ id: string; proxyId?: string | null }>;
        proxies?: Array<{ id: string; bridgeId?: string }>;
        clash?: { activeBridgeId?: string | null; bridges?: Array<{ id: string }> };
      };

      const proxyIds = new Set((cfg.proxies ?? []).map((p) => p.id));
      const bridgeIds = new Set((cfg.clash?.bridges ?? []).map((b) => b.id));

      for (const w of cfg.workers ?? []) {
        if (w.proxyId !== undefined && w.proxyId !== null) {
          expect(proxyIds, `示例 ${index + 1} 的 worker ${w.id} 引用了未定义的代理`).toContain(
            w.proxyId,
          );
        }
      }
      for (const p of cfg.proxies ?? []) {
        if (p.bridgeId !== undefined) {
          expect(bridgeIds, `示例 ${index + 1} 的代理 ${p.id} 引用了未定义的内核`).toContain(
            p.bridgeId,
          );
        }
      }
      const active = cfg.clash?.activeBridgeId;
      if (active !== undefined && active !== null) {
        expect(bridgeIds, `示例 ${index + 1} 的 activeBridgeId 指向未定义的内核`).toContain(active);
      }
    }
  });
});
