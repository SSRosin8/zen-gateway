import { createHash } from "node:crypto";

/**
 * 会话亲和：会话 → Worker、加密推理指纹 → Worker。上游把加密推理块（`encrypted_content` /
 * `signature`）绑定到签发它的调用方身份，多轮对话换 Worker 会被拒，所以会话在其 Worker
 * 健康期间必须钉住。
 *
 * 两类键都只存 sha256 摘要：会话键内容不受控，推理块是用户对话的一部分。`data/runtime.db`
 * 用 CHECK 约束只接受 64 位小写十六进制，内存侧键形态必须一致。
 *
 * 内存是唯一读路径；传入 `AffinitySink` 时写入镜像到 `runtime.db`，启动时经 `restore()` 装回。
 */

/**
 * 会话/指纹表的容量上限（TTL 只在读取时过滤，不会自己腾空间）。导出供持久化层的 `LIMIT`
 * 推导：`restore()` 不调 `evict`，cap 调小或从旧库恢复时装载侧只能靠 `loadSessions` 的 `LIMIT`。
 */
export const SESSION_CAP = 10_000;
export const BLOB_CAP = 5_000;

/** 会话键长度上限；超过即不参与亲和而非截断。体内指针不受 `maxHeaderSize` 约束，需防对巨串做 sha256。 */
const MAX_SESSION_KEY_LENGTH = 4096;

/** sha256 十六进制摘要,64 个小写十六进制字符。 */
export function digestOf(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * 归一化客户端给的会话键；超长或空返回 null（不参与亲和）。去掉 CR/LF/Tab：该值同时作为
 * HTTP 头转发，而亲和只是优化，不该因怪键让请求失败。
 * 超长必须拒绝而非截断：截断在哈希之前等于摘要截断，前缀相同的会话会共用绑定，
 * 还能被用来改写他人绑定。
 */
export function normalizeSessionKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.length > MAX_SESSION_KEY_LENGTH) return null;
  const clean = value.replace(/[\r\n\t]+/g, " ").trim();
  if (clean === "") return null;
  return clean;
}

/** 承载调用方绑定的加密推理的字段名。 */
const ENCRYPTED_BLOB_KEYS = new Set(["encrypted_content", "signature"]);

// 遍历上限：请求体来自客户端，无界遍历会在转发前占满 CPU 与内存。
const MAX_BLOB_VALUES = 64;
const MAX_BLOB_VALUE_LENGTH = 16_384;
const MIN_BLOB_VALUE_LENGTH = 16;
/**
 * 遍历预算，入栈与出栈都计入：只数出栈时一次 pop 可压入百万级数组元素，而宽而扁的恶意体
 * 深度恒为 1，深度上限挡不住。超预算只少提取指纹，粘滞退化成策略排序。
 */
const MAX_TRAVERSAL_BUDGET = 20_000;
const MAX_TRAVERSE_DEPTH = 16;

/**
 * 从请求体的解析副本收集加密推理块的 sha256 指纹。只有摘要离开本函数，结果可进内存、日志、磁盘。
 */
