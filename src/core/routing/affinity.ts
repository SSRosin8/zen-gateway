import { createHash } from "node:crypto";

/**
 * 会话亲和 —— 会话 → Worker、加密推理指纹 → Worker。
 *
 * ## 为什么需要它
 *
 * 上游把「加密推理块」(`encrypted_content` / `signature`)绑定到**签发它的
 * 调用方身份**。多轮对话里客户端会把上一轮的推理块原样回放,若这一轮换了
 * Worker(换了 key),上游会拒掉它 —— 表现为对话中途突然报错,而用户什么都没改。
 * 所以一条会话在其 Worker 健康期间必须钉住不动。
 *
 * ## 只存 sha256 摘要
 *
 * 两类键都经 sha256:
 *
 * - **会话键**来自客户端的 `x-opencode-session`,内容不受我们控制,
 *   而这张表会进备份与诊断导出。
 * - **推理指纹**本身就是对推理块内容取的摘要 —— 原文是用户对话的一部分。
 *
 * `data/runtime.db` 的两张表用 `CHECK (length = 64 AND NOT GLOB '*[^0-9a-f]*')`
 * 把这条约定变成**结构约束**:只有小写十六进制能写进去,任何自然语言都进不来。
 * 本文件是那两张表的内存侧,键的形态必须一致 —— 否则 Phase 7 接持久化时
 * 会在 SQLite 的 CHECK 上炸。
 *
 * ## 持久化在 Phase 7
 *
 * 当前是纯内存:服务端进程还没有打开 `runtime.db`(全仓只有测试打开它)。
 * 重启会丢掉绑定,后果是每条进行中的会话下一轮重新挑一次 Worker ——
 * 一次可能的 Worker 切换,不是数据损坏。表结构已就绪,Phase 7 接上即可。
 */

/**
 * 容量上限。
 *
 * 没有上限时,一个长期运行的网关会把每个见过的会话键永久留在内存里 ——
 * TTL 只在**读取时**过滤,不会自己腾出空间。
 */
const SESSION_CAP = 10_000;
const BLOB_CAP = 5_000;

/**
 * 会话键的长度上限。**超过就不参与亲和**,而不是截断 —— 见下。
 *
 * 数值放宽到 4096:头本身已被 Node 的 `maxHeaderSize`(16 KB)兜住,而体内的
 * 会话指针(Responses 面的 `previous_response_id`)没有那个约束,所以仍需一个
 * 上限防止对一个 64 MB 的字符串做 sha256。
 */
const MAX_SESSION_KEY_LENGTH = 4096;

/** sha256 十六进制摘要,64 个小写十六进制字符。 */
export function digestOf(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * 归一化客户端给的会话键;超长或空则返回 null(不参与亲和)。
 *
 * 去掉 CR/LF/Tab 是因为这个值**先前已经被当作 HTTP 头转发过**
 * (`x-opencode-session`),而 `headers.ts` 对含控制字符的值是**抛错**处理。
 * 这里不抛:亲和只是优化,一个奇怪的会话键不该让请求失败,
 * 归一化后照常用即可。
 *
 * ## 超长的键为什么**拒绝**而不是截断
 *
 * 先前这里是 `slice(0, 256)` 然后交给 `digestOf`。第五轮审核指出并实测了
 * 后果:**截断发生在哈希之前,等于摘要被截断**。
 *
 * ```
 * s1 = "x".repeat(256) + "AAA"
 * s2 = "x".repeat(256) + "BBB"
 * 两个不同会话键 → 同一摘要? true
 * ```
 *
 * 于是前 256 字符相同的两个会话共用一个绑定:一方的绑定被另一方改写,
 * 指纹学习也记到错误的 Worker 上。更糟的是它是个廉价的**操控原语** ——
 * 知道受害者会话键的前 256 字符就能任意改写其绑定。
 *
 * 我写那段注释时只想到"长度上限防客户端无界增长",没意识到**截断与哈希的
 * 顺序**决定了会不会碰撞。
 *
 * 返回 null 让这个请求退化成纯策略排序 —— 对一个畸形长度的会话键,
 * "不做亲和"远好于"把它和别人混在一起"。
 */
export function normalizeSessionKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // 先按上限拒绝:避免对超大字符串做 replace 与 trim。
  if (value.length > MAX_SESSION_KEY_LENGTH) return null;
  const clean = value.replace(/[\r\n\t]+/g, " ").trim();
  if (clean === "") return null;
  return clean;
}

