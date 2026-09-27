import type { Overview } from "../../shared/contract.ts";
import { Mono, PageHeader, Panel } from "../components/Panel.tsx";
import { RoutingSettingsForm, RuntimeSettingsForm } from "../components/GatewaySettingsForms.tsx";

/**
 * 网关页 —— 网关自身：监听与上游、运行参数（尝试次数、超时）、调度与冷却。
 * 客户端连接要的 Relay Token 与 opencode.json 在客户端接入页。
 */

export function GatewayPage({ data, refresh }: { data: Overview; refresh?: () => void }) {
  return (
    <div className="space-y-4">
      <PageHeader title="网关" />
      <Panel title="监听">
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2">
          <dt className="text-text-muted">监听</dt>
          <dd>
            <Mono>127.0.0.1:{data.gateway.port}</Mono>
            <span className="ml-2 text-text-muted">仅回环，不对外监听</span>
          </dd>
          <dt className="text-text-muted">上游</dt>
          <dd>
            <Mono>{data.gateway.baseUrl}</Mono>
          </dd>
          <dt className="text-text-muted">版本</dt>
          <dd>
            <Mono>v{data.health.version}</Mono>
            <span className="ml-2 text-text-muted">pid {data.health.pid}</span>
          </dd>
        </dl>
      </Panel>
      <RuntimeSettingsForm data={data} refresh={refresh} />
      <RoutingSettingsForm data={data} refresh={refresh} />
    </div>
  );
}
