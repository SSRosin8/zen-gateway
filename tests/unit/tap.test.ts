import { describe, expect, it } from "vitest";
import { createOverlapScanner, tapReadable } from "../../src/core/upstream/tap.ts";
import {
  containsStaleReasoning,
  STALE_PATTERN_WINDOW,
} from "../../src/core/routing/affinity.ts";

/**
 * 响应流旁路观察。
 *
 * 本文件最要紧的断言是**逐字节相同** —— 旁路的全部价值建立在"它不改变
 * 转发内容"之上,一旦它动了字节,整个原样透传的前提就没了。
 */

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[i]!);
      i += 1;
    },
  });
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const out: number[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(...value);
  }
  return new Uint8Array(out);
}

function collector(): {
  tap: { onText: (t: string) => void; onDone: (e: unknown) => void };
  text: () => string;
  doneCalls: () => unknown[];
} {
  const parts: string[] = [];
  const dones: unknown[] = [];
  return {
    tap: {
      onText: (t) => parts.push(t),
      onDone: (e) => dones.push(e),
    },
    text: () => parts.join(""),
    doneCalls: () => dones,
  };
}

describe("逐字节透传", () => {
  it("输出与输入完全相同", async () => {
    const chunks = [bytes("data: 第一块\n\n"), bytes("data: second\n\n"), bytes("data: [DONE]\n\n")];
    const expected = new Uint8Array(chunks.flatMap((c) => [...c]));
    const c = collector();

    const out = await drain(tapReadable(streamOf(chunks), c.tap));
    expect(out).toEqual(expected);
  });

  it("二进制(非 UTF-8)字节同样原样通过", async () => {
    /*
     * 多模态响应可能含任意字节。解码只用于**扫描副本**,绝不能影响转发 ——
     * 若实现里不小心把解码结果重新编码后入队,这条会红。
     */
    const raw = new Uint8Array([0x00, 0xff, 0xfe, 0x80, 0x41, 0xc3, 0x28]);
    const out = await drain(tapReadable(streamOf([raw]), collector().tap));
    expect(out).toEqual(raw);
  });

  it("空流也能正常结束", async () => {
    const c = collector();
    expect(await drain(tapReadable(streamOf([]), c.tap))).toEqual(new Uint8Array([]));
    expect(c.doneCalls()).toEqual([null]);
  });
});

describe("文本回调", () => {
  it("收到解码后的文本", async () => {
    const c = collector();
    await drain(tapReadable(streamOf([bytes("hello "), bytes("世界")]), c.tap));
    expect(c.text()).toBe("hello 世界");
  });

  it("跨块切断的 UTF-8 多字节序列能正确解码", async () => {
    /*
     * `decoder.decode(chunk, { stream: true })` 是必须的:一个汉字占 3 字节,
     * SSE 分块可以把它切在中间。一次性解码会在边界处产出替换字符 U+FFFD,
     * 而那个字符可能正好落在我们要匹配的消息中间 —— 把一次本该命中的扫描
     * 变成不命中,且只在特定分块位置发生。
     */
    const full = bytes("推理签名无效:signature invalid");
    // 在第 2 个字节处切 —— 正好切断第一个汉字。
    const c = collector();
    await drain(tapReadable(streamOf([full.slice(0, 2), full.slice(2)]), c.tap));
    expect(c.text()).toBe("推理签名无效:signature invalid");
    expect(c.text()).not.toContain("�");
  });

  it("回调抛异常不影响转发", async () => {
    /*
     * 结算是优化。让它把一个已经成功的响应在转发到一半时炸掉,
     * 是用一个小收益换一个大故障。
     */
    const payload = bytes("data: ok\n\n");
    const out = await drain(
      tapReadable(streamOf([payload]), {
        onText: () => {
          throw new Error("扫描器炸了");
        },
        onDone: () => {
          throw new Error("结算炸了");
        },
      }),
    );
    expect(out).toEqual(payload);
  });

  it("**整条流**都会回调 —— 预算不在 onText 上", async () => {
    /*
     * ## 不能断言「超出 1 MiB 后停止回调」
     *
     * 预算加在 `tapReadable` 的 `onText` 上是个真实缺陷:`onText` 有**两个**消费者
     * (失效推理扫描、token 用量),而它们对"看流的哪一段"的要求**正好相反** ——
     * 扫描器只要开头,用量要整条流(chat/responses 的用量只在末帧,
     * Anthropic 更糟:拆在两端)。
     *
     * 实测后果(复刻 relay 接线,唯一变量是流长度):
     *
     * ```
     * Anthropic  36 KB → in=812 out=37 total=849   ✓
     * Anthropic 1.8 MB → in=812 out=1  total=813   ← 只剩 message_start
     * chat        33 KB → in=900 out=5000          ✓
     * chat      1.6 MB → null(整条丢失)
     * ```
     *
     * Anthropic 那一行是**算错**而不是漏掉 —— `message_start` 真的带
     * `output_tokens: 1`,于是它成了预算内唯一的用量事件并被当成最终值。
     *
     * 所以预算移到了 `createOverlapScanner`(它的理由所在的那一层),
     * 而这里断言 `onText` **覆盖整条流**。
     */
    const chunk = bytes("x".repeat(64 * 1024));
    const chunks = Array.from({ length: 24 }, () => chunk);
    const total = 24 * 64 * 1024;
    const c = collector();
    const out = await drain(tapReadable(streamOf(chunks), c.tap));

    // 先钉住输入规模真的超过默认预算 —— 否则这条测试会随预算调整静默退化。
    expect(total).toBeGreaterThan(1024 * 1024);
    expect(out.byteLength).toBe(total);
    // 关键:回调看到的文本长度 == 整条流,一个字节都没被预算吃掉。
    expect(c.text().length).toBe(total);
  });
});

