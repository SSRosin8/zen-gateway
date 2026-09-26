/**
 * 数据库迁移，只往前走，用 `PRAGMA user_version` 记档位。不写 down：
 * 库里全是可再生的运行时数据，回滚的做法是删库重建。
 * worker_id / proxy_id 是对 config.json 的弱引用，UI 不得据历史统计复活已删 Worker。
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
      -- ⚠️ 这一版仍然可被 NUL 字节绕过(实测):length() 与 GLOB
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
      -- idle 必须在列:它是状态机的一员,而 reducer 的单元测试
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
     * 档位 1 的 CHECK 可被 NUL 字节绕过：SQLite 的 `length()` 与 `GLOB` 对 TEXT
     * 在首个 NUL 处停止。补 `length(CAST(hash AS BLOB)) = 64` 限定字节数；
     * 字符长度与字节长度都要 64 才能排除多字节字符。
     *
     * SQLite 不支持 ALTER 修改 CHECK，故重建表 + 搬数据。不合规的旧行会让迁移
     * 回滚、拒绝启动，而不是静默丢行。
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
     * `gateway_rejections`：网关在打上游之前拒绝的请求，按天聚合计数。`model` 是
     * 客户端可控字符串，进库前经 `normalizeRejectionModel` 归一化以免无界增长；
     * `reason` 从 `judgeFree` 的联合类型推导（纪律 #4）。
     *
     * `model_usage.requests_dropped_usage`：网关自己丢的用量（`createUsageCollector.dropped()`），
     * 与上游没报用量分开计，两者处置方向相反。新列有 DEFAULT 0，旧行无需回填。
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
