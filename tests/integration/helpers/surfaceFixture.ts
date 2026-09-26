import { createApp } from "../../../src/server/app.ts";
import type { ModelCatalog } from "../../../src/core/models/catalog.ts";
import { ConfigSchema, type Config } from "../../../src/shared/schema.ts";
import { useFakeUpstream, type FakeUpstream } from "./fakeUpstream.ts";

/**
 * 协议面、目录与用量集成测试共用的装配:一个假上游、一个认证 Worker。
 *
 * 在架目录里有两个免费模型和一个付费模型,付费那个用来验证
 * 「在架但不免费」仍被拒。
 */

export const TOKEN = "surface-test-token-x";

export type SurfaceFixture = {
  up: FakeUpstream;
  config(over?: Record<string, unknown>): Config;
  relay(body: unknown, headers?: Record<string, string>): RequestInit;
  /** 建 app;可选注入一个已预热的目录与日志收集器。 */
  app(cfg?: Config, catalog?: ModelCatalog, log?: (m: string) => void): ReturnType<typeof createApp>;
};

export function useSurfaceFixture(): SurfaceFixture {
  const up = useFakeUpstream({
    liveIds: ["big-pickle", "nemotron-3-ultra-free", "claude-opus-5"],
    usage: { prompt_tokens: 11, completion_tokens: 4 },
  });

  function config(over: Record<string, unknown> = {}): Config {
    return ConfigSchema.parse({
      version: 1,
      gateway: { relayToken: TOKEN, baseUrl: `http://127.0.0.1:${up.port}/v1` },
      workers: [
        { id: "w1", name: "", kind: "authenticated", apiKey: "fake-key-w1-not-real", enabled: true, proxyId: null },
      ],
      ...over,
    });
  }

  function relay(body: unknown, headers: Record<string, string> = {}) {
    return {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    };
  }

  function app(cfg: Config = config(), catalog?: ModelCatalog, log?: (m: string) => void) {
    return createApp({
      configOf: () => cfg,
      egress: up.egress,
      ...(catalog !== undefined ? { catalog } : {}),
      log: log ?? (() => {}),
    });
  }

  return { up, config, relay, app };
}
