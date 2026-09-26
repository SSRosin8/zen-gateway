import type { Config, Worker } from "../../shared/schema.ts";
import { ConfigSchema, WorkerSchema } from "../../shared/schema.ts";
import type { ConfigPatch, SecretPatch } from "../../shared/contract.ts";

/**
 * 把 `ConfigPatch` 应用到配置上的纯函数：合并规则里「错了不报错、只悄悄丢东西」的几条
 * 都能用断言钉住。失败用返回值表达，调用方据此映射成带类型的 HTTP 响应。
 */

export type PatchFailure =
  /** 要改/删的 Worker id 不存在。 */
  | { kind: "not_found"; message: string }
  /** 合并后的配置违反 schema 或引用完整性。 */
  | { kind: "invalid_config"; message: string };

export type PatchResult =
  | { ok: true; config: Config; changed: boolean }
  | { ok: false; failure: PatchFailure };

/**
 * 凭证三态：缺席不动、`{set}` 换值、`{clear:true}` 清空。清空必须显式（见 `SecretPatchSchema`）：
 * 前端拿不到原值，`""` 若表示清空，未填的输入框会静默抹掉 key。`{set: ""}` 交给 schema 处理。
 */
function applySecret(current: string, patch: SecretPatch | undefined): string {
  if (patch === undefined) return current;
  if ("clear" in patch) return "";
  return patch.set;
}

/**
 * 应用配置补丁，顺序为 create → update → delete：同一请求内可新建后立刻修改，
 * 「删掉又同名新建」的净效果是新建。
 */
export function applyConfigPatch(config: Config, patch: ConfigPatch): PatchResult {
  // 深拷贝，不改原对象：`Scheduler.#syncedFrom` 用引用比较判断配置是否变化。
  const next = structuredClone(config) as Config;

  /* ---- gateway ---- */
  if (patch.gateway !== undefined) {
    const g = patch.gateway;
    if (g.maxAttempts !== undefined) {
      next.gateway.maxAttempts = g.maxAttempts;
    }
    if (g.headersTimeoutMs !== undefined) {
      next.gateway.headersTimeoutMs = g.headersTimeoutMs;
    }
    if (g.bodyTimeoutMs !== undefined) {
      next.gateway.bodyTimeoutMs = g.bodyTimeoutMs;
    }
    if (g.relayToken !== undefined) {
      next.gateway.relayToken = applySecret(next.gateway.relayToken, g.relayToken);
    }
  }

  /* ---- models ---- */
  if (patch.models !== undefined) {
    const m = patch.models;
    if (m.freeSuffix !== undefined) {
      next.models.freeSuffix = m.freeSuffix;
    }
    if (m.extraFreeIds !== undefined) {
      next.models.extraFreeIds = [...m.extraFreeIds];
    }
    if (m.catalogTtlMs !== undefined) {
      next.models.catalogTtlMs = m.catalogTtlMs;
    }
    if (m.enforceCatalog !== undefined) {
      next.models.enforceCatalog = m.enforceCatalog;
    }
  }

  /* ---- workers ---- */
  if (patch.workers !== undefined) {
    const w = patch.workers;

    /*
     * 同一请求里要删的 id 不参与 create 的重复判定，以兑现「删后同名新建」。
     * update 不排除：改一个同请求内要删的 Worker 是自相矛盾的请求，应当报错。
     */
    const deleting = new Set(w.delete ?? []);

    if (w.create !== undefined) {
      for (const spec of w.create) {
        if (next.workers.some((x) => x.id === spec.id) && !deleting.has(spec.id)) {
          return {
            ok: false,
            failure: { kind: "invalid_config", message: `Worker id 已存在:${spec.id}` },
          };
        }
        // 过 `WorkerSchema` 而非手写字面量：默认值与 refine 只有一处（纪律 #4）。
        const parsed = WorkerSchema.safeParse({
          id: spec.id,
          name: spec.name,
          kind: spec.kind ?? "authenticated",
          apiKey: spec.apiKey,
          enabled: spec.enabled,
          proxyId: spec.proxyId,
        });
        if (!parsed.success) {
          return {
            ok: false,
            failure: {
              kind: "invalid_config",
              // 只给路径与规则，不回显值 —— 值里有 apiKey。
              message: `新建 Worker ${spec.id} 不合法:${issueText(parsed.error)}`,
            },
          };
        }
        next.workers.push(parsed.data as Worker);
      }
    }

    if (w.update !== undefined) {
      for (const [id, wp] of Object.entries(w.update)) {
        const index = next.workers.findIndex((x) => x.id === id);
        if (index === -1) {
          // 不静默跳过：否则响应 200 而值没变，用户无从得知 id 打错了。
          return { ok: false, failure: { kind: "not_found", message: `Worker 不存在:${id}` } };
        }
        const current = next.workers[index]!;
        next.workers[index] = {
          ...current,
          ...(wp.kind !== undefined ? { kind: wp.kind } : {}),
          ...(wp.name !== undefined ? { name: wp.name } : {}),
          ...(wp.enabled !== undefined ? { enabled: wp.enabled } : {}),
          // `proxyId: null` 是「改为直连」,与缺席(不动)不同 —— 见 schema 说明。
          ...(wp.proxyId !== undefined ? { proxyId: wp.proxyId } : {}),
          apiKey: applySecret(current.apiKey, wp.apiKey),
        };
      }
    }

    if (w.delete !== undefined) {
      for (const id of w.delete) {
        /*
         * `findIndex` 取第一个匹配，create 是 push 追加，所以 `delete X` + `create X` 删的是旧的。
         * 依赖 push 而非 unshift，有独立断言。
         */
        const index = next.workers.findIndex((x) => x.id === id);
        if (index === -1) {
          return { ok: false, failure: { kind: "not_found", message: `Worker 不存在:${id}` } };
        }
        next.workers.splice(index, 1);
      }
    }
  }

  /*
   * 全量过 `ConfigSchema`：其 `superRefine` 带引用完整性，指向已删除代理的 Worker
   * 会静默退回直连，与其他 Worker 共用公网 IP，破坏出口隔离。
   */
  const validated = ConfigSchema.safeParse(next);
  if (!validated.success) {
    return {
      ok: false,
      failure: { kind: "invalid_config", message: issueText(validated.error) },
    };
  }

  /*
   * `changed` 由真的比一次得出：管理 UI 提交整张表单，按字段出现与否判定会让每次保存都写盘。
   * 用 JSON 序列化比较：过 schema 后只含 JSON 原语且字段顺序固定，也不另造一份字段清单（纪律 #4）。
   * 比 `validated.data`：schema 补的默认值不算用户改动。
   */
  const changed = JSON.stringify(validated.data) !== JSON.stringify(config);

  return { ok: true, config: validated.data, changed };
}

/**
 * zod issue 列成人可读的行，只含路径与规则、不含值（值可能是凭证）。
 * 与 `config.ts` 的 `formatIssues` 同规则，刻意不复用其私有实现。
 */
function issueText(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues
    .slice(0, 10)
    .map((i) => {
      const path = i.path.length > 0 ? i.path.map(String).join(".") : "(根)";
      return `${path}: ${i.message}`;
    })
    .join("; ");
}