describe("createOverlapScanner 的扫描预算", () => {
  /*
   * 预算属于扫描器,不属于 `onText` —— 见上面那条测试的说明。
   *
   * 这一组钉住预算的取值:没有它,把预算改成任意值都不会有测试变红。
   */
  const test = (t: string) => t.includes("not issued to this caller");

  it("预算耗尽后停止跑正则", () => {
    const s = createOverlapScanner(80, test, 1000);
    s.feed("x".repeat(2000)); // 已超预算
    s.feed("not issued to this caller");
    expect(s.hit()).toBe(false);
  });

  it("预算内照常命中 —— 证明上一条的 false 来自预算而非别的原因", () => {
    const s = createOverlapScanner(80, test, 1000);
    s.feed("not issued to this caller");
    expect(s.hit()).toBe(true);
  });

  it("默认预算也真的能被耗尽", () => {
    /*
     * 不传 budget 时用 `DEFAULT_SCAN_BUDGET_BYTES`(1 MiB)。
     * 用纯 ASCII 喂满 —— 预算计的是**字符数**,对 CJK 会比字节数宽三倍,
     * 那是刻意的(粗阈值,不是正确性边界),这里用 ASCII 才测得准。
     */
    const s = createOverlapScanner(80, test);
    for (let i = 0; i < 12_000; i += 1) s.feed("a".repeat(100)); // 120 万字符
    s.feed("not issued to this caller");
    expect(s.hit()).toBe(false);
  });

  it("命中之后即便预算未耗尽也不再扫 —— 两条早退互不干扰", () => {
    const s = createOverlapScanner(80, test, 1_000_000);
    s.feed("not issued to this caller");
    expect(s.hit()).toBe(true);
    s.feed("后面全是正常内容".repeat(100));
    expect(s.hit()).toBe(true);
  });
});