/* ------------------------------------------------------------------ *
 * 推理指纹的提取
 * ------------------------------------------------------------------ */

/** 承载调用方绑定的加密推理的字段名。 */
const ENCRYPTED_BLOB_KEYS = new Set(["encrypted_content", "signature"]);

/*
 * 遍历上限。请求体来自客户端,可能是深度嵌套的多模态负载;
 * 无界遍历会让一个畸形请求体把 CPU 与内存占满(而且发生在**转发之前**,
 * 所以上游都还没参与,故障完全在我们这边)。
 */
const MAX_BLOB_VALUES = 64;
const MAX_BLOB_VALUE_LENGTH = 16_384;
const MIN_BLOB_VALUE_LENGTH = 16;
/**
 * 预算:**入栈**与出栈都计入。
 *
 * 先前只数出栈(`pop` 次数),而数组分支在**一次 pop 里把全部元素压栈** ——
 * 于是这个上限只约束"访问几个节点",完全不约束"压栈几个"。
 * `MAX_TRAVERSE_DEPTH` 也挡不住:恶意形态是**宽**而非深,深度恒为 1。
 *
 * 第五轮审核实测(一个 355 万元素的扁平数组,JSON 约 64 MB,在 64 MB 体上限内):
 *
 * ```
 * 恶意"宽而扁"体: 141ms | heapUsed +222MB | 提取到指纹 0 个
 * 真实多模态体:   0.4ms |                 | 提取到 1 个
 * ```
 *
 * 开销换来的信息量为零。攻击需要 Relay Token(鉴权在读体之前),而能读
 * 0600 `opencode.json` 的进程本来就能直接偷 Worker key —— 所以这不是越权,
 * 是一个**本机自伤**的放大器:事件循环被占住,同时进来的正常请求一起变慢。
 *
 * 超预算时静默少提取几个指纹是可接受的:漏提取只让粘滞退化成策略排序,
 * 而那是这个功能的降级形态,不是错误行为。
 */
const MAX_TRAVERSAL_BUDGET = 20_000;
const MAX_TRAVERSE_DEPTH = 16;

/**
 * 从请求体里收集加密推理块的 sha256 指纹。
 *
 * **只有摘要离开这个函数**,原文不外流 —— 所以结果可以进内存映射、
 * 进日志、进磁盘。
 *
 * 在解析副本上做(relay 第 2 步已经解析过一次),不额外解析 —— `JSON.parse`
 * → `stringify` 往返不是无损的,而转发出去的必须是原始字节。
 */
export function extractBlobHashes(body: unknown): string[] {
  if (body === null || typeof body !== "object") return [];

  const hashes = new Set<string>();
  const stack: Array<{ value: unknown; depth: number }> = [{ value: body, depth: 0 }];

  /*
   * 单一预算,**每个被检视的元素都扣一次** —— 出栈、数组元素、对象字段一视同仁。
   *
   * 关键是数组元素与对象字段在**压栈之前**就扣:先前只在出栈时扣,于是
   * 「一次 pop 压入 355 万个元素」完全不受约束(见上面常量的说明)。
   *
   * 数组元素被扣两次(压栈 1 + 出栈 1),所以有效预算约为一半。这是保守方向,
   * 不必修正。
   */
  let budget = MAX_TRAVERSAL_BUDGET;

  while (stack.length > 0 && hashes.size < MAX_BLOB_VALUES && budget > 0) {
    const frame = stack.pop();
    if (frame === undefined) break;
    budget -= 1;
    const { value, depth } = frame;

    if (Array.isArray(value)) {
      if (depth < MAX_TRAVERSE_DEPTH) {
        for (const item of value) {
          if (budget <= 0) break;
          budget -= 1;
          stack.push({ value: item, depth: depth + 1 });
        }
      }
      continue;
    }
    if (value === null || typeof value !== "object" || depth >= MAX_TRAVERSE_DEPTH) continue;

    for (const [key, entry] of Object.entries(value)) {
      if (budget <= 0) break;
      budget -= 1;
      if (typeof entry === "string" && ENCRYPTED_BLOB_KEYS.has(key)) {
        if (entry.length >= MIN_BLOB_VALUE_LENGTH && entry.length <= MAX_BLOB_VALUE_LENGTH) {
          hashes.add(digestOf(entry));
        }
      } else if (entry !== null && typeof entry === "object") {
        stack.push({ value: entry, depth: depth + 1 });
      }
    }
  }

  return [...hashes];
}

