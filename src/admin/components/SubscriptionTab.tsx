import { useState } from "react";
import type { ConfigPatch, ProxyList, SubscriptionRefresh } from "../../shared/contract.ts";
import { FormStatus, Mono, Panel, SecondaryButton, Strong, errorMessage, type FormMessage } from "./Panel.tsx";
import { StatusIndicator, type StatusTone } from "./StatusIndicator.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { SecretField, useSecretField } from "./SecretField.tsx";
import { patchConfig, useSubscriptionRefresh } from "../lib/api.ts";
import { formatLocalTime } from "../lib/format.ts";

type Subscription = ProxyList["subscriptions"][number];

const INPUT = "min-h-[44px] w-full rounded-sm border border-border-strong bg-bg px-3";

/**
 * 订阅标签：列表、刷新、增删改。
 *
 * ## URL 只显示脱敏串，编辑时也不回填
 *
 * 订阅 URL 的 token 通常带在 query 或 path 里，它本身就是付费凭证 ——
 * 与 API key 同一条规则。服务端只给 `urlRedacted`，编辑时 URL 走三态
 * （留空不改 / 设置新值），输入框是密码框，保存后清空。
 *
 * ## 「从没拉过」与「拉过但失败了」要分开显示
 *
 * 前者的下一步是「点一下刷新」，后者是「看看 token 过期了没」。
 */
