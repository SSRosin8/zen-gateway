import { useState } from "react";
import type { OpenCodeView } from "../../shared/contract.ts";
import { FormStatus, Mono, PrimaryButton, SecondaryButton, Strong } from "./Panel.tsx";
import { StatusIndicator } from "./StatusIndicator.tsx";
import type { FetchState } from "../lib/api.ts";
import {
  versionFromDetected,
  writeOpenCodeConfig,
  useAction,
} from "../lib/consoleApi.ts";
import { FIELD } from "../lib/styles.ts";

/**
 * OpenCode 项目配置的状态 + 写入按钮。快速开始与网关页共用。
 *
 * 写入由服务端完成（它持有真实 Relay Token），前端只发版本选择。
 * 已存在且指向网关时按钮文案是「重写」，表示会刷新 baseURL/apiKey 但保留其余键。
 */
export function openCodeStatusLabel(s: OpenCodeView): { tone: "success" | "warn" | "neutral"; icon: string; label: string } {
  if (!s.exists) return { tone: "neutral", icon: "○", label: `${s.path} 还不存在` };
  if (s.pointsToGateway) return { tone: "success", icon: "✓", label: `${s.path} 已指向本网关` };
  return { tone: "warn", icon: "!", label: `${s.path} 未指向本网关` };
}

export function OpenCodeConfigCard({
  status,
  onWritten,
  primary = false,
}: {
  status: FetchState<OpenCodeView>;
  onWritten: () => void;
  /** 为 true 时写入按钮是所在视图的主操作；否则描边。 */
  primary?: boolean;
}) {
  const write = useAction(writeOpenCodeConfig);
  const detected = status.status === "ready" ? status.data.detectedVersion : null;
  const [version, setVersion] = useState<"1" | "2" | null>(null);
  const chosen = version ?? versionFromDetected(detected);

  if (status.status === "loading") return <StatusIndicator tone="neutral" icon="○" label="检测中" />;
  if (status.status === "offline") return <StatusIndicator tone="error" icon="✕" label="未连接到网关服务" />;
  if (status.status === "error") {
    return <StatusIndicator tone="error" icon="✕" label={`拿不到 OpenCode 配置状态：${status.message}`} />;
  }

  const s = status.data;
  const label = openCodeStatusLabel(s);
  const running = write.state.status === "running";
  const buttonText = running ? "写入中…" : s.exists ? "重写 opencode.json" : "写入 opencode.json";
  const Button = primary ? PrimaryButton : SecondaryButton;

  return (
    <div className="space-y-3" data-opencode="">
      {/* 状态与三项事实同一行，宽屏不必逐行往下读。 */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
        <StatusIndicator {...label} />
        <span>
          <span className="text-text-muted">检测到的 OpenCode </span>
          {detected === null ? <span className="text-text-muted">未安装或不在 PATH 中</span> : <Mono>{detected}</Mono>}
        </span>
        <span>
          <span className="text-text-muted">当前格式 </span>
          {s.shape === null ? <span className="text-text-muted">无</span> : <Mono>{s.shape}</Mono>}
        </span>
      </div>
      {s.unwritableReason !== null && <StatusIndicator tone="warn" icon="!" label={`不会改写：${s.unwritableReason}`} />}
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="OpenCode 版本"
          value={chosen}
          onChange={(e) => setVersion(e.target.value as "1" | "2")}
          className={FIELD}
        >
          <option value="2">OpenCode 2.x 格式</option>
          <option value="1">OpenCode 1.x 格式</option>
        </select>
        <Button
          disabled={running}
          onClick={() => void write.run(chosen).then((r) => r !== null && onWritten())}
        >
          {buttonText}
        </Button>
        <FormStatus
          message={
            write.state.status === "error"
              ? { tone: "error", text: write.state.message }
              : write.state.status === "done"
                ? { tone: "success", text: "已写入" }
                : null
          }
        />
        <span className="text-text-muted">
          只设置内置 <Mono>opencode</Mono> provider 的 <Mono>baseURL</Mono> 与 <Mono>apiKey</Mono>，其他设置保留；
          含注释的 JSONC 文件<Strong>不会被改动</Strong>。
        </span>
      </div>
    </div>
  );
}
