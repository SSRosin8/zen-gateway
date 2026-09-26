const relayTokenPlaceholder = "<把配置文件里的 gateway.relayToken 填进来>";

export type OpenCodeVersion = "1" | "2";

const clientModels = [
  ["muse-spark-1.3-contributor-free", "aisdk:@ai-sdk/openai"],
  ["big-pickle", "aisdk:@ai-sdk/openai-compatible"],
  ["space-bunny-free", "aisdk:@ai-sdk/openai-compatible"],
  ["mimo-v2.6-flash-free", "aisdk:@ai-sdk/openai-compatible"],
] as const;

/**
 * 生成 OpenCode 对应版本的 provider 配置。
 *
 * v1 只覆盖连接选项，保留内置 provider 的 npm/模型适配；v2 需要显式的
 * package 和逐模型 settings，避免 OpenCode 内置模型地址覆盖本地网关。
 */
export function createOpenCodeConfig(port: number, version: OpenCodeVersion = "2") {
  const settings = {
    baseURL: `http://127.0.0.1:${port}/v1`,
    apiKey: relayTokenPlaceholder,
  };

  if (version === "1") {
    return {
      $schema: "https://opencode.ai/config.json",
      provider: {
        opencode: {
          options: settings,
        },
      },
    };
  }

  return {
    providers: {
      opencode: {
        package: "aisdk:@ai-sdk/openai-compatible",
        settings,
        models: Object.fromEntries(
          clientModels.map(([id, packageName]) => [id, { package: packageName, settings }]),
        ),
      },
    },
    $schema: "https://opencode.ai/config.json",
  };
}

export function openCodeConfigSnippet(port: number, version: OpenCodeVersion = "2"): string {
  return JSON.stringify(createOpenCodeConfig(port, version), null, 2);
}
