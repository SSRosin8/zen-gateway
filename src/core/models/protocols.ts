import { z } from "zod";
import { fetch as undiciFetch } from "undici";
import type { ProtocolId } from "../../shared/schema.ts";
import { safeErrorMessage } from "../../shared/redact.ts";
import { readBoundedText } from "./catalog.ts";

/**
 * 模型页「协议」列的声明来源：models.dev 里 `opencode` provider 的 AI SDK 包名。
 * OpenCode 按这个包名决定对某个 Zen 模型发哪种请求，所以它是「客户端会用哪个面」的依据。
 *
 * 只作展示，不进免费判定、不进转发（`catalog.ts` 的在架目录不回落 models.dev）。
 * models.dev 是第三方聚合，可能落后于 Zen；声明不证明 Zen 当前接受哪个面。
 *
 * 不经 Worker 出口：这不是发给 Zen 的请求，走出口会占用桥接 selector 锁并把 Worker 的
 * 出口暴露给第三方。用 undici 默认 dispatcher（服务进程的 CA 环境同样生效）。
 * 缓存、退避与合流的形状跟 `ModelCatalog` 一致：请求路径只读缓存、后台刷新。
 */

export const MODELS_DEV_URL = "https://models.dev/api.json";

/** 声明的协议：网关的三个面之一，或网关没有对应面的包（如 `@ai-sdk/google`）。 */
export type DeclaredProtocol = ProtocolId | "other";

/** OpenCode 的包名 → 请求协议。其余包名网关都没有对应的面。 */
const NPM_PROTOCOL: Readonly<Record<string, ProtocolId>> = {
  "@ai-sdk/openai-compatible": "chat",
  "@ai-sdk/openai": "responses",
  "@ai-sdk/anthropic": "messages",
};

export function protocolOfNpm(npm: string | undefined): DeclaredProtocol | null {
  if (npm === undefined || npm === "") return null;
  return Object.hasOwn(NPM_PROTOCOL, npm) ? NPM_PROTOCOL[npm]! : "other";
}

/** 整份 api.json 当前约 5 MB；上限留余量，挡住「在跟别的东西说话」。 */
const MAX_BYTES = 32 * 1024 * 1024;
/** `opencode` 下的模型数（当前一百多个）。超过即不采纳，不截断。 */
const MAX_MODELS = 4096;
const TTL_MS = 6 * 60 * 60 * 1000;
/** 失败后多久再试；比目录的 30 秒长，第三方故障没有必要频繁重试。 */
const FAILURE_BACKOFF_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 20_000;

/** 只校验用到的字段；z.object 丢弃其余字段，不把 5 MB 留在内存里。 */
const ModelsDevSchema = z.object({
  opencode: z.object({
    npm: z.string().max(256).optional(),
    models: z.record(
      z.string().min(1).max(256),
      z.object({ provider: z.object({ npm: z.string().max(256).optional() }).optional() }),
    ),
  }),
});

/** 解析出 id → 声明协议；不可采纳时返回 null。模型级 `provider.npm` 优先，缺省用 provider 级。 */
export function parseModelsDev(payload: unknown): ReadonlyMap<string, DeclaredProtocol | null> | null {
  const parsed = ModelsDevSchema.safeParse(payload);
  if (!parsed.success) return null;
  const { npm, models } = parsed.data.opencode;
  const ids = Object.keys(models);
  if (ids.length === 0 || ids.length > MAX_MODELS) return null;
  return new Map(ids.map((id) => [id, protocolOfNpm(models[id]!.provider?.npm ?? npm)] as const));
}

export type ProtocolSnapshot = {
  readonly byModel: ReadonlyMap<string, DeclaredProtocol | null>;
  readonly fetchedAt: number;
};

export type ProtocolDeclarationsOptions = {
  /** 测试指向本机假服务。 */
  readonly url?: string;
  readonly fetchImpl?: typeof undiciFetch;
  readonly clock?: () => number;
  readonly timeoutMs?: number;
  readonly log?: (message: string) => void;
};

export class ProtocolDeclarations {
  #snapshot: ProtocolSnapshot | null = null;
  #failedAt: number | null = null;
  #inFlight: Promise<ProtocolSnapshot | null> | null = null;
  readonly #url: string;
  readonly #fetch: typeof undiciFetch;
  readonly #clock: () => number;
  readonly #timeoutMs: number;
  readonly #log: ((message: string) => void) | undefined;

  constructor(opts: ProtocolDeclarationsOptions = {}) {
    this.#url = opts.url ?? MODELS_DEV_URL;
    this.#fetch = opts.fetchImpl ?? undiciFetch;
    this.#clock = opts.clock ?? Date.now;
    this.#timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
    this.#log = opts.log;
  }

  /** 最后一次成功的声明，不发请求。 */
  cached(): ProtocolSnapshot | null {
    return this.#snapshot;
  }

  /**
   * 过期或从未成功时在后台拉一次；失败退避期内不再发请求。调用方不 await（请求路径只读
   * `cached()`）；返回在途任务只为让测试和启动预热能等到结果，不需要拉取时返回 null。
   */
  refreshIfStale(): Promise<ProtocolSnapshot | null> | null {
    const now = this.#clock();
    if (this.#snapshot !== null && now - this.#snapshot.fetchedAt < TTL_MS) return null;
    if (this.#inFlight !== null) return this.#inFlight;
    // 时钟回拨（age < 0）视为退避已过，与 `ModelCatalog.#inBackoff` 一致。
    if (this.#failedAt !== null) {
      const age = now - this.#failedAt;
      if (age >= 0 && age < FAILURE_BACKOFF_MS) return null;
    }

    const task = this.#doFetch()
      .then((snapshot) => {
        if (snapshot === null) this.#failedAt = this.#clock();
        else {
          this.#failedAt = null;
          this.#snapshot = snapshot;
        }
        return snapshot;
      })
      // 无人 await 的后台任务，异常必须吞掉。
      .catch(() => null)
      .finally(() => {
        this.#inFlight = null;
      });
    this.#inFlight = task;
    return task;
  }

  async #doFetch(): Promise<ProtocolSnapshot | null> {
    try {
      const response = await this.#fetch(this.#url, {
        method: "GET",
        redirect: "manual",
        headers: { accept: "application/json" },
        // 同一个信号也覆盖读体阶段：慢速滴流的响应不会无限占住连接。
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      if (response.status < 200 || response.status >= 300) {
        await response.body?.cancel().catch(() => {});
        this.#log?.(`models.dev 协议声明拉取返回 ${response.status}`);
        return null;
      }
      const text = await readBoundedText(response, MAX_BYTES);
      const byModel = parseModelsDev(JSON.parse(text));
      if (byModel === null) {
        this.#log?.("models.dev 协议声明未通过校验，保留上一份");
        return null;
      }
      return { byModel, fetchedAt: this.#clock() };
    } catch (err) {
      this.#log?.(`models.dev 协议声明拉取失败: ${safeErrorMessage(err)}`);
      return null;
    }
  }
}