export function SubscriptionTab({ data, refresh: refreshList }: { data: ProxyList; refresh?: (() => void) | undefined }) {
  const { stateOf, refresh } = useSubscriptionRefresh();
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Subscription | null>(null);
  const [message, setMessage] = useState<FormMessage>(null);
  const [busy, setBusy] = useState(false);

  const save = async (patch: ConfigPatch, success: string): Promise<boolean> => {
    setBusy(true);
    setMessage(null);
    try {
      await patchConfig(patch);
      setMessage({ tone: "success", text: success });
      refreshList?.();
      return true;
    } catch (err) {
      setMessage(errorMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel
      title={`订阅（${data.subscriptions.length}）`}
      action={
        <SecondaryButton onClick={() => setEditing(editing === "new" ? null : "new")}>
          {editing === "new" ? "收起" : "添加订阅"}
        </SecondaryButton>
      }
    >
      <div className="mb-3">
        <FormStatus message={message} />
      </div>

      {editing === "new" && (
        <div className="mb-4 border-b border-border-strong pb-4">
          <SubscriptionEditor
            existingIds={data.subscriptions.map((s) => s.id)}
            busy={busy}
            onCancel={() => setEditing(null)}
            onSave={async (patch) => {
              if (await save(patch, "已添加订阅，点「刷新」拉取节点")) setEditing(null);
            }}
          />
        </div>
      )}

      {data.subscriptions.length === 0 ? (
        <p className="max-w-3xl text-text-muted">
          还没有订阅。订阅是批量导入节点的来源 —— 手工添加代理也可以，但一个机场几十个节点逐个填不现实。
          点「添加订阅」填入订阅地址，保存后点刷新。
        </p>
      ) : (
        <ul className="space-y-3">
          {data.subscriptions.map((s) => {
            const state = stateOf(s.id);
            const running = state.status === "running";
            return (
              <li key={s.id} className="rounded-md border border-border-strong p-4" data-subscription={s.id}>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-medium">{s.name}</div>
                    {/* 已脱敏 —— 服务端过了 redactUrl，这里只是显示。 */}
                    <div className="break-all text-text-muted">
                      <Mono>{s.urlRedacted}</Mono>
                    </div>
                  </div>
                  {/* 每行的操作都用描边按钮：页面的主操作是批量探测。 */}
                  <span className="flex flex-wrap gap-2">
                    <SecondaryButton onClick={() => void refresh(s.id).then(() => refreshList?.())} disabled={running}>
                      {running ? "刷新中…" : "刷新"}
                    </SecondaryButton>
                    <SecondaryButton onClick={() => setEditing(editing === s.id ? null : s.id)}>
                      {editing === s.id ? "收起" : "编辑"}
                    </SecondaryButton>
                    <SecondaryButton danger disabled={busy} onClick={() => setPendingDelete(s)}>
                      删除
                    </SecondaryButton>
                  </span>
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-4">
                  <span title={s.lastFetchedAt ?? undefined}>
                    <StatusIndicator {...subscriptionStatus(s)} />
                  </span>
                  <span className="text-text-muted">
                    当前 <Mono>{s.proxyCount}</Mono> 个节点
                    {s.lastFormat === null ? null : (
                      <>
                        {" · 格式 "}
                        <Mono>{s.lastFormat}</Mono>
                      </>
                    )}
                  </span>
                </div>

                <div aria-live="polite">
                  {state.status === "done" && <RefreshReport result={state.result} />}
                  {state.status === "error" && (
                    <p role="alert" className="mt-2">
                      <StatusIndicator tone="error" icon="✕" label={state.message} />
                    </p>
                  )}
                </div>

                {editing === s.id && (
                  <div className="mt-4 border-t border-border-strong pt-4">
                    <SubscriptionEditor
                      subscription={s}
                      existingIds={[]}
                      busy={busy}
                      onCancel={() => setEditing(null)}
                      onSave={async (patch) => {
                        if (await save(patch, "已保存")) setEditing(null);
                      }}
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title="删除订阅"
        confirmLabel="确认删除"
        destructive
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          const s = pendingDelete;
          setPendingDelete(null);
          if (s !== null) void save({ subscriptions: { delete: [s.id] } }, "已删除订阅");
        }}
      >
        <p>
          将删除订阅 <Mono>{pendingDelete?.name ?? ""}</Mono> 以及它导入的 {pendingDelete?.proxyCount ?? 0} 个节点。
        </p>
        <p>订阅地址后台只保存脱敏形态，删除后要重新填写原地址。有 Worker 使用其中的节点时不会删除。</p>
      </ConfirmDialog>
    </Panel>
  );
}

function SubscriptionEditor({
  subscription,
  existingIds,
  busy,
  onCancel,
  onSave,
}: {
  subscription?: Subscription;
  existingIds: readonly string[];
  busy: boolean;
  onCancel: () => void;
  onSave: (patch: ConfigPatch) => Promise<void>;
}) {
  const [id, setId] = useState("");
  const [name, setName] = useState(subscription?.name ?? "");
  const [enabled, setEnabled] = useState(subscription?.enabled ?? true);
  const url = useSecretField();
  const [newUrl, setNewUrl] = useState("");
  const [error, setError] = useState<FormMessage>(null);

  return (
    <form
      aria-label={subscription === undefined ? "添加订阅" : `编辑订阅 ${subscription.name}`}
      className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (name.trim() === "") return setError({ tone: "error", text: "名称不能为空" });
        if (subscription === undefined) {
          if (id.trim() === "") return setError({ tone: "error", text: "ID 不能为空" });
          if (existingIds.includes(id.trim())) return setError({ tone: "error", text: `ID ${id.trim()} 已被占用` });
          if (newUrl.trim() === "") return setError({ tone: "error", text: "订阅地址不能为空" });
          setError(null);
          void onSave({ subscriptions: { create: [{ id: id.trim(), name: name.trim(), url: newUrl.trim(), enabled }] } }).then(() =>
            setNewUrl(""),
          );
          return;
        }
        const urlPatch = url.patch();
        if (urlPatch !== undefined && "set" in urlPatch && urlPatch.set.trim() === "") {
          return setError({ tone: "error", text: "新的订阅地址不能为空" });
        }
        setError(null);
        void onSave({
          subscriptions: {
            update: {
              [subscription.id]: { name: name.trim(), enabled, ...(urlPatch === undefined ? {} : { url: urlPatch }) },
            },
          },
        }).then(() => url.setValue(""));
      }}
    >
      {subscription === undefined && (
        <label className="flex flex-col gap-1">
          <span className="text-text-muted">ID</span>
          <input value={id} onChange={(e) => setId(e.target.value)} className={`${INPUT} font-mono`} />
        </label>
      )}
      <label className="flex flex-col gap-1">
        <span className="text-text-muted">名称</span>
        <input value={name} onChange={(e) => setName(e.target.value)} className={INPUT} />
      </label>
      {subscription === undefined ? (
        <label className="flex flex-col gap-1 sm:col-span-2">
          <span className="text-text-muted">订阅地址（保存后只显示脱敏形态）</span>
          <input type="password" autoComplete="off" value={newUrl} onChange={(e) => setNewUrl(e.target.value)} className={INPUT} />
        </label>
      ) : (
        <SecretField
          label="订阅地址"
          saved={{ present: true, fingerprint: null }}
          field={url}
          allowClear={false}
          hint={<Mono>{subscription.urlRedacted}</Mono>}
        />
      )}
      <label className="flex min-h-[44px] items-center gap-2 self-end">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> 启用
      </label>
      <div className="flex flex-wrap items-center gap-2 sm:col-span-2 xl:col-span-4">
        <SecondaryButton type="submit" disabled={busy}>
          {busy ? "保存中…" : "保存订阅"}
        </SecondaryButton>
        <SecondaryButton onClick={onCancel}>取消</SecondaryButton>
        <FormStatus message={error} />
      </div>
    </form>
  );
}

/**
 * 订阅的状态标签。
 *
 * 四态而不是两态。**停用**时也要把失败原因带上（如果有）：一条 early return
 * 会让最常见的那类输入看不到原因。拉取时间按本地时区显示；完整 ISO 放在外层 `title`。
 */
export function subscriptionStatus(s: Subscription): { tone: StatusTone; icon: string; label: string } {
  if (!s.enabled) {
    const suffix = s.lastErrorKind === null ? "" : ` · 上次失败（${s.lastErrorKind}）`;
    return { tone: "neutral", icon: "○", label: `已停用${suffix}` };
  }
  if (s.lastErrorKind !== null) {
    return { tone: "error", icon: "✕", label: `上次拉取失败（${s.lastErrorKind}）` };
  }
  if (s.lastFetchedAt === null) {
    // 「从没拉过」不是错误 —— 但也绝不能显示成成功。
    return { tone: "warn", icon: "?", label: "从未拉取" };
  }
  return { tone: "success", icon: "✓", label: `上次拉取 ${formatLocalTime(s.lastFetchedAt)}` };
}

/** 一次刷新的结果明细。 */
function RefreshReport({ result }: { result: SubscriptionRefresh }) {
  if (!result.ok) {
    return (
      <p role="alert" className="mt-2">
        <StatusIndicator tone="error" icon="✕" label={`刷新失败（${result.failureKind}）：${result.reason}`} />
      </p>
    );
  }
  return (
    <div className="mt-2">
      <p>
        新增 <Mono>{result.added}</Mono> · 更新 <Mono>{result.updated}</Mono> · 移除 <Mono>{result.removed}</Mono>
        {result.skipped > 0 ? (
          <>
            {" · 跳过 "}
            <Mono>{result.skipped}</Mono>
          </>
        ) : null}
      </p>
      {result.keptBecauseInUse > 0 && (
        <p className="mt-1 text-text-muted">
          有 <Mono>{result.keptBecauseInUse}</Mono> 个节点已不在订阅里，但仍被 Worker 绑着，所以<Strong>没有删除</Strong>。
          先把那些 Worker 改绑到别的出口。
        </p>
      )}
      {result.disabledNeedBridge > 0 && (
        <p className="mt-1 text-text-muted">
          有 <Mono>{result.disabledNeedBridge}</Mono> 个节点只能经 Clash 桥接，而桥接当前未启用，所以它们以
          <Strong>停用</Strong>状态导入。开启 Clash 桥接后再启用它们。
        </p>
      )}
    </div>
  );
}
