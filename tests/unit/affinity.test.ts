import { describe, expect, it } from "vitest";
import {
  AffinityMap,
  containsStaleReasoning,
  digestOf,
  extractBlobHashes,
  normalizeSessionKey,
  STALE_PATTERN_WINDOW,
} from "../../src/core/routing/affinity.ts";

/**
 * 会话亲和的单测。时钟全部注入。
 */

const NOW = 1_800_000_000_000;
const TTL = 3_600_000;
const always = (): boolean => true;
const never = (): boolean => false;

/** 长度够格的假推理块。`digestOf` 的入参必须 ≥16 字符才会被收集。 */
const BLOB_A = "encrypted-blob-a-not-real-content";
const BLOB_B = "encrypted-blob-b-not-real-content";

describe("digestOf", () => {
  it("产出 64 个小写十六进制字符", () => {
    /*
     * 这个形态不是风格偏好:`session_affinity` 与 `blob_affinity` 两张表有
     * `CHECK (length = 64 AND NOT GLOB '*[^0-9a-f]*')`。形态不一致时
     * Phase 7 接持久化会在 SQLite 的 CHECK 上炸,而那时离这里已经很远。
     */
    expect(digestOf("任意输入")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("CJK 与超长输入同样合规", () => {
    expect(digestOf("你好".repeat(10_000))).toMatch(/^[0-9a-f]{64}$/);
  });

  it("不同输入不同摘要,相同输入稳定", () => {
    expect(digestOf("a")).not.toBe(digestOf("b"));
    expect(digestOf("a")).toBe(digestOf("a"));
  });
});

describe("normalizeSessionKey", () => {
  it("非字符串与空值返回 null", () => {
    for (const bad of [null, undefined, 42, {}, [], "", "   "]) {
      expect(normalizeSessionKey(bad)).toBeNull();
    }
  });

  it("CR/LF/Tab 被替换而不是抛错", () => {
    /*
     * 这个值先前已被当作 HTTP 头(`x-opencode-session`)校验过,而那里对
     * 含控制字符的值是**抛错**。这里不抛:亲和只是优化,一个奇怪的会话键
     * 不该让请求失败。
     */
    expect(normalizeSessionKey("ses\r\n123")).toBe("ses 123");
    expect(normalizeSessionKey("ses\t\t456")).toBe("ses 456");
  });

  it("超长键被截断,不能让客户端头无界增长", () => {
    const long = "x".repeat(10_000);
    expect(normalizeSessionKey(long)).toHaveLength(256);
  });
});

describe("extractBlobHashes", () => {
  it("非对象返回空数组", () => {
    for (const bad of [null, undefined, 42, "字符串", true]) {
      expect(extractBlobHashes(bad)).toEqual([]);
    }
  });

  it("收集 encrypted_content 与 signature", () => {
    const hashes = extractBlobHashes({
      messages: [
        { role: "assistant", reasoning: { encrypted_content: BLOB_A } },
        { role: "assistant", thinking: { signature: BLOB_B } },
      ],
    });
    expect(hashes).toHaveLength(2);
    expect(hashes).toContain(digestOf(BLOB_A));
    expect(hashes).toContain(digestOf(BLOB_B));
  });

  it("只产出摘要,绝不产出原文", () => {
    /*
     * 结果会进内存映射、日志、以及 Phase 7 的磁盘表。原文是用户对话的一部分。
     */
    const hashes = extractBlobHashes({ a: { encrypted_content: BLOB_A } });
    expect(hashes.join(",")).not.toContain(BLOB_A);
    for (const hash of hashes) expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("同一个值出现多次只记一次", () => {
    expect(
      extractBlobHashes({ a: { signature: BLOB_A }, b: { signature: BLOB_A } }),
    ).toHaveLength(1);
  });

  it("太短的值被跳过 —— 它不可能是加密推理块", () => {
    expect(extractBlobHashes({ a: { signature: "short" } })).toEqual([]);
  });

  it("过长的值被跳过", () => {
    expect(extractBlobHashes({ a: { signature: "x".repeat(20_000) } })).toEqual([]);
  });

  it("非字符串的同名字段被忽略", () => {
    expect(extractBlobHashes({ a: { signature: { nested: BLOB_A } } })).toEqual([]);
  });

  it("深度嵌套不会爆栈,而是到上限就停", () => {
    /*
     * 请求体来自客户端。无界遍历让一个畸形请求体把 CPU 占满,
     * 而且发生在**转发之前** —— 上游还没参与,故障完全在我们这边。
     */
    let deep: Record<string, unknown> = { signature: BLOB_A };
    for (let i = 0; i < 2_000; i += 1) deep = { nested: deep };
    expect(() => extractBlobHashes(deep)).not.toThrow();
    // 超过 MAX_TRAVERSE_DEPTH 的层里那个 blob 取不到 —— 这是刻意的取舍。
    expect(extractBlobHashes(deep)).toEqual([]);
  });

  it("超宽数组不会无界遍历", () => {
    const wide = { messages: Array.from({ length: 50_000 }, () => ({ signature: BLOB_A })) };
    expect(() => extractBlobHashes(wide)).not.toThrow();
  });

  it("最多收集 64 个不同指纹", () => {
    const many = {
      messages: Array.from({ length: 500 }, (_unused, i) => ({
        signature: `encrypted-blob-${i}-not-real-content`,
      })),
    };
    expect(extractBlobHashes(many).length).toBeLessThanOrEqual(64);
  });

  it("环状引用不会死循环", () => {
    /*
     * `JSON.parse` 产出的对象不可能有环,所以这在生产路径上不可达 ——
     * 但本函数签名接受 `unknown`,而测试与将来的调用方可以传任何东西。
     * 遍历节点数上限同时兜住了这一类。
     */
    const cyclic: Record<string, unknown> = { signature: BLOB_A };
    cyclic["self"] = cyclic;
    expect(() => extractBlobHashes(cyclic)).not.toThrow();
  });
});

describe("containsStaleReasoning", () => {
  it.each([
    "reasoning block was not issued to this caller",
    "Invalid signature for reasoning block",
    "signature is required",
    "signature missing",
    "reasoning content requires a valid signature",
  ])("识别:%s", (text) => {
    expect(containsStaleReasoning(text)).toBe(true);
  });

  it("大小写无关", () => {
    expect(containsStaleReasoning("NOT ISSUED TO THIS CALLER")).toBe(true);
  });

  it("普通内容不误判", () => {
    for (const ok of [
      "",
      "rate limit exceeded",
      "The quick brown fox",
      '{"choices":[{"delta":{"content":"你好"}}]}',
      "model is unavailable",
    ]) {
      expect(containsStaleReasoning(ok)).toBe(false);
    }
  });

  it("STALE_PATTERN_WINDOW 足够覆盖最长的模式", () => {
    /*
     * 跨块扫描的重叠窗口取这个值。短于最长可能匹配就会漏,
     * 而漏掉的症状取决于上游的分块位置 —— 时有时无,极难复现。
     *
     * 最长的模式是 `/reasoning.{0,40}signature/`:9 + 40 + 9 = 58 字符。
     */
    expect(STALE_PATTERN_WINDOW).toBeGreaterThanOrEqual(58);
  });
});

describe("AffinityMap:会话绑定", () => {
  it("绑定后能查到", () => {
    const map = new AffinityMap();
    map.bindSession("hash1", "w1", NOW);
    expect(map.lookupSession("hash1", NOW, TTL, always)).toBe("w1");
  });

  it("未绑定返回 null", () => {
    expect(new AffinityMap().lookupSession("nope", NOW, TTL, always)).toBeNull();
  });

  it("超过 TTL 后失效", () => {
    const map = new AffinityMap();
    map.bindSession("hash1", "w1", NOW);
    expect(map.lookupSession("hash1", NOW + TTL, TTL, always)).toBe("w1");
    expect(map.lookupSession("hash1", NOW + TTL + 1, TTL, always)).toBeNull();
  });

  it("Worker 已从配置删除时立刻失效", () => {
    /*
     * 不检查会让一条老绑定反复指向一个不存在的 id,表现为「粘滞完全不生效」
     * 而原因在别处 —— 查的时候会以为是 TTL 或哈希算错了。
     */
    const map = new AffinityMap();
    map.bindSession("hash1", "w1", NOW);
    expect(map.lookupSession("hash1", NOW, TTL, never)).toBeNull();
  });

  it("失效的条目被就地删掉,不只是查不到", () => {
    const map = new AffinityMap();
    map.bindSession("hash1", "w1", NOW);
    map.lookupSession("hash1", NOW + TTL + 1, TTL, always);
    expect(map.sizes().sessions).toBe(0);
  });

  it("来自未来的绑定视为失效", () => {
    /*
     * 系统时钟回拨(或持久化文件被改)会产生 `at > now` 的条目。
     * 留着它会让 `now - at` 为负,于是 TTL 永远算不到头 —— 那条绑定
     * 事实上**永不过期**。
     */
    const map = new AffinityMap();
    map.bindSession("hash1", "w1", NOW + 60_000);
    expect(map.lookupSession("hash1", NOW, TTL, always)).toBeNull();
  });

  it("解绑后查不到", () => {
    const map = new AffinityMap();
    map.bindSession("hash1", "w1", NOW);
    map.unbindSession("hash1");
    expect(map.lookupSession("hash1", NOW, TTL, always)).toBeNull();
  });

  it("重新绑定覆盖旧的 Worker 与时间", () => {
    const map = new AffinityMap();
    map.bindSession("hash1", "w1", NOW);
    map.bindSession("hash1", "w2", NOW + 1000);
    expect(map.lookupSession("hash1", NOW + 1000, TTL, always)).toBe("w2");
    expect(map.sizes().sessions).toBe(1);
  });

  it("超出容量时淘汰最老的,而不是拒绝新的", () => {
    /*
     * 没有上限时一个长期运行的网关会把每个见过的会话键永久留在内存里 ——
     * TTL 只在读取时过滤,不会自己腾出空间。
     *
     * 淘汰最老而不是拒绝新的:新会话是**活跃**的,老会话大概率已结束。
     */
    const map = new AffinityMap();
    for (let i = 0; i < 10_050; i += 1) map.bindSession(`h${i}`, "w1", NOW + i);
    expect(map.sizes().sessions).toBe(10_000);
    // 最早的那些被挤掉,最新的还在。
    expect(map.lookupSession("h0", NOW + 10_050, TTL, always)).toBeNull();
    expect(map.lookupSession("h10049", NOW + 10_050, TTL, always)).toBe("w1");
  });
});

describe("AffinityMap:推理指纹", () => {
  it("学习后能提示", () => {
    const map = new AffinityMap();
    map.learnBlobs(["h1", "h2"], "w1", NOW);
    expect(map.findBlobWorker(["h1", "h2"], NOW, TTL, always)).toBe("w1");
  });

  it("空指纹列表不给提示", () => {
    const map = new AffinityMap();
    map.learnBlobs(["h1"], "w1", NOW);
    expect(map.findBlobWorker([], NOW, TTL, always)).toBeNull();
  });

  it("任何一个指纹未知就不给提示", () => {
    const map = new AffinityMap();
    map.learnBlobs(["h1"], "w1", NOW);
    expect(map.findBlobWorker(["h1", "unknown"], NOW, TTL, always)).toBeNull();
  });

  it("指纹指向不同 Worker 时不给提示", () => {
    /*
     * 这条是本文件里最容易写错的判断。
     *
     * 提示要回答「这批推理块是谁签发的」。若两个指纹指向不同 Worker,
     * 那这个请求混合了两个来源的推理,无论选谁都会被拒 —— 此时提示一个
     * **比不提示更糟**:它会抢在策略排序之前,把请求钉到必败的那个,
     * 而正常排序至少给了轮到另一个的机会。
     */
    const map = new AffinityMap();
    map.learnBlobs(["h1"], "w1", NOW);
    map.learnBlobs(["h2"], "w2", NOW);
    expect(map.findBlobWorker(["h1", "h2"], NOW, TTL, always)).toBeNull();
  });

  it("过期的指纹不给提示", () => {
    const map = new AffinityMap();
    map.learnBlobs(["h1"], "w1", NOW);
    expect(map.findBlobWorker(["h1"], NOW + TTL + 1, TTL, always)).toBeNull();
  });

  it("Worker 已删除时不给提示", () => {
    const map = new AffinityMap();
    map.learnBlobs(["h1"], "w1", NOW);
    expect(map.findBlobWorker(["h1"], NOW, TTL, never)).toBeNull();
  });

  it("忘掉指纹后不再提示", () => {
    const map = new AffinityMap();
    map.learnBlobs(["h1", "h2"], "w1", NOW);
    map.forgetBlobs(["h1"]);
    expect(map.findBlobWorker(["h1", "h2"], NOW, TTL, always)).toBeNull();
    expect(map.findBlobWorker(["h2"], NOW, TTL, always)).toBe("w1");
  });

  it("重新学习覆盖为新 Worker", () => {
    const map = new AffinityMap();
    map.learnBlobs(["h1"], "w1", NOW);
    map.learnBlobs(["h1"], "w2", NOW + 1000);
    expect(map.findBlobWorker(["h1"], NOW + 1000, TTL, always)).toBe("w2");
  });

  it("超出容量时淘汰最老的", () => {
    const map = new AffinityMap();
    for (let i = 0; i < 5_050; i += 1) map.learnBlobs([`b${i}`], "w1", NOW + i);
    expect(map.sizes().blobs).toBe(5_000);
  });
});

describe("AffinityMap.prune", () => {
  it("清掉过期与指向已删除 Worker 的条目", () => {
    const map = new AffinityMap();
    map.bindSession("fresh", "w1", NOW);
    map.bindSession("stale", "w1", NOW - TTL - 1);
    map.learnBlobs(["bfresh"], "w1", NOW);
    map.learnBlobs(["bstale"], "w1", NOW - TTL - 1);

    map.prune(NOW, TTL, always);
    expect(map.sizes()).toEqual({ sessions: 1, blobs: 1 });

    map.prune(NOW, TTL, never);
    expect(map.sizes()).toEqual({ sessions: 0, blobs: 0 });
  });
});
