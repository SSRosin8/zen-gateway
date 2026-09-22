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
      CREATE TABLE session_affinity (
        session_hash  TEXT PRIMARY KEY CHECK (length(session_hash) = 64),
        worker_id     TEXT NOT NULL,
        bound_at      INTEGER NOT NULL,
        expires_at    INTEGER NOT NULL
      ) STRICT;

      CREATE INDEX idx_session_expires ON session_affinity (expires_at);

      -- 加密推理块 → Worker。
      --
      -- CHECK 把「只存摘要」从约定变成结构约束:长度不等于 64 的值根本写不进来,
      -- 于是不可能有人图方便直接存进原始推理内容。
      CREATE TABLE blob_affinity (
        blob_hash   TEXT PRIMARY KEY CHECK (length(blob_hash) = 64),
        worker_id   TEXT NOT NULL,
        learned_at  INTEGER NOT NULL,
        expires_at  INTEGER NOT NULL
      ) STRICT;

      CREATE INDEX idx_blob_expires ON blob_affinity (expires_at);

      -- 批量探测的长任务进度,由服务端持有。
      --
      -- 前端刷新或关页面后要能接着看,所以进度不能只活在浏览器内存里。
      -- state 的取值范围就是状态机的字母表,写错状态名会被 CHECK 拦住。
      CREATE TABLE batch_probe_jobs (
        id                TEXT PRIMARY KEY,
        state             TEXT NOT NULL CHECK (
                            state IN ('screening','running','paused','cancelling','done')
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
];

/** 目标档位 = 最后一条迁移的版本。 */
export const TARGET_VERSION: number = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);