describe("结束通知", () => {
  it("正常读完 → onDone(null)", async () => {
    const c = collector();
    await drain(tapReadable(streamOf([bytes("a")]), c.tap));
    expect(c.doneCalls()).toEqual([null]);
  });

  it("上游中断 → onDone(error),且只一次", async () => {
    /*
     * 这一路径是用手写 ReadableStream 而不是 TransformStream 的原因:
     * 后者在上游出错时**不调用** `flush()`,于是"流异常结束"拿不到通知 ——
     * 而那正是最需要区分的一种结局(内容不完整,不能据此学习绑定)。
     */
    const boom = new Error("上游断了");
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes("data: 部分\n\n"));
      },
      pull(controller) {
        controller.error(boom);
      },
    });

    const c = collector();
    await expect(drain(tapReadable(source, c.tap))).rejects.toThrow("上游断了");
    expect(c.doneCalls()).toEqual([boom]);
  });

  it("下游取消 → onDone(非 null)", async () => {
    /*
     * 客户端断开(OpenCode 里按 ESC 中断生成)走这条路。内容不完整,
     * 所以结算方据此**不学习**绑定 —— 而那与推理是否有效毫无关系。
     */
    const c = collector();
    const wrapped = tapReadable(streamOf([bytes("a"), bytes("b")]), c.tap);
    const reader = wrapped.getReader();
    await reader.read();
    await reader.cancel("客户端走了");

    expect(c.doneCalls()).toHaveLength(1);
    expect(c.doneCalls()[0]).not.toBeNull();
  });

  it("取消不传 reason 时仍然是非 null —— 否则会被当成正常完成", async () => {
    /*
     * `cancel()` 的 reason 是可选的。若直接把 undefined 传给 onDone,
     * 结算方的 `error === null` 判断会……为 false,没错;但若实现里写成
     * `error == null` 或用 `??` 转成 null,一次中途取消就会被当成完整响应,
     * 于是学习了一个可能会拒的 Worker。
     */
    const c = collector();
    const reader = tapReadable(streamOf([bytes("a"), bytes("b")]), c.tap).getReader();
    await reader.read();
    await reader.cancel();
    expect(c.doneCalls()[0]).not.toBeNull();
    expect(c.doneCalls()[0]).toBeInstanceOf(Error);
  });

  it("onText **绝不**越过 onDone(纵深防御,非可达缺陷)", async () => {
    /*
     * 结算方在 `onDone` 里采样 `scanner.hit()`,所以越过了的那一块等于白扫:
     * 拒绝消息被扫到,而 `settleStream` 收到 `staleHit: false`。而 `staleHit`
     * 是唯一**先于** `complete` 检查的分支(刻意设计成"即使流不完整也要解绑"),
     * 越界恰好把那条唯一可用的路径关掉。
     *
     * ## 这条用假 reader,且它测的不是一个可达的生产缺陷
     *
     * 这个时序只能用可控假 reader 复现。用**真实** ReadableStream
     * 测两种形态(同步入队、异步延迟入队)都无法触发 —— 真实 reader 在 cancel
     * 之后按规范以 `done: true` 兑现,不会带着值回来。
     *
     * 所以这里刻意用一个**不守规范**的假 reader:它代表"如果 reader 实现不善意"。
     * 按纪律 #1 的分类,这不是"补一个漏掉的断言",而是把
     * 「onText 与 onDone 的先后」从**依赖第三方善意**变成**本模块自己保证**。
     * 标注清楚是必要的 —— 否则以后会有人以为这是个真实缺陷的回归测试。
     */
    const releases: Array<() => void> = [];
    const fakeReader = {
      read: () =>
        new Promise<{ done: boolean; value: Uint8Array }>((resolve) => {
          releases.push(() => resolve({ done: false, value: bytes("not issued to this caller") }));
        }),
      cancel: () => Promise.resolve(),
    };
    const fakeBody = { getReader: () => fakeReader } as unknown as ReadableStream<Uint8Array>;

    const events: string[] = [];
    const wrapped = tapReadable(fakeBody, {
      onText: () => events.push("onText"),
      onDone: () => events.push("onDone"),
    });

    const reader = wrapped.getReader();
    const pending = reader.read();
    await Promise.resolve();
    await reader.cancel("客户端走了");
    for (const release of releases) release();
    await pending.catch(() => undefined);
    await new Promise((r) => { setTimeout(r, 10); });

    // onDone 必须是最后一个事件 —— 其后的 onText 被守卫挡住。
    expect(events.at(-1)).toBe("onDone");
    expect(events.filter((e) => e === "onDone")).toHaveLength(1);
  });

  it("读完之后再取消不会重复通知", async () => {
    const c = collector();
    const wrapped = tapReadable(streamOf([bytes("a")]), c.tap);
    const reader = wrapped.getReader();
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }
    await reader.cancel("多余的取消");
    expect(c.doneCalls()).toEqual([null]);
  });

  it("取消发生在 read 挂起期间时,只通知一次且是取消", async () => {
    /*
     * 这是 `finished` 幂等守卫**唯一**真正保护的路径。
     *
     * 上面那条"读完之后再取消"测不到:流已 close 后 `cancel()` 按规范
     * 不调用 source 的 cancel 算法,于是 `finish` 本来就只会被调一次 ——
     * 去掉守卫后那条依然全绿(变异验证查出来的)。
     *
     * 真正会重复触发的是这里:我们在 cancel 里 `finish(reason)` 并取消上游
     * reader,而那个**挂起中**的 `read()` 随即以 `done: true` 兑现,
     * 于是 pull 的后续接着调 `finish(null)`。
     *
     * 后果很具体:一次客户端中断被报成完整响应,结算方据此
     * **学习**绑定 —— 把一个可能会拒的 Worker 记成了正确答案。
     */
    /*
     * 用数组存 resolve 而不是 `let release: (() => void) | null`:
     * 后者 tsc 会把它窄化成 `never`(闭包里的赋值不进控制流分析),
     * 于是 `release?.()` 报 TS2349 —— 而 Vitest 只转译不检查,测试照常通过。
     * 这正是四份 tsconfig 里 `tsconfig.test.json` 的用处。
     */
    const releases: Array<() => void> = [];
    const source = new ReadableStream<Uint8Array>({
      pull() {
        // 永不主动兑现 —— 只有被 cancel 时才结束。
        return new Promise<void>((resolve) => {
          releases.push(resolve);
        });
      },
    });

    const c = collector();
    const reader = tapReadable(source, c.tap).getReader();
    const pending = reader.read();
    // 让 pull 真的跑起来并挂在上游的 read 上。
    await Promise.resolve();

    await reader.cancel("读到一半客户端走了");
    for (const release of releases) release();
    await pending.catch(() => undefined);
    await Promise.resolve();

    expect(c.doneCalls()).toHaveLength(1);
    expect(c.doneCalls()[0]).not.toBeNull();
  });
});

