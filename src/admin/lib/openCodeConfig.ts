const relayTokenPlaceholder = "<把配置文件里的 gateway.relayToken 填进来>";

const clientModels = [
  ["muse-spark-1.3-contributor-free", "aisdk:@ai-sdk/openai"],
  ["big-pickle", "aisdk:@ai-sdk/openai-compatible"],
  ["space-bunny-free", "aisdk:@ai-sdk/openai-compatible"],
  ["mimo-v2.6-flash-free", "aisdk:@ai-sdk/openai-compatible"],
] as const;

/** OpenCode 2 的内置模型设置会覆盖 provider 设置，因此每个模型都要指定网关地址。 */
export function createOpenCodeConfig(port: number) {
  const settings = {
    baseURL: `http://127.0.0.1:${port}/v1`,
    apiKey: relayTokenPlaceholder,
  };
  return {
    providers: {
      opencode: {
        package: "aisdk:@ai-sdk/openai-compatible",
        settings,
        models: Object.fromEntries(
          clientModels.map(([id, sdk]) => [id, { package: sdk, settings }]),
        ),
      },
    },
  };
}

export function openCodeConfigSnippet(port: number): string {
  return JSON.stringify(createOpenCodeConfig(port), null, 2);
}
