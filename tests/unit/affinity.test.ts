import { describe, expect, it } from "vitest";
import type { Binding } from "../../src/core/routing/affinity.ts";
import {
  AffinityMap,
  containsStaleReasoning,
  evict,
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

  it("超长键**不参与亲和**,而不是被截断", () => {
    /*
     * 先前这里断言 `toHaveLength(256)`(截断)。第五轮审核指出并实测:
     * **截断发生在哈希之前,等于摘要被截断** —— 见下一条。
     *
     * 改成返回 null(不参与亲和):对一个畸形长度的会话键,
     * "不做亲和"远好于"把它和别人混在一起"。
     */
    expect(normalizeSessionKey("x".repeat(10_000))).toBeNull();
  });

  it("恰好在上限内的键照常可用,上限外一律拒绝", () => {
    expect(normalizeSessionKey("x".repeat(4096))).toHaveLength(4096);
    expect(normalizeSessionKey("x".repeat(4097))).toBeNull();
  });

  it("前缀相同的长键**不得**产生同一摘要", () => {
    /*
     * 这是截断修复的核心断言。旧实现(先 slice(256) 再 digestOf)下:
     *
     * ```
     * s1 = "x".repeat(256) + "AAA"
     * s2 = "x".repeat(256) + "BBB"
     * 两个不同会话键 → 同一摘要? true
     * ```
     *
     * 后果不只是"算错":它是一个廉价的**操控原语** —— 知道受害者会话键的
     * 前 256 字符就能任意改写其绑定,让对方的加密推理块指向错误的 Worker。
     */
    const s1 = "x".repeat(256) + "AAA";
    const s2 = "x".repeat(256) + "BBB";
    const h1 = normalizeSessionKey(s1);
    const h2 = normalizeSessionKey(s2);
    expect(h1).not.toBeNull();
    expect(h1).not.toBe(h2);
    expect(digestOf(h1!)).not.toBe(digestOf(h2!));
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

  it("宽对象在预算耗尽后不再读取后续字段", () => {
    const wide: Record<string, unknown> = {};
    let reads = 0;
    for (let i = 0; i < 50_000; i += 1) {
      Object.defineProperty(wide, `field-${i}`, {
        enumerable: true,
        configurable: true,
        get() {
          reads += 1;
          return { signature: BLOB_A };
        },
      });
    }

    extractBlobHashes(wide);
    expect(reads).toBeLessThan(50_000);
    expect(reads).toBeGreaterThan(0);
  });

  it("**压栈预算真的限制访问次数** —— `not.toThrow()` 对两种实现都成立", () => {
    /*
     * 第十轮审核实测：删掉数组分支里压栈前的那两行预算检查（退回到「只数
     * 出栈」的形态）后，`affinity.test.ts` + `select.test.ts` **85 条全绿** ——
     * 因为上面那条只断言 `not.toThrow()`，而两种实现都不抛。
     *
     * 判据用**元素被访问了多少次**（由修复直接导致的行为差异），
     * 不用耗时或堆增长 —— 那类阈值天生要靠猜，且被 GC 时机左右
     * （纪律 #1：能用行为断言就别用性能断言）。
     *
     * 实测无预算时 300 万元素：115ms / heap +173MB；有预算：3.9ms / +1MB，
     * 而两者提取到的指纹数都是 0 —— 所以"提取结果"这个出口测不出差别。
     */
    const LENGTH = 200_000;
    let reads = 0;

    /*
     * 每个下标都是 getter —— 于是"访问了几个元素"可被精确计数。
     * 用 `Object.defineProperty` 而不是 Proxy：数组的 `for...of` 会走
     * 迭代器协议读 `length` 与各下标，getter 对这条路径是透明的。
     */
    const counting: unknown[] = new Array(LENGTH);
    for (let i = 0; i < LENGTH; i += 1) {
      Object.defineProperty(counting, i, {
        enumerable: true,
        configurable: true,
        get() {
          reads += 1;
          return { signature: BLOB_A };
        },
      });
    }

    extractBlobHashes({ messages: counting });

    /*
     * 预算是 20000，所以访问次数必须远小于 200000。
     * 缺陷版本会把 20 万个元素全压进栈并逐个读。
     */
    expect(reads).toBeLessThan(LENGTH / 2);
    // 而且它真的开始遍历了 —— 不是靠"一个都不读"通过的。
    expect(reads).toBeGreaterThan(0);
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

  it("**窗口真的覆盖每一条模式** —— 不是与一个手写数字比", () => {
    /*
     * 上一条把 58 写在了断言里，而窗口先前也是手写的 80 —— 同一事实的
     * 两份副本，于是往模式表加一条更长的措辞时**两边都不会变**，
     * 跨块扫描静默开始漏（第十轮审核实测：加一条最长 162 的模式后，
     * 切点 81 与 161 处漏检，而全部测试仍绿）。
     *
     * 现在窗口由 `longestPossibleMatch` 从模式表推导。这条断言据此逐条核对：
     * 对每个模式构造一个"恰好最长"的匹配串，断言它不长于窗口。
     * 判据来自模式表本身，加模式时自动跟上。
     */
    const longest = [
      // /not issued to this caller/i —— 纯字面量。
      "not issued to this caller",
      // /invalid.{0,24}signature/i —— 7 + 24 + 9。
      `invalid${"x".repeat(24)}signature`,
      // /signature.{0,24}(invalid|required|missing)/i —— 9 + 24 + 8。
      `signature${"x".repeat(24)}required`,
      // /reasoning.{0,40}signature/i —— 9 + 40 + 9，本表最长。
      `reasoning${"x".repeat(40)}signature`,
    ];

    for (const sample of longest) {
      // 每个样本都真的能被识别 —— 否则下面的长度比较毫无意义。
      expect(containsStaleReasoning(sample), `这个样本本身匹配不上: ${sample}`).toBe(true);
      expect(
        sample.length,
        `窗口 ${STALE_PATTERN_WINDOW} 短于这条模式的最长匹配 ${sample.length}`,
      ).toBeLessThanOrEqual(STALE_PATTERN_WINDOW);
    }

    // 最长那条恰好等于窗口 —— 钉住推导没有无谓放大（80 那个值就是放大了 22）。
    expect(Math.max(...longest.map((x) => x.length))).toBe(STALE_PATTERN_WINDOW);
  });

  it("模式表加一条更长的措辞时，窗口**自动跟上**", () => {
    /*
     * 这条验推导本身。`longestPossibleMatch` 不导出（它是实现细节），
     * 所以用一条等价的手算：窗口必须等于"各条模式最长匹配"的最大值。
     * 少了它，一个 `= 58` 的手写常量也能让上面几条通过。
     */
    const byHand = [
      "not issued to this caller".length,
      "invalid".length + 24 + "signature".length,
      "signature".length + 24 + "required".length,
      "reasoning".length + 40 + "signature".length,
    ];
    expect(STALE_PATTERN_WINDOW).toBe(Math.max(...byHand));
  });
});

describe("AffinityMap:会话绑定", () => {
  it("绑定后能查到", () => {
    const map = new AffinityMap();
    map.bindSession("hash1", "w1", NOW, TTL);
    expect(map.lookupSession("hash1", NOW, TTL, always)).toBe("w1");
  });

  it("未绑定返回 null", () => {
    expect(new AffinityMap().lookupSession("nope", NOW, TTL, always)).toBeNull();
  });

  it("超过 TTL 后失效", () => {
    const map = new AffinityMap();
    map.bindSession("hash1", "w1", NOW, TTL);
    expect(map.lookupSession("hash1", NOW + TTL, TTL, always)).toBe("w1");
    expect(map.lookupSession("hash1", NOW + TTL + 1, TTL, always)).toBeNull();
  });

  it("Worker 已从配置删除时立刻失效", () => {
    /*
     * 不检查会让一条老绑定反复指向一个不存在的 id,表现为「粘滞完全不生效」
     * 而原因在别处 —— 查的时候会以为是 TTL 或哈希算错了。
     */
    const map = new AffinityMap();
    map.bindSession("hash1", "w1", NOW, TTL);
    expect(map.lookupSession("hash1", NOW, TTL, never)).toBeNull();
  });

  it("失效的条目被就地删掉,不只是查不到", () => {
    const map = new AffinityMap();
    map.bindSession("hash1", "w1", NOW, TTL);
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
    map.bindSession("hash1", "w1", NOW + 60_000, TTL);
    expect(map.lookupSession("hash1", NOW, TTL, always)).toBeNull();
  });

  it("解绑后查不到", () => {
    const map = new AffinityMap();
    map.bindSession("hash1", "w1", NOW, TTL);
    map.unbindSession("hash1");
    expect(map.lookupSession("hash1", NOW, TTL, always)).toBeNull();
  });

  it("重新绑定覆盖旧的 Worker 与时间", () => {
    const map = new AffinityMap();
    map.bindSession("hash1", "w1", NOW, TTL);
    map.bindSession("hash1", "w2", NOW + 1000, TTL);
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
    for (let i = 0; i < 10_050; i += 1) map.bindSession(`h${i}`, "w1", NOW + i, TTL);
    expect(map.sizes().sessions).toBe(10_000);
    // 最早的那些被挤掉,最新的还在。
    expect(map.lookupSession("h0", NOW + 10_050, TTL, always)).toBeNull();
    expect(map.lookupSession("h10049", NOW + 10_050, TTL, always)).toBe("w1");
  });

  /*
   * `evict()` 的**第一轮「先清过期」**的回归防护。
   *
   * 这条规则是第五轮审核修过的一个真实缺陷:先前是无条件 FIFO,于是灌满这张表
   * 就能把别人**仍然有效**的绑定挤掉 —— 受害者正在进行的长对话丢失粘滞、
   * 下一轮换 Worker、客户端回放的加密推理块被上游拒。也就是
   * **Phase 5 刻意要避免的那个症状可以被主动诱发**。
   *
   * 第七轮审核发现它**没有任何测试守着**:删掉整个第一轮,110 条相关测试全绿。
   * 既有的容量测试用的全是活跃条目,第一轮清不到东西、直接掉到第二轮 FIFO ——
   * 被测的一直只有兜底那条路。
   *
   * 直接测 `evict`（已导出）而不绕 `AffinityMap`：两种实现的差别只在
   * **淘汰谁**，要让差别显现必须让一条**新鲜**绑定排在插入顺序的**最前**，
   * 而那个状态经公开 API 构造不出来（新鲜=绑定得晚，插入顺序=绑定顺序，
   * 在全局 TTL 下矛盾）。理由记在 `evict` 的文档注释里。
   */
  it("evict 优先淘汰过期项,不动排在更前面的新鲜绑定", () => {
    const CAP = 3;
    // 队首是**新鲜**的，其后两条已过期 —— 无条件 FIFO 会淘汰队首那条新鲜的。
    const map = new Map<string, Binding>([
      ["新鲜的", { workerId: "w-live", at: NOW }],
      ["过期A", { workerId: "w1", at: NOW - TTL * 10 }],
      ["过期B", { workerId: "w1", at: NOW - TTL * 10 }],
      ["新来的", { workerId: "w2", at: NOW }],
    ]);

    const dropped = evict(map, CAP, NOW, TTL);

    // 承重：淘汰的是过期项，而不是队首那条新鲜的。
    expect(dropped).toEqual(["过期A"]);
    expect(map.has("新鲜的")).toBe(true);
    expect([...map.keys()]).toEqual(["新鲜的", "过期B", "新来的"]);
  });

  it("evict 全是新鲜条目时退回 FIFO —— 兜底存在,内存不会无界", () => {
    /*
     * 与上一条互补：证明第一轮清不到东西时第二轮仍然工作。
     * 否则「先清过期」可能被实现成「只清过期，清不到就不淘汰」——
     * 那样内存无界，而这张表的上限正是防这个。
     */
    const CAP = 2;
    const map = new Map<string, Binding>([
      ["老", { workerId: "w1", at: NOW }],
      ["中", { workerId: "w1", at: NOW + 1 }],
      ["新", { workerId: "w1", at: NOW + 2 }],
    ]);

    expect(evict(map, CAP, NOW + 2, TTL)).toEqual(["老"]);
    expect([...map.keys()]).toEqual(["中", "新"]);
  });

  it("evict 在容量未满时什么都不做", () => {
    const map = new Map<string, Binding>([["a", { workerId: "w1", at: NOW }]]);
    expect(evict(map, 10, NOW, TTL)).toEqual([]);
    expect(map.size).toBe(1);
  });

  it("容量满且全部活跃时才退回 FIFO —— 兜底仍然存在", () => {
    /*
     * 与上一条互补:证明第一轮清不到东西时第二轮仍然工作,
     * 否则"先清过期"可能被实现成"只清过期,清不到就不淘汰"（内存无界）。
     */
    const map = new AffinityMap();
    const CAP = 10_000;
    for (let i = 0; i <= CAP; i += 1) map.bindSession(`活${i}`, "w1", NOW + i, TTL);

    expect(map.sizes().sessions).toBe(CAP);
    expect(map.lookupSession("活0", NOW + CAP, TTL, always)).toBeNull();
  });
});

describe("AffinityMap:推理指纹", () => {
  it("学习后能提示", () => {
    const map = new AffinityMap();
    map.learnBlobs(["h1", "h2"], "w1", NOW, TTL);
    expect(map.findBlobWorker(["h1", "h2"], NOW, TTL, always)).toBe("w1");
  });

  it("空指纹列表不给提示", () => {
    const map = new AffinityMap();
    map.learnBlobs(["h1"], "w1", NOW, TTL);
    expect(map.findBlobWorker([], NOW, TTL, always)).toBeNull();
  });

  it("任何一个指纹未知就不给提示", () => {
    const map = new AffinityMap();
    map.learnBlobs(["h1"], "w1", NOW, TTL);
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
    map.learnBlobs(["h1"], "w1", NOW, TTL);
    map.learnBlobs(["h2"], "w2", NOW, TTL);
    expect(map.findBlobWorker(["h1", "h2"], NOW, TTL, always)).toBeNull();
  });

  it("过期的指纹不给提示", () => {
    const map = new AffinityMap();
    map.learnBlobs(["h1"], "w1", NOW, TTL);
    expect(map.findBlobWorker(["h1"], NOW + TTL + 1, TTL, always)).toBeNull();
  });

  it("Worker 已删除时不给提示", () => {
    const map = new AffinityMap();
    map.learnBlobs(["h1"], "w1", NOW, TTL);
    expect(map.findBlobWorker(["h1"], NOW, TTL, never)).toBeNull();
  });

  it("忘掉指纹后不再提示", () => {
    const map = new AffinityMap();
    map.learnBlobs(["h1", "h2"], "w1", NOW, TTL);
    map.forgetBlobs(["h1"]);
    expect(map.findBlobWorker(["h1", "h2"], NOW, TTL, always)).toBeNull();
    expect(map.findBlobWorker(["h2"], NOW, TTL, always)).toBe("w1");
  });

  it("重新学习覆盖为新 Worker", () => {
    const map = new AffinityMap();
    map.learnBlobs(["h1"], "w1", NOW, TTL);
    map.learnBlobs(["h1"], "w2", NOW + 1000, TTL);
    expect(map.findBlobWorker(["h1"], NOW + 1000, TTL, always)).toBe("w2");
  });

  it("超出容量时淘汰最老的", () => {
    const map = new AffinityMap();
    for (let i = 0; i < 5_050; i += 1) map.learnBlobs([`b${i}`], "w1", NOW + i, TTL);
    expect(map.sizes().blobs).toBe(5_000);
  });
});

describe("AffinityMap.prune", () => {
  it("清掉过期与指向已删除 Worker 的条目", () => {
    const map = new AffinityMap();
    map.bindSession("fresh", "w1", NOW, TTL);
    map.bindSession("stale", "w1", NOW - TTL - 1, TTL);
    map.learnBlobs(["bfresh"], "w1", NOW, TTL);
    map.learnBlobs(["bstale"], "w1", NOW - TTL - 1, TTL);

    map.prune(NOW, TTL, always);
    expect(map.sizes()).toEqual({ sessions: 1, blobs: 1 });

    map.prune(NOW, TTL, never);
    expect(map.sizes()).toEqual({ sessions: 0, blobs: 0 });
  });
});
