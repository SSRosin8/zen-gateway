import { useState } from "react";
import type { Overview } from "../../shared/contract.ts";
import { Mono, Panel, PrimaryButton, Strong } from "../components/Panel.tsx";
import { StatusIndicator } from "../components/StatusIndicator.tsx";
import { patchConfig } from "../lib/api.ts";
import { openCodeConfigSnippet, type OpenCodeVersion } from "../lib/openCodeConfig.ts";

/**
 * 网关页 —— 连接信息与客户端配置片段。
 *
 * ## 这一页的主要价值是那段可复制的配置
 *
 * 提供兼容 OpenCode 1/2 的 `opencode.json` 片段。
 * 手写那段配置是最容易出错的一步（端口、路径、token 三处都能写错），
 * 而写错的症状是 401 或连接被拒 —— 两者都指不到「你的 baseURL 少了 /v1」。
 *
 * **Relay Token 不在片段里**：它是凭证，而这一页只有指纹。片段里放一个
 * 占位符并告诉用户去哪儿取 —— 把 token 渲染进 DOM 等于让它进截图、进
 * 浏览器扩展、进 devtools 的保存。
 */
export function GatewayPage({ data, refresh }: { data: Overview; refresh?: () => void }) {
  const [maxAttempts, setMaxAttempts] = useState(String(data.gateway.maxAttempts));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [openCodeVersion, setOpenCodeVersion] = useState<OpenCodeVersion>("2");
  const snippet = openCodeConfigSnippet(data.gateway.port, openCodeVersion);

  return (
    <div className="space-y-4">
      <Panel title="连接">
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2">
          <dt className="text-text-muted">监听</dt>
          <dd>
            <Mono>127.0.0.1:{data.gateway.port}</Mono>
            <span className="ml-2 text-text-muted">仅回环 —— 不对外监听</span>
          </dd>
          <dt className="text-text-muted">上游</dt>
          <dd>
            <Mono>{data.gateway.baseUrl}</Mono>
          </dd>
          <dt className="text-text-muted">Relay Token</dt>
          <dd>
            {data.gateway.relayToken.present ? (
              <>
                <Mono>{data.gateway.relayToken.fingerprint}</Mono>
                <span className="ml-2 text-text-muted">
                  只显示指纹（供比对）；完整值在 <Mono>data/config.json</Mono>
                </span>
              </>
            ) : (
              <span className="text-error">未配置 —— 转发面会拒绝一切请求</span>
            )}
          </dd>
          <dt className="text-text-muted">最多尝试</dt>
          <dd>
            {data.gateway.maxAttempts} 个 Worker
            <span className="ml-2 text-text-muted">一条客户端请求最多换几次</span>
          </dd>
          <dt className="text-text-muted">版本</dt>
          <dd>
            <Mono>v{data.health.version}</Mono>
            <span className="ml-2 text-text-muted">pid {data.health.pid}</span>
          </dd>
        </dl>
      </Panel>

      <Panel title="运行设置">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            setSaving(true);
            setMessage(null);
            void patchConfig({ gateway: { maxAttempts: Number(maxAttempts) } })
              .then(() => {
                setMessage("已保存");
                refresh?.();
              })
              .catch((err) => setMessage(err instanceof Error ? err.message : String(err)))
              .finally(() => setSaving(false));
          }}
        >
          <label className="flex flex-col gap-1">
            <span className="text-text-muted">最多尝试 Worker 数</span>
            <input
              type="number"
              min={1}
              max={10}
              required
              value={maxAttempts}
              onChange={(e) => setMaxAttempts(e.target.value)}
              className="min-h-[44px] w-40 rounded-sm border border-border-strong bg-bg px-3"
            />
          </label>
          <PrimaryButton type="submit" onClick={() => undefined} disabled={saving}>
            {saving ? "保存中…" : "保存"}
          </PrimaryButton>
          {message !== null && <span className="text-text-muted">{message}</span>}
        </form>
      </Panel>

      <Panel title="客户端配置">
        <p className="mb-3 text-text-muted">
          选择你的 OpenCode 主版本，生成覆盖本地网关的 <Mono>opencode</Mono> provider 配置。放在{" "}
          <Mono>~/.config/opencode/opencode.json</Mono> 或项目根目录。
        </p>
        <label className="mb-3 flex w-fit flex-col gap-1">
          <span className="text-text-muted">OpenCode 配置格式</span>
          <select
            aria-label="OpenCode 版本"
            value={openCodeVersion}
            onChange={(event) => setOpenCodeVersion(event.target.value as OpenCodeVersion)}
            className="min-h-[44px] rounded-sm border border-border-strong bg-bg px-3"
          >
            <option value="2">OpenCode 2.x（默认）</option>
            <option value="1">OpenCode 1.x</option>
          </select>
        </label>
        <div className="relative">
          <pre className="overflow-x-auto rounded-md border border-border-strong bg-bg p-3 pr-28 font-mono">
            {snippet}
          </pre>
          <button
            type="button"
            className="absolute right-2 top-2 min-h-[40px] rounded-xs border border-border-strong bg-surface px-3"
            onClick={() => {
              void navigator.clipboard?.writeText(snippet).then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1500);
              });
            }}
          >
            {copied ? "已复制" : "复制"}
          </button>
        </div>
        <p className="mt-3 text-text-muted">
          {openCodeVersion === "1" ? (
            <>
              OpenCode 1.x 使用单数 <Mono>provider</Mono> 与 <Mono>options</Mono>，只覆盖已有
              provider 的 <Mono>baseURL</Mono> 与 <Mono>apiKey</Mono>；模型和 SDK 由 OpenCode
              自己管理。
            </>
          ) : (
            <>
              OpenCode 2.x 使用复数 <Mono>providers</Mono>，只覆盖已有 <Mono>opencode</Mono>{" "}
              provider 的 <Mono>settings.baseURL</Mono> 与 <Mono>settings.apiKey</Mono>；模型和
              SDK 由 OpenCode 自己管理。
            </>
          )}{" "}
          你选择的模型仍受上游权限与免费规则约束。
        </p>
      </Panel>

      <Panel title="Clash 桥接">
        {!data.clash.enabled ? (
          <StatusIndicator tone="neutral" icon="○" label="未启用" />
        ) : (
          <>
            <StatusIndicator
              tone={data.clash.bridges.some((b) => b.enabled) ? "success" : "warn"}
              icon={data.clash.bridges.some((b) => b.enabled) ? "✓" : "!"}
              label={`已启用 · ${data.clash.bridges.filter((b) => b.enabled).length}/${data.clash.bridges.length} 个内核`}
            />
            <table className="mt-3 w-full border-collapse text-left">
              <thead>
                <tr className="border-b border-border-strong text-text-muted">
                  <th className="py-2 font-medium">内核</th>
                  <th className="py-2 font-medium">控制面</th>
                  <th className="py-2 font-medium" data-numeric="">
                    代理端口
                  </th>
                  <th className="py-2 font-medium">分组</th>
                  <th className="py-2 font-medium">secret</th>
                </tr>
              </thead>
              <tbody>
                {data.clash.bridges.map((b) => (
                  <tr
                    key={b.id}
                    className="border-b border-border last:border-0"
                    style={{ height: "44px" }}
                    data-bridge={b.id}
                  >
                    <td>
                      <Mono>{b.id}</Mono>
                      {!b.enabled && <span className="ml-2 text-text-muted">（已停用）</span>}
                      {b.id === data.clash.activeBridgeId && (
                        <span className="ml-2 text-accent-fg">当前</span>
                      )}
                    </td>
                    <td>
                      <Mono>{b.apiBase}</Mono>
                    </td>
                    <td data-numeric="">
                      <Mono>{b.localProxyPort}</Mono>
                    </td>
                    <td>
                      <Mono>{b.selectorGroup}</Mono>
                    </td>
                    <td>
                      {b.apiSecret.present ? (
                        <Mono>{b.apiSecret.fingerprint}</Mono>
                      ) : (
                        <span className="text-text-muted">无</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-3 text-text-muted">
              <Strong>代理端口必须与内核实际的 <Mono>mixed-port</Mono> 一致</Strong> ——
              不一致时桥接会连到一个没人监听的端口：所有桥接代理传输失败，
              而控制面明明是通的。<Mono>npm run doctor</Mono> 的第 5 层会核对它。
            </p>
            <p className="mt-2 text-text-muted">
              <Strong>分组不要用 <Mono>GLOBAL</Mono></Strong> —— rule 模式下它不参与选路，
              切它什么都不改变，于是所有 Worker 共用一个公网 IP 而不报任何错。
            </p>
          </>
        )}
      </Panel>
    </div>
  );
}
