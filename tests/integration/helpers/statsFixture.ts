import { afterEach, beforeEach } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { createApp } from "../../../src/server/app.ts";
import { Scheduler } from "../../../src/core/routing/scheduler.ts";
import { ConfigSchema, type Config } from "../../../src/shared/schema.ts";
import { openDb } from "../../../src/store/db/open.ts";
import { StatsStore } from "../../../src/store/db/stats.ts";
import { AffinityStore } from "../../../src/store/db/affinityStore.ts";
import { useFakeUpstream, type FakeUpstream } from "./fakeUpstream.ts";

/**
 * 统计与亲和持久化集成测试共用的装配:真实假上游 + 真实 SQLite,两个认证 Worker。
 *
 * 单测能验 `StatsStore` 按给定入参写对了行，但验不了**转发路径真的把
 * 那些入参凑对了**：中间隔着重试链的 `onAttempt`、流末尾的 `onDone`、
 * 以及「用量归属实际承接者而非候选链首位」这条只在重试发生时才分叉的规则。
 */

export const TOKEN = "stats-test-token-x";

export type StatsStoreFixture = {
  root: string;
  /** 用例可以关掉它制造写失败,再重开一个让 afterEach 能关。 */
  db: DatabaseSync;
  stats: StatsStore;
  affinityStore: AffinityStore;
};

export type StatsFixture = {
  up: FakeUpstream;
  store: StatsStoreFixture;
  config(over?: Record<string, unknown>): Config;
  relay(body: unknown, headers?: Record<string, string>): RequestInit;
  makeApp(cfg: Config, scheduler?: Scheduler, clock?: () => number): Promise<ReturnType<typeof createApp>>;
  chatBody(over?: Record<string, unknown>): Record<string, unknown>;
};

export function useStatsFixture(): StatsFixture {
  const up = useFakeUpstream({
    liveIds: ["big-pickle", "nemotron-3-ultra-free"],
    usage: { prompt_tokens: 40, completion_tokens: 10 },
  });
  const store = {} as StatsStoreFixture;

  beforeEach(async () => {
    store.root = await mkdtemp(join(tmpdir(), "zg-stats-"));
    await mkdir(join(store.root, "data"), { recursive: true, mode: 0o700 });
    store.db = openDb(join(store.root, "data", "runtime.db"));
    store.stats = new StatsStore(store.db);
    store.affinityStore = new AffinityStore(store.db);
  });

  afterEach(async () => {
    store.db.close();
    await rm(store.root, { recursive: true, force: true });
  });

  function config(over: Record<string, unknown> = {}): Config {
    return ConfigSchema.parse({
      version: 1,
      gateway: { relayToken: TOKEN, baseUrl: `http://127.0.0.1:${up.port}/v1` },
      workers: [
        { id: "w1", name: "", kind: "authenticated", apiKey: "fake-key-w1-not-real", enabled: true, proxyId: null },
        { id: "w2", name: "", kind: "authenticated", apiKey: "fake-key-w2-not-real", enabled: true, proxyId: null },
      ],
      ...over,
    });
  }

  function relay(body: unknown, headers: Record<string, string> = {}) {
    return {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    };
  }

  async function makeApp(cfg: Config, scheduler?: Scheduler, clock?: () => number) {
    return createApp({
      configOf: () => cfg,
      egress: up.egress,
      catalog: await up.warmCatalog(cfg),
      scheduler: scheduler ?? new Scheduler({ affinitySink: store.affinityStore }),
      stats: store.stats,
      ...(clock !== undefined ? { clock } : {}),
      log: () => {},
    });
  }

  const chatBody = (over: Record<string, unknown> = {}) => ({
    model: "big-pickle",
    messages: [{ role: "user", content: "hi" }],
    ...over,
  });

  return { up, store, config, relay, makeApp, chatBody };
}
