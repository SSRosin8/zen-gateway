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

/** 只取网关自己的 config 示例:以 `{` 开头且含顶层 `version` 或 `workers`。 */
function gatewayConfigBlocks(blocks: string[]): string[] {
  return blocks.filter((b) => {
    const body = stripJsoncComments(b).trim();
    if (!body.startsWith("{")) return false;
    return /"version"\s*:/.test(body) || /"workers"\s*:/.test(body);
  });
}

describe("docs/usage.md 的配置示例", () => {
  const markdown = readFileSync(USAGE_MD, "utf8");
  const blocks = gatewayConfigBlocks(jsoncBlocks(markdown));

  it("确实找到了要检查的示例 —— 否则这个文件是个空壳", () => {
    /*
     * 这条断言存在的理由:如果正则哪天匹配不到任何东西(文档改了围栏语言、
     * 示例被挪走),下面那条 `for...of` 会**零次循环然后通过**,
     * 于是整个关卡静默失效。空输入集是变异存活的第三类,必须显式排除。
     */
    expect(blocks.length).toBeGreaterThanOrEqual(2);
  });

  it("每个示例都能通过 ConfigSchema —— 用户照抄不会启动失败", () => {
    for (const [index, block] of blocks.entries()) {
      const body = stripJsoncComments(block);

      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch (err) {
        throw new Error(
          `第 ${index + 1} 个 jsonc 示例不是合法 JSON(去注释后):${(err as Error).message}`,
        );
      }

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
      const cfg = JSON.parse(stripJsoncComments(block)) as {
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