/* ------------------------------------------------------------------ *
 * 失效推理的识别
 * ------------------------------------------------------------------ */

/**
 * 「回放的推理不是发给这个调用方的」这类拒绝的措辞。
 *
 * 匹配**消息形态**而不是状态码,是不变量 #3 的核心:SSE 可以带着 HTTP 200
 * 把这种拒绝塞在流里面。只看状态码会整条漏掉,于是失效的指纹一直把会话
 * 钉在错的 Worker 上 —— 每一轮都失败,而且失败原因看起来来自上游。
 *
 * 模式来自旧项目实测到的上游措辞。这是**外部系统的属性**,不是我们的判断,
 * 所以宁可宽一点:误判的代价是解绑一次会话(下一轮重挑 Worker),
 * 漏判的代价是会话永久卡死。
 */
const STALE_REASONING_PATTERNS = [
  /not issued to this caller/i,
  /invalid.{0,24}signature/i,
  /signature.{0,24}(invalid|required|missing)/i,
  /reasoning.{0,40}signature/i,
];

/** 这些模式里最长的可能匹配长度 —— 跨块扫描时的重叠窗口据此取。 */
export const STALE_PATTERN_WINDOW = 80;

export function containsStaleReasoning(text: string): boolean {
  if (text === "") return false;
  return STALE_REASONING_PATTERNS.some((pattern) => pattern.test(text));
}

/* ------------------------------------------------------------------ *
 * 绑定表
 * ------------------------------------------------------------------ */

type Binding = { workerId: string; at: number };

/**
 * 两张有界的 TTL 映射。
 *
 * TTL 与容量都在**读取时**判定,不起定时器:一个自用网关不值得为过期清理
 * 养一个 interval(它还会在测试里把进程吊住)。
 *
 * 过期条目的清理有两条路径:
 *
 * - `lookupSession` / `findBlobWorker` 读到过期条目时就地删掉
 * - `evict`(容量满时)**优先清过期**,不够才按 FIFO 淘汰
 *
 * `prune()` 是第三条,但它**目前在生产里没有调用方** —— 只有测试与
 * (将来的)管理面用。先前这里的注释写的是「`prune()` 由写入路径顺带调用」,
 * 那是假的:写入路径调的是 `evict`。第五轮审核指出这与
 * 「`npm run status` 会报就绪数」是同一形态的失实(纪律 #7:把"代码里有
 * 这个能力"写成"它在被调用")。
 *
 * 不接上 `prune` 是有意的:上面两条路径已经保证内存有界,而定期全表扫描
 * 在个位数 Worker、万级条目的规模上没有收益。
 */
export class AffinityMap {
  #sessions = new Map<string, Binding>();
  #blobs = new Map<string, Binding>();

  /**
   * 查会话绑定的 Worker。
   *
   * `workerExists` 由调用方注入:配置里删掉的 Worker 必须立刻失效,
   * 否则一条老绑定会让 `select` 反复找一个不存在的 id,表现为
   * 「粘滞完全不生效」而原因在别处。
   */
  lookupSession(
    sessionHash: string,
    now: number,
    ttlMs: number,
    workerExists: (workerId: string) => boolean,
  ): string | null {
    const found = this.#sessions.get(sessionHash);
    if (found === undefined) return null;
    if (!fresh(found, now, ttlMs) || !workerExists(found.workerId)) {
      this.#sessions.delete(sessionHash);
      return null;
    }
    return found.workerId;
  }