export function extractBlobHashes(body: unknown): string[] {
  if (body === null || typeof body !== "object") return [];

  const hashes = new Set<string>();
  const stack: Array<{ value: unknown; depth: number }> = [{ value: body, depth: 0 }];

  // 单一预算，每个被检视的元素都扣一次，数组元素与对象字段在压栈前扣（数组元素扣两次，偏保守）。
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

    const record = value as Record<string, unknown>;
    // 不用 Object.entries：它会预先分配全部字段，宽对象可绕过预算；for...in 逐个读取。
    for (const key in record) {
      if (budget <= 0) break;
      budget -= 1;
      if (!Object.hasOwn(record, key)) continue;
      const entry = record[key];
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

/**
 * 「回放的推理不是发给这个调用方的」这类拒绝的措辞。匹配消息形态而非状态码（不变量 #3）：
 * SSE 可带着 200 把拒绝塞在流里。宁宽勿漏：误判只解绑一次，漏判让会话永久卡死。
 * 表预期会增长，所以重叠窗口必须从它推导。
 */
const STALE_REASONING_PATTERNS = [
  /not issued to this caller/i,
  /invalid.{0,24}signature/i,
  /signature.{0,24}(invalid|required|missing)/i,
  /reasoning.{0,40}signature/i,
];

/**
 * 跨块扫描的重叠窗口，从模式表推导而非手写（手写值不会随表增长，跨块扫描会按分块位置
 * 偶发漏检；纪律 #4）。每条模式的最长匹配 = 字面量长度 + 各 `{0,n}` 的 n，交替分支取最长；
 * 只覆盖本表用到的构造，遇到未知构造在启动期抛错。
 */
function longestPossibleMatch(pattern: RegExp): number {
  const src = pattern.source;
  let total = 0;
  let i = 0;

  while (i < src.length) {
    // `.{0,n}`：取上界 n。
    const quant = /^\.\{0,(\d+)\}/.exec(src.slice(i));
    if (quant !== null) {
      total += Number(quant[1]);
      i += quant[0].length;
      continue;
    }

    // `(a|b|c)`：取最长的一支。
    if (src[i] === "(") {
      const close = src.indexOf(")", i);
      if (close === -1) throw new Error(`STALE_REASONING_PATTERNS 含未闭合的分组: ${src}`);
      const alts = src.slice(i + 1, close).split("|");
      total += Math.max(...alts.map((a) => a.length));
      i = close + 1;
      continue;
    }

    // 其余当作一个字面量字符；正则元字符会让这个假设失效，故显式拒绝。
    const ch = src[i]!;
    if (/[*+?[\]\\{}^$|]/.test(ch)) {
      throw new Error(
        `STALE_REASONING_PATTERNS 用了 longestPossibleMatch 不认识的构造 \`${ch}\`（${src}）——` +
          `请扩展那个函数，否则重叠窗口会偏小而跨块扫描静默漏检。`,
      );
    }
    total += 1;
    i += 1;
  }

  return total;
}

export const STALE_PATTERN_WINDOW = Math.max(
  ...STALE_REASONING_PATTERNS.map(longestPossibleMatch),
);

export function containsStaleReasoning(text: string): boolean {
  if (text === "") return false;
  return STALE_REASONING_PATTERNS.some((pattern) => pattern.test(text));
}

/** 一条绑定。导出仅供测试构造 `evict` 的输入。 */
export type Binding = { workerId: string; at: number };

/**
 * 持久化接收端，由 `store/db/affinityStore.ts` 实现。`AffinityMap` 在每次内存变更（含容量淘汰）
 * 后通知它：内存决定、DB 跟随，淘汰规则只有一份（纪律 #4）。所有方法不得抛异常：
 * 持久化是可用性改善，写盘失败不该让转发失败。
 */
export type AffinitySink = {
  putSession(hash: string, workerId: string, at: number, ttlMs: number): void;
  deleteSession(hash: string): void;
  putBlobs(hashes: readonly string[], workerId: string, at: number, ttlMs: number): void;
  deleteBlobs(hashes: readonly string[]): void;
};

/** `restore()` 的入参：一条带 key 的绑定。与持久化层的 `StoredBinding` 同形。 */
export type RestoredBinding = {
  readonly hash: string;
  readonly workerId: string;
  readonly at: number;
};

/**
 * 两张有界的 TTL 映射，TTL 与容量都在读取时判定，不起定时器。过期条目由查询时就地删除
 * 与 `evict`（容量满时优先清过期）清理。`prune()` 目前没有生产调用方（有意：上述两条已保证
 * 有界）。查询路径不碰 sink。
 */
export class AffinityMap {
  #sessions = new Map<string, Binding>();
  #blobs = new Map<string, Binding>();
  #sink: AffinitySink | null;

  constructor(sink?: AffinitySink) {
    this.#sink = sink ?? null;
  }

  /**
   * 启动时把已持久化的绑定装回内存。须按 `at` 升序传入：Map 迭代顺序即 FIFO 淘汰顺序
   * （见 `loadSessions`）。不触发 sink，也不做 TTL 过滤（由后续读取的 `fresh()` 收口）。
   */
  restore(sessions: readonly RestoredBinding[], blobs: readonly RestoredBinding[]): void {
    for (const b of sessions) this.#sessions.set(b.hash, { workerId: b.workerId, at: b.at });
    for (const b of blobs) this.#blobs.set(b.hash, { workerId: b.workerId, at: b.at });
  }

  /** 查会话绑定的 Worker。`workerExists` 让已删除 Worker 的绑定立刻失效。 */
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
      // DB 也要删，否则指向已删除 Worker 的绑定每次重启复活。
      this.#sink?.deleteSession(sessionHash);
      return null;
    }
    return found.workerId;
  }

  /** 绑定会话。`ttlMs` 供 `evict` 优先清过期项。 */
  bindSession(sessionHash: string, workerId: string, now: number, ttlMs: number): void {
    // 先删再插：重新绑定的会话回到队尾。
    this.#sessions.delete(sessionHash);
    this.#sessions.set(sessionHash, { workerId, at: now });
    this.#sink?.putSession(sessionHash, workerId, now, ttlMs);
    const dropped = evict(this.#sessions, SESSION_CAP, now, ttlMs);
    for (const key of dropped) this.#sink?.deleteSession(key);
  }

  unbindSession(sessionHash: string): void {
    this.#sessions.delete(sessionHash);
    this.#sink?.deleteSession(sessionHash);
  }

  /**
   * 推理指纹提示的 Worker。必须全体一致：所有指纹都指向同一个 Worker 才给提示；混合来源的
   * 推理无论选谁都会被拒，此时提示反而会把请求钉到必败的那个。
   */
  findBlobWorker(
    hashes: readonly string[],
    now: number,
    ttlMs: number,
    workerExists: (workerId: string) => boolean,
  ): string | null {
    if (hashes.length === 0) return null;

    /*
     * 失效条目就地删掉，与 `lookupSession` 同构（纪律 #4）：指向已删除 Worker 的条目不会过期，
     * 否则每次重启都从 DB 复活并占着 `BLOB_CAP`。收集后统一删，避免逐条开事务。
     */
    const stale: string[] = [];
    let candidate: string | null = null;
    let usable = true;

    for (const hash of hashes) {
      const found = this.#blobs.get(hash);
      if (found === undefined) {
        usable = false;
        continue;
      }
      if (!fresh(found, now, ttlMs)) {
        this.#blobs.delete(hash);
        stale.push(hash);
        usable = false;
        continue;
      }
      if (candidate === null) candidate = found.workerId;
      else if (candidate !== found.workerId) usable = false;
    }

    // `workerExists` 只需对候选者问一次。
    if (candidate !== null && !workerExists(candidate)) {
      for (const hash of hashes) {
        const found = this.#blobs.get(hash);
        if (found !== undefined && found.workerId === candidate) {
          this.#blobs.delete(hash);
          stale.push(hash);
        }
      }
      usable = false;
    }

    if (stale.length > 0) this.#sink?.deleteBlobs(stale);

    if (!usable || candidate === null) return null;
    return candidate;
  }

  /** 学习指纹。`ttlMs` 供 `evict` 优先清过期项。 */
  learnBlobs(hashes: readonly string[], workerId: string, now: number, ttlMs: number): void {
    for (const hash of hashes) {
      this.#blobs.delete(hash);
      this.#blobs.set(hash, { workerId, at: now });
    }
    this.#sink?.putBlobs(hashes, workerId, now, ttlMs);
    const dropped = evict(this.#blobs, BLOB_CAP, now, ttlMs);
    if (dropped.length > 0) this.#sink?.deleteBlobs(dropped);
  }

  forgetBlobs(hashes: readonly string[]): void {
    for (const hash of hashes) this.#blobs.delete(hash);
    this.#sink?.deleteBlobs(hashes);
  }

  /** 供诊断与测试，只给数量不暴露键。 */
  sizes(): { sessions: number; blobs: number } {
    return { sessions: this.#sessions.size, blobs: this.#blobs.size };
  }

  /** 丢掉过期与指向已删除 Worker 的条目。 */
  prune(now: number, ttlMs: number, workerExists: (workerId: string) => boolean): void {
    const droppedSessions: string[] = [];
    const droppedBlobs: string[] = [];
    for (const [key, binding] of this.#sessions) {
      if (!fresh(binding, now, ttlMs) || !workerExists(binding.workerId)) {
        this.#sessions.delete(key);
        droppedSessions.push(key);
      }
    }
    for (const [key, binding] of this.#blobs) {
      if (!fresh(binding, now, ttlMs) || !workerExists(binding.workerId)) {
        this.#blobs.delete(key);
        droppedBlobs.push(key);
      }
    }
    for (const key of droppedSessions) this.#sink?.deleteSession(key);
    if (droppedBlobs.length > 0) this.#sink?.deleteBlobs(droppedBlobs);
  }
}

/** 绑定是否还有效。`at > now`（时钟回拨或文件被改）也算失效，否则那条绑定永不过期。 */
function fresh(binding: Binding, now: number, ttlMs: number): boolean {
  if (binding.at > now) return false;
  return now - binding.at <= ttlMs;
}

/**
 * 超出容量时腾空间：先清过期，不够再按 FIFO 淘汰最老的。无条件 FIFO 会让攻击者灌满表挤掉
 * 他人仍活跃的绑定（指纹表每请求可学 64 个），诱发亲和要避免的推理块被拒。
 * 返回被淘汰的键供持久化层一并删除，本函数保持纯。
 * 导出是因为「新鲜绑定排在插入顺序最前」经公开 API 构造不出来，只能直接构造 Map 测试。
 */
export function evict(map: Map<string, Binding>, cap: number, now: number, ttlMs: number): string[] {
  if (map.size <= cap) return [];

  const dropped: string[] = [];

  // 第一轮：清过期（含来自未来的）。
  for (const [key, binding] of map) {
    if (map.size <= cap) return dropped;
    if (!fresh(binding, now, ttlMs)) {
      map.delete(key);
      dropped.push(key);
    }
  }

  // 第二轮：全是活跃条目，按插入顺序淘汰最老的。
  while (map.size > cap) {
    const oldest = map.keys().next();
    if (oldest.done === true) break;
    map.delete(oldest.value);
    dropped.push(oldest.value);
  }

  return dropped;
}