describe("createOverlapScanner", () => {
  const scanner = () => createOverlapScanner(STALE_PATTERN_WINDOW, containsStaleReasoning);

  it("单块内命中", () => {
    const s = scanner();
    s.feed("error: not issued to this caller");
    expect(s.hit()).toBe(true);
  });

  it("**跨块**命中 —— 消息被切在两块之间", () => {
    /*
     * 这条是本文件存在的主要理由。逐块独立匹配会漏,而漏掉的症状取决于
     * 上游的分块位置 —— 时有时无,极难复现。
     *
     * ## 第一块必须**长于窗口**,否则这条测试是空壳
     *
     * 若第一次 feed 只有 43 字符,而 window 是 80 —— 那么
     * `combined.length > window` 为假,走的是 `tail = combined` 那一支,
     * **`slice` 分支根本没执行**。变异测试实测:把 `slice(-window)`
     * 改成 `slice(0, window)`(保留开头而非尾巴,跨块匹配必然失效)后
     * 这条测试依然全绿。
     *
     * 所以这里先垫 200 字符,迫使截断真的发生:此时只有"保留尾巴"才能
     * 让第二块接上。归类是纪律 #1 的第一类 —— **测的路径根本不存在**。
     */
    const s = scanner();
    const padding = "x".repeat(200);
    s.feed(`${padding}reasoning block was not iss`);
    expect(s.hit()).toBe(false);
    s.feed("ued to this caller");
    expect(s.hit()).toBe(true);
  });

  it("保留的是**尾巴**而不是开头", () => {
    /*
     * 上一条的反向钉子:即便第一块被截断,留下的必须是**末尾** window 个字符。
     * 保留开头会让跨块拼接必然失败,而两种写法在源码里长得几乎一样
     * (`slice(-window)` vs `slice(0, window)`)。
     *
     * 构造:前缀是与模式完全无关的填充,匹配所需的前半段紧贴第一块末尾。
     */
    const s = scanner();
    s.feed(`${"无关内容".repeat(60)}signature is req`);
    expect(s.hit()).toBe(false);
    s.feed("uired");
    expect(s.hit()).toBe(true);
  });

  it("逐字符喂入也能命中", () => {
    const s = scanner();
    for (const ch of "prefix not issued to this caller suffix") s.feed(ch);
    expect(s.hit()).toBe(true);
  });

  it("命中后保持命中,不被后续内容重置", () => {
    const s = scanner();
    s.feed("invalid signature");
    s.feed("后面全是正常内容".repeat(100));
    expect(s.hit()).toBe(true);
  });

  it("正常内容不误判,且尾巴不无界增长", () => {
    const s = scanner();
    for (let i = 0; i < 1_000; i += 1) s.feed(`data: {"delta":{"content":"块${i}"}}\n\n`);
    expect(s.hit()).toBe(false);
  });

  it("窗口小于最长模式时会漏 —— 说明 window 参数是真起作用的", () => {
    /*
     * 反向验证:用一个故意过小的窗口,同一段跨块输入就匹配不到。
     * 这证明上面那条"跨块命中"不是碰巧,而真的依赖重叠窗口。
     */
    const tiny = createOverlapScanner(3, containsStaleReasoning);
    tiny.feed("reasoning block was not iss");
    tiny.feed("ued to this caller");
    expect(tiny.hit()).toBe(false);
  });
});
