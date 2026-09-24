/**
 * 数据库迁移。
 *
 * 每条迁移只往前走，用 `PRAGMA user_version` 记档位。不写 down：
 * 单机自用工具回滚 schema 的实际做法是删库重建（这里存的全是可再生的
 * 运行时数据），维护一套没人跑过的 down 脚本只会带来虚假的安全感。
 *
 * 表的边界：凡是高频写 + 需要聚合查询的都在这里；凭证与用户意图在 config.json。
 * 因此本库里的 worker_id / proxy_id 都是对 config.json 的弱引用 ——
 * 配置里删掉一个 Worker，它的历史统计会留下，UI 不得据此把它复活。
 */

export type Migration = {
  version: number;
  name: string;
  up: string;
};

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial",
    up: `
      -- Worker 累计计数。命中/失败按「上游尝试」计,不是按客户端请求。
      CREATE TABLE worker_stats (
        worker_id     TEXT PRIMARY KEY,
        attempts      INTEGER NOT NULL DEFAULT 0,
        successes     INTEGER NOT NULL DEFAULT 0,
        failures      INTEGER NOT NULL DEFAULT 0,
        last_used_at  INTEGER,
        last_status   INTEGER
      ) STRICT;

      -- per-model / per-worker / per-day token 用量。
      --
      -- requests_without_usage 单独计数,因为缺失的 usage 必须如实显示为缺失。
      -- 把它并进 with_usage 或按均值估算,会让「缓存命中率」这类比值凭空变好看。
      CREATE TABLE model_usage (
        model                   TEXT NOT NULL,
        worker_id               TEXT NOT NULL,
        day                     TEXT NOT NULL,
        input_tokens            INTEGER NOT NULL DEFAULT 0,
        output_tokens           INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens       INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens      INTEGER NOT NULL DEFAULT 0,
        requests_with_usage     INTEGER NOT NULL DEFAULT 0,
        requests_without_usage  INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (model, worker_id, day)
      ) STRICT;

      -- 上游尝试日志。
      --
      -- 一条客户端请求 = 一个 request_id;它的重试链有多行,每行一个 attempt。
      -- 这是统计页最容易搞错的语义:请求数不等于尝试数,但每次尝试都要在
      -- 对应 Worker 上可见,否则「这个 Worker 到底转发过什么」无从查证。
      CREATE TABLE upstream_attempts (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id     TEXT NOT NULL,
        attempt_index  INTEGER NOT NULL,
        worker_id      TEXT NOT NULL,
        protocol       TEXT NOT NULL,
        model          TEXT,
        status         INTEGER,
        failure_kind   TEXT,
        latency_ms     INTEGER,
        at             INTEGER NOT NULL
      ) STRICT;

      CREATE INDEX idx_attempts_request ON upstream_attempts (request_id);
      CREATE INDEX idx_attempts_at      ON upstream_attempts (at DESC);
      CREATE INDEX idx_attempts_worker  ON upstream_attempts (worker_id, at DESC);

      -- 出口探测结果。egress_ip 是出口隔离判定的唯一依据 ——
      -- 按 proxy_id 判断「是否共用出口」是错的,两个代理可能 NAT 到同一公网 IP。
      CREATE TABLE probe_results (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        proxy_id      TEXT NOT NULL,
        at            INTEGER NOT NULL,
        ok            INTEGER NOT NULL CHECK (ok IN (0, 1)),
        egress_ip     TEXT,
        latency_ms    INTEGER,
        failure_kind  TEXT
      ) STRICT;

      CREATE INDEX idx_probe_proxy ON probe_results (proxy_id, at DESC);

      -- 会话 → Worker 的粘滞绑定。
      --
      -- session_key 存 sha256 摘要而非原值:它来自客户端的
      -- x-opencode-session,内容不受我们控制,而这张表会进备份与诊断导出。
      --
      -- CHECK 同时限定长度与字符集,见 blob_affinity 处的说明。
      CREATE TABLE session_affinity (
        session_hash  TEXT PRIMARY KEY CHECK (
                        length(session_hash) = 64
                        AND session_hash NOT GLOB '*[^0-9a-f]*'
                      ),
        worker_id     TEXT NOT NULL,
        bound_at      INTEGER NOT NULL,
        expires_at    INTEGER NOT NULL
      ) STRICT;

      CREATE INDEX idx_session_expires ON session_affinity (expires_at);

      -- 加密推理块 → Worker。
      --
      -- CHECK 把「只存 sha256 摘要」从约定变成**结构约束**。
      --
      -- 只查长度是不够的:实测 64 个字符的原始推理文本、64 个 CJK 字符
      -- (192 字节)都能照常写进来,于是注释里「不可能有人存进原始推理内容」
      -- 这句是假的。加上字符集限制后,只有小写十六进制能通过。
      --
      -- ⚠️ 这一版仍然可被 NUL 字节绕过(第七轮审核实测):length() 与 GLOB
      -- 对 TEXT 都在首个 NUL 处停止,所以「64 个 hex + 一个 NUL + 任意明文」通过。
      -- 档位 2 补了 length(CAST(... AS BLOB)) = 64 才真正收口 ——
      -- 看这张表的当前形状要读档位 2,不是这里。
      CREATE TABLE blob_affinity (
        blob_hash   TEXT PRIMARY KEY CHECK (
                      length(blob_hash) = 64
                      AND blob_hash NOT GLOB '*[^0-9a-f]*'
                    ),
        worker_id   TEXT NOT NULL,
        learned_at  INTEGER NOT NULL,
        expires_at  INTEGER NOT NULL
      ) STRICT;

      CREATE INDEX idx_blob_expires ON blob_affinity (expires_at);

      -- 批量探测的长任务进度,由服务端持有。
      --
      -- 前端刷新或关页面后要能接着看,所以进度不能只活在浏览器内存里。
      --
      -- state 的取值范围就是状态机的字母表(idle | screening | running |
      -- paused | cancelling | done),写错状态名会被 CHECK 拦住。
      -- idle 必须在列:规划把它定义为状态机的一员,而 reducer 的单元测试
      -- 会把每个状态都往库里存一遍 —— 少一个就会在那里炸,而不是在这里。
      CREATE TABLE batch_probe_jobs (
        id                TEXT PRIMARY KEY,
        state             TEXT NOT NULL CHECK (
                            state IN ('idle','screening','running','paused','cancelling','done')
                          ),
        screen_total      INTEGER NOT NULL DEFAULT 0,
        screen_done       INTEGER NOT NULL DEFAULT 0,
        main_total        INTEGER NOT NULL DEFAULT 0,
        main_done         INTEGER NOT NULL DEFAULT 0,
        cancel_requested  INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
        added_worker_ids  TEXT NOT NULL DEFAULT '[]',
        failure_kind      TEXT,
        started_at        INTEGER NOT NULL,
        updated_at        INTEGER NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 2,
    name: "hash-check-counts-bytes",
    /*
     * 修掉一个**被第七轮审核实测绕过**的约束。
     *
     * 档位 1 的两个 CHECK 写的是 `length(hash) = 64`,而 SQLite 的 `length()`
     * 对 TEXT **在首个 NUL 字节处停止计数**,`GLOB` 同样只看 NUL 之前那段。
     * 于是「64 个 hex 字符 + 一个 NUL 字节 + 任意明文」完整通过校验:
     *
     *   length('abc' || char(0) || 'defghij')          → 3
     *   ('aaa'||char(0)||'ZZZ!!') NOT GLOB '*[^0-9a-f]*' → 1（通过）
     *
     * 实测经 `AffinityStore.putSession()` 写入这样一个值:`writeFailures` 为 0,
     * SQL 侧看到的 `length()` 是 64 而实际字节数 99,**明文完整落在磁盘文件里**
     * (wal_checkpoint 后 `strings` 搜得到),而 JS 读回时在 NUL 处被截断 ——
     * 也就是说所有读路径都看不见那条尾巴。
     *
     * 补 `length(CAST(hash AS BLOB)) = 64`:BLOB 的长度是真实字节数,NUL
     * 不再能截断判定。两个条件都留着 —— 字符长度与字节长度**都**必须是 64
     * 才能排除多字节字符(64 个 CJK 是 64 字符 / 192 字节,单看任一个都不够)。
     *
     * ## 为什么这条值得一个迁移而不是"反正生产路径不会触发"
     *
     * 今天确实触发不到:生产路径每个键都经 `digestOf()`,输出恒为纯 hex。
     * 但档位 1 的注释声称「把『只存 sha256 摘要』从约定**变成结构约束**」、
     * 「任何自然语言都进不来」—— 而那句是假的。**假的强保证比没有保证更危险**:
     * 下一条写入路径(Phase 9 的管理 API 手工绑定、导入/恢复工具、诊断回灌)
     * 的作者会读这句注释,然后不再自己检查。
     *
     * 迁移方式是**重建表 + 搬数据**:SQLite 不支持 ALTER 修改 CHECK。
     * 旧行全部来自 `digestOf()` 所以必然合规;万一有不合规的(手工改过库、
     * 从别处恢复的库),`INSERT INTO ... SELECT` 会被新 CHECK 拦下并让整条
     * 迁移回滚 —— 那是对的:一个装着非摘要值的库应当拒绝启动并让人来看,
     * 而不是静默丢掉那些行。
     */
    up: `
      CREATE TABLE session_affinity_new (
        session_hash  TEXT PRIMARY KEY CHECK (
                        length(session_hash) = 64
                        AND length(CAST(session_hash AS BLOB)) = 64
                        AND session_hash NOT GLOB '*[^0-9a-f]*'
                      ),
        worker_id     TEXT NOT NULL,
        bound_at      INTEGER NOT NULL,
        expires_at    INTEGER NOT NULL
      ) STRICT;

      INSERT INTO session_affinity_new (session_hash, worker_id, bound_at, expires_at)
        SELECT session_hash, worker_id, bound_at, expires_at FROM session_affinity;

      DROP TABLE session_affinity;
      ALTER TABLE session_affinity_new RENAME TO session_affinity;
      CREATE INDEX idx_session_expires ON session_affinity (expires_at);

      CREATE TABLE blob_affinity_new (
        blob_hash   TEXT PRIMARY KEY CHECK (
                      length(blob_hash) = 64
                      AND length(CAST(blob_hash AS BLOB)) = 64
                      AND blob_hash NOT GLOB '*[^0-9a-f]*'
                    ),
        worker_id   TEXT NOT NULL,
        learned_at  INTEGER NOT NULL,
        expires_at  INTEGER NOT NULL
      ) STRICT;

      INSERT INTO blob_affinity_new (blob_hash, worker_id, learned_at, expires_at)
        SELECT blob_hash, worker_id, learned_at, expires_at FROM blob_affinity;

      DROP TABLE blob_affinity;
      ALTER TABLE blob_affinity_new RENAME TO blob_affinity;
      CREATE INDEX idx_blob_expires ON blob_affinity (expires_at);
    `,
  },
  {
    version: 3,
    name: "gateway-rejections-and-dropped-usage",
    /*
     * 补齐规划要求的第六项统计（「网关拒绝」），并把「我们自己丢了用量」
     * 与「上游没报用量」分开 —— 两条都是第七轮审核查出的缺口。
     *
     * ## 一、`gateway_rejections`
     *
     * Phase 7 的验收列了六项统计，前五项都实现了，而第六项没有表、没有列、
     * 没有写入点。`relay.ts` 有六条在打上游**之前**就返回的路径
     * （400 读体失败 / 413 超限 / 400 空体 / 400 非法 JSON / 403 免费闸门 /
     * 503 无可用 Worker）全部零记录 —— 403 那条连日志都不打。
     * 于是「我有多少请求被网关自己挡了」完全无法回答，而
     * `not_free` 与 `retired` 的处置完全不同（前者改模型名、后者删
     * `extraFreeIds` 条目），哪种发生得多也不可观测。
     *
     * **按天聚合而不是逐条记行**，与 `model_usage` 同构：这是计数不是日志。
     * 更要紧的是它**不能无界增长** —— `model` 是客户端可控字符串，而被拒的
     * 请求里它恰好**没通过**任何校验（`not_free` 那条尤其）。所以：
     *
     * - `model` 进库前要归一化成占位符，除非它在已知目录里（见 `normalizeRejectionModel`）
     * - 按天 upsert，一个 reason × protocol × model 一行
     *
     * `reason` 的取值从 `judgeFree` 的 `reason` 联合类型 + 几个
     * `invalid_request` 子类推导，不另手写一份（纪律 #4）。
     *
     * ## 二、`model_usage.requests_dropped_usage`
     *
     * `createUsageCollector.dropped()` 的文档明写它与 `usage() === null`
     * **必须分开**，否则「覆盖率会把我们自己丢的计成上游没报的」——
     * 而 `recordUsage` 先前只看 `totals`，`.dropped()` 的唯一读者是一行日志。
     *
     * 两个入口都可达：一条 >1 MiB 的 `data:` 行被整条弃掉，以及**上游中途
     * 断流**（更常见）。与 Phase 7 刚修的「上游从不报用量显示成 100% 覆盖」
     * **严格对称**，而处置方向相反 —— 一个要改代码（我们的界定常量错了），
     * 一个不用（上游就是不报）。库里两者同形则分不出来。
     *
     * 新列有 DEFAULT 0，所以旧行不需要回填。
     */
    up: `
      CREATE TABLE gateway_rejections (
        reason    TEXT NOT NULL,
        protocol  TEXT NOT NULL,
        model     TEXT NOT NULL,
        day       TEXT NOT NULL,
        count     INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (reason, protocol, model, day)
      ) STRICT;

      CREATE INDEX idx_rejections_day ON gateway_rejections (day DESC);

      ALTER TABLE model_usage
        ADD COLUMN requests_dropped_usage INTEGER NOT NULL DEFAULT 0;
    `,
  },
];

/** 目标档位 = 最后一条迁移的版本。 */
export const TARGET_VERSION: number = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);