  /**
   * 绑定会话。`ttlMs` 用于容量淘汰时优先清过期项 —— 见 `evict`。
   *
   * 写入方法也要 ttlMs,与读取方法(`lookupSession`/`findBlobWorker`/`prune`)
   * 一致:这张表的每个操作都需要知道"什么算过期"。
   */
  bindSession(sessionHash: string, workerId: string, now: number, ttlMs: number): void {
    // 先删再插:Map 按插入顺序迭代,这样重新绑定的会话回到队尾,淘汰的是最老的。
    this.#sessions.delete(sessionHash);
    this.#sessions.set(sessionHash, { workerId, at: now });
    evict(this.#sessions, SESSION_CAP, now, ttlMs);
  }

  unbindSession(sessionHash: string): void {
    this.#sessions.delete(sessionHash);
  }

  /**
   * 推理指纹提示的 Worker。
   *
   * **必须全体一致**:请求里所有指纹都指向同一个 Worker 才给提示。
   * 任何一个指纹缺失、过期、或指向别人 → 返回 null。
   *
   * 理由是这个提示的用途:它要回答「这批推理块是谁签发的」。若两个指纹指向
   * 不同 Worker,那这个请求混合了两个来源的推理,无论选谁都会被拒 ——
   * 此时提示一个反而比不提示更糟(它会抢在轮转之前,把请求钉到必败的那个)。
   */
  findBlobWorker(
    hashes: readonly string[],
    now: number,
    ttlMs: number,
    workerExists: (workerId: string) => boolean,
  ): string | null {
    if (hashes.length === 0) return null;
    let candidate: string | null = null;
    for (const hash of hashes) {
      const found = this.#blobs.get(hash);
      if (found === undefined || !fresh(found, now, ttlMs)) return null;
      if (candidate === null) candidate = found.workerId;
      else if (candidate !== found.workerId) return null;
    }
    if (candidate === null || !workerExists(candidate)) return null;
    return candidate;
  }

  /** 学习指纹。`ttlMs` 用于容量淘汰时优先清过期项 —— 见 `evict`。 */
  learnBlobs(hashes: readonly string[], workerId: string, now: number, ttlMs: number): void {
    for (const hash of hashes) {
      this.#blobs.delete(hash);
      this.#blobs.set(hash, { workerId, at: now });
    }
    evict(this.#blobs, BLOB_CAP, now, ttlMs);
  }

  forgetBlobs(hashes: readonly string[]): void {
    for (const hash of hashes) this.#blobs.delete(hash);
  }

  /** 供诊断与测试。刻意不暴露键本身 —— 它们是摘要,但数量才是有用的信息。 */
  sizes(): { sessions: number; blobs: number } {
    return { sessions: this.#sessions.size, blobs: this.#blobs.size };
  }

  /** 丢掉过期与指向已删除 Worker 的条目。 */
  prune(now: number, ttlMs: number, workerExists: (workerId: string) => boolean): void {
    for (const [key, binding] of this.#sessions) {
      if (!fresh(binding, now, ttlMs) || !workerExists(binding.workerId)) {
        this.#sessions.delete(key);
      }
    }
    for (const [key, binding] of this.#blobs) {
      if (!fresh(binding, now, ttlMs) || !workerExists(binding.workerId)) {
        this.#blobs.delete(key);
      }
    }
  }
}

/**
 * 绑定是否还有效。
 *
 * `binding.at > now` 也算失效:那意味着这条绑定来自「未来」——
 * 系统时钟回拨(或持久化文件被改)时会出现。留着它会让 TTL 永远算不到头,
 * 于是那条绑定事实上**永不过期**。
 */
function fresh(binding: Binding, now: number, ttlMs: number): boolean {
  if (binding.at > now) return false;
  return now - binding.at <= ttlMs;
}

/**
 * 超出容量时腾空间。**先清过期的,不够再按 FIFO 淘汰最老的。**
 *
 * 为什么先清过期:先前是无条件 FIFO,于是灌满这张表就能把别人**仍然有效**的
 * 绑定挤掉。第五轮审核实测了代价 —— 受害者正在进行的长对话丢失粘滞 →
 * 下一轮换 Worker → 客户端回放的加密推理块被上游拒,也就是
 * **Phase 5 刻意要避免的那个症状可以被主动诱发**。指纹表更便宜:
 * 每请求可学 64 个,79 个成功请求就能冲掉整张 5000 条的表。
 *
 * 先清过期把成本抬高了一个量级:攻击者要挤掉活跃绑定,得先让表里**全部**
 * 都是活跃的,也就是在 TTL 窗口内塞满 10000 个不同会话。而过期条目本来就
 * 该走 —— 它们只是因为「TTL 在读取时判定」才还留着。
 *
 * 仍保留 FIFO 兜底:全是活跃条目时总得淘汰一个,而最老的那个是最可能
 * 已经结束的。
 */
function evict(map: Map<string, Binding>, cap: number, now: number, ttlMs: number): void {
  if (map.size <= cap) return;

  // 第一轮:清过期(含"来自未来"的,见 fresh 的说明)。
  for (const [key, binding] of map) {
    if (map.size <= cap) return;
    if (!fresh(binding, now, ttlMs)) map.delete(key);
  }

  // 第二轮:仍超出说明全是活跃条目 —— 按插入顺序淘汰最老的。
  while (map.size > cap) {
    const oldest = map.keys().next();
    if (oldest.done === true) break;
    map.delete(oldest.value);
  }
}
