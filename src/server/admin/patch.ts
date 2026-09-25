import type { Config, Worker } from "../../shared/schema.ts";
import { ConfigSchema, WorkerSchema } from "../../shared/schema.ts";
import type { ConfigPatch, SecretPatch } from "../../shared/contract.ts";

/**
 * 把一个 `ConfigPatch` 应用到配置上 —— **纯函数**。
 *
 * ## 为什么是纯函数而不是直接在 handler 里改
 *
 * 合并规则里有好几条是「错了不报错、只是悄悄丢东西」的类型
 * （凭证被清空、引用完整性被破坏、调度状态被重置）。纯函数让每一条都能
 * 用一行断言钉住，不必起 HTTP。这与 `routing/` 四块纯函数同一个理由：
 * 判断能被穷举测试，而 handler 只需验证「接得对」。
 *
 * 失败用返回值表达而不是抛异常:调用方要把失败变成一个带类型的 HTTP 响应,
 * 而异常会让「哪种失败」退化成字符串匹配。
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
 * 应用一个凭证 patch。
 *
 * 三态:缺席不动、`{set}` 换值、`{clear:true}` 清空。**清空必须显式** ——
 * 见 `SecretPatchSchema` 的说明:前端拿不到原值(投影只给 present),
 * 所以不能靠「回传原值」表达「不动它」,于是 `""` 必须**不是**清空的意思,
 * 否则一个未填的输入框会静默抹掉能用的 key。
 *
 * `{set: ""}` 也**不**当作清空:它是「把凭证设成空串」这个自相矛盾的请求,
 * 交给 schema 去拒(`RelayTokenSchema.min(16)`)或按空值处理(apiKey)。
 * 这里不替调用方做那个决定。
 */
function applySecret(current: string, patch: SecretPatch | undefined): string {
  if (patch === undefined) return current;
  if ("clear" in patch) return "";
  return patch.set;
}

/**
 * 应用配置补丁。
 *
 * 顺序刻意是 **create → update → delete**:
 *
 * - create 在 update 之前,于是同一个请求里「新建一个 Worker 并立刻改它」
 *   能成立(虽然前端不会这么用,但那是个自然的语义,而反过来会让 update
 *   报 not_found —— 一个纯粹由实现顺序造成的失败)。
 * - delete 最后,于是「删掉一个又同名新建」的净效果是新建,而不是
 *   「建完又被删掉」—— 后者会让用户以为新建失败了。
 */
export function applyConfigPatch(config: Config, patch: ConfigPatch): PatchResult {
  /*
   * 深拷贝。**不能改原对象**:`Scheduler.#syncedFrom` 用**引用比较**判断
   * 「配置换了没有」(深比较一份含 512 个 Worker 的配置要跑在每个请求上)。
   * 原地改会让引用不变 → 调度器认为配置没换 → Worker 池不重新 sync,
   * 于是改了配置下一个请求还在用旧的池。而这个偏差**不报任何错**。
   */
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
     * 同一请求里要删掉的 id —— 它们不参与"重复 id"判定（缺口 #27）。
     *
     * 文件头承诺「删掉一个又同名新建的净效果是新建」，而先前的重复检查看的是
     * `next.workers`（那里还有待删的那个），于是 `delete X` + `create X`
     * 被拒 —— **注释与行为相反**。用户想换一个 Worker 的 id/key 时
     * 必须发两次请求，而中间那一刻配置里少了一个 Worker。
     *
     * 只在 `create` 里排除，`update` 不排除：更新一个同请求内要删的 Worker
     * 是自相矛盾的请求（改完就删），那种应当报错而不是静默接受。
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
        /*
         * 走一遍 `WorkerSchema` 而不是手写对象字面量。
         *
         * 那份 schema 带默认值与 `refine`（登录态必须有 apiKey），
         * 手写会让两处默认值分叉(纪律 #4) —— 而分叉方向是漏:schema 新增
         * 一个带默认值的字段时,这里造出来的对象会缺它。
         */
        const parsed = WorkerSchema.safeParse({
          id: spec.id,
          name: spec.name,
          kind: "authenticated",
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
          /*
           * **不静默跳过。** 静默跳过会让「我明明改了」变成一个查不出的问题:
           * 响应 200、界面刷新后值没变,而用户不知道是 id 打错了还是没生效。
           */
          return { ok: false, failure: { kind: "not_found", message: `Worker 不存在:${id}` } };
        }
        const current = next.workers[index]!;
        next.workers[index] = {
          ...current,
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
         * `findIndex` 取**第一个**匹配,而 create 是 `push`（追加到末尾）——
         * 于是 `delete X` + `create X` 删掉的是**旧的那个**,新建的留下。
         * 那正是文件头承诺的"净效果是新建"。
         *
         * 这个正确性依赖"create 追加而不是插入开头",所以它有一条独立的断言
         * （不然下一个人把 push 改成 unshift 就会静默删掉刚建的那个,
         * 而症状是"我换了 key 但它没了"）。
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
   * 全量过一遍 `ConfigSchema`。
   *
   * 这不只是形状校验 —— 那个 schema 的 `superRefine` 带**引用完整性**:
   * 一个指向已删除代理的 Worker 会静默退回本机直连出口,于是它和其他 Worker
   * 共用同一个公网 IP,而出口隔离正是本项目存在的理由。这种失败必须在这里
   * 就暴露,不能等到 Zen 因同 IP 多账号而封号。
   *
   * 也挡住「删掉一个代理但 Worker 还绑着它」这类跨资源的不一致 ——
   * 而那是管理面最容易产生的错误形态。
   */
  const validated = ConfigSchema.safeParse(next);
  if (!validated.success) {
    return {
      ok: false,
      failure: { kind: "invalid_config", message: issueText(validated.error) },
    };
  }

  /*
   * `changed` 由**真的比一次**得出，而不是「有没有出现这个字段」（缺口 #26）。
   *
   * 先前每个赋值点都跟一句 `changed = true`，于是把一个字段写成它**当前的值**
   * 也算"改了" —— 而管理 UI 提交的是整张表单，所以网关页每次「保存」都会触发
   * 一次原子写 + Worker 池 re-sync，即使用户什么都没动。
   * `admin.ts` 的注释承诺的正是相反的行为。
   *
   * 用 JSON 序列化比较而不是逐字段深比较：
   *
   * - `Config` 过 `ConfigSchema.parse` 之后只含 JSON 原语/数组/记录
   *   （没有 Date/Map/undefined），所以序列化是无损的；
   * - 字段顺序由 schema 固定（`structuredClone` 保序，赋值不新增键），
   *   所以"同样的配置"一定得到同样的字符串；
   * - 手写一份逐字段比较会是**第二份**关于"Config 有哪些字段"的真相，
   *   而 schema 加字段时它不会跟着变（纪律 #4）。
   *
   * 比的是 `validated.data` 而不是 `next` —— schema 会补默认值，
   * 而"补了一个默认值"不该算用户改了东西。
   */
  const changed = JSON.stringify(validated.data) !== JSON.stringify(config);

  return { ok: true, config: validated.data, changed };
}

/**
 * zod 的 issue 列成人可读的行 —— **只含路径与规则,不含值**。
 *
 * 与 `config.ts` 的 `formatIssues` 同一条规则(那里写着理由:值里每一行都
 * 可能是凭证)。刻意不复用那个函数:它是 `config.ts` 的私有实现,
 * 而把它导出会让一个「加载期错误格式化」变成公共 API。两处各自很短。
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
