const relayTokenPlaceholder = "<把配置文件里的 gateway.relayToken 填进来>";

export type OpenCodeVersion = "1" | "2";

/**
 * 生成 OpenCode 对应版本的 provider 配置。
 *
 * 两个版本都只覆盖内置 opencode provider 的连接设置。OpenCode 自己维护
 * provider package、模型目录和模型协议适配，网关不应复制或覆盖那份目录。
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
    $schema: "https://opencode.ai/config.json",
    providers: { opencode: { settings } },
  };
}

export function openCodeConfigSnippet(port: number, version: OpenCodeVersion = "2"): string {
  return JSON.stringify(createOpenCodeConfig(port, version), null, 2);
}
