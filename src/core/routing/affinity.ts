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

/** 会话键在哈希之前的长度上限 —— 客户端头不可信,不能让它无界增长。 */
const MAX_SESSION_KEY_LENGTH = 256;

/** sha256 十六进制摘要,64 个小写十六进制字符。 */
export function digestOf(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * 归一化客户端给的会话键。
 *
 * 去掉 CR/LF/Tab 是因为这个值**先前已经被当作 HTTP 头转发过**
 * (`x-opencode-session`),而 `headers.ts` 对含控制字符的值是**抛错**处理。
 * 这里不抛:亲和只是优化,一个奇怪的会话键不该让请求失败,
 * 归一化后照常用即可。
 */
export function normalizeSessionKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const clean = value.replace(/[\r\n\t]+/g, " ").trim();
  if (clean === "") return null;
  return clean.slice(0, MAX_SESSION_KEY_LENGTH);
}

/* ------------------------------------------------------------------ *
 * 推理指纹的提取
 * ------------------------------------------------------------------ */

/** 承载调用方绑定的加密推理的字段名。 */
const ENCRYPTED_BLOB_KEYS = new Set(["encrypted_content", "signature"]);

/*
 * 遍历上限。请求体来自客户端,可能是深度嵌套的多模态负载;
 * 无界遍历会让一个畸形请求体把 CPU 占满(而且发生在**转发之前**,
 * 所以上游都还没参与)。
 */
const MAX_BLOB_VALUES = 64;
const MAX_BLOB_VALUE_LENGTH = 16_384;
const MIN_BLOB_VALUE_LENGTH = 16;
const MAX_TRAVERSED_NODES = 20_000;
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
  let visited = 0;

  while (stack.length > 0 && hashes.size < MAX_BLOB_VALUES && visited < MAX_TRAVERSED_NODES) {
    const frame = stack.pop();
    if (frame === undefined) break;
    visited += 1;
    const { value, depth } = frame;

    if (Array.isArray(value)) {
      if (depth < MAX_TRAVERSE_DEPTH) {
        for (const item of value) stack.push({ value: item, depth: depth + 1 });
      }
      continue;
    }
    if (value === null || typeof value !== "object" || depth >= MAX_TRAVERSE_DEPTH) continue;

    for (const [key, entry] of Object.entries(value)) {
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
 * 养一个 interval(它还会在测试里把进程吊住)。`prune()` 由写入路径顺带调用。
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

  bindSession(sessionHash: string, workerId: string, now: number): void {
    // 先删再插:Map 按插入顺序迭代,这样重新绑定的会话回到队尾,淘汰的是最老的。
    this.#sessions.delete(sessionHash);
    this.#sessions.set(sessionHash, { workerId, at: now });
    evict(this.#sessions, SESSION_CAP);
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

  learnBlobs(hashes: readonly string[], workerId: string, now: number): void {
    for (const hash of hashes) {
      this.#blobs.delete(hash);
      this.#blobs.set(hash, { workerId, at: now });
    }
    evict(this.#blobs, BLOB_CAP);
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

/** 超出容量时从头(最老)开始淘汰。 */
function evict(map: Map<string, Binding>, cap: number): void {
  while (map.size > cap) {
    const oldest = map.keys().next();
    if (oldest.done === true) break;
    map.delete(oldest.value);
  }
}
