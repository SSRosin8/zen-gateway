import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { LanStatusSchema, type LanStatus } from "../../shared/contract.ts";
import { FormStatus, Mono, Panel, PrimaryButton, SecondaryButton, Strong, errorMessage, type FormMessage } from "./Panel.tsx";
import { StatusIndicator } from "./StatusIndicator.tsx";
import { FIELD } from "../lib/styles.ts";

/**
 * 局域网访问：未登录的局域网访客看到登录页；本机在网关页设置或关闭访问口令。
 *
 * 登录状态由服务端 `HttpOnly` cookie 持有，前端只读 `/api/lan/status`，
 * 不在 localStorage 里存任何凭证。
 */

async function lanRequest(path: string, body?: unknown): Promise<void> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) {
    const raw = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(raw?.error?.message ?? `HTTP ${res.status}`);
  }
}

export function useLanStatus(): { status: LanStatus | null; reload: () => void } {
  const [status, setStatus] = useState<LanStatus | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void fetch("/api/lan/status", { headers: { accept: "application/json" } })
      .then(async (res) => {
        const parsed = LanStatusSchema.safeParse(await res.json());
        if (!cancelled && parsed.success) setStatus(parsed.data);
      })
      // 拿不到状态（网关没在跑、旧版本网关）时按本机处理，由页面自己的三态报错。
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [tick]);
  return { status, reload: useCallback(() => setTick((n) => n + 1), []) };
}

/**
 * 局域网访客未登录时挡在整个控制台之前；本机或已登录时直接渲染子节点。
 * 状态还没回来时先渲染子节点：本机是最常见的情形，不该每次打开都闪一下登录页。
 */
export function LanGate({ children }: { children: ReactNode }) {
  const { status, reload } = useLanStatus();
  if (status === null || status.authenticated) return <>{children}</>;
  return <LanLogin enabled={status.enabled} onDone={reload} />;
}

function LanLogin({ enabled, onDone }: { enabled: boolean; onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<FormMessage>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    void lanRequest("/api/lan/login", { password })
      .then(onDone)
      .catch((err) => setMessage(errorMessage(err)))
      .finally(() => setBusy(false));
  };

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <p className="mb-4 font-serif text-display-30 tracking-tight">zen-gateway</p>
        <Panel title="局域网访问">
          {enabled ? (
            <form onSubmit={submit} className="space-y-3" aria-label="局域网登录">
              <label className="flex flex-col gap-1">
                <span className="text-text-muted">访问口令</span>
                <input
                  type="password"
                  autoComplete="current-password"
                  autoFocus
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className={FIELD}
                />
              </label>
              <div className="flex flex-wrap items-center gap-2">
                <PrimaryButton type="submit" disabled={busy || password === ""}>
                  {busy ? "登录中…" : "登录"}
                </PrimaryButton>
                <FormStatus message={message} />
              </div>
            </form>
          ) : (
            <p className="text-text-muted">
              局域网访问还没有开启。在运行网关的电脑上打开后台，到网关页设置访问口令后再试。
            </p>
          )}
        </Panel>
      </div>
    </main>
  );
}

/** 网关页的局域网访问卡片：本机设置 / 关闭口令并看到可访问地址；局域网访客只能登出。 */
export function LanAccessPanel() {
  const { status, reload } = useLanStatus();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<FormMessage>(null);

  const run = (path: string, body: unknown, success: string) => {
    setBusy(true);
    setMessage(null);
    void lanRequest(path, body)
      .then(() => {
        setPassword("");
        setMessage({ tone: "success", text: success });
        reload();
      })
      .catch((err) => setMessage(errorMessage(err)))
      .finally(() => setBusy(false));
  };

  if (status === null) return null;

  if (!status.local) {
    return (
      <Panel title="局域网访问">
        <div className="flex flex-wrap items-center gap-3">
          <StatusIndicator tone="success" icon="✓" label="已通过访问口令登录" />
          <SecondaryButton onClick={() => void lanRequest("/api/lan/logout").then(() => window.location.reload())}>
            退出登录
          </SecondaryButton>
        </div>
      </Panel>
    );
  }

  return (
    <Panel title="局域网访问">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <StatusIndicator
            tone={status.enabled ? "success" : "neutral"}
            icon={status.enabled ? "✓" : "○"}
            label={status.enabled ? "已设置访问口令" : "未开启"}
          />
          <span className="text-text-muted">
            设置口令后后台立即对局域网开放，同一局域网的设备输入口令即可访问，
            权限与本机相同（口令只能在本机修改）。
          </span>
        </div>
        {status.addresses.length > 0 && (
          <p>
            <span className="text-text-muted">访问地址：</span>
            {status.addresses.map((a) => (
              <Mono key={a}>{a} </Mono>
            ))}
          </p>
        )}
        <form
          className="flex flex-wrap items-center gap-2"
          aria-label="设置访问口令"
          onSubmit={(e) => {
            e.preventDefault();
            run("/api/lan/password", { password }, status.enabled ? "口令已更换，已登录的局域网设备需要重新登录" : "已开启局域网访问");
          }}
        >
          <input
            type="password"
            autoComplete="new-password"
            aria-label={status.enabled ? "新的访问口令" : "访问口令"}
            placeholder="至少 8 位"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={`${FIELD} w-64 max-w-full`}
          />
          <SecondaryButton type="submit" disabled={busy || password.length < 8}>
            {status.enabled ? "更换口令" : "设置口令并开启"}
          </SecondaryButton>
          {status.enabled && (
            <SecondaryButton danger disabled={busy} onClick={() => run("/api/lan/password", { password: null }, "已关闭局域网访问")}>
              关闭局域网访问
            </SecondaryButton>
          )}
          <FormStatus message={message} />
        </form>
        <p className="text-text-muted">
          <Strong>注意</Strong>：拿到口令的人可以修改 Worker、填写 API key 与轮换 Relay Token。
          口令经局域网明文传输（HTTP），只在可信网络里开启。
        </p>
      </div>
    </Panel>
  );
}
